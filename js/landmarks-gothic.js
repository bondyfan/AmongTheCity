// ---- landmarks-gothic.js: pieces the Prague old town is made of ----
// WORKER SAFE. The Old Town of Prague is a town of Gothic towers: the Town
// Hall, the two spires of Týn, the Powder Tower and the two bridge towers all
// end the same way, a steep dark slate helmet over a gallery, with a little
// needle turret at every corner of it. Here are that helmet, the statues the
// bridge and the orloj are crowded with (a figure in the round and one in
// relief), and the dials of the orloj.

import { K } from './landmarkskit.js';
import { circle, rect, GOLD } from './landmarks-parts.js';

export const SLATE = 0x3a3d43, SLATE_DK = 0x2c2f34, SANDSTONE = 0xa29379, SANDSTONE_DK = 0x7d715f,
  BRONZE = 0x3d4a3f, LEAD = 0x5b6066;

/** A slate needle on an eight-sided turret (the corner turrets of a gallery). */
export function slateNeedle(kit, x, z, y0, shaft, r, tip, hex = SLATE, ball = true) {
  kit.set(hex, K.slate);
  kit.lathe(x, z, [[r, y0], [r, y0 + shaft], [r * 1.25, y0 + shaft + 0.15], [r * 0.18, tip - 0.4], [0, tip]], 8, Math.PI / 8);
  if (!ball) return;
  kit.set(GOLD, K.metal);
  kit.lathe(x, z, [[0, tip - 0.2], [Math.max(0.12, r * 0.2), tip + 0.05], [0, tip + 0.35]], 6);
}

/**
 * The Gothic tower helmet of the old town, over a square shaft in frame F
 * (half sizes hu, hv about local (u, v)): a gallery slab on a corbel course at
 * yG with a pierced parapet, a turret at each corner, and a steep pyramid from
 * yR to the tip with a lantern of a spire and a gilt knob.
 * o: { over, turretR, turretTop, rise (pyramid top, below tip), tip, roofHex,
 *      stone, parapet (true), lucarnes (count of little dormers per side) }
 */
export function gothicHelmet(kit, F, u, v, hu, hv, yG, yR, o = {}) {
  const S = F.sub(u, v);
  const over = o.over ?? 0.7, stone = o.stone ?? SANDSTONE, roof = o.roofHex ?? SLATE;
  const gu = hu + over, gv = hv + over;
  // the corbel course and the walk
  kit.set(stone, K.stone);
  S.box(-gu + 0.25, gu - 0.25, -gv + 0.25, gv - 0.25, yG - 0.9, yG - 0.35, null, false, true);
  S.box(-gu, gu, -gv, gv, yG - 0.35, yG, null, true, true);
  if (o.parapet !== false) {
    // a parapet pierced with little pointed openings, on all four sides
    const pr = { pitch: 0.9, inset: 0.35, rows: [{ y: 0.2, h: 0.6, w: 0.45, arch: 2, open: true }] };
    const PH = 1.05;
    S.box(-gu, gu, gv - 0.18, gv, yG, yG + PH, { f: pr, b: true, l: true, r: true }, true);
    S.box(-gu, gu, -gv, -gv + 0.18, yG, yG + PH, { b: pr, f: true, l: true, r: true }, true);
    S.box(-gu, -gu + 0.18, -gv + 0.18, gv - 0.18, yG, yG + PH, { l: pr, f: false, b: false, r: true }, true);
    S.box(gu - 0.18, gu, -gv + 0.18, gv - 0.18, yG, yG + PH, { r: pr, f: false, b: false, l: true }, true);
  }
  // the shaft goes on behind the walk to the eaves, with a door each side
  kit.set(stone, K.stone);
  const door = { cols: 1, rows: [{ y: 0.1, h: 2.0, w: 0.9, arch: 2, hex: 0x221a14, kind: K.wood }] };
  S.box(-hu + 0.15, hu - 0.15, -hv + 0.15, hv - 0.15, yG, yR, { f: door, b: door, l: door, r: door }, false);
  // the helmet: a little eave, then the steep pyramid
  kit.set(roof, K.slate);
  const eu = hu + 0.25, ev = hv + 0.25, top = o.rise ?? yR + (hu + hv) * 2.1;
  S.pyramid(-eu, eu, -ev, ev, yR, top, 0.08);
  // little dormers on the slope, one tier
  const n = o.lucarnes ?? 1;
  if (n > 0) {
    const yd = yR + (top - yR) * 0.22, sh = 1.0;
    for (const [side, turn] of [['f', 0], ['b', Math.PI], ['l', -Math.PI / 2], ['r', Math.PI / 2]]) {
      const half = side === 'f' || side === 'b' ? eu : ev, far = side === 'f' || side === 'b' ? ev : eu;
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * half;
        // inset along the slope to where the roof stands at yd
        const d = far * (1 - (yd - yR) / (top - yR) * 0.92) - 0.15;
        const D = S.sub(0, 0, 0, turn);
        kit.set(roof, K.slate);
        D.box(t - 0.42, t + 0.42, d - 0.9, d + 0.05, yd, yd + sh, { f: { cols: 1, rows: [{ y: 0.12, h: 0.7, w: 0.5, arch: 2, hex: 0x2a2d30, glow: 0.2 }] } }, false);
        D.roof(t - 0.48, t + 0.48, d - 0.9, d + 0.1, yd + sh, yd + sh + 0.7, { alongV: true, over: 0.05 });
      }
    }
  }
  // the spire on the top and its knob
  const [cx, cz] = S.xz(0, 0);
  kit.set(roof, K.slate);
  const tip = o.tip ?? top + 3;
  const rr = Math.min(hu, hv) * 0.16;
  kit.lathe(cx, cz, [[rr, top - 0.5], [rr * 0.55, tip - 0.6], [0, tip]], 8, Math.PI / 8);
  kit.set(GOLD, K.metal);
  kit.lathe(cx, cz, [[0, tip - 0.55], [rr * 0.85 + 0.12, tip - 0.25], [0, tip + 0.15]], 8);
  // the four corner turrets of the gallery
  const tr = o.turretR ?? 0.75, tt = o.turretTop ?? yR + (top - yR) * 0.45;
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    const [x, z] = S.xz(su * (gu - tr * 0.75), sv * (gv - tr * 0.75));
    kit.set(stone, K.stone);
    kit.lathe(x, z, [[tr * 0.35, yG - 1.6], [tr, yG - 0.35]], 8, Math.PI / 8);   // corbel
    slateNeedle(kit, x, z, yG - 0.35, (tt - yG) * 0.32, tr, tt, roof);
  }
  return tip;
}

