// ---- Among The City: boot + game loop + camera + HUD ----
// The integrator. Loads the Pardubice data, streams the world in around the
// spawn (the forecourt of hlavní nádraží), owns the walk/drive state machine
// (E enters and leaves cars), the chase camera, the day clock and the HUD.
// Everything heavy lives in the modules: city.js streams meshes, traffic.js
// drives the AI cars, vehicles.js does car physics, sky.js does the light.

import * as THREE from 'three';
import { SPAWN, CITY_DATA_URL, DAY_LENGTH, START_TOD, CAR_COLORS, CAR } from './config.js';
import { loadCity } from './geo.js';
import { CityWorld } from './city.js';
import { input } from './input.js';
import { Player } from './player.js';
import { Vehicles, driveStep } from './vehicles.js';
import { Traffic } from './traffic.js';
import { makeSky, updateSky, todClock } from './sky.js';
import { Minimap } from './minimap.js';

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
};

let world = null, player = null, vehicles = null, traffic = null, sky = null, minimap = null;
const parked = [];      // cars placed by us, enterable

// ---------- camera rig ----------
// Walk: orbit-follow — eases behind the player's heading, right-drag orbits
// freely, wheel zooms. Drive: chase cam with speed-based distance + FOV kick.
let camYaw = SPAWN.heading;
let camPitch = 0.30;         // radians above horizontal
let camDist = 7.5;
const camSmooth = new THREE.Vector3();
let camInit = false;
const BASE_FOV = 55;

function updateCamera(dt) {
  const drag = input.takeDrag();
  camYaw -= drag.x * 0.004;
  camPitch = Math.max(0.06, Math.min(1.15, camPitch + drag.y * 0.004));
  camDist = Math.max(4.2, Math.min(16, camDist + input.takeWheel() * 0.9));

  let tx, ty, tz, wantYaw, dist, height, fov;
  if (game.car) {
    const c = game.car;
    // ease behind the car unless the player is dragging the camera around
    wantYaw = c.heading;
    const speedK = Math.min(1, Math.abs(c.speed) / CAR.vmax);
    dist = camDist + 1.6 + speedK * 3.2;
    height = 2.4 + speedK * 1.1;
    tx = c.x; ty = (c.mesh?.position.y ?? 0) + 1.1; tz = c.z;
    fov = BASE_FOV + speedK * 13;   // the road starts to RUSH at speed
  } else {
    wantYaw = player.heading;
    dist = camDist;
    height = 1.7;
    tx = player.pos.x; ty = player.mesh.position.y + 1.5; tz = player.pos.z;
    fov = BASE_FOV;
  }
  // auto-follow: yaw eases toward the travel heading only while moving and
  // not fighting the player's own drag
  const moving = game.car ? Math.abs(game.car.speed) > 1.5 : player.speed > 0.5;
  if (moving && !input.mouse.right) {
    let d = wantYaw - camYaw;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    camYaw += d * Math.min(1, dt * (game.car ? 2.2 : 1.6));
  }

  const flat = Math.cos(camPitch) * dist;
  const px = tx + Math.sin(camYaw) * flat;
  const pz = tz + Math.cos(camYaw) * flat;
  const py = ty + height + Math.sin(camPitch) * dist;
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
  }
});

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
    const kind = ['sedan', 'hatch', 'van'][(Math.random() * 3) | 0];
    const car = vehicles.add(kind, pos.x, pos.z, h, CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0]);
    parked.push(car);
  }
}

// ---------- HUD ----------
let hintT = 0;
function updateHud(dt) {
  $id('tod-clock').textContent = todClock(game.tod);
  if (game.car) {
    $id('speed-num').textContent = Math.round(Math.abs(game.car.speed) * 3.6);
  }
  // action hint, re-checked a few times a second
  hintT -= dt;
  if (hintT <= 0) {
    hintT = 0.2;
    const hint = $id('action-hint');
    if (game.car) {
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

// ---------- boot ----------
async function boot() {
  const city = await loadCity(CITY_DATA_URL);
  world = new CityWorld(scene, city);
  sky = makeSky(scene);
  player = new Player(scene, SPAWN.x, SPAWN.z, SPAWN.heading);
  vehicles = new Vehicles(scene);
  traffic = new Traffic(city, vehicles);
  minimap = new Minimap($id('minimap'), city);
  placeParkedCars(city);
  input.rpgMode = true; // right-drag orbits the camera

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
    renderer.render(scene, camera);
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

  if (game.car) {
    driveStep(game.car, {
      gas: -input.moveZ,                       // W forward, S reverse/brake
      steer: input.moveX,
      brake: input.keys.has('Space') ? 1 : 0,
    }, dt, world);
    player.update(dt, { input, camYaw, world }); // keeps player glued to the car
  } else {
    player.update(dt, { input, camYaw, world });
  }
  vehicles.update(dt);
  traffic.update(dt, player.pos, game.car);

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
  build: 'v4-raf-fix',   // bump on risky changes — tells us which code a tab runs
  game, input, renderer, scene, camera, stepGame,
  fps: 0, frameMs: 0,
  get player() { return player; }, get world() { return world; },
  get traffic() { return traffic; }, get vehicles() { return vehicles; },
  get parked() { return parked; },
};
