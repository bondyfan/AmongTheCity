// ---- roofs.js: every roof shape the city wears, as triangles into a sink ----
// Pure geometry: no three.js, no DOM. A "sink" is anything with tri(), quad()
// and triFacing() (meshes.js's TriSink); a sink that can texture roofs also has
// pinTo(u, v), which names the atlas cell every following triangle samples.
//
// One function, roofInto(), builds the roof of one building for BOTH tiers: the
// chunk mesh calls it straight into the chunk's batch, and roofGeometry() calls
// it into a private sink for the near shell. So the two cannot disagree about a
// ridge, an eave or where the chimney stands.

import { polygonArea } from './geo.js';
import { shapeOf, roofFurniture, roofPin, PIN_U, PIN_V } from './typology.js';

const lin = (v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
/** 0xrrggbb (sRGB) -> [r, g, b] in linear light, what a vertex colour holds */
export const linRGB = (hex) => [lin(hex >> 16 & 255), lin(hex >> 8 & 255), lin(hex & 255)];

const ROOF_MAX_N = 200;                   // bounds the O(n2) simplicity test
const ROOF_STEPS = [1, 0.5, 0.25, 0.125]; // depth fractions tried, deepest first

// Offset one ring by d along each vertex's angle bisector (d > 0 inward).
// Returns null for geometry that cannot be offset at all (a repeated vertex, a
// 180 degree spike); the CALLER decides whether the result is usable.
export function insetRing(ring, d, sgn) {
  const n = ring.length, out = new Array(n);
  for (let i = 0; i < n; i++) {
    const [px, pz] = ring[(i - 1 + n) % n], [cx, cz] = ring[i], [nx2, nz2] = ring[(i + 1) % n];
    let ax = cx - px, az = cz - pz, bx = nx2 - cx, bz = nz2 - cz;
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) return null;
    ax /= la; az /= la; bx /= lb; bz /= lb;
    // inward normals of the two edges meeting here, and their bisector
    const n1x = -az * sgn, n1z = ax * sgn, n2x = -bz * sgn, n2z = bx * sgn;
    let mx = n1x + n2x, mz = n1z + n2z;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-3) return null;
    mx /= ml; mz /= ml;
    // the bisector travels 1/cos(half-angle) so both eaves stay parallel at
    // distance d; the clamp stops a sharp corner shooting off to infinity
    const k = Math.min(4, 1 / Math.max(0.25, (mx * n1x + mz * n1z)));
    out[i] = [cx + mx * d * k, cz + mz * d * k];
  }
  return out;
}

// Does a closed ring cross itself? The area and winding guards do not catch a
// ring that folded through a thin wing (over the real Prague footprints they
// pass 7 603 rings that are knots), so the simplicity test has to be explicit.
export function ringSelfIntersects(ring) {
  const n = ring.length;
  const side = (ox, oz, ax, az, bx, bz) => (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;     // shares the closing vertex
      const c = ring[j], dd = ring[(j + 1) % n];
      const d1 = side(c[0], c[1], dd[0], dd[1], a[0], a[1]);
      const d2 = side(c[0], c[1], dd[0], dd[1], b[0], b[1]);
      const d3 = side(a[0], a[1], b[0], b[1], c[0], c[1]);
      const d4 = side(a[0], a[1], b[0], b[1], dd[0], dd[1]);
      if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
    }
  }
  return false;
}

