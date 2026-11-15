// ---- pumps.js: every fuel poi that has streamed in, and where its pumps are ----
// main.js's pump index, moved out so the fuel shop (js/jobplaces.js, E on
// foot) can ask the same list. No three, no DOM: node-testable.
//
// `city.pois` is a FLAT array that geo.js never bucketizes and never evicts,
// so it grows to tens of thousands of entries as you drive the region;
// filtering the fuel ones out once, as each tile arrives, leaves at most the
// 1 178 in the region and in practice a few dozen. Scanning THAT is free.
//
// WHERE A PUMP IS. Not "within 14 m of the node" any more: the forecourt is
// drawn off the node (slid back from the kerb, or framed under its mapped
// canopy), so the question is answered from the same frame the mesher draws
// (js/forecourt.js). A built frame depends on the roads of the node's chunk,
// so it is cached against that cell's road count and recomputed when a
// neighbouring tile adds one.

import { forecourtFrame, atForecourt, frameDist2 } from './forecourt.js';

const CHUNK = 120;                 // config.js CHUNK (kept local: no imports beyond the pure helper)
const REACH2 = 60 * 60;            // m^2 from a node beyond which no frame is worth computing

const _pumps = [];
const _frames = new Map();         // poi -> { f, n } (frame, the cell's road count it was made from)

/** File the fuel pois of a list (a tile's pois, or city.pois at boot). */
export function indexPumps(pois) {
  for (const p of pois ?? []) if (p.t === 'fuel' && p.p) _pumps.push(p);
}

/** Every fuel poi known so far (read only). */
export function pumpList() { return _pumps; }

/** Forget them all (a test, or a new world). */
export function resetPumps() { _pumps.length = 0; _frames.clear(); }

function cellRoads(city, x, z) {
  const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
  return city?.chunkIndex?.get(k)?.roads ?? null;
}

/** The forecourt frame of one fuel poi, as the mesher drew it. */
export function frameOf(city, poi) {
  const roads = poi.cv ? null : cellRoads(city, poi.p[0], poi.p[1]);
  const n = roads ? roads.length : -1;
  const have = _frames.get(poi);
  if (have && have.n === n) return have.f;
  const f = forecourtFrame(poi, roads ?? [], {});
  _frames.set(poi, { f, n });
  return f;
}

/**
 * The fuel poi whose forecourt (x, z) stands on, nearest first, or null.
 * `margin` grows the apron/roof (metres).
 */
export function pumpAt(city, x, z, margin = 1.5) {
  let best = null, bd = Infinity;
  for (let i = 0; i < _pumps.length; i++) {
    const p = _pumps[i];
    const dx = p.p[0] - x, dz = p.p[1] - z;
    if (dx * dx + dz * dz > REACH2) continue;
    const f = frameOf(city, p);
    if (!atForecourt(f, x, z, margin)) continue;
    const d = frameDist2(f, x, z);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

/**
 * The fuel shop the player stands at on foot: a forecourt within `r` metres
 * of its frame centre (the till is under or beside the canopy), or null.
 */
export function shopAt(city, x, z, r = 18) {
  let best = null, bd = Infinity;
  for (let i = 0; i < _pumps.length; i++) {
    const p = _pumps[i];
    const dx = p.p[0] - x, dz = p.p[1] - z;
    if (dx * dx + dz * dz > REACH2) continue;
    const f = frameOf(city, p);
    const d = frameDist2(f, x, z);
    if (d > r * r && !atForecourt(f, x, z, 3)) continue;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
