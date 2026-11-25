// ---- maproute: the route as a 2D map draws it ----------------------------------
// The minimap and the region map both paint the same thing, the road still
// ahead of you, so they share one painter. The caller hands a slice from
// js/routeahead.js (world metres, nothing behind the car) and a view transform
//
//   T = { cx, cy, k, c, s, ox, oz }
//   screen = (cx, cy) + k · R(θ) · (world − (ox, oz)),  c = cos θ, s = sin θ
//
// and gets a satnav line: a soft glow, a dark edge, the blue, and a pale core,
// all from ONE path stroked four times, joins and caps rounded. Points closer
// than half a pixel to the last one drawn are skipped, which is what lets the
// region map draw a 40 km route at country zoom for the price of a few hundred
// segments. No allocation: the path lives in the context.

import { ROUTE } from './mapstyle.js';
import { sliceAhead, blendStart } from './routeahead.js';

const MIN_PX = 0.5;

/** Lay the slice into the context's current path (screen space). */
export function routePath(g, out, n, T) {
  const X = out.x, Z = out.z, k = T.k, c = T.c, s = T.s;
  let lx = 0, ly = 0;
  g.beginPath();
  for (let j = 0; j < n; j++) {
    const rx = X[j] - T.ox, rz = Z[j] - T.oz;
    const x = T.cx + (rx * c - rz * s) * k, y = T.cy + (rx * s + rz * c) * k;
    if (j === 0) { g.moveTo(x, y); lx = x; ly = y; continue; }
    if (j < n - 1 && Math.abs(x - lx) + Math.abs(y - ly) < MIN_PX) continue;
    g.lineTo(x, y); lx = x; ly = y;
  }
}

/**
 * The route line. `w` is the blue's width in device pixels; the edge, glow
 * and core are proportioned from it so both maps keep one look at any size.
 */
export function strokeRoute(g, out, n, T, w) {
  if (n < 2) return;
  routePath(g, out, n, T);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.strokeStyle = ROUTE.glow;
  g.lineWidth = w * 2.6;
  g.stroke();
  g.strokeStyle = ROUTE.casing;
  g.lineWidth = w + Math.max(2, w * 0.55);
  g.stroke();
  g.strokeStyle = ROUTE.fill;
  g.lineWidth = w;
  g.stroke();
  g.strokeStyle = ROUTE.core;
  g.lineWidth = Math.max(1, w * 0.28);
  g.stroke();
}

/**
 * The manoeuvre arrow: the route's own shape through the junction, in white
 * with the route's dark edge, ending in a head that points where you leave.
 * `out` is the slice around the turn (a few metres before to a few after).
 */
export function drawTurnArrow(g, out, n, T, w) {
  if (n < 2) return;
  const X = out.x, Z = out.z, k = T.k, c = T.c, s = T.s;
  // head direction: from a point far enough back that a short last segment
  // cannot point it sideways
  const ex = T.cx + ((X[n - 1] - T.ox) * c - (Z[n - 1] - T.oz) * s) * k;
  const ey = T.cy + ((X[n - 1] - T.ox) * s + (Z[n - 1] - T.oz) * c) * k;
  let j = n - 2, qx = ex, qy = ey;
  for (; j >= 0; j--) {
    qx = T.cx + ((X[j] - T.ox) * c - (Z[j] - T.oz) * s) * k;
    qy = T.cy + ((X[j] - T.ox) * s + (Z[j] - T.oz) * c) * k;
    if (Math.abs(qx - ex) + Math.abs(qy - ey) >= w * 2.5) break;
  }
  let ux = ex - qx, uy = ey - qy;
  const ul = Math.hypot(ux, uy) || 1;
  ux /= ul; uy /= ul;
  const head = w * 2.4, half = w * 1.9;
  const bx = ex - ux * head, by = ey - uy * head;   // the head's base
  g.lineJoin = 'round';
  g.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    const col = pass ? ROUTE.arrow : ROUTE.arrowCasing;
    // the shaft stops at the head's base, so its round cap is under the head
    // and cannot poke through the tip
    routePath(g, out, Math.max(1, j + 1), T);
    g.lineTo(bx, by);
    g.strokeStyle = col;
    g.lineWidth = pass ? w : w + 3;
    g.stroke();
    g.beginPath();
    g.moveTo(ex + ux * w * 0.35, ey + uy * w * 0.35);
    g.lineTo(bx - uy * half, by + ux * half);
    g.lineTo(bx + uy * half, by - ux * half);
    g.closePath();
    if (!pass) { g.lineWidth = 3; g.stroke(); }
    g.fillStyle = col;
    g.fill();
  }
}

/**
 * The whole remaining route of a js/navigation.js instance, from where it has
 * the player to the end, as the region map shows it. `hold` keeps the scratch
 * arrays between calls (grown once per longer route, never per frame); the
 * head bends from the route onto (px, pz) over `blendM` metres. Returns the
 * number of points drawn (0 = no route), and leaves the last one in hold.end.
 */
export function drawNavRoute(g, nav, T, w, hold, px, pz, blendM) {
  const route = nav?.route, cum = nav?.routeCum;
  if (!route || !cum || cum.length !== route.length || route.length < 2) return 0;
  const n = route.length + 2;
  if (!hold.sl || hold.sl.x.length < n) {
    const cap = n + 256;
    hold.sl = { x: new Float64Array(cap), z: new Float64Array(cap), s: new Float64Array(cap) };
    hold.end = { x: 0, z: 0 };
  }
  const sl = hold.sl;
  const m = sliceAhead(route, cum, nav.routeS ?? 0, Infinity, sl, n, 0, nav.routeI ?? 0);
  if (m < 2) return 0;
  if (Number.isFinite(px) && Number.isFinite(pz)) blendStart(sl, m, px - sl.x[0], pz - sl.z[0], blendM);
  strokeRoute(g, sl, m, T, w);
  hold.end.x = sl.x[m - 1]; hold.end.z = sl.z[m - 1];
  return m;
}
