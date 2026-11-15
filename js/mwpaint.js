// ---- mwpaint.js: the paint of a motorway carriageway and its slip roads ----
// Called by meshes.js roadRibbon for t 'motorway' and 'motorway_link' (oneway),
// in place of the town rules (edge lines 30 cm in from both kerbs, 1.8/2.6 m
// centre dashes). Worker safe: no three, no DOM; it writes quads into the
// TriSink it is handed, on the ribbon's own frame, at the heights `yAt` reads
// off the ribbon's stations, so the paint lies on the asphalt that was drawn.
//
// WHERE THE LINES GO comes from js/lanes.js laneLayout, the record the AI
// traffic drives by, so a car is in the lane that is painted. Offsets there
// are + to the RIGHT of travel; the ribbon frame's `per` points LEFT
// ((dz, -dx), meshes.js ribbonFrame), so every offset is negated here.
//
// WHAT THE LINES ARE (Czech TP 133 terms, the widths and patterns read off
// ŘSD signing drawings, see the round 8 report):
//   V 4    edge line, solid, 0.25 m, both sides of the running lanes;
//   V 2b   lane line 6 m dash / 12 m gap, 0.125 m (dálnice);
//   V 2b   auxiliary lane line 3 m / 1.5 m, 0.25 m: the boundary between the
//          through lanes and an acceleration or deceleration lane, and the
//          right edge where a slip road's asphalt runs alongside;
//   slip roads: edge lines solid, a 2-lane slip a 3/6 lane line.
// The hard shoulder is left unpainted (its outer rim is the ribbon edge).
//
// THE SLIP ROAD PROBLEM. OSM starts a slip road on the motorway's CENTRELINE
// and lets it diverge at a few degrees, so for 30 to 80 m the slip road's
// ribbon lies across the right lane. Its own lines there would be a white
// lattice over the motorway (the old code cut them for 9.4 m round the node
// and then painted the rest straight across the lanes). So:
//   · a slip road paints nothing that lies on a motorway's asphalt;
//   · the motorway's right edge line turns into the 3/1.5 auxiliary dash
//     wherever a slip road's asphalt covers it, which is where the real
//     carriageway has its diverge or merge dash;
//   · junction pads whose every arm is a motorway or a slip road do not cut
//     the motorway's lines (a real motorway paints straight through).
//
// THE GORE (round 8 fix). Where the slip road's lane has moved off the
// motorway's lanes but its asphalt still runs on into the motorway's (the
// wedge before the grass nose of every exit, after every entry), a Czech
// motorway has two SOLID lines in a V and the wedge between them hatched
// with oblique lines (V 13). The first version painted the 3/1.5 dash all
// along the overlap and nothing on the slip road while it lay on motorway
// asphalt, so the wedge was a bare grey triangle. Now:
//   · the motorway's right edge line is the 3/1.5 dash only where the slip
//     road's LANE covers it, and solid again where the slip road's lane has
//     moved off to its right (gapAt below);
//   · the slip road's two edge lines are painted where they lie on the
//     motorway's asphalt right of its edge line (the deceleration taper and
//     the gore's right leg), and the wedge between the legs gets 45 degree
//     hatching every HATCH_STEP m of the slip road.
// The MOTORWAY's pass paints those, at the motorway's own deck height: the
// slip road's ribbon there lies under the motorway's (measured at exit 68 it
// is 0.8 m lower 30 m from the node), so its own paint would be buried. The
// slip road still paints nothing on motorway asphalt itself.

import { laneLayout, auxRight, LINE_W } from './lanes.js';

