// ---- destructible.js: buildings that come apart, Teardown-style ----
// A BuildingModel owns one building's pieces (pieces.js) and everything that
// can happen to them: drawing, being walked on, being hit, and falling down.
//
// Three decisions make this cheap enough to run inside a city that is already
// streaming ortofoto tiles and 120 AI cars:
//
//  1. ONE InstancedMesh per building (plus one for glass). A 4-storey block of
//     flats is ~900 boxes in a single draw call. After a hit we rewrite the
//     instance buffers for the survivors and drop `count` — no geometry is
//     rebuilt, nothing is re-triangulated, and the cost is a memcpy.
//
//  2. STRUCTURE IS A GRID, NOT A SIMULATION. The building is quantised into
//     ~1.6 m cells; a flood fill up from the cells at street level answers
//     "what is still standing", and every piece the fill did not reach falls.
//     That is the entire structural model, it costs single-digit milliseconds
//     on a 12 000-piece tower, and it produces the effect everybody actually
//     wants: shoot the corner out and the corner above it shears off and rains
//     down. (The first version compared every pair of pieces that might touch
//     and cost 150 ms on that same tower — see _support.)
//
//  3. GLASS AND FURNITURE ARE CARGO. Anything `weak` shatters at 1.45× the
//     blast radius and can never hold a floor up — it is carried by structure,
//     never part of it. Without that rule a sofa keeps a bedroom airborne.
//
// The collision side is deliberately here rather than in city.js: the pieces
// and their spatial hash live in this object, so `supportY` (what am I standing
// on) and `pushOut` (what am I bumping into) are lookups, not queries across a
// module boundary. That is also what makes a blown-out wall walkable for free —
// the hole is not special-cased anywhere, the panels that were there are gone.

import * as THREE from 'three';
import { DESTRUCTION, INTERIOR } from './config.js';
import { interiorPieces, shellPieces } from './pieces.js';
import { sfxAt } from './audio.js';   // safe headless — no-ops without an AudioContext

// One material for every model's roof: the geometry carries its own colours, so
// the only thing that varies between buildings is already in the vertices.
let _roofMat = null;
function roofMaterial() {
  return (_roofMat ??= new THREE.MeshLambertMaterial({ vertexColors: true }));
}

const D = DESTRUCTION;
const CELL = 4;                                  // spatial-hash cell, meters
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- shared geometry -----------------------------------------------------
// A unit cube carrying a baked vertical gradient in its `color` attribute.
// Two jobs at once: it gives every box a free ambient-occlusion fall-off (top
// faces bright, undersides dark, which is most of why a wall of identical
// panels does not read as a texture atlas), and it defines USE_COLOR — which
// three r160 requires in the FRAGMENT stage before instanceColor is allowed to
// touch the diffuse term. Instance colours without it are silently ignored.
let _unit = null;
function unitBox() {
  if (_unit) return _unit;
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const p = g.attributes.position, n = p.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const t = p.getY(i) + 0.5;                   // 0 at the base, 1 at the top
    const k = 0.74 + 0.26 * t;
    col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return (_unit = g);
}

// The FACADE material for box pieces. Same atlas the flat facade uses, but each
// instance samples its own sub-rectangle of it, handed in as a per-instance
// vec4. Only the box's two LARGE faces (local ±z, the wall's outward and inward
// faces) get the atlas; the four thin edges are the cut section of a broken
// wall and stay plain plaster, which is exactly what you want to see in a hole.
//
// This is the piece of machinery that answers "the building looks different
// after I shoot it": with it, the boxes are painted from the same atlas cells
// the facade was, so the swap is a change of REPRESENTATION, not of appearance.
let _shellMat = null;
function shellMat(atlas, pinU, pinV) {
  if (_shellMat) return _shellMat;
  const m = new THREE.MeshLambertMaterial({ vertexColors: true, map: atlas });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 aUvRect;')
      .replace('#include <uv_vertex>', `
        vec2 _fuv = vec2(${pinU.toFixed(6)}, ${pinV.toFixed(6)});
        if (abs(normal.z) > 0.5) _fuv = aUvRect.xy + uv * (aUvRect.zw - aUvRect.xy);
        vMapUv = _fuv;
      `);
  };
  m.customProgramCacheKey = () => 'atc-shell';
  return (_shellMat = m);
}

