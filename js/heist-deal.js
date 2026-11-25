import { endCard } from './campaignparts.js';
import * as THREE from 'three';
import { storyRecording, storyDuck } from './audio.js';
import { voiceToMouth } from './characters/mouth.js';
import { makeCitizen } from './citizen.js';
import { actor } from './prologue-actor.js';
import { props } from './story-props.js';
import { storyClock } from './prologue-clock.js';
import { dealTalk } from './heist-dialogue.js';
import { ROOM } from './heist-garage.js';

// NOON IN THE LOCK-UP (Frank, 21 Nov 2026: "aby tam bylo vidět, jak ten kupec
// dá tomu Vaškovi peníze a ten Vašek dá potom ty peníze v kufříku. Fakt si
// pohraj s animacemi"). The door is up on a white day. The buyer walks in with
// a briefcase, looks the car over, and holds the case out; Vašek takes it,
// lays it on his arm and opens it on the money, shuts it, crosses to the
// father and puts it in his hand. A hand on the shoulder, and the father
// walks out into the light with it.
//   card → arrive → [0 buyer] → [1 Vašek] → [2 buyer: the case changes hands]
//   → look (the money) → [3 Vašek: across the room, the case changes hands]
//   → [4 father] → [5 Vašek] → out → end
// Room frame as js/heist-garage.js: x across, z from the door (−) inwards.
const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const span = (t, a, b) => ease((t - a) / (b - a));
const mix = (a, b, t) => a + (b - a) * t;
const facing = (from, to) => Math.atan2(-(to.x - from.x), -(to.z - from.z));
const turnTo = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;
// where they stand
const DOOR = { x: 0.55, z: -5.4 },
  BUYER = { x: 0.3, z: -1.9 }, // by the car's tail
  BY_CAR = { x: -0.12, z: 0.15 }, // where he waits afterwards, a hand's reach from the door
  VASEK = { x: 1.2, z: -1.15 },
  VASEK2 = { x: 1.42, z: -0.3 }, // in front of the father
  ME = { x: 1.72, z: 0.82 },
  OUT = [{ x: 0.62, z: 0.05 }, { x: 0.55, z: -5.6 }]; // round Vašek, then straight out of the door
// camera, look-at, lens, where the camera drifts to
const shots = {
  arrive: [[2.35, 1.5, 0.1], [0.3, 1.1, -3.7], 42, [2.25, 1.48, -0.2]],
  car: [[1.75, 1.5, -3.0], [-0.7, 0.85, -0.8], 44, [1.6, 1.48, -2.85]],
  vasek: [[0.55, 1.5, -1.95], [1.2, 1.5, -1.15], 32, [0.6, 1.5, -1.9]],
  pass: [[2.2, 1.12, -3.3], [0.78, 1.02, -1.5], 40, [2.05, 1.1, -3.1]],
  money: [[0.62, 1.78, -1.7], [1.02, 1.02, -1.42], 30, [0.7, 1.72, -1.66]],
  give: [[-0.2, 1.38, 0.5], [1.56, 1.14, 0.26], 48, [-0.08, 1.36, 0.46]],
  me: [[1.3, 1.52, -0.12], [1.72, 1.5, 0.82], 30, [1.33, 1.52, -0.05]],
  him: [[2.05, 1.52, 0.7], [1.42, 1.52, -0.3], 30, [2.0, 1.52, 0.62]],
  out: [[1.5, 1.2, 2.7], [0.6, 1.0, -3.8], 38, [1.4, 1.2, 2.4]],
};
const byLine = ['car', 'vasek', 'pass', 'give', 'me', 'him'];
const SILENT = { card: 2.8, arrive: 4.4, look: 4.6, out: 4.6 };

