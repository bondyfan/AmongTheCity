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
  clustersIn, clusterHull, clusterDeckY } from './geo.js';
import { makeMaterials, buildChunkMeshes, buildBuildingsMesh, rebase, chunkBase } from './meshes.js';
import { Interiors } from './interiorsim.js';
import { Terrain, groundFor } from './terrain.js';
import { Canopy } from './canopy.js';
import { GroundClass } from './groundclass.js';

// how much of a chunk each tier builds, poorest first — the streamer compares
// these to decide whether a cell it already has is good enough
const LOD_RANK = { ground: 0, shell: 1, full: 2 };
import { stampFranchises } from './interiors.js';

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

export function conformTerrainTile(terrain, city, tx, tz) {
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

  // every road touching the tile, via the chunk index (which is cross-tile)
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
  if (!roads.size) { terrain._conformed.add(key); return false; }

  // Profiles FIRST, against the pristine survey — they are cached on the way,
  // so every later consumer (ribbons, cars, this bake) reads the same line.
  // If ANY profile is provisional (a far end over a tile still loading), the
  // bake still runs — a shaped guess beats a cliff — but the tile is NOT
  // marked conformed, so the pass returns and re-bakes from the pristine
  // survey once the neighbour lands. It used to mark itself done forever.
  let profReady = true;
  for (const r of roads.values()) {
    const pr = roadProfile(r, terrain);
    if (pr && !pr.ready) profReady = false;
  }

  // Road-major stamping: per segment, visit only the grid samples its
  // corridor + shoulder can reach, and keep the strongest claim per sample.
  const tBest = new Float32Array(n * n);
  const hBest = new Float32Array(n * n);
  for (const r of roads.values()) {
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
  let moved = 0;
  for (let o = 0; o < n * n; o++) {
    if (!tBest[o] || raw[o] === -32768) continue;
    const h0 = raw[o] / 10;
    const h1 = h0 + (hBest[o] - h0) * tBest[o];
    const v = Math.round(h1 * 10);
    if (v !== g[o]) { g[o] = v; moved++; }
  }
  // Ground memos measured against the survey are stale now.
  for (let cx = Math.floor(x0 / CHUNK); cx < Math.floor((x0 + T) / CHUNK); cx++) {
    for (let cz = Math.floor(z0 / CHUNK); cz < Math.floor((z0 + T) / CHUNK); cz++) {
      const cell = city.chunkIndex.get(cx + ',' + cz);
      if (!cell) continue;
      for (const b of cell.buildings) { delete b._gy; delete b._gfall; }
    }
  }
  if (profReady) terrain._conformed.add(key);
  // an unready tile must NOT be retried every frame — a road running off the
  // loaded world keeps its profile unready forever, and re-baking a 4800 m
  // tile per frame is a hang. Stamp the attempt; retry only after new ground.
  else (terrain._conformTried ??= new Map()).set(key, terrain._loads ?? 0);
  return moved > 0;
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
    this.built = new Map();     // key -> Group (or null for empty cells)
    this.queue = [];            // keys waiting to build, nearest first
    this._queued = new Set();
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
    // Fast food is not in the data (OSM keeps it as amenity nodes, which the
    // pipeline drops), so it is stamped onto suitable host buildings as they
    // stream in — deterministically, from the building's own id, so the same
    // shed is the same restaurant every session.
    this._stamped = 0;
    this._stampFranchises();
    this._initHits();
    city.onTileLoaded?.((t) => {
      this._dropCells(t.cells); this._stampFranchises();
      this._tileIn(t, true); this._flushHits();
      // the waterway buckets were built from whatever tiles existed at the
      // FIRST chunk build — a brook indexed later never got its trench
      delete this.city._wwChunks;
      // new roads may have landed over ground already shaped — bake again,
      // from the survey, next update. ONLY the arriving tile and its four
      // neighbours (a border road reaches into them): clearing the whole set
      // re-baked every loaded tile after every data tile, ~0.9 s of main
      // thread each, which was most of the after-boot stutter.
      if (this.terrain._conformed && t.tx !== undefined) {
        for (const [ox, oz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
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
    if ('keepAlive' in city)
      city.keepAlive = (f) => this.interiors.models.get(f._id)?.damaged === true;
  }

  update(dt, focus, opts) {
    this._flushGuessedDrops();
    // interiors stream on their own schedule (they only matter on foot, and
    // they must keep running even while the chunk streamer has nothing to do)
    this.interiors.update(dt, focus, opts?.onFoot ?? false);
    // grow the world as we drive: ask geo (at most once per second) to start
    // fetching any manifest tile now in reach — fire-and-forget, a failure
    // just logs and geo retries that tile on a later call
    this._tileT -= dt;
    if (this._tileT <= 0) {
      this._tileT = 1;
      this.city.ensureTiles(focus.x, focus.z).catch(console.error);
      // …and the ground under them. Reach is generous because a height map is
      // 116 KB against a feature tile's several megabytes, and terrain that
      // arrives late means a chunk gets built flat and then rebuilt.
      this.terrain.ensure(focus.x, focus.z, 6000);
      // Earthworks: one tile per pass, so a bake never stalls a frame. A tile
      // that gains roads later (its data tile arriving after its height map)
      // is re-marked below and re-baked from the pristine survey.
      for (const tk of this.terrain.grids.keys()) {
        if (this.terrain._conformed?.has(tk)) continue;
        // tried while some profile was provisional, and nothing new has
        // landed since — trying again would compute the same guess
        if (this.terrain._conformTried?.get(tk) === (this.terrain._loads ?? 0)) continue;
        const [ttx, ttz] = tk.split(',').map(Number);
        if (conformTerrainTile(this.terrain, this.city, ttx, ttz)) {
          this._dropTileChunks(ttx, ttz);
        }
        break;
      }
      // Trees are only scattered inside the built radius, so the canopy needs
      // far less reach than the ground — and it is four times the samples.
      this.canopy.ensure(focus.x, focus.z, 2000);
      this.ground.ensure(focus.x, focus.z, 2000);
    }
    const fx = Math.floor(focus.x / CHUNK), fz = Math.floor(focus.z / CHUNK);
    const outer = this.viewChunks + this.shellChunks + this.farChunks;
    // enqueue missing cells in view, nearest first. Cells inside viewChunks
    // want full detail; the ring beyond wants the cheap ground-only tier, and
    // a cell already built at the WRONG level is re-queued so flying low over
    // a distant suburb fills it in rather than leaving a flat photo.
    for (let r = 0; r <= outer; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const key = (fx + dx) + ',' + (fz + dz);
        const have = this.built.has(key);
        // A cell already built at a LOWER tier than it now deserves is
        // re-queued, so flying down toward a distant suburb fills it in rather
        // than leaving a photograph.
        // Stale for either reason: it deserves more GEOMETRY than it has, or a
        // sharper PHOTOGRAPH than it has. The second one is what stops a chunk
        // keeping the coarse aerial tile it happened to be built with.
        const px = this.mats.ortho?.tierOf?.(fx + dx, fz + dz);
        const stale = have && (LOD_RANK[this._lodAt(r)] > LOD_RANK[this._detail.get(key)]
          || (px !== undefined && this._px.get(key) !== undefined && px > this._px.get(key)));
        if ((!have || stale) && !this._queued.has(key)) {
          this.queue.push(key);
          this._queued.add(key);
        }
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
    const budget = performance.now() + this.buildBudgetMs;
    for (let i = 0; i < this.chunksPerFrame && this.queue.length; i++) {
      // always build at least one — otherwise a frame that arrived late never
      // makes progress and the world stops streaming altogether
      if (i > 0 && performance.now() > budget) break;
      const key = this.queue.shift();
      this._queued.delete(key);
      const [cx, cz] = key.split(',').map(Number);
      const ring = Math.max(Math.abs(cx - fx), Math.abs(cz - fz));
      if (ring > outer) continue;               // drifted out while queued
      const lod = this._lodAt(ring);
      const prev = this.built.get(key);         // upgrading a far tile in place
      if (prev) { this.scene.remove(prev); prev.traverse(o => o.geometry?.dispose?.()); }
      const hadTerrain = this.terrain.ready(cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2);
      const group = buildChunkMeshes(this.city, cx, cz, this.mats, lod);
      if (group) this.scene.add(group);
      this.built.set(key, group ?? null);
      this._detail.set(key, lod);
      this._px.set(key, this.mats.ortho?.tierOf?.(cx, cz));
      // The centre having ground is necessary but not sufficient: buildChunkMeshes
      // reports whether ANY vertex it placed was sampled against a height map
      // that had not arrived. Either way the chunk is a guess and must rebuild.
      this._hadTerrain.set(key, hadTerrain && !group?.userData.guessedGround);
      this._missBy.set(key, group?.userData.missTiles ?? null);
    }
    // drop cells far behind us (hysteresis +2 so the edge doesn't flicker)
    for (const [key, group] of this.built) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - fx), Math.abs(cz - fz)) > outer + 2) {
        if (group) {
          this.scene.remove(group);
          group.traverse(o => { o.geometry?.dispose?.(); });
        }
        this.built.delete(key);
        this._detail.delete(key);
        this._px.delete(key);
        this._hadTerrain.delete(key);
        this._missBy.delete(key);
      }
    }
  }

  // A running index is all the bookkeeping the franchise pass needs — until
  // eviction shortens city.buildings under it, at which point the cursor points
  // past the end and every future tile would go unstamped. Stamping is
  // deterministic (hashed from the building's own id), so starting over is free
  // and idempotent.
  _stampFranchises() {
    const all = this.city.buildings;
    if (this._stamped > all.length) this._stamped = 0;
    if (this._stamped >= all.length) return;
    stampFranchises(all.slice(this._stamped));
    this._stamped = all.length;
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
    if (this.queue.length) return false;
    if (this._guessDropWanted) return false;     // guessed chunks awaiting redo
    return this.ready(pos);
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
    if (keys.length) this._dropCells(keys);
  }

  // Drop the built groups of specific cells (a freshly indexed tile put new
  // features in them) — the ring scan in update() re-enqueues any that are
  // still in view, and out-of-view ones simply rebuild when approached.
  _dropCells(cells) {
    if (!cells) return;
    for (const key of cells) {
      if (!this.built.has(key)) continue; // never built — nothing stale to shed
      const group = this.built.get(key);
      if (group) {
        this.scene.remove(group);
        group.traverse(o => { o.geometry?.dispose?.(); });
      }
      this.built.delete(key);
    }
  }

  /** Drop the built chunks of ONE terrain tile — its ground just moved. */
  _dropTileChunks(tx, tz) {
    const T = this.terrain.tile;
    const c0x = Math.floor((tx * T) / CHUNK), c1x = Math.floor(((tx + 1) * T) / CHUNK);
    const c0z = Math.floor((tz * T) / CHUNK), c1z = Math.floor(((tz + 1) * T) / CHUNK);
    for (const [key, group] of [...this.built]) {
      const [cx, cz] = key.split(',').map(Number);
      if (cx < c0x || cx >= c1x || cz < c0z || cz >= c1z) continue;
      if (group) {
        this.scene.remove(group);
        group.traverse((o) => { o.geometry?.dispose?.(); });
      }
      this.built.delete(key);
    }
  }

  // Drop every built chunk so the next update() rebuilds it — used when a
  // setting flips the chunk RECIPE itself (ortofoto ground, facades, trees).
  rebuildAll() {
    for (const [key, group] of this.built) {
      if (group) {
        this.scene.remove(group);
        group.traverse(o => { o.geometry?.dispose?.(); });
      }
    }
    this.built.clear();
    this.queue.length = 0;
    this._queued.clear();
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
        if (js) for (const j of js) {
          if (j._cluster || j._ring) continue;   // cluster answers / no pad drawn
          const r = j.padR ?? 6;
          if ((x - j.x) ** 2 + (z - j.z) ** 2 > r * r) continue;
          const ring = junctionHull(j);
          if (!ring || !pointInPolygon(x, z, ring)) continue;
          levels.add(junctionDeckY(j, x, z, this.terrain) + LAYER_Y.road + 0.012);
        }
        const cls = clustersIn(key2);
        if (cls) for (const cl of cls) {
          const r = cl.padR;
          if ((x - cl.x) ** 2 + (z - cl.z) ** 2 > r * r) continue;
          const ring = clusterHull(cl);
          if (!ring || !pointInPolygon(x, z, ring)) continue;
          levels.add(clusterDeckY(cl, x, z, this.terrain) + LAYER_Y.road + 0.012);
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
      const bb = lineBB(r);
      if (x < bb[0] - half || x > bb[2] + half || z < bb[1] - half || z > bb[3] + half) continue;
      let along = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < half) {
          const s = along + Math.hypot(_closest.x - ax, _closest.z - az);
          // The HIGHER of the ground and the graded profile — the same max()
          // meshes.js laid the ribbon at, so the wheels are on the surface that
          // was drawn and not on either of the two things it was made from.
          const gy = r.br ? bridgeDeckHeight(r, s, this.terrain)
            : (roadGradeY(r, s, this.terrain) ?? ground);
          levels.add(gy + LAYER_Y.road);
        }
        along += Math.hypot(bx - ax, bz - az);
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
    levels.reset(near).add(ground);
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
        if (d < 2.6) {
          const along = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          if (r.br) levels.add(bridgeDeckHeight(r, along, this.terrain));
          else {
            const gy = roadGradeY(r, along, this.terrain);
            if (gy !== null && gy !== undefined) levels.add(gy + LAYER_Y.rail);
          }
        }
        dist += Math.hypot(bx - ax, bz - az);
      }
    }
    for (const r of cell.roads) {
      // Bridges, yes — but ALSO embanked ordinary roads: a levelled deck may
      // ride up to GRADE_FILL above the terrain, and feet that only knew the
      // terrain sank into it to the knees on a fill and to the neck on a big
      // one. Any graded deck IS the ground where it runs.
      const br = !!r.br;
      const reach = r.w / 2 + (br ? 1.5 : 5);   // 5 m: the embankment bank
      const bb = lineBB(r);
      if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
      let dist = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        const half = r.w / 2;
        if (d < half + (br ? 1.5 : 5)) {
          const along = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          if (br) { if (d < half + 1.5) levels.add(bridgeDeckHeight(r, along, this.terrain)); }
          else {
            const gy = roadGradeY(r, along, this.terrain);
            if (gy !== null && gy !== undefined) {
              if (d < half + 0.35) levels.add(gy + LAYER_Y.road);
              // the embankment bank the mesh draws beside the deck is
              // standable — snug under the edge, falling at 55 %
              const bank = gy + LAYER_Y.road - 0.45
                - (d > half ? (d - half) * 0.55 : 0);
              if (bank > ground) levels.add(bank);
            }
          }
        }
        dist += Math.hypot(bx - ax, bz - az);
      }
    }
    this._padLevels(x, z);
    return levels.value(ground);
  }

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
      const top = this._top(b);
      if (top <= best || top > fromY + 0.05) continue;
      if (this.interiors.hidden.has(b._id)) continue;
      if (pointInPolygon(x, z, b.o) && !(b.i ?? []).some((h) => pointInPolygon(x, z, h))) best = top;
    }
    return best;
  }

  /** A handful of body-colour chunks off a crashing car — the debris pool is
   *  the interiors', so wrecks and crashes share one budget and one mesh. */
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
    const cell = this.city.chunkIndex.get(chunkKey(pos.x, pos.z));
    if (!cell) return false;
    let pushed = false;
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
      if (b.y > 0.5) continue; // skyway/arch — walk under it
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
    const group = this.built.get(key);
    if (!group) return;
    const old = group.getObjectByName('buildings');
    if (old) {
      group.remove(old);
      old.traverse((o) => o.geometry?.dispose?.());   // it is a Group: walls,
    }                                                 // door trim and signs
    const [cx, cz] = key.split(',').map(Number);
    const m = buildBuildingsMesh(this.city, cx, cz, this.mats);
    // the group is chunk-local now (meshes.js rebase), and this batch was built
    // in world coordinates like every other — shift it into the same frame or
    // the rebuilt buildings land a chunk-centre away from their street
    if (m) { rebase(m, ...chunkBase(cx, cz)); group.add(m); }
  }
}
