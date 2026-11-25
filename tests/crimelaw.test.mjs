// ---- crime law: who saw it, who rings it in, and when ----------------------
// Frank, 25 Nov 2026: a driver thrown out of his car rings the police (two
// stars) unless the player kills him first with nobody else there; a punch is
// a star only with police within 50 m; "aby to fungovalo jako v GTAčku".
// js/crimelaw.js against the real js/wanted.js, and the thrown-out driver of
// js/carjack.js as a body that can be run down and punched.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('../libs/three.module.js');
const wanted = await import('../js/wanted.js');
const { CrimeLaw, RULES, verdict, CALL_T, POLICE_R, CALLER_R } = await import('../js/crimelaw.js');
const { Carjack } = await import('../js/carjack.js');

// a law with a switchable police presence and a list of bystanders
function law({ police = false, bystanders = [] } = {}) {
  const env = { police, bystanders };
  const L = new CrimeLaw({
    wanted,
    policeAt: () => env.police,
    witnesses: (x, z, r, victim) => env.bystanders.filter((b) => b !== victim),
  });
  return { L, env };
}
function run(L, seconds, dt = 0.05) {
  for (let t = 0; t < seconds; t += dt) { L.update(dt); wanted.update(dt, {}); }
}

test('the table: who has to see what', () => {
  assert.equal(verdict(RULES.rvacka, true, 0), 'now', 'a punch the police saw');
  assert.equal(verdict(RULES.rvacka, false, 3), 'none', 'a punch nobody in uniform saw is nobody\'s business');
  assert.equal(verdict(RULES.prepadeni, false, 1), 'call', 'the driver rings it in');
  assert.equal(verdict(RULES.prepadeni, false, 0), 'none', 'nobody left to ring');
  assert.equal(verdict(RULES.zabiti, false, 1), 'call');
  assert.equal(verdict(RULES.zabiti, true, 0), 'now');
  assert.equal(verdict(RULES.kradez, false, 2), 'none', 'a parked car taken is a star only if police see it');
  assert.equal(verdict(RULES.zabiti_policisty, false, 0), 'now', 'the police are their own witness');
  assert.equal(POLICE_R, 50);
  assert.ok(CALLER_R >= 20 && CALLER_R <= 60);
  assert.ok(CALL_T >= 5 && CALL_T <= 15, 'long enough to do something about it, short enough to matter');
});

test('a thrown-out driver rings the police: two stars, a moment later', () => {
  wanted.reset();
  const { L } = law();
  const driver = { dead: false };
  assert.equal(L.report('prepadeni', 0, 0, driver), 'call');
  assert.equal(wanted.stars(), 0, 'the stars came before anybody rang');
  run(L, CALL_T - 1);
  assert.equal(wanted.stars(), 0);
  run(L, 1.5);
  assert.equal(wanted.stars(), 2, '"i tak budu mít jako 2 hvězdičky"');
  assert.equal(wanted.lastCrime(), 'přepadení řidiče');
});

test('kill him before he rings, with nobody else there, and nothing happens', () => {
  wanted.reset();
  const { L } = law();
  const driver = { dead: false };
  L.report('prepadeni', 0, 0, driver);
  run(L, 4);
  driver.dead = true;
  assert.equal(L.report('zabiti', 0, 0, driver), 'none', 'the killing itself had no witness');
  run(L, CALL_T + 2);
  assert.equal(wanted.stars(), 0, '"zabiju toho člověka a nikdo tam nebude ... tak je to v pořádku"');
  assert.equal(L.calls.length, 0);
});

test('…but a bystander who saw it rings anyway, for the jacking and for the killing', () => {
  wanted.reset();
  const passer = { dead: false };
  const { L } = law({ bystanders: [passer] });
  const driver = { dead: false };
  L.report('prepadeni', 0, 0, driver);
  driver.dead = true;
  assert.equal(L.report('zabiti', 0, 0, driver), 'call');
  run(L, CALL_T + 1);
  assert.equal(wanted.stars(), 2);
  assert.equal(wanted.lastCrime(), 'zabití', 'the label follows the heavier charge of the two calls');
});

test('with police within 50 m it is at once, no call', () => {
  wanted.reset();
  const { L } = law({ police: true });
  assert.equal(L.report('prepadeni', 0, 0, { dead: false }), 'now');
  assert.equal(wanted.stars(), 2);
});

