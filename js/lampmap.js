// ---- lampmap.js: street light as a map of the ground, not as paint on it ----
// The first two versions of the lamp pools were quads lying on the road, blended
// over the frame. A quad cannot follow a kerb, so it floated 17 cm up to clear
// the pavements and painted every tyre and shoe under that height orange. It
// knew nothing of the surface below it, so tarmac, paint and paving all took
// the same cream and a junction under six lamps was a flat sheet. And it lit
// the ground and nothing else: a man under a lamp was a black figure on a
// bright floor.
//
// All three come from the same mistake, treating light as a decal. So the
// light is now DATA. Once a frame every pool and every headlight fan is drawn,
// from straight above, into one small float texture centred on the camera:
// how much lamp light arrives at each square metre of the town, summed the way
// light sums. The composite pass (postfx.js) already rebuilds each pixel's
// world position from the depth buffer for the tree shade; it now also looks
// that position up in this map and LIGHTS the pixel:
//
//     colour += albedo × lamp light,   albedo ≈ colour / ambient
//
// The frame at night is albedo × (moon + sky), and sky.js knows that ambient
// exactly, so dividing it back out recovers the surface. What falls out:
//   * tarmac stays tarmac and paint stays paint under a lamp, cracks and all,
//     because the light multiplies the real surface instead of covering it
//   * nothing floats, nothing is painted: the light lands on whatever is there
//   * a walker, a car, a tree trunk, a shop front standing in the pool are lit
//     exactly as the road under them is, up to the height of the lamp head
//   * a contact shadow or a creased corner stays dark under a lamp, since the
//     recovered albedo carries that shade with it
// It costs two small draw calls into a 1024 texture and one texture read per
// pixel in a pass that was running anyway. No light is added to any material,
// so nothing recompiles and the cost does not grow with the number of lamps.
//
// What it cannot do: cast a shadow (a wall does not stop the light).
//
// TWO MAPS. Lamp pools and headlight fans used to share one texture, and the
// shoulder that keeps six pools from going to milk was applied to their SUM: a
// fan on a lit road was the last third of an already bent curve and could not
// be seen. The fans now have a map of their own (smaller, and finer: fans only
// exist near the camera), and each kind of light is bent by itself, so a car's
// beam is a patch of whiter light on a sodium street as it is in a real one.
//
// WITHOUT THE COMPOSITE (post off, the low preset) lightpools.js still draws
// the quads over the ground, as before. But the same two maps are baked there
// too, and the things that STAND on the ground (people, cars, trees) read them
// in their own materials through the shared uniforms below (lampDirectPatch):
// a walker under a lamp is lit on the low preset as well. On the post path
// those materials are told to add nothing, the composite does it.

import * as THREE from 'three';
import { BEAM_T1, BEAM_T2 } from './poolspot.js';

// A fan follows its road (js/poolspot.js beamLie): `b` is how far the road
// stands over the fan's chord at its two inner nodes, and the strip runs
// straight from node to node. z is the strip's own coordinate along the fan,
// +1 at the bumper and -1 at the far end. Shared by the map pass here and the
// strip in lightpools.js, so the two paths lay the same fan.
const _f = (v) => v.toFixed(6);
export const BEND_GLSL = /* glsl */`
  float beamBend(vec2 b, float z) {
    float t = 0.5 - 0.5 * z;
    if (t < ${_f(BEAM_T1)}) return b.x * t / ${_f(BEAM_T1)};
    if (t < ${_f(BEAM_T2)}) return mix(b.x, b.y, (t - ${_f(BEAM_T1)}) / ${_f(BEAM_T2 - BEAM_T1)});
    return b.y * (1.0 - t) / ${_f(1 - BEAM_T2)};
  }`;

