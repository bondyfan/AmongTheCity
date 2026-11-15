// ---- roofholes.js: the roof of a block built round its own courtyard ----
// Pure geometry like roofs.js (no three.js, no DOM): it runs in the mesh worker
// and in headless tests. A Prague palace or an Old Town house with a light well
// is one footprint with hole rings, and roofs.js roofCap used to fan its inset
// top over the whole outer ring, so 324 Prague courtyards (8.3 ha, measured)
// were roofed over and the yard walls stood in the dark under a tiled lid.
//
// Here every ring gets its own slope: the street eave climbs inward from the
// outer ring, and each courtyard eave climbs outward from its hole ring, the
// way a real perimeter block's two roof planes meet over the middle of the
// wing. The flat top between the two ridges is a polygon WITH holes, which
// only an ear clipper can cut, so the caller hands one in (opts.tri, a
// THREE.ShapeUtils wrapper in meshes.js; three exists in the worker too). With
// no clipper, or rings that fold through each other, this returns 0 and the
// caller lays its flat deck with the holes left open: a flat roof is honest,
// a lid over the yard is not.

import { polygonArea } from './geo.js';
import { insetRing, ringSelfIntersects } from './roofs.js';

const MAX_N = 200;                       // same bound as roofCap's simplicity test
// Slope depths tried, deepest first. A courtyard block is a ring of wings
// 8 to 14 m deep, and its real roof is two planes meeting over the middle of
// each wing; the deepest offset whose rings still clear each other is the
// nearest this construction gets to that ridge.
const DEPTHS = [7, 5.6, 4.5, 3.6, 2.8, 2.1, 1.5, 1.0, 0.6, 0.35];
// Old Town footprints are surveyed to the centimetre, jogs and all, and a 10 cm
// kink is where an inward offset folds through itself (202 of the 507 Prague
// courtyard roofs, measured). Vertices that stand less than this far off the
// line of their neighbours are dropped before the offset: the eave overhang
// (0.25 m and up on every pitched roof) hides the difference against the wall.
const SIMPLIFY = 0.15;
// Where even that leaves a ring that folds at every depth (142 Prague
// courtyard blocks stayed flat, measured: tiny jogs and slivers of wall), the
// outline is simplified harder before the block gives up its pitch. 0.5 m is
// the most: the eave overhangs the wall by 0.32 m, so a dropped kink can let
// the roof edge fall at worst 18 cm inside one corner of the wall, invisible
// from the street, where a flat deck over a palace is not.
const SIMPLIFY_RETRY = [0.3, 0.5];

const ringArea = (r) => Math.abs(polygonArea(r));

/** Share of the outer ring's area the courtyards take (0 for none). */
export function holeShare(f) {
  if (!f.i?.length) return 0;
  const A = ringArea(f.o);
  if (!(A > 0)) return 0;
  let h = 0;
  for (const r of f.i) if (r.length >= 3) h += ringArea(r);
  return h / A;
}
// Below this share, and under 30 m2, a hole is a light well nobody sees from
// the street, and the plain cap over it costs nothing; above it the yard is a
// place and must stay open.
export const HOLE_SHARE_MIN = 0.04;
export function hasCourtyard(f) {
  if (!f.i?.length) return false;
  if (holeShare(f) >= HOLE_SHARE_MIN) return true;
  for (const r of f.i) if (r.length >= 3 && ringArea(r) >= 30) return true;
  return false;
}

// Drop near-collinear and near-duplicate vertices (a new array; the footprint
// itself is shared with the walls and must not change).
export function simplifyRing(ring, tol) {
  const r = ring.slice();
  let changed = true;
  while (changed && r.length > 3) {
    changed = false;
    for (let i = 0; i < r.length && r.length > 3; i++) {
      const a = r[(i - 1 + r.length) % r.length], b = r[i], c = r[(i + 1) % r.length];
      const ex = c[0] - a[0], ez = c[1] - a[1], L = Math.hypot(ex, ez);
      const dev = L > 1e-6 ? Math.abs((b[0] - a[0]) * ez - (b[1] - a[1]) * ex) / L : 0;
      if (dev < tol || Math.hypot(b[0] - a[0], b[1] - a[1]) < 0.05) { r.splice(i, 1); changed = true; i--; }
    }
  }
  return r;
}

