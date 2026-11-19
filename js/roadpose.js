// ---- roadpose.js: how a vehicle lies on the road it is driving -----------------
// Pure: no three, no DOM. Read by js/traffic.js (the level and the grade of an
// AI car's road at its arclength) and js/vehicles.js (the attitude drawn).
//
// WHY. An AI car's HEIGHT has always come off its road: the levelled grade, or
// the bridge deck, at the arclength it has reached. Its ATTITUDE came off the
// terrain: four samples of the height grid under its corners. On open ground
// the two agree. On a bridge the grid under the deck is the river valley; in
// an underpass it is the 20 m grid arching back over a 9 m cutting; on an
// embankment it is the bank. There the car stood at the right height and lay
// along the wrong slope: under the railway in Jana Palacha a car at rest was
// pitched 10.8 degrees nose up and rolled 7, its tail a hand deep in the
// asphalt and its front wheels in the air, and a 12 m trolleybus far worse.
//
// So the attitude is read where the height is: along the road. A carriageway
// is drawn flat across its width, so an AI car on it has pitch and no roll.

import { bridgeDeckHeight, roadGradeY } from './geo.js';

/** The level way `road` is laid at, `dist` m along it (the deck, under its asphalt). Null: not graded. */
export function deckLevel(road, dist, terrain) {
  const y = road.br ? bridgeDeckHeight(road, dist, terrain) : roadGradeY(road, dist, terrain);
  return y === undefined ? null : y;
}

/**
 * dy/ds of the deck along INCREASING dist, read over a body `len` m long whose
 * centre is at `dist` (the chord from its tail to its nose, kept on the way).
 * 0 where the way is not graded or too short to say.
 */
export function deckSlope(road, dist, terrain, len = 4.6) {
  const total = road._len ?? 0;
  const h = Math.max(1.2, len / 2);
  let a = dist - h, b = dist + h;
  if (a < 0) a = 0;
  if (total > 0 && b > total) b = total;
  if (!(b - a > 0.5)) return 0;
  const ya = deckLevel(road, a, terrain), yb = deckLevel(road, b, terrain);
  if (ya === null || yb === null || !Number.isFinite(ya) || !Number.isFinite(yb)) return 0;
  return (yb - ya) / (b - a);
}

/** Pitch (rad, nose up positive) of a car travelling along a deck of slope `g` (signed along its travel). */
export const pitchOf = (g) => Math.atan(g > 1 ? 1 : g < -1 ? -1 : g);

/** m: the most the drawn surface may stand over a car's own road and still be its road (a step, not a deck). */
export const LIFT_MAX = 1.2;
/**
 * How far an AI car is lifted off its own road's level `own` onto the surface
 * `surf` that is drawn there (city.surfaceY, asked near `own`): the overlap of
 * a wider carriageway or a junction pad lying over it. 0 when the surface is
 * not road, is the car's own, lies under it (its own road is then what is on
 * top), or stands a whole step over it (another level).
 */
export function surfaceLift(own, surf, isRoad = true) {
  if (!isRoad) return 0;
  const d = surf - own;
  return d > 0.02 && d < LIFT_MAX ? d : 0;
}

/**
 * The lowest bridge deck among `decks` (ways with br) that passes over (x, z)
 * at a height between `lo` and `hi`, or null. `pad`: how far past its edge a
 * deck still counts (a column beside the parapet goes up through the fascia).
 * What a street lamp asks before it is planted: a 7.5 m column under a deck
 * 6 m up comes out through the carriageway of the bridge.
 */
export function deckOver(decks, x, z, lo, hi, terrain, pad = 0.6) {
  let best = null;
  for (let k = 0; k < decks.length; k++) {
    const b = decks[k], p = b.p;
    if (!b.br || !p || p.length < 2) continue;
    const half = (b.w ?? 4.4) / 2 + pad;
    let bd = Infinity, bs = 0, run = 0;
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az;
      const L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - ex * t, dz = z - az - ez * t, d = Math.sqrt(dx * dx + dz * dz);
      if (d < bd) { bd = d; bs = run + L * t; }
      run += L;
    }
    if (bd > half) continue;
    const y = bridgeDeckHeight(b, bs, terrain);
    if (y > lo && y < hi && (best === null || y < best)) best = y;
  }
  return best;
}
