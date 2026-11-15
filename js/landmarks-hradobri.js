// ---- landmarks-hradobri.js: the railing of the 1st courtyard and the Gate of Giants ----
// WORKER SAFE (a footprint-less landmark, js/landmarks.js EXTRAS).
//
// Pacassi closed the Court of Honour (the 1st courtyard) from Hradčanské
// náměstí in the 1760s with a wrought-iron railing between stone piers, and
// put the Gate of Giants in its middle: two tall piers carrying Platzer's
// Fighting Titans (copies since 1912), the way every visitor walks in. The
// tile has the line as one generic `wall` barrier (5 vertices), which drew a
// 2 m grey wall across the whole front of the castle, gate included; it is
// replaced (js/landmarks.js landmarkBarrier) by this see-through railing.
// Nothing here collides (no barrier does).

import { K } from './landmarkskit.js';

/** The tile's barrier (tile -21_-2, k 'wall'), as it runs from the south-west. */
export const OBRI_LINE = [[-97350.9, -6548.8], [-97343.5, -6548.6], [-97328.1, -6553.6], [-97303.6, -6494.8], [-97321.5, -6486.4]];
/** The box the line lies in, for EXTRAS. */
export const OBRI_BOX = [-97352, -6555, -97302, -6485];
const FRONT = 2;                         // the edge the gate stands in (the court's west front)
const GATE_W = 5.2, PIER = 1.7, PIER_H = 5.6, POST = 0.8, POST_H = 2.9, RAIL_H = 2.4, BAY = 6.5;
const STONE = 0xc8bea6, IRON = 0x1d1f1e, TITAN = 0x8e8576;

const same = (p, q) => Math.abs(p[0] - q[0]) < 0.3 && Math.abs(p[1] - q[1]) < 0.3;

/** Is this barrier the court's railing line? WORKER SAFE. */
export function isObriBarrier(f) {
  return f.k === 'wall' && f.p?.length === OBRI_LINE.length && same(f.p[0], OBRI_LINE[0]);
}

/** A square stone pier standing at (x, z) on the ground y (absolute), turned to (dx, dz). */
function pier(kit, x, z, y, dx, dz, w, h) {
  const hw = w / 2, ex = dx * hw, ez = dz * hw, px = -dz * hw, pz = dx * hw;
  const box = (s, y0, y1) => {
    const c = [[x - ex * s - px * s, z - ez * s - pz * s], [x + ex * s - px * s, z + ez * s - pz * s], [x + ex * s + px * s, z + ez * s + pz * s], [x - ex * s + px * s, z - ez * s + pz * s]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], nx = (b[1] - a[1]), nz = -(b[0] - a[0]), l = Math.hypot(nx, nz);
      kit.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], nx / l, 0, nz / l);
    }
    kit.quad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]], 0, 1, 0);
  };
  kit.set(STONE, K.stone);
  box(1.12, y - 0.3, y + 0.5);              // plinth
  box(1, y + 0.5, y + h - 0.45);
  box(1.15, y + h - 0.45, y + h);           // cornice
}

/** One of the Titans: a heaving figure with a club over a fallen one, roughly, in weathered sandstone. */
function titan(kit, x, z, y, dx, dz, flip) {
  kit.set(TITAN, K.stone);
  const px = -dz, pz = dx, s = flip;
  const blk = (u, v, w, d, y0, y1) => {
    const cx = x + dx * u + px * v, cz = z + dz * u + pz * v;
    const c = [[cx - dx * w - px * d, cz - dz * w - pz * d], [cx + dx * w - px * d, cz + dz * w - pz * d], [cx + dx * w + px * d, cz + dz * w + pz * d], [cx - dx * w + px * d, cz - dz * w + pz * d]];
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], nx = (b[1] - a[1]), nz = -(b[0] - a[0]), l = Math.hypot(nx, nz);
      kit.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], nx / l, 0, nz / l);
    }
    kit.quad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]], 0, 1, 0);
  };
  blk(0.25 * s, 0, 0.75, 0.45, y, y + 0.7);               // the fallen one
  blk(-0.15 * s, 0.05, 0.32, 0.3, y + 0.5, y + 1.5);       // legs of the victor
  blk(-0.1 * s, 0, 0.36, 0.34, y + 1.5, y + 2.5);          // torso
  kit.lathe(x - dx * 0.1 * s, z - dz * 0.1 * s, [[0, y + 2.5], [0.2, y + 2.62], [0.19, y + 2.85], [0, y + 2.98]], 6);
  blk(-0.45 * s, 0, 0.1, 0.1, y + 2.2, y + 3.4);           // the raised arm
  blk(-0.5 * s, 0, 0.13, 0.13, y + 3.3, y + 3.9);          // ...and the club
}

