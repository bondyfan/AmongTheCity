// ---- the car voices, heard by a test ------------------------------------------
// The synthesis lives in public/worklets/ (it is loaded by URL on the audio
// thread) and its main-thread half in js/carvoices.js. Both are plain modules
// with no WebAudio in them, so the whole chain runs here exactly as it runs in
// the game: frames in, samples out. What is pinned is what an ear would notice:
// an engine that never repeats a cycle, gets louder under load, goes quiet with
// the fuel cut; traffic that is quieter far away, sits on the side it is on,
// and rises and falls in pitch as it goes by.

import test from 'node:test';
import assert from 'node:assert';
import { EngineVoice } from '../public/worklets/enginedsp.js';
import { RoadLayer, Impacts } from '../public/worklets/roaddsp.js';
import * as MIX from '../public/worklets/carmixer.js';
import * as CV from '../js/carvoices.js';
import { ENGINE_KINDS } from '../js/enginekinds.js';
import { cobbleAt } from '../js/roadsurface.js';
import { CHUNK } from '../js/config.js';

const SR = 48000;
const rms = (x, a = 0, b = x.length) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); };
function engine(kind, rpm, load, seconds = 1, cut = 0) {
  const e = new EngineVoice(SR, ENGINE_KINDS[kind].eng, 3);
  e.calibrate();
  e.set(rpm, load, cut);
  const n = Math.round(SR * seconds), out = new Float32Array(n);
  for (let o = 0; o < n; o += 128) e.render(out.subarray(o, Math.min(n, o + 128)), Math.min(128, n - o));
  return out;
}
/** Lag (in samples) of the strongest self-similarity between lo and hi. */
function period(x, lo, hi, from = 0, len = 16384) {
  let best = 0, at = lo;
  for (let lag = lo; lag <= hi; lag++) {
    let s = 0;
    for (let i = from; i < from + len; i++) s += x[i] * x[i + lag];
    if (s > best) { best = s; at = lag; }
  }
  return at;
}

test('the two halves agree on the layout of a frame', () => {
  for (const k of ['MAX_VOICES', 'HEAD', 'STRIDE', 'FRAME_LEN', 'MAX_DIST']) {
    assert.equal(CV[k], MIX[k], `${k} differs between js/carvoices.js and public/worklets/carmixer.js`);
  }
});

test('every kind makes a finite, bounded sound from idle to the redline', () => {
  for (const [kind, K] of Object.entries(ENGINE_KINDS)) {
    for (const [rpm, load] of [[K.eng.idle, 0.14], [K.eng.redline * 0.6, 1], [K.eng.redline, 1], [K.eng.redline * 0.8, 0]]) {
      const x = engine(kind, rpm, load, 0.5);
      let peak = 0;
      for (const v of x) { assert.ok(Number.isFinite(v), `${kind} at ${rpm} rpm is not finite`); if (Math.abs(v) > peak) peak = Math.abs(v); }
      assert.ok(peak > 0.005 && peak < 2.5, `${kind} at ${rpm | 0} rpm, load ${load}: peak ${peak.toFixed(3)}`);
    }
  }
});

test('the engine fires at the rate its cylinders say', () => {
  // a four at 2400 rpm fires 80 times a second: 600 samples apart
  const x = engine('octavia', 2400, 0.8, 1.5);
  const p = period(x, 300, 900, SR / 2);
  assert.ok(Math.abs(p - 600) <= 6, `firing period ${p} samples, expected 600`);
  // a three at the same revs fires 60 times a second
  const y = engine('fabia', 2400, 0.8, 1.5);
  const q = period(y, 500, 1100, SR / 2);
  assert.ok(Math.abs(q - 800) <= 8, `three-cylinder firing period ${q}, expected 800`);
});

test('no two cycles are the same: this is what the old oscillator could not do', () => {
  const x = engine('octavia', 900, 0.14, 3), cyc = Math.round(SR * 120 / 900);
  // the loudness of each whole cycle, over eighteen cycles
  const lv = [];
  for (let c = 2; c < 20; c++) lv.push(rms(x, c * cyc, (c + 1) * cyc));
  const mean = lv.reduce((a, b) => a + b) / lv.length;
  const cv = Math.sqrt(lv.reduce((a, b) => a + (b - mean) ** 2, 0) / lv.length) / mean;
  assert.ok(cv > 0.01, `idle cycles vary by only ${(cv * 100).toFixed(2)} %`);
  assert.ok(cv < 0.4, `idle cycles vary by ${(cv * 100).toFixed(0)} %: that is a misfire, not an idle`);
});

test('more throttle is louder, and cutting the fuel takes the combustion away', () => {
  const part = rms(engine('octavia', 3000, 0.25), SR / 2);
  const coast = rms(engine('octavia', 3000, 0), SR / 2);
  const full = rms(engine('octavia', 3000, 1), SR / 2);
  const cut = rms(engine('octavia', 3000, 1, 1, 1), SR / 2);
  assert.ok(full > part * 1.5, `floored is only ${(full / part).toFixed(1)}x a quarter throttle`);
  assert.ok(full > coast * 3, `floored is only ${(full / coast).toFixed(1)}x the overrun`);
  assert.ok(cut < full * 0.4, `with the fuel cut it is still ${(cut / full).toFixed(2)} of full`);
});

