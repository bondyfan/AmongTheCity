// ---- what a walker can stop AT, and what a walker has to cross ----------------
// The tiles hold thousands of benches, bus stops, zebra crossings and named
// shops, and the crowd walked past every one of them. This module is the two
// spatial indexes that let a beat ask "what is beside me" once, at birth:
//
//   SiteIndex   points a walker can do something at: a bench (with the way it
//               faces), a bus stop, a shop window, a place that serves food or
//               drink, a zebra.
//   RoadIndex   the carriageways, as segments, so a beat can find every stretch
//               of itself that lies ON one (a crossing) and a stop can find the
//               kerb it stands at.
//
// Pure data and arithmetic: no three.js, no clock, no Math.random. Everything
// it answers is a function of the features it was given, in an order that does
// not depend on which tile arrived first (candidates are sorted by position
// before anything is chosen from them).

import { propFacing } from './furniture.js';
import { bayAt } from './streets.js';

const G = 32;                       // grid pitch, metres
const LAYBY_R = 14;                 // m from a way's centreline a lay-by and the walk round it can reach

export const SITE = { BENCH: 1, STOP: 2, WINDOW: 3, FOOD: 4, ZEBRA: 5 };

// Trades with a window worth stopping at, and the ones people gather outside.
const FOOD = new Set(['restaurant', 'cafe', 'bar', 'pub', 'fast_food', 'coffee', 'nightclub',
  'biergarten', 'ice_cream', 'cinema', 'theatre']);
const DULL = new Set(['office', 'storage_rental', 'car_repair', 'school', 'kindergarten',
  'townhall', 'groundskeeping', 'rental', 'car']);
export const isFoodVenue = (t) => FOOD.has(t);

const key = (i, j) => i + ',' + j;
const q10 = (v) => Math.round(v * 10);

// Stable order for anything hashed or chosen: position first, kind as tie-break.
function cmpSite(a, b) { return (a.x - b.x) || (a.z - b.z) || (a.kind - b.kind); }

// The same integer mixer pedestrians.js and traffic.js use (murmur3 finaliser).
export function hash32(a, b = 0, c = 0, d = 0, e = 0, f = 0) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < 6; i++) {
    let k = (i === 0 ? a : i === 1 ? b : i === 2 ? c : i === 3 ? d : i === 4 ? e : f) | 0;
    k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}
export const rnd01 = (h) => (h >>> 8) / 16777216;

/**
 * Which way a prop at (x, z) faces: toward the nearest way of its chunk cell.
 * THIS IS js/furniture.js facingOf, restated, and it has to stay that function:
 * a walker sits on the bench the mesh drew, facing the way the mesh faces.
 * tests/city-life.test.mjs holds the two against each other.
 */
export function facingOf(cell, x, z, fallback = 0) {
  let best = 40 * 40, dx = Math.sin(fallback), dz = Math.cos(fallback);
  for (const r of cell?.roads ?? []) {
    if (!r.p || r.p.length < 2) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t, qz = az + ez * t;
      const d2 = (x - qx) ** 2 + (z - qz) ** 2;
      if (d2 < best) {
        best = d2;
        const L = Math.sqrt(d2) || 1;
        dx = (qx - x) / L; dz = (qz - z) / L;
      }
    }
  }
  return Math.atan2(dx, dz);
}

export class SiteIndex {
  constructor() {
    this.m = new Map();
    this._seen = new Map();        // "kind:id" -> the site (a Map, so removeIds can find it)
    this._ids = new WeakMap();     // site -> the feature _id it was made from
    this.count = 0;
  }

