// A port of the Model 3's motor voice (js/audio.js buildEV and evSet) to plain
// arithmetic, so it can be rendered without a browser and heard next to the
// Roadster in dev/render-roadster-audio.mjs. It is a REFERENCE for listening,
// not the game's code: the game still plays this voice with WebAudio nodes.
// The numbers below are copied from the EV table in js/audio.js; if that table
// moves, this follows by hand.

const EV = { whineK: 88, whineMin: 90, whineMax: 5000, stage2: 1.62, humK: 13.2, pwmF: 2400, lp: 7000, vol: 0.6, fadeV: 1.5 };
const WAVE = [0, 1, 0.30, 0.14, 0.06];        // cosine partials; WebAudio scales the sum to a peak of 1
const WAVE_K = 1 / WAVE.reduce((a, b) => a + b, 0);
const SPEED_REF = 38, VMAX = 72, TAU_S = 0.025;
const TWO_PI = Math.PI * 2;

/**
 * frames: [{ t, dt, v, th }] one per simulated frame (v in m/s, th 0..1).
 * Returns a Float32Array of n samples at sr, in the units of the game's master bus.
 */
export function renderEV(frames, n, sr) {
  const out = new Float32Array(n);
  // the lowpass: RBJ, 7 kHz, Q given in dB as WebAudio reads it
  const w0 = TWO_PI * EV.lp / sr, q = Math.pow(10, 0.5 / 20), al = Math.sin(w0) / (2 * q), cs = Math.cos(w0);
  const b0 = (1 - cs) / 2 / (1 + al), b1 = (1 - cs) / (1 + al), b2 = b0, a1 = -2 * cs / (1 + al), a2 = (1 - al) / (1 + al);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  // every AudioParam the game writes with setTargetAtTime(.., tau) is a one-pole here
  const k = 1 - Math.exp(-1 / (TAU_S * sr));
  let fw = EV.whineMin, fh = 40, gW = 0, gW2 = 0, gH = 0, gP = 0, gO = 0;
  let tW = fw, tH = fh, tgW = 0, tgW2 = 0, tgH = 0, tgP = 0, tgO = 0;
  let pW = 0, pW2 = 0, pH = 0, pC = 0, pL = 0, fi = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    while (fi < frames.length && frames[fi].t <= t) {
      const f = frames[fi++];
      const v = Math.min(VMAX, f.v > 0 ? f.v : 0), th = f.th > 0 ? Math.min(1, f.th) : 0;
      const n3 = EV.humK * v;
      const reg = Math.max(0, Math.min(1, (1 - th) * ((v - 5) / 10)));
      const lvl = 0.25 + 0.75 * Math.min(1, v / SPEED_REF);
      tW = Math.max(EV.whineMin, Math.min(EV.whineMax, EV.whineK * v));
      tH = n3 < 20 ? 20 : n3;
      tgW = 0.05 * lvl * (1 + 0.20 * reg); tgW2 = 0.022 * lvl * (1 + 0.08 * reg);
      tgH = 0.05 * Math.min(1, v / 8); tgP = 0.025 * th; tgO = EV.vol * Math.min(1, v / EV.fadeV);
    }
    fw += k * (tW - fw); fh += k * (tH - fh);
    gW += k * (tgW - gW); gW2 += k * (tgW2 - gW2); gH += k * (tgH - gH); gP += k * (tgP - gP); gO += k * (tgO - gO);
    pW += fw / sr; if (pW >= 1) pW -= 1;
    pW2 += fw * EV.stage2 / sr; if (pW2 >= 1) pW2 -= 1;
    pH += fh / sr; if (pH >= 1) pH -= 1;
    pL += fh / sr; if (pL >= 1) pL -= 1;
    pC += EV.pwmF / sr; if (pC >= 1) pC -= 1;
    let w = 0, w2 = 0;
    for (let h = 1; h < WAVE.length; h++) {
      if (fw * h < sr * 0.5) w += WAVE[h] * Math.cos(TWO_PI * pW * h);
      if (fw * EV.stage2 * h < sr * 0.5) w2 += WAVE[h] * Math.cos(TWO_PI * pW2 * h);
    }
    const tri = 1 - 4 * Math.abs(pH - 0.5);
    const x = w * WAVE_K * gW + w2 * WAVE_K * gW2 + tri * gH + Math.sin(TWO_PI * pC) * Math.sin(TWO_PI * pL) * gP;
    const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y * gO;
  }
  return out;
}
