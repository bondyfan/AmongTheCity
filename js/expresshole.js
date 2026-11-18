// ---- expresshole.js: the ride through the untiled ground (round 10) ----
// Split out of js/express.js (the 400-line rule). Line 010 runs ~20 km from
// just west of Prelouc to Kolin over ground no manifest tile covers (survey
// d11left (d)): no height map, no ground mesh, the terrain answers the
// nearest known ground continued flat. A rider is not shown that: the screen
// fades and the train is skipped on to tiled ground with the skip's own
// steps. Building the missing tiles is the real fix and needs the owner.

import { tilesReady } from './startplace.js';

const JUMP = 2000;                          // m per step: inside TILE_REACH (2600 m), as the skip

// ---- through the untiled ground -----------------------------------------------
/**
 * The ridden train has run onto ground no manifest tile covers: fade out,
 * move it on along the line JUMP m at a time (the skip's steps) until it
 * stands over a tile again, fade in, and let it run on at the speed it had.
 * A station passed in the dark is not called at (no one boards in a field
 * with no ground under it), but at each the express still takes the line
 * toward Prague, as it would standing there (at Kolin the straightest route
 * runs on to Kutna Hora). Local state only, like the skip.
 */
export async function throughHole(ex, fade = ex.fade) {
  const tr = ex.trains, t = tr.riding;
  if (!t || ex.skipping) return false;
  ex.skipping = true;
  const v0 = t.speed;
  t.hold = true;
  let ok = false;
  const pin = setInterval(() => ex._land(t), 100);
  try {
    await fade?.(1);
    for (let i = 0; i < 40 && tr.riding === t; i++) {
      const st = tr._nextStop(t);
      const end = t.dir > 0 ? tr._sHi(t) : tr._sLo(t);
      const goal = st ? Math.max(tr._sLo(t), Math.min(tr._sHi(t), st.s)) : end;
      const step = Math.max(-JUMP, Math.min(JUMP, goal - t.s));
      if (Math.abs(step) < 0.5) {
        if (st) {
          // a call in the dark: pass it, on the line toward Prague
          t.station = st;
          if (t.express) ex.towardPrague(t);
          t.departed = t.station; t.station = null;
          continue;
        }
        tr._pending = true;
        await sleep(400);
        if (ex.transfer(t)) continue;
        break;                                  // the end of the line, in the dark
      }
      t.s += step;
      tr._place(t, 0); tr._syncRide(); ex._land(t);
      ex.city.ensureTiles?.(t.x, t.z)?.catch?.(() => {});
      if (untiledAt(ex.city, t.x, t.z)) continue;
      await until(() => loaded(ex.city, t.x, t.z, 800), 25000);
      await sleep(250);
      tr._reheight?.();
      tr._place(t, 0); tr._syncRide(); ex._land(t);
      ok = true;
      break;
    }
  } finally {
    clearInterval(pin);
    ex._land(t);
    t.hold = false;
    t.speed = v0;
    await fade?.(0);
    ex.skipping = false;
  }
  return ok;
}

// Every manifest tile within r of (x, z) indexed. Unlike startplace.tilesReady
// NO tile at all counts as loaded: line 010 between Přelouč and Kolín runs
// along the corridor's edge, outside the world's tiles (measured: x -24 900,
// no manifest tile), and a skip waited 25 s at every step there.
export function loaded(city, x, z, r) {
  const tiles = city?.manifestTiles, T = city?.tile;
  if (!tiles || !T) return tilesReady(city, x, z, r);
  for (const q of tiles) {
    const dx = Math.max(q.tx * T - x, 0, x - (q.tx + 1) * T);
    const dz = Math.max(q.tz * T - z, 0, z - (q.tz + 1) * T);
    if (dx * dx + dz * dz <= r * r && q.state !== 2) return false;
  }
  return true;
}

// Is (x, z) over no manifest tile at all (the hole around Kolin)? The
// manifest is append-only, so its keys are cached by its length.
let _tileKeys = null, _tileN = -1;
export function untiledAt(city, x, z) {
  const tiles = city?.manifestTiles, T = city?.tile;
  if (!tiles?.length || !T) return false;
  if (tiles.length !== _tileN) {
    _tileN = tiles.length;
    _tileKeys = new Set(tiles.map((q) => q.tx + ',' + q.tz));
  }
  return !_tileKeys.has(Math.floor(x / T) + ',' + Math.floor(z / T));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function until(test, maxMs) {
  const t0 = performance.now();
  while (!test() && performance.now() - t0 < maxMs) await sleep(120);
}
