// ---- The lane an AI driver steers for (js/aidriver.js, js/traffic.js) ----
// Pure geometry on traffic.js's route records: where the lane is at a route
// arc (corners rounded to a radius a car can drive), the foot of the
// perpendicular from a point onto it, where along the route a body has got
// to, and the speed the corners ahead allow. Coordinates: +x east, -z north;
// "right" of a direction (dx, dz) is (-dz, dx). Plain arithmetic, nothing
// allocated per call, no Math.random: it runs for every car at 20 Hz.

// ---- the lane as a function of route arc ----------------------------------
// A route is traffic.js's itinerary: steps { e, base } where e.pts / e.cum are
// the edge's centreline polyline and its cumulative length, base the route arc
// at which the step starts. The LANE is that centreline moved `off` metres to
// the right, with every corner ROUNDED. OSM draws a junction turn as one
// vertex, or worse as a zigzag of two-metre edges through the junction box
// (dual carriageways, the links between them); a rail could drive that, a car
// cannot. So a corner is taken from the last LONG segment before it to the
// first long segment after it (anything under SHORT_SEG in between is the
// junction's insides and is skipped), and drawn as one cubic Bezier from t
// metres before the end of the incoming lane line to t metres past the start
// of the outgoing one. t is what a radius r0 (the vehicle's, cornerR) needs for
// the net turn, cut down to what the two long segments have room for. The
// lane is then continuous in position and direction and is a path a car can
// take, and the speed planner reads the radius of the very curve the wheel is
// turned for (cornerAt's R).
import { laneSide } from './regions.js';
// +1 where traffic keeps right (Czechia), -1 where it keeps left (Mahé,
// js/regions.js). Every `off` here means "metres right of travel" as the
// callers compute it; the two public entries turn it into the live side.
const SIDE = laneSide();

const T_MAX = 25;                            // m: no rounding longer than this on either side
const SHORT_SEG = 5;                         // m: a segment shorter than this is inside a corner
const RUN_MAX = 6;                           // ...and at most this many of them make one corner
const INSIDE_K = 0.6;                        // x the two roundings a segment must fit, or it is inside the corner
const CUT_IN = 0.35;                         // m the centre keeps inside the inner kerb of a tight turn
const CUT_K = 0.6;                           // legs under this share of r0 tan(phi): a squeezed corner
const TIGHT_K = 0.7;                         // x r0 on cornerAt R (already x0.85): tighter than the lock radius, walked (curveCap)
const TIGHT_V = 1.4;                         // m/s it is walked at (under pedestrians.js HIT_MIN_SPEED 1.5)

// output records, reused (no allocation per call)
export const lanePt = { x: 0, z: 0, dx: 0, dz: 0, k: 0, sp: 1, i: 0, seg: 0 };
const mkC = () => ({ ok: false, cut: false, aS: 0, aE: 0, Sx: 0, Sz: 0, C1x: 0, C1z: 0, C2x: 0, C2z: 0, Ex: 0, Ez: 0, R: 0 });
const _v = mkC(), _w = mkC(), _q = mkC();
const _sg = { i: 0, k: 0 };

