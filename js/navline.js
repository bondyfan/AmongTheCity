// ---- NavLine: the GPS line painted on the road (v7) ----
// The route from navigation.js is a polyline that can be sixty kilometres
// long. Drawing all of it would be a quarter of a million triangles of ribbon
// that nobody can see past the next corner, so this module draws a WINDOW: the
// next ~400 m, rebuilt only once the car has eaten into it. A 40 km route and
// a 400 m route therefore cost exactly the same to render, and the rebuild —
// two hundred points of trigonometry — happens roughly once every two seconds
// at motorway speed.
//
// Nothing here allocates after construction. The buffers are cut once at their
// maximum size and every rebuild overwrites them in place, moving the draw
// range instead of making new geometry; the only per-frame work is one texture
// offset and a windowed nearest-point scan.
//
// It sits at LAYER_Y.marking + 0.02 — above the tarmac AND above the painted
// lane dashes, which is the whole vertical budget it gets. On a bridge the
// deck is 0.85 m up, so the height comes from `world.surfaceY()` when the
// caller passes a world: sampled per ribbon point at BUILD time, which is what
// keeps the line on the Labe bridges instead of inside them.

import * as THREE from 'three';
import { LAYER_Y } from './config.js';

const HALF = 0.9;             // ribbon half-width (m). The texture's soft rim eats
                              // the outer ~0.15 m, so the painted line reads ~1.6 m
                              // — a lane's worth, the way a real satnav overlay does
const WINDOW = 400;           // m of route turned into geometry at a time
const BEHIND = 8;             // …starting this far behind the car, so the ribbon
                              // emerges from under it rather than at its bumper
const REBUILD = 45;           // m of progress before the window is rebuilt. 400 m of
                              // window minus 45 m of drift still leaves 350 m of line
                              // ahead, which is further than the camera can see
const MAX_PTS = 224;          // ribbon spine points (2 vertices each)
const MIN_STEP = 3;           // m — OSM polylines can carry a point every 30 cm on a
                              // curve; at 3 m a 1.8 m ribbon is still perfectly smooth
const FADE_IN = 9;            // m of alpha ramp at the near end…
const FADE_OUT = 55;          // …and at the far end, so the window's cut is invisible
// The near end is measured from the CAR, not from the window, and it is
// re-shaded every frame. The geometry can only afford to move once every
// REBUILD metres, so a near-end fade baked in at build time meant the line
// stayed put while the car drove into and then past it — up to 45 m of route
// painted BEHIND the driver, which reads as "the satnav is showing me where I
// have already been". Alpha is the one thing cheap enough to move per frame
// (two floats per spine point, ~450 of them), so the line's head rides the car
// while its geometry stays still.
const SHADE_STEP = 0.4;       // m of travel before the alphas are rewritten
const TILE_V = 6;             // m of route per texture repeat
const SCROLL = 0.55;          // repeats per second — the flow toward the destination
const LIFT = LAYER_Y.marking - LAYER_Y.road + 0.02;   // above the road DECK
const FLAT_Y = LAYER_Y.marking + 0.02;                // …when there is no world to ask
const COLOR = 0x25d0ff;
const GLOW = 1.6;             // >1 on purpose: with toneMapped:false the fragment
                              // leaves the shader over linear 1.0, which is exactly
                              // what the bloom pass thresholds on

// ---- scratch: neither the update nor the rebuild path allocates ----
const _cp = { x: 0, z: 0, t: 0 };
const _tmp = { x: 0, z: 0 };
// the ribbon spine: one record per possible point, cut once and refilled
const _spine = [];
for (let i = 0; i < MAX_PTS; i++) _spine.push({ x: 0, z: 0, s: 0 });

// distance from a point to a segment, plus the parametric position along it.
// (geo.js has this, but navline is a pure-render module and the import would be
// its only reason to know about the city data layer.)
function segT(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const cx = ax + dx * t, cz = az + dz * t;
  out.t = t;
  return Math.sqrt((px - cx) * (px - cx) + (pz - cz) * (pz - cz));
}

