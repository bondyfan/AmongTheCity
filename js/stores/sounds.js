// ---- stores/sounds.js: the two sounds of a shop ----
// The scanner's beep and the chime of a till that has been paid, made from an
// oscillator each on the game's own master bus (js/audio.js), so they follow
// the volume setting and are silent when the game is muted.

import { audioGraph } from '../audio.js';

function tone(freq, t0, dur, vol, type = 'square') {
  const g = audioGraph();
  if (!g) return;
  const o = g.ctx.createOscillator(), a = g.ctx.createGain();
  o.type = type; o.frequency.value = freq;
  const t = g.ctx.currentTime + t0;
  a.gain.setValueAtTime(0, t);
  a.gain.linearRampToValueAtTime(vol, t + 0.008);
  a.gain.exponentialRampToValueAtTime(0.0008, t + dur);
  o.connect(a).connect(g.master);
  o.start(t); o.stop(t + dur + 0.02);
}

/** The scanner at a till. */
export const beep = () => tone(2350, 0, 0.09, 0.06);
/** A payment gone through: two rising notes. */
export const paid = () => { tone(1320, 0, 0.14, 0.07, 'sine'); tone(1760, 0.12, 0.22, 0.07, 'sine'); };
/** Something refused: a low buzz. */
export const refused = () => tone(180, 0, 0.25, 0.08, 'sawtooth');
/** The alarm at the door. */
export const alarm = () => { for (let i = 0; i < 6; i++) tone(i % 2 ? 2100 : 2700, i * 0.16, 0.14, 0.09); };
/** A soft double chime: an order is ready. */
export const chime = () => { tone(880, 0, 0.3, 0.06, 'sine'); tone(1175, 0.18, 0.4, 0.06, 'sine'); };
