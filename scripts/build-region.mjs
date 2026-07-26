// ---- OSM → game-format processor, region edition ----
// build-city.mjs grew a bigger sibling: the playable world is the D11 corridor
// from Prague to Hradec Králové and down to Pardubice, split by
// scripts/split-extracts.mjs into 4.8 km raw tiles (data/raw-region/<tx>_<tz>.json).
// (Tiles downloaded by the older fetch-region.mjs, one Overpass response each,
// are read exactly the same way — see FIRST-VERTEX TILE OWNERSHIP below.)
// This script splits each response back into the layers build-city.mjs read
// from separate raw files — the per-layer SELECT predicates below mirror the
// fetch query clauses one-to-one, so a feature lands in exactly the layers it
// would have in the single-city pipeline (an element may feed several layers,
// e.g. a natural=water way that is also a waterway centerline — that matches
// how it would have appeared in several raw files). Output:
//   public/data/tiles/<tx>_<tz>.json   — pardubice.json format + "signals":[[x,z],…]
//   public/data/manifest.json          — { origin, mPerLat, mPerLon, tile, tiles:[{tx,tz,f,n}] }
// `f` is the tile URL relative to the app root (like CITY_DATA_URL), `n` its
// feature count. Tiles with zero features are neither written nor listed, so
// the runtime never fetches empty region corners.
//
// FIRST-VERTEX TILE OWNERSHIP: Overpass `out geom` returns FULL geometry for
// every element intersecting the tile bbox, so a way crossing a border shows
// up in BOTH tiles' raw files. The runtime does NOT dedupe across tiles —
// each tile's copy would get its own _id yet share one _home chunk, i.e. the
// feature would render twice. So each feature is kept ONLY by the tile that
// contains its FIRST stored vertex, mirroring geo.js' _home rule (which picks
// the render chunk from the first vertex — note processRoads may reverse p
// for oneway=-1, so ownership is tested AFTER that). First vertices outside
// the fetched grid (ways poking in from beyond the region) are clamped onto
// the grid so nothing is orphaned. The rule is deterministic and independent
// of which raw files currently exist, which makes the script safely
// RE-RUNNABLE while the download is still going: missing raw tiles are just
// skipped, and their features appear once their own raw file lands.
//
// Usage: node scripts/build-region.mjs

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { ORIGIN, M_PER_LAT, M_PER_LON, TILE, tileWanted, wantedTiles } from './lib/world-area.mjs';

const px = (lon) => +((lon - ORIGIN.lon) * M_PER_LON).toFixed(1);
const pz = (lat) => +((ORIGIN.lat - lat) * M_PER_LAT).toFixed(1); // south positive

// The grid is no longer a rectangle (scripts/lib/world-area.mjs owns its shape),
// so ownership clamps to the nearest WANTED tile rather than to a bounding box:
// a way arriving from beyond the world would otherwise be claimed by a tile
// that is never built, and vanish.
const clampTile = (tx, tz) => {
  if (tileWanted(tx, tz)) return [tx, tz];
  let best = [tx, tz], bestD = Infinity;
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    if (!tileWanted(tx + dx, tz + dz)) continue;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = [tx + dx, tz + dz]; }
  }
  return best;
};
// ownership predicate for one tile: does this [x,z] first vertex belong here?
// Uses the ROUNDED game-frame coords (px/pz output) — the same numbers geo.js
// will floor for _home, so build-time ownership and runtime home always agree.
const makeOwns = (tx, tz) => (pt) => {
  const [ox, oz] = clampTile(Math.floor(pt[0] / TILE), Math.floor(pt[1] / TILE));
  return ox === tx && oz === tz;
};

// ---- geometry helpers (verbatim from build-city.mjs) ----
// way geometry (from `out geom`) → [[x,z],...]
const ring = (geom) => geom.map(g => [px(g.lon), pz(g.lat)]);
const closed = (pts) => pts.length > 3
  && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];

