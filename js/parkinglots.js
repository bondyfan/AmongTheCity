// ---- parking lots that breathe with the clock ------------------------------
// Every amenity=parking polygon within reach grows deterministic stalls laid
// out in rows along its longest edge, and each stall's car comes and goes with
// the time of day: a residential lot is full at night and thins out through
// the working morning — the curve below is occupancy, not traffic.
//
// Determinism is the same discipline placeParkedCars() uses: everything is a
// pure function of the STALL's coordinates (strHash), so two clients agree on
// which car stands where without a word on the wire. Cars join the `parked`
// array, which makes them enterable, crashable and — via main's blocker list —
// solid for NPC traffic. A stolen stall car is simply forgotten: the space it
// left stays empty for the session, like the world noticed.
//
// Cars materialise and vanish only OUTSIDE noticeR of the player, so the lot
// never performs its magic on camera.

import { CAR_COLORS, CHUNK } from './config.js';
import { strHash } from './identity.js';
import { siteNear } from './d11services.js';
import { storeChain } from './stores/chains.js';

const KINDS = ['sedan', 'hatch', 'kombi', 'suv', 'van'];
const SCAN_DT = 2.5;          // s between lot sweeps
const REACH = 420;            // m — lots considered around the player
const NOTICE_R = 170;         // m — no stall changes closer than this
const LOT_CAP = 40;           // stalls per lot
const GLOBAL_CAP = 110;       // lot cars in the world at once
const PITCH_ACROSS = 2.75;    // stall width along the row
const PITCH_ALONG = 6.0;      // row spacing

// residential occupancy by hour — full nights, thin mid-mornings
const OCC_HOURS = [
  [0, 0.85], [5, 0.82], [7, 0.55], [9, 0.28], [13, 0.22],
  [16, 0.30], [18, 0.50], [20, 0.68], [22, 0.82], [24, 0.85],
];
export function occAt(t01) {
  const h = (t01 ?? 0) * 24;
  for (let i = 0; i < OCC_HOURS.length - 1; i++) {
    const [h0, v0] = OCC_HOURS[i], [h1, v1] = OCC_HOURS[i + 1];
    if (h >= h0 && h <= h1) return v0 + (v1 - v0) * ((h - h0) / (h1 - h0 || 1));
  }
  return 0.5;
}

