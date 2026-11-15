// ---- tram lines: a Prague tram route as a timetable on its own rail ------------
// The route files (docs/TILE-FORMAT.md, js/tiledata.js) carry the whole Prague
// tram network: 79 PID routes whose path IS the tile tram track (99 % of the
// path vertices are rail vertices to the decimetre) and whose calls are metres
// along that path. A tram never touches the traffic road graph (nine tenths of
// its path is not in the roads layer at all), so it is not a traffic schedule
// like a bus: it is a pure function of the route record and the shared clock.
//
//   trip k of a line departs at        (phase + k) x headway
//   it is due at call i at             departure + N[i]
//   and its NOSE is at arc             arcAt(line, now - departure)
//
// N and the motion between calls come from nothing but the route record: per
// leg, the fastest run a tram can make under its acceleration, its braking and
// the curves of the track (a speed limit per path vertex from the turn there),
// stretched by a driver's slack. So two clients that met the same tram from
// opposite ends of town, with different files loaded, agree where it is to the
// millimetre: there is no state, no Math.random and no wall clock in here.
//
// No three.js, no DOM: tests import it directly.

import { routePath, routeStops, CALL_EXIT_ONLY, LEG_TUNNEL } from './tiledata.js';
import { indexPath, projectOnPath, phaseOf } from './realines.js';
import { hourAt, isNightService } from './dayrhythm.js';
import { hash32, rnd01 } from './crowdsites.js';

// ---- motion ------------------------------------------------------------------
// (Škoda 15T and Tatra T3: about 1.0 m/s^2 pulling away and 1.2 braking in
// service, 50 km/h in town; a curve is taken at the speed that keeps the
// sideways pull under A_LAT, which is what makes a tram crawl round a corner)
export const ACCEL = 1.0, BRAKE = 1.2;
export const VMAX = 13.9;           // m/s, 50 km/h
const A_LAT = 0.9;                  // m/s^2 sideways in a curve
const V_CURVE_MIN = 3.0;            // m/s: no curve of the network is slower
const SAMPLE = 10;                  // m between samples of a leg's speed profile
// The timetable leaves a driver room: the fastest run a leg allows, times
// SLACK, plus PAD seconds. Prague trams make about 19 km/h with the stops; this
// gives 20 to 23 km/h on the measured legs (450 m median), lights not counted.
const SLACK = 1.25, PAD = 3;
export const DWELL = 15, DWELL_FIRST = 25, DWELL_TERMINUS = 30;   // s at a call
const SPIKE_DEG = 120, SPIKE_LEN = 3;   // a turn this sharp on a segment this short is a mapping artefact

// ---- service -----------------------------------------------------------------
// Real Prague runs its day lines every 8 to 10 minutes and its night lines
// every 20 to 30 (general knowledge, not measured; there is no timetable in
// the data). A game day is 1440 real s and its night (23:00 to 4:30) only 330
// real s, shorter than any real headway, so the NIGHT lines depart every
// NIGHT_H seconds while the night lasts (two departures a direction) and run
// their whole course from there, and the day lines drop every other trip
// after dark, as the buses do (js/realtransit.js runs()).
export const DAY_H = 600, SPECIAL_H = 1800, NIGHT_H = 150, OTHER_H = 900;

/** Is this a night line (91 to 99)? */
export function isNightRef(ref) {
  const n = +ref;
  return n >= 91 && n <= 99;
}

/** Seconds between departures of a tram line, by its number. */
export function tramHeadway(ref) {
  const n = +ref;
  if (!Number.isFinite(n)) return OTHER_H;
  if (isNightRef(ref)) return NIGHT_H;
  if (n === 41 || n === 42) return SPECIAL_H;           // the historic and the sightseeing circle
  if ((n >= 1 && n <= 26) || n === 31 || n === 34) return DAY_H;
  return OTHER_H;
}

// ---- the path -------------------------------------------------------------------

// Drop a vertex where the path doubles back on itself over a few metres (line
// 41 at (-94779, -7485): 155 degrees over 1.3 m). A rail cannot turn like that,
// and a 31 m body posed on it would fold. Returns a new flat array (and the
// leg flags that go with it).
export function filterSpikes(pts, flags = null) {
  let p = pts.slice(), f = flags ? flags.slice() : null;
  const cosLim = Math.cos(SPIKE_DEG * Math.PI / 180);
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    const n = p.length >> 1;
    const keep = new Uint8Array(n).fill(1);
    for (let i = 1; i < n - 1; i++) {
      if (!keep[i - 1]) continue;
      const ax = p[i * 2] - p[i * 2 - 2], az = p[i * 2 + 1] - p[i * 2 - 1];
      const bx = p[i * 2 + 2] - p[i * 2], bz = p[i * 2 + 3] - p[i * 2 + 1];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      if (la < 1e-6 || lb < 1e-6) { keep[i] = 0; changed = true; continue; }   // a repeated point
      const c = (ax * bx + az * bz) / (la * lb);
      if (c < cosLim && Math.min(la, lb) < SPIKE_LEN) { keep[i] = 0; changed = true; }
    }
    if (!changed) break;
    const q = [], g = f ? [] : null;
    for (let i = 0; i < n; i++) if (keep[i]) { q.push(p[i * 2], p[i * 2 + 1]); if (g) g.push(f[i]); }
    p = q; f = g;
  }
  return { pts: p, flags: f };
}

