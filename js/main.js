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
  const flat = Math.cos(pitch) * dist;
  const px = tx + Math.sin(camYaw) * flat;
  const pz = tz + Math.cos(camYaw) * flat;
  const py = ty + height + Math.sin(pitch) * dist;
  // keep the camera above ground/bridge decks
  const groundY = world.heightAt(px, pz) + 0.5;
  const want = new THREE.Vector3(px, Math.max(py, groundY), pz);
  if (!camInit) { camSmooth.copy(want); camInit = true; }
  camSmooth.lerp(want, Math.min(1, dt * 9));
  camera.position.copy(camSmooth);
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

input.onKey('KeyE', () => {
  if (game.mode !== 'play') return;
  if (game.car) {
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

// ---------- horizon: how far the world is built, and where the haze sits ----
// Two rules, and the second is the one that was broken:
//   1. From the air you see kilometres, so the streamed radius grows with
//      altitude (and the per-frame build budget with it, or the edge would
//      chase you).
//   2. The fog wall must always end INSIDE that radius. It sat at 900 m while
//      the city was only built to 720 m, so the world visibly stopped against
//      bare sky — exactly the "blue plane where nothing is loaded" report.
const GROUND_CHUNKS = 6, AIR_CHUNKS_MAX = 11;
function updateHorizon(dt) {
  if (!world || !sky) return;
  const gs = getSettings();
  const base = gs.viewChunks ?? GROUND_CHUNKS;
  const alt = game.heli ? Math.max(0, game.heli.y) : 0;
  // climb 0 → 300 m widens the view from the ground setting to the air cap
  const want = Math.round(base + (AIR_CHUNKS_MAX - base) * Math.min(1, alt / 300));
  world.viewChunks = Math.max(base, want);
  world.chunksPerFrame = alt > 20 ? 6 : 2;   // keep the edge ahead of the nose
  const radius = world.viewChunks * 120;
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
    else if (game.heli) {
      hint.innerHTML = game.heli.airborne
        ? '<kbd>↑</kbd><kbd>↓</kbd> stoupání · <kbd>WASD</kbd> let · <kbd>←</kbd><kbd>→</kbd> otáčení'
        : '<kbd>E</kbd> vystoupit · <kbd>↑</kbd> vzlet';
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
      const car = nearestEnterableCar();
      if (car) { hint.innerHTML = '<kbd>E</kbd> nastoupit'; hint.classList.remove('hidden'); }
      else hint.classList.add('hidden');
    }
  }
  minimap?.update(player.pos.x, player.pos.z, camYaw,
    traffic ? [...traffic.cars] : []);
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
  } catch (err) {
    showFatal(err);
  }
}

function stepGame(dt) {
  if (game.mode !== 'play') return;

  game.tod = (game.tod + dt / DAY_LENGTH) % 1;

  // world streams around whoever leads the view
  const focus = game.car ?? player.pos;
  world.update(dt, { x: focus.x, z: focus.z });

  if (game.heli) {
    // WASD flies the machine, the ARROWS work the collective and the pedals.
    // input.moveX/moveZ alias the arrows onto WASD for walking, so flight
    // reads the raw keys instead — otherwise ↑ would also pitch the nose down.
    const k = input.keys;
    const ctl = {
      pitch: (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0),
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
  peds.update(dt, focus);
  if (heli && !game.heli) heli.update(dt, { pitch: 0, roll: 0, yaw: 0, lift: 0 }, world);
  clouds?.update(dt, camera, sky?.sunDir, sky?.nightK ?? 0);
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
  build: 'v11-horizon',   // bump on risky changes — tells us which code a tab runs
  game, input, renderer, scene, camera, stepGame,
  fps: 0, frameMs: 0,
  cam: () => ({ camDist, camPitch, camYaw }),
  get postfx() { return postfx; },
  get heli() { return heli; }, get clouds() { return clouds; },
  get player() { return player; }, get world() { return world; },
  get traffic() { return traffic; }, get vehicles() { return vehicles; },
  get parked() { return parked; }, get peds() { return peds; },
};
