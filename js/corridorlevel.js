// ---- the corridor level a member way reads (round 10) ------------------------
// geo.levelWayBase asks this first for every way in scope (corridorgeom.inScope:
// heavy rail, motorway, trunk, primary and their links, bridges included). The
// answer is the way's `_prof` in today's shape, resampled from ONE profile laid
// along its corridor's chainage, so roadGradeY / railGradeY and every reader
// behind them follow with no change of API.
//
// DETERMINISM. Each way's line is worked out over a fixed WINDOW round itself
// (its box plus `reach`), from the data in that window sorted by id and the
// PRISTINE survey (terrain._raw where the earthworks have moved the grid: a
// line measured after the bake read the bake, and came out by load order).
// It is final (`ready`) once every data tile the window touches is indexed or
// absent from the manifest and every height tile it reads has answered, a 404
// included (the hole round Kolín settles too, on the same fallback everywhere).
// Before that it is a guess stamped with the terrain load counter and the
// index's tile counter, retired when either moves.
//
// Nothing is left on the way but `_prof` (which travels to the mesh worker
// already, js/chunkspec.js): every memo here lives in a WeakMap.
import { CHUNK } from './config.js';
import { inScope, isRail, outranks, geomOf, pointOn, endIndex, buildAxis, projectAxis,
  axisPoint, membersOf, parallel } from './corridorgeom.js';
import { gaussBlur, quantile, fillGaps, fitProfile, applyFloors, applyPins } from './corridorfit.js';

const DS = 2;                 // m between corridor bins (and member stations)
const GRADE_DS = 2;           // geo.js GRADE_DS: the way's own stations
// Rail: rails.md 4.1, the prototype on the Karlín bundle (max 19.9 per mille,
// R_v >= 2 879 m). Roads: roads.md 3.1, bounds by class below.
const RAIL = { reach: 600, lat: 50, sigma: 20, passes: 24, final: 40, probe: 6, base: 0.5,
  hw: 1.5, floorLift: 0.3, extD: 12, cut: 4, fill: 4, grade: 0.025 };
const ROAD = { reach: 450, lat: 40, sigma: 8, passes: 24, final: 16, probe: 8, base: 0.6,
  floorLift: 0.2, extD: 16 };
const ROAD_CLASS = {
  motorway: { cut: 1.5, fill: 4, grade: 0.04 },
  trunk: { cut: 1.2, fill: 3.5, grade: 0.06 },
  primary: { cut: 0.6, fill: 2.5, grade: 0.08 },
  link: { cut: 0.8, fill: 3, grade: 0.08 },
};
const classOf = (w) => (w.t.endsWith('_link') ? ROAD_CLASS.link : ROAD_CLASS[w.t] ?? ROAD_CLASS.primary);
const BRIDGE_GRADE = 0.06;    // geo.js: a bridge approach climbs at this
const OVL_APART = 1.5;        // geo.js: an overlap this far apart in height is two levels
const CEIL_LIFT = 0.3;        // m: under a bridge crossing over, the line keeps near the survey
const curveR = (v) => { const ms = Math.max(30, v || 50) / 3.6; return Math.max(250, ms * ms / 0.5); };

// ---- the survey, pristine ----------------------------------------------------
const _view = new WeakMap();
/** A Terrain-like view that reads the survey as it was before the earthworks moved it. */
export function surveyOf(terrain) {
  if (!terrain || !terrain.grids) return terrain;
  let v = _view.get(terrain);
  if (v) return v;
  const grids = {
    get: (k) => terrain._raw?.get(k) ?? terrain.grids.get(k),
    has: (k) => terrain.grids.has(k),
  };
  v = Object.create(terrain, { grids: { value: grids }, missed: { value: false, writable: true },
    _missTiles: { value: null, writable: true } });
  _view.set(terrain, v);
  return v;
}
/** Has the height tile under (x, z) answered (a map, or a 404)? */
function settled(terrain, x, z) {
  if (terrain.grids && terrain.tile) return terrain.grids.has(Math.floor(x / terrain.tile) + ',' + Math.floor(z / terrain.tile));
  return terrain.ready ? terrain.ready(x, z) : true;
}

