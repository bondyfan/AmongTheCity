// ---- who gets a voice -------------------------------------------------------
// Sixty cars, eight voices. js/voicebudget.js picks them; these pin the rules:
// never more than there are slots, the loudest at the ears win, a held voice is
// not traded for an equal, and a car keeps its slot for as long as it has one.

import test from 'node:test';
import assert from 'node:assert';
import { assignVoices } from '../js/voicebudget.js';

const car = (id, d, loud = 1) => ({ id, d, loud });
const fresh = (n = 8) => new Array(n).fill(null);

test('never more voices than slots, and the nearest get them', () => {
  const slots = fresh(8);
  const cands = Array.from({ length: 60 }, (_, i) => car('c' + i, 5 + i * 2));
  assignVoices(cands, slots, 130);
  assert.equal(slots.filter((s) => s !== null).length, 8);
  for (let i = 0; i < 8; i++) assert.ok(slots.includes('c' + i), `c${i} at ${5 + i * 2} m has no voice`);
});

test('nothing past earshot is ever voiced, even with slots to spare', () => {
  const slots = fresh(8);
  assignVoices([car('near', 20), car('far', 131), car('edge', 130)], slots, 130);
  assert.deepEqual(slots.filter((s) => s !== null), ['near']);
});

test('a lorry outranks a hatchback that is a little nearer', () => {
  const slots = fresh(1);
  assignVoices([car('fabia', 30, 0.95), car('truck', 40, 1.5)], slots, 130);
  assert.equal(slots[0], 'truck');
});

test('a car keeps its slot while it keeps its voice', () => {
  const slots = fresh(4);
  let cands = [car('a', 10), car('b', 20), car('c', 30), car('d', 40)];
  assignVoices(cands, slots, 130);
  const where = Object.fromEntries(slots.map((id, i) => [id, i]));
  // everything moves about, a fifth car turns up further out
  cands = [car('d', 12), car('c', 33), car('b', 18), car('a', 25), car('e', 90)];
  const r = assignVoices(cands, slots, 130);
  for (const id of ['a', 'b', 'c', 'd']) assert.equal(slots[where[id]], id, `${id} was moved to another slot`);
  assert.deepEqual(r.taken, []);
  assert.deepEqual(r.dropped, []);
});

test('two cars at the same distance do not trade the last voice back and forth', () => {
  const slots = fresh(1);
  assignVoices([car('a', 40), car('b', 41)], slots, 130);
  assert.equal(slots[0], 'a');
  let swaps = 0;
  for (let i = 0; i < 100; i++) {
    const wobble = i % 2 ? 2 : -2;                 // b is nearer every other frame
    const r = assignVoices([car('a', 40), car('b', 40 + wobble)], slots, 130);
    swaps += r.taken.length;
  }
  assert.equal(swaps, 0, 'the voice changed hands on a two metre wobble');
  // but something clearly nearer does take it
  const r = assignVoices([car('a', 40), car('b', 15)], slots, 130);
  assert.deepEqual(r.dropped, [0]);
});

test('a slot that was just dropped is not handed out in the same call, nor while it rests', () => {
  const slots = fresh(1);
  assignVoices([car('a', 20)], slots, 130);
  let r = assignVoices([car('b', 10)], slots, 130);
  assert.deepEqual(r.dropped, [0]);
  assert.deepEqual(r.taken, [], 'the old voice has not faded out yet');
  assert.equal(slots[0], null);
  r = assignVoices([car('b', 10)], slots, 130, () => true);       // still resting
  assert.deepEqual(r.taken, []);
  r = assignVoices([car('b', 10)], slots, 130, () => false);
  assert.equal(slots[0], 'b');
  assert.equal(r.taken[0][0], 0);
});

test('an empty street lets every voice go', () => {
  const slots = fresh(3);
  assignVoices([car('a', 10), car('b', 20)], slots, 130);
  const r = assignVoices([], slots, 130);
  assert.deepEqual(slots, [null, null, null]);
  assert.equal(r.dropped.length, 2);
});
