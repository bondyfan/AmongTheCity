// ---- Audio: one-shot SFX, city bed, procedural car engine + heli rotor ----
// One AudioContext for the whole game. Browsers park fresh contexts in
// 'suspended' until a user gesture, so main wires initAudio() to every
// click/keydown — it creates the context once and merely resumes it after
// that, which makes it free to call as often as you like. sfx() streams mp3s
// from assets/sounds and NEVER throws: a missing file is remembered as null
// and the call turns into a silent no-op, so the game runs fine from a bare
// checkout with an empty assets folder. The engine is pure synthesis — no
// looped sample to pitch-stretch and mangle — because only synthesis can
// follow revs, gears and throttle continuously at zero asset cost. v2 adds a
// virtual 5-speed box: road speed no longer maps straight to pitch, it picks
// a GEAR, and pitch follows in-gear revs — so accelerating climbs-drops-climbs
// like a real drivetrain instead of one long glissando.
//
// v4 adds the CITY layer, and it is deliberately three things and not thirty:
//   · one looping sample bed (city_ambience) that ducks when you drive fast,
//   · ONE procedural low rumble standing in for all nearby traffic — a
//     PannerNode per AI car would be 45 voices of mush at 45× the cost, and
//     you cannot localise tyre roar anyway, only its density,
//   · one procedural helicopter rotor (LFO-gated noise) — a rotor is a gate
//     rate and a filter, i.e. exactly the two things a sample can't follow
//     while the machine spools up and flies away.
//
// v7 is a MIX pass plus the events: the city bed and traffic hum come up (they
// were tuned into inaudibility), the rotor becomes the loudest continuous
// element at flight revs and now grows with speed, honks are real generated
// samples with the old synth as fallback, and sfxAt()/setListener() add a
// zero-cost distance falloff for the world's one-shots (debris, screams).

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
  if (ctx.state === 'suspended') ctx.resume().then(ambBuild).catch(() => {});
  else if (ctx.state === 'running') ambBuild();
  // ...and THAT is why ambBuild is called from here: main boots the ambience
  // during load, long before the first click, so the wish is remembered and
  // the loop actually starts on whichever gesture finally unlocks the context.
}

export function setVolume(v) {
  volume = v < 0 ? 0 : v > 1 ? 1 : v;
  if (master) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.03);
}

// ---- one-shot samples --------------------------------------------------
export function sfx(name, vol = 1, rate = 1) {
  if (!ctx || ctx.state !== 'running') return;  // pre-gesture: sources would
  const buf = buffers.get(name);                // queue up and burst on resume
  if (buf) { playSample(name, buf, vol, rate); return; }
  if (buf === null) { fallback(name, vol); return; }   // known missing
  // first request: fetch+decode exactly once and play on arrival — ~100 ms of
  // first-play latency beats dropping the cue; every later call is instant
  loadBuffer(name).then(b => { if (b) playSample(name, b, vol, rate); else fallback(name, vol); });
}

// One indirection over playBuffer so a cue other code must SYNC TO is noted at
// the moment it actually starts: heliSet() crossfades the procedural rotor in
// under the tail of the heli_start sample, so it needs to know when that
// sample ends — including the case where the first play arrives late off the
// network. Everything else passes straight through.
function playSample(name, buf, vol, rate) {
  if (name === 'heli_start') heliXfEnd = ctx.currentTime + buf.duration / (rate || 1);
  playBuffer(buf, vol, rate);
}

// One fetch+decode per name for the whole session, shared by sfx() and the
// looping ambience. NEVER rejects: a missing file resolves to null and is
// remembered as null, so a bare checkout costs one 404 per sound, not one per
// call. Only reached on a cache miss, so the promise it allocates is rare.
function loadBuffer(name) {
  const have = buffers.get(name);
  if (have !== undefined) return Promise.resolve(have);
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
  return p;
}

// Sample-backed since v7: gen-sounds.mjs renders four real honks
// (car_horn_short/long/double + a rare truck_horn), and every honk picks one
// at random with ±6 % playbackRate — a pitch jitter at play time is cheaper
// than shipping ten variants and sounds like more, so a jam never sounds like
// one car with a stutter. Volume jitters too. On a bare checkout the old path
// takes over: the horn_far/horn_angry samples if those exist, else the
// synthesized dyad in hornBeep() — a honk always sounds, whatever is on disk.
// Callers (traffic AI, the player's key) never choose which honk — the mix
// decides. They DO say where it came from: `horn(x, z)` is a car somewhere in
// the city and attenuates with distance, `horn()` with no arguments is your own
// steering wheel and is always at full volume. It used to be unpanned in every
// case, so the traffic AI had to hide the problem by refusing to honk beyond
// 110 m — which only meant a horn at 109 m was as loud as one at two.
const CAR_HORNS = ['car_horn_short', 'car_horn_long', 'car_horn_double'];
const HORN_MAX = 220;                              // m — a car horn is loud
export function horn(x, z) {
  if (!ctx || ctx.state !== 'running') return;
  const name = Math.random() < 0.08 ? 'truck_horn'
    : CAR_HORNS[(Math.random() * CAR_HORNS.length) | 0];
  const rate = 0.94 + Math.random() * 0.12;        // ±6 % — a different car each time
  let vol = (name === 'truck_horn' ? 0.8 : 0.65) * (0.85 + Math.random() * 0.3);
  if (x !== undefined) {
    vol = gainAt(vol, x, z, HORN_MAX);
    if (vol < 0.015) return;
  }
  const buf = buffers.get(name);
  if (buf) { playBuffer(buf, vol, rate); return; }
  if (buf === null) { hornLegacy(vol); return; }   // known missing → old mix
  loadBuffer(name).then(b => b ? playBuffer(b, vol, rate) : hornLegacy(vol));
}

// The pre-v7 horn: two generated horns picked per honk, themselves falling
// back to the synthesized dyad via fallback() when those files are missing too.
function hornLegacy(scale = 1) {
  const angry = Math.random() < 0.4;   // most honks are the mild one
  sfx(angry ? 'horn_angry' : 'horn_far',
    scale * (angry ? 0.75 : 0.6) * (0.88 + Math.random() * 0.24));
}

// ---- positioned one-shots ------------------------------------------------
// The cheap spatializer for debris, screams and other world events: a plain
// linear falloff against the last known listener position — no PannerNode, no
// per-source graph, just a volume. main.js pushes the listener in every frame
// from wherever the player's ears are — the car they are driving, or their own
// feet. It used to be forwarded by interiorsim.update() instead, as a side
// effect of the building-streaming scan, which meant that turning interiors OFF
// in the graphics settings silently turned distance attenuation off with them
// and every sound in the city played at full volume. Until the first call
// sfxAt is unattenuated: better a loud cue than a silently swallowed one. `cooldown` (seconds, per name) is for the
// cues that fire in bursts — one collapse must not become eight rumbles.
let lisX = 0, lisZ = 0, lisSet = false;
const sfxLast = new Map();     // name → ctx.currentTime of last cooldown play

export function setListener(x, z) { lisX = x; lisZ = z; lisSet = true; }

// Sound pressure falls as 1/r, not linearly. The old linear taper made a car
// horn at 50 m play at 81 % of full — which is why every honk in the city
// sounded like it was coming from the passenger seat. REF is the distance
// inside which a source is simply "close" and stops getting louder; past it the
// inverse law takes over, and a linear factor drags the last of it to exactly
// zero at maxDist so nothing ever clicks off mid-tail.
//
//   distance     old      now
//        10 m   0.96     0.96
//        30 m   0.88     0.29
//        50 m   0.81     0.16
//       110 m   0.58     0.05
const REF = 10;
export function gainAt(vol, x, z, maxDist) {
  if (!lisSet) return vol;
  const d = Math.hypot(x - lisX, z - lisZ);
  if (d >= maxDist) return 0;
  return vol * (REF / Math.max(REF, d)) * (1 - d / maxDist);
}

export function sfxAt(name, vol, x, z, maxDist = 260, cooldown = 0) {
  if (!ctx || ctx.state !== 'running') return;
  const g = gainAt(vol, x, z, maxDist);
  if (g < 0.015) return;                     // inaudible — don't burn the cooldown
  if (cooldown > 0) {
    const last = sfxLast.get(name);
    if (last !== undefined && ctx.currentTime - last < cooldown) return;
    sfxLast.set(name, ctx.currentTime);
  }
  sfx(name, g);
}

function playBuffer(buf, vol, rate = 1) {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  if (rate !== 1) src.playbackRate.value = rate;
  const g = ctx.createGain();
  g.gain.value = vol;
  src.connect(g); g.connect(master);
  src.onended = () => { src.disconnect(); g.disconnect(); };
  src.start();
}

// Cues the PLAYER acts on must survive a bare checkout with no generated
// assets — doors (did I get in?) and horns (traffic is yelling at me) both
// carry information, so both get a synthesized stand-in. Everything else
// missing stays silent by design.
function fallback(name, vol) {
  if (name === 'door_open' || name === 'door_close') doorThunk(name, vol);
  else if (name === 'horn' || name === 'horn_far' || name === 'horn_angry') hornBeep(name, vol);
}

// A 90 ms slice of lowpassed noise with a fast decay reads as a car door.
// Open is brighter (the latch click), close sits low (the solid slam).
function doorThunk(name, vol) {
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

// A real car horn is two reeds a rough minor third apart (≈ 2:2.4) — that
// beating dyad, not the pitch, is what makes it read as "car" instead of
// "beep". Distance is faked the way distance actually works: the far horn
// loses its top end to a lowpass and most of its level, the angry one holds
// longer and stays bright.
function hornBeep(name, vol) {
  const t = ctx.currentTime;
  const far = name === 'horn_far';
  const dur = name === 'horn_angry' ? 0.85 : 0.3;
  const a = ctx.createOscillator(); a.type = 'square'; a.frequency.value = far ? 392 : 415;
  const b = ctx.createOscillator(); b.type = 'square'; b.frequency.value = (far ? 392 : 415) * 1.19;
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass'; f.frequency.value = far ? 900 : 2600; f.Q.value = 0.8;
  const g = ctx.createGain();
  const peak = (far ? 0.11 : 0.2) * vol;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + 0.012);   // hard attack — horns bark
  g.gain.setValueAtTime(peak, t + dur);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.06);
  a.connect(f); b.connect(f); f.connect(g); g.connect(master);
  a.start(t); b.start(t); a.stop(t + dur + 0.08); b.stop(t + dur + 0.08);
  b.onended = () => { a.disconnect(); b.disconnect(); f.disconnect(); g.disconnect(); };
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

// ---- looping city ambience ---------------------------------------------
// The bed the whole mix sits on: one buffer, looped forever, at a level low
// enough that you notice it only when it's gone. It DUCKS — quieter AND
// duller — while you drive fast or a rotor is beating overhead, because both
// physically drown the street out; the lowpass is what turns "turned down" into
// "heard through a closed window", which is the difference between a mixing
// desk move and a place. The duck factor is a single scalar shared by every
// source that can claim the mix, so two claims never stack into silence.
const AMB = {
  vol: 0.55,          // the floor of the mix, but a floor you HEAR — v7 raised
                      // it from 0.42 after "neslyším hluk dopravy": on foot the
                      // city must be unmistakably there, not a rumor
  duckMin: 0.5,       // full duck leaves HALF (was a third) — driving fast dims
                      // the street, it no longer erases it
  lpOpen: 16000,      // undisturbed street: no filtering worth the name...
  lpShut: 900,        // ...fully ducked: the world outside the windscreen
  fadeIn: 1.4, fadeOut: 0.5,
  tau: 0.45,          // duck glide — slow, a mix move you feel and don't hear
  step: 0.02,         // ignore duck wobble smaller than this (per-frame callers)
};
let amb = null;          // { src, lp, gain } while the loop is actually playing
let ambWant = false;     // ambientStart() called and not yet stopped
let ambPending = false;  // a load is in flight — don't start a second one
let ambDuck = 1, ambDuckAt = -1;   // live duck factor + the last one WRITTEN
let duckDrive = 0, duckHeli = 0, duckTrain = 0;   // the claimants, 0..1 each

// exponential (pitch-linear) cutoff travel — a linear Hz ramp would spend
// almost all its audible movement in the last 10 % of the slider
const ambCut = () => AMB.lpShut
  * Math.pow(AMB.lpOpen / AMB.lpShut, (ambDuck - AMB.duckMin) / (1 - AMB.duckMin));

export function ambientStart() {
  ambWant = true;
  ambBuild();   // silently does nothing until the context is unlocked
}

