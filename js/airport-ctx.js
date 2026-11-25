// ---- airport-ctx.js: the terminal's frame, turned into stationKit calls ----
// Main thread only (stationKit makes canvases). The interior builders are written
// in the plan's own (u, v) and heights above the landmark's ground; this module is
// the one place that turns them into world boxes and plates, so every builder
// agrees on the orientation.
//
// stationKit's boxes are axis aligned in their own yaw. The terminal's u axis
// points along (cos θ, sin θ) in the world, so a box whose x is u and whose z is
// v is yawed by -θ (ARCHITECTURE.md: a mesh yawed by h turns its local -z into
// (−sin h, −cos h)). Every box is therefore built with rot.y = -θ.

import { FRAME, toWorld } from './airport-plan.js';

/** Yaw that makes a box's x run along the plan's u and its z along v. */
export const ROT = { x: 0, y: -FRAME.theta, z: 0 };
/**
 * Yaw of a plate whose front faces a plan direction (stationKit's plates face
 * (sin yaw, cos yaw) in the world). North is landside (−v), south the apron (+v),
 * east +u, west −u.
 */
export const FACE = {
  n: Math.PI - FRAME.theta,
  s: -FRAME.theta,
  e: Math.PI / 2 - FRAME.theta,
  w: -Math.PI / 2 - FRAME.theta,
};

/**
 * A builder context: the stationKit `k` and the landmark's founding ground
 * `base` (the floor is laid at base + 0.12, as a store's is). Every method takes
 * plan coordinates and heights above `base`.
 */
export function ctxOf(k, base) {
  const at = (u, v, y) => {
    const w = toWorld(u, v);
    return { x: w.x, y: base + y, z: w.z };
  };
  return {
    k,
    base,
    /** A box between two plan rectangles and two heights, in `finish`. */
    box(u0, u1, v0, v1, y0, y1, finish) {
      const c = at((u0 + u1) / 2, (v0 + v1) / 2, (y0 + y1) / 2);
      k.box(c.x, c.y, c.z, u1 - u0, y1 - y0, v1 - v0, finish, ROT);
    },
    /** A cylinder (a column, a drum, a round vent) standing on the plan point (u, v). */
    drum(u, v, y0, y1, across, finish) {
      const c = at(u, v, (y0 + y1) / 2);
      k.round(c.x, c.y, c.z, across, y1 - y0, finish);
    },
    /** One plate facing the plan direction `yaw` (a FACE value), centred on (u, v, y). */
    plate(u, v, y, yaw, w, h, px, draw, key, both = false) {
      const c = at(u, v, y);
      if (both) k.both(c.x, c.y, c.z, w, h, yaw, px, draw, key);
      else k.sign(c.x, c.y, c.z, w, h, yaw, px, draw, key);
    },
    /** A point at height y on plan (u, v), for lights and free-standing props. */
    at,
  };
}
