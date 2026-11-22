// ---- traindeck.js: the floor, the walls and the doors of a train that bends ----
// The campaign's train is one rigid body in one frame (js/prologue-deck.js).
// A train of the open world is articulated: every coach sits on its own two
// bogies (js/trains.js _place), so every coach has its own frame, and a walker
// in the gangway is handed from one to the next. The coach itself is the
// campaign's, to the centimetre: the same floor, steps, walls and seats.
//
// A frame is { x, z, c, s, y, first, last }: the model's origin in the world,
// the unit vector along the coach toward its front, the base's height, and
// whether a cab closes its front (`first`) or its back (`last`).
// Pure: no three.js, no world. Tested in tests/trainride.test.mjs.

import { FLOOR, stepY, coachWalls, endWall } from './prologue-deck.js';
import { doorX } from './prologue-coach.js';

export { FLOOR };
const FRONT = 16.35, BACK = -10.35;   // the slot of one coach along its own x
const CAB_F = 16.05, CAB_B = -10.03;  // where a cab's wall closes the aisle
const SEAM = 0.35;                    // m two coaches' slots overlap by, so a bend opens no gap
const REACH = 3.4;                    // m from the centreline a door's way in is open
export const DOOR_OPEN = 0.2;         // a door closed less than this lets a walker through

/** The frame of a coach whose group stands at (x, y, z) on the railhead, heading h. */
export function frameAt(x, y, z, h, first, last, mid, rise, out = {}) {
  const c = -Math.sin(h), s = -Math.cos(h);
  out.x = x - c * mid; out.z = z - s * mid; out.c = c; out.s = s; out.y = y + rise;
  out.first = first; out.last = last;
  return out;
}
export const toLocal = (f, x, z) => ({
  u: (x - f.x) * f.c + (z - f.z) * f.s,
  v: (z - f.z) * f.c - (x - f.x) * f.s,
});
export const toWorld = (f, u, v) => ({ x: f.x + u * f.c - v * f.s, z: f.z + u * f.s + v * f.c });

/** Is (u, v) of this frame inside the coach? `pad` widens the slot at a gangway end. */
export function insideCoach(f, u, v, pad = 0) {
  const lo = f.last ? CAB_B : BACK - pad, hi = f.first ? CAB_F : FRONT + pad;
  if (u < lo || u > hi) return false;
  return Math.abs(v) < (u < -10 || u > 16 ? 0.59 : 1.47);
}

/**
 * Which coach holds the point: { i, u, v } or null. A coach that holds it in
 * its own slot wins; in a bend the seam between two is handed to the nearer.
 */
export function locate(frames, x, z) {
  let best = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (Math.abs(x - f.x) + Math.abs(z - f.z) > 40) continue;
    const { u, v } = toLocal(f, x, z);
    if (insideCoach(f, u, v)) return { i, u, v };
    if (!best && insideCoach(f, u, v, SEAM)) best = { i, u, v };
  }
  return best;
}

/** The height a walker at (x, z) stands on, or -Infinity: the floor, or a step of an open door. */
export function deckY(frames, x, z, closed) {
  let y = -Infinity;
  for (const f of frames) {
    if (Math.abs(x - f.x) + Math.abs(z - f.z) > 40) continue;
    const { u, v } = toLocal(f, x, z);
    if (insideCoach(f, u, v, SEAM)) return f.y + FLOOR;
    if (closed < DOOR_OPEN) {
      const st = stepY(u, Math.abs(v));
      if (f.y + st > y) y = f.y + st;
    }
  }
  return y;
}

/** At an open door, on its steps or in front of them: the one way over the track's strip. */
export function atDoor(frames, x, z, closed) {
  if (closed >= DOOR_OPEN) return false;
  for (const f of frames) {
    if (Math.abs(x - f.x) + Math.abs(z - f.z) > 40) continue;
    const { u, v } = toLocal(f, x, z);
    if (Math.abs(u - doorX) < 0.95 && Math.abs(v) < REACH) return true;
  }
  return false;
}

/** Push a walker of radius r out of the train's walls. True if it moved him. */
export function deckWalls(frames, pos, r, closed) {
  let moved = false;
  const open = closed < DOOR_OPEN;
  for (const f of frames) {
    if (Math.abs(pos.x - f.x) + Math.abs(pos.z - f.z) > 40) continue;
    const p = toLocal(f, pos.x, pos.z), u0 = p.u, v0 = p.v;
    if (Math.abs(p.u - 3) > 14 + r) continue;
    coachWalls(p, r, 0, open, open);
    if (f.first) endWall(p, r, CAB_F, CAB_F + 0.15);
    if (f.last) endWall(p, r, CAB_B - 0.17, CAB_B);
    if (p.u === u0 && p.v === v0) continue;
    const w = toWorld(f, p.u, p.v);
    pos.x = w.x; pos.z = w.z;
    moved = true;
  }
  return moved;
}

/** The free seat nearest a walker at u in his coach's aisle, or null (the campaign's rule). */
export function seatNear(u) {
  if (u < -9.7 || u > 11.7) return null;
  const bay = Math.max(0, Math.min(7, Math.round((u + 8.2) / 2.62)));
  return { u: -8.2 + bay * 2.62 + 0.84, v: 0.61 };
}