// Backlit plastic: brand signage is unlit and untone-mapped, so a Kaufland red
// stays Kaufland red at dusk and under a shadow, and the bloom pass picks it up
// the way it picks up the street lamps.
let _signMat = null;
function signMat() {
  return (_signMat ??= new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
}

// ---- wordmark signage ----------------------------------------------------
// A flat-colour fascia says "supermarket"; only LETTERS say "KAUFLAND". Sign
// pieces may arrive stamped with signText/signBg/signFg (pieces.js decides
// which), and every distinct (text|bg|fg) triple gets one cached canvas — a
// 4:1 board with the wordmark set in a bold geometric sans, the way Czech
// retail fascias actually are — shared by every instance in the city that
// wears it. MeshBasicMaterial + toneMapped:false keeps it the same brightness
// at noon and at midnight: backlit plastic does not take the sun.
const _wordmarks = new Map();          // "text|bg|fg" → MeshBasicMaterial
function wordmarkMat(text, bg = 0xffffff, fg = 0x1c1c1c) {
  const key = text + '|' + bg + '|' + fg;
  let mat = _wordmarks.get(key);
  if (mat) return mat;
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 256;
  const g = cv.getContext('2d');
  // Under GPU/canvas memory pressure Chrome hands back a null context, and a
  // texture built from an unpainted canvas uploads as a solid BLACK board —
  // the floating black squares. Plain sign colour is the honest fallback.
  if (!g) {
    mat = new THREE.MeshBasicMaterial({ color: typeof bg === 'string' ? bg : bg & 0xffffff,
      toneMapped: false });
    _wordmarks.set(key, mat);
    return mat;
  }
  const css = (hex) => typeof hex === 'string'    // defensive: the stamping agent
    ? hex : '#' + (hex & 0xffffff).toString(16).padStart(6, '0');  // may hand either
  g.fillStyle = css(bg);
  g.fillRect(0, 0, 1024, 256);
  // a slightly darker frame reads as the sign's aluminium return from an angle
  _c.set(css(bg)).multiplyScalar(0.68);
  g.strokeStyle = _c.getStyle();
  g.lineWidth = 8;
  g.strokeRect(4, 4, 1016, 248);
  const word = String(text).toUpperCase();
  g.fillStyle = css(fg);
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const font = (px) =>
    `bold ${px}px 'Futura','Century Gothic','Avenir Next','Trebuchet MS',sans-serif`;
  let size = 168;
  g.font = font(size);
  const w = g.measureText(word).width;
  if (w > 920) { size = Math.max(40, Math.floor(size * 920 / w)); g.font = font(size); }
  g.fillText(word, 512, 136);
  // The 2×2 px corner is the swatch every NON-display face samples (the box's
  // thin edges must be plain sign colour, not a sliver of lettering) — painted
  // last so the border stroke cannot bleed into it.
  g.fillStyle = css(bg);
  g.fillRect(0, 0, 2, 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  mat = new THREE.MeshBasicMaterial({ map: tex, toneMapped: false });
  _wordmarks.set(key, mat);
  return mat;
}

// The box the wordmark instances draw with: the two LARGE faces (local ±z, the
// board's front and back) map the full 0..1 canvas, every other face pins to
// the bg-colour corner swatch. Face selection goes by the baked normals rather
// than vertex order, so a three version reshuffling BoxGeometry cannot break it.
let _wordBox = null;
function wordBox() {
  if (_wordBox) return _wordBox;
  const g = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const nrm = g.attributes.normal, uv = g.attributes.uv;
  const cu = 1 / 1024, cvv = 1 - 1 / 256;      // centre of the 2×2 corner px
  for (let i = 0; i < nrm.count; i++)
    if (Math.abs(nrm.getZ(i)) < 0.5) uv.setXY(i, cu, cvv);
  return (_wordBox = g);
}

let _solidMat = null, _glassMat = null;
function mats() {
  if (!_solidMat) {
    // A room has no light in it. The scene carries a sun and a hemisphere, and
    // a ceiling blocks both, so an honest Lambert interior renders very nearly
    // black — correct, and unplayable. This low emissive is the bounce light a
    // real room gets off its own walls: it lifts an unlit interior to roughly
    // 12 % grey and is invisible on the sunlit outside of the same boxes.
    _solidMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x24262b });
    _glassMat = new THREE.MeshLambertMaterial({
      vertexColors: true, transparent: true, opacity: 0.42,
      depthWrite: false, side: THREE.DoubleSide,
    });
  }
  return [_solidMat, _glassMat];
}

// scratch — none of the hot paths may allocate
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion();
const _v = new THREE.Vector3(), _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _c = new THREE.Color();

// world AABB half-extents of a yaw-rotated box — cached on the piece, used by
// the hash, the support graph, collision and the blast test alike
function stampBounds(p) {
  const ca = Math.abs(Math.cos(p.yaw)), sa = Math.abs(Math.sin(p.yaw));
  p.ax = ca * p.hx + sa * p.hz;
  p.az = sa * p.hx + ca * p.hz;
  p.top = p.y + p.hy;
  p.bot = p.y - p.hy;
}

// ---- debris --------------------------------------------------------------
// One InstancedMesh for every flying chunk in the city. Chunks inherit the
// colour and size of the piece they came from, which is the detail that sells
// the whole effect: the rubble on the pavement is visibly THAT wall.
export class Debris {
  constructor(scene, groundY) {
    this.groundY = groundY ?? (() => 0);
    this.max = D.debrisMax;
    this.mesh = new THREE.InstancedMesh(unitBox(), mats()[0], this.max);
    this.mesh.frustumCulled = false;             // instances live in world space
    this.mesh.castShadow = true;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
    this.list = [];                              // active chunks, compacted
  }

  spawn(p, vx, vy, vz, spin) {
    if (this.list.length >= this.max) {
      // budget full: recycle the oldest sleeper rather than dropping the cue —
      // a collapse must never silently stop producing rubble
      let oldest = -1, bestT = Infinity;
      for (let i = 0; i < this.list.length; i++) {
        const d = this.list[i];
        if (d.sleep && d.t < bestT) { bestT = d.t; oldest = i; }
      }
      if (oldest < 0) return;
      this.list.splice(oldest, 1);
    }
    const hx = Math.min(p.hx, 1.5), hy = Math.min(p.hy, 1.5), hz = Math.min(p.hz, 1.5);
    this.list.push({
      x: p.x, y: p.y, z: p.z, hx, hy, hz,
      vx, vy, vz,
      rx: p.yaw * 0.0, ry: p.yaw, rz: 0,
      wx: (Math.random() - 0.5) * spin, wy: (Math.random() - 0.5) * spin,
      wz: (Math.random() - 0.5) * spin,
      col: p.col, k: p.k, life: D.debrisLife * (0.7 + Math.random() * 0.6),
      t: 0, sleep: false, gy: this.groundY(p.x, p.z),
    });
  }

