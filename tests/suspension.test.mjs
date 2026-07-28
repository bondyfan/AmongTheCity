// ---- the car stops being a decal on the terrain ----
// For the whole life of this project driveStep ended with `car.y = surfaceY()`.
// That is not suspension, it is a sticker: the car could not leave the ground,
// so a crest was a shrug, a drop-off was a slide, and on a 10 % grade the body
// stayed dead level while the world tilted underneath it.
//
// Each test here is a shape of ground and one question about what a car does on
// it. They run the REAL driveStep against a synthetic world, because the whole
// point is that the behaviour falls out of the physics rather than out of a
// special case — a jump is nothing but a carried vertical velocity, and if that
// is right then landing, nose-down descents and hill-hugging are right too.
//
// three.js is not an npm package here, so the resolver hook is registered
// before the modules under test are imported. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { driveStep } = await import('../js/vehicles.js');

// A world is just a height function. `road: true` everywhere — offroad drag is
// a different test's problem.
const worldOf = (h) => ({ collide: () => false, surfaceY: (x, z) => ({ y: h(x, z), road: true }) });
const FLAT = worldOf(() => 0);

// heading 0 is north, and north is −z: driving forward makes z go DOWN. Every
// profile below is therefore a function of −z, so "ahead" reads left-to-right.
const ahead = (car) => -car.z;

function carAt(z, speed, world) {
  const car = { x: 0, z, y: world.surfaceY(0, z).y, heading: 0, speed,
    steer: 0, len: 4.2, wid: 1.8, kind: 'octavia' };
  return car;
}

/** Roll the car forward for `secs`, returning the trace of every step. The
 *  throttle is ON by default: coasting from 25 m/s, drag alone has the car down
 *  to 12 by the time it reaches anything interesting, and half the point here
 *  is what happens AT SPEED. */
function run(car, world, secs, ctl = { gas: 0.6, steer: 0, brake: 0 }, dt = 1 / 60) {
  const trace = [];
  for (let i = 0; i < Math.round(secs / dt); i++) {
    driveStep(car, ctl, dt, world, []);
    trace.push({ t: i * dt, z: car.z, y: car.y, air: car.air ?? 0,
      vy: car._vy ?? 0, pitch: car._gp ?? 0, roll: car._gr ?? 0 });
  }
  return trace;
}

// ---------------------------------------------------------------------------
// flat ground: the thing that must NOT change
// ---------------------------------------------------------------------------

test('on the flat the car sits exactly on the surface and never hops', () => {
  const car = carAt(0, 25, FLAT);
  const trace = run(car, FLAT, 3);
  const maxY = Math.max(...trace.map((s) => Math.abs(s.y)));
  assert.ok(maxY < 1e-9, `car left the flat ground by ${maxY} m`);
  assert.ok(trace.every((s) => s.air === 0), 'car went airborne on flat ground');
  const maxTilt = Math.max(...trace.map((s) => Math.abs(s.pitch) + Math.abs(s.roll)));
  assert.ok(maxTilt < 1e-6, `body tilted ${maxTilt} rad on flat ground`);
});

test('a parked car on a hillside does not creep, hover or fall', () => {
  // 8 % slope, engine off, and NOT moving: the ground is allowed to tilt the
  // body but nothing may launch it. (Sub-JUMP_V speeds clamp the carried
  // velocity to ≤ 0, which is what stops terrain noise levitating a car.)
  const world = worldOf((x, z) => ahead({ z }) * 0.08);
  const car = carAt(0, 0, world);
  const trace = run(car, world, 2, { gas: 0, steer: 0, brake: 0 });
  assert.ok(trace.every((s) => s.air === 0), 'a parked car took off');
  const last = trace.at(-1);
  assert.ok(Math.abs(last.y - world.surfaceY(0, last.z).y) < 1e-9, 'parked car is not on the ground');
  assert.ok(last.pitch > 0.06, `nose should point up the 8 % hill, got ${last.pitch}`);
});

