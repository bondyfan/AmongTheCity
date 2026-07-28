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
// …and how far behind it gives its buildings back. The world reaches Prague
// now: driving the D11 end to end crosses ~50 tiles, and holding every
// building of every one of them would be about a gigabyte of live objects on a
// machine that also has to render. So a tile that falls this far behind goes
// SLIM — its buildings and trees are dropped and re-fetched if you come back,
// while its roads, rails, water and green stay resident forever because the
// world map draws them, the traffic graph is built from them, and they are a
// third of the weight for all of the memory of where you have been.
const EVICT_REACH = 9000;
// Feature ids must survive that round trip unchanged: _id seeds the tree size
// jitter, the lamp stagger and which shed is a fast-food franchise, so a
// building that came back with a new id would come back as a different
// building. Ids are therefore derived from the tile, not from a global counter.
const IDS_PER_TILE = 1 << 20;

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

// Legacy relative bridge lift, retained for callers that do not have terrain.
export function bridgeElevation(dist, totalLen) {
  const edge = Math.min(dist, totalLen - dist);
  return Math.max(0, Math.min(BRIDGE_Y, (edge / BRIDGE_RAMP) * BRIDGE_Y));
}

// Absolute bridge-deck height. Adding bridgeElevation() to the terrain at
// every point makes a road faithfully copy the river valley below it. A real
// bridge holds one level across the full OSM bridge way. Its tagged endpoints
// are often already inside the bare-earth river trench, so blending back to
// their sampled heights would create a steep artificial hump at each bank.
// The higher endpoint owns the level so the deck never dives into either side.
export function bridgeDeckHeight(way, dist, terrain) {
  const total = way?._len ?? polylineLength(way?.p ?? []);
  if (!terrain || !way?.p?.length) return bridgeElevation(dist, total);

  let profile = way._bridgeProfile;
  if (!profile || profile.terrain !== terrain) {
    const first = way.p[0], last = way.p[way.p.length - 1];
    const start = terrain.heightAt(first[0], first[1]);
    const end = terrain.heightAt(last[0], last[1]);
    profile = { terrain, start, end, deck: Math.max(start, end) + BRIDGE_Y };
    // Terrain answers 0 while a height tile is still on the way. Remember the
    // profile only after both approaches are authoritative; the arriving tile
    // then rebuilds the chunk and gets a fresh, correct level.
    const ready = !terrain.ready
      || (terrain.ready(first[0], first[1]) && terrain.ready(last[0], last[1]));
    if (ready) way._bridgeProfile = profile;
  }

  return profile.deck;
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
// The cells one feature occupies. Split out of bucketize because eviction has
// to find exactly the same set again to unpick a feature from the index, and
// two copies of this loop would be two chances to disagree.
function forEachCellOf(f, fn) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  const ring = f.o ?? f.p ?? (typeof f[0] === 'number' ? [f] : f);
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++)
    for (let cz = Math.floor(minZ / CHUNK); cz <= Math.floor(maxZ / CHUNK); cz++)
      fn(cx + ',' + cz);
  return ring;
}

