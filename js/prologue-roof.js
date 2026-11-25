import * as THREE from 'three';
import { scenery } from './prologue-kit.js';
import { roofFrame, stationEntry } from './prologue-route.js';
import { groundFor } from './terrain.js';
import { chunkKey, pointInPolygon } from './geo.js';
import { dressRoof, dressDoor, dressLadder } from './prologue-roofset.js';
import { stepUp, UP_TIME, DOWN_TIME } from './prologue-stepup.js';

// The roof scene. He stands a step back from the edge of the end wall, four
// storeys over the pavement; when the bank says no he climbs onto the coping.
// The film cuts round him: his back against the town, the
// drop under his shoes, his face in the light of the phone. When Vašek names
// the money he steps back down, and he leaves by the stair head.
const lerp = THREE.MathUtils.lerp;
const sin = Math.sin(roofFrame.h),
  cos = Math.cos(roofFrame.h);
// roof frame → world (x across the wall, z back along the roof)
export const world2 = (x, z) => ({ x: roofFrame.x + x * cos + z * sin, z: roofFrame.z - x * sin + z * cos });
// The height of the roof deck: the building's own top (its walls stand on
// groundFor), or the mapped storeys over the ground while its tile is on the way.
export function deckY(world) {
  const x = roofFrame.x + sin * 3,
    z = roofFrame.z + cos * 3;
  const home = world.city.chunkIndex.get(chunkKey(x, z))?.buildings?.find?.((b) => pointInPolygon(x, z, b.o));
  return home ? groundFor(home, world.terrain) + home.h : world.terrain.heightAt(roofFrame.x, roofFrame.z) + roofFrame.floors;
}

const LEDGE = { x: 0.55, z: 0.14, up: 0.6 },
  DECK = { x: 0.55, z: 1.2, up: 0.035 }; // a step back from the coping
// Offsets are (right, up, forward) from his eyes, as on the street.
const shots = {
  est: { cam: [3.6, 3.3, -11.5], to: [2.5, 2.1, -7.2], look: [-0.3, -1.3, 6], fov: 40, rate: 0.22 },
  drop: { cam: [0.34, 0.75, 0.1], to: [0.3, 0.95, 0.16], look: [0.02, -9, 1.5], fov: 52, rate: 0.3 },
  sms: { cam: [-0.5, -0.22, 1.5], to: [-0.4, -0.18, 1.2], look: [0.03, -0.05, 0], fov: 33 },
  // from the felt behind him, low: the whole of the step up onto the coping
  // is in the frame (from in front of the wall the wall hid his legs)
  // (from his right: the chair and the crate stand on the other side)
  step: { cam: [2.1, -0.95, -3.5], to: [1.6, -0.9, -2.9], look: [-0.25, -0.55, 2.5], fov: 40, rate: 0.5 },
  ring: { cam: [5.6, 0.5, 1.6], to: [4.6, 0.35, 1.2], look: [0, -0.35, 0], fov: 34 },
  f0: { cam: [0.78, 0.3, -1.4], to: [0.64, 0.26, -1.12], look: [-0.5, -1.3, 14], fov: 40 },
  f1: { cam: [0.3, 0.02, 1.1], to: [0.22, 0.03, 0.84], look: [0.02, -0.03, 0], fov: 33 },
  f2: { cam: [-1.9, 0.08, 0.5], to: [-1.5, 0.06, 0.62], look: [0, -0.05, 0.1], fov: 34 },
  f3: { cam: [-0.3, -0.02, 1.0], to: [-0.24, 0, 0.8], look: [0.02, -0.03, 0], fov: 33 },
  f4: { cam: [3.6, 1.2, -5.4], to: [2.6, 0.8, -3.8], look: [-0.3, -0.5, 6], fov: 38, rate: 0.2 },
  f5: { cam: [-0.42, 0.04, 0.9], to: [-0.36, 0.04, 0.72], look: [0.02, -0.02, 0], fov: 32 },
  f6: { cam: [-0.13, 0.03, 0.52], to: [-0.1, 0.03, 0.4], look: [0, 0, 0], fov: 30 },
  f7: { cam: [-1.0, -0.7, 3.0], to: [-0.85, -0.6, 2.5], look: [0, -0.3, 0], fov: 36 },
  f8: { cam: [-0.75, 0.32, -1.7], to: [-0.62, 0.28, -1.3], look: [0.4, -2.4, 30], fov: 28, own: true },
  f9: { cam: [0.5, -0.1, 1.9], to: [0.42, -0.06, 1.5], look: [0, -0.12, 0], fov: 34, own: true },
};