test('a diesel clatters where a petrol engine does not', () => {
  // share of the idle sound that sits in the knock band, 1 to 4 kHz
  const band = (x) => {
    let lp1 = 0, lp2 = 0, hi = 0, all = 0;
    const a1 = 1 - Math.exp(-2 * Math.PI * 1000 / SR), a2 = 1 - Math.exp(-2 * Math.PI * 4000 / SR);
    for (let i = SR / 2; i < x.length; i++) { lp1 += a1 * (x[i] - lp1); lp2 += a2 * (x[i] - lp2); hi += (lp2 - lp1) ** 2; all += x[i] ** 2; }
    return hi / all;
  };
  const van = band(engine('van', 800, 0.14, 2)), oct = band(engine('octavia', 800, 0.14, 2));
  assert.ok(van > oct * 1.5, `knock band share: van ${van.toFixed(3)}, octavia ${oct.toFixed(3)}`);
});

// ---- the mixer -----------------------------------------------------------------
function mixer() {
  const m = new MIX.CarMixer(SR);
  const v = new CV.CarVoices((msg) => m.message(msg instanceof Float32Array ? msg.slice() : structuredClone(msg)));
  return { m, v };
}
function play(m, v, seconds, frame) {
  const n = Math.round(SR * seconds), L = new Float32Array(n), R = new Float32Array(n);
  let done = 0;
  for (let f = 0; done < n; f++) {
    frame(f / 60, 1 / 60);
    const until = Math.min(n, Math.round((f + 1) * SR / 60));
    while (done < until) { const k = Math.min(128, until - done); m.process(L.subarray(done, done + k), R.subarray(done, done + k), k); done += k; }
  }
  return { L, R };
}
const EARS = { x: 0, z: 0, dx: 0, dz: 1 };

test('with nobody about the mixer is exactly silent', () => {
  const { m, v } = mixer();
  const { L, R } = play(m, v, 0.5, (t, dt) => v.frame(dt, null, 0, [], EARS));
  assert.equal(rms(L), 0); assert.equal(rms(R), 0);
});

test('the player starts an engine and stopping it fades to silence', () => {
  const { m, v } = mixer();
  v.playerStart('octavia');
  const a = play(m, v, 1, (t, dt) => v.frame(dt, { speed: 0, throttle: 0 }, 0, [], EARS));
  assert.ok(rms(a.L, SR / 2) > 0.003, 'idling engine cannot be heard');
  assert.ok(Math.abs(rms(a.L) - rms(a.R)) < 1e-9, 'your own engine is not dead centre');
  v.playerStop();
  const b = play(m, v, 1, (t, dt) => v.frame(dt, null, 0, [], EARS));
  assert.equal(rms(b.L, SR / 2), 0, 'the engine is still running after the player got out');
});

test('traffic is louder near than far, and sits on the side it is on', () => {
  const at = (x, z) => {
    const { m, v } = mixer();
    const { L, R } = play(m, v, 1.5, (t, dt) => v.frame(dt, null, 0, [{ id: 'a', kind: 'octavia', x, z, speed: 14 }], EARS));
    return { l: rms(L, SR), r: rms(R, SR) };
  };
  const near = at(0, 10), far = at(0, 80);
  assert.ok(near.l > far.l * 4, `10 m is only ${(near.l / far.l).toFixed(1)}x louder than 80 m`);
  // facing +z, the listener's right is -x
  const right = at(-20, 0), left = at(20, 0);
  assert.ok(right.r > right.l * 3, 'a car on the right is not on the right');
  assert.ok(left.l > left.r * 3, 'a car on the left is not on the left');
  assert.equal(at(0, 140).l, 0, 'a car past earshot has a voice');
});

test('a car going past rises in pitch as it comes and falls as it goes', () => {
  // 30 m/s along x, four metres in front of the listener, at a held speed
  const { m, v } = mixer();
  const { L, R } = play(m, v, 6, (t, dt) => v.frame(dt, null, 0,
    [{ id: 'a', kind: 'octavia', x: -90 + 30 * t, z: 4, speed: 30 }], EARS));
  const x = L.map((s, i) => s + R[i]);
  const coming = period(x, 300, 2000, Math.round(1.6 * SR));     // at about -40 m
  const going = period(x, 300, 2000, Math.round(4.4 * SR));      // at about +40 m
  const ratio = going / coming;
  // (1 + v/c) / (1 - v/c) for 30 m/s is 1.19; off axis it is a little less
  assert.ok(ratio > 1.1 && ratio < 1.25, `period going/coming = ${ratio.toFixed(3)}, expected about 1.18`);
});

test('eight voices at most, however much traffic there is', () => {
  const { m, v } = mixer();
  const jam = Array.from({ length: 40 }, (_, i) => ({ id: i, kind: i % 5 ? 'octavia' : 'bus', x: i * 3 - 60, z: 6 + (i % 3) * 3, speed: 8 }));
  play(m, v, 1, (t, dt) => v.frame(dt, null, 0, jam, EARS));
  assert.equal(v.slots.filter((s) => s !== null).length, MIX.MAX_VOICES - 1);
  assert.equal(m.voices.filter((x) => x.on).length, MIX.MAX_VOICES - 1);
});

