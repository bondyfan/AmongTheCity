// Corridors (round 10): one smooth height profile per corridor, not per OSM way.
// Pure modules on synthetic ways; the real places are measured by the survey's
// scan (survey13/scan/scan.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK } from '../js/config.js';
import { inScope, outranks, endIndex, seriesNext, parallel, buildAxis, membersOf } from '../js/corridorgeom.js';
import { gradeLimit, fitProfile, applyPins, gaussBlur, applyFloors, smax, smin, crestFall } from '../js/corridorfit.js';
import { corridorLevel, invalidateBridgeFit, sameCorridor } from '../js/corridorlevel.js';
import { indexLevelCrossings, indexTileCrossings } from '../js/levelxing.js';

let ID = 1000;
const road = (p, o = {}) => ({ p, t: 'primary', d: 1, w: 10.5, v: 80, ow: 1, _id: ++ID, ...o });
const line = (x0, z0, x1, z1, n = 8) => Array.from({ length: n + 1 }, (_, i) => [x0 + (x1 - x0) * i / n, z0 + (z1 - z0) * i / n]);

function cityOf(ways, rails = [], barriers = []) {
  const chunkIndex = new Map();
  const put = (w, kind) => {
    const seen = new Set();
    for (const [x, z] of w.p) {
      const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
      if (seen.has(k)) continue; seen.add(k);
      let c = chunkIndex.get(k);
      if (!c) chunkIndex.set(k, c = { roads: [], rails: [], barriers: [] });
      c[kind].push(w);
    }
  };
  for (const w of ways) put(w, 'roads');
  for (const w of rails) put(w, 'rails');
  for (const w of barriers) put(w, 'barriers');
  // a long segment crosses cells between its vertices: file the cells it passes
  return { chunkIndex };
}
// an embankment 25 m wide along z = 0 that the "survey" has rounded: 2 m high
// at the axis, falling off as a Gaussian, on ground rising gently to the east
const embank = { _loads: 0, heightAt: (x, z) => 200 + 0.004 * x + 2 * Math.exp(-(z * z) / (2 * 9 * 9)) + 0.3 * Math.sin(x / 23) };

test('scope, rank and the straight-through chain are plain tag and plan facts', () => {
  assert.equal(inScope(road(line(0, 0, 100, 0))), true);
  assert.equal(inScope(road(line(0, 0, 100, 0), { t: 'secondary' })), false);
  assert.equal(inScope({ p: line(0, 0, 100, 0), t: 'rail' }), true);
  assert.equal(inScope({ p: line(0, 0, 100, 0), t: 'tram' }), false);
  const rail = { t: 'rail', _id: 5 }, mw = { t: 'motorway', v: 130, _id: 1 }, lk = { t: 'motorway_link', v: 60, _id: 2 };
  assert.ok(outranks(rail, mw) && outranks(mw, lk) && !outranks(lk, mw));
  // a fork: the straight continuation is the series partner, the slip is not
  const a = road(line(0, 0, 200, 0)), b = road(line(200, 0, 400, 0)), slip = road(line(200, 0, 380, 40), { t: 'primary_link' });
  const ends = endIndex([a, b, slip]);
  assert.equal(seriesNext(ends, a, 1).w, b);
  assert.equal(seriesNext(ends, slip, 0), null);
});

test('the two halves of a dual road pair; same-direction or far ways do not', () => {
  const sb = road(line(0, 0, 400, 0)), nb = road(line(400, 10, 0, 10));
  const same = road(line(0, -20, 400, -20)), far = road(line(400, 40, 0, 40));
  assert.equal(parallel(sb, nb), true);
  assert.equal(parallel(nb, sb), true);
  assert.equal(parallel(sb, same), false, 'both driven east: not the other carriageway');
  assert.equal(parallel(sb, far), false);
  // membership does not depend on the order the candidates come in
  const ways = [sb, nb, same, far];
  const ax = buildAxis(endIndex(ways), sb, 300);
  const m1 = membersOf(sb, ways, endIndex(ways), ax, 40).map((w) => w._id);
  const rev = [...ways].reverse();
  const m2 = membersOf(sb, rev, endIndex(rev), ax, 40).map((w) => w._id);
  assert.deepEqual(m1, m2);
  assert.deepEqual(m1, [sb._id, nb._id].sort((x, y) => x - y));
});

test('the grade limit is symmetric: a spike is halved, a pit filled as much as a crest is cut', () => {
  const n = 101, g = new Float64Array(n).fill(0.05);
  const up = new Float64Array(n); up[50] = 4;
  const dn = new Float64Array(n); dn[50] = -4;
  gradeLimit(up, g); gradeLimit(dn, g);
  for (let i = 1; i < n; i++) assert.ok(Math.abs(up[i] - up[i - 1]) <= 0.05 + 1e-9);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(up[i] + dn[i]) < 1e-9, 'mirror images');
  assert.ok(up[50] > 1.9 && up[50] < 2.1);
});

