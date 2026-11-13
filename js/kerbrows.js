// ---- kerbrows.js: which kerbs of a street have cars along them, and how they stand ----
// js/kerbparking.js parks cars along kerbs. This module answers the question
// before that one: WHICH side or sides of a street, facing which way, and how
// far up the kerb. Pure data and arithmetic: a road feature in, rows out.
//
// TWO SOURCES. A street the map says nothing about gets the procedural row it
// always had: residential, 5 to 8 m wide, one side chosen by hash, parallel,
// two wheels on the pavement. A street carrying `pk` (round 5 tiles,
// docs/TILE-FORMAT.md: one code for each side) is taken at its word, side by
// side: a no parking or no stopping sign means no row there, a side whose cars
// stand in a car park of their own (already drawn as one) gets none either, an
// allowed side gets a row in the mapped orientation, and a side with nothing
// mapped keeps the procedural answer unless the other side was mapped as THE
// parking side.
//
// HOW FAR UP THE KERB is the one thing the tag cannot simply dictate. A road's
// `w` is its driving width: where OSM maps a parking lane, the real street is
// wider than what the game draws by exactly that lane. So a car is put as far
// onto the carriageway as the mapped position asks (lane, half on kerb, on
// kerb) but never further than the traffic leaves free, and the rest of it
// stands on the verge. js/traffic.js gives way to ONE side of a street
// (traffic.kerbOf), by KERB_INTRUDES; that side is the row called `primary`.
// Any other row must fit in what a bus, the widest thing on the road, leaves
// beside itself without being asked.

import { TRAFFIC } from './config.js';
import { strHash } from './identity.js';
import { KERB_H } from './streets.js';
import { parkSide, parkAllowed, parkOrient, parkPosition, PARK_NONE } from './tiledata.js';

export const KERB_INTRUDES = 0.95;   // m of carriageway a kerb-parked car takes
export const ON_KERB = 0.05;         // m the procedural car's centreline sits inside the kerb line
export const ROLL = Math.atan2(KERB_H, 1.55);   // two wheels 12 cm up
export const PARALLEL = 1, DIAGONAL = 2, PERPENDICULAR = 3;
const POS_HALF = 3, POS_KERB = 4;    // (1 lane, 2 street_side and 5 shoulder: all "on the road")
const CAR_L = 4.8, CAR_W = 1.9;      // the biggest thing that parks here (a van)
const TRACK = 1.55, BASE = 2.6;      // wheel track and wheelbase
const DIAG = 50 * Math.PI / 180;     // a herringbone bay, against the kerb
const BUS_HALF = 1.275;
const GAP = 0.3;                     // m of air between a passing flank and a parked one

/** A street people park along when no tag says otherwise (the rule since wave 2). */
export function procParkable(r) {
  return !!r && r.d === 1 && !r.br && !r.l && !r.rb
    && (r.t === 'residential' || r.t === 'unclassified')
    && r.w >= 5 && r.w <= 8 && r._len >= 46 && r.p && r.p.length >= 2;
}

/** The hashed side of a street: +1 or -1 (streets.js's `e`; -1 is the right of the way's direction). */
export function procSide(r) {
  const a = r.p[0], b = r.p[r.p.length - 1];
  return (strHash('kerb:' + Math.round(a[0] * 10) + ',' + Math.round(a[1] * 10) + ','
    + Math.round(b[0] * 10) + ',' + Math.round(b[1] * 10)) & 1) ? 1 : -1;
}

// A tagged side is believed on any drivable street at ground level: a mapper
// who wrote "parallel, in the lane" on a tertiary road meant it. (Whether a
// car then FITS is the verge's business, in kerbparking.js.)
function tagParkable(r) {
  return r.d === 1 && !r.br && !r.l && !r.rb && r.w >= 4.5 && r._len >= 30 && !!r.p && r.p.length >= 2;
}

const procRow = (e) => ({ e, orient: PARALLEL, pos: POS_HALF, tagged: false, primary: true, place: null });
const NONE = Object.freeze([]);
// (a WeakMap, not a field on the way: js/chunkspec.js copies road features to
// the mesh workers and nothing of ours belongs in that message)
const _rows = new WeakMap();

/**
 * The rows of parked cars a street has: [] or one or two of
 *   { e, orient, pos, tagged, primary }
 * `e` is streets.js's side sign (-1: right of the way's direction, +1: left),
 * `orient` PARALLEL / DIAGONAL / PERPENDICULAR, `pos` the tile's position code
 * (js/tiledata.js PARK_POSITION), `tagged` false for the procedural row.
 * The primary row, the one the traffic keeps off, comes first.
 */
export function kerbRows(r) {
  if (!r || !r.p) return NONE;
  let rows = _rows.get(r);
  if (rows) return rows;
  rows = [];
  if (!r.pk) {
    if (procParkable(r)) rows.push(procRow(procSide(r)));
  } else {
    // pk is [left, right] of the stored direction; the right is e = -1
    const R = parkSide(r, 1) | 0, L = parkSide(r, 0) | 0;
    const any = parkAllowed(R) || parkAllowed(L), ok = tagParkable(r);
    for (const [code, e] of [[R, -1], [L, 1]]) {
      if (parkAllowed(code)) {
        if (ok) rows.push({ e, orient: parkOrient(code) || PARALLEL, pos: parkPosition(code), tagged: true, primary: false, place: null });
      } else if (code === PARK_NONE && !any && procParkable(r) && procSide(r) === e) rows.push(procRow(e));
    }
    // The traffic gives way to one side only, and on a one-way street that can
    // only be its right (nothing drives the other way to give way to the left).
    if (rows.length === 2) {
      const want = r.ow ? -1 : procSide(r);
      if (rows[1].e === want) rows.reverse();
      rows[0].primary = true; rows[1].primary = false;
    } else if (rows.length === 1 && rows[0].tagged) rows[0].primary = !r.ow || rows[0].e < 0;
  }
  // (a way not yet measured is asked again: its length decides)
  if (r._len !== undefined) _rows.set(r, rows);
  return rows;
}

