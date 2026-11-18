// ---- facadefx.js: depth, weather and glass for a painted wall ----
// MAIN THREAD ONLY (it builds a texture). The facade atlas is a flat picture:
// a window is a dark rectangle in a pale one, a cornice a pale stripe, and a
// wall the same clean plaster from the pavement to the eaves. Up close that
// reads as a painted box. This module is the shader work that turns the same
// picture into something with depth, and it costs no draw call, no vertex and
// no texture memory worth the name: the GPU has headroom, the CPU does not.
//
//   * WINDOW DEPTH. Every fragment knows which atlas cell it is in and where in
//     that cell (the uv IS that address), and typology says where the window of
//     each cell sits (band, frac). So the ray through a fragment inside an
//     opening is followed into the wall: it meets the glass GLASS_DEPTH metres
//     in, or a jamb, the head or the sill on the way. The glass is sampled where
//     the ray meets it (the frame, bars and curtains slide against the opening
//     as you walk), a reveal is drawn in the wall's own paint with its own
//     normal, and the sun is traced back out of the opening, so the head and the
//     sun side jamb throw a real shadow across the glass. The metres come from
//     the screen derivatives of the uv and the view position (as PANE_GLOW_GLSL
//     does): no attribute, so a worker-built chunk needs nothing new.
//   * LEDGES. A cornice, a string course and a sill stand proud of the wall, so
//     each throws a shadow down it whose length is the sun's: short at noon,
//     long in the evening. Same trace, one axis.
//   * WEATHER. Plaster mottled over a few metres, faint vertical rain streaks,
//     grime under every sill, rising damp on the ground storey and soot under
//     the cornice. All of it hashed from world position and the cell, never
//     random: two clients and both tiers see the same dirt.
//   * GLASS. Day glass is dark (the room behind it is) and reflects the sky
//     with a Fresnel rise toward grazing, with a skyline of the street opposite
//     low in the reflection. The sky and ground tones are the hemisphere
//     light's own, so the reflection follows the time of day by itself.
//
// Both tiers run this: the far chunk wall (facadeatlas.buildFacadeMaterial)
// and the near shell's atlas boxes (destructible.shellMat) sample the same
// atlas address at the same world point, so the swap between them shows the
// same grime in the same place. The near shell's REAL openings never sample an
// opening rect, so they keep their real depth (pieces.js sets the pane at the
// same GLASS_DEPTH); its solid door and blank bays, which do, get the painted
// one. The near glass (destructible.mats) reflects the same sky.
//
// THE SWITCH. `facadeFx` in settings.js (off on the low preset, on above it)
// drives FACADE_FX once a frame through syncFacadeFx (facadeatlas.facadeNight
// calls it). For an A/B from the console, window.__atcFacade:
//   __atcFacade.fx(false)              everything off, as before this module
//   __atcFacade.fx(true, false, true)  depth and glass, no weather
//   __atcFacade.fx()                   back to what the preset says
//   __atcFacade.cull(false) / .merge(false)   the near shell's two savings
//                                      (destructible.js), for the draw counts

import * as THREE from 'three';
import { ATLAS_N, ATLAS_M, BAYS, CELL_LIST, FAMILIES, PANEL_BALC, HOUSE_BLANK,
  GLASS_DEPTH } from './typologycells.js';

// The preset is read through a dynamic import, on the page only: meshes.js
// imports facadeatlas.js, which imports this, so a static import would drag
// the settings panel (and its name tags) into every mesh worker. Until it
// resolves, the switch reads as on, which is what the default preset says.
let _settings = null;
if (typeof window !== 'undefined')
  import('./settings.js').then((m) => { _settings = m.getSettings; }, () => {});
const presetOn = () => (_settings ? _settings().facadeFx !== false : true);