// `note` is the end card's second line: what the briefcase pays, or that a
// replay pays nothing (js/career.js heistRewardNote).
export function dealScene({ scene, player, hud, lights, set, friend, done, note }) {
  const { H } = ROOM;
  const act = actor(player, lights),
    kit = props(),
    box = kit.briefcase();
  const buyer = makeCitizen({ uid: 'kupec', avatar: 'bm02', archetype: 'man', jacket: 0x23262c, pants: 0x1c1e22, seed: 9113 });
  scene.add(buyer.group, friend.group, box);
  friend.group.visible = true;
  const eye = new THREE.Vector3(),
    look = new THREE.Vector3(),
    spot = new THREE.Vector3(),
    handA = new THREE.Vector3(),
    handB = new THREE.Vector3();
  let beat = 'card',
    age = 0,
    line = -1,
    lineAge = 0,
    wait = Infinity,
    safety = 0,
    token = 0,
    voice = null,
    speaker = '',
    live = true,
    shot = '',
    shotAge = 0,
    stride = 0; // metres the father has walked, for his gait
  // who has the case: 0 the buyer, 1 Vašek, 2 the father (fractions are a handover)
  let owner = 0;
  function say(index) {
    beat = 'talk';
    line = index;
    lineAge = 0;
    voice?.stop();
    const [id, who, words, role] = dealTalk[index];
    speaker = role;
    hud.say(who, words);
    const mine = ++token;
    wait = Infinity;
    safety = Math.max(15, words.length * 0.16);
    voice = storyRecording(id, {
      meter: true,
      level: 1.85,
      end: () => {
        if (live && token === mine) wait = 0.55;
      },
      missing: () => {
        if (live && token === mine) wait = 1.3 + words.length * 0.062;
      },
    });
  }
  function quiet(next) {
    beat = next;
    age = 0;
    ++token;
    voice?.stop();
    speaker = '';
    hud.say();
  }
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
  // a hand in the world (the sockets follow the drawn bones)
  function hand(cit, out, left = false) {
    const h = left ? cit.parts.handL : cit.parts.handR;
    h.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(h.matrixWorld);
  }
  // an arm held out: k = 0 hanging, 1 offering something at the height of the belt
  function reach(cit, k, left = false) {
    const p = cit.parts,
      arm = left ? p.armL : p.armR,
      elbow = left ? p.elbowL : p.elbowR;
    arm.rotation.x += 0.95 * k;
    elbow.rotation.x += 0.5 * k;
  }
  // a citizen walking from a to b: t is 0..1 along it
  function walkTo(cit, a, b, t, phase) {
    const k = ease(t),
      x = mix(a.x, b.x, k),
      z = mix(a.z, b.z, k),
      moving = t > 0.02 && t < 0.98;
    set.at(x, 0, z, cit.group.position);
    if (moving) cit.walk(phase, 0.8, 0, 1.1);
    else cit.standPose();
    return moving;
  }
  storyDuck(0.9);
  hud.cinema(true);
  hud.veil(true, 'V poledne', 'Na Staré poště · 12:00');
  storyClock.to(12);
  set.open(true);
  // daylight through the door, the bulb forgotten on
  lights.b.color.setHex(0xfff2dc);
  lights.b.distance = 13;
  lights.b.decay = 1.15;
  lights.a.color.setHex(0xffd9a0);
  lights.a.distance = 7;
  lights.a.decay = 1.5;
  set.at(0.4, 1.9, -3.1, lights.b.position);
  set.at(0.6, H - 0.4, -0.6, lights.a.position);
  return {
    get running() {
      return live;
    },
    use() {
      return true;
    },
    // T after a failed mission (js/story-retry.js)
    // T: the talk goes, the part's end card stays (Frank, 25 Nov 2026: every
    // part has its end); the street at noon follows it as always
    skip() {
      if (!live) return false;
      if (beat !== 'end') {
        quiet('end');
        hud.veil(true, endCard('part2')[0], note ?? endCard('part2')[1]);
      }
      return true;
    },
    update(dt) {
      if (!live) return;
      age += dt;
      lineAge += dt;
      lights.b.intensity = 15;
      lights.a.intensity = 3.2;
      if (beat === 'card') {
        if (age > SILENT.card) (hud.veil(false), quiet('arrive'), storyRecording('garage-door', { level: 0.5 }));
      } else if (beat === 'arrive') {
        if (age > SILENT.arrive) say(0);
      } else if (beat === 'talk') {
        if ((wait -= dt) <= 0 || (safety -= dt) <= 0) {
          if (line === 2) quiet('look');
          else if (line === 5) quiet('out');
          else say(line + 1);
        }
      } else if (beat === 'look') {
        if (age > SILENT.look) say(3);
      } else if (beat === 'out') {
        if (age > SILENT.out) {
          quiet('end');
          hud.veil(true, endCard('part2')[0], note ?? endCard('part2')[1]);
        }
      } else if (beat === 'end' && age > 4.8) finish();
    },
    pose(dt) {
      if (!live) return false;
      const speech = voice?.intensity() ?? 0,
        L = beat === 'talk' ? line : -1,
        // how far the scene has got: the lines are 0..5, the look into the case sits between 2 and 3
        step = beat === 'talk' ? line : beat === 'look' ? 2.5 : beat === 'out' || beat === 'end' ? 6 : -1,
        after = (n) => step > n;
      // ---- the buyer
      const bj = buyer.parts;
      let bh = Math.PI / 2; // he looks the car over
      if (beat === 'card') set.at(DOOR.x, 0, DOOR.z, buyer.group.position), buyer.standPose();
      else if (beat === 'arrive') {
        walkTo(buyer, DOOR, BUYER, age / 3.6, age * 1.1 * 1.6);
        bh = turnTo(facing(DOOR, BUYER), Math.PI / 2, span(age, 3.3, 4.2));
      } else if (after(2)) {
        // paid: he goes and stands by what he bought
        const t = beat === 'look' ? age / 2.6 : 1;
        walkTo(buyer, BUYER, BY_CAR, t, age * 1.1 * 1.6);
        bh = t < 1 ? facing(BUYER, BY_CAR) : Math.PI / 2;
      } else {
        set.at(BUYER.x, 0, BUYER.z, buyer.group.position);
        buyer.standPose();
        const toHim = facing(BUYER, VASEK);
        if (L === 0) bj.head.rotation.y += -1.0 * span(lineAge, 2.6, 3.4); // "and nobody saw you?" over his shoulder
        if (L === 1) bh = turnTo(Math.PI / 2, toHim, span(lineAge, 0.2, 1.0));
        if (L === 2) (bh = toHim), reach(buyer, span(lineAge, 0.5, 1.3) * (1 - span(lineAge, 2.3, 3.0)));
      }
      buyer.group.rotation.y = bh;
      bj.head.rotation.x += speaker === 'buyer' ? -0.08 * speech : 0;
      buyer.mouth?.(speaker === 'buyer' ? voiceToMouth(speech) : 0);
      // ---- Vašek
      const fj = friend.parts;
      let fh = facing(VASEK, BUYER),
        flat = 0, // the case laid on his arm
        open = 0;
      if (L === 3 || after(3)) {
        const t = L === 3 ? lineAge / 1.3 : 1;
        walkTo(friend, VASEK, VASEK2, t, lineAge * 1.1 * 1.6);
        fh = turnTo(facing(VASEK, BUYER), facing(VASEK2, ME), span(lineAge * (L === 3 ? 1 : 9), 0, 1.0));
        if (L === 3) reach(friend, span(lineAge, 1.4, 2.1) * (1 - span(lineAge, 3.0, 3.7)));
        if (L === 5) reach(friend, 1.25 * span(lineAge, 0.3, 1.1), true); // a hand on his shoulder
        // he turns to watch him go
        if (beat === 'out' || beat === 'end') fh = turnTo(facing(VASEK2, ME), facing(VASEK2, OUT[1]), beat === 'out' ? span(age, 0.5, 1.9) : 1);
      } else {
        set.at(VASEK.x, 0, VASEK.z, friend.group.position);
        friend.standPose();
        if (beat === 'arrive') fj.head.rotation.y += 0.25 * span(age, 2, 3.5);
        if (L === 2) reach(friend, span(lineAge, 0.9, 1.6) * (1 - span(lineAge, 2.4, 3.1)));
        if (beat === 'look') {
          // the case flat on his left arm, the lid up, his eyes in it
          flat = span(age, 0.2, 1.0) * (1 - span(age, 3.5, 4.3));
          open = span(age, 1.0, 1.7) * (1 - span(age, 2.9, 3.5));
          reach(friend, 0.85 * flat, true);
          reach(friend, 0.6 * flat);
          fj.head.rotation.x += 0.42 * flat;
        }
      }
      friend.group.rotation.y = fh;
      fj.head.rotation.x += speaker === 'friend' ? -0.1 * speech : 0;
      friend.mouth?.(speaker === 'friend' ? voiceToMouth(speech) : 0);
      // ---- the father
      let mh = 0, // facing the door
        walking = false;
      if (beat === 'out' || beat === 'end') {
        // out with it: round Vašek and through the door into the day
        const d1 = Math.hypot(OUT[0].x - ME.x, OUT[0].z - ME.z),
          d2 = Math.hypot(OUT[1].x - OUT[0].x, OUT[1].z - OUT[0].z),
          s = Math.min(d1 + d2, beat === 'out' ? Math.max(0, age - 0.3) * 1.5 : 99), // metres walked
          first = s < d1,
          a = first ? ME : OUT[0],
          b = first ? OUT[0] : OUT[1],
          k = first ? s / d1 : (s - d1) / d2;
        set.at(mix(a.x, b.x, k), 0, mix(a.z, b.z, k), spot);
        mh = facing(a, b);
        walking = beat === 'out' && age > 0.3 && s < d1 + d2;
        if (walking) stride += dt * 1.5;
      } else set.at(ME.x, 0, ME.z, spot);
      act.place(spot.x, spot.y, spot.z, mh);
      if (walking) act.cit.walk(stride * 1.6, 0.6, 0, 1.5);
      else player._stand();
      if (L === 3) reach(act.cit, span(lineAge, 2.0, 2.7) * (1 - span(lineAge, 3.3, 4.0)));
      act.perform(dt, { emotion: L >= 4 || beat === 'out' || beat === 'end', speech: speaker === 'father' ? speech : 0, light: null });
      // ---- the case: in a hand, between two hands, or open on an arm
      owner = L === 2 ? span(lineAge, 1.5, 2.1) : L === 3 ? 1 + span(lineAge, 2.6, 3.2) : after(3) ? 2 : after(2) ? 1 : 0;
      const from = owner < 1 ? buyer : owner < 2 ? friend : act.cit,
        to = owner <= 0 ? buyer : owner <= 1 ? friend : act.cit,
        k = owner - Math.floor(owner);
      hand(from, handA);
      hand(to, handB);
      box.position.lerpVectors(handA, handB, Number.isInteger(owner) ? 0 : ease(k));
      const holder = owner < 0.5 ? bh : owner < 1.5 ? fh : mh;
      box.rotation.set(0, holder + Math.PI / 2, 0, 'YXZ'); // carried edge-on, like any case
      if (flat > 0) {
        // on his forearm in front of him, the handle away, the lid towards the lens
        const fx = -Math.sin(fh),
          fz = -Math.cos(fh);
        set.at(VASEK.x, 1.08, VASEK.z, spot);
        spot.x += fx * 0.36;
        spot.z += fz * 0.36;
        box.position.lerp(spot, flat);
        box.rotation.set((-Math.PI / 2) * flat, mix(holder + Math.PI / 2, fh, flat), 0, 'YXZ');
        // (the grip is the case's origin, and laid flat it is the far edge: push
        // it out so the middle of the case, not its handle, is over his arm)
        box.position.x += fx * 0.2 * flat;
        box.position.z += fz * 0.2 * flat;
      }
      box.userData.open(open);
      return true;
    },
    camera(camera, dt) {
      if (!live) return false;
      const name = beat === 'talk' ? byLine[line] : beat === 'look' ? 'money' : beat === 'out' || beat === 'end' ? 'out' : 'arrive';
      if (name !== shot) {
        shot = name;
        shotAge = 0;
      }
      shotAge += dt;
      const [from, at, fov, to] = shots[name],
        t = 1 - Math.exp(-shotAge * 0.3);
      set.at(mix(from[0], to[0], t), mix(from[1], to[1], t), mix(from[2], to[2], t), eye);
      set.at(at[0], at[1], at[2], look);
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
      buyer.group.removeFromParent();
      buyer.dispose();
      kit.dispose();
    },
  };
}