// ---- motorway services (round 8) ----
// A lot within SERVICE_R of a D11 services side (js/d11services.js, the
// js/d11.js REST table plus the parking-only bay at exit 35) is not a village
// car park: its big lots (a long edge of LORRY_EDGE and LORRY_AREA of
// tarmac) are lorry parks, full at night when the drivers sleep in their cabs
// and half empty at midday, and its small ones fill with travellers through
// the day and empty at night. The tiles carry no hgv tag (the build dropped
// it; only the Bříství lot had one), so size and place decide. Everything is
// still hashed from stall coordinates: two clients park the same lorries.
const SERVICE_R = 200;        // m from the services' fuel poi (or the bay)
const LORRY_EDGE = 40;        // m: the long edge a row of lorries needs
const LORRY_AREA = 900;       // m^2
const LORRY_CAP = 16;         // stalls per lorry park
const LORRY_GLOBAL = 30;      // lorries in the world at once (they are big meshes)
const LORRY_ACROSS = 4.2;     // m between two lorries side by side
const LORRY_ALONG = 11.0;     // m row depth (a 7.6 m truck and its apron)
// The kind a parked lorry is: vehicles.js 'truck' (the cab-over box truck).
// When the round 8 TRAFFIC package's articulated 'semi' lands, this is the
// one line to change (the stall pitch above already fits an 8 m tractor).
export const LORRY_KIND = 'truck';
const LORRY_COLORS = [0xd8d5ce, 0xbcbfba, 0x8a9096, 0x476b46, 0x3a63a8, 0xd8d5ce];
// lorry park occupancy by hour: rest-time rules fill it from the evening
const LORRY_HOURS = [
  [0, 0.92], [4, 0.9], [6, 0.7], [9, 0.5], [12, 0.45], [15, 0.5],
  [18, 0.66], [20, 0.82], [22, 0.9], [24, 0.92],
];
// travellers' cars at a services: through the day, not the night
const SERVICE_HOURS = [
  [0, 0.18], [5, 0.15], [7, 0.35], [10, 0.5], [13, 0.62], [17, 0.58],
  [20, 0.38], [22, 0.25], [24, 0.18],
];
function curveAt(table, t01) {
  const h = (t01 ?? 0) * 24;
  for (let i = 0; i < table.length - 1; i++) {
    const [h0, v0] = table[i], [h1, v1] = table[i + 1];
    if (h >= h0 && h <= h1) return v0 + (v1 - v0) * ((h - h0) / (h1 - h0 || 1));
  }
  return 0.5;
}
export const lorryOccAt = (t01) => curveAt(LORRY_HOURS, t01);
export const serviceOccAt = (t01) => curveAt(SERVICE_HOURS, t01);
// A supermarket's car park is the opposite of a housing estate's: empty all
// night, filling from opening time, fullest after work (js/stores/). A lot is a
// shop's when a standalone chain store stands within SHOP_R of its middle.
const SHOP_HOURS = [
  [0, 0.03], [6, 0.04], [7, 0.2], [9, 0.45], [12, 0.55], [15, 0.6],
  [17.5, 0.85], [19, 0.6], [21, 0.15], [22, 0.05], [24, 0.03],
];
const SHOP_R = 75;
export const shopOccAt = (t01) => curveAt(SHOP_HOURS, t01);
/** Is there a chain store within SHOP_R of the middle of this ring? */
export function shopLot(city, ring) {
  const idx = city?.chunkIndex;
  if (!idx || !ring?.length) return false;
  let cx = 0, cz = 0;
  for (const q of ring) { cx += q[0]; cz += q[1]; }
  cx /= ring.length; cz /= ring.length;
  const c0 = Math.floor((cx - SHOP_R) / CHUNK), c1 = Math.floor((cx + SHOP_R) / CHUNK);
  const d0 = Math.floor((cz - SHOP_R) / CHUNK), d1 = Math.floor((cz + SHOP_R) / CHUNK);
  for (let x = c0; x <= c1; x++) for (let z = d0; z <= d1; z++) {
    for (const f of idx.get(x + ',' + z)?.buildings ?? []) {
      if (!f.n || !f.o?.length || !storeChain(f)) continue;
      for (const p of f.o) if (Math.hypot(p[0] - cx, p[1] - cz) < SHOP_R) return true;
    }
  }
  return false;
}

/**
 * What a lot is: 'lorry' (a services lorry park), 'service' (a services car
 * park) or 'town'. Pure, from its ring: centroid near a services side, then
 * its size. Exported for the tests.
 */
export function lotClass(ring) {
  if (!ring?.length) return 'town';
  let cx = 0, cz = 0;
  for (const q of ring) { cx += q[0]; cz += q[1]; }
  cx /= ring.length; cz /= ring.length;
  const site = siteNear(cx, cz, SERVICE_R);
  if (!site) return 'town';
  let edge = 0, a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    edge = Math.max(edge, Math.hypot(ring[i][0] - ring[j][0], ring[i][1] - ring[j][1]));
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return site.trucks && edge >= LORRY_EDGE && Math.abs(a) / 2 >= LORRY_AREA ? 'lorry' : 'service';
}
const _classOf = new Map();
function classOf(lot) {
  const k = lotKey(lot);
  let c = _classOf.get(k);
  if (!c) _classOf.set(k, c = lotClass(lot.o));
  return c;
}

function rnd(x, z, salt) {
  return strHash(salt + ':' + Math.round(x * 10) + ',' + Math.round(z * 10)) / 4294967296;
}

