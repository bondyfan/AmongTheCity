// ---- farlights.js: the town's lights, past where its lamps are drawn ----
// From a helicopter at night the lit streets stopped a few hundred metres out
// and the rest of the city was a dark plain, for two reasons. The lamp glows
// (lightpools.js) fade out 430 m from the camera, and at 300 m up nothing in
// front of you is that near. And lamps are instances of the full-detail
// chunks: beyond that ring the streamer builds the 'shell' tier (ground and
// plain buildings) and then the 'ground' tier (the aerial photograph alone),
// with no masts and no windows, so nothing to shine.
//
// A lamp a kilometre away is a point of light and nothing else, and where it
// stands is already known: the mesher plans a cell's lamps from its roads
// (meshes.js lampSpots: the surveyed ones, one column every 34 metres along
// the wider carriageways, lanterns along the pedestrian streets), and the
// roads of every indexed cell are in memory whatever tier the cell was built
// at. So each built cell is asked for that SAME plan (meshes.lampPlan) and
// gets one small glow per lamp. It used to walk the centrelines itself, a
// copy of the rule with none of its guards, so the columns the mesher had
// dropped (in a carriageway, on a crossing, in a house or a bus lay-by) still
// shone from the air, and the surveyed lamps and every lantern did not.
// A cell below full detail has no lit windows either, so it also gets a warm
// point or two on the walls of its houses.
//
// The points only exist BEYOND the reach of the real glows: the shader fades
// them in over the same stretch the glows fade out, so a street is a chain of
// lamps under you and a chain of points to the horizon, with no seam.
//
// One InstancedMesh for all of it, drawn with the lamp glows' own shader, so
// the points keep a two-pixel floor, thin with the haze and come up through
// dusk with the lamps. Nothing runs per frame except a signature check twice
// a second; a cell's points are worked out once and kept until the cell
// changes tier or leaves the world. On the ground at night the haze has
// swallowed everything past 300 m, and all of this costs one hidden draw.
// The plan is a tenth of a millisecond a cell where the walk was a fortieth,
// and the first dusk asks for two thousand cells at once: they are worked out
// PLAN_MS a frame, nearest first, so no frame pays for the town.

import * as THREE from 'three';
import { lampPlan } from './meshes.js';
import { MAST_OUT, MAST_Y } from './streetlamps.js';
import { mastTint } from './mastlamps.js';
import { landmarkOf } from './landmarks.js';

const CHUNK = 120;                // m: the streaming cell (config.js CHUNK)
const MAX = 30000;                // instances: nearest cells first when a city has more
const REACH = 3000;               // m: cells further than this are not asked
const HEAD_Y = 7.4;               // m above the ground: a lamp head
const PARK_Y = 3.9, PARK_K = 0.6; // a park lantern: lower, and a smaller light
const PLAN_MS = 1.5;              // ms of lamp planning a frame, at most
const RANGE = 3600;               // m: the glow shader's fade-out distance
const SODIUM = [1.0, 0.56, 0.21], LED = [1.0, 0.80, 0.56];   // as lightpools.js
const DISTRICT = 260, LED_SHARE = 0.34;
// window points: warm, a few television blues
const WARM = [1.0, 0.74, 0.42], COOL = [0.62, 0.74, 1.0];

