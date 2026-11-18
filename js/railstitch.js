// ---- railstitch.js: the last 6 km of line 010, Libeň to Praha hl.n. ----
// Pure: no three, no DOM. js/express.js asks it once the Prague rails are in
// memory and splices the answer onto the train route (trains.js _append).
//
// WHY. trains.js chains rail ways whose END POINTS meet within 3 m (JOIN),
// which is right for a clean main line and wrong for the Prague approach: the
// tiles are simplified, and through the Libeň yard and the Vítkov tunnels
// the ways meet 20 to 40 m apart or branch from a vertex in the middle of
// another way. So the 107 km route from Pardubice stops in the Libeň yard,
// 650 m short of Praha-Libeň and 6.2 km of track from the main station
// (measured by the services survey; the track is all there).
//
// HOW. A shortest path over the rail ways of the area, their end points
// welded within WELD m, with one rule the chainer also keeps: a train does
// not reverse, so a step that turns back on itself by more than MAX_TURN at
// a weld is not taken (a yard is full of welds that only a shunter uses).
// The answer is a polyline from the route's end to the track nearest the
// station's poi, gaps closed by straight joins.

const WELD = 32;              // m: end points this close are one joint (25 left the Vítkov approach broken)
const MAX_TURN = 0.5;         // cos: no continuation sharper than 60 degrees
const PAD = 1500;             // m of rails considered round the two ends
const GOAL_R = 45;            // m: the track must pass this close to the station poi (trains.js STATION_R is 60)

function wayLen(p) {
  let L = 0;
  for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  return L;
}
// unit direction leaving end `e` (0 start, 1 end) of polyline p, INTO the
// way, taken over its first DIR_RUN metres: a simplified tile way can start
// with a stub a metre long at any angle, and its first segment alone lied
const DIR_RUN = 12;
function inDir(p, e) {
  const n = p.length, a = e ? p[n - 1] : p[0];
  let b = a;
  for (let j = 1; j < n; j++) {
    b = e ? p[n - 1 - j] : p[j];
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) >= DIR_RUN) break;
  }
  const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1e-9;
  return [dx / L, dz / L];
}

/**
 * The rail path from a route's last stretch to the track nearest (tx, tz).
 * `tail` is that stretch, in travel order: [{ x, z, hx, hz }] (a vertex and
 * the direction of travel there). `rails` is any list of tile rail ways
 * ({ p, t }); trams are ignored. Returns { cut, pts, len, ways }: cut the
 * route after tail[cut], then append pts (which start at that vertex); or
 * null when no path exists in what is loaded. `at[i]` is [way, arclength]
 * of pts[i] on the way it came from (null for the route's own vertex), so the
 * splice can be graded like any chained track (trains.gradedPath).
 */
