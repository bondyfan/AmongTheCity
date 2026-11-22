// ---- Download Mahé's three sources (Frank approved this, 21 Nov 2026) ----
//   OpenStreetMap   Geofabrik's Seychelles extract           ODbL 1.0, © OpenStreetMap contributors
//   Copernicus DEM  GLO-30 tile S05 E055 (AWS open data)     © DLR e.V. 2010-2014 and © Airbus Defence
//                                                             and Space GmbH 2014-2018, provided under
//                                                             COPERNICUS by the European Union and ESA
//   ESA WorldCover  2021 v200 tile S06E054 (AWS open data)   CC BY 4.0, © ESA WorldCover project 2021
// About 6.5 MB together. Into data/regions/mahe/raw/ (gitignored), never anywhere else.
//
//   node scripts/mahe/fetch.mjs

import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';

const RAW = 'data/regions/mahe/raw';
const FILES = [
  ['seychelles.osm.pbf', 'https://download.geofabrik.de/africa/seychelles-latest.osm.pbf', 2e6],
  ['Copernicus_DSM_COG_10_S05_00_E055_00_DEM.tif',
    'https://copernicus-dem-30m.s3.amazonaws.com/Copernicus_DSM_COG_10_S05_00_E055_00_DEM/Copernicus_DSM_COG_10_S05_00_E055_00_DEM.tif', 1e6],
  ['ESA_WorldCover_10m_2021_v200_S06E054_Map.tif',
    'https://esa-worldcover.s3.eu-central-1.amazonaws.com/v200/2021/map/ESA_WorldCover_10m_2021_v200_S06E054_Map.tif', 2e6],
];
mkdirSync(RAW, { recursive: true });
for (const [name, url, min] of FILES) {
  const dest = `${RAW}/${name}`;
  if (existsSync(dest) && statSync(dest).size >= min) { console.log('have', name); continue; }
  const res = await fetch(url, { headers: { 'User-Agent': 'AmongTheCity-data-build/1.0' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < min) throw new Error(`${name}: only ${buf.length} bytes`);
  writeFileSync(dest, buf);
  console.log(`got ${name}: ${(buf.length / 1e6).toFixed(2)} MB`);
}
