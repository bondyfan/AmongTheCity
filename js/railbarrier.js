// ==========================================================================
// Nobody walks across the railway, anywhere
//
// Frank, 21 Nov 2026: "vsimnul jsem si ze v pardubicich muzu chodit pres koleje
// na nadrazi. to se nesmi stat nikde!" The campaign already took a step onto
// the rails back inside two station yards (js/prologue-tracks.js, a box per
// station, only while the story runs). In free roam nothing did, so from the
// forecourt of Pardubice hl. n. you could stroll over eleven tracks to Dukla.
//
// THE RULE, from the rail data and nothing else. Every heavy-rail way at grade
// (not a tram, not a bridge, not in a tunnel) is a strip RAIL_HALF either side
// of its centreline: the whole ballast bed the mesher draws, out to the foot of
// its shoulder (meshes.js BED_FOOT 2.25 m). A walker may not stand in it, and
// is pushed back out to the side he came from, exactly as a wall pushes him.
// That is also where a platform visibly ENDS: the bed is drawn over the mapped
// platform polygon (which reaches to 1.5 m of the rail at Pardubice), so the
// paving the player sees stops 2.4 to 3 m from the rail, and he stops there
// too instead of stepping down onto the stones. The way across is where the
// map says there is one:
//
//   crossings   a road, a service road, a footway or a path that meets the
//               track at grade (OSM draws a level crossing or a railway=crossing
//               as the two ways sharing a node, or at least crossing). Inside
//               that way's own width the strip is open. Indexed once per
//               chunk cell, from the cell's own rails and roads.
//   levels      the station underpasses and the footbridge are other floors:
//               a walker more than levelsep's LEVEL_GAP (2.4 m) below or above
//               the rail's top (geo.railGradeY + LAYER_Y.rail) is not on it.
//               Any road underpass and road bridge the same way.
//   stations    the station's own rooms, stairs and footbridge ramps
//               (js/station-passages.js floor()). A mapped platform is NOT an
//               exception: its polygon runs under the drawn bed.
//   the train   the story's coach (world.storyCoach) carries whoever is in it,
//               and its `boarding(x, z)` is the step from the platform edge.
//               Every other train the same (world.rideDeck, js/trainride.js):
//               in it, and at its open door while it stands at a station.
//
// Pure in the tile data and the walker's position: two co-op screens agree on
// where the barrier is without telling each other anything. The parts with no
// world in them (heavyAtGrade, crossingGates, railPush) are tested on their
// own in tests/railbarrier.test.mjs.
// ==========================================================================

import { chunkKey, railGradeY } from './geo.js';
import { LAYER_Y, CHUNK } from './config.js';
import { sameLevel } from './levelsep.js';
import { roadSegs, segmentNear } from './roadsegments.js';

export const RAIL_HALF = 2.25;  // m either side of a track's centreline nobody stands on (the bed's foot)
const GATE_PAD = 0.5;           // m past a crossing way's half width that is still the crossing
const GATE_REACH = 14;          // m from the crossing point along which a gate can open the strip
const RAIL_T = new Set(['rail', 'light_rail', 'narrow_gauge']);

/** A track a walker can step onto: heavy rail on the ground, not on a bridge or under it. */
export function heavyAtGrade(r) {
  return !!r && RAIL_T.has(r.t) && !r.br && (r.l ?? 0) === 0 && Array.isArray(r.p) && r.p.length >= 2;
}
/** A way that can carry a walker over a track at grade. */
function crossesAtGrade(w) {
  return !!w && !w.br && (w.l ?? 0) === 0 && Array.isArray(w.p) && w.p.length >= 2;
}

// segment ab against segment cd, endpoints INCLUDED: a level crossing in OSM is
// the two ways sharing their node, which is a touch, not a strict crossing
function meet(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  const e = 1e-6;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return [ax + rx * t, az + rz * t];
}

/**
 * Where ways cross heavy rail at grade, inside the box [x0, z0, x1, z1] (a
 * chunk cell; everything when omitted): [{ x, z, ax, az, bx, bz, half }], the
 * crossing point, the crossing way's segment there and the half width of the
 * opening along it.
 */
export function crossingGates(rails, roads, box = null) {
  const gates = [];
  const M = 3;
  const inBox = (s, i) => !box || (s[i + 7] >= box[0] - M && s[i + 6] <= box[2] + M && s[i + 9] >= box[1] - M && s[i + 8] <= box[3] + M);
  const rs = [];
  for (const r of rails ?? []) {
    if (!heavyAtGrade(r)) continue;
    const s = roadSegs(r);
    for (let i = 0; i < s.length; i += 10) if (inBox(s, i)) rs.push(s, i);
  }
  if (!rs.length) return gates;
  for (const w of roads ?? []) {
    if (!crossesAtGrade(w) || RAIL_T.has(w.t)) continue;
    const ws = roadSegs(w), half = (w.w ?? 3) / 2 + GATE_PAD;
    for (let j = 0; j < ws.length; j += 10) {
      if (!inBox(ws, j)) continue;
      const cx = ws[j], cz = ws[j + 1], dx = cx + ws[j + 2], dz = cz + ws[j + 3];
      for (let k = 0; k < rs.length; k += 2) {
        const s = rs[k], i = rs[k + 1];
        if (s[i + 7] < ws[j + 6] || s[i + 6] > ws[j + 7] || s[i + 9] < ws[j + 8] || s[i + 8] > ws[j + 9]) continue;
        const hit = meet(s[i], s[i + 1], s[i] + s[i + 2], s[i + 1] + s[i + 3], cx, cz, dx, dz);
        if (hit) gates.push({ x: hit[0], z: hit[1], ax: cx, az: cz, bx: dx, bz: dz, half });
      }
    }
  }
  return gates;
}

