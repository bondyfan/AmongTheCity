// ---- skidmarks.js: the road remembers -------------------------------------
// "Když se dělá smyk … ať to dělá nějaké jako rýhy prostě do toho asfaltu, do
// té země." Rubber laid down by a sliding tyre, and a torn-up gouge when the
// same slide happens on dirt.
//
// Shape: ONE mesh, one preallocated indexed BufferGeometry, a ring of quads.
// Every quad is a short strip of one wheel's track — previous contact point to
// current, widened to the tyre. That is the navline.js idiom (a ribbon cut once
// at maximum size, drawn through setDrawRange, faded through a per-vertex RGBA
// attribute) rather than the pedestrians.js blood idiom (a pool of discs with a
// SHARED material), and the reason is that a shared material's opacity fades
// every decal at once — pedestrians.js hit that exact wall with corpses and had
// to sink them into the ground instead of fading them. Per-vertex alpha fades
// each strip on its own clock.
//
// Four independent tracks, not one: a car in a slide has its front wheels
// pointed somewhere quite different from its rears, and two parallel lines
// where there should be four crossing arcs is most of what makes a skid mark
// read as a skid mark.
//
// The pool cap IS the memory bound. Nothing else reclaims these — city.js
// unloads only the chunks in its own `built` map, so a decal added to the scene
// outlives the street it was painted on (which is what we want; it also means
// an unbounded emitter would leak forever).

import * as THREE from 'three';
import { SLIP_MARK } from './vehicles.js';

const QUADS = 2400;           // ring size: 4 wheels × 600 segments each
const SEG = 0.34;             // m of travel per quad — finer than this and a
                              // 90° corner still looks smooth, coarser and the
                              // arc facets visibly
const GAP = 2.2;              // m: further than this since the last point and
                              // the strip is broken rather than bridged (the
                              // car was airborne, teleported, or re-seated)
const WIDTH = 0.13;           // half-width of a tyre's contact patch. 0.19 was
                              // wider than the quads were long, so each one read
                              // as a paving slab rather than as a tyre track.
const LIFT_ROAD = 0.035;      // m above the surface on tarmac. Blood sits at
                              // 0.04 and lane paint at 0.06 over the deck, so
                              // this is inside tested territory; a 5 mm offset
                              // z-fights at 200 m with this depth range.
const LIFT_SOFT = 0.075;      // …and higher off soft ground, where grass.js
                              // plants blades at +0.05 with real height on top
                              // and would otherwise swallow the gouge
// Three minutes, not forty seconds. Measured on screen, a mark laid at the old
// life was gone before the player could turn round and look at it — and leaving
// a trace of what you just did is most of the point of leaving one at all.
const LIFE = 180;             // s at full strength…
const FADE = 45;              // …then this long fading out
// Read off the framebuffer rather than guessed: at alpha 0.62 over 0x37 asphalt
// the mark measured (73,72,76) against the road's (80,83,89) — about a tenth of
// a stop of contrast, which is to say invisible. Darker pigment AND more of it.
const A_ROAD = 0.85;          // peak alpha of rubber on tarmac
const A_SOFT = 0.80;          // …and of a gouge in soil
const C_ROAD = [0.018, 0.016, 0.020];  // near-black rubber
const C_SOFT = [0.30, 0.235, 0.155];   // turned-over earth
const SHADE_HZ = 5;           // per-vertex alpha refresh rate — see _fade()

export class SkidMarks {
  constructor(scene) {
    const g = new THREE.BufferGeometry();
    this._pos = new Float32Array(QUADS * 4 * 3);
    this._col = new Float32Array(QUADS * 4 * 4);       // RGBA; A is the fade
    const idx = new Uint32Array(QUADS * 6);            // >65535 verts: Uint32
    for (let q = 0; q < QUADS; q++) {
      const o = q * 6, v = q * 4;
      idx[o] = v; idx[o + 1] = v + 1; idx[o + 2] = v + 2;
      idx[o + 3] = v; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
    }
    g.setAttribute('position', new THREE.BufferAttribute(this._pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this._col, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    this._geo = g;
    this.mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true,
      depthWrite: false,        // a decal must never occlude anything…
      toneMapped: false,        // …and ACES would lift near-black into grey
      side: THREE.DoubleSide,   // seen from a flyover it is still a skid mark
    }));
    this.mesh.name = 'skidmarks';   // findable from the console; the scene is
                                    // full of vertex-coloured meshes and
                                    // fishing for one by vertex count picks a
                                    // building chunk about as often as this
    // The ring wanders with the player and the bound would be recomputed on
    // every emit for nothing.
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;      // over the road, under the nav line (3)
    scene.add(this.mesh);

