// ---- lightpools.js: what a street lamp does to the street -----------------
// A lamp head in this city is an emissive box. It glows, the bloom pass makes
// it glare, and it lights nothing: after dark the road between two glowing
// heads was exactly as black as a field. Real lights per lamp are out of the
// question (two thousand of them in view, each a term in every fragment of
// every material, and a recompile whenever the count changes).
//
// What a lamp contributes to a picture is three things, and all are cheap:
//
//   1. THE POOL. A warm ellipse of light under every lamp. One InstancedMesh of
//      flat quads holds them all; HOW they reach the frame depends on the path
//      (see below).
//   2. THE GLOW. A small soft sprite at each head, a second InstancedMesh. It
//      is what air does around a light, and it is what keeps a lamp three
//      hundred metres away a point of light after the box itself has shrunk
//      under a pixel. A lit street reads as a chain to the horizon.
//   3. THE BEAM. The same trick for headlights: one more InstancedMesh, a
//      long fan of light on the road in front of every car near the camera,
//      the player's included. It is the ONLY headlight on the road: Vehicles
//      used to lay a second additive quad under every AI car, and the two
//      together burnt a cream streak thirty metres long in front of each one.
//      (The two SpotLights main.js gives the player's car light walls and the
//      backs of other cars. They cannot light the road: a lamp 75 cm up meets
//      tarmac 15 m ahead at three degrees.) Cars move, so these few dozen
//      instances ARE rewritten every frame.
//
// TWO WAYS ONTO THE SCREEN.
//   * With the post stack (medium, high) the pools and fans are never drawn
//     into the scene at all. bake() draws them from above into a light map
//     (js/lampmap.js, which has the whole argument) and the composite lights
//     every pixel from it: the road keeps its texture, nothing is painted, and
//     whatever stands in the light is lit.
//   * Straight to the canvas (post off, the low preset) there is no composite,
//     so the quads are drawn as before: light added over the ground, floating
//     LIFT above it to clear kerbs and paint. What used to be wrong with that
//     was the ORDER. As transparents they were drawn after everything, so every
//     tyre and shoe under LIFT was painted orange. They are opaque-pass objects
//     now, sorted after the static world and before anything that walks or
//     drives (cars and people carry renderOrder 1): an actor drawn later simply
//     covers them. The quads light the GROUND and nothing else, so on this
//     path the light maps are baked as well (from inside the frame, the moment
//     the pools are about to be drawn: _bakeDirect) and people, cars and trees
//     read them in their own materials (lampmap.js lampDirectPatch). A walker
//     under a lamp is lit on the low preset too, and so is his car.
//
// Zero draw calls by day (the meshes are hidden and nothing is uploaded), and
// the lamp instance buffers are rewritten only when the SET of lamps changes:
// a chunk streamed in or out, a mast knocked down.
//
// WHERE THE LAMPS COME FROM. Not from the mesher. city.js already hands every
// chunk's masts to poles.js so that cars can hit them, and that registry
// (world.poles.grid) is the truth about which lamps are standing right now. A
// felled mast leaves the registry, so its pool goes out within half a second.

import * as THREE from 'three';
import { LampMap, SHAPES_GLSL, LAMP_DIRECT_U } from './lampmap.js';
import { FarLights } from './farlights.js';
import { addLandmarkLamps } from './landmarklamps.js';

const MAX = 2048;                 // instances; a full ring of the city holds ~1500
const RANGE = 430;                // m: pools and glows fade out by here
const REACH = RANGE + 70;         // m: how far out a rebuild collects
const MOVE_REBUILD = 55;          // m of camera travel that forces a rebuild
const CHECK_T = 0.5;              // s between looks at the registry

