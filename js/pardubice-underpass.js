import { HALF, CEILING, STEPS, lanes, PARDUBICE } from './station-layout.js';
import { plate } from './stationkit.js';
import { departures, sectorsBy, tracksOf } from './pardubice-signs.js';

// The two underpasses of Pardubice hlavní nádraží as they look since 2024:
// cream square tiles to the ceiling, a terracotta floor with a dark skirting,
// a line of light along the top of both walls, navy plates with the track
// numbers at every exit and a blue departure board hung across the corridor
// there. Everything is in the station's frame (x = u, z = v) with y measured
// from the corridor floor; `k` is a js/stationkit.js kit on that group.

const EPS = 0.05,
  WALL = 0.14;

// The parts of one side of a room that are wall, i.e. not opened by another
// room or by a flight that continues beyond it. side: n, s (along u), w, e.
function solid(room, side, others) {
  const along = side === 'n' || side === 's',
    at = { n: room.v0, s: room.v1, w: room.u0, e: room.u1 }[side],
    out = side === 'n' || side === 'w' ? -1 : 1;
  let spans = [along ? [room.u0, room.u1] : [room.v0, room.v1]];
  for (const r of others) {
    const [p0, p1] = along ? [r.v0, r.v1] : [r.u0, r.u1],
      [q0, q1] = along ? [r.u0, r.u1] : [r.v0, r.v1];
    if (!(out > 0 ? p0 <= at + EPS && p1 > at + EPS : p1 >= at - EPS && p0 < at - EPS)) continue;
    spans = spans.flatMap(([a, b]) =>
      q1 <= a || q0 >= b ? [[a, b]] : [[a, Math.max(a, q0)], [Math.min(b, q1), b]].filter(([x, y]) => y - x > EPS),
    );
  }
  return { along, at, out, spans };
}

function rooms(s, k) {
  for (const room of s.rooms) {
    const cu = (room.u0 + room.u1) / 2,
      cv = (room.v0 + room.v1) / 2,
      w = room.u1 - room.u0,
      d = room.v1 - room.v0;
    k.box(cu, -0.1, cv, w, 0.2, d, 'floor');
    k.box(cu, CEILING + 0.1, cv, w + 2 * WALL, 0.2, d + 2 * WALL, 'ceiling');
    const others = [...s.rooms.filter((r) => r !== room), ...s.flights.map((f) => f.span)];
    for (const side of 'nswe') {
      const { along, at, out, spans } = solid(room, side, others);
      for (const [a, b] of spans) {
        const mid = (a + b) / 2,
          len = b - a;
        // the wall, its skirting and the strip of light under the ceiling
        const piece = (off, y, thick, h, finish) =>
          along ? k.box(mid, y, at + out * off, len, h, thick, finish) : k.box(at + out * off, y, mid, thick, h, len, finish);
        piece(WALL / 2, CEILING / 2, WALL, CEILING, 'tile');
        piece(-0.012, 0.07, 0.03, 0.14, 'skirt');
        piece(-0.05, CEILING - 0.11, 0.1, 0.07, 'led');
      }
    }
  }
}

