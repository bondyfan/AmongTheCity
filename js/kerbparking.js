// ---- cars parked along the kerb -------------------------------------------------
// A Czech residential street is a row of parked cars with a road down the
// middle, and ours were bare: cars stood in car parks and nowhere else. This
// module parks them along the kerbs of residential streets, the way they are
// parked on a street 5.5 m wide: two wheels up on the pavement, the other two
// in the gutter, nose in the direction of travel.
//
// WHERE. js/streets.js already knows every kerb in town (the verge of each way,
// station by station), so "is there room" is asked of it and not re-derived: a
// stall needs a kerbed verge with no dropped kerb (a crossing or a driveway),
// outside every junction mouth, clear of bus lay-bys, zebras, stops, mapped
// footways, trees and street furniture. One side of a street only, chosen by
// hash, so the carriageway keeps a lane and a half.
//
// WHEN. Occupancy breathes with the same curve js/parkinglots.js uses: full at
// night, thin through the working day. Which stall holds which car is a pure
// function of the stall's coordinates, so two clients park the same Škoda in
// the same place without a word on the wire.
//
// WHAT THE MAP SAYS. Since round 5 a road may carry `pk`, OSM's on-street
// parking tags for each side (docs/TILE-FORMAT.md). js/kerbrows.js turns a
// street into its ROWS: the one hashed, parallel, half-on-kerb row of a street
// nobody tagged (exactly the row it always had), or what the tags say, side by
// side: none where a sign forbids it, parallel, diagonal or square to the kerb
// where it is allowed, in the lane, half on the kerb or up on it. Only a
// handful of streets round Pardubice are tagged; Prague, Olomouc and Hradec
// Králové are, by the thousand.
//
// The cars are ordinary vehicles in main.js's `parked` list: enterable,
// crashable, stealable. One somebody drove away never comes back this session.
// Nothing is hung on the road features themselves (stalls live in a WeakMap):
// js/chunkspec.js copies features to the mesh workers and refuses anything
// with a live object on it.

import { pickCarColor } from './vehicles.js';
import { laneSide } from './regions.js';
const SIDE = laneSide();   // +1 keep right, -1 keep left (Mahé)
import { strHash } from './identity.js';
import { streetOf } from './geo.js';
import { vergeAt, inZone, KERB_H } from './streets.js';
import { obstructed, footprintBlocked } from './kerbclear.js';
import { occAt, standsIn, ownedIn } from './parkinglots.js';
import { kerbRows, rowPlace, rowNose, kerbPose, procSide, ROLL, ON_KERB, PARALLEL } from './kerbrows.js';

export { KERB_INTRUDES } from './kerbrows.js';

const ROADSTER_STALLS = 1 / 500;
const KINDS = ['octaviaCombi', 'fabia', 'fabia', 'octavia', 'bmw', 'mercedes', 'tesla', 'octaviaCombi', 'van'];
const CH = 120;                 // chunk size (config.CHUNK)
const PITCH = 6.3;              // m between stall centres: a car and a gap to get out of
const CAR_HALF = 2.4;           // m of kerb a stall needs either side of its centre
const END_CLEAR = 10;           // m a stall keeps from a junction mouth or the end of the way
const BAY_CLEAR = 22;           // m either side of a bus lay-by
const FILL = 0.8;               // share of the occupancy curve the kerb gets
const REACH = 250;              // m round the player streets are parked
const NOTICE_R = 125;           // m: no car arrives or leaves closer than this
const POLE_CLEAR = 2.6;         // m from a stall's centre a lamp, sign or signal post may not stand
const CAP = 44;                 // kerb cars in the world at once
const SCAN_DT = 2.0;
const ROADS_PER_SCAN = 5;       // streets surveyed per pass (the survey is the cost)

const rnd = (x, z, salt) => strHash(salt + ':' + Math.round(x * 10) + ',' + Math.round(z * 10)) / 4294967296;

/** Is this a street people park along (by the map's own word, or by the look of it)? */
export function parkable(r) {
  return kerbRows(r).length > 0;
}

