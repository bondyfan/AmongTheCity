// ---- stores/showlayout.js: a car showroom, in numbers ----
// WORKER SAFE: pure numbers, no three, no DOM. Three answers, each asked by
// more than one module so that they cannot disagree:
//
//   pickShowFront  which wall the gate is in (js/stores/landmark.js pins it on
//                  the main thread, the mesh worker reads the memo)
//   showLayout     where the cars, the desk and the spec stands are on the floor
//   leftLot        has a car been driven off the premises (the theft rule)
//
// A grocer fronts its car park (js/stores/site.js pickFront). A showroom fronts
// the wall with the most ROOM behind it: a car has to stand nose to the gate
// and be driven straight out, and the real footprint (a glazed strip 6.6 m deep
// round the corner of a workshop hall) has only one wall where that fits.

import { makeSite, shopRect, inRing, hashK } from './site.js';
import { roomOf } from './layout.js';

/** Length and width of what stands on the floor (js/vehicles.js KIND). */
export const SHOW_CARS = {
  roadster: { len: 4.56, wid: 2.0, name: 'Tesla Roadster', color: 0xa61c26,
    spec: '0–100 km/h asi za 1 s · až 400 km/h · trysky na stlačený plyn' },
  tesla: { len: 4.72, wid: 1.85, name: 'Tesla Model 3 Performance', color: 0xe9eae5,
    spec: '0–100 km/h za 3,1 s · pohon všech kol · dojezd 528 km' },
};
/** Metres past the walls a display car may be rolled before it counts as taken. */
export const LOT_PAD = 9;
/** What driving one away costs (js/wanted.js STAR_AT: 45 is the second star). */
export const THEFT_HEAT = 46;
export const THEFT_NOUN = 'krádež vystaveného vozu';

/** The index of the ring edge the gate is in, or -1 when no wall has room behind it. */
export function pickShowFront(f, chain, src) {
  const ring = f.o, n = ring.length, w = chain.arch.doorW;
  let best = -1, bestS = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < w * 2 + 0.6) continue;                     // the two leaves need wall to slide over
    const site = makeSite(f, chain, i);
    if (site.front.i !== i) continue;
    // a neighbour standing in front of the wall: nothing drives out that way
    const px = site.door.x + site.nx * 5, pz = site.door.z + site.nz * 5;
    if ((src?.buildings ?? []).some((o) => o !== f && o.o?.length >= 3 && (o.y ?? 0) <= 0.5 && inRing(o.o, px, pz))) continue;
    const r = shopRect(site, 0.45), [du, dv] = site.local(site.door.x, site.door.z);
    // the room has to come up to the gate's own wall and take the whole gate
    if (r.v1 < dv - 1.2 || du - w / 2 < r.u0 || du + w / 2 > r.u1) continue;
    const D = r.v1 - r.v0, W = r.u1 - r.u0;
    if (D < SHOW_CARS.roadster.len + 0.9) continue;    // a car, nose to the gate
    const s = Math.min(W, 30) * Math.min(D, 12);
    if (s > bestS + 1e-6) { bestS = s; best = i; }
  }
  return best;
}

/** World heading of a car whose nose points along (dx, dz) (js/vehicles.js: forward is -sin, -cos). */
export const headingOf = (dx, dz) => Math.atan2(-dx, -dz);

/**
 * showLayout(site) -> { kind: 'showroom', room, fixtures, points, stands, staff }
 *   stands[]  { slot, kind, id, a, b, x, z, heading, color, name, spec }
 *             `id` names the car for the whole session: store key and slot
 *   points[]  { kind: 'spec', slot, a, b, x, z } the stand E reads the card on
 */
