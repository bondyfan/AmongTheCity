// ---- stores/schedule.js: who is where in a shop, as a function of the clock ----
// Pure numbers. A shopper is not simulated: where slot 4 of this store is at
// second 81 234 of the shared clock is worked out from the store's key, the
// slot and the clock alone, so every player in a co-op session sees the same
// woman at the same shelf without a byte on the wire, and a store that was out
// of sight for ten minutes is where it would have been.
//
// A slot lives in cycles of PERIOD seconds. Each cycle is one visit: a plan of
// nodes in the room's own axes (`a` in from the front wall, `b` along it), with
// the second the body arrives at each and the second it leaves. Between two
// nodes it walks the straight line; the plans only ever join points along the
// room's free corridors (the cross aisles, the lanes between the rows).

import { hashK } from './site.js';

/** Seconds one visit's cycle lasts: longer in a hall that takes minutes to cross. */
export function periodOf(layout) {
  if (layout.kind === 'fast') return 230;
  return Math.max(260, Math.min(640, Math.round(190 + (layout.room.W + layout.room.D) * 1.7)));
}

/** How busy a shop is at an hour of the day, 0..1: quiet mornings, the rush after work. */
export function busyAt(hour) {
  const pts = [[6, 0.15], [8, 0.4], [10, 0.55], [12, 0.6], [14, 0.5], [16, 0.8], [17.5, 1], [19, 0.7], [20.5, 0.3], [22, 0.12], [24, 0.08], [30, 0.15]];
  const h = hour < 6 ? hour + 24 : hour;
  for (let i = 0; i + 1 < pts.length; i++) if (h >= pts[i][0] && h <= pts[i + 1][0]) {
    const t = (h - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
    return pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
  }
  return 0.15;
}
/** How many of a store's `n` tills have a cashier at this hour (never none). */
export const tillsOpen = (n, hour) => (n ? Math.max(1, Math.min(n, Math.round(n * (0.25 + 0.75 * busyAt(hour))))) : 0);

/** How many shopper slots a store has, and how many of them are out at this hour. */
export function slotCount(layout) {
  const { W, D } = layout.room;
  return layout.kind === 'fast' ? Math.max(2, Math.min(7, Math.floor(layout.seats.length / 3)))
    : Math.max(3, Math.min(12, Math.round(W * D / 170)));
}
export const slotsOut = (layout, hour) => Math.max(1, Math.round(slotCount(layout) * (0.2 + 0.8 * busyAt(hour))));

function timed(nodes, speed) {
  let t = 0;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (i) t += Math.hypot(n.a - nodes[i - 1].a, n.b - nodes[i - 1].b) / speed;
    n.t0 = t; t += n.dwell ?? 0; n.t1 = t;
  }
  return t;
}

/** One visit to a supermarket. */
export function marketPlan(layout, slot, cycle) {
  const H = (s) => hashK(layout.key, slot * 131 + cycle * 7919 + s);
  // a visit has to fit its cycle: in a hall a hundred metres wide, fewer stops
  let plan = null;
  for (let stops = 2 + Math.floor(H(2) * 3); stops >= 1; stops--) {
    plan = marketVisit(layout, slot, H, stops);
    if (plan.dur <= periodOf(layout) - 4) break;
  }
  return plan;
}

function marketVisit(layout, slot, H, stops) {
  const lc = layout.lane.c, nodes = [];
  const go = (a, b, dwell = 0, act = 'walk', face = 0) => nodes.push({ a, b, dwell, act, face });
  const trolley = H(3) < 0.55;
  // the aisles within a short walk of the way in (nobody crosses a hypermarket for one yoghurt)
  const lanes = layout.lanes.filter((b) => Math.abs(b - lc) >= 3.6 && Math.abs(b - lc) <= 30);
  go(-5, lc + (H(1) - 0.5) * 3);
  go(0.5, lc); go(layout.aTill1 + 0.4, lc); go(layout.crossA, lc);
  let ca = layout.crossA, cb = lc;
  for (let s = 0; s < stops; s++) {
    let a, b, face;
    if (!lanes.length || H(30 + s) < 0.22) {
      // fruit and vegetables, straight on from the way in
      b = lc; a = layout.aAisle0 + 1 + H(20 + s) * 5; face = H(40 + s) < 0.5 ? 1 : -1;
    } else {
      b = lanes[Math.floor(H(10 + s) * lanes.length) % lanes.length];
      a = layout.aAisle0 + 1.2 + H(20 + s) * Math.max(1, layout.backA - layout.aAisle0 - 3);
      face = H(40 + s) < 0.5 ? 1 : -1;
    }
    if (Math.abs(cb - b) > 0.01) {
      const viaF = Math.abs(ca - layout.crossA) + Math.abs(a - layout.crossA), viaB = Math.abs(ca - layout.backA) + Math.abs(a - layout.backA);
      const via = viaF <= viaB ? layout.crossA : layout.backA;
      go(via, cb); go(via, b);
    }
    go(a, b, 4 + H(50 + s) * 5, 'look', face);
    ca = a; cb = b;
  }
  // the open tills nearest the way in
  const open = tillsOpen(layout.tills.length, 12);
  const byLane = layout.tills.slice(0, Math.max(1, open)).sort((p, q) => Math.abs(p.lane - lc) - Math.abs(q.lane - lc));
  const till = byLane.length ? byLane[slot % Math.min(byLane.length, 3)] : null;
  go(layout.crossA, cb);
  if (till) {
    go(layout.crossA, till.lane);
    go(till.a - 0.7, till.lane, 9 + H(60) * 7, 'pay', -1);
    go(2.0, till.lane);
  }
  go(2.0, lc); go(0.5, lc); go(-5, lc + (H(4) - 0.5) * 3);
  const dur = timed(nodes, trolley ? 0.95 : 1.2);
  return { nodes, dur, trolley, till: till?.i ?? -1, speed: trolley ? 0.95 : 1.2 };
}

