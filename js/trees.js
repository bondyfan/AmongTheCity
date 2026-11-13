// ---- trees.js: the trees near you, and the shade under all of them ----------
// A chunk draws each of its trees as a 57-vertex blob on a stick, which is the
// right amount of tree at 80 m and a balloon at 10. This module owns the other
// tier: every frame it knows which trees stand within `radius` of the camera,
// and draws those as the full models of js/treemodels.js, one InstancedMesh per
// species build. The far instance of the same tree dissolves in the shader
// across the last few metres of the radius (js/treeshader.js), so there is
// never a frame with both or neither.
//
// It reads the trees straight out of the chunks' own InstancedMeshes: the crown
// matrix IS the crown and the low bits of its colour are the species (see the
// header of js/treeshapes.js). Nothing is added to a chunk and nothing travels
// through the worker for this, which is why the near tier costs the streamer
// nothing at all.
//
// THE BUDGET is a cap on instances, not just a radius. In a wood the radius
// that would hold `cap` trees is smaller than the one asked for, so the radius
// shrinks to fit: the swap band moves in and the frame cost stays put.
//
// It also keeps the SHADE MAP: a top-down picture of every crown within 190 m,
// which the post stack multiplies into whatever lies under a tree (the ground,
// a parked car, you). That is what stops a tree looking pasted onto a street.
// postfx.js had the reading side of this plumbed and switched off for want of a
// map; this is the map.

import * as THREE from 'three';
import { SP, groundOf, farCrownExtent, tagSpecies, tagVariant } from './treeshapes.js';
import { TREE_U, nearTreeMaterial, treeDepthMaterial } from './treeshader.js';
import { nearModel } from './treemodels.js';
import { worldPhase } from './worldclock.js';

const CHUNK_HALF = 60;      // half of config.CHUNK: a chunk group sits at its centre
const MOVE = 3;             // m the camera may travel before the near set is redrawn
const BAND = 0.8;           // the swap starts at this share of the radius
const SHADE_SIZE = 384;     // m across the shade map
const SHADE_PX = 256;
const SHADE_MOVE = 24;      // m of travel before the shade map is redrawn
const SHADE_CAP = 9000;     // crowns in the map
const BINS = 128;

const _m = new THREE.Matrix4(), _c = new THREE.Color();

/** What a quality tier buys: metres of full models, and how many of them. */
export function treeQuality(settings) {
  // The detail radius rides the tier's own "how far is detail drawn" number
  // (buildingR: 80 / 160 / 280 on low / medium / high) rather than a knob of
  // its own: a third of it is 27, 54 and 95 m of real trees.
  const r = Math.max(24, Math.min(96, (settings?.buildingR ?? 160) * 0.34));
  return { radius: r, cap: Math.round(r * r * 0.068) };   // 50, 201, 616
}

export class Trees {
  constructor(scene, world, renderer) {
    this.scene = scene; this.world = world; this.renderer = renderer;
    this.root = new THREE.Group();
    this.root.name = 'trees-near';
    scene.add(this.root);
    this.mat = nearTreeMaterial();
    this.uniforms = TREE_U;           // one set for every tree program: see treeshader.js
    this.depthNear = treeDepthMaterial('near');
    this.depthCrown = treeDepthMaterial('crown');
    this.depthTrunk = treeDepthMaterial('trunk');
    this.pools = new Map();           // species * 2 + variant → InstancedMesh
    this.info = new WeakMap();        // chunk group → { crown, trunk, fold } | null
    this.radius = 58; this.cap = 240;
    this.rNow = 0;                    // the radius the shader is using
    this.count = 0;                   // near models drawn after the last rebuild
    this._at = new THREE.Vector2(1e9, 1e9);
    this._age = 0; this._sig = -1;
    this._bins = new Uint16Array(BINS);
    this._near = [];
    this._shade = null;
    this._shadeAt = new THREE.Vector2(1e9, 1e9);
    this._shadeAge = 0; this._shadeSig = -1;
    this._shadeOut = { densTex: null, metaTex: null, cx: 0, cz: 0, size: SHADE_SIZE, strength: 0.6 };
    this._shadeOn = false;
  }

  setQuality(settings) {
    const q = treeQuality(settings);
    if (q.radius === this.radius && q.cap === this.cap) return;
    this.radius = q.radius; this.cap = q.cap;
    for (const p of this.pools.values()) { this.root.remove(p); p.geometry.dispose(); p.dispose(); }
    this.pools.clear();
    this._at.set(1e9, 1e9);
  }

