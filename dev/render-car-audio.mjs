// Render the car voices to WAV files without a browser, to listen to and to
// measure. This is the new synthesis ALONE (engine, traffic, setts, brakes,
// impacts): the recorded layers of the game (tyre roll, wind, skid) are added
// by js/audio.js, so the full mix is rendered by dev/audiorender.html instead.
//
//   node dev/render-car-audio.mjs <outDir> [scene ...]
//
// It drives js/carvoices.js and public/worklets/carmixer.js exactly as the game
// does: one frame() per sixtieth of a second, sound in blocks of 128.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { SCENES, playScene } from './audioscenes.js';
import { CarVoices } from '../js/carvoices.js';
import { CarMixer } from '../public/worklets/carmixer.js';

export const SR = 48000;

/** Renders one scene. Returns { L, R, trace } with trace = per-frame rpm/gear. */
export function renderScene(scene, sr = SR) {
  const mixer = new CarMixer(sr);
  const voices = new CarVoices((m) => mixer.message(m));
  const n = Math.round(scene.dur * sr), L = new Float32Array(n), R = new Float32Array(n);
  const trace = [];
  let done = 0;
  playScene(scene, (s) => {
    if (s.kindChanged) { voices.playerStop(); if (s.kind) voices.playerStart(s.kind); }
    for (const k of s.hits) voices.hit(k);
    voices.frame(s.dt, s.player, s.cabin, s.traffic, s.ears);
    const p = voices.player;
    trace.push({ t: s.t, v: s.player?.speed ?? 0, rpm: p?.rpm ?? 0, gear: p?.gear ?? 0, load: p?.load ?? 0 });
    const until = Math.min(n, Math.round((s.t + s.dt) * sr));
    while (done < until) {
      const m = Math.min(128, until - done);
      mixer.process(L.subarray(done, done + m), R.subarray(done, done + m), m);
      done += m;
    }
  });
  return { L, R, trace };
}

export function wavBytes(chans, sr) {
  const n = chans[0].length, nc = chans.length, b = Buffer.alloc(44 + n * nc * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * nc * 2, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(nc, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * nc * 2, 28); b.writeUInt16LE(nc * 2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * nc * 2, 40);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i]));
    b.writeInt16LE(Math.round(v * 32767), o); o += 2;
  }
  return b;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [outDir, ...names] = process.argv.slice(2);
  if (!outDir) { console.error('usage: node dev/render-car-audio.mjs <outDir> [scene ...]'); process.exit(2); }
  mkdirSync(outDir, { recursive: true });
  for (const name of names.length ? names : Object.keys(SCENES)) {
    const scene = SCENES[name];
    if (!scene) { console.error('no such scene: ' + name); continue; }
    const t0 = performance.now();
    const { L, R, trace } = renderScene(scene);
    const ms = performance.now() - t0;
    let peak = 0, sum = 0;
    for (let i = 0; i < L.length; i++) { const a = Math.abs(L[i]); if (a > peak) peak = a; sum += L[i] * L[i]; }
    writeFileSync(join(outDir, name + '.wav'), wavBytes([L, R], SR));
    const gears = trace.filter((f, i) => i && f.gear !== trace[i - 1].gear).map((f) => `${f.t.toFixed(1)}s>${f.gear + 1}`);
    console.log(`${name.padEnd(18)} ${scene.dur}s in ${ms.toFixed(0)} ms  peak ${peak.toFixed(2)}  rms ${(10 * Math.log10(sum / L.length + 1e-12)).toFixed(1)} dB  shifts: ${gears.join(' ') || 'none'}`);
  }
}
