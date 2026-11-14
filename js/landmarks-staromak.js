// ---- landmarks-staromak.js: the Old Town Hall of Prague, its tower and the orloj ----
// WORKER SAFE. The picture of the Old Town Square: the town hall tower of 1364
// (69.5 m, the gallery at 42.5 m, a steep slate helmet with four corner
// turrets), on its south face the orloj of 1410 in a Gothic stone housing (the
// astronomical dial over the calendar dial, the two windows the apostles pass
// at the hour, the gilt cock over them), on its east side the chapel with its
// polygonal oriel, and west of it the row of houses the town bought one by one
// and joined into its hall: Wolflin's, Kříž's (the Renaissance window with
// PRAGA CAPUT REGNI), Mikeš's, U Kohouta and the sgraffitoed U Minuty on the
// corner of the Little Square.
//
// The tile has five footprints for it (the hall, the tower, the strip of the
// orloj housing, the chapel and its oriel) and each one is its own entry, so
// a generic box never pokes through. All five are drawn in ONE frame, a
// constant (the hall's own rectangle, front to the square, bearing 156 deg):
// the parts meet where the real ones meet whatever vertex a ring starts at.

import { K } from './landmarkskit.js';
import { Frame } from './landmarksframe.js';
import { rect, circle, GOLD, COPPER } from './landmarks-parts.js';
import { gothicHelmet, slateNeedle, figureOutline, astroDial, calendarDial, SANDSTONE, SANDSTONE_DK, SLATE } from './landmarks-gothic.js';

// the hall's rectangle (scratch: fitFrame of the hall with the hint 156 deg):
// u along the square from west to east, v out to the square
const O = [-95706.16, -6151.11], N = [0.399, 0.917];
const frame = (kit) => new Frame(kit, O[0], O[1], N[0], N[1]);
// the tower in that frame
const TU0 = 19.2, TU1 = 30.5, TV0 = 0.8, TV1 = 11.7, TUC = (TU0 + TU1) / 2;
const GALLERY = 42.5, EAVES = 45.6, PEAK = 66.4, TIP = 69.5;
const STONE = 0x9b8f7b, STONE_LT = 0xb5ab98, DARK = 0x191b1f, PANE = 0x2f3a47, TILE = 0x9c4a36;

export function buildRadniceVez(kit) {
  const F = frame(kit);
  kit.floodFn = (x, y) => (y < GALLERY ? 0.95 - 0.25 * (y / GALLERY) : 0.75);
  const hu = (TU1 - TU0) / 2, hv = (TV1 - TV0) / 2, vc = (TV0 + TV1) / 2;
  const T = F.sub(TUC, vc);
  // ---- the shaft: little pointed windows, more of them the higher it goes
  const win = (y, w = 0.9, h = 2.1) => ({ y, h, w, arch: 2, hex: PANE, glow: 0.12, rev: 0.3 });
  const upper = [win(19.5), win(25.5), win(31.5), win(37.2, 1.2, 2.6)];
  const front = { cols: 2, inset: 2.2, rows: upper, seed: 11 };
  const side = { cols: 2, inset: 2.2, rows: [win(9), win(15), ...upper], seed: 12 };
  kit.set(STONE, K.stone);
  T.box(-hu, hu, -hv, hv, 0, GALLERY - 0.9, { f: front, b: { cols: 1, rows: upper.slice(1) }, l: side, r: { cols: 2, inset: 2.2, rows: upper.slice(1), seed: 13 } }, false);
  // string courses: the tower is three storeys of stone
  kit.set(STONE_LT, K.stone);
  for (const y of [16.6, 28.8]) T.box(-hu - 0.12, hu + 0.12, -hv - 0.12, hv + 0.12, y, y + 0.35, null, true, true);
  // the clock of the tower itself, high on the east face, toward the square
  const C = T.sub(hu, 0, 0, Math.PI / 2);
  kit.set(GOLD, K.metal); C.slab(circle(0, 34.6, 1.45, 20), 0, 0.08);
  kit.set(0x20304a, K.metal); C.slab(circle(0, 34.6, 1.25, 20), 0.08, 0.12);
  kit.set(GOLD, K.metal);
  C.slab(rect(-0.06, 34.6, 0.06, 35.6), 0.12, 0.15);
  C.slab([[0, 34.55], [0.06, 34.65], [0.7, 34.2], [0.64, 34.1]], 0.12, 0.15);
  // ---- gallery, turrets and helmet
  gothicHelmet(kit, F, TUC, vc, hu, hv, GALLERY, EAVES, {
    over: 0.75, stone: STONE, rise: PEAK, tip: TIP, turretR: 0.8, turretTop: 55.5, lucarnes: 1,
  });
}

