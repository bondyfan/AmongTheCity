// ---- the party-wall pass in steps (round 9, package roofs) ----
// js/partywalls.js used to run as ONE step of geo.js's sliced tile indexing:
// 21.5 ms warm on a dense Prague tile and 50 to 65 ms on the first tiles of a
// session (measured), which the 4 ms slicer could not cut. It is now
// stampPartyWallsSteps, yielding every few thousand edges, records or
// buildings, which geo.js calls with yield*. Pinned here: the walls and slabs
// it writes on real tiles are, byte for byte, what the single pass of round 7
// wrote (the hashes below were taken from that pass, 3e810cb), whether it is
// drained at once or one step at a time; it really is cut into many steps;
// and a pass interrupted by another tile's pass still finishes right.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const { stampPartyWalls, stampPartyWallsSteps } = await import('../js/partywalls.js');

const load = (t, slot) => {
  const b = JSON.parse(readFileSync(new URL(`../public/data/tiles/${t}.json`, import.meta.url), 'utf8')).buildings;
  let n = slot * (1 << 20);
  for (const f of b) f._id = ++n;
  return b;
};
const digest = (b) => {
  const h = createHash('sha1');
  for (const f of b) h.update(JSON.stringify([f._pw ?? null, f._slab ?? null]));
  return h.digest('hex').slice(0, 16);
};
// the round 7 single pass (3e810cb) on these tiles, ids stamped as above
const WANT = { '-20_-2': '5df36a190c5f71fe', '0_-1': '0fcf3f6a6fe54abc', '-21_-1': '89d2f7effe09cd73' };
const SLOT = { '-20_-2': 3, '0_-1': 4, '-21_-1': 5 };

test('the stepped pass writes what the single pass wrote, drained at once or step by step', () => {
  for (const t of Object.keys(WANT)) {
    const a = load(t, SLOT[t]);
    stampPartyWalls(a);
    assert.equal(digest(a), WANT[t], `tile ${t}, drained at once`);
    const b = load(t, SLOT[t]);
    let steps = 0;
    for (const it = stampPartyWallsSteps(b); !it.next().done;) steps++;
    assert.equal(digest(b), WANT[t], `tile ${t}, step by step`);
    if (t === '-20_-2') assert.ok(steps >= 60, `the dense Old Town tile took only ${steps} steps`);
    // stamped again over its own stamp: the same (stale values are cleared)
    stampPartyWalls(b);
    assert.equal(digest(b), WANT[t], `tile ${t}, stamped twice`);
  }
});

test('a pass interrupted by another tile\'s pass still finishes right', () => {
  const a = load('-20_-2', SLOT['-20_-2']), b = load('0_-1', SLOT['0_-1']);
  const it = stampPartyWallsSteps(a);
  for (let i = 0; i < 25; i++) it.next();
  stampPartyWalls(b);            // takes the shared scratch in the middle of a's pass
  while (!it.next().done);
  assert.equal(digest(a), WANT['-20_-2']);
  assert.equal(digest(b), WANT['0_-1']);
});

test('an empty tile and a tile of jogs only are no work at all', () => {
  assert.ok(stampPartyWallsSteps([]).next().done);
  const tiny = [{ o: [[0, 0], [0.5, 0], [0.5, 0.5]], h: 5, _pw: [1, 1, 1] }];
  stampPartyWalls(tiny);
  assert.equal(tiny[0]._pw, undefined, 'a stale stamp survived');
});
