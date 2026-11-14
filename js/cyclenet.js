// ---- cyclenet.js: where a bicycle can go ------------------------------------
// Pardubice is the cycling town of the country and its map shows it: 64 km of
// highway=cycleway in the four tiles round the centre. This module turns the
// road layer into the graph a rider follows, and draws a route through it.
//
// THREE CLASSES OF WAY, because the cycle network is not one piece. Measured
// on those four tiles: the cycleways alone fall into 136 islands (the largest
// 7 km); let a rider use quiet streets between them and 45 km of the 67 hang
// together; let them push on over a footway where nothing else continues and
// it is 63 km.
//
//   CYCLE   highway=cycleway, and paths with a sealed surface (the shared
//           paths: the tiles do not keep bicycle=designated). Where a rider
//           wants to be, and the only class a trip STARTS on.
//   STREET  residential, living street, unclassified, tertiary and service
//           ways: ridden at the kerb edge when that is where the network
//           continues.
//   FOOT    footways and unsurfaced-tag paths: a last resort between two
//           pieces of the above, ridden slowly.
//
// Main roads (secondary and up), tracks, steps and dirt paths are not ridden.
//
// THE GRAPH. Every vertex of every usable way is filed under its coordinate
// rounded to 10 cm, exactly as js/traffic.js welds its nodes: OSM repeats the
// coordinate where two ways meet, and a way cut at a tile border meets its
// other half the same way. A vertex shared by two ways is a place a rider can
// turn. Nothing is hung on the road features (js/chunkspec.js copies them to
// the mesh workers): what this module knows about a way lives in a WeakMap.
//
// A ROUTE IS A PURE FUNCTION OF (seed, start), which is what makes the same
// cyclist take the same turns on every co-op screen: the ways onward from a
// junction are put in an order that depends only on their geometry before a
// hash picks one. Like the crowd's beats and the traffic's trips, a route
// built while the next tile was still on its way ends at the tile border; the
// generation rolls that out.
//
// Pure data and arithmetic: no three.js, no clock, no Math.random.

import { hash32, rnd01 } from './crowdsites.js';
import { parkable, kerbSideOf, secondKerbOf } from './kerbparking.js';

export const CLS = { NONE: 0, FOOT: 1, STREET: 2, CYCLE: 3 };

const SEALED = new Set(['asphalt', 'paving', 'concrete']);
const STREETS = new Set(['residential', 'living_street', 'unclassified', 'tertiary', 'tertiary_link', 'service']);
const UNSEALED = new Set(['dirt', 'grass', 'gravel', 'ground', 'sand', 'mud', 'cobble']);

/** Which of the three classes a road feature is, or CLS.NONE. */
export function classOf(r) {
  if (!r || !r.p || r.p.length < 2) return CLS.NONE;
  const t = r.t;
  if (t === 'cycleway') return CLS.CYCLE;
  if (t === 'path') return SEALED.has(r.s) ? CLS.CYCLE : (r.s && UNSEALED.has(r.s)) ? CLS.NONE : CLS.FOOT;
  if (r.d === 1) return STREETS.has(t) ? CLS.STREET : CLS.NONE;
  if (t === 'footway' || t === 'pedestrian') return CLS.FOOT;
  return CLS.NONE;
}

// How much a rider at a junction likes each kind of way onward.
const LIKE_STREET = { residential: 1, living_street: 1.3, unclassified: 0.9, tertiary: 0.7, tertiary_link: 0.5, service: 0.3 };
const LIKE_CYCLE = 7, LIKE_FOOT = 0.25;
const RECENT = 8;                 // ways back a rider remembers having been down
const FAR = 180;                  // m a way has to lead onward to be worth turning into
const HOP = 220;                  // m of footway a rider will take to get from one real way to the next
const NK = 1200001, NO = 600000;  // node key: two 10 cm integers packed into one double

const q10 = (v) => Math.round(v * 10);
const q4 = (v) => Math.round(v * 4);
const nodeKey = (x, z) => (q10(x) + NO) * NK + (q10(z) + NO);
const dist = (x, z) => Math.sqrt(x * x + z * z);

