// ---- airport-marks.js: the airports on both maps ----
// Frank, 25 Nov 2026: in Pardubice he saw no way of flying to the Seychelles.
// The flight is sold at the airport's desks and nowhere else, so the maps say
// where the airports are: a plane glyph (js/mapmarks.js 'airport') on the
// check-in of each one the player can fly from in this region, with its name
// on the big map. js/career.js adds them to the marks it already keeps.

import { region } from './regions.js';
import { SPAWNS } from './airport-plan.js';
import { prague } from './flight-lkpr.js';
import { REGIONS } from './regions.js';
import { seychelles } from './flight-airports.js';

let cached = null, cachedFor = null;

/** [{ x, z, kind: 'airport', rim: false, label }] for the live region. */
export function airportMarks() {
  const id = region().id;
  if (cachedFor === id) return cached;
  cachedFor = id;
  cached = [];
  if (region().czech) {
    const pce = SPAWNS['pce-airport'];
    cached.push({ x: pce.x, z: pce.z, kind: 'airport', rim: false, label: 'Letiště Pardubice' });
    const prg = prague();
    if (prg?.desk) cached.push({ x: prg.desk.x, z: prg.desk.z, kind: 'airport', rim: false, label: 'Letiště Praha' });
  } else if (id === 'mahe') {
    const sez = seychelles(REGIONS.mahe?.airport);
    if (sez?.desk) cached.push({ x: sez.desk.x, z: sez.desk.z, kind: 'airport', rim: false, label: 'Letiště Mahé' });
  }
  return cached;
}
