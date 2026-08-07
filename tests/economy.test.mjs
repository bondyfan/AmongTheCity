// ---- The economy: money, the body, the tank, and the one price table ------
//
// Four modules were written in one afternoon against one brief, and all four
// are pure arithmetic over plain data with no DOM, no WebGL and no clock — the
// same property js/chatter.js has and for the same reason. So they get checked
// like it. js/statusbar.js is the fifth and is deliberately NOT tested beyond
// "it imports and does nothing without a document": everything it could be
// asked about is a DOM write, and a fake document here would be testing the
// fake.
//
// These tests are not a transcription of the four files. They exist because an
// adversarial read of the DESIGN found seven ways this feature can be wrong in
// a way that ships, and every one of them is silent:
//
//   1. A PART-PAID SALE. The pump debits as it fills, the player runs out at
//      31 of the 42 litres, and the caller is told the sale failed. The player
//      is now short 1 200 Kč with a part tank and no receipt. pay() has to be
//      all-or-nothing, and "nothing" has to mean the balance is BYTE-identical
//      and no listener was told a lie.
//   2. A NaN BALANCE. One fare that computed to NaN and the wallet is NaN for
//      the rest of the session — every comparison answers false, every purchase
//      silently succeeds or silently fails, and the HUD says "NaN Kč". There is
//      no way back from it, which is what makes it worth a test rather than a
//      bug report.
//   3. A STALE HUD AFTER A RESTORE. setMoney() is how a save comes back. If it
//      does not notify, the number in the corner is the one from before the
//      load and stays there until the player next buys something.
//   4. A TRANSITION BILLED AS A CRASH. Step out of a car doing 30 m/s and the
//      naive "previous speed" differences 30 against 0 and takes most of your
//      health for the crime of sitting down. vitals.js's header names this as a
//      rejected design; this file is where that rejection is enforced. The
//      helicopter is the same bug wearing a different hat, because main.js
//      hands it over through `player.inCar` — a field called `car`.
//   5. onDown FIRING EVERY FRAME. Death is a flag, and a flag that re-fires
//      charges a second hospital bill, raises a second death card and teleports
//      a corpse that is already being teleported.
//   6. A FUEL TYPE THAT DOES NOT EXIST. fuelTypeOf falls back to the Octavia, so
//      a kind it has never heard of is petrol rather than a crash — which is
//      correct, and which also means a typo in the table is INVISIBLE. The eight
//      tanks are all different sizes, and that is what lets a test prove no kind
//      quietly fell down the fallback.
//   7. THE RANGE BEING 8-16x WRONG. This is not hypothetical: fuel.js's header
//      says the first design measured exactly that, because it integrated a load
//      model over a bang-bang throttle and gave the Tesla 1.7 km. The range band
//      per kind at the bottom of this file is the assertion that catches that
//      whole class, and it is the reason this file exists at all.
//
// A NOTE ON THE THREE SINGLETONS. wallet.js and vitals.js are module-level
// state on purpose (one player per tab), and neither has an unsubscribe — both
// headers argue why. That makes them shared mutable state ACROSS these tests, so
// every test that touches them opens with freshWallet()/freshBody(), and the
// recorders are subscribed exactly once at module load and read through arrays
// that get emptied rather than replaced. A test that subscribes its own listener
// leaves it subscribed for the rest of the process, so the two that must do so
// (the duplicate check, the throwing listener) are written to be inert
// afterwards.
//
// vehicles.js is READ AS TEXT rather than imported. It pulls in three.js, and
// the whole point of these four modules is that they run under `node --test`
// with nothing else on disk; but the roster of car kinds still has to be pinned
// against the real one, or a ninth kind is added and nothing notices that it
// has no tank. The parse asserts its own success first, so a changed
// declaration fails loudly instead of testing an empty list.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import * as W from '../js/wallet.js';
import * as V from '../js/vitals.js';
import * as F from '../js/fuel.js';
import { PRICE, FUEL_PRICE, pumpBrand, pumpPrice, kc, kc2 } from '../js/prices.js';
import * as HUD from '../js/statusbar.js';

// ---------------------------------------------------------------- fixtures ----

// The eight kinds, taken from the file that owns them. See the header for why
// this is a read and not an import.
const CAR_KINDS = (() => {
  const src = readFileSync(new URL('../js/vehicles.js', import.meta.url), 'utf8');
  const m = /export const CAR_KINDS\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
})();

// U+202F NARROW NO-BREAK SPACE — the one prices.js prints. Written as an escape
// here on purpose: a literal would be invisible in a diff and indistinguishable
// from the ASCII space this file exists to prove is absent.
const NBSP = ' ';

// Everything a caller might hand a money function that is not money. `[]`
// and `''` are in the list because Number() maps both to 0, which is the
// coercion wallet.js's header says it rejected.
const CORRUPT = [NaN, Infinity, -Infinity, null, undefined, '', '500', 'dvanáct',
  [], [500], {}, true, false];

// ---- the wallet's one recorder --------------------------------------------
// Subscribed once, for the life of the process. Tests empty it rather than
// re-subscribing, because wallet.js has no unsubscribe (its header explains
// why) and a per-test listener would accumulate.
const WLOG = [];
W.onChange((money, delta, what) => { WLOG.push({ money, delta, what }); });

function freshWallet() { W.reset(); WLOG.length = 0; }

// ---- the body's recorders --------------------------------------------------
// Subscribed once each, for the same reason the wallet's is: vitals.js has no
// unsubscribe either. The third one is the re-entrant reviver — main.js's real
// death handler eventually calls revive() from inside onDown — and it is behind
// a flag so it is inert in every test that is not about it.
const DOWNS = [], REVIVES = [];
let REVIVE_ON_DOWN = false;
V.onDown((cause) => { DOWNS.push(cause); });
V.onDown(() => { if (REVIVE_ON_DOWN) V.revive(); });
V.onRevive(() => { REVIVES.push(1); });

function freshBody() { V.reset(); DOWNS.length = 0; REVIVES.length = 0; }

// The smallest thing that looks like a car to fuel.js: a kind and an identity.
// `_fuelSeed` is set explicitly so a test's tank does not depend on where the
// test happened to park it.
function tank(kind, seed = 1) {
  return { kind, x: 0, z: 0, speed: 0, vGround: 0, _acc: 0, _fuelSeed: seed | 0 };
}

// The smallest thing that looks like a car to vitals.js: the body-frame
// velocity pair every impulse in vehicles.js is written into.
function ride(speed = 0) {
  return { speed, _lat: 0, _vy: 0, air: 0, y: 0 };
}

// ==========================================================================
// PRICES — one table, and it must stay one table
// ==========================================================================

// The freeze is not documentation. prices.js's header calls it "an assertion
// that fires at the scene of the crime", and an ES module is strict mode, so a
// write THROWS. If deepFreeze ever stops walking into a nested object or an
// array, a "temporary" discount in a shop handler becomes permanent and global.
test('nothing in the game can write to a price', () => {
  assert.throws(() => { PRICE.gun.pistol = 0; }, TypeError, 'a scalar two levels down is writable');
  assert.throws(() => { PRICE.fuel.base.benzin = 1; }, TypeError, 'the fuel base is writable');
  assert.throws(() => { PRICE.cars[0].price = 1; }, TypeError, 'a row inside the car array is writable');
  assert.throws(() => { PRICE.fuel.brands[0].d = 99; }, TypeError, 'a brand offset is writable');
  assert.throws(() => { PRICE.fuel.brands[0].tags.push('x'); }, TypeError, 'a tag list is writable');
  assert.throws(() => { PRICE.cars.push({}); }, TypeError, 'the car ladder can be extended');
  assert.throws(() => { PRICE.food[0].hp = 999; }, TypeError, 'a plate is writable');
  assert.throws(() => { FUEL_PRICE.nafta = 0; }, TypeError, 'FUEL_PRICE is writable');
});

// The car ladder is keyed by vehicles.js's kind strings and is NOT alias-aware
// — prices.js imports nothing, so a typo here is a car nobody can buy and a
// lookup that comes back undefined. truck and bus are absent deliberately.
test('every car you can buy is a car the game can build', () => {
  assert.equal(CAR_KINDS.length, 8, `parsed ${CAR_KINDS.length} kinds out of vehicles.js, wanted 8`);
  const kinds = PRICE.cars.map((c) => c.kind);
  assert.equal(new Set(kinds).size, kinds.length, 'the ladder lists a kind twice');
  for (const k of kinds) assert.ok(CAR_KINDS.includes(k), `PRICE.cars sells "${k}", which vehicles.js cannot build`);
  for (const k of ['truck', 'bus']) assert.ok(!kinds.includes(k), `${k} is for sale — nobody sells you a bus`);
  // Ascending, strictly: a rung that costs the same as the one below it is not
  // a decision, and a rung that costs less is a trap.
  for (let i = 1; i < PRICE.cars.length; i++) {
    assert.ok(PRICE.cars[i].price > PRICE.cars[i - 1].price,
      `${PRICE.cars[i].kind} (${PRICE.cars[i].price}) is not above ${PRICE.cars[i - 1].kind}`);
  }
  for (const c of PRICE.cars) {
    assert.ok(c.name && c.note, `${c.kind}: a rung with no name or no note is a blank line in the bazaar`);
  }
});

// Food is the only thing that heals without a fee, so it is priced per hit
// point, and the discount for eating properly is the decision the menu exists
// to offer: expensive when you are badly hurt, cheap when you are topping up.
// A menu where Kč/hp ever RISES has no decision in it.
test('the menu gets cheaper per hit point as the plate gets bigger', () => {
  const f = PRICE.food;
  assert.ok(f.length >= 4, 'a menu of three is a vending machine');
  for (let i = 1; i < f.length; i++) {
    assert.ok(f[i].price > f[i - 1].price, `${f[i].id} does not cost more than ${f[i - 1].id}`);
    assert.ok(f[i].hp > f[i - 1].hp, `${f[i].id} does not heal more than ${f[i - 1].id}`);
    assert.ok(f[i].price / f[i].hp < f[i - 1].price / f[i - 1].hp,
      `${f[i].id} is worse value than ${f[i - 1].id} — the menu has no decision in it`);
  }
  // The scale these hp figures assume. If vitals ever leaves 100, they move.
  assert.equal(V.hpMax(), 100, 'PRICE.food is written against a 100-point body');
  // No single plate is a full heal, or the hospital has no job and the
  // expensive end of the menu is the only end.
  for (const p of f) assert.ok(p.hp < V.hpMax(), `${p.id} heals ${p.hp} of ${V.hpMax()} in one sitting`);
  // …but two of them can carry you from the floor to full, or being badly hurt
  // is unrecoverable without dying on purpose.
  assert.ok(f[f.length - 1].hp + f[f.length - 2].hp >= V.hpMax(),
    'the two best plates together cannot heal a body from zero');
});

