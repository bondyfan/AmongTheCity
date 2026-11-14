// ---- roofgrammar.js: the Prague tenement's roof line ----
// Pure geometry (no three, no DOM), called by roofs.js roofInto, so the far
// tier, the near shell and the mesh worker all build the same thing. Three
// pieces of Gruenderzeit and baroque grammar that a plain extruded block with
// a hipped lid does not have:
//
//   the CORNICE, a real ledge 0.35 m proud of the street wall at the eave
//     (the painted band stays under it), only along walls that are not shared
//     with a neighbour, so a street of houses reads as one continuous moulding;
//   DORMERS, small gabled boxes standing on a slope, one every two window bays;
//   the CORNER TURRET, the octagonal oriel with a copper or slate cone that
//     marks a Vinohrady or Zizkov block corner.
//
// It also holds the decisions typology.roofOf takes for Prague (pragueRoof:
// steep old-town roofs, Gruenderzeit mansards, gables against neighbours).
//
// Tens of triangles a building, never on the far shell ring (opts.bare skips
// the builders). Everything is decided from the tile record, f._id and
// constants (salts 120..149), so every client builds the same street.

import { polygonArea } from './geo.js';
import { rnd, PIN_U, PIN_V } from './typology.js';
import { praguePlace, inOldTown } from './praguezone.js';
import { partyOf, blockCorner } from './partywalls.js';

const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
const linHex = (h) => [lin(h >> 16 & 255), lin(h >> 8 & 255), lin(h & 255)];
const PANE = [0.045, 0.07, 0.1];         // glass under a sky, as roofs.js skylights
const COPPER = linHex(0x6fa694), SLATE = linHex(0x4b4f57);
const GRAMMAR = new Set(['tenement', 'civic']);

/**
 * insetRingVar(ring, d, sgn, k): roofs.js insetRing with a per-edge factor:
 * edge i moves by d * k[i] (k 0 keeps it on the wall line). Each vertex is the
 * meeting point of its two offset edges. null where two edges meet so sharply
 * that the meeting point runs off (the caller then keeps its uniform roof).
 */
export function insetRingVar(ring, d, sgn, k) {
  const n = ring.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n];
    let ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return null;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    const d0 = d * k[(i - 1 + n) % n], d1 = d * k[i];
    // inward normals of the two edges, the convention of insetRing
    const n0x = -az * sgn, n0z = ax * sgn, n1x = -bz * sgn, n1z = bx * sgn;
    const cr = ax * bz - az * bx;
    if (Math.abs(cr) < 0.05) {
      // (nearly) straight on: the average offset, along the shared normal
      const m = (d0 + d1) / 2;
      out[i] = [c[0] + (n0x + n1x) / 2 * m, c[1] + (n0z + n1z) / 2 * m];
      continue;
    }
    // c + n0*d0 + a*t = c + n1*d1 + b*u, solved for t
    const rx = n1x * d1 - n0x * d0, rz = n1z * d1 - n0z * d0;
    const t = (rx * bz - rz * bx) / cr;
    if (Math.abs(t) > 4 * Math.max(Math.abs(d0), Math.abs(d1)) + 1e-9) return null;
    out[i] = [c[0] + n0x * d0 + ax * t, c[1] + n0z * d0 + az * t];
  }
  return out;
}

/** Per-edge inset factors for a cap roof: 0 on party walls, 1 elsewhere; null if none. */
export function capFactors(f) {
  if (!f._pw || f._pw.length !== f.o.length) return null;
  let any = false;
  const k = f._pw.map((h) => { if (h > 0) { any = true; return 0; } return 1; });
  // a ring that is party all round has nothing to lean in from
  return any && k.some((v) => v) ? k : null;
}

/** Does this building wear the Prague roof grammar at all? */
export const wearsGrammar = (f, typ) => GRAMMAR.has(typ) && praguePlace(f);

