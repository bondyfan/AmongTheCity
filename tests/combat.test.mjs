// ---- Fists: the combo, the door they go through, and the money ------------
//
// js/combat.js and the injury door in js/pedestrians.js were written against
// one brief and they are checked together here, because every interesting
// claim either file makes is a claim about the OTHER one. combat.js never
// touches a citizen's velocity, state or health — it builds a blow record and
// hands it to peds.hurt() — so "three punches kill a man" is not a property of
// either module alone, and a test that stubbed the door would be testing the
// stub. The whole of this file therefore drives the REAL Pedestrians against
// the REAL Combat, with no canvas, no WebGL and no DOM: three.js runs, it just
// never draws (see tests/three-alias.mjs, and the header of
// tests/pedestrians-shared.test.mjs which registers it for the same reason).
//
// These tests are not a transcription of the two files. An adversarial read of
// the DESIGN found six ways this feature ships broken, and every one of them is
// silent — five of the six leave a green suite behind:
//
//   1. A COMBO THAT CANNOT BE REACHED. This one is not hypothetical; it
//      shipped. The first melee build threw a ragdoll on hit #1, and BOTH the
//      car hit pass in pedestrians.js and the melee sweep in combat.js skip
//      anything in 'rag' — so hits #2 and #3 landed on nobody and the ladder
//      was unreachable by construction. It tested green, because "one punch,
//      one ragdoll" is also what a working punch looks like from the outside.
//      Nothing short of asserting that all three blows reach the SAME body, and
//      that the THIRD is the one that puts them down, catches it.
//   2. A PUNCH THAT EVICTS A CITIZEN FROM THE CITY. A non-lethal blow that
//      writes p.state, or that releases the body from its slot, costs the
//      shared crowd a person for a whole generation (TRIP_T = 420 s) and turns
//      a flinch into a ghost this tab alone can see. The symptom is a slot that
//      quietly empties, which nobody will ever report.
//   3. HOOKS THAT LIE. No onPedHit is a punch nobody screams at and no
//      policeman hears about. Two onPedKilled for one death is two crimes, two
//      payments and two death cards — and a car rolling a corpse down the
//      street reaches hurt() a dozen times, which is exactly where a second one
//      comes from.
//   4. MONEY THAT MOVES. The first design folded a quarter-hour bucket into the
//      pocket "so the same person cannot be farmed". It changes the contents of
//      a man's pockets while you stand in front of him, and makes two clients
//      in one room disagree about the same corpse. The assertion is not "the
//      figure is right" — it is that the figure does not depend on the clock,
//      and the only way to state that is to move the clock.
//   5. A MUGGING THAT JOGS ON THE SPOT. 'held' is a state and not a flag
//      precisely because freezing the arc alone leaves _schedStep's animation
//      floor of 0.3 running: the victim stands still and walks at the same
//      time. p.animate must not be called AT ALL while somebody is held.
//   6. A SWING THAT THROWS. strike() is bound to a key the player mashes, on a
//      build where peds may be half-wired, and stepGame(dt) runs it several
//      times per rendered frame. An empty street, a null crowd and three calls
//      in one frame all have to be one swing or none, and never an exception —
//      js/vitals.js tells that story: one TypeError inside stepGame froze the
//      game on the last drawn frame, every frame, for as long as it kept being
//      raised.
//
// WHY THE FIGHTS HAPPEN IN AN EMPTY FIELD. The geometry tests teleport their
// victim to (4000, 4000) — four kilometres from the fixture's pavements — and
// never call peds.update() while the fists are flying. That is not a shortcut
// around the simulation, it is what makes the assertions mean something: with
// the crowd left where it stands, "the third punch landed on the same man" is
// a claim about who happened to wander within 1.5 m, and a stranger stepping
// into the arc would make this file flaky instead of true. The tests that ARE
// about walking (the flinch, the hold) run the real update loop and assert on
// the real schedule.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Pedestrians, PED_HP } = await import('../js/pedestrians.js');
const { Combat, pocketOf } = await import('../js/combat.js');
const { fightsBack } = await import('../js/fightmoves.js');
const { PRICE } = await import('../js/prices.js');

// ---------------------------------------------------------------- fixtures ----

// A town of pavements, the same shape tests/pedestrians-shared.test.mjs uses
// and for its reasons: one way per block (OSM splits a pavement at every
// junction), crossing ways repeating the EXACT coordinate so the junction index
// welds them into one graph, and every way non-drivable so the module treats it
// as footway. Smaller than that file's grid — this one only has to produce a
// crowd, not a region.
const HALF = 360, STEP = 60;
function gridPaths() {
  const roads = [];
  const n = Math.floor(HALF / STEP);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j < n; j++) {
      const x = i * STEP, z = j * STEP;
      roads.push({ t: 'footway', d: 0, w: 2,
        p: [[x, z], [x + 1.5, z + STEP / 2], [x, z + STEP]] });
      roads.push({ t: 'footway', d: 0, w: 2,
        p: [[z, x], [z + STEP / 2, x - 1.5], [z + STEP, x]] });
    }
  }
  let id = 0;
  for (const r of roads) r._id = ++id;
  return roads;
}

const stubScene = { add() {}, remove() {} };

// A world epoch far from zero, like the real one (worldT() is ~1.8e7 and
// climbing): a schedule that only works near t = 0 would be a lie.
const T0 = 17_900_000;

// Where the fights happen. Four kilometres from the last pavement, so nearest()
// can only ever find whoever the test put there. See the header.
const FAR_X = 4000, FAR_Z = 4000;

// Where the player stands to throw a punch: inside REACH (1.5 m) and dead ahead
// of camYaw 0, which by ARCHITECTURE.md's convention points at −z.
const RING = 0.9;

// One town, one crowd, one clock we own.
function town({ max = 20 } = {}) {
  const city = { roads: gridPaths(), onTileLoaded() {} };
  const peds = new Pedestrians(stubScene, city);
  let now = T0, elapsed = 0;
  peds.clock = () => now;
  peds.max = max;
  return {
    peds,
    // Time is (base + i/hz), never an accumulator — the same discipline the
    // shared-crowd tests keep, so nothing here measures its own rounding.
    run(secs, focus = { x: 0, z: 0 }, hz = 20) {
      const n = Math.round(secs * hz), base = elapsed;
      for (let i = 1; i <= n; i++) {
        now = T0 + base + i / hz;
        peds.update(1 / hz, focus);
      }
      elapsed = base + n / hz;
    },
    // A citizen on their feet, on their own schedule. The birth budget fills a
    // cold ring over a few seconds, so this walks the clock until somebody
    // shows up rather than assuming they already have.
    walker() {
      for (let i = 0; i < 12; i++) {
        const p = this.peds.peds.find((q) => !q.free && q.state === 'walk' && q.sch);
        if (p) return p;
        this.run(5);
      }
      assert.fail('the fixture never produced a walking citizen');
    },
  };
}

// Move a body out to the empty field, mesh and all.
function arena(p, x = FAR_X, z = FAR_Z) {
  p.x = x; p.z = z;
  p.mesh.position.set(x, 0, z);
  return p;
}

// The citizen poses js/player.js forwards through `_cit`. Recording them is how
// a test can see WHICH rung a swing was — the rung is fixed when the swing
// starts and is never exposed any other way.
function poses() {
  const log = [];
  return {
    log,
    punchPose(t01, arm) { log.push({ kind: 'punch', t01, arm }); },
    kickPose(t01) { log.push({ kind: 'kick', t01 }); },
    // What a swing was, in order, one entry per swing.
    swings() {
      const out = [];
      let last = null;
      for (const e of log) {
        const tag = e.kind === 'kick' ? 'kick' : 'punch' + e.arm;
        // t01 rewinds to ~0 at the start of every swing
        if (!last || tag !== last.tag || e.t01 < last.t01) out.push({ tag, t01: e.t01 });
        last = { tag, t01: e.t01 };
      }
      return out.map((s) => s.tag);
    },
  };
}

// The smallest thing js/combat.js calls a player, with the pose hooks where
// js/player.js really keeps them (on `_cit`, not on the player) so that _hook's
// resolution is exercised rather than bypassed.
function walker(x, z, cit = poses()) {
  return {
    pos: { x, z }, y: 0, heading: 0, speed: 0,
    aimLock: false, combatPose: null,
    inCar: null, boarding: null, exiting: null,
    _cit: cit, cit,
  };
}