// ---- the window --------------------------------------------------------------
const _cell = new WeakMap();
/** In-scope ways, crossing decks and retaining walls of one index cell, memoised by its contents. */
function cellLists(cell) {
  const nr = cell.roads?.length ?? 0, nl = cell.rails?.length ?? 0, nb = cell.barriers?.length ?? 0;
  let c = _cell.get(cell);
  if (c && c.nr === nr && c.nl === nl && c.nb === nb && c.roads === cell.roads && c.rails === cell.rails && c.barriers === cell.barriers) return c;
  c = { nr, nl, nb, roads: cell.roads, rails: cell.rails, barriers: cell.barriers, road: [], rail: [], decks: [], walls: [] };
  for (const r of cell.roads ?? []) {
    if (!r.p || r.p.length < 2) continue;
    if (inScope(r)) c.road.push(r);
    if (r.br) c.decks.push(r);
  }
  for (const r of cell.rails ?? []) {
    if (!r.p || r.p.length < 2) continue;
    if (inScope(r)) c.rail.push(r);
    if (r.br) c.decks.push(r);
  }
  for (const b of cell.barriers ?? []) if (b.k === 'retaining' && b.p?.length > 1) c.walls.push(b);
  _cell.set(cell, c);
  return c;
}
function gather(city, bb, rail) {
  const ways = new Set(), decks = new Set(), walls = new Set();
  for (let i = Math.floor(bb[0] / CHUNK); i <= Math.floor(bb[2] / CHUNK); i++) {
    for (let j = Math.floor(bb[1] / CHUNK); j <= Math.floor(bb[3] / CHUNK); j++) {
      const cell = city.chunkIndex.get(i + ',' + j);
      if (!cell) continue;
      const c = cellLists(cell);
      for (const w of rail ? c.rail : c.road) ways.add(w);
      for (const w of c.decks) decks.add(w);
      for (const w of c.walls) walls.add(w);
    }
  }
  const byId = (a, b) => (a._id ?? 0) - (b._id ?? 0);
  return { ways: [...ways].sort(byId), decks: [...decks].sort(byId), walls: [...walls] };
}
const _tileBy = new WeakMap();
/** Is every data tile the box touches indexed (or not in the manifest at all)? */
function windowIndexed(city, bb) {
  const tiles = city.manifestTiles, T = city.tile;
  if (!tiles || !T) return true;
  let by = _tileBy.get(tiles);
  if (!by) { by = new Map(); for (const t of tiles) by.set(t.tx + ',' + t.tz, t); _tileBy.set(tiles, by); }
  for (let tx = Math.floor(bb[0] / T); tx <= Math.floor(bb[2] / T); tx++) {
    for (let tz = Math.floor(bb[1] / T); tz <= Math.floor(bb[3] / T); tz++) {
      const t = by.get(tx + ',' + tz);
      if (t && t.state !== 2 && t.state !== 3) return false;
    }
  }
  return true;
}

// ---- a member's ground, sampled once -----------------------------------------
const _samp = new WeakMap();
// The terrain renderer extends the nearest available tile into an unmapped
// area. Its edge can be on another hill. Never fit railway grades or bridge
// clearance to that visual fallback.
function measured(terrain, x, z) {
  return !terrain.ready || terrain.ready(x, z);
}

function samplesOf(w, terrain, sv) {
  let c = _samp.get(w);
  const loads = terrain._loads ?? 0;
  if (c && c.terrain === terrain && c.p === w.p && (c.settled || c.loads === loads)) return c;
  const g = geomOf(w), n = Math.max(2, Math.ceil(g.L / DS) + 1), ds = g.L / (n - 1);
  const hw = isRail(w) ? RAIL.hw : Math.max(1, (w.w ?? 6) / 2);
  const x = new Float64Array(n), z = new Float64Array(n), h = new Float64Array(3 * n);
  let ok = true;
  for (let i = 0; i < n; i++) {
    const P = pointOn(w, i * ds);
    x[i] = P.x; z[i] = P.z;
    if (ok && !settled(terrain, P.x, P.z)) ok = false;
    if (!measured(terrain, P.x, P.z)) {
      h[3 * i] = NaN;
      continue;
    }
    h[3 * i] = sv.heightAt(P.x, P.z);
    const leftX = P.x + P.tz * hw, leftZ = P.z - P.tx * hw;
    const rightX = P.x - P.tz * hw, rightZ = P.z + P.tx * hw;
    if (!settled(terrain, leftX, leftZ) || !settled(terrain, rightX, rightZ)) ok = false;
    h[3 * i + 1] = measured(terrain, leftX, leftZ) ? sv.heightAt(leftX, leftZ) : h[3 * i];
    h[3 * i + 2] = measured(terrain, rightX, rightZ) ? sv.heightAt(rightX, rightZ) : h[3 * i];
  }
  c = { terrain, p: w.p, loads, settled: ok, n, ds, x, z, h, hw };
  _samp.set(w, c);
  return c;
}