// Do two closed rings cross anywhere? O(n*m), bounded by MAX_N.
function ringsCross(a, b) {
  const side = (ox, oz, ax, az, bx, bz) => (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      const c = b[j], d = b[(j + 1) % b.length];
      const d1 = side(c[0], c[1], d[0], d[1], p[0], p[1]);
      const d2 = side(c[0], c[1], d[0], d[1], q[0], q[1]);
      const d3 = side(p[0], p[1], q[0], q[1], c[0], c[1]);
      const d4 = side(p[0], p[1], q[0], q[1], d[0], d[1]);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
  }
  return false;
}
function inside(x, z, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// One band of slope between an eave ring and its ridge ring. `away` is +1 when
// the slope faces away from the ring's interior (the street side of the outer
// ring) and -1 when it faces into it (a courtyard side of a hole ring).
function band(sink, ring, eave, ey, top, ry, d, rise, sgn, away, r, g, b, soffit, topY) {
  const n = ring.length;
  const ny = d / Math.hypot(d, rise), nh = rise / Math.hypot(d, rise);
  for (let i = 0; i < n; i++) {
    const [ax, az] = eave[i], [bx, bz] = eave[(i + 1) % n];
    const [cx, cz] = top[(i + 1) % n], [dx, dz] = top[i];
    const ex = ring[(i + 1) % n][0] - ring[i][0], ez = ring[(i + 1) % n][1] - ring[i][1];
    const el = Math.hypot(ex, ez);
    if (el < 1e-6) continue;
    const ox = ez / el * sgn * away, oz = -ex / el * sgn * away;
    const nx = ox * ny, nz = oz * ny;
    sink.triFacing(ax, ey, az, bx, ey, bz, cx, ry, cz, nx, nh, nz, r, g, b);
    sink.triFacing(ax, ey, az, cx, ry, cz, dx, ry, dz, nx, nh, nz, r, g, b);
    if (soffit && eave !== ring) {
      const [wx, wz] = ring[i], [vx, vz] = ring[(i + 1) % n];
      sink.triFacing(ax, ey, az, bx, ey, bz, vx, topY, vz, -nx, -nh, -nz, r * 0.6, g * 0.6, b * 0.6);
      sink.triFacing(ax, ey, az, vx, topY, vz, wx, topY, wz, -nx, -nh, -nz, r * 0.6, g * 0.6, b * 0.6);
    }
  }
}

/**
 * roofCapHoled(sink, outer, holes, topY, r, g, b, ov, soffit, tag, tri, pitch, retry) -> rise
 * The courtyard version of roofs.js roofCap: same depth, rise and tag rules,
 * one slope band per ring, and a flat top with the yards cut out of it.
 * `tri(outer, holes)` returns index triples into outer.concat(...holes).
 * Returns 0 (nothing emitted) when the roof cannot be built cleanly.
 */
export function roofCapHoled(sink, outer, holes, topY, r, g, b, ov, soffit, tag, tri, pitch = 0.78,
  retry = false) {
  if (!tri || outer.length < 3) return 0;
  // the gentlest simplification that gives clean rings wins (the first one is
  // the only one most blocks ever need, so their roofs are what they were);
  // the harder ones only where the caller asks (roofs.js: Prague's palaces)
  let P = capPlan(outer, holes, tag, tri, SIMPLIFY);
  for (let k = 0; retry && !P && P !== false && k < SIMPLIFY_RETRY.length; k++)
    P = capPlan(outer, holes, tag, tri, SIMPLIFY_RETRY[k]);
  if (!P) return 0;
  return capEmit(sink, P, topY, r, g, b, ov, soffit, tag, pitch);
}

// The rings of a courtyard roof at one simplification: the outline and yards,
// the ridge rings at the deepest depth that clears, and the top's triangles.
// null when the rings fold at every depth; false when no simplification can
// help (too many vertices, too little solid roof).
function capPlan(outer, holes, tag, tri, tol) {
  outer = simplifyRing(outer, tol);
  const hs = holes.filter((h) => h.length >= 3).map((h) => simplifyRing(h, tol));
  let total = outer.length;
  for (const h of hs) total += h.length;
  if (total > MAX_N) return false;
  const area = ringArea(outer);
  let solid = area;
  for (const h of hs) solid -= ringArea(h);
  if (!(solid > 20)) return false;
  const sgn = polygonArea(outer) > 0 ? 1 : -1;
  const hsg = hs.map((h) => (polygonArea(h) > 0 ? 1 : -1));
  // the wing, not the block, sets how deep a slope can go, so the depth is
  // searched (DEPTHS) rather than scaled from the area; a mansard or an attic
  // gives up only a little plan for a lot of height, as in roofCap
  let want = tag?.rise ?? 0;
  if (tag?.attic) want = Math.max(want, 2.9 * tag.attic);
  const dMax = tag?.steep || tag?.attic ? Math.max(1.1, (want || 3.4) * 0.5) : 7;
  let inner = null, grown = null, d = 0;
  for (const dd of DEPTHS) {
    if (dd > dMax) continue;
    d = dd;
    const cand = insetRing(outer, d, sgn);
    if (!cand) continue;
    const ia = polygonArea(cand);
    if (!(ia * sgn > 0) || Math.abs(ia) < area * 0.06 || Math.abs(ia) > area) continue;
    if (ringSelfIntersects(cand)) continue;
    // each yard grows by d into the solid (an inset with the sign turned)
    const gs = [];
    let ok = true;
    for (let i = 0; i < hs.length && ok; i++) {
      const gh = insetRing(hs[i], -d, hsg[i]);
      if (!gh || ringArea(gh) <= ringArea(hs[i]) || ringSelfIntersects(gh)) { ok = false; break; }
      if (!inside(gh[0][0], gh[0][1], cand) || ringsCross(gh, cand)) { ok = false; break; }
      for (const o of gs) if (ringsCross(gh, o) || inside(gh[0][0], gh[0][1], o)) { ok = false; break; }
      gs.push(gh);
    }
    if (!ok) continue;
    inner = cand; grown = gs;
    break;
  }
  if (!inner) return null;
  // the clipper first: if it cannot cut the top, nothing has been emitted yet
  let tris;
  try { tris = tri(inner, grown); } catch { tris = null; }
  if (!tris?.length) return null;
  return { outer, hs, hsg, sgn, inner, grown, d, want, tris };
}

function capEmit(sink, P, topY, r, g, b, ov, soffit, tag, pitch) {
  const { outer, hs, hsg, sgn, inner, grown, d, want, tris } = P;
  // the pitch of roofs.js ridgeRoof (about 38 degrees, at most 5 m) and its
  // steeper old-town grammar when the caller asks (opts.pitch, rise per metre)
  let rise = Math.min(pitch > 0.9 ? 8 : 5, Math.max(0.8, d * pitch));
  if (want) rise = Math.max(0.5, Math.min(want, d * 3.2));
  else if (tag?.steep) rise = Math.min(4.2, Math.max(rise, d * 2));
  else if (tag?.low) rise = Math.max(0.5, rise * 0.55);
  const ry = topY + rise;
  // eaves: outward past the street wall, and into the yard past the yard wall
  let eave = outer, ey = topY;
  if (ov > 0.05) {
    const out = insetRing(outer, -ov, sgn);
    if (out) { eave = out; ey = topY - ov * rise / d; }
  }
  band(sink, outer, eave, ey, inner, ry, d, rise, sgn, 1, r, g, b, soffit, topY);
  for (let i = 0; i < hs.length; i++) {
    let he = hs[i], hy = topY;
    if (ov > 0.05) {
      const into = insetRing(hs[i], ov, hsg[i]);
      if (into && ringArea(into) > ringArea(hs[i]) * 0.3 && !ringSelfIntersects(into)) {
        he = into; hy = topY - ov * rise / d;
      }
    }
    band(sink, hs[i], he, hy, grown[i], ry, d, rise, hsg[i], -1, r, g, b, soffit, topY);
  }
  const all = inner.concat(...grown);
  for (const [ia, ib, ic] of tris) {
    const A = all[ia], B = all[ib], C = all[ic];
    sink.triFacing(A[0], ry, A[1], B[0], ry, B[1], C[0], ry, C[1], 0, 1, 0, r, g, b);
  }
  return rise;
}
