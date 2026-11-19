// ---- props.js: what a modelled person holds --------------------------------------
// The lofted citizen builds its carrier bag and its phone into its own mesh
// (js/bodyextras.js). A downloaded human cannot, so the same two things are
// small meshes on the hand socket (js/characters/human.js), shaped and placed
// by the same numbers. Geometry is shared by everybody; a material per colour.
// A pram and a dog are drawn elsewhere (js/pedpropdraw.js, js/dogs.js) and
// only need the hand, which the socket already is.

import * as THREE from 'three';
import { patchPeopleMaterial } from '../peoplemat.js';

let bagGeo = null, phoneGeo = null;
const mats = new Map();

function material(hex) {
  let m = mats.get(hex);
  if (!m) mats.set(hex, m = patchPeopleMaterial(new THREE.MeshStandardMaterial({ color: hex, roughness: 0.8, metalness: 0 }), 'people-prop-1'));
  return m;
}

// a carrier bag: gathered where the handles hold it, full and squarish below
function bag() {
  if (bagGeo) return bagGeo;
  const g = new THREE.BoxGeometry(0.10, 0.31, 0.26, 1, 3, 1), p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), u = (y + 0.155) / 0.31;          // 0 at the bottom, 1 at the handles
    const s = u > 0.95 ? 0.28 : u > 0.6 ? 0.82 : 1.08;
    p.setX(i, p.getX(i) * s); p.setZ(i, p.getZ(i) * s);
  }
  g.translate(0, -0.30 + 0.035, -0.005);
  g.computeVertexNormals();
  return (bagGeo = g);
}
function phone() {
  if (!phoneGeo) { phoneGeo = new THREE.BoxGeometry(0.014, 0.148, 0.074); phoneGeo.translate(-0.016, -0.085, -0.004); }
  return phoneGeo;
}

/**
 * Hang `key` ('bag' | 'phone') on a hand socket. `k` is the body's size
 * against the reference adult. Returns the mesh (to hide when the body goes
 * far), or null for anything that is not carried in the hand.
 */
export function addHandProp(socket, key, tint, k = 1) {
  if (key !== 'bag' && key !== 'phone') return null;
  const m = new THREE.Mesh(key === 'bag' ? bag() : phone(), material(key === 'bag' ? (tint ?? 0xe9e7e0) : 0x16181c));
  m.scale.setScalar(k);
  m.castShadow = false;
  m.renderOrder = 1;
  socket.add(m);
  return m;
}

/** Tests and a hard reset. */
export function disposeProps() {
  bagGeo?.dispose(); phoneGeo?.dispose(); bagGeo = phoneGeo = null;
  for (const m of mats.values()) m.dispose();
  mats.clear();
}
