// ---- OSM → game-format processor ----
// Reads the raw Overpass layers (data/raw/*.json) and emits ONE compact
// public/data/pardubice.json in local meters around the origin (the main
// train station). Everything downstream — meshing, traffic, collision —
// reads only this file, never raw OSM.
//
// Local frame: x = east, z = SOUTH (three.js-friendly: north is -z), y = up.
// Pardubice is Polabí flat (~220 m, meters of relief at most), so the ground
// is y = 0 and bridges get their height from `layer` tags at mesh time.
//
// Usage: node scripts/build-city.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

// hlavní nádraží — the world origin and the player's spawn neighbourhood
// (the exact railway=station node of Pardubice hlavní nádraží)
const ORIGIN = { lat: 50.0317084, lon: 15.7560881 };
const M_PER_LAT = 111132.9 - 559.8 * Math.cos(2 * ORIGIN.lat * Math.PI / 180); // ~111258
const M_PER_LON = 111412.8 * Math.cos(ORIGIN.lat * Math.PI / 180) - 93.5 * Math.cos(3 * ORIGIN.lat * Math.PI / 180); // ~71554

const px = (lon) => +((lon - ORIGIN.lon) * M_PER_LON).toFixed(1);
const pz = (lat) => +((ORIGIN.lat - lat) * M_PER_LAT).toFixed(1); // south positive

const raw = (name) => JSON.parse(readFileSync(`data/raw/${name}.json`, 'utf8')).elements;

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

// ---------- buildings ----------
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

