// ---- mwplan.js: where the D11's barriers stand, as plain data ----
// One planner for two readers: the chunk mesher draws what it returns
// (js/mwdress.js, on the main thread AND in the mesh worker) and city.collide
// pushes cars out of the very same lines (js/mwsolid.js), so what you see is
// what you hit. Pure: no three, no DOM, worker safe and node importable.
//
// WHAT A CZECH MOTORWAY HAS (and the tiles do not: OSM maps guard rails on
// 4 % of the D11, js/d11.js header):
//   · a concrete median barrier (betonové svodidlo, the step / New Jersey
//     profile) on the line midway between the two carriageways;
//   · where the carriageways part (the Prague six-lane end runs 17 to 20 m
//     apart, the interchanges further), no lone wall in a field but a steel
//     guard rail on each carriageway's left;
//   · a steel W-beam guard rail on posts beyond the right hard shoulder,
//     broken where a slip road's asphalt leaves or joins (that is the gore),
//     and not on a bridge, whose own parapet is the barrier there.
//
// THE PARTNER is read off js/d11.js's constant lines, not off whatever tiles
// are loaded: the opposite carriageway is often in a different tile (37 % of
// the D11 runs along the tz -2 / -3 border), and a plan that changed when that
// tile arrived would draw one barrier on the first build and another after
// the re-mesh, and differ between two co-op clients. The lines are the tile
// ways chained vertex for vertex, so the distance read here is the distance
// between the drawn ribbons.
//
// THE WALK is the lampSpots pattern (meshes.js): every D11 way that passes
// through the cell is walked from its own first vertex in STEP m stations, so
// the station positions are a property of the way, and a cell keeps the
// stations whose way-midpoint lies inside its rect (grown by `grow` for the
// collision memo). Two cells never draw the same piece and never leave a gap,
// whatever order their tiles arrived in.
//
// Heights are the road's own (geo.js roadGradeY / bridgeDeckHeight plus the
// ribbon's layer lift), never terrain.heightAt: an embanked D11 would have its
// barriers standing in the field below it.

import { d11Locate, d11Line, exitNear, onBridge, REST, D11_WORLD_END_KM } from './d11.js';
import { laneLayout } from './lanes.js';
import { roadGradeY, bridgeDeckHeight } from './geo.js';
import { roadRank } from './streets.js';

export const STEP = 4;               // m between stations (a guard rail's post spacing)
export const MEDIAN_MIN = 9;         // m: closer centrelines are a merge, not a median
export const MEDIAN_MAX = 15.5;      // m: wider is two carriageways with a grass median
export const RAIL_OUT = 0.6;         // m beyond the asphalt edge: where the rail stands
export const MEDIAN_H = 0.9;         // m, concrete barrier height
export const RAIL_H = 0.75;          // m, W-beam top
// a motorway bridge's edge: a concrete kerb (římsa) BRIDGE_KERB high whose
// inner face is BRIDGE_IN m in from the deck edge, the rail standing on it
export const BRIDGE_KERB = 0.2, BRIDGE_IN = 0.45;
export const STRIDE = 7;
export const DELIN_STEP = 48;        // m between delineators (směrové sloupky, ČSN: 50 m)             // numbers per station in a plan run
// the inner edge line's outer rim (lanes.js edgeL -3.875, line 0.25 m): the
// median surface runs from the barrier to just inside it
const FILL_IN = 4.02;
// LAYER_Y.road and meshes.js RANK_LIFT restated (config.js pulls three's
// colour tables in a way the planner does not need): the deck a ribbon draws
// is terrain-free y + ROAD_Y + rank * RANK_LIFT.
const ROAD_Y = 0.20, RANK_LIFT = 0.003;

// Kinds in a plan run. Append only (the mesher and the collider switch on them).
export const K_MEDIAN = 0;           // half a concrete barrier, centre on the median line
export const K_RAIL = 1;             // steel W-beam guard rail

const PARTNER = { E: 'W', W: 'E', S: 'N', N: 'S' };