test('the bulk box of ammunition is actually a discount, and the vest is a choice', () => {
  const g = PRICE.gun;
  assert.ok(g.box.price / g.box.rounds < g.ammo,
    `a box works out at ${g.box.price / g.box.rounds} a round against ${g.ammo} loose`);
  assert.ok(g.vest.price < g.pistol, 'armour costs more than a gun, so nobody buys armour');
  assert.ok(g.vest.price > g.pistol * 0.5, 'armour is so cheap it is not a decision');
  assert.ok(g.vest.armour > 0 && g.vest.armour <= 100, `a vest of ${g.vest.armour} is off the armour scale`);
});

// The brief's 2 400 is mechanical plus paint, and that identity is the only
// thing stopping the three numbers from drifting into disagreeing with each
// other the way the HUD and the garage already did once.
test('a full repair is exactly the two half repairs', () => {
  assert.equal(PRICE.garage.full, PRICE.garage.repair + PRICE.garage.respray);
  assert.ok(PRICE.garage.buy > PRICE.cars[PRICE.cars.length - 1].price,
    'the garage is cheaper than the car you keep in it');
});

test('the mission ladder starts inside its own bounds', () => {
  const m = PRICE.job.mission;
  assert.ok(m.min <= m.first && m.first <= m.max, `first ${m.first} is outside [${m.min}, ${m.max}]`);
  assert.ok(m.max > m.min * 2, 'the income curve barely moves, so nothing ever feels earned');
  const p = PRICE.job.pocket;
  assert.ok(p.min > 0 && p.max > p.min, 'a pocket has no spread');
  assert.ok(p.fat > 0 && p.fat < 0.15, `${p.fat} of the city carrying real cash is not a minority`);
  // Crime is bootstrap money and is meant to be WORSE than work. The luckiest
  // single pocket may rival one early mission; the average must not.
  assert.ok(p.max < m.first * 1.5, 'a lucky pocket beats a mission, so nobody takes a mission');
  assert.ok(p.min + p.fat * (p.max - p.min) < m.first * 0.25,
    'the average pocket is a quarter of a mission — mugging is the career');
});

// ---------------------------------------------------------------- pumps ----

test('pumpBrand is total: anything at all resolves to a forecourt', () => {
  const fallback = pumpBrand(null);
  assert.ok(fallback && typeof fallback.name === 'string' && fallback.name.length > 0);
  assert.equal(fallback.tags.length, 0, 'the fallback carries tags, so it can be matched by accident');
  for (const bad of [undefined, null, '', 0, 123, NaN, {}, [], true, { brand: 42 }]) {
    const b = pumpBrand(bad);
    assert.ok(PRICE.fuel.brands.includes(b), `pumpBrand(${String(bad)}) invented a row`);
  }
  assert.equal(pumpBrand('naprosto neznámá pumpa').id, fallback.id);
});

// Every brand has to be reachable by its own id AND by every word the world
// might print on it, or a station resolves to the base price and the whole
// point of the spread — a reason to drive to a particular pump — is gone.
test('every brand answers to its own id and to every tag it claims', () => {
  for (const b of PRICE.fuel.brands) {
    assert.equal(pumpBrand(b.id).id, b.id, `the id "${b.id}" does not resolve to itself`);
    for (const t of b.tags) {
      assert.equal(pumpBrand(t).id, b.id, `tag "${t}" resolves to ${pumpBrand(t).id}, not ${b.id}`);
      assert.equal(pumpBrand(t.toUpperCase()).id, b.id, `tag "${t}" is case-sensitive`);
    }
  }
});

// The trap prices.js's header names out loud: 'ono' is inside "ekonomik", so
// the id may only ever be matched by EQUALITY. A fuel price that depends on an
// accident of spelling is a bug nobody will ever find.
test('a short id is never matched as a substring of something else', () => {
  assert.equal(pumpBrand('ono').id, 'ono', 'the exact id pass is gone');
  for (const decoy of ['ekonomik', 'Monolit', 'Ekonom Oil', 'nonstop']) {
    assert.notEqual(pumpBrand(decoy).id, 'ono', `"${decoy}" was sold Tank ONO's discount`);
  }
});

test('Czech arrives with and without its háčky, and one company under three names', () => {
  for (const s of ['ČEPRO', 'CEPRO', 'Cepro', 'čepro TANKOMAT']) {
    assert.equal(pumpBrand(s).id, 'tankomat', `"${s}" did not resolve to ČEPRO`);
  }
  for (const s of ['Benzina', 'Benzina ORLEN', 'ORLEN Benzina', 'orlen']) {
    assert.equal(pumpBrand(s).id, 'benzina', `"${s}" did not resolve to Orlen Benzina`);
  }
  // EuroOil is listed before TANKOMAT precisely so this string finds the
  // forecourt with a till in it rather than the unmanned one.
  assert.equal(pumpBrand('ČEPRO EuroOil').id, 'eurooil');
  // …and a whole station object, however the world hands it over.
  assert.equal(pumpBrand({ brand: 'Shell' }).id, 'shell');
  assert.equal(pumpBrand({ name: 'OMV' }).id, 'omv');
  assert.equal(pumpBrand({ id: 'mol' }).id, 'mol');
  assert.equal(pumpBrand({ id: 'mol', name: 'Shell' }).id, 'mol', 'id must win over name');
});

test('a pump price is always money: finite, positive, and whole haléře', () => {
  const types = ['benzin', 'nafta', 'elektro', 'vodik', '', null, undefined, 7];
  for (const b of PRICE.fuel.brands) {
    for (const t of types) {
      const p = pumpPrice(b.id, t);
      assert.ok(Number.isFinite(p), `${b.id}/${String(t)} priced at ${p}`);
      assert.ok(p >= 0.5, `${b.id}/${String(t)} priced at ${p} — a free pump is a bug`);
      assert.ok(Math.abs(p * 100 - Math.round(p * 100)) < 1e-9,
        `${b.id}/${String(t)} = ${p} carries a fraction of a haléř`);
    }
  }
  // An unknown fuel is petrol, not NaN — a survivable wrong answer beats one
  // that propagates into the wallet and turns a purchase into a silent no-op.
  assert.equal(pumpPrice('shell', 'vodik'), pumpPrice('shell', 'benzin'));
  assert.equal(pumpPrice(null, 'elektro'), FUEL_PRICE.elektro);
});

