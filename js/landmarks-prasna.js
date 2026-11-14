// ---- landmarks-prasna.js: the Powder Tower and the Municipal House ----
// WORKER SAFE.
//   Prašná brána (1475, regothicised by Mocker 1876 to 1886): a 65 m gate
//   tower of sandstone gone black, Celetná running through its pointed
//   passage, its faces carved in bands of tracery and statues, a gallery at
//   44 m and a steep slate helmet with corner turrets. The tile lifts its
//   footprint to 10 m over a 13 m gap in Celetná (the passage way is not in
//   the tile); the entry is `lifted`, the model stands on the ground.
//   Obecní dům (1905 to 1912): the Art Nouveau wedge beside it, joined to the
//   tower by a little covered bridge. Its main front is the short side toward
//   náměstí Republiky, under a dome, with the half-round mosaic of the
//   Homage to Prague over the entrance and an iron and glass canopy before it.
//
// The car gap in Celetná is a road-graph matter (the passage way would have
// to be in the tile): the floor of the passage is paved and walked, the crowd
// goes through on a walk link (js/landmarks-walks.js), traffic still turns.

import { K } from './landmarkskit.js';
import { Frame, fitFrame } from './landmarksframe.js';
import { rect, circle, GOLD, COPPER } from './landmarks-parts.js';
import { gothicHelmet, figureOutline } from './landmarks-gothic.js';
import { paving } from './landmarks-passage.js';

const BLACK = 0x5b534a, BLACK_DK = 0x443e38, BLACK_LT = 0x766c60, PANE = 0x262b30;
// the passage runs along v (Celetná), the front (v+) to the Old Town in the west
const PB_HINT = [-0.956, -0.293];
const PB = { pu: 0.75, pw: 6.0, ph: 8.2, H: 44, hu: 6.9, hv: 7.1 };

export function buildPrasna(kit, f) {
  const { F } = fitFrame(kit, f.o, PB_HINT[0], PB_HINT[1]);
  kit.floodFn = (x, y) => (y < PB.H ? 0.95 - 0.15 * (y / PB.H) : 0.8);
  const { pu, pw, ph, H, hu, hv } = PB;
  // ---- the shaft, faced in bands: blind tracery panels, statue niches, windows
  const win = (y, h, w = 1.2) => ({ y, h, w, arch: 2, hex: PANE, glow: 0.1, rev: 0.3 });
  const side = { cols: 3, inset: 1.5, rows: [win(11, 3.2), win(20, 4.4, 1.4), win(30, 5.2, 1.6), win(38.5, 3.0)], seed: 1 };
  kit.set(BLACK, K.stone);
  for (const s of ['f', 'b']) {
    const sg = s === 'f' ? 1 : -1, v = sg * hv, [nx, nz] = F.dir(0, sg);
    const a = F.xz(-hu, v), b = F.xz(hu, v), c0 = F.xz(pu - pw / 2, v), c1 = F.xz(pu + pw / 2, v);
    const upper = { cols: 1, rows: [win(20, 4.4, 1.4), win(30, 5.2, 1.6)], seed: 2 };
    kit.wallGrid(a, c0, 0, H, nx, nz, upper);
    kit.wallGrid(c1, b, 0, H, nx, nz, upper);
    kit.wallGrid(c0, c1, 0, H, nx, nz, { cols: 1, rows: [{ y: 0, h: ph, w: pw - 0.02, arch: 2, open: true }, win(20, 4.4, 1.6), win(30, 5.2, 2.0)], seed: 3 });
  }
  F.face('l', -hu, hu, -hv, hv, 0, H, side);
  F.face('r', -hu, hu, -hv, hv, 0, H, side);
  kit.set(BLACK_DK, K.stone);
  F.tunnel(pu, pw, -hv, hv, ph, 2);
  if (kit.terrain) { kit.set(0x77736b, K.stone); paving(kit, F, pu - pw / 2, pu + pw / 2, -hv, hv, 0.05); }
  // corner buttresses, the round stair turrets of the outline, as octagonal shafts
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    const [x, z] = F.xz(su * (hu + 0.3), sv * (hv + 0.1));
    kit.set(BLACK_LT, K.stone);
    kit.lathe(x, z, [[0.75, 0], [0.75, H - 1.0], [0.55, H - 0.6], [0, H - 0.6]], 8, Math.PI / 8);
  }
  // string courses and the carved bands of the two passage fronts
  kit.set(BLACK_LT, K.stone);
  for (const y of [9.6, 17.6, 27.8, 36.8]) F.box(-hu - 0.15, hu + 0.15, -hv - 0.15, hv + 0.15, y, y + 0.4, null, true, true);
  for (const sg of [1, -1]) {
    const S = F.sub(pu * sg, sg * hv, 0, sg > 0 ? 0 : Math.PI);
    // the gable over the arch, with a pinnacle either side
    kit.set(BLACK_LT, K.stone);
    S.slab([[-pw / 2 - 0.6, ph - 0.2], [pw / 2 + 0.6, ph - 0.2], [0, ph + 3.6]], 0, 0.3);
    kit.set(0x8a7f70, K.stone);
    for (let i = -2; i <= 2; i++) S.slab(figureOutline(i * 2.2, 12.6, 2.0), 0, 0.3);
    for (let i = -1; i <= 1; i++) S.slab(figureOutline(i * 3.0, 22.6, 2.4), 0, 0.32);
  }
  gothicHelmet(kit, F, 0, 0, hu, hv, H, H + 1.8, {
    over: 0.7, stone: BLACK, roofHex: 0x2f3236, rise: 62, tip: 65, turretR: 0.85, turretTop: 54, lucarnes: 2,
  });
}