export function ambientStop() {
  ambWant = false;
  if (!amb) return;
  const a = amb;
  amb = null;                     // duck writes go inert immediately
  const t = ctx.currentTime;
  a.gain.gain.cancelScheduledValues(t);
  a.gain.gain.setTargetAtTime(0, t, AMB.fadeOut / 3);
  setTimeout(() => {
    try { a.src.stop(); } catch {}
    a.src.disconnect(); a.lp.disconnect(); a.gain.disconnect();
  }, AMB.fadeOut * 1000 + 250);
}

// graph: buffer(loop) → lowpass(duck) → gain(duck) → master
function ambBuild() {
  if (!ctx || ctx.state !== 'running' || amb || ambPending || !ambWant) return;
  ambPending = true;
  loadBuffer('city_ambience').then(buf => {
    ambPending = false;
    // the wish may have been cancelled, or the file may simply not exist yet
    // (nobody has run gen-sounds.mjs) — either way, stay silent, never throw
    if (!buf || !ambWant || amb || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = ambCut(); lp.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = 0;            // fade in — a bed that snaps on is a cue
    src.connect(lp); lp.connect(gain); gain.connect(master);
    // start at a random point in the loop so two sessions (or a stop/start)
    // never hear the same ten seconds in the same order
    src.start(t, Math.random() * buf.duration);
    gain.gain.setTargetAtTime(AMB.vol * ambDuck, t, AMB.fadeIn / 3);
    amb = { src, lp, gain };
    ambDuckAt = ambDuck;
  });
}

// Called from engineSet/heliSet/trainSet — i.e. every frame — so it must cost
// nothing when nothing changed: one max, one subtract, one compare, out.
function duckUpdate() {
  let d = duckDrive > duckHeli ? duckDrive : duckHeli;
  if (duckTrain > d) d = duckTrain;
  ambDuck = 1 - (1 - AMB.duckMin) * d;
  if (!amb || Math.abs(ambDuck - ambDuckAt) < AMB.step) return;
  ambDuckAt = ambDuck;
  const t = ctx.currentTime;
  amb.gain.gain.setTargetAtTime(AMB.vol * ambDuck, t, AMB.tau);
  amb.lp.frequency.setTargetAtTime(ambCut(), t, AMB.tau);
}

// ---- procedural engine loop --------------------------------------------
// v8 threw away the old three-oscillator bank (saw + sub triangle + square
// rasp, wobbled by a 4 Hz sine). That bank was a synthesizer patch, and it
// sounded like one, for three reasons worth writing down so nobody rebuilds
// it: a sawtooth puts energy on EVERY harmonic of its fundamental, while a
// real engine only has energy on multiples of the FIRING rate and silence in
// between; a continuous waveform has no time envelope, while a real engine is
// a sequence of explosions with a hard attack and an exponential tail; and a
// periodic LFO is vibrato, while the unevenness of a real engine is random.
//
// So the voice is now a FIRING PULSE TRAIN, built like this:
//   · one oscillator running at rpm/120 — the frequency of the whole 720°
//     four-stroke cycle, NOT the crank and NOT the firing rate. That choice is
//     what makes the harmonic index k mean "engine order k/2": for an inline
//     four the firing harmonics land on k = 4, 8, 12…, for an inline three on
//     k = 3, 6, 9… (orders 1.5, 3, 4.5 — the half-orders that make a triple
//     sound like it is limping). The gaps fall out of the maths, free.
//   · its PeriodicWave is one four-stroke cycle of cylinder pulses, each
//     shaped (1 − e^−αφ)·e^−βφ: α is the blowdown attack, β the decay. At
//     idle the oscillator runs at ~6 Hz and you hear the individual bangs;
//     by redline they fuse into a roar. That is the whole effect the user
//     asked for, and it is one oscillator.
//   · per-cylinder scatter (±3° of crank, ±6 % of amplitude) is baked into
//     the wave from a deterministic hash of the kind name — one cylinder is
//     always the lazy one, so an octavia is always the SAME octavia.
//   · cycle-to-cycle scatter is a slow random-walk buffer driving detune and
//     amplitude. Noise, not an LFO: a real engine is unsteady, not vibrato.
//     It shrinks with revs because the flywheel filters torque ripple.
//   · a feedback comb (delay = 2L/c, c ≈ 550 m/s in hot exhaust gas) IS the
//     exhaust pipe, and two peaking biquads are the silencer. Those never
//     move with revs — a real recording has a moving source inside FIXED
//     resonances, and that contrast is most of what the ear reads as "real".
//   · a tanh waveshaper whose input gain rides the throttle: more drive =
//     more harmonics = a harder engine when you floor it.
// Overrun (off the throttle, still spinning) is quieter and darker but with
// MORE pipe — higher comb feedback — which is exactly why lifting sounds
// hollow. On-throttle is louder, brighter and harder.
//
// VIRTUAL GEARBOX (unchanged from v2 in shape, it was always the good part —
// v15 only moved its edges from a normalized 0..1 into absolute m/s, see
// gearbox()) — road speed is sliced into five bands (the "gears"); inside a
// band the in-gear rev fraction runs 0→1 and rpm01 = 0.25 + 0.75·frac, so the
// engine never sits at true zero revs while rolling. The top band now ends at
// the KIND's own vmax, so a fast car finally revs out instead of pinning at
// the reference speed. Crossing a band edge triggers a ~120 ms
// scripted dip: freq+gain glide DOWN past the new gear's landing value, then
// recover — scheduled entirely with setTargetAtTime (never setValueAtTime) so
// the curve always departs from the current value and cannot click.
const ENGINE = {
  thCurve: 0.55,                      // pow(th, .55): filter opens HARD early —
                                      // half throttle already sounds urgent
  tau: 0.025,
  harmonics: 384,                     // partials baked into the wave. At a
                                      // 6 Hz idle that reaches ~2.3 kHz, well
                                      // past the idle lowpass; at redline the
                                      // browser band-limits what it must.
  jitterSec: 3,                       // length of the shared random-walk buffer
  combC: 550,                         // m/s — speed of sound in 400–600 °C
                                      // exhaust gas, NOT the 343 of cold air
  fbMax: 0.82,                        // comb feedback ceiling: past this the
                                      // loop rings instead of resonating
};
// Injection knock: a MUCH narrower pulse (alpha 200, beta 25) than combustion,
// gating a noise band at 1.8 kHz. Shape is shared by every kind — only the
// level differs, and that level is the petrol/diesel line.
const KNOCK = { f: 1800, q: 2.5, alpha: 200, beta: 25, base: 0.05, depth: 0.55 };
// engineSet() takes metres per second now, so this is no longer a divisor —
// it is the REFERENCE ROAD SPEED the whole mix was tuned against (CAR.vmax in
// config.js, 38 m/s = 137 km/h), and it survives only as the yardstick for the
// things that are genuinely about absolute speed rather than about revs: where
// the four lower shift points sit, and where the city bed finishes ducking.
//
// It used to be the divisor main.js applied before calling, which is what made
// this file wrong at both ends. Slow kinds could never reach the top gears (a
// truck peaked at 0.69 and never saw fifth) and were patched with a per-kind
// `sK` rescale; fast kinds had the opposite problem and no patch at all — an
// Octavia does 64 m/s, so everything above 38 arrived clamped at 1 and the
// engine hung at redline for the last 90 km/h it can actually do. Both are one
// bug: a fraction of the wrong top speed. Metres per second has no top speed
// in it, so there is nothing left to get wrong.
const SPEED_REF = 38;
// Per-kind engine identity. cyl → firing order and therefore which harmonics
// exist at all; alpha/beta → pulse shape (bigger beta = shorter pulse =
// brighter); exL → exhaust length in metres, i.e. where the comb peaks land;
// drive → how hard the waveshaper is pushed at full throttle; knock → the
// 1.8 kHz injection rattle that IS the diesel sound (petrol keeps a trace,
// without it the voice is suspiciously clean).
const ENG_KINDS = {
  // the Czech default: neutral, mid-bright four. Every other voice is a
  // deliberate departure from this one.
  octavia: { cyl: 4, alpha: 70, beta: 10, rpmIdle: 780, rpmMax: 6200, vmax: 64,
    exL: 3.6, combG: 0.55, knock: 0.012, turbo: 0, drive: 2.9, pops: 0,
    peak1: 120, peak2: 560, cutLo: 430, cutHi: 4600, vol: 0.22, intake: 0.075 },
  // Fabia IV 1.0 TSI really is a THREE — root order 1.5, so the odd
  // half-orders carry real energy and it thrums unevenly on purpose
  fabia: { cyl: 3, alpha: 75, beta: 11, rpmIdle: 800, rpmMax: 6000, vmax: 56,
    exL: 3.0, combG: 0.52, knock: 0.015, turbo: 0, drive: 2.7, pops: 0,
    peak1: 132, peak2: 600, cutLo: 440, cutHi: 4300, vol: 0.215, intake: 0.07 },
  // straight six, revs to 7000, short pulse (beta 6) = hard and bright.
  // The only kind that pops on the overrun.
  bmw: { cyl: 6, alpha: 65, beta: 6, rpmIdle: 700, rpmMax: 7000, vmax: 69,
    exL: 4.2, combG: 0.60, knock: 0.010, turbo: 0.02, drive: 3.6, pops: 1,
    peak1: 112, peak2: 640, cutLo: 420, cutHi: 5400, vol: 0.225, intake: 0.085 },
  // same six, opposite manners: long pulse, slack comb and a 3.2 kHz ceiling
  // — expensive silence rather than noise
  mercedes: { cyl: 6, alpha: 60, beta: 13, rpmIdle: 650, rpmMax: 6500, vmax: 67,
    exL: 4.2, combG: 0.48, knock: 0.008, turbo: 0, drive: 2.3, pops: 0,
    peak1: 108, peak2: 480, cutLo: 400, cutHi: 3200, vol: 0.21, intake: 0.055 },
  van: { cyl: 4, alpha: 130, beta: 9, rpmIdle: 800, rpmMax: 4200, vmax: 36.11,
    exL: 4.0, combG: 0.58, knock: 0.07, turbo: 0.025, drive: 2.6, pops: 0,
    peak1: 126, peak2: 520, cutLo: 400, cutHi: 2600, vol: 0.235, intake: 0.05 },
  // 2400 rpm redline: firing never leaves 30–120 Hz, so it is felt more than
  // heard, and the vertical stack is the longest pipe in the game
  truck: { cyl: 6, alpha: 145, beta: 8, rpmIdle: 600, rpmMax: 2400, vmax: 26.39,
    exL: 5.0, combG: 0.65, knock: 0.10, turbo: 0.04, drive: 2.8, pops: 0,
    peak1: 100, peak2: 450, cutLo: 380, cutHi: 2400, vol: 0.26, intake: 0.045 },
  bus: { cyl: 6, alpha: 140, beta: 7, rpmIdle: 550, rpmMax: 2200, vmax: 29.17,
    exL: 6.0, combG: 0.68, knock: 0.09, turbo: 0.035, drive: 2.6, pops: 0,
    peak1: 96, peak2: 430, cutLo: 370, cutHi: 2200, vol: 0.255, intake: 0.04 },
  // no pulse train, no pipe, no gearbox — see EV below and engineSet()
  tesla: { ev: 1, vmax: 72 },
};
// pre-v4 saves and main.js's spawn list still say sedan/hatch/kombi/suv
const ENG_ALIAS = { sedan: 'octavia', hatch: 'fabia', kombi: 'octavia', suv: 'bmw' };

// A Tesla has ONE reduction gear (≈9:1), so nothing about it is periodic in
// engine cycles — every tone is strictly proportional to ROAD SPEED and there
// is no idle at all. Different code, not different parameters.
const EV = {
  whineK: 88,        // Hz per m/s: v/2.05 m wheel circumference × 9.0 reduction
                     // × ~20 gear teeth ≈ 88·v — the gear mesh whine
  whineMin: 90, whineMax: 5000,
  stage2: 1.62,      // second reduction stage. NOT 2× — the slight dissonance
                     // is what reads as "electric car" instead of "theremin"
  humK: 13.2,        // n_motor × 3 pole pairs, also per m/s
  pwmF: 2400,        // inverter switching tone, FIXED; ring-modulated by the
                     // motor rate so you hear its sidebands, not a test tone
  lp: 7000,
  vol: 0.6,          // thinner than a combustion voice on purpose: above
                     // ~50 km/h a Model 3 is mostly tyres, and tireSet()
                     // already carries that weight
  fadeV: 1.5,        // m/s over which the whole voice fades up from silence
};
// gear-whine timbre: a fundamental with a short, fast-falling harmonic tail
const EV_REAL = new Float32Array([0, 1, 0.30, 0.14, 0.06]);
const EV_IMAG = new Float32Array(EV_REAL.length);

// tanh transfer curve for the drive stage — allocated once, shared by every
// engine that ever starts. Input gain (not this table) is what varies.
//
// A WaveShaper always maps input −1…+1 across the whole table and CLAMPS
// beyond it, so a drive gain of 3.6 fed straight in would hard-clip (buzz,
// aliasing) instead of saturating. The table therefore covers ±SHAPE_SPAN of
// pre-gain and the drive stage divides by it: shaper(D·x / SPAN) = tanh(D·x)
// exactly, for any D up to SPAN.
const SHAPE_SPAN = 4;
const SHAPE_DRIVE_LO = 0.9;   // idle: barely bent. Floored: P.drive, near-square.
const SHAPE_CURVE = new Float32Array(2048);
for (let i = 0; i < 2048; i++) SHAPE_CURVE[i] = Math.tanh((i / 1023.5 - 1) * SHAPE_SPAN);

// Deterministic 0..1 from a name + salt. audio.js deliberately imports
// nothing, so this is a local FNV/mulberry mash rather than the world's
// rnd(id, salt) — same contract: the same kind always gets the same scatter,
// so every octavia in every session has the same lazy cylinder.
function hash01(name, salt) {
  let h = (2166136261 ^ salt) >>> 0;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 15; h = Math.imul(h, 2246822507); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

// One four-stroke cycle of cylinder pulses, as PeriodicWave coefficients.
//
// The obvious way is to draw the cycle into a 2048-point buffer and DFT it —
// a million multiply-adds per kind. Unnecessary: the pulse
//     g(φ) = (1 − e^−αφ)·e^−βφ,  φ ∈ [0, 2π)
// has a closed-form Fourier transform, and firing a cylinder at angle φᵢ is
// just a phase rotation e^−ikφᵢ. So the whole spectrum is one analytic
// coefficient times the sum of the cylinders' phasors — a few thousand ops
// instead of a million, and EXACT rather than sampled.
//     ∫₀²ᵖ e^−βφ e^−ikφ dφ = (1 − e^−2πβ)/(β + ik)
// gives Cₖ, and for real g the WebAudio coefficients are a = 2·Re C,
// b = −2·Im C. Cylinder scatter falls out of the phasor sum, so half-orders
// and V-bank asymmetry appear on their own — nothing is tuned by hand.
//
// Pure function, no WebAudio, no globals: testable in node. Returns
// { real, imag } for createPeriodicWave plus `rms`, the RMS the wave will
// have AFTER the browser normalizes it to ±1 — a peaky diesel normalizes to a
// much quieter signal than a smooth six, and the mix has to know.
export function engineWave(cyl, alpha, beta, id, jitterDeg = 6, ampSpread = 0.12) {
  const K = ENGINE.harmonics;
  const real = new Float32Array(K + 1), imag = new Float32Array(K + 1);
  const TAU = Math.PI * 2;
  // phase (rad of the 720° cycle) and relative strength of each cylinder
  const phase = new Float64Array(cyl), amp = new Float64Array(cyl);
  for (let i = 0; i < cyl; i++) {
    const deg = i * (720 / cyl) + (hash01(id, 300 + i) - 0.5) * jitterDeg;
    phase[i] = (deg / 720) * TAU;
    amp[i] = 1 + (hash01(id, 400 + i) - 0.5) * ampSpread;
  }
  const g = alpha + beta;
  const A = 1 - Math.exp(-TAU * beta), B = 1 - Math.exp(-TAU * g);
  for (let k = 1; k <= K; k++) {
    const db = beta * beta + k * k, dg = g * g + k * k;
    const cr = (A * beta / db - B * g / dg) / TAU;          // Re Cₖ
    const ci = (-A * k / db + B * k / dg) / TAU;            // Im Cₖ
    let pr = 0, pi = 0;                                     // Σ ampᵢ e^−ikφᵢ
    for (let i = 0; i < cyl; i++) {
      const w = k * phase[i];
      pr += amp[i] * Math.cos(w);
      pi -= amp[i] * Math.sin(w);
    }
    real[k] = 2 * (cr * pr - ci * pi);
    imag[k] = -2 * (cr * pi + ci * pr);
  }
  // peak and RMS straight off the analytic pulse — 512 points is plenty for a
  // level estimate and costs a few thousand exp() calls, once per kind ever
  let peak = 1e-9, sum = 0;
  for (let m = 0; m < 512; m++) {
    const p = (m / 512) * TAU;
    let y = 0;
    for (let i = 0; i < cyl; i++) {
      let d = p - phase[i];
      if (d < 0) d += TAU;
      y += amp[i] * (1 - Math.exp(-alpha * d)) * Math.exp(-beta * d);
    }
    if (y > peak) peak = y;
    sum += y * y;
  }
  return { real, imag, rms: Math.sqrt(sum / 512) / peak };
}

// PeriodicWave objects are immutable and shareable, and building the
// browser's per-octave band-limited tables is the expensive half — so cache
// per (kind, role). Two entries per kind for the whole session.
const _waves = new Map();
// id (the kind name) seeds the cylinder scatter and is deliberately the SAME
// for both roles: the knock rattle has to land on the same cylinders, at the
// same slightly-off angles, as the combustion pulses it belongs to.
function engineWaveFor(id, cyl, alpha, beta, role) {
  const key = id + '|' + role;
  let w = _waves.get(key);
  if (!w) {
    const c = engineWave(cyl, alpha, beta, id);
    w = { wave: ctx.createPeriodicWave(c.real, c.imag), rms: c.rms };
    _waves.set(key, w);
  }
  return w;
}

// Cycle-to-cycle unsteadiness, as a signal rather than an LFO. A lowpassed
// random walk (~10 Hz of usable bandwidth) looped forever: no period the ear
// can lock onto, which is the entire difference between "engine" and "synth".
// One buffer for the session; every start reads in from a random offset.
let _jitterBuf = null;
function jitterBuffer() {
  if (!_jitterBuf) {
    const n = (ctx.sampleRate * ENGINE.jitterSec) | 0;
    _jitterBuf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = _jitterBuf.getChannelData(0);
    let v = 0, peak = 1e-6;
    for (let i = 0; i < n; i++) {
      v += (Math.random() * 2 - 1 - v * 0.06) * 0.06;
      d[i] = v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    for (let i = 0; i < n; i++) d[i] /= peak;   // ±1, so depths read in units
  }
  return _jitterBuf;
}
// Upper edge of each gear as a fraction of SPEED_REF. This is the SHAPE of the
// gearbox, not the gearbox: gearbox() below turns it into absolute m/s per
// kind. Last edge sits past 1 so flat-out stays in 5th (hysteresis below can
// never push beyond it either).
const GEAR_TOP = [0.12, 0.28, 0.48, 0.72, 1.001];
// Cruising exactly ON a band edge must not machine-gun shifts every frame, so
// a change only registers once road speed leaves the current band by this
// much — also a fraction of the reference, converted alongside the edges.
const GEAR_HYST = 0.012;

// ---- the gearbox, in metres per second ----------------------------------
// Shift points are ROAD SPEEDS, not fractions of a top speed. First gear is
// for pulling away, so an Octavia and a bus both leave it at ~16 km/h; a bus
// does not shift up at 60 km/h just because it happens to run out of road at
// 105. Scaling GEAR_TOP by min(vmax, SPEED_REF) is what says that, and it
// reproduces EXACTLY the four speeds that were audible before this change:
//   fast kinds (vmax ≥ 38): 4.56 / 10.64 / 18.24 / 27.36 m/s
//                         = 16 / 38 / 66 / 98 km/h, unchanged
//   slow kinds:  the same numbers their old sK rescale produced, to the digit
//                (truck 11 / 27 / 46 / 68 km/h, bus 13 / 29 / 50 / 76)
// so nobody's gearbox suddenly shifts somewhere new.
//
// What changes is what happens ABOVE the reference speed, and the fix is to
// ADD GEARS, not to stretch the last one. Stretching was the first attempt and
// it traded one fault for a worse one: fifth then ran 98 → 230 km/h on an
// Octavia, a 2.34× step where every other step is 1.4–1.7×, and since
// rpm01 maps every band idle→redline the engine dropped to 992 rpm at 100
// km/h and did not sound like it was pulling again until about 180. That is
// dead centre of the band people actually drive on the obchvat. So the ladder
// keeps climbing at GEAR_UP per gear until the kind's real vmax is in reach:
// the fast kinds all come out as seven-speeds, which is what a DSG Octavia
// or a ZF-8 BMW is anyway, and the 98–137 km/h band is note-for-note what it
// was before this whole round. Only above 137 km/h is anything new, and there
// the old code was a single held note at the limiter.
//   octavia  16/38/66/98/137/181 → 231 km/h   bmw   …/181 → 248
//   fabia    16/38/66/98/137/181 → 202        merc  …/181 → 241
//   van 17/38/64/95 → 130, truck 12/28/47/70 → 95, bus 14/31/52/77 → 105
//     (unchanged: their vmax is below the reference, so no gear is added)
// ×1.001 keeps `v > edge` unreachable on the LAST edge, so the gear index can
// never walk off the end of the array (v is clamped to vmax by the caller).
const GEAR_UP = 1.32;    // ratio of each added overdrive; the ladder's own
                         // taper is 2.33 → 1.71 → 1.50 → 1.39, so this is
                         // simply where that sequence was heading
function gearbox(vmax) {
  const ref = Math.min(vmax, SPEED_REF);
  const gearEdges = GEAR_TOP.slice(0, -1).map((f) => f * ref);
  // A gear is only worth having if it gets a band of its own; 0.90 is what
  // stops a kind whose vmax lands just past an edge from sprouting a top gear
  // three km/h wide. Nothing is added at all when vmax ≤ the reference.
  let top = GEAR_TOP[GEAR_TOP.length - 1] * ref;
  while (top < vmax * 0.90) { gearEdges.push(top); top *= GEAR_UP; }
  gearEdges.push(vmax * 1.001);
  return { gearEdges, gearHyst: GEAR_HYST * ref };
}
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

// kind is any key of ENG_KINDS (a car's runtime .kind) — omit it and you get
// the Octavia four, so pre-v8 callers still work unchanged.
export function engineStart(kind = 'octavia') {
  if (!ctx || ctx.state !== 'running' || eng) return;
  const key = ENG_KINDS[kind] ? kind : (ENG_ALIAS[kind] ?? 'octavia');
  const P = ENG_KINDS[key];
  eng = P.ev ? buildEV(P) : buildPiston(P, key);
}

// Every node that must be stopped/disconnected lives in these two arrays, so
// engineStop() never has to know which of the two graph shapes it is killing.
function engNodes(e, ...n) { for (const x of n) e.nodes.push(x); return e; }

function buildPiston(P, id) {
  const t = ctx.currentTime;
  const f0 = P.rpmIdle / 120;                 // Hz of the whole 720° cycle
  const fire = engineWaveFor(id, P.cyl, P.alpha, P.beta, 'fire');
  const knockW = engineWaveFor(id, P.cyl, KNOCK.alpha, KNOCK.beta, 'knock');

  const osc = ctx.createOscillator();
  osc.setPeriodicWave(fire.wave);
  osc.frequency.value = f0;
  // cycle-to-cycle wobble: one source, two destinations (pitch and level)
  const jit = ctx.createBufferSource();
  jit.buffer = jitterBuffer(); jit.loop = true;
  const jCents = ctx.createGain(); jCents.gain.value = 0;   // output is CENTS
  const jAM = ctx.createGain(); jAM.gain.value = 0;         // adds to out.gain

  const drive = ctx.createGain(); drive.gain.value = SHAPE_DRIVE_LO / SHAPE_SPAN;
  const shaper = ctx.createWaveShaper();
  shaper.curve = SHAPE_CURVE;
  shaper.oversample = '2x';            // the player's own car is worth 2×:
                                       // tanh on a redlining pulse train
                                       // aliases audibly at 1×
  // --- the exhaust: a feedback comb IS a pipe. delay = 2L/c (half-wave, both
  // ends open) puts the first peak at c/2L — 46 Hz for the bus's 6 m, 83 Hz
  // for the Fabia's 3 m. The lowpass INSIDE the loop is not optional: without
  // it every reflection comes back as bright as it left and the thing flanges
  // instead of resonating.
  const dly = 2 * P.exL / ENGINE.combC;
  const dry = ctx.createGain(); dry.gain.value = 0.85;
  const combIn = ctx.createGain(); combIn.gain.value = 1;
  const delay = ctx.createDelay(0.08); delay.delayTime.value = dly;
  const damp = ctx.createBiquadFilter();
  damp.type = 'lowpass'; damp.frequency.value = 1200; damp.Q.value = 0.4;
  const fb = ctx.createGain(); fb.gain.value = P.combG * 0.86;
  // wet under dry: the pipe COLOURS the engine, it does not replace it, and a
  // resonating comb can peak several times its input on its own
  const combWet = ctx.createGain(); combWet.gain.value = 0.6;

  // --- the silencer. These two peaks NEVER move: fixed resonances under a
  // moving source is the contrast the ear hears as a recording rather than a
  // patch. peak1 is the boom you feel in the chest and is what lets a laptop
  // imply a 26 Hz firing fundamental it cannot actually reproduce.
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass'; hp.frequency.value = 45; hp.Q.value = 0.7;
  const pk1 = ctx.createBiquadFilter();
  pk1.type = 'peaking'; pk1.frequency.value = P.peak1; pk1.Q.value = 3.5; pk1.gain.value = 8;
  const pk2 = ctx.createBiquadFilter();
  pk2.type = 'peaking'; pk2.frequency.value = P.peak2; pk2.Q.value = 1.6; pk2.gain.value = 4;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = P.cutLo; lp.Q.value = 0.9;
  const out = ctx.createGain(); out.gain.value = 0;   // born silent — no pop

  // --- intake, on its own branch. The throttle plate is the th^1.5: shut, an
  // engine barely breathes; open, it roars. The old linear map left hiss
  // audible at all times, which is mush.
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(); noise.loop = true;
  const inBp = ctx.createBiquadFilter();
  inBp.type = 'bandpass'; inBp.frequency.value = 520; inBp.Q.value = 0.7;
  const inGain = ctx.createGain(); inGain.gain.value = 0;

  // --- knock: a narrow pulse train GATES a 1.8 kHz noise band. This one
  // detail is the whole difference between a petrol engine and a diesel;
  // petrol keeps a trace of it because a completely clean voice sounds fake.
  const kOsc = ctx.createOscillator();
  kOsc.setPeriodicWave(knockW.wave);
  kOsc.frequency.value = f0;
  const kDepth = ctx.createGain(); kDepth.gain.value = KNOCK.depth;
  const kBp = ctx.createBiquadFilter();
  kBp.type = 'bandpass'; kBp.frequency.value = KNOCK.f; kBp.Q.value = KNOCK.q;
  const kGate = ctx.createGain(); kGate.gain.value = KNOCK.base;
  const kLevel = ctx.createGain(); kLevel.gain.value = 0;

  osc.connect(drive); drive.connect(shaper);
  jit.connect(jCents); jCents.connect(osc.detune);
  jit.connect(jAM); jAM.connect(out.gain);
  shaper.connect(dry); dry.connect(hp);
  shaper.connect(combIn); combIn.connect(delay);
  delay.connect(damp); damp.connect(fb); fb.connect(combIn);   // the loop
  delay.connect(combWet); combWet.connect(hp);
  hp.connect(pk1); pk1.connect(pk2); pk2.connect(lp); lp.connect(out);
  noise.connect(inBp); inBp.connect(inGain); inGain.connect(out);
  noise.connect(kBp); kBp.connect(kGate); kGate.connect(kLevel); kLevel.connect(out);
  kOsc.connect(kDepth); kDepth.connect(kGate.gain);
  out.connect(master);

  const e = {
    ev: 0, P, out, osc, kOsc, drive, fb, damp, lp, inBp, inGain, kLevel,
    jCents, jAM,
    // level compensation: WebAudio normalizes a PeriodicWave to ±1, so a
    // spiky diesel pulse ends up far quieter in RMS than a smooth six. Undo
    // that here or every kind would need its `vol` hand-tuned twice.
    levelK: Math.min(2.4, Math.max(0.6, 0.20 / (fire.rms || 0.20))),
    // this kind's shift points in m/s, resolved once at build time — engineSet
    // stays scalar math with no per-frame allocation
    vmax: P.vmax || SPEED_REF,
    ...gearbox(P.vmax || SPEED_REF),
    gear: 0, shiftT: -1e9, boost: 0, lastT: t, thPrev: 0, popT: -1e9,
    srcs: [osc, kOsc, jit, noise], nodes: [],
  };
  engNodes(e, osc, jit, jCents, jAM, drive, shaper, dry, combIn, delay, damp,
    fb, combWet, hp, pk1, pk2, lp, noise, inBp, inGain, kOsc, kDepth, kBp,
    kGate, kLevel, out);

  if (P.turbo > 0) {
    const tOsc = ctx.createOscillator();
    tOsc.type = 'triangle'; tOsc.frequency.value = 1600;
    const tBp = ctx.createBiquadFilter();
    tBp.type = 'bandpass'; tBp.frequency.value = 1600; tBp.Q.value = 3;
    const tGain = ctx.createGain(); tGain.gain.value = 0;
    tOsc.connect(tBp); tBp.connect(tGain); tGain.connect(master);
    e.tOsc = tOsc; e.tBp = tBp; e.tGain = tGain;
    e.srcs.push(tOsc); engNodes(e, tOsc, tBp, tGain);
  }

  osc.start(t); kOsc.start(t);
  jit.start(t, Math.random() * ENGINE.jitterSec);   // no two cars in phase
  noise.start(t, Math.random());
  if (e.tOsc) e.tOsc.start(t);
  out.gain.setTargetAtTime(P.vol * e.levelK * 0.5, t, 0.06);
  return e;
}

// Tesla: one reduction gear, so every tone is proportional to road speed and
// nothing is proportional to "revs". No pulse train, no exhaust, no intake,
// no gearbox, and no idle — standing still it is silent, and the graph just
// sits at zero rather than being built and torn down.
function buildEV(P) {
  const t = ctx.currentTime;
  const wave = ctx.createPeriodicWave(EV_REAL, EV_IMAG);
  const whine = ctx.createOscillator();
  whine.setPeriodicWave(wave); whine.frequency.value = EV.whineMin;
  const wGain = ctx.createGain(); wGain.gain.value = 0;
  const whine2 = ctx.createOscillator();     // second stage, deliberately not
  whine2.setPeriodicWave(wave);              // an octave — 1.62× is the metallic
  whine2.frequency.value = EV.whineMin * EV.stage2;   // beat that says "EV"
  const w2Gain = ctx.createGain(); w2Gain.gain.value = 0;
  const humOsc = ctx.createOscillator();
  humOsc.type = 'triangle'; humOsc.frequency.value = 40;
  const humGain = ctx.createGain(); humGain.gain.value = 0;
  // inverter: a FIXED switching tone ring-modulated by the motor rate, so
  // what you hear is its sidebands sliding, not the carrier itself
  const pwm = ctx.createOscillator();
  pwm.type = 'sine'; pwm.frequency.value = EV.pwmF;
  const pwmLfo = ctx.createOscillator();
  pwmLfo.type = 'sine'; pwmLfo.frequency.value = 40;
  const pwmDepth = ctx.createGain(); pwmDepth.gain.value = 0;
  const ring = ctx.createGain(); ring.gain.value = 0;   // 0 intrinsic → pure ring
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = EV.lp; lp.Q.value = 0.5;
  const out = ctx.createGain(); out.gain.value = 0;

  whine.connect(wGain); wGain.connect(lp);
  whine2.connect(w2Gain); w2Gain.connect(lp);
  humOsc.connect(humGain); humGain.connect(lp);
  pwm.connect(ring); pwmLfo.connect(pwmDepth); pwmDepth.connect(ring.gain);
  ring.connect(lp);
  lp.connect(out); out.connect(master);
  whine.start(t); whine2.start(t); humOsc.start(t); pwm.start(t); pwmLfo.start(t);

  const e = {
    ev: 1, P, out, whine, whine2, wGain, w2Gain, humOsc, humGain, pwmLfo, pwmDepth,
    // no gearbox at all (one reduction gear), but the speed clamp in
    // engineSet() is shared, so the top speed still has to be here
    vmax: P.vmax || SPEED_REF,
    gear: 0, shiftT: -1e9, levelK: 1,
    srcs: [whine, whine2, humOsc, pwm, pwmLfo], nodes: [],
  };
  engNodes(e, whine, wGain, whine2, w2Gain, humOsc, humGain, pwm, pwmLfo,
    pwmDepth, ring, lp, out);
  return e;
}

export function engineStop() {
  if (!eng) return;
  const e = eng;
  eng = null;                          // engineSet() goes inert immediately
  duckDrive = 0; duckUpdate();         // out of the car → the street comes back
  const t = ctx.currentTime;
  e.out.gain.cancelScheduledValues(t);
  e.out.gain.setTargetAtTime(0, t, 0.05);
  // the amplitude-jitter signal ADDS to out.gain, so fading the intrinsic
  // value alone would leave a wobbling residue humming for the whole teardown
  if (e.jAM) { e.jAM.gain.cancelScheduledValues(t); e.jAM.gain.setTargetAtTime(0, t, 0.05); }
  // the turbo whistle is its own voice hung straight off master (it is not part
  // of the engine's mix and must not be ducked by the shift dip), so out's fade
  // never reaches it: without this it keeps spooling at full level for the whole
  // teardown and is then cut mid-cycle by disconnect() — the exact click the
  // delayed teardown exists to avoid, and audible on every bail-out of a rolling
  // van/truck/bus, the kinds whose boost is actually up
  if (e.tGain) { e.tGain.gain.cancelScheduledValues(t); e.tGain.gain.setTargetAtTime(0, t, 0.05); }
  // let the fade land (τ=50 ms → inaudible well before 350 ms) THEN tear the
  // graph down; a bare stop() mid-waveform is an audible click
  setTimeout(() => {
    for (const s of e.srcs) { try { s.stop(); } catch {} }
    for (const n of e.nodes) n.disconnect();
  }, 350);
}

// Overrun backfire — bmw only. Off a big throttle at revs, unburnt mixture
// lights in the pipe: a few short cracks at irregular spacing. Allocated on
// the spot because it fires maybe once a minute, never per frame.
function exhaustPop(t0, level) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(); src.loop = true;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 200 + Math.random() * 120; bp.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(level, t0 + 0.0015);   // a crack, not a swell
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.07);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t0, Math.random()); src.stop(t0 + 0.09);
  src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); };
}

