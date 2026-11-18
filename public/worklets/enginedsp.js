// ---- a piston engine, one sample at a time --------------------------------
// The old engine voice (js/audio.js buildPiston) is an oscillator playing one
// stored cycle of cylinder pulses. Every cycle is the same cycle, and that is
// the whole reason it sounded like a synthesiser: a real engine never fires
// the same way twice.
//
// This voice has no stored waveform. It runs the crank and lets the events of
// the four-stroke cycle happen:
//   TDC  the charge burns: a knock into the block (the diesel clatter), and
//        this cycle's strength is drawn here, different every time
//   EVO  the exhaust valve opens and the cylinder blows down into the pipe
//   IVO  the intake valve opens and the piston pulls on the airbox
//   EVC/IVC  the valves land: the ticking of the valve train
// Each event is an impulse with its own random strength and its own small
// timing error. The impulses are then shaped by fixed things, which is the
// other half of sounding real: a header pipe (a quarter-wave resonator), a
// silencer, a tailpipe, an intake resonator and the resonances of the block.
// Those never move with revs. A moving source inside fixed resonances is what
// the ear reads as a machine and not as a tone.
//
// Noise is not laid on top. The gas rushing through the pipe hisses only while
// it flows, so the noise is multiplied by the flow itself.
//
// Shared by the AudioWorklet (car-worklet.js) and by node (tests, offline
// renders), so it touches no globals and allocates nothing while rendering.

const C_GAS = 480;            // m/s, sound in hot exhaust gas, mean along the pipe
const EVO = 0.19, IVO = 0.5, EVC = 0.52, IVC = 0.79;   // fractions of 720 degrees
const T_TDC = 0, T_EVO = 1, T_IVO = 2, T_TICK = 3;
const KNOCK_GAIN = 9;         // an impulse into a resonator comes out small; this evens it

const pow2 = (n) => { let p = 64; while (p < n) p <<= 1; return p; };
const clamp01 = (x) => (x > 0 ? (x < 1 ? x : 1) : 0);   // NaN lands on 0

/** Engine identity. Every number a kind does not set comes from here. */
export const ENGINE_DEFAULTS = {
  cyl: 4, fire: null,           // firing angles in degrees of 720, null = even
  idle: 800, redline: 6500,
  exL: 2.4, exG: 0.5,           // header + front pipe (m) and its reflection
  tailL: 0.8, tailG: 0.35,      // tailpipe behind the silencer
  mufLo: 300, mufHi: 2400,      // silencer lowpass, closed throttle / floored (Hz)
  rise: [0.9, 0.22],            // blowdown rise time in ms, closed / floored
  decay: 3.2,                   // blowdown decay in ms
  hdr: 0.45,                    // ms of header length scatter between cylinders
  boomF: 118, boom: 0.9,        // the silencer's chest resonance
  radF: 170,                    // tailpipe radiation highpass (Hz)
  rasp: 0.35,                   // flow noise in the exhaust
  roar: 0.5,                    // broadband burst of every combustion
  intake: 0.5, inF: 250, airF: 720, diesel: 0,
  knock: 0.12, mech: 0.16, res: [640, 1380, 2750],
  turbo: 0, turboF: [3200, 9500], bov: 0,
  pops: 0,
  cov: [0.16, 0.035],           // cycle to cycle variation, idle / full load
  vol: 1,
};

export class EngineVoice {
  constructor(sampleRate, spec = {}, seed = 1) {
    this.sr = sampleRate;
    this.rs = (Math.imul(seed | 0, 2654435761) | 0) || 1;
    this.ring = new Float32Array(512);                      // exhaust impulses
    this.dl1 = new Float32Array(pow2(sampleRate * 0.032));  // header pipe
    this.dl2 = new Float32Array(pow2(sampleRate * 0.012));  // tailpipe
    this.rpm = 0; this.rpmT = 0; this.load = 0; this.loadT = 0; this.cut = 0;
    this.cabin = 0; this.norm = 1;
    this.setSpec(spec);
  }

