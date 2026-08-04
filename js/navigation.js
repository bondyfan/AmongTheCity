// ---- Navigation: "how do I get there", on the real road graph (v7) ----
// The world already knows which ways a car may drive (`d === 1`) and how fast
// (`v` km/h), and traffic.js already turns that into a junction graph. This
// module builds the SAME graph for a different question: traffic asks "where
// does this car go next", navigation asks "what is the fastest way from here
// to that pin on the world map". Sharing the node keying is not a nicety —
// if the two disagreed about what a junction is, the GPS line would route
// through a crossing the AI cars cannot take, and vice versa. So keyOf(),
// the usage census and the way-splitting rule below are a deliberate mirror
// of traffic.js's _growGraph, down to the 10 cm coordinate rounding.
//
// Three things make this affordable on a world that reaches Prague:
//
//   · The graph GROWS. city.onTileLoaded hands us one 4.8 km tile's roads at
//     a time and we ingest only those — nothing is ever rebuilt from scratch,
//     and a way stamped `_ng` can never be ingested twice. (Roads are the one
//     layer geo.js never evicts, so the graph only ever gets bigger, which is
//     also why nothing here has to handle a node disappearing.)
//   · A* runs on an ADMISSIBLE heuristic and stops the instant optimality is
//     proven, with a hard cap on expansions so a hopeless search cannot eat a
//     frame. See _search for why straight-line ÷ fastest-edge-speed can never
//     overestimate.
//   · Start and destination snap to the nearest EDGE and the partial segments
//     are spliced onto the node path. Snapping to the nearest NODE instead is
//     the classic GPS bug where your route begins at a junction 200 m behind
//     the car and the line points backwards down the street you just left.
//
// Unreachable is not an error. A village whose lane has not streamed in yet,
// or a pin on the far side of a river with no mapped bridge, still gets the
// best-so-far route — the settled node closest to the target — because a line
// pointing at the main road is infinitely more useful than `null`.

import { distPointToSegment } from './geo.js';

// ---- graph keying: MUST agree with traffic.js ----------------------------
// 10 cm snapping welds shared OSM nodes without gluing near-misses, and it is
// what stitches tiles: build-region clips ways at tile borders and both halves
// carry the border point, so they hash to the same node.
const keyOf = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);

// A deliberate COPY of traffic.js's Czech speed defaults (that file exports
// neither the table nor the helper, and importing it here would drag THREE and
// the audio graph into a pure-data module). Two sources of truth is a real
// cost, accepted for one reason: the router must prefer the roads the AI cars
// actually drive fast on, and traffic's table is what defines that.
const SPEED_DFLT = {
  motorway: 110, trunk: 110, tertiary: 70,
  residential: 50, unclassified: 50, living_street: 20, service: 30,
  motorway_link: 60, trunk_link: 60, primary_link: 60, secondary_link: 60, tertiary_link: 60,
};
const BUILT_UP_R = 1800;      // m from the origin ≈ the edge of Pardubice proper
function defaultV(t, x, z) {
  if (t === 'primary' || t === 'secondary')
    return Math.sqrt(x * x + z * z) > BUILT_UP_R ? 90 : (t === 'primary' ? 50 : 70);
  return SPEED_DFLT[t] ?? 50;
}

// ---- tunables ------------------------------------------------------------
const GRID = 128;             // snap-bucket size (m). Bigger than traffic's 64 on
                              // purpose: a pin dropped in a field is kilometres from
                              // the nearest road and the ring search below walks
                              // cells, so fewer, fatter cells means fewer rings.
const MAX_RING = 40;          // …and 40 rings is a 5 km reach. Past that there is
                              // genuinely no road and the destination is refused.
const MAX_EXPAND = 40000;     // settled nodes per search. Pardubice→Prague settles
                              // ~12 k; the cap exists for the hopeless searches.
const OFF_ROUTE = 35;         // m off the line before we admit the driver left it
const REROUTE_DT = 1;         // s — a route is expensive and a driver weaving in a
                              // lane is not lost
const PARTIAL_RETRY = 6;      // s — a route that ended short is retried as tiles
                              // stream in, because the missing road may have landed
const PARTIAL_MAX = 30;       // …but a genuinely unreachable pin would then pay for
                              // a capped 40 k-node search every 6 s forever, so the
                              // interval doubles up to here and only resets when the
                              // graph actually GREW (new roads are new information)
const CAND_K = 6;             // destination snap candidates (see _snapMany)
const CAND_BAND = 120;        // …all within this much of the nearest one
const PIN_K = 3;              // how dearly a candidate pays for the metres still
                              // between it and the pin, in units of vmax driving.
                              // Must be ≥ 1 for the heuristic to stay admissible
                              // (see _search); at exactly 1 the router is
                              // INDIFFERENT between driving the last 100 m and
                              // stopping 100 m short, and it measurably stopped
                              // short. 3 means "a 300 m detour to finish at the
                              // door is worth it, a 3 km one is not".
