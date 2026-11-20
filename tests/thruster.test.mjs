// ---- the Roadster's voice, heard by a test ------------------------------------
// The third class of car voice (js/enginekinds.js THRUST_KINDS): electric
// motors that whine with the road speed, and cold gas thrusters that hiss and
// roar on a hard push until their tank is empty. js/thrustdrive.js decides what
// the car is doing, public/worklets/thrusterdsp.js makes the sound, and both
// run here exactly as they run in the game. What is pinned is what an ear
// would notice: the kind gets ITS voice and not an Octavia's, the whine climbs
// with speed and never falls, the thrusters are there at a launch and gone at
// a cruise, and nothing clips.

import test from 'node:test';
import assert from 'node:assert';
import { ThrusterVoice, THRUSTER_DEFAULTS } from '../public/worklets/thrusterdsp.js';
import { EngineVoice, svf } from '../public/worklets/enginedsp.js';
import * as MIX from '../public/worklets/carmixer.js';
import * as CV from '../js/carvoices.js';
import { makeThrustDrive, thrustStep, THRUST_DEFAULTS } from '../js/thrustdrive.js';
import { THRUST_KINDS, ENGINE_KINDS, ROLLING_KINDS, engineKind, engineKey, voiceKey, voiceClass, vehicleVoice } from '../js/enginekinds.js';

const SR = 48000, KMH = 1 / 3.6, DT = 1 / 60;
const K = THRUST_KINDS.roadster, RPM = THRUST_DEFAULTS.rpmPerMs;
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };

/** One voice held at a state for `seconds`, levelled the way the mixer levels it. */
function voice({ kmh = 100, load = 0.3, thrust = 0, cabin = 0, seconds = 1, seed = 3 } = {}) {
  const probe = new ThrusterVoice(SR, K.thr, 1), v = new ThrusterVoice(SR, K.thr, seed);
  v.norm = probe.calibrate();
  v.set(kmh * KMH * RPM, load, thrust, cabin);
  const n = Math.round(SR * seconds), out = new Float32Array(n);
  for (let o = 0; o < n; o += 128) v.render(out.subarray(o, Math.min(n, o + 128)), Math.min(128, n - o));
  return out;
}
/** RMS of x through a bandpass at fc (second half of the buffer: the filter has settled). */
function band(x, fc, q = 8) {
  const c = svf(fc, q, SR);
  let a = 0, b = 0, s = 0, n = 0;
  for (let i = 0; i < x.length; i++) {
    const v3 = x[i] - b, v1 = c.a1 * a + c.a2 * v3, v2 = b + c.a2 * a + c.a3 * v3;
    a = 2 * v1 - a; b = 2 * v2 - b;
    if (i >= x.length >> 1) { s += (v1 * c.k) ** 2; n++; }
  }
  return Math.sqrt(s / n);
}
/** Lag of the strongest self-similarity between lo and hi samples, to a fraction of a sample. */
function period(x, lo, hi, from = SR / 2 | 0, len = 8192) {
  const r = (lag) => { let s = 0; for (let i = from; i < from + len; i++) s += x[i] * x[i + lag]; return s; };
  let best = -Infinity, at = lo;
  for (let lag = lo; lag <= hi; lag++) { const s = r(lag); if (s > best) { best = s; at = lag; } }
  const a = r(at - 1), b = r(at), c = r(at + 1), d = a - 2 * b + c;
  return at + (d < 0 ? 0.5 * (a - c) / d : 0);
}
function mixer() {
  const m = new MIX.CarMixer(SR);
  const v = new CV.CarVoices((msg) => m.message(msg instanceof Float32Array ? msg.slice() : structuredClone(msg)));
  return { m, v };
}
function play(m, v, seconds, frame) {
  const n = Math.round(SR * seconds), L = new Float32Array(n), R = new Float32Array(n);
  let done = 0;
  for (let f = 0; done < n; f++) {
    frame(f / 60, DT);
    const until = Math.min(n, Math.round((f + 1) * SR / 60));
    while (done < until) { const k = Math.min(128, until - done); m.process(L.subarray(done, done + k), R.subarray(done, done + k), k); done += k; }
  }
  return { L, R };
}
const EARS = { x: 0, z: 0, dx: 0, dz: 1 };
/** The scene physics of dev/audioscenes.js: pedal in, speed out. */
function drive(gas, seconds, v0 = 0, each = () => {}) {
  const d = makeThrustDrive(K.drive);
  let v = v0;
  for (let t = 0; t < seconds - 1e-9; t += DT) {
    const g = gas(t);
    let a = -(0.3 + 0.0011 * v * v) * (v > 0.05 ? 1 : 0);
    if (g > 0) a += K.accel * g * (1 - (v / K.vmax) ** 2); else if (g < 0) a -= 11 * -g;
    v = Math.max(0, v + a * DT);
    thrustStep(d, v, Math.max(0, g), DT);
    each(t, v, d);
  }
  return d;
}

