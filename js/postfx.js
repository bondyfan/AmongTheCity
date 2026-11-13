// ---- Post-processing stack (canopy AO + god rays + bloom + composite) ----
// The scene renders to an offscreen MSAA HALF-FLOAT target that also captures
// depth. Half-float matters: it keeps light above 1.0 instead of clamping, and
// that headroom is what bloom feeds on (sun disc, water glints, flames).
//
// Three optional effects ride on that buffer:
//   * canopy AO — a world-space crown-shade map (canopy.js) sampled by
//     reconstructing each pixel's world position from depth, so shade pools
//     under tree crowns and nowhere else
//   * god rays  — march each pixel toward the sun's screen position and count
//     how much open SKY it crosses, giving shafts through gaps in the canopy
//   * bloom     — threshold at 1.0 ("brighter than white") + separable blur
//
// The composite works entirely in LINEAR light, then applies the tone curve and
// encodes to sRGB, both exactly once, at the very end. Both steps are easy to
// lose, because a raw ShaderMaterial gets neither for free:
//   * without the sRGB encode the whole frame came out about 60 % darker the
//     moment the post path switched on;
//   * without the TONE CURVE (the state of things until now) the post path
//     clipped at 1.0 where the direct path rolled off, so the default presets
//     (medium and high, post on) and the low preset (post off) were two
//     different pictures of the same scene. three only tone-maps a material
//     when it draws to the canvas; into a render target it never does. So the
//     curve three uses (ACES filmic, same matrices, same exposure, read from
//     the renderer) is repeated here, on the finished linear frame.
// Bloom still thresholds on linear light BEFORE the curve: "brighter than
// white" has to mean the scene's own values, not what is left after roll-off.
// (At night that is two and a half times screen white, so only real sources
// bloom: lamp heads and headlamps are kept over it by lightpools.js
// nightLevels, lit windows and signs are deliberately under it and keep their
// colour, and so do name tags, which are plain white, and speech bubbles,
// which js/chatbubbles.js dims to the scene after dark.)
// (The screen-space AO term below is the live one. The canopy shade path is
// plumbed through but main.js passes canopy: null.)

import * as THREE from 'three';
import { AIR_CLEAR_GLSL, airFogUniforms, lookGLSL } from './heightfog.js';
import { LAMP_GLSL } from './lampmap.js';