  /** The tree batches of a chunk group, found once and remembered. */
  _treesOf(group) {
    let t = this.info.get(group);
    if (t !== undefined) return t;
    const mats = this.world.mats;
    let crown = null, trunk = null;
    for (const o of group.children) {
      if (!o.isInstancedMesh) continue;
      if (o.material === mats.crown) crown = o; else if (o.material === mats.trunk) trunk = o;
    }
    t = null;
    if (crown && crown.instanceColor) {
      // A chunk built in the worker arrives with its template quantised into
      // [-1, 1] and the scale that undoes it multiplied into every instance
      // matrix. Dividing the template's real extent by the one it has now gives
      // that factor back, and a chunk built on the main thread reads 1.
      const p = crown.geometry.getAttribute('position');
      let ext = 0;
      for (let i = 0; i < p.count; i++) ext = Math.max(ext, Math.abs(p.getX(i)), Math.abs(p.getY(i)), Math.abs(p.getZ(i)));
      t = { crown, trunk, fold: ext > 0 ? farCrownExtent() / ext : 1 };
      // the far tier must drop out of the shadow map where the near one stands
      crown.customDepthMaterial = this.depthCrown;
      if (trunk) trunk.customDepthMaterial = this.depthTrunk;
    }
    this.info.set(group, t);
    return t;
  }

