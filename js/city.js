// ---- CityWorld: streams the city in around the player, answers collision ----
// The whole of Pardubice is ~3.5 MB of footprints and polylines; only the
// chunks near the camera exist as geometry. Each chunk cell becomes one
// THREE.Group built by meshes.js; a small per-frame budget keeps streaming
// hitch-free while driving. Collision reads the chunk index directly — the
// same polygons the meshes were extruded from, so what you see is what you
// hit.

import * as THREE from 'three';
import { CHUNK, VIEW_CHUNKS, CHUNKS_PER_FRAME } from './config.js';
import { chunkKey, pointInPolygon, distPointToSegment, bridgeElevation } from './geo.js';
import { makeMaterials, buildChunkMeshes } from './meshes.js';

const _closest = { x: 0, z: 0, t: 0 };

export class CityWorld {
  constructor(scene, city) {
    this.scene = scene;
    this.city = city;
    this.mats = makeMaterials();
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
    city.onTileLoaded?.((t) => this._dropCells(t.cells));
  }

  update(dt, focus) {
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

  // Push a {x,z} point out of building footprints and open water. Returns
  // true if it moved. radius = how fat the collider is (player 0.38, car
  // corners ~0.5). Buildings with a min-height (skyways) are passable.
  collide(pos, radius) {
    const cell = this.city.chunkIndex.get(chunkKey(pos.x, pos.z));
    if (!cell) return false;
    let pushed = false;
    for (const b of cell.buildings) {
      if (b.y > 0.5) continue; // skyway/arch — walk under it
      pushed = this._pushOutOfPoly(pos, radius, b.o, b.i, true) || pushed;
    }
    // Water only exists at ground level — ON A BRIDGE the point stands x,z
    // inside the Labe polygon yet 0.85 m above it, and pushing it to the bank
    // was exactly the "cars jam on every bridge" bug. Deck height wins.
    if (this.heightAt(pos.x, pos.z) < 0.3) {
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
}
