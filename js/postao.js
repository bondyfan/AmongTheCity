// ---- postao.js: the post stack's half-resolution occlusion pass ------------
// One full-screen pass at HALF resolution that writes everything the composite
// needs to know about how much ambient light a pixel gets:
//   R  screen-space ambient occlusion (1 open, 0 fully occluded)
//   G  canopy shade, the crown-density map of js/trees.js (1 open)
//   B  the pixel's view depth in metres, for the composite's edge-aware upsample
// It replaces three things the stack used to do (round 11, LOOK):
//   * the SSAO pass, which took sixteen kernel samples per pixel, each one a
//     fetch from the full-size depth buffer at a random spot;
//   * the 5 x 5 box blur that followed it, a pass of its own with 25 fetches a
//     pixel, as expensive as the AO itself;
//   * the canopy term, which ran in the composite at FULL resolution, with its
//     own depth read and world position, for a map that holds one value per
//     half metre of ground.
// Now the kernel is EIGHT samples, and the rotation that turns it is not a
// hash but a 4 x 4 interleave (a Bayer order of sixteen angles), so any 4 x 4
// block of AO pixels holds every rotation exactly once. The composite reads
// four bilinear taps that cover precisely such a block (AO_UPSAMPLE_GLSL):
// sixteen rotations of eight samples averaged, 128 directions a pixel, with no
// blur pass at all and four fetches instead of twenty-five. The taps are
// weighted by how close their depth lies to the pixel's own, so a dark crease
// does not bleed over the silhouette in front of it (the old blur knew nothing
// about depth, which is where the grey halo round a lamp post came from).
//
// The kernel is a fixed table, not Math.random() at boot: two players see the
// same shading, and a screenshot of one spot matches the next one.

// Eight points in the +Z hemisphere, unit length times a radius share that
// bunches samples toward the centre (a crease is mostly near) while two reach
// right out to the full radius (what puts shade under a car and along a kerb).
// Directions spread on a spiral so no two share a quadrant and elevation.
const KERNEL = (() => {
  const k = [];
  for (let i = 0; i < 8; i++) {
    const a = i * 2.39996323;                  // golden angle
    const z = 0.18 + 0.78 * ((i * 5) % 8) / 7; // elevation mixed, not sorted
    const r = Math.sqrt(1 - z * z);
    let s = (i + 1) / 8; s = 0.15 + 0.85 * s * s;
    k.push([Math.cos(a) * r * s, Math.sin(a) * r * s, z * s]);
  }
  return k;
})();
export const aoKernel = (THREE) => KERNEL.map(([x, y, z]) => new THREE.Vector3(x, y, z));