// segments crossing (endpoints touching does not count)
function cross(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den, u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return [ax + rx * t, az + rz * t];
}

// ---- the corridor of one way: its axis, members and the fitted line -----------
const _core = new WeakMap();
function core(w, terrain, city, fl) {
  let c = _core.get(w);
  const loads = terrain._loads ?? 0;
  if (c && c.terrain === terrain && c.p === w.p && (c.ready || (c.loads === loads && c.fl === fl))) return c.info;
  const info = computeCore(w, terrain, city);
  _core.set(w, { terrain, p: w.p, loads, fl, ready: !!info?.ready, info });
  return info;
}

function computeCore(w, terrain, city) {
  const rail = isRail(w), K = rail ? RAIL : ROAD;
  const g = geomOf(w);
  const bb = [g.bb[0] - K.reach, g.bb[1] - K.reach, g.bb[2] + K.reach, g.bb[3] + K.reach];
  const win = gather(city, bb, rail);
  if (!win.ways.includes(w)) win.ways.push(w);
  const ends = endIndex(win.ways);
  const ax = buildAxis(ends, w, K.reach, win.ways, K.extD);
  if (!(ax.L > 2 * DS)) return null;
  const members = membersOf(w, win.ways, ends, ax, K.lat);
  const sv = surveyOf(terrain);
  let ready = windowIndexed(city, bb);

  const nb = Math.floor(ax.L / DS) + 1;
  const inner = Array.from({ length: nb }, () => null);
  const dmin = new Float64Array(nb).fill(Infinity), dmax = new Float64Array(nb).fill(-Infinity);
  const deck = new Float64Array(nb).fill(-Infinity);
  const cut = new Float64Array(nb).fill(NaN), fill = new Float64Array(nb).fill(NaN), grade = new Float64Array(nb).fill(NaN);
  const top = Array.from({ length: nb }, () => null);
  for (const m of members) {
    const S = samplesOf(m, terrain, sv);
    if (!S.settled) ready = false;
    const P = rail ? RAIL : classOf(m);
    let hint = -1;
    for (let i = 0; i < S.n; i++) {
      if (!Number.isFinite(S.h[3 * i])) continue;
      const q = m === ax.self.w ? { d: 0, s: ax.self.off + i * S.ds } : projectAxis(ax, S.x[i], S.z[i], hint);
      hint = q.i ?? -1;
      // (a projection is clamped to the axis: what lies past its ends is not on it)
      if (Math.abs(q.d) > K.lat || q.s <= 1e-6 || q.s >= ax.L - 1e-6) continue;
      const b = Math.min(nb - 1, Math.round(q.s / DS));
      if (m.br) { const f = S.h[3 * i] + K.floorLift; if (f > deck[b]) deck[b] = f; continue; }
      (inner[b] ??= []).push(S.h[3 * i], S.h[3 * i + 1], S.h[3 * i + 2]);
      if (q.d - S.hw < dmin[b]) dmin[b] = q.d - S.hw;
      if (q.d + S.hw > dmax[b]) dmax[b] = q.d + S.hw;
      // the bounds of the highest class present (rail: one set)
      if (!top[b] || outranks(m, top[b])) { top[b] = m; cut[b] = P.cut; fill[b] = P.fill; grade[b] = P.grade; }
    }
  }
  // ---- the target across the width ----
  // On an embankment the survey falls away on both sides and the 20 m grid
  // has rounded the crest down: a HIGH quantile is the real level. On a cross
  // slope the middle is (cut and fill balanced), in a cutting a low one. A
  // retaining wall between the corridor and a side means that side's ground
  // says nothing about the corridor (Karlín: walls both sides of the terrace).
  const T = new Float64Array(nb).fill(NaN), free = new Uint8Array(nb);
  const wallSeg = [];
  for (const b of win.walls) for (let i = 0; i < b.p.length - 1; i++) wallSeg.push(b.p[i][0], b.p[i][1], b.p[i + 1][0], b.p[i + 1][1]);
  const walled = (x0, z0, x1, z1) => {
    for (let k = 0; k < wallSeg.length; k += 4) {
      const a = wallSeg[k], b2 = wallSeg[k + 1], c2 = wallSeg[k + 2], d2 = wallSeg[k + 3];
      if (Math.max(a, c2) < Math.min(x0, x1) || Math.min(a, c2) > Math.max(x0, x1)
        || Math.max(b2, d2) < Math.min(z0, z1) || Math.min(b2, d2) > Math.max(z0, z1)) continue;
      if (cross(x0, z0, x1, z1, a, b2, c2, d2)) return true;
    }
    return false;
  };
  for (let b = 0; b < nb; b++) {
    const v = inner[b];
    if (!v) { free[b] = 1; continue; }
    const A = axisPoint(ax, b * DS), nx = A.tz, nz = -A.tx;
    const med = quantile(v, 0.5);
    const side = [];
    for (const [d0, d1] of [[dmax[b], dmax[b] + K.probe], [dmin[b], dmin[b] - K.probe]]) {
      const x0 = A.x + nx * d0, z0 = A.z + nz * d0, x1 = A.x + nx * d1, z1 = A.z + nz * d1;
      if (wallSeg.length && walled(x0, z0, x1, z1)) continue;
      if (ready && !settled(terrain, x1, z1)) ready = false;
      if (measured(terrain, x1, z1)) side.push(sv.heightAt(x1, z1));
    }
    let c = 0;
    if (side.length) {
      const mean = side.reduce((a, h) => a + h, 0) / side.length;
      const spread = side.length > 1 ? Math.abs(side[0] - side[1]) / 2 : 0;
      c = Math.max(-1, Math.min(1, (med - mean) / (spread + 0.5)));
    }
    const q = Math.max(0.15, Math.min(0.9, K.base + 0.35 * c));
    T[b] = quantile(v, q);
  }
  if (!fillGaps(T)) return null;              // nothing in the window stands on ground
  if (rail) { cut.fill(RAIL.cut); fill.fill(RAIL.fill); grade.fill(RAIL.grade); }
  else { fillGaps(cut); fillGaps(fill); fillGaps(grade); }
  gaussBlur(T, 2);                            // 4 m: the bins are sparse
  const Y = fitProfile(T, free, cut, fill, grade, DS, K);

  // ---- floors and ceilings ----
  const floors = [], ceilings = [];
  const gW = rail ? RAIL.grade : BRIDGE_GRADE, R = curveR(rail ? 120 : w.v);
  // the ground under a span (a deck slanting over a hill shoulder)
  for (let b = 0; b < nb; b++) if (deck[b] > -Infinity && free[b]) floors.push({ s: b * DS, y: deck[b], g: gW, R });
  // a road deck's headroom over what it crosses (geo.indexBridgeCrossings)
  for (const m of members) {
    if (!m.br || !m._cross) continue;
    for (const c of m._cross) {
      const q = projectAxis(ax, c.x, c.z);
      if (Math.abs(q.d) > K.lat || !measured(terrain, c.x, c.z)) continue;
      floors.push({ s: q.s, y: sv.heightAt(c.x, c.z) + c.clear, g: BRIDGE_GRADE, R: curveR(m.v) });
    }
  }
  // a bridge that is not ours crossing over a member on the ground: pass under it near the survey
  const mem = new Set(members);
  for (const d of win.decks) {
    if (mem.has(d)) continue;
    const gd = geomOf(d);
    for (const m of members) {
      if (m.br) continue;
      const gm = geomOf(m);
      if (gd.bb[0] > gm.bb[2] || gm.bb[0] > gd.bb[2] || gd.bb[1] > gm.bb[3] || gm.bb[1] > gd.bb[3]) continue;
      for (let i = 0; i < m.p.length - 1; i++) for (let k = 0; k < d.p.length - 1; k++) {
        const hit = cross(m.p[i][0], m.p[i][1], m.p[i + 1][0], m.p[i + 1][1], d.p[k][0], d.p[k][1], d.p[k + 1][0], d.p[k + 1][1]);
        if (!hit || !measured(terrain, hit[0], hit[1])) continue;
        const q = projectAxis(ax, hit[0], hit[1]);
        ceilings.push({ s: q.s, y: sv.heightAt(hit[0], hit[1]) + CEIL_LIFT, g: gW, R });
      }
    }
  }
  applyFloors(Y, DS, floors, ceilings, rail ? 2 : 1);
  return { ax, members, memberIds: new Set(members.map((m) => m._id)), Y, ready, rail };
}

