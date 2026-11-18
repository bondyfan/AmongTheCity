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
 *
 * That still came to 21.5 ms warm on a dense Prague tile and 50 to 65 ms on
 * the first tiles of a session (measured), in ONE step of geo.js's sliced
 * indexing, so the 4 ms slicer could not cut it. stampPartyWallsSteps is the
 * same pass with a yield every few thousand edges, records or buildings:
 * geo.js calls it with yield*, and this function is its drain. The loops stay
 * in plain range functions over module state (V8 optimises a big loop inside
 * a generator body worse: 30 to 50 % slower cold, measured), and each range
 * continues exactly where the last one stopped, so every sum is taken in the
 * same order and the output is the same to the bit.
 */
export function stampPartyWalls(buildings) {
  const it = stampPartyWallsSteps(buildings);
  while (!it.next().done);
}

// work between two yields (a few tenths of a millisecond warm on a dense
// Prague tile, under a millisecond or two cold). The pairs are counted as
// records plus the pairs a cell holds, since a crowded cell costs the square
// of its records (a country tile's grid has bigger cells).
const EDGE_STEP = 2048, PAIR_STEP = 8192, BLD_STEP = 512;

/** The pass in steps: yields between ranges, returns when every f._pw is written. */
export function* stampPartyWallsSteps(buildings) {
  const my = begin(buildings);
  if (!my) return;
  yield;                // (the first tiles of a session grow the scratch here)
  if (_run !== my) return stampPartyWalls(buildings);
  // (tile indexing is serialised, geo.js workTurn, so nothing else runs this
  // pass between two of our steps; if something ever did, the scratch is no
  // longer ours and the pass starts over in one go rather than mix two tiles)
  const lost = () => _run !== my;
  for (let k = 0; k < _nb;) { k = edgeRange(k, EDGE_STEP); yield; if (lost()) return stampPartyWalls(buildings); }
  gridInit();
  for (let a = 0; a < _ne; a += EDGE_STEP) {
    gridCount(a, Math.min(_ne, a + EDGE_STEP)); yield; if (lost()) return stampPartyWalls(buildings);
  }
  gridPrefix();
  yield; if (lost()) return stampPartyWalls(buildings);
  for (let a = 0; a < _ne; a += EDGE_STEP) {
    gridFill(a, Math.min(_ne, a + EDGE_STEP)); yield; if (lost()) return stampPartyWalls(buildings);
  }
  gridShift();
  for (let k = 0; k < _nb; k += BLD_STEP) {
    slabRange(k, Math.min(_nb, k + BLD_STEP)); yield; if (lost()) return stampPartyWalls(buildings);
  }
  _cov.fill(0, 0, _ne); _low.fill(Infinity, 0, _ne);
  for (let c = 0; c < _nc;) { c = pairRange(c, PAIR_STEP); yield; if (lost()) return stampPartyWalls(buildings); }
  _e = 0;
  for (let k = 0; k < _nb; k += BLD_STEP) {
    writeRange(k, Math.min(_nb, k + BLD_STEP)); yield; if (lost()) return stampPartyWalls(buildings);
  }
  slabNames();
  _B = null;
}

// per edge in a cell, a record in two halves: the geometry the tests read
// (ux, uz, ax, az, L) and the integers that steer the walk (edge, owner * 4 +
// first-cell flags, end of the owner's run); split, the walk is 8 to 10 %
// faster than with one 64-byte record of doubles (measured), same answers
const RG = 5, RM = 3;
let _cap = 0, AX, AZ, UX, UZ, LN, C0, C1, R0, R1, OWN, COV, LOW;
let _lcap = 0, LG, LM;
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
    LG = new Float64Array(_lcap * RG); LM = new Int32Array(_lcap * RM);
  }
  _cov = COV; _low = LOW;
}

// the pass in flight: its buildings, sizes, grid and cursors
let _run = 0, _B = null, _nb = 0, _ne = 0, _e = 0, _total = 0;
let _x0 = 0, _z0 = 0, _x1 = 0, _z1 = 0, _cell = 0, _w = 0, _nc = 0;
let _slabF = null, _up = null, _hb = null, _ids = null, _cov = null, _low = null;

function begin(buildings) {
  const nb = buildings.length;
  let ne = 0;
  for (let k = 0; k < nb; k++) { const o = buildings[k].o; if (o && o.length >= 3) ne += o.length; }
  if (!ne) return 0;
  scratch(ne, 0);
  _B = buildings; _nb = nb; _ne = ne; _e = 0; _total = 0;
  _x0 = Infinity; _z0 = Infinity; _x1 = -Infinity; _z1 = -Infinity;
  return ++_run;
}

