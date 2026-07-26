// ---- Among The City: boot + game loop + camera + HUD ----
// The integrator. Loads the Pardubice data, streams the world in around the
// spawn (the forecourt of hlavní nádraží), owns the walk/drive state machine
// (E enters and leaves cars), the chase camera, the day clock and the HUD.
// Everything heavy lives in the modules: city.js streams meshes, traffic.js
// drives the AI cars, vehicles.js does car physics, sky.js does the light.

import * as THREE from 'three';
import { SPAWN, CITY_DATA_URL, DAY_LENGTH, START_TOD, CAR_COLORS, CAR } from './config.js';
import { loadCity, chunkKey } from './geo.js';
import { CityWorld } from './city.js';
import { input } from './input.js';
import { Player } from './player.js';
import { Vehicles, driveStep, lampMats } from './vehicles.js';
import { Traffic } from './traffic.js';
import { makeSky, updateSky, todClock } from './sky.js';
import { Minimap } from './minimap.js';
import { initAudio, sfx, engineStart, engineStop, engineSet, setVolume,
  heliStart, heliStop, heliSet, ambientStart, nearbyTrafficHum } from './audio.js';
import { initSettings, getSettings } from './settings.js';
import { initOrtho } from './ortho.js';
import { Pedestrians } from './pedestrians.js';
import { PostFX } from './postfx.js';
import { Helicopter, makeHelipad } from './helicopter.js';
import { Clouds } from './clouds.js';
import { WorldMap } from './worldmap.js';
import { Trains } from './trains.js';
import { Weapons } from './weapons.js';
import { MISSILE } from './config.js';

const $id = (id) => document.getElementById(id);

// ---------- renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
$id('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0xa8b8c8, 180, 900); // sky.js recolors/moves this
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 1400);

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---------- game state ----------
const game = {
  tod: START_TOD,       // 0..1 day clock
  mode: 'boot',         // boot → play
  car: null,            // the car the player is driving (null = on foot)
  heli: null,           // the helicopter being flown (null = not flying)
};

let world = null, player = null, vehicles = null, traffic = null, sky = null, minimap = null;
let peds = null;
let postfx = null;   // bloom + god rays — what makes lamps and headlights GLOW
let heli = null, clouds = null;   // the helipad's machine, and the sky to fly it through
let worldMap = null;   // the full-region map on M, and the waypoint it owns
let trains = null;     // České dráhy on the real 532 km network
let weapons = null;  // the rocket pod under that machine, and what it does to walls
let aimMark = null;  // the ring on the ground where the next rocket would land
let _aimT = 0;
const parked = [];      // cars placed by us, enterable

// ---------- camera rig ----------
// Walk: orbit-follow — eases behind the player's heading, right-drag orbits
// freely, wheel zooms. Drive: chase cam with speed-based distance + FOV kick.
let camYaw = SPAWN.heading;
// Measured: at 0.38 rad plus the height offset the camera looked 30° DOWN and
// the TOP of the frame sat 2.7° BELOW the horizon — the sky was never on
// screen at all, which is why the cloud field looked like it did not exist.
let camPitch = 0.26;         // radians above horizontal
// The character model is correctly scaled (1.77 m against a 4.9 m car), so
// "the player looks huge" is FRAMING, not size: at 7.5 m with FOV 55 a person
// filled 19 % of the screen height. Standing further back and higher halves
// that and lets the street read as a street.
let camDist = 14;
const camSmooth = new THREE.Vector3();
let camInit = false;
const BASE_FOV = 55;