// ONE texture for every nav line ever drawn, built on first use so that merely
// importing this module (headless tests) touches no DOM. White RGB with the
// pattern in ALPHA: the cyan comes from material.color, so the tint can change
// without repainting a pixel.
let _tex = null;
function flowTexture() {
  if (_tex) return _tex;
  const W = 32, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H;
    // one smooth pulse per repeat, biased bright: the line must read as a solid
    // painted lane first and as MOTION second — a hard dash pattern flickers at
    // speed and looks like a lane marking, which is what it must NOT be
    let p = 0.5 + 0.5 * Math.cos(2 * Math.PI * v);
    p = p * p * (3 - 2 * p);
    const flow = 0.42 + 0.58 * p;
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      // soft rim: this is the "glow", and it costs nothing because it is the
      // same texture fetch that carries the flow
      let e = Math.min(1, Math.max(0, (0.5 - Math.abs(u - 0.5)) / 0.17));
      e = e * e * (3 - 2 * e);
      const i = (y * W + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(255 * e * flow);
    }
  }
  ctx.putImageData(img, 0, 0);
  _tex = new THREE.CanvasTexture(c);
  _tex.wrapS = THREE.ClampToEdgeWrapping;
  _tex.wrapT = THREE.RepeatWrapping;          // v runs along the route, for kilometres
  _tex.colorSpace = THREE.SRGBColorSpace;
  return _tex;
}

export class NavLine {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.visible = false;
    scene?.add(this.group);

