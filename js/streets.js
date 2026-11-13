// ---- streets: what stands beside a carriageway, and how junctions are shaped --
// A road in the tiles is a centreline and a width. A STREET is more than that:
// a kerb, a pavement behind it, a dropped kerb where people cross, a corner
// that turns on a radius. None of it is in the data as geometry, so it is
// derived here as plain numbers hung on the ways and the junction nodes:
//
//   r._vg   per-station description of the verge on each side of a kerbed way:
//           how wide the raised band is, what it is surfaced with, how far the
//           kerb is dropped there. The mesh draws it, city.js stands on it, and
//           both read the same arrays, so feet and paving cannot disagree.
//   r._jz   the stretches of a way that lie inside a junction mouth, where the
//           junction's own kerb takes over from the ribbon's.
//   r._bays bus lay-bys (the kerb steps out around them).
//   node._hullRing / _edge / _legs   the junction outline with corner fillets,
//           and the kerb that runs along it.
//
// WHEN. The outlines are shaped at index time (geo.indexJunctions), because a
// ribbon has to know where its junction mouths are before anything is built.
// The verge of a way and the kerb of a junction are worked out on FIRST USE
// instead, on the main thread, from the chunk index: doing all 117 km of a town
// tile at index time cost 120 ms of blocked frame for streets the player may
// never drive down. The two doors every consumer comes through are in geo.js
// (roadProfile for a way, junctionsIn / clustersIn for a bucket), which is also
// exactly what chunkspec.js calls before it copies a chunk's inputs for the
// mesh worker, so a worker never has to derive any of this: it arrives done.
//
// Pure data and pure math: no three.js, no DOM, nothing the mesh worker cannot
// import. Everything it writes is a plain object, array or typed array, because
// chunkspec.js copies these across the worker boundary as they stand.

// ---- dimensions (metres) ----
export const KERB_H = 0.12;     // pavement top above the carriageway (ČSN: 100-120 mm)
export const KERB_W = 0.22;     // the kerb stone itself
export const WALK_W = 1.7;      // kerb + pavement where OSM maps no footway of its own
export const DROP_LIP = 0.02;   // what a dropped kerb still stands proud of the asphalt
export const FOOT_LIFT = 0.02;  // a mapped footway rides this far above the band it crosses
const VG_DS = 2.5;              // station spacing along a way
const DROP_REACH = 2.6;         // half length of a dropped kerb

// Which ways are streets with kerbs. Not living streets (a Czech obytná zóna is
// one shared surface by definition), not service ways (driveways, car park
// aisles), not motorways and trunks (those have barriers, not kerbs).
const KERBED = new Set(['residential', 'unclassified', 'tertiary', 'secondary', 'primary',
  'tertiary_link', 'secondary_link', 'primary_link']);
const WALKS = new Set(['footway', 'cycleway', 'pedestrian']);
const CROSSERS = new Set(['footway', 'cycleway', 'pedestrian', 'path', 'steps']);

// Kerb radius by the LESSER road at a corner. A driveway turns on 3 m, a
// residential corner on 6, a main road on 9 to 10 (ČSN 73 6110, table 14).
const RADIUS = {
  motorway: 14, trunk: 14, primary: 10, secondary: 9, tertiary: 8,
  unclassified: 6, residential: 6, living_street: 4, service: 3,
  motorway_link: 12, trunk_link: 12, primary_link: 10, secondary_link: 9, tertiary_link: 8,
};
// How important a way is, for deciding who gives way where nothing is signed.
const RANK = {
  motorway: 7, trunk: 7, primary: 6, secondary: 5, tertiary: 4,
  motorway_link: 6, trunk_link: 6, primary_link: 5, secondary_link: 4, tertiary_link: 3,
  unclassified: 3, residential: 2, living_street: 1, service: 0,
};
export const roadRank = (r) => RANK[r?.t] ?? 0;

const CH = 120;                 // chunk size; config.CHUNK, restated so this stays import-free

function ptSeg(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  let t = ((x - ax) * ex + (z - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + ex * t), z - (az + ez * t));
}
function bbOf(f) {
  if (f._sbb) return f._sbb;          // the same cache city.js and meshes.js keep
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const q of f.p) { if (q[0] < a) a = q[0]; if (q[1] < b) b = q[1]; if (q[0] > c) c = q[0]; if (q[1] > d) d = q[1]; }
  return (f._sbb = [a, b, c, d]);
}

/** Is (x, z) on the carriageway of some OTHER drivable way of the same layer? */
export function coveredBy(city, x, z, self, margin = 0) {
  const cell = city?.chunkIndex?.get(Math.floor(x / CH) + ',' + Math.floor(z / CH));
  if (!cell) return false;
  for (const o of cell.roads) {
    if (!o.d || o === self || o.br || !o.p || (o.l ?? 0) !== (self?.l ?? 0)) continue;
    const half = (o.w ?? 3) / 2 + margin, bb = bbOf(o);
    if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
    for (let i = 0; i < o.p.length - 1; i++) {
      if (ptSeg(x, z, o.p[i][0], o.p[i][1], o.p[i + 1][0], o.p[i + 1][1]) < half) return true;
    }
  }
  return false;
}

// ---- a way, walked at even stations ------------------------------------------
function stationsOf(p, len, n, segOf) {
  const out = new Float32Array(n * 4);
  const ds = len / (n - 1);
  let seg = 0, acc = 0;
  let L = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) || 1e-6;
  for (let k = 0; k < n; k++) {
    const want = k * ds;
    while (want > acc + L && seg < p.length - 2) {
      acc += L; seg++;
      L = Math.hypot(p[seg + 1][0] - p[seg][0], p[seg + 1][1] - p[seg][1]) || 1e-6;
    }
    const t = Math.max(0, Math.min(1, (want - acc) / L));
    out[k * 4] = p[seg][0] + (p[seg + 1][0] - p[seg][0]) * t;
    out[k * 4 + 1] = p[seg][1] + (p[seg + 1][1] - p[seg][1]) * t;
    out[k * 4 + 2] = (p[seg + 1][0] - p[seg][0]) / L; out[k * 4 + 3] = (p[seg + 1][1] - p[seg][1]) / L;
    segOf[k] = seg;
  }
  return out;
}