export const DASH_MW = [6, 12];      // m, V 2b lane line on a motorway
export const DASH_AUX = [3, 1.5];    // m, V 2b auxiliary lane line
export const DASH_LINK = [3, 6];     // m, lane line of a 2-lane slip road
const HW_EDGE = LINE_W / 2;          // 0.125: V 4 is 0.25 m
const HW_LANE = 0.0625;              // 0.125 m lane line
const HW_AUX = LINE_W / 2;           // 0.25 m auxiliary line
export const HATCH_STEP = 3;         // m along the slip road between two gore hatch lines
const HW_HATCH = 0.15;               // a 0.3 m hatch line (V 13)
const HATCH_MIN = 0.6;               // m: a narrower wedge gets no hatch (stubs read as dirt)

/** Is this a road mwpaint draws (a oneway motorway or slip road)? */
export function mwPainted(f) {
  return !!f && !!f.d && !!f.ow && (f.t === 'motorway' || f.t === 'motorway_link') && !!laneLayout(f);
}

// every arm of the junction (or of its cluster's members) is a motorway or a
// slip road: the motorway paints straight through it
function mwNode(j) {
  const nodes = j.members ?? [j];
  for (const nd of nodes) for (const a of nd.arms ?? []) {
    const t = a.r?.t;
    if (t !== 'motorway' && t !== 'motorway_link') return false;
  }
  return true;
}

// (Travel is the way's own vertex order here, as in the ribbon frames the
// paint is laid on: a oneway motorway or slip road is drawn that way.)
// How far right of a motorway's own right edge line the point (x, z) lies,
// for the motorway (same level as `self`) whose asphalt, grown by `grow`,
// holds it: lat - edgeR in that motorway's frame (+ right of travel), or
// null when no motorway's asphalt does. `out` (optional) gets the motorway's
// unit travel direction there (tx, tz). Where two hold it the smallest gap
// wins, so a line is never let onto a lane.
export function gapAt(cell, self, x, z, grow, out) {
  let best = null;
  for (const o of cell.roads) {
    if (o === self || o.t !== 'motorway' || !o.p || !!o.br !== !!self.br) continue;
    const lay = laneLayout(o);
    if (!lay) continue;
    const half = lay.ribbonHalf + grow, p = o.p;
    for (let k = 0; k < p.length - 1; k++) {
      const ax = p[k][0], az = p[k][1], ex = p[k + 1][0] - ax, ez = p[k + 1][1] - az;
      if (x < Math.min(ax, ax + ex) - half || x > Math.max(ax, ax + ex) + half
        || z < Math.min(az, az + ez) - half || z > Math.max(az, az + ez) + half) continue;
      const L2 = ex * ex + ez * ez || 1e-9;
      const u = ((x - ax) * ex + (z - az) * ez) / L2;
      if (u < -0.02 || u > 1.02) continue;
      const L = Math.sqrt(L2), tx = ex / L, tz = ez / L;
      // + right of travel: right = (-tz, tx)
      const lat = (x - ax) * -tz + (z - az) * tx;
      if (Math.abs(lat) > half) continue;
      const g = lat - lay.edgeR;
      if (best === null || g < best) {
        best = g;
        if (out) { out.tx = tx; out.tz = tz; }
      }
    }
  }
  return best;
}

// THE SLIP ROADS A PIECE PAINTS AGAINST. A motorway piece is drawn once, by
// its home chunk, over its whole length (often a kilometre or more), but its
// home cell lists only the ways that touch that one chunk. Read from the home
// cell alone, 9 of the 70 D11 pieces with a slip road on them lost their gore
// and auxiliary dash entirely and 30 more in part (measured in the round 8
// review), wherever the slip road leaves the piece away from its home chunk.
// So the gore and the dash read the slip roads of every cell along the piece.
// js/chunkspec.js ships exactly those cells (goreCellKeys) to the mesh
// worker, so both threads see the same list in the same order.
const GORE_M = 20;          // m round the centreline: a gore's slip road is within 13
const GORE_STEP = 15;       // m between samples: no point is then 7.5 m from one
const _gk = new Set(), _gs = new Set(), _gc = new Set();