  setSpec(spec) {
    const P = this.P = { ...ENGINE_DEFAULTS, ...spec };
    const sr = this.sr, n = P.cyl;
    // ---- the event list: every valve and spark of one cycle, in crank order
    const ev = [];
    this.bias = new Float32Array(n);      // each cylinder breathes a little differently
    this.hdr = new Float32Array(n);       // each header pipe is its own length
    this.str = new Float32Array(n);       // this cycle's combustion strength
    for (let c = 0; c < n; c++) {
      const off = (P.fire ? P.fire[c] / 720 : c / n) % 1;
      this.bias[c] = 1 + (this._rand() - 0.5) * 0.14;
      this.hdr[c] = this._rand() * P.hdr * 0.001 * sr;
      ev.push([off, T_TDC, c], [(off + EVO) % 1, T_EVO, c], [(off + IVO) % 1, T_IVO, c],
        [(off + EVC) % 1, T_TICK, c], [(off + IVC) % 1, T_TICK, c]);
    }
    ev.sort((a, b) => a[0] - b[0]);
    this.evA = Float32Array.from(ev, (e) => e[0]);
    this.evT = Uint8Array.from(ev, (e) => e[1]);
    this.evC = Uint8Array.from(ev, (e) => e[2]);
    this.ei = 0; this.ph = this._rand();
    while (this.ei < ev.length && this.evA[this.ei] <= this.ph) this.ei++;
    // ---- fixed resonances
    this.N1 = Math.min(this.dl1.length - 1, Math.max(2, Math.round(2 * P.exL / C_GAS * sr)));
    this.N2 = Math.min(this.dl2.length - 1, Math.max(2, Math.round(2 * P.tailL / C_GAS * sr)));
    this.pa1 = 1 - Math.exp(-2 * Math.PI * 1500 / sr);    // loss inside the header loop
    this.pa2 = 1 - Math.exp(-2 * Math.PI * 2600 / sr);
    this.ra = 1 - Math.exp(-2 * Math.PI * P.radF / sr);
    this.na = 1 - Math.exp(-2 * Math.PI * 2400 / sr);   // the roar is not white: it tilts down
    this.boomC = svf(P.boomF, 3.2, sr);
    this.inC = svf(P.inF, 2.6, sr);
    this.airC = svf(P.airF, 1.5, sr);
    // broad on purpose: a narrow one rings like a whistle under steady noise
    this.resC = P.res.map((f, i) => svf(f, 1.8 + i * 0.4, sr));
    this.mufC = svf(P.mufLo, 0.75, sr);
    this.tuC = svf(P.turboF[0], 28, sr);
    // ---- running state
    this.w = 0; this.w1 = 0; this.w2 = 0;
    this.y1 = 0; this.y2 = 0; this.nlp = 0; this.p1 = 0; this.p2 = 0; this.rlp = 0;
    this.s = new Float64Array(20);         // filter memories, see render()
    this.iA = 0; this.iB = 0; this.mA = 0; this.mB = 0; this.iy = 0;
    this.eI0 = 0; this.eI1 = 0; this.eM0 = 0; this.eM1 = 0; this.ePop = 0;   // set by _fire
    this.eN = 0; this.nEnv = 0; this.nlp2 = 0; this.nlp3 = 0;
    this.spool = 0; this.bovE = 0; this.popT = 0; this.popE = 0; this.hunt = 0;
    this.loadPrev = 0; this.cabLp = 0;
    this.ring.fill(0); this.dl1.fill(0); this.dl2.fill(0);
    this.norm = 1;
  }

  _rand() {
    let r = this.rs; r ^= r << 13; r ^= r >>> 17; r ^= r << 5; this.rs = r;
    return (r >>> 0) / 4294967296;
  }

  /** rpm, load 0..1 (the throttle the engine is answering), cut = fuel cut. */
  set(rpm, load, cut = 0, cabin = 0) {
    this.rpmT = rpm > 0 ? rpm : 0;
    this.loadT = clamp01(load);
    this.cut = cut ? 1 : 0;
    this.cabin = clamp01(cabin);
    if (this.rpm === 0) { this.rpm = this.rpmT; this.load = this.loadT; }
  }

