// ---- carpaint.js: what the cars are made of --------------------------------
// Five shared materials dress every vehicle in the city:
//
//   paint   MeshPhysicalMaterial, one per colour: a base coat (metallic flake
//           for the dark German metal, solid for fleet white and bright reds)
//           under a clearcoat, which is the two-layer highlight that makes
//           paint read as paint instead of as coloured plastic
//   glass   near-black, mirror smooth, reflections boosted: a window is told
//           apart from a black panel by the sky in it
//   detail  ONE vertex-coloured standard material for everything of a fixed
//           colour (bumper plastic, chrome, lamp housings, tyres, rims, liners).
//           Roughness and metalness ride a per-vertex `pbr` attribute, so chrome
//           and rubber share a draw call
//   head / tail   the lamps, still the two objects main.js drives at dusk. A
//           per-vertex `gate` says how much of an element is a NIGHT lamp: the
//           running strip burns all day, the projectors and the tail clusters
//           only come up with carNight()
//
// Reflections come from scene.environment when the game sets one. When it does
// not (the low preset, or a build without the lighting package) the same
// shaders fall back to an analytic sky: three colours and a smoothstep, enough
// for a bonnet to carry a horizon line. Nothing here sets material.envMap.

import * as THREE from 'three';
import { lampDirectPatch } from './lampmap.js';

const lin = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };

// shared by every patched program: one write reaches the whole fleet
const U = {
  uCarNight: { value: 0 },
  uCarSky: { value: [lin(0x3f76c4), lin(0xb4c4d6), lin(0x4a4c50)] },   // zenith, horizon, ground
};
const SKY_DAY = [lin(0x3f76c4), lin(0xb4c4d6), lin(0x4a4c50)];
const SKY_NIGHT = [lin(0x04060a), lin(0x0c1017), lin(0x050506)];

// carNight(k): k is the sky's own darkness, 0 at noon and 1 at midnight. Called
// once a frame from main.js updateNightLights, next to the lampMats lines.
export function carNight(k) {
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  // lamps come on a little before full dark, the way drivers switch them
  const n = Math.min(1, Math.max(0, (k - 0.18) / 0.35));
  U.uCarNight.value = n * n * (3 - 2 * n);
  const s = U.uCarSky.value;
  for (let i = 0; i < 3; i++) s[i].copy(SKY_DAY[i]).lerp(SKY_NIGHT[i], k);
}
// how far the lamps are up, 0..1
export const lampsOn = () => U.uCarNight.value;

const SKY_GLSL = /* glsl */`
  uniform vec3 uCarSky[3];
  vec3 carSky(vec3 d, float rough) {
    float soft = 0.03 + rough * 0.9;
    vec3 sky = mix(uCarSky[1], uCarSky[0], pow(clamp(d.y, 0.0, 1.0), 0.6));
    return mix(uCarSky[2], sky, smoothstep(-soft, soft, d.y));
  }`;

// Patch a standard/physical material: analytic sky when there is no envMap,
// and (opt.pbr) roughness/metalness from the `pbr` vertex attribute. Every
// patched material also reads the street-light maps on the direct path (the
// low preset), where no composite lights a car under a lamp: js/lampmap.js.
function patch(mat, opt = {}) {
  const k = opt.envK ?? 1;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uCarSky = U.uCarSky;
    if (opt.pbr) {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 pbr;\nvarying vec2 vPbr;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPbr = pbr;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPbr;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = vPbr.x;')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = vPbr.y;');
    }
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + SKY_GLSL)
      .replace('#include <lights_fragment_maps>', /* glsl */`#include <lights_fragment_maps>
        #ifndef USE_ENVMAP
        {
          vec3 cr = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
          radiance += carSky(cr, material.roughness) * ${k.toFixed(3)};
          #ifdef USE_CLEARCOAT
            vec3 cc = inverseTransformDirection(reflect(-geometryViewDir, geometryClearcoatNormal), viewMatrix);
            clearcoatRadiance += carSky(cc, material.clearcoatRoughness);
          #endif
        }
        #endif`);
    lampDirectPatch(sh);
  };
  mat.customProgramCacheKey = () => 'car-lamp|' + (opt.pbr ? 'p' : '') + '|' + k;
  return mat;
}

