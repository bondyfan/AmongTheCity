// The ZATČEN card (js/arrest-card.js, main.js busted and pumpArrest) and the
// two things that may not happen under it (review of 25 Nov 2026):
//   a death on his knees is the death's, not the arrest's: one move, one bill;
//   a campaign's replay is not raised over a man in handcuffs.
// The harness is main.js in small: the real vitals, both real clocks (this
// card's and the campaign's black card), the death handler with its two timers,
// a save to step back to, and a hospital that moves him and charges its fee.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vitals from '../js/vitals.js';
import { arrestCard, arrestStep, arrestLift, heldPose, HELD_IN, SHOW_AT, MOVE_AT, BACK_AT, LIFT_AT, GIVE_UP } from '../js/arrest-card.js';
import { overCard, dueMove, dueLift, deathGoesTo } from '../js/story-over.js';

const DT = 1 / 30, FEE = 500, SAVED = 9000;
let game = null;
vitals.onDown(() => game?.died());

/**
 * `chapter` is career.activeStory(). `letsGo: false` is the arrest as it was:
 * it runs on over a body that is down. `asksArrest: false` is the replay as
 * it was: it does not look for handcuffs.
 */
function world({ chapter = null, letsGo = true, asksArrest = true } = {}) {
  const g = { now: 0, arrest: null, card: null, chapter, journeys: !!chapter, built: true, timers: [],
    money: 12000, at: 'street', moves: [], held: null, shown: false, black: false, fails: [], reloads: 0, hospital: 0, cards: 0 };
  const story = () => !!g.chapter && g.chapter !== 'done';
  const fail = (why) => { if (g.card || !g.journeys) return; g.card = overCard(); g.cards++; g.fails.push(why); };
  const drop = () => { if (!g.arrest) return; g.arrest = null; g.held = null; g.shown = g.black = false; };
  const inStory = () => deathGoesTo({ chapter: g.chapter, journeys: g.journeys, heist: false, card: !!g.card }) === 'story';
  g.died = () => {
    if (letsGo) drop();
    if (inStory()) { g.timers.push({ at: g.now + 2.2, run: () => { if (vitals.down()) fail('death'); } }); return; }
    g.timers.push({ at: g.now + 4, run: () => {
      if (inStory()) { if (vitals.down()) fail('death'); return; }
      g.hospital++; g.at = 'hospital'; g.moves.push('hospital'); g.money -= FEE;
      vitals.revive();
    } });
  };
  // js/policecops.js onArrest
  g.busted = () => { if (g.arrest || g.card || vitals.down()) return false; g.held = 0; g.arrest = arrestCard(); return true; };
  // the Kampaně tab
  g.replay = () => { if (g.card || (asksArrest && g.arrest) || vitals.down()) return false; g.card = overCard({ replay: 'part1' }); g.cards++; return true; };
  g.frame = () => {
    g.now += DT;
    for (const t of g.timers.splice(0)) (t.at <= g.now ? t.run() : g.timers.push(t));
    // main.js pumpStoryOver
    const c = g.card;
    if (c) {
      if (dueMove(c, DT, vitals.down())) { vitals.revive(); g.at = 'start'; g.moves.push('start'); if (c.replay) g.chapter = 'bridge'; }
      if (dueLift(c, g.built)) g.card = null;
    }
    // main.js pumpArrest
    const o = g.arrest;
    if (!o) return;
    const due = arrestStep(o, DT, { down: letsGo && vitals.down(), story: story(), card: letsGo && !!g.card });
    if (due.drop) { drop(); return; }
    if (!o.moved) g.held = heldPose(o);
    if (due.show) g.shown = true;
    if (due.restart) { drop(); fail('busted'); return; }
    if (due.out) g.black = true;
    if (due.back) {
      // career.reloadLast: money as saved, the body at the save's spot (not while the campaign runs)
      g.held = null;
      if (!story()) { g.reloads++; g.money = SAVED; g.at = 'save'; g.moves.push('save'); }
    }
    if (arrestLift(o, g.built)) { g.arrest = null; g.shown = g.black = false; }
  };
  g.run = (seconds) => { for (let i = Math.round(seconds / DT); i > 0; i--) g.frame(); };
  vitals.reset();
  game = g;
  return g;
}
const kill = () => vitals.damage(1e6, 'kulka');