/** Which seats the regulars take: slot i always sits on the same chair. */
export function seatOfSlot(layout, slot) {
  const n = layout.seats.length;
  return n ? layout.seats[(Math.floor(hashK(layout.key, 900) * n) + slot * 3) % n] : null;
}

/** One visit to a restaurant: kiosk, wait, tray, table, out. */
export function fastPlan(layout, slot, cycle) {
  const H = (s) => hashK(layout.key, slot * 131 + cycle * 7919 + s + 5000);
  const lc = layout.lane.c, nodes = [];
  const go = (a, b, dwell = 0, act = 'walk', face = 0) => nodes.push({ a, b, dwell, act, face });
  const kiosks = layout.points.filter((p) => p.kind === 'kiosk' && p.a < layout.aK);
  const seat = seatOfSlot(layout, slot);
  const ct = layout.counter[slot % layout.counter.length];
  go(-5, lc + (H(1) - 0.5) * 3); go(0.5, lc);
  if (kiosks.length) {
    const k = kiosks[Math.floor(H(2) * kiosks.length) % kiosks.length];
    go(k.a, lc); go(k.a, k.b, 9 + H(3) * 7, 'kiosk', 1); go(k.a, lc);
  }
  go(layout.aC - 2.1, lc);
  go(layout.aC - 2.1, ct.b + (H(4) - 0.5) * 1.4, 10 + H(5) * 12, 'wait', 1);
  go(ct.a, ct.b, 3.5, 'pay', 1);
  go(layout.aC - 2.1, lc);
  if (seat) {
    // the aisle beside the seat's row of chairs, then along it to the chair
    const aisle = seat.a - seat.face * 0.46;
    go(aisle, lc); go(aisle, seat.b);
    go(seat.a, seat.b, 45 + H(6) * 60, 'sit', seat.face);
    go(aisle, seat.b); go(aisle, lc);
  }
  go(0.5, lc); go(-5, lc + (H(7) - 0.5) * 3);
  const dur = timed(nodes, 1.15);
  return { nodes, dur, trolley: false, seat: seat?.i ?? -1, speed: 1.15 };
}

const _out = { present: false, a: 0, b: 0, da: 0, db: 0, moving: false, act: 'walk', face: 0, k: 0, node: null };
/**
 * Where a plan's body is `u` seconds into its visit. Writes into (and returns)
 * a shared record: { present, a, b, da, db (unit direction of travel), moving,
 * act, face, k (0..1 through the dwell), node }.
 */
export function at(plan, u, out = _out) {
  out.present = u >= 0 && u < plan.dur;
  if (!out.present) return out;
  const N = plan.nodes;
  let i = 0;
  while (i + 1 < N.length && N[i + 1].t0 <= u) i++;
  const n = N[i];
  if (u < n.t1 || i + 1 >= N.length) {
    out.a = n.a; out.b = n.b; out.moving = false; out.act = n.act; out.face = n.face; out.node = n;
    out.k = n.t1 > n.t0 ? (u - n.t0) / (n.t1 - n.t0) : 0;
    out.da = 0; out.db = 0;
    return out;
  }
  const m = N[i + 1], t = (u - n.t1) / Math.max(1e-6, m.t0 - n.t1);
  const L = Math.hypot(m.a - n.a, m.b - n.b) || 1;
  out.a = n.a + (m.a - n.a) * t; out.b = n.b + (m.b - n.b) * t;
  out.da = (m.a - n.a) / L; out.db = (m.b - n.b) / L;
  out.moving = true; out.act = 'walk'; out.face = 0; out.k = 0; out.node = m;
  return out;
}

/**
 * The visit slot `slot` is on at shared second `now`: { cycle, u } (u seconds in).
 * Slots are spread over the period so a shop never fills and empties in a wave.
 */
export function visit(layout, slot, now) {
  const P = periodOf(layout);
  const t = now + hashK(layout.key, 700 + slot) * P + slot * P / 7.3;
  const cycle = Math.floor(t / P);
  return { cycle, u: t - cycle * P };
}