function hash2(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class FarLights {
  /** `glowMat` is lightpools.js's glow material: cloned, so the far field has
   *  its own range and size and shares the program. `near` is where the real
   *  glows give out, in metres. */
  constructor(scene, glowMat, near) {
    this.mat = glowMat.clone();
    delete this.mat.defines.STREET_LENS;
    this.mat.uniforms.uRange.value = RANGE;
    this.mat.uniforms.uSize.value = 0.55;
    this.mat.uniforms.uNear.value = near;
    const g = new THREE.PlaneGeometry(2, 2);
    this.mesh = new THREE.InstancedMesh(g, this.mat, MAX);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.mesh.count = 0;
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = -791;          // with the lamp glows, before glass and smoke
    this.mesh.onBeforeRender = (renderer) => {
      this.mat.uniforms.uDirect.value = renderer.getRenderTarget() === null ? 1 : 0;
    };
    scene.add(this.mesh);
    // every instance is a translation: the identity is written once and only
    // the three position elements ever change
    const im = this.mesh.instanceMatrix.array;
    for (let i = 0; i < MAX; i++) { im[i * 16] = im[i * 16 + 5] = im[i * 16 + 10] = im[i * 16 + 15] = 1; }
    this.cells = new Map();                // key -> { tier, pts: x, y, z, r, g, b ... }
    this._order = [];
    this._t = 0; this._sig = NaN;
    this._more = false;                    // cells still waiting for their plan
  }

  /** Once a frame from LightPools.update. `on` is the lamps' own dusk curve. */
  update(dt, camera, world, on, level, px) {
    if (on <= 0.002 || !world?.built || !world._detail || !world.city?.chunkIndex) {
      this.mesh.visible = false;
      return;
    }
    const u = this.mat.uniforms;
    u.uOn.value = on; u.uLevel.value = level; u.uPx.value = px;
    this._t -= dt;
    if (this._more) this._rebuild(world, this._fx, this._fz);
    else if (this._t <= 0) {
      this._t = 0.5;
      // which cells are standing in for a town right now?
      // has the set of cells, or the tier of any of them, changed? (or have we
      // moved a cell, which changes who is nearest)
      const fx = Math.floor(camera.position.x / CHUNK), fz = Math.floor(camera.position.z / CHUNK);
      let sig = Math.imul(fx, 73856093) ^ Math.imul(fz, 19349663), n = 0;
      for (const [key, tier] of world._detail) {
        if (!world.built.get(key)) continue;
        n++; sig = (sig + Math.imul(hashKey(key), tier === 'full' ? 3 : tier === 'shell' ? 5 : 7)) | 0;
      }
      sig = Math.imul(sig, 31) + n;
      if (sig !== this._sig) { this._sig = sig; this._rebuild(world, fx, fz); }
    }
    this.mesh.visible = this.mesh.count > 0;
  }

  _rebuild(world, fx, fz) {
    const live = this.cells, order = this._order, reach = Math.ceil(REACH / CHUNK);
    const todo = this._todo ??= [];
    order.length = 0; todo.length = 0;
    this._fx = fx; this._fz = fz;
    for (const key of live.keys()) if (!world.built.get(key)) live.delete(key);
    for (const [key, tier] of world._detail) {
      if (!world.built.get(key)) continue;
      const c = key.indexOf(','), dx = +key.slice(0, c) - fx, dz = +key.slice(c + 1) - fz;
      const d2 = dx * dx + dz * dz;
      // a cell under the camera is all real lamps: its points would never show
      if (d2 > reach * reach) continue;
      let e = live.get(key);
      // (a cell that changed tier keeps its old points until its turn comes)
      if (!e) live.set(key, e = { key, tier: '', want: tier, d2, pts: EMPTY });
      e.d2 = d2; e.want = tier;
      if (e.tier !== tier) todo.push(e);
      if (e.pts.length) order.push(e);
    }
    // the plans that are owed, nearest first, for PLAN_MS of this frame
    this._more = false;
    if (todo.length) {
      todo.sort(byDistance);
      const t0 = performance.now();
      let k = 0;
      for (; k < todo.length; k++) {
        if (k && performance.now() - t0 > PLAN_MS) break;
        const e = todo[k], had = e.pts.length;
        e.pts = cellPoints(e.key, world.city.chunkIndex.get(e.key), world.terrain, e.want !== 'full', world.city);
        e.tier = e.want;
        if (!had && e.pts.length) order.push(e);
      }
      this._more = k < todo.length;
      // while plans are still coming the buffers are refilled four times a
      // second, not every frame: 30 000 instances are two megabytes to upload
      if (this._more && (this._fill = (this._fill ?? 0) + 1) % 15) return;
    }
    order.sort(byDistance);
    let k = 0;
    const col = this.mesh.instanceColor.array, im = this.mesh.instanceMatrix.array;
    for (let j = 0; j < order.length && k < MAX; j++) {
      const pts = order[j].pts;
      for (let i = 0; i + 5 < pts.length && k < MAX; i += 6, k++) {
        im[k * 16 + 12] = pts[i]; im[k * 16 + 13] = pts[i + 1]; im[k * 16 + 14] = pts[i + 2];
        col[k * 3] = pts[i + 3]; col[k * 3 + 1] = pts[i + 4]; col[k * 3 + 2] = pts[i + 5];
      }
    }
    this.mesh.count = k;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.mesh.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.mat.dispose();
  }
}

const byDistance = (a, b) => a.d2 - b.d2;

function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h | 0;
}

