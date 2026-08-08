// ---- Wanted: one scalar, five thresholds, and the ways it ships broken -----
//
// js/wanted.js imports nothing — not three.js, not the clock, not the DOM — so
// the whole of the star ladder is plain arithmetic over plain data and gets
// checked like js/chatter.js and js/fuel.js are checked: in a bare node process
// with no city on disk. That is not a happy accident of the file, it is the
// property that makes this file possible, and the first assertion below is
// really "it still imports alone".
//
// These tests are not a transcription of wanted.js. Every one of them exists
// because an adversarial read of the DESIGN found a way the feature can be
// wrong that SHIPS — that is, wrong in a way where nothing throws, nothing
// logs, and the only symptom is a player saying the police feel odd:
//
//   1. ONE CORPSE, THREE CRIMES. js/pedestrians.js fires onPedHit AND
//      onPedKilled on the same lethal frame (pedestrians.js:1193-1194), and a
//      fatal punch adds combat's own 'rvacka' on top. Wire each to its own
//      add() and one dead man buys 108 heat instead of 52 — four stars for
//      something the design prices at two. Nothing about that looks like a bug
//      from inside any one of the three modules.
//   2. A FLICKERING STAR. Heat spends most of its life sitting ON a threshold,
//      because the last crime is what put it there and decay is slow. Without
//      hysteresis a player at the two-star line trades punches and toggles the
//      edge a dozen times — and js/police.js spawns a pursuit on that edge, so
//      twelve toggles is twelve sets of cars appearing and vanishing at the end
//      of the street. The HUD flicker is the cheap half of that bug.
//   3. DECAY THAT RUNS WHILE THEY HAVE YOU. If heat bleeds while a patrol is
//      sat on your bumper, hiding is not a mechanic and the doorway off
//      Sladkovského is scenery. The condition is the feature.
//   4. A WANTED LEVEL THE POLICE CANNOT REACH. This is the silent one and it is
//      the reason for the timing band below. Patrol density near the player is
//      about one slot inside TRAFFIC.spawnR (520 m), which is forty to sixty
//      seconds of driving. Halve CALM or T_SHED "for feel" and the star clears
//      before the first unit arrives: the pursuit becomes dead code, every test
//      still passes, and the symptom is that the police never turn up. So the
//      time from one star to clear is asserted against a stated band, and the
//      four escapes wanted.js's own header publishes are re-derived here from
//      the file's own constants and checked against what the code does.
//   5. A POISONED SCALAR. One NaN in `heat` and every comparison in the ladder
//      answers false forever: no stars, no decay, no way back inside a session.
//   6. A COUNTDOWN NOBODY TICKS. Every deadline in wanted.js is absolute
//      against its own stepped clock. The way that rots is main.js's substep
//      loop — stepGame runs up to three times per rendered frame — so the
//      substep tests are not tidiness, they are the shape of the real caller.
//
// A NOTE ON THE SINGLETON. wanted.js is module-level state on purpose (one
// player per tab) and onStars has no unsubscribe, exactly like wallet.js and
// vitals.js and for the same reasons their headers give. So the recorders here
// are subscribed ONCE at module load and read through arrays that get emptied
// rather than replaced, and every test opens with fresh(). The two tests that
// must install their own listener (the throwing one, the ignore-junk one) are
// written to be inert for every test after them.
//
// A NOTE ON THE NUMBERS. STAR_AT, HYST, T_SHED and the rest are private to
// wanted.js — correctly, nothing outside a debug overlay should read them — so
// this file PARSES them out of the source the way tests/economy.test.mjs parses
// CAR_KINDS out of vehicles.js. The parse asserts its own success first, so a
// renamed constant fails loudly instead of quietly testing zero. Everything
// derived below (the drop lines, the per-band rates, the reference integrator)
// is computed from those numbers rather than typed, so re-tuning the ladder
// re-tunes the expectations with it and only the DESIGN bands — the ones that
// say the police must be reachable — are written down as literals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import wanted, * as W from '../js/wanted.js';

// ------------------------------------------------------------- constants ----

const SRC = readFileSync(new URL('../js/wanted.js', import.meta.url), 'utf8');

function konst(name) {
  const m = new RegExp('^const ' + name + '\\s*=\\s*(-?[\\d.]+)\\s*;', 'm').exec(SRC);
  assert.ok(m, `could not read ${name} out of js/wanted.js — the parse, not the module, is broken`);
  return Number(m[1]);
}

const STAR_AT = (() => {
  const m = /^const STAR_AT = Object\.freeze\(\[([^\]]*)\]\)/m.exec(SRC);
  assert.ok(m, 'could not read STAR_AT out of js/wanted.js');
  const a = m[1].split(',').map((s) => Number(s.trim()));
  assert.equal(a.length, 6, `STAR_AT parsed as ${a.length} entries`);
  return a;
})();

const HEAT_MAX = konst('HEAT_MAX');
const HYST = konst('HYST');
const T_SHED = konst('T_SHED');
const CALM = konst('CALM');
const SEEN_HOLD = konst('SEEN_HOLD');
const COINCIDE = konst('COINCIDE');
const SEE_R_FOOT = konst('SEE_R_FOOT');
const SEE_R_CAR = konst('SEE_R_CAR');
const INSIDE_K = konst('INSIDE_K');
const LOCK_R = konst('LOCK_R');
const SIGHT_HZ = konst('SIGHT_HZ');
const DT_MAX = konst('DT_MAX');
const UNKNOWN_HEAT = W.CRIMES.rvacka.heat;   // wanted.js derives it the same way

// The two derived tables, derived here the way the module derives them. If
// these two loops and the module's two loops ever disagree, every timing
// assertion in this file is measuring the test rather than the code — which is
// why the drop lines are ALSO recovered from observed behaviour further down.
const DROP_AT = new Float64Array(6);
const RATE = new Float64Array(6);
for (let s = 1; s <= 5; s++) {
  const band = STAR_AT[s] - STAR_AT[s - 1];
  DROP_AT[s] = STAR_AT[s] - HYST * band;
  RATE[s] = band / T_SHED;
}
RATE[0] = RATE[1];

// ---------------------------------------------------------------- harness ----

// Subscribed once, for the life of the process — wanted.js has no unsubscribe
// (its header explains why: main.js registers the police at boot and dropping
// that on a restart leaves a city with no law in it). Tests empty this rather
// than re-subscribing, or the edges would be counted twice from here on.
const LOG = [];
W.onStars((s, prev) => { LOG.push([s, prev]); });

// The two flag-gated listeners, installed here in a fixed ORDER so a test can
// prove a throw does not rob the listener standing behind it. Both are inert
// unless their flag is on, and both flags are restored in a finally.
let BOOM = false;
let AFTER = 0;
W.onStars(() => { if (BOOM) throw new TypeError('the HUD is on fire'); });
W.onStars(() => { AFTER++; });

function fresh() { W.reset(); LOG.length = 0; AFTER = 0; }

// The step main.js's clamp actually produces most frames. Times measured on
// this grid are accurate to one step, which is what the bands allow for.
const STEP = 0.05;

function advance(seconds, ctx = null, step = STEP) {
  const n = Math.round(seconds / step);
  for (let i = 0; i < n; i++) W.update(step, ctx);
}