// The two footprints, shared by the map pass here and the quads in
// lightpools.js so the two paths light the same ground. `p` is the quad's own
// coordinate, -1..1 on both axes.
export const SHAPES_GLSL = /* glsl */`
  // a point source 7 m up over a plane: h^3 / (h^2 + r^2)^1.5, with r measured
  // in units of the pool's own half-length; then a window so the quad's edge is
  // exactly zero and can never show as a square
  float poolShape(vec2 p) {
    float r2 = dot(p, p);
    return (1.0 - smoothstep(0.50, 1.0, sqrt(r2))) / pow(1.0 + r2 * 3.4, 1.5);
  }
  // a headlight fan: t runs 0 at the bumper to 1 at the far end, the fan opens
  // as it goes, is brightest a third of the way out and has no edge
  float beamShape(vec2 p) {
    float t = 0.5 - p.y * 0.5;
    float w = p.x / (0.22 + 0.78 * t);
    float e = smoothstep(0.0, 0.10, t) * pow(max(1.0 - t, 0.0), 1.6) * exp(-w * w * 3.2);
    return e * (1.0 - smoothstep(0.75, 1.0, abs(p.x)));
  }`;

const MAP_VERT = /* glsl */`
  uniform vec4 uMap;        // centre x, centre z, 2 / metres covered, base height
  uniform vec3 uEye;        // the camera the frame is drawn from
  uniform float uRange;
  varying vec2 vP;
  varying vec3 vCol;
  varying float vFade;
  varying float vH;
  #ifdef ATC_BEAM
    attribute vec2 aBend;    // the fan's bend (js/lightpools.js: the direct path's shader has the same)
    ${BEND_GLSL}
  #endif
  void main() {
    vP = position.xz;
    vCol = instanceColor;
    vec4 world = instanceMatrix * vec4(position, 1.0);
    #ifdef ATC_BEAM
      world.y += beamBend(aBend, position.z);
    #endif
    vec3 centre = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vFade = 1.0 - smoothstep(uRange * 0.76, uRange, distance(centre.xz, uEye.xz));
    // the height of the lit plane rides in alpha, relative to the ground under
    // the camera and offset so that 0 can mean "nothing here" (a half float
    // resolves 3 cm at these magnitudes; an absolute 221 m would not)
    vH = clamp(world.y - uMap.w, -30.0, 30.0) + 32.0;
    gl_Position = vec4((world.x - uMap.x) * uMap.z, (world.z - uMap.y) * uMap.z, 0.0, 1.0);
  }`;
const MAP_FRAG = /* glsl */`
  uniform float uOn;
  uniform float uLevel;
  varying vec2 vP;
  varying vec3 vCol;
  varying float vFade;
  varying float vH;
  ${SHAPES_GLSL}
  void main() {
    #ifdef ATC_BEAM
    float e = beamShape(vP);
    #else
    float e = poolShape(vP);
    #endif
    gl_FragColor = vec4(vCol * (e * uOn * uLevel * vFade), vH);
  }`;

const SIZE = 1024;
// the fans' own map: they fade out 190 m from the camera, so 384 m of ground
// at 512 texels draws a fan's edge finer than the pools' map ever did
export const BEAM_SIZE = 512, BEAM_COVER = 384;

// ---- what a material needs to light itself from the maps (direct path) ----
// ONE set of objects, shared by every patched program: three uploads a uniform
// from whatever .value holds when the program is next used, so the bake writes
// here once and every walker, car and tree follows.
export const LAMP_DIRECT_U = {
  tLampD: { value: null },
  tBeamD: { value: null },
  uLampDMap: { value: new THREE.Vector4(0, 0, 0, 0) },   // pools: centre x, z, 1 / metres covered, base height
  // fans: centre x, z, 1 / metres covered; w: how hard a pale surface is held
  // back (the composite's `soft`, so both paths light a white shirt alike)
  uBeamDMap: { value: new THREE.Vector4(0, 0, 0, 1) },
  // x: 1 while materials light themselves (direct path, lamps on), else 0
  // y: knee of the summed light, z: top of the lamps' reach (m),
  // w: the share of the ground's light a vertical surface takes
  uLampDK: { value: new THREE.Vector4(0, 0.6, 8.5, 0.55) },
};

