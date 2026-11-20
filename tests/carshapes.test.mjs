// The cars redrawn from the real ones (20 Nov 2026): the Model 3 Performance,
// the Octavia liftback and Combi, and the new Roadster. The drawings are judged
// by eye in the showroom and the game; what can be pinned here are the numbers a
// real car is known by (length, width, wheelbase, roof height, where the belt
// and the tail sit), and the Roadster's one headline figure: 0 to 100 km/h in
// about a second, while it can still be steered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const VEH = await import('../js/vehicles.js');
const { buildCar } = await import('../js/cardetail.js');
const { voiceClass } = await import('../js/enginekinds.js');
const F = await import('../js/fuel.js');

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);
const K = (k) => VEH.kindOf(k);
const roofTop = (k) => { const s = VEH.bodySurface(k); let m = 0; for (let z = s.z0; z <= s.z1; z += 0.05) m = Math.max(m, s.topAt(z, 0)); return m; };

test('Model 3 Performance: 4.72 x 1.85 x 1.43 m on a 2.875 m wheelbase', () => {
  const k = K('tesla'), s = VEH.bodySurface('tesla');
  near(k.len, 4.72, 0.01, 'length'); near(k.wid, 1.85, 0.01, 'width');
  near(2 * k.axle, 2.875, 0.01, 'wheelbase');
  near(s.z1 - s.z0, 4.72, 0.02, 'body length');
  near(roofTop('tesla'), 1.431, 0.02, 'height');
  near(-k.axle - s.z0, 0.868, 0.03, 'front overhang');
  // the proportion that was wrong: a tall body under a shallow glasshouse, a high tail
  assert.ok(k.green.sts[2][1] > 0.93, 'belt at the B-pillar is near a metre');
  assert.ok(s.topAt(s.z1 - 0.25, 0) > 1.03, 'the boot lid sits above a metre');
  assert.ok(s.topAt(s.z0 + 0.15, 0) < 0.72, 'the nose is low');
});

test('Octavia IV: 4.69 x 1.83 x 1.47 m on a 2.686 m wheelbase, liftback and Combi', () => {
  for (const kind of ['octavia', 'octaviaCombi']) {
    const k = K(kind), s = VEH.bodySurface(kind);
    near(k.len, 4.69, 0.01, kind + ' length'); near(k.wid, 1.83, 0.01, kind + ' width');
    near(2 * k.axle, 2.686, 0.01, kind + ' wheelbase');
    near(roofTop(kind), 1.468, 0.02, kind + ' height');
    near(-k.axle - s.z0, 0.90, 0.03, kind + ' front overhang');
    near(s.z1 - k.axle, 1.10, 0.03, kind + ' rear overhang');
    assert.ok(k.green.sts[2][1] > 0.95, kind + ' belt');
  }
  // the estate carries its roof to the tailgate; the liftback has let it go by then
  const zr = 1.9;
  assert.ok(VEH.bodySurface('octaviaCombi').topAt(zr, 0) > 1.38, 'Combi roof at the D-pillar');
  assert.ok(VEH.bodySurface('octavia').topAt(zr, 0) < 1.25, 'liftback roof has come down');
  assert.equal(VEH.carLabel('octaviaCombi'), 'Škoda Octavia Combi');
});

test('the Roadster: a wide low wedge, known to every table that asks by kind', () => {
  const k = K('roadster'), s = VEH.bodySurface('roadster');
  near(k.wid, 2.0, 0.01, 'width'); near(2 * k.axle, 2.825, 0.01, 'wheelbase');
  near(roofTop('roadster'), 1.14, 0.03, 'height');
  assert.ok(s.topAt(s.z0 + 0.1, 0) < 0.45 && s.topAt(s.z1 - 0.3, 0) > 0.85, 'a wedge: low nose, high tail');
  assert.equal(VEH.normalizeKind('roadster'), 'roadster');
  assert.ok(!VEH.CAR_KINDS.includes('roadster'), 'nobody rolls one from the roster');
  assert.equal(VEH.carLabel('roadster'), 'Tesla Roadster');
  assert.equal(voiceClass('roadster'), 'thrust');
  assert.equal(F.fuelTypeOf('roadster'), 'elektro');
  // a seated driver fits under the canopy
  const eye = VEH.eyeAnchor({ kind: 'roadster' }, 0);
  assert.ok(s.topAt(eye.z, 0) - eye.y > 0.12, 'headroom');
});

const fresh = (kind) => { const k = K(kind); return { kind, x: 0, z: 0, heading: 0, speed: 0, steer: 0, len: k.len, wid: k.wid, _lat: 0, yaw: 0, offroad: 0 }; };
function sprint(kind, vTo) {
  const car = fresh(kind), k = K(kind), dt = 1 / 120;
  let t = 0;
  while (car.speed < vTo && t < 60) { VEH.tyreStep(car, k, 1, false, dt); t += dt; }
  return t;
}

