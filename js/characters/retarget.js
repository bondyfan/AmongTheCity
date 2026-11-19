// ---- retarget.js: one pose, any human skeleton -----------------------------
//
// The game's moves were all written for the seventeen joints of js/citizen.js:
// a walk solved from the feet, sitting, the car door, the vault, the arrest.
// A downloaded character has sixty bones bound in a T pose with axes of its
// author's choosing. This file is the bridge, and it is the same bridge for an
// animation clip recorded on somebody else's skeleton.
//
// THE IDEA. Both sides are described against one REFERENCE POSE: standing,
// arms hanging straight down, legs straight down. For every bone of a rig we
// keep C, its world rotation in that pose. A pose is then, per slot
// (js/characters/skeletonmap.js), a DELTA: the rotation that takes the limb
// from the reference pose to where it is now, in the figure's own frame. The
// delta means the same thing on every skeleton ("upper arm 40 degrees
// forward"), so
//
//     world rotation of bone b  =  delta(slot of b) * C_b
//
// and a bone with no slot (a finger, a twist bone, a collar) keeps its rest
// angle against its parent. The game's own joints are the simplest rig there
// is: their reference rotations are all identity, so a joint's world rotation
// IS its delta.
//
// The figure frame is the game's: facing -z, +x to its right, y up. All
// rotations here are unit quaternions stored x, y, z, w in flat arrays.

import * as THREE from 'three';
import { SLOT, SLOT_COUNT, SLOTS, mapBones, missing } from './skeletonmap.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const _q = new THREE.Quaternion(), _p = new THREE.Quaternion(), _r = new THREE.Quaternion();
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _s = new THREE.Vector3();
const _m = new THREE.Matrix4();

// which slot's bind direction is straightened to hang down, and toward which child slot
const HANG = [
  ['upperArmL', 'lowerArmL'], ['lowerArmL', 'handL'], ['upperArmR', 'lowerArmR'], ['lowerArmR', 'handR'],
  ['upperLegL', 'lowerLegL'], ['lowerLegL', 'footL'], ['upperLegR', 'lowerLegR'], ['lowerLegR', 'footR'],
];
// a hand keeps the straight wrist it was bound with, so it takes its forearm's correction
const FOLLOW = [['handL', 'lowerArmL'], ['handR', 'lowerArmR']];

const get = (a, i, q) => q.set(a[i * 4], a[i * 4 + 1], a[i * 4 + 2], a[i * 4 + 3]);
const put = (a, i, q) => { a[i * 4] = q.x; a[i * 4 + 1] = q.y; a[i * 4 + 2] = q.z; a[i * 4 + 3] = q.w; };

/**
 * Describe a skeleton for retargeting.
 *   bones   THREE.Bone[] (any order), posed as bound, under `frame`
 *   frame   the Object3D whose space is the FIGURE's (facing -z, feet at 0);
 *           its matrixWorld must be current, as must the bones'
 * Returns the rig record every other function here takes.
 */