// ---- what geo.js asks --------------------------------------------------------
const _out = new WeakMap();
const sampleY = (Y, s) => {
  const u = Math.max(0, Math.min(Y.length - 1, s / DS)), i = Math.min(Y.length - 2, Math.floor(u)), f = u - i;
  return Y[i] + (Y[i + 1] - Y[i]) * f;
};
/** Read a way-shaped profile at arclength `s` (linear). */
function profAt(p, s) {
  const u = Math.max(0, Math.min(p.n - 1, s / p.ds)), i = Math.min(p.n - 2, Math.floor(u)), f = u - i;
  return p.y[i] + (p.y[i + 1] - p.y[i]) * f;
}
// Where along the corridor each station of `w` lies, and whether all of it does.
function stationsOn(w, info, n, ds, total) {
  const L = geomOf(w).L, ax = info.ax, lat = info.rail ? RAIL.lat : ROAD.lat;
  const s = new Float64Array(n), P = new Array(n);
  let hint = -1;
  for (let i = 0; i < n; i++) {
    const a = Math.min(L, i * ds * (L / total));
    const p = pointOn(w, a);
    P[i] = p;
    if (ax.self.w === w) { s[i] = ax.self.off + a; continue; }
    const q = projectAxis(ax, p.x, p.z, hint);
    hint = q.i;
    if (Math.abs(q.d) > lat || ((q.s <= 1e-6 || q.s >= ax.L - 1e-6) && (i > 0 && i < n - 1))) return null;
    s[i] = q.s;
  }
  return { s, P };
}
function resample(w, info, Y, terrain, ready, loads, fl) {
  const total = w._len ?? geomOf(w).L;
  if (total < GRADE_DS * 2) return null;
  const n = Math.ceil(total / GRADE_DS) + 1, ds = total / (n - 1);
  const st = stationsOn(w, info, n, ds, total);
  if (!st) return null;
  const y = new Float32Array(n), ground = new Float32Array(n), gx = new Float32Array(n), gz = new Float32Array(n);
  const sv = surveyOf(terrain);
  for (let i = 0; i < n; i++) {
    const P = st.P[i];
    gx[i] = P.x; gz[i] = P.z;
    ground[i] = sv.heightAt(P.x, P.z);
    y[i] = sampleY(Y, st.s[i]);
  }
  return { terrain, ds, n, y, ground, gx, gz, total, ready, loads, fl, cor: true, rank: w.t };
}