/** Add to `out` the keys of the cells along motorway `f` that hold a slip road. */
export function goreCellKeys(city, f, out) {
  if (!city?.chunkIndex || f?.t !== 'motorway' || !(f.p?.length > 1)) return out;
  _gc.clear();
  const p = f.p, CH = 120;
  const add = (x, z) => {
    const i0 = Math.floor((x - GORE_M) / CH), i1 = Math.floor((x + GORE_M) / CH);
    const j0 = Math.floor((z - GORE_M) / CH), j1 = Math.floor((z + GORE_M) / CH);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = i + ',' + j;
      if (_gc.has(k)) continue;           // asked already (the samples overlap)
      _gc.add(k);
      const c = city.chunkIndex.get(k);
      if (c?.roads?.some((r) => r.t === 'motorway_link')) out.add(k);
    }
  };
  add(p[0][0], p[0][1]);
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], bx = p[i + 1][0], bz = p[i + 1][1];
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / GORE_STEP));
    for (let k = 1; k <= n; k++) add(ax + (bx - ax) * (k / n), az + (bz - az) * (k / n));
  }
  _gc.clear();
  return out;
}

// { roads } of the slip roads of the home cell and then of every cell along
// motorway `f` (goreCellKeys), each once
function slipRoadsNear(city, f, cell) {
  if (!city?.chunkIndex) return cell;
  _gk.clear(); _gs.clear();
  const roads = [];
  const take = (c) => {
    for (const r of c?.roads ?? []) if (r.t === 'motorway_link' && !_gs.has(r)) { _gs.add(r); roads.push(r); }
  };
  take(cell);
  for (const k of goreCellKeys(city, f, _gk)) take(city.chunkIndex.get(k));
  _gk.clear(); _gs.clear();
  return { roads };
}

// Is the motorway point (x, z) under a slip road's LANE (from its left edge
// line rightwards, within its asphalt)? Where the slip road's asphalt holds
// it but its lane has moved off to the right, the point is in the gore.
function underLinkLane(cell, self, x, z) {
  for (const o of cell.roads) {
    if (o === self || o.t !== 'motorway_link' || !o.p || !!o.br !== !!self.br) continue;
    const lay = laneLayout(o);
    if (!lay) continue;
    const half = lay.ribbonHalf + 0.1, p = o.p;
    for (let k = 0; k < p.length - 1; k++) {
      const ax = p[k][0], az = p[k][1], ex = p[k + 1][0] - ax, ez = p[k + 1][1] - az;
      if (x < Math.min(ax, ax + ex) - half || x > Math.max(ax, ax + ex) + half
        || z < Math.min(az, az + ez) - half || z > Math.max(az, az + ez) + half) continue;
      const L2 = ex * ex + ez * ez || 1e-9;
      let u = ((x - ax) * ex + (z - az) * ez) / L2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = x - ax - ex * u, qz = z - az - ez * u;
      if (qx * qx + qz * qz >= half * half) continue;
      const L = Math.sqrt(L2), tx = ex / L, tz = ez / L;
      const lat = (x - ax) * -tz + (z - az) * tx;
      if (lat >= lay.edgeL - HW_EDGE) return true;
    }
  }
  return false;
}

// A forward-only walker along the ribbon frame: the dash loops ask for
// increasing distances, so the cursor never goes back (meshes.js walkAt scans
// from the start every call, which on a 5 km way is 1 250 points a dash).
function walker(fr) {
  let i = 0;
  const { q, along } = fr;
  const o = { x: 0, z: 0, dx: 0, dz: 0 };
  return (d) => {
    if (along[i] > d) i = 0;
    while (i < q.length - 2 && along[i + 1] < d) i++;
    const L = (along[i + 1] - along[i]) || 1;
    const t = Math.min(1, Math.max(0, (d - along[i]) / L));
    const dx = q[i + 1][0] - q[i][0], dz = q[i + 1][1] - q[i][1], l = Math.hypot(dx, dz) || 1;
    o.x = q[i][0] + dx * t; o.z = q[i][1] + dz * t; o.dx = dx / l; o.dz = dz / l;
    return o;
  };
}