// ---- bus lay-bys --------------------------------------------------------------
// The shape meshes.bayInto draws (ČSN 73 6425-1, one bus): the kerb has to step
// out around it, so the same numbers live here where both can read them.
export const BAY_W = 3.0, BAY_FLAT = 6.5, BAY_TAPER = 10;
/** Extra carriageway width at arclength s on side e (+1 / -1) from a lay-by. */
export function bayAt(r, s, e) {
  const b = r._bays;
  if (!b) return 0;
  let w = 0;
  for (let i = 0; i < b.length; i += 2) {
    if (b[i + 1] !== e) continue;
    const d = Math.abs(s - b[i]);
    const v = d <= BAY_FLAT ? BAY_W : BAY_W * Math.max(0, 1 - (d - BAY_FLAT) / BAY_TAPER);
    if (v > w) w = v;
  }
  return w;
}

// ---- reading the verge --------------------------------------------------------
const _vs = { w: 0, t: 0, drop: 0, u: 0 };
/**
 * The verge of way `r` at arclength `s` on side index `side` (1 = the side the
 * ribbon frame's perpendicular (dz, -dx) points to, 0 = the other).
 * Returns a shared scratch { w, t, drop, u }: band width in metres (0 = none
 * drawn here), surface (1 paving, 2 grass), kerb drop 0..1, and whether this is
 * a kerbed street at all (u), which holds even where no band is drawn (inside a
 * junction mouth, under another carriageway).
 */
export function vergeAt(r, s, side) {
  const vg = r._vg;
  _vs.w = 0; _vs.t = 0; _vs.drop = 0; _vs.u = 0;
  if (!vg) return _vs;
  let k = s / vg.ds;
  if (k < 0) k = 0; else if (k > vg.n - 1) k = vg.n - 1;
  const i = Math.min(vg.n - 2, Math.floor(k)), f = k - i;
  const W = vg.w[side], T = vg.t[side], D = vg.d[side];
  _vs.w = (W[i] + (W[i + 1] - W[i]) * f) * 0.1;
  _vs.t = f < 0.5 ? (T[i] || T[i + 1]) : (T[i + 1] || T[i]);
  _vs.drop = (D[i] + (D[i + 1] - D[i]) * f) / 255;
  _vs.u = (f < 0.5 ? vg.u[i] : vg.u[i + 1]) ? 1 : 0;
  return _vs;
}

/**
 * Is arclength s of r somewhere the ribbon draws NO band: inside a junction
 * mouth, or off the end of the way altogether? A point past the end of a way
 * projects onto its last metre (s = 0 or its whole length), and what lies there
 * is the next way's carriageway or the junction, never this way's pavement.
 */
export function inZone(r, s) {
  if (s <= 0.02 || s >= (r._len ?? Infinity) - 0.02) return true;
  const z = r._jz;
  if (!z) return false;
  // (inclusive: a point past the END of a way projects onto its last metre,
  // and that is exactly where a junction zone ends)
  for (let i = 0; i < z.length; i += 2) if (s >= z[i] && s <= z[i + 1]) return true;
  return false;
}

/**
 * Height of the verge surface above the carriageway deck, `x` metres out from
 * the kerb line, given the band width and drop there. A dropped kerb tilts the
 * band toward the road: the kerb line comes down to a 2 cm lip and the back of
 * the pavement stays where it was.
 */
export function vergeLift(w, drop, x) {
  if (drop <= 0) return KERB_H;
  const run = Math.max(w, 1.2);
  const k = x <= 0 ? 1 : x >= run ? 0 : 1 - x / run;
  return KERB_H - (KERB_H - DROP_LIP) * drop * k;
}

// ---- built-up ground: is there a building near here? --------------------------
// One 5 x 5 bitmap per chunk cell (24 m squares), made the first time a street
// through it is asked about and remade when the cell's building list changes
// length (a far tile gives its buildings back and takes them again). Main
// thread only; nothing here crosses to a worker.
const _occ = new Map();
function occOf(city, ck) {
  const cell = city.chunkIndex.get(ck);
  const nb = cell?.buildings?.length ?? 0;
  let o = _occ.get(ck);
  if (o && o.n === nb) return o;
  o = { n: nb, bits: 0 };
  if (nb) {
    const comma = ck.indexOf(',');
    const x0 = +ck.slice(0, comma) * CH, z0 = +ck.slice(comma + 1) * CH;
    const put = (x, z) => {
      const i = Math.floor((x - x0) / 24), j = Math.floor((z - z0) / 24);
      if (i >= 0 && i < 5 && j >= 0 && j < 5) o.bits |= 1 << (j * 5 + i);
    };
    for (const b of cell.buildings) {
      const ring = b.o;
      if (!ring) continue;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / 20));
        for (let k = 0; k < n; k++) put(a[0] + (c[0] - a[0]) * (k / n), a[1] + (c[1] - a[1]) * (k / n));
      }
    }
  }
  _occ.set(ck, o);
  return o;
}
/** A building outline within two 24 m squares of (x, z): 48 to 72 m. */
function builtUp(city, x, z) {
  const gx = Math.floor(x / 24), gz = Math.floor(z / 24);
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const X = gx + i, Z = gz + j;
      const cx = Math.floor(X / 5), cz = Math.floor(Z / 5);
      const o = occOf(city, cx + ',' + cz);
      if (o.bits && (o.bits & (1 << ((Z - cz * 5) * 5 + (X - cx * 5))))) return true;
    }
  }
  return false;
}

