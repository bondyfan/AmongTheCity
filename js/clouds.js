// ---- Clouds: a sky you can fly INTO, made of flat sprites ----
// A helicopter changes what the sky has to be. Painted clouds on the dome
// (sky.js's FBM layer) are fine while the camera lives at street level, but
// the moment you climb to 300 m you need cloud you can approach, pass beside
// and punch through — and a real raymarch would cost more than the whole city
// does. So: ~14 CLUSTERS of 6–8 camera-facing puffs each. One puff is a soft
// radial-gradient sprite; a cluster's puffs are scattered in all three axes
// with a flat base and a cauliflower top, so from any angle — beside it,
// under it, above it, inside it — the silhouette has depth instead of being
// one card that flips to a line when you circle it.
//
// ONE DRAW CALL, AND WHY IT TOOK A SORT. These are soft, NORMAL-blended,
// depth-write-free quads that constantly overlap each other, and overlapping
// alpha is order-dependent: draw them in a fixed order and flying around a
// cluster smears its grey underside over its sunlit top. The first version
// got the order for free by making every puff its own THREE.Sprite and letting
// the renderer sort them, back when there were a hundred. The field grew to
// 2 900 puffs on the default setting (7 600 on the furthest), each a draw call
// with its own material: the single largest item in the frame, more than the
// whole city. So the puffs are now instances of one quad in one mesh, and the
// order is put back by hand: update() already visits every puff to fade and
// light it, and it now also drops each into a distance bucket and writes the
// instance buffers far-to-near (a counting sort: linear, no comparator, no
// allocation). Same picture, one draw.
//
// WHY the field is infinite: the clusters live on a 3600 m torus. Every frame
// each cluster's offset from the camera is wrapped into ±1800 m, i.e. we draw
// the NEAREST copy of an infinitely tiled pattern. Wrapping is a symmetry of
// that pattern, so it can never produce a seam — and the wrap can never pop
// either, because a puff is already at exactly zero opacity long before it
// reaches the wrap boundary (see the proof above FADE_CAP).
//
//   const clouds = new Clouds(scene);
//   clouds.update(dt, camera, sunDir, nightK);   // sunDir + nightK from sky.js

import * as THREE from 'three';

// ---- field shape ----
// 14 clusters over a ±1800 m field is one cloud per square kilometre — with
// the far fade biting at 773 m that left one or two faint puffs anywhere near
// the camera, which is why the sky looked empty. A real cumulus field is far
// busier, so: many more bodies, and a field only wide enough that the ones you
// can actually SEE are dense.
// ---- draw distance -------------------------------------------------------
// One knob with three notches, and every other number here follows from it, so
// the wrap invariant below cannot be broken by picking a bigger sky.
//
//   range   how far a cloud is still drawn
//   field   half-width of the torus the field tiles with; must exceed `range`
//           by more than a puff's reach, or a cluster would still be visible
//           at the moment it teleports to the other side
//   n       cluster count, chosen to hold the sky's DENSITY roughly constant
//           (2.5 → 1.7 bodies per km² across the three; it thins deliberately,
//           because a sprite is one draw call and the visible count grows with
//           the square of the range — 1700, 3200 and 5200 puffs on screen)
//
// The ranges are set by the CEILING, not by taste. With a base 1350 m up, a
// 2.6 km field would only show cloud steeper than 27° above the horizon — a
// patch overhead and a bare horizon, which is not what a sky looks like. These
// three put the lowest cloud at 19°, 13° and 9°.
export const CLOUD_RANGES = {
  medium:   { range: 4000, field: 4600, n: 210 },
  far:      { range: 6000, field: 6600, n: 360 },
  furthest: { range: 8500, field: 9100, n: 560 },
};
export const CLOUD_DIST_DEFAULT = 'medium';
// A real cumulus is a pile of many lobes, not six blobs — more puffs per body
// is what turns a smudge into cauliflower with an actual silhouette.
const PUFFS = [11, 16];          // sprites per cluster (inclusive range)

