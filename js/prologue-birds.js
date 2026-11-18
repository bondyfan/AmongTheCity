import * as THREE from 'three';
import { storyFlutter } from './audio.js';

// Town pigeons on the pavement. They peck about until somebody walks into
// them, then the whole flock claps up and away. One instanced mesh draws
// every bird: body, head, two wings and a tail are five squashed spheres.
const PARTS = 5,
  FLY_FOR = 7,
  feathers = [0x6c7480, 0x7b838d, 0x5a626c, 0x8a8f95, 0xd9d8d2, 0x4d4a52];
const body = new THREE.Object3D(),
  part = new THREE.Object3D(),
  matrix = new THREE.Matrix4(),
  colour = new THREE.Color();

export function pigeons(scene, world) {
  const flocks = [],
    birds = [];
  let mesh = null,
    age = 0;
  // `spots` are [x, z] on the ground (or [x, z, y] for a ledge).
  function flock(name, spots, radius = 4.2) {
    const f = { name, radius, birds: [], scared: false, away: 0, x: 0, z: 0 };
    for (const [x, z, y] of spots) {
      const b = { f, hx: x, hz: z, hy: y, x, z, y: 0, yaw: Math.random() * 6.3, mode: 'idle', t: Math.random() * 9, vx: 0, vy: 0, vz: 0, tint: feathers[birds.length % feathers.length], peck: 2 + Math.random() * 4 };
      f.birds.push(b);
      birds.push(b);
      f.x += x / spots.length;
      f.z += z / spots.length;
    }
    flocks.push(f);
  }
  function build() {
    const geometry = new THREE.SphereGeometry(0.5, 8, 6);
    mesh = new THREE.InstancedMesh(geometry, new THREE.MeshLambertMaterial(), birds.length * PARTS);
    mesh.frustumCulled = false;
    mesh.name = 'Kolín • holubi';
    birds.forEach((b, i) => {
      for (let p = 0; p < PARTS; p++) {
        const shade = p === 1 ? 0.62 : p === 4 ? 0.7 : p > 1 ? 0.85 : 1;
        mesh.setColorAt(i * PARTS + p, colour.setHex(b.tint).multiplyScalar(shade));
      }
    });
    scene.add(mesh);
  }
  function put(index, x, y, z, rx, ry, rz, sx, sy, sz) {
    part.position.set(x, y, z);
    part.rotation.set(rx, ry, rz);
    part.scale.set(sx, sy, sz);
    part.updateMatrix();
    mesh.setMatrixAt(index, matrix.multiplyMatrices(body.matrix, part.matrix));
  }
  function draw(b, i) {
    const flying = b.mode === 'fly',
      hidden = b.mode === 'gone';
    body.position.set(b.x, b.y + (flying ? 0 : 0.085), b.z);
    // pecking tips the whole bird on its feet; in the air it leans into the climb
    const peck = !flying && b.t % b.peck < 0.5 ? Math.sin((b.t % b.peck) * Math.PI * 4) ** 2 * 0.7 : 0;
    body.rotation.set(flying ? -0.35 : peck, b.yaw, 0, 'YXZ');
    body.scale.setScalar(hidden ? 0 : 1);
    body.updateMatrix();
    const flap = flying ? Math.sin(b.t * 58) * 1.05 : 0,
      spread = flying ? 1 : 0;
    const n = i * PARTS;
    put(n, 0, 0, 0, 0, 0, 0, 0.13, 0.12, 0.25);
    put(n + 1, 0, 0.075, -0.115, 0, 0, 0, 0.075, 0.08, 0.085);
    for (const side of [-1, 1])
      put(n + 2 + (side + 1) / 2, side * (0.045 + 0.1 * spread), 0.03, 0.01, 0, 0, side * (0.2 - flap) * (spread || 0.4), 0.05 + 0.27 * spread, 0.022, 0.2);
    put(n + 4, 0, 0.005, 0.15, -0.15, 0, 0, 0.075 + 0.05 * spread, 0.02, 0.13);
  }
  function startle(f, px, pz) {
    if (f.scared) return;
    f.scared = true;
    f.away = 0;
    for (const b of f.birds) {
      // away from whoever came, fanned out, each with its own nerve
      const away = Math.atan2(b.x - px, b.z - pz) + (Math.random() - 0.5) * 1.5,
        pace = 5.5 + Math.random() * 3;
      b.mode = 'fly';
      b.t = -Math.random() * 0.35; // negative: still on the ground, about to go
      b.vx = Math.sin(away) * pace;
      b.vz = Math.cos(away) * pace;
      b.vy = 3 + Math.random() * 2.2;
      b.yaw = away + Math.PI;
    }
    storyFlutter(0.16 + 0.02 * f.birds.length, 6 + f.birds.length);
  }
  return {
    flock,
    // Scare a named flock from where the walker stands (or from its middle).
    scare(name, px, pz) {
      for (const f of flocks) if (f.name === name) startle(f, px ?? f.x, pz ?? f.z + 1);
    },
    update(dt, px, pz) {
      if (!birds.length) return;
      if (!mesh) build();
      age += dt;
      let i = 0;
      for (const f of flocks) {
        const d = Math.hypot(px - f.x, pz - f.z);
        if (d > 160) {
          i += f.birds.length;
          continue;
        }
        if (!f.scared && f.radius > 0)
          for (const b of f.birds)
            if (Math.hypot(px - b.x, pz - b.z) < f.radius) {
              startle(f, px, pz);
              break;
            }
        // back on their pavement once nobody is near to see them land
        if (f.scared && d > 55 && (f.away += dt) > 12) {
          f.scared = false;
          for (const b of f.birds) Object.assign(b, { mode: 'idle', x: b.hx, z: b.hz, t: Math.random() * 9 });
        }
        for (const b of f.birds) {
          b.t += dt;
          if (b.mode === 'idle') {
            b.y = b.hy ?? world.heightAt(b.x, b.z);
            // a few steps now and then, the way pigeons loiter
            if (b.t % 5.3 < 0.9 && b.hy === undefined) {
              b.x += Math.sin(b.yaw + Math.PI) * dt * 0.22;
              b.z += Math.cos(b.yaw + Math.PI) * dt * 0.22;
            } else if (b.t % 5.3 > 5.1) b.yaw += dt * 4 * (b.peck > 4 ? 1 : -1);
          } else if (b.mode === 'fly' && b.t > 0) {
            b.x += b.vx * dt;
            b.z += b.vz * dt;
            b.y += b.vy * dt;
            b.vy += (1.4 - b.vy) * dt * 0.5;
            const bend = dt * 0.35 * (b.peck > 4 ? 1 : -1);
            const vx = b.vx * Math.cos(bend) - b.vz * Math.sin(bend);
            b.vz = b.vx * Math.sin(bend) + b.vz * Math.cos(bend);
            b.vx = vx;
            b.yaw = Math.atan2(b.vx, b.vz) + Math.PI;
            if (b.t > FLY_FOR) b.mode = 'gone';
          }
          draw(b, i++);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose() {
      if (!mesh) return;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      mesh.material.dispose();
    },
  };
}