const segLen = (route, i, k) => (route[i].e.cum[k + 1] - route[i].e.cum[k]) || 1e-6;
/** step _sg to the previous / next segment of the route; false at either end */
function segPrev(route) {
  if (_sg.k > 0) { _sg.k--; return true; }
  if (_sg.i > 0) { _sg.i--; _sg.k = route[_sg.i].e.pts.length - 2; return true; }
  return false;
}
function segNext(route) {
  if (_sg.k < route[_sg.i].e.pts.length - 2) { _sg.k++; return true; }
  if (_sg.i + 1 < route.length) { _sg.i++; _sg.k = 0; return true; }
  return false;
}
function bez(c, u, out, span = 1) {
  const w = 1 - u, a = w * w * w, b = 3 * w * w * u, d = 3 * w * u * u, f = u * u * u;
  out.x = a * c.Sx + b * c.C1x + d * c.C2x + f * c.Ex;
  out.z = a * c.Sz + b * c.C1z + d * c.C2z + f * c.Ez;
  const tx = 3 * (w * w * (c.C1x - c.Sx) + 2 * w * u * (c.C2x - c.C1x) + u * u * (c.Ex - c.C2x));
  const tz = 3 * (w * w * (c.C1z - c.Sz) + 2 * w * u * (c.C2z - c.C1z) + u * u * (c.Ez - c.C2z));
  const l = Math.sqrt(tx * tx + tz * tz) || 1e-6;
  out.dx = tx / l; out.dz = tz / l;
  // curvature, + to the right of travel: (B' x B'') / |B'|^3 in this frame
  const ax = 6 * (w * (c.C2x - 2 * c.C1x + c.Sx) + u * (c.Ex - 2 * c.C2x + c.C1x));
  const az = 6 * (w * (c.C2z - 2 * c.C1z + c.Sz) + u * (c.Ez - 2 * c.C2z + c.C1z));
  out.k = (tx * az - tz * ax) / (l * l * l);
  out.sp = l / span;                          // lane metres per metre of route arc
}
const mkP = () => ({ x: 0, z: 0, dx: 0, dz: 0, k: 0, sp: 1, i: 0, seg: 0 });
const _b0 = mkP(), _b1 = mkP(), _b2 = mkP();
/** circumradius of three points (Infinity when they are in a line) */
function circR(a, b, c) {
  const abx = b.x - a.x, abz = b.z - a.z, bcx = c.x - b.x, bcz = c.z - b.z, cax = a.x - c.x, caz = a.z - c.z;
  const cr = Math.abs(abx * bcz - abz * bcx);
  if (cr < 1e-9) return Infinity;
  return Math.sqrt((abx * abx + abz * abz) * (bcx * bcx + bcz * bcz) * (cax * cax + caz * caz)) / (2 * cr);
}

/**
 * The rounding a single vertex asks of its segments (r0 tan(angle/2)): the
 * vertex at the start of segment k of step i, k one past the step's last
 * segment meaning the vertex at its end. 0 at either end of the route.
 */
function needAt(route, i, k, r0) {
  const e = route[i].e, n = e.pts.length - 1;
  let ax, az, bx, bz;
  if (k >= n) {                             // the vertex at the end of the step
    if (i + 1 >= route.length) return 0;
    ax = e.ldx; az = e.ldz; bx = route[i + 1].e.fdx; bz = route[i + 1].e.fdz;
  } else if (k === 0) {
    if (i === 0) return 0;
    const pe = route[i - 1].e;
    ax = pe.ldx; az = pe.ldz; bx = e.fdx; bz = e.fdz;
  } else {
    const P = e.pts, cum = e.cum;
    const L0 = (cum[k] - cum[k - 1]) || 1e-6, L1 = (cum[k + 1] - cum[k]) || 1e-6;
    ax = (P[k][0] - P[k - 1][0]) / L0; az = (P[k][1] - P[k - 1][1]) / L0;
    bx = (P[k + 1][0] - P[k][0]) / L1; bz = (P[k + 1][1] - P[k][1]) / L1;
  }
  const sn = ax * bz - az * bx, cs = ax * bx + az * bz;
  const ang = Math.atan2(sn > 0 ? sn : -sn, cs);
  return ang < 0.03 ? 0 : r0 * Math.tan((ang < 2.4 ? ang : 2.4) * 0.5);
}

/** Is segment k of step i part of a corner rather than a way into or out of one? */
function inside(route, i, k, r0) {
  const L = segLen(route, i, k);
  if (L < SHORT_SEG) return true;
  return L < INSIDE_K * (needAt(route, i, k, r0) + needAt(route, i, k + 1, r0));
}

