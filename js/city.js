// ---- CityWorld: streams the city in around the player, answers collision ----
// The whole of Pardubice is ~3.5 MB of footprints and polylines; only the
// chunks near the camera exist as geometry. Each chunk cell becomes one
// THREE.Group built by meshes.js; a small per-frame budget keeps streaming
// hitch-free while driving. Collision reads the chunk index directly — the
// same polygons the meshes were extruded from, so what you see is what you
// hit.

import * as THREE from 'three';
import { CHUNK, VIEW_CHUNKS, CHUNKS_PER_FRAME, LAYER_Y } from './config.js';
import { chunkKey, pointInPolygon, distPointToSegment, bridgeElevation } from './geo.js';
import { makeMaterials, buildChunkMeshes, buildBuildingsMesh, rebase, chunkBase } from './meshes.js';
import { Interiors } from './interiorsim.js';
import { stampFranchises } from './interiors.js';

const _closest = { x: 0, z: 0, t: 0 };
const _surf = { y: 0, road: false };   // surfaceY's reusable answer

export class CityWorld {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.mats = makeMaterials();
    // v5: the inside of the city. The manager owns which buildings currently
    // have rooms, the debris pools, and the people in them; the chunk mesh
    // reads its `hidden` set so a building promoted to boxes stops being
    // drawn twice.
    this.interiors = new Interiors(scene, city, this);
    this.mats.hidden = this.interiors.hidden;
    this.built = new Map();     // key -> Group (or null for empty cells)
    this.queue = [];            // keys waiting to build, nearest first
    this._queued = new Set();
    this.viewChunks = VIEW_CHUNKS; // runtime-adjustable (settings: draw distance)
    this.chunksPerFrame = CHUNKS_PER_FRAME; // raised in flight — the edge must
                                            // stay ahead of a 60 m/s nose
    this.farChunks = 0;         // ground-only ring BEYOND viewChunks (flight)
    this._detail = new Map();   // key -> true when built at full detail
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
    city.onTileLoaded?.((t) => { this._dropCells(t.cells); this._stampFranchises(); });
    // The far side of streaming: a tile that fell 9 km behind gives its
    // buildings back (geo.js evictFar). Its cells are far out of view, but they
    // must still be dropped from `built` or coming back would find stale groups
    // with no data behind them. A building the player wrecked pins its whole
    // tile — the box model outlives the footprint it was built from.
    city.onTileUnloaded?.((t) => this._dropCells(t.cells));
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
    // build a few per frame
    for (let i = 0; i < this.chunksPerFrame && this.queue.length; i++) {
      const key = this.queue.shift();
      this._queued.delete(key);
      const [cx, cz] = key.split(',').map(Number);
      const ring = Math.max(Math.abs(cx - fx), Math.abs(cz - fz));
      if (ring > outer) continue;               // drifted out while queued
      const full = ring <= this.viewChunks;
      const prev = this.built.get(key);         // upgrading a far tile in place
      if (prev) { this.scene.remove(prev); prev.traverse(o => o.geometry?.dispose?.()); }
      const group = buildChunkMeshes(this.city, cx, cz, this.mats, !full);
      if (group) this.scene.add(group);
      this.built.set(key, group ?? null);
      this._detail.set(key, full);
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
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) { _surf.y = 0; return _surf; }
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
          const y = LAYER_Y.road + (r.br ? bridgeElevation(s, r._len) : 0);
          if (y > best) best = y;
        }
        along += Math.hypot(bx - ax, bz - az);
      }
    }
    if (best >= 0) { _surf.y = best; _surf.road = true; return _surf; }
    // car parks and plazas are paved and flat — driveable, not offroad
    for (const p of cell.paved) {
      if (pointInPolygon(x, z, p.o) && !(p.i ?? []).some((h) => pointInPolygon(x, z, h))) {
        _surf.y = LAYER_Y.paved; _surf.road = true; return _surf;
      }
    }
    _surf.y = 0.05;                              // grass, dirt, everything else
    return _surf;
  }

  // Ground height. Pardubice is flat (y=0) — the only relief is bridge decks:
  // standing on a bridge road means standing on its deck. Nearest drivable or
  // walkable bridge way within half its width owns the point.
  heightAt(x, z) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return 0;
    let y = 0;
    for (const r of cell.roads) {
      if (!r.br) continue;
      let dist = 0;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const d = distPointToSegment(x, z, ax, az, bx, bz, _closest);
        if (d < r.w / 2 + 1.5) {
          const along = dist + Math.hypot(_closest.x - ax, _closest.z - az);
          y = Math.max(y, bridgeElevation(along, r._len));
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

  /**
   * damageBuilding(hit, x, y, z, r) — route a blast into every building the
   * sphere actually reaches, not only the one the nose touched. A rocket into
   * a party wall has to open BOTH flats, and one into the street has to chew
   * the shopfronts either side of it, which is why `hit` may be null.
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
