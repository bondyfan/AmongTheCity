// ---- round 10, package ground: what stands on the road profile, and what reads it ----
// The feet, the wheels, the earthworks bake, the verge faces and shoulders the
// mesher draws, and the trains. Every test here is synthetic (no tiles): a
// survey, a few ways, and the game's own functions.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Terrain } = await import('../js/terrain.js');
const { conformTerrainTile, CityWorld } = await import('../js/city.js');
const { roadGradeY, railGradeY, polylineLength, chunkKey } = await import('../js/geo.js');
const { LAYER_Y } = await import('../js/config.js');
const B = await import('../js/batter.js');
const { chainRailWays, gradedPath, railHeadOn } = await import('../js/trains.js');
const { untiledAt } = await import('../js/expresshole.js');

const TILE = 4800, RES = 20;

function terrainOf(fn) {
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) g[j * t.n + i] = Math.round(fn(i * RES, j * RES) * 10);
  t.grids.set('0,0', g);
  t._loads = 1;
  return t;
}
const EMPTY = () => ({ buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
function cityWith(roads, rails = []) {
  let id = 0;
  const chunkIndex = new Map();
  const file = (r, list) => {
    for (let k = 0; k < r.p.length - 1; k++) {
      const [ax, az] = r.p[k], [bx, bz] = r.p[k + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 30);
      for (let s = 0; s <= steps; s++) {
        const kk = chunkKey(ax + (bx - ax) * (s / steps), az + (bz - az) * (s / steps));
        let c = chunkIndex.get(kk);
        if (!c) chunkIndex.set(kk, c = EMPTY());
        if (!c[list].includes(r)) c[list].push(r);
      }
    }
  };
  for (const r of roads) { r._id = ++id; r._len = polylineLength(r.p); file(r, 'roads'); }
  for (const r of rails) { r._id = 'rail:' + (++id); r._len = polylineLength(r.p); file(r, 'rails'); }
  return { chunkIndex, roads, rails };
}
const worldOf = (t, city) => Object.assign(Object.create(CityWorld.prototype),
  { terrain: t, city, ground: { classAt: () => 0 } });

// ---- the bake ---------------------------------------------------------------------
// Two carriageways overlapping by 2 m, a metre apart in level (a cross-slope),
// stamped in either order: the grid on each centreline takes ITS grade.
test('a tie between two carriageways goes to the one the sample lies in, not to stamp order', () => {
  const slope = (x, z) => 220 + (z - 600) * 0.12;          // 12 %: a metre over 8 m across
  for (const order of [0, 1]) {
    const t = terrainOf(slope);
    const a = { d: 1, ow: 1, t: 'primary', w: 10, p: [[200, 600], [1000, 600]] };
    const b = { d: 1, ow: 1, t: 'primary', w: 10, p: [[1000, 608], [200, 608]] };
    conformTerrainTile(t, cityWith(order ? [b, a] : [a, b]), 0, 0);
    // the grid samples on z 600 lie on a's line, inside b's half width too
    let worst = 0;
    for (let x = 300; x <= 900; x += RES) {
      const g = t.grids.get('0,0')[(600 / RES) * t.n + x / RES] / 10;
      worst = Math.max(worst, Math.abs(g - roadGradeY(a, x - 200, t)));
    }
    assert.ok(worst < 0.06, `order ${order}: the grid on a's line strays ${worst.toFixed(2)} m off a's grade`);
  }
});

test('the shoulder is a batter: a road at grade moves no earth ten metres out', () => {
  const t = terrainOf((x, z) => 220 + 0.4 * Math.sin(x * 0.05) + (z > 640 ? 1.5 : 0));
  const raw = t.grids.get('0,0').slice();
  const road = { d: 1, t: 'primary', w: 9, p: [[200, 600], [1000, 600]] };
  conformTerrainTile(t, cityWith([road]), 0, 0);
  const g = t.grids.get('0,0');
  // z 620: 15.5 m past the edge, a bank of 1.5 m (fall 2 + 2.25 m) cannot reach it
  let moved = 0;
  for (let x = 300; x <= 900; x += RES) {
    const o = (620 / RES) * t.n + x / RES;
    if (g[o] !== raw[o]) moved++;
  }
  assert.equal(moved, 0, `${moved} samples moved 15 m past the edge of a road at grade`);
});

test('between two parallel carriageways the median takes their level', () => {
  // a dell between them: the survey is 2 m low midway (z 620, a grid row); the
  // roads are levelled over their own lines, so the median would keep the dell
  const dell = (x, z) => 220 - 2 * Math.exp(-(((z - 620) / 5) ** 2));
  const t = terrainOf(dell);
  const raw = t.grids.get('0,0').slice();
  const a = { d: 1, ow: 1, t: 'trunk', w: 8, p: [[200, 610], [1000, 610]] };
  const b = { d: 1, ow: 1, t: 'trunk', w: 8, p: [[1000, 630], [200, 630]] };
  conformTerrainTile(t, cityWith([a, b]), 0, 0);
  let worst = 0, dip = 0;
  for (let x = 300; x <= 900; x += RES) {
    const o = (620 / RES) * t.n + x / RES;
    const g = t.grids.get('0,0')[o] / 10;
    const want = (roadGradeY(a, x - 200, t) + roadGradeY(b, 1000 - x, t)) / 2;
    worst = Math.max(worst, Math.abs(g - want));
    dip = Math.max(dip, want - raw[o] / 10);
  }
  assert.ok(dip > 0.5, 'the fixture has a dell in the median');
  assert.ok(worst < 0.06, `the median strays ${worst.toFixed(2)} m from the two decks' level`);
});

// ---- feet and wheels ----------------------------------------------------------------
test('feet on a carriageway never stand on the baked grid above its deck', () => {
  const t = terrainOf((x, z) => 220 + (z - 600) * 0.12);
  const a = { d: 1, ow: 1, t: 'primary', w: 10, p: [[200, 600], [1000, 600]] };
  const b = { d: 1, ow: 1, t: 'primary', w: 10, p: [[1000, 608], [200, 608]] };
  const city = cityWith([a, b]);
  conformTerrainTile(t, city, 0, 0);
  const w = worldOf(t, city);
  let worst = 0;
  for (let x = 300; x <= 900; x += 3) {
    for (const z of [598, 600, 602]) {
      const deck = roadGradeY(a, x - 200, t) + LAYER_Y.road;
      worst = Math.max(worst, w.heightAt(x, z, deck) - deck);
    }
  }
  assert.ok(worst < 0.03, `feet stand ${worst.toFixed(2)} m over the asphalt`);
});

test('the wheels read the deck of the nearest segment, not of a vertex ahead', () => {
  // a 6 % climb, vertices every 30 m: 4 m before a vertex the clamped projection
  // of the next segment is that vertex, 4 m higher up the road
  const t = terrainOf((x) => 200 + x * 0.06);
  const p = [];
  for (let x = 200; x <= 1000; x += 30) p.push([x, 600 + (((x - 200) / 30) & 1) * 0.8]);
  const road = { d: 1, t: 'primary', w: 10, p };
  const city = cityWith([road]);
  const w = worldOf(t, city);
  let worst = 0;
  let along = 0;
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, az] = p[i - 1], [bx, bz] = p[i];
    const L = Math.hypot(bx - ax, bz - az);
    const u = (L - 4) / L, x = ax + (bx - ax) * u, z = az + (bz - az) * u;
    const deck = roadGradeY(road, along + L - 4, t) + LAYER_Y.road;
    worst = Math.max(worst, Math.abs(w.surfaceY(x, z, deck).y - deck));
    along += L;
  }
  assert.ok(worst < 0.03, `a wheel 4 m before a vertex rides ${worst.toFixed(2)} m off its deck`);
});

