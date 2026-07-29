// ---- Canopy: how tall the thing standing here is ----
// The trees in this world grew inside OSM landuse polygons, and OSM's landuse
// is nothing like as complete as its buildings: measured over two full 4.8 km
// tiles beside Pardubice, 51–52 % of the ground carrying real canopy above 3 m
// has no green polygon at all. Half the woods in the country were missing, so
// the aerial photograph showed a forest and the world showed a field.
//
// This is the measured answer. scripts/fetch-canopy.mjs subtracts ČÚZK's bare
// earth model from its surface model, which leaves a raster of "how tall is
// whatever stands at this pixel" — 8 m of hedge, 25 m of spruce, 0 of meadow.
// No classifier and no guess; the trees are where the height is.
//
// Storage mirrors terrain.js closely enough that the two read as siblings, and
// deliberately: 481 × 481 per 4.8 km tile at 10 m spacing, edges INCLUSIVE so
// neighbours share their boundary samples exactly. One byte per sample in
// quarter-metres — a canopy height does not need decimetres, and the whole
// world is then 79 MB against the 561 MB of feature tiles.
//
// Sampling is nearest-neighbour, not bilinear, and that is not laziness: this
// answers "is there a tree here", asked once per candidate trunk during the
// scatter. Interpolating across a wood's edge would invent half-trees along it.

const CANOPY_URL = (tx, tz) => `data/canopy/${tx}_${tz}.bin`;
const NO_DATA = 255;
const STEP = 0.25;                        // m per stored unit

export class Canopy {
  /** @param tile metres per world tile, @param res metres between samples */
  constructor(tile = 4800, res = 10) {
    this.tile = tile;
    this.res = res;
    this.n = tile / res + 1;              // 481, edges inclusive
    this.grids = new Map();               // "tx,tz" → Uint8Array | null (failed)
    this._pending = new Set();
    this._listeners = [];
  }

  /** cb({ tx, tz }) once a tile's canopy is in — city.js rebuilds those chunks */
  onTileLoaded(cb) { this._listeners.push(cb); }

  /** True once the tile covering (x, z) has its canopy raster. */
  ready(x, z) {
    return !!this.grids.get(Math.floor(x / this.tile) + ',' + Math.floor(z / this.tile));
  }

  /**
   * Start fetching every canopy raster within `reach` of (x, z). Fire and
   * forget, exactly like Terrain.ensure: a failure leaves the tile absent and
   * the woods there fall back to the OSM polygons, which is the old behaviour
   * rather than a hole.
   */
  ensure(x, z, reach = 2000) {
    const T = this.tile;
    const t0x = Math.floor((x - reach) / T), t1x = Math.floor((x + reach) / T);
    const t0z = Math.floor((z - reach) / T), t1z = Math.floor((z + reach) / T);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let tz = t0z; tz <= t1z; tz++) {
        const key = tx + ',' + tz;
        if (this.grids.has(key) || this._pending.has(key)) continue;
        this._pending.add(key);
        fetch(CANOPY_URL(tx, tz))
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((ab) => {
            const want = this.n * this.n;
            if (ab.byteLength < want) throw new Error(`short: ${ab.byteLength} < ${want}`);
            this.grids.set(key, new Uint8Array(ab, 0, want));
            this._pending.delete(key);
            for (const cb of this._listeners) cb({ tx, tz });
          })
          .catch(() => {
            // Cache the miss: a tile outside the built world has no canopy and
            // never will, and retrying it forever is a steady drip of 404s.
            this.grids.set(key, null);
            this._pending.delete(key);
          });
      }
    }
  }

  /**
   * Metres of whatever stands at (x, z) — canopy, building, crane. Returns 0
   * where nothing is loaded, so a caller that has not got the raster yet plants
   * nothing rather than planting a forest.
   */
  heightAt(x, z) {
    const T = this.tile, R = this.res, n = this.n;
    const tx = Math.floor(x / T), tz = Math.floor(z / T);
    const g = this.grids.get(tx + ',' + tz);
    if (!g) return 0;
    let i = Math.round((x - tx * T) / R), j = Math.round((z - tz * T) / R);
    if (i < 0) i = 0; else if (i > n - 1) i = n - 1;
    if (j < 0) j = 0; else if (j > n - 1) j = n - 1;
    const v = g[j * n + i];
    return v === NO_DATA ? 0 : v * STEP;
  }
}
