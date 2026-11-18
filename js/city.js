// ---- CityWorld: streams the city in around the player, answers collision ----
// The whole of Pardubice is ~3.5 MB of footprints and polylines; only the
// chunks near the camera exist as geometry. Each chunk cell becomes one
// THREE.Group built by meshes.js; a small per-frame budget keeps streaming
// hitch-free while driving. Collision reads the chunk index directly — the
// same polygons the meshes were extruded from, so what you see is what you
// hit.

import * as THREE from 'three';
import { CHUNK, VIEW_CHUNKS, CHUNKS_PER_FRAME, LAYER_Y, MISSILE } from './config.js';
import { chunkKey, pointInPolygon, distPointToSegment, bridgeDeckHeight,
  roadGradeY, roadProfile, junctionsIn, junctionDeckY, junctionHull,
  clustersIn, clusterHull, clusterDeckY, streetOf } from './geo.js';
import { holdVerges } from './geo.js';
import { vergeAt, vergeLift, inZone, bayAt, cornerLift, FOOT_LIFT, BAY_W } from './streets.js';
import { makeMaterials, buildChunkMeshes, buildChunkMeshesGen, buildBuildingsMesh, rebase, chunkBase } from './meshes.js';
import { footPullW } from './meshes.js';
import { railGradeY } from './geo.js';
import { takeMeshPool, prewarmMeshPool } from './meshpool.js';
import { Poles } from './poles.js';
import { barrierCollide } from './mwsolid.js';
import { sweepBrandMats } from './meshes.js';
import { sweepWordmarks } from './destructible.js';
import { computeVergeGen } from './streets.js';
const LAMP_BATCHES = [['lampPosts', 'lampHeads'], ['parkPosts', 'parkHeads']];
import { Interiors } from './interiorsim.js';
import { landmarkSolids, solidHas } from './landmarks.js';
import { Terrain, groundFor } from './terrain.js';
import { stampShaped, onQuay } from './quayedge.js';
import { Canopy } from './canopy.js';
import { GroundClass } from './groundclass.js';
import { mwCollide } from './mwsolids.js';
import { freezeStatic } from './scenegraph.js';

// Wake the mesher workers as soon as the page has this module, which is while
// the menu is still up: see prewarmMeshPool. Nothing happens under node.
prewarmMeshPool();

// Give a chunk's GPU memory back. Its geometries, and ALSO the instance buffers
// of its InstancedMeshes (far trees, lamp posts and heads, park lanterns):
// three frees those only when the mesh itself is disposed, and a geometry-only
// walk left one matrix buffer and one colour buffer behind for every batch of
// every cell the streamer ever dropped. They are WebGL buffers, so they never
// showed in renderer.info.memory; they only grew, a few kilobytes a cell, for
// as long as the player kept driving. Materials are shared and stay.
function shed(group) {
  group?.traverse((o) => {
    o.geometry?.dispose?.();
    if (o.isInstancedMesh) o.dispose();
  });
}

// how much of a chunk each tier builds, poorest first — the streamer compares
// these to decide whether a cell it already has is good enough
const LOD_RANK = { ground: 0, shell: 1, full: 2 };

// ---- keeping up with a jet -------------------------------------------------
// Seconds of flight the DATA fetch runs ahead of the aircraft. It has to cover
// a whole tile round trip — fetch, parse, and an index deliberately serialised
// one tile per frame — with room over, because a tile that lands late is a
// chunk built on guessed ground that then has to be built again.
const PREFETCH_S = 20;
// …and the floor, which is geo's own TILE_REACH: at a standstill nothing about
// this changes, and a walking player must still pull in his surroundings.
const TILE_REACH_MIN = 2600;
// Above this the mesher cannot finish a full-detail cell before the aircraft
// has crossed it, so an EMPTY cell is filled at the cheapest tier and upgraded
// afterwards — see the build loop. 110 m/s is 396 km/h: over every car, over
// the helicopter's top speed, and comfortably under the 576 km/h at which the
// holes were measured to start.
const RUSH_FILL = 110;
// Seconds between two looks at which shop wordmarks are still worn: see _sweepMarks.
const MARK_SWEEP_S = 8;

const _closest = { x: 0, z: 0, t: 0 };

// axis-aligned bbox of a way's polyline, cached on the feature — the physics
// loops below run per wheel per frame, and most ways in a cell are nowhere
// near the asker
const lineBB = (f) => {
  if (f._sbb) return f._sbb;
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of f.p) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return (f._sbb = [a, b, c, d]);
};
const _surf = { y: 0, road: false };   // surfaceY's reusable answer
const _pull = { w: 0, t: 0 };          // _footPull's
// How far a kerbed street's verge can reach past its carriageway edge (a lawn
// strip out to a mapped footway, js/streets.js), and how far past a junction's
// outline its corner pavement can: the widening of the bbox rejects below.
const VERGE_REACH = 10.5, CORNER_REACH = 7;

// ---- WHICH surface, when a place has more than one -------------------------
// A bridge and the road beneath it stand on the same ground, and "how high is
// the world at (x, z)" has two answers there. Taking the higher — which is what
// every caller did — is the whole reason you could not drive under a bridge:
// the car popped up onto the deck, drove along it, and fell off the far end.
//
// So the caller says roughly where it IS, and the answer is the highest surface
// that is not over its head. SNAP_UP is the headroom that keeps a car on its
// own deck while it is airborne over a crest; it is far under the clearance of
// any bridge, which is the gap this has to tell apart. With no hint the highest
// still wins — a spawn or a teleport wants to land on top of the world.
//
// One object, no allocation, and shared by surfaceY and heightAt so the two
// cannot drift apart.
const SNAP_UP = 1.5;
export const levels = {
  best: -Infinity, above: Infinity, near: NaN,
  reset(near) { this.best = -Infinity; this.above = Infinity; this.near = near; return this; },
  add(y) {
    if (!(y <= this.near + SNAP_UP)) {          // NaN near → no ceiling, all pass
      if (Number.isFinite(this.near)) { if (y < this.above) this.above = y; return this; }
    }
    if (y > this.best) this.best = y;
    return this;
  },
  // …and if everything here is overhead, the LOWEST of them: a car put down
  // under a viaduct belongs on the road, not on the deck.
  value(fallback = null) {
    return this.best > -Infinity ? this.best : this.above < Infinity ? this.above : fallback;
  },
};

// How much demolition history one session carries. The log exists so a player
// who joins an hour late still finds the holes everybody else made, so it wants
// to be long — but it also goes on the wire in one snapshot message, and
// interiorsim only keeps INTERIOR.maxDamaged wrecks standing anyway, so beyond
// a couple of hundred entries the tail describes buildings that have already
// been restored. Oldest fall off the front.
const HIT_LOG_MAX = 240;
// Blasts waiting for their region tile to stream in. A peer can flatten a
// village 8 km away that this client has never fetched; the hit waits here
// until onTileLoaded says the ground under it exists.
const PENDING_HITS_MAX = 128;
const HIT_IDS_MAX = 8192;          // dedupe set ceiling — see _rememberHit

// ---- earthworks: the terrain conforms to the roads -------------------------
// Every visual disaster this project has fought — terrain lying across a
// carriageway, tall torn edges, kerb walls two metres high, fills breaching
// decks — came from one decision: the roads negotiated with a fixed terrain.
// The survey (DMR 5G, 20 m samples with sharp creases) is not ground anyone
// built on; a real road comes with EARTHWORKS, and the ground around it is
// shaped to meet it. The flat-world build looked right for exactly this
// reason: the ground and the roads were one surface.
//
// So once a height tile and the roads over it are both in, the tile's grid is
// re-shaped ONCE: every sample within a road corridor takes the road's own
// levelled grade, and a shoulder around it blends smoothly back into the
// survey. After that, by construction: the terrain can never rise through a
// deck, every kerb face is the same 25 cm, every fill draped on the ground
// meets the road edge exactly — and the hills stay where no road runs.
//
// The pristine survey is kept per tile, because roads arrive by data tile and
// a later tile can add roads over ground already shaped — the re-bake starts
// from the survey, not from the previous bake.
const CONFORM_FALL = 14;      // m of shoulder blending deck grade into survey
const CONFORM_FOOT = 5;       // …for footways, which move far less earth

// every road touching a terrain tile, via the chunk index (which is cross-tile)
function tileRoads(city, x0, z0, T) {
  const roads = new Map();
  for (let cx = Math.floor(x0 / CHUNK); cx < Math.floor((x0 + T) / CHUNK); cx++) {
    for (let cz = Math.floor(z0 / CHUNK); cz < Math.floor((z0 + T) / CHUNK); cz++) {
      const cell = city.chunkIndex.get(cx + ',' + cz);
      if (!cell) continue;
      for (const r of cell.roads) {
        if (r.br || !r.p || r.p.length < 2) continue;
        roads.set(r._id, r);
      }
      // rails are levelled and bedded exactly like roads — a railway is the
      // most engineered earthwork in any landscape
      for (const r of cell.rails) {
        if (r.br || !r.p || r.p.length < 2) continue;
        roads.set(r._id ?? (r._id = 'rail:' + (cell.rails.indexOf(r))), r);
      }
    }
  }
  return roads;
}

export function conformTerrainTile(terrain, city, tx, tz, st) {
  // levels only: a way's verge waits for its first real use (geo.holdVerges)
  holdVerges(1);
  try {
    const gen = conformTileGen(terrain, city, tx, tz, null, st);
    let it;
    do { it = gen.next(); } while (!it.done);
    return it.value;
  } finally { holdVerges(-1); }
}
// THE BAKE, WITH PLACES TO STOP. One tile was one bite: up to 45 ms of a frame
// in play (measured in wave 3), nearly all of it the stamping loop below, with
// the levels already warm. So it is a generator: the caller with a clock
// (CityWorld._bakeStep) runs it a few milliseconds a frame, everybody else
// drains it in one go and gets exactly what the function used to return.
// Nothing is WRITTEN to the grid until the stamping is complete, so a bake
// abandoned half way (a height map landed under it) leaves no trace.
// `list` is the tile's roads if the caller already has them (the warm-up
// does); `st.applied` is raised once the grid has been written.
function* conformTileGen(terrain, city, tx, tz, list, st) {
  const key = tx + ',' + tz;
  const g = terrain.grids.get(key);
  if (!g) return false;
  terrain._conformed ??= new Set();
  if (terrain._conformed.has(key)) return false;
  terrain._raw ??= new Map();
  if (!terrain._raw.has(key)) terrain._raw.set(key, g.slice());
  const raw = terrain._raw.get(key);
  const n = terrain.n, res = terrain.res, T = terrain.tile;
  const x0 = tx * T, z0 = tz * T;

  const roads = list ?? [...tileRoads(city, x0, z0, T).values()];
  if (!roads.length) { terrain._conformed.add(key); return false; }
  yield;

  // Profiles FIRST, against the pristine survey — they are cached on the way,
  // so every later consumer (ribbons, cars, this bake) reads the same line.
  // If ANY profile is provisional (a far end over a tile still loading), the
  // bake still runs — a shaped guess beats a cliff — but the tile is NOT
  // marked conformed, so the pass returns and re-bakes from the pristine
  // survey once the neighbour lands. It used to mark itself done forever.
  let profReady = true, step = 0;
  for (const r of roads) {
    const pr = roadProfile(r, terrain);
    if (pr && !pr.ready) profReady = false;
    if ((++step & 63) === 0) yield;
  }

  // Road-major stamping: per segment, visit only the grid samples its
  // corridor + shoulder can reach, and keep the strongest claim per sample.
  const tBest = new Float32Array(n * n);
  const hBest = new Float32Array(n * n);
  for (const r of roads) {
    if ((++step & 3) === 0) yield;
    stampWay(r, terrain, x0, z0, n, res, tBest, hBest);
  }
  yield;
  // from here to the marks below is one piece: the grid and its books move together
  if (st) st.applied = true;
  const changed = st ? [] : null;
  const moved = applyStamp(g, raw, tBest, hBest, n, changed);
  // which cells the ground moved under (round 8, HORIZON): a neighbour's
  // arrival re-bakes the tile the car is in, and the stamps of the roads it
  // already had come out the same, so only the cells round the samples that
  // actually changed are meshed again instead of the whole tile (_dropTileChunks)
  if (st) st.cells = movedCells(changed, x0, z0, n, res);
  // The grid is mutated IN PLACE, so anything holding a copy of it — a mesher
  // worker's raster mirror — now holds the wrong ground. This counter is how
  // the pool notices: a tile whose version has moved is re-sent.
  if (moved) {
    terrain._gridVer ??= new Map();
    terrain._gridVer.set(key, (terrain._gridVer.get(key) ?? 0) + 1);
  }
  if (profReady) terrain._conformed.add(key);
  // an unready tile must NOT be retried every frame: a road running off the
  // loaded world keeps its profile unready forever, and re-baking a 4800 m
  // tile per frame is a hang. Stamp the attempt; retry only after new ground.
  else (terrain._conformTried ??= new Map()).set(key, terrain._loads ?? 0);
  // ...and so is every BRIDGE DECK over this tile. A deck is never under the
  // ground along its span (geo.bridgeDeckHeight), it asks the grid as it
  // stands, and the answer is kept: a footbridge first meshed before this bake
  // kept a deck worked out over the survey, one meshed after it stands over
  // the shaped ground. So the same bridge was two shapes, by which of the two
  // a session happened to do first: chunks -2,-2 and -2,1 at the spawn were
  // 12 and 24 vertices apart between a boot into the place and a walk to it
  // (a hump over the street against a level deck), which two co-op players
  // would each have seen their own way. The bake forgets the decks it moved
  // the ground under (forgetGround, with the other memos); `st.decks` names
  // the home cells to mesh again, for a bridge drawn from a neighbouring tile.
  const decks = moved ? (st ? (st.decks = new Set()) : new Set()) : null;
  // Ground memos measured against the survey are stale now. (A column of
  // cells a step: a town tile holds sixty thousand buildings. The chunks over
  // them are only re-queued when this returns, so nothing reads a stale memo
  // into a mesh that is kept.)
  for (let cx = Math.floor(x0 / CHUNK); cx < Math.floor((x0 + T) / CHUNK); cx++) {
    forgetGround(city, cx, z0, T, decks);
    yield;
  }
  return moved > 0;
}

