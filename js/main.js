// ---- Among The City: boot + game loop + camera + HUD ----
// The integrator. Loads the Pardubice data, streams the world in around the
// spawn (the forecourt of hlavní nádraží), owns the walk/drive state machine
// (E enters and leaves cars), the chase camera, the day clock and the HUD.
// Everything heavy lives in the modules: city.js streams meshes, traffic.js
// drives the AI cars, vehicles.js does car physics, sky.js does the light.

import * as THREE from 'three';
import { SPAWN, CITY_DATA_URL, CAR_COLORS, CAR } from './config.js';
import { loadCity, chunkKey } from './geo.js';
import { CityWorld } from './city.js';
import { input } from './input.js';
import { Player, worldSeatAnchor } from './player.js';
import { Vehicles, driveStep, lampMats, carLabel, carSubtitle, eyeAnchor,
  attachCabin, detachCabin, setVehicleEventSink } from './vehicles.js';
import { Traffic } from './traffic.js';
import { makeSky, updateSky, todClock } from './sky.js';
import { Minimap } from './minimap.js';
import { initAudio, sfx, sfxAt, setListener, engineVoices, engineVoicesStop,
  engineStart, engineStop, engineSet, tireSet, setVolume,
  heliStart, heliStop, heliSet, jetStart, jetStop, jetSet,
  windStart, windStop, windSet, windLoad, roadWindSet, roadWindStop,
  ambientStart, nearbyTrafficHum } from './audio.js';
import { initSettings, getSettings } from './settings.js';
import { initOrtho } from './ortho.js';
import { Pedestrians } from './pedestrians.js';
import { PostFX } from './postfx.js';
import { Helicopter, makeHelipad } from './helicopter.js';
import { Grass } from './grass.js';
import { buildAirfields, nearestParked } from './airfield.js';
import { Fighter } from './aircraft.js';
import { Clouds } from './clouds.js';
import { WorldMap } from './worldmap.js';
import { Trains } from './trains.js';
import { Weapons } from './weapons.js';
import { SpeedStreaks } from './speedfx.js';
import { MISSILE } from './config.js';
import { showMenu } from './menu.js';
import { connectCity, queueEvent, getPlayerName, CityNetWS } from './netcity.js';
// ---- the co-op wave, wired in here and nowhere else ----
// worldclock: the day is a pure function of the shared wall clock now, so two
//   players never run two different afternoons (js/worldclock.js explains why).
// identity:   one uid → one look, for our own avatar and for the HUD dot.
// netvehicles: PROXY cars for the peers, the only honest answer to "which car
//   is he in" — see F8 below.
// netui:      the HUD that can say "you are alone now" out loud.
import { tod, setEpoch, setSoloTime } from './worldclock.js';
import { localUid, strHash } from './identity.js';
import { makeGhostCars } from './netvehicles.js';
import { makeNetUI } from './netui.js';

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
  // The day clock is READ-ONLY here now. It used to be a local accumulator
  // (`game.tod += dt / DAY_LENGTH`), which meant every client ran its own
  // afternoon: a minute of extra loading put two players a permanent in-game
  // hour apart, and since traffic density is scaled by the hour (0.06 at 03:00
  // against 1.45 at 16:00) they could not even have matching traffic in
  // principle. worldclock.tod() derives it from the shared wall clock instead,
  // so there is nothing to seed, nothing to send and nothing to drift. The
  // getter stays because the debug handle and a dozen call sites read it —
  // but NOTHING may write it, hence no setter.
  get tod() { return tod(); },
  mode: 'boot',         // boot → play
  car: null,            // the car the player is driving (null = on foot)
  heli: null,           // the helicopter being flown (null = not flying)
  jet: null,            // …and the Gripen (they are never both set)
};

let world = null, player = null, vehicles = null, traffic = null, sky = null, minimap = null;
let peds = null;
let postfx = null;   // bloom + god rays — what makes lamps and headlights GLOW
let clouds = null;                // the sky to fly the machines through
const _earDir = new THREE.Vector3();
const _voiceCars = [];            // reused every frame — the pool never keeps it
const VOICE_SCAN2 = 140 * 140;    // m² — wider than the pool's own 95 m cutoff,
                                  // so a car arriving fast is already a candidate
// Every machine parked at Pardubice and at Prague. `heli` stays as the one
// the player last had business with, because a lot of code below asks about
// "the helicopter" and only ever means the one within arm's reach.
let helis = [], fighters = [], heli = null;
// the throttle lever's position, kept across frames — a jet's thrust is set,
// not held down, and it must survive letting go of the key
let jetThrottle = 0;
let jetNearest = null;   // the Gripen within reach, for the hint
let jetWasAir = false;   // edge detector for touchdown
let jetBraking = false;  // …and for the brakes, so the sample fires once
let worldMap = null;   // the full-region map on M, and the waypoint it owns
let trains = null;     // České dráhy on the real 532 km network
let weapons = null;  // the rocket pod under that machine, and what it does to walls
let streaks = null;  // the air, showing itself past 100 km/h
let aimMark = null;  // the ring on the ground where the next rocket would land
let _aimT = 0;
const parked = [];      // cars placed by us, enterable RIGHT NOW
// …and the deterministic spawn fleet, in spawn order, never spliced. `parked`
// is a working set (a car leaves it when somebody gets in, a stolen taxi joins
// it when somebody gets out), so its indices are a fact about THIS session and
// useless as a name. This one is the fleet placeParkedCars() built from the
// map, so parkedFleet[3] is the same physical Škoda on every client in the
// room — the same property that makes helis[i] a usable claim key.
const parkedFleet = [];

// ---------- multiplayer plumbing (all null / empty in single player) --------
// `ghosts` is the peers' vehicle fleet — proxies we own, keyed by uid. `ui` is
// the co-op HUD. Both are created before the socket, because the HUD has to be
// able to report the connection FAILING, and because a null ghost fleet would
// mean every `ghosts?.` site below silently doing nothing in single player
// where it should simply be cheap.
let ghosts = null;      // makeGhostCars(vehicles) — built in boot()
let ui = null;          // makeNetUI() — built in start(), before the socket
// uid → the `veh` descriptor object we last handed to ghosts.sync. netcity
// replaces r.state (and with it r.state.veh) wholesale on every packet, so
// object IDENTITY is an exact "is this a new packet?" test — which matters,
// because sync() resets the ghost's dead-reckoning age and calling it every
// frame would quietly disable extrapolation between packets.
const _ghostVeh = new Map();
// uid → index into `helis` that peer has claimed (F22). One machine, one pilot.
const _heliClaims = new Map();
let _heliClaimT = 0;    // s until we re-announce our own claim (late joiners)
let grass = null;       // the ring of instanced tufts around the camera
let _myHeliClaim = -1;  // index of the helicopter WE hold, or -1
// uid → index into `parkedFleet` that peer is driving. Same mechanism, and for
// the same reason the helicopter needed one — see claimParked() below.
const _parkClaims = new Map();
let _parkClaimT = 0;
let _myParkClaim = -1;

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
const CAM_DIST_0 = 14;      // ⌘0 comes back here
let camDist = CAM_DIST_0;
const camSmooth = new THREE.Vector3();
let _camSpeedK = 0;   // eased |speed|/vmax for boom+FOV — see updateCamera
let _camPullT = 1;    // eased occlusion boom factor (1 = full length)
let camInit = false;
const BASE_FOV = 55;

// ---------- first person (C) ----------
// A head in a seat, not a boom. It only means anything from inside a car:
// walking, the model IS the game, and in a helicopter the machine and the sky
// around it are the whole point of the shot. The eye point comes from
// vehicles.js eyeAnchor(), i.e. exactly where the visible rider's head is —
// so what you look out of and what a peer sees you look out of are one place.
let fpView = false;
const FP_FOV = 74;         // wide enough that the dash and both mirrors stay in
const FP_YAW = 1.75;       // ±100° of look-around: a neck, not a turret
const FP_PITCH_UP = 0.55;  // roof lining
const FP_PITCH_DN = 0.75;  // the pedals
let fpPitch = 0;           // radians either side of the horizon — FP's own axis
// Near plane belongs to the camera MODE, not to the horizon — updateHorizon()
// owns `far` and defers to this. 0.14 was 3.6× the depth-buffer cost of 0.3
// (24-bit integer depth against far = 5200: ~12 cm of error at 1 km becomes
// ~43 cm, i.e. z-fighting on distant façades) and 0.5 clipped things that are
// genuinely that close — a remote passenger's shoulder, another car's wing
// folded into the cabin by a crash. 0.3 is now also a CONTRACT with the cabin
// vehicles.js builds: cabinSpec() sizes the door cards against exactly this
// number (the panel proper stops at the doorline ~0.39 m out, only a thin
// sill strip goes nearer). Moving it means re-reading that comment first.
const CAM_NEAR = 0.5, FP_NEAR = 0.3;
let camNear = CAM_NEAR;
// Hiding our own model is done with a LAYER, not mesh.visible: layers filter
// per camera, so the mesh stays in the graph, stays parented to the car, keeps
// its transform, and every other consumer (and every peer, who rebuilds our
// avatar from network state and never touches this object) sees it unchanged.
const FP_HIDE_LAYER = 2;   // nothing else in the project uses layers at all
let _selfHidden = false;

// The car whose seat the local eye sits in. game.car is only ever set for the
// driver, so a front passenger riding along with somebody else at the wheel
// resolves through player.inCar instead — a heli seat is a different anchor
// set and a different framing job, so it is refused here.
function fpVehicle() {
  if (game.car) return game.car;
  const v = player?.inCar;
  return v && v.rotorSpeed === undefined ? v : null;
}

// Re-derived from live state every frame rather than latched, so anything that
// ends first person — E, a wreck, losing the seat to the net layer — hands the
// model back on the next frame without needing its own cleanup path.
function fpHideSelf(hide) {
  if (hide === _selfHidden || !player) return;
  _selfHidden = hide;
  player.mesh.traverse((o) => o.layers.set(hide ? FP_HIDE_LAYER : 0));
}

// ---- the interior, grafted onto exactly the car being looked out of ----
// WHEN, not whether: on the C toggle, not on boarding. Three reasons, in
// order of weight. (1) The cabin is not culled away when you are outside the
// car — the glass is transparent and the trim is FrontSide facing IN, so a
// dashboard left attached shows through the windscreen from the chase cam as
// a hollow shell. (2) Most drives never press C, and the parked/traffic pool
// runs to ~500 cars: attaching on boarding would be a dozen draw calls bought
// for nothing on every single E. (3) It is nearly free to do it late anyway —
// vehicles.js caches the interior GEOMETRY per kind beside the exterior set,
// so the first C in an Octavia builds it once and every C after that is just
// `new THREE.Mesh` a dozen times over geometry that already exists.
//
// Like fpHideSelf this is re-derived from live state every frame rather than
// latched at the event, which is what makes the teardown total: stepping out
// at 100 km/h, the car exploding, the net layer taking the seat, the vehicle
// streaming out from under the player — every one of those makes fpVehicle()
// return null on the next frame and the graft comes off there. No exit path
// has to remember to clean up, so none of them can forget. The one thing that
// WOULD escape it is the frame loop stopping with a car still under the eye:
// game.mode is written exactly once today (boot → 'play', never back), so the
// only exit from the session is a reload that takes the whole scene with it —
// but a future pause screen or "back to menu" must call fpCabin(null) itself.
let _cabinCar = null;
function fpCabin(car) {
  if (car === _cabinCar) return;
  // detachCabin only touches car.mesh.userData, so a car that has already
  // been removed from the scene (despawn, wreck cleanup) is still safe to
  // hand back here — it just drops a reference that was about to die anyway.
  if (_cabinCar) detachCabin(_cabinCar);
  _cabinCar = car;
  if (car) attachCabin(car);
}

// blast shake: high-frequency positional jitter, decayed by weapons.js. It
// rides on the FINAL camera position rather than on the target, so a launch
// nudges the frame and a detonation slams it without the follow cam fighting
// back — and first person gets the same hit for free.
function camShake() {
  const sh = weapons?.shake ?? 0;
  if (sh <= 0.001) return;
  const t = performance.now() * 0.06;
  camera.position.x += Math.sin(t * 1.7) * sh * 0.42;
  camera.position.y += Math.sin(t * 2.3 + 1.1) * sh * 0.34;
  camera.position.z += Math.cos(t * 1.9 + 0.4) * sh * 0.42;
}

// FOV eases (a hard cut on the C toggle is nauseating, and the speed kick has
// always eased); near is a discrete projection property and snaps.
function applyLens(dt, fov, near) {
  camNear = near;
  let dirty = false;
  if (camera.near !== near) { camera.near = near; dirty = true; }
  if (Math.abs(camera.fov - fov) > 0.2) {
    camera.fov += (fov - camera.fov) * Math.min(1, dt * 4);
    dirty = true;
  }
  if (dirty) camera.updateProjectionMatrix();
}

