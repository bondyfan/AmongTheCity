// ---- grass you can stand in ----------------------------------------------
// A texture of grass is convincing until you stand on it, at which point it is
// a green floor. What makes a lawn read as a lawn is thickness: blades catching
// the light at different angles, a soft edge against the kerb, and movement.
//
// TWO LAYERS, because one cannot be both. Real grass is overwhelmingly made of
// short blades — a lawn is a carpet, not a field of clumps — but a carpet fine
// enough to look right underfoot cannot be afforded out to the horizon. So:
//
//   TURF   5 blades at 45 % of the mask's height, one every 24 cm, out to 22 m.
//   TUFTS  7 blades at full height,               one every 55 cm, out to 52 m.
//
// The turf's blades SPLAY (lean 0.34 against the tufts' own): a wider tuft
// covers more ground per instance than a denser grid of narrow ones does, and
// instances are the thing that costs.
//
// Near the camera both are present and the turf fills the gaps between the
// clumps; past 22 m the turf is under a pixel anyway and only the tufts remain.
//
// WHERE IT GROWS is not asked per blade any more. grassmask.js rasterises each
// chunk once into a byte of grass height per square metre, so the inner loop
// here is an array lookup. That is what makes the density above affordable, and
// it is also what fixed the stutter: the old version asked every candidate
// about every road, car park, building and green polygon in its chunk —
// thousands of candidates, hundreds of tests each, inside one frame.
//
// AND NOTHING HAPPENS IN ONE FRAME any more. A rebuild fills a scratch buffer
// over as many frames as its budget needs and is swapped in whole, so the ring
// on screen is never the one being written.
//
// SCATTER is world-anchored and deterministic: a tuft's position, height, tint
// and lean all come from a hash of its grid cell, so every player sees the same
// grass in the same places and it does not crawl when the ring is rebuilt.

import * as THREE from '../libs/three.module.js';
import { LAYER_Y } from './config.js';
import { GrassMask } from './grassmask.js';

// ---- and it GROWS IN, it does not arrive ---------------------------------
// The ring is one buffer swapped whole, so everything it gained since the last
// build appeared in a single frame — a band of grass switching on at the far
// edge every REBUILD_AT metres, which at 100 km/h is twice a second: "ta tráva
// se načítá jako po částech". Three things fix that together.
//
//   1. The blade's SIZE is a function of how far it is from the eye, evaluated
//      per frame in the vertex shader (`fade0` → `fade1`). Nothing is ever
//      switched on: a blade rises out of the ground as you approach it.
//   2. The ring is built WIDER than the fade reaches, so a blade only ever
//      enters the buffer while it is still scaled to nothing. `radius − fade1`
//      is that margin, and it has to cover how far the eye can drift from the
//      ring's centre before the next swap lands.
//   3. …which is why the centre LEADS the eye. A fill takes a few hundred ms,
//      and at speed the old code finished building a ring the player had
//      already driven a dozen metres past — half the margin was spent before
//      the ring was even on screen. The centre is now placed where the eye
//      will be, not where it was.
// …and NOTHING here may allocate per rebuild. The scratch buffers are sized
// from the layer's own geometry, which never changes, so they are built once
// and refilled forever. Allocating them per ring cost 9.4 MB a time, and at
// 100 km/h with the rebuild interval below that is ~30 MB/s of garbage — the
// major collections that followed are the one-to-two-second freezes with the
// engine note stuck on one tone.
const REBUILD_AT = 12;      // m of travel before the ring is rebuilt
const BUDGET_MS = 1.2;      // per frame, shared by the mask and the fill
const LEAD_T = 0.55;        // s of travel the ring centre is placed ahead
const LEAD_MAX = 16;        // …never more than this, or a jet flings it away

// The gradient up a single blade: dark at the root where no light reaches,
// lighter and warmer at the tip. Most of what makes a tuft read as round.
const ROOT = new THREE.Color(0x2f4a25);
const TIP = new THREE.Color(0x86ab55);

// `hMul` scales the height the MASK gives, which is the real height of the
// grass there. Two layers of the same grass, not two kinds of it.
// `radius` is how wide the ring is BUILT; `fade0`/`fade1` where the blades
// grow and vanish. The gap between fade1 and radius is the drift margin from
// the note above — a blade is only ever added to the buffer beyond fade1,
// where its scale is zero and nobody can see it arrive.
// DOUBLE the reach — turf to 30 m, tufts to 78 — which costs radius SQUARED
// in instances, so both layers pay for it with spacing. That is the right
// trade at distance: a blade 60 m away is under a pixel wide, and what reads
// as "grass out there" is coverage, not density. Net ~2× the instances for
// 2× the range, and the fill stays well inside its budget (measured below).
const LAYERS = [
  // turf is the filler BETWEEN the tufts, and the near ground is where its
  // density actually shows — so it thins out more gently than the tufts do.
  { name: 'turf', blades: 5, radius: 44, spacing: 0.42, hMul: 0.45, width: 0.014, lean: 0.36,
    fade0: 20, fade1: 30 },
  { name: 'tuft', blades: 7, radius: 128, spacing: 1.06, hMul: 1.00, width: 0.026, lean: 0.36,
    fade0: 88, fade1: 110 },
];

