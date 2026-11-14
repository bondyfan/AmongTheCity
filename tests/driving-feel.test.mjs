// ---- v14: the car has weight, and it bounces ----
// "Udělej to ovládání auta trošku lepší, jako v GTA San Andreas, s fyzikou."
// The owner has already rejected an "on ice" car once (ARCHITECTURE.md, v13
// contract), so most of what is pinned here is what must NOT change: planted
// through any corner a keyboard can ask for, the handbrake still swings the
// tail. The rest is new: a body that rolls and pitches with the g it pulls, a
// wall that bounces the car instead of gluing it on, no tunnelling through a
// thin wall on a long frame, and the impact record js/ejection.js reads.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { driveStep } = await import('../js/vehicles.js');

const DT = 1 / 60;
const FLAT = { collide: () => false, surfaceY: () => ({ y: 0, road: true }) };
const deg = (r) => r * 180 / Math.PI;
const carOf = (speed = 0, kind = 'octavia') => ({ x: 0, z: 0, y: 0, heading: 0, speed, steer: 0,
  len: 4.7, wid: 1.81, kind, offroad: 0 });
/** a flat wall across the road at z = W, the car driving north (−z) into it */
const wallAt = (W) => ({
  collide(pt, r) { if (pt.z < W + r) { pt.z = W + r; return true; } return false; },
  surfaceY: () => ({ y: 0, road: true }),
});
function run(car, ctl, secs, world = FLAT, cb) {
  for (let i = 0; i < Math.round(secs / DT); i++) {
    driveStep(car, typeof ctl === 'function' ? ctl(i * DT, car) : ctl, DT, world, []);
    cb?.(i * DT, car);
  }
  return car;
}
const bodySlip = (c) => Math.abs(deg(Math.atan2(c._lat, Math.abs(c.speed) + 0.5)));

test('still planted: full lock with W held never slides a front-drive car', () => {
  for (const v of [50, 90, 130]) {
    const c = carOf(v / 3.6);
    let s01 = 0;
    run(c, (t, k) => ({ gas: k.speed < v / 3.6 ? 1 : 0, steer: 1, brake: 0 }), 3, FLAT,
      (t, k) => { s01 = Math.max(s01, k.slip01); });
    assert.ok(s01 < 0.1, `${v} km/h full lock reads as a skid (slip01 ${s01.toFixed(2)})`);
  }
});

test('a junction turn in a rear-drive car with W held does not spin it', () => {
  // the case the SPIN_CAP comment is about: 25 km/h, full lock for 1.1 s
  for (const kind of ['bmw', 'mercedes']) {
    const c = carOf(25 / 3.6, kind);
    let slip = 0;
    run(c, (t) => ({ gas: 1, steer: t < 1.1 ? 1 : 0, brake: 0 }), 2.5, FLAT,
      (t, k) => { slip = Math.max(slip, bodySlip(k)); });
    assert.ok(slip < 15, `${kind} turned a junction at ${slip.toFixed(0)}° of body slip`);
    assert.ok(deg(-c.heading) < 120, `${kind} went round ${deg(-c.heading).toFixed(0)}°`);
  }
});

test('…but holding full lock and full throttle steps a rear-drive tail out, and it comes back', () => {
  // settle into the corner at 30 km/h first, then floor it
  const c = carOf(30 / 3.6, 'bmw');
  let slip = 0, s01 = 0, end = 0;
  // …then straighten up and lift, which is how a slide like that is caught
  run(c, (t, k) => ({ gas: t < 0.8 ? (k.speed < 30 / 3.6 ? 1 : 0) : t < 2.8 ? 1 : 0, steer: t < 2.8 ? 1 : 0, brake: 0 }), 4.8, FLAT, (t, k) => {
    if (t < 2.8) { slip = Math.max(slip, bodySlip(k)); s01 = Math.max(s01, k.slip01); } else end = bodySlip(k);
  });
  assert.ok(slip > 12 && s01 > 0.25, `no power slide: ${slip.toFixed(0)}°, slip01 ${s01.toFixed(2)}`);
  assert.ok(end < 3, `the slide did not recover once the wheel straightened (${end.toFixed(1)}°)`);
  // and the front-drive Octavia does not do it at all
  const o = carOf(30 / 3.6, 'octavia');
  let os = 0;
  run(o, { gas: 1, steer: 1, brake: 0 }, 2.5, FLAT, (t, k) => { os = Math.max(os, k.slip01); });
  assert.ok(os < 0.05, `the Octavia power-slid (slip01 ${os.toFixed(2)})`);
});