// flat edge table: endpoint, unit direction, length, owner (L 0: a jog), from
// building k on until `lim` edges are in; returns the next building
function edgeRange(k, lim) {
  const buildings = _B, nb = _nb;
  let x0 = _x0, z0 = _z0, x1 = _x1, z1 = _z1, e = _e;
  const stop = e + lim;
  for (; k < nb && e < stop; k++) {
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
  _x0 = x0; _z0 = z0; _x1 = x1; _z1 = z1; _e = e;
  return k;
}

// A uniform grid over the tile in compressed rows (count, prefix, fill):
// small integer cells and typed arrays, because a Map keyed on world cells
// cost half a second on a Prague tile.
// A country tile spreads its houses over 24 km, where 12 m cells made a
// 4.8-million-cell grid (two 20 MB arrays per tile arrival); the cell grows
// there so the grid stays near MAX_CELLS. Which edges pair up does not depend
// on the cell size, only how many candidates each cell lists.
function gridInit() {
  const CELL = Math.max(CELL0, Math.sqrt((_x1 - _x0 + 2 * CELL0) * (_z1 - _z0 + 2 * CELL0) / MAX_CELLS));
  _x0 -= CELL; _z0 -= CELL;
  const W = Math.max(1, Math.ceil((_x1 - _x0) / CELL) + 2), H = Math.max(1, Math.ceil((_z1 - _z0) / CELL) + 2);
  const NC = W * H;
  if (_start.length < NC + 1) _start = new Int32Array(NC + 1);
  _start.fill(0, 0, NC + 1);
  _cell = CELL; _w = W; _nc = NC; _total = 0;
}
function gridCount(a0, a1) {
  const start = _start, W = _w, CELL = _cell, x0 = _x0, z0 = _z0;
  let total = _total;
  for (let a = a0; a < a1; a++) {
    const L = LN[a];
    if (!L) continue;
    const ax = AX[a], az = AZ[a], bx = ax + UX[a] * L, bz = az + UZ[a] * L;
    const c0 = Math.floor((Math.min(ax, bx) - TOL - x0) / CELL), c1 = Math.floor((Math.max(ax, bx) + TOL - x0) / CELL);
    const r0 = Math.floor((Math.min(az, bz) - TOL - z0) / CELL), r1 = Math.floor((Math.max(az, bz) + TOL - z0) / CELL);
    C0[a] = c0; C1[a] = c1; R0[a] = r0; R1[a] = r1;
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) start[r * W + c + 1]++;
    total += (c1 - c0 + 1) * (r1 - r0 + 1);
  }
  _total = total;
}
function gridPrefix() {
  const start = _start, NC = _nc;
  for (let i = 0; i < NC; i++) start[i + 1] += start[i];
  scratch(_ne, _total);
}
// (the fill cursor runs on each cell's own start, which then holds the
// next cell's start, so the table shifts back by one in gridShift)
function gridFill(a0, a1) {
  const start = _start, W = _w, G = LG, M = LM;
  for (let a = a0; a < a1; a++) {
    if (!LN[a]) continue;
    const c0 = C0[a], r0 = R0[a], c1 = C1[a], r1 = R1[a], ok = OWN[a] * 4;
    const ux = UX[a], uz = UZ[a], ax = AX[a], az = AZ[a], L = LN[a];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const q = start[r * W + c]++, g = q * RG, m = q * RM;
      G[g] = ux; G[g + 1] = uz; G[g + 2] = ax; G[g + 3] = az; G[g + 4] = L;
      M[m] = a; M[m + 1] = ok + (c === c0 ? 2 : 0) + (r === r0 ? 1 : 0);
    }
  }
}
function gridShift() {
  const start = _start;
  for (let i = _nc; i > 0; i--) start[i] = start[i - 1];
  start[0] = 0;
  const nb = _nb;
  _slabF = new Uint8Array(nb); _up = new Int32Array(nb); _hb = new Float64Array(nb); _ids = new Float64Array(nb);
}

// Panel slabs are mapped section by section, and each section used to pick
// its own colour. Sections of one slab (flat, four storeys and up, the same
// height within a storey's half) are joined here, and f._slab names the
// slab by its smallest id, which is what its colour is hashed from.
// (heights and ids copied out once: the records come in many shapes, and a
// property read on them in the pair loop is a slow megamorphic lookup)
function slabRange(k0, k1) {
  const buildings = _B, slab = _slabF, up = _up, hb = _hb, ids = _ids;
  for (let k = k0; k < k1; k++) {
    const f = buildings[k];
    up[k] = k;
    hb[k] = f.h ?? 6;
    ids[k] = f._id ?? k;
    slab[k] = (!f.r || f.r === 'flat') && (f.lv ?? (f.h ?? 0) / 3.1) >= 4 && !(f.i?.length) ? 1 : 0;
  }
}
function root(k) {
  const up = _up;
  while (up[k] !== k) { up[k] = up[up[k]]; k = up[k]; }
  return k;
}
// the root is always the section with the smallest id, whatever order the
// list came in, so the slab's name does not depend on it
function join(a, b) {
  a = root(a); b = root(b);
  if (a !== b) { if (_ids[a] < _ids[b]) _up[b] = a; else _up[a] = b; }
}

