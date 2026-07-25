// ---- Audio: one-shot SFX + a fully procedural car engine (v2: virtual gears) ----
// One AudioContext for the whole game. Browsers park fresh contexts in
// 'suspended' until a user gesture, so main wires initAudio() to every
// click/keydown — it creates the context once and merely resumes it after
// that, which makes it free to call as often as you like. sfx() streams mp3s
// from assets/sounds and NEVER throws: a missing file is remembered as null
// and the call turns into a silent no-op, so the game runs fine from a bare
// checkout with an empty assets folder. The engine is pure synthesis — no
// looped sample to pitch-stretch and mangle — because a small oscillator bank
// through a throttle-driven lowpass tracks revs the way a small four-cylinder
// does, at zero asset cost. v2 adds a virtual 5-speed box: speed01 no longer
// maps straight to pitch, it picks a GEAR, and pitch follows in-gear revs —
// so accelerating climbs-drops-climbs like a real drivetrain instead of one
// long glissando.

let ctx = null;      // the one AudioContext (created on first gesture)
let master = null;   // master gain — setVolume() scales everything at once
let volume = 1;      // remembered so setVolume() before initAudio() sticks
const buffers = new Map();   // name → AudioBuffer, or null = known missing
const loading = new Map();   // name → in-flight fetch+decode Promise

export function initAudio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;                       // ancient browser — game runs silent
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  }
  // we are called FROM user gestures, so resume() is legal here (and a no-op
  // once running) — this is the whole trick that satisfies autoplay policy
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
}

export function setVolume(v) {
  volume = v < 0 ? 0 : v > 1 ? 1 : v;
  if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
}

// ---- one-shot samples --------------------------------------------------
export function sfx(name, vol = 1) {
  if (!ctx || ctx.state !== 'running') return;  // pre-gesture: sources would
  const buf = buffers.get(name);                // queue up and burst on resume
  if (buf) { playBuffer(buf, vol); return; }
  if (buf === null) { fallback(name, vol); return; }   // known missing
  // first request: fetch+decode exactly once and play on arrival — ~100 ms of
  // first-play latency beats dropping the cue; every later call is instant
  let p = loading.get(name);
  if (!p) {
    p = fetch('assets/sounds/' + name + '.mp3')
      .then(r => { if (!r.ok) throw 0; return r.arrayBuffer(); })
      .then(ab => ctx.decodeAudioData(ab))
      .then(b => { buffers.set(name, b); return b; })
      .catch(() => { buffers.set(name, null); return null; })
      .finally(() => loading.delete(name));
    loading.set(name, p);
  }
  p.then(b => { if (b) playBuffer(b, vol); else fallback(name, vol); });
}

function playBuffer(buf, vol) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g); g.connect(master);
  src.onended = () => { src.disconnect(); g.disconnect(); };
  src.start();
}

// Enter/exit MUST give feedback whether or not the ElevenLabs assets were
// ever generated: a 90 ms slice of lowpassed noise with a fast decay reads
// as a car-door thunk. Open is brighter (the latch click), close sits low
// (the solid slam). Everything else missing stays silent by design.
function fallback(name, vol) {
  if (name !== 'door_open' && name !== 'door_close') return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = name === 'door_open' ? 950 : 330;
  f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.55 * vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
  src.connect(f); f.connect(g); g.connect(master);
  src.onended = () => { src.disconnect(); f.disconnect(); g.disconnect(); };
  src.start(t, Math.random() * 0.5, 0.09);   // random slice → repeats differ
}

// one second of shared white noise — door thunks and the engine's intake
// hiss both loop/slice this single buffer, allocated once per session
let _noise = null;
function noiseBuffer() {
  if (!_noise) {
    const n = ctx.sampleRate | 0;
    _noise = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = _noise.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  }
  return _noise;
}

