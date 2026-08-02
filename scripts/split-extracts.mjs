// ---- Geofabrik .osm.pbf → per-tile raw JSON (the Overpass replacement) ----
// fetch-region.mjs asked Overpass for one 4.8 km bbox at a time. That is a fine
// way to get 72 tiles and a hopeless way to get 185: a dense Prague bbox mostly
// answers "runtime error: the server is probably too busy", and even a clean run
// is three hours of polite waiting on somebody else's free service.
//
// The same data, as a daily country extract, is a 320 MB download that parses in
// under a minute (scripts/lib/osmpbf.mjs). This script turns those extracts into
// exactly the files the existing pipeline already eats: data/raw-region/<tx>_<tz>.json
// holding `{ owned: true, elements: [...] }` where every element has the shape
// Overpass' `out geom` produces — way.geometry, relation.members[].geometry —
// so build-region.mjs needs no new parsing, only permission to trust the split.
//
// OWNERSHIP: Overpass returns a border-crossing way in BOTH tiles, and
// build-region.mjs resolves that by keeping the feature only in the tile holding
// its first vertex. Here each element exists exactly ONCE in the whole country,
// so we do the placing instead — into its first vertex's tile, or the nearest
// wanted tile when that falls outside the world. `owned: true` tells the builder
// the question is already settled (a raw file without the flag is an old
// Overpass download and still gets the first-vertex test).
//
// Usage: node scripts/split-extracts.mjs [extract.osm.pbf …]   (default: all
// four regions in data/raw-osm). Existing raw tiles are OVERWRITTEN.

