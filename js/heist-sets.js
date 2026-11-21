import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { farm, villa, villaAt, villaIn, city } from './heist-route.js';

// What part two adds to the places it happens in. The buildings are the map's
// own; these are the things a story needs on top of them: the farmyard's
// clutter, the villa's gate, camera and lean-to, the open lock-up. Boxes from
// the prologue's kit, each set one group that goes away with dispose().
const rnd = (seed) => {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
};

// --- Jarda's yard in Brozany: bales, hens, and a row of "tomatoes"
export function dressFarm(scene, world) {
  const group = new THREE.Group();
  group.name = 'Příběh • statek';
  const base = world.heightAt(farm.yard.x, farm.yard.z);
  group.position.set(farm.yard.x, base, farm.yard.z);
  scene.add(group);
  const k = scenery(group);
  const y = (x, z) => world.heightAt(farm.yard.x + x, farm.yard.z + z) - base;
  const r = rnd(41);
  // straw bales, stacked the way somebody meant to finish later
  for (const [x, z, n] of [[-5.2, 3.4, 3], [-3.9, 3.6, 2], [-5.0, 4.8, 2], [-3.6, 4.9, 1]])
    for (let i = 0; i < n; i++) k.box(x, y(x, z) + 0.26 + i * 0.5, z, 1.2, 0.5, 0.62, 0xc9a94e);
  // the hen house and its tenants
  k.box(-9.2, y(-9.2, 8.8) + 0.75, 8.8, 2.3, 1.2, 1.5, 0x6f4f33);
  k.box(-9.2, y(-9.2, 8.8) + 1.48, 8.8, 2.6, 0.12, 1.8, 0x3d3f42, 0.12);
  k.box(-8.0, y(-8.0, 8.2) + 0.3, 8.2, 0.05, 0.5, 0.34, 0x1d1a16);
  for (let i = 0; i < 7; i++) {
    const x = -7.6 + r() * 4.4, z = 6.4 + r() * 3.4, g = y(x, z), brown = r() > 0.5;
    k.box(x, g + 0.16, z, 0.2, 0.2, 0.3, brown ? 0x8a5a36 : 0xe8e2d4);
    k.box(x, g + 0.31, z - 0.13, 0.1, 0.12, 0.1, brown ? 0x8a5a36 : 0xe8e2d4);
    k.box(x, g + 0.39, z - 0.13, 0.03, 0.05, 0.08, 0xc62f24);
  }
  // the crop: tall, bushy, and labelled with a straight face
  for (let i = 0; i < 6; i++) {
    const x = -1.6 + i * 0.95, z = 9.6, g = y(x, z);
    k.box(x, g + 0.2, z, 0.5, 0.4, 0.5, 0x7a4630);
    k.box(x, g + 0.95, z, 0.07, 1.1, 0.07, 0x4f6b2a);
    for (let j = 0; j < 5; j++) k.box(x + (r() - 0.5) * 0.5, g + 0.7 + j * 0.24, z + (r() - 0.5) * 0.5, 0.42 - j * 0.05, 0.16, 0.42 - j * 0.05, j % 2 ? 0x3f7a2c : 0x4c8a34, (r() - 0.5) * 0.5);
  }
  k.box(1.0, y(1, 10.3) + 0.55, 10.3, 0.06, 1.1, 0.06, 0x6b4a2e);
  k.sign(1.0, y(1, 10.3) + 1.05, 10.26, 1.1, 0.42, ['RAJČATA'], Math.PI, '#e9dcc0', '#3b2a1a');
  // a wheelbarrow, a barrel, a lamp on the barn that still works
  k.box(-1.8, y(-1.8, -3) + 0.42, -3.0, 0.7, 0.36, 1.1, 0x3f5d45, 0);
  k.box(-1.8, y(-1.8, -3.7) + 0.2, -3.7, 0.1, 0.4, 0.4, 0x1c1c1c);
  k.box(2.6, y(2.6, -4.2) + 0.45, -4.2, 0.6, 0.9, 0.6, 0x2f5fa0, 0, false, 'round');
  k.box(-6.0, y(-6, 0) + 2.9, 0, 0.1, 5.8, 0.1, 0x5a5348);
  k.box(-5.7, y(-6, 0) + 5.6, 0, 0.5, 0.12, 0.3, 0x5a5348);
  k.box(-5.5, y(-6, 0) + 5.5, 0, 0.22, 0.1, 0.22, 0xffe2a8, 0, true);
  k.finish();
  return { lamp: { x: farm.yard.x - 5.5, y: base + y(-6, 0) + 5.3, z: farm.yard.z }, dispose: () => k.dispose() };
}