// Called every frame while driving — scalar math and AudioParam writes only,
// zero allocations.
//   speedMS   ABSOLUTE road speed in metres per second (|car.speed|). NOT a
//             0..1: the caller has no way to know which top speed to divide
//             by, and dividing by the wrong one is the whole history of this
//             function — see SPEED_REF. engineStart() was told the kind, so
//             the normalizing happens here where the kind's vmax is known.
//   throttle01  0..1 engine LOAD from main.js engineLoad(), not |gas|.
export function engineSet(speedMS, throttle01) {
  if (!eng) return;
  // written ">0 ? … : 0" rather than "<0 ? 0 : …" so a NaN speed (one bad
  // physics frame) clamps to zero instead of poisoning every AudioParam in
  // the graph — a NaN reaching setTargetAtTime silences the node for good
  let v = speedMS > 0 ? speedMS : 0;
  // driveStep already holds the car at vmax, but a collision impulse can put
  // it a hair over and there is no gear above the last one to shift into
  if (v > eng.vmax) v = eng.vmax;
  const th = throttle01 > 0 ? (throttle01 > 1 ? 1 : throttle01) : 0;
  const t = ctx.currentTime, tau = ENGINE.tau;

  if (eng.ev) { evSet(v, th, t, tau); return; }

  // --- pick the gear: hop bands only once v clears the edge by the
  // hysteresis; the do/while lets hard braking drop several gears in one
  // frame. Edges and hysteresis are this kind's, in m/s, from gearbox(). ---
  const edges = eng.gearEdges, hyst = eng.gearHyst;
  let g = eng.gear;
  if (v > edges[g] + hyst) {
    do g++; while (v > edges[g] + hyst);
  } else if (g > 0 && v < edges[g - 1] - hyst) {
    do g--; while (g > 0 && v < edges[g - 1] - hyst);
  }

  // --- in-gear revs → voice targets (hysteresis can park v a hair outside
  // the band, so clamp frac). rpm01 = 0.25 + 0.75·frac per the contract; a
  // standing car sits at the kind's idle rpm, and every upshift audibly drops
  // revs by the same rule. The oscillator runs at rpm/120 = the frequency of
  // the whole four-stroke CYCLE, which is what puts the firing harmonics on
  // k = m·cyl and gives an odd-cylinder engine its half-orders for free. ---
  const P = eng.P;
  const lo = g > 0 ? edges[g - 1] : 0;
  let frac = (v - lo) / (edges[g] - lo);
  frac = frac < 0 ? 0 : frac > 1 ? 1 : frac;
  const rpm01 = 0.25 + 0.75 * frac;
  const f = (P.rpmIdle + (P.rpmMax - P.rpmIdle) * frac) / 120;
  // Off the throttle the engine is being turned BY the wheels with no fuel
  // burning: quieter and darker than idle, but with more pipe (see fb below).
  // That combination is the entire "hollow" character of lifting off.
  const over = (1 - th) * rpm01;
  // loudness rides REVS (frac), not road speed — so the shift that drops the
  // pitch also ducks the volume a touch, which is half of what sells it
  const vol = P.vol * eng.levelK
    * (0.55 + 0.45 * th + 0.28 * frac * th - 0.12 * over);

  if (g !== eng.gear) {
    // --- the shift: glide freq+gain DOWN past the new landing values, then
    // recover, all pre-scheduled so the next ~130 ms plays out untouched.
    // setTargetAtTime always departs from the live value → click-free even if
    // a fast sweep re-triggers mid-dip (new events simply take over from now).
    // Downshifts share the shape: the "dip" lands as a rev-match blip because
    // the landing pitch is higher — one code path, both directions read right.
    eng.gear = g; eng.shiftT = t;
    const fD = f * SHIFT.fDipK, tUp = t + SHIFT.upAt;
    eng.osc.frequency.setTargetAtTime(fD, t, SHIFT.downTau);
    eng.osc.frequency.setTargetAtTime(f, tUp, SHIFT.upTau);
    eng.kOsc.frequency.setTargetAtTime(fD, t, SHIFT.downTau);   // knock is the
    eng.kOsc.frequency.setTargetAtTime(f, tUp, SHIFT.upTau);    // same cylinders
    eng.out.gain.setTargetAtTime(vol * SHIFT.gDipK, t, SHIFT.downTau);
    eng.out.gain.setTargetAtTime(vol, tUp, SHIFT.upTau);
  } else if (t - eng.shiftT > SHIFT.hold) {
    // normal running: track revs per frame. Skipped during the hold window —
    // a setTargetAtTime issued NOW would supersede the scheduled recovery leg
    // and flatten the dip into a plain fade.
    eng.osc.frequency.setTargetAtTime(f, t, tau);
    eng.kOsc.frequency.setTargetAtTime(f, t, tau);
    eng.out.gain.setTargetAtTime(vol, t, tau);
  }

  // --- always live, shift or not: these don't take part in the dip ---
  // Drive into the waveshaper is the "hardness" control: barely bent at idle,
  // saturating when floored. This is what makes the throttle feel like a pedal
  // rather than a volume knob. /SHAPE_SPAN puts it in the table's domain.
  eng.drive.gain.setTargetAtTime(
    (SHAPE_DRIVE_LO + (P.drive - SHAPE_DRIVE_LO) * Math.pow(th, 0.7)) / SHAPE_SPAN, t, tau);
  // lowpass: opens hard and early with throttle; off the throttle it creeps up
  // only a little with revs, so overrun stays dark
  const cut = P.cutLo * (0.85 + 0.6 * rpm01)
    + (P.cutHi - P.cutLo) * Math.pow(th, ENGINE.thCurve);
  eng.lp.frequency.setTargetAtTime(cut, t, tau);
  // pipe resonance: MORE feedback and MORE top in the loop off the throttle
  let fbv = P.combG * (0.86 + 0.14 * th) + 0.16 * over;
  if (fbv > ENGINE.fbMax) fbv = ENGINE.fbMax;
  eng.fb.gain.setTargetAtTime(fbv, t, tau);
  eng.damp.frequency.setTargetAtTime(1150 + 1350 * th + 900 * over, t, tau);
  // intake: th^1.5 IS the throttle plate — shut, the engine barely breathes
  eng.inBp.frequency.setTargetAtTime(300 + 900 * rpm01, t, tau);
  eng.inGain.gain.setTargetAtTime(
    P.intake * th * Math.sqrt(th) * (0.3 + 0.7 * rpm01), t, tau);
  // knock is loudest unloaded — under full load combustion swamps it
  eng.kLevel.gain.setTargetAtTime(P.knock * (1 - 0.4 * th), t, tau);
  // cycle-to-cycle scatter shrinks with revs: the flywheel filters torque
  // ripple as ω rises, so a busy engine is a steady one
  eng.jCents.gain.setTargetAtTime(3 + 38 * (1 - rpm01), t, tau);
  eng.jAM.gain.setTargetAtTime(vol * (0.02 + 0.13 * (1 - rpm01)), t, tau);

  // turbo: the LAG is the sound. boost chases th·rpm01 with a slow rise and a
  // faster fall, integrated per frame off the context clock (no dt available).
  if (eng.tGain) {
    const dt = Math.min(0.1, t - eng.lastT);
    const want = th * rpm01;
    const k = 1 - Math.exp(-dt / (want > eng.boost ? (P.turbo > 0.03 ? 0.8 : 0.6) : 0.3));
    eng.boost += (want - eng.boost) * k;
    const fT = 1600 + 6000 * eng.boost;
    eng.tOsc.frequency.setTargetAtTime(fT, t, tau);
    eng.tBp.frequency.setTargetAtTime(fT, t, tau);
    eng.tGain.gain.setTargetAtTime(P.turbo * eng.boost * eng.boost, t, tau);
  }
  eng.lastT = t;

  // lift off a big throttle at revs and the pipe cracks — bmw only
  if (P.pops && th < 0.1 && eng.thPrev > 0.5 && rpm01 > 0.55 && t - eng.popT > 0.5) {
    eng.popT = t;
    const n = 2 + ((Math.random() * 4) | 0);
    let at = t + 0.03;
    for (let i = 0; i < n; i++) {
      exhaustPop(at, 0.15 + Math.random() * 0.2);
      at += 0.04 + Math.random() * 0.12;
    }
  }
  eng.thPrev = th;

  // The city bed ducks with ROAD SPEED, not revs: coasting at 120 km/h with
  // your foot off is just as loud inside the cabin as pulling, and ducking off
  // the throttle instead would pump the whole mix on every gear change.
  duckSpeed(v);
}