test('an arrest in free roam: hands up, the word, black, back to the last save, and the card lifts', () => {
  const g = world();
  assert.equal(g.busted(), true);
  g.run(HELD_IN / 2);
  assert.ok(g.held > 0.4 && g.held < 0.6, 'the hands are half way up');
  g.run(SHOW_AT - HELD_IN / 2 + 0.1);
  assert.deepEqual([g.held, g.shown, g.black], [1, true, false]);
  g.run(MOVE_AT - SHOW_AT);
  assert.deepEqual([g.black, g.reloads, g.at], [true, 0, 'street']);
  g.run(BACK_AT - MOVE_AT);
  assert.deepEqual([g.reloads, g.at, g.money, g.held], [1, 'save', SAVED, null]);
  assert.ok(g.arrest, 'the card stays until its minimum');
  g.run(LIFT_AT - BACK_AT);
  assert.equal(g.arrest, null);
  assert.deepEqual([g.moves, g.hospital, vitals.down()], [['save'], 0, false]);
  // a place that never arrives does not hold it for ever
  const h = world();
  h.built = false;
  h.busted();
  h.run(GIVE_UP - 0.5);
  assert.ok(h.arrest);
  h.run(1);
  assert.equal(h.arrest, null);
});

test('shot on his knees in free roam: the death owns him, one move, one bill, no step back to the save', () => {
  for (const when of [0.2, 2.0, 3.9]) {       // early, in the hold, under the black card before the reload
    const g = world();
    g.busted();
    g.run(when);
    kill();
    assert.equal(g.arrest, null, 'the arrest lets go at once, ' + when);
    assert.equal(g.held, null, 'and so do the hands');
    g.run(3.9);
    assert.deepEqual([vitals.down(), g.hospital, g.reloads], [true, 0, 0], 'nothing moves him before the hospital, ' + when);
    g.run(0.2);
    assert.deepEqual([vitals.down(), g.moves, g.money], [false, ['hospital'], 12000 - FEE], 'SEJMUT overrode ZATČEN, ' + when);
    g.run(30);
    assert.deepEqual([g.moves, g.reloads, g.money], [['hospital'], 0, 12000 - FEE]);
  }
});

test('killed at the save, under the arrest\'s black card: the hospital, and the arrest is over', () => {
  const g = world();
  g.built = false;                            // the save's street is still being built
  g.busted();
  g.run(BACK_AT + 2);
  assert.deepEqual([g.at, g.reloads], ['save', 1]);
  kill();
  assert.equal(g.arrest, null);
  g.run(4.1);
  assert.deepEqual([g.moves, g.money, vitals.down()], [['save', 'hospital'], SAVED - FEE, false]);
});

test('the arrest as it was, blind to the body, moves it twice and stacks the fee on the reset', () => {
  const g = world({ letsGo: false });
  g.busted();
  g.run(2.0);
  kill();
  g.run(BACK_AT - 2.0 + 0.1);
  assert.deepEqual([vitals.down(), g.at, g.reloads], [true, 'save', 1], 'the trace of the review: a down body is stepped back to the save');
  g.run(4);
  assert.deepEqual([g.moves, g.money], [['save', 'hospital'], SAVED - FEE]);
  vitals.reset();
});

test('in the campaign an arrest starts it again, and a death on his knees starts it again as a death', () => {
  const g = world({ chapter: 'forecourt' });
  g.busted();
  g.run(MOVE_AT + 0.1);
  assert.deepEqual([g.fails, g.arrest, g.reloads], [['busted'], null, 0]);
  const h = world({ chapter: 'forecourt' });
  h.busted();
  h.run(2.0);
  kill();
  assert.equal(h.arrest, null);
  h.run(2.3);
  assert.deepEqual([h.fails, h.hospital], [['death'], 0], 'the card says he died');
  h.run(10);
  assert.deepEqual([h.fails, h.moves, h.reloads, vitals.down()], [['death'], ['start'], 0, false], 'and the arrest never came back for him');
});