// Stand the player where a punch at `p` connects, and hand back the ctx that
// main.js would.
function facing(p, cit = poses()) {
  const player = walker(p.x, p.z + RING, cit);
  return { player, onFoot: true, camYaw: 0, cit };
}

function purse() {
  return { paid: [], earn(n, what) { this.paid.push({ n, what }); } };
}
function speaker() {
  return { names: [], sfxAt(name) { this.names.push(name); } };
}

// Throw one attack and step until it has recovered.
//
// It STEPS BEFORE IT PRESSES, and that ordering is combat.js's contract rather
// than a convenience: update() "MUST be called every step", because it is the
// only thing that advances the clock and the only thing that decides whether a
// punch is legal at all. strike() reads that verdict. A test that pressed first
// would be testing what the module knew one frame ago.
//
// dt is deliberately 1/120 — twice main.js's usual step — because stepGame(dt)
// runs several times per rendered frame and every assertion in this file has to
// hold when it does. player.combatPose is called after every step because that
// is js/player.js's contract: the pose runs at the END of the player's update.
function land(cb, ctx, { dt = 1 / 120, steps = 130 } = {}) {
  cb.update(dt, ctx);
  ctx.player.combatPose?.();
  const began = cb.strike();
  for (let i = 0; i < steps; i++) {
    cb.update(dt, ctx);
    ctx.player.combatPose?.();
  }
  return began;
}

// Wait for a body that was thrown to fly, land, lie there and get back on its
// feet, one step at a time, pinned in the arena.
//
// THE PINNING IS NOT COSMETIC. A body cut loose by a blow keeps walking the
// beat it was BORN on — _getUp re-anchors to the nearest point of it — and this
// one's beat is four kilometres away in the fixture's grid, so the first
// _freeStep after they stand up drags them most of the way home. The sweep then
// finds a ghost nobody is looking at and collects it, and the rest of the test
// punches at a body that is no longer in the crowd. Re-seating them after every
// step keeps the focus honest; the ragdoll's own velocity, bounce and settle
// run exactly as they would anywhere else.
function standUp(T, p, x, z, limit = 25) {
  for (let i = 0; i < limit * 20; i++) {
    T.run(0.05, { x, z });
    assert.ok(T.peds.peds.includes(p), 'the crowd collected the body mid-recovery');
    arena(p, x, z);
    if (p.state === 'walk') return p;
  }
  assert.fail(`a stunned citizen never got up — still in '${p.state}'`);
}

// Presses IN RHYTHM, the way a combo is played: each one the moment the last
// swing has come home, well inside fightmoves.js CHAIN_GAP. Returns the moves
// thrown, in order, as combat.js reported them through onSwing.
function rhythm(cb, ctx, n, kind = 'light', dt = 1 / 120) {
  const moves = [];
  const log = (m) => moves.push(m);
  cb.onSwing(log);
  cb.update(dt, ctx);
  for (let i = 0; i < n; i++) {
    cb.strike(kind);
    for (let k = 0; k < 400 && (cb.busy || k < 2); k++) { cb.update(dt, ctx); ctx.player.combatPose?.(); }
    for (let k = 0; k < 6; k++) { cb.update(dt, ctx); ctx.player.combatPose?.(); }   // 50 ms of daylight
  }
  cb._swingFns.splice(cb._swingFns.indexOf(log), 1);
  return moves;
}

// A modelled body as far as the fight can tell: recordings by role, with the
// lengths of the real ones (fight.bin on a Rocketbox body), and a log of what
// was played. Hung on a pedestrian as `cit` it makes the crowd's KO path run.
function modelled() {
  const DUR = { fightJab: 0.87, fightCross: 1.0, fightHook: 0.47, fightHookRec: 0.6,
    hitHead: 0.43, hitChest: 0.33, hitBack: 0.83, getUp: 1.53, fallDown: 2.4 };
  const log = [];
  return {
    log, fists: 0, stopped: 0,
    act(role, t, w = 1, mask = 'upper', fade = 0.08, hold = false) {
      const d = DUR[role] ?? 0;
      if (d) log.push({ role, t, w, mask, hold });
      return d;
    },
    actDur(role) { return DUR[role] ?? 0; },
    fist(w) { this.fists++; },
    actStop() { this.stopped++; },
    roles() { const out = []; for (const e of log) if (out[out.length - 1] !== e.role) out.push(e.role); return out; },
  };
}

// Kill somebody the quick way: the door takes them to `left` HP (no crime, no
// panic), so the next fist is the one that ends it.
function softened(T, p, left) {
  T.peds.hurt(p, fist(p.hp - left, { panic: 0 }));
  return p;
}

// Time passing with nobody throwing anything.
function idle(cb, ctx, secs, dt = 1 / 60) {
  for (let i = 0, n = Math.round(secs / dt); i < n; i++) cb.update(dt, ctx);
}

// A crowd that records what it was told, wrapped around the real one.
function watchHooks(peds) {
  const rec = { hit: [], killed: [] };
  peds.onPedHit = (p, imp) => { rec.hit.push({ p, imp }); };
  peds.onPedKilled = (p) => { rec.killed.push(p); };
  return rec;
}

// A blow shaped like a fist, for the tests that knock on the door directly.
// Written as a literal on purpose: pedestrians.js's own _blow scratch record
// "belongs to _launch alone — an outside caller building a blow should write
// its own literal", and a test that reached for the module's scratch would be
// asserting against the thing it is supposed to be independent of.
function fist(dmg, extra = null) {
  return Object.assign({
    dmg, launch: false, vx: 0, vz: -1, vy: 0, spin: 0, cause: 'pěst',
  }, extra);
}

// ==========================================================================
// 1. THE COMBO — the bug that shipped, stated as the property it violates
// ==========================================================================

// THE ONE THAT MATTERS. Three presses in rhythm, one victim, and the third is
// the one that floors him (since the GTA rebuild of 25 Nov 2026: jab, cross,
// hook; js/fightmoves.js). Every clause here is load-bearing:
//
//   · all three land AT ALL: the shipped bug dropped #2 and #3 on the floor
//     because #1 had already put the body in 'rag', which both hit passes skip;
//   · all three land ON THE SAME BODY;
//   · the first two leave somebody STANDING, in the crowd, walking;
//   · the third is the HOOK and it floors without killing: one combo is a
//     beating, not a funeral.
test('three presses in rhythm are jab, cross, hook, all on the same man, and the hook floors him', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  const money = purse();
  const ctx = facing(victim);
  const cb = new Combat({ peds: T.peds, wallet: money, audio: speaker() });

  const hp = [];
  const moves = [];
  cb.onSwing((m) => { moves.push(m); });
  cb.update(1 / 120, ctx);
  for (let i = 0; i < 3; i++) {
    cb.strike();
    for (let k = 0; k < 400 && (cb.busy || k < 2); k++) { cb.update(1 / 120, ctx); ctx.player.combatPose?.(); }
    hp.push(victim.hp);
    if (i < 2) {
      assert.equal(victim.state, 'walk',
        `punch ${i + 1} took the victim out of 'walk': hits ${i + 2}+ can never land`);
    }
    for (let k = 0; k < 6; k++) cb.update(1 / 120, ctx);
  }
  assert.deepEqual(moves, ['jab', 'cross', 'hook'], 'three presses in rhythm are not the combo');
  assert.equal(hooks.hit.length, 3, `${hooks.hit.length} of 3 blows reached the door`);
  for (const h of hooks.hit) assert.equal(h.p, victim, 'a blow landed on somebody else');
  assert.deepEqual(hp, [PED_HP - 12, PED_HP - 28, PED_HP - 60], 'the ladder is not 12, 16, 32');
  // floored, not dead: the hook is a knock-down, the crowd keeps a man who can get up
  assert.equal(victim.dead, false, 'one combo killed a healthy man');
  assert.equal(victim.state, 'rag', 'the hook left him on his feet');
  assert.equal(hooks.killed.length, 0);
  assert.equal(money.paid.length, 0, 'a man on the ground was robbed while alive');
  // the lofted figure still gets its arm poses: left, right, right
  assert.deepEqual(ctx.cit.swings(), ['punch0', 'punch1', 'punch1'], 'the arms do not read as a combo');
});

