// ---- where grass grows, answered in one array lookup ----------------------
// The first version of the grass asked, per candidate tuft, "is there a road
// within half its width, a car park polygon, a building, water, a green
// polygon?" — a few hundred distance and point-in-polygon tests each, several
// thousand times, in one frame, every time the player walked far enough. That
// is the stutter: the work is not the grass, it is the QUESTION.
//
// It is also the wrong shape of question. A road is a long thin thing and a
// candidate is a point; asking the point about every road is O(points × roads)
// when the answer only varies over the area the road actually covers. So turn
// it round and RASTERISE: walk each feature once, stamping the cells it covers
// into a byte per square metre of chunk. Cost stops depending on how many tufts
// you want and starts depending on how much ground the features cover, which is
// the thing that is actually bounded.
//
// After that the grass asks an array. 14 400 bytes per 120 m chunk, built once,
// reused for every rebuild of the ring that passes over it.
//
// The values are grass HEIGHT in centimetres — 0 means bare, and bare is what
// tarmac, paving, a building footprint and water all are. Height rather than a
// flag because the same raster then carries the difference between a mown verge
// and an unmown meadow, which is most of what stops a field looking like a lawn.

import { CHUNK } from './config.js';
import { chunkKey } from './geo.js';

const RES = 1;                        // m per mask cell
const N = CHUNK / RES;                // 120 cells a side
// Centimetres, and they are the REAL height the blades are built at — not an
// index into a range. A mown Czech lawn is 4–8 cm and that is under a pixel at
// any playable camera, so these are roughly double life size; past that it
// stops being grass and starts being a wheat field, which is what the first
// pass looked like.
const UNMAPPED = 13;                  // ground nobody mapped, kept short
const MOWN = 17;                      // a park, a garden, a verge
const MEADOW = 48;                    // left to grow

const MEADOW_TYPES = new Set(['meadow', 'grassland', 'heath', 'scrub', 'village_green']);
// A pitch is mown to the ground and a cemetery is mostly stone: both read
// wrong with tufts standing in them.
const BARE_GREEN = new Set(['pitch', 'cemetery']);

export class GrassMask {
  /** @param city the indexed city; @param ground the sealed-ground raster */
  constructor(city, ground = null) {
    this.city = city;
    this.ground = ground;
    this.masks = new Map();           // chunk key → Uint8Array(N*N)
    this.queue = [];                  // keys waiting to be rasterised
    this._queued = new Set();
  }

  /** Drop everything — a tile arriving changes what the ground is made of. */
  clear() { this.masks.clear(); this.queue.length = 0; this._queued.clear(); }

  /**
   * Drop only what a newly arrived tile actually changed. `clear()` threw away
   * every rasterised chunk in memory, and it is wired to EVERY city tile and
   * every ground-raster tile arrival — so one tile landing blanked the grass
   * for the whole world and it came back one 120 m block per frame. That is
   * the "loads in blocks" the player sees, and no amount of distance fading
   * hides it, because the holes are chunk-shaped rather than ring-shaped.
   * A tile is 4.8 km of chunks; anything outside it is still valid.
   */
  clearTile(tx, tz, tile) {
    if (tx === undefined || tz === undefined || !tile) { this.clear(); return; }
    const c0x = Math.floor((tx * tile) / CHUNK), c1x = Math.floor(((tx + 1) * tile) / CHUNK);
    const c0z = Math.floor((tz * tile) / CHUNK), c1z = Math.floor(((tz + 1) * tile) / CHUNK);
    for (const key of [...this.masks.keys()]) {
      const [cx, cz] = key.split(',').map(Number);
      if (cx >= c0x && cx < c1x && cz >= c0z && cz < c1z) this.masks.delete(key);
    }
  }

  /**
   * Centimetres of grass at (x, z). Returns −1 for "not built yet", which is
   * NOT the same as 0: the caller leaves the ground alone rather than deciding
   * it is bare, and the chunk goes on the queue.
   */
  heightAt(x, z) {
    const key = chunkKey(x, z);
    const m = this.masks.get(key);
    if (!m) { this.request(key); return -1; }
    const cx = Math.floor(x / CHUNK) * CHUNK, cz = Math.floor(z / CHUNK) * CHUNK;
    let i = ((x - cx) / RES) | 0, j = ((z - cz) / RES) | 0;
    if (i < 0) i = 0; else if (i >= N) i = N - 1;
    if (j < 0) j = 0; else if (j >= N) j = N - 1;
    return m[j * N + i];
  }

