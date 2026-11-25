// ---- fist.js: closing a modelled hand into a fist --------------------------
//
// The retarget (js/characters/retarget.js) has no slot for a finger, so a
// finger keeps whatever angle the body's own clip gives it, and every Rocketbox
// clip holds them still and open. That is right for walking and wrong for a
// punch: a flat hand thrown at somebody reads as a shove, which is exactly what
// Frank saw (25 Nov 2026, "ona to tak jako strčí, ale nebouchne to jako pěstí").
//
// So the fingers are curled here, on top of the resolved pose, by an amount
// the owner asks for (0 open, 1 a fist). Everything is measured once per
// skeleton from its bind pose, by position and not by bone axes, so it works on
// any rig whose fingers are chains under the hand:
//
//   * each child chain of a hand bone is a finger; the one named like a thumb
//     (thumb, Finger0) is the thumb;
//   * "across the hand" runs from the knuckle farthest from the thumb to the
//     nearest one, and the palm is the side the thumb sits on;
//   * a finger segment curls about (its own direction x the palm normal),
//     taken into the bone's own frame, so the curl follows the hand wherever
//     the arm puts it.
//
// Pure arithmetic on flat arrays; three.js only for its quaternion type.

import * as THREE from 'three';
import { SLOT } from './skeletonmap.js';

// radians per segment, knuckle to tip: a fist is about 90 + 100 + 60 degrees
const CURL = [1.45, 1.6, 1.0];
const THUMB = [0.35, 0.55, 0.7];
const THUMB_RE = /thumb|finger0$/i;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _q = new THREE.Quaternion(), _r = new THREE.Quaternion(), _w = new THREE.Quaternion();

const P = (rig, i, v) => v.set(rig.worldP[i * 3], rig.worldP[i * 3 + 1], rig.worldP[i * 3 + 2]);

// the chains of bones under bone h: [[base, mid, tip...], ...]
function chains(rig, h) {
  const kids = (i) => { const out = []; for (let j = 0; j < rig.n; j++) if (rig.parent[j] === i) out.push(j); return out; };
  const out = [];
  for (const base of kids(h)) {
    if (rig.boneSlot[base] >= 0) continue;              // a slot bone under the hand is not a finger
    const c = [base];
    for (let k = kids(base); k.length; k = kids(k[0])) {
      if (/nub|leaf|end$/i.test(rig.names[k[0]])) break;
      c.push(k[0]);
    }
    out.push(c);
  }
  return out;
}

/**
 * The fist of one skeleton: { bones: Int16Array, axis: Float32Array (local
 * x, y, z per bone), ang: Float32Array }. Empty when the rig has no fingers.
 */
export function makeFist(rig) {
  const bones = [], axis = [], ang = [];
  for (const side of ['L', 'R']) {
    const h = rig.slotBone[SLOT['hand' + side]];
    if (h < 0) continue;
    const cs = chains(rig, h);
    if (cs.length < 2) continue;
    const thumb = cs.find((c) => THUMB_RE.test(rig.names[c[0]])) ?? null;
    const fingers = cs.filter((c) => c !== thumb);
    if (!fingers.length) continue;
    // knuckles nearest and farthest from the thumb: index and little finger
    const tb = thumb ? P(rig, thumb[0], new THREE.Vector3()) : null;
    const by = (c) => (tb ? P(rig, c[0], _a).distanceToSquared(tb) : 0);
    const sorted = fingers.slice().sort((x, y) => by(x) - by(y));
    const index = sorted[0], little = sorted[sorted.length - 1];
    const hand = P(rig, h, new THREE.Vector3());
    // the way the fingers point: the hand to the middle of the knuckles
    const knuck = new THREE.Vector3();
    for (const c of fingers) knuck.add(P(rig, c[0], _a));
    knuck.multiplyScalar(1 / fingers.length);
    const along = knuck.clone().sub(hand).normalize();
    const across = P(rig, index[0], new THREE.Vector3()).sub(P(rig, little[0], _a));
    across.addScaledVector(along, -across.dot(along)).normalize();
    // the palm is the side the thumb is on; without a thumb, guess from the side
    let palm = new THREE.Vector3().crossVectors(along, across).normalize();
    if (tb) {
      const t = _b.copy(tb).sub(knuck);
      if (t.dot(palm) < 0) palm.negate();
    }
    const add = (c, a, k) => {
      for (let s = 0; s < c.length; s++) {
        const i = c[s];
        // this segment's direction: toward its child, or its parent's for the tip
        const j = s + 1 < c.length ? c[s + 1] : -1;
        if (j >= 0) P(rig, j, _c).sub(P(rig, i, _d)); else P(rig, i, _c).sub(P(rig, s > 0 ? c[s - 1] : h, _d));
        if (_c.lengthSq() < 1e-10) continue;
        _c.normalize();
        // rotating the direction about (dir x palm) by a positive angle turns it toward the palm
        _a.crossVectors(_c, palm);
        if (_a.lengthSq() < 1e-8) continue;
        _a.normalize();
        _q.fromArray(rig.worldQ, i * 4).conjugate();
        _a.applyQuaternion(_q);
        bones.push(i); axis.push(_a.x, _a.y, _a.z); ang.push((a[s] ?? a[a.length - 1]) * k);
      }
    };
    for (const c of fingers) add(c, CURL, 1);
    if (thumb) add(thumb, THUMB, 1);
  }
  return { bones: Int16Array.from(bones), axis: Float32Array.from(axis), ang: Float32Array.from(ang) };
}

/** Curl the fingers of `cur` (local rotations, x y z w) by w (0 open .. 1 fist). */
export function applyFist(fist, cur, w) {
  if (!(w > 0) || !fist || !fist.bones.length) return;
  const { bones, axis, ang } = fist;
  for (let k = 0; k < bones.length; k++) {
    const o = bones[k] * 4;
    _r.setFromAxisAngle(_a.set(axis[k * 3], axis[k * 3 + 1], axis[k * 3 + 2]), ang[k] * w);
    _w.fromArray(cur, o).multiply(_r).toArray(cur, o);
  }
}
