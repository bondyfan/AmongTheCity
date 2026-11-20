// ---- electric motors and a cold gas thruster, one sample at a time ------------
// The voice of the kinds in js/enginekinds.js THRUST_KINDS (the Roadster). It
// stands where EngineVoice stands in the mixer and answers the same calls
// (set, render, calibrate, norm), but nothing in it is a combustion cycle.
// Two machines are heard at once:
//
//   the motors   a stack of tones locked to the motor's speed, so with one
//                reduction and no gearbox the whole stack is a single sweep
//                from a hum at walking pace to a scream at 400 km/h: the
//                electrical fundamental and its double, the torque ripple six
//                times above it (the whine proper), the gear mesh at an
//                inharmonic ratio over that, and the inverter's fixed carrier
//                with the motor's rate ringing either side of it. Under load
//                the low tones are driven into saturation and the top comes
//                up; on the overrun the motors charge the battery and the
//                ripple tone splits into a beating pair that falls with the car
//   the thruster compressed air let go through a nozzle. No pitch at all: a
//                hiss of several kHz whose band opens with the flow, a chest
//                roar between 80 and 400 Hz that churns the way a jet does
//                (two slow random gusts multiply it, and it is skewed so the
//                pressure peaks crackle), and a faint whistle in the nozzle.
//                The valve cracks as it opens and sighs as it shuts.
//
// Standing still there is only the hum of pumps and contactors.
//
// Shared by the AudioWorklet and by node (tests, offline renders): no globals,
// and nothing is allocated while rendering.

import { svf } from './enginedsp.js';

const TAU = Math.PI * 2;
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);   // NaN lands on 0
const clamp11 = (x) => (x > -1 ? (x < 1 ? x : 1) : -1);

/** Voice identity. Every number a kind does not set comes from here. */
export const THRUSTER_DEFAULTS = {
  rpmMax: 24000,
  pairs: 4,                 // pole pairs: electrical Hz = pairs x motor rev/s
  ripple: 6,                // the torque ripple, in electrical orders
  mesh: 8.22,               // gear mesh, in electrical orders: not a harmonic on purpose
  top: 12,                  // the second ripple harmonic
  pwmF: 7400,               // inverter carrier, fixed
  humF: 92,                 // pumps and contactors at a standstill
  whine: 1,                 // level of the motors
  jet: 1.15,                // level of the thrusters
  hissF: [2600, 5200],      // centre of the hiss, valve cracked .. wide open
  roarF: [118, 305],        // the two chest bands
  nozF: [1350, 2100],       // the nozzle whistle
  vol: 1,
};

export class ThrusterVoice {
  constructor(sampleRate, spec = {}, seed = 1) {
    this.sr = sampleRate;
    this.rs = (Math.imul(seed | 0, 2654435761) | 0) || 1;
    this.raw = 1;             // the mixer hands set() its third number unrounded
    this.s = new Float64Array(14);
    this.setSpec(spec);
  }

  setSpec(spec) {
    const P = this.P = { ...THRUSTER_DEFAULTS, ...spec };
    const sr = this.sr;
    this.hiC = svf(P.hissF[0], 0.8, sr);
    this.r1C = svf(P.roarF[0], 1.1, sr);
    this.r2C = svf(P.roarF[1], 0.9, sr);
    this.noC = svf(P.nozF[0], 7, sr);
    this.psC = svf(5000, 1.2, sr);
    // gust filters: 9 Hz and 38 Hz, each scaled back up to unit variance
    this.g1a = 1 - Math.exp(-TAU * 9 / sr); this.g1k = Math.sqrt((2 - this.g1a) / this.g1a) * 0.577;
    this.g2a = 1 - Math.exp(-TAU * 38 / sr); this.g2k = Math.sqrt((2 - this.g2a) / this.g2a) * 0.577;
    this.rla = 1 - Math.exp(-TAU * 900 / sr);        // the roar's feed is not white
    this.cabA = 1 - Math.exp(-TAU * 1100 / sr);      // what the shell lets through of the hiss
    // ---- running state
    this.rpm = 0; this.rpmT = 0; this.load = 0; this.loadT = 0; this.thr = 0; this.thrT = 0;
    this.cabin = 0; this.norm = 1; this.started = 0;
    this.pE = 0; this.p2E = 0; this.pR = 0; this.pR2 = 0; this.pM = 0; this.pT = 0;
    this.pC = 0; this.pH = this._rand(); this.pH2 = this._rand();
    this.hunt = 0; this.open = 0; this.peak = 0;
    this.crackE = 0; this.pshE = 0; this.pshL = 0;
    this.g1 = 0; this.g2 = 0; this.rl = 0; this.nlp = 0; this.cabLp = 0;
    this.s.fill(0);
  }