/**
 * Which side of a street the cars stand on: +1 or -1 (streets.js's `e`). With
 * rows on both sides it is the one the traffic gives way to (see kerbrows.js).
 */
export function kerbSideOf(r) {
  const rows = kerbRows(r);
  return rows.length ? rows[0].e : procSide(r);
}

/**
 * The OTHER kerb of a street parked on both sides, when its cars stand partly
 * on the carriageway: streets.js `e`, or 0. The traffic moves over for the
 * first row only (kerbSideOf); this one is fitted beside the widest vehicle in
 * its lane, but not beside a bicycle ridden at the kerb edge (js/cyclenet.js).
 */
export function secondKerbOf(r) {
  const rows = kerbRows(r);
  if (rows.length < 2) return 0;
  const P = rowPlace(r, rows[1], rows);
  return P.c < P.across ? rows[1].e : 0;
}

const _nose = { x: 0, z: 0 };
/** The stalls of one row of a street, appended to `out` (see kerbStalls). */
function rowStalls(city, r, row, rows, near, out) {
  // A procedural row is placed by the constants it always was (P stays null and
  // every number below is the one it was before the tags existed).
  const P = row.tagged ? { ...rowPlace(r, row, rows), orient: row.orient } : null;
  const e = row.e, side = e > 0 ? 1 : 0;
  const hw = r.w / 2, len = r._len;
  const pitch = P ? P.pitch : PITCH, half = P ? P.along : CAR_HALF;
  const from = out.length;
  let seg = 0, acc = 0;
  let L = Math.hypot(r.p[1][0] - r.p[0][0], r.p[1][1] - r.p[0][1]) || 1e-6;
  // (the second row of a street starts on a beat of its own, or the two
  // kerbs would mirror each other car for car)
  const j0 = rnd(r.p[0][0], r.p[0][1], row.primary ? 'kj' : 'kj2') * 3;
  for (let s = END_CLEAR + half + j0; s < len - END_CLEAR - half; s += pitch) {
    while (s > acc + L && seg < r.p.length - 2) {
      acc += L; seg++;
      L = Math.hypot(r.p[seg + 1][0] - r.p[seg][0], r.p[seg + 1][1] - r.p[seg][1]) || 1e-6;
    }
    const t = Math.max(0, Math.min(1, (s - acc) / L));
    const dx = (r.p[seg + 1][0] - r.p[seg][0]) / L, dz = (r.p[seg + 1][1] - r.p[seg][1]) / L;
    // not on a bend: the car is a straight thing and the kerb there is not
    if (L * Math.min(t, 1 - t) < half && seg > 0 && seg < r.p.length - 2) continue;
    let ok = true;
    for (const k of [-half, 0, half]) {
      const v = vergeAt(r, s + k, side);
      if (!v.u || v.drop > 0.02) { ok = false; break; }
      // room on the verge for the part of the car that stands on it. Two
      // wheels up fit any pavement; more than that needs a strip of its own
      // between the kerb and the mapped footway (which is exactly where a real
      // parking bay lies), or, for a car square to the kerb, ground nobody
      // mapped anything on (footprintBlocked asks what stands there).
      if (!P || P.need <= 1) { if (v.w < 1.2 && (!P || P.need > 0.05)) { ok = false; break; } }
      else if (!v.t || (v.t === 2 ? v.w - 1.2 < P.need : P.orient === PARALLEL)) { ok = false; break; }
    }
    if (!ok) continue;
    // outside every junction mouth, with room to turn in and out of them
    for (const k of [-END_CLEAR, -half, 0, half, END_CLEAR]) if (inZone(r, s + k)) { ok = false; break; }
    if (!ok) continue;
    const b = r._bays;
    if (b) for (let i = 0; i < b.length; i += 2) if (Math.abs(b[i] - s) < BAY_CLEAR) { ok = false; break; }
    if (!ok) continue;
    const px = dz * e, pz = -dx * e;                    // toward this kerb
    const kx = r.p[seg][0] + (r.p[seg + 1][0] - r.p[seg][0]) * t + px * hw;   // the kerb line here
    const kz = r.p[seg][1] + (r.p[seg + 1][1] - r.p[seg][1]) * t + pz * hw;
    if (!P) {
      const x = r.p[seg][0] + (r.p[seg + 1][0] - r.p[seg][0]) * t + px * (hw - ON_KERB);
      const z = r.p[seg][1] + (r.p[seg + 1][1] - r.p[seg][1]) * t + pz * (hw - ON_KERB);
      if (obstructed(city, r, x, z, dx, dz) || (near && near(x, z))) continue;
      // Traffic on the e = -1 side runs WITH the way (its right is (-dz, dx)), on
      // the other side against it; a one-way street runs with it on both. The
      // kerb is on the car's right whenever the car faces the way its side flows.
      // (where traffic keeps left, js/regions.js, the whole rule is mirrored:
      // e' is the side as the mirror sees it, and the kerb lands on the left)
      const e2 = e * SIDE;
      const fwd = e2 < 0 || !!r.ow;
      const h = fwd ? Math.atan2(-dx, -dz) : Math.atan2(dx, dz);
      const kerbRight = (fwd ? e2 < 0 : true) === (SIDE > 0);
      out.push({ x, z, h: h + (rnd(x, z, 'kh') - 0.5) * 0.05, roll: kerbRight ? ROLL : -ROLL, s, car: null, burned: false });
      continue;
    }
    const x = kx + px * P.c, z = kz + pz * P.c;
    const f = rowNose(r, row, dx, dz, px, pz, _nose), fx = f.x, fz = f.z;
    if (near && near(x, z)) continue;
    if (footprintBlocked(city, r, x, z, fx, fz, dx, dz, P)) continue;
    const pose = kerbPose(fx, fz, px, pz, P.c);
    out.push({ x, z, h: Math.atan2(-fx, -fz) + (rnd(x, z, 'kh') - 0.5) * 0.05, roll: pose.roll, s, car: null, burned: false,
      // placed by the tags: how high over the deck (asked 0.6 m inside the kerb
      // line, at dx, dz), the nose up or down, and the far end of the car, whose
      // ground is checked before anything is parked on it
      tag: row.orient, lift: pose.lift, pitch: pose.pitch, dx: kx - px * 0.6, dz: kz - pz * 0.6,
      ex: P.need > 1.2 ? kx + px * (P.need - 0.3) : x, ez: P.need > 1.2 ? kz + pz * (P.need - 0.3) : z });
  }
  // A row mapped square or slanted to the kerb that found almost nowhere to
  // stand (a footway hard against the kerb, houses on the pavement's edge)
  // stands parallel instead: the street is still one people park along.
  if (P && P.orient !== PARALLEL && out.length - from < 3 && !row.flat) {
    const flat = { ...row, orient: PARALLEL, pos: 0, place: null, flat: true };
    const alt = rowStalls(city, r, flat, rows, near, []);
    if (alt.length > out.length - from) { out.length = from; for (const st of alt) out.push(st); }
  }
  return out;
}