// x: window depth and ledges, y: weather, z: glass reflection, w: reflection gain.
export const FACADE_FX = { value: new THREE.Vector4(1, 1, 1, 2.6) };
export function setFacadeFx(depth = true, weather = true, glass = true) {
  FACADE_FX.value.x = depth ? 1 : 0;
  FACADE_FX.value.y = weather ? 1 : 0;
  FACADE_FX.value.z = glass ? 1 : 0;
}
let _override = null;          // [depth, weather, glass] from the console, or null
/** Once a frame: the preset decides, unless the console has taken over. */
export function syncFacadeFx() {
  if (_override) return;
  const on = presetOn();
  if ((FACADE_FX.value.x > 0.5) !== on || (FACADE_FX.value.y > 0.5) !== on || (FACADE_FX.value.z > 0.5) !== on)
    setFacadeFx(on, on, on);
}
/** The console handle (see the header). destructible.js adds cull and merge. */
export const facadeFxApi = {
  fx(depth, weather = depth, glass = depth) {
    if (depth === undefined) { _override = null; syncFacadeFx(); }
    else { _override = [!!depth, !!weather, !!glass]; setFacadeFx(..._override); }
    return this.state();
  },
  state() {
    const v = FACADE_FX.value;
    return { depth: v.x > 0.5, weather: v.y > 0.5, glass: v.z > 0.5, console: !!_override,
      preset: presetOn() };
  },
};
if (typeof window !== 'undefined') window.__atcFacade = facadeFxApi;

const ROLE = { mid: 0, ground: 1, top: 2, gable: 3, door: 4 };

// The ledges each cell paints, as the shadow they throw: the underside's height
// in the storey (0 floor, 1 ceiling; above 1 means the band at the foot of the
// storey above) and how far it stands out. Read off the painter in
// facadeatlas.js (tenement's floor line is CH-9..CH-3 px of the storey above,
// its cornice the top 13 %, a block's coping the top 14 px).
function ledgeOf(fam, role, v) {
  if (fam === 'tenement') return role === 'top' ? [0.87, 0.34] : role === 'ground' ? [0.965, 0.12] : [1.012, 0.08];
  if (fam === 'civic') return [1.012, 0.07];
  if (fam === 'block') return role === 'top' && v === 0 ? [0.945, 0.16] : [0, 0];
  if (fam === 'brick' && v === 2) return [1.012, 0.06];
  if (fam === 'panel' && role === 'top') return [0.86, 0.05];
  return [0, 0];
}
// how far a painted sill stands proud (metres); the store, the offices and the
// novostavba paint none
const SILL = { panel: 0.05, tenement: 0.07, block: 0.06, functional: 0.04, house: 0.06,
  brick: 0.06, civic: 0.06 };

/**
 * The per-cell table, (ATLAS_N x ATLAS_M) x 2 RGBA floats, one column per atlas
 * cell (index ci + ri * ATLAS_N, the painter's own order):
 *   row 0: band0, band1, frac, blank-bay mask + sill projection (mask 0..15 in
 *          the integer part, metres in the fraction)
 *   row 1: role (0 mid, 1 ground, 2 top, 3 gable, 4 door), glass depth (0: no
 *          openings), ledge height in the storey, ledge projection
 * Pure data: the test checks it without a GPU.
 */
export function cellTable() {
  const N = ATLAS_N * ATLAS_M, d = new Float32Array(N * 2 * 4);
  for (const c of CELL_LIST) {
    const F = FAMILIES[c.fam], i = c.ci + c.ri * ATLAS_N;
    let mask = 0;
    if (c.fam === 'house') HOUSE_BLANK[c.v].forEach((b, k) => { if (b) mask |= 1 << k; });
    // a loggia bay: the painted board stands in front of the window, so the
    // bay is not traced as an opening (pieces.js hangs real balconies there)
    if (c.fam === 'panel' && c.role === 'mid') PANEL_BALC[c.v].forEach((b, k) => { if (b) mask |= 1 << k; });
    const open = !F.solid && F.band && c.role !== 'gable' && c.role !== 'door';
    const sill = SILL[c.fam] ?? 0;               // (the shader skips it on a blank bay)
    const [ly, lp] = ledgeOf(c.fam, c.role, c.v);
    d.set([F.band?.[0] ?? 0, F.band?.[1] ?? 0, F.frac ?? 0, mask + Math.min(0.09, sill)], i * 4);
    d.set([ROLE[c.role] ?? 0, open ? (GLASS_DEPTH[c.fam] ?? 0.15) : 0, ly, lp], (N + i) * 4);
  }
  return d;
}