// ---- the shape the ground meets a way with ------------------------------------------
test('the embankment floor falls at 1:1.5 from just under the deck edge', () => {
  const r = { d: 1, t: 'primary', w: 10, p: [[0, 0], [100, 0]] };
  const e = B.roadCorr(r, [0, 0, 100, 0]);
  assert.equal(e.bat, true);
  const top = 200 + LAYER_Y.road;
  assert.ok(Math.abs(B.floorOf(e, 200, 4) - (top - 0.45)) < 1e-9, 'under the deck the floor keeps its depth');
  const f6 = B.floorOf(e, 200, 6), f9 = B.floorOf(e, 200, 9);
  assert.ok(Math.abs((f6 - f9) / 3 - 1 / B.BATTER) < 1e-9, 'the floor falls 1 in 1.5');
  assert.ok(top - (B.floorOf(e, 200, 5.0001)) < 0.05, 'the crest is snug under the edge');
  // a kerbed street keeps the old bench (no streetOf here: every road counts as outside)
  const rail = B.railCorr({ t: 'rail', p: [[0, 0], [100, 0]] }, [0, 0, 100, 0]);
  assert.ok(Math.abs(B.capOf(rail, 200, 4.5) - B.capOf(rail, 200, 3) - 1.5 / B.BATTER) < 1e-9,
    'a track\'s ceiling climbs at the batter past its bed');
});

