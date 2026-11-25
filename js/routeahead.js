// ---- routeahead: the part of the route that is still in front of you ---------
// A satnav never draws the road you have already driven. Every surface that
// shows the route (the ribbon on the tarmac, the HUD disc, the region map)
// asks the same three questions of the same polyline, so they are answered
// once, here, as plain arithmetic on arrays:
//
//   where am I along it   trackRoute: nearest point, with a continuity cost so
//                         a route that drives the same street twice (out of a
//                         dead end and back) cannot hand you the other pass
//   what is ahead         sliceAhead: the polyline from that arclength forward,
//                         interpolated at both ends, nothing behind it
//   how does it leave me  blendStart: the first metres bent from the route's
//                         centreline onto where the car really is, so the line
//                         grows out of the car rather than beside it
//
// No three.js, no DOM, no allocation on the per-frame paths (callers hand in
// their own scratch). Tests: tests/routeahead.test.mjs.

/** Arclength at every vertex of a [[x, z], …] polyline. */
export function routeCum(route) {
  const n = route ? route.length : 0;
  const cum = new Float64Array(Math.max(n, 1));
  for (let i = 1; i < n; i++) {
    const dx = route[i][0] - route[i - 1][0], dz = route[i][1] - route[i - 1][1];
    cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz);
  }
  return cum;
}

// Defaults shared with navigation.js and the old navline: a candidate pays
// CONT_K metres per metre it sits away from last frame's arclength, counted no
// further than CONT_MAX, so a genuine re-match (a teleport) still happens.
export const CONT_K = 0.05;
export const CONT_MAX = 600;
const REFIND = 40;           // m off the windowed match before the whole route is scanned

/**
 * Where (x, z) sits along the route. `st` carries { i, s } between calls and
 * is updated in place; it also receives `d`, the distance to the line.
 * A window around the last segment covers a car that follows the line; a
 * match further than REFIND off falls back to the whole polyline.
 */
const _best = { d: Infinity, score: Infinity, i: 0, s: 0 };
export function trackRoute(route, cum, x, z, st) {
  const n = route.length;
  if (n < 2) { st.i = 0; st.s = 0; st.d = Infinity; return st; }
  const best = _best;
  best.d = Infinity; best.score = Infinity; best.i = 0; best.s = 0;
  const lo = Math.max(0, (st.i | 0) - 6), hi = Math.min(n - 1, (st.i | 0) + 80);
  scanRange(route, cum, x, z, lo, hi, st.s ?? 0, best);
  if (best.d > REFIND) {
    best.d = Infinity; best.score = Infinity;
    scanRange(route, cum, x, z, 0, n - 1, st.s ?? 0, best);
  }
  st.i = best.i; st.s = best.s; st.d = best.d;
  return st;
}

function scanRange(r, cum, x, z, from, to, prev, best) {
  for (let i = from; i < to; i++) {
    const ax = r[i][0], az = r[i][1], bx = r[i + 1][0], bz = r[i + 1][1];
    const dx = bx - ax, dz = bz - az;
    const L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L2)) : 0;
    const cx = ax + dx * t - x, cz = az + dz * t - z;
    const d = Math.sqrt(cx * cx + cz * cz);
    const s = cum[i] + t * (cum[i + 1] - cum[i]);
    const score = d + CONT_K * Math.min(Math.abs(s - prev), CONT_MAX);
    if (score >= best.score) continue;
    best.score = score; best.d = d; best.i = i; best.s = s;
  }
}

/**
 * The point at arclength `s` (clamped to the route), written into `out` as
 * { x, z, dx, dz } with (dx, dz) the unit tangent there. `hint` is a segment
 * index to start the walk from; the segment found is returned.
 */
export function pointAt(route, cum, s, out, hint = 0) {
  const n = route.length;
  let k = Math.max(0, Math.min(n - 2, hint | 0));
  while (k > 0 && cum[k] > s) k--;
  while (k < n - 2 && cum[k + 1] < s) k++;
  const L = (cum[k + 1] - cum[k]) || 1e-9;
  const t = Math.max(0, Math.min(1, (s - cum[k]) / L));
  const ax = route[k][0], az = route[k][1];
  const ex = route[k + 1][0] - ax, ez = route[k + 1][1] - az;
  out.x = ax + ex * t; out.z = az + ez * t;
  const len = Math.sqrt(ex * ex + ez * ez) || 1;
  out.dx = ex / len; out.dz = ez / len;
  return k;
}

const _p = { x: 0, z: 0, dx: 0, dz: 0 };
let _seg = 0;

