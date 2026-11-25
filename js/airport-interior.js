// ---- airport-interior.js: the rooms of the terminal, as stationKit boxes ----
// Main thread only, drawn once when the player comes within reach
// (js/airport-terminal.js). Everything is laid out in the plan's frame
// (js/airport-plan.js) through js/airport-ctx.js, so a wall drawn here is the wall
// the solids stand on: the banding follows the outside faces, the partitions are
// the plan's WALLS, the ceilings are the plan's ceilingAt.
//
// From the photographs: a light grey 60 cm floor; white walls banded light grey to
// 2.2 m, a red stripe, dark grey to 3.0 m, white above; the roof is exposed steel
// trusses under a ceiling, with silver ducts and round vents; the gallery is a
// slab over the back of the hall with a glass balustrade and a white fascia that
// says "letiště Pardubice".

import { plate } from './stationkit.js';
import { PARTS, WALLS, H, GALLERY_V } from './airport-plan.js';
import { OUTSIDE, gapsOf } from './landmarks-letiste.js';
import { FACE } from './airport-ctx.js';

// The wall banding from the floor up: [y0, y1, finish]. The last band runs to the ceiling.
const BANDS = [
  [0, 1.0, 'airgrey'],    // light grey to the hip
  [1.0, 2.05, 'airwall'], // white
  [2.05, 2.17, 'airred'], // the red stripe
  [2.17, 2.85, 'airdark'], // dark grey
  [2.85, Infinity, 'airwall'],
];
const WALL_DEPTH = 0.08;        // the banding stands this far off the outside face, into the hall
const PARTITION = 0.3;          // a partition wall's thickness
/** The opening in the baggage room's wall, where the two security lanes are (the plan's WALLS at v 7). */
const SECURITY = [18, 32];

const len = (s) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);

/** The plan rectangle of a face's band from t0 to t1 metres along it, pushed `d` metres inward. */
function rectOn(s, t0, t1, d) {
  const L = len(s), ux = (s.b[0] - s.a[0]) / L, uy = (s.b[1] - s.a[1]) / L;
  const p0 = [s.a[0] + ux * t0, s.a[1] + uy * t0], p1 = [s.a[0] + ux * t1, s.a[1] + uy * t1];
  // the face's line and the inward side of it (the outward normal is s.n)
  if (s.n[0] === 0) {
    const v0 = s.a[1], v1 = s.a[1] - s.n[1] * d;
    return [Math.min(p0[0], p1[0]), Math.max(p0[0], p1[0]), Math.min(v0, v1), Math.max(v0, v1)];
  }
  const u0 = s.a[0], u1 = s.a[0] - s.n[0] * d;
  return [Math.min(u0, u1), Math.max(u0, u1), Math.min(p0[1], p1[1]), Math.max(p0[1], p1[1])];
}

/** The banding of one outside face, cut where its doors are: a door's opening is left clear
 *  below its lintel, and the band carries on over it. */
function faceBands(ctx, s) {
  const L = len(s), gaps = gapsOf(s);
  const emit = (t0, t1, ya, yb, fin) => {
    if (t1 - t0 < 0.02 || yb - ya < 0.01) return;
    const [u0, u1, v0, v1] = rectOn(s, t0, t1, WALL_DEPTH);
    ctx.box(u0, u1, v0, v1, ya, yb, fin);
  };
  for (const [y0, y1, fin] of BANDS) {
    if (y0 >= s.top) continue;
    const top = Math.min(Number.isFinite(y1) ? y1 : s.top, s.top);
    let at = 0;
    for (const g of gaps) {
      emit(at, g.s0, y0, top, fin);
      if (top > g.top) emit(g.s0, g.s1, Math.max(y0, g.top), top, fin);
      at = g.s1;
    }
    emit(at, L, y0, top, fin);
  }
}

