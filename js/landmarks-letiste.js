// ---- landmarks-letiste.js: Terminál Jana Kašpara, its outside and its solids ----
// WORKER SAFE (it is in the mesher's import graph through js/landmarks.js): pure
// maths and the kit, no DOM, no clock, no Math.random. The same builder runs on
// both threads and must emit the same triangles in the same order.
//
// Everything here is written in the terminal's own frame (js/airport-plan.js):
// u east along the building, v south across it, the glass hall's middle at
// (0, 0). The model is built ON the plan rather than on the OSM ring, so a tile
// rebuild that nudges the footprint by a metre moves nothing inside the building,
// and the counters and doors the walker uses are where the plan says they are.
//
// The shell is the OUTSIDE only: each wall once, on the face the world sees.
// The inside of those walls (the banding, the ceiling, the floor, the inner
// partitions) belongs to the near set (js/airport-terminal.js), which only
// exists beside the player, so the far model carries no triangles it would
// never show. Doors are real holes in the shell so a walker can go through
// them; the glass and the sliding leaves in those holes are the near set's.

import { K } from './landmarkskit.js';
import { Frame } from './landmarksframe.js';
import { FRAME, H, PARTS, DOORS, WALLS, COUNTERS, COUNTER, MAHE_COUNTERS, LANES, GATES, CAROUSEL, GALLERY_V } from './airport-plan.js';

const C = Math.cos(FRAME.theta), S = Math.sin(FRAME.theta);
/** The terminal frame as a Frame: local (u, v) is the plan's (u, v). `kit` may be null (solids only). */
export function frameOf(kit) { return new Frame(kit, FRAME.x, FRAME.z, -S, C, 0); }

// ---- the outside, wall by wall ----------------------------------------------
// One entry per outside face: a → b along it in the frame, n the outward normal
// (frame components), top the wall's height, face how it is dressed, doors the
// ids of the DOORS that open in it. The walls that are not outside (the
// partitions and the arrivals wall) are WALLS in the plan.
const GLASS = 'glass', WALL = 'wall', PORCH = 'porch', WING = 'wing', UPPER = 'upper';
const seg = (a, b, n, face, top, doors = []) => ({ a, b, n, face, top, doors });
export const OUTSIDE = [
  // the entrance: its north face and sides, and the glass hall's north face behind it
  seg([-15.6, -25.3], [14.2, -25.3], [0, -1], PORCH, H.porch, ['main-w', 'main-e']),
  seg([-15.6, -22.6], [-15.6, -25.3], [-1, 0], PORCH, H.porch),
  seg([14.2, -25.3], [14.2, -22.6], [1, 0], PORCH, H.porch),
  seg([-35.95, -22.6], [34.6, -22.6], [0, -1], GLASS, H.hall, ['main-w', 'main-e']),
  // the glass hall's ends, north and south of the wings' line: the curtain wall
  // wraps the corners (the airport's photograph from the east shows it)
  seg([-35.95, -22.6], [-35.95, -10.7], [-1, 0], GLASS, H.hall),
  seg([-35.95, 19.95], [-35.95, 23.2], [-1, 0], GLASS, H.hall),
  seg([34.6, -22.6], [34.6, -10.7], [1, 0], GLASS, H.hall),
  seg([34.6, 19.95], [34.6, 23.2], [1, 0], GLASS, H.hall),
  // ...and its sides over the wings' roofs: the first floor's glass above the anthracite
  seg([-35.95, 19.95], [-35.95, -10.7], [-1, 0], UPPER, H.hall),
  seg([34.6, -10.7], [34.6, 19.95], [1, 0], UPPER, H.hall),
  // the airside face: the glazing of the first floor and the lounge
  seg([34.6, 23.2], [-35.95, 23.2], [0, 1], GLASS, H.hall),
  // the east wing (gates 1 and 2)
  seg([34.6, -10.7], [68.55, -10.7], [0, -1], WING, H.wing),
  seg([68.55, -10.7], [68.55, 19.95], [1, 0], WING, H.wing),
  seg([68.55, 19.95], [34.6, 19.95], [0, 1], WING, H.wing, ['gate1', 'gate2']),
  // the west wing (arrivals)
  seg([-90.9, -10.7], [-35.95, -10.7], [0, -1], WING, H.wing),
  seg([-90.9, 19.95], [-90.9, -10.7], [-1, 0], WING, H.wing),
  seg([-35.95, 19.95], [-90.9, 19.95], [0, 1], WING, H.wing, ['arrivals']),
];

