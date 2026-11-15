// ---- mwtraffic.js: what a car on the D11 wants, as pure functions ----
// js/traffic.js runs ONE population model for the whole world (cells, slots,
// generations, schedules: see its v8/v9 headers). Round 8 gives the motorway
// a branch of its own inside that model, and the numbers and rules of that
// branch live here so they can be read, tested and tuned without the 4500
// lines around them. Pure: no three, no DOM, no Math.random, no wall clock.
// traffic.js hands in hashed 0..1 draws (its hash32 is the only randomness a
// shared world may use) and edge facts; everything here is arithmetic on
// them, so two co-op clients compute the same answers bit for bit.
//
// What was wrong (measured, survey9 motorway-traffic): one desire for every
// road, edge limit x vK with vK 0.72..1.18, so a v 130 carriageway carried
// cars at 94..153 km/h and up to 172 with the catch-up; trucks never knew
// they were trucks (the kind was drawn after the schedule) and ran 144; the
// schedule modelled every polyline vertex as a 7 m arc, so a 0.2 rad kink on
// a 500 m straight capped the motorway at 45 km/h; and 5.5 % heavy vehicles
// where the census says 28 %.

import { d11Locate } from './d11.js';
import { DAY_LENGTH, START_TOD } from './config.js';

// ---- who drives the D11 ------------------------------------------------------
// The 2020 census on the D11 (CZSO / ŘSD: Chýšť to Pravy 26 908 vehicles a
// day, 28.4 % heavy; about 40 000 a day nearer Prague, 15 000 heavy). So of
// the vehicles born on a carriageway: 30 % heavy (semi-trailers 70 % of that,
// rigid box trucks 30 %), 8 % vans, 2 % coaches, the rest cars in the town's
// own mix. Cumulative thresholds over one hashed draw.
export const MW_SEMI = 0.21, MW_TRUCK = 0.30, MW_VAN = 0.38, MW_BUS = 0.40;
// the car share, in the same proportions traffic.js COMMON has (škodas first)
const MW_CARS = ['octavia', 'octavia', 'fabia', 'fabia', 'octavia', 'bmw', 'mercedes', 'tesla'];

/** The vehicle kind of a motorway-born schedule from one 0..1 draw. */
export function mwKind(u) {
  if (u < MW_SEMI) return 'semi';
  if (u < MW_TRUCK) return 'truck';
  if (u < MW_VAN) return 'van';
  if (u < MW_BUS) return 'bus';
  const c = (u - MW_BUS) / (1 - MW_BUS);
  return MW_CARS[(c * MW_CARS.length) | 0] ?? 'octavia';
}

// Desire class codes, small ints so the hot loop compares numbers.
export const CL_CAR = 0, CL_VAN = 1, CL_HEAVY = 2, CL_BUS = 3;
/** The desire class of a kind: what the law and the limiter let it do. */
export function classOf(kind) {
  if (kind === 'truck' || kind === 'semi') return CL_HEAVY;
  if (kind === 'bus' || kind === 'trolleybus') return CL_BUS;
  if (kind === 'van') return CL_VAN;
  return CL_CAR;
}

// ---- how fast ---------------------------------------------------------------
// Czech law: 130 on a motorway, 80 for a lorry over 3.5 t, 100 for a coach.
// What the D11 actually does: cars spread from the cautious 112 to the odd
// mild speeder at 139 (a personal factor 0.86..1.07 of the limit, never the
// 1.18 of the town table, which on 130 is 153); vans hold under 125; lorries
// sit on their 85 km/h limiters (80..89); coaches 95..100.
export const VK_MW_MIN = 0.86, VK_MW_VAR = 0.21;
export const VAN_MAX = 125 / 3.6;
export const HEAVY_MIN = 80 / 3.6, HEAVY_VAR = 9 / 3.6;
export const BUS_MIN = 95 / 3.6, BUS_VAR = 5 / 3.6;
export const MW_LIMIT = 130 / 3.6;
// A slip road is signed for its tightest curve, and the corner caps already
// slow a car for that curve: on an ENTRY slip a driver is accelerating to
// join 130 km/h traffic, not holding the 60 on the sign.
export const ENTRY_V = 80 / 3.6;
// Catching up a lag on a motorway: at most this much over the driver's own
// desire (the town's x1.35 / x1.9 is 50 km/h on top of 130).
export const MW_CATCH = 12 / 3.6;

