// ---- Positioned one-shots: a horn that is THERE, not in your head ---------
//
// Frank, 21 Nov 2026: "kdyz auta v okoli troubi tak to ted zni jako strasne
// blizko me a uplne stejne hlasitost a ze stejne strany". He was right on all
// three counts. A traffic horn went through audio.js playBuffer(): one gain
// straight into the master bus. The gain fell with distance, but nothing else
// did, and a sound that only gets quieter does not get further away:
//
//   SIDE      there was no panner, so every horn sat dead centre, in the
//             middle of your head, whichever way you were facing.
//   DISTANCE  a far horn kept every bit of its top end. What tells the ear
//             "over there" is mostly the treble going (air, and the buildings
//             between you), then the street answering a beat late (reverb),
//             then the level. The level was the only cue we gave it.
//   NEAR      the law's "close" radius was 10 m, so a horn three cars back
//             was as loud as your own steering wheel.
//
// So a positioned one-shot is now played through a VOICE: a small graph built
// once and reused, gain -> lowpass -> stereo panner -> bus, with a send off the
// lowpass into the shared street reverb. Every frame the voices that are
// sounding are re-aimed at where the ears are now (main.js setListener: the
// car you drive, or your feet; the bearing from the camera), so a horn behind
// you swings round as you turn and fades as you drive away from it. Sound
// travels: a horn 170 m away is heard half a second after it was pressed.
//
// COST. VOICES graphs of four nodes each, made on the first positioned sound
// and never again. A play makes what it must, the buffer source and a gain for
// its own envelope (so a stolen voice can fade its old sound while the new one
// starts), and those go on `ended`. Per frame: four AudioParam targets per
// sounding voice, nothing allocated. When all voices are busy the quietest is
// stolen if the new sound would be louder, otherwise the new sound is dropped:
// the eighth horn of a jam is not worth a ninth graph.
//
// The math is exported on its own (no WebAudio in it) for tests/spatialsfx.

export const VOICES = 8;
export const SOUND_MS = 343;            // m/s, speed of sound in air at 20 °C
const LP_NEAR = 18000, LP_FAR = 1300;   // Hz of lowpass at the ear and at the edge of range
const REAR_K = 0.72;                    // a source behind you is a little darker
const WET = 0.55;                       // reverb send at the edge of range (0 at the ear)
const NEAR_PAN = 3;                     // m inside which a sound is pulled to the middle

/** 1/r with a "close" radius, faded to exactly zero at maxD so nothing clicks off. */
export function distanceGain(d, ref, maxD) {
  if (!(d >= 0) || d >= maxD) return 0;
  return (ref / Math.max(ref, d)) * (1 - d / maxD);
}

/** -1 (hard left) .. 1 (hard right) for a source (dx, dz) from an ear facing (fx, fz). */
export function panFor(dx, dz, fx, fz) {
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return 0;
  // the listener's right vector is the facing turned a quarter clockwise
  const p = (dx * -fz + dz * fx) / d;
  const k = d < NEAR_PAN ? d / NEAR_PAN : 1;
  return Math.max(-1, Math.min(1, p * k));
}

/**
 * Lowpass cutoff for a source at d of maxD: a log sweep, squared, so the first
 * tens of metres keep their crispness and the far end is dull. `behind` (0..1,
 * how far round behind the ear it is) takes a little more off.
 */
export function airCutoff(d, maxD, behind = 0) {
  const k = Math.max(0, Math.min(1, d / maxD));
  const f = LP_FAR * Math.pow(LP_NEAR / LP_FAR, (1 - k) * (1 - k));
  return f * (1 - (1 - REAR_K) * Math.max(0, Math.min(1, behind)));
}

/** How much of a source reaches you as reflection, relative to the direct sound. */
export function wetFor(d, maxD) {
  const k = Math.max(0, Math.min(1, d / maxD));
  return WET * k;
}

/** 0 in front or to the side, 1 straight behind. */
export function behindness(dx, dz, fx, fz) {
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d < 1e-6) return 0;
  const c = (dx * fx + dz * fz) / d;      // cos of the angle off the facing
  return c < 0 ? -c : 0;
}

/**
 * The voice a new sound of loudness `g` takes: a free one, else the quietest
 * busy one if `g` beats it, else -1 (drop the new sound). `voices[i].busy` and
 * `voices[i].level` are all it reads.
 */
export function pickVoice(voices, g) {
  let q = -1, ql = Infinity;
  for (let i = 0; i < voices.length; i++) {
    const v = voices[i];
    if (!v.busy) return i;
    if (v.level < ql) { ql = v.level; q = i; }
  }
  return q >= 0 && g > ql ? q : -1;
}

/**
 * The voice pool for one AudioContext. `out` is the bus the voices feed (the
 * master), `verb()` returns the shared reverb input or null. Listener state is
 * handed in per frame by audio.js, which owns it.
 */
