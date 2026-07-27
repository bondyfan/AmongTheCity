// ---- The ground itself: DMR 5G height maps, one per world tile ----
// Everything in this game has been flat since the first commit — Pardubice IS
// Polabí-flat, so y = 0 was an honest simplification. Then the world grew to
// Prague, where the Vltava runs in a valley a hundred metres below Petřín, and
// a flat world stopped being a simplification and became a lie.
//
// ČÚZK publishes the national terrain model as an ArcGIS ImageServer:
//   https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer
// DMR 5G is LiDAR-derived BARE EARTH at 2 m ground sample distance, 9.76 m at
// the Labe to 1603.58 m on Sněžka, free with no conditions attached. Bare earth
// is exactly what a game wants: buildings and trees are removed, so the houses
// this pipeline extrudes sit ON the ground instead of fighting a model that
// already contains them.
//
// THE WIRE FORMAT, established by probing the service (there is no document
// that states it): `format=bsq&pixelType=F32&f=image` answers with
//   width × height × float32 little-endian, row-major, ROW 0 IS NORTH,
//   followed by width × height / 8 bytes of 1-bit validity mask.
// Verified: the payload is exactly w·h floats with zero implausible values, the
// trailing bytes are always n²/8, and a two-pixel probe across the Vyšehrad
// rock matched point `identify` calls on the north and south halves.
//
// SEAMS. The one thing a tiled height map must get right is that neighbours
// agree on their shared edge, to the last bit — a millimetre of disagreement is
// a visible crack you can see the sky through. So samples are placed ON the
// tile's vertex grid, not at pixel centres: the request bbox is grown by half a
// cell all round, which puts pixel centres exactly on multiples of RES. Tile
// (tx,tz)'s last column is then the same world point as (tx+1,tz)'s first, and
// both read the same number because they asked for the same coordinate.
//
// Output: public/data/terrain/<tx>_<tz>.bin — (N×N) int16 little-endian in
// DECIMETRES above sea level. Decimetres because metres visibly terrace a
// gentle slope and float32 would double the size for precision the ground does
// not have; ±3276 m of range covers a country whose roof is 1603 m.
//
// Usage: node scripts/fetch-terrain.mjs [--force]

import { mkdirSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { TILE, wantedTiles, lonOf, latOf } from './lib/world-area.mjs';

const IMG = 'https://ags.cuzk.gov.cz/arcgis2/rest/services/dmr5g/ImageServer/exportImage';
const OUT = 'public/data/terrain';
const UA = 'AmongTheCity-dev/0.6 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';

// 20 m between samples. Czech landforms are hundreds of metres across — Petřín
// is 700 m of hill — so 20 m resolves every shape the player can see, while
// 10 m would quadruple a 21 MB payload for detail that dies in the 120 m chunk
// mesh anyway. N is cells+1 so both edges carry a vertex (see SEAMS above).
export const RES = 20;
export const N = TILE / RES + 1;          // 241 samples per side
const FORCE = process.argv.includes('--force');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchTile(tx, tz, attempt = 0) {
  // grow by half a cell so pixel CENTRES land on the vertex grid
  const x0 = tx * TILE - RES / 2, x1 = (tx + 1) * TILE + RES / 2;
  const z0 = tz * TILE - RES / 2, z1 = (tz + 1) * TILE + RES / 2;
  // our z axis points SOUTH, so the tile's smaller z is its NORTHERN edge
  const bbox = [lonOf(x0), latOf(z1), lonOf(x1), latOf(z0)].map(v => v.toFixed(8)).join(',');
  const url = `${IMG}?bbox=${bbox}&bboxSR=4326&imageSR=4326&size=${N},${N}`
    // adjustAspectRatio=false is NOT optional. A game tile is square in metres
    // but NOT in degrees, and by default the service quietly grows the smaller
    // axis to make its pixels square — measured here as a 55 % stretch in
    // latitude, which would have shipped a terrain that agrees with the map
    // only at the exact centre of each tile and is tens of metres out at the
    // corners. It is the kind of wrong that looks plausible everywhere.
    + '&adjustAspectRatio=false'
    + '&format=bsq&pixelType=F32&noData=&interpolation=RSP_BilinearInterpolation&f=image';
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const need = N * N * 4;
    if (buf.length < need) throw new Error(`short body: ${buf.length} < ${need}`);
    return buf;
  } catch (err) {
    if (attempt >= 5) throw new Error(`${tx},${tz}: ${err.message}`);
    await sleep(1500 + attempt * 2500);
    return fetchTile(tx, tz, attempt + 1);
  }
}

// float32 metres → int16 decimetres, with the service's own NoData mapped to a
// sentinel the runtime knows to treat as "no data here, use the neighbours".
export const NO_DATA = -32768;
function pack(buf) {
  const out = Buffer.allocUnsafe(N * N * 2);
  let lo = Infinity, hi = -Infinity, bad = 0;
  for (let i = 0; i < N * N; i++) {
    const v = buf.readFloatLE(i * 4);
    if (!Number.isFinite(v) || v < -500 || v > 2500) { out.writeInt16LE(NO_DATA, i * 2); bad++; continue; }
    const dm = Math.max(-32767, Math.min(32767, Math.round(v * 10)));
    out.writeInt16LE(dm, i * 2);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { out, lo, hi, bad };
}

mkdirSync(OUT, { recursive: true });
const tiles = wantedTiles();
console.log(`terrain: ${tiles.length} tiles × ${N}×${N} samples at ${RES} m`);

let done = 0, skipped = 0, bytes = 0;
let worldLo = Infinity, worldHi = -Infinity, worldBad = 0;
for (const [tx, tz] of tiles) {
  const file = `${OUT}/${tx}_${tz}.bin`;
  if (!FORCE && existsSync(file) && statSync(file).size === N * N * 2) {
    skipped++; done++;
    continue;
  }
  const raw = await fetchTile(tx, tz);
  const { out, lo, hi, bad } = pack(raw);
  writeFileSync(file, out);
  bytes += out.length;
  worldBad += bad;
  if (lo < worldLo) worldLo = lo;
  if (hi > worldHi) worldHi = hi;
  done++;
  if (done % 10 === 0 || done === tiles.length)
    console.log(`  ${done}/${tiles.length}  (${tx},${tz}) ${lo.toFixed(0)}–${hi.toFixed(0)} m`);
  await sleep(120);                        // be a good citizen of a free service
}

let total = 0;
for (const f of readdirSync(OUT)) if (f.endsWith('.bin')) total += statSync(`${OUT}/${f}`).size;
console.log(`\n${done} tiles (${skipped} already present), world ${worldLo.toFixed(0)}–${worldHi.toFixed(0)} m`
  + `, ${worldBad} samples without data`);
console.log(`${OUT}: ${(total / 1e6).toFixed(1)} MB`);
