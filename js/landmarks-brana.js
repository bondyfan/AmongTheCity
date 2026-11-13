// ---- landmarks-brana.js: Zelená brána and its fore-gate ----
// The Green Gate is the picture of Pardubice: a stone gate tower raised to
// 59 m after the fire of 1538, with a wooden gallery under the roof and a
// copper helmet in three tiers, eight needle turrets round one tall spire.
// West of it stands the fore-gate (předbraní): two storeys, a Renaissance
// attic gable with lesenes and a row of little arches, and over its arch the
// relief of the Pernštejn legend after Mikoláš Aleš (1903).
//
// Both have a real passage. Zelenobranská street runs through the pair, so the
// arches are open, vaulted inside and paved, and what stops you is only the
// masonry either side (branaSolids). The tile has no footway under either
// gate (covered ways are not in it), so the paving is the model's own:
// without it the floor of the passage is the aerial photo of the copper roof.

import { K } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { circle, rect, needle } from './landmarks-parts.js';
import { paving } from './landmarks-passage.js';

const STONE = 0xc6bba4, STONE_DK = 0xa3987f, COPPER = 0x5fa58c, COPPER_DK = 0x4b8a74,
  GOLD = 0xdcb648, TIMBER = 0x4a3727, PLASTER = 0xe9e2cf, TILE = 0xa4523a, DARK = 0x191b1f;
// which way each front looks: the tower at the square (east-north-east along
// the street), the fore-gate out of the old town, the opposite way
const AXIS = [0.907, -0.421];
const PASS_TOWER = 3.8, PASS_FORE = 4.2;      // clear widths of the two arches (metres)

const TOWER_H = 33, TOWER_PH = 5.6, FORE_E = 8.2, FORE_PH = 4.9;   // wall tops and arch heights

/**
 * The paving of a passage. The landmark is founded a fifth of the way up the
 * fall of its footprint (terrain.groundFor), so the ground inside stands up to
 * four fifths of that fall above the model's zero: the floor is laid just over
 * the highest of it, a threshold of a few centimetres and never a buried slab.
 */
function pave(kit, F, f, w, hv) {
  kit.set(0x8f8a80, K.stone);
  F.flat(-w / 2, w / 2, -hv, hv, (f._gfall ?? 0) * 0.8 + 0.04, true);
}

