// ---- Save game: one versioned blob in localStorage ----
// What survives a reload: money, where you stood, how long you have played,
// the car you own and where you left it, the body, the stats, the job you had
// taken and how far through the introduction you are. All of it as it was at
// the last AUTOSAVE POINT (js/autosave.js): the game is written only there,
// never while it is played and never on the way out.
//
// THE SAVE IS THE LOCAL PLAYER'S AND NOTHING ELSE. No traffic, no pedestrians,
// no wrecks in the street: those are a shared schedule in co-op (every client
// derives them from ids and the clock), and a save that restored them would
// put one player in a different city from the rest of the room.
//
// Pure: storage is INJECTED (tests hand it a Map-backed fake), and nothing
// here touches the DOM or the game. js/career.js collects the state out of the
// live modules and applies it back.
//
// Three rules, each of which is a test in tests/savegame.test.mjs:
//   1. A blob is never trusted. Every field goes through sanitize(), so a
//      hand-edited or half-written save can at worst give you a strange
//      balance, never a NaN position or a thrown boot.
//   2. A blob that cannot be read is KEPT (under KEY + '-corrupt') before the
//      game starts fresh. Deleting somebody's forty hours because one byte is
//      wrong is not a fallback, it is a second bug.
//   3. Old versions are migrated one step at a time through MIGRATIONS, and a
//      blob from a NEWER build is refused untouched: an older tab must not
//      overwrite what a newer one wrote.

import { stops as storyStops } from './prologue-route.js';
import { sanitizeLook } from './characters/appearance.js';
import { isPoint, PART_ONE_END } from './autosave.js';

export const SAVE_KEY = 'atc-save';
export const SAVE_VERSION = 3;

const WORLD_MAX = 400000;      // m: nothing in the region is further than this
const MONEY_MAX = 999999999;

const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const pos = (v, hi = Infinity) => clamp(fin(v, 0), 0, hi);
const str = (v, max = 80) => (typeof v === 'string' ? v.slice(0, max) : '');
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** A new game, as a save. The one place the starting state is written down. */
export function blank() {
  return {
    v: SAVE_VERSION,
    savedAt: 0,
    prologue: null,
    heist: null,               // 'done' once part two (js/heist.js) has been played through
    heistPaid: false,          // its briefcase has been paid out (once: a replay pays nothing)
    storyTrip: null,
    money: 2500,
    pos: null,                 // { x, z, h, y? } or null = the station forecourt
    tod: null,                 // 0..1 time of day (single player only), or null
    played: 0,                 // s
    vitals: { hp: 100, armour: 0, energy: 100 },
    car: null,                 // { kind, color, x, z, h, y?, fuel, damage, seed, parkIdx }
    stats: {},                 // js/progress.js owns the shape
    ach: {},                   // id → unix ms it was earned
    jobs: { day: '', shift: 0, done: [], active: null },
    onb: { step: 0, done: false, tips: {} },
    // The police do not forget you over a reload: js/wanted.js's heat and the
    // noun of what it is for. Without it F5 was a free pardon.
    wanted: { heat: 0, crime: '' },
    // Set only in the one save written as the player goes down: the hospital
    // (and the police, per star) have not been paid yet, and loading this save
    // is what pays them. null in every other save.
    owed: null,                // { stars } or null
    // Who the player chose to be (js/characters/appearance.js): a short code,
    // '' until the character creator has been through. Also kept in
    // localStorage, which is what free roam and co-op read; the save's copy
    // brings it back when that storage was cleared.
    look: '',
    // Which autosave point wrote this save ('mission', 'sleep'), or '' for a
    // new game and for a save from before the points existed.
    point: '',
  };
}