// The chain belongs to the RHYTHM of the presses (GTA's way), and a move is
// fixed when it STARTS, so a hook aimed at a man who steps aside really does
// land on whoever caught it. What must not happen is that the stranger dies of
// one hook: the damage and the knock-down rules are about HIS health, not
// about the button.
test('a hook that lands on a stranger floors the stranger without killing them', () => {
  const T = town();
  const first = arena(T.walker(), FAR_X, FAR_Z);
  const second = arena(T.peds.peds.find((p) => p !== first && p.state === 'walk'),
    FAR_X + 400, FAR_Z);
  assert.ok(second, 'the fixture only produced one citizen');
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(first);
  // the chain belongs to the rhythm: two on the first man, and he steps away
  // just as the third goes out
  assert.deepEqual(rhythm(cb, ctx, 2), ['jab', 'cross']);
  assert.equal(first.state, 'walk', 'two punches were not two flinches');
  arena(first, FAR_X + 800, FAR_Z);
  ctx.player.pos.x = second.x;
  ctx.player.pos.z = second.z + RING;
  assert.deepEqual(rhythm(cb, ctx, 1), ['hook'], 'the third press in rhythm was not the hook');
  assert.equal(hooks.hit.filter((h) => h.p === second).length, 1, 'the hook found nobody');
  assert.equal(second.dead, false, 'one hook killed a stranger');
  assert.equal(second.hp, PED_HP - 32);
  assert.equal(second.state, 'rag', 'a hook left the stranger on their feet');
  assert.equal(first.dead, false, 'the man who walked away died anyway');
});

// Out of rhythm the chain starts again: CHAIN_GAP is an absolute deadline on
// combat.js's own clock, and getting it wrong is not a crash, it is a hook
// thrown at somebody you tapped a minute ago.
test('presses slower than the rhythm are all jabs, and Q is the hook at once', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);
  const moves = [];
  cb.onSwing((m) => { moves.push(m); });
  land(cb, ctx);
  idle(cb, ctx, 0.6);                       // longer than CHAIN_GAP after the swing
  land(cb, ctx);
  idle(cb, ctx, 0.6);
  land(cb, ctx);
  assert.deepEqual(moves, ['jab', 'jab', 'jab'], 'a cold chain still threw the cross and the hook');
  assert.equal(victim.state, 'walk', 'three jabs floored a healthy man');
  assert.equal(victim.hp, PED_HP - 36);
  // the heavy key throws the hook straight away, chain or none
  idle(cb, ctx, 0.6);
  cb.update(1 / 120, ctx);
  assert.equal(cb.strike('heavy'), true);
  assert.equal(moves[moves.length - 1], 'hook', 'Q did not throw the hook');
});

// A man a car already clipped is on the floor sooner: any blow that leaves
// KO_HP (25) or less floors him, and nothing left is death. Worth pinning as a
// property rather than as a number.
test('somebody a car already hurt goes down sooner, and dies on the next', () => {
  const T = town();
  const victim = arena(T.walker());
  T.peds.hurt(victim, fist(PED_HP * 0.6, { panic: 0 }));
  assert.equal(victim.state, 'walk', 'a survivable blow put him on the floor');
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);
  land(cb, ctx);                            // 40 -> 28
  assert.equal(victim.state, 'walk', 'a jab floored a man with 40 HP left');
  land(cb, ctx);                            // 28 -> 16: at KO_HP or less, he goes down
  assert.equal(victim.dead, false);
  assert.equal(victim.state, 'rag', 'a badly hurt man stayed up under a jab');
  standUp(T, victim, FAR_X, FAR_Z);
  arena(victim);
  land(cb, ctx);                            // 16 -> 4: down again
  assert.equal(victim.dead, false);
  standUp(T, victim, FAR_X, FAR_Z);
  arena(victim);
  land(cb, ctx);
  assert.equal(victim.dead, true, 'there was nothing left and he is still alive');
});

// ==========================================================================
// 2. THE FLINCH — a blow that does not kill leaves the city alone
// ==========================================================================

// The rule the whole refactor exists for, stated from the crowd's side: a
// non-lethal blow costs hp and NOTHING else. Not the state, not the slot, not
// the schedule. A body cut loose here is a ghost only this tab can see and a
// slot the shared world holds empty for the rest of the generation (420 s),
// and the only symptom is a street that quietly thins out.
test('a punch that does not kill leaves a citizen in the crowd, walking', () => {
  const T = town();
  const p = T.walker();
  const slot = p.sch;
  const before = { x: p.x, z: p.z, gen: slot.gen, seed: slot.seed };
  let animated = 0;
  const realWalk = p.animate;
  p.animate = (...a) => { animated++; return realWalk(...a); };

  assert.equal(T.peds.hurt(p, fist(34)), true, 'the door refused a fist');

  assert.equal(p.state, 'walk', "a flinch wrote p.state — every blow after it lands on nobody");
  assert.equal(p.dead, false);
  assert.ok(p.hp > 0 && p.hp < PED_HP, `a 34-point punch left ${p.hp} HP`);
  assert.equal(p.free, 0, 'a flinch released the body from its schedule');
  assert.equal(p.sch, slot, 'a flinch took the citizen off their own slot');
  assert.equal(slot.body, p, 'the slot lost the body it still owns');
  assert.ok(!slot.held, 'the slot was held empty for a man who is still standing');
  assert.equal(slot.gen, before.gen, 'a punch rolled the generation');
  assert.equal(slot.seed, before.seed, 'a punch made him somebody else');

  // …and he is still WALKING: the schedule still drives him and the legs still
  // move. A body frozen where it was punched passes every assertion above.
  T.run(1.5, { x: p.x, z: p.z });
  assert.ok(T.peds.peds.includes(p), 'the flinch evicted him from the body list');
  assert.equal(p.state, 'walk');
  assert.ok(animated > 10, `p.animate ran ${animated} times in 1.5 s — he is standing still`);
  assert.ok(Math.hypot(p.x - before.x, p.z - before.z) > 0.5,
    'he has not moved since the punch');
});

// The other half of the same rule: a LETHAL blow is allowed to do all of it, and
// the slot it vacates is HELD rather than reopened, so the beat cannot walk a
// fresh citizen straight over the body of the last one.
test('a killing blow takes the body out of the schedule and holds the slot empty', () => {
  const T = town();
  const p = arena(T.walker());
  const slot = p.sch;
  T.peds.hurt(p, fist(PED_HP + 8));
  assert.equal(p.dead, true);
  assert.equal(p.state, 'rag', 'a dead man is still on his feet');
  assert.equal(p.free, 1, 'the corpse is still being driven by the shared schedule');
  assert.equal(p.sch, null);
  assert.equal(slot.body, null, 'the slot still points at the body it lost');
  assert.equal(slot.held, 1, 'the slot is free to hand out a replacement over the corpse');
});

// hitCd is the CAR's gate — decremented in update(), read in _hitPass, never
// tested by hurt(). A melee combo forced to wait on it would drop its second
// and third punch on the floor, which is the same shipped bug arriving through
// a different door. The property, stated without naming either constant: a
// second fist landing in the very next millisecond still counts.
test('the car cooldown does not swallow the next punch', () => {
  const T = town();
  const p = arena(T.walker());
  const hooks = watchHooks(T.peds);
  T.peds.hurt(p, fist(20));
  assert.ok(p.hitCd > 0, 'a blow set no cooldown at all');
  const after = p.hp;
  T.peds.hurt(p, fist(20));
  assert.equal(hooks.hit.length, 2, 'the second blow was swallowed by the car cooldown');
  assert.ok(p.hp < after, 'the second blow cost nothing');
});

// ==========================================================================
// 3. THE HOOKS — the street has to hear it, and hear it once
// ==========================================================================

