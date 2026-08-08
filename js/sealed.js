// ---- ground nobody mapped, between paths that are plainly paved -----------
// A Czech town square is very often not a polygon in OSM. Náměstí Jana Pernera
// is mapped as thirteen ways and no area at all: five footways on sett, three on
// concrete, two on paving_stones, three concrete service roads named after the
// square — and nothing whatsoever saying that the ground BETWEEN them is the
// same paving. So the runtime falls back to its rule for ground nobody mapped,
// which is "a field", and grows 13 cm of grass in every gap. Measured on that
// chunk: 7 % of its ground, in ribbons threaded between the path stamps, which
// is exactly what a pedestrian square looks like with weeds growing out of it.
//
// The signal is already in the data we ship. A path across a paved square says
// surface=sett / concrete / paving_stones; a path through a park says gravel or
// ground or nothing. So: where hard-surfaced ways run close enough together to
// enclose the ground between them, that ground is the same hard surface.
//
// That is a morphological CLOSING — grow the paved network, then shrink it back.
// Gaps narrower than twice the radius are swallowed and stay filled; open ground
// beyond the network grows and shrinks back to nothing.
//
// TWO SAFETY PROPERTIES, and the whole thing rests on them:
//
//   · only surfaces OSM calls hard take part. A gravel path through a meadow
//     never seals anything, so a park keeps its grass however dense its paths.
//   · the answer may only ever be applied to UNMAPPED ground. Where OSM drew a
//     lawn, the lawn wins — this is for the silence between features, not an
//     argument with the map.
//
// The caller enforces the second one; see grassmask.js.

import { CHUNK } from './config.js';

export const SEAL_RES = 2;                 // m per cell — the square's gaps are metres
const N = CHUNK / SEAL_RES;                // 60 cells a side
// The closing reaches past the chunk, and a square does not stop at a chunk
// border. Without the margin the fill would come apart along the seam, in a
// straight line, which is the most visible artefact a raster can have.
const PAD = 10;                            // cells of margin = 20 m
const W = N + 2 * PAD;
// Fills a gap up to 2 × CLOSE × SEAL_RES = 20 m across. A town square's paths
// are 5–15 m apart; a field's are hundreds.
const CLOSE = 5;

// What a surface has to be for the ground beside it to be paved too. These are
// build-region's own classes (scripts/build-region.mjs SURFACE), not raw OSM
// values — gravel, dirt and grass are deliberately absent.
const HARD = new Set(['asphalt', 'concrete', 'paving', 'cobble']);

/** Does this way's surface mean the ground around it is sealed? */
export function isHardWay(r) {
  return !!r && HARD.has(r.s);
}

function thickLine(g, x0, z0, pts, hw) {
  if (!pts || pts.length < 2) return;
  const hw2 = hw * hw;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    let i0 = Math.floor((Math.min(ax, bx) - hw - x0) / SEAL_RES) + PAD;
    let i1 = Math.ceil((Math.max(ax, bx) + hw - x0) / SEAL_RES) + PAD;
    let j0 = Math.floor((Math.min(az, bz) - hw - z0) / SEAL_RES) + PAD;
    let j1 = Math.ceil((Math.max(az, bz) + hw - z0) / SEAL_RES) + PAD;
    if (i0 < 0) i0 = 0; if (j0 < 0) j0 = 0;
    if (i1 > W - 1) i1 = W - 1; if (j1 > W - 1) j1 = W - 1;
    if (i1 < i0 || j1 < j0) continue;
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j - PAD + 0.5) * SEAL_RES;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i - PAD + 0.5) * SEAL_RES;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
        if (ex * ex + ez * ez <= hw2) g[j * W + i] = 1;
      }
    }
  }
}

// Separable box morphology: a running max (or min) along rows, then columns,
// which is a square structuring element and is all this needs. Two passes over
// 76 × 76 bytes, four times — a few tens of microseconds.
function sweep(src, dst, r, wantMax) {
  const tmp = new Uint8Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      let v = wantMax ? 0 : 1;
      const a = i - r < 0 ? 0 : i - r, b = i + r > W - 1 ? W - 1 : i + r;
      for (let k = a; k <= b; k++) {
        const s = src[j * W + k];
        if (wantMax ? s > v : s < v) v = s;
      }
      tmp[j * W + i] = v;
    }
  }
  for (let i = 0; i < W; i++) {
    for (let j = 0; j < W; j++) {
      let v = wantMax ? 0 : 1;
      const a = j - r < 0 ? 0 : j - r, b = j + r > W - 1 ? W - 1 : j + r;
      for (let k = a; k <= b; k++) {
        const s = tmp[k * W + i];
        if (wantMax ? s > v : s < v) v = s;
      }
      dst[j * W + i] = v;
    }
  }
}

/**
 * Which of this chunk's SEAL_RES cells are sealed ground the map never drew.
 * Returns an N×N Uint8Array (1 = sealed), or null when the chunk holds no hard
 * ways at all — the common case in open country, and worth not allocating for.
 */
