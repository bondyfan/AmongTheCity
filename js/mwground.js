// ---- the ground beside a motorway is a verge, never a pavement -------------
// Two layers lay hard ground on ground nobody mapped: sealed.js (the closing of
// a hard path network, for town squares) and the classifier raster
// (groundclass.js, read off the orthophoto). Both are right in a town and both
// were wrong along the D11 (round 8, exit 68 Chýšť and the Poříčany stretch):
//
//   · the closing took the two concrete carriageways, a slip road and the
//     crossing road for a "network" and tiled the median, the wedge before
//     every slip road and the verge past the rail in square paving;
//   · the classifier read the photo's pale concrete shoulders, the cutting
//     slopes and the link pavements as sealed ground: about one 4 m cell in
//     eight, 8 to 26 m from a carriageway centreline near Poříčany, is
//     "paving" in the shipped raster.
//
// A Czech motorway's surroundings are asphalt where a carriageway or a slip
// road actually is (their own ribbons draw that) and a grass or gravel verge
// everywhere else, which is exactly what the unmapped-ground rule (the field)
// already gives. So inside the VERGE band neither inferred layer may lay
// anything; a polygon OSM did draw (a rest-area car park, a fuel forecourt)
// is a different layer and is untouched.
//
// Pure, no three, no DOM: the mesher runs this on the main thread AND in the
// mesh worker, and grassmask.js asks it too, so grass and paving agree. The
// answer depends only on the cell's own roads and on the d11.js lines, never
// on which tiles arrived first.

import { CHUNK } from './config.js';
import { d11Line, d11Locate, LOCATE_R } from './d11.js';

export const VERGE_RES = 2;                       // m per cell, sealed.js's own grid
const N = CHUNK / VERGE_RES;                      // 60 cells a side
// Metres past a motorway or slip road's half width that stay verge. The
// closing fills gaps up to 20 m, and the classifier's false paving sits within
// 20 m of the ribbon edge (measured, see above); 18 m past the half width is
// d11Locate's own 25 m reach from a D11 centreline, so both tests end at the
// same line.
export const VERGE = 18;
const MW = new Set(['motorway', 'motorway_link']);
const CWS = ['E', 'W', 'S', 'N'];
// from a D11 / D35 centreline: d11Locate's own reach, the 12.5 m carriageway
// plus the same VERGE past its edge
const LINE_R = LOCATE_R;
const _seg = [[0, 0], [0, 0]];

/**
 * Which of this chunk's 2 m cells lie in a motorway's verge band, as an N×N
 * Uint8Array (1 = verge), or null when none does. Built from the cell's
 * motorway and motorway_link ways (any motorway, the D0 and D1 too) plus the
 * D11 / D35 carriageway lines of d11.js, which also cover a carriageway whose
 * way runs just outside this chunk's box and so is not in `cell.roads`.
 */
export function motorwayVerge(cell, cx, cz) {
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  let g = null;
  for (const r of cell?.roads ?? []) {
    if (!MW.has(r.t) || !(r.p?.length > 1)) continue;
    g = stamp(g, x0, z0, r.p, (r.w ?? 5.5) / 2 + VERGE);
  }
  // The D11 lines (2 700 vertices in all): every segment whose box comes
  // within LINE_R of the chunk is stamped like a way. Exact, and a tenth of
  // the cost of asking d11Locate at each of the 3 600 cells.
  const R = LINE_R;
  for (const cw of CWS) {
    const q = d11Line(cw);
    for (let i = 0; i + 1 < q.n; i++) {
      const ax = q.x[i], az = q.z[i], bx = q.x[i + 1], bz = q.z[i + 1];
      if (Math.max(ax, bx) < x0 - R || Math.min(ax, bx) > x0 + CHUNK + R
        || Math.max(az, bz) < z0 - R || Math.min(az, bz) > z0 + CHUNK + R) continue;
      _seg[0][0] = ax; _seg[0][1] = az; _seg[1][0] = bx; _seg[1][1] = bz;
      g = stamp(g, x0, z0, _seg, R);
    }
  }
  return g;
}

/**
 * Is world point (x, z) on a motorway's or slip road's own asphalt (its drawn
 * ribbon, plus a little)? The verge band takes in the carriageway too, so a
 * caller that lets something GROW in the band (grassmask.js) must keep it off
 * the road: without this, every classifier cell the band freed sprouted grass
 * tufts through the inner lane of the D11. Cell ways first, then the d11.js
 * lines for a carriageway whose way lies just outside this cell.
 */
