// ---- tramglow.js: a tram's lights, seen from far off at night ---------------------
// Past a couple of hundred metres a tram's head lamps and lit windows are
// smaller than a pixel: the lamp quads of the body (js/trammesh.js) flicker in
// and out and then vanish, and a night street with trams on it reads as one
// without. The town's own far lamps have the same problem and the answer
// (js/farlights.js): a camera-facing glow with a two-pixel floor, drawn with
// the lamp glows' shader (js/lightpools.js) so it thins with the haze and
// comes up through dusk with the street lamps. Here every drawn tram gets a
// few of those points (head lamps, tail lamps, a warm point per section for
// its windows), rewritten each frame: about 6 to 12 a tram, one draw for all.
// They fade in beyond NEAR metres, where the body's own lamps stop reading.

import * as THREE from 'three';

const MAX = 1200;              // points: a hundred trams at most in reach
const NEAR = 70;               // m: nearer than this the body's own lamps do it
const RANGE = 2400;            // m: the glow shader's fade-out
const SIZE = 0.55;             // m: a lamp's real radius

export class TramGlow {
  constructor(scene) {
    this.scene = scene;
    this.mesh = null;
    this.src = null;
    this.n = 0;
  }

  /** Take the lamp glows' shader from js/lightpools.js (main.js, once both exist). */
  attach(lightPools) {
    if (this.mesh || !lightPools?.glowMat) return;
    this.src = lightPools.glowMat;
    const mat = this.src.clone();
    mat.uniforms.uRange.value = RANGE;
    mat.uniforms.uSize.value = SIZE;
    mat.uniforms.uNear.value = NEAR;
    const m = new THREE.InstancedMesh(new THREE.PlaneGeometry(2, 2), mat, MAX);
    m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    m.count = 0;
    m.visible = false;
    m.frustumCulled = false;
    m.matrixAutoUpdate = false;
    m.renderOrder = -789;             // with the lamp glows (js/lightpools.js), before glass and smoke
    m.castShadow = m.receiveShadow = false;
    m.onBeforeRender = (renderer) => { mat.uniforms.uDirect.value = renderer.getRenderTarget() === null ? 1 : 0; };
    // every instance is a translation: the identity is written once
    const im = m.instanceMatrix.array;
    for (let i = 0; i < MAX; i++) { im[i * 16] = im[i * 16 + 5] = im[i * 16 + 10] = im[i * 16 + 15] = 1; }
    this.mesh = m;
    this.scene.add(m);
  }

  /** Is anything to be drawn this frame? (no shader yet, or broad day: skip the points) */
  get on() { return !!this.mesh && this.src.uniforms.uOn.value > 0.002; }

  begin() { this.n = 0; }

  point(x, y, z, r, g, b) {
    if (this.n >= MAX) return;
    const i = this.n++, im = this.mesh.instanceMatrix.array, c = this.mesh.instanceColor.array;
    im[i * 16 + 12] = x; im[i * 16 + 13] = y; im[i * 16 + 14] = z;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
  }

  end() {
    const m = this.mesh;
    if (!m) return;
    const u = m.material.uniforms, su = this.src.uniforms;
    // the street lamps' dusk curve, level and pixel size, so the two agree
    u.uOn.value = su.uOn.value; u.uLevel.value = su.uLevel.value; u.uPx.value = su.uPx.value;
    m.count = this.n;
    m.visible = this.n > 0 && su.uOn.value > 0.002;
    if (this.n) { m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
  }
}