/** The orloj in its Gothic housing on the tower's south face (the strip footprint before it). */
export function buildOrloj(kit) {
  const F = frame(kit);
  kit.floodFn = (x, y) => (y < 17 ? 0.95 : 0.6);
  const v0 = TV1, vf = 13.6, uc = TUC;
  // the plinth and the pier of the housing
  kit.set(STONE, K.stone);
  F.box(uc - 4.6, uc + 4.6, v0, vf + 0.35, 0, 2.7, { f: { cols: 1, rows: [{ y: 0, h: 2.2, w: 1.3, arch: 2, door: true, rev: 0.25 }] } }, true);
  F.box(uc - 4.1, uc + 4.1, v0, vf, 2.7, 15.4, null, false);
  const S = F.sub(uc, vf);
  // the Gothic surround: piers either side, a pointed arch over the upper dial
  kit.set(SANDSTONE_DK, K.stone);
  for (const s of [-1, 1]) {
    S.slab(rect(s * 3.95 - 0.3, 2.7, s * 3.95 + 0.3, 15.0), 0, 0.35);
    const [x, z] = S.xz(s * 3.95, 0.18);
    slateNeedle(kit, x, z, 15.0, 0.6, 0.3, 17.4, SANDSTONE_DK, false);
  }
  // a pointed arch over the upper dial: the outer curve and back by the inner
  const band = [];
  for (let i = 0; i <= 10; i++) { const a = i / 10 * Math.PI; band.push([Math.cos(a) * 3.65, 11.1 + Math.pow(Math.sin(a), 0.7) * 2.3]); }
  for (let i = 10; i >= 0; i--) { const a = i / 10 * Math.PI; band.push([Math.cos(a) * 2.45, 11.1 + Math.pow(Math.sin(a), 0.7) * 1.25]); }
  kit.set(SANDSTONE, K.stone);
  S.slab(band, 0, 0.14);
  // the two dials, gilt and painted: astronomical over calendar
  astroDial(kit, S, 0, 9.1, 1.95);
  kit.set(STONE_LT, K.stone); S.slab(rect(-2.2, 6.25, 2.2, 6.55), 0, 0.16);
  calendarDial(kit, S, 0, 4.55, 1.5);
  // the figures beside the dials: Vanity, the Miser, Death and the Turk, and
  // under them the chronicler, the angel, the astronomer and the philosopher
  const figs = [[-3.0, 7.4, 0x6d5a3f], [-2.45, 8.9, 0x7a4c32], [2.45, 8.9, 0xe2dccd], [3.0, 7.4, 0x7d3b2a]];
  for (const [u, y, hex] of figs) { kit.set(hex, K.metal); S.slab(figureOutline(u, y, 1.45), 0.12, 0.3); }
  for (const u of [-3.0, -2.3, 2.3, 3.0]) { kit.set(0xcfc5ae, K.stone); S.slab(figureOutline(u, 3.3, 1.5), 0.05, 0.25); }
  // the apostle windows and the little roof over them, the gilt cock on top
  kit.set(SANDSTONE_DK, K.stone); S.slab(rect(-1.9, 13.5, 1.9, 15.2), 0, 0.1);
  for (const u of [-0.85, 0.85]) {
    kit.set(0x14161a, K.metal); S.slab([[u - 0.55, 13.7], [u + 0.55, 13.7], [u + 0.55, 14.55], [u, 14.95], [u - 0.55, 14.55]], 0.1, 0.13);
  }
  // the canopy over the housing: a steep little copper roof
  kit.set(COPPER, K.copper);
  F.roof(uc - 4.4, uc + 4.4, v0 - 0.1, vf + 0.6, 15.4, 16.9, { over: 0.15, hip0: 0.9, hip1: 0.9 });
}

