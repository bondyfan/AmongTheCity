// ---- Job places: the named world, as jobs see it ----
// Reads the city data the tiles already carry and answers three questions:
//
//   collectPlaces   every NAMED place around a point (venue points, named
//                   buildings with a trade, stations and bus stops)
//   resolveStop     where a car can actually pull up for one of them: the
//                   nearest point on a drivable road, and that road's name
//   foodPlaceAt     is the player standing at somewhere that sells food
//
// No three.js and no DOM: it only walks `city` (js/geo.js), so the generator
// in js/jobgen.js stays pure and this file can be exercised with a hand-built
// chunk index (tests/jobplaces.test.mjs).
//
// NOTHING IS INVENTED HERE. A place is offered only if the map names it, and
// its "address" is the name of the real street its stop point lies on.

import { CHUNK } from './config.js';
import { shopAt } from './pumps.js';
import { pumpBrand } from './prices.js';

const key = (cx, cz) => cx + ',' + cz;

// Trades that put food or drink in your hand. Restaurants and shops both: a
// supermarket sells you a párek as surely as a hospoda does.
export const FOOD_TYPES = new Set(['restaurant', 'fast_food', 'cafe', 'pub', 'bar',
  'bakery', 'pastry', 'ice_cream', 'food_court', 'biergarten', 'supermarket',
  'convenience', 'kiosk', 'butcher', 'confectionery', 'deli', 'greengrocer']);

const POI_TYPES = new Set(['station', 'bus_stop', 'hospital']);

function centroid(o) {
  let x = 0, z = 0;
  for (const p of o) { x += p[0]; z += p[1]; }
  return [x / o.length, z / o.length];
}

function place(type, name, x, z) {
  const n = String(name).trim();
  if (n.length < 2 || n.length > 60) return null;
  return { id: type + ':' + Math.round(x) + ',' + Math.round(z) + ':' + n, name: n, type, x, z };
}

/**
 * Every named place within `radius` of (x, z). Walks the flat per-city arrays
 * once: this runs when the board is opened, not per frame, and a few tens of
 * thousands of distance tests are a millisecond.
 */
export function collectPlaces(city, x, z, radius) {
  const out = [], seen = new Set();
  const r2 = radius * radius;
  const add = (p) => { if (p && !seen.has(p.id)) { seen.add(p.id); out.push(p); } };
  for (const v of city?.venues ?? []) {
    const p = Array.isArray(v.p?.[0]) ? v.p[0] : v.p;
    if (!p || !v.n || !v.t) continue;
    const dx = p[0] - x, dz = p[1] - z;
    if (dx * dx + dz * dz <= r2) add(place(v.t, v.n, p[0], p[1]));
  }
  for (const b of city?.buildings ?? []) {
    if (!b.n || !b.u || !b.o?.length) continue;
    const dx = b.o[0][0] - x, dz = b.o[0][1] - z;
    if (dx * dx + dz * dz > r2) continue;
    const [cx, cz] = centroid(b.o);
    add(place(b.u, b.n, cx, cz));
  }
  for (const q of city?.pois ?? []) {
    if (!q.n || !q.p || !POI_TYPES.has(q.t)) continue;
    const dx = q.p[0] - x, dz = q.p[1] - z;
    if (dx * dx + dz * dz <= r2) add(place(q.t, q.n, q.p[0], q.p[1]));
  }
  return out;
}

// A road a job may end on: drivable, at ground level, and not a slip road
// where stopping would be the last thing you did.
function stoppable(r) {
  if (r.d !== 1 || !r.p || r.p.length < 2 || r.br) return false;
  const t = r.t ?? '';
  return !(t.startsWith('motorway') || t.startsWith('trunk') || t.endsWith('_link'));
}

const STOP_R = 90;                 // m: further than this and the place has no kerb
const SERVICE_PEN = 18;            // m of handicap for a yard or a car park aisle

/**
 * Where a car stops for `p`: { x, z, street } or null when no drivable road
 * comes within STOP_R. A named street beats a nameless service road unless the
 * service road is a good deal closer, because "Sladkovského" is an address and
 * "the yard behind it" is not.
 */