/** Seconds of stepped clock until `pred()` first reads true, or Infinity. The
 *  accumulation is the module's own (`_now += step` with the same literal), so
 *  the returned time and the module's clock never drift apart. */
function timeUntil(pred, ctx = null, cap = 900, step = STEP) {
  let t = 0;
  while (t < cap) { W.update(step, ctx); t += step; if (pred()) return t; }
  return Infinity;
}

// The smallest thing that looks like a police unit. Two shapes because
// wanted.js supports both: a car directly, or a record that wraps one.
function cop(x, z, sees = false) { return { x, z, sees }; }
function copCar(x, z, sees = false) { return { car: { x, z }, sees }; }

// One reusable ctx per test, mutated rather than replaced — the same discipline
// the per-frame path in the module keeps, and it means these tests exercise the
// object identity main.js actually hands over.
function scene(units, onFoot = true) {
  return { x: 0, z: 0, onFoot, car: null, police: { units } };
}

// ---- the reference the timing band is measured against ---------------------
// An independent integration of the same model: from `h` heat at the moment of
// the charge, unseen for ever after, how long until stars() reads `to`. Written
// out rather than reusing the module so that a change to the module's loop
// cannot silently move the expectation with it.
function ladderOf(h) {
  let s = 0;
  while (s < 5 && h >= STAR_AT[s + 1]) s++;
  return s;
}
function hideTime(h, to = 0) {
  let s = ladderOf(h), t = CALM;
  while (s > to) { t += (h - DROP_AT[s]) / RATE[s]; h = DROP_AT[s]; s--; }
  return t;
}
function zeroTime(h) { return hideTime(h, 0) + DROP_AT[1] / RATE[0]; }

// One step's worth of decay, which is the measurement granularity of every
// timing assertion below, plus the half-step the calm window is detected early
// by (decay applies on the first step whose END is past the deadline).
const SLOP = 0.25;

// ==========================================================================
// THE LADDER — where the stars are, and where they are not
// ==========================================================================

test('the module still stands up alone, and the ladder is a ladder', () => {
  // Nothing was imported to get here. That is the assertion.
  assert.equal(typeof W.update, 'function');
  for (let s = 1; s <= 5; s++) {
    assert.ok(STAR_AT[s] > STAR_AT[s - 1], `STAR_AT[${s}] does not rise`);
    // A drop line must sit INSIDE its own band. Below the band floor and losing
    // a star would drop you two at once; at or above the rise line and there is
    // no hysteresis at all, only a threshold with extra arithmetic.
    assert.ok(DROP_AT[s] < STAR_AT[s], `star ${s} is lost exactly where it is won`);
    assert.ok(DROP_AT[s] > STAR_AT[s - 1], `star ${s} is lost below the band it lives in`);
    assert.ok(RATE[s] > 0, `star ${s} sheds at ${RATE[s]}/s`);
  }
  assert.equal(STAR_AT[0], 0);
  assert.ok(HEAT_MAX > STAR_AT[5], 'the cap is under the five-star line, so five stars is unreachable');
  assert.ok(COINCIDE > DT_MAX, 'the incident window is narrower than one clamped step');
  assert.ok(SEEN_HOLD * SIGHT_HZ >= 8, 'a sighting can fall between two sight scans');
});

test('every crime is a row with a Czech noun and a price', () => {
  const rows = Object.values(W.CRIMES);
  assert.ok(rows.length >= 6, `${rows.length} crimes is not a ladder`);
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, 'two rows share a key');
  assert.equal(new Set(rows.map((r) => r.noun)).size, rows.length, 'two rows share a noun');
  for (const r of rows) {
    assert.ok(Number.isFinite(r.heat) && r.heat > 0, `${r.key} is worth ${r.heat}`);
    assert.ok(r.heat <= STAR_AT[3], `${r.key} alone is worth three stars`);
    assert.ok(typeof r.noun === 'string' && r.noun.length > 0, `${r.key} has no HUD noun`);
    assert.throws(() => { r.heat = 0; }, TypeError, `${r.key} is writable — a discount in a handler is global and permanent`);
  }
  assert.throws(() => { W.CRIMES.rvacka = null; }, TypeError, 'the crime table is writable');
});

test('a star is won exactly at its threshold and not a point before', () => {
  for (let s = 1; s <= 5; s++) {
    fresh();
    W.add(STAR_AT[s] - 0.001);
    assert.equal(W.stars(), s - 1, `${STAR_AT[s] - 0.001} heat already reads ${s} stars`);
    fresh();
    W.add(STAR_AT[s]);
    assert.equal(W.stars(), s, `${STAR_AT[s]} heat reads ${W.stars()} stars, not ${s}`);
  }
  // …and nothing above the top of the ladder exists.
  fresh();
  W.add(1e9);
  assert.equal(W.stars(), 5);
  assert.equal(W.heat(), HEAT_MAX, 'the cap did not hold against an absurd charge');
  advance(1);
  W.add(1e9);
  assert.equal(W.heat(), HEAT_MAX, 'ten minutes of rampage banks an hour of decay');
  assert.equal(W.stars(), 5);
});

// The drop lines RECOVERED from behaviour rather than read off the constants,
// so the derived table at the top of this file cannot quietly agree with itself
// while disagreeing with the module.
test('a star is lost well below where it was won, one at a time', () => {
  for (let s = 1; s <= 5; s++) {
    fresh();
    W.add(STAR_AT[s] + 0.5);
    assert.equal(W.stars(), s);
    let t = 0;
    while (W.stars() === s && t < 600) { W.update(STEP, null); t += STEP; }
    assert.equal(W.stars(), s - 1, `star ${s} fell to ${W.stars()} — two rungs in one step`);
    // Below the line by at most one step's decay, and never above it.
    assert.ok(W.heat() < DROP_AT[s] + 1e-9, `star ${s} was lost at ${W.heat()}, above its drop line ${DROP_AT[s]}`);
    assert.ok(DROP_AT[s] - W.heat() < RATE[s] * STEP + 1e-9,
      `star ${s} was lost at ${W.heat()}, well under its drop line ${DROP_AT[s]}`);
  }
});

// The ladder the header argues for, in the units the player experiences it in.
// These are the sentences the crime table was tuned to produce, and moving one
// heat figure without the other silently re-tunes all of them.
test('the sentences the crime table was tuned to hand down', () => {
  const seq = (...crimes) => {
    fresh();
    for (const c of crimes) { W.add(c); advance(COINCIDE * 2); }
    return W.stars();
  };
  assert.equal(seq('rvacka'), 1, 'one punch is not a nuisance');
  assert.equal(seq('rvacka', 'rvacka'), 1, 'a second punch is already a spree');
  assert.equal(seq('rvacka', 'rvacka', 'rvacka'), 2, 'a man who will not stop hitting people is still a nuisance');
  assert.equal(seq('kradez'), 1, 'taking a car is more than one star');
  assert.equal(seq('srazeni'), 1, 'stopping after you knock a man down costs two stars');
  assert.equal(seq('srazeni', 'ujeti'), 2, 'driving away from it costs the same as stopping — a whole mechanic gone');
  assert.equal(seq('srazeni', 'srazeni'), 2);
  assert.equal(seq('zabiti'), 2, 'a killing is not two stars on the spot');
  assert.equal(seq('naraz'), 2, 'ramming a patrol car off a clean record is not two stars');
  assert.equal(seq('zabiti', 'zabiti', 'zabiti'), 4);
  assert.equal(seq('zabiti', 'zabiti', 'zabiti', 'zabiti'), 5, 'a spree of four is not the maximum');
});