// Absolute m/s, the same two numbers for every vehicle — a bus at 90 km/h
// drowns out the street exactly as much as a BMW at 90 km/h does, because
// that is a fact about the street and not about the bus. Spelling them out in
// m/s is also what keeps them where they were: they used to be 0.2 and 0.5 of
// a speed01 that main.js had already divided by CAR.vmax, i.e. these numbers.
const DUCK_V0 = 0.2 * SPEED_REF;      // 7.6 m/s = 27 km/h — below this, none
const DUCK_SPAN = 0.5 * SPEED_REF;    // ...to full duck at 26.6 m/s = 96 km/h
function duckSpeed(v) {
  const dd = (v - DUCK_V0) / DUCK_SPAN;
  duckDrive = dd < 0 ? 0 : dd > 1 ? 1 : dd;
  duckUpdate();
}

// Tesla, per frame. Everything here is a function of ROAD SPEED (v), because
// a single reduction gear leaves nothing else to be a function of. th only
// controls the inverter tone — that one is proportional to TORQUE, which is
// why you hear it accelerating and not cruising.
function evSet(v, th, t, tau) {
  // v is m/s straight from the caller now. It used to be reconstructed as
  // s·SPEED_REF from a number main.js had already clamped at 1, so every tone
  // in here — whine, second stage, motor hum, inverter sidebands, the regen
  // threshold, the fade-in — froze at 137 km/h and the Tesla went eerily
  // constant for the 120 km/h it still had left. Nothing to reconstruct any
  // more, and no per-kind vmax needed either: an EV's tones are proportional
  // to road speed and to nothing else, which is the whole point of the model.
  let fw = EV.whineK * v;
  fw = fw < EV.whineMin ? EV.whineMin : fw > EV.whineMax ? EV.whineMax : fw;
  const n3 = EV.humK * v;                        // motor rate × 3 pole pairs
  // Regen: lifting off does NOT unload an EV, it loads it the other way — the
  // whine stays. That is the exact opposite of a combustion overrun, and it
  // is the cheapest way to make the car read as electric.
  let reg = (1 - th) * ((v - 5) / 10);
  reg = reg < 0 ? 0 : reg > 1 ? 1 : reg;
  // LOUDNESS stays on the reference speed, not on the Tesla's own 72 m/s, so
  // the mix below 137 km/h is bit-identical to before the unit change and only
  // the PITCHES carry on climbing above it. Riding vmax here would have made
  // the whine 3.8 dB quieter at every speed people actually drive at, to buy
  // headroom above 200 km/h where tyre roar owns the mix anyway.
  const lvl = 0.25 + 0.75 * Math.min(1, v / SPEED_REF);
  eng.whine.frequency.setTargetAtTime(fw, t, tau);
  eng.whine2.frequency.setTargetAtTime(fw * EV.stage2, t, tau);
  eng.humOsc.frequency.setTargetAtTime(n3 < 20 ? 20 : n3, t, tau);
  eng.pwmLfo.frequency.setTargetAtTime(n3 < 20 ? 20 : n3, t, tau);
  eng.wGain.gain.setTargetAtTime(0.05 * lvl * (1 + 0.20 * reg), t, tau);
  eng.w2Gain.gain.setTargetAtTime(0.022 * lvl * (1 + 0.08 * reg), t, tau);
  eng.humGain.gain.setTargetAtTime(0.05 * Math.min(1, v / 8), t, tau);
  eng.pwmDepth.gain.setTargetAtTime(0.025 * th, t, tau);
  // no idle: stopped, a Model 3 makes no sound at all
  eng.out.gain.setTargetAtTime(EV.vol * Math.min(1, v / EV.fadeV), t, tau);
  duckSpeed(v);
}

