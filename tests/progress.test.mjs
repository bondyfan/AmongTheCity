// Stats, achievements, the introduction, hunger and the price of one car.
import test from 'node:test';
import assert from 'node:assert/strict';

import { Progress, ACHIEVEMENTS, blankStats } from '../js/progress.js';
import { Onboarding, STEPS, DRIVE_REWARD } from '../js/onboarding.js';
import * as V from '../js/vitals.js';
import { PRICE, carOffer, repairCost, canisterCost } from '../js/prices.js';
import { sanitize, blank } from '../js/savegame.js';

const ids = (list) => list.map((a) => a.id);

test('achievements fire once, at their threshold, in the order they come true', () => {
  const p = new Progress();
  assert.deepEqual(p.check(), []);
  p.addWalk(40); p.addWalk(40);
  assert.deepEqual(p.check(), [], '80 m is not 300');
  for (let i = 0; i < 8; i++) p.addWalk(30);
  assert.deepEqual(ids(p.check(1000)), ['kroky']);
  assert.deepEqual(p.check(), [], 'the same achievement paid twice');
  assert.equal(p.unlocked.kroky, 1000);
  for (let i = 0; i < 40; i++) p.addDrive(100);
  assert.deepEqual(ids(p.check()), ['volant']);
});

test('jobs feed the counters the achievements read', () => {
  const p = new Progress();
  p.jobDone('courier', 420, { timeLeftS: 60, limitS: 200 });
  assert.equal(p.stats.jobsCourier, 1);
  assert.equal(p.stats.earned, 420);
  assert.equal(p.stats.bestPay, 420);
  assert.equal(p.stats.tightRuns, 0);
  assert.deepEqual(ids(p.check()), ['vyplata']);
  p.jobDone('courier', 300, { timeLeftS: 5, limitS: 200 });
  assert.deepEqual(ids(p.check()), ['chvile'], 'a delivery with 5 s left was not a close one');
  p.jobDone('taxi', 500, { smooth: 0.8 });
  assert.equal(p.stats.smoothRides, 0);
  p.jobDone('taxi', 700, { smooth: 1 });
  assert.equal(p.stats.bestPay, 700);
  assert.deepEqual(ids(p.check()), ['maslo']);
  for (let i = 0; i < 3; i++) p.jobDone('courier', 100, {});
  assert.deepEqual(ids(p.check()), ['kuryr']);
  p.jobFailed();
  assert.equal(p.stats.jobsFailed, 1);
  assert.equal(p.jobs, 7);
});

test('districts are discovered once each, by name', () => {
  const p = new Progress();
  assert.equal(p.enterDistrict('Zelené Předměstí'), true);
  assert.equal(p.enterDistrict('Zelené Předměstí'), false);
  assert.equal(p.enterDistrict(''), false);
  assert.equal(p.enterDistrict(null), false);
  for (const d of ['Polabiny', 'Staré Město']) p.enterDistrict(d);
  assert.deepEqual(p.check(), []);
  p.enterDistrict('Dukla');
  assert.deepEqual(ids(p.check()), ['znalec']);
  assert.deepEqual(p.stats.districts, ['Zelené Předměstí', 'Polabiny', 'Staré Město', 'Dukla']);
});

test('one-off verbs: eating, refuelling, buying a car', () => {
  const p = new Progress();
  p.bump('meals'); p.bump('refuels'); p.bump('carsBought');
  p.bump('districts'); p.bump('nonsense');
  assert.deepEqual(ids(p.check()).sort(), ['auto', 'chut', 'nadrz']);
  assert.deepEqual(p.stats.districts, []);
  p.addSpent(1700); p.addSpent(-5);
  assert.equal(p.stats.spent, 1700);
});

test('a teleport is not a drive and a respawn is not a walk', () => {
  const p = new Progress();
  p.addDrive(2500); p.addWalk(900); p.addDrive(NaN); p.addWalk(-3);
  assert.equal(p.stats.driveM, 0);
  assert.equal(p.stats.walkM, 0);
});

