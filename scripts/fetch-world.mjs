// ---- One command for the whole world ----
// The world is the D11 corridor from Prague to Hradec Králové and down to
// Pardubice: 185 tiles of OpenStreetMap. Getting it used to mean 185 Overpass
// queries; it is now four Geofabrik downloads and two local passes, which is
// both minutes instead of hours and immune to a public API having a bad day.
//
//   1. download the regional .osm.pbf extracts (skipped if already on disk)
//   2. split them into per-tile raw JSON        (scripts/split-extracts.mjs)
//   3. fetch Prague's storeys and roof shapes   (scripts/fetch-ipr.mjs)
//   3b. fetch the terrain height maps          (scripts/fetch-terrain.mjs)
//   4. process those into the runtime tiles     (scripts/build-region.mjs)
//   5. rebuild the world-map gazetteer          (scripts/fetch-places.mjs)
//
// Step 3 is what keeps Prague from flattening back into a village on the next
// rebuild: the IPR join lives in build-region, but its input is gitignored, so
// a fresh clone that skipped it would quietly emit 110 000 guessed buildings.
//
// Re-runnable: step 1 skips what it has, and steps 2–4 are pure functions of
// what is on disk. Pass --refresh to re-download the extracts (Geofabrik
// rebuilds them daily, so that is how the world gets a data update).
//
// Usage: node scripts/fetch-world.mjs [--refresh]

import { mkdirSync, existsSync, statSync, createWriteStream, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const OSM_DIR = 'data/raw-osm';
const UA = 'AmongTheCity-dev/0.5 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';
// Which extracts the world needs. Praha and Středočeský carry the corridor and
// the capital; Královéhradecký and Pardubický carry the home ground. Together
// they cover the whole envelope in scripts/lib/world-area.mjs with room to
// spare — a way crossing a region border is complete in both files.
const REGIONS = ['praha', 'stredocesky', 'kralovehradecky', 'pardubicky'];
const BASE = 'https://download.geofabrik.de/europe/czech-republic';

const refresh = process.argv.includes('--refresh');
mkdirSync(OSM_DIR, { recursive: true });

async function download(region) {
  const file = `${OSM_DIR}/${region}.osm.pbf`;
  if (existsSync(file) && !refresh) {
    console.log(`  ${region}: have it (${(statSync(file).size / 1e6).toFixed(0)} MB)`);
    return;
  }
  const url = `${BASE}/${region}-latest.osm.pbf`;
  process.stdout.write(`  ${region}: downloading … `);
  // Geofabrik answers -latest with a 302 to the dated file, and fetch follows
  // redirects by default. A partial file left behind by a dropped connection
  // would break the parser in a confusing way, so write to a temp name and
  // only move it into place once the body is complete.
  const tmp = `${file}.part`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${region}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const { renameSync } = await import('node:fs');
  renameSync(tmp, file);
  console.log(`${(statSync(file).size / 1e6).toFixed(0)} MB`);
}

console.log('extracts:');
for (const r of REGIONS) {
  try { await download(r); } catch (err) {
    console.error(`\n${err.message}`);
    const tmp = `${OSM_DIR}/${r}.osm.pbf.part`;
    if (existsSync(tmp)) unlinkSync(tmp);
    process.exit(1);
  }
}

const step = (label, script) => {
  console.log(`\n${label}`);
  const r = spawnSync(process.execPath, ['--max-old-space-size=8192', script], { stdio: 'inherit' });
  if (r.status) process.exit(r.status);
};
step('splitting extracts into raw tiles…', 'scripts/split-extracts.mjs');
step('fetching Prague storeys + roofs (IPR)…', 'scripts/fetch-ipr.mjs');
step('fetching the terrain (ČÚZK DMR 5G)…', 'scripts/fetch-terrain.mjs');
step('building runtime tiles…', 'scripts/build-region.mjs');
step('rebuilding the gazetteer…', 'scripts/fetch-places.mjs');
console.log('\nworld rebuilt — public/data/{tiles,terrain,manifest.json,overview.json,places.json}');