let _lastLookT = -9; // when the mouse last steered — pauses auto-follow
function updateCamera(dt) {
  const drag = input.takeDrag();
  // pointer-locked mouse look uses a finer touch than right-drag
  const sens = input.locked ? 0.0026 : 0.004;
  if (drag.x || drag.y) _lastLookT = performance.now() * 0.001;
  const fpCar = fpView ? fpVehicle() : null;
  // A seat is lost without anybody pressing E often enough to matter: the car
  // is wrecked, the net layer reclaims the slot, the vehicle streams out. The
  // mode drops itself here instead of in each of those paths, so first person
  // can never come back uninvited on the NEXT car the player gets into.
  if (fpView && !fpCar) fpView = false;
  camYaw -= drag.x * sens;
  // Pitch has two homes. The boom's is an ELEVATION above the target that
  // never points at the sky; the driver's is a look angle either side of the
  // horizon. Sharing one variable made C flip you straight into the headliner.
  if (fpCar) fpPitch = Math.max(-FP_PITCH_DN, Math.min(FP_PITCH_UP, fpPitch - drag.y * sens));
  else camPitch = Math.max(0.06, Math.min(1.15, camPitch + drag.y * sens));
  // consumed in BOTH modes even though first person has no boom: these are
  // one-shot getters, and a notch left sitting in the accumulator would fire
  // the chase cam across the street the moment C switched back.
  if (input.takeZoomHome()) camDist = CAM_DIST_0;
  camDist = Math.max(5, Math.min(26, camDist + input.takeWheel() * 1.4));
  fpHideSelf(!!fpCar);
  fpCabin(fpCar);

  if (fpCar) {
    const c = fpCar;
    // Look is an OFFSET from the nose, not a free orbit: the head turns with
    // the car, so through a roundabout you keep watching the same point ahead
    // instead of the world sliding past a fixed compass bearing. camYaw stays
    // the single source of truth in both modes — the minimap and the waypoint
    // compass read it and neither knows first person exists.
    let off = Math.atan2(Math.sin(camYaw - c.heading), Math.cos(camYaw - c.heading));
    const lookIdle = performance.now() * 0.001 - _lastLookT > 1.6;
    // same rule as the chase cam's auto-follow: the head drifts back to the
    // road once the hand lets go, but only while actually driving somewhere
    if (Math.abs(c.speed) > 1.5 && !input.mouse.right && lookIdle)
      off -= off * Math.min(1, dt * 2.2);
    camYaw = c.heading + Math.max(-FP_YAW, Math.min(FP_YAW, off));

    // Same local→world transform worldSeatAnchor() uses, one seat higher up.
    // The height is read off the MESH, not off car.y, so the offroad judder
    // (±5 cm, written by vehicles.update a few calls earlier this frame) shakes
    // the head too. The body group's roll and pitch are deliberately NOT
    // applied: leaning the horizon into every corner is where car sims make
    // people ill, and lookAt keeps the up vector world-vertical anyway.
    const a = eyeAnchor(c, game.car === c ? 0 : (player.seat ?? 1));
    const ch = Math.cos(c.heading), sh = Math.sin(c.heading);
    const ex = c.x + a.x * ch + a.z * sh;
    const ey = (c.mesh?.position.y ?? c.y ?? 0) + a.y;
    const ez = c.z - a.x * sh + a.z * ch;
    // No camSmooth, no wall marching, no ground clamp. A 9/s lerp is ~0.1 s of
    // lag, which at 100 km/h parks the eye three metres behind the seat — on
    // the back bench, or outside the car. The interior boxes are not a cabin,
    // and heightAt() under a bridge deck would shove the head through the roof.
    camera.position.set(ex, ey, ez);
    // keep the boom's memory glued to the seat so switching back EASES out of
    // the car instead of swooping in from wherever the chase cam last was
    camSmooth.copy(camera.position); camInit = true;
    camShake();
    const cp = Math.cos(fpPitch);
    camera.lookAt(ex - Math.sin(camYaw) * cp * 12,
                  ey + Math.sin(fpPitch) * 12,
                  ez - Math.cos(camYaw) * cp * 12);
    // A much gentler speed kick than the chase cam's: at 74° the edges of the
    // frame already move fast, and widening further from inside a cabin reads
    // as the windscreen stretching rather than as speed. CAR.vmax stays the
    // yardstick here even though engineSet() no longer uses it — the lens is
    // tuned to a SPEED (137 km/h is where the rush is fully sold), not to a
    // fraction of whatever the current car happens to be capable of. Judging
    // it per kind would mean a Fabia flat out looked slower than a BMW at the
    // same 200 km/h, which is exactly backwards.
    applyLens(dt, FP_FOV + Math.min(1, Math.abs(c.speed) / CAR.vmax) * 5, FP_NEAR);
    return;
  }

  let tx, ty, tz, wantYaw, dist, height, fov, pitchK = 1;
  if (game.car) {
    const c = game.car;
    // ease behind the car unless the player is dragging the camera around
    wantYaw = c.heading;
    // same reasoning as the FP lens above: an absolute speed yardstick, not
    // the kind's own top speed
    // EASED, not instantaneous: a hitch frame or a collision scrub dips
    // |speed| for a frame or two, and an instant speedK pumped the boom 3 m
    // in and back out — the "camera zooms for a moment" stutter. 3/s catches
    // real acceleration fine and ignores anything shorter than a blink.
    const speedK0 = Math.min(1, Math.abs(c.speed) / CAR.vmax);
    _camSpeedK += (speedK0 - _camSpeedK) * Math.min(1, dt * 3);
    const speedK = _camSpeedK;
    dist = camDist + 1.6 + speedK * 3.2;
    height = 2.4 + speedK * 1.1;
    tx = c.x; ty = (c.mesh?.position.y ?? 0) + 1.1; tz = c.z;
    fov = BASE_FOV + speedK * 13;   // the road starts to RUSH at speed
  } else if (game.jet) {
    // A Gripen crosses a 120 m chunk in a sixth of a second, so the camera
    // hangs much further back than the helicopter's and widens hard with
    // speed — otherwise the airframe fills the frame and you cannot see what
    // you are about to fly into.
    const j = game.jet;
    wantYaw = j.heading;
    const speedK = Math.min(1, j.speed / 340);
    dist = camDist + 14 + speedK * 26;
    height = 3.2 + speedK * 2.4;
    pitchK = 0.5;
    tx = j.x; ty = j.y + 2.2; tz = j.z;
    fov = BASE_FOV + speedK * 22;     // the world starts to STREAK past
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
    // player.y, NOT mesh.position.y: once boarding parents the mesh to a
    // vehicle its position is SEAT-LOCAL, and a passenger riding over a bridge
    // deck would drag the camera down to the riverbed. player.y is world space
    // in every state — walking, on a staircase, falling, or sitting.
    tx = player.pos.x; ty = player.y + 1.5; tz = player.pos.z;
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
  // FLYING IS NEVER INDOORS. modelAt() is a 2-D lookup, so overflying a
  // building at 300 m "found" its interior and collapsed a 40 m boom to 3.4 m,
  // then released it on the far side — the camera lunging in and out over
  // every block, which reads as the picture juddering rather than as a camera
  // bug. The helicopter was already excluded; the jet was not, and the jet is
  // the one that crosses a block every fifth of a second.
  const flying = !!(game.heli || game.jet);
  const indoors = !flying && !game.car && !!world.interiors?.modelAt(tx, tz);
  if (indoors) dist = Math.min(dist, 3.4);
  const flat = Math.cos(pitch) * dist;
  let px = tx + Math.sin(camYaw) * flat;
  let pz = tz + Math.cos(camYaw) * flat;
  let py = ty + height * (indoors ? 0.25 : 1) + Math.sin(pitch) * dist;
  // …and then it still has to not be inside a wall. March the boom back in
  // from full length until the camera sits in air: the same trick every
  // third-person game uses, done against the interior's own boxes rather than
  // a raycast, because the boxes are already in a spatial hash.
  // MIN_T is a floor, not an option: collapsing the boom onto the target
  // makes lookAt() aim the camera at its own position, which renders as one
  // flat grey wall. 0.2 of a 3.4 m boom is 0.7 m, close enough to clear a
  // 1.5 m stairwell and still be a camera.
  //
  // The march target is computed every frame, but the boom FACTOR is eased:
  // in fast (a wall is a wall — clipping through it is worse than a jolt),
  // out slowly (nothing justifies leaping 4 m backwards in one frame). The
  // old code also re-tested with a SMALLER pad (0.24) than the entry test
  // (0.28), so grazing contact flickered between full boom and an 18 % cut —
  // the direct source of the reported zoom-pop. The march pad is now the
  // larger one, so a spot that trips the entry test also holds the pull.
  let wantT = 1;
  if (!flying && world.interiors?.occupied(px, py, pz, 0.28)) {
    const bx = px - tx, by = py - ty, bz = pz - tz;
    const MIN_T = 0.2;
    let t = 0.82;
    for (; t > MIN_T; t -= 0.05)
      if (!world.interiors.occupied(tx + bx * t, ty + by * t, tz + bz * t, 0.32)) break;
    wantT = Math.max(MIN_T, t);
  }
  _camPullT += (wantT - _camPullT) * Math.min(1, dt * (wantT < _camPullT ? 10 : 1.6));
  if (_camPullT < 0.999) {
    px = tx + (px - tx) * _camPullT;
    py = ty + (py - ty) * _camPullT;
    pz = tz + (pz - tz) * _camPullT;
  }
  // keep the camera above ground/bridge decks — `py` as the near hint, so a
  // viaduct deck OVERHEAD no longer wins and pops the camera onto the bridge
  const groundY = world.heightAt(px, pz, py) + 0.5;
  const want = new THREE.Vector3(px, indoors ? py : Math.max(py, groundY), pz);
  if (!camInit) { camSmooth.copy(want); camInit = true; }
  // dt is CAPPED for the smoothing: a 150 ms hitch frame used to saturate the
  // lerp and snap the camera the whole trailing distance in one step — the
  // other half of the zoom-pop. The camera pays a hitch back over the next
  // few frames instead of all at once.
  camSmooth.lerp(want, Math.min(1, Math.min(dt, 0.045) * 9));
  camera.position.copy(camSmooth);
  camShake();
  camera.lookAt(tx, ty, tz);
  applyLens(dt, fov, CAM_NEAR);
}

// ---------- what the player can actually see ----------
// traffic.js and pedestrians.js both refuse to create or destroy an actor the
// player could catch doing it, and both ask the same question through the same
// setViewer() contract (pedestrians.js adopted traffic.js's signature verbatim,
// down to the 0.42 rad margin). One snapshot therefore feeds both.
//
// Both modules accept `{ camera, fogFar }` and will pull the numbers out
// themselves. We hand over the numbers instead, for two reasons. The cheap one:
// getWorldDirection() runs once a frame rather than twice. The real one: the
// two modules then judge the cone from BIT-IDENTICAL inputs, so a car and the
// pedestrian stepping in front of it can never disagree about where the screen
// ends — and the fov is eased every frame (applyLens), so a half-degree
// difference between two reads is not hypothetical.
//
// TIMING — this reads the camera as updateCamera() left it at the END of the
// previous frame. updateCamera() must run after the vehicles have moved, which
// puts it well below traffic.update(); hoisting it would change what the
// clouds, the reticle and the sky see, for a lag of one frame on a yaw. That
// lag is exactly what VIEW_MARGIN is for: 0.42 rad of slack absorbs a 24°
// slew, and a mouse whip fast enough to beat it is a frame in which nobody was
// reading the picture anyway.
const _viewDir = new THREE.Vector3();
// Mutated in place, never reallocated — this runs 60×/s and both callees copy
// what they need out of it synchronously, inside setViewer().
const _viewer = { x: 0, z: 0, dirX: 0, dirZ: 1, fovRad: 1.05, aspect: 16 / 9, fogFar: 900 };
function viewerState() {
  // Until updateCamera() has placed it once, the camera sits at the origin
  // looking down −Z while the player stands kilometres away in Pardubice.
  // Handing that over would protect a cone over empty fields AND declare
  // everything around the player unobserved — on precisely the frame where the
  // whole fleet is minted. "No camera" is the honest answer until there is one;
  // both modules have a documented, safe meaning for null (traffic falls back
  // to v8, pedestrians to a 110 m sphere watched in every direction).
  if (!camInit) return null;
  camera.getWorldDirection(_viewDir);
  _viewer.x = camera.position.x;
  _viewer.z = camera.position.z;
  _viewer.dirX = _viewDir.x;
  _viewer.dirZ = _viewDir.z;
  // Read from the camera, not from camYaw/camPitch: first person sets
  // camera.position/lookAt directly and never touches the boom, and the aim in
  // FP is camYaw + fpPitch rather than camYaw alone. The camera's own world
  // matrix is the one thing true in every mode — chase, driver's seat,
  // helicopter, jet.
  //
  // three.js keeps fov in DEGREES, and applyLens eases it every frame (55°
  // walking, 68° at speed, 74–79° from the driver's seat), so it cannot be
  // cached at boot.
  _viewer.fovRad = camera.fov * Math.PI / 180;
  _viewer.aspect = camera.aspect;
  // The fog wall, which is where a fade-in stops being catchable — and it is
  // not a constant. updateHorizon() stretches it with the streamed radius
  // (~634 m on the ground, past 3 km from a helicopter) and sky.js pulls it in
  // at night. Both modules clamp it into their own range, so pass it raw.
  _viewer.fogFar = scene.fog?.far ?? 900;
  // A camera looking dead vertical has no horizontal bearing and the cone is
  // meaningless. Unreachable today (camPitch tops out at 1.15 rad, fpPitch at
  // 0.75), but say it here rather than letting both modules discover it.
  if (!(Math.abs(_viewer.dirX) + Math.abs(_viewer.dirZ) > 1e-6)) return null;
  return _viewer;
}

// How far ahead of the player the streamer should be looking. Only the fast
// machines get a lead worth having: on foot or in a car the loader is never the
// bottleneck, and a lead there would only blur which chunks count as "near".
const LEAD_S = 2.0;          // seconds of travel to look ahead
const LEAD_MAX = 1600;       // …capped, or Mach 2 would stream a different town
const _lead = { x: 0, z: 0 };
function leadFocus(focus) {
  _lead.x = focus.x; _lead.z = focus.z;
  const f = game.jet ?? game.heli;
  if (!f) return _lead;
  const v = game.jet ? game.jet.speed : Math.hypot(f.vx ?? 0, f.vz ?? 0);
  if (v < 30) return _lead;                    // hovering or taxiing: look here
  // The lead may never push the player OUT of the built area — that would
  // trade a hole in front for a hole underneath, which is far worse. The
  // streamer builds `viewChunks` cells around the focus, so keep the offset
  // to a fraction of that radius whatever the speed asks for.
  const built = (world?.viewChunks ?? 6) * 120;
  const d = Math.min(v * LEAD_S, LEAD_MAX, built * 0.6);
  // heading convention: dir(h) = (−sin h, −cos h)
  _lead.x = focus.x - Math.sin(f.heading) * d;
  _lead.z = focus.z - Math.cos(f.heading) * d;
  return _lead;
}

// How hard to smear the frame. Speed alone is not the input: 130 km/h in a car
// is a rush and 130 km/h in a Gripen is taxiing, so each machine gets its own
// band — where the smear starts, where it maxes out, and how far it goes.
//
// [onset m/s, full m/s, peak uv]. The car band is the one that matters most in
// practice because it is where most of the game is played: it opens at 54 km/h
// and is fully out by 150, which puts real blur on an ordinary fast drive. The
// first cut squared the ramp and opened at 79 km/h, which made 100 km/h worth
// 0.003 uv — arithmetically present, visually nothing.
// Softened for the car after road-testing: 0.05 at 120 km/h read like 400. The
// car is the machine you spend the most time in and the one whose real-world
// speeds everyone has a calibrated feel for, so it gets the gentlest curve of
// the three.
const MB_CAR = [18, 46, 0.026];
const MB_HELI = [25, 60, 0.04];
const MB_JET = [110, 600, 0.085];
// x/y weight of the smear. A car's world streams past sideways; a jet at Mach 2
// is moving so fast that the whole frame goes, so it gets closer to round.
const MB_ANISO_GROUND = [1, 0.45];
const MB_ANISO_JET = [1, 0.8];
function motionBlurAmount() {
  let v = 0, band = null;
  if (game.jet) { v = game.jet.speed; band = MB_JET; }
  else if (game.car) { v = Math.abs(game.car.speed); band = MB_CAR; }
  else if (game.heli) { v = Math.hypot(game.heli.vx ?? 0, game.heli.vz ?? 0); band = MB_HELI; }
  else return 0;
  const [on, full, peak] = band;
  const t = Math.min(1, Math.max(0, (v - on) / (full - on)));
  // pow 1.5, not 2: still nothing at a crawl, but the middle of the band —
  // which is where you actually drive — gets a third of the effect rather
  // than a tenth of it
  return Math.pow(t, 1.5) * peak;
}

// ---------- ghost cars: things to look at, and nothing else ----------
// traffic.js keeps drawing a car whose shared slot has already rolled over, so
// that it can drive off the screen instead of blinking out of it (see the v9
// header there). Such a GHOST is by construction a car NO PEER HAS: on his
// machine that slot string already names the next generation's car, standing
// somewhere else. traffic.cars holds both kinds, so anything that reads that
// Set has to decide which it meant.
//
// The rule: a ghost may be seen and heard. It may not touch shared state.
//   · running a pedestrian over writes the ped's SHARED slot (`held`, the
//     ragdoll, the corpse, the decal) — a ghost doing it kills a walker on one
//     screen and leaves him strolling on the other, for up to a whole TRIP_T;
//   · crashing writes the player's own car, whose pose every peer is watching
//     — bouncing off thin air is the desync everybody actually sees;
//   · boarding one hands the player a car with no shared identity, and the
//     steal is not even broadcast (slotKey() is null for a ghost), so the peer
//     goes on driving his own generation through the one you are sitting in.
// Left deliberately ghost-inclusive, because they only move pixels: the
// minimap, the traffic hum, and the rocket pod (a rocket must not fly through
// a car body you can see — and the detonation is computed once here and then
// shipped through world.applyHit, so the peer never recomputes it and cannot
// disagree about the hole).
//
// slotKey() is the canonical question rather than car.ai.ghost: it is the
// public method whose documented contract is exactly "null = the peer has no
// such car", and it also covers a car whose schedule has been torn off.
// A ghost is a car the shared schedule has finished with but that is still on
// screen, so it keeps driving locally with no shared identity. Excluding it
// from the door and from the crash list is right ONLY when there is a peer:
// the whole reason is that on his machine there is nothing there, so boarding
// it or bouncing off it would desync two cities.
//
// In single player there is no other machine, and the exclusion turns into the
// bug the user reported — a car appears in front of you that you cannot get
// into and that your bumper passes straight through. So: no session, no ghosts.
function isGhostCar(c) { return net && traffic ? traffic.slotKey(c) === null : false; }

// The AI fleet minus the ghosts — every car both clients agree exists.
// Rebuilt per call: traffic.cars churns every frame and callers hold the
// result only for the length of one update.
function sharedCars() {
  const out = [];
  if (traffic) for (const c of traffic.cars) if (!isGhostCar(c)) out.push(c);
  return out;
}

// ---- how high is the aircraft, really ----------------------------------
// ABOVE GROUND, not above the sea. `flier.y` became an absolute altitude the
// day the terrain landed, and every reader of it kept treating it as height —
// so a helicopter PARKED in Pardubice reported 221 m and one on the Kudlov
// ridge above Zlín 385. The streamer read that as "we are flying" and opened
// every ring to its cap before the rotor had turned: 3 249 chunks built while
// standing still, and the frame rate that goes with them. The lens flare
// believed it too, and burned at altitude strength on the ground.
function aglOf(flier) {
  if (!flier) return 0;
  const g = world?.terrain?.heightAt(flier.x, flier.z) ?? 0;
  return Math.max(0, flier.y - g);
}

// How much lens flare. On the ground the sun is fighting haze, buildings and
// trees, so it is a hint; in the air there is nothing between the lens and it,
// which is exactly when a flare sells the altitude. It also needs the sun to
// actually be UP — postfx already refuses when it is behind the camera.
function flareAmount() {
  const flier = game.jet ?? game.heli;
  const alt = aglOf(flier);
  const air = Math.min(1, alt / 900);           // full effect by ~900 m
  return 0.16 + 0.75 * air;
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
    // a ghost is on borrowed time and belongs to nobody — the door is locked
    if (isGhostCar(c)) continue;
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

// E is a STATE MACHINE now, not a teleport (player.js owns it): boarding
// walks the figure to the door, slides it into the seat over ~0.55 s, and
// only the onSeated callback flips game.car/game.heli — so the chase camera
// stays in walk mode until the body is actually in the chair. Exiting hands
// control back immediately and plays a ~0.35 s step-out.
//
// SEAT REGISTRY — the multiplayer seam. Every enterable vehicle lazily grows
// `veh.seats = [occupant0, occupant1, …]` (created by player.boardVehicle or
// by whoever claims first): slot 0 is the driver/pilot, slot 1 the front
// passenger (a heli explicitly seats these two). Claiming a seat = writing
// any truthy occupant into its slot; the net layer seats REMOTE players by
// claiming a slot and placing their avatar at window.__atc.seatAnchor(veh, i)
// — the world-space anchor exported below. Locally, E takes the lowest free
// seat: the driver's if it's open, the passenger's if a remote player is
// already driving.
const freeSeat = (veh) => !veh.seats?.[0] ? 0 : !veh.seats?.[1] ? 1 : -1;

// ---------- F22: one helicopter, one pilot ----------------------------------
// `helis` holds ONE object per machine and it is a purely local simulation, so
// before this there was no lock at all: two players could each press E on the
// Pardubice machine and each fly "it", ending up flying two different aircraft
// that both claim to be the same one. `seats` is no help — it is a local array
// nobody else writes.
//
// The claim is an EVENT, not a lease from an authority: the pilot announces
// `heli_claim {i, on}` and re-announces every CLAIM_REANNOUNCE_S so a player
// who joined after take-off learns about it too. That makes it advisory (a
// simultaneous double-press within one round trip still double-books) and
// self-healing (a claim from a peer who has gone quiet is dropped with their
// avatar). A hard lock would need a server that knows what a helicopter is; an
// advisory one needs nothing and covers every case that actually happens.
//
// The INDEX is the identity. buildAirfields() walks a static AIRFIELDS table,
// so helis[2] is the same machine on every client in the room, forever — which
// is exactly the property vehId()'s colour hash never had.
const CLAIM_REANNOUNCE_S = 5;

// who (if anyone) holds machine `i` — a peer uid, or null
function heliHolder(i) {
  for (const [uid, hi] of _heliClaims) if (hi === i) return uid;
  return null;
}
// …and the same question for an object, which is what the E handler has
function heliClaimedByPeer(h) {
  if (!h || _heliClaims.size === 0) return null;
  const i = helis.indexOf(h);
  return i < 0 ? null : heliHolder(i);
}

// Announce (on=1) or release (on=0) our own claim. Idempotent and free in
// single player: queueEvent's outbox is capped and drained by nobody.
function claimHeli(h, on) {
  const i = on ? helis.indexOf(h) : _myHeliClaim;
  if (i < 0) return;
  _myHeliClaim = on ? i : -1;
  _heliClaimT = on ? CLAIM_REANNOUNCE_S : 0;
  if (net) queueEvent('heli_claim', { i, on: on ? 1 : 0 });
}

// A peer's claim landed (or was dropped). The local machine is HIDDEN while
// somebody else flies it, because they are simultaneously flying a ghost copy
// of it built by netvehicles — leaving both on screen would show the same
// helicopter twice, once flying and once parked on its pad.
function setHeliClaim(uid, i, on) {
  if (!Number.isInteger(i) || i < 0 || i >= helis.length) return;
  if (on) _heliClaims.set(uid, i);
  else if (_heliClaims.get(uid) === i) {
    _heliClaims.delete(uid);
    // Put the machine back where the pilot left it rather than teleporting it
    // home: their ghost is about to disappear from that spot and the real one
    // reappearing 8 km away on its pad reads as the world resetting itself.
    const p = ghosts?.pose(uid);
    const h = helis[i];
    // …but NEVER the machine we are flying ourselves. The claim is advisory —
    // the comment above admits two players can double-book one helicopter
    // inside a round trip — and in that race the loser's release would snatch
    // the aircraft out from under the winner mid-air: position, heading and
    // airborne all overwritten with a peer's landing spot. A double-booked
    // machine has to be double-booked visually; it must not fall out of the sky.
    if (h && h !== game.heli && p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      h.x = p.x; h.z = p.z; h.heading = Number.isFinite(p.heading) ? p.heading : h.heading;
      h.y = Math.max(world?.heightAt(p.x, p.z) ?? 0, 0);
      h.vx = h.vy = h.vz = 0; h.airborne = false;
      h.mesh.position.set(h.x, h.y, h.z);
      h.mesh.rotation.y = h.heading;
    }
  }
  applyHeliVisibility();
}

function applyHeliVisibility() {
  for (let i = 0; i < helis.length; i++) {
    const claimed = heliHolder(i) !== null && helis[i] !== game.heli;
    if (helis[i].mesh.visible !== !claimed) helis[i].mesh.visible = !claimed;
  }
}

// ---------- the parked fleet is shared too, not merely identical -----------
// F21 made the forecourt cars a pure function of the map, so both players see
// a blue kombi in the same bay. That is where it stopped, and it is only half
// of what "vidíme stejná auta" means: the moment one of them DROVE the kombi
// away, the other's copy stayed parked exactly where it was and a second,
// pixel-identical kombi (the ghost netvehicles builds from the wire) drove off
// past it. Both were enterable — `seats` is a local array — so two people
// could sit in "the same" car and watch it go two different ways, which is the
// duplicate netvehicles.js exists to prevent and the one place it could not
// see. It cannot: a ghost only dedupes against vehicles this client OWNS
// (ghosts.localVehicles), and a car nobody here is driving is not one of them.
//
// So the fleet gets the helicopter's mechanism, key included: the INDEX into
// parkedFleet, which is the same object on every client because the spawn is
// deterministic. Advisory, re-announced, self-healing when the claimant goes
// quiet — the trade-offs are the same and the note above heli_claim covers
// them. The one difference is the release: a helicopter is put back where the
// pilot left it because that is a courtesy, whereas for a car it is the whole
// point. Your friend parks by the river; the car is by the river for you too.
function parkHolder(i) {
  for (const [uid, pi] of _parkClaims) if (pi === i) return uid;
  return null;
}
function parkClaimedByPeer(car) {
  if (!car || _parkClaims.size === 0) return null;
  const i = car.parkIdx;
  return Number.isInteger(i) ? parkHolder(i) : null;
}

// Announce (on=1) or drop (on=0) our own claim. A car we never claimed (a
// stolen taxi — traffic has its own `steal` lane) is silently nothing.
function claimParked(car, on) {
  const i = on ? (Number.isInteger(car?.parkIdx) ? car.parkIdx : -1) : _myParkClaim;
  if (i < 0) return;
  _myParkClaim = on ? i : -1;
  _parkClaimT = on ? CLAIM_REANNOUNCE_S : 0;
  if (net) queueEvent('park_claim', { i, on: on ? 1 : 0 });
}

function setParkClaim(uid, i, on) {
  if (!Number.isInteger(i) || i < 0 || i >= parkedFleet.length) return;
  const car = parkedFleet[i];
  if (on) _parkClaims.set(uid, i);
  else if (_parkClaims.get(uid) === i) {
    _parkClaims.delete(uid);
    // Where the driver actually left it. Same guard as the helicopter's: if we
    // are somehow sitting in this car ourselves (a double-book inside one round
    // trip), nobody teleports it out from under us.
    const p = ghosts?.pose(uid);
    if (car && car !== game.car && car !== player?.inCar
        && p && Number.isFinite(p.x) && Number.isFinite(p.z)) {
      car.x = p.x; car.z = p.z;
      if (Number.isFinite(p.heading)) car.heading = p.heading;
      car.speed = 0;
      car.y = world?.heightAt(car.x, car.z) ?? car.y ?? 0;
      car.mesh.position.set(car.x, car.y, car.z);
      car.mesh.rotation.y = car.heading;
    }
  }
  applyParkVisibility();
}

// Hidden AND out of `parked`, which is the list that decides three separate
// things: what E can open (nearestEnterableCar), what you can crash into
// (_crashList) and what the minimap draws. A merely invisible car would still
// be a wall in the middle of the road.
function applyParkVisibility() {
  for (let i = 0; i < parkedFleet.length; i++) {
    const car = parkedFleet[i];
    // "ours" is three states, not one: driving it, riding in it, and WALKING UP
    // to it — boardVehicle has already written us into veh.seats by then, so
    // hiding it out from under the animation would leave us sliding into a car
    // nobody can see. A double-book that far in is the race the claim admits to.
    const mine = car === game.car || car === player?.inCar || car === player?.boarding?.veh;
    const claimed = parkHolder(i) !== null && !mine;
    if (car.mesh.visible !== !claimed) car.mesh.visible = !claimed;
    const at = parked.indexOf(car);
    if (claimed) { if (at >= 0) parked.splice(at, 1); }
    else if (at < 0 && !mine) parked.push(car);
  }
}

input.onKey('KeyE', () => {
  if (game.mode !== 'play') return;
  let jetNear = null;              // set by the fighter branch's own test
  if (trains?.riding) {
    // only with the doors open — stepping off at 140 km/h is not a feature
    if (!trains.alight()) { ui_hint('Vystoupit lze jen ve stanici'); return; }
    // the train is the one ride that showed the speedo without ever hiding it
    // again (updateHud only ever fills it), so stepping onto the platform left
    // the carriage's last speed frozen in the corner until you found a car
    $id('speedo').classList.add('hidden');
    sfx('train_doors', 0.7);
  } else if (!player.inCar && !game.car && !game.heli && !game.jet && !player.boarding && !player.exiting
      && trains?.nearestBoardable?.(player.pos.x, player.pos.z, 6)) {
    // !player.inCar, not just !game.car: a PASSENGER has no game.car but his
    // pos mirrors the vehicle's, so parking within 6 m of a halted train used
    // to board it from the seat — riding a train and sitting in a car at once,
    // with two updates fighting over player.pos.
    const t = trains.nearestBoardable(player.pos.x, player.pos.z, 6);
    if (trains.board(t)) sfx('train_doors', 0.7);
  } else if (player.boarding) {
    player.cancelBoarding();             // second E aborts the walk-up
  } else if (player.exiting) {
    // mid step-out: let the animation land, it's a third of a second
  } else if (game.car) {
    // step out: control returns NOW, the body follows over EXIT_T
    const c = game.car;
    c.ctl = null;
    game.car = null;
    fpView = false;          // step out and you are looking at yourself again
    parked.includes(c) || parked.push(c);
    // Hand it back to the room where it now stands, not where it was born.
    claimParked(c, false);
    $id('speedo').classList.add('hidden');
    hideCarName();
    engineStop();
    tireSet(0, 0);
    roadWindStop();
    sfx('door_open', 0.7);
    player.beginExit({ onOut: () => sfx('door_close', 0.8) });
  } else if (game.jet) {
    // …and nobody climbs out of a Gripen in the air either. Wheels down and
    // slow enough to stop: taxi speed, not a 200 km/h rollout.
    if (game.jet.airborne) { ui_hint('Nejdřív přistaň'); return; }
    if (game.jet.speed > 12) { ui_hint('Nejdřív zastav'); return; }
    game.jet.throttle = 0;
    game.jet = null;
    $id('speedo').classList.add('hidden');
    jetStop?.();
    windStop?.();
    sfx('door_open', 0.7);
    player.beginExit({ onOut: () => sfx('door_close', 0.8) });
  } else if (game.heli) {
    // step out of the helicopter — only with the skids down
    if (game.heli.airborne) { ui_hint('Nejdřív přistaň'); return; }
    claimHeli(game.heli, false);   // the machine is free again — tell the room
    game.heli = null;
    $id('speedo').classList.add('hidden');
    heliStop?.();
    sfx('door_open', 0.7);
    player.beginExit({ onOut: () => sfx('door_close', 0.8) });
  } else if (player.inCar) {
    // same rule as the pilot's: nobody steps off a flying helicopter
    if (player.inCar.airborne) { ui_hint('Nejdřív přistaň'); return; }
    // The PASSENGER'S exit. Every branch above tests game.car/game.heli, which
    // only the driver has, so a rider in seat 1 fell through to the last else,
    // where boardVehicle() refuses because inCar is already set — E did
    // nothing at all and the only way out was the console. First person is
    // what made this reachable in practice: it finally gives a passenger a
    // reason to sit there. No engineStop/speedo here — a passenger never
    // started either. fpView drops itself once the seat is gone, but say so.
    fpView = false;
    hideCarName();
    sfx('door_open', 0.7);
    player.beginExit({ onOut: () => sfx('door_close', 0.8) });
  } else if (heli && !heli.airborne
      && Math.hypot(heli.x - player.pos.x, heli.z - player.pos.z) < 5.5) {
    // F22: somebody in the room is already flying this one. `seats` cannot know
    // that — it is a local array — so the claim registry is asked first, and by
    // NAME, because "Obsazeno" for a machine standing empty in front of you is
    // the kind of hint that reads as a bug.
    const holder = heliClaimedByPeer(heli);
    if (holder) { ui_hint('Vrtulník pilotuje ' + (net?.peerName(holder) || 'jiný hráč')); return; }
    const seat = freeSeat(heli);
    if (seat < 0) { ui_hint('Obsazeno'); return; }
    player.boardVehicle(heli, seat, {
      onDoor: () => sfx('door_open', 0.8),
      onSeated: (s) => {
        sfx('door_close', 0.6);
        if (s !== 0) return;             // co-pilot seat: ride along, no controls
        game.heli = heli;
        // Claimed from onSeated, not from the keypress: the walk-up is
        // cancellable (a second E, the 6 s timeout), and locking the room out
        // of a machine nobody got into is worse than the race it prevents.
        claimHeli(heli, true);
        $id('speedo').classList.remove('hidden');
        sfx('heli_start', 0.75);
        heliStart?.();
      },
    });
  } else if ((jetNear = nearestParked(fighters, player.pos.x, player.pos.z, 7))) {
    // A Gripen is single-seat: there is no co-pilot to ride along.
    if (jetNear.seats?.[0]) { ui_hint('Obsazeno'); return; }
    player.boardVehicle(jetNear, 0, {
      onDoor: () => sfx('door_open', 0.8),
      onSeated: () => {
        sfx('door_close', 0.6);
        game.jet = jetNear;
        jetThrottle = 0;               // every flight starts at idle
        jetWasAir = false; jetBraking = false;
        sfx('jet_start', 0.8);
        jetStart?.();
        windStart?.();
        $id('speedo').classList.remove('hidden');
        ui_hint('W = tah (Shift forsáž) · ↓ vzlet · ←→ náklon · mezerník brzdy');
      },
    });
  } else {
    const car = nearestEnterableCar();
    if (!car) return;
    // A claimed car is already out of `parked`, so this is the double-book
    // window only (two people press E inside one round trip). Say who has it,
    // by name, exactly as the helicopter does — "Obsazeno" on a car standing
    // empty in front of you reads as a bug.
    // A peer's claim says who is DRIVING it, not that the car is off limits.
    // Refusing the whole car turned "somebody is already at the wheel" into
    // "you cannot get in", so two players could never ride together — which is
    // most of what a shared city is for. The claim takes the driver's seat; we
    // take the next free one.
    const holder = parkClaimedByPeer(car);
    const seat = holder ? (car.seats?.[1] ? -1 : 1) : freeSeat(car);
    if (seat < 0) {
      ui_hint(holder ? 'Plné — řídí ' + (net?.peerName(holder) || 'jiný hráč')
        : 'Obsazeno');
      return;
    }
    const inTraffic = traffic.cars instanceof Set ? traffic.cars.has(car) : traffic.cars.includes?.(car);
    if (inTraffic) {
      // The slot key has to be read BEFORE steal(), which nulls car.ai and
      // takes the key with it. Sending it lets every other client call
      // claimSlot() and kill its own copy of this car — traffic is a shared
      // SCHEDULE, so without this the peer keeps driving the phantom of the
      // Fabia you just took, in the middle of the road you are now on.
      const key = traffic.slotKey(car);
      traffic.steal(car);                // stops driving while we walk up
      if (net && key) queueEvent('steal', { key });
    }
    const pi = parked.indexOf(car);
    if (pi >= 0) parked.splice(pi, 1);
    player.boardVehicle(car, seat, {
      onDoor: () => sfx('door_open', 0.8),
      onSeated: (s) => {
        sfx('door_close', 0.6);
        // the name card goes up for BOTH seats — a passenger knows perfectly
        // well what he just climbed into — and only from here, never from
        // onDoor: the walk-up is cancellable (a second E, the car driving off,
        // the 6 s timeout), and naming a car nobody got into is a lie
        showCarName(car);
        if (s !== 0) return;             // passenger seat: no engine, no speedo
        game.car = car;
        // Claimed from onSeated for the same reason the helicopter is: the
        // walk-up is cancellable, and taking a car off everybody else's street
        // because somebody started strolling towards it is worse than the race
        // it would prevent. Only the DRIVER claims — a passenger is riding a
        // car somebody has already spoken for.
        claimParked(car, true);
        $id('speedo').classList.remove('hidden');
        // per-model engine voice: audio.js synthesises an I3 for the Fabia, a
        // diesel for the bus, motor whine for the Tesla. Without the kind it
        // would fall back to the Octavia four for everything.
        setTimeout(() => {
          if (game.car === car) { sfx('engine_start', 0.7); engineStart(car.kind); }
        }, 350);
      },
      // walked-up-and-it-vanished: a stolen car must stay enterable
      onCancel: () => { parked.includes(car) || parked.push(car); },
    });
  }
});

// ---------- C: chase cam ⇄ driver's eyes ----------
// C is the camera key everywhere in this genre, and it is free here (E, M and
// V are the only other onKey bindings; input.js reads W/A/S/D, Shift, Space,
// Ctrl and the arrows straight off input.keys). First person is a SEAT view,
// so off a seat the key says so rather than doing nothing, which reads as a
// dead key. The mode itself is not stored anywhere else: updateCamera
// re-resolves the seat every frame, so a wreck or an exit drops it on its own.
input.onKey('KeyC', () => {
  if (game.mode !== 'play') return;
  const v = fpVehicle();
  if (!v) { ui_hint('Pohled řidiče jen ve voze'); return; }
  fpView = !fpView;
  // Come up looking down the ROAD on both axes. Pitch alone was not enough:
  // camYaw carries whatever bearing the chase cam was orbiting at, and the FP
  // branch only CLAMPS it to ±FP_YAW — so pressing C after dragging the boom
  // round to the car's nose used to open first person staring out of the side
  // window at a hard 100°, with the auto-recentre unable to help while parked
  // (it only runs above 1.5 m/s). Snapping to the heading costs nothing: the
  // head is an offset from the nose in this mode, and zero is its home.
  if (fpView) { fpPitch = 0; camYaw = v.heading; }
});

// world-space seat anchor for the net layer (window.__atc is built at the
// bottom of this module, so hang the hook on the microtask after evaluation)
queueMicrotask(() => { if (window.__atc) window.__atc.seatAnchor = worldSeatAnchor; });

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

// ---------- the car's name, over the speedo, for three seconds ----------
// Held on a frame countdown rather than a setTimeout, exactly like _hintHold:
// re-entering a car simply rewrites the deadline, so there is one card and one
// timer no matter how fast the player jumps between vehicles — no stacked
// timeouts racing each other to hide an element that is visible again. The
// element is never `display:none`, only faded, so the CSS transition runs on
// every show without a forced reflow to restart it.
let _carNameHold = 0;
function showCarName(car) {
  const el = $id('car-name');
  if (!el) return;
  el.querySelector('.cn-name').textContent = carLabel(car);
  el.querySelector('.cn-sub').textContent = carSubtitle(car);
  el.classList.add('show');
  _carNameHold = 3;
}
// Stepping out inside the three seconds takes the card with it: it is a label
// for the speedo block, and leaving it naming a car you are walking away from
// (with the speedo already gone from under it) reads as a stuck HUD.
function hideCarName() {
  _carNameHold = 0;
  $id('car-name')?.classList.remove('show');
}

// ---------- parked cars around the spawn ----------
// A handful of cars wait on the forecourt and the nearby parking lots, so the
// first thing you do at the station is what you'd do in any GTA: take a car.
//
// F21 — THE FLEET IS A PROPERTY OF THE PLACE, NOT OF THE SESSION. Every choice
// here used to be Math.random(): the heading, the body style, the paint. So the
// two cars on the forecourt were a blue kombi to one player and a white van to
// the other, standing in the same two spots — and since these are enterable,
// "get in the red one" was a different car on each screen. Everything below is
// now a pure function of the SPOT's coordinates, hashed with identity.strHash
// (an integer FNV-1a + avalanche; no Math.sin, so no engine-dependent ULP).
//
// The second half of the fix is the ORDER. city.paved is filled by the tile
// streamer, so which parking polygons are in it — and in what sequence — is a
// property of how the download happened to interleave, and `n >= 8` would then
// take a different eight on a slow connection than on a fast one. Sorting the
// candidates by position before the cap makes the cut-off a fact about the map.
const PARK_KINDS = ['sedan', 'hatch', 'kombi', 'suv', 'van'];
// deterministic 0..1 from a world position plus a salt. 0.1 m quantisation so
// two clients that computed a centroid with a last-bit difference still agree.
function spotRnd(x, z, salt) {
  return strHash(salt + ':' + Math.round(x * 10) + ',' + Math.round(z * 10)) / 4294967296;
}
function placeParkedCars(city) {
  const spots = [[SPAWN.x + 9, SPAWN.z + 8, 1.2], [SPAWN.x - 14, SPAWN.z + 12, 1.9]];
  // parking polygons near the station → one car at each centroid
  const lots = [];
  for (const p of city.paved) {
    if (p.t !== 'parking') continue;
    let cx = 0, cz = 0;
    for (const [x, z] of p.o) { cx += x; cz += z; }
    cx /= p.o.length; cz /= p.o.length;
    if (Math.hypot(cx - SPAWN.x, cz - SPAWN.z) > 260) continue;
    lots.push([cx, cz]);
  }
  lots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [cx, cz] of lots.slice(0, 8))
    spots.push([cx, cz, spotRnd(cx, cz, 'h') * Math.PI * 2]);
  for (const [x, z, h] of spots) {
    const pos = { x, z };
    world.collide(pos, 1.2); // never inside a wall
    // hashed off the SPOT, not off the collided position: collide() nudges the
    // car out of a wall using the local geometry, and a client whose building
    // tile has not streamed in yet would nudge differently and repaint the car.
    const kind = PARK_KINDS[(spotRnd(x, z, 'k') * PARK_KINDS.length) | 0];
    const color = CAR_COLORS[(spotRnd(x, z, 'c') * CAR_COLORS.length) | 0];
    const car = vehicles.add(kind, pos.x, pos.z, h, color);
    // The claim key. Stamped at spawn and never renumbered, because `parked`
    // is spliced all session while parkedFleet is not — see the declaration.
    car.parkIdx = parkedFleet.length;
    parkedFleet.push(car);
    parked.push(car);
  }
}

// every car the player can hit — traffic + parked, self filtered in driveStep.
// SHARED traffic only: see isGhostCar. A ghost is not a wall, because on the
// peer's screen there is nothing there to bounce off.
function _crashList() {
  if (!traffic) return parked;
  const out = sharedCars();
  for (const c of parked) out.push(c);
  return out;
}

// what a rocket can hit and shove. Everything the player can SEE, ghosts
// included — this list moves no shared state (the blast's hole in the wall
// goes out over the wire from here, it is not recomputed on the far side), and
// a rocket sailing through a car that is plainly there is a worse lie than a
// car the peer happens not to draw.
function _blastList() {
  return traffic ? [...traffic.cars, ...parked] : parked;
}

// ---------- how busy the roads are, right now ----------
// ONE multiplier rides on the player's traffic-density setting, and it is a
// function of the SHARED clock only.
//
// There used to be a second one, trafficPlaceK(), which counted the buildings
// in the chunk index around the player and scaled traffic by how built-up the
// surroundings were. It is gone, and its removal is a REQUIREMENT of the shared
// traffic model, not a tidy-up: traffic.js now derives the population of each
// 256 m cell from the length of drivable road in that cell, which is a property
// of the world and therefore the same on every client. A per-player term in the
// same product means two people standing in different districts scale the ONE
// shared fleet by different factors — i.e. they disagree about how many cars
// exist between them, which is exactly the disagreement the schedule was built
// to remove. Built-up-ness is still honoured; it is just honoured per cell,
// where both clients can see it, instead of per viewer.
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
// the parameter is named t01, not tod: `tod` is the imported worldclock reader
// in this module now, and a shadowed import is one rename away from a bug
function trafficTimeK(t01) {
  const h = (t01 ?? 0) * 24;
  for (let i = 0; i < TRAFFIC_HOURS.length - 1; i++) {
    const [h0, v0] = TRAFFIC_HOURS[i], [h1, v1] = TRAFFIC_HOURS[i + 1];
    if (h >= h0 && h <= h1) {
      const t = (h - h0) / (h1 - h0);
      return v0 + (v1 - v0) * (t * t * (3 - 2 * t)); // smoothstep, no kinks
    }
  }
  return 0.5;
}

// ---------- everybody the AI traffic has to brake for ----------------------
// traffic.actors is the single biggest lever on whether two clients agree
// about the cars between them. The schedule (where a car nominally is at a
// given shared instant) is already identical on both machines to the bit; the
// only thing that makes the RENDERED positions differ is `lag`, and lag is
// bought by braking for obstacles. Feed one client only its own player and the
// two of them brake for different things — the fleets diverge for a reason
// that has nothing to do with either simulation being wrong.
//
// So this is every player in the room: us (in whatever we are driving), and
// every peer, taken from their ghost vehicle when they have one and from their
// avatar when they are on foot. Records are POOLED — this runs every frame and
// twenty fresh little objects a frame is 1200 allocations a second for nothing.
const _actors = [];
const _actorPool = [];
function pushActor(x, z, half) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return;
  const a = _actorPool[_actors.length] ??= { x: 0, z: 0, half: 0 };
  a.x = x; a.z = z; a.half = half;
  _actors.push(a);
}
function updateActors() {
  _actors.length = 0;
  // …and the ASYMMETRY that used to sit right here. player.pos mirrors whatever
  // you are riding (player.js does that so the streamer and the exit maths have
  // one truth), so flying a helicopter at 180 m put a 2.3 m obstacle on the
  // street underneath it — `_obst` is two-dimensional and never reads a height.
  // Peers were already filtered out of that (`p.kind !== 'heli'` below), so a
  // client braked for something no other client in the room could see: one
  // player takes off, and the traffic on both screens stops agreeing along the
  // whole flight path. Fliers are not on the road; nobody's are.
  const flying = !!(game.heli || game.jet || player.inCar?.airborne);
  if (game.car) pushActor(game.car.x, game.car.z, 3.9);
  else if (!flying) pushActor(player.pos.x, player.pos.z, 2.3);
  if (!net) return _actors;
  for (const [uid, r] of net.remotes) {
    const p = ghosts?.pose(uid);
    // `riding` means they are a passenger in something we already listed (our
    // car, or another peer's ghost) — a second obstacle on the same metre of
    // tarmac would make the queue behind it twice as timid on this client only.
    // A rider in ANY aircraft is not on the road, and the test has to be the
    // wire descriptor rather than the ghost, because a jet has no ghost at all
    // (netvehicles refuses to approximate a Gripen with a car — see readState).
    // Without this, `!p` sent a fighter pilot's avatar to traffic as a 2.3 m
    // obstacle from 5 km up, which is the very asymmetry the local-flier guard
    // above just removed.
    const vk = r.state?.veh?.k;
    if (vk === 'heli' || vk === 'jet') continue;
    if (p && !p.riding) {
      if (p.kind !== 'heli') pushActor(p.x, p.z, 3.9);
    } else if (!p) pushActor(r.x, r.z, 2.3);
  }
  return _actors;
}

