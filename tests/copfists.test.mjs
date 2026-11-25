// ---- js/copfists.js: a fist on a policeman, and a driver's pocket ---------
// Review, 25 Nov 2026: the officers out of a patrol car could not be punched
// (they were no target source of js/combat.js), so 'napadeni_policisty' never
// came from a fist; and a driver thrown out of a jacked car had no pid, so
// every one of them carried the same 94 Kc. These drive the REAL Combat
// against the REAL Officers (js/policecops.js), headless, with a body that
// has the fight's recordings by role like a Rocketbox person in the game.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { Combat, pocketOf } = await import('../js/combat.js');
const { Officers } = await import('../js/policecops.js');
const { CopTargets, COP_HP, copBody } = await import('../js/copfists.js');
const { driverPid } = await import('../js/carjack.js');
const { MOVES } = await import('../js/fightmoves.js');

// the lengths of the real recordings (fight.bin on a Rocketbox body)
const DUR = { hitHead: 0.43, hitChest: 0.33, hitBack: 0.83, getUp: 1.53 };
function copBodyStub() {
  const log = [];
  return {
    log, group: new THREE.Group(), stopped: 0,
    walk() {}, aimPose() {}, standPose() {}, ragdollPose() { log.push({ role: 'ragdoll' }); },
    act(role, t, w = 1, mask = 'upper', fade = 0.08, hold = false) {
      const d = DUR[role] ?? 0;
      if (d) log.push({ role, t, mask, hold });
      return d;
    },
    actDur(role) { return DUR[role] ?? 0; },
    actStop() { this.stopped++; },
    roles() { const out = []; for (const e of log) if (out[out.length - 1] !== e.role) out.push(e.role); return out; },
  };
}

const SEIZE = Object.freeze({ lethal: false, cops: 1, react: 1, rate: 1, acc: 0.5, dmg: 10 });
const X = 300, Z = 300, RING = 0.9;

// One officer standing at (X, Z), out of a parked unit, and a player an arm's
// length south of him facing north (camYaw 0 is -z), on foot and standing still.
function scene({ tier = SEIZE } = {}) {
  const arrests = [];
  const O = new Officers({ makeBody: copBodyStub, rnd: () => 0.5, onArrest: (r) => arrests.push(r) });
  const unit = { car: { x: X + 6, z: Z, y: 0, heading: 0, wid: 1.8, len: 4.4 } };
  assert.equal(O.deploy(unit, 1), 1);
  const r = O._rec.find((q) => !q.free);
  r.x = X; r.z = Z; r.state = 'seize';
  const cops = new CopTargets(() => O);
  const crimes = [];
  const money = { paid: [], earn(n) { this.paid.push(n); } };
  const hud = { foes: [], foe(p) { this.foes.push(p); }, keep() {} };
  const cb = new Combat({ peds: null, targets: [cops], wallet: money, hud });
  cb.onCrime((kind, x, z, who) => crimes.push({ kind, who }));
  const player = { pos: { x: X, z: Z + RING }, y: 0, heading: 0, speed: 0, aimLock: false, combatPose: null,
    inCar: null, boarding: null, exiting: null };
  const ctx = { player, onFoot: true, camYaw: 0 };
  let t = 0;
  const cc = { t: 0, px: X, pz: Z + RING, py: 0, pcar: null, onFoot: true, pspeed: 0, tier, down: false, lying: false };
  // one step of the street: the police clock and the fists together, the
  // player pinned where he stands
  const step = (dt = 1 / 60) => {
    t += dt; cc.t = t;
    O.update(dt, cc);
    cb.update(dt, ctx);
    ctx.player.combatPose?.();
  };
  const run = (secs, dt = 1 / 60) => { for (let i = 0, n = Math.round(secs / dt); i < n; i++) step(dt); };
  step();
  return { O, r, unit, cops, cb, ctx, crimes, money, hud, arrests, step, run };
}

// a press in rhythm and the swing played out
function punch(S, kind = 'light') {
  S.cb.strike(kind);
  for (let k = 0; k < 400 && (S.cb.busy || k < 2); k++) S.step(1 / 120);
  for (let k = 0; k < 6; k++) S.step(1 / 120);
}

test('a punch on a policeman is assault on an officer, it hurts him, and he reels', () => {
  const S = scene();
  const p = copBody(S.r);
  assert.equal(S.cops.nearest(X, Z + RING, 1.5, null), p, 'an officer on his feet is nobody a fist can find');
  S.r.cuffT = 0.8;                                // his hand already on your collar
  punch(S);
  assert.equal(S.r.hp, COP_HP - MOVES.jab.dmg);
  assert.deepEqual(S.crimes.map((c) => c.kind), ['napadeni_policisty'], 'the punch was the wrong crime');
  assert.equal(S.crimes[0].who, p, 'the crime names somebody else');
  assert.equal(S.hud.foes[0], p, 'his health bar never came up');
  assert.ok(S.r.body.roles().includes('hitHead'), 'his head did not snap back');
  assert.ok(S.r.cuffT < 0.2, 'being hit did not make him let go');
  assert.equal(S.money.paid.length, 0);
});

