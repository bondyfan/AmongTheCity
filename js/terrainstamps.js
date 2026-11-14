// ---- terrainstamps.js: earthworks that are not roads ----
// WORKER SAFE (js/terrain.js reads it, and the terrain is in the mesher's
// import graph). Plain data and arithmetic, no allocation per query.
//
// The earthworks pass (city.conformTerrainTile) shapes the ground for roads
// and railways, and only for them: a moat, a rampart, a pond's bank, a quarry
// floor was whatever DMR 5G held at 20 m a sample, which for anything with an
// edge is a soft hump. The chateau's moat was not there at all: the survey
// blurs a ditch beside an eleven metre rampart into one slope, and the wall
// stood half way up it.
//
// A STAMP is a polyline (or a closed ring) with a profile ACROSS it: at each
// signed distance d from the line (d > 0 on the right of its direction, which
// for a ring is OUTSIDE whichever way it winds) a target height and a weight.
// The target is a base height along the line (one per vertex, interpolated)
// plus the profile's offset; the weight blends the ground toward it, by one of
// three rules: 'dig' only ever lowers, 'raise' only ever lifts, 'set' does
// both. A profile may jump (two entries at the same d): that is a hard edge,
// the face of a wall. Holes (polylines with a half width and a falloff) keep
// the ground as it is along a road that crosses the stamp, so a causeway stays
// a causeway.
//
// Stamps are applied INSIDE Terrain.heightAt, on top of the grid the road
// earthworks wrote, at full resolution rather than at the grid's 20 m: so the
// drawn ground (4 m quads), trees, grass, walkers, buildings and the levelled
// paths that run along the moat floor all read one surface, and the worker,
// which builds its own Terrain from the same grids, reads the same one. The
// rules are idempotent where they are flat (a road levelled onto a stamped
// floor and stamped again is still the floor), which is what lets the road
// pass and the stamps share a surface without knowing about each other.

import { VALY, VALY_FLOOR } from './valyring.js';

const CELL = 8;              // m, the bucket grid that finds a stamp's nearby segments

/**
 * Make a stamp from its description.
 * @param def { pts: [[x,z]...], closed?: bool, base: number | number[] (per vertex),
 *              prof: [[d, dy, w]...] sorted by d, mode: 'dig'|'raise'|'set',
 *              holes?: [{ pts, hw, fall }] }
 */
export function makeStamp(def) {
  const pts = def.pts, n = pts.length, closed = !!def.closed;
  const segN = closed ? n : n - 1;
  let area = 0;
  if (closed) for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
  }
  // d > 0 is the right of travel; for a ring, flipped so it is the OUTSIDE
  const side = closed && area > 0 ? -1 : 1;
  const sx = new Float64Array(segN), sz = new Float64Array(segN);
  const ex = new Float64Array(segN), ez = new Float64Array(segN);
  const len = new Float64Array(segN), nx = new Float64Array(segN), nz = new Float64Array(segN);
  const y0 = new Float64Array(segN), y1 = new Float64Array(segN);
  const base = (i) => (Array.isArray(def.base) ? def.base[i % n] : def.base);
  for (let i = 0; i < segN; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    sx[i] = a[0]; sz[i] = a[1]; ex[i] = b[0] - a[0]; ez[i] = b[1] - a[1];
    len[i] = Math.hypot(ex[i], ez[i]) || 1e-9;
    // right-hand normal of travel (x east, z south): (-ez, ex)
    nx[i] = side * -ez[i] / len[i]; nz[i] = side * ex[i] / len[i];
    y0[i] = base(i); y1[i] = base(i + 1);
  }
  const prof = def.prof;
  const reach = Math.max(Math.abs(prof[0][0]), Math.abs(prof[prof.length - 1][0]));
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  x0 -= reach; z0 -= reach; x1 += reach; z1 += reach;
  const st = { mode: def.mode, prof, reach, x0, z0, x1, z1, segN, sx, sz, ex, ez, len, nx, nz, y0, y1,
    closed, holes: (def.holes ?? []).map(prepHole), grid: null, gw: 0, gh: 0 };
  // ---- the bucket grid: per CELL square, the segments within reach of it ----
  st.gw = Math.ceil((x1 - x0) / CELL); st.gh = Math.ceil((z1 - z0) / CELL);
  const lists = new Array(st.gw * st.gh);
  const pad = reach + CELL * 0.7072;
  for (let j = 0; j < st.gh; j++) for (let i = 0; i < st.gw; i++) {
    const cx = x0 + (i + 0.5) * CELL, cz = z0 + (j + 0.5) * CELL;
    let l = null;
    for (let k = 0; k < segN; k++) if (segDist(st, k, cx, cz) <= pad) (l ??= []).push(k);
    lists[j * st.gw + i] = l ? Int32Array.from(l) : null;
  }
  st.grid = lists;
  return st;
}

