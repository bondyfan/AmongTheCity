// ---- the Gripen, and whether it flies like one ----
// A flight model is all coupled scalars, so it fails quietly: change the drag
// constant and the jet still takes off, still turns, still lands — it just
// tops out at 900 km/h and nobody notices for a month. These tests pin the
// numbers a pilot would recognise, which are also the ones the brief asked for.
//
// The first cut of this model pulled 4.5 g down the runway and rotated after
// 77 metres, which is a catapult, not a take-off. That is exactly the class of
// mistake these assertions exist to catch.
//
// three.js is resolved through the same hook the destruction tests use, so the
// real aircraft.js runs — nothing here is a reimplementation of the model.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { Fighter, makeFighterMesh, seatAnchor } = await import('../js/aircraft.js');
const { Helicopter } = await import('../js/helicopter.js');

const DT = 1 / 60;
const scene = { add() {}, remove() {} };
const flatWorld = { heightAt: () => 0 };

// Fly `secs` seconds, asking `ctl(jet)` for the stick each frame.
function fly(jet, secs, ctl) {
  for (let i = 0; i < Math.round(secs / DT); i++) jet.update(DT, ctl(jet), flatWorld);
  return jet;
}

// full burner, hold it on the deck until VR, then rotate
const takeoff = (jet) => ({
  throttle: 1,
  pitch: jet.airborne ? 0.3 : (jet.speed > 72 ? 1 : 0),
});

test('it takes off like a fighter, not like a catapult', () => {
  const jet = new Fighter(scene, 0, 0, -Math.PI / 2);
  let liftedAt = null;
  for (let i = 0; i < 60 * 30; i++) {
    const was = jet.airborne;
    jet.update(DT, takeoff(jet), flatWorld);
    if (!was && jet.airborne) { liftedAt = { kmh: jet.kmh, roll: Math.hypot(jet.x, jet.z) }; break; }
  }
  assert.ok(liftedAt, 'never left the ground');
  // a real JAS-39 rotates around 250 km/h; anything under 150 means the wing
  // is doing something it should not
  assert.ok(liftedAt.kmh > 180 && liftedAt.kmh < 340,
    `rotated at ${Math.round(liftedAt.kmh)} km/h`);
  // and it needs a runway to do it on — both fields have 2.5 km, so a roll
  // between 150 m and 900 m is the believable band
  assert.ok(liftedAt.roll > 150 && liftedAt.roll < 900,
    `take-off roll was ${Math.round(liftedAt.roll)} m`);
});

test('it reaches the 2 000 km/h the brief asked for — but only up high', () => {
  const jet = new Fighter(scene, 0, 0, 0);
  // climb hard, then hold ~12 km and let it accelerate
  fly(jet, 240, (j) => ({
    throttle: 1,
    pitch: !j.airborne ? (j.speed > 72 ? 1 : 0) : j.y < 11000 ? 0.3 : j.y > 11500 ? -0.25 : 0,
  }));
  assert.ok(jet.kmh >= 2000, `only reached ${Math.round(jet.kmh)} km/h at altitude`);
  assert.ok(jet.kmh <= 2500, `${Math.round(jet.kmh)} km/h is past Mach 2 for this airframe`);

  // …and down in thick air the same engine cannot do it. This is the whole
  // reason to climb, so it is worth an assertion of its own.
  const low = new Fighter(scene, 0, 0, 0);
  low.airborne = true; low.y = 120; low.speed = 200;
  fly(low, 240, () => ({ throttle: 1, pitch: 0 }));
  assert.ok(low.kmh < 1600, `sea level top speed ${Math.round(low.kmh)} km/h is too high`);
  assert.ok(jet.kmh - low.kmh > 600,
    'altitude should be worth hundreds of km/h, or nobody will ever climb');
});

test('you roll to point the pull, and the pull is what turns you', () => {
  // The stick commands BODY rates, so a bank on its own does NOT turn the
  // aeroplane — it just puts the wing where the pull will be spent. This is
  // the whole difference between an aircraft and a car, and the first version
  // got it wrong by turning straight out of the bank angle.
  const rolled = new Fighter(scene, 0, 0, 0);
  rolled.airborne = true; rolled.y = 3000; rolled.speed = 250;
  const h0 = rolled.heading;
  fly(rolled, 0.35, () => ({ throttle: 0.7, roll: 1 }));
  assert.ok(rolled.roll < -0.3, `stick right must bank RIGHT (negative), got ${rolled.roll}`);
  assert.ok(Math.abs(rolled.heading - h0) < 0.05,
    'rolling alone must not change heading — only the pull turns you');

  // …and now the pull, held with the wing already banked right, turns right,
  // which in this frame means the heading DECREASES.
  const h1 = rolled.heading;
  fly(rolled, 2, () => ({ throttle: 0.7, pitch: 1 }));
  assert.ok(rolled.heading - h1 < -0.5,
    `banked right and pulling must turn right, swept ${rolled.heading - h1}`);

  // Upright, the same pull is a pure climb with no turn in it at all.
  const up = new Fighter(scene, 0, 0, 0);
  up.airborne = true; up.y = 3000; up.speed = 250;
  const y0 = up.y, h2 = up.heading;
  fly(up, 3, () => ({ throttle: 0.7, pitch: 1 }));
  assert.ok(up.y - y0 > 150, `upright pull should climb, gained ${Math.round(up.y - y0)} m`);
  assert.ok(Math.abs(up.heading - h2) < 0.05, 'upright pull must not turn');

  // The heading RATE no longer depends on speed, but the RADIUS does: same
  // rate, more metres per second, wider circle. That is still "fast is wide".
  const radius = (v) => {
    const j = new Fighter(scene, 0, 0, 0);
    j.airborne = true; j.y = 3000; j.speed = v; j.roll = -0.9;
    const a = j.heading;
    fly(j, 2, () => ({ throttle: 0.7, pitch: 1 }));
    const swept = Math.abs(j.heading - a);
    return swept > 1e-3 ? v * 2 / swept : Infinity;
  };
  assert.ok(radius(400) > radius(150) * 1.8,
    'a faster jet must carve a wider circle');
});