export function stitchPath(rails, tail, tx, tz, { weld = WELD, turn = MAX_TURN } = {}) {
  if (!tail?.length) return null;
  let x0 = tx, x1 = tx, z0 = tz, z1 = tz;
  for (const q of tail) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
  x0 -= PAD; x1 += PAD; z0 -= PAD; z1 += PAD;
  const ways = [];
  for (const w of rails) {
    if (!w?.p || w.p.length < 2 || w.t === 'tram') continue;
    const a = w.p[0], b = w.p[w.p.length - 1];
    if (Math.max(a[0], b[0]) < x0 || Math.min(a[0], b[0]) > x1
      || Math.max(a[1], b[1]) < z0 || Math.min(a[1], b[1]) > z1) continue;
    const len = wayLen(w.p);
    // a way shorter than the weld is a crossover stub: both its ends weld to
    // the same neighbours anyway, and its own direction is noise
    if (len < weld) continue;
    ways.push({ w, len });
  }
  if (!ways.length) return null;
  // end point grid for the welds
  const cell = (x, z) => Math.floor(x / weld) + ',' + Math.floor(z / weld);
  const grid = new Map();
  ways.forEach((o, i) => {
    for (const e of [0, 1]) {
      const q = e ? o.w.p[o.w.p.length - 1] : o.w.p[0];
      const k = cell(q[0], q[1]);
      let a = grid.get(k);
      if (!a) grid.set(k, a = []);
      a.push(i * 2 + e);
    }
  });
  const endPt = (id) => { const o = ways[id >> 1]; return (id & 1) ? o.w.p[o.w.p.length - 1] : o.w.p[0]; };
  // the way ends welded to a point
  const near = (x, z, r, out) => {
    out.length = 0;
    const cx = Math.floor(x / weld), cz = Math.floor(z / weld), n = Math.ceil(r / weld);
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      for (const id of grid.get((cx + i) + ',' + (cz + j)) ?? []) {
        const q = endPt(id);
        if (Math.hypot(q[0] - x, q[1] - z) <= r) out.push(id);
      }
    }
    return out;
  };
  // Dijkstra over states "entered way i at end e" (cost: metres so far),
  // leaving through the other end; a plain array heap is plenty for the
  // few thousand ways of two Prague tiles
  const N = ways.length * 2;
  const dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  const heap = [];
  const push = (id, d) => {
    heap.push([d, id]);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]]; i = m;
      }
    }
    return top;
  };
  // Sources: every way end welded to a vertex of the route's last stretch
  // and leaving it forward. The route itself may end in a yard siding past
  // the switch the through line leaves from (Libeň does), so the splice can
  // start back along it: `from[id]` remembers which tail vertex it left.
  const tmp = [], from = new Int32Array(N).fill(-1);
  tail.forEach((q, k) => {
    for (const id of near(q.x, q.z, weld, tmp)) {
      const o = ways[id >> 1], d = inDir(o.w.p, id & 1);
      if (d[0] * q.hx + d[1] * q.hz < turn) continue;     // not back the way we came
      const gap = Math.hypot(endPt(id)[0] - q.x, endPt(id)[1] - q.z);
      if (gap < dist[id]) { dist[id] = gap; from[id] = k; push(id, gap); }
    }
  });
  let best = -1, bestCost = Infinity;
  const reach = [];
  while (heap.length) {
    const [d, id] = pop();
    if (d > dist[id]) continue;
    if (d > bestCost) break;
    const o = ways[id >> 1];
    const outEnd = (id & 1) ^ 1;
    const out = outEnd ? o.w.p[o.w.p.length - 1] : o.w.p[0];
    const dd = d + o.len;
    // the goal: this way passes the station; scored by the walk to the poi
    const g = nearestOn(o.w.p, tx, tz);
    if (g < GOAL_R && dd + g < bestCost) { bestCost = dd + g; best = id; }
    // leaving direction at the far end, to keep the turn rule at the weld
    const od = inDir(o.w.p, outEnd);
    const hx2 = -od[0], hz2 = -od[1];
    for (const nid of near(out[0], out[1], weld, reach)) {
      if ((nid >> 1) === (id >> 1)) continue;
      const nd = inDir(ways[nid >> 1].w.p, nid & 1);
      if (nd[0] * hx2 + nd[1] * hz2 < turn) continue;
      const q = endPt(nid);
      const c = dd + Math.hypot(q[0] - out[0], q[1] - out[1]);
      if (c < dist[nid]) { dist[nid] = c; prev[nid] = id; from[nid] = from[id]; push(nid, c); }
    }
  }
  if (best < 0) return null;
  const chain = [];
  for (let id = best; id >= 0; id = prev[id]) chain.push(id);
  chain.reverse();
  const k = from[chain[0]];
  const pts = [[tail[k].x, tail[k].z]], used = [], at = [null];
  let hx = tail[k].hx, hz = tail[k].hz;
  for (const id of chain) {
    const o = ways[id >> 1], p = o.w.p, n = p.length, rev = (id & 1) === 1;
    used.push(o.w);
    const cum = [0];
    for (let j = 1; j < n; j++) cum.push(cum[j - 1] + Math.hypot(p[j][0] - p[j - 1][0], p[j][1] - p[j - 1][1]));
    let fresh = true;
    for (let j = 0; j < n; j++) {
      const ix = rev ? n - 1 - j : j;
      const q = p[ix], last = pts[pts.length - 1];
      const dx = q[0] - last[0], dz = q[1] - last[1], L = Math.hypot(dx, dz);
      if (L < 0.4) continue;
      // a weld can overlap: the next way may begin a few metres BEHIND where
      // the last one ended; its points up to there would be a step back
      if (fresh && dx * hx + dz * hz <= 0) continue;
      fresh = false;
      pts.push(q);
      at.push([o.w, cum[ix]]);
      hx = dx / L; hz = dz / L;
    }
  }
  return { cut: k, pts, at, len: wayLen(pts), ways: used };
}

function nearestOn(p, x, z) {
  let best = Infinity;
  for (let i = 1; i < p.length; i++) {
    const ax = p[i - 1][0], az = p[i - 1][1], ex = p[i][0] - ax, ez = p[i][1] - az;
    const L = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(ax + ex * t - x, az + ez * t - z);
    if (d < best) best = d;
  }
  return best;
}
