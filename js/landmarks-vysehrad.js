// ---- landmarks-vysehrad.js: the basilica of St Peter and St Paul at Vyšehrad ----
// Rebuilt Neo-Gothic by Josef Mocker (1885 to 1887) and given its two west
// towers by František Mikš in 1902 to 1903: the dark twin spires of openwork
// stone, 58 m, that stand over the river on the Vyšehrad rock and close the
// view south from every embankment of the Old and New Town. A nave with
// aisles under one steep slate roof, a polygonal apse to the east, a rose
// over the west portal between the towers, a little spire on the ridge.
//
// Frame: fitted to the footprint (tile -20_-1, way 24376643), front (v+)
// west, u+ south. The body is centred on u = 1.

import { K } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { circle, needle } from './landmarks-parts.js';
import { stoneNeedle } from './landmarks-prahaparts.js';

const STONE = 0x7b766e, TOWER = 0x5f5b55, SPIRE = 0x4b4b47, SLATE = 0x3d4246, PANE = 0x2e3742;
const UC = 1, NAVE = [UC - 7, UC + 7], WALL_H = 12, NAVE_H = 19, RIDGE = 30;
const TOWERS = [[-13.4, -6.6], [8.4, 15.2]], TW_V = [20.5, 27.6], TW_H = 38, SPIRE_TIP = 58;
const APSE = -22;

export function vysehradFrame(kit, f) { return fitFrame(kit, f.o, -1, 0).F; }

export function buildVysehrad(kit, f) {
  const F = vysehradFrame(kit, f);
  kit.floodFn = (x, y) => (y < 30 ? 0.75 : 0.6);
  const lancet = (h, w = 1.8) => ({ y: 2.6, h, w, arch: 2, hex: PANE, glow: 0.15, rev: 0.25, nx: 2, ny: 5 });
  // aisles and chapels on the real outline
  kit.set(STONE, K.stone);
  kit.ringWalls(f.o, 0, WALL_H, (e) => (e.len < 3.5 ? null : { pitch: 4.6, inset: 0.5, rows: [lancet(WALL_H - 5)], seed: e.i }));
  kit.set(SLATE, K.slate);
  kit.cap(f.o, null, WALL_H, true);
  // the clerestory and the steep roof, hipped over the apse
  const cler = { pitch: 4.6, inset: 1, rows: [{ y: 1.4, h: NAVE_H - WALL_H - 2.6, w: 2.0, arch: 2, hex: PANE, glow: 0.12, rev: 0.3, nx: 2, ny: 3 }], seed: 3 };
  kit.set(STONE, K.stone);
  F.box(NAVE[0], NAVE[1], APSE, TW_V[0], WALL_H, NAVE_H, { l: cler, r: cler, f: false }, false);
  kit.set(SLATE, K.slate);
  F.roof(NAVE[0], NAVE[1], APSE, TW_V[0], NAVE_H, RIDGE, { alongV: true, hip0: 6, over: 0.4 });
  const [rx, rz] = F.xz(UC, -14);
  needle(kit, rx, rz, RIDGE - 2.5, 3.2, 0.9, 37, 0x3b5a52);
  // the west front between the towers: gable, rose, portal
  kit.set(STONE, K.stone);
  F.box(TOWERS[0][1], TOWERS[1][0], TW_V[0], TW_V[1] - 0.4, 0, NAVE_H + 1, { f: true, l: false, r: false, b: false }, false);
  const G = F.sub(UC, TW_V[1] - 0.4);
  G.slab([[-7.5, NAVE_H + 1], [7.5, NAVE_H + 1], [0, NAVE_H + 9]], -0.6, 0.3);
  kit.set(0x8f8a80, K.stone);
  G.slab(circle(0, 14, 3.4, 14), 0, 0.2);
  kit.set(0x283245, K.glassDark);
  G.slab(circle(0, 14, 2.8, 14), 0.2, 0.26);
  kit.set(0x2a2420, K.wood);
  G.slab([[-1.8, 0], [1.8, 0], [1.8, 5], [0, 7.4], [-1.8, 5]], 0, 0.15);
  // the two towers and their openwork spires
  const belfry = { cols: 2, rows: [{ y: 8, h: 6, w: 1.4, arch: 2, hex: PANE, glow: 0.1, rev: 0.25 },
    { y: 25, h: 8.5, w: 1.6, arch: 2, hex: 0x1d1f22, kind: K.wood, rev: 0.5 }], seed: 9 };
  for (const [a, b] of TOWERS) {
    kit.set(TOWER, K.stone);
    F.box(a, b, TW_V[0], TW_V[1], 0, TW_H, { f: belfry, l: belfry, r: belfry, b: true }, true);
    kit.set(STONE, K.stone);
    F.box(a - 0.3, b + 0.3, TW_V[0] - 0.3, TW_V[1] + 0.3, TW_H - 0.8, TW_H, null, true, true);
    const um = (a + b) / 2, vm = (TW_V[0] + TW_V[1]) / 2;
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [x, z] = F.xz(um + du * 3.0, vm + dv * 3.0);
      stoneNeedle(kit, x, z, TW_H, 0.5, TW_H + 6, SPIRE, 4, 1);
    }
    const [x, z] = F.xz(um, vm);
    stoneNeedle(kit, x, z, TW_H, 3.2, SPIRE_TIP, SPIRE, 8, 4);
  }
}

/** Solid: the aisles to their walls, the nave to its clerestory, the towers. */
export function vysehradSolids(f, l) {
  const F = vysehradFrame(null, f);
  const box = (u0, u1, v0, v1, top) => ({ ring: F.ring(u0, u1, v0, v1), holes: null, top, bot: 0 });
  return [{ ring: f.o, holes: null, top: l.top, bot: 0 }, box(NAVE[0], NAVE[1], APSE, TW_V[0], NAVE_H),
    ...TOWERS.map(([a, b]) => box(a, b, TW_V[0], TW_V[1], TW_H))];
}

/** For the far skyline: the body, the roof, the two towers and spires. */
export function vysehradFar(kit, F) {
  kit.set(STONE, K.stone);
  F.box(-12.8, 15, APSE, TW_V[0], 0, WALL_H);
  F.box(NAVE[0], NAVE[1], APSE, TW_V[0], WALL_H, NAVE_H, null, false);
  kit.set(SLATE, K.slate);
  F.roof(NAVE[0], NAVE[1], APSE, TW_V[0], NAVE_H, RIDGE, { alongV: true, hip0: 6 });
  for (const [a, b] of TOWERS) {
    kit.set(TOWER, K.stone);
    F.box(a, b, TW_V[0], TW_V[1], 0, TW_H, null, true);
    const [x, z] = F.xz((a + b) / 2, (TW_V[0] + TW_V[1]) / 2);
    kit.set(SPIRE, K.stone);
    kit.lathe(x, z, [[3.2, TW_H], [0, SPIRE_TIP]], 8, Math.PI / 8);
  }
}
