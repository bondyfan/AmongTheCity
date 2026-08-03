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

const { roadProfile, roadGradeY, polylineLength, indexJunctions, indexBridgeCrossings, bridgeClearance,
  junctionDeckY, junctionHull, pointInPolygon, junctionY, clustersIn, clusterHull, clusterDeckY }
  = await import('../js/geo.js');
const { levels } = await import('../js/city.js');
const { LAYER_Y } = await import('../js/config.js');

test('a road across a dell is embanked, not dropped into it', () => {
  // The defect this exists for: DMR 5G is bare earth and OSM does not tag
  // embankments, so a road laid straight onto the ground dived into every dell
  // it crossed.
  const RES = 20;
  // A 2 m dell, 30 m across — the size of dip a road is actually built over.
  // The fill is capped low on purpose. The version before this one used an
  // unbounded slope envelope, and an envelope does not fill dips, it FLATTENS
  // HILLS: its cone reached a hundred metres, so every downhill road came out
  // on an embankment and the city grew viaducts.
  const terrain = {
    res: RES,
    ready: () => true,
    heightAt: (x) => (x > 85 && x < 115 ? 200 - 2 * Math.sin((x - 85) / 30 * Math.PI) : 200),
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
  // the road crosses it far flatter than the ground does (the dell bottoms 2 m
  // below the rim over 15 m, a 13 % slope)…
  assert.ok(worst <= 0.08, `road still climbs at ${(worst * 100).toFixed(0)} % per metre`);
  // …by filling, and by no more than the cap allows…
  assert.ok(fill > 0.8, `only ${fill.toFixed(2)} m of embankment — the dell was not filled`);
  assert.ok(fill <= 1.7, `${fill.toFixed(1)} m of embankment is a viaduct, not a road`);
  // …and it may cut, but never deeper than the surfacing it is then raised by,
  // which is what keeps the ground off the tarmac.
  assert.ok(cut <= LAYER_Y.road, `the road was cut ${cut.toFixed(2)} m in — deeper than it is thick`);
});

test('a levelled road is far smoother than the ground under it', () => {
  // The whole point. "Jsou takto hrbolaté" was a road draped straight onto a
  // 20 m height grid, which kinks at every cell boundary; a real street does
  // not. Roughness here is the worst change of slope over one metre, which is
  // what a wheel feels. Measured over 321 km of real OSM roads on the Pardubice
  // tile, the median road goes from 2.1 cm to 0.04 cm by this rule alone.
  // The ground is PIECEWISE LINEAR between samples 20 m apart, because that is
  // what a height map is — the kinks are at the cell boundaries and they are
  // the whole complaint. A smooth analytic hill would prove nothing: there is
  // no roughness in it to remove.
  // Amplitudes chosen so the ground's own worst kink lands near the 2 cm the
  // real Pardubice height map measures, not at some picturesque 12 cm no city
  // has — the fixture has to be as rough as the country actually is.
  const node = (k) => 200 + 0.12 * Math.sin(k * 2.3) + 0.07 * Math.sin(k * 5.1 + 1);
  const terrain = {
    res: 20,
    ready: () => true,
    heightAt: (x) => {
      const u = x / 20, i = Math.floor(u), f = u - i;
      return node(i) + (node(i + 1) - node(i)) * f;
    },
  };
  const way = { p: [[0, 0], [400, 0]] };
  way._len = polylineLength(way.p);
  assert.ok(roadProfile(way, terrain), 'no profile');

  const kink = (f) => {
    let w = 0;
    for (let s = 1; s < 399; s++) w = Math.max(w, Math.abs(f(s + 1) - 2 * f(s) + f(s - 1)));
    return w;
  };
  const ground = kink((s) => terrain.heightAt(s));
  const road = kink((s) => roadGradeY(way, s, terrain));
  assert.ok(road < ground / 5,
    `road kinks ${(road * 100).toFixed(1)} cm against the ground's ${(ground * 100).toFixed(1)} cm`);
});

test('two roads meeting at a node are levelled to the SAME height there', () => {
  // Every way is levelled on its own, so without this each would smooth its own
  // way to the corner and arrive somewhere else — a step at every junction,
  // which is the bumpiness, just relocated. The node gets one height, computed
  // from its own coordinates, and both arms are pinned to it.
  const terrain = {
    res: 20,
    ready: () => true,
    heightAt: (x, z) => 200 + 0.02 * x - 0.03 * z + 0.8 * Math.sin(x / 23) + 0.5 * Math.cos(z / 17),
  };
  // an L: one way ends where the other begins, sharing the node exactly
  const a = { d: 1, p: [[0, 0], [120, 0], [240, 0]] };
  const b = { d: 1, p: [[240, 0], [240, 130]] };
  for (const w of [a, b]) w._len = polylineLength(w.p);
  indexJunctions([a, b]);
  roadProfile(a, terrain);
  roadProfile(b, terrain);
  const ya = roadGradeY(a, a._len, terrain);
  const yb = roadGradeY(b, 0, terrain);
  assert.ok(Math.abs(ya - yb) < 0.02,
    `the two arms meet at ${ya.toFixed(2)} and ${yb.toFixed(2)} — a ${Math.abs(ya - yb).toFixed(2)} m step`);
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

// ---------------------------------------------------------------------------
// a bridge is a bridge OVER something
// ---------------------------------------------------------------------------

test('a road bridging a railway clears it, and its approaches are embanked', () => {
  // The screenshot behind this: a road crossing the Pardubice lines with the
  // rails running THROUGH the tarmac. Nothing in the data says otherwise — OSM
  // tags the road `bridge=yes` and the railway `layer=-1` at best, and neither
  // of those is a height. The height comes from what has to fit underneath.
  const terrain = { res: 20, ready: () => true, heightAt: () => 200 };
  //   approach ——— bridge ——— approach, running east; the railway crosses the
  //   middle of the bridge and shares no node with it, which is what "over"
  //   means as opposed to "joins".
  const west = { d: 1, t: 'primary', w: 8, p: [[-300, 0], [-20, 0]] };
  const span = { d: 1, t: 'primary', w: 8, br: 1, p: [[-20, 0], [20, 0]] };
  const east = { d: 1, t: 'primary', w: 8, p: [[20, 0], [300, 0]] };
  const rail = { p: [[0, -200], [0, 200]] };
  const roads = [west, span, east];
  for (const w of [...roads, rail]) w._len = polylineLength(w.p);
  indexJunctions(roads);
  indexBridgeCrossings(roads, [rail]);

  assert.ok(span._cross?.length, 'the crossing was not found at all');
  const deck = bridgeDeckHeight(span, span._len / 2, terrain);
  assert.ok(deck >= 205.5, `the deck is at ${deck.toFixed(1)} m over rails at 200 — no headroom`);

  // …and the approach ARRIVES there. A deck raised on its own would just move
  // the hole from over the rails to the abutment.
  const abut = roadGradeY(west, west._len, terrain);
  assert.ok(Math.abs(abut - deck) < 0.3,
    `the approach reaches ${abut.toFixed(1)} m and the deck is at ${deck.toFixed(1)} — a step`);
  // …up a bank a road could actually climb, not a wall
  const back = roadGradeY(west, west._len - 100, terrain);
  assert.ok((abut - back) / 100 <= 0.07,
    `the embankment climbs at ${(100 * (abut - back) / 100).toFixed(0)} % — that is not a road`);
});

test('a footpath under a bridge is not owed a road\'s headroom', () => {
  // Five metres of steps that happen to cross a path became a bridge on a 4.5 m
  // embankment. A path needs the height of a person, not of a lorry.
  const terrain = { res: 20, ready: () => true, heightAt: () => 200 };
  const span = { d: 1, t: 'footway', w: 2, br: 1, p: [[-20, 0], [20, 0]] };
  const foot = { d: 1, t: 'footway', w: 2, p: [[0, -100], [0, 100]] };
  for (const w of [span, foot]) w._len = polylineLength(w.p);
  indexBridgeCrossings([span, foot], []);
  const need = bridgeClearance(span, terrain);
  assert.ok(need !== null && need < 203.5, `a footpath was owed ${(need - 200).toFixed(1)} m of headroom`);
});

test('you can be under a bridge instead of on it', () => {
  // Every "how high is the world here" answered with the HIGHEST surface, so a
  // car driving under a bridge was teleported onto the deck, driven along it,
  // and dropped off the far end.
  const on = levels.reset(226).add(220).add(226).value();
  assert.equal(on, 226, 'a car on the deck was pulled down to the road under it');
  const under = levels.reset(220.2).add(220).add(226).value();
  assert.equal(under, 220, 'a car under the bridge was pulled up onto the deck');
  // airborne over a crest, still its own deck
  assert.equal(levels.reset(227).add(220).add(226).value(), 226);
  // no hint at all — the top of the world, which is what a spawn wants
  assert.equal(levels.reset(NaN).add(220).add(226).value(), 226);
  // put down beneath a viaduct with nothing at that height: the road, not the deck
  assert.equal(levels.reset(180).add(220).add(226).value(), 220);
});

test('a road too short for the smoothing kernel is still a number', () => {
  // The blur reflects at the ends, and a single fold is only enough while the
  // kernel is narrower than the profile. A 30 m way sampled every 2 m is three
  // samples against a nine-sample kernel: one fold left the index NEGATIVE, the
  // read came back undefined, and the NaN travelled all the way to the vertex
  // buffer — "Computed radius is NaN" for every short road in the city, which
  // in Pardubice is most of them.
  const terrain = { res: 20, ready: () => true, heightAt: (x) => 200 + 0.01 * x };
  for (let len = 4; len <= 60; len += 1) {
    const way = { p: [[0, 0], [len, 0]] };
    way._len = len;
    const prof = roadProfile(way, terrain);
    if (!prof) continue;
    for (let i = 0; i < prof.n; i++) {
      assert.ok(Number.isFinite(prof.y[i]),
        `a ${len} m road levelled to ${prof.y[i]} at sample ${i} of ${prof.n}`);
    }
  }
});

test('a viaduct in pieces is ONE structure with one grade', () => {
  // A viaduct arrives from OSM as a chain of bridge ways sharing endpoints.
  // Each used to level itself alone: its neighbours are bridges too, so the
  // approach search found nothing, fell back to the terrain under the span,
  // and the clearance rule hoisted every middle into a peak — a row of black
  // tents over the railway. A chain now carries one grade end to end.
  const terrain = { res: 20, ready: () => true, heightAt: () => 200 };
  const approachW = { d: 1, t: 'primary', w: 8, p: [[-300, 0], [-60, 0]] };
  const s1 = { d: 1, t: 'primary', w: 8, br: 1, p: [[-60, 0], [0, 0]] };
  const s2 = { d: 1, t: 'primary', w: 8, br: 1, p: [[0, 0], [60, 0]] };
  const s3 = { d: 1, t: 'primary', w: 8, br: 1, p: [[60, 0], [120, 0]] };
  const approachE = { d: 1, t: 'primary', w: 8, p: [[120, 0], [360, 0]] };
  const rail = { p: [[30, -200], [30, 200]] };
  const roads = [approachW, s1, s2, s3, approachE];
  for (const w of [...roads, rail]) w._len = polylineLength(w.p);
  indexJunctions(roads);
  indexBridgeCrossings(roads, [rail]);

  assert.ok(s1._chain && s1._chain === s2._chain && s2._chain === s3._chain,
    'the three spans were not chained into one structure');

  // one continuous grade: clears the rail in the middle…
  const midDeck = bridgeDeckHeight(s2, 30, terrain);
  assert.ok(midDeck >= 205.5, `the chain clears only ${(midDeck - 200).toFixed(1)} m over the rail`);
  // …and NO tent: walk the whole chain, the grade never exceeds 7 %
  let worst = 0, prev = null;
  for (const [w, off] of [[s1, 0], [s2, 60], [s3, 120]]) {
    for (let d = 0; d <= 60; d += 2) {
      const y = bridgeDeckHeight(w, d, terrain);
      if (prev !== null) worst = Math.max(worst, Math.abs(y - prev) / 2);
      prev = y;
    }
  }
  assert.ok(worst <= 0.07, `the chained deck climbs at ${(worst * 100).toFixed(0)} % — a tent`);
});

test('a chained deck lands EXACTLY on its approaches, whatever it crosses', () => {
  // A crossing close to one abutment used to hoist the deck's end above the
  // road it lands on: the clearance cone fell at 6 % and had not reached the
  // anchor by s=0, so the carriageway ended with a step in mid-air — the
  // visible "silnice na sebe nenavazuje" at the flyover. A hard cone now
  // steepens as much as it must (to 20 %) so the ends are exact.
  const terrain = { res: 20, ready: () => true, heightAt: () => 200 };
  const approachW = { d: 1, t: 'primary', w: 8, p: [[-300, 0], [-60, 0]] };
  const s1 = { d: 1, t: 'primary', w: 8, br: 1, p: [[-60, 0], [0, 0]] };
  const s2 = { d: 1, t: 'primary', w: 8, br: 1, p: [[0, 0], [60, 0]] };
  const approachE = { d: 1, t: 'primary', w: 8, p: [[60, 0], [360, 0]] };
  const rail = { p: [[-50, -200], [-50, 200]] };   // 10 m from the west abutment
  const roads = [approachW, s1, s2, approachE];
  for (const w of [...roads, rail]) w._len = polylineLength(w.p);
  indexJunctions(roads);
  indexBridgeCrossings(roads, [rail]);
  assert.ok(s1._chain, 'the spans did not chain');
  const A = roadGradeY(approachW, approachW._len, terrain);
  const B = roadGradeY(approachE, 0, terrain);
  assert.ok(Math.abs(bridgeDeckHeight(s1, 0, terrain) - A) < 0.02,
    `west end steps ${(bridgeDeckHeight(s1, 0, terrain) - A).toFixed(2)} m off its approach`);
  assert.ok(Math.abs(bridgeDeckHeight(s2, 60, terrain) - B) < 0.02,
    `east end steps ${(bridgeDeckHeight(s2, 60, terrain) - B).toFixed(2)} m off its approach`);
});

test('the ground never rises through a chained deck', () => {
  // The chain's profile knew the terrain only at its crossings; a smooth hill
  // shoulder mid-span rose straight through the deck and the bridge ran as a
  // green-roofed tunnel. The terrain along the whole line is now a floor.
  const knoll = (x) => 200 + 3 * Math.exp(-((x - 30) ** 2) / (2 * 20 * 20));
  const terrain = { res: 20, ready: () => true, heightAt: (x) => knoll(x) };
  const approachW = { d: 1, t: 'primary', w: 8, p: [[-300, 0], [-60, 0]] };
  const s1 = { d: 1, t: 'primary', w: 8, br: 1, p: [[-60, 0], [0, 0]] };
  const s2 = { d: 1, t: 'primary', w: 8, br: 1, p: [[0, 0], [60, 0]] };
  const s3 = { d: 1, t: 'primary', w: 8, br: 1, p: [[60, 0], [120, 0]] };
  const approachE = { d: 1, t: 'primary', w: 8, p: [[120, 0], [360, 0]] };
  const rail = { p: [[30, -200], [30, 200]] };
  const roads = [approachW, s1, s2, s3, approachE];
  for (const w of [...roads, rail]) w._len = polylineLength(w.p);
  indexJunctions(roads);
  indexBridgeCrossings(roads, [rail]);
  for (const [w, x0] of [[s1, -60], [s2, 0], [s3, 60]]) {
    for (let d = 0; d <= 60; d += 2) {
      const y = bridgeDeckHeight(w, d, terrain);
      assert.ok(y >= knoll(x0 + d) - 0.01,
        `deck ${y.toFixed(2)} under ground ${knoll(x0 + d).toFixed(2)} at x=${x0 + d}`);
    }
  }
});

test('the pad the mesh draws is the pad the feet stand on', () => {
  // junctionHull is the footprint and junctionDeckY the height, and BOTH mesh
  // and physics read them — because the first time they disagreed, a player
  // walking onto an embanked crossing sank into the pad up to the neck.
  const terrain = { res: 20, ready: () => true, heightAt: (x, z) => 200 + 0.05 * x + 0.02 * z };
  const a = { d: 1, t: 'residential', w: 6, p: [[-80, 0], [0, 0]] };
  const b = { d: 1, t: 'residential', w: 6, p: [[0, 0], [80, 10]] };
  const c = { d: 1, t: 'residential', w: 5, p: [[0, 0], [-10, 90]] };
  const roads = [a, b, c];
  for (const w of roads) w._len = polylineLength(w.p);
  indexJunctions(roads);
  const j = a._pins?.[0]?.node ?? b._pins?.[0]?.node;
  assert.ok(j && j.arms.length >= 3, 'no junction was indexed');
  const ring = junctionHull(j);
  assert.ok(ring && ring.length >= 3, 'the pad has no footprint');
  assert.ok(pointInPolygon(j.x, j.z, ring), 'the node is not inside its own pad');
  const y = junctionDeckY(j, j.x, j.z, terrain);
  assert.ok(Number.isFinite(y), 'the pad has no height');
  // the pad continues its arms: at an arm mouth it must MATCH that arm's deck
  const mouth = roadGradeY(a, a._len - j.pad, terrain);
  const py = junctionDeckY(j, -j.pad, 0, terrain);
  assert.ok(Math.abs(py - mouth) < 0.05,
    `pad ${py.toFixed(2)} misses its arm's deck ${mouth.toFixed(2)} at the mouth`);
});

test('a LONE bridge also keeps the ground under its deck', () => {
  // The terrain floor existed only for chains; a single bridge=yes way
  // slanting over a hill shoulder had the ground rising through its level
  // middle, because its deck only knew the two banks.
  const knoll = (x) => 200 + 2.5 * Math.exp(-((x - 25) ** 2) / (2 * 15 * 15));
  const terrain = { res: 20, ready: () => true, heightAt: (x) => knoll(x) };
  const way = { d: 1, t: 'primary', w: 8, br: 1, p: [[0, 0], [50, 0]] };
  way._len = 50;
  for (let d = 0; d <= 50; d += 2) {
    const y = bridgeDeckHeight(way, d, terrain);
    assert.ok(y >= knoll(d) - 0.01,
      `deck ${y.toFixed(2)} under ground ${knoll(d).toFixed(2)} at d=${d}`);
  }
});

test('a junction height measured on missing ground is not remembered', () => {
  // node._ny used to be keyed on the terrain INSTANCE, which lives for the
  // whole session — the first, boot-time answer won forever and every road
  // pinned to the node sat at cut depth for good.
  let loaded = false;
  const terrain = {
    res: 20, missed: false,
    ready: () => loaded,
    heightAt: () => (loaded ? 230 : 200),
  };
  const a = { d: 1, t: 'residential', w: 6, p: [[-80, 0], [0, 0]] };
  const b = { d: 1, t: 'residential', w: 6, p: [[0, 0], [80, 0]] };
  const c = { d: 1, t: 'residential', w: 5, p: [[0, 0], [0, 80]] };
  const roads = [a, b, c];
  for (const w of roads) w._len = polylineLength(w.p);
  indexJunctions(roads);
  const j = a._pins?.[0]?.node;
  assert.ok(j, 'no junction was indexed');
  const guess = junctionY(j, terrain);
  assert.ok(terrain.missed, 'the guess did not raise the flag');
  assert.ok(Math.abs(guess - 200) < 1, `guess ${guess.toFixed(1)} != 200`);
  loaded = true;
  terrain._loads = 1;               // the height tile lands
  const real = junctionY(j, terrain);
  assert.ok(Math.abs(real - 230) < 1,
    `the boot-time guess survived: got ${real.toFixed(1)}, want 230`);
});

test('a dual x dual crossing is ONE cluster with one surface', () => {
  // Four nodes a few metres apart used to mean four pads with slivers of
  // ground, mismatched shades and orphaned paint between them. Nodes joined
  // by a short link way now form one cluster: one hull, one deck.
  const terrain = { res: 20, ready: () => true, heightAt: () => 200 };
  // OSM splits every way at a junction, so the crossing arrives as segments
  // ENDING at the four nodes (0,0) (14,0) (0,14) (14,14)
  const R = (p) => ({ d: 1, t: 'primary', w: 7, p });
  const roads = [
    R([[-80, 0], [0, 0]]), R([[0, 0], [14, 0]]), R([[14, 0], [80, 0]]),
    R([[80, 14], [14, 14]]), R([[14, 14], [0, 14]]), R([[0, 14], [-80, 14]]),
    R([[0, -60], [0, 0]]), R([[0, 0], [0, 14]]), R([[0, 14], [0, 74]]),
    R([[14, -60], [14, 0]]), R([[14, 0], [14, 14]]), R([[14, 14], [14, 74]]),
  ];
  for (const w of roads) w._len = polylineLength(w.p);
  indexJunctions(roads);
  const cls = clustersIn('0,0') ?? clustersIn('-1,0') ?? clustersIn('0,-1') ?? clustersIn('-1,-1');
  assert.ok(cls && cls.length >= 1, 'no cluster formed at the dual crossing');
  const cl = cls[0];
  assert.ok(cl.members.length >= 2, `only ${cl.members.length} nodes clustered`);
  const ring = clusterHull(cl);
  assert.ok(ring && ring.length >= 3, 'cluster has no footprint');
  // the point BETWEEN the nodes — the old sliver zone — is inside the hull
  assert.ok(pointInPolygon(7, 7, ring), 'the middle of the crossing is not covered');
  const y = clusterDeckY(cl, 7, 7, terrain);
  assert.ok(Number.isFinite(y) && Math.abs(y - 200) < 2, `cluster deck ${y} is nowhere near grade`);
});