// Surface colours, sRGB. Plaster is the white of the porch and the hall ends,
// the anthracite is the wings' sandwich panel, the curtain wall a blue-green
// reflective glass with dark silver mullions drawn by the shader.
const PLASTER = 0xe9e7df, BAND = 0x4a5057, SILVER = 0xb7bfc5, RED = 0xc4222c;
const COPING = 0x8c9296, CURTAIN = 0x2c6670, ANTHRACITE = 0x33373c, ROOF = 0x8e9399, PLANT = 0xa6abaf;
// the curtain wall's mullions and transoms: dark silver, so the glass reads as one sheet
const MULLION = 0x40464c;
const SERVICE = 0x9ea3a7;
/** Where the curtain wall stops and the silver parapet band starts, metres above the ground. */
const GLASS_TOP = 9.0;
/** The glazing's bays: about 1.6 m, the mullions every bay. Three bands of lights with the mullions between. */
const CURTAIN_SP = {
  pitch: 1.6,
  rows: [
    { y: 0.0, h: 3.0, w: 1.9, hex: CURTAIN },
    { y: 3.2, h: 2.8, w: 1.9, hex: CURTAIN },
    { y: 6.2, h: 2.8, w: 1.9, hex: CURTAIN },
  ],
  seed: 3,
};
/** The same glass over a wing's roof: the first floor's band only. */
const CURTAIN_UPPER = { pitch: 1.6, rows: [{ y: 0.35, h: GLASS_TOP - H.wing - 0.55, w: 1.9, hex: CURTAIN }], seed: 5 };