/**
 * Paint a motorway or slip road ribbon.
 * ctx: { cell, city, js (junctionsNear), inPads, yAt, mark (paint lift over
 *        the deck), col [r, g, b], s0 (the trim at the way's start) }
 */
export function motorwayPaint(sink, f, fr, ctx) {
  const lay = laneLayout(f);
  if (!lay) return;
  const { cell, js, inPads, yAt, mark, col } = ctx;
  const [r, g, b] = col;
  const { q, per, along, len } = fr;
  const link = f.t === 'motorway_link';
  const cut = (x, z) => {
    const j = inPads(js, x, z);
    return !!j && !mwNode(j);
  };
  // a slip road's paint stays off the motorway's asphalt (the motorway's
  // pass paints the gore on it, goreInto)
  const offMw = (x, z) => !link || gapAt(cell, f, x, z, -0.15, null) === null;
  // the slip roads beside this piece along its whole length, not just its
  // home chunk's (slipRoadsNear)
  const slips = link ? cell : slipRoadsNear(ctx.city, f, cell);
  const quad = (ax, ay, az, bx, by, bz, px0, pz0, px1, pz1, hw) => sink.quad(
    ax - px0 * hw, ay, az - pz0 * hw, bx - px1 * hw, by, bz - pz1 * hw,
    bx + px1 * hw, by, bz + pz1 * hw, ax + px0 * hw, ay, az + pz0 * hw, r, g, b);
  // ---- the two edge lines, on the mitred frame like the deck ----
  // o is the lanes.js offset (+ right); the frame's per points left
  const edge = (o, isRight) => {
    let auxRun = -1;          // distance where the current auxiliary stretch began
    const auxDash = (d0, d1) => {
      // the 3/1.5 dash over [d0, d1], phased from the stretch start
      for (let s = d0; s < d1; s += DASH_AUX[0] + DASH_AUX[1]) dash(s, Math.min(d1, s + DASH_AUX[0]), o, HW_AUX);
    };
    for (let i = 0; i < q.length - 1; i++) {
      const ax = q[i][0] - per[i][0] * o, az = q[i][1] - per[i][1] * o;
      const bx = q[i + 1][0] - per[i + 1][0] * o, bz = q[i + 1][1] - per[i + 1][1] * o;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      const linkHere = isRight && !link && underLinkLane(slips, f, mx, mz);
      if (linkHere) { if (auxRun < 0) auxRun = along[i]; continue; }
      if (auxRun >= 0) { auxDash(auxRun, along[i]); auxRun = -1; }
      if (cut(ax, az) || cut(bx, bz) || !offMw(mx, mz)) continue;
      quad(ax, yAt(along[i]) + mark, az, bx, yAt(along[i + 1]) + mark, bz,
        per[i][0], per[i][1], per[i + 1][0], per[i + 1][1], HW_EDGE);
    }
    if (auxRun >= 0) auxDash(auxRun, len);
  };
  // ---- dashes: a run of [dash, gap] from the way's own start ----
  const at = walker(fr), at2 = walker(fr);
  const dash = (s, e, o, hw) => {
    if (e - s < 0.3) return;
    const A = at(s), ax = A.x - A.dz * o, az = A.z + A.dx * o, adx = A.dx, adz = A.dz;
    const B = at2(e), bx = B.x - B.dz * o, bz = B.z + B.dx * o;
    if (cut(ax, az) || cut(bx, bz) || !offMw((ax + bx) / 2, (az + bz) / 2)) return;
    // per (left) at each end is (dz, -dx)
    quad(ax, yAt(s) + mark, az, bx, yAt(e) + mark, bz, adz, -adx, B.dz, -B.dx, hw);
  };
  edge(lay.edgeL, false);
  edge(lay.edgeR, true);
  // ---- lane lines ----
  // A 3-lane motorway piece next to a slip road (lanes.js auxRight) paints
  // its second divider as the auxiliary dash; a real third lane (Prague's
  // 2.7 km run) keeps the ordinary lane line.
  let aux = null;
  if (!link && lay.n >= 3 && ctx.endsAt) aux = auxRight(f, ctx.endsAt);
  // the phase runs from the way's untrimmed start, so two pieces of one
  // carriageway that meet at a node keep one rhythm whatever their trim
  const s0 = ctx.s0 ?? 0;
  for (let k = 0; k < lay.dividers.length; k++) {
    const o = lay.dividers[k];
    const isAux = !!aux && k === lay.dividers.length - 1;
    const [dl, gl] = isAux ? DASH_AUX : link ? DASH_LINK : DASH_MW;
    const hw = isAux ? HW_AUX : HW_LANE, step = dl + gl;
    let s = step - ((s0 % step) + step) % step;
    if (s >= step) s -= step;
    for (; s < len; s += step) dash(Math.max(0, s), Math.min(len, s + dl), o, hw);
  }
  if (!link) goreInto(sink, f, fr, lay, ctx, cut, slips);

}

