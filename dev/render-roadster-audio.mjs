// The Roadster against the Model 3, rendered to WAV without a browser and
// measured, because the game runs muted while it is being worked on.
//
//   node dev/render-roadster-audio.mjs <outDir> [--png]
//
// For every scene of dev/audioscenes.js roadsterScenes() it writes
//   NN_<scene>_PRED_tesla.wav    the same pedals in the Model 3, as the game
//                                voices it today: its motor (js/audio.js
//                                buildEV, ported in dev/evref.mjs) plus what
//                                the worklet adds for an electric car
//   NN_<scene>_PO_roadster.wav   the Roadster, js/carvoices.js and the mixer
//                                exactly as the game runs them
// and prints, per half second, the level and where the energy sits. --png adds
// a spectrogram pair per scene (needs ffmpeg on the PATH).
//
// Like dev/render-car-audio.mjs this is the SYNTHESIS alone: the recorded tyre
// roll and wind of js/audio.js are not in either file.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { roadsterScenes, playScene } from './audioscenes.js';
import { renderScene, wavBytes, SR } from './render-car-audio.mjs';
import { renderEV } from './evref.mjs';

const OUT_GAIN = 0.55;                 // js/caraudio.js: the worklet against the master bus

/** Power spectrum of one Hann-windowed frame of N (a power of two) samples. */
function spectrum(x, o, N, re, im) {
  for (let i = 0; i < N; i++) { re[i] = (x[o + i] ?? 0) * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); im[i] = 0; }
  for (let i = 1, j = 0; i < N; i++) {
    let b = N >> 1;
    for (; j & b; b >>= 1) j ^= b;
    j ^= b;
    if (i < j) { const t = re[i]; re[i] = re[j]; re[j] = t; }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const a = -2 * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < N; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k], h = i + k + len / 2;
        const vr = re[h] * cr - im[h] * ci, vi = re[h] * ci + im[h] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi; re[h] = ur - vr; im[h] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

const BANDS = [[20, 80], [80, 400], [400, 2000], [2000, 8000], [8000, 20000]];
/** Level, spectral centroid and band shares of x between two times. */
export function measure(x, t0, t1, sr = SR) {
  const N = 4096, re = new Float64Array(N), im = new Float64Array(N);
  const band = new Float64Array(BANDS.length);
  let all = 0, cen = 0, sum = 0, peak = 0, n = 0;
  const a = Math.round(t0 * sr), b = Math.min(x.length, Math.round(t1 * sr));
  for (let i = a; i < b; i++) { sum += x[i] * x[i]; if (Math.abs(x[i]) > peak) peak = Math.abs(x[i]); n++; }
  for (let o = a; o + N <= b; o += N / 2) {
    spectrum(x, o, N, re, im);
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] * re[k] + im[k] * im[k], f = k * sr / N;
      all += p; cen += p * f;
      for (let j = 0; j < BANDS.length; j++) if (f >= BANDS[j][0] && f < BANDS[j][1]) band[j] += p;
    }
  }
  return {
    rms: Math.sqrt(sum / Math.max(1, n)), peak, centroid: all > 0 ? cen / all : 0,
    share: Array.from(band, (p) => (all > 0 ? p / all : 0)),
    abs: Array.from(band, (p) => p),
  };
}
const db = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

/** One scene for one kind: { L, R, trace }, the EV motor mixed in for the Model 3. */
export function renderKind(name, kind) {
  const scene = roadsterScenes(kind)[name];
  const r = renderScene(scene);
  if (kind === 'tesla' && scene.kind) {
    const frames = [];
    playScene(scene, (s) => frames.push({ t: s.t, dt: s.dt, v: s.player?.speed ?? 0, th: s.player?.throttle ?? 0 }));
    // master-bus units into worklet units, so the two files keep the game's balance
    const ev = renderEV(frames, r.L.length, SR);
    for (let i = 0; i < ev.length; i++) { r.L[i] += ev[i] / OUT_GAIN; r.R[i] += ev[i] / OUT_GAIN; }
  }
  return { ...r, scene };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), png = args.includes('--png');
  const outDir = args.find((a) => !a.startsWith('--'));
  if (!outDir) { console.error('usage: node dev/render-roadster-audio.mjs <outDir> [--png]'); process.exit(2); }
  mkdirSync(outDir, { recursive: true });
  let nn = 0;
  for (const name of Object.keys(roadsterScenes())) {
    nn++;
    const files = {};
    for (const [tag, kind] of [['PRED_tesla', 'tesla'], ['PO_roadster', 'roadster']]) {
      const { L, R, trace, scene } = renderKind(name, kind);
      const mono = L.map((v, i) => (v + R[i]) * 0.5);
      const file = join(outDir, `${String(nn).padStart(2, '0')}_${name.replace('roadster_', '')}_${tag}.wav`);
      writeFileSync(file, wavBytes([L, R], SR));
      files[tag] = file;
      let clip = 0, pk = 0;
      for (let i = 0; i < L.length; i++) { const a = Math.max(Math.abs(L[i]), Math.abs(R[i])); if (a > pk) pk = a; if (a >= 0.999) clip++; }
      const whole = measure(mono, 0, scene.dur);
      console.log(`\n${file.split('/').pop()}  (${scene.title})`);
      console.log(`  whole: rms ${db(whole.rms).toFixed(1)} dB  peak ${pk.toFixed(2)}  clipped samples ${clip}  centroid ${whole.centroid.toFixed(0)} Hz`);
      console.log('     t  km/h   rms dB  peak  centroid   <80  80-400  .4-2k  2-8k  >8k   thrust tank');
      for (let t = 0; t + 0.5 <= scene.dur + 1e-6; t += 0.5) {
        const m = measure(mono, t, t + 0.5), f = trace[Math.min(trace.length - 1, Math.round((t + 0.25) * 60))];
        console.log(`  ${t.toFixed(1).padStart(4)} ${(f.v * 3.6).toFixed(0).padStart(5)} ${db(m.rms).toFixed(1).padStart(8)} ${m.peak.toFixed(2).padStart(5)} ${m.centroid.toFixed(0).padStart(9)}  `
          + m.share.map((s) => (s * 100).toFixed(0).padStart(4) + '%').join(' ')
          + `   ${f.thrust !== undefined ? f.thrust.toFixed(2) : '   -'} ${f.tank !== undefined ? f.tank.toFixed(2) : '   -'}`);
      }
    }
    if (png) {
      const out = join(outDir, `${String(nn).padStart(2, '0')}_${name.replace('roadster_', '')}_spektrogram_tesla_nahore_roadster_dole.png`);
      try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', files.PRED_tesla, '-i', files.PO_roadster, '-filter_complex',
          '[0:a]showspectrumpic=s=1200x360:legend=0:scale=log:fscale=log[a];[1:a]showspectrumpic=s=1200x360:legend=0:scale=log:fscale=log[b];[a][b]vstack', out]);
        console.log('  ' + out.split('/').pop());
      } catch (e) { console.log('  (no spectrogram: ' + String(e.message).split('\n')[0] + ')'); }
    }
  }
}
