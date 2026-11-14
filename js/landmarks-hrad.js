// ---- landmarks-hrad.js: Prague Castle, and the registry of the wide Prague landmarks ----
// WORKER SAFE (in the mesher's import graph through js/landmarks.js).
//
// THE CASTLE. The tile holds the whole Pacassi complex as ONE footprint
// (relation 3367557, 20 366 m2, 279 vertices, misnamed "Císařská konírna"):
// the long south front over Malá Strana, the wings round the 2nd courtyard
// and the 1st courtyard's notch on the west. It is founded at 239.5 m because
// its north side stands over the Stag Moat, yet its courtyards lie at 257, so
// the generic 25 m prism was a 7.5 m wall seen from inside. Here every wall
// is founded on the ground under ITS OWN edge (kit.rel) and all of them share
// one cornice, 18 m over the courtyards, so the south front stands its full
// 29 m over the gardens and the courtyard walls their four storeys.
//
// THE MATTHIAS GATE (1614) is the way from the 1st courtyard into the 2nd: a
// vaulted passage straight through the west wing, measured off the tile's two
// footways that end on its mouths (outer vertex at -97278.3,-6520.2, courtyard
// vertex at -97264.1,-6527.9). The walls open there, and collision is the
// footprint with a channel cut through it (keyhole ring) plus the masonry over
// the passage as a `bot` piece.

import { K } from './landmarkskit.js';
import { Frame } from './landmarksframe.js';
import { rect } from './landmarks-parts.js';
import { ringRoof, rowsFromTop } from './landmarks-prahaparts.js';
import { buildVit, vitSolids } from './landmarks-vit.js';
import { buildNm, nmSolids, buildVaclav } from './landmarks-nm.js';
import { buildNd, ndSolids } from './landmarks-nd.js';
import { buildTancici } from './landmarks-tancici.js';
import { buildZizkov, zizkovSolids } from './landmarks-zizkov.js';
import { buildPetrin, petrinSolids } from './landmarks-petrin.js';
import { buildVysehrad, vysehradSolids } from './landmarks-vysehrad.js';

const WALL = 0xe2dac4, STONE = 0xc9bfa6, ROOF = 0x66796f, PANE = 0x46535e;
const COURT = 257.2;                 // the courtyards, absolute (survey: 257.1 to 257.3)
const CORNICE = COURT + 18;          // one cornice for every wing, absolute
const GATE_OUT = [-97278.3, -6520.2], GATE_IN = [-97264.1, -6527.9], GATE_W = 4.6, GATE_H = 7.2;

