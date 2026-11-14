// ---- landmarks-vit.js: the Cathedral of St Vitus, Wenceslas and Adalbert ----
// The Gothic choir of Matthias of Arras and Peter Parler (1344 to 1420) with
// its flying buttresses, and the nave and west front finished by Mocker and
// Hilbert in 1929: two 82 m stone spires over a rose window at the west end,
// the great south tower with its Renaissance gallery and green Baroque helmet
// (96.5 m) beside the Golden Gate, and one steep dark roof along the whole
// 124 m. From Charles Bridge it IS the castle: the spires and the helmet are
// what has to read, at 900 m and at night.
//
// Laid out in the frame of the footprint (tile -21_-2, relation 15317899):
// v runs along the axis with the west front at v = +62.8, u across it with
// the south side positive. The body is centred on u = -3 (the footprint is
// wider to the north, where the chapels are deeper).

import { K, prism } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { clockFace, circle, rect, needle, GOLD } from './landmarks-parts.js';
import { helmet, stoneNeedle, flyer } from './landmarks-prahaparts.js';

const STONE = 0x7e7a71, STONE_LT = 0x9a958a, ROOF = 0x46635a, PANE = 0x2f3a46, HELM = 0x5d9a83;
const HINT = [-0.93, 0.36];
const UC = -3;                                   // the axis of the body
const AISLE = 15, CLER = 33, RIDGE = 52;         // aisle walls, vault (33.2 m), ridge
const NAVE = [UC - 7, UC + 7];                    // the clerestory, 14 m across
const CHOIR_END = -50, WEST = 62.3;
const TOWERS = [[-19, -9], [3, 13]], TW_V = [51, WEST], TW_H = 56, SPIRE = 82;
const SOUTH = [15.5, 27.5, 9.5, 21.5], SOUTH_H = 56, SOUTH_TOP = 96.5;   // u0 u1 v0 v1

export function vitFrame(kit, f) { return fitFrame(kit, f.o, HINT[0], HINT[1]).F; }

