// The walkable underground of the two stations, as plain data and arithmetic
// (no three.js: js/station-passages.js draws and walks it, the tests read it).
//
// Each station has its own frame: u runs along the platforms, v across the
// tracks. Below the surface a walker may be in a ROOM (an axis-aligned
// rectangle of corridor floor, all at one level) or on a FLIGHT (an
// axis-aligned ramp of steps from that level up to the surface).
//
//   flight { axis, a, b, c, half, kind, to }
//     axis  'u' or 'v': the direction it climbs along
//     a, b  where it starts at the bottom and where it lands at the top
//     c     its centre line on the other axis, `half` its half width
//     kind  'stairs', 'escalator' (two belts: up and down) or 'hall'
//           (steps, a belt up and a belt down side by side)
//     to    what is at the top: 'hall' or the platform's number

export const HALF = 2.3, // half the width of a corridor
  WIDTH = 1.65, // half the width of a flight to a platform
  DEPTH = 3.8, // corridor floor below the lowest landing
  CEILING = 2.95, // underside of the corridor's roof slab
  HEADROOM = 3.25, // a walker this far above the floor is on the surface
  STEPS = 24,
  BELT = 0.72; // an escalator's speed along the ground, m/s

const stairs = (c, a, b, to, kind = 'stairs') => ({ axis: 'u', a, b, c, half: WIDTH, kind, to });

// Kolín: one straight corridor, a flight to the east at every stop, the last
// one up into the hall.
function kolin() {
  const stops = [-57, -41, -15, 0, 19, 35],
    platform = { 0: 2, '-15': 3, '-41': 4, '-57': 5, 19: '1A' };
  return {
    x: -38842.1,
    z: 706.5,
    angle: 0.61,
    name: 'Kolín',
    stops,
    hall: 35,
    rooms: [{ u0: -HALF, u1: HALF, v0: stops[0] - WIDTH, v1: stops.at(-1) + WIDTH }],
    flights: stops.map((v) => stairs(v, HALF, HALF + 13.8, v === 35 ? 'hall' : platform[v])),
  };
}

// Pardubice hlavní nádraží as it stands after the rebuild of 2020 to 2024
// (OpenStreetMap, November 2026, and photographs of the finished station):
// five platforms, tracks 1 to 11 for passengers, and two underpasses from the
// hall. The western one (u = 0) has stairs on one side of every island and
// escalators on the other; the eastern one (u = 49.5) has stairs and lifts.
// Both reach platform 1 by a side flight and end under the new platform 5.
// u runs east, v south: the hall is at v < -20.7, platform 5 at v = 79.
export const PARDUBICE = {
  A: 0, // axis of the western underpass
  B: 49.5, // axis of the eastern one
  wall: -20.7, // the hall's glass wall towards the tracks
  hall: { u0: -30.6, u1: 41.9, v0: -58.6, v1: -20.7 },
  // every platform: its number, the tracks at its two edges (north, south),
  // the paved band (v) and its length (u), and what the canopy covers
  platforms: [
    { n: 1, tracks: [null, 3], v0: -21.5, v1: -13.3, u0: -125.6, u1: 136, roof: null },
    { n: 2, tracks: [4, 5], v0: -5.2, v1: 5.6, u0: -125, u1: 171.6, roof: [-119, 106] },
    { n: 3, tracks: [6, 7], v0: 18.5, v1: 29.5, u0: -225, u1: 211.4, roof: [-120, 118] },
    { n: 4, tracks: [8, 9], v0: 37.2, v1: 48.5, u0: -177.4, u1: 257.8, roof: [-120, 117] },
    { n: 5, tracks: [10, 11], v0: 75.5, v1: 83.3, u0: -21.2, u1: 229.4, roof: [-21, 111] },
  ],
  // the bay platform west of the building: tracks 1 and 2 end at its sides
  bay: { tracks: [1, 2], v0: -29.1, v1: -21.3, u0: -181, u1: -78.6, roof: [-145, -81] },
  // the covered red footbridge of 2024 at the western end, from the bus
  // terminal over every track to the Dukla estate: its deck (rise: metres
  // above the hall floor) and where its piers stand clear of the rails (v)
  bridge: { u0: -169.2, u1: -165.2, v0: -38.4, v1: 216.2, rise: 7, piers: [-36, -20.8, 1.9, 23.5, 41.6, 60.5, 77.4, 97.2, 117.7, 140, 162, 184, 206] },
  // where the lifts of the eastern underpass stand on each platform
  lifts: [
    { n: 1, u: 53.4, v: -18.6 },
    { n: 2, u: 42, v: 0.2 },
    { n: 3, u: 41.7, v: 23.6 },
    { n: 4, u: 42.1, v: 42.9 },
    { n: 5, u: 44.2, v: 79.4 },
  ],
};