// Points on the route strictly between the last one written and arclength
// `to`, every maxStep metres; the end slot is always kept free. Returns m.
function fillTo(route, cum, out, m, max, maxStep, to) {
  let s = out.s[m - 1] + maxStep;
  while (to - s > maxStep * 0.25 && m < max - 1) {
    _seg = pointAt(route, cum, s, _p, _seg);
    out.x[m] = _p.x; out.z[m] = _p.z; out.s[m] = s; m++;
    s += maxStep;
  }
  return m;
}

/**
 * The route from arclength s0 forward for `len` metres, into `out`: three
 * parallel arrays out.x / out.z / out.s, each at least `max` long. The first
 * point is interpolated at s0 and the last at s0 + len (or the route's end),
 * and in between the route's own vertices, thinned to one per `minStep`
 * metres. With `maxStep` > 0 a gap longer than that is filled with points ON
 * the route (a straight street can have vertices 200 m apart, and whoever
 * samples ground height along the slice needs them). Nothing behind s0 is
 * ever written. Returns the point count.
 */
export function sliceAhead(route, cum, s0, len, out, max, minStep = 0, hint = 0, maxStep = 0) {
  const n = route ? route.length : 0;
  if (n < 2 || max < 2) return 0;
  const total = cum[n - 1];
  const a = Math.max(0, Math.min(total, s0));
  const b = Math.max(a, Math.min(total, a + Math.max(0, len)));
  if (b - a < 1e-6) return 0;
  const X = out.x, Z = out.z, S = out.s;
  let k = pointAt(route, cum, a, _p, hint);
  let m = 0;
  X[m] = _p.x; Z[m] = _p.z; S[m] = a; m++;
  _seg = k;
  for (k = k + 1; k < n && cum[k] < b; k++) {
    if (cum[k] <= a) continue;
    if (minStep > 0 && cum[k] - S[m - 1] < minStep) continue;
    if (maxStep > 0) m = fillTo(route, cum, out, m, max, maxStep, cum[k]);
    if (m >= max - 1) break;               // the end point keeps the last slot
    X[m] = route[k][0]; Z[m] = route[k][1]; S[m] = cum[k]; m++;
  }
  if (maxStep > 0) m = fillTo(route, cum, out, m, max, maxStep, b);
  pointAt(route, cum, b, _p, Math.max(0, k - 1));
  // the end is mandatory: replace a vertex crowding it rather than skip it
  if (m > 1 && minStep > 0 && b - S[m - 1] < minStep * 0.5) m--;
  X[m] = _p.x; Z[m] = _p.z; S[m] = b; m++;
  return m;
}

/**
 * Bend the head of a slice from the route's centreline onto where the car
 * actually is: point j moves by (dx, dz) · w(s_j − s_0), with w falling from 1
 * at the car to 0 at `blendM` metres (smoothstep). Behind nothing, beyond the
 * blend nothing; the route itself is untouched.
 */
export function blendStart(out, n, dx, dz, blendM) {
  if (n < 1 || !(blendM > 0)) return;
  const s0 = out.s[0];
  for (let j = 0; j < n; j++) {
    const u = (out.s[j] - s0) / blendM;
    if (u >= 1) break;
    const w = 1 - u * u * (3 - 2 * u);
    out.x[j] += dx * w; out.z[j] += dz * w;
  }
}

/**
 * Lateral offset at arclength `s`, interpolated between the per-vertex values
 * in `off` (aligned with the route; missing means 0). Positive is the right of
 * travel in the world frame (x east, z south: right of (dx, dz) is (−dz, dx)).
 */
export function offsetAt(off, cum, s, hint = 0) {
  if (!off || !off.length) return 0;
  const n = cum.length;
  let k = Math.max(0, Math.min(n - 2, hint | 0));
  while (k > 0 && cum[k] > s) k--;
  while (k < n - 2 && cum[k + 1] < s) k++;
  const L = (cum[k + 1] - cum[k]) || 1e-9;
  const t = Math.max(0, Math.min(1, (s - cum[k]) / L));
  const a = off[k] ?? 0, b = off[k + 1] ?? a;
  return a + (b - a) * t;
}

/**
 * The polyline length of a slice that still needs drawing inside a disc of
 * radius `r` around (cx, cz): walks until the line has stayed outside the disc
 * for `outM` metres. Lets a map stop drawing a 40 km route at the edge.
 */
export function visibleCount(out, n, cx, cz, r, outM) {
  const r2 = r * r;
  let outside = 0;
  for (let j = 1; j < n; j++) {
    const ex = out.x[j] - cx, ez = out.z[j] - cz;
    if (ex * ex + ez * ez > r2) {
      outside += out.s[j] - out.s[j - 1];
      if (outside > outM) return j + 1;
    } else outside = 0;
  }
  return n;
}
