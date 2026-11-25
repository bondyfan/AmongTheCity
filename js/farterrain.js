// ---- farterrain.js: the land beyond the streamed ring (round 8, HORIZON) ----
// MAIN THREAD ONLY (it owns meshes and textures); not part of buildChunkMeshes,
// so the mesher workers and their parity never see it.
//
// On the open D11 the streamed world ends 480 to 960 m out, and beyond it there
// was nothing but a fog wall at 422 m (medium, day): 7 s of sight at 200 km/h,
// a white sheet across the motorway. This draws the country out to the edge of
// the height maps the game already holds (city.js keeps every one within 6 km
// of the lead point): ONE low-resolution patch per 4.8 km terrain tile, wearing
// the same ČÚZK orthophoto the near ground wears, at 512 px a tile (9.4 m/px,
// what a kilometre away resolves to anyway), lit by the same sun.
//
// IT ALWAYS LIES UNDER THE STREAMED GROUND. A patch vertex every STEP metres
// takes the LOWEST height of every 20 m sample within STEP of it (heightAt:
// the earthworks, the ecoduct digs and the riverbed included) and SINK more, so
// across any cell of the patch each of its four corners is at or under every
// sample of that cell, and so is everything interpolated between them. Where
// the streamed ground is drawn it wins the depth test; where it dissolves at
// the window's edge (heightfog.js setFarEdge) this shows through. Skirts hang
// from every patch edge, because two neighbouring patches pool their own sides
// and meet at slightly different heights.
//
// Main.js shows it only where the view is open (js/openness.js), and never in
// Prague, which has its own far skyline and far ground (js/landmarksfar.js).
// Built once per tile when its height map is there, one tile a frame, disposed
// past DROP_R. Nothing here depends on time, randomness or arrival order.

import * as THREE from 'three';
import { wmsUrl } from './ortho.js';
import { region } from './regions.js';

const STEP = 80;              // m between patch vertices
const SINK = 2.0;             // m under the pooled minimum (heightAt is smooth between samples)
const SKIRT = 25;             // m a skirt hangs below a patch edge
const KEEP_R = 6200;          // m (box) round the player inside which a patch is built
const DROP_R = 9000;          // …and past which it is disposed
const PX = 512;               // photo pixels a tile
const PHOTOS_AT_ONCE = 2;    // far photo requests in flight at most
const SCAN = 20;              // frames between two looks at what to build or drop
// what the land reads as where no photo is (low preset, a dead WMS tile);
// on Mahé (js/regions.js), which has no photo at all, the rainforest green
const BARE = region().id === 'mahe' ? 0x355a2c : 0x7d8a5c;

