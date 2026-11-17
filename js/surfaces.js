// ---- the ground, made rather than photographed --------------------------
// Until now the world's floor was an aerial photograph, and a photograph has
// two problems that no amount of resolution fixes.
//
// It does not know what it is looking at. A photograph of a wood is green
// pixels; it cannot tell you the ground under the canopy is leaf litter, so
// nothing can react to it. And it has no THIRD DIMENSION — no roughness, no
// normal, no glint of wet tarmac at dusk. Everything was equally matte because
// everything was the same flat Lambert surface with a picture on it.
//
// And the one that decided it: a photograph is taken from above, so it has no
// idea what is UNDER A BRIDGE. Where the deck crosses, the photo shows the deck
// and the ground beneath it inherits the same pixels — a road running under a
// flyover was carpeted with a picture of the flyover. Ground that is inferred
// instead of photographed simply has an answer there, because it was never
// looking down in the first place.
//
// So: every surface class in the city gets a real material — albedo, normal and
// roughness — synthesised here from noise, tileable, and shipped as a texture
// ARRAY so the whole ground still draws in one call. The class comes down the
// geometry as a per-vertex index, the tint stays in the vertex colours the
// meshes already carry, and the shader multiplies the two. That keeps every bit
// of per-feature colour variation that was already there (a beech wood and a
// spruce plantation are different greens) and adds the surface under it.
//
// Nothing is fetched. The whole ground of the country is about 3 MB of texture
// generated in a few hundred milliseconds at startup, and it works offline, at
// any zoom, under any bridge.

import * as THREE from '../libs/three.module.js';
import { NOISE_GLSL, WRAP_GLSL, GROUND_DETAIL } from './groundglsl.js';
import { STREET_DETAIL_GLSL } from './streetdetail.js';

// ---- the classes -----------------------------------------------------------
// Layer indices into the texture arrays. The order is the order they are
// synthesised in; nothing else depends on it.
export const SURF = {
  grass: 0,        // mown, watered — parks, gardens, verges
  meadow: 1,       // taller, drier, yellower — scrub, heath, unmown field
  forest: 2,       // leaf litter and moss under a canopy
  farm: 3,         // ploughed earth in furrows
  dirt: 4,         // bare earth, riverbank, building site
  gravel: 5,       // loose stone — tracks, paths, sidings
  asphalt: 6,      // carriageway
  concrete: 7,     // poured slab — plazas, car parks, kerbs
  paving: 8,       // rectangular slabs, the Czech pavement
  cobble: 9,       // setts, historic squares
  ballast: 10,     // railway crushed stone
  paint: 11,       // road markings: flat, bright, barely textured
  pavers: 12,      // small concrete pavers in running bond: the Czech street pavement
};
export const SURF_COUNT = 13;

// How many metres of world one repeat of the texture covers, per class. Small
// enough that the detail reads at walking pace, large enough that the tiling
// does not beat at driving speed — the macro noise in the shader breaks up what
// is left.
const SCALE = new Float32Array([
  6, 8, 5, 12, 6, 3, 4, 5, 2.4, 1.6, 2.5, 4, 2.0,
]);

// Base roughness per class. Wet asphalt is the one thing here that is allowed
// to be shiny, and only just: 0.62 at its smoothest still scatters most of what
// hits it, which is what a road does.
const ROUGH = new Float32Array([
  0.94, 0.96, 0.97, 0.95, 0.93, 0.95, 0.72, 0.86, 0.82, 0.80, 0.94, 0.68, 0.84,
]);

const RES = 256;                 // px per layer — 3.1 MB per array at RGBA8

// ---- tileable value noise --------------------------------------------------
// The lattice wraps at `period`, so every octave is seamless and so is their
// sum. This is the whole reason the textures can tile at all; a plain hash of
// unwrapped coordinates would show a visible seam every RES pixels, and on a
// ground plane that is a grid you can see from a helicopter.

function hash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const fade = (t) => t * t * (3 - 2 * t);

