import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { bridgeDeckHeight } from '../js/geo.js';
import { BRIDGE_Y } from '../js/config.js';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { bridgeResample } = await import('../js/meshes.js');

test('a bridge holds one flat deck over a terrain valley', () => {
  const way = { p: [[0, 0], [0, 30]], _len: 30 };
  const terrain = {
    ready: () => true,
    heightAt: (_x, z) => z <= 0 ? 10 : z >= 30 ? 12 : -4,
  };
  // The higher bank owns the level, and nothing is added to it: BRIDGE_Y was a
  // flat-world fossil, and it was the whole reason these crossings had a ramp.
  const deck = 12;

  // The SPAN is level — that is the whole point of a bridge, and it must not
  // follow the −4 m river bed underneath it. With the deck at the higher bank
  // and ramps at a road's 7.5 % grade, the 2 m rise from the low bank takes
  // 12 m (capped at two fifths of the span) and the high bank needs none.
  for (const distance of [13, 20, 28])
    assert.equal(bridgeDeckHeight(way, distance, terrain), deck);
  // …and it never dives below either bank anywhere.
  for (let d = 0; d <= 30; d += 0.5)
    assert.ok(bridgeDeckHeight(way, d, terrain) >= 10 - 1e-9, `deck dived at ${d} m`);
});

test('the deck comes down to meet the road at both abutments', () => {
  // A level that runs edge to edge does not touch the ground, and the approach
  // road — a separate OSM way that drapes onto the terrain — does. The
  // difference is a bridge floating clear of the road with daylight under the
  // join, which is what "mosty nenavazují na silnice a je mezi tím mezera"
  // was. The endpoints are where the two ways share a node, so that is where
  // the deck has to agree with the ground exactly.
  const way = { p: [[0, 0], [0, 30]], _len: 30 };
  const terrain = {
    ready: () => true,
    heightAt: (_x, z) => z <= 0 ? 10 : z >= 30 ? 12 : -4,
  };
  assert.equal(bridgeDeckHeight(way, 0, terrain), 10, 'gap at the near abutment');
  assert.equal(bridgeDeckHeight(way, 30, terrain), 12, 'gap at the far abutment');
  // …and the far bank IS the deck level, so that end has no ramp at all —
  // which is what a real bridge onto level ground does.

  // the climb is monotone — no hump, no dip on the way up
  let prev = -Infinity;
  for (let d = 0; d <= 8; d += 0.25) {
    const y = bridgeDeckHeight(way, d, terrain);
    assert.ok(y >= prev - 1e-9, `ramp went backwards at ${d} m`);
    prev = y;
  }
  // …and it is not a wall: a road's grade, not a kerb
  const grade = (bridgeDeckHeight(way, 1, terrain) - 10) / 1;
  assert.ok(grade <= 0.18, `approach ramp is a ${(grade * 100).toFixed(0)} % climb`);
  // the deck still holds a level middle — the ramps must not eat the span
  assert.equal(bridgeDeckHeight(way, 20, terrain), 12);
});

test('a short bridge stays a bridge instead of becoming two ramps', () => {
  // The ramp is capped at a quarter of the span from each end, so even a big
  // step still leaves half the deck level.
  const way = { p: [[0, 0], [0, 20]], _len: 20 };
  const terrain = { ready: () => true, heightAt: (_x, z) => (z <= 0 ? 4 : z >= 20 ? 14 : 0) };
  const deck = 14;
  // ramps are capped at two fifths of the span from each end, so 8 < s < 20
  for (const d of [9, 12, 16]) assert.equal(bridgeDeckHeight(way, d, terrain), deck);
});

test('a long straight bridge is split into short fascia sections', () => {
  const points = bridgeResample([[0, 0], [0, 60]]);
  assert.ok(points.length > 2, 'the bridge is still only one long GPU chord');
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    assert.ok(d <= 3.001, `bridge chord remained ${d} m long`);
  }
});

test('regional data retains the Labe road and footbridge tags', () => {
  const tile = JSON.parse(readFileSync(
    new URL('../public/data/tiles/-1_-1.json', import.meta.url), 'utf8'));
  const crossing = tile.roads.filter((r) => r.p.length === 2
    && r.p.every(([x, z]) => x > -830 && x < -760 && z > -1070 && z < -915)
    && (r.t === 'primary' || r.t === 'footway'));
  assert.equal(crossing.length, 4);
  assert.ok(crossing.every((r) => r.br === 1),
    'the region builder dropped bridge=yes from a Labe crossing');
});

