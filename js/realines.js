// ---- real lines: an OSM route laid onto the traffic graph ----------------------
// The route files (docs/TILE-FORMAT.md, js/tiledata.js) say where a line runs as
// a polyline and where it calls as metres along that polyline. The traffic
// drives on DIRECTED EDGES (js/traffic.js), cut from the same roads after their
// bends were rounded (geo.js smoothBends). This module turns one into the
// other, and holds the timetable arithmetic, both as pure functions: no
// three.js, no clock, no fetch.
//
// HOW A PATH IS MATCHED. A leg of a route is one whole road feature, and the
// graph cuts a road only at nodes, so the path is a chain of whole edges and
// nearly every edge END lies on the path to the decimetre (a rounded bend never
// moves a first or last point; the exception is a junction ON a bend, a
// roundabout above all, where the arm was stitched onto the rounded line a
// metre or three from the surveyed corner). That is the test: from the node
// the walk stands at, the next edge is the one whose far node is on the path,
// about its own length further along, and whose middle is no further off than
// a rounded corner can be; of several, the one that can itself be followed. Where no edge passes (the road is in a tile that has not loaded, or was
// never in the road layer) the chain ends and a new one is looked for further
// along: a route is a LIST of chains, and a trip runs on one chain at a time.

import { hash32, rnd01 } from './crowdsites.js';

const NODE_TOL = 3.6;         // m an edge end may be off the path (a junction on a rounded bend)
const MID_TOL = 4.5;          // m the middle of an edge may be off it (a 9 m fillet cuts 3.2 m)
const BRIDGE = 1.6;           // m between two nodes that are one junction the graph lost
const ACQ_STEP = 24;          // m along the path between attempts to pick the road up again
const START_BACK = 8;         // m before its first call a trip begins rolling
const END_ON = 6;             // …and beyond its last one it ends

// ---- the path, indexed --------------------------------------------------------

/** A decoded route path (flat [x, z, ...]) with its running length. */
export function indexPath(pts) {
  const n = pts.length >> 1;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    cum[i] = cum[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
  }
  return { pts, cum, n, L: n ? cum[n - 1] : 0 };
}

// the last vertex at or before arc `a`
function segAt(P, a) {
  let lo = 0, hi = P.n - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1;
    if (P.cum[m] <= a) lo = m; else hi = m - 1;
  }
  return lo;
}

/** The point of the path at arc `a`, and the way it is heading: out = { x, z, dx, dz }. */
export function pathAt(P, a, out) {
  a = a < 0 ? 0 : a > P.L ? P.L : a;
  const i = segAt(P, a), p = P.pts;
  const ax = p[i * 2], az = p[i * 2 + 1], bx = p[i * 2 + 2] ?? ax, bz = p[i * 2 + 3] ?? az;
  const L = P.cum[i + 1] - P.cum[i];
  const u = L > 1e-9 ? (a - P.cum[i]) / L : 0;
  out.x = ax + (bx - ax) * u; out.z = az + (bz - az) * u;
  out.dx = L > 1e-9 ? (bx - ax) / L : 1; out.dz = L > 1e-9 ? (bz - az) / L : 0;
  return out;
}

/**
 * The point of the path nearest (x, z) among arcs a0..a1: out = { d, a }.
 * Windowed on purpose: a circle line passes the same street twice, and an
 * out-and-back one the same node in both directions.
 */
export function projectOnPath(P, x, z, a0, a1, out) {
  if (a0 < 0) a0 = 0;
  if (a1 > P.L) a1 = P.L;
  out.d = Infinity; out.a = a0;
  if (a1 < a0 || P.n < 2) return out;
  const p = P.pts, cum = P.cum;
  for (let i = segAt(P, a0); i < P.n - 1 && cum[i] <= a1; i++) {
    const ax = p[i * 2], az = p[i * 2 + 1], ex = p[i * 2 + 2] - ax, ez = p[i * 2 + 3] - az;
    const L = cum[i + 1] - cum[i];
    let u = L > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / (L * L) : 0;
    let a = cum[i] + (u < 0 ? 0 : u > 1 ? 1 : u) * L;
    if (a < a0) a = a0; else if (a > a1) a = a1;
    u = L > 1e-9 ? (a - cum[i]) / L : 0;
    const d = Math.hypot(x - ax - ex * u, z - az - ez * u);
    if (d < out.d) { out.d = d; out.a = a; }
  }
  return out;
}