const nearest = (ring, p) => {
  let best = -1, bd = 2.5;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - p[0], ring[i][1] - p[1]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

/** The passage: its frame (v along it, out toward the 1st courtyard), half length, and its two mouths. */
function gate(kit, f) {
  const mo = nearest(f.o, GATE_OUT);
  let hole = -1, mh = -1;
  (f.i ?? []).forEach((h, k) => { const i = nearest(h, GATE_IN); if (i >= 0) { hole = k; mh = i; } });
  if (mo < 0 || mh < 0) return null;
  const A = f.o[mo], B = f.i[hole][mh];
  const G = new Frame(kit, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, A[0] - B[0], A[1] - B[1]);
  return { G, half: Math.hypot(A[0] - B[0], A[1] - B[1]) / 2, mo, hole, mh };
}

export function buildHrad(kit, f) {
  const E = CORNICE - kit.ground;
  const g = gate(kit, f);
  kit.floodFn = (x, y) => (y > E - 14 ? 0.7 : 0.45);
  // One wall per edge, founded under that edge. Around a passage mouth the
  // two edges that meet there become three walls: up to the arch, the arch
  // itself (one bay with a real hole in it), and on.
  const walls = (ring, hole, mouth) => {
    const S = (ringArea2(ring) > 0 ? 1 : -1) * (hole ? -1 : 1);
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 0.05) continue;
      const nx = S * ez / L, nz = -S * ex / L;
      const y0 = Math.min(kit.rel(a[0], a[1]), kit.rel(b[0], b[1])) - 0.6;
      const grid = (yy) => (L < 3.4 ? null : { pitch: 3.9, inset: 0.6, seed: i + (hole ? 400 : 0),
        rows: rowsFromTop(yy, E, 3.8, 2.2, 1.3, { hex: PANE, glow: 0.22, mezz: true }) });
      const atMouth = mouth >= 0 && (i === mouth || (i + 1) % n === mouth);
      if (!atMouth) { const sp = grid(y0); if (sp) kit.wallGrid(a, b, y0, E, nx, nz, sp); else kit.wall(a, b, y0, E, nx, nz); continue; }
      // the edge runs into (or out of) the mouth vertex: stop short of the arch
      const m = ring[mouth], far = i === mouth ? b : a;
      const dx = (far[0] - m[0]) / L, dz = (far[1] - m[1]) / L, r = GATE_W / 2 + 0.5;
      const cut = [m[0] + dx * r, m[1] + dz * r];
      const yc = kit.rel(m[0], m[1]) - 0.6;
      const sp = grid(y0);
      if (L > r + 0.5) { if (sp) kit.wallGrid(cut, far, y0, E, nx, nz, sp); else kit.wall(cut, far, y0, E, nx, nz); }
      halfArch(kit, m, cut, yc, E, nx, nz);
    }
  };
  kit.set(WALL, K.plaster);
  walls(f.o, false, g ? g.mo : -1);
  (f.i ?? []).forEach((h, k) => { if (h.length >= 3) walls(h, true, g && g.hole === k ? g.mh : -1); });
  // the cornice, a stone band proud of every wall, so the long fronts end in a line
  kit.set(STONE, K.stone);
  kit.ringWalls(kit.offsetRing(f.o, -0.35), E - 1.1, E);
  for (const h of f.i ?? []) if (h.length >= 3) kit.ringWalls(kit.offsetRing(h, 0.35), E - 1.1, E, null, true);
  kit.set(ROOF, K.copper);
  ringRoof(kit, f.o, f.i, E, 6, 5.5, 0.45);
  if (g) gateDress(kit, g, E);
}

/**
 * Half of the gate's arch in a wall that runs from the mouth vertex m (the
 * passage's centre line) to c: the jamb beyond the opening, the wall over the
 * crown, and the spandrel between the round arch and the crown line.
 */
function halfArch(kit, m, c, yc, E, nx, nz) {
  const L = Math.hypot(c[0] - m[0], c[1] - m[1]), dx = (c[0] - m[0]) / L, dz = (c[1] - m[1]) / L;
  const hw = GATE_W / 2, P = (s, y) => [m[0] + dx * s, y, m[1] + dz * s];
  const crown = yc + 0.6 + GATE_H, spring = crown - hw;
  kit.quad(P(hw, yc), P(L, yc), P(L, E), P(hw, E), nx, 0, nz);
  kit.quad(P(0, crown), P(hw, crown), P(hw, E), P(0, E), nx, 0, nz);
  const N = 5;
  for (let k = 0; k < N; k++) {
    const a0 = k / N * Math.PI / 2, a1 = (k + 1) / N * Math.PI / 2;
    kit.tri(P(hw, crown), P(hw * Math.cos(a0), spring + hw * Math.sin(a0)), P(hw * Math.cos(a1), spring + hw * Math.sin(a1)), nx, 0, nz);
  }
}