function inPoly(x, z, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// stalls for one lot: rows along the polygon's longest edge, centres (and a
// nose/tail probe) inside the ring, computed once.
//
// Cached BESIDE the feature, not on it. `lot._stalls` used to hang the list on
// the paved polygon itself, and a stall holds its car, and a car holds a
// three.js Group: js/chunkspec.js walks every feature of a cell to copy it to
// the mesh workers and refuses a cell with a class instance in it ("_stalls[]
// .car.mesh is a Group"), so every cell with a live car park in it silently
// built on the main thread instead. A Map keeps the live objects out of what
// the spec walks.
//
// Keyed by the lot's _id (slot-derived, geo.js IDS_PER_TILE), not by the
// object: a tile released far away and loaded again brings a NEW polygon with
// the same id, and the stall the player took a car from must still be empty.
// Entries with nothing to remember (no car standing, no stall burned) are
// dropped when the lot drains, so the map holds what matters, not every lot
// the session drove past. A fixture lot without an id is its own key.
const _stallsOf = new Map();
const lotKey = (lot) => lot._id ?? lot;
/** The stalls of a lot, as the cars are parked in them: [{ x, z, h }] (js/stores/lotpaint.js draws their lines). */
export const lotStalls = (lot) => stallsFor(lot);
/** How far apart two stalls of a row stand, and how deep a stall is. */
export const STALL = { across: PITCH_ACROSS, deep: 4.9 };
function stallsFor(lot) {
  const have = _stallsOf.get(lotKey(lot));
  if (have) return have;
  const ring = lot.o;
  let bx = 0, bz = 0, bl = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [cx, cz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(cx - ax, cz - az);
    if (L > bl) { bl = L; bx = (cx - ax) / L; bz = (cz - az) / L; }
  }
  if (!bl) { const none = []; _stallsOf.set(lotKey(lot), none); return none; }
  const px = -bz, pz = bx;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const u = x * bx + z * bz, v = x * px + z * pz;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const out = [];
  const head = Math.atan2(px, pz);              // nose across the row
  // a lorry park lays wider, deeper stalls (and probes a lorry's length)
  const lorry = classOf(lot) === 'lorry';
  const cap = lorry ? LORRY_CAP : LOT_CAP;
  const across = lorry ? LORRY_ACROSS : PITCH_ACROSS, along = lorry ? LORRY_ALONG : PITCH_ALONG;
  const end = lorry ? 5.6 : 3.2, side = lorry ? 2.6 : 2.0, probe = lorry ? 4.2 : 2.3;
  for (let v = v0 + end; v <= v1 - end && out.length < cap; v += along) {
    for (let u = u0 + side; u <= u1 - side && out.length < cap; u += across) {
      const x = bx * u + px * v, z = bz * u + pz * v;
      if (!inPoly(x, z, ring)) continue;
      if (!inPoly(x + px * probe, z + pz * probe, ring)) continue;
      if (!inPoly(x - px * probe, z - pz * probe, ring)) continue;
      out.push({ x, z, h: head + (rnd(x, z, 'j') - 0.5) * 0.1, car: null, burned: false });
    }
  }
  _stallsOf.set(lotKey(lot), out);
  return out;
}

// Car parks within `r` of (x, z): out of the chunk cells under that square
// (each lot once, in id order, so a capped sweep fills the same lots on every
// client), or the whole flat array for a fixture without a chunk index.
function lotsNear(city, x, z, r, seen, out) {
  out.length = 0;
  const idx = city.chunkIndex;
  if (!idx) {
    for (const lot of city.paved ?? []) if (lot.t === 'parking' && lot.o?.length) out.push(lot);
    return out;
  }
  seen.clear();
  const c0 = Math.floor((x - r) / CHUNK), c1 = Math.floor((x + r) / CHUNK);
  const d0 = Math.floor((z - r) / CHUNK), d1 = Math.floor((z + r) / CHUNK);
  for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
    const a = idx.get(cx + ',' + cz)?.paved;
    if (!a) continue;
    for (let i = 0; i < a.length; i++) {
      const lot = a[i];
      if (lot.t !== 'parking' || !lot.o?.length || seen.has(lot)) continue;
      seen.add(lot);
      out.push(lot);
    }
  }
  out.sort((a, b) => (a._id ?? 0) - (b._id ?? 0));
  return out;
}