function sanePos(p) {
  if (!p || typeof p !== 'object') return null;
  const x = fin(p.x, NaN), z = fin(p.z, NaN);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (Math.abs(x) > WORLD_MAX || Math.abs(z) > WORLD_MAX) return null;
  const out = { x: +x.toFixed(1), z: +z.toFixed(1), h: +fin(p.h, 0).toFixed(3) };
  // y, the level it was taken on (a bridge deck over a riverbed, the D11 under
  // an overpass): x and z alone have two answers there (js/savespot.js). Only
  // when it is a sane altitude; a save without one is an older save and is
  // stood on the highest floor close above the ground instead.
  const y = fin(p.y, NaN);
  if (Number.isFinite(y) && y > -500 && y < 5000) out.y = +y.toFixed(2);
  // rg, the region the spot is in (js/regions.js); absent is the Czech world,
  // so every save written before regions existed reads exactly as it did
  if (typeof p.rg === 'string' && p.rg !== 'cz' && /^[a-z0-9-]{1,16}$/.test(p.rg)) out.rg = p.rg;
  return out;
}

function saneCar(c) {
  if (!c || typeof c !== 'object' || typeof c.kind !== 'string') return null;
  const p = sanePos(c);
  if (!p) return null;
  return {
    kind: str(c.kind, 24), color: fin(c.color, 0x8a9096) & 0xffffff,
    x: p.x, z: p.z, h: p.h, ...(p.y !== undefined ? { y: p.y } : {}),
    fuel: c.fuel == null ? null : +pos(c.fuel, 500).toFixed(2),
    damage: +pos(c.damage, 1.2).toFixed(3),
    seed: fin(c.seed, 0) >>> 0,
    parkIdx: Number.isInteger(c.parkIdx) && c.parkIdx >= 0 ? c.parkIdx : null,
  };
}

/** Whatever came in, a well-formed current-version state comes out. */
export function sanitize(raw) {
  const s = obj(raw), b = blank();
  const vit = obj(s.vitals), jobs = obj(s.jobs), onb = obj(s.onb);
  const stats = {};
  for (const [k, v] of Object.entries(obj(s.stats))) {
    if (typeof v === 'number' && Number.isFinite(v)) stats[str(k, 32)] = v;
    else if (Array.isArray(v)) stats[str(k, 32)] = v.filter((e) => typeof e === 'string').slice(0, 400).map((e) => str(e));
  }
  const ach = {};
  for (const [k, v] of Object.entries(obj(s.ach))) if (fin(v, 0) > 0) ach[str(k, 32)] = fin(v);
  const tips = {};
  for (const [k, v] of Object.entries(obj(onb.tips))) if (v) tips[str(k, 32)] = 1;
  const wanted = obj(s.wanted);
  return {
    v: SAVE_VERSION,
    savedAt: pos(s.savedAt),
    storyTrip: [2,4,5].includes(s.storyTrip?.platform) ? {
      platform: s.storyTrip.platform,
      remaining: clamp(fin(s.storyTrip.remaining, 210), 0, 210),
      ...(Number.isFinite(s.storyTrip.metres) ? {metres: clamp(s.storyTrip.metres, 0, 43000)} : {}),
      ...(Number.isFinite(s.storyTrip.seatU) && Math.abs(s.storyTrip.seatU) < 40 ? {seatU: s.storyTrip.seatU} : {}),
    } : null,
    prologue: storyStops.includes(s.prologue) ? s.prologue : null,
    heist: s.heist === 'done' ? 'done' : null,
    heistPaid: s.heistPaid === true,
    money: Math.round(clamp(fin(s.money, b.money), -MONEY_MAX, MONEY_MAX)),
    pos: sanePos(s.pos),
    tod: s.tod == null ? null : clamp(fin(s.tod, 0.25), 0, 1),
    played: Math.round(pos(s.played, 1e9)),
    vitals: {
      // a save is never written while down, but a hand-edited 0 must not boot
      // the player straight onto the death card
      hp: clamp(fin(vit.hp, 100), 1, 100),
      armour: pos(vit.armour, 100),
      energy: clamp(fin(vit.energy, 100), 0, 100),
    },
    car: saneCar(s.car),
    stats, ach,
    jobs: {
      day: str(jobs.day, 12), shift: pos(jobs.shift, 1e6) | 0,
      done: (Array.isArray(jobs.done) ? jobs.done : []).filter((e) => typeof e === 'string').slice(-200),
      active: jobs.active && typeof jobs.active === 'object' ? jobs.active : null,
    },
    onb: { step: pos(onb.step, 99) | 0, done: !!onb.done, tips },
    // 260 is wanted.js's own ceiling (HEAT_MAX): a hand-edited blob cannot bank more
    wanted: { heat: +pos(wanted.heat, 260).toFixed(1), crime: str(wanted.crime, 40) },
    owed: s.owed && typeof s.owed === 'object' && !Array.isArray(s.owed)
      ? { stars: pos(s.owed.stars, 5) | 0 } : null,
    look: sanitizeLook(s.look),
    point: isPoint(s.point) ? s.point : '',
  };
}