// ==========================================================================
// ONE DEAD PEDESTRIAN IS ONE CRIME
// ==========================================================================

// THE ONE THAT MATTERS. pedestrians.js:1193-1194 fires both callbacks on the
// same lethal frame, and the combat refactor adds a third for a fatal punch.
// Wire each to its own add() and the ladder charges the sum. Note there is no
// update() between the calls here, because there is none in the real caller
// either: they arrive inside one _launch().
test('a lethal hit is one crime however many callbacks announce it', () => {
  const KILL = W.CRIMES.zabiti.heat;

  // hit, then kill — the order pedestrians.js actually fires them in
  fresh();
  assert.equal(W.add('srazeni'), W.CRIMES.srazeni.heat, 'the hit was not charged');
  const mid = W.heat();
  assert.equal(W.add('zabiti'), KILL - W.CRIMES.srazeni.heat, 'the kill was charged in full on top of the hit');
  assert.ok(W.heat() >= mid, 'heat DIPPED through the merge — that crosses a drop line and fires a phantom edge');
  assert.equal(W.heat(), KILL, `one corpse cost ${W.heat()} heat, not ${KILL}`);
  assert.equal(W.stars(), 2, `one corpse bought ${W.stars()} stars`);
  assert.equal(W.lastCrime(), W.CRIMES.zabiti.noun, 'the HUD is naming the lesser crime');

  // The edge, which is the half a pursuit spawner listens on. The incremental
  // charge climbs the ladder in TWO rungs inside the one frame — 34 is one star
  // and 52 is two — and that is fine and is the point: both edges go UP, so a
  // spawner sees a pursuit created and then escalated, never created and torn
  // down. The rejected design is what this asserts against: charging by
  // REPLACING the incident's heat rather than adding the difference would dip
  // the scalar between the two callbacks, and a dip through DROP_AT is a
  // down-edge — a pursuit spawned and despawned inside a single lethal frame.
  assert.ok(LOG.length >= 1, 'one corpse raised no pursuit at all');
  for (const [s, p] of LOG) assert.ok(s > p, `the merge announced a stand-down (${p} -> ${s}) mid-corpse`);
  assert.deepEqual(LOG[LOG.length - 1], [2, 1], 'the merge did not finish at two stars');

  // kill, then hit — the same total, one edge, and the label does not slide down
  fresh();
  assert.equal(W.add('zabiti'), KILL);
  assert.equal(W.add('srazeni'), 0, 'a lesser echo was charged');
  assert.equal(W.heat(), KILL);
  assert.equal(W.lastCrime(), W.CRIMES.zabiti.noun, 'the label slid down to the lesser crime');
  // The heaviest charge arriving first is the cheap case: one edge, straight to
  // two. The pair above and this one must reach the SAME place, which is what
  // "the order of the callbacks does not matter" means.
  assert.deepEqual(LOG, [[2, 0]], 'a lesser echo moved the star');

  // a fatal PUNCH: combat's own 'rvacka' plus both pedestrian callbacks
  fresh();
  W.add('rvacka');
  W.add('srazeni');
  W.add('zabiti');
  assert.equal(W.heat(), KILL, `a fatal punch cost ${W.heat()} heat across three callbacks`);
  assert.equal(W.stars(), 2);

  // an echo of an echo, and a fourth source arriving in the same breath
  fresh();
  W.add('zabiti');
  for (let i = 0; i < 20; i++) W.add('srazeni');
  W.add('rvacka');
  W.add('ujeti');
  assert.equal(W.heat(), KILL, 'twenty echoes of one corpse cost more than the corpse');
});

// The window deliberately does NOT extend on each arrival: extending it would
// merge a car dragging through a crowd into one charge. This is the assertion
// that keeps those two cases apart.
test('two people a second apart are two crimes, and the window never stretches', () => {
  fresh();
  W.add('srazeni');
  advance(1);
  W.add('srazeni');
  assert.equal(W.heat(), W.CRIMES.srazeni.heat * 2, 'two people a second apart were merged into one incident');
  assert.equal(W.stars(), 2);

  // Three arrivals, each just inside the previous one's window but the third
  // outside the FIRST one's. If the window were extended, the third would be an
  // echo charging nothing.
  fresh();
  W.add('rvacka');
  advance(COINCIDE * 0.75);
  assert.equal(W.add('zabiti'), W.CRIMES.zabiti.heat - W.CRIMES.rvacka.heat, 'the second arrival opened a new incident');
  advance(COINCIDE * 0.75);
  assert.equal(W.add('rvacka'), W.CRIMES.rvacka.heat,
    'the incident window was extended by the second arrival — a massacre is now one crime');
  assert.equal(W.heat(), W.CRIMES.zabiti.heat + W.CRIMES.rvacka.heat);
});

// ==========================================================================
// HYSTERESIS — the star that must not flicker
// ==========================================================================

// js/police.js spawns and despawns a pursuit on this edge. A star that toggles
// on a wobble is cars appearing and vanishing at the end of the street, which
// reads as the world being broken rather than as a HUD glitch. So the test
// counts EDGES, not frames: drive heat back and forth across STAR_AT[2] ten
// times and exactly one edge — the one that got you there — may exist.
test('heat wobbling on a threshold does not flicker the star', () => {
  const LINE = STAR_AT[2];
  fresh();
  W.add(LINE + 1);
  assert.equal(W.stars(), 2);
  assert.deepEqual(LOG, [[2, 0]]);

  for (let i = 0; i < 10; i++) {
    // Past the dispatch window and a little way into the decay: heat crosses
    // BELOW the line it was won at…
    advance(CALM + 2.6);
    assert.ok(W.heat() < LINE, `cycle ${i}: heat ${W.heat()} never got below the threshold, so nothing was tested`);
    assert.equal(W.stars(), 2, `cycle ${i}: the star fell the moment heat dipped under ${LINE}`);
    // …and a punch puts it back above.
    W.add(2.2);
    assert.ok(W.heat() > LINE, `cycle ${i}: heat ${W.heat()} did not get back above the threshold`);
    assert.equal(W.stars(), 2);
  }
  assert.equal(LOG.length, 1, `the star toggled ${LOG.length - 1} extra times — that is ${LOG.length - 1} pursuits`);

  // …and it is not merely stuck: driven properly down it does fall, once, and
  // it announces the fall.
  const t = timeUntil(() => W.stars() === 1);
  assert.ok(Number.isFinite(t), 'the star never came down at all — it is stuck, not hysteretic');
  assert.deepEqual(LOG, [[2, 0], [1, 2]], 'the way down was announced wrong');
  assert.ok(W.heat() < DROP_AT[2], 'the star fell above its own drop line');
  assert.ok(W.heat() > STAR_AT[1], 'the star fell straight past the band below it');
});