  /** Adds n samples of this engine, times gain, into out. */
  render(out, n, gain = 1) {
    const P = this.P, sr = this.sr, S = this.s;
    // ---- once per block: where the engine is, and what that does to it
    const dt = n / sr;
    this.load += (this.loadT - this.load) * (1 - Math.exp(-dt / 0.035));
    const rpm0 = this.rpm;
    this.rpm += (this.rpmT - this.rpm) * (1 - Math.exp(-dt / 0.02));
    const load = this.load, rpm = this.rpm;
    const r01 = clamp01((rpm - P.idle) / (P.redline - P.idle));
    // idle hunting: the governor never quite holds the revs still
    this.hunt += ((this._rand() - 0.5) * 2 - this.hunt * 0.35) * 0.3;
    const huntK = 1 + this.hunt * 0.011 * (1 - r01) * (1 - r01);
    const dph0 = rpm0 * huntK / 120 / sr, dph1 = rpm * huntK / 120 / sr;
    const dd = (dph1 - dph0) / n;
    const period = 120 / Math.max(rpm, 200);                 // seconds per cycle
    // blowdown pulse: sharper and brighter the harder the cylinder is working
    const lk = Math.pow(load, 0.7);
    const tr = (P.rise[0] + (P.rise[1] - P.rise[0]) * lk) * 0.001;
    const ar = 1 - Math.exp(-1 / (tr * sr));
    const kd = Math.exp(-1 / (Math.min(P.decay * 0.001, period * 0.1) * sr));
    const over = (1 - load) * r01;                           // spinning, not burning
    svf(P.mufLo * (0.8 + 0.6 * r01) + (P.mufHi - P.mufLo) * Math.pow(load, 0.6),
      0.75, sr, this.mufC);
    const g1 = Math.min(0.85, P.exG * (0.85 + 0.15 * load) + 0.18 * over);
    const g2 = Math.min(0.8, P.tailG * (1 + 0.5 * over));
    const fuel = this.cut ? 0 : 1;
    // not linear in the throttle: an idling engine is quiet, not inaudible
    const comb = Math.pow(load, 0.75) * fuel;
    const pump = 0.07 + 0.13 * r01;                          // air pumped with no fire
    const cov = (P.cov[0] + (P.cov[1] - P.cov[0]) * load) * (1.3 - 0.6 * r01);
    const jit = 0.00016 * sr * (1 - 0.7 * load);             // samples of timing scatter
    // diesel knock is loudest lightly loaded and gone the moment fuel is cut
    const knockK = P.knock * fuel * (P.diesel
      ? Math.min(1, load * 9) * (0.55 + 0.45 * (1 - load)) * (1 - 0.35 * r01)
      : (0.25 + 0.75 * load));
    const mechN = P.mech * (0.1 + 0.9 * Math.pow(r01, 1.4)) * 0.036;
    const thr = P.diesel ? 0.5 + 0.5 * load : 0.06 + 0.94 * Math.pow(load, 1.35);
    const inK = P.intake * thr * (1 + 0.5 * this.cabin);
    const kid = Math.exp(-1 / (period * 0.085 * sr));
    // every burn is also a burst of plain noise: short at revs, long at idle
    const kn = Math.exp(-1 / (Math.min(0.012, period / P.cyl * 0.45) * sr));
    const roarK = P.roar * (0.5 + 0.5 * r01);
    const floorN = (P.mech * 0.035 + P.roar * 0.012) * (0.4 + 0.6 * r01);
    const raspK = P.rasp * (0.25 + 0.75 * load) * (0.5 + 0.9 * r01);
    // turbo: the lag is the sound. Slow up, quicker down.
    let tuK = 0, bovK = 0;
    if (P.turbo > 0) {
      const want = load * (0.25 + 0.75 * r01);
      this.spool += (want - this.spool) * (1 - Math.exp(-dt / (want > this.spool ? 0.7 : 0.3)));
      svf(P.turboF[0] + (P.turboF[1] - P.turboF[0]) * this.spool, 28, sr, this.tuC);
      tuK = P.turbo * this.spool * this.spool * 0.05;
      // lifting off with boost in the pipes lets it out with a sigh
      if (P.bov > 0 && this.loadPrev - this.loadT > 0.45 && this.spool > 0.4) this.bovE = this.spool;
      this.bovE *= Math.exp(-dt / 0.16);
      bovK = P.bov * this.bovE * 0.5;
    }
    // afterfire: unburnt mixture lights in the pipe just after a lift at revs
    if (P.pops > 0 && this.loadPrev > 0.5 && this.loadT < 0.12 && r01 > 0.45) this.popT = 1.1;
    this.popT -= dt;
    const popP = this.popT > 0 ? 0.11 * P.pops * r01 : 0;
    this.loadPrev = this.loadT;
    const cab = this.cabin;
    const exMix = P.vol * (1 - 0.45 * cab), boomK = P.boom * (1 + 0.5 * cab) / 3.2;
    const meMix = P.vol * (1 + 0.5 * cab);
    const cabA = 1 - Math.exp(-2 * Math.PI * 140 / sr), cabK = 0.4 * cab;
    // a little of the dynamic range is taken back: idle is 13 dB under full
    // load here, not the 20 it is in the pit lane
    const g = gain * this.norm * (1 + 1.2 * (1 - load) * (1 - load)) * (0.85 + 0.45 * r01);

    // ---- locals for the hot loop
    const ring = this.ring, dl1 = this.dl1, dl2 = this.dl2;
    const M1 = dl1.length - 1, M2 = dl2.length - 1, N1 = this.N1, N2 = this.N2;
    const evA = this.evA, evT = this.evT, evC = this.evC, nEv = evA.length;
    const mu = this.mufC, bo = this.boomC, ic = this.inC, ac = this.airC, tc = this.tuC;
    const r0 = this.resC[0], r1 = this.resC[1], r2 = this.resC[2];
    const pa1 = this.pa1, pa2 = this.pa2, ra = this.ra, na = this.na;
    let { ph, ei, w, w1, w2, y1, y2, nlp, p1, p2, rlp, iA, iB, mA, mB, iy, rs, popE, cabLp, nEnv, nlp2, nlp3 } = this;
    let dph = dph0;

    for (let i = 0; i < n; i++) {
      // ---- the crank turns; fire whatever it has passed
      dph += dd; ph += dph;
      let fired = 0;
      if (ph >= 1) {
        ph -= 1;
        for (; ei < nEv; ei++) {                              // the tail of the old cycle
          rs = this._fire(evT[ei], evC[ei], (ph + 1 - evA[ei]) / dph, w, comb, pump, cov, jit, knockK, thr, popP, rs);
        }
        ei = 0; fired = 1;
      }
      while (ei < nEv && evA[ei] <= ph) {
        rs = this._fire(evT[ei], evC[ei], (ph - evA[ei]) / dph, w, comb, pump, cov, jit, knockK, thr, popP, rs);
        ei++; fired = 1;
      }
      if (fired) {
        iA += this.eI0; iB += this.eI1; mA += this.eM0; mB += this.eM1;
        this.eI0 = this.eI1 = this.eM0 = this.eM1 = 0;
        if (this.ePop > 0) { popE = this.ePop; this.ePop = 0; }
        nEnv += this.eN; this.eN = 0;
      }

      rs = (Math.imul(rs, 1664525) + 1013904223) | 0;
      const wn = rs * 4.656612873e-10;                       // white, -1..1
      nlp += 0.14 * (wn - nlp);
      const hiss = wn - nlp;                                 // the same noise, top only
      nlp2 += 0.035 * (wn - nlp2);
      nEnv *= kn;
      nlp3 += na * (wn - nlp2 - nlp3);
      const roar = nlp3 * 1.25 * (nEnv * roarK + floorN);

      // ---- exhaust: blowdown pulse, flow noise, header, silencer, tailpipe
      y1 = y1 * kd + ring[w]; ring[w] = 0; w = (w + 1) & 511;
      y2 += ar * (y1 - y2);
      popE *= 0.9992;
      let x = y2 + hiss * ((y2 < 0 ? -y2 : y2) * raspK + popE);
      p1 += pa1 * (dl1[(w1 - N1) & M1] - p1);
      x -= g1 * p1; dl1[w1] = x; w1 = (w1 + 1) & M1;
      let v3 = x - S[1], v1 = mu.a1 * S[0] + mu.a2 * v3, v2 = S[1] + mu.a2 * S[0] + mu.a3 * v3;
      S[0] = 2 * v1 - S[0]; S[1] = 2 * v2 - S[1];
      let m = v2;
      v3 = m - S[3]; v1 = bo.a1 * S[2] + bo.a2 * v3; v2 = S[3] + bo.a2 * S[2] + bo.a3 * v3;
      S[2] = 2 * v1 - S[2]; S[3] = 2 * v2 - S[3];
      m += boomK * v1;
      p2 += pa2 * (dl2[(w2 - N2) & M2] - p2);
      m += g2 * p2; dl2[w2] = m; w2 = (w2 + 1) & M2;
      rlp += ra * (m - rlp);
      const ex = m - rlp;
      cabLp += cabA * (ex - cabLp);                          // what the shell lets in

      // ---- intake: the piston pulling on the airbox through the throttle
      iy = iy * kid + iA; iA = iB; iB = 0;
      const ia = iy < 0 ? -iy : iy;
      v3 = iy - S[5]; v1 = ic.a1 * S[4] + ic.a2 * v3; v2 = S[5] + ic.a2 * S[4] + ic.a3 * v3;
      S[4] = 2 * v1 - S[4]; S[5] = 2 * v2 - S[5];
      let inn = v1 * ic.k;
      const ax = iy + hiss * ia * 1.6;
      v3 = ax - S[7]; v1 = ac.a1 * S[6] + ac.a2 * v3; v2 = S[7] + ac.a2 * S[6] + ac.a3 * v3;
      S[6] = 2 * v1 - S[6]; S[7] = 2 * v2 - S[7];
      inn += v1 * ac.k * 0.7;

      // ---- the block: knock and valve ticks ringing in the iron
      const mx = mA + wn * mechN; mA = mB; mB = 0;
      v3 = mx - S[9]; v1 = r0.a1 * S[8] + r0.a2 * v3; v2 = S[9] + r0.a2 * S[8] + r0.a3 * v3;
      S[8] = 2 * v1 - S[8]; S[9] = 2 * v2 - S[9];
      let me = v1;
      v3 = mx - S[11]; v1 = r1.a1 * S[10] + r1.a2 * v3; v2 = S[11] + r1.a2 * S[10] + r1.a3 * v3;
      S[10] = 2 * v1 - S[10]; S[11] = 2 * v2 - S[11];
      me += v1 * 0.55;
      v3 = mx - S[13]; v1 = r2.a1 * S[12] + r2.a2 * v3; v2 = S[13] + r2.a2 * S[12] + r2.a3 * v3;
      S[12] = 2 * v1 - S[12]; S[13] = 2 * v2 - S[13];
      me += v1 * 0.3;

      let o = ex * exMix + cabLp * cabK + inn * inK + (me + roar) * meMix;
      if (tuK > 0 || bovK > 0) {
        v3 = wn - S[15]; v1 = tc.a1 * S[14] + tc.a2 * v3; v2 = S[15] + tc.a2 * S[14] + tc.a3 * v3;
        S[14] = 2 * v1 - S[14]; S[15] = 2 * v2 - S[15];
        o += v1 * tuK + hiss * bovK;
      }
      // soft ceiling: a floored engine saturates, it does not clip
      o *= g;
      out[i] += o / (1 + (o < 0 ? -o : o) * 0.35);
    }
    // denormals cost real time on the audio thread; a parked filter is zero
    for (let k = 0; k < 16; k++) if (S[k] < 1e-18 && S[k] > -1e-18) S[k] = 0;
    this.ph = ph; this.ei = ei; this.w = w; this.w1 = w1; this.w2 = w2;
    this.y1 = y1; this.y2 = y2; this.nlp = nlp; this.p1 = p1; this.p2 = p2; this.rlp = rlp;
    this.iA = iA; this.iB = iB; this.mA = mA; this.mB = mB; this.iy = iy;
    this.rs = rs; this.popE = popE; this.cabLp = cabLp; this.nEnv = nEnv; this.nlp2 = nlp2; this.nlp3 = nlp3;
  }

