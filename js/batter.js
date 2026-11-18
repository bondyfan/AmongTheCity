// ---- batter.js: where the ground meets a road or a railway (round 10) ----
// Pure: no three, no DOM. Read by the mesher (js/meshes.js: the ground clamp,
// the verge face of a road, the ballast shoulders of a track), by the feet
// (js/city.js heightAt) and by js/chunkspec.js (which cells a worker needs).
//
// WHY. A road outside the streets stood on its embankment behind a VERTICAL
// concrete quad, the kerb body, hung from each deck edge down to the ground.
// Where the ground under the edge was another carriageway's lower deck (the
// two carriageways of the Pardubice rychlodraha overlap by up to 1.7 m and
// were levelled a metre apart) that quad was a grey wall whose height rippled
// with the step. A railway's ballast shoulder had a fixed 0.9 m run, so a
// metre of height turned it into a vertical slab, and the ground clamp pulled
// the ground under every track down to the LOWEST track within 6.7 m, which
// left the higher one standing on its shoulders over a void.
//
// So the ground meets a way the way earthworks do: at a 1:1.5 batter. One
// shape, used by everything that has to agree on it:
//   · the ground mesh's embankment floor (clampUnderRoadsGen): snug under the
//     deck, then falling 1 in BATTER from just under the deck edge;
//   · the verge face a road edge is drawn with: from the deck edge down at the
//     same slope, FACE_GAP over that floor, until it meets the drawn ground
//     (and nothing at all where the edge lies on a sibling deck within
//     SIB_EPS); a track's ballast shoulder likewise, and between two parallel
//     tracks of one bed a ballast infill instead of two inner shoulders;
//   · the feet (city.heightAt), which stand on exactly the ground drawn.

import { roadSegs, segmentNear, nearestSeg } from './roadsegments.js';
import { LAYER_Y, CHUNK } from './config.js';
import { roadGradeY, railGradeY, streetOf } from './geo.js';

export const BATTER = 1.5;        // m of run per metre of fall
export const FACE_GAP = 0.03;     // the floor lies this far under the face
export const FACE_MAX = 4.5;      // m: the longest face a road edge draws (past one ground cell)
export const SIB_EPS = 0.05;      // an edge on a sibling deck this close draws nothing
const ROAD_BAND = 4.5;            // the flat cap past a kerb (meshes.js corridor note)
const FLARE = 5;                  // m beyond the band the ground still answers to the way
const RAIL_HALF = 1.35;           // meshes.js BED_HW: the ballast top's half width
const RAIL_FLAT = 3.0;            // m: the flat ceiling over a track's bed, then the batter
const RAIL_TOP0 = -0.025;         // the ballast top under the sleeper level
const FOOT = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian', 'track']);

/** A drivable road on the ground: its embankment body falls at the batter. */
const onGround = (r) => !!r.d && !r.br && !!r.p && r.p.length >= 2;
/** Is side `side` (0/1, streets.vergeAt) of road r kerbed at arclength s? There
 *  the street's kerb and pavement stand (meshes.vergeInto) and its kerb body. */
export function kerbedAt(r, s, side) {
  const vg = r._vg;
  if (!vg) return false;
  let k = s / vg.ds;
  if (k < 0) k = 0; else if (k > vg.n - 1) k = vg.n - 1;
  const i = Math.round(k);
  return !!vg.u[i] && vg.w[side][i] >= 0.5;          // (w in decimetres: a band of 5 cm or more)
}
/** Does road r get a sloped verge face anywhere (an edge that is not kerbed)? */
export function vergeFaced(r) {
  if (!onGround(r)) return false;
  const vg = streetOf(r);
  if (!vg) return true;
  for (let i = 0; i < vg.n; i++) if (!vg.u[i] || vg.w[0][i] < 0.5 || vg.w[1][i] < 0.5) return true;
  return false;
}
/** Heavy rail on its own bed (shoulders, infill), not a tram set into a street. */
export const railBedded = (r) => r.t !== 'tram' && !r.br && !!r.p && r.p.length >= 2;

