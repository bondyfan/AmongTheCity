import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { expression } from './prologue-face.js';
import { roof } from './prologue-route.js';

const ladder = { x: -38869.22, z: 868.15 };
const lerp = THREE.MathUtils.lerp;

export function rooftop(scene, world, player) {
  const group = new THREE.Group();
  group.name = 'Kolín • střecha u nádraží';
  group.position.set(ladder.x, 0, ladder.z);
  group.rotation.y = -0.518;
  scene.add(group);
  const kit = scenery(group);
  const ground = world.terrain.heightAt(ladder.x, ladder.z);
  const top = () => world.roofY(roof.x, roof.z, Infinity) || ground + 26;
  const height = top() - ground;
  group.position.y = ground;
  for (const x of [-0.33, 0.33]) {
    kit.box(x, height / 2 + 0.59, 0, 0.065, height + 1.18, 0.08, 0x87949a);
    for (let y = 1; y < height; y += 2.4) kit.box(x, y, 0.31, 0.09, 0.09, 0.69, 0x626563);
  }
  for (let y = 0.26; y < height + 0.6; y += 0.29) kit.box(0, y, 0, 0.7, 0.047, 0.055, 0xa3a8a4);
  for (const x of [-2.1, 2.1]) {
    kit.box(x, height + 0.14, 0.63, 3.1, 0.28, 0.22, 0x817e76);
    kit.box(x, height + 0.3, 0.63, 3.1, 0.055, 0.27, 0xb6b6ae);
  }
  kit.box(-2.1, height + 0.29, 4.5, 1.05, 0.58, 0.74, 0x6d7778);
  for (let x = -2.52; x < -1.6; x += 0.09) kit.box(x, height + 0.59, 4.5, 0.035, 0.04, 0.67, 0xa5afae);
  kit.box(2.2, height + 0.55, 4.8, 0.24, 1.1, 0.24, 0x867b6a);
  kit.box(2.2, height + 1.11, 4.8, 0.39, 0.06, 0.39, 0x545b60);
  // Service hatch, flashing and a riveted extraction duct on the station roof.
  kit.box(-1.72, height + 0.09, 6.04, 1.28, 0.17, 1.08, 0x596461);
  kit.box(-1.72, height + 0.2, 6.04, 1.18, 0.08, 0.98, 0x8d9590);
  kit.box(-1.72, height + 0.27, 5.72, 0.22, 0.055, 0.05, 0x424d4b);
  kit.box(-2.1, height + 0.2, 3.31, 0.56, 0.4, 1.69, 0x989e98);
  for (const z of [2.62, 3.24, 3.87]) kit.box(-2.1, height + 0.2, z, 0.59, 0.43, 0.044, 0x707c78);
  for (const x of [-2.66, 2.13])
    for (const z of [1.4, 3.6, 5.8]) kit.box(x, height + 0.015, z, 0.043, 0.022, 2.12, 0x535650);
  kit.box(0.55, height + 0.63, 0.71, 0.19, 0.27, 0.16, 0x475150);
  kit.box(0.55, height + 0.67, 0.61, 0.13, 0.13, 0.04, 0xffbe77, 0, true);
  kit.finish();
  const cit = player._cit,
    { head, handR } = cit.parts;
  const prop = new THREE.Group();
  const phoneKit = scenery(prop);
  phoneKit.box(0, 0.046, 0, 0.071, 0.148, 0.011, 0x282a29);
  phoneKit.box(0, 0.047, -0.006, 0.059, 0.122, 0.002, 0x8fb8c3, 0, true);
  phoneKit.finish();
  handR.add(prop);
  prop.visible = false;
  const eye = cit.eye;
  const face = expression(cit);
  face.hide();
  const light = new THREE.PointLight(0xd7e8ff, 2.6, 3.1, 2);
  scene.add(light);
  light.visible = false;
  const eyeWorld = new THREE.Vector3(),
    offset = new THREE.Vector3(),
    target = new THREE.Vector3();
  let emotionalTime = 0,
    climb = null,
    age = 0,
    shot = -99,
    shotAge = 0;
  function sync() {
    player.vy = 0;
    player.speed = 0;
    player.mesh.position.set(player.pos.x, player.y, player.pos.z);
    player.mesh.rotation.y = player.heading;
  }
  function near() {
    return Math.hypot(player.pos.x - ladder.x, player.pos.z - ladder.z) < 5.3 && player.y > top() - 2;
  }
  return {
    near,
    get climbing() {
      return climb !== null;
    },
    putOnRoof() {
      Object.assign(player.pos, { x: roof.x, z: roof.z });
      player.y = top();
      player.heading = roof.h;
      player.grounded = true;
      sync();
    },
    startClimb() {
      if (climb) return true;
      if (!near()) return false;
      climb = { t: 0, x: player.pos.x, z: player.pos.z, y: player.y };
      player.grounded = false;
      player._stand();
      return true;
    },
    pose(dt, cinematic, line, speech) {
      age += dt;
      prop.visible = cinematic && line >= 0 && line !== 4;
      light.visible = cinematic;
      if (!cinematic) face.hide();
      if (climb) {
        climb.t += dt;
        const onto = Math.min(1, climb.t / 0.85);
        const progress = Math.min(1, Math.max(0, (climb.t - 0.85) / 9));
        const exit = Math.max(0, (progress - 0.95) / 0.05);
        player.pos.x = lerp(climb.x, ladder.x + 0.21 + 0.55 * exit, onto);
        player.pos.z = lerp(climb.z, ladder.z - 0.38 - 0.94 * exit, onto);
        player.y = lerp(climb.y, world.heightAt(player.pos.x, player.pos.z), progress);
        player.heading = 2.62;
        const swing = Math.sin(climb.t * 6.4);
        const j = cit.parts;
        j.armL.rotation.x = 2.45 + 0.35 * swing;
        j.armR.rotation.x = 2.45 - 0.35 * swing;
        j.elbowL.rotation.x = 0.48;
        j.elbowR.rotation.x = 0.48;
        j.legL.rotation.x = 0.38 - 0.35 * swing;
        j.legR.rotation.x = 0.38 + 0.35 * swing;
        j.kneeL.rotation.x = -0.5 + 0.35 * swing;
        j.kneeR.rotation.x = -0.5 - 0.35 * swing;
        sync();
        if (progress === 1) {
          climb = null;
          player._stand();
          player.grounded = true;
        }
        return true;
      }
      if (!cinematic) return false;
      sync();
      player._stand();
      cit.setLod('near');
      const j = cit.parts;
      head.rotation.x = 0.12 + 0.027 * Math.sin(age * 1.1);
      head.rotation.z = 0.044 * Math.sin(age * 0.43);
      if (prop.visible) {
        j.armR.rotation.set(1.23, 0.14, -0.31);
        j.elbowR.rotation.x = 2.4;
        prop.rotation.set(-0.33, Math.PI / 2, 0.11);
      }
      if (line >= 2) emotionalTime += dt;
      face.update(line >= 2 ? emotionalTime : age, line >= 2, speech);
      light.position.set(player.pos.x - 0.48, player.y + 1.97, player.pos.z - 0.72);
      return true;
    },
    camera(camera, dt, line) {
      if (line !== shot) {
        shot = line;
        shotAge = 0;
      }
      shotAge += dt;
      const t = 1 - Math.exp(-shotAge * 0.38),
        breathe = Math.sin(age * 0.71) * 0.007;
      head.updateWorldMatrix(true, false);
      eyeWorld.set(0, eye.y, eye.z).applyMatrix4(head.matrixWorld);
      target.copy(eyeWorld);
      if (line < 0) {
        offset.set(lerp(8.8, 4.3, t), lerp(3.1, 1.75, t), lerp(10, 5.9, t));
        target.y -= 0.38;
      } else if (line === 3 || line === 4) {
        offset.set(lerp(0.095, 0.052, t), 0.016 + breathe, -lerp(0.3, 0.231, t));
        target.x += 0.014;
      } else if (line === 0 || line === 5 || line === 9) {
        offset.set(lerp(-1.15, -0.91, t), 0.18, lerp(0.85, 0.67, t));
        target.y -= 0.17;
      } else {
        offset.set(lerp(0.33, 0.21, t), 0.038 + breathe, -lerp(1.08, 0.75, t));
        target.y -= 0.07;
      }
      offset.applyAxisAngle(THREE.Object3D.DEFAULT_UP, player.heading);
      camera.position.copy(eyeWorld).add(offset);
      camera.lookAt(target);
      camera.near = 0.025;
      camera.fov = line < 0 ? 48 : 35;
      camera.updateProjectionMatrix();
    },
    release() {
      prop.visible = false;
      face.hide();
      light.visible = false;
      cit.setLod(null);
      if (!player.inCar && !player.ragdoll) player._stand();
    },
    dispose() {
      this.release();
      kit.dispose();
      phoneKit.dispose();
      face.dispose();
      light.removeFromParent();
      light.dispose();
    },
  };
}