// ---- migrations -----------------------------------------------------------
// MIGRATIONS[n] turns a version-n blob into version n+1. Append only: the
// chain is what lets a save from any earlier build load in this one.
//
// HONESTY NOTE: no released build wrote a save before version 2. v0 (a flat
// unversioned blob) and v1 (the first versioned draft) are the two shapes this
// file went through while it was being written, kept as real steps so that the
// chain, the "old save" path and their tests exist BEFORE the first migration
// that matters has to be added under pressure. v2 to v3 below is the first
// one that does. The next schema change appends `3: (s) => ...` and bumps
// SAVE_VERSION.
export const MIGRATIONS = {
  // v0: flat { money, x, z, heading, hp }. No stats, no car.
  0: (s) => ({
    v: 1, money: s.money,
    pos: Number.isFinite(s.x) && Number.isFinite(s.z) ? { x: s.x, z: s.z, h: s.heading ?? 0 } : null,
    vitals: { hp: s.hp ?? 100, armour: 0 },
    stats: {}, jobsDone: 0,
  }),
  // v1 to v2: hunger arrived (vitals.energy), the single job counter became the
  // jobs record, and the introduction got its own state. A v1 player has by
  // definition already played, so they are not walked through it again.
  1: (s) => {
    const { jobsDone, ...rest } = s;
    return {
      ...rest, v: 2,
      vitals: { ...obj(s.vitals), energy: 100 },
      stats: { ...obj(s.stats), jobsCourier: fin(jobsDone, 0) },
      jobs: { day: '', shift: 0, done: [], active: null },
      onb: { step: 0, done: true, tips: {} },
    };
  },
  // v2 to v3: the save is written only at autosave points (Frank, 20 Nov
  // 2026). A v2 save was written every twenty seconds and on the way out, so
  // its position and its hour are where and when the tab was closed, which is
  // exactly what a load must never return to. The rest (money, the car, the
  // stats) is kept: it is the player's, and there is nothing truer to put
  // instead. Whoever has finished part one of the campaign is stood where it
  // ends; anyone else starts on the square of the save's city. The one v2 save
  // whose spot is not the quit spot is the one written on the death card: it
  // stands you at the hospital with the bill still open, and stays so.
  2: (s) => {
    const deathCard = obj(s.owed) === s.owed;
    return {
      ...s, v: 3,
      pos: deathCard ? s.pos : s.prologue === 'done' ? { ...PART_ONE_END } : null,
      tod: null,
      point: '',
    };
  },
};

/** Walk a blob up to `target`. Throws on a version it cannot place. */
export function migrate(blob, table = MIGRATIONS, target = SAVE_VERSION) {
  let s = blob;
  let v = Number.isInteger(s.v) ? s.v : 0;
  let steps = 0;
  while (v < target) {
    const step = table[v];
    if (typeof step !== 'function') throw new Error('no migration from v' + v);
    s = step(s);
    if (!s || !(s.v > v)) throw new Error('migration v' + v + ' did not advance');
    v = s.v;
    steps++;
  }
  return { state: s, steps };
}