function pardubice() {
  const { A, B } = PARDUBICE;
  const top = 11.9; // length of a flight to a platform, as the mapped stairs are
  const west = [0, 24.4, 43.3, 79.3], // where the western underpass meets platforms 2 to 5
    east = [0, 23.6, 43.1, 79.5];
  const flights = [
    // from the hall, down towards the tracks and under its glass wall
    { axis: 'v', a: -21, b: -29, c: A, half: HALF, kind: 'hall', to: 'hall' },
    { axis: 'v', a: -26, b: -34, c: 36.8, half: HALF, kind: 'hall', to: 'hall' },
    // platform 1 (track 3, and the bay tracks 1 and 2 along it)
    // (the western one starts beyond a short passage, as the real one does:
    // its mouth must leave the hall's door onto the platform free)
    stairs(-18.6, 3.9, A + HALF + top, 1),
    stairs(-18.6, 44.8, 34.2, 1),
  ];
  west.forEach((v, i) => {
    const last = i === west.length - 1; // platform 5 has them the other way round
    flights.push(stairs(v, A + HALF, A + HALF + top, i + 2, last ? 'escalator' : 'stairs'));
    flights.push(stairs(v, A - HALF, A - HALF - top, i + 2, last ? 'stairs' : 'escalator'));
  });
  east.forEach((v, i) => flights.push(stairs(v, B + HALF, B + HALF + top, i + 2)));
  const rooms = [
    { u0: A - HALF, u1: A + HALF, v0: -21, v1: west.at(-1) + HALF },
    { u0: B - HALF, u1: B + HALF, v0: -26, v1: east.at(-1) + HALF },
    // the eastern underpass comes into the hall round a corner: the real hall
    // is 90 m long, the game's 72, and its own well would be under the annex
    { u0: 36.8 - HALF, u1: B + HALF, v0: -26, v1: -21.4 },
    // (side rooms reach 1.2 m into the corridor: shrunk by a walker's radius
    // they must still overlap it, or nearestInside would not let him through)
    { u0: 44.8, u1: B - HALF + 1.2, v0: -18.6 - WIDTH, v1: -18.6 + WIDTH },
    { u0: A + HALF - 1.2, u1: 3.9, v0: -18.6 - WIDTH, v1: -18.6 + WIDTH },
    // short passages to the lift doors
    ...PARDUBICE.lifts.slice(1).map((l) => ({ u0: l.u + 1.1, u1: B - HALF + 1.2, v0: l.v - 1.3, v1: l.v + 1.3 })),
    { u0: B + HALF - 1.2, u1: PARDUBICE.lifts[0].u - 1.1, v0: -18.6 - 1.3, v1: -18.6 + 1.3 },
  ];
  // up to the footbridge: moving stairs from the west end of platforms 2, 3
  // and 4 and from the forecourt, plain stairs at both ends of the deck
  const { bridge } = PARDUBICE,
    edge = bridge.u1,
    axis = (bridge.u0 + bridge.u1) / 2;
  const ramps = [
    ...[[0.6, 2], [23.6, 3], [41, 4], [-36.4, 'terminal']].map(([v, from]) => ({ axis: 'u', a: -144.5, b: edge, c: v, half: 1.7, kind: 'escalator', to: 'bridge', from })),
    { axis: 'v', a: -57, b: bridge.v0, c: axis, half: 1.6, kind: 'stairs', to: 'bridge', from: 'terminal' },
    { axis: 'u', a: -145, b: edge, c: 214.6, half: 1.6, kind: 'stairs', to: 'bridge', from: 'Dukla' },
  ];
  // walled: a stair mouth is fenced, nobody drops into it from the side
  // beyond: read a landing's height this far past the flight (the mapped
  // stairs under it are drawn a step above the paving)
  return { x: 14.9, z: -32.9, angle: 0.02, name: 'Pardubice hl. n.', rooms, flights, ramps, deck: { ...bridge }, walled: true, beyond: 1.3 };
}