/**
 * The stalls of one street: [{ x, z, h, roll, s }], nose in the direction of
 * travel on that side, `roll` the lean two wheels on the kerb give the car
 * (positive lifts its right flank). Pure in the data: the way, its tags, its
 * verge (js/streets.js) and what the chunk index holds round it. `near(x, z)`
 * is an optional extra veto (a bus stop, say). A stall of a TAGGED row also
 * carries `tag` (its orientation), `lift` and `pitch`.
 */
export function kerbStalls(city, r, near = null) {
  const rows = kerbRows(r);
  if (!rows.length || !streetOf(r)) return [];
  const out = [];
  for (const row of rows) rowStalls(city, r, row, rows, near, out);
  return out;
}

export class KerbParking {
  /** `veto(x, z)`: optional, true where no car may stand (a bus stop). */
  constructor(city, vehicles, world, parked, veto = null) {
    this.city = city;
    this.vehicles = vehicles;
    this.world = world;
    this.parked = parked;        // main's enterable-car array (shared reference)
    this.veto = veto;
    this._stalls = new WeakMap(); // way -> stalls (NOT on the way: see the header)
    // A far tile gives its ways back (geo.js RELEASE_DATA) and brings new
    // objects with the same ids when it returns, so the stalls are worked out
    // again; which of them were BURNED (a car driven away, a pole in the
    // space) is remembered by way id meanwhile, or the street would fill up
    // again on the next visit and two co-op clients would disagree about it.
    this._burnt = new Map();      // way _id -> indices of its burned stalls
    city.onTileReleased?.((t) => this.releaseTile(t));
    this._roads = new Set();      // ways with a car on them, for the drain
    this._t = 0;
    this._count = 0;
    this._virgin = true;         // the first pass fills freely, under the boot overlay
    this._owned = null;          // the player's own car while it stands parked (per pass)
  }

