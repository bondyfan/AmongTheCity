// ---- landmarks-karluv.js: Charles Bridge ----
// WORKER SAFE. The bridge of 1357: 516 m of sandstone on sixteen arches and
// fifteen massive piers, each pier with a pointed cutwater on both sides (and
// a wooden icebreaker upstream), a solid parapet with a coping all the way,
// and on the parapet over every pier a statue or a group on its plinth: thirty
// of them, black with weather against the pale stone.
//
// THE DECK STAYS THE TILE'S. The road ribbon of the 'Karlův most' ways is what
// feet and wheels stand on (geo.bridgeDeckHeight, anchored on the two banks);
// this model is everything round it, read off that same deck height, so the
// parapet stands on the paving that is drawn. The generic dressing of those
// ways (fascia, parapet, slim piers) is not drawn (js/landmarks.js
// landmarkBridge). The real deck stands 13 m over the water; the banks in the
// height data stand 5 to 7 m over it, so the arches are sized to the measured
// clearance instead of lifting both ends of the bridge over the streets.
//
// BUILT PER CHUNK. The bridge has no footprint in the tile and is longer than
// four chunks, so it is a footprint-less landmark (js/landmarks.js EXTRAS):
// every pier and every arch is one piece with its own anchor point on the
// centre line, and the chunk holding that point builds it, so nothing vanishes
// when one chunk unloads and every client builds the same pieces.
//
// The centre line and the pier stations are constants measured from the tile
// (the bridge ways plus the 25 statue props, which stand one per pier and side:
// round 7 survey, scratch piers2.mjs).

import { K } from './landmarkskit.js';
import { bridgeDeckHeight } from './geo.js';
import { GOLD } from './landmarks-parts.js';
import { figure } from './landmarks-gothic.js';

// the centre line from the east face of the Old Town tower to the west end:
// every vertex of the tile's bridge ways, because the real bridge bends (it
// is not straight) and the deck ribbon is drawn along those vertices. A chord
// from end to end stood the parapet 3.3 m off the paving at the first bend:
// over the water on one side, across the walkway on the other.
export const AXIS = [[-96181.4, -6057.1], [-96192.1, -6059.6], [-96275.7, -6080.1], [-96459.3, -6113.1],
  [-96502.4, -6123.2], [-96534.4, -6132.4], [-96607.4, -6154.2], [-96649.9, -6169.5], [-96666.1, -6175.2]];
// the indices of the two bridge ends in AXIS (the deck's first and last vertex)
const END0 = 1, END1 = AXIS.length - 2;
const CUM = [0];
for (let i = 1; i < AXIS.length; i++) CUM.push(CUM[i - 1] + Math.hypot(AXIS[i][0] - AXIS[i - 1][0], AXIS[i][1] - AXIS[i - 1][1]));
/** The pier stations, metres along AXIS. */
export const PIERS = [36.5, 67.6, 97.2, 128.7, 159.6, 190.4, 221.5, 252.5, 283.4, 313.4, 345.3, 377.3, 408.2, 439.6, 468.2];
const S0 = CUM[END0], S1 = CUM[END1];         // the two abutments: the bridge ends
const SUPPORTS = [S0, ...PIERS, S1];
const W = 5.0;                                 // half width to the outer face (the tile's 10 m way)
const PT = 0.45;                               // parapet thickness
const PH = 1.05;                               // parapet height over the deck
const T2 = 4.0;                                // half a pier's thickness along the bridge
const FOOT = 182;                              // piers go down to here: meets any water level
const SPRING = 185.6;                          // the arches spring here
const RIVER_END = 330;                         // past this the piers stand on Kampa (no icebreakers)

const STONE = 0xb3a68d, STONE_DK = 0x958a73, STONE_WET = 0x6e6656, COPING = 0xc2b69c,
  STATUE = 0x3b3833, WOOD = 0x3a2d22, IRON = 0x1e1f21;

/** Point, unit tangent and left normal of the centre line at station s. */
export function axisAt(s) {
  let i = 1;
  while (i < AXIS.length - 1 && CUM[i] < s) i++;
  const a = AXIS[i - 1], b = AXIS[i], L = CUM[i] - CUM[i - 1];
  const t = (s - CUM[i - 1]) / L, dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, dx, dz, -dz, dx];
}

/** The deck the tile's ribbon is drawn at, under (x, z); `fb` when no bridge way is near. */
const isWay = (r) => r.br && r.n === 'Karlův most' && r.p && r.p.length > 1;
function deckAt(ctx, x, z, fb) {
  let best = Infinity, way = null, along = 0;
  for (const r of ctx.roads ?? []) {
    if (!isWay(r)) continue;
    let acc = 0;
    for (let i = 0; i + 1 < r.p.length; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1], ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez, L = Math.sqrt(L2);
      let u = L2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const d = Math.hypot(x - ax - ex * u, z - az - ez * u);
      if (d < best) { best = d; way = r; along = acc + L * u; }
      acc += L;
    }
  }
  if (!way || best > 12 || !ctx.terrain) return fb;
  return bridgeDeckHeight(way, along, ctx.terrain);
}