// the lamps, as js/streetlamps.js builds them. A STREET column holds its LED
// head 1.8 m out over the carriageway (the mast's local -z) and 7.5 m up; a
// PARK lantern (p.kind === 'park') carries its light on its own axis, 4 m up,
// and throws a smaller round pool.
const HEAD_OUT = 1.8, HEAD_Y = 7.5;
const PARK_Y = 4.0, PARK_POOL = 8.5;
// The pool. A street luminaire at 7 m throws an oval: long along the road,
// shorter across it, and centred a few metres out from the kerb. Lamps stand
// 34 m apart, so 15 m of half-length leaves a visible dark neck between two
// pools, which is what makes a street read as a CHAIN of them.
const POOL_LONG = 17, POOL_WIDE = 13, POOL_OUT = 3.4;
// Direct path only: height of the quads above the road surface. They have to
// clear the lane paint and any kerb or raised pavement (KERB_H 0.12 plus the
// paving), and a quad cannot follow a kerb.
const LIFT = 0.17;
// A pool on a bridge. The quad is 26 m across and a deck is 9: left alone, eight
// metres of lit sheet hung in the air past each parapet, over the valley (and
// on the light map its height took the street below out of its own lamps'
// light). A pool whose road stands more than DECK_UP over the bare ground is
// measured against the deck: the surface is probed across the road in
// DECK_STEP strides until it falls DECK_DROP away, and the quad is fitted
// between the two edges.
const DECK_UP = 1.0, DECK_DROP = 1.2, DECK_STEP = 0.5;
// city.js surfaceY answers "road" out to 0.35 m past the carriageway (a wheel
// just off the kerb), and the edge lies somewhere inside the last stride:
// taken at its near end, so the quad never reaches past the deck
const DECK_TRIM = 0.35 + DECK_STEP;
// Everything a look at the screen might want to move, in one object so that a
// harness can retune a live page (window.__atc.lightPools.tune).
//   level   how bright the middle of a pool is, as light per unit albedo in
//           the units of (hemisphere + sun) / pi, where full noon sun is about
//           0.8. The composite multiplies it by the surface it finds, holds
//           pale surfaces back (soft) and bends the sum (knee), so 0.85 puts
//           tarmac under a lamp where a dull afternoon would and paving well
//           short of white. The old 1.25 was added over a constant grey: on
//           real paving and paint it burnt.
//   beam    the same for the hottest part of a headlight fan
//   knee    the shoulder on SUMMED light (lampmap.js): at 0.55 one lamp keeps
//           three quarters of itself and six lamps come to about two
//   beamKnee  the fans' own shoulder: two cars facing each other do not burn
//           the road between them, and a fan on a lit street keeps its light
//   leaf    how far foliage in lamp light is held back (lampmap.js), 0..1
//   mapDirect  side of the pool map on the direct path, texels (the post path
//           has 1024): the things that read it there are a few metres across
//   lit     how bright a pixel may be, against a white surface in the ambient,
//           before it is taken for a light source and left alone
//   top     how high above the road the light still reaches, m
//   sun     the share of the moon (or the last sun) counted into the ambient
//           the albedo is recovered with
//   wall    the share of the ground's light a vertical surface takes
//   soft    how hard pale surfaces are held back (lampmap.js): 1 halves white
//   direct  the grey the quads assume on the path that cannot see the surface:
//           tarmac's. At 0.26 (paving) every pool was a cream wash on that path
//   glow    brightness of the sprite at a lamp head
//   far     brightness of the far field's points (farlights.js)
export const TUNE = { level: 0.85, beam: 0.62, knee: 0.6, lit: 1.3, top: 8.5, sun: 0.45,
  wall: 0.55, soft: 1.0, direct: 0.11, glow: 0.42, far: 1.3,
  beamKnee: 0.5, leaf: 1.0, mapDirect: 512 };
// Two kinds of lighting, by district rather than by lamp (a street does not
// alternate): high-pressure sodium, the orange of every Czech housing estate,
// and the warm-white LED that has been replacing it.
const SODIUM = [1.0, 0.56, 0.21], LED = [1.0, 0.80, 0.56];
const DISTRICT = 260;             // m: the size of a "same lamps" block
const LED_SHARE = 0.34;
// Headlight fans. Dipped beams reach about 35 m and are as wide as the road.
const BEAM_MAX = 96, BEAM_RANGE = 190;
const BEAM_LEN = 36, BEAM_WIDE = 7.5, BEAM_NOSE = 1.9;
const BEAM_COL = [0.95, 0.90, 0.74];
// The fan's pitch is read off the road this far ahead of the car: where most
// of the light lands, and near enough to still be on the deck round a bend.
// One look at the surface per car every BEAM_EVERY frames, not every frame.
const BEAM_AHEAD = 13, BEAM_EVERY = 6;
const BEAM_EASE = 0.25;           // share of the way to the new pitch taken each frame

