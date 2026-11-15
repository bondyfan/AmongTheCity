// ---- coarseroute.js: the way to a far pin over roads not streamed yet -------
// The route planner (js/navigation.js) knows only the ways of the tiles that
// are resident, and since geo.js gives a far tile's ways back (RELEASE_DATA)
// that is a ring of about nine kilometres round the player. A pin in Prague
// set in Pardubice used to get a line that ended in a field at the edge of
// that ring. data/overview.json already carries every motorway, trunk,
// primary and secondary road of the region at map fidelity (the world map's
// base layer, 35 k ways, shared vertices exact to the metre), so this builds
// ONE small graph from it, once, and answers "how do I get from the end of
// the fine route to the pin" over it. Plain data, typed arrays, no THREE: the
// graph is a few megabytes for the whole region and lives for the session.
//
// It is a coarse answer on purpose: no one-way streets, no turn rules, speeds
// by road class. The fine planner takes over again as the tiles stream in
// (navigation retries a partial route), so this line is only ever the far
// part of the route, the part nobody is driving yet.

const SPEED = { motorway: 125, trunk: 100, primary: 80, secondary: 65 };   // km/h, open road
const SNAP = 1000;            // m, the snap grid
const SNAP_MAX = 6000;        // m: a pin further than this from any major road gets no coarse line
const WELD = 150;            // m: a way that ends this near another road joins it (see below)
const WELD_V = 40;           // km/h along such a joint
// a vertex to the metre, as one number (the region is ±200 km: 4e5 × 4e5 fits)
const key = (x, z) => (Math.round(x) + 200000) * 400000 + (Math.round(z) + 200000);

export class CoarseRoutes {
  /** `roads`: overview.json roads, [{ p: [[x, z], ...], t }]. Built at once (tests, tools). */
  constructor(roads) {
    if (roads) for (const _ of this.steps(roads));
  }

  /**
   * The same build a few milliseconds at a time, between frames (the region's
   * 35 k ways take about half a second): resolves to the finished graph.
   */
  static async create(roads, sliceMs = 4) {
    const c = new CoarseRoutes(null), it = c.steps(roads);
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
    for (;;) {
      const t0 = now();
      let r;
      do r = it.next(); while (!r.done && now() - t0 < sliceMs);
      if (r.done) return c;
      await new Promise((ok) => setTimeout(ok, 0));
    }
  }

