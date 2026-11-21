import { makeCitizen } from './citizen.js';
import { storyRecording } from './audio.js';
import { carStart } from './caraudio.js';
import * as wanted from './wanted.js';
import { unlock } from './carlocks.js';
import { storyHud } from './prologue-hud.js';
import { storyLights } from './prologue-lights.js';
import { waymark } from './prologue-marker.js';
import { storyClock } from './prologue-clock.js';
import { vasekHouse } from './prologue-house.js';
import { talker } from './heist-talk.js';
import { farmerVan } from './heist-farmer.js';
import { villaCar } from './heist-car.js';
import { manhunt } from './heist-police.js';
import { garageScene } from './heist-garage.js';
import { balaclava } from './heist-mask.js';
import { dressFarm, dressVilla, dressGarage } from './heist-sets.js';
import { sendOff, farmTalk, rideTalk, dropTalk, villaCall, startLine, cityCall } from './heist-dialogue.js';
import { start, kombi, farm, villa, villaAt, villaLocal, villaIn, city, hours, dist } from './heist-route.js';
import { retry } from './story-retry.js';

// PART TWO of the Last Train: the car under Kunětická hora (Frank, 18 and 20
// Nov 2026). Half past two at night in front of Vašek's house:
//   wake   Vašek sends him to Brozany in the estate
//   tofarm the drive there
//   farm   Jarda, his van, his radio; "vylez z toho auta, hodím tě tam já"
//   ride   the passenger seat, and Jarda on astrology
//   drop   set down on the road by the forest
//   walk   Vašek on the phone: the camera, the balaclava, the plates
//   theft  the gate, the window, two wires, and (if he remembers) the plates
//   run    home at daybreak with the police looking; Vašek rings about the
//          roadblock; the lock-up in Na Staré poště
//   end    the door comes down (js/heist-garage.js), and it is saved
// Nothing is written before the end. Caught, dead or without the car, he goes
// back to the villa's gate once he has reached it, else to Vašek's street.
const km = (m) => (m < 950 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(1).replace('.', ',') + ' km');
const lerp = (a, b, t) => a + (b - a) * Math.max(0, Math.min(1, t));

