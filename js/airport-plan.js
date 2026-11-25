// ---- airport-plan.js: Letiště Pardubice (LKPD) as plain data ----
// WORKER SAFE: no three.js, no DOM, no clock. The landmark shell
// (js/landmarks-letiste.js, both threads), the interior set
// (js/airport-terminal.js), the flight (js/flight*.js) and the tests all read
// the terminal and the apron from here, so they cannot disagree about where a
// counter or a door is.
//
// THE TERMINAL'S OWN FRAME. Terminál Jana Kašpara (opened 30 Jan 2018, 160 x 46
// m) is mapped in OSM as one ring of 26 points, turned 2.74 degrees from the
// grid like the runway it serves. In a frame turned by that angle every edge
// of the ring is axis aligned to a few centimetres, so the plan is written in
// it: u runs east along the building, v runs south across it (landside is
// negative v, the apron positive). (u, v) = (0, 0) is the middle of the glass
// hall.
//
//   the glass hall    u -35.95..34.60, v -22.60..23.20, two storeys, 10.6 m
//   the entrance      u -15.60..14.20, v -25.30..-22.60, the white porch with
//                     the sign "LETIŠTĚ PARDUBICE – TERMINÁL JANA KAŠPARA"
//   the west wing     u -90.90..-35.95, v -10.70..19.95, one storey, arrivals
//   the east wing     u  34.60..68.55, v -10.70..19.95, one storey, gates 1, 2
//
// What the photographs of the finished building show (airport-pardubice.cz,
// read 21 Nov 2026): a reflective blue-green curtain wall in three bands under a
// row of silver panels, a thin red line round the glazing, dark anthracite
// wings, inside light grey 60 cm floor tiles, white walls banded light grey,
// red and dark grey at 2.5 m, exposed steel trusses and silver ducts under the
// roof, a gallery with a glass balustrade over the check-in counters, red
// queue belts, grey perforated bench seats, the sign "GATE 1" over the lounge.
// Boarding is on foot across the apron: Pardubice has no jet bridges.

export const FRAME = { x: -2229.6, z: 1569.6, theta: 0.0478 };
const C = Math.cos(FRAME.theta),
  S = Math.sin(FRAME.theta);

/** Terminal frame → world metres. */
export function toWorld(u, v) {
  return { x: FRAME.x + u * C - v * S, z: FRAME.z + u * S + v * C };
}
/** World metres → terminal frame. */
export function toLocal(x, z) {
  const dx = x - FRAME.x,
    dz = z - FRAME.z;
  return { u: dx * C + dz * S, v: dz * C - dx * S };
}
/** A heading (ARCHITECTURE.md: 0 faces −z, a machine yawed by h moves along
 *  (−sin h, −cos h)) that looks along +u, the building's east. */
export const HEADING_U = -Math.PI / 2 - FRAME.theta;

// ---- the building -----------------------------------------------------------
export const H = {
  hall: 10.6, // the glass hall's parapet
  wing: 5.6, // the two wings
  porch: 4.4, // the entrance
  gallery: 4.8, // the first floor's slab over the back of the hall
  door: 2.6, // clear height of every door
};
const box = (u0, u1, v0, v1) => ({ u0, u1, v0, v1 });
export const PARTS = {
  hall: box(-35.95, 34.6, -22.6, 23.2),
  porch: box(-15.6, 14.2, -25.3, -22.6),
  west: box(-90.9, -35.95, -10.7, 19.95),
  east: box(34.6, 68.55, -10.7, 19.95),
};
/** The gallery (first floor) covers the hall behind this line. */
export const GALLERY_V = 7;

/** Is (u, v) inside the building (any part)? */
export function inBuilding(u, v, pad = 0) {
  for (const k in PARTS) {
    const b = PARTS[k];
    if (u > b.u0 - pad && u < b.u1 + pad && v > b.v0 - pad && v < b.v1 + pad) return true;
  }
  return false;
}
/** The underside of what is overhead at (u, v): the camera stays below it. */
export function ceilingAt(u, v) {
  const { hall, porch } = PARTS;
  if (u > porch.u0 && u < porch.u1 && v > porch.v0 && v < porch.v1) return H.porch - 0.5;
  if (u > hall.u0 && u < hall.u1 && v > hall.v0 && v < hall.v1) return v > GALLERY_V ? H.gallery - 0.35 : H.hall - 1.6;
  return H.wing - 0.6;
}

