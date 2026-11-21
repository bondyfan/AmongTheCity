import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { storyRecording, storyDuck } from './audio.js';
import { actor } from './prologue-actor.js';
import { garageTalk } from './heist-dialogue.js';
import { city } from './heist-route.js';

// The end of part two: the door comes down and the two of them stand by the
// car under one bulb. A closed set far below the lock-up, like Vašek's kitchen
// (js/prologue-house.js). Set frame: x across, z from the door (−) to the back
// wall (+), the car along the left wall.
const DEPTH = 46;
const HIM = { x: 1.3, z: -0.55 }, // Vašek, facing the door
  ME = { x: 1.35, z: -2.25 }; // the father, his back to it
// camera, look-at, lens, where the camera drifts to
const shots = {
  door: [[2.6, 2.05, -3.55], [-0.6, 0.7, 0.6], 60, [2.5, 2.0, -3.4]],
  car: [[-2.62, 1.35, -3.55], [-0.9, 0.75, 0.4], 56, [-2.55, 1.3, -3.4]],
  him: [[1.72, 1.52, -2.85], [1.28, 1.5, -0.55], 38, [1.66, 1.52, -2.7]],
  me: [[0.82, 1.5, -0.05], [1.36, 1.48, -2.25], 38, [0.88, 1.5, -0.2]],
  two: [[2.45, 1.35, -1.4], [0.9, 1.2, -1.4], 44, [2.4, 1.35, -1.5]],
};
const byLine = ['car', 'me', 'him', 'me', 'two'];
const mix = (a, b, t) => a + (b - a) * t;

