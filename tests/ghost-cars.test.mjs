// ---- co-op ghost cars: the distance dress and the contact shadow -------------
// A peer's car is a proxy js/netvehicles.js owns. It is not in Vehicles.cars,
// so until wave 3 it never switched to the 1k-triangle distance variant and
// never had a contact shadow: a remote Octavia was full detail at any range
// and floated over the road. No server is needed to pin this: the ghost fleet
// is fed wire packets by hand and the real Vehicles.update decides the rest.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

// A car paints its number plate and its shadow blob on a <canvas>. Nothing
// here looks at a pixel.
const ctx2d = new Proxy({}, {
  get: (_, k) => k === 'measureText' ? () => ({ width: 200 })
    : k === 'createLinearGradient' || k === 'createRadialGradient'
      ? () => ({ addColorStop() {} })
      : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
        : k === 'canvas' ? { width: 1, height: 1 } : () => {},
  set: () => true,
});
globalThis.document ??= { createElement: () => ({ width: 1, height: 1, style: {},
  getContext: () => ctx2d, toDataURL: () => '' }) };

const THREE = await import('three');
const { Vehicles } = await import('../js/vehicles.js');
const { makeGhostCars } = await import('../js/netvehicles.js');

const packet = (x, z) => ({ k: 'car', kd: 'octavia', cl: 0x224466, x, z, h: 0.4, sp: 0, st: 0 });

function rig() {
  const scene = new THREE.Scene();
  const vehicles = new Vehicles(scene);
  vehicles.focus = { x: 0, z: 0 };
  const ghosts = makeGhostCars(vehicles);
  return { scene, vehicles, ghosts };
}

test('the ghost fleet hands itself to the Vehicles it was built on', () => {
  const { vehicles, ghosts } = rig();
  assert.equal(vehicles.ghosts, ghosts);
  ghosts.dispose();
  assert.equal(vehicles.ghosts, null, 'a disposed fleet was left wired in');
  // a bare scene is still accepted and wires nothing
  assert.doesNotThrow(() => makeGhostCars(new THREE.Scene()));
});

test('a ghost car far from the viewer wears the distance variant, a near one does not', () => {
  const { scene, vehicles, ghosts } = rig();
  ghosts.sync('near:aa', packet(10, 5));
  ghosts.sync('far:bb', packet(200, 0));
  ghosts.update(1 / 60);
  vehicles.update(1 / 60);
  const meshes = scene.children.filter((o) => o.userData.ghost);
  assert.equal(meshes.length, 2);
  const at = (x) => meshes.find((m) => Math.abs(m.position.x - x) < 1);
  const near = at(10), far = at(200);
  assert.equal(near.userData.lod.far_, false, 'a ghost 11 m away was given the distance dress');
  assert.equal(far.userData.lod.far_, true, 'a ghost 200 m away kept its full-detail body');
  assert.equal(far.userData.lod.far.visible, true);
  assert.equal(far.userData.lod.near.visible, false);
  for (const w of far.userData.lod.wheels) assert.equal(w.visible, false);

  // hysteresis: between the two radii a car keeps whichever dress it has
  ghosts.sync('far:bb', packet(58, 0));
  for (let i = 0; i < 120; i++) { ghosts.sync('far:bb', packet(58, 0)); ghosts.update(1 / 30); }
  vehicles.update(1 / 60);
  assert.equal(far.userData.lod.far_, true, 'the dress flipped inside the hysteresis band');
  for (let i = 0; i < 120; i++) { ghosts.sync('far:bb', packet(30, 0)); ghosts.update(1 / 30); }
  vehicles.update(1 / 60);
  assert.equal(far.userData.lod.far_, false, 'a ghost that drove up close stayed in the distance dress');
});

test('every ghost car has a contact shadow under it, on its own ground', () => {
  const { vehicles, ghosts } = rig();
  ghosts.world = { surfaceY: () => ({ y: 221 }) };
  for (let i = 0; i < 90; i++) { ghosts.sync('p:aa', packet(12, -7)); ghosts.update(1 / 30); }
  vehicles.update(1 / 60);
  const blobs = vehicles._blobs;
  assert.ok(blobs, 'no shadow batch was made for a session whose only car is a ghost');
  assert.equal(blobs.count, 1);
  const m = new THREE.Matrix4(), p = new THREE.Vector3();
  blobs.getMatrixAt(0, m); p.setFromMatrixPosition(m);
  assert.ok(Math.abs(p.x - 12) < 0.2 && Math.abs(p.z + 7) < 0.2, 'shadow at ' + p.x + ', ' + p.z);
  assert.ok(Math.abs(p.y - 221.035) < 0.05, 'shadow at height ' + p.y);

  // local cars and ghosts share the one batch
  vehicles.add('fabia', 40, 40, 0, 0xffffff);
  vehicles.update(1 / 60);
  assert.equal(blobs.count, 2);

  // a ghost that leaves takes its shadow with it
  ghosts.drop('p:aa');
  vehicles.update(1 / 60);
  assert.equal(vehicles._blobs.count, 1);
});

test('the shadow batch grows for a room full of ghosts', () => {
  const { vehicles, ghosts } = rig();
  for (let i = 0; i < 300; i++) ghosts.sync('u' + i + ':aa', packet(i * 3, 0));
  ghosts.update(1 / 60);
  vehicles.update(1 / 60);
  assert.equal(vehicles._blobs.count, 300, 'ghosts past the first 256 lost their shadow');
});