// shoelace — signed, for orientation + area thresholds
function area(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

// A multipolygon relation (out geom) carries members with inline geometry.
// Members' ways may be SPLIT fragments — stitch outer fragments into closed
// rings by matching endpoints, then pair each inner ring with the outer that
// contains it. Returns [{o, i:[...]}]
function assembleRelation(rel) {
  const frags = { outer: [], inner: [] };
  for (const m of rel.members ?? []) {
    if (m.type !== 'way' || !m.geometry) continue;
    (m.role === 'inner' ? frags.inner : frags.outer).push(ring(m.geometry));
  }
  const stitch = (list) => {
    const rings = [];
    const pool = list.map(p => closed(p) ? { ring: p.slice(0, -1), done: true } : { ring: p, done: false });
    const open = pool.filter(p => !p.done);
    rings.push(...pool.filter(p => p.done).map(p => p.ring));
    const key = (pt) => pt[0] + ',' + pt[1];
    while (open.length) {
      let cur = open.shift().ring.slice();
      let grew = true;
      while (grew && key(cur[0]) !== key(cur[cur.length - 1])) {
        grew = false;
        for (let i = 0; i < open.length; i++) {
          const r = open[i].ring;
          if (key(r[0]) === key(cur[cur.length - 1])) { cur = cur.concat(r.slice(1)); open.splice(i, 1); grew = true; break; }
          if (key(r[r.length - 1]) === key(cur[cur.length - 1])) { cur = cur.concat(r.slice(0, -1).reverse()); open.splice(i, 1); grew = true; break; }
        }
      }
      if (key(cur[0]) === key(cur[cur.length - 1])) cur = cur.slice(0, -1);
      if (cur.length >= 3) rings.push(cur);
    }
    return rings;
  };
  const outers = stitch(frags.outer);
  const inners = stitch(frags.inner);
  const inside = (pt, poly) => { // ray cast
    let inA = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > pt[1]) !== (zj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - zi) / (zj - zi) + xi) inA = !inA;
    }
    return inA;
  };
  return outers.map(o => ({
    o, i: inners.filter(inr => inr.length && inside(inr[0], o)),
  }));
}

// ---------- buildings (constants verbatim from build-city.mjs) ----------
// height: explicit height tag > levels × 3.1 m + roof allowance > per-type default
const LEVEL_H = 3.1;
const TYPE_LEVELS = {
  house: 2, detached: 2, residential: 3, apartments: 4, terrace: 2, bungalow: 1,
  garage: 1, garages: 1, shed: 1, hut: 1, cabin: 1, roof: 1, carport: 1,
  industrial: 2, warehouse: 2, retail: 2, commercial: 3, office: 4, hotel: 5,
  school: 3, university: 4, hospital: 4, civic: 3, public: 3, church: 6,
  cathedral: 8, train_station: 4, station: 3, yes: 2,
};
function buildingHeight(t) {
  const h = parseFloat(t.height ?? t['building:height']);
  if (h > 0) return Math.min(h, 120);
  const lv = parseFloat(t['building:levels']);
  if (lv > 0) return Math.min(lv * LEVEL_H + 1.2, 120);
  return (TYPE_LEVELS[t.building] ?? 2) * LEVEL_H + 1.2;
}

const CZ_COLOURS = { // building:colour appears on some RÚIAN buildings
  red: '#b5533c', white: '#e8e4da', yellow: '#d9c47e', brown: '#8a6a4a',
  grey: '#9a9a94', gray: '#9a9a94', green: '#8ba07a', blue: '#7a92a8',
  orange: '#c98a52', beige: '#d8cbaa', pink: '#c9989a',
};

function processBuildings(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    const t = el.tags ?? {};
    if (!t.building) continue;
    // WITHIN-tile id dedupe: one clean response holds each element once, but a
    // merged/rescued download may not — cheap insurance, per layer (an element
    // may legitimately feed several layers, so the sets are not shared).
    const k = el.type + '/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    const rec = (o, i) => {
      if (!owns(o[0])) return;           // first-vertex tile ownership (see header)
      if (Math.abs(area(o)) < 8) return; // sub-8 m² slivers add nothing
      const b = { o, h: +buildingHeight(t).toFixed(1) };
      if (i?.length) b.i = i;
      const lv = parseFloat(t['building:levels']);
      if (lv > 0) b.lv = lv;
      if (t['building:colour'] && (CZ_COLOURS[t['building:colour']] || /^#/.test(t['building:colour'])))
        b.c = CZ_COLOURS[t['building:colour']] ?? t['building:colour'];
      const kind = t.building === 'yes' ? (t.amenity ?? t.shop ? 'commercial' : 'yes') : t.building;
      b.t = kind;
      if (t.name) b.n = t.name;
      if (t['roof:shape'] && t['roof:shape'] !== 'flat') b.r = t['roof:shape'];
      const mh = parseFloat(t.min_height ?? t['building:min_level'] * LEVEL_H);
      if (mh > 0) b.y = +mh.toFixed(1);
      out.push(b);
    };
    if (el.type === 'way' && el.geometry) {
      const o = ring(el.geometry);
      if (closed(o)) rec(o.slice(0, -1));
    } else if (el.type === 'relation') {
      for (const poly of assembleRelation(el)) rec(poly.o, poly.i);
    }
  }
  return out;
}

