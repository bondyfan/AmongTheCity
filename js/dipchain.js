// ---- dipchain.js: one grade line along a street that passes under something ----
// MAIN THREAD (js/underpass.js finds the crossings and calls rebuildChains;
// geo.levelWay lays the line through applyDip / underCap). The worker never
// needs it: the dipped line travels inside each way's `_prof`.

import { CHUNK as CHUNK_M } from './config.js';
import { polylineLength, bridgeDeckHeight, curveR, crestFall, smax } from './geo.js';

const KEY = (x, z) => Math.round(x * 50) + ',' + Math.round(z * 50);
const DIP_GRADE = 0.07;     // what a town underpass ramp falls at (ČSN 73 6110 allows 8 %)
const CHAIN_REACH = 260;    // m of street either side a dip chain may span
const FIELD_DS = 1;         // m between samples of a chain's dip
const cellAt = (city, x, z) => city.chunkIndex.get(Math.floor(x / CHUNK_M) + ',' + Math.floor(z / CHUNK_M));
const lenOf = (r) => r._len ?? (r._len = polylineLength(r.p));

// ---- dip chains ---------------------------------------------------------------
// One street, several OSM ways: the dip must be ONE line along all of them, or
// every way would dip by itself and meet the next at a step. The chain is the
// way under the bridge and its continuations both ways (the end-to-end way
// running on most nearly straight, the same name first), out to CHAIN_REACH.
//
// Rebuilt from every way that passes under something whenever a tile arrives,
// in id order, so the chains are the same whichever order the tiles came in
// (a way of the next tile can lengthen a chain); a chain that comes out the
// same as before is kept as it was, profiles and all.
export function rebuildChains(city) {
  const old = city._dipChains ?? new Map();
  const next = new Map();
  for (const ch of old.values()) for (const m of ch.members) { m.r._dipChain = undefined; m.r._dipM = undefined; }
  const order = [...(city._dipWays ?? [])].sort((a, b) => a._id - b._id);
  const ends = new Map();     // cell -> its ways by end vertex, for this rebuild (see endsOf)
  for (const w of order) {
    if (w._dipChain) continue;
    const fwd = walk(city, w, 1, ends), back = walk(city, w, 0, ends);
    const seq = [...back.reverse(), { r: w, rev: false }, ...fwd];
    const ch = { members: [], dips: [], field: null, total: 0 };
    let off = 0;
    for (const m of seq) {
      m.off = off; off += lenOf(m.r);
      ch.members.push(m);
      m.r._dipChain = ch; m.r._dipM = m;
    }
    ch.total = off;
    for (const m of ch.members) for (const d of m.r._dipX ?? [])
      ch.dips.push({ ...d, u: m.off + (m.rev ? lenOf(m.r) - d.s : d.s) });
    const key = ch.members.map((m) => m.r._id + (m.rev ? 'r' : 'f')).join(',') + '|' + ch.dips.length;
    const was = old.get(key);
    if (was) {                                   // the same chain: keep it, caches and all
      for (const m of was.members) { m.r._dipChain = was; m.r._dipM = m; }
      next.set(key, was);
      continue;
    }
    next.set(key, ch);
    // every member re-levels, and every junction on the chain learns where along it it is
    for (const m of ch.members) {
      m.r._prof = undefined;
      for (const p of m.r._pins ?? []) {
        p.node._dipChain = ch;
        p.node._dipU = m.off + (m.rev ? lenOf(m.r) - p.s : p.s);
        for (const a of p.node.arms) if (a.r !== m.r) a.r._prof = undefined;
      }
    }
  }
  // junctions of a chain that is gone forget it
  for (const [key, ch] of old) {
    if (next.get(key) === ch) continue;
    for (const m of ch.members) {
      if (!m.r._dipChain) m.r._prof = undefined;
      for (const p of m.r._pins ?? []) if (p.node._dipChain === ch) {
        p.node._dipChain = undefined;
        for (const a of p.node.arms) a.r._prof = undefined;
      }
    }
  }
  city._dipChains = next;
}

// The ways of a cell that END at each vertex key, in the cell's own order.
// A rebuild walks out of the same town cells hundreds of times (311 ways
// under something on four Prague tiles), and keying every way of a cell for
// every step was 35 ms of a frame; each cell is keyed once per rebuild now.
function endsOf(c, ends) {
  let m = ends.get(c);
  if (m) return m;
  m = new Map();
  for (const o of c.roads) {
    if (o.br || !o.p || o.p.length < 2) continue;
    const n = o.p.length - 1;
    const k0 = KEY(o.p[0][0], o.p[0][1]), k1 = KEY(o.p[n][0], o.p[n][1]);
    let a = m.get(k0);
    if (!a) m.set(k0, a = []);
    a.push(o);
    if (k1 !== k0) { let b = m.get(k1); if (!b) m.set(k1, b = []); b.push(o); }
  }
  ends.set(c, m);
  return m;
}