// A roof by inward offset: every eave vertex slides along its own angle
// bisector toward the interior by `d`, and the band between the original ring
// and the shrunken one becomes the slope. On a rectangle that is a hipped roof;
// on an L it is a hipped roof that turns the corner; on a courtyard block it is
// a mansard that follows all four wings, which is Prague's roofscape.
//
// Concave corners are where naive offsetting self-intersects, so the result is
// CHECKED rather than trusted: a ridge that folded through itself shows up as a
// collapsed or sign-flipped area, and the building simply keeps its flat top.
// Better a flat roof than a knot of triangles over Vinohrady.
//
// `ov` hangs the eave out past the wall (and a little below its top, on the
// same slope). Returns the rise it built, 0 if the building stays flat.
// `tag` is the tagged geometry of typology.roofOf, when there is any: `rise`
// (roof:height), `attic` storeys under the roof, `low`, and `steep` for a
// mansard, whose slope stands up instead of leaning in.
export function roofCap(sink, ring, topY, area, r, g, b, ov = 0, soffit = false, tag = null) {
  const n = ring.length;
  if (n < 3 || n > ROOF_MAX_N) return 0;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;   // which side of an edge is inside
  // Slope depth scales with the footprint, capped so a 2 000 m2 block does not
  // grow a cathedral. But a block with a 6 m wing cannot give up 3.5 m from
  // both sides of it, and the naive offset answers that by folding through
  // itself (measured over the real data, at full depth that is 55 % of
  // Prague's big pitched blocks). So the depth STEPS DOWN until the ring comes
  // back simple, which rescues nine in ten of them; the rest stay flat.
  let d0 = Math.min(3.5, Math.max(1.2, Math.sqrt(area) / 7));
  // what the tags want the rise to be, if they say (decided before the depth:
  // a mansard gives up only a little plan for a lot of height)
  let want = tag?.rise ?? 0;
  if (tag?.attic) want = Math.max(want, 2.9 * tag.attic);
  if (tag?.steep || tag?.attic) d0 = Math.min(d0, Math.max(1.1, (want || 3.4) * 0.5));
  let inner = null, d = 0;
  for (const f of ROOF_STEPS) {
    d = d0 * f;
    const cand = insetRing(ring, d, sgn);
    if (!cand) continue;
    const ia = polygonArea(cand);
    if (!(ia * sgn > 0) || Math.abs(ia) < area * 0.06 || Math.abs(ia) > area) continue;
    if (ringSelfIntersects(cand)) continue;
    inner = cand;
    break;
  }
  if (!inner) return 0;
  // rise follows the depth that actually survived: a 0.4 m lip with a 4 m
  // rise would be a spike, not a roof
  let rise = Math.min(4.2, Math.max(0.8, d * 1.15));
  // a tagged height is kept in proportion to the depth that survived, so a
  // wing that could only give up 40 cm does not grow a 6 m blade
  if (want) rise = Math.max(0.5, Math.min(want, d * 3.2));
  else if (tag?.steep) rise = Math.min(4.2, Math.max(rise, d * 2));
  else if (tag?.low) rise = Math.max(0.5, rise * 0.55);
  const ry = topY + rise;
  let late = null;
  // the eave: the same slope carried `ov` outward, so it ends below the wall top
  let eave = ring, ey = topY;
  if (ov > 0.05) {
    const out = insetRing(ring, -ov, sgn);
    if (out) { eave = out; ey = topY - ov * rise / d; }
  }
  for (let i = 0; i < n; i++) {
    const [ax, az] = eave[i], [bx, bz] = eave[(i + 1) % n];
    const [cx2, cz2] = inner[(i + 1) % n], [dx2, dz2] = inner[i];
    // outward-and-up normal of the slope, from the eave edge and the rise
    const ex = ring[(i + 1) % n][0] - ring[i][0], ez = ring[(i + 1) % n][1] - ring[i][1];
    const el = Math.hypot(ex, ez);
    if (el < 1e-6) continue;
    const ox = ez / el * sgn, oz = -ex / el * sgn;   // outward horizontal
    const ny = d / Math.hypot(d, rise), nh = rise / Math.hypot(d, rise);
    const nx3 = ox * ny, nz3 = oz * ny;
    sink.triFacing(ax, ey, az, bx, ey, bz, cx2, ry, cz2, nx3, nh, nz3, r, g, b);
    sink.triFacing(ax, ey, az, cx2, ry, cz2, dx2, ry, dz2, nx3, nh, nz3, r, g, b);
    // the attic's windows, on the wall edge's own length of slope (laid last:
    // they are pinned to the plain texel, the slopes to the roof's)
    if (tag?.attic && rise >= 2.2)
      (late ??= []).push([ring[i][0], topY, ring[i][1], ex / el, 0, ez / el, el,
        -ox * d, rise, -oz * d, nx3, nh, nz3]);
    if (soffit && eave !== ring) {
      // the underside of the overhang: what you see of a roof from its own pavement
      const [wx, wz] = ring[i], [vx, vz] = ring[(i + 1) % n];
      sink.triFacing(ax, ey, az, bx, ey, bz, vx, topY, vz, -nx3, -nh, -nz3, r * 0.6, g * 0.6, b * 0.6);
      sink.triFacing(ax, ey, az, vx, topY, vz, wx, topY, wz, -nx3, -nh, -nz3, r * 0.6, g * 0.6, b * 0.6);
    }
  }
  // the flat top of the mansard, fanned from the first inner vertex: convex
  // enough after the area guard, and it is only ever seen from the air. The
  // facing hint is straight up whatever the ring's winding: triFacing flips the
  // triangle to match it, and a roof that faces down renders black.
  for (let i = 1; i < n - 1; i++)
    sink.triFacing(inner[0][0], ry, inner[0][1], inner[i][0], ry, inner[i][1],
      inner[i + 1][0], ry, inner[i + 1][1], 0, 1, 0, r, g, b);
  if (late) for (const a of late) skylights(sink, ...a);
  return rise;
}

