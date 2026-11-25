// The black card between a failed mission and its restart (js/story-over.js,
// main.js failStory and pumpStoryOver). The rule under test, from the review of
// 25 Nov 2026: he can be killed AGAIN under the card, after it has revived him
// and while the street of the start is still being built, and that second
// death must not leave him down for the rest of the session.
// The harness below is main.js in small: the real vitals, the real clock, the
// death handler's 2.2 s timer and a failStory that drops a second card.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vitals from '../js/vitals.js';
import { overCard, dueMove, dueLift, MOVE_AT, LIFT_AT, GIVE_UP, AGAIN_IN } from '../js/story-over.js';

const DT = 1 / 30;
let game = null;
// (vitals keeps its listeners for good, like main.js: one handler, the game of the moment)
vitals.onDown(() => game?.died());

/** A campaign in small. `watch: false` is the card as it was: blind to the body. */
function campaign({ watch = true } = {}) {
  const g = { now: 0, card: null, moves: 0, lifts: 0, cards: 0, built: false, timers: [] };
  const fail = () => { if (g.card) return; g.card = overCard(); g.cards++; };
  g.died = () => g.timers.push({ at: g.now + 2.2, run: () => { if (vitals.down()) fail(); } });
  g.fail = fail;
  g.frame = () => {
    g.now += DT;
    for (const t of g.timers.splice(0)) (t.at <= g.now ? t.run() : g.timers.push(t));
    const o = g.card;
    if (!o) return;
    if (dueMove(o, DT, watch && vitals.down())) { vitals.revive(); g.moves++; }
    if (dueLift(o, g.built)) { g.card = null; g.lifts++; }
  };
  g.run = (seconds) => { for (let i = Math.round(seconds / DT); i > 0; i--) g.frame(); };
  g.until = (when, limit = 60) => { for (let i = Math.round(limit / DT); i > 0 && !when(); i--) g.frame(); return when(); };
  vitals.reset();
  game = g;
  return g;
}
const kill = () => vitals.damage(1e6, 'auto');

test('the card moves him once it is black and lifts once the street is there', () => {
  const g = campaign();
  kill();
  assert.equal(vitals.down(), true);
  g.run(2.1);
  assert.equal(g.card, null, 'the card comes 2.2 s after the death');
  assert.ok(g.until(() => g.card));
  g.run(MOVE_AT - 0.1);
  assert.equal(g.moves, 0, 'not before it is black');
  g.run(0.2);
  assert.deepEqual([g.moves, vitals.down()], [1, false], 'put back and revived, once');
  g.run(10);
  assert.equal(g.lifts, 0, 'it waits for the street');
  g.built = true;
  g.frame();
  assert.deepEqual([g.lifts, g.moves, g.cards], [1, 1, 1]);
  // a street that never arrives does not hold the card for ever
  const h = campaign();
  h.fail();
  h.run(GIVE_UP - 0.5);
  assert.equal(h.lifts, 0);
  h.run(1);
  assert.equal(h.lifts, 1);
});

test('killed again 2 s into the card, with the start not built yet: he is on his feet when it lifts', () => {
  const g = campaign();
  kill();
  assert.ok(g.until(() => g.card));
  g.until(() => g.card.t >= 2);
  assert.deepEqual([g.moves, vitals.down()], [1, false], 'the card has revived him at the start');
  kill();                                   // traffic at the start, under the black card
  assert.equal(vitals.down(), true);
  g.frame();
  assert.equal(g.card.moved, false, 'the card is back before its move');
  g.run(AGAIN_IN + 0.1);
  assert.deepEqual([g.moves, vitals.down(), g.card.again], [2, false, 1], 'moved and revived a second time');
  g.run(8);                                 // the death handler's timer has long fired
  assert.deepEqual([g.cards, g.lifts], [1, 0], 'no second card, and it still waits for the street');
  g.built = true;
  g.run(0.5);
  assert.equal(g.lifts, 1);
  g.run(5);
  assert.equal(vitals.down(), false, 'he is up after the tail');
  assert.deepEqual([g.cards, g.moves], [1, 2], 'and the campaign did not start over once more behind it');
  // damage and healing work again: down() no longer swallows them
  vitals.damage(10, 'pěst');
  assert.ok(vitals.hp() > 0 && vitals.hp() < vitals.hpMax());
});

test('the card as it was, blind to the body, leaves that second death down for good', () => {
  const g = campaign({ watch: false });
  kill();
  assert.ok(g.until(() => g.card));
  g.until(() => g.card.t >= 2);
  kill();
  g.run(8);
  g.built = true;
  g.run(5);
  assert.deepEqual([g.card, g.moves, vitals.down()], [null, 1, true], 'the trace of the review: the card is gone and he lies there');
  vitals.reset();
});

test('a death under the card of an arrest is undone by the move and starts nothing after it', () => {
  // arrested (he is alive under the card), then run over 0.1 s before the move
  const g = campaign();
  g.built = true;
  g.fail();
  g.run(MOVE_AT - 0.1);
  kill();
  g.until(() => !g.card);
  assert.deepEqual([g.moves, g.lifts, vitals.down()], [1, 1, false]);
  g.run(4);                                 // his timer fires 0.2 s after the card lifted
  assert.equal(g.cards, 1, 'he is alive: there is nothing to start over');
});

test('a death every time he stands up never lifts the card over a body that is down', () => {
  const g = campaign();
  g.built = true;
  g.fail();
  for (let i = 0; i < 6; i++) {
    g.until(() => g.card.moved);
    g.run(0.3);
    kill();
    g.frame();
    assert.equal(dueLift(g.card, true), false);
  }
  assert.equal(g.card.again, 6);
  g.until(() => !g.card);
  assert.deepEqual([vitals.down(), g.lifts, g.cards], [false, 1, 1]);
  assert.ok(LIFT_AT > MOVE_AT && MOVE_AT > AGAIN_IN);
});

test('main.js runs its card on this clock and asks the body before it fails the story', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const pump = main.slice(main.indexOf('function pumpStoryOver('), main.indexOf('let roadWorks'));
  assert.match(pump, /if \(dueMove\(o, dt, vitals\.down\(\)\)\) \{/);
  assert.match(pump, /dueLift\(o, ready\)/);
  assert.ok(pump.indexOf('vitals.revive()') > pump.indexOf('dueMove('), 'the revive is part of the move');
  assert.ok(!/o\.t \+= dt|o\.moved = true/.test(pump), 'no second clock beside it');
  // a replay begins once: the second move of its card goes where the first went
  assert.match(pump, /at = o\.at \?\?= career\.beginReplay\(o\.replay\)/);
  assert.equal(main.match(/storyOver = overCard\(/g)?.length, 2, 'both cards are made by the clock');
  assert.match(main, /if \(game\.mode === 'play' && vitals\.down\(\)\) failStory\('death'\);/);
});
