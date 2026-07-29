// ---- Terrain: the ground stops being a plane ----
// Every other module in this engine asks one question about the ground —
// `heightAt(x, z)` — and for the whole life of the project the answer was 0,
// plus a few centimetres of bridge deck. That was honest while the world was
// Pardubice, which really is flat. It stopped being honest at Prague, where the
// Vltava runs a hundred metres below Petřín.
//
// This module is the new answer. It holds one height map per 4.8 km world tile
// (scripts/fetch-terrain.mjs, ČÚZK DMR 5G — LiDAR bare earth, free), streams
// them alongside the feature tiles, and samples them bilinearly. Bare earth is
// the right model precisely because buildings and trees have been REMOVED from
// it: the houses this engine extrudes sit on the ground rather than fighting a
// surface that already contains them.
//
// Storage is int16 decimetres, 241 × 241 per tile at 20 m spacing. The grid is
// INCLUSIVE of both edges, which is the whole seam story: a tile's last column
// is the same world point as its neighbour's first, sampled from the same
// service at the same coordinate, so the two agree to the bit and no crack can
// open between them. It is also why 120 m chunks line up exactly — 120/20 = 6
// and 4800/120 = 40, so every chunk corner IS a terrain sample and no chunk
// ever has to interpolate across a tile boundary.
//
// Sampling has to be cheap: it runs per wheel per frame, per vertex at mesh
// build, and per shell of every falling piece of debris. It is four array reads
// and three lerps, with no allocation.

const TERRAIN_URL = (tx, tz) => `data/terrain/${tx}_${tz}.bin`;
const NO_DATA = -32768;

export class Terrain {
  /** @param tile metres per world tile (manifest.tile), @param res metres between samples */
  constructor(tile = 4800, res = 20) {
    this.tile = tile;
    this.res = res;
    this.n = tile / res + 1;              // samples per side, edges inclusive
    this.grids = new Map();               // "tx,tz" → Int16Array | null (failed)
    this._pending = new Set();
    this._listeners = [];
    // Height maps are static files, so a tile that has been fetched once is
    // never re-fetched — but they are also only ~116 KB each, and the whole
    // world is 21 MB, so nothing is ever evicted either. The feature tiles are
    // what cost memory; this is rounding error beside them.
  }

  /** cb({ tx, tz }) after a height map is indexed — city.js rebuilds its chunks */
  onTileLoaded(cb) { this._listeners.push(cb); }