  *steps(roads) {
    // 1. which vertices are nodes: every end, and every vertex two ways share
    const uses = new Map();
    let step = 0;
    for (const r of roads) {
      if ((++step & 1023) === 0) yield;
      if (!SPEED[r.t] || !(r.p?.length > 1)) continue;
      for (let i = 0; i < r.p.length; i++) {
        const k = key(r.p[i][0], r.p[i][1]);
        const u = uses.get(k) ?? 0;
        uses.set(k, u + (i === 0 || i === r.p.length - 1 ? 2 : 1));
      }
    }
    const id = new Map(), xs = [], zs = [];
    const nodeOf = (p) => {
      const k = key(p[0], p[1]);
      let i = id.get(k);
      if (i === undefined) { i = xs.length; id.set(k, i); xs.push(p[0]); zs.push(p[1]); }
      return i;
    };
    // 2. the edges between consecutive nodes along each way, both directions,
    // with the vertices between them kept for the line that is drawn
    const ea = [], eb = [], ecost = [], elen = [], epts = [];
    let vmax = 0;
    for (const r of roads) {
      if ((++step & 1023) === 0) yield;
      const v = SPEED[r.t];
      if (!v || !(r.p?.length > 1)) continue;
      vmax = Math.max(vmax, v);
      let from = 0, len = 0;
      for (let i = 1; i < r.p.length; i++) {
        len += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
        const last = i === r.p.length - 1;
        if (!last && (uses.get(key(r.p[i][0], r.p[i][1])) ?? 0) < 2) continue;
        const a = nodeOf(r.p[from]), b = nodeOf(r.p[i]);
        if (a !== b && len > 0) {
          const cost = len / (v / 3.6);
          ea.push(a); eb.push(b); ecost.push(cost); elen.push(len); epts.push(r.p.slice(from, i + 1));
        }
        from = i; len = 0;
      }
    }
    // 3. THE SLIP ROADS. The overview has no *_link ways, so a motorway's
    // carriageways meet the rest of the network nowhere but at their ends, and
    // a route from Pardubice to Prague went round the D11 by the old roads (165
    // km). A way that ends where no other way does is joined to the nearest
    // node of another way within WELD metres, at slip-road speed: that is
    // where its missing ramp, or the gap the map's simplification left, was.
    const deg0 = new Int32Array(xs.length);
    for (let e = 0; e < ea.length; e++) { deg0[ea[e]]++; deg0[eb[e]]++; }
    const cell = new Map(), C = WELD;
    yield;
    for (let i = 0; i < xs.length; i++) {
      const k = Math.floor(xs[i] / C) * 100000 + Math.floor(zs[i] / C);
      let a = cell.get(k);
      if (!a) cell.set(k, a = []);
      a.push(i);
    }
    const near = new Set();
    for (let e = 0; e < ea.length; e++) { near.add(ea[e] * 1e6 + eb[e]); near.add(eb[e] * 1e6 + ea[e]); }
    yield;
    for (let i = 0; i < xs.length; i++) {
      if ((i & 2047) === 2047) yield;
      if (deg0[i] !== 1) continue;
      const ci = Math.floor(xs[i] / C), cj = Math.floor(zs[i] / C);
      let best = -1, bd = WELD * WELD;
      for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
        for (const j of cell.get((ci + a) * 100000 + cj + b) ?? []) {
          if (j === i || near.has(i * 1e6 + j)) continue;
          const d = (xs[j] - xs[i]) ** 2 + (zs[j] - zs[i]) ** 2;
          if (d < bd) { bd = d; best = j; }
        }
      }
      if (best < 0) continue;
      const len = Math.sqrt(bd) || 1;
      ea.push(i); eb.push(best); ecost.push(len / (WELD_V / 3.6)); elen.push(len);
      epts.push([[xs[i], zs[i]], [xs[best], zs[best]]]);
      near.add(i * 1e6 + best); near.add(best * 1e6 + i);
    }
    yield;
    const n = xs.length, m = ea.length;
    this.n = n; this.m = m;
    this.x = Float64Array.from(xs); this.z = Float64Array.from(zs);
    this.invV = 3.6 / (vmax || 100);
    // adjacency as CSR: both directions of every edge
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < m; e++) { deg[ea[e] + 1]++; deg[eb[e] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.off = deg;
    this.to = new Int32Array(2 * m); this.eid = new Int32Array(2 * m);
    const fill = deg.slice(0, n);
    for (let e = 0; e < m; e++) {
      let k = fill[ea[e]]++; this.to[k] = eb[e]; this.eid[k] = e;
      k = fill[eb[e]]++; this.to[k] = ea[e]; this.eid[k] = ~e;     // ~e: walked backwards
    }
    this.cost = Float64Array.from(ecost); this.len = Float64Array.from(elen);
    this.pts = epts;
    // the snap grid: node ids by SNAP cell
    this.grid = new Map();
    for (let i = 0; i < n; i++) {
      const k = Math.floor(xs[i] / SNAP) + ',' + Math.floor(zs[i] / SNAP);
      let a = this.grid.get(k);
      if (!a) this.grid.set(k, a = []);
      a.push(i);
    }
    // search scratch, reused
    this._g = new Float64Array(n); this._came = new Int32Array(n); this._seen = new Int32Array(n);
    this._gen = 0;
    // the last answer: a partial route is planned again every few seconds as
    // tiles stream in, and its far end snaps to the same two nodes nearly
    // every time (one search of the region is 7 ms of a frame, quiet machine)
    this._memo = null; this._memoS = -1; this._memoT = -1;
  }

  /** The node nearest (x, z) within SNAP_MAX, or -1. */
  nearest(x, z) {
    let best = -1, bd = SNAP_MAX * SNAP_MAX;
    const ci = Math.floor(x / SNAP), cj = Math.floor(z / SNAP), R = Math.ceil(SNAP_MAX / SNAP);
    for (let r = 0; r <= R; r++) {
      for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
        if (Math.max(Math.abs(a), Math.abs(b)) !== r) continue;     // this ring only
        for (const i of this.grid.get((ci + a) + ',' + (cj + b)) ?? []) {
          const d = (this.x[i] - x) ** 2 + (this.z[i] - z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      // a ring further out cannot hold anything nearer than r - 1 cells
      if (best >= 0 && bd <= ((r) * SNAP) ** 2) break;
    }
    return best;
  }

  /**
   * The fastest coarse way from (ax, az) to (bx, bz): { pts: [[x, z], ...],
   * len (m), secs, speeds (m/s, one per point) }, or null where either end is
   * too far from a major road or nothing connects them.
   */
  route(ax, az, bx, bz) {
    const s = this.nearest(ax, az), t = this.nearest(bx, bz);
    if (s < 0 || t < 0) return null;
    if (s === this._memoS && t === this._memoT) return this._memo;
    this._memoS = s; this._memoT = t;
    return (this._memo = this._search(s, t));
  }

  _search(s, t) {
    const g = this._g, came = this._came, seen = this._seen, gen = ++this._gen;
    const tx = this.x[t], tz = this.z[t];
    const heap = new MinHeap();
    seen[s] = gen; g[s] = 0; came[s] = -1;
    heap.push(0, s);
    let found = s === t;
    while (heap.size && !found) {
      const i = heap.pop();
      if (i === t) { found = true; break; }
      const gi = g[i];
      for (let k = this.off[i]; k < this.off[i + 1]; k++) {
        const j = this.to[k], e = this.eid[k];
        const ng = gi + this.cost[e < 0 ? ~e : e];
        if (seen[j] === gen && ng >= g[j]) continue;
        seen[j] = gen; g[j] = ng; came[j] = k;
        heap.push(ng + Math.hypot(this.x[j] - tx, this.z[j] - tz) * this.invV, j);
      }
    }
    if (!found) return null;
    // walk back, then lay the edges' own vertices end to end
    const ks = [];
    for (let i = t; came[i] >= 0;) { const k = came[i]; ks.push(k); i = this._from(k); }
    ks.reverse();
    const pts = [[this.x[s], this.z[s]]], speeds = [0];
    let len = 0;
    for (const k of ks) {
      const e = this.eid[k], fwd = e >= 0, id = fwd ? e : ~e;
      const p = this.pts[id], v = this.len[id] / this.cost[id];
      for (let q = 1; q < p.length; q++) { pts.push(fwd ? p[q] : p[p.length - 1 - q]); speeds.push(v); }
      len += this.len[id];
    }
    speeds[0] = speeds[1] ?? 0;
    return { pts, len, secs: g[t], speeds };
  }

  // the node an adjacency slot leaves from (the slot is filed under it)
  _from(k) {
    let lo = 0, hi = this.n;           // off[] is sorted: the last i with off[i] <= k
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.off[mid] <= k) lo = mid; else hi = mid; }
    return lo;
  }
}

// a binary heap of (priority, id)
class MinHeap {
  constructor() { this.k = []; this.v = []; this.size = 0; }
  push(k, v) {
    let i = this.size++;
    this.k[i] = k; this.v[i] = v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= k) break;
      this.k[i] = this.k[p]; this.v[i] = this.v[p]; i = p;
    }
    this.k[i] = k; this.v[i] = v;
  }
  pop() {
    const top = this.v[0], n = --this.size;
    const k = this.k[n], v = this.v[n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.k[c + 1] < this.k[c]) c++;
      if (this.k[c] >= k) break;
      this.k[i] = this.k[c]; this.v[i] = this.v[c]; i = c;
    }
    this.k[i] = k; this.v[i] = v;
    return top;
  }
}
