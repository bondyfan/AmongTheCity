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
import { NAPLAVKY, FRANTISKU_LANDING, NAPLAVKA_BEFORE, NAPLAVKA_AFTER } from './naplavky.js';
import { VYSEHRAD } from './vysehraddata.js';
import { ecoductCuts } from './roadpatches.js';

export const CELL = 8;       // m, the bucket grid that finds a stamp's nearby segments

/**
 * Make a stamp from its description.
 * @param def { pts: [[x,z]...], closed?: bool, base: number | number[] (per vertex),
 *              prof: [[d, dy, w]...] sorted by d, mode: 'dig'|'raise'|'set',
 *              holes?: [{ pts, hw, fall }], capped?: bool }
 * An open line is capped by default: past either end the profile goes on
 * round the end vertex (a half disc). `capped: false` stops it square at the
 * ends instead, which is what a quay or a ramp that ends at a street wants
 * (the round cap of the Novoměstská náplavka dug the cycleway at Výtoň).
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
  // the profile's hard edges (two entries at one d): where the drawn ground
  // may be snapped onto the line (js/quayedge.js quaySnap)
  const hard = [];
  for (let i = 0; i < prof.length - 1; i++) {
    if (prof[i + 1][0] - prof[i][0] < 0.01 && Math.abs(prof[i + 1][2] - prof[i][2]) > 0.5) hard.push((prof[i][0] + prof[i + 1][0]) / 2);
  }
  const st = { mode: def.mode, prof, reach, x0, z0, x1, z1, segN, sx, sz, ex, ez, len, nx, nz, y0, y1,
    hard: def.snap ? hard : [],
    closed, open: !closed && def.capped === false,
    holes: (def.holes ?? []).map(prepHole), grid: null, gw: 0, gh: 0 };
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
  let best = Infinity, bk = -1, bt = 0, braw = 0;
  for (let q = 0; q < list.length; q++) {
    const k = list[q];
    const raw = ((x - st.sx[k]) * st.ex[k] + (z - st.sz[k]) * st.ez[k]) / (st.len[k] * st.len[k]);
    const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
    const d = Math.hypot(x - st.sx[k] - st.ex[k] * t, z - st.sz[k] - st.ez[k] * t);
    if (d < best) { best = d; bk = k; bt = t; braw = raw; }
  }
  if (bk < 0 || best > st.reach) return h;
  // (an uncapped line stops square: nothing past its two end vertices)
  if (st.open && ((bk === 0 && braw < 0) || (bk === st.segN - 1 && braw > 1))) return h;
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
const PARDUBICE = [
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
// PRAGUE: the lower quays of the Vltava and the ramps and stairs down to them
// (js/naplavky.js). A ramp between two walls is set BEFORE the quay is dug, so
// whatever of it spills over the quay wall is dug back to the floor; a ramp
// or a stair that climbs the quay's own face is laid on the floor AFTER.
//
// First, RAŠÍNOVO NÁBŘEŽÍ AT PALACKÉHO MOST. The survey holds a hump of 3 to
// 4 m along the embankment street at the bridgehead (197.8 m at z -4615,
// where the street either side runs at 193 to 195), and the bridge's east
// end, which lands on the street, climbed to 197.5 over it. Dug to the
// embankment's own line (a gentle grade from Jiráskův most to Dřevná), full
// within 20 m of the street and fading out by 55 m, so Palackého náměstí
// runs down to it. 'dig' only: where the street is already lower it stays.
const RASINOVO = {
  pts: [[-96173, -4800], [-96170, -4720], [-96160, -4610], [-96158, -4500], [-96157, -4465]],
  base: [194.2, 195.0, 194.7, 194.5, 193.4], mode: 'dig',
  prof: [[-55, 0, 0], [-20, 0, 1], [20, 0, 1], [55, 0, 0]],
};
// Then Vyšehrad: the rock face over the embankment road, and the road's cut
// through the spur that its tunnel roof covers (js/vysehraddata.js).
const PRAHA = [RASINOVO, VYSEHRAD.faceN, VYSEHRAD.faceS, VYSEHRAD.tunnel,
  ...NAPLAVKA_BEFORE, ...NAPLAVKY, FRANTISKU_LANDING, ...NAPLAVKA_AFTER].map(makeStamp);
// the quays and the ways down to them (js/quayedge.js onQuay)
const QUAYS = PRAHA.slice(4);
// THE D11 under its two green bridges: the elevation model holds the bridges'
// earth, 9 to 11 m over the road the build dropped and js/roadpatches.js puts
// back, so each carriageway runs in a flat trench dug to the approaches'
// grade. One region per bridge (they are 19 km apart).
const ECODUCT = ecoductCuts().map(makeStamp);
const ZEHUN = ECODUCT.filter((s, i) => ecoductCuts()[i].pts[0][0] < -20000);
const VOLEC = ECODUCT.filter((s, i) => ecoductCuts()[i].pts[0][0] >= -20000);

// Each city's stamps with their own box, so the hot path in Terrain.heightAt
// stays one compare per region everywhere outside them (two cities, 100 km
// apart: one shared box would cover everything between them).
const RCELL = 16;            // m, the region grid of indexRegion below
export const STAMP_REGIONS = [PARDUBICE, PRAHA, ZEHUN, VOLEC].map((stamps) => indexRegion({ stamps, box: stampsBox(stamps) }));
for (const st of QUAYS) st.quay = true;

// Inside a region's box, the stamps that can have a say at a point, from a
// coarse grid built once: with Prague's thirty-odd quay, ramp and stair stamps
// in one long box, asking every one of them at every heightAt doubled the
// build time of a quay chunk. A cell lists every stamp with a non-empty bucket
// overlapping it, in the stamps' order, so the answer is the same as asking
// them all (applyStamp returns h unchanged where its bucket is empty).
function indexRegion(R) {
  const { box } = R;
  const gw = Math.max(1, Math.ceil((box.x1 - box.x0) / RCELL)), gh = Math.max(1, Math.ceil((box.z1 - box.z0) / RCELL));
  const cells = new Array(gw * gh).fill(null);
  const mark = (st, x0, z0, x1, z1) => {
    const a0 = Math.max(0, Math.floor((x0 - box.x0) / RCELL)), a1 = Math.min(gw - 1, Math.floor((x1 - box.x0) / RCELL));
    const b0 = Math.max(0, Math.floor((z0 - box.z0) / RCELL)), b1 = Math.min(gh - 1, Math.floor((z1 - box.z0) / RCELL));
    for (let b = b0; b <= b1; b++) for (let a = a0; a <= a1; a++) {
      const k = b * gw + a, l = cells[k] ?? (cells[k] = []);
      if (l[l.length - 1] !== st) l.push(st);
    }
  };
  for (const st of R.stamps) {
    for (let j = 0; j < st.gh; j++) for (let i = 0; i < st.gw; i++) {
      if (!st.grid[j * st.gw + i]) continue;
      const cx = st.x0 + i * CELL, cz = st.z0 + j * CELL;
      mark(st, cx, cz, cx + CELL, cz + CELL);
      // (a point exactly on the box's east edge reads the first bucket of
      // the next row: keep that answer too)
      if (i === 0 && j > 0) mark(st, st.x1, cz - CELL, st.x1, cz);
    }
  }
  R.gw = gw; R.gh = gh; R.cells = cells;
  return R;
}
// the stamps of region R that can move (x, z), a point inside R.box; null for none
export function regionList(R, x, z) {
  const b = R.box;
  let a = Math.floor((x - b.x0) / RCELL), c = Math.floor((z - b.z0) / RCELL);
  if (a >= R.gw) a = R.gw - 1;
  if (c >= R.gh) c = R.gh - 1;
  return R.cells[c * R.gw + a];
}
/** stampHeight for the stamps of region R at (x, z), a point inside R.box. */
export function regionHeight(R, x, z, h) {
  const l = regionList(R, x, z);
  if (l) for (let i = 0; i < l.length; i++) h = applyStamp(l[i], x, z, h);
  return h;
}
// every stamp, in order (the regions never overlap, so order within a region
// is all that matters)
export const STAMPS = [...PARDUBICE, ...PRAHA, ...ZEHUN, ...VOLEC];

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
