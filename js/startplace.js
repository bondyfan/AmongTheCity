// ---- where a game begins, and which city you are in ----
// Pure (no DOM, no three.js): the menu, the career, main.js's boot and the
// tests all ask the same three questions and must get the same answers.
//
//   placeOf(x, z)            the START_PLACES entry nearest a point (the city
//                            a save, a death or a fleet belongs to)
//   startPoint(pick, saved)  where boot stands the player: the save when it
//                            lies in the city picked in the menu (or no city
//                            was picked), else that city's start square
//   nearestHospital(x, z)    the respawn point after the death card (on the
//                            D11 corridor: the nearest services)
//   tilesReady(city, x, z)   are all tiles around a point fully indexed (the
//                            fleet of a place is only parked then, so every
//                            client parks it from the same data)
//
// "Nearest" over two points 96 km apart is the right test for the D11
// corridor too: a save in Kolín belongs to Pardubice, one in Úvaly to Praha.

import { START_PLACES, HOSPITALS } from './config.js';
import { sites } from './d11services.js';
import { region } from './regions.js';

// A death out on the D11 corridor used to wake you in Pardubice or Prague, up
// to 55 km back (round 8): past FAR_HOSPITAL from either hospital, the
// nearest motorway services within SERVICES_R takes the patient instead (the
// ambulance's first stop; the fee is the same). Pure data, so the death save
// (career.js) and the respawn (main.js) agree.
const FAR_HOSPITAL = 15000;   // m
const SERVICES_R = 20000;     // m

const nearestOf = (list, x, z) => {
  let best = list[0], bd = Infinity;
  for (const p of list) {
    const d = (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
};

/** The START_PLACES entry nearest (x, z); the first one for a bad point. */
export function placeOf(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return START_PLACES[0];
  return nearestOf(START_PLACES, x, z);
}

/** The START_PLACES entry with this id, or null. */
export function placeById(id) {
  return START_PLACES.find((p) => p.id === id) ?? null;
}

/** Index of a place in START_PLACES (its fleet's claim-key block). */
export function placeIndex(place) {
  return START_PLACES.indexOf(place);
}

/**
 * Where boot stands the player. `pick` is the menu's place id (or null),
 * `saved` the save's { x, z, h } (or null). A save is continued where it was
 * when it lies in the picked city; picking the other city starts there with
 * the same career (money, car, stats), on that city's square.
 * Returns { x, z, heading, place, saved: bool }.
 */
export function startPoint(pick, saved) {
  const want = placeById(pick);
  const ok = saved && Number.isFinite(saved.x) && Number.isFinite(saved.z);
  if (ok && (!want || placeOf(saved.x, saved.z) === want)) {
    return { x: saved.x, z: saved.z, heading: Number.isFinite(saved.h) ? saved.h : 0,
      place: placeOf(saved.x, saved.z), saved: true };
  }
  const p = want ?? START_PLACES[0];
  return { x: p.x, z: p.z, heading: p.heading, place: p, saved: false };
}

/** The HOSPITALS entry nearest (x, z). */
export function nearestHospital(x, z) {
  // another region has its own hospitals and no D11 (js/regions.js)
  const own = region().hospitals;
  if (own?.length) return Number.isFinite(x) && Number.isFinite(z) ? nearestOf(own, x, z) : own[0];
  if (!Number.isFinite(x) || !Number.isFinite(z)) return HOSPITALS[0];
  const h = nearestOf(HOSPITALS, x, z);
  if (Math.hypot(h.x - x, h.z - z) <= FAR_HOSPITAL) return h;
  let best = null, bd = SERVICES_R;
  for (const s of sites()) {
    if (!s.fuel) continue;                    // a fuel station, with people at it
    // ...and its own spot: Dolní Roveň (D35) has no fuel poi, and its point is
    // the slip roads' midpoint, out on the carriageway (round 8 review)
    if (!s.exact) continue;
    const d = Math.hypot(s.x - x, s.z - z);
    if (d < bd) { bd = d; best = s; }
  }
  return best ? { x: best.x, z: best.z, name: 'Odpočívka ' + best.name } : h;
}

/** "Přijíždíte do Prahy…" for the boot cover. */
export function arriveText(place) {
  return 'Přijíždíte ' + (place?.to ?? START_PLACES[0].to) + '…';
}

/**
 * True when every manifest tile whose rectangle comes within `r` m of (x, z)
 * is indexed with its buildings (state 2), and there is at least one. A
 * legacy single-file city has no manifest: ready when the point's cell exists.
 */
export function tilesReady(city, x, z, r = 400, chunk = 120) {
  const tiles = city?.manifestTiles, T = city?.tile;
  if (!tiles || !T) return !!city?.chunkIndex?.has(Math.floor(x / chunk) + ',' + Math.floor(z / chunk));
  let n = 0;
  for (const t of tiles) {
    const dx = Math.max(t.tx * T - x, 0, x - (t.tx + 1) * T);
    const dz = Math.max(t.tz * T - z, 0, z - (t.tz + 1) * T);
    if (dx * dx + dz * dz > r * r) continue;
    if (t.state !== 2) return false;
    n++;
  }
  return n > 0;
}
