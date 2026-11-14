// ---- landmarks-valy.js: the ramparts of the chateau ----
// WORKER SAFE. "Valy": what Vilém of Pernštejn threw up round his palace after
// 1491, and what Pardubice still walks its dogs on. A square of earth eleven
// metres high with a round gun bastion (rondel) on each corner, a wall with
// loopholes along its foot, the moat outside it (dry and grassed today) and
// one way in: from Příhrádek over the bridge, between two walls that close
// like a funnel, through the gate.
//
// THE EARTH IS THE TERRAIN'S. The survey (DMR 5G) holds the banks and the
// bastions already, and the footways on their crest are levelled into it like
// every other way, so people, trees and benches stand on them without this
// file knowing. What the survey cannot hold at 20 m a sample is anything with
// an edge: that is what is modelled here, on the lines the tile gives for it
// (its one `citywall` barrier and the two walls of the inner moat, which this
// replaces: landmarkBarrier in js/landmarks.js).
//
// It is built with the palace (js/landmarks-zamek.js) and rides in the palace's
// chunk, so the whole fortress arrives as one piece.

import { K, ringArea, hash2 } from './landmarkskit.js';
import { VALY } from './valyring.js';

// The foot wall, a closed ring: the tile's citywall barrier as surveyed, now
// in js/valyring.js, which the terrain reads too (the moat is dug along it).
export { VALY };
// the stretch the gate and the house beside it stand ON: no wall across the portal
const GAP = [[1538.6, -1037.2], [1544.5, -1053.1]];
/** The gate, where the funnel ends: the floodlight is spent 45 m from here. */
export const GATE_AT = [1532, -1041.4];
// the bridge from Příhrádek, as the road runs: the stone bridge of 1805 (the
// tile's 7 m bridge way, s -7.2 to 0, which the generic ribbon dresses in a
// steel railing) and the embankment it was built with, as far as the path
// that climbs out of the moat to join it. The parapets' inner face stands 5 cm
// inside the deck's edge, so the railing and the kerb faces are inside them.
const BRIDGE = [[1576.7, -1018.6], [1546, -1038]], SPAN = [-7.6, 18.5], DECK = 2.35;
// the parapet's coping over the TERRAIN (the deck lies about 0.2 m over it,
// and the steel railing inside rises 0.9 m over the deck)
const BRIDGE_H = 1.3;

// The two walls the tile draws along the inner moat, either side of the bridge
// to the palace portal. Drawn by the generic ribbon they are 2 m of grey that
// hides the portal from the whole outer court; they are the moat's parapets,
// waist high, in the stone of the bridge (the moat itself is narrower than the
// survey's 20 m samples, so the ground does not dip for it).
const INNER = [
  [[1466.3, -1067.4], [1472.6, -1064.6], [1472.7, -1061.6], [1468, -1054.4]],
  [[1473.1, -1051.8], [1476.4, -1059.8], [1479, -1061.9], [1480.4, -1061.8], [1496.8, -1053.9], [1492.4, -1050.1]],
];
const PARAPET_H = 1.05, PARAPET_T = 0.5;

const STONE = 0xa99d87, BRICK = 0x9b6249, COPING = 0x8a8273, SLIT = 0x1b1916;
const WALL_H = 4.8, WALL_MIN = 1.7, THICK = 0.9;
// The bank behind the wall crests about here (absolute metres): where the soft
// ground of the survey already stands high at the wall's foot, the wall is the
// lower for it, so it never stands taller than the rampart it guards.
const CREST = 225.2;

const same = (p, q) => Math.abs(p[0] - q[0]) < 0.3 && Math.abs(p[1] - q[1]) < 0.3;

/** The wall, the bridge parapets: everything of the fortress that is masonry. */
export function buildValy(kit) {
  const ao = kit.ao, flood = kit.floodFn;
  kit.ao = false;                       // heights here are not "above the pavement"
  kit.floodFn = (x, y, z) => 0.55 * (1 - Math.hypot(x - GATE_AT[0], z - GATE_AT[1]) / 45);
  wall(kit);
  bridge(kit);
  for (const line of INNER) parapet(kit, line);
  kit.ao = ao; kit.floodFn = flood;
}

