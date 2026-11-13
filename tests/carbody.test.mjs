// The car bodies are generated, so the things that can silently go wrong are
// numeric: a spline that overshoots its stations, a patch that falls off the
// surface and leaves NaNs in a buffer, a kind whose geometry quietly triples.
// None of it needs WebGL: the builders are pure geometry.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { pchip, makeShape } = await import('../js/carbody.js');
const { buildCar, STYLE } = await import('../js/cardetail.js');
const VEH = await import('../js/vehicles.js');

test('pchip passes through its stations and never overshoots them', () => {
  const xs = [-2.35, -2.24, -1.95, -1.1, -0.65, 0.6, 1.55, 2.1, 2.35];
  const ys = [0.52, 0.66, 0.74, 0.84, 0.88, 0.90, 0.93, 0.90, 0.82];
  const f = pchip(xs, ys);
  for (let i = 0; i < xs.length; i++) assert.ok(Math.abs(f(xs[i]) - ys[i]) < 1e-9);
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = Math.min(ys[i], ys[i + 1]) - 1e-9, hi = Math.max(ys[i], ys[i + 1]) + 1e-9;
    for (let k = 1; k < 20; k++) {
      const y = f(xs[i] + (xs[i + 1] - xs[i]) * k / 20);
      assert.ok(y >= lo && y <= hi, `overshoot between stations ${i} and ${i + 1}: ${y}`);
    }
  }
});

test('every kind has a closed, finite body surface with wheel openings', () => {
  for (const kind of VEH.CAR_KINDS) {
    const s = VEH.bodySurface(kind);
    assert.ok(s.z1 - s.z0 > 2, kind);
    let arch = 0;
    for (let k = 0; k <= 60; k++) {
      const z = s.z0 + (s.z1 - s.z0) * k / 60;
      const top = s.topAt(z, 0), half = s.halfAt(z, top * 0.5);
      assert.ok(Number.isFinite(top) && top > 0.3, `${kind}: top at z ${z}`);
      assert.ok(Number.isFinite(half) && half > 0.3, `${kind}: half width at z ${z}`);
      arch = Math.max(arch, s.archTop(z));
    }
    assert.ok(arch > 0.5, `${kind}: no wheel arch found`);
  }
});

test('the exterior never sits inside the silhouette the cabin is cut from', () => {
  // cardetail.js may restyle noses and tails, but only outward: over the cabin
  // the smooth body must be at least as wide and as tall as the stations say.
  const K = { len: 4.7, wid: 1.81, wheelR: 0.32, axle: 1.45,
    hull: { sh: 0.84, bw: 0.90, yA: 0.34, yB: 0.80, sts: [
      [-2.35, 0.30, 0.52, 0.66], [-2.24, 0.22, 0.66, 0.84], [-1.95, 0.18, 0.74, 0.93],
      [-1.10, 0.16, 0.84, 0.99], [-0.65, 0.16, 0.88, 1.00], [0.60, 0.16, 0.90, 1.00],
      [1.55, 0.16, 0.93, 0.97], [2.10, 0.20, 0.90, 0.89], [2.35, 0.26, 0.82, 0.78]] },
    green: { baseW: 0.88, topW: 0.68, sts: [
      [-0.72, 0.87, 0.90], [-0.02, 0.88, 1.44], [0.30, 0.885, 1.44],
      [0.44, 0.885, 1.435], [1.30, 0.90, 1.40], [2.06, 0.90, 0.94]],
      segs: ['gp', 'pg', 'pp', 'pg', 'gp'] } };
  const S = makeShape(K, STYLE.octavia);
  const half = K.wid / 2;
  // the cabin runs from the screen header (z −0.02) to the C-pillar (z 1.30)
  for (let z = 0; z <= 1.3; z += 0.1) {
    assert.ok(S.topAt(z, 0) >= 1.40, `roof too low at z ${z.toFixed(1)}`);
    assert.ok(S.halfAt(z, 0.5) >= 0.99 * half - 0.02, `flank too narrow at z ${z.toFixed(1)}`);
    // the B-pillar trim's outer top corner (x 0.575, y 1.43) must stay under the skin
    assert.ok(S.topAt(z, 0.575) >= 1.40 - (z > 1.0 ? 0.05 : 0), `roof rail cuts the corner at z ${z.toFixed(1)}`);
  }
  // …and the whole car builds inside its budget with no hole in any buffer
  const car = buildCar('octavia', K);
  const tris = (g) => (g ? g.index.count / 3 : 0);
  const n = car.near, f = car.far;
  const near = tris(n.paint) + tris(n.glass) + tris(n.detail) + tris(n.head) + tris(n.tail) + 4 * tris(car.wheel[0]);
  const far = tris(f.paint) + tris(f.detail) + tris(f.head) + tris(f.tail);
  assert.ok(near > 4000 && near <= 7500, `near car is ${near} triangles`);
  assert.ok(far <= 1800, `distance car is ${far} triangles`);
  for (const g of [n.paint, n.glass, n.detail, n.head, n.tail, n.brake, f.paint, f.detail, car.wheel[0], car.wheel[1]]) {
    for (const name of ['position', 'normal']) {
      const a = g.attributes[name].array;
      for (let i = 0; i < a.length; i++) assert.ok(Number.isFinite(a[i]), `${name}[${i}] is not finite`);
    }
  }
});