// ---- the corridor entries the ground clamp reads -------------------------------
// { r, bb, hw, flare, lay } as before (meshes.js), plus: `half` the deck's own
// half width (where the batter starts), `bat` whether it does, `rise` the slope
// the ceiling climbs at past hw, `top0` the bed top under the layer level.
export function roadCorr(r, bb) {
  const half = (r.w ?? 3) / 2;
  return { r, bb, hw: half + ROAD_BAND, flare: FLARE,
    lay: FOOT.has(r.t) ? LAYER_Y.footway : LAYER_Y.road,
    half, bat: onGround(r), rise: 0.55, top0: 0 };
}
export function railCorr(r, bb) {
  // a tram keeps the street's numbers: its bed is the carriageway's
  if (r.t === 'tram') return { r, bb, hw: 2.2 + ROAD_BAND, flare: FLARE, lay: LAYER_Y.rail,
    half: 2.2, bat: false, rise: 0.55, top0: 0 };
  return { r, bb, hw: RAIL_FLAT, flare: FLARE, lay: LAYER_Y.rail,
    half: RAIL_HALF, bat: true, rise: 1 / BATTER, top0: RAIL_TOP0 };
}
/** The ceiling the ground keeps under way e at distance d from its line (grade gy). */
export function capOf(e, gy, d) {
  return gy + e.lay - 0.05 + (d > e.hw ? (d - e.hw) * e.rise : 0);
}
/** The embankment floor the ground rises to beside way e (flared entries only). */
export function floorOf(e, gy, d) {
  const top = gy + e.lay;
  if (!e.bat) return top - 0.45 - (d > e.hw ? (d - e.hw) * 0.55 : 0);
  return d <= e.half ? top - 0.45 : top + e.top0 - FACE_GAP - (d - e.half) / BATTER;
}
// (the clamp asks the grade the way it always has: a rail's own levelling,
// which for heavy rail is railGradeY's, for a tram not the street it is in)
const gradeOf = (r, s, terrain) => roadGradeY(r, s, terrain);

/**
 * The ground as the mesher DRAWS it at (x, z): the terrain `g0` under the
 * tightest ceiling and over the tallest floor of `entries`, the floor itself
 * under every ceiling, as meshes.clampUnderRoadsGen does per vertex.
 * `shaped(x, z)` is quayedge.stampShaped (no bank onto a Prague quay).
 */
export function groundUnder(x, z, g0, entries, terrain, shaped) {
  let minCap = Infinity, maxFloor = -Infinity;
  for (let k = 0; k < entries.length; k++) {
    const e = entries[k], bb = e.bb, reach = e.hw + (e.flare ?? 0);
    if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
    const segs = roadSegs(e.r);
    for (let i = 0; i < segs.length; i += 10) {
      if (!segmentNear(segs, i, x, z, reach)) continue;
      const dx = segs[i + 2], dz = segs[i + 3], L = segs[i + 4];
      const px = x - segs[i], pz = z - segs[i + 1];
      const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / (L * L || 1e-9)));
      const ex = px - dx * t, ez = pz - dz * t, d2 = ex * ex + ez * ez;
      if (d2 < reach * reach) {
        const d = Math.sqrt(d2);
        const gy = gradeOf(e.r, segs[i + 5] + L * t, terrain);
        if (gy !== null && gy !== undefined) {
          const cap = capOf(e, gy, d);
          if (cap < minCap) minCap = cap;
          if (e.flare) { const f = floorOf(e, gy, d); if (f > maxFloor) maxFloor = f; }
        }
      }
    }
  }
  let a = g0;
  if (a > minCap) a = minCap;
  const floor2 = Math.min(maxFloor, minCap);
  if (floor2 > -Infinity && a < floor2 && !shaped?.(x, z) && !(a < g0 - 1)) a = floor2;
  return a;
}