// ---- which voice a kind gets ---------------------------------------------------
test('the roadster resolves to the thruster class, and nobody else does', () => {
  assert.equal(voiceClass('roadster'), 'thrust');
  assert.equal(voiceKey('roadster'), 'roadster');
  assert.equal(vehicleVoice('roadster'), K);
  assert.ok(K.thr && K.drive && K.vmax > 100 && K.accel > 25 && K.loud > 0);
  // it is not a piston engine: the two piston lookups must not hand it an Octavia
  assert.equal(engineKind('roadster'), null);
  assert.equal(engineKey('roadster'), null);
  assert.ok(!ENGINE_KINDS.roadster && !ROLLING_KINDS.roadster);
  // and the rest of the roster is where it was
  for (const kind of Object.keys(ENGINE_KINDS)) { assert.equal(voiceClass(kind), 'piston'); assert.equal(voiceKey(kind), kind); }
  for (const kind of Object.keys(ROLLING_KINDS)) { assert.equal(voiceClass(kind), null); assert.equal(voiceKey(kind), null); }
  assert.equal(voiceKey('kombi'), 'octavia');
  assert.equal(voiceKey('nonsense'), 'octavia');
});

test('the mixer builds a thruster voice for a roadster and a piston engine for an Octavia', () => {
  const posts = [];
  const m = new MIX.CarMixer(SR);
  const v = new CV.CarVoices((msg) => { posts.push(msg); m.message(msg instanceof Float32Array ? msg.slice() : structuredClone(msg)); });
  v.playerStart('roadster');
  v.frame(DT, { speed: 10, throttle: 0.2 }, 0, [{ id: 'o', kind: 'octavia', x: 0, z: 12, speed: 10 }, { id: 'r', kind: 'roadster', x: 6, z: 12, speed: 10 }], EARS);
  const spec = posts.find((p) => p.t === 'spec' && p.key === 'roadster');
  assert.equal(spec.cls, 'thrust');
  assert.equal(posts.filter((p) => p.t === 'spec' && p.key === 'roadster').length, 1, 'described once, for two cars of it');
  assert.ok(m.voices[0].eng instanceof ThrusterVoice);
  const kinds = m.voices.slice(1).filter((x) => x.eng).map((x) => x.eng.constructor);
  assert.ok(kinds.includes(ThrusterVoice) && kinds.includes(EngineVoice));
  assert.ok(v.player && 'thrust' in v.player && 'tank' in v.player, 'the player record is the thrust drive');
});

// ---- the sound itself ------------------------------------------------------------
test('finite and inside full scale from a standstill to 400 km/h, thrusters shut and open', () => {
  for (const kmh of [0, 3, 30, 100, 250, 400, 520]) for (const load of [-1, 0, 0.2, 1]) for (const thrust of [0, 0.4, 1]) for (const cabin of [0, 1]) {
    const x = voice({ kmh, load, thrust, cabin, seconds: 0.4 });
    let peak = 0;
    for (const s of x) { assert.ok(Number.isFinite(s), `not finite at ${kmh} km/h, load ${load}, thrust ${thrust}`); if (Math.abs(s) > peak) peak = Math.abs(s); }
    assert.ok(peak < 1, `peak ${peak.toFixed(2)} at ${kmh} km/h, load ${load}, thrust ${thrust}, cabin ${cabin}`);
  }
  // nonsense in is silence or sense out, never NaN
  const v = new ThrusterVoice(SR, K.thr, 2), out = new Float32Array(256);
  v.set(NaN, NaN, NaN, NaN); v.render(out, 128); v.set(-5, 9, 7, -3); v.render(out.subarray(128), 128);
  for (const s of out) assert.ok(Number.isFinite(s));
});

