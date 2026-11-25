import * as THREE from 'three';

// ---- campaignmark.js: where the campaign's next part begins, in the world ----
// The maps draw a diamond there (js/mapmarks.js 'story'); in the world it is a
// tall amber column with a ring on the ground and the part's name over it, the
// way a mission's start stands in the street. Walking or driving into the ring
// starts the part (js/campaignparts.js gateStep, main.js). One mark at a time:
// the part that waits (js/career.js nextPart).

const SEEN = 900;              // m: further than this the column is not drawn

function nameplate(text) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d');
  g.font = '600 40px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 8;
  g.strokeStyle = 'rgba(12,14,20,0.85)';
  g.strokeText(text, 256, 48);
  g.fillStyle = '#ffd98a';
  g.fillText(text, 256, 48);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.scale.set(6.4, 1.2, 1);
  return sprite;
}

export function campaignMark(scene) {
  const group = new THREE.Group();
  group.name = 'Kampaň • start další části';
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.7, 1.6, 60, 20, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffb648, transparent: true, opacity: 0.24, depthWrite: false,
      blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }),
  );
  beam.position.y = 30;
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(2.6, 3.2, 48),
    new THREE.MeshBasicMaterial({ color: 0xffd98a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, fog: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.07;
  group.add(beam, ring);
  group.visible = false;
  scene.add(group);
  let shown = null, plate = null, age = 0;
  return {
    /** `part` from career.nextPart() (or null), `y` the ground at its start, `px, pz` the player. */
    update(dt, part, y, px, pz) {
      if (part?.id !== shown) {
        shown = part?.id ?? null;
        if (plate) { plate.material.map.dispose(); plate.material.dispose(); plate.removeFromParent(); plate = null; }
        if (part) {
          plate = nameplate(part.title);
          plate.position.y = 4.2;
          group.add(plate);
          group.position.set(part.at.x, y, part.at.z);
        }
      }
      if (!part) { group.visible = false; return; }
      if (Number.isFinite(y)) group.position.y = y;
      const d = Math.hypot(part.at.x - px, part.at.z - pz);
      group.visible = d < SEEN;
      if (!group.visible) return;
      age += dt;
      // close up the column thins out so it never fills the screen
      const near = Math.min(1, Math.max(0, (d - 4) / 30));
      beam.material.opacity = 0.06 + 0.2 * near;
      ring.scale.setScalar(1 + 0.08 * Math.sin(age * 3));
      plate.visible = d < 140;
    },
    dispose() {
      for (const m of [beam, ring]) { m.geometry.dispose(); m.material.dispose(); }
      if (plate) { plate.material.map.dispose(); plate.material.dispose(); }
      group.removeFromParent();
    },
  };
}
