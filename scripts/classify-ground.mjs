// ---- what is the ground where nobody said? --------------------------------
// Measured over a 180 m circle on Pardubice main station, 95 % of the ground
// carries no OSM polygon at all — not after adding platforms, not after adding
// works yards, not after anything. OSM simply does not map the square in front
// of the station, and the runtime's fallback ("ground nobody mapped is a
// field") turns a paved forecourt into a lawn.
//
// Two geometric inferences were tried first and both were MEASURED to fail: the
// forecourt has 0 % road coverage within 25 m while a suburban garden has 65 %,
// so "is this circulation space" separates nothing, and "how close is the
// nearest building" puts a garden and a forecourt within 5 m of each other.
// There is no shape-of-the-data answer here.
//
// What is left is the photograph. It cannot say what a thing IS — that is why
// the world stopped being built out of it — but it can say what COLOUR the
// ground is, and green against grey is exactly the distinction that is missing.
//
// So the photograph is asked ONCE, here, offline, and never again: the answer
// is vectorised into ordinary polygons in the tile, indistinguishable from the
// ones OSM supplied, and the game ships without a photograph in it.
//
// HOW IT DECIDES, and it is deliberately crude, because a crude answer with a
// known failure mode beats a clever one without:
//   · anything OSM already covers is skipped — it has a better source
//   · green (2G − R − B, the standard excess-green index) → leave it as field
//   · not green and bright  → paving / concrete
//   · not green and dark    → asphalt
// then open-close the raster to kill speckle, and emit only regions above a
// minimum area, because a 4 m² patch of "paving" in a meadow is a shadow.
//
// Usage: node scripts/classify-ground.mjs [--tiles="-1,-1 0,-2"] [--dry]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { decodePNG } from './lib/png.mjs';

const TILE = 4800;
const RES = 4;                          // m per classified cell
const N = TILE / RES;                   // 1200 cells a side
const PX = 1200;                        // pixels per WMS request…
const SPAN = TILE / 2;                  // …covering this many metres (2 m/px)
// Tuned against the Pardubice station square, where the paved strips between
// the footways are about ten metres wide: closing with a radius of 2 (an 8 m
// erosion) ate them and put the grass fallback back up from 22 % to 42 %.
const MIN_AREA = 80;                    // m² — under this it is a shadow
// Closing radius, in cells — 4 m, narrower than any real strip. Measured with
// roads no longer stamped out, in case that had changed the answer: closing by
// 2 cuts the tile from 8 682 polygons to 6 233, and takes the paving in front
// of Pardubice station from 33 % of the square back down to 17 %. It eats the
// thing it is there to find. Stays at 1.
const CLOSE_R = 1;
const WMS = 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer';
const UA = 'AmongTheCity-dev/0.7 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';
const DIR = 'public/data/tiles';
// The photograph is the slow part and the classifier is the part being tuned,
// so the download is cached on disk. Gitignored, throwaway, and it turns a
// forty-second iteration into a two-second one.
const CACHE = 'data/raw-ortho';

const ONLY = (process.argv.find((a) => a.startsWith('--tiles=')) ?? '').slice(8).split(/\s+/).filter(Boolean);
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the photograph --------------------------------------------------------

