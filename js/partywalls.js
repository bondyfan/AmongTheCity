// ---- partywalls.js: which walls a building shares with the house next door ----
// Pure data (no three, no DOM). A Prague street is one continuous wall built
// out of separate footprints, and the walls BETWEEN them (30 % of the wall
// length in the Old Town tile, measured) used to carry full window grids. Where
// the neighbour is taller they are hidden geometry (17 % of the tile's wall
// quads); where it is lower they are the blank firewall you see over a low
// house in every Czech town, and windows on them are a tell.
//
// stampPartyWalls(buildings) writes f._pw on every building that touches a
// neighbour: one number per OUTER ring edge, 0 for a free wall, otherwise the
// neighbour's height h rounded to 0.1 m (the lowest one, where two neighbours
// share an edge). Plain data, so js/chunkspec.js carries it to the mesh worker
// untouched.
//
// It sees ONE tile's buildings, on purpose: the answer must be a pure function
// of the tile, never of which neighbouring tile happened to arrive first (two
// co-op clients would build different walls). A wall across a tile seam stays
// a windowed wall, exactly as it was before this existed.

const TOL = 0.35;        // how far apart two surveyed walls may lie and still be one
const PAR = 0.06;        // sine of the largest angle between them (about 3.4 degrees)
const COVER = 0.7;       // share of an edge a neighbour must cover to make it party
const MIN_EDGE = 1.0;    // shorter edges are jogs: never party, never culled
const CELL0 = 12;        // grid cell, metres (grown on a sparse tile, below)
const MAX_CELLS = 1 << 18;

/**
 * stampPartyWalls(buildings): sets f._pw on each building with a shared wall,
 * deletes a stale one otherwise, and f._slab on the sections of a slab. Idempotent; the order of `buildings` does not
 * change the result (every edge is tested against every candidate).
 *
 * It runs on the main thread inside geo.js indexPayload, once per tile
 * arrival, so it is written for time: 143 000 edges on a dense Prague tile
 * took 45 to 130 ms, a hitch every time a tile streamed in. A tile lists its
 * buildings in OSM order, so the neighbours of an edge are random indices,
 * and every candidate used to be a handful of cache misses into parallel
 * arrays. Now each grid cell holds a COPY of what the tests read about its
 * edges, one 64-byte record per edge per cell, and the pairs are walked cell
 * by cell straight down that memory: a building's own edges sit in one run
 * and are skipped as a run, and a pair met in several cells is taken only in
 * the first cell the two spans share (two flag bits per record say whether
 * this is the edge's first column and first row). Each pair is then tested
 * both ways with the same tests as before, so the walls found are the same.
 */
const REC = 8;           // per edge in a cell: ux, uz, ax, az, L, edge, owner * 4 + first-cell flags, run end
let _cap = 0, AX, AZ, UX, UZ, LN, C0, C1, R0, R1, OWN, COV, LOW;
let _lcap = 0, LR;
let _start = new Int32Array(0);
function scratch(ne, nl) {
  if (ne > _cap) {
    _cap = Math.max(ne, Math.ceil(_cap * 1.25));
    AX = new Float64Array(_cap); AZ = new Float64Array(_cap); UX = new Float64Array(_cap);
    UZ = new Float64Array(_cap); LN = new Float64Array(_cap);
    COV = new Float64Array(_cap); LOW = new Float64Array(_cap);
    C0 = new Int32Array(_cap); C1 = new Int32Array(_cap); R0 = new Int32Array(_cap); R1 = new Int32Array(_cap);
    OWN = new Int32Array(_cap);
  }
  if (nl > _lcap) {
    _lcap = Math.max(nl, Math.ceil(_lcap * 1.25));
    LR = new Float64Array(_lcap * REC);
  }
}

