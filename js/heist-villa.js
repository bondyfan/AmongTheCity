import { storyRecording } from './audio.js';
import { carStart } from './caraudio.js';
import { villaCar } from './heist-car.js';
import { dressVilla } from './heist-sets.js';
import * as THREE from 'three';
import { villaInside, spots, pushOut, SIZE } from './heist-house.js';
import { scanners } from './heist-lasers.js';
import { startLine } from './heist-dialogue.js';
import { villa, villaAt, villaLocal, villaIn, dist } from './heist-route.js';

// THE VILLA (Frank, 21 Nov 2026): the car's key is in the house, the house is
// locked, and every room has a scanner in it. In by the ladder and the window
// on the side wall, through the hall, the living room and the study to the
// desk, out along the corridor by the back door, and round the corner to the
// car. A scanner that finds him is the end of the try; so is the camera on
// the corner if it sees a face. Nobody walks here, and a slow funk plays.
//
// The rooms are a set far under the house (js/heist-house.js). While he is in
// them this file is the ground under his feet and the walls round him
// (world.storyCoach), and tells the game's camera where the walls are.
const R = 0.38; // a walker's radius

export function villaJob({ scene, world, player, input, hud, lights, host, talk, mask, goal }) {
  const set = dressVilla(scene, world);
  const under = villaAt(villa.under.u, villa.under.v);
  const house = villaInside(scene, { x: under.x, y: set.ground - villa.under.depth, z: under.z });
  // the scanner over the ladder, in the set's own frame (x is v, z is −u)
  const sc = villa.scan;
  const outScan = scanners(set.group, [
    { cam: [sc.cam.v, set.floorAt(sc.cam.u, sc.cam.v) + sc.cam.up, -sc.cam.u], a: [sc.v, -sc.u0], b: [sc.v, -sc.u1], period: sc.period, floor: set.floorAt(villa.ladder.u, sc.v) },
  ]);
  let music = null; // a slow detective funk, from the gate until the engine catches
  let merc = villaCar(host, scene, world),
    inside = false,
    hasKey = false,
    fade = null, // { t, to: 'in' | 'out', moved }
    seen = 0, // seconds the camera has had a bare face in view
    crank = 0,
    coughed = false,
    tripped = false,
    age = 0;
  const eye = new THREE.Vector3(),
    look = new THREE.Vector3(),
    aim = new THREE.Vector3();
  let snap = true;
  const here = () => player.pos;
  const onFoot = () => !player.inCar && !player.boarding && !player.exiting;
  const ladder = villaAt(villa.ladder.u, villa.ladder.v - 0.35),
    backOut = villaAt(villa.back.u + 1.1, villa.back.v);
  const deck = {
    carrying: () => inside,
    support: () => house.origin.y,
    collide(pos, r) {
      if (!inside) return false;
      const l = house.local(pos.x, pos.z),
        moved = pushOut(l, r ?? R);
      if (moved) {
        pos.x = l.x + house.origin.x;
        pos.z = l.z + house.origin.z;
      }
      return moved;
    },
  };
  function put(x, y, z, h) {
    Object.assign(player.pos, { x, z });
    player.y = y;
    player.heading = h;
    player.mesh.position.set(x, y, z);
    host.camReset?.();
  }
  function cross(to) {
    if (fade) return;
    fade = { t: 0, to, moved: false };
    hud.veil(true);
    hud.action();
    storyRecording(to === 'in' ? 'window-climb' : 'house-door', { level: 0.9 });
  }
  function trip(why) {
    if (tripped) return;
    tripped = true;
    if (why === 'laser') storyRecording('villa-alarm', { level: 0.9 });
    host.fail(why);
  }
  function outside(dt) {
    const p = here(),
      l = villaLocal(p.x, p.z),
      car = merc.car,
      driving = host.driving() === car;
    outScan.update(dt);
    // a cold light under the lean-to, so the car can be seen at all
    const c = villaAt(villa.car.u + 1, villa.car.v - 2.2);
    lights.a.color.setHex(0xa9bfe0);
    lights.a.distance = 13;
    lights.a.decay = 1.5;
    lights.a.intensity = 2.6;
    lights.a.position.set(c.x, set.ground + 2.6, c.z);
    // the camera sees the drive along the house: a face without a hood is a face
    const c0 = villa.cone;
    if (!mask.on && onFoot() && l.u > c0.u0 && l.u < c0.u1 && Math.abs(l.v) < c0.half) {
      if ((seen += dt) > 0.9) return trip('camera');
    } else seen = 0;
    if (onFoot() && outScan.hit(l.v, -l.u) >= 0) return trip('laser');
    if (hasKey && !merc.keyed && dist(p, car) < 6) merc.key();
    let label = '';
    if (driving && car.hotwire) {
      label = 'Drž E: nastartuj';
      if (input.keys.has('KeyE')) {
        crank += dt / 2.6;
        if (crank > 0.12 && !coughed) {
          coughed = true;
          storyRecording('starter-fail', { level: 1.0 });
          talk.one(startLine, { level: 1.7 });
        }
        if (crank >= 1) {
          storyRecording('starter-catch', { level: 1.1 });
          merc.start();
          setTimeout(() => host.driving() === car && carStart(car.kind), 1700);
          return true;
        }
      }
    } else if (onFoot()) {
      if (!mask.on && Math.abs(l.u) < 5 && Math.abs(l.v) < 4) label = 'Nasadit kuklu';
      else if (merc.plateNear(p.x, p.z)) label = 'Urvat značku';
      else if (!hasKey && dist(p, ladder) < 1.5) label = 'Vylézt po žebříku k oknu';
    }
    hud.action(label);
    if (!hasKey) {
      hud.guide('Vila u lesa', 'Dostaň se do domu pro klíč od auta', 'Dveře jsou zamčené. U boční zdi stojí žebřík.');
      goal(l.u > -2 ? ladder : null, 'Žebřík', false);
    } else {
      hud.guide('Vila u lesa', driving ? 'Nastartuj' : 'Auto stojí pod přístřeškem', driving ? '' : 'Klíč máš');
      goal(driving ? null : car, 'Auto', false);
    }
    return false;
  }
  function indoors(dt) {
    const p = here(),
      l = house.local(p.x, p.z);
    house.update(dt);
    // one lamp for the room he is in: the night through the windows
    house.lamp(l.x, l.z, lights.a.position);
    lights.a.color.setHex(0x8ea6dc);
    lights.a.distance = 11;
    lights.a.decay = 1.25;
    lights.a.intensity = 1.9;
    if (house.scan.hit(l.x, l.z) >= 0) return trip('laser');
    const atKey = !hasKey && Math.hypot(l.x - spots.key.x, l.z - spots.key.z) < 1.15,
      atExit = Math.hypot(l.x - spots.exit.x, l.z - spots.exit.z) < 1.25;
    hud.action(atKey ? 'Vzít klíč od auta' : atExit ? 'Vyjít zadními dveřmi' : '');
    hud.guide('Vila', hasKey ? 'Vyjdi zadními dveřmi' : 'Najdi klíč od auta', hasKey ? 'Na konci chodby, pod zeleným světlem' : 'Do červeného paprsku nesmíš');
    goal(null);
    return false;
  }
  const api = {
    get car() {
      return merc;
    },
    get indoors() {
      return inside;
    },
    get hasKey() {
      return hasKey;
    },
    // The rooms are seen from above and from the south, the ceiling off, the
    // way a plan is read: the whole room, the beams and the doors at once. The
    // game's own boom does not fit between these walls (it was in them).
    camera(camera, dt) {
      const o = house.origin,
        p = here();
      // the lens follows him, but does not look past the house's ends for long
      look.set(Math.max(o.x + 2.2, Math.min(o.x + SIZE.x - 2.2, p.x)), o.y + 1.0, Math.max(o.z + 1.2, Math.min(o.z + SIZE.z - 1.0, p.z)));
      eye.set(look.x, look.y + 7.4, look.z - 3.7);
      if (snap) camera.position.copy(eye), aim.copy(look), (snap = false);
      const k = 1 - Math.exp(-dt * 5);
      camera.position.lerp(eye, k);
      aim.lerp(look, k);
      camera.lookAt(aim);
      camera.near = 0.3;
      camera.fov = 44;
      camera.updateProjectionMatrix();
      host.aim?.(Math.PI); // W is up the picture: north
      return true;
    },
    // (harness) straight in by the window
    goIn() {
      if (!inside) cross('in');
    },
    // E. True when the villa took the key press.
    use() {
      if (fade) return true;
      const p = here();
      if (inside) {
        const l = house.local(p.x, p.z);
        if (!hasKey && Math.hypot(l.x - spots.key.x, l.z - spots.key.z) < 1.15) {
          hasKey = true;
          house.takeKey();
          storyRecording('key-pick', { level: 0.9 });
          return true;
        }
        if (Math.hypot(l.x - spots.exit.x, l.z - spots.exit.z) < 1.25) cross('out');
        return true; // nothing else in here answers E
      }
      const l = villaLocal(p.x, p.z),
        car = merc.car;
      if (host.driving() === car && car.hotwire) return true; // the key is being held to start
      if (!onFoot()) return false;
      if (!mask.on && Math.abs(l.u) < 5 && Math.abs(l.v) < 4) {
        mask.set(true);
        return true;
      }
      const plate = merc.plateNear(p.x, p.z);
      if (plate) {
        merc.rip(plate);
        return true;
      }
      if (!hasKey && dist(p, ladder) < 1.5) {
        cross('in');
        return true;
      }
      return false;
    },
    // True once the engine has caught: the story goes on to the road.
    update(dt) {
      age += dt;
      set.blink(age);
      music ??= storyRecording('villa-music', { loop: true, level: 0 });
      music.set(tripped ? 0 : 0.42, 0.6);
      if (fade) {
        fade.t += dt;
        if (!fade.moved && fade.t > 0.6) {
          fade.moved = true;
          if (fade.to === 'in') {
            inside = true;
            snap = true;
            world.storyCoach = deck;
            const s = house.at(spots.enter.x, 0, spots.enter.z);
            put(s.x, s.y, s.z, spots.enter.h);
          } else {
            inside = false;
            if (world.storyCoach === deck) world.storyCoach = null;
            put(backOut.x, world.heightAt(backOut.x, backOut.z), backOut.z, villaIn + Math.PI / 2);
          }
        }
        if (fade.t > 1.25) {
          fade = null;
          hud.veil(false);
        }
        return false;
      }
      return inside ? indoors(dt) : outside(dt);
    },
    // back to the gate for another try: the key is on the desk again, the car as it stood
    reset() {
      inside = false;
      if (world.storyCoach === deck) world.storyCoach = null;
      fade = null;
      hasKey = tripped = coughed = false;
      seen = crank = 0;
      house.putKey();
      merc.dispose();
      merc = villaCar(host, scene, world);
      goal(null);
    },
    // the road: nothing of the house is needed any more, the car is
    leave() {
      music?.stop(2.5);
      music = null;
      goal(null);
    },
    dispose() {
      if (world.storyCoach === deck) world.storyCoach = null;
      music?.stop(0.4);
      outScan.dispose();
      house.dispose();
      merc?.dispose();
      merc = null;
      set.dispose();
    },
  };
  return api;
}