// --- the villa: a gate nobody shut, post nobody took, a camera that still blinks
export function dressVilla(scene, world) {
  const group = new THREE.Group();
  group.name = 'Příběh • vila';
  const base = world.heightAt(villa.x, villa.z);
  group.position.set(villa.x, base, villa.z);
  group.rotation.y = villaIn; // local −z runs up the drive (u), local x is v
  scene.add(group);
  const k = scenery(group);
  const g = (u, v) => {
    const p = villaAt(u, v);
    return world.heightAt(p.x, p.z) - base;
  };
  const r = rnd(7);
  // the fence along the forest road, and two stone pillars
  for (const side of [-1, 1])
    for (let i = 0; i < 9; i++) {
      const v = side * (2.9 + i * 1.7), y = g(-0.6, v);
      k.box(v, y + 0.75, 0.6, 0.09, 1.5, 0.09, 0x2c3a2c);
      if (i < 8) for (const h of [0.35, 0.85, 1.35]) k.box(v + side * 0.85, y + h, 0.6, 1.7, 0.05, 0.04, 0x2c3a2c);
    }
  for (const side of [-1, 1]) {
    k.box(side * 2.15, g(0, side * 2.15) + 0.95, 0.6, 0.52, 1.9, 0.52, 0x8d8475);
    k.box(side * 2.15, g(0, side * 2.15) + 1.96, 0.6, 0.64, 0.12, 0.64, 0x6f685c);
  }
  // one leaf of the gate hangs open along the drive, the other is on the ground
  k.box(-1.95, g(1.5, -1.95) + 0.72, -1.1, 0.05, 1.3, 2.9, 0x23302a);
  k.box(1.7, g(1.6, 1.7) + 0.05, -1.6, 2.9, 0.05, 1.3, 0x23302a, 0.03);
  k.sign(2.15, g(0, 2.15) + 1.35, 0.87, 0.5, 0.36, ['SOUKROMÝ POZEMEK', 'Objekt střežen kamerou'], 0, '#f1ead8', '#7a1c14');
  // the letterbox: half a year of leaflets
  k.box(-2.15, g(0, -2.15) + 1.25, 0.9, 0.34, 0.24, 0.12, 0x34495c);
  for (let i = 0; i < 6; i++) k.box(-2.15 + (r() - 0.5) * 0.2, g(0, -2.15) + 1.2 + i * 0.022, 0.99, 0.28, 0.02, 0.16, [0xe9e2cf, 0xd8443a, 0xf0c33c][i % 3], (r() - 0.5) * 0.3);
  for (let i = 0; i < 5; i++) k.box(-2.3 + r() * 0.6, g(0, -2.2) + 0.02, 1.0 + r() * 0.6, 0.21, 0.01, 0.3, [0xe9e2cf, 0xd8443a, 0xf0c33c][i % 3]);
  // the camera on the house's corner
  const cam = villa.camera, cy = g(cam.u, cam.v) + cam.up;
  k.box(cam.v - 0.16, cy, -cam.u, 0.32, 0.07, 0.07, 0x9aa0a6);
  k.box(cam.v - 0.36, cy - 0.06, -cam.u + 0.1, 0.16, 0.14, 0.3, 0xe8eaec, 0.2);
  // the ladder somebody left against the side wall, and the window over it
  const lad = villa.ladder, ly = g(lad.u, lad.v);
  for (const du of [-0.21, 0.21]) k.box(lad.v + 0.2, ly + 1.55, -(lad.u + du), 0.05, 3.25, 0.05, 0x8a6a42, -0.253);
  for (let i = 0; i < 9; i++) k.box(lad.v - 0.19 + i * 0.086, ly + 0.3 + i * 0.335, -lad.u, 0.035, 0.035, 0.46, 0x7a5a36);
  k.box(lad.v + 0.56, ly + 3.05, -lad.u, 0.07, 0.86, 1.0, 0x2c2a26);
  k.box(lad.v + 0.53, ly + 3.05, -lad.u, 0.03, 0.72, 0.86, 0x05070c, 0, true);
  k.box(lad.v + 0.4, ly + 3.05, -(lad.u - 0.55), 0.3, 0.72, 0.04, 0xe6e2d6); // the sash, swung out
  // the back door in the wing's north wall, one step up
  const bd = villa.back, by = g(bd.u + 0.5, bd.v);
  k.box(bd.v, by + 1.03, -(bd.u - 0.03), 0.95, 2.06, 0.08, 0x4d3423);
  k.box(bd.v, by + 1.05, -(bd.u - 0.06), 1.11, 2.2, 0.05, 0x2c2a26);
  k.box(bd.v + 0.34, by + 1.02, -(bd.u + 0.03), 0.04, 0.12, 0.05, 0xc9b27a);
  k.box(bd.v, by + 0.07, -(bd.u + 0.35), 1.3, 0.14, 0.7, 0x8d8475);
  // the lean-to behind the house
  const car = villa.car;
  for (const [u, v] of [[car.u - 2.9, -1.7], [car.u + 3.3, -1.7], [car.u - 2.9, 2.5], [car.u + 3.3, 2.5]]) k.box(v, g(u, v) + 1.2, -u, 0.12, 2.4, 0.12, 0x4c3a28);
  // (rafters and no sheeting: the leaves came through, and so does the camera's view)
  for (const v of [-1.7, 2.5]) k.box(v, g(car.u, v) + 2.42, -car.u - 0.2, 0.1, 0.14, 6.9, 0x4c3a28);
  for (let i = 0; i < 10; i++) k.box(0.4, g(car.u, 0.4) + 2.52, -car.u + 2.9 - i * 0.69, 4.7, 0.07, 0.07, 0x5b4a3a);
  // half a year of leaves on the drive, deepest where nothing moved them
  const leaf = [0x7a4a1e, 0x9a5b1f, 0xb8791f, 0x6a3b18, 0xa2892c];
  for (let i = 0; i < 150; i++) {
    const near = i < 60, u = near ? car.u - 3.6 + r() * 7.4 : 1.5 + r() * 42, v = near ? -1.9 + r() * 4.2 : -1.9 + r() * 3.6;
    k.box(v, g(u, v) + 0.012 + r() * 0.01, -u, 0.06 + r() * 0.07, 0.008, 0.05 + r() * 0.05, leaf[(r() * leaf.length) | 0], (r() - 0.5) * 0.3);
  }
  // weeds up through the gravel, taller towards the car
  for (let i = 0; i < 46; i++) {
    const u = 2 + r() * 49, v = (r() > 0.5 ? 1 : -1) * (1.25 + r() * 0.8), h = 0.18 + r() * 0.45 * (u / 50 + 0.4);
    k.box(v, g(u, v) + h / 2, -u, 0.05, h, 0.05, r() > 0.4 ? 0x5f7a3a : 0x8a8a4a, (r() - 0.5) * 0.4);
  }
  k.finish();
  // the camera's red eye blinks on its own mesh
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), new THREE.MeshBasicMaterial({ color: 0xff2a1a, fog: false }));
  led.position.set(cam.v - 0.36, cy - 0.04, -cam.u + 0.26);
  group.add(led);
  return {
    ground: base,
    group, // local x is v, local z is −u: the scanner over the ladder hangs in it
    floorAt: g,
    blink(t) {
      led.visible = t % 1.6 < 0.9;
    },
    dispose() {
      led.geometry.dispose();
      led.material.dispose();
      k.dispose();
    },
  };
}

// --- the lock-up in Na Staré poště, its door up and a bulb on inside
export function dressGarage(scene, world) {
  const group = new THREE.Group();
  group.name = 'Příběh • garáž';
  const d = city.door, base = world.heightAt(d.x, d.z - 1.5);
  group.position.set(d.x, base, d.z);
  scene.add(group);
  const k = scenery(group);
  k.box(0, 1.08, -0.02, 2.62, 2.16, 0.1, 0x070707, 0, true); // the dark inside
  k.box(0, 2.22, -0.62, 2.6, 0.05, 1.2, 0x7d8388); // the door, up
  k.box(-1.36, 1.1, -0.04, 0.08, 2.2, 0.14, 0x55595c);
  k.box(1.36, 1.1, -0.04, 0.08, 2.2, 0.14, 0x55595c);
  k.box(0.7, 1.95, 0.0, 0.1, 0.1, 0.1, 0xffe0a0, 0, true); // the bulb
  k.box(0, 0.012, -1.6, 3.0, 0.02, 3.0, 0x2b2b2b); // an oil-dark apron
  k.finish();
  return { bulb: { x: d.x + 0.7, y: base + 1.9, z: d.z - 0.3 }, dispose: () => k.dispose() };
}
