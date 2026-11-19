import { chunkKey } from './geo.js';
import { storyRecording } from './audio.js';
import { trainBody, doorX, carriageAt } from './prologue-coach.js';
import { trainDeck, inside } from './prologue-deck.js';
import { storyHud } from './prologue-hud.js';
import { stationEntry, stationExit, DEPARTS_IN, wayOut } from './prologue-route.js';
import { routeFor, localAt, worldAt } from './story-rail.js';
import { departureBoard } from './prologue-board.js';
import { railbed } from './prologue-railbed.js';
import { storyLights } from './prologue-lights.js';
import { opening } from './prologue-opening.js';
import { waymark } from './prologue-marker.js';
import { seating } from './prologue-seat.js';
import { dressPlatform } from './prologue-platform.js';
import { streetLife } from './prologue-life.js';
import { roofWalk } from './prologue-ladder.js';
import { trackGuard } from './prologue-tracks.js';
import { storyClock } from './prologue-clock.js';
import { trainVoice } from './prologue-voice.js';
import { announcements } from './prologue-dialogue.js';

// A skipped ride is not a cut to a standing train: the last half minute is
// ridden, braking into the station. 25.5 m/s at the train's own 0.85 m/s².
const ROLL_SPEED = 25.5,
  ROLL_IN = (ROLL_SPEED * ROLL_SPEED) / (2 * 0.85);