// ---- the ETA ------------------------------------------------------------
// The router already costs every edge in SECONDS (len/speed), so the arrival
// time is not a second model of the world — it is the same number the search
// minimised, carried through to the polyline and read off at the driver's
// position. Two corrections turn free-flow seconds into an honest estimate:
//
//   TIME_K   nobody drives a route at the speed limit end to end. Junctions,
//            give-ways, the slow crawl out of a housing estate and the
//            accelerating back up to 90 all cost time the edge costs do not
//            model. 1.25 is the factor that made a measured Pardubice→Sezemice
//            run land within a minute; it is a fudge, and it is labelled one.
//   GAP_V    a PARTIAL route stops short and remainingM already adds the
//            straight line to the pin. That last stretch has no road to take a
//            speed from, so it is charged at a slow one — it is usually a field
//            track or an unstreamed lane, never a motorway.
const TIME_K = 1.25;
const GAP_V = 11;             // m/s ≈ 40 km/h for the unmapped tail
const MIN_V = 2.8;            // m/s floor, so a broken speed cannot divide by ~0

const TURN_MIN = 0.38;        // rad (~22°) — below this a junction is "carrying on"
const TURN_PASSED = 2;        // m past a junction before it stops being "next"
const MIN_VMAX = 8;           // m/s floor for the heuristic on an empty graph

// ---- shared scratch: the update path never allocates ----------------------
const _cp = { x: 0, z: 0, t: 0 };            // distPointToSegment output
const _pa = { x: 0, z: 0, i: 0 }, _pb = { x: 0, z: 0, i: 0 };
const _chain = [];                            // reconstructed edge list
// snap candidate pools, allocated once: one slot for the car (it is ON a road,
// there is nothing to choose), CAND_K for the pin (see _snapMany)
const mkCand = () => ({ seg: null, s: 0, x: 0, z: 0, d: 0 });
const _poolA = [mkCand()];
const _poolB = []; for (let i = 0; i < CAND_K; i++) _poolB.push(mkCand());

// direction of travel along a directed edge. A reversed edge walks its
// segment's geometry backwards, so its first tangent is the segment's LAST
// one, negated — storing both directions' tangents would double the memory
// for arithmetic this cheap.
const firstDX = (e) => (e.rev ? -e.seg.ldx : e.seg.fdx);
const firstDZ = (e) => (e.rev ? -e.seg.ldz : e.seg.fdz);
const lastDX = (e) => (e.rev ? -e.seg.fdx : e.seg.ldx);
const lastDZ = (e) => (e.rev ? -e.seg.fdz : e.seg.ldz);