/** The railing between two posts a-b on its sill, whose top is at ya..yb (absolute): two rails, bars every 14 cm, both faces. */
function railing(kit, a, b, ya, yb) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (L < 0.3) return;
  const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L, nx = -dz, nz = dx;
  const P = (t, y) => [a[0] + dx * t, y + ya + (yb - ya) * t / L, a[1] + dz * t];
  // the stone sill the iron stands in
  kit.set(STONE, K.stone);
  const Q = (t, o, y) => { const p = P(t, y); return [p[0] + nx * o, p[1], p[2] + nz * o]; };
  for (const s of [1, -1]) kit.quad(Q(0, s * 0.25, -0.65), Q(L, s * 0.25, -0.65), Q(L, s * 0.25, 0), Q(0, s * 0.25, 0), s * nx, 0, s * nz);
  kit.quad(Q(0, 0.25, 0), Q(L, 0.25, 0), Q(L, -0.25, 0), Q(0, -0.25, 0), 0, 1, 0);
  kit.set(IRON, K.metal);
  for (const [y0, y1] of [[0.12, 0.2], [RAIL_H - 0.18, RAIL_H - 0.1]]) {
    kit.quad(P(0, y0), P(L, y0), P(L, y1), P(0, y1), nx, 0, nz);
    kit.quad(P(0, y0), P(L, y0), P(L, y1), P(0, y1), -nx, 0, -nz);
  }
  const n = Math.max(1, Math.round(L / 0.14));
  for (let k = 1; k < n; k++) {
    const t = L * k / n, w = 0.018;
    const top = RAIL_H + (k % 3 === 0 ? 0.25 : 0);         // every third bar a spear
    kit.quad(P(t - w, 0), P(t + w, 0), P(t + w, top), P(t - w, top), nx, 0, nz);
    kit.quad(P(t - w, 0), P(t + w, 0), P(t + w, top), P(t - w, top), -nx, 0, -nz);
  }
}

/** The pieces chunk ctx.key owns: each pier, post and panel by the chunk holding its middle. */
export function buildObri(kit, ctx) {
  const T = ctx.terrain;
  if (!T) return;
  const own = (x, z) => ctx.chunkOf(x, z) === ctx.key;
  const gy = (x, z) => T.heightAt(x, z);
  kit.floodFn = (x, y) => 0.6;
  for (let e = 0; e + 1 < OBRI_LINE.length; e++) {
    const a = OBRI_LINE[e], b = OBRI_LINE[e + 1];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    const at = (t) => [a[0] + dx * t, a[1] + dz * t];
    // where the posts stand along this edge: the ends, then bays; the front's
    // middle is the gate, its piers either side of the opening
    const stops = [];
    if (e === FRONT) {
      const m = L / 2, g0 = m - GATE_W / 2 - PIER / 2, g1 = m + GATE_W / 2 + PIER / 2;
      for (const [s0, s1] of [[0, g0], [g1, L]]) {
        const n = Math.max(1, Math.round((s1 - s0) / BAY));
        for (let k = 0; k <= n; k++) stops.push({ t: s0 + (s1 - s0) * k / n, big: (k === n && s1 === g0) || (k === 0 && s0 === g1) });
      }
    } else {
      const n = Math.max(1, Math.round(L / BAY));
      for (let k = 0; k <= n; k++) stops.push({ t: L * k / n, big: false });
    }
    for (let k = 0; k < stops.length; k++) {
      const s = stops[k], [x, z] = at(s.t), y = gy(x, z);
      // a corner post is the next edge's first: drawn once, by the edge that starts there
      if (!(k === stops.length - 1 && s.t === L && e + 2 < OBRI_LINE.length) && own(x, z)) {
        if (s.big) {
          pier(kit, x, z, y, dx, dz, PIER, PIER_H);
          titan(kit, x, z, y + PIER_H, dx, dz, s.t < L / 2 ? 1 : -1);
        } else pier(kit, x, z, y, dx, dz, POST, POST_H);
      }
      const nxt = stops[k + 1];
      if (!nxt || (s.big && nxt.big)) continue;            // the gate's opening
      const half = (st) => (st.big ? PIER : POST) / 2;
      const p0 = at(s.t + half(s)), p1 = at(nxt.t - half(nxt));
      const mx = (p0[0] + p1[0]) / 2, mz = (p0[1] + p1[1]) / 2;
      if (own(mx, mz)) railing(kit, p0, p1, gy(p0[0], p0[1]) + 0.45, gy(p1[0], p1[1]) + 0.45);
    }
  }
}

/** The entry for js/landmarks.js EXTRAS (through js/landmarks-hrad.js EXTRAS_WIDE). */
export const OBRI_EXTRA = { id: 'hrad-obri', region: 'praha', box: OBRI_BOX, build: buildObri };