// ---------- roads (spec table verbatim) ----------
// width by class (full carriageway), speed for traffic AI (km/h), drivable flag
const ROAD = {
  motorway: { w: 11, v: 110, d: 1 }, motorway_link: { w: 5.5, v: 60, d: 1 },
  trunk: { w: 10, v: 80, d: 1 }, trunk_link: { w: 5.5, v: 50, d: 1 },
  primary: { w: 9, v: 50, d: 1 }, primary_link: { w: 5, v: 40, d: 1 },
  secondary: { w: 8, v: 50, d: 1 }, secondary_link: { w: 5, v: 40, d: 1 },
  tertiary: { w: 7, v: 50, d: 1 }, tertiary_link: { w: 4.5, v: 40, d: 1 },
  unclassified: { w: 5.5, v: 40, d: 1 }, residential: { w: 5.5, v: 30, d: 1 },
  living_street: { w: 4.5, v: 20, d: 1 }, service: { w: 3.6, v: 20, d: 1 },
  pedestrian: { w: 4, v: 0, d: 0 }, footway: { w: 1.8, v: 0, d: 0 },
  path: { w: 1.5, v: 0, d: 0 }, cycleway: { w: 2.2, v: 0, d: 0 },
  steps: { w: 1.8, v: 0, d: 0 }, track: { w: 2.5, v: 0, d: 0 },
};

function processRoads(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    const t = el.tags ?? {};
    const spec = ROAD[t.highway];  // unknown classes (construction, proposed…) drop here
    if (!spec || el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    if (t.area === 'yes') continue; // pedestrian squares live in `paved`
    if (t.tunnel && t.tunnel !== 'no') continue; // nothing renders underground
    const k = 'way/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    const r = { p: ring(el.geometry), t: t.highway, w: spec.w, v: spec.v, d: spec.d };
    const w = parseFloat(t.width);
    if (w > 1 && w < 30) r.w = +w.toFixed(1);
    if (t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout') r.ow = 1;
    else if (t.oneway === '-1') { r.p.reverse(); r.ow = 1; }
    // ownership AFTER the oneway=-1 reverse — runtime _home reads the STORED p[0]
    if (!owns(r.p[0])) continue;
    const lanes = parseInt(t.lanes);
    if (lanes > 0) r.ln = lanes;
    if (t.name) r.n = t.name;
    out.push(r);
  }
  return out;
}

// ---------- rails ----------
function processRails(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    const t = el.tags ?? {};
    if (el.type !== 'way' || !/^(rail|tram|light_rail)$/.test(t.railway ?? '')) continue;
    if (!el.geometry || el.geometry.length < 2) continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    const k = 'way/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    // yard/siding tracks are kept on purpose — the station throat IS the view.
    // light_rail gets ballast+sleepers like heavy rail (meshes.js special-cases
    // only 'tram', which lies flush in the street).
    const r = { p: ring(el.geometry), t: t.railway === 'light_rail' ? 'rail' : t.railway };
    if (!owns(r.p[0])) continue;
    if (t.bridge && t.bridge !== 'no') r.br = 1;
    out.push(r);
  }
  return out;
}

