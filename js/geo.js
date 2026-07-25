// ---- City data: loading, spatial index, geometry helpers ----
// Everything the game knows about the world comes through here. loadCity()
// speaks BOTH data dialects: the legacy single-city JSON (pardubice.json,
// indexed whole at load) and the region manifest (public/data/manifest.json,
// where the world starts EMPTY and 4.8 km tiles stream in around the player
// via city.ensureTiles). Either way the caller gets one identical `city`
// object whose per-chunk index feeds streaming, collision and traffic — no
// consumer ever learns which dialect fed it. Pure math helpers (point-in-
// polygon, segment distance, bridge ramps) live here too — meshes, traffic
// and player all share one geometry truth.

import { CHUNK, BRIDGE_Y, BRIDGE_RAMP } from './config.js';

// how far ahead of the focus a tile starts loading. View streams ±600 m, so
// 2600 m of headroom means even 130 km/h driving gives a fetch ~55 s before
// its chunks could enter view — tiles are indexed long before they're seen.
const TILE_REACH = 2600;

export const chunkKey = (x, z) => Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// distance from point to segment + the closest point (into out {x,z,t})
export function distPointToSegment(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const cx = ax + dx * t, cz = az + dz * t;
  if (out) { out.x = cx; out.z = cz; out.t = t; }
  return Math.hypot(px - cx, pz - cz);
}

// Bridge decks run FLAT at BRIDGE_Y — the river below them is what's sunken
// (WATER_Y), which is how real Pardubice bridges read. Only a short blend at
// each way end eases the curb-height step onto the approach street.
export function bridgeElevation(dist, totalLen) {
  const edge = Math.min(dist, totalLen - dist);
  return Math.max(0, Math.min(BRIDGE_Y, (edge / BRIDGE_RAMP) * BRIDGE_Y));
}

export function polylineLength(p) {
  let L = 0;
  for (let i = 0; i < p.length - 1; i++) L += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  return L;
}

// iterate chunk keys in a square radius around a world position
export function forEachChunkInRadius(x, z, r, fn) {
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) fn((cx + dx) + ',' + (cz + dz), cx + dx, cz + dz);
}