export function buildVit(kit, f) {
  const F = vitFrame(kit, f);
  kit.floodFn = (x, y) => (y < 40 ? 0.9 - 0.004 * y : 0.75);
  const lancet = (h) => ({ y: 2.6, h, w: 2.4, arch: 2, hex: PANE, glow: 0.12, rev: 0.25, nx: 2, ny: 6 });
  // ---- the aisles and the ring of chapels, on the real outline -------------
  kit.set(STONE, K.stone);
  kit.ringWalls(f.o, 0, AISLE, (e) => (e.len < 4.5 ? null : { pitch: 6.2, inset: 0.8, rows: [lancet(AISLE - 5)], seed: e.i }));
  kit.set(ROOF, K.copper);
  kit.cap(f.o, null, AISLE, true);
  // ---- the clerestory, nave and choir in one run, and the transept ----------
  const clerestory = { pitch: 6.2, inset: 1.5, rows: [{ y: 3.5, h: CLER - AISLE - 6, w: 3.2, arch: 2, hex: PANE, glow: 0.1, rev: 0.35, nx: 3, ny: 8 }], seed: 3 };
  kit.set(STONE, K.stone);
  F.box(NAVE[0], NAVE[1], CHOIR_END, TW_V[0], AISLE, CLER, { l: clerestory, r: clerestory, f: false, b: false }, false);
  F.box(-26, 26, -4.5, 8.5, AISLE, CLER, { f: { cols: 3, rows: clerestory.rows }, b: { cols: 3, rows: clerestory.rows } }, false);
  // the choir ends in a polygon: the hip of the roof over a five-sided wall
  const apse = [F.xz(NAVE[0], CHOIR_END), F.xz(NAVE[0] + 2, CHOIR_END - 5), F.xz(UC, CHOIR_END - 7.5), F.xz(NAVE[1] - 2, CHOIR_END - 5), F.xz(NAVE[1], CHOIR_END)];
  for (let i = 0; i + 1 < apse.length; i++) {
    const a = apse[i], b = apse[i + 1], mx = (a[0] + b[0]) / 2 - F.xz(UC, CHOIR_END)[0], mz = (a[1] + b[1]) / 2 - F.xz(UC, CHOIR_END)[1];
    kit.wallGrid(a, b, AISLE, CLER, mx, mz, { cols: 1, rows: clerestory.rows, seed: 40 + i });
  }
  // ---- the roofs: steep, dark, all along; the transept crosses it ------------
  kit.set(ROOF, K.copper);
  F.roof(NAVE[0], NAVE[1], CHOIR_END, TW_V[0], CLER, RIDGE, { alongV: true, hip0: 7.5, over: 0.4 });
  F.roof(-26, 26, -4.5, 8.5, CLER, RIDGE - 2, { over: 0.4 });
  kit.set(STONE, K.stone);
  for (const u of [-26, 26]) {
    const G = F.sub(u, 2, 0, u > 0 ? Math.PI / 2 : -Math.PI / 2);
    G.slab([[-6.5, CLER], [6.5, CLER], [0, RIDGE - 1.4]], -0.2, 0.6);
    kit.set(PANE, K.glassDark);
    G.slab(circle(0, CLER - 7, 3.2, 12), 0.6, 0.75);
    kit.set(STONE, K.stone);
  }
  // the ridge turret over the crossing, gilt
  needle(kit, ...F.xz(UC, 2), RIDGE - 1.5, 3, 1.2, RIDGE + 13, 0x3f5f56);

  // ---- flying buttresses round the choir --------------------------------------
  kit.set(STONE_LT, K.stone);
  for (let v = CHOIR_END + 3; v <= -9; v += 6.5) {
    for (const [uP, uW] of [[-24.5, NAVE[0]], [17, NAVE[1]]]) {
      const s = uP < 0 ? -1 : 1;
      F.box(uP - 0.9 * s, uP + 0.9 * s, v - 0.9, v + 0.9, 0, 26);
      flyer(F, v, uP, uW, 24.5, 30.5);
      flyer(F, v, uP, uW, 18.5, 23.5, 0.55);
      const [x, z] = F.xz(uP, v);
      stoneNeedle(kit, x, z, 26, 0.75, 31.5, STONE_LT, 4, 1);
      kit.set(STONE_LT, K.stone);
    }
  }

  // ---- the west front: two towers, the rose and the gable between ----------
  const belfry = { cols: 2, rows: [{ y: 6, h: 9, w: 2.2, arch: 2, hex: PANE, glow: 0.1, rev: 0.3 },
    { y: 22, h: 10, w: 2.2, arch: 2, hex: PANE, glow: 0.08, rev: 0.3 },
    { y: 38, h: 12, w: 2.4, arch: 2, hex: 0x1d1f22, kind: K.wood, rev: 0.6 }], seed: 11 };
  kit.set(STONE, K.stone);
  for (const [a, b] of TOWERS) {
    F.box(a, b, TW_V[0], TW_V[1], 0, TW_H, { f: belfry, l: belfry, r: belfry, b: true }, true);
    kit.set(STONE_LT, K.stone);
    F.box(a - 0.4, b + 0.4, TW_V[0] - 0.4, TW_V[1] + 0.4, TW_H - 1.2, TW_H, null, true, true);
    const um = (a + b) / 2, vm = (TW_V[0] + TW_V[1]) / 2;
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [x, z] = F.xz(um + du * 4.3, vm + dv * 4.9);
      stoneNeedle(kit, x, z, TW_H, 0.7, TW_H + 8, STONE_LT, 4, 1);
    }
    const [x, z] = F.xz(um, vm);
    stoneNeedle(kit, x, z, TW_H, 4.4, SPIRE, STONE, 8, 4);
    kit.set(STONE, K.stone);
  }
  // the gable between the towers, the rose window and the portals
  const fv = TW_V[1];
  F.box(TOWERS[0][1], TOWERS[1][0], TW_V[0], fv - 0.6, AISLE, CLER + 2, { f: true, l: false, r: false, b: false }, false);
  const G = F.sub(UC, fv - 0.6);
  G.slab([[-6, CLER + 2], [6, CLER + 2], [0, CLER + 13]], -0.6, 0.4);
  kit.set(STONE_LT, K.stone);
  G.slab(circle(0, 26, 5.2, 16), 0, 0.25);
  kit.set(0x2b3445, K.glassDark);
  G.slab(circle(0, 26, 4.4, 16), 0.25, 0.32);
  kit.set(0x2a2420, K.wood);
  for (const u of [-6.6, 0, 6.6]) G.slab([[u - 1.7, 0], [u + 1.7, 0], [u + 1.7, 5.5], [u, 8.2], [u - 1.7, 5.5]], 0, 0.15);

  // ---- the great south tower -------------------------------------------------
  const [s0, s1, t0, t1] = SOUTH;
  const tall = { cols: 1, rows: [{ y: 18, h: 16, w: 4.4, arch: 2, hex: PANE, glow: 0.15, rev: 0.4, nx: 4, ny: 8 }], seed: 21 };
  kit.set(STONE, K.stone);
  F.box(s0, s1, t0, t1, 0, SOUTH_H, { f: tall, b: tall, r: tall, l: true }, false);
  // the Renaissance gallery: a jutting balustrade and a lighter storey
  kit.set(STONE_LT, K.stone);
  F.box(s0 - 0.8, s1 + 0.8, t0 - 0.8, t1 + 0.8, SOUTH_H, SOUTH_H + 1, null, true, true);
  F.merlons('f', s0 - 0.8, s1 + 0.8, t0 - 0.8, t1 + 0.8, SOUTH_H + 1, 1.1, 0.5, 0.7, 0.3);
  F.merlons('b', s0 - 0.8, s1 + 0.8, t0 - 0.8, t1 + 0.8, SOUTH_H + 1, 1.1, 0.5, 0.7, 0.3);
  F.merlons('l', s0 - 0.8, s1 + 0.8, t0 - 0.8, t1 + 0.8, SOUTH_H + 1, 1.1, 0.5, 0.7, 0.3);
  F.merlons('r', s0 - 0.8, s1 + 0.8, t0 - 0.8, t1 + 0.8, SOUTH_H + 1, 1.1, 0.5, 0.7, 0.3);
  kit.set(0xd8d0bc, K.plaster);
  F.box(s0 + 1, s1 - 1, t0 + 1, t1 - 1, SOUTH_H, SOUTH_H + 5, null, false);
  const [hx, hz] = F.xz((s0 + s1) / 2, (t0 + t1) / 2);
  kit.floodFn = () => 0.55;
  helmet(kit, hx, hz, SOUTH_H + 5, 6.2, SOUTH_TOP, HELM);
  kit.floodFn = (x, y) => (y < 40 ? 0.8 - 0.004 * y : 0.62);
  // two clocks on the south face, the upper one gilt
  const C = F.sub(s1 + 0.05, (t0 + t1) / 2, 0, Math.PI / 2);
  clockFace(kit, C, 44, 2.2);
  clockFace(kit, C, 50.5, 1.7, 0x1e3a5a);

  // ---- the Golden Gate: three arches under the gold mosaic ------------------
  const D = F.sub(29.2, 2, 0, Math.PI / 2);
  kit.set(STONE_LT, K.stone);
  for (const u of [-4.2, 0, 4.2]) D.slab([[u - 2.1, 0], [u - 1.6, 0], [u - 1.6, 6], [u - 2.1, 6]], 0, 1.2);
  D.slab(rect(-6.5, 6, 6.5, 7.2), 0, 1.4);
  kit.set(GOLD, K.metal);
  D.slab(rect(-5.5, 8, 5.5, 13.5), 0.1, 0.22);
  kit.set(0x8a2a22, K.plaster);
  D.slab(rect(-1.2, 9.2, 1.2, 12.6), 0.22, 0.28);
}