/**
 * Every point of light one cell owes the night, as x, y, z, r, g, b. Pure: the
 * same cell gives the same points on every client and every visit.
 */
export function cellPoints(key, cell, terrain, windows = true, city = null) {
  if (!cell) return EMPTY;
  const c = key.indexOf(','), cx = +key.slice(0, c), cz = +key.slice(c + 1);
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const out = [];
  const H = (x, z) => terrain?.heightAt?.(x, z) ?? 0;
  // ---- the lamps: the mesher's own plan for this cell ----
  // (a column on a bridge carries its deck's height, any other stands on the ground)
  const plan = lampPlan(cell, key, terrain, city);
  for (const sp of plan.street) {
    const px = sp[0], pz = sp[1];
    const t = hash2(Math.floor(px / DISTRICT), Math.floor(pz / DISTRICT)) < LED_SHARE ? LED : SODIUM;
    out.push(px, (sp[3] ?? H(px, pz)) + HEAD_Y, pz, t[0], t[1], t[2]);
  }
  for (const sp of plan.park) {
    const px = sp[0], pz = sp[1];
    const t = hash2(Math.floor(px / DISTRICT), Math.floor(pz / DISTRICT)) < LED_SHARE ? LED : SODIUM;
    out.push(px, H(px, pz) + PARK_Y, pz, t[0] * PARK_K, t[1] * PARK_K, t[2] * PARK_K);
  }
  // the D11's interchange masts (js/mastlamps.js): a point at every head, at
  // the head's own height, in the interchange's one colour
  for (const [list, arms] of [[plan.mast, 2], [plan.mast1, 1]]) {
    for (const sp of list ?? []) {
      const px = sp[0], pz = sp[1], rx = -Math.sin(sp[2]), rz = -Math.cos(sp[2]);
      const y = (sp[3] ?? H(px, pz)) + MAST_Y, t = mastTint(px, pz);
      for (let a = 0; a < arms; a++) {
        const o = a === 0 ? MAST_OUT : -MAST_OUT;
        out.push(px + rx * o, y, pz + rz * o, t[0], t[1], t[2]);
      }
    }
  }
  // ---- windows: one to three on the walls of every other building ----
  // (not where the cell is built in full: there the facades light their own)
  if (windows) for (const b of cell.buildings ?? []) {
    const o = b.o;
    if (!o || o.length < 3) continue;
    const id = b._id ?? 0;
    if (hash2(id, 11) < 0.45) continue;                 // a dark house
    // a building belongs to the cell its first corner is in, so one that
    // straddles a border is not lit twice
    if (o[0][0] < x0 || o[0][0] >= x1 || o[0][1] < z0 || o[0][1] >= z1) continue;
    // A footprint a landmark claims is drawn as the hand-built model at every
    // tier (meshes.js), and the model's panes glow on their own. Points at the
    // TILE's heights hung in the air beside the Old Town Hall tower, in the
    // arch of the Powder Tower and over Charles Bridge's towers' passages.
    if (landmarkOf(b)) continue;
    // ...and a footprint the tile lifts (a skyway, a covered bridge, a gate
    // over its passage) has its walls from y up, not from the street
    const y0 = b.y > 0.5 ? b.y : 0;
    const h = Math.max(3, b.h ?? 6), n = 1 + ((hash2(id, 5) * Math.min(3, 1 + (h - y0) / 9)) | 0);
    if (h - y0 < 2.4) continue;
    for (let j = 0; j < n; j++) {
      const e = (hash2(id, 20 + j) * o.length) | 0, f = (e + 1) % o.length, t = hash2(id, 40 + j);
      const x = o[e][0] + (o[f][0] - o[e][0]) * t, z = o[e][1] + (o[f][1] - o[e][1]) * t;
      const w = hash2(id, 60 + j) < 0.14 ? COOL : WARM, v = 0.34 + 0.22 * hash2(id, 80 + j);
      out.push(x, H(x, z) + y0 + 1.6 + (h - y0 - 2.4) * hash2(id, 100 + j), z, w[0] * v, w[1] * v, w[2] * v);
    }
  }
  return out.length ? new Float32Array(out) : EMPTY;
}
const EMPTY = new Float32Array(0);
