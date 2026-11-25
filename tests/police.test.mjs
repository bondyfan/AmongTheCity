// ---- the police: chase, ram, step out, shoot --------------------------------
// The owner asked for police that "drive after me, ram me when I have stars,
// get out and shoot at me, and can kill me". Every one of those is a claim
// about what happens over time on a road, so this file is a road: a long
// straight two-way street (the ambulance test's fixture shape), a player car
// driven by the REAL vehicles.js driveStep (so a ram is the real collision
// solver, not an assertion about intent), and the real vitals module.
//
// three.js is not an npm package here, so the resolver hook is registered
// before anything that imports it. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Police } = await import('../js/police.js');
const { driveStep } = await import('../js/vehicles.js');
const tune = await import('../js/policetune.js');
const { Gunfire } = await import('../js/copfire.js');
const vitals = await import('../js/vitals.js');

// mulberry32: every random draw in these tests is reproducible
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- the world ------------------------------------------------------------

function street({ x0 = -600, seg = 60, n = 60, speed = 13.9, w = 9 } = {}) {
  const N = [];
  for (let i = 0; i <= n; i++) N.push({ x: x0 + i * seg, z: 0, out: [] });
  const road = { w, br: 0, name: 'Testovací' };
  const mk = (a, b) => {
    const dx = Math.sign(b.x - a.x);
    const mid = (a.x + b.x) / 2;
    return {
      a, b, pts: [[a.x, 0], [mid, 0], [b.x, 0]], cum: [0, seg / 2, seg], len: seg, speed,
      oneway: false, road, off0: a.x, offSign: dx, fdx: dx, fdz: 0, ldx: dx, ldz: 0,
      vertAng: [0, 0, 0], mx: mid, mz: 0, twin: null,
    };
  };
  const edges = [];
  for (let i = 0; i < n; i++) {
    const f = mk(N[i], N[i + 1]), r = mk(N[i + 1], N[i]);
    f.twin = r; r.twin = f;
    N[i].out.push(f); N[i + 1].out.push(r);
    edges.push(f, r);
  }
  return edges;
}

const FLAT = { collide: () => false, surfaceY: () => ({ y: 0, road: true }), heightAt: () => 0 };
const EAST = -Math.PI / 2;           // heading whose forward is +x

function rig({ stars = 1, seed = 7 } = {}) {
  const edges = street();
  const built = [];
  const vehicles = {
    add(kind, x, z, heading) {
      const car = { kind, x, z, y: 0, heading, speed: 0, steer: 0, len: 4.6, wid: 1.82,
        mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} } };
      built.push(car);
      return car;
    },
    remove(car) { const i = built.indexOf(car); if (i >= 0) built.splice(i, 1); },
  };
  const traffic = {
    edges, cars: new Set(), world: null,
    steal(c) { this.cars.delete(c); c.ai = null; return c; },
    setSiren(c, on) { c.siren = on; },
    spawnPatrol(x, z, h) { const c = vehicles.add('octavia', x, z, h); c.police = true; return c; },
  };
  let heat = stars;
  const wanted = { stars: () => heat, add() {} };
  const said = [];
  let t = 1000;
  const arrests = [], tackles = [];
  const pol = new Police({ traffic, vehicles, wanted, city: null, scene: null,
    rnd: rng(seed), say: (s) => said.push(s), vitals,
    onArrest: (r) => arrests.push(r), onTackle: (r) => tackles.push(r) });
  pol.clock = () => t;
  const me = { kind: 'octavia', x: 0, z: 0, y: 0, heading: EAST, speed: 0, steer: 0,
    len: 4.6, wid: 1.82, _lat: 0, yaw: 0, mesh: { userData: {} } };
  const ctx = { x: 0, z: 0, car: me, onFoot: false, y: NaN };
  return {
    pol, traffic, vehicles, built, me, said, wanted, arrests, tackles,
    setStars(s) { heat = s; },
    now: () => t,
    /** One 1/60 s step: the player's physics first (as in main.js), then the police. */
    step(gas = 0, foot = false) {
      const dt = 1 / 60;
      t += dt;
      if (!foot) driveStep(me, { gas, steer: 0, brake: 0 }, dt, FLAT, pol.cars);
      ctx.car = foot ? null : me; ctx.onFoot = foot;
      ctx.x = me.x; ctx.z = me.z; ctx.y = foot ? 0 : NaN;
      vitals.update(dt, { onFoot: foot, car: foot ? null : me });
      pol.update(dt, ctx);
    },
  };
}

