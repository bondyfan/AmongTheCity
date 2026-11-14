// ---- landmarks-sloup.js: the two monuments of the Old Town Square ----
// WORKER SAFE.
//   The Marian column (1650, torn down in 1918, raised again in 2020): a
//   Corinthian column about 16 m high with the gilt Virgin on top, crowned
//   with stars, on a pedestal whose balustrade has an angel at each corner
//   fighting a demon. The tile has it as a 0.5 m "building" (OSM area
//   57 m2, named Mariánský sloup) that the generic code drew as a little
//   gabled house in the middle of the square; the entry claims that footprint.
//   The Jan Hus monument (Ladislav Šaloun, 1915): a long low granite base, and
//   on it a dark bronze wave of figures, the defeated Hussites on one side,
//   the exiles and a mother with children on the other, rising to Hus himself
//   standing on a rock in the middle, about 8 m up, looking east toward Týn.
//   There is no footprint (OSM has a node), so it is a footprint-less piece
//   (js/landmarks.js EXTRAS), built by the chunk its centre lies in.

import { K, ringCentroid } from './landmarkskit.js';
import { GOLD } from './landmarks-parts.js';
import { figure, BRONZE } from './landmarks-gothic.js';

const STONE = 0xc4b9a3, STONE_DK = 0x9c917c, GRANITE = 0x8a8680;

export function buildSloup(kit, f) {
  const [x, z] = ringCentroid(f.o);
  kit.floodFn = (px, y) => (y > 12 ? 1 : 0.7);
  // three octagonal steps and the balustraded platform
  kit.set(STONE_DK, K.stone);
  kit.lathe(x, z, [[3.7, 0], [3.7, 0.3], [3.3, 0.3], [3.3, 0.6], [2.9, 0.6], [2.9, 0.9], [2.6, 0.9]], 8, Math.PI / 8);
  kit.set(STONE, K.stone);
  kit.lathe(x, z, [[2.6, 0.9], [2.6, 1.85], [2.7, 1.95], [0, 1.95]], 8, Math.PI / 8);
  // the pedestal, its cornice and the base of the column
  kit.lathe(x, z, [[1.15, 1.95], [1.15, 4.4], [1.35, 4.6], [1.35, 4.85], [0.62, 4.85]], 4, Math.PI / 4);
  // the column: a shaft with a little entasis, a Corinthian capital and an abacus
  kit.set(0xd8cfbb, K.stone);
  kit.lathe(x, z, [[0.62, 4.85], [0.55, 5.3], [0.5, 9.5], [0.42, 13.6], [0.48, 13.8], [0.62, 14.4], [0.72, 14.6], [0.72, 14.85]], 12);
  // the Virgin, gilt, and her ring of stars
  kit.set(GOLD, K.metal);
  figure(kit, x, z, 14.85, 2.1, GOLD, K.metal);
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, sx = x + Math.cos(a) * 0.45, sz = z + Math.sin(a) * 0.45;
    kit.lathe(sx, sz, [[0, 16.95], [0.08, 17.03], [0, 17.11]], 4);
  }
  // the four angels and their demons at the corners of the balustrade
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 8 + i * Math.PI / 2, ax = x + Math.cos(a) * 2.1, az = z + Math.sin(a) * 2.1;
    kit.set(STONE, K.stone);
    kit.lathe(ax, az, [[0.42, 1.95], [0.42, 2.6], [0, 2.6]], 4, Math.PI / 4);
    figure(kit, ax, az, 2.6, 1.7, 0xd3cab7, K.stone, a);
    kit.lathe(ax + Math.cos(a) * 0.35, az + Math.sin(a) * 0.35, [[0.32, 2.6], [0.25, 2.95], [0, 3.05]], 5);
  }
}
export function sloupSolids(f) {
  const [x, z] = ringCentroid(f.o), ring = [];
  for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; ring.push([x + Math.cos(a) * 2.75, z + Math.sin(a) * 2.75]); }
  // the platform, and the column standing on it (nobody walks through the shaft)
  const shaft = [];
  for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; shaft.push([x + Math.cos(a) * 1.2, z + Math.sin(a) * 1.2]); }
  return [{ ring, holes: null, top: 1.95, bot: 0 }, { ring: shaft, holes: null, top: 14.85, bot: 0 }];
}

// ---- the Jan Hus monument ----------------------------------------------------
export const HUS = [-95648.2, -6230.9];
// the base is long north to south; Hus faces east (+x), toward Týn
const HL = 8.6, HW = 4.4;

export function buildHus(kit, ctx) {
  const [x, z] = HUS;
  if (!ctx.terrain || ctx.chunkOf(x, z) !== ctx.key) return;
  kit.ground = ctx.terrain.heightAt(x, z);
  kit.floodFn = (px, y) => (y > 3 ? 0.8 : 0.5);
  // the granite base in two low steps, then the rock the bronze stands on
  kit.set(GRANITE, K.stone);
  kit.lathe(x, z, [[1, -0.3], [1, 0.45], [0.92, 0.45], [0.92, 0.9], [0.86, 0.9], [0, 0.9]], 16, Math.PI / 16, HW, HL);
  kit.set(0x4c514b, K.stone);
  kit.lathe(x, z, [[0.8, 0.9], [0.74, 1.6], [0.55, 2.4], [0.28, 2.9], [0, 3.0]], 12, Math.PI / 12, HW * 0.95, HL * 0.95);
  // Hus's rock in the middle, and Hus
  kit.set(0x3f453f, K.stone);
  kit.lathe(x - 0.6, z, [[1.5, 2.6], [1.3, 4.0], [0.8, 4.9], [0, 5.0]], 7, 0.3);
  figure(kit, x - 0.5, z, 4.9, 3.3, BRONZE, K.metal);
  // the bronze crowd to either side, falling away from him
  for (let i = 0; i < 18; i++) {
    const side = i % 2 ? 1 : -1, k = (i >> 1) / 8;           // 0 by Hus .. 1 at the ends
    const t = 1.6 + k * (HL - 2.4), off = Math.sin(i * 2.17) * 1.2;
    const fz = z + side * t, fx = x + off * (1 - k * 0.4);
    const base = 2.9 - 1.9 * k, h = 1.9 - 0.25 * k;
    figure(kit, fx, fz, base, h, i % 3 ? BRONZE : 0x344037, K.metal, i);
  }
}
