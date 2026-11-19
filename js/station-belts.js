import * as THREE from 'three';
import { along, lanes, laneAt, flightAt, flightY, local, STEPS, BELT } from './station-layout.js';

// The moving stairs of one station: every tread of every belt in a single
// instanced mesh, and the push that carries whoever stands on one. A belt is
// a lane of a flight with `move` set (js/station-layout.js lanes()).
export function makeBelts(s, group) {
  const belts = [];
  for (const f of s.flights) for (const lane of lanes(f)) if (lane.move) belts.push({ f, lane });
  if (!belts.length) return null;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x68747b, metalness: 0.45, roughness: 0.55 }),
    belts.length * STEPS,
  );
  mesh.frustumCulled = false;
  group.add(mesh);
  const pose = new THREE.Object3D();
  let travel = 0;
  function place() {
    let n = 0;
    for (const { f, lane } of belts) {
      const rise = f.top - s.bottom,
        length = f.b - f.a,
        dir = Math.sign(length),
        tread = Math.abs(length) / STEPS,
        mid = ((lane.q0 + lane.q1) / 2) * dir,
        wide = lane.q1 - lane.q0 - 0.34,
        phase = (travel / tread) % 1;
      for (let i = 0; i < STEPS; i++) {
        const t = (i + (lane.move > 0 ? phase : 1 - phase)) / STEPS,
          p = f.a + length * t;
        if (f.axis === 'u') {
          pose.position.set(p, rise * t - 0.1, f.c + mid);
          pose.scale.set(tread + 0.01, 0.23, wide);
        } else {
          pose.position.set(f.c - mid, rise * t - 0.1, p);
          pose.scale.set(wide, 0.23, tread + 0.01);
        }
        pose.updateMatrix();
        mesh.setMatrixAt(n++, pose.matrix);
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
  place();
  return {
    advance(dt, player) {
      const { u, v } = local(s, player.pos.x, player.pos.z);
      // nobody near enough to see a tread move
      if (u < s.box.u0 - 90 || u > s.box.u1 + 90 || v < s.box.v0 - 90 || v > s.box.v1 + 90) return;
      travel += dt * BELT;
      place();
      if (player.inCar || player.boarding || player.ragdoll || !player.grounded) return;
      const f = flightAt(s, u, v);
      if (!f) return;
      const { t, q, dir } = along(f, u, v),
        lane = laneAt(f, q);
      if (!lane.move || t <= 0 || t >= 1 || Math.abs(player.y - flightY(s, f, u, v)) > 0.35) return;
      const step = dir * lane.move * BELT * dt;
      if (f.axis === 'u') {
        player.pos.x += s.c * step;
        player.pos.z += s.s * step;
      } else {
        player.pos.x -= s.s * step;
        player.pos.z += s.c * step;
      }
    },
  };
}