// A car is about this long and this wide (plus a hand): another one whose
// centre is nearer than that, measured in the first one's own frame, is
// standing in the same space.
const SPACE_ALONG = 4.8, SPACE_ACROSS = 2.0;

/**
 * Does something standing at (x, z) take up the space of a stall, or of a
 * parked car, at (sx, sz) facing game heading `h`? An oriented box and not a
 * radius: the next stall in the row is 2.75 m to the side and the next one
 * along a kerb 6.3 m ahead, and neither of those is "the same space".
 *
 * `h2` is the heading of the thing at (x, z), when it is known: a car left
 * ACROSS a row of stalls, or askew over two of them, reaches further sideways
 * than one parked straight, and its centre alone missed the stall its nose was
 * in (measured on the real car parks: a neighbour arrived through the owned
 * car in 4 of 14 crosswise parks). Two boxes of half that size each, tested on
 * both their axes; with the same heading it is the single box described above.
 */
export function standsIn(x, z, sx, sz, h, h2 = h) {
  const dx = x - sx, dz = z - sz, s = Math.sin(h), c = Math.cos(h);
  const s2 = Math.sin(h2), c2 = Math.cos(h2);
  const ca = Math.abs(s * s2 + c * c2), sa = Math.abs(s * c2 - c * s2);   // the angle between them
  const along = (SPACE_ALONG * (1 + ca) + SPACE_ACROSS * sa) / 2;
  const across = (SPACE_ACROSS * (1 + ca) + SPACE_ALONG * sa) / 2;
  return Math.abs(dx * s + dz * c) < along && Math.abs(dx * c - dz * s) < across
    && Math.abs(dx * s2 + dz * c2) < along && Math.abs(dx * c2 - dz * s2) < across;
}

/** The car the player has BOUGHT (js/garage.js sets `owned`), if it is standing parked. */
export function ownedIn(parked) {
  for (let i = 0; i < parked.length; i++) if (parked[i].owned) return parked[i];
  return null;
}

export class ParkingLots {
  constructor(city, vehicles, world, parked) {
    this.city = city;
    this.vehicles = vehicles;
    this.world = world;
    this.parked = parked;      // main's enterable-car array (shared reference)
    this._shop = new Map();    // lot key -> is it a chain store's car park
    this._t = 0;
    this._count = 0;
    this._virgin = true;      // first sweep fills freely — it runs under the
                              // boot overlay's fade, before anyone can watch
    this._lorries = 0;        // of _count, how many are lorries (LORRY_GLOBAL)
    this._live = new Set();   // lots that may have cars standing (to drain)
    this._near = [];          // scratch: the lots of this sweep
    this._seen = new Set();
  }