  update(dt) {
    const g = D.gravity * dt;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const d = this.list[i];
      d.t += dt;
      if ((d.life -= dt) <= 0) { this.list.splice(i, 1); continue; }
      if (!d.sleep) {
        d.vy -= g;
        d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt;
        d.rx += d.wx * dt; d.ry += d.wy * dt; d.rz += d.wz * dt;
        const floor = d.gy + Math.min(d.hx, d.hy, d.hz);
        if (d.y < floor) {
          d.y = floor;
          if (d.vy < -1.2) {                     // bounce, shedding energy
            d.vy = -d.vy * D.bounce;
            d.vx *= D.friction; d.vz *= D.friction;
            d.wx *= 0.5; d.wy *= 0.5; d.wz *= 0.5;
          } else {                               // settle: lie down and stop
            d.vy = 0;
            d.vx *= 0.72; d.vz *= 0.72;
            d.wx *= 0.4; d.wy *= 0.6; d.wz *= 0.4;
            if (Math.hypot(d.vx, d.vz) < 0.25) {
              d.sleep = true;
              // rubble lies flat — snap the tumble off so a settled pile does
              // not look like a frozen mid-air explosion
              d.rx = Math.round(d.rx / (Math.PI / 2)) * (Math.PI / 2);
              d.rz = Math.round(d.rz / (Math.PI / 2)) * (Math.PI / 2);
              d.wx = d.wy = d.wz = 0;
            }
          }
        }
      }
      // the last 1.6 s shrinks the chunk away instead of popping it
      const fade = d.life < 1.6 ? d.life / 1.6 : 1;
      _v.set(d.x, d.y, d.z);
      _q.setFromEuler(_eul.set(d.rx, d.ry, d.rz));
      _s.set(d.hx * 2 * fade, d.hy * 2 * fade, d.hz * 2 * fade);
      _m4.compose(_v, _q, _s);
      this.mesh.setMatrixAt(i, _m4);
      _c.setHex(d.col).multiplyScalar(d.k * 0.9);
      this.mesh.setColorAt(i, _c);
    }
    this.mesh.count = this.list.length;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}
const _eul = new THREE.Euler();

// ---- dust ----------------------------------------------------------------
// Soft sprites, pooled. Opacity is per-material in three, so each slot owns
// its own SpriteMaterial — 120 of them, allocated once, reused forever.
function puffTexture() {
  const S = 48, R = S / 2, data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = Math.hypot(x + 0.5 - R, y + 0.5 - R) / R;
    const a = u >= 1 ? 0 : Math.pow(1 - u, 1.9);
    const i = (y * S + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 255;
    data[i + 3] = Math.round(a * 255);
  }
  const t = new THREE.DataTexture(data, S, S);
  t.needsUpdate = true;
  return t;
}

export class Dust {
  constructor(scene) {
    const tex = puffTexture();
    this.slots = [];
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    for (let i = 0; i < D.dustMax; i++) {
      const m = new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false, opacity: 0, fog: true,
      });
      const s = new THREE.Sprite(m);
      s.visible = false;
      this.group.add(s);
      this.slots.push({ s, m, live: false, t: 0, life: 1, x: 0, y: 0, z: 0,
        vx: 0, vy: 0, vz: 0, r0: 1, r1: 2, a0: 0.5, col: 0x9a938a });
    }
    scene.add(this.group);
  }

  puff(x, y, z, r0, r1, life, alpha, col, vx, vy, vz) {
    for (const p of this.slots) {
      if (p.live) continue;
      p.live = true; p.t = 0; p.life = life;
      p.x = x; p.y = y; p.z = z;
      p.vx = vx ?? (Math.random() - 0.5) * 2;
      p.vy = vy ?? 0.6 + Math.random() * 1.4;
      p.vz = vz ?? (Math.random() - 0.5) * 2;
      p.r0 = r0; p.r1 = r1; p.a0 = alpha; p.col = col ?? 0x9a938a;
      p.s.visible = true;
      p.m.color.setHex(p.col);
      return;
    }
  }

  update(dt) {
    for (const p of this.slots) {
      if (!p.live) continue;
      p.t += dt;
      const u = p.t / p.life;
      if (u >= 1) { p.live = false; p.s.visible = false; p.m.opacity = 0; continue; }
      p.vy += 0.6 * dt;                          // smoke rises as it cools
      p.vx *= 1 - 0.9 * dt; p.vz *= 1 - 0.9 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const r = p.r0 + (p.r1 - p.r0) * Math.sqrt(u);
      p.s.position.set(p.x, p.y, p.z);
      p.s.scale.set(r, r, 1);
      p.m.opacity = p.a0 * (1 - u) * (1 - u);
    }
  }
}

// ---- the model -----------------------------------------------------------
export class BuildingModel {
  /**
   * @param scene  THREE.Scene
   * @param f      the building feature (needs _id, o, h)
   * @param plan   buildingPlan(f)
   * @param fx     { debris, dust } — shared pools
   * @param opts   { shellOnly } — skip the rooms; the caller builds the shell
   *               and ensureInterior() fills the inside in later (or a rocket
   *               does). This is the cheap tier a building far down the street
   *               lives in: a few hundred outer-wall boxes, nothing else.
   */
  constructor(scene, f, plan, fx, opts) {
    this.scene = scene;
    this.f = f;
    this.plan = plan;
    this.fx = fx;
    this.pieces = [];
    this.grid = new Map();
    this.alive = 0;
    this.shelled = false;      // outer wall built as boxes, facade stood down
    this.interiorBuilt = false; // rooms exist (full tier / after a hit)
    this.damaged = false;      // something has actually hit it
    this.hits = 0;
    this.settle = 0;           // seconds of progressive collapse still to run
    this._settleT = 0;
    this.shellPieces = 0;
    this.lastTouch = 0;        // seconds-since-boot stamp for the LRU
    this._dirty = true;
    this._solid = null;
    this._glass = null;
    this._shell = null;      // the atlas-textured outer leaf
    this._sign = null;       // unlit flat-colour signage
    this._words = null;      // wordmark InstancedMeshes, one per (text|bg|fg)
    this._wordIdx = null;    // wordmark key → index into _words
    this._wCursor = null;    // per-word instance cursors, reused by sync
    this._uvRect = null;
    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = false;
    scene.add(this.group);
    if (!opts?.shellOnly) this.ensureInterior();
  }

