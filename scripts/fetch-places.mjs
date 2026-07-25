// ---- Settlement names for the world map ----
// The region tiles carry geometry, not gazetteer: nothing in them says "this
// blob of houses is Sezemice". Place nodes are sparse enough that the whole
// agglomeration fits in ONE Overpass query, so this is a separate, cheap
// fetch rather than another field on the 72 tile downloads.
//
// Output: public/data/places.json — local metres, same origin as everything
// else, sorted big-to-small so a label renderer can draw by importance and
// stop when the map gets crowded.
//
// Usage: node scripts/fetch-places.mjs

import { writeFileSync, mkdirSync } from 'node:fs';

const ORIGIN = { lat: 50.0317084, lon: 15.7560881 };
const M_PER_LAT = 111132.9 - 559.8 * Math.cos(2 * ORIGIN.lat * Math.PI / 180);
const M_PER_LON = 111412.8 * Math.cos(ORIGIN.lat * Math.PI / 180)
  - 93.5 * Math.cos(3 * ORIGIN.lat * Math.PI / 180);

const UA = 'AmongTheCity-dev/0.4 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

// rank drives label size and which names survive a crowded map
const RANK = {
  city: 0, town: 1, village: 2, suburb: 3, borough: 3,
  quarter: 4, neighbourhood: 4, hamlet: 4, isolated_dwelling: 5,
};

const QUERY = `[out:json][timeout:180];
node["place"~"^(city|town|village|hamlet|suburb|borough|quarter|neighbourhood|isolated_dwelling)$"]
  (49.92,15.55,50.26,15.97);
out tags center;`;

async function run(attempt = 0) {
  const url = ENDPOINTS[attempt % ENDPOINTS.length];
  process.stdout.write(`↓ places (${url.split('/')[2]}) … `);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(QUERY),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.elements) throw new Error('no elements[]');
    console.log(`${json.elements.length} elements`);
    return json;
  } catch (err) {
    console.log(`FAILED (${err.message})`);
    if (attempt >= 5) throw err;
    await new Promise(r => setTimeout(r, 8000 + attempt * 6000));
    return run(attempt + 1);
  }
}

const json = await run();
const places = [];
for (const e of json.elements) {
  const name = e.tags?.name;
  if (!name) continue;                      // an unnamed place is no use as a label
  const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon;
  if (lat == null || lon == null) continue;
  places.push({
    n: name,
    t: e.tags.place,
    r: RANK[e.tags.place] ?? 5,
    p: [Math.round((lon - ORIGIN.lon) * M_PER_LON), Math.round((ORIGIN.lat - lat) * M_PER_LAT)],
    pop: e.tags.population ? Number(e.tags.population) || undefined : undefined,
  });
}
// biggest first: the label renderer draws in this order and can simply stop
places.sort((a, b) => a.r - b.r || (b.pop ?? 0) - (a.pop ?? 0));

mkdirSync('public/data', { recursive: true });
writeFileSync('public/data/places.json', JSON.stringify({
  origin: ORIGIN, mPerLat: M_PER_LAT, mPerLon: M_PER_LON, places,
}));
const byType = {};
for (const p of places) byType[p.t] = (byType[p.t] ?? 0) + 1;
console.log(`wrote public/data/places.json — ${places.length} named places`, byType);
