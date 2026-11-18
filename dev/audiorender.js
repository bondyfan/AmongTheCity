// Renders the driving scenes through the game's own audio code, silently.
// See audiorender.html for the query parameters.
//
// js/audio.js keeps one AudioContext for the life of the page, so every scene
// gets a page of its own: this script is both the parent (lists the scenes,
// opens one hidden iframe per scene, turns what comes back into a WAV) and the
// child (?child=1&scene=x: renders one scene and posts the samples up).
//
// The child never creates a real AudioContext. It hands audio.js an
// OfflineAudioContext that claims to be running, then walks the scene one
// sixtieth of a second at a time: suspend the render, tell the game's audio
// what the car is doing, resume. What is rendered is what the game would play.

import { SCENES, playScene } from './audioscenes.js';

const q = new URLSearchParams(location.search);
const SR = 48000;
const engine = q.get('engine') === 'old' ? 'old' : 'new';
const log = (s) => { const el = document.getElementById('log'); if (el) el.textContent += s + '\n'; };

if (q.get('child')) child(q.get('scene')).catch((e) => parent.postMessage({ scene: q.get('scene'), error: String(e?.stack ?? e) }, '*'));
else host();

// ---- parent ------------------------------------------------------------------
async function host() {
  const names = (q.get('scenes') ?? Object.keys(SCENES).join(',')).split(',').filter((n) => SCENES[n]);
  const save = q.get('save');
  window.__render = { done: [], failed: [], finished: false };
  log(`engine: ${engine}   scenes: ${names.length}`);
  for (const name of names) {
    const t0 = performance.now();
    const res = await new Promise((resolve) => {
      const frame = document.createElement('iframe');
      frame.style.display = 'none';
      const onMsg = (e) => {
        if (e.data?.scene !== name) return;
        removeEventListener('message', onMsg); frame.remove(); resolve(e.data);
      };
      addEventListener('message', onMsg);
      frame.src = `${location.pathname}?child=1&scene=${name}&engine=${engine}`;
      document.body.appendChild(frame);
    });
    if (res.error) { window.__render.failed.push(name); log(`${name}: FAILED ${res.error}`); continue; }
    const blob = new Blob([wav([res.L, res.R], SR)], { type: 'audio/wav' });
    const file = `${engine === 'old' ? 'pred' : 'po'}_${name}.wav`;
    let where = 'link';
    if (save) {
      const r = await fetch(`${save}/${file}`, { method: 'POST', body: blob }).catch(() => null);
      where = r?.ok ? 'saved' : 'SAVE FAILED';
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = file; a.textContent = file;
      document.body.append(a, document.createElement('br'));
    }
    window.__render.done.push(file);
    log(`${name}: ${SCENES[name].dur} s in ${((performance.now() - t0) / 1000).toFixed(1)} s, peak ${res.peak.toFixed(2)}, ${where}${res.note ? ', ' + res.note : ''}`);
  }
  window.__render.finished = true;
  log('hotovo');
}

function wav(chans, sr) {
  const n = chans[0].length, nc = chans.length, b = new DataView(new ArrayBuffer(44 + n * nc * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); b.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVEfmt ');
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, nc, true);
  b.setUint32(24, sr, true); b.setUint32(28, sr * nc * 2, true); b.setUint16(32, nc * 2, true);
  b.setUint16(34, 16, true); str(36, 'data'); b.setUint32(40, n * nc * 2, true);
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < nc; c++, o += 2) {
    b.setInt16(o, Math.round(Math.max(-1, Math.min(1, chans[c][i])) * 32767), true);
  }
  return b.buffer;
}

// ---- child: one scene --------------------------------------------------------
async function child(name) {
  const scene = SCENES[name];
  const off = new OfflineAudioContext(2, Math.round(scene.dur * SR), SR);
  // audio.js refuses to make a sound before the context is 'running'
  const fake = new Proxy(off, {
    get(t, k) { if (k === 'state') return 'running'; const v = t[k]; return typeof v === 'function' ? v.bind(t) : v; },
  });
  window.AudioContext = function () { return fake; };
  const RealNode = window.AudioWorkletNode;
  window.AudioWorkletNode = function (_ctx, n, o) { return new RealNode(off, n, o); };

  const audio = await import('../js/audio.js');
  const car = await import('../js/caraudio.js');
  audio.initAudio();
  audio.setVolume(1);
  car.carAudioForceOld(engine === 'old');
  // the dev server lets the browser keep worklet files from an earlier run;
  // a render of stale synthesis is a render of the wrong thing
  for (const f of ['car-worklet', 'carmixer', 'enginedsp', 'roaddsp']) await fetch(`worklets/${f}.js`, { cache: 'reload' });
  // everything that loads, loads before the clock starts
  car.carAudioFrame(0, null, 0, 0, 0, 1, false, null);
  for (let i = 0; i < 200 && engine === 'new' && car.carAudioState().stage !== 'ready'; i++) await sleep(25);
  audio.tireSet(30, 0.5); audio.roadWindSet(45); audio.skidSet(1, 0.5);
  audio.sfx('skid_chirp', 0); audio.sfx('skid_bark', 0); audio.sfx('debris_crash', 0);
  await sleep(1500);
  audio.tireSet(0, 0); audio.roadWindSet(0); audio.skidSet(0, 0);

  const frames = [];
  playScene(scene, (s) => frames.push(s));
  const fakeCar = { speed: 0, vGround: 0, slip01: 0, offroad: 0, damage: 0, x: 0, z: 0 };
  const sett = { chunkIndex: { get: () => ({ roads: [{ s: 'cobble', d: 1, w: 9, p: [[-60, 0], [60, 0]] }] }) } };
  let slipPrev = 0, hbPrev = false;
  const step = (s) => {
    if (s.kindChanged) { car.carStop(); if (s.kind) car.carStart(s.kind); }
    for (const k of s.hits) audio.crash(k);
    if (s.player) {
      const p = s.player;
      fakeCar.speed = fakeCar.vGround = p.speed; fakeCar.slip01 = p.slip;
      // the two transients vehicles.js adds itself: the chirp as the tyres let
      // go and the bark as the handbrake locks the rear
      if (p.slip > 0.1 && slipPrev <= 0.1) audio.skidChirp(0.5 + 0.5 * p.slip);
      if (p.hb && !hbPrev && p.speed > 4) audio.skidBark(Math.min(1, p.speed / 22));
      slipPrev = p.slip; hbPrev = p.hb;
      car.carDrive(s.dt, fakeCar, p.throttle, p.gas, p.hb, p.cobble > 0.5 ? sett : null);
    }
    audio.setListener(s.ears.x, s.ears.z, s.ears.dx, s.ears.dz);
    car.carAudioFrame(s.dt, s.traffic, s.ears.x, s.ears.z, s.ears.dx, s.ears.dz, s.cabin > 0.5, null);
  };
  step(frames[0]);
  for (let i = 1; i < frames.length; i++) {
    off.suspend(frames[i].t).then(() => { step(frames[i]); off.resume(); });
  }
  const buf = await off.startRendering();
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]); if (a > peak) peak = a; }
  const st = car.carAudioState();
  parent.postMessage({ scene: name, L, R, peak, note: engine === 'new' ? `worklet ${st.stage}` : '' }, '*', [L.buffer, R.buffer]);
}

// Not setTimeout: this page usually sits in a hidden pane, where timers are
// throttled to one a second or worse. A message is never throttled.
const tick = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = r; c.port2.postMessage(0); });
async function sleep(ms) { for (const end = performance.now() + ms; performance.now() < end;) await tick(); }