export function stampPartyWalls(buildings) {
  const nb = buildings.length;
  let ne = 0;
  for (let k = 0; k < nb; k++) { const o = buildings[k].o; if (o && o.length >= 3) ne += o.length; }
  if (!ne) return;
  scratch(ne, 0);
  // flat edge table: endpoint, unit direction, length, owner (L 0: a jog)
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  let e = 0;
  for (let k = 0; k < nb; k++) {
    const o = buildings[k].o;
    if (!o || o.length < 3) continue;
    const n = o.length;
    for (let i = 0; i < n; i++, e++) {
      const a = o[i], b = o[i + 1 < n ? i + 1 : 0];
      const ax = a[0], az = a[1];
      // (sqrt, not hypot: three times cheaper, and over all 342 tiles the
      // walls found are identical)
      const dx = b[0] - ax, dz = b[1] - az, L = Math.sqrt(dx * dx + dz * dz);
      AX[e] = ax; AZ[e] = az; OWN[e] = k;
      if (ax < x0) x0 = ax; if (ax > x1) x1 = ax;
      if (az < z0) z0 = az; if (az > z1) z1 = az;
      if (L < MIN_EDGE) { LN[e] = 0; continue; }
      LN[e] = L; UX[e] = dx / L; UZ[e] = dz / L;
    }
  }
  // A uniform grid over the tile in compressed rows (count, prefix, fill):
  // small integer cells and typed arrays, because a Map keyed on world cells
  // cost half a second on a Prague tile.
  // A country tile spreads its houses over 24 km, where 12 m cells made a
  // 4.8-million-cell grid (two 20 MB arrays per tile arrival); the cell grows
  // there so the grid stays near MAX_CELLS. Which edges pair up does not depend
  // on the cell size, only how many candidates each cell lists.
  const CELL = Math.max(CELL0, Math.sqrt((x1 - x0 + 2 * CELL0) * (z1 - z0 + 2 * CELL0) / MAX_CELLS));
  x0 -= CELL; z0 -= CELL;
  const W = Math.max(1, Math.ceil((x1 - x0) / CELL) + 2), H = Math.max(1, Math.ceil((z1 - z0) / CELL) + 2);
  const NC = W * H;
  if (_start.length < NC + 1) _start = new Int32Array(NC + 1);
  const start = _start;
  start.fill(0, 0, NC + 1);
  let total = 0;
  for (let a = 0; a < ne; a++) {
    const L = LN[a];
    if (!L) continue;
    const ax = AX[a], az = AZ[a], bx = ax + UX[a] * L, bz = az + UZ[a] * L;
    const c0 = Math.floor((Math.min(ax, bx) - TOL - x0) / CELL), c1 = Math.floor((Math.max(ax, bx) + TOL - x0) / CELL);
    const r0 = Math.floor((Math.min(az, bz) - TOL - z0) / CELL), r1 = Math.floor((Math.max(az, bz) + TOL - z0) / CELL);
    C0[a] = c0; C1[a] = c1; R0[a] = r0; R1[a] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * W + c + 1]++;
    total += (c1 - c0 + 1) * (r1 - r0 + 1);
  }
  for (let i = 0; i < NC; i++) start[i + 1] += start[i];
  scratch(ne, total);
  const R = LR;
  // (the fill cursor runs on each cell's own start, which then holds the
  // next cell's start, so the table shifts back by one)
  for (let a = 0; a < ne; a++) {
    if (!LN[a]) continue;
    const c0 = C0[a], r0 = R0[a], c1 = C1[a], r1 = R1[a], ok = OWN[a] * 4;
    const ux = UX[a], uz = UZ[a], ax = AX[a], az = AZ[a], L = LN[a];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const q = start[r * W + c]++ * REC;
      R[q] = ux; R[q + 1] = uz; R[q + 2] = ax; R[q + 3] = az; R[q + 4] = L; R[q + 5] = a;
      R[q + 6] = ok + (c === c0 ? 2 : 0) + (r === r0 ? 1 : 0);
    }
  }
  for (let i = NC; i > 0; i--) start[i] = start[i - 1];
  start[0] = 0;
  // Panel slabs are mapped section by section, and each section used to pick
  // its own colour. Sections of one slab (flat, four storeys and up, the same
  // height within a storey's half) are joined here, and f._slab names the
  // slab by its smallest id, which is what its colour is hashed from.
  // (heights and ids copied out once: the records come in many shapes, and a
  // property read on them in the pair loop is a slow megamorphic lookup)
  const slab = new Uint8Array(nb), up = new Int32Array(nb), hb = new Float64Array(nb), ids = new Float64Array(nb);
  for (let k = 0; k < nb; k++) {
    const f = buildings[k];
    up[k] = k;
    hb[k] = f.h ?? 6;
    ids[k] = f._id ?? k;
    slab[k] = (!f.r || f.r === 'flat') && (f.lv ?? (f.h ?? 0) / 3.1) >= 4 && !(f.i?.length) ? 1 : 0;
  }
  const root = (k) => { while (up[k] !== k) { up[k] = up[up[k]]; k = up[k]; } return k; };
  // the root is always the section with the smallest id, whatever order the
  // list came in, so the slab's name does not depend on it
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) { if (ids[a] < ids[b]) up[b] = a; else up[a] = b; } };
  COV.fill(0, 0, ne); LOW.fill(Infinity, 0, ne);
  for (let cell = 0; cell < NC; cell++) {
    const s0 = start[cell] * REC, s1 = start[cell + 1] * REC;
    if (s1 - s0 < 2 * REC) continue;
    // A building's own edges sit in one run (the list is in edge order): each
    // record learns where its run ends, so the pairs skip it in one step.
    for (let q = s1 - REC, end = s1, own = -1; q >= s0; q -= REC) {
      const o = (R[q + 6] | 0) >> 2;
      if (o !== own) { own = o; end = q + REC; }
      R[q + 7] = end;
    }
    for (let qa = s0; qa < s1 - REC; qa += REC) {
      const fa = R[qa + 6] | 0, oa = fa >> 2, ux = R[qa], uz = R[qa + 1];
      for (let qb = R[qa + 7]; qb < s1; qb += REC) {
        // parallel (either direction: neighbours wind their rings their own way)
        const vx = R[qb], vz = R[qb + 1];
        if (Math.abs(ux * vz - uz * vx) > PAR) continue;
        // each pair once, in the first cell both spans share: this cell is
        // the later of the two first columns and of the two first rows
        const fb = R[qb + 6] | 0;
        if (!((fa | fb) & 2) || !((fa | fb) & 1)) continue;
        const ob = fb >> 2;
        const ax = R[qa + 2], az = R[qa + 3], L = R[qa + 4], a = R[qa + 5];
        const bx = R[qb + 2], bz = R[qb + 3], Lb = R[qb + 4], b = R[qb + 5];
        let hit = false;
        // b on a's line: both ends of b within the tolerance, overlapping a
        let px = bx - ax, pz = bz - az, qx = px + vx * Lb, qz = pz + vz * Lb;
        if (Math.abs(px * uz - pz * ux) <= TOL && Math.abs(qx * uz - qz * ux) <= TOL) {
          const t0 = px * ux + pz * uz, t1 = qx * ux + qz * uz;
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
          if (hi - lo >= 0.3) {
            COV[a] += hi - lo;
            if (hb[ob] < LOW[a]) LOW[a] = hb[ob];
            hit = true;
          }
        }
        // and a on b's line, the same test the other way round
        px = ax - bx; pz = az - bz; qx = px + ux * L; qz = pz + uz * L;
        if (Math.abs(px * vz - pz * vx) <= TOL && Math.abs(qx * vz - qz * vx) <= TOL) {
          const t0 = px * vx + pz * vz, t1 = qx * vx + qz * vz;
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(Lb, Math.max(t0, t1));
          if (hi - lo >= 0.3) {
            COV[b] += hi - lo;
            if (hb[oa] < LOW[b]) LOW[b] = hb[oa];
            hit = true;
          }
        }
        if (hit && slab[oa] && slab[ob] && Math.abs(hb[oa] - hb[ob]) < 1.6 && up[oa] !== up[ob]) join(oa, ob);
      }
    }
  }
  // write back per building
  e = 0;
  for (let k = 0; k < nb; k++) {
    const f = buildings[k], o = f.o;
    if (!o || o.length < 3) continue;
    let pw = null;
    for (let i = 0; i < o.length; i++, e++) {
      const L = LN[e];
      if (L && COV[e] >= COVER * L) {
        pw ??= new Array(o.length).fill(0);
        pw[i] = Math.max(0.1, Math.round(LOW[e] * 10) / 10);
      }
    }
    if (pw) f._pw = pw; else if (f._pw) delete f._pw;
  }
  // the slab's name: the smallest id among its sections
  const many = new Uint8Array(nb);
  for (let k = 0; k < nb; k++) if (root(k) !== k) many[root(k)] = 1;
  for (let k = 0; k < nb; k++) {
    const f = buildings[k], r = root(k);
    if (slab[k] && (r !== k || many[k])) f._slab = ids[r];
    else if (f._slab !== undefined) delete f._slab;
  }
}

