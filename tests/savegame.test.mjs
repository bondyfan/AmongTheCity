// The save: versioning, migration, corrupt blobs, and a storage that fails.
import test from 'node:test';
import assert from 'node:assert/strict';

import { SAVE_KEY, SAVE_VERSION, blank, sanitize, migrate, parse, serialize,
  makeStore, browserStore, MIGRATIONS, fmtPlayed } from '../js/savegame.js';

// localStorage, as a Map. `fail` makes every call throw, like a private window.
function fakeStorage(fail = false) {
  const m = new Map();
  const boom = () => { throw new Error('SecurityError'); };
  return {
    m,
    getItem: (k) => (fail ? boom() : m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (fail) boom(); m.set(k, String(v)); },
    removeItem: (k) => { if (fail) boom(); m.delete(k); },
  };
}

const played = () => ({
  ...blank(), money: 8450, pos: { x: 1690.04, z: -780.26, h: 1.23456 }, tod: 0.6, played: 4321,
  vitals: { hp: 61.5, armour: 20, energy: 33 },
  car: { kind: 'fabia', color: 0x3a63a8, x: 40, z: -110, h: 0.5, fuel: 21.337, damage: 0.12, seed: 77, parkIdx: 3 },
  stats: { driveM: 12000.5, jobsCourier: 4, districts: ['Zelené Předměstí', 'Polabiny'] },
  ach: { kroky: 1700000000000 },
  jobs: { day: '2026-11-10', shift: 1, done: ['c1', 't2'], active: null },
  onb: { step: 2, done: false, tips: { fuel: 1 } },
});

test('a played game round-trips through the store', () => {
  const st = fakeStorage();
  const store = makeStore(st);
  assert.equal(store.has(), false);
  assert.equal(store.summary(), null);
  assert.equal(store.save(played(), 1234567), true);
  const res = store.load();
  assert.equal(res.ok, true);
  assert.equal(res.reason, null);
  assert.equal(res.migrated, false);
  const s = res.state;
  assert.equal(s.v, SAVE_VERSION);
  assert.equal(s.savedAt, 1234567);
  assert.equal(s.money, 8450);
  assert.deepEqual(s.pos, { x: 1690, z: -780.3, h: 1.235 });
  assert.equal(s.car.kind, 'fabia');
  assert.equal(s.car.parkIdx, 3);
  assert.equal(s.car.fuel, 21.34);
  assert.deepEqual(s.stats.districts, ['Zelené Předměstí', 'Polabiny']);
  assert.deepEqual(s.jobs.done, ['c1', 't2']);
  assert.deepEqual(s.onb, { step: 2, done: false, tips: { fuel: 1 } });
  assert.equal(store.has(), true);
  assert.deepEqual(store.summary(), { money: 8450, played: 4321, savedAt: 1234567, car: 'fabia', jobs: 4 });
  // and saving what was loaded changes nothing
  assert.equal(serialize(s), st.m.get(SAVE_KEY));
  store.clear();
  assert.equal(store.has(), false);
});

test('a new game is a valid save of the current version', () => {
  const b = blank();
  assert.equal(b.v, SAVE_VERSION);
  assert.deepEqual(sanitize(b), b);
  assert.equal(b.money, 2500);
  assert.equal(b.pos, null);
  assert.equal(b.onb.done, false);
});

test('a corrupt save falls back to a new game and is kept, not deleted', () => {
  for (const raw of ['{"money":', 'not json', '[1,2,3]', '"a string"', '42', 'null']) {
    const st = fakeStorage();
    st.m.set(SAVE_KEY, raw);
    const store = makeStore(st);
    const res = store.load();
    assert.equal(res.ok, false, `${raw} loaded`);
    assert.equal(res.reason, 'corrupt');
    assert.deepEqual(res.state, blank(), 'the fallback is not a clean new game');
    assert.equal(st.m.get(SAVE_KEY + '-corrupt'), raw, 'the unreadable save was thrown away');
    assert.equal(store.has(), false);
    // the next autosave then replaces it with something readable
    assert.equal(store.save(blank(), 5), true);
    assert.equal(store.load().ok, true);
  }
  const empty = makeStore(fakeStorage()).load();
  assert.equal(empty.reason, 'empty');
  assert.deepEqual(empty.state, blank());
});