// Roof windows: what an attic storey (roof:levels) shows of itself from the
// street and from the air. Dark panes lying 4 cm proud of one slope, a row of
// them along the eave edge that starts at (x, y, z), runs `len` metres along
// the unit vector e, and climbs the slope by the vector (sx, sy, sz) from eave
// to ridge. (nx, ny, nz) is the slope's normal. Pinned to the plain texel:
// glass has no courses.
const PANE = [0.045, 0.07, 0.1];          // 0x3b4a59 in linear light: glass under a sky
function skylights(sink, x, y, z, ex, ey, ez, len, sx, sy, sz, nx, ny, nz) {
  const sl = Math.hypot(sx, sy, sz);
  if (len < 3.2 || sl < 2.4) return;
  const n = Math.min(6, Math.max(1, Math.round(len / 3.6)));
  const hw = 0.36, hh = Math.min(0.52, sl * 0.18);
  const ux = sx / sl, uy = sy / sl, uz = sz / sl;
  const nl = Math.hypot(nx, ny, nz) || 1;
  const px = nx / nl * 0.04, py = ny / nl * 0.04, pz = nz / nl * 0.04;
  sink.pinTo?.(PIN_U, PIN_V);
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n * len, m = sl * 0.46;
    const cx = x + ex * t + ux * m + px, cy = y + ey * t + uy * m + py, cz = z + ez * t + uz * m + pz;
    const ax = ex * hw, ay = ey * hw, az = ez * hw, bx = ux * hh, by = uy * hh, bz = uz * hh;
    sink.triFacing(cx - ax - bx, cy - ay - by, cz - az - bz, cx + ax - bx, cy + ay - by, cz + az - bz,
      cx + ax + bx, cy + ay + by, cz + az + bz, nx, ny, nz, PANE[0], PANE[1], PANE[2]);
    sink.triFacing(cx - ax - bx, cy - ay - by, cz - az - bz, cx + ax + bx, cy + ay + by, cz + az + bz,
      cx - ax + bx, cy - ay + by, cz - az + bz, nx, ny, nz, PANE[0], PANE[1], PANE[2]);
  }
}