// ---- matching -----------------------------------------------------------------

const _q = { d: 0, a: 0 }, _q2 = { d: 0, a: 0 }, _at = { x: 0, z: 0, dx: 0, dz: 0 };

// Does edge `o`, entered where the path is at arc `a`, follow the path? Returns
// the arc its far node is at, or -1. `dev` (out) is how far its middle strays.
function follows(P, o, a, dev) {
  // a rounded bend is SHORTER than the corner it replaced, never longer
  const lo = a + o.len * 0.9 - 3, hi = a + o.len * 1.45 + 8;
  projectOnPath(P, o.b.x, o.b.z, lo > a ? lo : a, hi, _q);
  if (_q.d > NODE_TOL || _q.a < a + o.len * 0.5) return -1;
  const a1 = _q.a, pts = o.pts, n = pts.length;
  let worst = _q.d;
  // the middle, and on a long edge the quarters: a parallel street that shares
  // both end nodes with this one (a dual carriageway does) is told apart here
  const step = n > 8 ? (n >> 2) : (n >> 1) || 1;
  for (let i = step; i < n - 1; i += step) {
    projectOnPath(P, pts[i][0], pts[i][1], a - 1, a1 + 1, _q2);
    if (_q2.d > MID_TOL) return -1;
    if (_q2.d > worst) worst = _q2.d;
  }
  if (n === 2) {
    projectOnPath(P, (pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2, a - 1, a1 + 1, _q2);
    if (_q2.d > MID_TOL) return -1;
    if (_q2.d > worst) worst = _q2.d;
  }
  dev.v = worst;
  return a1;
}

// distance from a point to an edge polyline
function offEdge(e, x, z) {
  let best = Infinity;
  const pts = e.pts;
  for (let i = 0; i < pts.length - 1; i++) {
    const ax = pts[i][0], az = pts[i][1], ex = pts[i + 1][0] - ax, ez = pts[i + 1][1] - az;
    const L2 = ex * ex + ez * ez;
    let u = L2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    const d = Math.hypot(x - ax - ex * u, z - az - ez * u);
    if (d < best) best = d;
  }
  return best;
}

const _dev = { v: 0 };

// The edge the path is ON at arc `a`: { e, a0, a1 } or null.
function acquire(P, near, a) {
  pathAt(P, a, _at);
  const x = _at.x, z = _at.z;
  let best = null, bd = Infinity;
  for (const e of near(x, z)) {
    if (!e.pts || e.len < 0.5) continue;
    const d = offEdge(e, x, z);
    if (d > MID_TOL || d >= bd) continue;
    // its near node, behind us on the path
    projectOnPath(P, e.a.x, e.a.z, a - e.len * 1.45 - 8, a + 0.5, _q);
    if (_q.d > NODE_TOL) continue;
    const a0 = _q.a;
    const a1 = follows(P, e, a0, _dev);
    if (a1 < 0 || a1 < a - 0.5) continue;
    bd = d;
    best = { e, a0, a1 };
  }
  return best;
}

// stable order for a node's out-list: by identity, never by arrival
const byEid = (p, q) => (p.eid - q.eid) || (p.len - q.len);

/**
 * Lay a path onto the graph. `near(x, z)` gives the edges round a point (any
 * superset will do); `skip(x, z)` may say "nothing is loaded there", which
 * only saves the looking. Returns the chains, in path order:
 *   [{ a0, a1, steps: [{ e, a0, a1 }] }]
 * a0 and a1 are PATH arcs (metres along the raw route polyline), per step the
 * span of path that edge covers. Deterministic for a given set of edges.
 */
export function matchPath(P, near, skip = null) {
  const chains = [];
  let chain = null, a = 0, cur = null;
  const close = () => { if (chain) { chain.a1 = a; chains.push(chain); chain = null; } };
  while (a < P.L - 0.5) {
    if (!chain) {
      let st = null;
      if (!skip || !skip(pathAt(P, a, _at).x, _at.z)) st = acquire(P, near, a);
      if (!st || st.a1 <= a + 0.25) { a += ACQ_STEP; continue; }
      chain = { a0: st.a0, a1: st.a1, steps: [st] };
      a = st.a1; cur = st.e;
      continue;
    }
    let best = null, ba = 0, bdv = Infinity;
    const outs = cur.b.out.length > 1 ? cur.b.out.slice().sort(byEid) : cur.b.out;
    for (const o of outs) {
      const a1 = follows(P, o, a, _dev);
      if (a1 < 0) continue;
      // a stub a few metres long can END near the path without being on it:
      // an edge nothing follows on from costs more than any that goes on
      let dv = _dev.v;
      if (a1 < P.L - 6) {
        let on = false;
        for (const o2 of o.b.out) if (follows(P, o2, a1, _dev) >= 0) { on = true; break; }
        if (!on) dv += 100;
      }
      if (dv < bdv - 1e-6) { bdv = dv; best = o; ba = a1; }
    }
    if (!best) {
      // A JUNCTION THE GRAPH LOST. Where a way ends on the rounded bend of
      // another, its end node and the next way's first node can come out a
      // few decimetres apart (eleven such places on the lines of Pardubice,
      // the station forecourt among them): no edge leaves the node the walk
      // stands on. The road is there all the same, so the walk steps across
      // to an edge that starts within BRIDGE metres and follows the path.
      for (const o of near(cur.b.x, cur.b.z)) {
        if (o.a === cur.b || !o.pts) continue;
        const gap = Math.hypot(o.a.x - cur.b.x, o.a.z - cur.b.z);
        if (gap > BRIDGE) continue;
        const a1 = follows(P, o, a, _dev);
        if (a1 < 0) continue;
        const dv = _dev.v + gap;
        if (dv < bdv - 1e-6 || (Math.abs(dv - bdv) <= 1e-6 && best && o.eid < best.eid)) { bdv = dv; best = o; ba = a1; }
      }
    }
    if (!best) { close(); a += 1; continue; }
    chain.steps.push({ e: best, a0: a, a1: ba });
    a = ba; cur = best;
  }
  close();
  return chains;
}

/** Metres along chain `c` (0 at its first edge's start) of path arc `a`. */
export function chainArc(c, a) {
  let base = 0;
  for (const s of c.steps) {
    if (a <= s.a1 || s === c.steps[c.steps.length - 1]) {
      const u = s.a1 > s.a0 ? (a - s.a0) / (s.a1 - s.a0) : 0;
      return base + (u < 0 ? 0 : u > 1 ? 1 : u) * s.e.len;
    }
    base += s.e.len;
  }
  return base;
}

/**
 * The part of a chain a trip drives, in the shape js/traffic.js addFixed
 * takes: the calls `i0..i1` of `stops` (each { d } a path arc) must lie on the
 * chain. Returns { route, startS, len, arcs } with arcs[k] the route arc of
 * call i0 + k, or null when the chain does not hold them. `halt` moves every
 * halt along the road from the point abreast the stop (js/transitbody.js:
 * where the centre of the body stands when its nose is at the post).
 */
export function chainTrip(c, stops, i0, i1, halt = 0) {
  if (!c || stops[i0].d < c.a0 - 0.5 || stops[i1].d > c.a1 + 0.5) return null;
  // the first step the trip needs: the one its first call stands on
  let s0 = 0;
  while (s0 < c.steps.length - 1 && c.steps[s0].a1 < stops[i0].d - 1e-6) s0++;
  const route = [];
  let base = 0, k = i0;
  const arcs = [];
  const onStep = (s, a) => {
    const u = s.a1 > s.a0 ? (a - s.a0) / (s.a1 - s.a0) : 0;
    return (u < 0 ? 0 : u > 1 ? 1 : u) * s.e.len;
  };
  const first = onStep(c.steps[s0], stops[i0].d) + halt;
  const startS = Math.max(0, first - START_BACK);
  base = -startS;
  for (let i = s0; i < c.steps.length; i++) {
    const s = c.steps[i], e = s.e;
    let turnIn = 0;
    if (route.length) {
      const p = route[route.length - 1].e;
      const dot = p.ldx * e.fdx + p.ldz * e.fdz, crs = p.ldx * e.fdz - p.ldz * e.fdx;
      turnIn = Math.abs(Math.atan2(crs, dot));
      route[route.length - 1].turnOut = turnIn;
    }
    route.push({ e, base, turnIn, turnOut: 0 });
    while (k <= i1 && (stops[k].d <= s.a1 + 1e-6 || i === c.steps.length - 1)) {
      arcs.push(base + onStep(s, stops[k].d) + halt);
      k++;
    }
    base += e.len;
    if (k > i1) break;
  }
  if (k <= i1) return null;
  // The schedule only calls at a stop that is AHEAD of it: a first call at the
  // very start of its road (a terminus mapped at the end of the way) is put
  // two metres down it, or the trip would leave without ever having stood there.
  if (arcs[0] < startS + 2) arcs[0] = startS + 2;
  // arcs must strictly increase or the schedule cannot stop at them in order
  for (let j = 1; j < arcs.length; j++) if (arcs[j] < arcs[j - 1] + 12) arcs[j] = arcs[j - 1] + 12;
  // …and stay on the road there is: two calls a few metres apart at the very
  // end (a circle line's last call is its first) are pushed back, not off it
  if (arcs[arcs.length - 1] > base - 1) {
    arcs[arcs.length - 1] = base - 1;
    for (let j = arcs.length - 2; j >= 0 && arcs[j] > arcs[j + 1] - 12; j--) arcs[j] = arcs[j + 1] - 12;
    if (arcs[0] < startS + 2) return null;
  }
  const len = Math.min(base, arcs[arcs.length - 1] + END_ON);
  return { route, startS, len, arcs };
}

// ---- the timetable --------------------------------------------------------------
// PURE ARITHMETIC, on purpose. A trip is due at call i at
//
//     (phase + k) x headway + N[i]
//
// where N is made of nothing but the route file: the metres between calls at a
// commercial speed, and the dwell. No client has to have driven the line (or
// to have its first half loaded) to know when the 13 is due at Masarykovo
// náměstí, so two players who met the same bus from opposite ends of town
// agree where it is. The traffic schedule that carries the bus HOLDS at each
// call until this time (js/traffic.js, the `hold` of a stop), which is what
// real timetables are for, and the pace below is slow enough that it nearly
// always arrives early enough to do so.
export const DWELL = 12, DWELL_TERMINUS = 20;   // s the doors stand open
// Measured against the schedule's own dry run over the 67 lines round
// Pardubice (2 853 calls): a bus is due a median 20 s after it has pulled in
// (none more than a minute and a half), and one call in twelve finds it late,
// by half a minute at most for nine in ten of those.
const PACE = 8.4;             // m/s between calls: 30 km/h, lights and corners included
const PACE_OPEN = 12;         // …and on a long leg out of town, 43 km/h
const LEG_TOWN = 500, LEG_OPEN = 2500;   // m: legs this long run at PACE, this long at PACE_OPEN
const LEG_FIXED = 7;          // s per leg: pulling away and pulling up

// A long leg is an open road. Timed at the town pace a regional bus came in
// two or three minutes early from Živanice and stood at the stop holding the
// buses behind it (line 18, 24, 6 and the 6506xx coaches into the station).
export function legPace(m) {
  const u = (m - LEG_TOWN) / (LEG_OPEN - LEG_TOWN);
  return PACE + (PACE_OPEN - PACE) * (u < 0 ? 0 : u > 1 ? 1 : u);
}

/** Seconds after a trip's departure that it is due at each call. */
export function nominalTimes(arcs) {
  const N = new Float64Array(arcs.length);
  for (let i = 1; i < arcs.length; i++) {
    const m = Math.max(0, arcs[i] - arcs[i - 1]);
    N[i] = N[i - 1] + DWELL + LEG_FIXED + m / legPace(m);
  }
  return N;
}

/** How often a line runs, from nothing but the route record. */
export function headwayOf(route) {
  const town = /^MHD\b/.test(route.nw ?? '') || route.m === 1;
  if (!town || (route.L ?? 0) > 26000) return 1800;      // a regional coach
  return route.m === 1 ? 600 : 900;                        // trolleybus, town bus
}

/** A line's place in its own headway, 0..1: a hash of the relation id. */
export const phaseOf = (route) => rnd01(hash32(route.id | 0, 0x7a11));

export const _test = { NODE_TOL, MID_TOL, START_BACK, END_ON, PACE, LEG_FIXED };