/** A partition on the plan's line, PARTITION thick, from the floor to its top. */
function partition(ctx, w) {
  const [a, b] = [w.a, w.b], fin = w.glass ? 'glass' : w.top < 2 ? 'steel' : 'airwall';
  if (a[1] === b[1]) {
    ctx.box(Math.min(a[0], b[0]), Math.max(a[0], b[0]), a[1] - PARTITION / 2, a[1] + PARTITION / 2, 0, w.top, fin);
  } else {
    ctx.box(a[0] - PARTITION / 2, a[0] + PARTITION / 2, Math.min(a[1], b[1]), Math.max(a[1], b[1]), 0, w.top, fin);
  }
}

/** The steel roof of the hall: the ceiling under it, the trusses, the silver ducts, the vents. */
function hallRoof(ctx) {
  const hall = PARTS.hall, vN = hall.v0, vS = GALLERY_V;
  ctx.box(hall.u0, hall.u1, vN, hall.v1, H.hall - 0.35, H.hall - 0.25, 'airceil');
  // trusses hung from the ceiling every 5.6 m, and the two long chords they sit on
  for (let u = hall.u0 + 2; u < hall.u1 - 1; u += 5.6) ctx.box(u - 0.2, u + 0.2, vN, vS, H.hall - 0.8, H.hall - 0.35, 'airtruss');
  for (const v of [vN + 1, vS - 1]) ctx.box(hall.u0, hall.u1, v - 0.2, v + 0.2, H.hall - 0.9, H.hall - 0.7, 'airtruss');
  // two silver ducts along the hall, the way the photographs show them
  for (const v of [-16, -4]) ctx.box(hall.u0 + 1, hall.u1 - 1, v - 0.35, v + 0.35, H.hall - 1.7, H.hall - 1.0, 'steel');
  // round vents dropped from the ceiling on a grid
  for (let u = hall.u0 + 4; u < hall.u1 - 3; u += 9) {
    for (let v = vN + 4; v < vS - 2; v += 8) ctx.drum(u, v, H.hall - 0.6, H.hall - 0.35, 0.9, 'steel');
  }
}

/** The suspended ceilings of the wings and the porch, with their square diffusers. */
function lowCeilings(ctx) {
  for (const p of [PARTS.west, PARTS.east]) {
    ctx.box(p.u0, p.u1, p.v0, p.v1, H.wing - 0.5, H.wing - 0.4, 'airceil');
    for (let u = p.u0 + 2; u < p.u1 - 1; u += 3) {
      for (let v = p.v0 + 2; v < p.v1 - 1; v += 3) ctx.box(u - 0.3, u + 0.3, v - 0.3, v + 0.3, H.wing - 0.42, H.wing - 0.4, 'led');
    }
  }
  const pr = PARTS.porch;
  ctx.box(pr.u0, pr.u1, pr.v0, pr.v1, H.porch - 0.4, H.porch - 0.3, 'airceil');
}

/** The gallery over the back of the hall: its slab, the glass balustrade, the round columns. */
function gallery(ctx) {
  const hall = PARTS.hall;
  // (its underside is the ceiling over the lanes, the baggage room and the lounge)
  ctx.box(hall.u0, hall.u1, GALLERY_V, hall.v1, H.gallery - 0.35, H.gallery, 'airceil');
  // the balustrade stands on the wall line where the gallery overlooks the hall; the
  // opening of the security lanes stays clear
  ctx.box(hall.u0, SECURITY[0], GALLERY_V - 0.03, GALLERY_V + 0.03, H.gallery, H.gallery + 1.0, 'glass');
  ctx.box(SECURITY[1], hall.u1, GALLERY_V - 0.03, GALLERY_V + 0.03, H.gallery, H.gallery + 1.0, 'glass');
  // the round columns under the gallery's edge, on the wall line
  for (let u = -32; u <= 14; u += 6) ctx.drum(u, GALLERY_V, 0, H.gallery - 0.35, 0.7, 'airwall');
}