export class FarTerrain {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.group = new THREE.Group();
    this.group.name = 'far-terrain';
    this.group.visible = false;
    scene.add(this.group);
    this.patches = new Map();          // "tx,tz" -> { mesh, tex, mat } | null (no grid)
    this._loader = new THREE.TextureLoader();
    this._ready = [];                  // photos decoded and waiting for an upload (pump)
    this.photos = true;                // main.js: the ortho setting
    this._scan = 0;                    // frames to the next look (update)
    this._want = [];                   // [key, patch, ...] whose photo is still to ask for
    this._flying = 0;                  // photo requests in flight
    this.stats = { built: 0, lastMs: 0, maxMs: 0, tris: 0 };
  }

  /**
   * Once a frame. `on` false hides the layer and builds nothing. At most one
   * patch is built and one photo uploaded a frame. `grow` false (main.js:
   * the view is closing, the fog easing back in) shows what is there but
   * builds no new patch, so a teleport into Prague does not lay the far land
   * over it while the wall comes in.
   */
  update(x, z, on, renderer, grow = on) {
    this.group.visible = on;
    // the photos first: one upload a frame
    if (on && this._ready.length) {
      const p = this._ready.shift();
      if (p.mesh.parent) {
        renderer?.initTexture?.(p.tex);
        p.mat.map = p.tex; p.mat.color.set(0xffffff); p.mat.needsUpdate = true;
      }
    }
    // The photos are asked for a few at a time: an open view arriving builds
    // a dozen patches in a dozen frames, and a dozen requests at once to the
    // same WMS would queue the near ground's photos (js/ortho.js) behind them.
    while (on && this._flying < PHOTOS_AT_ONCE && this._want.length) {
      const key = this._want.shift(), p = this._want.shift();
      if (this.patches.get(key) === p) this._ask(key, p);
    }
    // The bookkeeping below makes key strings, so it runs every SCAN frames,
    // not every frame (every frame while patches are still missing). The
    // disposal runs with the layer hidden too: a drive from the open D11 into
    // a town or to Prague lets the patches behind it go instead of keeping
    // them until the view opens again.
    if (--this._scan > 0) return;
    this._scan = SCAN;
    const T = this.terrain.tile;
    // dispose what fell far behind
    for (const [key, p] of this.patches) {
      if (!p) continue;
      const dx = Math.max(p.tx * T - x, 0, x - (p.tx + 1) * T), dz = Math.max(p.tz * T - z, 0, z - (p.tz + 1) * T);
      if (Math.max(dx, dz) > DROP_R) this._drop(key, p);
    }
    // A patch whose ground moved since it was built (the earthworks bake,
    // city.js, bumps terrain._gridVer; a height map evicted and loaded again
    // is a new grid) is built again, one a look, hidden or not, so it is right
    // before it is shown: a patch made before the bake stood up to 7 m over
    // the D11 where the bake later lowered it.
    for (const [key, p] of this.patches) {
      if (!p) continue;
      const g = this.terrain.grids.get(key);
      if (g && (g !== p.grid || (this.terrain._gridVer?.get(key) ?? 0) !== p.ver)) { this._reshape(key, p); return; }
    }
    if (!on || !grow) return;
    // the nearest missing patch whose height map is there
    let best = null, bestD = Infinity;
    const t0x = Math.floor((x - KEEP_R) / T), t1x = Math.floor((x + KEEP_R) / T);
    const t0z = Math.floor((z - KEEP_R) / T), t1z = Math.floor((z + KEEP_R) / T);
    for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
      const key = tx + ',' + tz;
      if (this.patches.has(key) || !this.terrain.grids.get(key)) continue;
      const d = Math.hypot((tx + 0.5) * T - x, (tz + 0.5) * T - z);
      if (d < bestD) { bestD = d; best = key; }
    }
    if (best) { this._build(best); this._scan = 1; }   // (more may be missing: look again next frame)
  }

  _drop(key, p) {
    this.group.remove(p.mesh);
    p.mesh.geometry.dispose();
    p.mat.dispose();
    p.tex?.dispose();
    this.patches.delete(key);
  }

  _build(key) {
    const t0 = performance.now();
    const i = key.indexOf(','), tx = +key.slice(0, i), tz = +key.slice(i + 1);
    const geo = buildPatchGeometry(this.terrain, tx, tz);
    const mat = new THREE.MeshLambertMaterial({ color: BARE });
    // (the window's edge dissolve is for the streamed world, not for this:
    // heightfog.js atcHandOut)
    mat.defines = { ATC_NO_EDGE: '' };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = 'far-terrain:' + key;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false; mesh.receiveShadow = false;
    mesh.position.set(tx * this.terrain.tile, 0, tz * this.terrain.tile);
    mesh.updateMatrix();
    const p = { mesh, mat, tex: null, tx, tz,
      grid: this.terrain.grids.get(key), ver: this.terrain._gridVer?.get(key) ?? 0 };
    if (this.photos) this._want.push(key, p);         // (asked for in update, PHOTOS_AT_ONCE at a time)
    this.group.add(mesh);
    this.patches.set(key, p);
    const ms = performance.now() - t0;
    this.stats.built++; this.stats.lastMs = ms;
    if (ms > this.stats.maxMs) this.stats.maxMs = ms;
    this.stats.tris = 0;
    for (const q of this.patches.values()) if (q) this.stats.tris += q.mesh.geometry.index.count / 3;
  }

  // New heights under the same material and photo (see update).
  _reshape(key, p) {
    const t0 = performance.now();
    p.grid = this.terrain.grids.get(key);
    p.ver = this.terrain._gridVer?.get(key) ?? 0;
    const old = p.mesh.geometry;
    p.mesh.geometry = buildPatchGeometry(this.terrain, p.tx, p.tz);
    old.dispose();
    this.stats.reshaped = (this.stats.reshaped ?? 0) + 1;
    const ms = performance.now() - t0;
    this.stats.lastMs = ms;
    if (ms > this.stats.maxMs) this.stats.maxMs = ms;
  }

  // One patch's photo. Its failure (a dead WMS tile answers 200 with XML,
  // which the decoder rejects) leaves the patch its flat colour for good.
  _ask(key, p) {
    const T = this.terrain.tile, x0 = p.tx * T, z0 = p.tz * T;
    this._flying++;
    const tex = this._loader.load(wmsUrl(x0, z0, x0 + T, z0 + T, PX), () => {
      this._flying--;
      if (this.patches.get(key) !== p) return;
      const img = tex.image, go = () => this._ready.push(p);
      if (img && typeof img.decode === 'function') img.decode().then(go, go); else go();
    }, undefined, () => { this._flying--; });
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    p.tex = tex;
  }

  dispose() {
    for (const [key, p] of this.patches) if (p) this._drop(key, p);
    this.group.parent?.remove(this.group);
  }
}