// ---------------------------------------------------------------------------
// the jump — the user's "skokánek"
// ---------------------------------------------------------------------------

// A ramp: flat, then 12 m climbing at 15 %, then flat again. Hitting the lip
// at 25 m/s should throw the car; 15 % × 25 m/s is 3.75 m/s of climb, which is
// worth ~0.7 m of air and about 0.8 s of it.
const RAMP = worldOf((x, z) => {
  const d = ahead({ z });
  if (d < 20) return 0;
  if (d < 32) return (d - 20) * 0.15;
  return 12 * 0.15;
});

test('cresting a ramp at speed puts the car in the air', () => {
  const car = carAt(0, 25, RAMP);
  const trace = run(car, RAMP, 3);
  const airborne = trace.filter((s) => s.air > 0);
  assert.ok(airborne.length > 0, 'the car never left the ramp');
  const airtime = Math.max(...airborne.map((s) => s.air));
  assert.ok(airtime > 0.3, `only ${airtime.toFixed(2)} s of air — that is a bump, not a jump`);
  const clearance = Math.max(...trace.map((s) => s.y - RAMP.surfaceY(0, s.z).y));
  assert.ok(clearance > 0.35, `only ${clearance.toFixed(2)} m of clearance`);
});

test('the same ramp taken slowly is just a hill', () => {
  // 3 m/s — below JUMP_V. Speed is pinned rather than driven, because the
  // question is only "does a crawl launch?" and the answer must be no however
  // long it crawls. It has to actually get over the lip for that to mean
  // anything, hence the assertion that it did.
  const car = carAt(0, 3, RAMP);
  let air = 0;
  for (let i = 0; i < 60 * 14; i++) {
    car.speed = 3;
    driveStep(car, { gas: 0, steer: 0, brake: 0 }, 1 / 60, RAMP, []);
    air = Math.max(air, car.air ?? 0);
  }
  assert.ok(car.z < -34, `the car only reached z=${car.z.toFixed(1)} — never crossed the lip`);
  assert.equal(air, 0, 'a crawling car took off');
});

test('what goes up lands, and the landing is recorded', () => {
  const car = carAt(0, 25, RAMP);
  let thump = 0;
  for (let i = 0; i < 180; i++) {
    driveStep(car, { gas: 0.6, steer: 0, brake: 0 }, 1 / 60, RAMP, []);
    if (car._thump) thump = car._thump;   // update() consumes it; here we just watch
  }
  assert.equal(car.air, 0, 'the car never came down');
  assert.ok(Math.abs(car.y - RAMP.surfaceY(0, car.z).y) < 1e-9, 'it did not settle onto the ground');
  assert.ok(thump > 0, 'the landing left no impact for the dust and the tyre bark');
  assert.ok(car._sag >= 0 && car._sag <= 1, `spring compression out of range: ${car._sag}`);
});

// ---------------------------------------------------------------------------
// attitude — "to auto musí být opravdu otočené i dolů"
// ---------------------------------------------------------------------------

test('the body lies along the hill, nose up climbing and down descending', () => {
  const up = worldOf((x, z) => ahead({ z }) * 0.2);      // 20 % climb
  const down = worldOf((x, z) => ahead({ z }) * -0.2);   // 20 % drop
  const a = run(carAt(0, 20, up), up, 2).at(-1);
  const b = run(carAt(0, 20, down), down, 2).at(-1);
  // atan(0.2) = 0.197 rad. Allow the smoothing a little slack.
  assert.ok(a.pitch > 0.15, `climbing pitch ${a.pitch.toFixed(3)} should be near +0.197`);
  assert.ok(b.pitch < -0.15, `descending pitch ${b.pitch.toFixed(3)} should be near −0.197`);
});