export function showLayout(site) {
  const room = roomOf(site), { W, D, bd } = room, cars = site.chain.show?.cars ?? [];
  const fixtures = [], points = [], stands = [], staff = [];
  const fx = (t, a, b, along, len, o) => { const f = { t, a, b, along, len, ...o }; fixtures.push(f); return f; };
  const out = headingOf(site.nx, site.nz);
  const stand = (kind, a, b, turn) => {
    const [x, z] = room.at(a, b), C = SHOW_CARS[kind], slot = stands.length;
    stands.push({ slot, kind, id: site.key + ':' + slot, a, b, x, z, heading: out + turn, color: C.color, name: C.name, spec: C.spec });
    return slot;
  };
  // the first car stands behind the gate, nose out: it is the one that can leave
  const side = bd > W / 2 ? -1 : 1;                    // which way the floor is longer
  const used = [];
  cars.forEach((kind, i) => {
    const C = SHOW_CARS[kind];
    if (!C) return;
    const a = Math.min(D - C.len / 2 - 0.45, C.len / 2 + 1.2);
    if (a < C.len / 2 + 0.3) return;                   // the room is too shallow for it
    // every other car a bay further along, on alternate sides, turned a little to the gate
    const k = Math.ceil(i / 2), s = i === 0 ? 0 : (i % 2 ? side : -side);
    const b = bd + s * k * 4.4;
    if (b < C.wid / 2 + 0.9 || b > W - C.wid / 2 - 0.9) return;
    const slot = stand(kind, a, b, -s * 0.2);
    used.push(b);
    // its card: a slim stand by the front wing, on the side away from the gate
    const sb = b + (s || -side) * (C.wid / 2 + 0.95), sa = Math.max(0.7, a - C.len / 2 + 0.6);
    if (sb > 0.4 && sb < W - 0.4) {
      fx('stand', sa, sb, 'b', 0.4, { single: true });
      const [x, z] = room.at(sa - 0.55, sb);
      points.push({ kind: 'spec', slot, a: sa - 0.55, b: sb, x, z });
    }
  });
  // the advisers' desk at the back, in the longest stretch of floor no car stands on
  const edges = [0, ...used.sort((p, q) => p - q), W];
  let g0 = 0, g1 = 0;
  for (let i = 0; i + 1 < edges.length; i++) {
    const p = edges[i] + (i ? 1.7 : 0.4), q = edges[i + 1] - (i + 2 < edges.length ? 1.7 : 0.4);
    if (q - p > g1 - g0) { g0 = p; g1 = q; }
  }
  if (g1 - g0 >= 2.0) {
    const len = g1 - g0 >= 3.2 ? 2.6 : 1.3, db = (g0 + g1) / 2;
    fx('desk', D - 0.75, db, 'b', len);
    const [x, z] = room.at(D - 1.75, db);
    staff.push({ a: D - 1.75, b: db, x, z, role: 'adviser' });
  }
  return { kind: 'showroom', room, fixtures, points, stands, staff, lane: { c: bd, b0: bd - 2.6, b1: bd + 2.6 },
    key: site.key, seed: (s) => hashK(site.key, s) };
}

/** How far (x, z) is from the outline of ring `o` (0 on it). */
export function ringDist(o, x, z) {
  let best = Infinity;
  for (let i = 0, n = o.length; i < n; i++) {
    const a = o[i], b = o[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    let k = ((x - a[0]) * ex + (z - a[1]) * ez) / (ex * ex + ez * ez || 1);
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const d = Math.hypot(x - a[0] - ex * k, z - a[1] - ez * k);
    if (d < best) best = d;
  }
  return best;
}

/** Is a car at (x, z) off the premises of the showroom whose footprint is `o`? */
export function leftLot(o, x, z, pad = LOT_PAD) {
  return !inRing(o, x, z) && ringDist(o, x, z) > pad;
}

/**
 * The theft rule, once a frame for the car the LOCAL player drives. A display
 * car (`car._show`, js/stores/showroom.js) that is not the player's own and has
 * left the premises is charged once: two stars on the spot. Stars are local
 * (js/wanted.js), so in co-op each player answers for the car they took.
 * `d` { wanted, toast }. True on the frame it charges.
 */
export function watchDisplay(car, d) {
  const s = car?._show;
  if (!s || s.gone || car.owned || !leftLot(s.o, car.x, car.z)) return false;
  s.gone = true;
  d.wanted?.add(THEFT_HEAT, THEFT_NOUN);
  d.toast?.('Alarm autosalonu', { icon: '🚨', kind: 'warn', sub: 'Odjel jsi s vystaveným vozem. Jde po tobě policie.' });
  return true;
}
