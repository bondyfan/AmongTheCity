// ---- the sound of cars: what main.js calls ------------------------------------
// One door for everything a car contributes to the mix.
//
//   engine, traffic, setts, brakes, impacts   synthesised in an AudioWorklet
//       (public/worklets/), driven from here through js/carvoices.js
//   tyre roll, wind, skid                     the recorded layers js/audio.js
//       already had, still played there, fed from here
//   the cabin                                 audio.js setCabin(): the world
//       through glass, while the worklet gives the player's engine more boom
//
// Three things keep the old voices of audio.js alive. The electric kinds
// (tesla, trolleybus) have no combustion cycle and keep their motor whine. A
// browser without AudioWorklet, or a worklet that fails to load, falls back to
// the old piston synth so the game is never silent. And the offline renderer
// (dev/audiorender.html) can ask for the old engine to compare against.
//
// Headless-safe: nothing here touches window or WebAudio until audio.js has a
// running context, so node --test can import whatever imports this.

import {
  audioGraph, setCabin, engineDuck, setCrashSynth, engineStart, engineStop, engineSet,
  engineVoices, engineVoicesStop, tireSet, roadWindSet, skidSet, carAudioStop, sfx,
} from './audio.js';
import { CarVoices } from './carvoices.js';
import { engineKey } from './enginekinds.js';
import { cobbleAt } from './roadsurface.js';

const OUT_GAIN = 0.55;           // the worklet against the rest of the mix
const PROBE_EVERY = 0.1;         // s between looks at the road under the player

let stage = 0;                   // 0 not asked, 1 loading, 2 ready, -1 no worklet
let node = null, voices = null;
let kind = null;                 // the kind the player is driving, null on foot
let onNew = false, onOld = false;   // which engine voice is running for the player
let forceOld = false;
let player = null;               // this frame's state of the player's car
const pl = { speed: 0, throttle: 0, slip: 0, brake: 0, cobble: 0 };
let cob = 0, cobT = 0, probeT = 0, rr = 0;
const ears = { x: 0, z: 0, dx: 0, dz: 1 };
const notTram = (c) => c.kind !== 'tram';

/** Load the worklet as soon as there is a context to load it into. */
function boot() {
  if (stage !== 0) return;
  const g = audioGraph();
  if (!g) return;
  if (!g.ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') { stage = -1; return; }
  stage = 1;
  g.ctx.audioWorklet.addModule('worklets/car-worklet.js').then(() => {
    node = new AudioWorkletNode(g.ctx, 'car-voices',
      { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    const out = g.ctx.createGain();
    out.gain.value = OUT_GAIN;
    node.connect(out); out.connect(g.master);
    voices = new CarVoices((m) => node.port.postMessage(m));
    setCrashSynth((k) => { if (stage !== 2 || forceOld) return false; voices.hit(k); return true; });
    stage = 2;
    if (kind) startVoice();          // the player got in while it was loading
  }).catch(() => { stage = -1; if (kind) startVoice(); });
}

function startVoice() {
  const piston = !!engineKey(kind);
  if (stage === 2 && !forceOld) {
    voices.playerStart(kind);        // an EV still gets its road layer here
    onNew = true;
    if (!piston) { engineStart(kind); onOld = true; }
  } else if (stage === -1 || forceOld || !piston) {
    engineStart(kind); onOld = true;
  }
  // stage 1 with a piston engine: wait for the worklet rather than start the
  // old voice and swap a second later. engine_start.mp3 covers the gap.
}

/** The player took the wheel. kind is the car's runtime kind. */
export function carStart(k) {
  kind = k; onNew = onOld = false;
  boot();
  startVoice();
}

/** The player left the car, by the door or through the windscreen. */
export function carStop() {
  kind = null; player = null;
  if (onNew) voices?.playerStop();
  onNew = onOld = false;
  engineStop();                      // the old voice, if that is what was running
  engineDuck(0);
  carAudioStop();                    // roll, wind, skid
  setCabin(0);
  cob = cobT = 0;
}

/**
 * Every frame at the wheel, after driveStep.
 *   load   0..1, what the engine is asked for (main.js engineLoad)
 *   gas    the pedal axis, -1..1 (negative is the brake while rolling forward)
 *   hb     the handbrake
 *   city   world.city, for the surface under the wheels
 */
export function carDrive(dt, car, load, gas, hb, city) {
  const v = Math.abs(car.speed) || 0, vg = car.vGround ?? v;
  const off = car.offroad ?? 0;
  if ((probeT -= dt) <= 0) { probeT = PROBE_EVERY; cobT = off > 0.5 ? 0 : cobbleAt(city, car.x, car.z); }
  cob += (cobT - cob) * Math.min(1, dt * 9);
  tireSet(vg, off, forceOld ? 0 : cob);
  roadWindSet(vg);
  skidSet(car.slip01 ?? 0, off);
  if (onOld) engineSet(v, load);     // carries the duck for the old voice itself
  else engineDuck(v);
  let brake = gas < 0 && car.speed > 0.05 ? -gas : gas > 0 && car.speed < -0.05 ? gas : 0;
  if (hb && brake < 0.5) brake = 0.5;
  pl.speed = v; pl.throttle = load; pl.slip = car.slip01 ?? 0;
  pl.brake = (car.damage ?? 0) >= 1 ? 0 : brake; pl.cobble = cob;
  player = pl;
}

/**
 * Every frame, driving or not, after the listener is known.
 *   traffic  [{ id, kind, x, z, speed, load }] near the ears, or null to hush it
 *   cabin    true while the camera sits in the driver's seat
 */
export function carAudioFrame(dt, traffic, ex, ez, dirX, dirZ, cabin, city) {
  boot();
  const L = Math.hypot(dirX, dirZ) || 1;
  ears.x = ex; ears.z = ez; ears.dx = dirX / L; ears.dz = dirZ / L;
  const cab = cabin && kind ? 1 : 0;
  setCabin(forceOld ? 0 : cab);        // the old game had no cabin at all
  if (stage === 2 && !forceOld) {
    voices.frame(dt, onNew ? player : null, cab, traffic, ears);
    // one voiced car a frame is asked what it is driving on: every car is
    // looked at about seven times a second, for the price of a single probe
    const st = voices.state[1 + (rr = (rr + 1) % (voices.state.length - 1))];
    if (st && city) st.cobT = cobbleAt(city, st.x, st.z);
  } else if (traffic) engineVoices(traffic.filter(notTram));   // the old pool has no tram
  else engineVoicesStop();
  player = null;
}

// Your own horn used to be a different car's horn on every press, now and then
// a lorry's. A car has one horn: the same sample each time, at this kind's pitch.
const HORN_PITCH = { octavia: 1, fabia: 1.06, bmw: 0.95, mercedes: 0.92, tesla: 1.03, van: 0.9 };
const HEAVY_HORN = new Set(['truck', 'semi', 'bus', 'trolleybus']);
export function carHorn() {
  if (HEAVY_HORN.has(kind)) sfx('truck_horn', 0.8, 1);
  else sfx('car_horn_short', 0.7, HORN_PITCH[kind] ?? 1);
}

/** For the renderer and for tests: run the old engine voice on purpose. */
export function carAudioForceOld(on) { forceOld = !!on; }
/** 'loading' | 'ready' | 'none' | 'off', and the player's drivetrain when ready. */
export function carAudioState() {
  return { stage: ['off', 'none', 'loading', 'ready'][stage + 1], drivetrain: onNew ? voices?.player : null, voices };
}