test('a bus that stops lets its brake air go; a car does not', () => {
  for (const [kind, want] of [['bus', 1], ['octavia', 0]]) {
    const posts = [];
    const v = new CV.CarVoices((msg) => posts.push(msg));
    for (let f = 0; f < 600; f++) {
      const t = f / 60, speed = Math.max(0, 10 - 2 * t);       // rolls to a stop in five seconds
      v.frame(1 / 60, null, 0, [{ id: 'b', kind, x: 10, z: 10, speed }], EARS);
    }
    assert.equal(posts.filter((p) => p.t === 'hiss').length, want, `${kind}: wrong number of brake hisses`);
  }
});

test('each kind is described to the mixer once, however many cars of it go by', () => {
  const posts = [];
  const v = new CV.CarVoices((msg) => posts.push(msg));
  for (let f = 0; f < 120; f++) {
    v.frame(1 / 60, null, 0, [{ id: 'a' + (f >> 5), kind: 'van', x: 10, z: 10, speed: 5 }, { id: 'b', kind: 'van', x: -10, z: 10, speed: 5 }], EARS);
  }
  assert.equal(posts.filter((p) => p.t === 'spec').length, 1);
  assert.ok(posts.filter((p) => p.t === 'voice').length >= 2);
});

test('setts knock, tarmac does not, and a parked car is silent', () => {
  const road = (cobble, speed) => {
    const r = new RoadLayer(SR, 5, 0, 0), out = new Float32Array(SR);
    r.set(speed, 0, cobble);
    for (let o = 0; o < SR; o += 128) r.render(out.subarray(o, Math.min(SR, o + 128)), Math.min(128, SR - o));
    return rms(out, SR / 2);
  };
  assert.equal(road(0, 12), 0, 'the player has no tyre band here (it is a recording)');
  assert.ok(road(1, 12) > 0.01, 'setts at 43 km/h are silent');
  assert.equal(road(1, 0), 0, 'a parked car on setts makes a sound');
});

test('a harder hit is louder and lasts longer, and all of them end', () => {
  const hit = (k) => {
    const h = new Impacts(SR, 7), n = SR * 3, L = new Float32Array(n), R = new Float32Array(n);
    h.trigger(k);
    for (let o = 0; o < n; o += 128) h.render(L.subarray(o, o + 128), R.subarray(o, o + 128), Math.min(128, n - o));
    let last = 0;
    for (let i = 0; i < n; i++) if (Math.abs(L[i]) > 0.01) last = i;
    return { level: rms(L, 0, SR / 4), last: last / SR, tail: rms(L, n - SR / 4) };
  };
  const tap = hit(0.15), crash = hit(1);
  assert.ok(crash.level > tap.level * 2, 'a hard crash is no louder than a tap');
  assert.ok(crash.last > tap.last, 'a hard crash is over as soon as a tap');
  assert.ok(crash.tail < 1e-4 && tap.tail < 1e-4, 'an impact never ends');
});

test('the surface under the wheels: setts only on a street laid in them', () => {
  const road = (s, d = 1) => ({ s, d, w: 8, p: [[10, 10], [60, 10]] });
  const city = (r) => ({ chunkIndex: new Map([[Math.floor(30 / CHUNK) + ',' + Math.floor(10 / CHUNK), { roads: [r] }]]) });
  assert.equal(cobbleAt(city(road('cobble')), 30, 11), 1);
  assert.equal(cobbleAt(city(road('cobble')), 30, 19), 0, 'five metres off the carriageway');
  assert.equal(cobbleAt(city(road('asphalt')), 30, 11), 0);
  assert.equal(cobbleAt(city(road('cobble', 0)), 30, 11), 0, 'a sett footpath is not a street');
  assert.equal(cobbleAt(null, 30, 11), 0);
  assert.equal(cobbleAt({ chunkIndex: new Map() }, 30, 11), 0, 'a tile that has not loaded');
});

test('nine voices cost a small fraction of real time', () => {
  const { m, v } = mixer();
  v.playerStart('bmw');
  const jam = Array.from({ length: 12 }, (_, i) => ({ id: i, kind: ['octavia', 'bus', 'truck', 'van'][i % 4], x: i * 6 - 30, z: 8, speed: 12 }));
  play(m, v, 0.5, (t, dt) => v.frame(dt, { speed: 30, throttle: 0.6 }, 0, jam, EARS));   // warm up the JIT
  const t0 = performance.now();
  play(m, v, 2, (t, dt) => v.frame(dt, { speed: 30, throttle: 0.6 }, 0, jam, EARS));
  const ms = performance.now() - t0;
  // measured 2 to 4 % of real time on an M1 Pro; 50 % leaves room for a busy machine
  assert.ok(ms < 1000, `two seconds of nine voices took ${ms.toFixed(0)} ms`);
});
