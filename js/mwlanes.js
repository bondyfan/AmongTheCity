// ---- mwlanes.js: keep right, overtake, merge, exit (round 8, the D11) ----
// Until round 8 every AI car drove ONE line 2.1 m right of a carriageway's
// centreline: no lanes, no overtaking, nobody ever pulling out round a lorry.
// This module gives the motorway schedules of js/traffic.js a lane each and
// the rules a Czech driver keeps on the D11:
//   · lorries and coaches keep to the right lane, always;
//   · a car pulls out when a slower vehicle is ahead in the right lane and
//     the left lane is clear, and back in once it is past and the right lane
//     is clear; the indicator goes on LEAD s before it moves, the move takes
//     LC_T s on a cosine, and the indicator stays on through it;
//   · out of a slip road a car runs in the acceleration lane, and takes the
//     right lane where there is a gap (by the end of it in any case); a car
//     in the right lane beside the merge moves over if it can (courtesy, by
//     hash), the mainline never stands for a ramp;
//   · a car leaving moves right from EXIT_PREP m before its diverge, into
//     the deceleration lane for the last DEC_RUN m, and brakes on the slip.
//
// SHARED, which is the whole difficulty. Every decision is taken once per
// whole second of SHARED time (the tick), for every motorway schedule in the
// pool, from the NOMINAL state at that second: the schedules' arcs and
// desires (a forward recurrence every client runs to the same numbers) and
// the lanes the tick before decided. So two clients holding the same
// schedules decide the same lanes; the lateral position at any time T is a
// function of (lane, the lane it came from, the second it was decided, T).
// A late joiner, or a schedule one client minted later than the other,
// starts in the right lane and is decided afresh at the next tick: the
// disagreement is a few seconds of one lane change, never accumulated.
//
// THE BODY'S LANE (bodyLane below) is the one local layer, and it exists for
// the same reason the lag does. Schedules pass through one another; bodies
// cannot. A car held behind a slower lorry by the follow model falls behind
// its own schedule, whose nominal may already be past the lorry's, so the
// shared decision never sees a reason to pull out, and the car stood in the
// right lane behind it (16 % of the cars in the bench). So every car with a
// body carries a second, LOCAL lane state that follows the shared one
// exactly (same lane, same second) whenever the road beside it is clear, and
// otherwise (a) waits to move until the bodies leave it room, (b) pulls out
// round a slower body it is stuck behind, and comes back in once past. Like
// the lag, that is a reaction to what this client's bodies are doing; the
// shared tick never reads it.
//
// Lane indices: 0 the overtaking (left) lane, 1 the right lane, 2 the
// auxiliary lane right of it (acceleration / deceleration lane; on a piece
// the tiles draw as two lanes, the hard shoulder's band, which is where the
// look package paints it). Offsets come from js/lanes.js laneLayout, the same
// records the road markings are painted from.

import { laneLayout, ACC_LEN, TAPER } from './lanes.js';
import { CL_HEAVY, leftClosed } from './mwtraffic.js';

export const LEAD = 2;            // s of indicator before a car moves over
export const LC_T = 3.5;          // s the move itself takes
export const BLINK_T = LEAD + LC_T;
export const DV_PASS = 5 / 3.6;   // m/s slower than me before a vehicle is worth passing
const PASS_K = 8;                 // s of closing that start a pass: FRONT = 25 + 8 dv
const FRONT_MAX = 170;            // m, the furthest ahead a pass is planned from
const BACK_GAP = 15, BACK_K = 6;  // m + s x dv a car coming up behind must be away
const FWD_GAP = 10, FWD_K = 6;    // m + s x dv of room ahead in the lane moved into
const PASSED = 22;                // m past a vehicle before pulling back in in front of it
const EXIT_PREP = 650;            // m before its diverge a leaving car stays right
const DEC_RUN = 230;              // m before its diverge it takes the deceleration lane
const MERGE_FROM = 40;            // m after the merge node before an acc-lane car looks for its gap
const MERGE_BY = ACC_LEN - TAPER - 40;   // m: in the right lane by the taper, gap or not
const COURTESY = 0.6;             // share of right-lane drivers who move over for a merge
const LINK_NEAR = 180, LINK_FADE = 110;            // m of slip road from its node over which a car keeps the carriageway's lane
const SALT_COURT = 0x6c6e;

