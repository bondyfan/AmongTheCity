// ---- flight-sound.js: what an airliner sounds like from seat 14A ----
// Nothing is downloaded and nothing is new in kind: the two turbofans are the
// game's own synthesised jet (js/audio.js jetStart/jetSet: a fan whine over a
// band of roar), run without reheat and at an airliner's slow spool, and
// heard through the same cabin filter a car's interior uses (holdCabin), shut
// almost all the way, because inside a fuselage the engines are a low rush
// and not a scream. On top: the cabin's own air-conditioning hiss and the
// two-tone chime that comes before every announcement. All of it goes
// through the master bus, so the game's volume (0 in every test boot) rules it.

import { jetStart, jetStop, jetSet, holdCabin, audioGraph } from './audio.js';

export function flightSound() {
  let on = false, cabinAir = null, cabinK = 0;
  function airStart() {
    const g = audioGraph();
    if (!g || cabinAir) return;
    const { ctx, master } = g;
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    // brown-ish noise: the low rush of air and engines through the cabin wall
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(lp); lp.connect(gain); gain.connect(master);
    src.start();
    cabinAir = { src, lp, gain };
  }
  function airStop() {
    if (!cabinAir) return;
    const a = cabinAir;
    cabinAir = null;
    try { a.gain.gain.setTargetAtTime(0, a.gain.context.currentTime, 0.3); } catch {}
    setTimeout(() => { try { a.src.stop(); } catch {} a.src.disconnect(); a.lp.disconnect(); a.gain.disconnect(); }, 1200);
  }
  return {
    /**
     * @param n1 engine speed 0..1, `speed` m/s, `inside` 0 outside .. 1 in the cabin
     * `reverse` 0..1 (the roar of the reversers on the rollout)
     */
    update(n1, speed, inside, reverse = 0) {
      if (!on) { jetStart(); airStart(); on = true; }
      // an airliner's turbofans: the lever is n1, and reverse thrust is a roar of its own
      jetSet(Math.min(1, n1 * 0.85 + reverse * 0.35), Math.min(1, speed / 300), false);
      if (Math.abs(inside - cabinK) > 0.01) { cabinK = inside; holdCabin(0.25 + 0.7 * inside); }
      if (cabinAir) {
        const t = cabinAir.gain.context.currentTime;
        const lvl = inside * (0.05 + 0.13 * Math.min(1, speed / 230) + 0.05 * n1);
        cabinAir.gain.gain.setTargetAtTime(lvl, t, 0.4);
        cabinAir.lp.frequency.setTargetAtTime(300 + 400 * Math.min(1, speed / 230), t, 0.4);
      }
    },
    /** The "ding-dong" before the crew speaks: two sine tones a major third apart. */
    chime() {
      const g = audioGraph();
      if (!g) return;
      const { ctx, master } = g, t = ctx.currentTime;
      for (const [f, at] of [[880, 0], [698.5, 0.42]]) {
        const o = ctx.createOscillator(), e = ctx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        e.gain.setValueAtTime(0, t + at);
        e.gain.linearRampToValueAtTime(0.16, t + at + 0.02);
        e.gain.exponentialRampToValueAtTime(0.001, t + at + 1.6);
        o.connect(e); e.connect(master);
        o.start(t + at); o.stop(t + at + 1.7);
        o.onended = () => { o.disconnect(); e.disconnect(); };
      }
    },
    stop() {
      if (!on) return;
      on = false;
      jetStop();
      airStop();
      holdCabin(0);
      cabinK = 0;
    },
  };
}