export function describeRig(bones, frame) {
  // parents before children, whatever order the file had them in
  const set = new Set(bones);
  const order = [];
  const visit = (b) => { if (order.includes(b)) return; if (set.has(b.parent)) visit(b.parent); order.push(b); };
  bones.forEach(visit);
  const n = order.length;
  const parent = new Int16Array(n);
  const restQ = new Float32Array(n * 4), restP = new Float32Array(n * 3), restS = new Float32Array(n);
  const worldQ = new Float32Array(n * 4), worldP = new Float32Array(n * 3);
  const inv = _m.copy(frame.matrixWorld).invert();
  const fm = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const b = order[i];
    parent[i] = set.has(b.parent) ? order.indexOf(b.parent) : -1;
    put(restQ, i, b.quaternion);
    restP[i * 3] = b.position.x; restP[i * 3 + 1] = b.position.y; restP[i * 3 + 2] = b.position.z;
    restS[i] = b.scale.x;          // uniform, and 1 for a bone: an armature node in the chain may carry the file's units
    fm.multiplyMatrices(inv, b.matrixWorld).decompose(_v, _q, _s);
    put(worldQ, i, _q);
    worldP[i * 3] = _v.x; worldP[i * 3 + 1] = _v.y; worldP[i * 3 + 2] = _v.z;
  }
  const map = mapBones(order.map((b, i) => ({ name: b.name, parent: parent[i] })));
  const slotBone = new Int16Array(SLOT_COUNT).fill(-1);
  const boneSlot = new Int16Array(n).fill(-1);
  for (const s in map) { slotBone[SLOT[s]] = map[s]; boneSlot[map[s]] = SLOT[s]; }

  // C: the reference pose. Bind, with every arm and leg segment turned the
  // short way round until it hangs straight down.
  const C = worldQ.slice();
  const fix = new Map();
  const pos = (i, v) => v.set(worldP[i * 3], worldP[i * 3 + 1], worldP[i * 3 + 2]);
  for (const [a, c] of HANG) {
    const ia = slotBone[SLOT[a]], ic = slotBone[SLOT[c]];
    if (ia < 0 || ic < 0) continue;
    pos(ic, _v).sub(pos(ia, _w));
    if (_v.lengthSq() < 1e-10) continue;
    const A = new THREE.Quaternion().setFromUnitVectors(_v.normalize(), DOWN);
    fix.set(a, A);
    put(C, ia, _q.multiplyQuaternions(A, get(worldQ, ia, _p)));
  }
  for (const [h, f] of FOLLOW) {
    const ih = slotBone[SLOT[h]], A = fix.get(f);
    if (ih >= 0 && A) put(C, ih, _q.multiplyQuaternions(A, get(worldQ, ih, _p)));
  }
  // the frame the top bones hang in: where, which way round, how big
  const top = order[0].parent;
  const topQ = new THREE.Quaternion(), topP = new THREE.Vector3(), topS3 = new THREE.Vector3(1, 1, 1);
  if (top) fm.multiplyMatrices(inv, top.matrixWorld).decompose(topP, topQ, topS3);
  const topS = topS3.y;
  const hips = slotBone[SLOT.hips];
  // a figure-space offset of the hips, in the hips' own parent space, is
  // hipInv * offset / topS (bones themselves are taken as unscaled)
  const hipInv = new THREE.Quaternion();
  if (hips >= 0) {
    if (parent[hips] >= 0) get(worldQ, parent[hips], hipInv).conjugate(); else hipInv.copy(topQ).conjugate();
  }
  const y = (slot) => { const i = slotBone[SLOT[slot]]; return i < 0 ? NaN : worldP[i * 3 + 1]; };
  const dist = (a, b) => {
    const i = slotBone[SLOT[a]], j = slotBone[SLOT[b]];
    return i < 0 || j < 0 ? NaN : pos(i, _v).distanceTo(pos(j, _w));
  };
  return {
    bones: order, n, parent, restQ, restP, restS, worldQ, worldP, C, slotBone, boneSlot, map,
    missing: missing(map), topQ, topP, topS, hipInv, hips,
    names: order.map((b) => b.name),
    // the measurements the game's walk needs, in figure metres
    dims: {
      hipY: y('upperLegL'), hipX: Math.abs(hips >= 0 && slotBone[SLOT.upperLegL] >= 0 ? worldP[slotBone[SLOT.upperLegL] * 3] : NaN),
      thigh: dist('upperLegL', 'lowerLegL'), shin: dist('lowerLegL', 'footL'), ankleY: y('footL'),
      spineY: y('chest'), shoulderY: y('upperArmL'),
      shoulderX: Math.abs(slotBone[SLOT.upperArmL] >= 0 ? worldP[slotBone[SLOT.upperArmL] * 3] : NaN),
      upper: dist('upperArmL', 'lowerArmL'), fore: dist('lowerArmL', 'handL'),
      headY: y('head'), neckY: y('neck'), pelvisY: y('hips'),
    },
  };
}

