// ---- flight-path.js: a taxi route as something a wheel can follow ----
// Pure arithmetic, no three.js. A route in js/airport-plan.js is a polyline of
// mapped taxiway vertices; an airliner cannot turn on a point, so every corner
// is replaced by a circular fillet (the radius a nosewheel actually steers,
// shortened where two corners come close), the result is sampled every metre
// or so, and the speed a crew would hold is worked out along it: 12 m/s
// (about 23 kt) on the straights, slower in the turns so the sideways
// acceleration stays under 0.6 m/s², and a smooth stop at the end. The flight
// (js/flight.js) only ever asks `at(s)` and `limit(s)`.
//
// Heading convention (ARCHITECTURE.md): a machine yawed by h travels along
// (−sin h, −cos h), so the heading of a direction (dx, dz) is atan2(−dx, −dz).

export const TAXI = { fast: 12, turnAcc: 0.6, accel: 0.7, brake: 0.9, minSpeed: 2.2 };
export const headingOf = (dx, dz) => Math.atan2(-dx, -dz);

/**
 * Build a followable path from [[x, z], ...].
 * @param radius the fillet radius in metres (a narrowbody taxis round ~25 m)
 * @param endSpeed the speed it may still have at the end (0 = stop on the point)
 * → { length, at(s, out?), limit(s), points }
 */
export function makePath(points, radius = 25, endSpeed = 0) {
  const dense = [];
  const push = (x, z) => {
    const last = dense[dense.length - 1];
    if (!last || Math.hypot(x - last[0], z - last[1]) > 0.05) dense.push([x, z]);
  };
  push(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const [ax, az] = points[i - 1], [bx, bz] = points[i], [cx, cz] = points[i + 1];
    let ux = bx - ax, uz = bz - az, wx = cx - bx, wz = cz - bz;
    const lu = Math.hypot(ux, uz), lw = Math.hypot(wx, wz);
    if (lu < 1e-6 || lw < 1e-6) continue;
    ux /= lu; uz /= lu; wx /= lw; wz /= lw;
    const turn = Math.acos(Math.max(-1, Math.min(1, ux * wx + uz * wz)));
    if (turn < 0.01) { push(bx, bz); continue; }
    // the fillet's tangent length, never more than half of either leg, so two
    // close corners share the leg between them instead of overlapping
    let r = radius, t = r * Math.tan(turn / 2);
    const cap = Math.min(lu, lw) * 0.5;
    if (t > cap) { t = cap; r = t / Math.tan(turn / 2); }
    const sx = bx - ux * t, sz = bz - uz * t;
    const side = Math.sign(ux * wz - uz * wx);     // + turns toward +z of the leg's left
    // the arc's centre lies off the first leg, toward the inside of the turn
    const ox = sx - uz * r * side, oz = sz + ux * r * side;
    const a0 = Math.atan2(sz - oz, sx - ox);
    const steps = Math.max(2, Math.ceil(turn * r / 1.5));
    for (let k = 0; k <= steps; k++) {
      const a = a0 + side * turn * (k / steps);
      push(ox + Math.cos(a) * r, oz + Math.sin(a) * r);
    }
  }
  const end = points[points.length - 1];
  push(end[0], end[1]);

  // cumulative length, heading of each piece and curvature at each vertex
  const n = dense.length, dist = new Float64Array(n), head = new Float64Array(n), curv = new Float64Array(n);
  for (let i = 1; i < n; i++) dist[i] = dist[i - 1] + Math.hypot(dense[i][0] - dense[i - 1][0], dense[i][1] - dense[i - 1][1]);
  for (let i = 0; i < n; i++) {
    const a = dense[Math.max(0, i - 1)], b = dense[Math.min(n - 1, i + 1)];
    head[i] = headingOf(b[0] - a[0], b[1] - a[1]);
  }
  for (let i = 1; i < n - 1; i++) {
    let d = head[i + 1] - head[i - 1];
    d = Math.atan2(Math.sin(d), Math.cos(d));
    const ds = dist[i + 1] - dist[i - 1];
    curv[i] = ds > 1e-6 ? Math.abs(d) / ds : 0;
  }
  // the speed limit: the turn allows sqrt(a / k), and the two passes make it
  // reachable with the accelerations a crew uses (and a stop at the end)
  const lim = new Float64Array(n);
  for (let i = 0; i < n; i++) lim[i] = Math.max(TAXI.minSpeed, Math.min(TAXI.fast, Math.sqrt(TAXI.turnAcc / Math.max(1e-6, curv[i]))));
  lim[n - 1] = endSpeed;
  for (let i = n - 2; i >= 0; i--) lim[i] = Math.min(lim[i], Math.sqrt(lim[i + 1] ** 2 + 2 * TAXI.brake * (dist[i + 1] - dist[i])));
  const length = dist[n - 1];

  function find(s) {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s < dist[mid]) hi = mid; else lo = mid;
    }
    return lo;
  }
  return {
    length,
    points: dense,
    /** Where s metres along the path is: { x, z, heading }. */
    at(s, out = {}) {
      s = Math.max(0, Math.min(length, s));
      const i = Math.min(find(s), n - 2), j = i + 1, L = dist[j] - dist[i];
      const t = L > 1e-9 ? (s - dist[i]) / L : 0;
      out.x = dense[i][0] + (dense[j][0] - dense[i][0]) * t;
      out.z = dense[i][1] + (dense[j][1] - dense[i][1]) * t;
      out.heading = headingOf(dense[j][0] - dense[i][0], dense[j][1] - dense[i][1]);
      return out;
    },
    /** The speed (m/s) a crew holds at s. */
    limit(s) {
      if (s >= length) return endSpeed;
      const i = Math.min(find(Math.max(0, s)), n - 2), j = i + 1, L = dist[j] - dist[i];
      const t = L > 1e-9 ? (s - dist[i]) / L : 0;
      return lim[i] + (lim[j] - lim[i]) * t;
    },
  };
}

/**
 * One step along a path: the speed eases toward the limit with the crew's
 * acceleration and braking. Mutates and returns `st` { s, v }.
 */
export function taxiStep(path, st, dt) {
  const want = path.limit(st.s + st.v * 1.5);
  const dv = want - st.v;
  st.v += Math.max(-TAXI.brake * dt, Math.min(TAXI.accel * dt, dv));
  if (st.v < 0) st.v = 0;
  st.s = Math.min(path.length, st.s + st.v * dt);
  // the last metre: the limit there is zero and braking alone would creep
  // toward it for ever, so a crew at walking pace simply stops on the line
  if (path.length - st.s < 0.4 && st.v < 1.2) { st.s = path.length; st.v = 0; }
  return st;
}
