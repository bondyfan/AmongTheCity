// ---- mwworks.js: what a roadworks zone on the D11 looks like, planned ----
// js/mwtraffic.js closes the left lane of two or three D11 stretches a game
// day (zonesAt) and the traffic obeys it: 80 km/h on the approach, 60 inside,
// everybody out of the left lane by CLOSE_FORCE km before the zone. Until
// this module nothing on the road said so, and a queue that merges right for
// no visible reason reads as broken AI. This plans what a Czech driver sees
// at such a closure (TP 66 "Zásady pro označování pracovních míst na
// pozemních komunikacích", photos of D1 / D11 closures):
//   · far ahead, on both sides: the yellow lane-closure board (IP 22 style:
//     two lanes, the left one ending into the right), then the A 15 "práce"
//     triangle over a temporary 80 limit where the 80 starts;
//   · in the closed lane, where the closure begins: the arrow trailer, a
//     yellow board flashing an arrow to the right;
//   · a taper of cones across the left lane behind it, then cones along the
//     lane line to the zone's end, a short taper out, and the 60 limit at the
//     zone's start.
// Pure: its only imports are js/d11.js and js/mwtraffic.js (plain arithmetic
// on baked constants and the shared zone table), so every client plans the
// same cones in the same places from the same zonesAt(T) (co-op safe). The
// three.js half is js/mwworksmesh.js.
//
// Positions are { x, z, hx, hz } (hx, hz the unit direction of travel) on the
// carriageway's centreline offset `off` m to the right of travel: the lane
// line between the left and the right lane IS the centreline (js/lanes.js:
// dividers [0] on two and three lanes), the left lane's left edge line is at
// -(LANE_W + LINE_W / 2) = -3.875.

import { d11At, onBridge, UP, ECODUCTS } from './d11.js';
import { APPROACH, CLOSE_AHEAD, TAPER_AT, TAPER_END } from './mwtraffic.js';
import { SLIPS, OVERPASS } from './mwslips.js';

export const CONE_LINE = -0.35;      // m, a cone just inside the closed lane, off the lane line
export const CONE_EDGE = -3.55;      // m, the far end of the taper: the closed lane's left edge
export const CONE_STEP = 15;         // m between cones along the lane line
export const TAPER_N = 14;           // cones in the taper in
export const TAPER_OUT = 60;         // m of taper out, inside the zone's end
export const TRAILER_OFF = -1.875;   // m, the arrow trailer: the middle of the closed lane
export const SIGN_R = 7.6;           // m, the right verge (js/mwsigns.js POST_OFF)
export const SIGN_L = -5.3;          // m, the median's shoulder, short of the barrier

// travel-relative: metres from the zone's start along the direction of travel
// to the official km on carriageway cw
const kmOf = (z, cw, d) => (UP[cw] > 0 ? z.a + d / 1000 : z.b - d / 1000);

const _at = {};
// (cx, cz) the centreline point beside it: the road a verge board stands
// beside is where its height is read (js/mwworksmesh.js)
function put(list, z, d, off, extra) {
  const P = d11At(kmOf(z, z.cw, d), z.cw, _at);
  if (!P) return;
  const it = { x: P.x - P.dz * off, z: P.z + P.dx * off, cx: P.x, cz: P.z, hx: P.dx, hz: P.dz, d, off };
  if (extra) Object.assign(it, extra);
  list.push(it);
}

/**
 * Everything one zone ({ cw, a, b } from mwtraffic.zonesAt) puts on the road:
 * { cones: [pos], signs: [pos + { face }], trailer: pos | null }. Memoised
 * per zone record (zonesAt hands out the same records for the whole day).
 */
export function worksPlan(z) {
  if (z._works) return z._works;
  const len = (z.b - z.a) * 1000;
  const cones = [], signs = [];
  // the taper in: from the trailer's tail across the lane to the lane line
  const t0 = -TAPER_AT * 1000, t1 = -TAPER_END * 1000;
  for (let i = 0; i < TAPER_N; i++) {
    const u = i / (TAPER_N - 1);
    put(cones, z, t0 + (t1 - t0) * u, CONE_EDGE + (CONE_LINE - CONE_EDGE) * u);
  }
  // along the lane line, then the taper out back to the edge by the zone's end
  for (let d = t1 + CONE_STEP; d < len - TAPER_OUT; d += CONE_STEP) put(cones, z, d, CONE_LINE);
  for (let i = 0; i <= 4; i++) {
    const u = i / 4;
    put(cones, z, len - TAPER_OUT + TAPER_OUT * u, CONE_LINE + (CONE_EDGE - CONE_LINE) * u);
  }
  const tr = [];
  put(tr, z, t0 - 7, TRAILER_OFF);
  // the boards, both sides: the closure first, then the triangle and the 80,
  // the 60 where the zone's limit begins
  // (a board never stands on a bridge deck, under an overpass or an
  // ecoduct, or where a slip road leaves or joins: it moves back up the road
  // in 20 m steps until it is clear, as js/mwsigns.js nudges its own)
  for (const off of [SIGN_R, SIGN_L]) {
    for (const [d0, face] of [[-CLOSE_AHEAD * 1000, 'closure'], [-APPROACH * 1000, 'works80'], [0, 'works60']]) {
      let d = d0;
      while (d > d0 - 300 && !boardClear(kmOf(z, z.cw, d), z.cw, off > 0)) d -= 20;
      if (d > d0 - 300) put(signs, z, d, off, { face });
    }
  }
  return (z._works = { cones, signs, trailer: tr[0] ?? null });
}

// the slip corridors of carriageway cw (where a slip runs within 24 m of the
// centreline, js/mwslips.js), padded; [km lo, km hi]
const CORR = {};
function corridors(cw) {
  if (CORR[cw]) return CORR[cw];
  const out = [];
  for (const k of Object.keys(SLIPS)) {
    if (!k.endsWith(':' + cw)) continue;
    const s = SLIPS[k];
    if (s[2] != null) out.push([Math.min(s[2], s[3]) - 0.03, Math.max(s[2], s[3]) + 0.03 + (s[2] === s[3] ? 0.25 : 0)]);
    if (s[5] != null) out.push([Math.min(s[5], s[6]) - 0.03 - (s[5] === s[6] ? 0.25 : 0), Math.max(s[5], s[6]) + 0.03]);
  }
  return (CORR[cw] = out);
}
/** May a works board stand at km on cw (right verge if `right`, else the median side)? */
export function boardClear(km, cw, right) {
  if (onBridge(km, cw, 0.03)) return false;
  const o = OVERPASS[cw];
  if (o) for (let i = 0; i < o.length; i++) if (Math.abs(o[i] - km) < 0.05) return false;
  for (const e of ECODUCTS) {
    const s = e[cw];
    if (s && km >= s.km0 - 0.07 && km <= s.km1 + 0.07) return false;
  }
  if (right) for (const c of corridors(cw)) if (km >= c[0] && km <= c[1]) return false;
  return true;
}

/** Is the zone's road within r m of (x, z)? (its start, end and middle, plus r slack) */
export function zoneNear(z, x, z2, r) {
  const k0 = z.a - CLOSE_AHEAD - 0.05, k1 = z.b + CLOSE_AHEAD + 0.05;   // (either way of travel)
  for (let i = 0; i <= 8; i++) {
    const P = d11At(k0 + (k1 - k0) * i / 8, z.cw, _at);
    if (!P) continue;
    const dx = P.x - x, dz = P.z - z2;
    if (dx * dx + dz * dz < r * r) return true;
  }
  return false;
}