  // Lazily grow the rooms under the shell. A shell-tier building carries only
  // its outer wall and roof; walking close — or a rocket, which must always
  // have rooms to reveal — adds the floors, partitions, stairs and furniture
  // WITHOUT touching the shell pieces, so nothing changes seen from outside.
  // Once the shell exists its inner lining is redundant (addShell would only
  // kill it again), so it is filtered out rather than added dead.
  ensureInterior() {
    if (this.interiorBuilt) return;
    this.interiorBuilt = true;
    let list = interiorPieces(this.plan);
    if (this.shelled) list = list.filter((p) => p.leaf !== 'lin');
    this._add(list);
  }

  // ---- piece bookkeeping -------------------------------------------------
  _add(list) {
    const base = this.pieces.length;
    for (const p of list) {
      p.dead = false;
      stampBounds(p);
      this.pieces.push(p);
    }
    for (let i = base; i < this.pieces.length; i++) this._hash(i);
    this.alive += list.length;    this._dirty = true;
    this._rebuildMeshes();
  }

  _hash(i) {
    const p = this.pieces[i];
    const x0 = Math.floor((p.x - p.ax) / CELL), x1 = Math.floor((p.x + p.ax) / CELL);
    const z0 = Math.floor((p.z - p.az) / CELL), z1 = Math.floor((p.z + p.az) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const key = cx + ',' + cz;
      let a = this.grid.get(key);
      if (!a) this.grid.set(key, a = []);
      a.push(i);
    }
  }

  // three cannot grow an InstancedMesh, so adding pieces means new meshes.
  // That happens at most twice per building (shell tier, then the rooms).
  _rebuildMeshes() {
    let nS = 0, nG = 0, nF = 0, nB = 0;
    let wq = null;                       // wordmark key → { text, bg, fg, n }
    for (const p of this.pieces) {
      if (p.uv) nF++;
      else if (p.kind === 'glass') nG++;
      else if (p.kind === 'sign' && p.signText) {
        // one bucket per distinct wordmark; the key is cached on the piece so
        // sync() never rebuilds the string
        const k = p._wkey ??= p.signText + '|' + (p.signBg ?? '') + '|' + (p.signFg ?? '');
        let e = (wq ??= new Map()).get(k);
        if (!e) wq.set(k, e = { text: p.signText, bg: p.signBg, fg: p.signFg, n: 0 });
        e.n++;
      } else if (p.kind === 'sign') nB++;
      else nS++;
    }
    const [solidMat, glassMat] = mats();
    const mk = (n, mat, shadow, geo) => {
      if (!n) return null;
      const m = new THREE.InstancedMesh(geo ?? unitBox(), mat, n);
      m.frustumCulled = false;
      m.castShadow = shadow; m.receiveShadow = shadow;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      return m;
    };
    for (const old of [this._solid, this._glass, this._shell, this._sign,
      ...(this._words ?? [])]) {
      if (!old) continue;
      this.group.remove(old);
      old.dispose();
      if (old === this._shell) old.geometry.dispose();  // the per-model aUvRect clone
    }
    this._solid = mk(nS, solidMat, true);
    this._glass = mk(nG, glassMat, false);
    this._sign = mk(nB, signMat(), false);
    this._words = this._wordIdx = this._wCursor = null;
    if (wq) {
      this._words = []; this._wordIdx = new Map();
      for (const [key, e] of wq) {
        this._wordIdx.set(key, this._words.length);
        this._words.push(mk(e.n, wordmarkMat(e.text, e.bg, e.fg), false, wordBox()));
      }
      this._wCursor = new Array(this._words.length).fill(0);
    }
    this._shell = null;
    if (nF) {
      const c = this.plan.cells;
      this._shell = mk(nF, shellMat(c.atlas, c.pin[0], c.pin[1]), true);
      this._uvRect = new THREE.InstancedBufferAttribute(new Float32Array(nF * 4), 4);
      this._uvRect.setUsage(THREE.DynamicDrawUsage);
      this._shell.geometry = unitBox().clone();   // per-model, it carries aUvRect
      this._shell.geometry.setAttribute('aUvRect', this._uvRect);
    }
    if (this._solid) this.group.add(this._solid);
    if (this._shell) this.group.add(this._shell);
    if (this._sign) this.group.add(this._sign);
    if (this._words) for (const m of this._words) this.group.add(m);
    if (this._glass) this.group.add(this._glass);
    this._dirty = true;
    this.sync();
  }