// ---------- polygon layers (water / green / paved) ----------
// `select` mirrors the fetch-region.mjs query clause that pulled the element,
// `keep` maps its tags to the game kind — split so the green catch-all
// ('anything with landuse/natural/leisure → grass') can't swallow elements
// that only entered the combined response via an unrelated clause.
function processAreas(els, select, keep, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    if (el.type !== 'way' && el.type !== 'relation') continue;
    const t = el.tags ?? {};
    if (!select(t, el)) continue;
    const kind = keep(t);
    if (!kind) continue;
    const k = el.type + '/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    if (el.type === 'way' && el.geometry) {
      const o = ring(el.geometry);
      if (closed(o) && Math.abs(area(o.slice(0, -1))) > 25 && owns(o[0]))
        out.push({ o: o.slice(0, -1), t: kind });
    } else if (el.type === 'relation') {
      for (const poly of assembleRelation(el))
        if (Math.abs(area(poly.o)) > 25 && owns(poly.o[0]))
          out.push({ o: poly.o, i: poly.i.length ? poly.i : undefined, t: kind });
    }
  }
  return out;
}

const isWaterPoly = (t, el) =>
  t.natural === 'water' || (el.type === 'relation' && t.waterway === 'riverbank');

const GREEN_LANDUSE = /^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green|orchard|farmland)$/;
const GREEN_LEISURE = /^(park|garden|pitch|playground|golf_course|stadium)$/;
const GREEN_NATURAL = /^(wood|scrub|grassland)$/;
const isGreen = (t) => GREEN_LANDUSE.test(t.landuse ?? '')
  || GREEN_LEISURE.test(t.leisure ?? '') || GREEN_NATURAL.test(t.natural ?? '');
const greenKind = (t) =>
  t.leisure === 'park' || t.leisure === 'garden' ? 'park'
  : t.landuse === 'forest' || t.natural === 'wood' ? 'wood'
  : t.leisure === 'pitch' || t.leisure === 'playground' || t.leisure === 'stadium' ? 'pitch'
  : t.landuse === 'cemetery' ? 'cemetery'
  : (t.landuse || t.natural || t.leisure) ? 'grass' : null;

const isPaved = (t) =>
  (t.amenity === 'parking' && !/underground|multi-storey/.test(t.parking ?? ''))
  || (t.highway === 'pedestrian' && t.area === 'yes') || t.place === 'square';
const pavedKind = (t) =>
  t.amenity === 'parking' ? 'parking'
  : (t.highway === 'pedestrian' || t.place === 'square') ? 'plaza' : null;

// ---------- waterway centerlines ----------
function processWaterLines(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    const t = el.tags ?? {};
    if (el.type !== 'way' || !el.geometry) continue;
    if (!/^(river|stream|canal)$/.test(t.waterway ?? '')) continue;
    const k = 'way/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    const p = ring(el.geometry);
    if (!owns(p[0])) continue;
    const w = t.waterway === 'river' ? 12 : t.waterway === 'canal' ? 6 : 2.5;
    out.push({ p, w: parseFloat(t.width) > 0 ? +parseFloat(t.width).toFixed(1) : w });
  }
  return out;
}

// ---------- trees ----------
function processTrees(els, owns) {
  const pts = [], seen = new Set();
  for (const el of els) {
    const t = el.tags ?? {};
    const isNode = el.type === 'node' && t.natural === 'tree';
    const isRow = el.type === 'way' && t.natural === 'tree_row' && !!el.geometry;
    if (!isNode && !isRow) continue;
    const k = el.type + '/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    if (isNode) {
      const pt = [px(el.lon), pz(el.lat)];
      if (owns(pt)) pts.push(pt);
    } else { // tree_row: a tree every ~7 m along the way. Each SAMPLE owns
      // itself — both border tiles sample identical positions from identical
      // geometry, so a row crossing the border splits cleanly with no dupes.
      const p = ring(el.geometry);
      for (let i = 0; i < p.length - 1; i++) {
        const [x1, z1] = p[i], [x2, z2] = p[i + 1];
        const d = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.round(d / 7));
        for (let j = 0; j <= n; j++) {
          const pt = [+(x1 + (x2 - x1) * j / n).toFixed(1), +(z1 + (z2 - z1) * j / n).toFixed(1)];
          if (owns(pt)) pts.push(pt);
        }
      }
    }
  }
  return pts;
}