  /** One site. `id` dedupes a feature that two tiles both report. */
  add(kind, x, z, id, extra = null) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const sid = kind + ':' + (id ?? (q10(x) + ',' + q10(z)));
    if (this._seen.has(sid)) return null;
    // the identity every hash about this site is drawn from: its kind and its
    // 10 cm position, never its arrival order
    const s = { kind, x, z, sid: hash32(kind, q10(x), q10(z)), ...extra };
    this._seen.set(sid, s);
    if (id != null) this._ids.set(s, id);
    const k = key(Math.floor(x / G), Math.floor(z / G));
    let a = this.m.get(k);
    if (!a) this.m.set(k, a = []);
    a.push(s);
    this.count++;
    return s;
  }

  /** Forget every site made from a feature with lo < _id <= hi (one released
   *  tile's id block, geo.js IDS_PER_TILE). Sites without an id (bus stops,
   *  from the pois geo.js keeps) stay. Returns how many went. */
  removeIds(lo, hi) {
    let n = 0;
    for (const [sk, s] of this._seen) {
      const id = this._ids.get(s);
      if (!(id > lo && id <= hi)) continue;
      this._seen.delete(sk);
      const k = key(Math.floor(s.x / G), Math.floor(s.z / G));
      const a = this.m.get(k);
      const i = a ? a.indexOf(s) : -1;
      if (i >= 0) a.splice(i, 1);
      if (a && !a.length) this.m.delete(k);
      this.count--;
      n++;
    }
    return n;
  }

  /** Every site within r of (x, z), into `out` (unsorted). */
  near(x, z, r, out = []) {
    const i0 = Math.floor((x - r) / G), i1 = Math.floor((x + r) / G);
    const j0 = Math.floor((z - r) / G), j1 = Math.floor((z + r) / G);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.m.get(key(i, j));
      if (!a) continue;
      for (const s of a) if ((s.x - x) ** 2 + (s.z - z) ** 2 <= r * r) out.push(s);
    }
    return out;
  }

  /** Is there a site of `kind` within r of (x, z)? */
  has(kind, x, z, r) {
    const i0 = Math.floor((x - r) / G), i1 = Math.floor((x + r) / G);
    const j0 = Math.floor((z - r) / G), j1 = Math.floor((z + r) / G);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.m.get(key(i, j));
      if (!a) continue;
      for (const s of a) if (s.kind === kind && (s.x - x) ** 2 + (s.z - z) ** 2 <= r * r) return s;
    }
    return null;
  }

  /**
   * Take what a chunk cell of the city index holds. `seenCells` keeps a cell
   * from being read twice for the features that never change (the caller owns
   * it, because a cell gains features when a second tile touches it).
   */
  addCell(cell) {
    if (!cell) return;
    for (const f of cell.furniture ?? []) {
      if (f.k !== 'bench') continue;
      const [x, z] = f.p[0];
      // the bench's own facing, asked of the module that draws it
      this.add(SITE.BENCH, x, z, f._id, { h: propFacing(cell, f) });
    }
    for (const c of cell.crossings ?? []) {
      const q = c.p[0];
      this.add(SITE.ZEBRA, q[0], q[1], c._id, { sig: q[2] ? 1 : 0 });
    }
    for (const v of cell.venues ?? []) {
      if (!v.t || DULL.has(v.t)) continue;
      const q = v.p[0];
      this.add(FOOD.has(v.t) ? SITE.FOOD : SITE.WINDOW, q[0], q[1], v._id);
    }
  }
}

// ---- carriageways --------------------------------------------------------------
export class RoadIndex {
  constructor() { this.m = new Map(); }