/**
 * The party value of edge i, or 0. A ring with a different vertex count from
 * the stamp (a footprint rewritten after indexing) reads as all free.
 */
export const partyOf = (f, i) => (f._pw && f._pw.length === f.o.length ? f._pw[i] : 0);

/**
 * blockCorner(f) -> index of the block-corner vertex, or -1: a convex corner
 * whose two walls are both free (not party), at least 7 m long, and meet at
 * 60..120 degrees; the longest such. Where a perimeter block turns a street
 * corner: the corner turret (roofgrammar.js) and the corner shop (typology.js).
 */
export function blockCorner(f) {
  const ring = f.o, n = ring.length;
  // (a house that shares no wall is not a block corner, it is a villa)
  if (n > 40 || !f._pw) return -1;
  const sgn = ringSign(ring);
  let best = -1, bestL = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n];
    if (partyOf(f, (i - 1 + n) % n) > 0 || partyOf(f, i) > 0) continue;
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 7 || lb < 7) continue;
    const cr = (ax * bz - az * bx) / (la * lb), dt = (ax * bx + az * bz) / (la * lb);
    // convex: the turn has the ring's own winding; 60..120 degrees between walls
    if (cr * sgn <= 0) continue;
    if (Math.abs(dt) > 0.5) continue;
    if (la + lb > bestL) { bestL = la + lb; best = i; }
  }
  return best;
}