test('a cross-slope leans the car, and the high side is the one that lifts', () => {
  // Ground rising to the EAST (+x). Facing north, east is the car's right, so
  // the right flank rides high — a positive roll, per the +z convention.
  const world = worldOf((x) => x * 0.15);
  const car = carAt(0, 12, world);
  const trace = run(car, world, 2);
  assert.ok(trace.at(-1).roll > 0.1, `roll ${trace.at(-1).roll.toFixed(3)} should be near +0.149`);
  // …and facing SOUTH the same hill leans it the other way.
  const back = carAt(0, 12, world);
  back.heading = Math.PI;
  assert.ok(run(back, world, 2).at(-1).roll < -0.1, 'the lean did not follow the car around');
});

test('in the air the nose follows the trajectory, not the ground below', () => {
  // Drive off an edge: 30 m of flat, then the ground falls away at 120 % —
  // about 50°, which is as steep as a quarry face and far steeper than the car
  // can follow. (A literal vertical wall is not a terrain shape a 20 m height
  // map can hold, and suspension() reads an instant multi-metre step as a tile
  // arriving rather than as a cliff, on purpose.)
  const cliff = worldOf((x, z) => Math.min(0, (30 - ahead({ z })) * 1.2));
  const car = carAt(0, 30, cliff);
  const trace = run(car, cliff, 2.2);
  const flying = trace.filter((s) => s.air > 0.25);
  assert.ok(flying.length > 20, 'the car did not fall off the cliff');
  const nose = flying.at(-1).pitch;
  assert.ok(nose < -0.25, `falling nose should be well down, got ${nose.toFixed(3)}`);
  // and it accelerates downward like a thing in a gravity field
  const vy = flying.at(-1).vy;
  assert.ok(vy < -8, `after ~1.5 s of fall vy should be past −8 m/s, got ${vy.toFixed(1)}`);
});

// ---------------------------------------------------------------------------
// the guard that keeps streaming from throwing cars into orbit
// ---------------------------------------------------------------------------

test('a height map arriving re-seats the car instead of dropping it 200 m', () => {
  // Pardubice sits at 221 m. Before its terrain tile lands, surfaceY answers 0;
  // the frame it arrives, the ground under a standing car moves by the whole
  // 221 m. That is data, not a cliff, and the car must simply be there.
  let ground = 0;
  const world = { collide: () => false, surfaceY: () => ({ y: ground, road: true }) };
  const car = carAt(0, 8, world);
  run(car, world, 0.5);
  ground = 221;
  driveStep(car, { gas: 0, steer: 0, brake: 0 }, 1 / 60, world, []);
  assert.equal(car.y, 221, 'the car did not follow the ground up');
  assert.equal(car.air, 0, 'the car was launched by its own height map');
  assert.equal(car._vy, 0, 'a teleport left vertical speed behind');
  // …and the same going the other way.
  ground = 0;
  driveStep(car, { gas: 0, steer: 0, brake: 0 }, 1 / 60, world, []);
  assert.equal(car.y, 0);
  assert.equal(car.air, 0, 'the car fell 221 m because a tile was evicted');
});

test('a world with only heightAt still gets suspension', () => {
  // The net layer and the older tests hand driveStep a world without surfaceY.
  // That path used to be `car.y = heightAt(...)`; it must not silently lose the
  // physics now that the physics is where the ground contact lives.
  const world = { collide: () => false, heightAt: (x, z) => (ahead({ z }) < 20 ? 0 : Math.max(0, 6 - (ahead({ z }) - 20) * 0.3)) };
  const car = { x: 0, z: 0, y: 0, heading: 0, speed: 24, steer: 0,
    len: 4.2, wid: 1.8, kind: 'octavia' };
  const trace = run(car, world, 2);
  assert.ok(trace.some((s) => s.air > 0), 'no airtime on the heightAt-only path');
  assert.ok(Math.abs(trace.at(-1).pitch) > 0.05, 'no attitude on the heightAt-only path');
});