  /** A drivable way, segment by segment, into every grid cell it touches. */
  add(r) {
    const p = r.p, hw = (r.w ?? 3) / 2;
    let run = 0;                        // metres from the start of the way: what a lay-by is filed under
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
      const L = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
      if (!(L > 1e-6)) continue;
      const seg = { ax, az, bx, bz, L, hw, r, s0: run };
      run += L;
      // every cell the ASPHALT touches, not just the centreline: on() reads one cell
      const m = hw + 1;
      const i0 = Math.floor((Math.min(ax, bx) - m) / G), i1 = Math.floor((Math.max(ax, bx) + m) / G);
      const j0 = Math.floor((Math.min(az, bz) - m) / G), j1 = Math.floor((Math.max(az, bz) + m) / G);
      for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
        const k = key(gi, gj);
        let a = this.m.get(k);
        if (!a) this.m.set(k, a = []);
        a.push(seg);
      }
    }
  }

  /** Take these ways out again (a tile geo.js released). */
  remove(roads) {
    const gone = new Set(roads);
    if (!gone.size) return;
    // the cells add() filed each segment in, and no others
    const keys = new Set();
    for (const r of gone) {
      const p = r.p, m = (r.w ?? 3) / 2 + 1;
      for (let i = 0; i < p.length - 1; i++) {
        const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
        const i0 = Math.floor((Math.min(ax, bx) - m) / G), i1 = Math.floor((Math.max(ax, bx) + m) / G);
        const j0 = Math.floor((Math.min(az, bz) - m) / G), j1 = Math.floor((Math.max(az, bz) + m) / G);
        for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) keys.add(key(gi, gj));
      }
    }
    for (const k of keys) {
      const a = this.m.get(k);
      if (!a) continue;
      let n = 0;
      for (let i = 0; i < a.length; i++) if (!gone.has(a[i].r)) a[n++] = a[i];
      if (n === a.length) continue;
      a.length = n;
      if (!n) this.m.delete(k);
    }
  }

  /**
   * The carriageway nearest (x, z) within r: { d, qx, qz, dx, dz, hw, r } with
   * (dx, dz) the unit direction of the segment, or null.
   */
  nearest(x, z, r = 30, skipService = false) {
    let best = null, bd = r;
    const i0 = Math.floor((x - r) / G), i1 = Math.floor((x + r) / G);
    const j0 = Math.floor((z - r) / G), j1 = Math.floor((z + r) / G);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.m.get(key(i, j));
      if (!a) continue;
      for (const s of a) {
        if (skipService && s.r.t === 'service') continue;
        const ex = s.bx - s.ax, ez = s.bz - s.az;
        let t = ((x - s.ax) * ex + (z - s.az) * ez) / (s.L * s.L);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = s.ax + ex * t, qz = s.az + ez * t;
        const d = Math.sqrt((x - qx) ** 2 + (z - qz) ** 2);
        // ties resolved by geometry, so the answer does not depend on the order
        // the tiles (and so the segments) arrived in
        if (d < bd - 1e-9 || (best && Math.abs(d - bd) <= 1e-9 && (s.ax - best.seg.ax || s.az - best.seg.az) < 0)) {
          bd = d;
          best = { d, qx, qz, dx: ex / s.L, dz: ez / s.L, hw: s.hw, r: s.r, seg: s };
        }
      }
    }
    return best;
  }

  /**
   * The lay-by beside (x, z), for somebody walking ALONG the street there: how
   * far out from the way they would have to be to walk `clear` metres behind
   * the kerb where it steps out round the bay (js/streets.js bayAt, on the
   * side the point is on). Writes { push, nx, nz, dx, dz } into `out` (push in
   * metres along the unit normal (nx, nz) away from the way, (dx, dz) the way's
   * direction) and returns it, or null where no bay reaches the point.
   */
  layby(x, z, layer, clear, out) {
    let best = null, bd = LAYBY_R, bt = 0;
    const i0 = Math.floor((x - LAYBY_R) / G), i1 = Math.floor((x + LAYBY_R) / G);
    const j0 = Math.floor((z - LAYBY_R) / G), j1 = Math.floor((z + LAYBY_R) / G);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const a = this.m.get(key(i, j));
      if (!a) continue;
      for (const s of a) {
        const r = s.r;
        if (!r._bays || r.br || (r.l ?? 0) !== (layer ?? 0)) continue;
        const ex = s.bx - s.ax, ez = s.bz - s.az;
        let t = ((x - s.ax) * ex + (z - s.az) * ez) / (s.L * s.L);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.sqrt((x - s.ax - ex * t) ** 2 + (z - s.az - ez * t) ** 2);
        // the nearest piece of a way with bays (ties by geometry, as nearest())
        if (d < bd - 1e-9 || (best && Math.abs(d - bd) <= 1e-9 && (s.ax - best.ax || s.az - best.az) < 0)) { bd = d; best = s; bt = t; }
      }
    }
    // (on the centreline itself there is no side to step to: that is a crossing)
    if (!best || bd < 0.5) return null;
    const tx = (best.bx - best.ax) / best.L, tz = (best.bz - best.az) / best.L;
    const nx = (x - best.ax - (best.bx - best.ax) * bt) / bd, nz = (z - best.az - (best.bz - best.az) * bt) / bd;
    const left = (nx * -tz + nz * tx) >= 0 ? 1 : -1;
    const bay = bayAt(best.r, best.s0 + best.L * bt, -left);
    if (!(bay > 0)) return null;
    // the margin comes in with the bay, so the line bends out as the kerb does
    const push = best.hw + bay + clear * (bay < 1 ? bay : 1) - bd;
    if (!(push > 0)) return null;
    out.push = push; out.nx = nx; out.nz = nz; out.dx = tx; out.dz = tz;
    return out;
  }

  /**
   * Is (x, z) ON a carriageway of layer `layer` (not a bridge over the path,
   * not a tunnel under it)? Returns the same record nearest() does, for the
   * way whose asphalt the point is deepest into, or null.
   * `deck`: the asker is ON a bridge (a footway carried over the river beside
   * the road), so the carriageways that count are the bridge decks of that
   * layer and nothing on the ground below.
   */
  on(x, z, layer = 0, margin = 0, deck = false) {
    let best = null, bd = 0;
    const i = Math.floor(x / G), j = Math.floor(z / G);
    const a = this.m.get(key(i, j));
    if (!a) return null;
    for (const s of a) {
      const r = s.r;
      if (!!r.br !== deck || (r.l ?? 0) !== (layer ?? 0)) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az;
      let t = ((x - s.ax) * ex + (z - s.az) * ez) / (s.L * s.L);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = s.ax + ex * t, qz = s.az + ez * t;
      const inside = s.hw + margin - Math.sqrt((x - qx) ** 2 + (z - qz) ** 2);
      if (inside > bd + 1e-9 || (best && Math.abs(inside - bd) <= 1e-9 && (s.ax - best.seg.ax || s.az - best.seg.az) < 0)) {
        bd = inside;
        best = { d: s.hw - inside, qx, qz, dx: ex / s.L, dz: ez / s.L, hw: s.hw, r, seg: s };
      }
    }
    return best;
  }

  /**
   * EVERY carriageway (x, z) is on, one record per way (the segment of it the
   * point is deepest into), pushed into `out`. A junction mouth is two roads'
   * asphalt at once, and somebody crossing it is in the way of both.
   */
  onAll(x, z, layer, out) {
    const a = this.m.get(key(Math.floor(x / G), Math.floor(z / G)));
    if (!a) return out;
    const n0 = out.length;
    for (const s of a) {
      const r = s.r;
      if (r.br || (r.l ?? 0) !== (layer ?? 0)) continue;
      const ex = s.bx - s.ax, ez = s.bz - s.az;
      let t = ((x - s.ax) * ex + (z - s.az) * ez) / (s.L * s.L);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = s.ax + ex * t, qz = s.az + ez * t;
      const d = Math.sqrt((x - qx) ** 2 + (z - qz) ** 2);
      if (d >= s.hw) continue;
      let k = n0;
      while (k < out.length && out[k].r !== r) k++;
      if (k < out.length && out[k].d <= d) continue;
      out[k] = { d, qx, qz, dx: ex / s.L, dz: ez / s.L, hw: s.hw, r, seg: s };
    }
    return out;
  }

  /**
   * Does the straight hop a-b (on layer `layer`) pass over a carriageway?
   * Pushes one record per way it touches into `out`, sampled every metre.
   */
  crossSeg(ax, az, bx, bz, layer, out) {
    const L = Math.sqrt((bx - ax) ** 2 + (bz - az) ** 2);
    const n = Math.max(1, Math.ceil(L));
    let last = null;
    for (let i = 0; i <= n; i++) {
      const h = this.on(ax + (bx - ax) * i / n, az + (bz - az) * i / n, layer);
      if (!h || h.r === last) continue;
      last = h.r;
      out.push({ cx: h.qx, cz: h.qz, rdx: h.dx, rdz: h.dz, hw: h.hw, r: h.r });
    }
    return out;
  }
}