  /** Which side of this street has cars along it (streets.js `e`), or 0. */
  sideOf(r) {
    const st = this._stalls.get(r);
    return st && st.length ? kerbSideOf(r) : 0;
  }

  /** May this tagged stall be parked on: is the ground under the far end of the car level with the street? (null: not known yet) */
  _level(st) {
    const T = this.world?.terrain;
    if (!T?.heightAt || (st.ex === st.x && st.ez === st.z)) return true;
    // (the far end in a terrain tile not loaded yet: ask again later, never
    // burn the stall on a guess, or two clients would disagree for good)
    if (T.ready && (!T.ready(st.ex, st.ez) || !T.ready(st.dx, st.dz))) return null;
    return Math.abs(T.heightAt(st.ex, st.ez) - T.heightAt(st.dx, st.dz)) < 0.45;
  }

  update(dt, pos, t01) {
    this._t -= dt;
    if (this._t > 0) return;
    this._t = SCAN_DT;
    const occ = occAt(t01) * FILL;
    const virgin = this._virgin;
    this._virgin = false;
    let budget = virgin ? 40 : ROADS_PER_SCAN;
    this._owned = ownedIn(this.parked);
    const seen = new Set();
    for (let ci = Math.floor((pos.x - REACH) / CH); ci <= Math.floor((pos.x + REACH) / CH); ci++) {
      for (let cj = Math.floor((pos.z - REACH) / CH); cj <= Math.floor((pos.z + REACH) / CH); cj++) {
        const cell = this.city.chunkIndex?.get(ci + ',' + cj);
        if (!cell) continue;
        for (const r of cell.roads) {
          if (seen.has(r) || !parkable(r)) continue;
          seen.add(r);
          let stalls = this._stalls.get(r);
          if (!stalls) {
            if (budget-- <= 0) continue;
            this._stalls.set(r, stalls = kerbStalls(this.city, r, this.veto));
            const was = this._burnt.get(r._id);
            if (was) { for (const i of was) if (stalls[i]) stalls[i].burned = true; this._burnt.delete(r._id); }
          }
          for (const st of stalls) this._tend(r, st, pos, occ, virgin);
        }
      }
    }
    // streets the player has left give their cars back
    for (const r of this._roads) {
      if (seen.has(r)) continue;
      let any = false;
      for (const st of this._stalls.get(r) ?? []) {
        if (!st.car) continue;
        if (st.car.owned || !this.parked.includes(st.car)) { st.car = null; st.burned = true; this._count--; continue; }
        if (Math.hypot(st.x - pos.x, st.z - pos.z) > REACH + 60) this._remove(st); else any = true;
      }
      if (!any) this._roads.delete(r);
    }
  }

  /** A released tile's ways: remember their burned stalls by id, forget the rest. */
  releaseTile(t) {
    for (const r of t.roads ?? []) {
      const stalls = this._stalls.get(r);
      if (!stalls) continue;
      const burnt = [];
      for (let i = 0; i < stalls.length; i++) {
        const st = stalls[i];
        // (as the drain in update does: a car somebody took or bought is the
        // stall's no longer and burns it, one still standing goes with its
        // street, which is this far from the player only on a teleport)
        if (st.car) {
          if (st.car.owned || !this.parked.includes(st.car)) { st.car = null; st.burned = true; this._count--; }
          else this._remove(st);
        }
        if (st.burned) burnt.push(i);
      }
      if (burnt.length && r._id !== undefined) this._burnt.set(r._id, burnt);
      this._stalls.delete(r);
      this._roads.delete(r);
    }
  }

