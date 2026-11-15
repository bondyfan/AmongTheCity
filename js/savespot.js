// ---- savespot.js: where a save puts you down again ----
// Two questions the save asks of the world, kept apart from js/career.js so
// they can be tested with a fake world:
//
//   standY(world, x, z, y)          the level to stand a restored player on
//   groundReady(world, x, z)        can that question be answered yet
//   motorwayStop(x, z, h, out)      on a D11 / D35 carriageway: where the car
//                                   and the driver belong in a save
//   motorwaySave(world, x, z, h, y, out)  the same, kept only when both spots
//                                   are on the car's level
//
// WHY A SAVE CARRIES y. A position alone has two answers wherever a deck
// crosses something: Charles Bridge stands 8.7 m over the Vltava's bed, and a
// save made on it (x -96298, z -6088, deck 190.7) used to load at y 182, in
// the river under the bridge, because the first step of the walk controller
// starts from y 0 and every level is then "overhead", so the LOWEST wins. The
// same happened the other way under a D11 overpass. With the saved y the
// answer is the level the save was made on.
//
// Pure apart from what `world` answers (heightAt, supportY, terrain, city):
// nothing here touches the DOM or allocates per frame.

import { d11Locate, onBridge } from './d11.js';
import { chunkKey } from './geo.js';

// m over the bare ground an OLD save (no y) may still find its floor: Charles
// Bridge is 8.7 m over the riverbed, the highest footbridges in the data about
// 11 m. Higher than this is somebody else's viaduct, not where you stood.
const OLD_REACH = 13;
const SNAP_UP = 1.5;           // city.js SNAP_UP restated: "is this over the ground"

/**
 * The y to stand a restored player on at (x, z).
 * With the saved `y` (a save from this build): the walkable level nearest it,
 * found the way the walk controller finds its floor (supportY, a step over the
 * feet), so a deck, a roof or an interior floor comes back as the one you left.
 * Without it (an older save): the highest walkable level close above the
 * ground, a bridge deck before the riverbed, unless the point lies on a way
 * that is itself on the ground (the path under a footbridge), where it is the
 * walker's floor (world.walkY) as before.
 */
export function standY(world, x, z, y) {
  if (Number.isFinite(y)) {
    const s = world.supportY ? world.supportY(x, z, y + 0.3) : world.heightAt(x, z, y + 0.3);
    return Number.isFinite(s) ? s : y;
  }
  const g = world.terrain.heightAt(x, z);
  const top = world.heightAt(x, z, g + OLD_REACH);
  if (!(top > g + SNAP_UP)) return Number.isFinite(top) ? top : g;
  // a deck over a way on the ground is the street's ceiling, not its floor
  const deck = typeof world._deckAt === 'function' ? world._deckAt(x, z, top) : 0;
  if (deck && typeof world._onGroundWay === 'function' && world._onGroundWay(x, z, deck === 1)) {
    return world.walkY ? world.walkY(x, z) : g;
  }
  return top;
}

/**
 * Has (x, z) got what standY reads: its chunk cell of roads (the bridge ways),
 * its height map, and in a tiled world the earthworks that grade the decks.
 * A restore that stood the player before this would read the bare ground.
 */
export function groundReady(world, x, z) {
  const city = world?.city;
  if (!city?.chunkIndex?.get(chunkKey(x, z))) return false;
  const T = world.terrain;
  if (T?.ready && !T.ready(x, z)) return false;
  if (city.tile && T?._conformed) {
    const tk = Math.floor(x / city.tile) + ',' + Math.floor(z / city.tile);
    if (!T._conformed.has(tk)) return false;
  }
  return true;
}