// Canonical order for anything a hash picks from: geometry only.
function cmpOpt(a, b) { return (a.w.wid - b.w.wid) || (a.i - b.i) || (a.d - b.d); }

export class CycleNet {
  constructor() {
    this.ways = new WeakMap();      // road feature -> { r, cls, wid, cum, len, n, mx, mz }
    this.nodes = new Map();         // nodeKey -> [way, vertexIndex, way, vertexIndex, ...]
    this.count = 0;                 // ways taken in
    this.rev = 0;                   // bumped when the graph grows
    this._seen = new Set();         // feature _id already taken in
    this._opts = [];                // scratch for _choose
  }

  /** Take in a batch of road features (a tile's). Returns the CYCLE ways among them. */
  add(roads) {
    const fresh = [];
    for (const r of roads ?? []) {
      const cls = classOf(r);
      if (!cls) continue;
      if (r._id != null) { if (this._seen.has(r._id)) continue; this._seen.add(r._id); }
      else if (this.ways.has(r)) continue;
      const p = r.p, n = p.length;
      // Float64, so that two clients who summed the same way hold the same bits
      const cum = new Float64Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + dist(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      const len = cum[n - 1];
      if (!(len > 0.5)) continue;
      let k = 1;
      while (k < n - 1 && cum[k] < len / 2) k++;
      const f = (len / 2 - cum[k - 1]) / ((cum[k] - cum[k - 1]) || 1);
      const mx = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * f, mz = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * f;
      const w = {
        r, cls, cum, len, n, mx, mz, memo: null, memoRev: -1,
        wid: hash32(q4(p[0][0]), q4(p[0][1]), q4(p[n - 1][0]), q4(p[n - 1][1]), q4(mx), q4(mz)),
        // a street people park along has cars at one kerb: the direction whose
        // right-hand kerb that is has no kerb edge to ride (js/kerbparking.js;
        // side -1 is the right-hand kerb of the way's own direction)
        park: cls === CLS.STREET && parkable(r) ? kerbSideOf(r) : 0,
        // (a street the map parks on both sides has a second such kerb)
        park2: cls === CLS.STREET ? secondKerbOf(r) : 0,
      };
      this.ways.set(r, w);
      for (let i = 0; i < n; i++) {
        const key = nodeKey(p[i][0], p[i][1]);
        const a = this.nodes.get(key);
        if (a) a.push(w, i); else this.nodes.set(key, [w, i]);
      }
      this.count++;
      if (cls === CLS.CYCLE) fresh.push(w);
    }
    if (fresh.length || roads?.length) this.rev++;
    return fresh;
  }

  /** Let a batch of road features go again (a tile geo.js released). Returns
   *  the way records that left, so the caller can drop them from its cells. */
  remove(roads) {
    const out = [];
    for (const r of roads ?? []) {
      const w = this.ways.get(r);
      if (!w) continue;
      this.ways.delete(r);
      if (r._id != null) this._seen.delete(r._id);
      const p = r.p;
      for (let i = 0; i < w.n; i++) {
        const key = nodeKey(p[i][0], p[i][1]);
        const a = this.nodes.get(key);
        if (!a) continue;
        let k = 0;
        for (let j = 0; j < a.length; j += 2) if (a[j] !== w) { a[k++] = a[j]; a[k++] = a[j + 1]; }
        a.length = k;
        if (!k) this.nodes.delete(key);
      }
      this.count--;
      out.push(w);
    }
    if (out.length) this.rev++;
    return out;
  }

  /** May a rider travel along way `w` in direction d (+1 with its vertices, -1 against)? */
  rideable(w, d) {
    if (w.r.ow && d < 0) return false;            // one-way, for bicycles too
    if (w.park && w.park === -d) return false;    // parked cars at that kerb
    if (w.park2 && w.park2 === -d) return false;
    return true;
  }

  // Is vertex i of way w a place where another way meets it?
  _isNode(w, i) {
    const p = w.r.p[i];
    const a = this.nodes.get(nodeKey(p[0], p[1]));
    if (!a) return false;
    for (let k = 0; k < a.length; k += 2) if (a[k] !== w) return true;
    return false;
  }

  // The next vertex of w from i heading d where another way meets it, or the
  // end of the way. -1 if i is already that end.
  _nextNode(w, i, d) {
    let j = i + d;
    if (j < 0 || j >= w.n) return -1;
    while (j > 0 && j < w.n - 1 && !this._isNode(w, j)) j += d;
    return j;
  }

  // DOES THIS WAY LEAD ANYWHERE? Measured on the first build, which only asked
  // whether the next junction existed: 1.8 turn-rounds a ride, four in five of
  // them at the end of a footpath or a stub of cycle path, and one ride in ten
  // spent a kilometre lost among the footways of a housing estate. So before a
  // rider takes a way, the map is searched a little further:
  //   a CYCLE way or a STREET leads if FAR metres can be ridden onward from
  //   it over ways of those two classes without turning round;
  //   a FOOT way leads only as a BRIDGE: if it reaches a way of the other two
  //   classes within HOP metres of footway.
  // A bounded depth-first search, remembered per (way, vertex, direction)
  // until the graph next grows.
  leads(w, i, d) {
    if (w.memoRev !== this.rev) { w.memoRev = this.rev; w.memo = null; }
    const key = i * 2 + (d > 0 ? 1 : 0);
    const m = (w.memo ??= new Map());
    let v = m.get(key);
    if (v === undefined) {
      v = w.cls === CLS.FOOT ? this._bridge(w, i, d, HOP, 6) : this._far(w, i, d, FAR, 7);
      m.set(key, v);
    }
    return v;
  }

  _far(w, i, d, need, depth) {
    const j = this._nextNode(w, i, d);
    if (j < 0) return false;
    need -= Math.abs(w.cum[j] - w.cum[i]);
    if (need <= 0) return true;
    if (depth <= 0) return true;                 // six junctions on and still going: call it a way through
    if (j + d >= 0 && j + d < w.n && this._far(w, j, d, need, depth - 1)) return true;
    const q = w.r.p[j], a = this.nodes.get(nodeKey(q[0], q[1]));
    if (a) for (let k = 0; k < a.length; k += 2) {
      const w2 = a[k], i2 = a[k + 1];
      if (w2 === w || w2.cls === CLS.FOOT) continue;
      if (this.rideable(w2, 1) && this._far(w2, i2, 1, need, depth - 1)) return true;
      if (this.rideable(w2, -1) && this._far(w2, i2, -1, need, depth - 1)) return true;
    }
    return false;
  }

  _bridge(w, i, d, left, depth) {
    const j = this._nextNode(w, i, d);
    if (j < 0) return false;
    left -= Math.abs(w.cum[j] - w.cum[i]);
    if (left < 0) return false;
    const q = w.r.p[j], a = this.nodes.get(nodeKey(q[0], q[1]));
    if (a) for (let k = 0; k < a.length; k += 2) {
      const w2 = a[k];
      if (w2 !== w && w2.cls !== CLS.FOOT && (this.leads(w2, a[k + 1], 1) || this.leads(w2, a[k + 1], -1))) return true;
    }
    if (depth <= 0) return false;
    if (j + d >= 0 && j + d < w.n && this._bridge(w, j, d, left, depth - 1)) return true;
    if (a) for (let k = 0; k < a.length; k += 2) {
      const w2 = a[k], i2 = a[k + 1];
      if (w2 === w || w2.cls !== CLS.FOOT) continue;
      if (this._bridge(w2, i2, 1, left, depth - 1) || this._bridge(w2, i2, -1, left, depth - 1)) return true;
    }
    return false;
  }

  // The ways onward from vertex j of way w, reached heading d. Picks one by
  // hash `h`; `recent` is the ring of ways already ridden. Returns the pick in
  // `out` ({ w, i, d }) or null at a dead end.
  _choose(w, j, d, h, recent, out) {
    const opts = this._opts;
    opts.length = 0;
    const p = w.r.p, q = p[j], pv = p[j - d];
    let inx = q[0] - pv[0], inz = q[1] - pv[1];
    const il = dist(inx, inz) || 1;
    inx /= il; inz /= il;
    const consider = (w2, i2, d2) => {
      const k2 = i2 + d2;
      if (k2 < 0 || k2 >= w2.n || !this.rideable(w2, d2)) return;
      const p2 = w2.r.p;
      let ox = p2[k2][0] - p2[i2][0], oz = p2[k2][1] - p2[i2][1];
      const ol = dist(ox, oz) || 1;
      ox /= ol; oz /= ol;
      const cos = inx * ox + inz * oz;
      let like = w2.cls === CLS.CYCLE ? LIKE_CYCLE : w2.cls === CLS.FOOT ? LIKE_FOOT : (LIKE_STREET[w2.r.t] ?? 0.5);
      // straight on is what a rider does unless there is a reason not to
      like *= cos > 0.5 ? 2.2 : cos > -0.2 ? 1 : cos > -0.8 ? 0.35 : 0.05;
      // (not the way they are on: carrying on down it is not going back)
      if (w2 !== w) for (let k = 0; k < recent.length; k++) if (recent[k] === w2) { like *= 0.12; break; }
      opts.push({ w: w2, i: i2, d: d2, like, leads: this.leads(w2, i2, d2) });
    };
    consider(w, j, d);
    const a = this.nodes.get(nodeKey(q[0], q[1]));
    if (a) for (let k = 0; k < a.length; k += 2) {
      if (a[k] === w) continue;
      consider(a[k], a[k + 1], 1);
      consider(a[k], a[k + 1], -1);
    }
    if (!opts.length) return null;
    // Somewhere to go beats a dead end, and a real way beats a footway. A
    // footway that is not a bridge to anything is not taken at all: the ride
    // turns round or ends there (see route()).
    let any = false, real = false, stub = false;
    for (const o of opts) {
      if (o.leads) { any = true; if (o.w.cls !== CLS.FOOT) real = true; }
      else if (o.w.cls !== CLS.FOOT) stub = true;
    }
    let total = 0;
    for (const o of opts) {
      if (any ? (!o.leads || (real && o.w.cls === CLS.FOOT)) : (!stub || o.w.cls === CLS.FOOT)) o.like = 0;
      total += o.like;
    }
    if (!(total > 0)) return null;
    opts.sort(cmpOpt);
    let t = rnd01(h) * total, pick = null;
    for (const o of opts) { if (o.like <= 0) continue; pick = o; t -= o.like; if (t < 0) break; }
    out.w = pick.w; out.i = pick.i; out.d = pick.d;
    return out;
  }

  /**
   * A route `want` metres long from vertex i of way w heading d: a list of
   * legs { w, i0, i1 } (vertex i0 to vertex i1 of one way, either direction),
   * each ending where another way meets it. Shorter if the map runs out.
   */
  route(seed, w, i, d, want) {
    const legs = [], recent = [], pick = { w: null, i: 0, d: 0 };
    let acc = 0, turns = 0;
    for (let step = 0; step < 400 && acc < want; step++) {
      const j = this._nextNode(w, i, d);
      if (j < 0) break;
      legs.push({ w, i0: i, i1: j });
      acc += Math.abs(w.cum[j] - w.cum[i]);
      if (recent[recent.length - 1] !== w) { recent.push(w); if (recent.length > RECENT) recent.shift(); }
      if (acc >= want) break;
      if (this._choose(w, j, d, hash32(seed, step, 0xb1c), recent, pick)) {
        w = pick.w; i = pick.i; d = pick.d;
        continue;
      }
      // A dead end: back the way they came, ONCE in a ride (the end of a cycle
      // path that the map carries on as something else). A second one is a
      // rider going back and forth, and the ride simply ends there instead.
      if (turns++ || w.cls === CLS.FOOT || !this.rideable(w, -d)) break;
      i = j; d = -d;
    }
    return legs;
  }
}