// A rampage that crosses two thresholds in one lump is ONE event as far as a
// pursuit spawner is concerned. Two calls would spawn, despawn and re-spawn.
test('a lump that crosses two thresholds is a single edge', () => {
  fresh();
  W.add(STAR_AT[3] + 1);
  assert.equal(W.stars(), 3);
  assert.deepEqual(LOG, [[3, 0]], 'three stars in one charge was announced as three events');

  // and the same on the way down: a step never skips a rung, so five stars
  // coming home is five edges in order, no more and no less.
  fresh();
  W.add(STAR_AT[5]);
  LOG.length = 0;
  timeUntil(() => W.stars() === 0, null, 900);
  assert.deepEqual(LOG, [[4, 5], [3, 4], [2, 3], [1, 2], [0, 1]],
    'the descent from five stars did not announce every rung exactly once');
});

// ==========================================================================
// SEEING, AND NOT SEEING
// ==========================================================================

test('nothing decays while they can see you, however long you sit there', () => {
  fresh();
  W.add('zabiti');
  const h = W.heat();
  const ctx = scene([cop(5, 5)]);
  advance(600, ctx);
  assert.equal(W.heat(), h, `ten minutes under a patrol's nose bled ${(h - W.heat()).toFixed(2)} heat`);
  assert.equal(W.stars(), 2);
  assert.equal(W.seen(), true, 'a car five metres away is not looking at you');
  assert.deepEqual(LOG, [[2, 0]], 'the star moved while the police had eyes on');
});

test('nothing decays inside the dispatch window either, seen or not', () => {
  fresh();
  W.add('zabiti');
  const h = W.heat();
  advance(CALM - 1);
  assert.equal(W.heat(), h, `heat bled ${(h - W.heat()).toFixed(2)} before the dispatch window closed`);
  advance(3);
  assert.ok(W.heat() < h, 'the dispatch window never closed — heat is undecayable');
  // …and every fresh crime re-arms it, so a player under continuous provocation
  // never bleeds at all.
  fresh();
  W.add('rvacka');
  for (let i = 0; i < 12; i++) { advance(CALM - 2); W.add(0.0001); }
  assert.ok(W.heat() >= W.CRIMES.rvacka.heat, 'the calm window did not re-arm on a fresh charge');
});

// The latch is what stops a car weaving across the edge of SEE_R from
// chattering the decay on and off at frame rate. "They had eyes on me four
// seconds ago" is correctly still not clear.
test('the sighting is a latch, not an instant, and it lets go after its hold', () => {
  fresh();
  W.add('zabiti');
  const h = W.heat();
  const near = cop(5, 5);
  const ctx = scene([near]);
  advance(CALM + 5, ctx);
  assert.equal(W.heat(), h, 'heat bled while a patrol was alongside');

  near.x = 5000; near.z = 5000;             // they lose you
  let t = 0;
  while (W.heat() >= h && t < 30) { W.update(STEP, ctx); t += STEP; }
  assert.ok(t > 1, `decay restarted ${t.toFixed(2)} s after they lost you — the latch is not a latch`);
  assert.ok(Math.abs(t - SEEN_HOLD) < 0.5 + 1 / SIGHT_HZ,
    `decay restarted after ${t.toFixed(2)} s, not the ${SEEN_HOLD} s the latch promises`);
  assert.equal(W.seen(), false);
});

test('heat stops at zero and never goes under it', () => {
  fresh();
  W.add('zabiti');
  advance(400);
  assert.equal(W.heat(), 0, `four hundred seconds of hiding left ${W.heat()}`);
  assert.equal(W.stars(), 0);
  assert.ok(!Object.is(W.heat(), -0), 'the floor is negative zero');
  advance(600);
  assert.equal(W.heat(), 0, 'heat went under the floor once it was there');
  assert.equal(W.frac(), 0);
  assert.deepEqual(LOG, [[2, 0], [1, 2], [0, 1]], 'the way down was not announced rung by rung');
});

// The radius IS the abstraction — wanted.js's header spends thirty lines saying
// why it is not a raycast — so the two radii and the lock distance are the
// whole of "they can see you" and are worth pinning at their boundaries.
test('they see further from a car than from the pavement, and only so far on a lock', () => {
  const at = (d, patch) => {
    fresh();
    W.add('zabiti');
    const ctx = scene([cop(d, 0)]);
    Object.assign(ctx, patch);
    advance(1, ctx);
    return W.seen();
  };
  assert.equal(at(SEE_R_FOOT - 0.5, {}), true, `a unit ${SEE_R_FOOT - 0.5} m away cannot see you on foot`);
  assert.equal(at(SEE_R_FOOT + 0.5, {}), false, `a unit ${SEE_R_FOOT + 0.5} m away sees you on foot`);
  // In a car you are four metres long, painted, and making a noise.
  assert.equal(at(SEE_R_CAR - 0.5, { onFoot: false }), true);
  assert.equal(at(SEE_R_CAR + 0.5, { onFoot: false }), false);
  assert.ok(SEE_R_CAR > SEE_R_FOOT, 'a car is no more conspicuous than a pedestrian');

  // A unit's own `sees` flag is real information — police.js knows whether it
  // has locked on — but believed only inside LOCK_R, or a module that set the
  // flag at spawn would make heat undecayable from half a kilometre.
  const lock = (d) => {
    fresh();
    W.add('zabiti');
    advance(1, scene([cop(d, 0, true)]));
    return W.seen();
  };
  assert.equal(lock(LOCK_R - 5), true, `a locked-on unit at ${LOCK_R - 5} m is not believed`);
  assert.equal(lock(LOCK_R + 5), false, `a locked-on unit at ${LOCK_R + 5} m is believed — a wanted level you cannot lose`);
  assert.ok(LOCK_R > SEE_R_CAR, 'the lock is shorter than plain sight, so the flag can never matter');

  // ctx.inside is the one acknowledged cost of the range model turning into a
  // mechanic. Nobody sets it today, which is exactly why it rots silently.
  fresh();
  W.add('zabiti');
  advance(1, Object.assign(scene([cop(SEE_R_FOOT * 0.6, 0)]), { inside: true }));
  assert.equal(W.seen(), false, 'standing indoors did not shrink the radius at all');
  assert.ok(INSIDE_K > 0 && INSIDE_K < 1, 'the indoor multiplier is not a discount');
});

// main.js may hand over the police module or the bare list, and the units in it
// may be cars or records that wrap one. A wanted level that quietly never
// decays because it was handed the wrong shape is not a failure anybody would
// think to look for, and neither is one that never sees anybody.
test('every police shape main.js can hand over is read, and junk in it is skipped', () => {
  const sees = (police, patch = {}) => {
    fresh();
    W.add('zabiti');
    const ctx = { x: 0, z: 0, onFoot: true, police, ...patch };
    advance(1, ctx);
    return W.seen();
  };
  const near = cop(5, 5), far = cop(4000, 4000);

  assert.equal(sees({ units: [near] }), true, 'the module shape was not read');
  assert.equal(sees([near]), true, 'the bare list shape was not read');
  assert.equal(sees(new Set([near])), true, 'a Set of units was not iterated');
  assert.equal(sees({ units: new Set([near]) }), true);
  assert.equal(sees({ units: [copCar(5, 5)] }), true, 'a record wrapping a car was not read');
  assert.equal(sees([far]), false);

  // Nothing to see is not a reason to throw, and neither is rubbish in the list.
  for (const p of [null, undefined, [], { units: [] }, { units: null }, { units: new Set() },
    [null, undefined, {}, { x: NaN, z: 0 }, { car: null }, { x: 'blízko', z: 0 }]]) {
    assert.equal(sees(p), false, `${JSON.stringify(p)} was read as somebody watching you`);
  }
  // A junk unit standing in front of a real one must not shield it.
  assert.equal(sees([null, {}, { x: NaN, z: NaN }, near]), true, 'a junk unit ended the scan early');

  // A player position the world cannot supply fails the range test rather than
  // passing it — an unjudgeable frame is not a sighting.
  assert.equal(sees([near], { x: NaN }), false);
  assert.equal(sees([near], { z: Infinity }), false);
  assert.equal(sees([near], { x: undefined, z: undefined }), false);
});