test('below the stall it comes down', () => {
  const jet = new Fighter(scene, 0, 0, 0);
  jet.airborne = true; jet.y = 2000; jet.speed = 40;   // 144 km/h — well under
  const y0 = jet.y;
  fly(jet, 15, () => ({ throttle: 0, pitch: 0.4 }));   // hauling back changes nothing
  assert.ok(jet.y < y0 - 100, `stalled jet only lost ${Math.round(y0 - jet.y)} m`);
});

test('it lands and stops on the strip it took off from', () => {
  const jet = new Fighter(scene, 0, 0, 0);
  jet.airborne = true; jet.y = 40; jet.speed = 90; jet.vy = -3;
  let touchdown = null, rollout = 0;
  for (let i = 0; i < 60 * 120; i++) {
    const was = jet.airborne;
    jet.update(DT, { throttle: 0, brake: jet.airborne ? 0 : 1 }, flatWorld);
    if (was && !jet.airborne) touchdown = { kmh: jet.kmh, at: Math.hypot(jet.x, jet.z) };
    if (touchdown) rollout = Math.hypot(jet.x, jet.z) - touchdown.at;
    if (touchdown && jet.speed < 1) break;
  }
  assert.ok(touchdown, 'never touched down');
  assert.ok(jet.speed < 1, `still rolling at ${Math.round(jet.kmh)} km/h`);
  // Pardubice 09/27 is 2 499 m, and you do not get all of it after touchdown
  assert.ok(rollout < 1800, `rollout of ${Math.round(rollout)} m runs off the end`);
});

test('the ground refuses to be left below rotation speed', () => {
  const jet = new Fighter(scene, 0, 0, 0);
  // full back stick from a standing start, but only taxi power
  fly(jet, 20, () => ({ throttle: 0.2, pitch: 1 }));
  assert.equal(jet.airborne, false,
    `it left the ground at ${Math.round(jet.kmh)} km/h with the throttle closed`);
});

test('the pilot sits in the cockpit, not on the wing', () => {
  const a = seatAnchor(null, 0);
  // under the canopy: on the centreline, forward of the wing, above the floor
  assert.equal(a.x, 0, 'a single-seat jet seats the pilot on the centreline');
  assert.ok(a.z < -2 && a.z > -5, `seat at z=${a.z} is not under the canopy`);
  assert.ok(a.y > 0 && a.y < 1);
});

test('the upper wing skin is front-facing from above', () => {
  const { group } = makeFighterMesh();
  group.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(
    new THREE.Vector3(3, 10, 4.5),
    new THREE.Vector3(0, -1, 0),
  );
  assert.ok(ray.intersectObject(group, true).length > 0,
    'a ray from the chase camera passed through the upper wing');
});

test('the fighter is closed from the side and has both canards', () => {
  const { group } = makeFighterMesh();
  group.updateMatrixWorld(true);
  const side = new THREE.Raycaster(
    new THREE.Vector3(10, 0, 0),
    new THREE.Vector3(-1, 0, 0),
  );
  assert.ok(side.intersectObject(group, true).length > 0,
    'a side ray passed through the fuselage wall');
  const leftCanard = new THREE.Raycaster(
    new THREE.Vector3(-1.5, 10, -3),
    new THREE.Vector3(0, -1, 0),
  );
  assert.ok(leftCanard.intersectObject(group, true).length > 0,
    'the left canard is missing');
});

test('spawned aircraft start on the absolute terrain height', () => {
  const highWorld = { heightAt: () => 221, roofY: () => 0, collide: () => false };
  const heli = new Helicopter(scene, 10, 20, 0, highWorld);
  const jet = new Fighter(scene, 10, 20, 0, highWorld);
  assert.equal(heli.y, 221);
  assert.equal(heli.mesh.position.y, 221);
  assert.ok(jet.y > 222 && jet.y < 223, `fighter centreline spawned at y=${jet.y}`);
  assert.equal(jet.mesh.position.y, jet.y);
  for (let i = 0; i < 10 * 60; i++)
    heli.update(DT, { lift: 0, pitch: 0, roll: 0, yaw: 0 }, highWorld);
  assert.equal(heli.y, 221, 'a parked helicopter fell through absolute terrain');
});