// lane centre of lane L on a layout (the auxiliary lane is the third lane
// where the piece has one, else the middle of the hard shoulder band)
export function laneCentre(lay, L) {
  if (!lay) return 0;
  if (L < lay.n) return lay.centers[L];
  if (lay.n >= 2 && lay.shoulder) return (lay.shoulder.from + lay.shoulder.to) / 2;
  return lay.centers[lay.n - 1];
}
const smooth = (u) => (u <= 0 ? 0 : u >= 1 ? 1 : (1 - Math.cos(Math.PI * u)) / 2);

/** 0..1, how far the lane change decided at lnT has got by T. */
export function moveShare(lnT, T) { return smooth((T - lnT - LEAD) / LC_T); }

/**
 * The lateral offset (m right of the centreline) a schedule's car steers for
 * at shared time T on route step `i` (the edge its body is on), at `s` m along
 * that edge. Carriageways: its lane. Slip roads: eased out of / into the lane
 * of the carriageway they leave / join, so the car never jumps sideways at
 * the node where the slip's line meets the carriageway's.
 */
export function laneOffset(p, i, s, T) {
  const st = p.route[i], e = st.e;
  if (e.mw === 1) {
    const lay = laneLayout(e.road);
    const a = laneCentre(lay, p.eF), b = laneCentre(lay, p.eL);
    return a + (b - a) * moveShare(p.eT, T);
  }
  // A slip road. Its OSM line ends (or starts) ON the carriageway's
  // centreline, at the node the graph welds them at, so a car on the slip's
  // own line would arrive between the two running lanes. Near that node the
  // car keeps to the lane it is joining (the acceleration lane) or leaving
  // (the lane it left in), measured from the CARRIAGEWAY's line: `sep` is how
  // far right of the carriageway's line (extended through the node) the
  // slip's line is at this point, and the car sits `lane - sep` right of the
  // slip's line, never left of the slip's own right lane. Where the slip has
  // diverged by more than the lane, that is the slip's lane and nothing else.
  const ll = laneLayout(e.road), base = ll ? ll.centers[ll.n - 1] : 0;
  const nx = p.route[i + 1]?.e, pv = i > 0 ? p.route[i - 1].e : null;
  // (faded in over the far part of that stretch: where the slip's line runs
  // close beside the carriageway for long, the shift starts gently)
  if (nx && nx.mw === 1 && e.len - s < LINK_NEAR) {
    ptAt(e, s);
    const sep = (_px - e.b.x) * -nx.fdz + (_pz - e.b.z) * nx.fdx;
    const c = laneCentre(laneLayout(nx.road), 2), o = c - (sep > 0 ? sep : 0);
    return o > base ? base + (o - base) * smooth((LINK_NEAR - (e.len - s)) / LINK_FADE) : base;
  }
  if (pv && pv.mw === 1 && s < LINK_NEAR) {
    ptAt(e, s);
    const sep = (_px - e.a.x) * -pv.ldz + (_pz - e.a.z) * pv.ldx;
    const c = laneCentre(laneLayout(pv.road), p.eL), o = c - (sep > 0 ? sep : 0);
    return o > base ? base + (o - base) * smooth((LINK_NEAR - s) / LINK_FADE) : base;
  }
  return base;
}
// the point s m along edge e, into _px/_pz
let _px = 0, _pz = 0;
function ptAt(e, s) {
  const P = e.pts, cum = e.cum;
  let k = 0;
  while (k < P.length - 2 && cum[k + 1] < s) k++;
  const L = (cum[k + 1] - cum[k]) || 1e-6, u = (s - cum[k]) / L;
  _px = P[k][0] + (P[k + 1][0] - P[k][0]) * u;
  _pz = P[k][1] + (P[k + 1][1] - P[k][1]) * u;
}

