// ---- quayflights.js: the flights of steps down to the Prague lower quays ----
// The numbers of each flight (js/naplavky.js STAIRS) as a walker, a car and
// the mesher need them: how many steps, where each tread lies, where the feet
// go, and where a car is not allowed. js/quaystairs.js draws them from these.
// WORKER SAFE: plain arithmetic over constants, no allocation per query.
//
// A flight runs from its foot `a` (the quay floor, y0) to its top `b` (y1).
// Along it s (0 at the foot, L at the top), across it d (+ to the right of
// travel). n risers of about RISE each; tread k (1..n) lies over
// [(k-1)g, kg] at y0 + k h, so its back edge is on the line from the foot to
// the top and the ground under the flight (the stamp, a little below that
// line: naplavky.stairDip) never comes up through it.

import { STAIRS, stairDip } from './naplavky.js';

export const RISE = 0.16;                    // m, a comfortable step

/** The flights, with their steps worked out. */
export const FLIGHTS = STAIRS.map((st, i) => {
  const rise = st.y1 - st.y0, n = Math.max(1, Math.round(rise / RISE));
  const q = rise / st.L, { s1, dip } = stairDip(q, st.L);
  // right-hand normal of travel (x east, z south), as the stamp's own
  const nx = -st.uz, nz = st.ux;
  // the box the flight and its run-ons lie in, its band either side
  const w = Math.max(st.l, st.r) + 0.5;
  const ax = st.a[0] - st.ux * st.e0, az = st.a[1] - st.uz * st.e0;
  const bx = st.b[0] + st.ux * st.e1, bz = st.b[1] + st.uz * st.e1;
  return { ...st, i, n, h: rise / n, g: st.L / n, q, s1, dip, nx, nz,
    mx: (st.a[0] + st.b[0]) / 2, mz: (st.a[1] + st.b[1]) / 2,
    x0: Math.min(ax, bx) - w, x1: Math.max(ax, bx) + w, z0: Math.min(az, bz) - w, z1: Math.max(az, bz) + w };
});

// one box round all of them: the hot path (feet, cars) leaves at one compare
const BOX = FLIGHTS.reduce((b, f) => ({ x0: Math.min(b.x0, f.x0), z0: Math.min(b.z0, f.z0),
  x1: Math.max(b.x1, f.x1), z1: Math.max(b.z1, f.z1) }), { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity });
export const inStairBox = (x, z) => x >= BOX.x0 && x <= BOX.x1 && z >= BOX.z0 && z <= BOX.z1;

/** The ground the stamp makes under flight F at s (the same line naplavky.stair builds). */
export function groundUnder(F, s) {
  const { y0, y1, L, q, s1, dip } = F;
  const yd = y0 + q * s1 - dip;
  if (s <= 0) return y0;
  if (s < s1) return y0 + (yd - y0) * s / s1;
  if (s < L) return yd + (y1 - yd) * (s - s1) / (L - s1);
  return y1;
}
/** The top of the tread over s (the floor before the foot, the landing past the top). */
export function treadTop(F, s) {
  if (s <= 0) return F.y0;
  if (s >= F.L) return F.y1;
  return F.y0 + Math.min(F.n, Math.ceil(s / F.g - 1e-9)) * F.h;
}
/**
 * Where the feet go on the flight at s: a smooth line through the middle of
 * every riser, so a walker climbs at a steady pace and is never more than
 * half a step (8 cm) off the stone, and the step-up rule never sees a step.
 */
export function walkLine(F, s) {
  const y = F.y0 + F.h / 2 + F.q * s;
  return y < F.y1 ? y : F.y1;
}

/** Local (s, d) of (x, z) in flight F into `out`. */
function local(F, x, z, out) {
  const dx = x - F.a[0], dz = z - F.a[1];
  out.s = dx * F.ux + dz * F.uz; out.d = dx * F.nx + dz * F.nz;
  return out;
}
const _l = { s: 0, d: 0 };

/**
 * The walking level of a quay flight at (x, z), or null off every flight.
 * City.heightAt offers it like any other surface (js/city.js), so a walker,
 * the crowd and a prop all stand on the steps.
 */
export function quayStairY(x, z) {
  if (!inStairBox(x, z)) return null;
  let best = null;
  for (const F of FLIGHTS) {
    if (x < F.x0 || x > F.x1 || z < F.z0 || z > F.z1) continue;
    const { s, d } = local(F, x, z, _l);
    if (s < 0 || s > F.L || d < -F.l || d > F.r) continue;
    const y = walkLine(F, s);
    if (best === null || y > best) best = y;
  }
  return best;
}