/** Half the length of kerb the people waiting at one stop spread along, metres. */
export const STOP_SPREAD = 2.5;

/**
 * How far the kerb steps out where people wait at the stop at (x, z): the width
 * of the lay-by on the stop's own side of `road` (RoadIndex.nearest() for the
 * stop), 0 where the street has none. THE BUS PULLS INTO THAT WIDTH
 * (js/traffic.js moves it over by bayAt), so it is carriageway like the rest:
 * waiters who stood 1.1 m behind the street's nominal edge stood inside the
 * bay, and the arriving bus knocked them down. js/streets.js indexBays is
 * restated here on purpose (same nearest point, same side rule): the bay the
 * waiters step back from has to be the bay that is drawn and driven into.
 */
export function stopBay(x, z, road) {
  const r = road?.r;
  if (!r || !r._bays || !r.p) return 0;
  let best = Infinity, s = 0, tx = 1, tz = 0, qx = x, qz = z;
  for (let i = 0, run = 0; i < r.p.length - 1; i++) {
    const ax = r.p[i][0], az = r.p[i][1];
    const ex = r.p[i + 1][0] - ax, ez = r.p[i + 1][1] - az, L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d2 = (x - (ax + ex * t)) ** 2 + (z - (az + ez * t)) ** 2;
    if (d2 < best) { best = d2; s = run + L * t; tx = ex / L; tz = ez / L; qx = ax + ex * t; qz = az + ez * t; }
    run += L;
  }
  // A stop node ON the centreline: stopSpot puts its waiters to the right of
  // the way's direction, which is this frame's left normal.
  const left = best < 0.09 || ((x - qx) * -tz + (z - qz) * tx) >= 0 ? 1 : -1;
  // waiters spread a couple of metres either way along the kerb (and a second
  // stop's bay may begin there): the widest of the three is what they clear
  return Math.max(bayAt(r, s, -left), bayAt(r, s - STOP_SPREAD, -left), bayAt(r, s + STOP_SPREAD, -left));
}

