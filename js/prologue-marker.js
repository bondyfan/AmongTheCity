import * as THREE from 'three';

// Where to run. A column of warm light stands on the place in the world and a
// pin on the screen names it with the metres left; when the place is out of
// the picture the pin becomes an arrow on the rim that points the way round.
export function waymark(scene, hud) {
  const group = new THREE.Group();
  group.name = 'Příběh • značka cíle';
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 1.25, 34, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffc860, transparent: true, opacity: 0.2, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }),
  );
  beam.position.y = 17;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(1.25, 1.6, 40),
    new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.06;
  group.add(beam, ring);
  group.visible = false;
  scene.add(group);
  const point = new THREE.Vector3();
  let target = null,
    label = '',
    age = 0;
  return {
    // target: { x, y, z } in the world, or null to put the mark away.
    set(next, name = '') {
      target = next;
      label = name;
      group.visible = !!next;
      if (next) group.position.set(next.x, next.y, next.z);
      else hud.pin();
    },
    frame(camera, dt, px, pz) {
      if (!target) return;
      age += dt;
      const metres = Math.hypot(target.x - px, target.z - pz);
      // the column thins out as he arrives, so it never fills the screen
      const near = Math.min(1, Math.max(0, (metres - 5) / 22));
      beam.material.opacity = 0.2 * near;
      ring.scale.setScalar(1 + 0.12 * Math.sin(age * 3.2));
      ring.material.opacity = 0.35 + 0.5 * near;
      point.set(target.x, target.y + 3.4, target.z).project(camera);
      const behind = point.z > 1;
      let x = behind ? -point.x : point.x,
        y = behind ? -point.y : point.y;
      const text = Math.round(metres) + ' m';
      if (!behind && Math.abs(x) < 0.9 && y < 0.72 && y > -0.74) hud.pin((x + 1) / 2, (1 - y) / 2, label, text);
      else {
        // ride the rim of the picture, pointing out along the bearing
        if (behind && Math.abs(x) < 0.02 && Math.abs(y) < 0.02) x = 1;
        const scale = 1 / Math.max(Math.abs(x) / 0.9, Math.abs(y) / 0.72);
        hud.pin((x * scale + 1) / 2, (1 - y * scale) / 2, label, text, Math.atan2(x, y));
      }
    },
    dispose() {
      hud.pin();
      for (const m of [beam, ring]) {
        m.geometry.dispose();
        m.material.dispose();
      }
      group.removeFromParent();
    },
  };
}