function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const w = (v) => ((v % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  const u = fade(xf), v = fade(yf);
  const a = hash(x0, y0, seed), b = hash(x1, y0, seed);
  const c = hash(x0, y1, seed), d = hash(x1, y1, seed);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * v;
}

/** Sum of octaves, each wrapping at its own period so the total still tiles. */
function fbm(x, y, base, octaves, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, p = base;
  for (let o = 0; o < octaves; o++) {
    sum += vnoise((x * p) / RES, (y * p) / RES, p, seed + o * 977) * amp;
    norm += amp;
    amp *= gain;
    p *= 2;
  }
  return sum / norm;
}

/** Distance-to-nearest-feature-point on a wrapping grid — cells, cracks, setts. */
function worley(x, y, cells, seed) {
  const fx = (x / RES) * cells, fy = (y / RES) * cells;
  const cx = Math.floor(fx), cy = Math.floor(fy);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const gx = cx + i, gy = cy + j;
      const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
      const px = gx + hash(wx, wy, seed), py = gy + hash(wx, wy, seed + 7919);
      const d = (px - fx) ** 2 + (py - fy) ** 2;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}

// ---- the classes, one function each ---------------------------------------
// Each returns { r, g, b, h } in 0..1 for a pixel: colour and a HEIGHT that the
// normal map is differentiated out of. Writing height rather than a normal
// directly is what makes the normals consistent with the colour — the bump is
// the same feature the eye sees, not a second unrelated noise field.

const mix = (a, b, t) => a + (b - a) * t;

function px(layer, x, y) {
  switch (layer) {
    case SURF.grass: {
      // Blades at two scales plus a slow patchiness, so mown grass reads as a
      // surface and not as green paper.
      const blade = fbm(x, y, 48, 3, 11);
      const patch = fbm(x, y, 6, 3, 23);
      const dry = fbm(x, y, 3, 2, 31);
      const t = blade * 0.55 + patch * 0.45;
      return {
        r: mix(0.22, 0.42, t) * mix(0.86, 1.1, dry),
        g: mix(0.34, 0.58, t) * mix(0.92, 1.06, dry),
        b: mix(0.14, 0.24, t),
        h: blade * 0.7 + patch * 0.3,
      };
    }
    case SURF.meadow: {
      const stalk = fbm(x, y, 32, 4, 41);
      const patch = fbm(x, y, 5, 3, 53);
      const t = stalk * 0.6 + patch * 0.4;
      return {
        r: mix(0.34, 0.58, t), g: mix(0.38, 0.60, t), b: mix(0.18, 0.28, t),
        h: t,
      };
    }
    case SURF.forest: {
      // Leaf litter: broad soft patches of brown with darker hollows, plus the
      // odd bright fleck where light gets through.
      const litter = fbm(x, y, 24, 4, 61);
      const moss = fbm(x, y, 8, 3, 71);
      const fleck = Math.max(0, fbm(x, y, 64, 2, 83) - 0.72) * 3;
      return {
        r: mix(0.17, 0.34, litter) + fleck * 0.18,
        g: mix(0.15, 0.28, litter) * mix(0.9, 1.25, moss) + fleck * 0.2,
        b: mix(0.09, 0.16, litter),
        h: litter * 0.8 + fleck * 0.2,
      };
    }
    case SURF.farm: {
      // Furrows. A ploughed field is the one ground here with a DIRECTION, and
      // it is the direction that makes it read as farmed rather than as mud.
      const fur = 0.5 + 0.5 * Math.cos((y / RES) * Math.PI * 2 * 16);
      const clod = fbm(x, y, 40, 3, 91);
      const t = fur * 0.55 + clod * 0.45;
      return {
        r: mix(0.30, 0.46, t), g: mix(0.22, 0.34, t), b: mix(0.15, 0.23, t),
        h: t,
      };
    }
    case SURF.dirt: {
      const soil = fbm(x, y, 28, 4, 101);
      const stone = Math.max(0, worley(x, y, 22, 113) - 0.4);
      return {
        r: mix(0.31, 0.47, soil) + stone * 0.12,
        g: mix(0.25, 0.38, soil) + stone * 0.12,
        b: mix(0.19, 0.29, soil) + stone * 0.11,
        h: soil * 0.7 + stone * 0.3,
      };
    }
    case SURF.gravel: {
      // Loose stone: worley cells ARE the stones, and the cell edges are the
      // gaps between them, which is where the shadow lives.
      const d = worley(x, y, 26, 127);
      const stone = 1 - Math.min(1, d * 2.2);
      const tone = fbm(x, y, 30, 2, 131);
      const v = mix(0.34, 0.62, tone) * mix(0.7, 1, stone);
      return { r: v * 1.02, g: v, b: v * 0.94, h: stone };
    }
    case SURF.asphalt: {
      // Aggregate in bitumen: fine dense speckle, a few larger stones, and a
      // very slow lightness drift that reads as wear down the wheel tracks.
      // Chippings, at the size chippings are. The first pass had 40 worley
      // cells across a 4 m repeat, which is a 10 cm stone — that is not asphalt,
      // it is a farm track, and from a car it read as gravel.
      const grit = fbm(x, y, 150, 3, 149);
      const agg = Math.max(0, worley(x, y, 110, 151) - 0.25);
      const wear = fbm(x, y, 4, 2, 157);
      const v = mix(0.095, 0.14, grit) * mix(0.88, 1.14, wear) + agg * 0.04;
      return { r: v, g: v * 1.01, b: v * 1.06, h: grit * 0.55 + agg * 0.45 };
    }
    case SURF.concrete: {
      const grain = fbm(x, y, 80, 3, 163);
      const stain = fbm(x, y, 5, 3, 173);
      const v = mix(0.44, 0.60, grain) * mix(0.84, 1.06, stain);
      return { r: v, g: v * 0.99, b: v * 0.96, h: grain };
    }
    case SURF.paving: {
      // Czech pavement: rectangular slabs with a dark joint. The joint is a
      // straight-line grid, not noise — a paving stone is a manufactured thing
      // and the eye knows immediately when its edges wobble.
      const u = (x / RES) * 4, v = (y / RES) * 8;
      const ju = Math.abs(((u % 1) + 1) % 1 - 0.5), jv = Math.abs(((v % 1) + 1) % 1 - 0.5);
      const joint = Math.min(1, Math.min(0.5 - ju, 0.5 - jv) * 22);
      const slab = hash(Math.floor(u), Math.floor(v), 179);
      const grain = fbm(x, y, 72, 2, 181);
      const t = mix(0.52, 0.68, slab * 0.5 + grain * 0.5);
      const c = mix(0.30, t, joint);
      return { r: c, g: c * 0.99, b: c * 0.95, h: joint * 0.85 + grain * 0.15 };
    }
    case SURF.cobble: {
      // Granite setts: ten-centimetre cubes laid in ROWS, each row half a stone
      // off the last. They used to be worley cells, which is a riverbed, not a
      // street: a sett is cut, and what the eye reads is the courses. Every
      // stone its own grey, domed a little, sunk at the joints.
      const N = 16, row = Math.floor((y / RES) * N);
      const u = (x / RES) * N + (row & 1 ? 0.5 : 0);
      const col = ((Math.floor(u) % N) + N) % N;
      const fx = u - Math.floor(u), fy = (y / RES) * N - row;
      // each stone a touch narrower or wider than its neighbour, as cut stone is
      const edge = Math.min(Math.min(fx, 1 - fx), Math.min(fy, 1 - fy)) * 2;
      const joint = Math.min(1, Math.max(0, edge / 0.24));
      const dome = joint * (0.72 + 0.28 * (1 - ((fx - 0.5) ** 2 + (fy - 0.5) ** 2) * 2.4));
      const stone = hash(col, row, 193);
      const grain = fbm(x, y, 96, 2, 195);
      const v = mix(0.27, 0.47, stone * 0.75 + grain * 0.25) * mix(0.42, 1, joint);
      return { r: v * 1.03, g: v, b: v * 0.96, h: dome };
    }
    case SURF.pavers: {
      // Zámková dlažba: 20 x 10 cm concrete pavers in running bond, the surface
      // of nearly every Czech pavement laid since the nineties. Small, grey,
      // tight-jointed; what tells it from a slab is the rhythm, so the joint is
      // thin and the stones barely differ.
      const NU = 10, NV = 20, row = Math.floor((y / RES) * NV);
      const u = (x / RES) * NU + (row & 1 ? 0.5 : 0);
      const col = ((Math.floor(u) % NU) + NU) % NU;
      const fx = u - Math.floor(u), fy = (y / RES) * NV - row;
      const e = Math.min(Math.min(fx, 1 - fx) * (RES / NU), Math.min(fy, 1 - fy) * (RES / NV));
      const joint = Math.min(1, Math.max(0, (e - 0.25) / 1.1));
      const stone = hash(col, row, 221);
      const grain = fbm(x, y, 90, 2, 223);
      const t = mix(0.50, 0.63, stone * 0.6 + grain * 0.4);
      const c = mix(0.31, t, joint);
      return { r: c, g: c * 0.995, b: c * 0.97, h: joint * 0.8 + grain * 0.2 };
    }
    case SURF.ballast: {
      const d = worley(x, y, 30, 197);
      const stone = 1 - Math.min(1, d * 2.4);
      const v = mix(0.24, 0.44, fbm(x, y, 34, 2, 199)) * mix(0.6, 1, stone);
      return { r: v * 1.04, g: v, b: v * 0.92, h: stone };
    }
    default: {  // SURF.paint — thermoplastic: almost flat, faintly gritty
      const grit = fbm(x, y, 110, 2, 211);
      const v = mix(0.86, 0.98, grit);
      return { r: v, g: v, b: v * 0.97, h: grit * 0.25 };
    }
  }
}

// ---- synthesis -------------------------------------------------------------

let _albedo = null, _normal = null, _built = false;

/**
 * Fill both arrays. About 800 k pixels of noise; measured at ~250 ms on this
 * machine, paid once, and worth doing before the first frame rather than
 * hitching a chunk build later.
 */
function build() {
  if (_built) return;
  _built = true;
  const n = RES * RES;
  const alb = new Uint8Array(n * 4 * SURF_COUNT);
  const nrm = new Uint8Array(n * 4 * SURF_COUNT);
  const h = new Float32Array(n);
  const rgb = new Float32Array(n * 3);
  for (let L = 0; L < SURF_COUNT; L++) {
    const off = L * n * 4;
    let mean = 0;
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const i = y * RES + x;
        const p = px(L, x, y);
        h[i] = p.h;
        rgb[i * 3] = p.r; rgb[i * 3 + 1] = p.g; rgb[i * 3 + 2] = p.b;
        mean += 0.2126 * p.r + 0.7152 * p.g + 0.0722 * p.b;
      }
    }
    // ---- normalise each layer to a MEAN of 0.5 ----
    // The texture is a modulation, not a replacement. Every surface in this
    // world already has a colour that was tuned by eye — five greens for five
    // kinds of green space, nine greys down the road hierarchy — and throwing
    // that away for whatever tone the noise happened to average to would be a
    // straight loss. Divided by its own mean, a layer contributes only its
    // STRUCTURE: the mottling, the aggregate, the joint between two slabs, the
    // relative hue shift of a dry patch. The vertex colour still says what
    // green it is. The shader multiplies by two to undo the halving.
    mean = Math.max(1e-4, mean / n);
    const k = 0.5 / mean;
    for (let i = 0; i < n; i++) {
      alb[off + i * 4] = Math.max(0, Math.min(255, rgb[i * 3] * k * 255)) | 0;
      alb[off + i * 4 + 1] = Math.max(0, Math.min(255, rgb[i * 3 + 1] * k * 255)) | 0;
      alb[off + i * 4 + 2] = Math.max(0, Math.min(255, rgb[i * 3 + 2] * k * 255)) | 0;
      alb[off + i * 4 + 3] = 255;
    }
    // Normals by central difference on the height field, wrapping — the same
    // wrap the noise uses, so the normal map tiles exactly as the colour does.
    // Alpha carries roughness: the base for the class, modulated by height, so
    // the tops of the aggregate are polished and the hollows are not. That is
    // what makes a road look driven-on rather than freshly poured.
    const S = 2.2;                                  // bump strength
    for (let y = 0; y < RES; y++) {
      for (let x = 0; x < RES; x++) {
        const i = y * RES + x;
        const l = h[y * RES + ((x + RES - 1) % RES)], r = h[y * RES + ((x + 1) % RES)];
        const u = h[((y + RES - 1) % RES) * RES + x], d = h[((y + 1) % RES) * RES + x];
        let nx = (l - r) * S, ny = (u - d) * S, nz = 1;
        const inv = 1 / Math.hypot(nx, ny, nz);
        nx *= inv; ny *= inv; nz *= inv;
        nrm[off + i * 4] = ((nx * 0.5 + 0.5) * 255) | 0;
        nrm[off + i * 4 + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
        nrm[off + i * 4 + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
        nrm[off + i * 4 + 3] = Math.max(0, Math.min(255,
          (ROUGH[L] * (1 - 0.18 * h[i]) * 255) | 0));
      }
    }
  }
  _albedo = new THREE.DataArrayTexture(alb, RES, RES, SURF_COUNT);
  _normal = new THREE.DataArrayTexture(nrm, RES, RES, SURF_COUNT);
  for (const t of [_albedo, _normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.needsUpdate = true;
  }
  // NOT sRGB: this is a multiplier, and a multiplier lives in linear space.
  _albedo.colorSpace = THREE.NoColorSpace;
}

// ---- the material ----------------------------------------------------------
// A stock MeshStandardMaterial with three injections. Everything three does for
// lighting, shadows, fog and tone mapping is left alone; what changes is where
// the albedo, the normal and the roughness come from.
//
// The surface class arrives as a per-vertex attribute and is passed through as
// an ordinary varying rather than a flat one — every vertex of a triangle
// carries the same class, so interpolating it is a no-op, and it saves needing
// GLSL3-only qualifiers in a shader three also compiles for its own purposes.

export function surfaceMaterial() {
  build();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
    metalness: 0,
  });
  mat.defines = { ...(mat.defines || {}), USE_UV: '' };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uAlbedo = { value: _albedo };
    shader.uniforms.uNormalArr = { value: _normal };
    shader.uniforms.uScale = { value: SCALE };
    shader.uniforms.uGroundDetail = GROUND_DETAIL;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float surf;
        varying float vSurf;
        varying vec2 vWorldXZ;
        varying float vWorldY;
        ${WRAP_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vSurf = surf;
        vec4 atcWorld = modelMatrix * vec4(position, 1.0);
        // (wrapped: see js/groundglsl.js, the textures were a mosaic in Prague)
        vWorldXZ = atcWrapXZ(position);
        vWorldY = atcWorld.y;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2DArray uAlbedo;
        uniform sampler2DArray uNormalArr;
        uniform float uScale[${SURF_COUNT}];
        varying float vSurf;
        varying vec2 vWorldXZ;
        varying float vWorldY;

        uniform float uGroundDetail;
        // atcHash / atcNoise / atcUnit: js/groundglsl.js
        ${NOISE_GLSL}
        // A second, very slow noise that multiplies the albedo. Without it a
        // texture repeating every few metres beats into a visible grid the
        // moment you get above the rooftops — this is 30 m across and costs
        // four texture-free instructions.
        float macroNoise(vec2 p) { return atcNoise(p); }
        // Distance between the two nearest feature points of a jittered grid:
        // zero along the borders between cells, which is where tarmac cracks.
        float atcCrack(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          float d1 = 8.0, d2 = 8.0;
          for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
            vec2 g = vec2(float(x), float(y));
            vec2 r = g + vec2(atcHash(i + g), atcHash(i + g + 57.0)) - f;
            float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
          }
          return sqrt(d2) - sqrt(d1);
        }
        ${STREET_DETAIL_GLSL}
`)
      .replace('#include <map_fragment>', `
        // what the surface detail below hands on to the roughness and the
        // normal: how much smoother than its class this point is, and how much
        // of the class's bump it keeps
        float atcSmooth = 0.0;
        float atcBump = 1.0;
        // Where the texture is looked up. The ground is mapped straight down,
        // which is right for ground and a smear on anything that stands up: a
        // kerb face has ONE world (x, z) all the way down it, so the map drew
        // its top row of pixels as stripes, the barcode on every kerb and wall.
        // A face that stands is mapped along its own run and up its height.
        vec2 atcST = vWorldXZ;
        {
          vec3 wn = inverseTransformDirection(normalize(vNormal), viewMatrix);
          if (abs(wn.y) < 0.55) {
            vec2 along = normalize(vec2(-wn.z, wn.x));
            atcST = vec2(dot(vWorldXZ, along), vWorldY);
            atcBump = 0.0;
          }
        }
        {
          float layer = floor(vSurf + 0.5);
          vec4 texel = texture(uAlbedo, vec3(atcST / uScale[int(layer)], layer));
          float macro = 0.82 + 0.36 * macroNoise(vWorldXZ * 0.033);
          vec3 tone = texel.rgb * 2.0 * macro;
          // The floor of a wood. Its colour comes down the vertices as the
          // MAP's green for woodland (a dark leaf green, chosen to be told from
          // a lawn from the air), and under a closed canopy, in shade all day,
          // that left the ground a green so dark it read as a hole between the
          // trunks at noon. What lies there is last year's leaves: paler than
          // living leaf, and brown. So this one class is lifted and pulled
          // toward litter; the canopy's shade still falls on it in full.
          // ONLY that dark fill, though (told by the vertex tint itself:
          // vColor, since three multiplies it in AFTER this chunk): the class
          // is also what scrub, a wood drawn without its trees and the
          // planted crown of a roundabout wear, in their own lighter greens,
          // and lifted the same way those came out the yellow of straw.
          if (layer > 1.5 && layer < 2.5) {
            float floorK = 1.0 - smoothstep(0.07, 0.11, dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722)));
            tone *= mix(vec3(1.0), vec3(2.2, 1.6, 1.4), floorK);
          }
          // metres of world one pixel covers here: everything fine fades out
          // before it can alias
          float px = max(fwidth(vWorldXZ.x), fwidth(vWorldXZ.y));
          if (layer > 5.5 && layer < 6.5) {
            // ---- asphalt that has been driven on -----------------------------
            // A 4 m tile of chippings is right at walking distance and a visible
            // grid from a car, and nothing about it says the road is USED. So:
            vec2 w = vWorldXZ;
            // the same chippings again, turned and at a scale that never lines
            // up with the first: the product has no period the eye can find
            vec2 w2 = vec2(w.x * 0.8 - w.y * 0.6, w.x * 0.6 + w.y * 0.8) / 1.37;
            tone *= mix(1.0, texture(uAlbedo, vec3(w2 / uScale[6], layer)).g * 2.0, 0.42);
            // patches: a newer, blacker lay here, an old bleached one there,
            // with the hard edge a repair has (9 m blobs, ragged at 1.6 m)
            float pn = atcNoise(w * 0.085 + 31.7) + 0.3 * atcNoise(w * 0.61 + 3.1);
            float fresh = smoothstep(0.83, 0.86, pn);
            float old = 1.0 - smoothstep(0.36, 0.40, pn);
            tone *= 1.0 - 0.16 * fresh + 0.10 * old;
            atcSmooth += 0.08 * fresh - 0.05 * old;
            // cracks sealed with tar, in the stretches that have gone. A crack
            // is two centimetres wide, so it is drawn only while a pixel is
            // finer than that ACROSS it and fades out by 40 m: past there it
            // could only shimmer.
            vec2 fw = fwidth(w);
            float pxMin = min(fw.x, fw.y);
            if (px < 0.075) {
              // (and only in runs: a crack starts and stops, where a closed
              // net of them is dried mud)
              float gone = smoothstep(0.60, 0.74, atcNoise(w * 0.021 + 9.3)) * (1.0 - fresh)
                * smoothstep(0.50, 0.62, atcNoise(w * 0.37 + 21.0));
              if (gone > 0.01) {
                float e = atcCrack(w * 0.36 + vec2(atcNoise(w * 0.9), atcNoise(w * 0.9 + 7.7)) * 0.3);
                float wd = 0.006 + pxMin * 0.5;
                float line = (1.0 - smoothstep(wd * 0.4, wd, e)) * gone * (1.0 - px / 0.075);
                tone *= 1.0 - 0.27 * line;
                atcSmooth += 0.25 * line;
              }
            }
            // ---- the lanes (see TriSink.ln in meshes.js) ----------------------
            // uv.x counts lanes across the carriageway, uv.y is how worn the
            // surface is (0 on everything that is not a road deck). Tyres run a
            // quarter of a lane either side of its middle and polish what they
            // run on: darker, and smoother, so the tracks catch a low sun. The
            // middle of a lane is where engines drip while they wait, which is
            // why it blackens toward every stop line.
            float wear = vUv.y;
            if (wear > 0.004) {
              float l = fract((vUv.x - 0.25) * 16.0) - 0.5;
              float tr = exp(-pow((abs(l) - 0.255) / (0.085 + 0.03 * uGroundDetail), 2.0));
              float oil = exp(-pow(l / 0.07, 2.0)) * smoothstep(0.62, 1.0, wear)
                * (0.6 + 0.4 * atcNoise(w * vec2(0.5, 0.5) + 2.0));
              // (deeper with the street-level detail on, where the rest of
              // the surface has enough going on that 12 % got lost in it)
              float trK = 0.12 + 0.14 * uGroundDetail;
              tone *= 1.0 - trK * wear * tr - (0.24 + 0.08 * uGroundDetail) * oil;
              atcSmooth += 0.24 * wear * tr + 0.28 * oil;
              // the strip between the tracks and along every lane line is
              // where the dust the tyres throw off settles: a shade paler
              float dust = exp(-pow((abs(l) - 0.5) / 0.08, 2.0));
              tone *= 1.0 + 0.05 * uGroundDetail * wear * dust;
            }
            // chippings are a centimetre: the class bump is for standing over
            // them, not for a road seen along its length
            atcBump *= 0.6 * clamp(1.0 - px * 7.0, 0.15, 1.0);
          } else if (layer > 10.5 && layer < 11.5) {
            // paint wears through where tyres cross it: never one clean white
            float worn = smoothstep(0.50, 0.80, atcNoise(vWorldXZ * 1.9 + 3.0))
              * (0.5 + 0.5 * atcNoise(vWorldXZ * 11.0));
            tone *= 1.0 - 0.36 * worn;
          } else if (layer > 7.5) {
            // paving, setts, pavers: a slab here and there is a newer or a
            // dirtier one, on a scale no tile carries
            tone *= 0.93 + 0.14 * atcNoise(vWorldXZ * 0.23 + 11.0);
            atcBump *= clamp(1.0 - px * 5.0, 0.2, 1.0);
          }
          if (uGroundDetail > 0.5) {
            vec2 fwd = fwidth(vWorldXZ);
            tone *= atcStreetDetail(layer, vWorldXZ, atcST, px, min(fwd.x, fwd.y), atcBump);
          }
          diffuseColor.rgb *= tone;
        }`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = roughness;
        {
          float layer = floor(vSurf + 0.5);
          roughnessFactor *= texture(uNormalArr, vec3(atcST / uScale[int(layer)], layer)).a;
          roughnessFactor = clamp(roughnessFactor * (1.0 - atcSmooth), 0.28, 1.0);
        }`)
      .replace('#include <normal_fragment_maps>', `
        {
          float layer = floor(vSurf + 0.5);
          vec3 mapN = texture(uNormalArr, vec3(atcST / uScale[int(layer)], layer)).xyz * 2.0 - 1.0;
          mapN.xy *= atcBump;
          // The ground is very nearly flat in world terms, so a tangent frame
          // derived from screen-space derivatives is stable here and saves
          // carrying tangents through every merge in meshes.js.
          //
          // …NEARLY flat. A VERTICAL face running east-west has constant
          // world Z down the screen, both st.y derivatives are zero, the
          // tangent collapses and normalize(0) is NaN — and NaN lighting is
          // PURE BLACK. That was every "black square" in the city: kerb and
          // skirt faces aligned with the X axis. Where the frame degenerates
          // the face keeps its geometric normal, which on a 25 cm kerb wall
          // nobody can tell apart from the mapped one anyway.
          vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
          vec2 st0 = dFdx(vWorldXZ), st1 = dFdy(vWorldXZ);
          vec3 Tc = q0 * st1.y - q1 * st0.y;
          if (dot(Tc, Tc) > 1e-10) {
            vec3 N = normalize(normal);
            vec3 T = normalize(Tc);
            vec3 B = -normalize(cross(N, T));
            normal = normalize(mat3(T, B, N) * mapN);
          }
        }`);
    mat.userData.shader = shader;
  };
  // three keys its program cache on this, and two materials with different
  // injected code must not share one
  mat.customProgramCacheKey = () => 'surfaces-v5';
  return mat;
}

/** The synthesised arrays, for the aerial photo's street-level detail
 *  (js/orthodetail.js): the same setts and chippings, so a photographed
 *  square and a mapped one are laid in the same stone. */
export function surfaceTextures() {
  build();
  return { albedo: _albedo, normal: _normal, scale: SCALE };
}

/** For tests and for the settings toggle that throws the ground away. */
export function surfacesReady() { return _built; }