// ---- one rumble for ALL nearby traffic ----------------------------------
// Forty-five AI cars must never become forty-five voices: you cannot pick a
// single car out of city traffic by ear anyway, only sense how much of it is
// around you. So this is ONE looping noise source through ONE lowpass, whose
// level and cutoff track a scalar "how much traffic is close" — near traffic
// is both louder AND brighter (you hear tyre hiss on top of the rumble), far
// traffic is a formless low drone. Zero traffic leaves the graph silent but
// alive; building/tearing it down as cars come and go would click.
const HUM = {
  vol: 0.2,           // ceiling, reached stood in a jam — v7 raised it from
                      // 0.09, which was tuned so carefully into the bed that
                      // nobody could tell it was playing at all
  cutLo: 110, cutHi: 520,
  ref: 38,            // meters where one car counts as one "unit" of presence
  nK: 4.2,            // √n / nK — the 12th car adds far less than the 2nd;
                      // tuned so a busy junction (12 cars, 25 m) is the ceiling
                      // and ordinary driving (6 cars, 45 m) sits at half of it
  tau: 0.55,          // traffic density is a slow thing; glide slowly
  step: 0.01,         // per-frame caller: ignore changes smaller than this
};
let hum = null, humAt = -1;

// Sound power falls ~1/d and n incoherent sources sum as √n — this is that,
// clamped to 0..1. Pure scalar, no allocation, safe against 0 cars / 0 dist.
function humAmount(nCars, avgDist) {
  if (!(nCars > 0)) return 0;
  const d = avgDist > 6 ? avgDist : 6;        // a car "0 m away" is the player's own
  const a = (HUM.ref / d) * (Math.sqrt(nCars) / HUM.nK);
  return a > 1 ? 1 : a;
}

export function nearbyTrafficHum(nCars, avgDist) {
  const a = humAmount(nCars, avgDist);
  if (!hum) {
    if (a < 0.004 || !ctx || ctx.state !== 'running') return;   // silence needs no graph
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(); src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = HUM.cutLo; lp.Q.value = 0.9;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(lp); lp.connect(gain); gain.connect(master);
    src.start(ctx.currentTime, Math.random());
    hum = { src, lp, gain };
  }
  if (Math.abs(a - humAt) < HUM.step) return;
  humAt = a;
  const t = ctx.currentTime;
  // a^1.5: a couple of distant cars stay genuinely subliminal, the top of the
  // range still gets there — a linear map makes light traffic too present
  hum.gain.gain.setTargetAtTime(HUM.vol * a * Math.sqrt(a), t, HUM.tau);
  hum.lp.frequency.setTargetAtTime(HUM.cutLo + (HUM.cutHi - HUM.cutLo) * a, t, HUM.tau);
}

