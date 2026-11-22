import { localAt, worldAt } from './story-rail.js';
import { carriageAt, doorX, offsets } from './prologue-coach.js';
export function inside(u, v) {
  if (u < -36.73 || u > 42.75) return false;
  const dx = u - carriageAt(u);
  return Math.abs(v) < (dx < -10 || dx > 16 ? 0.59 : 1.47);
}

// ---- one coach, in its own metres -----------------------------------------
// dx runs along the coach from its origin, v across it. The campaign's train
// (below) and every train of the open world (js/traindeck.js) stand on these.
export const FLOOR = 0.165; // the saloon floor over the coach's base
/** The height of the door's steps over the base, `a` metres out from the centreline. */
export function stepY(dx, a) {
  if (Math.abs(dx - doorX) >= 0.78 || a <= 0 || a >= 2.65) return -Infinity;
  return 0.03 - 0.2 * Math.min(3, Math.max(0, Math.round((a - 1.5) / 0.28)));
}
// A wall from (a, c) to (b, d) pushes a walker of radius r out by the nearest face.
function wall(p, r, a, b, c, d) {
  if (p.u <= a - r || p.u >= b + r || p.v <= c - r || p.v >= d + r) return;
  const ds = [p.u - a + r, b + r - p.u, p.v - c + r, d + r - p.v],
    n = ds.indexOf(Math.min(...ds));
  if (n === 0) p.u = a - r;
  else if (n === 1) p.u = b + r;
  else if (n === 2) p.v = c - r;
  else p.v = d + r;
}
/** The walls of the coach at `offset`; a door stands open on the -v flank (`left`) or the +v one. */
export function coachWalls(p, r, offset, left, right) {
  for (const side of [-1, 1]) {
    const z = 1.51 * side;
    if (side < 0 ? left : right) {
      wall(p, r, offset - 10.15, offset + 13.25, z - 0.04, z + 0.04);
      wall(p, r, offset + 14.75, offset + 16.15, z - 0.04, z + 0.04);
    } else wall(p, r, offset - 10.15, offset + 16.15, z - 0.04, z + 0.04);
    if (side > 0) wall(p, r, offset - 9.6, offset + 11.55, 0.51, 1.43);
    else wall(p, r, offset - 9.6, offset + 11.55, -1.43, -0.51);
    for (const end of [-10.1, 16.1])
      wall(p, r, offset + end - 0.09, offset + end + 0.09, side > 0 ? 0.66 : -1.51, side > 0 ? 1.51 : -0.66);
  }
}
/** The closed end of a train, from u = a to u = b. */
export const endWall = (p, r, a, b) => wall(p, r, a, b, -1.51, 1.51);

export function trainDeck(state) {
  return {
    carrying(x, z) {
      const { aboard, travelling, pose } = state;
      if (!aboard || !travelling) return false;
      const { u, v } = localAt(pose, x, z);
      return inside(u, v);
    },
    support(x, z, limit) {
      const { pose, base, closed } = state;
      if (Math.abs(x - pose.x) + Math.abs(z - pose.z) > 67) return -Infinity;
      const { u, v } = localAt(pose, x, z),
        dx = u - carriageAt(u);
      let y = -Infinity;
      if (inside(u, v)) y = base + FLOOR;
      else if (v < 0 && closed < 0.2) y = base + stepY(dx, -v);
      return this.carrying(x, z) || y <= limit + 0.02 ? y : -Infinity;
    },
    collide(pos, r, opts) {
      const { pose, base, closed } = state;
      if (
        !opts?.interior ||
        opts.yLo > base + 2.8 ||
        opts.yHi < base ||
        Math.abs(pos.x - pose.x) + Math.abs(pos.z - pose.z) > 68
      )
        return false;
      const p = localAt(pose, pos.x, pos.z),
        beforeU = p.u,
        beforeV = p.v;
      for (const offset of offsets) {
        if (Math.abs(p.u - offset - 3) > 14 + r) continue;
        coachWalls(p, r, offset, closed < 0.2, false);
      }
      endWall(p, r, -36.9, -36.73);
      endWall(p, r, 42.75, 42.9);
      if (p.u === beforeU && p.v === beforeV) return false;
      Object.assign(pos, worldAt(pose, p.u, p.v));
      return true;
    },
  };
}
