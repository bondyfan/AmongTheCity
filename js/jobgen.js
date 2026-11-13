// ---- Job generator: today's work, in this part of town ----
// A pure function from (the named places that exist, the day, where the board
// was opened) to a list of offers. No Math.random and no clock: the same day
// in the same neighbourhood offers the same six jobs on every machine and on
// every reload, which is what makes a job something you can come back to, and
// what makes this file testable (tests/jobs.test.mjs).
//
// The places are REAL: named venues and named buildings out of the tiles,
// collected by js/jobplaces.js. This module never invents a name; it only
// decides which two of them a job runs between.

// ---- hashing --------------------------------------------------------------
// FNV-1a over the string, then an avalanche, the same family identity.js uses.
// Kept local because identity.js reaches for localStorage and this file must
// import in node without a browser around it.
export function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return h >>> 0;
}

/** mulberry32: a 0..1 stream from one 32-bit seed. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The day a board belongs to, in the player's own calendar. */
export function dayKey(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return date.getFullYear() + '-' + p(date.getMonth() + 1) + '-' + p(date.getDate());
}

// ---- which places do which work -------------------------------------------
// OSM trade keys, as the tiles carry them. A parcel leaves from somewhere that
// plausibly sends parcels; a fare waits where people wait.
const COURIER_FROM = new Set(['restaurant', 'fast_food', 'cafe', 'bakery', 'pastry',
  'florist', 'pharmacy', 'butcher', 'books', 'electronics', 'stationery', 'wine',
  'post_office', 'supermarket', 'convenience', 'chemist', 'pub', 'kiosk', 'newsagent']);
const TAXI_FROM = new Set(['station', 'bus_stop', 'hotel', 'pub', 'bar', 'restaurant',
  'theatre', 'cinema', 'hospital', 'supermarket', 'townhall', 'bank', 'library',
  'school', 'attraction', 'museum', 'nightclub', 'clinic', 'doctors']);
// A fare never asks to be driven to a bus stop (that is where they came from),
// and nobody has lunch delivered to one: both jobs end at a real address.
const TO_SKIP = new Set(['bus_stop', 'kiosk']);

export const BOARD_CELL = 900;       // m: the size of "this part of town"
const PICK_R = 1500;                 // m: pick-ups come from this far round the cell
const RANGE = {
  courier: [350, 2600],              // m, straight line pick-up to drop-off
  taxi: [600, 4200],
};
const TRIES = 24;                    // candidates tried per offer before giving up

// Who is waiting at the kerb. Flavour only, and deterministic like the rest.
const FARES = ['paní Nováková', 'pan Dvořák', 'paní Svobodová', 'pan Černý',
  'paní Procházková', 'pan Kučera', 'paní Veselá', 'pan Horák', 'paní Marková',
  'pan Pokorný', 'slečna Jelínková', 'pan Růžička', 'paní Benešová', 'pan Fiala',
  'paní Sedláčková', 'pan Zeman', 'paní Kolářová', 'pan Urban'];
const PARCELS = ['oběd', 'balíček', 'kytici', 'léky', 'dokumenty', 'nákup', 'dort', 'zásilku'];
const PARCEL_BY_TYPE = {
  restaurant: 'oběd', fast_food: 'oběd', pub: 'oběd', cafe: 'kávu a zákusky',
  bakery: 'pečivo', pastry: 'dort', florist: 'kytici', pharmacy: 'léky',
  chemist: 'drogerii', butcher: 'maso', books: 'knihy', electronics: 'elektroniku',
  stationery: 'kancelářské potřeby', wine: 'víno', post_office: 'balíček',
  supermarket: 'nákup', convenience: 'nákup', kiosk: 'noviny', newsagent: 'noviny',
};

function cellOf(x, z) {
  return [Math.floor(x / BOARD_CELL), Math.floor(z / BOARD_CELL)];
}