/** Fill gaps shorter than `gap` stations, then drop runs shorter than `run`. */
function settle(u, gap, run) {
  const n = u.length;
  let i = 0;
  while (i < n) {
    if (u[i]) { i++; continue; }
    let j = i;
    while (j < n && !u[j]) j++;
    if (i > 0 && j < n && j - i <= gap) for (let k = i; k < j; k++) u[k] = 1;
    i = j;
  }
  i = 0;
  while (i < n) {
    if (!u[i]) { i++; continue; }
    let j = i;
    while (j < n && u[j]) j++;
    if (j - i < run && !(i === 0 && j === n)) for (let k = i; k < j; k++) u[k] = 0;
    i = j;
  }
}

function markDrop(vg, s) {
  const k0 = Math.max(0, Math.ceil((s - DROP_REACH) / vg.ds));
  const k1 = Math.min(vg.n - 1, Math.floor((s + DROP_REACH) / vg.ds));
  for (let k = k0; k <= k1; k++) { vg.d[0][k] = 255; vg.d[1][k] = 255; }
  // a crossing shorter than one station still drops the nearest one
  if (k1 < k0) {
    const k = Math.max(0, Math.min(vg.n - 1, Math.round(s / vg.ds)));
    vg.d[0][k] = 255; vg.d[1][k] = 255;
  }
}

/**
 * Lay-bys, at index time: the kerb steps out around them, so a way has to know
 * its bays before its verge is worked out. The candidate set is the stop's own
 * chunk cell, exactly what meshes.busStopInto searches, so the bay the kerb
 * avoids is the bay that is drawn.
 */
