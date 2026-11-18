import { parkingLines } from './prologue-dialogue.js';
import { storyRecording } from './audio.js';
import { makeCitizen } from './citizen.js';
import { seatAnchor } from './vehicles.js';
import { SIT_DROP, seatX } from './seating.js';
import { storyHud } from './prologue-hud.js';

export function meetVasek(car, scene, world, map, complete) {
  const friend = makeCitizen({ uid: 'vasek', jacket: 0x525f4d, archetype: 'man' });
  const hud = storyHud();
  let line = -1,
    ready = false,
    near = false,
    seated = false;
  const sx = car.x + Math.cos(car.heading) * 1.55,
    sz = car.z - Math.sin(car.heading) * 1.55;
  friend.group.position.set(sx, world.terrain.heightAt(sx, sz), sz);
  friend.group.rotation.y = car.heading + Math.PI / 2;
  scene.add(friend.group);
  map.setWaypoint(car.x, car.z);
  let voice;
  function speak() {
    if (!near || ready) return false;
    voice?.stop();
    if (++line === parkingLines.length) {
      ready = true;
      hud.say();
      hud.action();
      friend.sitPose(1, 1);
      car.seats ??= [];
      car.seats[1] = friend;
      const p = seatAnchor(car, 1);
      car.mesh.add(friend.group);
      friend.group.position.set(seatX(p.x), p.y - SIT_DROP, p.z);
      friend.group.rotation.y = 0;
    } else {
      const [id, who, text] = parkingLines[line];
      hud.say(who, text);
      voice = storyRecording(id, {
        end: () => {
          if (near && !seated) speak();
        },
      });
    }
    return true;
  }
  hud.button.onclick = speak;
  return {
    car,
    get ready() {
      return ready;
    },
    use(player) {
      if (player.inCar || player.boarding) return false;
      near = Math.hypot(player.pos.x - sx, player.pos.z - sz) < 4.8;
      return speak();
    },
    update(player) {
      if (seated) return;
      near = !player.inCar && Math.hypot(player.pos.x - sx, player.pos.z - sz) < 4.8;
      if (!ready) {
        friend.group.position.y = world.terrain.heightAt(sx, sz);
        if (near) friend.group.rotation.y = Math.atan2(sx - player.pos.x, sz - player.pos.z);
      }
      const dist = Math.round(Math.hypot(player.pos.x - car.x, player.pos.z - car.z));
      hud.guide(
        'Pardubice • parkoviště',
        ready ? 'Sedni si za volant Vaškova kombíku' : 'Najdi Vaška u kombíku',
        ready ? 'Přistup k autu a stiskni E' : dist + ' m',
      );
      hud.action(near && !ready ? (line < 0 ? 'Promluvit s Vaškem' : 'Pokračovat') : '');
    },
    driving(c) {
      if (c !== car || !ready) return false;
      seated = true;
      hud.close();
      if (map.waypoint?.x === car.x && map.waypoint?.z === car.z) map.setWaypoint(null);
      complete('done');
      return true;
    },
  };
}