// A lorry's speed limiter (EU: 90 km/h) and a coach's (100) are no driver's
// mood: the catch-up stops there.
export const HEAVY_LIM = 90 / 3.6, BUS_LIM = 100 / 3.6;
/** The most a motorway driver of class `cls` with this desire will do to make up a lag. */
export function mwCeil(cls, desire) {
  const v = desire + MW_CATCH;
  if (cls === CL_HEAVY) return v < HEAVY_LIM ? v : HEAVY_LIM > desire ? HEAVY_LIM : desire;
  if (cls === CL_BUS) return v < BUS_LIM ? v : BUS_LIM > desire ? BUS_LIM : desire;
  return v;
}

/** A schedule's motorway factor from a 0..1 draw. */
export const mwVk = (u) => VK_MW_MIN + u * VK_MW_VAR;
/** A heavy vehicle's (or a coach's) cruise from a 0..1 draw. */
export const heavyV = (cls, u) => cls === CL_BUS ? BUS_MIN + u * BUS_VAR : HEAVY_MIN + u * HEAVY_VAR;

/**
 * Desire in m/s on a motorway-class edge. `lim` the edge's signed speed in
 * m/s (edge.speed), `vk` the driver's motorway factor, `hv` the heavy cruise
 * (heavyV), `entry` whether this is a slip road joining a carriageway.
 */
export function mwDesire(cls, vk, hv, lim, entry) {
  let v = (lim < MW_LIMIT ? lim : MW_LIMIT);
  if (entry && v < ENTRY_V) v = ENTRY_V;
  v *= vk;
  if (cls === CL_VAN && v > VAN_MAX) v = VAN_MAX;
  else if ((cls === CL_HEAVY || cls === CL_BUS) && v > hv) v = hv;
  return v;
}

// ---- corners on a motorway -----------------------------------------------------
// traffic.js cornerSpeed treats a polyline vertex as a turn taken over 7 m,
// which is right for a town junction and absurd for a motorway: OSM draws a
// 2 km radius as straights meeting at 0.1 rad vertices a few hundred metres
// apart. The turn is spread over the shorter of the two segments it joins,
// so R = L / ang and v = sqrt(a R) at the same lateral 4.5 m/s2 the town
// rule uses (at L = 7 m the two agree). The 0.06 rad noise floor stays.
export const MW_CORNER_A = 4.5;
const L_MIN = 7, L_MAX = 400;
/** Corner speed for a motorway vertex of turn `ang` between segments, the shorter `L` m long. */
export function mwCornerV(ang, L) {
  if (!(ang > 0.06)) return Infinity;
  const l = L < L_MIN ? L_MIN : L > L_MAX ? L_MAX : L;
  return Math.sqrt(MW_CORNER_A * l / ang);
}

// ---- where cars leave ------------------------------------------------------------
// At a diverge the town's 70 % "carry straight on" pick sends half the
// carriageway down every slip road. On the D11 most traffic is through
// traffic: a car leaves at a given exit about one time in eight.
export const P_EXIT = 0.12;