/** The indicator a schedule's car shows at T: -1 left, +1 right, 0 none. */
export function blinkOf(p, T) {
  return T >= p.eT && T < p.eT + BLINK_T ? p.eD : 0;
}

// ---- the body's lane (local) ------------------------------------------------
const BODY_LANE = 1.7;            // m off a lane centre that still counts as in it
const STUCK_T = 1.5;              // s held behind a slower body before pulling out round it
const AHEAD_SLOW = 45;            // m: a slower body this far ahead in a lane is a reason not to enter it
const ZIP_GAP = 3, ZIP_K = 1;     // m + s x dv clear ahead and behind, merging out of a closed lane
const ZIP_DROP = 3;               // m/s under the body beside that a car waiting to zip drops back at

/** Take over the shared lane as the body's (at attach, and on a carriageway reached without one). */
export function bodyAdopt(p) { p.eL = p.ln; p.eF = p.lnF; p.eT = p.lnT; p.eD = p.lnD; p.eHeld = 0; }

// Is lane L beside the body clear: nobody in it within the gaps the shared
// rule keeps, measured between the bodies. `cars` the meshed fleet. `zip`:
// out of a lane closed for roadworks, the zipper's gaps (a queue at 60 km/h
// never opens the 30 m a free-flow lane change wants), and the speed of the
// body that blocks it is left in _blockV (Infinity: none). Ahead, level or
// just behind alike: a lorry whose nose sits level with the car's tail at the
// same 60 km/h blocks the gap for good unless one of the two gives way, and
// the one in the closed lane is the one that does.
let _blockV = Infinity;
function bodyClear(p, car, cars, lay, L, zip) {
  const fx = -Math.sin(p.sh), fz = -Math.cos(p.sh), c = laneCentre(lay, L);
  const hl = (car.len ?? 4.6) / 2, v = car.speed;
  const bg = zip ? ZIP_GAP : BACK_GAP, bk = zip ? ZIP_K : BACK_K, fg = zip ? ZIP_GAP : FWD_GAP, fk = zip ? ZIP_K : FWD_K;
  _blockV = Infinity;
  for (const q of cars) {
    const o = q.ai;
    if (!o || o === p || !o.edge?.mw) continue;
    const rx = o.sx - p.sx, rz = o.sz - p.sz;
    const f = rx * fx + rz * fz;
    if (f < -140 || f > 90) continue;
    if (fx * -Math.sin(o.sh) + fz * -Math.cos(o.sh) < 0.9) continue;
    const off = p.laneOff + (fx * rz - fz * rx);
    if (off - c > BODY_LANE || c - off > BODY_LANE) continue;
    const ends = hl + (q.len ?? 4.6) / 2, dv = q.speed - v;
    if (f <= 0 ? -f < ends + bg + bk * (dv > 0 ? dv : 0)
      : f < ends + fg + fk * (dv < 0 ? -dv : 0)) { _blockV = q.speed; return false; }
  }
  return true;
}
// a body slower than this driver wants, ahead in lane L
function bodySlowAhead(p, car, cars, lay, L, want) {
  const fx = -Math.sin(p.sh), fz = -Math.cos(p.sh), c = laneCentre(lay, L);
  for (const q of cars) {
    const o = q.ai;
    if (!o || o === p || !o.edge?.mw) continue;
    const rx = o.sx - p.sx, rz = o.sz - p.sz;
    const f = rx * fx + rz * fz;
    if (f < -((car.len ?? 4.6) + (q.len ?? 4.6)) / 2 - 12 || f > AHEAD_SLOW + (q.len ?? 4.6)) continue;
    if (fx * -Math.sin(o.sh) + fz * -Math.cos(o.sh) < 0.9) continue;
    const off = p.laneOff + (fx * rz - fz * rx);
    if (off - c > BODY_LANE || c - off > BODY_LANE) continue;
    if (q.speed < want - DV_PASS) return true;
  }
  return false;
}
function start(p, L, t) { p.eF = p.eL; p.eD = L < p.eL ? -1 : 1; p.eL = L; p.eT = t; p.eHeld = 0; }