// The three loops of the bake live in plain functions, not in the generator
// above, for a reason that only shows on a stopwatch: a loop that runs long
// inside ONE call of a generator is never swapped for compiled code while it
// runs, so the first bakes of a session (the ones a boot waits for) stamped in
// the interpreter. Measured over the sixteen tiles round the spawn, CPU time
// of a cold bake: 9.1 to 9.2 s with the loops inline, 8.9 s like this, and
// 8.7 to 9.0 s for the function this generator replaced.
function stampWay(r, terrain, x0, z0, n, res, tBest, hBest) {
  const fall = r.d ? CONFORM_FALL : r.t ? CONFORM_FOOT : 8;   // rails: 8 m bed
  const hw = (r.w ?? 3) / 2;
  const reach = hw + fall;
  let along = 0;
  for (let k = 0; k < r.p.length - 1; k++) {
    const [ax, az] = r.p[k], [bx, bz] = r.p[k + 1];
    const segLen = Math.hypot(bx - ax, bz - az);
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - reach - x0) / res));
    const i1 = Math.min(n - 1, Math.ceil((Math.max(ax, bx) + reach - x0) / res));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - reach - z0) / res));
    const j1 = Math.min(n - 1, Math.ceil((Math.max(az, bz) + reach - z0) / res));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = x0 + i * res, z = z0 + j * res;
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d >= reach) continue;
        const o = j * n + i;
        let t = d <= hw ? 1 : 1 - (d - hw) / fall;
        t = t * t * (3 - 2 * t);                    // smooth shoulder
        if (t <= tBest[o]) continue;
        const s2 = along + Math.hypot(_closest.x - ax, _closest.z - az);
        const gy = roadGradeY(r, s2, terrain);
        if (gy === null || gy === undefined) continue;
        tBest[o] = t;
        hBest[o] = gy;
      }
    }
    along += segLen;
  }
}
function applyStamp(g, raw, tBest, hBest, n, changed) {
  let moved = 0;
  for (let o = 0; o < n * n; o++) {
    if (!tBest[o] || raw[o] === -32768) continue;
    const h0 = raw[o] / 10;
    const h1 = h0 + (hBest[o] - h0) * tBest[o];
    const v = Math.round(h1 * 10);
    if (v !== g[o]) { g[o] = v; moved++; changed?.push(o); }
  }
  return moved;
}
// The cells a changed sample can show in: every cell within one sample step
// of it (a chunk's ground reads its neighbours' samples for its normals and
// its edge), as chunk keys.
function movedCells(changed, x0, z0, n, res) {
  const cells = new Set();
  for (const o of changed) {
    const x = x0 + (o % n) * res, z = z0 + Math.floor(o / n) * res;
    const a0 = Math.floor((x - res) / CHUNK), a1 = Math.floor((x + res) / CHUNK);
    const b0 = Math.floor((z - res) / CHUNK), b1 = Math.floor((z + res) / CHUNK);
    for (let a = a0; a <= a1; a++) for (let b = b0; b <= b1; b++) cells.add(a + ',' + b);
  }
  return cells;
}
function forgetGround(city, cx, z0, T, decks) {
  for (let cz = Math.floor(z0 / CHUNK); cz < Math.floor((z0 + T) / CHUNK); cz++) {
    const cell = city.chunkIndex.get(cx + ',' + cz);
    if (!cell) continue;
    for (const b of cell.buildings) { delete b._gy; delete b._gfall; }
    if (!decks) continue;
    for (const list of [cell.roads, cell.rails]) for (const r of list) {
      if (!r.br) continue;
      if (r._bridgeProfile) { r._bridgeProfile = null; if (r._home) decks.add(r._home); }
      // (one grade for a whole viaduct: every member reads it, wherever homed)
      if (r._chain?.profile) {
        r._chain.profile = null;
        for (const m of r._chain.members ?? [r]) if (m._home) decks.add(m._home);
      }
    }
  }
}

// Does a road or rail of tile `t` (its arrival event) lie in, or within a
// stamp's reach of, tile (nx, nz)? Read off the cells it touched: its own ways
// are the ones with an id in its block (geo.js stamps ids by slot, ev.ids).
const REACH_CELLS = 1;        // a stamp reaches CONFORM_FALL + half a motorway: under a cell
function waysReach(city, t, nx, nz, T) {
  if (!t.ids || !t.cells) return true;          // (no way to tell: re-bake, as before)
  const [lo, hi] = t.ids;
  const c0 = Math.floor((nx * T) / CHUNK) - REACH_CELLS, c1 = Math.floor(((nx + 1) * T - 1e-6) / CHUNK) + REACH_CELLS;
  const d0 = Math.floor((nz * T) / CHUNK) - REACH_CELLS, d1 = Math.floor(((nz + 1) * T - 1e-6) / CHUNK) + REACH_CELLS;
  const mine = (f) => typeof f._id === 'number' && f._id > lo && f._id <= hi;
  for (const key of t.cells) {
    const i = key.indexOf(','), cx = +key.slice(0, i), cz = +key.slice(i + 1);
    if (cx < c0 || cx > c1 || cz < d0 || cz > d1) continue;
    const cell = city.chunkIndex.get(key);
    if (!cell) continue;
    for (const r of cell.roads) if (mine(r)) return true;
    for (const r of cell.rails) if (mine(r)) return true;
  }
  return false;
}