  // Write the survivors into the instance buffers. Called after every change,
  // never per frame — a standing building costs exactly nothing to draw.
  sync() {
    if (!this._dirty) return;
    this._dirty = false;
    let iS = 0, iG = 0, iF = 0, iB = 0;
    if (this._wCursor) this._wCursor.fill(0);
    for (const p of this.pieces) {
      if (p.dead) continue;
      _v.set(p.x, p.y, p.z);
      _q.setFromAxisAngle(_up, p.yaw);
      _s.set(p.hx * 2, p.hy * 2, p.hz * 2);
      _m4.compose(_v, _q, _s);
      _c.setHex(p.col).multiplyScalar(p.k);
      if (p.uv) {
        if (this._shell) {
          this._shell.setMatrixAt(iF, _m4); this._shell.setColorAt(iF, _c);
          this._uvRect.setXYZW(iF, p.uv[0], p.uv[1], p.uv[2], p.uv[3]);
          iF++;
        }
      } else if (p.kind === 'glass') {
        if (this._glass) { this._glass.setMatrixAt(iG, _m4); this._glass.setColorAt(iG, _c); iG++; }
      } else if (p.kind === 'sign') {
        // wordmark boards carry their colours in the texture — no instance tint
        const wi = p._wkey !== undefined && this._wordIdx
          ? this._wordIdx.get(p._wkey) : undefined;
        if (wi !== undefined) this._words[wi].setMatrixAt(this._wCursor[wi]++, _m4);
        else if (this._sign) { this._sign.setMatrixAt(iB, _m4); this._sign.setColorAt(iB, _c); iB++; }
      } else if (this._solid) {
        this._solid.setMatrixAt(iS, _m4); this._solid.setColorAt(iS, _c); iS++;
      }
    }
    for (const [mesh, n] of [[this._solid, iS], [this._glass, iG],
      [this._shell, iF], [this._sign, iB]]) {
      if (!mesh) continue;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    if (this._words) for (let i = 0; i < this._words.length; i++) {
      this._words[i].count = this._wCursor[i];
      this._words[i].instanceMatrix.needsUpdate = true;
    }
    if (this._uvRect) this._uvRect.needsUpdate = true;
  }

  // The outer wall + roof, built the moment the building is activated at any
  // tier. The thin interior lining (if the rooms exist yet) is retired in the
  // same breath: both leaves put their inner face at the same depth, so the
  // swap moves no surface the player can see or stand against.
  /**
   * The pitched roof, as one mesh rather than as a pile of boxes. A gable made
   * of tiles would be a staircase; this is the same geometry the chunk mesh
   * builds, handed over so the shell that REPLACES that mesh does not throw the
   * roof away with it. Removed the moment the building takes damage — a wrecked
   * house with an immaculate roof floating over it is worse than a flat one.
   */
  addRoof(geo) {
    if (this._roof || !geo) return;
    this._roof = new THREE.Mesh(geo, roofMaterial());
    this._roof.castShadow = this._roof.receiveShadow = true;
    this._roof.frustumCulled = false;
    this.group.add(this._roof);
  }

  dropRoof() {
    if (!this._roof) return;
    this.group.remove(this._roof);
    this._roof.geometry.dispose();
    this._roof = null;
  }

  addShell() {
    if (this.shelled) return;
    // NOTE: shelled ≠ damaged. Every activated building gets its outer wall as
    // boxes (that is what makes windows see-through and removes the on-hit
    // pop); `damaged` stays false until something actually blows a piece off,
    // because that is the flag that decides which models are kept forever.
    this.shelled = true;
    for (const p of this.pieces) if (p.leaf === 'lin') { p.dead = true; this.alive--; }
    const list = shellPieces(this.plan);
    this.shellPieces = list.length;
    this._add(list);
  }

  // ---- queries the walk controller uses ---------------------------------
  _cellsAround(x, z, r, fn) {
    const x0 = Math.floor((x - r) / CELL), x1 = Math.floor((x + r) / CELL);
    const z0 = Math.floor((z - r) / CELL), z1 = Math.floor((z + r) / CELL);
    for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
      const a = this.grid.get(cx + ',' + cz);
      if (a) fn(a);
    }
  }

  // is (x,z) over this piece's footprint? (yaw-rotated rectangle test)
  //
  // The frame, once, because two functions below depend on getting it right:
  // three's rotation.y = θ maps a LOCAL offset to world as
  //   wx =  c·lx + s·lz ,  wz = −s·lx + c·lz      (c = cos θ, s = sin θ)
  // — check it on local +x, which must land on (cos θ, −sin θ). The inverse is
  //   lx =  c·wx − s·wz ,  lz =  s·wx + c·wz .
  static _over(p, x, z) {
    const dx = x - p.x, dz = z - p.z;
    const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
    const lx = c * dx - s * dz, lz = s * dx + c * dz;
    return Math.abs(lx) <= p.hx && Math.abs(lz) <= p.hz;
  }

  // Highest surface at or below `maxY` that (x,z) stands on. −Infinity when
  // this building has nothing there — the caller then falls back to terrain.
  supportY(x, z, maxY) {
    let best = -Infinity;
    this._cellsAround(x, z, 0.1, (arr) => {
      for (const i of arr) {
        const p = this.pieces[i];
        if (p.dead || p.kind === 'glass' || p.kind === 'rail') continue;
        if (p.top > maxY || p.top <= best) continue;
        if (BuildingModel._over(p, x, z)) best = p.top;
      }
    });
    return best;
  }