let _lastLookT = -9; // when the mouse last steered — pauses auto-follow
function updateCamera(dt) {
  const drag = input.takeDrag();
  // pointer-locked mouse look uses a finer touch than right-drag
  const sens = input.locked ? 0.0026 : 0.004;
  if (drag.x || drag.y) _lastLookT = performance.now() * 0.001;
  camYaw -= drag.x * sens;
  camPitch = Math.max(0.06, Math.min(1.15, camPitch + drag.y * sens));
  camDist = Math.max(5, Math.min(26, camDist + input.takeWheel() * 1.4));

  let tx, ty, tz, wantYaw, dist, height, fov, pitchK = 1;
  if (game.car) {
    const c = game.car;
    // ease behind the car unless the player is dragging the camera around
    wantYaw = c.heading;
    const speedK = Math.min(1, Math.abs(c.speed) / CAR.vmax);
    dist = camDist + 1.6 + speedK * 3.2;
    height = 2.4 + speedK * 1.1;
    tx = c.x; ty = (c.mesh?.position.y ?? 0) + 1.1; tz = c.z;
    fov = BASE_FOV + speedK * 13;   // the road starts to RUSH at speed
  } else if (game.heli) {
    // flight: hang back but stay close to the machine's own level — a chase
    // cam perched high enough to look down at the fuselage crops the whole sky
    // out of frame, and from a helicopter the sky IS half the view
    const h = game.heli;
    wantYaw = h.heading;
    const speedK = Math.min(1, Math.hypot(h.vx ?? 0, h.vz ?? 0) / 62);
    dist = camDist + 6 + speedK * 6;
    height = 1.4 + speedK * 0.8;
    pitchK = 0.45;                    // flatten the orbit: horizon ~⅔ up frame
    tx = h.x; ty = h.y + 1.4; tz = h.z;
    fov = BASE_FOV + speedK * 10;
  } else {
    wantYaw = player.heading;
    dist = camDist;
    height = 2.1;
    tx = player.pos.x; ty = player.mesh.position.y + 1.5; tz = player.pos.z;
    fov = BASE_FOV;
  }
  // auto-follow: yaw eases toward the travel heading only while moving and
  // the mouse hasn't steered for a moment — with mouse look on, the player's
  // hand owns the camera and auto-follow must not wrestle it back
  const moving = game.car ? Math.abs(game.car.speed) > 1.5
    : game.heli ? true : player.speed > 0.5;
  const lookIdle = performance.now() * 0.001 - _lastLookT > 1.6;
  if (moving && !input.mouse.right && lookIdle) {
    let d = wantYaw - camYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * Math.min(1, dt * (game.car ? 2.2 : 1.6));
  }

  const pitch = camPitch * pitchK;
  // Indoors the orbit has to shrink or a 14 m boom simply lives in the flat
  // next door. 3.4 m is about as far back as a Czech living room allows.
  const indoors = !game.car && !game.heli
    && !!world.interiors?.modelAt(tx, tz);
  if (indoors) dist = Math.min(dist, 3.4);
  const flat = Math.cos(pitch) * dist;
  let px = tx + Math.sin(camYaw) * flat;
  let pz = tz + Math.cos(camYaw) * flat;
  let py = ty + height * (indoors ? 0.25 : 1) + Math.sin(pitch) * dist;
  // …and then it still has to not be inside a wall. March the boom back in
  // from full length until the camera sits in air: the same trick every
  // third-person game uses, done against the interior's own boxes rather than
  // a raycast, because the boxes are already in a spatial hash.
  if (world.interiors?.occupied(px, py, pz, 0.28)) {
    const bx = px - tx, by = py - ty, bz = pz - tz;
    // MIN_T is a floor, not an option: collapsing the boom onto the target
    // makes lookAt() aim the camera at its own position, which renders as one
    // flat grey wall — the bug this replaces. 0.2 of a 3.4 m boom is 0.7 m,
    // close enough to clear a 1.5 m wide stairwell and still be a camera.
    const MIN_T = 0.2;
    let t = 0.82;
    for (; t > MIN_T; t -= 0.1)
      if (!world.interiors.occupied(tx + bx * t, ty + by * t, tz + bz * t, 0.24)) break;
    t = Math.max(MIN_T, t);
    px = tx + bx * t; py = ty + by * t; pz = tz + bz * t;
  }
  // keep the camera above ground/bridge decks
  const groundY = world.heightAt(px, pz) + 0.5;
  const want = new THREE.Vector3(px, indoors ? py : Math.max(py, groundY), pz);
  if (!camInit) { camSmooth.copy(want); camInit = true; }
  camSmooth.lerp(want, Math.min(1, dt * 9));
  camera.position.copy(camSmooth);
  // blast shake: high-frequency positional jitter, decayed by weapons.js. It
  // rides on the SMOOTHED position rather than the target, so a launch nudges
  // the frame and a detonation slams it without the follow cam fighting back.
  const sh = weapons?.shake ?? 0;
  if (sh > 0.001) {
    const t = performance.now() * 0.06;
    camera.position.x += Math.sin(t * 1.7) * sh * 0.42;
    camera.position.y += Math.sin(t * 2.3 + 1.1) * sh * 0.34;
    camera.position.z += Math.cos(t * 1.9 + 0.4) * sh * 0.42;
  }
  camera.lookAt(tx, ty, tz);
  if (Math.abs(camera.fov - fov) > 0.2) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
    camera.updateProjectionMatrix();
  }
}

// ---------- enter / exit cars ----------
function nearestEnterableCar() {
  let best = null, bd = 3.4;
  const px = player.pos.x, pz = player.pos.z;
  for (const c of parked) {
    const d = Math.hypot(c.x - px, c.z - pz);
    if (d < bd) { bd = d; best = c; }
  }
  if (traffic) for (const c of traffic.cars) {
    const d = Math.hypot(c.x - px, c.z - pz);
    // moving traffic must slow right down before you can yank the door
    if (d < bd && Math.abs(c.speed) < 3) { bd = d; best = c; }
  }
  return best;
}

// M opens the region map. It does not pause anything — the city keeps
// streaming and the traffic keeps driving underneath it.
input.onKey('KeyM', () => {
  if (game.mode !== 'play' || !worldMap) return;
  const open = worldMap.toggle();
  document.body.dataset.panelOpen = open ? '1' : '';
  if (open && input.locked) document.exitPointerLock();
});

input.onKey('KeyE', () => {
  if (game.mode !== 'play') return;
  if (trains?.riding) {
    // only with the doors open — stepping off at 140 km/h is not a feature
    if (!trains.alight()) { ui_hint('Vystoupit lze jen ve stanici'); return; }
    sfx('train_doors', 0.7);
  } else if (!game.car && !game.heli
      && trains?.nearestBoardable?.(player.pos.x, player.pos.z, 6)) {
    const t = trains.nearestBoardable(player.pos.x, player.pos.z, 6);
    if (trains.board(t)) sfx('train_doors', 0.7);
  } else if (game.car) {
    // step out: player.js places us at the car's side
    game.car.ctl = null;
    player.setInCar(null);
    parked.includes(game.car) || parked.push(game.car);
    game.car = null;
    $id('speedo').classList.add('hidden');
    engineStop();
    sfx('door_close', 0.8);
  } else if (game.heli) {
    // step out of the helicopter — only with the skids down
    if (game.heli.airborne) { ui_hint('Nejdřív přistaň'); return; }
    player.setInCar(null);
    player.pos.x = game.heli.x + 3; player.pos.z = game.heli.z + 3;
    game.heli = null;
    $id('speedo').classList.add('hidden');
    heliStop?.();
    sfx('door_close', 0.8);
  } else if (heli && Math.hypot(heli.x - player.pos.x, heli.z - player.pos.z) < 5.5
      && !heli.airborne) {
    game.heli = heli;
    player.setInCar(heli);              // rides along, hidden, like a car
    $id('speedo').classList.remove('hidden');
    sfx('door_open', 0.8);
    sfx('heli_start', 0.75);
    heliStart?.();
  } else {
    const car = nearestEnterableCar();
    if (!car) return;
    const inTraffic = traffic.cars instanceof Set ? traffic.cars.has(car) : traffic.cars.includes?.(car);
    if (inTraffic) traffic.steal(car);
    const pi = parked.indexOf(car);
    if (pi >= 0) parked.splice(pi, 1);
    game.car = car;
    player.setInCar(car);
    $id('speedo').classList.remove('hidden');
    sfx('door_open', 0.8);
    setTimeout(() => { if (game.car) { sfx('engine_start', 0.7); engineStart(); } }, 350);
  }
});