/** Is (x, z) inside the opening of one of these crossings? */
export function inGate(gates, x, z) {
  for (const g of gates) {
    const ex = x - g.x, ez = z - g.z;
    if (ex * ex + ez * ez > GATE_REACH * GATE_REACH) continue;
    const vx = g.bx - g.ax, vz = g.bz - g.az, L2 = vx * vx + vz * vz;
    let t = L2 > 0 ? ((x - g.ax) * vx + (z - g.az) * vz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = g.ax + vx * t - x, qz = g.az + vz * t - z;
    if (qx * qx + qz * qz <= g.half * g.half) return true;
  }
  return false;
}

/**
 * Push `pos` out of the strip of one track. `r` the rail way, `radius` the
 * walker's. Returns null when the walker is clear of it, else the chainage
 * where it was nearest (for the caller's level test) and writes the pushed
 * point into out { x, z }. Nothing in here knows about crossings or levels.
 */
export function railPush(r, x, z, radius, out) {
  const reach = RAIL_HALF + radius;
  const s = roadSegs(r);
  let best = reach * reach, bi = -1, bt = 0;
  for (let i = 0; i < s.length; i += 10) {
    if (!segmentNear(s, i, x, z, reach)) continue;
    const dx = s[i + 2], dz = s[i + 3], L = s[i + 4];
    if (!(L > 1e-9)) continue;
    let t = ((x - s[i]) * dx + (z - s[i + 1]) * dz) / (L * L);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - (s[i] + dx * t), ez = z - (s[i + 1] + dz * t), d2 = ex * ex + ez * ez;
    if (d2 < best) { best = d2; bi = i; bt = t; }
  }
  if (bi < 0) return null;
  const dx = s[bi + 2], dz = s[bi + 3], L = s[bi + 4];
  const cx = s[bi] + dx * bt, cz = s[bi + 1] + dz * bt;
  let nx = x - cx, nz = z - cz;
  const d = Math.sqrt(nx * nx + nz * nz);
  if (d > 1e-6) { nx /= d; nz /= d; } else { nx = -dz / L; nz = dx / L; }   // on the line: one side
  out.x = cx + nx * reach;
  out.z = cz + nz * reach;
  out.s = s[bi + 5] + L * bt;
  return out;
}

// per cell: the crossing gates of its rails, rebuilt when the cell's arrays change
const _cells = new WeakMap();
function gatesOf(cell, key) {
  let c = _cells.get(cell);
  const rails = cell.rails, roads = cell.roads;
  if (c && c.rails === rails && c.roads === roads && c.nr === rails.length && c.nw === (roads?.length ?? 0)) return c.gates;
  const [ci, cj] = key.split(',').map(Number);
  const gates = crossingGates(rails, roads, [ci * CHUNK, cj * CHUNK, (ci + 1) * CHUNK, (cj + 1) * CHUNK]);
  _cells.set(cell, { rails, roads, nr: rails.length, nw: roads?.length ?? 0, gates });
  return gates;
}
function anyHeavy(rails) {
  for (let i = 0; i < rails.length; i++) if (heavyAtGrade(rails[i])) return true;
  return false;
}

const _out = { x: 0, z: 0, s: 0 };

/**
 * The walker half of world.collide (js/city.js, opts.interior): `pos` is pushed
 * out of every track strip it stands in unless something above lets it be
 * there. `y` is the walker's own level (feet). Returns true if it moved.
 */
export function railCollide(world, pos, radius, y) {
  const idx = world?.city?.chunkIndex;
  if (!idx) return false;
  const key = chunkKey(pos.x, pos.z);
  const cell = idx.get(key);
  const rails = cell?.rails;
  if (!rails || !rails.length || !anyHeavy(rails)) return false;
  let pushed = false;
  for (let pass = 0; pass < 3; pass++) {
    let moved = false;
    for (let i = 0; i < rails.length; i++) {
      const r = rails[i];
      if (!heavyAtGrade(r)) continue;
      const hit = railPush(r, pos.x, pos.z, radius, _out);
      if (!hit) continue;
      if (Number.isFinite(y)) {
        const g = railGradeY(r, hit.s, world.terrain);
        if (g !== null && g !== undefined && Number.isFinite(g) && !sameLevel(y, g + LAYER_Y.rail)) continue;
      }
      if (allowed(world, cell, key, pos.x, pos.z, y)) return pushed;
      pos.x = hit.x; pos.z = hit.z;
      pushed = moved = true;
    }
    if (!moved) break;
  }
  return pushed;
}

// a walker in a track strip who is nevertheless somewhere he may be
function allowed(world, cell, key, x, z, y) {
  if (world.storyCoach?.boarding?.(x, z) || world.rideDeck?.boarding?.(x, z)) return true;
  const sp = world.stationPassages;
  if (sp?.floor && sp.floor(x, z, (Number.isFinite(y) ? y : 0) + 0.4) !== null) return true;
  return inGate(gatesOf(cell, key), x, z);
}