// feature bbox → every chunk cell it touches. `touched` (optional Set)
// collects the keys of cells that gained features — tile streaming hands it
// to CityWorld so already-built chunk meshes can be invalidated PRECISELY
// (long rivers/roads overhang their tile by kilometers; guessing bounds from
// the tile rectangle would miss those cells).
function bucketize(index, list, kind, touched) {
  for (const f of list) {
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const ring = f.o ?? f.p ?? (typeof f[0] === 'number' ? [f] : f);
    for (const [x, z] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    f._home = chunkKey(ring[0][0], ring[0][1]); // rendered once, here
    for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++)
      for (let cz = Math.floor(minZ / CHUNK); cz <= Math.floor(maxZ / CHUNK); cz++) {
        const key = cx + ',' + cz;
        let cell = index.get(key);
        if (!cell) index.set(key, cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
        cell[kind].push(f);
        touched?.add(key);
      }
  }
}

// push(...src) blows the argument stack on region-sized arrays — loop instead
function appendAll(dst, src) { for (const f of src) dst.push(f); }

// Index ONE data payload into the city — the legacy whole-city JSON and a
// region tile share the exact same compact format, so this is the single
// place that stamps _id (continuing counter — dedupe at mesh time keys on
// it), wraps bare tree points, precomputes road _len (bridges + traffic both
// need it), buckets everything into the chunk index and GROWS the flat city
// arrays (traffic builds its first graph from city.roads; minimap redraws
// from all of them). Returns the slices tile listeners care about.
function indexPayload(city, data, touched) {
  const stamp = (list) => { for (const f of list ?? []) f._id = city._nextId++; return list ?? []; };
  const buildings = stamp(data.buildings), roads = stamp(data.roads), rails = stamp(data.rails),
    water = stamp(data.water), green = stamp(data.green), paved = stamp(data.paved);
  // trees are bare [x,z] pairs — wrap so they can carry _home/_id like the rest
  const trees = (data.trees ?? []).map(t => ({ p: [t], _id: city._nextId++ }));
  for (const r of roads) r._len = polylineLength(r.p);
  bucketize(city.chunkIndex, buildings, 'buildings', touched);
  bucketize(city.chunkIndex, roads, 'roads', touched);
  bucketize(city.chunkIndex, rails, 'rails', touched);
  bucketize(city.chunkIndex, water, 'water', touched);
  bucketize(city.chunkIndex, green, 'green', touched);
  bucketize(city.chunkIndex, paved, 'paved', touched);
  bucketize(city.chunkIndex, trees, 'trees', touched);
  appendAll(city.buildings, buildings);
  appendAll(city.roads, roads);
  appendAll(city.rails, rails);
  appendAll(city.water, water);
  appendAll(city.green, green);
  appendAll(city.paved, paved);
  appendAll(city.trees, trees);
  appendAll(city.waterways, data.waterways ?? []); // not bucketized — minimap-only
  appendAll(city.pois, data.pois ?? []);           // not bucketized — HUD/labels
  const signals = data.signals ?? [];              // [[x,z],…] — traffic lights v3
  appendAll(city.signals, signals);
  return { roads, signals };
}

const _resolved = Promise.resolve(); // ensureTiles' no-work answer, allocated once

export async function loadCity(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`city data: HTTP ${res.status}`);
  const data = await res.json();
  // One city shape for BOTH dialects. The arrays only ever GROW — consumers
  // (traffic's graph, minimap's redraw) may hold the references forever.
  const city = {
    name: data.name ?? 'Region',
    origin: data.origin, mPerLat: data.mPerLat, mPerLon: data.mPerLon,
    tile: data.tile, // manifest tile size in meters (undefined in legacy mode)
    buildings: [], roads: [], rails: [], water: [], waterways: [],
    green: [], paved: [], trees: [], pois: [], signals: [],
    chunkIndex: new Map(), _nextId: 1,
  };
  // tile-arrival listeners: cb({roads, signals, tx, tz, cells}) fires AFTER a
  // tile is indexed — roads/signals are that tile's slices (with _id/_len),
  // cells the chunk keys that gained features. Legacy mode registers fine and
  // simply never fires (everything is already there).
  const listeners = [];
  city.onTileLoaded = (cb) => { listeners.push(cb); };

  if (!data.tiles) { // legacy single-city file — index it all right now
    indexPayload(city, data);
    city.ensureTiles = () => _resolved; // uniform API: city.js calls this blindly
    return city;
  }

  // ---- manifest mode: the world starts empty and streams in ----
  const T = data.tile;
  // state: 0 idle / 1 loading / 2 indexed. A failed fetch rolls back to 0 so
  // the next ensureTiles pass retries — the region download may still be
  // filling the server, or the network hiccuped; either way we self-heal.
  const tiles = data.tiles.map(t => ({ tx: t.tx, tz: t.tz, f: t.f, state: 0 }));
  // The world map needs the region's EXTENT before any of it has streamed —
  // fitting to the loaded arrays alone showed Pardubice and hid 400 villages.
  city.manifestTiles = tiles;
  const loadTile = async (t) => {
    try {
      const res = await fetch(t.f); // f is app-root-relative, like CITY_DATA_URL
      if (!res.ok) throw new Error(`tile ${t.tx},${t.tz}: HTTP ${res.status}`);
      const payload = await res.json();
      const touched = new Set();
      const { roads, signals } = indexPayload(city, payload, touched);
      t.state = 2;
      for (const cb of listeners) cb({ roads, signals, tx: t.tx, tz: t.tz, cells: touched });
    } catch (err) {
      t.state = 0;
      throw err;
    }
  };
  // Kick off every idle tile whose BOUNDS come within TILE_REACH of (x,z).
  // Resolves when the tiles this call started are all indexed; already-inflight
  // tiles are someone else's promise. Called ~1×/s from CityWorld.update —
  // the linear scan over the manifest (≤ ~50 entries) is nothing at that rate.
  city.ensureTiles = (x, z) => {
    let batch = null;
    for (const t of tiles) {
      if (t.state) continue;
      // distance from focus to the tile AABB: clamp-to-rect, then measure
      const dx = Math.max(t.tx * T - x, 0, x - (t.tx + 1) * T);
      const dz = Math.max(t.tz * T - z, 0, z - (t.tz + 1) * T);
      if (dx * dx + dz * dz > TILE_REACH * TILE_REACH) continue;
      t.state = 1;
      (batch ??= []).push(loadTile(t));
    }
    return batch ? Promise.all(batch) : _resolved;
  };
  return city;
}