// The spread is the whole reason brands exist, and its size is a design
// decision stated in the header: enough to be worth a two-minute detour, not
// enough to make the nearest pump a mistake.
test('the spread between the dearest and cheapest pump is worth a detour and no more', () => {
  let lo = Infinity, hi = -Infinity;
  for (const b of PRICE.fuel.brands) {
    const p = pumpPrice(b.id, 'benzin');
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  const spread = hi - lo;
  assert.ok(spread > 1.5 && spread < 4, `${spread.toFixed(2)} Kč/l of spread`);
  const perTank = spread * F.tankOf('fabia');
  assert.ok(perTank > 50 && perTank < 200,
    `shopping around saves ${perTank.toFixed(0)} Kč a tank — that is homework, not a choice`);
});

// ------------------------------------------------------------ formatting ----

test('kc prints koruny the way Czech prints them', () => {
  assert.equal(kc(0), '0' + NBSP + 'Kč');
  assert.equal(kc(45), '45' + NBSP + 'Kč');
  assert.equal(kc(1660), '1' + NBSP + '660' + NBSP + 'Kč');
  assert.equal(kc(250000), '250' + NBSP + '000' + NBSP + 'Kč');
  assert.equal(kc(-1234), '-1' + NBSP + '234' + NBSP + 'Kč');
  assert.equal(kc(1660.5), '1' + NBSP + '661' + NBSP + 'Kč', 'ties do not go away from zero');
});

// -0 is the bug this rounding order exists to prevent: a rounding artefact of
// four tenths of a koruna must not print as a debt.
test('a balance that rounds to nothing is never a debt', () => {
  assert.equal(kc(-0.4), '0' + NBSP + 'Kč');
  assert.equal(kc(-0), '0' + NBSP + 'Kč');
  assert.equal(kc2(-0.001), '0,00' + NBSP + 'Kč');
  assert.equal(kc2(-0), '0,00' + NBSP + 'Kč');
});

test('kc2 is a price board: decimal comma, two places, always', () => {
  assert.equal(kc2(36.9), '36,90' + NBSP + 'Kč');
  assert.equal(kc2(8.8), '8,80' + NBSP + 'Kč');
  assert.equal(kc2(0), '0,00' + NBSP + 'Kč');
  assert.equal(kc2(1234.5), '1' + NBSP + '234,50' + NBSP + 'Kč');
  assert.equal(kc2(-12.345), '-12,35' + NBSP + 'Kč');
  for (const b of PRICE.fuel.brands) {
    assert.match(kc2(pumpPrice(b.id, 'benzin')), /^\d+,\d\d Kč$/, `${b.id} does not print as a price`);
  }
});

// The HUD is allowed to break a line at any ASCII space. There isn't one, in
// either formatter, for any input — including the corrupt ones, which is where
// a "0" fallback could otherwise leak a String(undefined) into the layout.
test('neither formatter can produce garbage, a wrap point or an exponent', () => {
  const money = /^-?[\d ]+ Kč$/;
  const price = /^-?[\d ]+,\d\d Kč$/;
  for (const bad of [...CORRUPT, 0, -0, 1e300, -1e300, 9e15, 1e21, Number.MIN_VALUE]) {
    const a = kc(bad), b = kc2(bad);
    assert.match(a, money, `kc(${String(bad)}) = "${a}"`);
    assert.match(b, price, `kc2(${String(bad)}) = "${b}"`);
    for (const s of [a, b]) {
      assert.ok(!s.includes(' '), `"${s}" contains an ASCII space the HUD may wrap on`);
      assert.ok(!/NaN|undefined|null|e[+-]/i.test(s), `"${s}" leaked a non-number`);
    }
  }
});

// ==========================================================================
// WALLET — atomicity, and the four ways a balance dies
// ==========================================================================

test('a wallet starts at the starting balance and says so as a replacement', () => {
  W.setMoney(12345);
  WLOG.length = 0;
  W.reset();
  assert.equal(W.money(), W.START);
  assert.equal(WLOG.length, 1, 'reset told nobody');
  assert.equal(WLOG[0].what, 'set', 'a new game reported a transaction, so a HUD would ticker it');
});

// THE ONE THAT MATTERS. A short wallet must be left BYTE-identical — not
// "close", not "the price minus what was affordable". The bug this prevents is
// a pump that debits as it fills and strands the player with a part tank they
// paid for and a caller that was told the sale failed.
test('pay() is atomic — a short wallet is left exactly as it was', () => {
  freshWallet();
  W.setMoney(1000);
  WLOG.length = 0;

  assert.equal(W.pay(1001, 'benzín'), false, 'sold petrol on credit');
  assert.equal(W.money(), 1000, 'a refused sale moved the balance');
  assert.equal(WLOG.length, 0, 'a refused sale told the HUD something happened');

  // …and again with a price the player can ALMOST afford, which is the case a
  // partial debit would actually be reached by.
  assert.equal(W.pay(1000.49, 'benzín'), true, '1000,49 rounds to 1000 and was affordable');
  assert.equal(W.money(), 0);
  assert.equal(W.pay(1, 'benzín'), false);
  assert.equal(W.money(), 0, 'an empty wallet went negative');
});

// canPay and pay must answer the same question, for every input including the
// corrupt ones, or a caller that asks before it buys can be surprised by the
// buy — which is exactly how a shop ends up with a half-completed sale.
test('canPay(n) is true exactly when pay(n) would be', () => {
  for (const start of [0, 5, 2500, -300]) {
    for (const n of [...CORRUPT, -1, -0.4, 0, 0.4, 0.5, 1, 4, 5, 6, 2500, 2501, 1e12]) {
      freshWallet();
      W.setMoney(start);
      const predicted = W.canPay(n);
      const before = W.money();
      const actual = W.pay(n, 'test');
      assert.equal(actual, predicted,
        `at ${start}: canPay(${String(n)}) said ${predicted}, pay said ${actual}`);
      if (!actual) {
        assert.equal(W.money(), before, `a refused pay(${String(n)}) moved the balance`);
      }
    }
  }
});

// A free item is a completed sale. A caller that treats false as "the pump
// broke" would otherwise break on the one price it is guaranteed to afford.
test('a price of nothing is a sale, and it is a silent one', () => {
  freshWallet();
  W.setMoney(-500);                        // in debt, and a free thing is still free
  WLOG.length = 0;
  assert.equal(W.canPay(0), true);
  assert.equal(W.pay(0, 'zdarma'), true);
  assert.equal(W.money(), -500);
  assert.equal(WLOG.length, 0, '"nothing moved" was announced as a transaction');
  assert.equal(W.pay(0.4, 'skoro zdarma'), true, '0,4 Kč rounds to nothing and is free');
  assert.equal(W.money(), -500);
});

// Corrupt input is REFUSED, not coerced. Number('') is 0 and Number([]) is 0,
// and a silent zero looks exactly like a call that never happened.
test('money survives everything that is not money, and never becomes NaN', () => {
  for (const bad of CORRUPT) {
    freshWallet();
    const before = W.money();

    assert.equal(W.pay(bad, 'x'), false, `pay(${String(bad)}) succeeded`);
    assert.equal(W.money(), before, `pay(${String(bad)}) moved the balance`);

    W.earn(bad, 'x');
    assert.equal(W.money(), before, `earn(${String(bad)}) moved the balance`);

    W.setMoney(bad);
    assert.equal(W.money(), before, `setMoney(${String(bad)}) replaced a good balance with junk`);

    assert.ok(Number.isFinite(W.money()) && Number.isInteger(W.money()),
      `${String(bad)} left the balance at ${W.money()}`);
  }
  // And the property that outlives any single input: after a long shuffle of
  // good and corrupt calls, the balance is still a whole finite number.
  freshWallet();
  for (let i = 0; i < 500; i++) {
    const bad = CORRUPT[i % CORRUPT.length];
    W.earn(i % 7 === 0 ? bad : i, 'x');
    W.pay(i % 5 === 0 ? bad : i * 3, 'x');
    W.setMoney(i % 11 === 0 ? bad : W.money());
    assert.ok(Number.isInteger(W.money()), `step ${i} left ${W.money()}`);
  }
});

// A negative price is a corrupt price, never a gift.
test('a negative amount neither pays out nor takes in', () => {
  freshWallet();
  const before = W.money();
  assert.equal(W.pay(-500, 'záporná cena'), false);
  assert.equal(W.money(), before, 'pay(-500) handed out money');
  W.earn(-500, 'záporná odměna');
  assert.equal(W.money(), before, 'earn(-500) took money');
});

// THE RESTORED SAVE. setMoney is how a save comes back; if it does not notify,
// the number in the corner is the one from before the load. It must fire even
// when the balance did NOT move, because that is the case a save restored onto
// an identical balance produces, and it is the one an _apply()-style "stay
// quiet when nothing moved" would swallow.
test('setMoney always tells the HUD, even when the number did not change', () => {
  freshWallet();
  W.setMoney(37500);
  assert.equal(WLOG.length, 1);
  assert.equal(WLOG[0].what, 'set');
  assert.equal(WLOG[0].money, 37500, 'the listener was handed the balance from before the move');

  WLOG.length = 0;
  W.setMoney(37500);                      // the same number again
  assert.equal(WLOG.length, 1, 'a restore onto an identical balance left the HUD unsynchronised');
  assert.equal(WLOG[0].delta, 0);
  assert.equal(WLOG[0].what, 'set');

  WLOG.length = 0;
  W.setMoney(NaN);                        // …and even a corrupt one resynchronises
  assert.equal(WLOG.length, 1, 'a corrupt restore left the HUD unsynchronised');
  assert.equal(WLOG[0].money, 37500);
  assert.equal(WLOG[0].what, 'set');
});

// 'set' means SNAP, every other label means TICKER. A restored save must not
// fly a "+37 500 Kč" banner past the player.
test('a transaction and a replacement are told apart by their label', () => {
  freshWallet();
  W.earn(800, 'zakázka');
  W.pay(145, 'guláš');
  assert.deepEqual(WLOG.map((e) => e.what), ['zakázka', 'guláš']);
  assert.deepEqual(WLOG.map((e) => e.delta), [800, -145]);
  // The balance handed to the listener is the one AFTER the move, so a listener
  // that calls money() from inside its own callback reads the same thing.
  assert.equal(WLOG[1].money, W.money());
  // A non-string label is a caller bug and becomes '', never "undefined".
  WLOG.length = 0;
  W.earn(10);
  assert.equal(WLOG[0].what, '');
});

// The running total on screen has to sum to the balance underneath it. If a
// clipped earn reported what was ASKED for rather than what MOVED, the ticker
// and the number drift apart and only the player notices.
test('every delta reported sums back to the balance', () => {
  freshWallet();
  W.setMoney(0);
  WLOG.length = 0;
  let sum = 0;
  for (let i = 0; i < 300; i++) {
    if (i % 3 === 0) W.earn(i * 13 + 7, 'zakázka'); else W.pay(i * 5, 'benzín');
  }
  W.earn(1e12, 'absurdní výhra');          // must be clipped, and reported clipped
  W.pay(1e12, 'absurdní pokuta');
  for (const e of WLOG) sum += e.delta;
  assert.equal(sum, W.money(), 'the ticker and the balance disagree');
  assert.ok(Number.isInteger(W.money()));
});

test('the balance saturates instead of reaching Infinity', () => {
  freshWallet();
  for (let i = 0; i < 40; i++) W.earn(1e9, 'výhra');
  const hi = W.money();
  assert.ok(Number.isFinite(hi) && hi > 1e8, `saturated at ${hi}`);
  W.earn(1e9, 'ještě');
  assert.equal(W.money(), hi, 'the ceiling is not a ceiling');
  // Infinity − Infinity is how a wallet becomes NaN forever; it must not be
  // reachable from either end.
  W.setMoney(-1e300);
  assert.ok(Number.isFinite(W.money()) && W.money() < 0, `debt saturated at ${W.money()}`);
  assert.equal(W.money(), -hi, 'debt is bounded by a different figure than credit');
});

// After a successful pay() the balance is >= 0, always. Debt is reachable only
// through setMoney(), which is restore and dev.
test('pay() cannot open a debt, however hard it is pushed', () => {
  freshWallet();
  W.setMoney(500);
  for (let i = 0; i < 200; i++) {
    W.pay(Math.floor(Math.random() * 400), 'benzín');
    assert.ok(W.money() >= 0, `pay() opened a debt of ${W.money()}`);
  }
});

// init() being called twice is a normal thing for a HUD to survive, and a
// double-subscribed ticker counts every purchase twice.
test('the same listener cannot subscribe twice', () => {
  let n = 0;
  const count = () => { n++; };
  W.onChange(count);
  W.onChange(count);
  W.onChange(count);
  freshWallet();
  n = 0;
  W.earn(100, 'x');
  assert.equal(n, 1, `one change reached the listener ${n} times`);
  W.onChange(null);                        // and a non-function is ignored, not stored
  W.onChange(undefined);
  n = 0;
  W.earn(100, 'x');
  assert.equal(n, 1);
});

// One broken listener must not un-sell the petrol, and must not rob the other
// listeners of the event either.
test('a listener that throws does not take the transaction with it', () => {
  let boom = false, after = 0;
  W.onChange(() => { if (boom) throw new Error('HUD is on fire'); });
  W.onChange(() => { after++; });
  freshWallet();

  const warn = console.warn;
  console.warn = () => {};
  try {
    boom = true;
    after = 0;
    const before = W.money();
    assert.equal(W.pay(100, 'benzín'), true, 'a throwing listener un-sold the petrol');
    assert.equal(W.money(), before - 100, 'the balance was rolled back by a listener');
    assert.equal(after, 1, 'the throw robbed the listener behind it');
  } finally {
    console.warn = warn;
    boom = false;                          // inert for every test after this one
  }
});

// prices.js pays in decimals and this is the only place they become whole, so
// the rule — ties away from zero — has to hold for every amount pay() and
// earn() can be handed. It does, and trivially: _amount() refuses anything
// negative, and over the non-negatives Math.round IS ties-away-from-zero.
//
// The one door a negative decimal can come through is setMoney(), which is a
// restore or a dev key, and there the two rules part company: JavaScript breaks
// a tie toward +Infinity, so a balance of −1660,5 becomes −1660 rather than the
// −1661 the header promises. That is half a koruna on a path whose only real
// caller hands it an integer out of a save file, so this test pins what is
// actually load-bearing — the balance is a whole number after every call, it is
// never −0, and a charge never rounds in the player's favour — rather than
// asserting a claim the code does not make.
test('koruny become whole exactly once, and a charge never rounds down', () => {
  freshWallet();
  W.setMoney(0);
  W.earn(1660.5, 'x');
  assert.equal(W.money(), 1661);
  W.pay(0.5, 'x');
  assert.equal(W.money(), 1660);
  W.pay(1661.03 - 1000, 'benzín');         // 661,03 → 661
  assert.equal(W.money(), 999);

  // Written out rather than computed, so that 2,5 → 3 rules out the banker's
  // rounding somebody will eventually be tempted to "fix" this with.
  const TIES = [[0.49, 0], [0.5, 1], [0.51, 1], [1.5, 2], [2.5, 3], [42.5, 43], [1660.5, 1661]];
  for (const [asked, want] of TIES) {
    freshWallet();
    W.setMoney(100000);
    assert.equal(W.pay(asked, 'x'), true);
    assert.equal(100000 - W.money(), want, `pay(${asked}) took ${100000 - W.money()}`);
    freshWallet();
    W.setMoney(0);
    W.earn(asked, 'x');
    assert.equal(W.money(), want, `earn(${asked}) paid ${W.money()}`);
  }

  // Whatever comes through the restore door, the balance is a whole number and
  // never negative zero — a −0 balance is a "-0 Kč" bug report waiting for a
  // formatter that tests the sign bit.
  for (const n of [-1660.5, -0.4, -0.6, 0.5, 1e300, -1e300, ...CORRUPT]) {
    W.setMoney(n);
    assert.ok(Number.isInteger(W.money()), `setMoney(${String(n)}) left ${W.money()}`);
    assert.ok(!Object.is(W.money(), -0), `setMoney(${String(n)}) left negative zero`);
  }
  W.setMoney(-0.4);
  assert.equal(W.money(), 0);
});

// ==========================================================================
// VITALS — the body, and the transition that must not be a crash
// ==========================================================================

// THE REGRESSION THIS MODULE WAS SHAPED AROUND. A global "previous speed"
// bills every TRANSITION as a crash. Every assertion here would also pass if
// the damage model were simply switched off, so the second half of the test —
// the same car, hitting a wall — is not decoration, it is what makes the first
// half mean anything.
test('getting out of a fast car and into a parked one costs nothing', () => {
  freshBody();
  const moving = ride(30);
  for (let i = 0; i < 20; i++) V.update(0.05, { car: moving });
  assert.equal(V.hp(), 100, 'a steady 30 m/s cruise hurt the driver');

  // Step out. main.js states onFoot and may well leave a stale game.car behind
  // it, which is precisely the case that has to be survived.
  const p = { y: 0, vy: 0, grounded: true, inCar: null };
  for (let i = 0; i < 10; i++) V.update(0.05, { car: moving, onFoot: true, player: p });
  assert.equal(V.hp(), 100, 'stepping out of a moving car was billed as a crash');

  const parked = ride(0);
  for (let i = 0; i < 10; i++) V.update(0.05, { car: parked, player: p });
  assert.equal(V.hp(), 100, 'sitting down in a parked car cost 30 m/s of health');
  assert.equal(V.down(), false);

  // …and the detector is not merely asleep: the same car, into a wall.
  for (let i = 0; i < 30; i++) { parked.speed = Math.min(25, parked.speed + 0.9); V.update(0.05, { car: parked }); }
  assert.equal(V.hp(), 100, 'accelerating to 25 m/s was billed as a collision');
  parked.speed = 10;                       // vehicles.js scrubs a wall hit to 40 %
  V.update(0.05, { car: parked });
  assert.ok(V.hp() < 95, `a 90 km/h wall hit cost ${(100 - V.hp()).toFixed(1)} HP`);
});

// The helicopter arrives through a field called `car` — player.inCar holds
// whichever machine you actually sat in — so a rule that classified the SLOT
// instead of the OBJECT would read a rotor as a gearbox and difference two
// different frames against each other.
test('swapping a car for a helicopter and back is not two crashes', () => {
  freshBody();
  const car = ride(30);
  for (let i = 0; i < 10; i++) V.update(0.05, { car });
  assert.equal(V.hp(), 100);

  // Into the helicopter, already moving — which is the transition, not a jump.
  const heli = { rotorSpeed: 40, vx: 25, vy: -3, vz: 4, airborne: true, y: 60 };
  const rider = { y: 60, vy: 0, grounded: false, inCar: heli };
  for (let i = 0; i < 20; i++) V.update(0.05, { player: rider });
  assert.equal(V.hp(), 100, 'boarding a helicopter doing 25 m/s was billed as a crash');

  // …and out of it into a parked car, which is the same bug in reverse.
  rider.inCar = null;
  const parked = ride(0);
  for (let i = 0; i < 20; i++) V.update(0.05, { car: parked, player: rider });
  assert.equal(V.hp(), 100, 'climbing out of a helicopter cost 25 m/s of health');

  // Sanity, again: the helicopter's own rules still bill a real arrival. It is
  // the fragile machine and 12 m/s of sink killed in one step must hurt.
  freshBody();
  const h2 = { rotorSpeed: 40, vx: 0, vy: -12, vz: 0, airborne: true, y: 3 };
  V.update(0.05, { player: { y: 3, vy: 0, grounded: false, inCar: h2 } });
  h2.vy = 0; h2.airborne = false; h2.y = 0;
  V.update(0.05, { player: { y: 0, vy: 0, grounded: false, inCar: h2 } });
  assert.ok(V.hp() < 90, `a 12 m/s helicopter arrival cost ${(100 - V.hp()).toFixed(1)} HP`);
});

// The calibration table in vitals.js's header is a published claim, measured at
// 60 fps against the engine's own 40 % wall scrub. If the curve or the
// thresholds move, these are the numbers that were promised.
test('a wall hit costs what the header says it costs', () => {
  const DT = 1 / 60;
  // km/h → the delta-v vehicles.js leaves behind (it keeps 40 %), → HP
  const CASES = [[50, 0.8], [90, 15.5], [130, 48.6]];
  for (const [kmh, want] of CASES) {
    freshBody();
    const v = kmh / 3.6;
    const c = ride(v);
    V.update(DT, { car: c });              // baseline
    c.speed = v * 0.4;
    V.update(DT, { car: c });
    const got = 100 - V.hp();
    assert.ok(Math.abs(got - want) < 0.15, `${kmh} km/h into a wall cost ${got.toFixed(1)} HP, not ${want}`);
  }
  // 180 km/h is the end of it in the open.
  freshBody();
  const bare = ride(50);
  V.update(DT, { car: bare });
  bare.speed = 20;
  V.update(DT, { car: bare });
  assert.equal(V.hp(), 0, '180 km/h into a wall was survivable');
  assert.equal(V.down(), true);
  assert.deepEqual(DOWNS, ['náraz'], 'the death card was told the wrong cause');

  // The curve is NOT capped at HP_MAX, and this is the pair of assertions that
  // says what that buys. Capped, the full 100 points of armour the module
  // allows would absorb ANY crash whole and leave health untouched at any
  // speed. Uncapped, the same 180 km/h hit spends the vest and still reaches
  // the body…
  freshBody();
  V.addArmour(100);
  const vest = ride(50);
  V.update(DT, { car: vest });
  vest.speed = 20;
  V.update(DT, { car: vest });
  assert.equal(V.armour(), 0, 'a full vest walked away from 180 km/h with armour to spare');
  assert.ok(V.hp() < 90 && V.hp() > 0,
    `180 km/h in a full vest left ${V.hp().toFixed(1)} HP — a vest is neither a sponge nor a second life`);

  // …and a hard enough one kills through it outright. 280 km/h is 46,7 m/s of
  // delta-v, which the quadratic charges at 336 points: the vest is not a
  // fatality you can buy your way out of.
  freshBody();
  V.addArmour(100);
  const fatal = ride(77.8);
  V.update(DT, { car: fatal });
  fatal.speed = 77.8 * 0.4;
  V.update(DT, { car: fatal });
  assert.equal(V.hp(), 0, '280 km/h into a bridge abutment was walked away from in a vest');
  assert.equal(V.down(), true);

  // And the same 90 km/h arriving SIDEWAYS costs more, because the lateral
  // scrub is harsher and because there is a door where the bonnet should be.
  freshBody();
  const s = ride(0);
  s._lat = 25;
  V.update(DT, { car: s });
  s._lat = 25 * 0.3;
  V.update(DT, { car: s });
  const sideways = 100 - V.hp();
  assert.ok(Math.abs(sideways - 25.8) < 0.2, `a 90 km/h broadside cost ${sideways.toFixed(1)} HP, not 25.8`);
});

test('armour is spent before health, and a vest is not a second life', () => {
  freshBody();
  V.addArmour(50);
  assert.equal(V.armour(), 50);
  V.damage(30, 'náraz');
  assert.equal(V.armour(), 20, 'the vest did not take the hit');
  assert.equal(V.hp(), 100, 'the hit went through a vest that had room');
  V.damage(30, 'náraz');
  assert.equal(V.armour(), 0);
  assert.equal(V.hp(), 90, 'the overflow past the vest was lost');
  // The cap holds from both directions, and corrupt input adds nothing.
  V.addArmour(1e9);
  assert.equal(V.armour(), 100);
  for (const bad of CORRUPT) V.addArmour(bad);
  assert.equal(V.armour(), 100);
  V.addArmour(-50);
  assert.equal(V.armour(), 100, 'a negative vest removed armour');
});

// The dead do not get deader. Two hospital bills for one crash is what a second
// onDown costs, and a HUD that re-raises the card restarts its own animation.
test('damage while down is a no-op, and onDown fires exactly once', () => {
  freshBody();
  V.damage(1000, 'havárie');
  assert.equal(V.down(), true);
  assert.equal(V.hp(), 0);
  assert.deepEqual(DOWNS, ['havárie'], 'the death card was told the wrong cause');

  // A wreck keeps tumbling for a second after it kills you — every one of those
  // steps reaches damage(), and not one of them may be a second death.
  const wreck = ride(0);
  for (let i = 0; i < 200; i++) {
    wreck.speed = (i % 7) * 6;             // violent, changing every step
    wreck._lat = (i % 5) * 5;
    V.update(0.05, { car: wreck });
    V.damage(500, 'znovu');
  }
  assert.equal(DOWNS.length, 1, `onDown fired ${DOWNS.length} times for one death`);
  assert.equal(V.hp(), 0, 'health moved while down');
  assert.equal(V.down(), true);
});

// `_down` is set BEFORE the callbacks run, and the ordering is load-bearing
// rather than tidy: main.js's real death handler ends up calling revive() from
// inside onDown, and revive() opens with `if (!_down) return;`. Fire first and
// set the flag afterwards and that call is a silent no-op — the player is left
// at 0 HP with the flag then stamped on top of them, the death card never comes
// down, and onRevive is never told anything happened.
test('a listener may revive the player from inside onDown', () => {
  freshBody();
  REVIVE_ON_DOWN = true;
  try {
    V.damage(1000, 'havárie');
  } finally {
    REVIVE_ON_DOWN = false;                // inert for every test after this one
  }
  assert.deepEqual(DOWNS, ['havárie'], 'the death was not announced');
  assert.equal(V.down(), false, 'revive() called from inside onDown was swallowed');
  assert.equal(V.hp(), V.hpMax(), `the player got back up with ${V.hp()} HP`);
  assert.equal(REVIVES.length, 1, 'onRevive was never told');
});

// Three separate reasons in the module, any one of which alone would do: the
// dead do not heal, hp climbing off 0 contradicts down(), and a body that
// healed past the floor would stand up mid-animation.
test('nothing regenerates or heals while the death card is up', () => {
  freshBody();
  V.damage(1000, 'havárie');
  for (let t = 0; t < 120; t += 0.05) V.update(0.05, null);
  assert.equal(V.hp(), 0, `two minutes on the floor healed to ${V.hp()}`);
  V.heal(50);
  assert.equal(V.hp(), 0, 'heal() quietly resurrected the player');
  assert.equal(V.down(), true);
  assert.equal(REVIVES.length, 0, 'onRevive fired without revive()');
});

// A slow trickle back to a FLOOR, not to full: full regeneration makes every
// crash free and deletes the reason to drive well.
test('the body walks off a scrape and nothing more', () => {
  freshBody();
  V.damage(70, 'náraz');
  assert.ok(Math.abs(V.hp() - 30) < 1e-9);

  // Nothing at all during the calm window.
  for (let t = 0; t < 6; t += 0.05) V.update(0.05, null);
  assert.ok(Math.abs(V.hp() - 30) < 1e-9, `regeneration started early, at ${V.hp()}`);

  for (let t = 0; t < 60; t += 0.05) V.update(0.05, null);
  const floor = V.hp();
  assert.ok(floor > 30 && floor < 100, `a minute of calm took ${floor} HP — the floor is wrong`);

  // …and it STOPS there, however long you wait.
  for (let t = 0; t < 600; t += 0.05) V.update(0.05, null);
  assert.equal(V.hp(), floor, `ten minutes of calm climbed past the floor to ${V.hp()}`);

  // A hit resets the calm window, so a body under continuous fire never heals.
  V.damage(5, 'náraz');
  const hurt = V.hp();
  for (let i = 0; i < 40; i++) { V.update(0.05, null); V.damage(0.0001, 'náraz'); }
  assert.ok(V.hp() <= hurt, 'regeneration ran while the body was still being hurt');

  // Food heals above the floor and the cap holds.
  V.heal(1000);
  assert.equal(V.hp(), V.hpMax());
  for (let t = 0; t < 60; t += 0.05) V.update(0.05, null);
  assert.equal(V.hp(), V.hpMax(), 'regeneration pulled a healthy body back down to the floor');
});

// A teleport is not a crash. Terrain arriving late drops a car through the
// world and vehicles.js re-seats it; a chunk streaming in snaps a walker up
// onto a support with a big negative vy still on the books.
test('a body re-seated by the terrain is not billed for the trip', () => {
  freshBody();
  // The car: airborne, then put back DOWN — that is a landing and it costs.
  const c = ride(20);
  c._vy = -14; c.air = 0.5; c.y = 5;
  V.update(0.05, { car: c });
  c._vy = 0; c.air = 0; c.y = 4.5;
  V.update(0.05, { car: c });
  const landed = 100 - V.hp();
  assert.ok(landed > 5 && landed < 25, `a 14 m/s landing cost ${landed.toFixed(1)} HP`);

  // The same numbers, but the car ended up HIGHER than it started: that is the
  // re-seat, and it must cost nothing.
  freshBody();
  const j = ride(20);
  j._vy = -14; j.air = 0.5; j.y = 5;
  V.update(0.05, { car: j });
  j._vy = 0; j.air = 0; j.y = 8;
  V.update(0.05, { car: j });
  assert.equal(V.hp(), 100, 'a car re-seated upward was billed as a landing');

  // On foot: a real fall hurts…
  freshBody();
  const p = { y: 20, vy: 0, grounded: false };
  V.update(0.05, { onFoot: true, player: p });
  p.vy = -20; p.y = 10;
  V.update(0.05, { onFoot: true, player: p });
  p.vy = 0; p.y = 0; p.grounded = true;
  V.update(0.05, { onFoot: true, player: p });
  const fell = 100 - V.hp();
  assert.ok(Math.abs(fell - 41.9) < 0.5, `a 20 m/s fall cost ${fell.toFixed(1)} HP, not ~42`);

  // …and a support arriving above your feet does not.
  freshBody();
  const q = { y: 20, vy: 0, grounded: false };
  V.update(0.05, { onFoot: true, player: q });
  q.vy = -20; q.y = 10;
  V.update(0.05, { onFoot: true, player: q });
  q.vy = 0; q.y = 12; q.grounded = true;   // the chunk landed above him
  V.update(0.05, { onFoot: true, player: q });
  assert.equal(V.hp(), 100, 'a chunk streaming in was billed as a five-storey fall');
});

test('a corrupt world cannot injure anybody', () => {
  freshBody();
  for (const bad of CORRUPT) V.damage(bad, 'x');
  assert.equal(V.hp(), 100, `a corrupt damage() took the body to ${V.hp()}`);
  for (const bad of CORRUPT) V.heal(bad);
  assert.equal(V.hp(), 100);

  // A car whose fields are junk: the sample is thrown away, not billed.
  const c = ride(20);
  V.update(0.05, { car: c });
  c.speed = NaN;
  V.update(0.05, { car: c });
  c.speed = 20; c._lat = Infinity;
  V.update(0.05, { car: c });
  c._lat = 0;
  V.update(0.05, { car: c });
  assert.ok(Number.isFinite(V.hp()), `health went to ${V.hp()}`);
  assert.equal(V.hp(), 100, 'a NaN in the physics was billed as a crash');

  // A corrupt dt must not move the module's own clock in EITHER direction, and
  // both directions are a real bug rather than a tidiness point: an Infinity
  // that lands in `_now` skips the calm window and heals the player instantly
  // and forever, while a NaN freezes the clock and regeneration never starts
  // again for the life of the session. So the assertion is two-sided — the
  // calm window still has to hold afterwards, and it still has to end.
  freshBody();
  V.damage(70, 'náraz');
  assert.ok(Math.abs(V.hp() - 30) < 1e-9);
  for (const bad of [NaN, Infinity, -Infinity, -1, 0, undefined, null, 1e9, '5']) V.update(bad, null);
  for (let t = 0; t < 6; t += 0.05) V.update(0.05, null);
  assert.ok(Math.abs(V.hp() - 30) < 1e-9,
    `a corrupt dt jumped the clock past the calm window — health is already ${V.hp()}`);
  for (let t = 0; t < 60; t += 0.05) V.update(0.05, null);
  assert.ok(V.hp() > 30, `a corrupt dt froze the clock — health is still ${V.hp()}`);
});

// The voiding on revive is not housekeeping: the caller teleports the body (and
// possibly its car) BEFORE calling revive(), and a stale sample would bill that
// teleport as the crash that killed you all over again.
test('revive() voids every sample, so the teleport home is not a second crash', () => {
  freshBody();
  V.addArmour(100);                        // the wreck takes the vest with it
  const c = ride(50);
  V.update(0.05, { car: c });
  c.speed = 0;                             // straight into a bridge
  V.update(0.05, { car: c });
  assert.equal(V.down(), true);

  // Armour is spent before health on every path, so a body that is down always
  // has an empty vest already — there is no way to die in one. That is worth
  // asserting on its own, and it is also why the line below has to put a vest
  // back ON the corpse before reviving: it is the only way to observe that the
  // hospital does not hand one back. A hospital that returned you fully kitted
  // would make the armour shop pointless.
  assert.equal(V.armour(), 0, 'a lethal hit left armour on the corpse');
  V.addArmour(75);
  c.speed = 40;                            // main.js has moved the car and the body
  c.y = 300;
  V.revive();
  assert.equal(V.hp(), V.hpMax());
  assert.equal(V.armour(), 0, 'the hospital handed the vest back');
  assert.equal(V.down(), false);
  assert.equal(REVIVES.length, 1);

  V.update(0.05, { car: c });
  assert.equal(V.hp(), V.hpMax(), 'the respawn teleport was billed as a crash');
  // …and revive() on a living body does nothing at all.
  V.damage(20, 'náraz');
  V.revive();
  assert.equal(V.hp(), 80, 'revive() healed a living body');
  assert.equal(REVIVES.length, 1, 'onRevive fired for a body that was never down');
});

// ==========================================================================
// FUEL — what a car takes, how full it was, and how far it goes
// ==========================================================================

// The eight tanks are all different sizes, and that is what makes this test
// possible: a kind that fell down the unknown-kind fallback would come back
// with the Octavia's 50 litres and collide with the Octavia. Eight distinct
// tanks proves eight distinct rows.
test('all eight car kinds have a tank of their own', () => {
  assert.equal(CAR_KINDS.length, 8, `parsed ${CAR_KINDS.length} kinds out of vehicles.js`);
  const tanks = CAR_KINDS.map((k) => F.tankOf(k));
  assert.equal(new Set(tanks).size, 8, 'two kinds share a tank size — one of them fell down the fallback');
  for (const t of tanks) assert.ok(Number.isFinite(t) && t > 0, `a tank of ${t}`);
});

// The classification is derived by hand from ENG_KINDS in js/audio.js and
// written out in fuel.js's header — knock >= 0.05 or rpmMax <= 4500 is a
// diesel, no engine cycle is electric. A car that clatters like a diesel and
// takes benzín at the pump is the small lie a player notices once.
test('every kind takes what it sounds like', () => {
  const WANT = {
    octavia: 'benzin', fabia: 'benzin', bmw: 'benzin', mercedes: 'benzin',
    van: 'nafta', truck: 'nafta', bus: 'nafta', tesla: 'elektro',
  };
  for (const k of CAR_KINDS) {
    assert.ok(WANT[k], `vehicles.js has a kind "${k}" this test has never heard of`);
    assert.equal(F.fuelTypeOf(k), WANT[k], `${k} pulls up at the wrong pump`);
  }
  // The three types are the three prices.js sells, and no fourth exists.
  for (const k of CAR_KINDS) {
    assert.ok(Number.isFinite(FUEL_PRICE[F.fuelTypeOf(k)]), `${k} takes a fuel with no price`);
    assert.ok(PRICE.fuel.label[F.fuelTypeOf(k)], `${k} takes a fuel with no name on the board`);
    assert.ok(PRICE.fuel.unit[F.fuelTypeOf(k)], `${k} takes a fuel sold by no unit`);
  }
});

// Pre-v4 saves and main.js's own spawn list still say these names. An alias
// that stopped resolving would not throw — it would silently sell a diesel van
// petrol, or give a Fabia the Octavia's tank.
test('the four legacy names resolve rather than falling back', () => {
  // hatch and suv are provable: their targets have tanks the fallback does not.
  assert.equal(F.tankOf('hatch'), F.tankOf('fabia'), 'hatch no longer means fabia');
  assert.notEqual(F.tankOf('hatch'), F.tankOf('octavia'), 'hatch fell down the fallback');
  assert.equal(F.tankOf('suv'), F.tankOf('bmw'), 'suv no longer means bmw');
  assert.notEqual(F.tankOf('suv'), F.tankOf('octavia'), 'suv fell down the fallback');
  // sedan and kombi both mean octavia, which is also the fallback, so all this
  // can pin is the answer — stated so nobody later mistakes it for proof.
  assert.equal(F.tankOf('sedan'), F.tankOf('octavia'));
  assert.equal(F.tankOf('kombi'), F.tankOf('octavia'));
  for (const a of ['sedan', 'hatch', 'kombi', 'suv']) {
    assert.equal(F.fuelTypeOf(a), 'benzin', `the legacy name ${a} pulls up at the wrong pump`);
  }
});

// A corrupt save gets a petrol Škoda, not a crash.
test('an unknown kind is a petrol Octavia and never a throw', () => {
  for (const bad of [null, undefined, '', 'gripen', 'heli', 'traktor', 123, {}, [], NaN, true]) {
    let type, size;
    assert.doesNotThrow(() => { type = F.fuelTypeOf(bad); size = F.tankOf(bad); },
      `fuelTypeOf(${String(bad)}) threw`);
    assert.equal(type, 'benzin', `${String(bad)} was classified as ${type}`);
    assert.equal(size, F.tankOf('octavia'), `${String(bad)} got a tank of ${size}`);
  }
});

// "There's a Fabia by the bridge and it's nearly empty" has to be a fact two
// players share rather than two different rumours.
test('the fuel in a found car is deterministic and lives inside the tank', () => {
  for (const kind of CAR_KINDS) {
    const cap = F.tankOf(kind);
    for (let s = -3000; s < 3000; s += 97) {
      const a = F.levelOf(tank(kind, s));
      const b = F.levelOf(tank(kind, s));
      assert.equal(a, b, `${kind}/${s}: two clients read different tanks`);
      assert.ok(Number.isFinite(a), `${kind}/${s}: a tank of ${a}`);
      assert.ok(a > 0, `${kind}/${s}: a found car was dead on the spot`);
      assert.ok(a <= cap, `${kind}/${s}: ${a} litres in a ${cap} litre tank`);
      assert.ok(a >= cap * 0.12 - 1e-9, `${kind}/${s}: ${(a / cap).toFixed(3)} of a tank is below the floor`);
    }
  }
  // The two other identity paths: traffic's own per-slot seed, and a parked
  // car's position quantised to the half metre.
  const byAi = () => ({ kind: 'fabia', x: 0, z: 0, ai: { seed: 424242 } });
  assert.equal(F.levelOf(byAi()), F.levelOf(byAi()), 'a scheduled car re-seeds per read');
  const byPos = () => ({ kind: 'fabia', x: 137.25, z: -908.75 });
  assert.equal(F.levelOf(byPos()), F.levelOf(byPos()), 'a parked car re-seeds per read');
  assert.notEqual(F.levelOf(byPos()), F.levelOf({ kind: 'fabia', x: 500, z: 500 }),
    'every parked car in the city has the same tank');

  // Triangular, not uniform: most cars you open are near half, and both
  // extremes are rare enough to be worth mentioning to the other player.
  let sum = 0, low = 0, high = 0;
  const N = 4000;
  for (let s = 0; s < N; s++) {
    const f = F.levelOf(tank('fabia', s * 2654435761 | 0)) / F.tankOf('fabia');
    sum += f;
    if (f < 0.2) low++;
    if (f > 0.9) high++;
  }
  const mean = sum / N;
  assert.ok(Math.abs(mean - 0.55) < 0.02, `the average found car is ${mean.toFixed(3)} of a tank`);
  assert.ok(low / N < 0.05, `${(low / N * 100).toFixed(1)} % of cars are nearly empty — that is an emergency a minute`);
  assert.ok(high / N < 0.05, `${(high / N * 100).toFixed(1)} % of cars are brimmed`);
  assert.ok(low / N > 0.003 && high / N > 0.003, 'the extremes never happen at all, so they mean nothing');
});

// reset() has no registry to walk, so it bumps a generation and lets each car
// re-seed. `_fuelSeed` survives on purpose: the Fabia by the bridge comes back
// with the same fumes, which is what a reset is supposed to mean.
test('reset gives every car its factory tank back, not a new one', () => {
  const c = tank('fabia', 999);
  const factory = F.levelOf(c);
  F.fill(c, Infinity);
  assert.equal(F.levelOf(c), F.tankOf('fabia'));
  F.reset();
  assert.equal(F.levelOf(c), factory, 'reset re-rolled the tank instead of restoring it');
});

test('fill() clamps, and reports what actually went in so the bill cannot exceed the tank', () => {
  for (const kind of CAR_KINDS) {
    const cap = F.tankOf(kind);
    const c = tank(kind, 7);
    const start = F.levelOf(c);

    const put = F.fill(c, Infinity);
    assert.ok(Math.abs(put - (cap - start)) < 1e-9, `${kind}: asked for a brim, got ${put} of ${cap - start}`);
    assert.ok(Math.abs(F.levelOf(c) - cap) < 1e-9, `${kind}: a brimmed tank holds ${F.levelOf(c)} of ${cap}`);
    assert.equal(F.fill(c, 40), 0, `${kind}: a full tank took another 40 litres`);
    assert.equal(F.fill(c, Infinity), 0, `${kind}: a full tank took an infinite fill`);

    // The property the pump bills on: over any sequence of fills, the total
    // that went in can never exceed the tank, and the tank never overfills.
    const d = tank(kind, 8);
    let total = 0;
    let level = F.levelOf(d);
    for (let i = 0; i < 200; i++) {
      const asked = (i % 13) * 7 + 0.5;
      const got = F.fill(d, asked);
      assert.ok(got >= 0 && got <= asked + 1e-9, `${kind}: asked ${asked}, took ${got}`);
      total += got;
      assert.ok(F.levelOf(d) <= cap + 1e-9, `${kind}: overfilled to ${F.levelOf(d)}`);
      assert.ok(F.levelOf(d) >= level - 1e-9, `${kind}: a fill removed fuel`);
      level = F.levelOf(d);
    }
    assert.ok(total <= cap + 1e-9, `${kind}: billed ${total} litres into a ${cap} litre tank`);

    // Corrupt asks put nothing in and bill nothing.
    const before = F.levelOf(d);
    for (const bad of CORRUPT) assert.equal(F.fill(d, bad), 0, `${kind}: fill(${String(bad)}) charged for something`);
    assert.equal(F.fill(d, -50), 0);
    assert.equal(F.levelOf(d), before, `${kind}: a corrupt fill moved the level`);
  }
  assert.equal(F.fill(null, 40), 0, 'filling nothing charged for it');
});

// stepGame(dt) runs SEVERAL times per rendered frame — main.js clamps to 50 ms
// and loops — so the bill for a stretch of road must not depend on how it was
// chopped up. There is no accumulator in burn() and this is what proves it.
test('splitting a step three ways bills the same metres', () => {
  const V0 = 25;
  for (const kind of CAR_KINDS) {
    const drive = (dt, steps) => {
      const c = tank(kind, 3);
      F.fill(c, Infinity);
      c.vGround = V0;
      const full = F.levelOf(c);
      for (let i = 0; i < steps; i++) F.burn(c, dt);
      return full - F.levelOf(c);
    };
    const whole = drive(0.05, 300);        // 15 s at the frame clamp
    const third = drive(0.05 / 3, 900);    // the same 15 s, three steps a frame
    const tenth = drive(0.005, 3000);
    assert.ok(Math.abs(whole - third) < whole * 1e-9,
      `${kind}: 3 steps a frame burned ${third}, one step burned ${whole}`);
    assert.ok(Math.abs(whole - tenth) < whole * 1e-9,
      `${kind}: ten steps a frame burned ${tenth}, one step burned ${whole}`);
  }
});

test('burn is monotonic and can never take a tank below zero', () => {
  const DTS = [1e-6, 0.001, 0.05, 0.1, 0.5, 5, 1e6, Infinity, NaN, -1, 0, null, undefined];
  // Every run below is started NEARLY DRY and then driven through zero, and
  // that is the whole design of this test rather than an optimisation. A
  // missing clamp does not show up while there is fuel left; and a tank that
  // does go negative does not merely read as negative, it fails levelOf's
  // `v >= 0` guard and re-seeds itself back to a factory tankful of free fuel.
  // Nibbling the top of a full tank for a few thousand steps would have proved
  // neither half, which is exactly what an earlier version of this test did.
  for (const kind of ['fabia', 'tesla', 'truck']) {
    for (const dt of DTS) {
      const c = tank(kind, 11);
      c.vGround = 400;
      for (let i = 0; i < 2e5 && F.levelOf(c) > 0.05; i++) F.burn(c, 0.1);
      assert.ok(F.levelOf(c) <= 0.05, `${kind}: could not be driven down to the last litre`);

      let last = F.levelOf(c);
      for (let i = 0; i < 3000; i++) {
        F.burn(c, dt);
        const now = F.levelOf(c);
        assert.ok(Number.isFinite(now), `${kind}/dt=${String(dt)}: tank went to ${now}`);
        assert.ok(now >= 0, `${kind}/dt=${String(dt)}: tank went to ${now}`);
        assert.ok(now <= last + 1e-12, `${kind}/dt=${String(dt)}: burning put fuel IN`);
        last = now;
      }
      // …and at every dt that moves the car a sensible distance, it really did
      // reach empty and stay there, so the loop above was not passing on a tank
      // nothing ever touched. (1e-6 is excluded because 0,4 mm a step genuinely
      // cannot spend a litre in three thousand steps.)
      if (typeof dt === 'number' && dt >= 0.001) {
        assert.equal(last, 0, `${kind}/dt=${dt}: an all-but-empty tank never reached zero`);
        assert.equal(F.dry(c), true, `${kind}/dt=${dt}: an empty tank does not report itself dry`);
      }
    }
  }
  // Standing still is free, at any dt — a tank that empties while the player
  // reads a map is the one failure this whole model refuses to have. The second
  // speed is the reason there is a deadband at all rather than a bare `v > 0`:
  // a car sat at a red light does not report a clean zero, it jitters in the
  // last decimals of the integrator, and 2 cm/s billed for an hour of game time
  // is a slow leak with no cause the player can see.
  for (const dt of DTS) {
    for (const v of [0, 0.02, -0.02]) {
      const c = tank('fabia', 12);
      c.vGround = v;
      const before = F.levelOf(c);
      for (let i = 0; i < 2000; i++) F.burn(c, dt);
      assert.equal(F.levelOf(c), before, `a parked car burned fuel at ${v} m/s, dt=${String(dt)}`);
    }
  }

  // A step longer than one frame is a hidden tab or a paused debugger, and the
  // car did NOT travel vGround × dt metres while the screen was frozen. The
  // rule is CLAMP rather than reject, so the property is two-sided: every
  // oversized step bills the same as every other oversized step (there is a
  // ceiling), and that ceiling is a fraction of a second rather than the
  // seconds it was handed (the ceiling is small).
  const oneStep = (dt) => {
    const c = tank('fabia', 15);
    F.fill(c, Infinity);
    c.vGround = 25;
    const full = F.levelOf(c);
    F.burn(c, dt);
    return full - F.levelOf(c);
  };
  const frame = oneStep(0.05);
  assert.ok(frame > 0);
  const huge = oneStep(5);
  assert.equal(oneStep(0.5), huge, 'two oversized steps bill differently — there is no ceiling');
  assert.equal(oneStep(1e6), huge, 'an absurd step is not clamped with the merely large ones');
  assert.equal(oneStep(Infinity), huge, 'an infinite step is not clamped');
  assert.ok(huge >= frame, 'a clamped step bills less than an ordinary frame');
  assert.ok(huge <= frame * 3,
    `one 5-second step billed ${(huge / frame).toFixed(1)} frames — a hidden tab drains the tank`);
  // A corrupt speed empties the tank at worst; it never makes it NaN.
  for (const v of [Infinity, NaN, -50, null, undefined]) {
    const c = tank('fabia', 13);
    c.vGround = v;
    for (let i = 0; i < 50; i++) F.burn(c, 0.05);
    assert.ok(Number.isFinite(F.levelOf(c)) && F.levelOf(c) >= 0,
      `vGround=${String(v)} left ${F.levelOf(c)} in the tank`);
  }
  // And traffic's own cars are refused outright: a fuel model that can reach
  // zero can strand a scheduled car in lane one, and nothing knows how to tow it.
  const ai = { kind: 'fabia', x: 0, z: 0, vGround: 30, _acc: 4, _fuelSeed: 14, ai: { seed: 5 } };
  const before = F.levelOf(ai);
  for (let i = 0; i < 5000; i++) F.burn(ai, 0.05);
  assert.equal(F.levelOf(ai), before, 'an AI car burned fuel and can now strand itself');
});

// The bill is per metre, so braking can only remove metres you were going to
// pay for anyway. There is no way to make a journey cheaper by driving worse,
// and no way to make it more than twice as dear by driving badly.
test('acceleration costs, braking is free, and the penalty has a ceiling', () => {
  const burnFor = (acc) => {
    const c = tank('fabia', 21);
    F.fill(c, Infinity);
    c.vGround = 25; c._acc = acc;
    const full = F.levelOf(c);
    for (let i = 0; i < 400; i++) F.burn(c, 0.05);
    return full - F.levelOf(c);
  };
  const cruise = burnFor(0);
  assert.ok(cruise > 0);
  assert.equal(burnFor(-5), cruise, 'braking made the same metres cheaper');
  assert.equal(burnFor(-1e9), cruise, 'an absurd deceleration was a refund');
  for (const bad of [NaN, undefined, null]) {
    assert.equal(burnFor(bad), cruise, `_acc=${String(bad)} changed the bill`);
  }
  // 4 m/s² is a hot hatch at full throttle: 1 + 0.18 × 4 = ×1.72.
  assert.ok(Math.abs(burnFor(4) / cruise - 1.72) < 1e-9, `a hard launch cost ×${burnFor(4) / cruise}`);
  // …and the cap is exactly double, reached only by the Tesla off the line.
  assert.ok(Math.abs(burnFor(12) / cruise - 2) < 1e-9, `the ceiling is ×${burnFor(12) / cruise}`);
  assert.ok(Math.abs(burnFor(1e6) / cruise - 2) < 1e-9, 'the ceiling is not a ceiling');
});

test('dry() and frac() agree with the tank, and a corrupt tank cannot bend a needle', () => {
  const c = tank('fabia', 31);
  assert.equal(F.dry(c), false);
  assert.ok(F.frac(c) > 0 && F.frac(c) < 1);
  F.fill(c, Infinity);
  assert.ok(Math.abs(F.frac(c) - 1) < 1e-12);
  c.vGround = 40;
  for (let i = 0; i < 2e6 && !F.dry(c); i++) F.burn(c, 0.1);
  assert.equal(F.dry(c), true);
  assert.equal(F.frac(c), 0);
  assert.equal(F.levelOf(c), 0);
  // Junk on the car, out of a save or a dev key, and there are two behaviours
  // here rather than one. fill() is used first because it stamps the CURRENT
  // generation — without that the level is stale and levelOf re-seeds before it
  // ever looks at the corrupt value, which is a test that proves nothing.
  //
  // A value that fails levelOf's own guard is thrown away and the car comes
  // back with its factory tank…
  for (const bad of [NaN, -5, 'plno', null, undefined, {}]) {
    const d = tank('fabia', 32);
    F.fill(d, Infinity);
    d._fuel = bad;
    const lvl = F.levelOf(d);
    assert.ok(Number.isFinite(lvl) && lvl >= 0 && lvl <= F.tankOf('fabia'),
      `a tank of ${String(bad)} read back as ${lvl}`);
    assert.ok(F.frac(d) >= 0 && F.frac(d) <= 1, `a tank of ${String(bad)} put the needle at ${F.frac(d)}`);
  }
  // …but a value that passes it is BELIEVED, and then the clamp in frac() is
  // the only thing between a corrupt save and a needle wound twice round the
  // dial. 1e9 litres in a 45 litre tank is the case the clamp is there for.
  for (const bad of [1e9, Infinity, F.tankOf('fabia') * 2]) {
    const d = tank('fabia', 33);
    F.fill(d, Infinity);
    d._fuel = bad;
    assert.equal(F.frac(d), 1, `${String(bad)} litres in a 45 litre tank read as ${F.frac(d)} of full`);
  }
  assert.equal(F.frac(null), 0);
  assert.equal(F.levelOf(null), 0);
  assert.equal(F.dry(null), false, 'nothing at all reported itself as an empty car');
});

// ==========================================================================
// RANGE — the assertion this file exists for
//
// fuel.js's first design was measured 8x to 16x wrong, because it integrated a
// road-load model over a throttle that is an INTEGER and therefore bang-bang:
// it charged a full-throttle engine for every metre the player was not braking,
// and the Tesla came out with 1.7 km of range. Nothing else in this file would
// have caught that. A gauge still moved, a tank still emptied, fill() still
// clamped, and every unit test passed.
//
// So: drive each kind at a steady 25 m/s (90 km/h, the speed the whole city is
// laid out for) with no acceleration penalty, until the tank is dry, and check
// the kilometres against a band. The bands below are the design's own figures —
// tank ÷ (l/100 km), cross-checked against the MEASURED motorway column in
// fuel.js's header — with ±10 % either side. Ten per cent is deliberately much
// tighter than the error it is aimed at: an 8x mistake misses by 700 %, and a
// band that only caught 8x would also accept a car that quietly does 200 km
// less than its own header claims.
//
// The two bands the brief names are FABIA 500-700 km and TESLA 300-400 km, and
// both of those are asserted separately at the end, because they are the
// contract rather than the calibration.
// ==========================================================================

const RANGE_KM = {
  //          low   high    design figure (tank ÷ per100 × 100)
  octavia:  [600,  720],    // 658 — 50 L at 7.6
  fabia:    [590,  700],    // 643 — 45 L at 7.0
  bmw:      [550,  660],    // 600 — 60 L at 10.0
  mercedes: [590,  710],    // 647 — 66 L at 10.2, the heavier and thriftier six
  van:      [670,  810],    // 737 — 70 L of diesel at 9.5
  truck:    [850, 1030],    // 938 — 300 L at 32.0
  bus:      [650,  790],    // 714 — 250 L at 35.0
  tesla:    [345,  400],    // 381 — 80 kWh at 21.0, and the brief's own ceiling
};

// A full tank, driven flat out in a straight line at 25 m/s until it dies.
// dt is 0.1 — under fuel.js's own DT_MAX, so nothing is clamped and the metres
// counted are the metres billed.
function rangeKm(kind) {
  const c = tank(kind, 1);
  F.fill(c, Infinity);
  c.vGround = 25;
  c._acc = 0;
  const dt = 0.1, step = 25 * dt;
  let m = 0;
  for (let i = 0; i < 5e6 && !F.dry(c); i++) { F.burn(c, dt); m += step; }
  assert.ok(F.dry(c), `${kind} never ran out — five million steps is 12 500 km`);
  return m / 1000;
}

test('a full tank goes the distance the design says it goes', () => {
  for (const kind of CAR_KINDS) {
    const band = RANGE_KM[kind];
    assert.ok(band, `vehicles.js has a kind "${kind}" with no range band in this test`);
    const km = rangeKm(kind);
    assert.ok(km >= band[0] && km <= band[1],
      `${kind}: ${km.toFixed(0)} km on a tank, wanted ${band[0]}-${band[1]}`);
  }
});

test("the brief's two acceptance ranges hold", () => {
  const fabia = rangeKm('fabia');
  assert.ok(fabia >= 500 && fabia <= 700, `a Fabia does ${fabia.toFixed(0)} km, wanted 500-700`);
  const tesla = rangeKm('tesla');
  assert.ok(tesla >= 300 && tesla <= 400, `a Tesla does ${tesla.toFixed(0)} km, wanted 300-400`);
  // And the ordering that has to survive a glance: the electric car is the
  // shortest-legged thing in the city, which is the reason to think before
  // taking it.
  for (const kind of CAR_KINDS) {
    if (kind === 'tesla') continue;
    assert.ok(rangeKm(kind) > tesla, `${kind} runs out before the Tesla does`);
  }
});

// The worst any player can actually drive — stop, launch, stop again — must
// still leave a usable car. fuel.js's header measures that style at 561 km for
// an Octavia against 655 on the motorway; the property is that the penalty is
// a cost you feel at the pump and not a curve to optimise around.
test('driving badly costs a fifth of the range, not four fifths', () => {
  for (const kind of ['fabia', 'octavia', 'tesla']) {
    const c = tank(kind, 1);
    F.fill(c, Infinity);
    c.vGround = 25;
    const dt = 0.1, step = 25 * dt;
    let m = 0;
    // 150 m hops: launch hard for the first third, then coast.
    for (let i = 0; i < 5e6 && !F.dry(c); i++) {
      c._acc = (m % 150) < 50 ? 8 : 0;
      F.burn(c, dt);
      m += step;
    }
    const km = m / 1000, best = RANGE_KM[kind][0];
    assert.ok(km > best * 0.75,
      `${kind}: stop-start driving left only ${km.toFixed(0)} km against a floor of ${best}`);
  }
});

// ==========================================================================
// THE RATIOS — the claims prices.js's header makes, checked across modules
// ==========================================================================

// "Balance is not a property of any single number, it is a property of the
// RATIOS between them" — so the ratios are what a test can hold on to. Each of
// these spans two of the four modules, which is exactly where the drift the
// price table exists to prevent would reappear.
test('a full tank is about two early missions, and the wallet starts with one in it', () => {
  const fabiaTank = F.tankOf('fabia') * FUEL_PRICE.benzin;
  assert.equal(Math.round(fabiaTank), 1661, `a Fabia tank is ${fabiaTank.toFixed(2)} Kč`);

  const first = PRICE.job.mission.first;
  assert.ok(fabiaTank / first > 1.5 && fabiaTank / first < 2.5,
    `a tank is ${(fabiaTank / first).toFixed(2)} early missions — the pressure is wrong`);
  assert.ok(fabiaTank / PRICE.job.mission.max < 0.8,
    'a tank still hurts at the top rate, so nothing ever feels earned');

  // The starting balance fills a tank and still eats, and does not fill two.
  assert.ok(W.START > fabiaTank + PRICE.food[0].price, 'a new game cannot afford a tank and a párek');
  assert.ok(W.START < fabiaTank * 2, 'a new game starts with two tanks in its pocket');
});

test('a pistol, a repair and a garage sit where the header puts them', () => {
  const first = PRICE.job.mission.first, top = PRICE.job.mission.max;
  assert.ok(PRICE.gun.pistol / first > 3 && PRICE.gun.pistol / first < 5,
    `a pistol is ${(PRICE.gun.pistol / first).toFixed(1)} early missions`);
  assert.ok(PRICE.cars[0].price / first > 15 && PRICE.cars[0].price / first < 30,
    `the cheapest car is ${(PRICE.cars[0].price / first).toFixed(0)} early missions`);
  assert.ok(PRICE.garage.buy / top > 50, 'the garage is not the thing you buy last');
  // Dying costs most of a tank early and is an errand later.
  const fabiaTank = F.tankOf('fabia') * FUEL_PRICE.benzin;
  const wasted = PRICE.hospital.fee + PRICE.garage.full;
  assert.ok(wasted > fabiaTank && wasted < fabiaTank * 2.5,
    `one bad afternoon costs ${(wasted / fabiaTank).toFixed(1)} tanks`);
  assert.ok(PRICE.hospital.fee < fabiaTank * 0.3,
    'the hospital fee alone empties the wallet, so dying is a save-reload');
});

// A delivery is the floor: always available, never fast. If it ever cost more
// in fuel than it paid, the one route back for a player who has spent their
// last koruna would be a trap.
test('a delivery always pays more than the petrol it burns', () => {
  const km = 4;
  const fare = PRICE.job.delivery.base + PRICE.job.delivery.perKm * km;
  for (const kind of CAR_KINDS) {
    const c = tank(kind, 41);
    F.fill(c, Infinity);
    c.vGround = 25;
    const before = F.levelOf(c);
    const dt = 0.1, step = 25 * dt;
    for (let m = 0; m < km * 1000; m += step) F.burn(c, dt);
    const spent = (before - F.levelOf(c)) * FUEL_PRICE[F.fuelTypeOf(kind)];
    assert.ok(spent < fare * 0.35,
      `${kind}: a ${km} km run burns ${spent.toFixed(0)} Kč against a ${fare} Kč fare`);
  }
  assert.ok(fare / PRICE.job.mission.first > 0.25 && fare / PRICE.job.mission.first < 0.6,
    `a delivery is ${(fare / PRICE.job.mission.first).toFixed(2)} of a mission — it is not a floor`);
});

// The whole loop, once, with real numbers, because a ratio can be right while
// the plumbing between two modules is not.
test('filling a Fabia at a real pump moves exactly the right money', () => {
  freshWallet();
  W.setMoney(2500);
  WLOG.length = 0;

  const c = tank('fabia', 55);
  const brand = pumpBrand('Benzina ORLEN');
  const perLitre = pumpPrice(brand, F.fuelTypeOf(c.kind));
  const room = F.tankOf('fabia') - F.levelOf(c);
  const bill = room * perLitre;

  assert.ok(W.canPay(bill), `2500 Kč cannot brim a part-full Fabia at ${perLitre} Kč/l`);
  const put = F.fill(c, room);
  assert.ok(Math.abs(put - room) < 1e-9, 'the pump delivered a different amount than it quoted');
  assert.equal(W.pay(put * perLitre, 'benzín'), true);
  assert.equal(W.money(), 2500 - Math.round(put * perLitre));
  assert.equal(WLOG.length, 1);
  assert.equal(WLOG[0].what, 'benzín');
  assert.ok(Math.abs(F.levelOf(c) - F.tankOf('fabia')) < 1e-9);

  // And the sale that cannot happen leaves the wallet byte-identical — this is
  // the atomicity property again, arrived at through the real call chain.
  W.setMoney(10);
  WLOG.length = 0;
  const d = tank('fabia', 56);
  const want = F.tankOf('fabia') - F.levelOf(d);
  const cost = want * perLitre;
  if (!W.canPay(cost)) {
    const before = W.money(), level = F.levelOf(d);
    assert.equal(W.pay(cost, 'benzín'), false);
    assert.equal(W.money(), before, 'a refused fill still took money');
    assert.equal(F.levelOf(d), level, 'a refused fill still put petrol in');
    assert.equal(WLOG.length, 0);
  }
});

// ==========================================================================
// STATUSBAR — one property, and only one
// ==========================================================================

// The four modules above are pure so that this one can be the only file in the
// build that has ever heard of an element. Everything statusbar.js does is a
// DOM write, and a fake document here would be testing the fake — so the only
// thing worth asserting is the one its header promises: import it under node
// with no document and it is inert.
test('the status bar imports and does nothing at all without a DOM', () => {
  assert.equal(typeof globalThis.document, 'undefined',
    'something in this process installed a document — this test now proves nothing');
  freshWallet();
  freshBody();
  const before = W.money(), hp = V.hp();

  assert.doesNotThrow(() => {
    HUD.init();
    HUD.init();                            // twice, the way main.js may call it
    const c = tank('fabia', 61);
    for (let i = 0; i < 30; i++) HUD.update(0.05, { car: c, onFoot: false });
    HUD.update();                          // no dt, no ctx
    HUD.update(NaN, null);
    HUD.update(10, { car: null, onFoot: true });
    HUD.banner('SEJMUT', 'dead');
    HUD.banner('SEJMUT', 'dead');
    HUD.hideBanner();
    HUD.hideBanner();
    // …and while the two modules it listens to are actually moving.
    W.earn(800, 'zakázka');
    W.pay(145, 'guláš');
    V.damage(1000, 'havárie');
    HUD.update(0.05, null);
    V.revive();
    HUD.update(0.05, null);
  });

  assert.equal(W.money(), before + 800 - 145, 'the headless HUD moved the balance');
  assert.equal(V.hp(), hp, 'the headless HUD moved the health');
  assert.equal(typeof HUD.default.update, 'function', 'the default export lost its surface');
});