let _tab = null;
export function cellTexture() {
  if (_tab) return _tab;
  const t = new THREE.DataTexture(cellTable(), ATLAS_N * ATLAS_M, 2, THREE.RGBAFormat, THREE.FloatType);
  t.magFilter = t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return (_tab = t);
}

/** Uniforms the chunk below needs; merge into a shader's uniforms. */
export const fxUniforms = () => ({ uFx: FACADE_FX, uCellTab: { value: cellTexture() } });

const f1 = (n) => n.toFixed(1);
const NB = ATLAS_N * BAYS;                       // bays across the atlas

// Declarations, after lights_pars_begin (so the sun and the sky are in scope):
// put it in place of '#include <lights_lambert_pars_fragment>' + that include.
export const FX_PARS = /* glsl */`
  uniform vec4 uFx;
  uniform highp sampler2D uCellTab;
  float fxHash(vec2 p) {
    p = fract(p * vec2(0.1031, 0.1030));
    p += dot(p, p.yx + 33.33);
    return fract((p.x + p.y) * p.y);
  }
  float fxNoise(vec2 p) {
    vec2 i = floor(p), w = fract(p);
    w = w * w * (3.0 - 2.0 * w);
    return mix(mix(fxHash(i), fxHash(i + vec2(1.0, 0.0)), w.x),
      mix(fxHash(i + vec2(0.0, 1.0)), fxHash(i + vec2(1.0, 1.0)), w.x), w.y);
  }
  // inside [lo, hi] with a soft edge of e (the shadow's penumbra)
  float fxIn(float x, float lo, float hi, float e) {
    return smoothstep(lo - e, lo + e, x) * (1.0 - smoothstep(hi - e, hi + e, x));
  }
  // What the shading needs from the trace, kept for the light stage. Every one
  // starts at the value that changes nothing: a roof, a pin texel or an
  // interior box that never reaches the trace is lit exactly as before.
  vec2 fxUv = vec2(0.0); float fxSun = 1.0; float fxAo = 1.0; float fxGlassK = 0.0; float fxKind = 0.0;
  vec4 fxW = vec4(0.0); vec4 fxI = vec4(0.0); vec2 fxF = vec2(0.0); float fxBay = 0.0;   // the cell
  float fxWm = 0.0, fxHm = 0.0;                   // one bay and one storey, metres
  float fxMpp = 0.0;                              // metres a pixel spans here
  vec3 fxTn = vec3(1.0, 0.0, 0.0), fxBn = vec3(0.0, 1.0, 0.0);
  vec3 fxWp = vec3(0.0), fxWn = vec3(0.0, 1.0, 0.0);   // world position and normal
  float fxSkip = 0.0;                             // 1: no weather (an interior piece)

  // Follow the ray through this fragment into the wall. uv: the atlas address,
  // P: view-space position, N: view-space normal. Sets fxUv (where to sample
  // the atlas), fxKind (0 glass or wall, 1/2 a jamb, 3 the head, 4 the sill),
  // fxSun and fxAo. Derivatives are taken by the caller, outside any branch.
  void fxTrace(vec2 uv, vec3 P, vec3 N, vec3 dPx, vec3 dPy, vec2 dUx, vec2 dUy) {
    fxUv = uv;
    vec2 cc = floor(uv * vec2(${f1(ATLAS_N)}, ${f1(ATLAS_M)}));
    int ci = int(cc.x) + (${ATLAS_M - 1} - int(cc.y)) * ${ATLAS_N};
    if (ci < 0 || ci > ${ATLAS_N * ATLAS_M - 1}) return;
    fxW = texelFetch(uCellTab, ivec2(ci, 0), 0);
    fxI = texelFetch(uCellTab, ivec2(ci, 1), 0);
    fxF = fract(uv * vec2(${f1(ATLAS_N)}, ${f1(ATLAS_M)}));
    fxBay = floor(fxF.x * ${f1(BAYS)});
    float det = dUx.x * dUy.y - dUx.y * dUy.x;
    if (abs(det) < 1e-16) return;                    // a cut edge: one texel, no frame
    vec3 T = (dPx * dUy.y - dPy * dUx.y) / det;      // metres per unit of u, along the wall
    vec3 B = (dPy * dUx.x - dPx * dUy.x) / det;      // and of v, up it
    fxWm = length(T) / ${f1(NB)}; fxHm = length(B) / ${f1(ATLAS_M)};
    if (fxWm < 0.4 || fxHm < 0.4 || fxWm > 14.0 || fxHm > 14.0) { fxWm = 0.0; return; }
    fxTn = T / length(T); fxBn = B / length(B);
    if (uFx.x < 0.5) return;
    // under ~6 px a bay it would only shimmer: fade to the flat paint
    float bpp = max(length(dUx), length(dUy)) * ${f1(NB)};
    float fade = 1.0 - smoothstep(0.09, 0.2, bpp);
    vec3 L = vec3(0.0, 1.0, 0.0);
    #if NUM_DIR_LIGHTS > 0
      L = directionalLights[0].direction;
    #endif
    float ln = dot(L, N);
    vec2 lt = vec2(dot(L, fxTn), dot(L, fxBn)) / max(ln, 0.06) / vec2(fxWm, fxHm);   // per metre out
    float bx = fract(fxF.x * ${f1(BAYS)}), fy = fxF.y;
    // ---- ledges: the band's underside throws its shadow down the wall ----
    if (fxI.w > 0.0 && lt.y > 0.0) {
      float len = fxI.w * lt.y;                      // shadow length, in storeys
      fxSun *= 1.0 - fade * fxIn(fy, fxI.z - len, fxI.z, 0.006) * step(0.0, ln);
    }
    float sillP = fract(fxW.w);
    float x0 = 0.5 - 0.5 * fxW.z, x1 = 0.5 + 0.5 * fxW.z;
    float blank = mod(floor(floor(fxW.w) / exp2(fxBay)), 2.0);
    if (sillP > 0.0 && lt.y > 0.0 && blank < 0.5) {
      float sb = fxW.x - 0.024, len = sillP * lt.y;  // the sill's underside (6 px under the glass)
      fxSun *= 1.0 - fade * fxIn(fy, sb - len, sb, 0.004) * fxIn(bx, x0 - 0.06, x1 + 0.06, 0.01) * step(0.0, ln);
    }
    float d = fxI.y;
    if (d <= 0.0 || blank > 0.5 || fade <= 0.0) return;
    if (bx < x0 || bx > x1 || fy < fxW.x || fy > fxW.y) return;
    // ---- inside an opening: where does the ray meet the glass? ----
    vec3 E = normalize(-P);
    float en = max(dot(E, N), 0.08);
    vec2 off = -d * vec2(dot(E, fxTn), dot(E, fxBn)) / en / vec2(fxWm, fxHm) * fade;
    vec2 g = vec2(bx, fy) + off;
    float sx = 2.0, sy = 2.0, kx = 0.0, ky = 0.0;
    if (g.x < x0) { sx = (x0 - bx) / off.x; kx = 1.0; }
    if (g.x > x1) { sx = (x1 - bx) / off.x; kx = 2.0; }
    if (g.y > fxW.y) { sy = (fxW.y - fy) / off.y; ky = 3.0; }
    if (g.y < fxW.x) { sy = (fxW.x - fy) / off.y; ky = 4.0; }
    float s = min(min(sx, sy), 1.0);
    vec2 h = vec2(bx, fy) + off * s;                 // where the ray stops
    float dh = d * s * fade;                         // ...this deep
    vec3 FN = N;
    if (s < 1.0) {
      fxKind = sx < sy ? kx : ky;
      FN = fxKind == 1.0 ? fxTn : fxKind == 2.0 ? -fxTn : fxKind == 3.0 ? -fxBn : fxBn;
      // a reveal wears the plaster just outside the opening
      vec2 pj = fxKind < 2.5 ? vec2(fxKind == 1.0 ? x0 - 0.035 : x1 + 0.035, clamp(h.y, fxW.x + 0.02, fxW.y - 0.02))
                             : vec2(clamp(h.x, x0 + 0.02, x1 - 0.02), fxKind == 3.0 ? fxW.y + 0.03 : fxW.x - 0.04);
      fxUv = (cc + vec2((fxBay + clamp(pj.x, 0.002, 0.998)) / ${f1(BAYS)}, clamp(pj.y, 0.002, 0.998)))
        / vec2(${f1(ATLAS_N)}, ${f1(ATLAS_M)});
      fxAo = fxKind == 3.0 ? 0.5 : fxKind == 4.0 ? 0.95 : 0.72;
    } else {
      fxUv = uv + off * vec2(${(1 / NB).toFixed(6)}, ${(1 / ATLAS_M).toFixed(6)});
      // the corners of a deep opening see less sky
      float ex = min(h.x - x0, x1 - h.x) * fxWm, ey = min(h.y - fxW.x, fxW.y - h.y) * fxHm;
      fxAo = 0.62 + 0.38 * smoothstep(0.0, 0.35, min(ex, ey));
    }
    // ---- the sun, traced back out through the opening ----
    vec2 e = h + dh * lt;
    float out_ = fxIn(e.x, x0, x1, 0.008) * fxIn(e.y, fxW.x, fxW.y, 0.008);
    float face = s < 1.0 ? clamp(max(dot(L, FN), 0.0) / max(ln, 0.06), 0.0, 3.0) : 1.0;
    fxSun *= mix(1.0, out_ * face, fade);
    fxAo = mix(1.0, fxAo, fade);
  }

  // Dirt, by cell and world position. col: the lit-free surface colour.
  vec3 fxWeather(vec3 col, vec3 wp, vec3 wn) {
    if (uFx.y < 0.5 || fxSkip > 0.5) return col;
    float wall = (1.0 - smoothstep(0.45, 0.75, abs(wn.y))) * (1.0 - fxGlassK);
    if (wall <= 0.0) return col;
    vec2 hd = normalize(vec2(-wn.z, wn.x) + vec2(1e-5, 0.0));
    float a = dot(wp.xz, hd);
    // the fine terms fade out as a pixel grows past them: they would crawl
    float fine = 1.0 - smoothstep(0.12, 0.35, fxMpp);
    float m = fxNoise(vec2(a, wp.y) * 0.29) * 0.65
      + mix(0.5, fxNoise(vec2(a, wp.y) * 1.13 + 17.0), 1.0 - smoothstep(0.3, 0.8, fxMpp)) * 0.35;
    vec3 c = col * (0.93 + 0.13 * m)
      * mix(vec3(1.03, 1.0, 0.96), vec3(0.975, 0.995, 1.025), fxNoise(vec2(a * 0.06 + wp.y * 0.02, 3.7)));
    // rain streaks: thin, vertical, and only here and there
    float st = smoothstep(0.58, 1.0, fxNoise(vec2(a * 2.1, wp.y * 0.055)))
      * (0.4 + 0.6 * fxNoise(vec2(a * 0.37, wp.y * 0.3 + 5.0)));
    c *= 1.0 - 0.13 * st * fine;
    if (fxWm > 0.0) {
      float bx = fract(fxF.x * ${f1(BAYS)}), fy = fxF.y;
      float x0 = 0.5 - 0.5 * fxW.z, x1 = 0.5 + 0.5 * fxW.z;
      float blank = mod(floor(floor(fxW.w) / exp2(fxBay)), 2.0);
      // the run-off under a sill spreads and fades down the wall
      if (fxW.z > 0.0 && blank < 0.5 && fy < fxW.x) {
        float below = (fxW.x - fy) * fxHm;
        float w = fxIn(bx, x0 + 0.02, x1 - 0.02, 0.05 + 0.02 * below);
        c *= 1.0 - 0.16 * w * exp(-below * 1.3) * (0.55 + 0.45 * fxNoise(vec2(a * 3.0, wp.y * 0.8)));
      }
      // rising damp and splash-back at the foot of the ground storey
      if (fxI.x == 1.0) {
        float up = fy * fxHm;
        c *= 1.0 - 0.2 * (1.0 - smoothstep(0.0, 0.9 + 0.4 * fxNoise(vec2(a * 0.8, 1.0)), up));
      }
      // soot in the lee of a cornice
      if (fxI.x == 2.0 && fxI.z > 0.0 && fxI.z < 1.0) {
        float under = (fxI.z - fy) * fxHm;
        c *= 1.0 - 0.14 * step(0.0, under) * exp(-under * 2.2);
      }
    }
    return mix(col, c, wall);
  }

  // Sky in a pane: radiance off a dark glass, Fresnel-weighted. N, E view space;
  // wp, wn world space.
  vec3 fxReflect(vec3 N, vec3 E, vec3 wp, vec3 wn) {
    vec3 sky = vec3(0.5), gnd = vec3(0.12), up = vec3(0.0, 1.0, 0.0);
    #if NUM_HEMI_LIGHTS > 0
      sky = hemisphereLights[0].skyColor; gnd = hemisphereLights[0].groundColor;
      up = hemisphereLights[0].direction;
    #endif
    vec3 R = reflect(-E, N);
    float ry = dot(R, up);
    vec3 col = mix(gnd * 0.55, sky * mix(0.8, 1.25, smoothstep(0.0, 0.7, ry)), smoothstep(-0.12, 0.25, ry));
    // the street opposite: a ragged skyline, darker than the sky over it
    vec2 hd = normalize(vec2(-wn.z, wn.x) + vec2(1e-5, 0.0));
    vec3 Rw = R * mat3(viewMatrix);
    float a = dot(wp.xz, hd) + 14.0 * dot(Rw.xz, hd) / max(abs(dot(Rw, wn)), 0.2);
    float sl = 0.07 + 0.3 * fxNoise(vec2(floor(a / 7.0) * 1.7, 2.0));
    col = mix(col, gnd * 0.9 + sky * 0.12, (1.0 - smoothstep(sl - 0.01, sl + 0.01, ry)) * 0.85);
    float en = clamp(dot(E, N), 0.0, 1.0);
    float F = 0.04 + 0.96 * pow(1.0 - en, 5.0);
    return col * RECIPROCAL_PI * F * uFx.w;
  }
`;