/** The chapel east of the tower, under a lean-to against it. */
export function buildKaple(kit) {
  const F = frame(kit);
  kit.floodFn = (x, y) => (y < 15 ? 0.75 : 0.45);
  const u0 = 30.3, u1 = 35.4, v0 = 0.8, v1 = 11.7, H = 14.6;
  const tall = { cols: 2, inset: 1.2, rows: [{ y: 1.2, h: 2.4, w: 1.1, hex: PANE, glow: 0.3 }, { y: 6.5, h: 5.0, w: 1.4, arch: 2, hex: PANE, glow: 0.35, rev: 0.3 }], seed: 21 };
  kit.set(STONE_LT, K.stone);
  F.box(u0, u1, v0, v1, 0, H, { f: { cols: 1, rows: tall.rows }, r: { ...tall, cols: 2, skip: (c, r) => r === 1 && c === 1 }, b: true, l: false }, false);
  // the lean-to: up against the tower to 20 m
  kit.set(SLATE, K.slate);
  F.slab([[u0, 20.0], [u1 + 0.35, H - 0.2], [u1 + 0.35, H + 0.15], [u0, 20.35]], v0 - 0.2, v1 + 0.25, false);
  kit.set(STONE_LT, K.stone);
  F.slab([[u0, H], [u1, H], [u0, 20.0]], v1 - 0.3, v1);
  F.slab([[u0, H], [u1, H], [u0, 20.0]], v0, v0 + 0.3);
}

/** The oriel of the chapel: a five-sided bay on a corbel, its windows pointed, its roof a needle. */
export function buildArkyr(kit) {
  const F = frame(kit);
  kit.floodFn = () => 0.7;
  const [x, z] = F.xz(34.95, 5.8), r = 1.95, n = 8, y0 = 8.2, y1 = 15.6;
  const ang0 = Math.atan2(F.uz, F.ux);           // the frame's u in world angles
  kit.set(STONE_LT, K.stone);
  kit.lathe(x, z, [[0.25, 6.2], [0.9, 6.9], [1.6, 7.6], [r, y0]], n, ang0 + Math.PI / 8);
  // the five faces that stand out of the wall, each with one tall pointed light
  const P = (i) => { const a = ang0 + Math.PI / 8 + i * 2 * Math.PI / n; return [x + Math.cos(a) * r, z + Math.sin(a) * r]; };
  for (let i = -3; i < 2; i++) {
    const a = P(i), b = P(i + 1), mx = (a[0] + b[0]) / 2 - x, mz = (a[1] + b[1]) / 2 - z, L = Math.hypot(mx, mz);
    kit.wallGrid(a, b, y0, y1, mx / L, mz / L, { cols: 1, rows: [{ y: 1.4, h: 4.6, w: 0.85, arch: 2, hex: PANE, glow: 0.45, rev: 0.2 }], seed: 30 + i });
  }
  kit.set(SANDSTONE, K.stone);
  kit.lathe(x, z, [[r + 0.15, y1], [r + 0.15, y1 + 0.4]], n, ang0 + Math.PI / 8);
  slateNeedle(kit, x, z, y1 + 0.4, 0.2, r + 0.1, 26.6, SLATE);
}

// ---- the hall: the row of houses on the square ------------------------------
// [u0, u1, front v, wall top, roof rise, wall colour, storeys, ground row]
const HOUSES = [
  [10.9, 19.2, 12.2, 15.8, 6.5, 0xa79c88, 3, 'portal'],     // Wolflin's house, the Gothic main portal
  [2.5, 10.9, 12.6, 16.6, 6.8, 0xb8ad97, 3, 'window'],       // Kříž's house: PRAGA CAPUT REGNI
  [-8.3, 2.5, 13.1, 15.4, 6.2, 0xd3a991, 3, 'shop'],          // Mikeš's house
  [-14.2, -8.3, 13.7, 14.6, 6.0, 0xd9c48f, 3, 'shop'],        // U Kohouta
  [-33.2, -14.2, 14.8, 14.2, 6.6, 0xe0d5bd, 3, 'arcade'],     // U Minuty, round the corner
];
const BACK = -7.4;

