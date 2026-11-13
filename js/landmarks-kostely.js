// ---- landmarks-kostely.js: the three old churches and the bell tower ----
// None of them has a tower of its own, which is what makes the Pardubice
// skyline: three steep red roofs each carrying one green needle, and beside
// St Bartholomew a separate square bell tower.
//   sv. Bartoloměj (1507 to 1514): hall church of the Pernštejns, presbytery
//     to the east, a porch of 1912 before the west gable with a round chapel
//     on its north side.
//   Zvěstování Panny Marie: the former Minorite church, the same hand.
//   sv. Jan Křtitele: the small cemetery church by the main street.

import { K } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { church, onion, TILE, TILE_DK } from './landmarks-parts.js';

const WEST = [-0.95, 0.3];        // all three face a little south of west

export function buildBartolomej(kit, f) {
  const { F } = fitFrame(kit, f.o, WEST[0], WEST[1]);
  kit.floodFn = (x, y) => (y < 15 ? 0.62 : 0.1);
  church(kit, F, {
    nave: [-7.6, 8.4, -10.6, 12.6], H: 14.5, rise: 13.5, bays: 4,
    pres: [-5.4, 5.5, -22.0, -10.6], presH: 14.5, presRise: 10,
    vest: [-5.0, 5.5, 21.6, 7.6, 4.6],
    turret: { v: 1, top: 47, r: 1.0 }, wall: 0xe8e1d1, roof: TILE,
  });
  // the round chapel on the north side of the porch, and the sacristy by the choir
  const [x, z] = F.xz(-9.4, 15.9);
  kit.set(0xe8e1d1, K.plaster);
  kit.lathe(x, z, [[3.3, 0], [3.3, 6.6]], 12);
  kit.set(TILE, K.tile);
  kit.lathe(x, z, [[3.6, 6.5], [0, 10.4]], 12);
  kit.set(0xe8e1d1, K.plaster);
  F.box(-10.9, -5.4, -19.1, -11.4, 0, 6.2, { l: { cols: 2, rows: [{ y: 2, h: 2.2, w: 1.0, arch: 2 }] } }, false);
  kit.set(TILE, K.tile);
  F.roof(-10.9, -5.4, -19.1, -11.4, 6.2, 9.4, { alongV: true, hip0: 2.7, hip1: 2.7, over: 0.25 });
  // the two side portals, each under its own little gable
  for (const s of [-1, 1]) {
    const a = s < 0 ? -11.3 : 8.4, b = s < 0 ? -7.6 : 11.3;
    kit.set(0xe8e1d1, K.plaster);
    F.box(a, b, 2.9, 8.9, 0, 6.5, { [s < 0 ? 'l' : 'r']: { cols: 1, rows: [{ y: 0, h: 3.4, w: 1.9, arch: 2, door: true, rev: 0.3 }] } }, false);
    kit.set(TILE, K.tile);
    F.roof(a, b, 2.9, 8.9, 6.5, 9.6, { hip0: s < 0 ? 1.6 : 0, hip1: s < 0 ? 0 : 1.6, over: 0.25 });
  }
}

export function buildZvestovani(kit, f) {
  const { F } = fitFrame(kit, f.o, WEST[0], WEST[1]);
  kit.floodFn = (x, y) => (y < 13 ? 0.45 : 0.08);
  church(kit, F, {
    nave: [-7.8, 7.6, -4.4, 16.8], H: 12.5, rise: 11.5, bays: 4,
    pres: [-5.9, 3.5, -17.2, -4.4], presH: 12.5, presRise: 8,
    turret: { v: 5, top: 38, r: 0.85 }, wall: 0xe9e3d3, roof: TILE_DK,
  });
  // the sacristy in the angle of the choir
  kit.set(0xe9e3d3, K.plaster);
  F.box(3.5, 7.9, -10.7, -4.4, 0, 5.6, { r: { cols: 1, rows: [{ y: 1.8, h: 2.0, w: 1.0 }] } }, false);
  kit.set(TILE_DK, K.tile);
  F.roof(3.5, 7.9, -10.7, -4.4, 5.6, 8.2, { alongV: true, hip0: 2.2, over: 0.2 });
}

export function buildJan(kit, f) {
  const { F } = fitFrame(kit, f.o, WEST[0], WEST[1]);
  kit.floodFn = (x, y) => (y < 10 ? 0.35 : 0.06);
  church(kit, F, {
    nave: [-4.5, 7.0, -6.4, 13.8], H: 9.5, rise: 8.5, bays: 3,
    pres: [-5.5, 4.2, -14.2, -6.4], presH: 9.5, presRise: 6,
    turret: { v: 3, top: 29, r: 0.75 }, wall: 0xece8dd, roof: TILE,
  });
  kit.set(0xece8dd, K.plaster);
  F.box(-8.1, -4.5, 7.5, 11.7, 0, 4.4, { l: { cols: 1, rows: [{ y: 0, h: 2.6, w: 1.4, arch: 1, door: true }] } }, false);
  kit.set(TILE, K.tile);
  F.roof(-8.1, -4.5, 7.5, 11.7, 4.4, 6.6, { hip0: 1.6, over: 0.2 });
}

/** The bell tower of St Bartholomew: a plain square shaft, bell openings under a cupola. */
export function buildZvonice(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, 0.22, 0.97);
  kit.floodFn = (x, y) => (y < 20 ? 0.4 : 0.25);
  const s = Math.min(hu, hv), H = 20;
  const bell = { cols: 1, rows: [{ y: 6, h: 1.4, w: 0.8 }, { y: 14, h: 3.0, w: 1.7, arch: 1, hex: 0x221c16, kind: K.wood, rev: 0.35 }] };
  kit.set(0xe4dccb, K.plaster);
  F.box(-s, s, -s, s, 0, H, { f: { cols: 1, rows: [{ y: 0, h: 2.6, w: 1.3, arch: 1, door: true }, ...bell.rows] }, b: bell, l: bell, r: bell }, false);
  kit.set(0xcfc6b2, K.stone);
  F.box(-s - 0.3, s + 0.3, -s - 0.3, s + 0.3, H - 0.5, H + 0.1, null, true, true);
  kit.set(TILE, K.tile);
  F.pyramid(-s - 0.3, s + 0.3, -s - 0.3, s + 0.3, H + 0.1, H + 3.2, 0.42);
  const [x, z] = F.xz(0, 0);
  onion(kit, x, z, H + 3.2, 1.75);
}
