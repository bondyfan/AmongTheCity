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

import { CHUNK, LAYER_Y } from './config.js';
import { chunkKey, roadGradeY, polylineLength, streetOf } from './geo.js';
import { sealedGrid, SEAL_RES, isHardWay } from './sealed.js';

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
  /** @param city the indexed city; @param ground the sealed-ground raster;
   *  @param terrain lets the mask see the corridor benching (shear zones) */
  constructor(city, ground = null, terrain = null) {
    this.city = city;
    this.ground = ground;
    this.terrain = terrain;
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
    // (a kerbed street's pavement reaches a couple of metres past its
    // carriageway, js/streets.js: no tufts through the paving)
    for (const r of cell.roads) stampLine(m, x0, z0, r.p, (r.w ?? 3) / 2 + (r.d && streetOf(r) ? 2.6 : 0.6));
    for (const r of cell.rails) stampLine(m, x0, z0, r.p, 2.6);
    // THE SHEAR ZONE. The chunk ground inside a road's corridor is benched to
    // the deck — flat over w/2 + 4.5 m, rising back at 55 % over a 5 m flare
    // (meshes.js clampUnderRoadsGen). A blade's height comes from the raw
    // height field, so on a road cut into a hillside every blade on the uphill
    // side of the bench stands on ground that is not there any more — "tráva
    // je nad realným terénem", floating up to the whole depth of the cut. The
    // blades that would float are cleared here, with the bench's own formula;
    // where the bench never bites (flat ground, embankments) nothing changes
    // and the verges keep their grass.
    if (this.terrain) {
      for (const r of cell.roads) {
        if (!r.br && r.p?.length > 1) shearLine(m, x0, z0, r, (r.w ?? 3) / 2 + 4.5, this.terrain);
      }
      for (const r of cell.rails) {
        if (!r.br && r.p?.length > 1) shearLine(m, x0, z0, r, 2.2 + 4.5, this.terrain);
      }
    }
    // …and so does ground the map never drew but plainly paved anyway: the
    // inside of a town square, which OSM plots as a web of footways on sett and
    // concrete and no area at all. Only UNMAPPED cells may be overruled here —
    // where OSM drew a lawn the lawn wins, because this is for the silence
    // between features and not an argument with the map.
    const sealed = sealedGrid(cell, ci, cj, this.terrain);
    if (sealed) {
      const step = SEAL_RES / RES;                    // mask cells per sealed cell
      for (let j = 0; j < N; j++) {
        const sj = (j / step) | 0;
        for (let i = 0; i < N; i++) {
          const k = j * N + i;
          if (m[k] !== UNMAPPED) continue;
          if (sealed[sj * (N / step) + ((i / step) | 0)]) m[k] = 0;
        }
      }
    }
    // …and a Prague square is wider than any closing. The Old Town Square is
    // a hundred metres of sett with a handful of named pedestrian ways across
    // it and no area at all, so the closing above left it a field with tufts
    // all over it. In Prague a hard pedestrian way NAMED as a square (náměstí)
    // paves the unmapped ground for SQUARE_REACH round it; a mapped lawn still wins.
    if (x0 < PRAHA_X1 && x0 > PRAHA_X0) {
      for (const r of cell.roads) {
        if (r.t === 'pedestrian' && isHardWay(r) && r.n && SQUARE_NAME.test(r.n)) stampLine(m, x0, z0, r.p, SQUARE_REACH, UNMAPPED);
      }
    }
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

/**
 * Clear cells whose raw ground stands above the corridor bench — the cap is
 * clampUnderRoadsGen's own: gy + lay − 0.05, rising at 55 % past the flat band.
 * Only cells still carrying grass pay for a terrain read, and only those whose
 * raw height clears the cap pay for the road profile.
 */
const SHEAR_FLARE = 5, SHEAR_OVER = 0.3;
function shearLine(m, x0, z0, r, hw, terrain) {
  const pts = r.p;
  r._len ??= polylineLength(pts);
  const reach = hw + SHEAR_FLARE, reach2 = reach * reach;
  let along = 0;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / RES));
    const i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / RES));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / RES));
    const j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + reach - z0) / RES));
    const dx = bx - ax, dz = bz - az;
    const L = Math.hypot(dx, dz), len2 = dx * dx + dz * dz || 1e-9;
    if (i1 >= i0 && j1 >= j0) {
      for (let j = j0; j <= j1; j++) {
        const pz = z0 + (j + 0.5) * RES;
        for (let i = i0; i <= i1; i++) {
          if (!m[j * N + i]) continue;
          const px = x0 + (i + 0.5) * RES;
          let t = ((px - ax) * dx + (pz - az) * dz) / len2;
          if (t < 0) t = 0; else if (t > 1) t = 1;
          const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
          const d2 = ex * ex + ez * ez;
          if (d2 > reach2) continue;
          const d = Math.sqrt(d2);
          const gy = roadGradeY(r, along + L * t, terrain);
          if (!Number.isFinite(gy)) continue;
          const cap = gy + LAYER_Y.road - 0.05 + (d > hw ? (d - hw) * 0.55 : 0);
          if (terrain.heightAt(px, pz) > cap + SHEAR_OVER) m[j * N + i] = 0;
        }
      }
    }
    along += L;
  }
}

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
// Prague's old town, by x: the only place the square rule above runs
const PRAHA_X0 = -110000, PRAHA_X1 = -85000;
const SQUARE_NAME = /náměstí/i, SQUARE_REACH = 45;

/** Clear the cells within hw of a polyline (only those holding `only`, when given). */
function stampLine(m, x0, z0, pts, hw, only = -1) {
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
        if (ex * ex + ez * ez <= hw2 && (only < 0 || m[j * N + i] === only)) m[j * N + i] = 0;
      }
    }
  }
}

export const _test = { N, RES, UNMAPPED, MOWN, MEADOW, fillPolygon, stampLine };
