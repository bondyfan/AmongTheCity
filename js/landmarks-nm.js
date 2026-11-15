// ---- landmarks-nm.js: the National Museum and St Wenceslas ----
// Josef Schulz's Neo-Renaissance museum of 1891 closes the top of Wenceslas
// Square: a 104 m front of sandstone with a rusticated ground floor, a giant
// Corinthian order over it, corner pavilions with their own little domes, a
// central risalit with a pediment, and over the pantheon behind it the drum
// and ribbed dome whose lantern stands about 70 m over the square below.
// Before it, 130 m down the axis, Myslbek's equestrian St Wenceslas (1912)
// with the four patron saints round the pedestal.
//
// Frame: fitted to the footprint (tile -20_-2, relation 3366506), front
// (v+) north-west down the square. u runs along the front; the corner and
// central risalits are the footprint's own notches at v = +37..41.

import { K } from './landmarkskit.js';
import { Frame, fitFrame } from './landmarksframe.js';
import { rect, COPPER, GOLD } from './landmarks-parts.js';
import { ringRoof } from './landmarks-prahaparts.js';

const STONE = 0xcbbd9c, STONE_DK = 0xa8997a, ROOF = 0x55695f, PANE = 0x3f4b57, DOME = 0x4f8e78;
const HINT = [-0.67, -0.74];
const E = 22, ATTIC = 25;                      // cornice, top of the attic balustrade
const DOME_V = 8, DRUM_R = 11.5;               // the pantheon's dome, on the axis behind the front
const DOME_TOP = 62.4;                         // 70 m over the fountain (209), on a founding of 216.6
// St Wenceslas: the OSM node, the way he looks (315 deg, down the square)
const VACLAV = [-95032.3, -5347.1], VACLAV_FACE = [-0.7071, -0.7071];

export function nmFrame(kit, f) { return fitFrame(kit, f.o, HINT[0], HINT[1]); }