// Hold the player's car at `v` m/s eastward along the street (a cruise
// control on top of the real physics: whatever a ram does to the speed is
// measured BEFORE this correction each step).
function cruise(R, v, secs, onStep) {
  const n = Math.round(secs * 60);
  for (let i = 0; i < n; i++) {
    const err = v - R.me.speed;
    R.step(Math.max(-1, Math.min(1, err * 0.5)));
    // keep the car in its lane: this test is about the police, not steering
    R.me.z = 2.2; R.me.heading = EAST + (R.me.heading - EAST) * 0.9;
    onStep?.(i);
  }
}

// ---- 1. the ladder ----------------------------------------------------------

test('each star buys more cars, and the fastest never outruns a car', () => {
  for (let s = 1; s <= 5; s++) assert.equal(tune.tierFor(s).units, s, `${s} stars`);
  assert.equal(tune.tierFor(0), null);
  assert.equal(tune.tierFor(9).units, 5);
  assert.equal(tune.tierFor(NaN), null);
  assert.ok(!tune.tierFor(1).ram && tune.tierFor(2).ram, 'ramming starts at two stars');
  assert.ok(!tune.tierFor(2).pit && tune.tierFor(3).pit && tune.tierFor(3).box, 'PIT and box at three');
  for (let s = 1; s <= 5; s++) assert.ok(tune.tierFor(s).vmax < 56, 'slower than the slowest car (fabia 56)');
  assert.ok(tune.tierFor(4).vmax > tune.tierFor(3).vmax && tune.tierFor(4).react < tune.tierFor(3).react,
    'four stars is faster and quicker on the trigger');
});

// ---- 2. fair shooting -------------------------------------------------------

test('a pistol is a threat close and noise far, and worse on the move', () => {
  const at = (d, mv = false, tv = 0) => tune.hitChance(d, tune.aimSigma(mv, tv, 1));
  const p10 = at(10), p25 = at(25), p50 = at(50);
  assert.ok(p10 > 0.4 && p10 < 0.65, `10 m: ${p10.toFixed(2)}`);
  assert.ok(p25 > 0.08 && p25 < 0.25, `25 m: ${p25.toFixed(2)}`);
  assert.ok(p50 < 0.07, `50 m: ${p50.toFixed(3)}`);
  assert.ok(at(10, true) < p10 * 0.6, 'a walking shooter is much worse');
  assert.ok(at(10, false, 6) < p10 * 0.75, 'a running target is harder');
});

test('the traced rounds hit as often as the model says they should', () => {
  const rnd = rng(3);
  const hurt = { n: 0, damage(v) { this.n += v; }, down: () => false };
  for (const d of [10, 25, 50]) {
    const g = new Gunfire({ scene: null, city: null, vitals: hurt, rnd });
    const N = 4000;
    let hits = 0;
    const tgt = { foot: true, x: 0, y: 0, z: 0, speed: 0 };
    for (let i = 0; i < N; i++) if (g.shoot(d, 1.42, 0, tgt, false, 1, 1) === 'foot') hits++;
    const want = tune.hitChance(d, tune.aimSigma(false, 0, 1));
    const got = hits / N;
    // the cylinder is not exactly the box the model integrates: a loose band
    assert.ok(Math.abs(got - want) < Math.max(0.06, want * 0.35),
      `${d} m: traced ${got.toFixed(3)} vs model ${want.toFixed(3)}`);
  }
});