  update(dt, pos, t01, reserved = null) {
    this._t -= dt;
    if (this._t > 0) return;
    this._t = SCAN_DT;
    const occTown = occAt(t01), occLorry = lorryOccAt(t01), occSvc = serviceOccAt(t01), occShop = shopOccAt(t01);
    const virgin = this._virgin;
    this._virgin = false;
    const owned = ownedIn(this.parked);
    // a lot that held cars and is now far past reach gives them back
    for (const lot of this._live) {
      const [fx, fz] = lot.o[0];
      if (Math.hypot(fx - pos.x, fz - pos.z) <= REACH + 150) continue;
      this._drain(lot, pos, true);
      if (!this._holds(lot)) this._live.delete(lot);
    }
    for (const lot of lotsNear(this.city, pos.x, pos.z, REACH + CHUNK, this._seen, this._near)) {
      const [fx, fz] = lot.o[0];
      const d = Math.hypot(fx - pos.x, fz - pos.z);
      if (d > REACH + 150) { this._drain(lot, pos, true); continue; }
      if (d > REACH) continue;
      this._live.add(lot);
      const cls = classOf(lot), lorry = cls === 'lorry';
      let occ = lorry ? occLorry : cls === 'service' ? occSvc : occTown;
      if (cls === 'town') {
        // a supermarket's own car park: full by day, empty by night
        const k = lotKey(lot);
        let shop = this._shop.get(k);
        if (shop === undefined) this._shop.set(k, shop = shopLot(this.city, lot.o));
        if (shop) occ = occShop;
      }
      for (const st of stallsFor(lot)) {
        if (st.burned) continue;
        // a stall car somebody drove away never comes back this session, and
        // one the player has paid for is off the books the same way: it stays
        // in `parked` (it has not moved), so without the second test the lot
        // went on tidying it away with its own
        if (st.car && (st.car.owned || !this.parked.includes(st.car))) { st.car = null; st.burned = true; continue; }
        const want = rnd(st.x, st.z, 'occ') < occ;
        if (want === !!st.car) continue;
        const dd = Math.hypot(st.x - pos.x, st.z - pos.z);
        if (!virgin && dd < NOTICE_R) continue;   // never on camera
        if (want) {
          // Leave both door approaches free during the station handover.
          if (reserved && Math.hypot(st.x - reserved.x, st.z - reserved.z) < 5) continue;
          if (this._count >= GLOBAL_CAP) continue;
          if (lorry && this._lorries >= LORRY_GLOBAL) continue;
          // the player's own car is standing here (left where it was bought,
          // or parked in a space that was free): nothing arrives on top of it
          if (owned && standsIn(owned.x, owned.z, st.x, st.z, st.h, owned.heading)) { st.burned = true; continue; }
          const kind = lorry ? LORRY_KIND : KINDS[(rnd(st.x, st.z, 'k') * KINDS.length) | 0];
          const color = lorry ? LORRY_COLORS[(rnd(st.x, st.z, 'c') * LORRY_COLORS.length) | 0]
            : CAR_COLORS[(rnd(st.x, st.z, 'c') * CAR_COLORS.length) | 0];
          st.car = this.vehicles.add(kind, st.x, st.z, st.h, color);
          st.car._lot = true;
          if (lorry) { st.car._lorry = true; this._lorries++; }
          this.parked.push(st.car);
          this._count++;
        } else this._remove(st);
      }
    }
  }

  _remove(st) {
    const i = this.parked.indexOf(st.car);
    if (i >= 0) this.parked.splice(i, 1);
    if (st.car._lorry) this._lorries--;
    this.vehicles.remove(st.car);
    st.car = null;
    this._count--;
  }

  // far past reach the lot gives its cars back (unless the player is somehow
  // still close — teleports exist), so the world's car count stays bounded
  _drain(lot, pos, far) {
    const stalls = _stallsOf.get(lotKey(lot));
    if (!stalls) return;
    let keep = false;
    for (const st of stalls) {
      if (st.car) {
        if (st.car.owned || !this.parked.includes(st.car)) { st.car = null; st.burned = true; }
        else if (far && Math.hypot(st.x - pos.x, st.z - pos.z) > NOTICE_R) this._remove(st);
      }
      if (st.car || st.burned) keep = true;
    }
    // nothing standing and nothing to remember: the stalls are recomputed
    // (identically, they are a pure function of the ring) if it comes back
    if (!keep) _stallsOf.delete(lotKey(lot));
  }

  // does any stall of this lot still hold a car?
  _holds(lot) {
    const stalls = _stallsOf.get(lotKey(lot));
    if (stalls) for (const st of stalls) if (st.car) return true;
    return false;
  }
}