export class LampMap {
  /** `pools` and `beams` are the InstancedMeshes lightpools.js keeps: the maps
   *  draw twins that share their geometry and instance buffers. `size` is the
   *  pool map's side in texels (the direct path asks for a smaller one). */
  constructor(pools, beams, range, beamRange, size = SIZE) {
    this.size = size;
    const target = (n) => new THREE.WebGLRenderTarget(n, n, {
      type: THREE.HalfFloatType, colorSpace: THREE.LinearSRGBColorSpace,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
    });
    this.rt = target(size);
    this.rtBeam = target(BEAM_SIZE);
    const mat = (beam, r) => new THREE.ShaderMaterial({
      vertexShader: MAP_VERT, fragmentShader: MAP_FRAG,
      defines: beam ? { ATC_BEAM: '' } : {},
      uniforms: { uMap: { value: new THREE.Vector4() }, uEye: { value: new THREE.Vector3() },
        uRange: { value: r }, uOn: { value: 0 }, uLevel: { value: 1 } },
      depthTest: false, depthWrite: false, side: THREE.DoubleSide, transparent: true,
      // light ADDS; the plane height in alpha takes the highest (a bridge deck
      // over a street: the deck's lamps own that column)
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
    });
    const twin = (src, m) => {
      const t = new THREE.InstancedMesh(src.geometry, m, src.instanceMatrix.count);
      t.instanceMatrix = src.instanceMatrix;
      t.instanceColor = src.instanceColor;
      t.frustumCulled = false;
      t.matrixAutoUpdate = false;
      return t;
    };
    this.poolMat = mat(false, range);
    this.beamMat = mat(true, beamRange);
    this.pools = twin(pools, this.poolMat);
    this.beams = twin(beams, this.beamMat);
    this._src = [pools, beams];
    // one scene each: the two kinds of light land in different targets
    this.scene = new THREE.Scene();
    this.scene.add(this.pools);
    this.sceneB = new THREE.Scene();
    this.sceneB.add(this.beams);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._clear = new THREE.Color();
    // what postfx.js reads: the textures, where they lie, and the ambient the
    // frame was lit with (the divisor of the albedo estimate)
    this.out = { tex: this.rt.texture, cx: 0, cz: 0, size: 600, baseY: 0,
      beamTex: this.rtBeam.texture, bx: 0, bz: 0, beamSize: BEAM_COVER,
      amb: new THREE.Color(0.02, 0.03, 0.04), on: 0 };
  }

  /** Draw the maps for this frame. `cover` is the side of the square of ground
   *  the pool map spans, in metres; each map is centred on the camera in whole
   *  texels of its own, so a lamp's light never crawls across the road as the
   *  camera moves. */
  bake(renderer, camera, cover, baseY, on, level, beamLevel) {
    const o = this.out, texel = cover / this.size, btexel = BEAM_COVER / BEAM_SIZE;
    o.size = cover; o.baseY = baseY; o.on = on;
    o.cx = Math.round(camera.position.x / texel) * texel;
    o.cz = Math.round(camera.position.z / texel) * texel;
    o.bx = Math.round(camera.position.x / btexel) * btexel;
    o.bz = Math.round(camera.position.z / btexel) * btexel;
    // (two calls, not a loop over a fresh array: this runs every frame)
    this._aim(this.poolMat, o.cx, o.cz, cover, baseY, camera, on, level);
    this._aim(this.beamMat, o.bx, o.bz, BEAM_COVER, baseY, camera, on, beamLevel);
    this.pools.count = this._src[0].count;
    this.beams.count = this._src[1].count;
    this.pools.visible = this.pools.count > 0;
    this.beams.visible = this.beams.count > 0;
    const prev = renderer.getRenderTarget(), a = renderer.getClearAlpha();
    renderer.getClearColor(this._clear);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(this.rt);
    renderer.clear();
    if (this.pools.visible) renderer.render(this.scene, this.cam);
    renderer.setRenderTarget(this.rtBeam);
    renderer.clear();
    if (this.beams.visible) renderer.render(this.sceneB, this.cam);
    renderer.setClearColor(this._clear, a);
    renderer.setRenderTarget(prev);
    return o;
  }

  _aim(m, cx, cz, cover, baseY, camera, on, level) {
    const u = m.uniforms;
    u.uMap.value.set(cx, cz, 2 / cover, baseY);
    u.uEye.value.copy(camera.position);
    u.uOn.value = on;
    u.uLevel.value = level;
  }

  dispose() {
    this.rt.dispose(); this.rtBeam.dispose();
    this.poolMat.dispose(); this.beamMat.dispose();
  }
}

