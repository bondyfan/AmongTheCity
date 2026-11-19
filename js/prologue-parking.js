import { parkingLines } from './prologue-dialogue.js';
import { storyRecording } from './audio.js';
import { makeCitizen } from './citizen.js';
import { seatAnchor } from './vehicles.js';
import { SIT_DROP, seatX } from './seating.js';
import { storyHud } from './prologue-hud.js';
import { storyLights } from './prologue-lights.js';
import { waymark } from './prologue-marker.js';
import { vasekHouse, house, doorAt } from './prologue-house.js';
import { tableScene } from './prologue-table.js';
import { storyClock } from './prologue-clock.js';

// The Pardubice half of part one. Vašek waits by his estate car in front of
// the station; they talk, he gets in, and the player drives him home to
// Dražkovická 119. There they go inside, sit down at the kitchen table, and
// the film says what the job is (js/prologue-table.js).
//   talk → drive → walk (to the door) → fade → table → over
// Nothing spoken is skipped or waited for: the lines follow one another.
export function meetVasek(car, scene, world, map, complete, player) {
  const friend = makeCitizen({ uid: 'vasek', jacket: 0x525f4d, archetype: 'man' });
  const hud = storyHud(),
    lights = storyLights(scene),
    mark = waymark(scene, hud);
  let stage = 'talk',
    line = -1,
    ready = false,
    near = false,
    set = null,
    film = null,
    far = 1, // metres to the house when the drive began
    fade = 0,
    over = false;
  const sx = car.x + Math.cos(car.heading) * 1.55,
    sz = car.z - Math.sin(car.heading) * 1.55;
  friend.group.position.set(sx, world.terrain.heightAt(sx, sz), sz);
  friend.group.rotation.y = car.heading + Math.PI / 2;
  scene.add(friend.group);
  map.setWaypoint(car.x, car.z);
  let voice;
  const distance = (p) => Math.hypot(player.pos.x - p.x, player.pos.z - p.z);
  // The talk at the car runs by itself once he walks up, and goes on while
  // he gets in and drives: nothing waits for a key. After his first line
  // Vašek takes the passenger seat and the car is the player's.
  function aboard() {
    ready = true;
    friend.sitPose(1, 1);
    car.seats ??= [];
    car.seats[1] = friend;
    const p = seatAnchor(car, 1);
    car.mesh.add(friend.group);
    friend.group.position.set(seatX(p.x), p.y - SIT_DROP, p.z);
    friend.group.rotation.y = 0;
  }
  function speak() {
    voice?.stop();
    if (line === 0 && !ready) aboard();
    if (++line >= parkingLines.length || stage === 'table' || over) {
      hud.say();
      return;
    }
    const [id, who, text] = parkingLines[line];
    hud.say(who, text);
    const at = line;
    const on = () => {
      if (line === at && !over) speak();
    };
    let timer = 0;
    voice = storyRecording(id, {
      level: 1.7,
      end: () => setTimeout(on, 450),
      // no recording yet: leave the caption up for as long as it reads
      missing: () => {
        timer = setTimeout(on, 1300 + text.length * 62);
      },
    });
    const stop = voice.stop;
    voice.stop = () => {
      clearTimeout(timer);
      stop();
    };
  }
  // Vašek out of the car and at his own door, waiting to let him in.
  function toDoor() {
    stage = 'walk';
    if (car.seats?.[1] === friend) car.seats[1] = null;
    scene.add(friend.group);
    const p = doorAt(0.9, -0.9);
    friend.standPose();
    friend.group.position.set(p.x, world.heightAt(p.x, p.z), p.z);
    friend.group.rotation.y = house.h + 0.5;
    const d = set.door;
    mark.set({ x: d.x, y: set.ground, z: d.z }, 'Vchod');
    map.setWaypoint(d.x, d.z);
  }
  hud.button.onclick = () => api.use(player);
  const api = {
    car,
    get ready() {
      return ready;
    },
    get finished() {
      return over;
    },
    use() {
      if (film?.running) return film.use();
      if (stage === 'walk' && !player.inCar && distance(set.door) < 2.6) {
        stage = 'fade';
        fade = 0;
        hud.action();
        hud.veil(true);
        return true;
      }
      return false;
    },
    update(player_, dt = 0.016) {
      if (over) return;
      if (stage === 'talk') {
        storyClock.flow(dt, 20.7);
        near = !player.inCar && distance({ x: sx, z: sz }) < 4.8;
        if (near && line < 0) speak();
        if (!ready) {
          friend.group.position.y = world.terrain.heightAt(sx, sz);
          if (near) friend.group.rotation.y = Math.atan2(sx - player.pos.x, sz - player.pos.z);
        }
        const dist = Math.round(distance(car));
        hud.guide(
          'Pardubice • parkoviště',
          ready ? 'Sedni si za volant Vaškova kombíku' : 'Najdi Vaška u kombíku',
          ready ? 'Přistup k autu a stiskni E' : dist + ' m',
        );
        return;
      }
      const left = distance(house.kerb);
      if (!set && left < 320 && world.terrain.ready(house.x, house.z)) set = vasekHouse(scene, world);
      if (stage === 'drive') {
        // the evening goes by on the way: ten o'clock as they pull up
        storyClock.to(20.7 + (22 - 20.7) * Math.min(1, Math.max(0, 1 - left / far)));
        const close = left < 26;
        hud.guide(
          'Pardubice',
          close ? 'Zastav a vystup' : 'Odvez Vaška domů',
          'Dražkovická 119 · ' + (left < 950 ? Math.round(left / 10) * 10 + ' m' : (left / 1000).toFixed(1).replace('.', ',') + ' km'),
        );
        if (set && close && !player.inCar && !player.exiting) toDoor();
      } else if (stage === 'walk') {
        hud.guide('Dražkovická 119', 'Pojď za Vaškem dovnitř', '');
        // the porch lamp is one of the story's two real lights
        const lamp = doorAt(0.6, -0.7);
        lights.b.color.setHex(0xffd9a6);
        lights.b.distance = 9;
        lights.b.decay = 1.6;
        lights.b.intensity = 7;
        lights.b.position.set(lamp.x, set.ground + 2.2, lamp.z);
        hud.action(!player.inCar && distance(set.door) < 2.6 ? 'Vejít' : '');
        friend.walk(0, 0, 0, 0);
      } else if (stage === 'fade') {
        if ((fade += dt) > 0.95) {
          stage = 'table';
          storyClock.to(22);
          mark.set(null);
          map.setWaypoint(null);
          hud.guide('', '', '');
          film = tableScene({
            scene,
            world,
            player,
            hud,
            lights,
            set,
            friend,
            done: () => {
              // part one is over: he is back on the street, and it is saved
              const p = doorAt(0, -1.8);
              Object.assign(player.pos, p);
              player.y = world.heightAt(p.x, p.z);
              // facing his door, so the camera comes back out on the street side
              player.heading = -Math.PI / 2;
              player.mesh.position.set(p.x, player.y, p.z);
              player._stand();
              friend.group.visible = false;
              storyClock.release();
              over = true;
              complete('done');
            },
          });
        }
      } else if (stage === 'table') film.update(dt);
    },
    // The film at the table owns the camera and the body while it runs.
    frameCamera(camera, dt) {
      if (film?.running) return film.camera(camera, dt);
      mark.frame(camera, dt, player.pos.x, player.pos.z);
      return false;
    },
    posePlayer(dt) {
      return film?.running ? film.pose(dt) : false;
    },
    get seated() {
      return false;
    },
    // True once, when he takes the wheel with Vašek aboard: the drive begins.
    driving(c) {
      if (c !== car || !ready || stage !== 'talk') return false;
      stage = 'drive';
      far = Math.max(60, distance(house.kerb));
      hud.say();
      hud.action();
      map.setWaypoint(house.kerb.x, house.kerb.z);
      mark.set({ x: house.kerb.x, y: world.heightAt(house.kerb.x, house.kerb.z), z: house.kerb.z }, 'Dražkovická 119');
      return true;
    },
    // The campaign ended or started again: everything of this half goes.
    close() {
      voice?.stop();
      film?.dispose();
      if (car.seats?.[1] === friend) car.seats[1] = null;
      friend.dispose();
      set?.dispose();
      mark.dispose();
      map.setWaypoint(null);
      lights.dispose();
      hud.close();
    },
  };
  return api;
}