// ---------- V: the rocket pod ----------
// Only from the cockpit, and only with the rotor actually turning — a rocket
// fired off a cold pad would just skid down the apron. The launcher inherits
// the machine's own velocity, so a fast pass throws them ahead of you.
input.onKey('KeyV', () => {
  if (game.mode !== 'play' || !game.heli || !weapons) return;
  const h = game.heli;
  if (!weapons.ready) {
    if (weapons.reload > 0) ui_hint('Přebíjím…');
    return;
  }
  weapons.fire({
    x: h.x, y: h.y + 0.9, z: h.z,
    heading: h.heading, pitch: h.pitch ?? 0,
    vx: h.vx ?? 0, vy: h.vy ?? 0, vz: h.vz ?? 0,
  });
});

// brief nudge in the action-hint slot (e.g. "land first")
let _hintHold = 0;
function ui_hint(text) {
  const el = $id('action-hint');
  el.textContent = text;
  el.classList.remove('hidden');
  _hintHold = 1.6;
}

// ---------- parked cars around the spawn ----------
// A handful of cars wait on the forecourt and the nearby parking lots, so the
// first thing you do at the station is what you'd do in any GTA: take a car.
function placeParkedCars(city) {
  const spots = [[SPAWN.x + 9, SPAWN.z + 8, 1.2], [SPAWN.x - 14, SPAWN.z + 12, 1.9]];
  // parking polygons near the station → one car at each centroid
  let n = 0;
  for (const p of city.paved) {
    if (p.t !== 'parking' || n >= 8) continue;
    let cx = 0, cz = 0;
    for (const [x, z] of p.o) { cx += x; cz += z; }
    cx /= p.o.length; cz /= p.o.length;
    if (Math.hypot(cx - SPAWN.x, cz - SPAWN.z) > 260) continue;
    spots.push([cx, cz, Math.random() * Math.PI * 2]);
    n++;
  }
  for (const [x, z, h] of spots) {
    const pos = { x, z };
    world.collide(pos, 1.2); // never inside a wall
    const kind = ['sedan', 'hatch', 'kombi', 'suv', 'van'][(Math.random() * 5) | 0];
    const car = vehicles.add(kind, pos.x, pos.z, h, CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0]);
    parked.push(car);
  }
}

// every car the player can hit — traffic + parked, self filtered in driveStep
function _crashList() {
  return traffic ? [...traffic.cars, ...parked] : parked;
}

// ---------- how busy the roads are, right here and right now ----------
// Two multipliers ride on the player's traffic-density setting, because one
// global number cannot be right for 03:00 on a field track AND 16:00 on
// Masarykovo náměstí.
//
// TIME: a real Czech city has twin peaks — the commute in around 08:00 and the
// heavier one home around 16:00 — a lunchtime plateau, and a dead trough near
// 03:00. Values are multipliers on the setting, interpolated smoothly between
// the anchor hours so the world never jumps at a boundary.
const TRAFFIC_HOURS = [
  [0, 0.16], [3, 0.06], [5, 0.22], [7, 0.95], [8, 1.15], [10, 0.72],
  [12, 0.80], [14, 0.85], [16, 1.45], [17, 1.35], [19, 0.75],
  [21, 0.42], [23, 0.22], [24, 0.16],
];
function trafficTimeK(tod) {
  const h = (tod ?? 0) * 24;
  for (let i = 0; i < TRAFFIC_HOURS.length - 1; i++) {
    const [h0, v0] = TRAFFIC_HOURS[i], [h1, v1] = TRAFFIC_HOURS[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return v0 + (v1 - v0) * (t * t * (3 - 2 * t)); // smoothstep, no kinks
    }
  }
  return 0.5;
}

// PLACE: count the buildings the chunk index already holds around the player.
// A city block carries hundreds per cell, a village a dozen, open fields none
// — so this is a free, always-current read on how built-up the surroundings
// are, with no extra data and no per-place tuning.
let _densK = 1, _densT = 0;
function trafficPlaceK(dt, focus) {
  _densT -= dt;
  if (_densT <= 0) {
    _densT = 2;                       // a couple of times a minute is plenty
    const cx = Math.floor(focus.x / 120), cz = Math.floor(focus.z / 120);
    let n = 0;
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++)
      n += world?.city?.chunkIndex?.get((cx + dx) + ',' + (cz + dz))?.buildings?.length ?? 0;
    // 25 cells ≈ 0.36 km². Empty country → 0.18, a village ≈ 0.5,
    // suburbs ≈ 1, the middle of Pardubice or Hradec ≈ 1.5.
    const want = Math.max(0.18, Math.min(1.5, 0.18 + Math.sqrt(n) / 26));
    _densK += (want - _densK) * 0.5;  // ease so a corner never snaps the flow
  }
  return _densK;
}