test('a punch: one star with police watching, nothing without, and free in self-defence', () => {
  wanted.reset();
  const { L, env } = law({ bystanders: [{ dead: false }] });
  assert.equal(L.report('rvacka', 0, 0, { dead: false }), 'none');
  run(L, CALL_T + 1);
  assert.equal(wanted.stars(), 0, 'a scuffle with only civilians around');
  env.police = true;
  assert.equal(L.report('rvacka', 0, 0, { dead: false, brawl: true }), 'free', 'he was fighting back');
  assert.equal(wanted.stars(), 0);
  assert.equal(L.report('rvacka', 0, 0, { dead: false }), 'now');
  assert.equal(wanted.stars(), 1, '"zaútočím na nějakého člověka a blízkosti 50 metrů policie, tak zase mám jako hvězdičku"');
});

test('a man knocked down by your car rings it in himself; killed, only witnesses can', () => {
  wanted.reset();
  const { L } = law();
  const man = { dead: false };
  assert.equal(L.report('srazeni', 0, 0, man), 'call');
  run(L, CALL_T + 1);
  assert.equal(wanted.stars(), 1);
  wanted.reset();
  const { L: L2 } = law();
  assert.equal(L2.report('zabiti', 0, 0, { dead: true }), 'none', 'a dead man and nobody else');
});

test('crimes against the police always count, and killing one is three stars', () => {
  wanted.reset();
  const { L } = law();
  assert.equal(L.report('zabiti_policisty', 0, 0), 'now');
  assert.equal(wanted.stars(), 3);
});

test('an arrest or a death hangs up every pending call', () => {
  wanted.reset();
  const { L } = law();
  L.report('prepadeni', 0, 0, { dead: false });
  assert.ok(L.nextCall() <= CALL_T);
  L.clear();
  run(L, CALL_T + 1);
  assert.equal(wanted.stars(), 0);
  assert.equal(L.nextCall(), Infinity);
});

// ---- the thrown-out driver as a body ----------------------------------------
function jack() {
  const body = () => {
    const parts = {};
    for (const k of ['body', 'torso', 'chest', 'head', 'pelvis', 'armL', 'armR', 'legL', 'legR', 'elbowL', 'elbowR',
      'kneeL', 'kneeR', 'footL', 'footR']) parts[k] = { rotation: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } };
    return { group: new THREE.Group(), parts, ragdollPose() {}, standPose() {}, walk() {}, dispose() {} };
  };
  return new Carjack({ scene: new THREE.Scene(), world: { supportY: () => 0, heightAt: () => 0 }, makeBody: body });
}
function upAndRunning(J) {
  const car = { x: 0, z: 0, y: 0, heading: 0, wid: 1.8, len: 4.6 };
  const r = J.throwOut(car, -1, { x: -0.6, y: 0.45, z: 0.1 });
  for (let n = 0; r.phase !== 'run' && n < 60 * 12; n++) J.update(1 / 60, 0, 0);
  return r;
}

test('the driver can be punched to death, and is only a target while on his feet', () => {
  const J = jack();
  const r = upAndRunning(J);
  assert.equal(r.state, 'walk');
  assert.equal(J.nearest(r.x, r.z, 2), r, 'a running driver is a target');
  for (let i = 0; i < 3; i++) J.hurt(r, { dmg: 40 });
  assert.equal(r.dead, true);
  assert.equal(r.state, 'dead');
  assert.equal(J.nearest(r.x, r.z, 2), null, 'a corpse is not a target');
  for (let i = 0; i < 60 * 5; i++) J.update(1 / 60, 50, 50);
  assert.equal(J.out.includes(r), true, 'the body lies there, it does not run off');
});

test('run him down: slow knocks him over, fast kills him, and the law is told', () => {
  const J = jack();
  const hits = [];
  J.onRunOver = (r, killed) => hits.push(killed);
  const r = upAndRunning(J);
  // the stolen car comes back for him at 40 km/h
  const car = { x: r.x, z: r.z + 1, y: 0, heading: 0, speed: 11, wid: 1.8, len: 4.6 };
  J.update(1 / 60, 0, 0, car);
  assert.deepEqual(hits, [true]);
  assert.equal(r.dead, true);

  const J2 = jack();
  const h2 = [];
  J2.onRunOver = (q, killed) => h2.push(killed);
  const q = upAndRunning(J2);
  J2.update(1 / 60, 0, 0, { x: q.x, z: q.z, y: 0, heading: 0, speed: 3.5, wid: 1.8, len: 4.6 });
  assert.deepEqual(h2, [false], 'a walking-pace knock is not a killing');
  assert.equal(q.dead, false);
  assert.equal(q.phase, 'thrown', 'knocked over, down he goes');
});