function bucketize(index, list, kind, touched) {
  for (const f of list) {
    const ring = forEachCellOf(f, (key) => {
      let cell = index.get(key);
      if (!cell) index.set(key, cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
      cell[kind].push(f);
      touched?.add(key);
    });
    f._home = chunkKey(ring[0][0], ring[0][1]); // rendered once, here
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
// `slot` is the tile's index in the manifest — it makes _id deterministic, so
// a building that is evicted and re-fetched keeps the identity everything
// downstream hashes from. `heavyOnly` is the re-fetch of a SLIM tile: its
// roads and polygons never left, so re-indexing them would double them.
function indexPayload(city, data, touched, slot = 0, heavyOnly = false) {
  let next = slot * IDS_PER_TILE;
  const stamp = (list) => { for (const f of list ?? []) f._id = ++next; return list ?? []; };
  const buildings = stamp(data.buildings);
  // trees are bare [x,z] pairs — wrap so they can carry _home/_id like the rest
  const trees = (data.trees ?? []).map(t => ({ p: [t], _id: ++next }));
  bucketize(city.chunkIndex, buildings, 'buildings', touched);
  bucketize(city.chunkIndex, trees, 'trees', touched);
  appendAll(city.buildings, buildings);
  appendAll(city.trees, trees);
  const heavy = { buildings, trees };
  if (heavyOnly) return { roads: [], signals: [], heavy };

  // ids for the resident layers continue past the heavy ones in the same slot
  const roads = stamp(data.roads), rails = stamp(data.rails),
    water = stamp(data.water), green = stamp(data.green), paved = stamp(data.paved);
  for (const r of roads) r._len = polylineLength(r.p);
  bucketize(city.chunkIndex, roads, 'roads', touched);
  bucketize(city.chunkIndex, rails, 'rails', touched);
  bucketize(city.chunkIndex, water, 'water', touched);
  bucketize(city.chunkIndex, green, 'green', touched);
  bucketize(city.chunkIndex, paved, 'paved', touched);
  appendAll(city.roads, roads);
  appendAll(city.rails, rails);
  appendAll(city.water, water);
  appendAll(city.green, green);
  appendAll(city.paved, paved);
  appendAll(city.waterways, data.waterways ?? []); // not bucketized — minimap-only
  appendAll(city.pois, data.pois ?? []);           // not bucketized — HUD/labels
  const signals = data.signals ?? [];              // [[x,z],…] — traffic lights v3
  appendAll(city.signals, signals);
  return { roads, signals, heavy };
}

const _resolved = Promise.resolve(); // ensureTiles' no-work answer, allocated once

// One tile is indexed per frame, at most, and never in the same task as the
// one before it. Everything queued here is main-thread work measured in tens of
// milliseconds, so the ONLY thing that keeps it from being felt is spreading it
// out. Chained promises give the serialisation; the rAF gives the frame break.
let _indexChain = _resolved;
function indexGate() {
  _indexChain = _indexChain.then(() => new Promise((done) => {
    // rAF alone would DEADLOCK the world: a tab that is not the foreground tab
    // never paints, so the frame callback never comes, so no tile ever indexes
    // — and boot, which awaits the spawn tiles, hangs on the loading spinner
    // forever. The timer is the floor that keeps streaming alive off-screen;
    // whichever fires first wins.
    let fired = false;
    const go = () => { if (!fired) { fired = true; done(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 50);
  }));
  return _indexChain;
}

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
  const listeners = [], unloadListeners = [];
  city.onTileLoaded = (cb) => { listeners.push(cb); };
  // …and the other direction: cb({cells}) after a tile went slim, so built
  // chunk groups holding its buildings can be dropped.
  city.onTileUnloaded = (cb) => { unloadListeners.push(cb); };
  // A building the player has wrecked must not be evicted out from under the
  // wreck; interiors installs this guard.
  city.keepAlive = null;

  if (!data.tiles) { // legacy single-city file — index it all right now
    indexPayload(city, data);
    city.ensureTiles = () => _resolved; // uniform API: city.js calls this blindly
    return city;
  }

  // ---- manifest mode: the world starts empty and streams in ----
  const T = data.tile;
  // state: 0 idle / 1 loading / 2 indexed / 3 slim (buildings + trees evicted,
  // everything else still resident). A failed fetch rolls back to its previous
  // state so the next ensureTiles pass retries — the network hiccuped, or the
  // region download may still be filling the server; either way we self-heal.
  const tiles = data.tiles.map((t, i) => ({
    tx: t.tx, tz: t.tz, f: t.f, wb: t.wb,
    state: 0, slot: i + 1, heavy: null,
  }));
  // The world map needs the region's EXTENT before any of it has streamed —
  // fitting to the loaded arrays alone showed Pardubice and hid 400 villages.
  city.manifestTiles = tiles;
  // distance² from a point to a tile's rectangle (clamp-to-rect, then measure)
  const distSqTo = (t, x, z) => {
    const dx = Math.max(t.tx * T - x, 0, x - (t.tx + 1) * T);
    const dz = Math.max(t.tz * T - z, 0, z - (t.tz + 1) * T);
    return dx * dx + dz * dz;
  };
  const distSqToBounds = (b, x, z) => {
    if (!b || b.length !== 4) return Infinity;
    const dx = Math.max(b[0] - x, 0, x - b[2]);
    const dz = Math.max(b[1] - z, 0, z - b[3]);
    return dx * dx + dz * dz;
  };
  const loadTile = async (t, back) => {
    try {
      const res = await fetch(t.f); // f is app-root-relative, like CITY_DATA_URL
      if (!res.ok) throw new Error(`tile ${t.tx},${t.tz}: HTTP ${res.status}`);
      const payload = await res.json();
      // Measured on a Prague tile: 6.5 MB, 55 ms to parse and 47 ms to index —
      // 100 ms of BLOCKED main thread. Fetches finish whenever the network says
      // so, so three tiles landing together used to freeze a third of a second
      // in one frame, which is exactly the hitch you feel crossing a city at
      // 700 m/s. The gate serialises the indexing and puts each tile on its own
      // frame: the same total work, but never two hitches back to back, and
      // never one while the renderer is trying to present.
      await indexGate();
      const touched = new Set();
      const { roads, signals, heavy } = indexPayload(city, payload, touched, t.slot, back === 3);
      t.heavy = heavy;
      t.state = 2;
      for (const cb of listeners) cb({ roads, signals, tx: t.tx, tz: t.tz, cells: touched });
    } catch (err) {
      t.state = back;
      throw err;
    }
  };
  // Kick off every idle tile whose BOUNDS come within TILE_REACH of (x,z).
  // Resolves when the tiles this call started are all indexed; already-inflight
  // tiles are someone else's promise. Called ~1×/s from CityWorld.update —
  // the linear scan over the manifest (≤ ~200 entries) is nothing at that rate.
  city.ensureTiles = (x, z) => {
    let batch = null;
    for (const t of tiles) {
      if (t.state === 1 || t.state === 2) continue;   // in flight, or already full
      const ownerNear = distSqTo(t, x, z) <= TILE_REACH * TILE_REACH;
      // State 0 has no resident layers yet, so a long river reaching this
      // location may pull in its distant owner tile. State 3 already retained
      // water/roads/rails; only proximity to the owner should re-fetch its
      // evicted buildings and trees, otherwise a long river would cause an
      // endless load → slim → load loop.
      const waterNear = t.state === 0
        && distSqToBounds(t.wb, x, z) <= TILE_REACH * TILE_REACH;
      if (!ownerNear && !waterNear) continue;
      const back = t.state;                            // 0 = never seen, 3 = slim
      t.state = 1;
      (batch ??= []).push(loadTile(t, back));
    }
    evictFar(x, z);
    return batch ? Promise.all(batch) : _resolved;
  };

  // Unpick one tile's buildings and trees from the index and from the flat
  // arrays. Everything is done by identity against a Set of the tile's own
  // features, so a cell shared with a neighbouring tile keeps that neighbour's
  // features untouched.
  function evictFar(x, z) {
    for (const t of tiles) {
      if (t.state !== 2 || !t.heavy) continue;
      if (distSqTo(t, x, z) <= EVICT_REACH * EVICT_REACH) continue;
      const { buildings, trees } = t.heavy;
      if (city.keepAlive && buildings.some(city.keepAlive)) continue;
      const gone = new Set(buildings);
      for (const f of trees) gone.add(f);
      const cells = new Set();
      for (const f of buildings) forEachCellOf(f, (k) => cells.add(k));
      for (const f of trees) forEachCellOf(f, (k) => cells.add(k));
      for (const key of cells) {
        const cell = city.chunkIndex.get(key);
        if (!cell) continue;
        cell.buildings = cell.buildings.filter(f => !gone.has(f));
        cell.trees = cell.trees.filter(f => !gone.has(f));
      }
      // in place — every consumer holds this array by reference, forever
      const compact = (arr) => {
        let w = 0;
        for (let i = 0; i < arr.length; i++) if (!gone.has(arr[i])) arr[w++] = arr[i];
        arr.length = w;
      };
      compact(city.buildings);
      compact(city.trees);
      t.heavy = null;
      t.state = 3;
      for (const cb of unloadListeners) cb({ tx: t.tx, tz: t.tz, cells });
      // ONE per call. Each eviction walks every cell the tile touched and then
      // compacts the whole (six-figure) building array, and a jet leaves half a
      // dozen tiles behind at once — doing them all in one tick is a freeze in
      // its own right. ensureTiles runs every second, so the backlog drains in
      // seconds and nothing is ever more than a tile or two over budget.
      return;
    }
  }
  return city;
}
