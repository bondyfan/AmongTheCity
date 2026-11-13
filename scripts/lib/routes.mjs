// ---- OSM route relations -> the game's route files ---------------------------
// Input: data/raw-region/_routes.json (scripts/lib/route-collect.mjs): every
// bus, trolleybus and tram relation of the world with its member ways and stop
// nodes, WGS84, unordered beyond what the mapper did. Output: one small file
// per OWNER tile, public/data/routes/<tx>_<tz>.json, and for every tile the
// list of files holding a route that passes through it (the manifest's `rt`).
// docs/TILE-FORMAT.md describes the file; js/tiledata.js decodes it.
//
// WHAT A ROUTE IS MADE OF
//   legs    One per OSM way a route of this file runs along, shared by every
//           route that uses it. A leg carries the way's points exactly as the
//           road layer stores them (same 10 cm rounding, same 0.5 m
//           Douglas-Peucker, done by the very functions build-region.mjs uses
//           for `roads`), so the points of a leg ARE the points of one road
//           feature and a consumer can find the road by coordinates.
//   stops   One per place a vehicle calls at: the stop position on the
//           carriageway and the platform beside it folded into one entry.
//   routes  Tags, the calls in order (indices into stops) and the path in
//           order (signed indices into legs, 0 where there is a gap).
//
// ORDER. PTv2 says the member ways run from the first stop to the last, but
// not which way round each one is drawn. Each way is turned to continue from
// where the previous one ended; a roundabout (a closed way) is entered and left
// at the vertices its neighbours touch and only that arc is kept; a way that
// does not connect at all starts a new piece behind a gap marker. Nothing is
// ever reordered: a route mapped out of order comes out as many pieces, which
// the gap count `g` reports honestly, instead of as a guess.
//
// OWNERSHIP. A route belongs to the tile of its first stop that stands inside
// the world. That is a pure function of the relation, so it does not depend on
// which extract was read first or which tiles are being rebuilt.

import { WAY_TUNNEL, WAY_BRIDGE, WAY_PLATFORM, WAY_AREA } from './route-collect.mjs';

const MODES = ['bus', 'trolleybus', 'tram'];
const LEG_TUNNEL = 1, LEG_BRIDGE = 2, LEG_RAIL = 4, LEG_OFF = 8;

const PAIR_NEAR = 60;     // m: a stop position and a platform this close are one call
const PAIR_FAR = 150;     // m: ...and beyond this never, whatever they are called
const SNAP_MAX = 60;      // m a call may stand from the path and still be given an arc
const WRONG_SIDE = 25;    // m of penalty for a platform on the left of the direction of travel

const CSS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', brown: '#a52a2a', grey: '#808080',
  gray: '#808080', pink: '#ffc0cb', cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00',
  navy: '#000080', maroon: '#800000', olive: '#808000', teal: '#008080', silver: '#c0c0c0',
};
/** A transit colour tag as '#rrggbb', or null. */
export function lineColour(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1];
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  return CSS[s] ?? null;
}

const key = (p) => p[0] + ',' + p[1];

/**
 * @param raw  the parsed _routes.json
 * @param env  { px, pz, simplify, TILE, tileWanted, roadClass(highwayValue) }
 *             px/pz/simplify are build-region.mjs's own, so a leg and a road
 *             made from the same way are the same numbers. roadClass says
 *             whether the road layer keeps a highway of that value.
 */
