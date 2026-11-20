// ---- cardirt.js: the road on a car, and the odd leaf ----------------------------
// GLSL for js/carbodymat.js to splice into the one body program. Nothing here
// is geometry or a texture: the dirt is a few value-noise reads per pixel in the
// car's own frame, so it stays where it is as the car moves, costs no draw and
// no memory, and a clean car (amount 0) skips it on one test.
//
//   film     road film, thick at the sills and thinning up the doors; how far
//            it climbs is the amount, so a lightly dirty car is dusty only along
//            the sills and the lower doors
//   spray    more of it on the tail, where the wheels throw it
//   runs     vertical streaks down the flanks, where rain carried the dust and
//            dried
//   dust     on what faces the sky, only on a car that has stood a while
//
// The leaf is per car only (the distance dress is past the range where a 9 cm
// leaf is a pixel): a lens of two arcs with a stalk and a midrib, laid in plan
// on whatever faces up at its spot (js/carlook.js leafSpot).

import * as THREE from 'three';

/** needs carHash() (js/carbodymat.js CITY_GLSL) declared before it */
export const DIRT_GLSL = /* glsl */`
  float carVn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n = i.x + i.y * 57.0;
    return mix(mix(carHash(n), carHash(n + 1.0), f.x), mix(carHash(n + 57.0), carHash(n + 58.0), f.x), f.y);
  }
  // how much road is on this point of the body, 0..1. p is in the car's frame
  // (metres, y up from the road, +z the tail), up the body normal's y.
  float carDirt(vec3 p, float up, float amt, float seed) {
    float s = seed * 61.0;
    float n1 = carVn(vec2(p.z * 2.3 + s, p.y * 3.1 + abs(p.x) * 1.9));
    float n2 = carVn(vec2(p.z * 8.0 - s, p.y * 12.0 + p.x * 6.0));
    float side = 1.0 - abs(up);
    float run = carVn(vec2(p.z * 34.0 + s, p.y * 1.1 - s)) * 0.6 + carVn(vec2(p.z * 11.0 - s, p.y * 0.7)) * 0.4;
    float top = 0.24 + 0.80 * amt + 0.26 * (n1 - 0.5);
    float film = (1.0 - smoothstep(0.10, top, p.y)) * (0.62 + 0.38 * n2);
    film *= mix(1.0, 0.78 + 0.44 * run, side * 0.55);
    float spray = smoothstep(1.3, 2.2, p.z) * (1.0 - smoothstep(0.35, 1.35, p.y)) * (0.5 + 0.5 * n1);
    float dust = max(up, 0.0) * (0.3 + 0.55 * carVn(p.xz * 2.1 + s)) * smoothstep(0.45, 1.0, amt);
    float streak = side * smoothstep(0.52, 0.80, run) * smoothstep(0.55, 1.0, amt) * 0.16
      * (1.0 - smoothstep(0.75, 1.15, p.y));
    return clamp(film * (0.55 + amt) + spray * amt * 0.7 + dust * 0.6 + streak, 0.0, 1.0);
  }`;

/**
 * Fragment lines, after diffuseColor holds the body colour. LOOK is the GLSL of
 * the vec4 (gloss, lacquer roughness, dirt, seed). Declares cDirt. Lamps keep
 * half their lens clear (a lit lamp under mud is still a lamp) and glass takes
 * less: the wipers and the wind see to it.
 */
export const dirtFrag = (LOOK) => /* glsl */`
  float cDirt = 0.0;
  if (${LOOK}.z > 0.001) {
    cDirt = carDirt(vObj, vUp, ${LOOK}.z, ${LOOK}.w)
      * (1.0 - 0.5 * clamp(vFx.y + vFx.z, 0.0, 1.0)) * mix(1.0, 0.5, step(2.0, vPbr.z));
    // pale dust on some cars, dark road grime on others
    vec3 dcol = mix(vec3(0.105, 0.092, 0.078), vec3(0.29, 0.26, 0.21), fract(${LOOK}.w * 5.3));
    diffuseColor.rgb = mix(diffuseColor.rgb, dcol, cDirt * 0.92);
  }`;

/** Fragment lines for the leaf (uniforms uLeaf: x, z, angle, half length; uLeafC). Declares cLeaf. */
export const leafFrag = () => /* glsl */`
  float cLeaf = 0.0;
  if (uLeaf.w > 0.0) {
    vec2 lq = vObj.xz - uLeaf.xy;
    float lca = cos(uLeaf.z), lsa = sin(uLeaf.z);
    lq = vec2(lca * lq.x - lsa * lq.y, lsa * lq.x + lca * lq.y) / uLeaf.w;
    // a lens of two arcs (half length 1, half width 0.42), and the stalk
    float lens = max(length(lq - vec2(0.0, 0.98)), length(lq + vec2(0.0, 0.98))) - 1.4;
    float stalk = max(abs(lq.y) - 0.035, max(0.95 - lq.x, lq.x - 1.45));
    float ld = min(lens, stalk), laa = fwidth(ld) + 1e-4;
    cLeaf = (1.0 - smoothstep(-laa, laa, ld)) * step(0.3, vUp);
    float rib = 1.0 - smoothstep(0.02, 0.07, abs(lq.y));
    float vein = 1.0 - smoothstep(0.04, 0.10, abs(fract(lq.x * 2.5 + abs(lq.y) * 1.6) - 0.5));
    diffuseColor.rgb = mix(diffuseColor.rgb, uLeafC * (1.0 - 0.38 * rib - 0.16 * vein), cLeaf);
  }`;

// November on a Czech street: ochre, rust, brown, and a late yellow-green
const LEAF_HEX = [0xb8891e, 0x8a4a1c, 0x5c3d1e, 0x8c9a2e, 0xc9a227];

/** leaf: js/carlook.js leafSpot() ([x, z, angle, half length, tint]) or null */
export function leafUniforms(leaf) {
  const c = new THREE.Color(leaf ? LEAF_HEX[Math.min(LEAF_HEX.length - 1, (leaf[4] * LEAF_HEX.length) | 0)] : 0);
  return {
    uLeaf: { value: new THREE.Vector4(leaf?.[0] ?? 0, leaf?.[1] ?? 0, leaf?.[2] ?? 0, leaf?.[3] ?? 0) },
    uLeafC: { value: new THREE.Vector3(c.r, c.g, c.b) },
  };
}
