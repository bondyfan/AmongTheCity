// ---- signalmodel.js: what a traffic signal is made of -----------------------
// The signal used to be a stick with a box and three smaller boxes. This is the
// thing that actually stands at a Czech crossing: a mast on a flange, a black
// three-lens head hung in front of it on a backplate, a hood over every lens,
// and lower down, turned ninety degrees to face the people waiting on the far
// kerb, the two-lens pedestrian head.
//
// One geometry and material set for EVERY mast in the region. A light changes
// by swapping the material on a lens mesh, nothing else (js/traffic.js owns the
// schedule and the swapping; this file only says what the parts look like).
//
// Frame: base on the origin, y up, the vehicle lenses on the head's -z face
// (a mast is yawed so that -z looks at the drivers rolling up). Local +x is
// then the carriageway side of a right-kerb mast, which is where the
// pedestrian head looks.
//
// Built lazily: headless tests import traffic.js and never ask for these.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';

/** Vehicle lens centres, top down (red, amber, green), and their face plane. */
export const LAMP_Y = [3.24, 2.96, 2.68], LAMP_Z = -0.292;
/** Pedestrian lens centres (stop, walk) on the +x face of the lower head. */
export const PED_Y = [2.27, 2.05], PED_X = 0.262;

const plain = (g) => { const n = g.index ? g.toNonIndexed() : g; n.deleteAttribute('uv'); return n; };

let _S = null;
export function sigAssets() {
  if (_S) return _S;
  // ---- the mast: flange, shaft, and the two brackets the heads hang on
  const pole = mergeGeometries([
    new THREE.CylinderGeometry(0.13, 0.13, 0.03, 10).translate(0, 0.015, 0),
    new THREE.CylinderGeometry(0.058, 0.072, 0.9, 8).translate(0, 0.48, 0),
    new THREE.CylinderGeometry(0.05, 0.058, 2.62, 8).translate(0, 2.24, 0),
    new THREE.CylinderGeometry(0.062, 0.062, 0.04, 8).translate(0, 3.57, 0),
    new THREE.BoxGeometry(0.06, 0.06, 0.14).translate(0, 3.2, -0.1),
    new THREE.BoxGeometry(0.06, 0.06, 0.14).translate(0, 2.7, -0.1),
  ].map(plain), false);
  // ---- the heads: housings, the backplate, a hood per lens
  const parts = [
    new THREE.BoxGeometry(0.29, 0.9, 0.2).translate(0, 2.96, -0.19),
    // the backplate is what makes a lit lens readable against a bright sky
    new THREE.BoxGeometry(0.56, 1.14, 0.018).translate(0, 2.96, -0.1),
    // the pedestrian head, on the carriageway side of the mast
    new THREE.BoxGeometry(0.2, 0.5, 0.25).translate(0.16, 2.16, 0),
  ];
  for (const y of LAMP_Y) {
    // a hood: the top two thirds of a short tube, open toward the driver
    const hood = new THREE.CylinderGeometry(0.125, 0.125, 0.17, 10, 1, true, Math.PI * 0.38, Math.PI * 1.24)
      .rotateX(Math.PI / 2).translate(0, y, LAMP_Z - 0.08);
    parts.push(hood);
  }
  for (const y of PED_Y) {
    parts.push(new THREE.BoxGeometry(0.1, 0.012, 0.23).translate(PED_X + 0.045, y + 0.1, 0));
  }
  const head = mergeGeometries(parts.map(plain), false);
  // lenses: a disc for vehicles (faces -z), a rounded square for people (+x)
  const lamp = plain(new THREE.CircleGeometry(0.098, 16).rotateY(Math.PI));
  const ped = plain(new THREE.CircleGeometry(0.088, 4, Math.PI / 4).rotateY(Math.PI / 2));
  const mat = (c, extra) => new THREE.MeshLambertMaterial({ color: c, ...extra });
  // a lit lens is overbright so the bloom pass finds it; signalNight() keeps
  // that constant to the eye when the night exposure opens up
  const lit = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e, emissiveIntensity: LIT });
  _S = {
    pole, head, lamp, ped,
    poleMat: mat(0x6f7479),
    headMat: mat(0x15171a, { side: THREE.DoubleSide }),
    redOff: mat(0x2c0c0c), ambOff: mat(0x2e2109), grnOff: mat(0x0a2412),
    redOn: lit(0xff3524, 0xff2a1c), ambOn: lit(0xffb02e, 0xffa018), grnOn: lit(0x3dff8a, 0x22ff6a),
  };
  return _S;
}

// What a lit lens is worth on screen: its emissive times the exposure. Tuned by
// day (exposure 0.82) at the 2.2 the old box lamps had, a little over.
const LIT = 2.86, LIT_DAY_EXPOSURE = 0.86;   // (3.0 at 0.82: the same product, sky.js raised the day exposure)

/**
 * Once a frame: hold the lenses at one brightness TO THE EYE. sky.js opens the
 * exposure to 2.5 after dark, which would take a 3.0 emissive to 9 and burn
 * every signal in the city to a white disc with no colour left in it.
 */
export function signalNight(exposure) {
  if (!_S) return;
  // (more than the plain ratio: at night the bloom adds its own share, and a
  // lens held at the same product read as a pale disc with the red gone. The
  // square of the ratio, about 0.3 at midnight, is where the green is green:
  // at a power of 1.5 it was still mint.)
  const k = LIT * Math.pow(LIT_DAY_EXPOSURE / Math.max(0.3, exposure || LIT_DAY_EXPOSURE), 2);
  _S.redOn.emissiveIntensity = _S.ambOn.emissiveIntensity = _S.grnOn.emissiveIntensity = k;
}