// a TriSink stand-in: collects quads with their corners
function sinkStub() {
  const quads = [];
  return { quads, at() { return this; },
    tri(ax, ay, az, bx, by, bz, cx, cy, cz) { quads.push([[ax, ay, az], [bx, by, bz], [cx, cy, cz]]); } };
}
function stations(p, step = 4) {
  const q = [], per = [];
  const [[ax, az], [bx, bz]] = p, L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
  for (let s = 0; s <= L + 1e-6; s += step) { q.push([ax + ux * s, az + uz * s]); per.push([-uz, ux]); }
  return { q, per };
}

test('a verge face runs down at 1:1.5 to the ground, and not at all onto a sibling deck', () => {
  // flat ground 1.2 m under a deck: an embankment
  const t = terrainOf(() => 220);
  const a = { d: 1, ow: 1, t: 'primary', w: 10, p: [[200, 600], [400, 600]] };
  const city = cityWith([a]);
  const { q, per } = stations(a.p);
  const ys = q.map(() => 221.2 + LAYER_Y.road);
  const ents = B.edgeNear(city, a);
  const sk = sinkStub();
  B.vergeFacesInto(sk, a, q, per, ys, 5, t, ents, null, [0.4, 0.5, 0.3]);
  assert.ok(sk.quads.length > 0, 'an embankment gets its faces');
  // every face corner off the edge lies on the 1:1.5 line from the deck edge
  let off = 0;
  for (const qd of sk.quads) for (const [x, y, z] of qd) {
    const e = Math.abs(z - 600) - 5;
    if (e > 0.05 && y > 220) off = Math.max(off, Math.abs(y - (ys[0] - e / B.BATTER)));
  }
  assert.ok(off < 0.13, `a face corner is ${off.toFixed(2)} m off the batter`);   // (the toe drops 0.12)
  // a twin carriageway whose deck covers this one's edge, within 5 cm: no face on that side
  const b = { d: 1, ow: 1, t: 'primary', w: 10, p: [[400, 609], [200, 609]] };
  const city2 = cityWith([a, b]);
  const t2 = terrainOf(() => 220);
  // both decks at the same level: give b the same profile by levelling over the same ground
  const yA = roadGradeY(a, 100, t2), yB = roadGradeY(b, 100, t2);
  assert.ok(Math.abs(yA - yB) < 0.01);
  const ys2 = q.map((_, i) => roadGradeY(a, i * 4, t2) + LAYER_Y.road);
  const sk2 = sinkStub();
  B.vergeFacesInto(sk2, a, q, per, ys2, 5, t2, B.edgeNear(city2, a), null, [0.4, 0.5, 0.3]);
  const onTwinSide = sk2.quads.filter((qd) => qd.some(([, , z]) => z > 605.2)).length;
  assert.equal(onTwinSide, 0, `${onTwinSide} face quads stand on the twin deck`);
});

