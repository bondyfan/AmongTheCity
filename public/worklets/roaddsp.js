// ---- what a car sounds like besides its engine -------------------------------
// RoadLayer: the things that depend on the road and the brakes.
//   tyres    a band of noise that grows and brightens with speed. Only for
//            traffic: the player's own tyres are recordings (audio.js tireSet)
//   setts    granite setts are a row of small kerbs twelve centimetres apart.
//            Each one is a knock into the suspension and the shell, so this is
//            a train of impacts into two body resonances, not a filter sweep
//   brakes   pads rubbing a disc, and on some stops the squeal as it comes to rest
//   air      the sigh of a bus or lorry dumping its brake air
//   rail     a tram: the tyre band becomes the rumble of steel on steel, with
//            the whine of its traction motors on top
// Impacts: a collision. Sheet metal is a set of badly tuned bells, so it is a
// burst of noise through a handful of resonances, re-struck while it crumples.
//
// Like enginedsp.js this is shared by the worklet and by node, touches no
// globals and allocates nothing while rendering.

import { svf } from './enginedsp.js';

const SETT_PITCH = 0.12;      // m between the joints of a sett pavement
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);

export class RoadLayer {
  /** heavy = 0 for a car .. 1 for a bus or lorry. tyre = 0 mutes the tyre band. */
  constructor(sampleRate, seed = 1, heavy = 0, tyre = 1, rail = 0) {
    this.sr = sampleRate;
    this.rs = (Math.imul(seed | 0, 2246822519) | 0) || 1;
    this.heavy = heavy; this.tyre = tyre; this.rail = rail;
    this.whC = svf(200, 14, sampleRate);
    this.v = 0; this.brake = 0; this.cob = 0;
    this.tyC = svf(700, 0.6, sampleRate);
    this.b1 = svf(72 - 14 * heavy, 3, sampleRate);        // the shell booming
    this.b2 = svf(185 - 40 * heavy, 2.2, sampleRate);     // the suspension knocking
    this.rubC = svf(680, 1, sampleRate);
    this.sqC = svf(2100, 40, sampleRate);
    this.airC = svf(3400, 0.7, sampleRate);
    this.s = new Float64Array(14);
    this.cph = 0; this.imp = 0; this.rat = 0; this.nlp = 0;
    this.sq = 0; this.sqOn = 0; this.wasBraking = 0; this.air = 0; this.airLp = 0;
    this.tyreK = 0; this.tyLp = 0; this.tyLp2 = 0;
  }

  set(speed, brake, cobble) {
    this.v = speed > 0 ? speed : 0;
    this.brake = clamp01(brake);
    this.cob = clamp01(cobble);
  }

  /** A brake valve letting go. level 0..1. */
  hiss(level = 1) { this.air = Math.max(this.air, clamp01(level)); }

  /** Is there anything to render at all? A parked, silent layer costs nothing. */
  get quiet() {
    return this.v < 0.3 && this.air < 1e-3 && this.tyreK < 1e-4 && this.sq < 1e-3;
  }

