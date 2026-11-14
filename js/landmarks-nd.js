// ---- landmarks-nd.js: the National Theatre on the embankment ----
// Josef Zítek's theatre (1868 to 1881, rebuilt by Schulz after the fire of
// 1881): a Neo-Renaissance block of light sandstone on the corner of the
// embankment and Národní, three tiers of arched windows over a rusticated
// base, and over the auditorium the tall dark roof with its gilded crest and
// crown that the whole river sees ("the golden chapel"). On the two pylons of
// the north front, toward Národní and Most Legií, Wagner's Trigas: the
// goddess of victory driving three horses, in dark bronze, 26 m up.
//
// Frame: fitted to the footprint (tile -21_-2, way 7649971), front (v+) NORTH
// toward Národní; u+ is the river side (west). The plan is a trapezoid: the
// east wall runs straight, the river wall closes in toward the stage at the
// south end. The porch before the north front is the tile's companion
// footprint (169 m2), taken out of the generic city and built here.

import { K } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { rect, GOLD } from './landmarks-parts.js';

const STONE = 0xd6c39e, STONE_DK = 0xb7a17a, ROOF = 0x2f3a45, PANE = 0x3b4652, BRONZE = 0x3a3a33;
const E = 20;                                     // the main cornice
const AUD = { u0: -15.5, u1: 14.5, v0: 4, v1: 36 }; // the auditorium roof, at the cornice
const PYLONS = [[-16.8, 44.4], [16.3, 46.4]];       // the Triga pylons, on the OSM sculpture nodes
const PORCH = [-7.5, 6.5, 48.2, 53.2];

export function ndFrame(kit, f) { return fitFrame(kit, f.o, 0, -1); }

/** A frustum between two rectangles of the frame, the lower at y0, the upper at y1 (faces only). */
function frustum(F, a, b, y0, y1) {
  const k = F.k;
  const A = [[a[0], a[2]], [a[1], a[2]], [a[1], a[3]], [a[0], a[3]]], B = [[b[0], b[2]], [b[1], b[2]], [b[1], b[3]], [b[0], b[3]]];
  const n = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4, [fx, fz] = F.dir(n[i][0], n[i][1]);
    k.quad(F.P(A[i][0], A[i][1], y0), F.P(A[j][0], A[j][1], y0), F.P(B[j][0], B[j][1], y1), F.P(B[i][0], B[i][1], y1), fx, 0.6, fz);
  }
}