export function buildNm(kit, f) {
  const { F, hv } = nmFrame(kit, f);
  kit.floodFn = (x, y) => (y < E + 4 ? 0.85 - 0.01 * y : 0.6);
  const rows = [{ y: 1.6, h: 3.2, w: 1.7, arch: 1, hex: PANE, glow: 0.2, rev: 0.25 },
    { y: 8.4, h: 4.4, w: 1.9, arch: 1, hex: PANE, glow: 0.3, rev: 0.25 },
    { y: 15.4, h: 3.2, w: 1.7, hex: PANE, glow: 0.25, rev: 0.2 }];
  const grid = (e) => (e.len < 4 ? null : { pitch: 4.4, inset: 0.8, rows, seed: e.i });
  // the front stands on the ground of the square, which falls to the
  // north-west: the walls start where each edge meets it
  kit.set(STONE, K.stone);
  kit.ringWalls(f.o, -1.2, E, grid);
  for (const h of f.i ?? []) if (h.length >= 3) kit.ringWalls(h, 0, E, (e) => (e.len < 4 ? null : { pitch: 4.4, inset: 0.8, rows, seed: 60 + e.i }), true);
  // rustication band, cornice, attic
  kit.set(STONE_DK, K.stone);
  kit.ringWalls(kit.offsetRing(f.o, -0.25), 6.6, 7.4);
  kit.ringWalls(kit.offsetRing(f.o, -0.45), E - 0.9, E);
  kit.set(STONE, K.stone);
  kit.ringWalls(kit.offsetRing(f.o, 0.3), E, ATTIC);
  kit.set(ROOF, K.copper);
  ringRoof(kit, kit.offsetRing(f.o, 0.3), f.i, ATTIC - 0.6, 5, 3.5, 0);

  // ---- the central risalit: giant order, pediment, the inscription --------
  const vf = hv + 0.1;
  kit.set(STONE, K.stone);
  for (let i = 0; i < 8; i++) {
    const u = -10.5 + i * 3;
    const [x, z] = F.xz(u, vf + 1.2);
    kit.lathe(x, z, [[0.95, 7.4], [0.8, 8.2], [0.72, E - 2], [1.0, E - 0.9]], 8, Math.PI / 8);
  }
  F.box(-12.5, 12.5, vf - 0.3, vf + 2.4, E - 0.9, E + 0.6, null, true, true);
  F.slab([[-12.8, E + 0.6], [12.8, E + 0.6], [0, E + 7.2]], vf - 0.3, vf + 2.4);
  kit.set(0x2a2622, K.metal);
  F.slab(rect(-8, E - 0.6, 8, E + 0.3), vf + 2.4, vf + 2.5);
  // the steps up to it and the ramp landing
  kit.set(0xb2a68c, K.stone);
  for (let k = 0; k < 4; k++) F.box(-14 + k * 0.6, 14 - k * 0.6, vf, vf + 6 - k * 1.4, -1.2, 0.5 + k * 0.6);

  // ---- corner pavilions: square cupolas -----------------------------------
  for (const s of [-1, 1]) {
    const uc = s * 45.6, vc = 33;
    kit.set(STONE, K.stone);
    F.box(uc - 5, uc + 5, vc - 5, vc + 5, E, ATTIC + 3.5, null, false);
    kit.set(ROOF, K.copper);
    F.pyramid(uc - 5.4, uc + 5.4, vc - 5.4, vc + 5.4, ATTIC + 3.5, ATTIC + 9, 0.35);
    const [x, z] = F.xz(uc, vc);
    kit.set(COPPER, K.copper);
    kit.lathe(x, z, [[1.2, ATTIC + 9], [1.0, ATTIC + 11], [0.15, ATTIC + 13.5], [0, ATTIC + 14]], 8, Math.PI / 8);
  }

  // ---- the drum and the dome ------------------------------------------------
  const [dx, dz] = F.xz(0, DOME_V);
  kit.set(STONE, K.stone);
  kit.lathe(dx, dz, [[DRUM_R + 1.2, ATTIC - 1], [DRUM_R + 1.2, ATTIC + 2], [DRUM_R, ATTIC + 2], [DRUM_R, 37]], 16);
  // the drum's windows as dark slots between pilasters
  kit.set(0x30363d, K.glassDark);
  for (let i = 0; i < 16; i++) {
    const a = (i + 0.5) * Math.PI / 8, c = Math.cos(a), sn = Math.sin(a), r = DRUM_R + 0.04;
    const w = 1.1, t = [-sn, c];
    const A = [dx + c * r + t[0] * w, ATTIC + 4, dz + sn * r + t[1] * w], B = [dx + c * r - t[0] * w, ATTIC + 4, dz + sn * r - t[1] * w];
    kit.quad(A, B, [B[0], 35, B[2]], [A[0], 35, A[2]], c, 0, sn);
  }
  kit.set(STONE_DK, K.stone);
  kit.lathe(dx, dz, [[DRUM_R + 0.6, 37], [DRUM_R + 0.6, 38.4], [DRUM_R - 0.3, 38.4]], 16);
  kit.set(DOME, K.copper);
  const prof = [];
  for (let i = 0; i <= 7; i++) { const a = i / 7 * Math.PI / 2; prof.push([(DRUM_R - 0.3) * Math.cos(a) + (i === 7 ? 2.2 : 0), 38.4 + 13.5 * Math.sin(a)]); }
  kit.lathe(dx, dz, prof, 16);
  // ribs
  kit.set(0x3f7563, K.copper);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, c = Math.cos(a), sn = Math.sin(a);
    for (let k = 0; k < 6; k++) {
      const a0 = k / 7 * Math.PI / 2, a1 = (k + 1) / 7 * Math.PI / 2;
      const r0 = (DRUM_R - 0.1) * Math.cos(a0), r1 = (DRUM_R - 0.1) * Math.cos(a1), y0 = 38.4 + 13.6 * Math.sin(a0), y1 = 38.4 + 13.6 * Math.sin(a1);
      const t = [-sn * 0.3, c * 0.3];
      kit.quad([dx + c * r0 + t[0], y0, dz + sn * r0 + t[1]], [dx + c * r0 - t[0], y0, dz + sn * r0 - t[1]],
        [dx + c * r1 - t[0], y1, dz + sn * r1 - t[1]], [dx + c * r1 + t[0], y1, dz + sn * r1 + t[1]], c, Math.sin(a0 + 0.1), sn);
    }
  }
  // the lantern and its gilt finial
  kit.set(STONE, K.stone);
  kit.lathe(dx, dz, [[2.2, 51.8], [2.0, 52], [2.0, 56.5], [2.5, 57]], 8, Math.PI / 8);
  kit.set(DOME, K.copper);
  kit.lathe(dx, dz, [[2.6, 57], [1.6, 59], [0.4, 60.6]], 8, Math.PI / 8);
  kit.set(GOLD, K.metal);
  kit.lathe(dx, dz, [[0.4, 60.6], [0.55, 61.2], [0, 61.8], [0.06, DOME_TOP - 0.2], [0, DOME_TOP]], 6);
}

/** Solid as built: the block to its cornice, courtyards open; the drum as a ring of its own. */
export function nmSolids(f, l) {
  const { F } = nmFrame(null, f);
  const drum = [];
  for (let i = 0; i < 12; i++) { const a = i * Math.PI / 6; drum.push(F.xz(Math.cos(a) * DRUM_R, DOME_V + Math.sin(a) * DRUM_R)); }
  return [{ ring: f.o, holes: f.i ?? null, top: l.top, bot: 0 }, { ring: drum, holes: null, top: 38, bot: 0 }];
}

