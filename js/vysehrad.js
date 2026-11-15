// VYŠEHRAD from the river: the rock and the tunnel through it.
//
// The rock (Vyšehradská skála) stands straight up out of the embankment road
// under the fortress, 30 m of it, and the road and the trams go through its
// spur in a short tunnel (Vyšehradský tunel, 1902). The 20 m survey softened
// the face into a 60 to 75 % grass slope, and the tiles do not carry tunnels
// at all: the embankment road ended at both portals and its last metres were
// levelled onto the spur, so it climbed 20 m over the rock to a dead end.
//
// Here, in terrain stamps (js/terrainstamps.js applies them) and a little
// geometry (meshes.js draws it with the chunk's absolute-height pieces):
//   * the FACE: the ground beside the road on the rock's side rises at 250 %
//     from the kerb to the plateau ('raise' only, so the plateau and the
//     fortress on it are untouched);
//   * the TUNNEL: the road's line through the spur dug to its own level,
//     hard edged (the cut's sides are the tunnel's walls), and over it a roof
//     at the rock's own height with a portal face at each end, so from the
//     river the road runs INTO the rock. Cars drive the cut; the trams' and
//     the road's ways stay as shipped.
// WORKER SAFE: plain data and arithmetic, geometry into a sink.

import { makeStamp, applyStamp } from './terrainstamps.js';
import { VYSEHRAD, TUNNEL, TUNNEL_Y, PORTALS, HALF } from './vysehraddata.js';

const CLEAR = 5.6;               // m: from the road to the tunnel's ceiling

let _face = null;
/** The rock's height at (x, z) with the face but without the tunnel: the roof. */
function rockY(terrain, x, z) {
  _face ??= [makeStamp(VYSEHRAD.faceN), makeStamp(VYSEHRAD.faceS)];
  let h = terrain._gridAt(x, z);
  for (const st of _face) h = applyStamp(st, x, z, h);
  return h;
}

const ROOF = [0.27, 0.29, 0.20], CEIL = [0.16, 0.16, 0.15], PORTAL = [0.46, 0.43, 0.38];
const STEP = 4;                  // m along the tunnel per roof piece

/**
 * The tunnel's roof, ceiling and portal faces: the pieces whose midpoint lies
 * in this chunk (one owner each). Absolute heights: the caller marks them
 * fixed, like the bank skirts.
 */
export function vysehradInto(sink, x0, z0, x1, z1, terrain) {
  if (!terrain || x1 < -96030 || x0 > -95975 || z1 < -3580 || z0 > -3500) return;
  for (let i = PORTALS[0]; i < PORTALS[1]; i++) {
    const [ax, az] = TUNNEL[i], [bx, bz] = TUNNEL[i + 1];
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / STEP));
    const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
    for (let k = 0; k < n; k++) {
      const t0 = k / n, t1 = (k + 1) / n;
      const mx = ax + (bx - ax) * (t0 + t1) / 2, mz = az + (bz - az) * (t0 + t1) / 2;
      if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
      const px = ax + (bx - ax) * t0, pz = az + (bz - az) * t0;
      const qx = ax + (bx - ax) * t1, qz = az + (bz - az) * t1;
      const fy0 = TUNNEL_Y[i] + (TUNNEL_Y[i + 1] - TUNNEL_Y[i]) * t0 + CLEAR;
      const fy1 = TUNNEL_Y[i] + (TUNNEL_Y[i + 1] - TUNNEL_Y[i]) * t1 + CLEAR;
      // across in three strips, the roof following the rock over them
      const W = HALF + 0.4;
      for (let s = 0; s < 3; s++) {
        const o0 = -W + (2 * W) * s / 3, o1 = -W + (2 * W) * (s + 1) / 3;
        const A = [px + nx * o0, pz + nz * o0], B = [px + nx * o1, pz + nz * o1];
        const C = [qx + nx * o1, qz + nz * o1], D = [qx + nx * o0, qz + nz * o0];
        const yA = rockY(terrain, A[0], A[1]) + 0.05, yB = rockY(terrain, B[0], B[1]) + 0.05;
        const yC = rockY(terrain, C[0], C[1]) + 0.05, yD = rockY(terrain, D[0], D[1]) + 0.05;
        sink.triFacing(A[0], yA, A[1], B[0], yB, B[1], C[0], yC, C[1], 0, 1, 0, ROOF[0], ROOF[1], ROOF[2]);
        sink.triFacing(A[0], yA, A[1], C[0], yC, C[1], D[0], yD, D[1], 0, 1, 0, ROOF[0], ROOF[1], ROOF[2]);
      }
      // the ceiling over the road, wall to wall
      const A = [px - nx * HALF, pz - nz * HALF], B = [px + nx * HALF, pz + nz * HALF];
      const C = [qx + nx * HALF, qz + nz * HALF], D = [qx - nx * HALF, qz - nz * HALF];
      sink.triFacing(A[0], fy0, A[1], B[0], fy0, B[1], C[0], fy1, C[1], 0, -1, 0, CEIL[0], CEIL[1], CEIL[2]);
      sink.triFacing(A[0], fy0, A[1], C[0], fy1, C[1], D[0], fy1, D[1], 0, -1, 0, CEIL[0], CEIL[1], CEIL[2]);
    }
  }
  // the portals: a face of dressed stone from the ceiling up to the rock
  for (const [pi, dir] of [[PORTALS[0], -1], [PORTALS[1], 1]]) {
    const [px, pz] = TUNNEL[pi];
    if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue;
    const j = dir < 0 ? pi + 1 : pi - 1;
    const ux = (TUNNEL[j][0] - px), uz = (TUNNEL[j][1] - pz), L = Math.hypot(ux, uz);
    const nx = -uz / L, nz = ux / L, fx = -ux / L, fz = -uz / L;   // fx/fz: out of the rock
    const fy = TUNNEL_Y[pi] + CLEAR;
    const W = HALF + 0.4, n = 4;
    for (let s = 0; s < n; s++) {
      const o0 = -W + 2 * W * s / n, o1 = -W + 2 * W * (s + 1) / n;
      const ax = px + nx * o0, az = pz + nz * o0, bx = px + nx * o1, bz = pz + nz * o1;
      const ta = rockY(terrain, ax, az) + 0.05, tb = rockY(terrain, bx, bz) + 0.05;
      if (ta <= fy && tb <= fy) continue;
      sink.triFacing(ax, fy - 0.6, az, bx, fy - 0.6, bz, bx, Math.max(tb, fy), bz, fx, 0, fz, PORTAL[0], PORTAL[1], PORTAL[2]);
      sink.triFacing(ax, fy - 0.6, az, bx, Math.max(tb, fy), bz, ax, Math.max(ta, fy), az, fx, 0, fz, PORTAL[0], PORTAL[1], PORTAL[2]);
    }
  }
}