// ---- the composite's half ----
// lampLight() returns what to ADD to a pixel, in linear light, given the
// pixel's colour before any screen-space shade and its world position.
//
// THE MOON'S SHADOW UNDER A LAMP. The surface is recovered as colour over
// ambient, and in the shadow of a tree the colour is the hemisphere's alone:
// divided by the full ambient it came out a third too dark, and the lamp, which
// multiplies it, drew the moon's shadow straight through its own pool. So the
// one shadow map the frame was lit with is read here as well (five taps, only
// where lamp light arrives): a pixel the moon does not reach is divided by the
// ambient WITHOUT the moon, its albedo comes out whole, and the pool fills the
// shadow the way a lamp does.
export const LAMP_GLSL = /* glsl */`
  uniform sampler2D tLamp;
  uniform sampler2D tBeam;
  uniform vec4 uLampMap;      // pools: centre x, centre z, 1 / metres covered, base height
  uniform vec3 uBeamMap;      // fans: centre x, centre z, 1 / metres covered
  uniform vec3 uLampAmb;      // what a white horizontal surface shows without lamps
  uniform vec4 uLampShape;    // x: knee of the summed pools, y: how bright a
                              // pixel may be and still count as a lit surface,
                              // z: top of the lamps' reach, metres,
                              // w: knee of the summed fans
  uniform vec3 uLampSurf;     // x: share of the light a wall takes, y: how hard
                              // a pale surface is held back, z: how far
                              // foliage is held back (see below)
  uniform sampler2D tSunShadow;   // the one directional light's shadow map
  uniform mat4 uSunShadowMat;     // world to its uv and depth
  uniform vec3 uSunShadowK;       // x: 1 when it can be read, y: normal bias (m), z: 1 / map size
  uniform vec3 uSunDir;           // unit direction TO that light
  uniform vec3 uSunCol;           // its colour x intensity (the moon, after dark)
  uniform vec3 uHemiSky;          // hemisphere sky colour x intensity
  uniform vec3 uHemiGround;       // hemisphere ground colour x intensity
  // three's RGBA depth packing (packing.glsl), under an own name
  float atcShadowDepth(vec2 uv) {
    return dot(texture2D(tSunShadow, uv), vec4(255.0 / 256.0) / vec4(16777216.0, 65536.0, 256.0, 1.0));
  }
  // 1 where the directional light reaches the point, 0 in its shadow. Five
  // taps a texel apart: about the footprint of three's soft filter, so the
  // edge found here lies on the edge drawn in the frame.
  float atcSunLit(vec3 p, vec3 n) {
    vec4 sc = uSunShadowMat * vec4(p + n * uSunShadowK.y, 1.0);
    sc.xyz /= sc.w;
    if (sc.x < 0.0 || sc.x > 1.0 || sc.y < 0.0 || sc.y > 1.0 || sc.z > 1.0) return 1.0;
    float t = uSunShadowK.z;
    float s = step(sc.z, atcShadowDepth(sc.xy))
      + step(sc.z, atcShadowDepth(sc.xy + vec2(t, t)))
      + step(sc.z, atcShadowDepth(sc.xy + vec2(-t, t)))
      + step(sc.z, atcShadowDepth(sc.xy + vec2(t, -t)))
      + step(sc.z, atcShadowDepth(sc.xy + vec2(-t, -t)));
    // the same feathered rim sky.js gives the box in every material
    return mix(s * 0.2, 1.0, smoothstep(0.86, 1.0, length(abs(sc.xy - 0.5) * 2.0)));
  }
  // one map's light at a world point: rgb, and in a how much of it reaches
  // this height (above the lit plane the light thins out toward the lamp
  // head; under it, the street below a lit bridge, there is none)
  // (h: the point's height over the lit plane, for the caller)
  vec4 atcLampTap(sampler2D map, vec2 uv, float y, float base, out float h) {
    vec2 e = abs(uv - 0.5);
    float em = max(e.x, e.y);
    h = 1e3;
    if (em >= 0.5) return vec4(0.0);
    vec4 m = texture2D(map, uv);
    h = y - (m.a - 32.0 + base);
    float reach = (1.0 - smoothstep(1.8, uLampShape.z, h)) * smoothstep(-2.6, -0.7, h);
    // and no ruled line where the map ends
    return vec4(m.rgb, reach * (1.0 - smoothstep(0.44, 0.5, em)));
  }
  // wdx, wdy: the screen-space derivatives of world, taken by the caller
  // OUTSIDE any branch (a derivative inside one is undefined)
  vec3 lampLight(vec3 c, vec3 world, vec3 wdx, vec3 wdy, vec3 ray, float camY) {
    float hp, hb;
    vec4 mp = atcLampTap(tLamp, (world.xz - uLampMap.xy) * uLampMap.z + 0.5, world.y, uLampMap.w, hp);
    vec4 mb = atcLampTap(tBeam, (world.xz - uBeamMap.xy) * uBeamMap.z + 0.5, world.y, uLampMap.w, hb);
    float Lp = max(mp.r, max(mp.g, mp.b)), Lb = max(mb.r, max(mb.g, mb.b));
    if (Lp * mp.a + Lb * mb.a < 0.0005) return vec3(0.0);
    // Light sums, eyes do not: where six pools meet, the sum is several lamps'
    // worth and the junction went to milk. A soft shoulder on the summed light
    // keeps one lamp's pool as it is and bends the pile-up. The fans have a
    // shoulder of their OWN: bent together with the pools, a headlight on a
    // lit street added a sliver and could not be seen.
    vec3 light = mp.rgb * (mp.a / (1.0 + Lp * uLampShape.x)) + mb.rgb * (mb.a / (1.0 + Lb * uLampShape.w));
    // The map knows how much light reaches the GROUND. A wall stands edge on
    // to a lamp over the road and takes a fraction of it; which way a surface
    // faces comes from how its world position changes across the pixel. At a
    // silhouette that change is a jump between two objects and means nothing,
    // so there the surface is taken as level (no dark line round a figure).
    vec3 n = cross(wdx, wdy);
    float nl = length(n);
    n = nl > 1e-12 ? n / nl : vec3(0.0, 1.0, 0.0);
    if (dot(n, ray) > 0.0) n = -n;
    float up = abs(n.y);
    float jump = smoothstep(0.03, 0.06, max(length(wdx), length(wdy)) / max(length(ray), 0.5));
    float face = mix(uLampSurf.x, 1.0, max(smoothstep(0.35, 0.85, up), jump));
    n = normalize(mix(n, vec3(0.0, 1.0, 0.0), jump));
    // The ambient this pixel was lit with: all of it in the open, the
    // hemisphere's share alone where the moon (or the last sun) is shadowed.
    vec3 amb = uLampAmb;
    if (uSunShadowK.x > 0.5) {
      float ndl = max(dot(n, uSunDir), 0.0);
      if (ndl > 0.02) {
        vec3 H = mix(uHemiGround, uHemiSky, 0.5 + 0.5 * n.y);
        vec3 M = uSunCol * ndl;
        amb *= (H + M * atcSunLit(world, n)) / (H + M);
      }
    }
    // The surface, recovered from the frame: colour over ambient, per channel,
    // so a red car is lit red. A pixel much brighter than a white wall could be
    // in this ambient is not a surface, it is a lamp, a window or a sign, and
    // gets nothing (lit glass must not be lit twice).
    vec3 alb = min(c / amb, vec3(1.0));
    float x = dot(c, vec3(0.2126, 0.7152, 0.0722)) / dot(amb, vec3(0.2126, 0.7152, 0.0722));
    alb *= 1.0 - smoothstep(uLampShape.y, uLampShape.y * 2.6, x);
    // Leaves. A crown's colour is tuned for the sun, which shades one side of
    // it and shadows the inside; a lamp term has neither, and every leaf in
    // reach came out at its full daylight green, twice as bright as the road
    // under it. Foliage is found by its colour (green well clear of red and
    // blue) and held back to what a mass of leaves under a street lamp is: a
    // dull olive. A lawn, which lies flat in the light, gives up far less.
    float gd = (alb.g - max(alb.r, alb.b)) / max(alb.g, 1e-3);
    float leaf = smoothstep(0.10, 0.32, gd) * uLampSurf.z;
    leaf *= mix(0.3, 1.0, smoothstep(0.4, 2.2, Lp > 0.0 ? hp : hb));
    alb = mix(alb, vec3(dot(alb, vec3(0.30, 0.59, 0.11))) * vec3(0.95, 1.0, 0.70), leaf * 0.65) * (1.0 - 0.52 * leaf);
    // A lamp is tuned on tarmac, which sends back a tenth of what falls on it.
    // A white rendered wall sends back eight times that, and beside a lamp it
    // was a blank sheet. Eyes and film both give way at the top, so the pale
    // end is held back: tarmac keeps all of its light, plaster about half.
    alb /= 1.0 + alb * uLampSurf.y;
    // the haze has already taken its share of the ground; take it from the
    // light on it too, or a distant pool makes the air itself glow
    float clear = atcAirClear(ray, camY);
    return alb * light * (face * clear * clear);
  }`;