/**
 * The rounded corner that the vertex at the START of segment k of route step
 * i belongs to, for a lane `off` m right of the centreline and a radius r0.
 * Fills o (o.ok false where there is no corner: a straight, or the very start
 * of the route). o.aS..o.aE is the route arc it spans, o.R its tightest radius.
 */
export function cornerAt(route, i, k, off, r0, o) {
  o.ok = false;
  if (!route[i] || k > route[i].e.pts.length - 2) return o;
  // back over short segments to the long one the corner is entered from
  // (a segment is also inside the corner when it is too short to round both
  // of its vertices for r0: two sharp kinks four metres apart are one turn
  // to a car, and rounded apart each one would be tighter than it can steer)
  _sg.i = i; _sg.k = k;
  let n = 0;
  if (!segPrev(route)) return o;
  while (n < RUN_MAX && inside(route, _sg.i, _sg.k, r0)) {
    const pi = _sg.i, pk = _sg.k;
    if (!segPrev(route)) { _sg.i = pi; _sg.k = pk; break; }
    n++;
  }
  const ii = _sg.i, ik = _sg.k;                 // the incoming long segment
  // …and forward from (i, k) to the long one it leaves by
  _sg.i = i; _sg.k = k; n = 0;
  while (n < RUN_MAX && inside(route, _sg.i, _sg.k, r0)) {
    const pi = _sg.i, pk = _sg.k;
    if (!segNext(route)) { _sg.i = pi; _sg.k = pk; break; }
    n++;
  }
  const oi = _sg.i, ok = _sg.k;                 // the outgoing long segment
  const ei = route[ii].e, eo = route[oi].e;
  const Lin = segLen(route, ii, ik), Lout = segLen(route, oi, ok);
  const ax = ei.pts[ik + 1][0], az = ei.pts[ik + 1][1];      // end of the way in
  const bx = eo.pts[ok][0], bz = eo.pts[ok][1];              // start of the way out
  const dix = (ax - ei.pts[ik][0]) / Lin, diz = (az - ei.pts[ik][1]) / Lin;
  const dox = (eo.pts[ok + 1][0] - bx) / Lout, doz = (eo.pts[ok + 1][1] - bz) / Lout;
  const cs = dix * dox + diz * doz, sn = dix * doz - diz * dox;
  const ang = Math.atan2(sn > 0 ? sn : -sn, cs);
  const gap = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
  if (ang < 0.03 && gap < 0.05) return o;     // a straight vertex
  // the two lane lines (right normal (-dz, dx))
  const Ax = ax - diz * off, Az = az + dix * off;
  const Bx = bx - doz * off, Bz = bz + dox * off;
  // Legs of r0 tan(phi), phi half the turn: a circle's. The quadratic drawn
  // on them is a little tighter at the apex (0.71 r0 at a right angle), and
  // measured that is the better trade: legs long enough for a true r0 apex
  // start every corner so early that the car cuts the inside of the next one.
  const phi = (ang < 2.4 ? ang : 2.4) * 0.5;
  let t = r0 * Math.tan(phi);
  // …and a turn towards the kerb the lane hugs (a right turn, for a lane
  // right of the centre) cuts the inside by t sin(phi) / 2 at the apex: on a
  // narrow street the legs are shortened until that stays CUT_IN inside the
  // asphalt, whatever it costs in radius (Stanley keeps the front axle on the
  // line; the car swings wide of a turn it cannot make, not over the kerb)
  if ((sn > 0) === (off > 0) && off !== 0 && phi > 0.15) {
    const half = 0.5 * Math.min(ei.road?.w ?? 7, eo.road?.w ?? 7);
    const a = off > 0 ? off : -off;
    const tMax = 2 * (half - a - CUT_IN) / (Math.sin(phi) * Math.cos(phi));
    if (t > tMax) t = tMax > 1 ? tMax : 1;
  }
  if (t < gap * 0.5 + 1.5) t = gap * 0.5 + 1.5;
  // Each long segment is shared with the corner at its other end. Half of it
  // each (less a margin) is the fair split, but a corner that needs more may
  // take what its neighbour does not: a sharp turn off a straight that ends
  // in a gentle bend gets the room it needs.
  let tin = t, tout = t;
  const rin = Math.max(0.45 * Lin, Lin - needAt(route, ii, ik, r0) - 0.3);
  const rout = Math.max(0.45 * Lout, Lout - needAt(route, oi, ok + 1, r0) - 0.3);
  if (tin > rin) tin = rin;
  if (tout > rout) tout = rout;
  if (tin > T_MAX) tin = T_MAX;
  if (tout > T_MAX) tout = T_MAX;
  // squeezed: the way in or out had well under the room the radius asks for,
  // so the curve is tighter than the vehicle was rounded for (curveCap walks it)
  o.cut = (tin < tout ? tin : tout) < CUT_K * r0 * Math.tan(phi);
  o.Sx = Ax - dix * tin; o.Sz = Az - diz * tin;
  o.Ex = Bx + dox * tout; o.Ez = Bz + doz * tout;
  // Control points: where the two lane lines cross, if they cross between
  // the ends (a proper corner: the curve is then the quadratic through that
  // point, written as a cubic); along the two tangents otherwise (a jog, a
  // hairpin, lines that cross behind the car). The legs run from the lane
  // points at the two vertices, not from the crossing: on the inside of a
  // turn that makes them `off` shorter and the apex tighter, and measured
  // on the real town that is the variant that stays on the asphalt best
  // (legs from the crossing start the turn earlier and run it wider, and
  // the body, which cannot follow the tighter corners anyway, then leaves
  // the lane by more).
  let crossed = false;
  const den = dix * doz - diz * dox;
  if (den > 0.15 || den < -0.15) {
    const lam = ((Bx - Ax) * doz - (Bz - Az) * dox) / den;  // along the way in, from A
    const mu = ((Bx - Ax) * diz - (Bz - Az) * dix) / den;   // along the way out, from B
    if (lam > -tin * 0.95 && mu < tout * 0.95) {
      const Mx = Ax + dix * lam, Mz = Az + diz * lam;
      o.C1x = o.Sx + (Mx - o.Sx) * (2 / 3); o.C1z = o.Sz + (Mz - o.Sz) * (2 / 3);
      o.C2x = o.Ex + (Mx - o.Ex) * (2 / 3); o.C2z = o.Ez + (Mz - o.Ez) * (2 / 3);
      crossed = true;
    }
  }
  if (!crossed) {
    const h = 0.4 * Math.sqrt((o.Ex - o.Sx) ** 2 + (o.Ez - o.Sz) ** 2);
    o.C1x = o.Sx + dix * h; o.C1z = o.Sz + diz * h;
    o.C2x = o.Ex - dox * h; o.C2z = o.Ez - doz * h;
  }
  o.aS = route[ii].base + ei.cum[ik + 1] - tin;
  o.aE = route[oi].base + eo.cum[ok] + tout;
  // the tightest radius, from five points along the curve
  let R = Infinity;
  bez(o, 0.1, _b0); bez(o, 0.3, _b1);
  for (let j = 0; j < 3; j++) {
    bez(o, 0.5 + 0.2 * j, _b2);
    const r = circR(_b0, _b1, _b2);
    if (r < R) R = r;
    _b0.x = _b1.x; _b0.z = _b1.z; _b1.x = _b2.x; _b1.z = _b2.z;
  }
  // (sampled 0.2 apart, the triples span 0.4 of the curve: a chord that long
  // slightly overstates the radius at the apex, hence the 0.85)
  o.R = R * 0.85;
  o.ok = true;
  return o;
}