// ---- procedural helicopter rotor ----------------------------------------
// What makes a helicopter is not a tone, it's a RATE: each blade passing the
// tail boom slaps the air, and the ear counts those slaps. So the voice is a
// gate — bandpassed noise (the air) plus a low oscillator (the mass of the
// disc) multiplied by an LFO running at the blade-slap rate, 7 Hz on a lazy
// idle up to 22 Hz at flight revs. Two details do the heavy lifting:
//   · the LFO is a PULSE-shaped periodic wave, not a sine. A sine gives a
//     wobble; a narrow peak over a long trough gives a THUMP, which is what
//     a rotor actually sounds like.
//   · the body oscillator sits at an exact harmonic (6×) of the slap rate, so
//     the tone and the thumps stay phase-locked as the machine spools up
//     instead of drifting into a beat-frequency warble.
// The lowpass opens with SPEED, not revs: hovering, you hear a muffled chop;
// running at 200 km/h the blade slap turns hard and bright as the disc bites.
// Everything moves on setTargetAtTime, so a rotor going from 0 to full and
// back can never click, and heliSet() allocates nothing.
const HELI = {
  rateLo: 7, rateHi: 22,      // blade-slap Hz across rotor01 (contract)
  oscMult: 6,                 // body tone = 6× slap → 42 Hz idle, 132 Hz flat out
  whineMult: 11,              // turbine whine above that: 462 Hz → 1452 Hz
  bandF: 480, bandQ: 0.6,     // where the air noise lives before the main lowpass
  cutBase: 340, cutRotor: 420,// lowpass floor: 340 Hz stopped → 760 Hz at full revs
  cutSpeedK: 4.5,             // ...× up to 4.5 as speed01 → 1 (≈ 3.4 kHz)
  chopBase: 0.5, chopDepth: 0.5,   // gate: base ± depth·wave, so peaks reach 1
  depthIdle: 0.55,            // slap depth at rest — softer, less "attack"
  oscLevel: 0.85,             // the disc's mass — raised in v7, this is the THUMP
  whineLevel: 0.05,
  vol: 0.62,                  // full-rotor HOVER level. v7 tripled it: at flight
                              // revs the rotor is the loudest continuous element
                              // in the mix, ~2× the (unducked) city bed
  speedLift: 0.75,            // ...and speed GROWS it, ×1.75 at vmax. The old
                              // additive +0.035 was why the machine "sounded
                              // like a drone" and then vanished in flight — the
                              // brighter lowpass spread the same energy thinner
  xfade: 1.6,                 // s of heli_start sample tail the loop swells over
  tau: 0.09,                  // ~250 ms settle: a rotor has inertia, so should its sound
};
// Cosine partials, all in phase → a tall narrow peak and a long shallow
// trough (WebAudio normalizes the result to ±1 for us). Allocated once at
// module load, copied by createPeriodicWave, never touched per frame.
const CHOP_REAL = new Float32Array([0, 1, 0.82, 0.58, 0.34, 0.16]);
const CHOP_IMAG = new Float32Array(CHOP_REAL.length);
let heli = null;
let heliXfEnd = 0;   // ctx time the heli_start sample runs out (0 = no sample)

export function heliStart() {
  if (!ctx || ctx.state !== 'running' || heli) return;
  const t = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(); noise.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass'; band.frequency.value = HELI.bandF; band.Q.value = HELI.bandQ;
  const osc = ctx.createOscillator();             // the disc's mass
  osc.type = 'triangle'; osc.frequency.value = HELI.rateLo * HELI.oscMult;
  const oscGain = ctx.createGain(); oscGain.gain.value = HELI.oscLevel;
  const whine = ctx.createOscillator();           // turbine — NOT gated: the
  whine.type = 'sawtooth';                        // engine screams continuously,
  whine.frequency.value = HELI.rateLo * HELI.oscMult * HELI.whineMult;  // only
  const whineGain = ctx.createGain();             // the blades chop the air
  whineGain.gain.value = 0;                       // (fades in with revs)
  const lfo = ctx.createOscillator();
  lfo.setPeriodicWave(ctx.createPeriodicWave(CHOP_REAL, CHOP_IMAG));
  lfo.frequency.value = HELI.rateLo;
  const lfoDepth = ctx.createGain();
  lfoDepth.gain.value = HELI.chopDepth * HELI.depthIdle;
  const chop = ctx.createGain();
  chop.gain.value = HELI.chopBase;   // LFO output ADDS to this intrinsic value
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = HELI.cutBase; lp.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.value = 0;               // born silent; heliSet() drives it up
  noise.connect(band); band.connect(chop);
  osc.connect(oscGain); oscGain.connect(chop);
  lfo.connect(lfoDepth); lfoDepth.connect(chop.gain);
  chop.connect(lp);
  whineGain.connect(lp); whine.connect(whineGain);
  lp.connect(gain); gain.connect(master);
  noise.start(t, Math.random()); osc.start(t); whine.start(t); lfo.start(t);
  heli = { noise, band, osc, oscGain, whine, whineGain, lfo, lfoDepth, chop, lp, gain };
}

export function heliStop() {
  if (!heli) return;
  const h = heli;
  heli = null;                       // heliSet() goes inert immediately
  heliXfEnd = 0;                     // a fresh start gets a fresh crossfade
  duckHeli = 0; duckUpdate();        // the sky quietens, the street returns
  const t = ctx.currentTime;
  h.gain.gain.cancelScheduledValues(t);
  h.gain.gain.setTargetAtTime(0, t, 0.08);   // spool-down is a fade, not a cut
  setTimeout(() => {
    try { h.noise.stop(); h.osc.stop(); h.whine.stop(); h.lfo.stop(); } catch {}
    h.noise.disconnect(); h.band.disconnect(); h.osc.disconnect(); h.oscGain.disconnect();
    h.whine.disconnect(); h.whineGain.disconnect(); h.lfo.disconnect(); h.lfoDepth.disconnect();
    h.chop.disconnect(); h.lp.disconnect(); h.gain.disconnect();
  }, 500);
}

// Per frame while a helicopter is running. rotor01 = spin-up fraction (0 =
// stopped, 1 = flight revs), speed01 = |velocity|/vmax. Scalar math + param
// writes only, zero allocations.
export function heliSet(rotor01, speed01) {
  if (!heli) return;
  const r = rotor01 < 0 ? 0 : rotor01 > 1 ? 1 : rotor01;
  const sp = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;
  const t = ctx.currentTime, tau = HELI.tau;
  const rate = HELI.rateLo + (HELI.rateHi - HELI.rateLo) * r;
  const fBody = rate * HELI.oscMult;
  heli.lfo.frequency.setTargetAtTime(rate, t, tau);
  heli.osc.frequency.setTargetAtTime(fBody, t, tau);
  heli.whine.frequency.setTargetAtTime(fBody * HELI.whineMult, t, tau);
  heli.whineGain.gain.setTargetAtTime(HELI.whineLevel * r * r, t, tau);  // late, quiet
  // slap deepens as the blades load up — a barely-turning rotor whooshes,
  // a working one cracks
  heli.lfoDepth.gain.setTargetAtTime(
    HELI.chopDepth * (HELI.depthIdle + (1 - HELI.depthIdle) * r), t, tau);
  heli.lp.frequency.setTargetAtTime(
    (HELI.cutBase + HELI.cutRotor * r) * Math.pow(HELI.cutSpeedK, sp), t, tau);
  // pow(r, 0.7): audible early in the spin-up (you hear it before you can fly
  // it), then the last stretch adds little — matches how lift feels. Speed
  // MULTIPLIES the level: a flyby has to get louder, not thinner. And while
  // the heli_start sample is still playing (main fires sfx('heli_start') and
  // heliStart() together), the loop hides under it at 18 % and swells across
  // the sample's last `xfade` seconds — a crossfade, not two rotors fighting.
  let xf = 1;
  if (heliXfEnd > t) {
    const remain = heliXfEnd - t;
    xf = remain > HELI.xfade ? 0.18 : 0.18 + 0.82 * (1 - remain / HELI.xfade);
  }
  heli.gain.gain.setTargetAtTime(
    HELI.vol * Math.pow(r, 0.7) * (1 + HELI.speedLift * sp) * xf, t, tau);
  // rotor noise beats the street flat once it's really turning
  duckHeli = r;
  duckUpdate();
}

// ---- procedural train: wheels, rail joints, traction --------------------
// Riding a train is three sounds and no more, and the reason none of them is
// a sample is that all three are RATE, not timbre:
//   · the ROAR — broadband wheel-on-rail noise. One looping noise source
//     through a lowpass that OPENS with speed: standing still you hear only
//     the bottom of it, at 144 km/h the hiss of the railhead comes right up
//     into the cabin. Level and brightness move together because that is what
//     "faster" sounds like.
//   · the CLATTER — the joints. A second noise voice, bandpassed up where the
//     crack of a rail joint lives, GATED by a pulse-shaped LFO whose frequency
//     is the whole trick: joints pass at speed/spacing, so the rate literally
//     is the speedometer. The LFO wave is ten cosine partials in phase — a
//     tall narrow peak over a long trough, i.e. a click and then nothing,
//     where a sine would give a wobble. (Same construction as the rotor's
//     blade slap, tightened.)
//   · the HUM — a low triangle at 24→62 Hz for the traction motors, with a
//     quiet third harmonic so it has an edge rather than being a test tone.
// Every parameter moves on setTargetAtTime, so pulling out of a station and
// braking back into one is one continuous glide with nothing to click on.
const TRAIN = {
  roarLo: 210, roarHi: 1700,      // wheel-roar lowpass, stopped → flat out
  roarQ: 0.7,
  clackLo: 0.6, clackHi: 8.5,     // rail joints per second across the range
  clackF: 1500, clackQ: 2.2,      // where a joint crack lives
  clackBase: 0.26, clackDepth: 0.3,   // gate floor + peak (never negative)
  humLo: 24, humHi: 62,           // traction fundamental
  humLevel: 0.30, third: 0.10,    // …and its third harmonic, well under
  vol: 0.30, volFloor: 0.30,      // overall level: floor + the rest from speed
  tau: 0.12,                      // ~350 ms settle — a train is not a synth
  duck: 0.85,                     // how hard the ride flattens the city bed
};
// ten in-phase cosine partials → the narrow peak that reads as a CLICK
const CLACK_REAL = new Float32Array([0, 1, 0.96, 0.9, 0.81, 0.7, 0.58, 0.45, 0.32, 0.2, 0.1]);
const CLACK_IMAG = new Float32Array(CLACK_REAL.length);
let train = null;

export function trainStart() {
  if (!ctx || ctx.state !== 'running' || train) return;
  const t = ctx.currentTime;
  // roar
  const roar = ctx.createBufferSource();
  roar.buffer = noiseBuffer(); roar.loop = true;
  const roarLP = ctx.createBiquadFilter();
  roarLP.type = 'lowpass'; roarLP.frequency.value = TRAIN.roarLo; roarLP.Q.value = TRAIN.roarQ;
  const roarGain = ctx.createGain(); roarGain.gain.value = 0.1;
  // clatter
  const clack = ctx.createBufferSource();
  clack.buffer = noiseBuffer(); clack.loop = true;
  const clackBP = ctx.createBiquadFilter();
  clackBP.type = 'bandpass'; clackBP.frequency.value = TRAIN.clackF; clackBP.Q.value = TRAIN.clackQ;
  const gate = ctx.createGain();
  gate.gain.value = TRAIN.clackBase;      // the LFO ADDS to this intrinsic value
  const lfo = ctx.createOscillator();
  lfo.setPeriodicWave(ctx.createPeriodicWave(CLACK_REAL, CLACK_IMAG));
  lfo.frequency.value = TRAIN.clackLo;
  const lfoDepth = ctx.createGain(); lfoDepth.gain.value = TRAIN.clackDepth;
  const clackGain = ctx.createGain(); clackGain.gain.value = 0;
  // traction hum
  const hum = ctx.createOscillator();
  hum.type = 'triangle'; hum.frequency.value = TRAIN.humLo;
  const hum3 = ctx.createOscillator();
  hum3.type = 'sawtooth'; hum3.frequency.value = TRAIN.humLo * 3;
  const hum3Gain = ctx.createGain(); hum3Gain.gain.value = TRAIN.third;
  const humGain = ctx.createGain(); humGain.gain.value = TRAIN.humLevel;
  const gain = ctx.createGain();
  gain.gain.value = 0;                    // born silent — no start pop
  roar.connect(roarLP); roarLP.connect(roarGain); roarGain.connect(gain);
  clack.connect(clackBP); clackBP.connect(gate);
  lfo.connect(lfoDepth); lfoDepth.connect(gate.gain);
  gate.connect(clackGain); clackGain.connect(gain);
  hum.connect(humGain); hum3.connect(hum3Gain); hum3Gain.connect(humGain);
  humGain.connect(gain);
  gain.connect(master);
  roar.start(t, Math.random()); clack.start(t, Math.random());
  lfo.start(t); hum.start(t); hum3.start(t);
  gain.gain.setTargetAtTime(TRAIN.vol * TRAIN.volFloor, t, 0.25);
  train = { roar, roarLP, roarGain, clack, clackBP, gate, lfo, lfoDepth,
    clackGain, hum, hum3, hum3Gain, humGain, gain };
}