export function buildBrana(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, AXIS[0], AXIS[1]);
  // lit from the pavement on every side; the helmet has its own lamps on the gallery
  kit.floodFn = (x, y) => (y < 34 ? 1 - 0.3 * (y / 34) : 0.82);
  const H = TOWER_H, PH = TOWER_PH;

  // ---- the shaft --------------------------------------------------------
  const slits = [{ y: 9, h: 1.7, w: 0.9, arch: 1, hex: DARK, kind: K.metal }, { y: 16, h: 1.7, w: 0.9, arch: 1, hex: DARK, kind: K.metal },
    { y: 22.3, h: 1.5, w: 0.8, arch: 1, hex: DARK, kind: K.metal }];
  const gate = { cols: 1, rows: [{ y: 0, h: PH, w: PASS_TOWER, arch: 2, open: true }, ...slits] };
  const side = { cols: 1, rows: slits };
  kit.set(STONE, K.stone);
  F.box(-hu, hu, -hv, hv, 0, H, { f: gate, b: gate, l: side, r: side }, false);
  kit.set(STONE_DK, K.stone);
  F.tunnel(0, PASS_TOWER, -hv, hv, PH, 2);
  pave(kit, F, f, PASS_TOWER, hv);
  // The little yard between the two gates. The tile has a footway across it
  // and nothing either side, and the photo ground there is the shadow the
  // tower threw on the morning it was flown: cobbles, wall to wall. 12 cm up:
  // over the photo (which can lie on the survey from before the earthworks,
  // a hand above today's ground) and under the footway (LAYER_Y.footway 16 cm).
  if (kit.terrain) {
    kit.set(0x8f8a80, K.stone);
    for (let u = -7; u < 7; u += 3.5) paving(kit, F, u, u + 3.5, -hv - 4.6, -hv + 0.1, 0.12);
  }
  // the stone course the gallery rides on
  F.box(-hu - 0.35, hu + 0.35, -hv - 0.35, hv + 0.35, H - 0.9, H, null, true, true);

  // ---- four clock faces -------------------------------------------------
  for (const [u, v, turn] of [[0, hv, 0], [0, -hv, Math.PI], [hu, 0, Math.PI / 2], [-hu, 0, -Math.PI / 2]]) {
    const S = F.sub(u, v, 0, turn);
    kit.set(GOLD, K.metal); S.slab(circle(0, 28, 1.5, 16), 0, 0.1);
    kit.set(0x17181b, K.metal); S.slab(circle(0, 28, 1.3, 16), 0.1, 0.14);
    kit.set(GOLD, K.metal);
    S.slab(rect(-0.07, 28, 0.07, 29.1), 0.14, 0.17);                                    // ten past
    S.slab([[0, 27.93], [0.07, 28.05], [0.74, 27.52], [0.67, 27.4]], 0.14, 0.17);       // ...four
  }

  // ---- the wooden gallery ----------------------------------------------
  const gu = hu + 1.15, gv = hv + 1.15, G = H + 0.22;
  kit.set(TIMBER, K.wood);
  F.box(-gu, gu, -gv, gv, H, G, null, true, true);
  F.box(-gu, gu, gv - 0.1, gv, G, G + 1.08);
  F.box(-gu, gu, -gv, -gv + 0.1, G, G + 1.08);
  F.box(-gu, -gu + 0.1, -gv, gv, G, G + 1.08);
  F.box(gu - 0.1, gu, -gv, gv, G, G + 1.08);
  for (const pu of [-1, 0, 1]) for (const pv of [-1, 0, 1]) {
    if (!pu && !pv) continue;
    const x = pu * (gu - 0.1), z = pv * (gv - 0.1);
    F.box(x - 0.09, x + 0.09, z - 0.09, z + 0.09, G, H + 3.2);
  }
  // the shaft goes on behind it, with a door on to the walk each side
  const door = { cols: 1, rows: [{ y: 0.25, h: 2.1, w: 1.1, hex: 0x241a12, kind: K.wood }] };
  kit.set(STONE, K.stone);
  F.box(-hu + 0.3, hu - 0.3, -hv + 0.3, hv - 0.3, H, H + 3.3, { f: door, b: door, l: door, r: door }, false);

  // ---- the copper helmet, three tiers of little roofs --------------------
  const eu = gu + 0.3, ev = gv + 0.3;
  kit.set(0x3a2c20, K.wood);
  F.flat(-eu, eu, -ev, ev, H + 3.2, false);                    // boarded underside of the eaves
  kit.set(COPPER, K.copper);
  F.pyramid(-eu, eu, -ev, ev, H + 3.2, H + 5.3, 0.6);          // tier one: the skirt over the gallery
  const a = eu * 0.6, b = ev * 0.6;
  kit.set(COPPER_DK, K.copper);
  F.box(-a, a, -b, b, H + 5.3, H + 7.1, null, false);
  kit.set(COPPER, K.copper);
  F.pyramid(-a - 0.25, a + 0.25, -b - 0.25, b + 0.25, H + 7.1, H + 10.2, 0.6);      // tier two
  const c = (a + 0.25) * 0.6, d = (b + 0.25) * 0.6;
  kit.set(COPPER_DK, K.copper);
  F.box(-c, c, -d, d, H + 10.2, H + 12.0, null, false);
  kit.set(COPPER, K.copper);
  F.pyramid(-c - 0.2, c + 0.2, -d - 0.2, d + 0.2, H + 12.0, H + 14.3, 0.55);        // tier three
  // four needles at the corners of the gallery roof, four more a tier up
  for (const su of [-1, 1]) for (const sv of [-1, 1]) {
    const [x1, z1] = F.xz(su * (hu + 0.25), sv * (hv + 0.25));
    needle(kit, x1, z1, H + 3.5, 3.2, 0.62, H + 12.6);
    const [x2, z2] = F.xz(su * (a - 0.1), sv * (b - 0.1));
    needle(kit, x2, z2, H + 8.0, 2.6, 0.45, H + 16.4);
  }
  // the lantern and the great spire, a gilt knob and the star
  const [cx, cz] = F.xz(0, 0);
  kit.set(COPPER_DK, K.copper);
  kit.lathe(cx, cz, [[1.25, H + 14.3], [1.25, H + 16.5]], 8, Math.PI / 8);
  kit.set(COPPER, K.copper);
  kit.lathe(cx, cz, [[1.25, H + 16.5], [1.7, H + 16.7], [1.05, H + 17.8], [0.45, H + 21.6], [0.15, H + 25.0], [0, H + 25.3]], 8, Math.PI / 8);
  kit.set(GOLD, K.metal);
  kit.lathe(cx, cz, [[0, H + 25.0], [0.36, H + 25.35], [0, H + 25.7]], 8);
  kit.lathe(cx, cz, [[0, H + 25.6], [0.3, H + 25.9], [0, H + 26.2]], 4);
}

