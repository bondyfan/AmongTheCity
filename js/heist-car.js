import * as THREE from 'three';
import { unlock } from './carlocks.js';
import { storyRecording } from './audio.js';
import { villa, villaAt, villaOut } from './heist-route.js';

// The car under the lean-to: a silver Mercedes nobody has moved for half a
// year (Frank, 18 Nov 2026: "bude jako fakt opravdu vypadat tak, že už půl roku
// nikdo nepoužíval, budou na něm jako listy"). It is one of the game's own
// cars; this file adds what the story needs on it:
//   * leaves, twigs and bird lime lying on the bodywork, found by dropping a
//     ray on the car so they sit on whatever shape it has, and shed on the road
//   * its two number plates as things a hand can tear off (a dark empty holder
//     goes over the plate the body draws)
//   * a side window that can be put through, which is what unlocks it
//   * `car.hotwire`, which main.js reads: no engine until two wires meet.
const LEAF = [0x7a4a1e, 0x9a5b1f, 0xb8791f, 0x6a3b18, 0xa2892c, 0x54401f];

export function villaCar(host, scene, world) {
  const p = villaAt(villa.car.u, villa.car.v);
  const car = host.addCar('mercedes', p.x, p.z, villaOut, 0xb7bcc3);
  car._lockDraw = 1; // somebody locked it, and that is certain
  car.hotwire = true;
  car._litT = 0;
  car.story = true;
  const mesh = car.mesh;
  mesh.updateMatrixWorld(true);
  const ray = new THREE.Raycaster(),
    from = new THREE.Vector3(),
    dir = new THREE.Vector3(),
    hit = new THREE.Vector3();
  // where a ray sent from a point in the car's own frame meets the car
  function probe(x, y, z, dx, dy, dz) {
    from.set(x, y, z);
    mesh.localToWorld(from);
    dir.set(dx, dy, dz).transformDirection(mesh.matrixWorld);
    ray.set(from, dir);
    ray.far = 8;
    const found = ray.intersectObject(mesh, true).find((f) => f.object !== litter && !f.object.userData.story);
    return found ? mesh.worldToLocal(hit.copy(found.point)).clone() : null;
  }
  // --- what half a year under trees leaves on a car
  const COUNT = 130;
  const litter = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial(), COUNT);
  litter.userData.story = true;
  let seed = 977, placed = 0;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pose = new THREE.Object3D(),
    colour = new THREE.Color();
  for (let i = 0; i < COUNT * 3 && placed < COUNT; i++) {
    const x = (rnd() - 0.5) * (car.wid - 0.25),
      z = (rnd() - 0.5) * (car.len - 0.5),
      at = probe(x, 3, z, 0, -1, 0);
    if (!at || at.y < 0.55) continue;
    const kind = rnd();
    pose.position.set(at.x, at.y + 0.006, at.z);
    pose.rotation.set((rnd() - 0.5) * 0.5, rnd() * 6.28, (rnd() - 0.5) * 0.5);
    if (kind < 0.12) {
      pose.scale.set(0.012, 0.012, 0.16 + rnd() * 0.2); // a twig
      colour.setHex(0x3f2f20);
    } else if (kind < 0.2) {
      pose.scale.set(0.05 + rnd() * 0.04, 0.004, 0.05 + rnd() * 0.05); // bird lime
      colour.setHex(0xe6e4dc);
    } else {
      pose.scale.set(0.07 + rnd() * 0.07, 0.005, 0.05 + rnd() * 0.05);
      colour.setHex(LEAF[(rnd() * LEAF.length) | 0]);
    }
    pose.updateMatrix();
    litter.setMatrixAt(placed, pose.matrix);
    litter.setColorAt(placed, colour);
    placed++;
  }
  litter.count = placed;
  litter.instanceMatrix.needsUpdate = true;
  if (litter.instanceColor) litter.instanceColor.needsUpdate = true;
  mesh.add(litter);
  // --- the plates
  const holder = new THREE.MeshLambertMaterial({ color: 0x16181b });
  const plateMat = new THREE.MeshLambertMaterial({ color: 0xe9e9e4 });
  const plates = [
    ['přední', probe(0, 0.37, -5, 0, 0, 1), Math.PI, -1],
    ['zadní', probe(0, 0.44, 5, 0, 0, -1), 0, 1],
  ].map(([name, at, yaw, out]) => {
    at ??= new THREE.Vector3(0, 0.4, (out * car.len) / 2);
    const cover = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.135), holder);
    cover.userData.story = true;
    cover.position.set(at.x, at.y, at.z + out * 0.012);
    cover.rotation.y = yaw;
    cover.visible = false;
    mesh.add(cover);
    return { name, cover, on: true, local: new THREE.Vector3(at.x, at.y, at.z + out * 0.55) };
  });
  const dropped = [];
  const world3 = new THREE.Vector3();
  const spot = (local) => mesh.localToWorld(world3.copy(local));
  // --- glass on the ground by the driver's door
  const shards = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0xbfe0e6 }), 22);
  shards.count = 0;
  scene.add(shards);
  let broken = false,
    shed = 0;
  const doorLocal = new THREE.Vector3(-car.wid / 2 - 0.55, 0, -0.25);
  const api = {
    car,
    plates,
    get broken() {
      return broken;
    },
    get bare() {
      return plates.every((pl) => !pl.on);
    },
    // which plate a man standing at (x, z) could put his hands on, or null
    plateNear(x, z) {
      for (const pl of plates) {
        if (!pl.on) continue;
        const w = spot(pl.local);
        if (Math.hypot(w.x - x, w.z - z) < 1.15) return pl;
      }
      return null;
    },
    rip(pl) {
      if (!pl.on) return;
      pl.on = false;
      pl.cover.visible = true;
      storyRecording('plate-rip', { level: 1.1 });
      // it lies where he dropped it
      const w = spot(pl.local),
        m = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.006, 0.11), plateMat);
      m.position.set(w.x + 0.3, world.heightAt(w.x, w.z) + 0.012, w.z);
      m.rotation.y = car.heading + 0.9;
      scene.add(m);
      dropped.push(m);
    },
    atDoor(x, z) {
      const w = spot(doorLocal);
      return Math.hypot(w.x - x, w.z - z) < 1.5;
    },
    smash() {
      if (broken) return;
      broken = true;
      unlock(car);
      storyRecording('glass-break', { level: 1.2 });
      setTimeout(() => storyRecording('alarm-chirp', { level: 0.5 }), 900);
      const w = spot(doorLocal),
        g = world.heightAt(w.x, w.z);
      for (let i = 0; i < 22; i++) {
        pose.position.set(w.x + (Math.random() - 0.5) * 1.1, g + 0.008, w.z + (Math.random() - 0.5) * 1.1);
        pose.rotation.set(0, Math.random() * 6.28, 0);
        pose.scale.set(0.02 + Math.random() * 0.03, 0.008, 0.02 + Math.random() * 0.03);
        pose.updateMatrix();
        shards.setMatrixAt(i, pose.matrix);
      }
      shards.count = 22;
      shards.instanceMatrix.needsUpdate = true;
    },
    // the wires met: the engine is his
    start() {
      car.hotwire = false;
      car._litT = Infinity;
    },
    // On the road the wind takes what lay on it: metres driven above walking pace.
    update(dt) {
      const v = Math.abs(car.speed);
      if (v > 4 && litter.count > 0) {
        shed += v * dt;
        litter.count = Math.max(0, Math.round(placed * (1 - shed / 420)));
      }
    },
    dispose() {
      mesh.remove(litter);
      litter.geometry.dispose();
      litter.material.dispose();
      for (const pl of plates) {
        mesh.remove(pl.cover);
        pl.cover.geometry.dispose();
      }
      holder.dispose();
      plateMat.dispose();
      for (const m of dropped) {
        scene.remove(m);
        m.geometry.dispose();
      }
      scene.remove(shards);
      shards.geometry.dispose();
      shards.material.dispose();
      car.hotwire = false;
      host.removeCar(car);
    },
  };
  return api;
}