// ---- a material's half (the direct path) ----
// atcLampDirect() is the same two maps read from inside a lit material: what
// a surface at a world point sends back of the lamps' light, in the units of
// albedo x (hemisphere + sun) / pi. `up` is the world y of the surface normal. `cut` is 1 for things
// that stand in the static world: the pool quads are drawn over those and
// already paint everything under their own plane, so the material adds
// nothing down there (a trunk's foot was lit twice).
export const LAMP_DIRECT_GLSL = /* glsl */`
  uniform sampler2D tLampD;
  uniform sampler2D tBeamD;
  uniform vec4 uLampDMap;
  uniform vec4 uBeamDMap;
  uniform vec4 uLampDK;
  vec3 atcLampDirectTap(sampler2D map, vec3 where, vec3 world, float cut) {
    vec2 uv = (world.xz - where.xy) * where.z + 0.5;
    vec2 e = abs(uv - 0.5);
    float em = max(e.x, e.y);
    if (em >= 0.5) return vec3(0.0);
    vec4 m = texture2D(map, uv);
    float h = world.y - (m.a - 32.0 + uLampDMap.w);
    float reach = (1.0 - smoothstep(1.8, uLampDK.z, h)) * smoothstep(-2.6, -0.7, h)
      * mix(1.0, step(0.0, h), cut) * (1.0 - smoothstep(0.44, 0.5, em));
    return m.rgb * (reach / (1.0 + max(m.r, max(m.g, m.b)) * uLampDK.y));
  }
  // alb: the surface's own diffuse colour. The result is what the surface
  // SENDS BACK, with the pale end held as the composite holds it (lampmap.js
  // LAMP_GLSL): tarmac keeps all of its light, a white shirt about half.
  vec3 atcLampDirect(vec3 world, float up, float cut, vec3 alb) {
    vec3 sum = atcLampDirectTap(tLampD, uLampDMap.xyz, world, cut) + atcLampDirectTap(tBeamD, uBeamDMap.xyz, world, cut);
    return sum * alb / (1.0 + alb * uBeamDMap.w) * mix(uLampDK.w, 1.0, smoothstep(0.35, 0.85, up));
  }`;

