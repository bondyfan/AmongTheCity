// ---- maptiles: the HUD map, rasterised a chunk at a time, at screen resolution ----
// The old minimap painted a 4.9 km window into ONE 2048 px bitmap (0.42 px per
// metre) and then blew it up five times on a Retina disc: the blur Frank saw.
// Painting a window that big at the disc's real resolution would be a 12 000 px
// bitmap and a long hitch every time it slid. So the map is cut the way the
// world already is, into its 120 m chunk cells, and each cell is painted on
// its own small canvas at exactly the pixels per metre the disc shows
// (js/mapstyle.js tilePpm). Per frame the minimap only blits the dozen cells
// under the disc; painting happens a cell at a time inside a millisecond
// budget, nearest first, while you drive.
//
// A cell's canvas covers a whole number of pixels (bleedPx, about BLEED m)
// past each edge, so a tile can be copied 1:1 onto whole-pixel positions of
// js/mapwindow.js's canvas without any resampling (that is what keeps the map
// crisp), and neighbours overlap with identical pixels (every tile gathers its
// 3×3 neighbourhood), so no seam shows at a cell edge.
//
// When new data lands in some cells (city.onTileLoaded hands their keys) only
// tiles touching those cells go stale. A stale tile keeps being drawn until
// its fresh copy is ready, so the disc never flashes empty.

import { CHUNK } from './config.js';
import { MAP, greenFill, roadStyle, roadWidthM, AERO_CLASS } from './mapstyle.js';

export const TILE_M = CHUNK;
export const BLEED = 2;          // m painted past each tile edge, at least
/** The bleed in whole device pixels at `ppm`. */
export const bleedPx = (ppm) => Math.ceil(BLEED * ppm);
/** A tile canvas's side in pixels at `ppm` (TILE_M·ppm is whole for ppm in quarters). */
export const tilePx = (ppm) => Math.round(TILE_M * ppm) + 2 * bleedPx(ppm);
const LINE_PAD = 22;             // m a line's bbox may sit outside and still reach in
const WIDTH_K = 0.6;             // roads under real width: a diagram, not an aerial,
                                 // with room left for the blocks between them

const NEIGH = [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
let _stamp = 0;
// Tile keys are numbers, not 'tx,tz' strings: the disc asks for ~50 tiles a
// frame and a string key per ask is garbage per frame. ±32 768 cells of 120 m
// is ±3 900 km, which covers every region with room to spare.
const KEY_OFF = 32768;
export const tileKey = (tx, tz) => (tx + KEY_OFF) * 65536 + (tz + KEY_OFF);

function bboxOf(f, pts) {
  let bb = f._mmbb;              // shared with js/worldmap.js: same layout
  if (!bb) {
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i][0], z = pts[i][1];
      if (x < a) a = x; if (x > c) c = x; if (z < b) b = z; if (z > d) d = z;
    }
    bb = f._mmbb = [a, b, c, d];
  }
  return bb;
}

/**
 * Everything one tile needs, each feature once, in id order (so two renders
 * of the same data paint identically). Exported for the tests.
 */
export function gatherTile(city, tx, tz) {
  const out = { paved: [], green: [], water: [], buildings: [], rails: [], roads: [], waterways: [] };
  const idx = city.chunkIndex;
  const pad = BLEED * 2;           // covers bleedPx's rounding at any ppm
  const x1 = tx * TILE_M - pad, z1 = tz * TILE_M - pad;
  const x2 = x1 + TILE_M + 2 * pad, z2 = z1 + TILE_M + 2 * pad;
  const st = ++_stamp;
  const take = (list, kind, pad, ptsKey) => {
    const o = out[kind];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      if (f._mtS === st) continue;
      const pts = f[ptsKey];
      if (!pts || pts.length < 2) continue;
      const bb = bboxOf(f, pts);
      if (bb[2] < x1 - pad || bb[0] > x2 + pad || bb[3] < z1 - pad || bb[1] > z2 + pad) continue;
      f._mtS = st;
      o.push(f);
    }
  };
  if (idx && idx.size) {
    for (const [dx, dz] of NEIGH) {
      const cell = idx.get((tx + dx) + ',' + (tz + dz));
      if (!cell) continue;
      take(cell.paved, 'paved', 0, 'o');
      take(cell.green, 'green', 0, 'o');
      take(cell.water, 'water', 0, 'o');
      take(cell.buildings, 'buildings', 0, 'o');
      take(cell.rails, 'rails', LINE_PAD, 'p');
      take(cell.roads, 'roads', LINE_PAD, 'p');
    }
  } else {
    // bare fixtures: the flat arrays
    take(city.paved ?? [], 'paved', 0, 'o');
    take(city.green ?? [], 'green', 0, 'o');
    take(city.water ?? [], 'water', 0, 'o');
    take(city.buildings ?? [], 'buildings', 0, 'o');
    take(city.rails ?? [], 'rails', LINE_PAD, 'p');
    take(city.roads ?? [], 'roads', LINE_PAD, 'p');
  }
  // waterways are not in the chunk index; few enough to test by bbox
  take(city.waterways ?? [], 'waterways', LINE_PAD, 'p');
  for (const k in out) out[k].sort((a, b) => (a._id ?? 0) - (b._id ?? 0));
  return out;
}