// onPedHit is what the scream, the blood and the police hang off; onPedKilled is
// what pays out and what raises the crime. A car rolling a corpse down the
// street reaches hurt() a dozen times, and that is precisely where a second
// onPedKilled comes from — so the assertion is not "it fires" but "it fires
// once, ever, for this body".
test('every blow is announced once, and a death is announced exactly once', () => {
  const T = town();
  const p = arena(T.walker());
  const hooks = watchHooks(T.peds);

  T.peds.hurt(p, fist(34));
  assert.equal(hooks.hit.length, 1, 'a punch reached nobody');
  assert.equal(hooks.killed.length, 0, 'a flinch raised a death');
  assert.ok(hooks.hit[0].imp > 0, 'the hooks were told the punch was worth nothing');

  T.peds.hurt(p, fist(PED_HP));
  assert.equal(hooks.hit.length, 2);
  assert.equal(hooks.killed.length, 1, 'the death went unannounced');
  assert.equal(hooks.killed[0], p);

  // Roll the corpse down the street. Every one of these is a real impact and
  // must be announced as one — and not one of them is a second death.
  for (let i = 0; i < 12; i++) T.peds.hurt(p, fist(PED_HP, { launch: true }));
  assert.equal(hooks.hit.length, 14, 'running over a corpse stopped being an event');
  assert.equal(hooks.killed.length, 1,
    `onPedKilled fired ${hooks.killed.length} times for one death`);
  assert.equal(p.hp, 0, 'a corpse kept losing health it did not have');
});

// A punch is audible and it is NOT a car crash. main.js screams past an impact
// of 3 and js/chatter.js witnesses past 3, so a fist has to clear that bar
// without arriving anywhere near the metres per second a bonnet reports.
test('a fist reports an impact a bystander notices and a crash investigator does not', () => {
  const T = town();
  const p = arena(T.walker());
  const hooks = watchHooks(T.peds);
  T.peds.hurt(p, fist(34));
  const imp = hooks.hit[0].imp;
  assert.ok(imp > 3, `a punch reported ${imp} — under the threshold the street reacts at`);
  assert.ok(imp < 25, `a punch reported ${imp}, which is a car doing 90 km/h`);
});

// The blow is one object rewritten in place for the life of the process, so
// hurt() must READ it and never keep it. A door that stashed the reference
// would see the next punch's numbers stamped on the last punch's victim.
test('the door keeps no reference to the blow it was handed', () => {
  const T = town();
  const p = arena(T.walker());
  const q = arena(T.peds.peds.find((b) => b !== p && b.state === 'walk'), FAR_X + 400, FAR_Z);
  const scratch = fist(10, { cause: 'první' });
  T.peds.hurt(p, scratch);
  scratch.dmg = 90;
  scratch.cause = 'druhá';
  T.peds.hurt(q, scratch);
  assert.equal(p.hp, PED_HP - 10, `the first victim ended on ${p.hp} — the record was kept`);
  assert.equal(p.cause, 'první', 'the first victim was re-labelled by the second blow');
  assert.equal(q.hp, PED_HP - 90);
});

// ==========================================================================
// 4. HELD — a man with his hands up is not jogging
// ==========================================================================

// 'held' is a STATE and not a flag for one measurable reason: _schedStep passes
// Math.max(0.3, …) as the animation speed, so a victim pinned in place by
// freezing their arc alone would walk on the spot for as long as you robbed
// them. The assertion is therefore not "he does not move" — a frozen arc gives
// you that too — it is that p.animate is not called AT ALL.
test('a held citizen does not walk and does not animate', () => {
  const T = town();
  const p = T.walker();
  let animated = 0;
  const realWalk = p.animate;
  p.animate = (...a) => { animated++; return realWalk(...a); };

  assert.equal(T.peds.hold(p, true), true, 'nobody could be held');
  assert.equal(p.state, 'held');
  const at = { x: p.x, z: p.z };
  const heading = p.heading;

  T.run(3, at);
  assert.equal(animated, 0, `the walk cycle ran ${animated} times on a man standing still`);
  assert.equal(p.x, at.x, 'a held citizen drifted down the pavement');
  assert.equal(p.z, at.z);
  assert.equal(p.speed, 0, `a held citizen reports ${p.speed} m/s`);
  assert.equal(p.state, 'held', 'the hold expired on its own');
  // The pose is not ours: heading is READ here, never written, so whoever is
  // holding them can turn the victim to face them by assigning it.
  p.heading = heading + 1;
  T.run(0.5, at);
  assert.equal(p.mesh.rotation.y, heading + 1, 'the walk loop took the heading back');

  // Let go, and everything starts again — including the walk cycle. A release
  // that left them frozen would be the same bug wearing the opposite hat.
  assert.equal(T.peds.hold(p, false), true);
  assert.equal(p.state, 'walk');
  T.run(2, at);
  assert.ok(animated > 10, `p.animate ran ${animated} times after release`);
  assert.ok(Math.hypot(p.x - at.x, p.z - at.z) > 0.3, 'he never started walking again');
});

// Only somebody on their feet can be robbed, and the answer has to be honest:
// a caller that is told `true` will start driving a pose on a body the walk
// loop is still moving.
test('hold() refuses anybody who is not on their feet, and says so', () => {
  const T = town();
  const p = arena(T.walker());
  assert.equal(T.peds.hold(p, false), false, 'released somebody who was never held');
  T.peds.hurt(p, fist(PED_HP));
  assert.equal(p.state, 'rag');
  assert.equal(T.peds.hold(p, true), false, 'a corpse put its hands up');
  assert.equal(p.state, 'rag', 'a refused hold changed the state anyway');
  assert.equal(T.peds.hold(null, true), false);
  assert.equal(T.peds.hold({}, true), false, 'a body with no mesh was held');
});

// Being hit ends a mugging: the hands come down before the body does. And a
// held citizen is still a target — combat.js's arc accepts 'walk' and 'held'
// deliberately, because the man you are robbing is the one you are most likely
// to punch.
test('a held citizen can still be punched, and the punch lets go of them', () => {
  const T = town();
  const p = arena(T.walker());
  const hooks = watchHooks(T.peds);
  assert.equal(T.peds.hold(p, true), true);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(p);

  land(cb, ctx);
  assert.equal(hooks.hit.length, 1, 'a man with his hands up could not be hit');
  assert.equal(hooks.hit[0].p, p);
  assert.notEqual(p.state, 'held', 'he is still holding his hands up after being hit');
  assert.equal(p.state, 'walk', 'a flinch on a held man took him off his feet');
});

// ==========================================================================
// 5. MONEY — a pocket is a pure function of a pid, and of nothing else
// ==========================================================================

// The rejected design folded a quarter-hour bucket into this. The only way to
// state that it is gone is to move every clock the process has and compute
// again: js/worldclock.js runs on performance.now() and re-anchors off
// Date.now(), so moving both is moving world time.
function atClock(msAhead, fn) {
  const rd = Date.now;
  const perf = globalThis.performance;
  const rp = perf?.now;
  Date.now = () => rd.call(Date) + msAhead;
  if (perf && rp) perf.now = () => rp.call(perf) + msAhead;
  try { return fn(); } finally {
    Date.now = rd;
    if (perf && rp) perf.now = rp;
  }
}

const PIDS = [];
for (let i = 0; i < 64; i++) PIDS.push((i * 2654435761) | 0);

test('what is in somebody\'s pocket does not change while you are standing in front of them', () => {
  const before = PIDS.map(pocketOf);
  // A quarter of an hour is the bucket the rejected design used; the day and the
  // week are there so a coarser one cannot hide behind it either.
  for (const jump of [15 * 60e3, 16 * 60e3, 60 * 60e3, 24 * 3600e3, 7 * 24 * 3600e3]) {
    const after = atClock(jump, () => PIDS.map(pocketOf));
    assert.deepEqual(after, before, `pockets changed ${jump / 60e3} minutes later`);
  }
  // …and it is the same answer twice in a row, which is what two clients
  // robbing the same corpse depend on.
  assert.deepEqual(PIDS.map(pocketOf), before);
});

test('a pocket is money: whole koruny, inside the range js/prices.js publishes', () => {
  const P = PRICE.job.pocket;
  let sum = 0, fat = 0, lo = Infinity, hi = -Infinity;
  const N = 60000;
  for (let i = 0; i < N; i++) {
    const kc = pocketOf((i * 2654435761) | 0);
    assert.ok(Number.isInteger(kc), `pocketOf gave ${kc}, which is not koruny`);
    assert.ok(kc >= P.min && kc <= P.max, `a pocket held ${kc}, outside [${P.min}, ${P.max}]`);
    sum += kc;
    if (kc > (P.max + P.min) / 2) fat++;
    if (kc < lo) lo = kc;
    if (kc > hi) hi = kc;
  }
  const mean = sum / N;
  // js/prices.js's own calibration: "a robbed pocket averages ~130 Kč, twelve of
  // them to a tank". If this band moves, that sentence and the fuel economy it
  // was written against have both quietly stopped being true.
  assert.ok(mean > 110 && mean < 155, `the average pocket is ${mean.toFixed(0)} Kč`);
  // The shape matters as much as the mean: a uniform 40–900 has the same
  // average and makes every third pocket a payday.
  assert.ok(fat / N < 0.12, `${(100 * fat / N).toFixed(1)} % of the city is carrying real cash`);
  assert.ok(fat / N > 0.01, 'nobody in the city ever carries real cash');
  assert.ok(lo <= P.min + 2, `the floor of the distribution is ${lo}, not ${P.min}`);
  assert.ok(hi > P.max * 0.9, `the richest of ${N} pockets held only ${hi}`);
});

