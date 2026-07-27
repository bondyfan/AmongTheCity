// ---- Prague's real storeys and roof shapes (IPR Praha open data) ----
// OSM gives Prague 447 000 building footprints and a height for barely half of
// them; the rest fall back to the pipeline's "2 storeys ≈ 7.4 m" guess, which
// is how you get a Staré Město where the burgher houses are bungalows and a
// Vinohrady block that is shorter than its own courtyard wall.
//
// The city surveyed all of this itself. IPR Praha publishes "Podlažnosti" —
// 178 775 building footprints carrying the number of storeys (to the cornice
// AND in total), the setback/roof storeys, and a coded roof shape — as open
// data under CC BY. That is exactly the two numbers this engine extrudes from,
// for every building inside the city boundary.
//
// This script reduces that 146 MB GeoJSON to a compact point table that
// build-region.mjs joins onto the OSM footprints:
//   data/ipr-buildings.json  { cell, pts: [x, z, storeys, roof, …] }
// one entry per IPR building, positions in the game's metre frame. The heavy
// GeoJSON stays in data/raw-ipr/ (gitignored, regenerable); only the joined
// result ever ships, baked into the tiles.
//
// ATTRIBUTION: the licence is CC BY and the required credit is
// "datový podklad © IPR Praha" — see README.
//
// Usage: node scripts/fetch-ipr.mjs   (downloads the source if absent)

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { xOf, zOf } from './lib/world-area.mjs';

const DIR = 'data/raw-ipr';
const SRC = `${DIR}/podlaznosti.geojson`;
const OUT = 'data/ipr-buildings.json';
const URL = 'https://opendata.geoportalpraha.cz/api/download/v1/items/'
  + '669fb3aca4bf4129b252eac8552f6054/geojson?layers=0';
const UA = 'AmongTheCity-dev/0.5 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';

// IPR's `strecha` domain → the roof shapes meshes.js already knows. 4
// ("atypická (kombinace)") and 99 ("neurčeno") stay unset: a wrong roof reads
// worse than the flat default, and those are 0.003 % of the city between them.
const ROOF = { 1: 'gabled', 3: 0, 5: 'dome' };   // 0 = explicitly flat

mkdirSync(DIR, { recursive: true });
if (!existsSync(SRC)) {
  process.stdout.write('downloading Podlažnosti (146 MB) … ');
  const res = await fetch(URL, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`IPR download: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(SRC));
  console.log(`${(statSync(SRC).size / 1e6).toFixed(0)} MB`);
}

// The file is one Feature per line, so it streams — JSON.parse on the whole
// 146 MB would cost well over a gigabyte of live objects for data we are about
// to throw away anyway.
const pts = [];
let n = 0, skipped = 0, noStoreys = 0;
const rl = createInterface({ input: createReadStream(SRC), crlfDelay: Infinity });
for await (const raw of rl) {
  const line = raw.trim().replace(/,$/, '');
  if (!line.startsWith('{ "type": "Feature"') && !line.startsWith('{"type":"Feature"')) continue;
  let f;
  try { f = JSON.parse(line); } catch { skipped++; continue; }
  const p = f.properties ?? {};
  // total storeys is the one that decides the ridge height; where it is
  // missing, rebuild it from the cornice count plus any setback storeys
  let st = p.podlaz_celk;
  if (!(st > 0)) st = (p.pocet_podlazi > 0 ? p.pocet_podlazi : 0) + (p.pocet_podlazi_ustup_stres > 0 ? p.pocet_podlazi_ustup_stres : 0);
  if (!(st > 0)) { noStoreys++; continue; }

  // representative point: the area centroid of the largest outer ring. For the
  // L-shaped courtyard blocks that make up half of Prague it can fall in the
  // yard, so build-region falls back to nearest-centroid matching too.
  const g = f.geometry;
  if (!g) { skipped++; continue; }
  const polys = g.type === 'MultiPolygon' ? g.coordinates : g.type === 'Polygon' ? [g.coordinates] : null;
  if (!polys?.length) { skipped++; continue; }
  let best = null, bestA = 0;
  for (const poly of polys) {
    const ring = poly?.[0];
    if (!ring || ring.length < 4) continue;
    let a = 0, cx = 0, cy = 0;
    for (let i = 0, m = ring.length - 1; i < m; i++) {
      const [x1, y1] = ring[i], [x2, y2] = ring[i + 1];
      const cross = x1 * y2 - x2 * y1;
      a += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross;
    }
    if (Math.abs(a) < 1e-12) continue;
    const area = Math.abs(a / 2);
    if (area <= bestA) continue;
    bestA = area;
    best = [cx / (3 * a), cy / (3 * a)];
  }
  if (!best) { skipped++; continue; }

  const roof = ROOF[p.strecha];
  pts.push(
    +xOf(best[0]).toFixed(1), +zOf(best[1]).toFixed(1),
    st, roof === 'gabled' ? 1 : roof === 'dome' ? 2 : roof === 0 ? 3 : 0,
  );
  n++;
}

writeFileSync(OUT, JSON.stringify({ cell: 60, stride: 4, pts }));
console.log(`${OUT}: ${n.toLocaleString()} buildings`
  + ` (${skipped} unusable geometry, ${noStoreys} without a storey count)`
  + ` — ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);
