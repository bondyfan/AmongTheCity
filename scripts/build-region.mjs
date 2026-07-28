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

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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

// ---- polygon simplification (Douglas–Peucker) ----
// The world grew from 72 tiles to 185 and from 163 k buildings to 831 k, which
// took the deployed JSON from 49 MB to 299 MB. Most of that weight is detail
// nobody can see: a farmland polygon traced to the decimetre, a motorway
// centreline with a vertex every few metres under an 11 m wide ribbon. Tuned
// per layer, DP takes 56 % off the green polygons and 19 % off the roads while
// moving nothing further than the tolerance — which is far under one texel of
// the ortho photo the ground is drawn from.
//
// Buildings are deliberately NOT simplified: their corners are the silhouette,
// interiors.js lays out real floor plans inside these outlines, and the whole
// layer would only give back 8 %.
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0], pts[pts.length - 1]];
  let dmax = 0, idx = 0;
  const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i];
    const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2)) : 0;
    const d = Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dz * t));
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax <= eps) return [a, b];
  return simplify(pts.slice(0, idx + 1), eps).slice(0, -1).concat(simplify(pts.slice(idx), eps));
}

// A closed ring is stored WITHOUT its repeated last point, so close it for the
// run and drop the duplicate after — otherwise DP is free to cut the corner
// that joins the last vertex back to the first. Never returns a degenerate
// ring: below three points the original wins.
function simplifyRing(pts, eps) {
  if (pts.length < 5) return pts;
  const out = simplify([...pts, pts[0]], eps);
  out.pop();
  return out.length >= 3 ? out : pts;
}

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

// ---------- Prague: real storeys and roofs from IPR ----------
// OSM has a height for barely half of Prague's 447 000 footprints; the rest get
// the two-storey guess, which flattens Staré Město into a village. IPR Praha's
// own survey (scripts/fetch-ipr.mjs) covers 145 123 buildings inside the city
// with a storey count and a roof shape, so where it has an answer it wins over
// the guess — but never over an explicit OSM `height`, which is how the
// landmarks and the Pankrác towers keep their surveyed numbers.
//
// The join is spatial: IPR and OSM drew the same city twice and share no ids.
// An IPR building's centroid falling INSIDE an OSM footprint is the strong
// match; for the L-shaped courtyard blocks whose centroid lands in the yard,
// the nearest centroid within IPR_NEAR metres is the fallback.
const IPR_NEAR = 9;         // m — beyond this, two centroids are two buildings
function loadIpr() {
  const file = 'data/ipr-buildings.json';
  if (!existsSync(file)) return null;
  const { cell, stride, pts } = JSON.parse(readFileSync(file, 'utf8'));
  const grid = new Map();
  for (let i = 0; i < pts.length; i += stride) {
    const k = Math.floor(pts[i] / cell) + ',' + Math.floor(pts[i + 1] / cell);
    let a = grid.get(k);
    if (!a) grid.set(k, a = []);
    a.push(i);
  }
  const inRing = (x, z, poly) => {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, zi] = poly[i], [xj, zj] = poly[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) hit = !hit;
    }
    return hit;
  };
  return {
    used: 0,
    // → { st, roof } or null. `o` is the OSM outer ring in game metres.
    match(o) {
      let cx = 0, cz = 0;
      for (const [x, z] of o) { cx += x; cz += z; }
      cx /= o.length; cz /= o.length;
      const gx = Math.floor(cx / cell), gz = Math.floor(cz / cell);
      let inside = -1, near = -1, nearD = IPR_NEAR * IPR_NEAR;
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
        const a = grid.get((gx + dx) + ',' + (gz + dz));
        if (!a) continue;
        for (const i of a) {
          const x = pts[i], z = pts[i + 1];
          if (inside < 0 && inRing(x, z, o)) { inside = i; continue; }
          const d = (x - cx) ** 2 + (z - cz) ** 2;
          if (d < nearD) { nearD = d; near = i; }
        }
      }
      const i = inside >= 0 ? inside : near;
      if (i < 0) return null;
      this.used++;
      return { st: pts[i + 2], roof: pts[i + 3] };
    },
  };
}
const IPR = loadIpr();

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
      // …then let Prague's own survey correct the guess. An explicit OSM
      // `height` is a measurement and outranks it; everything else does not.
      const m = !(parseFloat(t.height ?? t['building:height']) > 0) && IPR?.match(o);
      if (m) {
        b.lv = m.st;
        // `h` is the wall height to the eaves, for both this join and the OSM
        // path — the pitched roof above it is geometry meshes.js builds from
        // `r`, so adding a ridge allowance here as well would count it twice.
        b.h = +(m.st * LEVEL_H + 1.2).toFixed(1);
        if (m.roof === 1) b.r ??= 'gabled';
        else if (m.roof === 2) b.r ??= 'dome';
        else if (m.roof === 3) delete b.r;      // surveyed flat: no ridge
      }
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