// Parked cars as traffic obstacles. A car the player abandons mid-lane joins
// `parked`, and NPC traffic used to drive straight through it — `_obst` held
// players only, so anything standing still was a ghost. Every parked hull in
// braking reach goes in; the 400 m gate keeps the list at village size (NPCs
// only exist near the player anyway, so a farther obstacle brakes nobody).
function updateBlockers() {
  _blockers.length = 0;
  const px = player.pos.x, pz = player.pos.z;
  for (const c of parked) {
    const dx = c.x - px, dz = c.z - pz;
    if (dx * dx + dz * dz > 400 * 400) continue;
    _blockers.push({ x: c.x, z: c.z, half: (c.len ?? 4.4) / 2 + 0.35 });
  }
  return _blockers;
}
const _blockers = [];

// ---------- horizon: how far the world is built, and where the haze sits ----
// Two rules, and the second is the one that was broken:
//   1. From the air you see kilometres, so the streamed radius grows with
//      altitude (and the per-frame build budget with it, or the edge would
//      chase you).
//   2. The fog wall must always end INSIDE that radius. It sat at 900 m while
//      the city was only built to 720 m, so the world visibly stopped against
//      bare sky — exactly the "blue plane where nothing is loaded" report.
// Three rings in the air. AIR_CHUNKS_MAX is FULL detail; AIR_SHELL_MAX adds a
// ring of ground-and-buildings beyond it; AIR_FAR_MAX is the photo alone. At
// 121 m over a village the old two-ring world put buildings out to 720 m and
// then a kilometre of bare photograph — houses plainly there in the aerial
// image with nothing standing on them, which is the "dost budov není ve světě"
// report. The shell ring is cheap enough to be wide: no facade atlas, no
// roads (the photo has better ones), no lamps, no trees.
const GROUND_CHUNKS = 6, AIR_CHUNKS_MAX = 10, AIR_SHELL_MAX = 10, AIR_FAR_MAX = 14;
function updateHorizon(dt) {
  if (!world || !sky) return;
  const gs = getSettings();
  const base = gs.viewChunks ?? GROUND_CHUNKS;
  // altitude drives the horizon whichever machine is up there
  const flier = game.heli ?? game.jet;
  const alt = aglOf(flier);
  // Altitude is one reason to see further; SPEED is the other, and the jet has
  // it at any height. A Gripen on the deck at Mach 1 crosses the whole 720 m
  // ground-setting radius in two seconds, so it needs the wide horizon just as
  // much as a helicopter at 300 m — and without it the look-ahead focus has no
  // room to move and the ground ahead stays unbuilt.
  const rush = game.jet ? Math.min(1, game.jet.speed / 260) : 0;
  const climb = Math.max(Math.min(1, alt / 300), rush);
  // climb 0 → 300 m widens the view from the ground setting to the air cap
  const want = Math.round(base + (AIR_CHUNKS_MAX - base) * climb);
  world.viewChunks = Math.max(base, want);
  // …and unrolls a ground-only ORTHO ring far beyond it. That ring is one
  // textured quad per cell, so it costs almost nothing, and since the aerial
  // photo already contains the roads and roofs it reads as real city out to
  // kilometres — which is what stops the world ending in mid-air.
  // The shell ring opens FASTER than the others (√climb, not climb). Altitude
  // is not what makes you see far — angle is. At 120 m over a village you are
  // already looking a kilometre and a half down the valley, and that is exactly
  // the height at which the missing houses were reported.
  world.shellChunks = Math.round(AIR_SHELL_MAX * Math.sqrt(climb));
  world.farChunks = Math.round(AIR_FAR_MAX * climb);
  // Keep the edge ahead of the nose. These are CAPS, not targets: city.js
  // spends a millisecond budget and stops, so a high number costs nothing over
  // open country and cannot blow a frame over Prague. The jet gets the widest
  // cap because its nose moves twenty times faster than a helicopter's — but
  // it also gets a slightly bigger time slice, because a stalled edge in front
  // of a 700 m/s aircraft is a hole in the world.
  world.chunksPerFrame = game.jet ? 16 : alt > 20 ? 8 : 2;
  world.buildBudgetMs = game.jet ? 9 : 7;
  // The aerial photo picks its resolution from distance to the same LOOK-AHEAD
  // point the chunk streamer uses, so the full-detail ring sits over the ground
  // you are about to cross rather than the ground behind you.
  const of = leadFocus(game.car ?? player.pos);
  orthoMgr?.setFocus?.(of.x, of.z);
  const radius = (world.viewChunks + world.farChunks) * 120;
  // haze reaches 88 % of the built radius: geometry has fully dissolved before
  // the streamed edge, so there is nothing to notice
  sky.fogScale = (radius * 0.88) / 900;
  // The far plane serves the SKY as well as the city. Tied to the city radius
  // it sat at 1632 m, while the cloud field spans ±2600 m — so 95 % of the
  // clouds were clipped away before they could be seen (measured: 16 of 319
  // puffs alive). The floor here lets the whole field render.
  //
  // `near` used to be pinned to 0.5 right here, on the reasoning that nothing
  // in a chase camera is closer than a metre. First person broke that: from
  // the driver's seat the A-pillar and the dash are ~0.3 m away, and this ran
  // every frame BEFORE updateCamera, so it clipped them back off as fast as
  // the camera set 0.14. The near plane is now the camera mode's business
  // (applyLens) and this only reads the value it chose.
  // The far plane serves the sky as well as the city, and the cloud fade is
  // clamped to 0.89·far — so a far plane short of the chosen cloud range would
  // quietly cancel the setting the player just paid for.
  const cloudFar = clouds ? clouds.range / 0.89 + 400 : 5200;
  const wantFar = Math.max(radius * 1.7, 5200, cloudFar);
  if (Math.abs(camera.far - wantFar) > 50 || camera.near !== camNear) {
    camera.far = wantFar;
    camera.near = camNear;
    camera.updateProjectionMatrix();
  }
}