  // Is this point inside solid geometry? A 3-D point test, unlike pushOut's
  // 2-D-with-a-height-band one — the chase camera needs to know about ceilings
  // and floor slabs, not just walls.
  occupied(x, y, z, pad = 0) {
    let hit = false;
    this._cellsAround(x, z, pad + 0.1, (arr) => {
      if (hit) return;
      for (const i of arr) {
        const p = this.pieces[i];
        if (p.dead || p.kind === 'glass' || p.kind === 'prop' || p.kind === 'rail') continue;
        if (y > p.top + pad || y < p.bot - pad) continue;
        const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
        const dx = x - p.x, dz = z - p.z;
        const lx = c * dx - s * dz, lz = s * dx + c * dz;
        if (Math.abs(lx) <= p.hx + pad && Math.abs(lz) <= p.hz + pad) { hit = true; return; }
      }
    });
    return hit;
  }

  // Push a {x,z} point out of every piece whose vertical span overlaps
  // [yLo, yHi]. Returns true if it moved. This is the ONLY thing that keeps
  // the player in the building — and the reason a hole in a wall is walkable
  // without a single line of code about holes.
  pushOut(pos, radius, yLo, yHi) {
    let moved = false;
    for (let pass = 0; pass < 2; pass++) {
      let hit = false;
      this._cellsAround(pos.x, pos.z, radius + 0.6, (arr) => {
        for (const i of arr) {
          const p = this.pieces[i];
          if (p.dead || p.kind === 'glass') continue;
          if (p.top <= yLo || p.bot >= yHi) continue;
          const c = Math.cos(p.yaw), s = Math.sin(p.yaw);
          const dx = pos.x - p.x, dz = pos.z - p.z;
          const lx = c * dx - s * dz, lz = s * dx + c * dz;
          const qx = clamp(lx, -p.hx, p.hx), qz = clamp(lz, -p.hz, p.hz);
          let nx, nz, pen;
          if (qx === lx && qz === lz) {
            // centre inside the box: leave by the nearest face
            const ex = p.hx - Math.abs(lx), ez = p.hz - Math.abs(lz);
            if (ex < ez) { nx = Math.sign(lx) || 1; nz = 0; pen = ex + radius; }
            else { nx = 0; nz = Math.sign(lz) || 1; pen = ez + radius; }
          } else {
            const ox = lx - qx, oz = lz - qz;
            const d = Math.hypot(ox, oz);
            if (d >= radius || d < 1e-9) continue;
            nx = ox / d; nz = oz / d; pen = radius - d;
          }
          // …and the escape normal back out to world (see _over for the frame)
          const wx = c * nx + s * nz, wz = -s * nx + c * nz;
          pos.x += wx * pen; pos.z += wz * pen;
          hit = true; moved = true;
        }
      });
      if (!hit) break;
    }
    return moved;
  }

  // ---- damage -----------------------------------------------------------