/**
 * One step of the body's lane, for a car on a carriageway at shared time T.
 * `leader` the schedule the follow model is held by (or null), `desire` this
 * driver's m/s. Returns a speed cap (m/s) or Infinity: a car in the
 * acceleration lane waiting for its gap does not run past the car it is to
 * merge behind.
 */
export function bodyLane(p, car, cars, T, dt, leader, desire) {
  const e = p.edge, lay = laneLayout(e.road);
  if (!lay || lay.n < 2 || T < p.eT + BLINK_T) return Infinity;
  const want = p.ghost ? (p.eL === 2 && !p._acc ? 2 : 1) : p.ln;
  let cap = Infinity;
  if (want !== p.eL) {
    // (the bodies beside it are looked at four times a second, not at every
    // step: a scan of the fleet per car per step was most of the step's cost;
    // the moment the shared decision lands is always looked at)
    if (T < p.eChk && !(T >= p.lnT && T - p.lnT < 0.06)) return p.eCap;
    p.eChk = T + 0.25;
    const L = want < p.eL ? p.eL - 1 : p.eL + 1;
    // Out of a lane closed for roadworks (round 8 fix): the zipper. A queue
    // in the open lane never leaves the gap a free-flow change wants, so the
    // car in the closed lane takes a zipper's gap, and while there is none it
    // drops back beside the body that blocks it until one comes past: it
    // never runs on down the closed lane beside the queue.
    const zip = p.eL === 0 && L === 1 && leftClosed(e, p.s, T) !== 0;
    // in step with the shared decision when the road allows it (peers then
    // see the same move in the same second); later, where it does not
    const ok = bodyClear(p, car, cars, lay, L, zip) && (zip || L < p.eL || !bodySlowAhead(p, car, cars, lay, L, desire));
    // (an acceleration lane runs out: in at its end whatever the bodies say)
    const force = p.eL === 2 && p._acc === 0 && !p.ghost && want === 1 && T > p.lnT + 4;
    if (ok || force) start(p, L, T - p.lnT < 0.5 && T >= p.lnT ? p.lnT : T);
    else if (zip) {
      if (_blockV < Infinity) cap = _blockV - ZIP_DROP > 0 ? _blockV - ZIP_DROP : 0;
    } else if (p.eL === 2) {
      // waiting for the gap: no faster than the car beside
      const lv = leader ? leader.car?.speed ?? 0 : Infinity;
      cap = lv + 1 < desire ? lv + 1 : desire;
    }
    p.eCap = cap;
    return cap;
  }
  p.eCap = Infinity;
  // stuck behind a slower body in the right lane: round it, locally (never
  // into a left lane closed for roadworks, here or just ahead: that was the
  // one way a body got into the closed lane, and in the queue it could not
  // get back out)
  if (p.eL === 1 && p.mwc < CL_HEAVY && leader && leader.car && leader.car.speed < desire - DV_PASS && car.speed < desire - 1) {
    p.eHeld += dt;
    if (p.eHeld > STUCK_T && T >= p.eChk) {
      p.eChk = T + 0.25;
      if (!leftClosed(e, p.s, T) && bodyClear(p, car, cars, lay, 0, false)) start(p, 0, T);
    }
  } else p.eHeld = 0;
  return cap;
}

// ---- the tick ----------------------------------------------------------------
// Index of the motorway schedules by the carriageway edge their nominal is on
// at the tick (arrays kept on the edges, reused), then one decision each from
// the previous tick's lanes, then all committed together: the order the pool
// is walked in changes nothing.
const _on = [];                   // schedules indexed this tick
let _tick = -1;

function occupies(q, L) { return q.ln === L || (q.lnF === L && q._mid); }