// Where (x, z) lies on way `f` (polyline p, cumulative arclength cum):
// out.along (m from the way's start), out.lat (+ right of travel), out.tx,
// out.tz, for the nearest segment whose span holds it. False when none does.
// The way's own vertices, not the ribbon frame's 4 m stations: the frame is
// those vertices resampled, so the arclength is the same, at a fraction of
// the segments (a 2.4 km carriageway piece is 20 vertices, 600 stations).
function onWay(p, cum, x, z, out) {
  let best = Infinity;
  for (let i = 0; i < p.length - 1; i++) {
    const ax = p[i][0], az = p[i][1], ex = p[i + 1][0] - ax, ez = p[i + 1][1] - az;
    const L = cum[i + 1] - cum[i];
    if (L < 1e-3) continue;
    const u = ((x - ax) * ex + (z - az) * ez) / (L * L);
    if (u < -0.01 || u > 1.01) continue;
    const tx = ex / L, tz = ez / L;
    const lat = (x - ax) * -tz + (z - az) * tx;
    if (Math.abs(lat) < Math.abs(best)) {
      best = lat;
      out.along = cum[i] + L * Math.min(1, Math.max(0, u)); out.lat = lat; out.tx = tx; out.tz = tz;
    }
  }
  return best !== Infinity;
}

const _fa = { along: 0, lat: 0, tx: 0, tz: 0 }, _fb = { along: 0, lat: 0, tx: 0, tz: 0 };
const _prev = [0, 0, 0, 0];   // the last station's x, z, y and whether it was painted