  // ---- structure: what is still held up? ----------------------------------
  // A SUPPORT GRID, not a piece-to-piece graph. The first version built real
  // neighbour lists by testing every pair whose AABBs could touch, and on a
  // 12 800-piece tower that cost 150 ms — a nine-frame freeze on the very
  // frame the player wants to watch. This does the same job in single-digit
  // milliseconds: quantise the building into ~1.6 m cells, mark the ones any
  // structural piece occupies, flood-fill from the cells at ground level, and
  // call a piece supported when ANY of its cells was reached.
  //
  // Two properties fall out for free, and both are improvements:
  //   · Being coarse makes it FORGIVING. Pieces within a cell of each other
  //     count as connected whether or not they literally touch, so a 5 mm
  //     modelling gap can no longer drop a floor.
  //   · Furniture, glass and railings never mark a cell (they are cargo, not
  //     structure) but their cell set reaches one cell DOWN, so a wardrobe is
  //     held up by the floor under it and by nothing else.
  //
  // Keys are packed ints in the building's own cell frame — 250 cells per axis
  // is enough for the 305 m station hall, and the cell size grows for anything
  // bigger, so ix/iy/iz always fit a byte each.
  _support() {
    const pl = this.plan, bb = this.bb, n = this.pieces.length;
    const spanX = bb.maxX - bb.minX + 6, spanZ = bb.maxZ - bb.minZ + 6;
    const spanY = pl.top - pl.y0 + 8;
    const cell = Math.max(1.6, spanX / 250, spanZ / 250, spanY / 250);
    const ox = bb.minX - 3, oz = bb.minZ - 3, oy = pl.y0 - 4;
    const key = (ix, iy, iz) => (ix * 256 + iy) * 256 + iz;
    const occ = new Set();                 // cells containing STRUCTURE
    const cellsOf = new Array(n);
    for (let i = 0; i < n; i++) {
      const p = this.pieces[i];
      if (p.dead) { cellsOf[i] = null; continue; }
      const x0 = Math.floor((p.x - p.ax - ox) / cell), x1 = Math.floor((p.x + p.ax - ox) / cell);
      const z0 = Math.floor((p.z - p.az - oz) / cell), z1 = Math.floor((p.z + p.az - oz) / cell);
      let y0 = Math.floor((p.bot - oy) / cell);
      const y1 = Math.floor((p.top - oy) / cell);
      if (p.weak && y0 > 0) y0--;          // cargo reaches down to its floor
      const list = [];
      for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++)
        for (let iy = y0; iy <= y1; iy++) {
          const k = key(ix, iy, iz);
          list.push(k);
          if (!p.weak) occ.add(k);
        }
      cellsOf[i] = list;
    }
    // ---- support propagation, with a LATERAL BUDGET ----------------------
    // Pure connectivity is not physics: it happily leaves half a tower hanging
    // off one surviving column, which is what "a piece of the building floats
    // in the air" looked like. Real structure carries load DOWN cheaply and
    // SIDEWAYS expensively, so:
    //
    //   support(ground cell)       = SPAN
    //   support(cell above a cell) = support(below)          — free, that's a wall
    //   support(cell beside a cell)= support(beside) − 1     — that's a cantilever
    //
    // and anything that ends up at 0 is not held up by anything. A column of
    // any height stands; a slab reaches SPAN cells (~10 m, about what a real
    // floor plate spans) from the nearest thing that stands; beyond that it
    // goes. Best-first over integer budgets, so one pass with SPAN buckets is
    // exact and costs no more than the plain fill did.
    const SPAN = 6;
    const groundIy = Math.floor((pl.y0 + 1.0 - oy) / cell);
    const level = new Map();                 // cell → remaining lateral budget
    const buckets = [];
    for (let s = 0; s <= SPAN; s++) buckets.push([]);
    for (const k of occ) {
      if (((k >> 8) & 255) > groundIy) continue;
      level.set(k, SPAN); buckets[SPAN].push(k);
    }
    for (let s = SPAN; s > 0; s--) {
      const q = buckets[s];
      for (let qi = 0; qi < q.length; qi++) {
        const k = q[qi];
        if (level.get(k) !== s) continue;    // superseded by a better route
        const iz = k & 255, iy = (k >> 8) & 255, ix = k >>> 16;
        // explicit bounds, because a packed key ±1 at an axis edge would wrap
        // into a legal-looking cell on the far side and bridge the two
        for (let d = 0; d < 6; d++) {
          const up = d === 2, down = d === 3;
          const jx = ix + (d === 0 ? 1 : d === 1 ? -1 : 0);
          const jy = iy + (up ? 1 : down ? -1 : 0);
          const jz = iz + (d === 4 ? 1 : d === 5 ? -1 : 0);
          if (jx < 0 || jy < 0 || jz < 0 || jx > 255 || jy > 255 || jz > 255) continue;
          const j = key(jx, jy, jz);
          if (!occ.has(j)) continue;
          // straight up off something that stands costs nothing (a wall);
          // going down or sideways spends a unit of the cantilever budget
          const ns = up ? s : s - 1;
          if (ns <= 0) continue;
          if ((level.get(j) ?? 0) >= ns) continue;
          level.set(j, ns);
          buckets[ns].push(j);
        }
      }
    }
    // ---- and a SLENDERNESS test ------------------------------------------
    // The budget rule alone still allows a two-cell-wide splinter to stand
    // fourteen storeys tall, because a column is free to carry itself. Real
    // masonry needs bracing: a wall stands because it is long, a lone pier
    // buckles. So a cell above the stub height survives only if its own level
    // has at least BRACE lateral neighbours to be part of — which passes a
    // wall, a floor plate and a stair shaft, and fails exactly the splinters
    // and stumps that looked wrong hanging there.
    const BRACE = 2, STUB = 3;
    const doomed = new Set();
    for (const k of level.keys()) {
      const iy = (k >> 8) & 255;
      if (iy - groundIy <= STUB) continue;
      let neigh = 0;
      const ix = k >>> 16, iz = k & 255;
      for (let dx = -1; dx <= 1 && neigh < BRACE; dx++)
        for (let dz = -1; dz <= 1; dz++) {
          if (!dx && !dz) continue;
          if (occ.has(key(ix + dx, iy, iz + dz))) { neigh++; if (neigh >= BRACE) break; }
        }
      if (neigh < BRACE) doomed.add(k);
    }

