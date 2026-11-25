// ---- the route ahead of the car, and only that -----------------------------------
// js/routeahead.js answers "where am I on the route" and "what is still in
// front of me" for the line on the road, the HUD disc and the region map.
// Frank, 25 Nov 2026: the line "si zobrazuje trošku i za mnou, což je blbost".
import test from 'node:test';
import assert from 'node:assert';
import {
  routeCum, trackRoute, pointAt, sliceAhead, blendStart, offsetAt, visibleCount,
} from '../js/routeahead.js';

const scratch = (n) => ({ x: new Float64Array(n), z: new Float64Array(n), s: new Float64Array(n) });
// an L: 300 m east, then 200 m south
const L = [[0, 0], [100, 0], [300, 0], [300, 200]];
const cumL = routeCum(L);

test('arclength runs along the polyline', () => {
  assert.deepStrictEqual([...cumL], [0, 100, 300, 500]);
  assert.equal(routeCum([[5, 5]]).length, 1);
});

test('pointAt interpolates and gives the tangent', () => {
  const p = { x: 0, z: 0, dx: 0, dz: 0 };
  assert.equal(pointAt(L, cumL, 150, p), 1);
  assert.deepStrictEqual([p.x, p.z, p.dx, p.dz], [150, 0, 1, 0]);
  pointAt(L, cumL, 400, p);
  assert.deepStrictEqual([p.x, p.z, p.dx, p.dz], [300, 100, 0, 1]);
  pointAt(L, cumL, 9999, p);                         // clamped to the end
  assert.deepStrictEqual([p.x, p.z], [300, 200]);
});

test('the slice starts exactly at the car and never reaches behind it', () => {
  const out = scratch(64);
  const n = sliceAhead(L, cumL, 120, 250, out, 64);
  assert.deepStrictEqual([out.x[0], out.z[0], out.s[0]], [120, 0, 120]);
  for (let j = 0; j < n; j++) assert.ok(out.s[j] >= 120, `point ${j} at ${out.s[j]} m is behind the car`);
  for (let j = 1; j < n; j++) assert.ok(out.s[j] > out.s[j - 1], 'arclength increases');
  // through the corner vertex, ending interpolated 250 m on
  assert.deepStrictEqual([out.x[1], out.z[1]], [300, 0]);
  assert.deepStrictEqual([out.x[n - 1], out.z[n - 1], out.s[n - 1]], [300, 70, 370]);
});

test('the slice stops at the destination', () => {
  const out = scratch(64);
  const n = sliceAhead(L, cumL, 450, 1000, out, 64);
  assert.equal(n, 2);
  assert.deepStrictEqual([out.x[1], out.z[1], out.s[1]], [300, 200, 500]);
  assert.equal(sliceAhead(L, cumL, 500, 100, out, 64), 0, 'nothing left at the end');
});

test('maxStep fills a long straight with points on the route', () => {
  const route = [[0, 0], [400, 0]];
  const out = scratch(128);
  const n = sliceAhead(route, routeCum(route), 10, 300, out, 128, 0, 0, 10);
  for (let j = 1; j < n; j++) {
    assert.ok(out.s[j] - out.s[j - 1] <= 10 + 1e-9, 'no gap over maxStep');
    assert.equal(out.z[j], 0, 'on the route');
  }
  assert.equal(out.s[n - 1], 310);
});

test('the slice respects its capacity and keeps the end point', () => {
  const route = [];
  for (let x = 0; x <= 1000; x += 5) route.push([x, 0]);
  const out = scratch(16);
  const n = sliceAhead(route, routeCum(route), 0, 900, out, 16);
  assert.equal(n, 16);
  assert.equal(out.s[n - 1], 900, 'the far end is still where it should be');
});

test('tracking follows the car and survives a route that doubles back', () => {
  const route = [];
  for (let x = 0; x <= 400; x += 10) route.push([x, 0]);
  for (let x = 400; x >= 0; x -= 10) route.push([x, 4]);
  const cum = routeCum(route);
  const st = { i: 0, s: 0 };
  let worst = 0;
  for (let x = 2; x <= 390; x += 3) {
    trackRoute(route, cum, x, 1.9, st);                 // nearer the RETURN leg
    worst = Math.max(worst, Math.abs(st.s - x));
  }
  assert.ok(worst < 3, `matched ${worst.toFixed(1)} m from the car on the outbound pass`);
  // a teleport far along is still found
  trackRoute(route, cum, 100, 4, st);
  assert.ok(Math.abs(st.s - 704) < 1, `re-matched at ${st.s}`);   // 400 out, 4 across, 300 back
});

test('blendStart bends the head onto the car and leaves the rest alone', () => {
  const route = [[0, 0], [200, 0]];
  const out = scratch(64);
  const n = sliceAhead(route, routeCum(route), 50, 100, out, 64, 0, 0, 5);
  blendStart(out, n, 0, 3, 20);                         // the car is 3 m right of the line
  assert.equal(out.z[0], 3, 'starts at the car');
  for (let j = 1; j < n; j++) {
    assert.ok(out.z[j] <= out.z[j - 1] + 1e-9, 'eases monotonically');
    if (out.s[j] - out.s[0] >= 20) assert.equal(out.z[j], 0, 'back on the route past the blend');
  }
});

test('offsetAt interpolates per-vertex lane offsets', () => {
  const off = [1.5, 1.5, 0, 0];
  assert.equal(offsetAt(off, cumL, 50), 1.5);
  assert.equal(offsetAt(off, cumL, 200), 0.75);
  assert.equal(offsetAt(off, cumL, 400), 0);
  assert.equal(offsetAt(null, cumL, 50), 0);
});

test('visibleCount stops once the line has left the disc for good', () => {
  const route = [[0, 0], [1000, 0]];
  const out = scratch(256);
  const n = sliceAhead(route, routeCum(route), 0, 1000, out, 256, 0, 0, 10);
  const m = visibleCount(out, n, 0, 0, 100, 50);
  assert.ok(m < n && out.s[m - 1] <= 170 && out.s[m - 1] >= 150, `cut at ${out.s[m - 1]} m`);
});