// ---- how high a cloud actually is ----------------------------------------
// A cloud is where rising air got cold enough to condense. Air lifted off the
// ground cools at about 9.8 °C per km; the dew point it carries falls at only
// ~1.8 °C per km, so the two converge, and the height where they meet is the
// LIFTING CONDENSATION LEVEL — the cloud base. The pilot's rule of thumb is
//
//     base ≈ 125 m × (temperature − dew point), in °C
//
// so a Czech summer afternoon at 24 °C with a dew point of 12 °C puts fair-
// weather cumulus about 1500 m up. Below that height the air is simply not
// cold enough to hold a cloud, which is why you never walk through one.
//
// The part that matters for a world with hills in it: temperature and dew
// point are properties of the AIR MASS, not of the ground under it. So the
// condensation level sits at a nearly constant altitude ABOVE SEA LEVEL across
// a whole region — pilots call it the ceiling and mean it literally, a flat lid
// every cumulus in sight shares. It does not rise with the terrain, which is
// exactly why clouds appear to sit on ridges and swallow mountain tops: the
// ridge climbs into the lid.
//
// So these are METRES ABOVE SEA LEVEL, the same y everything else in the world
// now uses. They were 230–620 back when the ground was a plane at zero and the
// two were the same thing; on real terrain that put the whole sky underground
// in Pardubice (221 m) and 130 m below the ridges above Zlín.
//
// Genera, for the record, and roughly what this builds:
//   low    cumulus, stratocumulus     base   0–2000 m   ← deck 1
//   middle altocumulus, altostratus   base 2000–7000 m  ← deck 2
//   high   cirrus (ice)               base 5000–13000 m ← not modelled
const BASE_LOW = 1350;           // m MSL — the fair-weather cumulus ceiling
const BASE_MID = 2650;           // m MSL — a thinner stratocumulus deck above
const BASE_JITTER = 55;          // the lid is flat, not laser-levelled
const MID_SHARE = 0.28;          // how many clusters belong to the upper deck
const SPREAD_H = 210;            // puff scatter around the cluster axis, meters
const SPREAD_V = 88;             // …and vertically: flat base, towering top
// Real fair-weather cumulus run 0.5–2 km across. At 155–255 m these read as
// dabs of mist; the bodies now measure hundreds of metres, which is also what
// lets you fly INTO one instead of past it.
const PUFF_D = [300, 520];       // puff sprite diameter, meters
const WIND = { x: 2.7, z: 0.95 };// prevailing westerly, drifting east-southeast

// ---- look ----
// Linear working-space colours (Color(r,g,b) is linear here). The puffs are
// tone-mapped like every other object in the scene, so values near 1 merely
// land high on the ACES curve. They must stay UNDER 1.0 though: the bloom pass
// thresholds on linear light before the curve, and a sky that blooms washes
// the whole frame the way only the overbright lamps are meant to. (The tops
// used to sit at 1.45 and did exactly that.)
// Contrast is the whole game here. The first pass used #dbdfe5 puffs against a
// horizon sky that is ALSO pale grey-blue — measured as very nearly the same
// value, so the field rendered correctly and still read as "no clouds". Tops
// now sit clearly above the sky's brightness and undersides clearly below it.
const LIT = new THREE.Color(0.98, 0.97, 0.94);   // sun-facing cauliflower tops
const SHADE = new THREE.Color(0.26, 0.31, 0.44); // grey-blue undersides
const LIT_W = new THREE.Color(0.99, 0.60, 0.33); // golden hour: lit sides go amber
const SHADE_W = new THREE.Color(0.34, 0.27, 0.38);
// night: barely-there moonlit grey. Small numbers, because sky.js opens the
// exposure up after dark and these are seen through it.
// (A quarter down from 0.040 / 0.012: the tone curve's toe is open now
// (heightfog.js lookGLSL) and the old values came out as pale daytime puffs
// in a midnight sky.)
const LIT_N = new THREE.Color(0.029, 0.037, 0.060);
const SHADE_N = new THREE.Color(0.009, 0.011, 0.021);
const OPACITY = 0.82;            // master alpha; puffs jitter ±18 % around it