// ---- paint -----------------------------------------------------------------
const _paint = new Map();
const _hsl = { h: 0, s: 0, l: 0 };
export function paintMatFor(hex) {
  let m = _paint.get(hex);
  if (m) return m;
  new THREE.Color(hex).getHSL(_hsl);
  // Whites, creams and saturated brights are solid paint; everything dark or
  // grey carries flake. Metalness stays modest on purpose: with no environment
  // at all a metal has no diffuse to fall back on and the car goes black.
  const solid = _hsl.l > 0.70 || (_hsl.s > 0.5 && _hsl.l > 0.32);
  m = new THREE.MeshPhysicalMaterial({
    color: hex,
    metalness: solid ? 0.0 : 0.42,
    roughness: solid ? 0.55 : 0.46,
    clearcoat: 1.0,
    // 0.10, not mirror-sharp: at 0.06 the sun's glint in the lacquer peaked so
    // far above white that the bloom pass turned every roof into a flare
    clearcoatRoughness: 0.10,
  });
  patch(m);
  _paint.set(hex, m);
  return m;
}

// ---- glass, detail ---------------------------------------------------------
// polygonOffset ladders the draped layers: glass and trim over paint,
// lamps over their housings, decals over everything. The geometric lift does
// the work up close; the offset is what keeps it true at 60 m, where a 24-bit
// depth buffer with a 0.1 m near plane resolves about 2 mm.
// Glass and trim share ONE rung. Every pane sits 4 mm above a gloss-black
// surround that is trim, so a trim rung above the glass's pulled that surround
// through the windscreen in blocks whenever the glass was seen at a slant.
// Between these two the geometric lift alone decides, and it is always right.
export const glassMat = patch(new THREE.MeshStandardMaterial({
  color: 0x0a0e13, roughness: 0.045, metalness: 0.0, envMapIntensity: 2.4,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
}), { envK: 2.4 });

export const detailMat = patch(new THREE.MeshStandardMaterial({
  vertexColors: true, roughness: 0.5, metalness: 0.0,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
}), { pbr: true });

// ---- lamps -----------------------------------------------------------------
function lamp(params) {
  const m = new THREE.MeshLambertMaterial({ ...params, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uCarNight = U.uCarNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float gate;\nvarying float vGate;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGate = gate;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uCarNight;\nvarying float vGate;')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= mix(1.0, uCarNight, vGate);');
  };
  m.customProgramCacheKey = () => 'carlamp';
  return m;
}
// Cool white LED and a deep ruby. emissiveIntensity is main.js's to drive
// (about 1.4 by day, 6 at night); the values here only matter before it has.
export const headMat = lamp({ color: 0xc9d0d6, emissive: 0xf2f6ff, emissiveIntensity: 1.4 });
export const tailMat = lamp({ color: 0x3c0507, emissive: 0xff1c10, emissiveIntensity: 1.4 });
// Brake lights are a separate little mesh that is simply hidden until the car
// slows: a per-car uniform would cost a material per car.
export const brakeMat = new THREE.MeshBasicMaterial({
  color: new THREE.Color(0xff2a1a).multiplyScalar(4.2), toneMapped: false,
  polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
});

// ---- contact shadow --------------------------------------------------------
// The sun shadow stops 90 m out and the low preset has none at all, and a car
// with nothing under it floats. One soft dark rounded rectangle per car, all
// of them in a single InstancedMesh: one draw call for the whole fleet.
let _blobTex = null;
function blobTexture() {
  if (_blobTex) return _blobTex;
  const N = 64, data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // rounded-box distance, normalised so the alpha dies before the quad edge
    const u = Math.abs((x + 0.5) / N * 2 - 1), v = Math.abs((y + 0.5) / N * 2 - 1);
    const qx = Math.max(0, u - 0.42), qy = Math.max(0, v - 0.55);
    const d = Math.hypot(qx / 0.58, qy / 0.45);
    const a = Math.max(0, 1 - d);
    const o = (y * N + x) * 4;
    data[o] = data[o + 1] = data[o + 2] = 0;
    data[o + 3] = Math.round(255 * a * a * (3 - 2 * a));
  }
  _blobTex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  _blobTex.magFilter = _blobTex.minFilter = THREE.LinearFilter;
  _blobTex.needsUpdate = true;
  return _blobTex;
}
// (Headlight light on the road is js/lightpools.js: one fan per car, baked into
// the lamp map on the post path. The additive quad this module used to lay
// under every AI car doubled it and is gone.)

export function makeContactShadows(capacity = 256) {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);                 // flat on the road, facing up
  const mat = new THREE.MeshBasicMaterial({
    map: blobTexture(), color: 0x000000, transparent: true, opacity: 0.62,
    depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, capacity);
  mesh.count = 0;
  mesh.frustumCulled = false;                // instances are all over the city
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.renderOrder = -1;                     // under every other transparent thing
  mesh.userData.capacity = capacity;
  return mesh;
}
