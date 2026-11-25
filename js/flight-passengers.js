// ---- flight-passengers.js: the other people on the flight ----
// An empty narrowbody to the Seychelles would be the strangest thing in the
// game. From seat 14A what a passenger sees of the others is the back of a
// head over every seat back ahead, a shoulder across the aisle and somebody's
// elbow on the armrest: so they are drawn as exactly that much. Two
// InstancedMeshes in the airliner's own frame (torso, head with its hair),
// about two seats in three taken, chosen by a hash of the seat so the same
// people sit in the same places every time; 14A is the player's, and 14B and
// 14C stay free so he can get to it. The game's modelled people would cost a
// skeleton each, for a hundred backs of heads.

import * as THREE from 'three';
import { SEATS, SEAT, AIRLINER } from './airliner-layout.js';

const SHIRTS = [0x2d3e50, 0x8e2b2b, 0xd9d4c7, 0x3b5d3a, 0x1f1f24, 0x6b7f99, 0xb8862f, 0xe7e2da, 0x4a2f4f, 0x7d8c8a];
const SKIN = [0xf1c9a9, 0xe0ac82, 0xc68a5f, 0x8d5a3b, 0x5a3825, 0xf5d6bf];
const HAIR = [0x1c1410, 0x3b2a1e, 0x6b4b2e, 0xa98458, 0xd7c49a, 0x8a8a88, 0x2a2a2a];
const hash = (a, b) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export function flightPassengers(parent, keepFree = ['14A', '14B', '14C']) {
  const taken = SEATS.filter((s) => !keepFree.includes(s.row + s.letter) && hash(s.row * 7 + 3, s.letter.charCodeAt(0)) < 0.68);
  const torso = new THREE.BoxGeometry(0.42, 0.6, 0.24);
  const head = new THREE.IcosahedronGeometry(0.105, 1);
  const hair = new THREE.SphereGeometry(0.112, 10, 6, 0, Math.PI * 2, 0, Math.PI * 0.55);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  // the cabin is lit by its own lights: a little emissive keeps them from going black at night
  mat.emissive = new THREE.Color(0x222222);
  const bodies = new THREE.InstancedMesh(torso, mat, taken.length);
  const heads = new THREE.InstancedMesh(head, mat, taken.length);
  const hairs = new THREE.InstancedMesh(hair, mat, taken.length);
  const o = new THREE.Object3D(), col = new THREE.Color();
  const cushion = AIRLINER.floorY + SEAT.cushionY;
  taken.forEach((s, i) => {
    const r1 = hash(s.row, s.letter.charCodeAt(0) + 11), r2 = hash(s.row + 40, s.letter.charCodeAt(0));
    const lean = (r1 - 0.5) * 0.12, tall = 0.94 + r2 * 0.12;
    o.position.set(s.x + lean * 0.4, cushion + 0.36 * tall, s.z + 0.1);
    o.rotation.set(-0.1, 0, lean);
    o.scale.set(1, tall, 1);
    o.updateMatrix();
    bodies.setMatrixAt(i, o.matrix);
    bodies.setColorAt(i, col.setHex(SHIRTS[Math.floor(r1 * SHIRTS.length)]));
    o.position.set(s.x + lean * 0.8, cushion + 0.8 * tall, s.z + 0.12);
    o.rotation.set(0, (r2 - 0.5) * 0.8, 0);
    o.scale.set(1, 1.12, 1.05);
    o.updateMatrix();
    heads.setMatrixAt(i, o.matrix);
    heads.setColorAt(i, col.setHex(SKIN[Math.floor(r2 * SKIN.length)]));
    o.position.y += 0.02;
    o.rotation.x = 0.35; // the hair sits further back than the face
    o.updateMatrix();
    hairs.setMatrixAt(i, o.matrix);
    hairs.setColorAt(i, col.setHex(HAIR[Math.floor(hash(s.row + 9, s.letter.charCodeAt(0) + 5) * HAIR.length)]));
  });
  const group = new THREE.Group();
  group.name = 'Let • cestující';
  group.add(bodies, heads, hairs);
  for (const m of group.children) { m.frustumCulled = false; m.instanceMatrix.needsUpdate = true; }
  group.visible = false;
  parent.add(group);
  return {
    count: taken.length,
    show(on) { group.visible = on; },
    dispose() {
      group.removeFromParent();
      torso.dispose(); head.dispose(); hair.dispose(); mat.dispose();
      bodies.dispose(); heads.dispose(); hairs.dispose();
    },
  };
}