async function fetchQuadrant(tile, qx, qz) {
  const { origin, mPerLat, mPerLon } = tile;
  const x0 = tile.tx * TILE + qx * SPAN, z0 = tile.tz * TILE + qz * SPAN;
  const lonW = origin.lon + x0 / mPerLon, lonE = origin.lon + (x0 + SPAN) / mPerLon;
  // our z axis points SOUTH, so the smaller z is the NORTHERN edge
  const latN = origin.lat - z0 / mPerLat, latS = origin.lat - (z0 + SPAN) / mPerLat;
  const url = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=CRS:84`
    + `&BBOX=${[lonW, latS, lonE, latN].map((v) => v.toFixed(7)).join(',')}`
    + `&WIDTH=${PX}&HEIGHT=${PX}&FORMAT=image/png`;
  mkdirSync(CACHE, { recursive: true });
  const hit = `${CACHE}/${tile.tx}_${tile.tz}_${qx}${qz}.png`;
  if (existsSync(hit)) return decodePNG(readFileSync(hit));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // the WMS reports its own failures as HTTP 200 + an XML ServiceException
      if (buf[0] !== 0x89) throw new Error('not an image: ' + buf.toString('latin1', 0, 120));
      writeFileSync(hit, buf);
      return decodePNG(buf);
    } catch (err) {
      if (attempt >= 4) throw new Error(`${tile.tx},${tile.tz} q${qx}${qz}: ${err.message}`);
      await sleep(1500 + attempt * 2500);
    }
  }
}

// ---- what OSM already answers for -----------------------------------------
// Exactly the layers whose ground the runtime already draws. Anything stamped
// here is left alone: OSM stood on it and the photograph did not.

const COVERED = 1, GRASS = 2, PAVING = 3, ASPHALT = 4, DIRT = 5, CLAIMED = 6, UNKNOWN = 7;

function stampCovered(mask, tile) {
  const x0 = tile.tx * TILE, z0 = tile.tz * TILE;
  const poly = (o, holes) => fillPolygon(mask, x0, z0, o, holes, COVERED);
  for (const f of tile.buildings) if (f.o?.length >= 3) poly(f.o, f.i);
  for (const f of tile.paved) if (f.o?.length >= 3) poly(f.o, f.i);
  for (const f of tile.water) if (f.o?.length >= 3) poly(f.o, f.i);
  // GREEN is not covered — it is a CLAIM, and the photograph gets to dispute it.
  // The courtyard at Pardubice hlavní nádraží is tagged landuse=grass and is a
  // grey concrete rectangle in the orthophoto; trusting the tag drew a lawn over
  // it. OSM's green polygons are drawn generously, around whole blocks, and are
  // the one layer here that is routinely wrong about its own inside.
  //
  // Buildings, water and paved stay covered: those are structural, OSM is
  // reliable about them, and a photograph cannot see under a roof anyway.
  for (const f of tile.green) if (f.o?.length >= 3) fillPolygon(mask, x0, z0, f.o, f.i, CLAIMED);
  // ROADS ARE NOT COVERED EITHER, and this was the whole of the remaining bug.
  //
  // Traced at the exact spot the user reported, x 18.1 z −118.4 in front of
  // Pardubice station: the photograph there is RGB 176,175,171 — bright neutral
  // grey, paving, exactly as reported — and the classifier never looked at it,
  // because the cell was stamped COVERED by a two-metre footway. Cells are 4 m,
  // so a cell is blanked whenever its CENTRE falls within the corridor: a 2 m
  // path takes out a 4 m swath, and the ribbon drawn over it is 2 m wide. The
  // difference showed as a lawn down both sides of every path in the city.
  //
  // Narrowing the corridor only moves the error. Removing it costs nothing: a
  // road ribbon draws at LAYER_Y.road, well above this layer, so ground
  // inferred underneath one is invisible — and the margins either side, which
  // are the part you can actually see, finally get classified.
  //
  // Rails keep their stamp: ballast is not a surface the photograph can read
  // usefully, and the sleepers alias into stripes of "paving".
  for (const f of tile.rails) stampLine(mask, x0, z0, f.p, 2);
}

function fillPolygon(m, x0, z0, outer, holes, value) {
  let za = Infinity, zb = -Infinity;
  for (const [, z] of outer) { if (z < za) za = z; if (z > zb) zb = z; }
  const j0 = Math.max(0, Math.floor((za - z0) / RES));
  const j1 = Math.min(N - 1, Math.ceil((zb - z0) / RES));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * RES;
    xs.length = 0;
    crossings(outer, zc, xs);
    for (const h of holes ?? []) if (h.length >= 3) crossings(h, zc, xs);
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / RES - 0.5));
      const i1 = Math.min(N - 1, Math.floor((xs[k + 1] - x0) / RES - 0.5));
      for (let i = i0; i <= i1; i++) m[j * N + i] = value;
    }
  }
}

function crossings(ring, zc, out) {
  for (let k = 0; k < ring.length; k++) {
    const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
    if ((az <= zc) === (bz <= zc)) continue;
    out.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
  }
}

function stampLine(m, x0, z0, pts, hw) {
  if (!pts || pts.length < 2) return;
  const hw2 = hw * hw;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - x0) / RES));
    const i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + hw - x0) / RES));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - z0) / RES));
    const j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + hw - z0) / RES));
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * RES;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * RES;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
        if (ex * ex + ez * ez <= hw2) m[j * N + i] = COVERED;
      }
    }
  }
}

// ---- the classifier --------------------------------------------------------

const warmOf = (r, b) => r - b;

/** Average a 2×2 block of 2 m pixels into one 4 m cell, then decide. */
function classify(mask, quads) {
  let green = 0, paving = 0, asphalt = 0, dirt = 0, unknown = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const claim = mask[j * N + i];
      if (claim && claim !== CLAIMED) continue;
      const qx = i < N / 2 ? 0 : 1, qz = j < N / 2 ? 0 : 1;
      const img = quads[qz * 2 + qx];
      if (!img) continue;
      // the cell's own 2×2 patch of 2 m pixels inside that quadrant
      const px0 = (i - qx * (N / 2)) * 2, pz0 = (j - qz * (N / 2)) * 2;
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const o = ((pz0 + dy) * img.w + (px0 + dx)) * 3;
          r += img.rgb[o]; g += img.rgb[o + 1]; b += img.rgb[o + 2];
        }
      }
      r /= 4; g /= 4; b /= 4;
      // Excess green — the standard index for separating vegetation from
      // everything else in plain RGB, and the reason this works at all: a lawn
      // and a concrete apron are both mid-grey in luminance and nothing alike
      // in this.
      const exg = 2 * g - r - b;
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      // WARM means soil. This is the correction that mattered: a ploughed field
      // in October is dark brown, and luminance alone called a quarter of the
      // Pardubice tile asphalt — which would have tarmacked the countryside.
      // Tarmac is NEUTRAL grey, r ≈ g ≈ b; earth is not, and the red-blue gap
      // is what says so.
      const warm = warmOf(r, b);
      // Overruling OSM takes MORE evidence than filling a blank. A park with a
      // dry August patch must stay a park; only ground that is both plainly
      // colourless and plainly bright — concrete, not shadow, not soil — is
      // allowed to take a green tag off the map.
      if (claim === CLAIMED) {
        if (exg < 6 && lum > 96 && Math.abs(warmOf(r, b)) < 24) { mask[j * N + i] = PAVING; paving++; }
        else { mask[j * N + i] = GRASS; green++; }
        continue;
      }
      // ---- TOO DARK TO JUDGE is not the same as GRASS -----------------------
      // Measured at the exact spot the user reported, x 18.1 z −118.4 in front
      // of Pardubice station: r 23, g 34, b 38 — luminance 31. That is the tree
      // row's shadow, and the old guard ("cool and dark is water or shadow,
      // leave it as field") turned every shaded pavement in the city into a
      // lawn. A photograph taken at nine in the morning shadows one side of
      // every street, so this was not an edge case.
      //
      // Darkness carries no colour information, so it is recorded as UNKNOWN
      // and filled in afterwards from the ground AROUND it — a shadow in the
      // middle of a forecourt is forecourt, a shadow in the middle of a lawn is
      // lawn. That is the only honest reading of a pixel with no signal in it.
      if (lum < 62) { mask[j * N + i] = UNKNOWN; unknown++; }
      else if (exg > 18) { mask[j * N + i] = GRASS; green++; }
      else if (warm > 14) { mask[j * N + i] = DIRT; dirt++; }
      // Real water: distinctly blue, not merely unlit.
      else if (b > r + 18 && lum < 100) { mask[j * N + i] = GRASS; green++; }
      else if (lum > 105) { mask[j * N + i] = PAVING; paving++; }
      else { mask[j * N + i] = ASPHALT; asphalt++; }
    }
  }
  return { green, paving, asphalt, dirt, unknown };
}

/**
 * Fill UNKNOWN cells from their neighbours, a ring at a time.
 *
 * Everything that is in shadow in the photograph lands here, which in a city
 * photographed in the morning is one side of every street. The rule is a plain
 * majority of the eight neighbours, applied repeatedly, so a shaded strip takes
 * the surface of the ground it is a strip OF, and grows inward from both edges
 * at once. Cells still unknown after `rounds` are left alone — that is a shadow
 * wider than 2·rounds cells with nothing identifiable anywhere near it, and the
 * field fallback is the safer wrong answer for those.
 */
function inpaint(mask, rounds = 14) {
  const vote = new Int32Array(8);
  for (let pass = 0; pass < rounds; pass++) {
    const next = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (mask[j * N + i] !== UNKNOWN) continue;
        vote.fill(0);
        let best = 0, bestN = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const jj = j + dj, ii = i + di;
            if (jj < 0 || jj >= N || ii < 0 || ii >= N) continue;
            const v = mask[jj * N + ii];
            if (v !== GRASS && v !== PAVING && v !== ASPHALT && v !== DIRT) continue;
            if (++vote[v] > bestN) { bestN = vote[v]; best = v; }
          }
        }
        if (best) next.push(j * N + i, best);
      }
    }
    if (!next.length) break;
    for (let k = 0; k < next.length; k += 2) mask[next[k]] = next[k + 1];
  }
  let left = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k] === UNKNOWN) { mask[k] = 0; left++; }
  return left;
}

/**
 * Morphological CLOSE of one class: dilate by `r` then erode by `r`. It joins
 * patches separated by a cell or two — a paved yard cut up by a shadow, a
 * forecourt nibbled by the corridor of every footway crossing it — without
 * growing the region's outer edge.
 *
 * This is what makes the output shippable: without it the Pardubice tile
 * vectorised into 8 760 rectangles and took thirty seconds to load. The regions
 * were right; they were just shattered.
 */
function close(mask, want, r) {
  const grow = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (mask[j * N + i] !== want) continue;
      for (let dj = -r; dj <= r; dj++) {
        const y = j + dj;
        if (y < 0 || y >= N) continue;
        for (let di = -r; di <= r; di++) {
          const x = i + di;
          // never dilate over ground OSM already answered for
          if (x >= 0 && x < N && mask[y * N + x] !== COVERED) grow[y * N + x] = 1;
        }
      }
    }
  }
  const out = new Uint8Array(N * N);
  for (let j = r; j < N - r; j++) {
    for (let i = r; i < N - r; i++) {
      if (!grow[j * N + i]) continue;
      let all = 1;
      for (let dj = -r; dj <= r && all; dj++)
        for (let di = -r; di <= r; di++)
          if (!grow[(j + dj) * N + i + di]) { all = 0; break; }
      if (all) out[j * N + i] = want;
    }
  }
  return out;
}

/** Majority filter — removes single-cell speckle without moving real edges. */
function despeckle(mask) {
  const out = Uint8Array.from(mask);
  for (let j = 1; j < N - 1; j++) {
    for (let i = 1; i < N - 1; i++) {
      const v = mask[j * N + i];
      if (v === 0 || v === COVERED) continue;
      const tally = new Map();
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const u = mask[(j + dj) * N + i + di];
          if (u && u !== COVERED) tally.set(u, (tally.get(u) ?? 0) + 1);
        }
      }
      let best = v, bn = 0;
      for (const [k, n] of tally) if (n > bn) { bn = n; best = k; }
      out[j * N + i] = best;
    }
  }
  return out;
}

// ---- vectorise -------------------------------------------------------------
// Greedy maximal rectangles. Not the prettiest decomposition, but the regions
// are inferred and mostly bounded by roads and buildings that draw on top of
// them, and rectangles cost four points each and can never self-intersect.

function rectangles(mask, want, x0, z0) {
  const used = new Uint8Array(N * N);
  const out = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (used[j * N + i] || mask[j * N + i] !== want) continue;
      // The LARGEST rectangle anchored here, not the first one that is as wide
      // as it can be. Taking maximum width and then growing down cuts an
      // irregular region into a staircase of slivers — on the Pardubice tile
      // that was 8 777 rectangles where the same ground fits in a fraction of
      // them, and the count is what the client pays to load and to index.
      let w = 0;
      while (i + w < N && !used[j * N + i + w] && mask[j * N + i + w] === want) w++;
      let bw = w, bh = 1, best = w;
      let run = w;
      for (let h = 2; j + h - 1 < N; h++) {
        let k = 0;
        while (k < run) {
          const o = (j + h - 1) * N + i + k;
          if (used[o] || mask[o] !== want) break;
          k++;
        }
        if (!k) break;
        run = k;                                    // the widest this deep
        if (run * h > best) { best = run * h; bw = run; bh = h; }
      }
      w = bw;
      const h = bh;
      for (let dj = 0; dj < h; dj++) for (let di = 0; di < w; di++) used[(j + dj) * N + i + di] = 1;
      if (w * h * RES * RES < MIN_AREA) continue;
      const ax = x0 + i * RES, az = z0 + j * RES;
      const bx = ax + w * RES, bz = az + h * RES;
      out.push([[ax, az], [bx, az], [bx, bz], [ax, bz]]);
    }
  }
  return out;
}

// ---- per tile --------------------------------------------------------------

const tiles = readdirSync(DIR).filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((k) => !ONLY.length || ONLY.includes(k.replace('_', ',')));

console.log(`classifying ${tiles.length} tiles from the ČÚZK orthophoto at ${RES} m`);
let done = 0, added = 0;
for (const key of tiles) {
  const file = `${DIR}/${key}.json`;
  const tile = JSON.parse(readFileSync(file, 'utf8'));
  // re-runnable: drop what a previous run inferred before inferring again
  tile.paved = tile.paved.filter((f) => f.t !== 'inferred');

  const mask = new Uint8Array(N * N);
  stampCovered(mask, tile);
  const open = mask.reduce((a, v) => a + (v ? 0 : 1), 0);
  if (open < 400) { done++; continue; }        // nothing worth a download

  const quads = [];
  for (let qz = 0; qz < 2; qz++) for (let qx = 0; qx < 2; qx++) quads.push(await fetchQuadrant(tile, qx, qz));
  // --probe=x,z ... : say exactly what happened to those cells. Guessing why a
  // classifier said what it said is how an afternoon disappears.
  const probes = process.argv.filter((a) => a.startsWith('--probe='))
    .map((a) => a.slice(8).split(',').map(Number));
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    const before = mask[j * N + i];
    const qx = i < N / 2 ? 0 : 1, qz = j < N / 2 ? 0 : 1;
    const img = quads[qz * 2 + qx];
    const ix = (i - qx * (N / 2)) * 2, iz = (j - qz * (N / 2)) * 2;
    const o = (iz * img.w + ix) * 3;
    const r = img.rgb[o], g = img.rgb[o + 1], b = img.rgb[o + 2];
    console.log(`  probe ${px},${pz}: cell ${i},${j} covered=${before} rgb=${r},${g},${b}`
      + ` exg=${(2 * g - r - b).toFixed(0)} lum=${(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(0)}`
      + ` warm=${r - b}`);
  }
  const stats = classify(mask, quads);
  const NAME = { 0: 'open', 1: 'covered', 2: 'grass', 3: 'paving', 4: 'asphalt', 5: 'dirt', 6: 'claimed', 7: 'SHADOW' };
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    console.log(`    → classified as ${NAME[mask[j * N + i]]}`);
  }
  // Shadow gets the surface of what surrounds it — see inpaint().
  const dark = inpaint(mask);
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    console.log(`    → after in-painting ${NAME[mask[j * N + i]]}`);
  }
  const clean = despeckle(mask);
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    console.log(`    → after despeckle ${NAME[clean[j * N + i]]}`);
  }

  const x0 = tile.tx * TILE, z0 = tile.tz * TILE;
  const before = tile.paved.length;
  for (const [want, s] of [[PAVING, 'paving'], [ASPHALT, 'asphalt'], [DIRT, 'dirt']]) {
    const joined = close(clean, want, CLOSE_R);
    for (const o of rectangles(joined, want, x0, z0)) tile.paved.push({ o, t: 'inferred', s });
  }
  const n = tile.paved.length - before;
  added += n;
  if (!DRY) writeFileSync(file, JSON.stringify(tile));
  done++;
  console.log(`  ${key}: ${(100 * open / (N * N)).toFixed(0)}% unmapped → `
    + `${stats.green} field, ${stats.dirt} dirt, ${stats.paving} paving, ${stats.asphalt} asphalt`
    + `, ${stats.unknown} in shadow (${dark} of them still unread) → ${n} polygons`);
  await sleep(200);                            // be a good citizen of a free service
}
console.log(`\n${done} tiles, ${added} inferred polygons${DRY ? ' (dry run, nothing written)' : ''}`);