// ---------- horizon: how far the world is built, and where the haze sits ----
// Two rules, and the second is the one that was broken:
//   1. From the air you see kilometres, so the streamed radius grows with
//      altitude (and the per-frame build budget with it, or the edge would
//      chase you).
//   2. The fog wall must always end INSIDE that radius. It sat at 900 m while
//      the city was only built to 720 m, so the world visibly stopped against
//      bare sky — exactly the "blue plane where nothing is loaded" report.
const GROUND_CHUNKS = 6, AIR_CHUNKS_MAX = 10, AIR_FAR_MAX = 20;
function updateHorizon(dt) {
  if (!world || !sky) return;
  const gs = getSettings();
  const base = gs.viewChunks ?? GROUND_CHUNKS;
  const alt = game.heli ? Math.max(0, game.heli.y) : 0;
  const climb = Math.min(1, alt / 300);
  // climb 0 → 300 m widens the view from the ground setting to the air cap
  const want = Math.round(base + (AIR_CHUNKS_MAX - base) * climb);
  world.viewChunks = Math.max(base, want);
  // …and unrolls a ground-only ORTHO ring far beyond it. That ring is one
  // textured quad per cell, so it costs almost nothing, and since the aerial
  // photo already contains the roads and roofs it reads as real city out to
  // kilometres — which is what stops the world ending in mid-air.
  world.farChunks = Math.round(AIR_FAR_MAX * climb);
  world.chunksPerFrame = alt > 20 ? 8 : 2;   // keep the edge ahead of the nose
  const radius = (world.viewChunks + world.farChunks) * 120;
  // haze reaches 88 % of the built radius: geometry has fully dissolved before
  // the streamed edge, so there is nothing to notice
  sky.fogScale = (radius * 0.88) / 900;
  // The far plane serves the SKY as well as the city. Tied to the city radius
  // it sat at 1632 m, while the cloud field spans ±2600 m — so 95 % of the
  // clouds were clipped away before they could be seen (measured: 16 of 319
  // puffs alive). The floor here lets the whole field render; near moves out
  // to 0.5 m to buy back the depth precision that costs (nothing in a chase
  // camera is closer than a metre anyway).
  const wantFar = Math.max(radius * 1.7, 5200);
  if (Math.abs(camera.far - wantFar) > 50 || camera.near < 0.4) {
    camera.far = wantFar;
    camera.near = 0.5;
    camera.updateProjectionMatrix();
  }
}

// ---------- FPS meter (Settings → Hra → Zobrazit FPS) ----------
// Measured on the WALL CLOCK between frames, not on how long render() took:
// the two differ a lot here, because streaming a chunk or rebuilding the
// canopy costs time outside the draw call and a render-only figure would
// happily read 200 FPS through a visible stutter. The 1 % low is the number
// that actually correlates with "it feels smooth", so it is shown too.
let _fpsLast = 0, _fpsAvg = 60, _fpsAcc = 0, _fpsFrames = 0;
const _fpsHist = new Float32Array(120);
let _fpsHi = 0;
function tickFpsMeter(now) {
  const el = $id('fps-meter');
  if (!el) return;
  if (!getSettings().showFps) {
    if (!el.classList.contains('hidden')) el.classList.add('hidden');
    _fpsLast = 0;
    return;
  }
  el.classList.remove('hidden');
  if (_fpsLast) {
    const dtMs = now - _fpsLast;
    // 250 ms is already four frames at 15 FPS: anything longer is a tab
    // switch, a boot stall or the OS, not gameplay — and letting one such
    // frame into the ring pinned the "1 % low" at 1 for two seconds.
    if (dtMs > 0 && dtMs < 250) {
      _fpsAvg += (1000 / dtMs - _fpsAvg) * 0.08;   // smooth, no jitter
      _fpsHist[_fpsHi] = dtMs;
      _fpsHi = (_fpsHi + 1) % _fpsHist.length;
    }
  }
  _fpsLast = now;
  _fpsAcc += 1; _fpsFrames += 1;
  // repaint the DOM ~5x a second: a per-frame textContent write is itself a
  // measurable cost in a meter whose whole job is not to lie about the cost
  if (_fpsFrames % 12) return;
  // 1 % low = the 99th-percentile FRAME TIME over the last ~2 s
  let worst = 0, filled = 0;
  for (let i = 0; i < _fpsHist.length; i++) {
    if (_fpsHist[i] <= 0) continue;
    filled++;
    if (_fpsHist[i] > worst) worst = _fpsHist[i];
  }
  // only claim a 1 % low once the ring actually holds a second of history —
  // before that the "worst frame" is just the newest frame
  const low = filled > 60 && worst > 0 ? Math.round(1000 / worst) : 0;
  const cls = _fpsAvg >= 50 ? '' : _fpsAvg >= 30 ? 'mid' : 'low';
  el.innerHTML = `<b class="${cls}">${Math.round(_fpsAvg)}</b> FPS`
    + `  ·  ${(1000 / Math.max(1, _fpsAvg)).toFixed(1)} ms`
    + (low ? `  ·  1% low ${low}` : '');
}

// ---------- night lights ----------
// Two real headlight cones ride the player's car and switch on with dusk, so
// driving after dark actually lights the road ahead instead of relying on the
// (unlit) emissive lamp boxes. Only the player gets real lights — 120 traffic
// cars with spotlights would melt the shadow budget; their emissive lamps read
// fine as distant points.
let _beamL = null, _beamR = null, _beamsOn = false;
const _beamTarget = new THREE.Object3D();
function updateNightLights(dt) {
  // how dark it is, read off the sun the sky module already computes
  // sky.js publishes the authoritative night curve — deriving it from
  // sun.intensity broke the moment that curve was retuned
  const nightK = sky?.nightK ?? 0;
  // street lamps: one shared material drives every instanced lamp head in the
  // city, so dusk lights the whole map with a single assignment
  const lm = world?.mats?.lampHead;
  if (lm) lm.emissiveIntensity = 4.5 * nightK;   // >1 in linear = bloom bites
  // car lamps: a dim daytime marker, a real glare after dark
  const vm = lampMats;
  if (vm) {
    vm.head.emissiveIntensity = 1.4 + 5.0 * nightK;
    vm.tail.emissiveIntensity = 1.4 + 4.0 * nightK;
  }
  const want = !!game.car && nightK > 0.3;
  if (want && !_beamL) {
    const mk = () => {
      const s = new THREE.SpotLight(0xfff0cc, 3.2, 55, 0.55, 0.45, 1.4);
      s.castShadow = false; // the beams light the road; shadows stay on the sun
      scene.add(s);
      return s;
    };
    _beamL = mk(); _beamR = mk();
    scene.add(_beamTarget);
    _beamL.target = _beamTarget; _beamR.target = _beamTarget;
  }
  if (_beamL) {
    _beamsOn = want;
    _beamL.visible = _beamR.visible = want;
    if (want) {
      const c = game.car;
      const fx = -Math.sin(c.heading), fz = -Math.cos(c.heading);
      const rx = Math.cos(c.heading), rz = -Math.sin(c.heading);
      const y = (c.mesh?.position.y ?? 0) + 0.75;
      _beamL.position.set(c.x + fx * 1.9 - rx * 0.62, y, c.z + fz * 1.9 - rz * 0.62);
      _beamR.position.set(c.x + fx * 1.9 + rx * 0.62, y, c.z + fz * 1.9 + rz * 0.62);
      // aim well down the road, dipped slightly toward the tarmac
      _beamTarget.position.set(c.x + fx * 26, y - 2.2, c.z + fz * 26);
      _beamTarget.updateMatrixWorld();
    }
  }
}

