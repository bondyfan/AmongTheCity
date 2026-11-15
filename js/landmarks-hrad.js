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
// the passage as a `bot` piece. The other passages out of the 2nd courtyard
// (east to the 3rd courtyard, north to the Powder Bridge, south-west to the
// Garden on the Bastion) and the arch cut shared by all of them live in
// js/landmarks-hradpass.js.

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
import { passages, cutsOf, cutWall, vault, passSolids } from './landmarks-hradpass.js';
import { VALY_EXTRA, isVysehradWall } from './landmarks-vysehradvaly.js';
import { OBRI_EXTRA, isObriBarrier } from './landmarks-hradobri.js';

const WALL = 0xe2dac4, STONE = 0xc9bfa6, ROOF = 0x66796f, PANE = 0x46535e;
const COURT = 257.2;                 // the courtyards, absolute (survey: 257.1 to 257.3)
const CORNICE = COURT + 18;          // one cornice for every wing, absolute
const GATE_W = 4.6, GATE_H = 7.2;    // the Matthias Gate (its mouths: js/landmarks-hradpass.js PASSAGES)

/** The Matthias Gate as a passage of js/landmarks-hradpass.js (its frame, half length and mouths), or null. */
function gate(kit, f) { return passages(kit, f).find((q) => q.p.id === 'matyas') ?? null; }

export function buildHrad(kit, f) {
  const E = CORNICE - kit.ground;
  const ps = passages(kit, f);
  kit.floodFn = (x, y) => (y > E - 14 ? 0.7 : 0.45);
  // One wall per edge, founded under that edge; where an edge crosses a
  // passage it is cut along that passage's arch (js/landmarks-hradpass.js).
  const walls = (ring, hole) => {
    const S = (ringArea2(ring) > 0 ? 1 : -1) * (hole ? -1 : 1);
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i], b = ring[(i + 1) % n];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 0.05) continue;
      const nx = S * ez / L, nz = -S * ex / L;
      const y0 = Math.min(kit.rel(a[0], a[1]), kit.rel(b[0], b[1])) - 0.6;
      const body = (p, q, yy) => {
        const sp = Math.hypot(q[0] - p[0], q[1] - p[1]) < 3.4 ? null : { pitch: 3.9, inset: 0.6, seed: i + (hole ? 400 : 0),
          rows: rowsFromTop(yy, E, 3.8, 2.2, 1.3, { hex: PANE, glow: 0.22, mezz: true }) };
        if (sp) kit.wallGrid(p, q, yy, E, nx, nz, sp); else kit.wall(p, q, yy, E, nx, nz);
      };
      const cuts = cutsOf(a, b, ps);
      if (cuts.length) cutWall(kit, a, b, y0, E, nx, nz, cuts, body); else body(a, b, y0);
    }
  };
  kit.set(WALL, K.plaster);
  walls(f.o, false);
  (f.i ?? []).forEach((h) => { if (h.length >= 3) walls(h, true); });
  // the cornice, a stone band proud of every wall, so the long fronts end in a line
  kit.set(STONE, K.stone);
  kit.ringWalls(kit.offsetRing(f.o, -0.35), E - 1.1, E);
  for (const h of f.i ?? []) if (h.length >= 3) kit.ringWalls(kit.offsetRing(h, 0.35), E - 1.1, E, null, true);
  kit.set(ROOF, K.copper);
  ringRoof(kit, f.o, f.i, E, 6, 5.5, 0.45);
  // the vaults: stone, paved where the passage is level (the north one falls
  // to the Powder Bridge and keeps the ground as it runs)
  for (const q of ps) {
    kit.set(0xb9ae96, K.stone);
    vault(kit, f, q, q.p.id === 'sever' ? 0 : 0x8f877b);
    if (q.p.id === 'matyas') gateDress(kit, q, E);
  }
}

/** Signed area, local copy (the kit's own is imported by every other module; this keeps the edge loop self-contained). */
function ringArea2(r) { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; }

/** The triumphal arch on the Matthias Gate's face to the 1st courtyard, and the flagpoles before it. */
function gateDress(kit, g, E) {
  const { G, half } = g;
  const y0 = kit.rel(G.ox, G.oz);
  const T = G.sub(0, 0, y0);
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
 * the Matthias Gate cut out of it as a channel joining the outer ring to the
 * 2nd courtyard (one simple ring, the courtyard inside it), the other
 * passages splitting that ring where they cross it, and the masonry over
 * every passage as a piece walked under.
 */
export function hradSolids(f) {
  const base = f._gy ?? 239.5;              // its founding height (terrain.groundFor caches it; 239.5 measured)
  const top = CORNICE - base;
  const g = gate(null, f);
  if (!g) return [{ ring: f.o, holes: f.i ?? null, top, bot: 0 }];
  const { G, half, hole } = g, mo = g.mo[0], mh = g.mh[0];
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
  // the other passages out of the same courtyard each split the ring they cross
  const rest = passages(null, f).filter((q) => q !== g && q.p.id !== g.p.id && q.hole === hole);
  const { rings, over } = passSolids([best], rest, base, top);
  return [...rings.map((r) => ({ ring: r, holes: others.length ? others : null, top, bot: 0 })),
    { ring: [G.xz(-hw - 0.4, -half), G.xz(hw + 0.4, -half), G.xz(hw + 0.4, half), G.xz(-hw - 0.4, half)], holes: null, top, bot: COURT - base + GATE_H + 0.6 },
    ...over];
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
  // the 3rd courtyard, paved from St Vitus's west front past the Golden Gate
  // to the Old Royal Palace (a lime stood against the great south tower)
  [-97185, -6545, -97075, -6530, 15],
  [-97200, -6549, -97182, -6570, 9],      // ...out of the east passage to the cathedral's west front
  // the paved terrace round the foot of the Žižkov tower (a spruce grew
  // through one of its legs)
  [-93503.5, -5485.3, -93503.5, -5485.3, 21],
];
/**
 * The footprint-less pieces of the wide set (js/landmarks.js EXTRAS): the
 * Vyšehrad ramparts, and the railing of the castle's 1st courtyard with the
 * Gate of Giants. Each replaces one barrier of the tile, which the generic
 * ribbon would draw through it (isWideBarrier).
 */
export const EXTRAS_WIDE = [VALY_EXTRA, OBRI_EXTRA];
/** Is this barrier one a wide piece draws itself? WORKER SAFE. */
export function isWideBarrier(f) { return isVysehradWall(f) || isObriBarrier(f); }
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
  // a 9 m brick box the tile stands against the theatre's river corner, in front of its west front
  { id: 'nd-zapad', region: R, kind: 'yes', at: [-96215.6, -5498.8], area: 75.5, r: 3, tol: 0.15, ...HIDE },
  { id: 'tancici', region: R, name: 'Tančící dům', at: [-96147.0, -4861.1], area: 663, r: 6, tol: 0.15, top: 28, build: buildTancici },
  // the monument's own footprint (h 1, gabled), drawn as a little house over the statue's plinth
  { id: 'vaclav-pomnik', region: R, name: 'Pomník svatého Václava', at: [-95031.9, -5346.8], area: 76.4, r: 3, tol: 0.15, ...HIDE },
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
