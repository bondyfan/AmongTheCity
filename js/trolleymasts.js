// ---- trolleymasts.js: the masts that hold the trolley wire, as things ------------
// Phase one planted the masts behind the kerb (js/meshes.js trolleyMasts) and
// drew them into the chunk with everything else. A mast is a steel column at
// the kerb, though, and a lamp column at the same kerb already stops a car or
// goes over when it is hit hard (js/poles.js). So the masts left the chunk:
// this module plants them for the BUILT cells round the player, from the same
// plan the chunk used (meshes.trolleyPlan, so they stand exactly where they
// stood), one merged mesh per cell, and registers each with js/poles.js as a
// free-standing pole of its own shape.
//
// A felled mast is taken out of its cell's mesh by collapsing its own vertex
// range (one attribute upload), and stays out: poles.js remembers it by
// position, and a cell planted again skips it.
//
// THE WIRE WHEN A MAST GOES DOWN. The wire itself is chunk geometry and stays
// where it is drawn: the masts either side still carry it (a span of 64 m in
// place of 32, as it already spans every big junction). What changes is what
// it is FOR: the bracket that went over took the droppers with it, so the
// stretch it held is dead. deadAt() says so, and a trolleybus whose shoes
// come to it drops its poles and rolls through on its traction battery
// (js/trolleypoles.js), raising them again beyond.
//
// Nothing here is shared co-op state: the masts are a pure function of the
// map, and a felling is as local as a felled lamp.

import * as THREE from 'three';
import { trolleyPlan, trolleyMastInto } from './meshes.js';
import { CHUNK, LAYER_Y } from './config.js';
import { bridgeDeckHeight } from './geo.js';

const REACH = 480;            // m: cells this near the player have their masts
const DROP = REACH + 160;     // …and keep them until this far (no churn at the edge)
const SCAN_DT = 0.5;
const PLANT_PER_SCAN = 3;     // cells planted per scan: about 0.3 ms each
export const DEAD_SPAN = 34;  // m of wire either side of a felled mast's station that is dead

// The little triangle sink trolleyMastInto writes into (js/propkit.js drum and
// bar call quad, tri and triFacing), flat normals, a colour per vertex.
class MastSink {
  constructor() { this.pos = []; this.nrm = []; this.col = []; }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b) {
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
    this.col.push(r, g, b, r, g, b, r, g, b);
  }
  quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, r, g, b) {
    this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
    this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz, r, g, b);
  }
  triFacing(ax, ay, az, bx, by, bz, cx, cy, cz, gx, gy, gz, r, g, b) {
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (nx * gx + ny * gy + nz * gz < 0) this.tri(ax, ay, az, cx, cy, cz, bx, by, bz, r, g, b);
    else this.tri(ax, ay, az, bx, by, bz, cx, cy, cz, r, g, b);
  }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.computeBoundingSphere();
    return g;
  }
}

/** Is way arc `D` within DEAD_SPAN of a felled mast's station? `list` is that way's stations. */
export function deadOn(list, D) {
  if (!list) return false;
  for (let i = 0; i < list.length; i++) if (Math.abs(list[i] - D) < DEAD_SPAN) return true;
  return false;
}

export class TrolleyMasts {
  /**
   * scene   where the masts go
   * city    the streamed map (chunkIndex, for the plan)
   * world   js/city.js CityWorld: `built` (which cells have their chunk),
   *         `terrain` (what the wire hangs over), `walkY` (what a mast stands
   *         on) and `poles` (js/poles.js, where a mast becomes a thing)
   */
  constructor({ scene, city, world }) {
    this.scene = scene; this.city = city; this.world = world;
    this.poles = world?.poles ?? null;
    this.cells = new Map();       // chunk key -> { group, mesh, masts }
    this.dead = new Map();        // trolley way -> [way arc of each felled mast's station]
    this._t = 0;
    this._mat = null;
    this.deadAt = (road, D) => deadOn(this.dead.get(road), D);
  }

  material() {
    // galvanised steel, the colour the chunk drew them in; Lambert like the
    // felled lamps (js/poles.js), so a fallen mast is the same grey it stood in
    return (this._mat ??= new THREE.MeshLambertMaterial({ vertexColors: true }));
  }

  _kill(f, s) {
    let l = this.dead.get(f);
    if (!l) this.dead.set(f, l = []);
    if (!l.some((v) => Math.abs(v - s) < 0.5)) l.push(s);
  }

