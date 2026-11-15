// ---- expressroute.js: which track the express runs on (round 8) ----
// Split out of js/express.js (which was over the 400-line rule): the route
// changes the R train Pardubice - Praha makes where the chainer left line 010
// in pieces, at a seam (transferRoute) and at its stations (towardPrague).
// Pure functions of the trains.js routes and the train; no clock, no DOM.

/** Praha hl.n., where the express is going (its OSM station poi). */
export const HLN = [-94575.7, -5701.1];
const HLN_NAME = 'Praha hlavní nádraží';
const SWITCH_R = 8;                         // m: another route this close to a route's end runs on from it
const SWITCH_FAR = 35;                      // m: …or, failing that, this close (a gap in a station throat)
const TOWARD = 3000;                        // m of line ahead a route choice is judged on
const PLATFORM_R = 60;                      // m: another route's stop for the same station this near is a platform across (trains.js STATION_R)

// ---- changing routes at a seam --------------------------------------------
/**
 * A train at (or near) the end of its route goes on along another route
 * that passes through that end point in the same direction. Why: the
 * chainer is greedy (trains.js walkChain takes the straightest way at every
 * joint), so at a junction the through line can end up INSIDE another
 * route while this one stops (measured west of Přelouč: line 010's route
 * ends at x -13213, and the line on to Kolín is the middle of a 20 km route
 * that came in on the parallel track). Ends meeting ends are joined by
 * trains.js _joinRoutes; this is the case a join cannot fix. The head is
 * put at the same point on the other route; the coaches behind follow that
 * route's track (at a junction, a few metres to the side). True if it moved.
 */
export function transferRoute(tr, t) {
  const R = t.route, n = R.pts.length;
  const end = t.dir > 0 ? R.pts[n - 1] : R.pts[0], prev = t.dir > 0 ? R.pts[n - 2] : R.pts[1];
  const L = Math.hypot(end[0] - prev[0], end[1] - prev[1]) || 1;
  const hx = (end[0] - prev[0]) / L, hz = (end[1] - prev[1]) / L;
  let best = null;
  const here = Math.hypot(end[0] - HLN[0], end[1] - HLN[1]);
  // the near radius first (a route through the end point); only if none,
  // the far one: the simplified tiles leave 20 to 40 m between the line's
  // pieces in a station throat (Velim: the line on starts 27 m off the end,
  // the 1.2 km yard routes between are too short to carry a train)
  for (const reach of [SWITCH_R, SWITCH_FAR]) {
    for (const R2 of tr.routes) {
      if (R2 === R || R2.len < 600) continue;
      if (end[0] < R2.minX - reach || end[0] > R2.maxX + reach
        || end[1] < R2.minZ - reach || end[1] > R2.maxZ + reach) continue;
      for (let i = 0; i + 1 < R2.pts.length; i++) {
        const a = R2.pts[i], b = R2.pts[i + 1];
        const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1e-9;
        let k = ((end[0] - a[0]) * ex + (end[1] - a[1]) * ez) / l2;
        k = k < 0 ? 0 : k > 1 ? 1 : k;
        const d = Math.hypot(a[0] + ex * k - end[0], a[1] + ez * k - end[1]);
        if (d >= reach) continue;
        const sl = Math.sqrt(l2), dot = (ex * hx + ez * hz) / sl;
        if (Math.abs(dot) < 0.85) continue;          // not the same direction
        const s2 = R2.cum[i] + k * sl, dir = dot > 0 ? 1 : -1;
        // room ahead to be worth it (a set that does not fit behind the
        // point is put down with its tail on the route: the head moves on
        // by the shortfall)
        const ahead = dir > 0 ? R2.len - s2 : s2;
        if (ahead < 500) continue;
        // the express takes the candidate that leads toward Prague (past
        // Kolín the nearest one ran 20 km south, seen in game), and only
        // one that does; any other train the nearest
        const sc = t.express ? towardScore(R2, s2, dir) : d;
        if (t.express && sc > here - 200) continue;
        if (best && sc >= best.sc) continue;
        best = { R2, s2, dir, sc };
      }
    }
    if (best) break;
  }
  if (!best) return false;
  // where the head is now, relative to the end it is heading for
  const toEnd = t.dir > 0 ? R.len - t.s : t.s;
  t.route = best.R2;
  t.dir = best.dir;
  t.s = Math.max(tr._sLo(t), Math.min(tr._sHi(t), best.s2 - best.dir * toEnd));
  t.seg = 0;
  for (const v of t.cars) { v.segF = 0; v.segR = 0; v.hasH = false; }
  t.departed = null;
  tr._place(t, 0);
  if (t === tr.riding) tr._syncRide();
  return true;
}

