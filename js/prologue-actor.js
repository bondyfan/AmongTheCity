import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { expression } from './prologue-face.js';

// The father as the film sees him: the phone in his hand, a face that can
// speak and cry, and the poses of a man on a call. Scenes place him and pick
// a gesture; this module owns everything that is attached to his body.
export function actor(player, lights) {
  const cit = player._cit,
    j = cit.parts;
  const prop = new THREE.Group(),
    phoneKit = scenery(prop);
  // Centred on the palm: the forearm hangs along −y, the screen faces −z.
  phoneKit.box(0, 0, 0, 0.071, 0.148, 0.011, 0x282a29);
  phoneKit.box(0, 0.001, -0.006, 0.059, 0.122, 0.002, 0x9cc6d2, 0, true);
  phoneKit.finish();
  j.handR.add(prop);
  prop.visible = false;
  const face = expression(cit);
  face.hide();
  // His key light is the first of the story's two lamps (prologue-lights.js).
  const key = lights.a;
  const eye = new THREE.Vector3();
  let age = 0,
    tears = 0,
    held = 0; // 0 arm down, 1 phone at the ear
  return {
    cit,
    get age() {
      return age;
    },
    // Where his eyes are in the world, for a camera to look at.
    eyes(out = eye) {
      j.head.updateWorldMatrix(true, false);
      return out.set(0, cit.eye.y, cit.eye.z).applyMatrix4(j.head.matrixWorld);
    },
    place(x, y, z, heading) {
      player.pos.x = x;
      player.pos.z = z;
      player.y = y;
      player.heading = heading;
      player.vy = 0;
      player.speed = 0;
      player.grounded = true;
      player.mesh.position.set(x, y, z);
      player.mesh.rotation.y = heading;
    },
    // Call after the body pose of the frame is written. `gesture` is 'ear',
    // 'read' (the phone held low in front, head down) or null; `emotion`
    // brings the wet eyes, `speech` (0..1) opens the mouth.
    perform(dt, { gesture = null, emotion = false, speech = 0, light = 1, bow = 0 } = {}) {
      age += dt;
      cit.setLod('near');
      const want = gesture === 'ear' ? 1 : gesture === 'read' ? 0.55 : 0;
      held += (want - held) * Math.min(1, dt * 5.5);
      prop.visible = held > 0.12;
      if (held > 0.02) {
        const up = Math.min(1, held / 0.55),
          ear = Math.max(0, (held - 0.55) / 0.45);
        // reading: the forearm up across the chest, the screen tipped to his
        // face; at the ear the phone turns flat against his head
        j.armR.rotation.set(0.28 * up + 0.87 * ear, 0.5 * up - 0.36 * ear, -0.06 * up - 0.25 * ear);
        j.elbowR.rotation.x = 1.7 * up + 0.9 * ear;
        prop.position.set(-0.028 * ear, -0.068, -0.026 * (1 - ear));
        prop.rotation.set(0, (Math.PI / 2) * ear, 0);
      }
      const read = gesture === 'read' ? 1 : 0;
      // negative tips the head forward: down at the screen, or at the street below
      j.head.rotation.x = 0.1 - 0.42 * read - bow + 0.027 * Math.sin(age * 1.1);
      // the head leans to the phone a little when it is at his ear
      j.head.rotation.z = 0.044 * Math.sin(age * 0.43) - 0.09 * Math.max(0, (held - 0.55) / 0.45);
      if (emotion) tears += dt;
      face.update(emotion ? tears : age, emotion, speech);
      // `light: null` leaves the lamp alone: the scene is lighting him itself
      if (light !== null) {
        key.color.setHex(0xd7e8ff);
        key.distance = 3.4;
        key.decay = 2;
        key.intensity = 2.6 * light;
      }
      if (light > 0) {
        const p = this.eyes();
        const h = player.heading;
        // a little in front and to his left, where a screen or a window would be
        key.position.set(p.x - Math.sin(h) * 0.7 - Math.cos(h) * 0.45, p.y + 0.3, p.z - Math.cos(h) * 0.7 + Math.sin(h) * 0.45);
      }
    },
    release() {
      prop.visible = false;
      held = 0;
      face.hide();
      cit.setLod(null);
      if (!player.inCar && !player.ragdoll) player._stand();
    },
    dispose() {
      this.release();
      prop.removeFromParent();
      phoneKit.dispose();
      face.dispose();
    },
  };
}