test('two tracks of one bed share their ballast: no inner shoulders between them', () => {
  const t = terrainOf(() => 220);
  const a = { t: 'rail', p: [[200, 600], [400, 600]] };
  const b = { t: 'rail', p: [[200, 604.5], [400, 604.5]] };
  const city = cityWith([], [a, b]);
  const { q, per } = stations(a.p);
  const g = q.map((_, i) => railGradeY(a, i * 4, t));
  const sk = sinkStub();
  B.railShouldersInto(sk, a, q, per, g, t, B.edgeNear(city, a), null, [0.4, 0.4, 0.4]);
  // toward b (z > 600) the bed runs flat to the midline at 602.25
  let worst = 0, reach = 0;
  for (const qd of sk.quads) for (const [, y, z] of qd) {
    if (z > 601.3) { worst = Math.max(worst, Math.abs(y - (g[0] + LAYER_Y.rail - 0.025))); reach = Math.max(reach, z); }
  }
  assert.ok(Math.abs(reach - 602.25) < 0.01, `the infill reaches ${reach.toFixed(2)}, not the midline`);
  assert.ok(worst < 0.01, `the infill between level tracks is ${worst.toFixed(2)} m off their bed`);
  // and the feet on it
  const w = worldOf(t, city);
  const bed = g[10] + LAYER_Y.rail;
  assert.ok(Math.abs(w.heightAt(240, 602, bed) - (bed - 0.025)) < 0.03, 'feet between the tracks stand on the bed');
});

// ---- the trains ----------------------------------------------------------------------
test('a train route is graded every 10 m, on the same arclength', () => {
  const t = terrainOf((x) => 200 + 6 * Math.sin(x / 120));
  const w = { t: 'rail', p: [[100, 600], [220, 600], [400, 610], [700, 600]] };
  cityWith([], [w]);
  const [c] = chainRailWays([w]);
  let gap = 0;
  for (let i = 1; i < c.pts.length; i++) gap = Math.max(gap, Math.hypot(c.pts[i][0] - c.pts[i - 1][0], c.pts[i][1] - c.pts[i - 1][1]));
  assert.ok(gap <= 10 + 1e-6, `points ${gap.toFixed(1)} m apart`);
  assert.ok(Math.abs(c.len - polylineLength(w.p)) < 1e-6, 'the route is as long as its way');
  assert.equal(c.wy.length, c.pts.length);
  assert.ok(c.ws.every((s, i) => i === 0 || s >= c.ws[i - 1]), 'arclengths run along the way');
});

test('a spliced path is graded on its ways and interpolated across a weld', () => {
  const w1 = { t: 'rail', p: [[0, 0], [50, 0]] }, w2 = { t: 'rail', p: [[60, 0], [100, 0]] };
  const pts = [[0, 0], [50, 0], [60, 0], [100, 0]];
  const at = [[w1, 0], [w1, 50], [w2, 0], [w2, 40]];
  const g = gradedPath(pts, at, railHeadOn(w1, 0, 0, 0));
  assert.ok(g.pts.length >= 11, 'sampled every 10 m');
  for (let i = 0; i < g.pts.length; i++) {
    if (g.wy[i]) assert.ok(Math.abs(g.ys[i] - railHeadOn(g.wy[i], g.ws[i], g.pts[i][0], g.pts[i][1])) < 1e-9);
  }
});

test('the untiled ground is known from the manifest', () => {
  const city = { tile: 4800, manifestTiles: [{ tx: 0, tz: 0 }, { tx: -1, tz: 0 }] };
  assert.equal(untiledAt(city, 100, 100), false);
  assert.equal(untiledAt(city, -100, 100), false);
  assert.equal(untiledAt(city, 100, -100), true);
  assert.equal(untiledAt({ tile: 4800 }, 100, -100), false, 'no manifest: nothing is a hole');
});
