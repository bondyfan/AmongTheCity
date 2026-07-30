// ---- grass you can stand in ----------------------------------------------
// A texture of grass is a photograph of grass, and it is convincing until you
// stand on it, at which point it is a green floor. What makes a lawn read as a
// lawn from a metre up is that it has THICKNESS — blades catching the light at
// different angles, a soft edge against the kerb, and the fact that it moves.
//
// So: real geometry, but only where it can be afforded, which is close to the
// camera. This is a ring of instanced tufts that follows the player and is
// rebuilt when they walk out of it — nothing is stored per chunk, nothing is
// streamed, and the whole thing is one draw call.
//
// WHERE IT GROWS is decided from the same data the ground colour comes from:
// inside a green polygon, or on unclaimed ground that no road, no car park and
// no building is standing on. That last test is the one that matters — grass
// growing through the tarmac is worse than no grass at all, and OSM's green
// polygons are drawn generously enough that a park routinely covers the path
// running through it.
//
// SCATTER is world-anchored and deterministic: a tuft's position comes from a
// hash of its grid cell, so it is in the same place for every player and does
// not crawl as the ring is rebuilt. Same rule as the tree scatter, same reason.
//
// COST at the defaults below: a 58 m ring at one tuft per 1.15 m² is about
// 8 000 candidates, of which roughly half survive the masks; each is five
// tapered blades, so ~40 000 triangles in one instanced draw. The rebuild walks
// the candidates against the chunk index and costs a few milliseconds, which is
// why it only happens once the player has moved REBUILD_AT metres.

import * as THREE from '../libs/three.module.js';
import { LAYER_Y } from './config.js';
import { chunkKey, pointInPolygon, distPointToSegment } from './geo.js';

const RADIUS = 58;          // m of grass around the camera
const SPACING = 0.66;       // m between candidate tufts (jittered inside the cell)
const REBUILD_AT = 9;       // m of travel before the ring is rebuilt
const BLADES = 6;           // tapered blades per tuft
// Taller than a real lawn on purpose. A 12 cm blade seen from a camera eight
// metres up and nearly edge-on is a fraction of a pixel: the first pass placed
// 3 837 tufts and not one of them was visible. These are the heights at which
// grass reads as grass from where the game is actually played.
const H_MIN = 0.26, H_MAX = 0.62;   // m — mown verge to unmown meadow
const FADE = 0.82;          // fraction of RADIUS where tufts start shrinking

// The green a blade is, before the per-tuft variation. Warmer and lighter at
// the tip than at the root, which is most of what makes a tuft read as round.
const ROOT = new THREE.Color(0x35502a);
const TIP = new THREE.Color(0x7fa451);

const MEADOW_TYPES = new Set(['meadow', 'grassland', 'heath', 'scrub', 'village_green']);
const NO_GRASS = new Set(['pitch', 'cemetery']);   // mown to the ground, or paved between stones