// The ridge family: gable (q = 0), half-hip (q about 0.45), hip (q = 1) and
// pyramid, all one construction over the footprint's bounding box. `q` is how
// much of each gable end is hipped back. The slopes hang `ov` past the walls
// (with a soffit under them when asked), and the gable ends are WALL (plaster,
// in the wall's colour), which the old prism painted in roof colour.
// Returns { rise, tan, hw, ax, az, bx, bz, cx, cz } for the chimneys.
function ridgeRoof(sink, S, topY, q, ov, rr, wall, pyramid, soffit, tag) {
  // ridge along the longer side of the box, unless the tags turn it
  const along = (S.L >= S.W) !== !!tag?.swap;
  const ax = along ? S.ux : S.vx, az = along ? S.uz : S.vz;       // ridge direction
  const bx = along ? S.vx : S.ux, bz = along ? S.vz : S.uz;       // across
  const hl = (along ? S.L : S.W) / 2, hw = (along ? S.W : S.L) / 2;
  const cx = S.ux * S.cu + S.vx * S.cv, cz = S.uz * S.cu + S.vz * S.cv;
  if (hl < 0.5 || hw < 0.5) return null;
  let rise = Math.min(5, Math.max(1.0, hw * (q >= 1 ? 0.7 : 0.78)));
  // tagged: the surveyed height; an attic storey needs about 45 degrees and
  // three metres to stand up in; a roof over nothing is a low one
  if (tag?.rise) rise = Math.max(0.3, tag.rise);
  else if (tag?.attic) rise = Math.max(rise, Math.min(hw * 1.15, 3.2 * tag.attic, 9));
  else if (tag?.low) rise = Math.max(0.6, rise * 0.55);
  const tan = rise / hw;
  const W2 = hw + ov, yE = topY - ov * tan, R2 = rise + ov * tan, yR = yE + R2;
  const oa = q >= 1 ? ov : Math.min(ov, 0.3);                     // overhang at the ends
  const A = hl + oa;
  const qq = pyramid ? 1 : q;
  const yC = yE + R2 * (1 - qq);
  const ra = pyramid ? 0 : Math.max(0, A - qq * W2);              // ridge half-length
  const P = (a, b) => [cx + ax * a + bx * b, cz + az * a + bz * b];
  const [r, g, b] = rr;
  const poly = (pts, nx, ny, nz, k = 1) => {
    for (let i = 1; i < pts.length - 1; i++)
      sink.triFacing(pts[0][0], pts[0][1], pts[0][2], pts[i][0], pts[i][1], pts[i][2],
        pts[i + 1][0], pts[i + 1][1], pts[i + 1][2], nx, ny, nz, r * k, g * k, b * k);
  };
  const v3 = (a, bb, y) => { const p = P(a, bb); return [p[0], y, p[1]]; };
  let late = null;
  for (const s of [-1, 1]) {
    // one main slope: eave, up the end to the hip cut, along the ridge and back
    const pts = [v3(-A, s * W2, yE), v3(A, s * W2, yE)];
    const cut = qq > 0.02 && qq < 1;
    if (cut) pts.push(v3(A, s * qq * W2, yC));
    pts.push(v3(ra, 0, yR));
    if (ra > 1e-3) pts.push(v3(-ra, 0, yR));
    if (cut) pts.push(v3(-A, s * qq * W2, yC));
    poly(pts, s * bx * tan, 1, s * bz * tan);
    if (tag?.attic && rise >= 2.2) {
      // the attic's windows, between the hipped ends (laid last: they are
      // pinned to the plain texel)
      const h0 = cut || qq >= 1 ? ra : A - 0.6;
      if (h0 > 1.6) {
        const e0 = v3(-h0, s * hw, topY);
        (late ??= []).push([e0[0], e0[1], e0[2], ax, 0, az, 2 * h0, -s * bx * hw, rise, -s * bz * hw,
          s * bx * tan, 1, s * bz * tan]);
      }
    }
    if (soffit && ov > 0.05)                        // the soffit under the eave
      poly([v3(-A, s * W2, yE), v3(A, s * W2, yE), v3(A, s * hw, topY), v3(-A, s * hw, topY)],
        -s * bx * tan, -1, -s * bz * tan, 0.55);
    // the hipped part of each end
    if (qq > 0.02)
      poly([v3(s * A, -qq * W2, yC), v3(s * A, qq * W2, yC), v3(s * ra, 0, yR)],
        s * ax * tan, 1, s * az * tan);
    if (soffit && qq >= 0.95 && ov > 0.05)          // and the soffit of a full hip
      poly([v3(s * A, -W2, yE), v3(s * A, W2, yE), v3(s * hl, hw, topY), v3(s * hl, -hw, topY)],
        -s * ax * tan, -1, -s * az * tan, 0.55);
  }
  // gable walls, up to where the hip starts
  if (qq < 0.95 && wall) {
    sink.pinTo?.(PIN_U, PIN_V);
    const [wr, wg, wb] = wall;
    const cut = Math.min(hw, qq * W2), yW = topY + (yC - topY) * (hw > cut ? 1 : 0);
    for (const s of [-1, 1]) {
      const p0 = v3(s * hl, -hw, topY), p1 = v3(s * hl, hw, topY);
      const p2 = v3(s * hl, cut, qq < 0.02 ? yR : yW), p3 = v3(s * hl, -cut, qq < 0.02 ? yR : yW);
      sink.triFacing(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], s * ax, 0, s * az, wr, wg, wb);
      if (qq >= 0.02)
        sink.triFacing(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], s * ax, 0, s * az, wr, wg, wb);
    }
  }
  if (late) for (const a of late) skylights(sink, ...a);
  // A, ra and yC describe the hipped ends, so a chimney can find the roof under it
  return { rise, tan, hw, W2, yE, R2, ax, az, bx, bz, cx, cz, A, ra, yC, hipped: qq > 0.02 };
}