export function buildPredbrani(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, -AXIS[0], -AXIS[1]);
  kit.floodFn = () => 0.85;
  const E = FORE_E, PH = FORE_PH;
  const arch = { cols: 1, rows: [{ y: 0, h: PH, w: PASS_FORE, arch: 1, open: true }] };
  const win = { cols: 2, rows: [{ y: 5.0, h: 1.5, w: 0.95, glow: 0.5 }], seed: 3 };
  kit.set(PLASTER, K.plaster);
  F.box(-hu, hu, -hv, hv, 0, E, { f: arch, b: arch, l: win, r: win }, true);
  kit.set(0xb7b09d, K.plaster);
  F.tunnel(0, PASS_FORE, -hv, hv, PH, 1);
  pave(kit, F, f, PASS_FORE, hv);

  // the legend of the Pernštejns over the arch, in its frame
  kit.set(0x8a7654, K.metal); F.slab(rect(-2.25, 5.25, 2.25, 7.95), hv, hv + 0.07);
  kit.set(0xcdb88f, K.plaster); F.slab(rect(-2.0, 5.5, 2.0, 7.7), hv + 0.07, hv + 0.13);
  // the knight leading the bison by a rope through its nose, in low relief: a
  // standing figure and a horned head, not two blots (seen from the square, the
  // first cut read as two pentagons)
  kit.set(0xa98f63, K.metal);
  F.slab([[-1.35, 5.65], [-1.15, 5.65], [-1.05, 6.3], [-0.95, 5.65], [-0.75, 5.65], [-0.8, 6.5], [-0.55, 6.9],
    [-0.6, 7.05], [-0.85, 7.0], [-0.85, 7.15], [-0.78, 7.2], [-0.8, 7.45], [-0.95, 7.55], [-1.1, 7.45],
    [-1.12, 7.2], [-1.05, 7.15], [-1.05, 7.0], [-1.35, 6.95], [-1.45, 6.6], [-1.3, 6.5]], hv + 0.13, hv + 0.19);
  F.slab([[0.55, 6.0], [1.25, 6.0], [1.45, 6.5], [1.75, 6.85], [1.9, 7.35], [1.6, 7.0], [1.35, 7.05], [1.2, 7.25],
    [0.6, 7.25], [0.45, 7.05], [0.2, 7.0], [-0.1, 7.35], [0.05, 6.85], [0.35, 6.5]], hv + 0.13, hv + 0.19);
  F.slab([[-0.6, 6.8], [0.62, 6.2], [0.62, 6.28], [-0.6, 6.88]], hv + 0.13, hv + 0.16);
  // lesenes up the front and the cornice they carry
  kit.set(0xd8cfb9, K.plaster);
  for (const u of [-hu + 0.25, -hu * 0.56, hu * 0.56, hu - 0.25]) F.slab(rect(u - 0.17, 0, u + 0.17, E + 2.0), hv, hv + 0.09);
  F.slab(rect(-hu - 0.15, E - 0.16, hu + 0.15, E + 0.14), hv - 0.1, hv + 0.2);

  // the Renaissance attic: three steps, each crowned with little arches
  kit.set(PLASTER, K.plaster);
  const s1 = hu, s2 = hu * 0.64, s3 = hu * 0.3, y1 = E + 2.2, y2 = E + 3.7, y3 = E + 5.0;
  F.slab([[-s1, E], [s1, E], [s1, y1], [s2, y1], [s2, y2], [s3, y2], [s3, y3],
    [-s3, y3], [-s3, y2], [-s2, y2], [-s2, y1], [-s1, y1]], hv - 0.5, hv);
  const ear = (uc, y, r) => {
    const pts = [];
    for (let i = 0; i <= 6; i++) { const t = i * Math.PI / 6; pts.push([uc + Math.cos(t) * r, y + Math.sin(t) * r]); }
    F.slab(pts, hv - 0.45, hv - 0.05);
  };
  const e1 = (s1 - s2) / 2, e2 = (s2 - s3) / 2;
  for (const sgn of [-1, 1]) { ear(sgn * (s2 + e1), y1, e1 * 0.92); ear(sgn * (s3 + e2), y2, e2 * 0.92); }
  for (const u of [-s3 * 0.5, s3 * 0.5]) ear(u, y3, s3 * 0.46);

  // a tiled saddle roof behind it, ridge along the passage
  kit.set(TILE, K.tile);
  F.roof(-hu, hu, -hv, hv - 0.5, E, E + 4.0, { alongV: true, gableHex: PLASTER, over: 0.2 });
}

/**
 * The masonry either side of the passage (all of either gate that stops
 * somebody on the ground) and the masonry over it. Solid to `l.top`: the
 * tower to the foot of its helmet, the fore-gate to half way up its roof.
 */
export function branaSolids(f, l) {
  const fore = l.id === 'predbrani';
  const { F, hu, hv } = fitFrame(null, f.o, fore ? -AXIS[0] : AXIS[0], fore ? -AXIS[1] : AXIS[1]);
  const half = (fore ? PASS_FORE : PASS_TOWER) / 2;
  const piece = (u0, u1, bot) => ({ ring: F.ring(u0, u1, -hv, hv), holes: null, top: l.top, bot });
  return [piece(-hu, -half, 0), piece(half, hu, 0), piece(-half, half, fore ? FORE_PH : TOWER_PH)];
}