test('a wall between stops the round', () => {
  const wallAt = { buildingAt: (x, z) => x > 4 && x < 6 };
  const hurt = { n: 0, damage(v) { this.n += v; }, down: () => false };
  const g = new Gunfire({ scene: null, city: wallAt, vitals: hurt, rnd: rng(1) });
  let through = 0;
  for (let i = 0; i < 300; i++) if (g.shoot(10, 1.42, 0, { foot: true, x: 0, y: 0, z: 0, speed: 0 }) === 'foot') through++;
  assert.equal(through, 0);
  assert.equal(hurt.n, 0);
});

// ---- 3. the chase -----------------------------------------------------------

test('one star: a unit is called in behind you and catches up at town speed', () => {
  const R = rig({ stars: 1 });
  cruise(R, 1, 0.2);                                 // let the recruiter run
  assert.equal(R.pol.units.length, 1, 'no unit drafted');
  assert.ok(R.pol.stats.spawned >= 1, 'it was not called in');
  const u = R.pol.units[0];
  const d0 = Math.hypot(u.x - R.me.x, u.z - R.me.z);
  assert.ok(d0 > 150, `called in at ${d0.toFixed(0)} m, in plain view`);
  let dMin = d0;
  cruise(R, 13, 40, () => { dMin = Math.min(dMin, Math.hypot(u.x - R.me.x, u.z - R.me.z)); });
  assert.ok(dMin < 30, `at 47 km/h it never got closer than ${dMin.toFixed(0)} m`);
  assert.equal(R.pol.stats.rams, 0, 'one star never rams');
});

test('three stars: three cars, and one of them gets AHEAD of you', () => {
  const R = rig({ stars: 3, seed: 11 });
  let maxUnits = 0, ahead = 0;
  cruise(R, 14, 45, () => {
    maxUnits = Math.max(maxUnits, R.pol.units.length);
    for (const u of R.pol.units) if (u.x > R.me.x + 10 && Math.abs(u.x - R.me.x) < 80) ahead++;
  });
  assert.equal(maxUnits, 3);
  assert.ok(ahead > 60, `no unit got in front (${ahead} steps)`);
});

test('two stars: the tail car rams you through the collision solver, and telegraphs it', () => {
  const R = rig({ stars: 2, seed: 5 });
  let shoves = 0, prev = 0;
  cruise(R, 15, 70, () => {
    // a ram is visible as the player's speed being kicked UP between steps
    if (R.me.speed - prev > 0.8) shoves++;
    prev = R.me.speed;
  });
  const st = R.pol.stats;
  assert.ok(st.rams >= 2, `rams ${st.rams} (tries ${st.ramTries}, contacts ${st.contacts})`);
  assert.ok(st.ramTries >= st.rams, 'every ram was announced (horn) before contact');
  assert.ok(shoves >= 1, 'the rams never moved the player car');
});

test('three stars: a PIT turns the player car', () => {
  const R = rig({ stars: 3, seed: 21 });
  let maxYaw = 0;
  cruise(R, 16, 90, () => { maxYaw = Math.max(maxYaw, Math.abs(R.me.yaw ?? 0)); });
  const st = R.pol.stats;
  assert.ok(st.pits >= 1, `pits ${st.pits} (tries ${st.pitTries}, rams ${st.rams})`);
  assert.ok(maxYaw > 0.8, `the PIT never spun the car (yaw ${maxYaw.toFixed(2)})`);
});

// ---- 4. stop, step out, shoot, die -----------------------------------------