// One slope across the short side: the lean-to and the modern monopitch.
function monoRoof(sink, S, topY, ov, rr, wall, tag) {
  const along = (S.L >= S.W) !== !!tag?.swap;
  const ax = along ? S.ux : S.vx, az = along ? S.uz : S.vz;
  // the slope falls toward -b: a tagged roof:direction can turn that round
  const fs = tag?.flip ? -1 : 1;
  const bx = (along ? S.vx : S.ux) * fs, bz = (along ? S.vz : S.uz) * fs;
  const hl = (along ? S.L : S.W) / 2, hw = (along ? S.W : S.L) / 2;
  const cx = S.ux * S.cu + S.vx * S.cv, cz = S.uz * S.cu + S.vz * S.cv;
  const rise = tag?.rise ? Math.min(8, Math.max(0.2, tag.rise))
    : Math.min(3, Math.max(0.6, hw * 2 * 0.22)) * (tag?.low ? 0.55 : 1);
  const tan = rise / (2 * hw);
  const v3 = (a, bb, y) => [cx + ax * a + bx * bb, y, cz + az * a + bz * bb];
  const A = hl + Math.min(ov, 0.3), lo = v3(0, -hw - ov, topY - ov * tan)[1], hi = topY + rise + ov * tan;
  const [r, g, b] = rr;
  const q = (p0, p1, p2, p3, nx, ny, nz, cr, cg, cb) => {
    sink.triFacing(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], nx, ny, nz, cr, cg, cb);
    sink.triFacing(p0[0], p0[1], p0[2], p2[0], p2[1], p2[2], p3[0], p3[1], p3[2], nx, ny, nz, cr, cg, cb);
  };
  q(v3(-A, -hw - ov, lo), v3(A, -hw - ov, lo), v3(A, hw + ov, hi), v3(-A, hw + ov, hi), -bx * tan, 1, -bz * tan, r, g, b);
  q(v3(-A, -hw - ov, lo), v3(A, -hw - ov, lo), v3(A, hw + ov, hi), v3(-A, hw + ov, hi), bx * tan, -1, bz * tan, r * 0.55, g * 0.55, b * 0.55);
  if (wall) {
    sink.pinTo?.(PIN_U, PIN_V);
    const [wr, wg, wb] = wall;
    // the tall wall under the high edge, and the two wedges at the ends
    q(v3(-hl, hw, topY), v3(hl, hw, topY), v3(hl, hw, topY + rise), v3(-hl, hw, topY + rise), bx, 0, bz, wr, wg, wb);
    for (const s of [-1, 1]) {
      const p0 = v3(s * hl, -hw, topY), p1 = v3(s * hl, hw, topY), p2 = v3(s * hl, hw, topY + rise);
      sink.triFacing(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2], s * ax, 0, s * az, wr, wg, wb);
    }
  }
  return { rise, tan: rise / hw, hw, W2: hw, yE: topY, R2: rise * 0.5, ax, az, bx, bz, cx, cz, mono: true };
}