export const AO_FRAG = /* glsl */`
  uniform sampler2D tDepth;
  uniform mat4 uProj;
  uniform mat4 uInvProj;
  uniform mat4 uCamWorld;
  uniform vec2 uRes;          // this (half-res) target's size in px
  uniform float uRadius;
  uniform float uBias;
  uniform vec3 uKernel[8];
  uniform bool useSsao;
  uniform bool useCanopy;
  uniform sampler2D tCanopy;      // R: remaining light under crowns (1 = open)
  uniform sampler2D tCanopyMeta;  // R: ground height, G: canopy-top height
  uniform vec2 uCanopyCenter;     // world xz of the shade map's center
  uniform float uCanopyInvSize;   // 1 / metres covered by the map
  uniform float uCanopyStrength;
  varying vec2 vUv;

  vec3 viewPos(vec2 uv, float d) {
    vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  // canopy shade: look up the crown-density map under the pixel's WORLD
  // position and darken only what sits UNDER the crowns (the meta map carries
  // ground and canopy-top heights, so sunlit crown tops stay bright)
  float canopyShade(vec3 world) {
    vec2 uv2 = (world.xz - uCanopyCenter) * uCanopyInvSize + 0.5;
    if (uv2.x <= 0.0 || uv2.x >= 1.0 || uv2.y <= 0.0 || uv2.y >= 1.0) return 1.0;
    float dens = 1.0 - texture2D(tCanopy, uv2).r;      // 0 open, toward 1 thick woods
    if (dens < 0.004) return 1.0;
    // response curve: moderate crown coverage (the floor BETWEEN trees) still
    // reads as shade instead of hiding in the low end
    dens = smoothstep(0.1, 1.0, dens);
    vec2 meta = texture2D(tCanopyMeta, uv2).rg;
    float groundH = meta.r * 176.0 - 16.0;
    float topH = meta.g * 32.0;
    if (topH < 0.5) return 1.0;
    // full shade from the ground up through the trunks; the crown itself keeps
    // a share, which is what makes a thick wood darker from above
    float fade = mix(1.0, 0.35, smoothstep(topH * 0.5, topH * 0.95, world.y - groundH));
    return 1.0 - min(dens * fade * uCanopyStrength, 0.75);
  }
  // 4 x 4 Bayer order: neighbours get angles far apart, and every 4 x 4 block
  // holds all sixteen
  float bayer2(vec2 p) { return mod(p.x * 2.0 + p.y * 3.0, 4.0); }
  float bayer4(vec2 p) { return 4.0 * bayer2(mod(p, 2.0)) + bayer2(mod(floor(p * 0.5), 2.0)); }

  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.9999) { gl_FragColor = vec4(1.0, 1.0, 1e4, 1.0); return; }   // sky
    vec3 P = viewPos(vUv, d);
    float ao = 1.0;
    if (useSsao) {
      // silhouette-safe normal: on each axis take the neighbour with the
      // SMALLER view-Z step, so an edge cannot fabricate a tilted normal
      vec2 tx = vec2(1.0 / uRes.x, 0.0);
      vec2 ty = vec2(0.0, 1.0 / uRes.y);
      vec3 Pr = viewPos(vUv + tx, texture2D(tDepth, vUv + tx).x);
      vec3 Pl = viewPos(vUv - tx, texture2D(tDepth, vUv - tx).x);
      vec3 Pu = viewPos(vUv + ty, texture2D(tDepth, vUv + ty).x);
      vec3 Pd = viewPos(vUv - ty, texture2D(tDepth, vUv - ty).x);
      vec3 ddx = (abs(Pr.z - P.z) < abs(P.z - Pl.z)) ? (Pr - P) : (P - Pl);
      vec3 ddy = (abs(Pu.z - P.z) < abs(P.z - Pd.z)) ? (Pu - P) : (P - Pd);
      vec3 N = normalize(cross(ddx, ddy));   // faces the camera (+Z)

      float ang = (bayer4(floor(gl_FragCoord.xy)) + 0.5) * (6.2831853 / 16.0);
      vec3 rv = vec3(cos(ang), sin(ang), 0.0);
      vec3 T = normalize(rv - N * dot(rv, N));
      mat3 TBN = mat3(T, cross(N, T), N);
      // depth-scaled bias: grazing self-occlusion and depth precision error
      // both grow with distance
      float bias = uBias + abs(P.z) * 0.015;
      // the radius shrinks a little with distance in SCREEN terms by itself;
      // past 60 m it also shrinks in metres, so far facades do not get a
      // two-metre grey apron where they meet the street
      float rad = uRadius * mix(1.0, 0.5, smoothstep(60.0, 220.0, -P.z));
      float occ = 0.0;
      for (int i = 0; i < 8; i++) {
        vec3 sp = P + (TBN * uKernel[i]) * rad;          // +N hemisphere sample
        vec4 clip = uProj * vec4(sp, 1.0);
        vec2 suv = (clip.xy / clip.w) * 0.5 + 0.5;
        if (suv.x < 0.0 || suv.x > 1.0 || suv.y < 0.0 || suv.y > 1.0) continue;
        float sd = texture2D(tDepth, suv).x;
        if (sd >= 0.9999) continue;                       // sky is not an occluder
        vec3 Ps = viewPos(suv, sd);                        // real geometry there
        float above = dot(N, Ps - P);                      // > bias only if it rises off the plane
        float rc = 1.0 - smoothstep(rad * 0.5, rad, abs(P.z - Ps.z)); // hard local cutoff
        occ += ((Ps.z >= sp.z + bias) && (above > bias)) ? rc : 0.0;
      }
      ao = 1.0 - occ / 8.0;
    }
    float shade = 1.0;
    if (useCanopy) shade = canopyShade((uCamWorld * vec4(P, 1.0)).xyz);
    gl_FragColor = vec4(ao, shade, -P.z, 1.0);
  }`;

// The composite's half: four bilinear taps on texel CORNERS, each the mean of
// a 2 x 2 block, together exactly the 4 x 4 block around the pixel, weighted
// by depth agreement. Returns (ao, canopy). `dc` is the pixel's view depth in
// metres (atcViewDepth below), uAoRes the AO target's size.
export const AO_UPSAMPLE_GLSL = /* glsl */`
  uniform vec2 uAoRes;
  uniform vec2 uProjZ;            // projectionMatrix elements 10 and 14
  float atcViewDepth(float d) { return uProjZ.y / ((d * 2.0 - 1.0) + uProjZ.x); }
  vec4 atcAoW(vec2 uv, float dc, float tol) {
    vec3 s = texture2D(tAO, uv).rgb;
    float w = max(0.0, 1.0 - abs(s.b - dc) / tol) + 1e-4;
    return vec4(s.rg * w, w, 0.0);
  }
  vec2 atcAoUpsample(float dc) {
    vec2 t = 1.0 / uAoRes;
    vec2 q = floor(vUv * uAoRes + 0.5);
    float tol = dc * 0.04 + 0.08;
    vec4 a = atcAoW((q + vec2(-1.0, -1.0)) * t, dc, tol)
           + atcAoW((q + vec2( 1.0, -1.0)) * t, dc, tol)
           + atcAoW((q + vec2(-1.0,  1.0)) * t, dc, tol)
           + atcAoW((q + vec2( 1.0,  1.0)) * t, dc, tol);
    return a.xy / a.z;
  }`;