    const supported = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const cs = cellsOf[i];
      if (!cs) continue;
      for (const k of cs) if (level.has(k) && !doomed.has(k)) { supported[i] = 1; break; }
    }
    return supported;
  }

  /**
   * blast(x, y, z, r, power) — the whole point of the module.
   * Everything inside the sphere is destroyed and thrown outward; a shell of
   * pieces just outside is scorched; then the support solver drops whatever is
   * no longer connected to the ground. Returns the number of pieces lost.
   */
  blast(x, y, z, r, power = 1) {
    // the roof comes off first, before anything under it can be reached
    this.dropRoof();
    // a rocket must always reveal rooms — a shell-tier building grows its
    // inside on the same frame the hole is made, never a hollow box
    this.ensureInterior();
    this.addShell();
    this.damaged = true;
    this.hits++;
    const outer = r * 1.62;
    const touched = new Set();
    this._cellsAround(x, z, outer + 2, (arr) => { for (const i of arr) touched.add(i); });
    const killed = [];
    let nGlass = 0;                              // shattered panes → glass_break cue
    for (const i of touched) {
      const p = this.pieces[i];
      if (p.dead) continue;
      // distance from the blast centre to the piece's world AABB
      const dx = Math.max(0, Math.abs(x - p.x) - p.ax);
      const dz = Math.max(0, Math.abs(z - p.z) - p.az);
      const dy = Math.max(0, Math.abs(y - p.y) - p.hy);
      const d = Math.hypot(dx, dy, dz);
      const reach = r * (p.weak ? 1.45 : 1);
      if (d <= reach) { killed.push(i); if (p.kind === 'glass') nGlass++; }
      else if (d <= outer) {
        p.k *= D.crackDarken;                    // scorched but standing
        this._dirty = true;
      }
    }
    for (const i of killed) this._destroy(i, x, y, z, r, power, true);
    const fell = this._collapse();
    // the SOUND of it (distance-attenuated one-shots, no-ops without files):
    // a real debris load crashes, a shower of panes shatters, and a big first
    // wave means the whole structure is going — the sustained rumble. The
    // cooldowns live in sfxAt, so a double rocket is not a double rumble.
    if (killed.length + fell > 30) sfxAt?.('debris_crash', 0.9, x, z, 340, 0.7);
    if (nGlass > 8) sfxAt?.('glass_break', 0.8, x, z, 280, 0.3);
    if (fell > 60) sfxAt?.('collapse_rumble', 1, x, z, 460, 6);
    // A building does not finish falling down in the frame it was hit. Arm the
    // settling timer: update() re-runs the support solver a few times a second
    // for the next few seconds, and every round that drops something buys more
    // time. Losing a wall exposes the tip of a slab, which fails, which exposes
    // the next one — the cascade is what makes a collapse read as a collapse
    // instead of a single subtraction.
    this.settle = 3.4;
    this._settleT = 0.22;
    this._dirty = true;
    this.sync();
    // dust: a column at the impact plus a curtain along the new edge
    const dust = this.fx.dust;
    if (dust) {
      for (let i = 0; i < 9; i++)
        dust.puff(x + (Math.random() - 0.5) * r, y + (Math.random() - 0.3) * r,
          z + (Math.random() - 0.5) * r, r * 0.5, r * 2.6, 2.2 + Math.random() * 1.8,
          0.5, 0x8f877c);
    }
    return killed.length + fell;
  }

  // one piece → rubble. `thrown` gives it the blast's outward kick; a piece
  // that merely lost its support just drops.
  _destroy(i, bx, by, bz, r, power, thrown) {
    const p = this.pieces[i];
    if (p.dead) return;
    p.dead = true;
    this.alive--;
    const debris = this.fx.debris;
    if (!debris) return;
    if (thrown) {
      let dx = p.x - bx, dy = p.y - by, dz = p.z - bz;
      const d = Math.hypot(dx, dy, dz) || 1;
      dx /= d; dy /= d; dz /= d;
      // closer to the centre = harder throw; add a lift so the pile does not
      // just slide along the floor
      const f = (1 - Math.min(1, d / (r * 1.3))) * (10 + 16 * power);
      debris.spawn(p, dx * f + (Math.random() - 0.5) * 3,
        dy * f * 0.75 + 4 + Math.random() * 5,
        dz * f + (Math.random() - 0.5) * 3, 7);
    } else {
      debris.spawn(p, (Math.random() - 0.5) * 1.6, -0.4,
        (Math.random() - 0.5) * 1.6, 2.4);
    }
  }

  // Whatever the support grid could not reach from the ground is no longer a
  // building, it is a load looking for somewhere to be.
  //
  // It does NOT all go at once. The solver is a fixed point — one pass already
  // knows the final answer — so dropping everything it condemns would make a
  // ten-storey shear happen inside a single frame, which reads as the building
  // being deleted rather than falling. Instead each pass releases a WAVE of the
  // LOWEST condemned pieces and leaves the rest standing for a quarter of a
  // second; update() calls back, the wave moves up, and the collapse travels
  // through the structure from the wound upward the way a real one does.
  _collapse() {
    const n = this.pieces.length;
    const seen = this._support();
    const doomed = [];
    for (let i = 0; i < n; i++) if (!this.pieces[i].dead && !seen[i]) doomed.push(i);
    if (!doomed.length) return 0;
    doomed.sort((a, b) => this.pieces[a].bot - this.pieces[b].bot);
    const WAVE = Math.max(60, Math.min(D.collapseMax, Math.ceil(doomed.length / 5)));
    const take = Math.min(doomed.length, WAVE);
    for (let k = 0; k < take; k++) this._destroy(doomed[k], 0, 0, 0, 1, 0, false);
    // dust rolls off the front of the wave, not off every chunk
    if (this.fx.dust) for (let k = 0; k < take; k += 26) {
      const p = this.pieces[doomed[k]];
      this.fx.dust.puff(p.x, p.y, p.z, 2, 9, 2.6, 0.34, 0x8f877c);
    }
    this.settle = Math.max(this.settle, doomed.length > take ? 1.6 : 0.6);
    return take;
  }

  // Progressive collapse. Called every frame by interiorsim for damaged models;
  // costs nothing at all once the dust has settled (`settle` runs out and the
  // solver is never touched again until the next rocket).
  update(dt) {
    if (this.settle <= 0) return;
    this.settle -= dt;
    if ((this._settleT -= dt) > 0) return;
    this._settleT = 0.24;
    const fell = this._collapse();
    if (fell > 0) {
      this.settle = Math.max(this.settle, 1.3);   // it is still coming down
      this._dirty = true;
      this.sync();
      // a wave that is really a collapse sounds like one — sfxAt's per-name
      // cooldowns make the rumble "once per settle episode" with no state here
      const cx = (this.bb.minX + this.bb.maxX) / 2, cz = (this.bb.minZ + this.bb.maxZ) / 2;
      if (fell > 30) sfxAt?.('debris_crash', 0.7, cx, cz, 340, 0.7);
      if (fell > 20) sfxAt?.('collapse_rumble', 0.85, cx, cz, 460, 6);
    }
  }

  // how wrecked is it? (drives the "footprint collision no longer applies" test
  // and the HUD)
  get ruinK() {
    const total = this.pieces.length || 1;
    return 1 - this.alive / total;
  }

  dispose() {
    this.dropRoof();
    this.scene.remove(this.group);
    for (const m of [this._solid, this._glass, this._shell, this._sign,
      ...(this._words ?? [])]) {
      if (!m) continue;
      m.dispose();               // wordmark geometry + materials are shared caches
      if (m === this._shell) m.geometry.dispose();   // the per-model aUvRect clone
    }
    this._solid = this._glass = this._shell = this._sign = null;
    this._words = this._wordIdx = this._wCursor = null;
    this.pieces.length = 0;
    this.grid.clear();
  }
}