// ---------- pois ----------
// The amenity list mirrors the fetch query (build-city could catch-all
// `t.amenity` because its raw file was already query-filtered; here unrelated
// nodes share the response, so the filter must be explicit).
function processPois(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    if (el.type !== 'node') continue;
    const t = el.tags ?? {};
    const kind = t.railway === 'station' ? 'station'
      : t.railway === 'tram_stop' ? 'tram_stop'
      : t.highway === 'bus_stop' ? 'bus_stop'
      : /^(fuel|hospital|police|fire_station)$/.test(t.amenity ?? '') ? t.amenity : null;
    if (!kind) continue;
    const k = 'node/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    const pt = [px(el.lon), pz(el.lat)];
    if (owns(pt)) out.push({ p: pt, t: kind, n: t.name });
  }
  return out;
}

// ---------- traffic signals (new layer — semafory for traffic v3) ----------
function processSignals(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    if (el.type !== 'node' || el.tags?.highway !== 'traffic_signals') continue;
    const k = 'node/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    const pt = [px(el.lon), pz(el.lat)];
    if (owns(pt)) out.push(pt);
  }
  return out;
}

// ---------- run: every raw tile on disk ----------
// Driven by the directory, not by a rectangle: the world's shape lives in
// world-area.mjs and a partially-finished split is simply a smaller world.
// Dry runs point RAW_DIR/OUT_DIR at a scratch directory; production uses both
// defaults, which are the paths the game and the deploy actually read.
const RAW_DIR = process.env.RAW_DIR || 'data/raw-region';
const OUT_DIR = process.env.OUT_DIR || 'public/data';
mkdirSync(`${OUT_DIR}/tiles`, { recursive: true });
const manifestTiles = [];
const totals = { buildings: 0, roads: 0, rails: 0, water: 0, waterways: 0,
  green: 0, paved: 0, trees: 0, pois: 0, signals: 0 };
let emitted = 0, empty = 0, bytes = 0;

const rawTiles = readdirSync(RAW_DIR)
  .map(f => /^(-?\d+)_(-?\d+)\.json$/.exec(f))
  .filter(Boolean)
  .map(m => [+m[1], +m[2]])
  .sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));

{
  for (const [tx, tz] of rawTiles) {
    const rawFile = `${RAW_DIR}/${tx}_${tz}.json`;
    const raw = JSON.parse(readFileSync(rawFile, 'utf8'));
    const els = raw.elements ?? [];
    // split-extracts.mjs already placed every element in exactly one tile;
    // an Overpass download did not, and still needs the first-vertex test.
    const owns = raw.owned ? () => true : makeOwns(tx, tz);
    const tile = {
      tx, tz,
      origin: ORIGIN, mPerLat: +M_PER_LAT.toFixed(1), mPerLon: +M_PER_LON.toFixed(1),
      buildings: processBuildings(els, owns),
      roads: processRoads(els, owns),
      rails: processRails(els, owns),
      water: processAreas(els, isWaterPoly, () => 'water', owns),
      waterways: processWaterLines(els, owns),
      green: processAreas(els, isGreen, greenKind, owns),
      paved: processAreas(els, isPaved, pavedKind, owns),
      trees: processTrees(els, owns),
      pois: processPois(els, owns),
      signals: processSignals(els, owns),
    };
    let n = 0;
    for (const key of Object.keys(totals)) { n += tile[key].length; totals[key] += tile[key].length; }
    if (!n) { empty++; continue; } // bare corner — nothing to stream, keep it off the manifest
    const json = JSON.stringify(tile);
    writeFileSync(`${OUT_DIR}/tiles/${tx}_${tz}.json`, json);
    manifestTiles.push({ tx, tz, f: `data/tiles/${tx}_${tz}.json`, n });
    bytes += json.length;
    emitted++;
  }
}

writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify({
  origin: ORIGIN, mPerLat: +M_PER_LAT.toFixed(1), mPerLon: +M_PER_LON.toFixed(1),
  tile: TILE, tiles: manifestTiles,
}));

const wanted = wantedTiles().length;
console.log(`${rawTiles.length} raw tiles read of ${wanted} the world wants`
  + ` → ${emitted} emitted, ${empty} empty`);
console.log({ ...totals, sizeMB: +(bytes / 1e6).toFixed(2) });