// Doors in the outside walls: { id, side ('n' | 's'), u (centre), w, v (the wall) }.
// The two main doors are the porch's glazed sliding pairs; the gates and the
// arrivals door open onto the apron, where the OSM footways from the stands
// meet the building (u 57.6 and u -63.4).
export const DOORS = [
  { id: 'main-w', side: 'n', u: -5, v: -25.3, w: 2.4 },
  { id: 'main-e', side: 'n', u: 5, v: -25.3, w: 2.4 },
  { id: 'gate1', side: 's', u: 42, v: 19.95, w: 2.0 },
  { id: 'gate2', side: 's', u: 57.6, v: 19.95, w: 2.0 },
  { id: 'arrivals', side: 's', u: -63.4, v: 19.95, w: 2.4 },
];

// Walls inside, as segments in the frame { a: [u, v], b: [u, v], top }.
// Landside (the check-in hall) is v < 7 west of the security lanes; airside
// is the departure lounge (v > 13) and the east wing's gate lounges; the west
// wing is the arrivals hall, which lets out into the check-in hall.
export const WALLS = [
  // behind the counters: the baggage room between v 7 and 13
  { a: [-35.95, 7], b: [18, 7], top: H.gallery },
  { a: [-35.95, 13], b: [18, 13], top: H.gallery },
  // the security lanes: a wall each side and a divider between them
  { a: [18, 7], b: [18, 13], top: H.gallery },
  { a: [24.6, 7.6], b: [24.6, 12.4], top: 1.2 },
  { a: [32, 7], b: [32, 13], top: H.gallery },
  { a: [32, 7], b: [34.6, 7], top: H.gallery },
  { a: [32, 13], b: [34.6, 13], top: H.gallery },
  // the hall's east side against the wing: offices, then the open way to the gates
  { a: [34.6, -10.7], b: [34.6, 13], top: H.wing },
  { a: [34.6, 2], b: [68.55, 2], top: H.wing },
  // the hall's west side against the arrivals hall, with its way out
  { a: [-35.95, -10.7], b: [-35.95, -6.6], top: H.wing },
  { a: [-35.95, -3.4], b: [-35.95, 19.95], top: H.wing },
  // the gate lounges: a glass screen between gate 1 and gate 2
  { a: [50.5, 2], b: [50.5, 12], top: H.wing - 0.6, glass: true },
];
/** The way out of the arrivals hall into the check-in hall (a gap in WALLS). */
export const ARRIVALS_EXIT = { u: -35.95, v: -5, w: 3.2 };

// ---- check-in, security, gates ----------------------------------------------
// Eight counters under the gallery's edge, facing the doors (−v): the
// passenger stands at v ≈ 3, the agent sits at v ≈ 5, the belt runs behind.
export const COUNTERS = Array.from({ length: 8 }, (_, i) => ({ no: i + 1, u: -30 + i * 4, v: 4.6 }));
export const COUNTER = { w: 2.2, d: 0.9, h: 1.05 };
/** The counter open for the flight to the Seychelles (the rest stay dark). */
export const MAHE_COUNTERS = [3, 4];

// The two security lanes: the walk-through arch on the walker's line and the
// X-ray belt beside it. `u` is the walker's line through the arch.
export const LANES = [
  { u: 20.6, belt: 22.9, v0: 7, v1: 13, arch: 10 },
  { u: 27.2, belt: 29.6, v0: 7, v1: 13, arch: 10 },
];

// Gates: the agent's desk in the lounge and the door to the apron.
export const GATES = [
  { id: '1', door: 'gate1', desk: { u: 39.2, v: 17.4 }, seats: { u0: 37, u1: 49, v0: 5, v1: 14 } },
  { id: '2', door: 'gate2', desk: { u: 54.8, v: 17.4 }, seats: { u0: 52.5, u1: 66.5, v0: 5, v1: 14 } },
];
/** The gate the Seychelles flight leaves from. */
export const MAHE_GATE = '2';

// Where the departure boards hang (u, v, y, facing: heading of the screen's
// normal in the frame, 0 = toward −v): the totem by the doors, the row over
// the counters and the one at the gates.
export const BOARDS = [
  { id: 'totem', u: -9, v: -16, y: 2.6, face: Math.PI, w: 1.6, h: 0.95 },
  { id: 'hall', u: -14, v: 6.6, y: 5.7, face: 0, w: 3.2, h: 1.0 },
  { id: 'gates', u: 46, v: 2.2, y: 3.2, face: Math.PI, w: 2.4, h: 0.75 },
];