/**
 * generateJobs → Job[]
 *
 *   places   [{ id, name, type, x, z, street? }]  every named place on offer
 *   origin   { x, z }       where the board is being read
 *   day      string         dayKey(); the seed's calendar half
 *   shift    integer        bumped when a board has been worked through
 *   counts   { courier, taxi }
 *   done     Set<string>    ids already finished today (never offered twice)
 *   resolve  (place) → { x, z, street } | null
 *            where a car can actually stop for this place. The generator calls
 *            it only for places it wants to use and skips those it cannot
 *            reach; it must be deterministic for the board to be.
 */
export function generateJobs({ places, origin, day, shift = 0,
  counts = { courier: 3, taxi: 3 }, done = null, resolve = null }) {
  const out = [];
  if (!Array.isArray(places) || !places.length || !origin) return out;
  const [cx, cz] = cellOf(origin.x, origin.z);
  const mx = (cx + 0.5) * BOARD_CELL, mz = (cz + 0.5) * BOARD_CELL;
  // Sorted by id so the candidate order is a fact about the map and not about
  // the order the tiles happened to arrive in.
  const all = places.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // one resolve per place per board: it walks road segments, and the same
  // supermarket is a candidate drop-off for every offer on the list
  const stops = new Map();
  const stopOf = (p) => {
    if (!stops.has(p.id))
      stops.set(p.id, resolve ? resolve(p) : { x: p.x, z: p.z, street: p.street ?? null });
    return stops.get(p.id);
  };
  const used = new Set();
  for (const kind of ['courier', 'taxi']) {
    const want = counts[kind] | 0;
    if (want <= 0) continue;
    const fromSet = kind === 'courier' ? COURIER_FROM : TAXI_FROM;
    const near = all.filter((p) => fromSet.has(p.type)
      && Math.hypot(p.x - mx, p.z - mz) <= PICK_R);
    if (!near.length) continue;
    const rnd = rng(hash32(day + '|' + shift + '|' + cx + ',' + cz + '|' + kind));
    const [dMin, dMax] = RANGE[kind];
    let made = 0;
    for (let t = 0; t < TRIES * want && made < want; t++) {
      const from = near[(rnd() * near.length) | 0];
      // Draw the drop-off BEFORE any test that can reject the pair, so the
      // stream of random numbers is consumed identically whatever the resolver
      // answers: one unreachable shop must not reshuffle every later offer.
      const pick = rnd(), flavour = rnd();
      if (used.has(from.id)) continue;
      const fs = stopOf(from);
      if (!fs) continue;
      const tos = all.filter((p) => {
        if (p === from || used.has(p.id)) return false;
        if (TO_SKIP.has(p.type)) return false;
        const d = Math.hypot(p.x - from.x, p.z - from.z);
        return d >= dMin && d <= dMax;
      });
      if (!tos.length) continue;
      const to = tos[(pick * tos.length) | 0];
      const ts = stopOf(to);
      if (!ts) continue;
      const id = kind[0] + hash32(day + '|' + kind + '|' + from.id + '|' + to.id).toString(36);
      if (done?.has(id)) continue;
      used.add(from.id); used.add(to.id);
      out.push({
        id, kind,
        // x, z: where the car stops. wx, wz: the kerb beside it (the fare's feet).
        from: { name: from.name, type: from.type, x: fs.x, z: fs.z,
          wx: fs.wx ?? fs.x, wz: fs.wz ?? fs.z, street: fs.street ?? null },
        to: { name: to.name, type: to.type, x: ts.x, z: ts.z,
          wx: ts.wx ?? ts.x, wz: ts.wz ?? ts.z, street: ts.street ?? null },
        distM: Math.round(Math.hypot(ts.x - fs.x, ts.z - fs.z)),
        who: kind === 'taxi' ? FARES[(flavour * FARES.length) | 0] : null,
        what: kind === 'courier'
          ? (PARCEL_BY_TYPE[from.type] ?? PARCELS[(flavour * PARCELS.length) | 0]) : null,
      });
      made++;
    }
  }
  return out;
}

/** "Sladkovského" for a place with a street, the bare name otherwise. */
export function placeLabel(p) {
  if (!p) return '';
  return p.street && p.street !== p.name ? p.name + ', ' + p.street : p.name;
}