/** The point at arc `a`, extended straight past either end (a body behind its nose at the first call). */
export function pathAtExt(P, a, out) {
  const p = P.pts, n = P.n;
  if (n < 2) { out.x = p[0] ?? 0; out.z = p[1] ?? 0; out.dx = 1; out.dz = 0; return out; }
  let i;
  if (a <= 0) i = 0;
  else if (a >= P.L) i = n - 2;
  else {
    let lo = 0, hi = n - 2;
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (P.cum[m] <= a) lo = m; else hi = m - 1;
    }
    i = lo;
  }
  // (a zero-length segment has no heading: look for the nearest real one)
  let j = i;
  while (j < n - 2 && P.cum[j + 1] - P.cum[j] < 1e-6) j++;
  while (j > 0 && P.cum[j + 1] - P.cum[j] < 1e-6) j--;
  const L = P.cum[j + 1] - P.cum[j];
  const ax = p[j * 2], az = p[j * 2 + 1];
  const dx = L > 1e-6 ? (p[j * 2 + 2] - ax) / L : 1, dz = L > 1e-6 ? (p[j * 2 + 3] - az) / L : 0;
  const u = a - P.cum[j];
  out.x = ax + dx * u; out.z = az + dz * u; out.dx = dx; out.dz = dz;
  return out;
}

// The speed a curve allows at each vertex of the path: the turn there spread
// over the shorter of its two segments (an arc of that length), R = l / turn.
function vertexLimits(P) {
  const n = P.n, p = P.pts, lim = new Float32Array(n).fill(VMAX);
  for (let i = 1; i < n - 1; i++) {
    const ax = p[i * 2] - p[i * 2 - 2], az = p[i * 2 + 1] - p[i * 2 - 1];
    const bx = p[i * 2 + 2] - p[i * 2], bz = p[i * 2 + 3] - p[i * 2 + 1];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const th = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / (la * lb))));
    if (th < 0.02) continue;
    const l = Math.max(2, Math.min(la, lb, 40));
    const v = Math.sqrt(A_LAT * l / th);
    lim[i] = Math.max(V_CURVE_MIN, Math.min(VMAX, v));
  }
  return lim;
}

// The fastest run from standstill at arc a to standstill at arc b under ACCEL,
// BRAKE and the curve limits: samples { s (from a), v, t (cumulative) }.
function legProfile(P, lim, a, b) {
  const D = Math.max(0, b - a);
  const arcs = [0];
  // every vertex inside the leg is a sample (that is where a curve bites),
  // and no two samples are more than SAMPLE apart
  let lo = 0, hi = P.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (P.cum[m] <= a) lo = m + 1; else hi = m; }
  const verts = [];
  for (let i = lo; i < P.n && P.cum[i] < b; i++) if (P.cum[i] > a) verts.push(i);
  let prev = 0;
  const push = (s) => {
    const gap = s - prev;
    if (gap < 0.05) return;
    const k = Math.ceil(gap / SAMPLE);
    for (let j = 1; j <= k; j++) arcs.push(prev + gap * j / k);
    prev = s;
  };
  for (const i of verts) push(P.cum[i] - a);
  push(D);
  if (arcs.length === 2 && D > 0) arcs.splice(1, 0, D / 2);   // a leg needs a middle to have a speed
  if (D <= 0) arcs.push(0);
  const m = arcs.length;
  const v = new Float32Array(m);
  // the limit at a sample: the tightest curve whose arc it lies on
  for (let j = 0; j < m; j++) v[j] = VMAX;
  for (const i of verts) {
    if (lim[i] >= VMAX) continue;
    const c = P.cum[i] - a;
    const la = P.cum[i] - P.cum[i - 1], lb = P.cum[i + 1] - P.cum[i];
    const w = Math.max(3, Math.min(la, lb, 40) / 2);
    for (let j = 0; j < m; j++) if (Math.abs(arcs[j] - c) <= w && lim[i] < v[j]) v[j] = lim[i];
  }
  v[0] = 0; v[m - 1] = 0;
  for (let j = 1; j < m; j++) {
    const up = Math.sqrt(v[j - 1] * v[j - 1] + 2 * ACCEL * (arcs[j] - arcs[j - 1]));
    if (up < v[j]) v[j] = up;
  }
  for (let j = m - 2; j >= 0; j--) {
    const dn = Math.sqrt(v[j + 1] * v[j + 1] + 2 * BRAKE * (arcs[j + 1] - arcs[j]));
    if (dn < v[j]) v[j] = dn;
  }
  const t = new Float32Array(m);
  for (let j = 1; j < m; j++) {
    const ds = arcs[j] - arcs[j - 1], vs = v[j - 1] + v[j];
    t[j] = t[j - 1] + (ds > 0 && vs > 1e-6 ? 2 * ds / vs : 0);
  }
  return { s: Float32Array.from(arcs), v, t, T: t[m - 1] };
}