function walk(city, w, atEnd, ends) {
  const out = [];
  let cur = w, end = atEnd, reach = 0;
  for (let guard = 0; guard < 24 && reach < CHAIN_REACH; guard++) {
    const p = cur.p, k = end ? p.length - 1 : 0, k2 = end ? p.length - 2 : 1;
    const [x, z] = p[k];
    const L = Math.hypot(x - p[k2][0], z - p[k2][1]) || 1;
    const dx = (x - p[k2][0]) / L, dz = (z - p[k2][1]) / L;
    const c = cellAt(city, x, z);
    if (!c) break;
    const k0 = KEY(x, z);
    let best = null, bestScore = 0.7;
    for (const o of (ends ? endsOf(c, ends).get(k0) : c.roads) ?? []) {
      if (o === cur || o === w || o.br || !o.p || o.p.length < 2 || !!o.d !== !!w.d) continue;
      if (o._dipChain || out.some((m) => m.r === o)) continue;   // (one chain a way)
      const n = o.p.length - 1;
      const e0 = KEY(o.p[0][0], o.p[0][1]) === k0, e1 = KEY(o.p[n][0], o.p[n][1]) === k0;
      if (!e0 && !e1) continue;
      const q = e0 ? o.p[1] : o.p[n - 1];
      const ql = Math.hypot(q[0] - x, q[1] - z) || 1;
      const cos = ((q[0] - x) * dx + (q[1] - z) * dz) / ql;
      const score = cos + (o.n && o.n === cur.n ? 0.3 : 0);
      if (score > bestScore) { bestScore = score; best = { r: o, e0 }; }
    }
    if (!best) break;
    // walking away from w: a way entered at its start runs forward
    out.push({ r: best.r, rev: atEnd ? !best.e0 : best.e0 });
    reach += lenOf(best.r);
    cur = best.r; end = best.e0 ? 1 : 0;
  }
  return out;
}

// THE CAP. Under each structure the street may be no higher than the deck less
// its headroom and the deck's own depth; away from it the cap rises at
// DIP_GRADE out of a sag of the street's design radius. The street is then
// the smooth minimum of its own levelled line and the cap: where the survey
// already holds the cutting (DMR 5G has most of it, blurred by its 20 m
// samples) the street keeps its line, and the ramps never steepen by adding
// the cap's grade to the ground's.
const CAP_FAR = 9999;       // "no cap": far above anything a street is levelled to
const SMIN_K = 1.0;         // m: the crest where the ramp meets the street
const smin = (a, b) => -smax(-a, -b, SMIN_K);

/** The chain's cap at chain arclength u (CAP_FAR where nothing crosses). */
export function dipAt(ch, u, terrain) {
  const f = field(ch, terrain);
  if (!f) return CAP_FAR;
  const t = Math.max(0, Math.min(f.n - 1, u / FIELD_DS));
  const i = Math.min(f.n - 2, Math.floor(t)), a = t - i;
  return f.C[i] + (f.C[i + 1] - f.C[i]) * a;
}
/** A level held under the chain's cap: what a side road's pin aims for (geo.levelWay). */
export function underCap(ch, u, y, terrain) {
  const c = dipAt(ch, u, terrain);
  return c - y > 3 * SMIN_K ? y : smin(y, c);
}

/** Hold a member way's levelled samples under the chain's cap. Returns readiness. */
export function applyDip(way, y, ds, terrain) {
  const ch = way._dipChain, m = way._dipM;
  if (!ch || !m) return true;
  const f = field(ch, terrain);
  if (!f) return true;
  const L = lenOf(way);
  for (let i = 0; i < y.length; i++) {
    const s = Math.min(L, i * ds);
    y[i] = underCap(ch, m.off + (m.rev ? L - s : s), y[i], terrain);
  }
  return f.ready;
}

function field(ch, terrain) {
  const loads = terrain._loads ?? 0;
  const c = ch.field;
  if (c && c.terrain === terrain && (c.ready || c.loads === loads)) return c;
  if (ch._busy) return null;
  ch._busy = true;
  try {
    let ready = true;
    const R = curveR(Math.max(...ch.members.map((m) => m.r.v || 30)));
    const caps = [];
    for (const d of ch.dips) {
      if (terrain.ready && !terrain.ready(d.x, d.z)) ready = false;
      caps.push({ u: d.u, hw: d.hw, y: bridgeDeckHeight(d.b, d.sb, terrain) - d.clear });
    }
    const n = Math.max(2, Math.ceil(ch.total / FIELD_DS) + 1);
    const C = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i * FIELD_DS;
      let v = CAP_FAR;
      for (const k of caps) {
        const e = k.y + crestFall(Math.max(0, Math.abs(u - k.u) - k.hw), DIP_GRADE, R);
        if (e < v) v = e;
      }
      C[i] = v;
    }
    ch.field = { terrain, loads, ready, n, C };
    return ch.field;
  } finally { ch._busy = false; }
}