test('he is back on duty after the snap, and the arrest goes on', () => {
  const S = scene();
  S.cb.strike('light');
  for (let k = 0; k < 120 && !S.crimes.length; k++) S.step(1 / 120);
  assert.equal(S.crimes.length, 1, 'the jab never landed');
  assert.equal(S.r.fist?.mode, 'stun', 'the punch left no mark on him');
  const x0 = S.r.x, z0 = S.r.z;
  S.run(0.3);
  assert.equal(S.r.fist?.mode, 'stun', 'he shrugged a jab off at once');
  assert.ok(Math.hypot(S.r.x - x0, S.r.z - z0) < 1e-6, 'he walked on while reeling');
  S.run(0.8);
  assert.equal(S.r.fist, null, 'he never got over a jab');
  assert.equal(S.r.state, 'seize', 'a punched officer below three stars stopped coming for you');
  // the player stands still with him alongside: cuffed within a second or two
  S.run(2);
  assert.ok(S.arrests.length >= 1, 'a man who punched a policeman and stood there was not arrested');
  assert.ok(Math.hypot(S.r.x - x0, S.r.z - z0) < 1, 'he wandered off');
});

test('the combo floors him, he is no target on the ground, and he gets up to finish the job', () => {
  const S = scene();
  const moves = [];
  S.cb.onSwing((m) => moves.push(m));
  punch(S); punch(S); punch(S);
  assert.deepEqual(moves, ['jab', 'cross', 'hook']);
  assert.equal(S.r.hp, COP_HP - MOVES.jab.dmg - MOVES.cross.dmg - MOVES.hook.dmg);
  const p = copBody(S.r);
  assert.equal(p.state, 'ko', 'the hook did not put him down');
  assert.equal(S.r.state === 'down', false, 'a knock-down killed him');
  assert.equal(S.cops.nearest(X, Z + RING, 1.5, null), null, 'a man on the ground can still be punched');
  assert.equal(S.crimes.length, 3);
  assert.ok(S.crimes.every((c) => c.kind === 'napadeni_policisty'));
  S.run(1);
  assert.ok(S.r.body.log.some((e) => e.role === 'hitBack' && e.mask === 'full'), 'the fall is not the whole body');
  assert.equal(S.O.allIn(S.unit), false, 'his unit drove off without him');
  S.run(7);
  assert.ok(S.r.body.roles().includes('getUp'), 'he never played getting up');
  assert.equal(S.r.fist, null, 'he stayed down');
  assert.equal(p.state, 'walk');
  assert.equal(S.r.state, 'seize', 'up again, he did not come for you');
});

test('a killing blow is the killing of an officer, pays nothing, and lays him out for good', () => {
  const S = scene();
  S.r.hp = 8;
  punch(S);
  assert.deepEqual(S.crimes.map((c) => c.kind), ['zabiti_policisty']);
  assert.equal(S.r.state, 'down');
  assert.equal(copBody(S.r).dead, true);
  assert.equal(S.money.paid.length, 0, "a dead policeman's wallet was robbed");
  assert.equal(S.O.stats.downs, 1);
  S.run(3);
  const last = S.r.body.log[S.r.body.log.length - 1];
  assert.equal(last.role, 'hitBack');
  assert.equal(last.hold, true, 'the body would stand up when the layer let go');
  assert.equal(S.r.state, 'down', 'a dead man got up');
  assert.equal(S.O.allDown(S.unit), true, 'his unit does not know it lost him');
  punch(S);
  assert.equal(S.crimes.length, 1, 'a corpse was punched again');
});

test('a pooled record handed to the next officer is a new man with a full bar', () => {
  const S = scene();
  punch(S);
  const old = copBody(S.r);
  S.O.dropUnit(S.unit);
  assert.equal(S.r.free, true);
  assert.equal(S.r.body, null);
  assert.equal(old.dead, true, 'a body the pool took back still reads as standing there');
  assert.equal(old.mesh, null);
  const u2 = { car: { x: X, z: Z + 6, y: 0, heading: 0 } };
  S.O.deploy(u2, 1);
  const r2 = S.O._rec.find((q) => !q.free);
  assert.equal(r2.hp, COP_HP, 'the new man came out of the car already beaten');
  assert.equal(r2.fist, null);
  assert.notEqual(copBody(r2), old);
});

test('an officer you run over while he is down is laid out by the car, not the fist', () => {
  const S = scene();
  punch(S); punch(S); punch(S);
  assert.equal(copBody(S.r).state, 'ko');
  const stopped = S.r.body.stopped;
  // the player's car drives over him
  const car = { x: S.r.x, z: S.r.z, y: 0, heading: 0, speed: 9, len: 4.4, wid: 1.8 };
  S.O.update(1 / 60, { t: 99, px: S.r.x, pz: S.r.z + 1, py: 0, pcar: car, onFoot: false, pspeed: 9, tier: SEIZE, down: false });
  assert.equal(S.r.state, 'down');
  assert.equal(S.r.fist, null, 'the fist kept a run-over body');
  assert.ok(S.r.body.stopped > stopped, 'the recording kept playing over the ragdoll');
});

