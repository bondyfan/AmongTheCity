// ---- carbodymat.js: one material for the whole car ---------------------------
// The geometry from carmerge.js carries, per vertex, what each part is made of.
// This is the one MeshPhysicalMaterial that reads it, so a car is a single draw:
//
//   paint   the material's own colour, roughness and metalness under a
//           clearcoat (cfx.x = 1); everywhere else the clearcoat is off
//   trim    vertex colour, roughness and metalness (chrome, rubber, piano
//           black, the wheel wells), as the old detail material had them
//   glass   near-black and mirror smooth, its reflection boosted by cpbr.z
//   lamps   a lens colour plus light: the head and tail colours times the
//           intensities main.js has always written to lampMats.head / .tail,
//           gated by the dusk for the night-only elements, and switched off
//           altogether on a car nobody is driving (uLit). The brake element
//           is lit by uBrake with lampMats.brake's colour, which
//           lightpools.js nightLevels already holds steady under the exposure
//   decals  the plate and the badge, sampled from a per-car atlas and laid
//           over the paint by their own alpha, so a round badge needs no
//           transparency and no discard (both cost more than the draw saved).
//           Where the badge is clear the paint shows through with the paint's
//           own lacquer, so a badge edge is not a matt square on the bonnet.
//
// THE CITY IN THE PAINT. scene.environment holds the sky and a flat ground
// (envmap.js) and nothing in between, so a car door reflected a clean gradient
// and read as plastic. Every reflection here goes through carCity(): a ring of
// building silhouettes standing on the horizon, hashed from the azimuth of the
// reflected ray. It is a few ALU per pixel and no texture, it is fixed in the
// world, so the skyline slides along a flank as the car turns, and after dark
// its windows are lit: the glass and the lacquer of every car pick up a city
// at night. uCity scales it (1 in town, console: atcCars.city(k)).
//
// Two variants: per car (paint from the material's own uniforms, with the
// decal atlas) and instanced (the distance dress of carinstances.js, paint
// and lamp state from the per-instance attribute iPaint, no decals).
//
// THE LOOK (js/carlook.js). A car's paint is polished, used, worn or matte and
// clean or dirty, one byte hashed off the car's identity. Per car it is the
// material's own clearcoat, roughness and metalness plus the uLook uniforms;
// in the distance dress it is the per-instance attribute iLook. The dirt and
// the leaf are drawn by js/cardirt.js in this same program: no draw is added.
//
// Every preset takes the same path. With scene.environment (medium, high) the
// IBL is the reflection and carSky stays out; without it (low) carSky stands
// in, exactly as carpaint.js does for the old materials. lampDirectPatch
// lights a car under a street lamp on the direct path (low), and is one
// uniform test on the post path. On the post path nothing is tone mapped in
// the scene pass, so the lamps' exemption from the curve only matters on low.

import * as THREE from 'three';
import { U, SKY_GLSL, headMat, tailMat, brakeMat } from './carpaint.js';
import { lampDirectPatch } from './lampmap.js';
import { GLASS_VERT_DECL, GLASS_VERT, GLASS_FRAG_DECL, glassFrag, glassUniforms } from './carglass.js';
import { lookParams, fadeRgb, ROUGH_K, METAL_LO } from './carlook.js';
import { DIRT_GLSL, dirtFrag, leafFrag, leafUniforms } from './cardirt.js';

// Shared by every body program. The lamp values are GETTERS onto the lamp
// materials main.js and lightpools.js already drive, so nothing outside this
// package had to learn about the new material.
export const BODY_U = {
  uHeadE: { get value() { return headMat.emissiveIntensity; } },
  uTailE: { get value() { return tailMat.emissiveIntensity; } },
  uHeadC: { get value() { return headMat.emissive; } },
  uTailC: { get value() { return tailMat.emissive; } },
  uBrakeC: { get value() { return brakeMat.color; } },
  uCity: { value: 1 },
};

// The solid / metallic split the old paint had: whites, creams and saturated
// brights are solid; anything dark or grey carries flake.
const _hsl = { h: 0, s: 0, l: 0 };
const _c = new THREE.Color();
export function paintFinish(hex) {
  _c.set(hex).getHSL(_hsl);
  const solid = _hsl.l > 0.70 || (_hsl.s > 0.5 && _hsl.l > 0.32);
  // rougher base under the lacquer for solids; metallics a touch smoother and
  // more metal than before, so the flake carries the sky in the clearcoat's wake
  return solid ? { metalness: 0.0, roughness: 0.5, solid } : { metalness: 0.5, roughness: 0.38, solid };
}

