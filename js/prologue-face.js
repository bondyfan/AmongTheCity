import * as THREE from 'three';

// Follow the same skull surface that the character builder used for the eyes.
export function expression(cit) {
  const {
    eye,
    parts: { head },
  } = cit;
  const group = new THREE.Group();
  head.add(group);
  const shape = new THREE.SphereGeometry(1, 20, 12),
    materials = [];
  function finish(color, options = {}) {
    const m = new THREE.MeshPhongMaterial({ color, ...options });
    materials.push(m);
    return m;
  }
  function dot(material, x, y, z, sx, sy, sz) {
    const m = new THREE.Mesh(shape, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    group.add(m);
    return m;
  }
  const wet = finish(0x446166, { specular: 0xf7fcff, shininess: 120, transparent: true, opacity: 0.48 });
  const iris = finish(cit.outfit.eyes ?? 0x584234, { specular: 0x8eabb2, shininess: 50 });
  const pupil = finish(0x171b1c),
    glint = finish(0xc2dbe1, { emissive: 0x415357 });
  const skin = finish(cit.look.skin),
    lids = [],
    eyes = [];
  for (const side of [-1, 1]) {
    const x = side * eye.x;
    const socket = new THREE.Group();
    socket.position.set(x, eye.y, eye.z - 0.0012);
    group.add(socket);
    const radius = eye.x * 0.195;
    for (const [mat, dx, dy, dz, w, h, d] of [
      [iris, 0, 0, 0, radius, radius, 0.0018],
      [pupil, 0, 0, -0.0015, radius * 0.5, radius * 0.61, 0.0009],
      [glint, -0.0014, 0.0018, -0.0024, 0.00085, 0.0008, 0.0003],
    ]) {
      const m = dot(mat, dx, dy, dz, w, h, d);
      socket.add(m);
    }
    eyes.push(socket);
    const lid = dot(skin, x, eye.y + 0.007, eye.z - 0.003, 0.014, 0.007, 0.002);
    lid.rotation.y = -side * 0.22;
    lids.push(lid);
  }
  const mouth = dot(finish(0x4a2927), 0, eye.lipY, eye.surface(0, eye.lipY) - 0.0038, 0.018, 0.0024, 0.0012);
  const drop = dot(wet, 0, 0, 0, 0.0015, 0.0034, 0.00085);
  const spark = dot(glint, 0, 0, 0, 0.00046, 0.0009, 0.00022);
  return {
    update(age, emotion, speech) {
      group.visible = true;
      mouth.visible = speech > 0.03;
      mouth.scale.y = 0.0018 + speech * 0.0065;
      mouth.position.y = eye.lipY - mouth.scale.y * 0.46;
      const blink = Math.pow(Math.max(0, Math.cos(age * (emotion ? 1.65 : 1.21))), 95);
      for (const lid of lids) {
        lid.position.y = eye.y + 0.009 - 0.008 * blink;
        lid.scale.y = 0.0036 + 0.0032 * blink;
      }
      for (const socket of eyes)
        socket.position.y = eye.y - (emotion ? 0.0016 : 0) + 0.0005 * Math.sin(age * 0.86);
      drop.visible = spark.visible = emotion;
      if (emotion) {
        const t = Math.min(1, age / 7);
        const x = eye.x + 0.005 + 0.009 * t,
          y = eye.y - 0.006 - 0.052 * t;
        drop.position.set(x, y, eye.surface(x, y) - 0.0018);
        spark.position.copy(drop.position);
        spark.position.z -= 0.001;
        spark.position.y += 0.0011;
      }
    },
    hide() {
      group.visible = false;
    },
    dispose() {
      group.removeFromParent();
      shape.dispose();
      for (const m of materials) m.dispose();
    },
  };
}
