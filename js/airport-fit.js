// ---- airport-fit.js: the things a passenger uses, as stationKit boxes ----
// Main thread only (js/airport-terminal.js draws it once, near the player). The
// counters, the security lanes, the gate desks, the bench rows, the shops, the
// baggage carousel and the totem, and the props outside the terminal that its
// own signs are read from (the HOCKEYTOWN panel, the flagpoles). Plan coordinates
// through js/airport-ctx.js; the solids of the same things are in
// js/landmarks-letiste.js letisteSolids, so a passenger meets the desk he sees.

import { plate } from './stationkit.js';
import { COUNTERS, COUNTER, MAHE_COUNTERS, LANES, GATES, CAROUSEL, PARTS, BOARDS } from './airport-plan.js';
import { FACE } from './airport-ctx.js';

/** The check-in row: the desk, its screen on a post, the chair, the bag belt and the number. */
function counters(ctx) {
  const { w, d, h } = COUNTER;
  for (const c of COUNTERS) {
    const open = MAHE_COUNTERS.includes(c.no);
    ctx.box(c.u - w / 2, c.u + w / 2, c.v - d / 2, c.v + d / 2, 0, h - 0.12, 'white');
    ctx.box(c.u - w / 2 - 0.02, c.u + w / 2 + 0.02, c.v - d / 2 - 0.02, c.v + d / 2 + 0.02, h - 0.12, h, 'steel');
    // the red accent along the passenger side, the way the real row is faced
    ctx.box(c.u - w / 2, c.u + w / 2, c.v - d / 2 - 0.03, c.v - d / 2, 0.25, 0.55, 'red');
    // the screen on its post, lit only when the desk is open
    ctx.box(c.u + 0.7, c.u + 0.8, c.v - 0.1, c.v + 0.1, h, h + 0.55, 'steel');
    ctx.box(c.u + 0.45, c.u + 1.05, c.v - 0.16, c.v - 0.1, h + 0.25, h + 0.75, open ? 'screen' : 'dark');
    // the black chair the agent sits on, behind the desk
    ctx.box(c.u - 0.35, c.u + 0.35, c.v + 0.6, c.v + 1.0, 0.45, 0.5, 'dark');
    ctx.box(c.u - 0.35, c.u + 0.35, c.v + 1.0, c.v + 1.08, 0.5, 1.0, 'dark');
    // the bag belt behind the desk: a steel bed on its rollers
    ctx.box(c.u - 1.1, c.u + 1.1, c.v + 1.4, c.v + 2.0, 0.7, 0.85, 'steel');
    // the number, hung over the desk on the passenger side
    ctx.plate(c.u, c.v - 0.6, 2.35, FACE.n, 1.4, 0.55, 512,
      plate([String(c.no)], open ? '#c4222c' : '#2a2f33', '#ffffff', 700), 'counter-' + c.no);
  }
}

/** The queue belts in front of the open desks: chrome posts and the red tape between them. */
function queues(ctx) {
  for (const c of COUNTERS) {
    if (!MAHE_COUNTERS.includes(c.no)) continue;
    for (const du of [-1.1, 1.1]) ctx.box(c.u + du - 0.06, c.u + du + 0.06, 1.94, 2.06, 0, 1.1, 'steel');
    ctx.box(c.u - 1.1, c.u + 1.1, 1.98, 2.02, 0.95, 1.0, 'red');
  }
}