const ASPHALT_PAD = 0.6;
const _loc = {};
export function onMotorwayAsphalt(cell, x, z) {
  for (const r of cell?.roads ?? []) {
    if (!MW.has(r.t) || !(r.p?.length > 1)) continue;
    const hw = (r.w ?? 5.5) / 2 + ASPHALT_PAD, hw2 = hw * hw;
    for (let k = 0; k < r.p.length - 1; k++) {
      const ax = r.p[k][0], az = r.p[k][1], ex = r.p[k + 1][0] - ax, ez = r.p[k + 1][1] - az;
      const l2 = ex * ex + ez * ez;
      let t = l2 > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = x - ax - ex * t, dz = z - az - ez * t;
      if (dx * dx + dz * dz < hw2) return true;
    }
  }
  const L = d11Locate(x, z, _loc);
  return !!L && Math.abs(L.off) < 6.25 + ASPHALT_PAD;
}

/** Is world point (x, z) in the verge band `g` of chunk (cx, cz)? */
export function inVerge(g, cx, cz, x, z) {
  if (!g) return false;
  let i = Math.floor((x - cx * CHUNK) / VERGE_RES), j = Math.floor((z - cz * CHUNK) / VERGE_RES);
  if (i < 0) i = 0; else if (i > N - 1) i = N - 1;
  if (j < 0) j = 0; else if (j > N - 1) j = N - 1;
  return g[j * N + i] === 1;
}

/**
 * The classifier's merged rectangles with every cell in the verge band taken
 * out. A rectangle clear of the band passes through as it is; one that
 * touches it is cut back into row runs of `res` m cells (the classifier's own
 * 4 m grid), so a cell is dropped whole and the edges stay on that grid.
 */
export function cutRects(rects, g, cx, cz, res = 4) {
  if (!g || !rects.length) return rects;
  const out = [];
  for (const r of rects) {
    let hit = false;
    for (let z = r.z0; z < r.z1 && !hit; z += VERGE_RES) {
      for (let x = r.x0; x < r.x1; x += VERGE_RES) if (inVerge(g, cx, cz, x + 1, z + 1)) { hit = true; break; }
    }
    if (!hit) { out.push(r); continue; }
    for (let z = r.z0; z < r.z1; z += res) {
      let run = -1;
      for (let x = r.x0; x <= r.x1; x += res) {
        const keep = x < r.x1 && !cellHits(g, cx, cz, x, z, res);
        if (keep && run < 0) run = x;
        else if (!keep && run >= 0) {
          out.push({ x0: run, z0: z, x1: x, z1: z + res, c: r.c });
          run = -1;
        }
      }
    }
  }
  return out;
}

/**
 * Does the mesher drop the classifier's res m cell holding world point (x, z)?
 * grassmask.js asks this so the grass grows exactly where the paving went.
 */
export function vergeDrops(g, cx, cz, x, z, res = 4) {
  if (!g) return false;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  return cellHits(g, cx, cz, x0 + Math.floor((x - x0) / res) * res, z0 + Math.floor((z - z0) / res) * res, res);
}

// any 2 m verge cell inside the res × res ground cell at (x, z)
function cellHits(g, cx, cz, x, z, res) {
  for (let dz = 0; dz < res; dz += VERGE_RES) {
    for (let dx = 0; dx < res; dx += VERGE_RES) if (inVerge(g, cx, cz, x + dx + 1, z + dz + 1)) return true;
  }
  return false;
}

// a polyline's band of half width hw stamped into the chunk's grid
function stamp(g, x0, z0, pts, hw) {
  const hw2 = hw * hw;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    let i0 = Math.floor((Math.min(ax, bx) - hw - x0) / VERGE_RES);
    let i1 = Math.floor((Math.max(ax, bx) + hw - x0) / VERGE_RES);
    let j0 = Math.floor((Math.min(az, bz) - hw - z0) / VERGE_RES);
    let j1 = Math.floor((Math.max(az, bz) + hw - z0) / VERGE_RES);
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0;
    if (i1 > N - 1) i1 = N - 1; if (j1 > N - 1) j1 = N - 1;
    if (i1 < i0 || j1 < j0) continue;
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * VERGE_RES;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * VERGE_RES;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = px - ax - dx * t, ez = pz - az - dz * t;
        if (ex * ex + ez * ez <= hw2) (g ??= new Uint8Array(N * N))[j * N + i] = 1;
      }
    }
  }
  return g;
}
