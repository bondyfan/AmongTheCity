// ---- the aerial photograph, seen from the ground --------------------------
// The ČÚZK orthophoto is 20 cm a pixel, which is superb from a rooftop and a
// smear at your feet: on Staroměstské náměstí the player stood on a grey haze
// with the dark blots of the tourists the plane photographed one morning. Two
// things are wrong with it up close, and the photograph cannot fix either:
//
//   · it has no detail finer than its pixel, so nothing is sharp;
//   · what detail it does have is of the wrong things: people, umbrellas,
//     parked cars and their shadows, enlarged to a metre of blur each.
//
// So close to the camera the photo is asked for less and given more. Its
// COLOUR is kept (the photo knows that this square is pale granite and that
// courtyard dark tarmac, which no map does), but a half-blurred version of it
// is used, read further down its own mip chain, which takes the tourists out
// and keeps the square. The SHARPNESS comes from the same synthesised stone
// js/surfaces.js lays on every mapped street: setts where the photo is a pale
// grey, chippings where it is dark, mown grass where it is green, blended by
// the photo's own colour so the transitions follow what was photographed. It
// fades out by pixel footprint, so beyond a few tens of metres the ground is
// the photograph alone, exactly as before.
//
// Up close it also takes the stone's RELIEF: the same normal arrays tilt the
// photo's shading, so a low sun rakes across the setts it now shows.
//
// What it must not do is touch the view from the air, where the photograph is
// at its native 20 cm and every blot really is a person: the calming is held
// to a camera within a few tens of metres of the ground, the stone to pixels
// under 25 cm.
//
// Cost: five array reads, two more reads of the photo and some arithmetic per
// photo pixel. No geometry, no draw call, one program shared by every
// supertile (the cache key is fixed). GROUND_DETAIL turns it off.

import { NOISE_GLSL, WRAP_GLSL, GROUND_DETAIL } from './groundglsl.js';
import { surfaceTextures, SURF } from './surfaces.js';
import { ORTHO } from './config.js';

const LUM = 'vec3(0.2126, 0.7152, 0.0722)';

const FRAG = `
  // (outside the map block: the relief pass after normal_fragment_begin reads them)
  float atcNearK = 0.0, atcSettK = 0.0, atcGrassK = 0.0;
  #ifdef USE_MAP
    vec4 sampledDiffuseColor = texture2D( map, vMapUv );
    if (uGroundDetail > 0.5) {
      vec2 gw = vGroundXZ;
      vec2 gfw = fwidth(gw);
      float gpx = max(gfw.x, gfw.y), gmin = min(gfw.x, gfw.y);
      // full detail while a pixel is under 4 cm, none past 25 cm (~40 m away
      // at street level, sooner at a grazing angle)
      atcNearK = 1.0 - smoothstep(0.04, 0.25, gpx);
      // The photo blurred to ~1.6 m, the scale of a person or a parasol, so
      // those go and the square stays; and to ~4 m, for the blots below. Read
      // at an EXPLICIT level: a bias is added to the level the hardware picks,
      // and up close the photo is magnified, that level is below zero and
      // clamps to the sharp one whatever the bias, so where it mattered most
      // nothing was blurred at all. The level is in metres, not mips, because
      // the near tier is 20 cm a texel and the mid one 94 cm. Never sharper
      // than the hardware's own pick, or it would sparkle further off.
      vec2 tsz = vec2(textureSize(map, 0));
      vec2 tdx = dFdx(vMapUv) * tsz, tdy = dFdy(vMapUv) * tsz;
      float lod0 = 0.5 * log2(max(max(dot(tdx, tdx), dot(tdy, tdy)), 1e-8));
      float mPerTexel = @TILE@ / tsz.x;
      vec3 coarse = textureLod(map, vMapUv, max(lod0, log2(1.6 / mPerTexel))).rgb;
      vec3 wide = textureLod(map, vMapUv, max(lod0, log2(4.0 / mPerTexel))).rgb;
      // (the stone is read here, unconditionally: a read with implicit
      // derivatives may not sit in a branch that differs between pixels)
      vec3 dA = texture(uDetailAlb, vec3(gw / @SA@, @LA@.0)).rgb;
      vec3 dC = texture(uDetailAlb, vec3(gw / @SC@, @LC@.0)).rgb;
      vec3 dG = texture(uDetailAlb, vec3(gw / @SG@, @LG@.0)).rgb;
      // The blots: what is much darker than the ground four metres round it
      // is a person, a parasol or its shadow, and it is lifted toward that
      // ground. A building's shadow is wider than that, darkens the wide read
      // too, and stays. Measured along the SHARP axis of the pixel (at a
      // grazing angle the long axis says "far" while the photo is still
      // visibly magnified), and only for a camera near the ground: from a
      // helicopter the photo is at its native sharpness and a blot is a man.
      float hCam = cameraPosition.y - vGroundY;
      float calmK = (1.0 - smoothstep(0.15, 0.6, gmin)) * (1.0 - smoothstep(20.0, 60.0, hCam));
      vec3 fine = sampledDiffuseColor.rgb;
      float lf = dot(fine, ${LUM}), lw = dot(wide, ${LUM});
      vec3 lifted = fine * clamp(lw * 0.82 / max(lf, 1e-3), 1.0, 2.5);
      sampledDiffuseColor.rgb = mix(fine, mix(lifted, coarse, 0.5), calmK);
      // green: a lawn; pale grey: setts or slabs; dark grey: tarmac. Linear
      // values: tarmac photographs at ~0.05-0.1, a granite square ~0.2-0.4.
      float lum = dot(coarse, ${LUM});
      atcGrassK = smoothstep(0.05, 0.22, (coarse.g - max(coarse.r, coarse.b)) / max(lum, 0.02));
      atcSettK = smoothstep(0.09, 0.17, lum);
      if (atcNearK > 0.001) {
        vec3 photo = sampledDiffuseColor.rgb;
        vec3 d = mix(mix(dA, dC, atcSettK), dG, atcGrassK) * 2.0;
        // stone keeps the photo's hue and takes only the light; grass takes a
        // little of the synthesised hue shift too
        float dl = dot(d, ${LUM});
        vec3 m = mix(vec3(dl), d, atcGrassK * 0.6);
        // every sett its own shade from its world index (see atcUnit)
        float unitK = (1.0 - smoothstep(0.015, 0.05, gpx)) * atcSettK * (1.0 - atcGrassK);
        float u = atcUnit(gw / @SC@, 16.0, 16.0, 0.5);
        m *= mix(1.0, 0.8 + 0.4 * u, unitK);
        m *= 0.94 + 0.12 * atcNoise(gw * 0.6 + 4.0);
        sampledDiffuseColor.rgb = photo * mix(vec3(1.0), m, atcNearK * 0.9);
      }
    }
    diffuseColor *= sampledDiffuseColor;
  #endif`;

