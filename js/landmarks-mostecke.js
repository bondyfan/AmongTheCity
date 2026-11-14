// ---- landmarks-mostecke.js: the towers at the two ends of Charles Bridge ----
// WORKER SAFE.
//   Staroměstská mostecká věž (about 1380, Peter Parler's workshop): a square
//   Gothic gate tower with the passage on to the bridge, its east face to the
//   Old Town carved with the patrons of the realm, Charles IV and Wenceslas IV
//   seated either side of St Vitus over a row of coats of arms, and a steep
//   slate helmet with a tracery gallery and four corner turrets, about 47 m.
//   The tile lifts its footprint to 9 m (the passage under it is not in the
//   tile at all, and neither is its floor): the entry is `lifted`, the model
//   stands on the ground and paves its passage on the ground as it rises two
//   metres from the deck to the Old Town side.
//   Malostranské mostecké věže: the taller Gothic tower of 1464 (about 43.5 m,
//   the twin of the Old Town tower's silhouette), the low Romanesque Judith
//   tower of the first stone bridge, and between them the gate over Mostecká,
//   also lifted in the tile (8 m).

import { K } from './landmarkskit.js';
import { Frame, fitFrame } from './landmarksframe.js';
import { rect, GOLD } from './landmarks-parts.js';
import { gothicHelmet, figureOutline, SLATE } from './landmarks-gothic.js';
import { paving } from './landmarks-passage.js';

const STONE = 0x8e8474, STONE_LT = 0xa79d8a, STONE_DK = 0x6d655a, PANE = 0x2a3038;

// ---- the Old Town Bridge Tower ----------------------------------------------
// v runs along the passage, out toward the bridge (west); the passage centre
// line sits 1.5 m off the middle of the footprint (scratch: the bridge end and
// the way beyond the tower, in its frame)
const OT_HINT = [-0.966, -0.259];
const OT = { u0: -6.9, u1: 4.4, pu: -1.5, pw: 5.2, ph: 9.6, H: 30.5 };

export function buildOtbt(kit, f) {
  const { F, hv } = fitFrame(kit, f.o, OT_HINT[0], OT_HINT[1]);
  kit.floodFn = (x, y) => (y < OT.H ? 0.95 - 0.2 * (y / OT.H) : 0.75);
  const { u0, u1, pu, pw, ph, H } = OT, uc = (u0 + u1) / 2, hu = (u1 - u0) / 2;
  const T = F.sub(uc, 0);
  const off = pu - uc;                        // the passage, in the tower's own frame
  const slit = (y) => ({ y, h: 2.0, w: 0.8, arch: 2, hex: PANE, glow: 0.1, rev: 0.3 });
  kit.set(STONE, K.stone);
  // the two faces with the passage: the opening is offset, so each face is a
  // wallGrid of its own on either side of the arch
  const face = (side) => {
    const s = side === 'f' ? 1 : -1, v = s * hv;
    const a = F.xz(u0, v), b = F.xz(u1, v), c0 = F.xz(pu - pw / 2, v), c1 = F.xz(pu + pw / 2, v);
    const [nx, nz] = F.dir(0, s);
    const L = side === 'f' ? [a, c0] : [c1, b], R = side === 'f' ? [c1, b] : [a, c0];
    kit.wallGrid(L[0], L[1], 0, H, nx, nz, { cols: 1, rows: [slit(16), slit(23)], seed: 1 });
    kit.wallGrid(R[0], R[1], 0, H, nx, nz, { cols: 1, rows: [slit(16), slit(23)], seed: 2 });
    const m0 = side === 'f' ? c0 : c1, m1 = side === 'f' ? c1 : c0;
    kit.wallGrid(m0, m1, 0, H, nx, nz, { cols: 1, rows: [{ y: 0, h: ph, w: pw - 0.02, arch: 2, open: true }, slit(20.5)], seed: 3 });
  };
  face('f'); face('b');
  const side = { cols: 2, inset: 2, rows: [slit(12), slit(19), slit(25)], seed: 4 };
  T.face('l', -hu, hu, -hv, hv, 0, H, side);
  T.face('r', -hu, hu, -hv, hv, 0, H, side);
  kit.set(STONE_DK, K.stone);
  F.tunnel(pu, pw, -hv, hv, ph, 2);
  // the stair turret on the south side
  kit.set(STONE, K.stone);
  F.box(u1, 6.9, -1.25, 1.6, 0, 24, { l: false, r: { cols: 1, rows: [slit(8), slit(15)], seed: 5 } }, false);
  kit.set(SLATE, K.slate);
  F.pyramid(u1 - 0.1, 7.1, -1.4, 1.75, 24, 27.5);
  // the passage floor, laid on the ground as it rises from the deck to the town
  if (kit.terrain) { kit.set(0x8a857b, K.stone); paving(kit, F, pu - pw / 2, pu + pw / 2, -hv, hv, 0.05); }

  // ---- the sculpture of the east face (b, toward the Old Town)
  const S = F.sub(uc, -hv, 0, Math.PI);       // its front looks east; u runs the other way
  const su = -off;                             // the passage centre, in S
  kit.set(STONE_LT, K.stone);
  S.slab(rect(-hu + 0.4, ph + 0.6, hu - 0.4, ph + 1.0), 0, 0.3);
  // the row of the coats of arms of the lands of the Crown
  const arms = [0xb32b25, 0xe0c24a, 0x2b4f9a, 0xb32b25, 0xd9d4c4, 0x2b4f9a, 0xe0c24a, 0xb32b25];
  for (let i = 0; i < arms.length; i++) {
    const u = su - 3.5 + i;
    kit.set(arms[i], K.metal);
    S.slab([[u - 0.35, ph + 1.4], [u + 0.35, ph + 1.4], [u + 0.35, ph + 2.0], [u, ph + 2.35], [u - 0.35, ph + 2.0]], 0.05, 0.15);
  }
  // the gallery of the patrons: St Vitus on the bridge, the two kings seated beside
  kit.set(STONE_DK, K.stone);
  S.slab(rect(su - 3.4, ph + 3.0, su + 3.4, ph + 6.6), 0, 0.12);
  kit.set(0x948a77, K.stone);
  for (const [u, h] of [[-2.3, 2.6], [0, 3.0], [2.3, 2.6]]) S.slab(figureOutline(su + u, ph + 3.3, h, 0.25), 0.12, 0.42);
  for (const u of [-3.4, -1.15, 1.15, 3.4]) {
    kit.set(STONE_LT, K.stone);
    S.slab([[su + u - 0.15, ph + 3.0], [su + u + 0.15, ph + 3.0], [su + u + 0.15, ph + 6.9], [su + u, ph + 7.6], [su + u - 0.15, ph + 6.9]], 0, 0.3);
  }
  // the patron saints under the gallery: St Adalbert and St Sigismund
  kit.set(0x948a77, K.stone);
  for (const u of [-4.1, 4.1]) S.slab(figureOutline(su + u, ph + 8.4, 2.4), 0, 0.35);

  gothicHelmet(kit, F, uc, 0, hu, hv, H, H + 1.6, {
    over: 0.6, stone: STONE, rise: 44.5, tip: 47, turretR: 0.75, turretTop: 39.5, lucarnes: 1,
  });
}