// ---------- HUD ----------
let hintT = 0;
function updateHud(dt) {
  $id('tod-clock').textContent = todClock(game.tod);
  if (game.car) {
    $id('speed-num').textContent = Math.round(Math.abs(game.car.speed) * 3.6);
    $id('speed-unit').textContent = 'km/h';
  } else if (trains?.riding) {
    $id('speedo').classList.remove('hidden');
    $id('speed-num').textContent = Math.round(Math.abs(trains.riding.speed ?? 0) * 3.6);
    $id('speed-unit').textContent = 'km/h · ČD';
  } else if (game.heli) {
    // in flight the readout becomes an altimeter with the airspeed beside it,
    // so the trailing unit has to switch too (it used to read "137 m km/h")
    const kmh = Math.round(Math.hypot(game.heli.vx ?? 0, game.heli.vz ?? 0) * 3.6);
    $id('speed-num').textContent = `${kmh}`;
    $id('speed-unit').textContent = `km/h · ${Math.round(game.heli.y)} m`;
  }
  // action hint, re-checked a few times a second
  hintT -= dt;
  if (hintT <= 0) {
    hintT = 0.2;
    const hint = $id('action-hint');
    if (_hintHold > 0) { _hintHold -= 0.2; }
    else if (trains?.riding) {
      const t = trains.riding;
      hint.innerHTML = t.halted
        ? `<b>${t.stopName ?? 'Stanice'}</b> · odjezd za ${Math.ceil(t.dwellLeft ?? 0)} s · <kbd>E</kbd> vystoupit`
        : `Jedete do <b>${t.nextStopName ?? 'další stanice'}</b>`;
      hint.classList.remove('hidden');
    }
    else if (trains?.nearestBoardable?.(player.pos.x, player.pos.z, 6)) {
      hint.innerHTML = '<kbd>E</kbd> nastoupit do vlaku';
      hint.classList.remove('hidden');
    }
    else if (game.heli) {
      hint.innerHTML = game.heli.airborne
        ? '<kbd>↑</kbd><kbd>↓</kbd> stoupání · <kbd>WASD</kbd> let · <kbd>←</kbd><kbd>→</kbd> otáčení · <kbd>V</kbd> raketa'
        : '<kbd>E</kbd> vystoupit · <kbd>↑</kbd> vzlet · <kbd>V</kbd> raketa';
      hint.classList.remove('hidden');
    }
    else if (heli && !game.car && Math.hypot(heli.x - player.pos.x, heli.z - player.pos.z) < 5.5) {
      hint.innerHTML = '<kbd>E</kbd> nastoupit do vrtulníku';
      hint.classList.remove('hidden');
    }
    else if (game.car) {
      hint.innerHTML = '<kbd>E</kbd> vystoupit';
      hint.classList.remove('hidden');
    } else {
      // on foot the hint doubles as a sign over the door: walk into a building
      // and it tells you what you just walked into
      const inside = world?.interiors?.labelAt(player.pos.x, player.pos.z);
      const car = nearestEnterableCar();
      if (inside) {
        const fl = player.y > 1.5 ? ` · ${Math.max(1, Math.round(player.y / 3) + 1)}. patro` : '';
        hint.innerHTML = `🏠 ${inside}${fl}`;
        hint.classList.remove('hidden');
      } else if (car) { hint.innerHTML = '<kbd>E</kbd> nastoupit'; hint.classList.remove('hidden'); }
      else hint.classList.add('hidden');
    }
  }
  // rocket readout: rounds left, or the reload bar
  const pod = $id('pod');
  if (pod) {
    if (game.heli && weapons) {
      pod.classList.remove('hidden');
      pod.textContent = weapons.reload > 0
        ? '🚀 ' + '·'.repeat(Math.max(1, Math.round(MISSILE.mag * (1 - weapons.reload / MISSILE.reload))))
        : '🚀 ' + '▮'.repeat(weapons.ammo);
    } else pod.classList.add('hidden');
  }
  // the map draws its own markers while open; the waypoint it owns is mirrored
  // onto the HUD compass and the minimap so it is useful once the map closes
  worldMap?.update(player, game.car, heli);
  const wp = worldMap?.waypoint ?? null;
  minimap?.setWaypoint?.(wp);
  const wpEl = $id('waypoint-hud');
  if (wpEl) {
    if (wp) {
      const d = Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z);
      // bearing relative to where the CAMERA looks, so the arrow reads as
      // "turn that way" rather than as a compass needle
      const ang = Math.atan2(wp.x - player.pos.x, wp.z - player.pos.z) - camYaw + Math.PI;
      wpEl.classList.remove('hidden');
      wpEl.style.setProperty('--wp-rot', (ang * 180 / Math.PI).toFixed(1) + 'deg');
      wpEl.querySelector('.wp-dist').textContent = d > 1500
        ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
    } else wpEl.classList.add('hidden');
  }
  minimap?.update(player.pos.x, player.pos.z, camYaw,
    traffic ? [...traffic.cars] : []);
}

