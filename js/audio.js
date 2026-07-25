// ---- Audio: one-shot SFX + a fully procedural car engine ----
// One AudioContext for the whole game. Browsers park fresh contexts in
// 'suspended' until a user gesture, so main wires initAudio() to every
// click/keydown — it creates the context once and merely resumes it after
// that, which makes it free to call as often as you like. sfx() streams mp3s
// from assets/sounds and NEVER throws: a missing file is remembered as null
// and the call turns into a silent no-op, so the game runs fine from a bare
// checkout with an empty assets folder. The engine is pure synthesis — no
// looped sample to pitch-stretch and mangle — because two detuned oscillators
// through a throttle-driven lowpass track revs the way a small four-cylinder
// does, at zero asset cost.

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
// thrum), the pair detuned a few cents so they beat against each other like
// uneven cylinders, both through one lowpass whose cutoff opens with the
// throttle (the "roar" when you floor it), plus a whisper of lowpassed noise
// for intake hiss. Every parameter change rides setTargetAtTime with a ~25 ms
// time constant (≈ 60–80 ms perceived settle), so per-frame speed updates
// can never click or zipper.
const ENGINE = {
  fIdle: 55, fMax: 190, curve: 0.65,  // rev curve: eager off idle, flat on top
  loCut: 600, hiCut: 2400,            // lowpass span, closed → floored
  gIdle: 0.12, gThrottle: 0.10, gSpeed: 0.04,
  tau: 0.025,
};
let eng = null;   // { oscA, oscB, filter, gain, noise, nGain } while running

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
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass'; filter.frequency.value = ENGINE.loCut; filter.Q.value = 1.1;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(); noise.loop = true;
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'lowpass'; nFilter.frequency.value = 480;
  const nGain = ctx.createGain(); nGain.gain.value = 0.015;
  const gain = ctx.createGain();
  gain.gain.value = 0;                 // born silent, fade in — no start pop
  oscA.connect(filter); oscB.connect(filter); filter.connect(gain);
  noise.connect(nFilter); nFilter.connect(nGain); nGain.connect(gain);
  gain.connect(master);
  oscA.start(t); oscB.start(t); noise.start(t, Math.random());
  gain.gain.setTargetAtTime(ENGINE.gIdle, t, 0.06);
  eng = { oscA, oscB, filter, gain, noise, nGain };
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
    try { e.oscA.stop(); e.oscB.stop(); e.noise.stop(); } catch {}
    e.oscA.disconnect(); e.oscB.disconnect(); e.noise.disconnect();
    e.filter.disconnect(); e.nGain.disconnect(); e.gain.disconnect();
  }, 350);
}

// Called every frame while driving — scalar math and AudioParam writes only,
// zero allocations. speed01 = |speed|/vmax, throttle01 = |gas| from input.
export function engineSet(speed01, throttle01) {
  if (!eng) return;
  const s = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;
  const th = throttle01 < 0 ? 0 : throttle01 > 1 ? 1 : throttle01;
  const t = ctx.currentTime, tau = ENGINE.tau;
  // pow(s, 0.65): revs climb eagerly off the line then flatten toward vmax —
  // the closest a gearbox-free arcade car gets to feeling like it shifts up
  const f = ENGINE.fIdle + (ENGINE.fMax - ENGINE.fIdle) * Math.pow(s, ENGINE.curve);
  eng.oscA.frequency.setTargetAtTime(f, t, tau);
  eng.oscB.frequency.setTargetAtTime(f / 2, t, tau);
  eng.filter.frequency.setTargetAtTime(ENGINE.loCut + (ENGINE.hiCut - ENGINE.loCut) * th, t, tau);
  eng.gain.gain.setTargetAtTime(ENGINE.gIdle + ENGINE.gThrottle * th + ENGINE.gSpeed * s, t, tau);
  eng.nGain.gain.setTargetAtTime(0.015 + 0.035 * th, t, tau);   // intake hiss
}
