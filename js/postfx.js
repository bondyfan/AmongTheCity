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
// The composite works entirely in LINEAR light and encodes to sRGB exactly
// once at the end. That last step is easy to lose: a raw ShaderMaterial gets
// no automatic output encode, and writing linear straight to the canvas
// darkened every frame ~60% the moment the post path switched on. With it
// right, pixels that no effect touches come through bit-identical to a direct
// render — verified by a direct-vs-post pixel diff.
// (SSAO's screen-space term is still here but unused; canopy AO replaced it.)

import * as THREE from 'three';

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
  uniform bool useAO;
  uniform bool useCanopy;
  uniform bool useBloom;
  uniform bool useRays;
  uniform bool useFXAA;
  varying vec2 vUv;
  const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
  // canopy shade: reconstruct the pixel's WORLD position from depth, look up
  // the crown-density map there, and darken only what sits UNDER the crowns
  // (the meta map carries ground + canopy-top heights, so sunlit canopy tops
  // and anything above the foliage stay bright)
  float canopyShade() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 0.9999) return 1.0;                       // sky
    vec4 ndc = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    vec4 v = uInvProj * ndc;
    vec3 world = (uCamWorld * vec4(v.xyz / v.w, 1.0)).xyz;
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
    if (useAO || useCanopy) {
      float occl = 1.0;
      if (useAO) {
        float ao = texture2D(tAO, vUv).r;          // 1 = open (guard pins it), <1 = occluded
        ao = mix(1.0, ao, aoStrength);             // scale the occlusion amount
        ao = max(ao, aoFloor);                     // deepest allowed darkening
        occl = ao;
      }
      // the canopy term is where the visible "AO" now lives: shade pools
      // under tree crowns and deepens where many crowns overlap
      if (useCanopy) occl *= canopyShade();
      // spare near-white highlights so speculars don't get gouged
      float hl = smoothstep(0.9, 1.0, dot(c, LUMA));
      float f = mix(occl, 1.0, hl);
      c *= f;                                       // occlusion is a LINEAR-light multiply
    }
    // shafts land BEFORE bloom so the brightest ones bloom too (they were
    // additively lit by the sun, so they take the sun's current colour —
    // white at noon, deep gold at sunset)
    if (useRays) c += rayColor * (texture2D(tRays, vUv).r * rayStrength);
    if (useBloom) c += texture2D(tBloom, vUv).rgb * bloomStrength;
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
      aoStrength: { value: 0.25 }, aoFloor: { value: 0.30 }, bloomStrength: { value: 0.55 },
      useAO: { value: false }, useCanopy: { value: false },
      useBloom: { value: false }, useRays: { value: false }, useFXAA: { value: false },
    });
    this._sunWorld = new THREE.Vector3();
    this._camFwd = new THREE.Vector3();
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

  // opts: { ssao, bloom, aoRadius, aoStrength, aoFloor, canopy, rays }
  // canopy: { densTex, metaTex, cx, cz, size, strength } — the world-space
  // crown-shade map maintained by canopy.js
  // rays:   { dir, color, strength } — dir is the world-space direction TO the
  //         sun; shafts fade out as it leaves the view and vanish behind you
  render(scene, camera, opts = {}) {
    const r = this.renderer;
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
    c.aoStrength.value = opts.aoStrength ?? 0.25;
    c.aoFloor.value = opts.aoFloor ?? 0.30;
    c.useRays.value = rayK > 0;
    c.tRays.value = rayK > 0 ? this.rtRay.texture : this.rtAOb.texture;
    c.rayStrength.value = rayK;
    if (rayK > 0 && opts.rays.color) c.rayColor.value.copy(opts.rays.color);
    const cp = opts.canopy;
    c.useCanopy.value = !!cp;
    // always bind real textures (unbound samplers trip driver warnings)
    c.tDepth.value = this.rtScene.depthTexture;
    c.tCanopy.value = cp ? cp.densTex : this.rtAOb.texture;
    c.tCanopyMeta.value = cp ? cp.metaTex : this.rtAOb.texture;
    if (cp) {
      c.uInvProj.value.copy(camera.projectionMatrixInverse);
      c.uCamWorld.value.copy(camera.matrixWorld);
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