// a point off the centre line: station s, offset o (left positive), height y
const at = (s, o, y) => { const [x, z, , , nx, nz] = axisAt(s); return [x + nx * o, y, z + nz * o]; };

/** The arch over span j: its two faces' stations and its intrados height at s. */
function archOf(j, deckMid) {
  const a = SUPPORTS[j] + (j === 0 ? 0 : T2), b = SUPPORTS[j + 1] - (j === SUPPORTS.length - 2 ? 0 : T2);
  const half = (b - a) / 2, mid = (a + b) / 2;
  const rise = Math.max(1.2, deckMid - 1.25 - SPRING);
  const R = (half * half + rise * rise) / (2 * rise);
  return { a, b, mid, y: (s) => SPRING + rise - R + Math.sqrt(Math.max(0, R * R - (s - mid) * (s - mid))) };
}

/** The stations along [a, b] a strip is cut at: every `step` metres and at every bend of the axis. */
function stations(a, b, step) {
  const out = [a];
  const n = Math.max(1, Math.ceil((b - a) / step));
  for (let i = 1; i < n; i++) out.push(a + (b - a) * i / n);
  for (let i = 1; i < CUM.length - 1; i++) if (CUM[i] > a + 0.05 && CUM[i] < b - 0.05) out.push(CUM[i]);
  out.push(b);
  return out.sort((p, q) => p - q);
}

/** The parapet, its coping and the cornice under it, on both sides from station a to b. */
function parapet(kit, ctx, a, b) {
  const st = stations(a, b, 6);
  const D = st.map((s) => { const p = at(s, 0, 0); return deckAt(ctx, p[0], p[2], 191); });
  for (const e of [-1, 1]) {
    for (let i = 0; i + 1 < st.length; i++) {
      const s0 = st[i], s1 = st[i + 1], d0 = D[i], d1 = D[i + 1];
      const [, , , , nx0, nz0] = axisAt((s0 + s1) / 2);
      const fx = nx0 * e, fz = nz0 * e;
      kit.set(STONE, K.stone);
      // outer face down to the cornice, inner face, and the coping on top
      kit.quad(at(s0, e * W, d0 - 0.25), at(s1, e * W, d1 - 0.25), at(s1, e * W, d1 + PH), at(s0, e * W, d0 + PH), fx, 0, fz);
      kit.quad(at(s0, e * (W - PT), d0 - 0.05), at(s1, e * (W - PT), d1 - 0.05), at(s1, e * (W - PT), d1 + PH), at(s0, e * (W - PT), d0 + PH), -fx, 0, -fz);
      kit.set(COPING, K.stone);
      kit.quad(at(s0, e * (W + 0.06), d0 + PH), at(s1, e * (W + 0.06), d1 + PH), at(s1, e * (W - PT - 0.06), d1 + PH + 0.08), at(s0, e * (W - PT - 0.06), d0 + PH + 0.08), 0, 1, 0);
      // the cornice: a course standing out 18 cm under the parapet
      kit.set(STONE_DK, K.stone);
      kit.quad(at(s0, e * (W + 0.18), d0 - 0.6), at(s1, e * (W + 0.18), d1 - 0.6), at(s1, e * (W + 0.18), d1 - 0.25), at(s0, e * (W + 0.18), d0 - 0.25), fx, 0, fz);
      kit.quad(at(s0, e * W, d0 - 0.25), at(s1, e * W, d1 - 0.25), at(s1, e * (W + 0.18), d1 - 0.25), at(s0, e * (W + 0.18), d0 - 0.25), 0, 1, 0);
      kit.quad(at(s0, e * W, d0 - 0.6), at(s1, e * W, d1 - 0.6), at(s1, e * (W + 0.18), d1 - 0.6), at(s0, e * (W + 0.18), d0 - 0.6), 0, -1, 0);
    }
  }
}