export function indexBays(city, pois) {
  for (const poi of pois ?? []) {
    if (poi.t !== 'bus_stop' || !poi.p) continue;
    const x = poi.p[0], z = poi.p[1];
    const cell = city?.chunkIndex?.get(Math.floor(x / CH) + ',' + Math.floor(z / CH));
    if (!cell) continue;
    let best = 900, bestR = null, bestS = 0, tx = 1, tz = 0, qx = x, qz = z;
    for (const r of cell.roads) {
      if (!r.d || !r.p) continue;
      let run = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const ax = r.p[i][0], az = r.p[i][1], bx = r.p[i + 1][0], bz = r.p[i + 1][1];
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
        let t = ((x - ax) * ex + (z - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d2 = (x - (ax + ex * t)) ** 2 + (z - (az + ez * t)) ** 2;
        if (d2 < best) {
          best = d2; bestR = r; bestS = run + L * t; tx = ex / L; tz = ez / L;
          qx = ax + ex * t; qz = az + ez * t;
        }
        run += L;
      }
    }
    const r = bestR;
    if (!r || r.br || !(r.w >= 5.4)) continue;
    if (bestS - BAY_FLAT - BAY_TAPER < 0 || bestS + BAY_FLAT + BAY_TAPER > (r._len ?? 1e9)) continue;
    // meshes.bayInto's `side` is along the LEFT normal (-tz, tx); the frame
    // perpendicular this module counts sides by is (tz, -tx), its opposite
    const left = ((x - qx) * -tz + (z - qz) * tx) >= 0 ? 1 : -1;
    const b = (r._bays ??= []);
    let dup = false;
    for (let i = 0; i < b.length; i += 2) if (Math.abs(b[i] - bestS) < 0.5 && b[i + 1] === -left) dup = true;
    if (!dup) { b.push(bestS, -left); if (r._vg !== undefined) r._vg = undefined; }
  }
}

// ---- first use: the verge of one way -------------------------------------------
const _cd = [], _cw = [], _cc = [];     // candidates near one segment of the way
let _stamp = 0;

/** Everything near segment a-b of way r, from the chunk index, as flat numbers. */
function nearSeg(city, r, ax, az, bx, bz, hw) {
  _cd.length = 0; _cw.length = 0; _cc.length = 0;
  const reach = hw + BAY_W + 8.5, st = ++_stamp;
  const x0 = Math.min(ax, bx) - reach, x1 = Math.max(ax, bx) + reach;
  const z0 = Math.min(az, bz) - reach, z1 = Math.max(az, bz) + reach;
  const ex = bx - ax, ez = bz - az, L = Math.hypot(ex, ez) || 1e-6;
  const ux = ex / L, uz = ez / L;
  for (let cx = Math.floor(x0 / CH); cx <= Math.floor(x1 / CH); cx++) {
    for (let cz = Math.floor(z0 / CH); cz <= Math.floor(z1 / CH); cz++) {
      const cell = city.chunkIndex.get(cx + ',' + cz);
      if (!cell) continue;
      for (const o of cell.roads) {
        if (o === r || o._gs === st || !o.p || o.p.length < 2) continue;
        o._gs = st;
        const bb = bbOf(o);
        if (bb[2] < x0 || bb[0] > x1 || bb[3] < z0 || bb[1] > z1) continue;
        const drive = o.d && (o.w ?? 0) > 0 && !o.br && (o.l ?? 0) === (r.l ?? 0);
        const walk = !o.d && !o.br && WALKS.has(o.t);
        const crosser = !o.d && !o.br && CROSSERS.has(o.t);
        if (!drive && !crosser) continue;
        const p = o.p, last = p.length - 2;
        for (let i = 0; i <= last; i++) {
          const cx0 = p[i][0], cz0 = p[i][1], cx1 = p[i + 1][0], cz1 = p[i + 1][1];
          if (Math.max(cx0, cx1) < x0 || Math.min(cx0, cx1) > x1
            || Math.max(cz0, cz1) < z0 || Math.min(cz0, cz1) > z1) continue;
          if (drive) { _cd.push(cx0, cz0, cx1, cz1, (o.w ?? 3) / 2); continue; }
          const fx = cx1 - cx0, fz = cz1 - cz0, fl = Math.hypot(fx, fz) || 1e-6;
          const par = Math.abs((fx * ux + fz * uz) / fl);
          if (walk && par > 0.75) _cw.push(cx0, cz0, cx1, cz1);
          // …and a walking line that CROSSES this segment, or ends on it
          const den = fx * uz - fz * ux;
          let hit = false;
          if (par < 0.866 && Math.abs(den) > 1e-9) {
            const t = ((ax - cx0) * uz - (az - cz0) * ux) / den;       // along the walking line
            const v = ((ax - cx0) * fz - (az - cz0) * fx) / den;       // along this segment
            const ext = (hw + 0.4) / fl;
            if (t >= -ext && t <= 1 + ext && v >= 0 && v <= L) { _cc.push(v); hit = true; }
          }
          if (!hit) {
            for (const end of [i === 0 ? 0 : -1, i === last ? 1 : -1]) {
              if (end < 0) continue;
              const qx = end ? cx1 : cx0, qz = end ? cz1 : cz0;
              const v = (qx - ax) * ux + (qz - az) * uz;
              if (v >= 0 && v <= L && Math.abs((qx - ax) * uz - (qz - az) * ux) < hw + 0.4) _cc.push(v);
            }
          }
        }
      }
      for (const c of cell.crossings ?? []) {
        const q = c.p[0];
        const v = (q[0] - ax) * ux + (q[1] - az) * uz;
        if (v >= 0 && v <= L && Math.abs((q[0] - ax) * uz - (q[1] - az) * ux) < 1.2) _cc.push(v);
      }
    }
  }
}
const onAny = (x, z, margin) => {
  for (let i = 0; i < _cd.length; i += 5) {
    if (ptSeg(x, z, _cd[i], _cd[i + 1], _cd[i + 2], _cd[i + 3]) < _cd[i + 4] + margin) return true;
  }
  return false;
};

/**
 * Work out r._vg (or null: not a kerbed street). `city` needs chunkIndex.
 * Deterministic in the data the index holds at the time, and cached on the way.
 */
export function computeVerge(city, r) {
  r._vg = null;
  const gen = computeVergeGen(city, r);
  let it;
  do { it = gen.next(); } while (!it.done);
  return (r._vg = it.value);
}
/**
 * The same derivation with a place to stop after every segment of the way, for
 * a caller with a frame to protect (CityWorld._warmVerges): a way is 60 to 210
 * microseconds as a rule, and a street that runs the length of a town is one
 * way of up to 54 such segments. It RETURNS the verge and leaves r._vg alone, so nobody
 * reads a half-made answer; the caller assigns it. The scratch lists nearSeg
 * fills are only read inside the segment that filled them; the one pause that
 * falls INSIDE a segment (a long straight) fills them again if they were used
 * meanwhile, so nothing shared is trusted across a pause.
 */
export function* computeVergeGen(city, r) {
  if (!r.d || r.br || !KERBED.has(r.t) || !(r._len >= 8) || !r.p || r.p.length < 2) return null;
  const len = r._len;
  const n = Math.max(2, Math.ceil(len / VG_DS) + 1);
  const segOf = new Int32Array(n);
  const st = stationsOf(r.p, len, n, segOf);
  const hw = (r.w ?? 3) / 2;
  const u = new Uint8Array(n);
  let any = false;
  // built-up is asked every fourth station (10 m): a town does not start and
  // stop faster than that, and settle() closes what is left
  for (let k = 0; k < n; k += 4) {
    // (a pause every sixteenth station: the first street through a cell is
    // also what makes that cell's building bitmap, occOf above)
    if ((k & 63) === 60) yield;
    if (!builtUp(city, st[k * 4], st[k * 4 + 1])) continue;
    any = true;
    for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++) u[j] = 1;
  }
  if (!any) return null;
  settle(u, 24, 8);
  const ds = len / (n - 1);
  const vg = { n, ds, u,
    w: [new Uint8Array(n), new Uint8Array(n)],
    t: [new Uint8Array(n), new Uint8Array(n)],
    d: [new Uint8Array(n), new Uint8Array(n)] };
  let run = 0;
  for (let g = 0, k = 0; g < r.p.length - 1; g++) {
    const ax = r.p[g][0], az = r.p[g][1], bx = r.p[g + 1][0], bz = r.p[g + 1][1];
    const L = Math.hypot(bx - ax, bz - az);
    let k1 = k;
    while (k1 < n && segOf[k1] === g) k1++;
    let live = false;
    for (let j = Math.max(0, k - 1); j < Math.min(n, k1 + 1); j++) if (u[j]) live = true;
    if (live && L > 1e-6) {
      nearSeg(city, r, ax, az, bx, bz, hw);
      for (let i = 0; i < _cc.length; i++) markDrop(vg, run + _cc[i]);
      // (a long straight is hundreds of stations against one candidate list,
      // up to 13 ms of one step: a pause every 32 of them too, and the list is
      // made again if somebody else's segment used the scratch arrays meanwhile)
      let mine = _stamp, since = 0;
      for (; k < k1; k++) {
        if (!u[k]) continue;
        if (++since > 32) {
          since = 0;
          yield;
          if (_stamp !== mine) { nearSeg(city, r, ax, az, bx, bz, hw); mine = _stamp; }
        }
        const x = st[k * 4], z = st[k * 4 + 1], dx = st[k * 4 + 2], dz = st[k * 4 + 3];
        for (let side = 0; side < 2; side++) {
          const e = side ? 1 : -1;
          const px = dz * e, pz = -dx * e;
          const off = hw + bayAt(r, k * ds, e);
          const ex = x + px * off, ez = z + pz * off;
          // another carriageway where the kerb or the pavement would stand
          if (_cd.length && (onAny(ex + px * 0.7, ez + pz * 0.7, 0.1)
            || onAny(ex + px * (WALK_W - 0.2), ez + pz * (WALK_W - 0.2), 0))) continue;
          // a mapped footway running alongside: how far out is its centreline?
          let D = Infinity;
          for (let i = 0; i < _cw.length; i += 4) {
            const fx = _cw[i + 2] - _cw[i], fz = _cw[i + 3] - _cw[i + 1], L2 = fx * fx + fz * fz || 1e-9;
            let t = ((ex - _cw[i]) * fx + (ez - _cw[i + 1]) * fz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const cx = _cw[i] + fx * t - ex, cz = _cw[i + 1] + fz * t - ez;
            if (Math.abs(cx * dx + cz * dz) > 3) continue;
            const lat = cx * px + cz * pz;
            if (lat > -0.6 && lat < 6.5 && lat < D) D = lat;
          }
          if (D === Infinity || D <= 2.0) {
            vg.t[side][k] = 1;
            vg.w[side][k] = Math.round(Math.max(WALK_W, (D === Infinity ? 0 : D) + 0.3) * 10);
          } else { vg.t[side][k] = 2; vg.w[side][k] = Math.round((D + 0.2) * 10); }
        }
      }
      k = k1;
      run += L;
      yield;
      continue;
    }
    k = k1;
    run += L;
  }
  // one station of a different mind between two that agree is noise from a
  // footway vertex, not a change in the street
  for (let side = 0; side < 2; side++) {
    const T = vg.t[side], W = vg.w[side];
    for (let k = 1; k < n - 1; k++) {
      if (T[k] && T[k - 1] && T[k + 1] && T[k - 1] === T[k + 1] && T[k] !== T[k - 1]) {
        T[k] = T[k - 1]; W[k] = Math.round((W[k - 1] + W[k + 1]) / 2);
      }
    }
  }
  // A way cut at a tile seam ENDS where its other half begins, and the node
  // count that flagged a dead end (geo.indexJunctions) only ever saw this
  // tile's half: the kerb was carried round the end of a through street, across
  // its own carriageway. Asked again here, of the whole chunk index.
  if (r._de0 && meetsRoad(city, r, r.p[0][0], r.p[0][1])) r._de0 = 0;
  if (r._de1 && meetsRoad(city, r, r.p[r.p.length - 1][0], r.p[r.p.length - 1][1])) r._de1 = 0;
  return vg;
}

/** Does (x, z) lie on the carriageway of any OTHER drivable way, bridge or not? */
function meetsRoad(city, self, x, z) {
  const cell = city.chunkIndex.get(Math.floor(x / CH) + ',' + Math.floor(z / CH));
  if (!cell) return false;
  for (const o of cell.roads) {
    if (!o.d || o === self || !o.p) continue;
    const half = (o.w ?? 3) / 2, bb = bbOf(o);
    if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
    for (let i = 0; i < o.p.length - 1; i++) {
      if (ptSeg(x, z, o.p[i][0], o.p[i][1], o.p[i + 1][0], o.p[i + 1][1]) < half) return true;
    }
  }
  return false;
}

// ---- first use: the kerb and the control of one junction ------------------------
/**
 * Finish a junction node or cluster: which outline points have another
 * carriageway where their kerb would stand, which legs are signed or
 * signalled, and the kerb along each piece. `verge(r)` is the caller's
 * ensure-and-read for a way (geo.streetOf).
 */
export function finishJunction(city, o, verge) {
  if (o._kd) return;
  o._kd = 1;
  const legs = o._legs ?? [];
  for (const lg of legs) verge(lg.r);
  const under = (x, z, nx, nz, r) => coveredBy(city, x + nx * 0.7, z + nz * 0.7, r, 0.05)
    || coveredBy(city, x + nx * (WALK_W - 0.2), z + nz * (WALK_W - 0.2), r, 0);
  for (const pc of o._edge ?? []) {
    const p = pc.p;
    for (let i = 0; i < p.length; i += 8) {
      if (under(p[i], p[i + 1], p[i + 2], p[i + 3], legs[p[i + 5]]?.r)) p[i + 4] = 1;
    }
    // Between a point with a carriageway under it and a neighbour without, the
    // band tapers to nothing, and the edge of that carriageway is somewhere in
    // between: up to a whole step of 12 cm kerb lay ON the side street, out to
    // its wheel tracks. So the edge itself is found (bisected to a few
    // centimetres) and gets a point of its own, and the taper ends there.
    if (!pc.k) continue;
    let out = null;
    for (let i = 0; i + 8 < p.length; i += 8) {
      const j = i + 8;
      if (out) for (let q = 0; q < 8; q++) out.push(p[i + q]);
      if (!p[i + 4] === !p[j + 4]) continue;
      const u = p[i + 4] ? j : i, c = p[i + 4] ? i : j, r = legs[p[u + 5]]?.r;
      let lo = 0, hi = 1;                          // from the clear point to the covered one
      for (let k = 0; k < 5; k++) {
        const t = (lo + hi) / 2;
        if (under(p[u] + (p[c] - p[u]) * t, p[u + 1] + (p[c + 1] - p[u + 1]) * t,
          p[u + 2] + (p[c + 2] - p[u + 2]) * t, p[u + 3] + (p[c + 3] - p[u + 3]) * t, r)) hi = t; else lo = t;
      }
      if (hi > 0.97) continue;                     // the covered point IS the edge, near enough
      out ??= p.slice(0, j);
      out.push(p[u] + (p[c] - p[u]) * hi, p[u + 1] + (p[c + 1] - p[u + 1]) * hi,
        p[u + 2] + (p[c + 2] - p[u + 2]) * hi, p[u + 3] + (p[c + 3] - p[u + 3]) * hi,
        1, p[u + 5], p[u + 6], p[u + 7]);
    }
    if (out) { for (let q = p.length - 8; q < p.length; q++) out.push(p[q]); pc.p = out; }
  }
  // signs and signals within reach, from the cells round the node
  const reach = (o.padR ?? 10) + 30;
  const legAt = (x, z) => {
    let best = null, bestD = 6;
    for (const lg of legs) {
      const ax = x - lg.nx, az = z - lg.nz;
      const al = ax * lg.ux + az * lg.uz;
      // nearer this end of the way than the other: the junction at the far
      // end has the same sign in reach and it is not theirs
      if (al < -1 || al > Math.min(28, lg.avail / 2 + 2)) continue;
      const lat = Math.abs(ax * -lg.uz + az * lg.ux);
      if (lat < lg.hw + 0.8 && lat < bestD) { bestD = lat; best = lg; }
    }
    return best;
  };
  for (let cx = Math.floor((o.x - reach) / CH); cx <= Math.floor((o.x + reach) / CH); cx++) {
    for (let cz = Math.floor((o.z - reach) / CH); cz <= Math.floor((o.z + reach) / CH); cz++) {
      for (const sg of city.chunkIndex.get(cx + ',' + cz)?.signs ?? []) {
        if (sg.k !== 'give_way' && sg.k !== 'stop') continue;
        const lg = legAt(sg.p[0][0], sg.p[0][1]);
        if (lg && lg.ctl !== 'signal') lg.ctl = sg.k === 'stop' ? 'stop' : 'give';
      }
    }
  }
  const onNode = (o.members ? o.padR : 4) + 1;
  for (const s of city.signals ?? []) {
    const d2 = (s[0] - o.x) ** 2 + (s[1] - o.z) ** 2;
    if (d2 > reach * reach) continue;
    // a signal ON the node governs every approach; one set back on an approach
    // governs that approach
    if (d2 < onNode * onNode) { for (const lg of legs) lg.ctl = 'signal'; o._sig = 1; continue; }
    const lg = legAt(s[0], s[1]);
    if (lg) lg.ctl = 'signal';
  }
  // unsigned, but plainly a side road joining a bigger one: Czech practice is
  // a give-way triangle on the minor arm
  let top = 0, main = 0;
  for (const lg of legs) top = Math.max(top, roadRank(lg.r));
  for (const lg of legs) if (roadRank(lg.r) === top) main++;
  if (top >= 3 && main >= 2) {
    for (const lg of legs) {
      if (!lg.ctl && roadRank(lg.r) >= 2 && roadRank(lg.r) < top && lg.hw >= 2.4) lg.ctl = 'give';
    }
  }
  kerbSpec(o);
}

/**
 * Give every outline piece of a junction its kerb: per point, the band width,
 * surface and drop read off the verge of the way that point runs along.
 */
export function kerbSpec(o) {
  for (const pc of o._edge ?? []) {
    const m = pc.p.length / 8;
    const w = new Array(m), t = new Array(m), d = new Array(m);
    let any = false;
    for (let i = 0; i < m; i++) {
      const lg = o._legs[pc.p[i * 8 + 5]];
      const v = lg ? vergeAt(lg.r, pc.p[i * 8 + 6], pc.p[i * 8 + 7]) : _vs;
      const on = pc.k && lg && v.u && !pc.p[i * 8 + 4];
      // where the ribbon band is absent for a reason of its own (another
      // carriageway under it), the corner still wants a pavement to wrap it
      w[i] = on ? (v.w > 0.3 ? v.w : WALK_W) : 0;
      t[i] = on ? (v.w > 0.3 ? v.t : 1) : 0;
      d[i] = on ? v.drop : 0;
      if (on) any = true;
    }
    // a corner turns on PAVING: a strip of lawn squeezed round a kerb radius is
    // not something anybody builds
    if (any && pc.arc) for (let i = 0; i < m; i++) if (t[i] === 2) t[i] = 1;
    pc.w = w; pc.t = t; pc.d = d; pc.any = any ? 1 : 0;
  }
}

// ---- junction outlines ----------------------------------------------------------

const TAN_MAX = 13;     // m a fillet may run back along an arm
const ARM_MAX = 26;     // m from the node a mouth may sit

/**
 * The ordered outline of a junction from its legs.
 *
 * A leg is one direction a road leaves the junction in: { nx, nz, ux, uz, hw,
 * pad, avail, r, s, dir }. Between each neighbouring pair of legs the two kerb
 * lines meet in a corner, and the corner is rounded on a radius chosen by the
 * lesser road and clamped to the room there is. The asphalt gains the sliver
 * between the sharp corner and the arc; the pavement follows the arc.
 *
 * Writes lg.m (how far out along the leg the mouth sits) and returns
 * { ring, edge } or null when the outline would not be a simple polygon, in
 * which case the caller falls back to the convex hull it always had.
 */
export function junctionOutline(legs, cx, cz) {
  const n = legs.length;
  if (n < 2) return null;
  for (const lg of legs) {
    lg.ang = Math.atan2(lg.nz + lg.uz * lg.pad - cz, lg.nx + lg.ux * lg.pad - cx);
    lg.m = lg.pad;
  }
  legs.sort((a, b) => a.ang - b.ang);
  const corners = new Array(n);
  for (let i = 0; i < n; i++) {
    const A = legs[i], B = legs[(i + 1) % n];
    // A's kerb line on the side facing B (its +90 degree side), B's facing A
    const eax = A.nx - A.uz * A.hw, eaz = A.nz + A.ux * A.hw;
    const ebx = B.nx + B.uz * B.hw, ebz = B.nz - B.ux * B.hw;
    const den = A.ux * B.uz - A.uz * B.ux;                 // sin of the turn A -> B
    const dot = A.ux * B.ux + A.uz * B.uz;
    const wx = ebx - eax, wz = ebz - eaz;
    const c = { kind: 'chord', kerb: dot < 0 ? 1 : 0, a: 0, b: 0, t: 0, eax, eaz, ebx, ebz };
    if (Math.abs(den) > 0.26) {
      const a = (wx * B.uz - wz * B.ux) / den, b = (wx * A.uz - wz * A.ux) / den;
      if (den > 0 && a > -A.hw * 1.5 && b > -B.hw * 1.5 && a < ARM_MAX - 2 && b < ARM_MAX - 2) {
        // a pavement corner between two arms: round it
        const R0 = Math.min(RADIUS[A.r.t] ?? 5, RADIUS[B.r.t] ?? 5);
        const half = Math.acos(Math.max(-1, Math.min(1, dot))) / 2;   // half the wedge angle
        const tan = Math.tan(half) || 1e-6;
        let t = R0 / tan;
        t = Math.min(t, TAN_MAX, A.avail * 0.45 - a, B.avail * 0.45 - b,
          ARM_MAX - a, ARM_MAX - b);
        c.a = a; c.b = b; c.cx = eax + A.ux * a; c.cz = eaz + A.uz * a;
        if (t >= 0.5) {
          c.kind = 'arc'; c.t = t; c.R = t * tan; c.kerb = 1;
          const bx = A.ux + B.ux, bz = A.uz + B.uz, bl = Math.hypot(bx, bz) || 1;
          const od = c.R / Math.sin(half);
          c.ox = c.cx + (bx / bl) * od; c.oz = c.cz + (bz / bl) * od;
        } else { c.kind = 'sharp'; c.kerb = 1; }
        A.m = Math.max(A.m, a + c.t); B.m = Math.max(B.m, b + c.t);
      } else if (den < 0 && Math.abs(a) < 3 * A.hw + 2 && Math.abs(b) < 3 * B.hw + 2) {
        // the outside of a bend: the two kerb lines meet in a point
        c.kind = 'sharp'; c.kerb = 1; c.a = a; c.b = b;
        c.cx = eax + A.ux * a; c.cz = eaz + A.uz * a;
        A.m = Math.max(A.m, a + 0.3); B.m = Math.max(B.m, b + 0.3);
      }
    }
    corners[i] = c;
  }
  for (const lg of legs) lg.m = Math.min(Math.max(lg.m, lg.pad), Math.max(lg.pad, ARM_MAX));
  // Two legs that leave side by side and are still lying over each other at
  // their mouths (the two carriageways of a split, a slip road peeling off at
  // ten degrees) are one mouth: the outline runs round the outside of both and
  // has no corner between them. Without this the ring doubled back on itself.
  for (let i = 0; i < n; i++) {
    const A = legs[i], B = legs[(i + 1) % n], c = corners[i];
    if (c.kind !== 'chord' || n < 3) continue;
    const amx = c.eax + A.ux * A.m, amz = c.eaz + A.uz * A.m;     // A's mouth corner on this side
    const bmx = c.ebx + B.ux * B.m, bmz = c.ebz + B.uz * B.m;     // B's
    const inA = (bmx - A.nx) * -A.uz + (bmz - A.nz) * A.ux < A.hw + 0.05;
    const inB = (amx - B.nx) * B.uz + (amz - B.nz) * -B.ux < B.hw + 0.05;
    if (A.ux * B.ux + A.uz * B.uz > 0.5 && inA && inB) c.kind = 'merge';
  }
  const ring = [], edge = [];
  for (let i = 0; i < n; i++) {
    const A = legs[i], j = (i + 1) % n, B = legs[j], c = corners[i];
    if (c.kind === 'merge') continue;
    // verge side index of each kerb line, in its OWN way's frame (see vergeAt)
    const sa = A.dir > 0 ? 0 : 1, sb = B.dir > 0 ? 1 : 0;
    const nax = -A.uz, naz = A.ux, nbx = B.uz, nbz = -B.ux;   // outward of each kerb line
    const pts = [];
    const put = (x, z, nx, nz, leg, ax) => {
      const lg = legs[leg];
      pts.push(x, z, nx, nz, 0, leg, lg.s + lg.dir * ax, leg === i ? sa : sb);
    };
    put(c.eax + A.ux * A.m, c.eaz + A.uz * A.m, nax, naz, i, A.m);
    if (c.kind === 'arc') {
      if (A.m - (c.a + c.t) > 0.05) put(c.cx + A.ux * c.t, c.cz + A.uz * c.t, nax, naz, i, c.a + c.t);
      const tax = c.cx + A.ux * c.t - c.ox, taz = c.cz + A.uz * c.t - c.oz;
      const tbx = c.cx + B.ux * c.t - c.ox, tbz = c.cz + B.uz * c.t - c.oz;
      const a0 = Math.atan2(taz, tax);
      let da = Math.atan2(tbz, tbx) - a0;
      while (da > Math.PI) da -= 2 * Math.PI;
      while (da < -Math.PI) da += 2 * Math.PI;
      const steps = Math.max(2, Math.min(10, Math.ceil(Math.abs(da) / 0.22)));
      // k = 0 is the tangent point on A, which is already in (as the mouth
      // itself or as the point just pushed)
      for (let k = 1; k <= steps; k++) {
        if (k === steps && B.m - (c.b + c.t) <= 0.05) break;   // the mouth point itself follows
        const ang = a0 + da * (k / steps);
        const x = c.ox + Math.cos(ang) * c.R, z = c.oz + Math.sin(ang) * c.R;
        const first = k * 2 <= steps;
        const lg = first ? A : B;
        const ax = (x - lg.nx) * lg.ux + (z - lg.nz) * lg.uz;
        put(x, z, -Math.cos(ang), -Math.sin(ang), first ? i : j, ax);
      }
    } else if (c.kind === 'sharp') {
      let mx = nax + nbx, mz = naz + nbz;
      const ml = Math.hypot(mx, mz) || 1;
      mx /= ml; mz /= ml;
      const sc = 1 / Math.max(0.5, mx * nax + mz * naz);
      put(c.cx, c.cz, mx * sc, mz * sc, i, c.a);
    }
    put(c.ebx + B.ux * B.m, c.ebz + B.uz * B.m, nbx, nbz, j, B.m);
    const m = pts.length / 8;
    for (let k = 0; k < m; k++) {
      const x = pts[k * 8], z = pts[k * 8 + 1];
      ring.push([x, z]);

    }
    edge.push({ k: c.kerb, arc: c.kind === 'arc' ? 1 : 0, p: c.kerb ? splitRuns(pts, legs) : pts });
  }
  if (!simpleRing(ring)) return null;
  return { ring, edge };
}

// A kerb piece is a few points, and between two of them the band is one quad.
// finishJunction asks "is another carriageway here?" at the POINTS only, so a
// straight run of 20 or 70 m (the far kerb of a T, the side of a cluster) was
// asked at its two ends and laid kerb and paving straight across the mouth of
// every side street that joins between them: a 12 cm step for each car turning
// in. So a long straight run gets a point every KERB_STEP, the spacing a way's
// own verge is worked out at, and the test that already existed finds the
// mouth. The first half of a run reads the verge of the leg it starts on, the
// second of the leg it ends on, as the points of a corner arc do. Only the kerb
// gets these points: the outline polygon is the same without them.
const KERB_STEP = 2.5;
function splitRuns(pts, legs) {
  const m = pts.length / 8;
  let out = null;
  for (let k = 0; k < m - 1; k++) {
    const a = k * 8, b = a + 8;
    const L = Math.hypot(pts[b] - pts[a], pts[b + 1] - pts[a + 1]);
    const n = L > KERB_STEP + 0.5 ? Math.ceil(L / KERB_STEP) : 1;
    if (n > 1 && !out) out = pts.slice(0, b);
    else if (out) for (let q = 0; q < 8; q++) out.push(pts[a + q]);
    for (let q = 1; q < n; q++) {
      const t = q / n, e = t <= 0.5 ? a : b, lg = legs[pts[e + 5]];
      const x = pts[a] + (pts[b] - pts[a]) * t, z = pts[a + 1] + (pts[b + 1] - pts[a + 1]) * t;
      out.push(x, z, pts[a + 2] + (pts[b + 2] - pts[a + 2]) * t, pts[a + 3] + (pts[b + 3] - pts[a + 3]) * t,
        0, pts[e + 5], lg.s + lg.dir * ((x - lg.nx) * lg.ux + (z - lg.nz) * lg.uz), pts[e + 7]);
    }
  }
  if (!out) return pts;
  for (let q = 0; q < 8; q++) out.push(pts[(m - 1) * 8 + q]);
  return out;
}

/** A polygon worth filling: at least a triangle, some area, no edge crossing another. */
export function simpleRing(ring) {
  const n = ring.length;
  if (n < 3) return false;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    area += a[0] * b[1] - b[0] * a[1];
    if (!Number.isFinite(a[0]) || !Number.isFinite(a[1])) return false;
  }
  if (Math.abs(area) < 2) return false;
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
      if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9))
        && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) return false;
    }
  }
  return true;
}