function processBuildings() {
  const out = [];
  for (const el of raw('buildings')) {
    const t = el.tags ?? {};
    if (!t.building) continue;
    const rec = (o, i) => {
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

// ---------- roads ----------
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

function processRoads() {
  const out = [];
  for (const el of raw('roads')) {
    const t = el.tags ?? {};
    const spec = ROAD[t.highway];
    if (!spec || !el.geometry || el.geometry.length < 2) continue;
    if (t.area === 'yes') continue; // pedestrian squares live in `paved`
    if (t.tunnel && t.tunnel !== 'no') continue; // nothing renders underground in v1
    const r = { p: ring(el.geometry), t: t.highway, w: spec.w, v: spec.v, d: spec.d };
    const w = parseFloat(t.width);
    if (w > 1 && w < 30) r.w = +w.toFixed(1);
    if (t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout') r.ow = 1;
    else if (t.oneway === '-1') { r.p.reverse(); r.ow = 1; }
    if (t.bridge && t.bridge !== 'no') r.br = 1;
    const lanes = parseInt(t.lanes);
    if (lanes > 0) r.ln = lanes;
    if (t.name) r.n = t.name;
    out.push(r);
  }
  return out;
}

// ---------- rails / water / green / paved / trees / pois ----------
function processRails() {
  const out = [];
  for (const el of raw('rails')) {
    const t = el.tags ?? {};
    if (!el.geometry || el.geometry.length < 2) continue;
    if (t.tunnel && t.tunnel !== 'no') continue;
    if (t.service === 'yard' || t.service === 'siding') {
      // keep — the station throat full of sidings IS the view from the spawn
    }
    const r = { p: ring(el.geometry), t: t.railway };
    if (t.bridge && t.bridge !== 'no') r.br = 1;
    out.push(r);
  }
  return out;
}

function processAreasLayer(name, keep) {
  const out = [];
  for (const el of raw(name)) {
    const t = el.tags ?? {};
    const kind = keep(t);
    if (!kind) continue;
    if (el.type === 'way' && el.geometry) {
      const o = ring(el.geometry);
      if (closed(o) && Math.abs(area(o.slice(0, -1))) > 25)
        out.push({ o: o.slice(0, -1), t: kind });
    } else if (el.type === 'relation') {
      for (const poly of assembleRelation(el))
        if (Math.abs(area(poly.o)) > 25)
          out.push({ o: poly.o, i: poly.i.length ? poly.i : undefined, t: kind });
    }
  }
  return out;
}

function processWater() {
  const polys = processAreasLayer('water', t =>
    (t.natural === 'water' || t.waterway === 'riverbank') ? 'water' : null);
  const lines = [];
  for (const el of raw('water')) {
    const t = el.tags ?? {};
    if (el.type !== 'way' || !el.geometry) continue;
    if (!/^(river|stream|canal)$/.test(t.waterway ?? '')) continue;
    const w = t.waterway === 'river' ? 12 : t.waterway === 'canal' ? 6 : 2.5;
    lines.push({ p: ring(el.geometry), w: parseFloat(t.width) > 0 ? +parseFloat(t.width).toFixed(1) : w });
  }
  return { polys, lines };
}

function processTrees() {
  const pts = [];
  for (const el of raw('trees')) {
    if (el.type === 'node') pts.push([px(el.lon), pz(el.lat)]);
    else if (el.geometry) { // tree_row: a tree every ~7 m along the way
      const p = ring(el.geometry);
      for (let i = 0; i < p.length - 1; i++) {
        const [x1, z1] = p[i], [x2, z2] = p[i + 1];
        const d = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.round(d / 7));
        for (let k = 0; k <= n; k++) pts.push([+(x1 + (x2 - x1) * k / n).toFixed(1), +(z1 + (z2 - z1) * k / n).toFixed(1)]);
      }
    }
  }
  return pts;
}

function processPois() {
  const out = [];
  for (const el of raw('pois')) {
    const t = el.tags ?? {};
    const pt = el.type === 'node' ? [px(el.lon), pz(el.lat)]
      : el.geometry ? ring(el.geometry)[0] : null;
    if (!pt) continue;
    const kind = t.railway === 'station' ? 'station'
      : t.railway === 'tram_stop' ? 'tram_stop'
      : t.highway === 'bus_stop' ? 'bus_stop'
      : t.amenity;
    out.push({ p: pt, t: kind, n: t.name });
  }
  return out;
}

// ---------- run ----------
const buildings = processBuildings();
const roads = processRoads();
const rails = processRails();
const water = processWater();
const green = processAreasLayer('green', t =>
  t.leisure === 'park' || t.leisure === 'garden' ? 'park'
  : t.landuse === 'forest' || t.natural === 'wood' ? 'wood'
  : t.leisure === 'pitch' || t.leisure === 'playground' || t.leisure === 'stadium' ? 'pitch'
  : t.landuse === 'cemetery' ? 'cemetery'
  : (t.landuse || t.natural || t.leisure) ? 'grass' : null);
const paved = processAreasLayer('paved', t =>
  t.amenity === 'parking' ? 'parking'
  : (t.highway === 'pedestrian' || t.place === 'square') ? 'plaza' : null);
const trees = processTrees();
const pois = processPois();

const city = {
  name: 'Pardubice',
  origin: ORIGIN,
  mPerLat: +M_PER_LAT.toFixed(1),
  mPerLon: +M_PER_LON.toFixed(1),
  buildings, roads, rails,
  water: water.polys, waterways: water.lines,
  green, paved, trees, pois,
};

mkdirSync('public/data', { recursive: true });
const json = JSON.stringify(city);
writeFileSync('public/data/pardubice.json', json);

// ---- report ----
const drivable = roads.filter(r => r.d);
const stats = {
  buildings: buildings.length,
  named: buildings.filter(b => b.n).length,
  multipoly: buildings.filter(b => b.i).length,
  roads: roads.length,
  drivable: drivable.length,
  drivableKm: +(drivable.reduce((s, r) => {
    let d = 0;
    for (let i = 0; i < r.p.length - 1; i++) d += Math.hypot(r.p[i + 1][0] - r.p[i][0], r.p[i + 1][1] - r.p[i][1]);
    return s + d;
  }, 0) / 1000).toFixed(1),
  rails: rails.length, waterPolys: water.polys.length, green: green.length,
  paved: paved.length, trees: trees.length, pois: pois.length,
  sizeMB: +(json.length / 1e6).toFixed(2),
};
console.log(stats);
const station = buildings.find(b => /hlavní nádraží|main station/i.test(b.n ?? ''))
  ?? pois.find(p => p.t === 'station' && /pardubice/i.test(p.n ?? ''));
console.log('station found:', station ? JSON.stringify(station.n ?? station).slice(0, 120) : 'NOT FOUND');
