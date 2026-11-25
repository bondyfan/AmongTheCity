// The black card between a failed mission and its restart (js/story-over.js,
// main.js failStory and pumpStoryOver). The rule under test, from the review of
// 25 Nov 2026: he can be killed AGAIN under the card, after it has revived him
// and while the street of the start is still being built, and that second
// death must not leave him down for the rest of the session.
// The harness below is main.js in small: the real vitals, the real clock, the
// death handler with both of its timers (2.2 s to the campaign's restart, 4 s
// to the hospital), a failStory that drops a second card, and the replay card
// of the Kampaně tab over a save that still says 'done'.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as vitals from '../js/vitals.js';
import { overCard, dueMove, dueLift, deathGoesTo, MOVE_AT, LIFT_AT, GIVE_UP, AGAIN_IN } from '../js/story-over.js';

const DT = 1 / 30;
let game = null;
// (vitals keeps its listeners for good, like main.js: one handler, the game of the moment)
vitals.onDown(() => game?.died());

/**
 * A campaign in small. `chapter` is career.activeStory(), `journeys` whether
 * part one's maker is loaded (startJourney), `heist` whether part two runs.
 * `watch: false` is the card as it was, blind to the body; `seesCard: false`
 * is the death handler as it was, blind to the card.
 */
function campaign({ watch = true, seesCard = true, chapter = 'bridge', journeys = true, heist = false } = {}) {
  const g = { now: 0, card: null, moves: 0, lifts: 0, cards: 0, hospital: 0, built: false, timers: [], chapter, journeys, heist };
  const fail = () => { if (g.card || !(g.journeys || g.heist)) return; g.card = overCard(); g.cards++; };
  const inStory = () => deathGoesTo({ chapter: g.chapter, journeys: g.journeys, heist: g.heist, card: seesCard && !!g.card }) === 'story';
  g.died = () => {
    if (inStory()) { g.timers.push({ at: g.now + 2.2, run: () => { if (vitals.down()) fail(); } }); return; }
    g.timers.push({ at: g.now + 4, run: () => {
      if (seesCard && inStory()) { if (vitals.down()) fail(); return; }
      g.hospital++;                           // carried off, billed, and whatever ran is gone
      vitals.revive();
    } });
  };
  g.fail = fail;
  // the Kampaně tab: a card over a finished save (main.js replayCampaign)
  g.replay = (part) => { if (g.card || vitals.down()) return false; g.card = overCard({ replay: part }); g.cards++; return true; };
  g.frame = () => {
    g.now += DT;
    for (const t of g.timers.splice(0)) (t.at <= g.now ? t.run() : g.timers.push(t));
    const o = g.card;
    if (!o) return;
    if (dueMove(o, DT, watch && vitals.down())) {
      vitals.revive();
      g.moves++;
      if (o.replay === 'part1') g.chapter = 'bridge';   // career.beginReplay: the chapter begins at the move
    }
    if (dueLift(o, g.built)) {
      g.card = null;
      g.lifts++;
      if (o.replay === 'part2') g.heist = true;         // part two is made once the card is gone
    }
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

test('a death under a card that came up over a living man is undone by the move and starts nothing after it', () => {
  // The card of failStory('busted') or failStory('train'): he is alive under
  // it. The arrest itself is driven in tests/arrest-card.test.mjs; here it is
  // what it ends in, the same failStory. Then he is run over 0.1 s before the move.
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

test('a death in the first 1.4 s of a replay card is the campaign\'s: no hospital, no fee, the replay goes on', () => {
  // part one finished and saved: activeStory() says 'done' until the card's move
  const g = campaign({ chapter: 'done' });
  g.built = true;
  assert.equal(g.replay('part1'), true);
  g.run(0.7);
  assert.equal(g.chapter, 'done', 'the replay has not begun yet');
  kill();
  g.run(10);
  assert.deepEqual([g.hospital, vitals.down(), g.moves, g.lifts, g.cards], [0, false, 1, 1, 1]);
  assert.equal(g.chapter, 'bridge', 'and part one is being played again');
});

test('a death anywhere under the card of a replayed part two is the campaign\'s too', () => {
  // part two is only made once the card lifts, and the save says 'done' all along
  const g = campaign({ chapter: 'done', journeys: false });
  assert.equal(g.replay('part2'), true);
  g.run(0.7);
  kill();                                   // before the move
  g.run(9.3);
  assert.deepEqual([g.hospital, vitals.down(), g.moves, g.lifts], [0, false, 1, 0], 'the move revived him, the street is not built');
  kill();                                   // after the move, 10 s in, long before the lift
  g.run(6);
  assert.deepEqual([g.hospital, vitals.down(), g.moves, g.lifts, g.heist], [0, false, 2, 0, false]);
  g.built = true;
  g.run(0.5);
  assert.deepEqual([g.lifts, g.heist, g.cards, vitals.down()], [1, true, 1, false], 'part two starts, with him on his feet');
  kill();                                   // and a death in the running part two fails it as ever
  g.run(2.3);
  assert.equal(g.cards, 2);
  assert.equal(g.hospital, 0);
});

test('the death handler as it was, blind to the card, sends a replay to the hospital', () => {
  const g = campaign({ seesCard: false, chapter: 'done' });
  g.built = true;
  g.replay('part1');
  g.run(0.7);
  kill();
  g.run(3.9);
  assert.deepEqual([g.moves, vitals.down(), g.hospital], [1, false, 0], 'the card has him alive at the start');
  g.run(0.2);
  assert.equal(g.hospital, 1, 'the trace of the review: 4 s after the death he is carried off and billed');
});

test('outside the campaign a death still wakes up in the hospital after 4 s', () => {
  for (const chapter of [null, 'done']) {
    const g = campaign({ chapter, journeys: chapter === 'done' });
    kill();
    g.run(3.9);
    assert.deepEqual([vitals.down(), g.hospital, g.cards], [true, 0, 0]);
    g.run(0.2);
    assert.deepEqual([vitals.down(), g.hospital, g.cards], [false, 1, 0]);
  }
  // the rule on its own
  const to = (chapter, journeys, heist, card) => deathGoesTo({ chapter, journeys, heist, card });
  assert.equal(to('coach', true, false, false), 'story');
  assert.equal(to('coach', false, false, false), 'hospital', 'a chapter nobody can make is not a campaign');
  assert.equal(to('done', true, false, false), 'hospital');
  assert.equal(to(null, false, false, false), 'hospital');
  assert.equal(to('done', true, true, false), 'story');
  assert.equal(to('done', false, false, true), 'story');
  assert.equal(to(null, false, false, true), 'story');
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

test('main.js asks the same rule where a death goes, card included, and again before the hospital', () => {
  const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const down = main.slice(main.indexOf('vitals.onDown((cause) => {'), main.indexOf('const chapter = career.activeStory();'));
  assert.match(down, /const inStory = \(\) => deathGoesTo\(\{ chapter: career\.activeStory\(\), journeys: !!startJourney, heist: !!heist, card: !!storyOver \}\) === 'story';/);
  assert.match(down, /if \(inStory\(\)\) \{\s+\/\/[^\n]*\n\s+\/\/[^\n]*\n\s+setTimeout\(/, 'the campaign branch is chosen by it');
  const bed = down.slice(down.lastIndexOf('setTimeout(() => {'));
  assert.match(bed, /if \(game\.mode !== 'play'\) return;\s+\/\/[^\n]*\n\s+if \(inStory\(\)\) \{ if \(vitals\.down\(\)\) failStory\('death'\); return; \}/);
  assert.ok(bed.indexOf('inStory()') < bed.indexOf('nearestHospital('), 'asked before he is moved or billed');
  assert.match(bed, /wallet\.pay\(PRICE\.hospital\.fee, 'nemocnice'\);\s+vitals\.revive\(\);/, 'the ordinary bed is as it was');
  // a replay never comes up over a body that is down, not even after its await
  const replay = main.slice(main.indexOf('async function replayCampaign('), main.indexOf("window.addEventListener('atc:campaigns'"));
  assert.match(replay, /if \(storyOver \|\| arrest \|\| vitals\.down\(\) \|\| !career\.canReplay\(part\)\) return false;/);
});
