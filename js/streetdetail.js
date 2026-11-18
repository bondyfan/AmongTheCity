// ---- what the street looks like from a metre and a half up ---------------
// js/surfaces.js gives every class of ground its texture: a 256 px tile of
// chippings, slabs or setts, two to six metres across. That is the right
// thing from a helicopter and the wrong one on foot, for one reason: a tile
// REPEATS. A square of granite setts where every stone two metres along is
// the same grey as this one is a wallpaper, and a road whose blotches line up
// down its length is a carpet. The cure is not a bigger texture; it is detail
// with NO period, drawn from the world position itself.
//
// So this is a multiplier the surface shader applies on top of the tile, class
// by class, all arithmetic (one hash or a few lattice noises, no texture):
//
//   asphalt   blotches at two scales, the brown of old bitumen against the
//             blue-black of a new lay, and the odd pale stone in the binder;
//   slabs,    every stone its own shade from its WORLD index, so the shades
//   pavers,   never repeat, plus the dirt that collects in a walked-on
//   setts     surface;
//   grass     dry straw-coloured patches, lush dark ones, clumps;
//   concrete  grime on a kerb top, and a kerb FACE a shade darker, which is
//             the gutter's shadow and its dirt.
//
// Everything fine fades by pixel footprint (`px`, metres per pixel) before it
// can alias; what survives at a distance is the slow variation, which is the
// part that stops the tiling showing from a car. The mean of each multiplier
// stays near 1, so the colours tuned by eye in meshes.js are kept.
//
// Uses atcHash / atcNoise / atcUnit (js/groundglsl.js), declared before it.
// GROUND_DETAIL there switches the whole thing off for an A/B.