// A box standing on the roof: four sides and a lid, shaded by hand a little so
// it does not read as a flat-coloured decal from above.
function boxInto(sink, x, z, ux, uz, hu, hv, y0, y1, hex) {
  const [r, g, b] = linRGB(hex);
  const vx = uz, vz = -ux;
  const c = (su, sv) => [x + ux * hu * su + vx * hv * sv, z + uz * hu * su + vz * hv * sv];
  const p = [c(-1, -1), c(1, -1), c(1, 1), c(-1, 1)];
  const nrm = [[-vx, -vz], [ux, uz], [vx, vz], [-ux, -uz]];
  for (let i = 0; i < 4; i++) {
    const a = p[i], bb = p[(i + 1) % 4], k = 0.82 + 0.1 * (i % 2);
    sink.triFacing(a[0], y1, a[1], bb[0], y1, bb[1], bb[0], y0, bb[1], nrm[i][0], 0, nrm[i][1], r * k, g * k, b * k);
    sink.triFacing(a[0], y1, a[1], bb[0], y0, bb[1], a[0], y0, a[1], nrm[i][0], 0, nrm[i][1], r * k, g * k, b * k);
  }
  sink.triFacing(p[0][0], y1, p[0][1], p[1][0], y1, p[1][1], p[2][0], y1, p[2][1], 0, 1, 0, r, g, b);
  sink.triFacing(p[0][0], y1, p[0][1], p[2][0], y1, p[2][1], p[3][0], y1, p[3][1], 0, 1, 0, r, g, b);
}

// A parapet with thickness: the top strip and the inner face. The OUTER face is
// the wall itself (ringFacade carries the facade up), so this is only what you
// see from above. Skipped when the ring cannot be inset cleanly.
export function parapetInto(sink, ring, topY, h, t, wall) {
  const n = ring.length;
  if (n > 60) return;
  const sgn = polygonArea(ring) > 0 ? 1 : -1;
  const inner = insetRing(ring, t, sgn);
  if (!inner || ringSelfIntersects(inner)) return;
  const [r, g, b] = wall, y = topY + h;
  for (let i = 0; i < n; i++) {
    const a = ring[i], bb = ring[(i + 1) % n], c = inner[(i + 1) % n], d = inner[i];
    const ex = bb[0] - a[0], ez = bb[1] - a[1], el = Math.hypot(ex, ez);
    if (el < 0.05) continue;
    const ix = -ez / el * sgn, iz = ex / el * sgn;     // inward horizontal
    sink.triFacing(a[0], y, a[1], bb[0], y, bb[1], c[0], y, c[1], 0, 1, 0, r * 0.95, g * 0.95, b * 0.95);
    sink.triFacing(a[0], y, a[1], c[0], y, c[1], d[0], y, d[1], 0, 1, 0, r * 0.95, g * 0.95, b * 0.95);
    sink.triFacing(d[0], y, d[1], c[0], y, c[1], c[0], topY, c[1], ix, 0, iz, r * 0.7, g * 0.7, b * 0.7);
    sink.triFacing(d[0], y, d[1], c[0], topY, c[1], d[0], topY, d[1], ix, 0, iz, r * 0.7, g * 0.7, b * 0.7);
  }
}