/**
 * The heights of one patch, in a (n x n) Float32Array at STEP spacing, from
 * the tile's 20 m samples: the minimum within STEP of each vertex, less SINK.
 * Pure: a function of the terrain and the tile (tests/farterrain.test.mjs).
 */
export function patchHeights(terrain, tx, tz) {
  const T = terrain.tile, res = terrain.res, N = terrain.n;     // 241 samples a side
  const x0 = tx * T, z0 = tz * T;
  const H = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = terrain.heightAt(x0 + i * res, z0 + j * res);
  // the minimum over ±r samples, rows then columns (separable)
  const r = Math.round(STEP / res);
  const A = new Float32Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    let m = Infinity;
    for (let k = Math.max(0, i - r); k <= Math.min(N - 1, i + r); k++) if (H[j * N + k] < m) m = H[j * N + k];
    A[j * N + i] = m;
  }
  const n = Math.round(T / STEP) + 1, s = Math.round(STEP / res);
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const ci = i * s, cj = j * s;
    let m = Infinity;
    for (let k = Math.max(0, cj - r); k <= Math.min(N - 1, cj + r); k++) if (A[k * N + ci] < m) m = A[k * N + ci];
    out[j * n + i] = m - SINK;
  }
  return { n, step: STEP, h: out };
}

/** The patch as an indexed geometry about the tile's corner, skirts included. */
export function buildPatchGeometry(terrain, tx, tz) {
  const T = terrain.tile;
  const { n, step, h } = patchHeights(terrain, tx, tz);
  const ring = 4 * (n - 1);                         // edge vertices, once each
  const nv = n * n + ring;
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const v = j * n + i;
    pos[v * 3] = i * step; pos[v * 3 + 1] = h[v]; pos[v * 3 + 2] = j * step;
    // image row 0 is the tile's NORTH edge (smallest z), and the loader's flipY
    // puts it at v = 1 (ortho.js tileUrl)
    uv[v * 2] = (i * step) / T; uv[v * 2 + 1] = 1 - (j * step) / T;
  }
  const idx = [];
  for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // the skirt: the edge walked once round, each vertex copied SKIRT lower
  const edge = [];
  for (let i = 0; i < n - 1; i++) edge.push(i);                       // north, west to east
  for (let j = 0; j < n - 1; j++) edge.push(j * n + n - 1);           // east, north to south
  for (let i = n - 1; i > 0; i--) edge.push((n - 1) * n + i);         // south, east to west
  for (let j = n - 1; j > 0; j--) edge.push(j * n);                   // west, south to north
  for (let k = 0; k < ring; k++) {
    const s = edge[k], v = n * n + k;
    pos[v * 3] = pos[s * 3]; pos[v * 3 + 1] = pos[s * 3 + 1] - SKIRT; pos[v * 3 + 2] = pos[s * 3 + 2];
    uv[v * 2] = uv[s * 2]; uv[v * 2 + 1] = uv[s * 2 + 1];
  }
  for (let k = 0; k < ring; k++) {
    const a = edge[k], b = edge[(k + 1) % ring], a2 = n * n + k, b2 = n * n + (k + 1) % ring;
    // (both windings: a skirt is seen from either side, and it costs nothing)
    idx.push(a, a2, b, b, a2, b2, a, b, a2, b, b2, a2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