  _tend(r, st, pos, occ, virgin) {
    if (st.burned) return;
    // a stall car somebody drove away never comes back this session, and one
    // the player has BOUGHT leaves the books the same way (it is still in
    // `parked`, standing right here, and must not be given back with the street)
    if (st.car && (st.car.owned || !this.parked.includes(st.car))) { st.car = null; st.burned = true; this._count--; return; }
    const d = Math.hypot(st.x - pos.x, st.z - pos.z);
    // A car that took its stall before the chunk round it was built could not
    // know a lamp column or a sign post stands there (they exist once the mesh
    // does). It gives the stall up as soon as that is known, while it is still
    // too far off to be seen going.
    if (st.car && d >= NOTICE_R && this.world?.poles?.near(st.x, st.z, POLE_CLEAR).length) {
      this._remove(st); st.burned = true; return;
    }
    const want = d <= REACH && rnd(st.x, st.z, 'kocc') < occ;
    if (want === !!st.car) return;
    if (!virgin && d < NOTICE_R) return;                // never on camera
    if (!want) { this._remove(st); return; }
    if (this._count >= CAP) return;
    const T = this.world?.terrain;
    if (T?.ready && !T.ready(st.x, st.z)) return;       // no ground under it yet
    // a lamp or a signal mast standing in the stall (only known once the chunk is built)
    if (this.world?.poles?.near(st.x, st.z, POLE_CLEAR).length) { st.burned = true; return; }
    // the player's own car is standing in this space: nothing arrives on top of it
    const own = this._owned;
    if (own && standsIn(own.x, own.z, st.x, st.z, st.h, own.heading)) { st.burned = true; return; }
    // one stall in ROADSTER_STALLS holds the Roadster, and its owner left it open
    const rare = rnd(st.x, st.z, 'krare') < ROADSTER_STALLS;
    const kind = rare ? 'roadster' : KINDS[(rnd(st.x, st.z, 'kk') * KINDS.length) | 0];
    const color = pickCarColor(kind, rnd(st.x, st.z, 'kc'));
    // (a stall the tags put across the verge, on a bank or in a ditch: never)
    if (st.tag) {
      const lv = this._level(st);
      if (lv === null) return;
      if (!lv) { st.burned = true; return; }
    }
    const car = this.vehicles.add(kind, st.x, st.z, st.h, color);
    if (rare) car.unlocked = true;                       // (js/carlocks.js unlock)
    if (st.tag) {
      // placed by the tags: on the road, on the verge or across the kerb, and
      // the deck is asked where the carriageway certainly is
      const deck = this.world?.surfaceY ? this.world.surfaceY(st.dx, st.dz).y : car.y;
      car.y = deck + st.lift; car._gr = st.roll; car._gp = st.pitch;
    } else {
      // two wheels on the pavement: half a kerb up, and leaning on it
      car.y += KERB_H / 2; car._gr = st.roll;
    }
    car._grounded = true;
    car.mesh?.position?.set?.(car.x, car.y, car.z);
    car._kerb = st;
    st.car = car;
    this.parked.push(car);
    this._roads.add(r);
    this._count++;
  }

  _remove(st) {
    const i = this.parked.indexOf(st.car);
    if (i >= 0) this.parked.splice(i, 1);
    this.vehicles.remove(st.car);
    st.car = null;
    this._count--;
  }
}

/** Is this parked car still standing in its kerb stall (not driven, not shunted)? */
export function inKerbStall(car) {
  const st = car?._kerb;
  return !!st && Math.abs(car.x - st.x) < 0.6 && Math.abs(car.z - st.z) < 0.6;
}