// The OSM `steps` way each flight was built along (js/naplavky.js: every
// stamp follows the way's own line) is drawn by the stone now, and its
// levelled ribbon, a footway slab 16 cm over the ground under the treads,
// would stand up through them. So would any short footway that reaches into
// a flight's band: the chunk's sink is draped onto the ground vertex by
// vertex, and a ribbon corner inside the band rose to the steps, a fin of
// paving standing out of the parapet (the stubs that join the quay to the
// short OSM flights beside the Palackého pair). A pure function of the way's
// geometry, so both threads and every client agree; remembered per way.
const FOOT = new Set(['steps', 'footway', 'path', 'pedestrian', 'cycleway']);
const _stairWay = new WeakMap();
/** Is road way r drawn by a quay flight (its OSM line, or a stub into its band)? */
export function isQuayStairWay(r) {
  if (!r || r.d || !FOOT.has(r.t) || !r.p || r.p.length < 2) return false;
  const p0 = r.p[0];
  if (!inStairBox(p0[0], p0[1])) return false;
  let v = _stairWay.get(r);
  if (v === undefined) {
    v = false;
    const p1 = r.p[r.p.length - 1];
    let len = 0;
    for (let i = 1; i < r.p.length; i++) len += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
    const hw = (r.w ?? 1.8) / 2;
    for (const F of FLIGHTS) {
      // (a metre's grace either side: the short OSM flights drawn beside
      // the Palackého pair, levelled half onto the stone)
      const near = (p, g) => {
        const { s, d } = local(F, p[0], p[1], _l);
        return s > -0.6 && s < F.L + 0.6 && d > -F.l - g && d < F.r + g;
      };
      // A short stub ending on the retaining wall beside the foot can
      // lie wholly before the first riser. Draping its width across that
      // wall produces a vertical triangle of paving (Na Františku).
      const onLanding = len < 2 && F.wall && [p0, p1].every(p =>
        Math.hypot(p[0] - F.a[0], p[1] - F.a[1]) < 3.5);
      if (r.t === 'steps' ? near(p0, 1) && near(p1, 1)
        : onLanding || (len < 5 && (near(p0, hw + 0.2) || near(p1, hw + 0.2)))) { v = true; break; }
    }
    _stairWay.set(r, v);
  }
  return v;
}

/**
 * A car is not a walker: a flight of steps is a solid block to it. Pushes the
 * point `pos` (radius `radius`) out of every flight's footprint when the
 * caller's level (opts.y, as js/vehicles.js wallPass passes it) is anywhere
 * near the flight's heights. A walker below a flight meets its retaining face.
 * A caller with no level passes freely (a spawn nudge must not throw someone
 * off a quay). Returns true if it moved.
 */
export function quayStairsCollide(pos, radius, opts) {
  const walker = !!opts?.interior;
  const y = opts?.y ?? opts?.yLo;
  if (y === undefined || y === null) return false;
  if (!inStairBox(pos.x, pos.z)) return false;
  let pushed = false;
  for (const F of FLIGHTS) {
    if (pos.x < F.x0 - radius || pos.x > F.x1 + radius || pos.z < F.z0 - radius || pos.z > F.z1 + radius) continue;
    if (y < F.y0 - 1.5 || y > F.y1 + 2.5) continue;
    const { s, d } = local(F, pos.x, pos.z, _l);
    if (walker) {
      // The actor moves in substeps smaller than its radius. Keep a walker
      // below the stair out of the solid support, including the top landing.
      // A walker already standing on a tread can climb through either end.
      if (y >= walkLine(F, Math.max(0, s)) || s < -F.e0 || s > F.L + F.e1 + radius) continue;
      const side = d < 0 ? -1 : 1;
      const width = side < 0 ? F.l : F.r;
      const pen = width + radius - Math.abs(d);
      if (pen <= 0) continue;
      const endPen = F.L + F.e1 + radius - s;
      if (endPen < pen) {
        pos.x += F.ux * endPen; pos.z += F.uz * endPen;
      } else {
        pos.x += side * F.nx * pen; pos.z += side * F.nz * pen;
      }
      pushed = true;
      continue;
    }
    // the flight proper, from its first riser to its top step
    const pS0 = s + radius, pS1 = F.L + radius - s, pD0 = d + F.l + radius, pD1 = F.r + radius - d;
    if (pS0 <= 0 || pS1 <= 0 || pD0 <= 0 || pD1 <= 0) continue;
    // out the nearest way
    const m = Math.min(pS0, pS1, pD0, pD1);
    let ds = 0, dd = 0;
    if (m === pS0) ds = -pS0; else if (m === pS1) ds = pS1; else if (m === pD0) dd = -pD0; else dd = pD1;
    pos.x += F.ux * ds + F.nx * dd; pos.z += F.uz * ds + F.nz * dd;
    pushed = true;
  }
  return pushed;
}