// At zero stars nobody is looking for you: the scan is skipped, which is the
// only per-frame work in the module and is skipped for almost the whole
// session. The visible consequence is that residue clears even with a patrol
// parked on your bumper, and that is intended rather than tolerated.
test('nobody is looking for you at zero stars, so the residue still clears', () => {
  fresh();
  W.add(STAR_AT[1] - 1);                    // heat, but not a star
  assert.equal(W.stars(), 0);
  const ctx = scene([cop(0, 0)]);
  advance(2, ctx);
  assert.equal(W.seen(), false, 'a patrol was watching a man with a clean record');
  advance(CALM + STAR_AT[1] / RATE[0] + 5, ctx);
  assert.equal(W.heat(), 0, `the residue never cleared under a parked patrol: ${W.heat()}`);
});

// ==========================================================================
// THE TIMING BAND — the police have to be able to get there
// ==========================================================================

// THE ASSERTION THIS FILE EXISTS FOR. Patrol density near the player is about
// one slot inside TRAFFIC.spawnR (520 m, config.js:154); a car covering that at
// a realistic 12 m/s through junctions is forty to sixty seconds away before it
// is even dispatched. Halve CALM or T_SHED for feel and the star clears before
// the first unit arrives — the pursuit becomes dead code, nothing throws, and
// the only symptom is that the police never turn up. These bands are stated in
// seconds of play, deliberately, so that they fail HERE instead of in play.
const PATROL_MIN = 40;      // s — the soonest a dispatched unit can be on you
const PATROL_MAX = 60;      // s — the latest

test('one star outlives the drive the police have to make, and does not become a sentence', () => {
  fresh();
  W.add('rvacka');
  assert.equal(W.stars(), 1);
  const t = timeUntil(() => W.stars() === 0);

  assert.ok(t >= PATROL_MIN,
    `a single punch is over in ${t.toFixed(1)} s — a patrol needs ${PATROL_MIN}-${PATROL_MAX} s to arrive, so nobody ever comes`);
  assert.ok(t <= 75,
    `a single punch keeps you wanted for ${t.toFixed(1)} s — a scuffle is not a manhunt`);
  // …and the same figure against the model, so a change that keeps the band but
  // gets there by a different route is still visible.
  assert.ok(Math.abs(t - hideTime(W.CRIMES.rvacka.heat)) < SLOP,
    `one star cleared in ${t.toFixed(2)} s, not the ${hideTime(W.CRIMES.rvacka.heat).toFixed(2)} the model says`);

  // The heat behind the star takes longer still: the record is not clean the
  // moment the icon goes out, which is what stops a second punch being free.
  fresh();
  W.add('rvacka');
  const tz = timeUntil(() => W.heat() === 0);
  assert.ok(tz > t, 'the scalar hit zero with the star, so there is no residue at all');
  assert.ok(Math.abs(tz - zeroTime(W.CRIMES.rvacka.heat)) < SLOP,
    `the residue cleared in ${tz.toFixed(2)} s, not ${zeroTime(W.CRIMES.rvacka.heat).toFixed(2)}`);
});

// The four escapes wanted.js's header publishes, integrated against the file's
// own constants and checked against what the code actually does.
//
// The header claims all four "clear the 40-60 s a patrol needs to arrive", and
// three of them clear it with room. THE PUNCH DOES NOT: 22 heat is 41.7 s, which
// clears the FAST end of the dispatch band and nothing more, so a punch thrown
// with no unit already nearby is a wanted level that expires while the nearest
// car is still at a junction. That is defensible — a scuffle is meant to be
// something you can walk away from, and 22 was picked so two punches stay under
// two stars — but it is not what the header says, and it is one heat point of
// re-tuning away from being flatly wrong. So the band is asserted per case at
// the honest figure: everything must clear PATROL_MIN, and everything the
// design actually wants a pursuit for must clear PATROL_MAX.
test('the escapes the header publishes are the escapes the code performs', () => {
  const CASES = [
    ['jedna rvačka', ['rvacka'], PATROL_MIN],
    ['jedno zabití', ['zabiti'], PATROL_MAX],
    ['srazil a ujel', ['srazeni', 'ujeti'], PATROL_MAX],
    ['čtyři zabití', ['zabiti', 'zabiti', 'zabiti', 'zabiti'], PATROL_MAX],
  ];
  for (const [name, crimes, floor] of CASES) {
    fresh();
    for (let i = 0; i < crimes.length; i++) {
      W.add(crimes[i]);
      if (i < crimes.length - 1) advance(COINCIDE * 2);
    }
    const h = W.heat();
    const want = hideTime(h);
    const got = timeUntil(() => W.stars() === 0, null, 900);
    assert.ok(Math.abs(got - want) < SLOP,
      `${name}: ${h} heat cleared in ${got.toFixed(2)} s, not the ${want.toFixed(2)} the model says`);
    assert.ok(got > floor,
      `${name}: wanted for only ${got.toFixed(1)} s — the pursuit it is supposed to survive is still driving`);
  }
  // …and the ladder of escapes is itself monotone: a worse crime is never a
  // shorter sentence, which a badly chosen HYST or a per-band rate could break
  // without moving any single figure out of its own band. Non-strict, because
  // 34 + 18 is exactly 52 by construction — driving away from a man you knocked
  // down is DESIGNED to cost precisely what killing him costs, which is the
  // whole reason the 'ujeti' row is worth 18 and not some rounder number.
  let prev = 0;
  for (const [name, crimes] of CASES) {
    fresh();
    for (let i = 0; i < crimes.length; i++) {
      W.add(crimes[i]);
      if (i < crimes.length - 1) advance(COINCIDE * 2);
    }
    const got = timeUntil(() => W.stars() === 0, null, 900);
    assert.ok(got >= prev, `${name} is a shorter sentence than the crime below it`);
    prev = got;
  }
  // …and that identity, said directly rather than inferred from two timings.
  assert.equal(W.CRIMES.srazeni.heat + W.CRIMES.ujeti.heat, W.CRIMES.zabiti.heat,
    'hit-and-run no longer costs exactly what a killing costs — stop or drive away is not a decision any more');
  assert.ok(W.CRIMES.srazeni.heat < STAR_AT[2],
    'stopping after you knock a man down already costs two stars, so there is nothing to gain by stopping');

  // Two stars specifically, because that is the rung a pursuit is worth
  // spawning for and the one the killing figure is quoted against.
  fresh();
  W.add('zabiti');
  const twoStar = timeUntil(() => W.stars() === 1);
  assert.ok(twoStar >= PATROL_MIN,
    `two stars lasted ${twoStar.toFixed(1)} s — the second unit never gets there`);
  assert.ok(Math.abs(twoStar - hideTime(W.CRIMES.zabiti.heat, 1)) < SLOP);

  // THE POINT OF DERIVING THE RATE FROM THE BAND WIDTH. Each band bleeds at
  // (its width / T_SHED), so a star costs the same wall time to shed whichever
  // star it is, even though the fifth band is nearly four times as wide as the
  // first. Measured from the rung's own threshold — which is where a crime that
  // just won you that rung leaves you — losing it again costs HYST × T_SHED
  // seconds of successful hiding, and that figure is a constant of the model.
  const SHED = HYST * T_SHED;
  for (let s = 1; s <= 5; s++) {
    fresh();
    W.add(STAR_AT[s]);
    assert.equal(W.stars(), s);
    const shed = timeUntil(() => W.stars() === s - 1) - CALM;
    assert.ok(Math.abs(shed - SHED) < 0.2,
      `shedding star ${s} took ${shed.toFixed(2)} s of hiding, not ${SHED.toFixed(2)} — the bands no longer cost the same`);
    assert.ok(Math.abs(RATE[s] * T_SHED - (STAR_AT[s] - STAR_AT[s - 1])) < 1e-9,
      `band ${s} does not bleed its own width in ${T_SHED} s`);
  }

  // …and the consequence, which is the reason it was worth deriving: a single
  // typed rate — the first band's, applied everywhere — would make the maximum
  // sentence 208/RATE[1] + CALM, seven minutes of sitting in a doorway. The
  // whole ladder has to stay a handful of one-star sentences long.
  fresh();
  for (let i = 0; i < 4; i++) { W.add('zabiti'); advance(COINCIDE * 2); }
  const flat = CALM + W.heat() / RATE[1];
  const worst = timeUntil(() => W.stars() === 0, null, 900);
  assert.ok(worst < flat * 0.6,
    `five stars is ${worst.toFixed(0)} s against ${flat.toFixed(0)} s flat — the rate is barely derived at all`);
  assert.ok(worst < 300, `five stars is a ${(worst / 60).toFixed(1)}-minute sentence`);
});

