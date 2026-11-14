// ---- landmarks-tyn.js: the Church of Our Lady before Týn and the Týn school ----
// WORKER SAFE. The other half of the Old Town Square's picture: a Gothic
// hall church (1350 to 1510) whose two west towers rise to 80 m, each ending
// in a steep black helmet bristling with needles (four corner turrets and four
// more half way up), the south one, Adam, a little wider than Eva to the north.
// Between them the west gable holds the gilt Madonna. From the square the
// church is half hidden behind the Týn school, two houses with a Gothic arcade
// on the ground floor and ornamental gables, so only the towers and the steep
// roof read over them.
//
// Both are drawn in one constant frame: the church's own rectangle with its
// front to the square (bearing 252.5 deg), u running north to south.

import { K } from './landmarkskit.js';
import { Frame } from './landmarksframe.js';
import { rect, GOLD } from './landmarks-parts.js';
import { gothicHelmet, slateNeedle, SLATE_DK } from './landmarks-gothic.js';

const O = [-95531.99, -6227.90], N = [-0.954, 0.301];
const frame = (kit) => new Frame(kit, O[0], O[1], N[0], N[1]);
const H = 20, RIDGE = 45, WEST = 28.2, EAST = -26;
const STONE = 0x8b8172, STONE_DK = 0x6f675b, PANE = 0x2d3640;
// the towers: Eva to the north (u negative), Adam to the south, a touch wider
const TOWERS = [[-17.6, -8.3], [2.4, 12.3]];
const TV0 = 19.4, TV1 = 30.3, GAL = 48, EAVES = 50.5, PEAK = 77, TIP = 80;

export function buildTyn(kit, f) {
  const F = frame(kit);
  kit.floodFn = (x, y) => (y < H ? 0.55 : y < EAVES ? 0.9 : 0.75);
  // ---- the walls on the real outline: tall lancets on every long edge,
  // the stubs of the buttresses left blank
  kit.set(STONE, K.stone);
  kit.ringWalls(f.o, 0, H, (e) => (e.len > 3.4
    ? { cols: Math.max(1, Math.round(e.len / 5.2)), inset: 0.8, rows: [{ y: 3.5, h: H - 7, w: 1.8, arch: 2, hex: PANE, glow: 0.25, rev: 0.35 }], seed: e.i }
    : null));
  kit.set(STONE_DK, K.stone);
  kit.cap(f.o, null, H, true);
  // ---- the great roof: steep and black, hipped round the apses in the east
  kit.set(SLATE_DK, K.slate);
  F.roof(-17.8, 12.5, EAST, WEST - 0.3, H, RIDGE, { alongV: true, hip0: 11, over: 0.4 });
  // the west gable between the towers, the Madonna in it
  kit.set(STONE, K.stone);
  const gm = (TOWERS[0][1] + TOWERS[1][0]) / 2;   // the gable's middle
  F.slab([[-17.8 - 0.4, H], [12.5 + 0.4, H], [(-17.8 + 12.5) / 2, RIDGE + 0.4]], WEST - 0.5, WEST);
  const S = F.sub(gm, WEST);
  kit.set(STONE_DK, K.stone);
  S.slab([[-2.2, 24], [2.2, 24], [2.2, 33], [0, 35.5], [-2.2, 33]], 0, 0.2);
  kit.set(GOLD, K.metal);
  S.slab([[-0.9, 25.2], [0.9, 25.2], [0.7, 28.5], [1.0, 30.6], [0.5, 31.6], [0.35, 32.4], [0, 32.8], [-0.35, 32.4], [-0.5, 31.6], [-1.0, 30.6], [-0.7, 28.5]], 0.2, 0.45);
  S.slab(rect(-1.3, 32.7, 1.3, 33.0), 0.2, 0.45);
  // the great west window under it
  kit.set(0x23292f, K.glassDark);
  S.slab([[-1.8, 9], [1.8, 9], [1.8, 18.5], [0, 21.5], [-1.8, 18.5]], 0, 0.06);

  // ---- the towers: square shafts to the gallery, then the helmets
  for (const [i, [u0, u1]] of TOWERS.entries()) {
    const hu = (u1 - u0) / 2, hv = (TV1 - TV0) / 2, uc = (u0 + u1) / 2, vc = (TV0 + TV1) / 2;
    const T = F.sub(uc, vc);
    const lan = (y, h, w) => ({ y, h, w, arch: 2, hex: PANE, glow: 0.12, rev: 0.35 });
    const face = { cols: 2, inset: 1.6, rows: [lan(24, 4.2, 1.2), lan(31, 4.2, 1.2), lan(39, 5.5, 1.5)], seed: 80 + i };
    kit.set(STONE, K.stone);
    T.box(-hu, hu, -hv, hv, H - 2, GAL - 0.9, { f: face, b: face, l: face, r: face }, false);
    // buttresses up the corners, stepping back twice
    kit.set(STONE_DK, K.stone);
    for (const su of [-1, 1]) for (const sv of [-1, 1]) {
      const cu = su * hu, cv = sv * hv;
      T.box(cu - (su > 0 ? 0.2 : 1.1), cu + (su > 0 ? 1.1 : 0.2), cv - (sv > 0 ? 0.2 : 1.1), cv + (sv > 0 ? 1.1 : 0.2), 0, 30, null, true);
      T.box(cu - (su > 0 ? 0.2 : 0.6), cu + (su > 0 ? 0.6 : 0.2), cv - (sv > 0 ? 0.2 : 0.6), cv + (sv > 0 ? 0.6 : 0.2), 30, GAL - 1.2, null, true);
    }
    gothicHelmet(kit, F, uc, vc, hu, hv, GAL, EAVES, {
      over: 0.6, stone: STONE, roofHex: 0x26292e, rise: PEAK, tip: TIP, turretR: 0.85, turretTop: 63, lucarnes: 2,
    });
    // the second ring of needles half way up each side of the helmet
    for (const [du, dv] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
      const yb = 58, k = 1 - (yb - EAVES) / (PEAK - EAVES) * 0.92;
      const [x, z] = T.xz(du * (hu + 0.25) * k, dv * (hv + 0.25) * k);
      slateNeedle(kit, x, z, yb, 2.2, 0.5, 69, 0x26292e);
    }
  }
}