// A hand-built test body, a peer with no pid, a body from a build that predates
// the stamp: none of them may put NaN into somebody's wallet.
test('a body with no usable identity still has a pocket, and it is a number', () => {
  const P = PRICE.job.pocket;
  for (const bad of [undefined, null, NaN, Infinity, -Infinity, 1.5, '4242', {}, [], true]) {
    const kc = pocketOf(bad);
    assert.ok(Number.isInteger(kc) && kc >= P.min && kc <= P.max,
      `pocketOf(${String(bad)}) = ${kc}`);
  }
  assert.equal(pocketOf(undefined), pocketOf(0), 'an unidentified body is not the zero pid');
});

// End to end: the killing blow collects, once, through the wallet — and it
// collects the SAME figure whenever the session happens to be running.
test("a kill pays out exactly the dead man's pocket, once, whatever the hour", () => {
  const expected = (() => {
    const T = town();
    const victim = softened(T, arena(T.walker()), 10);
    const money = purse();
    const cb = new Combat({ peds: T.peds, wallet: money });
    const ctx = facing(victim);
    land(cb, ctx);
    assert.equal(victim.dead, true);
    land(cb, ctx); land(cb, ctx);
    assert.equal(money.paid.length, 1, `${money.paid.length} payments for one corpse`);
    assert.equal(money.paid[0].n, pocketOf(victim.pid), 'the wallet was paid the wrong pocket');
    assert.equal(money.paid[0].what, 'kapsa', 'the HUD ticker was given the wrong label');
    return { kc: money.paid[0].n, pid: victim.pid };
  })();

  // The same world, the same slot, the same man, three quarters of an hour
  // later on every clock in the process.
  atClock(45 * 60e3, () => {
    const T = town();
    const victim = softened(T, arena(T.walker()), 10);
    assert.equal(victim.pid, expected.pid, 'the fixture minted a different citizen');
    const money = purse();
    const cb = new Combat({ peds: T.peds, wallet: money });
    land(cb, facing(victim));
    assert.equal(money.paid.length, 1);
    assert.equal(money.paid[0].n, expected.kc,
      'the same man was worth a different amount an hour later');
  });
});

// Two flinches are not a mugging: nothing is paid until somebody is dead, and a
// half-wired build with no wallet at all must still land the punch.
test('a beating pays nothing, and a build with no wallet still fights', () => {
  const T = town();
  const victim = arena(T.walker());
  const money = purse();
  const cb = new Combat({ peds: T.peds, wallet: money });
  const ctx = facing(victim);
  rhythm(cb, ctx, 3);
  assert.equal(victim.dead, false);
  assert.equal(money.paid.length, 0, 'somebody was robbed while they were still alive');

  const T2 = town();
  const v2 = softened(T2, arena(T2.walker()), 10);
  const hooks = watchHooks(T2.peds);
  const bare = new Combat({ peds: T2.peds });          // no wallet, no audio, no chatter
  land(bare, facing(v2));
  assert.equal(v2.dead, true, 'a build with no wallet cannot kill anybody');
  assert.equal(hooks.killed.length, 1);
});

// One crime per blow, and the kill supersedes the brawl rather than joining it:
// firing both would charge js/wanted.js twice for one punch.
test('every landed blow is one crime, and the fatal one is not also a brawl', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const seen = [];
  cb.onCrime((kind, x, z, who) => { seen.push({ kind, x, z, who }); });
  const ctx = facing(victim);
  land(cb, ctx); land(cb, ctx);
  softened(T, victim, 10);                  // the door is not a crime
  land(cb, ctx);
  assert.deepEqual(seen.map((c) => c.kind), ['rvacka', 'rvacka', 'zabiti']);
  for (const c of seen) {
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z), 'a crime with no scene');
    assert.ok(Math.hypot(c.x - FAR_X, c.z - FAR_Z) < 3,
      'the crime was reported somewhere other than where it happened');
    assert.equal(c.who, victim, 'the crime does not say who it was done to');
  }
  // A swing that hits nothing is not a crime.
  ctx.player.pos.x = FAR_X + 900;
  land(cb, ctx);
  assert.equal(seen.length, 3, 'a whiff was reported to the police');
});

// A listener that throws must not take the fist with it — js/vitals.js tells
// the story of one TypeError inside stepGame freezing the game on its last
// drawn frame, every frame.
test('a crime listener that throws does not stop the punch or rob the one behind it', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  let after = 0;
  cb.onCrime(() => { throw new Error('the police are on fire'); });
  cb.onCrime(() => { after++; });
  const hooks = watchHooks(T.peds);

  const warn = console.warn;
  console.warn = () => {};
  try {
    land(cb, facing(victim));
  } finally { console.warn = warn; }
  assert.equal(hooks.hit.length, 1, 'a throwing listener un-threw the punch');
  assert.equal(after, 1, 'the throw robbed the listener behind it');
});

// ==========================================================================
// 6. THE SWING — what a mashed button on a half-wired build may do
// ==========================================================================

// stepGame(dt) runs several times per rendered frame, and strike() is bound to
// a key players hold down. Three presses inside one frame are one swing, and
// one swing is one victim however many times it is stepped.
test('three presses in one frame are one punch, not three', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);

  cb.update(1 / 60, ctx);                    // combat.js must have seen a player
  assert.equal(cb.strike(), true, 'the first press was refused');
  assert.equal(cb.strike(), false, 'a second press inside the same frame started a swing');
  assert.equal(cb.strike(), false);
  // …and the frame itself is three physics steps, as main.js's clamp produces.
  for (let i = 0; i < 60; i++) for (let k = 0; k < 3; k++) cb.update(1 / 180, ctx);
  assert.equal(hooks.hit.length, 1,
    `${hooks.hit.length} blows landed for one press — the window is being spent more than once`);
  assert.equal(cb.busy, false, 'the swing never recovered');
});

// The swing must survive the clock being nonsense. This is the one piece of
// state in the file that is ACCUMULATED rather than read, and every deadline in
// it is a comparison against that accumulator: one NaN dt and `_now` is NaN for
// the rest of the session, every comparison answers false, and the player can
// never punch anything again. An Infinity is the same wound from the other
// side. Both have to be thrown away rather than added.
test('a corrupt or enormous dt does not poison the swing clock', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);

  for (const bad of [NaN, Infinity, -Infinity, -1, 0, undefined, null, '5', 1e9]) {
    cb.update(bad, ctx);
  }
  assert.equal(cb.busy, false, 'a corrupt frame started a swing on its own');
  land(cb, ctx);
  assert.equal(hooks.hit.length, 1, 'the fist never landed after a corrupt frame');

  // A tab hidden mid-punch comes back with one enormous step. The clamp means
  // it advances the swing by 0.25 s and no more, so the swing may well whiff —
  // what must NOT happen is that it stays live forever, or that the clock comes
  // back poisoned. Both are checked by the punch after it landing normally.
  cb.strike();
  cb.update(600, ctx);
  for (let i = 0; i < 60; i++) cb.update(1 / 120, ctx);
  assert.equal(cb.busy, false, 'a hidden tab left the player mid-swing forever');
  assert.ok(hooks.hit.length <= 2, 'one swing across a hidden tab landed twice');
  const before = hooks.hit.length;
  idle(cb, ctx, 0.6);
  land(cb, ctx);
  assert.equal(hooks.hit.length, before + 1, 'the clock never recovered from the hidden tab');
});

