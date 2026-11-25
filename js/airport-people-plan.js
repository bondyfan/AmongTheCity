// ---- airport-people-plan.js: who stands and sits where in Terminál Jana Kašpara ----
// Pure data, WORKER SAFE: no three.js, no DOM, no clock, no random draws. Every
// place is a point of js/airport-plan.js (counters, lanes, gates, doors, walls,
// boards) turned into world metres here, and every choice is a hash of an index,
// so the same terminal has the same people on every screen.
//
// Each entry is { x, z, y, heading, pose, role, seed }:
//   x, z      world metres
//   y         the height of what the person stands or sits on ABOVE THE TERMINAL
//             FLOOR: 0 on the tiles, SEAT.bench or SEAT.chair on a seat. The floor
//             itself is lifted at runtime (js/airport-terminal.js _lift), so
//             js/airport-people.js adds it from terminal.floor().
//   heading   the figure's heading (ARCHITECTURE.md: 0 faces -z)
//   pose      'sit' on a seat, 'stand' a member of staff at work, 'idle' a passenger
//             standing still
//   role      'agent' (check-in), 'security' (the lanes), 'gate' (a gate desk), 'passenger'
//   seed      an integer for the body and its clothes
//
// THE PLAYER'S LINE. The walk the player must be able to make: from the north doors
// to counters 3 and 4, through lane 1's arch, along the lounge to gate 2's desk and
// out of its door. Nobody stands within ROUTE_CLEAR of it, nor in the lane mouths,
// where the officer holds a walker without a ticket (js/flight-terminal.js collide).
// That line runs past the counters' fronts, so the queues stand at the west end of
// the row, not in front of counters 3 and 4.

import { FRAME, HEADING_U, toWorld, DOORS, COUNTERS, COUNTER, MAHE_COUNTERS, LANES, GATES, MAHE_GATE, BOARDS, WALLS, CAROUSEL, inBuilding } from './airport-plan.js';

// ---- the seats: the numbers of js/airport-fit.js and js/airport-interior.js ----
const TILE_TOP = 0.12;                               // the tiles stand this far above the set's datum
/** A seat's height above the tiles. A bench pan is 0.38 to 0.44 above the datum, a counter chair 0.45 to 0.5. */
export const SEAT = { bench: 0.44 - TILE_TOP, chair: 0.5 - TILE_TOP };
const PITCH = 0.62;                                  // bench seat pitch (airport-fit.js benchRow)
const SIT_HIP = -0.12;                               // a bench sitter's hips, on the row's line toward its back (the back is at -0.24)
const BODY = 0.3;                                    // a body's radius
const MARGIN = 0.6;                                  // the least a body's centre keeps from an outside wall
const ROUTE_CLEAR = 1.2;                             // the least a body's centre keeps from the player's line
const SPACING = 0.6;                                 // the least between two bodies' centres
const MOUTH = { u0: 17.5, u1: 33.5, v0: 6.6, v1: 13.5 }; // the lane mouths and the staff side of them
const STAFFED = [2, 3, 4, 5];                        // counters with an agent: 3 and 4 sell the flight, 2 and 5 another desk

// The heading of a figure that faces a plan direction (du, dv): the world direction
// is (du C - dv S, du S + dv C), and a figure facing (dx, dz) has heading atan2(-dx, -dz).
const C = Math.cos(FRAME.theta), S = Math.sin(FRAME.theta);
const facing = (du, dv) => Math.atan2(-(du * C - dv * S), -(du * S + dv * C));
const SOUTH = facing(0, 1);                          // toward the apron, +v
const NORTH = facing(0, -1);                         // toward the landside, -v

/** A hash of two integers to [0, 2^32): the plan's only source of variety. */
function h32(a, b = 0) {
  let h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return h >>> 0;
}