export const STREET_DETAIL_GLSL = `
  vec3 atcStreetDetail(float layer, vec2 w, vec2 st, float px, float pxMin, float bump) {
    vec3 k = vec3(1.0);
    // one laid unit is 10 to 60 cm: its shade goes before it shrinks to a pixel
    float unitK = 1.0 - smoothstep(0.015, 0.05, px);
    // A lattice noise of period P metres is a smooth field while a pixel is
    // well under P and a boil of random pixels once it is not, so each term
    // below is faded on its own scale: a half-metre grain is gone by the time
    // a pixel is 12 cm (about 60 m down a street at eye height), a 1.5 m one
    // by 35 cm. What is left far off is the slow variation, which is the part
    // that stops a tile showing from a car.
    float fine = 1.0 - smoothstep(0.05, 0.12, px);
    float mid = 1.0 - smoothstep(0.15, 0.35, px);
    if (layer > 5.5 && layer < 6.5) {
      // ---- asphalt ----
      // Blotches at the scales a driver reads: 6 m and 1.4 m, then a
      // half-metre grain that survives the mips the chippings do not.
      // (seen in the game the first amplitudes were too shy: from the chase
      // camera a street still read as one flat grey, so the slow term is the
      // strong one now; it is also the one that cannot shimmer)
      float m1 = atcNoise(w * 0.17 + 5.0), m2 = atcNoise(w * 0.73 + 1.3), m3 = atcNoise(w * 2.1 + 7.0);
      k *= 0.88 + 0.24 * m1 + 0.16 * (m2 - 0.5) * mid + 0.08 * (m3 - 0.5) * fine;
      // (repairs and sealed cracks are already in the surface shader, under
      // the same switch they are drawn a shade deeper: js/surfaces.js)
      // bitumen browns and greys as it ages; a fresh lay is blue-black. The
      // bias is warm: a grey road under a blue sky came out blue.
      float age = atcNoise(w * 0.045 + 77.0);
      // (the cool end is neutral now: under the sky light the street still
      // came out blue in the game with a bluish fresh lay)
      k *= mix(vec3(1.0, 1.0, 0.99), vec3(1.07, 1.02, 0.9), age);
      // a pale stone in the binder here and there, four centimetres across
      float fl = atcNoise(w * 24.0 + 3.7);
      k *= 1.0 + 0.4 * smoothstep(0.80, 0.93, fl) * (1.0 - smoothstep(0.004, 0.018, px));
    } else if (layer > 7.5 && layer < 9.5 || layer > 11.5) {
      // (the shade is a step per stone: judged on the pixel's mean footprint,
      // so a pavement seen along its length keeps it a little further out)
      unitK = 1.0 - smoothstep(0.02, 0.06, 0.5 * (px + pxMin));
      // ---- slabs (8), setts (9), pavers (12) ----
      // the unit index from the same st the texture is read with
      float u = layer < 8.5 ? atcUnit(st / 2.4, 4.0, 8.0, 0.0)
        : layer < 9.5 ? atcUnit(st / 1.6, 16.0, 16.0, 0.5)
        : atcUnit(st / 2.0, 10.0, 20.0, 0.5);
      // granite varies most; a concrete slab a little; pavers from one
      // pallet barely, and a strong shade on 10 cm pavers is a checkerboard
      float spread = layer > 8.5 && layer < 9.5 ? 0.42 : layer < 8.5 ? 0.2 : 0.12;
      float shade = 1.0 - spread * 0.5 + spread * u;
      // and a warm or a cool one: setts are granite from several quarries
      vec3 hue = mix(vec3(1.03, 1.0, 0.95), vec3(0.97, 1.0, 1.04), atcHash(vec2(u * 97.0, 3.0)));
      k *= mix(vec3(1.0), shade * hue, unitK);
      // walked-on dirt: darker where the feet go, a gum-spotted stain or two
      float d1 = atcNoise(w * 0.31 + 41.0), d2 = mix(0.5, atcNoise(w * 1.7 + 9.0), mid);
      k *= 1.0 - 0.15 * smoothstep(0.45, 0.95, d1 * 0.65 + d2 * 0.35);
      // and the slow weathering of a whole square: a dozen metres darker and
      // warmer where the rain runs and the market stands, paler where the sun
      // bleaches it (near neutral: a warmer tint set the mapped square apart
      // from the photographed one beside it, which is cool grey)
      float wx = atcNoise(w * 0.07 + 23.0);
      k *= mix(vec3(1.06, 1.05, 1.04), vec3(0.91, 0.9, 0.88), wx);
      k *= 1.0 - 0.12 * smoothstep(0.86, 0.96, atcNoise(w * 3.1 + 2.0)) * unitK;
    } else if (layer < 1.5) {
      // ---- grass and meadow ----
      float g1 = atcNoise(w * 0.085 + 3.0), g2 = atcNoise(w * 0.41 + 8.0);
      float dry = smoothstep(0.48, 0.8, g1 * 0.7 + g2 * 0.3);
      float lush = 1.0 - smoothstep(0.18, 0.45, g1 * 0.5 + g2 * 0.5);
      k *= mix(vec3(1.0), vec3(1.2, 1.1, 0.7), dry * 0.85);
      k *= mix(vec3(1.0), vec3(0.76, 0.9, 0.78), lush * 0.75);
      // a mown verge is never one green: a metre-scale mottle of light and
      // shade and a touch less chroma, which the 3D blades alone do not give
      // (in the game a verge still read as a flat painted strip)
      float gm = atcNoise(w * 0.9 + 4.0);
      k *= mix(vec3(1.0), vec3(0.84 + 0.32 * gm, 0.86 + 0.26 * gm, 0.84 + 0.3 * gm), mid);
      // clumps, a hand across, and the odd bare patch by a kerb or a path
      k *= 1.0 + 0.4 * (atcNoise(w * 2.4 + 0.5) - 0.5) * fine * (0.6 + 0.4 * atcNoise(w * 0.9 + 4.0));
      k *= mix(vec3(1.0), vec3(1.18, 1.0, 0.78), smoothstep(0.82, 0.95, atcNoise(w * 0.23 + 61.0)) * 0.6);
    } else if (layer > 6.5 && layer < 7.5) {
      // ---- concrete: kerbs, slabs, steps ----
      if (bump < 0.001) k *= 0.8;          // a standing face: the gutter's shadow and dirt
      else k *= 1.0 + 0.16 * (atcNoise(w * 1.7 + 13.0) - 0.5) * mid;
    }
    return k;
  }`;