  /**
   * The nearest tile that HAS a height map, searched outward from (tx, tz).
   * Two rings is nine kilometres and is far more than streaming ever needs;
   * past that the honest answer is "no idea".
   */
  _nearestGrid(tx, tz) {
    const memo = this._nearMemo ??= new Map();
    const key = tx + ',' + tz;
    if (memo.has(key)) return memo.get(key);
    let found = null;
    for (let r = 1; r <= 2 && !found; r++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const g = this.grids.get((tx + dx) + ',' + (tz + dz));
          if (g) { found = { g, tx: tx + dx, tz: tz + dz }; break; }
        }
      }
    }
    memo.set(key, found);
    return found;
  }

  /** True once the tile covering (x, z) has its height map. */
  ready(x, z) {
    return !!this.grids.get(Math.floor(x / this.tile) + ',' + Math.floor(z / this.tile));
  }

  /**
   * Start fetching every height map within `reach` of (x, z). Fire-and-forget,
   * mirroring geo.ensureTiles: a failure leaves the tile absent and the ground
   * flat there, which is a worse map but a working game.
   */
  ensure(x, z, reach = 3000) {
    const T = this.tile;
    const t0x = Math.floor((x - reach) / T), t1x = Math.floor((x + reach) / T);
    const t0z = Math.floor((z - reach) / T), t1z = Math.floor((z + reach) / T);
    for (let tx = t0x; tx <= t1x; tx++) {
      for (let tz = t0z; tz <= t1z; tz++) {
        const key = tx + ',' + tz;
        if (this.grids.has(key) || this._pending.has(key)) continue;
        this._pending.add(key);
        fetch(TERRAIN_URL(tx, tz))
          .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((ab) => {
            const want = this.n * this.n * 2;
            if (ab.byteLength < want) throw new Error(`short: ${ab.byteLength} < ${want}`);
            this.grids.set(key, new Int16Array(ab, 0, this.n * this.n));
            this._pending.delete(key);
            this._nearMemo?.clear();          // a miss may now have a better answer
            for (const cb of this._listeners) cb({ tx, tz });
          })
          .catch(() => {
            // Cache the miss. A tile outside the built world has no height map
            // and never will; retrying it every second forever would be a
            // steady drip of 404s for the lifetime of the session.
            this.grids.set(key, null);
            this._pending.delete(key);
          });
      }
    }
  }

  /**
   * Metres above sea level at (x, z), bilinearly interpolated.
   *
   * Where no height map is loaded the answer is the NEAREST KNOWN GROUND, not
   * zero. Zero was a catastrophe dressed as a default: this world sits 170 to
   * 540 m above the sea, so every consumer that sampled unloaded ground got a
   * number four hundred metres wrong and believed it. A forest or park polygon
   * reaching across the boundary had half its vertices on the hillside and
   * half at sea level, and the triangles between them made a sheer wall of
   * stretched photograph hundreds of metres tall — the "jiná dimenze" report.
   * Continuing the nearest known ground flat is wrong too, but it is wrong by
   * the local relief rather than by the altitude of the entire country, and it
   * is invisible where the real fix does its work: `missed` is raised, the
   * chunk is marked incomplete, and it rebuilds when the height map lands.
   */
  heightAt(x, z) {
    const T = this.tile, R = this.res, n = this.n;
    let tx = Math.floor(x / T), tz = Math.floor(z / T);
    let g = this.grids.get(tx + ',' + tz);
    if (!g) {
      this.missed = true;
      const near = this._nearestGrid(tx, tz);
      if (!near) return 0;                    // nothing within 9 km: flat world
      g = near.g; tx = near.tx; tz = near.tz;
      // clamp the query into that tile, so the answer is its closest edge
      x = Math.min(Math.max(x, tx * T), tx * T + T);
      z = Math.min(Math.max(z, tz * T), tz * T + T);
    }
    // position within the tile, in sample units
    const u = (x - tx * T) / R, v = (z - tz * T) / R;
    let i = Math.floor(u), j = Math.floor(v);
    // A point exactly on the tile's far edge lands on the last sample; clamping
    // is EXACT there rather than approximate, because that sample is shared
    // with the neighbour.
    if (i < 0) i = 0; else if (i > n - 2) i = n - 2;
    if (j < 0) j = 0; else if (j > n - 2) j = n - 2;
    const fx = u - i, fz = v - j;
    const o = j * n + i;
    const h00 = g[o], h10 = g[o + 1], h01 = g[o + n], h11 = g[o + n + 1];
    // NoData is rare (water margins, the odd hole) and one bad corner must not
    // drag a whole quad to the sentinel — fall back to any neighbour that has
    // a number rather than interpolating with −3276 m.
    if (h00 === NO_DATA || h10 === NO_DATA || h01 === NO_DATA || h11 === NO_DATA) {
      let sum = 0, k = 0;
      for (const h of [h00, h10, h01, h11]) if (h !== NO_DATA) { sum += h; k++; }
      return k ? sum / k / 10 : 0;
    }
    const a = h00 + (h10 - h00) * fx;
    const b = h01 + (h11 - h01) * fx;
    return (a + (b - a) * fz) / 10;
  }

  /**
   * The lowest and highest ground under a polygon ring, plus the mean — what a
   * building needs to decide where to stand. Samples the ring's vertices and
   * its bounding-box centre, which for the footprints this game extrudes (a few
   * metres to a few tens of metres across) is a truer answer than marching a
   * grid: a courtyard block's interior is not ground it sits on.
   */
  underRing(ring) {
    let lo = Infinity, hi = -Infinity, sum = 0, n = 0;
    let cx = 0, cz = 0;
    for (const [px, pz] of ring) {
      const h = this.heightAt(px, pz);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
      sum += h; n++;
      cx += px; cz += pz;
    }
    if (!n) return { lo: 0, hi: 0, mean: 0 };
    const hc = this.heightAt(cx / n, cz / n);
    if (hc < lo) lo = hc;
    if (hc > hi) hi = hc;
    return { lo, hi, mean: (sum + hc) / (n + 1) };
  }
}

// ---- where a building stands ---------------------------------------------
// ONE answer, shared by everything that has an opinion about a building's
// height: the chunk mesh that extrudes it, the floor plan that furnishes it,
// and the box model that blows it up. They used to disagree — meshes.js founded
// on the terrain while interiors.js founded at absolute zero — and because the
// interior REPLACES the chunk mesh once you get close, every building within
// the draw radius sank to sea level as you walked up to it.
//
// The rule: stand on the LOWEST ground under the footprint, plus a fifth of the
// fall across it. All of it means a house on a slope is buried at its low
// corner; none of it means it floats at the high one. Real buildings are cut
// into the hill, nearer the bottom than the top.
export function groundFor(f, terrain) {
  if (f._gy !== undefined) return f._gy;
  if (!terrain || !f?.o?.length) return 0;
  let lo = Infinity, hi = -Infinity, known = 0, n = 0;
  const ring = f.o;
  const step = Math.max(1, Math.floor(ring.length / 48));
  for (let i = 0; i < ring.length; i += step) {
    n++;
    const px = ring[i][0], pz = ring[i][1];
    // A footprint straddling a tile edge has vertices in a height map that has
    // not arrived; heightAt answers 0 there, and one such vertex would drag the
    // minimum to sea level and bury the building. Only KNOWN ground counts.
    if (!terrain.ready(px, pz)) continue;
    known++;
    const h = terrain.heightAt(px, pz);
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (!known) return 0;                       // nothing known yet: flat, uncached
  const fall = hi - lo;
  const g = lo + Math.min(fall * 0.2, 1.2);
  // Same discipline as the water: never remember a number measured against
  // ground that was not there. The chunk rebuilds when the height map lands.
  if (known > n * 0.6) { f._gy = g; f._gfall = fall; }
  return g;
}

/** The fall across a footprint, for the plinth that hides the cut. */
export function fallFor(f) { return f._gfall ?? 0; }