  render(out, n, gain = 1) {
    const sr = this.sr, S = this.s, v = this.v, dt = n / sr;
    // ---- once per block
    const rail = this.rail;
    const tyT = this.tyre * 0.11 * (1 + 0.8 * this.heavy + 1.2 * rail) * Math.pow(Math.min(v, 45) / 30, rail ? 1.1 : 1.6);
    this.tyreK += (tyT - this.tyreK) * (1 - Math.exp(-dt / 0.08));
    const tyreK = this.tyreK;
    svf(rail ? Math.min(700, 150 + 18 * v) : Math.min(1500, 420 + 26 * v), 0.6, sr, this.tyC);
    // traction motors through their gears: a band of noise that climbs with speed
    const whK = rail ? 0.9 * Math.min(1, v / 5) : 0;
    if (rail) svf(Math.min(2400, 90 + 62 * v), 14, sr, this.whC);
    const wh = this.whC;
    const cobK = this.cob * Math.min(1, v / 8) * (0.5 + 0.5 * Math.min(1, v / 20));
    const dph = v / SETT_PITCH / sr;
    const rubK = this.brake * Math.min(1, v / 3) * (0.02 + 0.03 * Math.min(1, v / 25));
    // the squeal: decided once per stop, and only heard as the wheel nearly stops
    const braking = this.brake > 0.25 && v > 0.5;
    if (braking && !this.wasBraking) {
      this.sqOn = this._rand() < (0.1 + 0.6 * this.heavy) ? 1 : 0;
      svf(1700 + 900 * this._rand(), 40, sr, this.sqC);
    }
    this.wasBraking = braking ? 1 : 0;
    const sqT = this.sqOn && braking && v < 4.5 ? 0.035 * this.brake * (1 - v / 4.5) : 0;
    this.sq += (sqT - this.sq) * (1 - Math.exp(-dt / 0.05));
    const sqK = this.sq;
    const airDec = Math.exp(-1 / (0.3 * sr));
    const ty = this.tyC, b1 = this.b1, b2 = this.b2, ru = this.rubC, sc = this.sqC, ac = this.airC;
    // tyre noise peaks near a kilohertz and falls away above it
    const tyA = 1 - Math.exp(-2 * Math.PI * Math.min(0.4 * sr, 1.7 * (rail ? 150 + 18 * v : 420 + 26 * v)) / sr);
    let { cph, imp, rat, nlp, rs, air, airLp, tyLp, tyLp2 } = this;

    for (let i = 0; i < n; i++) {
      rs = (Math.imul(rs, 1664525) + 1013904223) | 0;
      const wn = rs * 4.656612873e-10;
      nlp += 0.2 * (wn - nlp);
      let o = 0, v3, v1, v2;
      if (tyreK > 1e-5) {
        v3 = wn - S[1]; v1 = ty.a1 * S[0] + ty.a2 * v3; v2 = S[1] + ty.a2 * S[0] + ty.a3 * v3;
        S[0] = 2 * v1 - S[0]; S[1] = 2 * v2 - S[1];
        tyLp += tyA * (v1 + 0.25 * v2 - tyLp);
        tyLp2 += tyA * (tyLp - tyLp2);
        o += tyLp2 * 2.4 * tyreK;
        if (whK > 0) {
          v3 = wn - S[13]; v1 = wh.a1 * S[12] + wh.a2 * v3; v2 = S[13] + wh.a2 * S[12] + wh.a3 * v3;
          S[12] = 2 * v1 - S[12]; S[13] = 2 * v2 - S[13];
          o += v1 * tyreK * whK;
        }
      }
      if (cobK > 1e-4) {
        // one joint after another, none of them quite like the last
        cph += dph;
        if (cph >= 1) {
          cph -= 1;
          rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
          const u = (rs >>> 0) / 4294967296;
          imp += (0.25 + 0.75 * u * u) * (u > 0.93 ? 2.6 : 1);   // now and then a deep one
          rat = 0.5 + u;
          cph += (u - 0.5) * 0.3;                              // and never evenly spaced
          if (cph < 0) cph = 0;
        }
        v3 = imp - S[3]; v1 = b1.a1 * S[2] + b1.a2 * v3; v2 = S[3] + b1.a2 * S[2] + b1.a3 * v3;
        S[2] = 2 * v1 - S[2]; S[3] = 2 * v2 - S[3];
        let c = v1 * 1.5;
        v3 = imp - S[5]; v1 = b2.a1 * S[4] + b2.a2 * v3; v2 = S[5] + b2.a2 * S[4] + b2.a3 * v3;
        S[4] = 2 * v1 - S[4]; S[5] = 2 * v2 - S[5];
        c += v1;
        imp = 0;
        rat *= 0.996;                                          // the trim rattling after it
        o += (c * 6 + (wn - nlp) * rat * 0.22) * cobK;
      }
      if (rubK > 1e-5 || sqK > 1e-4) {
        v3 = wn - S[7]; v1 = ru.a1 * S[6] + ru.a2 * v3; v2 = S[7] + ru.a2 * S[6] + ru.a3 * v3;
        S[6] = 2 * v1 - S[6]; S[7] = 2 * v2 - S[7];
        o += v1 * rubK;
        v3 = wn - S[9]; v1 = sc.a1 * S[8] + sc.a2 * v3; v2 = S[9] + sc.a2 * S[8] + sc.a3 * v3;
        S[8] = 2 * v1 - S[8]; S[9] = 2 * v2 - S[9];
        o += v1 * sqK;
      }
      if (air > 1e-4) {
        air *= airDec;
        v3 = (wn - nlp) - S[11]; v1 = ac.a1 * S[10] + ac.a2 * v3; v2 = S[11] + ac.a2 * S[10] + ac.a3 * v3;
        S[10] = 2 * v1 - S[10]; S[11] = 2 * v2 - S[11];
        airLp += 0.004 * (air - airLp);                        // a soft front, not a click
        o += v1 * airLp * 0.9;
      } else airLp *= 0.999;
      out[i] += o * gain;
    }
    for (let k = 0; k < 14; k++) if (S[k] < 1e-18 && S[k] > -1e-18) S[k] = 0;
    this.cph = cph; this.imp = imp; this.rat = rat; this.nlp = nlp; this.rs = rs;
    this.air = air; this.airLp = airLp; this.tyLp = tyLp; this.tyLp2 = tyLp2;
  }

  _rand() {
    let r = this.rs; r ^= r << 13; r ^= r >>> 17; r ^= r << 5; this.rs = r;
    return (r >>> 0) / 4294967296;
  }
}

// ---- collisions ---------------------------------------------------------------
const MODES = [205, 330, 515, 790, 1180, 1740, 2580, 3850];   // Hz, a steel panel