  _plant(key, group) {
    const owners = [], plan = trolleyPlan(this.city, key, owners);
    const rec = { group, mesh: null, masts: [] };
    this.cells.set(key, rec);
    if (!plan.length) return;
    const terrain = this.world.terrain, poles = this.poles;
    const c = key.indexOf(','), ox = +key.slice(0, c) * CHUNK, oz = +key.slice(c + 1) * CHUNK;
    const sink = new MastSink();
    for (let k = 0; k < plan.length; k++) {
      const m = plan[k], f = owners[k], x = m[0], z = m[1];
      // knocked down earlier this session: it stays down, and so does its wire
      if (poles?.isFelled(x, z)) { this._kill(f, m[7]); continue; }
      // (a mast on a bridge stands on the edge of the deck, as the chunk stood it)
      const g = f.br ? bridgeDeckHeight(f, m[7], terrain) + LAYER_Y.road
        : this.world.walkY?.(x, z) ?? terrain.heightAt(x, z);
      const v0 = sink.pos.length / 3;
      trolleyMastInto(sink, f, m, terrain, g, ox, 0, oz);
      rec.masts.push({ x, z, y: g, f, m, v0, v1: sink.pos.length / 3 });
    }
    if (!rec.masts.length) return;
    const mesh = new THREE.Mesh(sink.geo(), this.material());
    mesh.position.set(ox, 0, oz);
    mesh.updateMatrix();
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = 'trolleymasts';
    this.scene.add(mesh);
    rec.mesh = mesh;
    if (!poles) return;
    for (const ms of rec.masts) {
      const self = this;
      poles.registerOne('tw:' + key, ms.x, ms.y, ms.z, () => this._felled(rec, ms), 'trolley', 0, {
        mat: this.material(),
        // built only if it is ever hit: the mast and its bracket about its foot
        get geo() { const s = new MastSink(); trolleyMastInto(s, ms.f, ms.m, self.world.terrain, ms.y, ms.x, ms.y, ms.z); return s.geo(); },
      });
    }
  }

  // poles.js took this mast down: out of the cell's mesh, and its wire is dead
  _felled(rec, ms) {
    this._kill(ms.f, ms.m[7]);
    const mesh = rec.mesh;
    if (!mesh) return;
    const pos = mesh.geometry.attributes.position, a = pos.array;
    const x = a[ms.v0 * 3], y = a[ms.v0 * 3 + 1], z = a[ms.v0 * 3 + 2];
    for (let v = ms.v0; v < ms.v1; v++) { a[v * 3] = x; a[v * 3 + 1] = y; a[v * 3 + 2] = z; }
    pos.needsUpdate = true;
  }

  _drop(key) {
    const rec = this.cells.get(key);
    if (!rec) return;
    this.cells.delete(key);
    this.poles?.unregister('tw:' + key);
    if (rec.mesh) { this.scene.remove(rec.mesh); rec.mesh.geometry.dispose(); }
  }

  update(dt, pos) {
    this._t -= dt;
    if (this._t > 0 || !pos || !this.world?.built || !this.world.terrain) return;
    this._t = SCAN_DT;
    const built = this.world.built;
    // gone out of reach, or rebuilt (the ground under it may have been levelled since)
    for (const [key, rec] of this.cells) {
      const c = key.indexOf(','), cx = (+key.slice(0, c) + 0.5) * CHUNK, cz = (+key.slice(c + 1) + 0.5) * CHUNK;
      if (Math.hypot(cx - pos.x, cz - pos.z) > DROP || !built.has(key) || built.get(key) !== rec.group) this._drop(key);
    }
    // the nearest cells first, a few a scan
    const ci = Math.floor(pos.x / CHUNK), cj = Math.floor(pos.z / CHUNK), R = Math.ceil(REACH / CHUNK);
    let budget = PLANT_PER_SCAN;
    for (let ring = 0; ring <= R && budget > 0; ring++) {
      for (let i = ci - ring; i <= ci + ring && budget > 0; i++) {
        for (let j = cj - ring; j <= cj + ring && budget > 0; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== ring) continue;
          const key = i + ',' + j;
          if (this.cells.has(key) || !built.has(key)) continue;
          if (Math.hypot((i + 0.5) * CHUNK - pos.x, (j + 0.5) * CHUNK - pos.z) > REACH) continue;
          if (!this.city.chunkIndex?.get(key)?.roads?.some((r) => r.tw)) { this.cells.set(key, { group: built.get(key), mesh: null, masts: [] }); continue; }
          this._plant(key, built.get(key));
          budget--;
        }
      }
    }
  }

  /** Everything, for a world reset (the felled set lives in poles.js). */
  clear() {
    for (const key of [...this.cells.keys()]) this._drop(key);
    this.dead.clear();
  }
}