/** The fascia of the gallery: a long white band, "letiště Pardubice" and a red P, faced into the hall. */
function fasciaDraw(ctx, w, h) {
  ctx.fillStyle = '#f4f3ef';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#c4222c';
  ctx.fillRect(w * 0.04, h * 0.12, h * 0.76, h * 0.76);
  ctx.fillStyle = '#ffffff';
  ctx.font = `700 ${Math.round(h * 0.62)}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('P', w * 0.04 + h * 0.38, h * 0.52);
  ctx.fillStyle = '#1b2f55';
  ctx.font = `600 ${Math.round(h * 0.56)}px system-ui, sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText('letiště Pardubice', w * 0.04 + h * 1.0, h * 0.52);
}

/** Every sign that hangs on the building's own walls (the porch lettering is on the outside). */
function signs(ctx) {
  const pr = PARTS.porch;
  // on the porch's dark band, outside, facing the forecourt
  ctx.plate(-0.7, pr.v0 - 0.035, 3.75, FACE.n, 20, 0.5, 2048,
    plate(['LETIŠTĚ PARDUBICE – TERMINÁL JANA KAŠPARA'], '#4a5057', '#ffffff', 700), 'porch-name');
  // the gallery's fascia, on the gallery's edge over the baggage room wall
  ctx.plate(-11, GALLERY_V - 0.2, H.gallery - 0.05, FACE.n, 30, 0.85, 2048, fasciaDraw, 'fascia');
  // the direction signs: departures over the check-in counters, arrivals on the west side
  ctx.plate(-22, GALLERY_V - 0.2, 3.7, FACE.n, 7, 0.7, 1024,
    plate(['ODLETY / DEPARTURES'], '#1b2f55', '#ffd23f', 700), 'to-departures');
  ctx.plate(PARTS.hall.u0 + 0.1, -16, 3.7, FACE.e, 4, 0.7, 1024,
    plate(['PŘÍLETY / ARRIVALS'], '#1b2f55', '#ffd23f', 700), 'to-arrivals');
  // the gate lounges: the dark plates over the way into each gate
  for (const [u, n] of [[42, '1'], [57.6, '2']]) {
    ctx.plate(u, 2.18, 3.9, FACE.s, 2.4, 0.6, 1024,
      plate(['GATE ' + n], '#1e2327', '#ffd23f', 700), 'gate-' + n + '-sign');
  }
}

/** The hall's lights for the night: one pool per room, on the tiles. */
function pools(ctx) {
  const L = (u, v, long, wide) => {
    const p = ctx.at(u, v, 0.14);
    ctx.k.light(p.x, p.y, p.z, long, wide, 0xfff1d6);
  };
  for (const u of [-28, -12, 4]) L(u, -8, 7, 6);
  for (const u of [-28, -14]) L(u, 3, 6, 5);
  for (const u of [40, 60]) L(u, 8, 7, 6);
  for (const u of [-80, -60]) L(u, 6, 7, 6);
}

/** Build the rooms. `ctx` is from js/airport-ctx.js: its box() and plate() take plan coordinates. */
export function buildInterior(ctx) {
  // the floor, one slab per part, its top 12 cm above the ground (as a store's is)
  // (on a plinth down to the shell's founding ground when the set is lifted: js/airport-terminal.js _lift)
  for (const p of Object.values(PARTS)) ctx.box(p.u0, p.u1, p.v0, p.v1, -(ctx.lift ?? 0), 0.12, 'airtile');
  // the inner faces of the outside walls, banded; the glass faces have their own panes
  // (the hall's glazing over the wings' roofs has no inside: the wings' ceilings meet it)
  for (const s of OUTSIDE) if (s.face !== 'glass' && s.face !== 'upper') faceBands(ctx, s);
  for (const w of WALLS) partition(ctx, w);
  hallRoof(ctx);
  lowCeilings(ctx);
  gallery(ctx);
  signs(ctx);
  pools(ctx);
}
