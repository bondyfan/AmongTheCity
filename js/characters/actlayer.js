// ---- actlayer.js: a one-off recording laid over whatever the body is doing ----
//
// A punch, a flinch, a fall and getting up are recordings like the walk, but
// they are not something a body IS doing, they are something that happens to
// it for a second. So they are not a base (js/characters/resolve.js keeps
// those: moving, standing, sitting) but a LAYER on top of the resolved pose:
//
//   'upper'  from the small of the back up, both arms and the head. The legs
//            stay the walk's, so a man can jab while he circles you.
//   'full'   the whole body, the hips' height and travel included: a fall,
//            lying on the ground, getting up.
//
// The owner says which clip, how far into it and how much of it (0..1), every
// step it wants it, through human.js act(); this file only does the per-bone
// arithmetic, on flat arrays.
//
// THE MIX IS IN THE FIGURE'S SPACE, NOT BONE BY BONE LOCALLY. A recorded punch
// leans its pelvis one way and its spine the other, and the walk under it
// holds the pelvis differently again; taking the punch's LOCAL spine angle onto
// the walk's pelvis bent the whole trunk forward like a man looking for his
// keys. And on a 3ds Max Biped the thighs hang from the spine bone, so any
// spine angle laid on locally also swung the legs. So both poses are taken to
// figure-space rotations, mixed there bone by bone (the trunk takes the
// recording's, the legs keep the walk's whatever their parent did), and turned
// back into local rotations.

import * as THREE from 'three';
import { SLOT } from './skeletonmap.js';
import { worldOf } from './retarget.js';

const _p = new THREE.Quaternion(), _q = new THREE.Quaternion(), _r = new THREE.Quaternion();
const SCR = new Map();
function scratch(n) {
  let s = SCR.get(n);
  if (!s) SCR.set(n, s = { WB: new Float32Array(n * 4), WA: new Float32Array(n * 4) });
  return s;
}

// how much of a bone an 'upper' layer takes, by the slot it belongs to: the
// lower spine half, so a hook turns the trunk without twisting the pelvis
const UPPER = new Map([
  [SLOT.spine, 0.6], [SLOT.chest, 1], [SLOT.neck, 1], [SLOT.head, 1],
  [SLOT.clavicleL, 1], [SLOT.upperArmL, 1], [SLOT.lowerArmL, 1], [SLOT.handL, 1],
  [SLOT.clavicleR, 1], [SLOT.upperArmR, 1], [SLOT.lowerArmR, 1], [SLOT.handR, 1],
]);

/**
 * The 'upper' weight of every bone of a rig: a bone takes the weight of the
 * nearest slot at or above it (a finger goes with its hand, a twist bone with
 * its arm), and a bone with no slot above it (a root node) takes none.
 */
export function upperMask(rig) {
  const out = new Float32Array(rig.n);
  for (let i = 0; i < rig.n; i++) {
    let j = i;
    while (j >= 0 && rig.boneSlot[j] < 0) j = rig.parent[j];
    out[i] = j < 0 ? 0 : UPPER.get(rig.boneSlot[j]) ?? 0;
  }
  return out;
}

/**
 * out = a moved toward b by w * mask[bone], bone by bone (normalised lerp,
 * short way round). `mask` null means every bone at w. `out` may be `a`.
 */
export function mixMasked(out, a, b, w, mask, n) {
  for (let i = 0; i < n; i++) {
    const k = mask ? w * mask[i] : w, o = i * 4;
    if (!(k > 0)) { if (out !== a) { out[o] = a[o]; out[o + 1] = a[o + 1]; out[o + 2] = a[o + 2]; out[o + 3] = a[o + 3]; } continue; }
    const v = 1 - k;
    const ax = a[o], ay = a[o + 1], az = a[o + 2], aw = a[o + 3];
    let bx = b[o], by = b[o + 1], bz = b[o + 2], bw = b[o + 3];
    if (ax * bx + ay * by + az * bz + aw * bw < 0) { bx = -bx; by = -by; bz = -bz; bw = -bw; }
    const x1 = ax * v + bx * k, y1 = ay * v + by * k, z1 = az * v + bz * k, w1 = aw * v + bw * k;
    const l = 1 / Math.sqrt(x1 * x1 + y1 * y1 + z1 * z1 + w1 * w1);
    out[o] = x1 * l; out[o + 1] = y1 * l; out[o + 2] = z1 * l; out[o + 3] = w1 * l;
  }
  return out;
}

/**
 * out = base with `act` laid over it by w * mask[bone], mixed as figure-space
 * rotations (see the header). `mask` null: every bone at w. `out` may be
 * `base`; it may not be `act`.
 */
export function mixWorld(rig, out, base, act, w, mask) {
  const n = rig.n, { WB, WA } = scratch(n);
  worldOf(rig, base, WB);
  worldOf(rig, act, WA);
  mixMasked(WB, WB, WA, w, mask, n);
  // and back to local rotations, against the MIXED parent
  const { parent, topQ } = rig;
  for (let i = 0; i < n; i++) {
    const p = parent[i];
    if (p < 0) _p.copy(topQ); else _p.fromArray(WB, p * 4);
    _q.fromArray(WB, i * 4);
    _r.copy(_p).conjugate().multiply(_q).toArray(out, i * 4);
  }
  return out;
}

/** How long an act() call keeps the layer on, in seconds of wall clock, if
 *  the owner stops calling it (a body handed back, a pedestrian dropped). */
export const ACT_LINGER = 0.25;