export function resolveStop(city, p) {
  const idx = city?.chunkIndex;
  if (!idx) return null;
  const cx = Math.floor(p.x / CHUNK), cz = Math.floor(p.z / CHUNK);
  let best = Infinity, bx = 0, bz = 0, bex = 1, bez = 0, bRoad = null;
  let nameD = Infinity, name = null;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const cell = idx.get(key(cx + dx, cz + dz));
    for (const r of cell?.roads ?? []) {
      if (!stoppable(r)) continue;
      const pen = r.t === 'service' || !r.n ? SERVICE_PEN : 0;
      for (let i = 1; i < r.p.length; i++) {
        const x1 = r.p[i - 1][0], z1 = r.p[i - 1][1], x2 = r.p[i][0], z2 = r.p[i][1];
        const ex = x2 - x1, ez = z2 - z1;
        const L = ex * ex + ez * ez;
        let t = L ? ((p.x - x1) * ex + (p.z - z1) * ez) / L : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x1 + t * ex, qz = z1 + t * ez;
        const d = Math.hypot(qx - p.x, qz - p.z);
        if (r.n && d < nameD) { nameD = d; name = r.n; }
        // ties broken on the coordinates so the answer does not depend on the
        // order the cell happens to list its roads in
        const score = d + pen;
        if (score < best - 1e-6 || (Math.abs(score - best) <= 1e-6 && (qx < bx || (qx === bx && qz < bz)))) {
          best = score; bx = qx; bz = qz; bex = ex; bez = ez; bRoad = r;
        }
      }
    }
  }
  if (!bRoad || best > STOP_R) return null;
  const k = kerbSide(city, bRoad, bx, bz, bex, bez, p.x, p.z);
  return { x: k.x, z: k.z, wx: k.wx, wz: k.wz, street: bRoad.n ?? (nameD < 140 ? name : null) };
}

// ---- pull in to the kerb ----------------------------------------------------
// A stop used to be the point on the road's CENTRELINE nearest the place. A
// car that stops there stands astride both lanes with the traffic coming at it
// from either side (the taxi pick-up where the AI rammed the player's van), and
// "the kerb beside it" was measured towards the place and "never past it", so
// where the map's point for a shop lies on the asphalt the fare stood on the
// asphalt too. Now the car stops IN THE LANE AGAINST THE KERB on the place's
// side, and the fare stands behind that kerb, on the pavement, and on nobody
// else's carriageway either.
const KERB_IN = 1.25;              // m from the carriageway edge to the stopped car's centreline
const SIDE_MAX = 4.5;              // m off the centreline at most (under SNAP_MIN: the GPS line still ends at the stop)
const FARE_OUT = [1.3, 2.4, 3.6];  // m behind the carriageway edge the fare stands, nearest first
const FARE_ALONG = [0, 3.5, -3.5, 7, -7];   // m along the kerb from the car, tried in this order

/** Is (x, z) on the asphalt of a drivable way other than `own`? */
function onCarriageway(city, x, z, own) {
  const idx = city?.chunkIndex;
  if (!idx) return false;
  const cell = idx.get(key(Math.floor(x / CHUNK), Math.floor(z / CHUNK)));
  for (const r of cell?.roads ?? []) {
    if (r === own || r.d !== 1 || r.br || !r.p) continue;
    const reach = (r.w ?? 6) / 2 + 0.4;
    for (let i = 1; i < r.p.length; i++) {
      const x1 = r.p[i - 1][0], z1 = r.p[i - 1][1], ex = r.p[i][0] - x1, ez = r.p[i][1] - z1;
      const L = ex * ex + ez * ez;
      let t = L ? ((x - x1) * ex + (z - z1) * ez) / L : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if (Math.hypot(x1 + t * ex - x, z1 + t * ez - z) < reach) return true;
    }
  }
  return false;
}

/**
 * The kerb-side stop on way `r` abreast of its centreline point (qx, qz), where
 * the way runs (ex, ez), on the side (px, pz) is on: { x, z } for the car and
 * { wx, wz } for whoever waits. A place the map put on the centreline itself
 * gets the right-hand kerb of the way's own direction.
 */
