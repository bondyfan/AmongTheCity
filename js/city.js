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
  }

  update(dt, focus) {
    const fx = Math.floor(focus.x / CHUNK), fz = Math.floor(focus.z / CHUNK);
    // enqueue missing cells in view, nearest first
    for (let r = 0; r <= this.viewChunks; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring only
        const key = (fx + dx) + ',' + (fz + dz);
        if (!this.built.has(key) && !this._queued.has(key)) {
          this.queue.push(key);
          this._queued.add(key);
        }
      }
    }
    // build a few per frame
    for (let i = 0; i < CHUNKS_PER_FRAME && this.queue.length; i++) {
      const key = this.queue.shift();
      this._queued.delete(key);
      const [cx, cz] = key.split(',').map(Number);
      // may have drifted out of view while queued
      if (Math.max(Math.abs(cx - fx), Math.abs(cz - fz)) > this.viewChunks) continue;
      const group = buildChunkMeshes(this.city, cx, cz, this.mats);
      if (group) this.scene.add(group);
      this.built.set(key, group ?? null);
    }
    // drop cells far behind us (hysteresis +2 so the edge doesn't flicker)
    for (const [key, group] of this.built) {
      const [cx, cz] = key.split(',').map(Number);
      if (Math.max(Math.abs(cx - fx), Math.abs(cz - fz)) > this.viewChunks + 2) {
        if (group) {
          this.scene.remove(group);
          group.traverse(o => { o.geometry?.dispose?.(); });
        }
        this.built.delete(key);
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
    for (const w of cell.water) {
      // inside water (and not on an island hole) → push back to the bank
      pushed = this._pushOutOfPoly(pos, radius, w.o, w.i, false) || pushed;
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