function inTri(x, z, ax, az, bx, bz, cx, cz) {
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * Where (x, z) stands on the kerb band around a junction outline: the lift above
 * the pad there, or -1 when it is not on the band. `o` is a node or a cluster.
 */
export function cornerLift(o, x, z) {
  const edge = o._edge;
  if (!edge) return -1;
  for (const pc of edge) {
    if (!pc.any) continue;
    const p = pc.p, m = p.length / 8;
    for (let i = 0; i < m - 1; i++) {
      const w0 = pc.w[i], w1 = pc.w[i + 1];
      if (w0 <= 0 && w1 <= 0) continue;
      const ax = p[i * 8], az = p[i * 8 + 1], bx = p[i * 8 + 8], bz = p[i * 8 + 9];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
      if (L2 < 1e-9) continue;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const nx = p[i * 8 + 2] + (p[i * 8 + 10] - p[i * 8 + 2]) * t;
      const nz = p[i * 8 + 3] + (p[i * 8 + 11] - p[i * 8 + 3]) * t;
      const out = (x - (ax + ex * t)) * nx + (z - (az + ez * t)) * nz;
      const w = w0 + (w1 - w0) * t;
      // On the band as it was DRAWN (meshes.kerbRun): the quad between the
      // kerb line and each end pushed out along its own normal. Where the two
      // normals differ (a straight cut across a corner between two arms) that
      // quad is a skewed wedge metres wide, and a test of "abreast of the kerb
      // line" stood nobody on most of it: feet sank a hand deep into the band.
      const cx = bx + p[i * 8 + 10] * w1, cz = bz + p[i * 8 + 11] * w1;
      const dx = ax + p[i * 8 + 2] * w0, dz = az + p[i * 8 + 3] * w0;
      if (!inTri(x, z, ax, az, bx, bz, cx, cz) && !inTri(x, z, ax, az, cx, cz, dx, dz)) continue;
      return vergeLift(w, pc.d[i] + (pc.d[i + 1] - pc.d[i]) * t, Math.max(0, out));
    }
  }
  return -1;
}
