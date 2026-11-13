// ---- cycletime.js: when a rider is where ----------------------------------------
// Split out of js/cycleplan.js: the timeline of one ride. js/cycleplan.js has
// the story (caps, one pass forward and one back, a light asked on arrival);
// this is the arithmetic.
//
// Only + - x / and sqrt: the timeline is shared between co-op clients, and
// those are the operations every engine rounds the same way (js/traffic.js
// has the story). A bend is measured by its CHORD for that reason, not its
// angle: no acos.

import { CLS } from './cyclenet.js';

export const ACC = 0.85, BRK = 1.5;   // m/s2: pushing off, and braking without drama
export const FOOT_V = 2.6;            // m/s on a footway: among people

const dist = (x, z) => Math.sqrt(x * x + z * z);

// The speed a bend can be taken at: lateral grip over the radius the rounded
// line really has there. `ch` is the chord between the two unit directions,
// sqrt(2 - 2 cos): the angle itself for a gentle bend, 1.41 for a right angle,
// 2 for a turn back on itself.
function turnCap(ch) {
  if (ch < 0.12) return Infinity;
  return Math.sqrt(5.3 / ch);
}

// T, S, V: shared second, metres along the line and speed at each key. Between
// two keys the acceleration is constant, so position is a quadratic in time.
export function schedule(plan, opt) {
  const { cum, px, pz, lg, legs, cross } = plan;
  const v0 = plan.v0;
  // knots: every vertex of the line (with its bend), and the near edge of every crossing
  const ks = [0], kc = [v0], kx = [-1];
  for (let i = 1; i < plan.n - 1; i++) {
    const ax = px[i] - px[i - 1], az = pz[i] - pz[i - 1], bx = px[i + 1] - px[i], bz = pz[i + 1] - pz[i];
    const al = dist(ax, az) || 1, bl = dist(bx, bz) || 1;
    let c = (ax * bx + az * bz) / (al * bl);
    c = c > 1 ? 1 : c < -1 ? -1 : c;
    ks.push(cum[i]); kc.push(Math.min(v0, turnCap(Math.sqrt(2 - 2 * c)))); kx.push(-1);
  }
  // the end of the line is a stop: a rider somebody is still watching when
  // the ride runs out brakes to a halt there, and does not freeze at speed
  ks.push(plan.len); kc.push(0); kx.push(-1);
  for (let i = 0; i < cross.length; i++) {
    const c = cross[i];
    if (c.a0 < 1 || c.a0 > plan.len - 1) continue;      // born on it, or the ride ends there
    // rolling up to it: slow enough to look where they give way, a glance on a
    // zebra, and through a driveway mouth as they were
    const cap = c.sig ? 3.6 : !c.kerb ? 3.6 : c.give ? (c.street ? 2.6 : 2.2) : 3.0;
    ks.push(c.a0); kc.push(Math.min(v0, cap)); kx.push(i);
  }
  const order = ks.map((_, i) => i).sort((a, b) => (ks[a] - ks[b]) || (a - b));
  const S = [], C = [], XI = [];
  for (const i of order) {
    const k = S.length - 1;
    if (k >= 0 && ks[i] - S[k] < 0.05) {
      if (kc[i] < C[k]) C[k] = kc[i];
      if (kx[i] >= 0) XI[k] = kx[i];
      continue;
    }
    S.push(ks[i]); C.push(kc[i]); XI.push(kx[i]);
  }
  const m = S.length;
  // the most a stretch between two knots is ridden at: a footway is slow
  const VM = new Float64Array(m);
  for (let i = 0, si = 0; i < m - 1; i++) {
    const mid = (S[i] + S[i + 1]) / 2;
    while (si < plan.n - 2 && cum[si + 1] < mid) si++;
    VM[i] = legs[lg[si]].w.cls === CLS.FOOT ? Math.min(v0, FOOT_V) : v0;
  }
  const V = new Float64Array(m);
  const dwell = new Float64Array(m);     // seconds stood at a knot; -1: a stop whose wait is asked on arrival
  const done = new Uint8Array(m);        // a signal that has been asked
  const kT = new Float64Array(m);
  let T = null, TS = null, TV = null;
  const waitAt = (i, t) => {
    const c = cross[XI[i]];
    const w = opt.signalWait(c.cx, c.cz, c.rdx, c.rdz, t, (c.a1 - c.a0) / 3 + 1);
    return w === null || !(w > 0) ? 0 : w;
  };
  for (let round = 0; round < 24; round++) {
    // forward: how fast can they have got; back: how fast may they still be going
    V[0] = Math.min(C[0], v0);
    for (let i = 0; i < m - 1; i++) {
      const cap = dwell[i + 1] !== 0 ? 0 : Math.min(C[i + 1], VM[i], i + 1 < m - 1 ? VM[i + 1] : v0);
      V[i + 1] = Math.min(cap, Math.sqrt(V[i] * V[i] + 2 * ACC * (S[i + 1] - S[i])));
    }
    for (let i = m - 2; i >= 0; i--) {
      const b = Math.sqrt(V[i + 1] * V[i + 1] + 2 * BRK * (S[i + 1] - S[i]));
      if (b < V[i]) V[i] = b;
    }
    // lay the keys out in time
    T = [plan.t0]; TS = [0]; TV = [V[0]];
    let t = plan.t0, s = 0, v = V[0];
    const key = (s1, v1) => {
      const ds = s1 - s;
      // (two stops a hand apart: nothing to divide by, and a second to cover it)
      if (ds > 1e-9) t += v + v1 > 1e-6 ? 2 * ds / (v + v1) : 1;
      s = s1; v = v1;
      T.push(t); TS.push(s); TV.push(v);
    };
    let ask = -1;
    kT[0] = t;
    for (let i = 0; i < m - 1 && ask < 0; i++) {
      const sa = S[i], sb = S[i + 1], ds = sb - sa, va = V[i], vb = V[i + 1];
      // (between two caps a few metres apart, the two halves of one corner,
      // nobody sprints: the faster of the two ends is as fast as it gets)
      const vm = ds < 8 ? Math.min(VM[i], Math.max(va, vb)) : VM[i];
      const d1 = (vm * vm - va * va) / (2 * ACC), d2 = (vm * vm - vb * vb) / (2 * BRK);
      if (va >= vm - 1e-6 && vb >= vm - 1e-6) key(sb, vb);
      else if (d1 + d2 <= ds) {
        if (d1 > 0.02) key(sa + d1, vm);
        if (d2 > 0.02 && ds - d2 > d1 + 0.02) key(sb - d2, vm);
        key(sb, vb);
      } else {
        const vp = Math.sqrt((2 * ACC * BRK * ds + BRK * va * va + ACC * vb * vb) / (ACC + BRK));
        const dp = (vp * vp - va * va) / (2 * ACC);
        if (dp > 0.02 && dp < ds - 0.02) key(sa + dp, vp);
        key(sb, vb);
      }
      kT[i + 1] = t;
      const k = i + 1;
      if (XI[k] >= 0 && cross[XI[k]].sig && opt.signalWait) {
        if (!done[k]) {
          // rolling up to lights nobody has asked yet: red means plan the
          // stop (and everything before it) again
          done[k] = 1;
          if (waitAt(k, t) > 0.4) { dwell[k] = -1; ask = k; }
        } else if (dwell[k] !== 0) {
          // stood at the line: wait the red out (asked now that they are there)
          if (dwell[k] < 0) dwell[k] = Math.max(0.6, waitAt(k, t) + 0.3);
          t += dwell[k];
          T.push(t); TS.push(s); TV.push(0);
        }
      }
    }
    if (ask < 0) break;
  }
  plan.T = Float64Array.from(T); plan.S = Float64Array.from(TS); plan.V = Float64Array.from(TV);
  plan.tEnd = T[T.length - 1];
}

/**
 * Where the plan has the rider at shared second t: writes { arc, v } into out.
 * `hint` is any object the caller keeps per rider ({ k: 0 }): time only runs
 * forward, so the search starts where it last ended.
 */
export function planAt(plan, t, hint, out) {
  const T = plan.T, n = T.length;
  if (t <= T[0]) { out.arc = 0; out.v = plan.V[0]; return out; }
  if (t >= T[n - 1]) { out.arc = plan.S[n - 1]; out.v = 0; return out; }
  let k = hint.k | 0;
  if (k > n - 2 || T[k] > t) k = 0;
  while (k < n - 2 && T[k + 1] <= t) k++;
  hint.k = k;
  const dt = T[k + 1] - T[k], tau = t - T[k];
  if (!(dt > 1e-9)) { out.arc = plan.S[k]; out.v = plan.V[k]; return out; }
  const a = (plan.V[k + 1] - plan.V[k]) / dt;
  out.arc = plan.S[k] + plan.V[k] * tau + 0.5 * a * tau * tau;
  out.v = plan.V[k] + a * tau;
  return out;
}
