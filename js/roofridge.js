// ---- roofridge.js: the roofs that stand on a ridge or a single slope ----
// Pure geometry (no three, no DOM), split out of roofs.js, whose roofInto is
// still the one caller: the gable, half-hip, hip and pyramid family over the
// footprint's oriented box, the lean-to, and the attic's roof windows, which
// roofs.js roofCap lays on its offset slopes too. Both tiers and the mesh
// worker build through here, so a ridge is the same ridge near and far.

import { PIN_U, PIN_V } from './typologycells.js';

// Roof windows: what an attic storey (roof:levels) shows of itself from the
// street and from the air. Dark panes lying 4 cm proud of one slope, a row of
// them along the eave edge that starts at (x, y, z), runs `len` metres along
// the unit vector e, and climbs the slope by the vector (sx, sy, sz) from eave
// to ridge. (nx, ny, nz) is the slope's normal. Pinned to the plain texel:
// glass has no courses.
const PANE = [0.045, 0.07, 0.1];          // 0x3b4a59 in linear light: glass under a sky
export function skylights(sink, x, y, z, ex, ey, ez, len, sx, sy, sz, nx, ny, nz) {
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
export function ridgeRoof(sink, S, topY, q, ov, rr, wall, pyramid, soffit, tag) {
  // ridge along the longer side of the box, unless the tags turn it
  const along = (S.L >= S.W) !== !!tag?.swap;
  const ax = along ? S.ux : S.vx, az = along ? S.uz : S.vz;       // ridge direction
  const bx = along ? S.vx : S.ux, bz = along ? S.vz : S.uz;       // across
  const hl = (along ? S.L : S.W) / 2, hw = (along ? S.W : S.L) / 2;
  const cx = S.ux * S.cu + S.vx * S.cv, cz = S.uz * S.cu + S.vz * S.cv;
  if (hl < 0.5 || hw < 0.5) return null;
  // (the old town of Prague: about 50 degrees and up to 8 m, the medieval
  // and baroque roof that towers over its own facade)
  let rise = tag?.old ? Math.min(8, Math.max(1.2, hw * 1.2))
    : Math.min(5, Math.max(1.0, hw * (q >= 1 ? 0.7 : 0.78)));
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
export function monoRoof(sink, S, topY, ov, rr, wall, tag) {
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
