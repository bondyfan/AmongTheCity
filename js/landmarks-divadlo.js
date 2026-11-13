// ---- landmarks-divadlo.js: Východočeské divadlo ----
// Antonín Balšánek's Art Nouveau theatre of 1909 looks north over náměstí
// Republiky: a cream front with one great round-arched window over three
// doors and a balcony, two pylons carrying bronze figures either side of it,
// a mosaic lunette after Aleš on each flank, the auditorium behind under a
// dark hipped roof and the plain fly tower rising at the back.
//
// The footprint is symmetrical, so everything is a box in its own frame:
// u along the front (west to the right of somebody facing it), v north.

import { K, prism } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { rect, COPPER, GOLD } from './landmarks-parts.js';

const WALL = 0xe9dfc3, STONE = 0xd3c9ae, ROOF = 0x4d5457, PANE = 0x4a5a6a, BRONZE = 0x4c5b4a;
const HINT = [-0.35, -0.94];                          // the front looks north over the square
const STAGE = [-13.5, 13.5, -21.2, -4.9], STAGE_H = 21.5;   // the fly tower: [u0, u1, v0, v1] and its height

function lunette(F, uc, y, r, v) {
  const pts = [];
  for (let i = 0; i <= 8; i++) { const t = Math.PI * i / 8; pts.push([uc + Math.cos(t) * r, y + Math.sin(t) * r]); }
  return F.slab(pts, v, v + 0.07);
}

