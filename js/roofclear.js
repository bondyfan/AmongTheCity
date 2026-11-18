// ---- roofclear.js: how much room each wall of a courtyard block has ----
// Pure geometry (no three, no DOM), for js/roofholes.js in both threads.
//
// A courtyard roof slopes in from the street wall and out from every yard
// wall, and its two ridge rings must not cross. With one depth for every ring
// that needs twice the depth of clearance everywhere, and a Prague yard that
// lies against the plot line behind one thin wall (0.3 to 0.7 m, measured on
// 61 of the 68 blocks that failed that way) can never give it. So each edge
// gets its own share of the depth: as much as the gap in front of it allows,
// split between the two rings that face each other across it.

const sideOf = (ox, oz, ax, az, bx, bz) => (ax - ox) * (bz - oz) - (az - oz) * (bx - ox);
// distance from point p to segment ab
function pointSeg(px, pz, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
  let t = L2 > 1e-12 ? ((px - ax) * ex + (pz - az) * ez) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = ax + ex * t - px, dz = az + ez * t - pz;
  return Math.sqrt(dx * dx + dz * dz);
}
/** Shortest distance between segments ab and cd (0 where they cross). */
export function segDist(a, b, c, d) {
  const d1 = sideOf(c[0], c[1], d[0], d[1], a[0], a[1]), d2 = sideOf(c[0], c[1], d[0], d[1], b[0], b[1]);
  const d3 = sideOf(a[0], a[1], b[0], b[1], c[0], c[1]), d4 = sideOf(a[0], a[1], b[0], b[1], d[0], d[1]);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return 0;
  return Math.min(pointSeg(a[0], a[1], c[0], c[1], d[0], d[1]), pointSeg(b[0], b[1], c[0], c[1], d[0], d[1]),
    pointSeg(c[0], c[1], a[0], a[1], b[0], b[1]), pointSeg(d[0], d[1], a[0], a[1], b[0], b[1]));
}

/**
 * frontGap(a, b, m, c, d) -> how far segment cd lies in front of edge ab,
 * along ab's moving direction m (a unit normal): the least height over ab of
 * the part of cd that stands over ab's own span; 0 where cd touches or crosses
 * ab there, Infinity where none of cd stands over ab or all of it is behind.
 * (Not the plain distance: a wall whose END comes near another ring is not
 * squeezed along its whole length, only one whose face does.)
 */
export function frontGap(a, b, m, c, d) {
  const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
  if (L < 1e-9) return Infinity;
  const ux = ex / L, uz = ez / L;
  const tc = (c[0] - a[0]) * ux + (c[1] - a[1]) * uz, td = (d[0] - a[0]) * ux + (d[1] - a[1]) * uz;
  const hc = (c[0] - a[0]) * m[0] + (c[1] - a[1]) * m[1], hd = (d[0] - a[0]) * m[0] + (d[1] - a[1]) * m[1];
  let lo = 0, hi = 1;
  if (Math.abs(td - tc) < 1e-12) { if (tc < 0 || tc > L) return Infinity; }
  else {
    const l0 = -tc / (td - tc), l1 = (L - tc) / (td - tc);
    lo = Math.max(0, Math.min(l0, l1)); hi = Math.min(1, Math.max(l0, l1));
    if (lo > hi) return Infinity;
  }
  const h0 = hc + lo * (hd - hc), h1 = hc + hi * (hd - hc);
  if (Math.max(h0, h1) < 0) return Infinity;
  if (Math.min(h0, h1) <= 0) return 0;
  return Math.min(h0, h1);
}

/**
 * ringClearances(rings, dirs) -> per ring, per edge: the gap in front of that
 * edge (Infinity where there is none). `dirs[r]` says which way ring r's edges
 * move: along dirs[r] * (-uz, ux) for an edge running along (ux, uz) (the
 * inward normal of roofs.js insetRing is that with dirs = its sgn).
 * Two edges squeeze each other only where they move toward each other (the
 * street wall and the yard wall across a wing, the two sides of a notch or a
 * thin arm), never a neighbour, nor the far side of a jog, which move along
 * with it. O(n2) over all the vertices, which roofholes.js bounds at 200.
 * `near`: the cautious reading, for when that one leaves rings that cross at
 * a corner: an edge of another ring counts by its plain distance, facing or
 * not (so a yard wall that merely ENDS near the street wall is held back too).
 */
export function ringClearances(rings, dirs, near = false) {
  const out = rings.map((r) => new Array(r.length).fill(Infinity));
  const moves = rings.map((r, R) => r.map((a, i) => {
    const b = r[(i + 1) % r.length], ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1;
    return [-ez / L * dirs[R], ex / L * dirs[R]];
  }));
  for (let A = 0; A < rings.length; A++) {
    const ra = rings[A], na = ra.length;
    for (let i = 0; i < na; i++) {
      const a = ra[i], b = ra[(i + 1) % na], ma = moves[A][i];
      for (let B = A; B < rings.length; B++) {
        const rb = rings[B], nb = rb.length;
        for (let j = B === A ? i + 2 : 0; j < nb; j++) {
          if (B === A && i === 0 && j === na - 1) continue;     // the closing neighbour
          const mb = moves[B][j];
          if (near && B !== A) {
            const g = segDist(a, b, rb[j], rb[(j + 1) % nb]);
            if (g < out[A][i]) out[A][i] = g;
            if (g < out[B][j]) out[B][j] = g;
            continue;
          }
          if (ma[0] * mb[0] + ma[1] * mb[1] > -0.1) continue;   // not toward each other
          const c = rb[j], d = rb[(j + 1) % nb];
          const ga = frontGap(a, b, ma, c, d), gb = frontGap(c, d, mb, a, b);
          if (ga < out[A][i]) out[A][i] = ga;
          if (gb < out[B][j]) out[B][j] = gb;
        }
      }
    }
  }
  return out;
}

// what is left between two ridge rings that meet across a tight gap
export const CLEAR_GAP = 0.05;

/**
 * depthFactors(clear, d) -> per edge, the share of depth d it may take: all
 * of it where the gap in front is 2d or more, otherwise half the gap (less
 * CLEAR_GAP), so the two rings facing each other stop just short of touching.
 */
export function depthFactors(clear, d) {
  return clear.map((c) => Math.max(0, Math.min(1, (c - CLEAR_GAP) / (2 * d))));
}

/**
 * depthCap(rings, clear) -> the deepest slope the block's ordinary walls
 * allow: half the gap in front of them at the 30th percentile of wall length,
 * counting only walls with room for a real slope (ORDINARY or more). A
 * squeezed wall is what the per-edge depth is for; the depth itself should
 * still be what a block of these wings would get, or every squeezed wall
 * stands up as a fin as tall as the deepest roof.
 */
const ORDINARY = 1.5;
export function depthCap(rings, clear) {
  const e = [];
  let tot = 0;
  rings.forEach((r, R) => r.forEach((a, i) => {
    if (!(clear[R][i] >= ORDINARY)) return;
    const b = r[(i + 1) % r.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    e.push([clear[R][i], L]); tot += L;
  }));
  e.sort((p, q) => p[0] - q[0]);
  let acc = 0;
  for (const [c, L] of e) { acc += L; if (acc >= 0.3 * tot) return c / 2; }
  return Infinity;
}