/** Paint one tile into a 2D context tilePx(ppm) pixels square. */
export function paintTile(g, city, tx, tz, ppm) {
  const L = gatherTile(city, tx, tz);
  const b = bleedPx(ppm) / ppm;
  const ox = tx * TILE_M - b, oz = tz * TILE_M - b;
  const span = TILE_M + 2 * b;
  g.setTransform(ppm, 0, 0, ppm, 0, 0);
  g.fillStyle = MAP.land;
  g.fillRect(0, 0, span, span);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  const px = 1 / ppm;            // one device pixel, in metres
  const ring = (r) => {
    for (let i = 0; i < r.length; i++) {
      const x = r[i][0] - ox, z = r[i][1] - oz;
      i ? g.lineTo(x, z) : g.moveTo(x, z);
    }
    g.closePath();
  };
  const line = (p) => {
    for (let i = 0; i < p.length; i++) {
      const x = p[i][0] - ox, z = p[i][1] - oz;
      i ? g.lineTo(x, z) : g.moveTo(x, z);
    }
  };
  const poly = (f, color) => {   // holes by even-odd: outer + inner rings
    g.beginPath();
    ring(f.o);
    if (f.i) for (const h of f.i) ring(h);
    g.fillStyle = color;
    g.fill('evenodd');
  };
  // ground cover: hard standing, then green, then water over both
  g.beginPath();
  for (const f of L.paved) if (f.t !== 'apron' && f.t !== 'runway') ring(f.o);
  g.fillStyle = MAP.paved;
  g.fill();
  for (const f of L.paved) if (f.t === 'apron' || f.t === 'runway') poly(f, MAP.apron);
  for (const f of L.green) poly(f, greenFill(f.t));
  for (const f of L.water) poly(f, MAP.water);
  g.strokeStyle = MAP.water;
  for (const f of L.waterways) {
    g.beginPath();
    line(f.p);
    g.lineWidth = Math.max((f.w ?? 4), 1.4 * px);
    g.stroke();
  }
  // buildings: one path, one fill, one hairline edge (outer rings only: a
  // courtyard is a few pixels and reads fine filled)
  if (L.buildings.length) {
    g.beginPath();
    for (const f of L.buildings) ring(f.o);
    g.fillStyle = MAP.building;
    g.fill();
    if (ppm >= 1.4) {
      g.strokeStyle = MAP.buildingEdge;
      g.lineWidth = px;
      g.stroke();
    }
  }
  // rails: a thin grey thread
  if (L.rails.length) {
    g.beginPath();
    for (const f of L.rails) if (f.t !== 'tram') line(f.p);
    g.strokeStyle = MAP.rail;
    g.lineWidth = Math.max(1.2, 1.1 * px);
    g.stroke();
  }
  // footways, paths, tracks: one faint stroke; runways at their real width
  g.beginPath();
  let anyPath = false;
  for (const f of L.roads) {
    if (f.d || AERO_CLASS.test(f.t)) continue;
    line(f.p); anyPath = true;
  }
  if (anyPath) {
    g.strokeStyle = MAP.path;
    g.lineWidth = Math.max(1.6, 1.2 * px);
    g.stroke();
  }
  for (const f of L.roads) {
    if (f.d || !AERO_CLASS.test(f.t)) continue;
    g.beginPath();
    line(f.p);
    g.strokeStyle = MAP.aero;
    g.lineWidth = Math.max(f.w ?? 20, 2 * px);
    g.stroke();
  }
  // the drivable network: every casing first, then the fills by rank, so main
  // roads run through junctions with side streets instead of under them. Ways
  // sharing a class and a width share ONE path (a Prague cell holds hundreds
  // of ways and a couple of dozen distinct strokes). Bridges go last, over
  // whatever they cross, with their own darker edge.
  for (let pass = 0; pass < 2; pass++) {
    const groups = new Map();
    for (const f of L.roads) {
      if (!f.d || !!f.br !== !!pass) continue;
      const st = roadStyle(f.t);
      const w = Math.max(roadWidthM(f) * WIDTH_K, st.min * px);
      const key = st.rank * 1000 + Math.round(w * 4);
      let gr = groups.get(key);
      if (!gr) groups.set(key, gr = { rank: st.rank, w, fill: st.fill, list: [] });
      gr.list.push(f);
    }
    if (!groups.size) continue;
    const order = [...groups.values()].sort((a, b) => a.rank - b.rank || a.w - b.w);
    const edge = Math.max(0.5, 1.1 * px);
    g.strokeStyle = pass ? MAP.bridgeCasing : MAP.casing;
    for (const gr of order) {
      g.beginPath();
      for (const f of gr.list) line(f.p);
      g.lineWidth = gr.w + 2 * edge;
      g.stroke();
    }
    for (const gr of order) {
      g.beginPath();
      for (const f of gr.list) line(f.p);
      g.strokeStyle = gr.fill;
      g.lineWidth = gr.w;
      g.stroke();
    }
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
}

/**
 * A cache of painted tiles. The frame protocol is
 *   tiles.want(tx, tz, priority)   for every tile the disc needs this frame
 *   tiles.pump(budgetMs)           paint the most urgent ones within budget
 *   tiles.get(tx, tz)              → { cv, fresh } | undefined, to blit
 * want() is cheap and idempotent within a frame; pump() clears the wants.
 */
export class MapTiles {
  constructor(city, opts = {}) {
    this.city = city;
    this.ppm = opts.ppm ?? 2;
    this.max = opts.max ?? 64;
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this._make = opts.makeCanvas ?? ((n) => {
      const c = document.createElement('canvas');
      c.width = c.height = n;
      return c;
    });
    this.tiles = new Map();      // tileKey → { tx, tz, cv, gen, used }
    this.gen = 1;
    this._pool = [];             // canvases of evicted tiles, reused at the same size
    this._wk = []; this._wx = []; this._wz = []; this._wp = [];
    this._wn = 0; this._frame = 0;
    this.stats = { painted: 0, lastMs: 0, maxMs: 0 };
  }

  get px() { return tilePx(this.ppm); }

  setPpm(ppm) {
    if (ppm === this.ppm) return;
    this.ppm = ppm;
    // every canvas is now the wrong size: drop them all (and the pool)
    this.tiles.clear();
    this._pool.length = 0;
  }

  /** Data changed in these chunk cells: tiles touching them go stale. */
  invalidateCells(cells) {
    if (!cells) { this.gen++; return; }
    const set = cells instanceof Set ? cells : new Set(cells);
    for (const t of this.tiles.values()) {
      for (const [dx, dz] of NEIGH) {
        if (set.has((t.tx + dx) + ',' + (t.tz + dz))) { t.gen = 0; break; }
      }
    }
  }

  get(tx, tz) {
    const t = this.tiles.get(tileKey(tx, tz));
    if (t) t.used = this._frame;
    return t;
  }

  want(tx, tz, pri) {
    const i = this._wn++;
    this._wk[i] = tileKey(tx, tz); this._wx[i] = tx; this._wz[i] = tz; this._wp[i] = pri;
  }

  /**
   * Paint wanted tiles, missing ones before stale ones, lowest priority value
   * first, until `budgetMs` is spent (the first paint always happens: a budget
   * smaller than one tile must not starve the disc). Returns tiles painted.
   */
  pump(budgetMs) {
    this._frame++;
    const n = this._wn;
    this._wn = 0;
    if (!n) return 0;
    const t0 = this.now();
    let painted = 0;
    for (;;) {
      let best = -1, bestP = Infinity;
      for (let i = 0; i < n; i++) {
        const k = this._wk[i];
        if (k < 0) continue;
        const t = this.tiles.get(k);
        if (t && t.gen === this.gen) { this._wk[i] = -1; continue; }     // fresh
        const p = this._wp[i] + (t ? 1e6 : 0);        // missing beats stale
        if (p < bestP) { bestP = p; best = i; }
      }
      if (best < 0) break;
      if (painted > 0 && this.now() - t0 >= budgetMs) break;
      this._paint(this._wk[best], this._wx[best], this._wz[best]);
      this._wk[best] = -1;
      painted++;
    }
    for (let i = 0; i < n; i++) {                       // keep what was wanted warm
      const t = this._wk[i] < 0 ? null : this.tiles.get(this._wk[i]);
      if (t) t.used = this._frame;
    }
    if (painted) {
      const ms = this.now() - t0;
      this.stats.painted += painted;
      this.stats.lastMs = ms;
      if (ms > this.stats.maxMs) this.stats.maxMs = ms;
    }
    this._evict();
    return painted;
  }

  _paint(key, tx, tz) {
    let t = this.tiles.get(key);
    const size = this.px;
    if (!t) {
      const cv = this._pool.pop() ?? this._make(size);
      if (cv.width !== size) { cv.width = size; cv.height = size; }
      t = { tx, tz, cv, gen: 0, used: this._frame };
      this.tiles.set(key, t);
    }
    paintTile(t.cv.getContext('2d'), this.city, tx, tz, this.ppm);
    t.ver = (t.ver ?? 0) + 1;     // js/mapwindow.js copies a tile again when this moves
    t.gen = this.gen;
    t.used = this._frame;
  }

  _evict() {
    if (this.tiles.size <= this.max) return;
    const arr = [...this.tiles.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < arr.length && this.tiles.size > this.max; i++) {
      const [k, t] = arr[i];
      if (t.used === this._frame) break;                // wanted right now: keep
      this.tiles.delete(k);
      if (this._pool.length < 8) this._pool.push(t.cv);
    }
  }
}
