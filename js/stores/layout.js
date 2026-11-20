// ---- stores/layout.js: what stands where inside a store ----
// Pure numbers, no three.js: the fixtures the runtime draws, the points the
// player can use, and the lanes the shoppers walk, all from the store's site
// (js/stores/site.js). The same call on any machine gives the same shop.
//
// The room is the largest rectangle inside the footprint (shopRect). In it:
//   a   metres in from the front wall (the wall the doors are in)
//   b   metres along the front, from the left end seen from the car park
// A Czech supermarket, walked from the door: the entry lane beside the tills,
// fruit, vegetables and the bakery first, then the gondola aisles running away
// from the front, chilled goods along the back wall, frozen chests in one
// aisle, and back along the front through the tills to the same door.

import { shopRect, hashK } from './site.js';

/** The departments, in the order the aisles are given them. */
export const AISLE_CATS = ['dry', 'drinks', 'sweets', 'dairy', 'snacks', 'frozen', 'meat', 'beer', 'drug', 'home'];

const TILL_PITCH = 2.5, LANE_W = 3.4, ROW_PITCH = 3.3, MODULE = 1.3;
const A_TILL0 = 2.9, A_TILL1 = 6.7, A_AISLE0 = 9.5;

/** The room and its two axes: (a, b) to the world and back. */
export function roomOf(site) {
  const r = shopRect(site, 0.45);
  const W = r.u1 - r.u0, D = r.v1 - r.v0;
  const at = (a, b) => site.world(r.u0 + b, r.v1 - a);
  const from = (x, z) => { const [u, v] = site.local(x, z); return [r.v1 - v, u - r.u0]; };
  // the door, pulled onto the room's front edge
  const [du] = site.local(site.door.x, site.door.z);
  const bd = Math.max(1.9, Math.min(W - 1.9, du - r.u0));
  // which way +a and +b point in the world (unit), for turning things
  const ax = -site.nx, az = -site.nz, bx = site.ux, bz = site.uz;
  return { r, W, D, at, from, bd, ax, az, bx, bz };
}

/**
 * marketLayout(site) -> {
 *   room, fixtures[], points[], lanes[], tills[], selfs[], lane: { b0, b1 },
 *   crossA, backA }
 * fixture: { t, a, b, along ('a'|'b'), len, cat?, face? } centre at (a, b)
 * point:   { kind, a, b, x, z, cat?, i? } something E does something at
 */