/** The outline of a standing figure in relief, an [u, y] polygon (feet at y0). */
export function figureOutline(uc, y0, h, arms = 0) {
  const s = h / 1.8, w = 0.27 * s;
  const a = arms * s;
  return [[uc - w * 1.2, y0], [uc + w * 1.2, y0], [uc + w * 0.95, y0 + 0.9 * s], [uc + w + a * 0.4, y0 + 1.25 * s],
    [uc + w * 0.9 + a, y0 + 1.45 * s], [uc + w * 0.55, y0 + 1.5 * s], [uc + w * 0.3, y0 + 1.53 * s],
    [uc + w * 0.42, y0 + 1.68 * s], [uc, y0 + 1.8 * s], [uc - w * 0.42, y0 + 1.68 * s], [uc - w * 0.3, y0 + 1.53 * s],
    [uc - w * 0.55, y0 + 1.5 * s], [uc - w * 0.9, y0 + 1.45 * s], [uc - w, y0 + 1.25 * s], [uc - w * 0.95, y0 + 0.9 * s]];
}

/**
 * A figure in the round: a robed saint, a soldier, the Virgin on her column.
 * A six-sided robe, shoulders, a head, and (when `halo`) a gilt ring of stars.
 * h is the figure's height; the plinth is the caller's.
 */
export function figure(kit, x, z, y, h, hex = 0x4a443b, kind = K.stone, phase = 0) {
  const s = h / 1.8;
  kit.set(hex, kind);
  kit.lathe(x, z, [[0.36 * s, y], [0.34 * s, y + 0.25 * s], [0.25 * s, y + 0.95 * s], [0.27 * s, y + 1.3 * s],
    [0.24 * s, y + 1.44 * s], [0.1 * s, y + 1.52 * s]], 6, phase);
  kit.lathe(x, z, [[0, y + 1.5 * s], [0.12 * s, y + 1.56 * s], [0.13 * s, y + 1.68 * s], [0.08 * s, y + 1.78 * s], [0, y + 1.8 * s]], 6, phase);
}

/** An annulus in a facade plane, as `n` quads (slab outlines cannot have holes). */
export function ringSlab(S, uc, yc, r0, r1, v0, v1, n = 16, phase = 0) {
  for (let i = 0; i < n; i++) {
    const a = phase + i * 2 * Math.PI / n, b = phase + (i + 1) * 2 * Math.PI / n;
    S.slab([[uc + Math.cos(a) * r0, yc + Math.sin(a) * r0], [uc + Math.cos(a) * r1, yc + Math.sin(a) * r1],
      [uc + Math.cos(b) * r1, yc + Math.sin(b) * r1], [uc + Math.cos(b) * r0, yc + Math.sin(b) * r0]], v0, v1);
  }
}

/**
 * The astronomical dial of the orloj, in a frame S whose origin lies in the
 * wall it hangs on and whose front is the wall's: the blue of the day sky
 * over the black of the night below the horizon, the red-brown of dawn and
 * dusk, the gilt ring of the 24 Old Bohemian hours round it, the zodiac ring
 * set off centre, and the hands with the sun and the moon on them.
 */