// metres from the leg's start, and speed, `tau` seconds into the fastest run
function profileAt(pr, tau, out) {
  const t = pr.t, m = t.length;
  if (tau <= 0) { out.s = 0; out.v = 0; return out; }
  if (tau >= pr.T) { out.s = pr.s[m - 1]; out.v = 0; return out; }
  let lo = 0, hi = m - 2;
  while (lo < hi) { const k = (lo + hi + 1) >> 1; if (t[k] <= tau) lo = k; else hi = k - 1; }
  const ds = pr.s[lo + 1] - pr.s[lo], v0 = pr.v[lo], v1 = pr.v[lo + 1];
  const tl = tau - t[lo];
  // constant acceleration across a sample interval
  const acc = ds > 1e-9 ? (v1 * v1 - v0 * v0) / (2 * ds) : 0;
  let s = v0 * tl + 0.5 * acc * tl * tl;
  if (s > ds) s = ds; else if (s < 0) s = 0;
  out.s = pr.s[lo] + s;
  out.v = Math.max(0, v0 + acc * tl);
  return out;
}

// ---- the line ---------------------------------------------------------------------

/**
 * One tram route as a line, or null when it cannot run (fewer than two calls).
 * Pure on the route record: { id, ref, dest, from, color, P, flags, stops,
 * legs, N, dur, headway, phase, night, bb }.
 */
export function buildTramLine(file, route) {
  if (!route?.s || route.s.length < 2 || !route.p) return null;
  const raw = routePath(file, route);
  if (raw.pts.length < 4) return null;
  const rawP = indexPath(raw.pts);
  const f = filterSpikes(raw.pts, raw.flags);
  const P = indexPath(f.pts);
  const calls = routeStops(file, route);
  const filtered = f.pts.length !== raw.pts.length;
  const q = { d: 0, a: 0 }, at = { x: 0, z: 0, dx: 0, dz: 0 };
  const stops = [];
  for (const c of calls) {
    let d = Math.max(0, Math.min(c.d, rawP.L));
    if (filtered) {
      // the arc moved by the few metres the spike took out: find it again
      pathAtExt(rawP, d, at);
      projectOnPath(P, at.x, at.z, d - 40, d + 40, q);
      d = q.a;
    }
    stops.push({ n: c.n, k: c.k, x: c.x, z: c.z, px: c.px, pz: c.pz, f: c.f, d });
  }
  // calls in strictly increasing order along the path, and on it
  for (let i = 1; i < stops.length; i++) if (stops[i].d < stops[i - 1].d + 1) stops[i].d = Math.min(P.L, stops[i - 1].d + 1);
  const lim = vertexLimits(P);
  const legs = [], N = new Float64Array(stops.length);
  for (let i = 0; i < stops.length - 1; i++) {
    const pr = legProfile(P, lim, stops[i].d, stops[i + 1].d);
    const T = pr.T * SLACK + PAD;
    pr.k = pr.T > 1e-6 ? T / pr.T : 1;          // the stretch that turns the fastest run into the timetable
    pr.Tn = T;
    legs.push(pr);
    N[i + 1] = N[i] + (i === 0 ? DWELL_FIRST : DWELL) + T;
  }
  const last = stops[stops.length - 1];
  const ref = String(route.ref ?? '');
  return {
    id: route.id, ref, mode: route.m,
    dest: last.n || route.to || '', from: stops[0].n || route.fr || '',
    color: route.c ?? null, name: route.n ?? '',
    P, flags: f.flags, stops, legs, N, dur: N[N.length - 1] + DWELL_TERMINUS,
    headway: tramHeadway(ref), phase: phaseOf(route), night: isNightRef(ref), bb: route.bb,
  };
}