test('the fit holds its grade and its bounds, and pins land exactly', () => {
  const n = 600, T = new Float64Array(n), free = new Uint8Array(n);
  for (let i = 0; i < n; i++) T[i] = 200 + 1.5 * Math.sin(i / 7) + (i > 300 ? 6 : 0);
  const cut = new Float64Array(n).fill(4), fill = new Float64Array(n).fill(4), grade = new Float64Array(n).fill(0.025);
  const y = fitProfile(T, free, cut, fill, grade, 2, { sigma: 20, passes: 24, final: 40 });
  let gmax = 0, kmax = 0;
  for (let i = 1; i < n; i++) gmax = Math.max(gmax, Math.abs(y[i] - y[i - 1]) / 2);
  for (let i = 5; i < n - 5; i++) kmax = Math.max(kmax, Math.abs(y[i - 5] - 2 * y[i] + y[i + 5]) / 100);
  assert.ok(gmax <= 0.0255, 'grade ' + gmax);
  assert.ok(1 / kmax >= 2000, 'vertical radius ' + (1 / kmax).toFixed(0));
  for (let i = 0; i < n; i++) assert.ok(y[i] >= T[i] - 4.3 && y[i] <= T[i] + 4.3);
  const z = new Float64Array(200).fill(10);
  applyPins(z, 2, [{ s: 100, d: 1 }, { s: 300, d: -0.5 }], () => 40);
  assert.ok(Math.abs(z[50] - 11) < 1e-9 && Math.abs(z[150] - 9.5) < 1e-9);
  assert.ok(Math.abs(z[0] - 10) < 1e-9 && Math.abs(z[99] - 10) < 1e-9);
  assert.equal(gaussBlur(Float64Array.from([1, 1, 1, 1]), 3)[2], 1);
});

test('both carriageways read one line on an embankment the survey rounds', () => {
  const sb = road(line(-800, -5, 800, -5, 32)), nb = road(line(800, 5, -800, 5, 32));
  const city = cityOf([sb, nb]);
  const A = corridorLevel(sb, embank, city, 0), B = corridorLevel(nb, embank, city, 0);
  assert.ok(A && B && A.cor && A.ready);
  // the survey under each centreline: 200 + 2 exp(-25/162) = 201.71 at x 0
  let worst = 0, gmax = 0;
  for (let i = 0; i < A.n; i++) {
    const x = A.gx[i];
    if (Math.abs(x) > 500) continue;
    const j = Math.round((800 - x) / B.ds);
    worst = Math.max(worst, Math.abs(A.y[i] - B.y[j]));
    if (i) gmax = Math.max(gmax, Math.abs(A.y[i] - A.y[i - 1]) / A.ds);
  }
  assert.ok(worst < 0.03, 'step between the carriageways ' + worst.toFixed(3));
  assert.ok(gmax < 0.01, 'grade ' + gmax);
  const mid = A.y[Math.round(800 / A.ds)];
  assert.ok(mid > 201.75, 'the crest, not a shoulder: ' + mid.toFixed(2));
  assert.equal(sameCorridor(sb, nb, embank, city, 0), true);
});

test('a road crossing a railway at grade is pinned to the rail', () => {
  const r = road(line(0, -100, 0, 100), { t: 'secondary', ow: undefined });
  const rail = { p: line(-300, 0, 300, 0), t: 'rail', _id: ++ID };
  assert.equal(indexLevelCrossings([r], [rail]), 1);
  const pin = r._pins[0];
  assert.ok(Math.abs(pin.s - 100) < 1e-6 && pin.node._xing === rail && Math.abs(pin.node._xingS - 300) < 1e-6);
  assert.ok(pin.node.arms.some((a) => a.r === rail), 'the rail is an arm, so releasing it lets the pin go');
});

test('missing height tiles cannot pull a surveyed railway up a neighbouring hill', () => {
  const track = { p: line(-300, 0, 300, 0), t: 'rail', _id: ++ID };
  const terrain = { ready: x => x >= 0, heightAt: x => x < 0 ? 620 : 407 };
  const p = corridorLevel(track, terrain, cityOf([], [track]), 1);
  assert.ok(p);
  for (const h of p.y) assert.ok(Math.abs(h - 407) < 0.01);
});

test('an at-grade crossing shared across two tiles is indexed once in either arrival order', () => {
  for (const railFirst of [false, true]) {
    const r = road(line(20, 0, 20, 80)), train = { p: line(0, 40, 80, 40), t: 'rail', _id: ++ID };
    const city = cityOf([r], [train]);
    for (let repeat = 0; repeat < 2; repeat++)
      Array.from(indexTileCrossings(city, railFirst ? [r] : [], railFirst ? [] : [train], city.chunkIndex.keys()));
    assert.equal(r._pins.length, 1);
    assert.equal(r._pins[0].node._xing, train);
    assert.equal(r._pins[0].s, 40);
  }
});

