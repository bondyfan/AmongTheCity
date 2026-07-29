// ---- Settlement names for the world map ----
// The region tiles carry geometry, not gazetteer: nothing in them says "this
// blob of houses is Sezemice". Place nodes are sparse, so this stays a separate
// cheap pass rather than another field on 185 tile files.
//
// It used to be one Overpass query over a 30 km box. The world now runs from
// Prague to Hradec, and the same extracts that build the tiles
// (scripts/lib/osmpbf.mjs) already hold every place node in the country — so
// this reads them off disk instead, which is both faster and immune to
// Overpass telling us the server is too busy.
//
// Output: public/data/places.json — local metres, same origin as everything
// else, sorted big-to-small so the label renderer can draw by importance and
// stop when the map gets crowded.
//
// Usage: node scripts/fetch-places.mjs   (needs data/raw-osm/*.osm.pbf)

import { writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { readPbf } from './lib/osmpbf.mjs';
import { ORIGIN, M_PER_LAT, M_PER_LON, TILE, xOf, zOf, tileWanted } from './lib/world-area.mjs';

// rank drives label size and which names survive a crowded map
const RANK = {
  city: 0, town: 1, village: 2, suburb: 3, borough: 3,
  quarter: 4, neighbourhood: 4, hamlet: 4, isolated_dwelling: 5,
};
const PLACE = /^(city|town|village|hamlet|suburb|borough|quarter|neighbourhood|isolated_dwelling)$/;

const OSM_DIR = 'data/raw-osm';
const files = readdirSync(OSM_DIR).filter(f => f.endsWith('.osm.pbf')).map(f => `${OSM_DIR}/${f}`);
if (!files.length) {
  console.error(`no .osm.pbf in ${OSM_DIR} — run: node scripts/fetch-world.mjs`);
  process.exit(1);
}

// The extracts overlap along their shared borders, so the same village can
// arrive twice; a node id is the identity that survives that.
const seen = new Set();
const places = [];
for (const f of files) {
  let n = 0;
  readPbf(f, {
    onNode(id, lat, lon, tags) {
      if (!tags || !PLACE.test(tags.place ?? '') || !tags.name) return;
      // The world's SHAPE, not its bounding box. The envelope now spans most of
      // Moravia, and labelling Jihlava or Šumperk on a map that has no data
      // there is worse than leaving them off — the player would drive to a name
      // and find empty ground.
      const px = xOf(lon), pz = zOf(lat);
      if (!tileWanted(Math.floor(px / TILE), Math.floor(pz / TILE))) return;
      if (seen.has(id)) return;
      seen.add(id);
      places.push({
        n: tags.name,
        t: tags.place,
        r: RANK[tags.place] ?? 5,
        p: [Math.round(xOf(lon)), Math.round(zOf(lat))],
        pop: tags.population ? Number(tags.population) || undefined : undefined,
      });
      n++;
    },
  });
  console.log(`  ${f.split('/').pop()}: ${n} places`);
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
