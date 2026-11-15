// ---- d11services.js: the services of the D11, made to work ----
// Pure data and pure functions. js/geo.js indexPayload calls servicesInto()
// on every tile payload before it files anything, and geo.js is in the mesh
// WORKER's import graph: no three, no DOM, nothing that touches either.
//
// WHAT THE TILES GET WRONG, and what this puts right at load time (no tile
// rebuild, the owner has not approved one):
//
//  1. Osice westbound (km 81, the Benzina with the McDonald's) has NO fuel poi:
//     OSM maps that station as a building (way 1150466310, amenity=fuel), and
//     the build keeps fuel only as nodes. SYNTH_FUEL puts a node under its
//     mapped canopy, in the tile poi shape, so the pump index (main.js), the
//     map marks (career.js), the forecourt mesher and the workers all see it,
//     exactly as if the tile had carried it.
//  2. Every forecourt canopy in OSM is a building=roof, and the tiles draw it
//     as a 4.3 m SOLID box with windows: on the D11 one stands 2 m from every
//     pump node, so the drawn forecourt (built beside it, see js/forecourt.js)
//     was half buried in a block you could not drive through. liftCanopies()
//     lifts that roof onto 4.6 m of clear height (the tile's `y`, which the
//     mesher, the collider and the walkers already read as "passable under",
//     the skyway rule) and hands the node the roof's frame (`cv`), so the
//     pumps are drawn and used UNDER the real canopy.
//
// Both are pure functions of the payload: every client and both threads get
// the same pois and the same roofs whatever order the tiles came in. Pois
// carry no ids and a lifted roof keeps its own, so no id shifts anywhere.
//
// The SITES half (siteNear, TRUCK_PARKS) is what the parking lots read to
// tell a motorway services lot from a village car park: the tiles carry no
// hgv tag (data/raw-region has it on the Bříství lot only), so it is the
// js/d11.js REST table plus the one parking-only bay with no fuel.

import { REST } from './d11data.js';

/**
 * Fuel the tiles lack, in the tile poi shape. Placed at the centre of the
 * station's mapped canopy (the t 'roof' building over the pump lanes, centre
 * of its ring), so liftCanopies frames the forecourt on it.
 * Osice W: brand from the OSM building's tags (brand Benzina).
 */
export const SYNTH_FUEL = Object.freeze([
  Object.freeze({ site: 'osice', side: 'W', p: Object.freeze([-4133.5, -11917.0]), t: 'fuel', n: 'Benzina' }),
]);

const TILE = 4800;
const CANOPY_R = 12;         // m: a roof this close to a fuel node is its canopy
const CANOPY_MIN = 60;       // m^2: smaller is a kiosk awning, not a forecourt
const CANOPY_MAX = 2500;     // m^2: larger is a hall, not a canopy
const CANOPY_FAR = 32;       // m: the same, for a station js/d11.js REST lists
const CLEAR = 4.5;           // m under a lifted canopy (a lorry is 4.0)
// m the canopy itself, fascia to roof (the forecourt mesher clads it in the
// brand's colours; the building mesher draws its slab, underside and top)
const SLAB = 1.2;

/**
 * Put the services right in one tile payload, in place: synthetic fuel pois
 * appended to data.pois, mapped canopies lifted and framed. Idempotent (a
 * payload indexed twice is untouched the second time).
 */
export function servicesInto(data) {
  if (!data || data._svc) return data;
  data._svc = true;
  const tx = data.tx, tz = data.tz;
  if (Number.isFinite(tx) && Number.isFinite(tz)) {
    for (const s of SYNTH_FUEL) {
      if (Math.floor(s.p[0] / TILE) !== tx || Math.floor(s.p[1] / TILE) !== tz) continue;
      // a fresh record per payload: geo.js hands t.pois on to listeners and
      // the mesher's spec copies them, nothing may share one across loads
      (data.pois ??= []).push({ p: [s.p[0], s.p[1]], t: 'fuel', n: s.n });
    }
  }
  liftCanopies(data);
  return data;
}

