import { localAt, worldAt } from './story-rail.js';
import { carriageAt, doorX, offsets } from './prologue-coach.js';
export function inside(u, v) {
  if (u < -36.73 || u > 42.75) return false;
  const dx = u - carriageAt(u);
  return Math.abs(v) < (dx < -10 || dx > 16 ? 0.59 : 1.47);
}

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
      if (inside(u, v)) y = base + 0.165;
      else if (Math.abs(dx - doorX) < 0.78 && v < 0 && v > -2.65 && closed < 0.2)
        y = base + 0.03 - 0.2 * Math.min(3, Math.max(0, Math.round((-v - 1.5) / 0.28)));
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
      let { u, v } = localAt(pose, pos.x, pos.z);
      const beforeU = u,
        beforeV = v;
      function wall(a, b, c, d) {
        if (u <= a - r || u >= b + r || v <= c - r || v >= d + r) return;
        const ds = [u - a + r, b + r - u, v - c + r, d + r - v],
          n = ds.indexOf(Math.min(...ds));
        if (n === 0) u = a - r;
        else if (n === 1) u = b + r;
        else if (n === 2) v = c - r;
        else v = d + r;
      }
      for (const offset of offsets) {
        if (Math.abs(u - offset - 3) > 14 + r) continue;
        for (const side of [-1, 1]) {
          const z = 1.51 * side;
          if (side === -1 && closed < 0.2) {
            wall(offset - 10.15, offset + 13.25, z - 0.04, z + 0.04);
            wall(offset + 14.75, offset + 16.15, z - 0.04, z + 0.04);
          } else wall(offset - 10.15, offset + 16.15, z - 0.04, z + 0.04);
          if (side > 0) wall(offset - 9.6, offset + 11.55, 0.51, 1.43);
          else wall(offset - 9.6, offset + 11.55, -1.43, -0.51);
          for (const end of [-10.1, 16.1])
            wall(offset + end - 0.09, offset + end + 0.09, side > 0 ? 0.66 : -1.51, side > 0 ? 1.51 : -0.66);
        }
      }
      wall(-36.9, -36.73, -1.51, 1.51);
      wall(42.75, 42.9, -1.51, 1.51);
      if (u === beforeU && v === beforeV) return false;
      Object.assign(pos, worldAt(pose, u, v));
      return true;
    },
  };
}