/** One tuft at the origin: BLADES tapered strips, splayed and twisted. */
function tuftGeometry() {
  const pos = [], col = [], hgt = [];
  const c = new THREE.Color();
  for (let b = 0; b < BLADES; b++) {
    const a = (b / BLADES) * Math.PI * 2 + b * 0.7;
    const lean = 0.18 + (b % 3) * 0.09;
    const dx = Math.cos(a), dz = Math.sin(a);
    const w = 0.027;                      // half-width at the root
    // root quad → tip triangle, so a blade tapers to a point in two triangles
    const rx = -dz * w, rz = dx * w;
    const mx = dx * lean * 0.45, mz = dz * lean * 0.45;
    const tx = dx * lean, tz = dz * lean;
    const P = [
      [-rx, 0, -rz], [rx, 0, rz], [mx + rx * 0.45, 0.55, mz + rz * 0.45],
      [-rx, 0, -rz], [mx + rx * 0.45, 0.55, mz + rz * 0.45], [mx - rx * 0.45, 0.55, mz - rz * 0.45],
      [mx - rx * 0.45, 0.55, mz - rz * 0.45], [mx + rx * 0.45, 0.55, mz + rz * 0.45], [tx, 1, tz],
    ];
    for (const [x, y, z] of P) {
      pos.push(x, y, z);
      hgt.push(y);
      c.copy(ROOT).lerp(TIP, y * y);
      col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // How far up the blade a vertex is — the wind bends by the square of it, so
  // the root stays put and the tip does the moving, which is what a blade does.
  g.setAttribute('up01', new THREE.Float32BufferAttribute(hgt, 1));
  g.computeVertexNormals();
  return g;
}

function grassMaterial() {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,   // a blade is one-sided geometry seen from anywhere
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        attribute float up01;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // Two waves crossing at an angle, so the field ripples rather than
          // swaying as one — the give-away of instanced grass is every tuft
          // leaning the same way at the same moment.
          vec3 wp = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float k = up01 * up01;
          float a = sin(uTime * 1.7 + wp.x * 0.21 + wp.z * 0.13);
          float b = sin(uTime * 1.1 + wp.x * 0.07 - wp.z * 0.19);
          transformed.x += k * (a * 0.055 + b * 0.03);
          transformed.z += k * (b * 0.055 - a * 0.025);
        }`);
  };
  return mat;
}

export class Grass {
  /** @param world the CityWorld — for the chunk index, the terrain and surfaceY */
  constructor(scene, world, city) {
    this.scene = scene;
    this.world = world;
    this.city = city;
    this.enabled = true;
    this.mesh = null;
    this._at = null;                    // where the current ring was built
    this._mat = grassMaterial();
    this._geo = tuftGeometry();
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._v = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._cap = 0;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this._dispose();
    else this._at = null;               // force a rebuild at the next update
  }

  _dispose() {
    if (!this.mesh) return;
    this.scene.remove(this.mesh);
    this.mesh.dispose?.();
    this.mesh = null;
  }

  /** Deterministic 0..1 from a grid cell — the same tuft for every player. */
  static _rnd(i, j, salt) {
    let h = (i * 374761393 + j * 668265263 + salt * 1442695041) | 0;
    h = (h ^ (h >>> 13)) * 1274126177;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  }

  /**
   * Is there grass at (x, z), and how tall? Returns 0 for "no".
   *
   * Green polygons say yes; a road, a car park or a building says no, and no
   * beats yes — OSM draws a park straight over the path through it, and a tuft
   * standing in the tarmac is worse than a bare verge.
   */
  _grassAt(x, z) {
    const cell = this.city.chunkIndex.get(chunkKey(x, z));
    if (!cell) return 0;
    for (const r of cell.roads) {
      const half = (r.w ?? 3) / 2 + 0.5;
      for (let i = 0; i < r.p.length - 1; i++) {
        if (distPointToSegment(x, z, r.p[i][0], r.p[i][1], r.p[i + 1][0], r.p[i + 1][1], null) < half) return 0;
      }
    }
    for (const p of cell.paved) if (pointInPolygon(x, z, p.o)) return 0;
    for (const b of cell.buildings) if (b.o && pointInPolygon(x, z, b.o)) return 0;
    for (const w of cell.water) if (w.o && pointInPolygon(x, z, w.o)) return 0;
    let h = 0, mapped = false;
    for (const g of cell.green) {
      if (!g.o || !pointInPolygon(x, z, g.o)) continue;
      if ((g.i ?? []).some((hole) => pointInPolygon(x, z, hole))) continue;
      mapped = true;
      if (NO_GRASS.has(g.t)) return 0;              // a pitch is mown to the ground
      h = Math.max(h, MEADOW_TYPES.has(g.t) ? H_MAX : H_MIN + (H_MAX - H_MIN) * 0.35);
    }
    // Ground nobody mapped, with nothing built on it, IS grass — that is what
    // the ground renders as, and a green floor with no blades in it is exactly
    // the thing this exists to fix. It is kept short: an unmapped verge in a
    // city is a mown strip, not a meadow.
    return mapped ? h : H_MIN * 0.85;
  }

  /** Called every frame with the camera's ground position. */
  update(x, z, dt) {
    if (!this.enabled) return;
    const sh = this._mat.userData.shader;
    if (sh) sh.uniforms.uTime.value += dt;
    if (this._at && (x - this._at[0]) ** 2 + (z - this._at[1]) ** 2 < REBUILD_AT * REBUILD_AT) return;
    this._at = [x, z];
    this._rebuild(x, z);
  }

  _rebuild(cx, cz) {
    const terrain = this.world?.terrain;
    if (!terrain) return;
    const step = SPACING;
    const i0 = Math.floor((cx - RADIUS) / step), i1 = Math.ceil((cx + RADIUS) / step);
    const j0 = Math.floor((cz - RADIUS) / step), j1 = Math.ceil((cz + RADIUS) / step);
    const R2 = RADIUS * RADIUS, fade0 = (RADIUS * FADE) ** 2;
    const M = [];
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x = (i + Grass._rnd(i, j, 1)) * step;
        const z = (j + Grass._rnd(i, j, 2)) * step;
        const d2 = (x - cx) ** 2 + (z - cz) ** 2;
        if (d2 > R2) continue;
        const h = this._grassAt(x, z);
        if (h <= 0) continue;
        // …and thin out towards the edge instead of ending in a hard circle
        const t = d2 <= fade0 ? 1 : 1 - (d2 - fade0) / (R2 - fade0);
        if (Grass._rnd(i, j, 3) > t * 0.92 + 0.08) continue;
        const y = terrain.heightAt(x, z) + LAYER_Y.green;
        const scale = h * (0.72 + 0.56 * Grass._rnd(i, j, 4)) * (0.55 + 0.45 * t);
        this._q.setFromAxisAngle(UP, Grass._rnd(i, j, 5) * Math.PI * 2);
        this._v.set(x, y, z);
        this._s.set(0.9 + 0.35 * Grass._rnd(i, j, 6), scale, 0.9 + 0.35 * Grass._rnd(i, j, 7));
        M.push(new THREE.Matrix4().compose(this._v, this._q, this._s));
      }
    }
    // Reuse the instanced mesh while it is big enough — an InstancedMesh cannot
    // grow, and rebuilding it every nine metres of walking would churn a buffer
    // the size of the ring several times a minute.
    if (!this.mesh || M.length > this._cap) {
      this._dispose();
      this._cap = Math.ceil(M.length * 1.25) + 256;
      this.mesh = new THREE.InstancedMesh(this._geo, this._mat, this._cap);
      this.mesh.frustumCulled = false;      // the ring is around the camera anyway
      this.mesh.castShadow = false;
      this.mesh.receiveShadow = false;
      this.scene.add(this.mesh);
    }
    for (let k = 0; k < M.length; k++) this.mesh.setMatrixAt(k, M[k]);
    this.mesh.count = M.length;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

const UP = new THREE.Vector3(0, 1, 0);