/** The shared second trip k leaves its first call. */
export const departOf = (line, k) => (line.phase + k) * line.headway;

/**
 * Does trip k run? A night line only departs while the night lasts; a day
 * line runs every departure by day and every other one after dark.
 */
export function tripRuns(line, k) {
  const night = isNightService(hourAt(departOf(line, k)));
  return line.night ? night : !(night && (k & 1));
}

/** The trips of a line that are on the rail at shared second `wt`: [k0, k1], every k of which still has to pass tripRuns. */
export function tripRange(line, wt) {
  const H = line.headway;
  return [Math.floor((wt - line.dur) / H - line.phase) + 1, Math.floor(wt / H - line.phase)];
}

/**
 * Where a trip's NOSE is `since` seconds after its departure, as a pure
 * function: out = { s (path arc), v (m/s), i (the call it is at or has last
 * left), stop (true while it stands at call i) }. Null when the trip is not on
 * the rail (not yet left, or done at its terminus).
 */
export function arcAt(line, since, out) {
  const N = line.N, st = line.stops, n = st.length;
  if (!(since >= 0) || since > line.dur) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (N[m] <= since) lo = m; else hi = m - 1; }
  const i = lo;
  out.i = i;
  if (i >= n - 1) { out.s = st[n - 1].d; out.v = 0; out.stop = true; return out; }
  const dw = i === 0 ? DWELL_FIRST : DWELL;
  const tau = since - N[i] - dw;
  if (tau <= 0) { out.s = st[i].d; out.v = 0; out.stop = true; return out; }
  const pr = line.legs[i];
  profileAt(pr, tau / pr.k, out);
  out.s += st[i].d;
  out.v /= pr.k;
  out.stop = false;
  return out;
}

const _inv = { s: 0, v: 0, i: 0, stop: false };

/**
 * The inverse of arcAt: the LATEST second since departure, no later than
 * `hi`, at which the nose had not yet passed arc `a` (a held tram's own clock,
 * js/trams.js). Pure; arcAt never goes back, so a bisection finds it.
 */
export function sinceAtArc(line, a, hi) {
  if (hi > line.dur) hi = line.dur;
  if (!(hi > 0)) return 0;
  if (arcAt(line, hi, _inv).s <= a) return hi;
  let lo = 0;
  if (arcAt(line, lo, _inv).s > a) return 0;
  for (let it = 0; it < 40 && hi - lo > 0.005; it++) {
    const m = (lo + hi) / 2;
    if (arcAt(line, m, _inv).s <= a) lo = m; else hi = m;
  }
  return lo;
}

/**
 * The shared second trip k's nose is due at arc `a` by the timetable (the
 * first moment it is there), or Infinity past its terminus. Pure: who goes
 * first where two trams want the same rail (js/tramspacing.js).
 */
export function dueAt(line, k, a) {
  const dep = departOf(line, k);
  if (a <= line.stops[0].d) return dep;
  if (a > line.stops[line.stops.length - 1].d) return Infinity;
  let lo = 0, hi = line.dur;
  for (let it = 0; it < 40 && hi - lo > 0.01; it++) {
    const m = (lo + hi) / 2;
    if (arcAt(line, m, _inv).s >= a) hi = m; else lo = m;
  }
  return dep + hi;
}

/** Is the path under arc `a` a tunnel (the tram is out of sight there)? */
export function inTunnel(line, a) {
  const f = line.flags;
  if (!f) return false;
  const P = line.P;
  let lo = 0, hi = P.n - 2;
  if (hi < 0) return false;
  if (a <= 0) return (f[0] & LEG_TUNNEL) !== 0;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (P.cum[m] <= a) lo = m; else hi = m - 1; }
  return (f[lo] & LEG_TUNNEL) !== 0;
}

// ---- the cars -----------------------------------------------------------------------
export const KIND_15T = 0, KIND_T3 = 1, KIND_T3_PAIR = 2;

/**
 * What runs trip k of a line, by hash: a 15T ForCity most of the time, a pair
 * of T3s otherwise. Line 23 is the T3 line (single cars), and the historic 41
 * and the circle 42 are single T3s too.
 */
export function kindOf(line, k) {
  const n = +line.ref;
  if (n === 23 || n === 41 || n === 42) return KIND_T3;
  return rnd01(hash32(line.id | 0, k | 0, 0x7a3)) < 0.65 ? KIND_15T : KIND_T3_PAIR;
}

/** Calls where somebody may board: not the terminus, not exit-only. */
export const boards = (line, i) => i < line.stops.length - 1 && !(line.stops[i].f & CALL_EXIT_ONLY);

export const _test = { SLACK, PAD, SAMPLE, legProfile, profileAt, vertexLimits };
