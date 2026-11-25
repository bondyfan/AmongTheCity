// ---- fightsfx.js: the sounds of a fist fight -------------------------------
//
// Eleven short recordings made with ElevenLabs (scripts/gen-fight-audio.mjs,
// Frank asked for them on 25 Nov 2026) in public/assets/sounds/, played
// through js/audio.js sfxAt, so the game's volume and its distance filter
// apply like to every other one-shot. Variants rotate rather than repeat: the
// same smack three times in a combo is what makes a fight sound like a loop.
// A name without a file is one 404 for the session and then silence.

const SWING = ['fight_swing_1', 'fight_swing_2'];
const PUNCH = ['fight_punch_1', 'fight_punch_2', 'fight_punch_3'];
const HEAVY = 'fight_punch_heavy';
const BLOCK = 'fight_block';
const GRUNT_M = ['fight_grunt_m_1', 'fight_grunt_m_2', 'fight_grunt_m_3'];
const GRUNT_F = ['fight_grunt_f_1', 'fight_grunt_f_2'];
const R = 60;               // m: a fist is not a car horn

/** The fight's sound calls over an audio object with sfxAt (or nothing). */
export function fightSfx(audio) {
  let n = 0;
  const play = (name, vol, x, z, rate = 1) => {
    if (typeof audio?.sfxAt !== 'function') return;
    try { audio.sfxAt(name, vol, x, z, R, 0, rate); } catch (e) { /* a sound never stops a punch */ }
  };
  const pick = (list) => list[(n++) % list.length];
  // a touch of pitch spread: two jabs are never the same jab
  const rate = () => 0.94 + ((n * 37) % 13) / 100;
  return {
    swing(heavy, x, z) { play(pick(SWING), heavy ? 0.55 : 0.4, x, z, heavy ? 0.85 : rate()); },
    punch(heavy, x, z) { play(heavy ? HEAVY : pick(PUNCH), heavy ? 0.95 : 0.8, x, z, heavy ? 1 : rate()); },
    block(x, z) { play(BLOCK, 0.7, x, z, rate()); },
    grunt(male, x, z, vol = 0.8) { play(pick(male ? GRUNT_M : GRUNT_F), vol, x, z, rate()); },
    fall(x, z) { play('body_fall', 0.8, x, z); },
  };
}

export const FIGHT_SOUNDS = Object.freeze([...SWING, ...PUNCH, HEAVY, BLOCK, ...GRUNT_M, ...GRUNT_F]);
