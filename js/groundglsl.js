// ---- GLSL the two ground materials share --------------------------------
// The world's floor is drawn by two materials: the synthesised surfaces of
// js/surfaces.js (every carriageway, pavement, kerb and lawn in one merged
// mesh) and the aerial photograph of js/ortho.js (one Lambert per supertile).
// Both want the same things from the shader: a world position that keeps its
// precision 95 km from the origin, a small lattice noise, and one switch that
// turns the street-level detail off for an A/B. They live here so the two
// cannot drift apart.

/**
 * The street-level detail switch. ONE uniform object, handed by reference to
 * every ground program, so flipping `.value` changes every chunk in the next
 * frame without a recompile. 1 = on (the default), 0 = the old flat look.
 * From the console: (await import('/js/groundglsl.js')).GROUND_DETAIL.value = 0
 */
export const GROUND_DETAIL = { value: 1 };

// ---- a world position that is still precise in Prague ---------------------
// Prague sits at x ≈ −95 000 m, where a float32 has a step of 8 mm. Fed raw
// world coordinates, a 1.6 m texture tile is addressed in steps of one texel
// (its 256 px are 6 mm each), so up close every texture in the city was a
// quarter-pixel-jittered mosaic, and fwidth(), which everything here uses to
// fade fine detail before it can alias, measured that 8 mm staircase instead
// of the pixel. The chunk ORIGIN is the big number and it is a whole multiple
// of 60 m, so it is wrapped on its own, exactly, and the small local position
// is added after. 4 800 m is a multiple of every tile period on the ground
// (1.6, 2, 2.4, 2.5, 3, 4, 5, 6, 8, 12 m), so the textures never notice the
// wrap; only the slow noises restart, on a chunk border, once every 4.8 km.
export const WRAP_GLSL = `
  vec2 atcWrapXZ(vec3 local) {
    return mod(modelMatrix[3].xz, 4800.0) + (modelMatrix * vec4(local, 0.0)).xz;
  }`;

// ---- noise -----------------------------------------------------------------
// Lattice hash on coordinates wrapped to 4096 first: every lattice point is a
// small exact integer wherever it is, so the pattern does not come out in bands.
export const NOISE_GLSL = `
  float atcHash(vec2 p) {
    p = mod(p, 4096.0);
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float atcNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(atcHash(i), atcHash(i + vec2(1.0, 0.0)), f.x),
      mix(atcHash(i + vec2(0.0, 1.0)), atcHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // Which laid unit (slab, paver, sett) a point is in, for a texture tile of
  // nu x nv units with every other row shifted by half a unit when 'bond' is
  // 0.5. Returned as a hash in 0..1: the texture repeats every tile, so its
  // own per-stone shades repeat too, and on a square of a thousand stones a
  // repeat every two metres is exactly the "clean tile" the eye catches. A
  // shade drawn from the stone's WORLD index has no period at all.
  float atcUnit(vec2 st, float nu, float nv, float bond) {
    float row = floor(st.y * nv);
    float col = floor(st.x * nu + bond * mod(row, 2.0));
    return atcHash(vec2(col, row) + 17.0);
  }`;