/** Solid as built: the aisles to their walls, the clerestory, the two west towers and the south tower. */
export function vitSolids(f, l) {
  const F = vitFrame(null, f);
  const box = (u0, u1, v0, v1, top) => ({ ring: F.ring(u0, u1, v0, v1), holes: null, top, bot: 0 });
  return [prism(f, l.top), box(NAVE[0], NAVE[1], CHOIR_END, TW_V[0], CLER), box(-26, 26, -4.5, 8.5, CLER),
    ...TOWERS.map(([a, b]) => box(a, b, TW_V[0], TW_V[1], TW_H)), box(SOUTH[0], SOUTH[1], SOUTH[2], SOUTH[3], SOUTH_H)];
}

/** For the far skyline (js/landmarksfar.js): the same silhouette in a few hundred triangles. */
export function vitFar(kit, F) {
  kit.set(STONE, K.stone);
  F.box(NAVE[0] - 8, NAVE[1] + 7, CHOIR_END - 8, WEST, 0, AISLE);
  F.box(NAVE[0], NAVE[1], CHOIR_END, TW_V[0], AISLE, CLER, null, false);
  F.box(-26, 26, -4.5, 8.5, AISLE, CLER, null, false);
  kit.set(ROOF, K.copper);
  F.roof(NAVE[0], NAVE[1], CHOIR_END, TW_V[0], CLER, RIDGE, { alongV: true, hip0: 7.5 });
  F.roof(-26, 26, -4.5, 8.5, CLER, RIDGE - 2, { gableHex: STONE, gableKind: K.stone });
  kit.set(STONE, K.stone);
  for (const [a, b] of TOWERS) {
    F.box(a, b, TW_V[0], TW_V[1], 0, TW_H, null, true);
    const [x, z] = F.xz((a + b) / 2, (TW_V[0] + TW_V[1]) / 2);
    kit.lathe(x, z, [[4.4, TW_H], [0, SPIRE]], 8, Math.PI / 8);
  }
  F.box(TOWERS[0][1], TOWERS[1][0], TW_V[0], TW_V[1] - 0.6, AISLE, CLER + 2, null, true);
  F.box(SOUTH[0], SOUTH[1], SOUTH[2], SOUTH[3], 0, SOUTH_H + 1, null, true);
  const [hx, hz] = F.xz((SOUTH[0] + SOUTH[1]) / 2, (SOUTH[2] + SOUTH[3]) / 2);
  kit.set(HELM, K.copper);
  const y = SOUTH_H + 1, h = SOUTH_TOP - y;
  kit.lathe(hx, hz, [[6.4, y], [6.2, y + h * 0.16], [3.2, y + h * 0.31], [2.6, y + h * 0.47], [3.0, y + h * 0.5], [1.2, y + h * 0.66], [0, SOUTH_TOP]], 8, Math.PI / 8);
}