// ---- the opposite carriageway: a bucket grid per line, built once a thread ----
const CELL = 32;
let GRIDS = null;
function grids() {
  if (GRIDS) return GRIDS;
  GRIDS = {};
  for (const cw of ['E', 'W', 'S', 'N']) {
    const q = d11Line(cw), g = new Map();
    for (let i = 0; i + 1 < q.n; i++) {
      const x0 = Math.floor((Math.min(q.x[i], q.x[i + 1]) - MEDIAN_MAX) / CELL);
      const x1 = Math.floor((Math.max(q.x[i], q.x[i + 1]) + MEDIAN_MAX) / CELL);
      const z0 = Math.floor((Math.min(q.z[i], q.z[i + 1]) - MEDIAN_MAX) / CELL);
      const z1 = Math.floor((Math.max(q.z[i], q.z[i + 1]) + MEDIAN_MAX) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = (cx + 32768) * 65536 + (cz + 32768);
        let a = g.get(k);
        if (!a) g.set(k, a = []);
        a.push(i);
      }
    }
    GRIDS[cw] = { q, g };
  }
  return GRIDS;
}

/**
 * Distance from (x, z) to the nearest point of carriageway line `cw`, or
 * Infinity beyond MEDIAN_MAX. Writes the point into out.x / out.z.
 */
export function lineDist(cw, x, z, out) {
  const G = grids()[cw];
  if (!G) return Infinity;
  const a = G.g.get((Math.floor(x / CELL) + 32768) * 65536 + (Math.floor(z / CELL) + 32768));
  if (!a) return Infinity;
  const q = G.q;
  let best = Infinity;
  for (let k = 0; k < a.length; k++) {
    const i = a[k], ax = q.x[i], az = q.z[i], ex = q.x[i + 1] - ax, ez = q.z[i + 1] - az;
    const L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const px = ax + ex * t, pz = az + ez * t, d = (px - x) ** 2 + (pz - z) ** 2;
    if (d < best) { best = d; out.x = px; out.z = pz; }
  }
  return Math.sqrt(best);
}

const _loc = { road: '', cw: '', km: 0, off: 0, dx: 0, dz: 0 };
/**
 * Which D11 / D35 carriageway a tile way IS ('E' | 'W' | 'S' | 'N'), or null:
 * a oneway motorway whose middle lies on a d11.js line (within 1.5 m) and runs
 * its way. Every other motorway in the world (the D0, D1, D10 in the Prague
 * box) keeps the town treatment.
 */
export function cwOf(f) {
  if (!f || f.t !== 'motorway' || !f.ow || !f.p || f.p.length < 2) return null;
  const i = (f.p.length - 1) >> 1, a = f.p[i], b = f.p[i + 1];
  const x = (a[0] + b[0]) / 2, z = (a[1] + b[1]) / 2;
  const l = d11Locate(x, z, _loc);
  if (!l || Math.abs(l.off) > 1.5) return null;
  const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez) || 1;
  if ((ex * l.dx + ez * l.dz) / L < 0.8) return null;
  if (l.road === 'D11' && l.km > D11_WORLD_END_KM) return null;
  return l.cw;
}

// is (x, z) on the asphalt of a drivable road other than `self` that is on the
// same level (an overpass above or a road under a viaduct does not count)
function onOther(cell, self, x, z, grow) {
  for (const o of cell.roads) {
    if (o === self || !o.d || !o.p || !!o.br !== !!self.br) continue;
    if (o.t === 'motorway' && cwOf(o) === cwOf(self)) continue;   // our own next piece
    const half = (o.w ?? 3) / 2 + grow, p = o.p;
    for (let k = 0; k < p.length - 1; k++) {
      const ax = p[k][0], az = p[k][1], bx = p[k + 1][0], bz = p[k + 1][1];
      if (x < Math.min(ax, bx) - half || x > Math.max(ax, bx) + half
        || z < Math.min(az, bz) - half || z > Math.max(az, bz) + half) continue;
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if ((x - ax - ex * t) ** 2 + (z - az - ez * t) ** 2 < half * half) return true;
    }
  }
  return false;
}