// ---- the decisions, read by typology.roofOf -------------------------------
// Prague's roof grammar, decided once in roofOf so every tier reads one answer
// (praguezone.js says where; roofs.js and the builders below build it):
//  - the old town's roofs are steep (`old`: about 50 degrees, roofs.js);
//  - nearly half the Gruenderzeit tenements of four storeys and up wear a
//    mansard, steep sides and an attic storey with its windows, half of them in
//    dark seamed sheet;
//  - a hipped end against a neighbour's wall is a gable, or a row of
//    terraced houses becomes a row of hips with a valley between each two.
const SHEET_HEX = [0x4b4f57, 0x545960, 0x5d6064, 0x464a50];
export function pragueRoof(f, typ, roof, S) {
  if (!praguePlace(f)) return;
  if (inOldTown(f)) { roof.old = true; return; }
  if (typ === 'tenement' && (f.lv ?? Math.max(1, Math.round((f.h ?? 6) / 3.1))) >= 4 && roof.shape !== 'mono' && roof.shape !== 'pyramid'
      && !(f.rl >= 0) && !(f.rh > 0) && rnd(f._id, 120) < 0.45) {
    roof.shape = 'cap'; roof.steep = true; roof.attic = 1;
    if (roof.src === 'proc' && rnd(f._id, 123) < 0.5) {
      roof.style = 'metal';
      roof.hex = SHEET_HEX[Math.floor(rnd(f._id, 124) * SHEET_HEX.length) % SHEET_HEX.length];
    }
    return;
  }
  if ((roof.shape === 'hip' || roof.shape === 'halfhip') && f._pw && f._pw.length === f.o.length) {
    // both ends of the ridge (the walls facing along the long axis) shared
    const ring = f.o, n = ring.length, sgn = polygonArea(ring) > 0 ? 1 : -1;
    const ends = [0, 0];
    const ax = S.L >= S.W ? S.ux : S.vx, az = S.L >= S.W ? S.uz : S.vz;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const ex = b[0] - a[0], ez = b[1] - a[1], el = Math.hypot(ex, ez);
      if (el < 1) continue;
      const d = (ez / el * sgn) * ax + (-ex / el * sgn) * az;
      if (Math.abs(d) < 0.9) continue;
      ends[d > 0 ? 0 : 1] += f._pw[i] > 0 ? el : -el;
    }
    if (ends[0] > 0 && ends[1] > 0) roof.shape = 'gable';
  }
}

// ---- the cornice ----------------------------------------------------------
// A ledge along every free outer edge: top, front and soffit faces (six
// triangles an edge). The offset ring gives clean mitres at the corners.
function cornice(sink, f, yT, wall) {
  const ring = f.o, n = ring.length;
  if (n > 80) return;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const D = 0.35, H = 0.45, yB = yT - H;
  const k = new Array(n).fill(1);
  const out = insetRingVar(ring, -D, sgn, k);
  if (!out) return;
  const [r, g, b] = wall;
  const lr = Math.min(1, r * 1.12), lg = Math.min(1, g * 1.12), lb = Math.min(1, b * 1.12);
  sink.pinTo?.(PIN_U, PIN_V);
  for (let i = 0; i < n; i++) {
    if (partyOf(f, i) > 0) continue;
    const a = ring[i], c = ring[(i + 1) % n], A = out[i], C = out[(i + 1) % n];
    const ex = c[0] - a[0], ez = c[1] - a[1], el = Math.hypot(ex, ez);
    if (el < 2) continue;
    const ox = ez / el * sgn, oz = -ex / el * sgn;          // outward horizontal
    // top, lit like the sky sees it
    sink.triFacing(a[0], yT, a[1], c[0], yT, c[1], C[0], yT, C[1], 0, 1, 0, lr, lg, lb);
    sink.triFacing(a[0], yT, a[1], C[0], yT, C[1], A[0], yT, A[1], 0, 1, 0, lr, lg, lb);
    // the face, the line you read from the street
    sink.triFacing(A[0], yT, A[1], C[0], yT, C[1], C[0], yB, C[1], ox, 0, oz, lr, lg, lb);
    sink.triFacing(A[0], yT, A[1], C[0], yB, C[1], A[0], yB, A[1], ox, 0, oz, lr, lg, lb);
    // the soffit, in its own shadow
    sink.triFacing(a[0], yB, a[1], C[0], yB, C[1], c[0], yB, c[1], 0, -1, 0, r * 0.6, g * 0.6, b * 0.6);
    sink.triFacing(a[0], yB, a[1], A[0], yB, A[1], C[0], yB, C[1], 0, -1, 0, r * 0.6, g * 0.6, b * 0.6);
  }
}