function ringArea(o) {
  let a = 0;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) a += (o[j][0] + o[i][0]) * (o[j][1] - o[i][1]);
  return Math.abs(a) / 2;
}
function inRing(x, z, o) {
  let inside = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const xi = o[i][0], zi = o[i][1], xj = o[j][0], zj = o[j][1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segDist2(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  let t = ((x - ax) * ex + (z - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return (x - ax - ex * t) ** 2 + (z - az - ez * t) ** 2;
}
function ringDist(x, z, o) {
  if (inRing(x, z, o)) return 0;
  let best = Infinity;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const d = segDist2(x, z, o[j][0], o[j][1], o[i][0], o[i][1]);
    if (d < best) best = d;
  }
  return Math.sqrt(best);
}

/**
 * The frame of a canopy ring: the lanes run along the drivable road that
 * passes UNDER it (a station's pump lanes are service ways mapped through
 * the roof), else along its longest edge. [cx, cz, lx, lz, LA, LB].
 */
export function canopyFrame(o, roads) {
  let cx = 0, cz = 0;
  for (const q of o) { cx += q[0]; cz += q[1]; }
  cx /= o.length; cz /= o.length;
  let lx = 0, lz = 0, bestL = 0;
  for (const r of roads ?? []) {
    if (!r.d || !r.p || /^motorway/.test(r.t ?? '')) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const a = r.p[i], b = r.p[i + 1];
      const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
      // a segment whose middle or either end is under the roof
      if (!inRing(mx, mz, o) && !inRing(a[0], a[1], o) && !inRing(b[0], b[1], o)) continue;
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (L > bestL) { bestL = L; lx = (b[0] - a[0]) / L; lz = (b[1] - a[1]) / L; }
    }
  }
  if (!bestL) {
    for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
      const L = Math.hypot(o[i][0] - o[j][0], o[i][1] - o[j][1]);
      if (L > bestL) { bestL = L; lx = (o[i][0] - o[j][0]) / L; lz = (o[i][1] - o[j][1]) / L; }
    }
  }
  // a fixed sense, so the frame does not depend on which way a way was drawn
  if (lx < 0 || (lx === 0 && lz < 0)) { lx = -lx; lz = -lz; }
  const ax = -lz, az = lx;
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const q of o) {
    const a = (q[0] - cx) * lx + (q[1] - cz) * lz, b = (q[0] - cx) * ax + (q[1] - cz) * az;
    if (a < a0) a0 = a; if (a > a1) a1 = a;
    if (b < b0) b0 = b; if (b > b1) b1 = b;
  }
  const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
  const r1 = (v) => Math.round(v * 100) / 100;
  return [r1(cx + lx * ma + ax * mb), r1(cz + lz * ma + az * mb),
    Math.round(lx * 1e5) / 1e5, Math.round(lz * 1e5) / 1e5, r1((a1 - a0) / 2), r1((b1 - b0) / 2)];
}

function isRestPoi(x, z) {
  for (const r of REST) for (const side of ['E', 'W', 'S', 'N']) {
    const p = r[side]?.poi;
    if (p && Math.abs(p[0] - x) < 5 && Math.abs(p[1] - z) < 5) return true;
  }
  for (const s of SYNTH_FUEL) if (Math.abs(s.p[0] - x) < 5 && Math.abs(s.p[1] - z) < 5) return true;
  return false;
}

/**
 * Lift every fuel poi's mapped canopy (a t 'roof' building within CANOPY_R
 * of it) and frame the poi on it (poi.cv, poi.cr: the roof ring, a fresh
 * copy, for the fascia). Exported for the tests.
 */