/**
 * Deltas in, local rotations out. `delta` holds one quaternion per slot
 * (SLOT order); `has` says which slots it fills (a Uint8Array, or null for
 * all). `out` gets n local quaternions, ready to copy onto the bones.
 * `world`, when given, receives the figure-space rotation of every bone.
 * `rest`, when given, replaces the bind angles of the bones without a slot.
 */
const _F = [];
export function solve(rig, delta, has, out, world = null, rest = null) {
  const { n, parent, C, boneSlot, topQ } = rig;
  // a bone with no slot keeps this angle against its parent: its bind angle,
  // or a clip's (so fingers and collars stay animated under a retargeted arm)
  const restQ = rest ?? rig.restQ;
  const F = world ?? (_F[0] && _F[0].length >= n * 4 ? _F[0] : (_F[0] = new Float32Array(n * 4)));
  for (let i = 0; i < n; i++) {
    const s = boneSlot[i], p = parent[i];
    if (p < 0) _p.copy(topQ); else get(F, p, _p);
    if (s >= 0 && (!has || has[s])) {
      _q.multiplyQuaternions(get(delta, s, _r), get(C, i, _q));
      put(F, i, _q);
      _r.copy(_p).conjugate().multiply(_q);
      put(out, i, _r);
    } else {
      get(restQ, i, _r);
      put(F, i, _q.multiplyQuaternions(_p, _r));
      put(out, i, _r);
    }
  }
  return out;
}

/** Figure-space rotations of every bone for a set of LOCAL rotations. */
export function worldOf(rig, local, out) {
  const { n, parent, topQ } = rig;
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p < 0) _p.copy(topQ); else get(out, p, _p);
    put(out, i, _q.multiplyQuaternions(_p, get(local, i, _r)));
  }
  return out;
}

/** The per-slot deltas a pose (figure-space bone rotations) amounts to. */
export function deltasOf(rig, world, delta, has = null) {
  const { slotBone, C } = rig;
  for (let s = 0; s < SLOT_COUNT; s++) {
    const i = slotBone[s];
    if (i < 0) { if (has) has[s] = 0; delta[s * 4 + 3] = 1; continue; }
    if (has) has[s] = 1;
    put(delta, s, _q.multiplyQuaternions(get(world, i, _p), get(C, i, _r).conjugate()));
  }
  return delta;
}

// ---- the game's own joints ---------------------------------------------------
// J is the joint record of js/citizen.js. Its chains, as slots:
const _a = new THREE.Quaternion(), _b = new THREE.Quaternion(), _c = new THREE.Quaternion(), _d = new THREE.Quaternion();

/** Fill `delta` (and `has`) from the seventeen joints as they stand now. */
export function deltasFromJoints(J, delta, has) {
  const body = J.body.quaternion;
  const set = (slot, q) => { put(delta, SLOT[slot], q); has[SLOT[slot]] = 1; };
  has.fill(0);
  set('hips', _a.multiplyQuaternions(body, J.pelvis.quaternion));
  _a.multiplyQuaternions(body, J.torso.quaternion); set('spine', _a);
  _b.multiplyQuaternions(_a, J.chest.quaternion); set('chest', _b);
  _c.multiplyQuaternions(_b, J.head.quaternion); set('head', _c);
  set('neck', _d.copy(_b).slerp(_c, 0.5));
  for (const sd of ['L', 'R']) {
    const sh = J['arm' + sd];
    _c.multiplyQuaternions(_b, sh.parent.quaternion).multiply(sh.quaternion); set('upperArm' + sd, _c);
    _c.multiply(J['elbow' + sd].quaternion); set('lowerArm' + sd, _c);
    _c.multiply(J['hand' + sd].quaternion); set('hand' + sd, _c);
    _c.multiplyQuaternions(body, J['leg' + sd].quaternion); set('upperLeg' + sd, _c);
    _c.multiply(J['knee' + sd].quaternion); set('lowerLeg' + sd, _c);
    _c.multiply(J['foot' + sd].quaternion); set('foot' + sd, _c);
  }
  return delta;
}

export { SLOT, SLOTS, SLOT_COUNT };