test('the handbrake still swings the tail right out', () => {
  const c = carOf(22);
  let yaw = 0, slip = 0;
  run(c, (t) => ({ gas: 0, steer: t > 0.2 ? 1 : 0, brake: t > 0.3 && t < 1.3 ? 1 : 0 }), 2, FLAT,
    (t, k) => { yaw = Math.max(yaw, Math.abs(k.yaw)); slip = Math.max(slip, bodySlip(k)); });
  assert.ok(deg(yaw) > 100, `handbrake yaw ${deg(yaw).toFixed(0)}°/s`);
  assert.ok(slip > 25, `handbrake body slip ${slip.toFixed(0)}°`);
});

test('the body leans out of a corner and dives under the brakes, then settles', () => {
  const c = carOf(20);
  let roll = 0;
  run(c, { gas: 0.3, steer: 1, brake: 0 }, 1.2, FLAT, (t, k) => { roll = Math.max(roll, k._bRoll); });
  // a right turn: +roll lifts the right (inside) flank, i.e. the shell leans OUT
  assert.ok(deg(roll) > 3 && deg(roll) < 9, `corner roll ${deg(roll).toFixed(1)}°`);
  const b = carOf(25);
  let pitch = 0;
  run(b, (t, k) => ({ gas: k.speed > 0.05 ? -1 : 0, steer: 0, brake: 0 }), 3.0, FLAT,
    (t, k) => { pitch = Math.min(pitch, k._bPitch); });
  assert.ok(deg(pitch) < -2 && deg(pitch) > -6, `brake dive ${deg(pitch).toFixed(1)}°`);
  assert.ok(Math.abs(b.speed) < 0.05, 'never stopped');
  run(b, { gas: 0, steer: 0, brake: 0 }, 2, FLAT);
  assert.ok(Math.abs(b._bPitch) < 0.004 && Math.abs(b._bRoll) < 0.004, 'the body never settled');
});

test('a kerb kicks the springs and they settle; a long hill does not sink the body', () => {
  // a 12 cm kerb at z = −20
  const kerb = { collide: () => false, surfaceY: (x, z) => ({ y: z < -20 ? 0.12 : 0, road: true }) };
  const c = carOf(10);
  let lo = 0;
  run(c, { gas: 0.2, steer: 0, brake: 0 }, 3, kerb, (t, k) => { lo = Math.min(lo, k._heave); });
  assert.ok(lo < -0.04, `the kerb never reached the body (${lo.toFixed(3)} m)`);
  assert.ok(Math.abs(c._heave) < 0.005, `the body is still bouncing (${c._heave.toFixed(3)} m)`);
  // a steady 8 % climb at 90 km/h
  const hill = { collide: () => false, surfaceY: (x, z) => ({ y: -z * 0.08, road: true }) };
  const h = carOf(25);
  run(h, { gas: 1, steer: 0, brake: 0 }, 3, hill);
  assert.ok(Math.abs(h._heave) < 0.01, `a steady climb sank the body ${h._heave.toFixed(3)} m`);
});

test('a wall hit bounces the car off once, without gluing it on with W held', () => {
  for (const v of [40, 100]) {
    const c = carOf(v / 3.6); c.z = -10;
    const hits = [];
    let hitT = null, backed = 0;
    run(c, (t, k) => ({ gas: hitT != null || k.speed < v / 3.6 ? 1 : 0, steer: 0, brake: 0 }), 3, wallAt(-30),
      (t, k) => {
        if (k.impactV > 2) hits.push(k.impactV);
        if (hitT == null && k.impactV > 0.5) hitT = t;
        if (hitT != null) backed = Math.max(backed, -k.speed);   // −speed: rolling back off it
      });
    assert.ok(hits.length >= 1 && Math.abs(hits[0] - v / 3.6) < 1.5, `${v}: first hit ${hits[0]}`);
    // only the first hit is a crash; at most one small rebound knock after it
    assert.ok(hits.length <= 2 && (hits[1] ?? 0) < 3.5, `${v}: repeated crashes ${hits.map((h) => h.toFixed(1))}`);
    assert.ok(backed > 1, `${v}: no bounce (${backed.toFixed(2)} m/s back)`);
    assert.ok(Math.abs(deg(c.heading)) < 1, `${v}: a square hit span the car ${deg(c.heading).toFixed(1)}°`);
    assert.ok(c.damage < 0.7, `${v}: damage ${c.damage.toFixed(2)}`);
  }
});

