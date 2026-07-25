// ---- Region downloader: the whole Pardubice–Hradec–Chrudim agglomeration ----
// The single-city fetch grew up: the playable world now spans lat 49.92–50.26,
// lon 15.55–15.97 (~30×38 km) — all of Pardubice and Hradec Králové, Chrudim,
// and every village between (Sezemice, Kunětice, Ráby/Zástava, Brozany, Staré
// Hradiště, Dříteč…). One Overpass query per 4.8 km data tile pulls EVERY
// layer at once; raw responses land in data/raw-region/<tx>_<tz>.json and are
// processed by build-region.mjs into runtime-streamable tiles. Re-runnable:
// existing raw files are skipped, so a crashed run just resumes.
//
// Usage: node scripts/fetch-region.mjs   (builds the runtime tiles when done)

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const ORIGIN = { lat: 50.0317084, lon: 15.7560881 }; // Pardubice hl.n. — the one world origin
const M_PER_LAT = 111132.9 - 559.8 * Math.cos(2 * ORIGIN.lat * Math.PI / 180);
const M_PER_LON = 111412.8 * Math.cos(ORIGIN.lat * Math.PI / 180) - 93.5 * Math.cos(3 * ORIGIN.lat * Math.PI / 180);

const TILE = 4800;               // meters per data tile
const REGION = { latS: 49.92, latN: 50.26, lonW: 15.55, lonE: 15.97 };

const UA = 'AmongTheCity-dev/0.2 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// local meters ↔ geo (z south-positive, matching the game frame)
const xOf = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
const zOf = (lat) => (ORIGIN.lat - lat) * M_PER_LAT;
const lonOf = (x) => ORIGIN.lon + x / M_PER_LON;
const latOf = (z) => ORIGIN.lat - z / M_PER_LAT;

// everything the game eats, one union — buildings, roads, rails, water,
// green, paved, trees, pois AND traffic signals (new: semafory)
const tileQuery = (bbox) => `[out:json][timeout:240][maxsize:536870912];(
  way["building"](${bbox});
  relation["building"](${bbox});
  way["highway"](${bbox});
  node["highway"="traffic_signals"](${bbox});
  way["railway"~"^(rail|tram|light_rail)$"](${bbox});
  way["natural"="water"](${bbox});
  relation["natural"="water"](${bbox});
  way["waterway"~"^(river|stream|canal)$"](${bbox});
  relation["waterway"="riverbank"](${bbox});
  way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green|orchard|farmland)$"](${bbox});
  relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green)$"](${bbox});
  way["leisure"~"^(park|garden|pitch|playground|golf_course|stadium)$"](${bbox});
  relation["leisure"~"^(park|garden)$"](${bbox});
  way["natural"~"^(wood|scrub|grassland)$"](${bbox});
  way["amenity"="parking"]["parking"!~"underground|multi-storey"](${bbox});
  way["highway"="pedestrian"]["area"="yes"](${bbox});
  way["place"="square"](${bbox});
  node["natural"="tree"](${bbox});
  way["natural"="tree_row"](${bbox});
  node["railway"="station"](${bbox});
  node["highway"="bus_stop"](${bbox});
  node["amenity"~"^(fuel|hospital|police|fire_station)$"](${bbox});
);out geom;`;

async function fetchTile(name, bbox, attempt = 0) {
  const url = ENDPOINTS[attempt % ENDPOINTS.length];
  process.stdout.write(`↓ ${name} (${url.split('/')[2]}) … `);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(tileQuery(bbox)),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.elements) throw new Error('no elements[]');
    console.log(`${json.elements.length} elements`);
    return json;
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    if (attempt >= 6) throw new Error(`${name}: giving up`);
    await new Promise(r => setTimeout(r, 10000 + attempt * 8000));
    return fetchTile(name, bbox, attempt + 1);
  }
}

mkdirSync('data/raw-region', { recursive: true });
// tile grid over the region, in the LOCAL meter frame
const txMin = Math.floor(xOf(REGION.lonW) / TILE), txMax = Math.floor(xOf(REGION.lonE) / TILE);
const tzMin = Math.floor(zOf(REGION.latN) / TILE), tzMax = Math.floor(zOf(REGION.latS) / TILE);
const jobs = [];
for (let tz = tzMin; tz <= tzMax; tz++)
  for (let tx = txMin; tx <= txMax; tx++) jobs.push([tx, tz]);
// SPAWN FIRST: the game reads the manifest as soon as tiles exist, so the
// playable core (Pardubice, around tile 0,0/−1) must land before the distant
// countryside — sort by distance from the origin tile, spiralling outward
jobs.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2));
console.log(`region tiles: x ${txMin}..${txMax}, z ${tzMin}..${tzMax} → ${jobs.length} tiles`);

let done = 0, skipped = 0;
for (const [tx, tz] of jobs) {
  const file = `data/raw-region/${tx}_${tz}.json`;
  if (existsSync(file)) { skipped++; done++; continue; }
  // bbox: south lat from larger z, north from smaller z
  const bbox = [latOf((tz + 1) * TILE), lonOf(tx * TILE), latOf(tz * TILE), lonOf((tx + 1) * TILE)]
    .map(v => v.toFixed(6)).join(',');
  const json = await fetchTile(`${tx}_${tz} [${++done}/${jobs.length}]`, bbox);
  writeFileSync(file, JSON.stringify(json));
  await new Promise(r => setTimeout(r, 1800));
}
console.log(`done — ${done} tiles (${skipped} already present)`);

// Build straight away. Downloading and building were two commands, and the
// gap between them is exactly where a whole region went missing: 46 tiles sat
// on disk while the game still shipped the 26 built days earlier, so every
// village outside Pardubice looked unmapped. Downloading data the game cannot
// see is not a useful end state, so the fetch owns the build.
console.log('\nbuilding runtime tiles…');
const { spawnSync } = await import('node:child_process');
const r = spawnSync(process.execPath, ['scripts/build-region.mjs'], { stdio: 'inherit' });
process.exit(r.status ?? 0);
