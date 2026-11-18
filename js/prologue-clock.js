import { overrideTod, setSoloTime } from './worldclock.js';

// The campaign keeps its own clock (Frank, 18 Nov 2026): eight in the evening
// on the street in Kolín, ten past in the train, half past in Pardubice, ten
// at night at Vašek's table. The sky, the light and the HUD clock follow it;
// the world's own time (signals, timetables) runs on underneath. The clock
// only ever goes forward, in real seconds or pulled along by the story.
let now = 20 / 24,
  running = false;
export const storyClock = {
  start(hours = 20) {
    now = hours / 24;
    running = true;
    overrideTod(now);
  },
  get hours() {
    return now * 24;
  },
  // Jump ahead to `hours` (never back).
  to(hours) {
    if (!running) return;
    now = Math.max(now, hours / 24);
    overrideTod(now);
  },
  // Let real time pass, but not beyond `until` (hours).
  flow(dt, until = 24) {
    if (!running) return;
    now = Math.min(Math.max(now, until / 24), now + dt / 86400);
    overrideTod(now);
  },
  // The campaign is over: the world's clock takes over from this minute.
  release() {
    if (!running) return;
    running = false;
    setSoloTime(now);
    overrideTod(null);
  },
};
