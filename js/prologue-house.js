import * as THREE from 'three';
import { scenery } from './prologue-kit.js';

// Vašek's house: Dražkovická 119, the gabled house on the corner of Nemošická
// in Pardubice. Outside it gets what makes a mapped box somebody's home (a
// door under a porch lamp, the number, a letter box, a bench and flower pots);
// inside is one hand-built room, the kitchen with the table where part one
// ends. The room is a closed set far below the house, like the hospital room.
//
// Door frame: local −z points out of the west wall to the street, +x along the
// wall to the north. Room frame: x across, z from his chair (−) to Vašek's (+).
export const house = { x: 1215.45, z: 1448, h: Math.PI / 2, kerb: { x: 1209.6, z: 1448.5 } };
export const doorAt = (x, z) => ({ x: house.x + z, z: house.z - x });
export const DEPTH = 46; // metres the room lies under the street

function exterior(k) {
  const wood = 0x5b3a26;
  k.box(0, 0.09, -0.55, 1.9, 0.18, 1.1, 0x9a968c);
  k.box(0, 0.27, -0.3, 1.5, 0.18, 0.6, 0xa4a096);
  k.box(0, 1.42, -0.03, 1.22, 2.3, 0.1, 0x3b2a1f);
  k.box(0, 1.4, -0.09, 0.98, 2.08, 0.06, wood);
  for (const y of [0.85, 1.75]) k.box(0, y, -0.125, 0.7, 0.62, 0.02, 0x6a4630);
  k.box(0, 2.12, -0.13, 0.5, 0.26, 0.02, 0xffcf8f, 0, true);
  for (const x of [-0.2, 0.2]) k.box(x, 1.75, -0.136, 0.2, 0.44, 0.012, 0xffc27a, 0, true);
  k.box(0.38, 1.36, -0.14, 0.04, 0.16, 0.05, 0xc9b27a);
  // porch roof on two brackets, the lamp under it
  k.box(0, 2.78, -0.62, 2.1, 0.08, 1.3, 0x5a2f26);
  k.box(0, 2.84, -0.62, 2.2, 0.04, 1.4, 0x7a3d30);
  for (const x of [-0.9, 0.9]) k.box(x, 2.5, -0.5, 0.06, 0.5, 0.06, 0x3b2a1f);
  k.box(0.78, 2.3, -0.16, 0.16, 0.22, 0.16, 0x2c2f31);
  k.box(0.78, 2.28, -0.18, 0.11, 0.15, 0.11, 0xffdca8, 0, true);
  k.sign(-0.95, 2.05, -0.07, 0.42, 0.26, ['119'], Math.PI, '#1c3f78');
  k.box(-0.95, 1.45, -0.1, 0.32, 0.24, 0.12, 0x8b1f1c);
  k.box(-0.95, 1.5, -0.165, 0.2, 0.02, 0.01, 0x1a1a1a);
  k.box(0, 0.365, -0.3, 0.8, 0.02, 0.45, 0x4b3b2b); // mat
  // pots with geraniums either side, a bench under the window, a broom
  for (const x of [-1.25, 1.25]) {
    k.box(x, 0.22, -0.5, 0.36, 0.44, 0.36, 0xa85d3b);
    k.box(x, 0.56, -0.5, 0.5, 0.34, 0.5, 0x3f6a34, 0, false, 'round');
    for (const [dx, dz] of [[0.12, 0.1], [-0.1, -0.08], [0.02, -0.16]]) k.box(x + dx, 0.7, -0.5 + dz, 0.11, 0.1, 0.11, 0xc9342f, 0, false, 'round');
  }
  for (let n = 0; n < 3; n++) k.box(2.9, 0.46, -0.3 - n * 0.13, 1.5, 0.035, 0.11, 0x7b5a3a);
  for (const x of [2.25, 3.55]) k.box(x, 0.23, -0.42, 0.06, 0.46, 0.42, 0x33373a);
  k.box(2.9, 0.75, -0.2, 1.5, 0.3, 0.035, 0x7b5a3a);
  k.box(-2.2, 0.8, -0.14, 0.035, 1.6, 0.035, 0x9a7b4f, 0.06);
  k.box(-2.2, 0.08, -0.18, 0.3, 0.16, 0.09, 0xb89650);
}