test('two stars: nobody shoots; they come to the door and arrest a driver who has stopped', () => {
  vitals.reset();
  assert.ok(!tune.tierFor(1).lethal && !tune.tierFor(2).lethal && tune.tierFor(3).lethal, 'pistols from three stars');
  assert.ok(tune.tierFor(2).box, 'the second car goes ahead to block');
  const R = rig({ stars: 2, seed: 9 });
  cruise(R, 15, 40);
  const hp0 = vitals.hp();
  for (let i = 0; i < 60 * 60 && !R.arrests.length; i++) { R.step(-1); R.me.speed = Math.max(0, R.me.speed); }
  assert.ok(R.pol.stats.deploys > 0, 'nobody got out');
  assert.ok(R.said.length && R.said[0].includes('Policie'), 'no warning');
  assert.equal(R.pol.gunfire.stats.shots, 0, 'a shot was fired at two stars');
  assert.ok(R.arrests.length > 0, 'a driver sitting in a stopped car was never arrested');
  assert.equal(vitals.hp(), hp0, 'an arrest cost health');
  vitals.reset();
});

test('two stars on foot: stand still and you are arrested, run and you are brought down', () => {
  const run = (moving) => {
    vitals.reset();
    const R = rig({ stars: 2, seed: 4 });
    cruise(R, 12, 30);
    R.me.speed = 0;
    let x = R.me.x;
    for (let i = 0; i < 60 * 40 && !R.arrests.length && !R.tackles.length; i++) {
      // a slow jog: slower than an officer after you, far too fast to cuff
      if (moving) { x += 3.0 / 60; R.me.x = x; }
      R.step(0, true);
    }
    return { arrests: R.arrests.length, tackles: R.tackles.length, shots: R.pol.gunfire.stats.shots };
  };
  const still = run(false), fleeing = run(true);
  assert.ok(still.arrests > 0 && still.shots === 0, `standing: ${JSON.stringify(still)}`);
  assert.ok(fleeing.tackles > 0 && fleeing.arrests === 0 && fleeing.shots === 0, `running: ${JSON.stringify(fleeing)}`);
  vitals.reset();
});

test('stop the car: they pull up, get out, warn, shoot, and it can kill you', () => {
  vitals.reset();
  const R = rig({ stars: 3, seed: 9 });
  cruise(R, 15, 40);                                 // the chase arrives
  // now stop dead and stay in the car
  let deployedAt = -1, firstShot = -1, warnedAt = -1;
  const t0 = R.now();
  for (let i = 0; i < 60 * 90 && !vitals.down(); i++) {
    R.step(-1);
    R.me.speed = Math.max(0, R.me.speed);
    if (deployedAt < 0 && R.pol.stats.deploys > 0) deployedAt = R.now() - t0;
    if (warnedAt < 0 && R.said.length) warnedAt = R.now() - t0;
    if (firstShot < 0 && R.pol.gunfire.stats.shots > 0) firstShot = R.now() - t0;
  }
  assert.ok(deployedAt >= 0, 'nobody got out');
  assert.ok(R.pol.officers.out.length >= 1, 'no officers on the street');
  // the parked car and the men beside it are hulls the traffic must wait behind
  assert.ok(R.pol.blockers.length >= 1 + R.pol.officers.out.length, 'traffic would drive through them');
  assert.ok(warnedAt >= 0 && R.said[0].includes('Policie'), 'no warning');
  assert.ok(firstShot > deployedAt + 1.0, `fired ${(firstShot - deployedAt).toFixed(2)} s after getting out: no telegraph`);
  const g = R.pol.gunfire.stats;
  // A stopped car eight metres away is a target nobody misses, so the
  // fairness here is the body of the car: most rounds stay in the metal.
  assert.ok(g.hitCar > 0, `shots ${g.shots}, none hit the car`);
  assert.ok(g.hitCabin < g.hitCar * 0.6, `cabin ${g.hitCabin} of ${g.hitCar}: the car is no cover`);
  assert.ok(vitals.down(), `still alive after 90 s at ${vitals.hp().toFixed(0)} HP`);
  vitals.revive();
  vitals.reset();
});

