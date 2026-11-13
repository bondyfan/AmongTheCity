// ---- cycleplan.js: one ride, start to finish --------------------------------
// js/cyclenet.js says which ways a rider takes. This module turns that list
// into everything the ride is: the line the wheels follow (the right-hand side
// of a cycle path, the kerb edge of a street), the places it meets a road,
// and a TIMELINE, so that where the rider is at shared second t is a lookup
// and not a simulation. Built once, when the rider is minted, from the route,
// the seed and pure functions of the shared clock: the same plan on every
// co-op screen (the doctrine of js/traffic.js and js/pedestrians.js).
//
// THE SPEED IS PLANNED, NOT REACTED. A bend, a kerb, a red light: each is a
// cap on the speed at a point of the line. One pass forward (how fast can they
// have got by here) and one back (how fast may they still be going to make the
// next cap) give the speed at every knot, and between two knots the rider
// accelerates, cruises and brakes at fixed rates, which has a closed form. So
// a cyclist rolls up to a red light and stops, instead of arriving at speed.
//
// A LIGHT IS ASKED WHEN THEY GET THERE. Whether a signal stops a rider depends
// on when they reach it, and when they reach it depends on whether they brake
// for it. The plan is cut at each signal in turn: arrive rolling, ask
// (signalWait is a pure function of shared time), and if it is red, plan that
// knot again as a stop and wait the red out.
//
// What the plan does NOT know is anything that happens on this client only: a
// walker on the path, a car across the crossing. js/cyclists.js lets a rider
// fall BEHIND the plan for those and catch up after, never run ahead of it.
//
// Only + - x / and sqrt on the shared path: no three.js, no clock, no
// Math.random, no trigonometry.

import { CLS } from './cyclenet.js';
import { survey } from './cyclesurvey.js';
import { schedule, planAt, ACC, BRK, FOOT_V } from './cycletime.js';

export { planAt };

const SMOOTH = 1.1;               // m either side the ridden line is rounded over
const TRIM = 2.5;                 // m of a way left out at each end, so a turn is a chord and not a corner
const dist = (x, z) => Math.sqrt(x * x + z * z);

/** How far right of the centreline of a way its riders keep, metres. */
export function sideOf(w) {
  const hw = (w.r.w ?? 2) / 2;
  // the kerb edge: js/traffic.js keeps every vehicle's flank half a metre off
  // the kerb, and a pair of handlebars is that wide
  if (w.cls === CLS.STREET) return Math.max(0.6, hw - 0.25);
  if (w.cls === CLS.CYCLE) return Math.max(0, Math.min(0.45, hw - 0.5));
  return Math.max(0, Math.min(0.3, hw - 0.5));
}

// position and direction `s` metres into a leg (vertex i0 toward i1 of way w)
function legAt(w, i0, d, s, out) {
  const p = w.r.p, c = w.cum, base = c[i0];
  let i = i0;
  // (cum runs with the vertices; against them the distances count down)
  while (i + d >= 0 && i + d < w.n && Math.abs(c[i + d] - base) < s) i += d;
  let j = i + d;
  if (j < 0 || j >= w.n) { j = i; i = i - d; }
  const a = p[i], b = p[j], L = Math.abs(c[j] - c[i]) || 1;
  const t = (s - Math.abs(c[i] - base)) / L;
  out.x = a[0] + (b[0] - a[0]) * t; out.z = a[1] + (b[1] - a[1]) * t;
  out.dx = (b[0] - a[0]) / L; out.dz = (b[1] - a[1]) / L;
  return out;
}
const _L = { x: 0, z: 0, dx: 0, dz: 0 };

/**
 * legs: js/cyclenet.js route(). opt:
 *   v0          cruising speed, m/s
 *   t0          shared second the ride starts
 *   maxLen      metres of line to keep (the rest of the route is not ridden)
 *   drive       js/crowdsites.js RoadIndex of the carriageways (optional)
 *   sites       js/crowdsites.js SiteIndex, for zebras (optional)
 *   signalWait  (x, z, rdx, rdz, t, crossT) -> seconds, or null where no lights govern
 * Returns the plan, or null if there is nothing to ride.
 */