export function trainStop() {
  if (!train) return;
  const tr = train;
  train = null;                     // trainSet() goes inert immediately
  duckTrain = 0; duckUpdate();      // off the train → the street comes back
  const t = ctx.currentTime;
  tr.gain.gain.cancelScheduledValues(t);
  tr.gain.gain.setTargetAtTime(0, t, 0.12);
  setTimeout(() => {
    try { tr.roar.stop(); tr.clack.stop(); tr.lfo.stop(); tr.hum.stop(); tr.hum3.stop(); } catch {}
    tr.roar.disconnect(); tr.roarLP.disconnect(); tr.roarGain.disconnect();
    tr.clack.disconnect(); tr.clackBP.disconnect(); tr.gate.disconnect();
    tr.lfo.disconnect(); tr.lfoDepth.disconnect(); tr.clackGain.disconnect();
    tr.hum.disconnect(); tr.hum3.disconnect(); tr.hum3Gain.disconnect();
    tr.humGain.disconnect(); tr.gain.disconnect();
  }, 700);
}

// Per frame while the player is on a train. speed01 = |speed|/vmax. Scalar
// math and AudioParam writes only, zero allocations.
export function trainSet(speed01) {
  if (!train) return;
  const s = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;
  const t = ctx.currentTime, tau = TRAIN.tau;
  // exponential cutoff travel — a linear Hz ramp spends its whole audible
  // movement in the last tenth of the slider
  train.roarLP.frequency.setTargetAtTime(
    TRAIN.roarLo * Math.pow(TRAIN.roarHi / TRAIN.roarLo, s), t, tau);
  train.roarGain.gain.setTargetAtTime(0.12 + 0.85 * s, t, tau);
  // the joints ARE the speedometer: rate scales straight off road speed, and
  // the level with it, so a train drifting into a platform goes tick… tick…
  train.lfo.frequency.setTargetAtTime(
    TRAIN.clackLo + (TRAIN.clackHi - TRAIN.clackLo) * s, t, tau);
  train.clackGain.gain.setTargetAtTime(0.75 * s * s, t, tau);   // late, then hard
  train.hum.frequency.setTargetAtTime(TRAIN.humLo + (TRAIN.humHi - TRAIN.humLo) * s, t, tau);
  train.hum3.frequency.setTargetAtTime(
    (TRAIN.humLo + (TRAIN.humHi - TRAIN.humLo) * s) * 3, t, tau);
  train.gain.gain.setTargetAtTime(
    TRAIN.vol * (TRAIN.volFloor + (1 - TRAIN.volFloor) * s), t, tau);
  // inside a moving train the street is simply gone
  duckTrain = TRAIN.duck * (0.35 + 0.65 * s);
  duckUpdate();
}

// ---- ordnance ------------------------------------------------------------
// Both cues are synthesized rather than sampled for the same reason the engine
// is: an explosion has to be a DIFFERENT explosion every time or the tenth
// rocket sounds like a loop, and the only way to get that from a sample is to
// ship ten samples. Two voices layered do the whole job:
//
//   · the CRACK — filtered noise with a fast attack and an exponential tail,
//     its lowpass sweeping down from a few kHz to a couple hundred Hz. That
//     sweep IS the sound of an explosion moving away from you.
//   · the THUMP — a sine dropping from ~90 Hz to ~28 Hz over a quarter second.
//     Below the crack, felt more than heard, and it is what makes a small
//     speaker still read the hit as big.
//
// A launch is the same graph with the sweep running the other way: bandpassed
// noise rising as the motor lights, over in a third of a second.

export function missileLaunch(vol = 1) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.playbackRate.value = 1.4;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.Q.value = 0.7;
  bp.frequency.setValueAtTime(420, t);
  bp.frequency.exponentialRampToValueAtTime(2600, t + 0.26);   // the motor lights
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.42 * vol, t + 0.035);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.5, 0.5);
  src.stop(t + 0.45);
  src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); };
}

// k = 0..1 loudness (distance is the caller's business — the blast is always
// the player's own rocket in v5, so k is really "how big was it")
export function explosion(k = 1) {
  if (!ctx || ctx.state !== 'running') return;
  const t = ctx.currentTime;
  const v = Math.max(0.05, Math.min(1, k));
  // crack
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.playbackRate.value = 0.65 + Math.random() * 0.3;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(3800 + Math.random() * 1800, t);
  lp.frequency.exponentialRampToValueAtTime(180, t + 1.5);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.75 * v, t + 0.012);    // no attack at all
  g.gain.exponentialRampToValueAtTime(0.0001, t + 1.7);
  src.connect(lp); lp.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.5, 1.9);
  src.stop(t + 1.8);
  src.onended = () => { src.disconnect(); lp.disconnect(); g.disconnect(); };
  // thump
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(95, t);
  osc.frequency.exponentialRampToValueAtTime(26, t + 0.34);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(0.62 * v, t + 0.02);
  og.gain.exponentialRampToValueAtTime(0.0001, t + 0.75);
  osc.connect(og); og.connect(master);
  osc.start(t); osc.stop(t + 0.8);
  osc.onended = () => { osc.disconnect(); og.disconnect(); };
  // …and the rubble that follows it down, a second behind
  rubble(t + 0.35 + Math.random() * 0.3, v * 0.55);
}

// The tail of a collapse: a long, dry, mid-heavy noise wash. Deliberately
// UNfiltered at the top — falling masonry is all clatter, no bottom end.
function rubble(t, v) {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.playbackRate.value = 0.4;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.5;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.3 * v, t + 0.25);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 2.4);
  src.connect(bp); bp.connect(g); g.connect(master);
  src.start(t, Math.random() * 0.4, 2.6);
  src.stop(t + 2.5);
  src.onended = () => { src.disconnect(); bp.disconnect(); g.disconnect(); };
}

// ---- tyre / road noise ----------------------------------------------------
// The one loop a driving game cannot go without: broadband tyre hiss that
// rises and brightens with speed, plus a low gravel rumble that fades in as
// the wheels leave the tarmac. One noise source, two filter paths, all moves
// on setTargetAtTime — silent at rest, self-starting on the first call.
// Pulled down and darkened once roadWindSet() existed: this layer used to be
// the ONLY thing that got louder with speed, so it had to carry the wind too,
// and a 2600 Hz noise sweep carrying that job is what the wind ended up sounding
// like. With real air on top of it, this can go back to being rubber.
const TIRE = {
  vol: 0.13,            // ceiling at full speed on asphalt
  hissLo: 380, hissHi: 1800,   // bandpass sweep across speed01
  gravel: 0.22,         // extra rumble ceiling when fully offroad
  gravelF: 140,
  tau: 0.12,
};
let tire = null, tireAt = -1, tireOff = -1;

export function tireSet(speed01, offroad01 = 0) {
  if (!ctx || ctx.state !== 'running') return;
  const s = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;
  const o = offroad01 < 0 ? 0 : offroad01 > 1 ? 1 : offroad01;
  if (!tire) {
    if (s < 0.02) return;                        // parked: build nothing
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(); src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = TIRE.hissLo; bp.Q.value = 0.5;
    const hg = ctx.createGain(); hg.gain.value = 0;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = TIRE.gravelF; lp.Q.value = 0.8;
    const gg = ctx.createGain(); gg.gain.value = 0;
    src.connect(bp); bp.connect(hg); hg.connect(master);
    src.connect(lp); lp.connect(gg); gg.connect(master);
    src.start(ctx.currentTime, Math.random());
    tire = { src, bp, hg, lp, gg };
  }
  if (Math.abs(s - tireAt) < 0.01 && Math.abs(o - tireOff) < 0.02) return;
  tireAt = s; tireOff = o;
  const t = ctx.currentTime;
  // hiss grows ~s^1.6 (quiet in town, loud at speed) and brightens with it
  tire.hg.gain.setTargetAtTime(TIRE.vol * Math.pow(s, 1.6), t, TIRE.tau);
  tire.bp.frequency.setTargetAtTime(TIRE.hissLo + (TIRE.hissHi - TIRE.hissLo) * s, t, TIRE.tau);
  // gravel rumble scales with BOTH how offroad and how fast
  tire.gg.gain.setTargetAtTime(TIRE.gravel * o * Math.min(1, s * 2.2), t, TIRE.tau);
}

// ---- the wind at the window ------------------------------------------------
// What made the old "wind at speed" sound like a desk fan was that it WAS one:
// tireSet's bandpassed noise is perfectly steady, and steady broadband noise is
// the definition of a fan. Real wind is never steady — it swells, drops, and
// thuds against the microphone. So this layer is a recording (car_wind.mp3: a
// mic left out in a gale) rather than a filter, and on top of the recording sit
// two slow oscillators that keep pushing the level around, because a nine
// second loop played for ten minutes must not settle into a rhythm the ear can
// learn.
//
// Deliberately NOT the jet's slipstream: that one is gated from 90 m/s and is
// the roar of a canopy at Mach 1. A car is a different range and a different
// sound, so it gets its own instance rather than a rescaled one.
const RWIND = {
  from: 13,          // m/s (47 km/h) — under this the engine owns the mix
  full: 62,          // m/s (223 km/h) — everything the car has
  vol: 0.52,
  cutLo: 460, cutHi: 5000,
  gust: 0.3,         // ± this fraction of level, wandering
  tau: 0.18,
};
let rwind = null, rwindPending = false, rwindLvl = 0;

function rwindBuild() {
  if (!ctx || ctx.state !== 'running' || rwind || rwindPending) return;
  rwindPending = true;
  loadBuffer('car_wind').then((buf) => {
    rwindPending = false;
    if (rwind || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    // No sample (no API key at build time, or a 404): fall back to noise, but
    // keep the gusting — a fan with weather in it still beats a fan.
    src.buffer = buf || noiseBuffer();
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = RWIND.cutLo; lp.Q.value = 0.5;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 90; hp.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    // The gusts: two incommensurate LFOs summed into the gain's own parameter.
    // An AudioParam adds its connected inputs to its scheduled value, so the
    // speed ramp below and this wander compose without fighting each other.
    const depth = ctx.createGain(); depth.gain.value = 0;
    for (const [f, a] of [[0.13, 0.62], [0.31, 0.38]]) {
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      const og = ctx.createGain(); og.gain.value = a;
      o.connect(og); og.connect(depth);
      o.start(t + Math.random() * 3);       // out of phase with each other
    }
    depth.connect(gain.gain);
    src.connect(hp); hp.connect(lp); lp.connect(gain); gain.connect(master);
    src.start(t, Math.random() * src.buffer.duration);
    rwind = { src, lp, gain, depth };
    if (rwindLvl > 0) roadWindSet(-1);      // catch up to the speed we are at
  });
}

/**
 * speed in m/s. Self-starting like tireSet: the first call above the gate
 * builds the graph, and there is nothing to tear down when the car stops —
 * the level simply falls to zero. Pass −1 to re-apply the last level.
 */
export function roadWindSet(speed) {
  if (!ctx || ctx.state !== 'running') return;
  if (speed >= 0) {
    const v = Math.abs(speed);
    rwindLvl = v <= RWIND.from ? 0
      : Math.min(1, (v - RWIND.from) / (RWIND.full - RWIND.from));
  }
  if (!rwind) { if (rwindLvl > 0) rwindBuild(); return; }
  const t = ctx.currentTime;
  // squared, same reasoning as the jet: the bottom of the range stays a
  // whisper so the wind ARRIVING is an event rather than a constant
  const lvl = RWIND.vol * rwindLvl * rwindLvl;
  rwind.gain.gain.setTargetAtTime(lvl, t, RWIND.tau);
  rwind.depth.gain.setTargetAtTime(lvl * RWIND.gust, t, RWIND.tau);
  rwind.lp.frequency.setTargetAtTime(
    RWIND.cutLo + (RWIND.cutHi - RWIND.cutLo) * rwindLvl, t, RWIND.tau);
}

/** Getting out of the car: silence it now rather than waiting for the ramp. */
export function roadWindStop() {
  rwindLvl = 0;
  if (!rwind) return;
  const t = ctx.currentTime;
  rwind.gain.gain.cancelScheduledValues(t);
  rwind.gain.gain.setTargetAtTime(0, t, 0.12);
  rwind.depth.gain.setTargetAtTime(0, t, 0.12);
}

// ---- crash -----------------------------------------------------------------
// A collision is three sounds stacked: a metallic CRUNCH (noise burst whose
// lowpass slams shut), a body THUMP (short low sine), and — for the big ones —
// the debris_crash sample of parts hitting the road. k is 0..1 severity.
let _crashCd = 0;
export function crash(k = 0.5) {
  if (!ctx || ctx.state !== 'running') return;
  const now = ctx.currentTime;
  if (now < _crashCd) return;                    // two crunches a frame is one crash
  _crashCd = now + 0.12;
  const v = k < 0.05 ? 0.05 : k > 1 ? 1 : k;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer();
  src.playbackRate.value = 0.9 + Math.random() * 0.4;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 1.4;
  lp.frequency.setValueAtTime(2600 + v * 2200, now);
  lp.frequency.exponentialRampToValueAtTime(240, now + 0.28 + v * 0.2);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(0.5 * v + 0.1, now + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, now + 0.4 + v * 0.3);
  src.connect(lp); lp.connect(g); g.connect(master);
  src.start(now, Math.random() * 0.5, 0.8);
  src.stop(now + 0.8);
  src.onended = () => { src.disconnect(); lp.disconnect(); g.disconnect(); };
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, now);
  osc.frequency.exponentialRampToValueAtTime(38, now + 0.16);
  const og = ctx.createGain();
  og.gain.setValueAtTime(0.0001, now);
  og.gain.exponentialRampToValueAtTime(0.45 * v, now + 0.012);
  og.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
  osc.connect(og); og.connect(master);
  osc.start(now); osc.stop(now + 0.35);
  osc.onended = () => { osc.disconnect(); og.disconnect(); };
  if (v > 0.55) sfx('debris_crash', v * 0.8);    // parts on the tarmac
}