// The fragment's world position and its normal's world y, from what every lit
// three material already has (vViewPosition, the view matrix), so no vertex
// shader is touched and skinning, instancing and the trees' wind all hold.
// (World y of a view-space normal is the view matrix's SECOND COLUMN dotted
// with it, viewMatrix[ 1 ].xyz: the inverse of a rotation is its transpose.
// The second ROW, which stood here first, is the camera's up axis instead, and
// a car roof went dim whenever the camera looked down at it.)
export const LAMP_DIRECT_WORLD = /* glsl */`
		vec3 atcLampW = cameraPosition - vViewPosition * mat3( viewMatrix );
		float atcLampUp = dot( viewMatrix[ 1 ].xyz, normal );`;

/**
 * Give a lit three material (Lambert, Standard, Physical) street light on the
 * direct path. Call from its onBeforeCompile; the material must also carry a
 * customProgramCacheKey of its own. Costs one uniform test on the post path
 * and two texture reads per fragment where it is live.
 *   cut  true for static things the pool quads are drawn over (see above)
 */
export function lampDirectPatch(sh, cut = false) {
  Object.assign(sh.uniforms, LAMP_DIRECT_U);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\n' + LAMP_DIRECT_GLSL)
    .replace('#include <lights_fragment_begin>', `#include <lights_fragment_begin>
#if defined( RE_IndirectDiffuse )
	if ( uLampDK.x > 0.5 ) {${LAMP_DIRECT_WORLD}
		// already times the albedo, so it goes straight to the diffuse sum
		// (irradiance would be multiplied by albedo / pi once more)
		reflectedLight.indirectDiffuse += atcLampDirect( atcLampW, atcLampUp, ${cut ? '1.0' : '0.0'}, material.diffuseColor );
	}
#endif`);
}