function wall(kit) {
  const S = ringArea(VALY) > 0 ? 1 : -1, n = VALY.length;
  const inner = kit.offsetRing(VALY, THICK);
  const top = (x, z) => {
    const g = kit.rel(x, z);
    return g + Math.max(WALL_MIN, Math.min(WALL_H, CREST - kit.ground - g));
  };
  for (let i = 0; i < n; i++) {
    const a = VALY[i], b = VALY[(i + 1) % n], a2 = inner[i], b2 = inner[(i + 1) % n];
    if ((same(a, GAP[0]) && same(b, GAP[1])) || (same(a, GAP[1]) && same(b, GAP[0]))) continue;
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    if (L < 0.05) continue;
    const nx = S * ez / L, nz = -S * ex / L;
    const m = Math.max(1, Math.ceil(L / 5));
    for (let k = 0; k < m; k++) {
      const t0 = k / m, t1 = (k + 1) / m;
      const p0 = [a[0] + ex * t0, a[1] + ez * t0], p1 = [a[0] + ex * t1, a[1] + ez * t1];
      const q0 = [a2[0] + (b2[0] - a2[0]) * t0, a2[1] + (b2[1] - a2[1]) * t0];
      const q1 = [a2[0] + (b2[0] - a2[0]) * t1, a2[1] + (b2[1] - a2[1]) * t1];
      const g0 = kit.rel(p0[0], p0[1]), g1 = kit.rel(p1[0], p1[1]);
      const h0 = top(p0[0], p0[1]), h1 = top(p1[0], p1[1]);
      const face = (u, v, lo0, lo1, hi0, hi1, fx, fz) =>
        kit.quad([u[0], lo0, u[1]], [v[0], lo1, v[1]], [v[0], hi1, v[1]], [u[0], hi0, u[1]], fx, 0, fz);
      // outside: rubble stone, the brick of later repairs under the coping
      kit.set(STONE, K.stone); face(p0, p1, g0 - 1.2, g1 - 1.2, h0 - 1.15, h1 - 1.15, nx, nz);
      kit.set(BRICK, K.brick); face(p0, p1, h0 - 1.15, h1 - 1.15, h0 - 0.22, h1 - 0.22, nx, nz);
      kit.set(COPING, K.stone); face(p0, p1, h0 - 0.22, h1 - 0.22, h0, h1, nx, nz);
      // inside, where the bank lies against it, and the top
      kit.set(STONE, K.stone); face(q0, q1, g0 - 1.2, g1 - 1.2, h0, h1, -nx, -nz);
      kit.set(COPING, K.stone);
      kit.quad([p0[0], h0, p0[1]], [p1[0], h1, p1[1]], [q1[0], h1, q1[1]], [q0[0], h0, q0[1]], 0, 1, 0);
      // a loophole for a handgun every few metres of a straight run
      if (L / m > 3.2 && h0 - g0 > 3 && hash2(i, k, 77) < 0.6) {
        const sx = (p0[0] + p1[0]) / 2 + nx * 0.03, sz = (p0[1] + p1[1]) / 2 + nz * 0.03, gy = (g0 + g1) / 2 + 1.9;
        const dx = ex / L * 0.11, dz = ez / L * 0.11;
        kit.set(SLIT, K.metal);
        kit.quad([sx - dx, gy, sz - dz], [sx + dx, gy, sz + dz], [sx + dx, gy + 0.95, sz + dz], [sx - dx, gy + 0.95, sz - dz], nx, 0, nz);
      }
    }
  }
}

