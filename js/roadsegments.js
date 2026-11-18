// A road's centreline as flat numbers, ten per segment: ax, az, dx, dz, length,
// distance along the way to its start, then its own box (x0, x1, z0, z1).
// Measured in wave 3 over 169 real cells: clampUnderRoadsGen was 45 percent of
// a full chunk build, nearly all of it walking EVERY segment of a road for a
// vertex that its box had only said was somewhere near the road, with a
// Math.hypot and two array reads apiece. The numbers are the same ones the
// loop used to work out in place, in the same order, so the result is the same
// to the last bit; the box test only skips segments that could not have been
// within reach. Keyed on the road and checked against its point list, because
// indexing may still splice a node into a way after the first chunk was built.
const _segCache = new WeakMap();
const _emptySegments = new Float64Array(0);
export function roadSegs(r) {
  const p = r.p, n = p.length;
  if (n < 2) return _emptySegments;
  const c = _segCache.get(r);
  if (c && c.p === p && c.n === n && c.x0 === p[0][0] && c.z1 === p[n - 1][1]) return c.a;
  const a = new Float64Array(Math.max(0, n - 1) * 10);
  let along = 0;
  for (let k = 0, o = 0; k < n - 1; k++, o += 10) {
    const ax = p[k][0], az = p[k][1], bx = p[k + 1][0], bz = p[k + 1][1];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    a[o] = ax; a[o + 1] = az; a[o + 2] = dx; a[o + 3] = dz; a[o + 4] = L; a[o + 5] = along;
    a[o + 6] = Math.min(ax, bx); a[o + 7] = Math.max(ax, bx);
    a[o + 8] = Math.min(az, bz); a[o + 9] = Math.max(az, bz);
    along += L;
  }
  _segCache.set(r, { p, n, x0: p[0][0], z1: p[n - 1][1], a });
  return a;
}

/** Can a disc around (x, z) intersect this segment's bounding box? */
export function segmentNear(s, i, x, z, radius) {
  return x >= s[i + 6] - radius && x <= s[i + 7] + radius
    && z >= s[i + 8] - radius && z <= s[i + 9] + radius;
}

/** Return chainage at the nearest segment within reach, with distance and side in out. */
export function nearestSeg(r, x, z, reach, out) {
  const segs = roadSegs(r);
  let best2 = reach * reach, bs = 0, be = 1, found = false;
  for (let i = 0; i < segs.length; i += 10) {
    if (!segmentNear(segs, i, x, z, reach)) continue;
    const dx = segs[i + 2], dz = segs[i + 3], L = segs[i + 4];
    const px = x - segs[i], pz = z - segs[i + 1];
    const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / (L * L || 1e-9)));
    const ex = px - dx * t, ez = pz - dz * t, d2 = ex * ex + ez * ez;
    if (d2 >= best2) continue;
    best2 = d2; bs = segs[i + 5] + L * t; be = px * dz - pz * dx >= 0 ? 1 : -1;
    found = true;
  }
  out.d = found ? Math.sqrt(best2) : Infinity;
  out.e = be;
  return bs;
}