// ---- which ways a face or a shoulder must know about ------------------------------
const EDGE_REACH_ROAD = 30, EDGE_REACH_RAIL = 16;
/** Does way f draw a face or shoulder that reads its neighbours (edgeCellKeys)? */
export const edgeReaches = (f) => vergeFaced(f) || (!f.d && railBedded(f) && isRailT(f.t));
const isRailT = (t) => t === 'rail' || t === 'light_rail' || t === 'narrow_gauge' || t === 'subway';
/**
 * The chunk cells the edges of f read their neighbours from, into `out`. Pure
 * in f.p, because js/chunkspec.js ships exactly these cells to the mesh worker
 * (meshes.footCellKeys is the same idea for footways).
 */
export function edgeCellKeys(f, out) {
  const p = f.p, m = vergeFaced(f) ? EDGE_REACH_ROAD : EDGE_REACH_RAIL;
  const add = (x, z) => {
    const i0 = Math.floor((x - m) / CHUNK), i1 = Math.floor((x + m) / CHUNK);
    const j0 = Math.floor((z - m) / CHUNK), j1 = Math.floor((z + m) / CHUNK);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) out.add(i + ',' + j);
  };
  add(p[0][0], p[0][1]);
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / (m / 2)));
    for (let k = 1; k <= n; k++) add(ax + (bx - ax) * (k / n), az + (bz - az) * (k / n));
  }
  return out;
}
const bbOf = (r) => {
  if (r._bbE) return r._bbE;
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of r.p) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return [a, b, c, d];
};
/**
 * The ground corridors (roadCorr / railCorr entries) near way f, from every
 * cell its edges read (edgeCellKeys), f itself included: the ground at the
 * foot of a face is shaped by its own way as much as by the others.
 */
export function edgeNear(city, f, bboxOfLine = bbOf) {
  const keys = edgeCellKeys(f, new Set());
  const fb = bboxOfLine(f), m = (vergeFaced(f) ? EDGE_REACH_ROAD : EDGE_REACH_RAIL);
  const out = [], seen = new Set();
  for (const k of keys) {
    const c = city?.chunkIndex?.get(k);
    if (!c) continue;
    for (const [list, rail] of [[c.roads, false], [c.rails, true]]) {
      for (const r of list ?? []) {
        if (r.br || !r.p || r.p.length < 2 || seen.has(r)) continue;
        seen.add(r);
        const rb = bboxOfLine(r);
        if (rb[2] < fb[0] - m || rb[0] > fb[2] + m || rb[3] < fb[1] - m || rb[1] > fb[3] + m) continue;
        out.push(rail ? railCorr(r, rb) : roadCorr(r, rb));
      }
    }
  }
  // the order the cells came in is the order of a Set filled along f.p: the
  // same on both threads, and nothing below depends on it anyway (min / max)
  return out;
}

// ---- the drivable deck at a point, of the nearest segment of a way -------------
// (the same reading city.surfaceY makes: the nearest segment speaks for the way)
const _deckNear = { d: Infinity, e: 1 };
function deckOf(r, x, z, terrain, grow) {
  const half = (r.w ?? 3) / 2 + grow;
  const bs = nearestSeg(r, x, z, half, _deckNear);
  if (_deckNear.d >= half) return null;
  const gy = roadGradeY(r, bs, terrain);
  return gy === null || gy === undefined ? null : gy + LAYER_Y.road;
}
/** The highest drivable deck other than f's covering (x, z), or -Infinity. */
export function siblingTop(x, z, f, entries, terrain) {
  let top = -Infinity;
  for (const e of entries) {
    const r = e.r;
    if (r === f || !r.d) continue;
    const bb = e.bb, h = (r.w ?? 3) / 2;
    if (x < bb[0] - h || x > bb[2] + h || z < bb[1] - h || z > bb[3] + h) continue;
    const y = deckOf(r, x, z, terrain, 0.02);
    if (y !== null && y > top) top = y;
  }
  return top;
}

// ---- how far a face runs ----------------------------------------------------------
const STEPS = [0.15, 0.4, 0.8, 1.5, 2.5, 3.5, FACE_MAX];
const _run = { e: 0, y: 0, toe: 0 };
/**
 * The face from edge point (px, pz) at deck level Y, out along unit (nx, nz):
 * down at 1:BATTER until it is under the drawn ground there. Into _run: `e` the
 * run (0: no face), `y` its foot, `toe` how far down its toe goes, into the
 * ground (or, past FACE_MAX, down to the ground: a step only a broken profile
 * makes). The crossing is interpolated between the sample offsets.
 */