const QUAD_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tDiffuse; uniform float threshold; varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tDiffuse, vUv).rgb;
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(c * smoothstep(threshold, threshold + 0.25, l), 1.0);
  }`;

// ---- God rays (crepuscular shafts): march each pixel toward the sun's
// screen position and accumulate how much SKY it passes over. Where the
// canopy breaks, light spills through in shafts — exactly the forest look.
// Runs at quarter res on the depth buffer alone (no extra scene pass).
const GODRAY_FRAG = /* glsl */`
  #define RAY_SAMPLES 24
  uniform sampler2D tDepth;
  uniform vec2 uSunUv;
  uniform float uDensity;   // how far along the ray we march (screen fraction)
  uniform float uDecay;     // per-step falloff
  uniform float uAspect;
  varying vec2 vUv;
  float rhash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  void main() {
    vec2 delta = (vUv - uSunUv) * (uDensity / float(RAY_SAMPLES));
    // jitter the start so the low sample count doesn't band into rings
    vec2 uv = vUv - delta * rhash(vUv * 512.0);
    float illum = 1.0, sum = 0.0;
    for (int i = 0; i < RAY_SAMPLES; i++) {
      uv -= delta;
      float d = texture2D(tDepth, clamp(uv, 0.0, 1.0)).x;
      sum += step(0.9999, d) * illum;   // only open sky emits
      illum *= uDecay;
    }
    // radial falloff from the sun: without it every open-sky pixel accumulates
    // a full march and the ENTIRE sky lifts uniformly (a flat wash, not shafts).
    // The origin now sits just past the top edge rather than a third of a
    // screen above it, so the reach pulls in to match — shafts stay strongest
    // where they break through the canopy and fade on the way down.
    float dist = length((vUv - uSunUv) * vec2(uAspect, 1.0));
    float fall = 1.0 - smoothstep(0.05, 0.75, dist);
    gl_FragColor = vec4(vec3(sum / float(RAY_SAMPLES) * fall), 1.0);
  }`;

const BLUR_FRAG = /* glsl */`
  uniform sampler2D tDiffuse; uniform vec2 dir; varying vec2 vUv;
  void main() {
    vec3 sum = texture2D(tDiffuse, vUv).rgb * 0.227;
    sum += texture2D(tDiffuse, vUv + dir * 1.384).rgb * 0.316;
    sum += texture2D(tDiffuse, vUv - dir * 1.384).rgb * 0.316;
    sum += texture2D(tDiffuse, vUv + dir * 3.230).rgb * 0.070;
    sum += texture2D(tDiffuse, vUv - dir * 3.230).rgb * 0.070;
    gl_FragColor = vec4(sum, 1.0);
  }`;

// ---- SSAO: reconstruct view-space position from depth, orient a hemisphere
// kernel by a silhouette-safe normal, count only occluders that RISE off the
// local plane. The above-plane guard is what pins open flat ground to 1.0. ----
const SSAO_FRAG = /* glsl */`
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform vec2 uRes;          // HALF-res AO target size in px
  uniform float uRadius;
  uniform float uBias;
  uniform vec3 uKernel[16];
  varying vec2 vUv;

  vec3 viewPos(vec2 uv, float d) {
    vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * ndc;
    return v.xyz / v.w;
  }
  float hash(vec2 c) { return fract(sin(dot(c, vec2(12.9898, 78.233))) * 43758.5453); }

  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.9999) { gl_FragColor = vec4(1.0); return; }   // sky — no AO
    vec3 P = viewPos(vUv, d);

    // silhouette-safe normal: on each axis pick the neighbour with the SMALLER
    // view-Z step, so trunk/canopy edges and half-res depth noise cannot
    // fabricate a tilted normal (was cross(dFdx(P), dFdy(P)), which did).
    vec2 tx = vec2(1.0 / uRes.x, 0.0);
    vec2 ty = vec2(0.0, 1.0 / uRes.y);
    vec3 Pr = viewPos(vUv + tx, texture2D(tDepth, vUv + tx).x);
    vec3 Pl = viewPos(vUv - tx, texture2D(tDepth, vUv - tx).x);
    vec3 Pu = viewPos(vUv + ty, texture2D(tDepth, vUv + ty).x);
    vec3 Pd = viewPos(vUv - ty, texture2D(tDepth, vUv - ty).x);
    vec3 ddx = (abs(Pr.z - P.z) < abs(P.z - Pl.z)) ? (Pr - P) : (P - Pl);
    vec3 ddy = (abs(Pu.z - P.z) < abs(P.z - Pd.z)) ? (Pu - P) : (P - Pd);
    vec3 N = normalize(cross(ddx, ddy));   // faces the camera (+Z)

    float ang = hash(vUv * uRes) * 6.2831853;
    vec3 rv = vec3(cos(ang), sin(ang), 0.0);
    vec3 T = normalize(rv - N * dot(rv, N));
    vec3 Bt = cross(N, T);
    mat3 TBN = mat3(T, Bt, N);

    // depth-scaled bias: grazing self-occlusion + depth precision error both
    // grow with distance, so a fixed bias can't reject them far from camera.
    float bias = uBias + abs(P.z) * 0.015;

    float occ = 0.0;
    for (int i = 0; i < 16; i++) {
      vec3 sp = P + (TBN * uKernel[i]) * uRadius;      // +N hemisphere sample
      vec4 clip = uProj * vec4(sp, 1.0);
      vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
      if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
      float sd = texture2D(tDepth, suv).x;
      if (sd >= 0.9999) continue;                       // sky is not an occluder
      vec3 Ps = viewPos(suv, sd);                        // real geometry there
      float above = dot(N, Ps - P);                      // >bias only if it rises off the plane
      float dz = abs(P.z - Ps.z);
      float rc = 1.0 - smoothstep(uRadius * 0.5, uRadius, dz); // HARD local cutoff
      occ += ((Ps.z >= sp.z + bias) && (above > bias)) ? rc : 0.0;
    }
    gl_FragColor = vec4(vec3(1.0 - occ / 16.0), 1.0);
  }`;

// a small box blur to smooth the noisy AO
const AO_BLUR_FRAG = /* glsl */`
  uniform sampler2D tAO; uniform vec2 texel; varying vec2 vUv;
  void main() {
    float s = 0.0;
    for (int x = -2; x <= 2; x++)
      for (int y = -2; y <= 2; y++)
        s += texture2D(tAO, vUv + vec2(float(x), float(y)) * texel).r;
    gl_FragColor = vec4(vec3(s / 25.0), 1.0);
  }`;

const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tScene;
  uniform sampler2D tAO;
  uniform sampler2D tBloom;
  uniform sampler2D tDepth;
  uniform sampler2D tCanopy;      // R: remaining light under crowns (1 = open)
  uniform sampler2D tCanopyMeta;  // R: ground height, G: canopy-top height
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec2 uCanopyCenter;     // world xz of the shade map's center
  uniform float uCanopyInvSize;   // 1 / meters covered by the map
  uniform float uCanopyStrength;
  uniform vec2 texel;
  uniform float aoStrength;
  uniform float aoFloor;
  uniform float bloomStrength;
  uniform sampler2D tRays;
  uniform vec3 rayColor;
  uniform float rayStrength;
  uniform float uBlur;            // 0 = off; how far the smear reaches, in uv
  uniform vec2  uBlurC;           // the point it smears AWAY from
  uniform vec2  uBlurAniso;       // x/y weight — sideways beats forwards
  uniform vec2  uFlareUv;         // sun position on screen
  uniform float uFlare;           // 0 = off; overall strength
  uniform vec3  uFlareCol;
  uniform bool useAO;
  uniform bool useCanopy;
  uniform bool useLamp;           // street light from the lamp map (lampmap.js)
  uniform vec3 uCamPos;
  uniform bool useBloom;
  uniform bool useRays;
  uniform bool useFXAA;
  uniform float uExposure;        // renderer.toneMappingExposure
  uniform vec3  uGradeLift;       // colour pushed into the shadows
  uniform vec3  uGradeGain;       // colour multiplied into the highlights
  uniform float uVignette;        // 0 = none
  varying vec2 vUv;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  // canopy shade: reconstruct the pixel's WORLD position from depth, look up
  // the crown-density map there, and darken only what sits UNDER the crowns
  // (the meta map carries ground + canopy-top heights, so sunlit canopy tops
  // and anything above the foliage stay bright)
  vec3 worldAt(float d) {
    vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * ndc;
    return (uCamWorld * vec4(v.xyz / v.w, 1.0)).xyz;
  }
  ${AIR_CLEAR_GLSL}
  ${LAMP_GLSL}
  float canopyShade(float d, vec3 world) {
    if (d >= 0.9999) return 1.0;                       // sky
    vec2 uv2 = (world.xz - uCanopyCenter) * uCanopyInvSize + 0.5;
    if (uv2.x <= 0.0 || uv2.x >= 1.0 || uv2.y <= 0.0 || uv2.y >= 1.0) return 1.0;
    float dens = 1.0 - texture2D(tCanopy, uv2).r;      // 0 open … →1 thick woods
    if (dens < 0.004) return 1.0;
    // response curve: moderate crown coverage (the forest floor BETWEEN
    // trees) still reads as real shade, instead of hiding in the low end —
    // tuned to ~10% at blob edges, ~33% typical floor, ~49% in thick stands
    dens = smoothstep(0.1, 1.0, dens);
    vec2 meta = texture2D(tCanopyMeta, uv2).rg;
    float groundH = meta.r * 176.0 - 16.0;
    float topH = meta.g * 32.0;
    if (topH < 0.5) return 1.0;
    // full shade from the ground up through the trunks; the crown itself
    // KEEPS a partial share — from the top-down camera the ground under a
    // crown is hidden BY that crown, so this is what makes a thick wood
    // visibly darker from above (a lone tree's crown barely registers).
    float fade = mix(1.0, 0.35, smoothstep(topH * 0.5, topH * 0.95, world.y - groundH));
    return 1.0 - min(dens * fade * uCanopyStrength, 0.75);
  }
  // three's ACESFilmicToneMapping, verbatim (libs/three.module.js,
  // tonemapping_pars_fragment), so this path and the direct path agree to the
  // last bit about what a given linear value looks like. Own names: three
  // prepends its originals to this very shader whenever it draws to the canvas.
  // Both end with the same look (heightfog.js lookGLSL): open toe, saturation.
  ${lookGLSL('atcLookPost')}
  vec3 atcRRTAndODTFit(vec3 v) {
    vec3 a = v * (v + 0.0245786) - 0.000090537;
    vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
    return a / b;
  }
  vec3 aces(vec3 color) {
    const mat3 ACESInputMat = mat3(
      vec3(0.59719, 0.07600, 0.02840),
      vec3(0.35458, 0.90834, 0.13383),
      vec3(0.04823, 0.01566, 0.83777));
    const mat3 ACESOutputMat = mat3(
      vec3( 1.60475, -0.10208, -0.00327),
      vec3(-0.53108,  1.10813, -0.07276),
      vec3(-0.07367, -0.00605,  1.07602));
    color *= uExposure / 0.6;
    color = ACESInputMat * color;
    color = atcRRTAndODTFit(color);
    color = ACESOutputMat * color;
    return atcLookPost(clamp(color, 0.0, 1.0));
  }
  vec3 s2l(vec3 c){ return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
  vec3 l2s(vec3 c){ c = max(c, 0.0); return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
  // FXAA-lite: the non-MSAA post target loses edge AA, which reads as harsh
  // contrast; this cheap edge-directed blur restores smooth edges.
  vec3 fxaa(vec2 uv){
    vec3 mNW = texture2D(tScene, uv + vec2(-1.0,-1.0) * texel).rgb;
    vec3 mNE = texture2D(tScene, uv + vec2( 1.0,-1.0) * texel).rgb;
    vec3 mSW = texture2D(tScene, uv + vec2(-1.0, 1.0) * texel).rgb;
    vec3 mSE = texture2D(tScene, uv + vec2( 1.0, 1.0) * texel).rgb;
    vec3 mM  = texture2D(tScene, uv).rgb;
    float lNW = dot(mNW, LUMA), lNE = dot(mNE, LUMA);
    float lSW = dot(mSW, LUMA), lSE = dot(mSE, LUMA), lM = dot(mM, LUMA);
    float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
    float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));
    float red = max((lNW + lNE + lSW + lSE) * 0.25 * 0.125, 1.0 / 128.0);
    float rcp = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
    dir = clamp(dir * rcp, -8.0, 8.0) * texel;
    vec3 rA = 0.5 * (texture2D(tScene, uv + dir * (1.0 / 3.0 - 0.5)).rgb
                   + texture2D(tScene, uv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 rB = rA * 0.5 + 0.25 * (texture2D(tScene, uv + dir * -0.5).rgb
                               + texture2D(tScene, uv + dir *  0.5).rgb);
    float lB = dot(rB, LUMA);
    return (lB < lMin || lB > lMax) ? rA : rB;
  }
  void main() {
    // tScene is a LINEAR half-float HDR target: sampling gives raw linear
    // light, values above 1.0 included (that headroom is what makes bloom and
    // the sun disc glow). The whole composite works in linear and encodes to
    // sRGB once at the very end — a raw ShaderMaterial gets NO automatic
    // output encode, so writing linear straight out (the old bug) darkened
    // the whole frame ~60% the moment the post path switched on.
    vec3 c = useFXAA ? fxaa(vUv) : texture2D(tScene, vUv).rgb;
    // ---- motion blur -----------------------------------------------------
    // A RADIAL smear away from where the machine is heading. Real camera blur
    // needs per-pixel velocity, which needs a velocity buffer and a second
    // pass; but almost all of the blur a driver or a pilot actually perceives
    // is the world streaming outward from the vanishing point, and that is a
    // pure function of one screen-space point and one strength. Six taps, no
    // extra target, no extra pass — it rides the composite that was already
    // sampling this texture. Pixels near the centre barely move, the frame
    // edges tear past, which is exactly the real thing's signature.
    if (uBlur > 0.0005) {
      vec2 off = vUv - uBlurC;
      // Two shapes on top of the radial smear, both about WHERE you are looking:
      //  · a sharp core. Radial blur alone still smears the middle of the frame
      //    a little, and the middle of the frame is the road you are driving
      //    down — so the inner fifth is left completely alone and the effect
      //    ramps in from there out to the corners.
      //  · sideways bias. What actually streams past a driver is the scenery to
      //    the LEFT and RIGHT; the road ahead mostly grows rather than sweeps.
      //    Weighting x over y puts the smear where the motion really is.
      float rad = length(off * vec2(uBlurAniso.x, uBlurAniso.y));
      float gate = smoothstep(0.20, 0.72, rad);
      vec2 d = off * uBlurAniso * uBlur * gate;
      vec3 acc = c;
      for (int i = 1; i <= 6; i++) {
        float t = float(i) / 6.0;
        acc += texture2D(tScene, vUv - d * t).rgb;
      }
      c = acc / 7.0;
    }
    // one depth read and one world position for everything below that asks
    // where a pixel IS (tree shade, street light)
    float sceneD = 1.0;
    vec3 world = vec3(0.0);
    if (useCanopy || useLamp) { sceneD = texture2D(tDepth, vUv).x; world = worldAt(sceneD); }
    vec3 wdx = dFdx(world), wdy = dFdy(world);
    // Street light is worked out from the frame BEFORE any screen-space shade
    // (the shade under a crown is the sun's, and a lamp stands under the crown)
    // and added after it.
    vec3 lamp = vec3(0.0);
    if (useLamp && sceneD < 0.9999) lamp = lampLight(c, world, wdx, wdy, world - uCamPos, uCamPos.y);
    if (useAO || useCanopy) {
      float occl = 1.0, ao = 1.0;
      if (useAO) {
        ao = texture2D(tAO, vUv).r;                // 1 = open (guard pins it), <1 = occluded
        ao = mix(1.0, ao, aoStrength);             // scale the occlusion amount
        ao = max(ao, aoFloor);                     // deepest allowed darkening
        occl = ao;
      }
      // the canopy term is where the visible "AO" now lives: shade pools
      // under tree crowns and deepens where many crowns overlap
      if (useCanopy) occl *= canopyShade(sceneD, world);
      // spare near-white highlights so speculars don't get gouged
      float hl = smoothstep(0.9, 1.0, dot(c, LUMA));
      float f = mix(occl, 1.0, hl);
      c *= f;                                       // occlusion is a LINEAR-light multiply
      lamp *= ao;                                   // a crease is a crease under a lamp too
    }
    c += lamp;
    // shafts land BEFORE bloom so the brightest ones bloom too (they were
    // additively lit by the sun, so they take the sun's current colour —
    // white at noon, deep gold at sunset)
    if (useRays) c += rayColor * (texture2D(tRays, vUv).r * rayStrength);
    if (useBloom) c += texture2D(tBloom, vUv).rgb * bloomStrength;

    // ---- lens flare ------------------------------------------------------
    // Ghosts along the line from the sun THROUGH the centre of the frame, which
    // is what a real lens does: each element in the stack reflects the source
    // back at a different scale, so the artefacts march across the middle as
    // the sun moves. Cheap, and it needs nothing the composite does not already
    // know — the god-ray pass has already worked out where the sun is.
    if (uFlare > 0.001) {
      vec2 d = uFlareUv - vUv;
      float aspect = texel.y / texel.x;
      vec2 da = vec2(d.x * aspect, d.y);
      // the halo hugging the sun itself
      float halo = exp(-dot(da, da) * 26.0) * 1.3;
      // …and the ghosts, mirrored through the frame centre at fixed spacings
      vec2 toC = (vec2(0.5) - uFlareUv);
      float ghosts = 0.0;
      for (int i = 1; i <= 5; i++) {
        float sc = float(i) * 0.42;
        vec2 gp = uFlareUv + toC * (2.0 * sc);
        vec2 gd = vec2((gp.x - vUv.x) * aspect, gp.y - vUv.y);
        // alternate tight/loose so the stack does not read as five identical dots
        float tight = mod(float(i), 2.0) > 0.5 ? 320.0 : 90.0;
        ghosts += exp(-dot(gd, gd) * tight) * (0.5 / float(i));
      }
      // fade the whole thing out toward the frame edge, where a real flare
      // loses the aperture anyway
      float edge = 1.0 - smoothstep(0.55, 1.15, length(vec2((uFlareUv.x - 0.5) * aspect, uFlareUv.y - 0.5)));
      c += uFlareCol * ((halo + ghosts) * uFlare * edge);
    }
    // ---- the look: one tone curve, then a light grade --------------------
    c = aces(max(c, 0.0));
    // A split tone, in display-linear light after the curve so it cannot push
    // anything back over white: shadows lean one way, highlights the other.
    // main.js feeds the two colours from the sun's height (cool shade and warm
    // light through the golden hour, a blue cast at night, neutral at noon).
    // Both are (0,0,0) and (1,1,1) when grading is off, and then this is exact
    // identity.
    float gl = dot(c, LUMA);
    c = c * mix(vec3(1.0), uGradeGain, smoothstep(0.0, 0.85, gl))
      + uGradeLift * (1.0 - gl) * (1.0 - gl);
    // a vignette you should not be able to point at: 8 % in the far corners
    if (uVignette > 0.0) {
      vec2 vq = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.30, 0.80, dot(vq, vq) * 2.0);
    }
    gl_FragColor = vec4(l2s(c), 1.0);              // LINEAR → sRGB for the canvas
  }`;

