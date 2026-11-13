// ---- bus lines, derived -------------------------------------------------------
// The tiles hold 22 000 bus stops and not one route: the relations that say
// which bus calls where never left the OSM extract. So the lines are DERIVED,
// from two things the tiles do have: where the stops are, and the road graph
// the traffic already drives on.
//
//   1. every stop is snapped to the carriageway it serves, in the direction of
//      travel that puts it on the kerb side (this country drives on the right);
//   2. from each stop a bounded search along the roads finds the stops a bus
//      could plausibly call at next, preferring main roads and roads with
//      trolley wire over them;
//   3. lines are grown stop by stop, straight on rather than round the block,
//      until they are a believable length.
//
// DETERMINISM. Everything is chosen by cost, with ties broken by a stop's
// identity (a hash of its 10 cm position), never by array order, so the lines
// do not depend on the order tiles arrived in. What they DO depend on is which
// roads and stops were on the table, which is why js/buses.js only derives a
// region once every tile under it has loaded.
//
// Pure graph arithmetic: no three.js, no clock. The graph is js/traffic.js's
// directed edges, read and never written: { a, b: { out: [] }, len, twin, road,
// pts, cum, eid }.

import { hash32, rnd01 } from './crowdsites.js';

const SNAP_R = 28;            // m a stop may stand from the road it serves
const LINK_MIN = 110;         // m: two stops closer than this are one place
const LINK_MAX = 950;         // m of road between consecutive stops, at most
const LINE_STOPS_MAX = 9;
const LINE_LEN_MAX = 3000;    // m
const LINE_LEN_MIN = 900;
const LINE_STOPS_MIN = 4;
const START_BACK = 8;         // m before its first stop a trip begins
const END_ON = 6;             // …and beyond its last one it ends

const MAIN = /^(primary|secondary|tertiary)(_link)?$/;
/** How reluctant a bus is to use a metre of this road (1 = a main road). */
export function roadCost(road) {
  const t = road?.t;
  let k = MAIN.test(t) ? 1 : (t === 'residential' || t === 'unclassified') ? 1.5
    : t === 'trunk' || t === 'trunk_link' ? 1.3 : t === 'living_street' ? 3 : t === 'service' ? 3.5 : 2.2;
  if (road?.tw) k *= 0.85;    // trolley wire overhead: this is where the real ones run
  return k;
}

/** A stop's identity: its 10 cm position, hashed. */
export const stopId = (x, z) => hash32(Math.round(x * 10), Math.round(z * 10), 0x570b);

/**
 * Snap one stop to the directed edge that serves it. `edges` is the candidate
 * list (anything near). Returns { e, s, d } or null: the edge, the arc along it
 * abreast of the stop, and how far off the centreline the stop stands.
 */
export function snapStop(x, z, edges) {
  let best = null, bs = Infinity;
  for (const e of edges) {
    const t = e.road?.t;
    if (!e.pts || e.len < 8 || e.road?.br || t === 'motorway' || t === 'motorway_link') continue;
    const pts = e.pts, cum = e.cum;
    for (let i = 0; i < pts.length - 1; i++) {
      const ax = pts[i][0], az = pts[i][1], bx = pts[i + 1][0], bz = pts[i + 1][1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
      if (!(L2 > 1e-9)) continue;
      let u = ((x - ax) * ex + (z - az) * ez) / L2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = ax + ex * u, qz = az + ez * u;
      const d = Math.sqrt((x - qx) ** 2 + (z - qz) ** 2);
      if (d > SNAP_R) continue;
      // which side of THIS direction of travel is the stop on? right = (-dz, dx)
      const L = Math.sqrt(L2);
      const right = ((x - qx) * -ez + (z - qz) * ex) / L;
      // A bus serves the stop on its right. A one-way street has one direction
      // to offer; a stop standing on the centreline (a stop_position node)
      // serves whichever direction its own hash picks.
      let ok;
      if (e.oneway || !e.twin) ok = true;
      else if (Math.abs(right) <= 0.4) ok = ((stopId(x, z) & 1) === 0) === (e.offSign > 0);
      else ok = right > 0.4;
      if (!ok) continue;
      // nearest wins, but a main road beats a service lane a little further off
      const score = d + (t === 'service' ? 14 : t === 'living_street' ? 8 : 0);
      if (score < bs - 1e-9 || (Math.abs(score - bs) <= 1e-9 && best && e.eid < best.e.eid)) {
        bs = score;
        best = { e, s: cum[i] + u * (cum[i + 1] - cum[i]), d };
      }
    }
  }
  return best;
}

// a tiny binary heap of [cost, seq, edge, metres]: seq keeps equal costs in
// insertion order, which is itself deterministic (out-lists are sorted below)
function heapPush(h, it) {
  let i = h.length;
  h.push(it);
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (h[p][0] < it[0] || (h[p][0] === it[0] && h[p][1] <= it[1])) break;
    h[i] = h[p]; i = p;
  }
  h[i] = it;
}
function heapPop(h) {
  const top = h[0], last = h.pop();
  if (h.length) {
    let i = 0;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= h.length) break;
      if (c + 1 < h.length && (h[c + 1][0] < h[c][0] || (h[c + 1][0] === h[c][0] && h[c + 1][1] < h[c][1]))) c++;
      if (last[0] < h[c][0] || (last[0] === h[c][0] && last[1] <= h[c][1])) break;
      h[i] = h[c]; i = c;
    }
    h[i] = last;
  }
  return top;
}
const cmpEid = (a, b) => (a.eid - b.eid) || (a.len - b.len);