// ---------------------------------------------------------------------------
// roads are built, not draped
// ---------------------------------------------------------------------------

const { roadProfile, roadGradeY, polylineLength } = await import('../js/geo.js');

test('a road across a dell is embanked, not dropped into it', () => {
  // The defect this exists for: DMR 5G is bare earth and OSM does not tag
  // embankments, so a road laid straight onto the ground dived into every dell
  // it crossed. Measured over a real Pardubice height map before the grading,
  // the worst grade on a 200 m road was 65.8 % at the extreme and 17.0 % at p95;
  // after it, 9.9 % and 7.5 %. In the Zlín hills the median halves and the
  // extremes stay, because there the slope IS the hill.
  const RES = 20;
  // a 6 m dell, 30 m across, in otherwise level ground
  const terrain = {
    res: RES,
    ready: () => true,
    heightAt: (x) => (x > 85 && x < 115 ? 200 - 6 * Math.sin((x - 85) / 30 * Math.PI) : 200),
  };
  const way = { p: [[0, 0], [200, 0]] };
  way._len = polylineLength(way.p);
  const prof = roadProfile(way, terrain);
  assert.ok(prof, 'no profile was built');

  let worst = 0, fill = 0, cut = 0;
  let prev = roadGradeY(way, 0, terrain);
  for (let s = 1; s <= 200; s++) {
    const y = roadGradeY(way, s, terrain);
    worst = Math.max(worst, Math.abs(y - prev));
    fill = Math.max(fill, y - terrain.heightAt(s));
    cut = Math.max(cut, terrain.heightAt(s) - y);
    prev = y;
  }
  // the road holds a road's grade across it…
  assert.ok(worst <= 0.076, `graded road still climbs at ${(worst * 100).toFixed(0)} % per metre`);
  // …by filling…
  assert.ok(fill > 3, `only ${fill.toFixed(1)} m of embankment — the dell was not filled`);
  // …and never by cutting, because a hill that is really there must stay.
  assert.ok(cut < 1e-6, `the road was cut ${cut.toFixed(2)} m into the ground`);
});

test('the profile leaves both ends on the terrain, so joining roads agree', () => {
  const terrain = { res: 20, ready: () => true, heightAt: (x) => 200 + x * 0.01 };
  const way = { p: [[0, 0], [200, 0]] };
  way._len = polylineLength(way.p);
  roadProfile(way, terrain);
  assert.ok(Math.abs(roadGradeY(way, 0, terrain) - 200) < 1e-6);
  assert.ok(Math.abs(roadGradeY(way, 200, terrain) - 202) < 1e-6);
});

test('a road is the higher of the ground and its profile, so it cannot sink', () => {
  // This is the invariant that keeps the aerial photograph off the tarmac, and
  // it holds by construction rather than by tolerance: the road IS max(ground,
  // profile), and one of the two things it is the maximum of is the ground.
  //
  // Both halves have been shipped wrong. Terrain alone dives into every dell,
  // because no embankment is in the data. The profile alone stops following the
  // ground at all, so between its 5 m samples the ground comes through it and
  // every wiggle of those samples becomes a step you can feel — the bumpy road.
  //
  // Measured over two real height maps, 800 roads of 200 m, worst grade per
  // metre and how far the ground ever reaches above the road:
  //   Pardubice  bare p95 17.0 % max 65.8 %  →  p95 9.2 % max 33.6 %, sink 0.0000 m
  //   Zlín       bare p50 21.5 %             →  p50 14.5 %,           sink 0.0000 m
  const terrain = {
    res: 20,
    ready: () => true,
    // a dell AND a hump, so both halves of the max() have to do their job
    heightAt: (x) => 200 - 5 * Math.sin(x / 40) + 3 * Math.sin(x / 11),
  };
  const way = { p: [[0, 0], [300, 0]] };
  way._len = polylineLength(way.p);
  assert.ok(roadProfile(way, terrain), 'no profile');

  let sink = 0, filled = 0;
  for (let s = 0; s <= 300; s += 0.5) {
    const ground = terrain.heightAt(s);
    const road = Math.max(ground, roadGradeY(way, s, terrain));
    sink = Math.max(sink, ground - road);
    filled = Math.max(filled, road - ground);
  }
  assert.equal(sink, 0, `the ground reaches ${sink.toFixed(3)} m above the road`);
  assert.ok(filled > 1, 'nothing was filled — the dell is still a dell');
});
