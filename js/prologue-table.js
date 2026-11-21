import * as THREE from 'three';
import { voiceToMouth } from './characters/mouth.js';
import { tableTalk, hospitalMessage } from './prologue-dialogue.js';
import { storyRecording, storyDuck } from './audio.js';
import { actor } from './prologue-actor.js';

// The end of part one, at Vašek's kitchen table. They come in, he sits and
// says "sit down", the player sits (E), and Vašek says what the job is: a car
// to steal, tonight. He pushes a balaclava across the table. The hospital's
// reminder arrives on the phone, and the father says yes.
//   enter → ask (E) → sit → talk (lines) → sms → yes → end
// Room frame (prologue-house.js): his chair at z = −0.78, Vašek's at +0.78.
const SEAT = 0.44, // how far the hips come down onto a chair
  HIS = { x: 0, z: -0.76 },
  VASEK = { x: 0, z: 0.76 },
  DOOR = { x: 1.9, z: -1.9 },
  BESIDE = { x: 0.56, z: -0.8 };
// camera, look-at, lens; `to` is where the camera drifts
const shots = {
  enter: [[-2.35, 1.62, -1.95], [0.3, 0.9, 0.1], 44, [-2.1, 1.55, -1.7]],
  ask: [[-0.8, 1.32, -1.55], [0, 1.12, 0.78], 38, [-0.7, 1.3, -1.4]],
  sit: [[2.3, 1.25, -0.5], [0, 0.9, -0.3], 40, [2.1, 1.2, -0.45]],
  him: [[-0.36, 1.36, -1.42], [0.08, 1.1, 0.78], 40, [-0.33, 1.35, -1.34]],
  me: [[0.36, 1.36, 1.42], [-0.08, 1.1, -0.78], 40, [0.33, 1.35, 1.34]],
  price: [[-0.3, 1.2, -0.32], [0, 1.14, 0.78], 30, [-0.25, 1.19, -0.2]],
  mask: [[1.05, 1.45, 0.0], [0, 0.8, 0.02], 36, [0.95, 1.4, 0.0]],
  sms: [[0.32, 1.16, 0.06], [0, 1.08, -0.78], 32, [0.28, 1.16, 0.0]],
  yes: [[0.22, 1.18, -0.04], [0, 1.14, -0.78], 28, [0.18, 1.18, -0.1]],
};
const byLine = ['ask', 'him', 'me', 'him', 'me', 'price', 'mask', 'yes'];
const ease = (t) => t * t * (3 - 2 * t);
const mix = (a, b, t) => a + (b - a) * t;

