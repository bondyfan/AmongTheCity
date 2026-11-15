// ---- haul.js: the long run, Pardubice to Prague and back (round 8) ----
// Pure: no DOM, no three, no clock of its own. js/careerjobs.js adds these
// offers to the board, js/jobs.js runs them as kind 'haul' (a courier whose
// drop-off is 87 km away), js/jobmath.js times and pays them.
//
// WHY A TABLE AND NOT THE GENERATOR. jobgen.js picks both ends out of the
// named places of the tiles in memory (6 km round the board), and the town
// limit is half an hour: a Prague drop-off can neither be found nor reached
// that way. A haul runs between two fixed depots that exist in the tiles as
// named post_office buildings (Česká pošta Depo Pardubice beside the main
// station, Zásilkovna depo Štěrboholy at Prague's east edge, 5 km off the
// D11's start), baked here with the service road a van stops on.
//
// ONCE PER IN-GAME DAY PER DIRECTION. The id hashes the game day (the shared
// clock's day number, js/worldclock.js) and the two depots, so every client
// is offered the same run, a finished run is not offered again that day, and
// a new one comes with the next game day (24 real minutes).
//
// THE FAR END is carried as it is baked (no `snap`): jobplaces.snapStopToRoute
// moves it onto the end of the GPS line once Prague has streamed in and the
// route reaches it, exactly as it does for a town job's stop.

import { hash32 } from './jobgen.js';

/** The depots: where the board offers the run, and where the van stops. */
export const DEPOTS = Object.freeze({
  pardubice: Object.freeze({ id: 'pardubice', name: 'Česká pošta, Depo Pardubice', type: 'post_office',
    x: 254.5, z: -103.6, wx: 254.5, wz: -107.0, street: 'u hlavního nádraží' }),
  praha: Object.freeze({ id: 'praha', name: 'Zásilkovna, depo Štěrboholy', type: 'post_office',
    x: -86990.3, z: -3867.5, wx: -86990.3, wz: -3871.5, street: 'Praha-Štěrboholy' }),
});

/** The two runs: [from, to, what the van carries]. */
const RUNS = Object.freeze([
  Object.freeze(['pardubice', 'praha', 'zásilky do Prahy']),
  Object.freeze(['praha', 'pardubice', 'zásilky do Pardubic']),
]);

/** How far from its origin depot the board offers a run. */
export const HAUL_R = 3000;

/** The game day number of shared world time `worldT` (s): what "today" means
 *  for an offer that comes once a game day. startTod and dayLength are the
 *  config.js START_TOD and DAY_LENGTH. */
export function gameDay(worldT, startTod, dayLength) {
  return Math.floor(startTod + worldT / dayLength);
}

/**
 * The haul offers for a board read at (x, z) on game day `day`: the run whose
 * origin depot is within HAUL_R, unless `done` already has it. Job shape as
 * jobgen.generateJobs makes it, kind 'haul'.
 */
export function haulOffers({ x, z, day, done = null }) {
  const out = [];
  for (const [a, b, what] of RUNS) {
    const from = DEPOTS[a], to = DEPOTS[b];
    if (Math.hypot(from.x - x, from.z - z) > HAUL_R) continue;
    const id = 'h' + hash32(day + '|haul|' + a + '|' + b).toString(36);
    if (done?.has(id)) continue;
    out.push({
      id, kind: 'haul',
      from: { name: from.name, type: from.type, x: from.x, z: from.z, wx: from.wx, wz: from.wz, street: from.street },
      to: { name: to.name, type: to.type, x: to.x, z: to.z, wx: to.wx, wz: to.wz, street: to.street },
      distM: Math.round(Math.hypot(to.x - from.x, to.z - from.z)),
      who: null, what,
    });
  }
  return out;
}