/** One arch: the two spandrel faces down to the intrados, and the soffit across. */
function arch(kit, ctx, j) {
  const pm = at((SUPPORTS[j] + SUPPORTS[j + 1]) / 2, 0, 0);
  const A = archOf(j, deckAt(ctx, pm[0], pm[2], 191));
  const st = stations(A.a, A.b, (A.b - A.a) / 10);
  const D = st.map((s) => { const p = at(s, 0, 0); return deckAt(ctx, p[0], p[2], 191); });
  for (let i = 0; i + 1 < st.length; i++) {
    const s0 = st[i], s1 = st[i + 1], y0 = A.y(s0), y1 = A.y(s1);
    const [, , dx, dz, nx, nz] = axisAt((s0 + s1) / 2);
    for (const e of [-1, 1]) {
      kit.set(STONE, K.stone);
      kit.quad(at(s0, e * W, y0), at(s1, e * W, y1), at(s1, e * W, D[i + 1] - 0.6), at(s0, e * W, D[i] - 0.6), nx * e, 0, nz * e);
      // the arch ring: voussoirs a shade darker, standing proud of the face
      kit.set(STONE_DK, K.stone);
      kit.quad(at(s0, e * (W + 0.12), y0), at(s1, e * (W + 0.12), y1), at(s1, e * (W + 0.12), y1 + 0.75), at(s0, e * (W + 0.12), y0 + 0.75), nx * e, 0, nz * e);
      kit.quad(at(s0, e * W, y0), at(s1, e * W, y1), at(s1, e * (W + 0.12), y1), at(s0, e * (W + 0.12), y0), 0, -1, 0);
    }
    // the soffit, darker with the damp, facing down and along the slope
    const sl = (y1 - y0) / (s1 - s0);
    kit.set(STONE_WET, K.stone);
    kit.quad(at(s0, -W, y0), at(s1, -W, y1), at(s1, W, y1), at(s0, W, y0), dx * sl, -1, dz * sl);
  }
}

/** One pier: the body, the two cutwaters, the upstream icebreaker and the two statues over it. */
function pier(kit, ctx, i) {
  const s = PIERS[i], p = at(s, 0, 0), deck = deckAt(ctx, p[0], p[2], 191);
  const [, , dx, dz, nx, nz] = axisAt(s);
  const a = s - T2, b = s + T2;
  kit.set(STONE, K.stone);
  for (const e of [-1, 1]) {
    // the outer face over the pier, from the foot to the cornice
    kit.quad(at(a, e * W, FOOT), at(b, e * W, FOOT), at(b, e * W, deck - 0.6), at(a, e * W, deck - 0.6), nx * e, 0, nz * e);
  }
  // the faces toward the arches, up to where the arches spring
  kit.quad(at(a, -W, FOOT), at(a, W, FOOT), at(a, W, SPRING + 0.05), at(a, -W, SPRING + 0.05), -dx, 0, -dz);
  kit.quad(at(b, -W, FOOT), at(b, W, FOOT), at(b, W, SPRING + 0.05), at(b, -W, SPRING + 0.05), dx, 0, dz);
  // the cutwaters: pointed prisms, capped by a steep stone hood against the face
  const top = SPRING + 2.3, reach = 4.4;
  for (const e of [-1, 1]) {
    const A = at(a, e * W, 0), B = at(b, e * W, 0), C = at(s, e * (W + reach), 0);
    const P = (q, y) => [q[0], y, q[2]];
    kit.set(STONE_DK, K.stone);
    kit.quad(P(A, FOOT), P(C, FOOT), P(C, top), P(A, top), e * nx - dx, 0, e * nz - dz);
    kit.quad(P(C, FOOT), P(B, FOOT), P(B, top), P(C, top), e * nx + dx, 0, e * nz + dz);
    const H = at(s, e * W, top + 2.6);
    kit.set(STONE, K.stone);
    kit.tri(P(A, top), P(C, top), H, e * nx - dx, 1, e * nz - dz);
    kit.tri(P(C, top), P(B, top), H, e * nx + dx, 1, e * nz + dz);
    // upstream (the south side, e = -1) a wooden icebreaker on the river piers
    if (e < 0 && s < RIVER_END) {
      const I = at(s, e * (W + reach + 3.2), 0), A2 = at(s - 1.4, e * (W + reach + 0.2), 0), B2 = at(s + 1.4, e * (W + reach + 0.2), 0);
      kit.set(WOOD, K.wood);
      kit.quad(P(A2, FOOT), P(I, FOOT), P(I, SPRING + 0.9), P(A2, SPRING + 0.9), e * nx - dx, 0, e * nz - dz);
      kit.quad(P(I, FOOT), P(B2, FOOT), P(B2, SPRING + 0.9), P(I, SPRING + 0.9), e * nx + dx, 0, e * nz + dz);
      kit.tri(P(A2, SPRING + 0.9), P(I, SPRING + 0.9), P(B2, SPRING + 0.9), 0, 1, 0);
    }
  }
  // the statues: a plinth on the parapet, and the saint (or the group) on it
  const was = kit.floodFn;
  kit.floodFn = () => 0.9;
  for (const e of [-1, 1]) {
    const c = at(s, e * (W - 0.3), 0), yb = deck + PH;
    const o = (u, v) => [c[0] + dx * u + nx * e * v, c[2] + dz * u + nz * e * v];
    kit.set(STONE_DK, K.stone);
    const ring = [o(-0.85, -0.55), o(0.85, -0.55), o(0.85, 0.75), o(-0.85, 0.75)];
    for (let k = 0; k < 4; k++) {
      const q0 = ring[k], q1 = ring[(k + 1) % 4], mx = (q0[0] + q1[0]) / 2 - c[0], mz = (q0[1] + q1[1]) / 2 - c[2];
      kit.wall(q0, q1, yb - 0.2, yb + 1.9, mx, mz);
    }
    kit.set(COPING, K.stone);
    kit.cap(ring, null, yb + 1.9, true);
    // which saint: a hash of the pier and side keeps the line varied and fixed
    const k = (i * 2 + (e > 0 ? 1 : 0)) % 5;
    const [fx, fz] = o(0, 0.1);
    figure(kit, fx, fz, yb + 1.9, k === 1 ? 2.2 : 2.7, STATUE, K.stone, i * 0.7 + e);
    if (k === 0 || k === 3) {
      // a group: a second, smaller figure beside the first
      const [gx, gz] = o(0.55, 0.25);
      figure(kit, gx, gz, yb + 1.9, 1.7, STATUE, K.stone, i);
    }
    if (k === 2) {
      // St John of Nepomuk and his like carry a cross; gilt stars round the head
      kit.set(IRON, K.metal);
      kit.lathe(fx - dx * 0.45, fz - dz * 0.45, [[0.05, yb + 1.9], [0.05, yb + 4.6], [0, yb + 4.6]], 4);
      kit.set(GOLD, K.metal);
      for (let q = 0; q < 5; q++) {
        const ang = q * 1.2566;
        kit.lathe(fx + Math.cos(ang) * 0.32, fz + Math.sin(ang) * 0.32, [[0, yb + 4.75], [0.07, yb + 4.82], [0, yb + 4.89]], 4);
      }
    }
  }
  kit.floodFn = was;
}