// ---- procedural engine loop --------------------------------------------
// Graph: sawtooth fundamental + triangle one OCTAVE DOWN (the block's low
// thrum) + square one octave UP at −14 dB (exhaust rasp — squares carry only
// odd harmonics, so doubling the fundamental slots them BETWEEN the saw's
// partials instead of masking them), all three through one lowpass whose
// cutoff opens with the throttle (the "roar" when you floor it), plus a
// whisper of lowpassed noise for intake hiss. A 4 Hz sine LFO wobbles ONLY
// oscA.detune, so at idle the saw drifts against both the sub-octave AND the
// rasp — the uneven "lope" of a cold four-cylinder; the depth fades to zero
// as revs climb because a spinning engine smooths itself out. Every parameter
// change rides setTargetAtTime with a ~25 ms time constant (≈ 60–80 ms
// perceived settle), so per-frame speed updates can never click or zipper.
//
// VIRTUAL GEARBOX — speed01 is sliced into five bands (the "gears"); inside a
// band the in-gear rev fraction runs 0→1 and rpm01 = 0.25 + 0.75·frac, so the
// engine never sits at true zero revs while rolling. Pitch anchors rpm 0.25 →
// fIdle and rpm 1 → fMax, meaning EVERY gear sweeps the full 55→190 Hz voice —
// short sweeps in low gears, long hauls in high ones, exactly the accelerating
// rhythm a real box produces. Crossing a band edge triggers a ~120 ms scripted
// dip: freq+gain glide DOWN past the new gear's landing value, then recover —
// scheduled entirely with setTargetAtTime (never setValueAtTime) so the curve
// always departs from the current value and cannot click.
const ENGINE = {
  fIdle: 55, fMax: 190,               // voice span, bottom of gear → redline
  loCut: 500, hiCut: 2800,            // lowpass span, closed → floored
  thCurve: 0.55,                      // pow(th, .55): filter opens HARD early —
                                      // half throttle already sounds urgent
  gIdle: 0.12, gThrottle: 0.10, gRpm: 0.05,  // loudness: base + pedal + revs
  rasp: 0.2,                          // square osc level ≈ −14 dB vs the saw
  lopeCents: 25,                      // idle-lope LFO depth, fades out by redline
  tau: 0.025,
};
// upper speed01 edge of each gear; last edge sits past 1 so flat-out stays in
// 5th (hysteresis below can never push beyond it either)
const GEAR_TOP = [0.12, 0.28, 0.48, 0.72, 1.001];
// Cruising exactly ON a band edge must not machine-gun shifts every frame, so
// a change only registers once speed01 leaves the current band by this much.
const GEAR_HYST = 0.012;
const SHIFT = {
  hold: 0.13,     // engineSet() keeps hands off freq+gain this long after a
                  // shift — per-frame writes would stomp the scheduled recovery
  fDipK: 0.84,    // momentary under-rev below the new gear's landing pitch —
                  // the clutch biting before revs settle
  gDipK: 0.52,    // volume ducks to half — the between-gears "breath"
  downTau: 0.03,  // fast fall into the dip...
  upAt: 0.06, upTau: 0.045,  // ...recovery starts +60 ms, settles ≈ +195 ms —
                             // reads as a ~120 ms dip to the ear
};
let eng = null;   // node bundle + gear state while running, see engineStart()

export function engineStart() {
  if (!ctx || ctx.state !== 'running' || eng) return;
  const t = ctx.currentTime;
  const oscA = ctx.createOscillator();
  oscA.type = 'sawtooth';
  oscA.frequency.value = ENGINE.fIdle;
  const oscB = ctx.createOscillator();
  oscB.type = 'triangle';
  oscB.frequency.value = ENGINE.fIdle / 2;
  oscB.detune.value = 9;               // ~9 cents flat → a slow cylinder beat
  const oscC = ctx.createOscillator(); // exhaust rasp an octave up, kept low
  oscC.type = 'square';
  oscC.frequency.value = ENGINE.fIdle * 2;
  const cGain = ctx.createGain();      // −14 dB pad — rasp seasons, never leads
  cGain.gain.value = ENGINE.rasp;
  const lfo = ctx.createOscillator();  // idle lope: slow wobble on A's detune
  lfo.type = 'sine';
  lfo.frequency.value = 4;
  const lfoDepth = ctx.createGain();   // output is CENTS (detune's unit)
  lfoDepth.gain.value = ENGINE.lopeCents;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = ENGINE.loCut; filter.Q.value = 1.1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(); noise.loop = true;
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'lowpass'; nFilter.frequency.value = 480;
  const nGain = ctx.createGain(); nGain.gain.value = 0.015;
  const gain = ctx.createGain();
  gain.gain.value = 0;                 // born silent, fade in — no start pop
  oscA.connect(filter); oscB.connect(filter);
  oscC.connect(cGain); cGain.connect(filter);
  lfo.connect(lfoDepth); lfoDepth.connect(oscA.detune);
  filter.connect(gain);
  noise.connect(nFilter); nFilter.connect(nGain); nGain.connect(gain);
  gain.connect(master);
  oscA.start(t); oscB.start(t); oscC.start(t); lfo.start(t);
  noise.start(t, Math.random());
  gain.gain.setTargetAtTime(ENGINE.gIdle, t, 0.06);
  // gear: current band index; shiftT: when the last shift fired — parked deep
  // in the past so the very first engineSet() writes params immediately
  eng = { oscA, oscB, oscC, cGain, lfo, lfoDepth, filter, gain, noise, nFilter,
          nGain, gear: 0, shiftT: -1e9 };
}

export function engineStop() {
  if (!eng) return;
  const e = eng;
  eng = null;                          // engineSet() goes inert immediately
  const t = ctx.currentTime;
  e.gain.gain.cancelScheduledValues(t);
  e.gain.gain.setTargetAtTime(0, t, 0.05);
  // let the fade land (τ=50 ms → inaudible well before 350 ms) THEN tear the
  // graph down; a bare stop() mid-waveform is an audible click
  setTimeout(() => {
    try { e.oscA.stop(); e.oscB.stop(); e.oscC.stop(); e.lfo.stop(); e.noise.stop(); } catch {}
    e.oscA.disconnect(); e.oscB.disconnect(); e.oscC.disconnect(); e.cGain.disconnect();
    e.lfo.disconnect(); e.lfoDepth.disconnect(); e.noise.disconnect();
    e.filter.disconnect(); e.nFilter.disconnect(); e.nGain.disconnect(); e.gain.disconnect();
  }, 350);
}