/** The two security lanes: the arch, the X-ray tunnel with its belt and roller tables, the trays. */
function lanes(ctx) {
  for (const L of LANES) {
    const v0 = L.arch - 0.06, v1 = L.arch + 0.06;
    for (const du of [-0.5, 0.5]) ctx.box(L.u + du - 0.06, L.u + du + 0.06, v0, v1, 0, 2.2, 'steel');
    ctx.box(L.u - 0.5, L.u + 0.5, v0, v1, 2.0, 2.2, 'steel');
    // the X-ray housing, its screen on the entry end, the belt through it
    ctx.box(L.belt - 0.45, L.belt + 0.45, L.v0 + 1, L.v1 - 1, 0, 1.1, 'dark');
    ctx.box(L.belt - 0.5, L.belt + 0.5, L.v0 + 0.9, L.v0 + 1.0, 0.5, 0.95, 'screen');
    ctx.box(L.belt - 0.3, L.belt + 0.3, L.v0 + 1, L.v1 - 1, 0.74, 0.8, 'dark');
    // roller tables either side of the belt, and the grey trays stacked on the entry one
    for (const side of [-1, 1]) {
      ctx.box(L.belt + side * 0.9 - 0.45, L.belt + side * 0.9 + 0.45, L.v0 + 1, L.v1 - 1, 0.72, 0.76, 'steel');
    }
    for (let i = 0; i < 3; i++) ctx.box(L.belt - 1.35, L.belt - 0.55, L.v0 + 1.2, L.v0 + 1.7, 0.76 + i * 0.05, 0.81 + i * 0.05, 'steel');
  }
  // the agent's desk beside the lanes, on the staff side of the wall
  ctx.box(32.2, 34.2, 10.2, 11.2, 0, 1.05, 'white');
  ctx.box(32.2, 34.2, 10.2, 11.2, 1.05, 1.1, 'steel');
}

/** The gate desks and the bench rows of each lounge. */
function gates(ctx) {
  for (const g of GATES) {
    ctx.box(g.desk.u - 1, g.desk.u + 1, g.desk.v - 0.4, g.desk.v + 0.4, 0, 1.1, 'white');
    ctx.box(g.desk.u - 1.05, g.desk.u + 1.05, g.desk.v - 0.45, g.desk.v + 0.45, 1.1, 1.15, 'steel');
    // the gate's name on the desk front, the side the passengers come to it from
    ctx.plate(g.desk.u, g.desk.v - 0.42, 0.75, FACE.n, 1.6, 0.42, 512,
      plate(['GATE ' + g.id], '#1e2327', '#ffd23f', 700), 'desk-' + g.id);
    // the grey perforated benches: seats on a beam, facing the gate
    for (let v = g.seats.v0 + 1; v <= g.seats.v1 - 1.5; v += 2) benchRow(ctx, g.seats.u0 + 1, g.seats.u1 - 1, v, 1);
  }
  // and the lounge in the hall behind the lanes, under the gallery, facing the apron glass
  for (const v of [15.5, 18.5]) for (const [u0, u1] of [[-30, -16], [-12, 2]]) benchRow(ctx, u0, u1, v, 1);
}

/**
 * A row of airport seats from u0 to u1 at v, facing +v (face 1) or -v (-1):
 * the beam and its two feet, and per seat the pan, the back and an armrest,
 * the way the real ones in the gate lounges are built (one beam, 4 to 6
 * perforated grey seats, chrome arms).
 */
function benchRow(ctx, u0, u1, v, face) {
  const PITCH = 0.62, n = Math.max(1, Math.floor((u1 - u0) / PITCH));
  const at = u0 + ((u1 - u0) - n * PITCH) / 2;
  const back = v - face * 0.24;
  ctx.box(u0, u1, v - 0.05, v + 0.05, 0.3, 0.36, 'steel');
  for (const u of [u0 + 0.2, u1 - 0.2]) ctx.box(u - 0.05, u + 0.05, v - 0.22, v + 0.22, 0, 0.3, 'steel');
  for (let i = 0; i < n; i++) {
    const c = at + PITCH * (i + 0.5);
    ctx.box(c - 0.25, c + 0.25, v - 0.22, v + 0.22, 0.38, 0.44, 'airseat');
    ctx.box(c - 0.25, c + 0.25, back - 0.03, back + 0.03, 0.46, 0.92, 'airseat');
    ctx.box(c - PITCH / 2 - 0.02, c - PITCH / 2 + 0.02, v - 0.2, v + 0.15, 0.6, 0.64, 'steel');
  }
}