/**
 * St Wenceslas on his pedestal, 130 m down the axis: a stepped granite base,
 * the horse (a silhouette slab, three layers, so it has a body from any side),
 * the saint with his lance and banner, and Ludmila, Agnes, Procopius and
 * Adalbert at the corners. A `grounds` builder of the museum (the monument
 * has no footprint); it stands where the OSM node does.
 */
export function buildVaclav(kit) {
  const [x0, z0] = VACLAV;
  // lathes are not in the frame: their heights take the plinth's ground
  // themselves (without it the rider's and the saints' heads hung 7 m up in
  // the air over the statue, seen from the square)
  const y0 = kit.rel(x0, z0);
  const S = new Frame(kit, x0, z0, VACLAV_FACE[0], VACLAV_FACE[1], y0);
  const was = kit.floodFn;
  kit.floodFn = (x, y) => 0.9;
  kit.set(0x6d6a66, K.stone);
  S.box(-4.2, 4.2, -5.6, 5.6, -0.6, 0.5);
  kit.set(0x8a857c, K.stone);
  S.box(-3.0, 3.0, -4.2, 4.2, 0.5, 1.4);
  S.box(-1.7, 1.7, -3.2, 3.2, 1.4, 4.6);
  kit.set(0x77736c, K.stone);
  S.box(-1.95, 1.95, -3.45, 3.45, 4.6, 5.0);
  const BR = 0x3b4a3f;                       // bronze, green with age
  kit.set(BR, K.metal);
  // the horse, walking: a silhouette in (v, y), v forward, three slabs wide
  const horse = [[-2.4, 7.4], [-2.6, 6.6], [-2.2, 6.9], [-1.9, 6.4], [-1.8, 5.0], [-1.5, 5.0], [-1.4, 6.1],
    [1.0, 6.1], [1.3, 5.0], [1.6, 5.0], [1.5, 6.3], [1.9, 7.0], [2.1, 8.0], [2.6, 8.3], [2.7, 7.9], [2.2, 7.2],
    [1.8, 7.4], [1.5, 7.6], [-1.6, 7.6]];
  S.slab(horse, -0.35, 0.35, true);
  S.slab(horse.map(([v, y]) => [v * 0.92, 5.6 + (y - 5.6) * 0.9]), -0.62, -0.35, true);
  S.slab(horse.map(([v, y]) => [v * 0.92, 5.6 + (y - 5.6) * 0.9]), 0.35, 0.62, true);
  // the rider: legs, torso, head, the helmet; the lance with the banner
  S.box(-0.55, 0.55, -0.5, 0.4, 7.5, 8.2);
  S.box(-0.38, 0.38, -0.35, 0.3, 8.2, 9.4);
  const [hx, hz] = S.xz(0, 0);
  kit.lathe(hx, hz, [[0, 9.4], [0.28, 9.55], [0.3, 9.85], [0.12, 10.15], [0, 10.3]].map(([r, y]) => [r, y0 + y]), 6);
  const L0 = S.P(0.6, 0.3, 7.6), L1 = S.P(0.75, 0.6, 12.4);
  const [lx, lz] = S.dir(1, 0);
  kit.quad([L0[0] - 0.05, L0[1], L0[2]], [L0[0] + 0.05, L0[1], L0[2]], [L1[0] + 0.05, L1[1], L1[2]], [L1[0] - 0.05, L1[1], L1[2]], lx, 0, lz);
  S.slab([[0.6, 11.0], [1.8, 11.3], [1.7, 12.0], [0.7, 12.2]], 0.72, 0.78, true);
  // the four patron saints at the corners of the base
  for (const [u, v] of [[-2.5, -3.8], [2.5, -3.8], [-2.5, 3.8], [2.5, 3.8]]) {
    S.box(u - 0.35, u + 0.35, v - 0.3, v + 0.3, 1.4, 3.3);
    const [px, pz] = S.xz(u, v);
    kit.lathe(px, pz, [[0, 3.3], [0.24, 3.45], [0.2, 3.75], [0, 3.85]].map(([r, y]) => [r, y0 + y]), 6);
  }
  kit.floodFn = was;
}

/** For the far skyline: the block, the attic line and the dome. kit.ground is the founding height. */
export function nmFar(kit, F) {
  kit.set(STONE, K.stone);
  F.box(-52, 52, -40, 41, -2, ATTIC);
  kit.set(ROOF, K.copper);
  F.roof(-52, 52, -40, 41, ATTIC - 0.6, ATTIC + 4, { hip0: 6, hip1: 6 });
  const [dx, dz] = F.xz(0, DOME_V);
  kit.set(STONE, K.stone);
  kit.lathe(dx, dz, [[DRUM_R, ATTIC], [DRUM_R, 38.4]], 12);
  kit.set(DOME, K.copper);
  kit.lathe(dx, dz, [[DRUM_R, 38.4], [DRUM_R * 0.9, 44], [DRUM_R * 0.62, 49], [2.2, 52], [2.0, 57], [0, DOME_TOP]], 12);
}