test('progress survives the save, and a save cannot unlock what it has not earned twice', () => {
  const p = new Progress();
  for (let i = 0; i < 12; i++) p.addWalk(30);
  p.enterDistrict('Polabiny');
  p.check(555);
  const saved = sanitize({ ...blank(), stats: p.stats, ach: p.unlocked });
  const q = new Progress(saved.stats, saved.ach);
  assert.deepEqual(q.stats, p.stats);
  assert.deepEqual(q.unlocked, { kroky: 555 });
  assert.deepEqual(q.check(), [], 'a reload re-awarded an achievement');
  // garbage in: zeros, no throw, unknown achievement ids ignored
  const r = new Progress({ driveM: 'far', districts: ['A', 'A', 3] }, { ghost: 1 });
  assert.equal(r.stats.driveM, 0);
  assert.deepEqual(r.stats.districts, ['A']);
  assert.deepEqual(r.unlocked, {});
  assert.deepEqual(Object.keys(new Progress(null, null).stats), Object.keys(blankStats()));
});

test('the achievement table is well formed', () => {
  const seen = new Set();
  const fresh = blankStats();
  for (const a of ACHIEVEMENTS) {
    assert.ok(!seen.has(a.id), `duplicate id ${a.id}`);
    seen.add(a.id);
    assert.ok(a.name && a.desc && a.reward > 0, `${a.id} is missing text or a reward`);
    assert.equal(a.test(fresh), false, `${a.id} is true on a new game`);
    assert.ok(!/\u2014/.test(a.name + a.desc), 'an em dash in player-facing text');
  }
});

// ---- the introduction -------------------------------------------------------

const octx = (o = {}) => ({ dt: 0.1, x: 0, z: 0, onFoot: true, inCar: false, walkedM: 0, boardOpen: false, ...o });

test('the introduction walks through its four steps by playing', () => {
  const o = new Onboarding();
  assert.equal(o.name, 'walk');
  assert.equal(o.view().step, 1);
  assert.deepEqual(o.update(octx()), []);
  for (let i = 0; i < 11; i++) o.update(octx({ walkedM: 1 }));
  assert.equal(o.name, 'walk');
  const ev = o.update(octx({ walkedM: 1.5 }));
  assert.deepEqual(ev, [{ type: 'step', was: 'walk', reward: 0 }]);
  assert.equal(o.name, 'car');
  assert.equal(o.needsTarget, true);
  o.setTarget({ x: 9, z: 8, name: 'Škoda Fabia' });
  assert.equal(o.view().where, 'Škoda Fabia');
  o.update(octx());
  assert.equal(o.name, 'car');
  o.update(octx({ inCar: true, onFoot: false }));
  assert.equal(o.name, 'drive');
  assert.equal(o.target, null, 'the car marker became the drive target');
  o.setTarget({ x: 400, z: 0, name: 'Pizzerie' });
  assert.equal(o.view().reward, DRIVE_REWARD);
  o.update(octx({ inCar: true, x: 200 }));
  assert.equal(o.name, 'drive');
  const arrive = o.update(octx({ inCar: true, x: 390 }));
  assert.deepEqual(arrive, [{ type: 'step', was: 'drive', reward: DRIVE_REWARD }]);
  assert.equal(o.name, 'board');
  const fin = o.update(octx({ boardOpen: true }));
  assert.deepEqual(fin.map((e) => e.type), ['step', 'finished']);
  assert.equal(o.done, true);
  assert.equal(o.view(), null);
  assert.deepEqual(o.update(octx()), []);
});

test('getting straight into a car skips the walking hint; no target skips the drive unpaid', () => {
  const o = new Onboarding();
  o.update(octx({ inCar: true, onFoot: false }));
  assert.equal(o.name, 'car');
  o.update(octx({ inCar: true, onFoot: false }));
  assert.equal(o.name, 'drive');
  let ev = [];
  for (let t = 0; t < 7 && o.name === 'drive'; t += 0.1) ev = [...o.update(octx({ inCar: true }))];
  assert.equal(o.name, 'board', 'the introduction hung waiting for a target');
  assert.deepEqual(ev, [{ type: 'step', was: 'drive', reward: 0 }]);
});

test('skip ends it, and the save resumes at the right step', () => {
  const o = new Onboarding();
  o.skip();
  assert.equal(o.done, true);
  assert.equal(o.view(), null);
  const p = new Onboarding({ step: 2, done: false });
  assert.equal(p.name, 'drive');
  assert.deepEqual(p.toJSON(), { step: 2, done: false });
  assert.equal(new Onboarding({ step: 99 }).done, true);
  assert.equal(new Onboarding({ step: -4 }).name, 'walk');
  assert.equal(new Onboarding({ step: 1, done: true }).view(), null);
  assert.equal(STEPS.length, 4);
});

// ---- hunger -----------------------------------------------------------------