// An empty street is a whiff, and a whiff is a complete, legal swing: the pose
// runs, the aim lock is taken and given back, and nothing anywhere is hurt.
test('a swing at nobody is a whiff, and it recovers cleanly', () => {
  const T = town();
  const hooks = watchHooks(T.peds);
  const money = purse();
  const sfx = speaker();
  const cb = new Combat({ peds: T.peds, wallet: money, audio: sfx });
  const ctx = facing({ x: FAR_X, z: FAR_Z });      // four km from the nearest person

  assert.equal(land(cb, ctx), true, 'the player could not swing at thin air');
  assert.equal(hooks.hit.length, 0, 'a punch thrown at nothing hurt somebody');
  assert.equal(money.paid.length, 0);
  assert.equal(cb.busy, false, 'the whiff never recovered');
  assert.ok(sfx.names.some((n) => n.startsWith('fight_swing')), 'a swing made no sound at all');
  // The fists stay up for the stance (the body faces the camera, the stick
  // strafes)… and come down by themselves when nothing else happens. A stance
  // that never ends leaves the player walking sideways for the session.
  assert.equal(cb.stance, true, 'a swing did not put the fists up');
  assert.equal(ctx.player.aimLock, true);
  idle(cb, ctx, 5);
  assert.equal(cb.stance, false, 'the stance outlived its time');
  assert.equal(ctx.player.aimLock, false, 'the swing kept the aim lock');
  assert.equal(ctx.player.combatPose, null, 'the pose hook outlived the stance');
});

// Both of these are ADDITIONS to js/pedestrians.js landing in the same run as
// combat.js. Without them there is no honest way to hurt anybody, and reaching
// into ped physics from out here is the one thing this module must never do —
// so a half-wired build has to be silent rather than broken.
test('a missing or half-wired crowd is inert, never an exception', () => {
  for (const peds of [null, undefined, {}, { peds: [] },
    { nearest: () => null }, { hurt: () => true }]) {
    const cb = new Combat({ peds, wallet: purse() });
    const ctx = facing({ x: 0, z: 0 });
    assert.doesNotThrow(() => {
      cb.update(1 / 60, ctx);
      cb.strike();
      for (let i = 0; i < 60; i++) cb.update(1 / 120, ctx);
      cb.reset();
    }, `a crowd of ${JSON.stringify(peds)} threw`);
    assert.equal(cb.busy, false);
  }
  // …and no ctx at all, which is what main.js hands over on a frame where the
  // player does not exist yet.
  const bare = new Combat({});
  assert.doesNotThrow(() => {
    bare.update(1 / 60);
    bare.update(1 / 60, {});
    bare.strike();
    bare.update(1 / 60, {});
  });
});

// A press the player throws at a moment they demonstrably cannot fight in is
// refused and remembered by nobody. The difference between a buffer and a trap:
// a punch queued through a car journey lands on whoever they parked next to.
test('a punch thrown from the driver\'s seat is refused, not queued', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);
  cb.update(1 / 60, ctx);

  // He gets in and drives off. update() is what notices — it is the one place
  // that decides whether a punch is legal — so it runs first, exactly as
  // main.js runs it before it reads the input.
  ctx.player.inCar = { kind: 'fabia' };
  cb.update(1 / 60, ctx);
  assert.equal(cb.strike(), false, 'a punch was thrown from behind the wheel');
  for (let i = 0; i < 30; i++) cb.update(1 / 60, ctx);
  ctx.player.inCar = null;
  for (let i = 0; i < 60; i++) cb.update(1 / 120, ctx);
  assert.equal(hooks.hit.length, 0,
    'a press made in a car landed on whoever the player parked next to');

  // …and once they are out, the next press works normally.
  land(cb, ctx);
  assert.equal(hooks.hit.length, 1, 'getting out of the car left the player unable to fight');
});

// main.js binds the attack key at boot and the browser will deliver a keydown
// between that and the first stepGame. Without the buffer the first punch of the
// session is eaten — a bug report ("it didn't register") nobody can reproduce.
test('the first press of the session is not eaten by the boot frame', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);

  assert.equal(cb.strike(), false, 'a press before the first step claimed to have swung');
  for (let i = 0; i < 60; i++) { cb.update(1 / 120, ctx); ctx.player.combatPose?.(); }
  assert.equal(hooks.hit.length, 1, 'the first punch of the session was eaten');
});

// The soft lock is the ARC, and it is applied INSIDE the search rather than
// after it. Testing it afterwards lets one pedestrian standing behind the
// player shield everybody in front of them — the same shielding bug
// js/chatter.js's proximity scan had to fix with a `continue`.
test('somebody standing behind you does not shield the man you are swinging at', () => {
  const T = town();
  const target = arena(T.walker(), FAR_X, FAR_Z);
  const shield = arena(T.peds.peds.find((p) => p !== target && p.state === 'walk'),
    FAR_X, FAR_Z + RING + 0.3);              // between the player and the camera
  assert.ok(shield, 'the fixture only produced one citizen');
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(target);

  land(cb, ctx);
  assert.equal(hooks.hit.length, 1, 'the swing found nobody at all');
  assert.equal(hooks.hit[0].p, target,
    'the nearest body won even though it was behind the player');
});

// The dead and the lying are not targets: the ladder is chest-height animation
// and kicking a body on the tarmac needs a pose and a reason this pass does not
// have. A corpse that stayed hittable would also be a corpse that could be
// robbed twice.
test('a body on the ground is not a target', () => {
  const T = town();
  const victim = softened(T, arena(T.walker()), 10);
  const money = purse();
  const cb = new Combat({ peds: T.peds, wallet: money });
  const ctx = facing(victim);
  land(cb, ctx);
  assert.equal(victim.dead, true);
  const hooks = watchHooks(T.peds);
  const paid = money.paid.length;
  for (let i = 0; i < 5; i++) land(cb, ctx);
  assert.equal(hooks.hit.length, 0, 'the player kept punching a corpse');
  assert.equal(money.paid.length, paid, 'the corpse was robbed twice');
});

// A different body — a respawn, a teardown, a second local player — voids
// everything that referred to the old one, swing included. A half-thrown punch
// spent against a body it was not aimed from is the same class of bug
// js/vitals.js rejects for a vehicle sample.
test('swapping the player mid-swing cancels the swing instead of landing it', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);

  cb.update(1 / 60, ctx);
  assert.equal(cb.strike(), true);
  cb.update(1 / 120, ctx);                   // in the wind-up, before the window
  const old = ctx.player;
  ctx.player = walker(victim.x, victim.z + RING);
  for (let i = 0; i < 60; i++) cb.update(1 / 120, ctx);
  assert.equal(hooks.hit.length, 0, 'a punch aimed by one body landed from another');
  assert.equal(old.aimLock, false, 'the old body was left aim-locked forever');
  assert.equal(old.combatPose, null, 'the old body kept the pose hook');
  assert.equal(cb.busy, false);
});

// reset() is a new game. It drops the swing and the fight but KEEPS the crime
// listeners — main.js subscribes once at boot, and quietly unhooking the police
// on a restart would leave them blind for the rest of the session.
test('reset() drops the fight and keeps the police subscribed', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const seen = [];
  cb.onCrime((kind) => { seen.push(kind); });
  const ctx = facing(victim);
  assert.deepEqual(rhythm(cb, ctx, 2), ['jab', 'cross']);
  cb.reset();
  assert.equal(cb.busy, false);
  assert.equal(cb.stance, false, 'reset() left the fists up');
  // The chain went with it: the next press is a jab, not the hook.
  assert.deepEqual(rhythm(cb, ctx, 1), ['jab'], 'reset() left the hook queued up');
  assert.equal(seen.length, 3, 'reset() unsubscribed the police');
});

// The same listener registered twice — a HUD that init()s twice, a boot that
// runs twice — must not charge js/wanted.js two crimes for one punch.
test('the same crime listener cannot subscribe twice', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  let n = 0;
  const count = () => { n++; };
  cb.onCrime(count);
  cb.onCrime(count);
  cb.onCrime(null);
  cb.onCrime(undefined);
  land(cb, facing(victim));
  assert.equal(n, 1, `one blow reached the listener ${n} times`);
});

// ==========================================================================
// 7. THE FIGHT ON A MODELLED BODY (js/fightpeds.js), Nov 2026
// ==========================================================================
//
// With the people bank a body has recordings (human.js act()), and a body that
// is floored by a fist falls from one instead of being thrown: pedestrians.js
// hands it over upright as 'ko', and the crowd's half of the fight plays the
// fall, the lying there and the getting up. These run the REAL door and the
// REAL fight against a stand-in body that has the real clips' lengths.

