// ---- The Indian Ocean round Mahé ----
// The Czech world has rivers and ponds, each a polygon sunk between its banks
// (js/meshes.js makeWaterMaterial). An island has the opposite problem: the
// water is everything that is NOT land, out to the horizon, and its colour is
// the whole postcard. Turquoise over the sand of the lagoon, the white line of
// the reef where the swell breaks, ink blue beyond it.
//
// So the sea is ONE surface at sea level that follows the camera, and its
// colour is read from the lagoon map scripts/mahe/ground.mjs bakes from the
// coastline and the reef: two bytes per 20 m, the depth in decimetres (land
// reads 0) and the reef crest. The terrain under it is the seabed the same
// script made, so where the map says shallow, the ground really is just under
// the surface, and the beach rises out of the water where the coast is.
//
// It is the same light model as the rivers (sun glint, fresnel against the
// sky, darkness from sky.nightK), fed by main.js from the same two numbers.
// One draw call, no per-frame allocation.

import * as THREE from 'three';
import { dataUrl } from '../regions.js';

const SIZE = 60000;          // m across: past the camera's far plane in every direction
const SNAP = 200;            // m: the plane moves in steps, so its UV grid never swims

export class Sea {
  constructor(scene) {
    this.uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
      uTime: { value: 0 },
      uSun: { value: new THREE.Vector3(0.3, 0.9, 0.2) },
      uNight: { value: 0 },
      uSky: { value: new THREE.Color(0x9fc4dc) },
      uMap: { value: null },
      uBox: { value: new THREE.Vector4(0, 0, 1, 1) },   // x0, z0, width, height (m)
      uHas: { value: 0 },
    }]);
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, fog: true,
      // the ocean runs to the horizon: it must not take part in the streamed
      // window's edge dissolve (js/heightfog.js), or past the built radius the
      // sea vanished and the far landscape's seabed showed through as land
      defines: { ATC_NO_EDGE: '' },
      // a hair toward the camera: the beach shelf is 30 cm under the surface,
      // which at a kilometre is inside one depth step without it
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
      vertexShader: SEA_VERT, fragmentShader: SEA_FRAG,
    });
    const geo = new THREE.PlaneGeometry(SIZE, SIZE, 1, 1);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;     // opaque, before the shore's alpha bits
    this.mesh.name = 'sea';
    scene.add(this.mesh);
    this._load();
  }

  async _load() {
    try {
      const meta = await (await fetch(dataUrl('sea.json'))).json();
      const buf = await (await fetch(dataUrl('sea.bin'))).arrayBuffer();
      // two channels: depth in decimetres, and the reef crest (scripts/mahe/ground.mjs)
      const tex = new THREE.DataTexture(new Uint8Array(buf, 0, meta.w * meta.h * 2), meta.w, meta.h,
        THREE.RGFormat, THREE.UnsignedByteType);
      tex.magFilter = THREE.LinearFilter; tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      this.uniforms.uMap.value = tex;
      this.uniforms.uBox.value.set(meta.x0 - meta.res / 2, meta.z0 - meta.res / 2, meta.w * meta.res, meta.h * meta.res);
      this.uniforms.uHas.value = 1;
    } catch (err) {
      // no lagoon map (the stand-in Mahé has none): open sea everywhere
      console.warn('[sea] lagoon map unavailable:', err.message);
    }
  }

  /** Per frame: follow the eye, and take the sky's sun and darkness. */
  update(dt, eye, sky, fog) {
    const u = this.uniforms;
    u.uTime.value += dt;
    this.mesh.position.set(Math.round(eye.x / SNAP) * SNAP, 0, Math.round(eye.z / SNAP) * SNAP);
    if (sky?.sunDir) u.uSun.value.copy(sky.sunDir);
    u.uNight.value = sky?.nightK ?? 0;
    if (fog) u.uSky.value.copy(fog.color);
  }

  dispose() {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.uniforms.uMap.value?.dispose();
  }
}