const FLARE = 16;                    // m over which a rail bends onto a bridge's kerb
const lenOf = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return L; };
// does a bridge piece of the same carriageway join way f at its vertex q
// (ending there when f starts there, starting there when f ends there)
function bridgeAt(cell, f, cw, q, atEnd) {
  for (const o of cell.roads) {
    if (o === f || !o.br || o.t !== 'motorway' || !o.p) continue;
    const e = atEnd ? o.p[0] : o.p[o.p.length - 1];
    if (Math.abs(e[0] - q[0]) < 0.15 && Math.abs(e[1] - q[1]) < 0.15 && cwOf(o) === cw) return true;
  }
  return false;
}
// the same question asked of js/d11.js's deck table: a cell lists a way only
// when the way's vertex box touches it, so the stations within FLARE of a deck
// often lie in a cell that does not list the deck, and that cell drew its rail
// unbent (a 0.5 m kink at the cell border by the Chlumec viaduct). The table
// is the same in every cell.
function deckAt(cw, q) {
  const l = d11Locate(q[0], q[1], _loc);
  return !!l && l.cw === cw && Math.abs(l.off) < 1.5 && onBridge(l.km, cw, 0.004);
}

/** The deck of way f at s m from its first vertex, as the ribbon draws it. */
export function deckY(f, s, x, z, terrain) {
  let y = f.br ? bridgeDeckHeight(f, s, terrain) : roadGradeY(f, s, terrain);
  if (y === null || y === undefined || !Number.isFinite(y)) y = terrain.heightAt(x, z);
  return y + ROAD_Y + roadRank(f) * RANK_LIFT;
}

const _q = { x: 0, z: 0 };

/**
 * The barrier plan of one chunk cell: an array of runs
 *   { k (K_MEDIAN | K_RAIL), id (the way's _id), ends, v: [x, z, y, nx, nz, w, s, ...] }
 * STRIDE 7: the barrier's line point, the deck height under it, the unit
 * normal pointing TOWARD the carriageway the barrier guards (a median run is
 * that carriageway's half), w (a median: the width of the median surface from
 * the barrier's centre to the inner edge line; a rail: 1 when it stands on a
 * bridge deck), and s, the station's metres along its way (delineators stand
 * every DELIN_STEP of it). Consecutive stations of a run are STEP apart along
 * their way, so the mesher draws a piece between every two. `sd` per run:
 * +1 for a rail on the carriageway's right, -1 on its left (and the median). `ends` per run:
 * bit 1 the run's first station starts a barrier (draw a terminal), bit 2 the
 * last one ends it. Plain numbers only: the plan crosses to the worker
 * nowhere (each thread plans for itself), but a plain plan is also what the
 * collision memo keeps.
 * grow: metres the cell rect is grown by (0 for drawing, more for collision).
 */
