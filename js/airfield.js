// ---- The two airfields: where the flying machines live ----
// The helicopter used to sit on the station forecourt, which was convenient and
// slightly absurd. It belongs at an airport, and now there are two real ones in
// the world: Pardubice (LKPD, runway 09/27, 2 499 m) and Václav Havel Airport
// Prague (LKPR, 06/24 at 3 724 m and 12/30 at 3 200 m). Both come out of the
// OSM data the pipeline now carries — runways, taxiways and aprons ride the
// road and paved layers, so the strips are drawn, lit and mapped like anything
// else in the world.
//
// Every parking spot below was picked by testing candidate points against the
// real apron polygons and rejecting anything inside — or within 22 m of — a
// building, so nothing is parked in a hangar wall. They sit beside the terminal
// at Pardubice (Terminál Jana Kašpara) and on the north apron at Prague, a
// short taxi from the threshold either way.
//
// This module owns the airfield furniture so main.js only has to know that
// there is a list of helicopters and a list of fighters, and which one the
// player is standing next to.

import { makeHelipad, Helicopter } from './helicopter.js';
import { Fighter } from './aircraft.js';

// heading convention (ARCHITECTURE.md): 0 faces −z (north), and a machine yawed
// by h travels along (−sin h, −cos h). −π/2 therefore faces EAST, which is the
// way both fields' main runways point their departures.
const EAST = -Math.PI / 2;

export const AIRFIELDS = [
  {
    name: 'Letiště Pardubice',
    icao: 'LKPD',
    // 09/27 runs (−2504, 1971) → (−7, 2091): 2 499 m of concrete, due east
    runway: { a: [-2504, 1971], b: [-7, 2091], ref: '09/27' },
    heli: { x: -2270, z: 1664, h: EAST },
    jets: [
      { x: -2246, z: 1676, h: EAST },
      { x: -2222, z: 1664, h: EAST },
    ],
  },
  {
    name: 'Letiště Václava Havla',
    icao: 'LKPR',
    // 06/24, the long one: (−109608, −7800) → (−106233, −9371)
    runway: { a: [-109608, -7800], b: [-106233, -9371], ref: '06/24' },
    heli: { x: -107221, z: -8337, h: EAST },
    jets: [
      { x: -107197, z: -8349, h: EAST },
      { x: -107185, z: -8325, h: EAST },
      { x: -107173, z: -8361, h: EAST },
    ],
  },
];

/**
 * Build every airfield's pads and machines into the scene.
 * → { helis: Helicopter[], fighters: Fighter[] }
 * The arrays are flat and in AIRFIELDS order; main.js only ever asks "what am
 * I standing next to", so it never needs to know which field it is at.
 */
export function buildAirfields(scene, world = null) {
  const helis = [], fighters = [];
  for (const f of AIRFIELDS) {
    const ground = world?.heightAt?.(f.heli.x, f.heli.z) ?? 0;
    scene.add(makeHelipad(f.heli.x, f.heli.z, ground));
    helis.push(new Helicopter(scene, f.heli.x, f.heli.z, f.heli.h, world));
    for (const j of f.jets) fighters.push(new Fighter(scene, j.x, j.z, j.h, world));
  }
  return { helis, fighters };
}

/**
 * The nearest machine of `list` within `r` metres of (x, z) that is on the
 * ground — you cannot board something that is already flying. Shared by the
 * helicopters and the fighters because "walk up to it and press E" is one rule.
 */
export function nearestParked(list, x, z, r = 6.5) {
  let best = null, bestD = r * r;
  for (const v of list) {
    if (v.airborne) continue;
    const d = (v.x - x) ** 2 + (v.z - z) ** 2;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** Which airfield is (x, z) closest to, and how far — for the HUD. */
export function nearestField(x, z) {
  let best = null, bestD = Infinity;
  for (const f of AIRFIELDS) {
    const d = Math.hypot(f.heli.x - x, f.heli.z - z);
    if (d < bestD) { bestD = d; best = f; }
  }
  return { field: best, dist: bestD };
}