export function marketLayout(site) {
  const room = roomOf(site), { W, D, bd } = room, chain = site.chain, S = chain.shop ?? {};
  const fixtures = [], points = [];
  const fx = (t, a, b, along, len, o) => { const f = { t, a, b, along, len, ...o }; fixtures.push(f); return f; };
  const pt = (kind, a, b, o) => { const [x, z] = room.at(a, b); const p = { kind, a, b, x, z, ...o }; points.push(p); return p; };

  // ---- the entry lane: from the door straight in, tills either side of it ----
  let l0 = bd - LANE_W / 2, l1 = bd + LANE_W / 2;
  if (l0 < 1.4) { l0 = 0.5; l1 = l0 + LANE_W; }
  if (l1 > W - 1.4) { l1 = W - 0.5; l0 = l1 - LANE_W; }
  const lc0 = (l0 + l1) / 2;
  const deep = D > 17;                       // room for a cross aisle and real aisles
  const aTill1 = deep ? A_TILL1 : Math.min(A_TILL1, D * 0.34);
  const aAisle0 = deep ? A_AISLE0 : aTill1 + 2.2;
  const backA = D - 2.3;                     // the walk along the back wall
  const crossA = (aTill1 + aAisle0) / 2;     // ...and the one behind the tills

  // ---- tills: belts running in from the cross aisle toward the front ----
  const tills = [], selfs = [];
  const spans = [[0.9, l0 - 0.5], [l1 + 0.5, W - 0.9]].filter(([p, q]) => q - p >= TILL_PITCH);
  const wantSelf = Math.min(S.self ?? 0, 8), wantTills = S.tills ?? 4;
  // the self-checkouts take the span end nearest the lane, two rows facing each other
  let selfSpan = null;
  if (wantSelf > 0 && spans.length) {
    const sp = spans.reduce((m, s) => (s[1] - s[0] > m[1] - m[0] ? s : m));
    const wSelf = Math.min(4.6, (sp[1] - sp[0]) * 0.45);
    if (wSelf >= 3.2) {
      const nearLane = Math.abs(sp[0] - l1) < Math.abs(sp[1] - l0);
      selfSpan = nearLane ? [sp[0], sp[0] + wSelf] : [sp[1] - wSelf, sp[1]];
      if (nearLane) sp[0] += wSelf + 0.7; else sp[1] -= wSelf + 0.7;
      const n = Math.max(2, Math.min(wantSelf, 2 * Math.floor((aTill1 - A_TILL0) / 1.25)));
      for (let i = 0; i < n; i++) {
        const side = i % 2, a = A_TILL0 + 0.6 + Math.floor(i / 2) * 1.25;
        const b = side ? selfSpan[1] - 0.35 : selfSpan[0] + 0.35;
        fx('self', a, b, 'b', 0.6, { face: side ? -1 : 1 });
        selfs.push(pt('self', a, b + (side ? -0.75 : 0.75), { i }));
      }
    }
  }
  // every place a till could stand, nearest the way in first: till 1 is the one by the door
  const slots = [];
  for (const [p, q] of spans) {
    const n = Math.floor((q - p) / TILL_PITCH), nearLo = Math.abs(p - l1) < Math.abs(q - l0);
    for (let i = 0; i < n; i++) slots.push(nearLo ? p + (i + 0.5) * TILL_PITCH + 0.2 : q - (i + 0.5) * TILL_PITCH - 0.2);
  }
  // a shop too narrow for the pitch still has ONE till, squeezed in beside the way in
  if (!slots.length && !selfSpan) slots.push(lc0 < W / 2 ? Math.min(W - 1.3, l1 + 1.5) : Math.max(1.3, l0 - 1.5));
  slots.sort((p, q) => Math.abs(p - lc0) - Math.abs(q - lc0));
  for (const b of slots.slice(0, wantTills)) {
    const a = (A_TILL0 + aTill1) / 2;
    fx('till', a, b, 'a', aTill1 - A_TILL0, { i: tills.length });
    // the shopper walks down the belt's side, the cashier sits on the other
    tills.push({ i: tills.length, a, b, lane: b + 0.95, seat: pt('cashier', a - 0.5, b - 0.72, {}),
      pay: pt('till', a - 0.7, b + 0.95, { i: tills.length }), queue: [aTill1 + 0.6, b + 0.95] });
  }
  // ---- baskets and the gate by the door ----
  const bk = l0 > W - l1 ? l0 + 0.45 : l1 - 0.45;
  fx('baskets', 0.85, bk, 'a', 0.5);
  pt('baskets', 0.85, bk + (bk < bd ? 0.7 : -0.7), {});
  fx('gate', aTill1 - 0.2, (l0 + l1) / 2, 'b', LANE_W - 0.6);

  // ---- fresh first: produce islands and the bakery, straight on from the lane ----
  const freshA1 = Math.min(backA - 1.6, aAisle0 + (deep ? 9.5 : 4));
  const nIsl = Math.max(1, Math.floor((freshA1 - aAisle0) / 3.1));
  const lc = (l0 + l1) / 2;
  for (let i = 0; i < nIsl; i++) {
    const a = aAisle0 + 1.3 + i * 3.1;
    for (const off of [-1.35, 1.35]) {
      fx('produce', a, lc + off, 'a', 2.4, { cat: 'produce', v: (i * 2 + (off > 0 ? 1 : 0)) % 6 });
      pt('shelf', a, lc + off * 2.05, { cat: 'produce' });
    }
  }
  // ---- gondola rows, away from the front ----
  const rows = [];
  const bLo = 1.9, bHi = W - 1.9;
  const freshLo = lc - 3.6, freshHi = lc + 3.6;
  let k = 0;
  for (let b = bLo + ROW_PITCH / 2; b <= bHi - ROW_PITCH / 2 + 0.01; b += ROW_PITCH) {
    const inFresh = b > freshLo && b < freshHi;
    const a0 = inFresh ? freshA1 + 2.2 : aAisle0, a1 = backA - 1.2;
    if (a1 - a0 < 2.6) { k++; continue; }
    const cat = S.middle && k === 3 ? 'home' : AISLE_CATS[k % AISLE_CATS.length];
    const type = cat === 'frozen' ? 'freezer' : S.middle && k === 3 ? 'bins' : S.racking ? 'rack' : 'gondola';
    // a long run is cut by a cross aisle in its middle
    const cuts = a1 - a0 > 24 ? [[a0, (a0 + a1) / 2 - 1.3], [(a0 + a1) / 2 + 1.3, a1]] : [[a0, a1]];
    for (const [p, q] of cuts) {
      const len = Math.floor((q - p) / MODULE) * MODULE;
      if (len < MODULE) continue;
      fx(type, (p + q) / 2, b, 'a', len, { cat, k });
      for (let a = p + 1.6; a < q - 0.5; a += 4.2) {
        pt('shelf', a, b - 1.25, { cat });
        pt('shelf', a, b + 1.25, { cat });
      }
    }
    rows.push({ b, a0, a1, cat });
    k++;
  }
  // ---- the walls: chilled goods along the back, shelves down the sides ----
  const wallRun = (type, a, b, along, len, cat) => {
    const n = Math.floor(len / MODULE);
    if (n < 1) return;
    fx(type, a, b, along, n * MODULE, { cat });
    for (let s = -n * MODULE / 2 + 1.4; s < n * MODULE / 2; s += 4.6) {
      const pa = along === 'a' ? a + s : a + (a > D / 2 ? -1.2 : 1.2), pb = along === 'b' ? b + s : b + (b > W / 2 ? -1.2 : 1.2);
      pt('shelf', pa, pb, { cat });
    }
  };
  wallRun('chiller', D - 0.5, W / 2, 'b', W - 1.4, 'dairy');
  if (S.bakery !== false) {
    // the bakery is the wall the entry lane's side leads to, or the back wall's first metres
    const side = lc < W / 2 ? 0.5 : W - 0.5;
    const bl = Math.min(8, backA - aAisle0 - 1);
    wallRun('bakery', aAisle0 + bl / 2, side, 'a', bl, 'bakery');
    wallRun('wallshelf', (aAisle0 + bl + backA - 1.2) / 2 + 0.3, side, 'a', backA - 1.5 - aAisle0 - bl, 'dry');
    wallRun('wallshelf', (aAisle0 + backA - 1.2) / 2, side < 1 ? W - 0.5 : 0.5, 'a', backA - 1.2 - aAisle0, 'drinks');
  } else {
    wallRun('wallshelf', (aAisle0 + backA - 1.2) / 2, 0.5, 'a', backA - 1.2 - aAisle0, 'dry');
    wallRun('wallshelf', (aAisle0 + backA - 1.2) / 2, W - 0.5, 'a', backA - 1.2 - aAisle0, 'drinks');
  }
  // the walking lanes between the rows, for the shoppers
  const lanes = [];
  const bs = rows.map((r) => r.b).sort((p, q) => p - q);
  for (let i = 0; i + 1 < bs.length; i++) if (bs[i + 1] - bs[i] < ROW_PITCH * 1.6) lanes.push((bs[i] + bs[i + 1]) / 2);
  if (!lanes.length) lanes.push(lc);
  return { kind: 'market', room, fixtures, points, lanes, rows, tills, selfs, lane: { b0: l0, b1: l1, c: lc },
    crossA, backA, aTill0: A_TILL0, aTill1, aAisle0, key: site.key,
    seed: (s) => hashK(site.key, s) };
}

const _layouts = new WeakMap();
/** The layout of a store's site, worked out once. */
export function layoutOf(site, make) {
  let l = _layouts.get(site);
  if (!l) { l = make(site); _layouts.set(site, l); }
  return l;
}