export function buildPlan(legs, opt) {
  const X = [], Z = [], LG = [];
  const info = [];                  // per leg: { w, d, a0, a1, base }
  // ---- the ridden line ----
  for (let li = 0; li < legs.length; li++) {
    const { w, i0, i1 } = legs[li];
    if (i0 === i1) continue;
    const d = i1 > i0 ? 1 : -1, p = w.r.p;
    const len = Math.abs(w.cum[i1] - w.cum[i0]);
    const off = sideOf(w);
    const tS = li === 0 ? 0 : Math.min(TRIM, len / 3), tE = li === legs.length - 1 ? 0 : Math.min(TRIM, len / 3);
    const rec = { w, d, i0, i1, a0: Infinity, a1: -Infinity, base: 0, len, off, tS };
    const put = (x, z, nx, nz, k) => { X.push(x + nx * off * k); Z.push(z + nz * off * k); LG.push(info.length); };
    legAt(w, i0, d, tS, _L);
    put(_L.x, _L.z, -_L.dz, _L.dx, 1);
    for (let i = i0 + d; i !== i1; i += d) {
      const s = Math.abs(w.cum[i] - w.cum[i0]);
      if (s < tS + 0.3 || s > len - tE - 0.3) continue;
      const a = p[i - d], b = p[i], c = p[i + d];
      let ix = b[0] - a[0], iz = b[1] - a[1], ox = c[0] - b[0], oz = c[1] - b[1];
      const il = dist(ix, iz) || 1, ol = dist(ox, oz) || 1;
      ix /= il; iz /= il; ox /= ol; oz /= ol;
      // right of travel is (-dz, dx); at a vertex, the bisector of the two
      // sides, stretched so the line stays `off` from both
      let nx = -(iz + oz), nz = ix + ox;
      const nl = dist(nx, nz);
      if (nl < 0.2) { nx = -iz; nz = ix; } else { nx /= nl; nz /= nl; }
      const cosH = nx * -iz + nz * ix;
      put(b[0], b[1], nx, nz, 1 / Math.max(0.6, cosH));
    }
    legAt(w, i0, d, len - tE, _L);
    put(_L.x, _L.z, -_L.dz, _L.dx, 1);
    info.push(rec);
  }
  // drop coincident points, measure, and cut to length
  const n0 = X.length;
  if (n0 < 2) return null;
  const px = [], pz = [], lg = [], cum = [];
  const maxLen = opt.maxLen ?? Infinity;
  let acc = 0;
  for (let i = 0; i < n0; i++) {
    const rec = info[LG[i]];
    let dl = 0;
    if (px.length) {
      const k = px.length - 1;
      dl = dist(X[i] - px[k], Z[i] - pz[k]);
      if (acc + dl >= maxLen) {
        const t = (maxLen - acc) / (dl || 1);
        if (rec.a0 === Infinity) { rec.a0 = maxLen; rec.base = maxLen - rec.tS; }
        rec.a1 = maxLen;
        px.push(px[k] + (X[i] - px[k]) * t); pz.push(pz[k] + (Z[i] - pz[k]) * t);
        lg.push(LG[i]); cum.push(maxLen); acc = maxLen;
        break;
      }
    }
    // (a leg's first point, even one that coincides with the last leg's end)
    if (rec.a0 === Infinity) { rec.a0 = acc + dl; rec.base = rec.a0 - rec.tS; }
    rec.a1 = acc + dl;
    if (px.length && dl < 0.05) continue;
    acc += dl;
    px.push(X[i]); pz.push(Z[i]); lg.push(LG[i]); cum.push(acc);
  }
  const n = px.length;
  if (n < 2 || !(acc > 8)) return null;
  const plan = {
    n, len: acc, px: Float64Array.from(px), pz: Float64Array.from(pz), cum: Float64Array.from(cum),
    lg: Uint16Array.from(lg), legs: info, v0: opt.v0, t0: opt.t0,
    cross: [], zones: [], along: 0,
    T: null, S: null, V: null, tEnd: opt.t0,
  };
  survey(plan, opt);
  schedule(plan, opt);
  return plan;
}

// the raw line at `arc`: x, z into (_a | _b | _c), starting the search at hint.s
function lineAt(plan, arc, hint, o) {
  const cum = plan.cum, n = plan.n;
  if (!(arc > 0)) arc = 0; else if (arc > plan.len) arc = plan.len;
  let i = hint.s | 0;
  if (i > n - 2 || cum[i] > arc) i = 0;
  while (i < n - 2 && cum[i + 1] < arc) i++;
  hint.s = i;
  const f = (arc - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
  o.x = plan.px[i] + (plan.px[i + 1] - plan.px[i]) * f;
  o.z = plan.pz[i] + (plan.pz[i + 1] - plan.pz[i]) * f;
  return i;
}
const _a = { x: 0, z: 0 }, _b = { x: 0, z: 0 }, _c = { x: 0, z: 0 }, _h2 = { s: 0 };

/**
 * The rider's place at `arc` metres along the line: writes { x, z, dx, dz,
 * curv, leg } into out. The line is rounded over SMOOTH metres either side, so
 * a turn between two ways is an arc; `curv` is its signed curvature, 1/m,
 * positive turning RIGHT (what the lean and the handlebar are drawn from).
 */
export function planPose(plan, arc, hint, out) {
  const h = Math.min(SMOOTH, plan.len / 4);
  _h2.s = hint.s;
  lineAt(plan, arc - h, _h2, _a);
  const si = lineAt(plan, arc, _h2, _b);
  hint.s = _h2.s;
  lineAt(plan, arc + h, _h2, _c);
  // at the two ends of the line there is nothing to round against
  const k = Math.min(1, Math.min(arc, plan.len - arc) / h);
  out.x = _b.x + ((_a.x + _c.x) / 2 - _b.x) * 0.5 * k;
  out.z = _b.z + ((_a.z + _c.z) / 2 - _b.z) * 0.5 * k;
  let ux = _b.x - _a.x, uz = _b.z - _a.z, vx = _c.x - _b.x, vz = _c.z - _b.z;
  const ul = dist(ux, uz), vl = dist(vx, vz);
  let dx = _c.x - _a.x, dz = _c.z - _a.z;
  const dl = dist(dx, dz);
  if (dl > 1e-6) { dx /= dl; dz /= dl; } else {
    const i = si, L = (plan.cum[i + 1] - plan.cum[i]) || 1;
    dx = (plan.px[i + 1] - plan.px[i]) / L; dz = (plan.pz[i + 1] - plan.pz[i]) / L;
  }
  out.dx = dx; out.dz = dz;
  // the turn between the two half chords, over the metres between their middles
  out.curv = (ul > 1e-3 && vl > 1e-3) ? (ux * vz - uz * vx) / (ul * vl) / ((ul + vl) / 2) : 0;
  out.leg = plan.lg[si];
  return out;
}

/** Is `arc` inside one of the plan's lane zones? */
export function inZone(plan, arc) {
  const z = plan.zones;
  for (let i = 0; i < z.length; i += 2) if (arc >= z[i] && arc <= z[i + 1]) return true;
  return false;
}

export const _tuning = { ACC, BRK, SMOOTH, FOOT_V };