export const definitions = [kolin(), pardubice()];

export const local = (s, x, z) => ({ u: (x - s.x) * s.c + (z - s.z) * s.s, v: (z - s.z) * s.c - (x - s.x) * s.s });
export const worldAt = (s, u, v) => ({ x: s.x + u * s.c - v * s.s, z: s.z + u * s.s + v * s.c });

// A flight's footprint in the station frame.
export function spanOf(f) {
  const lo = Math.min(f.a, f.b),
    hi = Math.max(f.a, f.b);
  return f.axis === 'u'
    ? { u0: lo, u1: hi, v0: f.c - f.half, v1: f.c + f.half }
    : { u0: f.c - f.half, u1: f.c + f.half, v0: lo, v1: hi };
}
// The point on the surface where it lands (or `beyond` metres past it).
export function landing(f, beyond = 0) {
  const b = f.b + Math.sign(f.b - f.a) * beyond;
  return f.axis === 'u' ? { u: b, v: f.c } : { u: f.c, v: b };
}
// Somebody on the surface at height y who is over a stair mouth without being
// on its top steps: where the fence round it puts him back (or null).
export function fencedOut(s, u, v, y, r) {
  for (const f of s.flights) {
    const m = f.span;
    if (!inRect(m, u, v, r) || y - flightY(s, f, Math.max(m.u0, Math.min(m.u1, u)), Math.max(m.v0, Math.min(m.v1, v))) < 0.7) continue;
    const gaps = [[u - (m.u0 - r), -1, 0], [m.u1 + r - u, 1, 0], [v - (m.v0 - r), 0, -1], [m.v1 + r - v, 0, 1]];
    const [gap, du, dv] = gaps.reduce((a, b) => (b[0] < a[0] ? b : a));
    return { u: u + du * (gap + 0.01), v: v + dv * (gap + 0.01) };
  }
  return null;
}
// Along and across a flight: t runs 0 at the bottom to 1 at the top, q is the
// offset from its centre line, positive on the right of somebody climbing.
export function along(f, u, v) {
  const dir = Math.sign(f.b - f.a),
    p = f.axis === 'u' ? u : v,
    q = f.axis === 'u' ? (v - f.c) * dir : (f.c - u) * dir;
  return { t: (p - f.a) / (f.b - f.a), q, dir };
}
// The lanes across a flight, from the climber's left to right: where each
// begins and ends (q) and which way it carries (1 up, -1 down, 0 fixed steps).
export function lanes(f) {
  if (f.kind === 'escalator') return [{ q0: -f.half, q1: 0, move: -1 }, { q0: 0, q1: f.half, move: 1 }];
  if (f.kind === 'hall')
    return [
      { q0: -f.half, q1: -0.76, move: 0 },
      { q0: -0.76, q1: 0.77, move: -1 },
      { q0: 0.77, q1: f.half, move: 1 },
    ];
  return [{ q0: -f.half, q1: f.half, move: 0 }];
}
export const laneAt = (f, q) => lanes(f).find((l) => q >= l.q0 && q <= l.q1) ?? lanes(f)[0];