export function faceRun(px, pz, nx, nz, Y, entries, terrain, shaped) {
  let pe = 0;
  let ph = Y - (groundUnder(px, pz, terrain.heightAt(px, pz), entries, terrain, shaped) - 0.02);
  if (ph <= 0) { _run.e = 0; _run.y = Y; _run.toe = Y; return _run; }
  let G;
  for (const e of STEPS) {
    const x = px + nx * e, z = pz + nz * e;
    G = groundUnder(x, z, terrain.heightAt(x, z), entries, terrain, shaped);
    const h = (Y - e / BATTER) - (G - 0.02);
    if (h <= 0) {
      const ef = pe + (e - pe) * (ph / (ph - h));
      _run.e = ef; _run.y = Y - ef / BATTER; _run.toe = _run.y - 0.12;
      return _run;
    }
    pe = e; ph = h;
  }
  _run.e = FACE_MAX; _run.y = Y - FACE_MAX / BATTER;
  _run.toe = Math.min(_run.y - 0.12, G - 0.05);
  return _run;
}

// ---- emitters (the sink is meshes.js TriSink) ----------------------------------------
// A face tapers to nothing where its run is 0 at one end (a sibling's deck, a
// kerbed stretch), and a degenerate triangle has no normal: the codec ships a
// zero vector that comes back pointing anywhere. So the two triangles of a
// quad are emitted one by one, and a collapsed one is not.
function tri(sink, ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
  const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * nx + ny * ny + nz * nz < 1e-10) return;
  sink.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
}
function quad4(sink, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
  tri(sink, ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
  tri(sink, ax, ay, az, cx, cy, cz, dx, dy, dz, r, g, b);
}
// a quad whose normal points up whatever order its corners came in (meshes.paintQuad)
function upQuad(sink, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
  const ny = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  if (ny <= 0) quad4(sink, ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b);
  else quad4(sink, dx, dy, dz, cx, cy, cz, bx, by, bz, ax, ay, az, r, g, b);
}
// a wall a→b with its own top and bottom at each end, facing (fx, fz) (meshes.wallQuad4)
function wallQuad(sink, ax, az, bx, bz, yTa, yTb, yBa, yBb, fx, fz, r, g, b) {
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz >= 0) quad4(sink, ax, yTa, az, bx, yTb, bz, bx, yBb, bz, ax, yBa, az, r, g, b);
  else quad4(sink, bx, yTb, bz, ax, yTa, az, ax, yBa, az, bx, yBb, bz, r, g, b);
}

/**
 * The verge faces of road f: q / per / ys are its ribbon's stations, unit
 * perpendiculars and deck levels, hw its half width. `col` = [r, g, b].
 * Replaces the vertical kerb body on every road that is not a kerbed street.
 */
