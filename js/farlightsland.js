// ---- farlightsland.js: the towns' lights on the far land at night (round 8) ----
// MAIN THREAD (owns a mesh and a worker).
//
// With the open view (js/farterrain.js) the D11 at night looked out over a
// black plain: js/farlights.js lights only the cells that are built, and the
// window ends 720 m out. A village two kilometres off is a cluster of street
// lights and windows and nothing else, and where the villages are is known:
// the overview's built-up 200 m cells (public/data/overview.json `urban`, read
// once by js/farurbanworker.js, off the main thread). Each cell gets a few
// points of sodium, LED and window light, hashed from its position (the same
// on every machine, whatever order anything arrived in), standing on the
// height map, and they fade in past the window's edge, where the real lamps
// end, and out with the haze.
//
// One Points draw. Built from scratch when the eye has moved REBUILD m (a few
// milliseconds for some ten thousand points), shown only at night with the
// open view on.

import * as THREE from 'three';
import { dataUrl } from './regions.js';

const REACH = 8000;           // m (box) of land whose lights are drawn
const REBUILD = 1200;         // m the eye moves before the set is made again
const SPACING = 55;           // m: about one light per this square of town
const MAX = 24000;            // points
const HEAD = 6;               // m over the ground
const SODIUM = [1.0, 0.56, 0.21], LED = [1.0, 0.80, 0.56], WARM = [1.0, 0.74, 0.42];

function hash2(i, j, s) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(s | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const VERT = /* glsl */`
  attribute vec3 color;
  uniform vec4 uEdge;        // x, z: the window's centre; z: dissolve start; w: end (Chebyshev m)
  uniform vec2 uWall;        // the fog wall near and far
  uniform float uNight;
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec4 mv = modelViewMatrix * vec4( position, 1.0 );
    gl_Position = projectionMatrix * mv;
    float d = length( mv.xyz );
    vec2 q = abs( position.xz - uEdge.xy );
    float inside = 1.0 - smoothstep( uEdge.z, uEdge.w, max( q.x, q.y ) );
    vA = uNight * ( 1.0 - inside ) * ( 1.0 - smoothstep( uWall.x, uWall.y, d ) );
    // At ground level many kilometres of town project onto the same row.
    // A distant point contributes less light even before the outer fog wall.
    vCol = color / (1.0 + d * d * 0.00000032);
    gl_PointSize = 3.0;
  }`;
const FRAG = /* glsl */`
  varying vec3 vCol;
  varying float vA;
  void main() {
    if ( vA < 0.01 ) discard;
    vec2 q = 2.0 * gl_PointCoord - 1.0;
    float coverage = 1.0 - smoothstep(0.0, 1.0, dot(q, q));
    gl_FragColor = vec4(vCol * (0.8 * vA * coverage), 1.0);
  }`;

export class FarLandLights {
  constructor(scene, terrain) {
    this.terrain = terrain;
    this.boxes = null;
    this._asked = false;
    this._at = null;
    this.uni = { uEdge: { value: new THREE.Vector4() }, uWall: { value: new THREE.Vector2(3000, 5000) }, uNight: { value: 0 } };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setDrawRange(0, 0);
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uni,
      blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
    this.points = new THREE.Points(geo, this.mat);
    this.points.name = 'far-land-lights';
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
    this.points.visible = false;
    scene.add(this.points);
  }

  _ask() {
    this._asked = true;
    try {
      const w = new Worker(new URL('./farurbanworker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { if (e.data.boxes) this.boxes = e.data.boxes; w.terminate(); };
      w.onerror = () => w.terminate();
      w.postMessage({ url: new URL(dataUrl('overview.json'), document.baseURI).href });
    } catch { /* no workers: no far lights */ }
  }

  /** Once a frame: `night` 0..1, the window edge [x, z, r0, r1], the fog wall near/far. */
  update(x, z, on, night, edge, near, far) {
    const show = on && night > 0.05;
    this.points.visible = show && !!this.boxes;
    if (!show) return;
    if (!this._asked) this._ask();
    if (!this.boxes) return;
    if (!this._at || Math.max(Math.abs(x - this._at[0]), Math.abs(z - this._at[1])) > REBUILD) this._fill(x, z);
    this.uni.uEdge.value.set(edge[0], edge[1], edge[2], edge[3]);
    this.uni.uWall.value.set(near, far);
    this.uni.uNight.value = night;
  }

  _fill(x, z) {
    this._at = [x, z];
    const b = this.boxes, t = this.terrain;
    const pos = this.points.geometry.attributes.position, col = this.points.geometry.attributes.color;
    let n = 0;
    for (let k = 0; k < b.length && n < MAX; k += 4) {
      const x0 = b[k], z0 = b[k + 1], x1 = b[k + 2], z1 = b[k + 3];
      if (x1 < x - REACH || x0 > x + REACH || z1 < z - REACH || z0 > z + REACH) continue;
      // a light every SPACING metres or so, jittered, on a grid that is the
      // same whichever box a point falls in
      const i0 = Math.floor(x0 / SPACING), i1 = Math.floor((x1 - 1e-3) / SPACING);
      const j0 = Math.floor(z0 / SPACING), j1 = Math.floor((z1 - 1e-3) / SPACING);
      for (let i = i0; i <= i1 && n < MAX; i++) for (let j = j0; j <= j1 && n < MAX; j++) {
        const h = hash2(i, j, 1);
        if (h < 0.35) continue;                  // yards, fields between houses
        const px = (i + hash2(i, j, 2)) * SPACING, pz = (j + hash2(i, j, 3)) * SPACING;
        if (px < x0 || px >= x1 || pz < z0 || pz >= z1) continue;
        if (!t.ready(px, pz)) continue;
        pos.array[n * 3] = px; pos.array[n * 3 + 1] = t.heightAt(px, pz) + HEAD; pos.array[n * 3 + 2] = pz;
        const c = h < 0.55 ? WARM : hash2(i, j, 4) < 0.34 ? LED : SODIUM;
        const k2 = h < 0.55 ? 0.55 : 1;
        col.array[n * 3] = c[0] * k2; col.array[n * 3 + 1] = c[1] * k2; col.array[n * 3 + 2] = c[2] * k2;
        n++;
      }
    }
    pos.needsUpdate = true; col.needsUpdate = true;
    this.points.geometry.setDrawRange(0, n);
    this.count = n;
  }
}