// A walker who will or will not fight back, picked from the fixture by who
// they are (fightmoves.js fightsBack is a pure function of pid and archetype).
function personWho(T, fights) {
  for (let i = 0; i < 20; i++) {
    for (const p of T.peds.peds) {
      if (p.free || p.state !== 'walk' || !p.sch) continue;
      if (fightsBack(p.pid, 'm30') === fights) { p.arch = 'm30'; return p; }
    }
    T.run(5);
  }
  assert.fail(`the fixture produced nobody who ${fights ? 'fights' : 'runs'}`);
}

function stepFight(cb, ctx, secs, dt = 1 / 60) {
  for (let i = 0, n = Math.round(secs / dt); i < n; i++) { cb.update(dt, ctx); ctx.player.combatPose?.(); }
}

test('a modelled body floored by the hook falls from a recording, lies there, and gets up', () => {
  const T = town();
  const victim = arena(personWho(T, false));
  const body = modelled();
  victim.cit = body;
  const hooks = watchHooks(T.peds);
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);

  assert.deepEqual(rhythm(cb, ctx, 3), ['jab', 'cross', 'hook']);
  assert.equal(hooks.hit.length, 3);
  assert.equal(victim.state, 'ko', 'the hook threw a modelled body instead of flooring it');
  assert.equal(victim.dead, false);
  assert.equal(victim.mesh.rotation.x, 0, 'a recorded fall was also tipped over like a ragdoll');
  assert.equal(victim.free, 1, "a floored body is still the shared schedule's");
  assert.ok(body.roles().includes('hitHead'), 'the jab and the cross did not snap the head');
  assert.ok(body.log.some((e) => e.role === 'hitBack' && e.mask === 'full'), 'the fall is not the whole body');

  // a few seconds on the tarmac, then the recording of getting up, then away
  stepFight(cb, ctx, 3);
  assert.equal(victim.state, 'ko', 'he was up before he had lain there');
  stepFight(cb, ctx, 5);
  assert.ok(body.roles().includes('getUp'), 'he never played getting up');
  assert.equal(victim.state, 'walk', 'he never got back on his feet');
  assert.ok(victim.calm > 0 || victim.speed > 2, 'a man knocked down walked off calmly');
});

test('a knock-out that kills lays the body out where it fell, held on the last frame', () => {
  const T = town();
  const victim = softened(T, arena(personWho(T, false)), 10);
  const body = modelled();
  victim.cit = body;
  const hooks = watchHooks(T.peds);
  const money = purse();
  const cb = new Combat({ peds: T.peds, wallet: money });
  const ctx = facing(victim);
  land(cb, ctx);
  assert.equal(victim.dead, true);
  assert.equal(hooks.killed.length, 1);
  assert.equal(money.paid.length, 1, 'the pocket was not paid on the killing blow');
  stepFight(cb, ctx, 1.2);
  assert.equal(victim.state, 'dead', 'the fall never ended in a corpse');
  const last = body.log[body.log.length - 1];
  assert.equal(last.role, 'hitBack');
  assert.equal(last.hold, true, 'the corpse would stand up a quarter second after the fight let go');
  assert.equal(cb.crowd.list.length, 0, 'the fight kept holding a corpse');
});

test('somebody who fights back squares up, and their punches cost the player health', () => {
  const T = town();
  const victim = arena(personWho(T, true));
  victim.cit = modelled();
  const taken = [];
  const vitals = { damage(n, cause) { taken.push({ n, cause }); } };
  const crimes = [];
  const cb = new Combat({ peds: T.peds, wallet: purse(), vitals });
  cb.onCrime((k, x, z, who) => crimes.push({ k, who }));
  const ctx = facing(victim);
  land(cb, ctx);
  assert.equal(victim.state, 'brawl', 'a man who fights back ran instead');
  assert.equal(victim.brawl, true, 'the wanted rules cannot tell self-defence');
  assert.equal(crimes.length, 1);

  stepFight(cb, ctx, 4);
  assert.ok(taken.length >= 1, "a brawler at arm's length never landed a punch");
  for (const t of taken) {
    assert.ok(t.n >= 4 && t.n <= 10, `one punch cost the player ${t.n}`);
    assert.equal(t.cause, 'pěst');
  }
  assert.equal(crimes.length, 1, 'being hit back was charged to the player');

  // a block facing the punch takes most of it
  const before = taken.length;
  ctx.block = true;
  stepFight(cb, ctx, 4);
  const blocked = taken.slice(before);
  assert.ok(blocked.length >= 1, 'no punch arrived while blocking');
  for (const t of blocked) assert.ok(t.n <= 2, `a blocked punch still cost ${t.n}`);
});

test('a brawler hurt enough runs, and one you walk away from gives up', () => {
  const T = town();
  const a = arena(personWho(T, true));
  a.cit = modelled();
  const cb = new Combat({ peds: T.peds, wallet: purse(), vitals: { damage() {} } });
  const ctx = facing(a);
  land(cb, ctx);
  assert.equal(a.state, 'brawl');
  // softened to 40 by the door, a cross takes him to 24: down (KO_HP); a jab at
  // 40 leaves 28, under the brawler's own limit of 30, and he runs
  softened(T, a, 40);
  idle(cb, ctx, 1.2);
  land(cb, ctx);
  stepFight(cb, ctx, 0.5);
  assert.equal(a.state, 'walk', 'a beaten brawler kept fighting');
  assert.equal(a.brawl, false);

  const T2 = town();
  const b = arena(personWho(T2, true));
  b.cit = modelled();
  const cb2 = new Combat({ peds: T2.peds, wallet: purse(), vitals: { damage() {} } });
  const ctx2 = facing(b);
  land(cb2, ctx2);
  assert.equal(b.state, 'brawl');
  ctx2.player.pos.x += 30;                  // the player walks off
  stepFight(cb2, ctx2, 4);
  assert.equal(b.state, 'walk', 'a brawler followed the player across town');
});

test('a brawler lets go the moment the player cannot be fought', () => {
  const T = town();
  const b = arena(personWho(T, true));
  b.cit = modelled();
  const taken = [];
  const cb = new Combat({ peds: T.peds, wallet: purse(), vitals: { damage(n) { taken.push(n); } } });
  const ctx = facing(b);
  land(cb, ctx);
  assert.equal(b.state, 'brawl');
  ctx.down = true;                          // SEJMUT
  stepFight(cb, ctx, 1);
  assert.equal(b.state, 'walk', 'a brawler kept beating a player who was down');
  assert.equal(cb.takeHit(10, b.x, b.z), null, 'a downed player can still take punches');
});

test('every target source is searched and the nearest body wins', () => {
  const T = town();
  const victim = arena(T.walker());
  const hooks = watchHooks(T.peds);
  // a second source: the driver thrown out of a jacked car, closer than the walker
  const driver = { x: victim.x, z: victim.z + 0.35, state: 'walk', dead: false, hp: 100, mesh: { position: { y: 0 } } };
  const blows = [];
  const jack = {
    nearest(x, z, r, want) { return Math.hypot(driver.x - x, driver.z - z) < r && want(driver) ? driver : null; },
    hurt(p, b) { blows.push(b.dmg); p.hp -= b.dmg; if (p.hp <= 0) p.dead = true; return true; },
  };
  const seen = [];
  const cb = new Combat({ peds: T.peds, targets: [T.peds, jack, null, {}], wallet: purse() });
  cb.onCrime((k, x, z, who) => seen.push(who));
  land(cb, facing(victim));
  assert.deepEqual(blows, [12], 'the nearer body in the other source was not hit');
  assert.equal(hooks.hit.length, 0, 'the farther walker was hit instead');
  assert.equal(seen[0], driver, 'the crime names somebody else');
});

test('every swing is announced once, for the other players to see', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const sent = [];
  cb.onSwing((m) => sent.push(m));
  cb.onSwing((m) => sent.push(m));          // the same listener twice is one
  const other = () => { throw new Error('the relay is down'); };
  cb.onSwing(other);
  const warn = console.warn; console.warn = () => {};
  try { rhythm(cb, facing(victim), 3); } finally { console.warn = warn; }
  assert.equal(sent.length, 6, 'a listener that threw ate the swing, or one listener counted twice');
  assert.equal(cb.stance, true);
});