test('batched clearance crests agree with individual floors and ceilings', () => {
  const input = Float64Array.from({ length: 600 }, (_, i) => 104 + 0.02 * i);
  const points = Array.from({ length: 100 }, (_, i) => ({
    s: i * 13.35 - 123, y: 101 + 8 * Math.sin(i * 0.37), g: i % 2 ? 0.025 : 0.06, R: i % 3 ? 540 : 1333,
  }));
  const floors = points.filter((_, i) => i % 3), ceilings = points.filter((_, i) => !(i % 3));
  const expected = input.map((y, i) => {
    const s = i * 2;
    const f = Math.max(...floors.map(c => c.y - crestFall(Math.abs(c.s - s), c.g, c.R)));
    const c = Math.min(...ceilings.map(c => c.y + crestFall(Math.abs(c.s - s), c.g, c.R)));
    return smin(smax(y, f, 1), c, 1);
  });
  applyFloors(input, 2, floors, ceilings);
  for (let i = 0; i < input.length; i++) assert.ok(Math.abs(input[i] - expected[i]) < 1e-9);
});

test('the shared asphalt of a motorway slip follows the main road through the whole gore', async () => {
  const { fitSlip } = await import('../js/slipgrade.js');
  const main = road([[0, 0], [500, 0]], { t: 'motorway', w: 11 });
  const slip = road([[0, 0], [60, 5], [200, 65]], { t: 'motorway_link', w: 5.5 });
  const city = cityOf([main, slip]), base = { total: 212.52, ds: 2.1252, n: 101, ready: true,
    y: new Float32Array(101).fill(200) };
  const profile = fitSlip(slip, base, {}, city, () => ({ n: 2, ds: 500, y: [202, 202], ready: true }));
  assert.equal(profile.y[20], 202);
  assert.equal(profile.y.at(-1), 200);
  assert.equal(base.y[20], 200);
});

test('a viaduct longer than its fit window uses both real abutments', () => {
  const bridge = road(line(400, 0, 640, 0), { br: 1, t: 'motorway' });
  const left = road([[-1600, 0], [-1500, 0]]), right = road([[2000, 0], [2100, 0]]);
  bridge._apN0 = [{ road: left, at: 100, d: 1900 }, { road: right, at: 0, d: 1600 }];
  bridge._apN1 = [{ road: left, at: 100, d: 2140 }, { road: right, at: 0, d: 1360 }];
  const terrain = { heightAt: x => x <= -1500 ? 220 : x >= 2000 ? 240 : 180 };
  const city = cityOf([bridge]);
  const p = corridorLevel(bridge, terrain, city, 0);
  assert.ok(p);
  assert.ok(p.y[0] > 230 && p.y.at(-1) < 233);
  assert.ok(p.y.at(-1) - p.y[0] > 0.75);
  bridge._apN0 = [{ road: left, at: 100, d: 40 }];
  invalidateBridgeFit(bridge);
  const fresh = corridorLevel(bridge, terrain, city, 1);
  assert.ok(fresh.y[0] < p.y[0] - 4);
});

test('a high motorway merge extends back across a split elevated slip', async () => {
  const { fitSlip } = await import('../js/slipgrade.js');
  const main = road([[200, 0], [300, 0]], { t: 'motorway', br: 1, l: 2 });
  const nose = road([[100, 25], [200, 0]], { t: 'motorway_link', br: 1, l: 2 });
  const upstream = road([[0, 50], [100, 25]], { t: 'motorway_link', br: 1, l: 1 });
  const city = cityOf([main, nose, upstream]);
  const L = Math.hypot(100, 25);
  const base = { n: 51, total: L, ds: L / 50, ready: true, y: new Float32Array(51).fill(200) };
  const highway = () => ({ n: 2, ds: 100, y: [222, 222], ready: true });
  const a = fitSlip(upstream, base, {}, city, highway), b = fitSlip(nose, base, {}, city, highway);
  assert.ok(a.y[0] > 208 && Math.abs(a.y.at(-1) - b.y[0]) < 0.001);
  assert.equal(b.y.at(-1), 222);
});

test('crossing panels hold the rail elevation over their full width and across adjacent tracks', async () => {
  const { fitCrossingPanels } = await import('../js/levelxing.js');
  const y = Float32Array.from({ length: 41 }, (_, i) => 202 + 0.5 * Math.cos(i * 2));
  const before = y[0];
  fitCrossingPanels(y, 2, [{ s: 33.6, y: 201.2 }, { s: 29.5, y: 201.1 }]);
  assert.equal(y[0], before);
  for (let i = 14; i <= 18; i++) assert.ok(y[i] >= 201.099 && y[i] <= 201.201);
});

test('ramp smoothing preserves the sides of a real junction and its endpoints', async () => {
  const { fairLink } = await import('../js/corridorfit.js');
  const y = Float32Array.from({ length: 81 }, (_, i) => 201 + 0.6 * Math.cos(i / 2));
  const way = { t: 'primary_link', _pins: [{ s: 61, node: {} }] };
  const smooth = fairLink({ y, n: y.length, ds: 2 }, way).y;
  for (const i of [0, 30, 31, 80]) assert.equal(smooth[i], y[i]);
  assert.ok(Math.abs(smooth[50] - smooth[56]) < Math.abs(y[50] - y[56]) / 2);
});
