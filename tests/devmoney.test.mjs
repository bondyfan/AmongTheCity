// ---- Dev money (?devmode): what the amount field accepts ----
//
// js/devmoney.js is the pure half of the dev "Přidat peníze" control. The
// panel and the wallet are not tested here: the wallet has its own tests in
// economy.test.mjs, and the panel is a DOM write. What can be wrong in a way
// nobody sees until a test session is the parsing: a field that reads
// "20 000" as 20, takes "-500" as a debit, or lets a typo put a billion on
// the balance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DEV_ADD_MAX, DEV_QUICK, DEV_MONEY_WHY, parseDevAmount, quickLabel } from '../js/devmoney.js';
import * as wallet from '../js/wallet.js';

const ok = (text, amount) => assert.deepEqual(parseDevAmount(text), { ok: true, amount }, JSON.stringify(text));
const no = (text, why) => assert.deepEqual(parseDevAmount(text), { ok: false, why }, JSON.stringify(text));

test('whole koruna, the way Czech writes them', () => {
  ok('20000', 20000);
  ok('20 000', 20000);
  ok('  20 000  ', 20000);
  ok('20 000', 20000);          // no-break space
  ok('20 000', 20000);          // the narrow one kc() prints
  ok('20 000 Kč', 20000);
  ok('20000kc', 20000);
  ok('1 000 000', 1000000);
  ok('+500', 500);
  ok('007', 7);
  ok('1', 1);
});

test('empty input is refused, not read as zero', () => {
  no('', 'empty');
  no('   ', 'empty');
  no('Kč', 'empty');
  no(undefined, 'empty');
  no(null, 'empty');
});

test('a minus is a debit, and this tool does not take money', () => {
  no('-500', 'negative');
  no('-20 000', 'negative');
  no(' -1 ', 'negative');
});

test('anything that is not a whole number is refused', () => {
  for (const t of ['abc', '20k', '1,5', '1.500', '12.5', '1e5', '0x10', '++5', '+-5', '5-', 'NaN', 'Infinity', '20 000 eur']) {
    no(t, 'nan');
  }
  no(20000, 'nan');                   // the field only ever hands over text
  no({}, 'nan');
});

test('zero adds nothing and says so', () => {
  no('0', 'zero');
  no('000', 'zero');
  no('+0', 'zero');
});

test('an upper limit per top-up, inclusive', () => {
  ok(String(DEV_ADD_MAX), DEV_ADD_MAX);
  no(String(DEV_ADD_MAX + 1), 'max');
  no('999 999 999', 'max');
  no('9'.repeat(400), 'max');         // parses to Infinity, still just "too much"
  assert.ok(DEV_ADD_MAX >= 20000 * 10, 'room for a few flights in one go');
  assert.ok(DEV_ADD_MAX < 999999999, 'below the wallet ceiling');
});

test('every refusal has a Czech message', () => {
  for (const why of ['empty', 'nan', 'negative', 'zero', 'max']) {
    assert.equal(typeof DEV_MONEY_WHY[why], 'string');
    assert.ok(DEV_MONEY_WHY[why].length > 3);
  }
  for (const m of Object.values(DEV_MONEY_WHY)) assert.ok(!m.includes('—'), 'no em dash: ' + m);
});

test('the quick buttons: about one flight among them, and each one valid', () => {
  assert.deepEqual([...DEV_QUICK], [1000, 20000, 100000]);
  for (const n of DEV_QUICK) {
    assert.ok(n > 0 && n <= DEV_ADD_MAX);
    assert.match(quickLabel(n), /^\+\d{1,3}(\s\d{3})*\sKč$/u);
  }
  assert.equal(quickLabel(20000).replace(/\s/gu, ' '), '+20 000 Kč');
});

test('a parsed amount lands in the wallet as an ordinary earning', () => {
  wallet.reset();
  const seen = [];
  wallet.onChange((m, d, what) => seen.push([m, d, what]));
  const before = wallet.money();
  const r = parseDevAmount('20 000');
  wallet.earn(r.amount, 'dev');
  assert.equal(wallet.money(), before + 20000);
  assert.deepEqual(seen.at(-1), [before + 20000, 20000, 'dev']);
  // ...and is then enough for the Mahé fare a test session wants to buy
  assert.ok(wallet.canPay(20000));
  wallet.reset();
});