/**
 * Put the express on whichever route through the point it stands at leads
 * it nearest Praha hl.n. within the next TOWARD km, keeping its heading.
 * True if it changed route.
 */
export function towardPrague(tr, t) {
  const R = t.route;
  const here = posAt(R, t.s), fw = posAt(R, Math.max(0, Math.min(R.len, t.s + t.dir * 30)));
  let hx = fw[0] - here[0], hz = fw[1] - here[1];
  const hl = Math.hypot(hx, hz) || 1; hx /= hl; hz /= hl;
  const score = towardScore;
  let best = { R2: R, s2: t.s, dir: t.dir, sc: score(R, t.s, t.dir) };
  const poi = t.station?.poi;
  for (const R2 of tr.routes) {
    if (R2 === R || R2.len < 2000) continue;
    // the same station on another platform track: at Praha-Libeň the line
    // into Praha hl.n. is a route 30 m across the station from the one the
    // express came in on, and no route passes within SWITCH_R of both
    const st2 = poi ? R2.stops.find((x) => x.poi === poi) : null;
    if (st2 && Math.hypot(st2.x - here[0], st2.z - here[1]) <= PLATFORM_R) {
      const a = posAt(R2, Math.max(0, st2.s - 15)), b = posAt(R2, Math.min(R2.len, st2.s + 15));
      const bl = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const dot = ((b[0] - a[0]) * hx + (b[1] - a[1]) * hz) / bl;
      const dir = dot > 0 ? 1 : -1;
      const behind = dir > 0 ? st2.s : R2.len - st2.s;
      if (Math.abs(dot) >= 0.85 && behind >= t.length + 5) {
        const sc = score(R2, st2.s, dir);
        if (sc < best.sc - 50) best = { R2, s2: st2.s, dir, sc };
      }
    }
    if (here[0] < R2.minX - SWITCH_R || here[0] > R2.maxX + SWITCH_R
      || here[1] < R2.minZ - SWITCH_R || here[1] > R2.maxZ + SWITCH_R) continue;
    for (let i = 0; i + 1 < R2.pts.length; i++) {
      const a = R2.pts[i], b = R2.pts[i + 1];
      const ex = b[0] - a[0], ez = b[1] - a[1], l2 = ex * ex + ez * ez || 1e-9;
      let k = ((here[0] - a[0]) * ex + (here[1] - a[1]) * ez) / l2;
      k = k < 0 ? 0 : k > 1 ? 1 : k;
      if (Math.hypot(a[0] + ex * k - here[0], a[1] + ez * k - here[1]) > SWITCH_R) continue;
      const sl = Math.sqrt(l2), dot = (ex * hx + ez * hz) / sl;
      if (Math.abs(dot) < 0.85) continue;
      const s2 = R2.cum[i] + k * sl, dir = dot > 0 ? 1 : -1;
      const behind = dir > 0 ? s2 : R2.len - s2;
      if (behind < t.length + 5) continue;
      const sc = score(R2, s2, dir);
      if (sc < best.sc - 50) best = { R2, s2, dir, sc };
    }
  }
  if (best.R2 === R) return false;
  t.route = best.R2; t.dir = best.dir;
  t.s = Math.max(tr._sLo(t), Math.min(tr._sHi(t), best.s2));
  t.seg = 0;
  for (const v of t.cars) { v.segF = 0; v.segR = 0; v.hasH = false; }
  // the platform it stands at, on the new route (same poi), so it is the
  // stop it departs from and not one it brakes for
  const st = best.R2.stops.find((x) => x.poi === t.station?.poi);
  if (st) t.station = st;
  tr._place(t, 0);
  if (t === tr.riding) tr._syncRide();
  return true;
}

// how far from Praha hl.n. a train would be TOWARD m on along R from s. A
// route that CALLS at Praha hl.n. ahead is the answer outright: 3 km on, the
// line through the Vítkov tunnels is no nearer the station than a yard track
// that ends 2 km short of it (review, seen in game at Praha-Libeň)
function towardScore(R, s, dir) {
  for (const st of R.stops) if (st.name === HLN_NAME && (st.s - s) * dir > 0) return 0;
  const q = posAt(R, Math.max(0, Math.min(R.len, s + dir * TOWARD)));
  return Math.hypot(q[0] - HLN[0], q[1] - HLN[1]);
}

/** The point s metres along route R. */
export function posAt(R, s) {
  let i = 0;
  while (i < R.pts.length - 2 && R.cum[i + 1] < s) i++;
  const a = R.pts[i], b = R.pts[i + 1], L = (R.cum[i + 1] - R.cum[i]) || 1;
  const k = Math.max(0, Math.min(1, (s - R.cum[i]) / L));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}