function interior(k) {
  const wall = 0xd9cfbb,
    panel = 0x9a7a55,
    wood = 0x7a5333,
    steel = 0x9aa2a4;
  // shell: boarded floor, wainscot, ceiling with a beam
  for (let i = 0; i < 15; i++) k.box(-2.8 + i * 0.4, -0.04, 0, 0.39, 0.08, 5, i % 2 ? 0x8a6238 : 0x805a33);
  k.box(0, 2.72, 0, 6, 0.1, 5, 0xe7e1d2);
  k.box(0, 2.58, 0.2, 6, 0.18, 0.2, 0x5a3f28);
  for (const x of [-3, 3]) {
    k.box(x, 1.35, 0, 0.1, 2.7, 5, wall);
    k.box(x * 0.985, 0.5, 0, 0.03, 1.0, 5, panel);
  }
  for (const z of [-2.5, 2.5]) {
    k.box(0, 1.35, z, 6, 2.7, 0.1, wall);
    k.box(0, 0.5, z * 0.982, 6, 1.0, 0.03, panel);
  }
  // ---- the table and four chairs, a rug under them, the lamp over them
  k.box(0, 0.012, 0, 2.6, 0.02, 2.3, 0x7d3a34);
  k.box(0, 0.016, 0, 2.3, 0.02, 2.0, 0x9a5a48);
  k.box(0, 0.74, 0, 1.5, 0.05, 0.82, wood);
  for (const x of [-0.66, 0.66]) for (const z of [-0.33, 0.33]) k.box(x, 0.36, z, 0.07, 0.72, 0.07, 0x5f3f27);
  for (const [x, z, back] of [
    [0, -0.78, -1],
    [0, 0.78, 1],
    [-1.0, 0, 0],
    [1.0, 0, 0],
  ]) {
    k.box(x, 0.45, z, 0.44, 0.045, 0.44, 0x6b4a2e);
    for (const dx of [-0.19, 0.19]) for (const dz of [-0.19, 0.19]) k.box(x + dx, 0.225, z + dz, 0.04, 0.45, 0.04, 0x54381f);
    if (back) {
      k.box(x, 0.86, z + back * 0.21, 0.44, 0.34, 0.04, 0x6b4a2e);
      for (const dx of [-0.19, 0.19]) k.box(x + dx, 0.68, z + back * 0.21, 0.04, 0.46, 0.04, 0x54381f);
    } else {
      const s = Math.sign(x);
      k.box(x + s * 0.21, 0.86, z, 0.04, 0.34, 0.44, 0x6b4a2e);
      for (const dz of [-0.19, 0.19]) k.box(x + s * 0.21, 0.68, z + dz, 0.04, 0.46, 0.04, 0x54381f);
    }
  }
  k.box(0, 2.3, 0, 0.02, 0.75, 0.02, 0x2a2a2a);
  k.box(0, 1.9, 0, 0.46, 0.2, 0.46, 0x9a3b2c, 0, false, 'round');
  k.box(0, 1.84, 0, 0.3, 0.1, 0.3, 0xffe1a8, 0, true, 'round');
  // on the table: two bottles, an ashtray, his car keys, a newspaper
  for (const [x, z] of [[0.42, 0.12], [0.3, 0.26]]) {
    k.box(x, 0.86, z, 0.065, 0.2, 0.065, 0x4d3219);
    k.box(x, 0.99, z, 0.03, 0.08, 0.03, 0x4d3219);
  }
  k.box(-0.4, 0.78, 0.2, 0.15, 0.03, 0.15, 0x8e969a, 0, false, 'round');
  k.box(-0.5, 0.775, -0.18, 0.09, 0.012, 0.05, 0x25282a);
  k.box(-0.42, 0.775, -0.16, 0.05, 0.01, 0.05, steel, 0, false, 'round');
  k.box(0.1, 0.772, -0.05, 0.36, 0.008, 0.26, 0xd8d3c4);
  // ---- kitchen run on the far wall: cupboards, sink, cooker, fridge, window
  k.box(-0.9, 0.44, 2.16, 3.9, 0.88, 0.6, 0xb9a98a);
  k.box(-0.9, 0.9, 2.14, 3.96, 0.04, 0.66, 0x4a4540);
  for (let i = 0; i < 6; i++) {
    k.box(-2.52 + i * 0.65, 0.46, 1.855, 0.6, 0.76, 0.012, 0xc7b797);
    k.box(-2.52 + i * 0.65, 0.72, 1.845, 0.14, 0.02, 0.02, steel);
  }
  k.box(-1.6, 0.93, 2.1, 0.7, 0.03, 0.44, steel);
  k.box(-1.6, 1.08, 2.33, 0.03, 0.3, 0.03, steel);
  k.box(-1.6, 1.22, 2.24, 0.03, 0.03, 0.2, steel);
  k.box(0.2, 0.93, 2.1, 0.6, 0.02, 0.5, 0x1d1f20);
  k.box(0.08, 1.0, 2.05, 0.24, 0.13, 0.24, 0xa63a2e, 0, false, 'round');
  k.box(-0.55, 1.02, 2.2, 0.16, 0.22, 0.16, 0xd9d9d6);
  k.box(-0.9, 1.95, 2.3, 3.9, 0.7, 0.32, 0xb9a98a);
  for (let i = 0; i < 6; i++) k.box(-2.52 + i * 0.65, 1.95, 2.135, 0.6, 0.62, 0.012, 0xc7b797);
  k.box(1.95, 0.95, 2.12, 0.72, 1.9, 0.68, 0xdfe2e0);
  k.box(1.95, 1.32, 1.775, 0.68, 0.02, 0.012, 0xa9aeac);
  k.box(1.68, 1.0, 1.765, 0.03, 0.5, 0.03, steel);
  // window over the sink: night outside, a street lamp, a net curtain
  k.box(-1.6, 1.52, 2.44, 1.2, 0.9, 0.04, 0x33302b);
  k.box(-1.6, 1.52, 2.43, 1.08, 0.78, 0.02, 0x141d33, 0, true);
  k.box(-1.25, 1.62, 2.42, 0.08, 0.08, 0.02, 0xffc980, 0, true, 'round');
  k.box(-1.6, 1.52, 2.415, 0.04, 0.78, 0.02, 0x33302b);
  for (let i = 0; i < 7; i++) k.box(-2.12 + i * 0.07, 1.6, 2.39, 0.06, 0.72, 0.012, 0xeae6da, 0, false, 'glass');
  // ---- the door they came in by, coats, boots, a mirror
  k.box(1.9, 1.05, -2.44, 0.96, 2.1, 0.06, 0x5b3a26);
  k.box(1.9, 1.05, -2.47, 1.1, 2.24, 0.04, 0x3b2a1f);
  k.box(1.55, 1.02, -2.4, 0.04, 0.14, 0.05, 0xc9b27a);
  k.box(0.75, 1.7, -2.42, 0.9, 0.06, 0.05, 0x5f3f27);
  for (const [x, c] of [[0.5, 0x3f4f3a], [0.8, 0x2b3550], [1.05, 0x6b3a2a]]) k.box(x, 1.28, -2.36, 0.26, 0.8, 0.12, c, 0, false, 'round');
  for (const x of [0.5, 0.78]) k.box(x, 0.08, -2.25, 0.14, 0.16, 0.3, 0x26221f);
  // ---- the other end of the room: a sofa, a low table, the television
  k.box(-2.45, 0.3, -1.0, 0.9, 0.44, 2.0, 0x55616b);
  k.box(-2.82, 0.66, -1.0, 0.22, 0.6, 2.0, 0x4b5660);
  for (const z of [-1.9, -0.1]) k.box(-2.45, 0.5, z, 0.9, 0.3, 0.2, 0x4b5660);
  k.box(-2.4, 0.56, -1.5, 0.5, 0.14, 0.5, 0xa9623f, 0.2, false, 'round');
  k.box(-2.3, 0.2, 1.1, 0.6, 0.4, 1.1, 0x4a3524);
  k.box(-2.36, 0.72, 1.1, 0.06, 0.6, 1.0, 0x16181a);
  k.box(-2.325, 0.72, 1.1, 0.012, 0.54, 0.92, 0x7c9fd0, 0, true);
  // ---- the walls: a clock, the calendar, a shelf of jars, a framed photograph
  k.box(2.93, 1.9, -0.6, 0.04, 0.36, 0.36, 0xece7da, 0, false, 'round');
  k.box(2.9, 1.95, -0.6, 0.012, 0.13, 0.02, 0x1c1c1c);
  k.box(2.9, 1.9, -0.55, 0.012, 0.02, 0.1, 0x1c1c1c);
  k.sign(2.94, 1.5, 0.9, 0.42, 0.58, ['LISTOPAD', '18'], -Math.PI / 2, '#f2eee2', '#8b1f1c');
  k.box(2.86, 1.42, -1.7, 0.2, 0.03, 0.9, 0x5f3f27);
  for (let i = 0; i < 4; i++) k.box(2.86, 1.53, -2.02 + i * 0.22, 0.1, 0.19, 0.1, [0xb9783a, 0x6d7f3f, 0xc8b25a, 0x8a3a2a][i], 0, false, 'round');
  k.box(-2.94, 1.75, 0.2, 0.03, 0.42, 0.56, 0x3b2a1f);
  k.box(-2.92, 1.75, 0.2, 0.012, 0.34, 0.48, 0xb9a98a);
}