test('0 to 100 km/h: the Roadster in about a second, nothing else near it', () => {
  const r = sprint('roadster', 100 / 3.6);
  assert.ok(r > 0.9 && r < 1.12, 'roadster 0-100 in ' + r.toFixed(2) + ' s');
  assert.ok(sprint('tesla', 100 / 3.6) > 2.8, 'the Model 3 is still a Model 3');
  assert.ok(sprint('octavia', 100 / 3.6) > 5);
  assert.ok(sprint('roadster', 300 / 3.6) < 7, 'and it keeps going');
});

test('flat out it still steers: the thrusters do not spend the front tyres', () => {
  const k = K('roadster'), car = fresh('roadster'), dt = 1 / 120;
  car.speed = 15;
  car.steer = 0.12;
  for (let i = 0; i < 120; i++) VEH.tyreStep(car, k, 1, false, dt);       // one second, pedal down, wheel held
  assert.ok(Math.abs(car.heading) > 0.35, 'it turned: ' + car.heading.toFixed(2) + ' rad');
  assert.ok(Math.abs(car._lat) < 4, 'without sliding off sideways: ' + car._lat.toFixed(2) + ' m/s');
  assert.ok(Math.abs(car.yaw) < 2.5, 'or spinning: ' + car.yaw.toFixed(2));
  // the same car with every newton through its tyres would have washed straight on
  const dull = { ...k, thrust: 0, cgH: undefined }, c2 = fresh('roadster');
  c2.speed = 15; c2.steer = 0.12;
  for (let i = 0; i < 120; i++) VEH.tyreStep(c2, dull, 1, false, dt);
  assert.ok(Math.abs(car.heading) > Math.abs(c2.heading) * 1.3, 'thrust share is what leaves it steerable');
});

test('it stops harder than a family car', () => {
  const stop = (kind) => { const k = K(kind), car = fresh(kind); car.speed = 100 / 3.6; let t = 0; while (car.speed > 0.1 && t < 20) { VEH.tyreStep(car, k, -1, false, 1 / 120); t += 1 / 120; } return -car.z; };
  assert.ok(stop('roadster') < stop('octavia') * 0.8);
});

test('every redrawn kind builds clean geometry, near and far', () => {
  for (const kind of ['tesla', 'octavia', 'octaviaCombi', 'roadster']) {
    const car = buildCar(kind, K(kind), null);
    for (const lod of ['near', 'far']) for (const part of ['paint', 'detail', 'head', 'tail']) {
      const g = car[lod][part];
      assert.ok(g && g.attributes.position.count > 0, `${kind} ${lod} ${part}`);
      for (const v of g.attributes.position.array) if (!Number.isFinite(v)) assert.fail(`${kind} ${lod} ${part} has a NaN`);
    }
    const tris = (g) => (g ? (g.index ? g.index.count : g.attributes.position.count) / 3 : 0);
    const nearT = ['paint', 'glass', 'detail', 'head', 'tail', 'brake'].reduce((s, p) => s + tris(car.near[p]), 0);
    const farT = ['paint', 'detail', 'head', 'tail'].reduce((s, p) => s + tris(car.far[p]), 0);
    assert.ok(nearT < 12000, `${kind} near is ${nearT} triangles`);
    assert.ok(farT < 2600, `${kind} far is ${farT} triangles`);
  }
});

test('driven like a keyboard drives it (pedal down, wheel hard over), it grips like the other cars', () => {
  // the real driveStep, on a flat road: steering lock and wind-on as in the game
  const world = { surfaceY: () => ({ y: 0, road: true }), collide: () => false, heightAt: () => 0 };
  for (const v0 of [0, 10, 20, 30, 45]) {
    const k = K('roadster');
    const car = { kind: 'roadster', x: 0, z: 0, heading: 0, speed: v0, steer: 0, len: k.len, wid: k.wid, _lat: 0, yaw: 0, offroad: 0, y: 0, mesh: { userData: {} } };
    let beta = 0, slip = 0;
    for (let i = 0; i < 90; i++) {
      VEH.driveStep(car, { gas: 1, steer: 1, brake: false }, 1 / 60, world, null);
      beta = Math.max(beta, Math.abs(Math.atan2(car._lat, Math.max(1, Math.abs(car.speed)))));
      slip = Math.max(slip, car.slip01 ?? 0);
    }
    assert.ok(beta < 0.2, `from ${Math.round(v0 * 3.6)} km/h the body slips ${(beta * 57.3).toFixed(1)} degrees`);
    assert.ok(slip < 0.3, `from ${Math.round(v0 * 3.6)} km/h slip01 reached ${slip.toFixed(2)}: that is a slide`);
    assert.ok(Math.abs(car.heading) > 0.35, 'and it has turned');
  }
});
