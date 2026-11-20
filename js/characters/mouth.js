// ---- mouth.js: a jaw that opens when its owner speaks -----------------------------
//
// A modelled person keeps one face bone, the jaw (scripts/people/convert-
// rocketbox.py), and this file decides how far it hangs open. Two callers:
//
//   mouth(level)   the campaign, which has the real loudness of the voice
//                  being played (js/prologue-voice.js intensity()), frame by frame
//   talk(seconds)  the street (js/chatter.js), which knows only that somebody
//                  says a line of about that length: the syllables are made up
//
// Pure arithmetic on the body's state record; no three, no clock of its own.

/** Radians the jaw drops at full voice. */
export const JAW_OPEN = 0.19;
const HOLD = 0.2;          // seconds an explicit level stands without being refreshed

/**
 * A made-up syllable train, 0..1: about five a second, uneven, with a short
 * shut between words. `seed` moves it so two people do not chew in step.
 */
export function syllables(t, seed = 0) {
  const p = t * 5.3 + seed * 7.1;
  const beat = Math.abs(Math.sin(p * Math.PI));
  const word = 0.5 + 0.5 * Math.sin(t * 2.1 + seed * 3.3);          // a slow swell: louder and quieter words
  const gap = Math.sin(t * 1.3 + seed * 5.7) > 0.86 ? 0 : 1;        // now and then a breath
  return gap * beat * (0.45 + 0.55 * word);
}

/**
 * A voice's measured loudness (js/audio.js storyRecording().intensity(), which
 * for speech sits around 0.1 to 0.4) as a mouth opening: ordinary talk opens
 * the jaw most of the way, and only silence shuts it.
 */
export const voiceToMouth = (v) => (v > 0.02 ? Math.min(1, v * 2.4) : 0);

/** The body is told how open its mouth is right now. */
export function setMouth(st, level, now) {
  st.mouthSet = level > 0 ? (level < 1 ? level : 1) : 0;
  st.mouthAt = now;
}
/** The body says something for `seconds` from now; zero cuts it off mid-word. */
export function startTalk(st, seconds, now) {
  st.talkUntil = seconds > 0 ? Math.max(st.talkUntil ?? 0, now + seconds) : 0;
}
export const talking = (st, now) => (st.talkUntil ?? 0) > now;

/** This frame's opening, 0..1, eased so a jaw never snaps. Advances st.mouth. */
export function mouthLevel(st, now, dt) {
  let want = 0;
  if (now - (st.mouthAt ?? -9) < HOLD) want = st.mouthSet ?? 0;
  else if (talking(st, now)) want = syllables(now, (st.seed ?? 0) % 97);
  const k = 1 - Math.exp(-dt * (want > (st.mouth ?? 0) ? 30 : 18));   // quicker to open than to shut
  st.mouth = (st.mouth ?? 0) + (want - (st.mouth ?? 0)) * k;
  if (st.mouth < 0.002) st.mouth = 0;
  return st.mouth;
}
