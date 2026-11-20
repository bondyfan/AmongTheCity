// ---- landmarksmat.js: the one material every hand-made landmark is drawn with ----
// No texture and no canvas, so it can be made anywhere (node tests included);
// the mesher worker never makes it at all, it names the slot 'landmark' and the
// main thread's decode puts this object back (js/geomcodec.js MAT_SLOTS).
//
// A Lambert wall material with three additions, all read from the two uv pairs
// the kit writes (js/landmarkskit.js):
//   · MASONRY IN METRES. uv.x says what the surface is made of, and the pattern
//     (roof tile courses, brick bond, ashlar joints, copper seams) is laid out
//     from the fragment's WORLD position, so it has the same scale on a tower
//     and on a wing and never stretches. It fades to its own average as soon
//     as a course is thinner than a pixel, so nothing shimmers at 300 m.
//   · FLOODLIGHT. uv1.x is how much monument lighting reaches the vertex. The
//     real Zelená brána and the chateau are lit from the ground every night;
//     this is that light as emission, warm, scaled by the surface's own colour.
//   · WINDOW LIGHT. uv.y is a lit pane.
// The night is the city's one shared uniform (facadeatlas.NIGHT), so landmarks
// light up with the windows around them and cost main.js nothing.

import * as THREE from 'three';
import { NIGHT } from './facadeatlas.js';

/** How strong the floodlight is. One number so the look is tuned in one place. */
export const FLOOD = { value: 0.28 };

// ---- seen across the town --------------------------------------------------
// The haze has a WALL (heightfog.js): a linear ramp that takes everything out
// before the streamed edge, ending at 88 % of the built radius by day and at
// 63 % of it by night (sky.js FOG_DAY_FAR 900 and FOG_NIGHT_FAR 640, main.js
// fogScale). On the default preset that is 422 m and 300 m of a 480 m world,
// and a tower is exactly the thing that should still stand in the last of it.
// So a landmark keeps the haze but has its own wall, 70 to 95 % of the built
// radius at any hour. The shader only knows fogFar; this is the factor that
// turns fogFar back into the radius, kept current by landmarkNight().
export const WALL = { value: 1 / 0.88 };
/** Once a frame with sky.nightK (through mats.facadeNight, js/meshes.js). */
export function landmarkNight(k) { WALL.value = 1 / (0.88 * (1 - (260 / 900) * k)); }