  _rand() {
    let r = this.rs; r ^= r << 13; r ^= r >>> 17; r ^= r << 5; this.rs = r;
    return (r >>> 0) / 4294967296;
  }

  /** The whine proper, in Hz, at the revs the voice is at now (for tests and meters). */
  get whineHz() { return this.rpm / 60 * this.P.pairs * this.P.ripple; }

  /**
   * rpm     the motor's
   * load    -1..1: the pedal, or below zero how hard the motors are charging
   * thrust  0..1 from js/thrustdrive.js
   */
  set(rpm, load, thrust = 0, cabin = 0) {
    this.rpmT = rpm > 0 ? rpm : 0;
    this.loadT = clamp11(load) || 0;
    this.thrT = clamp01(thrust);
    this.cabin = clamp01(cabin);
    if (!this.started) { this.started = 1; this.rpm = this.rpmT; this.load = this.loadT; }
  }

  /** Adds n samples of this voice, times gain, into out. */
  render(out, n, gain = 1) {
    const P = this.P, sr = this.sr, S = this.s, dt = n / sr;
    // ---- once per block: the motors
    const rpm0 = this.rpm;
    this.rpm += (this.rpmT - this.rpm) * (1 - Math.exp(-dt / 0.02));
    this.load += (this.loadT - this.load) * (1 - Math.exp(-dt / 0.03));
    const rpm = this.rpm, load = this.load;
    const drive = load > 0 ? load : 0, regen = load < 0 ? -load : 0;
    const r01 = clamp01(rpm / P.rpmMax);
    // nothing holds a motor's speed perfectly still: a slow wander of a few cents
    this.hunt += ((this._rand() - 0.5) * 2 - this.hunt * 0.3) * 0.25;
    const wob = 1 + this.hunt * 0.0016;
    const fe0 = rpm0 / 60 * P.pairs * wob / sr, fe1 = rpm / 60 * P.pairs * wob / sr;   // cycles per sample
    const dfe = (fe1 - fe0) / n;
    const fe = rpm / 60 * P.pairs;                    // Hz, for the level of each tone
    const moving = clamp01(rpm / 500);
    // a tone is worth less the higher it gets (and nothing near Nyquist), and a
    // tone under 60 Hz is a wobble, not a note
    const roll = (f) => (f / (f + 70)) / (1 + (f / 6500) * (f / 6500)) * clamp01((17000 - f) / 5000);
    const hard = Math.pow(drive, 1.15);
    const lvl = moving * (0.16 + 0.84 * Math.max(hard, 0.36 * regen)) * (0.75 + 0.5 * r01);
    const aE = lvl * 0.55 * roll(fe);
    const a2E = lvl * (0.22 + 0.25 * hard) * roll(2 * fe);
    const aR = lvl * (0.75 + 0.35 * hard) * roll(P.ripple * fe);
    // the beating twin of the ripple tone: only while the motors are charging
    const aR2 = lvl * 0.7 * regen * roll(P.ripple * fe);
    const aM = lvl * (0.22 + 0.5 * hard) * roll(P.mesh * fe);
    const aT = lvl * (0.06 + 0.5 * hard * hard) * roll(P.top * fe);
    // inverter: sidebands of a fixed carrier, there even at a crawl
    const aC = (0.012 + 0.11 * Math.max(hard, 0.5 * regen)) * clamp01(rpm / 120);
    const sat = 0.6 + 1.7 * hard;                     // how hard the low tones are bent
    const dC = P.pwmF / sr, dR2 = 1.011;
    // standing hum: masked as soon as the car rolls
    const aH = 0.12 * (1 - 0.85 * moving);
    const dH = P.humF / sr * (1 + this.hunt * 0.004);

    // ---- once per block: the thrusters
    const tT = this.thrT;
    if (!this.open && tT > 0.3) { this.open = 1; this.crackE = 0.6 + 0.4 * clamp01((tT - this.thr) * 2.5); this.peak = 0; }
    this.thr += (tT - this.thr) * (1 - Math.exp(-dt / (tT > this.thr ? 0.014 : 0.045)));
    const T = this.thr;
    if (this.open) {
      if (T > this.peak) this.peak = T;
      if (tT < 0.1) { this.open = 0; this.pshE = Math.max(this.pshE, 0.35 + 0.65 * this.peak); }
    }
    const jet = T > 1e-4 || this.crackE > 1e-4 || this.pshE > 1e-4;
    const flow = Math.sqrt(T);
    if (jet) {
      svf(P.hissF[0] + (P.hissF[1] - P.hissF[0]) * flow, 0.8, sr, this.hiC);
      svf(P.nozF[0] + (P.nozF[1] - P.nozF[0]) * flow, 7, sr, this.noC);
      // the sigh falls in pitch as the line empties
      svf(2400 + 4600 * this.pshE, 1.2, sr, this.psC);
    }
    const cab = this.cabin;
    const kHiss = P.jet * 1.05 * Math.pow(T, 1.15) * (1 - 0.62 * cab);
    const kAir = P.jet * 0.115 * Math.pow(T, 1.15) * (1 - 0.8 * cab);
    const kRoar = P.jet * 6.2 * Math.pow(T, 1.3) * (1 + 0.1 * cab);
    const kNoz = P.jet * 1.1 * T * (1 - 0.5 * cab);
    const kCrack = Math.exp(-1 / (0.008 * sr)), kPsh = Math.exp(-1 / (0.22 * sr));
    const kWh = P.whine * (1 + 0.15 * cab);
    const g = gain * this.norm * P.vol;

    const hi = this.hiC, r1 = this.r1C, r2 = this.r2C, no = this.noC, ps = this.psC;
    const g1a = this.g1a, g1k = this.g1k, g2a = this.g2a, g2k = this.g2k, rla = this.rla, cabA = this.cabA;
    const mesh = P.mesh, rip = P.ripple, top = P.top;
    let { pE, p2E, pR, pR2, pM, pT, pC, pH, pH2, rs, g1, g2, rl, nlp, cabLp, crackE, pshE } = this;
    let de = fe0;

    for (let i = 0; i < n; i++) {
      // ---- the motors: one phase a tone, all advanced by the same motor
      de += dfe;
      pE += de; if (pE >= 1) pE -= 1;
      p2E += 2 * de; if (p2E >= 1) p2E -= 1;
      pR += rip * de; if (pR >= 1) pR -= 1;
      pR2 += rip * de * dR2; if (pR2 >= 1) pR2 -= 1;
      pM += mesh * de; if (pM >= 1) pM -= 1;
      pT += top * de; if (pT >= 1) pT -= 1;
      pC += dC; if (pC >= 1) pC -= 1;
      pH += dH; if (pH >= 1) pH -= 1;
      pH2 += dH * 2.03; if (pH2 >= 1) pH2 -= 1;
      const sE = Math.sin(TAU * pE);
      // the low pair is bent under load, which is what "harder" sounds like
      let lo = (aE * sE + a2E * Math.sin(TAU * p2E)) * sat;
      lo = lo / (1 + (lo < 0 ? -lo : lo)) / sat * 1.6;
      const wh = lo + aR * Math.sin(TAU * pR) + aR2 * Math.sin(TAU * pR2) + aM * Math.sin(TAU * pM)
        + aT * Math.sin(TAU * pT) + aC * Math.sin(TAU * pC) * sE
        + aH * (Math.sin(TAU * pH) + 0.4 * Math.sin(TAU * pH2));
      let o = wh * kWh;

      // ---- the thrusters
      if (jet) {
        rs = (Math.imul(rs, 1664525) + 1013904223) | 0;
        const wn = rs * 4.656612873e-10;                     // white, -1..1
        g1 += g1a * (wn - g1); g2 += g2a * (wn - g2);
        let gust = 1 + 0.5 * g1 * g1k + 0.28 * g2 * g2k;
        if (gust < 0.15) gust = 0.15;
        // hiss: a band that opens with the flow, and the air above it
        let v3 = wn - S[1], v1 = hi.a1 * S[0] + hi.a2 * v3, v2 = S[1] + hi.a2 * S[0] + hi.a3 * v3;
        S[0] = 2 * v1 - S[0]; S[1] = 2 * v2 - S[1];
        nlp += 0.2 * (wn - nlp);
        const hiss = v1 * hi.k * kHiss + (wn - nlp) * kAir;
        cabLp += cabA * (hiss - cabLp);
        // roar: two chest bands fed by darkened noise, churned and skewed
        rl += rla * (wn - rl);
        const rin = rl * (1 + crackE * 5);                    // the valve body takes the knock too
        v3 = rin - S[3]; v1 = r1.a1 * S[2] + r1.a2 * v3; v2 = S[3] + r1.a2 * S[2] + r1.a3 * v3;
        S[2] = 2 * v1 - S[2]; S[3] = 2 * v2 - S[3];
        let roar = v1;
        v3 = rin - S[5]; v1 = r2.a1 * S[4] + r2.a2 * v3; v2 = S[5] + r2.a2 * S[4] + r2.a3 * v3;
        S[4] = 2 * v1 - S[4]; S[5] = 2 * v2 - S[5];
        roar = (roar + 0.8 * v1) * gust * (kRoar + crackE * 1.2 * P.jet);
        roar += 0.9 * roar * (roar < 0 ? -roar : roar);      // pressure peaks outrun the troughs
        // the nozzle whistles a little, and rings when the valve cracks
        crackE *= kCrack; pshE *= kPsh;
        const nx = wn * (kNoz + crackE * 6 * P.jet);
        v3 = nx - S[7]; v1 = no.a1 * S[6] + no.a2 * v3; v2 = S[7] + no.a2 * S[6] + no.a3 * v3;
        S[6] = 2 * v1 - S[6]; S[7] = 2 * v2 - S[7];
        const noz = v1 * no.k;
        // the sigh of the line letting go
        v3 = wn - S[9]; v1 = ps.a1 * S[8] + ps.a2 * v3; v2 = S[9] + ps.a2 * S[8] + ps.a3 * v3;
        S[8] = 2 * v1 - S[8]; S[9] = 2 * v2 - S[9];
        o += hiss + (cabLp - hiss) * 0.5 * cab + roar + noz + (wn - nlp) * crackE * 0.9 * P.jet + v1 * ps.k * pshE * 2.6 * P.jet * (1 - 0.5 * cab);
      }
      // soft ceiling: a full launch saturates, it does not clip. Close to the
      // engines' own curve where they both work, but this one cannot pass 1.
      o *= g;
      out[i] += o / Math.sqrt(1 + o * o);
    }
    for (let k = 0; k < 10; k++) if (S[k] < 1e-18 && S[k] > -1e-18) S[k] = 0;
    if (!jet) { g1 = g2 = rl = nlp = cabLp = 0; }
    this.pE = pE; this.p2E = p2E; this.pR = pR; this.pR2 = pR2; this.pM = pM; this.pT = pT;
    this.pC = pC; this.pH = pH; this.pH2 = pH2; this.rs = rs; this.g1 = g1; this.g2 = g2;
    this.rl = rl; this.nlp = nlp; this.cabLp = cabLp;
    this.crackE = crackE < 1e-5 ? 0 : crackE; this.pshE = pshE < 1e-5 ? 0 : pshE;
  }

  /** Level the kind once, the way the engines are levelled: floored in the
   *  middle of its range WITHOUT the thrusters. The whine then sits where a
   *  quiet engine sits and the thrusters stand above it by their own design. */
  calibrate() {
    const P = this.P, n = Math.round(this.sr * 0.3), buf = new Float32Array(n);
    this.norm = 1;
    this.started = 1;
    this.rpm = this.rpmT = P.rpmMax * 0.3;
    this.load = this.loadT = 1; this.thr = this.thrT = 0;
    const vol = P.vol; P.vol = 1;
    for (let o = 0; o < n; o += 128) this.render(buf.subarray(o, Math.min(n, o + 128)), Math.min(128, n - o));
    let sum = 0;
    for (let i = n >> 1; i < n; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / (n - (n >> 1)));
    this.setSpec({ ...P, vol });
    this.norm = rms > 1e-6 ? 0.085 / rms : 1;
    return this.norm;
  }
}
