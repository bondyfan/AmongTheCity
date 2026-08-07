// ---- two carriageways over the same ground must agree about its height ----
// OSM does not join every way that overlaps: the parallel ways of one street, a
// service road along a kerb, a driveway crossed by a lane. Each is levelled on
// its own, so one ended up lying ON the other — "je to jako vyšší layer... s
// autem nadskočím". Measured over one Pardubice tile: 5 474 overlapping
// samples, median step 5 mm but 368 over 15 cm and a worst case of 1.69 m
// between two 3.6 m service roads, of which 297 were CROSSINGS.
//
// Real junctions were never the problem (795 measured, worst 1 cm). What was
// missing is a node where two ways overlap without sharing one.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));

const geo = await import('../js/geo.js');

// Ground that RISES steeply to the east. A way is levelled by smoothing the
// terrain along its own length, so a way running east climbs while a way
// crossing it north–south stays flat — which is exactly how two ways over one
// patch of ground end up at different heights.
const terrain = {
  res: 20, tile: 4800, missed: false, ready: () => true,
  heightAt: (x) => 200 + Math.max(0, Math.min(60, x)) * 0.35,
};

function crossing({ layerA = undefined, layerB = undefined } = {}) {
  const A = { _id: 1, t: 'service', w: 3.6, d: 1, l: layerA,
    p: [[-140, 0], [-70, 0], [0, 0], [70, 0], [140, 0]] };          // runs east, climbs
  const B = { _id: 2, t: 'service', w: 3.6, d: 1, l: layerB,
    p: [[30, -140], [30, -70], [30, 0], [30, 70], [30, 140]] };     // crosses it, flat
  for (const r of [A, B]) r._len = geo.polylineLength(r.p);
  geo.indexJunctions([A, B]);
  const at = (r, x, z) => {
    let best = Infinity, bs = 0, run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
      if (d < best) { best = d; bs = run + L * t; }
      run += L;
    }
    return geo.roadGradeY(r, bs, terrain);
  };
  // they cross at (30, 0) and share no node there
  return { step: Math.abs(at(A, 30, 0) - at(B, 30, 0)), A, B };
}

test('two ways crossing without a shared node still meet at one height', () => {
  const { step } = crossing();
  assert.ok(step < 0.06,
    `the carriageways step by ${(step * 100).toFixed(0)} cm where they cross — `
    + 'a car driving one of them rides up onto the other');
});

test('…and the node that does it is a real one, not a coincidence', () => {
  const { A, B } = crossing();
  const pin = (A._pins ?? []).find((p) => p.node._ovl && (p.node.arms ?? []).some((a) => a.r === B));
  assert.ok(pin, 'no overlap node was created for the crossing');
  assert.ok(Math.abs(pin.node.x - 30) < 4 && Math.abs(pin.node.z) < 4,
    `the overlap node landed at ${pin.node.x.toFixed(0)},${pin.node.z.toFixed(0)} `
    + 'instead of at the crossing (30, 0)');
});

test('a flyover is left alone — different layer, different height', () => {
  // `layer` is the only thing in the data that separates a mapping accident
  // from a road deliberately passing over another. Reconciling those would
  // flatten every underpass in the country.
  const { step } = crossing({ layerA: 1 });
  assert.ok(step > 0.2,
    'a way on layer 1 was levelled together with the one it passes over');
});
