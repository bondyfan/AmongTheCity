// ---- what the unmapped ground is sealed with, shipped as a raster ----------
// The offline classifier (scripts/classify-ground.mjs) reads the ČÚZK
// orthophoto once and decides, for every 4 m cell of ground no OSM polygon
// covers, whether it is sealed and what it is made of. For a while it shipped
// that answer as POLYGONS in the tile, and that was wrong twice over:
//
//   · nine thousand rectangles per city tile — 2.3 MB of coordinates for
//     information that is a byte per cell, tripling the tile;
//   · a polygon is a plate floating at its own layer height, and a LEVELLED
//     road may cut 14 cm into the hill, so the plate could sit above the
//     carriageway and bury it. "Silnice mizí a pod nimi je dlažba" was this,
//     and no amount of raster-side subtraction fixes a layering conflict.
//
// So it ships as what it is: a raster. Run-length encoded, ~20–150 kB per city
// tile, nothing at all for open country. The client turns the cells into a few
// merged rectangles per chunk and lays them LAYER_Y.inferred = 4 cm over the
// ground — below every OSM fill (green at 5 cm outranks a disputed claim) and
// far below the shallowest levelled road (+6 cm at full cut, drawn at
// LAYER_Y.road above its grade), so a road can never be buried again. Storage
// and fetching mirror canopy.js deliberately; the two read as siblings.

const URL_OF = (tx, tz) => `data/ground/${tx}_${tz}.bin`;
export const GROUND_RES = 4;             // m per cell — the classifier's own grid
const TILE = 4800;
const N = TILE / GROUND_RES;             // 1200 cells a side
const CHUNK = 120;
const C = CHUNK / GROUND_RES;            // 30 cells per chunk side

export class GroundClass {
  constructor() {
    this.grids = new Map();              // "tx,tz" → Uint8Array | null (no such tile)
    this._pending = new Set();
    this._listeners = [];
    // Raised whenever classAt answers for a tile still in flight — the chunk
    // that asked was built on a guess and rebuilds when the raster lands.
    this.missed = false;
  }

  onTileLoaded(cb) { this._listeners.push(cb); }

  /** 0 = nothing inferred here, 1 = paving, 2 = asphalt. */
  classAt(x, z) {
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    const g = this.grids.get(tx + ',' + tz);
    if (g === null) return 0;            // definitively absent — open country
    if (!g) { this.missed = true; return 0; }
    let i = Math.floor((x - tx * TILE) / GROUND_RES);
    let j = Math.floor((z - tz * TILE) / GROUND_RES);
    if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
    if (j < 0) j = 0; else if (j > N - 1) j = N - 1;
    return g[j * N + i];
  }

  /**
   * The chunk's inferred ground as a handful of merged rectangles, world
   * coordinates: { x0, z0, x1, z1, c }. Row runs merged vertically while both
   * span and class agree — a square comes back as one rectangle, not 900.
   */
  rectsIn(cx0, cz0) {
    const tx = Math.floor(cx0 / TILE), tz = Math.floor(cz0 / TILE);
    const g = this.grids.get(tx + ',' + tz);
    if (g === null) return [];
    if (!g) { this.missed = true; return []; }
    const i0 = Math.round((cx0 - tx * TILE) / GROUND_RES);
    const j0 = Math.round((cz0 - tz * TILE) / GROUND_RES);
    const out = [];
    let open = new Map();                // "i,w,c" → rect still growing downward
    for (let j = 0; j < C; j++) {
      const next = new Map();
      let i = 0;
      while (i < C) {
        const c = g[(j0 + j) * N + (i0 + i)];
        if (!c) { i++; continue; }
        let w = 1;
        while (i + w < C && g[(j0 + j) * N + (i0 + i + w)] === c) w++;
        const key = i + ',' + w + ',' + c;
        const grown = open.get(key);
        if (grown) { grown.rows++; next.set(key, grown); open.delete(key); }
        else next.set(key, { i, j, w, rows: 1, c });
        i += w;
      }
      for (const r of open.values()) out.push(r);
      open = next;
    }
    for (const r of open.values()) out.push(r);
    return out.map((r) => ({
      x0: cx0 + r.i * GROUND_RES, z0: cz0 + r.j * GROUND_RES,
      x1: cx0 + (r.i + r.w) * GROUND_RES, z1: cz0 + (r.j + r.rows) * GROUND_RES,
      c: r.c,
    }));
  }

  /** Fetch every raster within `reach` — fire and forget, like Canopy.ensure. */
  ensure(x, z, reach = 2000) {
    const t0x = Math.floor((x - reach) / TILE), t1x = Math.floor((x + reach) / TILE);
    const t0z = Math.floor((z - reach) / TILE), t1z = Math.floor((z + reach) / TILE);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let tz = t0z; tz <= t1z; tz++) {
        const key = tx + ',' + tz;
        if (this.grids.has(key) || this._pending.has(key)) continue;
        this._pending.add(key);
        fetch(URL_OF(tx, tz))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((ab) => {
            this.grids.set(key, decodeRLE(ab, N * N));
            this._pending.delete(key);
            for (const cb of this._listeners) cb({ tx, tz });
          })
          .catch(() => {
            // Cache the miss: a tile that was never classified has no raster
            // and never will — open country falls back to the field, correctly.
            this.grids.set(key, null);
            this._pending.delete(key);
          });
      }
    }
  }
}

/** (uint16 LE run length, uint8 value)* — must decode to exactly `want` cells. */
export function decodeRLE(ab, want) {
  const dv = new DataView(ab);
  const out = new Uint8Array(want);
  let o = 0, p = 0;
  while (p + 3 <= dv.byteLength && o < want) {
    const n = dv.getUint16(p, true), v = dv.getUint8(p + 2);
    out.fill(v, o, Math.min(want, o + n));
    o += n; p += 3;
  }
  if (o !== want) throw new Error(`ground raster short: ${o} of ${want} cells`);
  return out;
}