// ==========================================================================
// add() — what a wiring mistake is allowed to cost
// ==========================================================================

// Everything a caller might hand add() that is not a crime. This is the same
// list tests/economy.test.mjs keeps for the wallet, and for the same reason:
// Number('') and Number([]) are both 0, so a silent coercion looks exactly like
// a call that never happened.
const CORRUPT = [NaN, Infinity, -Infinity, null, undefined, '', [], {}, true, false,
  [52], { heat: 52 }, () => 52, Symbol.iterator];

test('nothing that is not money-shaped can poison the scalar', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    for (const bad of CORRUPT) {
      fresh();
      const charged = W.add(bad);
      // A broken call may cost at most what an unnamed crime costs — a punch.
      // It may never cost more, and it may never be NaN or Infinity, which is
      // the failure with no way back inside a session.
      assert.ok(Number.isFinite(charged) && charged >= 0 && charged <= UNKNOWN_HEAT,
        `add(${String(bad)}) charged ${charged}`);
      assert.equal(W.heat(), charged, `add(${String(bad)}) moved the scalar by something other than what it reported`);
      assert.ok(Number.isFinite(W.heat()) && W.heat() >= 0 && W.heat() <= HEAT_MAX);
      assert.ok(Number.isInteger(W.stars()) && W.stars() >= 0 && W.stars() <= 5);
      assert.equal(typeof W.lastCrime(), 'string');
      // …and whatever it did, the module still steps and still decays.
      advance(400);
      assert.equal(W.heat(), 0, `add(${String(bad)}) left ${W.heat()} that will not bleed off`);
    }

    // The absurd end of the number line saturates at the cap rather than
    // reaching Infinity — Infinity − anything is how a scalar dies forever.
    fresh();
    for (const n of [1e12, 1e300, Number.MAX_VALUE]) { W.add(n); advance(COINCIDE * 2); }
    assert.equal(W.heat(), HEAT_MAX);
    assert.equal(W.stars(), 5);
  } finally {
    console.warn = warn;
  }
});

test('a negative price is a corrupt price, never a gift and never a charge', () => {
  for (const n of [-1, -0.5, -1e9, -0, 0]) {
    fresh();
    W.add('zabiti');
    const h = W.heat(), s = W.stars(), c = W.lastCrime(), edges = LOG.length;
    assert.equal(W.add(n), 0, `add(${n}) charged something`);
    assert.equal(W.add(n, 'zabiti'), 0, `add(${n}, 'zabiti') fell back to the table price`);
    assert.equal(W.heat(), h, `add(${n}) moved the scalar`);
    assert.equal(W.stars(), s);
    assert.equal(W.lastCrime(), c, `add(${n}) relabelled the HUD`);
    assert.equal(LOG.length, edges, `add(${n}) announced an edge`);
  }
});

// resolve() is deliberately forgiving about order and type, because seven files
// are being wired against this at once and a strict signature turns a spelling
// mistake into a crime that is silently free. Every one of these has to land on
// the same row.
test('a crime by any spelling, in either argument, lands on the same row', () => {
  const SPELLINGS = {
    rvacka: ['rvacka', 'rvačka', 'RVAČKA', 'Rvacka'],
    zabiti: ['zabiti', 'zabití', 'ZABITI', 'Zabití'],
    srazeni: ['srazeni', 'sražení chodce', 'srazeni chodce', 'SRAŽENÍ CHODCE'],
    ujeti: ['ujeti', 'ujetí od nehody', 'ujeti_od_nehody'],
    kradez: ['kradez', 'krádež auta', 'kradezauta', 'krádež_auta'],
    naraz: ['naraz', 'náraz do policie'],
  };
  for (const key in SPELLINGS) {
    const row = W.CRIMES[key];
    for (const s of SPELLINGS[key]) {
      fresh();
      assert.equal(W.add(s), row.heat, `add('${s}') was not priced as ${key}`);
      assert.equal(W.lastCrime(), row.noun, `add('${s}') put "${W.lastCrime()}" on the HUD`);
      // …and in the second position, which is how a caller who has a number
      // already will naturally write it.
      fresh();
      assert.equal(W.add(NaN, s), row.heat, `add(NaN, '${s}') did not fall back to the table`);
      assert.equal(W.lastCrime(), row.noun);
    }
  }

  // The four documented call shapes, spelled out because they are the contract.
  fresh(); assert.equal(W.add(52, 'zabiti'), 52);
  assert.equal(W.lastCrime(), W.CRIMES.zabiti.noun, 'an explicit price lost the HUD noun');
  fresh(); assert.equal(W.add('zabiti', 60), 60, 'a caller price did not win over the table');
  assert.equal(W.lastCrime(), W.CRIMES.zabiti.noun);
  fresh(); assert.equal(W.add(W.CRIMES.zabiti.heat, W.CRIMES.zabiti.noun), W.CRIMES.zabiti.heat);
  // A caller with their own price AND their own label knew what they were
  // doing: 'výtržnictví' for 12 is a legitimate one-off, not a typo.
  fresh(); assert.equal(W.add(12, 'výtržnictví'), 12);
  assert.equal(W.lastCrime(), 'výtržnictví', 'a caller label was not passed through to the HUD');
});