export const inRect = (r, u, v, pad = 0) => u >= r.u0 - pad && u <= r.u1 + pad && v >= r.v0 - pad && v <= r.v1 + pad;
export function flightAt(s, u, v) {
  for (const f of s.flights) if (inRect(f.span, u, v)) return f;
  return null;
}
// Height of a flight under (u, v): fixed steps are steps, a belt is a ramp.
export function flightY(s, f, u, v) {
  const { t, q } = along(f, u, v),
    k = Math.max(0, Math.min(1, t));
  const step = laneAt(f, q).move ? k : Math.min(1, Math.ceil(k * STEPS) / STEPS),
    base = f.base ?? s.bottom; // a ramp to the footbridge starts from the ground
  return base + (f.top - base) * step;
}
// What a walker at (u, v) whose head is at `limit` stands on, or null.
export function floorAt(s, u, v, limit) {
  const f = flightAt(s, u, v);
  if (f) return flightY(s, f, u, v);
  if (limit < s.bottom + HEADROOM) for (const r of s.rooms) if (inRect(r, u, v)) return s.bottom;
  return null;
}
// The nearest point of the underground to (u, v) for a body of radius r:
// rooms shrunk by r, flights shrunk at the sides, open at the top and running
// 2 m into the room they start from so the two always overlap.
export function nearestInside(s, u, v, r) {
  let best = null,
    d = Infinity;
  const candidate = (u0, u1, v0, v1) => {
    const q = Math.max(u0, Math.min(u1, u)),
      t = Math.max(v0, Math.min(v1, v)),
      err = (q - u) ** 2 + (t - v) ** 2;
    if (err < d) {
      d = err;
      best = { u: q, v: t };
    }
  };
  for (const m of s.rooms) candidate(m.u0 + r, m.u1 - r, m.v0 + r, m.v1 - r);
  for (const f of s.flights) {
    const dir = Math.sign(f.b - f.a),
      lo = Math.min(f.a - dir * 2, f.b + dir * 0.5),
      hi = Math.max(f.a - dir * 2, f.b + dir * 0.5);
    if (f.axis === 'u') candidate(lo, hi, f.c - f.half + r, f.c + f.half - r);
    else candidate(f.c - f.half + r, f.c + f.half - r, lo, hi);
  }
  return best && { ...best, d: Math.sqrt(d) };
}

// The footbridge and its ramps, for a walker whose head is at `limit`: he is
// on it when he is up at its level, under it otherwise.
export function deckAt(s, u, v, limit) {
  if (!s.deck) return null;
  for (const f of s.ramps)
    if (inRect(f.span, u, v)) {
      const y = flightY(s, f, u, v);
      return limit >= y - 0.3 ? y : null;
    }
  return inRect(s.deck, u, v) && limit >= s.deck.y - 0.3 ? s.deck.y : null;
}
// The nearest point of the bridge to (u, v) and its height there: the deck,
// and each ramp from half a metre before its foot to 2 m into the deck.
export function nearestOnDeck(s, u, v, r) {
  let best = null,
    d = Infinity;
  const candidate = (u0, u1, v0, v1, f) => {
    const q = Math.max(u0, Math.min(u1, u)),
      t = Math.max(v0, Math.min(v1, v)),
      err = (q - u) ** 2 + (t - v) ** 2;
    if (err < d) {
      d = err;
      best = { u: q, v: t, f };
    }
  };
  const k = s.deck;
  candidate(k.u0 + r, k.u1 - r, k.v0 + r, k.v1 - r, null);
  for (const f of s.ramps) {
    const dir = Math.sign(f.b - f.a),
      lo = Math.min(f.a - dir * 0.5, f.b + dir * 2),
      hi = Math.max(f.a - dir * 0.5, f.b + dir * 2);
    if (f.axis === 'u') candidate(lo, hi, f.c - f.half + r, f.c + f.half - r, f);
    else candidate(f.c - f.half + r, f.c + f.half - r, lo, hi, f);
  }
  const y = best.f && inRect(best.f.span, best.u, best.v) ? flightY(s, best.f, best.u, best.v) : k.y;
  return { u: best.u, v: best.v, d: Math.sqrt(d), y, base: best.f && inRect(best.f.span, best.u, best.v) ? best.f.base : -Infinity };
}

// A station ready for use: its axes, every flight's footprint, the boxes that
// hold everything below ground and everything it has built.
export function prepare(d) {
  const s = { ...d, c: Math.cos(d.angle), s: Math.sin(d.angle) };
  s.flights = d.flights.map((f) => ({ ...f, span: spanOf(f) }));
  s.ramps = (d.ramps ?? []).map((f) => ({ ...f, span: spanOf(f) }));
  const around = (rects) => ({
    u0: Math.min(...rects.map((r) => r.u0)),
    u1: Math.max(...rects.map((r) => r.u1)),
    v0: Math.min(...rects.map((r) => r.v0)),
    v1: Math.max(...rects.map((r) => r.v1)),
  });
  s.under = around([...s.rooms, ...s.flights.map((f) => f.span)]); // everything below ground
  s.box = around([s.under, ...s.ramps.map((f) => f.span), ...(d.deck ? [d.deck] : [])]); // and the bridge
  return s;
}