export function buildRoutes(raw, env) {
  const { px, pz, simplify, TILE, tileWanted, roadClass } = env;
  const proj = (g) => g.map(([lat, lon]) => [px(lon), pz(lat)]);
  const tileOf = (x, z) => [Math.floor(x / TILE), Math.floor(z / TILE)];

  // which master a route hangs under (the first by id, should two claim it)
  const masterOf = new Map();
  for (const m of raw.masters) for (const r of m.members) if (!masterOf.has(r)) masterOf.set(r, m);

  const wayPts = new Map();   // way id -> projected, unsimplified points
  const ptsOf = (id) => {
    let p = wayPts.get(id);
    if (p === undefined) { const w = raw.ways[id]; wayPts.set(id, p = w ? proj(w.g) : null); }
    return p;
  };

  const files = new Map();    // 'tx_tz' -> file under construction
  const tileIndex = new Map();// 'tx_tz' of a tile -> Set of file keys
  const stats = { routes: 0, kept: 0, noStops: 0, outside: 0, gaps: 0, legs: 0, stops: 0,
    byMode: [0, 0, 0], unsnapped: 0 };

  const fileOf = (tx, tz) => {
    const k = tx + '_' + tz;
    let f = files.get(k);
    if (!f) files.set(k, f = { v: 1, tx, tz, stops: [], legs: [], routes: [], _stopIx: new Map(), _legIx: new Map() });
    return f;
  };

  for (const rel of raw.routes) {
    stats.routes++;
    const t = rel.tags;
    const mode = MODES.indexOf(t.route);
    if (mode < 0) continue;

    // ---- the calls ---------------------------------------------------------
    // Each stop-like member becomes a candidate: S a stop position on the
    // carriageway, P a platform or a pole beside it.
    const cands = [];
    for (const [type, ref, role] of rel.members) {
      if (/^backward/.test(role)) continue;        // the other direction of a legacy two-way relation
      let kind = /stop/.test(role) ? 'S' : /platform/.test(role) ? 'P' : null;
      let pos = null, name = '';
      if (type === 'n') {
        const n = raw.nodes[ref];
        if (!n) { if (kind) cands.push(null); continue; }   // a call outside the world: keep the order honest
        const nt = n.t ?? {};
        if (!kind) {
          // a legacy relation lists its stops with no role at all: the node's
          // own tags say what it is, and a node with none is just road
          if (role !== '' && role !== 'forward') continue;
          kind = nt.public_transport === 'stop_position' || nt.railway === 'tram_stop' ? 'S'
            : nt.highway === 'bus_stop' || nt.public_transport === 'platform' ? 'P' : null;
          if (!kind) continue;
        }
        pos = [px(n.p[1]), pz(n.p[0])];
        name = nt.name ?? '';
      } else if (type === 'w') {
        if (!kind) continue;                        // an unroled way is road, handled below
        const w = raw.ways[ref];
        if (!w) { cands.push(null); continue; }
        const p = ptsOf(ref);
        let sx = 0, sz = 0;
        const n = p.length > 1 && key(p[0]) === key(p[p.length - 1]) ? p.length - 1 : p.length;
        for (let i = 0; i < n; i++) { sx += p[i][0]; sz += p[i][1]; }
        pos = [+(sx / n).toFixed(1), +(sz / n).toFixed(1)];
        name = w.n ?? '';
      } else continue;
      let f = 0;
      if (/entry_only/.test(role)) f |= 1;
      if (/exit_only/.test(role)) f |= 2;
      if (/on_demand/.test(role)) f |= 4;
      cands.push({ kind, pos, name, f, ref: type + ref });
    }
    // fold a stop position and its platform into one call
    const calls = [];
    let missing = 0;
    for (const c of cands) {
      if (!c) { missing++; continue; }
      const last = calls[calls.length - 1];
      if (last && !last[c.kind]) {
        const o = last.S ?? last.P;
        const d = Math.hypot(o.pos[0] - c.pos[0], o.pos[1] - c.pos[1]);
        const same = o.name && c.name && o.name === c.name;
        if (d <= PAIR_FAR && (same || d <= PAIR_NEAR)) { last[c.kind] = c; continue; }
      }
      calls.push({ [c.kind]: c });
    }
    if (calls.length < 2) { stats.noStops++; continue; }
    const primary = (c) => (c.S ?? c.P).pos;
    const first = calls.find((c) => { const [tx, tz] = tileOf(...primary(c)); return tileWanted(tx, tz); });
    let inWorld = 0;
    for (const c of calls) { const [tx, tz] = tileOf(...primary(c)); if (tileWanted(tx, tz)) inWorld++; }
    if (!first || inWorld < 2) { stats.outside++; continue; }

    const file = fileOf(...tileOf(...primary(first)));

    // ---- the path ----------------------------------------------------------
    const ways = [];
    let lost = 0;
    for (const [type, ref, role] of rel.members) {
      if (type !== 'w' || /stop|platform|backward/.test(role)) continue;
      const w = raw.ways[ref];
      if (w && (w.f & WAY_PLATFORM)) continue;      // a platform listed without its role
      ways.push(w ? { ref, w, p: ptsOf(ref) } : null);
      if (!w) lost++;
    }
    const legRef = (id, w, pts, part) => {
      const k = part ? id + ':' + part : String(id);
      let ix = file._legIx.get(k);
      if (ix === undefined) {
        const s = simplify(pts, 0.5);
        const cls = w.c;
        let f = 0;
        if (w.f & WAY_TUNNEL) f |= LEG_TUNNEL;
        if (w.f & WAY_BRIDGE) f |= LEG_BRIDGE;
        if (cls.startsWith('r:')) f |= LEG_RAIL;
        // the road layer drops tunnels and areas and knows only its own classes
        if (!cls.startsWith('h:') || !roadClass(cls.slice(2)) || (w.f & (WAY_TUNNEL | WAY_AREA))) f |= LEG_OFF;
        const leg = [f];
        let lx = 0, lz = 0;
        for (const [x, z] of s) {
          const ix10 = Math.round(x * 10), iz10 = Math.round(z * 10);
          leg.push(ix10 - lx, iz10 - lz);
          lx = ix10; lz = iz10;
        }
        ix = file.legs.length;
        file.legs.push(leg);
        file._legIx.set(k, ix);
        file._legPts ??= [];
        file._legPts[ix] = s;
      }
      return ix;
    };

    const path = [];            // signed leg refs, 0 = gap
    const line = [];            // the decoded polyline, [x, z] points
    const cuts = [];
    let cur = null, gaps = 0, pendingGap = false;
    const emit = (ix, reversed) => {
      const s = file._legPts[ix];
      if (pendingGap && path.length) { path.push(0); gaps++; cuts.push(line.length); }
      pendingGap = false;
      path.push(reversed ? -(ix + 1) : ix + 1);
      const n = s.length;
      for (let i = 0; i < n; i++) {
        const q = s[reversed ? n - 1 - i : i];
        if (i === 0 && line.length && !cuts.includes(line.length) && key(line[line.length - 1]) === key(q)) continue;
        line.push(q);
      }
      cur = key(line[line.length - 1]);
    };
    for (let i = 0; i < ways.length; i++) {
      const it = ways[i];
      if (!it) { cur = null; pendingGap = true; continue; }
      const P = it.p, n = P.length;
      const isClosed = n > 2 && key(P[0]) === key(P[n - 1]);
      const nx = ways[i + 1] ?? null;
      const nA = nx ? key(nx.p[0]) : null, nB = nx ? key(nx.p[nx.p.length - 1]) : null;
      const nxClosed = nx && nx.p.length > 2 && nA === nB;
      // where the route enters this way, and where the next way takes over
      const find = (k, skip = -1) => {
        if (k === null) return -1;
        if (!isClosed) { if (skip !== 0 && key(P[0]) === k) return 0; if (skip !== n - 1 && key(P[n - 1]) === k) return n - 1; }
        for (let j = 0; j < n - (isClosed ? 1 : 0); j++) if (j !== skip && key(P[j]) === k) return j;
        return -1;
      };
      let e = find(cur);
      let x = -1;
      if (nx) {
        if (nxClosed) {       // the next way is a ring: it takes over wherever the two touch
          const ring = new Set(nx.p.map(key));
          const order = e === 0 ? [n - 1, 0] : [0, n - 1];
          for (const j of isClosed ? [] : order) if (j !== e && ring.has(key(P[j]))) { x = j; break; }
          if (x < 0) for (let j = 0; j < n; j++) if (j !== e && ring.has(key(P[j]))) { x = j; break; }
        } else {
          x = find(nA, e);
          const xb = find(nB, e);
          // an endpoint of this way beats an interior vertex of it
          if (x < 0 || (xb >= 0 && !isClosed && (xb === 0 || xb === n - 1) && !(x === 0 || x === n - 1))) x = xb >= 0 ? xb : x;
        }
      }
      if (e < 0 && cur !== null) { cur = null; pendingGap = true; }   // does not connect: a gap
      if (isClosed) {
        // a ring is driven in the direction it is drawn (a roundabout is one-way)
        const m = n - 1;
        if (e < 0) e = x >= 0 ? x : 0;
        const stop = x >= 0 && x !== e ? x : e;
        const arc = [P[e]];
        for (let j = (e + 1) % m; ; j = (j + 1) % m) { arc.push(P[j]); if (j === stop) break; }
        if (e === 0 && stop === 0) emit(legRef(it.ref, it.w, P, ''), false);
        else emit(legRef(it.ref, it.w, arc, e + '>' + stop), false);
        continue;
      }
      const ends = (j) => j === 0 || j === n - 1;
      if (e < 0) {
        // nothing behind to continue from: face the way the next one is waiting
        if (x === 0) emit(legRef(it.ref, it.w, P, ''), true);
        else if (x > 0 && x < n - 1) emit(legRef(it.ref, it.w, P.slice(0, x + 1), '0>' + x), false);
        else emit(legRef(it.ref, it.w, P, ''), false);
      } else if (ends(e) && (x < 0 || ends(x))) {
        emit(legRef(it.ref, it.w, P, ''), e !== 0);                    // the ordinary case: the whole way
      } else {
        // entered or left at an interior vertex (a way the mapper did not split)
        const to = x >= 0 ? x : (e === 0 ? n - 1 : e === n - 1 ? 0 : n - 1);
        const piece = to > e ? P.slice(e, to + 1) : P.slice(to, e + 1).reverse();
        emit(legRef(it.ref, it.w, piece, e + '>' + to), false);
      }
    }

    // ---- where along the path each call is -------------------------------
    // Arc length runs over the decoded polyline as ONE line, a gap counting as
    // the straight jump across it (js/tiledata.js routePath measures the same).
    const cum = [0];
    for (let i = 1; i < line.length; i++)
      cum.push(cum[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
    const cutSet = new Set(cuts);
    const sd = [], offPath = [];
    let from = 0, unsnapped = 0;
    for (const c of calls) {
      const q = primary(c), onRoad = !!c.S;
      // every segment ahead of the previous call, scored by distance, with a
      // platform on the left of the direction of travel counted as further
      // away (this country drives on the right, so that is the stop of the
      // opposite direction). The EARLIEST near-best wins, which is what keeps
      // a line that passes the same corner twice calling there in order.
      let best = Infinity, bestArc = -1;
      const hits = [];
      for (let i = 1; i < line.length; i++) {
        if (cum[i] < from || cutSet.has(i)) continue;
        const a = line[i - 1], b = line[i];
        const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez;
        if (!(L2 > 0)) continue;
        let u = ((q[0] - a[0]) * ex + (q[1] - a[1]) * ez) / L2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const arc = cum[i - 1] + Math.sqrt(L2) * u;
        if (arc < from) continue;
        const dx = q[0] - (a[0] + ex * u), dz = q[1] - (a[1] + ez * u);
        const d = Math.hypot(dx, dz);
        if (d > SNAP_MAX) continue;
        const right = (dx * -ez + dz * ex) / Math.sqrt(L2);
        const score = d + (!onRoad && right < -1 ? WRONG_SIDE : 0);
        hits.push([arc, score]);
        if (score < best) { best = score; bestArc = arc; }
      }
      offPath.push(bestArc < 0);
      if (bestArc < 0) { sd.push(-1); unsnapped++; continue; }
      // ...then the best within the next stretch of it, so a vertex a few
      // metres short of the stop does not win over the point abreast of it
      let first = -1;
      for (const [arc, score] of hits) if (score <= best + 6) { first = arc; break; }
      let near = Infinity;
      for (const [arc, score] of hits) if (arc >= first && arc <= first + 40 && score < near) { near = score; bestArc = arc; }
      sd.push(Math.round(bestArc));
      from = bestArc;
    }
    // a call the path never comes near sits between its neighbours, and says
    // so (CALL_OFF_PATH): its arc is a guess, its position is not
    for (let i = 0; i < sd.length; i++) {
      if (sd[i] >= 0) continue;
      let a = i - 1, b = i + 1;
      while (b < sd.length && sd[b] < 0) b++;
      const lo = a >= 0 ? sd[a] : 0, hi = b < sd.length ? sd[b] : Math.round(cum[cum.length - 1] ?? 0);
      sd[i] = Math.round(lo + (hi - lo) * (1 / (b - a)));
    }
    stats.unsnapped += unsnapped;

    // ---- the record ----------------------------------------------------------
    const s = [], sf = [];
    for (const c of calls) {
      const k = (c.S?.ref ?? '') + '/' + (c.P?.ref ?? '');
      let ix = file._stopIx.get(k);
      if (ix === undefined) {
        const name = c.S?.name || c.P?.name || '';
        const e = c.S && c.P ? [name, 3, ...c.S.pos, ...c.P.pos] : [name, c.S ? 1 : 2, ...primary(c)];
        ix = file.stops.length;
        file.stops.push(e);
        file._stopIx.set(k, ix);
      }
      s.push(ix);
      sf.push((c.S?.f ?? 0) | (c.P?.f ?? 0) | (offPath[s.length - 1] ? 8 : 0));
    }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    const grow = (p) => { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1]; };
    for (const p of line) grow(p);
    for (const c of calls) grow(primary(c));
    const master = masterOf.get(rel.id);
    const r = { id: rel.id, m: mode };
    const ref = t.ref ?? master?.tags.ref;
    if (ref) r.ref = ref;
    if (t.name) r.n = t.name;
    if (t.from) r.fr = t.from;
    if (t.to) r.to = t.to;
    const c = lineColour(t.colour ?? t.color ?? master?.tags.colour ?? master?.tags.color);
    if (c) r.c = c;
    const nw = t.network ?? master?.tags.network;
    if (nw) r.nw = nw;
    const op = t.operator ?? master?.tags.operator;
    if (op) r.op = op;
    if (master) r.ms = master.id;
    r.s = s;
    if (sf.some((v) => v)) r.sf = sf;
    r.sd = sd;
    r.p = path;
    r.L = Math.round(cum[cum.length - 1] ?? 0);
    r.bb = [Math.floor(x0), Math.floor(z0), Math.ceil(x1), Math.ceil(z1)];
    if (gaps) r.g = gaps;
    if (missing || lost) r.pa = 1;          // members outside the world: the line runs on
    file.routes.push(r);
    stats.kept++; stats.byMode[mode]++; stats.gaps += gaps;

    // ---- which tiles it passes through ----------------------------------------
    const touch = (x, z) => {
      const [tx, tz] = tileOf(x, z);
      if (!tileWanted(tx, tz)) return;
      const k = tx + '_' + tz;
      let set = tileIndex.get(k);
      if (!set) tileIndex.set(k, set = new Set());
      set.add(file.tx + '_' + file.tz);
    };
    for (const c of calls) touch(...primary(c));
    for (let i = 0; i < line.length; i++) {
      touch(line[i][0], line[i][1]);
      if (i && !cutSet.has(i)) {
        // a long straight (a motorway leg) can step over a tile without a vertex in it
        const a = line[i - 1], b = line[i], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
        for (let k = 1, n = Math.ceil(d / 1000); k < n; k++)
          touch(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n);
      }
    }
  }

  for (const f of files.values()) {
    stats.legs += f.legs.length; stats.stops += f.stops.length;
    delete f._stopIx; delete f._legIx; delete f._legPts;
  }
  return { files, tileIndex, stats };
}