/**
 * Where people wait at a bus stop: just in front of the shelter, on the
 * pavement side of the kerb. `road` is RoadIndex.nearest() for the stop (or
 * null), `bay` the width of the lay-by there (stopBay), which is carriageway
 * too. Returns { x, z, fx, fz } with (fx, fz) the unit vector toward the road.
 */
export function stopSpot(x, z, road, bay = 0) {
  if (!road) return { x, z, fx: 0, fz: 1, ax: 1, az: 0 };
  const hw = road.hw + bay;
  let tx = road.qx - x, tz = road.qz - z;
  let d = Math.sqrt(tx * tx + tz * tz);
  if (d < 0.3) {
    // the stop node sits ON the centreline (a stop_position): take the right
    // of the way's own direction, which is the kerb a bus running along it serves
    tx = road.dz; tz = -road.dx; d = 1;
    return { x: road.qx - tx * (hw + 1.3), z: road.qz - tz * (hw + 1.3), fx: tx, fz: tz,
      ax: road.dx, az: road.dz };
  }
  tx /= d; tz /= d;
  // never on the asphalt: at least 1.1 m behind the carriageway edge
  const back = Math.max(0, hw + 1.1 - d);
  return { x: x - tx * back + tx * Math.min(0.9, Math.max(0, d - hw - 1.1)),
    z: z - tz * back + tz * Math.min(0.9, Math.max(0, d - hw - 1.1)),
    fx: tx, fz: tz, ax: road.dx, az: road.dz };
}

export const _order = { cmpSite };
