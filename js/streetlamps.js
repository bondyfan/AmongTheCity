// ---- streetlamps.js: what a Czech street lamp is made of --------------------
// Two luminaires light this country's streets and both are here as geometry:
//
//   STREET  the galvanised column every through street has: a base plate bolted
//           to the pavement, a wider door section, a tapered shaft, an arm that
//           sweeps up and OUT over the carriageway, and a flat LED head whose
//           lens looks straight down at the road.
//   PARK    the short column of footways, squares and parks: four metres of
//           slim shaft and a round lantern on top, lit all the way round.
//   MAST    the tall galvanised mast of a lit motorway interchange (round 9):
//           twelve metres of tapered octagonal shaft on a bolted flange, and
//           at the top two arms, one over the carriageway and one back over
//           the verge or the slip road beside it, each with a flat LED head.
//   MAST1   the same mast with the one arm, beside a slip road.
//
// Frame of both: y up, the column on the origin, and the STREET arm reaching
// toward local -z. A lamp instance is yawed by a heading, and a heading's
// forward is -z, so "rot faces the carriageway" puts the head over the road.
// (The arm used to lie along +x, which is along the kerb: every lamp in the
// city held its head over the pavement it stood on.)
//
// Each kind is two geometries because the chunk draws it as two InstancedMeshes:
// the steel (mats.lampPost, shaded) and the lens (mats.lampHead, emissive after
// dusk). poles.js merges the two into the one mesh that falls over.
//
// Worker-safe: three.js geometry only, no DOM.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';

/** Where the STREET lens sits: metres out from the column toward the road, and up. */
export const HEAD_OUT = 1.8, HEAD_Y = 7.42;
/** Where the PARK lantern sits: on the column axis, this high. */
export const PARK_Y = 4.0;
/** Where a MAST's lenses sit: metres out along each arm, and up. */
export const MAST_OUT = 3.0, MAST_Y = 12.05;
/** The kinds a lamp batch can be (meshes.lampBatch names its meshes after them). */
export const LAMP_KINDS = Object.freeze(['street', 'park', 'mast', 'mast1']);

const _cache = new Map();

function street() {
  const parts = [];
  // base plate, bolted down: it is what says "this stands ON the pavement"
  parts.push(new THREE.BoxGeometry(0.34, 0.03, 0.34).translate(0, 0.015, 0));
  // the door section, then the tapered shaft
  parts.push(new THREE.CylinderGeometry(0.078, 0.086, 1.15, 8, 1).translate(0, 0.03 + 0.575, 0));
  parts.push(new THREE.CylinderGeometry(0.044, 0.07, 5.45, 8, 1).translate(0, 1.18 + 2.725, 0));
  // the arm: up out of the shaft, over, and nearly level by the time it ends
  const arm = new THREE.CubicBezierCurve3(
    new THREE.Vector3(0, 6.6, 0), new THREE.Vector3(0, 7.25, 0),
    new THREE.Vector3(0, 7.5, -0.55), new THREE.Vector3(0, 7.56, -1.5));
  parts.push(new THREE.TubeGeometry(arm, 8, 0.036, 6, false));
  // the head: a flat die-cast body, a hand thick, tipped up five degrees
  const body = new THREE.BoxGeometry(0.25, 0.075, 0.66).rotateX(0.09).translate(0, 7.5, -1.8);
  const neck = new THREE.BoxGeometry(0.11, 0.09, 0.2).rotateX(0.09).translate(0, 7.55, -1.47);
  parts.push(body, neck);
  const post = mergeGeometries(parts.map(plain), false);
  // the lens, a hair under the body so it never fights it
  const lens = new THREE.PlaneGeometry(0.19, 0.5).rotateX(Math.PI / 2).rotateX(0.09)
    .translate(0, 7.5 - 0.042, -1.81);
  return [post, plain(lens)];
}