  _pool(key) {
    let p = this.pools.get(key);
    if (p !== undefined) return p;
    const geo = nearModel(key >> 1, key & 1);
    if (!geo) { this.pools.set(key, null); return null; }
    // every pool can hold the whole budget: a spruce wood is all one species
    const size = this.cap + 16;
    p = new THREE.InstancedMesh(geo, this.mat, size);
    p.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(size * 3), 3);
    p.count = 0;
    // instances are placed round the camera, never round the mesh's own origin
    p.frustumCulled = false;
    p.castShadow = p.receiveShadow = true;
    p.customDepthMaterial = this.depthNear;
    this.root.add(p);
    this.pools.set(key, p);
    return p;
  }

  /**
   * Once a frame. `camera` is the game camera; `nightK` 0 by day, 1 at night.
   * Returns nothing: the shader uniforms and the pools are the result.
   */
  update(camera, dt, nightK = 0) {
    TREE_U.uTreeWind.value.x = worldPhase(512);
    const ex = camera.position.x, ez = camera.position.z;
    // from a helicopter no tree is near: skip the whole tier
    // (the bare terrain: this runs every frame and needs no kerbs or bridges)
    const high = camera.position.y - this.world.terrain.heightAt(ex, ez) > this.radius + 30;
    this._age += dt; this._shadeAge += dt;
    if (high) {
      if (this.count) { for (const p of this.pools.values()) if (p) { p.count = 0; p.visible = false; } this.count = 0; }
      this.rNow = 0; this._at.set(1e9, 1e9);
    } else if (Math.hypot(ex - this._at.x, ez - this._at.y) > MOVE || this._age > 0.35) {
      this._rebuild(ex, ez);
    }
    const u = TREE_U.uTreeNear.value;
    u.set(ex, ez, this.rNow * BAND, this.rNow);
    if (this._shadeOn && (Math.hypot(ex - this._shadeAt.x, ez - this._shadeAt.y) > SHADE_MOVE || this._shadeAge > 0.6)) {
      this._drawShade(ex, ez);
    }
    this._shadeOut.strength = 0.6 * (1 - 0.4 * nightK);
  }

  _rebuild(ex, ez) {
    const R = this.radius + MOVE + 1, bins = this._bins, near = this._near;
    // -- 1: which chunks are in reach, and has anything changed ---------------
    near.length = 0;
    let sig = 0;
    for (const group of this.world.built.values()) {
      if (!group) continue;
      const gx = group.position.x, gz = group.position.z;
      if (Math.abs(gx - ex) > CHUNK_HALF + R + 8 || Math.abs(gz - ez) > CHUNK_HALF + R + 8) continue;
      const t = this._treesOf(group);
      if (!t) continue;
      near.push(group);
      sig = (sig * 31 + t.crown.id + t.crown.count) | 0;
    }
    // nothing moved and no chunk changed: the pools are still right
    if (sig === this._sig && Math.hypot(ex - this._at.x, ez - this._at.y) <= MOVE) { this._age = 0; return; }
    this._sig = sig; this._age = 0; this._at.set(ex, ez);
    bins.fill(0);
    for (const group of near) {
      const t = this.info.get(group), gx = group.position.x, gz = group.position.z;
      const a = t.crown.instanceMatrix.array, n = t.crown.count;
      const ca = t.crown.instanceColor.array, f = ca instanceof Float32Array ? 255 : 1;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(gx + a[i * 16 + 12] - ex, gz + a[i * 16 + 14] - ez);
        if (d >= R) continue;
        // a shrub never becomes a model, so it must not spend the budget either:
        // a planted roundabout would otherwise pull the radius in round itself
        if (tagSpecies(Math.round(ca[i * 3] * f), Math.round(ca[i * 3 + 2] * f)) === SP.SHRUB) continue;
        bins[Math.min(BINS - 1, Math.floor(d / R * BINS))]++;
      }
    }
    // -- 2: the radius the budget can afford ---------------------------------
    let reach = R, sum = 0;
    for (let b = 0; b < BINS; b++) {
      sum += bins[b];
      if (sum > this.cap) { reach = b / BINS * R; break; }
    }
    this.rNow = Math.max(0, Math.min(this.radius, reach - MOVE - 1));
    // -- 3: fill the pools ----------------------------------------------------
    for (const p of this.pools.values()) if (p) p.count = 0;
    // the pools hang from a point near the camera so their matrices stay small
    // numbers: at 100 km from the origin a float32 metre is 8 mm wide
    const ax = Math.round(ex / 16) * 16, az = Math.round(ez / 16) * 16;
    this.root.position.set(ax, 0, az);
    this.root.updateMatrixWorld(true);
    let total = 0;
    for (const group of near) {
      const t = this.info.get(group), gx = group.position.x, gy = group.position.y, gz = group.position.z;
      const a = t.crown.instanceMatrix.array, n = t.crown.count, k = 1 / t.fold;
      const col = t.crown.instanceColor, ca = col.array, bytes = !(ca instanceof Float32Array);
      for (let i = 0; i < n; i++) {
        const o = i * 16;
        if (Math.hypot(gx + a[o + 12] - ex, gz + a[o + 14] - ez) >= reach) continue;
        const r8 = bytes ? ca[i * 3] : Math.round(ca[i * 3] * 255), g8 = bytes ? ca[i * 3 + 1] : Math.round(ca[i * 3 + 1] * 255),
          b8 = bytes ? ca[i * 3 + 2] : Math.round(ca[i * 3 + 2] * 255);
        const sp = tagSpecies(r8, b8);
        if (sp === SP.SHRUB) continue;
        const p = this._pool(sp * 2 + tagVariant(g8));
        if (!p || p.count >= p.instanceMatrix.count) continue;
        const e = _m.elements;
        for (let j = 0; j < 12; j++) e[j] = a[o + j] * k;
        e[3] = e[7] = e[11] = 0;
        e[12] = gx + a[o + 12] - ax; e[13] = gy + a[o + 13]; e[14] = gz + a[o + 14] - az; e[15] = 1;
        const at = p.count++;
        p.setMatrixAt(at, _m);
        p.setColorAt(at, _c.setRGB(r8 / 255, g8 / 255, b8 / 255));
        total++;
      }
    }
    for (const p of this.pools.values()) {
      if (!p) continue;
      p.visible = p.count > 0;
      if (p.count) { p.instanceMatrix.needsUpdate = true; p.instanceColor.needsUpdate = true; }
    }
    this.count = total;
  }

  // ---- the shade map --------------------------------------------------------
  _initShade() {
    const quad = new THREE.InstancedBufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    quad.setIndex([0, 1, 2, 0, 2, 3]);
    const disc = new THREE.InstancedBufferAttribute(new Float32Array(SHADE_CAP * 4), 4);
    const top = new THREE.InstancedBufferAttribute(new Float32Array(SHADE_CAP), 1);
    disc.setUsage(THREE.DynamicDrawUsage); top.setUsage(THREE.DynamicDrawUsage);
    quad.setAttribute('aDisc', disc); quad.setAttribute('aTop', top);
    quad.instanceCount = 0;
    const uMap = { value: new THREE.Vector3() };
    const vert = /* glsl */`
      attribute vec4 aDisc;   // x, z, radius, ground height
      attribute float aTop;   // crown top over the ground
      uniform vec3 uMap;      // centre x, z and 2 / size
      varying vec2 vC; varying vec2 vH;
      void main() {
        vC = position.xy; vH = vec2( aDisc.w, aTop );
        gl_Position = vec4( ( aDisc.xy + position.xy * aDisc.z - uMap.xy ) * uMap.z, 0.0, 1.0 );
      }`;
    // R of the first map is the light LEFT under the crowns: each disc
    // multiplies what is there, so two crowns over one spot are darker than one
    const dens = new THREE.ShaderMaterial({ uniforms: { uMap }, vertexShader: vert,
      fragmentShader: /* glsl */`
        varying vec2 vC; varying vec2 vH;
        void main() {
          float a = 1.0 - smoothstep( 0.2, 1.0, length( vC ) );
          gl_FragColor = vec4( vec3( 1.0 - 0.55 * a ), 1.0 );
        }`,
      depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendSrc: THREE.DstColorFactor, blendDst: THREE.ZeroFactor });
    // the second holds the ground height and how tall the crowns over it stand,
    // in the encoding postfx.js canopyShade() reads (a half-float target, so the
    // 220 m of Pardubice is not clamped at 1)
    const meta = new THREE.ShaderMaterial({ uniforms: { uMap }, vertexShader: vert,
      fragmentShader: /* glsl */`
        varying vec2 vC; varying vec2 vH;
        void main() {
          if ( length( vC ) > 1.0 ) discard;
          gl_FragColor = vec4( ( vH.x + 16.0 ) / 176.0, vH.y / 32.0, 0.0, 1.0 );
        }`,
      depthTest: false, depthWrite: false, blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor });
    const mesh = new THREE.Mesh(quad, dens);
    mesh.frustumCulled = false;
    const scene = new THREE.Scene();
    scene.add(mesh);
    const opt = { depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    const rtDens = new THREE.WebGLRenderTarget(SHADE_PX, SHADE_PX, { ...opt,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const rtMeta = new THREE.WebGLRenderTarget(SHADE_PX, SHADE_PX, { ...opt, type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this._shade = { quad, disc, top, uMap, dens, meta, mesh, scene, rtDens, rtMeta,
      cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), clear: new THREE.Color() };
    this._shadeOut.densTex = rtDens.texture; this._shadeOut.metaTex = rtMeta.texture;
  }

  _drawShade(ex, ez) {
    if (!this._shade) this._initShade();
    const S = this._shade, half = SHADE_SIZE / 2, d = S.disc.array, tp = S.top.array, near = this._near;
    // which chunks reach into the map, and is it the same set as last time
    near.length = 0;
    let sig = 0;
    for (const group of this.world.built.values()) {
      if (!group) continue;
      if (Math.abs(group.position.x - ex) > CHUNK_HALF + half + 10 || Math.abs(group.position.z - ez) > CHUNK_HALF + half + 10) continue;
      const t = this._treesOf(group);
      if (!t) continue;
      near.push(group);
      sig = (sig * 31 + t.crown.id + t.crown.count) | 0;
    }
    this._shadeAge = 0;
    if (sig === this._shadeSig && Math.hypot(ex - this._shadeAt.x, ez - this._shadeAt.y) <= SHADE_MOVE) return;
    this._shadeSig = sig; this._shadeAt.set(ex, ez);
    let n = 0;
    for (const group of near) {
      const t = this.info.get(group), gx = group.position.x, gy = group.position.y, gz = group.position.z;
      const a = t.crown.instanceMatrix.array, cnt = t.crown.count, k = 1 / t.fold;
      const ca = t.crown.instanceColor.array, bytes = !(ca instanceof Float32Array);
      for (let i = 0; i < cnt && n < SHADE_CAP; i++) {
        const o = i * 16, x = gx + a[o + 12], z = gz + a[o + 14];
        if (Math.abs(x - ex) > half + 8 || Math.abs(z - ez) > half + 8) continue;
        const rx = Math.hypot(a[o], a[o + 1], a[o + 2]) * k, ry = Math.hypot(a[o + 4], a[o + 5], a[o + 6]) * k;
        const r8 = bytes ? ca[i * 3] : Math.round(ca[i * 3] * 255), b8 = bytes ? ca[i * 3 + 2] : Math.round(ca[i * 3 + 2] * 255);
        const G = groundOf(tagSpecies(r8, b8));
        d[n * 4] = x; d[n * 4 + 1] = z; d[n * 4 + 2] = rx * 1.2; d[n * 4 + 3] = gy + a[o + 13] - ry * G;
        // NOT the tree's top: the composite shades at full strength up to half
        // of this height and lets go above it, and what must stay bright is the
        // crown itself. So this is where the crown STARTS: the ground, a car and
        // the foot of the trunk take the shade, the leaves keep their light.
        tp[n] = Math.max(1.4, ry * (G - 1) * 1.15);
        n++;
      }
    }
    S.quad.instanceCount = n;
    S.disc.needsUpdate = true; S.top.needsUpdate = true;
    S.uMap.value.set(ex, ez, 2 / SHADE_SIZE);
    this._shadeOut.cx = ex; this._shadeOut.cz = ez;
    const r = this.renderer, was = r.getRenderTarget(), auto = r.autoClear, alpha = r.getClearAlpha();
    r.getClearColor(S.clear);
    r.autoClear = true;
    r.setClearColor(0xffffff, 1); S.mesh.material = S.dens;
    r.setRenderTarget(S.rtDens); r.render(S.scene, S.cam);
    r.setClearColor(0x000000, 0); S.mesh.material = S.meta;
    r.setRenderTarget(S.rtMeta); r.render(S.scene, S.cam);
    r.setRenderTarget(was); r.setClearColor(S.clear, alpha); r.autoClear = auto;
  }

  /**
   * The `canopy` option of postfx.render: the shade map, or null before the
   * first one is drawn. Asking for it is what turns the map on, so a preset
   * that never runs the post stack never pays for it.
   */
  shade() {
    this._shadeOn = true;
    return this._shadeOut.densTex ? this._shadeOut : null;
  }
}