test('standing still it hums, quietly, and is not silent', () => {
  const x = voice({ kmh: 0, load: 0, seconds: 1 });
  const lvl = rms(x, SR / 2);
  assert.ok(lvl > 0.003 && lvl < 0.05, `standstill level ${lvl.toFixed(4)}`);
  assert.ok(band(x, THRUSTER_DEFAULTS.humF, 6) > lvl * 0.5, 'the standstill sound is not the hum');
});

test('the whine rises with speed and never falls back: one sweep, no gears', () => {
  const v = new ThrusterVoice(SR, K.thr, 1);
  let prevHz = 0, prevP = Infinity;
  for (const kmh of [20, 40, 70, 100, 140, 190, 250, 320, 400]) {
    v.rpm = kmh * KMH * RPM;
    assert.ok(v.whineHz > prevHz * 1.1, `whine at ${kmh} km/h is ${v.whineHz.toFixed(0)} Hz, not above ${prevHz.toFixed(0)}`);
    prevHz = v.whineHz;
    // and in the sound: the tone stack repeats at the motor's electrical rate
    const fe = kmh * KMH * RPM / 60 * THRUSTER_DEFAULTS.pairs, want = SR / fe;
    const x = voice({ kmh, load: 0.6, seconds: 1.2 });
    const p = period(x, Math.max(4, Math.floor(want * 0.7)), Math.ceil(want * 1.3));
    assert.ok(Math.abs(p - want) < want * 0.03 + 0.6, `${kmh} km/h: period ${p.toFixed(1)} samples, expected ${want.toFixed(1)}`);
    assert.ok(p < prevP, `the pitch fell between speeds at ${kmh} km/h`);
    prevP = p;
    // the whine proper is a real peak: stronger than the gap a third below it
    if (v.whineHz < 6500) assert.ok(band(x, v.whineHz, 12) > 6 * band(x, v.whineHz * 0.71, 12), `no whine peak at ${kmh} km/h`);
  }
  // a floored drive from rest: the motor's revs only ever go up
  let last = -1;
  drive(() => 1, 6, 0, (t, vv, d) => { assert.ok(d.rpm >= last - 1e-9, `revs fell at ${t.toFixed(2)} s`); last = d.rpm; });
  assert.ok(last > 15000);
});

test('more pedal is louder and brighter; lifting off charges the battery and still whines', () => {
  const light = voice({ kmh: 90, load: 0.15 }), full = voice({ kmh: 90, load: 1 }), regen = voice({ kmh: 90, load: -0.8 });
  assert.ok(rms(full, SR / 2) > rms(light, SR / 2) * 2.5, 'floored is not clearly louder than a light foot');
  const hi = (x) => band(x, 4800, 10) / rms(x, SR / 2);     // the second ripple harmonic at 90 km/h
  assert.ok(hi(full) > hi(light) * 1.5, 'no brighter under load');
  assert.ok(rms(regen, SR / 2) > rms(light, SR / 2), 'regen is quieter than cruising');
  assert.ok(rms(regen, SR / 2) < rms(full, SR / 2), 'regen is as loud as full power');
  // regen is a beating pair: the level swells and sinks where a drive tone holds
  const swell = (x) => { const e = []; for (let o = SR / 2 | 0; o + 480 <= x.length; o += 480) e.push(band(x.subarray(o - 2400, o + 480), 2150, 6)); return (Math.max(...e) - Math.min(...e)) / Math.max(...e); };
  assert.ok(swell(regen) > swell(full) + 0.2, 'the regen whine does not beat');
});