/**
 * chamferCorner(f) -> index of the edge that cuts a block corner off, or -1:
 * a free wall of 2 to 7 m between two free walls of at least 7 m, turning about
 * 45 degrees (30..60) the same way at both its ends, so the long walls meet at
 * 60..120 degrees across it; the longest such pair. The corner of a Zizkov or
 * Vinohrady block is as often cut off as square (26 of 100 corner houses in
 * Zizkov, measured), and the oriel stands over the cut.
 */
export function chamferCorner(f) {
  const ring = f.o, n = ring.length;
  if (n > 40 || n < 5 || !f._pw) return -1;
  const sgn = ringSign(ring);
  const dir = (i) => {
    const a = ring[(i + n) % n], b = ring[(i + 1 + n) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    return [dx / L, dz / L, L];
  };
  let best = -1, bestL = 0;
  for (let i = 0; i < n; i++) {
    const [cx, cz, cl] = dir(i);
    if (cl < 2 || cl > 7) continue;
    const ip = (i - 1 + n) % n, inx = (i + 1) % n;
    if (partyOf(f, ip) > 0 || partyOf(f, i) > 0 || partyOf(f, inx) > 0) continue;
    const [px, pz, pl] = dir(ip), [qx, qz, ql] = dir(inx);
    if (pl < 7 || ql < 7) continue;
    // each end turns 30..60 degrees, convex (the ring's own winding)
    const c1 = px * cx + pz * cz, c2 = cx * qx + cz * qz;
    if (c1 < 0.5 || c1 > 0.866 || c2 < 0.5 || c2 > 0.866) continue;
    if ((px * cz - pz * cx) * sgn <= 0 || (cx * qz - cz * qx) * sgn <= 0) continue;
    // and the two long walls meet at 60..120 degrees
    if (Math.abs(px * qx + pz * qz) > 0.5) continue;
    if (pl + ql > bestL) { bestL = pl + ql; best = i; }
  }
  return best;
}

function ringSign(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a > 0 ? 1 : -1;
}
