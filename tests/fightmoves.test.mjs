// ---- js/fightmoves.js: the punches, the ladder, who hits back --------------
// Pure tables and functions, so these are plain arithmetic: the combo's
// rhythm, what each blow costs and does to a body, where the damage window
// sits in a recording, and the decisions of a pedestrian who fights back.

import test from 'node:test';
import assert from 'node:assert/strict';

const F = await import('../js/fightmoves.js');
const { MOVES, LIGHT_CHAIN, CHAIN_GAP, KO_HP, nextMove, reactionFor, movePose, inWindow, moveDur,
  fightsBack, FIGHT_SHARE, playerTakes, PED_PUNCH, brawlStep } = F;

test('three light presses in rhythm are jab, cross, hook, and then it starts again', () => {
  let step = 0;
  const thrown = [];
  for (let i = 0; i < 7; i++) {
    const r = nextMove('light', step, i === 0 ? Infinity : 0.1);
    thrown.push(r.move.key);
    step = r.step;
  }
  assert.deepEqual(thrown, ['jab', 'cross', 'hook', 'jab', 'cross', 'hook', 'jab']);
  assert.deepEqual(LIGHT_CHAIN, ['jab', 'cross', 'hook']);
});

test('a press after the rhythm is lost is a jab again; Q is the hook at any point', () => {
  assert.equal(nextMove('light', 1, CHAIN_GAP + 0.01).move.key, 'jab', 'a cold chain threw the cross');
  assert.equal(nextMove('light', 2, CHAIN_GAP + 0.5).move.key, 'jab');
  assert.equal(nextMove('light', 2, CHAIN_GAP).move.key, 'hook', 'the edge of the rhythm still counts');
  for (const step of [0, 1, 2]) {
    const r = nextMove('heavy', step, 0.1);
    assert.equal(r.move.key, 'hook');
    assert.equal(r.step, 0, 'the heavy punch left the light chain half thrown');
  }
  // nonsense in, a jab out: never undefined, never a throw
  for (const [s, g] of [[NaN, 0.1], [-3, 0.1], [99, 0.1], [1, NaN]]) {
    assert.equal(nextMove('light', s, g).move.key, 'jab');
  }
});

test('what a blow does: a flinch, a knock-down at the hook or at KO_HP, and death at nothing left', () => {
  assert.equal(reactionFor(MOVES.jab, 100), 'flinch');
  assert.equal(reactionFor(MOVES.cross, 100), 'flinch');
  assert.equal(reactionFor(MOVES.hook, 100), 'down', 'the hook does not floor a healthy man');
  assert.equal(reactionFor(MOVES.jab, KO_HP + MOVES.jab.dmg), 'down', 'a blow to KO_HP left him standing');
  assert.equal(reactionFor(MOVES.jab, KO_HP + MOVES.jab.dmg + 1), 'flinch');
  assert.equal(reactionFor(MOVES.jab, MOVES.jab.dmg), 'dead', 'exactly nothing left is alive');
  assert.equal(reactionFor(MOVES.hook, 5), 'dead');
});

test('a healthy man survives a combo, and six punches in the rhythm finish him', () => {
  // the fight as the crowd sees it: combos until there is nothing left, up
  // again after every knock-down
  let hp = 100, punches = 0, downs = 0, step = 0, dead = false;
  for (let round = 0; round < 5 && !dead; round++) {
    step = 0;
    for (let i = 0; i < 3; i++) {
      const { move, step: s } = nextMove('light', step, 0.1);
      step = s;
      const rx = reactionFor(move, hp);
      hp -= move.dmg; punches++;
      if (rx === 'dead') { dead = true; break; }
      if (rx === 'down') { downs++; break; }
    }
    if (round === 0) assert.equal(dead, false, 'one combo killed a healthy man');
  }
  assert.equal(dead, true);
  assert.equal(punches, 6, `${punches} punches to kill: the ladder drifted`);
  assert.equal(downs, 2);
});

