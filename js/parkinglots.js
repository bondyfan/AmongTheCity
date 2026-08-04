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

import { CAR_COLORS } from './config.js';
import { strHash } from './identity.js';

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
function occAt(t01) {
  const h = (t01 ?? 0) * 24;
  for (let i = 0; i < OCC_HOURS.length - 1; i++) {
    const [h0, v0] = OCC_HOURS[i], [h1, v1] = OCC_HOURS[i + 1];
    if (h >= h0 && h <= h1) return v0 + (v1 - v0) * ((h - h0) / (h1 - h0 || 1));
  }
  return 0.5;
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
// nose/tail probe) inside the ring — cached on the feature, computed once
function stallsFor(lot) {
  if (lot._stalls) return lot._stalls;
  const ring = lot.o;
  let bx = 0, bz = 0, bl = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [cx, cz] = ring[(i + 1) % ring.length];
    const L = Math.hypot(cx - ax, cz - az);
    if (L > bl) { bl = L; bx = (cx - ax) / L; bz = (cz - az) / L; }
  }
  if (!bl) return (lot._stalls = []);
  const px = -bz, pz = bx;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const u = x * bx + z * bz, v = x * px + z * pz;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const out = [];
  const head = Math.atan2(px, pz);              // nose across the row
  for (let v = v0 + 3.2; v <= v1 - 3.2 && out.length < LOT_CAP; v += PITCH_ALONG) {
    for (let u = u0 + 2.0; u <= u1 - 2.0 && out.length < LOT_CAP; u += PITCH_ACROSS) {
      const x = bx * u + px * v, z = bz * u + pz * v;
      if (!inPoly(x, z, ring)) continue;
      if (!inPoly(x + px * 2.3, z + pz * 2.3, ring)) continue;
      if (!inPoly(x - px * 2.3, z - pz * 2.3, ring)) continue;
      out.push({ x, z, h: head + (rnd(x, z, 'j') - 0.5) * 0.1, car: null, burned: false });
    }
  }
  return (lot._stalls = out);
}

export class ParkingLots {
  constructor(city, vehicles, world, parked) {
    this.city = city;
    this.vehicles = vehicles;
    this.world = world;
    this.parked = parked;      // main's enterable-car array (shared reference)
    this._t = 0;
    this._count = 0;
    this._virgin = true;      // first sweep fills freely — it runs under the
                              // boot overlay's fade, before anyone can watch
  }

  update(dt, pos, t01) {
    this._t -= dt;
    if (this._t > 0) return;
    this._t = SCAN_DT;
    const occ = occAt(t01);
    const virgin = this._virgin;
    this._virgin = false;
    for (const lot of this.city.paved) {
      if (lot.t !== 'parking' || !lot.o?.length) continue;
      const [fx, fz] = lot.o[0];
      const d = Math.hypot(fx - pos.x, fz - pos.z);
      if (d > REACH + 150) { this._drain(lot, pos, true); continue; }
      if (d > REACH) continue;
      for (const st of stallsFor(lot)) {
        if (st.burned) continue;
        // a stall car somebody drove away never comes back this session
        if (st.car && !this.parked.includes(st.car)) { st.car = null; st.burned = true; continue; }
        const want = rnd(st.x, st.z, 'occ') < occ;
        if (want === !!st.car) continue;
        const dd = Math.hypot(st.x - pos.x, st.z - pos.z);
        if (!virgin && dd < NOTICE_R) continue;   // never on camera
        if (want) {
          if (this._count >= GLOBAL_CAP) continue;
          const kind = KINDS[(rnd(st.x, st.z, 'k') * KINDS.length) | 0];
          const color = CAR_COLORS[(rnd(st.x, st.z, 'c') * CAR_COLORS.length) | 0];
          st.car = this.vehicles.add(kind, st.x, st.z, st.h, color);
          st.car._lot = true;
          this.parked.push(st.car);
          this._count++;
        } else this._remove(st);
      }
    }
  }

  _remove(st) {
    const i = this.parked.indexOf(st.car);
    if (i >= 0) this.parked.splice(i, 1);
    this.vehicles.remove(st.car);
    st.car = null;
    this._count--;
  }

  // far past reach the lot gives its cars back (unless the player is somehow
  // still close — teleports exist), so the world's car count stays bounded
  _drain(lot, pos, far) {
    if (!lot._stalls) return;
    for (const st of lot._stalls) {
      if (!st.car) continue;
      if (!this.parked.includes(st.car)) { st.car = null; st.burned = true; continue; }
      if (far && Math.hypot(st.x - pos.x, st.z - pos.z) > NOTICE_R) this._remove(st);
    }
  }
}