// The gore on a motorway ribbon `f` (lanes lay): every slip road of the cell
// at the same level, walked along its own line every metre from its own start
// (so a slip road split over two chunks keeps one hatch rhythm). Heights from
// this ribbon (yAt takes the frame's distance, the way's minus its trim s0).
function goreInto(sink, f, fr, lay, ctx, cut, cell) {
  const { yAt, mark, col } = ctx;
  const s0 = ctx.s0 ?? 0, len = fr.len;
  const [cr, cg, cb] = col;
  const onAsph = lay.ribbonHalf - 0.15;      // a line must lie on this ribbon's asphalt
  const legMin = 2 * HW_EDGE + 0.05;          // and clear of its edge line
  const p = f.p, cum = [0];
  let bx0 = p[0][0], bz0 = p[0][1], bx1 = bx0, bz1 = bz0;
  for (let i = 1; i < p.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]));
    if (p[i][0] < bx0) bx0 = p[i][0]; if (p[i][0] > bx1) bx1 = p[i][0];
    if (p[i][1] < bz0) bz0 = p[i][1]; if (p[i][1] > bz1) bz1 = p[i][1];
  }
  const g = lay.ribbonHalf + 1;
  bx0 -= g; bz0 -= g; bx1 += g; bz1 += g;
  const yOf = (along) => yAt(Math.min(len, Math.max(0, along - s0))) + mark;
  const seg = (ax, az, ay, bx, bz, by, hw) => {
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, px = dz / l * hw, pz = -dx / l * hw;
    sink.quad(ax - px, ay, az - pz, bx - px, by, bz - pz, bx + px, by, bz + pz, ax + px, ay, az + pz, cr, cg, cb);
  };
  for (const o of cell.roads) {
    if (o.t !== 'motorway_link' || !o.p || o.p.length < 2 || !!o.br !== !!f.br) continue;
    const lo = laneLayout(o);
    if (!lo) continue;
    const q = o.p;
    let ox0 = Infinity, oz0 = Infinity, ox1 = -Infinity, oz1 = -Infinity;
    for (const v of q) {
      if (v[0] < ox0) ox0 = v[0]; if (v[0] > ox1) ox1 = v[0];
      if (v[1] < oz0) oz0 = v[1]; if (v[1] > oz1) oz1 = v[1];
    }
    if (ox1 < bx0 || ox0 > bx1 || oz1 < bz0 || oz0 > bz1) continue;
    for (const eo of [lo.edgeL, lo.edgeR]) {
      const isLeft = eo === lo.edgeL;
      _prev[3] = 0;
      let acc = 0, last = -1;
      for (let k = 0; k < q.length - 1; k++) {
        const ax = q[k][0], az = q[k][1], ex = q[k + 1][0] - ax, ez = q[k + 1][1] - az;
        const L = Math.hypot(ex, ez);
        if (L < 1e-6) continue;
        const tx = ex / L, tz = ez / L;
        // a segment wholly outside the motorway's box: skip its stations
        if (Math.max(ax, ax + ex) < bx0 - 4 || Math.min(ax, ax + ex) > bx1 + 4
          || Math.max(az, az + ez) < bz0 - 4 || Math.min(az, az + ez) > bz1 + 4) { acc += L; _prev[3] = 0; continue; }
        for (let s = Math.ceil(acc) - acc; s <= L; s += 1) {
          const at = acc + s;
          if (at - last < 0.5) continue;     // a vertex on a whole metre: once
          last = at;
          // the edge line's point: + right = (-tz, tx)
          const x = ax + tx * s - tz * eo, z = az + tz * s + tx * eo;
          let on = false, y = 0;
          if (x >= bx0 && x <= bx1 && z >= bz0 && z <= bz1 && onWay(p, cum, x, z, _fa)) {
            const gap = _fa.lat - lay.edgeR;
            if (gap > legMin && _fa.lat < onAsph && !cut(x, z)) {
              on = true;
              y = yOf(_fa.along);
              if (_prev[3]) seg(_prev[0], _prev[1], _prev[2], x, z, y, HW_EDGE);
              // the hatch, from the left leg back at 45 degrees to the
              // motorway's edge line, both ends on this ribbon
              const ph = ((at % HATCH_STEP) + HATCH_STEP) % HATCH_STEP;
              if (isLeft && gap >= HATCH_MIN + legMin && (ph < 0.5 || ph > HATCH_STEP - 0.5)) {
                const w = gap - legMin - 0.05, rx = -_fa.tz, rz = _fa.tx;
                const hx = x - rx * (HW_EDGE + 0.05), hz = z - rz * (HW_EDGE + 0.05);
                const kx = hx - rx * w - _fa.tx * w, kz = hz - rz * w - _fa.tz * w;
                if (!cut(kx, kz) && onWay(p, cum, kx, kz, _fb) && _fb.lat - lay.edgeR >= HW_EDGE) {
                  seg(hx, hz, y, kx, kz, yOf(_fb.along), HW_HATCH);
                }
              }
            }
          }
          _prev[0] = x; _prev[1] = z; _prev[2] = y; _prev[3] = on ? 1 : 0;
        }
        acc += L;
      }
    }
  }
}