  // One event of the cycle. fr = how far into this sample it happened, so the
  // impulse is split across two samples and the pulse train stays in tune.
  _fire(type, c, fr, w, comb, pump, cov, jit, knockK, thr, popP, rs) {
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
    const u = (rs >>> 0) / 4294967296;
    rs ^= rs << 13; rs ^= rs >>> 17; rs ^= rs << 5;
    const u2 = (rs >>> 0) / 4294967296;
    const lead = 1 - (fr < 1 ? fr : 1);
    if (type === T_TDC) {
      // this cycle's burn: mostly like the last one, never the same
      let s = comb * this.bias[c] * (1 + (u + u2 - 1) * 2 * cov);
      if (s < 0) s = 0;
      this.str[c] = s;
      const k = knockK * KNOCK_GAIN * (0.5 + u2);
      this.eM0 += k * (1 - lead); this.eM1 += k * lead;
      this.eN += (0.05 + s) * (0.6 + 0.8 * u);
    } else if (type === T_EVO) {
      let a = pump * this.bias[c] + this.str[c];
      if (popP > 0 && u < popP) { a += 0.5 + u2; this.ePop = 0.25 + 0.3 * u2; }
      const pos = this.hdr[c] + lead + u2 * jit, i0 = pos | 0, f = pos - i0;
      this.ring[(w + i0) & 511] += a * (1 - f);
      this.ring[(w + i0 + 1) & 511] += a * f;
    } else if (type === T_IVO) {
      const a = -(0.15 + 0.85 * thr) * this.bias[c] * (0.92 + 0.16 * u);
      this.eI0 += a * (1 - lead); this.eI1 += a * lead;
    } else {
      const k = this.P.mech * KNOCK_GAIN * 0.1 * (0.4 + 1.2 * u);
      this.eM0 += k * (1 - lead); this.eM1 += k * lead;
    }
    return rs;
  }