/**
 * The stops a bus leaving `S` could call at next: [{ to, cost, m, path }],
 * nearest first. `onEdge` maps an edge to the stops snapped onto it; `inBox`
 * says whether an edge may be driven at all.
 */
export function linksFrom(S, onEdge, inBox) {
  const out = [], seen = new Map(), heap = [];
  let seq = 0;
  const k0 = roadCost(S.e.road);
  for (const T of onEdge.get(S.e) ?? []) {
    const m = T.s - S.s;
    if (T !== S && m >= LINK_MIN && m <= LINK_MAX) out.push({ to: T, cost: m * k0, m, path: [S.e] });
  }
  seen.set(S.e, null);
  const push = (e, from, cost, m) => {
    for (const o of e.b.out.slice().sort(cmpEid)) {
      if (o === e.twin || seen.has(o) || !inBox(o)) continue;
      heapPush(heap, [cost, seq++, o, m, from]);
    }
  };
  push(S.e, S.e, (S.e.len - S.s) * k0, S.e.len - S.s);
  while (heap.length) {
    const [cost, , e, m, from] = heapPop(heap);
    if (seen.has(e)) continue;
    seen.set(e, from);
    const k = roadCost(e.road);
    for (const T of onEdge.get(e) ?? []) {
      const mm = m + T.s;
      if (T === S || mm < LINK_MIN || mm > LINK_MAX) continue;
      const path = [e];
      for (let p = from; p; p = seen.get(p)) path.push(p);
      out.push({ to: T, cost: cost + T.s * k, m: mm, path: path.reverse() });
    }
    if (m + e.len > LINK_MAX) continue;
    push(e, e, cost + e.len * k, m + e.len);
  }
  out.sort((a, b) => (a.cost - b.cost) || (a.to.id - b.to.id));
  return out.slice(0, 5);
}

/**
 * Derive the lines of one region.
 *   stops   [{ x, z, n? }] every stop inside the region's halo box
 *   near    (x, z) => iterable of edges near that point (for snapping)
 *   inBox   (edge) => may a line drive it (inside the halo box)
 *   isSeed  (stop) => does a line START here (inside the region proper)
 * Returns [{ id, stops: [{ x, z, id, n, arc }], route: [{ e, base, turnIn,
 * turnOut }], len }] with `route` in the shape js/traffic.js drives.
 */