// ---------- dev tools (?devmode) ----------
// Loaded lazily and only when the URL asks, so a normal session never pays for
// it and a missing file can never take the boot down.
async function initDev() {
  try {
    const { initDevMode, isDevMode } = await import('./devmode.js');
    if (!isDevMode()) return;
    const actions = {
      teleport(p) {
        if (!world || !player) return;      // panel can be open at the menu
        // Put the player (and whatever they are riding) down at the place, then
        // let the streamer catch up: ensureTiles first so the ground under the
        // feet exists before the camera is there, otherwise you land inside the
        // void for a second and the collision has nothing to push against.
        const ride = game.car ?? game.heli ?? null;
        world.city.ensureTiles?.(p.x, p.z)?.catch?.(() => {});
        player.pos.x = p.x; player.pos.z = p.z;
        player.heading = p.h ?? 0;
        // The walk controller would settle this by falling, which from a Zlín
        // ridge to the Pardubice plain is 130 m of freefall before the ground
        // arrives. Put the feet down instead.
        const gy = world.surfaceY?.(p.x, p.z)?.y;
        if (gy !== undefined) { player.y = gy; player.vy = 0; player.grounded = true; }
        // …and put it on the GROUND there, not at absolute zero. Zero was
        // harmless while the world was a plane; Zlín stands at 230 m and its
        // ridges at 350, so a teleported car arrived that far underground and a
        // helicopter — which has no suspension to re-seat it — simply stayed
        // there. surfaceY answers 0 until the height map lands, which is the
        // same flat world as before and settles itself a moment later.
        if (ride) { ride.x = p.x; ride.z = p.z; ride.heading = p.h ?? 0; ride.speed = 0;
          if (ride.y !== undefined) ride.y = world.surfaceY?.(p.x, p.z)?.y ?? 0; }
        camInit = false;              // stop the chase cam sliding 100 km
        // …and turn the VIEW too, not just the body. The pose readout reports
        // the camera's bearing, so a teleport that ignores it puts you on the
        // right spot looking the wrong way — half a reproduction.
        if (p.h !== undefined) camYaw = p.h;
        ui_hint?.('📍 ' + p.n);
      },
      // Everything a bug report needs to be reproducible: where, which way, in
      // what, and the lat/lon that means something outside this project.
      pose() {
        if (!world || !player) return null;
        const ride = game.car ?? game.heli ?? game.jet ?? null;
        const x = ride ? ride.x : player.pos.x;
        const z = ride ? ride.z : player.pos.z;
        const y = ride ? ride.y : player.y;
        camera.getWorldDirection(_earDir);
        const T = world.city.tile ?? 4800;
        return {
          x, y, z,
          lat: world.city.origin.lat - z / world.city.mPerLat,
          lon: world.city.origin.lon + x / world.city.mPerLon,
          // the camera's own bearing, not the player's — "what I see" is the
          // question a screenshot raises, and the chase camera is what took it
          headingDeg: (Math.atan2(-_earDir.x, -_earDir.z) * 180 / Math.PI + 360) % 360,
          pitchDeg: Math.asin(Math.max(-1, Math.min(1, _earDir.y))) * 180 / Math.PI,
          tile: Math.floor(x / T) + ',' + Math.floor(z / T),
          chunk: Math.floor(x / 120) + ',' + Math.floor(z / 120),
          ride: game.jet ? 'gripen' : game.heli ? 'heli' : game.car ? game.car.kind : null,
          place: placeFinder ? [placeFinder.town, placeFinder.street].filter(Boolean).join(' · ') : '',
        };
      },
      spawnCar(kind) {
        if (!world || !player || !vehicles) return;
        // A helicopter or a jet needs room the road in front of you does not
        // have, so they land further out and clear of the kerb — and they join
        // the same lists main.js already scans for "what am I standing next
        // to", so E works on them with no extra wiring.
        if (kind === 'heli' || kind === 'gripen') {
          const h0 = game.car?.heading ?? player.heading;
          const d = kind === 'gripen' ? 26 : 16;
          const sx = player.pos.x - Math.sin(h0) * d;
          const sz = player.pos.z - Math.cos(h0) * d;
          if (kind === 'heli') {
            const ground = world.heightAt(sx, sz);
            scene.add(makeHelipad(sx, sz, ground));
            const h = new Helicopter(scene, sx, sz, h0 + Math.PI, world);
            helis.push(h);
            ui_hint?.('🚁 vrtulník před tebou');
          } else {
            fighters.push(new Fighter(scene, sx, sz, h0 + Math.PI, world));
            ui_hint?.('✈️ Gripen před tebou');
          }
          return;
        }
        // 7 m ahead of where the player faces, nudged clear of walls by the
        // same collide() the traffic uses — a car spawned inside a facade is
        // worse than no car at all.
        const h = game.car?.heading ?? player.heading;
        const pos = { x: player.pos.x - Math.sin(h) * 7, z: player.pos.z - Math.cos(h) * 7 };
        world.collide(pos, 2.4);
        const color = CAR_COLORS[(Math.random() * CAR_COLORS.length) | 0];
        const car = vehicles.add(kind, pos.x, pos.z, h + Math.PI, color);
        parked.push(car);
        ui_hint?.('🚗 ' + kind);
      },
    };
    initDevMode(actions);
    // ?tp=x,z[,heading] — stand exactly where a report was filed. Every bug in
    // this project arrives as a pose from the dev readout, and not being able
    // to GO there is how a session ends up reasoning instead of looking.
    // Applied once the session is actually in the world; before that the
    // world/player guards inside teleport() would silently drop it.
    const tpArg = new URLSearchParams(location.search).get('tp');
    if (tpArg) {
      const [tx2, tz2, th2] = tpArg.split(',').map(Number);
      if (Number.isFinite(tx2) && Number.isFinite(tz2)) {
        const t = setInterval(() => {
          if (!world || !player || game.mode !== 'play') return;
          clearInterval(t);
          actions.teleport({ x: tx2, z: tz2,
            h: Number.isFinite(th2) ? (th2 * Math.PI) / 180 : 0,
            n: `tp ${tx2}, ${tz2}` });
        }, 250);
      }
    }
  } catch (err) {
    console.warn('devmode unavailable:', err.message);
  }
}