/**
 * How the cars of a tagged row stand, in metres:
 *   across, along   half the car's extent across and along the kerb
 *   pitch           stall spacing along the kerb
 *   c               the car's centre, measured OUT from the kerb line (negative: on the carriageway)
 *   need            how deep the car reaches onto the verge
 */
export function rowPlace(r, row, rows = kerbRows(r)) {
  if (row.place) return row.place;
  const hw = r.w / 2, o = row.orient;
  const sin = Math.sin(DIAG), cos = Math.cos(DIAG);
  const across = o === PARALLEL ? CAR_W / 2 : o === PERPENDICULAR ? CAR_L / 2 : (CAR_L * sin + CAR_W * cos) / 2;
  const along = o === PARALLEL ? 2.4 : o === PERPENDICULAR ? 1.25 : (CAR_L * cos + CAR_W * sin) / 2 + 0.2;
  const pitch = o === PARALLEL ? 6.3 : o === PERPENDICULAR ? 2.7 : (CAR_W + 0.7) / sin;
  // Where the widest vehicle's flank runs, measured from the centreline toward
  // its own right-hand kerb (the lane offset rule of js/traffic.js), and where
  // it runs once it has moved over for a primary row on that kerb.
  const lane = Math.min(TRAFFIC.laneOffsetK * r.w, TRAFFIC.laneOffsetMax);
  const flank = Math.min(lane + BUS_HALF, hw - 0.5);
  let room;
  if (r.ow && row.e > 0) {
    // the left of a one-way street: everything drives right of the centre, so
    // what is free here is all that lies left of the leftmost flank
    const rightRow = rows.some((q) => q.e < 0 && q.primary);
    const off = Math.max(0, Math.min(lane, hw - BUS_HALF - 0.5, rightRow ? hw - KERB_INTRUDES - 0.35 - BUS_HALF : Infinity));
    room = hw - (BUS_HALF - off) - GAP;
  } else {
    room = hw - flank - GAP;
    if (row.primary) room = Math.max(KERB_INTRUDES, room);
  }
  const full = 2 * across + 0.2;       // the whole car beside the kerb, on the road
  const want = row.pos === POS_KERB ? -0.1
    : row.pos === POS_HALF || (row.pos === 0 && o === PARALLEL) ? (o === PARALLEL ? KERB_INTRUDES : across)
      : full;
  let c = across - Math.min(want, Math.max(0, room));
  // no wheel balanced on the kerb stone: up onto the verge with it (never the
  // other way, which would take road the traffic was not asked for)
  if (o === PARALLEL) for (const wl of [c - TRACK / 2, c + TRACK / 2]) if (Math.abs(wl) < 0.14) c += 0.2 - wl;
  return (row.place = { across, along, pitch, c, need: Math.max(0, across + c) });
}

const _pose = { lift: 0, roll: 0, pitch: 0 };
/**
 * What the kerb does to a car standing with its centre `c` metres out from the
 * kerb line, nose along (fx, fz), the outward normal of the kerb (px, pz): how
 * far it is lifted, and its roll (positive lifts the right flank) and pitch
 * (positive lifts the nose). Each wheel stands on the verge or on the road.
 */
export function kerbPose(fx, fz, px, pz, c) {
  const rx = -fz, rz = fx;             // the car's right
  const fo = fx * px + fz * pz, ro = rx * px + rz * pz;
  const h = (a, b) => (c + a * fo + b * ro > 0 ? KERB_H : 0);
  const fl = h(BASE / 2, -TRACK / 2), fr = h(BASE / 2, TRACK / 2), rl = h(-BASE / 2, -TRACK / 2), rr = h(-BASE / 2, TRACK / 2);
  _pose.lift = (fl + fr + rl + rr) / 4;
  _pose.roll = Math.atan2((fr + rr - fl - rl) / 2, TRACK);
  _pose.pitch = Math.atan2((fl + fr - rl - rr) / 2, BASE);
  return _pose;
}

/**
 * The nose of a car in a row, as a unit vector: along the kerb the way the
 * traffic of that side runs, square to the kerb and nose in, or between the two.
 * (dx, dz) is the way's direction there, (px, pz) the outward normal of the kerb.
 */
export function rowNose(r, row, dx, dz, px, pz, out) {
  // Traffic on the e = -1 side runs WITH the way, on the other side against
  // it; a one-way street runs with it on both.
  const k = row.e < 0 || r.ow ? 1 : -1;
  if (row.orient === PERPENDICULAR) { out.x = px; out.z = pz; }
  else if (row.orient === DIAGONAL) {
    out.x = dx * k * Math.cos(DIAG) + px * Math.sin(DIAG);
    out.z = dz * k * Math.cos(DIAG) + pz * Math.sin(DIAG);
  } else { out.x = dx * k; out.z = dz * k; }
  return out;
}