function prepHole(h) {
  const n = h.pts.length - 1;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of h.pts) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  const r = h.hw + h.fall;
  return { pts: h.pts, n, hw: h.hw, fall: h.fall, x0: x0 - r, z0: z0 - r, x1: x1 + r, z1: z1 + r };
}

function segDist(st, k, x, z) {
  let t = ((x - st.sx[k]) * st.ex[k] + (z - st.sz[k]) * st.ez[k]) / (st.len[k] * st.len[k]);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - st.sx[k] - st.ex[k] * t, z - st.sz[k] - st.ez[k] * t);
}

const smooth = (t) => t * t * (3 - 2 * t);

/** How much of a stamp a hole lets through at (x, z): 1 nowhere near, 0 on it. */
function holeKeep(holes, x, z) {
  let keep = 1;
  for (const h of holes) {
    if (x < h.x0 || x > h.x1 || z < h.z0 || z > h.z1) continue;
    let d = Infinity;
    for (let i = 0; i < h.n; i++) {
      const [ax, az] = h.pts[i], [bx, bz] = h.pts[i + 1];
      const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz || 1e-9;
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const e = Math.hypot(x - ax - dx * t, z - az - dz * t);
      if (e < d) d = e;
    }
    const k = d <= h.hw ? 0 : d >= h.hw + h.fall ? 1 : smooth((d - h.hw) / h.fall);
    if (k < keep) keep = k;
  }
  return keep;
}

/** One stamp applied to the height h at (x, z). */
export function applyStamp(st, x, z, h) {
  if (x < st.x0 || x > st.x1 || z < st.z0 || z > st.z1) return h;
  const gi = Math.floor((x - st.x0) / CELL), gj = Math.floor((z - st.z0) / CELL);
  const list = st.grid[gj * st.gw + gi];
  if (!list) return h;
  // the nearest segment, and on it the nearest point
  let best = Infinity, bk = -1, bt = 0;
  for (let q = 0; q < list.length; q++) {
    const k = list[q];
    let t = ((x - st.sx[k]) * st.ex[k] + (z - st.sz[k]) * st.ez[k]) / (st.len[k] * st.len[k]);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - st.sx[k] - st.ex[k] * t, z - st.sz[k] - st.ez[k] * t);
    if (d < best) { best = d; bk = k; bt = t; }
  }
  if (bk < 0 || best > st.reach) return h;
  // which side: the segment's own normal, or at a vertex the mean of the two
  // segments meeting there (the pseudo-normal, so a bastion's corner is
  // inside on both of its faces)
  const px = st.sx[bk] + st.ex[bk] * bt, pz = st.sz[bk] + st.ez[bk] * bt;
  let mx = st.nx[bk], mz = st.nz[bk];
  if (bt <= 0 && (st.closed || bk > 0)) { const o = (bk - 1 + st.segN) % st.segN; mx += st.nx[o]; mz += st.nz[o]; }
  else if (bt >= 1 && (st.closed || bk < st.segN - 1)) { const o = (bk + 1) % st.segN; mx += st.nx[o]; mz += st.nz[o]; }
  const sd = (x - px) * mx + (z - pz) * mz >= 0 ? best : -best;
  // the profile at sd
  const P = st.prof;
  if (sd < P[0][0] || sd > P[P.length - 1][0]) return h;
  let i = 0;
  while (i < P.length - 2 && sd > P[i + 1][0]) i++;
  const a = P[i], b = P[i + 1], span = b[0] - a[0];
  const f = span > 1e-9 ? (sd - a[0]) / span : 1;
  let w = a[2] + (b[2] - a[2]) * smooth(f);
  if (w <= 0) return h;
  if (st.holes.length) { w *= holeKeep(st.holes, x, z); if (w <= 0) return h; }
  const dy = a[1] + (b[1] - a[1]) * f;
  const target = st.y0[bk] + (st.y1[bk] - st.y0[bk]) * bt + dy;
  const v = h + (target - h) * w;
  return st.mode === 'dig' ? (v < h ? v : h) : st.mode === 'raise' ? (v > h ? v : h) : v;
}