export function deriveLines({ stops, near, inBox, isSeed }) {
  // ---- 1. snap ----
  const S = [];
  for (const st of stops) {
    const hit = snapStop(st.x, st.z, near(st.x, st.z));
    if (!hit || !inBox(hit.e)) continue;
    S.push({ x: st.x, z: st.z, n: st.n ?? '', id: stopId(st.x, st.z), e: hit.e, s: hit.s, used: 0, links: null, into: 0 });
  }
  S.sort((a, b) => (a.id - b.id) || (a.x - b.x) || (a.z - b.z));
  // two nodes for one stop (a pole and a shelter, mapped separately): keep one
  const onEdge = new Map();
  for (const st of S) {
    const l = onEdge.get(st.e) ?? [];
    if (l.some((o) => Math.abs(o.s - st.s) < 14)) { st.dup = true; continue; }
    l.push(st); onEdge.set(st.e, l);
  }
  const live = S.filter((st) => !st.dup);
  for (const l of onEdge.values()) l.sort((a, b) => a.s - b.s);

  // ---- 2. who can follow whom ----
  for (const st of live) st.links = linksFrom(st, onEdge, inBox);
  for (const st of live) for (const l of st.links) l.to.into++;

  // ---- 3. grow ----
  const seeds = live.filter(isSeed).sort((a, b) => (a.into - b.into) || (a.id - b.id));
  const lines = [];
  for (const seed of seeds) {
    if (seed.used) continue;
    const chain = [seed], hops = [];
    let total = 0, hx = 0, hz = 0;
    while (chain.length < LINE_STOPS_MAX && total < LINE_LEN_MAX) {
      const cur = chain[chain.length - 1];
      let best = null, bs = Infinity;
      for (const l of cur.links) {
        const T = l.to;
        // one line per kerb: the station forecourt alone would otherwise seed a
        // dozen lines down the same three streets (measured: 18 buses in sight)
        if (chain.includes(T) || T.used) continue;
        // the next stop is the next PLACE: not the other platform of this one
        // (a station forecourt has six poles with one name between them)
        if (T.n && T.n === cur.n) continue;
        // straight on rather than round the block: penalise turning away from
        // the bearing of the hop before
        const dx = T.x - cur.x, dz = T.z - cur.z, dl = Math.sqrt(dx * dx + dz * dz) || 1;
        const turn = hops.length ? 1 - (dx * hx + dz * hz) / dl : 0;      // 0 ahead .. 2 back
        const score = l.cost * (1 + 0.9 * turn);
        if (turn > 1.5) continue;                                         // no doubling back
        if (score < bs - 1e-9 || (Math.abs(score - bs) <= 1e-9 && best && T.id < best.to.id)) { bs = score; best = l; }
      }
      if (!best) break;
      const dx = best.to.x - cur.x, dz = best.to.z - cur.z, dl = Math.sqrt(dx * dx + dz * dz) || 1;
      hx = dx / dl; hz = dz / dl;
      hops.push(best); chain.push(best.to); total += best.m;
    }
    if (chain.length < LINE_STOPS_MIN || total < LINE_LEN_MIN) continue;
    for (const st of chain) st.used++;
    lines.push(buildLine(chain, hops));
  }
  return lines;
}

// ---- two lines over the same kerbs ----------------------------------------------
// deriveLines keeps to one line per kerb, but only among the lines of ONE call,
// and js/buses.js calls it once per region with boxes that overlap. Two
// neighbouring regions each grew a line down the same street through the same
// stops; the two timetables waited at the same lights and stood at the same
// stops, fell into step, and two buses drove inside one another for a minute
// at a time. So lines are compared ACROSS calls by their hops (a hop is one
// stop followed by the next), and of two lines that share SHARE_MIN hops or
// more the one that `outranks` the other runs. One shared hop is two routes
// that cross or share a street for a block, which is what real lines do.
export const SHARE_MIN = 2;
export const hopKey = (a, b) => a.id + '>' + b.id;
/**
 * Does line `a` keep the kerbs it shares with line `b`? A total order made of
 * what the lines ARE (identity, then the region that grew them: buses.js sets
 * rx and rz), never of which was derived first, so every client retires the
 * same one of the two whatever order its regions came in.
 */
export function outranks(a, b) {
  const ia = a.id >>> 0, ib = b.id >>> 0;
  if (ia !== ib) return ia < ib;
  if (a.rx !== b.rx) return a.rx < b.rx;
  return a.rz < b.rz;
}

// Stitch a chain of stops and the hops between them into one drivable route.
function buildLine(chain, hops) {
  const edges = [chain[0].e];
  const at = [0];                              // index into `edges` each stop stands on
  for (const h of hops) {
    for (let i = 1; i < h.path.length; i++) edges.push(h.path[i]);
    at.push(edges.length - 1);
  }
  const startS = Math.max(0, chain[0].s - START_BACK);
  const route = [];
  let base = -startS;
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    let turnIn = 0;
    if (i) {
      const p = edges[i - 1];
      const dot = p.ldx * e.fdx + p.ldz * e.fdz, crs = p.ldx * e.fdz - p.ldz * e.fdx;
      turnIn = Math.abs(Math.atan2(crs, dot));
      route[i - 1].turnOut = turnIn;
    }
    route.push({ e, base, turnIn, turnOut: 0 });
    base += e.len;
  }
  const stops = chain.map((st, j) => ({ x: st.x, z: st.z, id: st.id, n: st.n, arc: route[at[j]].base + st.s }));
  // arcs must strictly increase or the schedule cannot stop at them in order
  for (let j = 1; j < stops.length; j++) if (stops[j].arc < stops[j - 1].arc + 20) stops[j].arc = stops[j - 1].arc + 20;
  const len = Math.min(base, stops[stops.length - 1].arc + END_ON);
  const id = hash32(chain[0].id, chain[chain.length - 1].id, chain.length, 0xb15);
  return { id, stops, route, len, startS, phase: rnd01(hash32(id, 0x7a)), trolley: trolleyShare(edges) > 0.6 };
}

function trolleyShare(edges) {
  let a = 0, b = 0;
  for (const e of edges) { b += e.len; if (e.road?.tw) a += e.len; }
  return b ? a / b : 0;
}