export function prasnaSolids(f, l) {
  const { F } = fitFrame(null, f.o, PB_HINT[0], PB_HINT[1]);
  const { pu, pw, ph, hu, hv } = PB, half = pw / 2;
  const piece = (a, b, bot) => ({ ring: F.ring(a, b, -hv, hv), holes: null, top: l.top, bot });
  return [piece(-hu, pu - half, 0), piece(pu + half, hu, 0), piece(pu - half, pu + half, ph)];
}

/** The covered bridge between the tower and the Municipal House, 6 m up (the tile's own `bridge`). */
export function buildPrasnaSpoj(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, 0, 1);
  kit.floodFn = () => 0.6;
  const rows = [{ y: 1.4, h: 2.2, w: 1.1, glow: 0.5, hex: PANE }, { y: 4.8, h: 2.0, w: 1.0, glow: 0.4, hex: PANE }];
  kit.set(0xd8cbaa, K.plaster);
  F.box(-hu, hu, -hv, hv, 6.3, 14, { f: { pitch: 2.4, inset: 0.5, rows }, b: { pitch: 2.4, inset: 0.5, rows }, l: true, r: true }, true, true);
  kit.set(0x6e7275, K.slate);
  F.roof(-hu, hu, -hv, hv, 14, 16.5, { over: 0.3, gableHex: 0xd8cbaa });
}

// ---- the Municipal House --------------------------------------------------
const OD_HINT = [0.6, 0.8];
const OD_H = 16.5, OCHRE = 0xd9c595, OCHRE_DK = 0xbca878;