// Walk the vehicles on p's carriageway between `lo` and `hi` metres of p
// (route ahead, the inbound carriageway behind), calling fn(q, d).
function around(p, lo, hi, fn) {
  const st = p.route[p.ni], e = st.e, s = p._ls;
  scan(e, -s, p, lo, hi, fn);
  // ahead along the route, as long as it stays on carriageways
  let D = e.len - s;
  for (let i = p.ni + 1; i < p.route.length && D < hi; i++) {
    const f = p.route[i].e;
    if (f.mw !== 1) break;
    scan(f, D, p, lo, hi, fn);
    D += f.len;
  }
  // behind: up to two carriageway edges into this one's start node
  if (lo < -s) {
    for (const b of e.a.inn) {
      if (b.mw !== 1) continue;
      const D1 = -s - b.len;
      scan(b, D1, p, lo, hi, fn);
      if (lo < D1) for (const c of b.a.inn) if (c.mw === 1) scan(c, D1 - c.len, p, lo, hi, fn);
    }
  }
}
function scan(e, D, p, lo, hi, fn) {
  if (e._lqT !== _tick) return;
  const a = e._lq;
  for (let k = 0; k < a.length; k++) {
    const q = a[k];
    if (q === p) continue;
    const d = D + q._ls;
    if (d >= lo && d <= hi) fn(q, d);
  }
}

// is lane L free for p to move into: nobody faster close behind, nobody
// slower close ahead, nobody level
let _clr = true, _L = 0, _v = 0;
function clearFn(q, d) {
  if (!_clr || !occupies(q, _L)) return;
  const dv = q._lv - _v;
  if (d <= 0 ? -d < BACK_GAP + (q._len ?? 5) + BACK_K * (dv > 0 ? dv : 0)
    : d < FWD_GAP + (q._len ?? 5) + FWD_K * (dv < 0 ? -dv : 0)) _clr = false;
}
function laneClear(p, L) {
  _clr = true; _L = L; _v = p._lv;
  around(p, -120, 80, clearFn);
  return _clr;
}
// a slower vehicle in the right lane (or the aux lane) ahead, worth passing
let _slow = false;
function slowFn(q, d) {
  if (_slow || q.ln === 0 || q._mid && q.lnF === 0) return;
  const dv = _v - q._lv;
  if (dv < DV_PASS) return;
  const front = 25 + PASS_K * dv;
  if (d > -(PASSED + (q._len ?? 5)) && d < (front < FRONT_MAX ? front : FRONT_MAX)) _slow = true;
}
function slowerAhead(p) {
  _slow = false; _v = p._lv;
  around(p, -40, FRONT_MAX, slowFn);
  return _slow;
}
let _yield = false, _to = 0, _from = 0;
function yieldFn(q, d) { if (!_yield && d > 0 && q.ln === _from && q._lnN === _to) _yield = true; }
// courtesy: a car merging from the acceleration lane beside me
let _mrg = false;
function mergeFn(q, d) { if (!_mrg && q.ln === 2 && q._acc && d > -25 && d < 45) _mrg = true; }

/**
 * One tick of lane decisions at shared second T, over every schedule of the
 * traffic pool `pool` (a Map, read only) whose nominal is on a carriageway.
 * `nomTo(p, T)` advances a schedule; `arcOf(p, T)` its route arc;
 * `ensure(p, want)` grows its route; `hash(a, b, c)` and `rnd01` are
 * traffic.js's own (the only randomness a shared world may use).
 */