// ---- a save made at the wheel on the motorway --------------------------------
// The driver's door is no place to wake up on the D11: from the overtaking
// lane it is the median barrier or the other carriageway, from any lane it is
// a running lane with traffic at 130. So a car on a D11 / D35 carriageway is
// saved standing on its HARD SHOULDER (js/lanes.js: 3.75 to 6.25 m right of
// the line, centre 5.0), and its driver behind the guard rail beyond it
// (js/mwplan.js: the rail 0.6 m past the asphalt edge at 6.25), where a Czech
// driver is told to wait. On a bridge there is no "behind the rail" but the
// drop, so there the car keeps to the right lane and the driver stands on the
// shoulder, inside the deck's kerb.
const ON_CW = 6.6;             // m: |offset| still on this carriageway (ribbon half 6.25 + a wheel)
const CAR_SHOULDER = 5.0;      // m right of the line: the hard shoulder's middle
const CAR_RIGHT_LANE = 1.875;  // m: the right running lane's centre (lanes.js centers[1])
const WALK_VERGE = 7.75;       // m: rail at 6.85, then 0.9 m of verge
const WALK_DECK = 5.0;         // m: the shoulder of a bridge
const ALIGN = 0.94;            // cos 20 deg: a road crossing over the D11 is not on it
const _loc = { road: '', cw: '', km: 0, off: 0, dx: 0, dz: 0 };

/**
 * For a car at (x, z) heading `heading` (0 faces -z): null when it is not on a
 * D11 / D35 carriageway, else `out` filled with { cx, cz, px, pz, h }: where
 * the car is saved, where its driver is saved, and the carriageway's heading.
 * The caller checks the ground there (a lateral move off an overpass that
 * happens to lie along the D11 must not drop anyone off its edge).
 */
export function motorwayStop(x, z, heading, out) {
  const loc = d11Locate(x, z, _loc);
  if (!loc || Math.abs(loc.off) > ON_CW) return null;
  // the car's travel direction against the carriageway's (oneway: a car
  // driving the wrong way is still on it, a crossing road is not)
  const fx = -Math.sin(heading), fz = -Math.cos(heading);
  if (Math.abs(fx * loc.dx + fz * loc.dz) < ALIGN) return null;
  // right of travel along the line is (-dz, dx) (d11Locate's own `off` sign)
  const rx = -loc.dz, rz = loc.dx;
  const deck = onBridge(loc.km, loc.cw, 0.03);
  const carOff = deck ? CAR_RIGHT_LANE : CAR_SHOULDER, walkOff = deck ? WALK_DECK : WALK_VERGE;
  const bx = x - rx * loc.off, bz = z - rz * loc.off;      // the foot on the line
  out.cx = bx + rx * carOff; out.cz = bz + rz * carOff;
  out.px = bx + rx * walkOff; out.pz = bz + rz * walkOff;
  out.h = Math.atan2(-loc.dx, -loc.dz);
  out.deck = deck;
  return out;
}

// The shoulder may stand a little proud of the lane (under the overpass at D11
// km 66.3 the abutment's earth rises 0.7 m through it), and the verge behind
// the rail may fall away down an embankment. What must not happen is a move
// of a deck's height: off the side of an overpass that lies along the D11,
// or from the road under a bridge up onto it.
const CAR_LEVEL = 1.5;         // m: the car's spot against the car's y
const WALK_LEVEL = 2.5;        // m: the driver's spot against the car's y

/**
 * motorwayStop for a car at level `y`, checked against the world: true with
 * `out` filled (and out.py, the driver's floor there) when the car's and the
 * driver's spots are both on the car's level; false (out.ok false) otherwise,
 * and then the caller keeps its ordinary spot by the driver's door.
 * Two heightAt calls a frame while on the motorway (a few microseconds).
 */
export function motorwaySave(world, x, z, heading, y, out) {
  out.ok = false;
  if (!Number.isFinite(y) || !world?.heightAt || !motorwayStop(x, z, heading, out)) return false;
  const gy = world.heightAt(out.px, out.pz, y + 0.3);
  const cy = world.heightAt(out.cx, out.cz, y + 0.3);
  if (!(Math.abs(gy - y) < WALK_LEVEL && Math.abs(cy - y) < CAR_LEVEL)) return false;
  out.py = gy;
  out.ok = true;
  return true;
}

// (exported for the tests: the numbers the layout above is made of)
export const STOP = Object.freeze({ ON_CW, CAR_SHOULDER, CAR_RIGHT_LANE, WALK_VERGE, WALK_DECK });