  request(key) {
    if (this.masks.has(key) || this._queued.has(key)) return;
    this._queued.add(key);
    this.queue.push(key);
  }

  /** Rasterise queued chunks until the budget runs out. Returns how many. */
  step(budgetMs = 2) {
    const t0 = performance.now();
    let n = 0;
    while (this.queue.length && performance.now() - t0 < budgetMs) {
      const key = this.queue.shift();
      this._queued.delete(key);
      this._build(key);
      n++;
    }
    return n;
  }

  _build(key) {
    const cell = this.city.chunkIndex.get(key);
    const m = new Uint8Array(N * N);
    this.masks.set(key, m);
    if (!cell) return;                      // off the mapped world: no grass
    const [ci, cj] = key.split(',').map(Number);
    const x0 = ci * CHUNK, z0 = cj * CHUNK;

    // 1. Ground nobody mapped is a field — that is what the ground renders as,
    //    and a green floor with no blades in it is the thing this exists to fix.
    m.fill(UNMAPPED);

    // 2. Green polygons say how tall, and two of them say "none".
    for (const g of cell.green) {
      if (!g.o || g.o.length < 3) continue;
      const h = BARE_GREEN.has(g.t) ? 0 : MEADOW_TYPES.has(g.t) ? MEADOW : MOWN;
      fillPolygon(m, x0, z0, g.o, g.i, h);
    }

    // 3. …and everything built on top of it says none. These come LAST because
    //    no beats yes: OSM draws a park straight over the path through it, and
    //    a tuft standing in the tarmac is worse than a bare verge.
    for (const p of cell.paved) if (p.o?.length >= 3) fillPolygon(m, x0, z0, p.o, p.i, 0);
    for (const w of cell.water) if (w.o?.length >= 3) fillPolygon(m, x0, z0, w.o, w.i, 0);
    for (const b of cell.buildings) if (b.o?.length >= 3) fillPolygon(m, x0, z0, b.o, b.i, 0);
    for (const r of cell.roads) stampLine(m, x0, z0, r.p, (r.w ?? 3) / 2 + 0.6);
    for (const r of cell.rails) stampLine(m, x0, z0, r.p, 2.6);
    // …and the classifier's sealed ground says none too. The raster is 4 m
    // cells; asking at each mask metre keeps its edges where it drew them.
    if (this.ground) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          if (m[j * N + i] && this.ground.classAt(x0 + i + 0.5, z0 + j + 0.5) > 0) m[j * N + i] = 0;
        }
      }
    }
  }
}

// ---- rasterisers -----------------------------------------------------------
// Both write into the chunk's own N×N grid and clip to it, so a feature
// straddling two chunks stamps the part that belongs to each and nothing else.

/** Even-odd scanline fill of a ring with holes, at the row centres. */
function fillPolygon(m, x0, z0, outer, holes, value) {
  let jz0 = Infinity, jz1 = -Infinity;
  for (const [, z] of outer) { if (z < jz0) jz0 = z; if (z > jz1) jz1 = z; }
  let j0 = Math.max(0, Math.floor((jz0 - z0) / RES));
  let j1 = Math.min(N - 1, Math.ceil((jz1 - z0) / RES));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * RES;
    xs.length = 0;
    crossings(outer, zc, xs);
    for (const h of holes ?? []) if (h.length >= 3) crossings(h, zc, xs);
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.max(0, Math.ceil((xs[k] - x0) / RES - 0.5));
      let i1 = Math.min(N - 1, Math.floor((xs[k + 1] - x0) / RES - 0.5));
      for (let i = i0; i <= i1; i++) m[j * N + i] = value;
    }
  }
}

function crossings(ring, zc, out) {
  const n = ring.length;
  for (let k = 0; k < n; k++) {
    const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % n];
    if ((az <= zc) === (bz <= zc)) continue;
    out.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
  }
}

/** Stamp a corridor of half-width `hw` around a polyline. */
function stampLine(m, x0, z0, pts, hw) {
  if (!pts || pts.length < 2) return;
  const hw2 = hw * hw;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - x0) / RES));
    const i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + hw - x0) / RES));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - z0) / RES));
    const j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + hw - z0) / RES));
    if (i1 < i0 || j1 < j0) continue;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * RES;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * RES;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
        if (ex * ex + ez * ez <= hw2) m[j * N + i] = 0;
      }
    }
  }
}

export const _test = { N, RES, UNMAPPED, MOWN, MEADOW, fillPolygon, stampLine };