// The wall sample, in place of the atlas lookup. Needs vMapUv, vNormal,
// vViewPosition and the four derivatives fxDPx, fxDPy (of the view position,
// -vViewPosition) and fxDUx, fxDUy (of vMapUv), taken outside any branch.
// Leaves vec4 fxTex: the paint at the point the ray meets, darkened where it
// is glass and weathered where it is wall.
export const FX_MAP = /* glsl */`
  vec4 fxTex;
  {
    vec3 fxN = normalize(vNormal), fxP = -vViewPosition;
    fxMpp = max(length(fxDPx), length(fxDPy));
    fxTrace(vMapUv, fxP, fxN, fxDPx, fxDPy, fxDUx, fxDUy);
    fxTex = textureGrad(map, fxUv, fxDUx, fxDUy);
    fxGlassK = smoothstep(0.1, 0.35, fxTex.a) * step(fxKind, 0.5) * uFx.z;
    fxWp = cameraPosition + fxP * mat3(viewMatrix);
    fxWn = fxN * mat3(viewMatrix);
    fxTex.rgb = fxWeather(fxTex.rgb * (1.0 - 0.5 * fxGlassK), fxWp, fxWn);
  }
`;

// After the lights, before '#include <aomap_fragment>': the traced sun and
// sky, and the reflection in the glass.
export const FX_LIGHT = /* glsl */`
  reflectedLight.directDiffuse *= fxSun;
  reflectedLight.indirectDiffuse *= fxAo;
  if (fxGlassK > 0.0)
    reflectedLight.indirectDiffuse += fxReflect(normal, normalize(vViewPosition), fxWp, fxWn) * fxGlassK;
`;

// The atlas wall's map stage for a material that has no custom one (the near
// shell): derivatives, the trace and the weathered sample.
export const FX_MAP_FRAGMENT = /* glsl */`
  #ifdef USE_MAP
    vec3 fxDPx = -dFdx(vViewPosition), fxDPy = -dFdy(vViewPosition);
    vec2 fxDUx = dFdx(vMapUv), fxDUy = dFdy(vMapUv);
    ${FX_MAP}
    diffuseColor.rgb *= fxTex.rgb;
  #endif
`;