let _mat = null;
export function landmarkMaterial() {
  if (_mat) return _mat;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = NIGHT;
    sh.uniforms.uFlood = FLOOD;
    sh.uniforms.uLmWall = WALL;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        #ifndef USE_UV1
        attribute vec2 uv1;
        #endif
        varying vec3 vLmP;
        varying vec3 vLmN;
        varying vec4 vLmK;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // WORLD space through the model matrix: a worker-built chunk arrives
        // with quantised positions and its scale in the mesh transform, a
        // main-thread one in metres about the chunk centre. The normal is
        // snapped to the codec's own int8 grid so both lay the same courses.
        vLmP = (modelMatrix * vec4(position, 1.0)).xyz;
        vLmN = mat3(modelMatrix) * (floor(normal * 127.0 + 0.5) / 127.0);
        vLmK = vec4(uv, uv1);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec2 uNight;
        uniform float uFlood;
        uniform float uLmWall;
        varying vec3 vLmP;
        varying vec3 vLmN;
        varying vec4 vLmK;
        float lmBar;
        vec3 lmEmit;
        float lmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float lmNoise(vec2 p) {
          vec2 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          return mix(mix(lmHash(i), lmHash(i + vec2(1.0, 0.0)), f.x),
                     mix(lmHash(i + vec2(0.0, 1.0)), lmHash(i + vec2(1.0, 1.0)), f.x), f.y);
        }
        // Running bond: units of size s, every other course shifted half a unit.
        // x: tone of this unit (0..1), y: 1 inside the unit, 0 in the joint,
        // z: how far the pattern has faded (1 near, 0 once a course is a pixel)
        vec3 lmBond(vec2 p, vec2 s, float joint) {
          vec2 q = p / s;
          float row = floor(q.y);
          q.x += 0.5 * mod(row, 2.0);
          vec2 id = vec2(floor(q.x), row), f = fract(q);
          vec2 w = fwidth(q);
          vec2 j = vec2(joint) / s;
          vec2 e = smoothstep(j, j + w + 0.001, f) * smoothstep(j, j + w + 0.001, 1.0 - f);
          float fade = 1.0 - smoothstep(0.3, 0.9, max(w.x, w.y));
          return vec3(lmHash(id), e.x * e.y, fade);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float kind = floor(vLmK.x * 16.0 + 0.5);
          vec3 ln = normalize(vLmN);
          float sl = sqrt(max(1.0 - ln.y * ln.y, 0.0));
          // a: along the surface horizontally, b: up it (metres)
          vec2 hd = sl > 0.17 ? vec2(-ln.z, ln.x) / sl : vec2(1.0, 0.0);
          vec2 sp = vec2(dot(vLmP.xz, hd),
            sl > 0.17 ? vLmP.y / sl : dot(vLmP.xz, vec2(-hd.y, hd.x)));
          float m = 1.0;
          if (kind == 1.0) {                       // clay tile, lapped courses
            vec3 t = lmBond(sp, vec2(0.24, 0.33), 0.012);
            float lap = 0.82 + 0.18 * smoothstep(0.0, 0.5, fract(sp.y / 0.33));
            m = mix(0.93, (0.8 + 0.34 * t.x) * lap * mix(0.72, 1.0, t.y), t.z);
          } else if (kind == 2.0) {                // brick, light mortar
            vec3 t = lmBond(sp, vec2(0.30, 0.085), 0.006);
            m = mix(1.0, mix(1.5, 0.84 + 0.32 * t.x, t.y), t.z);
            m *= 0.94 + 0.12 * lmNoise(sp * 0.6);
          } else if (kind == 3.0) {                // ashlar
            vec3 t = lmBond(sp, vec2(0.86, 0.43), 0.012);
            m = mix(0.97, mix(0.8, 0.9 + 0.18 * t.x, t.y), t.z);
            m *= 0.94 + 0.12 * lmNoise(sp * 1.7);
          } else if (kind == 4.0) {                // patinated copper sheet
            float seam = abs(fract(sp.x / 0.62) - 0.5);
            float fw = fwidth(sp.x / 0.62);
            m = mix(1.0, 0.8, (1.0 - smoothstep(0.0, 0.04 + fw, seam)) * (1.0 - smoothstep(0.2, 0.7, fw)));
            m *= 0.86 + 0.28 * lmNoise(vec2(sp.x * 2.3, sp.y * 0.35));
          } else if (kind == 6.0) {                // slate
            vec3 t = lmBond(sp, vec2(0.3, 0.2), 0.008);
            m = mix(0.95, (0.84 + 0.26 * t.x) * mix(0.7, 1.0, t.y), t.z);
          } else if (kind == 9.0) {                // ceramic cladding, stack bond
            vec2 q = sp / vec2(0.3, 0.15);
            vec2 f = fract(q), w = fwidth(q);
            float e = smoothstep(0.04, 0.04 + w.x, f.x) * smoothstep(0.08, 0.08 + w.y, f.y);
            float fade = 1.0 - smoothstep(0.3, 0.9, max(w.x, w.y));
            // three shades of brick from one firing, which the restorers of
            // the station kept as they found it: three tones, never a smear
            float h3 = lmHash(floor(q));
            float tone = h3 < 0.34 ? 0.84 : h3 < 0.67 ? 0.95 : 1.07;
            m = mix(0.95, mix(0.6, tone, e), fade);
          } else if (kind == 11.0) {               // sandwich panels: a shed's skin, long and flat
            vec2 q = sp / vec2(6.0, 1.0);
            vec2 f = fract(q), w = fwidth(q);
            float e = smoothstep(0.0, 0.004 + w.x, f.x) * smoothstep(0.0, 0.03 + w.y, f.y);
            float fade = 1.0 - smoothstep(0.3, 0.9, max(w.x, w.y));
            m = mix(0.97, mix(0.74, 0.97 + 0.05 * lmHash(floor(q)), e), fade);
          } else if (kind == 12.0) {               // timber slats, upright
            float q = sp.x / 0.14;
            float f = fract(q), w = fwidth(q);
            float e = smoothstep(0.0, 0.1 + w, f) * smoothstep(0.0, 0.1 + w, 1.0 - f);
            float fade = 1.0 - smoothstep(0.3, 0.9, w);
            m = mix(0.9, mix(0.5, 0.82 + 0.3 * lmHash(vec2(floor(q), 3.0)), e), fade);
          } else if (kind == 13.0) {               // paving slabs and shop floor tiles
            vec2 q = sp / vec2(0.6, 0.6);
            vec2 f = fract(q), w = fwidth(q);
            float e = smoothstep(0.0, 0.012 + w.x, f.x) * smoothstep(0.0, 0.012 + w.y, f.y);
            float fade = 1.0 - smoothstep(0.3, 0.9, max(w.x, w.y));
            m = mix(0.96, mix(0.8, 0.94 + 0.08 * lmHash(floor(q)), e), fade);
          } else if (kind == 0.0) {                // plaster: weather, no pattern
            m = 0.93 + 0.12 * lmNoise(sp * 0.55) + 0.04 * lmNoise(sp * 4.0);
          }
          diffuseColor.rgb *= m;
          lmBar = 0.0;
          if (kind == 5.0 || kind == 10.0) {
            // A window. uv1 is the pane's own coordinate in eighths of a light:
            // the frame and the glazing bars are drawn 5 cm a side in METRES,
            // which the two derivative lengths give without knowing the size.
            vec2 q = vLmK.zw * 8.0;
            vec2 c = fract(q), d = min(c, 1.0 - c);
            vec2 g = vec2(length(vec2(dFdx(q.x), dFdy(q.x))), length(vec2(dFdx(q.y), dFdy(q.y))));
            vec2 mpp = vec2(length(vec2(dFdx(sp.x), dFdy(sp.x))), length(vec2(dFdx(sp.y), dFdy(sp.y))));
            vec2 bw = 0.05 * g / max(mpp, vec2(1e-6));
            vec2 e = 1.0 - smoothstep(bw, bw + g, d);
            lmBar = max(e.x, e.y) * (1.0 - smoothstep(0.25, 0.6, max(g.x, g.y)));
            // the glass carries a little of the sky, more toward the top of the pane
            vec3 glass = diffuseColor.rgb * (0.82 + 0.3 * c.y);
            vec3 frame = kind == 5.0 ? vec3(0.78, 0.76, 0.7) : vec3(0.05, 0.055, 0.06);
            diffuseColor.rgb = mix(glass, frame, lmBar);
          }
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float on = smoothstep(0.1, 0.7, uNight.x);
          // the lamps stand on the ground and shine up the walls; a roof
          // facing the sky gets what spills past the eaves
          float up = normalize(vLmN).y;
          float lmKind = floor(vLmK.x * 16.0 + 0.5);
          bool isGlass = lmKind == 5.0 || lmKind == 10.0;      // a pane's uv1 is not light
          float wash = (isGlass ? 0.0 : vLmK.z) * on * uFlood * (1.0 - 0.55 * clamp(up, 0.0, 1.0));
          // a lit room: the bars stand dark against it
          lmEmit = diffuseColor.rgb * vec3(1.0, 0.86, 0.62) * wash
            + vec3(1.0, 0.74, 0.42) * (vLmK.y * uNight.y * on * (1.0 - 0.85 * lmBar));
          totalEmissiveRadiance += lmEmit;
          // by day a pane shows the sky whichever way it faces; a Lambert wall
          // in its own shade would leave every north window a black hole
          if (isGlass) totalEmissiveRadiance += vec3(0.30, 0.38, 0.47) * (0.3 * (1.0 - on) * (1.0 - lmBar));
        }`);
    // THE FOG, with a wall of its own and the light carried through it.
    // heightfog.js puts the mix at the head of the tone-mapping chunk; here
    // that head is replaced by the same mix with two changes:
    //   · the wall stands further out (see WALL above); the haze itself is
    //     heightfog's own closed form, copied, so a landmark sits in the same
    //     air as the street it stands in;
    //   · two thirds of what the fog is about to take from the EMITTED light is
    //     put back first. Mixing toward the horizon colour is right for a wall
    //     and wrong for a lamp: a floodlit tower is the one thing you do see
    //     across a town at night. At the wall's end the mix is total and
    //     nothing survives, so the streamed edge stays hidden.
    // Without heightfog (a test, a tool) the chunk is left exactly as three has it.
    const tm = THREE.ShaderChunk.tonemapping_fragment;
    const at = tm.indexOf('#if defined( TONE_MAPPING )');
    if (tm.includes('ATC_FOG_DONE') && at >= 0) {
      sh.fragmentShader = sh.fragmentShader.replace('#include <tonemapping_fragment>', `
        #if defined( USE_FOG ) && defined( ATC_FOG_PARS )
          #define ATC_FOG_DONE
          if ( atcFogAir.w > 0.5 ) {
            #ifdef FOG_EXP2
              float lmWall = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth * 0.4 );
            #else
              float lmR = fogFar * uLmWall;
              float lmWall = smoothstep( lmR * 0.70, lmR * 0.95, vFogDepth );
            #endif
            float lmK = length( vAtcRay ) * atcFogAir.x;
            float lmDy = max( vAtcRay.y * atcFogTint.w, - 60.0 );
            float lmThin = exp( - clamp( ( cameraPosition.y - atcFogAir.y ) * atcFogTint.w, 0.0, 60.0 ) );
            float lmCol = abs( lmDy ) > 0.001 ? ( 1.0 - exp( - lmDy ) ) / lmDy : 1.0;
            float lmHaze = 1.0 - exp( - pow( lmK, atcFogAir.z ) * min( lmThin * lmCol, 1.6 ) );
            float lmA = clamp( 1.0 - ( 1.0 - lmWall ) * ( 1.0 - lmHaze ), 0.0, 1.0 );
            float lmB = min( lmA, 0.95 );
            gl_FragColor.rgb += lmEmit * ( 0.66 * lmB / ( 1.0 - lmB ) );
            gl_FragColor.rgb = mix( gl_FragColor.rgb, atcFogColour(), lmA );
          }
        #endif
        ` + tm.slice(at));
    }
  };
  mat.customProgramCacheKey = () => 'atc-landmark-v6';
  return (_mat = mat);
}