test('the thrusters roar at a launch and are gone at a steady cruise', () => {
  // 6 kHz at 100 km/h lies between two tones of the motor (4.8 and 7 kHz): a
  // narrow band there hears the jet's hiss and nothing else
  const shut = band(voice({ kmh: 100, load: 0.2, thrust: 0, seconds: 1.5 }), 6000, 12);
  const off = voice({ kmh: 100, load: 1, thrust: 0, seconds: 1.5 }), on = voice({ kmh: 100, load: 1, thrust: 1, seconds: 1.5 });
  const loud = band(on, 6000, 12);
  assert.ok(shut < 0.003, `at a cruise there is ${shut.toFixed(5)} of noise at 6 kHz`);
  assert.ok(loud > shut * 12 && loud > 0.02, `jet at 6 kHz: ${loud.toFixed(4)} at a launch against ${shut.toFixed(5)} at a cruise`);
  // hiss of several kHz over a chest roar, and the whole thing well above the motors
  // (floored, the motors' own top tones leak into this band: twice that is the jet)
  assert.ok(loud > band(off, 6000, 12) * 2, `hiss ${loud.toFixed(4)} against ${band(off, 6000, 12).toFixed(4)} with the valves shut`);
  assert.ok(band(on, 160, 2) > band(off, 160, 2) * 8, `roar ${band(on, 160, 2).toFixed(4)} against ${band(off, 160, 2).toFixed(4)} with the valves shut`);
  assert.ok(rms(on, SR / 2) > rms(off, SR / 2) * 1.6, 'the thrusters do not stand above the motors');
  assert.ok(rms(on, SR / 2) < 0.4, 'a launch is painful');
  // the roar churns: its level over 20 ms windows is anything but flat
  const e = []; for (let o = SR / 2 | 0; o + 960 <= on.length; o += 960) e.push(rms(on, o, o + 960));
  const mean = e.reduce((a, b) => a + b) / e.length, cv = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / e.length) / mean;
  assert.ok(cv > 0.05, `the jet is as steady as a fan (${(cv * 100).toFixed(1)} %)`);
  // through the whole chain: a steady 90 km/h with a light foot never opens a valve
  const { m, v } = mixer();
  v.playerStart('roadster');
  let worst = 0;
  const cruise = play(m, v, 4, (t, dt) => { v.frame(dt, { speed: 25, throttle: 0.2 }, 0, [], EARS); worst = Math.max(worst, v.player.thrust); });
  assert.equal(worst, 0, 'thrust at a cruise');
  const { m: m2, v: v2 } = mixer();
  v2.playerStart('roadster');
  let vv = 0;
  const launch = play(m2, v2, 2, (t, dt) => { vv += K.accel * (1 - (vv / K.vmax) ** 2) * dt; v2.frame(dt, { speed: vv, throttle: 1 }, 0, [], EARS); });
  assert.ok(v2.player.thrust > 0.9, 'the valves are not open at a launch');
  assert.ok(rms(launch.L, SR / 2) > rms(cruise.L, SR) * 3, 'a launch is not much louder than a cruise');
  let peak = 0; for (const s of launch.L) peak = Math.max(peak, Math.abs(s));
  assert.ok(peak < 0.98, `the launch peaks at ${peak.toFixed(2)}`);
});

test('the valve cracks as it opens and the line sighs as it shuts', () => {
  // two voices from one seed: one opens its valve from 0.5 s to 1.0 s, one never does
  const norm = new ThrusterVoice(SR, K.thr, 1).calibrate();
  const run = (opens) => {
    const v = new ThrusterVoice(SR, K.thr, 5), out = new Float32Array(SR * 2);
    v.norm = norm;
    for (let o = 0; o < out.length; o += 128) {
      const th = opens && o >= SR / 2 && o < SR ? 1 : 0;
      v.set(3000, 0.1, th, 0); v.render(out.subarray(o, o + 128), 128);
    }
    return out;
  };
  const a = run(true), b = run(false);
  assert.ok(rms(a, SR / 2, SR / 2 + 720) > rms(b, SR / 2, SR / 2 + 720) * 3, 'no crack when the valve opens');
  // 150 ms after it shuts the jet itself is gone (45 ms release), the sigh is not
  // (the motor at 3000 rpm has no tone above 2.4 kHz)
  const hi = (x, t0, t1) => band(x.subarray(Math.round(t0 * SR), Math.round(t1 * SR)), 5000, 3);
  assert.ok(hi(a, 1.1, 1.3) > hi(b, 1.1, 1.3) * 3, 'no sigh after the valve shuts');
  assert.ok(hi(a, 1.75, 2) < hi(b, 1.75, 2) * 1.2, 'the sigh does not die away');
});