export function barrierPlan(cell, key, terrain, grow = 0) {
  const out = [];
  if (!cell?.roads || !terrain) return out;
  const c = key.indexOf(','), cx = +key.slice(0, c), cz = +key.slice(c + 1);
  const x0 = cx * 120 - grow, z0 = cz * 120 - grow, x1 = x0 + 120 + 2 * grow, z1 = z0 + 120 + 2 * grow;
  for (const f of cell.roads) {
    const cw = cwOf(f);
    if (!cw) continue;
    const lay = laneLayout(f);
    const rh = lay.ribbonHalf, pcw = PARTNER[cw];
    const p = f.p;
    // A rail leaving the ground for a bridge deck moves 1 m in (onto the
    // deck's kerb) and 0.2 m up: over the last FLARE m before a deck of the
    // same carriageway it bends there instead of jumping
    const len = f._len ?? lenOf(p);
    const br0 = !f.br && (deckAt(cw, p[0]) || bridgeAt(cell, f, cw, p[0], false));
    const br1 = !f.br && (deckAt(cw, p[p.length - 1]) || bridgeAt(cell, f, cw, p[p.length - 1], true));
    // the open runs of this way in this cell, one per kind and side
    let med = null, lrail = null, rrail = null;
    const flush = (r) => { if (r && r.v.length >= 2 * STRIDE) out.push(r); return null; };
    const push = (run, k, x, z, y, nx, nz, w, s, first, sd) => {
      if (!run) run = { k, id: f._id ?? 0, ends: first ? 1 : 0, sd, v: [] };
      run.v.push(x, z, y, nx, nz, w, s);
      return run;
    };
    let s0 = 0, iLast = -1;
    for (let i = 0; i < p.length - 1; i++) if (Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]) >= 1e-6) iLast = i;
    // the previous station's verdicts, so a run that begins after a gap in
    // the barrier (not merely at the cell border) is marked for a terminal
    // (unknown counts as standing: a way's first station continues the piece
    // before it, which ends at the same node)
    let pm = true, pl = true, pr = true;
    const close = (run, gap) => { if (run && gap) run.ends |= 2; return flush(run); };
    for (let i = 0; i < p.length - 1; i++) {
      const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az;
      const L = Math.hypot(ex, ez);
      if (L < 1e-6) continue;
      const dx = ex / L, dz = ez / L, lx = dz, lz = -dx;      // unit left of travel
      // segment bbox reject: nothing of it within reach of the (grown) cell
      const reach = MEDIAN_MAX;
      if (Math.max(ax, ax + ex) < x0 - reach || Math.min(ax, ax + ex) > x1 + reach
        || Math.max(az, az + ez) < z0 - reach || Math.min(az, az + ez) > z1 + reach) {
        med = flush(med); lrail = flush(lrail); rrail = flush(rrail);
        pm = pl = pr = true;
        s0 += L;
        continue;
      }
      // the stations of this segment on the way's own STEP grid, and on the
      // last segment the way's end node too: the next piece of the carriageway
      // starts its own grid there, so without it every joint of two ways (one
      // every few hundred metres) left a gap of up to STEP m in each barrier
      const sEnd = s0 + L, lastSeg = i === iLast;
      for (let s = Math.ceil(s0 / STEP - 1e-9) * STEP, atEnd = false; ; s += STEP) {
        if (s >= sEnd - 1e-6) {
          if (!lastSeg || atEnd || sEnd - (s - STEP) < 0.05) break;
          s = sEnd; atEnd = true;
        }
        const t = s - s0, x = ax + dx * t, z = az + dz * t;
        // a station belongs to the cell its piece's midpoint is in; the
        // station after a run's last piece closes that piece
        const h = lastSeg ? Math.min(STEP, sEnd - s) : STEP;
        const mx = x + dx * h / 2, mz = z + dz * h / 2;
        const mine = mx >= x0 && mx < x1 && mz >= z0 && mz < z1;
        // ---- the left side: median barrier, or a rail of our own ----
        const d = lineDist(pcw, x, z, _q);
        const side = (_q.x - x) * lx + (_q.z - z) * lz;          // + when the partner is left
        let wantM = false, wantL = false;
        if (d >= MEDIAN_MIN && d <= MEDIAN_MAX && side > 0.8 * d) wantM = true;
        else if (!(d < MEDIAN_MIN && side > 0)) wantL = true;
        // on a bridge the rails stand on the deck's edge kerb (meshes.js draws
        // the kerb), not in the air beyond it
        const fl = f.br ? 1 : Math.max(br0 ? 1 - s / FLARE : 0, br1 ? 1 - (len - s) / FLARE : 0, 0);
        const ro = rh + RAIL_OUT - (RAIL_OUT + BRIDGE_IN) * fl;
        const lxp = x + lx * ro, lzp = z + lz * ro;
        if (wantL && onOther(cell, f, lxp, lzp, 0.6)) wantL = false;
        // ---- the right side: the outer guard rail ----
        const rx = x - lx * ro, rz = z - lz * ro;
        const wantR = !onOther(cell, f, rx, rz, f.br ? 0.2 : 1.2);
        if (mine || med || lrail || rrail) {
          const y = deckY(f, s, x, z, terrain), ry = y + BRIDGE_KERB * fl;
          if (wantM) med = push(med, K_MEDIAN, (x + _q.x) / 2, (z + _q.z) / 2, y, -lx, -lz, d / 2 - FILL_IN, s, !pm, -1);
          else med = close(med, true);
          // w on a rail: 1 when its posts stand on a deck (never down to the ground)
          if (wantL) lrail = push(lrail, K_RAIL, lxp, lzp, ry, -lx, -lz, f.br ? 1 : 0, s, !pl, -1);
          else lrail = close(lrail, true);
          if (wantR) rrail = push(rrail, K_RAIL, rx, rz, ry, lx, lz, f.br ? 1 : 0, s, !pr, 1);
          else rrail = close(rrail, true);
          if (!mine) { med = flush(med); lrail = flush(lrail); rrail = flush(rrail); }
        }
        pm = wantM; pl = wantL; pr = wantR;
      }
      s0 += L;
    }
    // a run cut by the way's own end is no terminal: the next piece of the
    // carriageway carries it on from the same node
    med = flush(med); lrail = flush(lrail); rrail = flush(rrail);
  }
  return out;
}