const CITY_GLSL = /* glsl */`
  uniform float uCity;
  float carHash(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  // 0 sky, 1 building, for a reflected world direction. Blocks are 1/48 of the
  // turn wide with a narrow street between, 4 to 21 degrees tall; rough
  // surfaces see them blurred (soft grows with roughness).
  float carCity(vec3 d, float soft) {
    if (d.y < -0.06 || d.y > 0.42) return 0.0;
    float az = (atan(d.z, d.x) + 3.14159265) * 7.6394;   // 48 cells round
    float c = floor(az), f = fract(az);
    float h = 0.07 + 0.30 * carHash(c) * carHash(c + 31.0) + 0.06 * carHash(c + 7.0);
    float gap = smoothstep(0.0, 0.04 + soft, f) * (1.0 - smoothstep(0.96 - soft, 1.0, f));
    return (1.0 - smoothstep(h - soft, h + soft, d.y)) * gap * uCity;
  }
  // lit windows on that skyline, for the night: a sparse hashed grid. Seen in
  // a curved pane or a faceted flank the reflected ray sweeps several cells a
  // pixel, and a hard 60-a-radian grid turned every rear window into
  // glitter (seen in game, 18 Nov 2026). So the grid is coarser and fades
  // out by its own screen-space footprint: where a pixel covers more than
  // about half a cell, it shows the cells' average glow instead of dots.
  float carWindows(vec3 d) {
    vec2 g = vec2((atan(d.z, d.x) + 3.14159265) * 34.0, d.y * 40.0);
    vec2 fw = fwidth(g);
    vec2 cell = floor(g), f = fract(g);
    float on = step(0.62, carHash(cell.x * 7.13 + cell.y * 91.7));
    float dots = on * step(0.3, f.x) * step(f.x, 0.75) * step(0.25, f.y) * step(f.y, 0.7);
    return mix(dots, 0.07, smoothstep(0.2, 0.55, max(fw.x, fw.y)));
  }`;

/** the look byte a body key carries ('kind|hex|look'; none is 0, the polished car) */
export const lookOfKey = (key) => (+String(key).split('|')[2] || 0);

// where the leaf of a key lies (js/carmesh.js knows the kind's shape and says so
// before the first material of that key is built)
const _leaf = new Map();
export function setBodyLeaf(key, leaf) { if (leaf) _leaf.set(key, leaf); }