// ---- whose window a way reads -------------------------------------------------
// Every way of a bundle levelled over its OWN window saw its own piece of the
// bundle and its own axis, and the tracks of one terrace still stood half a
// metre apart. So each way reads the corridor of its OWNER: follow "the
// longest parallel neighbour" (ties: the lower id) until nothing is longer.
// Neighbouring tracks and both carriageways end up with one owner, read ONE
// computed line, and agree exactly; it also does the work once per bundle.
// A pure function of the plan of the ways near it.
const _own = new WeakMap();
const longer = (a, b) => { const la = geomOf(a).L, lb = geomOf(b).L; return la > lb + 1e-6 || (Math.abs(la - lb) <= 1e-6 && a._id < b._id); };
function ownerOf(w, city, fl) {
  const c = _own.get(w);
  if (c && c.p === w.p && (c.ready || c.fl === fl)) return c.o;
  let cur = w, ready = true;
  const rail = isRail(w);
  for (let k = 0; k < 64; k++) {
    const g = geomOf(cur), bb = [g.bb[0] - 30, g.bb[1] - 30, g.bb[2] + 30, g.bb[3] + 30];
    if (!windowIndexed(city, bb)) ready = false;
    let best = cur;
    for (const o of gather(city, bb, rail).ways) if (o !== cur && longer(o, best) && parallel(cur, o)) best = o;
    if (best === cur) break;
    cur = best;
  }
  _own.set(w, { p: w.p, fl, ready, o: cur });
  return cur;
}