// ---------- where the next rocket lands ----------
// Not a guess: aimPoint() runs the SAME ballistic integrator update() does,
// against the same world, and reports the first thing it meets. Recomputed a
// few times a second (nothing about a helicopter changes fast enough to need
// it per frame), then PROJECTED onto the screen every frame.
//
// The projection is the important half. A crosshair pinned to the middle of
// the screen is a lie in a chase camera: the machine sits below and ahead of
// the camera, so the rockets leave along its nose, not along the view axis.
// Putting the reticle where the impact point actually appears means it hangs
// over the helicopter when you are flying level and slides onto the target as
// you nose down — which is exactly the information you need to aim.
const _aimV = new THREE.Vector3();
let aimHit = null;
function updateAim(dt) {
  if (!weapons) return;
  if (!game.heli) { if (aimMark) aimMark.visible = false; aimHit = null; return; }
  _aimT -= dt;
  if (_aimT > 0) return;
  _aimT = 0.08;
  const h = game.heli;
  const src = {
    x: h.x, y: h.y + 0.9, z: h.z, heading: h.heading, pitch: h.pitch ?? 0,
    vx: h.vx ?? 0, vy: h.vy ?? 0, vz: h.vz ?? 0,
  };
  const hit = weapons.aimPoint(src);
  if (!aimMark) {
    const g = new THREE.RingGeometry(2.1, 2.9, 26).rotateX(-Math.PI / 2);
    aimMark = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xff5a3c, transparent: true, opacity: 0.85, depthTest: false,
      toneMapped: false, side: THREE.DoubleSide,
    }));
    aimMark.renderOrder = 900;
    scene.add(aimMark);
  }
  if (hit) {
    aimHit = { x: hit.x, y: hit.y, z: hit.z, far: false };
    aimMark.visible = true;
    aimMark.position.set(hit.x, hit.y + 0.25, hit.z);
  } else {
    // nothing in range — aim at open sky, 400 m down the launch vector, so the
    // sight never disappears just because you are pointing at the horizon
    const p = (src.pitch ?? 0) - 0.055, cp = Math.cos(p);
    aimHit = {
      x: src.x - Math.sin(src.heading) * cp * 400,
      y: src.y + Math.sin(p) * 400,
      z: src.z - Math.cos(src.heading) * cp * 400,
      far: true,
    };
    aimMark.visible = false;
  }
}

// Screen placement, every frame and AFTER the camera has moved — a reticle
// lagging the camera by a frame reads as drift and makes aiming feel greasy.
function placeReticle() {
  const el = $id('reticle');
  if (!el) return;
  if (!game.heli || !aimHit) { el.classList.add('hidden'); return; }
  _aimV.set(aimHit.x, aimHit.y, aimHit.z).project(camera);
  if (_aimV.z > 1) { el.classList.add('hidden'); return; }   // behind the camera
  el.classList.remove('hidden');
  el.style.left = ((_aimV.x * 0.5 + 0.5) * window.innerWidth).toFixed(0) + 'px';
  el.style.top = ((-_aimV.y * 0.5 + 0.5) * window.innerHeight).toFixed(0) + 'px';
  el.classList.toggle('far', aimHit.far);
  const span = el.firstElementChild;
  if (span) {
    const d = Math.hypot(aimHit.x - game.heli.x, aimHit.y - game.heli.y, aimHit.z - game.heli.z);
    span.textContent = aimHit.far ? '—' : Math.round(d) + ' m';
  }
}

// the big location title fades once you've read it
setTimeout(() => { const el = $id('location-name'); if (el) el.style.opacity = '0'; }, 7000);

// ---------- pointer-lock mouse look (default ON) + audio unlock ----------
// Click into the game → the cursor locks and the mouse always steers the
// camera; Escape releases it (native pointer-lock behaviour). The same first
// gesture unlocks WebAudio. Clicks are ignored while the settings panel is
// open, so its controls stay clickable.
renderer.domElement.addEventListener('click', () => {
  initAudio();
  ambientStart?.();
  if (game.mode !== 'play') return;
  if (document.body.dataset.panelOpen) return;
  if (getSettings().mouseLook && !input.locked) renderer.domElement.requestPointerLock();
});
window.addEventListener('keydown', () => initAudio(), { once: true });