test('hunger: a full stomach empties over about a game day and food fills it', () => {
  V.reset();
  assert.equal(V.energy(), 100);
  assert.equal(V.hungry(), false);
  for (let t = 0; t < 10 * 60; t += 0.2) V.update(0.2, {});
  assert.ok(V.energy() > 40 && V.energy() < 60, `after ten minutes: ${V.energy()}`);
  for (let t = 0; t < 12 * 60; t += 0.2) V.update(0.2, {});
  assert.equal(V.energy(), 0);
  assert.equal(V.hungry(), true);
  assert.equal(V.hp(), 100, 'hunger took health');
  V.eat(30);
  assert.equal(V.energy(), 30);
  V.eat(500);
  assert.equal(V.energy(), V.energyMax());
  V.eat(NaN); V.eat(-10);
  assert.equal(V.energy(), 100);
  V.reset();
});

test('hunger: an empty stomach stops the free mending, a meal starts it again', () => {
  V.reset();
  V.restore({ hp: 20, armour: 0, energy: 0 });
  assert.equal(V.hp(), 20);
  for (let t = 0; t < 60; t += 0.2) V.update(0.2, {});
  assert.equal(V.hp(), 20, 'a starving body healed itself');
  V.eat(50);
  for (let t = 0; t < 60; t += 0.2) V.update(0.2, {});
  assert.equal(V.hp(), 50, 'a fed body did not climb back to the floor');
  V.reset();
});

test('restore puts a saved body back and refuses garbage', () => {
  V.reset();
  V.restore({ hp: 61.5, armour: 20, energy: 33 });
  assert.equal(V.hp(), 61.5);
  assert.equal(V.armour(), 20);
  assert.equal(V.energy(), 33);
  V.restore({ hp: NaN, armour: 'x', energy: undefined });
  assert.equal(V.hp(), 61.5);
  V.restore({ hp: -5, armour: 900, energy: 900 });
  assert.equal(V.hp(), 1, 'a save booted the player dead');
  assert.equal(V.armour(), 100);
  assert.equal(V.energy(), 100);
  V.restore(null);
  V.reset();
});

// ---- one particular car -------------------------------------------------------

test('a car has its own price: stable per car, cheaper when bent, never free', () => {
  const a = carOffer('fabia', 12345, 0);
  assert.deepEqual(carOffer('fabia', 12345, 0), a, 'the same car changed price between visits');
  assert.equal(a.list, PRICE.cars.find((c) => c.kind === 'fabia').price);
  assert.ok(a.price <= a.list && a.price >= a.list * 0.44, `${a.price} against list ${a.list}`);
  assert.equal(a.price % 100, 0, 'a used car priced to the koruna');
  const prices = new Set();
  for (let s = 0; s < 400; s += 7) prices.add(carOffer('fabia', s, 0).price);
  assert.ok(prices.size > 20, 'every Fabia in town costs the same');
  assert.ok(carOffer('fabia', 12345, 0.8).price < a.price);
  assert.ok(carOffer('fabia', 0, 5).price > 0);
  assert.ok(Number.isFinite(carOffer('tesla', 3, NaN).price));
  assert.equal(carOffer('bus', 1, 0), null, 'the city bus is for sale');
  assert.equal(carOffer('truck', 1, 0), null);
  // every kind on the price list resolves
  for (const c of PRICE.cars) assert.equal(carOffer(c.kind, 1, 0).name, c.name);
});

test('repairs cost by damage, with a floor, up to the garage rate', () => {
  assert.equal(repairCost(0), 0);
  assert.equal(repairCost(0.01), 0, 'a scratch nobody can see has a bill');
  assert.equal(repairCost(0.05), 250);
  assert.equal(repairCost(1), PRICE.garage.repair);
  assert.equal(repairCost(1.2), PRICE.garage.repair);
  assert.ok(repairCost(0.5) > repairCost(0.2));
  assert.equal(repairCost(NaN), 0);
  assert.ok(PRICE.fine.perStar > PRICE.hospital.fee, 'being caught is cheaper than being hurt');
});

test('the rescue canister costs well over the pump, in round money', () => {
  for (const type of ['benzin', 'nafta', 'elektro']) {
    const c = canisterCost(type), pump = PRICE.fuel.base[type] * PRICE.rescue.units;
    assert.equal(c % 10, 0);
    assert.ok(c > pump * 1.4 && c < pump * 1.8, `${type}: ${c} against ${pump} at the pump`);
  }
  assert.equal(canisterCost('uhlí'), canisterCost('benzin'), 'an unknown fuel priced as NaN');
});