export function laneTick(pool, T, nomTo, arcOf, ensure, hash, rnd01) {
  _tick = T;
  _on.length = 0;
  for (const p of pool.values()) {
    if (p.ndone || p.stolen || p.fixed || !p.route) continue;
    nomTo(p, T);
    if (p.ndone) continue;
    const st = p.route[p.ni], e = st.e;
    if (e.mw !== 1) { p._carr = 0; continue; }
    p._ls = arcOf(p, T) - st.base;
    p._lv = p.vMax;
    p._len = p.mwc >= CL_HEAVY ? (p.kind === 'semi' ? 16.5 : 8) : 5;
    p._mid = T < p.lnT + BLINK_T;
    // first tick on a carriageway: in the acceleration lane out of a slip road
    if (!p._carr) {
      p._carr = 1;
      const pv = p.ni > 0 ? p.route[p.ni - 1].e : null;
      if (pv && pv.mw === 2) { p.ln = p.lnF = 2; p.lnT = -1e9; p.lnD = 0; p._acc = 1; p._accA = st.base; }
      else if (p.ln === 2) { p.ln = p.lnF = 1; p._acc = 0; }
    }
    if (e._lqT !== T) { e._lqT = T; (e._lq ??= []).length = 0; }
    e._lq.push(p);
    _on.push(p);
  }
  for (let k = 0; k < _on.length; k++) decide(_on[k], T, ensure, hash, rnd01);
  // two cars of one lane both pulling out in the same second, the one behind
  // a few lengths behind the other: the front one goes, the one behind waits
  // a tick (decided from the same old lanes, both would end up nose to tail)
  for (let k = 0; k < _on.length; k++) {
    const p = _on[k];
    if (p._lnN === p.ln) continue;
    _yield = false; _to = p._lnN; _from = p.ln;
    around(p, 0, 60, yieldFn);
    if (_yield) p._lnK = 1;
  }
  for (let k = 0; k < _on.length; k++) {
    const p = _on[k];
    if (p._lnK) { p._lnK = 0; p._lnN = p.ln; }
  }
  for (let k = 0; k < _on.length; k++) {
    const p = _on[k];
    if (p._lnN === p.ln) continue;
    p.lnF = p.ln; p.lnD = p._lnN < p.ln ? -1 : 1; p.ln = p._lnN; p.lnT = T;
    if (p.lnF === 2) p._acc = 0;
  }
  _on.length = 0;
}

function decide(p, T, ensure, hash, rnd01) {
  p._lnN = p.ln;
  if (p._mid) return;
  const e = p.route[p.ni].e, lay = laneLayout(e.road);
  if (!lay || lay.n < 2) return;           // one lane (the D0 knot): nowhere to go
  // where does this trip leave the carriageway? (the route is laid that far
  // ahead now, a few hundred metres sooner than the schedule needs it)
  let exitD = Infinity, D = e.len - p._ls;
  for (let i = p.ni + 1; D < EXIT_PREP + 50; i++) {
    if (i >= p.route.length) { ensure(p, i); if (i >= p.route.length) break; }
    const f = p.route[i].e;
    if (f.mw === 2) { exitD = D; break; }
    if (f.mw !== 1) break;
    D += f.len;
  }
  const heavy = p.mwc >= CL_HEAVY;
  // roadworks: the left lane closed ahead or here: in, gap or (inside) not
  const closed = p.ln === 2 ? 0 : leftClosed(e, p._ls, T);
  if (closed) {
    if (p.ln === 0 && (closed === 2 || laneClear(p, 1))) p._lnN = 1;
    // (a car leaving at an exit inside the closure still takes its
    // deceleration lane: the closure now starts up to CLOSE_AHEAD km early)
    else if (p.ln === 1 && exitD < DEC_RUN && laneClear(p, 2)) p._lnN = 2;
    return;
  }
  if (p.ln === 2) {
    if (p._acc) {
      // the acceleration lane: take the gap, or the lane at the taper anyway
      const sM = p._ls + p.route[p.ni].base - p._accA;
      if (sM > MERGE_BY || (sM > MERGE_FROM && laneClear(p, 1))) p._lnN = 1;
    } else if (exitD > DEC_RUN + 60) p._lnN = 1;   // (a deceleration lane it no longer needs)
    return;
  }
  if (exitD < EXIT_PREP) {
    if (p.ln === 0) { if (laneClear(p, 1)) p._lnN = 1; return; }
    if (exitD < DEC_RUN && laneClear(p, 2)) p._lnN = 2;
    return;
  }
  if (p.ln === 1) {
    if (heavy) return;
    if (slowerAhead(p) && laneClear(p, 0)) { p._lnN = 0; return; }
    // a car coming out of the acceleration lane beside me: over, if I can
    _mrg = false;
    around(p, -30, 30, mergeFn);
    if (_mrg && rnd01(hash(p.seed, SALT_COURT, T | 0)) < COURTESY && laneClear(p, 0)) p._lnN = 0;
    return;
  }
  // the left lane: back in once past, and the right lane is clear
  if ((heavy || !slowerAhead(p)) && laneClear(p, 1)) p._lnN = 1;
}