export function createSpatial(ctx, out, verb) {
  const voices = [];
  const L = { x: 0, z: 0, fx: 0, fz: -1, set: false };
  let lastT = -1;

  function build() {
    for (let i = 0; i < VOICES; i++) {
      const g = ctx.createGain(); g.gain.value = 0;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = LP_NEAR; lp.Q.value = 0.5;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      g.connect(lp);
      if (pan) { lp.connect(pan); pan.connect(out); } else lp.connect(out);
      const bus = verb?.();
      let send = null;
      if (bus) { send = ctx.createGain(); send.gain.value = 0; lp.connect(send); send.connect(bus); }
      voices.push({ g, lp, pan, send, src: null, env: null, busy: false, level: 0, vol: 1, x: 0, z: 0, ref: 10, maxD: 220 });
    }
  }

  // Aim one voice at its source from where the ears are now. `snap` sets the
  // values outright (a new sound must not slide in from the last one's side).
  function aim(v, t, snap) {
    const dx = v.x - L.x, dz = v.z - L.z;
    const d = L.set ? Math.sqrt(dx * dx + dz * dz) : 0;
    const gain = distanceGain(d, v.ref, v.maxD);
    v.level = gain * v.vol;               // how loud it is at the ear, for stealing
    const f = airCutoff(d, v.maxD, L.set ? behindness(dx, dz, L.fx, L.fz) : 0);
    const p = L.set ? panFor(dx, dz, L.fx, L.fz) : 0;
    const w = wetFor(d, v.maxD);
    if (snap) {
      v.g.gain.cancelScheduledValues(t); v.g.gain.setValueAtTime(gain, t);
      v.lp.frequency.cancelScheduledValues(t); v.lp.frequency.setValueAtTime(f, t);
      if (v.pan) { v.pan.pan.cancelScheduledValues(t); v.pan.pan.setValueAtTime(p, t); }
      if (v.send) { v.send.gain.cancelScheduledValues(t); v.send.gain.setValueAtTime(w, t); }
      return d;
    }
    v.g.gain.setTargetAtTime(gain, t, 0.06);
    v.lp.frequency.setTargetAtTime(f, t, 0.08);
    if (v.pan) v.pan.pan.setTargetAtTime(p, t, 0.06);
    if (v.send) v.send.gain.setTargetAtTime(w, t, 0.1);
    return d;
  }

  function release(v, src) {
    if (v.src !== src) return;           // already stolen by a newer sound
    v.src = null; v.env = null; v.busy = false; v.level = 0;
  }

  return {
    /** Where the ears are and which way they face (unit or not). Cheap; call every step. */
    listener(x, z, fx, fz) {
      L.x = x; L.z = z; L.set = true;
      if (fx !== undefined) {
        const n = Math.sqrt(fx * fx + fz * fz) || 1;
        L.fx = fx / n; L.fz = fz / n;
      }
      const t = ctx.currentTime;
      if (t - lastT < 1 / 90) return;      // stepGame can run three times a frame
      lastT = t;
      for (let i = 0; i < voices.length; i++) if (voices[i].busy) aim(voices[i], t, false);
    },

    /**
     * Play `buf` at (x, z): `vol` is the sound's own loudness at the ear,
     * `ref` its close radius and `maxD` its range. Returns false when it was
     * dropped (out of range, or every voice busy with something louder).
     */
    play(buf, vol, rate, x, z, ref, maxD) {
      if (!voices.length) build();
      const dx = x - L.x, dz = z - L.z;
      const d = L.set ? Math.sqrt(dx * dx + dz * dz) : 0;
      const g0 = distanceGain(d, ref, maxD) * vol;
      if (g0 < 0.004) return false;
      const i = pickVoice(voices, g0);
      if (i < 0) return false;
      const v = voices[i];
      const t = ctx.currentTime;
      if (v.busy && v.src) {
        // stolen: the old sound fades out on its own envelope over 30 ms
        const os = v.src, oe = v.env;
        try { oe.gain.setTargetAtTime(0, t, 0.01); os.stop(t + 0.05); } catch { /* already ended */ }
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (rate !== 1) src.playbackRate.value = rate;
      const env = ctx.createGain();
      env.gain.value = vol;
      src.connect(env); env.connect(v.g);
      v.src = src; v.env = env; v.busy = true;
      v.x = x; v.z = z; v.ref = ref; v.maxD = maxD; v.vol = vol;
      aim(v, t, true);
      src.onended = () => { src.disconnect(); env.disconnect(); release(v, src); };
      // it was pressed now; it reaches you when the sound has come this far
      src.start(t + (L.set ? d / SOUND_MS : 0));
      return true;
    },

    /** For tests and the debug overlay: how many voices are sounding. */
    busy() { let n = 0; for (const v of voices) if (v.busy) n++; return n; },
    /** For a harness: what each sounding voice is doing (a copy). */
    state() {
      const out = [];
      for (const v of voices) if (v.busy) out.push({ x: v.x, z: v.z, level: v.level, gain: v.g.gain.value,
        cutoff: v.lp.frequency.value, pan: v.pan ? v.pan.pan.value : 0, wet: v.send ? v.send.gain.value : 0 });
      return out;
    },
  };
}