test('a glancing hit scrapes along the wall instead of stopping dead', () => {
  const c = carOf(70 / 3.6); c.heading = 1.2; c.z = -24;
  let hit = null;
  run(c, { gas: 0, steer: 0, brake: 0 }, 2, wallAt(-30), (t, k) => {
    if (!hit && k.impactV > 0.5) hit = { v: k.impactV, after: k.vGround };
  });
  assert.ok(hit, 'never touched the wall');
  assert.ok(hit.v < 8, `a glance billed as a ${hit.v.toFixed(1)} m/s hit`);
  assert.ok(hit.after > 0.6 * 70 / 3.6, `the glance killed the speed (${(hit.after * 3.6).toFixed(0)} km/h)`);
});

test('an off-centre hit spins the car', () => {
  // only the right half of the road has a wall in it: the right front corner hits
  const w = { collide(pt, r) { if (pt.x > 0 && pt.z < -30 + r) { pt.z = -30 + r; return true; } return false; },
    surfaceY: () => ({ y: 0, road: true }) };
  const c = carOf(50 / 3.6); c.z = -20;
  let yaw = 0;
  run(c, { gas: 0, steer: 0, brake: 0 }, 1.5, w, (t, k) => { yaw = Math.max(yaw, Math.abs(k.yaw)); });
  assert.ok(deg(yaw) > 30, `a one-corner hit gave ${deg(yaw).toFixed(0)}°/s of spin`);
});

test('a 30 cm wall stops a car at 130 km/h even on a 1/20 s frame', () => {
  const w = { collide(pt, r) {
    if (pt.z < -30 + r && pt.z > -30.3 - r) { pt.z = pt.z > -30.15 ? -30 + r : -30.3 - r; return true; }
    return false;
  }, surfaceY: () => ({ y: 0, road: true }) };
  const c = carOf(130 / 3.6);
  for (let i = 0; i < 60; i++) driveStep(c, { gas: 1, steer: 0, brake: 0 }, 1 / 20, w, []);
  assert.ok(c.z > -30, `tunnelled to z = ${c.z.toFixed(1)}`);
  for (const k of ['x', 'z', 'speed', 'heading', 'yaw', '_lat', '_bRoll', '_bPitch', '_heave'])
    assert.ok(Number.isFinite(c[k]), `${k} went ${c[k]}`);
});

test('the impact record: closing speed, how square, and the velocity before it', () => {
  const c = carOf(100 / 3.6); c.z = -26;
  let rec = null;
  run(c, { gas: 0, steer: 0, brake: 0 }, 1, wallAt(-30), (t, k) => {
    if (!rec && k.impactV > 0) rec = { v: k.impactV, cos: k.impactCos, vz: k.impactVz, with: k.impactWith };
  });
  assert.ok(rec && rec.v > 25, `no hard impact recorded (${rec?.v})`);
  assert.ok(rec.cos > 0.99, `a square hit read as cos ${rec.cos}`);
  assert.ok(rec.vz < -25, `pre-impact velocity lost (${rec.vz})`);
  assert.strictEqual(rec.with, 'wall');
  // the next quiet step clears it
  driveStep(c, { gas: 0, steer: 0, brake: 0 }, DT, FLAT, []);
  assert.strictEqual(c.impactV, 0);
});

test('car into car: momentum is shared, the hit is recorded as a car', () => {
  const c = carOf(60 / 3.6);
  const o = { x: 0, z: -12, y: 0, heading: 0, speed: 0, len: 4.7, wid: 1.81, kind: 'octavia' };
  let rec = null;
  for (let i = 0; i < 60; i++) {
    driveStep(c, { gas: 0, steer: 0, brake: 0 }, DT, FLAT, [o]);
    if (!rec && c.impactV > 0) rec = { v: c.impactV, with: c.impactWith, them: o.speed, me: c.speed };
  }
  assert.ok(rec && rec.with === 'car', 'no car impact recorded');
  // equal masses, mostly plastic: the struck car leaves faster than we do
  assert.ok(rec.them > 7 && rec.me < rec.them, `shove ${rec.me.toFixed(1)} → ${rec.them.toFixed(1)}`);
});
