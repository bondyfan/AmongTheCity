// ---- Where the trees actually are ----
// The world scatters trees into OSM's landuse polygons, and the scatter itself
// is good — world-anchored, deterministic, multiplayer-safe. The problem is the
// polygons: measured over two full 4.8 km tiles beside Pardubice, 51–52 % of the
// ground carrying real canopy above 3 m has no OSM green polygon at all. Half
// the trees in this country are simply not mapped, so the aerial photo shows a
// wood and the world shows a field.
//
// The photograph cannot answer it either — a shadowed meadow and a wood are the
// same green, and ČÚZK's ortho WMS serves RGB only, so there is no infrared to
// separate them with. What CAN answer it is height, and the height is published:
//
//   DMP  — digital model of the SURFACE, everything included    0.5 m, image correlation
//   DMR 5G — digital model of the bare EARTH, already fetched   2 m, LiDAR
//
// Subtract them and every pixel says how tall the thing standing there is. A
// wood is 8–30 m, a hedge is 3, a meadow is 0. No classifier, no segmentation,
// no guessing — a raster subtraction of two national datasets.
//
// Both answer the exact request shape scripts/fetch-terrain.mjs established for
// DMR 5G, including the non-optional adjustAspectRatio=false. This script is
// deliberately its near-twin: same half-cell bbox growth so neighbours agree on
// their shared edge, same retry, same skip-what-exists.
//
// RESOLUTION. 10 m, half the terrain's 20. A wood is hundreds of metres across
// and its EDGE is what the eye reads, so 10 m places that edge within half a
// tree. Finer would not survive the scatter, which jitters each trunk inside its
// own grid cell anyway.
//
// STORAGE. uint8 in quarter-metres, 0–63.5 m, 255 = no data. A canopy height
// does not need decimetres and this is a raster the client downloads: one byte
// keeps the whole world at ~79 MB against the 561 MB of feature tiles already
// shipped. Anything over 63.5 m is a chimney or a crane, and clamping it to the
// top of the range is the right answer for a tree.
//
// THE CATCH, stated plainly: DMP is photogrammetric and contemporaneous with the
// orthophoto; DMR 5G is LiDAR flown 2009–2013. Where the GROUND itself has moved
// since — a motorway cut, a quarry, a new embankment — the difference is not a
// tree, it is a date mismatch. Those show up as tall smooth blobs, which is why
// the runtime gate is a height AND the scatter's own density rules, not height
// alone.
//
// Usage: node scripts/fetch-canopy.mjs [--force]

import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { TILE, wantedTiles, lonOf, latOf } from './lib/world-area.mjs';

const BASE = 'https://ags.cuzk.gov.cz/arcgis2/rest/services';
const SURFACE = `${BASE}/dmp/ImageServer/exportImage`;      // everything standing
const EARTH = `${BASE}/dmr5g/ImageServer/exportImage`;      // bare ground
const OUT = 'public/data/canopy';
const UA = 'AmongTheCity-dev/0.6 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';

export const RES = 10;                    // m between samples
export const N = TILE / RES + 1;          // 481 per side, both edges inclusive
export const STEP = 0.25;                 // m per stored unit
export const NO_DATA = 255;
const MAX_H = 63.5;                       // (255 − 1) × 0.25, minus the sentinel

const FORCE = process.argv.includes('--force');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function raster(url, tx, tz, attempt = 0) {
  // grow by half a cell so pixel CENTRES land on the vertex grid — the same
  // seam argument as the terrain, and it has to hold for BOTH rasters or the
  // subtraction would be comparing two different places
  const x0 = tx * TILE - RES / 2, x1 = (tx + 1) * TILE + RES / 2;
  const z0 = tz * TILE - RES / 2, z1 = (tz + 1) * TILE + RES / 2;
  // our z axis points SOUTH, so the tile's smaller z is its NORTHERN edge
  const bbox = [lonOf(x0), latOf(z1), lonOf(x1), latOf(z0)].map((v) => v.toFixed(8)).join(',');
  const q = `${url}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${N},${N}`
    + '&adjustAspectRatio=false'
    + '&format=bsq&pixelType=F32&noData=&interpolation=RSP_BilinearInterpolation&f=image';
  try {
    const res = await fetch(q, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const need = N * N * 4;
    if (buf.length < need) throw new Error(`short body: ${buf.length} < ${need}`);
    return buf;
  } catch (err) {
    if (attempt >= 5) throw new Error(`${tx},${tz}: ${err.message}`);
    await sleep(1500 + attempt * 2500);
    return raster(url, tx, tz, attempt + 1);
  }
}

/** surface − earth → quarter-metre bytes, with a running census. */
function subtract(dsm, dtm) {
  const out = Buffer.allocUnsafe(N * N);
  let bad = 0, tall = 0, hi = 0;
  for (let i = 0; i < N * N; i++) {
    const s = dsm.readFloatLE(i * 4), e = dtm.readFloatLE(i * 4);
    if (!Number.isFinite(s) || !Number.isFinite(e)
      || s < -500 || s > 2600 || e < -500 || e > 2500) { out[i] = NO_DATA; bad++; continue; }
    // Negative is not a hole in the ground, it is the two surveys disagreeing;
    // the honest reading of "the surface is below the earth" is "nothing here".
    const h = Math.max(0, Math.min(MAX_H, s - e));
    if (h > 3) tall++;
    if (h > hi) hi = h;
    out[i] = Math.round(h / STEP);
  }
  return { out, bad, tall, hi };
}

mkdirSync(OUT, { recursive: true });
const tiles = wantedTiles();
console.log(`canopy: ${tiles.length} tiles × ${N}×${N} samples at ${RES} m (surface − bare earth)`);

let done = 0, skipped = 0, worldTall = 0, worldCells = 0, worldHi = 0, worldBad = 0;
for (const [tx, tz] of tiles) {
  const file = `${OUT}/${tx}_${tz}.bin`;
  if (!FORCE && existsSync(file) && statSync(file).size === N * N) { skipped++; done++; continue; }
  // sequential on purpose: two requests per tile against a free public service
  const dsm = await raster(SURFACE, tx, tz);
  const dtm = await raster(EARTH, tx, tz);
  const { out, bad, tall, hi } = subtract(dsm, dtm);
  writeFileSync(file, out);
  worldTall += tall; worldCells += N * N; worldBad += bad;
  if (hi > worldHi) worldHi = hi;
  done++;
  if (done % 10 === 0 || done === tiles.length) {
    console.log(`  ${done}/${tiles.length}  (${tx},${tz}) `
      + `${(100 * tall / (N * N)).toFixed(0)}% over 3 m, tallest ${hi.toFixed(0)} m`);
  }
  await sleep(150);                        // be a good citizen of a free service
}

let total = 0;
for (const f of readdirSync(OUT)) if (f.endsWith('.bin')) total += statSync(`${OUT}/${f}`).size;
console.log(`\n${done} tiles (${skipped} already present), `
  + `${(100 * worldTall / Math.max(1, worldCells)).toFixed(1)}% of the world stands over 3 m, `
  + `tallest ${worldHi.toFixed(0)} m, ${worldBad} samples without data`);
console.log(`${OUT}: ${(total / 1e6).toFixed(1)} MB`);