// ---- procedural jet engine (Saab JAS 39 Gripen, js/aircraft.js) ----------
// A turbofan is three sounds stacked, and getting the BALANCE between them
// right with power is the whole job — the same engine is a polite whistle on
// the apron and a physical assault at full reheat:
//
//   · the FAN WHINE. At idle this is all you hear: a hard, buzzy tone at the
//     fan's blade-pass frequency, up around a kilohertz and climbing with N1.
//     A sawtooth through a high-Q bandpass gives the metallic edge that a pure
//     tone cannot — a jet whistle is rich, not sinusoidal.
//   · the CORE ROAR. Broadband noise through a lowpass that opens with both
//     power and airspeed. This is what takes over past ~60 % and it is what
//     makes a take-off run feel like weight rather than pitch.
//   · the AFTERBURNER. Not "louder" — DIFFERENT: raw combustion instability,
//     which is noise shaped down to a rumble and then amplitude-modulated by a
//     slow, deliberately non-musical LFO. Lighting it should feel like the
//     floor dropping out, so it comes in on its own path with its own lowpass
//     and its own level, under everything else.
//
// Airspeed brightens the whole thing (you are dragging the mix through the air
// with you) and lifts the level, for the same reason the rotor does. As with
// every other voice here, all movement is setTargetAtTime, so nothing clicks
// and jetSet() allocates nothing.
const JET = {
  fanLo: 620, fanHi: 3100,     // blade-pass Hz across throttle — idle to max dry
  fanQ: 7.5,                   // high Q: a whistle with a metallic edge
  fanLevel: 0.30,
  roarBand: 900, roarQ: 0.5,   // where the core noise sits before the lowpass
  cutBase: 300, cutThr: 2600,  // lowpass: 300 Hz at idle → ~2.9 kHz at full dry
  cutSpeedK: 2.6,              // ...× as speed01 → 1
  roarLevel: 0.85,
  abCut: 190,                  // the burner lives entirely below this
  abLevel: 1.5,                // and is the loudest thing in the game when lit
  abRumbleHz: 11,              // combustion roughness — felt, not heard as pitch
  abRumbleDepth: 0.42,
  vol: 0.5,                    // master, before throttle shapes it
  speedLift: 0.9,              // ×1.9 at V_MAX: a fast jet is a loud jet
  idleFloor: 0.12,             // an engine at idle is never silent
  tau: 0.10,                   // spool lag — a turbine has inertia
};
let jet = null;

export function jetStart() {
  if (!ctx || ctx.state !== 'running' || jet) return;
  const t = ctx.currentTime;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(); noise.loop = true;
  const roarBand = ctx.createBiquadFilter();
  roarBand.type = 'bandpass';
  roarBand.frequency.value = JET.roarBand; roarBand.Q.value = JET.roarQ;
  const roarGain = ctx.createGain(); roarGain.gain.value = JET.roarLevel;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.frequency.value = JET.cutBase;

  const fan = ctx.createOscillator();
  fan.type = 'sawtooth'; fan.frequency.value = JET.fanLo;
  const fanBand = ctx.createBiquadFilter();
  fanBand.type = 'bandpass';
  fanBand.frequency.value = JET.fanLo; fanBand.Q.value = JET.fanQ;
  const fanGain = ctx.createGain(); fanGain.gain.value = JET.fanLevel;

  // the burner: its own noise tap, its own lowpass, gated by a slow rumble
  const abNoise = ctx.createBufferSource();
  abNoise.buffer = noiseBuffer(); abNoise.loop = true;
  const abLp = ctx.createBiquadFilter();
  abLp.type = 'lowpass'; abLp.frequency.value = JET.abCut;
  const abRumble = ctx.createOscillator();
  abRumble.type = 'triangle'; abRumble.frequency.value = JET.abRumbleHz;
  const abDepth = ctx.createGain(); abDepth.gain.value = JET.abRumbleDepth;
  const abMod = ctx.createGain(); abMod.gain.value = 1 - JET.abRumbleDepth;
  const abGain = ctx.createGain(); abGain.gain.value = 0;   // lit by jetSet only

  const gain = ctx.createGain(); gain.gain.value = 0;       // born silent

  noise.connect(roarBand); roarBand.connect(roarGain); roarGain.connect(lp);
  fan.connect(fanBand); fanBand.connect(fanGain); fanGain.connect(lp);
  lp.connect(gain);
  abNoise.connect(abLp); abLp.connect(abMod);
  abRumble.connect(abDepth); abDepth.connect(abMod.gain);   // AM around the base
  abMod.connect(abGain); abGain.connect(gain);
  gain.connect(master);

  noise.start(t); fan.start(t); abNoise.start(t); abRumble.start(t);
  jet = { noise, roarBand, roarGain, lp, fan, fanBand, fanGain,
    abNoise, abLp, abRumble, abDepth, abMod, abGain, gain };
}

export function jetStop() {
  if (!jet) return;
  const j = jet;
  jet = null;                         // jetSet() goes inert immediately
  duckHeli = 0; duckUpdate();         // the street comes back
  const t = ctx.currentTime;
  j.gain.gain.cancelScheduledValues(t);
  j.gain.gain.setTargetAtTime(0, t, 0.12);   // a turbine winds DOWN
  setTimeout(() => {
    try { j.noise.stop(); j.fan.stop(); j.abNoise.stop(); j.abRumble.stop(); } catch {}
    for (const n of [j.noise, j.roarBand, j.roarGain, j.lp, j.fan, j.fanBand,
      j.fanGain, j.abNoise, j.abLp, j.abRumble, j.abDepth, j.abMod, j.abGain, j.gain])
      n.disconnect();
  }, 900);
}

/**
 * throttle01 0..1 — the lever, which sets pitch and level
 * speed01    0..1 — airspeed over V_MAX, which brightens and lifts
 * reheat     bool — is the burner lit
 */
export function jetSet(throttle01, speed01, reheat) {
  if (!jet) return;
  const th = throttle01 < 0 ? 0 : throttle01 > 1 ? 1 : throttle01;
  const sp = speed01 < 0 ? 0 : speed01 > 1 ? 1 : speed01;
  const t = ctx.currentTime, tau = JET.tau;

  const fanHz = JET.fanLo + (JET.fanHi - JET.fanLo) * th;
  jet.fan.frequency.setTargetAtTime(fanHz, t, tau);
  jet.fanBand.frequency.setTargetAtTime(fanHz, t, tau);
  // the whine is the WHOLE sound at idle and gets buried by the roar at power
  jet.fanGain.gain.setTargetAtTime(JET.fanLevel * (1 - 0.55 * th), t, tau);
  jet.lp.frequency.setTargetAtTime(
    (JET.cutBase + JET.cutThr * th) * Math.pow(JET.cutSpeedK, sp), t, tau);
  // reheat is a step change in kind, so it gets a fast attack and a slow decay:
  // lighting it should be an event, cutting it should be a sag
  jet.abGain.gain.setTargetAtTime(reheat ? JET.abLevel : 0, t, reheat ? 0.05 : 0.35);
  // pow(th, 0.6): the first half of the lever is most of the audible change,
  // which is how a turbine actually behaves — and the idle floor means the
  // machine is never mute while you sit on the apron deciding.
  const lvl = JET.idleFloor + (1 - JET.idleFloor) * Math.pow(th, 0.6);
  jet.gain.gain.setTargetAtTime(JET.vol * lvl * (1 + JET.speedLift * sp), t, tau);
  // a jet flattens the street the way a rotor does, only more so
  duckHeli = Math.max(0.35, th);
  duckUpdate();
}

// ---- slipstream: the wind, once you are going fast enough to hear it -------
// The engine is behind you; the WIND is the sound of the airframe pushing a
// hole through the sky, and it is what actually tells a pilot how fast they
// are going. Kept as a looping render rather than synthesis because broadband
// rush with buffeting in it is one thing samples do better than filters.
//
// It is speed-gated, not throttle-gated: chopping the power at Mach 1 leaves
// you just as fast and just as loud for a while, which is exactly right. The
// lowpass opens with speed too, so the character travels from a distant hiss
// to a hard roar rather than simply getting louder.
const WIND = {
  from: 90,          // m/s (324 km/h) where it first becomes audible
  full: 620,         // m/s where it is everything
  vol: 0.75,
  cutLo: 700, cutHi: 6000,
  tau: 0.25,         // slow: the slipstream has no transients
};
let wind = null, windWant = false, windPending = false, windLvl = 0;

export function windStart() { windWant = true; windBuild(); }

function windBuild() {
  if (!ctx || ctx.state !== 'running' || wind || windPending || !windWant) return;
  windPending = true;
  loadBuffer('jet_wind').then((buf) => {
    windPending = false;
    if (!buf || !windWant || wind || !ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = WIND.cutLo; lp.Q.value = 0.4;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(lp); lp.connect(gain); gain.connect(master);
    src.start(t, Math.random() * buf.duration);
    wind = { src, lp, gain };
  });
}

export function windStop() {
  windWant = false;
  windLvl = 0;
  if (!wind) return;
  const w = wind;
  wind = null;
  const t = ctx.currentTime;
  w.gain.gain.cancelScheduledValues(t);
  w.gain.gain.setTargetAtTime(0, t, 0.2);
  setTimeout(() => {
    try { w.src.stop(); } catch {}
    w.src.disconnect(); w.lp.disconnect(); w.gain.disconnect();
  }, 1200);
}

/**
 * The wing tearing at the air in a hard turn. Rides the slipstream's own voice
 * rather than a second source: a loaded wing does not add a NEW sound, it makes
 * the existing rush louder and harder-edged, which is exactly what a gain lift
 * plus an open filter is. `g` is 0..1 of wing load.
 */
export function windLoad(g) {
  windG = g < 0 ? 0 : g > 1 ? 1 : g;
}
let windG = 0;

/** speed in m/s — the only thing the slipstream cares about. */
export function windSet(speed) {
  windLvl = speed <= WIND.from ? 0
    : Math.min(1, (speed - WIND.from) / (WIND.full - WIND.from));
  if (!wind) return;
  const t = ctx.currentTime;
  // squared: the first third of the range stays a whisper, so the wind arriving
  // is something you notice rather than something that was always there
  // a loaded wing is worth up to +60 % level and a much brighter filter — the
  // buffeting you hear in a hard break turn
  const load = 1 + 0.6 * windG;
  wind.gain.gain.setTargetAtTime(WIND.vol * windLvl * windLvl * load, t, 0.12);
  wind.lp.frequency.setTargetAtTime(
    (WIND.cutLo + (WIND.cutHi - WIND.cutLo) * windLvl) * (1 + 0.8 * windG), t, 0.12);
}