import { readdirSync, mkdirSync, unlinkSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { readPbf } from './lib/osmpbf.mjs';
import { TILE, xOf, zOf, tileWanted, nearestWanted, wantedTiles, nodeWanted } from './lib/world-area.mjs';

const RAW_DIR = process.env.RAW_DIR || 'data/raw-region';  // overridable for dry runs
const OSM_DIR = 'data/raw-osm';

// ---- which elements the game wants (mirrors fetch-region.mjs' query) --------
const GREEN_LANDUSE = /^(grass|forest|meadow|recreation_ground|cemetery|allotments|village_green|orchard|farmland)$/;
const GREEN_LEISURE = /^(park|garden|pitch|playground|golf_course|stadium)$/;
const GREEN_NATURAL = /^(wood|scrub|grassland)$/;
const RAILWAY = /^(rail|tram|light_rail)$/;
const WATERWAY = /^(river|stream|canal)$/;
const POI_AMENITY = /^(fuel|hospital|police|fire_station)$/;

// Ground that is NOT a field. Measured over a 180 m circle on Pardubice main
// station: 90 % of it carried no polygon this file kept, so the runtime fell
// back to "unmapped ground is a field" and turned the forecourt into a lawn.
// These are the tags that say otherwise — a platform, a railway yard, a works,
// a retail park. `residential` is deliberately NOT here: the ground between
// Czech houses really is garden.
const YARD_LANDUSE = /^(railway|industrial|retail|commercial|construction|quarry|brownfield|landfill|port|depot)$/;

const wantWay = (t) => !!t && (
  !!t.building
  || !!t.highway
  || t.railway === 'platform' || t.public_transport === 'platform'
  || YARD_LANDUSE.test(t.landuse ?? '')
  || !!t.aeroway                    // runways, taxiways, aprons, helipads, hangars
  || RAILWAY.test(t.railway ?? '')
  || t.natural === 'water' || WATERWAY.test(t.waterway ?? '')
  || GREEN_LANDUSE.test(t.landuse ?? '') || GREEN_LEISURE.test(t.leisure ?? '')
  || GREEN_NATURAL.test(t.natural ?? '')
  || (t.amenity === 'parking' && !/underground|multi-storey/.test(t.parking ?? ''))
  || t.place === 'square'
  || t.natural === 'tree_row'
);

// Relations only matter as multipolygons — a building, a lake, a forest whose
// outline has holes. Route/boundary relations carry no geometry we render.
const wantRelation = (t) => !!t && (
  !!t.building
  || t.natural === 'water' || t.waterway === 'riverbank'
  || GREEN_LANDUSE.test(t.landuse ?? '') || GREEN_LEISURE.test(t.leisure ?? '')
  || YARD_LANDUSE.test(t.landuse ?? '')
);

const wantNode = (t) => !!t && (
  t.natural === 'tree' || t.highway === 'traffic_signals' || t.highway === 'bus_stop'
  || t.railway === 'station' || POI_AMENITY.test(t.amenity ?? '')
  || t.aeroway === 'aerodrome'      // the airport's own name, for the map
  // road signs: give way, stop, and anything with an explicit traffic_sign
  // tag (hlavní silnice arrives as traffic_sign=CZ:P2 on a node)
  || t.highway === 'give_way' || t.highway === 'stop'
  || t.traffic_sign !== undefined
);

// ---- tile writer -----------------------------------------------------------
// One append-buffered JSON array per tile. 185 tiles × a 1 MB buffer is nothing,
// and appending in bulk keeps the whole split to a few hundred write syscalls
// instead of a few million.
class TileWriter {
  constructor(dir) {
    this.dir = dir;
    this.buf = new Map();     // key -> string[] pending
    this.size = new Map();    // key -> pending bytes
    this.open = new Set();    // keys whose file already has its "[" prefix
    this.count = new Map();
  }
  add(tx, tz, obj) {
    const key = tx + '_' + tz;
    const s = JSON.stringify(obj);
    let arr = this.buf.get(key);
    if (!arr) this.buf.set(key, arr = []);
    arr.push(s);
    const n = (this.size.get(key) ?? 0) + s.length + 1;
    this.count.set(key, (this.count.get(key) ?? 0) + 1);
    if (n > 1 << 20) this.flush(key); else this.size.set(key, n);
  }
  flush(key) {
    const arr = this.buf.get(key);
    if (!arr?.length) return;
    const file = `${this.dir}/${key}.json`;
    if (!this.open.has(key)) {
      writeFileSync(file, '{"owned":true,"elements":[' + arr.join(','));
      this.open.add(key);
    } else appendFileSync(file, ',' + arr.join(','));
    arr.length = 0;
    this.size.set(key, 0);
  }
  close() {
    for (const key of this.buf.keys()) this.flush(key);
    for (const key of this.open) appendFileSync(`${this.dir}/${key}.json`, ']}');
    // A wanted tile with nothing in it still needs a file, or a re-run would
    // think the download is incomplete and the builder would report it missing.
    for (const [tx, tz] of wantedTiles()) {
      const key = tx + '_' + tz;
      if (!this.open.has(key)) writeFileSync(`${this.dir}/${key}.json`, '{"owned":true,"elements":[]}');
    }
  }
}

// ---- node index ------------------------------------------------------------
// Ids arrive in ascending order in every sorted extract, so the index is just
// three parallel growable arrays and a binary search — no Map, no hashing, and
// ~16 bytes per node instead of the ~80 a Map entry would cost. Coordinates are
// kept as integer 1e-7 degrees, which is OSM's own storage precision.
class NodeIndex {
  constructor(cap = 1 << 21) {
    this.ids = new Float64Array(cap);
    this.lat = new Int32Array(cap);
    this.lon = new Int32Array(cap);
    this.n = 0;
    this.sorted = true;
  }
  push(id, lat, lon) {
    if (this.n === this.ids.length) this._grow();
    if (this.n && id < this.ids[this.n - 1]) this.sorted = false;
    this.ids[this.n] = id;
    this.lat[this.n] = Math.round(lat * 1e7);
    this.lon[this.n] = Math.round(lon * 1e7);
    this.n++;
  }
  _grow() {
    const cap = this.ids.length * 2;
    const ids = new Float64Array(cap); ids.set(this.ids); this.ids = ids;
    const lat = new Int32Array(cap); lat.set(this.lat); this.lat = lat;
    const lon = new Int32Array(cap); lon.set(this.lon); this.lon = lon;
  }
  find(id) {                       // → index or -1
    let lo = 0, hi = this.n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = this.ids[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }
}

// ---- one extract -----------------------------------------------------------
function splitExtract(file, tiles) {
  const t0 = Date.now();
  const idx = new NodeIndex();
  const stats = { nodes: 0, ways: 0, rels: 0, poi: 0, dropped: 0 };

  // Way geometry has to survive until the relations arrive, because a
  // multipolygon's outline is made of member ways that carry no tags of their
  // own. Kept as flat node INDICES (4 bytes each) rather than resolved
  // coordinates — a relation is the only reader and it can look them up.
  const wayIds = []; const wayOff = [0]; let wayRefs = new Int32Array(1 << 22); let wr = 0;
  const pushRefs = (list) => {
    if (wr + list.length > wayRefs.length) {
      const next = new Int32Array(Math.max(wayRefs.length * 2, wr + list.length));
      next.set(wayRefs.subarray(0, wr)); wayRefs = next;
    }
    for (const v of list) wayRefs[wr++] = v;
    wayOff.push(wr);
  };
  const findWay = (id) => {
    let lo = 0, hi = wayIds.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1, v = wayIds[mid];
      if (v === id) return mid;
      if (v < id) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  };

  const geomOf = (i) => {
    const out = [];
    for (let k = wayOff[i]; k < wayOff[i + 1]; k++) {
      const n = wayRefs[k];
      out.push({ lat: idx.lat[n] / 1e7, lon: idx.lon[n] / 1e7 });
    }
    return out;
  };

  // place a feature by its first vertex, exactly as geo.js will pick its home
  const place = (lat, lon) => {
    const x = xOf(lon), z = zOf(lat);
    const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
    return tileWanted(tx, tz) ? [tx, tz] : nearestWanted(x, z);
  };

  readPbf(file, {
    onNode(id, lat, lon, tags) {
      if (!nodeWanted(lat, lon)) return;
      idx.push(id, lat, lon);
      stats.nodes++;
      if (wantNode(tags)) {
        const [tx, tz] = place(lat, lon);
        tiles.add(tx, tz, { type: 'node', id, lat, lon, tags });
        stats.poi++;
      }
    },
    onWay(id, refs, tags) {
      // resolve every ref; a way with a node outside the kept region is a way
      // leaving the world, and half a road is worse than no road
      const nodes = new Array(refs.length);
      for (let i = 0; i < refs.length; i++) {
        const n = idx.find(refs[i]);
        if (n < 0) { stats.dropped++; return; }
        nodes[i] = n;
      }
      // findWay binary-searches this list, so an unsorted extract must not pass
      // silently — it would resolve relation members to the wrong outlines.
      if (wayIds.length && id < wayIds[wayIds.length - 1])
        throw new Error(`${file}: way ids are not ascending — findWay needs a sort pass`);
      wayIds.push(id); pushRefs(nodes);
      if (!wantWay(tags)) return;
      const geometry = new Array(nodes.length);
      for (let i = 0; i < nodes.length; i++)
        geometry[i] = { lat: idx.lat[nodes[i]] / 1e7, lon: idx.lon[nodes[i]] / 1e7 };
      const [tx, tz] = place(geometry[0].lat, geometry[0].lon);
      tiles.add(tx, tz, { type: 'way', id, tags, geometry });
      stats.ways++;
    },
    onRelation(id, members, tags) {
      if (!wantRelation(tags)) return;
      const out = [];
      for (const m of members) {
        if (m.type !== 'way') continue;
        const w = findWay(m.ref);
        if (w < 0) continue;                    // member outside the envelope
        out.push({ type: 'way', ref: m.ref, role: m.role, geometry: geomOf(w) });
      }
      if (!out.length || !out[0].geometry.length) return;
      const first = out[0].geometry[0];
      const [tx, tz] = place(first.lat, first.lon);
      tiles.add(tx, tz, { type: 'relation', id, tags, members: out });
      stats.rels++;
    },
  });

  if (!idx.sorted) throw new Error(`${file}: node ids are not ascending — the index needs a sort pass`);
  console.log(`  ${file.split('/').pop()}: ${stats.nodes.toLocaleString()} nodes in envelope, `
    + `${stats.ways.toLocaleString()} ways, ${stats.rels.toLocaleString()} relations, `
    + `${stats.poi.toLocaleString()} poi nodes  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}

// ---- run -------------------------------------------------------------------
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : readdirSync(OSM_DIR).filter(f => f.endsWith('.osm.pbf')).map(f => `${OSM_DIR}/${f}`);
if (!files.length) {
  console.error(`no .osm.pbf in ${OSM_DIR} — run: node scripts/fetch-world.mjs`);
  process.exit(1);
}

mkdirSync(RAW_DIR, { recursive: true });
// A stale raw-region from the Overpass era would leave the old 72 tiles mixed
// with the new split — same tiles, month-old data, and no `owned` flag. The
// builder reads whatever is on disk, so the directory starts empty.
for (const f of readdirSync(RAW_DIR)) if (f.endsWith('.json')) unlinkSync(`${RAW_DIR}/${f}`);
const tiles = new TileWriter(RAW_DIR);
console.log(`world: ${wantedTiles().length} tiles; splitting ${files.length} extracts`);
for (const f of files) splitExtract(f, tiles);
tiles.close();

let bytes = 0, n = 0;
for (const f of readdirSync(RAW_DIR)) {
  if (!f.endsWith('.json')) continue;
  const s = statSync(`${RAW_DIR}/${f}`).size;
  if (s > 2) { bytes += s; n++; }
}
console.log(`\n${n} raw tiles, ${(bytes / 1e6).toFixed(0)} MB — now: node scripts/build-region.mjs`);
