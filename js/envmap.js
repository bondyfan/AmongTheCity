// ---- envmap.js: the sky, baked into scene.environment ----------------------
// The ground has been a PBR material for a while (surfaces.js: roughness and
// normal maps per surface class) with nothing to reflect: no environment, so
// roughness only ever shaped the sun's one highlight. This module gives every
// MeshStandardMaterial / MeshPhysicalMaterial in the scene the sky to reflect.
//
// HOW. The dome's own shader (sky.js, compiled with ATC_ENV) is drawn into a
// small cube from the inside, and three's PMREMGenerator prefilters that cube
// into the mip chain a rough surface samples. The result is assigned to
// scene.environment ONCE; after that the same texture is refreshed in place.
//
// WHEN. Not per frame. sky.js calls update() every frame, and it re-bakes only
// when the sun has moved 2.5°, the night level has changed by 3 %, the painted
// cloud amount or the gain has changed, and never more often than once in
// 0.6 s. At the game's clock that is one bake every ten seconds or so by day
// and a few in a row through dusk. A bake is six 128 px faces of the dome
// shader and about twenty tiny blur quads: no allocation of GPU memory (both
// targets are created once and reused), 0.2 ms measured.
//
// ---- THE CONTRACT FOR MATERIALS (read this if you are making a car shiny) --
//
//   * Use MeshStandardMaterial or MeshPhysicalMaterial and leave `envMap`
//     unset. three hands scene.environment to those two and to nothing else:
//     MeshLambertMaterial, MeshPhongMaterial and MeshBasicMaterial ignore it.
//   * The environment is SPECULAR ONLY. Its diffuse (irradiance) term is
//     switched off for the whole scene, below. Diffuse sky light keeps coming
//     from the one HemisphereLight in sky.js, for Standard and Lambert alike.
//     That is what keeps a PBR road and the Lambert kerb beside it at the same
//     brightness, and it is why adding the environment did not double-light
//     the ground. Consequence: `metalness: 1` with no direct light on it shows
//     ONLY reflections, which is what chrome should do.
//   * Per material: `material.envMapIntensity` (default 1). It is an ordinary
//     uniform, so changing it costs nothing. Glass and chrome can run 1.0 to
//     1.4; paint under a clearcoat 0.8 to 1.0; anything matte, leave it.
//   * For the whole scene: `sky.env.gain` (default 1). r160 has no
//     scene.environmentIntensity, so the global scale is baked into the map
//     itself on the next refresh. Set it and it takes effect within a second.
//   * The map holds the sky above the horizon and a flat ground tone below it
//     (street albedo times the light of the moment). It does not hold the
//     city: a car door will not show the building opposite.
//   * `sky.env.texture` is the PMREM texture (CubeUV layout) for a shader that
//     wants to sample it by hand; bindWater() shows how.

import * as THREE from 'three';

// Diffuse image-based light off, for every material, before any compiles. The
// constant folds the whole irradiance lookup away, so this also saves the two
// texture fetches it would have cost per fragment.
THREE.ShaderChunk.envmap_physical_pars_fragment =
  THREE.ShaderChunk.envmap_physical_pars_fragment.replace(
    'return PI * envMapColor.rgb * envMapIntensity;',
    'return PI * envMapColor.rgb * envMapIntensity * 0.0;');

const FACE = 128;                 // px per cube face
const COS_STEP = Math.cos(2.5 * Math.PI / 180);
const MIN_GAP_MS = 600;

export class SkyEnv {
  /**
   * `domeMat` is the ATC_ENV twin of the sky dome's material. It shares the
   * dome's uniform holders, so there is nothing to copy before a bake.
   */
  constructor(renderer, scene, domeMat) {
    this.renderer = renderer;
    this.scene = scene;
    this.gain = 1;                // global reflection scale, see the header
    this.bakes = 0;               // how many times it has baked (for the curious)
    this._mat = domeMat;
    this._cube = new THREE.WebGLCubeRenderTarget(FACE, { type: THREE.HalfFloatType });
    this._cam = new THREE.CubeCamera(1, 100, this._cube);
    this._capScene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(45, 24, 16), domeMat);
    mesh.frustumCulled = false;
    this._capScene.add(mesh);
    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._rt = null;              // the prefiltered target, made on the first bake
    this._dir = new THREE.Vector3(0, -2, 0);   // impossible: forces the first bake
    this._night = -1; this._cloud = -1; this._gain = -1; this._at = -1e9;
    this._waterBound = null;
  }

  /** The PMREM texture, or null before the first bake. */
  get texture() { return this._rt ? this._rt.texture : null; }

  /** Every frame from sky.js. Bakes only when the sky has actually changed. */
  update(sunDir, nightK, cloudAmt, nowMs) {
    if (nowMs - this._at < MIN_GAP_MS) return;
    const changed = this._dir.dot(sunDir) < COS_STEP
      || Math.abs(nightK - this._night) > 0.03
      || Math.abs(cloudAmt - this._cloud) > 0.02
      || this.gain !== this._gain;
    if (!changed) return;
    this._dir.copy(sunDir); this._night = nightK; this._cloud = cloudAmt;
    this._gain = this.gain; this._at = nowMs;
    this.bake();
  }

  bake() {
    const r = this.renderer;
    this._mat.uniforms.uEnvGain.value = this.gain;
    // the cube camera saves and restores the renderer's target itself; the
    // capture scene holds no lights, so the shadow pass has nothing to do
    this._cam.update(r, this._capScene);
    // First bake: let the generator allocate its targets. Every later bake is
    // handed the same target back, so nothing is created again.
    this._rt = this._pmrem.fromCubemap(this._cube.texture, this._rt);
    if (this.scene.environment !== this._rt.texture) this.scene.environment = this._rt.texture;
    this.bakes++;
  }

  /**
   * Let a hand-written ShaderMaterial sample the same map. The material must
   * declare `uniform sampler2D envMap;` and include cube_uv_reflection_fragment
   * under `#ifdef ENVMAP_TYPE_CUBE_UV`; this supplies the texture and the three
   * defines that chunk needs, once, the first time a map exists. The water
   * (meshes.js makeWaterMaterial) is the one user today.
   */
  bindWater(mat) {
    const tex = this.texture;
    if (!tex || !mat || this._waterBound === mat) return;
    if (!mat.uniforms.envMap) return;      // an older water shader: leave it be
    const size = FACE;
    mat.defines = {
      ...(mat.defines || {}),
      ENVMAP_TYPE_CUBE_UV: '',
      CUBEUV_TEXEL_WIDTH: (1 / (3 * Math.max(size, 16 * 7))).toFixed(8),
      CUBEUV_TEXEL_HEIGHT: (1 / (4 * size)).toFixed(8),
      CUBEUV_MAX_MIP: Math.log2(size).toFixed(1),
    };
    mat.uniforms.envMap.value = tex;
    mat.needsUpdate = true;
    this._waterBound = mat;
  }

  dispose() {
    this._cube.dispose();
    this._rt?.dispose();
    this._pmrem.dispose();
  }
}
