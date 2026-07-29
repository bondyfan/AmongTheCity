// ---- CityWorld: streams the city in around the player, answers collision ----
// The whole of Pardubice is ~3.5 MB of footprints and polylines; only the
// chunks near the camera exist as geometry. Each chunk cell becomes one
// THREE.Group built by meshes.js; a small per-frame budget keeps streaming
// hitch-free while driving. Collision reads the chunk index directly — the
// same polygons the meshes were extruded from, so what you see is what you
// hit.

import * as THREE from 'three';
import { CHUNK, VIEW_CHUNKS, CHUNKS_PER_FRAME, LAYER_Y, MISSILE } from './config.js';
import { chunkKey, pointInPolygon, distPointToSegment, bridgeDeckHeight } from './geo.js';
import { makeMaterials, buildChunkMeshes, buildBuildingsMesh, rebase, chunkBase } from './meshes.js';
import { Interiors } from './interiorsim.js';
import { Terrain } from './terrain.js';
import { stampFranchises } from './interiors.js';

const _closest = { x: 0, z: 0, t: 0 };
const _surf = { y: 0, road: false };   // surfaceY's reusable answer

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
    this.terrain.onTileLoaded(() => this._dropGuessedChunks());
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
    this.farChunks = 0;         // ground-only ring BEYOND viewChunks (flight)
    this._detail = new Map();   // key -> true when built at full detail
    this._hadTerrain = new Map(); // key -> was the ground known when it was built
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
    }
    const fx = Math.floor(focus.x / CHUNK), fz = Math.floor(focus.z / CHUNK);
    const outer = this.viewChunks + this.farChunks;
    // enqueue missing cells in view, nearest first. Cells inside viewChunks
    // want full detail; the ring beyond wants the cheap ground-only tier, and
    // a cell already built at the WRONG level is re-queued so flying low over
    // a distant suburb fills it in rather than leaving a flat photo.
    for (let r = 0; r <= outer; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const key = (fx + dx) + ',' + (fz + dz);
        const wantFull = r <= this.viewChunks;
        const have = this.built.has(key);
        const stale = have && wantFull && this._detail.get(key) === false;
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
      const full = ring <= this.viewChunks;
      const prev = this.built.get(key);         // upgrading a far tile in place
      if (prev) { this.scene.remove(prev); prev.traverse(o => o.geometry?.dispose?.()); }
      const hadTerrain = this.terrain.ready(cx * CHUNK + CHUNK / 2, cz * CHUNK + CHUNK / 2);
      const group = buildChunkMeshes(this.city, cx, cz, this.mats, !full);
      if (group) this.scene.add(group);
      this.built.set(key, group ?? null);
      this._detail.set(key, full);
      // The centre having ground is necessary but not sufficient: buildChunkMeshes
      // reports whether ANY vertex it placed was sampled against a height map
      // that had not arrived. Either way the chunk is a guess and must rebuild.
      this._hadTerrain.set(key, hadTerrain && !group?.userData.guessedGround);
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
        this._hadTerrain.delete(key);
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

  // Every built chunk inside one world tile, dropped so the streamer rebuilds
  // it — used when a height map lands after its ground was already meshed flat.
  _dropGuessedChunks() {
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
  surfaceY(x, z) {
    _surf.road = false;
    // THE GROUND FIRST. Every height below is a thickness of surfacing — 20 cm
    // of asphalt, 10 of paving, 5 of grass — measured from the ground, not from
    // the sea. Leaving it out parked every car in the world at y ≈ 0.2 while
    // Pardubice sits at 220 m and Prague at 190: the traffic was all there,
    // driving, two hundred metres underground.
    const ground = this.terrain.heightAt(x, z);
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) { _surf.y = ground; return _surf; }
    let best = -1;
    for (const r of cell.roads) {
      if (!r.d) continue;
      const half = r.w / 2 + 0.35;               // a wheel just off the kerb still rides the kerb
      let along = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < half) {
          const s = along + Math.hypot(_closest.x - ax, _closest.z - az);
          const y = r.br
            ? bridgeDeckHeight(r, s, this.terrain) + LAYER_Y.road
            : ground + LAYER_Y.road;
          if (y > best) best = y;
        }
        along += Math.hypot(bx - ax, bz - az);
      }
    }
    if (best >= 0) { _surf.y = best; _surf.road = true; return _surf; }
    // car parks and plazas are paved and flat — driveable, not offroad
    for (const p of cell.paved) {
      if (pointInPolygon(x, z, p.o) && !(p.i ?? []).some((h) => pointInPolygon(x, z, h))) {
        _surf.y = ground + LAYER_Y.paved; _surf.road = true; return _surf;
      }
    }
    _surf.y = ground + 0.05;                     // grass, dirt, everything else
    return _surf;
  }

  // Ground height plus bridge decks: standing on a bridge road means standing
  // on its level span, not on the river valley sampled underneath it. Nearest
  // drivable or walkable bridge way within half its width owns the point.
  heightAt(x, z) {
    const ground = this.terrain.heightAt(x, z);
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return ground;
    let y = ground;
    for (const r of cell.roads) {
      if (!r.br) continue;
      let dist = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < r.w / 2 + 1.5) {
          const along = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          y = Math.max(y, bridgeDeckHeight(r, along, this.terrain));
        }
        dist += Math.hypot(bx - ax, bz - az);
      }
    }
    return y;
  }

  // What is (x, z) standing on, at or below `maxY`? Terrain and bridge decks
  // as before, plus the floor slabs and stairs of any streamed-in interior —
  // which is the whole mechanism behind walking upstairs: nothing knows what a
  // staircase is, the walk controller merely keeps finding a surface 175 mm
  // higher than the last one.
  supportY(x, z, maxY) {
    let best = this.heightAt(x, z);
    const roof = this.roofY(x, z, maxY);
    if (roof > best) best = roof;
    const inside = this.interiors.supportY(x, z, maxY);
    return inside > best ? inside : best;
  }

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
      if (b.h <= best || b.h > fromY + 0.05) continue;
      if (this.interiors.hidden.has(b._id)) continue;
      if (pointInPolygon(x, z, b.o) && !(b.i ?? []).some((h) => pointInPolygon(x, z, h))) best = b.h;
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
      if (above !== undefined && b.h <= above) continue;
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
      if (y > b.h || y < (b.y ?? 0)) continue;
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
        if (y - r > b.h || y + r < (b.y ?? 0)) continue;      // over or under it
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
