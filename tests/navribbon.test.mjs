// ---- the satnav ribbon: in the lane, out of the car, cut per pixel ------------
import test from 'node:test';
import assert from 'node:assert';
import { routeCum, sliceAhead } from '../js/routeahead.js';
import { buildRibbon, navCut, CUT_KEEP, NAV_CUT_GLSL } from '../js/navribbon.js';

const scratch = (n) => ({ x: new Float64Array(n), z: new Float64Array(n), s: new Float64Array(n) });
function ribbon(route, s0, len, offs, car = null, blend = 0) {
  const cum = routeCum(route);
  const sl = scratch(256);
  const n = sliceAhead(route, cum, s0, len, sl, 256, 0, 0, 5);
  const pos = new Float32Array(n * 6), aS = new Float32Array(n * 2);
  const o = offs ? new Float64Array(n).fill(offs) : null;
  const ctr = { x: new Float64Array(n), z: new Float64Array(n) };
  buildRibbon(sl, n, o, 0.4, pos, aS, 0, null, 0.25, car, blend, ctr);
  return { n, pos, aS, ctr, sl };
}

test('the ribbon keeps its width, flat on the given height', () => {
  const r = ribbon([[0, 0], [100, 0], [100, 100]], 0, 200, 0);
  for (let k = 0; k < r.n; k++) {
    const w = Math.hypot(r.pos[k * 6] - r.pos[k * 6 + 3], r.pos[k * 6 + 2] - r.pos[k * 6 + 5]);
    assert.ok(w >= 0.8 - 1e-4 && w <= 0.8 * 2.4 + 1e-4, `width ${w} at ${k}`);
    assert.equal(r.pos[k * 6 + 1], 0.25);
  }
  // on the straights the width is exactly the line's
  assert.ok(Math.abs(Math.hypot(r.pos[0] - r.pos[3], r.pos[2] - r.pos[5]) - 0.8) < 1e-5);
});

test('a positive offset puts the line on the right of travel', () => {
  // travelling east (+x) in a frame where +z is south: right is +z
  const r = ribbon([[0, 0], [200, 0]], 0, 100, 1.5);
  for (let k = 0; k < r.n; k++) assert.ok(Math.abs(r.ctr.z[k] - 1.5) < 1e-9);
  // …and the left edge vertex comes first (the winding needs it)
  assert.ok(r.pos[2] < r.pos[5], 'left (north) edge before right (south) edge');
  // travelling north (−z): right is +x; negative offset (Mahé) goes left, −x
  const m = ribbon([[0, 0], [0, -200]], 0, 100, -1.5);
  for (let k = 0; k < m.n; k++) assert.ok(Math.abs(m.ctr.x[k] + 1.5) < 1e-9);
});

test('the head leaves from the car, then settles into the lane', () => {
  const car = { x: 20, z: -2, s: 20 };            // 2 m LEFT of the centreline
  const r = ribbon([[0, 0], [300, 0]], 20, 200, 1.5, car, 24);
  let k = 0;
  while (r.sl.s[k] < 20) k++;
  assert.ok(Math.abs(r.ctr.z[k] - -2) < 0.01, `at the car the line is at z ${r.ctr.z[k]}`);
  for (let j = 0; j < r.n; j++) {
    if (r.sl.s[j] >= 44) assert.ok(Math.abs(r.ctr.z[j] - 1.5) < 1e-9, 'in the lane past the blend');
  }
});

test('per-vertex arclength is what the cut reads', () => {
  const r = ribbon([[0, 0], [300, 0]], 40, 100, 0);
  assert.equal(r.aS[0], 40);
  assert.equal(r.aS[1], 40);
  assert.equal(r.aS[r.n * 2 - 1], 140);
});

test('the cut lights nothing behind its start, ramps in, fades a window end', () => {
  const a = [100, 6, 400, 50], b = [99, 0, 1, 0];
  assert.equal(navCut(99.9, 99.9, 0, a, b), 0, 'behind the start');
  assert.equal(navCut(100, 100, 0, a, b), 0, 'exactly at it');
  const mid = navCut(103, 103, 0, a, b);
  assert.ok(mid > 0 && mid < 1, 'ramping');
  assert.equal(navCut(130, 130, 0, a, b), 1, 'fully lit ahead');
  assert.ok(navCut(380, 380, 0, a, b) < 1, 'dissolving toward the window end');
  assert.equal(navCut(400, 400, 0, a, b), 0);
  assert.equal(navCut(399, 399, 0, [100, 6, 400, 0], b), 1, 'a destination ends crisply');
});

test('a returning leg is cut only once it is a different piece of road', () => {
  const a = [0, 6, 1000, 0], b = [0, 0, 1, 0];       // car at the origin facing +x
  // near (inside CUT_KEEP) a point behind in space stays lit: a roundabout ring
  assert.equal(navCut(CUT_KEEP - 1, -10, 5, a, b), 1);
  // far along the route but physically behind: gone
  assert.equal(navCut(CUT_KEEP + 60, -10, 5, a, b), 0);
  // far along and in front: lit
  assert.equal(navCut(CUT_KEEP + 60, 30, 5, a, b), 1);
});

test('the GLSL and the JS cut say the same thing', () => {
  assert.match(NAV_CUT_GLSL, new RegExp('ds > ' + CUT_KEEP.toFixed(1).replace('.', '\\.')));
  assert.match(NAV_CUT_GLSL, /diffuseColor\.a \*= a \* a \* \(3\.0 - 2\.0 \* a\)/);
});

test('a car far off the lane does not drag the line out to it', () => {
  const car = { x: 20, z: -30, s: 20 };           // 30 m off: a car park, not a lane
  const r = ribbon([[0, 0], [300, 0]], 20, 100, 1.5, car, 24);
  for (let k = 0; k < r.n; k++) assert.ok(Math.abs(r.ctr.z[k] - 1.5) < 1e-9);
});