// A name nobody knows still has to COST something — dropping it silently is how
// a whole category of crime turns out to have been free since March — and it
// has to complain, once, so the wiring bug is visible without becoming a
// per-frame console flood.
test('an unknown crime is charged a punch and complained about exactly once', () => {
  const warn = console.warn;
  const said = [];
  console.warn = (...a) => { said.push(a.join(' ')); };
  try {
    fresh();
    assert.equal(W.add('vytrznictvi_nekde'), UNKNOWN_HEAT, 'an unknown crime was free');
    assert.equal(said.length, 1, `an unknown crime warned ${said.length} times`);
    assert.match(said[0], /vytrznictvi_nekde/, 'the warning does not name the crime');
    assert.equal(W.lastCrime(), 'vytrznictvi_nekde', 'the unknown label did not reach the HUD');

    advance(COINCIDE * 2);
    W.add('vytrznictvi_nekde');
    assert.equal(said.length, 1, 'the same wiring bug warned twice — that is a per-frame flood waiting to happen');

    advance(COINCIDE * 2);
    W.add('neco_uplne_jineho');
    assert.equal(said.length, 2, 'a second distinct unknown crime was swallowed');

    // A fresh session gets to hear about its wiring again.
    W.reset();
    W.add('vytrznictvi_nekde');
    assert.equal(said.length, 3, 'reset() did not forget what it had already complained about');
  } finally {
    console.warn = warn;
    fresh();
  }
});

// ==========================================================================
// clear(), reset(), and the edge that goes DOWN
// ==========================================================================

test('clear() stands the pursuit down through the edge it was raised on', () => {
  fresh();
  W.add('zabiti');
  assert.equal(W.stars(), 2);
  assert.deepEqual(LOG, [[2, 0]]);

  W.clear();
  assert.equal(W.heat(), 0);
  assert.equal(W.stars(), 0);
  assert.equal(W.lastCrime(), '', 'the HUD is still naming a crime nobody is wanted for');
  assert.equal(W.seen(), false);
  assert.deepEqual(LOG, [[2, 0], [0, 2]], 'the pursuit was never told to stand down');

  // Clearing a clean record announces nothing — an edge that did not happen
  // would despawn a pursuit that was never spawned.
  W.clear();
  assert.equal(LOG.length, 2, 'clear() on a clean record raised an edge');

  // The open incident goes with it: the first crime after an arrest is charged
  // in full, not swallowed as an echo of the one you were arrested for.
  W.add('zabiti');
  assert.equal(W.heat(), W.CRIMES.zabiti.heat, 'the first crime after a clear was swallowed by a stale incident');
});

test('reset() takes the clock with it, and the sight scan comes back with it', () => {
  fresh();
  W.add('zabiti');
  const ctx = scene([cop(5, 5)]);
  advance(120, ctx);
  assert.equal(W.seen(), true);
  assert.equal(W.stars(), 2);
  LOG.length = 0;

  W.reset();
  assert.deepEqual(LOG, [[0, 2]], 'a new game left a pursuit holding a player who no longer exists');
  assert.equal(W.heat(), 0);
  assert.equal(W.stars(), 0);
  assert.equal(W.lastCrime(), '');
  assert.equal(W.seen(), false, 'the sighting latch survived a new game');
  assert.equal(W.frac(), 0);

  // THE ONE THAT ROTS. reset() zeroes _now; if it did not also zero the scan
  // deadline, that deadline would sit two minutes in the future and the sight
  // scan would never run again for the life of the session — heat would then
  // decay under a patrol's nose and nothing anywhere would report it.
  W.add('zabiti');
  advance(0.5, ctx);
  assert.equal(W.seen(), true, 'the sight scan never ran again after a reset — its deadline outlived the clock');

  // Subscriptions are NOT dropped: main.js registers once at boot.
  const before = LOG.length;
  W.reset();
  assert.ok(LOG.length > before, 'reset() unhooked the listeners — the city has no law in it now');
});

test('frac fills the current star and never runs backwards', () => {
  fresh();
  assert.equal(W.frac(), 0);
  W.add(STAR_AT[1] / 2);
  assert.ok(Math.abs(W.frac() - 0.5) < 1e-9, `half of the first band reads ${W.frac()}`);
  fresh();
  W.add(STAR_AT[5]);
  assert.equal(W.frac(), 1, 'there is something above five stars to fill towards');

  // The hysteresis case: two stars, but heat has fallen back UNDER the line the
  // second star was won at. The bar pins at empty rather than going negative.
  fresh();
  W.add(STAR_AT[2] + 1);
  timeUntil(() => W.heat() < STAR_AT[2]);
  assert.equal(W.stars(), 2);
  assert.equal(W.frac(), 0, `a bar below its own band start reads ${W.frac()}`);
});

// ==========================================================================
// THE SUBSTEP LOOP — main.js clamps to 50 ms and runs stepGame several times
// ==========================================================================

// Decay is linear in dt, so three partial steps must integrate to exactly what
// one whole step does. A rate that were applied per CALL rather than per second
// would triple under a substep loop and nothing would look wrong on screen.
test('three substeps in one frame integrate to one whole step', () => {
  const run = (sub) => {
    fresh();
    W.add('zabiti');
    advance(CALM + 7);                      // a common prelude on a common grid
    const h0 = W.heat();
    for (let f = 0; f < 100; f++) for (let k = 0; k < sub; k++) W.update(0.048 / sub, null);
    return { h0, h: W.heat(), s: W.stars(), edges: LOG.length };
  };
  const one = run(1), three = run(3), five = run(5);
  assert.equal(one.h0, three.h0, 'the prelude itself was not reproducible');
  assert.ok(Math.abs(one.h - three.h) < 1e-9,
    `one 48 ms step left ${one.h}, three 16 ms substeps left ${three.h}`);
  assert.ok(Math.abs(one.h - five.h) < 1e-9);
  assert.equal(one.s, three.s);
  assert.equal(one.edges, three.edges);
  assert.ok(one.h < one.h0, 'the window under test contained no decay at all, so nothing was compared');

  // …and the EDGES are the same sequence whatever the substep count. A drop
  // detected inside a substep must not be announced once per substep.
  const edgeRun = (sub) => {
    fresh();
    W.add('zabiti');
    for (let f = 0; f < 3000; f++) for (let k = 0; k < sub; k++) W.update(STEP / sub, null);
    return LOG.map((e) => e.join('>')).join(',');
  };
  assert.equal(edgeRun(1), '2>0,1>2,0>1');
  assert.equal(edgeRun(3), edgeRun(1), 'a substepped frame announced the descent differently');
  assert.equal(edgeRun(5), edgeRun(1));
});

// The de-duplication window has to survive being measured by a substepped
// clock: COINCIDE is comfortably over main.js's 50 ms clamp precisely so that
// the two pedestrian callbacks are merged even if a substep lands between them.
test('the incident window survives a substep landing between the two callbacks', () => {
  for (const sub of [1, 3, 5]) {
    fresh();
    W.add('srazeni');
    for (let k = 0; k < sub; k++) W.update(0.05 / sub, null);
    assert.equal(W.add('zabiti'), W.CRIMES.zabiti.heat - W.CRIMES.srazeni.heat,
      `${sub} substeps between the two callbacks broke the merge`);
    assert.equal(W.heat(), W.CRIMES.zabiti.heat);
  }
});

