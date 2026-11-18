// Prague quays. Once the Vltava lies flat in its pools (riverpools.js) the Old
// Town bank stands 4 to 6 m over the water, and the generic bank skirt, a
// strip of brown earth from the ground down to the waterline, turned that into
// an earth cliff. A real nábřeží is a dressed stone wall with a coping course
// and, where a street or a promenade runs along the top, a parapet. This draws
// one bank piece that way. Worker safe (pure geometry into the sink).

import { distPointToSegment } from './geo.js';

// m: a bank higher than this over its water is a built wall, not a slope
export const QUAY_MIN = 1.2;
// m: and higher than this, with a street along it, it carries a parapet
const PARAPET_MIN = 2.6;
const PARAPET_H = 1.0, PARAPET_T = 0.42, COPING_W = 0.45, COPING_H = 0.12;
// m: how far from the bank an embankment street may run and still own a parapet
const ROAD_REACH = 25;

// granite and sandstone ashlar, darker and greener where the river wets it
const STONE = [0.44, 0.41, 0.36], WET = [0.19, 0.20, 0.16], CAP = [0.56, 0.53, 0.47];
const WET_BAND = 0.55;   // m of stained stone above the waterline

// quad a→b with its own top and bottom at each end, facing (fx, fz)
function face(sink, ax, az, bx, bz, ta, tb, ba, bb, fx, fz, c) {
  const dx = bx - ax, dz = bz - az;
  if (dz * fx - dx * fz >= 0) sink.quad(ax, ta, az, bx, tb, bz, bx, bb, bz, ax, ba, az, c[0], c[1], c[2]);
  else sink.quad(bx, tb, bz, ax, ta, az, ax, ba, az, bx, bb, bz, c[0], c[1], c[2]);
}

/**
 * One piece of quay wall from (p0x, p0z) to (p1x, p1z). t0/t1: ground at each
 * end (absolute), wy: the water level, (fx, fz): toward the water (any length).
 * `parapet`: a street runs along the top; `style` 'balustrade' draws it as
 * one (js/quaybalustrade.js says where), anything else as a solid wall. The
 * sink's surface layer is the caller's (stone slabs read best mapped up the wall).
 */
export function quayPiece(sink, p0x, p0z, p1x, p1z, t0, t1, wy, fx, fz, parapet, style = null) {
  const L = Math.hypot(fx, fz) || 1, nx = fx / L, nz = fz / L;
  const foot = wy - 0.4, wet = wy + WET_BAND;
  // stained band at the waterline, dressed stone above it, up to the coping
  face(sink, p0x, p0z, p1x, p1z, Math.min(wet, t0), Math.min(wet, t1), foot, foot, nx, nz, WET);
  if (t0 > wet || t1 > wet) {
    face(sink, p0x, p0z, p1x, p1z, t0 + COPING_H, t1 + COPING_H,
      Math.min(wet, t0), Math.min(wet, t1), nx, nz, STONE);
  }
  // the coping: a lid a little proud of the ground, running back from the edge
  const bx0 = p0x - nx * COPING_W, bz0 = p0z - nz * COPING_W;
  const bx1 = p1x - nx * COPING_W, bz1 = p1z - nz * COPING_W;
  const c0 = t0 + COPING_H, c1 = t1 + COPING_H;
  sink.triFacing(p0x, c0, p0z, p1x, c1, p1z, bx1, c1, bz1, 0, 1, 0, CAP[0], CAP[1], CAP[2]);
  sink.triFacing(p0x, c0, p0z, bx1, c1, bz1, bx0, c0, bz0, 0, 1, 0, CAP[0], CAP[1], CAP[2]);
  // its back edge, down into the ground that may rise behind it
  face(sink, bx0, bz0, bx1, bz1, c0, c1, t0 - 0.2, t1 - 0.2, -nx, -nz, CAP);
  if (!parapet || Math.max(t0, t1) - wy < PARAPET_MIN) return;
  if (style === 'balustrade') { balustradeInto(sink, p0x, p0z, p1x, p1z, c0, c1, nx, nz); return; }
  // the parapet stands flush with the water face, on the coping
  const qx0 = p0x - nx * PARAPET_T, qz0 = p0z - nz * PARAPET_T;
  const qx1 = p1x - nx * PARAPET_T, qz1 = p1z - nz * PARAPET_T;
  const h0 = c0 + PARAPET_H, h1 = c1 + PARAPET_H;
  face(sink, p0x, p0z, p1x, p1z, h0, h1, c0, c1, nx, nz, STONE);
  face(sink, qx0, qz0, qx1, qz1, h0, h1, c0 - 0.05, c1 - 0.05, -nx, -nz, STONE);
  sink.triFacing(p0x, h0, p0z, p1x, h1, p1z, qx1, h1, qz1, 0, 1, 0, CAP[0], CAP[1], CAP[2]);
  sink.triFacing(p0x, h0, p0z, qx1, h1, qz1, qx0, h0, qz0, 0, 1, 0, CAP[0], CAP[1], CAP[2]);
}

// ---- the balustrade -------------------------------------------------------------
// A granite plinth and top rail the parapet's thickness, a pedestal every
// PED_EVERY (the piece's own start carries one, so a joint has exactly one),
// and square balusters between, centred in the thickness. About 30
// triangles a metre against the solid wall's 3.
const PLINTH_H = 0.24, RAIL_H = 0.16, PED_EVERY = 2.4, PED_W = 0.44, PED_PROUD = 0.05;
const BAL_GAP = 0.3, BAL_W = 0.13;
const BAL = [0.60, 0.57, 0.51];