test('on foot you can be shot, and running away makes them miss more', () => {
  const run = (moving) => {
    vitals.reset();
    const R = rig({ stars: 3, seed: 4 });
    cruise(R, 12, 30);
    R.me.speed = 0;
    const hp0 = vitals.hp();
    let x = R.me.x;
    for (let i = 0; i < 60 * 25 && !vitals.down(); i++) {
      if (moving) { x += 5.5 / 60; R.me.x = x; }
      R.step(0, true);
    }
    const g = R.pol.gunfire.stats;
    const res = { shots: g.shots, hits: g.hitFoot, lost: hp0 - vitals.hp() + (vitals.down() ? 100 : 0) };
    if (vitals.down()) vitals.revive();
    vitals.reset();
    return res;
  };
  const still = run(false), fleeing = run(true);
  assert.ok(still.shots > 3 && still.hits > 0, `standing: ${JSON.stringify(still)}`);
  assert.ok(fleeing.shots > 3, `nobody shot at a man running away: ${JSON.stringify(fleeing)}`);
  const rs = still.hits / still.shots, rf = fleeing.shots ? fleeing.hits / fleeing.shots : 0;
  assert.ok(rf < rs, `running ${rf.toFixed(2)} vs standing ${rs.toFixed(2)}`);
});

test('no stars, no police: everything goes away', () => {
  const R = rig({ stars: 2, seed: 2 });
  cruise(R, 14, 20);
  assert.ok(R.pol.units.length > 0);
  R.setStars(0);
  cruise(R, 25, 40);
  assert.equal(R.pol.units.length, 0);
  assert.equal(R.pol.officers.out.length, 0);
});

// Review, 25 Nov 2026: a two-man unit parks, one officer is killed (a fist,
// js/copfists.js, or a car), his partner walks back and gets in. The car used
// to read that as nobody left to drive: it went silent, `dead`, and stood
// there with the partner inside until you were far away. The survivor drives
// off and rejoins, and the next time it stops he gets out again.
test('a unit that lost one of two men drives off with the other, and puts him out again', async () => {
  const { CopTargets, copBody } = await import('../js/copfists.js');
  vitals.reset();
  const R = rig({ stars: 2, seed: 4 });
  cruise(R, 12, 30);
  R.me.speed = 0;
  const O = R.pol.officers;
  let u = null;
  for (let i = 0; i < 60 * 40 && !u; i++) {
    R.step(0, true);
    const crew = O.out.filter((r) => r.state !== 'down');
    if (crew.length >= 2 && crew[0].unit === crew[1].unit) u = crew[0].unit;
  }
  assert.ok(u, 'no two-man crew got out');
  const [a, b] = O.out.filter((r) => r.unit === u);
  // A is punched dead
  const cops = new CopTargets(O);
  cops.hurt(copBody(a), { dmg: 999 });
  cops.react(copBody(a), 'dead', { hit: 'hitChest' }, R.me.x, R.me.z);
  // B is called back to the car (as the chase would when you drive off)
  O.recall(u);
  let left = false, wentDead = false, siren = true;
  for (let i = 0; i < 60 * 10 && !left; i++) {
    R.step(0, true);
    if (u.dead) wentDead = true;
    if (u.car && u.car.siren === false) siren = false;
    if (u.mode !== 'parked') left = true;
  }
  assert.equal(b.free, true, 'the partner never got back in');
  assert.equal(wentDead, false, 'a car with a live man at the wheel was written off');
  assert.equal(siren, true, 'the siren went quiet with a man still in the car');
  assert.ok(left, `the car is still standing there (${u.mode})`);
  // the chase goes on: the next time it stops by a man on foot, he gets out
  let again = false;
  for (let i = 0; i < 60 * 60 && !again; i++) {
    R.step(0, true);
    again = O.out.some((r) => r.unit === u && r.state !== 'down');
  }
  assert.ok(again, 'the survivor never got out again: the dead record blocked the deploy');
  vitals.reset();
});