/**
 * The lane point at route arc `arc`, `off` m right of the centreline, corners
 * rounded for radius r0 (see cornerAt). `i` and `seg` are the caller's hints
 * (step and segment), searched from, so a car that only ever moves forward
 * pays O(1). Past the end of the route the last segment runs straight on, so
 * a pursuit point is always defined.
 */
export function laneAt(route, i, seg, arc, off, out = lanePt, r0 = 5) {
  off *= SIDE;   // (Mahé keeps left: the same lane, mirrored about the centreline)
  if (i < 0) i = 0;
  if (i >= route.length) i = route.length - 1;
  while (i > 0 && arc < route[i].base) { i--; seg = 1e9; }
  while (i + 1 < route.length && arc >= route[i + 1].base) { i++; seg = 0; }
  const st = route[i], e = st.e, cum = e.cum, n = e.pts.length - 1;
  const s = arc - st.base;
  let k = seg > n - 1 ? n - 1 : seg < 0 ? 0 : seg;
  while (k > 0 && s < cum[k]) k--;
  while (k < n - 1 && s > cum[k + 1]) k++;
  out.i = i; out.seg = k;
  // the corner this segment starts in, and the one it ends in (the same one
  // when the segment is itself a short piece of a junction)
  const c = cornerAt(route, i, k, off, r0, _v);
  if (c.ok && arc >= c.aS && arc <= c.aE) { const sp = c.aE - c.aS || 1; bez(c, (arc - c.aS) / sp, out, sp); return out; }
  const c2 = k + 1 < n ? cornerAt(route, i, k + 1, off, r0, _w)
    : i + 1 < route.length ? cornerAt(route, i + 1, 0, off, r0, _w) : null;
  if (c2 && c2.ok && arc >= c2.aS && arc <= c2.aE) { const sp = c2.aE - c2.aS || 1; bez(c2, (arc - c2.aS) / sp, out, sp); return out; }
  const a = e.pts[k];
  const L = (cum[k + 1] - cum[k]) || 1e-6;
  const dx = (e.pts[k + 1][0] - a[0]) / L, dz = (e.pts[k + 1][1] - a[1]) / L;
  const t = s - cum[k];                     // may run past either end (extension)
  out.x = a[0] + dx * t - dz * off;         // right of travel = (-dz, dx)
  out.z = a[1] + dz * t + dx * off;
  out.dx = dx; out.dz = dz; out.k = 0; out.sp = 1;
  return out;
}