/**
 * parse(raw) → { ok, state, reason, migrated }
 *   reason: null | 'empty' | 'corrupt' | 'newer'
 * `state` is always a usable state: the save when ok, a blank game otherwise.
 */
export function parse(raw, table = MIGRATIONS, target = SAVE_VERSION) {
  if (raw == null || raw === '') return { ok: false, state: blank(), reason: 'empty', migrated: false };
  let blob;
  try { blob = JSON.parse(raw); } catch { blob = null; }
  if (!blob || typeof blob !== 'object' || Array.isArray(blob))
    return { ok: false, state: blank(), reason: 'corrupt', migrated: false };
  if (Number.isInteger(blob.v) && blob.v > target)
    return { ok: false, state: blank(), reason: 'newer', migrated: false };
  try {
    const { state, steps } = migrate(blob, table, target);
    return { ok: true, state: sanitize(state), reason: null, migrated: steps > 0 };
  } catch {
    return { ok: false, state: blank(), reason: 'corrupt', migrated: false };
  }
}

export function serialize(state) {
  return JSON.stringify(sanitize(state));
}

/**
 * A store over one storage key. `storage` is anything with getItem/setItem/
 * removeItem; every call is wrapped, because localStorage throws in private
 * modes and when the quota is gone, and a game that cannot save must still run.
 */
export function makeStore(storage, key = SAVE_KEY) {
  const get = (k) => { try { return storage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { storage.setItem(k, v); return true; } catch { return false; } };
  const del = (k) => { try { storage.removeItem(k); } catch { /* nothing to do */ } };
  return {
    key,
    /** Is there anything to continue? True only for a save that will load. */
    has() { return parse(get(key)).ok; },
    load() {
      const raw = get(key);
      const res = parse(raw);
      // rule 2: keep what could not be read before anything overwrites it
      if (res.reason === 'corrupt' && raw) set(key + '-corrupt', raw);
      if (res.reason === 'newer' && raw) set(key + '-newer', raw);
      return res;
    },
    /** Write. Refuses to clobber a save from a newer build. */
    save(state, now = Date.now()) {
      if (parse(get(key)).reason === 'newer') return false;
      return set(key, serialize({ ...state, savedAt: now }));
    },
    clear() { del(key); },
    /** Can this storage be written at all? One tiny key, set and taken away
     *  again. False in a browser that blocks site data: the game runs, and
     *  whoever asked can say that nothing is being kept. */
    writable() {
      const ok = set(key + '-probe', '1');
      del(key + '-probe');
      return ok;
    },
    /** The facts for the menu's "Pokračovat" line (and where it was), or null. */
    summary() {
      const res = parse(get(key));
      if (!res.ok) return null;
      const s = res.state;
      // pos: which city the save is in, so the menu's place toggle can show it
      return { money: s.money, played: s.played, savedAt: s.savedAt, car: s.car?.kind ?? null,
        ...(s.prologue ? { prologue: s.prologue } : {}), jobs: fin(s.stats.jobsCourier, 0) + fin(s.stats.jobsTaxi, 0), pos: s.pos };
    },
  };
}

/** The browser's store, or one that holds nothing when storage is unavailable.
 *  Its setItem THROWS, like a blocked localStorage does: a setItem that quietly
 *  did nothing made save() answer true for a game that was keeping nothing. */
export function browserStore() {
  let ls = null;
  try { ls = globalThis.localStorage ?? null; } catch { ls = null; }
  return makeStore(ls ?? { getItem: () => null, setItem: () => { throw new Error('no storage'); }, removeItem: () => {} });
}

/** "1 h 12 min" / "8 min", for the menu and the stats panel. */
export function fmtPlayed(s) {
  const m = Math.floor(Math.max(0, s) / 60);
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min';
}
