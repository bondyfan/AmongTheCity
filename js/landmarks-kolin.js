import { K, prism } from './landmarkskit.js';

// The two long facades follow the platform. A six-metre bay in each one
// connects the bus forecourt, waiting room and platform in the same footprint.
function walls(f) {
  const out = [];
  const along = ([x, z]) => (x + 38842.1) * 0.81965 + (z - 706.5) * 0.57287;
  for (let i = 0; i < f.o.length; i++) {
    const a = f.o[i],
      b = f.o[(i + 1) % f.o.length],
      ua = along(a),
      ub = along(b);
    const split = [0, 1];
    if (Math.abs(ub - ua) > 0.01)
      for (const u of [21, 27]) {
        const t = (u - ua) / (ub - ua);
        if (t > 0 && t < 1) split.push(t);
      }
    split.sort((a, b) => a - b);
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    for (let j = 1; j < split.length; j++) {
      const p = at(split[j - 1]),
        q = at(split[j]),
        u = (along(p) + along(q)) / 2;
      out.push({ p, q, bot: u > 21 && u < 27 ? 3.1 : 0 });
    }
  }
  return out;
}
export function buildKolin(kit, f) {
  kit.set(0xe2cfab, K.plaster);
  for (const { p, q, bot } of walls(f)) {
    const dx = q[0] - p[0],
      dz = q[1] - p[1],
      l = Math.hypot(dx, dz);
    kit.wallGrid(p, q, bot, f.h, dz / l, -dx / l, {
      pitch: 3,
      rows: bot ? [] : [{ y: 1, h: 1.9, w: 1.7, hex: 0x536c78, glow: 0.45 }],
    });
    kit.wall(q, p, bot, f.h, -dz / l, dx / l);
  }
  kit.set(0x656668, K.metal);
  kit.cap(f.o, f.i, f.h);
  kit.cap(f.o, f.i, f.h - 0.15, false);
}
export function kolinSolids(f) {
  const result = [prism(f, f.h, f.h - 0.15)];
  for (const { p, q, bot } of walls(f)) {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]),
      x = ((q[1] - p[1]) * 0.1) / len,
      z = ((p[0] - q[0]) * 0.1) / len;
    result.push({
      ring: [
        [p[0] + x, p[1] + z],
        [q[0] + x, q[1] + z],
        [q[0] - x, q[1] - z],
        [p[0] - x, p[1] - z],
      ],
      top: f.h,
      bot,
    });
  }
  return result;
}