/**
 * The foot of the perpendicular from (x, z) onto the lane: the route arc whose
 * lane point is level with (x, z), found from a guess a0 by three Newton steps
 * (the along-track error divided by how many lane metres one metre of arc
 * is). Fills `out` as laneAt does, plus out.arc.
 */
export function laneFoot(route, i, seg, a0, x, z, off, r0, out, lo = -Infinity, hi = Infinity) {
  let a = a0 < lo ? lo : a0 > hi ? hi : a0;
  for (let it = 0; it < 3; it++) {
    laneAt(route, i, seg, a, off, out, r0);
    i = out.i; seg = out.seg;
    const et = (x - out.x) * out.dx + (z - out.z) * out.dz;
    if (et < 0.02 && et > -0.02) break;
    let da = et / (out.sp > 0.2 ? out.sp : 0.2);
    if (da > 3) da = 3; else if (da < -3) da = -3;
    const na = a + da < lo ? lo : a + da > hi ? hi : a + da;
    if (na === a) break;
    a = na;
  }
  // (the bracket is the caller's: where the point can plausibly be along its
  // own lane. Newton on a lane that doubles back can find the perpendicular
  // foot on a stretch twenty metres on, and a car steered for THAT one drives
  // straight off the road.)
  if (out.arc !== a) laneAt(route, i, seg, a, off, out, r0);
  out.arc = a;
  return out;
}

/**
 * Where along the route a body at (x, z), heading h, has got to: the nearest
 * point of the centreline inside [arc0 - back, arc0 + ahead]. A small penalty
 * for facing against a segment keeps a car turning in a dead end on the leg it
 * is actually driving rather than its twin, which runs on the same line.
 * Returns the arc (the caller decides whether to let it go backwards).
 */