// ---- distances in the plan's frame ----------------------------------------------
function rectDist(u, v, r) {
  return Math.hypot(Math.max(r.u0 - u, 0, u - r.u1), Math.max(r.v0 - v, 0, v - r.v1));
}
function segDist(u, v, a, b) {
  const ex = b[0] - a[0], ey = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((u - a[0]) * ex + (v - a[1]) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(u - a[0] - ex * t, v - a[1] - ey * t);
}
const rect = (u0, u1, v0, v1) => ({ u0, u1, v0, v1 });

// ---- the benches: rows of seats, as airport-fit.js builds them ----------------------
/** The bench rows: gate lounges (rows every 2 m, from airport-fit gates()) and the hall's two rows. */
const ROWS = [];
for (const g of GATES) {
  for (let v = g.seats.v0 + 1; v <= g.seats.v1 - 1.5; v += 2) ROWS.push({ u0: g.seats.u0 + 1, u1: g.seats.u1 - 1, v, gate: g.id });
}
for (const v of [15.5, 18.5]) for (const [u0, u1] of [[-30, -16], [-12, 2]]) ROWS.push({ u0, u1, v, gate: null });

/** The seats of one row: hips on the row's line, centred as airport-fit.js centres them. */
function seatsOf(row) {
  const n = Math.max(1, Math.floor((row.u1 - row.u0) / PITCH));
  const at = row.u0 + ((row.u1 - row.u0) - n * PITCH) / 2;
  return Array.from({ length: n }, (_, i) => ({ u: at + PITCH * (i + 0.5), v: row.v + SIT_HIP, row }));
}

/** Every seat of the terminal as the rectangle its sitter's hips must be in, with the height of the seat. */
export const SEAT_RECTS = [
  ...COUNTERS.map((c) => ({ kind: 'chair', u0: c.u - 0.35, u1: c.u + 0.35, v0: c.v + 0.6, v1: c.v + 1.0, y: SEAT.chair })),
  ...ROWS.map((row) => ({ kind: 'bench', u0: row.u0, u1: row.u1, v0: row.v - 0.22, v1: row.v + 0.22, y: SEAT.bench })),
];

// ---- what a body may not stand in --------------------------------------------------
/** Solid rectangles of the furniture (airport-fit.js), with the bench rows that a sitter may use. */
const SOLIDS = [];
for (const c of COUNTERS) {
  SOLIDS.push(rect(c.u - COUNTER.w / 2, c.u + COUNTER.w / 2, c.v - COUNTER.d / 2, c.v + COUNTER.d / 2)); // the desk
  SOLIDS.push(rect(c.u - 1.1, c.u + 1.1, c.v + 1.4, c.v + 2.0));                                        // the bag belt behind it
  if (MAHE_COUNTERS.includes(c.no)) for (const du of [-1.1, 1.1]) SOLIDS.push(rect(c.u + du - 0.06, c.u + du + 0.06, 1.94, 2.06));
}
for (const L of LANES) {
  for (const du of [-0.5, 0.5]) SOLIDS.push(rect(L.u + du - 0.06, L.u + du + 0.06, L.arch - 0.06, L.arch + 0.06));
  SOLIDS.push(rect(L.u - 0.5, L.u + 0.5, L.arch - 0.05, L.arch + 0.05));
  SOLIDS.push(rect(L.belt - 0.45, L.belt + 0.45, L.v0 + 1, L.v1 - 1));
}
for (const g of GATES) SOLIDS.push(rect(g.desk.u - 1, g.desk.u + 1, g.desk.v - 0.45, g.desk.v + 0.45));
SOLIDS.push(rect(32.2, 34.2, 10.2, 11.2));                                    // the agent's desk beside the lanes
SOLIDS.push(rect(40, 46, 2.4, 3.25), rect(56, 63, 2.4, 3.25));                // the duty-free front, the café
const TOTEM = BOARDS.find((b) => b.id === 'totem');
SOLIDS.push(rect(TOTEM.u - 0.5, TOTEM.u + 0.5, TOTEM.v - 0.2, TOTEM.v + 0.2));   // its base
SOLIDS.push(rect(TOTEM.u - 0.85, TOTEM.u + 0.85, TOTEM.v - 0.15, TOTEM.v + 0.15)); // its panel
SOLIDS.push(rect(CAROUSEL.u - CAROUSEL.w / 2, CAROUSEL.u + CAROUSEL.w / 2, CAROUSEL.v - CAROUSEL.d / 2, CAROUSEL.v + CAROUSEL.d / 2));
for (const row of ROWS) SOLIDS.push({ ...rect(row.u0, row.u1, row.v - 0.3, row.v + 0.3), row });

/** The player's line: every polyline a walker takes from the doors to the counters, the arch and the gate. */
const LINES = (() => {
  const [mainW, mainE] = DOORS.filter((d) => d.side === 'n');
  const [c3, c4] = COUNTERS.filter((c) => MAHE_COUNTERS.includes(c.no));
  const ticket = [(c3.u + c4.u) / 2, c3.v - 1.2];
  const stops = [[c3.u, c3.v - 2.1], [c4.u, c4.v - 2.1], ticket];
  const lane1 = LANES[0], lane2 = LANES[1];
  const g2 = GATES.find((g) => g.id === MAHE_GATE), door2 = DOORS.find((d) => d.id === g2.door);
  const door1 = DOORS.find((d) => d.id === 'gate1');
  const lines = [];
  for (const d of [mainW, mainE]) for (const s of stops) lines.push([[d.u, d.v + 1.3], [d.u, -8], s]);
  for (const s of [stops[0], ticket]) lines.push([s, [lane1.u, s[1]], [lane1.u, 14], [34.6, 15], [50, 16], [g2.desk.u, 16], [door2.u, 16], [door2.u, door2.v - 0.4]]);
  lines.push([ticket, [lane2.u, ticket[1]], [lane2.u, 14], [34.6, 15]]);
  lines.push([[34.6, 15], [door1.u, 15.5], [door1.u, door1.v - 0.4]]);
  return lines;
})();

/** Is a body of radius r at (u, v) free: inside the building, off the walls, the furniture and the line? */
function clear(u, v, r, own) {
  if (!inBuilding(u, v, -MARGIN)) return false;
  if (u > MOUTH.u0 && u < MOUTH.u1 && v > MOUTH.v0 && v < MOUTH.v1) return false;
  for (const w of WALLS) if (segDist(u, v, w.a, w.b) < r + 0.15) return false;
  for (const s of SOLIDS) if (s.row !== own && rectDist(u, v, s) < r) return false;
  for (const line of LINES) for (let i = 0; i + 1 < line.length; i++) {
    if (segDist(u, v, line[i], line[i + 1]) < ROUTE_CLEAR) return false;
  }
  return true;
}

/** Choose `quota` candidates in a hashed order, each accepted by `ok`. */
function pick(cands, quota, salt, ok) {
  const order = cands.map((c, i) => [h32(i, salt), c]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [, c] of order) {
    if (out.length >= quota) break;
    if (ok(c)) out.push(c);
  }
  return out;
}

let PLAN = null;

/**
 * The people of the terminal, as a list of entries (see the header). Memoised:
 * every call returns the same array.
 */
export function airportPeoplePlan() {
  if (PLAN) return PLAN;
  const out = [], placed = [];
  const add = (u, v, y, heading, pose, role) => {
    const w = toWorld(u, v);
    out.push({ x: w.x, z: w.z, y, heading, pose, role, seed: h32(out.length + 1, 0x51ed) });
    placed.push([u, v]);
  };
  const free = (u, v) => placed.every(([a, b]) => Math.hypot(a - u, b - v) >= SPACING);

  // ---- staff: the check-in agents sit behind their desks, the gate agents stand behind theirs
  for (const no of STAFFED) {
    const c = COUNTERS.find((k) => k.no === no);
    add(c.u, c.v + 0.9, SEAT.chair, NORTH, 'sit', 'agent');
  }
  for (const g of GATES) add(g.desk.u, g.desk.v + 0.95, 0, NORTH, 'stand', 'gate');
  // the officers stand north of the lane mouths, off the walker's line and clear of the collider
  add(18.9, 5.9, 0, SOUTH, 'stand', 'security');
  add(31.4, 5.9, 0, SOUTH, 'stand', 'security');

  // ---- passengers: 14 in all
  const gateRows = (id) => ROWS.filter((r) => r.gate === id);
  const groups = [
    // a queue at the west end of the row, facing east along the desks
    { cands: [3.0, 1.6, 0.2, -1.2].map((v) => ({ u: -27.4, v })), quota: 4, pose: 'idle', heading: HEADING_U, y: 0, salt: 11 },
    // standing in front of the totem, reading the departures on its south face
    { cands: [[-12.4, -14.0], [-11.4, -14.0], [-10.2, -14.0], [-12.4, -13.4], [-11.4, -13.4]].map(([u, v]) => ({ u, v })),
      quota: 2, pose: 'idle', heading: NORTH, y: 0, salt: 12 },
    // at the two windows over the apron
    { cands: [{ u: 45.8, v: 18.2 }, { u: 46.8, v: 18.2 }], quota: 1, pose: 'idle', heading: SOUTH, y: 0, salt: 13 },
    { cands: [{ u: 62.8, v: 17.8 }, { u: 63.8, v: 17.8 }], quota: 1, pose: 'idle', heading: SOUTH, y: 0, salt: 14 },
    // on the benches: gate 2 (three), gate 1 (two), the hall's first row (one)
    { cands: gateRows('2').flatMap(seatsOf), quota: 3, pose: 'sit', heading: SOUTH, y: SEAT.bench, salt: 15 },
    { cands: gateRows('1').flatMap(seatsOf), quota: 2, pose: 'sit', heading: SOUTH, y: SEAT.bench, salt: 16 },
    { cands: ROWS.filter((r) => r.gate === null && r.v === 15.5 && r.u0 === -30).flatMap(seatsOf), quota: 1, pose: 'sit', heading: SOUTH, y: SEAT.bench, salt: 17 },
  ];
  for (const g of groups) {
    for (const c of pick(g.cands, g.quota, g.salt, (k) => free(k.u, k.v) && clear(k.u, k.v, BODY, k.row))) {
      add(c.u, c.v, g.y, g.heading, g.pose, 'passenger');
    }
  }
  PLAN = out;
  return out;
}