test('a replay is not raised over a man in handcuffs', () => {
  const g = world({ chapter: 'done' });
  g.journeys = true;
  g.busted();
  g.run(3.0);
  assert.equal(g.replay(), false);
  g.run(LIFT_AT);
  assert.deepEqual([g.arrest, g.reloads, g.cards], [null, 1, 0]);
  assert.equal(g.replay(), true, 'once the arrest is over it may start');
  assert.equal(g.busted(), false, 'and nobody is arrested under its card');
});

test('the replay as it was: raised 3.2 s into the hold, it starts from the arrest\'s reset', () => {
  const g = world({ chapter: 'done', asksArrest: false, letsGo: false });
  g.journeys = true;
  g.busted();
  g.run(3.2);
  assert.equal(g.replay(), true);
  g.run(BACK_AT - 3.2 + 0.1);                 // the arrest's reload, 0.2 s before the replay's move
  assert.deepEqual([g.reloads, g.money, g.chapter], [1, SAVED, 'done'], 'the trace of the review: money and all go back to the save');
  g.run(1);
  assert.equal(g.chapter, 'bridge', 'and the replay begins on top of it');
});

test('if a campaign card is up all the same, the arrest lets go instead of stepping back to the save', () => {
  const o = arrestCard();
  let due = null;
  for (let t = 0; t < 3; t += DT) due = arrestStep(o, DT, { down: false, story: false, card: false });
  assert.equal(due.drop, false);
  due = arrestStep(o, DT, { down: false, story: false, card: true });
  assert.deepEqual(due, { drop: true, show: false, restart: false, out: false, back: false });
  // in the campaign the card of another failure does not stop the arrest's own end
  const p = arrestCard();
  for (let t = 0; t < MOVE_AT + 0.1; t += DT) due = arrestStep(p, DT, { down: false, story: true, card: true });
  assert.equal(p.moved, true);
  // a frame as long as the whole card still steps back only once
  const q = arrestCard();
  due = arrestStep(q, 5, { down: false, story: false, card: false });
  assert.deepEqual(due, { drop: false, show: true, restart: false, out: true, back: true });
  assert.deepEqual(arrestStep(q, 5, { down: false, story: false, card: false }), { drop: false, show: false, restart: false, out: false, back: false });
  assert.equal(arrestLift(q, true), true);
});

test('main.js runs the card on this clock, lets go on a death, and guards the replay twice', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const pump = main.slice(main.indexOf('function pumpArrest('), main.indexOf('// The sounds of a car door.'));
  assert.match(pump, /const due = arrestStep\(o, dt, \{ down: vitals\.down\(\), story: !!\(\(story && story !== 'done'\) \|\| heist\), card: !!storyOver \}\);/);
  assert.match(pump, /if \(due\.drop\) \{ dropArrest\(\); return; \}/);
  assert.ok(pump.indexOf('due.drop') < pump.indexOf('career.reloadLast()'), 'asked before anything is reloaded');
  assert.match(pump, /if \(due\.back\) \{[^}]*career\.reloadLast\(\);/);
  assert.equal(pump.match(/career\.reloadLast\(\)/g).length, 1);
  assert.match(pump, /if \(arrestLift\(o, ready\)\)/);
  assert.ok(!/o\.t \+= dt|o\.t > /.test(pump), 'no second clock beside it');
  assert.match(main, /arrest = arrestCard\(\{ veil \}\);/);
  assert.match(main, /function dropArrest\(\) \{\s+if \(!arrest\) return;\s+arrest\.veil\.remove\(\);\s+arrest = null;\s+player\.held = null;\s+\}/);
  // the death handler lets go first, before it picks the hospital or the campaign
  const down = main.slice(main.indexOf('vitals.onDown((cause) => {'), main.indexOf('const chapter = career.activeStory();'));
  assert.ok(down.indexOf('dropArrest();') > 0 && down.indexOf('dropArrest();') < down.indexOf('const inStory'));
  // both guards of the replay, before and after its await
  const replay = main.slice(main.indexOf('async function replayCampaign('), main.indexOf("window.addEventListener('atc:campaigns'"));
  assert.match(replay, /if \(game\.mode !== 'play' \|\| net \|\| storyOver \|\| arrest \|\| journey \|\| meeting \|\| heist \|\| vitals\.down\(\)\) return false;/);
  assert.match(replay, /if \(storyOver \|\| arrest \|\| vitals\.down\(\) \|\| !career\.canReplay\(part\)\) return false;/);
});