export function vergeFacesInto(sink, f, q, per, ys, hw, terrain, entries, shaped, col, kerbed = null) {
  const n = q.length;
  const run = new Float32Array(n * 2), fy = new Float32Array(n * 2), ty = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    for (let s = 0; s < 2; s++) {
      const e = s ? 1 : -1, nx = per[i][0] * e, nz = per[i][1] * e;
      const px = q[i][0] + nx * hw, pz = q[i][1] + nz * hw, Y = ys[i];
      const o = i * 2 + s;
      // a kerbed side has its kerb and pavement (meshes.vergeInto) instead
      if (kerbed?.(i, px, pz)) { run[o] = 0; fy[o] = Y; ty[o] = Y; continue; }
      // the edge lies on a sibling's deck within SIB_EPS: nothing to face
      if (siblingTop(px, pz, f, entries, terrain) >= Y - SIB_EPS) { run[o] = 0; fy[o] = Y; ty[o] = Y; continue; }
      const r = faceRun(px, pz, nx, nz, Y, entries, terrain, shaped);
      run[o] = r.e; fy[o] = r.y; ty[o] = r.toe;
    }
  }
  const [cr, cg, cb] = col;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < 2; s++) {
      const a = i * 2 + s, b = a + 2;
      if (run[a] <= 0 && run[b] <= 0) continue;
      const e = s ? 1 : -1;
      const ax = per[i][0] * e, az = per[i][1] * e, bx = per[i + 1][0] * e, bz = per[i + 1][1] * e;
      const X0 = q[i][0] + ax * hw, Z0 = q[i][1] + az * hw, X1 = q[i + 1][0] + bx * hw, Z1 = q[i + 1][1] + bz * hw;
      const F0x = X0 + ax * run[a], F0z = Z0 + az * run[a], F1x = X1 + bx * run[b], F1z = Z1 + bz * run[b];
      upQuad(sink, X0, ys[i], Z0, X1, ys[i + 1], Z1, F1x, fy[b], F1z, F0x, fy[a], F0z, cr, cg, cb);
      // the toe: into the ground, so no crease of it opens a slit under the face
      wallQuad(sink, F0x, F0z, F1x, F1z, fy[a], fy[b], ty[a], ty[b], ax + bx, az + bz, cr * 0.82, cg * 0.82, cb * 0.82);
    }
  }
}

// ---- a track's shoulders, and the bed between two tracks ----------------------------
const INFILL_MIN = 2.8, INFILL_MAX = 8;     // m between track centres: one bed
/**
 * The other heavy-rail track beside (x, z) on the side (nx, nz) whose bed
 * this one shares: parallel within ~18 deg, its centre INFILL_MIN to INFILL_MAX
 * away. Into _nb { d, top } (top: its ballast top), or null.
 */
const _nb = { d: 0, top: 0 };
function bedNeighbour(f, x, z, nx, nz, ux, uz, entries, terrain) {
  let best = null, bd = INFILL_MAX;
  for (const e of entries) {
    const r = e.r;
    if (r === f || !railBedded(r) || !isRailT(r.t)) continue;
    const bb = e.bb;
    if (x < bb[0] - bd || x > bb[2] + bd || z < bb[1] - bd || z > bb[3] + bd) continue;
    const p = r.p;
    let along = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], dx = p[i + 1][0] - ax, dz = p[i + 1][1] - az;
      const L2 = dx * dx + dz * dz || 1e-9, L = Math.sqrt(L2);
      let t = ((x - ax) * dx + (z - az) * dz) / L2;
      if (t >= 0 && t <= 1) {
        const cx = ax + dx * t, cz = az + dz * t;
        const d = Math.hypot(cx - x, cz - z);
        const side = (cx - x) * nx + (cz - z) * nz;
        if (d >= INFILL_MIN && d < bd && side > 0.9 * d && Math.abs((dx * ux + dz * uz) / L) > 0.95) {
          const gy = railGradeY(r, along + L * t, terrain);
          if (gy !== null && gy !== undefined) { bd = d; best = _nb; _nb.d = d; _nb.top = gy + LAYER_Y.rail + RAIL_TOP0; }
        }
      }
      along += L;
    }
  }
  return best;
}
/**
 * Both ballast shoulders of heavy-rail track f (railWay's stations q / per,
 * rail grades g): from the bed edge down at 1:BATTER to the drawn ground, or,
 * toward a parallel track of the same bed whose level a batter can reach, a
 * ballast infill to the midline between the two (each track draws its half,
 * so the two meet at the mean of their levels).
 */