export function buildRadnice(kit) {
  const F = frame(kit);
  kit.floodFn = (x, y) => (y < 16 ? 0.55 : 0.2);
  for (const [i, [u0, u1, vf, H, rise, hex, n, ground]] of HOUSES.entries()) {
    const sH = (H - 4.4) / n;
    const rows = [];
    for (let k = 0; k < n; k++) rows.push({ y: 4.6 + k * sH, h: Math.min(2.2, sH - 1.0), w: 1.25, glow: 0.4, hex: PANE });
    const g = ground === 'portal' ? [{ y: 0, h: 3.6, w: 2.0, arch: 2, door: true, rev: 0.45 }]
      : ground === 'arcade' ? [{ y: 0, h: 3.3, w: 2.6, arch: 1, hex: 0x2a2520, kind: K.stone, rev: 0.7 }]
        : [{ y: 0.4, h: 2.6, w: 1.6, arch: 1, glow: 0.6, hex: 0x3b4652 }];
    const vb = u0 < -30 ? -14.8 : BACK;
    kit.set(hex, K.plaster);
    F.box(u0, u1, vb, vf, 0, H, {
      f: { pitch: ground === 'arcade' ? 3.4 : 2.7, inset: 0.6, rows: [...g, ...rows], seed: 40 + i },
      l: u0 < -30 ? { pitch: 3.2, inset: 1, rows: [...g, ...rows], seed: 50 } : true,
      b: { pitch: 3.0, inset: 0.8, rows, seed: 60 + i }, r: true,
    }, false);
    // a cornice, and the red roof with its gables against the neighbours
    kit.set(0xcfc5b0, K.plaster);
    F.box(u0, u1, vf - 0.05, vf + 0.3, H - 0.4, H, null, true, true);
    kit.set(TILE, K.tile);
    F.roof(u0, u1, vb, vf, H, H + rise, { over: 0.3, gableHex: hex });
    if (ground === 'window') {
      // the Renaissance window of 1520 and its inscription band
      const S = F.sub((u0 + u1) / 2, vf);
      kit.set(0xcfc3a8, K.stone); S.slab(rect(-2.3, 6.9, 2.3, 10.6), 0, 0.18);
      kit.set(0x2a2f36, K.glass); S.slab(rect(-1.9, 7.6, 1.9, 10.2), 0.18, 0.2);
      kit.set(0x8c2b22, K.metal); S.slab(rect(-2.3, 6.5, 2.3, 6.9), 0, 0.2);
      kit.set(GOLD, K.metal); S.slab(rect(-1.9, 6.62, 1.9, 6.78), 0.2, 0.22);
    }
    if (ground === 'arcade') {
      // the sgraffito: dark bands framing the storeys
      const S = F.sub((u0 + u1) / 2, vf), half = (u1 - u0) / 2;
      kit.set(0x6a5644, K.plaster);
      for (let k = 0; k <= n; k++) S.slab(rect(-half, 4.2 + k * sH - 0.12, half, 4.2 + k * sH + 0.12), 0, 0.03);
    }
  }
  // behind the tower: the wing to the north, and its roof
  kit.set(0xb0a690, K.plaster);
  const wing = { pitch: 2.8, inset: 0.8, rows: [{ y: 4.6, h: 2, w: 1.2, glow: 0.35, hex: PANE }, { y: 8.8, h: 2, w: 1.2, glow: 0.35, hex: PANE }], seed: 70 };
  F.box(19.2, 33.9, -5.8, TV0, 0, 15, { b: wing, l: false, r: { ...wing, seed: 71 }, f: true }, false);
  kit.set(TILE, K.tile);
  F.roof(19.2, 33.9, -5.8, TV0, 15, 19.5, { over: 0.3, hip1: 3.3, gableHex: 0xb0a690 });
}

// what is solid: each part to the top of its walls
const ring = (u0, u1, v0, v1) => { const F = frame(null); return F.ring(u0, u1, v0, v1); };
export function radniceSolids() {
  const out = [];
  for (const [u0, u1, vf, H] of HOUSES) out.push({ ring: ring(u0, u1, u0 < -30 ? -14.8 : BACK, vf), holes: null, top: H, bot: 0 });
  out.push({ ring: ring(19.2, 33.9, -5.8, TV0), holes: null, top: 15, bot: 0 });
  return out;
}
export const vezSolids = () => [{ ring: ring(TU0, TU1, TV0, TV1), holes: null, top: GALLERY, bot: 0 }];
export const orlojSolids = () => [{ ring: ring(TUC - 4.6, TUC + 4.6, TV1, 13.9), holes: null, top: 15.4, bot: 0 }];
export const kapleSolids = () => [{ ring: ring(30.3, 35.4, 0.8, 11.7), holes: null, top: 14.6, bot: 0 }];
export const arkyrSolids = () => [{ ring: ring(33.0, 36.9, 3.9, 7.7), holes: null, top: 15.6, bot: 8.2 }];