// Runways and taxiways are polylines with a width, which is exactly what a road
// is — so they ride the road layer rather than inventing a parallel one, and
// get streaming, the minimap and the world map for free. `d: 0` keeps the
// traffic AI off them (a Škoda queueing for take-off is not the joke we want);
// the player can still drive onto one, because driving is free physics.
// Default widths are the real thing: Pardubice's 09/27 is 45 m wide, Prague's
// 06/24 is 60 m, and a taxiway is 23 m.
const AERO_LINE = {
  runway: { w: 45, v: 0, d: 0 },
  taxiway: { w: 23, v: 0, d: 0 },
  taxilane: { w: 15, v: 0, d: 0 },
  airstrip: { w: 20, v: 0, d: 0 },
};
const AERO_AREA = { apron: 'apron', helipad: 'helipad', taxiway: 'apron', runway: 'runway' };

function processRoads(els, owns) {
  const out = [], seen = new Set();
  for (const el of els) {
    const t = el.tags ?? {};
    // an aeroway line is a road with a very generous width (see AERO_LINE)
    const spec = ROAD[t.highway] ?? (t.area === 'yes' ? null : AERO_LINE[t.aeroway]);
    if (!spec || el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    if (t.area === 'yes') continue; // pedestrian squares live in `paved`
    if (t.tunnel && t.tunnel !== 'no') continue; // nothing renders underground
    const k = 'way/' + el.id;
    if (seen.has(k)) continue;
    seen.add(k);
    // 0.5 m on a centreline under a 5–11 m ribbon is invisible, and DP never
    // drops an endpoint — so every junction node the traffic graph keys on
    // survives untouched.
    const r = { p: simplify(ring(el.geometry), 0.5), t: t.highway ?? t.aeroway, w: spec.w, v: spec.v, d: spec.d };
    const w = parseFloat(t.width);
    // a runway's own `width` tag is 45–60 m, well past the 30 m road sanity cap
    if (w > 1 && w < (t.aeroway ? 90 : 30)) r.w = +w.toFixed(1);
    // the painted designation ("09/27", "06/24") — meshes paints the numbers
    if (t.aeroway === 'runway' && t.ref) r.ref = t.ref;
    if (t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout') r.ow = 1;
    else if (t.oneway === '-1') { r.p.reverse(); r.ow = 1; }
    // Keep the vertical topology. Without this flag every regional road bridge
    // is indistinguishable from an ordinary road at runtime and gets draped
    // over the riverbed terrain, even though the raw OSM way says bridge=yes.
    if (t.bridge && t.bridge !== 'no') r.br = 1;
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
// Per-kind simplification tolerance. A field boundary and a forest edge can
// move 2.5 m and nobody will ever know; a tennis court or a cemetery wall is
// small enough that the same tolerance would visibly round its corners, and a
// riverbank carries the bridge geometry, so both stay near-exact.
const AREA_EPS = { wood: 2.5, grass: 2.5, park: 1.2, pitch: 0.8, cemetery: 1.2, water: 1.2, parking: 0.8, plaza: 0.8 };

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
    const eps = AREA_EPS[kind] ?? 1;
    if (el.type === 'way' && el.geometry) {
      const o = ring(el.geometry);
      if (closed(o) && Math.abs(area(o.slice(0, -1))) > 25 && owns(o[0]))
        out.push({ o: simplifyRing(o.slice(0, -1), eps), t: kind });
    } else if (el.type === 'relation') {
      for (const poly of assembleRelation(el))
        if (Math.abs(area(poly.o)) > 25 && owns(poly.o[0]))
          out.push({
            o: simplifyRing(poly.o, eps), t: kind,
            i: poly.i.length ? poly.i.map(r => simplifyRing(r, eps)) : undefined,
          });
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
  || (t.highway === 'pedestrian' && t.area === 'yes') || t.place === 'square'
  // aprons and helipads are always areas; runways/taxiways sometimes are too
  || (!!AERO_AREA[t.aeroway] && (t.area === 'yes' || t.aeroway === 'apron' || t.aeroway === 'helipad'));
const pavedKind = (t) =>
  t.amenity === 'parking' ? 'parking'
  : AERO_AREA[t.aeroway] ? AERO_AREA[t.aeroway]
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
    const p = simplify(ring(el.geometry), 1.5);
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
      : t.aeroway === 'aerodrome' ? 'aerodrome'
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

// ---------- the world overview (public/data/overview.json) ----------
// The world map draws the LIVE city arrays, which is exactly right for a 30 km
// region that streams in within seconds of spawning. Over 110 km it means the
// map is an empty olive rectangle until you have personally driven somewhere:
// open it in Pardubice and Prague simply is not on it.
//
// So the builder also emits a sketch of the WHOLE world — motorways down to
// secondary roads, main railway lines, big water, big forests, and built-up
// area as a coarse grid of 200 m cells — in the same feature shape the map's
// own draw helpers already take, so the map gets a permanent base layer for a
// couple of megabytes and paints live detail over it as tiles arrive.
const OV = {
  roads: /^(motorway|trunk|primary|secondary)$/,
  roadEps: 18,        // m — at region zoom one pixel is 50 m+
  railMin: 1200,      // m — main lines, not sidings and yard throats
  railEps: 25,
  waterMin: 30000,    // m² — the Labe, the Vltava, Sec, Rozkoš; not village ponds
  waterEps: 12,
  woodMin: 250000,    // m² — a forest you would navigate by
  woodEps: 25,
  cell: 200,          // built-up grid
};
const overview = { roads: [], rails: [], water: [], green: [], urban: [] };
const urbanCells = new Set();

function collectOverview(tile) {
  for (const r of tile.roads) {
    if (!OV.roads.test(r.t)) continue;
    overview.roads.push({ p: simplify(r.p, OV.roadEps), t: r.t });
  }
  for (const r of tile.rails) {
    if (r.t !== 'rail') continue;
    let L = 0;
    for (let i = 1; i < r.p.length; i++) L += Math.hypot(r.p[i][0] - r.p[i - 1][0], r.p[i][1] - r.p[i - 1][1]);
    if (L < OV.railMin) continue;
    overview.rails.push({ p: simplify(r.p, OV.railEps), t: 'rail' });
  }
  for (const w of tile.water)
    if (Math.abs(area(w.o)) > OV.waterMin) overview.water.push({ o: simplifyRing(w.o, OV.waterEps), t: 'water' });
  for (const g of tile.green)
    if (g.t === 'wood' && Math.abs(area(g.o)) > OV.woodMin)
      overview.green.push({ o: simplifyRing(g.o, OV.woodEps), t: 'wood' });
  for (const b of tile.buildings)
    urbanCells.add(Math.floor(b.o[0][0] / OV.cell) + ',' + Math.floor(b.o[0][1] / OV.cell));
}

// Built-up cells → rectangles, merged into horizontal runs. One rect per cell
// is ~24 000 rings for this world; runs of adjacent cells in the same row cut
// that by about four, and the map only ever fills them as a flat wash anyway.
function urbanRuns() {
  const rows = new Map();
  for (const k of urbanCells) {
    const [cx, cz] = k.split(',').map(Number);
    let row = rows.get(cz);
    if (!row) rows.set(cz, row = []);
    row.push(cx);
  }
  const out = [];
  for (const [cz, row] of rows) {
    row.sort((a, b) => a - b);
    let start = row[0], prev = row[0];
    const flush = (from, to) => {
      const x0 = from * OV.cell, x1 = (to + 1) * OV.cell;
      const z0 = cz * OV.cell, z1 = z0 + OV.cell;
      out.push({ o: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]] });
    };
    for (let i = 1; i < row.length; i++) {
      if (row[i] === prev + 1) { prev = row[i]; continue; }
      flush(start, prev);
      start = prev = row[i];
    }
    flush(start, prev);
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

// Some rivers are single OSM multipolygons tens of kilometres long. They live
// in the raw tile owning their first vertex, but the runtime must also know
// that the feature reaches other tiles or it will show only the aerial photo
// there. Store the actual water extent in the tiny manifest for that purpose.
function waterBounds(water) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const f of water) for (const [x, z] of f.o ?? []) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return Number.isFinite(x0) ? [x0, z0, x1, z1] : null;
}

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
    collectOverview(tile);
    const json = JSON.stringify(tile);
    writeFileSync(`${OUT_DIR}/tiles/${tx}_${tz}.json`, json);
    const wb = waterBounds(tile.water);
    manifestTiles.push({ tx, tz, f: `data/tiles/${tx}_${tz}.json`, n, ...(wb ? { wb } : {}) });
    bytes += json.length;
    emitted++;
  }
}

writeFileSync(`${OUT_DIR}/manifest.json`, JSON.stringify({
  origin: ORIGIN, mPerLat: +M_PER_LAT.toFixed(1), mPerLon: +M_PER_LON.toFixed(1),
  tile: TILE, tiles: manifestTiles,
}));

overview.urban = urbanRuns();
const ovJson = JSON.stringify({
  origin: ORIGIN, mPerLat: +M_PER_LAT.toFixed(1), mPerLon: +M_PER_LON.toFixed(1), cell: OV.cell, ...overview,
});
writeFileSync(`${OUT_DIR}/overview.json`, ovJson);
console.log(`overview.json: ${overview.roads.length} roads, ${overview.rails.length} rails, `
  + `${overview.water.length} water, ${overview.green.length} woods, ${overview.urban.length} built-up runs`
  + ` — ${(ovJson.length / 1e6).toFixed(2)} MB`);

if (IPR) console.log(`IPR Praha: ${IPR.used.toLocaleString()} buildings took their storeys`
  + ' and roof from the city survey (datový podklad © IPR Praha)');
else console.log('IPR Praha: data/ipr-buildings.json absent — Prague keeps the OSM guess'
  + ' (run: node scripts/fetch-ipr.mjs)');

const wanted = wantedTiles().length;
console.log(`${rawTiles.length} raw tiles read of ${wanted} the world wants`
  + ` → ${emitted} emitted, ${empty} empty`);
console.log({ ...totals, sizeMB: +(bytes / 1e6).toFixed(2) });
