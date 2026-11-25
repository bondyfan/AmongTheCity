// ---- NavLine: the satnav line painted on the road ---------------------------------
// The route from navigation.js can be sixty kilometres long; what a driver
// needs is the next few hundred metres, in his lane, starting at his bonnet.
// So this draws a WINDOW of the route as a ribbon (js/navribbon.js does the
// geometry) and rebuilds it only when the car has eaten into it.
//
// What changed (Frank, 25 Nov 2026: "modrá, velká, tlustá čára, která si
// zobrazuje trošku i za mnou"):
//   · nothing behind the car, ever. The old line faded its near end per
//     VERTEX, and OSM puts the vertices of a straight street up to a hundred
//     metres apart, so the fade was smeared across the car and the line lit
//     the road behind it. The cut is now per PIXEL: every vertex carries its
//     arclength, the fragment shader compares it with the car's (a uniform
//     written each frame), and the line begins a metre ahead of the car's
//     centre with a short ramp. No buffer is touched between rebuilds.
//   · in the lane, out of the car. The ribbon sits on the half of the road
//     you drive on (navigation.routeOff, signed by the region's side) and its
//     head bends onto where the car actually is.
//   · thinner and quieter: 0.8 m instead of 1.8, a dark edge, a lit blue core
//     and small chevrons flowing forward, with just enough over 1.0 for the
//     bloom to give it a soft edge instead of a glare.
//   · a returning leg (a route doubling back past you) is still cut once it
//     is a different piece of road, now per pixel too.
//
// Nothing allocates after construction: buffers are cut once at their maximum
// size and rewritten in place; per frame it is a windowed nearest-point scan
// and two uniforms.

import * as THREE from 'three';
import { LAYER_Y } from './config.js';
import { laneSide } from './regions.js';
import { routeCum, trackRoute, sliceAhead, offsetAt, pointAt } from './routeahead.js';
import { buildRibbon, NAV_CUT_GLSL, BLEND_MAX } from './navribbon.js';

const HALF = 0.4;             // ribbon half width (m): a 0.8 m line in a 3 m lane
const WINDOW = 320;           // m of route turned into geometry at a time
const BEHIND = 6;             // …starting this far behind the car (the cut hides it)
const REBUILD = 30;           // m of progress before the window is rebuilt
const MAX_PTS = 256;          // ribbon spine points (2 vertices each)
const MIN_STEP = 2.5;         // m between spine points, at least…
const MAX_STEP = 5;           // …and at most: the ground under a long straight is sampled
const START = 1.0;            // m ahead of the car's centre where the line begins…
const FADE_IN = 6;            // …ramping in over this
const FADE_OUT = 50;          // m of fade at a window end that is not the destination
const BLEND = 24;             // m over which the head bends from the car onto the lane
const OFF_SMOOTH = 14;        // m either side the lane offset is averaged over
const DRIFT = 1.1;            // m the car may drift off the head before a rebuild
const DRIFT_DT = 0.25;        // …at most this often
const TILE_V = 4;             // m of route per texture repeat (one chevron)
const SCROLL = 0.5;           // repeats per second: the flow toward the destination
// Height above the road DECK. Ground height is sampled at the spine points
// only, and a crowned or rolling road rises up to ~8 cm above the straight
// chord between two samples 5 m apart (measured along a Pardubice route): at
// the old 5 cm the line dipped under the tarmac there and showed as dashes.
// 14 cm clears it, and from a chase camera it still reads as painted on.
const LIFT = LAYER_Y.marking - LAYER_Y.road + 0.11;
const FLAT_Y = LAYER_Y.marking + 0.11;                // …when there is no world to ask
const GLOW = 1.12;            // just over 1: the bloom softens the edge, no glare

