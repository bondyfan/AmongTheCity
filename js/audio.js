// ---- Audio: one-shot SFX, city bed, procedural car engine + heli rotor ----
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
//
// v4 adds the CITY layer, and it is deliberately three things and not thirty:
//   · one looping sample bed (city_ambience) that ducks when you drive fast,
//   · ONE procedural low rumble standing in for all nearby traffic — a
//     PannerNode per AI car would be 45 voices of mush at 45× the cost, and
//     you cannot localise tyre roar anyway, only its density,
//   · one procedural helicopter rotor (LFO-gated noise) — a rotor is a gate
//     rate and a filter, i.e. exactly the two things a sample can't follow
//     while the machine spools up and flies away.

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
export function sfx(name, vol = 1) {
  if (!ctx || ctx.state !== 'running') return;  // pre-gesture: sources would
  const buf = buffers.get(name);                // queue up and burst on resume
  if (buf) { playBuffer(buf, vol); return; }
  if (buf === null) { fallback(name, vol); return; }   // known missing
  // first request: fetch+decode exactly once and play on arrival — ~100 ms of
  // first-play latency beats dropping the cue; every later call is instant
  loadBuffer(name).then(b => { if (b) playBuffer(b, vol); else fallback(name, vol); });
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

// Two horns, picked at random per honk so a jam doesn't sound like one car
// with a stutter: horn_far is the polite "the light is green" beep, horn_angry
// is somebody actually furious. Volume jitters ±12 % for the same reason.
// Callers (traffic AI, the player's key) never choose — the mix decides.
export function horn() {
  const angry = Math.random() < 0.4;   // most honks are the mild one
  sfx(angry ? 'horn_angry' : 'horn_far', (angry ? 0.75 : 0.6) * (0.88 + Math.random() * 0.24));
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
  vol: 0.42,          // sits under engine + SFX; it is the floor, not a track
  duckMin: 0.34,      // full duck leaves a third — never a hard mute, that reads as a bug
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
  duckDrive = 0; duckUpdate();         // out of the car → the street comes back
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

  // The city bed ducks with ROAD SPEED, not revs: coasting at 120 km/h with
  // your foot off is just as loud inside the cabin as pulling, and ducking off
  // the throttle instead would pump the whole mix on every gear change.
  // Nothing below ~25 km/h ducks at all — crawling through town, you can still
  // hear the town. (s = speed01, so 0.2·vmax ≈ 27 km/h, 0.7·vmax ≈ 96 km/h.)
  const dd = (s - 0.2) / 0.5;
  duckDrive = dd < 0 ? 0 : dd > 1 ? 1 : dd;
  duckUpdate();
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
  vol: 0.09,          // ceiling, only reached when you're stood in a jam
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
  oscLevel: 0.55, whineLevel: 0.05,
  vol: 0.2, volSpeed: 0.035,
  tau: 0.09,                  // ~250 ms settle: a rotor has inertia, so should its sound
};
// Cosine partials, all in phase → a tall narrow peak and a long shallow
// trough (WebAudio normalizes the result to ±1 for us). Allocated once at
// module load, copied by createPeriodicWave, never touched per frame.
const CHOP_REAL = new Float32Array([0, 1, 0.82, 0.58, 0.34, 0.16]);
const CHOP_IMAG = new Float32Array(CHOP_REAL.length);
let heli = null;

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
  // it), then the last stretch adds little — matches how lift feels
  heli.gain.gain.setTargetAtTime(HELI.vol * Math.pow(r, 0.7) + HELI.volSpeed * sp, t, tau);
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