// One flight: its steps or belts, the walls beside it, the lintel over the
// door it leaves the corridor by, and what stands round its mouth above.
function flight(s, k, f) {
  const rise = f.top - s.bottom,
    len = f.b - f.a,
    dir = Math.sign(len),
    run = Math.abs(len),
    tread = run / STEPS,
    tilt = Math.atan2(rise, run),
    slope = Math.hypot(rise, run),
    mid = (f.a + f.b) / 2;
  // a box by its place along (p) and across (q) the flight
  const put = (p, y, q, long, h, wide, finish, lean = 0) =>
    f.axis === 'u'
      ? k.box(p, y, f.c + q * dir, long, h, wide, finish, lean ? { z: lean * dir } : null)
      : k.box(f.c - q * dir, y, p, wide, h, long, finish, lean ? { x: -lean * dir } : null);
  for (const lane of lanes(f)) {
    const q = (lane.q0 + lane.q1) / 2,
      wide = lane.q1 - lane.q0;
    for (let i = 0; i < STEPS; i++) {
      const p = f.a + dir * (i + 0.5) * tread,
        h = ((i + 1) * rise) / STEPS;
      if (!lane.move) {
        put(p, h / 2, q, tread + 0.005, h, wide, 'step');
        put(p - dir * (tread / 2 - 0.035), h + 0.007, q, 0.07, 0.014, wide - 0.12, 'nosing');
      } else if (h > 0.4) put(p, (h - 0.24) / 2, q, tread + 0.005, h - 0.24, wide, 'dark');
    }
    if (lane.move) {
      // balustrades and their rubber handrails, and the comb plates at both ends
      for (const side of [lane.q0 + 0.09, lane.q1 - 0.09]) {
        put(mid, rise / 2 + 0.4, side, slope, 0.8, 0.07, 'steel', tilt);
        put(mid, rise / 2 + 0.84, side, slope, 0.07, 0.1, 'dark', tilt);
      }
      put(f.a - dir * 0.3, 0.012, q, 0.6, 0.024, wide - 0.2, 'steel');
      put(f.b + dir * 0.3, rise + 0.012, q, 0.6, 0.024, wide - 0.2, 'steel');
      put(f.a + dir * 0.45, 0.05, q, 0.1, 0.012, wide - 0.4, lane.move > 0 ? 'led' : 'red');
    }
  }
  const well = f.kind === 'hall';
  for (const side of [-f.half, f.half]) {
    put(mid, rise / 2, side + Math.sign(side) * (WALL / 2), run, rise, WALL, 'tile');
    // (in the hall the wells are edged in the building's black ceramic)
    if (well) put(mid, rise - 0.3, side + Math.sign(side) * (WALL / 2 - 0.01), run, 0.6, WALL, 'blacktile');
    if (well) {
      // a glass balustrade round the opening in the hall floor
      put(mid, rise + 0.5, side, run, 0.9, 0.03, 'glass');
      put(mid, rise + 1.0, side, run, 0.05, 0.07, 'steel');
      for (let p = 0; p <= run + 0.01; p += run / 4) put(f.a + dir * p, rise + 0.5, side, 0.06, 1.0, 0.06, 'steel');
    } else {
      // the brick wall round a stair mouth on the platform, with its rail
      put(mid, rise + 0.45, side + Math.sign(side) * (WALL / 2), run, 0.9, 0.3, 'brick');
      put(mid, rise + 0.93, side + Math.sign(side) * (WALL / 2), run + 0.1, 0.06, 0.36, 'concrete');
      put(mid, rise / 2 + 0.95, side - Math.sign(side) * 0.09, slope, 0.05, 0.05, 'steel', tilt);
    }
  }
  // over the door into the corridor, up to the surface
  put(f.a + dir * (WALL / 2), (CEILING + rise) / 2, 0, WALL, rise - CEILING, 2 * f.half, 'tile');
  if (!well) {
    put(f.a + dir * 0.15, rise + 0.45, 0, 0.3, 0.9, 2 * f.half + 0.6, 'brick');
    put(f.a + dir * 0.15, rise + 0.93, 0, 0.36, 0.06, 2 * f.half + 0.7, 'concrete');
  } else if (f.a < PARDUBICE.wall - 1) {
    put(f.a, rise + 0.5, 0, 0.03, 0.9, 2 * f.half, 'glass');
    put(f.a, rise + 1.0, 0, 0.07, 0.05, 2 * f.half, 'steel');
  }
}

// What tells a passenger where he is: plates with the track numbers beside
// each exit, the sectors under them, a departure board across the corridor.
function exitSigns(s, k, f) {
  if (f.axis !== 'u') return;
  const dir = Math.sign(f.b - f.a),
    wallU = f.a - dir * 0.012,
    yaw = (-dir * Math.PI) / 2,
    tracks = tracksOf(f.to),
    sectors = sectorsBy(f);
  const sides = f.to === 1 ? [[-1, '1 2'], [1, '3']] : [[-1, String(tracks[0])], [1, String(tracks[1])]];
  for (const [side, text] of sides) {
    const v = f.c + side * (f.half + 0.5);
    k.sign(wallU, 2.08, v, 0.56, 0.56, yaw, 96, plate([text]), 'track' + text);
    k.sign(wallU, 1.58, v, 0.56, 0.3, yaw, 128, plate(['sektor', sectors], '#1b2f55', '#ffffff', 600), 'sector' + sectors);
  }
  // the arrow and what is up there, over the door
  const label = f.to === 1 ? 'Koleje 1 · 2 · 3' : 'Koleje ' + tracks.join(' · ');
  const way = f.kind === 'escalator' ? 'Pojízdné schody' : 'Schody';
  k.sign(wallU, 2.62, f.c, 2.6, 0.36, yaw, 512, plate([label + '   ' + way + (dir > 0 ? '  →' : '  ←')], '#1b2f55'), 'over' + label + way + dir);
}