// ---- dormers ----------------------------------------------------------------
// On the two main slopes of a ridge roof (fr is roofs.js ridgeRoof's frame),
// one every 5.4 m between the hipped ends, skipped on a slope whose eave is a
// party wall. Eleven triangles each: front wall, pane, two cheeks, two roof
// planes and the little gable.
function sideIsParty(f, fr, s) {
  const ring = f.o, n = ring.length, sgn = polygonArea(ring) > 0 ? 1 : -1;
  let free = 0, party = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], c = ring[(i + 1) % n];
    const ex = c[0] - a[0], ez = c[1] - a[1], el = Math.hypot(ex, ez);
    if (el < 1) continue;
    const ox = ez / el * sgn, oz = -ex / el * sgn;
    if (ox * fr.bx * s + oz * fr.bz * s < 0.9) continue;     // faces this side
    if (partyOf(f, i) > 0) party += el; else free += el;
  }
  return party > free;
}
function dormers(sink, f, fr, topY, wall, roofRGB, id) {
  if (fr.mono || fr.tan < 0.55) return;
  const hw = fr.hw, tan = fr.tan;
  const inset = 0.9, hD = 1.45, w = 1.5;
  const back = inset + hD / tan;                  // where the dormer meets the slope
  if (inset + (hD + 0.55) / tan > hw - 0.4) return; // its ridge must die into the slope
  const span = (fr.hipped ? Math.max(0, fr.ra - 0.6) : fr.A - 1.4);
  const n = Math.min(6, Math.floor((2 * span) / 5.4));
  if (n < 1) return;
  const [wr, wg, wb] = wall, [rr, rg, rb] = roofRGB;
  const P = (a, bb, y) => [fr.cx + fr.ax * a + fr.bx * bb, y, fr.cz + fr.az * a + fr.bz * bb];
  const T = (p, q, r, nx, ny, nz, c0, c1, c2) =>
    sink.triFacing(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], nx, ny, nz, c0, c1, c2);
  for (const s of [-1, 1]) {
    if (sideIsParty(f, fr, s)) continue;
    // one in three roofs carries none on this side: not every attic is lived in
    if (rnd(id, s < 0 ? 121 : 122) < 0.3) continue;
    const bF = s * (hw - inset), bB = s * (hw - back);
    const yF = topY + inset * tan, yH = yF + hD, yR = yH + 0.55;
    const ox = fr.bx * s, oz = fr.bz * s;                  // outward, across the ridge
    for (let j = 0; j < n; j++) {
      const a = ((j + 0.5) / n - 0.5) * 2 * span;
      const L = a - w / 2, R = a + w / 2;
      sink.pinTo?.(PIN_U, PIN_V);
      // front wall and its window
      T(P(L, bF, yF), P(R, bF, yF), P(R, bF, yH), ox, 0, oz, wr, wg, wb);
      T(P(L, bF, yF), P(R, bF, yH), P(L, bF, yH), ox, 0, oz, wr, wg, wb);
      const e = 0.03 * s, pl = a - 0.42, pr = a + 0.42;
      T(P(pl, bF + e, yF + 0.25), P(pr, bF + e, yF + 0.25), P(pr, bF + e, yH - 0.2), ox, 0, oz, ...PANE);
      T(P(pl, bF + e, yF + 0.25), P(pr, bF + e, yH - 0.2), P(pl, bF + e, yH - 0.2), ox, 0, oz, ...PANE);
      // the cheeks, down to the slope
      for (const [x, sg] of [[L, -1], [R, 1]])
        T(P(x, bF, yF), P(x, bF, yH), P(x, bB, yH), fr.ax * sg, 0, fr.az * sg, wr * 0.85, wg * 0.85, wb * 0.85);
      // the gable over the window
      T(P(L, bF, yH), P(R, bF, yH), P(a, bF, yR), ox, 0, oz, wr, wg, wb);
      // and its two little roof planes, from a hand's breadth past the front
      // back to where each edge dies into the main slope (eave and ridge
      // meet it at different depths, so each runs to its own)
      const bO = bF + s * 0.15, yE = yH - 0.1;
      const bE = s * (hw - (yE - topY) / tan), bR = s * (hw - (yR - topY) / tan);
      for (const [x, sg] of [[L - 0.12, -1], [R + 0.12, 1]]) {
        const nx = fr.ax * sg * 0.75, nz = fr.az * sg * 0.75;
        T(P(x, bO, yE), P(a, bO, yR), P(a, bR, yR), nx, 0.66, nz, rr, rg, rb);
        T(P(x, bO, yE), P(a, bR, yR), P(x, bE, yE), nx, 0.66, nz, rr, rg, rb);
      }
    }
  }
}