export function buildObecniDum(kit, f) {
  const { F } = fitFrame(kit, f.o, OD_HINT[0], OD_HINT[1]);
  kit.floodFn = (x, y) => (y < OD_H ? 0.5 : 0.7);
  const rows = [{ y: 0.6, h: 3.0, w: 2.0, arch: 1, glow: 0.6, hex: 0x3a444e }, { y: 5.4, h: 2.8, w: 1.4, glow: 0.5, hex: PANE },
    { y: 9.6, h: 2.6, w: 1.4, glow: 0.45, hex: PANE }, { y: 13.4, h: 1.6, w: 1.0, arch: 1, glow: 0.3, hex: PANE }];
  kit.set(OCHRE, K.plaster);
  kit.ringWalls(f.o, 0, OD_H, (e) => (e.len > 3.2 ? { pitch: 3.3, inset: 0.6, rows, seed: e.i } : null));
  // the cornice, an attic and the roof: a mansard in the grey-green of the tile
  // (the mansard is laid on the outline without its jogs: offsetRing wants a convex-ish ring)
  // (a vertex is kept when one of its two edges is a real wall, over 4 m: the
  // same answer whichever vertex the ring starts at)
  const n = f.o.length, len = (i) => { const a = f.o[i % n], b = f.o[(i + 1) % n]; return Math.hypot(b[0] - a[0], b[1] - a[1]); };
  const plain = f.o.filter((p, i) => len(i) > 4 || len(i + n - 1) > 4);
  kit.set(OCHRE_DK, K.plaster);
  const out = kit.offsetRing(plain, -0.35);
  kit.ringWalls(out, OD_H - 0.5, OD_H);
  kit.cap(out, null, OD_H - 0.5, false);
  const inner = kit.offsetRing(plain, 3.2);
  kit.set(0x7d8281, K.slate);
  for (let i = 0; i < out.length; i++) {
    const a = out[i], b = out[(i + 1) % out.length], c = inner[(i + 1) % out.length], d = inner[i];
    const mx = (a[0] + b[0]) / 2 - (c[0] + d[0]) / 2, mz = (a[1] + b[1]) / 2 - (c[1] + d[1]) / 2;
    kit.quad([a[0], OD_H, a[1]], [b[0], OD_H, b[1]], [c[0], OD_H + 3.6, c[1]], [d[0], OD_H + 3.6, d[1]], mx, 0.9, mz);
  }
  kit.cap(inner, null, OD_H + 3.6, true);

  // ---- the main front: the short side between (33.4, 8.3) and (25.9, 19.4)
  const A = F.xz(33.4, 8.3), B = F.xz(25.9, 19.4), cx = (A[0] + B[0]) / 2, cz = (A[1] + B[1]) / 2;
  const ex = B[0] - A[0], ez = B[1] - A[1], L = Math.hypot(ex, ez);
  // its outward normal: away from the footprint's middle
  let nx = ez / L, nz = -ex / L;
  if ((cx - F.ox) * nx + (cz - F.oz) * nz < 0) { nx = -nx; nz = -nz; }
  const M = new Frame(kit, cx, cz, nx, nz);
  const S = M.sub(0, 0.5);
  // the great arch and the half-round mosaic in it
  kit.set(OCHRE_DK, K.stone);
  S.slab([[-5.4, 0], [5.4, 0], [5.4, 17.0], [-5.4, 17.0]], -0.4, 0.15);
  // the half-round of the mosaic, framed by a gilt arch
  const MY = 11.6;
  kit.set(0xcfb27a, K.stone);
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI, b = (i + 1) / 8 * Math.PI;
    S.slab([[Math.cos(a) * 4.3, MY + Math.sin(a) * 4.3], [Math.cos(a) * 4.9, MY + Math.sin(a) * 4.9],
      [Math.cos(b) * 4.9, MY + Math.sin(b) * 4.9], [Math.cos(b) * 4.3, MY + Math.sin(b) * 4.3]], 0.15, 0.3);
  }
  const half = [];
  for (let i = 0; i <= 12; i++) { const a = i / 12 * Math.PI; half.push([Math.cos(a) * 4.3, MY + Math.sin(a) * 4.3]); }
  kit.set(0x3d6c8f, K.metal); S.slab([[4.3, MY], ...half.slice(1, -1), [-4.3, MY]], 0.15, 0.22);
  kit.set(GOLD, K.metal); S.slab(circle(0, MY + 1.7, 1.3, 12), 0.22, 0.28);
  kit.set(0x9e4b3a, K.metal); S.slab(rect(-3.2, MY + 0.2, 3.2, MY + 0.8), 0.22, 0.26);
  // the balcony and the entrance doors under it
  kit.set(0x2c2a27, K.metal); S.slab(rect(-4.4, 5.2, 4.4, 5.5), 0.15, 1.2);
  kit.set(0x3b2a1c, K.wood);
  for (const u of [-2.6, 0, 2.6]) S.slab([[u - 0.95, 0.2], [u + 0.95, 0.2], [u + 0.95, 3.8], [u, 4.5], [u - 0.95, 3.8]], 0.15, 0.2);
  // the statue groups on the attic either side
  kit.set(0x8c8a7d, K.stone);
  for (const u of [-4.6, 4.6]) S.slab(figureOutline(u, 17.0, 2.8, 0.3), -0.3, 0.3);
  // the dome behind the front, copper with gilt ribs and a lantern
  const [dx, dz] = M.xz(0, -7.5);
  kit.set(COPPER, K.copper);
  kit.lathe(dx, dz, [[6.0, OD_H + 2], [6.0, OD_H + 4.5], [5.6, OD_H + 7], [4.2, OD_H + 9.6], [2.2, OD_H + 11.4], [0.9, OD_H + 12]], 16);
  kit.set(GOLD, K.metal);
  kit.lathe(dx, dz, [[0.9, OD_H + 12], [0.9, OD_H + 13.4], [0.35, OD_H + 14.6], [0, OD_H + 15.6]], 8);
  kit.set(0xd2c08f, K.plaster);
  kit.lathe(dx, dz, [[6.3, OD_H], [6.3, OD_H + 2]], 16);
}
export const obecniSolids = (f) => [{ ring: f.o, holes: f.i ?? null, top: OD_H, bot: 0 }];

/** The iron and glass canopy over the main entrance (the tile's lifted `roof` piece, 9 m up). */
export function buildMarkyza(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, 0.8, 0.6);
  kit.floodFn = () => 0.7;
  kit.set(0x4a5a52, K.metal);
  F.box(-hu, hu, -hv, hv, 9.0, 9.3, null, true, true);
  kit.set(0xb7c7cc, K.metal);
  F.roof(-hu + 0.2, hu - 0.2, -hv + 0.2, hv - 0.2, 9.35, 10.0, { over: 0 });
  kit.set(GOLD, K.metal);
  F.box(-hu, hu, hv - 0.12, hv, 8.6, 9.0, null, false);
  // the iron ribs over the glass, and the lamps hanging under it
  kit.set(0x2b2c2d, K.metal);
  const n = 8;
  for (let i = 0; i <= n; i++) {
    const u = -hu + 0.2 + (2 * hu - 0.4) * i / n;
    F.box(u - 0.05, u + 0.05, -hv + 0.2, hv - 0.2, 9.35, 9.55, null, true);
  }
  for (const u of [-hu * 0.6, -hu * 0.2, hu * 0.2, hu * 0.6]) {
    const [x, z] = F.xz(u, hv * 0.4);
    kit.set(0x2b2c2d, K.metal);
    kit.lathe(x, z, [[0.03, 8.0], [0.03, 9.0]], 4);
    kit.set(0xf3dcaa, K.metal); kit.gl = 1;
    kit.lathe(x, z, [[0, 7.5], [0.22, 7.65], [0.22, 7.95], [0, 8.05]], 6);
  }
}
