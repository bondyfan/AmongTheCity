import * as THREE from 'three';
import { unlock } from './carlocks.js';
import { storyRecording } from './audio.js';
import { villa, villaAt, villaOut } from './heist-route.js';

// The car under the lean-to: a silver Mercedes nobody has moved for half a
// year (Frank, 18 Nov 2026: "bude jako fakt opravdu vypadat tak, že už půl roku
// nikdo nepoužíval, budou na něm jako listy"). It is one of the game's own
// cars; this file adds what the story needs on it:
//   * leaves, twigs and bird lime lying on the bodywork, found by dropping a
//     ray on the car so they sit on whatever shape it has. On the road the
//     wind takes them one by one (Frank, 21 Nov 2026: "ty listy opravdu musí
//     jako padat... a nejenom, že to zmizí"): each lifts off, tumbles, sinks
//     behind the car and lies on the tarmac. The bird lime stays where it is.
//   * its two number plates as things a hand can tear off (a dark empty holder
//     goes over the plate the body draws)
//   * the key, found in the house: until `key()` it is locked
//   * `car.hotwire`, which main.js reads: no engine until `start()`.
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
  const loose = []; // what the wind can take: { i, local, scale, colour, twig }
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
    if (kind >= 0.2 || kind < 0.12) loose.push({ i: placed, local: pose.position.clone(), scale: pose.scale.clone(), colour: colour.getHex(), twig: kind < 0.12 });
    placed++;
  }
  // the order they go in: the roof and the bonnet's edge first, by a hashed draw
  // (a flurry as he pulls away, then a thinning trail: two in five are gone in the first hundred metres)
  for (const l of loose) l.at = 12 + Math.pow(rnd(), 2.2) * 1300 + (l.local.y > 1.1 ? 0 : 60);
  loose.sort((a, b) => a.at - b.at);
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
  // --- the leaves in the air and on the road behind
  // (unlit, so they are seen leaving the car at four in the morning too)
  const air = new THREE.InstancedMesh(litter.geometry, new THREE.MeshBasicMaterial({ color: 0xb9b9b9 }), Math.max(1, loose.length));
  air.count = 0;
  air.frustumCulled = false;
  air.userData.story = true;
  scene.add(air);
  const flying = [];
  const zero = new THREE.Matrix4().makeScale(0, 0, 0);
  let shed = 0,
    next = 0,
    keyed = false;
  function launch(l) {
    litter.setMatrixAt(l.i, zero);
    litter.instanceMatrix.needsUpdate = true;
    const w = mesh.localToWorld(l.local.clone()),
      v = car.speed,
      side = (Math.random() - 0.5) * 2.4;
    flying.push({
      x: w.x, y: w.y, z: w.z,
      // it leaves with some of the car's speed, lifted by the air over the roof
      vx: -Math.sin(car.heading) * v * 0.5 + Math.cos(car.heading) * side,
      vy: (l.twig ? 0.4 : 0.9) + Math.random() * 1.5,
      vz: -Math.cos(car.heading) * v * 0.5 - Math.sin(car.heading) * side,
      rx: Math.random() * 6.28, ry: Math.random() * 6.28, rz: Math.random() * 6.28,
      spin: (l.twig ? 5 : 9) * (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random()),
      phase: Math.random() * 6.28, age: 0, down: 0, ground: world.heightAt(w.x, w.z),
      scale: l.scale, twig: l.twig, slot: flying.length,
    });
    air.setColorAt(flying.length - 1, colour.setHex(l.colour));
    if (air.instanceColor) air.instanceColor.needsUpdate = true;
    air.count = flying.length;
  }
  function fly(dt) {
    for (const f of flying) {
      if (f.down > 14) continue;
      f.age += dt;
      if (!f.down) {
        const drag = Math.exp(-(f.twig ? 0.9 : 1.9) * dt);
        f.vx *= drag;
        f.vz *= drag;
        // a leaf does not fall, it sinks: towards 1.2 m/s, rocking as it goes
        f.vy += ((f.twig ? -6 : -1.2) - f.vy) * Math.min(1, (f.twig ? 1.6 : 2.4) * dt);
        const rock = f.twig ? 0 : Math.sin(f.age * 5.2 + f.phase) * 0.9;
        f.x += (f.vx + Math.cos(f.phase) * rock) * dt;
        f.z += (f.vz + Math.sin(f.phase) * rock) * dt;
        f.y += f.vy * dt;
        f.rx += f.spin * dt;
        f.rz += f.spin * 0.6 * dt;
        if (f.y <= f.ground + 0.012 && f.vy < 0) {
          f.ground = world.heightAt(f.x, f.z);
          if (f.y <= f.ground + 0.012) {
            f.y = f.ground + 0.012;
            f.down = 0.001;
            f.rx = f.rz = 0;
          }
        }
      } else f.down += dt;
      // lying on the road it stays a while, then it is gone with the rest of the night
      const k = f.down > 11 ? Math.max(0, 1 - (f.down - 11) / 3) : 1;
      pose.position.set(f.x, f.y, f.z);
      pose.rotation.set(f.rx, f.ry, f.rz);
      pose.scale.copy(f.scale).multiplyScalar(k * (f.twig ? 1 : 1.35)); // a touch larger than life, to be seen from the chase camera
      pose.updateMatrix();
      air.setMatrixAt(f.slot, pose.matrix);
    }
    if (flying.length) air.instanceMatrix.needsUpdate = true;
  }
  const api = {
    car,
    plates,
    get keyed() {
      return keyed;
    },
    // how many leaves are still on it, and how many are in the air or down
    get leaves() {
      return { on: loose.length - next, off: flying.length };
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
    // the key from the house: the locks answer, the lamps blink once
    key() {
      if (keyed) return;
      keyed = true;
      unlock(car);
      storyRecording('alarm-chirp', { level: 0.6 });
      car._litT = 1.2;
    },
    // the engine caught: it is his
    start() {
      car.hotwire = false;
      car._litT = Infinity;
    },
    // On the road the wind takes what lay on it: the faster, the sooner.
    update(dt) {
      const v = Math.abs(car.speed);
      if (v > 2.5 && next < loose.length) {
        shed += v * dt * (0.5 + v / 16);
        let n = 0;
        while (next < loose.length && shed > loose[next].at && n++ < 2) launch(loose[next++]);
      }
      fly(dt);
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
      scene.remove(air);
      air.material.dispose();
      car.hotwire = false;
      host.removeCar(car);
    },
  };
  return api;
}