export function garageScene({ scene, world, player, hud, lights, friend, car, done }) {
  const group = new THREE.Group();
  group.name = 'Příběh • garáž uvnitř';
  const ox = city.door.x,
    oy = world.heightAt(city.door.x, city.door.z) - DEPTH,
    oz = city.door.z + 3.6;
  group.position.set(ox, oy, oz);
  scene.add(group);
  const k = scenery(group);
  const W = 5.8, L = 7.6, H = 2.6;
  k.box(0, -0.05, 0, W, 0.1, L, 0x4a4a48); // floor
  k.box(-0.6, 0.004, 0.4, 1.4, 0.006, 2.2, 0x2e2e2c); // old oil
  k.box(0, H + 0.05, 0, W, 0.1, L, 0x6a6a66);
  k.box(-W / 2, H / 2, 0, 0.12, H, L, 0x8a8880);
  k.box(W / 2, H / 2, 0, 0.12, H, L, 0x8a8880);
  k.box(0, H / 2, L / 2, W, H, 0.12, 0x8a8880);
  k.box(0, H / 2, -L / 2, W, H, 0.1, 0x767a7c); // the door, down
  for (let i = -4; i <= 4; i++) k.box(i * 0.6, H / 2, -L / 2 + 0.06, 0.03, H, 0.03, 0x5c6062);
  // shelves on the right wall, a stack of tyres, a canister
  for (const y of [0.9, 1.5, 2.05]) k.box(W / 2 - 0.3, y, 1.6, 0.46, 0.04, 2.6, 0x6b4f33);
  for (const [z, y, c] of [[0.7, 1.02, 0xb8352c], [1.3, 1.02, 0x2f5fa0], [2.2, 1.62, 0x8d8475], [1.0, 1.62, 0x3f6a34], [2.4, 1.02, 0x1d1d1d]]) k.box(W / 2 - 0.3, y + 0.1, z, 0.3, 0.24, 0.3, c);
  for (let i = 0; i < 4; i++) k.box(W / 2 - 0.55, 0.11 + i * 0.22, 3.1, 0.66, 0.2, 0.66, 0x151515, 0, false, 'round');
  k.box(1.9, 0.2, 3.3, 0.24, 0.4, 0.34, 0x9b2a22);
  k.box(0.6, H - 0.12, -0.6, 0.02, 0.24, 0.02, 0x222222);
  k.box(0.6, H - 0.28, -0.6, 0.1, 0.12, 0.1, 0xffe2a6, 0, true); // the bulb
  k.finish();
  // the car itself comes down with them: it is the game's own car, so its
  // wheels, its missing plates and its broken window are what they were
  car.x = ox - 1.25;
  car.z = oz + 0.5;
  car.y = oy;
  car.heading = Math.PI; // nose to the back wall
  car.speed = car.steer = 0;
  car._grounded = true;
  car._litT = 0;
  const act = actor(player, lights),
    eye = new THREE.Vector3(),
    look = new THREE.Vector3();
  const at = (x, y, z, out) => out.set(ox + x, oy + y, oz + z);
  let beat = 'door',
    age = 0,
    line = -1,
    wait = Infinity,
    safety = 0,
    token = 0,
    voice = null,
    speaker = '',
    live = true,
    shot = '',
    shotAge = 0;
  function say(index) {
    line = index;
    voice?.stop();
    const [id, who, words, role] = garageTalk[index];
    speaker = role;
    hud.say(who, words);
    const mine = ++token;
    wait = Infinity;
    safety = Math.max(15, words.length * 0.16);
    voice = storyRecording(id, {
      meter: true,
      level: 1.85,
      end: () => {
        if (live && token === mine) wait = 0.6;
      },
      missing: () => {
        if (live && token === mine) wait = 1.3 + words.length * 0.062;
      },
    });
  }
  // the film is over: the game has its lights, its picture and its player back
  function finish() {
    live = false;
    ++token;
    voice?.stop();
    hud.say();
    act.release();
    storyDuck(0);
    lights.off();
    hud.cinema(false);
    done();
  }
  scene.add(friend.group);
  friend.group.visible = true;
  storyDuck(0.9);
  hud.cinema(true);
  storyRecording('garage-door', { level: 1.2 });
  lights.a.color.setHex(0xffd9a0);
  lights.a.distance = 9;
  lights.a.decay = 1.3;
  lights.b.color.setHex(0x8fa6c8);
  lights.b.distance = 5;
  lights.b.decay = 2;
  at(0.6, H - 0.4, -0.6, lights.a.position);
  at(-2.2, 1.0, -2.6, lights.b.position);
  return {
    get running() {
      return live;
    },
    use() {
      return true; // E skips nothing here
    },
    // T after a failed mission (js/story-retry.js): the door is down, it is over
    skip() {
      if (!live) return false;
      finish();
      return true;
    },
    update(dt) {
      age += dt;
      lights.a.intensity = 7.5 + 0.25 * Math.sin(age * 31) * Math.sin(age * 3.3);
      lights.b.intensity = 0.9;
      if (beat === 'door') {
        if (age > 1.1) hud.veil(false);
        if (age > 3.4) {
          beat = 'talk';
          age = 0;
          say(0);
        }
      } else if (beat === 'talk') {
        if ((wait -= dt) <= 0 || (safety -= dt) <= 0) {
          if (line + 1 < garageTalk.length) say(line + 1);
          else {
            beat = 'end';
            age = 0;
            ++token;
            voice?.stop();
            hud.say();
            hud.veil(true, 'Konec druhé části', 'Poslední vlak');
          }
        }
      } else if (beat === 'end' && age > 4.8) finish();
    },
    pose(dt) {
      if (!live) return false;
      const speech = voice?.intensity() ?? 0;
      at(HIM.x, 0, HIM.z, friend.group.position);
      friend.group.rotation.y = 0.12; // towards the door, a little to the car
      friend.standPose();
      const fj = friend.parts;
      fj.head.rotation.x += speaker === 'friend' ? -0.1 * speech : 0;
      if (beat === 'talk' && line === 0) fj.head.rotation.y += 0.7; // he cannot stop looking at it
      if (beat === 'talk' && line === 2) {
        fj.armL.rotation.x += 0.9;
        fj.armR.rotation.x += 0.9; // hands up: easy, easy
      }
      at(ME.x, 0, ME.z, look);
      act.place(look.x, look.y, look.z, Math.PI);
      player._stand();
      act.perform(dt, { emotion: beat !== 'door', speech: speaker === 'father' ? speech : 0, light: null });
      return true;
    },
    camera(camera, dt) {
      if (!live) return false;
      const name = beat === 'talk' ? byLine[line] : beat === 'end' ? 'two' : 'door';
      if (name !== shot) {
        shot = name;
        shotAge = 0;
      }
      shotAge += dt;
      const [from, to2, fov, to] = shots[name],
        t = 1 - Math.exp(-shotAge * 0.3);
      at(mix(from[0], to[0], t), mix(from[1], to[1], t), mix(from[2], to[2], t), eye);
      at(to2[0], to2[1], to2[2], look);
      camera.position.copy(eye);
      camera.lookAt(look);
      camera.near = 0.05;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      return true;
    },
    dispose() {
      live = false;
      voice?.stop();
      storyDuck(0);
      act.dispose();
      k.dispose();
    },
  };
}