// The rhythm the way a player mashes it: the next press arrives while the fist
// is still out, is buffered, and cuts the swing short at its chain time. That
// cut is the combo itself, so it has to continue the chain rather than read as
// a cold start (which threw jab, jab, jab in the first build of this).
test('a press while the punch is still out cuts it short and continues the combo', () => {
  const T = town();
  const victim = arena(T.walker());
  const cb = new Combat({ peds: T.peds, wallet: purse() });
  const ctx = facing(victim);
  const moves = [];
  cb.onSwing((m) => moves.push(m));
  cb.update(1 / 120, ctx);
  cb.strike();
  for (let k = 0; k < 3; k++) {
    // well inside the swing, after the fist has gone out
    for (let i = 0; i < 40; i++) { cb.update(1 / 120, ctx); ctx.player.combatPose?.(); }
    assert.equal(cb.busy, true, 'the swing was over before the next press');
    cb.strike();
  }
  for (let i = 0; i < 200; i++) cb.update(1 / 120, ctx);
  assert.deepEqual(moves.slice(0, 3), ['jab', 'cross', 'hook'], 'mashing does not combo');
});

test('a fighter floored by the hook lies there a while before he comes back at you', () => {
  const T = town();
  const victim = arena(personWho(T, true));
  victim.cit = modelled();
  const cb = new Combat({ peds: T.peds, wallet: purse(), vitals: { damage() {} } });
  const ctx = facing(victim);
  const seen = [];
  const watch = (secs) => {
    for (let i = 0, n = Math.round(secs * 60); i < n; i++) {
      cb.update(1 / 60, ctx); ctx.player.combatPose?.();
      const r = cb.crowd.list.find((x) => x.p === victim);
      const tag = victim.state + '/' + (r?.mode ?? '-');
      if (seen[seen.length - 1]?.tag !== tag) seen.push({ tag, t: +cb.now.toFixed(2) });
    }
  };
  land(cb, ctx);
  assert.equal(victim.state, 'brawl');
  // he squares up at arm's length; the player throws the heavy punch
  arena(victim, ctx.player.pos.x, ctx.player.pos.z - RING);
  const r = cb.crowd.list.find((x) => x.p === victim);
  r.nextPunch = Infinity; r.swing = null;   // he does not get his punch in first
  idle(cb, ctx, 0.5);                       // and the player is not still reeling from one
  arena(victim, ctx.player.pos.x, ctx.player.pos.z - RING);
  cb.update(1 / 60, ctx);
  assert.equal(cb.strike('heavy'), true);
  watch(9);
  const tags = seen.map((s) => s.tag);
  assert.ok(tags.includes('ko/fall') && tags.includes('ko/lie') && tags.includes('ko/getup'),
    `the knock-down skipped a beat: ${JSON.stringify(seen)}`);
  const lie = seen.find((s) => s.tag === 'ko/lie'), up = seen.find((s) => s.tag === 'ko/getup');
  assert.ok(up.t - lie.t >= 2.3, `he lay there ${(up.t - lie.t).toFixed(2)} s`);
  assert.equal(seen[seen.length - 1].tag, 'brawl/brawl', `he did not come back at you: ${JSON.stringify(seen)}`);
});

test('a brawler who is never hit back makes his point and walks off', () => {
  const T = town();
  const b = arena(personWho(T, true));
  b.cit = modelled();
  let taken = 0;
  const cb = new Combat({ peds: T.peds, wallet: purse(), vitals: { damage(n) { taken += n; } } });
  const ctx = facing(b);
  land(cb, ctx);
  assert.equal(b.state, 'brawl');
  stepFight(cb, ctx, 13);
  assert.equal(b.state, 'walk', 'he kept beating a man who never hit back');
  assert.ok(taken > 0 && taken < 60, `standing still cost the player ${taken} before he gave up`);
});

// Review, 25 Nov 2026: a brawler floored by the hook who gets up too hurt to
// go on walked off still carrying p.brawl, the self-defence flag, so the next
// beating anybody gave him was free under the wanted rules (js/crimelaw.js).
// Whoever the fight lets go of is no longer fighting.
test('a brawler who gets up and walks away is no longer fighting, and hitting him again is a crime', () => {
  const T = town();
  const victim = arena(personWho(T, true));
  victim.cit = modelled();
  const cb = new Combat({ peds: T.peds, wallet: purse(), vitals: { damage() {} } });
  const crimes = [];
  cb.onCrime((k, x, z, who) => crimes.push({ k, brawl: !!who?.brawl }));
  const ctx = facing(victim);
  land(cb, ctx);
  assert.equal(victim.state, 'brawl');
  assert.equal(victim.brawl, true);
  // hurt enough that the hook floors him and he will not come back at you
  softened(T, victim, 45);
  const r = cb.crowd.list.find((x) => x.p === victim);
  r.nextPunch = Infinity; r.swing = null;
  idle(cb, ctx, 0.5);
  arena(victim, ctx.player.pos.x, ctx.player.pos.z - RING);
  cb.update(1 / 60, ctx);
  assert.equal(cb.strike('heavy'), true);
  let rose = false;
  for (let i = 0; i < 60 * 10 && !rose; i++) {
    cb.update(1 / 60, ctx); ctx.player.combatPose?.();
    rose = victim.state === 'walk';
  }
  assert.ok(rose, `he never got up: still '${victim.state}'`);
  assert.ok(victim.hp > 0 && victim.hp <= 30, `the setup missed: he got up with ${victim.hp}`);
  assert.equal(victim.brawl, false, 'he walked off still flagged as fighting you');
  assert.equal(cb.crowd.list.some((x) => x.p === victim), false, 'the fight kept a record of him');
  // and the next punch on him is charged as a brawl the player started
  const before = crimes.length;
  arena(victim, ctx.player.pos.x, ctx.player.pos.z - RING);
  idle(cb, ctx, 1);
  arena(victim, ctx.player.pos.x, ctx.player.pos.z - RING);
  land(cb, ctx);
  assert.equal(crimes.length, before + 1, 'the punch was not a crime at all');
  assert.equal(crimes[crimes.length - 1].brawl, false, 'a later attack on him read as self-defence');
});

// Review, 25 Nov 2026: the left button and Q punched through a story film, the
// ZATČEN and chapter cards and the open big map. main.js decides WHY (its
// fistsTaken and fistsBusy); combat.js owns what the two flags mean, and that
// is what is pinned here: `down` is a player nobody can fight, `hold` is hands
// that belong to the UI for now while the street goes on around him.
test('no swing starts while the player is not his own or his hands are the UI\'s', () => {
  for (const flag of ['down', 'hold']) {
    const T = town();
    const victim = arena(T.walker());
    const hooks = watchHooks(T.peds);
    const cb = new Combat({ peds: T.peds, wallet: purse() });
    const ctx = facing(victim);
    const swings = [];
    cb.onSwing((m) => swings.push(m));
    cb.update(1 / 120, ctx);
    ctx[flag] = true;
    cb.update(1 / 120, ctx);
    assert.equal(cb.strike('light'), false, `${flag}: the left button punched`);
    assert.equal(cb.strike('heavy'), false, `${flag}: Q punched`);
    ctx.input = { keys: new Set(), attackHeld: true };      // the button held down
    stepFight(cb, ctx, 1, 1 / 120);
    assert.deepEqual(swings, [], `${flag}: a held button punched`);
    assert.equal(hooks.hit.length, 0);
    // and nothing pressed meanwhile is thrown the moment the hands come back
    ctx[flag] = false;
    ctx.input = { keys: new Set(), attackHeld: false };
    stepFight(cb, ctx, 0.5, 1 / 120);
    assert.deepEqual(swings, [], `${flag}: a press from under the ${flag} was kept for later`);
    assert.equal(land(cb, ctx), true, `${flag}: the fists never came back`);
    assert.deepEqual(swings, ['jab']);
  }
});

test('a brawler keeps at a player looking at the map, and lets go of one who is not his own', () => {
  for (const [flag, stays] of [['hold', true], ['down', false]]) {
    const T = town();
    const b = arena(personWho(T, true));
    b.cit = modelled();
    const cb = new Combat({ peds: T.peds, wallet: purse(), vitals: { damage() {} } });
    const ctx = facing(b);
    land(cb, ctx);
    assert.equal(b.state, 'brawl');
    ctx[flag] = true;
    stepFight(cb, ctx, 1);
    assert.equal(b.state === 'brawl', stays, `${flag}: the brawler ${stays ? 'gave up' : 'kept fighting'}`);
  }
});