/** Signed area, local copy (the kit's own is imported by every other module; this keeps the edge loop self-contained). */
function ringArea2(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

/** The vault through the wing, and the triumphal arch on its face to the 1st courtyard. */
function gateDress(kit, g, E) {
  const { G, half } = g;
  const y0 = kit.rel(G.ox, G.oz);
  const T = G.sub(0, 0, y0);
  kit.set(0xb9ae96, K.stone);
  T.tunnel(0, GATE_W, -half - 0.3, half + 0.3, GATE_H + 0.6, 1);
  kit.set(0x8f877b, K.stone);
  T.flat(-GATE_W / 2, GATE_W / 2, -half - 0.3, half + 0.3, 0.05, true);
  // Scamozzi's arch: rusticated piers, an entablature, the attic with the
  // inscription, obelisks on top; it stands proud of the wing by a metre
  const v = half + 0.05;
  kit.set(0xd4cbb4, K.stone);
  for (const s of [-1, 1]) {
    T.slab(rect(s * (GATE_W / 2 + 0.1), 0, s * (GATE_W / 2 + 2.6), 9.8), v, v + 1.0);
    T.slab(rect(s * (GATE_W / 2 + 0.6), 9.8, s * (GATE_W / 2 + 2.2), 13.4), v + 0.2, v + 0.9);
  }
  T.slab(rect(-GATE_W / 2 - 3.0, 9.8, GATE_W / 2 + 3.0, 11.0), v, v + 1.2);
  T.slab([[-GATE_W / 2, 7.8], [GATE_W / 2, 7.8], [GATE_W / 2, 9.8], [-GATE_W / 2, 9.8]], v + 0.3, v + 0.9);
  kit.set(0x2a2622, K.metal);
  T.slab(rect(-2.2, 11.3, 2.2, 12.9), v + 0.9, v + 1.0);
  kit.set(0xd4cbb4, K.stone);
  T.slab([[-GATE_W / 2 - 3.0, 13.4], [GATE_W / 2 + 3.0, 13.4], [0, 15.6]], v + 0.1, v + 0.8);
  // the two Plečnik flagpoles before it, 25 m of fir
  kit.set(0x6a4a2c, K.wood);
  for (const s of [-1, 1]) {
    const [x, z] = T.xz(s * 9, half + 8);
    kit.lathe(x, z, [[0.32, y0 - 0.3], [0.3, y0 + 4], [0.12, y0 + 25], [0, y0 + 25.4]], 6);
  }
}

/**
 * Solid as built: the whole footprint to the cornice over the courtyards, with
 * the passage cut out of it as a channel joining the outer ring to the 2nd
 * courtyard (one simple ring, the courtyard inside it), and the masonry over
 * the passage as a piece walked under.
 */
export function hradSolids(f) {
  const base = f._gy ?? 239.5;              // its founding height (terrain.groundFor caches it; 239.5 measured)
  const top = CORNICE - base;
  const g = gate(null, f);
  if (!g) return [{ ring: f.o, holes: f.i ?? null, top, bot: 0 }];
  const { G, half, mo, hole, mh } = g;
  const O = f.o, H = f.i[hole], hw = GATE_W / 2 - 0.3;
  const want = Math.abs(ringArea2(O)) - Math.abs(ringArea2(H)) - 2 * hw * 2 * half;
  let best = null, bd = Infinity;
  for (const s of [1, -1]) for (const dir of [1, -1]) {
    const r = O.slice(0, mo);
    r.push(G.xz(s * hw, half), G.xz(s * hw, -half));
    for (let k = 1; k < H.length; k++) r.push(H[(mh + dir * k + H.length * 2) % H.length]);
    r.push(G.xz(-s * hw, -half), G.xz(-s * hw, half));
    r.push(...O.slice(mo + 1));
    const d = Math.abs(Math.abs(ringArea2(r)) - want);
    if (d < bd) { bd = d; best = r; }
  }
  const others = f.i.filter((h, k) => k !== hole);
  return [{ ring: best, holes: others.length ? others : null, top, bot: 0 },
    { ring: [G.xz(-hw - 0.4, -half), G.xz(hw + 0.4, -half), G.xz(hw + 0.4, half), G.xz(-hw - 0.4, half)], holes: null, top, bot: COURT - base + GATE_H + 0.6 }];
}

/**
 * The wide Prague landmarks. Every entry carries `region: 'praha'`. `kind`
 * must equal the footprint's type; `hide` takes a duplicate or companion
 * footprint out of the generic city without a model of its own (Žižkov's tile
 * holds the one tower as eleven overlapping rings, one of them upside down).
 */
const R = 'praha';
const HIDE = { hide: true, build: () => {}, solids: () => [] };
const Z_AT = [-93496.6, -5486.3];
/**
 * Where the wide landmarks keep the ground free of the surface model's trees
 * (landmarks.js landmarkClear): capsules [ax, az, bx, bz, r]. The castle's
 * 1st and 2nd courtyards are paved squares, and the Matthias Gate between
 * them is the way in.
 */
export const CLEAR_WIDE = [
  [-97292, -6508, -97300, -6548, 14],     // the 1st courtyard (Čestné nádvoří)
  [-97300, -6528, -97240, -6512, 4],      // ...through the Matthias Gate
  [-97250, -6478, -97216, -6548, 20],     // the 2nd courtyard
];
/**
 * Props the tile scatters where a wide landmark now stands outside its own
 * footprint (landmarks.js landmarkProp): points [x, z, r]. The five memorial
 * boxes of St Wenceslas and his saints, and the two Trigas the tile drew at
 * ground level beside the theatre.
 */
export const PROP_WIDE = [
  [-95032.3, -5347.1, 6.5],
  [-96211.9, -5510.2, 2.5], [-96178.3, -5511.2, 2.5],
];

export const LANDMARKS_WIDE = [
  { id: 'hrad', region: R, name: 'Císařská konírna', at: [-97181.2, -6520.0], area: 20366, r: 15, tol: 0.1, top: 35.5, build: buildHrad, solids: hradSolids },
  { id: 'vit', region: R, name: 'Katedrála svatého Víta', at: [-97121.4, -6579.4], area: 5513, r: 10, tol: 0.15, top: 15, build: buildVit, solids: vitSolids },
  { id: 'nd', region: R, name: 'Národní divadlo', at: [-96189.3, -5469.7], area: 3099, r: 10, tol: 0.15, top: 20, reach: 7, build: buildNd, solids: ndSolids },
  { id: 'nd-sever', region: R, kind: 'yes', at: [-96195.4, -5516.1], area: 169, r: 4, tol: 0.15, ...HIDE },
  { id: 'tancici', region: R, name: 'Tančící dům', at: [-96147.0, -4861.1], area: 663, r: 6, tol: 0.15, top: 28, build: buildTancici },
  { id: 'nm', region: R, name: 'Národního muzea', at: [-94945.7, -5250.5], area: 7588, r: 10, tol: 0.15, top: 24, build: buildNm, solids: nmSolids, grounds: buildVaclav },
  { id: 'zizkov', region: R, kind: 'industrial', name: 'Žižkovský vysílač', at: Z_AT, area: 475.8, r: 3, tol: 0.08, top: 5.5, reach: 4, build: buildZizkov, solids: zizkovSolids },
  { id: 'zizkov-x1', region: R, kind: 'industrial', at: Z_AT, area: 391, r: 3, tol: 0.06, ...HIDE },
  { id: 'zizkov-x2', region: R, kind: 'industrial', at: [-93496.7, -5486.7], area: 100.4, r: 3, tol: 0.1, ...HIDE },
  { id: 'zizkov-x3', region: R, kind: 'industrial', at: [-93493.6, -5487.5], area: 18.2, r: 9, tol: 0.1, ...HIDE },
  { id: 'zizkov-x4', region: R, kind: 'industrial', at: [-93503.7, -5485.1], area: 32.5, r: 3, tol: 0.1, ...HIDE },
  { id: 'zizkov-x5', region: R, kind: 'yes', at: Z_AT, area: 475.8, r: 3, tol: 0.08, ...HIDE },
  { id: 'zizkov-x6', region: R, kind: 'yes', at: [-93503.5, -5485.1], area: 10.2, r: 3, tol: 0.2, ...HIDE },
  { id: 'zizkov-x7', region: R, kind: 'yes', sky: true, at: [-93503.6, -5485.2], area: 40.6, r: 3, tol: 0.15, ...HIDE },
  { id: 'petrin', region: R, name: 'Petřínská rozhledna', at: [-97513.6, -5761.8], area: 544, r: 6, tol: 0.15, top: 4, build: buildPetrin, solids: petrinSolids },
  { id: 'vysehrad', region: R, name: 'svatý Petr a Pavel', at: [-95883.4, -3638.6], area: 1354, r: 8, tol: 0.15, top: 14, build: buildVysehrad, solids: vysehradSolids },
];