// ---- the texture: edge, core, chevron, in real colours --------------------------
// u runs across the ribbon, v along it (one repeat = TILE_V m). With flipY the
// canvas top is v = 1, and forward along the route is +v, so a chevron whose
// apex is at the top points toward the destination. Built on first use so a
// headless import touches no DOM.
let _tex = null;
function lineTexture() {
  if (_tex) return _tex;
  const W = 64, H = 128;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, W, 0);
  gr.addColorStop(0.00, 'rgba(8, 36, 82, 0)');
  gr.addColorStop(0.05, 'rgba(8, 36, 82, 0.92)');
  gr.addColorStop(0.17, 'rgba(10, 46, 102, 0.95)');
  gr.addColorStop(0.22, 'rgba(40, 132, 255, 0.95)');
  gr.addColorStop(0.50, 'rgba(98, 172, 255, 0.97)');
  gr.addColorStop(0.78, 'rgba(40, 132, 255, 0.95)');
  gr.addColorStop(0.83, 'rgba(10, 46, 102, 0.95)');
  gr.addColorStop(0.95, 'rgba(8, 36, 82, 0.92)');
  gr.addColorStop(1.00, 'rgba(8, 36, 82, 0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, W, H);
  // the chevron, drawn in metres: 0.8 m across, TILE_V m along
  g.save();
  g.scale(W / (HALF * 2), H / TILE_V);
  g.lineJoin = 'round';
  g.lineCap = 'round';
  g.strokeStyle = 'rgba(235, 246, 255, 0.82)';
  g.lineWidth = 0.075;
  const mid = TILE_V / 2, cx = HALF;
  g.beginPath();
  g.moveTo(cx - 0.2, mid + 0.16);
  g.lineTo(cx, mid - 0.12);
  g.lineTo(cx + 0.2, mid + 0.16);
  g.stroke();
  g.restore();
  _tex = new THREE.CanvasTexture(c);
  _tex.wrapS = THREE.ClampToEdgeWrapping;
  _tex.wrapT = THREE.RepeatWrapping;
  _tex.colorSpace = THREE.SRGBColorSpace;
  _tex.anisotropy = 4;
  return _tex;
}