/** The Týn school before the church: an arcade on the square, two ornamental gables over it. */
export function buildTynskaSkola(kit) {
  const F = frame(kit);
  kit.floodFn = (x, y) => (y < 14 ? 0.45 : 0.25);
  const front = 58.3, v0 = 43.7, E = 13.2;
  const houses = [[-16.4, -7.0, 0xe2d6bb], [-7.0, 2.8, 0xd6c49d]];
  for (const [i, [u0, u1, hex]] of houses.entries()) {
    kit.set(hex, K.plaster);
    const rows = [{ y: 5.0, h: 2.1, w: 1.2, glow: 0.4, hex: PANE }, { y: 9.0, h: 2.1, w: 1.2, glow: 0.4, hex: PANE }];
    F.box(u0, u1, v0, front, 0, E, {
      f: { cols: 3, inset: 0.4, rows: [{ y: 0, h: 3.6, w: 2.5, arch: 2, hex: 0x2a2520, kind: K.stone, rev: 0.8 }, ...rows], seed: 90 + i },
      l: i === 0 ? { pitch: 3, inset: 1, rows, seed: 92 } : false, r: i === 1 ? { pitch: 3, inset: 1, rows, seed: 93 } : false, b: true,
    }, false);
    kit.set(0x9c4a36, K.tile);
    F.roof(u0, u1, v0, front - 0.4, E, E + 6, { alongV: true, over: 0.25 });
    // the gable: stepped in the Venetian manner, crowned with little pinnacles
    const um = (u0 + u1) / 2, w = (u1 - u0) / 2;
    kit.set(hex, K.plaster);
    F.slab([[u0, E], [u1, E], [u1, E + 2.3], [um + w * 0.62, E + 2.3], [um + w * 0.62, E + 4.6], [um + w * 0.3, E + 4.6],
      [um + w * 0.3, E + 7.4], [um - w * 0.3, E + 7.4], [um - w * 0.3, E + 4.6], [um - w * 0.62, E + 4.6], [um - w * 0.62, E + 2.3], [u0, E + 2.3]], front - 0.45, front);
    const S = F.sub(um, front);
    kit.set(0xcfc3a6, K.stone);
    for (const [u, y] of [[-w, E + 2.3], [w, E + 2.3], [-w * 0.62, E + 4.6], [w * 0.62, E + 4.6], [-w * 0.3, E + 7.4], [w * 0.3, E + 7.4]])
      S.slab([[u - 0.18, y], [u + 0.18, y], [u, y + 1.2]], -0.3, 0.05);
    kit.set(PANE, K.glass);
    S.slab([[-0.5, E + 3.0], [0.5, E + 3.0], [0.5, E + 4.2], [0, E + 4.6], [-0.5, E + 4.2]], 0, 0.04);
  }
  // the lower houses behind, against the church
  kit.set(0xd2c3a3, K.plaster);
  F.box(-18.3, -5.6, 30.5, v0, 0, 9.5, { l: { pitch: 3, inset: 1, rows: [{ y: 1, h: 2, w: 1.1, glow: 0.3, hex: PANE }, { y: 5.2, h: 2, w: 1.1, glow: 0.3, hex: PANE }], seed: 95 }, f: false }, false);
  kit.set(0x9c4a36, K.tile);
  F.roof(-18.3, -5.6, 30.5, v0, 9.5, 13.5, { alongV: true, over: 0.2, hip0: 2 });
}

const ring = (u0, u1, v0, v1) => frame(null).ring(u0, u1, v0, v1);
export function tynSolids(f) {
  return [{ ring: f.o, holes: null, top: H, bot: 0 },
    ...TOWERS.map(([u0, u1]) => ({ ring: ring(u0, u1, TV0, TV1), holes: null, top: GAL - 1, bot: 0 }))];
}
export const skolaSolids = () => [{ ring: ring(-16.4, 2.8, 43.7, 58.3), holes: null, top: 13.2, bot: 0 },
  { ring: ring(-18.3, -5.6, 30.5, 43.7), holes: null, top: 9.5, bot: 0 }];