// ---- fades (the two reasons nothing ever pops) ----
// FAR: derived from camera.far so the field can never straddle the far plane.
// A sprite's four corners share their centre's view-space depth (three builds
// the quad in view space), so a sprite does not clip gradually — it would
// vanish WHOLE the instant its centre crossed camera.far. Hence the far fade
// must reach zero strictly inside it: 0.89·far, capped at the chosen `range`.
//
// That cap is what keeps the WRAP invisible, and it is the one invariant this
// module has to hold. At the wrap boundary a cluster centre sits `field` metres
// away, and no puff's visible edge is further than PUFF_REACH from its centre,
// so every puff that wraps is at least (field − PUFF_REACH) out. Require
//
//     range ≤ field − PUFF_REACH
//
// and a wrapping puff's opacity is exactly 0 on both sides of the jump: the
// recentre moves geometry that is not on screen, whatever the camera is doing.
// CLOUD_RANGES is asserted against this on load, because the old version was a
// hand-computed constant (4200) describing a field that had since grown to
// 2600 — so the proof in this comment had quietly stopped being true.
// PUFF_REACH is that "puff's reach": how far a sprite's visible edge can sit
// from its cluster's centre. The old constant was a hand-computed 4200 that
// silently stopped matching the field when it grew, so the wrap was no longer
// provably invisible; it is now derived, and the range table above is checked
// against it.
const FADE_FAR_K = 0.89, FADE_IN_K = 0.72;
// centre offset (SPREAD_H wide, SPREAD_V tall) plus the sprite's own half-width
const PUFF_REACH = Math.hypot(SPREAD_H, SPREAD_V) + PUFF_D[1] / 2;
for (const [name, r] of Object.entries(CLOUD_RANGES)) {
  if (r.range > r.field - PUFF_REACH) {
    throw new Error(`clouds: ${name} range ${r.range} exceeds field ${r.field} `
      + `less puff reach ${PUFF_REACH.toFixed(0)} — the wrap would be visible`);
  }
}
// NEAR: a puff you fly into would otherwise fill the screen with one flat
// smear and then blink out the instant the camera crossed its centre (a
// point sprite behind the eye is simply gone). Fading it over its own radius
// turns that blink into a whiteout that thins as you pass through the cloud.
// This IS camera-distance-driven, but it is a smoothstep of distance with no
// thresholds anywhere, so it cannot pop — the failure mode the contract bans
// is a discontinuity, not a dependence on distance.
const FADE_NEAR_K = 1.55;        // full opacity once d > 1.55 × puff radius

// deterministic sky: the same 14 clouds every session, so a screenshot taken
// today can be compared with one taken last week
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp01 = (v) => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth01 = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