// ---- the corner turret --------------------------------------------------------
// At the block corner (partywalls.blockCorner: a convex corner whose two walls
// are both free, at least 7 m long, meeting at 60..120 degrees): an octagonal
// oriel from two storeys under the eave to over the roof line, a pane per
// storey on its outward faces, and a cone.
function turret(sink, f, i, topY, sH, wall, id, rise) {
  const ring = f.o, n = ring.length, sgn = polygonArea(ring) > 0 ? 1 : -1;
  const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n];
  const la = Math.hypot(c[0] - p[0], c[1] - p[1]), lb = Math.hypot(q[0] - c[0], q[1] - c[1]);
  // outward along the corner's bisector, so the oriel stands proud of both walls
  const o0x = (c[1] - p[1]) / la * sgn, o0z = -(c[0] - p[0]) / la * sgn;
  const o1x = (q[1] - c[1]) / lb * sgn, o1z = -(q[0] - c[0]) / lb * sgn;
  let mx = o0x + o1x, mz = o0z + o1z;
  const ml = Math.hypot(mx, mz) || 1;
  mx /= ml; mz /= ml;
  const R = 1.8, cx = c[0] + mx * 0.7, cz = c[1] + mz * 0.7;
  // over a pitched roof it stands clear of the slope; over a flat one it is
  // the parapet's height and the cone
  const y0 = topY - 2 * sH, y1 = topY + rise, yC = y1 + 3.2;
  const [wr, wg, wb] = wall;
  const cap = rnd(id, 131) < 0.6 ? COPPER : SLATE;
  const V = [];
  for (let k = 0; k < 8; k++) {
    const t = (k + 0.5) / 8 * Math.PI * 2;
    V.push([cx + Math.cos(t) * R, cz + Math.sin(t) * R]);
  }
  sink.pinTo?.(PIN_U, PIN_V);
  for (let k = 0; k < 8; k++) {
    const A = V[k], B = V[(k + 1) % 8];
    const nx = (A[0] + B[0]) / 2 - cx, nz = (A[1] + B[1]) / 2 - cz;
    sink.triFacing(A[0], y0, A[1], B[0], y0, B[1], B[0], y1, B[1], nx, 0, nz, wr, wg, wb);
    sink.triFacing(A[0], y0, A[1], B[0], y1, B[1], A[0], y1, A[1], nx, 0, nz, wr, wg, wb);
    // underside, and the cone
    sink.triFacing(cx, y0, cz, A[0], y0, A[1], B[0], y0, B[1], 0, -1, 0, wr * 0.55, wg * 0.55, wb * 0.55);
    const nl = Math.hypot(nx, nz) || 1;
    sink.triFacing(A[0], y1, A[1], B[0], y1, B[1], cx, yC, cz, nx / nl * 0.87, 0.5, nz / nl * 0.87,
      cap[0], cap[1], cap[2]);
    // a pane per storey on the faces that look out of the block
    if (nx * mx + nz * mz < -0.2) continue;
    const ux = (B[0] - A[0]) / 2, uz = (B[1] - A[1]) / 2, px = nx / nl * 0.03, pz = nz / nl * 0.03;
    const mxp = (A[0] + B[0]) / 2 + px, mzp = (A[1] + B[1]) / 2 + pz;
    for (let s = 0; s < 2; s++) {
      const yb = y0 + s * sH + sH * 0.25, yt = y0 + s * sH + sH * 0.8;
      const ax = mxp - ux * 0.55, az = mzp - uz * 0.55, bx = mxp + ux * 0.55, bz = mzp + uz * 0.55;
      sink.triFacing(ax, yb, az, bx, yb, bz, bx, yt, bz, nx, 0, nz, ...PANE);
      sink.triFacing(ax, yb, az, bx, yt, bz, ax, yt, az, nx, 0, nz, ...PANE);
    }
  }
}

/**
 * roofGrammar(sink, f, typ, roof, topY, wallRGB, fr, roofRGB, storeys)
 * Everything above. `fr` is the ridge frame when a ridge roof was built.
 */
export function roofGrammar(sink, f, typ, roof, topY, wallRGB, fr, roofRGB, storeys) {
  if (!wearsGrammar(f, typ)) return;
  const id = f._id ?? 0;
  const pitched = roof.shape !== 'flat';
  const lv = storeys ?? f.lv ?? 3;
  // the cornice sits under the eave of a pitched roof, at the coping of a flat one
  const yT = pitched ? topY - Math.min(0.4, (roof.ov ?? 0) * (fr?.tan ?? 0.8) + 0.05) : topY;
  if (lv >= 3) cornice(sink, f, yT, wallRGB);
  if (fr && !fr.mono && typ === 'tenement' && lv >= 3) dormers(sink, f, fr, topY, wallRGB, roofRGB, id);
  if (typ === 'tenement' && lv >= 4 && !inOldTown(f) && rnd(id, 130) < 0.4) {
    const i = blockCorner(f);
    const sH = Math.min(3.6, Math.max(2.8, (f.h ?? 3.1 * lv) / Math.max(1, lv)));
    if (i >= 0) turret(sink, f, i, topY, sH, wallRGB, id, pitched ? 2.6 : 0.8);
  }
  sink.pinTo?.(PIN_U, PIN_V);
}