// a vertical box from (ax, az) to (bx, bz) along u, `w0..w1` deep behind the
// water face (along -n), between y0 and y1 at its ends: its four sides and lid
function stoneBox(sink, ax, az, bx, bz, w0, w1, ya0, ya1, yb0, yb1, nx, nz, c, lid) {
  const fx0 = ax - nx * w0, fz0 = az - nz * w0, fx1 = bx - nx * w0, fz1 = bz - nz * w0;
  const kx0 = ax - nx * w1, kz0 = az - nz * w1, kx1 = bx - nx * w1, kz1 = bz - nz * w1;
  face(sink, fx0, fz0, fx1, fz1, ya1, yb1, ya0, yb0, nx, nz, c);
  face(sink, kx0, kz0, kx1, kz1, ya1, yb1, ya0, yb0, -nx, -nz, c);
  const ux = bx - ax, uz = bz - az;
  face(sink, fx0, fz0, kx0, kz0, ya1, ya1, ya0, ya0, -ux, -uz, c);
  face(sink, fx1, fz1, kx1, kz1, yb1, yb1, yb0, yb0, ux, uz, c);
  if (lid) {
    sink.triFacing(fx0, ya1, fz0, fx1, yb1, fz1, kx1, yb1, kz1, 0, 1, 0, lid[0], lid[1], lid[2]);
    sink.triFacing(fx0, ya1, fz0, kx1, yb1, kz1, kx0, ya1, kz0, 0, 1, 0, lid[0], lid[1], lid[2]);
  }
}

function balustradeInto(sink, p0x, p0z, p1x, p1z, c0, c1, nx, nz) {
  const L = Math.hypot(p1x - p0x, p1z - p0z);
  if (L < 0.05) return;
  const ux = (p1x - p0x) / L, uz = (p1z - p0z) / L;
  const at = (t) => [p0x + ux * t, p0z + uz * t, c0 + (c1 - c0) * t / L];
  // plinth and rail, end to end
  stoneBox(sink, p0x, p0z, p1x, p1z, 0, PARAPET_T, c0 - 0.05, c0 + PLINTH_H, c1 - 0.05, c1 + PLINTH_H, nx, nz, STONE, CAP);
  stoneBox(sink, p0x, p0z, p1x, p1z, 0, PARAPET_T, c0 + PARAPET_H - RAIL_H, c0 + PARAPET_H,
    c1 + PARAPET_H - RAIL_H, c1 + PARAPET_H, nx, nz, STONE, CAP);
  // (the rail's underside, seen between the balusters)
  const ra = c0 + PARAPET_H - RAIL_H, rb = c1 + PARAPET_H - RAIL_H;
  const kx0 = p0x - nx * PARAPET_T, kz0 = p0z - nz * PARAPET_T, kx1 = p1x - nx * PARAPET_T, kz1 = p1z - nz * PARAPET_T;
  sink.triFacing(p0x, ra, p0z, p1x, rb, p1z, kx1, rb, kz1, 0, -1, 0, STONE[0], STONE[1], STONE[2]);
  sink.triFacing(p0x, ra, p0z, kx1, rb, kz1, kx0, ra, kz0, 0, -1, 0, STONE[0], STONE[1], STONE[2]);
  const m = Math.max(1, Math.round(L / PED_EVERY)), span = L / m;
  for (let j = 0; j < m; j++) {
    // the pedestal at this bay's start, a touch proud of both faces
    const t0 = j * span, a = at(Math.max(0, t0 - PED_W / 2)), b = at(Math.min(L, t0 + PED_W / 2));
    stoneBox(sink, a[0], a[1], b[0], b[1], -PED_PROUD, PARAPET_T + PED_PROUD, a[2], a[2] + PARAPET_H + 0.06,
      b[2], b[2] + PARAPET_H + 0.06, nx, nz, STONE, CAP);
    // the balusters of the bay
    const g0 = t0 + PED_W / 2, g1 = t0 + span - PED_W / 2, nb = Math.floor((g1 - g0) / BAL_GAP);
    for (let i = 0; i < nb; i++) {
      const tc = g0 + (g1 - g0) * (i + 0.5) / nb;
      const p = at(tc - BAL_W / 2), q = at(tc + BAL_W / 2);
      const w0 = (PARAPET_T - BAL_W) / 2, w1 = w0 + BAL_W;
      stoneBox(sink, p[0], p[1], q[0], q[1], w0, w1, p[2] + PLINTH_H, p[2] + PARAPET_H - RAIL_H,
        q[2] + PLINTH_H, q[2] + PARAPET_H - RAIL_H, nx, nz, BAL, null);
    }
  }
}

/**
 * Is a street or a promenade running along the bank near (x, z)? `roads` is
 * the chunk neighbourhood's road list. Bridges do not count (they cross the
 * river, they do not follow it), nor does anything far below the bank top
 * (a lower quay, náplavka, has an open edge).
 */
export function embankmentNear(roads, x, z, top, heightAt) {
  for (const r of roads) {
    if (r.br || !r.p || r.p.length < 2) continue;
    const reach = ROAD_REACH + (r.w ?? 3) / 2;
    const bb = r._qbb ??= bboxOf(r.p);
    if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
    for (let k = 0; k < r.p.length - 1; k++) {
      const a = r.p[k], b = r.p[k + 1];
      if (distPointToSegment(x, z, a[0], a[1], b[0], b[1], _near) >= reach) continue;
      if (heightAt(_near.x, _near.z) > top - 1.0) return true;
    }
  }
  return false;
}
const _near = { x: 0, z: 0 };

function bboxOf(p) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return [x0, z0, x1, z1];
}