export function rooftop(scene, world, player, act, lights) {
  const deck = () => deckY(world);
  const group = new THREE.Group(),
    kit = scenery(group);
  group.name = 'Kolín • střecha bytového domu';
  group.rotation.y = roofFrame.h;
  group.position.set(roofFrame.x, deck(), roofFrame.z);
  dressRoof(kit);
  dressLadder(kit, group.position.y - world.terrain.heightAt(world2(-3.6, -1).x, world2(-3.6, -1).z));
  kit.finish();
  scene.add(group);
  const porch = new THREE.Group(),
    doorKit = scenery(porch);
  porch.name = 'Kolín • domovní dveře';
  porch.rotation.y = roofFrame.h;
  const wallFoot = world2(-1.1, -0.6);
  porch.position.set(roofFrame.x, world.terrain.heightAt(wallFoot.x, wallFoot.z), roofFrame.z);
  dressDoor(doorKit);
  doorKit.finish();
  scene.add(porch);
  // The lamp over the stair-head door: warm on his back, dark between scenes.
  const lamp = lights.b;
  const eyes = new THREE.Vector3(),
    target = new THREE.Vector3(),
    anchor = new THREE.Vector3();
  // towards the station: where he turns once there is a train to catch
  const toStation = Math.atan2(-(stationEntry.x - roofFrame.x), -(stationEntry.z - roofFrame.z));
  let shot = '',
    shotAge = 0,
    step = 1, // 0 on the ledge, 1 down on the roof
    turn = 0;
  function offset(out, [r, u, f], base, h) {
    return out.set(base.x + Math.cos(h) * r - Math.sin(h) * f, base.y + u, base.z - Math.sin(h) * r - Math.cos(h) * f);
  }
  return {
    begin() {
      shot = '';
      shotAge = turn = 0;
      step = 1; // he begins a step back from the edge, thinking
      group.position.y = deck();
      lamp.position.set(world2(1.85, 7.3).x, group.position.y + 2.2, world2(1.85, 7.3).z);
      this.pose(0, { gesture: null });
    },
    // gesture, emotion, speech as the actor takes them; `down` steps him off
    // the coping and `face` turns him to the station.
    pose(dt, { gesture = null, emotion = false, speech = 0, down = false, face = false } = {}) {
      // up onto the coping and back down as a real step (js/prologue-stepup.js):
      // `step` is 0 on the ledge, 1 down on the roof, and moves at walking pace
      step = down ? Math.min(1, step + dt / DOWN_TIME) : Math.max(0, step - dt / UP_TIME);
      turn += ((face ? 1 : 0) - turn) * Math.min(1, dt * 1.8);
      const top = group.position.y,
        m = stepUp(1 - step),
        j = act.cit.parts;
      const x = lerp(DECK.x, LEDGE.x, m.forward),
        z = lerp(DECK.z, LEDGE.z, m.forward),
        heading = roofFrame.h + (toStation - roofFrame.h) * turn;
      const y = top + lerp(DECK.up, LEDGE.up, m.up) + m.dip;
      const p = world2(x, z);
      act.place(p.x, y, p.z, heading);
      if (m.walk !== null && m.walk > 0 && m.walk < 1) {
        // two short paces to the wall (backwards when he comes down from it)
        act.cit.walk(m.walk * Math.PI * 2, 0.16, 0, 0.9);
      } else {
        player._stand();
        j.legR.rotation.x = m.hipR;
        j.kneeR.rotation.x = m.kneeR;
        j.legL.rotation.x = m.hipL;
        j.kneeL.rotation.x = m.kneeL;
        j.torso.rotation.x += m.lean;
        j.armL.rotation.x += m.arm;
      }
      // a man on a ledge leans a little into the air and back
      if (step < 0.02) j.torso.rotation.x += 0.035 * Math.sin(act.age * 0.7) - 0.03;
      act.perform(dt, { gesture, emotion, speech, light: 1, bow: gesture ? 0 : 0.3 * (1 - step) });
      lamp.color.setHex(0xffb873);
      lamp.distance = 9;
      lamp.decay = 1.7;
      lamp.intensity = 9;
    },
    camera(camera, dt, key) {
      const def = shots[key] ?? shots.est;
      act.eyes(eyes);
      if (key !== shot) {
        shot = key;
        shotAge = 0;
        anchor.copy(eyes);
      }
      shotAge += dt;
      const t = 1 - Math.exp(-shotAge * (def.rate ?? 0.38)),
        breathe = Math.sin(act.age * 0.71) * 0.006;
      const mix = def.cam.map((v, i) => lerp(v, def.to[i], t));
      mix[1] += breathe;
      // shots keep the roof's own axes; `own` ones turn with him to the station
      const h = def.own ? player.heading : roofFrame.h;
      offset(camera.position, mix, def.fixed ? anchor : eyes, h);
      offset(target, def.look, eyes, h);
      camera.lookAt(target);
      camera.near = 0.03;
      camera.fov = def.fov;
      camera.updateProjectionMatrix();
    },
    // The film is over: he stands on the felt, turned to the ladder's corner.
    handOver() {
      const p = world2(DECK.x, DECK.z),
        to = world2(-3.6, 0.9);
      act.place(p.x, group.position.y + DECK.up, p.z, Math.atan2(-(to.x - p.x), -(to.z - p.z)));
    },
    release() {
      lamp.intensity = 0;
    },
    dispose() {
      kit.dispose();
      doorKit.dispose();
    },
  };
}
