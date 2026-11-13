// ---- the shape of a day ------------------------------------------------------
// How many people are out, as a function of the SHARED clock and of nothing
// else. The crowd used to be the same size at 03:00 as at noon while the
// traffic beside it ran a 24x curve (main.js TRAFFIC_HOURS), so the night
// streets were full of walkers and empty of cars. The two now tell one story:
// a rush toward work and school before eight, a lunch bump, the afternoon peak,
// an evening that gathers round the places that serve food and drink, and a
// town that is all but empty at three in the morning.
//
// Everything here is a pure function of numbers both co-op clients hold: the
// hour and the day index come off js/worldclock.js's shared seconds. The
// settings slider stays the CEILING: no curve below ever exceeds 1.
//
// Pure math, no imports beyond config: the pedestrian tests load it headless.

import { DAY_LENGTH, START_TOD } from './config.js';

// [hour, share of the slider] on a working day
const CROWD_WEEKDAY = [
  [0, 0.09], [1.5, 0.05], [3, 0.03], [4.5, 0.05], [5.5, 0.18], [6.5, 0.55],
  [7.5, 1.0], [8.5, 0.85], [10, 0.62], [11.5, 0.78], [12.5, 0.92], [14, 0.72],
  [15.5, 0.95], [16.5, 1.0], [18, 0.82], [19.5, 0.62], [21, 0.42], [22.5, 0.24],
  [24, 0.09],
];
// …and on Saturday and Sunday: nobody is going to work at seven, the middle of
// the day belongs to shops and parks, and the night runs later.
const CROWD_WEEKEND = [
  [0, 0.16], [1.5, 0.10], [3, 0.05], [5, 0.04], [7, 0.14], [8.5, 0.38],
  [10, 0.74], [11.5, 0.92], [13, 0.88], [15, 0.95], [17, 0.86], [19, 0.74],
  [21, 0.58], [22.5, 0.40], [24, 0.16],
];
// The share of a going-out place (a cell with restaurants, cafes, pubs): lunch,
// then the evening proper, and the pub-closing trickle after midnight.
const VENUE_WEEKDAY = [
  [0, 0.22], [1.5, 0.08], [3, 0.03], [6, 0.05], [8, 0.35], [11, 0.55],
  [12.5, 0.95], [14, 0.60], [17, 0.70], [19, 0.95], [21, 1.0], [22.5, 0.80],
  [24, 0.22],
];
const VENUE_WEEKEND = [
  [0, 0.55], [1.5, 0.30], [3, 0.08], [6, 0.04], [9, 0.40], [12.5, 0.95],
  [15, 0.80], [18, 0.90], [20, 1.0], [22.5, 1.0], [24, 0.55],
];
// What the weekend does to the traffic curve main.js already owns: the two
// commuter peaks flatten, the late evening picks up.
const TRAFFIC_WEEKEND = [
  [0, 1.5], [3, 1.3], [5, 0.7], [8, 0.5], [10, 0.9], [13, 1.05], [16, 0.7],
  [19, 0.95], [22, 1.3], [24, 1.5],
];

function curve(tbl, h) {
  if (!(h >= 0)) h = 0; else if (h >= 24) h -= 24 * Math.floor(h / 24);
  for (let i = 0; i < tbl.length - 1; i++) {
    const a = tbl[i], b = tbl[i + 1];
    if (h >= a[0] && h <= b[0]) {
      const t = (h - a[0]) / (b[0] - a[0] || 1);
      return a[1] + (b[1] - a[1]) * (t * t * (3 - 2 * t));   // smoothstep, no kinks
    }
  }
  return tbl[0][1];
}

/** Hour of the day, 0..24, at shared second `wt`. */
export function hourAt(wt) {
  const d = START_TOD + wt / DAY_LENGTH;
  return (d - Math.floor(d)) * 24;
}

/** Whole days since the world epoch at shared second `wt`. */
export function dayAt(wt) { return Math.floor(START_TOD + wt / DAY_LENGTH); }

/** Day of the week 0..6 (0 = Monday). Days 5 and 6 are the weekend. */
export function weekdayAt(wt) { return ((dayAt(wt) % 7) + 7) % 7; }
export function isWeekend(wt) { return weekdayAt(wt) >= 5; }

/** Share of the crowd slider out on an ordinary street. 0..1. */
export function crowdK(hour, weekend = false) {
  return curve(weekend ? CROWD_WEEKEND : CROWD_WEEKDAY, hour);
}

/** Share of the slider out where the restaurants and pubs are. 0..1. */
export function venueK(hour, weekend = false) {
  return curve(weekend ? VENUE_WEEKEND : VENUE_WEEKDAY, hour);
}

/**
 * Crowd share for a square of city, given how much of it is a going-out place
 * (`venueShare` 0..1). Never below the street curve: a pub does not empty its
 * street at eight in the morning, it only fills it at nine in the evening.
 */
export function placeCrowdK(hour, weekend, venueShare) {
  const base = crowdK(hour, weekend);
  if (!(venueShare > 0)) return base;
  const v = venueK(hour, weekend);
  return v > base ? base + (v - base) * Math.min(1, venueShare) : base;
}

/** Multiplier on the traffic curve for the day of the week (1 on a working day). */
export function trafficWeekK(hour, weekend = false) {
  return weekend ? curve(TRAFFIC_WEEKEND, hour) : 1;
}

/** Both at once, off the shared clock: what pedestrians.js asks every sweep. */
export function crowdAt(wt, venueShare = 0) {
  return placeCrowdK(hourAt(wt), isWeekend(wt), venueShare);
}

/** Do buses run their full timetable now, or the thin night one? */
export function isNightService(hour) { return hour >= 23 || hour < 4.5; }

export const _tables = { CROWD_WEEKDAY, CROWD_WEEKEND, VENUE_WEEKDAY, VENUE_WEEKEND, TRAFFIC_WEEKEND };