const clock = (seconds) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
// `night()` is the sky's 0..1 darkness; `fail(why)` ends the campaign ('train').
export function createPrologue({ chapter, scene, world, player, map, trip, trains, save, input, night = () => 0, fail = () => {}, crowd = () => 0 }) {
  const hud = storyHud(),
    train = trainBody(scene),
    board = departureBoard(scene, world, trip),
    lights = storyLights(scene),
    mark = waymark(scene, hud),
    seat = seating(player),
    life = streetLife(scene, world),
    roofCtl = roofWalk(world, player, input),
    guard = trackGuard(world),
    sound = trainVoice(hud),
    railHeight = railbed(world);
  const { lineLength, railPose, nearestMetres } = routeFor(trip.platform);
  let phase = chapter,
    speed = 0,
    closed = chapter === 'coach' ? 1 : 0;
  let metres =
    chapter === 'arrival'
      ? lineLength
      : chapter === 'coach'
        ? Math.min(lineLength, trip.metres ?? nearestMetres(player.pos.x, player.pos.z))
        : 0;
  let pose = railPose(metres),
    base = 0,
    aboard = false,
    driving = false;
  let skipped = null,
    missed = 0, // seconds since the train left without him
    readBoard = false,
    guideTarget = null,
    hudWait = 0,
    platformSet = null,
    announced = false,
    rolled = false, // the ride was skipped once: no second skip on the way in
    nextJunction = 240,
    exitStep = 0;
  const frame = world.stationPassages.stations;
  const kolin = frame[0],
    pardubice = frame[1];
  let inbound = null; // the way out of Pardubice, chosen where he steps off (prologue-route.js)
  function nextTurn(station, points, index) {
    while (index < points.length && distance(worldAt(station, ...points[index])) < 2.1) index++;
    return index;
  }
  const point = () => localAt(pose, player.pos.x, player.pos.z);
  const distance = (p) => Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
  // The map's waypoint, the column of light and the pin all follow one target.
  function guideTo(target, label = '') {
    if (guideTarget?.x === target?.x && guideTarget?.z === target?.z) return;
    guideTarget = target;
    map.setWaypoint(target ? target.x : null, target?.z);
    mark.set(target && label ? { x: target.x, y: target.y ?? world.heightAt(target.x, target.z), z: target.z } : null, label);
  }
  function place() {
    pose = railPose(metres);
    base = railHeight(pose.x, pose.z) + 0.6;
    train.group.position.set(pose.x, base, pose.z);
    train.group.rotation.y = -Math.atan2(pose.s, pose.c);
    train.doors(closed);
    if (phase === 'coach') trip.metres = metres;
  }
  function change(next) {
    phase = next;
    hud.say();
    hud.action();
    hud.phone();
    hudWait = 0;
    if (next === 'station') {
      trip.remaining = DEPARTS_IN;
      // Pardubice starts downloading while he runs for the train, so skipping
      // the ride does not wait on forty kilometres of map over a slow line.
      const end = railPose(lineLength);
      world.city.ensureTiles(end.x, end.z).catch(() => {});
      world.terrain.ensure(end.x, end.z);
    }
    if (next === 'arrival') guideTo(stationExit);
    save(next);
  }
  place();
  // The film runs first; when Vašek has hung up the clock starts.
  const film =
    phase === 'bridge'
      ? opening({
          scene,
          world,
          player,
          hud,
          lights,
          birds: life,
          crowd,
          // Vašek has hung up: the roof is the player's, and the clock runs
          done: () => {
            roofCtl.begin();
            change('station');
          },
        })
      : null;
  life.populate(film?.street);
  if (phase === 'coach') {
    const { u, v } = point();
    if (!inside(u, v)) {
      metres = 0;
      closed = 0;
      place();
      change('station');
    } else {
      aboard = true;
      player.y = base + 0.165;
    }
  }
  const coachDeck = trainDeck({
    get pose() {
      return pose;
    },
    get base() {
      return base;
    },
    get closed() {
      return closed;
    },
    get aboard() {
      return aboard;
    },
    get travelling() {
      return phase === 'coach';
    },
  });
  // One deck for the world's support and collision: the roof while he is on
  // it, the train otherwise.
  const deck = {
    carrying: (x, z) => roofCtl.carrying(x, z) || coachDeck.carrying(x, z),
    support: (x, z, limit) => (roofCtl.carrying(x, z) ? roofCtl.support() : coachDeck.support(x, z, limit)),
    collide: (pos, r, opts) => roofCtl.collide(pos, r) || coachDeck.collide(pos, r, opts),
  };
  world.storyCoach = deck;
  // where a walker in the yard may be off the platforms: in the train, at its door
  const atTrain = (x, z) => {
    const l = localAt(pose, x, z),
      dx = l.u - carriageAt(l.u);
    return inside(l.u, l.v) || (Math.abs(dx - doorX) < 0.95 && l.v < 0.3 && l.v > -3.4);
  };
  const passSound = () =>
    storyRecording(aboard ? 'coach-pass' : 'platform-pass', { level: aboard ? 0.38 : 0.65 });
  if (trains) trains.storyPass = passSound;
  function beginRun() {
    trip.remaining = 0;
    if (aboard) change('coach');
    else {
      // The doors close in front of him. He watches it go, and it is over.
      missed = 0.001;
      guideTo(null);
      hud.guide('Kolín', 'Poslední vlak odjel', 'Bez Vaška zálohu nezaplatíš.');
      hud.action();
    }
    if (distance(pose) < 90) storyRecording('door', { level: aboard ? 0.54 : 0.72 });
  }
  function nearSeat() {
    if (!aboard || seat.taken) return null;
    const { u } = point(),
      offset = carriageAt(u),
      x = u - offset;
    if (x < -9.7 || x > 11.7) return null;
    const bay = Math.max(0, Math.min(7, Math.round((x + 8.2) / 2.62)));
    return { u: offset - 8.2 + bay * 2.62 + 0.84, v: 0.61 };
  }
  const coachFrame = () => ({
    worldAt: (u, v) => worldAt(pose, u, v),
    floor: base + 0.165,
    facing: train.group.rotation.y + Math.PI / 2,
  });
  function use() {
    if (driving) return false;
    if (skipped || missed) return true;
    if (film?.running) return film.use();
    if (roofCtl.state === 'ladder') return true;
    if (roofCtl.state === 'roof' && roofCtl.mount()) return true;
    if (seat.taken) {
      if (seat.settled) seat.rise();
      hudWait = 0;
      return true;
    }
    if (phase === 'station' && !aboard && distance(stationEntry) < 7) {
      readBoard = true;
      hudWait = 0;
      return true;
    }
    if (phase === 'station' || phase === 'coach') {
      const target = nearSeat();
      if (target) {
        const { u, v } = point();
        seat.sit(target, u, v, player.heading);
        hudWait = 0;
        return true;
      }
    }
    return aboard && phase === 'coach';
  }
  function skip() {
    if (!seat.settled || skipped || rolled || (phase !== 'station' && phase !== 'coach')) return;
    if (phase === 'station') beginRun();
    const destination = railPose(lineLength);
    world.city.ensureTiles(destination.x, destination.z).catch(() => {});
    world.terrain.ensure(destination.x, destination.z);
    skipped = { elapsed: 0, moved: false, from: metres };
    hud.travel(true);
    hud.seated(false);
    hud.countdown();
    hud.action();
    storyRecording('skip-rail', { level: 0.76 });
  }
  hud.button.onclick = use;
  hud.skip.onclick = skip;
  function arrive() {
    speed = 0;
    change('arrival');
    storyClock.to(20.5);
    storyRecording('open', { level: 0.9 });
    sound.announce(announcements.at(-1), 0.85);
  }
  // The two lamps after the film: one under the canopy beside him, one in the coach.
  function lamps() {
    const dark = night(),
      { a, b } = lights;
    const close = distance(pose) < 150 && phase !== 'arrival';
    if (platformSet && close && phase === 'station') {
      const p = platformSet.lampAt(player.pos.x, player.pos.z);
      b.color.setHex(0xffe2b8);
      b.distance = 15;
      b.decay = 1.5;
      b.intensity = 4 + 14 * dark;
      b.position.set(p.x, p.y, p.z);
    } else b.intensity = 0;
    if (aboard || distance(pose) < 60) {
      const u = aboard ? point().u : carriageAt(point().u) + doorX - 2,
        p = worldAt(pose, u, 0);
      a.color.setHex(0xfff0d4);
      a.distance = 9;
      a.decay = 1.5;
      a.intensity = 2 + 3.2 * dark;
      a.position.set(p.x, base + 2.4, p.z);
    } else a.intensity = 0;
  }
  function refreshHud() {
    const remaining = Math.ceil(trip.remaining);
    const status = missed || phase === 'coach' || phase === 'arrival' ? 'Vlak odjel' : 'Odjezd za ' + clock(remaining);
    if (distance(stationEntry) < 220) board.update(status);
    platformSet?.update(0, night(), status, player.pos.x, player.pos.z);
    hud.countdown(phase === 'station' && !missed && !skipped ? clock(remaining) : '', remaining < 45);
    hud.seated(seat.settled && !skipped && !rolled && phase !== 'arrival');
    if (phase === 'bridge' || missed) return;
    if (phase === 'station' && !aboard) {
      if (roofCtl.state !== 'off') {
        const rungs = roofCtl.state === 'ladder';
        guideTo(rungs ? null : roofCtl.ladderTop(), 'Žebřík');
        hud.guide(
          'Kolín • poslední vlak',
          rungs ? 'Slez po žebříku' : 'Dolů vede jen žebřík',
          rungs ? 'Drž S, dokud nejsi na zemi (W zpátky nahoru)' : 'Je na rohu střechy',
        );
        hud.action(!rungs && roofCtl.near() ? 'Slézt po žebříku' : '');
        return;
      }
      // The pin leads to the departure board and no further (Frank, 18 Nov
      // 2026): which platform, and how to get to it, he reads there himself.
      if (distance(stationEntry) < 5) readBoard = true;
      if (!readBoard) {
        guideTo(stationEntry, 'Nádraží');
        hud.guide('Kolín • poslední vlak', 'Utíkej na nádraží', 'Shift: běh. Dvakrát Shift a držet: sprint, dokud stačí dech.');
        hud.action(distance(stationEntry) < 7 ? 'Přečíst odjezdy' : '');
      } else {
        guideTo(null);
        hud.guide('Kolín • poslední vlak', 'Najdi svůj vlak', 'Nástupiště a kolej jsou na odjezdové tabuli.');
        hud.action();
      }
      return;
    }
    if (phase === 'station' || phase === 'coach') {
      if (guideTarget) guideTo(null);
      hud.guide(
        'Poslední vlak',
        seat.taken ? 'Pardubice hlavní nádraží' : 'Najdi si místo v oddílu',
        phase === 'coach'
          ? ((lineLength - metres) / 1000).toFixed(1).replace('.', ',') + ' km'
          : seat.taken
            ? 'Vlak odjede za ' + clock(remaining)
            : 'Pardubice hlavní nádraží',
      );
      hud.action(seat.settled ? 'Vstát' : nearSeat() ? 'Sednout si' : '');
      return;
    }
    if (phase === 'arrival') {
      if (!aboard) {
        inbound ??= wayOut(localAt(pardubice, player.pos.x, player.pos.z).u);
        exitStep = nextTurn(pardubice, inbound, exitStep);
        guideTo(exitStep < inbound.length ? worldAt(pardubice, ...inbound[exitStep]) : stationExit);
      }
      hud.guide(
        'Pardubice hlavní nádraží',
        seat.taken ? 'Vstaň a vystup z vlaku' : aboard ? 'Vystup na nástupiště' : 'Projdi halou na parkoviště za Vaškem',
      );
      hud.action(seat.settled ? 'Vstát' : '');
    }
  }
  return {
    get aboard() {
      return aboard;
    },
    get finished() {
      return phase === 'forecourt';
    },
    use,
    skip,
    get seated() {
      return false;
    },
    // for the test harness: the opening film, while it runs
    get film() {
      return film;
    },
    // The film owns the camera; afterwards it is the game's own again, seated or not.
    frameCamera(camera, dt) {
      if (film?.running && !driving) return film.camera(camera, dt);
      // one frame handed to main.js as "filmed" swings its boom behind him,
      // out over the street, as he turns to the wall and takes the ladder
      if (roofCtl.turned) {
        roofCtl.turned = false;
        return true;
      }
      mark.frame(camera, dt, player.pos.x, player.pos.z);
      return false;
    },
    posePlayer(dt) {
      if (driving) return false;
      if (film?.running) return film.pose(dt);
      if (roofCtl.pose(dt)) return true;
      return seat.pose(dt, coachFrame());
    },
    update(dt, otherRide, car) {
      driving = otherRide || !!(player.inCar || player.boarding || player.exiting || player.ragdoll);
      const { u, v } = point(),
        oldBase = base;
      aboard =
        !driving &&
        (seat.taken || (inside(u, v) && ((phase === 'coach' && aboard) || Math.abs(player.y - base) < 1.54)));
      life.update(dt, player.pos.x, player.pos.z, player.y);
      // (the film object stays after its last frame: the roof it dressed is
      // still under his feet, and goes with the rest in dispose)
      if (film?.running) film.update(dt);
      if (!film?.running) {
        lamps();
        // the story's clock: five past eight on the roof, ten past as the train
        // leaves, half past as it draws into Pardubice
        if (phase === 'station') storyClock.to(20 + (5 + 5 * (1 - trip.remaining / DEPARTS_IN)) / 60);
        else if (phase === 'coach') storyClock.to(20 + (10 + 20 * (metres / lineLength)) / 60);
        else storyClock.flow(dt, 20.7);
        if (!driving && roofCtl.state === 'off' && !seat.taken) guard(player, atTrain);
      }
      if (!platformSet && kolin.group && distance(kolin) < 420) platformSet = dressPlatform(scene, world, kolin, trip.platform);
      platformSet?.update(dt, night(), undefined, player.pos.x, player.pos.z);
      if (phase === 'station' && !missed) {
        // the station says where the train is, the way stations do
        if (!announced && roofCtl.state === 'off' && !aboard && distance(stationEntry) < 120) {
          announced = true;
          sound.announce(announcements.find((a) => a[0] === 'pa-kolin-' + trip.platform), 1);
        }
        trip.remaining = Math.max(0, trip.remaining - dt);
        if (trip.remaining === 0) beginRun();
      }
      // a moment to watch the tail lights, then the campaign starts again
      if (missed && (missed += dt) > 4.2 && missed < 90) {
        missed = 99;
        fail('train');
      }
      // its sound: idle at the platform, the ride inside, the montage of a skip
      sound.update(aboard, distance(pose), skipped ? 31 : speed);
      if (skipped) {
        skipped.elapsed += dt;
        if (skipped.elapsed > 0.55 && !skipped.moved) {
          metres = Math.max(skipped.from, lineLength - ROLL_IN);
          closed = 1;
          place();
          skipped.moved = true;
        }
        if (
          skipped.moved &&
          skipped.elapsed >= 4.35 &&
          world.terrain.ready(pose.x, pose.z) &&
          world.built.has(chunkKey(pose.x, pose.z))
        ) {
          // the picture comes back with the train still running in
          skipped = null;
          rolled = true;
          hud.travel(false);
          speed = Math.min(ROLL_SPEED, Math.sqrt(Math.max(0, 2 * 0.85 * (lineLength - metres))));
        } else if (skipped.elapsed > 70) {
          metres = skipped.from;
          skipped = null;
          place();
          hud.travel(false);
          hud.say('Poslední vlak', 'Nádraží se zatím nepodařilo načíst. Vlak pokračuje po trati.');
        }
        return;
      }
      if (phase === 'coach' || missed) {
        closed = Math.min(1, closed + dt * 0.65);
        if (closed === 1) {
          sound.depart(aboard, distance(pose));
          if (phase === 'coach') sound.brake(lineLength - metres, speed);
          speed = Math.min(speed + dt * 0.95, 44.4, Math.sqrt(Math.max(0, 2 * 0.85 * (lineLength - metres))));
          metres = Math.min(lineLength, metres + dt * speed);
        }
      } else closed = Math.max(0, closed - dt * 0.69);
      place();
      if (aboard) {
        Object.assign(player.pos, worldAt(pose, u, v));
        player.y += base - oldBase;
        if (phase === 'coach' && speed > 4 && metres > nextJunction) {
          storyRecording('junction', { level: 0.21 + Math.random() * 0.13 });
          nextJunction = metres + 650 + Math.random() * 1250;
        }
      }
      if ((aboard || distance(pose) < 85) && train.aisle(dt, aboard ? u : null))
        storyRecording('passenger', { level: 0.24 });
      if (phase === 'coach' && metres >= lineLength) arrive();
      if (!aboard && car && (distance(car) < 11 || distance(stationExit) < 7)) {
        change('forecourt');
        return;
      }
      if ((hudWait -= dt) <= 0) {
        hudWait = 0.18;
        refreshHud();
      }
    },
    dispose() {
      sound.stop();
      film?.dispose();
      if (trains?.storyPass === passSound) trains.storyPass = null;
      if (world.storyCoach === deck) world.storyCoach = null;
      map.setWaypoint(null);
      mark.dispose();
      life.dispose();
      platformSet?.dispose();
      board.dispose();
      train.close();
      lights.dispose();
      hud.close();
    },
  };
}