function boards(s, k) {
  const { A, B } = PARDUBICE;
  const seen = new Set();
  for (const f of s.flights) {
    if (f.axis !== 'u' || f.to === 1) continue;
    const axis = Math.abs(f.a) < 10 ? A : B,
      key = axis + ':' + f.to;
    if (seen.has(key)) continue;
    seen.add(key);
    // hung across the corridor at the exit, read from both directions
    k.box(axis, 2.5, f.c, 2.7, 0.66, 0.08, 'dark');
    for (const u of [-1.1, 1.1]) k.box(axis + u, 2.88, f.c, 0.04, 0.14, 0.04, 'steel');
    k.both(axis, 2.5, f.c, 2.6, 0.58, 0, 640, departures(tracksOf(f.to), 2), 'exit' + f.to, 0.045);
  }
  // screens with every departure, on the wall as one comes down from the hall
  for (const [u, v, yaw] of [[A - HALF + 0.03, -12, Math.PI / 2], [A + HALF - 0.03, 12, -Math.PI / 2], [B + HALF - 0.03, -10, -Math.PI / 2], [B - HALF + 0.03, 33, Math.PI / 2], [A - HALF + 0.03, 61, Math.PI / 2]]) {
    k.box(u - Math.sin(yaw) * 0.01, 1.85, v, 0.05, 0.82, 1.24, 'dark');
    k.sign(u + Math.sin(yaw) * 0.02, 1.85, v, 1.16, 0.74, yaw, 512, departures(null, 7), 'all');
  }
  // which way is out
  for (const [axis, v0, v1] of [[A, -19.5, 81.2], [B, -24.5, 81.4]]) {
    k.both(axis, 2.62, v0 + 4.5, 2.4, 0.34, Math.PI, 512, plate(['↑  Hala · Východ · náměstí Jana Pernera'], '#1b2f55'), 'out', 0.02);
    k.sign(axis, 2.1, v1 - 0.02, 2.4, 0.5, Math.PI, 512, plate(['Koleje 10 · 11', '←   →'], '#1b2f55'), 'end');
  }
  // round the corner the eastern underpass takes under the hall
  k.sign(36.8 - HALF + 0.03, 2.1, -23.7, 2.6, 0.5, Math.PI / 2, 512, plate(['Koleje 1 až 11  →', 'Výtahy  →'], '#1b2f55'), 'corner');
  k.sign(B + HALF - 0.03, 2.1, -23.7, 2.6, 0.5, -Math.PI / 2, 512, plate(['←  Hala · Východ', 'Koleje 1 až 11  ↓'], '#1b2f55'), 'corner2');
  // the plaque of the aviator Jan Kašpar, which hangs in the underpass
  k.box(A - HALF + 0.02, 1.7, 9, 0.04, 0.84, 0.64, 'dark');
  k.sign(A - HALF + 0.045, 1.7, 9, 0.56, 0.76, Math.PI / 2, 192, plate(['JAN KAŠPAR', '1883–1927', 'první český', 'aviatik'], '#6b5234', '#e9d7a8', 600), 'kaspar');
}

// The lifts of the eastern underpass: a door at the end of each short passage.
function liftDoors(s, k) {
  const { B, lifts } = PARDUBICE;
  for (const l of lifts) {
    const east = l.u > B,
      u = l.u + (east ? -1.1 : 1.1),
      yaw = east ? -Math.PI / 2 : Math.PI / 2,
      face = east ? -1 : 1; // the door looks back at the corridor
    const v = l.v;
    k.box(u + face * 0.02, 1.1, v, 0.05, 2.2, 1.3, 'steel');
    k.box(u + face * 0.05, 1.1, v, 0.02, 2.1, 0.03, 'dark');
    k.box(u + face * 0.05, 2.32, v, 0.03, 0.12, 1.3, 'led');
    k.sign(u + face * 0.06, 2.6, v, 1.2, 0.3, yaw, 256, plate(['Výtah · kolej ' + tracksOf(l.n).filter(Boolean).join(' · ')], '#1b2f55'), 'lift' + l.n);
    k.box(u + face * 0.04, 1.15, v + 0.85, 0.03, 0.22, 0.1, 'steel');
  }
}

// In the hall: the frame over each well with the two blue departure boards
// (the hall's hall-mark since the rebuild) and the plates that send people on.
function hall(s, k) {
  for (const f of s.flights) {
    if (f.kind !== 'hall') continue;
    const y = f.top - s.bottom,
      v = f.a - 0.25; // over the low end of the well, facing the hall
    for (const side of [-1, 1]) k.box(f.c + side * (f.half + 0.22), y + 2.9, v, 0.16, 5.8, 0.16, 'dark');
    k.box(f.c, y + 4.55, v, 2 * f.half + 0.6, 2.5, 0.12, 'dark');
    for (const side of [-1, 1])
      k.sign(f.c + side * 1.2, y + 4.55, v - 0.07, 2.3, 2.3, Math.PI, 640, departures(null, 12, side < 0 ? 0 : 12), 'big' + side);
    k.sign(f.c, y + 3.08, v - 0.07, 2 * f.half + 0.4, 0.34, Math.PI, 640, plate(['↓  Koleje 4 až 11  ·  Koleje 1 až 3 podchodem i z haly'], '#1b2f55'), 'down');
  }
}

export function buildUnderpass(s, k) {
  rooms(s, k);
  for (const f of s.flights) {
    flight(s, k, f);
    exitSigns(s, k, f);
  }
  boards(s, k);
  liftDoors(s, k);
  hall(s, k);
}
