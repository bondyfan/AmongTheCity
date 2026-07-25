// ---- ČÚZK ortofoto downloader for Among The City ----
// Grabs real aerial photos of Pardubice from the ČÚZK WMS (open data, CC BY
// 4.0 — credit "Podkladová data ČÚZK") as 480×480 m "supertiles", one JPEG
// per 4×4 block of streaming chunks. js/ortho.js windows each 120 m chunk's
// UVs into its quarter of the supertile at runtime, so 100 files cover the
// whole playable 4.8×4.8 km square. Idempotent: existing files are skipped,
// so a re-run only fetches what a previous run missed.
//
// Usage: node scripts/fetch-ortho.mjs

import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORTHO } from '../js/config.js';

// resolve everything from the script's location — works from any cwd
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', ORTHO.dir);

// The city JSON carries the local-meters ↔ WGS84 mapping the whole pipeline
// shares: origin is (0,0), mPerLon/mPerLat are meters per degree at Pardubice.
const { origin, mPerLat, mPerLon } =
  JSON.parse(readFileSync(join(ROOT, 'public/data/pardubice.json'), 'utf8'));

const WMS = 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer';
const UA = 'AmongTheCity-dev/0.1 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';

// Supertile (sx, sz) covers x ∈ [sx·T, (sx+1)·T), z ∈ [sz·T, (sz+1)·T) local
// meters. CRS:84 BBOX wants lonW,latS,lonE,latN — and because our z axis
// points SOUTH, the tile's smaller-z edge is its NORTH edge, i.e. the LARGER
// latitude: latN comes from sz·T, latS from (sz+1)·T. Get this backwards and
// every photo arrives mirrored top-to-bottom.
function tileUrl(sx, sz) {
  const T = ORTHO.tile;
  const lonW = origin.lon + (sx * T) / mPerLon;
  const lonE = origin.lon + ((sx + 1) * T) / mPerLon;
  const latN = origin.lat - (sz * T) / mPerLat;
  const latS = origin.lat - ((sz + 1) * T) / mPerLat;
  const bbox = [lonW, latS, lonE, latN].map(v => v.toFixed(7)).join(',');
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=CRS:84`
    + `&BBOX=${bbox}&WIDTH=${ORTHO.px}&HEIGHT=${ORTHO.px}&FORMAT=image/jpeg`;
}

async function download(sx, sz) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(tileUrl(sx, sz), { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // WMS reports its own failures as HTTP 200 + XML ServiceException — a
      // status check alone would happily save XML with a .jpg name
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('image')) throw new Error(`not an image (${type || 'no content-type'})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2000) throw new Error(`suspiciously small (${buf.length} B)`);
      return buf;
    } catch (err) {
      if (attempt >= 3) throw err;
      process.stdout.write(`  retry ${attempt} (${err.message}) … `);
      await new Promise(r => setTimeout(r, 1500 * attempt)); // back off harder each time
    }
  }
}

mkdirSync(OUT, { recursive: true });
// extent 2400 → supertile indices span [−5, 5) on both axes → 10×10 files
const n = ORTHO.extent / ORTHO.tile;
const total = (2 * n) * (2 * n);
let idx = 0, fetched = 0, skipped = 0, failed = 0;
console.log(`ČÚZK ortofoto: ${total} supertiles of ${ORTHO.tile} m → ${OUT}`);

for (let sz = -n; sz < n; sz++) {
  for (let sx = -n; sx < n; sx++) {
    idx++;
    const name = `${sx}_${sz}.jpg`;          // floor indices — "-3_2.jpg" is a fine name
    const file = join(OUT, name);
    if (existsSync(file)) { skipped++; continue; } // idempotent re-runs, no delay either
    process.stdout.write(`[${idx}/${total}] ${name} … `);
    try {
      const buf = await download(sx, sz);
      writeFileSync(file, buf);
      fetched++;
      console.log(`${(buf.length / 1024) | 0} kB`);
    } catch (err) {
      failed++;
      console.log(`FAILED (${err.message})`);
    }
    // sequential + a politeness pause — it's a public state-agency server
    await new Promise(r => setTimeout(r, 400));
  }
}

console.log(`done — ${fetched} downloaded, ${skipped} already present, ${failed} failed`);
if (failed) process.exitCode = 1; // let a wrapper script notice and re-run