// the pairs, cell by cell from `cell` on until `lim` records and pairs are
// walked; returns the next cell
function pairRange(cell, lim) {
  const start = _start, G = LG, M = LM, NC = _nc, COVa = _cov, LOWa = _low;
  const slab = _slabF, up = _up, hb = _hb;
  let done = 0;
  for (; cell < NC && done < lim; cell++) {
    const s0 = start[cell], s1 = start[cell + 1];
    if (s1 - s0 < 2) continue;
    const nr = s1 - s0;
    done += nr + nr * (nr - 1) / 2;
    // A building's own edges sit in one run (the list is in edge order): each
    // record learns where its run ends, so the pairs skip it in one step.
    for (let q = s1 - 1, end = s1, own = -1; q >= s0; q--) {
      const o = M[q * RM + 1] >> 2;
      if (o !== own) { own = o; end = q + 1; }
      M[q * RM + 2] = end;
    }
    for (let qa = s0; qa < s1 - 1; qa++) {
      const ga = qa * RG, fa = M[qa * RM + 1], oa = fa >> 2, ux = G[ga], uz = G[ga + 1];
      for (let qb = M[qa * RM + 2]; qb < s1; qb++) {
        // parallel (either direction: neighbours wind their rings their own way)
        const gb = qb * RG, vx = G[gb], vz = G[gb + 1];
        if (Math.abs(ux * vz - uz * vx) > PAR) continue;
        // each pair once, in the first cell both spans share: this cell is
        // the later of the two first columns and of the two first rows
        const fb = M[qb * RM + 1];
        if (!((fa | fb) & 2) || !((fa | fb) & 1)) continue;
        const ob = fb >> 2;
        const ax = G[ga + 2], az = G[ga + 3], L = G[ga + 4], a = M[qa * RM];
        const bx = G[gb + 2], bz = G[gb + 3], Lb = G[gb + 4], b = M[qb * RM];
        let hit = false;
        // b on a's line: both ends of b within the tolerance, overlapping a
        let px = bx - ax, pz = bz - az, qx = px + vx * Lb, qz = pz + vz * Lb;
        if (Math.abs(px * uz - pz * ux) <= TOL && Math.abs(qx * uz - qz * ux) <= TOL) {
          const t0 = px * ux + pz * uz, t1 = qx * ux + qz * uz;
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(L, Math.max(t0, t1));
          if (hi - lo >= 0.3) {
            COVa[a] += hi - lo;
            if (hb[ob] < LOWa[a]) LOWa[a] = hb[ob];
            hit = true;
          }
        }
        // and a on b's line, the same test the other way round
        px = ax - bx; pz = az - bz; qx = px + ux * L; qz = pz + uz * L;
        if (Math.abs(px * vz - pz * vx) <= TOL && Math.abs(qx * vz - qz * vx) <= TOL) {
          const t0 = px * vx + pz * vz, t1 = qx * vx + qz * vz;
          const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(Lb, Math.max(t0, t1));
          if (hi - lo >= 0.3) {
            COVa[b] += hi - lo;
            if (hb[oa] < LOWa[b]) LOWa[b] = hb[oa];
            hit = true;
          }
        }
        if (hit && slab[oa] && slab[ob] && Math.abs(hb[oa] - hb[ob]) < 1.6 && up[oa] !== up[ob]) join(oa, ob);
      }
    }
  }
  return cell;
}

// write back per building (the edge cursor _e runs on from range to range)
function writeRange(k0, k1) {
  const buildings = _B;
  let e = _e;
  for (let k = k0; k < k1; k++) {
    const f = buildings[k], o = f.o;
    if (!o || o.length < 3) continue;
    let pw = null;
    for (let i = 0; i < o.length; i++, e++) {
      const L = LN[e];
      if (L && _cov[e] >= COVER * L) {
        pw ??= new Array(o.length).fill(0);
        pw[i] = Math.max(0.1, Math.round(_low[e] * 10) / 10);
      }
    }
    if (pw) f._pw = pw; else if (f._pw) delete f._pw;
  }
  _e = e;
}

// the slab's name: the smallest id among its sections
function slabNames() {
  const buildings = _B, nb = _nb, slab = _slabF, ids = _ids;
  const many = new Uint8Array(nb);
  for (let k = 0; k < nb; k++) if (root(k) !== k) many[root(k)] = 1;
  for (let k = 0; k < nb; k++) {
    const f = buildings[k], r = root(k);
    if (slab[k] && (r !== k || many[k])) f._slab = ids[r];
    else if (f._slab !== undefined) delete f._slab;
  }
}

// what the stamp says about one building (its corners, its shared edges) lives
// in js/partycorners.js; the roof and facade modules import it from here
export { partyOf, blockCorner, chamferCorner } from './partycorners.js';
