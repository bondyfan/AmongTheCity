// ---- bodyjoints.js: the seventeen joints every move is written for ----------
//
// The walk (js/gait.js), the fixed poses (js/poses.js), the car door and the
// vault (js/bodymoves.js) and the campaign all write angles onto these joints.
// js/citizen.js skins its own lofted body to them directly; a downloaded human
// (js/characters/human.js) keeps them as an invisible driver and copies the
// pose onto its own skeleton. Both build them here, so a joint means the same
// thing on either body.

import * as THREE from 'three';
import { BONE } from './bodyshape.js';

/**
 * D is js/bodyshape.js bodyDims() (or the same measurements read off a
 * skeleton). `body` is the group the walk moves the pelvis with.
 * Returns { bones, J, collarL, collarR } where bones is in BONE order.
 */
export function buildJoints(D, group, body) {
  const bones = [];
  const bone = (i, parent, x, y, z) => {
    const b = new THREE.Bone();
    b.position.set(x, y, z);
    parent.add(b);
    if (i >= 0) bones[i] = b;
    return b;
  };
  const k = D.k;
  const pelvis = bone(BONE.pelvis, body, 0, D.hipY, 0);
  // The stoop bends the BACK at the hip and leaves the legs standing under it,
  // which is why the trunk has its own joint there instead of leaning `body`.
  const torso = bone(BONE.torso, body, 0, D.hipY, 0);
  const chest = bone(BONE.chest, torso, 0, D.spineY - D.hipY, 0);
  const head = bone(BONE.head, chest, 0, D.shoulderTopY + 0.012 * k - D.spineY, 0.008 * k);
  const arm = (sx, ia) => {
    // a collar joint that only ever holds the resting angle of the arm away
    // from the ribs, so the poses' own shoulder angles compose on top of it
    const collar = bone(-1, chest, sx * (D.shoulderX + 0.004 * k), D.shoulderY - D.spineY, 0);
    const shoulder = bone(ia, collar, 0, 0, 0);
    const elbow = bone(ia + 1, shoulder, 0, -D.upper, 0);
    const hand = bone(ia + 2, elbow, 0, -D.fore, 0);
    return { collar, shoulder, elbow, hand };
  };
  const aL = arm(-1, BONE.armL), aR = arm(1, BONE.armR);
  const leg = (sx, il) => {
    const hip = bone(il, body, sx * D.hipX, D.hipY, 0);
    const knee = bone(il + 1, hip, 0, -D.thigh, 0);
    const foot = bone(il + 2, knee, 0, -D.shin, 0);
    return { hip, knee, foot };
  };
  const lL = leg(-1, BONE.legL), lR = leg(1, BONE.legR);
  const cane = bone(BONE.cane, aR.hand, 0.008 * k, -0.065 * k, -0.02 * k);
  const J = { group, body, pelvis, torso, chest, head,
    armL: aL.shoulder, armR: aR.shoulder, elbowL: aL.elbow, elbowR: aR.elbow, handL: aL.hand, handR: aR.hand,
    legL: lL.hip, legR: lR.hip, kneeL: lL.knee, kneeR: lR.knee, footL: lL.foot, footR: lR.foot, cane };
  return { bones, J, collarL: aL.collar, collarR: aR.collar };
}