/** The base line of an in-scope way (no pins from other corridors), or null. */
function baseOf(w, terrain, city, fl) {
  const loads = terrain._loads ?? 0;
  let o = _out.get(w);
  if (o?.B && o.terrain === terrain && (o.B.ready || (o.loads === loads && o.fl === fl))) return o.B;
  const own = ownerOf(w, city, fl);
  let info = core(own, terrain, city, fl);
  let B = info ? resample(w, info, info.Y, terrain, info.ready, loads, fl) : null;
  // (a way leaving its owner's corridor somewhere along it reads its own)
  if (!B && own !== w) { info = core(w, terrain, city, fl); B = info ? resample(w, info, info.Y, terrain, info.ready, loads, fl) : null; }
  if (B && !_own.get(w)?.ready) B.ready = false;
  _out.set(w, o = { terrain, loads, fl, info, B, C: null });
  return B;
}

// The corridor's line with what outranks it laid in (one per computed corridor).
function constrained(info, terrain, city, fl) {
  const loads = terrain._loads ?? 0;
  const k = info._con;
  if (k && (k.ready || (k.loads === loads && k.fl === fl))) return k;
  const ax = info.ax, pins = [];
  let ready = info.ready;
  for (const m of info.members) {
    for (const pin of m._pins ?? []) {
      const node = pin.node;
      let hi = null, hs = 0, lift = 0;
      if (node._xing) { hi = node._xing; hs = node._xingS; lift = node._xingLift ?? 0; }
      else {
        for (const a of node.arms ?? []) {
          if (a.r === m || !inScope(a.r) || info.memberIds.has(a.r._id)) continue;
          if (!hi || outranks(a.r, hi)) { hi = a.r; hs = a.s ?? 0; }
        }
      }
      if (!hi || !outranks(hi, m) || info.memberIds.has(hi._id)) continue;
      const hb = baseOf(hi, terrain, city, fl);
      if (!hb) continue;
      if (!hb.ready) ready = false;
      const q = projectAxis(ax, node.x, node.z);
      if (Math.abs(q.d) > (info.rail ? RAIL.lat : ROAD.lat) || q.s <= 1e-6 || q.s >= ax.L - 1e-6) continue;
      const d = profAt(hb, hs) + lift - sampleY(info.Y, q.s);
      // an overlap in plan only, metres apart in height: two levels, not a junction (geo.js OVL_APART)
      if (node._ovl && Math.abs(d) > OVL_APART) continue;
      pins.push({ s: q.s, d });
    }
  }
  let Y = info.Y;
  if (pins.length) { Y = Float64Array.from(info.Y); applyPins(Y, DS, pins, (d) => Math.max(40, Math.abs(d) / 0.03)); }
  return (info._con = { Y, ready, loads, fl });
}

/**
 * The way's corridor line with what outranks it laid in: at every node of a
 * member where a HIGHER way of another corridor meets it (geo.junctionY's
 * order: rail, motorway, trunk, primary, links; speed, then id), the line is
 * bent onto that way's base line. One level only (a base never asks anyone),
 * so nothing can recurse and the answer does not depend on who asked first.
 * Null for a way out of scope or with no ground in its window.
 */
export function corridorLevel(w, terrain, city, fl) {
  if (!city || !terrain || !inScope(w)) return null;
  const B = baseOf(w, terrain, city, fl);
  if (!B) return null;
  const o = _out.get(w);
  const loads = terrain._loads ?? 0;
  if (o.C && (o.C.ready || (o.Cl === loads && o.Cf === fl))) return o.C;
  const k = constrained(o.info, terrain, city, fl);
  const ready = B.ready && k.ready;
  const C = k.Y === o.info.Y ? (ready === B.ready ? B : { ...B, ready })
    : resample(w, o.info, k.Y, terrain, ready, loads, fl);
  o.C = C; o.Cl = loads; o.Cf = fl;
  return C;
}

/** Are `a` and `b` read off one corridor line? */
export function sameCorridor(a, b, terrain, city, fl) {
  if (!inScope(a) || !inScope(b)) return false;
  if (!baseOf(a, terrain, city, fl)) return false;
  return _out.get(a).info.memberIds.has(b._id);
}
export { inScope, outranks };

/** The corridor `w` reads ({ax, members, Y, ready, rail}), for tests and probes. */
export function corridorInfo(w, terrain, city, fl) {
  if (!inScope(w) || !baseOf(w, terrain, city, fl)) return null;
  return _out.get(w).info;
}
