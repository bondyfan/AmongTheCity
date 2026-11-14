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
 */
export function stampPartyWalls(buildings) {
  const nb = buildings.length;
  let ne = 0;
  for (let k = 0; k < nb; k++) { const o = buildings[k].o; if (o && o.length >= 3) ne += o.length; }
  if (!ne) return;
  // flat edge table: endpoints, unit direction, length, owner and edge index
  const AX = new Float64Array(ne), AZ = new Float64Array(ne), UX = new Float64Array(ne),
    UZ = new Float64Array(ne), LN = new Float64Array(ne);
  const OWN = new Int32Array(ne);
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  let e = 0;
  for (let k = 0; k < nb; k++) {
    const o = buildings[k].o;
    if (!o || o.length < 3) continue;
    for (let i = 0; i < o.length; i++, e++) {
      const a = o[i], b = o[(i + 1) % o.length];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
      AX[e] = a[0]; AZ[e] = a[1]; OWN[e] = k;
      if (a[0] < x0) x0 = a[0]; if (a[0] > x1) x1 = a[0];
      if (a[1] < z0) z0 = a[1]; if (a[1] > z1) z1 = a[1];
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
  const span = (a, out) => {
    const ax = AX[a], az = AZ[a], bx = ax + UX[a] * LN[a], bz = az + UZ[a] * LN[a];
    out[0] = Math.floor((Math.min(ax, bx) - TOL - x0) / CELL);
    out[1] = Math.floor((Math.max(ax, bx) + TOL - x0) / CELL);
    out[2] = Math.floor((Math.min(az, bz) - TOL - z0) / CELL);
    out[3] = Math.floor((Math.max(az, bz) + TOL - z0) / CELL);
  };
  const sp = [0, 0, 0, 0];
  const start = new Int32Array(W * H + 1);
  for (let a = 0; a < ne; a++) {
    if (!LN[a]) continue;
    span(a, sp);
    for (let c = sp[0]; c <= sp[1]; c++) for (let r = sp[2]; r <= sp[3]; r++) start[r * W + c + 1]++;
  }
  for (let i = 0; i < W * H; i++) start[i + 1] += start[i];
  const fill = start.slice(0, W * H), list = new Int32Array(start[W * H]);
  for (let a = 0; a < ne; a++) {
    if (!LN[a]) continue;
    span(a, sp);
    for (let c = sp[0]; c <= sp[1]; c++) for (let r = sp[2]; r <= sp[3]; r++) list[fill[r * W + c]++] = a;
  }
  // Panel slabs are mapped section by section, and each section used to pick
  // its own colour. Sections of one slab (flat, four storeys and up, the same
  // height within a storey's half) are joined here, and f._slab names the
  // slab by its smallest id, which is what its colour is hashed from.
  const slab = new Uint8Array(nb), up = new Int32Array(nb);
  for (let k = 0; k < nb; k++) {
    const f = buildings[k];
    up[k] = k;
    slab[k] = (!f.r || f.r === 'flat') && (f.lv ?? (f.h ?? 0) / 3.1) >= 4 && !(f.i?.length) ? 1 : 0;
  }
  const root = (k) => { while (up[k] !== k) { up[k] = up[up[k]]; k = up[k]; } return k; };
  // the root is always the section with the smallest id, whatever order the
  // list came in, so the slab's name does not depend on it
  const key = (k) => buildings[k]._id ?? k;
  const join = (a, b) => { a = root(a); b = root(b); if (a !== b) { if (key(a) < key(b)) up[b] = a; else up[a] = b; } };
  const seen = new Int32Array(ne).fill(-1);
  const cover = new Float64Array(ne), low = new Float64Array(ne).fill(Infinity);
  for (let a = 0; a < ne; a++) {
    const L = LN[a];
    if (!L) continue;
    const ax = AX[a], az = AZ[a], ux = UX[a], uz = UZ[a];
    span(a, sp);
    for (let c = sp[0]; c <= sp[1]; c++) for (let r = sp[2]; r <= sp[3]; r++) {
      const cell = r * W + c;
      for (let j = start[cell], je = start[cell + 1]; j < je; j++) {
        const b = list[j];
        if (seen[b] === a) continue;
        seen[b] = a;
        if (OWN[b] === OWN[a]) continue;
        // parallel (either direction: neighbours wind their rings their own way)
        if (Math.abs(ux * UZ[b] - uz * UX[b]) > PAR) continue;
        const px = AX[b] - ax, pz = AZ[b] - az;
        const qx = px + UX[b] * LN[b], qz = pz + UZ[b] * LN[b];
        // both ends of b lie on a's line, within the tolerance
        if (Math.abs(px * uz - pz * ux) > TOL || Math.abs(qx * uz - qz * ux) > TOL) continue;
        const t0 = px * ux + pz * uz, t1 = qx * ux + qz * uz;
        const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
        if (hi - lo < 0.3) continue;
        cover[a] += hi - lo;
        const h = buildings[OWN[b]].h ?? 6;
        if (h < low[a]) low[a] = h;
        if (slab[OWN[a]] && slab[OWN[b]] && Math.abs(h - (buildings[OWN[a]].h ?? 6)) < 1.6)
          join(OWN[a], OWN[b]);
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
      if (LN[e] && cover[e] >= COVER * LN[e]) {
        pw ??= new Array(o.length).fill(0);
        pw[i] = Math.max(0.1, Math.round(low[e] * 10) / 10);
      }
    }
    if (pw) f._pw = pw; else if (f._pw) delete f._pw;
  }
  // the slab's name: the smallest id among its sections
  const many = new Uint8Array(nb);
  for (let k = 0; k < nb; k++) if (root(k) !== k) many[root(k)] = 1;
  for (let k = 0; k < nb; k++) {
    const f = buildings[k], r = root(k);
    if (slab[k] && (r !== k || many[k])) f._slab = key(r);
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

function ringSign(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a > 0 ? 1 : -1;
}