// Two stone parapets with a pier every four metres. The deck is the road's
// own: the earthworks carry it over the moat as a causeway (a hole in the
// moat's stamps, js/terrainstamps.js), and these walls, standing on the moat
// floor either side, are what make a causeway read as the bridge it is.
function bridge(kit) {
  const [A, B] = BRIDGE, ex = B[0] - A[0], ez = B[1] - A[1], L = Math.hypot(ex, ez);
  const dx = ex / L, dz = ez / L, px = -dz, pz = dx;
  const at = (s, o) => [A[0] + dx * s + px * o, A[1] + dz * s + pz * o];
  const road = (s) => kit.rel(A[0] + dx * s, A[1] + dz * s);
  const block = (s0, s1, o0, o1, lo, hi0, hi1) => {
    const c = [at(s0, o0), at(s1, o0), at(s1, o1), at(s0, o1)], hi = [hi0, hi1, hi1, hi0];
    const f = [[-px, -pz], [dx, dz], [px, pz], [-dx, -dz]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      kit.quad([c[i][0], lo, c[i][1]], [c[j][0], lo, c[j][1]], [c[j][0], hi[j], c[j][1]], [c[i][0], hi[i], c[i][1]], f[i][0], 0, f[i][1]);
    }
    kit.quad([c[0][0], hi0, c[0][1]], [c[1][0], hi1, c[1][1]], [c[2][0], hi1, c[2][1]], [c[3][0], hi0, c[3][1]], 0, 1, 0);
  };
  const m = 6, step = (SPAN[1] - SPAN[0]) / m;
  for (const side of [-1, 1]) {
    const o0 = side * DECK, o1 = side * (DECK + 0.45);
    for (let k = 0; k < m; k++) {
      const s0 = SPAN[0] + k * step, s1 = s0 + step;
      kit.set(STONE, K.stone);
      // down to the moat floor beside the causeway (js/terrainstamps.js), not
      // a fixed 2.2 m under the road: the walls ARE the causeway's sides
      const out = side * (DECK + 1.6);
      const foot = Math.min(kit.rel(...at(s0, out)), kit.rel(...at(s1, out))) - 0.3;
      block(s0, s1, Math.min(o0, o1), Math.max(o0, o1), Math.min(Math.min(road(s0), road(s1)) - 2.2, foot), road(s0) + BRIDGE_H, road(s1) + BRIDGE_H);
    }
    for (let k = 0; k <= m; k++) {
      const s = SPAN[0] + k * step, y = road(s);
      kit.set(COPING, K.stone);
      const foot = kit.rel(...at(s, side * (DECK + 1.6))) - 0.3;
      block(s - 0.4, s + 0.4, Math.min(o0, o1) - 0.14, Math.max(o0, o1) + 0.14, Math.min(y - 2.2, foot), y + BRIDGE_H + 0.3, y + BRIDGE_H + 0.3);
    }
  }
}

// A waist-high stone wall along a polyline, its foot and coping following the
// ground, in pieces of at most 3 m so it never floats over a dip.
function parapet(kit, line) {
  const t = PARAPET_T / 2;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    if (L < 0.05) continue;
    const dx = ex / L, dz = ez / L, px = -dz, pz = dx, m = Math.max(1, Math.ceil(L / 3));
    // (a joint's ends run on by half the thickness, so a corner closes)
    const s0 = i ? -t : 0, s1 = L + (i + 2 < line.length ? t : 0);
    for (let k = 0; k < m; k++) {
      const sa = s0 + (s1 - s0) * k / m, sb = s0 + (s1 - s0) * (k + 1) / m;
      const at = (s, o) => [a[0] + dx * s + px * o, a[1] + dz * s + pz * o];
      const ga = kit.rel(...at(sa, 0)), gb = kit.rel(...at(sb, 0));
      const c = [at(sa, -t), at(sb, -t), at(sb, t), at(sa, t)];
      const lo = [ga - 0.5, gb - 0.5, gb - 0.5, ga - 0.5], hi = [ga + PARAPET_H, gb + PARAPET_H, gb + PARAPET_H, ga + PARAPET_H];
      const fn = [[-px, -pz], [dx, dz], [px, pz], [-dx, -dz]];
      kit.set(STONE, K.stone);
      for (let j = 0; j < 4; j++) {
        const q = (j + 1) % 4;
        if ((j === 1 && k < m - 1) || (j === 3 && k > 0)) continue;     // inner joints are never seen
        kit.quad([c[j][0], lo[j], c[j][1]], [c[q][0], lo[q], c[q][1]], [c[q][0], hi[q], c[q][1]], [c[j][0], hi[j], c[j][1]], fn[j][0], 0, fn[j][1]);
      }
      kit.set(COPING, K.stone);
      kit.quad([c[0][0], hi[0], c[0][1]], [c[1][0], hi[1], c[1][1]], [c[2][0], hi[2], c[2][1]], [c[3][0], hi[3], c[3][1]], 0, 1, 0);
    }
  }
}

/**
 * Is this barrier one the fortress models itself: the chateau's foot wall
 * (citywall) or a parapet of the inner moat?
 */
export function isValyBarrier(f) {
  if (!f.p?.length) return false;
  const p = f.p[0];
  if (f.k === 'wall') return INNER.some((l) => l.length === f.p.length && same(p, l[0]));
  if (f.k !== 'citywall') return false;
  for (const q of VALY) if (same(p, q)) return true;
  return false;
}