test('every damage window sits inside its recording, before the punch may be cut', () => {
  for (const m of Object.values(MOVES)) {
    assert.ok(m.open > 0 && m.open < m.shut, `${m.key}: an empty window`);
    assert.ok(m.shut <= m.chain + 1e-9, `${m.key}: the next press can cut the punch before it lands`);
    assert.ok(m.chain <= m.end, `${m.key}: chain after the end`);
    assert.ok(m.speed > 0.8 && m.speed < 2, `${m.key}: an absurd speed`);
    assert.ok(m.reach >= 1.2 && m.reach <= 2, `${m.key}: reach ${m.reach}`);
    // real time
    assert.equal(inWindow(m, (m.open - 0.01) / m.speed), false);
    assert.equal(inWindow(m, (m.open + 0.001) / m.speed), true);
    assert.equal(inWindow(m, (m.shut + 0.01) / m.speed), false);
    assert.ok(Math.abs(moveDur(m) - m.end / m.speed) < 1e-9);
  }
  // a snappy game: the jab lands within a seventh of a second of the press
  assert.ok(MOVES.jab.open / MOVES.jab.speed < 0.15, 'the jab is slow to land');
  assert.ok(moveDur(MOVES.hook) > moveDur(MOVES.jab), 'the heavy punch is not the slow one');
});

test('the hook is two recordings back to back, the swing and the way home', () => {
  const h = MOVES.hook, swing = h.end - h.recDur;
  const a = movePose(h, (swing - 0.05) / h.speed);
  assert.equal(a.role, 'fightHook');
  assert.ok(Math.abs(a.t - (swing - 0.05)) < 1e-9);
  const b = movePose(h, (swing + 0.1) / h.speed);
  assert.equal(b.role, 'fightHookRec');
  assert.ok(Math.abs(b.t - 0.1) < 1e-9);
  const j = movePose(MOVES.jab, 0.2);
  assert.equal(j.role, 'fightJab');
  assert.ok(Math.abs(j.t - 0.2 * MOVES.jab.speed) < 1e-9);
  assert.equal(movePose(MOVES.jab, -1).t, 0, 'a negative time ran the clip backwards');
});

test('who fights back is who they are, in about the shares the table says', () => {
  for (const pid of [1, 77, -5, 2 ** 30]) {
    assert.equal(fightsBack(pid, 'm30'), fightsBack(pid, 'm30'), 'the same man changed his mind');
  }
  const N = 6000;
  for (const [arch, share] of Object.entries(FIGHT_SHARE)) {
    let n = 0;
    for (let i = 0; i < N; i++) if (fightsBack((i * 2654435761) | 0, arch)) n++;
    assert.ok(Math.abs(n / N - share) < 0.03, `${arch}: ${(n / N).toFixed(3)} fight back, the table says ${share}`);
  }
  assert.equal([...Array(500).keys()].some((i) => fightsBack(i, 'm90')), false, 'a man of ninety put his fists up');
  assert.equal(typeof fightsBack(undefined, undefined), 'boolean');
});

test('a block facing the punch takes most of it, from behind it takes nothing', () => {
  assert.deepEqual(playerTakes(10, true, 1), { dmg: 2, blocked: true });
  assert.deepEqual(playerTakes(10, true, PED_PUNCH.blockCos), { dmg: 2, blocked: true });
  assert.deepEqual(playerTakes(10, true, -0.9), { dmg: 10, blocked: false }, 'a block worked backwards');
  assert.deepEqual(playerTakes(10, false, 1), { dmg: 10, blocked: false });
  // a pedestrian's punch costs less than the player's own lightest
  assert.ok(PED_PUNCH.cross.dmg < MOVES.jab.dmg);
});

test('a brawler closes in, holds, punches when due, and gives up for the right reasons', () => {
  const base = { dist: 1.0, hp: 80, ready: false, away: 0, fought: 2, gone: false };
  assert.equal(brawlStep({ ...base, gone: true }), 'quit');
  assert.equal(brawlStep({ ...base, hp: 30 }), 'flee');
  assert.equal(brawlStep({ ...base, away: 3 }), 'quit');
  assert.equal(brawlStep({ ...base, fought: 60 }), 'quit');
  assert.equal(brawlStep({ ...base, calm: PED_PUNCH.satisfied + 1 }), 'quit', 'he beat a man who never hit back flat');
  assert.equal(brawlStep({ ...base, calm: 2 }), 'hold');
  assert.equal(brawlStep({ ...base, dist: 3 }), 'approach');
  assert.equal(brawlStep({ ...base, dist: 0.5 }), 'back');
  assert.equal(brawlStep(base), 'hold');
  assert.equal(brawlStep({ ...base, ready: true }), 'punch');
  // close enough to punch is close enough to be punched by
  assert.ok(PED_PUNCH.reach >= 1.3, 'a brawler holding at 1.3 m cannot reach');
});