export function tableScene({ scene, world, player, hud, lights, set, friend, done }) {
  const act = actor(player, lights);
  const eye = new THREE.Vector3(),
    look = new THREE.Vector3(),
    spot = new THREE.Vector3();
  let beat = 'enter',
    age = 0,
    line = 0,
    wait = Infinity,
    safety = 0,
    token = 0,
    voice = null,
    speaker = '',
    live = true,
    shot = '',
    shotAge = 0,
    sat = 0, // 0 standing … 1 seated (the player)
    hisSeat = 0, // the same for Vašek
    walk = 0,
    tv = 0;
  function say(index) {
    line = index;
    voice?.stop();
    const [id, who, words, role] = tableTalk[index];
    speaker = role;
    hud.say(who, words);
    hud.action();
    const mine = ++token;
    wait = Infinity;
    safety = Math.max(15, words.length * 0.16);
    voice = storyRecording(id, {
      meter: true,
      level: role === 'father' ? 1.8 : 1.9,
      end: () => {
        if (live && token === mine) wait = 0.55;
      },
      missing: () => {
        if (live && token === mine) wait = 1.3 + words.length * 0.062;
      },
    });
  }
  function enter(next) {
    beat = next;
    age = 0;
    if (next === 'ask') hud.action('Sednout si');
    if (next === 'sit') {
      hud.action();
      hud.say();
    }
    if (next === 'talk') say(1);
    if (next === 'sms') {
      ++token;
      voice?.stop();
      hud.say();
      hud.action();
      storyRecording('phone-ring', { level: 0.4 });
      hud.phone(hospitalMessage[0], '', hospitalMessage[1]);
    }
    if (next === 'yes') {
      hud.phone();
      say(tableTalk.length - 1);
    }
    if (next === 'end') {
      ++token;
      voice?.stop();
      hud.say();
      hud.action();
      hud.veil(true, 'Konec první části', 'Poslední vlak');
    }
  }
  function next() {
    if (beat === 'talk' && line + 1 < tableTalk.length - 1) say(line + 1);
    else if (beat === 'talk') enter('sms');
    else if (beat === 'sms') enter('yes');
    else if (beat === 'yes') enter('end');
  }
  // the lights go out on the kitchen and the street is his again
  function finish() {
    live = false;
    ++token;
    voice?.stop();
    hud.say();
    hud.action();
    hud.phone();
    act.release();
    set.show(false);
    storyDuck(0);
    lights.off();
    hud.cinema(false);
    hud.veil(false);
    done();
  }
  // Vašek leaves the car's seat for the room
  scene.add(friend.group);
  set.show(true);
  storyDuck(0.9);
  hud.cinema(true);
  hud.veil(false);
  set.room(0, 1.78, 0, lights.a.position);
  set.room(-2.0, 0.8, 1.1, lights.b.position);
  lights.a.color.setHex(0xffd9a0);
  lights.a.distance = 7.5;
  lights.a.decay = 1.4;
  lights.b.color.setHex(0x7c9fd0);
  lights.b.distance = 4.5;
  lights.b.decay = 2;
  return {
    get running() {
      return live;
    },
    use() {
      // E sits him down; the talk itself is not skipped
      if (beat === 'ask') enter('sit');
      return true;
    },
    // T after a failed mission (js/story-retry.js): the job is known, out he goes
    skip() {
      if (!live) return false;
      finish();
      return true;
    },
    update(dt) {
      age += dt;
      tv += dt;
      lights.a.intensity = 6.5;
      lights.b.intensity = 1.1 + 0.5 * Math.sin(tv * 7.3) * Math.sin(tv * 2.1);
      if (beat === 'enter') {
        if (age > 1.5 && line === 0 && token === 0) say(0);
        if (age > 3.4) enter('ask');
      } else if (beat === 'sit') {
        if (age > 1.5) enter('talk');
      } else if (beat === 'talk' || beat === 'yes') {
        if ((wait -= dt) <= 0 || (safety -= dt) <= 0) next();
      } else if (beat === 'sms') {
        if (age > 6.5) next();
      } else if (beat === 'end' && age > 4.6) {
        finish();
        return;
      }
      // the balaclava crosses the table while he talks about the cameras
      const pushed = beat === 'talk' && line === 6 ? Math.min(1, age / 1.4) : beat === 'sms' || beat === 'yes' || beat === 'end' ? 1 : -1;
      set.mask.visible = pushed >= 0;
      if (pushed >= 0) set.mask.position.set(0.06, 0.8, mix(0.3, -0.22, ease(pushed)));
    },
    pose(dt) {
      if (!live) return false;
      const speech = voice?.intensity() ?? 0;
      // Vašek: down onto his chair as they come in, then he talks with his head
      hisSeat = Math.min(1, hisSeat + (age > 0.5 || beat !== 'enter' ? dt / 1.1 : 0));
      const k = ease(hisSeat);
      set.room(mix(-0.5, VASEK.x, k), -SEAT * k, VASEK.z, friend.group.position);
      friend.group.rotation.y = 0;
      friend.sitPose(k, 0);
      const fj = friend.parts;
      fj.head.rotation.x += speaker === 'friend' ? -0.1 * speech : 0;
      friend.mouth?.(speaker === 'friend' ? voiceToMouth(speech) : 0);
      fj.torso.rotation.x += -0.14 * k;
      fj.armL.rotation.x += 0.35 * k;
      if (beat === 'talk' && line === 6) fj.armR.rotation.x += 0.75 * Math.sin(Math.min(1, age / 1.4) * Math.PI);
      // the player: in from the door, beside the chair, then onto it
      if (beat === 'enter') walk = Math.min(1, walk + dt / 2.8);
      if (beat === 'sit') sat = Math.min(1, sat + dt / 1.3);
      const w = ease(walk),
        f = ease(Math.max(0, (sat - 0.25) / 0.75)),
        side = ease(Math.min(1, sat / 0.35));
      const x = mix(mix(DOOR.x, BESIDE.x, w), HIS.x, side),
        z = mix(mix(DOOR.z, BESIDE.z, w), HIS.z, side);
      set.room(x, -SEAT * f, z, spot);
      // he walks in facing the table, and turns to face Vašek as he sits
      const coming = Math.atan2(-(BESIDE.x - DOOR.x), -(BESIDE.z - DOOR.z));
      const heading = mix(coming, Math.PI, Math.max(side, w > 0.9 ? (w - 0.9) * 4 : 0));
      act.place(spot.x, spot.y + SEAT * f, spot.z, heading);
      player.mesh.position.y = spot.y;
      if (beat === 'enter' && walk < 1) act.cit.walk(w * 3.2 * 1.6, 0.3, 0, 1.3);
      else player._sit(f, 0);
      if (sat > 0 && sat < 1) act.cit.parts.torso.rotation.x += -0.4 * Math.sin(f * Math.PI);
      act.perform(dt, {
        gesture: beat === 'sms' ? 'read' : null,
        emotion: beat === 'sms' || beat === 'yes' || beat === 'end',
        speech: speaker === 'father' ? speech : 0,
        light: null,
      });
      return true;
    },
    camera(camera, dt) {
      if (!live) return false;
      const name = beat === 'talk' ? byLine[line] : beat === 'end' ? 'yes' : beat;
      if (name !== shot) {
        shot = name;
        shotAge = 0;
      }
      shotAge += dt;
      const [from, at, fov, to] = shots[name],
        t = 1 - Math.exp(-shotAge * 0.3);
      set.room(mix(from[0], to[0], t), mix(from[1], to[1], t), mix(from[2], to[2], t), eye);
      set.room(at[0], at[1], at[2], look);
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
      set.show(false);
    },
  };
}
