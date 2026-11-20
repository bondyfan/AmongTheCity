// ---- carcrew.js: who the glass of a car shows in its front seats -----------------
//
// The cabin behind a car's glass is drawn by the body shader (js/carglass.js),
// people included. This file says WHO: a "crew" is the small record a body
// material is keyed by ({ id, D, P }):
//   D   the driver's jacket colour, for the plain figure the glass falls back
//       to, and in w whether there is a driver at all: 0 nobody, 1 the stock
//       driver (shown while the lamps burn), 2 somebody named (always shown)
//   P   a four-vector the shader reads: x the row of the driver's picture in
//       the seated atlas (js/characters/seatrows.js), y the passenger's, -1
//       for nobody modelled. The rows move; the vector is kept right for us.
//
// Every car is born with a stock driver (one of a few civilians, or the
// uniform its job wears), shown while its lamps burn: that is what lamps mean
// (js/vehicles.js). A car somebody has sat in is told exactly who is in it
// (js/cardoor.js setDriver, setPassenger).

import * as THREE from 'three';
import { bindSeat, touchSeat, seatKey, CIVS } from './characters/seatrows.js';

const DRIVER = [0.035, 0.04, 0.06, 1];
const NOBODY = [0, 0, 0, 0];
const _crews = new Map();
const _col = new THREE.Color();
let _born = 0;

function crew(id, D, dKey, pKey) {
  let c = _crews.get(id);
  if (c) { touchSeat(c.dKey); touchSeat(c.pKey); return c; }
  const P = new THREE.Vector4(-1, -1, 0, 0);
  c = { id, D, P, dKey: dKey ?? null, pKey: pKey ?? null };
  bindSeat(P, 0, c.dKey);
  bindSeat(P, 1, c.pKey);
  _crews.set(id, c);
  return c;
}

/** The stock driver's key for a job: 'police', 'medic', or anything else for one of the civilians. */
export function stockKey(role, n = 0) {
  return role === 'police' || role === 'medic' ? '@' + role : '@civ' + (((n % CIVS) + CIVS) % CIVS);
}

/** The crew a car is born with: a civilian at the wheel, a different one from car to car. */
export function bornCrew() {
  const key = stockKey(null, (Math.imul(_born++, 0x9e3779b1) >>> 28));
  return crew('s' + key, DRIVER, key, null);
}

/** The stock crew of a job (a patrol car, an ambulance). */
export const roleCrew = (role) => { const key = stockKey(role); return crew('s' + key, DRIVER, key, null); };

/**
 * Exactly who is in the front seats.
 *   driver      undefined: the car's own stock driver (`born`), as long as its lamps burn
 *               null: nobody, lamps or no lamps
 *               { jacket, cit }: this person (cit is their citizen, js/citizen.js)
 *   passenger   a citizen, or null
 */
export function crewOf(born, driver, passenger = null) {
  const pKey = seatKey(passenger, 'p');
  if (driver === undefined) {
    if (!pKey) return born ?? null;
    return crew((born?.id ?? 's') + '|' + pKey, born?.D ?? DRIVER, born?.dKey ?? null, pKey);
  }
  if (driver === null) return crew('x|' + (pKey ?? ''), NOBODY, null, pKey);
  const hex = driver.jacket ?? 0x22262c, dKey = seatKey(driver.cit, 'd');
  _col.set(hex);
  // 2, not 1: somebody named sits there whether the lamps burn or not (js/carglass.js)
  return crew('j' + hex.toString(16) + '|' + (dKey ?? '') + '|' + (pKey ?? ''), [_col.r, _col.g, _col.b, 2], dKey, pKey);
}
