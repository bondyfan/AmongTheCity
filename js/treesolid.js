// ---- treesolid.js: a tree trunk is in the way ----------------------------------
// A tree was a picture: a car drove through an avenue of limes as if it were
// fog, and so did a man on foot (Frank, 21 Nov 2026: "stromy musí být
// solid/rigid body a ne že skrz stromy můžu projíždět"). This module is where
// the trunks are, as circles on the ground, for whoever asks.
//
// WHERE THE TRUNKS COME FROM. Not from the tiles and not from the mesher: from
// the chunk's own tree batch, the one InstancedMesh a chunk draws its trees
// with (js/meshes.js "trees: ONE InstancedMesh"). Its matrix IS the crown and
// the species rides in the low bits of its colour (js/treeshapes.js), which is
// everything a trunk needs: the foot is the crown's centre taken down its own
// axis, and the girth is the species' share of the crown radius. So
//   * nothing new crosses the worker boundary (a chunk meshed in the worker and
//     one meshed here hand over the same matrices),
//   * every client grows the same trunks in the same places (the matrices are a
//     pure function of the tree's id and place), and
//   * a tree that is not drawn is not there: no collider without its picture.
//
// COST. A wood is thousands of trees to a chunk and most chunks are never
// driven through, so a chunk's batch is only REMEMBERED when it is built and
// decoded the first time something asks near it: one pass, into a flat array
// sorted by an 8 m grid. A query after that reads one or two grid cells.
//
// Pure: no three, no DOM. The batch is handed in as plain arrays.

import { SPECIES, SP, groundOf, tagSpecies } from './treeshapes.js';
import { inBand } from './levelsep.js';

const CELL = 8;                 // m: the grid inside a chunk
/** m: the slimmest and the stoutest trunk anything can run into. */
export const TRUNK_MIN = 0.13, TRUNK_MAX = 0.7;
// The root flare and the bark: what a bumper meets is a little wider than the
// stem the species table describes at breast height.
const FLARE = 1.15;
const PAD = 1;                  // m past a chunk's edge a query still asks that chunk
const STRIDE = 5;               // x, z, radius, foot height, how tall the stem stands

/**
 * How much a worker-built batch scaled its template down (js/trees.js
 * _treesOf has the long version): the template's real extent over the one it
 * has now. `pos` is the template geometry's position attribute.
 */
export function crownFold(pos, extent = 1) {
  let ext = 0;
  for (let i = 0; i < pos.count; i++) ext = Math.max(ext, Math.abs(pos.getX(i)), Math.abs(pos.getY(i)), Math.abs(pos.getZ(i)));
  return ext > 0 ? extent / ext : 1;
}

/** The radius a trunk is solid to, from its species and its crown's radius. */
export function trunkRadius(sp, rx) {
  const tau = SPECIES[sp]?.tau ?? 0;
  if (!(tau > 0)) return 0;                              // a shrub: nothing to hit
  return Math.max(TRUNK_MIN, Math.min(TRUNK_MAX, tau * rx * FLARE));
}

/**
 * Decode one batch into trunks: [x, z, r, y0, tall] each, world space.
 *   a      instance matrices, 16 floats each (chunk-local)
 *   col    instance colours, 3 each: bytes, or floats 0..1
 *   n      how many instances
 *   fold   crownFold() of the batch's template
 *   gx, gy, gz   where the chunk's group stands
 */
export function decodeTrunks(a, col, n, fold, gx, gy, gz) {
  const out = new Float32Array(n * STRIDE);
  const k = 1 / (fold || 1), f = col instanceof Float32Array ? 255 : 1;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    const sp = tagSpecies(Math.round(col[i * 3] * f), Math.round(col[i * 3 + 2] * f));
    if (sp === SP.SHRUB || !SPECIES[sp]) continue;
    const rx = Math.hypot(a[o], a[o + 1], a[o + 2]) * k;
    const r = trunkRadius(sp, rx);
    if (!(r > 0) || !(rx > 0)) continue;                 // a hidden (zeroed) instance
    // the foot: the crown's centre taken groundOf() crown radii down its own axis
    const g = groundOf(sp) * k;
    const ux = a[o + 4] * g, uy = a[o + 5] * g, uz = a[o + 6] * g;
    const w = m * STRIDE;
    out[w] = gx + a[o + 12] - ux;
    out[w + 1] = gz + a[o + 14] - uz;
    out[w + 2] = r;
    out[w + 3] = gy + a[o + 13] - uy;
    out[w + 4] = Math.max(1.5, uy);                      // the stem runs to the crown's centre
    m++;
  }
  return m === n ? out : out.subarray(0, m * STRIDE);
}

