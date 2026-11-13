// ---- seating.js: where a BODY goes on a car seat ---------------------------
//
// vehicles.js seatAnchor() puts a seat at 0.35 of the car's width from the
// centre line. That number is the cabin's skeleton (the first-person camera
// and the interior are cut from it) and it is further out than a real seat: a
// full-size adult centred there has a shoulder 10 cm through the door glass
// and a head through the roof rail, which is what chase view was showing.
// The glass is opaque, so the fix is not a prettier pose: it is to put the
// body where the whole of it is INSIDE the shell, and then it cannot be seen
// to be wrong from any angle.
//
// Pure numbers, no three: the net layer imports this headless.

import { PLAYER_SCALE } from './config.js';

// The seat anchor is the cushion top; a seated figure's origin (its feet when
// standing) hangs this far below it, which rests the underside of the thigh on
// the cushion: hip joint 0.915 m up the reference body, thigh 0.094 thick.
export const SIT_DROP = 0.82 * PLAYER_SCALE;

// half a seated adult across the shoulders, arms included
const HALF_BODY = 0.27 * PLAYER_SCALE;

/**
 * The body's sideways seat position for a CAR seat anchor at local x = ax.
 * The car's width is read back out of the anchor itself (ax is 0.35 of it),
 * so a ghost car that is only a kind name works too. The greenhouse at
 * shoulder height is about 0.80 of the half width (the tumblehome), and the
 * body has to fit inside that with its own half width to spare.
 */
export function seatX(ax) {
  const m = Math.abs(ax);
  if (!(m > 0)) return 0;
  const lim = Math.max(0.2, (m / 0.35) * 0.5 * 0.80 - HALF_BODY);
  return ax < 0 ? -Math.min(m, lim) : Math.min(m, lim);
}
