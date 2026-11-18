// ---- partycorners.js: what a building's party-wall stamp says about it ----
// Pure data (no three, no DOM), read by the roofs and facades in both threads.
// js/partywalls.js writes f._pw (one value per outer edge, 0 for a free wall);
// these read it: one edge's value, and the street corner a perimeter block
// turns, square or cut off.

/**
 * The party value of edge i, or 0. A ring with a different vertex count from
 * the stamp (a footprint rewritten after indexing) reads as all free.
 */
export const partyOf = (f, i) => (f._pw && f._pw.length === f.o.length ? f._pw[i] : 0);

/**
 * blockCorner(f) -> index of the block-corner vertex, or -1: a convex corner
 * whose two walls are both free (not party), at least 7 m long, and meet at
 * 60..120 degrees; the longest such. Where a perimeter block turns a street
 * corner: the corner turret (roofgrammar.js) and the corner shop (typology.js).
 */
export function blockCorner(f) {
  const ring = f.o, n = ring.length;
  // (a house that shares no wall is not a block corner, it is a villa)
  if (n > 40 || !f._pw) return -1;
  const sgn = ringSign(ring);
  let best = -1, bestL = 0;
  for (let i = 0; i < n; i++) {
    const p = ring[(i - 1 + n) % n], c = ring[i], q = ring[(i + 1) % n];
    if (partyOf(f, (i - 1 + n) % n) > 0 || partyOf(f, i) > 0) continue;
    const ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 7 || lb < 7) continue;
    const cr = (ax * bz - az * bx) / (la * lb), dt = (ax * bx + az * bz) / (la * lb);
    // convex: the turn has the ring's own winding; 60..120 degrees between walls
    if (cr * sgn <= 0) continue;
    if (Math.abs(dt) > 0.5) continue;
    if (la + lb > bestL) { bestL = la + lb; best = i; }
  }
  return best;
}

/**
 * chamferCorner(f) -> index of the edge that cuts a block corner off, or -1:
 * a free wall of 2 to 7 m between two free walls of at least 7 m, turning about
 * 45 degrees (30..60) the same way at both its ends, so the long walls meet at
 * 60..120 degrees across it; the longest such pair. The corner of a Zizkov or
 * Vinohrady block is as often cut off as square (26 of 100 corner houses in
 * Zizkov, measured), and the oriel stands over the cut.
 */
export function chamferCorner(f) {
  const ring = f.o, n = ring.length;
  if (n > 40 || n < 5 || !f._pw) return -1;
  const sgn = ringSign(ring);
  const dir = (i) => {
    const a = ring[(i + n) % n], b = ring[(i + 1 + n) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    return [dx / L, dz / L, L];
  };
  let best = -1, bestL = 0;
  for (let i = 0; i < n; i++) {
    const [cx, cz, cl] = dir(i);
    if (cl < 2 || cl > 7) continue;
    const ip = (i - 1 + n) % n, inx = (i + 1) % n;
    if (partyOf(f, ip) > 0 || partyOf(f, i) > 0 || partyOf(f, inx) > 0) continue;
    const [px, pz, pl] = dir(ip), [qx, qz, ql] = dir(inx);
    if (pl < 7 || ql < 7) continue;
    // each end turns 30..60 degrees, convex (the ring's own winding)
    const c1 = px * cx + pz * cz, c2 = cx * qx + cz * qz;
    if (c1 < 0.5 || c1 > 0.866 || c2 < 0.5 || c2 > 0.866) continue;
    if ((px * cz - pz * cx) * sgn <= 0 || (cx * qz - cz * qx) * sgn <= 0) continue;
    // and the two long walls meet at 60..120 degrees
    if (Math.abs(px * qx + pz * qz) > 0.5) continue;
    if (pl + ql > bestL) { bestL = pl + ql; best = i; }
  }
  return best;
}

function ringSign(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a > 0 ? 1 : -1;
}