test('inside the car the hiss is behind the shell', () => {
  // the thrusters alone (the motors bent under load reach up here as well)
  const jet = (cabin) => {
    const v = new ThrusterVoice(SR, { ...K.thr, whine: 0 }, 3), out = new Float32Array(SR * 1.5);
    v.set(40 * KMH * RPM, 1, 1, cabin);
    for (let o = 0; o < out.length; o += 128) v.render(out.subarray(o, o + 128), 128);
    return out;
  };
  const out = jet(0), inn = jet(1);
  const hiss = (x) => band(x, 4000, 2), roar = (x) => band(x, 150, 2);
  assert.ok(hiss(inn) < hiss(out) * 0.6, `hiss ${hiss(inn).toFixed(3)} inside, ${hiss(out).toFixed(3)} outside`);
  assert.ok(roar(inn) > roar(out) * 0.9, 'the roar does not come through the floor');
});

test('the same seed is the same sound, sample for sample', () => {
  const a = voice({ kmh: 80, load: 1, thrust: 1, seed: 11, seconds: 0.5 }), b = voice({ kmh: 80, load: 1, thrust: 1, seed: 11, seconds: 0.5 });
  const c = voice({ kmh: 80, load: 1, thrust: 1, seed: 12, seconds: 0.5 });
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

// ---- the drive: valves and tank ------------------------------------------------
test('the tank: a few seconds of full thrust, then nothing until it has refilled', () => {
  // floored for twelve seconds: full cry at the launch, fading, empty
  const log = [];
  drive(() => 1, 12, 0, (t, v, d) => log.push({ t, thrust: d.thrust, tank: d.tank, valve: d.valve }));
  const at = (t) => log[Math.round(t * 60)];
  assert.ok(at(0.2).thrust > 0.9, `thrust ${at(0.2).thrust.toFixed(2)} a fifth of a second after flooring it`);
  assert.ok(at(1.5).thrust > 0.8, 'the thrust sags within the first second and a half');
  assert.ok(at(4).thrust < at(1.5).thrust * 0.6, 'the tank does not run down');
  assert.ok(at(6).thrust === 0 && at(6).tank === 0, 'thrust left after the tank is empty');
  for (let i = 1; i < log.length; i++) assert.ok(log[i].tank <= log[i - 1].tank, 'the tank refilled with the valves open');
  // lift: the compressor brings it back, and the next launch has its thrust again
  const d = drive((t) => (t < 6 ? 1 : 0), 6 + THRUST_DEFAULTS.fill + 0.5);
  assert.equal(d.tank, 1);
  // a light foot never opens them, at any speed
  for (const v0 of [0, 20, 60, 100]) drive(() => 0.5, 3, v0, (t, v, dd) => assert.equal(dd.thrust, 0));
  // traffic's guessed pedal: pulling away at 3 m/s^2 is not a launch
  const tr = makeThrustDrive(K.drive);
  for (let t = 0, v = 0; t < 5; t += DT) { v += 3 * DT; thrustStep(tr, v, 0.1 + 3 / (K.accel * 0.6), DT); assert.equal(tr.thrust, 0); }
});

test('a roadster voice costs a small fraction of real time', () => {
  const run = (kind) => {
    const { m, v } = mixer();
    v.playerStart(kind);
    play(m, v, 0.5, (t, dt) => v.frame(dt, { speed: 40, throttle: 1 }, 0, [], EARS));     // warm up the JIT
    const t0 = performance.now();
    play(m, v, 2, (t, dt) => v.frame(dt, { speed: 40, throttle: 1 }, 0, [], EARS));
    return performance.now() - t0;
  };
  const ms = run('roadster');
  // measured about 2 % of real time on an M1 Pro (an engine is 0.5 %); 25 % leaves room for a busy machine
  assert.ok(ms < 500, `two seconds of the roadster took ${ms.toFixed(0)} ms`);
});