export class NavLine {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene?.add(this.group);
    this.mesh = null;                 // built on first need (see lineTexture)
    this._route = null; this._off = null; this._cum = null;
    this._st = { i: 0, s: 0, d: 0 };  // where the car is along the route
    this._builtAt = -1e9;
    this._builtT = 0;
    this._visible = true;
    this._vBase = 0; this._s1 = 0; this._fadeEnd = false; this._m = 0;
    this._sl = { x: new Float64Array(MAX_PTS), z: new Float64Array(MAX_PTS), s: new Float64Array(MAX_PTS) };
    this._offs = new Float64Array(MAX_PTS);
    this._ctr = { x: new Float64Array(MAX_PTS), z: new Float64Array(MAX_PTS) };
    this._car = { x: 0, z: 0, s: 0 };
    this._p = { x: 0, z: 0, dx: 0, dz: 0 };
    this._uA = { value: new THREE.Vector4(0, FADE_IN, 0, 0) };   // carS, fadeIn, endS, fadeOut
    this._uB = { value: new THREE.Vector4(0, 0, 0, -1) };        // car x, z, forward x, z
    this._clock = 0;
  }

  _ensureMesh() {
    if (this.mesh) return;
    const g = new THREE.BufferGeometry();
    const V = MAX_PTS * 2;
    this._pos = new Float32Array(V * 3);
    this._aS = new Float32Array(V);
    this._uv = new Float32Array(V * 2);
    const idx = new Uint16Array((MAX_PTS - 1) * 6);
    for (let k = 0; k < MAX_PTS - 1; k++) {
      const o = k * 6, a = k * 2;
      // wound so the face normal is +y (left, right, next-left / right, next-right, next-left)
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    g.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this._uv, 2));
    g.setAttribute('aS', new THREE.BufferAttribute(this._aS, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      map: lineTexture(), transparent: true,
      depthWrite: false,          // a decal: it never occludes anything…
      toneMapped: false,          // …and it reaches the bloom pass untouched
      side: THREE.DoubleSide,
      // and a nudge toward the camera, for the last centimetres of a kerb
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -8,
    });
    mat.color.setScalar(GLOW);
    const uA = this._uA, uB = this._uB;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uNavA = uA;
      sh.uniforms.uNavB = uB;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aS;\nvarying float vNavS;\nvarying vec2 vNavXZ;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvNavS = aS;\nvNavXZ = position.xz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uNavA;\nuniform vec4 uNavB;\nvarying float vNavS;\nvarying vec2 vNavXZ;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + NAV_CUT_GLSL);
    };
    mat.customProgramCacheKey = () => 'navline-cut-1';
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;   // the window follows the camera by definition
    this.mesh.renderOrder = 3;         // after the opaque city, before the sky dome
    this.group.add(this.mesh);
  }

  /**
   * Hand it navigation.route and navigation.routeOff (or null). Re-setting the
   * SAME array is free, so a caller may call this every frame.
   */
  set(route, off = null) {
    if (route === this._route) { this._off = off; return; }
    this._route = (route && route.length >= 2) ? route : null;
    this._off = off;
    this._builtAt = -1e9;
    this._st.i = 0; this._st.s = 0; this._st.d = 0;
    if (!this._route) { this.group.visible = false; this._cum = null; return; }
    this._cum = routeCum(this._route);
  }

  clear() { this.set(null); }

  setVisible(v) {
    this._visible = !!v;
    if (!v) this.group.visible = false;
  }

  update(dt, x, z, world) {
    if (!this._route || !this._visible) { this.group.visible = false; return; }
    this._clock += dt;
    const st = trackRoute(this._route, this._cum, x, z, this._st);
    const s = st.s;
    const drift = this._m > 1 ? this._headDrift(x, z, s) : 0;
    if (s - this._builtAt > REBUILD || s < this._builtAt - 2
      || (drift > DRIFT && drift < BLEND_MAX + 1 && this._clock - this._builtT > DRIFT_DT)) this._rebuild(world, x, z, s);
    if (this._m < 2) { this.group.visible = false; return; }
    // the cut rides the car every frame: two uniforms, no buffers
    pointAt(this._route, this._cum, s, this._p, st.i);
    this._uA.value.set(s - this._vBase + START, FADE_IN, this._s1 - this._vBase, this._fadeEnd ? FADE_OUT : 0);
    this._uB.value.set(this._p.x, this._p.z, this._p.dx, this._p.dz);
    // the flow: a shrinking offset carries the chevrons toward the destination
    const t = lineTexture();
    t.offset.y = (t.offset.y - dt * SCROLL) % 1;
    this.group.visible = true;
  }

  // How far the car is from the ribbon's head (its centre line at the car's
  // arclength): a lane change since the last rebuild shows up here.
  _headDrift(x, z, s) {
    const S = this._sl.s, m = this._m;
    let k = 0;
    while (k < m - 2 && S[k + 1] < s) k++;
    const L = (S[k + 1] - S[k]) || 1e-9;
    const t = Math.max(0, Math.min(1, (s - S[k]) / L));
    const cx = this._ctr.x[k] + (this._ctr.x[k + 1] - this._ctr.x[k]) * t;
    const cz = this._ctr.z[k] + (this._ctr.z[k + 1] - this._ctr.z[k]) * t;
    return Math.hypot(x - cx, z - cz);
  }

  _rebuild(world, x, z, s) {
    this._ensureMesh();
    const r = this._route, cum = this._cum, total = cum[r.length - 1];
    const s0 = Math.max(0, s - BEHIND);
    this._builtAt = s;
    this._builtT = this._clock;
    const sl = this._sl;
    const m = sliceAhead(r, cum, s0, WINDOW, sl, MAX_PTS, MIN_STEP, this._st.i, MAX_STEP);
    if (m < 2) { this._m = 0; return; }
    // The lane offset changes where one way meets the next (a two-way street
    // onto a oneway carriageway: 3 m to 0), and following that literally
    // makes the line jog sideways in a few metres. Averaged over ±OFF_SMOOTH
    // metres of route it eases across instead, the way a driver would.
    const side = laneSide(), off = this._off;
    for (let k = 0; k < m; k++) {
      if (!off) { this._offs[k] = 0; continue; }
      let sum = 0;
      for (let q = -2; q <= 2; q++) sum += offsetAt(off, cum, sl.s[k] + q * OFF_SMOOTH / 2, this._st.i);
      this._offs[k] = side * sum / 5;
    }
    // v is rebased on a whole number of texture repeats: 60 km of arclength in
    // float32 uv would wobble, and a rebased flow stays phase-continuous
    const vBase = this._vBase = Math.floor(s0 / TILE_V) * TILE_V;
    const car = this._car;
    car.x = x; car.z = z; car.s = s;
    const yAt = world && world.surfaceY ? (px, pz) => world.surfaceY(px, pz).y + LIFT : null;
    buildRibbon(sl, m, this._offs, HALF, this._pos, this._aS, vBase, yAt, FLAT_Y, car, BLEND, this._ctr);
    const uv = this._uv;
    for (let k = 0; k < m; k++) {
      const v = (sl.s[k] - vBase) / TILE_V;
      uv[k * 4] = 0; uv[k * 4 + 1] = v; uv[k * 4 + 2] = 1; uv[k * 4 + 3] = v;
    }
    this._m = m;
    this._s1 = sl.s[m - 1];
    // the far end fades only if the route goes on past the window; a route
    // that ends here ends at the destination and stops crisply
    this._fadeEnd = this._s1 < total - 0.5;
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.attributes.aS.needsUpdate = true;
    g.setDrawRange(0, (m - 1) * 6);
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.group.remove(this.mesh);
    this.mesh = null;
  }
}