function kerbSide(city, r, qx, qz, ex, ez, px, pz) {
  const L = Math.hypot(ex, ez) || 1;
  const nx = -ez / L, nz = ex / L;                       // right of the way's direction
  const lat = (px - qx) * nx + (pz - qz) * nz;
  const side = lat < -0.05 ? -1 : 1;
  const hw = (r.w ?? 6) / 2;
  const inn = Math.max(0, Math.min(SIDE_MAX, hw - KERB_IN));
  let wx = qx + nx * side * (hw + FARE_OUT[0]), wz = qz + nz * side * (hw + FARE_OUT[0]);
  // abreast of the car if that is pavement; otherwise a few steps along the
  // kerb (the mouth of a yard or a side street is asphalt however far back
  // from the kerb one stands)
  search:
  for (const along of FARE_ALONG) {
    for (const out of FARE_OUT) {
      const x = qx + (ex / L) * along + nx * side * (hw + out), z = qz + (ez / L) * along + nz * side * (hw + out);
      if (onCarriageway(city, x, z, r)) continue;
      wx = x; wz = z;
      break search;
    }
  }
  return { x: +(qx + nx * side * inn).toFixed(1), z: +(qz + nz * side * inn).toFixed(1),
    wx: +wx.toFixed(1), wz: +wz.toFixed(1) };
}

/** The stoppable way whose centreline passes within `maxD` of (x, z): { r, qx, qz, ex, ez } or null. */
function roadUnder(city, x, z, maxD) {
  const idx = city?.chunkIndex;
  if (!idx) return null;
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  let best = maxD, hit = null;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const r of idx.get(key(cx + dx, cz + dz))?.roads ?? []) {
      if (!stoppable(r)) continue;
      for (let i = 1; i < r.p.length; i++) {
        const x1 = r.p[i - 1][0], z1 = r.p[i - 1][1], ex = r.p[i][0] - x1, ez = r.p[i][1] - z1;
        const L = ex * ex + ez * ez;
        let t = L ? ((x - x1) * ex + (z - z1) * ez) / L : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x1 + t * ex, qz = z1 + t * ez, d = Math.hypot(qx - x, qz - z);
        if (d < best - 1e-6 || (hit && Math.abs(d - best) <= 1e-6 && (qx < hit.qx || (qx === hit.qx && qz < hit.qz)))) {
          best = d; hit = { r, qx, qz, ex, ez };
        }
      }
    }
  }
  return hit;
}

// ---- the stop is where the GPS line ends -----------------------------------
// resolveStop() puts a stop on the nearest drivable road, and the navigator
// will not always go there: that road is often a courtyard lane or a
// pedestrian street the network cannot drive into, so the route finishes at
// the nearest road it CAN reach (navigation.js, CAND_K). Measured over five
// boards, two stops in five had the line end more than an arrival radius from
// the marker: the player sat at the end of the line and nothing happened.
//
// So once the route to a stop exists, the stop moves to the route's end, once.
// `nav` is anything shaped like navigation.js ({ destination, route, partial });
// `t` is a job's from/to (or the introduction's target) and is changed in
// place. `snap` rides in it (and so in the save): the move is never redone.
// A partial route is believed only when it already ends close by, because one
// that stops a kilometre short is tiles still streaming, not an answer.
// Returns true when the stop moved (the caller re-aims marker, flag and fare).
const SNAP_MIN = 6;                // m: a route ending this close is at the stop
const SNAP_MAX = 160;              // m: further than this is not the same address
const KERB_OUT = 4.4;              // m from the centreline to where a fare stands