/** The duty-free front and the café counter of the airside lounge, with their fascias. */
function shops(ctx) {
  ctx.box(40, 46, 2.4, 3.2, 0, 1.1, 'white');
  ctx.box(40.1, 45.9, 3.2, 3.22, 0.3, 1.0, 'glass');
  ctx.box(40, 46, 3.2, 3.25, 1.1, 1.16, 'red');
  ctx.plate(43, 3.27, 1.75, FACE.s, 3.6, 0.5, 1024, plate(['DUTY FREE'], '#1b2f55', '#ffffff', 700), 'duty-free');
  ctx.box(56, 63, 2.4, 3.2, 0, 1.1, 'wood');
  ctx.box(56, 63, 3.2, 3.25, 1.1, 1.16, 'steel');
  ctx.plate(59.5, 3.27, 1.75, FACE.s, 3.6, 0.5, 1024, plate(['KAVÁRNA'], '#c4222c', '#ffffff', 700), 'cafe');
  for (const u of [57, 59.5, 62]) ctx.box(u - 0.15, u + 0.15, 3.9, 4.15, 0, 0.75, 'dark');
}

/** The carousel in the arrivals hall: the steel bed, the belt on it, the drum ends. */
function carousel(ctx) {
  const { u, v, w, d } = CAROUSEL;
  ctx.box(u - w / 2, u + w / 2, v - d / 2, v + d / 2, 0, 0.9, 'steel');
  ctx.box(u - w / 2 + 0.2, u + w / 2 - 0.2, v - d / 2 + 0.2, v + d / 2 - 0.2, 0.9, 0.95, 'dark');
  ctx.drum(u - w / 2 + d / 2, v, 0, 0.95, d, 'steel');
  ctx.drum(u + w / 2 - d / 2, v, 0, 0.95, d, 'steel');
}

/** The black totem by the doors, with its pictograms on the two faces (its screen is a board). */
function totem(ctx) {
  const t = BOARDS.find((b) => b.id === 'totem');
  const { u, v } = t;
  ctx.box(u - 0.5, u + 0.5, v - 0.2, v + 0.2, 0, 1.2, 'dark');
  ctx.box(u - 0.85, u + 0.85, v - 0.15, v + 0.15, 1.2, 3.6, 'dark');
  ctx.box(u - 0.9, u + 0.9, v - 0.15, v + 0.15, 3.6, 3.7, 'yellow');
  ctx.plate(u, v + 0.17, 1.45, FACE.s, 1.4, 0.5, 512, plate(['ODLETY / DEPARTURES'], '#111111', '#ffd23f', 700), 'totem-s');
  ctx.plate(u, v - 0.17, 1.45, FACE.n, 1.4, 0.5, 512, plate(['PŘÍJEZDY / ARRIVALS'], '#111111', '#ffd23f', 700), 'totem-n');
}

/** The props outside the building its own signs are read from: the HOCKEYTOWN panel and the flagpoles. */
function outside(ctx) {
  const w = PARTS.west;
  // the arrivals side's red panel, on the landside face of the west wing
  ctx.plate(-74, w.v0 - 0.08, 3.4, FACE.n, 9, 3.4, 2048,
    plate(['VÍTÁ VÁS', 'WELCOME TO', 'HOCKEYTOWN'], '#c8102e', '#ffffff', 800), 'hockeytown');
  ctx.box(-80, -68, -13.4, w.v0, 5.0, 5.3, 'dark');
  for (const u of [-79.5, -68.5]) ctx.box(u - 0.1, u + 0.1, -13.2, -13.0, 0, 5.0, 'steel');
  // three flagpoles at the east end, each with a red flag
  for (const v of [-7, 2, 11]) {
    ctx.drum(72, v, 0, 14, 0.14, 'steel');
    ctx.plate(72, v, 12.6, FACE.e, 2.4, 1.6, 512, plate([''], '#c8102e', '#ffffff', 700), 'flag-' + v);
  }
}

/** Every fitting of the terminal, in the order the stationKit batches them. */
export function buildFittings(ctx) {
  counters(ctx);
  queues(ctx);
  lanes(ctx);
  gates(ctx);
  shops(ctx);
  carousel(ctx);
  totem(ctx);
  outside(ctx);
}