    this._n = 0;                    // quads written, until the ring wraps
    this._head = 0;                 // next quad to overwrite
    this._born = new Float32Array(QUADS);   // age clock per quad
    this._a0 = new Float32Array(QUADS);     // …and the alpha it was laid at
    this._t = 0;                    // our own seconds, so a paused tab does
                                    // not age forty seconds of rubber at once
    this._fadeT = 0;
    // Per-wheel last contact point: x, z, y, and whether it is live at all.
    this._wx = new Float32Array(4);
    this._wz = new Float32Array(4);
    this._wy = new Float32Array(4);
    this._live = [false, false, false, false];
    // …and the two EDGE vertices the last quad ended on. Emitting each quad
    // with its own freshly-computed perpendicular looked right in a straight
    // line and fell apart in a spin: the travel direction swings several
    // degrees per quad, so consecutive quads splay and leave wedge-shaped holes
    // between them — on screen, a dotted line of slabs instead of a track.
    // Carrying the previous edge forward makes the seam exact by construction,
    // which is the same reason navline.js builds its ribbon from a shared spine.
    this._el = new Float32Array(12);   // left  edge: x,y,z per wheel
    this._er = new Float32Array(12);   // right edge: x,y,z per wheel
    this._edge = [false, false, false, false];
  }

  /**
   * Called once per frame with the player's car (or null on foot / in the air).
   * Emission is gated on DISTANCE, never on frames: stepGame sub-steps up to
   * twenty times per rendered frame after a hidden tab, and a per-frame emitter
   * would lay twenty quads on the same square metre.
   */
  update(dt, car, world) {
    this._t += dt;
    if (dt > 0) this._fade(dt);
    if (!car) { this._lift(); return; }
    // Wheels off the ground leave nothing, and a strip drawn across a landing
    // would join two points the car never travelled between.
    if ((car.air ?? 0) > 0.02) { this._lift(); return; }
    const slipF = car.slipF ?? 0, slipR = car.slipR ?? 0;
    if (slipF < SLIP_MARK && slipR < SLIP_MARK) { this._lift(); return; }

    const soft = (car.offroad ?? 0) > 0.45;
    const h = car.heading;
    const fx = -Math.sin(h), fz = -Math.cos(h);
    const rx = Math.cos(h), rz = -Math.sin(h);
    const hl = car.len * 0.34, hw = car.wid * 0.42;   // where the wheels are
    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const slip = front ? slipF : slipR;
      // Each wheel decides for itself: on the handbrake the rears are dragging
      // hard while the fronts are still gripping, and only the rears paint.
      if (slip < SLIP_MARK) { this._live[i] = false; this._edge[i] = false; continue; }
      const of = front ? hl : -hl, os = (i & 1) ? hw : -hw;
      const x = car.x + fx * of + rx * os;
      const z = car.z + fz * of + rz * os;
      if (!this._live[i]) {                 // first contact: anchor, draw nothing
        this._seed(i, x, z, car, world);
        continue;
      }
      const dx = x - this._wx[i], dz = z - this._wz[i];
      const d2 = dx * dx + dz * dz;
      if (d2 < SEG * SEG) continue;         // hasn't travelled far enough yet
      if (d2 > GAP * GAP) { this._seed(i, x, z, car, world); continue; }
      const d = Math.sqrt(d2);
      const y = this._ground(x, z, car, world, soft);
      // Strip width runs across the direction of TRAVEL, which in a slide is
      // not the direction the wheel points — that is exactly why the mark is
      // wide and smeared rather than a thin line.
      const px = (-dz / d) * WIDTH, pz = (dx / d) * WIDTH;
      const e = i * 3;
      if (!this._edge[i]) {          // first segment: square the ribbon off
        this._el[e] = this._wx[i] - px; this._el[e+1] = this._wy[i]; this._el[e+2] = this._wz[i] - pz;
        this._er[e] = this._wx[i] + px; this._er[e+1] = this._wy[i]; this._er[e+2] = this._wz[i] + pz;
        this._edge[i] = true;
      }
      // Darker the harder it is sliding, but never invisible: a light scrub
      // still leaves something, it is just not a black stripe.
      const a = (soft ? A_SOFT : A_ROAD) * (0.42 + 0.58 * Math.min(1, slip / 8));
      this._quad(e, x - px, y, z - pz, x + px, y, z + pz, a, soft);
      this._wx[i] = x; this._wz[i] = z; this._wy[i] = y;
    }
  }

  // Anchor a wheel's track without drawing anything. _edge goes false with it:
  // a seeded point has no direction of travel yet, so there is no edge to carry
  // forward, and reusing the stale one would bridge the gap the seed exists to
  // break.
  _seed(i, x, z, car, world) {
    this._wx[i] = x; this._wz[i] = z;
    this._wy[i] = this._ground(x, z, car, world, (car.offroad ?? 0) > 0.45);
    this._live[i] = true;
    this._edge[i] = false;
  }

  _lift() {
    for (let i = 0; i < 4; i++) { this._live[i] = false; this._edge[i] = false; }
  }

  // surfaceY, not terrain.heightAt: the deck of a bridge, the pad of a raised
  // junction and a levelled embankment are all real surfaces the wheels are on
  // and the ground is not. `near` matters — omit it and a mark laid under a
  // flyover snaps up onto the deck above. The returned object is a MODULE-LEVEL
  // SINGLETON inside city.js, so read .y immediately and never hold on to it.
  _ground(x, z, car, world, soft) {
    const lift = soft ? LIFT_SOFT : LIFT_ROAD;
    if (world?.surfaceY) return world.surfaceY(x, z, car.y).y + lift;
    return (world?.heightAt ? world.heightAt(x, z) : car.y) + lift;
  }

  /** One ribbon segment: the previous quad's two edge vertices (kept in
   *  _el/_er at offset e) plus the two new ones, wound round the perimeter. The
   *  new pair becomes the next segment's start, so the seam is shared rather
   *  than merely coincident and no rounding can open a gap in it. */
  _quad(e, lx, ly, lz, rx, ry, rz, a, soft) {
    const q = this._head;
    this._head = (q + 1) % QUADS;
    if (this._n < QUADS) this._n = Math.max(this._n, q + 1);
    this._born[q] = this._t;
    this._a0[q] = a;
    const p = this._pos, c = this._col, el = this._el, er = this._er;
    let o = q * 12;
    p[o] = el[e]; p[o + 1] = el[e + 1]; p[o + 2] = el[e + 2];
    p[o + 3] = er[e]; p[o + 4] = er[e + 1]; p[o + 5] = er[e + 2];
    p[o + 6] = rx; p[o + 7] = ry; p[o + 8] = rz;
    p[o + 9] = lx; p[o + 10] = ly; p[o + 11] = lz;
    el[e] = lx; el[e + 1] = ly; el[e + 2] = lz;
    er[e] = rx; er[e + 1] = ry; er[e + 2] = rz;
    const col = soft ? C_SOFT : C_ROAD;
    o = q * 16;
    for (let v = 0; v < 4; v++) {
      c[o + v * 4] = col[0]; c[o + v * 4 + 1] = col[1];
      c[o + v * 4 + 2] = col[2]; c[o + v * 4 + 3] = a;
    }
    this._geo.attributes.position.needsUpdate = true;
    this._geo.attributes.color.needsUpdate = true;
    this._geo.setDrawRange(0, this._n * 6);
  }

  // Age every live quad's alpha. Throttled to SHADE_HZ because the whole point
  // of a 42-second life is that nothing visibly changes inside one frame, and
  // re-uploading 150 kB of vertex colour sixty times a second to move an alpha
  // by 0.0004 is the kind of thing that shows up in a profile and nowhere else.
  _fade(dt) {
    this._fadeT += dt;
    if (this._fadeT < 1 / SHADE_HZ || !this._n) return;
    this._fadeT = 0;
    const c = this._col;
    let any = false;
    for (let q = 0; q < this._n; q++) {
      const age = this._t - this._born[q];
      if (age <= LIFE) continue;
      const k = age >= LIFE + FADE ? 0 : 1 - (age - LIFE) / FADE;
      const o = q * 16;
      // From the alpha it was LAID at, never from its current value: scaling
      // what is already there compounds, and recovering the birth alpha from
      // the curve loses the per-quad slip weighting, which would make a light
      // scrub visibly jump darker on its first fade tick.
      const a = this._a0[q] * k;
      if (c[o + 3] === a) continue;
      for (let v = 0; v < 4; v++) c[o + v * 4 + 3] = a;
      any = true;
    }
    if (any) this._geo.attributes.color.needsUpdate = true;
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this._geo.dispose();
    this.mesh.material.dispose();
  }
}