// ---- the odd queue: roadworks and the Prague rush hour ---------------------------
// Real D11 traffic is not 96 km of free flow: a lane is closed for works
// somewhere most days, and the Prague end jams at the rush hours. Both are a
// SPEED FIELD on the carriageway, applied to the schedule (traffic.js _nomTo
// caps a piece's speed by it, the body reads the same cap), so every client
// sees the same queue in the same place: with the schedules slower there,
// density rises there by itself. Never under ZONE_MIN: a schedule slower than
// about 40 km/h falls out of the reactive layer's LAG_MAX in a zone.
//   · Roadworks: 2 or 3 zones per game day (DAY_LENGTH s of shared time),
//     each on one carriageway, 0.8 to 2 km, km 4 to 96, from a hash of the
//     day: 80 km/h for APPROACH km before, 60 inside, the left lane closed
//     from CLOSE_AHEAD km before to the end.
//   · Where the closure is (round 8 fix). The left lane used to be closed
//     only from the zone's km on, with a hint CLOSE_AHEAD before it, and the
//     shared lane decision waited for a free-flow gap until then: a fifth of
//     the bodies were still in the left lane at the zone's start and the last
//     of them merged 150 m inside it. Now the closure is a place on the road,
//     the one js/mwworks.js draws: the arrow trailer and the cone taper from
//     TAPER_AT km before the zone to TAPER_END before it, the cones along the
//     lane line to the end. Every car is out of the left lane by force
//     CLOSE_FORCE km before (the zipper of js/mwlanes.js bodyLane does the
//     body's part): over 12 zones 99.8 % of the bodies were out by the
//     trailer and every one by the end of the taper.
//   · Rush hour: km 0 to RUSH_KM both ways (the D0 and Černý Most), 07:00 to
//     09:00 and 15:30 to 18:30, at RUSH_V.
export const ZONE_V = 60 / 3.6, APPROACH_V = 80 / 3.6, RUSH_V = 70 / 3.6, ZONE_MIN = 40 / 3.6;
export const APPROACH = 0.6, CLOSE_AHEAD = 0.85, RUSH_KM = 5;
export const CLOSE_FORCE = 0.4, TAPER_AT = 0.2, TAPER_END = 0.05;
const h32 = (a, b) => {
  let h = Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 8) / 16777216;
};
let _day = NaN, _zones = [];
/** The roadworks of shared second T: [{ cw, a, b }] in official km, a < b (memoised per day). */
export function zonesAt(T) {
  const day = Math.floor(START_TOD + T / DAY_LENGTH);
  if (day === _day) return _zones;
  _day = day; _zones = [];
  const n = 2 + (h32(day, 1) < 0.5 ? 1 : 0);
  for (let k = 0; k < n; k++) {
    const a = 4 + h32(day, 10 + k) * 92, len = 0.8 + h32(day, 20 + k) * 1.2;
    _zones.push({ cw: h32(day, 30 + k) < 0.5 ? 'E' : 'W', a, b: a + len });
  }
  return _zones;
}
/** Is shared second T in the rush hours? */
export function rushAt(T) {
  const t = (START_TOD + T / DAY_LENGTH) % 1 * 24;
  return (t >= 7 && t < 9) || (t >= 15.5 && t < 18.5);
}
const _loc = {};
// km along the D11 of every vertex of a carriageway edge (NaN off the D11),
// worked out once per edge from js/d11.js
function edgeKm(e) {
  if (e._zk) return e._zk;
  const n = e.pts.length, k = new Float32Array(n);
  let cw = null;
  for (let i = 0; i < n; i++) {
    const L = d11Locate(e.pts[i][0], e.pts[i][1], _loc);
    k[i] = L && (L.cw === 'E' || L.cw === 'W') ? L.km : NaN;
    if (L && !cw) cw = L.cw;
  }
  e._zcw = cw;
  return (e._zk = k);
}
// does carriageway `cw`'s direction of travel reach [a, b) between km k0 and k1?
const over = (k0, k1, a, b) => (k0 < k1 ? k1 > a && k0 < b : k0 > a && k1 < b);
/**
 * The speed cap (m/s, Infinity for none) on segment `seg` of carriageway
 * edge `e` at shared second T: the roadworks and the rush hour.
 */
export function zoneCap(e, seg, T) {
  const k = edgeKm(e);
  const k0 = k[seg], k1 = k[seg + 1];
  if (k0 !== k0 || k1 !== k1) return Infinity;
  let cap = Infinity;
  for (const z of zonesAt(T)) {
    if (z.cw !== e._zcw) continue;
    // E runs up the km, W down: "before" the zone is below a on E, above b on W
    if (over(k0, k1, z.a, z.b)) return ZONE_V;
    if (z.cw === 'E' ? over(k0, k1, z.a - APPROACH, z.a) : over(k0, k1, z.b, z.b + APPROACH)) cap = APPROACH_V;
  }
  if (cap > RUSH_V && (k0 < RUSH_KM || k1 < RUSH_KM) && rushAt(T)) cap = RUSH_V;
  return cap;
}
/**
 * Is the left lane closed s m along edge e at T: 0 no, 1 within CLOSE_AHEAD
 * km ahead (move over when there is a gap), 2 here: from CLOSE_FORCE km
 * before the zone to its end (move over, gap or not).
 */
export function leftClosed(e, s, T) {
  const k = edgeKm(e);
  let i = 0;
  while (i < e.pts.length - 2 && e.cum[i + 1] < s) i++;
  const k0 = k[i], k1 = k[i + 1];
  if (k0 !== k0 || k1 !== k1) return 0;
  const u = (s - e.cum[i]) / ((e.cum[i + 1] - e.cum[i]) || 1), km = k0 + (k1 - k0) * u;
  for (const z of zonesAt(T)) {
    if (z.cw !== e._zcw) continue;
    if (z.cw === 'E' ? km > z.a - CLOSE_FORCE && km < z.b : km < z.b + CLOSE_FORCE && km > z.a) return 2;
    if (z.cw === 'E' ? km > z.a - CLOSE_AHEAD && km < z.b : km < z.b + CLOSE_AHEAD && km > z.a) return 1;
  }
  return 0;
}