export function projectArc(route, i, arc0, x, z, h, ahead, back = 1) {
  const fx = -Math.sin(h), fz = -Math.cos(h);
  const lo = arc0 - back, hi = arc0 + ahead;
  while (i > 0 && lo < route[i].base) i--;
  let best = 1e18, bestArc = arc0;
  for (; i < route.length; i++) {
    const st = route[i], e = st.e;
    if (st.base > hi) break;
    const P = e.pts, cum = e.cum;
    for (let k = 0; k < P.length - 1; k++) {
      const s0 = st.base + cum[k], s1 = st.base + cum[k + 1];
      if (s1 < lo || s0 > hi) continue;
      const ax = P[k][0], az = P[k][1];
      const ex = P[k + 1][0] - ax, ez = P[k + 1][1] - az;
      const L = (cum[k + 1] - cum[k]) || 1e-6;
      let t = ((x - ax) * ex + (z - az) * ez) / (L * L);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      let sa = s0 + t * L;
      if (sa < lo) sa = lo; else if (sa > hi) sa = hi;
      const qx = ax + ex * ((sa - s0) / L), qz = az + ez * ((sa - s0) / L);
      const ddx = x - qx, ddz = z - qz;
      const facing = (fx * ex + fz * ez) / L;            // 1 along, -1 against
      const d = Math.sqrt(ddx * ddx + ddz * ddz) + 2 * (1 - facing);
      if (d < best) { best = d; bestArc = sa; }
    }
  }
  return bestArc;
}

/**
 * The speed the lane ahead allows. Walks the route's corners from one corner
 * behind `arc` to `reach` ahead; each one is the rounded corner laneAt drives
 * (cornerAt, same r0), so its radius is known, and the speed that keeps the
 * turn at aLat is sqrt(aLat R). The cap is the braking envelope
 * v^2 = vc^2 + 2 b d, d to where the rounding begins.
 */
export function curveCap(route, i, arc, reach, aLat, brake, off = 0, r0 = 5, lockR = r0) {
  off *= SIDE;   // (the lane cornerAt rounds is laneAt's, so it is mirrored the same way)
  let cap = Infinity, lastS = NaN;
  const hi = arc + reach;
  while (i > 0 && route[i].base > arc - T_MAX) i--;
  for (; i < route.length; i++) {
    const st = route[i], e = st.e;
    if (st.base > hi + T_MAX) break;
    const n = e.pts.length - 1;
    for (let k = 0; k < n; k++) {
      const s = st.base + e.cum[k];
      if (s < arc - T_MAX || s > hi + T_MAX) continue;
      const c = cornerAt(route, i, k, off, r0, _q);
      if (!c.ok || c.aS === lastS || c.aE < arc || c.aS > hi) continue;
      lastS = c.aS;
      let v = Math.sqrt(aLat * c.R);
      if (v < 2.2) v = 2.2;
      // A corner the rounding had to SQUEEZE (the segments around it had no
      // room for r0: OSM's two-metre service-road bends) and so drew tighter
      // than the vehicle can steer is one the body makes only on the crawl
      // lock (aidriver lockAt): walk it round, under the speed that can knock
      // anybody down (pedestrians.js HIT_MIN_SPEED), since this is where a car
      // brushes the kerb. An ordinary junction turn is not squeezed and keeps
      // its sqrt(aLat R).
      // (lockR: the vehicle's own radius, where a caller rounds wider than it,
      // as traffic.js does on a motorway: the walk is for corners the vehicle
      // cannot steer, not for ones rounded tighter than a 300 m radius)
      if (c.cut && c.R < lockR * TIGHT_K) v = TIGHT_V;
      const d = c.aS - arc;
      const vc = d > 0 ? Math.sqrt(v * v + 2 * brake * d) : v;
      if (vc < cap) cap = vc;
    }
  }
  return cap;
}