/** Beside the passage, and over it from the crown of the arch. */
export function otbtSolids(f, l) {
  const { F, hv } = fitFrame(null, f.o, OT_HINT[0], OT_HINT[1]);
  const { u0, u1, pu, pw, ph } = OT, half = pw / 2;
  const piece = (a, b, bot) => ({ ring: F.ring(a, b, -hv, hv), holes: null, top: l.top, bot });
  // ...and the stair turret on the south side, to its own eaves
  return [piece(u0, pu - half, 0), piece(pu + half, u1, 0), piece(pu - half, pu + half, ph),
    { ring: F.ring(u1, 6.9, -1.25, 1.6), holes: null, top: 24, bot: 0 }];
}

// ---- the Lesser Town towers and their gate ------------------------------------
// One constant frame for all three: the gate's own rectangle, v east along
// Mostecká toward the bridge, u to the north... (scratch: fitFrame of the gate
// footprint with the hint east). In it the taller tower spans u 2.6..15.1,
// Judith's tower u -15.5..-3.3, the gate u -4.2..4.2.
const MO = [-96671.03, -6175.53], MN = [0.999, 0.044];
const mframe = (kit) => new Frame(kit, MO[0], MO[1], MN[0], MN[1]);
const MLST = { u0: 2.6, u1: 15.1, v0: -6.0, v1: 6.0, H: 28.5 };
const JUD = { u0: -15.5, u1: -3.3, v0: -4.6, v1: 5.4, H: 13.5 };
const GATE = { u0: -4.0, u1: 4.0, v0: -5.0, v1: 5.0, H: 11.6, pw: 4.6, ph: 6.6 };