export function vasekHouse(scene, world) {
  const outside = new THREE.Group(),
    inside = new THREE.Group(),
    ok = scenery(outside),
    ik = scenery(inside);
  outside.name = 'Pardubice • Dražkovická 119';
  inside.name = 'Pardubice • Vaškova kuchyň';
  const step = doorAt(0, -1.2);
  const ground = world.terrain.heightAt(step.x, step.z);
  outside.position.set(house.x, ground, house.z);
  outside.rotation.y = house.h;
  exterior(ok);
  ok.finish();
  inside.position.set(house.x + 5, ground - DEPTH, house.z);
  interior(ik);
  ik.finish();
  inside.visible = false;
  // the balaclava he pushes across the table
  const mask = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 8), new THREE.MeshLambertMaterial({ color: 0x141416 }));
  mask.scale.set(0.24, 0.07, 0.2);
  mask.visible = false;
  inside.add(mask);
  scene.add(outside, inside);
  return {
    ground,
    // room frame → world
    room(x, y, z, out = new THREE.Vector3()) {
      return out.set(inside.position.x + x, inside.position.y + y, inside.position.z + z);
    },
    door: doorAt(0, -1.0),
    show(on) {
      inside.visible = on;
    },
    mask,
    dispose() {
      mask.geometry.dispose();
      mask.material.dispose();
      ok.dispose();
      ik.dispose();
    },
  };
}