export function buildDivadlo(kit, f) {
  const { F } = fitFrame(kit, f.o, HINT[0], HINT[1]);
  kit.floodFn = (x, y) => (y < 17 ? 0.6 - 0.15 * (y / 17) : 0.25);
  const two = (y0) => [{ y: y0, h: 2.5, w: 1.5, hex: PANE, glow: 0.4 }, { y: y0 + 5.0, h: 3.2, w: 1.6, arch: 1, hex: PANE, glow: 0.5 }];
  const FH = 13.2, AH = 14.6, SH = STAGE_H;

  // ---- the foyer block across the front -----------------------------------
  kit.set(WALL, K.plaster);
  const flank = { cols: 2, inset: 0.6, rows: [{ y: 1.1, h: 2.6, w: 1.5, hex: PANE, glow: 0.5 }], seed: 2 };
  const sideF = { cols: 2, inset: 0.6, rows: two(1.1), seed: 3 };
  F.box(-14.7, 14.6, 10.9, 20.0, 0, FH, { f: flank, l: sideF, r: sideF, b: true }, false);
  kit.set(ROOF, K.slate);
  F.roof(-14.7, 14.6, 10.9, 20.0, FH, FH + 3.6, { hip0: 4.5, hip1: 4.5, over: 0.4 });
  // a string course, a cornice and the two mosaics on the flanks
  kit.set(STONE, K.stone);
  F.slab(rect(-14.8, 4.5, 14.7, 4.9), 20.0, 20.14);
  F.slab(rect(-14.9, FH - 0.5, 14.8, FH + 0.1), 19.9, 20.4);
  for (const uc of [-10.6, 10.6]) {
    kit.set(GOLD, K.metal); lunette(F, uc, 6.4, 2.75, 20.0);
    kit.set(0x3d6f8f, K.plaster); lunette(F, uc, 6.5, 2.45, 20.07);
    kit.set(0xb9853f, K.plaster); F.slab(rect(uc - 1.5, 6.5, uc + 1.5, 7.5), 20.14, 20.17);
  }

  // ---- the centre: three doors, the balcony, the great window --------------
  const cu = 6.0, cv = 21.8, CH = 17.2;
  kit.set(WALL, K.plaster);
  F.face('f', -cu, cu, 20.0, cv, 0, 4.5, { cols: 3, inset: 0.9, rows: [{ y: 0.15, h: 3.3, w: 2.2, arch: 1, door: true, rev: 0.3 }] });
  F.face('f', -cu, cu, 20.0, cv, 4.5, CH, { cols: 1, rows: [{ y: 0.8, h: 9.0, w: 8.2, arch: 1, hex: 0x52636f, glow: 1, rev: 0.35, nx: 5, ny: 5 }], seed: 1 });
  F.face('l', -cu, cu, 20.0, cv, 0, CH); F.face('r', -cu, cu, 20.0, cv, 0, CH);
  F.flat(-cu, cu, 18.0, cv, CH, true);
  F.face('b', -cu, cu, 18.0, cv, FH, CH); F.face('l', -cu, cu, 18.0, 20.0, FH, CH); F.face('r', -cu, cu, 18.0, 20.0, FH, CH);
  // the attic over it, with the town's arms
  kit.set(WALL, K.plaster);
  F.slab([[-cu, CH], [cu, CH], [cu, CH + 1.2], [3.4, CH + 1.2], [2.2, CH + 3.3], [-2.2, CH + 3.3], [-3.4, CH + 1.2], [-cu, CH + 1.2]], cv - 0.6, cv);
  kit.set(GOLD, K.metal); F.slab(rect(-1.1, CH + 0.9, 1.1, CH + 2.8), cv, cv + 0.08);
  kit.set(STONE, K.stone);
  F.slab(rect(-cu - 0.2, CH - 0.45, cu + 0.2, CH + 0.1), cv - 0.1, cv + 0.35);
  // the balcony and its balustrade
  F.box(-5.0, 5.0, cv, cv + 1.3, 4.35, 4.65, null, true, true);
  F.box(-5.0, 5.0, cv + 1.18, cv + 1.3, 4.65, 5.55);
  F.box(-5.0, -4.88, cv, cv + 1.3, 4.65, 5.55); F.box(4.88, 5.0, cv, cv + 1.3, 4.65, 5.55);

  // ---- the two pylons and their bronzes -------------------------------------
  for (const uc of [-7.5, 7.5]) {
    kit.set(WALL, K.plaster);
    F.box(uc - 1.4, uc + 1.4, 19.2, 21.7, 0, 19.4, { f: { cols: 1, rows: [{ y: 6.2, h: 3.4, w: 0.9, arch: 1, hex: PANE }, { y: 12.4, h: 2.6, w: 0.9, arch: 1, hex: PANE }] } }, false);
    kit.set(STONE, K.stone);
    F.box(uc - 1.6, uc + 1.6, 19.0, 21.9, 19.4, 19.9, null, true, true);
    kit.set(COPPER, K.copper);
    F.pyramid(uc - 1.4, uc + 1.4, 19.2, 21.7, 19.9, 21.0, 0.4);
    const [x, z] = F.xz(uc, 20.45);
    kit.set(BRONZE, K.metal);
    kit.lathe(x, z, [[0.55, 21.0], [0.4, 22.0], [0.5, 22.6], [0.28, 23.3], [0.3, 23.6], [0, 23.9]], 6);
    F.slab([[uc - 1.5, 23.4], [uc - 0.3, 22.4], [uc - 0.3, 23.0]], 20.35, 20.5);        // a wing each side
    F.slab([[uc + 0.3, 22.4], [uc + 1.5, 23.4], [uc + 0.3, 23.0]], 20.35, 20.5);
  }

  // ---- the house behind: auditorium, stairs, stage ---------------------------
  const aud = { cols: 4, inset: 0.8, rows: [...two(1.1), { y: 10.6, h: 1.8, w: 1.5, hex: PANE, glow: 0.2 }], seed: 5 };
  kit.set(WALL, K.plaster);
  F.box(-12.7, 12.6, -5.0, 10.9, 0, AH, { l: aud, r: aud, f: false, b: false }, false);
  kit.set(ROOF, K.slate);
  F.roof(-12.7, 12.6, -5.0, 10.9, AH, AH + 5.2, { alongV: true, hip1: 9, over: 0.4 });
  const plain = (cols, seed) => ({ cols, inset: 1, rows: [{ y: 1.3, h: 2.2, w: 1.3, hex: PANE, glow: 0.3 }, { y: 6.3, h: 2.2, w: 1.3, hex: PANE, glow: 0.3 }], seed });
  kit.set(WALL, K.plaster);
  F.box(-14.8, 14.8, -19.3, -14.7, 0, 11.5, { l: plain(1, 7), r: plain(1, 8), f: true, b: true });
  F.box(-14.2, 14.2, -4.9, -0.3, 0, AH, { l: plain(1, 9), r: plain(1, 10) });
  F.box(...STAGE, 0, SH, { b: plain(5, 11), l: plain(3, 12), r: plain(3, 13) }, false);
  kit.set(STONE, K.stone);
  F.box(-13.7, 13.7, -21.4, -4.7, SH - 0.5, SH, null, false);
  kit.set(ROOF, K.slate);
  F.roof(...STAGE, SH, SH + 2.8, { hip0: 6, hip1: 6, over: 0.3 });
}

/** Solid as built: the house to the auditorium's eaves (l.top) and the fly tower over the stage. */
export function divadloSolids(f, l) {
  const { F } = fitFrame(null, f.o, HINT[0], HINT[1]);
  return [prism(f, l.top), { ring: F.ring(...STAGE), holes: null, top: STAGE_H, bot: 0 }];
}