// Sort decoded trunks into an 8 m grid over their own bounds (a counting sort:
// `start[c]..start[c + 1]` are the trunks of cell c in `data`).
function gridOf(tr) {
  const n = tr.length / STRIDE;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = tr[i * STRIDE], z = tr[i * STRIDE + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!n) return { n: 0, x0: 0, z0: 0, nx: 0, nz: 0, start: null, data: tr };
  const nx = Math.floor((x1 - x0) / CELL) + 1, nz = Math.floor((z1 - z0) / CELL) + 1;
  const start = new Uint32Array(nx * nz + 1), at = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.floor((tr[i * STRIDE] - x0) / CELL) + Math.floor((tr[i * STRIDE + 1] - z0) / CELL) * nx;
    at[i] = c; start[c + 1]++;
  }
  for (let c = 0; c < nx * nz; c++) start[c + 1] += start[c];
  const fill = start.slice(0, nx * nz), data = new Float32Array(n * STRIDE);
  for (let i = 0; i < n; i++) {
    const w = fill[at[i]]++ * STRIDE;
    for (let j = 0; j < STRIDE; j++) data[w + j] = tr[i * STRIDE + j];
  }
  return { n, x0, z0, nx, nz, start, data };
}

export class TreeSolids {
  /** chunk: the side of a chunk in metres (js/config.js CHUNK). */
  constructor(chunk = 120) {
    this.chunk = chunk;
    this.recs = new Map();      // chunk key "i,j" → { src } until asked, then { grid }
  }

  /**
   * A chunk has built its trees (or rebuilt them: the key replaces what it
   * held). `src`: { a, col, n, fold, gx, gy, gz }, see decodeTrunks. The arrays
   * are kept, not copied, until the first question near the chunk.
   */
  register(key, src) {
    if (!src || !(src.n > 0)) { this.recs.delete(key); return; }
    this.recs.set(key, { src, grid: null });
  }

  /** The chunk went away, and its trees with it. */
  unregister(key) { this.recs.delete(key); }

  clear() { this.recs.clear(); }

  _grid(key) {
    const rec = this.recs.get(key);
    if (!rec) return null;
    if (!rec.grid) {
      const s = rec.src;
      rec.grid = gridOf(decodeTrunks(s.a, s.col, s.n, s.fold, s.gx, s.gy, s.gz));
      rec.src = null;           // the batch's arrays are the chunk's again
    }
    return rec.grid.n ? rec.grid : null;
  }

  /**
   * Every trunk within `reach` of (x, z) whose stem stands at height `y` (a
   * tree in the street under a bridge is not in the way of the deck: asked
   * without a height, every trunk is). Appends [x, z, r] to `out` from index 0
   * and returns how many.
   */
  near(x, z, reach, y, out) {
    let m = 0;
    const C = this.chunk, R = reach + TRUNK_MAX;
    const i0 = Math.floor((x - R - PAD) / C), i1 = Math.floor((x + R + PAD) / C);
    const j0 = Math.floor((z - R - PAD) / C), j1 = Math.floor((z + R + PAD) / C);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const g = this._grid(i + ',' + j);
      if (!g) continue;
      const a0 = Math.max(0, Math.floor((x - R - g.x0) / CELL)), a1 = Math.min(g.nx - 1, Math.floor((x + R - g.x0) / CELL));
      const b0 = Math.max(0, Math.floor((z - R - g.z0) / CELL)), b1 = Math.min(g.nz - 1, Math.floor((z + R - g.z0) / CELL));
      for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) {
        const c = a + b * g.nx, d = g.data;
        for (let t = g.start[c]; t < g.start[c + 1]; t++) {
          const w = t * STRIDE, dx = d[w] - x, dz = d[w + 1] - z, rr = reach + d[w + 2];
          if (dx * dx + dz * dz > rr * rr) continue;
          if (y !== undefined && !inBand(y, d[w + 3], d[w + 4])) continue;
          out[m * 3] = d[w]; out[m * 3 + 1] = d[w + 1]; out[m * 3 + 2] = d[w + 2];
          m++;
        }
      }
    }
    return m;
  }

  /**
   * Push a circle ({ x, z }, mutated) out of every trunk it stands in.
   * Returns true if it moved, like world.collide().
   */
  collide(pos, radius, y) {
    const n = this.near(pos.x, pos.z, radius, y, _hit);
    let pushed = false;
    for (let i = 0; i < n; i++) {
      const tx = _hit[i * 3], tz = _hit[i * 3 + 1], rr = _hit[i * 3 + 2] + radius;
      const dx = pos.x - tx, dz = pos.z - tz, d2 = dx * dx + dz * dz;
      // (a hair of tolerance: a circle put exactly on the bark is clear of it)
      if (d2 >= (rr - 1e-4) * (rr - 1e-4)) continue;
      if (d2 < 1e-9) { pos.x = tx + rr; pushed = true; continue; }
      const d = Math.sqrt(d2);
      pos.x = tx + (dx / d) * rr; pos.z = tz + (dz / d) * rr;
      pushed = true;
    }
    return pushed;
  }
}

const _hit = [];