export function buildMlst(kit) {
  const F = mframe(kit);
  kit.floodFn = (x, y) => (y < MLST.H ? 0.9 - 0.2 * (y / MLST.H) : 0.75);
  const { u0, u1, v0, v1, H } = MLST, uc = (u0 + u1) / 2, vc = (v0 + v1) / 2, hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const T = F.sub(uc, vc);
  const win = (y, h = 2.0) => ({ y, h, w: 0.9, arch: 2, hex: PANE, glow: 0.1, rev: 0.3 });
  const face = { cols: 2, inset: 2.4, rows: [win(9), win(15), win(21, 2.6)], seed: 6 };
  kit.set(STONE, K.stone);
  T.box(-hu, hu, -hv, hv, 0, H, { f: face, b: face, l: { cols: 1, rows: [win(15), win(21, 2.6)] }, r: face }, false);
  kit.set(STONE_LT, K.stone);
  for (const y of [8.2, 18.8]) T.box(-hu - 0.1, hu + 0.1, -hv - 0.1, hv + 0.1, y, y + 0.3, null, true, true);
  // blind tracery on the bridge face: three tall pointed panels
  const S = F.sub(uc, v1);
  kit.set(STONE_DK, K.stone);
  for (const u of [-3.4, 0, 3.4]) S.slab([[u - 1.1, 10.2], [u + 1.1, 10.2], [u + 1.1, 16.2], [u, 17.8], [u - 1.1, 16.2]], 0, 0.1);
  gothicHelmet(kit, F, uc, vc, hu, hv, H, H + 1.5, {
    over: 0.55, stone: STONE, rise: 41.2, tip: 43.5, turretR: 0.75, turretTop: 37, lucarnes: 1,
  });
}

export function buildJudita(kit) {
  const F = mframe(kit);
  kit.floodFn = (x, y) => (y < JUD.H ? 0.7 : 0.4);
  const { u0, u1, v0, v1, H } = JUD;
  const win = { cols: 2, inset: 2.2, rows: [{ y: 5.5, h: 1.6, w: 0.8, arch: 1, hex: PANE, glow: 0.3 }, { y: 9.6, h: 1.6, w: 0.8, arch: 1, hex: PANE, glow: 0.3 }], seed: 7 };
  kit.set(0xb4a891, K.stone);
  F.box(u0, u1, v0, v1, 0, H, { f: win, b: win, l: win, r: false }, false);
  kit.set(SLATE, K.slate);
  F.roof(u0, u1, v0, v1, H, H + 6.5, { over: 0.3, hip0: 3.5, hip1: 0, gableHex: 0xb4a891, gableKind: K.stone });
}

export function buildMlstBrana(kit) {
  const F = mframe(kit);
  kit.floodFn = () => 0.8;
  const { u0, u1, v0, v1, H, pw, ph } = GATE;
  const arch = { cols: 1, rows: [{ y: 0, h: ph, w: pw, arch: 1, open: true }, { y: 8.0, h: 1.4, w: 0.8, arch: 1, hex: PANE, glow: 0.4 }] };
  kit.set(STONE_LT, K.stone);
  F.box(u0, u1, v0, v1, 0, H, { f: arch, b: arch, l: false, r: false }, true);
  kit.set(STONE_DK, K.stone);
  F.tunnel(0, pw, v0, v1, ph, 1);
  if (kit.terrain) { kit.set(0x8a857b, K.stone); paving(kit, F, -pw / 2, pw / 2, v0, v1, 0.05); }
  kit.set(STONE_LT, K.stone);
  F.merlons('f', u0, u1, v0, v1, H, 1.0, 0.9, 0.6);
  F.merlons('b', u0, u1, v0, v1, H, 1.0, 0.9, 0.6);
  // the arms of the Lesser Town over the arch, toward the bridge
  const S = F.sub(0, v1);
  kit.set(0xb32b25, K.metal); S.slab([[-0.6, 7.2], [0.6, 7.2], [0.6, 8.0], [0, 8.5], [-0.6, 8.0]], 0, 0.12);
  kit.set(GOLD, K.metal); S.slab(rect(-0.25, 7.5, 0.25, 8.0), 0.12, 0.16);
}

const mring = (u0, u1, v0, v1) => mframe(null).ring(u0, u1, v0, v1);
export const mlstSolids = () => [{ ring: mring(MLST.u0, MLST.u1, MLST.v0, MLST.v1), holes: null, top: MLST.H, bot: 0 }];
export const juditaSolids = () => [{ ring: mring(JUD.u0, JUD.u1, JUD.v0, JUD.v1), holes: null, top: JUD.H, bot: 0 }];
export function mlstBranaSolids() {
  const { u0, u1, v0, v1, H, pw, ph } = GATE;
  return [{ ring: mring(u0, -pw / 2, v0, v1), holes: null, top: H, bot: 0 },
    { ring: mring(pw / 2, u1, v0, v1), holes: null, top: H, bot: 0 },
    { ring: mring(-pw / 2, pw / 2, v0, v1), holes: null, top: H, bot: ph }];
}
/** The passage centre lines (WALKS and the tests): OTBT and the Lesser Town gate. */
export const PASSAGES = { otbt: [[-96192.1, -6059.6], [-96181.4, -6057.1]], gate: [[-96676.0, -6175.7], [-96666.1, -6175.2]] };
