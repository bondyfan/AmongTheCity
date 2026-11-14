// ---- through the windscreen ----
// "A když se rychle vybourám, chci vyletět předním sklem, jako v GTA 4."
// The decision is made from the impact record driveStep leaves on the car, so
// these run the REAL driveStep into a wall and then hand the result to
// js/ejection.js: 40 km/h stays in the seat, 100 km/h goes through the glass,
// a broadside or a reverse never does, and the thrown body flies, lands,
// bounces once, slides, lies there and gets up.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { driveStep } = await import('../js/vehicles.js');
const { shouldEject, launchDamage, impactDamage, launchBody, stepBody, feetFor, EJECT_V } =
  await import('../js/ejection.js');

const DT = 1 / 60;
const carOf = (kmh, heading = 0) => ({ x: 0, z: -22, y: 0, heading, speed: kmh / 3.6, steer: 0,
  len: 4.7, wid: 1.81, kind: 'octavia', offroad: 0 });
const wallAt = (W) => ({
  collide(pt, r) { if (pt.z < W + r) { pt.z = W + r; return true; } return false; },
  surfaceY: () => ({ y: 0, road: true }),
  supportY: () => 0,
});

/** Drive at the wall; return the car on the first step that hit it. */
function crashInto(car, world, gas = 0) {
  for (let i = 0; i < 240; i++) {
    driveStep(car, { gas, steer: 0, brake: 0 }, DT, world, []);
    if (car.impactV > 0.5) return car;
  }
  return null;
}

test('40 km/h into a wall: you stay in the seat', () => {
  const c = crashInto(carOf(40), wallAt(-30));
  assert.ok(c, 'never hit the wall');
  assert.strictEqual(shouldEject(c), false);
});

test('100 km/h into a wall, nose first: through the windscreen', () => {
  const c = crashInto(carOf(100), wallAt(-30));
  assert.ok(c && c.impactV > EJECT_V, `impact ${c?.impactV}`);
  assert.strictEqual(shouldEject(c), true);
});

test('the same speed sideways or backwards is not a windscreen', () => {
  // backwards: heading π points the nose south, the car reverses north into the wall
  const r = carOf(0, Math.PI); r.speed = -70 / 3.6;
  // (reverse is capped by the gearbox in driveStep, so set it and let it hit)
  const c = crashInto(r, wallAt(-30));
  assert.ok(!c || !shouldEject(c), 'reversing into a wall threw the driver out of the boot');
  // a broadside: the car slides north while pointing west
  const b = carOf(0, Math.PI / 2); b.speed = 0; b._lat = 100 / 3.6;    // right of west is north
  const cb = crashInto(b, wallAt(-30));
  assert.ok(cb && cb.impactV > EJECT_V, `the broadside never hit hard (${cb?.impactV})`);
  assert.strictEqual(shouldEject(cb), false);
});

test('the bill rises with speed, is continuous at the threshold and kills at 150', () => {
  assert.strictEqual(launchDamage(5), 0);
  assert.strictEqual(impactDamage(5), 0);
  let prev = -1;
  for (let v = 10; v <= 50; v += 2) { const d = launchDamage(v); assert.ok(d >= prev); prev = d; }
  assert.ok(launchDamage(EJECT_V) < 20, `${launchDamage(EJECT_V)} HP just for the glass at the threshold`);
  // 150 km/h, open road: glass + a landing at the speed the flight test below measures
  assert.ok(launchDamage(150 / 3.6) + impactDamage(18) >= 100, 'a 150 km/h ejection is survivable');
  // 100 km/h on an open road is not a death sentence
  assert.ok(launchDamage(100 / 3.6) + impactDamage(14) < 70);
});

/** Throw a body from a car that hit something at `kmh`; fly it in `world`. */
function fly(kmh, world, secs = 8) {
  const car = { x: 0, z: 0, y: 0, heading: 0, len: 4.7, wid: 1.81, impactVx: 0, impactVz: -kmh / 3.6 };
  const st = launchBody(car, { x: -0.35, y: 0.5, z: 0.1 }, 0.83, () => 0.5);
  const hits = [];
  const trace = [];
  let done = false;
  for (let i = 0; i < Math.round(secs / DT) && !done; i++) {
    done = !stepBody(st, DT, world, (u, what) => hits.push({ u, what, t: i * DT }));
    trace.push({ phase: st.phase, x: st.x, y: st.y, z: st.z });
  }
  return { st, hits, trace, done };
}
const OPEN = { collide: () => false, supportY: () => 0 };

test('the body flies forward and up, lands once, bounces, slides, lies, and gets up', () => {
  const { st, hits, trace, done } = fly(100, OPEN);
  const top = Math.max(...trace.map((p) => p.y));
  assert.ok(top > 1.4, `never rose over the bonnet (peak ${top.toFixed(2)} m)`);
  const far = -st.z;
  assert.ok(far > 12 && far < 60, `landed ${far.toFixed(1)} m ahead`);
  const ground = hits.filter((h) => h.what === 'ground');
  assert.strictEqual(ground.length, 1, 'the ground was billed more than once');
  assert.ok(ground[0].u > 8 && ground[0].u < 20, `landing speed ${ground[0].u.toFixed(1)}`);
  assert.ok(trace.some((p) => p.phase === 'lie'), 'never lay still');
  assert.ok(done, 'never got up');
  assert.ok(Number.isFinite(st.x + st.y + st.z + st.pitch + st.roll));
});

test('a body thrown at a building meets the building', () => {
  // a wall 3 m ahead of the seat: the flight is short and stops at the face
  const w = { collide(pt, r) { if (pt.z < -3 + r) { pt.z = -3 + r; return true; } return false; }, supportY: () => 0 };
  const { st, hits } = fly(100, w);
  const wall = hits.filter((h) => h.what === 'wall');
  assert.strictEqual(wall.length, 1);
  assert.ok(wall[0].u > 18, `met the wall at ${wall[0].u.toFixed(1)} m/s`);
  assert.ok(st.z > -3, `went through it to z ${st.z.toFixed(2)}`);
});

test('killed by the landing: the body stays down', () => {
  const car = { x: 0, z: 0, y: 0, heading: 0, len: 4.7, wid: 1.81, impactVx: 0, impactVz: -40 };
  const st = launchBody(car, { x: 0, y: 0.5, z: 0 }, 0.83, () => 0.5);
  st.stay = true;
  for (let i = 0; i < 900; i++) assert.ok(stepBody(st, DT, OPEN, null), 'a dead body got up');
  assert.strictEqual(st.phase, 'lie');
});

test('the feet go where the middle of the body is upright, and beside it lying down', () => {
  const st = { x: 1, y: 0.83, z: 2, pitch: 0, roll: 0, yaw: 0.7, hip: 0.83 };
  const f = feetFor(st, {});
  assert.ok(Math.abs(f.x - 1) < 1e-9 && Math.abs(f.y) < 1e-9 && Math.abs(f.z - 2) < 1e-9);
  st.pitch = Math.PI / 2; st.y = 0.16;
  const g = feetFor(st, {});
  assert.ok(Math.abs(g.y - 0.16) < 1e-9, 'lying feet are not level with the body');
  assert.ok(Math.abs(Math.hypot(g.x - 1, g.z - 2) - 0.83) < 1e-9, 'lying feet are not a body length away');
});