const POOL_VERT = /* glsl */`
  uniform float uRange;
  varying vec2 vP;
  varying vec3 vCol;
  varying float vFade;
  #include <fog_pars_vertex>
  void main() {
    vP = position.xz;
    vCol = instanceColor;
    vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
    vec3 centre = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
    vFade = 1.0 - smoothstep(uRange * 0.76, uRange, distance(centre.xz, cameraPosition.xz));
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const POOL_FRAG = /* glsl */`
  uniform float uOn;        // 0 by day, 1 once the lamps are fully up
  uniform float uLevel;     // light per unit albedo x the grey this path assumes
  varying vec2 vP;
  varying vec3 vCol;
  varying float vFade;
  #include <fog_pars_fragment>
  ${SHAPES_GLSL}
  void main() {
    #ifdef ATC_BEAM
    float e = beamShape(vP);
    #else
    float e = poolShape(vP);
    #endif
    // what the fog has already taken from the ground it must take from the
    // light on it too, or a distant pool makes the haze itself glow
    float clear = 1.0;
    #ifdef USE_FOG
      // clamped: past the wall the amount can read a hair over 1, and the
      // square root of a negative is a NaN that paints the whole quad black
      clear = clamp(1.0 - atcFogAmount(), 0.0, 1.0);
      clear *= sqrt(clear);
    #endif
    // Only ever drawn straight to the canvas (see the header), where the frame
    // already holds tone-mapped sRGB, not light: the lamp's light on a
    // mid-grey street, through the same curve and encode as everything else.
    vec3 a = vCol * (uLevel * e * uOn * vFade * clear);
    #ifdef TONE_MAPPING
      a = toneMapping(a);
    #endif
    gl_FragColor = vec4(linearToOutputTexel(vec4(a, 1.0)).rgb, 1.0);
  }`;

const GLOW_VERT = /* glsl */`
  uniform float uRange;
  uniform float uPx;        // world metres per pixel at one metre of depth
  uniform float uSize;      // the glow's real radius, m
  uniform float uNear;      // farlights.js only: nothing nearer than this (0 = off)
  varying vec2 vP;
  varying vec3 vCol;
  varying float vK;
  #include <fog_pars_vertex>
  void main() {
    vP = position.xy;
    vCol = instanceColor;
    vec4 mvPosition = viewMatrix * modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float depth = max(0.1, -mvPosition.z);
    // never smaller than about two pixels across, so a far lamp stays a point
    // of light instead of flickering in and out between samples; what it
    // gains in area it gives back in brightness
    float size = max(uSize, depth * uPx * 1.1);
    float fade = 1.0 - smoothstep(uRange * 0.80, uRange, depth);
    if (uNear > 0.0) fade *= smoothstep(uNear * 0.80, uNear, depth);
    vK = fade * min(1.0, (uSize * uSize) / (size * size) * 3.0);
    mvPosition.xy += position.xy * size;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }`;
const GLOW_FRAG = /* glsl */`
  uniform float uOn;
  uniform float uLevel;
  uniform float uDirect;
  varying vec2 vP;
  varying vec3 vCol;
  varying float vK;
  #include <fog_pars_fragment>
  void main() {
    float r = length(vP);
    float g = exp(-r * r * 5.5) * (1.0 - smoothstep(0.7, 1.0, r));
    float clear = 1.0;
    #ifdef USE_FOG
      clear = clamp(1.0 - atcFogAmount(), 0.0, 1.0);
    #endif
    gl_FragColor = vec4(vCol * (g * vK * uOn * uLevel * clear), 1.0);
    // Straight to the canvas the glow needs the tone curve and the sRGB
    // encode like anything else. NOT via the tonemapping chunk: heightfog.js
    // puts the fog mix in there, and fog mixed into an additive sprite is a
    // fog-coloured square. Into the post target both of these are no-ops.
    #ifdef TONE_MAPPING
      gl_FragColor.rgb = toneMapping(gl_FragColor.rgb);
    #endif
    gl_FragColor = linearToOutputTexel(gl_FragColor);
    // added in the encoded space a glow reads stronger than added in light
    if (uDirect > 0.5) gl_FragColor.rgb *= 0.7;
  }`;

// deterministic, allocation-free hash of two integers to 0..1
function hash2(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const _m = new THREE.Matrix4(), _c = new THREE.Color();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();

export class LightPools {
  constructor(scene) {
    const fogU = () => THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {}]);
    const direct = (mat) => (renderer) => {
      mat.uniforms.uDirect.value = renderer.getRenderTarget() === null ? 1 : 0;
    };

    // ---- pools: unit quads lying flat, x = along the road, z = across it
    const pg = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
    this.poolMat = new THREE.ShaderMaterial({
      vertexShader: POOL_VERT, fragmentShader: POOL_FRAG,
      uniforms: { ...fogU(),
        uOn: { value: 0 }, uLevel: { value: 0 }, uRange: { value: RANGE } },
      // NOT transparent, although it blends: that is what puts it in the opaque
      // pass, where renderOrder can slot it between the world and the actors
      fog: true, transparent: false, depthWrite: false, depthTest: true,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    this.pools = new THREE.InstancedMesh(pg, this.poolMat, MAX);

    // ---- beams: the pool shader with a different footprint, own uniforms
    this.beamMat = this.poolMat.clone();
    this.beamMat.defines = { ATC_BEAM: '' };
    this.beamMat.uniforms.uRange.value = BEAM_RANGE;
    this.beams = new THREE.InstancedMesh(pg, this.beamMat, BEAM_MAX);

    // ---- glows: camera-facing quads at the lamp heads
    const gg = new THREE.PlaneGeometry(2, 2);
    this.glowMat = new THREE.ShaderMaterial({
      vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
      uniforms: { ...fogU(), uOn: { value: 0 }, uDirect: { value: 0 }, uLevel: { value: 1 }, uNear: { value: 0 },
        uRange: { value: RANGE }, uPx: { value: 0.001 }, uSize: { value: 1.15 } },
      fog: true, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
    });
    this.glows = new THREE.InstancedMesh(gg, this.glowMat, MAX);
    this.glows.onBeforeRender = direct(this.glowMat);

    for (const m of [this.pools, this.glows, this.beams]) {
      m.count = 0;
      m.visible = false;
      m.frustumCulled = false;          // the instances span the whole city
      m.matrixAutoUpdate = false;
      m.castShadow = m.receiveShadow = false;
      m.setColorAt(0, _c.setRGB(0, 0, 0));   // creates the instanceColor buffer
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    // Pools and fans: after the static world (renderOrder 0), before cars and
    // people (renderOrder 1), see the header. The glow is a real transparent,
    // first among them (after the clouds at −900): car glass, name tags and
    // smoke draw OVER it.
    this.pools.renderOrder = 0.5;
    this.beams.renderOrder = 0.6;
    this.glows.renderOrder = -790;
    // The direct path's bake: when the pools come up in the opaque pass (they
    // are hidden on the post path, so this never fires there) the static world
    // is drawn and nothing that walks or drives is yet. The fans alone carry
    // it where no lamp stands.
    this.pools.onBeforeRender = (renderer, scene, camera) => this._bakeDirect(renderer, camera);
    this.beams.onBeforeRender = (renderer, scene, camera) => {
      if (!this.pools.visible) this._bakeDirect(renderer, camera);
    };
    scene.add(this.pools, this.beams, this.glows);
    _c.setRGB(BEAM_COL[0], BEAM_COL[1], BEAM_COL[2]);
    for (let i = 0; i < BEAM_MAX; i++) this.beams.setColorAt(i, _c);   // one colour, set once

    // the same lamps, as points only, where the world is built below full
    // detail (js/farlights.js): what a helicopter sees of the town at night
    this.far = new FarLights(scene, this.glowMat, RANGE);
    this.scene = scene;
    this.tune = TUNE;
    this.map = null;                  // LampMap, made the first night the post path asks
    this.amb = new THREE.Color(0.02, 0.03, 0.04);
    this._sky = null;                 // the rig update() was last handed (bake reads its lights)
    this._baking = false;
    this._on = 0; this._baseY = 0; this._frame = 0;
    this.count = 0;
    this._t = 0; this._sum = NaN; this._n = -1;
    this._bx = Infinity; this._bz = Infinity;
  }

  /**
   * Every frame, after the camera has moved and after updateSky.
   *   world  the CityWorld (for world.poles and world.surfaceY)
   *   sky    the sky.js rig (nightK is all that is read)
   *   viewH  drawing-buffer height in pixels (renderer.domElement.height)
   *   cars   anything iterable of cars with their lamps on ({ x, z, heading,
   *          mesh }): the traffic set. `own` is the car being driven, which
   *          has usually left that set.
   */
  update(dt, camera, world, sky, viewH, cars = null, own = null) {
    const nightK = sky?.nightK ?? 0;
    // the lamps come up through dusk: nothing at 20 % of the way to night,
    // everything by 60 %
    let on = (nightK - 0.20) / 0.40;
    on = on < 0 ? 0 : on > 1 ? 1 : on;
    on = on * on * (3 - 2 * on);
    const poles = world?.poles;
    this._on = on;
    this._sky = sky;
    if (on <= 0.002 || !poles) {
      this.pools.visible = this.glows.visible = this.beams.visible = false;
      this.far.update(dt, camera, world, 0, 0, 0);
      this._on = 0;
      LAMP_DIRECT_U.uLampDK.value.x = 0;      // by day no material reads the maps
      return;
    }
    // The ambient the frame is lit with: what a white, level surface sends
    // back with no lamp near it. lampmap.js divides the frame by this to get
    // the surface back. The hemisphere in full; the moon (or the last of the
    // sun) in part, since half of everything is turned away from it.
    const h = sky.hemi, sn = sky.sun;
    const down = Math.max(0, sky.lightDir.y) * sn.intensity * TUNE.sun;
    this.amb.setRGB(
      (h.color.r * h.intensity + sn.color.r * down) / Math.PI,
      (h.color.g * h.intensity + sn.color.g * down) / Math.PI,
      (h.color.b * h.intensity + sn.color.b * down) / Math.PI);
    this._baseY = world.terrain?.heightAt?.(camera.position.x, camera.position.z) ?? camera.position.y;

    // ---- has the set of lamps changed? ----
    this._t -= dt;
    const cx = camera.position.x, cz = camera.position.z;
    const moved = Math.hypot(cx - this._bx, cz - this._bz) > MOVE_REBUILD;
    if (moved || this._t <= 0) {
      this._t = CHECK_T;
      // one pass over the registry, no allocation: a count and a position
      // checksum are enough to notice a chunk arriving or a mast going down
      let n = 0, sum = 0;
      for (const arr of poles.grid.values()) {
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i];
          if (!p.posts) continue;         // a traffic signal, not a lamp
          n++; sum += p.x * 0.731 + p.z * 1.377;
        }
      }
      if (moved || n !== this._n || sum !== this._sum) {
        this._n = n; this._sum = sum;
        this._rebuild(poles, world, cx, cz);
      }
    }

    // ---- per-frame: a uniform or two each, nothing else ----
    this.poolMat.uniforms.uOn.value = on;
    this.poolMat.uniforms.uLevel.value = TUNE.level * TUNE.direct;
    this.glowMat.uniforms.uOn.value = on;
    this.glowMat.uniforms.uLevel.value = TUNE.glow;
    this.glowMat.uniforms.uPx.value =
      2 * Math.tan((camera.fov * Math.PI) / 360) / Math.max(1, viewH);
    const show = this.count > 0;
    this.pools.visible = this.glows.visible = show;
    this.far.update(dt, camera, world, on, TUNE.far, this.glowMat.uniforms.uPx.value);

    // ---- headlight fans: rewritten every frame, there are only a few dozen
    this.beamMat.uniforms.uOn.value = on;
    this.beamMat.uniforms.uLevel.value = TUNE.beam * TUNE.direct;
    let k = 0;
    this._frame = (this._frame + 1) | 0;
    if (own) k = this._beam(k, own, cx, cz, world);
    if (cars) for (const c of cars) { if (c !== own && k < BEAM_MAX) k = this._beam(k, c, cx, cz, world); }
    this.beams.count = k;
    this.beams.visible = k > 0;
    if (k > 0) this.beams.instanceMatrix.needsUpdate = true;
    // nothing to bake from: the maps on the GPU are a place left behind
    if (!show && k === 0) LAMP_DIRECT_U.uLampDK.value.x = 0;
  }

  /**
   * The post path's half, called by PostFX.render just before it draws the
   * scene: draw this frame's light map and take the quads OUT of the scene
   * (update() puts them back every frame, so a frame drawn straight to the
   * canvas still gets them). Returns what the composite needs, or null by day.
   */
  bake(renderer, camera) {
    if (this._on <= 0.002) return null;
    this.pools.visible = this.beams.visible = false;
    // the composite lights everything from here on: no material adds its own
    LAMP_DIRECT_U.uLampDK.value.x = 0;
    const o = this._bakeMaps(renderer, camera, 1024);
    o.amb.copy(this.amb);
    o.knee = TUNE.knee; o.lit = TUNE.lit; o.top = TUNE.top;
    o.wall = TUNE.wall; o.soft = TUNE.soft;
    o.beamKnee = TUNE.beamKnee; o.leaf = TUNE.leaf;
    // the frame's own lights, for the composite's shadow fill (it reads the
    // shadow map and matrix off `sun` AFTER the scene is drawn, when both are
    // this frame's)
    o.sun = this._sky?.sun ?? null;
    o.hemi = this._sky?.hemi ?? null;
    return o;
  }

  // both paths: make sure the maps exist at the wanted size, and draw them
  _bakeMaps(renderer, camera, size) {
    if (this.map && this.map.size !== size) { this.map.dispose(); this.map = null; }
    if (!this.map) this.map = new LampMap(this.pools, this.beams, RANGE, BEAM_RANGE, size);
    // as much ground as can be seen through the night's haze, and no more:
    // the fewer metres the map spans, the finer a pool's edge is drawn
    const far = this.scene.fog?.far ?? RANGE;
    const cover = 2 * Math.max(150, Math.min(RANGE, far * 1.04));
    return this.map.bake(renderer, camera, cover, this._baseY, this._on, TUNE.level, TUNE.beam);
  }

  /**
   * The direct path's half (post off, the low preset), called from inside the
   * frame by the pool quads' onBeforeRender: bake the same maps and switch the
   * patched materials on. A render from inside a render is what three's own
   * Reflector does; the render target is put back and three re-binds its state
   * for the object it was about to draw. Whatever was drawn BEFORE the pools
   * this frame (the static world: tree trunks) read last frame's maps through
   * last frame's uniforms, which agree with each other.
   */
  _bakeDirect(renderer, camera) {
    if (this._baking || this._on <= 0.002 || renderer.getRenderTarget() !== null) return;
    this._baking = true;
    const o = this._bakeMaps(renderer, camera, TUNE.mapDirect);
    const u = LAMP_DIRECT_U;
    u.tLampD.value = o.tex; u.tBeamD.value = o.beamTex;
    u.uLampDMap.value.set(o.cx, o.cz, 1 / o.size, o.baseY);
    u.uBeamDMap.value.set(o.bx, o.bz, 1 / o.beamSize, TUNE.soft);
    u.uLampDK.value.set(1, TUNE.knee, TUNE.top, TUNE.wall);
    this._baking = false;
  }

  // one car's fan: a quad from its bumper out along its nose, lying on the
  // slope of the ROAD ahead. It used to take that slope from the bare terrain,
  // which a graded road follows and a bridge does not: over a valley the fan
  // dived under the deck (and was cut off at the bumper) or climbed metres
  // above it.
  _beam(k, c, cx, cz, world) {
    const dx = c.x - cx, dz = c.z - cz;
    if (dx * dx + dz * dz > BEAM_RANGE * BEAM_RANGE) return k;
    const fx = -Math.sin(c.heading), fz = -Math.cos(c.heading);
    const terr = world?.terrain;
    const carY = c.mesh?.position.y ?? terr?.heightAt?.(c.x, c.z) ?? 0;
    const y = carY + LIFT - 0.03;
    // kept on the car between looks; k staggers the cars over the frames
    let want = c._beamSlope;
    if (want === undefined || (this._frame + k) % BEAM_EVERY === 0) {
      want = c._beamSlope = beamSlope(world, c.x, c.z, fx, fz, carY);
    }
    // ...and the fan EASES to what the look found. Set outright, the pitch
    // changed on one frame in six, and at the foot of a ramp the far end of
    // the fan went up the road in steps of a quarter of a metre and more.
    let slope = c._beamPitch;
    slope = c._beamPitch = slope === undefined ? want : slope + (want - slope) * BEAM_EASE;
    // +0.004: a fan that floats a hand above the far tarmac is invisible, one
    // that dips under it is cut off in a line
    _z.set(-fx, -(slope + 0.004), -fz).normalize();   // local +z points BACK at the car
    _x.set(-fz, 0, fx);                                // the car's right
    _y.crossVectors(_z, _x);
    const half = BEAM_LEN / 2, mid = BEAM_NOSE + half;
    _m.set(
      _x.x * BEAM_WIDE, _y.x, _z.x * half, c.x + fx * mid,
      _x.y * BEAM_WIDE, _y.y, _z.y * half, y + (slope + 0.004) * mid,
      _x.z * BEAM_WIDE, _y.z, _z.z * half, c.z + fz * mid,
      0, 0, 0, 1);
    this.beams.setMatrixAt(k, _m);
    return k + 1;
  }

  _rebuild(poles, world, cx, cz) {
    this._bx = cx; this._bz = cz;
    const R2 = REACH * REACH;
    let k = 0;
    for (const arr of poles.grid.values()) {
      for (let i = 0; i < arr.length && k < MAX; i++) {
        const p = arr[i];
        if (!p.posts) continue;
        const dx = p.x - cx, dz = p.z - cz;
        if (dx * dx + dz * dz > R2) continue;
        // Where the pool lies is worked out once per mast and kept ON the
        // registry's own record, so a rebuild after the first is a copy.
        let s = p._pool;
        if (!s) s = p._pool = poolSpot(p, world);
        // pool: columns are (along the road) × length, the plane's normal,
        // (across the road) × width; translation is the pool's centre
        _x.set(s.ax, s.slope, s.az).normalize();
        _z.set(-s.az, 0, s.ax);                  // along × +Y, flat
        _y.crossVectors(_z, _x);
        _m.set(
          _x.x * s.pl, _y.x, _z.x * s.pw, s.x,
          _x.y * s.pl, _y.y, _z.y * s.pw, s.y,
          _x.z * s.pl, _y.z, _z.z * s.pw, s.z,
          0, 0, 0, 1);
        this.pools.setMatrixAt(k, _m);
        _m.makeTranslation(s.hx, s.hy, s.hz);
        this.glows.setMatrixAt(k, _m);
        const t = s.led ? LED : SODIUM;
        // a park lantern is a smaller lamp on a lower post: at a street
        // column's output the ground at its foot was a white spot
        const v = s.var * (s.pl === PARK_POOL ? 0.7 : 1);
        this.pools.setColorAt(k, _c.setRGB(t[0] * v, t[1] * v, t[2] * v));
        this.glows.setColorAt(k, _c.setRGB(t[0], t[1], t[2]));
        k++;
      }
    }
    // the lanterns of the landmark models (Charles Bridge), which are no masts
    k = addLandmarkLamps(this.pools, this.glows, world, cx, cz, k, MAX, REACH, LIFT);
    this.count = k;
    for (const m of [this.pools, this.glows]) {
      m.count = k;
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
    }
  }
}

// Everything about one mast's pool that does not change while it stands.
function poolSpot(p, world) {
  const rot = p.posts.userData?.spots?.[p.i * 3 + 2] ?? 0;
  // The mast's local axes in the world (a Y rotation by rot): +x runs ALONG
  // the kerb, and −z points at the carriageway it was placed beside (rot is a
  // heading, and a heading's forward is −z).
  const ax = Math.cos(rot), az = -Math.sin(rot);        // along the road
  const rx = -Math.sin(rot), rz = -Math.cos(rot);       // toward the road
  const park = p.kind === 'park';
  const out = park ? 0 : POOL_OUT, ho = park ? 0 : HEAD_OUT;
  let x = p.x + rx * out, z = p.z + rz * out;
  // surfaceY hands back ONE reused object: take the number, not the object.
  // It is told where the mast's foot is (p.y), so a lamp on the street UNDER
  // a viaduct lights the street and not the deck over its head.
  const ground = world.terrain?.heightAt?.(x, z) ?? p.y;
  const y0 = world.surfaceY?.(x, z, p.y)?.y ?? ground;
  let pw = park ? PARK_POOL : POOL_WIDE;
  if (!park && world.surfaceY && y0 - ground > DECK_UP) {
    const a = deckEdge(world, x, z, rx, rz, y0), b = deckEdge(world, x, z, -rx, -rz, y0);
    if (a + b < 2 * POOL_WIDE) {
      // between the two edges, so the window (lampmap.js poolShape) is zero
      // where the deck ends. Where only one side falls away (a street cut
      // into a slope) the pool moves over no further than it already hangs
      // out from its mast, and gives up the width instead.
      const sh = Math.max(-POOL_OUT, Math.min(POOL_OUT, (a - b) / 2));
      x += rx * sh; z += rz * sh;
      pw = Math.max(1, Math.min(a - sh, b + sh));
    }
  }
  const y1 = world.surfaceY?.(x + ax * 8, z + az * 8, y0)?.y ?? y0;
  const y2 = world.surfaceY?.(x - ax * 8, z - az * 8, y0)?.y ?? y0;
  // a graded road or a bridge ramp tilts the pool with it; a sample that fell
  // off the road onto a bank (more than a metre away in height) is ignored
  const slope = (Math.abs(y1 - y0) < 1.2 && Math.abs(y2 - y0) < 1.2) ? (y1 - y2) / 16 : 0;
  const cellI = Math.floor(p.x / DISTRICT), cellJ = Math.floor(p.z / DISTRICT);
  return {
    x, z, ax, az, slope,
    // above the surfacing whatever it is: the carriageway where there is one,
    // otherwise the whole layer ladder over bare ground
    y: Math.max(y0 + LIFT, ground + 0.20 + LIFT),
    // the head hangs TOWARD the road (it used to be drawn along the kerb)
    hx: p.x + rx * ho, hy: p.y + (park ? PARK_Y : HEAD_Y) - 0.12, hz: p.z + rz * ho,
    pl: park ? PARK_POOL : POOL_LONG, pw,
    led: hash2(cellI, cellJ) < LED_SHARE,
    var: 0.88 + 0.24 * hash2(Math.round(p.x * 10), Math.round(p.z * 10)),
  };
}

// How far from (x, z) the deck at height y0 runs in the direction (ux, uz),
// POOL_WIDE at most: the last stride that was still on it.
function deckEdge(world, x, z, ux, uz, y0) {
  for (let d = DECK_STEP; d <= POOL_WIDE; d += DECK_STEP) {
    if (y0 - world.surfaceY(x + ux * d, z + uz * d, y0).y > DECK_DROP) return Math.max(0, d - DECK_TRIM);
  }
  return POOL_WIDE;
}

// The pitch of the road in front of a car standing at height carY: rise over
// run to the surface BEAM_AHEAD metres along its nose. `carY` tells surfaceY
// which of two stacked roads is meant, so a car on a bridge reads the deck.
// Where the look ahead lands beside the road (a bend, a T junction) there is
// no surface to read: a car on the ground falls back to the lie of the land,
// as before, and a car on a deck (nothing but air out there) keeps its fan
// level. Anything steeper than one in five is a drop, not a road.
export function beamSlope(world, x, z, fx, fz, carY) {
  const terr = world?.terrain;
  const ax = x + fx * BEAM_AHEAD, az = z + fz * BEAM_AHEAD;
  let slope = 0;
  const s = world?.surfaceY?.(ax, az, carY);
  if (s?.road) slope = (s.y - carY) / BEAM_AHEAD;
  else if (terr?.heightAt) {
    const here = terr.heightAt(x, z);
    if (carY - here < DECK_UP) slope = (terr.heightAt(ax, az) - here) / BEAM_AHEAD;
  }
  return (slope > 0.2 || slope < -0.2) ? 0 : slope;
}

// ---- the player's headlights, under a night exposure ----
// main.js builds two SpotLights for the car being driven, at an intensity that
// was chosen under the day exposure. sky.js opens the exposure up after dark,
// which would make the beams two and a half times brighter than they were
// tuned to be and burn the road ahead out to white. This keeps what the
// player sees constant: called once a frame from updateNightLights.
// 22, where main.js builds them at 3.2: at 3.2 a wall eight metres ahead got a
// hundredth of the light a street lamp puts on the road under it. The fans
// above light the ROAD; these are for everything standing up in front of you.
const BEAM_BASE = 22;

// ---- everything that glows, under a night exposure ----
// The same problem as the beams, for every emissive main.js drives by hand.
// Their night values were chosen when the exposure never moved: a lamp head at
// 4.5, a tail lamp at 5.4, a shop sign at full white. Through the night
// exposure (three times the day's) each of them is a white hole with a halo,
// and a red tail lamp is pink. Called once a frame from updateNightLights,
// AFTER the lines that set the old values, this holds each one at a level
// where it is plainly the light source and still has its colour. Lamp heads
// and headlamps stay over linear 1.0, where the bloom finds them.
//   LAMP_HEAD  the luminaire: the brightest thing on the street, a white core
//   HEAD/TAIL  car lamps at midnight; by day main.js's own 1.4 stands
//   SIGN       a backlit fascia holds its DAY brightness to the eye (a little
//              over: it is lit, and the street round it is not)
const LAMP_HEAD = 1.5, CAR_HEAD = 1.3, CAR_TAIL = 0.62, CAR_DAY = 1.4, SIGN_POW = 0.82;
export function nightLevels(mats, lampMats, nightK, exposure, dayExposure) {
  const k = nightK < 0 ? 0 : nightK > 1 ? 1 : nightK;
  if (mats?.lampHead) mats.lampHead.emissiveIntensity = LAMP_HEAD * k;
  if (lampMats?.head) {
    lampMats.head.emissiveIntensity = CAR_DAY + (CAR_HEAD - CAR_DAY) * k;
    lampMats.tail.emissiveIntensity = CAR_DAY + (CAR_TAIL - CAR_DAY) * k;
  }
  // Unlit materials. toneMapped: false does not exempt them from the
  // composite's curve, so they are dimmed in step with the exposure instead: a
  // brake light stays the red it is by day.
  const hold = dayExposure / Math.max(0.1, exposure);
  if (lampMats?.brake) {
    const b = lampMats.brake;
    if (!b.userData.day) b.userData.day = b.color.clone();
    b.color.copy(b.userData.day).multiplyScalar(0.25 + 0.75 * hold);
  }
  if (mats?.doorSign) mats.doorSign.color.setScalar(Math.pow(dayExposure / Math.max(0.1, exposure), SIGN_POW));
}
export function nightBeams(a, b, exposure, dayExposure) {
  if (!a || !b) return;
  // not the full ratio: against a brighter night a beam should still gain a
  // little, or it stops reading as the brightest thing on the road
  const k = BEAM_BASE * Math.pow(dayExposure / Math.max(0.1, exposure), 0.8);
  a.intensity = b.intensity = k;
}
