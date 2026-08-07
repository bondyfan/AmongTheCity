// ---- the station area of Pardubice, straight out of OpenStreetMap ----------
// Shared by tests/venues.test.mjs (does the real trade survive the pipeline and
// land on the right footprint?) and tests/interiors.test.mjs (does the building
// it lands on then LOOK like a McDonald's?), so the two can never disagree
// about what the data says.
//
// tests/fixtures/pardubice-hlavni-nadrazi.json is verbatim stage-1 output — the
// same elements scripts/split-extracts.mjs now writes into data/raw-region —
// and this rebuilds from them the two things scripts/build-region.mjs emits:
// building records in game metres, and the venue point layer. Deliberately a
// SKETCH of the builder rather than an import of it (build-region.mjs is a
// script that runs on import), so it keeps only what the join and the
// classifier read: the ring, the OSM type, a height, a name, a trade.

import { readFileSync } from 'node:fs';
import { xOf, zOf } from '../scripts/lib/world-area.mjs';
import { venueKind, venueName, isVenue, joinVenues } from '../scripts/lib/venues.mjs';

const LEVEL_H = 3.1;

export function stationArea() {
  const fx = JSON.parse(readFileSync(
    new URL('./fixtures/pardubice-hlavni-nadrazi.json', import.meta.url), 'utf8'));
  const buildings = [], venues = [];
  let id = 1;
  for (const el of fx.elements) {
    if (el.type === 'way') {
      const o = el.geometry.map((g) => [+xOf(g.lon).toFixed(1), +zOf(g.lat).toFixed(1)]);
      // a closed ring is stored without its repeated last point, as in the tiles
      if (o.length > 3 && o[0][0] === o[o.length - 1][0] && o[0][1] === o[o.length - 1][1]) o.pop();
      if (o.length < 3) continue;
      const lv = parseFloat(el.tags['building:levels']);
      const b = {
        o, _id: id++, t: el.tags.building,
        h: +((lv > 0 ? lv : 2) * LEVEL_H + 1.2).toFixed(1),
      };
      if (lv > 0) b.lv = lv;
      if (el.tags.name) b.n = el.tags.name;
      const u = venueKind(el.tags);
      if (u) b.u = u;
      buildings.push(b);
    } else if (el.type === 'node' && isVenue(el.tags)) {
      venues.push({
        p: [+xOf(el.lon).toFixed(1), +zOf(el.lat).toFixed(1)],
        t: venueKind(el.tags), n: venueName(el.tags),
      });
    }
  }
  const stats = joinVenues(buildings, venues);
  return { buildings, venues, stats, elements: fx.elements };
}

/** centroid of a building ring, for "how far from where OSM says it is" */
export function centroid(o) {
  let x = 0, z = 0;
  for (const p of o) { x += p[0]; z += p[1]; }
  return [x / o.length, z / o.length];
}