// The relief, after three has worked out the plain normal. Same tangent frame
// as js/surfaces.js (screen derivatives of the world position: the ground is
// near enough flat for it to be stable), same guard where it degenerates.
const NORMAL = `
  #ifdef USE_MAP
  if (uGroundDetail > 0.5) {
    vec2 gst = vGroundXZ;
    vec3 nA = texture(uDetailNrm, vec3(gst / @SA@, @LA@.0)).xyz;
    vec3 nC = texture(uDetailNrm, vec3(gst / @SC@, @LC@.0)).xyz;
    vec3 q0 = dFdx(-vViewPosition), q1 = dFdy(-vViewPosition);
    vec2 st0 = dFdx(gst), st1 = dFdy(gst);
    // chippings at half strength, as surfaces.js keeps them; grass none: a
    // photographed lawn is the one place the stone must not show
    float bumpK = atcNearK * (1.0 - atcGrassK) * mix(0.45, 0.9, atcSettK);
    vec3 Tc = q0 * st1.y - q1 * st0.y;
    if (bumpK > 0.001 && dot(Tc, Tc) > 1e-10) {
      vec3 mapN = mix(nA, nC, atcSettK) * 2.0 - 1.0;
      mapN.xy *= bumpK;
      vec3 N = normal;
      vec3 T = normalize(Tc);
      vec3 B = -normalize(cross(N, T));
      normal = normalize(mat3(T, B, N) * mapN);
    }
  }
  #endif`;

const fill = (src, tx) => src
  .replaceAll('@TILE@', ORTHO.tile.toFixed(1))
  .replaceAll('@SA@', tx.scale[SURF.asphalt].toFixed(2)).replaceAll('@LA@', String(SURF.asphalt))
  // setts at 2.4 m a tile: sixteen to the tile is 15 cm granite, the size
  // of the old-town squares, not the 10 cm mosaic of a pavement
  .replaceAll('@SC@', '2.40').replaceAll('@LC@', String(SURF.cobble))
  .replaceAll('@SG@', tx.scale[SURF.grass].toFixed(2)).replaceAll('@LG@', String(SURF.grass));

/** Teach one ortho supertile material the street-level detail. Idempotent. */
export function orthoDetail(mat) {
  if (mat.userData.orthoDetail) return mat;
  mat.userData.orthoDetail = true;
  const tx = surfaceTextures();
  const frag = fill(FRAG, tx), nrm = fill(NORMAL, tx);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDetailAlb = { value: tx.albedo };
    shader.uniforms.uDetailNrm = { value: tx.normal };
    shader.uniforms.uGroundDetail = GROUND_DETAIL;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec2 vGroundXZ;
        varying float vGroundY;
        ${WRAP_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vGroundXZ = atcWrapXZ(transformed);
        vGroundY = (modelMatrix * vec4(transformed, 1.0)).y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2DArray uDetailAlb;
        uniform sampler2DArray uDetailNrm;
        uniform float uGroundDetail;
        varying vec2 vGroundXZ;
        varying float vGroundY;
        ${NOISE_GLSL}`)
      .replace('#include <map_fragment>', frag)
      .replace('#include <normal_fragment_maps>', '#include <normal_fragment_maps>\n' + nrm);
  };
  // every supertile shares the one program (per USE_MAP variant)
  mat.customProgramCacheKey = () => 'ortho-detail-v2';
  return mat;
}