export class CityWorld {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.mats = makeMaterials();
    // v5: the inside of the city. The manager owns which buildings currently
    // have rooms, the debris pools, and the people in them; the chunk mesh
    // reads its `hidden` set so a building promoted to boxes stops being
    // drawn twice.
    // The ground. Created before the interiors because everything that asks
    // "how high is the world here" — collision, the walk controller, the debris
    // pool — resolves through heightAt(), and heightAt() is now this.
    this.terrain = new Terrain(city.tile ?? 4800);
    this.mats.terrain = this.terrain;
    // A height map landing changes the SHAPE of ground that has already been
    // meshed, so the chunks over it have to be rebuilt — the same treatment a
    // feature tile gets when it arrives late.
    this.terrain.onTileLoaded((t) => {
      (this._arrivedTiles ??= new Set()).add(t.tx + ',' + t.tz);
      this._dropGuessedChunks();
    });
    // …and how tall whatever stands on it is, which is where half the trees in
    // this world come from — OSM's landuse misses the other half entirely.
    this.canopy = new Canopy(city.tile ?? 4800, 10);
    this.mats.canopy = this.canopy;
    this.canopy.onTileLoaded(() => this._dropGuessedChunks());
    // …and what the unmapped ground is sealed with, read off the orthophoto
    // once, offline, and shipped as a raster (groundclass.js).
    this.ground = new GroundClass();
    this.mats.ground = this.ground;
    this.ground.onTileLoaded(() => this._dropGuessedChunks());
    this.interiors = new Interiors(scene, city, this);
    this.mats.hidden = this.interiors.hidden;
    // Street lamps are collidable, fellable objects rather than scenery. The
    // manager outlives every chunk: it is what remembers, across rebuilds and
    // across the whole session, which masts are lying in the road.
    this.poles = new Poles(scene);
    this.poles.groundAt = (x, z) => this.walkY(x, z);
    this.built = new Map();     // key -> Group (or null for empty cells)
    // Turning this OFF inverts the rule below, so upgrades outrank empty
    // cells exactly as the single-FIFO streamer used to. It exists for one
    // reason: without it the speed regression test cannot prove its own
    // harness still detects a hole, and a test that cannot fail is not a
    // test. Nothing in the game ever writes it.
    this.coverageFirst = true;
    // ---- COVERAGE BEFORE DETAIL --------------------------------------------
    // TWO queues, and the order BETWEEN them is the whole rule: a cell with no
    // geometry at all outranks every cell that merely deserves better than it
    // already has. `queue` is the cells that are EMPTY; `queueUp` the ones that
    // want a richer tier or a sharper photograph.
    //
    // One FIFO could not express that, and at speed it inverted: the scan
    // enqueues nearest-first, but a key's PLACE in the queue was fixed when it
    // was first seen, and at 555 m/s a cell enqueued two seconds ago is a
    // kilometre behind the aircraft. So the budget went on ground already
    // crossed while the ground ahead stayed empty — measured on real Pardubice
    // tiles as a hole under the nose in 526 of 526 frames at 555 m/s, and seen
    // by the player as "only road ribbons, no terrain", because the far-ribbon
    // overlay is the one thing cheap enough to keep up with him.
    //
    // Both are rebuilt from the ring scan EVERY frame, which is what keeps them
    // sorted by current distance: the scan already walks the window ring by
    // ring, so pushing in visit order costs nothing extra and a cell that fell
    // behind loses its place instead of keeping it. Nothing else ever pushes to
    // them — `_stale` is the out-of-band channel, and the scan reads it.
    this.queue = [];            // EMPTY cells, nearest first — always built first
    this.queueUp = [];          // built cells that deserve better, nearest first
    this._stale = new Set();    // keys whose group is out of date (tile, conform)
    this.viewChunks = VIEW_CHUNKS; // runtime-adjustable (settings: draw distance)
    this.chunksPerFrame = CHUNKS_PER_FRAME; // raised in flight — the edge must
                                            // stay ahead of a 60 m/s nose
    // …and the real limit: how many milliseconds of a frame chunk building may
    // eat. At 60 fps a frame is 16.7 ms and the renderer needs most of it, so
    // 7 ms of streaming is a chunk or two of Prague, or a dozen of open field.
    this.buildBudgetMs = 7;
    // Three rings, not two. viewChunks is everything; shellChunks adds the
    // GROUND AND THE BUILDINGS and nothing else; farChunks is the aerial photo
    // alone. The middle one exists because from a helicopter the old two-tier
    // world ended in a village whose houses were only in the photograph.
    this.shellChunks = 0;       // buildings-on-photo ring (flight)
    this.farChunks = 0;         // ground-only ring beyond that
    this._detail = new Map();   // key -> the LOD it was built at ('full'|'shell'|'ground')
    this._px = new Map();       // key -> the ortho detail tier it was built with
    this._hadTerrain = new Map();
    this._missBy = new Map(); // key -> was the ground known when it was built
    this._tileT = 0;            // ensureTiles throttle — 1 Hz, fetches run km ahead
    // Region tiles can land AFTER their chunks were already built: the boot
    // frames raise empty spawn cells before the first fetch returns, and long
    // features (the Labe, a km-long road) overhang far into neighbours' cells.
    // geo reports exactly which cells gained features — drop those groups so
    // the normal streamer rebuilds them with the new data on its next pass.
    // ---- more than one chunk at a time -------------------------------------
    // `_inflight` is key → flight, and the invariant it carries is the one the
    // whole streamer leans on:
    //
    //   A KEY IN `_inflight` IS BEING BUILT AND IS IN NEITHER `built` NOR THE
    //   QUEUE.
    //
    // Every pass that reasons about a cell has to consult it, because those
    // cells are invisible to the other two containers: the ring scan's skip
    // (without it a multi-frame build was followed by a full duplicate
    // rebuild), the stale marking in _requeueCells, the conform sweep in
    // _dropTileChunks, and the buildings re-mesh.
    //
    // At most ONE flight is synchronous (`_syncFlight`) — it is a generator
    // pumped against the frame budget, and two of those would divide the
    // budget rather than spend it. The rest are worker builds, whose share of
    // the frame is a spec and a decode (measured 3.85 ms against 79.5 ms for
    // the same chunk built here), so the cap on those is the pool size.
    this._inflight = new Map();
    this.pool = takeMeshPool();
    this._poolFails = 0;
    // On the ground, in play: a full-detail cell waits for a worker instead of
    // being started on this thread. Set by main.js with the other pacing
    // knobs; off (the old behaviour) during boot, in the air and in tests.
    this.workersFirst = false;
    // Bytes of worker-built geometry one frame may take: see _landFlights.
    // Unbounded until main.js says the game is in play (a boot wants it all).
    this.landBytes = Infinity;
    // Milliseconds a frame for levelling the roads of a tile whose earthworks
    // are due: see _warmRoads. Unbounded (the whole tile in one go) until
    // main.js says the game is in play.
    this.conformBudgetMs = Infinity;
    // Milliseconds a frame for making the verges of the streets ahead of the
    // chunk specs that need them: see _warmVerges. Off until main.js says the
    // player is on the ground, in play.
    this.vergeBudgetMs = 0;
    this._initHits();
    city.onTileLoaded?.((t) => {
      this._requeueCells(t.cells);
      this._tileIn(t, true); this._flushHits();
      // the waterway buckets were built from whatever tiles existed at the
      // FIRST chunk build — a brook indexed later never got its trench
      delete this.city._wwChunks;
      // new roads may have landed over ground already shaped — bake again,
      // from the survey, next update. ONLY the arriving tile and its four
      // neighbours (a border road reaches into them): clearing the whole set
      // re-baked every loaded tile after every data tile, ~0.9 s of main
      // thread each, which was most of the after-boot stutter.
      this._dataLanded(t);                     // ...and whatever was half way through the old roads starts again
      if (this.terrain._conformed && t.tx !== undefined) {
        for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          // (a neighbour only if a way of this tile reaches into it: on the D11
          // every arrival re-baked the tile the car was in, round 8 HORIZON)
          if ((ox || oz) && !waysReach(this.city, t, t.tx + ox, t.tz + oz, this.terrain.tile)) continue;
          this.terrain._conformed.delete((t.tx + ox) + ',' + (t.tz + oz));
          this.terrain._conformTried?.delete((t.tx + ox) + ',' + (t.tz + oz));
        }
      }
    });
    // The far side of streaming: a tile that fell 9 km behind gives its
    // buildings back (geo.js evictFar). Its cells are far out of view, but they
    // must still be dropped from `built` or coming back would find stale groups
    // with no data behind them. A building the player wrecked pins its whole
    // tile — the box model outlives the footprint it was built from.
    city.onTileUnloaded?.((t) => { this._dropCells(t.cells); this._tileIn(t, false); });
    // ...and the player is a place no tile is evicted near, as well as the
    // point the fetches are aimed at (which runs ahead of a fast flier)
    city.evictHolds?.push((out) => { if (this._lfx !== undefined) out.push(this._lfx, this._lfz); });
    if ('keepAlive' in city)
      city.keepAlive = (f) => this.interiors.models.get(f._id)?.damaged === true;
  }

  update(dt, focus, opts) {
    this._inflight ??= new Map();      // …for callers that build one by hand
    this.queueUp ??= []; this._stale ??= new Set();
    this._flushGuessedDrops();
    // interiors stream on their own schedule (they only matter on foot, and
    // they must keep running even while the chunk streamer has nothing to do)
    this.interiors.update(dt, focus, opts?.onFoot ?? false);
    this.poles?.update(dt);
    // How fast the focus is actually travelling, eased. Everything below that
    // has to reason about the future — how far to look ahead, how far to
    // prefetch, whether a full-detail cell can be finished before it is
    // crossed — reads this one number, so it is measured BEFORE the first of
    // them rather than in the middle.
    //
    // The teleport guard used to be a SPEED (90 m/s), which a Gripen exceeds
    // by 6×: above 324 km/h the eased velocity was pinned at zero and the
    // streamer looked ahead by nothing at exactly the speeds that need it
    // most. A teleport is a DISCONTINUITY, so the test is now the jump itself
    // — no aircraft in this game covers 400 m between two frames.
    {
      const dt2 = Math.max(1e-3, dt);
      const jx = focus.x - (this._lfx ?? focus.x), jz = focus.z - (this._lfz ?? focus.z);
      this._lfx = focus.x; this._lfz = focus.z;
      if (Math.hypot(jx, jz) > 400) { this._fvx = 0; this._fvz = 0; }
      else {
        const vx = jx / dt2, vz = jz / dt2;
        this._fvx = (this._fvx ?? 0) + (vx - (this._fvx ?? 0)) * 0.12;
        this._fvz = (this._fvz ?? 0) + (vz - (this._fvz ?? 0)) * 0.12;
      }
    }
    const speed = Math.hypot(this._fvx ?? 0, this._fvz ?? 0);
    const ux = speed > 1 ? this._fvx / speed : 0, uz = speed > 1 ? this._fvz / speed : 0;
    // grow the world as we drive: ask geo (at most once per second) to start
    // fetching any manifest tile now in reach — fire-and-forget, a failure
    // just logs and geo retries that tile on a later call
    this._tileT -= dt;
    if (this._tileT <= 0) {
      this._tileT = 1;
      // ---- PREFETCH BY TIME, NOT BY METRES ---------------------------------
      // geo's own reach is 2600 m, which the comment there prices at 55 s of
      // driving. At 555 m/s it is 4.7 s — less than one tile takes to fetch,
      // parse and index (measured 100 ms of that on the main thread alone, and
      // the indexing is deliberately serialised one tile per frame). So the
      // aircraft outran its own data and arrived over ground nothing had asked
      // for: no height map, no features, a hole.
      //
      // The reach is therefore SPEED × a horizon. The circle is also pushed
      // FORWARD, because a symmetric one of that radius would fetch as many
      // tiles behind the aircraft as in front and they are megabytes each —
      // the lead is capped at one world tile so `evictFar`, which measures
      // from this same point, can never reach the tile under the player.
      const want = speed * PREFETCH_S;
      const lead = Math.min(want * 0.5, this.city.tile ?? 4800);
      const reach = Math.max(TILE_REACH_MIN, want - lead);
      const ax = focus.x + ux * lead, az = focus.z + uz * lead;
      this.city.ensureTiles(ax, az, reach).catch(console.error);
      // …and the ground under them. Reach is generous because a height map is
      // 116 KB against a feature tile's several megabytes, and terrain that
      // arrives late means a chunk gets built flat and then rebuilt.
      this.terrain.ensure(ax, az, Math.max(6000, reach));
      // Earthworks: one tile per pass, so a bake never stalls a frame. A tile
      // that gains roads later (its data tile arriving after its height map)
      // is re-marked below and re-baked from the pristine survey.
      // the FOCUS tile first: the boot gate waits for the ground under the
      // player, and insertion order used to conform five far tiles before it
      // …and after it the NEAREST tile, not the next in insertion order: the
      // spawn stands 25 m from a tile border, and the tile across it used to
      // wait behind four tiles nobody could see. With the bake paced over
      // frames (below) that wait would be the ground under the next street
      // settling long after play began.
      this._pickBake(focus);
      // These two are only read INSIDE the built window — the canopy for the
      // tree scatter, the ground class for what unmapped ground is sealed with
      // — so they follow the geometry rings rather than the clock, but they
      // follow them from the same forward anchor: a cell being meshed ahead of
      // the aircraft needs its rasters before it is meshed, not after.
      const rasterReach = Math.max(2000,
        lead + (this.viewChunks + this.shellChunks) * CHUNK);
      this.canopy.ensure(ax, az, rasterReach);
      this.ground.ensure(ax, az, rasterReach);
      // The far-ribbon sweep is DUE, not run: it builds whole chunks, and
      // running it here spent unbudgeted milliseconds before the ring scan had
      // been offered its first one. It runs below, on what the ring scan left.
      this._ribbonDue = true;
    } else if (this._bake) this._bakeStep();
    else if (this._warm) this._warmRoads(this._warm.key, this._warm.tx, this._warm.tz);
    // BOOT DOES NOT WAIT A SECOND BETWEEN BAKES. Unbudgeted (boot, tests) a
    // bake is the whole tile at once, and the boot gate (readyFull) waits for
    // the four tiles under the spawn window, so pacing them by the 1 Hz pass
    // above held the overlay three seconds of sixty warm-up frames each
    // (measured 13 Nov 2026: 41 warm-up rounds over 7.3 s, four bakes). The
    // next one starts as soon as the last is done, and only once every height
    // map asked for has landed, so the nearest-first ORDER is the one the
    // complete set gives (a border way keeps the profile its first bake gave
    // it: see readyFull), never a guess made over half of them.
    // (Only the tiles in view: those are the gate, and the nearest anyway.)
    else if (!((this.conformBudgetMs ?? Infinity) < Infinity) && !this.terrain._pending?.size) this._pickBake(focus, true);
    // The ring centre leads a moving focus by ~2.2 s of travel, capped at two
    // chunks, so the cells ahead build while they are still far — the pop-in
    // happens out in the fog and the hitch happens before you are close enough
    // to care. This is ON TOP of main.js's own look-ahead, which is why that
    // one keeps three chunks of built world in hand rather than two: these
    // 240 m have to fit inside its margin.
    const LOOK = 2.2, LOOK_MAX = 2 * CHUNK;
    let lx = (this._fvx ?? 0) * LOOK, lz = (this._fvz ?? 0) * LOOK;
    const ll = Math.hypot(lx, lz);
    if (ll > LOOK_MAX) { lx *= LOOK_MAX / ll; lz *= LOOK_MAX / ll; }
    const fx = Math.floor((focus.x + lx) / CHUNK), fz = Math.floor((focus.z + lz) / CHUNK);
    const outer = this.viewChunks + this.shellChunks + this.farChunks;
    // what is surely in the window: a square of half side edgeR round this
    // point (main.js dissolves the window's edge there, heightfog.js setFarEdge)
    this.edgeX = focus.x + lx; this.edgeZ = focus.z + lz; this.edgeR = outer * CHUNK;
    // Sort the window into the two queues, nearest ring first. Cells inside
    // viewChunks want full detail; the ring beyond wants the cheap ground-only
    // tier, and a cell already built at the WRONG level is re-queued so flying
    // low over a distant suburb fills it in rather than leaving a flat photo.
    // Rebuilt from scratch every frame — see the constructor for why the ORDER
    // has to be recomputed against the current focus rather than remembered.
    const fill = this.queue, up = this.queueUp;
    fill.length = 0; up.length = 0;
    for (let r = 0; r <= outer; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const key = (fx + dx) + ',' + (fz + dz);
        // the cell being BUILT right now is in neither `built` nor either
        // queue — without this skip the scan re-enqueued it every frame of
        // its flight and every multi-frame build was followed by a full
        // duplicate rebuild. If it deserves better by the time it lands,
        // the very next scan sees the fresh `built` entry and re-queues it.
        if (this._inflight.has(key)) continue;
        // NOTHING here: coverage, and coverage always wins.
        if (!this.built.has(key)) { fill.push(key); continue; }
        // Otherwise it is an UPGRADE, wanted for one of three reasons: it
        // deserves more GEOMETRY than it has, it deserves a sharper
        // PHOTOGRAPH than it has (which is what stops a chunk keeping the
        // coarse aerial tile it happened to be built with), or something
        // out of band — an arriving tile, a conform — marked it stale.
        const px = this.mats.ortho?.tierOf?.(fx + dx, fz + dz);
        if (this._stale.has(key)
          || LOD_RANK[this._lodAt(r)] > LOD_RANK[this._detail.get(key)]
          || (px !== undefined && this._px.get(key) !== undefined && px > this._px.get(key)))
          up.push(key);
      }
    }
    // Build until the BUDGET is spent, not until a COUNT is reached. A count is
    // a lie about cost: a rural ground-only cell is a single textured quad and
    // a cell in central Prague is two hundred buildings with facades, and they
    // differ by two orders of magnitude. "8 chunks" therefore means 3 ms over
    // Polabí and 300 ms over Vinohrady — which is exactly the stutter you feel
    // flying fast over a city, because the fast machines are the ones that ask
    // for the most cells per second. chunksPerFrame stays as the hard cap so a
    // pathologically cheap area cannot spin the loop forever.
    //
    // A chunk build used to be ATOMIC — 29 to 319 ms of main thread in one
    // bite (measured over Palackého), and the cooldown could only space the
    // bites apart, never shrink them: every arriving chunk was a dropped
    // frame ("když jedu rychle, tak se to posekává"). Slicing spread that cost
    // over frames without removing any of it; the pool REMOVES it — a worker
    // chunk costs this thread its spec and its decode and nothing else. The
    // generator stays as the fallback, and the cooldown still spaces STARTS.
    const budget = performance.now() + this.buildBudgetMs;
    this.pool?.poll();
    this._landFlights(budget, fx, fz, outer);
    this._landRibbons();
    if (this._syncFlight) this._pumpBuild(budget, fx, fz, outer);
    const coolOff = this.buildCooldownMs
      && performance.now() - (this._lastBuildAt ?? 0) < this.buildCooldownMs;
    // A cell that has nothing gets the CHEAPEST tier that shows ground rather
    // than the tier its ring deserves, once the aircraft is moving faster than
    // the mesher can finish a full cell before it is crossed. Measured: a
    // 'full' cell is 26.5 + 0.096·features ms (up to 160 ms in the centre of
    // Pardubice), a 'ground' cell 0.69 ms flat — and the frontier at 555 m/s
    // asks for (2·viewChunks+1) × 4.6 of them a second. Filling cheap and
    // upgrading afterwards is the difference between terrain everywhere and
    // terrain nowhere. Below RUSH_FILL the streamer has always kept up, so
    // boot, walking and driving still build each cell exactly once, at the
    // tier it deserves.
    const cheapFill = speed > RUSH_FILL;
    let qi = 0, ui = 0;
    for (let i = 0; i < this.chunksPerFrame; i++) {
      // always start at least one — otherwise a frame that arrived late never
      // makes progress and the world stops streaming altogether
      if (i > 0 && performance.now() > budget) break;
      // nothing free to build WITH: every worker is busy and the one
      // synchronous slot is taken
      if (!this._freeWorker() && this._syncFlight) break;
      // COVERAGE BEFORE DETAIL: the upgrade queue is not even looked at while
      // one cell in the window is still empty.
      // `!== false`, not a plain truthy test: several tests build a CityWorld
      // with Object.create and never set the flag, and an undefined default
      // would silently hand them the inverted priority.
      const covering = this.coverageFirst !== false ? qi < fill.length : !(ui < up.length);
      // Both sides have to answer with null when they run dry. With coverage
      // first, `covering` is itself the "fill still has one" test and the fill
      // branch cannot overrun — but with it OFF, `covering` only means "the
      // upgrade queue is empty", which is exactly when the fill queue is most
      // likely to be empty too, and `fill[qi++]` then hands back undefined.
      // undefined is not null, so the guard below waved it through into
      // key.split(',') and the frame died on a TypeError.
      const key = covering ? (qi < fill.length ? fill[qi++] : null)
        : (ui < up.length ? up[ui++] : null);
      if (key == null) break;
      const [cx, cz] = key.split(',').map(Number);
      const ring = Math.max(Math.abs(cx - fx), Math.abs(cz - fz));
      // the cooldown yields only to a FIRST build right under the player —
      // a hole in the ground beats a wait, but everything already standing
      // (in-place rebuilds included) can wait its turn
      if (coolOff && !(ring <= 2 && covering)) break;
      const lod = covering && cheapFill ? 'ground' : this._lodAt(ring);
      // …and if nothing could take it, stop: the rest of this frame's
      // iterations would keep re-offering the same key to the same full pool
      if (!this._startBuild(key, cx, cz, lod, budget, fx, fz, outer)) break;
    }
    // Whatever the ring scan LEFT of the budget, and only that: a ribbon build
    // is a whole chunk of carriageways (measured 5.8 ms in the centre) and two
    // of them ran ahead of the ring scan every second, unbudgeted.
    if (this._ribbonDue && performance.now() < budget) this._sweepFarRibbons(focus, budget);
    // drop cells far behind us (hysteresis +2 so the edge doesn't flicker)
    for (const [key, group] of this.built) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - fx), Math.abs(cz - fz)) > outer + 2) {
        if (group) {
          this.scene.remove(group);
          shed(group);
        }
        this.poles?.unregister(key);
        this.built.delete(key);
        this._detail.delete(key);
        this._px.delete(key);
        this._hadTerrain.delete(key);
        this._missBy.delete(key);
        this._stale.delete(key);
        this._rasterRetried?.delete(key);
      }
    }
    this._warmVerges(fx, fz);
    if ((this._markT = (this._markT ?? MARK_SWEEP_S) - dt) <= 0) { this._markT = MARK_SWEEP_S; this._sweepMarks(); }
  }

  // THE BAKE ITSELF, A SLICE A FRAME. _warmRoads below took the levelling out
  // of the frame the bake ran in; what was left was the bake, one bite of up
  // to 45 ms a tile. In play it now runs inside the same conformBudgetMs a
  // frame, on the frames the warm-up is not using. Boot and tests (no budget)
  // bake the tile at once, as before.
  _startBake(key, tx, tz, roads) {
    const st = { applied: false };
    if (!((this.conformBudgetMs ?? Infinity) < Infinity)) {
      if (conformTerrainTile(this.terrain, this.city, tx, tz, st)) this._dropTileChunks(tx, tz, st.cells);
      if (st.decks) this._requeueCells(st.decks);
      return;
    }
    this._bake = { key, tx, tz, st, loads: this.terrain._loads ?? 0,
      gen: conformTileGen(this.terrain, this.city, tx, tz, roads, st) };
    this._bakeStep();
  }

  // A DATA TILE LANDED WHILE WORK WAS SPREAD OVER FRAMES. Three things read the
  // roads and houses as they were: a bake still stamping (it has written
  // nothing, so it is dropped), the verge warm-up (new streets, or the houses
  // that make one a street), and the road warm-up, whose LIST of the tile's
  // ways is handed to the bake when it is done. That list is from before the
  // new ways arrived: a border road of the new tile would never be stamped
  // into this one, and the tile would still be marked as shaped. So the list
  // is gathered again (the levels already worked out are cached on the ways,
  // the second walk only pays for the new ones).
  _dataLanded(t) {
    if (this._bake && !this._bake.st.applied) this._bake = null;
    this._vergeWarm = null;
    if (t?.roads?.length) this._warm = null;
  }

  _bakeStep() {
    const b = this._bake;
    // a height map landed under it: the levels it was reading have moved. It
    // has written nothing yet, so it is dropped and the next pass starts it
    // again from the survey.
    if (!b.st.applied && b.loads !== (this.terrain._loads ?? 0)) { this._bake = null; return; }
    const end = performance.now() + (this.conformBudgetMs ?? Infinity);
    let it;
    holdVerges(1);            // as conformTerrainTile: levels, not verges
    try { do { it = b.gen.next(); } while (!it.done && performance.now() < end); }
    finally { holdVerges(-1); }
    if (!it.done) return;
    this._bake = null;
    if (it.value) this._dropTileChunks(b.tx, b.tz, b.st.cells);
    if (b.st.decks) this._requeueCells(b.st.decks);
  }

  // VERGES BEFORE THE SPEC THAT NEEDS THEM. A way's verge (kerb, pavement,
  // lawn strip: js/streets.js) is worked out on first use, and since the fix
  // round the first use is the spec of a chunk about to go to a worker: 60 to
  // 210 microseconds a way, every way of nine cells, inside one spec. Measured
  // driving into fresh streets, 5 to 15 ms a spec and 15 to 50 at worst, and a
  // spec is not budgeted. So the same derivation is done HERE first, for the
  // ways of the cells the full-detail ring is about to ask for, nearest ring
  // first, inside vergeBudgetMs a frame; the spec then finds them made. It is
  // the same derivation reading the same index, a few frames earlier, and a cell
  // is only warmed once the data tiles its verges read are fully indexed (a
  // verge asks where the houses are), which the spec itself never waited for.
  // On the ground in play only (main.js sets the budget): a boot has no frame
  // to protect, and an aircraft crosses cells faster than this could prepare.
  _warmVerges(fx, fz) {
    const budget = this.vergeBudgetMs ?? 0;
    if (!(budget > 0)) return;
    let s = this._vergeWarm;
    if (!s || s.fx !== fx || s.fz !== fz) s = this._vergeWarm = { fx, fz, r: 0, k: 0, i: 0, gen: null, done: false };
    if (s.done) return;
    const R = this.viewChunks + 1;           // a spec reads the eight cells round its own
    const end = performance.now() + budget;
    for (; s.r <= R; s.r++, s.k = 0) {
      const side = 2 * s.r + 1, cells = s.r ? 8 * s.r : 1;
      for (; s.k < cells; s.k++, s.i = 0) {
        // the k-th cell of ring r, walked round its four sides
        let dx = 0, dz = 0;
        if (s.r) {
          const e = Math.floor(s.k / (side - 1)), o = s.k % (side - 1);
          if (e === 0) { dx = -s.r + o; dz = -s.r; }
          else if (e === 1) { dx = s.r; dz = -s.r + o; }
          else if (e === 2) { dx = s.r - o; dz = s.r; }
          else { dx = -s.r; dz = s.r - o; }
        }
        const cx = fx + dx, cz = fz + dz, key = cx + ',' + cz;
        const cell = this.city.chunkIndex.get(key);
        if (!cell || !this._vergeDataIn(cx, cz)) continue;
        const roads = cell.roads;
        for (; s.i < roads.length; s.i++) {
          const r = roads[s.i];
          if (r._vg !== undefined) { s.gen = null; continue; }
          // one way can be a street the length of the town: it is worked out a
          // segment at a time too, and only becomes the way's verge when whole
          s.gen ??= computeVergeGen(this.city, r);
          let it;
          do { it = s.gen.next(); } while (!it.done && performance.now() < end);
          if (!it.done) return;
          s.gen = null;
          // (a spec or a wheel that needed it meanwhile made it the fast way:
          // the same answer from the same index, and theirs stands)
          if (r._vg === undefined) r._vg = it.value;
          if (performance.now() >= end) { s.i++; return; }
        }
        // ...and the kerbs of this cell's junction pads, which are first-use
        // work behind the same door (geo.junctionsIn / clustersIn)
        junctionsIn(key); clustersIn(key);
        if (performance.now() >= end) { s.k++; s.i = 0; return; }
      }
    }
    s.done = true;
  }

  /** Are the data tiles a verge in this cell reads (its own, and the one across
   *  a border within a cell of it) fully indexed? Always, off the tile manifest. */
  _vergeDataIn(cx, cz) {
    const tiles = this.city.manifestTiles, T = this.city.tile;
    if (!tiles || !T) return true;
    let by = this._tileBy;
    if (!by) { by = this._tileBy = new Map(); for (const t of tiles) by.set(t.tx + ',' + t.tz, t); }
    const x0 = (cx - 1) * CHUNK, x1 = (cx + 2) * CHUNK - 1e-3, z0 = (cz - 1) * CHUNK, z1 = (cz + 2) * CHUNK - 1e-3;
    for (let tx = Math.floor(x0 / T); tx <= Math.floor(x1 / T); tx++) {
      for (let tz = Math.floor(z0 / T); tz <= Math.floor(z1 / T); tz++) {
        const t = by.get(tx + ',' + tz);
        if (t && t.state !== 2) return false;
      }
    }
    return true;
  }

  // WORDMARKS NOBODY WEARS. Every shop name is a 1024 x 256 canvas and a
  // texture, cached by name in two places: the far tier's (js/meshes.js) and
  // the box shells' (js/destructible.js). Neither cache ever let go, so a
  // session held every name it had driven past: 430 boards at the old town
  // after three laps of a tour, about a megabyte of canvas and 1.3 of GPU
  // memory each, and the "5 to 10 textures a lap" nobody had traced. Every few
  // seconds the materials actually worn (by a built chunk or a standing shell)
  // are gathered and the two caches drop what has been idle for two sweeps
  // running. A dropped name is painted again the next time a build asks.
  _sweepMarks() {
    const used = this._marksUsed ??= new Set();
    used.clear();
    const note = this._markNote ??= (o) => {
      const m = o.material;
      if (!m) return;
      if (Array.isArray(m)) { for (const e of m) if (e.map) used.add(e); } else if (m.map) used.add(m);
      // a chunk's merged wordmarks wear the shared page: the labels it shows
      // are listed on the mesh (js/wordmarkatlas.js mergeMarks), and a label
      // freed under it would hand its slot to another chain's name
      const mk = o.userData.marks;
      if (mk) for (let i = 0; i < mk.length; i++) used.add(mk[i]);
    };
    for (const [key, g] of this.built) if (g && this._detail.get(key) !== 'ground') g.traverse(note);
    for (const m of this.interiors?.models?.values() ?? []) m.group?.traverse(note);
    sweepWordmarks(used);
    const gone = sweepBrandMats(used);
    const cm = this.mats?.codecMats;
    if (gone && cm) for (const k in cm) if (gone.includes(cm[k])) delete cm[k];
    used.clear();
  }

  /** Earthworks: start the bake of the nearest unconformed tile, if any is due. */
  _pickBake(focus, inView = false) {
    const TT = this.city.tile || 4800;
    let pick = null, pickD = Infinity, ptx = 0, ptz = 0;
    for (const tk of this.terrain.grids.keys()) {
      if (!this.terrain.grids.get(tk)) continue;
      if (this.terrain._conformed?.has(tk)) continue;
      // tried while some profile was provisional, and nothing new has
      // landed since: trying again would compute the same guess
      if (this.terrain._conformTried?.get(tk) === (this.terrain._loads ?? 0)) continue;
      const [ttx, ttz] = tk.split(',').map(Number);
      if (inView && !this._tileInView(ttx, ttz, focus)) continue;
      const d = Math.max(ttx * TT - focus.x, focus.x - (ttx + 1) * TT,
        ttz * TT - focus.z, focus.z - (ttz + 1) * TT, 0);
      if (d < pickD) { pickD = d; pick = tk; ptx = ttx; ptz = ttz; }
    }
    // in play the bake waits until its roads have been levelled, a few
    // milliseconds a frame: see _warmRoads
    if (pick !== null && !this._bake && this._warmRoads(pick, ptx, ptz)) {
      const roads = this._warm?.key === pick ? this._warm.roads : null;
      this._warm = null;
      this._startBake(pick, ptx, ptz, roads);
    }
  }

  // LEVEL A TILE'S ROADS BEFORE ITS EARTHWORKS, A SLICE A FRAME. The bake
  // above reads every road's levelled profile, and for a tile nobody has
  // driven through yet that is the FIRST ask for each of several thousand
  // ways: the levelling, its junction heights and (since the streets went in)
  // the verge of every one, all in the single frame the bake ran in. Measured
  // in wave 3 on the drive out of the station, one tile a second for the
  // first seconds of play: 837, 583, 516 and 408 ms of this thread, against
  // 12 to 38 ms for the same bake once the profiles exist. The profiles are
  // cached on the ways, so they are simply asked for here first, inside
  // conformBudgetMs a frame, and the bake runs when the last one is in.
  // Infinity (boot, where the gate waits for this ground, and tests) keeps
  // the old all-at-once behaviour.
  // @returns true when the tile's roads are levelled and it may be baked
  _warmRoads(tk, tx, tz) {
    const budget = this.conformBudgetMs ?? Infinity;
    if (!(budget < Infinity)) return true;
    let s = this._warm;
    if (!s || s.key !== tk) {
      const T = this.terrain.tile;
      s = this._warm = { key: tk, tx, tz, i: 0,
        roads: [...tileRoads(this.city, tx * T, tz * T, T).values()] };
    }
    const end = performance.now() + budget;
    // at least one a call, whatever the clock says, or a late frame stalls it
    holdVerges(1); try {      // as the bake itself: levels now, verges on first use
    while (s.i < s.roads.length) {
      roadProfile(s.roads[s.i++], this.terrain);
      if (performance.now() >= end) break;
    }
    } finally { holdVerges(-1); }
    return s.i >= s.roads.length;
  }

  /** Is there a worker sitting idle? (The pool is absent in headless tests.) */
  _freeWorker() { return !!this.pool && !this.pool.dead && this.pool.free() > 0; }

  /**
   * Send one cell off to be meshed. A worker takes it when one is free and the
   * cell can be described as data; otherwise it goes down the generator path,
   * which is the only one that always works.
   * @returns false when neither could take it. The key is simply dropped: the
   *   queues are rebuilt from the ring scan every frame, so an unbuilt cell
   *   re-offers itself next frame, at whatever priority it deserves BY THEN.
   */
  _startBuild(key, cx, cz, lod, budget, fx, fz, outer) {
    const flight = {
      key, cx, cz, lod,
      // the ground under the CENTRE, asked now rather than at finalize: by
      // then a height map may have landed and the chunk would register as
      // built on ground it never saw
      hadTerrain: this.terrain.ready(cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2),
      stale: false,
    };
    let declined = false;
    if (this._freeWorker()) {
      const job = this.pool.submit(this, cx, cz, lod);
      if (job) {
        flight.job = job;
        flight.pool = this.pool;
        this._inflight.set(key, flight);
        return true;
      }
      // submit() declined — no city data for this cell, or a spec it could not
      // gather. Either way the generator can answer and the worker cannot.
      declined = true;
    }
    if (this._syncFlight) return false;     // …but the one slot is taken
    // WORKERS FIRST. With every worker busy the old rule started this cell on
    // the main thread at once, so a healthy pool still left this thread meshing
    // in 7 ms slices for most of a drive (measured over 3 km round the station:
    // 149 cells started here against 98 sent to the four workers), and a full
    // cell is 40 percent more work than it was before the streets, roofs, trees
    // and street furniture went in. A worker comes free within a few hundred
    // milliseconds and the view ring is sixteen seconds of driving deep, so on
    // the ground a full cell simply waits its turn. Two things do not wait: a
    // cell the workers cannot take (declined above), and a HOLE within a cell
    // of the player, where being late is a missing street under the wheels.
    // And nothing waits on a line that is delivering seconds late (pool.slow).
    if (this.workersFirst && !declined && lod === 'full'
      && this.pool && !this.pool.dead && this.pool.ready > 0 && !this.pool.slow
      && !(Math.max(Math.abs(cx - fx), Math.abs(cz - fz)) <= 1 && !this.built.has(key)))
      return false;
    flight.gen = buildChunkMeshesGen(this.city, cx, cz, this.mats, lod);
    // the guess-tracking flags live on SHARED material objects; a paused
    // build stashes its own copies here — see _pumpBuild
    flight.missed = false; flight.missTiles = null;
    flight.canopyMissed = false; flight.groundMissed = false;
    flight.started = false;
    this._inflight.set(key, flight);
    this._syncFlight = flight;
    this._pumpBuild(budget, fx, fz, outer);
    return true;
  }

  /**
   * Bring in whatever the workers have finished. A decode is fractions of a
   * millisecond (the bytes go straight to BufferAttribute), but the scene work
   * around it is not free, so at least one lands per frame and the rest only
   * while the budget holds — the same rule the slice pump follows.
   */
  _landFlights(budget, fx, fz, outer) {
    if (!this._inflight.size) return;
    let landed = 0, bytes = 0;
    for (const flight of [...this._inflight.values()]) {
      if (!flight.job?.done) continue;
      if (landed++ && performance.now() > budget) break;
      // WHAT LANDS HERE IS PAID FOR IN THE NEXT DRAW. Taking a worker chunk
      // costs this thread 0.2 ms, so the millisecond budget above let forty
      // of them land in one frame once the pool was healthy, and the renderer
      // then uploaded all forty before it could draw: measured on a drive
      // round the station, 27 draws over 30 ms and one of 238 ms, with the
      // streamer itself asleep. So a frame also takes a bounded WEIGHT of
      // geometry (always one chunk, however big): about two full cells, or
      // twenty of the ground-only cells a jet needs.
      if (landed > 1 && bytes > (this.landBytes ?? Infinity)) break;
      const bufs = flight.job.reply?.payload?.buffers;
      if (bufs) for (let i = 0; i < bufs.length; i++) bytes += bufs[i].byteLength;
      this._inflight.delete(flight.key);
      let out;
      try {
        // …its OWN pool, not this.pool: retiring the pool below must not strand
        // the chunks the retired workers had already finished
        out = flight.pool.finish(flight.job, this.mats);
      } catch (err) {
        // A chunk that silently never arrives is a hole in the world. A cell
        // that has nothing goes back to the top of the queue by itself — the
        // next ring scan finds it empty — and an in-place rebuild that failed
        // needs the stale mark or the scan would call it finished. After a
        // third failure the pool is retired outright rather than being asked
        // again forever.
        console.warn(`city: worker chunk ${flight.key} failed —`, err?.message ?? err);
        if (++this._poolFails >= 3 && this.pool) { this.pool.dispose(); this.pool = null; }
        this._requeueCells([flight.key]);
        continue;
      }
      this._poolFails = 0;                       // a run of bad luck is not a dead pool
      this._finalizeBuild(flight, out.group, fx, fz, outer,
        out.canopyMissed, out.groundMissed);
    }
  }

  // Run slices of the synchronous chunk build until the budget runs out — at
  // least one slice always, so a late frame still makes progress. The
  // builder's guess-tracking flags (`missed`, `_missTiles`) live on the
  // SHARED terrain/canopy/ground objects, and everything else — the
  // far-ribbon sweep, interior re-meshes, the camera's ground probe, and now
  // the spec gathered for a worker chunk — samples the same terrain between
  // slices. A paused build therefore stashes its flags aside and a resume puts
  // them back: our chunk must neither inherit their misses nor donate its own.
  _pumpBuild(budget, fx, fz, outer) {
    const inf = this._syncFlight;
    const t = this.mats.terrain, cn = this.mats.canopy, gr = this.mats.ground;
    if (inf.started) {
      if (t) { t.missed = inf.missed; t._missTiles = inf.missTiles; }
      if (cn) cn.missed = inf.canopyMissed;
      if (gr) gr.missed = inf.groundMissed;
    }
    inf.started = true;
    let it;
    do { it = inf.gen.next(); } while (!it.done && performance.now() < budget);
    if (!it.done) {
      if (t) { inf.missed = t.missed; inf.missTiles = t._missTiles; t.missed = false; t._missTiles = null; }
      if (cn) { inf.canopyMissed = cn.missed; cn.missed = false; }
      if (gr) { inf.groundMissed = gr.missed; gr.missed = false; }
      return;
    }
    this._syncFlight = null;
    this._inflight.delete(inf.key);
    this._finalizeBuild(inf, it.value ?? null, fx, fz, outer,
      !!cn?.missed, !!gr?.missed);
  }

  /**
   * A finished group takes its place in the world — the same bookkeeping
   * whichever thread built it. `canopyMissed`/`groundMissed` are the builder's
   * own raster flags: the synchronous path reads them off the shared objects,
   * a worker chunk carries its own back, and either way they belong to THIS
   * chunk rather than to whatever sampled the rasters in between.
   */
  _finalizeBuild(inf, group, fx, fz, outer, canopyMissed, groundMissed) {
    const { key, cx, cz, lod } = inf;
    const ring = Math.max(Math.abs(cx - fx), Math.abs(cz - fz));
    if (ring > outer) {                          // drifted out while building
      shed(group);
      // a data tile landed mid-build: the OLD group may still sit in `built`
      // (eviction hysteresis is outer+2), drawn from pre-tile data — hand it
      // to _requeueCells, which drops what lies beyond the ring, so the
      // return trip rebuilds it fresh instead of trusting a stale cell
      if (inf.stale) this._requeueCells([key]);
      return;
    }
    const prev = this.built.get(key);            // rebuilt / upgraded in place
    if (prev) { this.scene.remove(prev); shed(prev); }
    // a finished chunk never moves: its matrices are composed once (js/scenegraph.js)
    if (group) this.scene.add(freezeStatic(group));
    this.built.set(key, group);
    // The lamp masts of this chunk become collidable objects. It has to happen
    // on every build, not once: a rebuild hands over brand-new InstancedMeshes
    // with every pole upright again, and poles.js is what remembers which of
    // them are lying in the road.
    this._registerPoles(key, group);
    this._detail.set(key, lod);
    // …and whatever made it stale has now been answered. Anything that marks
    // it again below re-adds it, which is the ONLY way back into the set.
    this._stale.delete(key);
    // the real cell now draws its own ribbons — the far overlay for this
    // home must go NOW, not at the next sweep, or the two z-fight
    if (lod === 'full') {
      const far = this._farRibbons?.get(key);
      if (far) {
        this.scene.remove(far);
        shed(far);
        this._farRibbons.delete(key);
      }
    }
    // the photo tier the ground mesh was ACTUALLY built with — captured at
    // the fetch slice, because tierOf moves with the focus and finalize can
    // be dozens of frames later: recording the finalize-time tier here let a
    // chunk built with the 512 px photo register as 2400 px and keep the
    // blurry tile against sharp neighbours forever
    this._px.set(key, group?.userData.px !== undefined
      ? group.userData.px : this.mats.ortho?.tierOf?.(cx, cz));
    // The centre having ground is necessary but not sufficient: the builder
    // reports whether ANY vertex it placed was sampled against a height map
    // that had not arrived. Either way the chunk is a guess and must rebuild.
    this._hadTerrain.set(key, inf.hadTerrain && !group?.userData.guessedGround);
    this._missBy.set(key, group?.userData.missTiles ?? null);
    // Three ways a build spread over frames can already be out of date the
    // moment it lands: a height tile it guessed against ARRIVED mid-build
    // (the guessed-chunk sweep consumed that arrival before this chunk
    // registered its guess, so it would wait forever); a region tile added
    // features / interiors re-meshed this cell while it was in flight
    // (`stale`); or a canopy/ground raster landed mid-build — those record
    // no tile list, so the terrain check cannot see them. The raster case
    // retries ONCE per cell (the miss may be a neighbour tile that will
    // never load, and retrying on a present centre tile forever would be a
    // rebuild loop).
    const mx = cx * CHUNK + CHUNK / 2, mz = cz * CHUNK + CHUNK / 2;
    const rasterHealed = (canopyMissed && this.canopy?.ready?.(mx, mz))
      || (groundMissed && this.ground?.ready?.(mx, mz));
    if (inf.stale
      || group?.userData.missTiles?.some((tk) => this.terrain.grids?.get(tk))
      || (rasterHealed && !(this._rasterRetried ??= new Set()).has(key)
        && this._rasterRetried.add(key)))
      this._requeueCells([key]);
    this._lastBuildAt = performance.now();
  }

  // are the 3×3 cells around a position built? (gates the boot overlay)
  ready(pos) {
    const fx = Math.floor(pos.x / CHUNK), fz = Math.floor(pos.z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++)
      if (!this.built.has((fx + dx) + ',' + (fz + dz))) return false;
    return true;
  }

  // The FULL boot gate: everything the first playable frame will show, built
  // before the overlay drops. The 3×3 `ready` above let the player in while
  // the other forty-odd view cells were still streaming, so play began inside
  // the stutter instead of after it. "Fully loaded" here means: the height
  // map under the spawn is present AND conformed to its roads, every cell the
  // ring scan wants is built, and the build queue has gone quiet — including
  // the guessed-ground rebuilds the arriving terrain triggered.
  readyFull(pos) {
    if (!this.terrain.ready?.(pos.x, pos.z)) return false;
    const tk = Math.floor(pos.x / this.city.tile) + ',' + Math.floor(pos.z / this.city.tile);
    if (this.city.tile && !this.terrain._conformed?.has(tk)) return false;
    // ...and so is every other tile under the window. The spawn stands 25 m
    // from a tile corner, so three more tiles are in view, and a bake that
    // lands after the reveal re-meshes the ground the player is looking at.
    // They are the nearest, so the pick in update bakes them first anyway: a
    // tile with no height map yet, or one whose profiles cannot be final
    // (tried, nothing new since), does not hold the gate. (Boot does NOT skip
    // the tiles out of view: deferring them to play moved the bake order, and
    // a way across a tile border keeps the profile it was first levelled to,
    // so a boot into the old town left chunk 16,-2 up to 1.16 m off what a
    // walk there builds; nor did it make boot any faster.)
    if (this.city.tile) {
      const T = this.terrain;
      for (const k of T.grids.keys()) {
        if (!T.grids.get(k) || T._conformed?.has(k) || T._conformTried?.get(k) === (T._loads ?? 0)) continue;
        const c = k.indexOf(',');
        if (this._tileInView(+k.slice(0, c), +k.slice(c + 1), pos)) return false;
      }
    }
    if (this._guessDropWanted) return false;     // guessed chunks awaiting redo
    // every windowed cell BUILT — not "queue empty": arriving photo
    // supertiles re-queue built chunks for sharper textures indefinitely,
    // and waiting for that silence held the overlay at 99 % for minutes
    const { built, total } = this.bootProgress(pos);
    return built >= total && this.ready(pos);
  }

  // ---- far ribbons: the road you are ON must exist, wherever its home is --
  // A way draws WHOLE from the chunk of its first vertex, and a 3 km rural
  // road's home is routinely a kilometre past the streaming ring — so the
  // carriageway under the car simply was not built until you drove most of
  // the way along it. Once a second this sweep looks at every view-ring cell,
  // finds linear features whose home cell is neither built nor already
  // overlaid, and builds that home at the 'roads' tier: ribbons only, a few
  // milliseconds each. The overlay retires when the real cell reaches full
  // detail (which draws the same ribbons) or when nothing in view needs it.
  //
  // IT MAY NOT OUTRUN THE RING SCAN, and it used to in both directions. It ran
  // before the frame's build budget was even opened, so its chunk builds were
  // pure overhead on top of it; and being cheap, it was the only thing that
  // kept pace with a jet — which is precisely why the report was "road ribbons
  // hanging over nothing". So: it spends what the ring scan LEFT, and it does
  // not build at all while a single cell in the window is still empty. The
  // retirement half always runs — dropping what nobody needs is free, and
  // holding it is not.
  _sweepFarRibbons(focus, budget) {
    this._ribbonDue = false;
    const fx = Math.floor(focus.x / CHUNK), fz = Math.floor(focus.z / CHUNK);
    this._farRibbons ??= new Map();          // homeKey -> group
    const needed = new Set();
    for (let dx = -this.viewChunks; dx <= this.viewChunks; dx++) {
      for (let dz = -this.viewChunks; dz <= this.viewChunks; dz++) {
        const cell = this.city.chunkIndex.get((fx + dx) + ',' + (fz + dz));
        if (!cell) continue;
        for (const list of [cell.roads, cell.rails, cell.barriers]) {
          for (const f of list ?? []) {
            const hk = f._home;
            if (hk && this._detail.get(hk) !== 'full') needed.add(hk);
          }
        }
      }
    }
    // build at most two per pass — a pass runs at 1 Hz, and a rural ribbon
    // build is milliseconds, so this never becomes the stutter it is curing
    let builds = 0;
    const mayBuild = !this.queue.length;       // COVERAGE BEFORE DETAIL
    for (const hk of mayBuild ? needed : []) {
      if (this._farRibbons.has(hk)) continue;
      if (builds >= 2 || performance.now() > budget) break;
      const [cx, cz] = hk.split(',').map(Number);
      // TO A WORKER WHEN ONE IS FREE. "A rural ribbon build is milliseconds"
      // stopped being true when a carriageway got kerbs, pavements, rounded
      // corners and junction pads: measured on a drive east of the station in
      // wave 3, one of these was 271 ms of this thread in a single call, the
      // worst hitch of the whole drive. The ribbon is a chunk like any other
      // to the mesher, so it goes the same way and lands in _landRibbons; the
      // slot holds null meanwhile, exactly as it does for a home with nothing
      // to draw, so the pass does not ask twice.
      if (this._freeWorker() && !this._ribbonLocal?.has(hk)) {
        const job = this.pool.submit(this, cx, cz, 'roads');
        if (job) {
          (this._ribbonFlights ??= new Map()).set(hk, { job, pool: this.pool });
          this._farRibbons.set(hk, null);
          builds++;
          continue;
        }
      }
      const group = buildChunkMeshes(this.city, cx, cz, this.mats, 'roads');
      this._farRibbons.set(hk, group ?? null);
      if (group) this.scene.add(freezeStatic(group));
      builds++;
    }
    // retire what nothing needs any more — or what the real chunk now draws
    for (const [hk, group] of this._farRibbons) {
      if (needed.has(hk) && this._detail.get(hk) !== 'full') continue;
      if (this._ribbonFlights?.has(hk)) continue;      // still being meshed: _landRibbons decides
      if (group) {
        this.scene.remove(group);
        shed(group);
      }
      this._farRibbons.delete(hk);
    }
  }

  /** Take the far ribbons the workers have finished. Once a frame; nearly free. */
  _landRibbons() {
    if (!this._ribbonFlights?.size) return;
    for (const [hk, fl] of this._ribbonFlights) {
      if (!fl.job.done) continue;
      this._ribbonFlights.delete(hk);
      let out = null;
      try { out = fl.pool.finish(fl.job, this.mats); }
      catch (err) {
        // not worth a retired pool: forget the slot and the next pass builds
        // this one here, on the path that always works
        console.warn(`city: worker ribbon ${hk} failed:`, err?.message ?? err);
        this._farRibbons.delete(hk);
        // ...and it is built HERE: a ribbon a worker cannot mesh would
        // otherwise be sent, fail and be sent again once a second for as long
        // as it was in view
        (this._ribbonLocal ??= new Set()).add(hk);
        continue;
      }
      // the real chunk may have arrived, or the home left the window, while
      // the ribbon was away
      if (!this._farRibbons.has(hk) || this._detail.get(hk) === 'full') {
        shed(out.group);
        this._farRibbons.delete(hk);
        continue;
      }
      this._farRibbons.set(hk, out.group ?? null);
      if (out.group) this.scene.add(freezeStatic(out.group));
    }
  }

  /**
   * How far the world actually reaches from (x, z) along (dx, dz) — metres to
   * the first cell that has no geometry at all, or `maxM` if none does.
   *
   * The look-ahead is clamped to this. A lead longer than the built world
   * trades a hole in front for a hole UNDERNEATH, which is much the worse of
   * the two: the ring centre moves off the aircraft, the cell it is standing
   * in drops out of the near rings, and collision starts answering against
   * ground that was never meshed. Asking what is built is the only honest
   * bound, because what is built depends on the machine, the area and how long
   * the player has been flying straight — none of which a constant knows.
   */
  builtReach(x, z, dx, dz, maxM) {
    const L = Math.hypot(dx, dz);
    if (!L || !(maxM > 0)) return 0;
    const ux = dx / L, uz = dz / L;
    const step = CHUNK / 2;                  // never skip a cell on a diagonal
    for (let d = step; d <= maxM + step; d += step) {
      const k = Math.floor((x + ux * d) / CHUNK) + ',' + Math.floor((z + uz * d) / CHUNK);
      if (!this.built.has(k)) return Math.max(0, d - step);
    }
    return maxM;
  }

  /** Does world tile tx,tz lie under the built window round `pos` (one chunk of margin)? */
  _tileInView(tx, tz, pos) {
    const T = this.city.tile || 4800;
    const r = (this.viewChunks + this.shellChunks + this.farChunks + 1) * CHUNK;
    const fx = (Math.floor(pos.x / CHUNK) + 0.5) * CHUNK, fz = (Math.floor(pos.z / CHUNK) + 0.5) * CHUNK;
    return tx * T < fx + r && (tx + 1) * T > fx - r && tz * T < fz + r && (tz + 1) * T > fz - r;
  }

  // built / wanted counts over the whole streaming window, for the boot label
  bootProgress(pos) {
    const fx = Math.floor(pos.x / CHUNK), fz = Math.floor(pos.z / CHUNK);
    const r = this.viewChunks + this.shellChunks + this.farChunks;
    let built = 0, total = 0;
    for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
      total++;
      if (this.built.has((fx + dx) + ',' + (fz + dz))) built++;
    }
    return { built, total };
  }

  // Every built chunk inside one world tile, dropped so the streamer rebuilds
  // it — used when a height map lands after its ground was already meshed flat.
  /** Which tier a cell `ring` rings out deserves. */
  _lodAt(ring) {
    if (ring <= this.viewChunks) return 'full';
    if (ring <= this.viewChunks + this.shellChunks) return 'shell';
    return 'ground';
  }

  // Debounced: height tiles land in bursts at boot, and every burst used to
  // drop-and-rebuild the whole guessed set per tile — most of the loading
  // stutter was the same chunks being rebuilt five times in three seconds.
  _dropGuessedChunks() { this._guessDropWanted = true; }

  _flushGuessedDrops() {
    if (!this._guessDropWanted) return;
    const now = performance.now();
    if (now - (this._guessDropAt ?? 0) < 1500) return;
    this._guessDropAt = now;
    this._guessDropWanted = false;
    const arrived = this._arrivedTiles;
    this._arrivedTiles = null;
    const keys = [];
    for (const key of this.built.keys()) {
      // ONLY the chunks that were meshed on ground somebody had to GUESS. A
      // world tile is 40×40 chunks, so dropping the lot on every height map
      // that lands means the whole visible world rebuilds several times over
      // during a normal drive — measured as a fall from 60 fps to 18. A chunk
      // built when the ground was already known is correct and must be left
      // alone.
      //
      // Not restricted to the arriving tile's own chunks, and that is the
      // point: a feature is drawn WHOLE from its home chunk, so the chunk that
      // guessed is routinely in a different tile from the height map that
      // settles the question. buildChunkMeshes records the guess per chunk
      // (userData.guessedGround), so this can simply ask every chunk whether it
      // is still waiting for ground — wherever that ground turned out to be.
      if (this._hadTerrain.get(key)) continue;
      // a chunk that knows WHICH tiles it guessed on only rebuilds when one
      // of them actually arrived; unknown guesses stay conservative
      const miss = this._missBy.get(key);
      if (miss && arrived && !miss.some((tk) => arrived.has(tk))) continue;
      keys.push(key);
    }
    if (keys.length) this._requeueCells(keys);
  }

  // Re-BUILD, don't re-MOVE. Dropping a built chunk blanks it until its turn
  // in the queue comes round again, and with the build cooldown that turn is
  // seconds away — a conform wave used to erase the road under the car for
  // five seconds at a time ("občas to takhle vypadá na 5 s"). A stale cell is
  // MARKED instead, and the build loop replaces the old group in place: the
  // world is briefly out of date, never absent.
  // Cells beyond the streaming window still drop the old way — blanking what
  // nobody can see is free, and keeping it stale forever is not.
  //
  // The mark, not a queue push, is the out-of-band channel now: the two queues
  // are rebuilt from the ring scan every frame, so anything pushed here would
  // be discarded a millisecond later. `_stale` survives the rebuild and the
  // scan reads it — and a stale cell is an UPGRADE, never coverage, because it
  // still has its old geometry standing.
  _requeueCells(cells) {
    if (!cells) return;
    this._stale ??= new Set();
    const fx = Math.floor((this._lfx ?? 0) / CHUNK), fz = Math.floor((this._lfz ?? 0) / CHUNK);
    const outer = this.viewChunks + this.shellChunks + this.farChunks;
    const gone = [];
    for (const key of cells) {
      // the cell being BUILT right now is in neither `built` nor either queue
      // — mark the flight and its finalize re-queues itself with the fresh data
      const flying = this._inflight?.get(key);
      if (flying) { flying.stale = true; continue; }
      if (!this.built.has(key)) continue;
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - fx), Math.abs(cz - fz)) > outer) { gone.push(key); continue; }
      this._stale.add(key);
    }
    if (gone.length) this._dropCells(gone);
  }

  // Drop the built groups of specific cells — the REMOVAL path, for tiles
  // that actually unloaded. Anything merely stale goes through _requeueCells.
  _dropCells(cells) {
    if (!cells) return;
    for (const key of cells) {
      if (!this.built.has(key)) continue; // never built — nothing stale to shed
      const group = this.built.get(key);
      if (group) {
        this.scene.remove(group);
        shed(group);
      }
      this.poles?.unregister(key);
      this.built.delete(key);
      this._stale?.delete(key);
      this._forget(key);
    }
  }

  // The four per-cell notes that go with a built chunk. The ring eviction has
  // always cleared them; the two other ways a chunk is dropped did not, and a
  // session that changed preset over a full air window was carrying 4,680
  // notes for 81 chunks (measured, wave 3).
  _forget(key) {
    this._rasterRetried?.delete(key);
    this._detail.delete(key);
    this._px.delete(key);
    this._hadTerrain.delete(key);
    this._missBy.delete(key);
  }

  /** Drop the built chunks of ONE terrain tile: its ground just moved
   * (only those in `cells`, the bake's own list of where it moved, if given). */
  _dropTileChunks(tx, tz, cells = null) {
    const T = this.terrain.tile;
    const c0x = Math.floor((tx * T) / CHUNK), c1x = Math.floor(((tx + 1) * T) / CHUNK);
    const c0z = Math.floor((tz * T) / CHUNK), c1z = Math.floor(((tz + 1) * T) / CHUNK);
    // a FIRST build in flight is in neither `built` nor the queue, so the
    // scan below cannot see it — but it sampled the heights this conform just
    // moved (a worker chunk was handed the pre-conform grid, a sliced one read
    // it directly). Mark them stale; finalize re-queues them.
    for (const inf of this._inflight?.values() ?? [])
      if (inf.cx >= c0x && inf.cx < c1x && inf.cz >= c0z && inf.cz < c1z)
        inf.stale = true;
    const keys = [];
    for (const key of this.built.keys()) {
      const [cx, cz] = key.split(',').map(Number);
      if (cx < c0x || cx >= c1x || cz < c0z || cz >= c1z) continue;
      if (cells && !cells.has(key)) continue;
      keys.push(key);
    }
    this._requeueCells(keys);
  }

  // Drop every built chunk so the next update() rebuilds it — used when a
  // setting flips the chunk RECIPE itself (ortofoto ground, facades, trees).
  rebuildAll() {
    for (const [key, group] of this.built) {
      if (group) {
        this.scene.remove(group);
        shed(group);
      }
      // a cell outside today's window is never rebuilt: its lamp posts must
      // not stay behind as things to drive into, nor its notes as books
      this.poles?.unregister(key);
      this._forget(key);
    }
    this.built.clear();
    this.queue.length = 0;
    this.queueUp && (this.queueUp.length = 0);
    this._stale?.clear();
    // …and whatever is in flight was started under the OLD recipe. It cannot
    // be recalled — a worker is already meshing it — so it is marked stale and
    // re-queued the moment it lands, which is what every other mid-build
    // invalidation does.
    for (const inf of this._inflight?.values() ?? []) inf.stale = true;
  }

  // What a WHEEL is standing on. heightAt() answers "how high is the world
  // here" for feet and skids; a car needs more — the road DECK renders at
  // LAYER_Y.road above the ground plane (and bridge decks that much above
  // their elevation), so a car placed at heightAt() rides with its tyres 20 cm
  // inside the asphalt, which on a bridge (parapet right beside the wheel)
  // finally became visible. Returns { y, road } and never allocates.
  // The pads of every junction near (x, z), offered to `levels`. The pad is a
  // REAL surface — meshes.js draws it from junctionDeckY over junctionHull —
  // but it belongs to no road, so neither the wheels loop nor the feet loop
  // ever saw it: a player walking onto an embanked crossing fell through the
  // pad to the terrain a metre and a half below and stood in it up to the
  // neck. Same shape, same height function, now load-bearing.
  _padLevels(x, z) {
    const M = 40;                            // a CLUSTER can reach this far over a border
    const ci = Math.floor(x / CHUNK), cj = Math.floor(z / CHUNK);
    const lx = x - ci * CHUNK, lz = z - cj * CHUNK;
    const xs = lx < M ? [0, -1] : lx > CHUNK - M ? [0, 1] : [0];
    const zs = lz < M ? [0, -1] : lz > CHUNK - M ? [0, 1] : [0];
    for (const dx of xs) {
      for (const dz of zs) {
        const key2 = (ci + dx) + ',' + (cj + dz);
        const js = junctionsIn(key2);
        // …and the kerb round each pad (js/streets.js): the corner of a
        // pavement is where people stand to cross, and it is drawn 12 cm up
        if (js) for (const j of js) {
          if (j._cluster || j._ring) continue;   // cluster answers / no pad drawn
          const r = (j.padR ?? 6) + CORNER_REACH;
          if ((x - j.x) ** 2 + (z - j.z) ** 2 > r * r) continue;
          const ring = junctionHull(j);
          if (!ring) continue;
          if (pointInPolygon(x, z, ring)) { levels.add(junctionDeckY(j, x, z, this.terrain) + LAYER_Y.road + 0.012); continue; }
          const up = cornerLift(j, x, z);
          if (up >= 0) levels.add(junctionDeckY(j, x, z, this.terrain) + LAYER_Y.road + up);
        }
        const cls = clustersIn(key2);
        if (cls) for (const cl of cls) {
          const r = cl.padR + CORNER_REACH;
          if ((x - cl.x) ** 2 + (z - cl.z) ** 2 > r * r) continue;
          const ring = clusterHull(cl);
          if (!ring) continue;
          if (pointInPolygon(x, z, ring)) { levels.add(clusterDeckY(cl, x, z, this.terrain) + LAYER_Y.road + 0.012); continue; }
          const up = cornerLift(cl, x, z);
          if (up >= 0) levels.add(clusterDeckY(cl, x, z, this.terrain) + LAYER_Y.road + up);
        }
      }
    }
  }

  surfaceY(x, z, near) {
    _surf.road = false;
    // THE GROUND FIRST. Every height below is a thickness of surfacing — 20 cm
    // of asphalt, 10 of paving, 5 of grass — measured from the ground, not from
    // the sea. Leaving it out parked every car in the world at y ≈ 0.2 while
    // Pardubice sits at 220 m and Prague at 190: the traffic was all there,
    // driving, two hundred metres underground.
    const ground = this.terrain.heightAt(x, z);
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) { _surf.y = ground; return _surf; }
    levels.reset(near);
    for (const r of cell.roads) {
      if (!r.d) continue;
      const half = r.w / 2 + 0.35;               // a wheel just off the kerb still rides the kerb
      // A kerbed street is wider than its carriageway: the pavement beside it
      // is a surface a wheel can be put on, 12 cm up, and a bus lay-by is
      // carriageway the centreline's width does not know about.
      const vg = r.br ? null : streetOf(r);
      const reach = half + (vg ? VERGE_REACH : 0) + (r._bays ? BAY_W : 0);
      const bb = lineBB(r);
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      // The verge is asked of the NEAREST segment only. Round a bend a point
      // in the lane is inside the carriageway of the segment beside it and
      // "a metre past the kerb" of the one before, measured to that one's end:
      // judged segment by segment, every bend had a phantom kerb in its lane.
      let along = 0, bd = Infinity, bs = 0, be = 1;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < reach) {
          const s = along + Math.hypot(_closest.x - ax, _closest.z - az);
          const e = (x - ax) * (bz - az) - (z - az) * (bx - ax) >= 0 ? 1 : -1;
          if (d < bd) { bd = d; bs = s; be = e; }
          const bay = r._bays ? bayAt(r, s, e) : 0;
          if (d < half + bay) {
            // The HIGHER of the ground and the graded profile: the same max()
            // meshes.js laid the ribbon at, so the wheels are on the surface that
            // was drawn and not on either of the two things it was made from.
            const gy = r.br ? bridgeDeckHeight(r, s, this.terrain)
              : (roadGradeY(r, s, this.terrain) ?? ground);
            levels.add(gy + LAYER_Y.road);
          }
        }
        along += Math.hypot(bx - ax, bz - az);
      }
      if (vg && bd < reach && !inZone(r, bs)) {
        const xo = bd - r.w / 2 - (r._bays ? bayAt(r, bs, be) : 0);
        const v = vergeAt(r, bs, be > 0 ? 1 : 0);
        if (xo > 0 && v.w > 0.05 && xo <= v.w) {
          const gy = roadGradeY(r, bs, this.terrain);
          if (gy !== null && gy !== undefined) levels.add(gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo));
        }
      }
    }
    this._padLevels(x, z);
    const best = levels.value();
    if (best !== null) { _surf.y = best; _surf.road = true; return _surf; }
    // car parks and plazas are paved and flat — driveable, not offroad
    for (const p of cell.paved) {
      if (pointInPolygon(x, z, p.o) && !(p.i ?? []).some((h) => pointInPolygon(x, z, h))) {
        _surf.y = ground + LAYER_Y.paved; _surf.road = true; return _surf;
      }
    }
    // …and so is the sealed ground the classifier read off the photograph
    if (this.ground.classAt(x, z) > 0) {
      _surf.y = ground + LAYER_Y.inferred; _surf.road = true; return _surf;
    }
    _surf.y = ground + 0.05;                     // grass, dirt, everything else
    return _surf;
  }

  // Ground height plus bridge decks: standing on a bridge road means standing
  // on its level span, not on the river valley sampled underneath it. Nearest
  // drivable or walkable bridge way within half its width owns the point.
  // `near` — roughly where the asker is; see `levels` above for why a deck over
  // your head is not the ground you are standing on.
  heightAt(x, z, near) {
    const ground = this.terrain.heightAt(x, z);
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return ground;
    levels.reset(near);          // (the ground is offered last: see the foot of this function)
    // rails too: the drawn bed is an absolute graded surface (sleepers at
    // grade + LAYER_Y.rail), and feet that only knew the terrain sank into
    // it — a metre, on a rail bridge
    for (const r of cell.rails ?? []) {
      if (!r.p || r.p.length < 2) continue;
      const bb = lineBB(r);
      if (x < bb[0] - 2.6 || x > bb[2] + 2.6 || z < bb[1] - 2.6 || z > bb[3] + 2.6) continue;
      let dist = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        // (a tram's panel is 2.84 m wide with its chamfers, and no wider than
        // that underfoot: at a railway's 2.6 m either side, feet stepped up
        // onto its level a pace before the concrete began)
        if (d < (r.t === 'tram' && !r.br ? 1.42 : 2.6)) {
          const along = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          if (r.br) levels.add(bridgeDeckHeight(r, along, this.terrain));
          else {
            // the level the mesh laid it at (geo.railGradeY): a tram's is the
            // deck of the street it runs in, a railway's its own bed
            const gy = railGradeY(r, along, this.terrain);
            // a tram runs on a panel set in the street, a touch over the
            // carriageway (meshes.railWay); heavy rail on its sleepers
            if (gy !== null && gy !== undefined) levels.add(gy + (r.t === 'tram' ? LAYER_Y.road + 0.03 : LAYER_Y.rail));
          }
        }
        dist += Math.hypot(bx - ax, bz - az);
      }
    }
    // ---- the footway level, the way the mesh draws it ------------------------
    // A footway is its own levelled strip (LAYER_Y.footway over its own grade)
    // BLENDED toward whatever carriageway it runs beside or arrives at: the
    // pavement level of a kerbed street (kerb height, down a dropped kerb at a
    // crossing), a touch under the asphalt of any other. meshes.roadRibbon
    // does exactly this per vertex; the numbers here are the same numbers, so
    // feet stand on the paving that was drawn. `footOwn` is the footway's own
    // level, `upW` / `upT` the strongest pull on it, and `onRoad` says the
    // point is on a carriageway, where no footway is drawn at all.
    //
    // The pull is asked at the footway's CENTRELINE, not under the feet: the
    // drawn slab is flat across its width at the level its centreline came out
    // at, and a pull judged point by point tilted the answer across it (and
    // flipped it outright where two streets pulled about equally), so along
    // one edge of a lifted footway feet stood a hand deep in the paving.
    let footOwn = -Infinity, fcx = 0, fcz = 0, onRoad = false;
    for (const r of cell.roads) {
      // Bridges, yes — but ALSO embanked ordinary roads: a levelled deck may
      // ride up to GRADE_FILL above the terrain, and feet that only knew the
      // terrain sank into it to the knees on a fill and to the neck on a big
      // one. Any graded deck IS the ground where it runs.
      const br = !!r.br;
      const vg = r.d && !br ? streetOf(r) : null;
      const reach = r.w / 2 + (br ? 1.5 : vg ? VERGE_REACH + (r._bays ? BAY_W : 0) : 5);   // 5 m: the embankment bank
      const bb = lineBB(r);
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      // (the verge and its pull are asked of the NEAREST segment only: see surfaceY)
      let dist = 0, bd = Infinity, bs = 0, be = 1;
      const half = r.w / 2;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < reach) {
          const along = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          if (br) { if (d < half + 1.5) levels.add(bridgeDeckHeight(r, along, this.terrain)); }
          else {
            const gy = roadGradeY(r, along, this.terrain);
            if (gy !== null && gy !== undefined) {
              if (!r.d) {
                // a footway, path or track: its own strip
                // (a hand past its edge and no more: a lifted footway is a
                // slab now, and 35 cm of grace stood people on the air beside it)
                if (d < half + 0.12 && gy + LAYER_Y.footway > footOwn) {
                  footOwn = gy + LAYER_Y.footway; fcx = _closest.x; fcz = _closest.z;
                }
              } else {
                const e = (x - ax) * (bz - az) - (z - az) * (bx - ax) >= 0 ? 1 : -1;
                if (d < bd) { bd = d; bs = along; be = e; }
                const xo = d - half - (r._bays ? bayAt(r, along, e) : 0);   // metres past the kerb line
                if (xo < 0.35) levels.add(gy + LAYER_Y.road);
                if (xo < 0.3) onRoad = true;
              }
              // the embankment bank the mesh draws beside the deck is
              // standable — snug under the edge, falling at 55 %
              if (d < half + 5) {
                const bank = gy + LAYER_Y.road - 0.45
                  - (d > half ? (d - half) * 0.55 : 0);
                // (not over ground a stamp shaped: the mesh draws no bank onto
                // a Prague lower quay or its stairs, meshes.clampUnderRoadsGen,
                // and feet at the foot of a quay stair stood on the air 4 m up)
                if (bank > ground && !stampShaped(this.terrain, x, z)) levels.add(bank);
              }
            }
          }
        }
        dist += Math.hypot(bx - ax, bz - az);
      }
      if (r.d && !br && bd < reach) {
        const gy = roadGradeY(r, bs, this.terrain);
        if (gy !== null && gy !== undefined) {
          const bay = r._bays ? bayAt(r, bs, be) : 0;
          const xo = bd - half - bay;
          const v = vg ? vergeAt(r, bs, be > 0 ? 1 : 0) : null;
          // the generated pavement itself
          // (…but not out over a flight or ramp a stamp cut down to a Prague
          // lower quay: offered there, the pavement 2 m up was within the
          // walker's reach on the top half of the stairs and popped them up)
          if (v && v.u && xo > 0 && v.w > 0.05 && xo <= v.w && !inZone(r, bs) && !stampShaped(this.terrain, x, z)) {
            levels.add(gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo));
          }
        }
      }
    }
    let slab = -Infinity;
    if (footOwn > -Infinity && !onRoad) {
      this._footPull(cell, fcx, fcz, footOwn);
      slab = footOwn + (_pull.t - footOwn) * _pull.w;
      levels.add(slab);
    }
    // THE GROUND, except over a path's own slab. The drawn ground dives under
    // every way's strip (meshes.js clamps it under each corridor), but the
    // height grid does not: where the earthworks of a street beside the path
    // have raised the 20 m samples (the shoulder of an embankment), the grid
    // arches back over the path, and feet that were offered it walked on
    // ground that is not drawn, up to 0.8 m over the cycleway at the foot of
    // the flyover by Kaufland once the kerb pull stopped lifting that path
    // (2.8 km of path within 2.4 km of the spawn had the grid over 15 cm
    // above its slab). On a path's strip the slab is what is there.
    if (slab === -Infinity || ground <= slab) levels.add(ground);
    // (a junction's pad and corner pavement do not reach down a flight to a
    // Prague lower quay: the Trojická corner stood 2 m over its stairs)
    if (!onQuay(x, z)) this._padLevels(x, z);
    return levels.value(ground);
  }

  // The strongest pull of a carriageway on a footway whose centreline passes
  // (x, z), into _pull: the pavement level of a kerbed street out to 6 m and
  // fading over the next 4, a touch under the asphalt of any other within
  // 3.5 m. The same numbers, asked at the same place, as meshes.roadRibbon
  // blends each footway station with, and capped by the same function
  // (meshes.footPullW) against `own`, the footway's own level there: a street
  // up on an embankment does not lift the path at the foot of it.
  _footPull(cell, x, z, own) {
    let upW = 0, upT = 0;
    // (a stair or ramp down to a Prague lower quay stands where its stamp
    // built it: pulled toward the street over the wall it floated 1.6 m over
    // its own foot. meshes.roadRibbon draws it the same way.)
    if (stampShaped(this.terrain, x, z)) { _pull.w = 0; _pull.t = own; return; }
    for (const r of cell.roads) {
      if (!r.d || r.br || !r.p) continue;
      const vg = streetOf(r), half = r.w / 2;
      const reach = half + (vg ? VERGE_REACH + (r._bays ? BAY_W : 0) : 5);
      const bb = lineBB(r);
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      let dist = 0, bd = Infinity, bs = 0, be = 1;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < bd) {
          bd = d; bs = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          be = (x - ax) * (bz - az) - (z - az) * (bx - ax) >= 0 ? 1 : -1;
        }
        dist += Math.hypot(bx - ax, bz - az);
      }
      if (bd >= reach) continue;
      const gy = roadGradeY(r, bs, this.terrain);
      if (gy === null || gy === undefined) continue;
      const bay = r._bays ? bayAt(r, bs, be) : 0;
      const xo = bd - half - bay;
      const v = vg ? vergeAt(r, bs, be > 0 ? 1 : 0) : null;
      if (v && v.u) {
        const t = gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo) + FOOT_LIFT;
        const w = footPullW(xo <= 6 ? 1 : xo >= 10 ? 0 : 1 - (xo - 6) / 4, t - own, xo, v.w);
        if (w > upW) { upW = w; upT = t; }
      } else {
        const t = gy + LAYER_Y.road - 0.04;
        const w = footPullW(xo + bay <= 0 ? 1 : 1 - (xo + bay) / 3.5, t - own, xo + bay);
        if (w > upW) { upW = w; upT = t; }
      }
    }
    _pull.w = upW; _pull.t = upT;
  }

  // Where a WALKER's feet are at (x, z), for callers that only have a position
  // and no height of their own to hint with (the crowd): the highest surface
  // within a storey of the bare ground, so a pavement, a kerb, an embankment or
  // a low deck counts and a flyover overhead does not. `footing` wraps it in
  // the one-method shape pedestrians.js already asks its terrain for.
  //
  // The 2.6 m hint plus SNAP_UP reaches 4.1 m over the ground, and that made
  // every low bridge deck the floor of whoever walked UNDER it: a path passing
  // beneath a footbridge lifted its walkers onto the deck for the width of the
  // bridge and dropped them again (and a signal mast under a flyover stood on
  // the flyover). Hinting at the bare ground instead would do the opposite:
  // everybody ON a bridge between 1.5 and 4.1 m up would walk the valley floor
  // (measured: 620 m of footbridge within 2.4 km of the spawn). A position
  // alone cannot tell the two apart, so the way underfoot decides, and only
  // where the answer really is a bridge: a footway drawn up the side of an
  // embanked street stands as far over the bare ground as any deck, and it is
  // the floor (taking those for decks dropped walkers through a kilometre of
  // raised paving). A deck counts as overhead when the point lies on a way
  // that is on the ground, and the answer is then what it would have been
  // without that deck (asked again, because one flyover may cross another).
  walkY(x, z) {
    const g = this.terrain.heightAt(x, z);
    let y = this.heightAt(x, z, g + 2.6);
    // (nothing more than SNAP_UP over the ground: both hints agree)
    for (let k = 0; k < 3 && y > g + SNAP_UP; k++) {
      const deck = this._deckAt(x, z, y);
      if (!deck || !this._onGroundWay(x, z, deck === 1)) break;
      y = this.heightAt(x, z, y - SNAP_UP - 0.05);
    }
    return y;
  }
  // Is the `y` heightAt answered at (x, z) a bridge deck? 0: no, 1: a
  // footbridge, 2: a road or rail bridge. The same ways, reaches and heights
  // as heightAt itself.
  _deckAt(x, z, y) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return 0;
    for (let pass = 0; pass < 2; pass++) {
      const list = pass ? cell.rails : cell.roads;
      if (!list) continue;
      for (const r of list) {
        if (!r.br || !r.p || r.p.length < 2) continue;
        const reach = pass ? 2.6 : r.w / 2 + 1.5;
        const bb = lineBB(r);
        if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
        let dist = 0;
        for (let i = 0; i < r.p.length - 1; i++) {
          const ax = r.p[i][0], az = r.p[i][1], bx = r.p[i + 1][0], bz = r.p[i + 1][1];
          if (distPointToSegment(x, z, ax, az, bx, bz, _closest) < reach
            && Math.abs(bridgeDeckHeight(r, dist + Math.hypot(_closest.x - ax, _closest.z - az), this.terrain) - y) < 1e-3) {
            return pass || r.d ? 2 : 1;
          }
          dist += Math.hypot(bx - ax, bz - az);
        }
      }
    }
    return 0;
  }
  // Is (x, z) on a way that lies on the ground: a path's own strip, or a
  // carriageway and the pavement beside it? Under a FOOTBRIDGE (`walked`) only
  // a path's own strip counts: the people at that point of a street are the
  // ones crossing over it, and they are on the bridge (counting the street
  // dropped them onto its asphalt for the width of the road).
  _onGroundWay(x, z, walked) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return false;
    for (const r of cell.roads) {
      if (r.br || !r.p || r.p.length < 2 || (walked && r.d)) continue;
      const reach = r.w / 2 + (r.d ? 2 : 0.3);
      const bb = lineBB(r);
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        if (distPointToSegment(x, z, r.p[i][0], r.p[i][1], r.p[i + 1][0], r.p[i + 1][1], _closest) < reach) return true;
      }
    }
    return false;
  }
  get footing() { return (this._footing ??= { heightAt: (x, z) => this.walkY(x, z) }); }

  // What is (x, z) standing on, at or below `maxY`? Terrain and bridge decks
  // as before, plus the floor slabs and stairs of any streamed-in interior —
  // which is the whole mechanism behind walking upstairs: nothing knows what a
  // staircase is, the walk controller merely keeps finding a surface 175 mm
  // higher than the last one.
  supportY(x, z, maxY) {
    let best = this.heightAt(x, z, maxY);
    const roof = this.roofY(x, z, maxY);
    if (roof > best) best = roof;
    const inside = this.interiors.supportY(x, z, maxY);
    return inside > best ? inside : best;
  }

  // ---- where a building actually IS, vertically ----------------------------
  // `b.h` and `b.y` are heights ABOVE THE GROUND — that is what the data file
  // holds and what meshes.js and interiors.js both extrude from. While the
  // ground was a plane at zero they doubled as absolute heights, and every
  // test in this file compared a world-space y against them directly.
  //
  // With terrain they are 221 m out in Pardubice and up to 350 in Zlín, and the
  // comparisons stopped meaning anything: a rocket arriving at a roof 235 m up
  // was tested against `y > b.h` with b.h = 15, so it missed every building in
  // the city and flew on to bury itself in the ground. Nothing could be blown
  // up from the air at all.
  //
  // groundFor() is the same founding rule the chunk mesh and the floor plan
  // use, so these three agree by construction rather than by coincidence.
  _base(b) { return groundFor(b, this.terrain); }
  _top(b) { return groundFor(b, this.terrain) + b.h; }

  // The top of a building you are ABOVE, or terrain height if there is none.
  // Roofs are surfaces, not just the tops of collision blocks: this is what
  // lets a helicopter set down on a block of flats and the pilot climb out and
  // stand there. `fromY` is the querier's own level — a building whose roof is
  // over your head is not something you are standing on, it is something you
  // are inside or beside, so it is skipped. Wrecks are skipped too: their roofs
  // are boxes now, and interiorsim answers for those.
  roofY(x, z, fromY) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return 0;
    let best = 0;
    for (const b of cell.buildings) {
      // a hand-made landmark answers with its own solids (js/landmarks.js):
      // the hotel stands 13 m over the station hall it shares a footprint with
      const lm = landmarkSolids(b);
      if (lm) {
        const g = this._base(b);
        for (const s of lm) {
          const t = g + s.top;
          if (t > best && t <= fromY + 0.05 && solidHas(s, x, z)) best = t;
        }
        continue;
      }
      const top = this._top(b);
      if (top <= best || top > fromY + 0.05) continue;
      if (this.interiors.hidden.has(b._id)) continue;
      if (pointInPolygon(x, z, b.o) && !(b.i ?? []).some((h) => pointInPolygon(x, z, h))) best = top;
    }
    return best;
  }

  /** A handful of body-colour chunks off a crashing car — the debris pool is
   *  the interiors', so wrecks and crashes share one budget and one mesh. */
  /**
   * Hand this chunk's lamp masts to poles.js, or take them back when the chunk
   * has gone. Reads them off the batch rather than off the cell, so it works
   * identically whether the chunk was meshed here or in a worker.
   */
  _registerPoles(key, group) {
    if (!this.poles) return;
    if (!group) { this.poles.unregister(key); return; }
    // two batches at most: street columns and park lanterns (meshes.lampBatch)
    let n = 0;
    for (const [pn, hn] of LAMP_BATCHES) {
      const posts = group.getObjectByName(pn), heads = group.getObjectByName(hn);
      const flat = posts?.userData?.spots;
      if (!posts || !heads || !flat?.length) continue;
      const spots = [];
      for (let i = 0; i + 2 < flat.length; i += 3) spots.push([flat[i], flat[i + 1], flat[i + 2]]);
      this.poles.register(key, spots, posts, heads, this.terrain, n++ > 0);
    }
    if (!n) this.poles.unregister(key);
  }

  crashDebris(x, y, z, color, n, energy) {
    const d = this.interiors?.debris;
    if (!d) return;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = energy * (0.5 + Math.random() * 0.8);
      d.spawn({ x, y: y + 0.4, z, hx: 0.1 + Math.random() * 0.18, hy: 0.04 + Math.random() * 0.08,
        hz: 0.1 + Math.random() * 0.16, yaw: a, col: color ?? 0x888a8e, k: 0.9 },
        Math.cos(a) * e, 2 + Math.random() * 3, Math.sin(a) * e, 9);
    }
  }

  /** Is there destructible-model geometry at this point? (rocket impacts) */
  solidAt(x, y, z) { return this.interiors.occupied(x, y, z, 0.12); }

  // Push a {x,z} point out of building footprints and open water. Returns
  // true if it moved. radius = how fat the collider is (player 0.38, car
  // corners ~0.5). Buildings with a min-height (skyways) are passable.
  //
  // `opts.interior` switches a WALKER onto the box model: buildings whose
  // inside exists stop being solid blocks and become their own walls, doors
  // and (once shot at) holes. Cars and the helicopter never pass it, so for
  // them a building stays the impenetrable footprint it always was.
  collide(pos, radius, opts) {
    let pushed = false;
    // A CAR IS A SOLID OBJECT, even for someone on foot. Walking through a
    // parked Octavia was the same lie as an NPC driving through it, and it
    // stayed in for exactly as long as nobody thought of the pavement as
    // geometry. Hulls come from main.js (see world.carHulls) — every vehicle
    // in the world, whoever owns it.
    const hulls = this.carHulls?.();
    if (hulls) {
      for (const c of hulls) {
        const dx = pos.x - c.x, dz = pos.z - c.z;
        if (dx * dx + dz * dz > 64) continue;                 // 8 m gate
        // the hull as two discs down its axis, like driveStep's own model
        const fx = -Math.sin(c.heading), fz = -Math.cos(c.heading);
        const rr = c.wid * 0.55 + radius;
        const back = c.len / 2 - c.wid * 0.55;
        for (const s2 of [-back, back]) {
          const cx = c.x + fx * s2, cz = c.z + fz * s2;
          const ex = pos.x - cx, ez = pos.z - cz;
          const d2 = ex * ex + ez * ez;
          if (d2 >= rr * rr || d2 < 1e-9) continue;
          const d = Math.sqrt(d2);
          pos.x = cx + (ex / d) * rr;
          pos.z = cz + (ez / d) * rr;
          pushed = true;
        }
      }
    }
    // A LAMP MAST IS SOLID. It is instanced geometry, so it never went near
    // the footprint tests below — you drove through seven metres of steel.
    pushed = this.poles?.collide(pos, radius) || pushed;
    // the D11's median barrier and guard rails (js/mwsolid.js, the mesher's own plan)
    pushed = barrierCollide(this, pos, radius, opts) || pushed;
    // …and so are the D11 gantry legs and sign posts (js/mwsolids.js), never fellable
    pushed = mwCollide(pos, radius, opts?.aboveY, this) || pushed;
    const cell = this.city.chunkIndex.get(chunkKey(pos.x, pos.z));
    if (!cell) return pushed;
    const walker = !!opts?.interior;
    if (walker) {
      pushed = this.interiors.pushOut(pos, radius,
        opts.yLo ?? 0, opts.yHi ?? 1.8) || pushed;
    }
    // `aboveY`: the caller's own level. A building whose ROOF is below you is
    // not in your way — you are over it. Without this the helicopter was
    // shoved off every rooftop it tried to hover onto, and a player standing
    // on one was pushed straight off the edge.
    const above = opts?.aboveY;
    for (const b of cell.buildings) {
      // A hand-made landmark is solid where its MODEL is and as high as its
      // walls stand, not to the tile's height tag: the Green Gate only beside
      // its passage (a piece with `bot` is the masonry over one). Asked BEFORE
      // the skyway test: a gate the tile lifts over its passage (Prašná brána,
      // y 10) stands on the ground in its model, beside the passage; a real
      // skyway's solids all start up in the air and are skipped by `bot`.
      const lm = landmarkSolids(b);
      if (lm) {
        const g = above !== undefined ? this._base(b) : 0;
        for (const s of lm) {
          if (s.bot > 0.5 || (above !== undefined && g + s.top <= above)) continue;
          pushed = this._pushOutOfPoly(pos, radius, s.ring, s.holes, true) || pushed;
        }
        continue;
      }
      if (b.y > 0.5) continue; // skyway/arch: walk under it
      if (above !== undefined && this._top(b) <= above) continue;
      if (walker && this.interiors.isActive(b)) continue;   // its boxes did it
      pushed = this._pushOutOfPoly(pos, radius, b.o, b.i, true) || pushed;
    }
    // Water only exists at ground level — ON A BRIDGE the point stands x,z
    // inside the Labe polygon yet 0.85 m above it, and pushing it to the bank
    // was exactly the "cars jam on every bridge" bug. Deck height wins — and
    // so does ANY drivable surface: OSM leaves plenty of river crossings
    // untagged as bridges, and a car on tarmac is on tarmac whatever the
    // polygon under it says (the second, subtler "nemůžu přes most" bug).
    if (this.heightAt(pos.x, pos.z) < 0.3 && !this.surfaceY(pos.x, pos.z).road) {
      for (const w of cell.water) {
        // inside water (and not on an island hole) → push back to the bank
        pushed = this._pushOutOfPoly(pos, radius, w.o, w.i, false) || pushed;
      }
    }
    return pushed;
  }

  _pushOutOfPoly(pos, radius, outer, holes, solidInside) {
    // cheap reject: bbox grown by radius
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const [x, z] of outer) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    if (pos.x < minX - radius || pos.x > maxX + radius
      || pos.z < minZ - radius || pos.z > maxZ + radius) return false;

    const inside = pointInPolygon(pos.x, pos.z, outer)
      && !(holes ?? []).some(h => pointInPolygon(pos.x, pos.z, h));

    // nearest point on the outline (outer + holes both count as walls)
    let bestD = 1e9, bx = 0, bz = 0;
    const scan = (ring) => {
      for (let i = 0; i < ring.length; i++) {
        const [ax, az] = ring[i], [cx, cz] = ring[(i + 1) % ring.length];
        const d = distPointToSegment(pos.x, pos.z, ax, az, cx, cz, _closest);
        if (d < bestD) { bestD = d; bx = _closest.x; bz = _closest.z; }
      }
    };
    scan(outer);
    for (const h of holes ?? []) scan(h);

    if (inside) {
      // deep inside a wall (or in the river): eject to the outline + radius
      const d = Math.max(bestD, 1e-6);
      const nx = (pos.x - bx) / d, nz = (pos.z - bz) / d;
      pos.x = bx - nx * (radius + 0.02);
      pos.z = bz - nz * (radius + 0.02);
      return true;
    }
    // water only stops you once you're IN it — standing on the bank is fine
    if (!solidInside) return false;
    if (bestD < radius) {
      // grazing the wall from outside: slide out along the normal
      const d = Math.max(bestD, 1e-6);
      const nx = (pos.x - bx) / d, nz = (pos.z - bz) / d;
      pos.x = bx + nx * radius;
      pos.z = bz + nz * radius;
      return true;
    }
    return false;
  }

  // the building whose footprint contains (x,z) — action hints, minimap labels
  buildingAt(x, z) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return null;
    for (const b of cell.buildings)
      if (pointInPolygon(x, z, b.o) && !(b.i ?? []).some(h => pointInPolygon(x, z, h))) return b;
    return null;
  }

  // ---- v5: taking the city apart -----------------------------------------

  /**
   * The building a point in SPACE is inside — footprint AND height, which is
   * what a rocket needs (buildingAt would call a hit at 200 m altitude over a
   * bungalow). A building already made of boxes returns null: its own pieces
   * answer for it, so the rocket flies in through the hole it made last time.
   */
  buildingHitAt(x, y, z) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return null;
    for (const b of cell.buildings) {
      const lm = landmarkSolids(b);            // as in roofY: its own solids
      if (lm) {
        const g = this._base(b);
        for (const s of lm) if (y <= g + s.top && y >= g + s.bot && solidHas(s, x, z)) return b;
        continue;
      }
      if (y > this._top(b) || y < this._base(b) + (b.y ?? 0)) continue;
      if (this.interiors.hidden.has(b._id)) continue;
      if (pointInPolygon(x, z, b.o) && !(b.i ?? []).some(h => pointInPolygon(x, z, h))) return b;
    }
    return null;
  }

  // ---- the shared demolition record --------------------------------------
  // Destruction is the game, so in multiplayer it is state, not an effect. Three
  // things follow from that and all three live here:
  //   · every blast goes through ONE door (applyHit) whoever set it off,
  //   · a blast whose ground has not streamed in yet is KEPT, not dropped —
  //     TILE_REACH is 2.6 km and the world is 50 km wide, so "the peer bombed a
  //     village I have never loaded" is the normal case, not the corner one,
  //   · the whole history is kept in `hitLog` so a late joiner can be handed the
  //     wrecked city instead of an intact one.

  _initHits() {
    /** Array<{x,y,z,r,id}> — every blast this world has accepted, oldest first.
     *  Feed it straight to sendSnap; feed a peer's copy back through applyHits.
     *  The `id` is what makes that round trip idempotent. */
    this.hitLog = [];
    /** Prefix for locally minted hit ids. A random session token by default, so
     *  two clients never mint the same id; multiplayer may overwrite it with the
     *  player uid to make ids stable and readable. */
    this.hitOrigin = 'h' + Math.random().toString(36).slice(2, 8);
    this._hitSeq = 0;
    this._hitIds = new Set();
    this._pendingHits = [];
    this._tilesIn = new Set();          // 'tx,tz' of manifest tiles indexed NOW
    this._tileKeys = null;              // …of every tile the manifest lists
    const mt = this.city.manifestTiles;
    if (mt) { this._tileKeys = new Set(); for (const t of mt) this._tileKeys.add(t.tx + ',' + t.tz); }
  }

  _tileIn(t, on) {
    if (!t || t.tx === undefined) return;
    const key = t.tx + ',' + t.tz;
    if (on) this._tilesIn.add(key); else this._tilesIn.delete(key);
  }

  // Is there anything at (x,z) for a blast to bite into YET? Two answers, and
  // the cheap one is also the trustworthy one: a chunk cell that already holds
  // buildings proves the data is resident no matter what the tile ledger below
  // it believes (a tile that finished loading before this CityWorld existed
  // never told us). Only when the neighbourhood is empty do we ask whether the
  // tile that owns the spot is actually missing — a hit in a genuinely empty
  // field on a LOADED tile must be applied and forgotten, not queued forever.
  _hitReady(x, z) {
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const cell = this.city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
      if (cell && cell.buildings.length) return true;
    }
    const T = this.city.tile;
    if (!T || !this._tileKeys) return true;                  // legacy whole-city file
    const key = Math.floor(x / T) + ',' + Math.floor(z / T);
    if (!this._tileKeys.has(key)) return true;               // outside the region
    return this._tilesIn.has(key);
  }

  /**
   * applyHit({x, y, z, r, id}) → boolean — the one door every blast goes
   * through, local or relayed or replayed out of a snapshot. Applies the damage
   * NOW if the ground is loaded, otherwise queues it against onTileLoaded.
   * Returns true when the damage actually landed, false when it was queued or
   * refused.
   *
   * `id` is the identity of the BLAST, not of the packet, and it is what keeps
   * the mesh honest: a hit whose id has been seen is ignored, so replaying a
   * snapshot that already contains hits we took live is a no-op. A hit without
   * one has an id minted here AND STAMPED BACK onto the caller's object, so
   * whoever is about to put it on the wire can forward the same id to everyone
   * else. Forward it — without it a hit that reaches a player twice (once live,
   * once inside somebody's snapshot) detonates twice.
   */
  applyHit(hit) {
    if (!hit) return false;
    const x = +hit.x, y = +hit.y, z = +hit.z;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    // the wire is not a trusted source: a radius is a rocket's radius, not
    // whatever a hand-rolled client felt like sending
    const raw = +hit.r;
    const r = Number.isFinite(raw) && raw > 0 ? Math.min(raw, MISSILE.blast * 3) : MISSILE.blast;
    let id = typeof hit.id === 'string' && hit.id ? hit.id : null;
    if (!id) { id = this.hitOrigin + ':' + (++this._hitSeq); try { hit.id = id; } catch {} }
    if (this._hitIds.has(id)) return false;
    const rec = { x, y, z, r, id };
    this._rememberHit(rec);
    if (!this._hitReady(x, z)) {
      this._pendingHits.push(rec);
      if (this._pendingHits.length > PENDING_HITS_MAX) this._pendingHits.shift();
      return false;
    }
    this.damageBuilding(null, x, y, z, r);
    return true;
  }

  /** applyHits(list) — a whole snapshot at once. Returns how many landed. */
  applyHits(list) {
    if (!Array.isArray(list)) return 0;
    let n = 0;
    for (const h of list) if (this.applyHit(h)) n++;
    return n;
  }

  _rememberHit(rec) {
    this._hitIds.add(rec.id);
    this.hitLog.push(rec);
    if (this.hitLog.length > HIT_LOG_MAX) this.hitLog.shift();
    // The id set must outlive the log (a snapshot may still carry an id we
    // dropped), but it cannot grow without bound either — a peer spraying
    // events would otherwise be a slow leak. Past the ceiling, re-seed it from
    // the log: the worst that can happen is a very old hit being applied twice.
    if (this._hitIds.size > HIT_IDS_MAX) {
      this._hitIds = new Set();
      for (const h of this.hitLog) this._hitIds.add(h.id);
    }
  }

  // A tile arrived: anything that was waiting for ground under it lands now.
  _flushHits() {
    if (!this._pendingHits.length) return;
    const still = [];
    for (const h of this._pendingHits) {
      if (this._hitReady(h.x, h.z)) this.damageBuilding(null, h.x, h.y, h.z, h.r);
      else still.push(h);
    }
    this._pendingHits = still;
  }

  /**
   * damageBuilding(hit, x, y, z, r) — route a blast into every building the
   * sphere actually reaches, not only the one the nose touched. A rocket into
   * a party wall has to open BOTH flats, and one into the street has to chew
   * the shopfronts either side of it, which is why `hit` may be null — in fact
   * it is never read at all, the sphere finds its own targets.
   *
   * This is the RAW, local, unlogged path: the car that scrapes a corner
   * (vehicles.js) uses it because chipping plaster is not worth a packet.
   * Anything a second player should also see goes through applyHit().
   */
  damageBuilding(hit, x, y, z, r) {
    const seen = new Set();
    const targets = [];
    const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const cell = this.city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
      if (!cell) continue;
      for (const b of cell.buildings) {
        if (seen.has(b._id)) continue;
        seen.add(b._id);
        if ((b.y ?? 0) > 0.5 || !b.o || b.o.length < 3) continue;
        const g = this._base(b);
        if (y - r > g + b.h || y + r < g + (b.y ?? 0)) continue;  // over or under it
        let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
        for (const [px, pz] of b.o) {
          if (px < minX) minX = px; if (px > maxX) maxX = px;
          if (pz < minZ) minZ = pz; if (pz > maxZ) maxZ = pz;
        }
        const bd = Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
        if (bd <= r) targets.push([bd, b]);
      }
    }
    targets.sort((a, b) => a[0] - b[0]);
    let n = 0;
    for (const [, b] of targets) {
      if (n++ >= 4) break;                 // a blast that reaches five buildings
      this.interiors.damage(b, x, y, z, r); // is a blast in an alley — cap it
    }
  }

  /** Stop drawing one building in its chunk mesh (its boxes take over). */
  hideBuilding(f) { this._rebuildBuildings(f._home); }
  /** …and put it back, when a wreck is finally recycled far from the player. */
  unhideBuilding(f) { this._rebuildBuildings(f._home); }

  // Re-mesh ONE chunk's buildings in place. Everything else in the group —
  // ground, roads, lamps, trees — is untouched, which is what makes promoting
  // a building to boxes a sub-millisecond event instead of a chunk rebuild.
  _rebuildBuildings(key) {
    // a build of this very chunk may be in flight, and it may already have
    // read `hidden` (a worker was handed a copy of it at dispatch) — whatever
    // we patch below lives in the OLD group and dies at the swap. Mark the
    // flight stale so the finalize re-queues the chunk and the rebuild reads
    // the set as it is then; the patch still goes ahead so the interim frames
    // look right.
    const flying = this._inflight?.get(key);
    if (flying) flying.stale = true;
    const group = this.built.get(key);
    if (!group) return;
    const old = group.getObjectByName('buildings');
    if (old) {
      group.remove(old);
      shed(old);   // it is a Group: walls,
    }                                                 // door trim and signs
    const [cx, cz] = key.split(',').map(Number);
    const m = buildBuildingsMesh(this.city, cx, cz, this.mats);
    // the group is chunk-local now (meshes.js rebase), and this batch was built
    // in world coordinates like every other — shift it into the same frame or
    // the rebuilt buildings land a chunk-centre away from their street
    if (m) { rebase(m, ...chunkBase(cx, cz)); group.add(m); }
  }
}