// ---- binary heap over (f, node), on typed arrays -------------------------
// A Map/array-of-objects priority queue would allocate one wrapper per push,
// and a cross-region search pushes six figures of them. This one allocates
// only when it outgrows itself, which happens twice in a session.
class Heap {
  constructor(cap = 4096) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  clear() { this.n = 0; }
  push(key, val) {
    if (this.n === this.k.length) {
      const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    const k = this.k, v = this.v;
    let i = this.n++;
    while (i > 0) {                              // sift up through the hole
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v, out = v[0], n = --this.n;
    if (n > 0) {
      const key = k[n], val = v[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && k[c + 1] < k[c]) c++;
        if (k[c] >= key) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = key; v[i] = val;
    }
    return out;
  }
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Navigation {
  constructor(city) {
    this.city = city;

    // ---- public contract ----
    this.route = null;          // [[x,z]…] world polyline, or null
    this.remainingM = null;     // metres left ALONG THE ROAD, or null
    this.etaS = null;           // seconds left at the modelled speeds, or null
    this.nextTurn = null;       // { dist, dir, street } | null — one reused object
    this.destination = null;    // {x,z} | null
    this.partial = false;       // true when the route stops short of the pin
    this.offRoute = 0;          // m from the player to the line (0 with no route)
    // diagnostics, not contract. `edges` counts SEGMENTS — split way pieces —
    // of which a two-way street is one, walked in either direction.
    this.stats = { nodes: 0, edges: 0, expanded: 0, ms: 0, partial: false, capped: false };

    // ---- the graph ----
    this.nodes = [];            // { x, z, out: [] } — the ARRAY INDEX is the node id,
                                // which is what lets the A* state live in typed arrays
    this._nodeIx = new Map();   // keyOf(x,z) → index
    this._usage = new Map();    // keyOf → { n, last }: PERSISTENT, so a side street
                                // arriving three tiles later still turns an existing
                                // way's interior point into a junction
    this._segs = [];            // undirected geometry, one per split way piece
    this._grid = new Map();     // GRID cell key → seg[] (snapping only)
    this._vmax = MIN_VMAX;      // fastest edge speed seen — the heuristic's divisor
    this._sv = 0;               // snap visit stamp (a seg spans several grid cells)

    // ---- A* scratch, sized with the graph rather than per search ----
    this._gen = 0;              // search generation: makes "unvisited" free to test
    this._cap = 0;
    this._g = null; this._stamp = null; this._closed = null;
    this._cameE = null; this._cameN = null;
    this._heap = new Heap();

    // ---- route tracking ----
    this._cum = null;           // arclength at every route point
    this._cumT = null;          // …and the free-flow seconds to reach it
    this._gapT = 0;             // seconds charged for a partial route's tail
    this._i = 0; this._s = 0;   // current segment index + arclength along the route
    this._joints = [];          // turn markers { s, dir, street }
    this._ji = 0;               // cursor into them
    this._gap = 0;              // straight-line from a partial route's end to the pin
    this._since = 1e9;          // s since the last search (gates the re-route rate)
    this._retryIn = PARTIAL_RETRY;  // …and the current partial-route backoff
    this._bd = 0; this._bi = 0; this._bs = 0;  // _scan results, kept off the stack
    this._turn = { dist: 0, dir: 'straight', street: null };

    // whatever already streamed in, then every tile after us
    this._growGraph(city.roads ?? []);
    city.onTileLoaded?.((t) => this._growGraph(t.roads ?? []));
  }

  // ======================= graph construction ==============================

  // One tile's roads. Mirrors traffic.js: count how many DISTINCT drivable ways
  // touch each snapped point, then split every way at its ends and at any
  // interior point ≥2 ways share. Same blind spot, deliberately: a way arriving
  // later that crosses an already-built segment mid-polyline does not retro-
  // split it. Inheriting the flaw is the point — the two graphs stay identical,
  // and cross-tile joins are way ENDPOINTS, which are always nodes.
  _growGraph(roads) {
    const fresh = [];
    for (const r of roads ?? []) {
      if (r.d !== 1 || !r.p || r.p.length < 2 || r._ng) continue;
      r._ng = 1;                                 // traffic.js owns `_tg`; this is ours
      fresh.push(r);
      for (const [x, z] of r.p) {
        const k = keyOf(x, z);
        const u = this._usage.get(k);
        // a point may repeat inside one way (loops) — comparing the last way
        // keeps that from inflating the count into a phantom junction
        if (!u) this._usage.set(k, { n: 1, last: r });
        else if (u.last !== r) { u.n++; u.last = r; }
      }
    }
    for (const r of fresh) {
      const p = r.p;
      let start = 0;
      for (let i = 1; i < p.length; i++) {
        if (i === p.length - 1 || this._usage.get(keyOf(p[i][0], p[i][1])).n >= 2) {
          this._addSeg(r, p.slice(start, i + 1));
          start = i;
        }
      }
    }
    this.stats.nodes = this.nodes.length;
    this.stats.edges = this._segs.length;
    // a tile that carried drivable ways is the only reason a partial route
    // might complete this time, so it — and nothing else — resets the backoff
    if (fresh.length) this._retryIn = PARTIAL_RETRY;
  }

  _nodeAt(x, z) {
    const k = keyOf(x, z);
    let i = this._nodeIx.get(k);
    if (i === undefined) {
      i = this.nodes.length;
      this.nodes.push({ x, z, out: [] });
      this._nodeIx.set(k, i);
    }
    return i;
  }

  // One split way piece → one geometry record + one or two DIRECTED edges.
  // The reverse direction shares the geometry (no mirrored point array): rev
  // edges read `pts` backwards, which is what firstDX/lastDX above encode.
  _addSeg(road, pts) {
    const n = pts.length;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dz = pts[i][1] - pts[i - 1][1];
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz);
    }
    const len = cum[n - 1];
    if (len < 0.5) return;                       // degenerate / duplicate points
    // km/h → m/s, with traffic.js's own corrections for the two class defaults
    // build-city.mjs stamps wrong (Czech law is 50 in a built-up area).
    const mid = pts[n >> 1];
    let kmh = road.v || defaultV(road.t, mid[0], mid[1]);
    if (road.t === 'residential' && kmh === 30) kmh = 50;
    else if (road.t === 'unclassified' && kmh === 40) kmh = 50;
    const speed = kmh / 3.6;
    const Lf = cum[1] || 1, Ll = (cum[n - 1] - cum[n - 2]) || 1;
    const seg = {
      pts, cum, len, speed, road, name: road.n ?? null,
      fdx: (pts[1][0] - pts[0][0]) / Lf, fdz: (pts[1][1] - pts[0][1]) / Lf,
      ldx: (pts[n - 1][0] - pts[n - 2][0]) / Ll, ldz: (pts[n - 1][1] - pts[n - 2][1]) / Ll,
      f: null, r: null, _v: 0,
    };
    const a = this._nodeAt(pts[0][0], pts[0][1]);
    const b = this._nodeAt(pts[n - 1][0], pts[n - 1][1]);
    const cost = len / speed;
    seg.f = { seg, rev: 0, a, b, cost };
    this.nodes[a].out.push(seg.f);
    // a oneway never grows a reverse twin — exactly as traffic.js decides it,
    // so the router can never send the player up a street the AI refuses
    if (!road.ow) {
      seg.r = { seg, rev: 1, a: b, b: a, cost };
      this.nodes[b].out.push(seg.r);
    }
    this._segs.push(seg);
    this._gridAdd(seg);
    if (speed > this._vmax) this._vmax = speed;
  }

  // A segment occupies every grid cell its polyline passes through, not just
  // its endpoints' — half-cell steps along each piece cannot skip a cell.
  _gridAdd(seg) {
    const pts = seg.pts, g = this._grid;
    let lastK = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
      const L = Math.sqrt((bx - ax) * (bx - ax) + (bz - az) * (bz - az));
      const steps = Math.max(1, Math.ceil(L / (GRID / 2)));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const k = Math.floor((ax + (bx - ax) * t) / GRID) + ','
          + Math.floor((az + (bz - az) * t) / GRID);
        if (k === lastK) continue;               // consecutive samples repeat a lot
        lastK = k;
        let a = g.get(k);
        if (!a) g.set(k, a = []);
        if (a[a.length - 1] !== seg && !a.includes(seg)) a.push(seg);
      }
    }
  }

  // ======================= snapping ========================================

  // The k nearest SEGMENTS to (x,z), as an expanding ring walk over the grid.
  // A cell at Chebyshev ring r is at least (r−1)·GRID away, so once everything
  // that could still qualify is closer than that, the remaining rings cannot
  // beat it — which is what makes "the pin is 3 km from any road" cost rings
  // rather than a scan of every road in the region.
  //
  // Why k > 1 for the destination, measured on the real data: the nearest road
  // to a pin dropped near a block of flats is very often the COURTYARD service
  // lane, which reaches the street network through a gate the data does not
  // call drivable. Snapping to it alone turns a one-kilometre trip into a
  // "destination unreachable" partial. Handing the search half a dozen nearby
  // candidates lets it pick the one you can actually drive to — which is what
  // a real satnav does when it says "nearest road access".
  _snapMany(x, z, k, pool) {
    const g = this._grid;
    const cx = Math.floor(x / GRID), cz = Math.floor(z / GRID);
    const stamp = ++this._sv;
    let n = 0, worst = Infinity;                 // worst = the distance to beat
    const consider = (seg, d, px, pz, s) => {
      // insertion sort into the pooled top-k: k is 1 or 6, so this is cheaper
      // than any heap and allocates nothing
      if (n === k && d >= pool[k - 1].d) return;
      let i = n < k ? n++ : k - 1;
      while (i > 0 && pool[i - 1].d > d) {
        const p = pool[i], q = pool[i - 1];       // swap the RECORDS, not fields
        pool[i] = q; pool[i - 1] = p; i--;
      }
      const c = pool[i];
      c.seg = seg; c.d = d; c.x = px; c.z = pz; c.s = s;
    };
    for (let ring = 0; ring <= MAX_RING; ring++) {
      // stop only once the whole candidate BAND is proven covered, not merely
      // the nearest hit — otherwise a candidate one ring out could be missed
      if (n && pool[0].d + CAND_BAND <= (ring - 1) * GRID) break;
      for (let i = -ring; i <= ring; i++) {
        // only the PERIMETER of the ring is new — the interior was walked
        // already — so the two edge columns are the only j's worth visiting
        // unless this row is itself an edge row
        const edgeRow = (i === -ring || i === ring);
        for (let j = -ring; j <= ring; j += (edgeRow ? 1 : 2 * ring || 1)) {
          const cell = g.get((cx + i) + ',' + (cz + j));
          if (!cell) continue;
          for (const seg of cell) {
            if (seg._v === stamp) continue;      // a seg spans several cells
            seg._v = stamp;
            const pts = seg.pts;
            let bd = Infinity, bx = 0, bz = 0, bs = 0;
            for (let m = 0; m < pts.length - 1; m++) {
              const d = distPointToSegment(x, z, pts[m][0], pts[m][1],
                pts[m + 1][0], pts[m + 1][1], _cp);
              if (d >= bd) continue;
              bd = d; bx = _cp.x; bz = _cp.z;
              bs = seg.cum[m] + _cp.t * (seg.cum[m + 1] - seg.cum[m]);
            }
            if (bd < worst) consider(seg, bd, bx, bz, bs);
          }
        }
      }
      if (n) worst = pool[0].d + CAND_BAND;      // …anything further is not a candidate
    }
    // trim the band: a road 400 m from the pin is not "the destination"
    while (n > 1 && pool[n - 1].d > pool[0].d + CAND_BAND) n--;
    return n;
  }

  // ======================= A* ==============================================

  _ensureCap(n) {
    if (n <= this._cap) return;
    let cap = Math.max(1024, this._cap || 1024);
    while (cap < n) cap *= 2;
    this._cap = cap;
    this._g = new Float64Array(cap);
    this._stamp = new Int32Array(cap);
    this._closed = new Uint8Array(cap);
    this._cameN = new Int32Array(cap);
    this._cameE = new Array(cap);
    this._gen = 0;                               // fresh arrays start unstamped
  }

  // The heuristic. h(n) = straight-line(n → the PIN) ÷ the FASTEST edge speed
  // anywhere in the graph. It cannot overestimate: any real route from n is at
  // least as long as the straight line, and every metre of it is driven at some
  // speed ≤ vmax, so its time is at least dist/vmax. It is also CONSISTENT
  // (edge cost len/speed ≥ len/vmax ≥ |h(a)−h(b)|), which is why a node may be
  // closed the moment it is popped and never reopened.
  // vmax only ever GROWS as tiles stream in, and a growing divisor only makes
  // h smaller — an admissible heuristic cannot become inadmissible here.
  //
  // The one thing that WOULD break admissibility is measuring h to the pin
  // while the goal is really "arrive on a road c.d metres away from it": h
  // could then exceed the true remaining cost by c.d/vmax. So arriving on a
  // candidate is charged its own snap distance at vmax, `c.d·PIN_K·invV`.
  // Then, since PIN_K ≥ 1, |n−c.point| + PIN_K·c.d ≥ |n−c.point| + |c.point−pin|
  // ≥ |n−pin| by the triangle inequality, and h is a lower bound again — with
  // the pleasant side effect that of two equally drivable candidates the one
  // nearer the pin wins.
  //
  // `nC === 0` is legal: a pin dropped where no road has streamed in yet has no
  // segment to arrive on. The search then has no target at all and runs purely
  // for its best-so-far — which is the whole point of aiming at (bx,bz) rather
  // than at a node id.
  _search(A, cands, nC, bx, bz) {
    const nodes = this.nodes;
    this._ensureCap(nodes.length);
    const gen = ++this._gen;
    const g = this._g, stamp = this._stamp, closed = this._closed;
    const cameE = this._cameE, cameN = this._cameN;
    const heap = this._heap;
    heap.clear();
    const invV = 1 / Math.max(MIN_VMAX, this._vmax);

    // Each candidate segment, entered from either of its ends: arriving at that
    // end still owes `extra` seconds — the drive up the segment to the snap
    // point, plus the walk-off charge above. Two candidates can share an end
    // node, in which case the cheaper arrival owns it.
    const tgt = new Map();
    const addTarget = (c, e) => {
      if (!e) return;
      const sIn = e.rev ? c.seg.len - c.s : c.s;
      const extra = sIn / c.seg.speed + c.d * PIN_K * invV;
      const old = tgt.get(e.a);
      if (!old || extra < old.extra) tgt.set(e.a, { edge: e, extra, cand: c });
    };
    for (let i = 0; i < nC; i++) {
      addTarget(cands[i], cands[i].seg.f);
      addTarget(cands[i], cands[i].seg.r);
    }

    let bestTotal = Infinity, goalNode = -1, goalEdge = null, goalCand = null;
    let direct = null, directCand = null;
    let bestH = Infinity, bestNode = -1;

    // Seed: leaving the start segment towards either of its ends, paying only
    // for the part of it still ahead of us. This is the splice that keeps the
    // route from beginning at a junction behind the car.
    const seed = (e) => {
      if (!e) return;
      const sIn = e.rev ? A.seg.len - A.s : A.s;
      const g0 = (A.seg.len - sIn) / A.seg.speed;
      // DIRECT case: a candidate lies on the very segment we stand on, ahead of
      // us in this direction — no graph walk at all, and no detour out to a
      // junction and back, which is what a pure node search would produce.
      for (let i = 0; i < nC; i++) {
        const c = cands[i];
        if (c.seg !== A.seg) continue;
        const tIn = e.rev ? c.seg.len - c.s : c.s;
        if (tIn < sIn) continue;
        const cost = (tIn - sIn) / A.seg.speed + c.d * PIN_K * invV;
        if (cost < bestTotal) { bestTotal = cost; direct = e; directCand = c; goalNode = -1; }
      }
      const n = nodes[e.b], ddx = n.x - bx, ddz = n.z - bz;
      const h = Math.sqrt(ddx * ddx + ddz * ddz) * invV;
      if (stamp[e.b] !== gen) { stamp[e.b] = gen; closed[e.b] = 0; g[e.b] = Infinity; }
      if (g0 >= g[e.b]) return;
      g[e.b] = g0; cameE[e.b] = e; cameN[e.b] = -1;
      heap.push(g0 + h, e.b);
    };
    seed(A.seg.f); seed(A.seg.r);

    let pops = 0, capped = false;
    while (heap.n) {
      // OPTIMALITY STOP: nothing left in the queue can beat the best complete
      // candidate, so the answer is proven and the search ends here rather than
      // draining the whole frontier.
      if (heap.k[0] >= bestTotal) break;
      const i = heap.pop();
      if (closed[i]) continue;                   // stale duplicate from a relax
      closed[i] = 1;
      pops++;
      const n = nodes[i], ddx = n.x - bx, ddz = n.z - bz;
      const hi = Math.sqrt(ddx * ddx + ddz * ddz) * invV;
      // best-so-far: the settled node that got closest to the pin. This is the
      // village-with-no-mapped-connection answer, and it costs one comparison.
      if (hi < bestH) { bestH = hi; bestNode = i; }
      const t = tgt.get(i);
      if (t && g[i] + t.extra < bestTotal) {
        bestTotal = g[i] + t.extra;
        goalNode = i; goalEdge = t.edge; goalCand = t.cand; direct = null;
      }
      if (pops >= MAX_EXPAND) { capped = true; break; }
      const gi = g[i], out = n.out;
      for (let e = 0; e < out.length; e++) {
        const ed = out[e], j = ed.b;
        if (stamp[j] !== gen) { stamp[j] = gen; closed[j] = 0; g[j] = Infinity; }
        if (closed[j]) continue;
        const ng = gi + ed.cost;
        if (ng >= g[j]) continue;
        g[j] = ng; cameE[j] = ed; cameN[j] = i;
        const nj = nodes[j], jx = nj.x - bx, jz = nj.z - bz;
        heap.push(ng + Math.sqrt(jx * jx + jz * jz) * invV, j);
      }
    }
    this.stats.expanded = pops;
    this.stats.capped = capped;
    return { direct, directCand, goalNode, goalEdge, goalCand, bestNode };
  }

  // ======================= route assembly ==================================

  // Append the stretch of directed edge `e` between travel-arclengths s0..s1.
  // Everything is expressed in the segment's FORWARD arclength so one walk
  // serves both directions; the endpoints are interpolated so a route can start
  // and end in the middle of a segment.
  //
  // `spd` grows in lockstep with `out`: spd[i] is the speed of the piece of
  // road the driver is on while travelling INTO point i, which is what makes
  // the arclength→time integral in reroute() a straight parallel walk. At a
  // splice the arriving edge's last point and the leaving edge's first point
  // are the same place, pushPt drops the second, and the junction point keeps
  // the ARRIVING speed — correct, because the interval that ends there was
  // driven on the old road and the next interval already carries the new one.
  _emit(out, spd, e, s0, s1) {
    const seg = e.seg, pts = seg.pts, v = seg.speed;
    const f0 = e.rev ? seg.len - s0 : s0, f1 = e.rev ? seg.len - s1 : s1;
    fwdPoint(seg, f0, _pa); fwdPoint(seg, f1, _pb);
    pushPt(out, spd, _pa.x, _pa.z, v);
    if (f1 >= f0) for (let i = _pa.i + 1; i <= _pb.i; i++) pushPt(out, spd, pts[i][0], pts[i][1], v);
    else for (let i = _pa.i; i > _pb.i; i--) pushPt(out, spd, pts[i][0], pts[i][1], v);
    pushPt(out, spd, _pb.x, _pb.z, v);
  }

  // Turn instruction at a junction: the angle from the arriving tangent to the
  // departing one. Right of travel is (−dz, dx) in this frame (x east, z SOUTH),
  // so the 2D cross product dx·nz − dz·nx is positive for a right turn.
  _joint(prev, next, nodeIx) {
    const dx = lastDX(prev), dz = lastDZ(prev), nx = firstDX(next), nz = firstDZ(next);
    const crs = dx * nz - dz * nx, dot = dx * nx + dz * nz;
    const ang = Math.atan2(crs, dot);
    if (Math.abs(ang) > TURN_MIN) return crs > 0 ? 'right' : 'left';
    // Straight on is only worth SAYING at a genuine crossroads where the street
    // you continue onto has a different name — otherwise every polyline kink in
    // the data would become an instruction.
    const changed = next.seg.name && next.seg.name !== prev.seg.name;
    return (changed && this.nodes[nodeIx].out.length >= 3) ? 'straight' : null;
  }

  // Walk the came-from chain back to the seed, then lay the polyline down in
  // travel order: partial start segment, whole edges, partial end segment.
  _build(A, res) {
    const out = [], spd = [], joints = [];
    if (res.direct) {                            // same segment, pin straight ahead
      const e = res.direct, c = res.directCand;
      const sIn = e.rev ? A.seg.len - A.s : A.s, tIn = e.rev ? c.seg.len - c.s : c.s;
      this._emit(out, spd, e, sIn, tIn);
      return { pts: out, spd, joints, complete: true };
    }
    const end = res.goalNode >= 0 ? res.goalNode : res.bestNode;
    if (end < 0) return null;
    _chain.length = 0;
    for (let n = end; n >= 0;) {
      const e = this._cameE[n];
      if (!e) break;
      _chain.push(e);
      n = this._cameN[n];
    }
    _chain.reverse();
    if (!_chain.length) return null;
    const head = _chain[0];
    const sIn = head.rev ? A.seg.len - A.s : A.s;
    this._emit(out, spd, head, sIn, head.seg.len);
    for (let i = 1; i < _chain.length; i++) {
      const e = _chain[i], prev = _chain[i - 1];
      const dir = this._joint(prev, e, prev.b);
      if (dir) joints.push({ idx: out.length - 1, dir, street: e.seg.name });
      this._emit(out, spd, e, 0, e.seg.len);
    }
    const complete = res.goalNode >= 0 && res.goalEdge != null;
    if (complete) {                              // splice the tail onto the pin
      const f = res.goalEdge, c = res.goalCand, tIn = f.rev ? c.seg.len - c.s : c.s;
      const dir = this._joint(_chain[_chain.length - 1], f, f.a);
      if (dir) joints.push({ idx: out.length - 1, dir, street: f.seg.name });
      this._emit(out, spd, f, 0, tIn);
    }
    return { pts: out, spd, joints, complete };
  }

  // ======================= public API ======================================

  setDestination(x, z) {
    this.destination = { x, z };
    this.route = null; this.remainingM = null; this.etaS = null; this.nextTurn = null;
    this._since = 1e9;                           // route on the very next update
    this._retryIn = PARTIAL_RETRY;
  }

  clear() {
    this.destination = null;
    this.route = null; this.remainingM = null; this.etaS = null; this.nextTurn = null;
    this.partial = false; this.offRoute = 0; this.stats.partial = false;
    this._joints.length = 0; this._cum = null; this._cumT = null;
    this._i = 0; this._s = 0; this._ji = 0;
    this._gap = 0; this._gapT = 0; this._retryIn = PARTIAL_RETRY;
  }

  // Compute a fresh route from (x,z) to the standing destination. Public so a
  // caller can force one (e.g. the moment the map's waypoint moves) without
  // waiting for the rate limiter; update() is the normal path.
  reroute(x, z) {
    this._since = 0;
    const dest = this.destination;
    if (!dest) return false;
    const t0 = now();
    // A missing START snap is the one thing we cannot route around — there is
    // no position in the graph to leave from (a helicopter over unstreamed
    // country). A missing DESTINATION snap is fine: aim at the raw pin.
    const nA = this._snapMany(x, z, 1, _poolA);
    const nB = this._snapMany(dest.x, dest.z, CAND_K, _poolB);
    if (!nA) { this.stats.ms = now() - t0; return false; }
    const res = this._search(_poolA[0], _poolB, nB, dest.x, dest.z);
    const built = this._build(_poolA[0], res);
    this.stats.ms = now() - t0;
    if (!built || built.pts.length < 2) return false;
    this.route = built.pts;
    this.partial = !built.complete;
    this.stats.partial = this.partial;
    this._retryIn = this.partial ? Math.min(PARTIAL_MAX, this._retryIn * 2) : PARTIAL_RETRY;
    // arclengths once, here — every per-frame question (how far is left, how
    // far to the turn, am I still on the line) is then a subtraction
    const n = built.pts.length;
    const cum = this._cum = new Float64Array(n);
    // …and the SAME pass in seconds, at each piece's own speed. One array more
    // makes the ETA the same kind of question as "how far is left": a
    // subtraction, not a model that has to be re-run every frame.
    const cumT = this._cumT = new Float64Array(n);
    const spd = built.spd;
    for (let i = 1; i < n; i++) {
      const dx = built.pts[i][0] - built.pts[i - 1][0], dz = built.pts[i][1] - built.pts[i - 1][1];
      const d = Math.sqrt(dx * dx + dz * dz);
      cum[i] = cum[i - 1] + d;
      cumT[i] = cumT[i - 1] + d / Math.max(MIN_V, spd[i] || 0);
    }
    this._joints.length = 0;
    for (const j of built.joints)
      this._joints.push({ s: cum[j.idx], dir: j.dir, street: j.street });
    this._ji = 0; this._i = 0; this._s = 0;
    // a partial route stops short; the straight-line remainder is added to
    // remainingM so the HUD's distance never lies about how far away the pin is
    const last = built.pts[n - 1];
    this._gap = this.partial
      ? Math.sqrt((dest.x - last[0]) ** 2 + (dest.z - last[1]) ** 2) : 0;
    this._gapT = this._gap / GAP_V;
    this._track(x, z, true);
    return true;
  }

  // Called every frame. Cheap unless something actually changed: tracking is a
  // windowed scan of a handful of segments, and a search only happens when the
  // driver has genuinely left the line (or a partial route deserves a retry).
  update(dt, x, z) {
    this._since += dt;
    if (!this.destination) return;
    if (this.route) this._track(x, z, false);
    if (this._since < REROUTE_DT) return;
    const need = !this.route || this.offRoute > OFF_ROUTE ||
      (this.partial && this._since >= this._retryIn);
    if (need) this.reroute(x, z);
  }

  // nearest point on route segments [from, to) — results land in fields, not in
  // a returned object, because this runs every frame
  _scan(x, z, from, to) {
    const r = this.route, cum = this._cum;
    for (let i = from; i < to; i++) {
      const a = r[i], b = r[i + 1];
      const d = distPointToSegment(x, z, a[0], a[1], b[0], b[1], _cp);
      if (d >= this._bd) continue;
      this._bd = d; this._bi = i; this._bs = cum[i] + _cp.t * (cum[i + 1] - cum[i]);
    }
  }

  // Where along the route are we? A window around the last answer is enough
  // for a car following the line; a full sweep is the fallback for the frame
  // after a re-route, and for a driver who teleported or short-cut across a
  // block (the windowed answer then reads as "far off route", which is exactly
  // the condition that earns a full sweep).
  _track(x, z, full) {
    const n = this.route.length;
    this._bd = Infinity; this._bi = 0; this._bs = 0;
    if (full) this._scan(x, z, 0, n - 1);
    else {
      this._scan(x, z, Math.max(0, this._i - 6), Math.min(n - 1, this._i + 80));
      if (this._bd > OFF_ROUTE) { this._bd = Infinity; this._scan(x, z, 0, n - 1); }
    }
    this._i = this._bi; this._s = this._bs; this.offRoute = this._bd;
    this.remainingM = (this._cum[n - 1] - this._bs) + this._gap;
    // Time left: the same subtraction on the time axis. _bs landed part-way
    // along piece _bi, so the seconds already spent on that piece come from the
    // same fraction of it — the two arrays are indexed identically by
    // construction, which is the whole reason for carrying spd through _emit.
    const cum = this._cum, cumT = this._cumT;
    const i = this._bi, L = cum[i + 1] - cum[i];
    const f = L > 1e-6 ? (this._bs - cum[i]) / L : 0;
    const tAt = cumT[i] + f * (cumT[i + 1] - cumT[i]);
    this.etaS = Math.max(0, cumT[n - 1] - tAt) * TIME_K + this._gapT;
    // next instruction: the cursor walks with the driver, forwards normally and
    // backwards if they reversed, so this is O(1) amortised on a 40 km route
    const J = this._joints;
    let j = this._ji;
    while (j > 0 && J[j - 1].s > this._s + TURN_PASSED) j--;
    while (j < J.length && J[j].s <= this._s + TURN_PASSED) j++;
    this._ji = j;
    if (j < J.length) {
      this._turn.dist = J[j].s - this._s;
      this._turn.dir = J[j].dir;
      this._turn.street = J[j].street;
      this.nextTurn = this._turn;
    } else this.nextTurn = null;
  }
}

// ---- module-private geometry helpers -------------------------------------

// point at forward arclength `s` on a segment, plus the index of the piece it
// landed in (the caller needs that to know which vertices to copy verbatim)
function fwdPoint(seg, s, out) {
  const cum = seg.cum, pts = seg.pts, last = pts.length - 2;
  let i = 0;
  while (i < last && cum[i + 1] < s) i++;
  const L = (cum[i + 1] - cum[i]) || 1e-6;
  const t = Math.max(0, Math.min(1, (s - cum[i]) / L));
  out.x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
  out.z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
  out.i = i;
}

// consecutive duplicates are guaranteed at every splice (the interpolated end
// of one edge IS the start of the next) and would make zero-length ribbon
// quads downstream, so they are dropped here rather than in navline
function pushPt(out, spd, x, z, v) {
  const n = out.length;
  if (n) {
    const p = out[n - 1];
    if (Math.abs(p[0] - x) < 1e-3 && Math.abs(p[1] - z) < 1e-3) return;
  }
  out.push([x, z]);
  spd.push(v);
}