/** Which part of the plan (u, v) is in: 'landside', 'security', 'airside', 'arrivals', 'staff' or null. */
export function zoneAt(u, v) {
  if (!inBuilding(u, v)) return null;
  if (u < PARTS.hall.u0) return 'arrivals';
  if (u > PARTS.east.u0) return v < 2 ? 'staff' : 'airside';
  if (v > 13) return 'airside';
  if (v > 7) return u > 18 && u < 32 ? 'security' : 'staff';
  return 'landside';
}

// ---- the apron, the stand and the way to the runway ---------------------------
// Runway 09/27, 2 499 m x 75 m (OSM, as in js/airfield.js). 09 is flown east,
// 27 west. The prevailing wind over Polabí is westerly, so arrivals land on 27
// and roll out toward the terminal; departures to the south-east leave from 09,
// a short taxi from the civil apron.
export const RUNWAY = {
  ref: '09/27',
  a: [-2504, 1971], // threshold 09, the west end
  b: [-7, 2091], // threshold 27, the east end
  mid: [-769, 2053], // the kink the OSM way has
  width: 75,
};

// The narrowbody's stand: the top of the turning loop the OSM stand markings
// draw east of the terminal, nose east, its front door (L1) facing the
// building. `x, z` is the main gear, which is where js/airliner.js puts its
// origin. The OSM footway from gate 2 ends 22 m west of the airstairs.
export const STAND = { x: -2174, z: 1657, heading: HEADING_U };

// Taxi routes as polylines in world metres, every point a mapped OSM taxiway
// vertex or the middle of a fillet between two of them.
// Out: round the stand loop, south onto the parallel taxiway, west to the end
// of it and down the link to the threshold of 09.
export const TAXI_OUT = [
  [-2174, 1657], [-2160, 1655], [-2148, 1658], [-2140, 1665], [-2135, 1684], [-2137, 1692], [-2140, 1698],
  [-2145, 1704], [-2147, 1714], [-2154, 1726], [-2168, 1731.4], [-2183, 1731.6], [-2300, 1726.1],
  [-2449, 1719], [-2459, 1720], [-2467, 1724], [-2474, 1729], [-2479, 1737], [-2481, 1747], [-2487, 1880],
  [-2490, 1924], [-2488, 1941], [-2484, 1952], [-2476, 1962], [-2464, 1969], [-2454, 1973.3], [-2440, 1974],
];
/** Where the take-off roll starts (on the centreline, facing 09) and how long the runway is from there. */
export const LINEUP = { x: -2440, z: 1974 };
// In: off 27 at the high-speed link, north to the parallel taxiway, east to
// the stand's lead-in line and round onto the stand.
export const TAXI_IN = [
  [-1620, 2012], [-1658, 2010], [-1690, 2009], [-1722, 2007], [-1739, 2000], [-1748, 1992], [-1754, 1982],
  [-1757, 1970], [-1753, 1880], [-1747, 1779], [-1752, 1766], [-1762, 1757], [-1773, 1751], [-1900, 1745],
  [-2050, 1738], [-2170, 1732.4], [-2181, 1729], [-2182, 1700], [-2181, 1676], [-2178, 1664], [-2174, 1657],
];
/** The taxiway leaves the runway here (27 is flown west, so this is past the touchdown zone). */
export const EXIT_27 = { x: -1620, z: 2012 };

// Spawns other modules may name (js/regions.js of the Mahé work):
//   'pce-airport'  on foot on the landside forecourt, facing the doors
//   'pce-arrival'  on final for 27, 9 km out, 715 m (absolute: the field is ~225 m)
export const SPAWNS = {
  'pce-airport': { x: -2229.4, z: 1530.5, heading: Math.PI },
  'pce-arrival': { x: 8980, z: 2520, y: 715, heading: Math.PI / 2 - 0.0475 },
};

/** How js/landmarks.js recognises the footprint: its OSM name, centroid and area (6 022 m2). */
export const OSM_NAME = 'Letiště Pardubice - Terminál Jana Kašpara';
export const AT = [-2238.9, 1571.2];
export const AREA = 6022;

// The baggage carousel of the arrivals hall, centred (u, v), w long along u and
// d deep (added with the terminal model: the photographs show it in the hall,
// the plan had no place for it). It stands clear of the arrivals door and of
// the way out at ARRIVALS_EXIT.
export const CAROUSEL = { u: -74, v: 4, w: 9, d: 3.2 };
