// ---- every car voice in one place ---------------------------------------------
// One mixer renders the player's car (slot 0) and the traffic around it (the
// other slots) into a single stereo pair. js/carvoices.js on the main thread
// decides who gets a slot and sends, once a frame, what each car is doing; this
// side only makes the sound. The wrapper that runs it on the audio thread is
// car-worklet.js; node drives the same class directly for tests and renders.
//
// What a traffic voice gets on its way to the ears, all from one number, its
// distance:
//   level    inverse distance, fading to nothing at MAX_DIST
//   air      a lowpass that closes as the car gets further away
//   Doppler  the sound is written into a delay line and read back distance/c
//            seconds later. As the distance shrinks the read head catches up
//            and the pitch rises; as it grows the pitch falls. Nothing is
//            pitch shifted by hand, so the engine, the tyres and the turbo all
//            bend together, the way they do at the kerb
//   pan      equal power, from the bearing

import { EngineVoice } from './enginedsp.js';
import { RoadLayer, Impacts } from './roaddsp.js';

export const MAX_VOICES = 9;          // the player and eight others
export const HEAD = 2, STRIDE = 10;   // layout of the per-frame Float32Array
export const F_ON = 0, F_RPM = 1, F_LOAD = 2, F_CUT = 3, F_SPEED = 4, F_BRAKE = 5,
  F_COBBLE = 6, F_DIST = 7, F_PAN = 8, F_VR = 9;
export const FRAME_LEN = HEAD + MAX_VOICES * STRIDE;
export const MAX_DIST = 130;          // m, past this a car is not a voice
const REF_DIST = 7;                   // m, inside this it is simply "here"
const C_AIR = 343;
const FADE = 0.1;                     // s for a voice to come and go

class Voice {
  constructor(sr, slot) {
    this.slot = slot; this.sr = sr;
    this.on = 0; this.lvl = 0; this.eng = null; this.road = null; this.loud = 1;
    this.dist = 30; this.distT = 30; this.vr = 0; this.pan = 0; this.speed = 0;
    this.amp = 0; this.gl = 0.707; this.gr = 0.707; this.lp = 0; this.D = 0;
    this.buf = slot ? new Float32Array(32768) : null; this.w = 0;
    this.fresh = 1;
  }
}

export class CarMixer {
  constructor(sampleRate) {
    this.sr = sampleRate;
    this.voices = Array.from({ length: MAX_VOICES }, (_, i) => new Voice(sampleRate, i));
    this.specs = new Map();           // key -> { eng, norm }
    this.hits = new Impacts(sampleRate);
    this.tmp = new Float32Array(128);
    this.cabin = 0;
  }

  /** Everything the main thread says arrives here. */
  message(m) {
    if (m instanceof Float32Array) { this._frame(m); return; }
    const v = m.slot !== undefined ? this.voices[m.slot] : null;
    if (m.t === 'spec') {
      // levelled once per kind per session; the cost is a third of a second of
      // one engine, paid here and never while the car is being heard
      const probe = new EngineVoice(this.sr, m.eng, 1);
      this.specs.set(m.key, { eng: m.eng, norm: probe.calibrate() });
    } else if (m.t === 'voice' && v) {
      const s = m.key ? this.specs.get(m.key) : null;
      v.eng = s ? new EngineVoice(this.sr, s.eng, m.seed ?? v.slot + 1) : null;
      if (v.eng) v.eng.norm = s.norm;
      // the player's tyres are recordings in audio.js; traffic gets the band
      v.road = new RoadLayer(this.sr, (m.seed ?? 1) + 77, m.heavy ?? 0, v.slot ? 1 : 0, m.rail ?? 0);
      v.loud = m.loud ?? 1;
      v.fresh = 1; v.lvl = 0; v.lp = 0; v.amp = 0;
      if (v.buf) v.buf.fill(0);
    } else if (m.t === 'free' && v) v.on = 0;
    else if (m.t === 'hiss' && v?.road) v.road.hiss(m.level ?? 1);
    else if (m.t === 'hit') this.hits.trigger(m.k, m.pan ?? 0, m.gain ?? 1);
    else if (m.t === 'stop') for (const x of this.voices) x.on = 0;
  }