// ---- the stamps of the world ---------------------------------------------------
// THE CHATEAU OF PARDUBICE. A square of earth ramparts with a gun bastion on
// each corner, a loopholed wall along their foot (js/landmarks-valy.js), and
// outside it the dry moat, grassed, its floor at the level of the park and
// the tennis courts that are what is left of it (VALY_FLOOR). Three stamps on
// the one ring, applied in this order:
//   · the MOAT: dug to its floor from the wall's face out to 10 m, coming back
//     up to the survey over the next 12; a hard edge at the wall, which stands
//     in it with its foot on the floor (the wall's crown is the floor + 4.8 m);
//   · the BERM: the metre and a half behind the wall set to just under its
//     crown, so the earth meets the coping instead of the 20 m survey's
//     slope cutting through the wall half way up;
//   · the RAMPART: from 7 to 14 m in, raised (never lowered) to 8.5 m over the
//     floor, a crest the paths along the top are levelled onto.
// The one way in, the causeway from Příhrádek over the moat and through the
// gate, is a hole in all three: the bridge (js/landmarks-valy.js) stands on a
// causeway with its walls down to the moat floor either side, and the passage
// through the rampart keeps its own grade.
const CAUSEWAY = [
  // the stone bridge, between its parapets: steep sides, the parapets are the walls
  { pts: [[1584.0, -1014.0], [1561.3, -1028.4]], hw: 2.9, fall: 1.2 },
  // the embankment on to the gate and the passage through the rampart
  { pts: [[1561.3, -1028.4], [1546.0, -1038.0], [1532.0, -1041.4], [1516.0, -1048.0]], hw: 3.2, fall: 5 },
];
export const STAMPS = [
  makeStamp({ pts: VALY, closed: true, base: VALY_FLOOR, mode: 'dig', holes: CAUSEWAY,
    prof: [[-0.001, 0, 0], [0, 0, 1], [10, 0, 1], [22, 0, 0]] }),
  makeStamp({ pts: VALY, closed: true, base: VALY_FLOOR, mode: 'set', holes: CAUSEWAY,
    prof: [[-4.5, 4.7, 0], [-1.5, 4.7, 1], [-0.001, 4.7, 1], [0, 4.7, 0]] }),
  makeStamp({ pts: VALY, closed: true, base: VALY_FLOOR, mode: 'raise', holes: CAUSEWAY,
    prof: [[-22, 8.5, 0], [-14, 8.5, 1], [-7, 8.5, 1], [-2, 4.7, 0]] }),
  // …and the moat in front of the gate is the wide one, the whole way out to
  // Příhrádek's gardens and the tennis courts: dug to the courts' level
  // under the bridge, wall to wall (its west edge stays clear of the rampart)
  makeStamp({ pts: [[1556, -1060], [1590, -1052], [1596, -1030], [1594, -1004], [1566, -992], [1556, -996]],
    closed: true, base: 215.8, mode: 'dig', holes: CAUSEWAY,
    prof: [[-400, 0, 1], [-0.001, 0, 1], [6, 0, 0]] }),
];

/** Every stamp, in order, applied to the height h at (x, z). */
export function stampHeight(stamps, x, z, h) {
  for (let i = 0; i < stamps.length; i++) h = applyStamp(stamps[i], x, z, h);
  return h;
}
/** The box all stamps lie in, for a one-compare reject on the hot path. */
export function stampsBox(stamps) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const s of stamps) { x0 = Math.min(x0, s.x0); z0 = Math.min(z0, s.z0); x1 = Math.max(x1, s.x1); z1 = Math.max(z1, s.z1); }
  return { x0, z0, x1, z1 };
}