// ---- the openings in a face -------------------------------------------------
/** Where the doors of a face sit along it: [{ s0, s1, top }] from a, sorted. */
export function gapsOf(s) {
  const L = segLen(s), ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L;
  const out = [];
  for (const id of s.doors) {
    const d = DOORS.find((x) => x.id === id);
    // the door's centre projected on the face: a door set back a metre (the
    // porch's doors stand in the porch's north face, the hall's glass behind)
    const c = (d.u - s.a[0]) * ux + (d.v - s.a[1]) * uy;
    out.push({ s0: c - d.w / 2, s1: c + d.w / 2, top: H.door });
  }
  return out.sort((p, q) => p.s0 - q.s0);
}
const segLen = (s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

/**
 * One storey-band of a face, from y0 to y1, with its doors cut out. Each run
 * between doors is a wallGrid (sp) or a plain wall (sp null); a door's lintel is
 * a plain wall above it, and its two reveals are drawn into the thickness.
 * `off` lifts the whole band off the face (a red line, a service panel).
 */
function faceWall(kit, F, s, y0, y1, sp, off = 0) {
  const L = segLen(s), ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L;
  const N = F.dir(s.n[0], s.n[1]);
  // a point on the face, t metres from a, pushed `d` metres along the outward normal
  const xz = (t, d) => F.xz(s.a[0] + ux * t + s.n[0] * d, s.a[1] + uy * t + s.n[1] * d);
  const run = (t0, t1, ya, yb, spec) => {
    if (t1 - t0 < 0.02 || yb - ya < 0.02) return;
    const p = xz(t0, off), q = xz(t1, off);
    if (spec) kit.wallGrid(p, q, ya, yb, N[0], N[1], spec);
    else kit.wall(p, q, ya, yb, N[0], N[1]);
  };
  // the reveal of a door: the thickness of the wall, facing into the opening
  const reveal = (t, dir, top) => {
    const [fx, fz] = F.dir(ux * dir, uy * dir);
    const A = xz(t, off), B = xz(t, off - 0.3);
    kit.quad([A[0], y0, A[1]], [B[0], y0, B[1]], [B[0], top, B[1]], [A[0], top, A[1]], fx, 0, fz);
  };
  let at = 0;
  for (const g of gapsOf(s)) {
    if (g.top <= y0) continue;               // a door under this band: nothing to cut
    run(at, g.s0, y0, y1, sp);
    run(g.s0, g.s1, g.top, y1, null);
    reveal(g.s0, 1, Math.min(g.top, y1));
    reveal(g.s1, -1, Math.min(g.top, y1));
    at = g.s1;
  }
  run(at, L, y0, y1, sp);
}

/** A grey service leaf, flush on a face: from t0 to t1 metres along it, up to y1. Drawn as a
 *  plain panel, not cut into the wall, so the shell stays one skin there. */
function servicePanel(kit, F, s, t0, t1, y1) {
  const L = segLen(s), ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L;
  const xz = (t) => F.xz(s.a[0] + ux * t + s.n[0] * 0.03, s.a[1] + uy * t + s.n[1] * 0.03);
  const N = F.dir(s.n[0], s.n[1]);
  kit.set(SERVICE, K.metal);
  kit.wall(xz(t0), xz(t1), 0, y1, N[0], N[1]);
}

/** Paint one outside face: its skin, its parapet, its coping. */
function drawFace(kit, F, s) {
  if (s.face === GLASS) {
    kit.set(MULLION, K.metal);
    faceWall(kit, F, s, 0, GLASS_TOP, CURTAIN_SP);
    kit.set(SILVER, K.metal);
    faceWall(kit, F, s, GLASS_TOP, s.top, null);
    kit.set(RED, K.plaster);
    faceWall(kit, F, s, GLASS_TOP - 0.05, GLASS_TOP + 0.12, null, 0.05);
  } else if (s.face === UPPER) {
    kit.set(MULLION, K.metal);
    faceWall(kit, F, s, H.wing, GLASS_TOP, CURTAIN_UPPER);
    kit.set(SILVER, K.metal);
    faceWall(kit, F, s, GLASS_TOP, s.top, null);
    kit.set(RED, K.plaster);
    faceWall(kit, F, s, GLASS_TOP - 0.05, GLASS_TOP + 0.12, null, 0.05);
  } else if (s.face === PORCH) {
    kit.set(PLASTER, K.plaster);
    faceWall(kit, F, s, 0, 3.5, null);
    // the dark band that carries the sign: on the north face, where the lettering is
    if (s.n[1] === -1) { kit.set(BAND, K.metal); faceWall(kit, F, s, 3.5, 4.0, null, 0.02); }
    kit.set(PLASTER, K.plaster);
    faceWall(kit, F, s, s.n[1] === -1 ? 4.0 : 0, s.top, null);
  } else if (s.face === WING) {
    kit.set(ANTHRACITE, K.panel);
    faceWall(kit, F, s, 0, s.top, null);
  } else {
    kit.set(PLASTER, K.panel);
    faceWall(kit, F, s, 0, s.top, null);
  }
  kit.set(COPING, K.metal);
  faceWall(kit, F, s, s.top, s.top + 0.3, null);
}

/**
 * The shell: every outside face, the flat roofs with their plant, and the grey
 * service doors of the wings. Heights are above the landmark's ground.
 */
export function buildLetiste(kit) {
  const F = frameOf(kit);
  for (const s of OUTSIDE) drawFace(kit, F, s);
  // the service doors: two grey leaves on the west wing's north face
  const westNorth = OUTSIDE.find((s) => s.face === WING && s.a[0] === -90.9 && s.n[1] === -1);
  for (const u of [-80, -50]) servicePanel(kit, F, westNorth, u + 90.9, u + 92.1, 2.3);
  // roofs, each part one flat lid, and the plant boxes the photographs show on them
  kit.set(ROOF, K.metal);
  for (const [k, top] of [['hall', H.hall], ['porch', H.porch], ['west', H.wing], ['east', H.wing]]) {
    const p = PARTS[k];
    F.flat(p.u0, p.u1, p.v0, p.v1, top, true);
  }
  kit.set(PLANT, K.metal);
  const plant = [
    [-28, -24, -14, -10, H.hall, H.hall + 1.2], [4, 8, 4, 8, H.hall, H.hall + 0.8],
    [44, 48, -6, -2, H.wing, H.wing + 1.0], [58, 62, 8, 11, H.wing, H.wing + 0.8],
    [-80, -74, 2, 6, H.wing, H.wing + 1.0], [-60, -56, 12, 15, H.wing, H.wing + 0.6],
  ];
  for (const [u0, u1, v0, v1, y0, y1] of plant) F.box(u0, u1, v0, v1, y0, y1, null, true, false);
}

// ---- the solids -------------------------------------------------------------
// Collision as city.collide reads it: a piece with bot 0 stops a walker, a piece
// with bot above the walker's height is walked under. Every outside wall is a
// thin strip on its inner side, and a door is the same strip standing from the
// lintel (bot H.door) down to nothing, so the gap is open to walk through.
const RAY = 0.3;                 // the strip's thickness, into the building
/** A rectangle of the frame as a solid piece (world [x, z] ring). */
const box = (F, u0, u1, v0, v1, top, bot = 0) => ({ ring: F.ring(u0, u1, v0, v1), holes: null, top, bot });

/**
 * What of the terminal is solid, as landmarkSolids pieces: the outside walls
 * with their doors, the partitions of the plan, the roof slabs, the gallery,
 * and the furniture a walker cannot pass through (counters, queue posts, the
 * security arches and X-ray tunnels, the gate desks, the bench rows, the shops,
 * the carousel). Heights are above the landmark's ground.
 */
export function letisteSolids() {
  const F = frameOf(null);
  const out = [];
  const xz = (s, t, d) => {
    const L = segLen(s), ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L;
    return F.xz(s.a[0] + ux * t + s.n[0] * d, s.a[1] + uy * t + s.n[1] * d);
  };
  const strip = (s, t0, t1, bot, top) => {
    if (t1 - t0 < 0.02) return;
    out.push({ ring: [xz(s, t0, 0.05), xz(s, t1, 0.05), xz(s, t1, -RAY), xz(s, t0, -RAY)], holes: null, top, bot });
  };
  // the outside walls, cut at their doors (the hall's sides over the wings
  // stand on the wings' roofs: the way from the lounge to the gates runs under them)
  for (const s of OUTSIDE) {
    const foot = s.face === UPPER ? H.wing : 0;
    let at = 0;
    for (const g of gapsOf(s)) {
      strip(s, at, g.s0, foot, s.top);
      strip(s, g.s0, g.s1, g.top, s.top);
      at = g.s1;
    }
    strip(s, at, segLen(s), foot, s.top);
  }
  // the partitions of the plan, 0.3 m thick, centred on their line
  for (const w of WALLS) {
    const [a, b] = [w.a, w.b], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nu = -(b[1] - a[1]) / L * 0.15, nv = (b[0] - a[0]) / L * 0.15;
    out.push({
      ring: [F.xz(a[0] + nu, a[1] + nv), F.xz(b[0] + nu, b[1] + nv), F.xz(b[0] - nu, b[1] - nv), F.xz(a[0] - nu, a[1] - nv)],
      holes: null, top: w.top, bot: 0,
    });
  }
  // the roof slabs and the gallery's floor: walked under, never through
  out.push(box(F, PARTS.hall.u0, PARTS.hall.u1, PARTS.hall.v0, PARTS.hall.v1, H.hall, H.hall - 0.5));
  out.push(box(F, PARTS.porch.u0, PARTS.porch.u1, PARTS.porch.v0, PARTS.porch.v1, H.porch, H.porch - 0.5));
  out.push(box(F, PARTS.west.u0, PARTS.west.u1, PARTS.west.v0, PARTS.west.v1, H.wing, H.wing - 0.5));
  out.push(box(F, PARTS.east.u0, PARTS.east.u1, PARTS.east.v0, PARTS.east.v1, H.wing, H.wing - 0.5));
  // (its underside is the plan's ceilingAt, H.gallery - 0.35: the camera keeps below it)
  out.push(box(F, PARTS.hall.u0, PARTS.hall.u1, GALLERY_V, PARTS.hall.v1, H.gallery, H.gallery - 0.35));
  // the check-in counters: the desk, its belt behind it, and the queue posts in
  // front of the open ones (the posts are the only solid of a queue belt)
  for (const c of COUNTERS) {
    out.push(box(F, c.u - COUNTER.w / 2, c.u + COUNTER.w / 2, c.v - COUNTER.d / 2, c.v + COUNTER.d / 2, COUNTER.h));
    // the belt runs behind the agent's chair (the chair stands at v + 0.8, not solid)
    out.push(box(F, c.u - 1.1, c.u + 1.1, c.v + 1.4, c.v + 2.0, 0.85));
    if (MAHE_COUNTERS.includes(c.no))
      for (const du of [-1.1, 1.1]) out.push(box(F, c.u + du - 0.06, c.u + du + 0.06, 1.94, 2.06, 1.1));
  }
  // the security lanes: the arch's two posts and its cross bar (walked under),
  // and the X-ray tunnel beside the walker's line
  for (const L of LANES) {
    for (const du of [-0.5, 0.5]) out.push(box(F, L.u + du - 0.06, L.u + du + 0.06, L.arch - 0.06, L.arch + 0.06, 2.2));
    out.push(box(F, L.u - 0.5, L.u + 0.5, L.arch - 0.05, L.arch + 0.05, 2.2, 2.0));
    out.push(box(F, L.belt - 0.45, L.belt + 0.45, L.v0 + 1, L.v1 - 1, 1.1));
  }
  // the gate desks, the bench rows of each lounge, the shops and the carousel
  for (const g of GATES) {
    out.push(box(F, g.desk.u - 1, g.desk.u + 1, g.desk.v - 0.4, g.desk.v + 0.4, 1.1));
    for (let v = g.seats.v0 + 1; v <= g.seats.v1 - 1.5; v += 2)
      out.push(box(F, g.seats.u0 + 1, g.seats.u1 - 1, v - 0.3, v + 0.3, 0.45));
  }
  // the lounge's benches in the hall behind the lanes (js/airport-fit.js benchRow)
  for (const v of [15.5, 18.5]) for (const [u0, u1] of [[-30, -16], [-12, 2]]) out.push(box(F, u0, u1, v - 0.3, v + 0.3, 0.45));
  out.push(box(F, 32.2, 34.2, 10.2, 11.2, 1.1));           // the agent's desk beside the lanes
  out.push(box(F, -9.5, -8.5, -16.2, -15.8, 1.2));         // the totem's pedestal
  out.push(box(F, 40, 46, 2.4, 3.2, 1.1));                 // the duty-free front
  out.push(box(F, 56, 63, 2.4, 3.2, 1.1));                 // the café counter
  out.push(box(F, CAROUSEL.u - CAROUSEL.w / 2, CAROUSEL.u + CAROUSEL.w / 2, CAROUSEL.v - CAROUSEL.d / 2, CAROUSEL.v + CAROUSEL.d / 2, 0.9));
  return out;
}