function park() {
  const parts = [];
  parts.push(new THREE.CylinderGeometry(0.11, 0.13, 0.05, 8, 1).translate(0, 0.025, 0));
  parts.push(new THREE.CylinderGeometry(0.05, 0.062, 0.9, 8, 1).translate(0, 0.5, 0));
  parts.push(new THREE.CylinderGeometry(0.036, 0.048, 2.9, 8, 1).translate(0, 2.4, 0));
  // the lantern's hat: a shallow cone over a rim
  parts.push(new THREE.CylinderGeometry(0.23, 0.23, 0.03, 12, 1).translate(0, PARK_Y + 0.115, 0));
  parts.push(new THREE.ConeGeometry(0.23, 0.09, 12, 1).translate(0, PARK_Y + 0.175, 0));
  // …and the collar the diffuser sits in
  parts.push(new THREE.CylinderGeometry(0.1, 0.05, 0.1, 8, 1).translate(0, PARK_Y - 0.14, 0));
  const post = mergeGeometries(parts.map(plain), false);
  // the opal diffuser: lit from every side, which is why a park reads as lit
  const glass = new THREE.CylinderGeometry(0.15, 0.1, 0.2, 10, 1, false).translate(0, PARK_Y + 0.0, 0);
  return [post, plain(glass)];
}

// A Czech motorway lighting mast (stožár veřejného osvětlení, 12 m, žárově
// zinkovaný): an octagonal cone on a square flange, a cap, and the arms bent
// up out of the top. `arms` 2 puts the second arm at 180 degrees (local +z).
function mast(arms) {
  const parts = [];
  parts.push(new THREE.BoxGeometry(0.5, 0.04, 0.5).translate(0, 0.02, 0));
  // the anchor bolts' nuts, four dark lumps on the flange
  for (const [bx, bz] of [[-0.19, -0.19], [0.19, -0.19], [-0.19, 0.19], [0.19, 0.19]]) {
    parts.push(new THREE.BoxGeometry(0.05, 0.05, 0.05).translate(bx, 0.065, bz));
  }
  const top = MAST_Y - 0.35;
  parts.push(new THREE.CylinderGeometry(0.075, 0.165, top - 0.04, 8, 1).translate(0, 0.04 + (top - 0.04) / 2, 0));
  parts.push(new THREE.CylinderGeometry(0.085, 0.085, 0.16, 8, 1).translate(0, top, 0));
  for (let a = 0; a < arms; a++) {
    const s = a === 0 ? -1 : 1;           // the first arm over the road (local -z)
    const arm = new THREE.CubicBezierCurve3(
      new THREE.Vector3(0, top - 0.05, 0), new THREE.Vector3(0, top + 0.3, s * 0.05),
      new THREE.Vector3(0, MAST_Y + 0.1, s * 0.9), new THREE.Vector3(0, MAST_Y + 0.12, s * (MAST_OUT - 0.45)));
    parts.push(new THREE.TubeGeometry(arm, 8, 0.045, 6, false));
    // the head: a long flat LED luminaire, tipped up five degrees off the road
    parts.push(new THREE.BoxGeometry(0.34, 0.1, 0.86).rotateX(-s * 0.09).translate(0, MAST_Y + 0.07, s * MAST_OUT));
  }
  const post = mergeGeometries(parts.map(plain), false);
  const lenses = [];
  for (let a = 0; a < arms; a++) {
    const s = a === 0 ? -1 : 1;
    lenses.push(plain(new THREE.PlaneGeometry(0.26, 0.66).rotateX(Math.PI / 2).rotateX(-s * 0.09)
      .translate(0, MAST_Y - 0.0, s * (MAST_OUT + 0.01))));
  }
  return [post, lenses.length > 1 ? mergeGeometries(lenses, false) : lenses[0]];
}

// position + normal only, non-indexed: one attribute set for every part, which
// is what the merge needs and all the two lamp materials read
function plain(g) {
  const n = g.index ? g.toNonIndexed() : g;
  n.deleteAttribute('uv');
  return n;
}

/** [post, lens] templates for a kind. Shared: CLONE before handing to a chunk. */
export function lampGeoms(kind) {
  let g = _cache.get(kind);
  if (!g) _cache.set(kind, g = kind === 'park' ? park() : kind === 'mast' ? mast(2)
    : kind === 'mast1' ? mast(1) : street());
  return g;
}

/** The one mesh a felled lamp becomes: steel and lens together, about its base. */
export function lampFallGeom(kind) {
  const k = 'fall:' + kind;
  let g = _cache.get(k);
  if (!g) _cache.set(k, g = mergeGeometries(lampGeoms(kind), false));
  return g;
}