/** The lanterns between the statues: an iron post on the coping with a lit glass head. */
function lantern(kit, ctx, s) {
  const p = at(s, 0, 0), deck = deckAt(ctx, p[0], p[2], 191);
  for (const e of [-1, 1]) {
    const c = at(s, e * (W - PT / 2), 0), y = deck + PH + 0.08;
    kit.set(IRON, K.metal);
    kit.lathe(c[0], c[2], [[0.14, y], [0.1, y + 0.4], [0.06, y + 0.5], [0.06, y + 2.6], [0.12, y + 2.7]], 6);
    kit.set(0xf3dcaa, K.metal);
    kit.gl = 1;
    kit.lathe(c[0], c[2], [[0.17, y + 2.7], [0.24, y + 3.25], [0.2, y + 3.3]], 6);
    kit.set(IRON, K.metal);
    kit.lathe(c[0], c[2], [[0.27, y + 3.3], [0.06, y + 3.6], [0, y + 3.75]], 6);
  }
}

/**
 * The pieces of the bridge chunk ctx.key owns (js/landmarks.js EXTRAS). Each
 * span is the arch and the parapet from pier to pier; each pier its body,
 * cutwaters and statues; anchors on the centre line.
 */
export function buildKarluv(kit, ctx) {
  if (!ctx.terrain) return;
  const own = (s) => { const [x, z] = axisAt(s); return ctx.chunkOf(x, z) === ctx.key; };
  kit.floodFn = (x, y) => (y < SPRING ? 0.2 : 0.6);
  for (let j = 0; j + 1 < SUPPORTS.length; j++) {
    const mid = (SUPPORTS[j] + SUPPORTS[j + 1]) / 2;
    if (!own(mid)) continue;
    arch(kit, ctx, j);
    parapet(kit, ctx, SUPPORTS[j], SUPPORTS[j + 1]);
    lantern(kit, ctx, mid);
  }
  for (let i = 0; i < PIERS.length; i++) if (own(PIERS[i])) pier(kit, ctx, i);
}

/** The box the bridge lies in (js/landmarks.js EXTRAS). */
export const KARLUV_BOX = (() => {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of AXIS) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  return [x0 - 20, z0 - 20, x1 + 20, z1 + 20];
})();
/** Where its statues and the cross the tile has stand on the riverbed: a capsule per segment. */
export const KARLUV_ZONES = AXIS.slice(END0, END1 + 1).map((p, i, a) => (i + 1 < a.length ? [p[0], p[1], a[i + 1][0], a[i + 1][1], 8.5] : null)).filter(Boolean);