// A countdown nobody ticks is a silent bug every test still passes. The other
// half of that is a clock somebody ticks with rubbish: an Infinity that lands
// in _now clears the wanted level instantly and forever, a NaN freezes it and
// nothing ever decays again. So the assertion is two-sided.
test('a corrupt dt neither jumps the clock nor freezes it', () => {
  fresh();
  W.add('rvacka');
  const h = W.heat();
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, -0, undefined, null, '5', [], {}, true]) {
    W.update(bad, null);
    assert.equal(W.heat(), h, `update(${String(bad)}) moved the scalar`);
  }
  advance(CALM - 2);
  assert.equal(W.heat(), h, 'a corrupt dt jumped the clock past the dispatch window');
  advance(30);
  assert.ok(W.heat() < h, 'a corrupt dt froze the clock — nothing will ever decay again');
  assert.ok(Number.isFinite(W.heat()));
});

// THE HIDDEN TAB. A wall clock would let two minutes of alt-tab clear your
// wanted level while the pursuit cars sat frozen, and you would come back clean
// with three Octavias parked around you. The clamp is what stops that, and it
// stops it on a path where nothing throws and nothing logs.
test('alt-tabbing is not an escape route', () => {
  fresh();
  W.add('rvacka');
  const h = W.heat();
  const frames = Math.floor((CALM / DT_MAX) - 4);
  for (let i = 0; i < frames; i++) W.update(1e6, null);
  assert.equal(W.heat(), h,
    `${frames} hidden frames bled ${(h - W.heat()).toFixed(2)} heat — a hidden tab escaped the police`);
  for (let i = 0; i < 200; i++) W.update(1e6, null);
  assert.ok(W.heat() < h, 'the clamp is so tight that time stopped passing altogether');
  assert.ok(W.heat() >= 0);
});

// ==========================================================================
// THE INVARIANTS, under a long shuffle
// ==========================================================================

// Everything above drives one path at a time. This drives all of them at once
// against the properties that must hold at every instant: the scalar is money,
// the star is a function of the scalar ANCHORED on the star before it, the star
// only ever moves in the direction the scalar moved, and every movement is
// announced exactly once with the right pair.
test('the ladder invariant, the monotonicity and the edges survive a long shuffle', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    fresh();
    let seed = 20250807;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const NAMES = ['rvacka', 'zabiti', 'srazeni', 'ujeti', 'kradez', 'naraz', 'neznamy_zlocin'];
    const ctx = scene([cop(4000, 4000)]);

    let lastStars = W.stars(), lastHeat = W.heat(), edges = 0;
    for (let i = 0; i < 40000; i++) {
      const r = rnd();
      if (r < 0.01) W.add(NAMES[(rnd() * NAMES.length) | 0]);
      else if (r < 0.013) W.add(CORRUPT[(rnd() * CORRUPT.length) | 0]);
      else if (r < 0.0135) W.clear();
      else {
        ctx.police.units[0].x = rnd() < 0.4 ? 5 : 4000;
        ctx.onFoot = rnd() < 0.5;
        W.update(0.005 + rnd() * (DT_MAX * 1.5), ctx);
      }

      const h = W.heat(), s = W.stars();
      assert.ok(Number.isFinite(h) && h >= 0 && h <= HEAT_MAX, `step ${i}: heat ${h}`);
      assert.ok(Number.isInteger(s) && s >= 0 && s <= 5, `step ${i}: stars ${s}`);
      // The anchored ladder: rising uses STAR_AT, falling uses DROP_AT, and the
      // gap between them IS the hysteresis. Outside that gap the star is wrong.
      if (s > 0) assert.ok(h >= DROP_AT[s] - 1e-9, `step ${i}: ${s} stars held at ${h}, under the drop line ${DROP_AT[s]}`);
      if (s < 5) assert.ok(h < STAR_AT[s + 1] + 1e-9, `step ${i}: only ${s} stars at ${h}`);
      const f = W.frac();
      assert.ok(f >= 0 && f <= 1, `step ${i}: frac ${f}`);

      // Monotone in heat: a charge never lowers the star, decay never raises it.
      if (h > lastHeat) assert.ok(s >= lastStars, `step ${i}: heat rose to ${h} and the star fell to ${s}`);
      if (h < lastHeat) assert.ok(s <= lastStars, `step ${i}: heat fell to ${h} and the star rose to ${s}`);

      // Exactly one edge per change, with the right pair, and none without one.
      if (s !== lastStars) {
        assert.equal(LOG.length, edges + 1, `step ${i}: the star moved ${lastStars}->${s} with ${LOG.length - edges} edges`);
        assert.deepEqual(LOG[edges], [s, lastStars], `step ${i}: the edge names the wrong pair`);
        edges++;
      } else {
        assert.equal(LOG.length, edges, `step ${i}: an edge fired without the star moving`);
      }
      lastStars = s; lastHeat = h;
    }
    assert.ok(edges > 50, `only ${edges} star changes in 40 000 steps — the shuffle never got going`);
  } finally {
    console.warn = warn;
  }
});

// ==========================================================================
// THE LISTENERS
// ==========================================================================

// One TypeError raised inside stepGame froze co-op on the last drawn frame,
// every frame — vitals.js's header names it and wallet.js has the same guard. A
// HUD that fails to update is a bug; a dead renderer is a dead game.
test('a listener that throws does not take the wanted system with it', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    fresh();
    BOOM = true;
    W.add('zabiti');
    assert.equal(W.stars(), 2, 'a throwing listener un-did the crime');
    assert.equal(W.heat(), W.CRIMES.zabiti.heat, 'the scalar was rolled back by a listener');
    assert.deepEqual(LOG, [[2, 0]], 'the throw robbed the listener in front of it');
    assert.equal(AFTER, 1, 'the throw robbed the listener behind it');

    // …and the module keeps stepping afterwards, which is the half that a
    // try/catch in the wrong place would still get wrong.
    advance(400);
    assert.equal(W.heat(), 0);
    assert.equal(W.stars(), 0);
    // 2>0 on the way up, then 1>2 and 0>1 on the way down: three edges, three
    // deliveries, none of them eaten by the thrower standing in front.
    assert.equal(AFTER, 3, `the descent reached the far listener ${AFTER} times`);
    assert.deepEqual(LOG, [[2, 0], [1, 2], [0, 1]]);
  } finally {
    BOOM = false;                            // inert for every test after this one
    console.warn = warn;
  }
});

test('a non-function subscription is ignored rather than stored', () => {
  fresh();
  for (const junk of [null, undefined, 0, '', 'onStars', {}, []]) W.onStars(junk);
  W.add('zabiti');                           // would throw if any of them were called
  assert.deepEqual(LOG, [[2, 0]]);
  assert.equal(W.stars(), 2);
});

test('the default export and the named exports are the same bindings', () => {
  for (const k of ['CRIMES', 'heat', 'stars', 'frac', 'lastCrime', 'seen', 'add',
    'update', 'clear', 'reset', 'onStars']) {
    assert.ok(k in wanted, `the bundled default is missing ${k}`);
    assert.equal(wanted[k], W[k], `wanted.${k} is not the named export`);
  }
  // Every function is module-level and closes over nothing, so neither import
  // form can lose its binding — `new Police({ wanted })` must work.
  const detached = wanted.stars;
  fresh();
  W.add('zabiti');
  assert.equal(detached(), 2, 'a detached method lost its binding');
});
