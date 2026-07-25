// ---- OSM downloader for Among The City ----
// Pulls every layer the game needs for central Pardubice from the Overpass
// API and stores the RAW responses in data/raw/*.json. Processing into the
// game's compact format happens in build-city.mjs, so re-tuning the pipeline
// never re-downloads. Czech OSM carries the full RÚIAN cadastre import —
// every real building footprint with storey counts — which is what makes a
// faithful replica of the city possible at all.
//
// Usage: node scripts/fetch-city.mjs [--bbox S,W,N,E]

import { writeFileSync, mkdirSync } from 'node:fs';

// Central Pardubice: hlavní nádraží sits at (50.0383, 15.7565); the box runs
// east past the old town (Pernštýnské nám., zámek) and north over the Labe
// into Polabiny — ~4.3 km E-W, ~3.8 km N-S.
const BBOX = process.argv.includes('--bbox')
  ? process.argv[process.argv.indexOf('--bbox') + 1]
  : '50.022,15.740,50.056,15.800';

const UA = 'AmongTheCity-dev/0.1 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// Each layer is one Overpass query. `out geom` inlines node coordinates into
// the ways (no separate node lookup pass), and includes full ring geometry
// for relation members — multipolygon buildings (the castle, the station)
// arrive whole.
const LAYERS = {
  buildings: `(
    way["building"](${BBOX});
    relation["building"](${BBOX});
  );out geom;`,
  roads: `(
    way["highway"](${BBOX});
  );out geom;`,
  rails: `(
    way["railway"~"^(rail|tram|light_rail)$"](${BBOX});
  );out geom;`,
  water: `(
    way["natural"="water"](${BBOX});
    relation["natural"="water"](${BBOX});
    way["waterway"~"^(river|stream|canal)$"](${BBOX});
    relation["waterway"="riverbank"](${BBOX});
  );out geom;`,
  green: `(
    way["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green|orchard)$"](${BBOX});
    relation["landuse"~"^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green)$"](${BBOX});
    way["leisure"~"^(park|garden|pitch|playground|golf_course|stadium)$"](${BBOX});
    relation["leisure"~"^(park|garden)$"](${BBOX});
    way["natural"~"^(wood|scrub|grassland)$"](${BBOX});
  );out geom;`,
  paved: `(
    way["amenity"="parking"]["parking"!~"underground|multi-storey"](${BBOX});
    way["highway"="pedestrian"]["area"="yes"](${BBOX});
    way["place"="square"](${BBOX});
  );out geom;`,
  trees: `(
    node["natural"="tree"](${BBOX});
    way["natural"="tree_row"](${BBOX});
  );out geom;`,
  pois: `(
    node["railway"="station"](${BBOX});
    node["highway"="bus_stop"](${BBOX});
    node["railway"="tram_stop"](${BBOX});
    node["amenity"~"^(fuel|hospital|police|fire_station)$"](${BBOX});
    way["amenity"~"^(fuel|hospital|police|fire_station)$"](${BBOX});
  );out geom;`,
};

async function fetchLayer(name, body, attempt = 0) {
  const url = ENDPOINTS[attempt % ENDPOINTS.length];
  const query = `[out:json][timeout:180];${body}`;
  process.stdout.write(`↓ ${name} (${url.split('/')[2]}) … `);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.elements) throw new Error('no elements[] in response');
    console.log(`${json.elements.length} elements`);
    return json;
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    if (attempt >= 5) throw new Error(`${name}: giving up after ${attempt + 1} tries`);
    // Overpass rate-limits aggressively — back off, rotate endpoints
    await new Promise(r => setTimeout(r, 8000 + attempt * 7000));
    return fetchLayer(name, body, attempt + 1);
  }
}

mkdirSync('data/raw', { recursive: true });
console.log(`bbox ${BBOX}`);
for (const [name, body] of Object.entries(LAYERS)) {
  const json = await fetchLayer(name, body);
  writeFileSync(`data/raw/${name}.json`, JSON.stringify(json));
  await new Promise(r => setTimeout(r, 2500)); // be polite between queries
}
console.log('done — raw layers in data/raw/');