export function snapStopToRoute(t, nav, city) {
  const nd = nav?.destination, route = nav?.route;
  if (!t || t.snap || !nd || !route || route.length < 2) return false;
  if (Math.abs(nd.x - t.x) > 2 || Math.abs(nd.z - t.z) > 2) return false;   // not our route
  const end = route[route.length - 1];
  const gap = Math.hypot(end[0] - t.x, end[1] - t.z);
  if (!(gap <= SNAP_MAX)) { if (!nav.partial) t.snap = 1; return false; }
  t.snap = 1;
  if (gap < SNAP_MIN) return false;
  // the kerb stays on the place's own side: aim at where it was
  const ax = t.wx ?? t.x, az = t.wz ?? t.z;
  const kx = ax - end[0], kz = az - end[1], kd = Math.hypot(kx, kz);
  const under = roadUnder(city, end[0], end[1], 3);
  if (under) {
    // the end of the line is on a street: pull in to its kerb, as resolveStop does
    const k = kerbSide(city, under.r, under.qx, under.qz, under.ex, under.ez, ax, az);
    t.x = k.x; t.z = k.z; t.wx = k.wx; t.wz = k.wz;
    // the address is the street the stop is on now, when the map names it
    if (under.r.n) t.street = under.r.n;
    return true;
  }
  t.x = +end[0].toFixed(1); t.z = +end[1].toFixed(1);
  const out = Math.min(kd, KERB_OUT);
  t.wx = kd > 0.01 ? +(t.x + kx / kd * out).toFixed(1) : t.x;
  t.wz = kd > 0.01 ? +(t.z + kz / kd * out).toFixed(1) : t.z;
  return true;
}

function distToRing(o, x, z) {
  let best = Infinity, inside = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const x1 = o[j][0], z1 = o[j][1], x2 = o[i][0], z2 = o[i][1];
    if ((z1 > z) !== (z2 > z) && x < (x2 - x1) * (z - z1) / (z2 - z1) + x1) inside = !inside;
    const ex = x2 - x1, ez = z2 - z1;
    const L = ex * ex + ez * ez;
    let t = L ? ((x - x1) * ex + (z - z1) * ez) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x1 + t * ex - x, z1 + t * ez - z);
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

/**
 * The food place the player is AT: a venue point within `maxD`, or a named
 * eatery whose own building they are inside of or standing against. Returns
 * { name, type } or null. Reads one 3x3 of chunks.
 */
export function foodPlaceAt(city, x, z, maxD = 7) {
  const idx = city?.chunkIndex;
  if (!idx) return null;
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  let best = maxD, hit = null;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const cell = idx.get(key(cx + dx, cz + dz));
    if (!cell) continue;
    for (const v of cell.venues ?? []) {
      if (!v.n || !FOOD_TYPES.has(v.t)) continue;
      const p = Array.isArray(v.p?.[0]) ? v.p[0] : v.p;
      const d = Math.hypot(p[0] - x, p[1] - z);
      if (d < best) { best = d; hit = v; }
    }
    for (const b of cell.buildings ?? []) {
      if (!b.n || !FOOD_TYPES.has(b.u) || !b.o?.length) continue;
      const d = distToRing(b.o, x, z);
      if (d < best) { best = d; hit = b; }
    }
  }
  if (hit) return { name: hit.n, type: hit.t && FOOD_TYPES.has(hit.t) ? hit.t : hit.u };
  // No eatery here: maybe a petrol station's shop (round 8). Three of the D11
  // services sides have no restaurant at all, and every Czech forecourt sells
  // coffee and a bageta over the till. Named by the brand, served from the
  // shop menu (PRICE.shop, js/shoppanel.js).
  const fuel = shopAt(city, x, z);
  return fuel ? { name: pumpBrand(fuel.n).name + ' · prodejna', type: 'fuel', menu: 'shop' } : null;
}

/**
 * The nearest place of one of `types` between `minD` and `maxD` metres away
 * that a car can stop at. Used for the introduction's first drive.
 */
export function nearestStop(city, x, z, types, minD, maxD) {
  const cands = collectPlaces(city, x, z, maxD)
    .filter((p) => types.has(p.type))
    .map((p) => ({ p, d: Math.hypot(p.x - x, p.z - z) }))
    .filter((c) => c.d >= minD)
    .sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));
  for (const c of cands.slice(0, 12)) {
    const s = resolveStop(city, c.p);
    if (s) return { x: s.x, z: s.z, name: c.p.name, street: s.street };
  }
  return null;
}