// ---------- settings → engine application ----------
let orthoMgr = null;
function applySettings(s, key) {
  // cheap, always-safe knobs first
  setVolume(s.volume ?? 0.8);
  renderer.setPixelRatio(s.resScale === 2 ? Math.min(window.devicePixelRatio, 2) : s.resScale);
  if (world) world.viewChunks = s.viewChunks;
  if (traffic) traffic.maxCars = s.traffic;
  if (peds) peds.max = s.peds ?? 34;
  // interiors are a live toggle: switching them off sheds every un-shot
  // building's rooms on the next scan, and keeps the wrecks. buildingR is the
  // "Dohlednost budov" knob — how far out the box shells (real windows, brand
  // signage) exist; past it the flat chunk facade takes over.
  if (world?.interiors) {
    world.interiors.enabled = s.interiors !== false;
    world.interiors.drawR = s.buildingR ?? 160;
  }
  if (sky) {
    const sun = sky.sun;
    if (renderer.shadowMap.enabled !== !!s.shadows) {
      renderer.shadowMap.enabled = !!s.shadows;
      sun.castShadow = !!s.shadows;
      scene.traverse(o => { if (o.material) o.material.needsUpdate = true; });
    }
    if (sun.shadow.mapSize.x !== s.shadowRes) {
      sun.shadow.mapSize.set(s.shadowRes, s.shadowRes);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }
  if (!s.mouseLook && input.locked) document.exitPointerLock();
  // chunk-recipe knobs: flip the flags on the shared mats and rebuild
  if (world) {
    const wantOrtho = s.ortho ? orthoMgr : null;
    const recipeChanged = world.mats.ortho !== wantOrtho
      || world.mats.facades !== !!s.facades
      || world.mats.trees !== (s.trees !== false);
    world.mats.ortho = wantOrtho;
    world.mats.facades = !!s.facades;
    world.mats.trees = s.trees !== false;
    if (recipeChanged && (key === undefined || ['ortho', 'facades', 'trees', 'preset'].includes(key))) {
      world.rebuildAll();
    }
  }
}

// ---------- boot ----------
async function boot() {
  // Region manifest first (tiled world); the single-city file is the
  // fallback — ALSO when the manifest exists but its download hasn't reached
  // the spawn yet (the region fetcher writes tiles spawn-first, but a fresh
  // clone mid-download must still boot into a full Pardubice).
  let city = await loadCity('data/manifest.json').catch(() => null);
  if (city) {
    await city.ensureTiles(SPAWN.x, SPAWN.z);
    const cell = city.chunkIndex.get(chunkKey(SPAWN.x, SPAWN.z));
    if (!cell || !cell.roads.length) city = null; // manifest too young — legacy
  }
  if (!city) city = await loadCity(CITY_DATA_URL);
  world = new CityWorld(scene, city);
  sky = makeSky(scene);
  player = new Player(scene, SPAWN.x, SPAWN.z, SPAWN.heading);
  vehicles = new Vehicles(scene);
  traffic = new Traffic(city, vehicles);
  minimap = new Minimap($id('minimap'), city);
  trains = new Trains(scene, city);
  worldMap = new WorldMap(city, minimap);
  peds = new Pedestrians(scene, city);
  clouds = new Clouds(scene);
  // The world beyond the streamed chunks used to be bare sky, so from the air
  // the built area showed as a hard-edged square floating in blue. This apron
  // is a single huge quad at ground level in the fog's own colour: distance
  // fog paints it the same shade as the horizon haze, so the city now dissolves
  // into open country instead of stopping against nothing.
  const apron = new THREE.Mesh(
    new THREE.PlaneGeometry(60000, 60000),
    new THREE.MeshBasicMaterial({ color: 0x8a9182, fog: true, depthWrite: false }));
  apron.rotation.x = -Math.PI / 2;
  apron.position.y = -0.6;      // under every road, kerb and water surface
  apron.renderOrder = -800;     // before the city, after the sky dome
  apron.frustumCulled = false;
  scene.add(apron);
  // The heliport: a pad on the open forecourt apron east of the hall, clear of
  // the bus stands, with the machine sitting on it — visible the moment you
  // spawn, so the sky is an obvious invitation rather than a secret.
  const padX = SPAWN.x + 62, padZ = SPAWN.z - 16;
  scene.add(makeHelipad(padX, padZ));
  heli = new Helicopter(scene, padX, padZ, Math.PI * 0.75);
  // the pod shares the interior manager's dust pool: one set of sprites does
  // rocket smoke, blast plume and the dust off a collapsing floor alike
  weapons = new Weapons(scene, world, { dust: world.interiors.dust });
  placeParkedCars(city);
  input.rpgMode = true;   // right-drag orbits the camera
  input.mouseLook = true; // locked pointer steers it too (settings can disable)
  orthoMgr = initOrtho();
  initSettings(applySettings);
  applySettings(getSettings());

  // warm up: build the spawn's neighbourhood before revealing the city.
  // Exceptions here used to vanish (setTimeout swallows them out of the
  // promise chain) and left the overlay spinning forever — route them out.
  let warmFrames = 0;
  await new Promise((resolve, reject) => {
    const warm = () => {
      try {
        for (let i = 0; i < 6; i++) world.update(1 / 60, player.pos);
        if (world.ready(player.pos) || ++warmFrames > 200) resolve();
        else setTimeout(warm, 0); // setTimeout, not rAF — hidden tabs still boot
      } catch (err) { reject(err); }
    };
    warm();
  });

  game.mode = 'play';
  $id('hud').classList.remove('hidden');
  const ov = $id('enter-overlay');
  ov.classList.add('fade');
  setTimeout(() => ov.remove(), 700);
}

// ---------- main loop ----------
// rAF normally; a hidden tab suspends rAF entirely AND clamps timers to 1 Hz,
// so the interval fallback covers the real elapsed time in stable 50 ms
// sub-steps (max 1 s per fire) — the sim keeps true pace while hidden (day
// clock, traffic, automated tests; same reason the Woods co-op runs a worker
// clock for hidden partners).
const clock = new THREE.Clock();
// the interval steps in whenever rAF is not running — hidden tab, or any
// future stall of the rAF chain (belt and braces: a dead loop was once a
// silent black screen)
let _lastRaf = 0;
setInterval(() => {
  if (document.hidden || performance.now() - _lastRaf > 500) tick('interval');
}, 66);

// A dead game must never be a silent black screen: the first exception the
// loop throws goes ON the screen (and the console), so "nefunguje to" always
// comes with the actual error text.
let _fatalShown = false;
function showFatal(err) {
  console.error(err);
  if (_fatalShown) return;
  _fatalShown = true;
  const d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99;background:#7a1f1f;'
    + 'color:#ffe;padding:10px 16px;font:13px/1.5 monospace;white-space:pre-wrap';
  d.textContent = '⚠ ' + (err?.stack?.split('\n').slice(0, 3).join('\n') ?? String(err));
  document.body.appendChild(d);
}

// CAREFUL: requestAnimationFrame passes a TIMESTAMP to its callback. The
// interval marker must therefore be a sentinel string compared explicitly —
// treating "truthy first argument" as "came from the interval" killed the
// rAF chain after one frame (rAF's own timestamp is truthy), which showed
// up as a single frozen frame on every visible tab while hidden-tab test
// harnesses (living off the interval path) kept passing.
function tick(src) {
  const fromInterval = src === 'interval';
  if (!fromInterval) {
    _lastRaf = performance.now();
    requestAnimationFrame(tick);
  }
  try {
    let remaining = Math.min(clock.getDelta(), fromInterval ? 1.0 : 0.05);
    while (remaining > 0) {
      const dt = Math.min(remaining, 0.05);
      remaining -= dt;
      stepGame(dt);
    }
    // render ONCE per fire, after every sub-step — rendering inside the
    // sub-step loop turned a throttled hidden tab into 20 draws per second of
    // covered time and froze the main thread solid
    const r0 = performance.now();
    // The post stack is why night lights read as LIGHT: bloom thresholds at
    // linear 1.0 ("brighter than white") and the lamp/headlight materials are
    // deliberately overbright (and toneMapped:false, so ACES can't squash them
    // back under the bar). Without this pass emissive is just a pale box.
    // God rays ride the same pass at dawn and dusk.
    const gs = getSettings();
    const wantPost = game.mode === 'play' && (gs.bloom !== false || gs.rays !== false);
    if (wantPost && !postfx) {
      postfx = new PostFX(renderer);
      postfx.setSize(renderer.domElement.width, renderer.domElement.height);
    }
    if (wantPost && postfx) {
      postfx.setSize(renderer.domElement.width, renderer.domElement.height);
      let rays = null;
      if (gs.rays !== false && sky?.sunDir) {
        const dayK = Math.min(1, Math.max(0, (sky.sun?.intensity ?? 0) / 1.4));
        if (dayK > 0.02) rays = { dir: sky.sunDir, color: sky.sun.color, strength: dayK * 0.7 };
      }
      postfx.render(scene, camera, { ssao: false, bloom: gs.bloom !== false, rays, canopy: null });
    } else {
      renderer.render(scene, camera);
    }
    if (window.__atc) {
      const ms = performance.now() - r0;
      window.__atc.frameMs += (ms - window.__atc.frameMs) * 0.1;
      window.__atc.fps = Math.round(1000 / Math.max(1, ms));
    }
    tickFpsMeter(r0);
  } catch (err) {
    showFatal(err);
  }
}

function stepGame(dt) {
  if (game.mode !== 'play') return;

  game.tod = (game.tod + dt / DAY_LENGTH) % 1;

  // world streams around whoever leads the view. `onFoot` is what gates the
  // interior streamer: rooms only matter to somebody who can walk into them,
  // and building them for a car doing 130 km/h would be a hitch for nothing.
  const focus = game.car ?? player.pos;
  world.update(dt, { x: focus.x, z: focus.z }, { onFoot: !game.car && !game.heli });

  if (game.heli) {
    // WASD flies the machine, the ARROWS work the collective and the pedals.
    // input.moveX/moveZ alias the arrows onto WASD for walking, so flight
    // reads the raw keys instead — otherwise ↑ would also pitch the nose down.
    const k = input.keys;
    const ctl = {
      // helicopter.js: pitch +1 = stick FORWARD (nose down, accelerate along
      // the heading). W must therefore be +1 — it was mapped to −1, which
      // flew the machine backwards.
      pitch: (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0),
      roll:  (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      yaw:   (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0),
      lift:  (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0),
    };
    game.heli.update(dt, ctl, world);
    player.update(dt, { input, camYaw, world });   // stays glued to the cabin
    heliSet?.(Math.min(1, (game.heli.rotorSpeed ?? 0) / 60),
      Math.min(1, Math.hypot(game.heli.vx ?? 0, game.heli.vz ?? 0) / 62));
  } else if (game.car) {
    const gas = -input.moveZ;
    driveStep(game.car, {
      gas,                                     // W forward, S reverse/brake
      steer: input.moveX,
      brake: input.keys.has('Space') ? 1 : 0,
    }, dt, world, _crashList());
    player.update(dt, { input, camYaw, world }); // keeps player glued to the car
    engineSet(Math.min(1, Math.abs(game.car.speed) / CAR.vmax), Math.abs(gas));
  } else {
    player.update(dt, { input, camYaw, world });
  }
  vehicles.update(dt);
  traffic.update(dt, player.pos, game.car);
  // ragdoll physics needs to know what can hit a pedestrian: every AI car
  // plus whatever the player is driving, refreshed per frame because the
  // player's car changes identity on every E
  peds.cars = traffic ? traffic.cars : null;
  peds.playerCar = game.car;
  peds.update(dt, focus);
  trains?.update(dt, focus);
  if (heli && !game.heli) heli.update(dt, { pitch: 0, roll: 0, yaw: 0, lift: 0 }, world);
  weapons?.update(dt, { cars: _crashList(), peds });
  updateAim(dt);
  clouds?.update(dt, camera, sky?.sunDir, sky?.nightK ?? 0);
  if (traffic) {
    const base = getSettings().traffic ?? 60;
    traffic.maxCars = Math.round(base * trafficTimeK(game.tod) * trafficPlaceK(dt, focus));
  }
  updateHorizon(dt);
  updateNightLights(dt);
  // one cheap rumble for the whole nearby fleet — never per-car audio
  if (traffic) {
    let n = 0, sum = 0;
    for (const c of traffic.cars) {
      const d = Math.hypot(c.x - focus.x, c.z - focus.z);
      if (d < 90) { n++; sum += d; }
    }
    nearbyTrafficHum?.(n, n ? sum / n : 999);
  }

  updateCamera(dt);
  placeReticle();          // after the camera: a lagging sight reads as drift
  updateSky(sky, game.tod, camera, scene);
  updateHud(dt);
}

boot().catch(err => {
  $id('enter-label').textContent = 'Chyba při načítání města: ' + err.message;
  console.error(err);
});
tick();

// dev/debug handle — lets an automated harness (or the console) inspect and
// drive the game: window.__atc.player.pos, __atc.input.keys, __atc.game.car…
window.__atc = {
  build: 'v13-interiors',   // bump on risky changes — tells us which code a tab runs
  game, input, renderer, scene, camera, stepGame,
  fps: 0, frameMs: 0,
  cam: () => ({ camDist, camPitch, camYaw }),
  get weapons() { return weapons; },
  get interiors() { return world?.interiors; },
  get postfx() { return postfx; },
  get heli() { return heli; }, get clouds() { return clouds; },
  get player() { return player; }, get world() { return world; },
  get traffic() { return traffic; }, get vehicles() { return vehicles; },
  get parked() { return parked; }, get peds() { return peds; },
  get trains() { return trains; }, get worldMap() { return worldMap; },
};