export function sealedGrid(cell, cx, cz) {
  if (!cell) return null;
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const hard = [];
  for (const r of cell.roads ?? []) if (isHardWay(r) && r.p?.length > 1) hard.push(r);
  // One path across a corner seals nothing: a closing needs a network to close.
  if (hard.length < 3) return null;

  const g = new Uint8Array(W * W);
  for (const r of hard) thickLine(g, x0, z0, r.p, (r.w ?? 2) / 2 + 0.6);
  // …and a paved AREA the map did draw is part of the same network, so a square
  // with a platform or a car park in it closes across that too instead of
  // leaving a moat of grass around it.
  for (const p of cell.paved ?? []) {
    if (p.o?.length >= 3) thickLine(g, x0, z0, [...p.o, p.o[0]], 1.0);
  }

  const grown = new Uint8Array(W * W);
  sweep(g, grown, CLOSE, true);
  const closed = new Uint8Array(W * W);
  sweep(grown, closed, CLOSE, false);

  // WHERE THE MAP SPOKE, THE MAP WINS. The closing does not know a lawn from a
  // forecourt — it only knows the ground is enclosed by paving — so a green in
  // the middle of a square, a pond, a building footprint, all come back out. The
  // layering hides most of this anyway (a green fill outranks the inferred layer
  // by a centimetre), but only while the green fill is DRAWN, and under the
  // aerial photo it is not. Subtracting here means both readers of this grid,
  // the renderer and the grass, get the same answer under either setting.
  for (const f of cell.green ?? []) if (f.o?.length >= 3) clearPolygon(closed, x0, z0, f.o, f.i);
  for (const f of cell.water ?? []) if (f.o?.length >= 3) clearPolygon(closed, x0, z0, f.o, f.i);
  for (const f of cell.buildings ?? []) if (f.o?.length >= 3) clearPolygon(closed, x0, z0, f.o, f.i);

  // Crop the margin away and report only this chunk's own cells.
  const out = new Uint8Array(N * N);
  let any = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = closed[(j + PAD) * W + (i + PAD)];
      out[j * N + i] = v;
      any += v;
    }
  }
  return any ? out : null;
}

/** Even-odd scanline, clearing the ring's interior back to unsealed. */
function clearPolygon(g, x0, z0, outer, holes) {
  let za = Infinity, zb = -Infinity;
  for (const [, z] of outer) { if (z < za) za = z; if (z > zb) zb = z; }
  let j0 = Math.floor((za - z0) / SEAL_RES) + PAD;
  let j1 = Math.ceil((zb - z0) / SEAL_RES) + PAD;
  if (j0 < 0) j0 = 0;
  if (j1 > W - 1) j1 = W - 1;
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j - PAD + 0.5) * SEAL_RES;
    xs.length = 0;
    crossings(outer, zc, xs);
    for (const h of holes ?? []) if (h.length >= 3) crossings(h, zc, xs);
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let i0 = Math.ceil((xs[k] - x0) / SEAL_RES - 0.5) + PAD;
      let i1 = Math.floor((xs[k + 1] - x0) / SEAL_RES - 0.5) + PAD;
      if (i0 < 0) i0 = 0;
      if (i1 > W - 1) i1 = W - 1;
      for (let i = i0; i <= i1; i++) g[j * W + i] = 0;
    }
  }
}

function crossings(ring, zc, out) {
  for (let k = 0; k < ring.length; k++) {
    const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
    if ((az <= zc && bz > zc) || (bz <= zc && az > zc))
      out.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
  }
}

/**
 * The same answer as a handful of merged rectangles in world coordinates, for
 * the renderer — one quad per run rather than 3 600 cells. `skip(x, z)` drops
 * cells somebody else already surfaces, so the derived fill and the shipped
 * classifier raster never lay two plates at the same height and z-fight.
 */
export function sealedRects(cell, cx, cz, skip = null) {
  const g = sealedGrid(cell, cx, cz);
  if (!g) return [];
  const x0 = cx * CHUNK, z0 = cz * CHUNK;
  const used = new Uint8Array(N * N);
  const out = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (!g[j * N + i] || used[j * N + i]) continue;
      if (skip && skip(x0 + (i + 0.5) * SEAL_RES, z0 + (j + 0.5) * SEAL_RES)) {
        used[j * N + i] = 1;
        continue;
      }
      // widest run on this row…
      let i1 = i;
      while (i1 + 1 < N && g[j * N + i1 + 1] && !used[j * N + i1 + 1]
        && !(skip && skip(x0 + (i1 + 1.5) * SEAL_RES, z0 + (j + 0.5) * SEAL_RES))) i1++;
      // …then grow it down while every row below is just as wide
      let j1 = j;
      for (;;) {
        const jn = j1 + 1;
        if (jn >= N) break;
        let ok = true;
        for (let k = i; k <= i1; k++) {
          if (!g[jn * N + k] || used[jn * N + k]
            || (skip && skip(x0 + (k + 0.5) * SEAL_RES, z0 + (jn + 0.5) * SEAL_RES))) { ok = false; break; }
        }
        if (!ok) break;
        j1 = jn;
      }
      for (let jj = j; jj <= j1; jj++) for (let k = i; k <= i1; k++) used[jj * N + k] = 1;
      out.push({ x0: x0 + i * SEAL_RES, z0: z0 + j * SEAL_RES,
        x1: x0 + (i1 + 1) * SEAL_RES, z1: z0 + (j1 + 1) * SEAL_RES });
    }
  }
  return out;
}

export const _test = { SEAL_RES, N, W, PAD, CLOSE, HARD, sweep, thickLine };