/**
 * roofInto(sink, f, typ, roof, topY, wallRGB, storeys, opts)
 * The whole roof of one building above its wall top: the pitched shape (flat
 * roofs build nothing here, their deck is the caller's cap) and the furniture.
 * `roof` is typology.roofOf(f). opts.soffit also closes the underside of the
 * eaves and caps the chimneys, detail only the near shell is ever close enough
 * to show (the far mesh saves about a tenth of its triangles without it); opts.bare
 * leaves the furniture off (the far shell ring, seen from an aircraft).
 * Returns true when a pitched roof now covers the building.
 */
export function roofInto(sink, f, typ, roof, topY, wallRGB, storeys, opts) {
  const S = shapeOf(f), rr = linRGB(roof.hex);
  let fr = null, capRise = 0;
  const pin = roofPin(roof.style);
  sink.pinTo?.(pin[0], pin[1]);
  // the tagged geometry, when the tile carries any (typology.roofOf)
  const tag = roof.rise || roof.attic || roof.low || roof.swap || roof.flip || roof.steep ? roof : null;
  if (roof.shape === 'cap') {
    capRise = roofCap(sink, f.o, topY, S.area, rr[0], rr[1], rr[2], roof.ov, !!opts?.soffit, tag);
  } else if (roof.shape === 'mono') {
    fr = monoRoof(sink, S, topY, roof.ov, rr, wallRGB, tag);
  } else if (roof.shape !== 'flat') {
    const q = roof.shape === 'hip' ? 1 : roof.shape === 'halfhip' ? 0.45 : 0;
    fr = ridgeRoof(sink, S, topY, q, roof.ov, rr, wallRGB, roof.shape === 'pyramid',
      !!opts?.soffit, tag);
  }
  sink.pinTo?.(PIN_U, PIN_V);
  const pitched = roof.shape !== 'flat';
  const built = pitched && !!(fr || capRise);
  // a pitched roof that could not be built leaves the caller's flat deck showing
  if ((pitched && !built) || opts?.bare) return built;
  for (const it of roofFurniture(f, typ, roof, storeys)) {
    const pu = S.cu + it.u, pv = S.cv + it.v;
    const x = pu * S.ux + pv * S.vx, z = pu * S.uz + pv * S.vz;
    if (it.k === 'chimney') {
      if (fr?.mono) continue;
      let base = topY, top = topY + capRise + 0.7;
      if (fr) {
        // how far across the slope this stack stands, and the roof under it
        const bb = Math.abs((x - fr.cx) * fr.bx + (z - fr.cz) * fr.bz);
        base = fr.yE + fr.R2 * (1 - Math.min(1, bb / fr.W2));
        // Near a hipped end the roof under the stack is the END slope, which is
        // lower than the main one: measured from the main slope alone, a stack
        // on a pyramid roof hung up to 0.8 m in the air.
        if (fr.hipped && fr.A - fr.ra > 1e-3) {
          const aa = Math.abs((x - fr.cx) * fr.ax + (z - fr.cz) * fr.az);
          const yR = fr.yE + fr.R2;
          base = Math.min(base, fr.yC + (yR - fr.yC) * Math.max(0, (fr.A - aa) / (fr.A - fr.ra)));
        }
        base -= 0.35;
        top = fr.yE + fr.R2 + 0.45;
      }
      boxInto(sink, x, z, S.ux, S.uz, it.w / 2, it.d / 2, base, top, it.hex);
      // the cap stone, only where somebody can get close enough to see it
      if (opts?.soffit)
        boxInto(sink, x, z, S.ux, S.uz, it.w / 2 + 0.06, it.d / 2 + 0.06, top, top + 0.08, 0x6a6660);
    } else {
      boxInto(sink, x, z, S.ux, S.uz, it.w / 2, it.d / 2, topY, topY + it.h, it.hex);
    }
  }
  return built;
}
