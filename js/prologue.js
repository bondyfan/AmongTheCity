import { chunkKey, distPointToSegment } from './geo.js';
import { railHeadOn, railHeadAt } from './trains.js';
import { storyRecording } from './audio.js';
import { trainBody, doorX, carriageAt } from './prologue-coach.js';
import { trainDeck, inside } from './prologue-deck.js';
import { storyHud } from './prologue-hud.js';
import { calls } from './prologue-dialogue.js';
import { stationEntry, stationExit, trackNumber, roof } from './prologue-route.js';
import { routeFor, localAt, worldAt } from './story-rail.js';
import { rooftop } from './prologue-roof.js';
import { departureBoard } from './prologue-board.js';

const clock = (seconds) => Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
export function createPrologue({ chapter, scene, world, player, map, trip, trains, save }) {
  const hud = storyHud(),
    train = trainBody(scene),
    board = departureBoard(scene, world, trip);
  const { lineLength, railPose, nearestMetres } = routeFor(trip.platform);
  const roofSet = rooftop(scene, world, player);
  let phase = chapter,
    speed = 0,
    closed = chapter === 'coach' ? 1 : 0,
    line = -1;
  let metres =
    chapter === 'arrival'
      ? lineLength
      : chapter === 'coach'
        ? Math.min(lineLength, trip.metres ?? nearestMetres(player.pos.x, player.pos.z))
        : 0;
  let pose = railPose(metres),
    base = 0,
    aboard = false,
    driving = false,
    seat = null;
  let skipped = null,
    missed = false,
    readBoard = false,
    guideTarget = null,
    hudWait = 0;
  let voice = null,
    music = null,
    ring = null,
    friendRinging = false,
    silence = 0,
    speechTime = 0,
    nextJunction = 240,
    lookYaw = 0.98,
    lookPitch = 0;
  let live = true,
    step = 0,
    exitStep = 0;
  const frame = world.stationPassages.stations;
  const kolin = frame[0],
    pardubice = frame[1],
    vPlatform = { 2: 0, 4: -41, 5: -57 }[trip.platform];
  const outbound = [
    [24, 35],
    [17, 35],
    [0, 35],
    [0, vPlatform],
    [17, vPlatform],
  ];
  const inbound = [
    [18, 0],
    [0, 0],
    [0, -39],
    [18, -39],
    [18, -46],
    [7, -46],
  ];
  function nextTurn(station, points, index) {
    while (index < points.length && distance(worldAt(station, ...points[index])) < 2.1) index++;
    return index;
  }
  const point = () => localAt(pose, player.pos.x, player.pos.z);
  const distance = (p) => Math.hypot(p.x - player.pos.x, p.z - player.pos.z);
  function guideTo(target) {
    if (guideTarget?.x === target.x && guideTarget?.z === target.z) return;
    guideTarget = target;
    map.setWaypoint(target.x, target.z);
  }
  let lastSegment = null;
  function railHeight(x, z) {
    const rails = world.city.chunkIndex.get(chunkKey(x, z))?.rails;
    // Keep the rail bed under the wheels even when a road passes overhead.
    // A curve can cross several mapped ways without leaving the same cell.
    const near = {};
    if (lastSegment && rails === lastSegment.rails) {
      const { a, b, way, start } = lastSegment;
      if (distPointToSegment(x, z, ...a, ...b, near) < 0.04)
        return railHeadOn(way, start + Math.hypot(near.x - a[0], near.z - a[1]), x, z);
    }
    for (const way of rails ?? []) {
      if (way.t !== 'rail') continue;
      let start = 0;
      for (let i = 1; i < way.p.length; i++) {
        const a = way.p[i - 1],
          b = way.p[i];
        if (distPointToSegment(x, z, ...a, ...b, near) < 0.04) {
          lastSegment = { rails, way, a, b, start };
          return railHeadOn(way, start + Math.hypot(near.x - a[0], near.z - a[1]), x, z);
        }
        start += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    }
    return railHeadAt(x, z);
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
    if (next === 'station') guideTo(stationEntry);
    if (next === 'arrival') guideTo(stationExit);
    save(next);
  }
  function nextLine() {
    voice?.stop();
    ring?.stop();
    silence = 0;
    speechTime = 0;
    if (line === 4 && !friendRinging) {
      friendRinging = true;
      hud.say();
      hud.phone('Vašek');
      hud.action('Přijmout hovor');
      ring = storyRecording('phone-ring', { level: 0.49 });
      silence = 2.4;
      return;
    }
    if (++line >= calls.length) {
      roofSet.release();
      hud.cinema(false);
      music?.stop(2.3);
      change('station');
      return;
    }
    const [id, who, words, role] = calls[line];
    hud.say(who, words);
    hud.phone(
      line < 4 ? 'Nemocnice' : line === 4 ? 'Máma' : 'Vašek',
      line === 4 ? 'Nová zpráva' : 'Probíhá hovor',
    );
    hud.action('Další replika');
    if (id === 'message') {
      silence = 4.4;
      return;
    }
    const expected = line;
    voice = storyRecording(id, {
      phone: role !== 'father',
      meter: role === 'father',
      level: role === 'father' ? 0.95 : 1.08,
      end: () => {
        if (live && phase === 'bridge' && line === expected) silence = 0.52;
      },
    });
    speechTime = Math.max(14, words.length * 0.16);
  }
  place();
  if (phase === 'bridge') {
    if (distance(roof) < 9) roofSet.putOnRoof();
    hud.cinema(true);
    music = storyRecording('roof-music', { level: 0.23, loop: true });
    ring = storyRecording('phone-ring', { level: 0.49, loop: true });
    hud.phone('Nemocnice');
    hud.action('Přijmout hovor');
  }
  if (phase !== 'bridge' && Number.isFinite(trip.seatU)) {
    const savedSeat = { u: trip.seatU, v: 0.61 };
    if (distance(worldAt(pose, savedSeat.u, savedSeat.v)) < 2) seat = savedSeat;
  }
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
  const deck = trainDeck({
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
  world.storyCoach = deck;
  const passSound = () =>
    storyRecording(aboard ? 'coach-pass' : 'platform-pass', { level: aboard ? 0.38 : 0.65 });
  if (trains) trains.storyPass = passSound;
  function beginRun() {
    trip.remaining = 0;
    missed = !aboard;
    if (!missed) change('coach');
    if (distance(pose) < 90) storyRecording('door', { level: aboard ? 0.54 : 0.72 });
  }
  function nearSeat() {
    if (!aboard) return null;
    const { u } = point(),
      offset = carriageAt(u),
      x = u - offset;
    if (x < -9.7 || x > 11.7) return null;
    const bay = Math.max(0, Math.min(7, Math.round((x + 8.2) / 2.62)));
    return { u: offset - 8.2 + bay * 2.62 + 0.84, v: 0.61 };
  }
  function use() {
    if (driving) return false;
    if (skipped) return true;
    if (phase === 'bridge') {
      nextLine();
      return true;
    }
    if (phase === 'station' && roofSet.startClimb()) return true;
    if (roofSet.climbing) return true;
    if (seat) {
      Object.assign(player.pos, worldAt(pose, seat.u, 0));
      player.y = base + 0.165;
      seat = null;
      delete trip.seatU;
      player._stand();
      hud.seated(false);
      hudWait = 0;
      return true;
    }
    if (phase === 'station' && missed) {
      if (distance(stationEntry) > 7) return false;
      missed = false;
      metres = 0;
      speed = 0;
      closed = 0;
      trip.remaining = 120;
      place();
      change('station');
      return true;
    }
    if (phase === 'station' && !aboard && distance(stationEntry) < 7) {
      readBoard = true;
      hudWait = 0;
      return true;
    }
    if (phase === 'station' || phase === 'coach') {
      seat = nearSeat();
      if (seat) {
        trip.seatU = seat.u;
        lookYaw = 0.98;
        lookPitch = 0;
        hudWait = 0;
        hud.seated(true);
        return true;
      }
    }
    return aboard && phase === 'coach';
  }
  function skip() {
    if (!seat || skipped || (phase !== 'station' && phase !== 'coach')) return;
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
    missed = false;
    change('arrival');
    storyRecording('open', { level: 0.55 });
  }
  function moveSeat() {
    Object.assign(player.pos, worldAt(pose, seat.u, seat.v));
    player.y = base + 0.165;
    player.vy = 0;
    player.speed = 0;
    player.grounded = true;
    player.heading = train.group.rotation.y + Math.PI / 2;
    player.mesh.position.set(player.pos.x, base - 0.26, player.pos.z);
    player.mesh.rotation.y = player.heading;
    player._sit(1, 0);
  }
  function refreshHud() {
    const remaining = Math.ceil(trip.remaining),
      n = trip.platform;
    const platform = 'Nástupiště ' + n + ' · kolej ' + trackNumber[n];
    const boardStatus =
      missed || phase === 'coach' || phase === 'arrival' ? 'Vlak odjel' : 'Odjezd za ' + clock(remaining);
    if (distance(stationEntry) < 220) board.update(boardStatus);
    hud.countdown(phase === 'station' && !missed && !skipped ? clock(remaining) : '', remaining < 45);
    hud.seated(!!seat && !skipped && phase !== 'arrival');
    if (phase === 'bridge') return;
    if (phase === 'station') {
      if (missed) {
        guideTo(stationEntry);
        hud.guide(
          'Kolín',
          'Poslední vlak odjel',
          'Odjezd můžeš zopakovat u tabule nebo dojet k Vaškovi autem.',
        );
        hud.action(distance(stationEntry) <= 7 ? 'Zkusit odjezd znovu' : '');
        return;
      }
      if (roofSet.near() || roofSet.climbing) {
        hud.guide('Kolín', 'Slez po žebříku na ulici', 'Nádraží je za rohem');
        hud.action(roofSet.climbing ? '' : 'Slézt po žebříku');
        return;
      }
      if (!aboard) {
        if (distance(stationEntry) < 5) readBoard = true;
        const door = worldAt(pose, doorX, -2.5);
        const toTrain = readBoard || distance(door) < 30;
        if (toTrain) {
          step = nextTurn(kolin, outbound, step);
          guideTo(step < outbound.length && distance(door) > 17 ? worldAt(kolin, ...outbound[step]) : door);
        } else guideTo(stationEntry);
        hud.guide(
          'Kolín • poslední vlak',
          toTrain ? platform : 'Najdi odjezdovou tabuli',
          toTrain
            ? step < outbound.length && distance(door) > 17
              ? 'Projdi halou a podchodem k nástupišti'
              : 'Pardubice hl. n. · nastup otevřenými dveřmi'
            : 'Nádraží Kolín · ' + Math.round(distance(stationEntry)) + ' m',
        );
        hud.action(!readBoard && distance(stationEntry) < 7 ? 'Přečíst odjezdy' : '');
        return;
      }
    }
    if (phase === 'station' || phase === 'coach') {
      if (aboard && guideTarget) {
        guideTarget = null;
        map.setWaypoint(null);
      }
      hud.guide(
        'Poslední vlak',
        seat ? 'Pardubice hlavní nádraží' : aboard ? 'Najdi si místo v oddílu' : platform,
        phase === 'coach'
          ? ((lineLength - metres) / 1000).toFixed(1).replace('.', ',') + ' km'
          : seat
            ? 'Rozhlédni se myší'
            : 'Pardubice hlavní nádraží',
      );
      hud.action(seat ? 'Vstát' : nearSeat() ? 'Sednout si' : '');
      return;
    }
    if (phase === 'arrival') {
      if (!aboard) {
        exitStep = nextTurn(pardubice, inbound, exitStep);
        guideTo(exitStep < inbound.length ? worldAt(pardubice, ...inbound[exitStep]) : stationExit);
      }
      hud.guide(
        'Pardubice hlavní nádraží',
        seat
          ? 'Vstaň a vystup z vlaku'
          : aboard
            ? 'Vystup na nástupiště'
            : 'Projdi halou na parkoviště za Vaškem',
      );
      hud.action(seat ? 'Vstát' : '');
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
      return !!seat;
    },
    frameCamera(camera, dt, drag) {
      if (seat && !driving) {
        lookYaw = Math.max(-1.7, Math.min(1.7, lookYaw - drag.x * 0.003));
        lookPitch = Math.max(-0.73, Math.min(0.71, lookPitch - drag.y * 0.003));
        const heading = player.heading + lookYaw,
          c = Math.cos(lookPitch);
        const eye = player._cit.eye,
          head = player._cit.parts.head;
        head.updateWorldMatrix(true, false);
        camera.position.set(0, eye.y, eye.z - 0.035).applyMatrix4(head.matrixWorld);
        const { x, y, z } = camera.position;
        camera.lookAt(x - Math.sin(heading) * c, y + Math.sin(lookPitch), z - Math.cos(heading) * c);
        camera.near = 0.055;
        camera.fov = 68;
        camera.updateProjectionMatrix();
        return true;
      }
      if (phase !== 'bridge' || driving) return false;
      roofSet.camera(camera, dt, line);
      return true;
    },
    posePlayer(dt) {
      if (driving) return false;
      if (seat) {
        moveSeat();
        return true;
      }
      return roofSet.pose(dt, phase === 'bridge', line, phase === 'bridge' ? (voice?.intensity() ?? 0) : 0);
    },
    update(dt, otherRide, car) {
      driving = otherRide || !!(player.inCar || player.boarding || player.exiting || player.ragdoll);
      const { u, v } = point(),
        oldBase = base;
      aboard =
        !driving &&
        (seat !== null ||
          (inside(u, v) && ((phase === 'coach' && aboard) || Math.abs(player.y - base) < 1.54)));
      if (phase === 'bridge' && !driving && line >= 0) {
        if (silence > 0) {
          silence -= dt;
          if (silence <= 0) nextLine();
        } else if (speechTime > 0) {
          speechTime -= dt;
          if (speechTime <= 0) nextLine();
        }
      }
      if (phase === 'station' && !missed) {
        trip.remaining = Math.max(0, trip.remaining - dt);
        if (trip.remaining === 0) beginRun();
      }
      if (skipped) {
        skipped.elapsed += dt;
        if (skipped.elapsed > 0.55 && !skipped.moved) {
          metres = lineLength;
          closed = 1;
          place();
          moveSeat();
          skipped.moved = true;
        }
        if (
          skipped.moved &&
          skipped.elapsed >= 4.35 &&
          world.terrain.ready(pose.x, pose.z) &&
          world.built.has(chunkKey(pose.x, pose.z))
        ) {
          skipped = null;
          hud.travel(false);
          arrive();
        } else if (skipped.elapsed > 25) {
          metres = skipped.from;
          skipped = null;
          place();
          moveSeat();
          hud.travel(false);
          hud.say('Poslední vlak', 'Nádraží se zatím nepodařilo načíst. Vlak pokračuje po trati.');
        }
        return;
      }
      if (phase === 'coach' || missed) {
        closed = Math.min(1, closed + dt * 0.65);
        if (closed === 1) {
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
      live = false;
      voice?.stop();
      music?.stop(0.4);
      ring?.stop();
      if (trains?.storyPass === passSound) trains.storyPass = null;
      if (world.storyCoach === deck) world.storyCoach = null;
      roofSet.dispose();
      board.dispose();
      train.close();
      hud.close();
    },
  };
}