// ---------- navigation: where am I, and how do I get to the waypoint ------
// These three modules are loaded LAZILY and each is optional. A static import
// of a module that does not exist yet takes the entire game down at boot (it
// did, once), and navigation is a luxury: the city must still be drivable if
// any of it fails to load.
let placeFinder = null, navigation = null, navLine = null;
let _navWpX = null, _navWpZ = null;
async function initNavigation(city) {
  try {
    const [{ PlaceFinder }, { Navigation }, { NavLine }] = await Promise.all([
      import('./place.js'), import('./navigation.js'), import('./navline.js'),
    ]);
    placeFinder = new PlaceFinder(city);
    navigation = new Navigation(city);
    navLine = new NavLine(scene);
  } catch (err) {
    console.warn('navigation unavailable:', err.message);
  }
}

function updateNavigation(dt) {
  if (placeFinder) {
    placeFinder.update(player.pos.x, player.pos.z);
    const el = $id('place-hud');
    if (el) {
      const town = placeFinder.town ?? '', street = placeFinder.street ?? '';
      if (town || street) {
        el.classList.remove('hidden');
        const t = el.querySelector('.pl-town'), st = el.querySelector('.pl-street');
        if (t.textContent !== town) t.textContent = town;
        if (st.textContent !== street) st.textContent = street;
      } else el.classList.add('hidden');
    }
  }
  if (!navigation) return;
  // the world map owns the waypoint; hand it over only when it actually moves
  const wp = worldMap?.waypoint ?? null;
  if (wp) {
    if (wp.x !== _navWpX || wp.z !== _navWpZ) {
      _navWpX = wp.x; _navWpZ = wp.z;
      navigation.setDestination(wp.x, wp.z);
    }
  } else if (_navWpX !== null) {
    _navWpX = _navWpZ = null;
    navigation.clear();
    navLine?.clear();
  }
  navigation.update(dt, player.pos.x, player.pos.z);
  // the line belongs on the road under a CAR — on foot it would just be litter
  if (navLine) {
    if (game.car && navigation.route) {
      navLine.set(navigation.route);
      navLine.update(dt, player.pos.x, player.pos.z, world);
    } else navLine.clear();
  }
  updateTripHud();
}

// ---- the trip readout: time left and the distance BY ROAD ----------------
// The compass at the top of the screen shows the straight line, which is the
// number a bird would use. This is the one a driver needs: navigation.js has
// already integrated the route in both metres and seconds, so both figures are
// reads, not calculations.
//
// The clock is only shown while DRIVING. The seconds come from the road's own
// speed limits, so on foot they would promise a 40-minute walk in four — and a
// confidently wrong ETA is worse than none. The distance is honest either way.
let _tripTxt = '';
function updateTripHud() {
  const el = $id('nav-hud');
  if (!el) return;
  const m = navigation?.route ? navigation.remainingM : null;
  if (m == null || !Number.isFinite(m)) {
    if (!el.classList.contains('hidden')) { el.classList.add('hidden'); _tripTxt = ''; }
    return;
  }
  const t = game.car && Number.isFinite(navigation.etaS) ? navigation.etaS : null;
  // A partial route stops short of the pin and pads the rest with a straight
  // line, so both numbers are a floor rather than an answer — say so with the
  // one character that means "about" in every language on the map.
  const approx = navigation.partial ? '≈' : '';
  const txt = (t === null ? '' : approx + fmtEta(t)) + '\n' + approx + fmtRoadDist(m);
  if (txt === _tripTxt) return;                 // ~1 DOM write a second, not 60
  _tripTxt = txt;
  const nl = txt.indexOf('\n');
  el.querySelector('.nv-eta').textContent = txt.slice(0, nl);
  el.querySelector('.nv-dist').textContent = txt.slice(nl + 1);
  el.classList.remove('hidden');
}