test('a thrown-out driver carries his own pocket, the one his car was born with', () => {
  assert.equal(driverPid({ _driverPid: 41 }), 41);
  assert.equal(driverPid({ ai: { seed: -7 } }), -7);
  assert.equal(driverPid({ _driverPid: 5, ai: { seed: 9 } }), 5, 'main.js stamps the seed before steal() drops car.ai');
  const strangers = new Set();
  for (let i = 0; i < 20; i++) strangers.add(pocketOf(driverPid({})));
  assert.ok(strangers.size > 5, 'drivers without a schedule all carry the same money');
  const pockets = new Set();
  for (let s = 1; s <= 40; s++) pockets.add(pocketOf(driverPid({ ai: { seed: s * 7919 } })));
  assert.ok(pockets.size > 20, `40 drivers carried only ${pockets.size} different sums`);
  assert.ok(Number.isInteger(driverPid(null)));
});

// Review, 25 Nov 2026: a two-man unit whose driver was punched dead read as a
// car with nobody left in it once the partner walked back and was freed from
// the records (allDown looked only at the records still held), and the dead
// man's record, held until the unit is dropped, made count() refuse every
// later deploy of that unit.
test('a two-man crew with one man dead still has a driver, and can put him out again', () => {
  const O = new Officers({ makeBody: copBodyStub, rnd: () => 0.5 });
  const unit = { car: { x: X, z: Z, y: 0, heading: 0, wid: 1.8, len: 4.4 } };
  assert.equal(O.deploy(unit, 2), 2);
  const [a, b] = O._rec.filter((q) => !q.free && q.unit === unit);
  const cops = new CopTargets(O);
  // A is punched dead
  cops.hurt(copBody(a), { dmg: 999 });
  cops.react(copBody(a), 'dead', MOVES.hook, X, Z + 5);
  assert.equal(a.state, 'down');
  assert.equal(O.allDown(unit), false, 'one dead of two is a car with nobody in it');
  assert.equal(O.allIn(unit), false, 'B is still out');
  // B walks back to the car and gets in
  O.recall(unit);
  const cc = { t: 0, px: X + 40, pz: Z, py: 0, pcar: null, onFoot: true, pspeed: 0, tier: SEIZE, down: false };
  for (let i = 0; i < 600 && !b.free; i++) { cc.t += 1 / 60; O.update(1 / 60, cc); }
  assert.equal(b.free, true, 'the partner never got back in');
  assert.equal(O.allIn(unit), true);
  assert.equal(O.allDown(unit), false, 'a man at the wheel read as nobody left');
  assert.equal(O.count(unit), 0, 'a dead man counted as an officer on the street');
  assert.equal(O.dead(unit), 1);
  // the unit stops again: the survivor gets out, alone
  assert.equal(O.deploy(unit, 2), 1, 'the dead record blocked the next deploy');
  assert.equal(O.count(unit), 1);
  assert.equal(O.deploy(unit, 2), 0, 'a second deploy while he is out');
  // and when he dies too, nobody is left to drive it
  const c = O._rec.find((q) => !q.free && q.unit === unit && q.state !== 'down');
  cops.hurt(copBody(c), { dmg: 999 });
  assert.equal(O.allDown(unit), true, 'a car whose whole crew is dead still has a driver');
  assert.equal(O.deploy(unit, 2), 0, 'a dead crew got out again');
  // dropping the unit forgets it: the pooled record is a new car next time
  O.dropUnit(unit);
  assert.equal(O.allDown(unit), false);
  assert.equal(O.deploy(unit, 1), 1);
  // a one-man car whose man is dead does not grow a partner when the stars rise
  const lone = O._rec.find((q) => !q.free && q.unit === unit);
  cops.hurt(copBody(lone), { dmg: 999 });
  assert.equal(O.allDown(unit), true);
  assert.equal(O.deploy(unit, 2), 0, 'three stars raised a dead man\'s car a new crew');
  // while nobody is lost, more stars do bring the partner out
  const u2 = { car: { x: X + 20, z: Z, y: 0, heading: 0 } };
  assert.equal(O.deploy(u2, 1), 1);
  O.recall(u2);
  const cc2 = { t: 100, px: X + 60, pz: Z, py: 0, pcar: null, onFoot: true, pspeed: 0, tier: SEIZE, down: false };
  for (let i = 0; i < 600 && O.count(u2); i++) { cc2.t += 1 / 60; O.update(1 / 60, cc2); }
  assert.equal(O.count(u2), 0);
  assert.equal(O.deploy(u2, 2), 2, 'a whole crew at three stars put out one man');
});