// Called every frame while driving — scalar math and AudioParam writes only,
// zero allocations. speed01 = |speed|/vmax, throttle01 = |gas| from input.
export function engineSet(speed01, throttle01) {
  if (!eng) return;
  const s = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;
  const th = throttle01 < 0 ? 0 : throttle01 > 1 ? 1 : throttle01;
  const t = ctx.currentTime, tau = ENGINE.tau;

  // --- pick the gear: hop bands only once s clears the edge by GEAR_HYST;
  // the do/while lets hard braking drop several gears in one frame ---
  let g = eng.gear;
  if (s > GEAR_TOP[g] + GEAR_HYST) {
    do g++; while (s > GEAR_TOP[g] + GEAR_HYST);
  } else if (g > 0 && s < GEAR_TOP[g - 1] - GEAR_HYST) {
    do g--; while (g > 0 && s < GEAR_TOP[g - 1] - GEAR_HYST);
  }

  // --- in-gear revs → voice targets (hysteresis can park s a hair outside
  // the band, so clamp frac). rpm01 = 0.25 + 0.75·frac per the contract; the
  // frequency map anchors rpm 0.25 → fIdle so a standing car still idles at
  // 55 Hz, and every upshift audibly drops revs by the same rule ---
  const lo = g > 0 ? GEAR_TOP[g - 1] : 0;
  let frac = (s - lo) / (GEAR_TOP[g] - lo);
  frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const f = ENGINE.fIdle + (ENGINE.fMax - ENGINE.fIdle) * frac;
  // loudness rides REVS (frac), not road speed — so the shift that drops the
  // pitch also ducks the volume a touch, which is half of what sells it
  const vol = ENGINE.gIdle + ENGINE.gThrottle * th + ENGINE.gRpm * frac;

  if (g !== eng.gear) {
    // --- the shift: glide freq+gain DOWN past the new landing values, then
    // recover, all pre-scheduled so the next ~130 ms plays out untouched.
    // setTargetAtTime always departs from the live value → click-free even if
    // a fast sweep re-triggers mid-dip (new events simply take over from now).
    // Downshifts share the shape: the "dip" lands as a rev-match blip because
    // the landing pitch is higher — one code path, both directions read right.
    eng.gear = g; eng.shiftT = t;
    const fD = f * SHIFT.fDipK, tUp = t + SHIFT.upAt;
    eng.oscA.frequency.setTargetAtTime(fD, t, SHIFT.downTau);
    eng.oscA.frequency.setTargetAtTime(f, tUp, SHIFT.upTau);
    eng.oscB.frequency.setTargetAtTime(fD / 2, t, SHIFT.downTau);
    eng.oscB.frequency.setTargetAtTime(f / 2, tUp, SHIFT.upTau);
    eng.oscC.frequency.setTargetAtTime(fD * 2, t, SHIFT.downTau);
    eng.oscC.frequency.setTargetAtTime(f * 2, tUp, SHIFT.upTau);
    eng.gain.gain.setTargetAtTime(vol * SHIFT.gDipK, t, SHIFT.downTau);
    eng.gain.gain.setTargetAtTime(vol, tUp, SHIFT.upTau);
  } else if (t - eng.shiftT > SHIFT.hold) {
    // normal running: track revs per frame. Skipped during the hold window —
    // a setTargetAtTime issued NOW would supersede the scheduled recovery leg
    // and flatten the dip into a plain fade.
    eng.oscA.frequency.setTargetAtTime(f, t, tau);
    eng.oscB.frequency.setTargetAtTime(f / 2, t, tau);
    eng.oscC.frequency.setTargetAtTime(f * 2, t, tau);
    eng.gain.gain.setTargetAtTime(vol, t, tau);
  }

  // --- always live, shift or not: these don't take part in the dip ---
  // filter opens on a hard early curve — sharper throttle response than the
  // linear v1 map, and the wider 500→2800 span buys real bite when floored
  const cut = ENGINE.loCut + (ENGINE.hiCut - ENGINE.loCut) * Math.pow(th, ENGINE.thCurve);
  eng.filter.frequency.setTargetAtTime(cut, t, tau);
  eng.nGain.gain.setTargetAtTime(0.015 + 0.035 * th, t, tau);   // intake hiss
  // idle lope dies off with revs — ±25 cents at the bottom of a gear, none at
  // the top, so cruising in high gear stays clean and steady
  eng.lfoDepth.gain.setTargetAtTime(ENGINE.lopeCents * (1 - frac), t, tau);
}