// "3 min", "48 min", "1 h 20 min" — never seconds, which would flicker, and
// never "0 min", which reads as "you have arrived" while you are still driving.
function fmtEta(s) {
  const mins = Math.max(1, Math.round(s / 60));
  if (mins < 60) return mins + ' min';
  return Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min';
}

// Rounded the way a satnav rounds: to 10 m up close (a 3 m tick would never
// settle), to 100 m within the kilometre, and to whole kilometres once the
// tenth stopped meaning anything.
function fmtRoadDist(m) {
  if (m >= 10000) return Math.round(m / 1000) + ' km po silnici';
  if (m >= 1000) return (m / 1000).toFixed(1) + ' km po silnici';
  return Math.round(m / 10) * 10 + ' m po silnici';
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
  $id('tod-clock').textContent = todClock(tod());
  if (game.car) {
    $id('speed-num').textContent = Math.round(Math.abs(game.car.speed) * 3.6);
    $id('speed-unit').textContent = 'km/h';
  } else if (trains?.riding) {
    $id('speedo').classList.remove('hidden');
    $id('speed-num').textContent = Math.round(Math.abs(trains.riding.speed ?? 0) * 3.6);
    $id('speed-unit').textContent = 'km/h · ČD';
  } else if (game.jet) {
    // airspeed, altitude, and whether the burner is lit — the three numbers a
    // pilot actually watches. Mach is worth showing because past 1 234 km/h it
    // is the number that means something.
    const j = game.jet;
    const mach = j.kmh / 1234;
    $id('speed-num').textContent = Math.round(j.kmh);
    $id('speed-unit').textContent =
      `km/h · M${mach.toFixed(2)} · ${Math.round(j.y)} m${j.reheat ? ' · AB' : ''}`;
  } else if (game.heli) {
    // in flight the readout becomes an altimeter with the airspeed beside it,
    // so the trailing unit has to switch too (it used to read "137 m km/h")
    const kmh = Math.round(Math.hypot(game.heli.vx ?? 0, game.heli.vz ?? 0) * 3.6);
    $id('speed-num').textContent = `${kmh}`;
    $id('speed-unit').textContent = `km/h · ${Math.round(game.heli.y)} m`;
  }
  // vehicle name card: counted down per frame, not on the 0.2 s hint tick, so
  // three seconds is three seconds and not "three seconds rounded to a tick"
  if (_carNameHold > 0) {
    _carNameHold -= dt;
    if (_carNameHold <= 0) $id('car-name')?.classList.remove('show');   // CSS fades it out
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
    else if (!player.inCar && trains?.nearestBoardable?.(player.pos.x, player.pos.z, 6)) {
      hint.innerHTML = '<kbd>E</kbd> nastoupit do vlaku';
      hint.classList.remove('hidden');
    }
    else if (game.heli) {
      hint.innerHTML = game.heli.airborne
        ? '<kbd>↑</kbd><kbd>↓</kbd> stoupání · <kbd>WASD</kbd> let · <kbd>←</kbd><kbd>→</kbd> otáčení · <kbd>V</kbd> raketa'
        : '<kbd>E</kbd> vystoupit · <kbd>↑</kbd> vzlet · <kbd>V</kbd> raketa';
      hint.classList.remove('hidden');
    }
    else if (game.jet) {
      hint.innerHTML = game.jet.airborne
        ? '<kbd>W</kbd><kbd>S</kbd> tah · <kbd>Shift</kbd> forsáž · <kbd>↓</kbd> nahoru · <kbd>↑</kbd> dolů · <kbd>←</kbd><kbd>→</kbd> náklon'
        : '<kbd>E</kbd> vystoupit · <kbd>W</kbd> tah · <kbd>↓</kbd> vzlet po rozjezdu';
      hint.classList.remove('hidden');
    }
    else if (heli && !game.car && !player.inCar
        && Math.hypot(heli.x - player.pos.x, heli.z - player.pos.z) < 5.5) {
      // Offering E on a machine somebody in the room is already flying (and
      // which is therefore not even drawn here) reads as a dead key. Say who
      // has it instead — textContent, because that name came off the wire.
      const holder = heliClaimedByPeer(heli);
      if (holder) {
        hint.textContent = 'Vrtulník pilotuje ' + (net?.peerName(holder) || 'jiný hráč');
      } else {
        hint.innerHTML = '<kbd>E</kbd> nastoupit do vrtulníku';
      }
      hint.classList.remove('hidden');
    }
    else if (jetNearest && !game.car && !player.inCar
        && Math.hypot(jetNearest.x - player.pos.x, jetNearest.z - player.pos.z) < 7) {
      hint.innerHTML = '<kbd>E</kbd> nastoupit do stíhačky';
      hint.classList.remove('hidden');
    }
    // player.inCar, not game.car: the passenger is seated too, and E now takes
    // him out. Every "nastoupit" hint above is guarded the same way — from a
    // seat, the pos they measure against is the vehicle's, not a pedestrian's.
    else if (game.car || player.inCar) {
      hint.innerHTML = '<kbd>E</kbd> vystoupit';
      hint.classList.remove('hidden');
    } else {
      // on foot the hint doubles as a sign over the door: walk into a building
      // and it tells you what you just walked into
      const inside = world?.interiors?.labelAt(player.pos.x, player.pos.z);
      const car = nearestEnterableCar();
      if (inside) {
        // Storeys are counted from the GROUND under your feet, not from sea
        // level. player.y is an absolute altitude now, so dividing it by a
        // storey height put the ground floor of Zlaté jablko in Zlín on the
        // 76th storey — 226 m of Moravia divided by three metres of ceiling.
        // The bare terrain is the right datum: inside a building it is that
        // building's ground to within the fall across its own footprint, which
        // is less than half a storey.
        const agl = player.y - (world?.terrain?.heightAt(player.pos.x, player.pos.z) ?? 0);
        const fl = agl > 1.5 ? ` · ${Math.max(1, Math.round(agl / 3) + 1)}. patro` : '';
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
  // ---- the maps, and the peers on them (F10) ----
  // peerList() is built ONCE a frame and handed to both maps: it allocates a
  // record per peer and calls lookForUid() on each, and doing that twice for
  // the same frame is pure waste.
  //
  // The array must be passed EVERY frame, open map or not: worldmap.js reads
  // `null` as "the caller said nothing this frame, keep chasing" and an array
  // as "this is the room, and anyone not in it has left". Skipping the call
  // while the map is closed would freeze a followed friend at the last place
  // the map happened to be open — the chase would neither track nor stop.
  const peers = net ? net.peerList() : null;
  worldMap?.update(player, game.car, heli, peers);
  // The waypoint the map owns wins; failing that, point at the nearest friend.
  // This is what makes "kde jsi?" answerable without opening anything: the
  // compass on the HUD always has somebody to point at in a shared session.
  const wp = worldMap?.waypoint ?? nearestPeerPoint(peers);
  minimap?.setWaypoint?.(wp);
  const wpEl = $id('waypoint-hud');
  if (wpEl) {
    // styling hook: a chase after a person is not the same promise as a pin
    // dropped on a map, and index.html may one day want to say so
    wpEl.dataset.peer = (!worldMap?.waypoint && wp) || worldMap?.followUid ? '1' : '';
    if (wp) {
      const d = Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z);
      // Bearing relative to where the CAMERA looks, so the arrow reads as
      // "turn that way" rather than as a compass needle.
      //
      // Derived, not guessed — the first version was MIRRORED (it sent you
      // left for a target on the right). updateCamera parks the camera at
      // (tx + sin·flat, tz + cos·flat) looking at the target, so the view
      // direction is f = (−sin y, −cos y) and three's right vector is
      // cross(f, up) = (cos y, −sin y). The screen bearing clockwise from
      // "up" is then atan2(d·right, d·forward). Checked against seven
      // hand-worked cases (N/E/S/W target × N/E/W facing).
      const dx = wp.x - player.pos.x, dz = wp.z - player.pos.z;
      const cy = Math.cos(camYaw), sy = Math.sin(camYaw);
      const ang = Math.atan2(dx * cy - dz * sy, -dx * sy - dz * cy);
      wpEl.classList.remove('hidden');
      wpEl.style.setProperty('--wp-rot', (ang * 180 / Math.PI).toFixed(1) + 'deg');
      wpEl.querySelector('.wp-dist').textContent = d > 1500
        ? (d / 1000).toFixed(1) + ' km' : Math.round(d) + ' m';
    } else wpEl.classList.add('hidden');
  }
  minimap?.update(player.pos.x, player.pos.z, camYaw,
    traffic ? [...traffic.cars] : [], peers);
}

// The closest peer, as a waypoint-shaped {x, z}, or null. Returns a FRESH
// object only when the target actually moved: minimap.setWaypoint keeps the
// reference it is given, and handing it a new object every frame is 60
// allocations a second plus a repaint the map has no reason to do.
let _npWp = null, _npUid = null;
function nearestPeerPoint(peers) {
  if (!peers || !peers.length) { _npWp = null; _npUid = null; return null; }
  let best = null, bd = Infinity;
  const px = player.pos.x, pz = player.pos.z;
  for (const p of peers) {
    const d = (p.x - px) ** 2 + (p.z - pz) ** 2;
    if (d < bd) { bd = d; best = p; }
  }
  if (!best) { _npWp = null; _npUid = null; return null; }
  if (!_npWp || _npUid !== best.uid
      || (best.x - _npWp.x) ** 2 + (best.z - _npWp.z) ** 2 > 2.25) {
    _npWp = { x: best.x, z: best.z };
    _npUid = best.uid;
  }
  return _npWp;
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
  // …and how much sky. setDist rebuilds the field, so it no-ops on a repeat.
  clouds?.setDist?.(s.cloudDist ?? 'medium');
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
  // co-op preferences. These are not performance knobs and deliberately do not
  // ride the graphics preset: a name tag is either information you want over
  // your friends' heads or clutter you don't, and that has nothing to do with
  // how fast the machine is. Both are no-ops in single player — netcity never
  // constructs a NameTags when there is nobody to label.
  if (net) {
    net.showNames = s.showNames !== false;
    net.tags?.setRange?.(s.nameDist);
  }
  // chunk-recipe knobs: flip the flags on the shared mats and rebuild
  if (world) {
    const wantOrtho = s.ortho ? orthoMgr : null;
    const recipeChanged = world.mats.ortho !== wantOrtho
      || world.mats.facades !== !!s.facades
      || world.mats.trees !== (s.trees !== false);
    world.mats.ortho = wantOrtho;
    world.mats.facades = !!s.facades;
    world.mats.trees = s.trees !== false;
    grass?.setEnabled(s.grass !== false);
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
  grass = new Grass(scene, world, city);
  // A region tile landing changes what the ground under us is MADE of — a car
  // park arriving where the mask said field has to stop the grass growing
  // through it. The mask is cheap to rebuild and this only fires on a tile.
  city.onTileLoaded?.(() => grass?.invalidate());
  world.ground?.onTileLoaded?.(() => grass?.invalidate());
  grass.setEnabled(getSettings().grass !== false);
  sky = makeSky(scene);
  // The uid is passed EXPLICITLY even though Player defaults to localUid(),
  // because it is the whole identity contract in one line: this same string
  // picks our jacket here, picks the dot in the co-op HUD, and is what every
  // other client hashes to dress our avatar. One function, one uid, one look —
  // "the blue one is me" used to be true on four screens at once.
  player = new Player(scene, SPAWN.x, SPAWN.z, SPAWN.heading, localUid());
  vehicles = new Vehicles(scene);
  // Immediately, not later: every car built from here on — parked, spawned by
  // the dev tools, or a peer's — asks this for the height of the road it is
  // standing on, and one built before it is set is one built underground.
  vehicles.world = world;
  traffic = new Traffic(city, vehicles, world);
  // Settlement factor for traffic density: buildings within the cell's 3×3
  // chunk neighbourhood, saturating around a small-town block. A hamlet's
  // lane spawns the odd car; the same metres of asphalt in a sídliště spawn
  // a street's worth. Deterministic across clients — same tiles, same count.
  traffic.urbanAt = (x, z) => {
    let b = 0;
    const cx = Math.floor(x / 120), cz = Math.floor(z / 120);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      b += city.chunkIndex.get((cx + dx) + ',' + (cz + dz))?.buildings?.length ?? 0;
    return Math.min(1, 0.15 + b / 45);
  };
  // ---- the peers' vehicles (F8/F9) ----
  // Built even in single player: the fleet is empty, update() is a no-op over
  // an empty Map, and every `ghosts?.` site below then has one shape instead
  // of two. `world` is not optional — without it a ghost drives along y = 0,
  // i.e. through the riverbed under the Labe bridges.
  ghosts = makeGhostCars(vehicles);
  ghosts.world = world;
  // The vehicles WE own and already draw. A remote passenger whose reported
  // position sits on one of these rides it instead of having a duplicate car
  // built around him — which is what stops a friend in your passenger seat
  // from being wrapped in a second, z-fighting copy of your own Octavia.
  ghosts.localVehicles = () => {
    const l = [];
    if (game.car) l.push(game.car);
    if (player?.inCar && player.inCar !== game.car) l.push(player.inCar);
    for (const h of helis) l.push(h);
    return l;
  };
  minimap = new Minimap($id('minimap'), city);
  trains = new Trains(scene, city);
  worldMap = new WorldMap(city, minimap);
  initNavigation(city);   // lazy + optional; never blocks the boot
  peds = new Pedestrians(scene, city, world.terrain);
  // hit sounds ride the ragdoll callbacks: a scream at the point of impact
  // (gender rolled per victim), attenuated by distance like the debris audio
  peds.onPedHit = (p, v) => {
    if (v > 3) sfxAt(Math.random() < 0.5 ? 'scream_female' : 'scream_male',
      Math.min(1, 0.5 + v * 0.05), p.x, p.z, 180, 0.25);
  };
  peds.onPedKilled = (p) => sfxAt('crowd_panic', 0.7, p.x, p.z, 200, 4);
  clouds = new Clouds(scene, getSettings().cloudDist);
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
  // Flying machines live at airports now, not on the station forecourt:
  // Pardubice (LKPD) and Václav Havel Prague (LKPR), each with a pad, a
  // helicopter and a pair of Gripens on the apron. airfield.js owns the where.
  ({ helis, fighters } = buildAirfields(scene, world));
  heli = helis[0] ?? null;
  // the pod shares the interior manager's dust pool: one set of sprites does
  // rocket smoke, blast plume and the dust off a collapsing floor alike
  weapons = new Weapons(scene, world, { dust: world.interiors.dust });
  streaks = new SpeedStreaks(scene);
  // vehicles borrow the shared dust pool for exhaust + wreck smoke, and the
  // focus so only machines near the player breathe visible puffs
  vehicles.dust = world.interiors.dust;

  placeParkedCars(city);
  input.rpgMode = true;   // right-drag orbits the camera
  input.mouseLook = true; // locked pointer steers it too (settings can disable)
  orthoMgr = initOrtho(world.terrain);   // the photo lies ON the ground now
  // initSettings moved to start(): the gear must exist while the MENU is up,
  // before boot ever runs — boot only re-applies the loaded values to the
  // freshly built world.
  applySettings(getSettings());

  // warm up: build the spawn's neighbourhood before revealing the city.
  // Exceptions here used to vanish (setTimeout swallows them out of the
  // promise chain) and left the overlay spinning forever — route them out.
  // FULLY loaded, then play: every view cell built, terrain present and
  // conformed, queue quiet. The old 3×3 gate revealed the game with forty
  // cells still streaming, so the first minute of play was the loading
  // stutter. The failsafe cap stays (rim spawns can never conform), but at a
  // ceiling that means minutes, not the gate.
  let warmFrames = 0;
  const label = $id('enter-label');
  await new Promise((resolve, reject) => {
    const warm = () => {
      try {
        for (let i = 0; i < 6; i++) world.update(1 / 60, player.pos);
        if (label && (warmFrames & 7) === 0) {
          const { built, total } = world.bootProgress(player.pos);
          label.textContent = `Přijíždíte do Pardubic… ${Math.min(99, Math.round(built / total * 100))} %`;
        }
        if (world.readyFull(player.pos) || ++warmFrames > 1500) resolve();
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
    // motion blur lives in the composite pass, so it needs the post path up —
    // without it in this test, switching bloom AND rays off silently killed the
    // blur too, with the toggle still reading "on"
    const wantPost = game.mode === 'play'
      && (gs.bloom !== false || gs.rays !== false || gs.mblur !== false
        || gs.flare !== false);
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
      postfx.render(scene, camera, { ssao: false, bloom: gs.bloom !== false, rays, canopy: null,
        motionBlur: gs.mblur === false ? 0 : motionBlurAmount(),
        blurAniso: game.jet ? MB_ANISO_JET : MB_ANISO_GROUND,
        flare: gs.flare === false ? 0 : flareAmount() });
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

// What the ENGINE is doing, which is not what the pedal is doing — audio.js
// asks for load, and |gas| is not it. driveStep reads gas<0 as the BRAKE while
// rolling forward (reverse only once stopped) and gas>0 as the brake while
// rolling backwards, and it starves a wreck outright (damage ≥ 1 → gas ≤ 0).
// Passing |gas| meant standing on the brakes from 100 km/h sounded like being
// floored — the overrun voice audio.js models (darker, quieter, more pipe) was
// unreachable — and a totalled car sat motionless screaming at full throttle
// for as long as W was held. The handbrake is deliberately NOT counted: the
// engine really does pull against it, which is how the handbrake turn works.
function engineLoad(car, gas) {
  if ((car.damage ?? 0) >= 1) return 0;
  const s = car.speed ?? 0;
  if (gas > 0) return s < -0.05 ? 0 : Math.min(1, gas);
  if (gas < 0) return s > 0.05 ? 0 : Math.min(1, -gas);
  return 0;
}

function stepGame(dt) {
  if (game.mode !== 'play') return;

  // The day used to be integrated right here. It is now read, never written —
  // see the note on `game.tod`. Nothing replaced this line because nothing has
  // to: worldclock derives the hour from the shared wall clock on demand, so a
  // dropped frame, a backgrounded tab and a slow machine all land on the same
  // afternoon as everybody else instead of each keeping their own.

  // world streams around whoever leads the view. `onFoot` is what gates the
  // interior streamer: rooms only matter to somebody who can walk into them,
  // and building them for a car doing 130 km/h would be a hitch for nothing.
  const focus = game.car ?? player.pos;
  // STREAM WHERE YOU WILL BE, NOT WHERE YOU ARE. Everything downstream of this
  // point — chunk meshes, region tiles, the aerial photo — is keyed to one
  // focus, and centring it on the aircraft means a tile is only requested once
  // it is already under the nose. At 690 m/s a WMS round trip is a kilometre of
  // ground, which is exactly the bare grey hole you see ahead of a fast jet.
  // So the focus is pushed forward along the velocity vector by a couple of
  // seconds of travel: standing still it is the player, at Mach 2 it is 1.4 km
  // down the track, and the loader spends its budget on ground you are about
  // to fly over instead of ground already behind the wing.
  const lead = leadFocus(focus);
  world.update(dt, lead, { onFoot: !game.car && !game.heli && !game.jet });
  // Grass follows the EYE, not the streaming focus: the ring is 58 m across
  // and pushing it two seconds down the track would leave the player standing
  // in a bare circle at any speed.
  grass?.update(focus.x, focus.z, dt);

  if (game.jet) {
    // Same hands as the helicopter, and the same hands GTA trained everyone's
    // fingers on: W/S is the ENGINE, the arrows are the attitude. ↓ pulls the
    // nose up (stick back), ↑ pushes it down, ←/→ roll. It is not how a stick
    // is labelled in a cockpit, but it is how every player already expects an
    // aircraft to fly, and consistency with the machine parked next to it on
    // the apron matters more than the label.
    const k = input.keys;
    const jet = game.jet;
    if (k.has('KeyW')) jetThrottle = Math.min(1, jetThrottle + dt * 0.8);
    if (k.has('KeyS')) jetThrottle = Math.max(0, jetThrottle - dt * 0.9);
    if (k.has('ShiftLeft') || k.has('ShiftRight')) jetThrottle = 1;
    jet.update(dt, {
      // aircraft.js takes pitch +1 = nose UP, so ArrowDown is the +1
      pitch: (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0),
      roll:  (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0),
      // A/D stay useful: the rudder in the air, the nosewheel on the ground
      yaw:   (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      throttle: jetThrottle,
      brake: k.has('Space') ? 1 : 0,
    }, world);
    player.update(dt, { input, camYaw, world });   // stays glued to the cockpit
    jetSet?.(jetThrottle, Math.min(1, jet.speed / 690), jet.reheat);
    windSet?.(jet.speed);
    windLoad?.(jet.gLoad ?? 0);
    // aircraft.js owns "am I supersonic" so the bang and the vapour cone are
    // one event; this just plays the bang. Loud, because it is competing with
    // an afterburner four metres away.
    if (jet.justWentSupersonic) sfx('jet_boom', 1.0);
    // Landing: the tyres bite once, then the brakes grind until you are slow.
    // `_wasAir` is the edge detector — touchdown is a transition, not a state.
    if (jetWasAir && !jet.airborne) sfx('tyre_touchdown', Math.min(1, jet.speed / 90));
    jetWasAir = jet.airborne;
    if (!jet.airborne && k.has('Space') && jet.speed > 14) {
      if (!jetBraking) { jetBraking = true; sfx('jet_brake', 0.85); }
    } else jetBraking = false;
  } else if (game.heli) {
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
    // ABSOLUTE m/s, not a 0..1 — the fix for the engine hanging at redline.
    // CAR.vmax is the generic 38 m/s (137 km/h) from config.js, but the KINDS
    // that vehicles.js actually drives run to 64 (Octavia), 69 (BMW), 72
    // (Tesla), so |speed|/CAR.vmax saturated at 137 km/h and every tone above
    // that froze — the last 90 km/h of an Octavia was one held note. main.js
    // cannot divide by the right number either (car objects carry no vmax and
    // vehicles.js exports none), but audio.js was told the KIND at
    // engineStart() and has the top speed in its own table, so the caller now
    // hands over metres per second and audio.js normalizes per kind. Shift
    // points and the ducking thresholds live there in m/s and are unchanged.
    engineSet(Math.abs(game.car.speed), engineLoad(game.car, gas));
    // Tyre hiss under the engine — and gravel once the wheels leave the road.
    // Deliberately NOT rescaled per kind: this one is not a rev counter, it is
    // road roar, which is a function of the road and the rubber and not of
    // which car is on top of them. 40 m/s (144 km/h) is where it is already
    // as loud as it should get in the mix; a Tesla at 250 km/h does not need
    // to be 1.8× louder than a van at 130, it needs the same wall of noise.
    tireSet(Math.min(1, Math.abs(game.car.speed) / 40), game.car.offroad ?? 0);
    // …and over the top of both, the air. Fed raw m/s: audio.js owns where the
    // wind starts (47 km/h) and where it is everything (223), because those are
    // properties of moving through air rather than of this car.
    roadWindSet(Math.abs(game.car.speed));
  } else {
    player.update(dt, { input, camYaw, world });
  }
  // WHERE THE EARS ARE. Positioned one-shots (horns, crashes, debris, screams)
  // attenuate against this, and it must be set every frame from something that
  // always exists — it used to be forwarded by the interiors streamer, so
  // switching interiors off in the settings silently made the whole city play
  // at full volume regardless of distance.
  const ears = game.car ?? game.heli ?? game.jet ?? player.pos;
  camera.getWorldDirection(_earDir);
  setListener(ears.x, ears.z, _earDir.x, _earDir.z);
  // …and the engines of whatever is close enough to pick out of the traffic.
  // The pool takes the nearest few and steals from the furthest, so handing it
  // everything within a couple of hundred metres is both cheap and correct —
  // it does the ranking, because it is the one that knows how many voices it
  // has. Off the road entirely (in the air, in a menu) they all stop.
  if (game.mode === 'play' && traffic && !game.jet && !game.heli) {
    _voiceCars.length = 0;
    for (const c of traffic.cars) {
      if (c === game.car) continue;                 // that one is engineSet's
      const dx = c.x - ears.x, dz = c.z - ears.z;
      if (dx * dx + dz * dz < VOICE_SCAN2) {
        _voiceCars.push({ id: c._id ?? c.uid ?? c, kind: c.kind,
          x: c.x, z: c.z, speed: Math.abs(c.speed), load: engineLoad(c, 0.35) });
      }
    }
    engineVoices(_voiceCars);
  } else engineVoicesStop();
  vehicles.update(dt);
  // The peers' cars move BEFORE anything that reads them this frame: the AI
  // traffic brakes for them (traffic.actors), the seat resolver hangs remote
  // avatars off them (remoteSeatAnchor, called from inside net.update), and
  // both want this frame's pose rather than last frame's.
  pumpGhosts(dt);
  // One look, both crowds. This is the fix for "auta a chodci se z ničeho nic
  // objevují a mizí": without it traffic.js reaps a car the moment its shift
  // expires and pedestrians.js spawns from 18 m out, both of them in plain
  // sight. With it, neither module makes a lifecycle decision inside this cone.
  // It has to precede BOTH update() calls — a setViewer() after the fact would
  // describe the frame the pop already happened in.
  const view = viewerState();
  traffic.setViewer(view);
  peds.setViewer(view);
  traffic.actors = updateActors();
  traffic.blockers = updateBlockers();
  traffic.update(dt, player.pos, game.car);
  // ragdoll physics needs to know what can hit a pedestrian: every SHARED AI
  // car plus whatever the player is driving, refreshed per frame because the
  // player's car changes identity on every E. Ghosts are filtered out here and
  // not in pedestrians.js on purpose — traffic.cars is main.js's wiring, and
  // pedestrians.js has no business knowing traffic.js has two kinds of car.
  peds.cars = sharedCars();
  peds.playerCar = game.car;
  peds.update(dt, focus);
  trains?.update(dt, focus);
  for (const h of helis) if (h !== game.heli) h.update(dt, { pitch: 0, roll: 0, yaw: 0, lift: 0 }, world);
  for (const j of fighters) if (j !== game.jet) j.update(dt, { throttle: 0 }, world);
  // There are machines at two airports now, but everything downstream — the
  // E hint, the map icon, the net layer's seat anchor — means "the helicopter
  // I am dealing with". Keep that pointing at the one being flown, else the
  // nearest parked one.
  heli = game.heli ?? nearestParked(helis, player.pos.x, player.pos.z, Infinity);
  jetNearest = game.jet ?? nearestParked(fighters, player.pos.x, player.pos.z, Infinity);
  weapons?.update(dt, { cars: _blastList(), peds });
  updateAim(dt);
  clouds?.update(dt, camera, sky?.sunDir, sky?.nightK ?? 0);
  if (traffic) {
    // Shared clock in, shared fleet out. No per-player place factor any more
    // (see the note above trafficTimeK) — this product must be computable from
    // facts both clients hold, and "how built-up it is where I am standing" is
    // not one of them.
    const base = getSettings().traffic ?? 60;
    traffic.maxCars = Math.round(base * trafficTimeK(tod()));
  }
  updateNavigation(dt);
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

  vehicles.focus = focus;
  // speed lines for whichever machine the player is actually in
  if (game.car) {
    const c = game.car, fx2 = -Math.sin(c.heading), fz2 = -Math.cos(c.heading);
    streaks?.update(dt, c.x, (c.mesh?.position.y ?? 0) + 0.9, c.z,
      fx2 * c.speed, 0, fz2 * c.speed);
  } else if (game.jet) {
    // the jet's velocity is along its nose (it does not fly sideways), and the
    // vertical component matters here — a vertical climb should streak too
    const j = game.jet, cp = Math.cos(j.pitch);
    streaks?.update(dt, j.x, j.y, j.z,
      -Math.sin(j.heading) * cp * j.speed,
      Math.sin(j.pitch) * j.speed,
      -Math.cos(j.heading) * cp * j.speed);
  } else if (game.heli) {
    const h = game.heli;
    streaks?.update(dt, h.x, h.y + 0.6, h.z, h.vx ?? 0, h.vy ?? 0, h.vz ?? 0);
  } else {
    streaks?.update(dt, 0, 0, 0, 0, 0, 0);
  }

  updateCamera(dt);
  placeReticle();          // after the camera: a lagging sight reads as drift
  updateSky(sky, tod(), camera, scene);
  updateHud(dt);

  // ---- net: server co-op pump (menu → Multiplayer only; null in single) ----
  // One call does everything network: our state out at ~10 Hz, remote citizens
  // walked/interpolated, peers' rocket detonations replayed here, and the name
  // tags over their heads (netcity owns the NameTags instance and pumps it at
  // the end of its own update, so the tag can never trail its owner by a
  // frame). `camera` is in the context for the tags: they are sprites scaled
  // off view distance, and passing it explicitly beats netcity's
  // window.__atc.camera fallback. In single player `net` is null and no
  // NameTags is ever constructed — nobody to label, nothing to draw.
  //
  // `trains` is in the context because netcity derives the vehicle descriptor
  // from it: a train ride leaves player.inCar null, so before this a commuter
  // appeared to every other client as a man sprinting down the rails at 140.
  // netcity falls back to window.__atc.trains without it; passing it properly
  // is the difference between a contract and a global.
  if (net) {
    if (_myHeliClaim >= 0) {
      // Re-announce, so a player who joined after take-off still knows the
      // machine is taken. An event, not a lease: nobody has to answer.
      _heliClaimT -= dt;
      if (_heliClaimT <= 0) {
        _heliClaimT = CLAIM_REANNOUNCE_S;
        queueEvent('heli_claim', { i: _myHeliClaim, on: 1 });
      }
    }
    if (_myParkClaim >= 0) {
      _parkClaimT -= dt;
      if (_parkClaimT <= 0) {
        _parkClaimT = CLAIM_REANNOUNCE_S;
        queueEvent('park_claim', { i: _myParkClaim, on: 1 });
      }
    }
    net.update(dt, { scene, player, game, weapons, world, camera, trains,
      cars: _crashList(), peds });
  }
}

// ---------- the peers' vehicles, one frame's worth ------------------------
// netcity does not know netvehicles exists (deliberately: one owns the wire,
// the other owns meshes), so main.js is the joint. Two rules make it correct:
//
//  1. sync() is called ONLY on a new packet. netcity replaces r.state — and
//     with it r.state.veh — wholesale for every packet, so comparing the veh
//     object by IDENTITY is an exact "is this new?" test. Calling sync() every
//     frame would work, but it resets the ghost's dead-reckoning age, which
//     silently turns off extrapolation and parks every peer's car a couple of
//     metres behind where its driver actually is.
//  2. A peer who stepped out sends veh:null, which sync() reads as "drop" —
//     so getting out of a car is handled by the same path as leaving the room,
//     and neither leaves an abandoned Škoda idling in the street.

// A car derives its own altitude from the road under it, so the wire does not
// carry one. An AIRCRAFT must, or the ghost flies along y = 0 and the seat
// anchor built on it drags the pilot's avatar through the riverbed.
//
// netcity's descriptor now sends `y` for both flying classes, so on a current
// peer this returns its argument untouched — which is what the note that used
// to live here predicted it would become. It stays as a COMPATIBILITY SHIM for
// a peer running the older client: the altitude was always in the packet, just
// not in the descriptor (player.js mirrors `this.y = this.inCar.y` for a seated
// rider), so the state's own `y` reconstructs it to the metre.
function heliAltitude(veh, state) {
  if (!veh || (veh.k !== 'heli' && veh.k !== 'jet') || Number.isFinite(veh.y)) return veh;
  if (!Number.isFinite(state?.y)) return veh;
  return { ...veh, y: state.y };
}

function pumpGhosts(dt) {
  if (!ghosts) return;
  if (net) {
    for (const [uid, r] of net.remotes) {
      const veh = r.state?.veh ?? null;
      if (veh === _ghostVeh.get(uid)) continue;
      // The ORIGINAL object is what the dedupe remembers, even when what we
      // hand to sync() is a patched copy — otherwise the patch itself looks
      // like a new packet every frame.
      _ghostVeh.set(uid, veh);
      ghosts.sync(uid, heliAltitude(veh, r.state));
    }
    // Reap anyone netcity has already forgotten (a leave, or the 30 s silence
    // reap). ghosts has its own 35 s backstop, but a friend who says goodbye
    // should not leave his car standing in the road for half a minute.
    //
    // Deliberately NOT gated on `_ghostVeh.size > net.remotes.size`: one player
    // leaving while another joins in the same frame leaves the sizes equal and
    // the departed car parked in the street forever. The scan is over a map
    // that holds at most a roomful of entries.
    for (const uid of [..._ghostVeh.keys()]) {
      if (net.remotes.has(uid)) continue;
      _ghostVeh.delete(uid);
      // Release BEFORE dropping the ghost, not after: setParkClaim's whole job
      // is to stand the car where the driver left it, and it reads that spot
      // from ghosts.pose(uid) — which drop() has just deleted. Getting this
      // backwards is not a crash, it is the car silently teleporting back to
      // its spawn bay every time somebody's connection dies.
      const pk = _parkClaims.get(uid);
      if (pk !== undefined) setParkClaim(uid, pk, false);
      ghosts.drop(uid);
      if (_heliClaims.delete(uid)) applyHeliVisibility();
    }
  } else if (_ghostVeh.size) {
    // the session ended under us — let go of every proxy
    for (const uid of [..._parkClaims.keys()]) setParkClaim(uid, _parkClaims.get(uid), false);
    for (const uid of _ghostVeh.keys()) ghosts.drop(uid);
    _ghostVeh.clear();
    if (_heliClaims.size) { _heliClaims.clear(); applyHeliVisibility(); }
  }
  ghosts.update(dt);
}

// ---------- menu gate ----------
// The game no longer boots straight into the city: the main menu (js/menu.js)
// decides single player vs the shared dedicated server first. Settings come up
// BEFORE the menu so the ⚙️ gear works on it; the multiplayer path connects the
// transport before boot so the world never streams for a connection that then
// fails — and if the server dies between the menu's health check and the click,
// we fall back to single player rather than to a dead screen.
let net = null;   // NetGame from netcity.js, or null — single player stays null

// ---------- F8: where a remote player's body goes ---------------------------
// THE OLD CODE, AND WHY IT COULD NOT WORK. A peer's state carried {k, id, seat}
// where id = hash(kind + ':' + colour), and this function looked that id up in
// OUR parked/traffic pools. The comment above it claimed "the same car exists
// on both clients because traffic spawns are relayed" — traffic spawns were
// never relayed, and even now that traffic is a shared SCHEDULE, a car the peer
// stole and drove away is not in our pools under any identity, because the
// object he is sitting in is his client's object. Worse, that id is a TYPE, not
// an identity: ~90 live cars collapse onto ~35 distinct ids, so the lookup
// usually SUCCEEDED — against an unrelated Fabia half a district away. The
// avatar was then glued to a stranger's car and drove off on its own.
//
// THE FIX IS TO STOP LOOKING ANYTHING UP. netvehicles.js builds one proxy per
// uid from the wire fields, positioned by the one client that actually
// simulates that vehicle, and hands back a real seat on it. A passenger riding
// something we already draw (our own car, or another peer's ghost) binds to it
// instead of getting a duplicate built around him — that is netvehicles' job,
// not ours, and `ghosts.localVehicles` in boot() is what tells it about ours.
//
// Returns the world-space CUSHION TOP; netcity subtracts its own SIT_DROP to
// get the citizen group's feet. null means "we cannot place them" and netcity
// leaves them standing at the position they reported, which already mirrors
// their vehicle — the correct degradation, and the one a train rider gets
// (netvehicles refuses k:'train' by design).
function remoteSeatAnchor(uid, veh) {
  if (!veh || !ghosts) return null;
  return ghosts.seatAnchor(uid, veh.st ?? veh.seat ?? 0);
}

// ---------- inbound one-shot events ---------------------------------------
// netcity owns `boom` (a peer's rocket) inside its own handler. Everything
// else in the room's event vocabulary is main.js's business, because it is
// about objects main.js owns: walls, helicopters, traffic slots.
//
// This CHAINS the existing handler rather than replacing it. netcity registers
// its own on construction and exposes no "add a listener" seam, so the previous
// one is captured and called first — replacing it outright would silently stop
// every peer's rocket from going off in our world. See the request list.
function installEventHandler() {
  const prev = CityNetWS._handlers?.event ?? null;
  CityNetWS.onEvent((ev) => {
    try { prev?.(ev); } catch (err) { console.error(err); }
    try { onNetEvent(ev); } catch (err) { console.error(err); }
  });
  // The damage a peer's CAR does to a wall (F20). vehicles.js emits through a
  // sink rather than importing the net layer, so single player and the tests
  // keep working with no netcity in the build at all; the sink is a rate-
  // limited token bucket at the source, because every event we send becomes a
  // demolition on every other machine in the room.
  setVehicleEventSink((type, data) => queueEvent(type, data));
  // A late joiner inherits the wreckage. Only the authority answers, so twenty
  // people in the room do not all reply to one arrival with a 15 KB snapshot.
  CityNetWS.onPeer((m) => {
    if (m?.event !== 'join' || CityNetWS.role !== 'host') return;
    if (world?.hitLog?.length) CityNetWS.sendSnap(world.hitLog);
  });
  CityNetWS.onSnap((snap) => { world?.applyHits?.(snap); });
}

function onNetEvent(ev) {
  if (!ev || typeof ev !== 'object') return;
  switch (ev.type) {
    // A peer rammed a wall. NOT weapons.detonate: a car hitting a shopfront is
    // not a rocket — no shake, no fireball, no scattered burning debris, just
    // the same hole in the same wall. applyHit is the one door for that, and it
    // queues the damage against onTileLoaded if the tile has not streamed in
    // here yet, so a hit two districts away still lands when you drive there.
    case 'vhit':
      world?.applyHit?.({ x: ev.x, y: ev.y, z: ev.z, r: ev.r, id: ev.id });
      break;
    // F22 — somebody took (or released) a helicopter.
    case 'heli_claim':
      if (typeof ev.from === 'string') setHeliClaim(ev.from, ev.i, !!ev.on);
      break;
    // …and the same for one of the spawn-fleet cars. `from` is stamped by the
    // relay (server-city/room.js onEvent puts it on LAST, so a client cannot
    // sign a claim with somebody else's uid) — without it a release could be
    // forged for a car another player is driving.
    case 'park_claim':
      if (typeof ev.from === 'string') setParkClaim(ev.from, ev.i, !!ev.on);
      break;
    // A peer yanked open the door of an AI car. Our copy of that schedule slot
    // has to die, or we keep driving a phantom of the car he is now sitting in
    // — through him, on the road he is on. claimSlot works even for a slot we
    // never built (he may be beyond our streaming frontier).
    case 'steal':
      if (typeof ev.key === 'string') traffic?.claimSlot?.(ev.key);
      break;
    default: break;
  }
}

async function start() {
  initSettings(applySettings);
  initDev();                 // ?devmode only — attaches to that panel
  // Begin from the local clock while the menu is open. Multiplayer replaces
  // this with the server epoch; single player is phased to 06:00 below.
  setEpoch(null);
  // The HUD comes up BEFORE the socket, because the thing it most needs to be
  // able to say is that the socket did not come up.
  ui = makeNetUI();
  const choice = await showMenu();
  ui.setSelf({ name: choice.name || getPlayerName(), uid: localUid() });
  if (choice.mode === 'server') {
    try {
      // The nickname goes in BEFORE the socket, not after: connectCity arms it
      // module-side so it rides in the very first state packet. Peers who are
      // already in the room learn our name from that packet (≤100 ms) because
      // WELCOME carries uids only — a beat of "Hráč 4f2a" is the price of not
      // having to redeploy the relay, which never looks inside `state`.
      // menu.js has already sanitized it and netcity sanitizes it again on the
      // way out and a third time on every packet in; none of those trusts the
      // one before it, and none of them is the one that matters.
      net = await connectCity(choice.name);
      net.onRemoteVehicle = remoteSeatAnchor;
      net.onStatus((s) => ui.setStatus(s));
      net.onClose((info) => {
        // A dead socket used to change NOTHING on screen: the avatars simply
        // stopped moving and the player carried on driving round a city they
        // believed was shared. Now it says so, and keeps saying so.
        ui.setStatus({ online: false, count: 0, names: [] });
        if (!info?.expected) ui.toast('Server spadl — pokračuješ sám', 'error');
        // every proxy dies with the session; pumpGhosts finishes the job on
        // the next frame once `net` goes null, this covers the socket dropping
        // while the session object is still alive
        for (const uid of [..._parkClaims.keys()]) setParkClaim(uid, _parkClaims.get(uid), false);
        for (const uid of _ghostVeh.keys()) ghosts?.drop(uid);
        _ghostVeh.clear();
        if (_heliClaims.size) { _heliClaims.clear(); applyHeliVisibility(); }
      });
      installEventHandler();
      // showNames/nameDist are applied by boot()'s own applySettings() a moment
      // from now, which is the only place that call has to exist.
    } catch (err) {
      // A banner, not a console line. "Multiplayer nefunguje" was the single
      // most common report, and the reason was always visible in a console
      // nobody had open — the game simply started, in silence, alone.
      console.error('Multiplayer: připojení selhalo — spouštím jednohráčovku.', err);
      net = null;
      ui.toast('Server je nedostupný — hraješ sám', 'error');
    }
  }
  if (!net) {
    // Every fresh single-player world starts at dawn. This is applied only
    // after the menu choice (and also after a failed server connection), so it
    // cannot disturb the shared multiplayer clock. Setting it before boot
    // also makes every deterministic subsystem initialise against dawn.
    setSoloTime(6 / 24);
    ui.setStatus({ online: null });   // single player: no LED, no lie
  }
  await boot();
  // Loading terrain can take several real seconds, which are several in-game
  // minutes in a 24-minute day. Re-anchor once the world is actually ready so
  // the first playable frame—not merely the start of loading—reads 06:00.
  if (!net) setSoloTime(6 / 24);
}
// Leaving the tab is the ordinary way a session ends here, so say goodbye
// properly: net.dispose() drops every remote avatar (and with it every name
// tag sprite, material and canvas texture), then sends BYE so the relay tells
// the others we left instead of making them wait out the 30 s reap. 'pagehide'
// rather than 'beforeunload' because Safari and every mobile browser fire it
// on the bfcache path too, where beforeunload simply never runs. Guarded and
// nulled: single player has no `net`, and a second pagehide must not resend.
window.addEventListener('pagehide', () => {
  if (!net) return;
  const n = net; net = null;
  // Let go of our helicopter on the way out, so the machine is not left locked
  // to a uid that will never speak again. It rides in the same BYE flush.
  // Sent straight down the transport, not through queueEvent: the outbox is
  // drained by NetGame.update() and there is no next frame from here.
  try {
    if (_myHeliClaim >= 0) CityNetWS.sendEvent({ type: 'heli_claim', i: _myHeliClaim, on: 0 });
    if (_myParkClaim >= 0) CityNetWS.sendEvent({ type: 'park_claim', i: _myParkClaim, on: 0 });
  } catch {}
  _myHeliClaim = -1;
  _myParkClaim = -1;
  // The sink outlives the session object (it is module state in vehicles.js),
  // so unhook it or every wall a car hits after this queues into an outbox
  // nobody drains.
  try { setVehicleEventSink(null); } catch {}
  try { n.dispose(); } catch {}
  // drop the proxies but keep the fleet itself alive: bfcache can restore this
  // page, and a disposed ghost API would be a broken game rather than a lonely
  // one. pumpGhosts sees `net === null` next frame and finishes the cleanup.
  try { for (const uid of [..._parkClaims.keys()]) setParkClaim(uid, _parkClaims.get(uid), false); } catch {}
  for (const uid of _ghostVeh.keys()) { try { ghosts?.drop(uid); } catch {} }
  _ghostVeh.clear();
  if (_heliClaims.size) { _heliClaims.clear(); try { applyHeliVisibility(); } catch {} }
});

start().catch(err => {
  $id('enter-label').textContent = 'Chyba při načítání města: ' + err.message;
  console.error(err);
});
tick();

// dev/debug handle — lets an automated harness (or the console) inspect and
// drive the game: window.__atc.player.pos, __atc.input.keys, __atc.game.car…
window.__atc = {
  build: 'v16-coop-shared-world',   // bump on risky changes — which code a tab runs
  game, input, renderer, scene, camera, stepGame,
  fps: 0, frameMs: 0,
  // `cabin` is the graft's live truth, not a copy of fpView: a harness can
  // assert the interior really came off after a wreck or an exit at speed
  cam: () => ({ camDist, camPitch, camYaw, fpView, fpPitch, near: camera.near,
    cabin: !!_cabinCar }),
  // The exact snapshot traffic.js and pedestrians.js are gating their lifecycle
  // on, so a harness can assert the cone is live (and is the SAME one) instead
  // of inferring it from pops. A copy: the real record is mutated in place.
  viewer: () => { const v = viewerState(); return v && { ...v }; },
  get weapons() { return weapons; },
  get interiors() { return world?.interiors; },
  get postfx() { return postfx; },
  get heli() { return heli; }, get clouds() { return clouds; },
  get player() { return player; }, get world() { return world; },
  get traffic() { return traffic; }, get vehicles() { return vehicles; },
  get parked() { return parked; }, get peds() { return peds; },
  get trains() { return trains; }, get worldMap() { return worldMap; },
  // multiplayer session (null in single player). net.onRemoteVehicle is wired
  // to the ghost fleet: a harness asserting "my friend is in a car" should ask
  // __atc.ghosts.pose(uid), not go looking for the car in traffic.
  get net() { return net; },
  get ghosts() { return ghosts; }, get ui() { return ui; },
  get uid() { return localUid(); },
  // the shared clock, so a harness can prove two tabs agree on the hour
  get tod() { return tod(); }, get heliClaims() { return [..._heliClaims]; },
};