function build(opt) {
  const inst = !!opt.instanced;
  const fin = inst ? { metalness: 0.4, roughness: 0.45 } : paintFinish(opt.hex);
  const L = lookParams(inst ? 0 : lookOfKey(opt.key));
  const m = new THREE.MeshPhysicalMaterial({
    color: inst ? 0xffffff : opt.hex,
    metalness: fin.metalness * (METAL_LO + (1 - METAL_LO) * L.gloss), roughness: Math.min(0.95, fin.roughness + L.rough),
    // never exactly 0: without USE_CLEARCOAT a matte car would be a second program
    clearcoat: Math.max(L.gloss, 1e-3),
    // 0.10, not mirror-sharp: at 0.06 the sun's glint in the lacquer peaked so
    // far above white that the bloom pass turned every roof into a flare
    clearcoatRoughness: L.ccRough,
    vertexColors: true,
  });
  if (!inst && L.fade > 0) m.color.setRGB(...fadeRgb(m.color.r, m.color.g, m.color.b, L.fade));
  const uLook = { value: new THREE.Vector4(L.gloss, L.ccRough, L.dirt, L.seed) };
  const leafU = inst ? null : leafUniforms(_leaf.get(opt.key) ?? null);
  m.name = inst ? 'carbody-inst' : 'carbody';
  const uLit = { value: opt.lit === false ? 0 : 1 };
  const uBrake = { value: opt.brake ? 1 : 0 };
  // pull per depth rung, metres per metre of distance (see carmerge.js). Near
  // bodies are inside 62 m, where 6e-5 is one to two depth steps of a 24-bit
  // buffer; the distance dress is coarser and its patches stand further off.
  const uPull = { value: inst ? 1.6e-4 : 6e-5 };
  const decal = opt.decal ?? null;
  // the cabin behind the glass and the door region (js/carglass.js): per car only
  const glassU = inst ? null : glassUniforms(opt.key ?? '', opt.hex, opt.door ?? null, opt.tint ?? null);
  m.userData.glassU = glassU;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, BODY_U);
    sh.uniforms.uCarSky = U.uCarSky;
    sh.uniforms.uCarNight = U.uCarNight;
    sh.uniforms.uLit = uLit;
    sh.uniforms.uBrake = uBrake;
    sh.uniforms.uPull = uPull;
    if (decal) sh.uniforms.uDecal = { value: decal };
    if (glassU) Object.assign(sh.uniforms, glassU);
    if (leafU) Object.assign(sh.uniforms, leafU);
    if (!inst) sh.uniforms.uLook = uLook;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec4 cpbr; attribute vec4 cfx; attribute vec3 duv;
        varying vec4 vPbr; varying vec4 vFx; varying vec3 vDuv; varying float vUp;
        uniform float uPull;
        ${inst ? 'attribute vec4 iPaint; varying vec4 vPaint; attribute vec4 iLook; varying vec4 vLook; varying vec3 vObj;' : GLASS_VERT_DECL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vPbr = cpbr; vFx = cfx; vDuv = duv; vUp = normal.y;
        ${inst ? 'vPaint = iPaint; vLook = iLook; vObj = position;' : GLASS_VERT}`)
      .replace('#include <project_vertex>', `#include <project_vertex>
        // the depth rung: slide the vertex toward the eye along its own view
        // ray, so it lands on the same pixel a hair nearer (mvPosition itself,
        // which the lighting reads, is left where it is)
        gl_Position = projectionMatrix * vec4(mvPosition.xyz * (1.0 - cpbr.w * uPull), 1.0);`);
    const PAINT = inst ? 'vPaint.rgb' : 'diffuse';
    // instanced: w packs metallic (1) and lit (2)
    const LIT = inst ? 'step(1.5, vPaint.w)' : 'uLit';
    const METAL = inst ? 'mod(vPaint.w, 2.0)' : '0.0';
    // the look: gloss, lacquer roughness, dirt, seed (js/carlook.js lookParams)
    const LOOK = inst ? 'vLook' : 'uLook';
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec4 vPbr; varying vec4 vFx; varying vec3 vDuv; varying float vUp;
        uniform vec3 uHeadC, uTailC, uBrakeC; uniform float uHeadE, uTailE, uLit, uBrake, uCarNight;
        ${inst ? 'varying vec4 vPaint; varying vec4 vLook; varying vec3 vObj;' : GLASS_FRAG_DECL + 'uniform vec4 uLook; uniform vec4 uLeaf; uniform vec3 uLeafC;'}
        ${decal ? 'uniform sampler2D uDecal;' : ''}
        ${SKY_GLSL}
        ${CITY_GLSL}
        ${DIRT_GLSL}`)
      // cPaint: how much of this fragment is lacquered paint. 1 on the paint,
      // 0 on trim, glass and lamps, and on a decal the clear part of its texel.
      // The atlas is sampled unconditionally: a texture read inside a branch
      // that differs between neighbouring pixels has no derivatives, and the
      // plate's edge would pick a random mip.
      .replace('#include <color_fragment>', `#include <color_fragment>
        float cPaint = vFx.x;
        vec3 cBase = mix(vColor, ${PAINT}, vFx.x);
        ${decal ? `{
          vec4 dt = texture2D(uDecal, vDuv.xy);
          cBase = mix(cBase, mix(${PAINT}, dt.rgb, dt.a), vDuv.z);
          cPaint = mix(cPaint, 1.0 - dt.a, vDuv.z);
        }` : ''}
        diffuseColor.rgb = cBase;
        ${inst ? '' : glassFrag(LIT)}
        float cTail = vFx.z * (2.0 - vFx.z), cBrake = vFx.z * (vFx.z - 1.0) * 0.5;
        // the road on the body, then (per car only) the leaf lying on it
        ${dirtFrag(LOOK)}
        ${inst ? 'float cLeaf = 0.0;' : leafFrag()}
        float cMatt = max(cDirt, cLeaf);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        ${inst ? `roughnessFactor = mix(vPbr.x, min(0.95, mix(0.5, 0.38, ${METAL}) + (1.0 - vLook.x) * ${ROUGH_K.toFixed(3)}), cPaint);`
          : 'roughnessFactor = mix(vPbr.x, roughnessFactor, cPaint);'}
        roughnessFactor = mix(roughnessFactor, 0.94, cMatt);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        ${inst ? `metalnessFactor = mix(vPbr.y, 0.5 * ${METAL} * (${METAL_LO.toFixed(3)} + ${(1 - METAL_LO).toFixed(3)} * vLook.x), cPaint);`
          : 'metalnessFactor = mix(vPbr.y, metalnessFactor, cPaint);'}
        metalnessFactor *= 1.0 - cMatt;`)
      .replace('#include <lights_physical_fragment>', `#include <lights_physical_fragment>
        #ifdef USE_CLEARCOAT
          material.clearcoat *= cPaint * (1.0 - cMatt)${inst ? ' * max(vLook.x, 0.001)' : ''};
          ${inst ? 'material.clearcoatRoughness = max(material.clearcoatRoughness, vLook.y);' : ''}
        #endif`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += ((vFx.y * uHeadC * uHeadE + cTail * uTailC * uTailE) * mix(1.0, uCarNight, vFx.w)
          + cBrake * uBrakeC * uBrake) * ${LIT};`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
        {
          vec3 rd = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
          #ifndef USE_ENVMAP
            radiance += carSky(rd, material.roughness);
          #endif
          float city = carCity(rd, 0.012 + material.roughness * 0.2);
          float nightW = uCarNight * carWindows(rd) * city;
          float envK = mix(vPbr.z, 0.7, cMatt);          // dirty glass mirrors no sky
          radiance = radiance * envK * (1.0 - 0.72 * city) + vec3(1.0, 0.72, 0.42) * nightW * 0.16 * envK;
          #ifdef USE_CLEARCOAT
            vec3 cd = inverseTransformDirection(reflect(-geometryViewDir, geometryClearcoatNormal), viewMatrix);
            #ifndef USE_ENVMAP
              clearcoatRadiance += carSky(cd, material.clearcoatRoughness);
            #endif
            float cc = carCity(cd, 0.012 + material.clearcoatRoughness * 0.1);
            clearcoatRadiance = clearcoatRadiance * (1.0 - 0.75 * cc)
              + vec3(1.0, 0.72, 0.42) * uCarNight * carWindows(cd) * cc * 0.12;
          #endif
        }`)
      // the lamps were toneMapped: false; keep them out of the curve on the
      // direct path too (with the post stack on nothing here is tone mapped)
      .replace('#include <tonemapping_fragment>', `#if defined( TONE_MAPPING )
          gl_FragColor.rgb = mix(toneMapping(gl_FragColor.rgb), gl_FragColor.rgb,
            clamp((vFx.y + cTail + cBrake * uBrake) * ${LIT}, 0.0, 1.0));
        #endif`);
    lampDirectPatch(sh);
  };
  m.customProgramCacheKey = () => 'carbody4|' + (inst ? 'i' : 'c') + (decal ? 'd' : '');
  return m;
}

