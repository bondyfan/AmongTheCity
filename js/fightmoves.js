// ==========================================================================
// fightmoves.js: the punches, what they cost, and what they do to a body
//
// Pure tables and pure functions: no three.js, no DOM, no clock of its own.
// js/combat.js (the player's fists), js/fightpeds.js (what a punched
// pedestrian does about it) and tests/fightmoves.test.mjs all read the same
// numbers from here, so a punch cannot cost one thing to the player and
// another to the crowd.
//
// ---- THE MOVES ARE THE RECORDINGS ----------------------------------------
//
// Frank, 25 Nov 2026: the old left click "strčí, ale nebouchne to jako pěstí".
// A punch is now a recorded punch (Quaternius UAL, scripts/people/bake-fight.mjs)
// and every number below that says WHEN was measured off the recording on a
// Rocketbox body, in the clip's own seconds (the probe: the fist's distance in
// front of the chest, frame by frame):
//
//     jab    left fist out from 0.14, furthest at 0.22, back by 0.58 of 0.87 s
//     cross  right fist out from 0.20, furthest 0.25..0.50, back by 0.83 of 1.00
//     hook   a heavy step-in, right fist through the target at 0.23..0.31 of
//            0.47, then a recovery clip of 0.60 back to the guard
//
// `speed` plays a clip faster than recorded (GTA punches are snappy; the
// library's are a touch theatrical). The damage window is [open, shut] of the
// CLIP's seconds, so it follows the fist whatever the speed. `chain` is the
// moment the next press may cut the rest of the swing short: a combo flows
// from the extended fist into the next punch instead of waiting for the arm
// to come all the way home.
//
// ---- THE LADDER, AND WHY THESE NUMBERS -----------------------------------
//
// A pedestrian has 100 HP (js/pedestrians.js PED_HP), the player the same 100
// (js/vitals.js). Three presses in rhythm are jab, cross, hook:
//
//     jab 12 + cross 16 + hook 32 = 60, and the hook puts them on the ground
//
// Down, not dead: they lie a few seconds and get up (to run, or to come back
// at you). A second combo takes them to 12 or below, and any blow that leaves
// somebody at KO_HP or less floors them again; the third time there is nothing
// left. About seven punches kill a healthy man, which is GTA's order of
// magnitude and a long way from the old three (34, 34, 40) that made every
// shove a funeral. A body a car already clipped dies sooner, as it should.
//
// ---- WHAT A BLOW DOES TO THE BODY ----------------------------------------
//
//     'flinch'   the head snaps (a recorded hit to the head or chest) and they
//                keep their feet: every jab and cross that does not floor them
//     'down'     knocked flat (Hit_Knockback), a few seconds on the ground,
//                then up again (LayToIdle): the hook, or any blow to KO_HP
//     'dead'     knocked flat and staying there
//
// ---- WHO HITS BACK -------------------------------------------------------
//
// GTA's crowd does not all run. A share of the people you hit put their fists
// up instead, and which share is a pure function of who they are (their pid
// and their archetype), so the same man always reacts the same way and a test
// can name one who fights. Children are not in the crowd; the oldest never
// fight, a woman rarely does, a man of thirty about every other time.
// ==========================================================================

export const MOVES = Object.freeze({
  jab: Object.freeze({
    key: 'jab', role: 'fightJab', hand: 'L', speed: 1.35,
    open: 0.17, shut: 0.40, chain: 0.40, end: 0.80,
    dmg: 12, reach: 1.45, react: 'flinch', hit: 'hitHead', blood: 0, sfx: 'light',
  }),
  cross: Object.freeze({
    key: 'cross', role: 'fightCross', hand: 'R', speed: 1.45,
    open: 0.22, shut: 0.55, chain: 0.55, end: 0.92,
    dmg: 16, reach: 1.5, react: 'flinch', hit: 'hitHead', blood: 0.3, sfx: 'light',
  }),
  hook: Object.freeze({
    key: 'hook', role: 'fightHook', rec: 'fightHookRec', recDur: 0.60, hand: 'R', speed: 1.2,
    open: 0.23, shut: 0.34, chain: 0.80, end: 1.07,
    dmg: 32, reach: 1.75, react: 'down', hit: 'hitChest', blood: 0.45, sfx: 'heavy',
  }),
});

/** Three presses in rhythm: jab, cross, then the hook that ends it. */
export const LIGHT_CHAIN = Object.freeze(['jab', 'cross', 'hook']);

// A press this long after the last swing ENDED still continues the chain; a
// later one starts again at the jab. GTA's rhythm: you keep tapping, or you
// start over.
export const CHAIN_GAP = 0.45;
// Anybody left at this or less by any blow goes down.
export const KO_HP = 25;
// How long the fight stance lasts after the last thing that happened in it (a
// swing, a hit taken, a block): long enough to circle somebody, short enough
// that walking off puts the hands down.
export const STANCE_T = 4.5;

/** Real seconds a move lasts at its speed, recovery included. */
export function moveDur(m) { return m.end / m.speed; }