export function astroDial(kit, S, uc, y, r) {
  kit.set(GOLD, K.metal); S.slab(circle(uc, y, r, 24), 0, 0.1);
  kit.set(0x1c2333, K.metal); S.slab(circle(uc, y, r * 0.9, 24), 0.1, 0.13);
  // the 24 gilt hours on the black outer band
  kit.set(GOLD, K.metal);
  for (let i = 0; i < 24; i++) {
    const a = i * Math.PI / 12, c = Math.cos(a), s = Math.sin(a), w = r * 0.025;
    const p0 = r * 0.8, p1 = r * 0.88;
    S.slab([[uc + c * p0 - s * w, y + s * p0 + c * w], [uc + c * p1 - s * w, y + s * p1 + c * w],
      [uc + c * p1 + s * w, y + s * p1 - c * w], [uc + c * p0 + s * w, y + s * p0 - c * w]], 0.13, 0.16);
  }
  // the sky: blue above, dawn and dusk, and the black earth under the horizon
  kit.set(0x3a6fa6, K.metal); S.slab(circle(uc, y, r * 0.78, 24), 0.13, 0.16);
  const seg = (y0, y1, hex) => {
    // the part of the inner disc between two heights, as one outline
    const R = r * 0.78, pts = [];
    const a0 = Math.asin(Math.max(-1, Math.min(1, (y0) / R))), a1 = Math.asin(Math.max(-1, Math.min(1, (y1) / R)));
    for (let i = 0; i <= 8; i++) { const a = a0 + (a1 - a0) * i / 8; pts.push([uc + Math.cos(a) * R, y + Math.sin(a) * R]); }
    for (let i = 0; i <= 8; i++) { const a = a1 + (a0 - a1) * i / 8; pts.push([uc - Math.cos(a) * R, y + Math.sin(a) * R]); }
    kit.set(hex, K.metal); S.slab(pts, 0.16, 0.18);
  };
  seg(-r * 0.78, -r * 0.3, 0x18120f);
  seg(-r * 0.3, -r * 0.18, 0x8a3f22);
  // the zodiac ring, off centre toward the top
  kit.set(GOLD, K.metal);
  ringSlab(S, uc, y + r * 0.2, r * 0.46, r * 0.54, 0.18, 0.22, 18);
  // the hands: the hand with the sun, and the moon
  S.slab([[uc - r * 0.03, y], [uc + r * 0.03, y], [uc + r * 0.02, y + r * 0.8], [uc - r * 0.02, y + r * 0.8]], 0.22, 0.25);
  S.slab(circle(uc + r * 0.0, y + r * 0.5, r * 0.09, 10), 0.25, 0.28);
  kit.set(0xb9bcc0, K.metal);
  S.slab([[uc, y - r * 0.02], [uc + r * 0.6, y - r * 0.38], [uc + r * 0.58, y - r * 0.42], [uc - r * 0.02, y + r * 0.02]], 0.22, 0.24);
  S.slab(circle(uc + r * 0.43, y - r * 0.27, r * 0.07, 8), 0.24, 0.27);
  kit.set(GOLD, K.metal); S.slab(circle(uc, y, r * 0.06, 8), 0.25, 0.3);
}

/** The calendar dial under it: gilt rim, twelve painted medallions of the months, the town's arms. */
export function calendarDial(kit, S, uc, y, r) {
  kit.set(GOLD, K.metal); S.slab(circle(uc, y, r, 24), 0, 0.1);
  kit.set(0x2a4f7a, K.metal); S.slab(circle(uc, y, r * 0.93, 24), 0.1, 0.13);
  kit.set(0xd8cdb2, K.metal);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6 + Math.PI / 12;
    S.slab(circle(uc + Math.cos(a) * r * 0.72, y + Math.sin(a) * r * 0.72, r * 0.17, 8), 0.13, 0.16);
  }
  kit.set(GOLD, K.metal); ringSlab(S, uc, y, r * 0.44, r * 0.5, 0.13, 0.16, 16);
  kit.set(0x9c2a26, K.metal); S.slab(circle(uc, y, r * 0.4, 16), 0.13, 0.16);
  kit.set(GOLD, K.metal);
  S.slab([[uc - r * 0.2, y - r * 0.18], [uc + r * 0.2, y - r * 0.18], [uc + r * 0.2, y + r * 0.08], [uc + r * 0.12, y + r * 0.08],
    [uc + r * 0.12, y + r * 0.2], [uc + r * 0.04, y + r * 0.2], [uc + r * 0.04, y + r * 0.08], [uc - r * 0.04, y + r * 0.08],
    [uc - r * 0.04, y + r * 0.2], [uc - r * 0.12, y + r * 0.2], [uc - r * 0.12, y + r * 0.08], [uc - r * 0.2, y + r * 0.08]], 0.16, 0.19);
  S.slab(rect(uc - r * 0.03, y + r * 0.04, uc + r * 0.03, y + r * 0.72), 0.16, 0.19);
}
