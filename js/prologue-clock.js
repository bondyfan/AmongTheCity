import { overrideTod, overrideSky, setSoloTime } from './worldclock.js';

// The campaign keeps its own clock (Frank, 18 Nov 2026): eight in the evening
// on the street in Kolín, ten past in the train, half past in Pardubice, ten
// at night at Vašek's table. The sky, the light and the HUD clock follow it;
// the world's own time (signals, timetables) runs on underneath. The clock
// only ever goes forward, in real seconds or pulled along by the story.
//
// ITS LIGHT RUNS AHEAD OF IT (Frank, 25 Nov 2026: the start of the campaign
// has to be a wow for whoever plays it first). The sun of this sky sets at
// nine, so at eight the street was flat daylight. The story's hours are
// therefore shown to the sky as later ones: the hospital rings in the last
// low sun, he stands on the roof in the afterglow with the town's lamps
// coming on, runs for the train in the blue hour and rides into the night.
// The HUD still says 20:00. [story hour, the hour the sky is shown]
const LIGHT = [
  [20, 20.63], // the street: the sun five degrees up, long shadows
  [20.05, 21.3], // the roof (20:03): the sun is down, the afterglow, the first windows
  [20.1, 21.42], // down the ladder and across to the station
  [20.17, 21.6], // the train pulls out into the blue hour
  [20.5, 21.95], // Pardubice: night
  [22, 22.4], // Vašek's table
];
/** The hour the sky is lit for at story hour `h` (the same hour outside the evening above). */
export function skyHours(h) {
  const [first, light0] = LIGHT[0], [last, light1] = LIGHT.at(-1);
  if (h < first) return h; // (part two's small hours and morning are the clock's own)
  // after the table the two meet again within half an hour
  if (h >= last) return h + (light1 - last) * Math.max(0, 1 - (h - last) * 2);
  if (h === first) return light0;
  for (let i = 1; i < LIGHT.length; i++) {
    const [a, la] = LIGHT[i - 1], [b, lb] = LIGHT[i];
    if (h <= b) return la + ((lb - la) * (h - a)) / (b - a);
  }
  return h;
}

let now = 20 / 24,
  running = false;
const show = () => {
  overrideTod(now);
  overrideSky(skyHours(now * 24) / 24);
};
export const storyClock = {
  start(hours = 20) {
    now = hours / 24;
    running = true;
    show();
  },
  get hours() {
    return now * 24;
  },
  // Jump ahead to `hours` (never back).
  to(hours) {
    if (!running) return;
    now = Math.max(now, hours / 24);
    show();
  },
  // Let real time pass, but not beyond `until` (hours).
  flow(dt, until = 24) {
    if (!running) return;
    now = Math.min(Math.max(now, until / 24), now + dt / 86400);
    show();
  },
  // The campaign is over: the world's clock takes over from this minute.
  release() {
    if (!running) return;
    running = false;
    setSoloTime(now);
    overrideTod(null);
    overrideSky(null);
  },
};