  _frame(f) {
    this.cabin = f[0];
    for (const v of this.voices) {
      const b = HEAD + v.slot * STRIDE;
      v.on = f[b + F_ON] > 0.5 && (v.eng || v.road) ? 1 : 0;
      if (!v.on) continue;
      v.speed = f[b + F_SPEED];
      if (v.eng) v.eng.set(f[b + F_RPM], f[b + F_LOAD], f[b + F_CUT] > 0.5, v.slot ? 0 : this.cabin);
      v.road.set(v.speed, f[b + F_BRAKE], f[b + F_COBBLE]);
      v.distT = Math.max(1, f[b + F_DIST]); v.vr = f[b + F_VR]; v.pan = f[b + F_PAN];
      if (v.fresh) { v.fresh = 0; v.dist = v.distT; v.D = v.dist / C_AIR * this.sr; }
    }
  }

  /** Adds n (<= 128) samples to outL and outR. */
  process(outL, outR, n) {
    const sr = this.sr, tmp = this.tmp, dt = n / sr;
    for (const v of this.voices) {
      // fade towards on/off; a voice that has faded out costs nothing
      const lvl0 = v.lvl;
      v.lvl += Math.max(-dt / FADE, Math.min(dt / FADE, v.on - v.lvl));
      if (v.lvl <= 0 && lvl0 <= 0) continue;
      const lvl = (lvl0 + v.lvl) * 0.5;
      for (let i = 0; i < n; i++) tmp[i] = 0;
      if (v.eng) v.eng.render(tmp, n, lvl);
      if (v.road && !v.road.quiet) v.road.render(tmp, n, lvl);
      if (!v.slot) {
        // your own car is all around you: dead centre, no distance
        for (let i = 0; i < n; i++) { outL[i] += tmp[i]; outR[i] += tmp[i]; }
        continue;
      }
      // ---- where the car is this block
      v.dist += v.vr * dt;
      v.dist += (v.distT - v.dist) * 0.12;        // the frame's truth pulls the guess back
      if (v.dist < 1) v.dist = 1;
      const d = v.dist, far = d / MAX_DIST;
      const ampT = v.loud * 2 * REF_DIST / (d > REF_DIST ? d : REF_DIST) * (far < 1 ? 1 - far * far : 0);
      const a = 1 - Math.exp(-2 * Math.PI * (15000 / (1 + Math.pow(d / 22, 1.25))) / sr);
      const ang = (Math.max(-1, Math.min(1, v.pan)) + 1) * Math.PI / 4;
      const glT = Math.cos(ang), grT = Math.sin(ang);
      const D1 = Math.max(1, d / C_AIR * sr);
      const dA = (ampT - v.amp) / n, dL = (glT - v.gl) / n, dR = (grT - v.gr) / n, dD = (D1 - v.D) / n;
      const buf = v.buf;
      let { amp, gl, gr, lp, D, w } = v;
      for (let i = 0; i < n; i++) {
        amp += dA; gl += dL; gr += dR; D += dD;
        lp += a * (tmp[i] * amp - lp);
        buf[w] = lp;
        const rp = w - D, i0 = Math.floor(rp), fr = rp - i0;
        const y = buf[i0 & 32767] * (1 - fr) + buf[(i0 + 1) & 32767] * fr;
        w = (w + 1) & 32767;
        outL[i] += y * gl; outR[i] += y * gr;
      }
      v.amp = amp; v.gl = gl; v.gr = gr; v.lp = lp < 1e-18 && lp > -1e-18 ? 0 : lp; v.D = D; v.w = w;
    }
    this.hits.render(outL, outR, n);
    // A lorry pulling away at arm's length, on top of your own engine, on top
    // of a crash: the sum is rounded off instead of being allowed to clip.
    // Below half scale this is within a decibel of doing nothing.
    for (let i = 0; i < n; i++) {
      const l = outL[i], r = outR[i];
      outL[i] = l / Math.sqrt(1 + l * l * 0.5);
      outR[i] = r / Math.sqrt(1 + r * r * 0.5);
    }
  }
}