test('every field is sanitised: a hand-edited save cannot poison the game', () => {
  const s = sanitize({
    v: SAVE_VERSION, money: 'lots', pos: { x: NaN, z: 5 }, tod: 9, played: -50,
    vitals: { hp: 0, armour: 1e9, energy: -4 },
    car: { kind: 'fabia', x: 1e9, z: 0 },
    stats: { driveM: Infinity, walkM: 12, districts: ['A', 7, null, 'B'], evil: { nested: true } },
    ach: { kroky: 'yes', volant: 5 }, jobs: 'none', onb: null,
  });
  assert.equal(s.money, 2500);
  assert.equal(s.pos, null, 'a NaN position survived');
  assert.equal(s.tod, 1);
  assert.equal(s.played, 0);
  assert.deepEqual(s.vitals, { hp: 1, armour: 100, energy: 0 });
  assert.equal(s.car, null, 'a car parked outside the world survived');
  assert.deepEqual(s.stats, { walkM: 12, districts: ['A', 'B'] });
  assert.deepEqual(s.ach, { volant: 5 });
  assert.deepEqual(s.jobs, { day: '', shift: 0, done: [], active: null });
  assert.deepEqual(s.onb, { step: 0, done: false, tips: {} });
  assert.equal(sanitize({ money: 1e15 }).money, 999999999);
  for (const junk of [null, undefined, 5, 'x', []]) assert.deepEqual(sanitize(junk), blank());
});

test('old versions migrate up the chain one step at a time', () => {
  // v0: flat and unversioned
  const v0 = parse(JSON.stringify({ money: 900, x: 12, z: -34, heading: 1, hp: 40 }));
  assert.equal(v0.ok, true);
  assert.equal(v0.migrated, true);
  assert.equal(v0.state.v, SAVE_VERSION);
  assert.equal(v0.state.money, 900);
  assert.deepEqual(v0.state.pos, { x: 12, z: -34, h: 1 });
  assert.equal(v0.state.vitals.hp, 40);
  assert.equal(v0.state.vitals.energy, 100, 'hunger did not exist: it starts full');
  // v1: versioned, single job counter
  const v1 = parse(JSON.stringify({ v: 1, money: 5000, pos: { x: 1, z: 2, h: 0 },
    vitals: { hp: 80, armour: 10 }, stats: { driveM: 4000 }, jobsDone: 7 }));
  assert.equal(v1.ok, true);
  assert.equal(v1.state.stats.jobsCourier, 7, 'the old job counter was dropped');
  assert.equal(v1.state.stats.driveM, 4000);
  assert.equal(v1.state.onb.done, true, 'a returning player was sent through the introduction');
  assert.equal(v1.state.vitals.armour, 10);
});

test('the chain itself: ordered, complete, and loud when a step is missing', () => {
  for (let v = 0; v < SAVE_VERSION; v++) assert.equal(typeof MIGRATIONS[v], 'function', `no step from v${v}`);
  const calls = [];
  const table = {
    2: (s) => { calls.push(2); return { ...s, v: 3, extra: 1 }; },
    3: (s) => { calls.push(3); return { ...s, v: 4, extra: s.extra + 1 }; },
  };
  const out = migrate({ v: 2, money: 1 }, table, 4);
  assert.deepEqual(calls, [2, 3]);
  assert.equal(out.steps, 2);
  assert.equal(out.state.extra, 2);
  assert.equal(migrate({ v: 4 }, table, 4).steps, 0);
  assert.throws(() => migrate({ v: 2 }, { 2: (s) => ({ ...s, v: 3 }) }, 5), /no migration from v3/);
  assert.throws(() => migrate({ v: 2 }, { 2: (s) => s }, 3), /did not advance/);
  // a broken step reads as a corrupt save rather than a thrown boot
  assert.equal(parse('{"v":2}', { 2: () => { throw new Error('x'); } }, 3).reason, 'corrupt');
});