    this.mesh = null;                 // built on the first set() — see flowTexture
    this._route = null;
    this._cum = null;                 // arclength at every route point
    this._i = 0; this._s = 0;         // where the car is along the route
    this._builtAt = -1e9;             // the _s the current window was cut at
    this._visible = true;             // the caller's on/off (driving or not)
    this._bd = 0; this._bi = 0; this._bs = 0;   // _scan results, kept off the stack
    // the built window, kept so _shade can re-fade it without rebuilding
    this._sp = new Float32Array(MAX_PTS);       // arclength of every spine point
    this._m = 0; this._s1 = 0; this._fadeEnd = false;
    this._shadedAt = -1e9;
  }

  // ---- geometry, cut once at maximum size ----
  _ensureMesh() {
    if (this.mesh) return;
    const g = new THREE.BufferGeometry();
    const V = MAX_PTS * 2;
    this._pos = new Float32Array(V * 3);
    this._uv = new Float32Array(V * 2);
    this._col = new Float32Array(V * 4);        // RGBA — alpha is the fade
    const idx = new Uint16Array((MAX_PTS - 1) * 6);
    for (let k = 0; k < MAX_PTS - 1; k++) {
      const o = k * 6, a = k * 2;
      // wound so the face normal is +y: left, right, next-left / right, next-right,
      // next-left. (Left of travel is (dz,−dx) in this frame — see the offsets below.)
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    g.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(this._uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(this._col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      map: flowTexture(), vertexColors: true, transparent: true,
      depthWrite: false,          // it is a decal: it must never occlude anything…
      toneMapped: false,          // …and it must survive ACES to reach the bloom pass
      side: THREE.DoubleSide,     // a nav line seen from a helicopter underneath a
                                  // flyover is still a nav line
    });
    mat.color.setHex(COLOR).multiplyScalar(GLOW);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;   // the window follows the camera by definition;
                                       // a bounding sphere would be recomputed for
                                       // nothing on every rebuild
    this.mesh.renderOrder = 3;         // after the opaque city, before the sky dome
    this.group.add(this.mesh);
  }

  // Hand it navigation.route (or null). Re-setting the SAME array is free, so a
  // caller may call this every frame without thinking about it.
  set(route) {
    if (route === this._route) return;
    this._route = (route && route.length >= 2) ? route : null;
    this._builtAt = -1e9;
    this._shadedAt = -1e9; this._m = 0;
    this._i = 0; this._s = 0;
    if (!this._route) { this.group.visible = false; this._cum = null; return; }
    const n = this._route.length;
    const cum = this._cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const dx = this._route[i][0] - this._route[i - 1][0];
      const dz = this._route[i][1] - this._route[i - 1][1];
      cum[i] = cum[i - 1] + Math.sqrt(dx * dx + dz * dz);
    }
  }

  clear() { this.set(null); }

  // The caller's own switch — the line is hidden on foot and in the air, and
  // that is main.js's judgement, not ours.
  setVisible(v) {
    this._visible = !!v;
    if (!v) this.group.visible = false;
  }

  update(dt, x, z, world) {
    if (!this._route || !this._visible) { this.group.visible = false; return; }
    this._track(x, z);
    // rebuild when the car has eaten into the window (or on a new route, where
    // _builtAt is −∞). Driving BACKWARDS past the window start counts too.
    if (this._s - this._builtAt > REBUILD || this._s < this._builtAt) this._rebuild(world);
    // …and between rebuilds, walk the head of the line forward with the car so
    // nothing is ever painted behind it
    else if (this._m > 1 && Math.abs(this._s - this._shadedAt) > SHADE_STEP) this._shade();
    // the flow: offset DOWN, because a feature sits where uv = (T − offset), so
    // a shrinking offset carries the pattern toward the destination
    const t = flowTexture();
    t.offset.y = (t.offset.y - dt * SCROLL) % 1;
  }

  // nearest point on route segments [from, to) — into fields, not an object
  _scan(x, z, from, to) {
    const r = this._route, cum = this._cum;
    for (let i = from; i < to; i++) {
      const a = r[i], b = r[i + 1];
      const d = segT(x, z, a[0], a[1], b[0], b[1], _cp);
      if (d >= this._bd) continue;
      this._bd = d; this._bi = i; this._bs = cum[i] + _cp.t * (cum[i + 1] - cum[i]);
    }
  }

  // Where along the route is the car? A window around the last answer covers a
  // driver following the line; anything wilder (a re-route arriving, a teleport,
  // a lap of a roundabout) falls back to the whole polyline, which is a few
  // thousand segments once and then never again.
  _track(x, z) {
    const n = this._route.length;
    this._bd = Infinity; this._bi = 0; this._bs = 0;
    this._scan(x, z, Math.max(0, this._i - 6), Math.min(n - 1, this._i + 80));
    if (this._bd > 40) { this._bd = Infinity; this._scan(x, z, 0, n - 1); }
    this._i = this._bi; this._s = this._bs;
  }

  // Cut the next WINDOW metres of route into ribbon. Everything is written into
  // the pre-cut buffers; only the draw range and the `needsUpdate` flags change.
  _rebuild(world) {
    this._ensureMesh();
    const r = this._route, cum = this._cum, n = r.length;
    const total = cum[n - 1];
    const s0 = Math.max(0, this._s - BEHIND);
    const s1 = Math.min(total, s0 + WINDOW);
    this._builtAt = this._s;
    if (s1 - s0 < 0.5) { this._m = 0; this.group.visible = false; return; }
    // …the far end only fades if the route CONTINUES past the window; a route
    // that ends here ends at the destination and should stop crisply
    const fadeEnd = s1 < total - 0.5;
    // v is measured from a WHOLE number of texture repeats before the window, not
    // from the route's origin: 60 km of arclength is 10 000 repeats, where float32
    // uv has visibly less precision than the pattern, and rebasing on a repeat
    // boundary keeps the flow phase-continuous across a rebuild
    const vBase = Math.floor(s0 / TILE_V) * TILE_V;

    // --- spine: interpolated start, the route's own points, interpolated end ---
    const P = _spine;
    let m = 0;
    let i = this._i;
    while (i > 0 && cum[i] > s0) i--;
    while (i < n - 2 && cum[i + 1] < s0) i++;
    const put = (px, pz, s) => {
      if (m >= MAX_PTS) return;
      // drop points the ribbon cannot resolve, but never the last one
      if (m > 0 && s - P[m - 1].s < MIN_STEP) return;
      const p = P[m++];
      p.x = px; p.z = pz; p.s = s;
    };
    const at = (s, out) => {                       // point at arclength s
      let k = i;
      while (k < n - 2 && cum[k + 1] < s) k++;
      const L = (cum[k + 1] - cum[k]) || 1e-6, t = (s - cum[k]) / L;
      out.x = r[k][0] + (r[k + 1][0] - r[k][0]) * t;
      out.z = r[k][1] + (r[k + 1][1] - r[k][1]) * t;
    };
    at(s0, _tmp);
    put(_tmp.x, _tmp.z, s0);
    for (let k = i + 1; k < n && cum[k] < s1; k++) put(r[k][0], r[k][1], cum[k]);
    at(s1, _tmp);
    // the end point is mandatory: overwrite the last spine point if it crowds it
    if (m >= MAX_PTS || (m > 1 && s1 - P[m - 1].s < MIN_STEP)) m--;
    const last = P[m++];
    last.x = _tmp.x; last.z = _tmp.z; last.s = s1;
    if (m < 2) { this._m = 0; this.group.visible = false; return; }

    // --- ribbon: two vertices per spine point, mitred at the corners ---
    const pos = this._pos, uv = this._uv, sp = this._sp;
    for (let k = 0; k < m; k++) {
      const p = P[k];
      // tangents either side of the point; the ends have only one
      let ix = 0, iz = 0, ox = 0, oz = 0;
      if (k > 0) {
        ix = p.x - P[k - 1].x; iz = p.z - P[k - 1].z;
        const L = Math.hypot(ix, iz) || 1; ix /= L; iz /= L;
      }
      if (k < m - 1) {
        ox = P[k + 1].x - p.x; oz = P[k + 1].z - p.z;
        const L = Math.hypot(ox, oz) || 1; ox /= L; oz /= L;
      }
      if (k === 0) { ix = ox; iz = oz; }
      if (k === m - 1) { ox = ix; oz = iz; }
      // left of travel is (dz, −dx); the bisector of the two lefts is the mitre
      let nx = iz + oz, nz = -(ix + ox);
      const L = Math.hypot(nx, nz) || 1;
      nx /= L; nz /= L;
      // widen the mitre by 1/cos(θ/2) so the ribbon keeps its width through a
      // corner, but never past 2.4× — a hairpin would otherwise fire a spike
      const cos = nx * iz + nz * -ix;
      const w = HALF / Math.max(0.42, Math.abs(cos));
      const y = (world && world.surfaceY) ? world.surfaceY(p.x, p.z).y + LIFT : FLAT_Y;
      const v3 = k * 6, v2 = k * 4;
      pos[v3] = p.x + nx * w; pos[v3 + 1] = y; pos[v3 + 2] = p.z + nz * w;
      pos[v3 + 3] = p.x - nx * w; pos[v3 + 4] = y; pos[v3 + 5] = p.z - nz * w;
      const v = (p.s - vBase) / TILE_V;
      uv[v2] = 0; uv[v2 + 1] = v; uv[v2 + 2] = 1; uv[v2 + 3] = v;
      sp[k] = p.s;
    }
    this._m = m; this._s1 = s1; this._fadeEnd = fadeEnd;
    const g = this.mesh.geometry;
    g.attributes.position.needsUpdate = true;
    g.attributes.uv.needsUpdate = true;
    g.setDrawRange(0, (m - 1) * 6);
    this._shade();
    this.group.visible = true;
  }

  // Alpha only, for the window that is already built. The near end is cut at
  // the CAR's own arclength — everything behind it goes to zero and the first
  // FADE_IN metres ahead ramp in, so the line grows out from under the bumper
  // and never trails behind. The far end still dissolves into the window's cut
  // the way it always did, and both are the same smoothstep.
  _shade() {
    if (!this.mesh || this._m < 2) return;
    const col = this._col, sp = this._sp, m = this._m;
    const sCar = this._s, s1 = this._s1, fadeEnd = this._fadeEnd;
    for (let k = 0; k < m; k++) {
      let a = (sp[k] - sCar) / FADE_IN;
      if (fadeEnd) a = Math.min(a, (s1 - sp[k]) / FADE_OUT);
      a = Math.max(0, Math.min(1, a));
      a = a * a * (3 - 2 * a);
      const v4 = k * 8;
      col[v4] = 1; col[v4 + 1] = 1; col[v4 + 2] = 1; col[v4 + 3] = a;
      col[v4 + 4] = 1; col[v4 + 5] = 1; col[v4 + 6] = 1; col[v4 + 7] = a;
    }
    this._shadedAt = sCar;
    this.mesh.geometry.attributes.color.needsUpdate = true;
  }

  dispose() {
    if (!this.mesh) return;
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.group.remove(this.mesh);
    this.mesh = null;
  }
}