const SEA_VERT = /* glsl */`
  varying vec3 vWorld;
  #include <fog_pars_vertex>
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;

const SEA_FRAG = /* glsl */`
  uniform float uTime;
  uniform vec3 uSun;
  uniform float uNight;
  uniform vec3 uSky;
  uniform sampler2D uMap;
  uniform vec4 uBox;
  uniform float uHas;
  varying vec3 vWorld;
  #include <fog_pars_fragment>

  // the lagoon map: depth in metres (0..25), reef crest, land
  void lagoon(vec2 xz, out float depth, out float reef, out float land) {
    vec2 uv = (xz - uBox.xy) / uBox.zw;
    if (uHas < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) {
      depth = 40.0; reef = 0.0; land = 0.0; return;
    }
    vec2 t = texture2D(uMap, uv).rg;
    land = 0.0;                       // the terrain covers the land; the map's land is depth 0
    reef = smoothstep(0.3, 0.8, t.g);
    depth = mix(t.r * 25.5, 0.4, reef);
  }

  // swell from the south-east trades, plus the chop on top of it
  vec3 waveNormal(vec2 p, float t, float calm) {
    float a = dot(p, vec2(0.021, -0.017)) - t * 0.9;
    float b = dot(p, vec2(-0.043, -0.031)) - t * 1.4;
    float c = dot(p, vec2(0.17, 0.11)) + t * 2.3;
    float d = dot(p, vec2(-0.13, 0.21)) - t * 2.9;
    vec2 s = vec2(0.021, -0.017) * cos(a) * 0.9 + vec2(-0.043, -0.031) * cos(b) * 0.5
           + (vec2(0.17, 0.11) * cos(c) + vec2(-0.13, 0.21) * cos(d)) * 0.05;
    return normalize(vec3(-s.x * calm, 1.0, -s.y * calm));
  }

  void main() {
    float depth, reef, land;
    lagoon(vWorld.xz, depth, reef, land);
    // inside the reef the water lies still; outside, the swell runs
    float calm = mix(0.35, 1.0, smoothstep(2.0, 12.0, depth));
    vec3 n = waveNormal(vWorld.xz, uTime, calm);
    vec3 viewDir = normalize(cameraPosition - vWorld);
    float day = 1.0 - uNight;

    // colour of the water column: sand showing through, turquoise, teal, ink
    vec3 sand = vec3(0.36, 0.80, 0.74), turq = vec3(0.06, 0.62, 0.66);
    vec3 teal = vec3(0.03, 0.38, 0.52), deep = vec3(0.02, 0.13, 0.30);
    vec3 col = mix(sand, turq, smoothstep(0.25, 1.4, depth));
    col = mix(col, teal, smoothstep(2.0, 7.0, depth));
    col = mix(col, deep, smoothstep(9.0, 30.0, depth));
    // the coral heads of the reef flat: darker patches through the shallows
    float coral = fract(sin(dot(floor(vWorld.xz / 6.0), vec2(12.9898, 78.233))) * 43758.5453);
    col = mix(col, vec3(0.20, 0.36, 0.30), reef * 0.35 * step(0.55, coral));
    col *= 0.10 + 0.90 * day;

    // the sky in the water, and the sun on it
    float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
    col = mix(col, uSky * (0.25 + 0.75 * day), clamp(0.03 + fresnel * 0.75, 0.0, 0.7));
    vec3 halfDir = normalize(normalize(uSun) + viewDir);
    float sunUp = smoothstep(-0.05, 0.08, uSun.y);
    col += vec3(1.0, 0.95, 0.85) * pow(max(dot(n, halfDir), 0.0), 220.0) * 1.6 * sunUp * day;

    // white water: the swell breaking on the reef, and the wash on the beach
    float t = uTime;
    float breakers = reef * (0.55 + 0.45 * sin(dot(vWorld.xz, vec2(0.11, 0.07)) - t * 1.7));
    // (only the last few metres: the beach shelf is 3 cm deeper a metre out)
    float wash = smoothstep(0.42, 0.30, depth) * (1.0 - land) * (0.5 + 0.5 * sin(depth * 60.0 - t * 1.2));
    vec3 foam = vec3(0.92, 0.95, 0.95) * (0.12 + 0.88 * day);
    col = mix(col, foam, clamp(breakers * 0.75 + wash * 0.35, 0.0, 0.85));

    gl_FragColor = vec4(col, 1.0);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }`;
