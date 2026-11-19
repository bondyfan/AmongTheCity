// ---- birdscan.js: the map round the player, searched a chunk at a time ---------
// The part of js/birds.js that keeps its list of flocks in step with the map:
// which chunks have been searched for perches (js/birdperches.js), which
// flocks live in them now (js/birdsites.js), and which have been left behind.
//
// SEARCHING IS THE DEAR PART (a millisecond or two for a dense Prague block),
// so a chunk's candidates are found once and kept, and found again only when
// its lamp masts change (they arrive with the chunk's near tier, and a felled
// one is gone). JUDGING the kept candidates is cheap, and that is all the
// passing of the hour needs: who is out at dusk is a new answer about the same
// places.

import { CHUNK } from './config.js';
import { SPECIES, flockAt, hash32, rnd01 } from './birdsites.js';
import { chunkPerches } from './birdperches.js';

const SCAN_R = 150, DROP_R = 260;       // chunks searched for perches, and forgotten
const LOOK = 6;                         // s between two looks at a chunk that is already known

// how many lamp masts stand in the chunk: what its candidates depend on
function masts(B, key) {
  const [i, j] = key.split(',');
  let n = 0;
  for (const p of B.env.world?.poles?.near((+i + 0.5) * CHUNK, (+j + 0.5) * CHUNK, CHUNK * 0.75, B._near ??= []) ?? []) {
    if (Math.floor(p.x / CHUNK) === +i && Math.floor(p.z / CHUNK) === +j) n++;
  }
  return n;
}

// the hour to a quarter, and the density: what the judging depends on
const mood = (B) => Math.floor((B.env.hourOf?.() ?? 12) * 4) + ':' + B.density;

function search(B, key) {
  const env = B.env;
  const got = chunkPerches(key, { city: env.city, terrain: env.world?.terrain, poles: env.world?.poles,
    signs: env.signs, sites: env.sites, hidden: env.world?.interiors?.hidden });
  const old = B.chunks.get(key);
  const ch = { t: B._t, ids: old?.ids ?? [], spares: [], cands: got.cands, urban: got.urban, masts: masts(B, key), mood: null };
  B.chunks.set(key, ch);
  judge(B, key, ch);
}

// which of a chunk's candidates hold a flock at this hour
function judge(B, key, ch) {
  const hour = B.env.hourOf?.() ?? 12;
  const ids = [], spares = [], seen = new Set();
  for (const cand of ch.cands) {
    const fl = flockAt(cand, { urban: ch.urban, water: cand.water, hour, density: B.density });
    if (!fl) { spares.push(cand); continue; }
    if (seen.has(fl.id)) continue;
    seen.add(fl.id); ids.push(fl.id);
    if (B.flocks.has(fl.id)) continue;
    B.flocks.set(fl.id, { ...fl, home: cand, cand, sp: SPECIES[fl.species], birds: null, state: 'idle',
      x: cand.x, z: cand.z, calm: 0, roam: 20 + 120 * rnd01(hash32(fl.id, 77)) });
  }
  // a flock the hour has sent home leaves if it is out, and is forgotten if it is not
  for (const id of ch.ids) {
    if (seen.has(id)) continue;
    const f = B.flocks.get(id);
    if (f?.birds && f.state === 'sit') { B._flushFlock(f, f.x + 1, f.z, true, true); f.dead = true; ids.push(id); }
    else if (f?.birds) ids.push(id);
    else B.flocks.delete(id);
  }
  ch.ids = ids; ch.spares = spares; ch.mood = mood(B); ch.t = B._t;
}

/** One step of keeping up with the map: at most one chunk searched or judged. */
export function scanStep(B, fx, fz) {
  const env = B.env, c0 = Math.floor((fx - SCAN_R) / CHUNK), c1 = Math.floor((fx + SCAN_R) / CHUNK);
  const d0 = Math.floor((fz - SCAN_R) / CHUNK), d1 = Math.floor((fz + SCAN_R) / CHUNK);
  let fresh = null, stale = null, age = LOOK;
  for (let i = c0; i <= c1 && !fresh; i++) for (let j = d0; j <= d1; j++) {
    const key = i + ',' + j;
    if (!env.world?.built?.get(key)) continue;             // its lamps and signs do not stand yet
    const ch = B.chunks.get(key);
    if (!ch) { fresh = key; break; }
    if (B._t - ch.t > age) { stale = key; age = B._t - ch.t; }
  }
  if (fresh) search(B, fresh);
  else if (stale) {
    const ch = B.chunks.get(stale);
    if (ch.masts !== masts(B, stale)) search(B, stale);
    else if (ch.mood !== mood(B)) judge(B, stale, ch);
    else ch.t = B._t;
  }
  for (const [key, ch] of B.chunks) {
    const [i, j] = key.split(',');
    const dx = (+i + 0.5) * CHUNK - fx, dz = (+j + 0.5) * CHUNK - fz;
    if (dx * dx + dz * dz > DROP_R * DROP_R) {
      for (const id of ch.ids) B._forget(B.flocks.get(id));
      B.chunks.delete(key);
    }
  }
}