export function createHeist({ scene, world, player, map, input, traffic, host, complete }) {
  const hud = storyHud(),
    lights = storyLights(scene),
    mark = waymark(scene, hud),
    talk = talker(hud),
    mask = balaclava(player);
  const vasek = makeCitizen({ uid: 'vasek', jacket: 0x525f4d, archetype: 'man' });
  vasek.group.visible = false;
  scene.add(vasek.group);
  let stage = 'wake',
    checkpoint = 'start',
    age = 0, // seconds in this stage
    far = 1,
    estate = null,
    home = null, // Vašek's doorstep, dressed as in part one
    farmSet = null,
    farmer = null,
    villaSet = null,
    merc = null,
    police = null,
    garageSet = null,
    film = null,
    forest = null,
    tried = false,
    wire = 0,
    coughed = false,
    seen = 0,
    called = false,
    fading = -1,
    lastFail = '',
    over = false;
  const here = () => player.pos;
  const onFoot = () => !player.inCar && !player.boarding && !player.exiting;
  function goal(p, label, gps = true) {
    mark.set(p ? { x: p.x, y: world.heightAt(p.x, p.z), z: p.z } : null, label);
    map.setWaypoint(p && gps ? p.x : null, p?.z);
  }
  function standVasek(p, facing) {
    vasek.group.visible = true;
    vasek.standPose();
    vasek.group.position.set(p.x, world.heightAt(p.x, p.z), p.z);
    vasek.group.rotation.y = facing;
  }
  function enter(next) {
    stage = next;
    age = 0;
    hud.action();
    if (next === 'wake') {
      storyClock.start(hours.leave);
      hud.veil(true, 'O několik hodin později', 'Dražkovická 119 · 02:30', true);
      // the estate at the kerb, wherever the evening left it
      estate = host.kombi() ?? host.addCar('octaviaCombi', kombi.x, kombi.z, kombi.h, 0x54695d);
      unlock(estate);
      estate.story = true;
      host.mend?.(estate); // whatever the last try did to it
      if (dist(estate, kombi) > 28 && host.driving() !== estate) {
        Object.assign(estate, { x: kombi.x, z: kombi.z, heading: kombi.h, speed: 0 });
        estate.y = world.surfaceY?.(kombi.x, kombi.z, world.heightAt(kombi.x, kombi.z))?.y ?? world.heightAt(kombi.x, kombi.z);
        estate._grounded = false;
      }
      home ??= vasekHouse(scene, world);
      standVasek({ x: start.x - 0.5, z: start.z + 1.7 }, Math.PI / 2 + 0.9);
      goal(null);
    } else if (next === 'tofarm') {
      far = Math.max(500, dist(here(), farm.yard));
      goal(farm.yard, 'Statek');
    } else if (next === 'farm') {
      goal(null);
      talk.run(farmTalk, { done: () => farmer?.board() });
    } else if (next === 'ride') {
      goal(null);
      farmer.go();
    } else if (next === 'drop') {
      storyClock.to(hours.drop);
      talk.run(dropTalk, { gap: 0.7 });
    } else if (next === 'walk') {
      farmer.leave();
      forest ??= storyRecording('forest-night', { loop: true, level: 0.5 });
      goal({ x: villa.x, z: villa.z }, 'Vila', false);
    } else if (next === 'theft') {
      checkpoint = 'villa';
      goal(null);
    } else if (next === 'run') {
      far = Math.max(800, dist(merc.car, city.centre));
      police = manhunt({ host, scene, world, traffic, talk, car: merc.car });
      goal(city.garage, 'Garáž');
    }
  }
  // The things of a place exist while he is near it.
  function near() {
    const p = here();
    if (!farmer && (stage === 'tofarm' || stage === 'wake') && dist(p, farm.yard) < 420 && world.terrain.ready(farm.yard.x, farm.yard.z)) {
      farmSet = dressFarm(scene, world);
      farmer = farmerVan(host, scene, world, player);
    }
    if (!merc && stage !== 'run' && stage !== 'end' && dist(p, villa) < 340 && world.terrain.ready(villa.x, villa.z)) {
      villaSet = dressVilla(scene, world);
      merc = villaCar(host, scene, world);
    }
    if (!garageSet && stage === 'run' && dist(p, city.garage) < 330 && world.terrain.ready(city.door.x, city.door.z)) {
      garageSet = dressGarage(scene, world);
      standVasek(city.vasek, Math.PI);
    }
  }
  function finale() {
    stage = 'end';
    age = 0;
    fading = 0;
    talk.stop();
    hud.phone();
    hud.guide('', '', '');
    hud.action();
    hud.veil(true);
    goal(null);
  }
  function theft(dt) {
    const p = here(),
      l = villaLocal(p.x, p.z),
      car = merc.car,
      driving = host.driving() === car;
    villaSet.blink(age);
    // a cold light under the lean-to, so the car can be seen at all
    const c = villaAt(villa.car.u + 1, villa.car.v - 2.2);
    lights.a.color.setHex(0xa9bfe0);
    lights.a.distance = 13;
    lights.a.decay = 1.5;
    lights.a.intensity = 2.6;
    lights.a.position.set(c.x, villaSet.ground + 2.6, c.z);
    // the camera sees the drive along the house: a face without a hood is a face
    const c0 = villa.cone;
    if (!mask.on && onFoot() && l.u > c0.u0 && l.u < c0.u1 && Math.abs(l.v) < c0.half) {
      if ((seen += dt) > 0.9) host.fail('camera');
    } else seen = 0;
    let label = '';
    if (driving && car.hotwire) {
      label = 'Drž E: spoj dráty';
      if (input.keys.has('KeyE')) {
        if (wire === 0) storyRecording('wires', { level: 1.1 });
        wire += dt / 3.4;
        if (wire > 0.42 && !coughed) {
          coughed = true;
          storyRecording('starter-fail', { level: 1.0 });
          talk.one(startLine, { level: 1.7 });
        }
        if (wire >= 1) {
          storyRecording('starter-catch', { level: 1.1 });
          merc.start();
          setTimeout(() => host.driving() === car && carStart(car.kind), 1700);
          enter('run');
          return;
        }
      }
    } else if (onFoot()) {
      if (!mask.on && Math.abs(l.u) < 5 && Math.abs(l.v) < 4) label = 'Nasadit kuklu';
      else if (merc.plateNear(p.x, p.z)) label = 'Urvat značku';
      else if (!merc.broken && tried && merc.atDoor(p.x, p.z)) label = 'Vyrazit okno';
    }
    hud.action(label);
    hud.guide('Vila u lesa', driving ? 'Nastartuj' : 'Auto stojí vzadu pod přístřeškem', '');
  }
  function run(dt) {
    const car = merc.car,
      driving = host.driving() === car,
      left = dist(car, city.garage),
      toCentre = dist(car, city.centre);
    merc.update(dt);
    // day breaks on the way in: seven on třída Míru, later at the lock-up
    storyClock.to(toCentre > city.callAt && !called ? lerp(hours.away, hours.centre, 1 - (toCentre - city.callAt) / (far - city.callAt)) : lerp(hours.garage, hours.centre, left / 900));
    if (driving) police.update(dt, merc.bare);
    if (!called && driving && toCentre < city.callAt) {
      called = true;
      hud.phone('Vašek', 'Probíhá hovor');
      talk.run(cityCall, { phone: true, done: () => hud.phone() });
    }
    const hot = wanted.stars() > 0;
    hud.guide(
      'Pardubice',
      hot ? 'Setřes policii' : left < 30 ? 'Zajeď před otevřenou garáž' : 'Odvez auto do garáže',
      called ? 'Na Staré poště · ' + km(left) + ' · 17. listopadu je zatarasená, jeď přes třídu Míru' : 'Na Staré poště · ' + km(left),
    );
    if (garageSet) {
      lights.b.color.setHex(0xffd9a0);
      lights.b.distance = 8;
      lights.b.decay = 1.6;
      lights.b.intensity = 5;
      lights.b.position.set(garageSet.bulb.x, garageSet.bulb.y, garageSet.bulb.z - 1.2);
    }
    if (driving && !hot && left < 4.6 && Math.abs(car.speed) < 0.9) return finale();
    if ((car.damage ?? 0) >= 1) host.fail('wreck');
    else if (!driving && onFoot() && dist(here(), car) > 240) host.fail('left');
  }
  function end(dt) {
    if (fading >= 0 && (fading += dt) > 1.0) {
      fading = -1;
      host.exitCar();
      wanted.clear();
      police?.dispose();
      police = null;
      storyClock.to(hours.garage);
      film = garageScene({
        scene, world, player, hud, lights, friend: vasek, car: merc.car,
        done() {
          // out on the street in the morning, the door shut behind him
          const g = city.garage;
          Object.assign(player.pos, { x: g.x + 2.6, z: g.z - 1.2 });
          player.y = world.heightAt(player.pos.x, player.pos.z);
          player.heading = Math.PI;
          player.mesh.position.set(player.pos.x, player.y, player.pos.z);
          player._stand();
          mask.set(false);
          vasek.group.visible = false;
          merc.dispose();
          merc = null;
          storyClock.release();
          hud.veil(false);
          over = true;
          complete();
        },
      });
    }
    film?.update(dt);
  }
  enter('wake');
  const api = {
    get finished() {
      return over;
    },
    get stage() {
      return stage;
    },
    // E. True when the story took the key.
    use() {
      if (film?.running) return film.use();
      if (stage === 'ride') return true; // nobody gets out of a moving van
      if (stage !== 'theft' || !merc) return false;
      const p = here(),
        l = villaLocal(p.x, p.z),
        car = merc.car;
      if (host.driving() === car && car.hotwire) return true; // the key is held for the wires
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
      if (!merc.broken && dist(p, car) < 3.8) {
        if (tried && merc.atDoor(p.x, p.z)) {
          merc.smash();
          return true;
        }
        tried = true; // the handle first: the game's own "Zamčeno"
      }
      return false;
    },
    // T after a failed mission (js/story-retry.js): the film, the ride in the
    // van or the talk that is running is over at once.
    skip() {
      if (!retry.on || over) return false;
      if (film?.running) return film.skip();
      if (stage === 'ride') {
        if (farmer.skipRide(hud)) talk.stop();
        return true;
      }
      if (!talk.busy) return false;
      talk.skip();
      return true;
    },
    update(dt) {
      if (over) return;
      age += dt;
      mask.update();
      near();
      const p = here();
      farmer?.update(dt, { inside: player.inCar === farmer.van, talking: talk.busy, facing: p });
      if (stage === 'wake') {
        if (age > 3.4 && age - dt <= 3.4) {
          hud.veil(false);
          talk.run(sendOff);
        }
        hud.guide('Dražkovická 119', 'Sedni za volant Vaškova kombíku', '');
        if (host.driving() === estate) enter('tofarm');
      } else if (stage === 'tofarm') {
        const left = dist(p, farm.yard);
        storyClock.to(lerp(hours.leave, hours.farm, 1 - left / far));
        hud.guide('Brozany', 'Dojeď na statek za Jardou', km(left));
        if (vasek.group.visible && dist(p, start) > 70) vasek.group.visible = false;
        if (home && dist(p, start) > 320) {
          home.dispose();
          home = null;
        }
        if (farmer && dist(p, farmer.stand) < 24 && Math.abs(host.driving()?.speed ?? 0) < 4) enter('farm');
      } else if (stage === 'farm') {
        lights.a.color.setHex(0xffe2a8);
        lights.a.distance = 16;
        lights.a.decay = 1.5;
        lights.a.intensity = 6;
        lights.a.position.set(farmSet.lamp.x, farmSet.lamp.y, farmSet.lamp.z);
        const seated = farmer.stage === 'seated';
        hud.guide('Brozany • statek', seated ? 'Nasedni k Jardovi do dodávky' : 'Vystup za Jardou', seated ? 'E u dveří spolujezdce' : '');
        if (seated) goal(farmer.van, 'Dodávka', false);
        if (player.inCar === farmer.van && !player.boarding) enter('ride');
      } else if (stage === 'ride') {
        if (!farmer.hopped && age > 3.5 && age - dt <= 3.5) talk.run(rideTalk, { gap: 1.5 });
        storyClock.to(lerp(hours.farm, hours.drop, age / 130));
        hud.guide('', '', '');
        if (farmer.stage === 'stopped') enter('drop');
      } else if (stage === 'drop') {
        hud.guide('Ráby', 'Vystup', 'E');
        if (onFoot() && dist(p, farmer.van) > 2.2) enter('walk');
      } else if (stage === 'walk') {
        if (age > 4 && age - dt <= 4) {
          storyRecording('phone-ring', { level: 0.5 });
          hud.phone('Vašek', 'Probíhá hovor');
          talk.run(villaCall, { phone: true, done: () => hud.phone() });
        }
        const left = dist(p, villa);
        storyClock.to(lerp(hours.drop, hours.villa, 1 - left / 160));
        hud.guide('Ráby • les', 'Dojdi k vile', km(left));
        if (villaSet && left < 9) enter('theft');
      } else if (stage === 'theft') theft(dt);
      else if (stage === 'run') run(dt);
      else if (stage === 'end') end(dt);
      const riding = stage === 'ride' && !farmer.hopped && farmer.stage === 'ride';
      hud.offer(retry.on && (film?.running || riding || talk.busy) ? (film?.running ? 'Přeskočit film' : riding ? 'Přeskočit jízdu' : 'Přeskočit rozhovor') : '');
      forest?.set(stage === 'walk' || stage === 'theft' ? 0.5 : 0);
      if (stage !== 'farm' && stage !== 'theft' && stage !== 'end') lights.a.intensity = 0;
      // the forest at four in the morning is black: on foot he lights his way
      // with the phone (the story's second lamp, a step ahead of him)
      if ((stage === 'drop' || stage === 'walk' || stage === 'theft') && onFoot()) {
        lights.b.color.setHex(0xdfe8ff);
        lights.b.distance = 13;
        lights.b.decay = 1.3;
        lights.b.intensity = 3.2;
        lights.b.position.set(p.x - Math.sin(player.heading) * 1.1, player.y + 1.25, p.z - Math.cos(player.heading) * 1.1);
      } else if (stage !== 'run' && stage !== 'end') lights.b.intensity = 0;
    },
    frameCamera(camera, dt) {
      if (film?.running) return film.camera(camera, dt);
      mark.frame(camera, dt, player.pos.x, player.pos.z);
      return false;
    },
    posePlayer(dt) {
      return film?.running ? film.pose(dt) : false;
    },
    // --- failing: main.js shows the card, asks where to stand him, then resumes
    get lastFail() {
      return lastFail;
    },
    // for the harness (window.__atc.heist.rehearse('end')): the last scene
    // without the night that leads to it
    rehearse(what) {
      if (film) return;
      if (what === 'villa') {
        villaSet ??= dressVilla(scene, world);
        checkpoint = 'villa';
        const at = api.rewind();
        Object.assign(player.pos, { x: at.x, z: at.z });
        hud.veil(false);
      } else if (what === 'end') {
        merc ??= villaCar(host, scene, world);
        finale();
      }
    },
    failText(why) {
      lastFail = why;
      const head = { camera: 'Natočila tě kamera', plate: 'Dostali tě', busted: 'Zatkli tě', death: 'Zemřel jsi', wreck: 'Auto je na odpis', left: 'Auto zůstalo stát' }[why] ?? 'Konec';
      const reason = why === 'camera' ? 'Bez kukly tě poznají. ' : why === 'plate' || (why === 'busted' && police?.known) ? 'Poznali auto podle značky. ' : '';
      return [head, reason + (checkpoint === 'villa' ? 'Zpátky k vile' : 'Zpátky na Dražkovickou')];
    },
    rewind() {
      talk.stop();
      hud.phone();
      hud.action();
      film?.dispose();
      film = null;
      police?.dispose();
      police = null;
      merc?.dispose();
      merc = null;
      garageSet?.dispose();
      garageSet = null;
      mask.set(false);
      tried = coughed = called = false;
      wire = seen = 0;
      fading = -1;
      if (checkpoint === 'villa') {
        merc = villaCar(host, scene, world);
        storyClock.start(hours.villa);
        stage = 'theft';
        age = 0;
        goal(null);
        const at = villaAt(-5, 0);
        return { x: at.x, z: at.z, h: villaIn };
      }
      farmer?.dispose();
      farmer = null;
      farmSet?.dispose();
      farmSet = null;
      villaSet?.dispose();
      villaSet = null;
      forest?.stop();
      forest = null;
      enter('wake');
      return start;
    },
    close() {
      talk.stop();
      forest?.stop();
      film?.dispose();
      police?.dispose();
      merc?.dispose();
      farmer?.dispose();
      farmSet?.dispose();
      villaSet?.dispose();
      garageSet?.dispose();
      home?.dispose();
      mask.dispose();
      vasek.dispose();
      mark.dispose();
      map.setWaypoint(null);
      lights.dispose();
      hud.close();
    },
  };
  hud.button.onclick = () => api.use();
  hud.skip.onclick = () => api.skip();
  return api;
}