/**
 * Which move the next press throws. `kind` is 'light' (left click) or
 * 'heavy' (Q); `step` is how far into the light chain the fighter is (0, 1,
 * 2), `gap` the seconds since the last swing ended (Infinity if none).
 * Returns { move, step } where `step` is the chain position AFTER this press.
 */
export function nextMove(kind, step, gap) {
  if (kind === 'heavy') return { move: MOVES.hook, step: 0 };
  const s = gap <= CHAIN_GAP && step > 0 && step < LIGHT_CHAIN.length ? step : 0;
  const key = LIGHT_CHAIN[s];
  return { move: MOVES[key], step: (s + 1) % LIGHT_CHAIN.length };
}

/**
 * What a landed blow does. hpBefore is the victim's health before it, dmg
 * what it takes off. Returns 'flinch' | 'down' | 'dead'.
 */
export function reactionFor(move, hpBefore, dmg = move.dmg) {
  const after = hpBefore - dmg;
  if (!(after > 0)) return 'dead';
  if (move.react === 'down' || after <= KO_HP) return 'down';
  return 'flinch';
}

/**
 * Where the clip of a move is `t` real seconds after it started: the role to
 * play and the clip's own time. The hook is two recordings back to back (the
 * swing and the recovery).
 */
export function movePose(m, t, out = {}) {
  const ct = (t > 0 ? t : 0) * m.speed;
  if (m.rec) {
    const swing = m.end - m.recDur;
    if (ct > swing) { out.role = m.rec; out.t = ct - swing; return out; }
  }
  out.role = m.role; out.t = ct;
  return out;
}

/** True while the move's damage window is open, `t` real seconds in. */
export function inWindow(m, t) {
  const ct = t * m.speed;
  return ct >= m.open && ct <= m.shut;
}

// ---- who hits back --------------------------------------------------------

// Byte-identical to the hash in js/pedestrians.js, js/combat.js and the rest
// of the deterministic layers (see js/combat.js for why it is duplicated).
function hash32(a, b = 0) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < 6; i++) {
    let k = (i === 0 ? a : i === 1 ? b : 0) | 0;
    k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}
const S_FIGHT = 0xca61;       // the 0xca5x/0xca6x block is the fight's (js/combat.js)

// The share of each archetype (js/people.js) that fights back.
export const FIGHT_SHARE = Object.freeze({ m30: 0.5, m60: 0.25, f30: 0.15, f60: 0.04, m90: 0 });

/** Does this person put their fists up when you hit them? Pure in (pid, arch). */
export function fightsBack(pid, arch) {
  const share = FIGHT_SHARE[arch] ?? 0.2;
  if (!(share > 0)) return false;
  const id = Number.isInteger(pid) ? pid : 0;
  return ((hash32(id, S_FIGHT) >>> 8) / 16777216) < share;
}

// ---- a pedestrian's own punches ------------------------------------------

/** What a brawling pedestrian's punch costs the player, and how a block takes it. */
export const PED_PUNCH = Object.freeze({
  jab: { dmg: 5, speed: 0.95 },
  cross: { dmg: 7, speed: 0.95 },
  reach: 1.45,           // m, centre to centre
  arcCos: 0.55,          // they have to be roughly facing you
  blockK: 0.2,           // a block lets this much through
  blockCos: 0.34,        // …if you face within 70 degrees of the punch
  gap: [1.3, 2.2],       // seconds between their punches
  // A man who has made his point: this long since YOU last hit him and he
  // lets it go. Without it a player who stands and takes it is beaten flat
  // (measured: about seventeen seconds of standing still in the first build).
  satisfied: 10,
});

/**
 * What a punch thrown at the player does: { dmg, blocked }. `facing` is the
 * cosine between the player's facing and the direction to the attacker.
 */
export function playerTakes(dmg, blocking, facing) {
  const blocked = !!blocking && facing >= PED_PUNCH.blockCos;
  return { dmg: blocked ? Math.round(dmg * PED_PUNCH.blockK) : dmg, blocked };
}

// ---- the brawler's mind ----------------------------------------------------

/**
 * One decision of a pedestrian who is fighting you. Pure: everything it needs
 * is handed in. Returns 'approach' | 'hold' | 'back' | 'punch' | 'quit' | 'flee'.
 *   dist     metres to the player, centre to centre
 *   hp       their health
 *   ready    true when their next punch is due and none is running
 *   away     seconds the player has been out of reach (> 8 m)
 *   fought   seconds since this fight began
 *   calm     seconds since the player last hit THIS person
 *   gone     the player cannot be fought (in a car, dead, through a door)
 */
export function brawlStep({ dist, hp, ready, away, fought, calm = 0, gone }) {
  if (gone) return 'quit';
  if (hp <= 30) return 'flee';
  if (away > 2.5 || fought > 45 || calm > PED_PUNCH.satisfied) return 'quit';
  if (dist > 1.3) return 'approach';
  if (dist < 0.75) return 'back';
  return ready ? 'punch' : 'hold';
}