  /** Level the kind once so every engine sits at the same loudness floored at
   *  mid revs; P.vol then says how loud this kind is against the others. */
  calibrate() {
    const P = this.P, n = Math.round(this.sr * 0.3), buf = new Float32Array(n);
    this.norm = 1;
    this.rpm = this.rpmT = P.idle + (P.redline - P.idle) * 0.55;
    this.load = this.loadT = 1;
    for (let o = 0; o < n; o += 128) this.render(buf.subarray(o, Math.min(n, o + 128)), Math.min(128, n - o));
    let sum = 0;
    for (let i = n >> 1; i < n; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / (n - (n >> 1)));
    this.setSpec({ ...P });
    this.rpm = this.rpmT = this.load = this.loadT = 0;
    this.norm = rms > 1e-6 ? 0.2 / rms : 1;
    return this.norm;
  }
}

/** Coefficients of a state variable filter (Simper's form). Pass `into` to
 *  retune an existing one without allocating. band·k has unity peak gain. */
export function svf(fc, q, sr, into) {
  const o = into ?? { a1: 0, a2: 0, a3: 0, k: 1 };
  const g = Math.tan(Math.PI * Math.min(fc, sr * 0.45) / sr);
  o.k = 1 / q;
  o.a1 = 1 / (1 + g * (g + o.k));
  o.a2 = g * o.a1;
  o.a3 = g * o.a2;
  return o;
}
