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
 * `parapet`: a street runs along the top. The sink's surface layer is the
 * caller's (stone slabs read best mapped up the wall).
 */
export function quayPiece(sink, p0x, p0z, p1x, p1z, t0, t1, wy, fx, fz, parapet) {
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
  // the parapet stands flush with the water face, on the coping
  const qx0 = p0x - nx * PARAPET_T, qz0 = p0z - nz * PARAPET_T;
  const qx1 = p1x - nx * PARAPET_T, qz1 = p1z - nz * PARAPET_T;
  const h0 = c0 + PARAPET_H, h1 = c1 + PARAPET_H;
  face(sink, p0x, p0z, p1x, p1z, h0, h1, c0, c1, nx, nz, STONE);
  face(sink, qx0, qz0, qx1, qz1, h0, h1, c0 - 0.05, c1 - 0.05, -nx, -nz, STONE);
  sink.triFacing(p0x, h0, p0z, p1x, h1, p1z, qx1, h1, qz1, 0, 1, 0, CAP[0], CAP[1], CAP[2]);
  sink.triFacing(p0x, h0, p0z, qx1, h1, qz1, qx0, h0, qz0, 0, 1, 0, CAP[0], CAP[1], CAP[2]);
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