// hemisphere kernel: points in the +Z hemisphere, bunched toward the origin
function buildKernel(n) {
  const k = [];
  for (let i = 0; i < n; i++) {
    const v = new THREE.Vector3(
      Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 0.9 + 0.1);
    v.normalize();
    let s = i / n; s = 0.1 + 0.9 * s * s; // more samples close in
    v.multiplyScalar(s);
    k.push(v);
  }
  return k;
}

export class PostFX {
  constructor(renderer) {
    this.renderer = renderer;
    const w = renderer.domElement.width, h = renderer.domElement.height;
    // colour + DEPTH target. MSAA (samples) keeps the offscreen path as crisp
    // as the direct canvas — without it, distant detail (tree lines!) had to
    // be FXAA-smeared, which read as "the fog moved closer" when AO went on.
    // HALF-FLOAT LINEAR target: keeps light above 1.0 instead of clamping it,
    // which is what lets bloom actually catch the sun disc, water glints and
    // flames (on the old 8-bit sRGB target every highlight flattened to white
    // first, so bloom had nothing bright left to work with).
    this.rtScene = new THREE.WebGLRenderTarget(w, h, {
      samples: 4, type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
    });
    this.rtScene.depthTexture = new THREE.DepthTexture(w, h);
    this.rtScene.depthTexture.type = THREE.UnsignedIntType;
    // AO at half res (+ its blur target)
    this.rtAO = new THREE.WebGLRenderTarget(w >> 1, h >> 1);
    this.rtAOb = new THREE.WebGLRenderTarget(w >> 1, h >> 1);
    // bloom scratch at quarter res (half-float so HDR survives the blur)
    const hdr = { type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace };
    this.rtA = new THREE.WebGLRenderTarget(w >> 2, h >> 2, hdr);
    this.rtB = new THREE.WebGLRenderTarget(w >> 2, h >> 2, hdr);
    // god-ray shaft mask at quarter res
    this.rtRay = new THREE.WebGLRenderTarget(w >> 2, h >> 2);

    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), null);
    this.quadScene.add(this.quad);

    const mat = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: QUAD_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false,
    });
    this.ssaoMat = mat(SSAO_FRAG, {
      tDepth: { value: null }, uProj: { value: new THREE.Matrix4() },
      uInvProj: { value: new THREE.Matrix4() }, uRes: { value: new THREE.Vector2() },
      uRadius: { value: 1.6 }, uBias: { value: 0.03 }, uKernel: { value: buildKernel(16) },
    });
    this.aoBlurMat = mat(AO_BLUR_FRAG, { tAO: { value: null }, texel: { value: new THREE.Vector2() } });
    // threshold sits at 1.0 = "brighter than white": on the HDR target only
    // genuinely over-bright light (sun disc, water glints, flames) blooms, so
    // ordinary lit surfaces come through the post path untouched
    this.brightMat = mat(BRIGHT_FRAG, { tDiffuse: { value: null }, threshold: { value: 1.0 } });
    this.blurMat = mat(BLUR_FRAG, { tDiffuse: { value: null }, dir: { value: new THREE.Vector2() } });
    this.rayMat = mat(GODRAY_FRAG, {
      tDepth: { value: null }, uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
      uDensity: { value: 0.7 }, uDecay: { value: 0.96 }, uAspect: { value: 1.78 },
    });
    this.compositeMat = mat(COMPOSITE_FRAG, {
      tScene: { value: null }, tAO: { value: null }, tBloom: { value: null },
      tDepth: { value: null }, tCanopy: { value: null }, tCanopyMeta: { value: null },
      tRays: { value: null }, rayColor: { value: new THREE.Color(1, 1, 1) },
      rayStrength: { value: 0 },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
      uCanopyCenter: { value: new THREE.Vector2() }, uCanopyInvSize: { value: 1 / 400 },
      uCanopyStrength: { value: 0.9 },
      texel: { value: new THREE.Vector2() },
      uBlur: { value: 0 }, uBlurC: { value: new THREE.Vector2(0.5, 0.5) },
      uBlurAniso: { value: new THREE.Vector2(1, 0.45) },
      uFlareUv: { value: new THREE.Vector2(0.5, 0.5) }, uFlare: { value: 0 },
      uFlareCol: { value: new THREE.Color(1, 0.92, 0.8) },
      aoStrength: { value: 0.25 }, aoFloor: { value: 0.30 }, bloomStrength: { value: 0.55 },
      useAO: { value: false }, useCanopy: { value: false },
      useLamp: { value: false }, tLamp: { value: null },
      uLampMap: { value: new THREE.Vector4() }, uLampAmb: { value: new THREE.Color(0.02, 0.03, 0.04) },
      uLampShape: { value: new THREE.Vector4(0.55, 1.3, 8.5, 0.5) },
      uLampSurf: { value: new THREE.Vector3(0.55, 1.0, 1.0) },
      // the headlight fans' own map, and what the lamp term needs to know a
      // moon shadow when it lights one (lampmap.js)
      tBeam: { value: null }, uBeamMap: { value: new THREE.Vector3() },
      tSunShadow: { value: null }, uSunShadowMat: { value: new THREE.Matrix4() },
      uSunShadowK: { value: new THREE.Vector3(0, 0.15, 1 / 2048) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) }, uSunCol: { value: new THREE.Color(0, 0, 0) },
      uHemiSky: { value: new THREE.Color(0, 0, 0) }, uHemiGround: { value: new THREE.Color(0, 0, 0) },
      uCamPos: { value: new THREE.Vector3() }, uFogWall: { value: new THREE.Vector2(600, 900) },
      ...airFogUniforms(),
      useBloom: { value: false }, useRays: { value: false }, useFXAA: { value: false },
      uExposure: { value: 1 },
      uGradeLift: { value: new THREE.Color(0, 0, 0) },
      uGradeGain: { value: new THREE.Color(1, 1, 1) },
      uVignette: { value: 0 },
    });
    // the lamp term takes dFdx/dFdy of the world position: built in on WebGL2,
    // an extension that has to be asked for on a WebGL1 context
    this.compositeMat.extensions.derivatives = true;
    this._sunWorld = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();
    this._flareUv = new THREE.Vector2(0.5, 0.5);
    this._flareFacing = 0;
  }

  setSize(w, h) {
    this.rtScene.setSize(w, h);
    this.rtAO.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.rtAOb.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
    this.rtA.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.rtB.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
    this.rtRay.setSize(Math.max(1, w >> 2), Math.max(1, h >> 2));
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  // opts: { ssao, bloom, aoRadius, aoStrength, aoFloor, canopy, rays, grade, lamps }
  // lamps:  the LightPools (lightpools.js). Its bake() draws this frame's lamp
  //         map and returns where it lies, or null by day
  // grade:  { lift: Color, gain: Color, vignette } from gradeFor() below, or
  //         nothing for a neutral frame
  // canopy: { densTex, metaTex, cx, cz, size, strength } — the world-space
  // crown-shade map maintained by canopy.js
  // rays:   { dir, color, strength } — dir is the world-space direction TO the
  //         sun; shafts fade out as it leaves the view and vanish behind you
  render(scene, camera, opts = {}) {
    const r = this.renderer;
    this._flareFacing = 0;          // recomputed below when the sun is in front
    // before the scene: bake() also takes the pool quads out of it for this frame
    const lamp = opts.lamps?.bake?.(r, camera) ?? null;
    r.setRenderTarget(this.rtScene);
    r.render(scene, camera);

    // ---- god rays: only worth a pass when the sun is actually in front ----
    let rayK = 0;
    if (opts.rays?.strength > 0) {
      // Project the sun as a point at INFINITY. Placing a proxy point some
      // fixed distance away and calling .project() breaks the moment that
      // distance passes camera.far (the game pulls far in with the fog), so
      // do the perspective divide on the view-space DIRECTION instead — exact
      // for a sun, and independent of near/far entirely.
      const v = this._sunWorld.copy(opts.rays.dir).transformDirection(camera.matrixWorldInverse);
      const facing = -v.z;                            // >0 = sun ahead of the camera
      if (facing > 0) {
        const e = camera.projectionMatrix.elements;
        // CLAMP the shaft origin to just past the frame edge. The third-person
        // camera tilts down, so the real sun sits above the top edge for all
        // but a few minutes a day (screen v runs 1.4 at dawn to 22 near noon)
        // and shafts converging on a point that far off screen degenerate to
        // nothing. Pinning the origin to the edge makes light stream IN from
        // the sun's side instead. (An earlier off-screen FADE was tidy and
        // left the effect dead at every sun angle above ~15°.)
        // The VERTICAL margin is deliberately tiny: the horizon sits ~80% up
        // the frame, so an origin a hair past the top edge puts the shafts'
        // source right behind the treetops. A generous margin here reads as
        // light falling out of the sky high ABOVE the canopy instead.
        const MU = 0.35, MV = 0.06;
        const su = Math.max(-MU, Math.min(1 + MU, (e[0] * v.x / facing) * 0.5 + 0.5));
        const sv = Math.max(-MV, Math.min(1 + MV, (e[5] * v.y / facing) * 0.5 + 0.5));
        // Shafts belong where the sun ACTUALLY is. Measure how far it sits to
        // the side as a horizontal AZIMUTH difference — that stays meaningful
        // at any elevation, while the projected screen x blows up as the sun
        // climbs toward the zenith (su hits 12+ at noon for a 30° turn). Full
        // strength while the sun is within the frame's half-FOV, then out over
        // the next ~23°, so no shafts rake between trees the sun isn't behind.
        const f = this._camFwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
        let dAz = Math.abs(Math.atan2(opts.rays.dir.x, opts.rays.dir.z)
          - Math.atan2(f.x, f.z)) % (Math.PI * 2);
        if (dAz > Math.PI) dAz = Math.PI * 2 - dAz;
        const halfH = Math.atan(Math.tan(camera.fov * Math.PI / 360) * camera.aspect);
        const sideFade = 1 - Math.min(1, Math.max(0, (dAz - halfH) / 0.4));
        // the flare wants the sun's TRUE screen position, not the clamped
        // shaft origin — a ghost stack anchored to the frame edge would slide
        // along it instead of tracking the sun
        this._flareUv.set((e[0] * v.x / facing) * 0.5 + 0.5, (e[5] * v.y / facing) * 0.5 + 0.5);
        this._flareFacing = facing;
        rayK = opts.rays.strength * Math.min(1, facing * 2.2) * sideFade;
        if (rayK > 0.001) {
          this.rayMat.uniforms.tDepth.value = this.rtScene.depthTexture;
          this.rayMat.uniforms.uSunUv.value.set(su, sv);
          this.rayMat.uniforms.uAspect.value = this.rtScene.width / this.rtScene.height;
          this._pass(this.rayMat, this.rtRay);
        } else rayK = 0;
      }
    }

    if (opts.ssao) {
      const u = this.ssaoMat.uniforms;
      u.tDepth.value = this.rtScene.depthTexture;
      u.uProj.value.copy(camera.projectionMatrix);
      u.uInvProj.value.copy(camera.projectionMatrixInverse);
      u.uRes.value.set(this.rtAO.width, this.rtAO.height);
      u.uRadius.value = opts.aoRadius ?? 1.6;
      this._pass(this.ssaoMat, this.rtAO);
      this.aoBlurMat.uniforms.tAO.value = this.rtAO.texture;
      this.aoBlurMat.uniforms.texel.value.set(1 / this.rtAO.width, 1 / this.rtAO.height);
      this._pass(this.aoBlurMat, this.rtAOb);
    }

    if (opts.bloom) {
      this.brightMat.uniforms.tDiffuse.value = this.rtScene.texture;
      this._pass(this.brightMat, this.rtA);
      this.blurMat.uniforms.tDiffuse.value = this.rtA.texture;
      this.blurMat.uniforms.dir.value.set(1 / this.rtA.width, 0);
      this._pass(this.blurMat, this.rtB);
      this.blurMat.uniforms.tDiffuse.value = this.rtB.texture;
      this.blurMat.uniforms.dir.value.set(0, 1 / this.rtB.height);
      this._pass(this.blurMat, this.rtA);
    }

    const c = this.compositeMat.uniforms;
    c.tScene.value = this.rtScene.texture;
    c.tAO.value = this.rtAOb.texture;
    c.tBloom.value = this.rtA.texture;
    c.texel.value.set(1 / this.rtScene.width, 1 / this.rtScene.height);
    c.useAO.value = !!opts.ssao;
    c.useBloom.value = !!opts.bloom;
    // the scene target is MSAA-resolved — FXAA on top only smears fine detail
    c.useFXAA.value = false;
    // the same exposure the direct path uses, whatever main.js has set it to
    c.uExposure.value = r.toneMappingExposure;
    const g = opts.grade;
    if (g) { c.uGradeLift.value.copy(g.lift); c.uGradeGain.value.copy(g.gain); }
    else { c.uGradeLift.value.setRGB(0, 0, 0); c.uGradeGain.value.setRGB(1, 1, 1); }
    c.uVignette.value = g ? (g.vignette ?? 0) : 0;
    c.aoStrength.value = opts.aoStrength ?? 0.25;
    c.aoFloor.value = opts.aoFloor ?? 0.30;
    // motion blur: main.js hands us a strength and, optionally, where the
    // vanishing point is on screen (the nose, not the frame centre — you are
    // rarely looking exactly where you are going)
    c.uBlur.value = opts.motionBlur ?? 0;
    if (opts.blurCenter) c.uBlurC.value.copy(opts.blurCenter);
    else c.uBlurC.value.set(0.5, 0.5);
    // a jet is closer to isotropic: at Mach 2 the whole frame is moving
    if (opts.blurAniso) c.uBlurAniso.value.set(opts.blurAniso[0], opts.blurAniso[1]);
    else c.uBlurAniso.value.set(1, 0.45);
    // Lens flare. Only when the sun is genuinely in front of the camera, and
    // scaled by the caller — main.js gives it a fraction on the ground and the
    // full amount in the air, where there is nothing between you and the sun.
    const flare = (opts.flare ?? 0) * (this._flareFacing > 0 ? 1 : 0);
    c.uFlare.value = flare;
    if (flare > 0) {
      c.uFlareUv.value.copy(this._flareUv);
      if (opts.rays?.color) c.uFlareCol.value.copy(opts.rays.color);
    }
    c.useRays.value = rayK > 0;
    c.tRays.value = rayK > 0 ? this.rtRay.texture : this.rtAOb.texture;
    c.rayStrength.value = rayK;
    if (rayK > 0 && opts.rays.color) c.rayColor.value.copy(opts.rays.color);
    const cp = opts.canopy;
    c.useLamp.value = !!lamp;
    c.tLamp.value = lamp ? lamp.tex : this.rtAOb.texture;
    c.tBeam.value = lamp ? lamp.beamTex : this.rtAOb.texture;
    // The moon's shadow map, read AFTER the scene was drawn: three stores the
    // matrix with the map when it draws it, so the two always belong together
    // (also on the frames js/shadowpace.js skips the pass).
    const sun = lamp?.sun, smap = sun?.castShadow && r.shadowMap.enabled ? sun.shadow.map : null;
    c.tSunShadow.value = smap ? smap.texture : this.rtAOb.texture;
    c.uSunShadowK.value.x = smap ? 1 : 0;
    if (lamp) {
      c.uLampMap.value.set(lamp.cx, lamp.cz, 1 / lamp.size, lamp.baseY);
      c.uBeamMap.value.set(lamp.bx, lamp.bz, 1 / lamp.beamSize);
      c.uLampAmb.value.copy(lamp.amb);
      c.uLampShape.value.set(lamp.knee, lamp.lit, lamp.top, lamp.beamKnee ?? lamp.knee);
      c.uLampSurf.value.set(lamp.wall, lamp.soft, lamp.leaf ?? 0);
      c.uFogWall.value.set(scene.fog?.near ?? 1e5, scene.fog?.far ?? 2e5);
      if (smap) {
        c.uSunShadowMat.value.copy(sun.shadow.matrix);
        c.uSunShadowK.value.set(1, sun.shadow.normalBias, 1 / sun.shadow.mapSize.x);
        // the direction the map was DRAWN from (sky.js holds it in steps), not
        // where the moon is this instant
        c.uSunDir.value.subVectors(sun.position, sun.target.position).normalize();
        c.uSunCol.value.copy(sun.color).multiplyScalar(sun.intensity);
        const hm = lamp.hemi;
        if (hm) {
          c.uHemiSky.value.copy(hm.color).multiplyScalar(hm.intensity);
          c.uHemiGround.value.copy(hm.groundColor).multiplyScalar(hm.intensity);
        }
      }
    }
    if (cp || lamp) {
      c.uInvProj.value.copy(camera.projectionMatrixInverse);
      c.uCamWorld.value.copy(camera.matrixWorld);
      c.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    }
    c.useCanopy.value = !!cp;
    // always bind real textures (unbound samplers trip driver warnings)
    c.tDepth.value = this.rtScene.depthTexture;
    c.tCanopy.value = cp ? cp.densTex : this.rtAOb.texture;
    c.tCanopyMeta.value = cp ? cp.metaTex : this.rtAOb.texture;
    if (cp) {
      c.uCanopyCenter.value.set(cp.cx, cp.cz);
      c.uCanopyInvSize.value = 1 / cp.size;
      c.uCanopyStrength.value = cp.strength ?? 0.9;
    }
    this._pass(this.compositeMat, null);
  }

  dispose() {
    for (const rt of [this.rtScene, this.rtAO, this.rtAOb, this.rtA, this.rtB, this.rtRay]) rt.dispose();
    this.rtScene.depthTexture?.dispose();
  }
}

// ---- the grade, as numbers ----
// One reused object: main.js calls this every frame and hands the result to
// render(). `warm` is 0 with the sun high and 1 with it on the horizon (the
// same curve sky.js colours the sun with); `nightK` is sky.nightK.
const _grade = { lift: new THREE.Color(), gain: new THREE.Color(), vignette: 0.08 };
export function gradeFor(warm, nightK) {
  // golden hour: light goes amber, shade goes blue. It has to stay a hint:
  // the sun and the haze already carry the colour, this only separates them.
  const w = warm * (1 - nightK);
  // night: lift the shadows a touch toward blue so the dark has a hue instead
  // of being a hole, and let the highlights (lamps, windows) keep their warmth
  const n = nightK;
  _grade.lift.setRGB(0.000 * w + 0.0010 * n, 0.006 * w + 0.0018 * n, 0.020 * w + 0.0050 * n);
  _grade.gain.setRGB(1 + 0.045 * w, 1 + 0.010 * w, 1 - 0.050 * w + 0.0 * n);
  return _grade;
}
