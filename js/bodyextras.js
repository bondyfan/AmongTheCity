// ---- bodyextras.js: what a person carries -----------------------------------
//
// A backpack, a shoulder bag, a handbag, a walking stick. Each is a soft box
// (a tube with a squarish section) or a thin tube on the bone that carries it,
// in the same mesh as the body: a bag costs triangles, never a draw call.

import { BONE } from './bodyshape.js';
import { shade } from './bodymesh.js';

export function buildExtras(M, D, o, t) {
  const k = D.k;
  if (o.bag === 'backpack') {
    const a = D.trunkAt(D.chestY), z = a.bz + t + 0.062 * k, c = o.bagColor;
    const R = (y, s) => ({ y, z, rx: 0.125 * k * s, rz: 0.066 * k * s, c, p: 3.2 });
    M.tube([{ ...R(D.shoulderY + 0.015 * k, 0), rx: 0, rz: 0 }, R(D.shoulderY, 0.8), R(D.chestY, 1), R(D.waistY + 0.02 * k, 1.04), R(D.waistY - 0.035 * k, 0.86),
      { ...R(D.waistY - 0.05 * k, 0), rx: 0, rz: 0 }], { segs: 8, b: [BONE.chest, BONE.torso, 0.7], far: [0, 2, 3, 5] });
    for (const sx of [-1, 1]) {      // the straps: what makes it a backpack from the front
      const x = sx * a.rx * 0.62, w = 0.016 * k, y0 = D.ribY, y1 = D.shoulderTopY - 0.012 * k;
      const zf = (y) => -(D.trunkAt(y).fz + t) * 0.86 - 0.004 * k;
      M.fan([[x - w, y0, zf(y0)], [x + w, y0, zf(y0)], [x + w, y1, zf(y1) + 0.02 * k], [x - w, y1, zf(y1) + 0.02 * k]], shade(c, 0.8), BONE.chest, { normal: [0, 0.2, -1] });
    }
  } else if (o.bag === 'shoulder') {
    const a = D.trunkAt(D.hipY + 0.03 * k), x = -(a.rx + t + 0.075 * k), c = o.bagColor, y = D.hipY + 0.06 * k;
    const R = (yy, s) => ({ x, y: yy, z: 0.02 * k, rx: 0.045 * k * s, rz: 0.125 * k * s, c, p: 3.2 });
    M.tube([{ ...R(y + 0.085 * k, 0), rx: 0, rz: 0 }, R(y + 0.08 * k, 0.9), R(y, 1), R(y - 0.09 * k, 0.95), { ...R(y - 0.10 * k, 0), rx: 0, rz: 0 }],
      { segs: 8, b: [BONE.chest, BONE.pelvis, 0.5], far: [0, 2, 4] });
    // the strap, up over the shoulder on its own side, front and back
    const sy = D.shoulderTopY + t + 0.004 * k, sxx = -D.trunkAt(D.shoulderTopY).rx * 0.78, w = 0.012 * k;
    for (const sz of [-1, 1]) {
      const zb = 0.02 * k + sz * 0.09 * k, zt = sz * 0.01 * k;
      const v = [[x - w, y + 0.08 * k, zb], [x + w, y + 0.08 * k, zb], [sxx + w, sy, zt], [sxx - w, sy, zt]];
      M.fan(sz < 0 ? v : v.reverse(), shade(c, 0.75), BONE.chest, { normal: [-0.5, 0.2, sz] });
    }
  } else if (o.bag === 'hand') {
    const x = -(D.shoulderX + 0.004 * k), y = D.wristY - 0.27 * k, c = o.bagColor;
    const R = (yy, s) => ({ x, y: yy, z: -0.005 * k, rx: 0.038 * k * s, rz: 0.12 * k * s, c, p: 3.4 });
    M.tube([{ ...R(y + 0.105 * k, 0), rx: 0, rz: 0 }, R(y + 0.10 * k, 0.86), R(y, 1), R(y - 0.10 * k, 1), { ...R(y - 0.108 * k, 0), rx: 0, rz: 0 }],
      { segs: 8, b: BONE.handL, far: [0, 2, 4] });
    for (const sz of [-1, 1]) {
      const z0 = -0.005 * k + sz * 0.06 * k, w = 0.007 * k, v = [[x, y + 0.10 * k, z0 - w], [x, y + 0.10 * k, z0 + w], [x, D.wristY - 0.10 * k, w], [x, D.wristY - 0.10 * k, -w]];
      M.fan(v, shade(c, 0.7), BONE.handL, { normal: [-1, 0, 0] });
      M.fan(v.slice().reverse(), shade(c, 0.7), BONE.handL, { normal: [1, 0, 0] });
    }
  }
  if (o.cane) {
    // hangs straight down from the right hand in the bind pose; its own bone
    // lets the walk keep it planted while the arm moves
    const x = D.shoulderX + 0.012 * k, top = D.wristY - 0.065 * k, c = 0x6b4a2a, r = 0.011 * k;
    M.tube([{ x, y: top + 0.012 * k, z: -0.02 * k, rx: 0, c }, { x, y: top, z: -0.02 * k, rx: r, c }, { x, y: 0.02, z: -0.02 * k, rx: r * 0.9, c, c2: 0x2a2623 },
      { x, y: 0, z: -0.02 * k, rx: r, c: 0x2a2623 }, { x, y: 0, z: -0.02 * k, rx: 0, c: 0x2a2623 }], { segs: 5, b: BONE.cane, far: [0, 1, 3, 4] });
    M.blob(x, top + 0.006 * k, 0.0, 0.014 * k, 0.014 * k, 0.055 * k, c, BONE.cane, { segs: 5, rings: 3 });
  }
}