export function buildNd(kit, f) {
  const { F } = ndFrame(kit, f);
  kit.floodFn = (x, y) => (y < E + 2 ? 0.95 - 0.012 * y : 0.7);
  const rows = [{ y: 1.8, h: 3.0, w: 1.6, arch: 1, hex: PANE, glow: 0.35, rev: 0.25 },
    { y: 7.4, h: 4.6, w: 2.0, arch: 1, hex: PANE, glow: 0.45, rev: 0.3 },
    { y: 14.2, h: 3.2, w: 1.6, arch: 1, hex: PANE, glow: 0.35, rev: 0.25 }];
  kit.set(STONE, K.stone);
  kit.ringWalls(f.o, 0, E, (e) => (e.len < 3.5 ? null : { pitch: 4.2, inset: 0.8, rows, seed: e.i }));
  kit.set(0x5b5f63, K.metal);
  kit.cap(f.o, null, E, true);
  // the rusticated base's string course, the cornice and the balustrade
  kit.set(STONE_DK, K.stone);
  kit.ringWalls(kit.offsetRing(f.o, -0.3), 5.6, 6.4);
  kit.ringWalls(kit.offsetRing(f.o, -0.5), E - 0.8, E);
  kit.set(STONE, K.stone);
  kit.ringWalls(kit.offsetRing(f.o, 0.2), E, E + 1.4);

  // ---- the auditorium roof: three steepening tiers, crest and crown --------
  const { u0, u1, v0, v1 } = AUD;
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2, hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const R = (s) => [um - hu * s, um + hu * s, vm - hv * s, vm + hv * s];
  const tiers = [[1, E + 1.2], [0.86, E + 5.2], [0.62, E + 8.8], [0.4, E + 10.6]];
  kit.set(ROOF, K.slate);
  for (let i = 0; i + 1 < tiers.length; i++) frustum(F, R(tiers[i][0]), R(tiers[i + 1][0]), tiers[i][1], tiers[i + 1][1]);
  const [t0, t1, t2, t3] = R(0.4);
  F.flat(t0, t1, t2, t3, E + 10.6, true);
  // the gilded crest along the top, and the gilt ribs down the corners
  kit.set(GOLD, K.metal);
  const yT = E + 10.6;
  F.box(t0, t1, t2 - 0.15, t2 + 0.15, yT, yT + 0.9);
  F.box(t0, t1, t3 - 0.15, t3 + 0.15, yT, yT + 0.9);
  F.box(t0 - 0.15, t0 + 0.15, t2, t3, yT, yT + 0.9);
  F.box(t1 - 0.15, t1 + 0.15, t2, t3, yT, yT + 0.9);
  for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    for (let i = 0; i + 1 < tiers.length; i++) {
      const s0 = tiers[i][0], s1 = tiers[i + 1][0];
      const A = F.P(um + du * hu * s0, vm + dv * hv * s0, tiers[i][1]), B = F.P(um + du * hu * s1, vm + dv * hv * s1, tiers[i + 1][1]);
      const [nx, nz] = F.dir(du, dv);
      kit.quad([A[0] - 0.12, A[1] + 0.1, A[2]], [A[0] + 0.12, A[1] + 0.1, A[2]], [B[0] + 0.12, B[1] + 0.1, B[2]], [B[0] - 0.12, B[1] + 0.1, B[2]], nx, 1, nz);
    }
  }
  // the crown: a gilt lantern with points round its rim
  const [cx, cz] = F.xz(um, vm);
  kit.lathe(cx, cz, [[2.2, yT], [2.4, yT + 0.6], [1.8, yT + 1.4], [2.3, yT + 2.6], [0.6, yT + 3.6], [0.25, yT + 5.2], [0, yT + 5.6]], 8, Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, x = cx + Math.cos(a) * 2.3, z = cz + Math.sin(a) * 2.3;
    kit.lathe(x, z, [[0.18, yT + 2.5], [0, yT + 3.4]], 4);
  }

  // ---- the stage house to the south: a lower hipped roof -------------------
  kit.set(ROOF, K.slate);
  F.roof(-17, 6, -43, AUD.v0 - 0.5, E + 1.2, E + 7.5, { hip0: 4, hip1: 4, over: 0.3 });
  F.roof(-17.5, 17.5, AUD.v1 + 0.5, 46, E + 1.2, E + 5.5, { hip0: 3.5, hip1: 3.5, over: 0.3 });

  // ---- the north front: the porch, the pylons and the Trigas -----------------
  const [p0, p1, q0, q1] = PORCH;
  kit.set(STONE, K.stone);
  F.box(p0, p1, q0, q1, 0, 9.5, { f: { cols: 3, rows: [{ y: 0, h: 6.4, w: 3.1, arch: 1, hex: 0x6f6658, kind: K.plaster, rev: 1.2 }] },
    l: { cols: 1, rows: [{ y: 0, h: 6.4, w: 2.6, arch: 1, hex: 0x6f6658, kind: K.plaster, rev: 1.2 }] },
    r: { cols: 1, rows: [{ y: 0, h: 6.4, w: 2.6, arch: 1, hex: 0x6f6658, kind: K.plaster, rev: 1.2 }] }, b: false });
  kit.set(STONE_DK, K.stone);
  F.box(p0 - 0.3, p1 + 0.3, q0, q1 + 0.3, 9.5, 10.6, null, true, true);
  kit.set(0xcfc4ae, K.stone);
  F.slab(rect(-4, 10.6, 3, 12.4), q1 - 0.4, q1);
  for (const [pu, pv] of PYLONS) {
    kit.set(STONE, K.stone);
    F.box(pu - 2.6, pu + 2.6, pv - 2.6, pv + 2.6, E, E + 4.2, null, true);
    kit.set(STONE_DK, K.stone);
    F.box(pu - 2.9, pu + 2.9, pv - 2.9, pv + 2.9, E + 4.2, E + 5.0, null, true, true);
    triga(kit, F.sub(pu, pv, E + 5.0), BRONZE);
  }
}

/** Three horses abreast and Victory in the chariot behind them, facing out of the front. */
function triga(kit, T, hex) {
  const was = kit.floodFn;
  kit.floodFn = () => 0.75;
  kit.set(hex, K.metal);
  const horse = [[-1.0, 0.0], [-0.8, 0.0], [-0.75, 0.9], [0.6, 0.9], [0.7, 0.0], [0.9, 0.0], [0.95, 1.0], [1.3, 1.6],
    [1.55, 2.1], [1.75, 2.0], [1.4, 1.3], [1.1, 1.55], [-1.0, 1.55]];
  for (const u of [-0.95, 0, 0.95]) T.slab(horse.map(([v, y]) => [v + 0.4, y]), u - 0.32, u + 0.32, true);
  T.box(-1.2, 1.2, -1.6, -0.6, 0, 1.0);
  T.box(-0.32, 0.32, -1.4, -0.9, 1.0, 2.7);
  const [x, z] = T.xz(0, -1.15);
  kit.lathe(x, z, [[0, 2.7 + T.y], [0.24, 2.85 + T.y], [0.2, 3.15 + T.y], [0, 3.3 + T.y]], 6);
  T.slab([[-0.35, 2.4], [-1.4, 3.3], [-1.3, 3.5], [-0.3, 2.6]], -1.2, -1.1);
  T.slab([[0.35, 2.4], [1.4, 3.3], [1.3, 3.5], [0.3, 2.6]], -1.2, -1.1);
  kit.floodFn = was;
}

/** Solid as built: the block to its cornice and the porch. */
export function ndSolids(f, l) {
  const { F } = ndFrame(null, f);
  return [{ ring: f.o, holes: f.i ?? null, top: l.top, bot: 0 }, { ring: F.ring(PORCH[0], PORCH[1], PORCH[2], PORCH[3]), holes: null, top: 9.5, bot: 0 }];
}