export function railShouldersInto(sink, f, q, per, g, terrain, entries, shaped, col) {
  const n = q.length;
  const off = new Float32Array(n * 2), fy = new Float32Array(n * 2), ty = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const j = Math.min(i + 1, n - 1), k = j === i ? i - 1 : i;
    let ux = q[j][0] - q[k][0], uz = q[j][1] - q[k][1];
    const uL = Math.hypot(ux, uz) || 1; ux /= uL; uz /= uL;
    const Y = g[i] + LAYER_Y.rail + RAIL_TOP0;
    for (let s = 0; s < 2; s++) {
      const e = s ? 1 : -1, nx = per[i][0] * e, nz = per[i][1] * e, o = i * 2 + s;
      const nb = bedNeighbour(f, q[i][0], q[i][1], nx, nz, ux, uz, entries, terrain);
      if (nb) {
        const gap = nb.d - 2 * RAIL_HALF;
        if (Math.abs(nb.top - Y) <= gap / BATTER) {
          off[o] = nb.d / 2; fy[o] = (Y + nb.top) / 2; ty[o] = fy[o];
          continue;
        }
      }
      const px = q[i][0] + nx * RAIL_HALF, pz = q[i][1] + nz * RAIL_HALF;
      const r = faceRun(px, pz, nx, nz, Y, entries, terrain, shaped);
      off[o] = RAIL_HALF + Math.max(0.15, r.e);
      fy[o] = r.e > 0 ? r.y : Y - 0.1; ty[o] = r.e > 0 ? r.toe : Y - 0.22;
    }
  }
  const [cr, cg, cb] = col;
  for (let i = 0; i < n - 1; i++) {
    for (let s = 0; s < 2; s++) {
      const a = i * 2 + s, b = a + 2, e = s ? 1 : -1;
      const ax = per[i][0] * e, az = per[i][1] * e, bx = per[i + 1][0] * e, bz = per[i + 1][1] * e;
      const ya = g[i] + LAYER_Y.rail + RAIL_TOP0, yb = g[i + 1] + LAYER_Y.rail + RAIL_TOP0;
      const X0 = q[i][0] + ax * RAIL_HALF, Z0 = q[i][1] + az * RAIL_HALF;
      const X1 = q[i + 1][0] + bx * RAIL_HALF, Z1 = q[i + 1][1] + bz * RAIL_HALF;
      const F0x = q[i][0] + ax * off[a], F0z = q[i][1] + az * off[a];
      const F1x = q[i + 1][0] + bx * off[b], F1z = q[i + 1][1] + bz * off[b];
      upQuad(sink, X0, ya, Z0, X1, yb, Z1, F1x, fy[b], F1z, F0x, fy[a], F0z, cr, cg, cb);
      if (ty[a] < fy[a] || ty[b] < fy[b]) {
        wallQuad(sink, F0x, F0z, F1x, F1z, fy[a], fy[b], ty[a], ty[b], ax + bx, az + bz, cr * 0.86, cg * 0.86, cb * 0.86);
      }
    }
  }
}

/**
 * Where feet stand on heavy-rail track f at arclength s, `d` from its line,
 * at (x, z): the sleepers over the bed top, then what railShouldersInto drew
 * on that side, the shoulder at the batter or the infill toward a track of
 * the same bed. Null where the grade is not known.
 */
export function railBedY(f, s, d, x, z, entries, terrain) {
  const gy = railGradeY(f, s, terrain);
  if (gy === null || gy === undefined) return null;
  if (d <= RAIL_HALF + 0.1) return gy + LAYER_Y.rail;
  // the line's point and direction there
  const p = f.p;
  let along = 0, cx = x, cz = z, ux = 1, uz = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], dx = p[i + 1][0] - ax, dz = p[i + 1][1] - az;
    const L = Math.hypot(dx, dz) || 1e-9;
    if (along + L >= s || i === p.length - 2) {
      const t = Math.max(0, Math.min(1, (s - along) / L));
      cx = ax + dx * t; cz = az + dz * t; ux = dx / L; uz = dz / L;
      break;
    }
    along += L;
  }
  let nx = x - cx, nz = z - cz;
  const nL = Math.hypot(nx, nz) || 1; nx /= nL; nz /= nL;
  const Y = gy + LAYER_Y.rail + RAIL_TOP0;
  const nb = bedNeighbour(f, cx, cz, nx, nz, ux, uz, entries, terrain);
  if (nb && Math.abs(nb.top - Y) <= (nb.d - 2 * RAIL_HALF) / BATTER && d <= nb.d / 2) {
    const mid = (Y + nb.top) / 2;
    return Y + (mid - Y) * (d - RAIL_HALF) / (nb.d / 2 - RAIL_HALF);
  }
  return Y - (d - RAIL_HALF) / BATTER;
}