/** One tuft at the origin, one unit tall: tapered strips, splayed and twisted. */
function tuftGeometry(blades, halfWidth, lean) {
  const pos = [], col = [], hgt = [];
  const c = new THREE.Color();
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.73;
    const L = lean * (0.55 + (b % 3) * 0.3);
    const dx = Math.cos(a), dz = Math.sin(a);
    const rx = -dz * halfWidth, rz = dx * halfWidth;
    const mx = dx * L * 0.45, mz = dz * L * 0.45;
    const tx = dx * L, tz = dz * L;
    // root quad → tip triangle, so a blade tapers to a point in two triangles
    const P = [
      [-rx, 0, -rz], [rx, 0, rz], [mx + rx * 0.45, 0.55, mz + rz * 0.45],
      [-rx, 0, -rz], [mx + rx * 0.45, 0.55, mz + rz * 0.45], [mx - rx * 0.45, 0.55, mz - rz * 0.45],
      [mx - rx * 0.45, 0.55, mz - rz * 0.45], [mx + rx * 0.45, 0.55, mz + rz * 0.45], [tx, 1, tz],
    ];
    for (const [x, y, z] of P) {
      pos.push(x, y, z);
      hgt.push(y);
      c.copy(ROOT).lerp(TIP, y * y);
      col.push(c.r, c.g, c.b);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // How far up the blade a vertex is — the wind bends by the square of it, so
  // the root stays put and the tip does the moving, which is what a blade does.
  g.setAttribute('up01', new THREE.Float32BufferAttribute(hgt, 1));
  g.computeVertexNormals();
  return g;
}

function grassMaterial(fade0, fade1) {
  const mat = new THREE.MeshLambertMaterial({
    vertexColors: true,
    side: THREE.DoubleSide,   // a blade is one-sided geometry seen from anywhere
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uEye = { value: new THREE.Vector2() };
    shader.uniforms.uFade = { value: new THREE.Vector2(fade0, fade1) };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec2 uEye;
        uniform vec2 uFade;
        attribute float up01;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // Two waves crossing at an angle, so the field ripples rather than
          // swaying as one — the give-away of instanced grass is every tuft
          // leaning the same way at the same moment. The offset is in LOCAL
          // space, so the instance scales it: a 5 cm blade of turf cannot sway
          // as far as a 60 cm tuft, which is the whole point of writing it here
          // rather than in world units.
          vec3 wp = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float k = up01 * up01;
          float a = sin(uTime * 1.7 + wp.x * 0.21 + wp.z * 0.13);
          float b = sin(uTime * 1.1 + wp.x * 0.07 - wp.z * 0.19);
          transformed.x += k * (a * 0.17 + b * 0.09);
          transformed.z += k * (b * 0.17 - a * 0.07);
          // …and the blade GROWS OUT OF THE GROUND with distance. The scale is
          // about the local origin, which is the root, so a far blade is not a
          // faded ghost lying on the grass — it is a shorter blade, exactly
          // what a blade looks like before it has grown. At zero the triangle
          // is degenerate and never reaches the rasteriser, which is what pays
          // for building the ring wider than it draws.
          transformed *= 1.0 - smoothstep(uFade.x, uFade.y, distance(wp.xz, uEye));
        }`);
  };
  return mat;
}

/** Deterministic 0..1 from a grid cell — the same blade for every player. */
function rnd(i, j, salt) {
  let h = (i * 374761393 + j * 668265263 + salt * 1442695041) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const UP = new THREE.Vector3(0, 1, 0);

export class Grass {
  constructor(scene, world, city) {
    this.scene = scene;
    this.world = world;
    this.mask = new GrassMask(city, world?.ground ?? null);
    this.enabled = true;
    this._at = null;                // where the ring on screen was built
    this._needRefill = false;       // a fill hit ground the mask did not have yet
    // one material per layer: they fade over different distances, and the
    // fade lives in the shader
    this.layers = LAYERS.map((L) => {
      // The worst case is the whole disc surviving the mask, and it is a
      // constant — so the scratch is allocated ONCE here and refilled for the
      // life of the session, and the InstancedMesh is sized to the same
      // number so it never has to be disposed and rebuilt either.
      const cap = Math.ceil((Math.PI * L.radius * L.radius) / (L.spacing * L.spacing)) + 64;
      return {
        ...L,
        geo: tuftGeometry(L.blades, L.width, L.lean),
        mat: grassMaterial(L.fade0, L.fade1),
        mesh: null,
        cap,
        mats: new Float32Array(cap * 16),
        cols: new Float32Array(cap * 3),
        pending: null,
      };
    });
    this._eye = new THREE.Vector2();
    this._px = null; this._pz = null;   // last eye position, for the velocity
    this._vx = 0; this._vz = 0;         // …eased, so a hitch cannot fling the ring
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();
    this._c = new THREE.Color();
  }

  setEnabled(on) {
    this.enabled = !!on;
    for (const L of this.layers) if (!on) { this._drop(L); L.pending = null; }
    this._at = null;                // either way, the next update starts fresh
  }

  /**
   * A region tile landing changes what the ground under us is made of — but
   * only inside that tile. Passing the tile through means a wood arriving
   * 4 km away no longer blanks the lawn you are standing on.
   */
  invalidate(t) { this.mask.clearTile(t?.tx, t?.tz, this.world?.terrain?.tile ?? this._tile); this._at = null; }

  _drop(L) {
    if (!L.mesh) return;
    this.scene.remove(L.mesh);
    L.mesh.dispose?.();
    L.mesh = null;   // …but NOT L.cap: it is the layer's fixed size, and the
  }                  // scratch buffers are cut to it for the whole session

  /** Called every frame with the eye's ground position. */
  update(x, z, dt) {
    if (!this.enabled) return;
    // Where the eye is NOW — the fade is measured from here every frame, which
    // is the whole reason nothing pops any more.
    this._eye.set(x, z);
    for (const L of this.layers) {
      const sh = L.mat.userData.shader;
      if (!sh) continue;
      sh.uniforms.uTime.value += dt;
      sh.uniforms.uEye.value.copy(this._eye);
    }
    // Velocity, eased. A build hitch or a teleport must not throw the ring
    // centre across the map, so the step is clamped and the ease is slow
    // enough that only sustained travel moves it.
    if (dt > 0 && this._px !== null) {
      const k = Math.min(1, dt * 1.5);
      this._vx += ((x - this._px) / dt - this._vx) * k;
      this._vz += ((z - this._pz) / dt - this._vz) * k;
    }
    this._px = x; this._pz = z;

    // The mask shares the budget: it is the input to the fill, so a frame that
    // spends the lot on rasterising is a frame the fill had nothing to do in.
    this.mask.step(BUDGET_MS);
    // A fill that ran over ground the mask had not rasterised yet published a
    // ring with 120 m square holes in it. It used to ask for a redo by setting
    // `_at = null` — and the fill completing in the SAME update then wrote
    // `_at` straight back, cancelling it, so the holes survived until the
    // player had driven another whole REBUILD_AT and then snapped in as
    // blocks. The request is a flag of its own now, and it is honoured once
    // the mask has nothing left queued — which is also what stops it from
    // spinning: each retry can only be triggered by a queue that has drained.
    if (this._needRefill && !this.mask.queue.length) {
      this._needRefill = false;
      this._at = null;
    }

    const far = !this._at
      || (x - this._at[0]) ** 2 + (z - this._at[1]) ** 2 >= REBUILD_AT * REBUILD_AT;
    if (far && !this.layers.some((L) => L.pending)) this._start(x, z);
    this._fill(BUDGET_MS);
  }

  _start(ex, ez) {
    // Lead the eye: the fill below runs over the next few hundred ms, and a
    // ring centred on where the player WAS is a ring he has already driven a
    // dozen metres into by the time it lands. Standing still this is zero.
    const v = Math.hypot(this._vx, this._vz);
    const lead = Math.min(LEAD_MAX, v * LEAD_T);
    const cx = ex + (v > 0.01 ? this._vx / v : 0) * lead;
    const cz = ez + (v > 0.01 ? this._vz / v : 0) * lead;
    for (const L of this.layers) {
      const step = L.spacing;
      L.pending = {
        cx, cz, ex, ez,
        i0: Math.floor((cx - L.radius) / step), i1: Math.ceil((cx + L.radius) / step),
        j0: Math.floor((cz - L.radius) / step), j1: Math.ceil((cz + L.radius) / step),
        j: Math.floor((cz - L.radius) / step),
        n: 0, cap: L.cap,
        // the layer's own scratch, not a fresh pair — see the note at the top
        mats: L.mats, cols: L.cols,
      };
    }
    // Ask the mask for every chunk the widest ring touches, before it is needed
    // — heightAt queues what it does not have.
    const R = Math.max(...this.layers.map((L) => L.radius));
    for (let dz = -R; dz <= R + 60; dz += 60) {
      for (let dx = -R; dx <= R + 60; dx += 60) this.mask.heightAt(cx + dx, cz + dz);
    }
  }

  _fill(budgetMs) {
    const t0 = performance.now();
    for (const L of this.layers) {
      const P = L.pending;
      if (!P) continue;
      while (P.j <= P.j1) {
        this._row(L, P);
        P.j++;
        if (performance.now() - t0 >= budgetMs) return;
      }
      this._swap(L, P);
      L.pending = null;
      // The trigger below measures from where the EYE was when this ring was
      // started, never from the ring's centre — the centre leads the eye by up
      // to LEAD_MAX, and comparing against that would trip the rebuild on the
      // very next frame, forever.
      this._at = [P.ex, P.ez];
      if (P.missed) this._needRefill = true;   // …and come back once the mask has caught up
    }
  }

  _row(L, P) {
    const terrain = this.world?.terrain;
    if (!terrain) return;
    const step = L.spacing, j = P.j;
    const R2 = L.radius * L.radius;
    for (let i = P.i0; i <= P.i1; i++) {
      const x = (i + rnd(i, j, 1)) * step;
      const z = (j + rnd(i, j, 2)) * step;
      const d2 = (x - P.cx) ** 2 + (z - P.cz) ** 2;
      if (d2 > R2) continue;
      const cm = this.mask.heightAt(x, z);
      if (cm < 0) { P.missed = true; continue; }        // mask not rasterised yet
      if (cm === 0) continue;                           // tarmac, roof, water
      if (P.n >= P.cap) return;
      // NO thinning towards the rim any more. It used to hide the hard edge of
      // the disc, but it was keyed to the ring's own centre — so the same
      // blade was kept by one build and dropped by the next, and blinked in
      // and out at mid-radius as the rings marched past. The shader's distance
      // fade does the job from the EYE, where it belongs, and it is continuous.

      // The mask's byte IS the height in centimetres — a verge, a lawn and a
      // meadow differ by how tall they are, which is the whole of the
      // difference. The layer only says what fraction of it it draws.
      const h = (cm / 100) * L.hMul * (0.72 + 0.56 * rnd(i, j, 4));
      const y = terrain.heightAt(x, z) + LAYER_Y.green;
      this._q.setFromAxisAngle(UP, rnd(i, j, 5) * Math.PI * 2);
      this._p.set(x, y, z);
      const w = 0.85 + 0.45 * rnd(i, j, 6);
      this._s.set(w, h, w);
      this._m.compose(this._p, this._q, this._s);
      this._m.toArray(P.mats, P.n * 16);

      // Tint. A lawn is not one green, and per-blade noise alone does not fix
      // that — it averages back to one green at any distance. So the dryness is
      // drawn from a SEVEN-METRE patch as well as from the blade, and it is the
      // patches that make a field look like a field.
      const patch = rnd(Math.floor(x / 7), Math.floor(z / 7), 8);
      const dry = 0.3 * rnd(i, j, 9) + 0.7 * patch;
      const dark = 0.8 + 0.36 * rnd(i, j, 10);
      this._c.setRGB(
        dark * (0.84 + 0.42 * dry),
        dark * (1.02 - 0.10 * dry),
        dark * (0.92 - 0.40 * dry),
      );
      P.cols[P.n * 3] = this._c.r;
      P.cols[P.n * 3 + 1] = this._c.g;
      P.cols[P.n * 3 + 2] = this._c.b;
      P.n++;
    }
  }

  /** Publish a finished scratch buffer — the one visible change, all at once. */
  _swap(L, P) {
    // Built at the layer's FIXED cap, once. It used to be sized to whatever
    // the build that created it happened to produce, so the next slightly
    // fuller ring disposed the mesh and reallocated both GPU buffers — every
    // few seconds while driving, on top of the scratch churn.
    if (!L.mesh) {
      L.mesh = new THREE.InstancedMesh(L.geo, L.mat, L.cap);
      L.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(L.cap * 3), 3);
      L.mesh.frustumCulled = false;      // the ring is around the camera anyway
      L.mesh.castShadow = false;
      L.mesh.receiveShadow = false;
      this.scene.add(L.mesh);
    }
    L.mesh.instanceMatrix.array.set(P.mats.subarray(0, P.n * 16));
    L.mesh.instanceColor.array.set(P.cols.subarray(0, P.n * 3));
    L.mesh.count = P.n;
    L.mesh.instanceMatrix.needsUpdate = true;
    L.mesh.instanceColor.needsUpdate = true;
  }
}