export function liftCanopies(data) {
  const pois = data.pois, bs = data.buildings;
  if (!pois?.length || !bs?.length) return;
  // one pass for the fuel nodes, one for the roofs: a Prague tile has 60 000
  // buildings and a few dozen of each, and this runs on the tile's own frame
  let fuel = null, roofs = null;
  for (const poi of pois) if (poi.t === 'fuel' && poi.p && !poi.cv) (fuel ??= []).push(poi);
  if (!fuel) return;
  for (const b of bs) if (b.t === 'roof' && b.o && b.o.length >= 3) (roofs ??= []).push(b);
  if (!roofs) return;
  for (const poi of fuel) {
    const x = poi.p[0], z = poi.p[1];
    // a D11 station's node can sit at its shop, 20 to 30 m from the canopy
    // (Bříství westbound): there the table vouches for the match
    let best = null, bd = isRestPoi(x, z) ? CANOPY_FAR : CANOPY_R;
    for (const b of roofs) {
      // cheap reject on the first vertex: a canopy is tens of metres across
      if (Math.abs(b.o[0][0] - x) > 80 || Math.abs(b.o[0][1] - z) > 80) continue;
      const d = ringDist(x, z, b.o);
      if (d > bd) continue;
      const A = ringArea(b.o);
      if (A < CANOPY_MIN || A > CANOPY_MAX) continue;
      bd = d; best = b;
    }
    if (!best) continue;
    if (!(best.y > 0)) {
      best.y = CLEAR;
      best.h = CLEAR + SLAB;
    }
    poi.cv = canopyFrame(best.o, data.roads);
    poi.cr = best.o.map((q) => [q[0], q[1]]);
    poi.ch = best.y;
    poi.cd = best.h - best.y;
  }
}

// ---------------------------------------------------------------------------
// The sites, for the parking lots (lorries) and anything else that asks
// "is this a motorway services". One entry per carriageway side.

/** Parking-only bays with no fuel that lorries use. km 35.4 E (the survey's
 *  "km 35.9 R", data chainage): stall-row parking ways at exit 35's slips. */
export const TRUCK_PARKS = Object.freeze([
  Object.freeze({ id: 'vrbova-lhota-bay', side: 'E', p: Object.freeze([-49325, -9795]) }),
]);

let _sites = null;
/** Every services side as { id, name, side, x, z, fuel, food, trucks }. */
export function sites() {
  if (_sites) return _sites;
  const out = [];
  for (const r of REST) {
    for (const side of ['E', 'W', 'S', 'N']) {
      const s = r[side];
      if (!s) continue;
      let p = s.poi;
      if (!p) {
        const syn = SYNTH_FUEL.find((f) => f.site === r.id && f.side === side);
        if (syn) p = syn.p;
      }
      // `exact`: the point is the station itself (its poi, or the synthetic
      // pump). Failing both, the middle of the slip roads' diverge and merge
      // is good enough to tell a lot near the services (parkinglots.js), but
      // it lies on or beside the carriageway: never a place to stand someone
      const exact = !!p;
      if (!p && s.div && s.mer) p = [(s.div.x + s.mer.x) / 2, (s.div.z + s.mer.z) / 2];
      if (!p) continue;
      out.push(Object.freeze({ id: r.id, name: r.name, side, x: p[0], z: p[1],
        fuel: s.fuel, food: s.food, trucks: !!s.trucks, exact }));
    }
  }
  for (const t of TRUCK_PARKS) {
    out.push(Object.freeze({ id: t.id, name: 'Odpočívka', side: t.side, x: t.p[0], z: t.p[1],
      fuel: null, food: null, trucks: true, exact: true }));
  }
  _sites = Object.freeze(out);
  return _sites;
}

/** The services side nearest (x, z) within r metres, or null. */
export function siteNear(x, z, r = 250) {
  let best = null, bd = r * r;
  for (const s of sites()) {
    const d = (s.x - x) ** 2 + (s.z - z) ** 2;
    if (d <= bd) { bd = d; best = s; }
  }
  return best;
}