test('a save from a newer build is refused and never overwritten', () => {
  const st = fakeStorage();
  const future = JSON.stringify({ v: SAVE_VERSION + 3, money: 77777, shiny: true });
  st.m.set(SAVE_KEY, future);
  const store = makeStore(st);
  const res = store.load();
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'newer');
  assert.equal(store.has(), false);
  assert.equal(store.save(blank(), 1), false, 'an old build clobbered a newer save');
  assert.equal(st.m.get(SAVE_KEY), future);
  assert.equal(st.m.get(SAVE_KEY + '-newer'), future);
});

test('storage that throws on every call costs the save, not the game', () => {
  const store = makeStore(fakeStorage(true));
  assert.equal(store.has(), false);
  const res = store.load();
  assert.equal(res.ok, false);
  assert.deepEqual(res.state, blank());
  assert.equal(store.save(played(), 1), false);
  store.clear();
  assert.equal(store.summary(), null);
});

test('a store that keeps nothing says so, and says it before the first save', () => {
  // site data blocked: reading the global throws, as it does in a locked-down browser
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const blocked = browserStore();
    assert.equal(blocked.writable(), false);
    assert.equal(blocked.save(played(), 1), false, 'a save that went nowhere was reported as written');
    assert.equal(blocked.has(), false);
    assert.equal(blocked.load().reason, 'empty');
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had); else delete globalThis.localStorage;
  }
  // full: reads work, writes throw
  const full = makeStore({ getItem: () => null, setItem() { throw new Error('QuotaExceededError'); }, removeItem() {} });
  assert.equal(full.writable(), false);
  assert.equal(full.save(blank(), 1), false);
  // a healthy one answers yes and leaves nothing behind
  const st = fakeStorage();
  const ok = makeStore(st);
  assert.equal(ok.writable(), true);
  assert.equal(st.m.size, 0, 'the probe key was left in storage');
  assert.equal(makeStore(fakeStorage(true)).writable(), false);
});

test('the wanted level and an unpaid hospital bill survive a reload', () => {
  const st = fakeStorage();
  const store = makeStore(st);
  store.save({ ...played(), wanted: { heat: 156.04, crime: 'zabití' }, owed: { stars: 4 } }, 9);
  const s = store.load().state;
  assert.deepEqual(s.wanted, { heat: 156, crime: 'zabití' });
  assert.deepEqual(s.owed, { stars: 4 });
  assert.equal(serialize(s), st.m.get(SAVE_KEY));
  // a save from before these fields existed, and a new game: clean, nothing owed
  assert.deepEqual(sanitize(played()).wanted, { heat: 0, crime: '' });
  assert.equal(sanitize(played()).owed, null);
  assert.deepEqual(blank().wanted, { heat: 0, crime: '' });
  assert.equal(blank().owed, null);
  // hand-edited: clamped to what js/wanted.js can hold, never NaN
  const bad = sanitize({ wanted: { heat: 1e9, crime: 7 }, owed: { stars: 99.7 } });
  assert.deepEqual(bad.wanted, { heat: 260, crime: '' });
  assert.deepEqual(bad.owed, { stars: 5 });
  assert.deepEqual(sanitize({ wanted: 'yes', owed: 'no' }).wanted, { heat: 0, crime: '' });
  assert.equal(sanitize({ wanted: { heat: -5 }, owed: [3] }).owed, null);
  assert.deepEqual(sanitize({ owed: { stars: NaN } }).owed, { stars: 0 });
});

test('time played reads like a person would say it', () => {
  assert.equal(fmtPlayed(0), '0 min');
  assert.equal(fmtPlayed(8 * 60 + 59), '8 min');
  assert.equal(fmtPlayed(72 * 60), '1 h 12 min');
  assert.equal(fmtPlayed(-5), '0 min');
});