class Hit {
  constructor(sr) {
    this.sr = sr; this.on = 0;
    this.c = MODES.map((f) => svf(f, 18, sr));
    this.lpC = svf(2000, 0.7, sr);
    this.s = new Float64Array(2 * MODES.length + 2);
  }
}

export class Impacts {
  constructor(sampleRate, seed = 99, pool = 3) {
    this.sr = sampleRate;
    this.rs = (Math.imul(seed | 0, 3266489917) | 0) || 1;
    this.hits = Array.from({ length: pool }, () => new Hit(sampleRate));
    this.tmp = new Float32Array(128);
  }

  /** k 0..1 is how hard; pan -1..1; gain is the distance law, done by the caller. */
  trigger(k, pan = 0, gain = 1) {
    const sr = this.sr;
    const h = this.hits.find((x) => !x.on) ?? this.hits.reduce((a, b) => (a.env < b.env ? a : b));
    k = k < 0.05 ? 0.05 : k > 1 ? 1 : k;
    h.on = 1; h.k = k; h.t = 0; h.s.fill(0);
    h.env = 1; h.dec = Math.exp(-1 / ((0.05 + 0.2 * k) * sr));
    h.cut = 2200 + 3600 * k; h.cutDec = Math.exp(-1 / ((0.12 + 0.2 * k) * sr));
    h.crumple = (0.08 + 0.5 * k * k) * sr;                // samples it keeps folding
    h.thF = (88 - 30 * k) * 2 * Math.PI / sr; h.thPh = 0;
    h.thEnv = 1; h.thDec = Math.exp(-1 / ((0.06 + 0.07 * k) * sr));
    // no two panels ring alike: detune and re-weight the modes every time
    h.w = MODES.map((_, i) => (0.4 + this._rand()) * Math.pow(0.82, i) * (0.3 + 0.7 * k));
    MODES.forEach((f, i) => svf(f * (0.85 + 0.35 * this._rand()), 10 + 16 * this._rand(), sr, h.c[i]));
    const a = (pan + 1) * Math.PI / 4;
    h.gl = Math.cos(a) * gain * (0.4 + 0.9 * k); h.gr = Math.sin(a) * gain * (0.4 + 0.9 * k);
  }

  render(outL, outR, n) {
    for (const h of this.hits) {
      if (!h.on) continue;
      const S = h.s, c = h.c, w = h.w, lp = h.lpC, M = MODES.length;
      let rs = this.rs, { env, cut, thPh, thEnv, t } = h;
      for (let i = 0; i < n; i++) {
        rs = (Math.imul(rs, 1664525) + 1013904223) | 0;
        const wn = rs * 4.656612873e-10;
        // while it crumples, it is struck again at random
        if (t < h.crumple && (rs & 0x3ff) < 14) env = Math.max(env, 0.35 + 0.65 * ((rs >>> 12) & 255) / 255 * (1 - t / h.crumple));
        env *= h.dec; cut = 260 + (cut - 260) * h.cutDec; thEnv *= h.thDec; t++;
        if ((i & 31) === 0) svf(cut, 0.7, this.sr, lp);
        const x = wn * env;
        let v3 = x - S[1], v1 = lp.a1 * S[0] + lp.a2 * v3, v2 = S[1] + lp.a2 * S[0] + lp.a3 * v3;
        S[0] = 2 * v1 - S[0]; S[1] = 2 * v2 - S[1];
        let o = v2 * 0.9;
        for (let m = 0, j = 2; m < M; m++, j += 2) {
          const f = c[m];
          v3 = x - S[j + 1]; v1 = f.a1 * S[j] + f.a2 * v3; v2 = S[j + 1] + f.a2 * S[j] + f.a3 * v3;
          S[j] = 2 * v1 - S[j]; S[j + 1] = 2 * v2 - S[j + 1];
          o += v1 * w[m] * 0.35;
        }
        thPh += h.thF * (0.6 + 0.4 * thEnv);
        o += Math.sin(thPh) * thEnv * 0.9 * h.k;
        o = o / (1 + (o < 0 ? -o : o) * 0.5);
        outL[i] += o * h.gl; outR[i] += o * h.gr;
      }
      this.rs = rs;
      h.env = env; h.cut = cut; h.thPh = thPh; h.thEnv = thEnv; h.t = t;
      if (t > h.crumple && env < 1e-4 && thEnv < 1e-4) {
        // let the modes ring out before the slot is handed back
        let e = 0; for (let k = 0; k < S.length; k++) e += S[k] * S[k];
        if (e < 1e-10) h.on = 0;
      }
    }
  }

  _rand() {
    let r = this.rs; r ^= r << 13; r ^= r >>> 17; r ^= r << 5; this.rs = r;
    return (r >>> 0) / 4294967296;
  }
}