// ---- the one texture every sprite shares ----
// A plain airbrushed disc reads as a bubble, so the alpha is built from ~34
// overlapping soft blobs ADDED together (a lumpy interior) and then multiplied
// by a radial mask, which guarantees the puff always ends in air no matter how
// the lumps fell. RGB stays pure white: all colour comes from per-puff
// material.color, which is what lets one texture light 100 sprites differently.
function makePuffTexture() {
  // headless (node --test with a three shim) has no DOM: fall back to the same
  // profile evaluated into a small DataTexture so the module stays importable
  if (typeof document === 'undefined') return makePuffTextureHeadless();
  const S = 256, R = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const rnd = mulberry32(0x5EED17);
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 34; i++) {
    const a = rnd() * Math.PI * 2, rr = Math.sqrt(rnd()) * R * 0.40;
    const px = R + Math.cos(a) * rr, py = R + Math.sin(a) * rr;
    const br = R * (0.16 + rnd() * 0.24);
    const g = ctx.createRadialGradient(px, py, 0, px, py, br);
    g.addColorStop(0, 'rgba(255,255,255,0.24)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(px - br, py - br, br * 2, br * 2);
  }
  ctx.globalCompositeOperation = 'destination-in';
  const m = ctx.createRadialGradient(R, R, 0, R, R, R);
  m.addColorStop(0.00, 'rgba(255,255,255,1)');
  m.addColorStop(0.34, 'rgba(255,255,255,0.98)');
  m.addColorStop(0.62, 'rgba(255,255,255,0.62)');
  m.addColorStop(0.85, 'rgba(255,255,255,0.16)');
  m.addColorStop(1.00, 'rgba(255,255,255,0)');
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter; // puffs shrink to specks at 1.2 km
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function makePuffTextureHeadless() {
  const S = 32, R = S / 2, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
    const a = u >= 1 ? 0 : Math.pow(1 - u, 1.6);
    const i = (y * S + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(a * 255);
  }
  const tex = new THREE.DataTexture(data, S, S);
  tex.needsUpdate = true;
  return tex;
}

// scratch: the update loop must not allocate, it runs on every sub-step
const _lit = new THREE.Color(), _shade = new THREE.Color();

// ---- the one material ----
// A camera-facing quad per instance, built in view space exactly as
// THREE.Sprite builds its own: all four corners share the centre's depth, so
// the far-fade reasoning above still holds word for word.
//   iPos  xyz world centre, w diameter
//   iCol  rgb linear colour, a opacity
//   iRot  cos and sin of the puff's fixed in-plane rotation
const PUFF_VERT = /* glsl */`
  attribute vec4 iPos;
  attribute vec4 iCol;
  attribute vec2 iRot;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vUv = uv;
    vCol = iCol;
    vec4 mv = viewMatrix * vec4(iPos.xyz, 1.0);
    vec2 q = position.xy * iPos.w;
    mv.xy += vec2(q.x * iRot.x - q.y * iRot.y, q.x * iRot.y + q.y * iRot.x);
    gl_Position = projectionMatrix * mv;
  }`;
const PUFF_FRAG = /* glsl */`
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vCol;
  void main() {
    vec4 t = texture2D(map, vUv);
    gl_FragColor = vec4(vCol.rgb * t.rgb, vCol.a * t.a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

// distance buckets for the back-to-front sort. A puff is 300 m and more
// across, so buckets a few metres deep order them as well as an exact sort.
const BUCKETS = 1024;

export class Clouds {
  constructor(scene, dist = CLOUD_DIST_DEFAULT) {
    this.scene = scene;
    this.tex = makePuffTexture();
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false; // stays at the origin; instances carry world pos
    this.mat = new THREE.ShaderMaterial({
      vertexShader: PUFF_VERT, fragmentShader: PUFF_FRAG,
      uniforms: { map: { value: this.tex } },
      transparent: true,
      depthWrite: false,   // puffs must not carve each other out of the depth buffer
      depthTest: true,     // …but the CITY still occludes them, as it must
      fog: false,          // they live above the fog wall; fogging them greys the sky out
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;  // the instances span the whole sky
    this.mesh.renderOrder = -900;     // behind every other transparent thing (glass, rotor disc)
    this.mesh.matrixAutoUpdate = false;
    this.group.add(this.mesh);
    this.clusters = [];
    this.puffCount = 0;
    this.drawn = 0;                   // puffs on screen after the last update()
    this._bucket = new Uint32Array(BUCKETS + 1);
    this._build(dist);
  }

  /** Swap the draw distance. Rebuilds the field, which is a fresh set of
   *  instance buffers: cheap enough for a settings panel and never for a frame. */
  setDist(dist) {
    if (dist === this.dist || !CLOUD_RANGES[dist]) return;
    this._build(dist);
  }

  _build(dist) {
    const cfg = CLOUD_RANGES[dist] ?? CLOUD_RANGES[CLOUD_DIST_DEFAULT];
    this.dist = CLOUD_RANGES[dist] ? dist : CLOUD_DIST_DEFAULT;
    this.clusters = [];
    this.puffCount = 0;
    this.range = cfg.range;
    this.field = cfg.field;
    this.period = cfg.field * 2;
    const CLUSTERS = cfg.n, FIELD = cfg.field, PERIOD = this.period;
    const rnd = mulberry32(0xC10D5);

    // Stratified placement over a G×G grid of the torus, shuffled. Pure random
    // would regularly leave a whole quadrant of sky empty and pile four
    // clusters into one corner, which reads as a bug rather than as weather.
    //
    // G is derived from the cluster count, and that is not a tidy-up: the grid
    // was a fixed 4×4 = 16 cells from when the field held 14 bodies, and when
    // the count grew to 120 nothing grew with it. `cells[c]` was undefined for
    // every cluster past the sixteenth, so gx was NaN and 104 of 120 clouds
    // were built at coordinate NaN — present in the scene, counted in the
    // budget, and never drawn.
    const G = Math.ceil(Math.sqrt(CLUSTERS));
    const cells = [];
    for (let i = 0; i < G * G; i++) cells.push(i);
    for (let i = cells.length - 1; i > 0; i--) {
      const j = (rnd() * (i + 1)) | 0;
      [cells[i], cells[j]] = [cells[j], cells[i]];
    }
    const cell = PERIOD / G;
    for (let c = 0; c < CLUSTERS; c++) {
      const gx = cells[c] % G, gz = (cells[c] / G) | 0;
      const cl = {
        // absolute world position; wind moves it, the wrap only affects drawing
        x: -FIELD + (gx + 0.5) * cell + (rnd() - 0.5) * cell * 0.84,
        z: -FIELD + (gz + 0.5) * cell + (rnd() - 0.5) * cell * 0.84,
        // Two DECKS with flat bases, not one uniform smear between two numbers.
        // A shared base is the strongest thing the eye reads about a cumulus
        // field, and drawing altitudes uniformly across a 400 m band destroys
        // exactly that.
        y: (rnd() < MID_SHARE ? BASE_MID : BASE_LOW) + (rnd() - 0.5) * 2 * BASE_JITTER,
        puffs: [],
      };
      const n = PUFFS[0] + ((rnd() * (PUFFS[1] - PUFFS[0] + 1)) | 0);
      const base = Math.ceil(n * 0.55); // majority sit on the flat cumulus base
      for (let p = 0; p < n; p++) {
        const onBase = p < base;
        const a = rnd() * Math.PI * 2;
        // base puffs spread wide and hang a little below the axis; the tower
        // puffs stack above and pull in — a cauliflower over a flat bottom
        const rr = Math.sqrt(rnd()) * SPREAD_H * (onBase ? 1 : 0.6);
        const oy = onBase ? SPREAD_V * (-0.30 + rnd() * 0.35)
          : SPREAD_V * (0.15 + rnd() * 0.85);
        const ox = Math.cos(a) * rr, oz = Math.sin(a) * rr;
        // higher puffs are smaller: the towers are the youngest parcels
        const d = (PUFF_D[0] + rnd() * (PUFF_D[1] - PUFF_D[0]))
          * (1 - 0.22 * (oy / SPREAD_V));
        // Shading normal ≠ position offset. A cumulus is far wider than it is
        // tall, so the true offsets are nearly horizontal and dot(sun, offset)
        // would grade almost nothing top-to-bottom. Stretching the normal's y
        // by 3.2 restores the reading everyone expects — bright crown, grey
        // belly — without deforming the actual volume.
        const ny = oy * 3.2;
        const nl = Math.sqrt(ox * ox + ny * ny + oz * oz) || 1;
        // one texture, 100 different-looking blobs: a fixed in-plane rotation.
        // Drawn here, in the same place in the random stream the sprite's
        // material used to draw it, so the sky is cloud for cloud the old one.
        const rot = rnd() * Math.PI * 2;
        cl.puffs.push({
          ox, oy, oz, r: d * 0.5,
          nx: ox / nl, ny: ny / nl, nz: oz / nl,   // unit shading normal
          a: 0.82 + rnd() * 0.18,                  // per-puff opacity jitter
          cr: Math.cos(rot), sr: Math.sin(rot),
        });
        this.puffCount++;
      }
      this.clusters.push(cl);
    }
    this._alloc(this.puffCount);
    // the group is added once and reused across rebuilds — setDist() swaps the
    // instance buffers inside it, not the group itself
    if (this.group.parent !== this.scene) this.scene.add(this.group);
  }

  // Instance buffers for `n` puffs, and the scratch the sort works in. Called
  // on a rebuild only; update() never allocates.
  _alloc(n) {
    this.mesh.geometry.dispose();     // let go of the old sky's buffers
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(
      [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0], 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    const dyn = (arr, size) => {
      const at = new THREE.InstancedBufferAttribute(arr, size);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this._aPos = dyn(new Float32Array(n * 4), 4);
    this._aCol = dyn(new Float32Array(n * 4), 4);
    this._aRot = dyn(new Float32Array(n * 2), 2);
    geo.setAttribute('iPos', this._aPos);
    geo.setAttribute('iCol', this._aCol);
    geo.setAttribute('iRot', this._aRot);
    geo.instanceCount = 0;
    this.mesh.geometry = geo;
    // pass one of update() parks each visible puff here, pass two reads it
    // back in sorted order: 10 floats a puff, plus its bucket
    this._tmp = new Float32Array(n * 10);
    this._key = new Uint16Array(n);
    this.drawn = 0;
  }

  // dt seconds; camera drives the recentre; sunDir/nightK come straight from
  // sky.js (sky.sunDir, sky.nightK) so the clouds are lit by the same sun that
  // lights the streets. Safe to call several times per rendered frame — the
  // integrator sub-steps the sim — since everything but the drift is recomputed
  // from scratch rather than accumulated.
  update(dt, camera, sunDir, nightK = 0) {
    if (!camera) return;
    const nk = clamp01(nightK);

    // ---- wind: absolute drift, so the wrap stays pure modular arithmetic ----
    for (const cl of this.clusters) { cl.x += WIND.x * dt; cl.z += WIND.z * dt; }

    // ---- this frame's two palette ends, computed ONCE for the whole field ----
    const sx = sunDir?.x ?? 0.40, sy = sunDir?.y ?? 0.85, sz = sunDir?.z ?? 0.35;
    // Key direction = the sun nudged upward. With the sun on the horizon a
    // pure sun vector would light the sides and leave tops and bottoms
    // identical; real clouds keep a bright crown from the whole sky bowl. The
    // vertical term is floored at 0 for the same reason: once the sun is UNDER
    // the horizon its raw −y would light the bellies and shade the crowns, an
    // inversion nothing in the sky ever does (what light is left after dark
    // still arrives from above).
    let kx = sx, ky = Math.max(sy, 0) + 0.40, kz = sz;
    const kl = Math.sqrt(kx * kx + ky * ky + kz * kz) || 1;
    kx /= kl; ky /= kl; kz /= kl;
    // golden hour: sun low but not yet under (sy = sin of elevation)
    const warm = clamp01((0.30 - sy) / 0.30) * clamp01((sy + 0.10) / 0.14);
    _lit.copy(LIT).lerp(LIT_W, warm).lerp(LIT_N, nk);
    _shade.copy(SHADE).lerp(SHADE_W, warm).lerp(SHADE_N, nk);
    const lr = _lit.r, lg = _lit.g, lb = _lit.b;
    const sr = _shade.r, sg = _shade.g, sb = _shade.b;
    const master = OPACITY * (1 - 0.18 * nk); // night thins them so the moon reads

    // ---- fade band, re-derived each frame in case camera.far ever changes ----
    const farOut = Math.min((camera.far || 1400) * FADE_FAR_K, this.range);
    const farIn = farOut * FADE_IN_K;
    const invFar = 1 / Math.max(1, farOut - farIn);

    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    // ---- pass one: fade, light and bucket every puff that is visible ----
    const tmp = this._tmp, key = this._key, bucket = this._bucket;
    bucket.fill(0);
    const toBucket = (BUCKETS - 1) / Math.max(1, farOut);
    let n = 0;
    for (const cl of this.clusters) {
      // THE RECENTRE. Stateless modular wrap into [−FIELD, +FIELD]: the cluster
      // is drawn at whichever of its infinitely many tiled copies is nearest.
      // Doing it as arithmetic rather than as an incremental "if it fell behind,
      // add a field width" means it is also correct after a teleport (respawn,
      // a save load, the helicopter crossing a tile boundary at 62 m/s) — there
      // is no accumulated state to get out of step with the camera.
      let dx = cl.x - cx, dz = cl.z - cz;
      const PERIOD = this.period;
      dx -= PERIOD * Math.round(dx / PERIOD);
      dz -= PERIOD * Math.round(dz / PERIOD);
      const dy = cl.y - cy;   // altitude never wraps: you can climb above the deck
      for (const p of cl.puffs) {
        const px = dx + p.ox, py = dy + p.oy, pz = dz + p.oz;
        const d = Math.sqrt(px * px + py * py + pz * pz);
        // far fade → 0 well inside camera.far and far inside the wrap boundary
        const fFar = 1 - smooth01((d - farIn) * invFar);
        // near fade → 0 at the puff's own centre, so flying through whitens
        // the view and thins out instead of blinking
        const fNear = smooth01(d / (p.r * FADE_NEAR_K));
        const alpha = master * p.a * fFar * fNear;
        // Below 1/255 the framebuffer cannot represent the puff at all, so
        // dropping it there saves the fill without being a visible cut:
        // this is the ONE hard threshold in the module, and it sits under the
        // hardware's own quantisation floor.
        if (alpha <= 0.004) continue;
        // sun-facing side bright, underside grey-blue — one dot product
        const k = smooth01(0.5 + 0.62 * (kx * p.nx + ky * p.ny + kz * p.nz));
        const o = n * 10;
        tmp[o] = cx + px; tmp[o + 1] = cy + py; tmp[o + 2] = cz + pz; tmp[o + 3] = p.r * 2;
        tmp[o + 4] = sr + (lr - sr) * k; tmp[o + 5] = sg + (lg - sg) * k;
        tmp[o + 6] = sb + (lb - sb) * k; tmp[o + 7] = alpha;
        tmp[o + 8] = p.cr; tmp[o + 9] = p.sr;
        // bucket 0 is the FARTHEST, so ascending bucket order is draw order
        const b = (BUCKETS - 1) - Math.min(BUCKETS - 1, (d * toBucket) | 0);
        key[n] = b;
        bucket[b + 1]++;
        n++;
      }
    }
    // ---- pass two: counting sort straight into the instance buffers ----
    for (let b = 0; b < BUCKETS; b++) bucket[b + 1] += bucket[b];
    const aPos = this._aPos.array, aCol = this._aCol.array, aRot = this._aRot.array;
    for (let i = 0; i < n; i++) {
      const at = bucket[key[i]]++;
      const o = i * 10, q = at * 4, r2 = at * 2;
      aPos[q] = tmp[o]; aPos[q + 1] = tmp[o + 1]; aPos[q + 2] = tmp[o + 2]; aPos[q + 3] = tmp[o + 3];
      aCol[q] = tmp[o + 4]; aCol[q + 1] = tmp[o + 5]; aCol[q + 2] = tmp[o + 6]; aCol[q + 3] = tmp[o + 7];
      aRot[r2] = tmp[o + 8]; aRot[r2 + 1] = tmp[o + 9];
    }
    this.drawn = n;
    this.mesh.geometry.instanceCount = n;
    this.mesh.visible = n > 0;
    // only the part in use goes to the GPU
    flush(this._aPos, n); flush(this._aCol, n); flush(this._aRot, n);
  }
}

function flush(at, n) {
  if (at.clearUpdateRanges) { at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); }
  at.needsUpdate = true;
}