// ---- light: a dark motorway with lit interchanges ----
// The D11 is unlit between its junctions (raw OSM lit=no on 245 km of it, and
// that is what a driver at night knows: a black ribbon, the delineators in the
// headlights, and a knot of orange light at each exit). The town lamp rule
// planted a street lamp every 34 m along all of it, about 7 000 of them.
export const LIT_R = 250;            // m round an exit's or a rest area's slip nodes

/** Is (x, z) inside a lit interchange or rest area of the D11 / D35? */
export function motorwayLit(x, z) {
  if (exitNear(x, z, LIT_R)) return true;
  for (const r of REST) {
    for (const cw of ['E', 'W', 'S', 'N']) {
      const s = r[cw];
      if (!s) continue;
      for (const q of [s.div, s.mer]) if (q && (q.x - x) ** 2 + (q.z - z) ** 2 < LIT_R * LIT_R) return true;
    }
  }
  return false;
}

/**
 * Is this tile barrier one the procedural D11 dressing replaces? OSM guard
 * rails and jersey walls inside the corridor (4 % of it, standing on the
 * terrain, not the deck); a noise wall is kept.
 */
export function osmBarrierReplaced(b) {
  if ((b?.k !== 'guard' && b?.k !== 'jersey') || !b.p?.length) return false;
  const i = (b.p.length - 1) >> 1, a = b.p[i], c = b.p[Math.min(b.p.length - 1, i + 1)];
  const l = d11Locate((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, _loc);
  return !!l && Math.abs(l.off) < 14;
}

/**
 * Pier stations (metres along the ribbon frame `fr`) for a D11 viaduct deck
 * between sA and sB, or null for any other bridge. The real viaducts carry
 * both decks on piers side by side; drawn per deck every PIER_STEP from each
 * way's own start they stood staggered. So a pier stands where the official
 * km (which W and N take by projection onto E and S, js/d11.js) is a multiple
 * of the step: both decks get the same km, so the same place across.
 */
export function mwPierStations(f, fr, sA, sB, step) {
  if (!f?.br || !cwOf(f)) return null;
  const at = (s) => {
    const { q, along } = fr;
    let i = 0;
    while (i < q.length - 2 && along[i + 1] < s) i++;
    const t = Math.min(1, Math.max(0, (s - along[i]) / ((along[i + 1] - along[i]) || 1)));
    const l = d11Locate(q[i][0] + (q[i + 1][0] - q[i][0]) * t, q[i][1] + (q[i + 1][1] - q[i][1]) * t, _loc);
    return l ? l.km : null;
  };
  const kA = at(sA), kB = at(sB);
  if (kA === null || kB === null || Math.abs(kB - kA) < 1e-4) return null;
  const st = step / 1000, lo = Math.min(kA, kB), hi = Math.max(kA, kB), out = [];
  // a pier no nearer the abutment than a third of a step
  for (let k = Math.ceil((lo + st / 3) / st) * st; k <= hi - st / 3; k += st) {
    out.push(sA + (sB - sA) * (k - kA) / (kB - kA));
  }
  out.sort((a, b) => a - b);
  return out;
}