// ---- per car: (kind, colour, lit, braking) ----------------------------------
// The decal atlas is per kind and colour (the plate number hashes off both),
// so that is the key. Lit, unlit and braking are materials of their own on one
// shared program: a car that starts or stops being driven, or touches its
// brakes, just swaps between them (carmesh.js setCarState). Four materials a
// colour at most, each a few uniforms.
const _mats = new Map();
/**
 * Forget the materials no car wears any more. A material here is a bag of
 * uniforms on the one shared program, keyed by kind, colour and look, so a long
 * drive mints many; js/carmesh.js calls this now and then with the set in use.
 */
export function sweepBodyMats(inUse, cap = 360) {
  if (_mats.size <= cap) return 0;
  let n = 0;
  for (const [k, m] of _mats) {
    if (inUse.has(m) || k.startsWith('trailer')) continue;
    m.dispose(); _mats.delete(k); n++;
  }
  return n;
}
export const bodyMatCount = () => _mats.size;
// `door` (js/cardoor.js: { id, A, B, C }) is a fifth key: the same car with a
// door's region cut out, or with nothing BUT that region. Uniforms again, so
// these too are materials on the one program.
// `tint` ({ id, D }) is who the glass shows at the wheel (js/carglass.js).
export function bodyMatFor(key, hex, decal, lit = true, brake = false, door = null, tint = null) {
  const k = key + '|' + (lit ? 1 : 0) + (brake ? 1 : 0) + (door ? '|' + door.id : '') + (tint ? '|' + tint.id : '');
  let m = _mats.get(k);
  if (!m) _mats.set(k, m = build({ key, hex, decal, lit, brake, door, tint }));
  return m;
}

// ---- instanced: the one distance-dress material -----------------------------
let _inst = null;
export function instancedBodyMat() { return _inst ??= build({ instanced: true }); }

/** iPaint for a colour: linear rgb (faded as the look says), w = metallic + 2 * lit. */
export function paintInstance(hex, lit, out, look = 0) {
  _c.set(hex);
  const f = paintFinish(hex), L = lookParams(look);
  const c = fadeRgb(_c.r, _c.g, _c.b, L.fade);
  out[0] = c[0]; out[1] = c[1]; out[2] = c[2]; out[3] = (f.solid ? 0 : 1) + (lit ? 2 : 0);
  return out;
}
/** iLook for a look byte: gloss, lacquer roughness, dirt, seed. */
export function lookInstance(look, out) {
  const L = lookParams(look);
  out[0] = L.gloss; out[1] = L.ccRough; out[2] = L.dirt; out[3] = L.seed;
  return out;
}
