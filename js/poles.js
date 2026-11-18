// ---- poles.js: a lamp column is an object in the world, not a decal --------
// A street lamp used to be scenery in the most literal sense: an InstancedMesh
// the car drove straight through. This makes it a THING — you cannot pass it,
// you can knock it down, and once it is down it stays down.
//
// Three constraints shaped the design, and all three come from the fact that
// the masts are instanced:
//
//  1. THE STANDING POLES ARE NOT MESHES. They are rows in two InstancedMeshes
//     the chunk owns. So "knock this one over" means: zero its instance matrix
//     (it vanishes from the batch at the cost of one matrix write) and spawn a
//     single real Mesh for the one that is falling. At any moment the scene
//     holds one Mesh per pole IN MOTION — a handful — not one per pole.
//
//  2. A CHUNK REBUILDS, A FELLED POLE MUST NOT COME BACK. Chunks are rebuilt on
//     LOD upgrades, on tile arrival, on re-entry from across the city; each
//     rebuild makes fresh InstancedMeshes with every pole standing again. So
//     the damage lives HERE, keyed by the pole's own position rounded to a
//     decimetre, and every registration filters itself through it. Same
//     discipline parkinglots.js uses for a stolen stall car.
//
//  3. COLLISION IS ASKED PER CORNER, PER CAR, PER FRAME. world.collide() runs
//     4–6 times for every vehicle; it cannot afford a scan. Poles go in a
//     20 m grid and a query touches one bucket.
//
// The felling itself is deliberately not a physics engine. A mast is a rigid
// rod hinged at its base: it rotates about the axis perpendicular to the blow,
// accelerating under gravity, and stops flat. That is two floats of state and
// it looks like what everybody remembers from GTA, because that is roughly what
// GTA does too.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { sfxAt } from './audio.js';   // safe headless — no-ops without a context
import { lampFallGeom, LAMP_KINDS } from './streetlamps.js';
import { sigAssets } from './signalmodel.js';
import { inBand } from './levelsep.js';

const CELL = 20;                       // m — spatial grid for collision queries
export const POLE_R = 0.16;            // m — mast radius the car feels
// Below this you have merely bumped it: the mast wins, the car stops. A parked
// nudge should never fell a steel column, and 12 km/h is about where a real one
// starts to lose.
const FELL_SPEED = 3.4;                // m/s
// How far a mast reaches over its foot: what stands higher than that is over it.
const POLE_TALL = { street: 8, park: 4.6, mast: 14.5, mast1: 14.5, signal: 6.5 };
const FALL_T = 1.15;                   // s from upright to flat
// How long a felled mast lies in the street before it is quietly retired. Long
// enough to drive back and look at it, short enough that an hour of demolition
// does not become a thousand draw calls.
const LIE_T = 90;                      // s

const key10 = (x, z) => `${Math.round(x * 10)},${Math.round(z * 10)}`;
const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;

export class Poles {
  constructor(scene) {
    this.scene = scene;
    this.grid = new Map();        // cell key → array of standing poles
    this.felled = new Set();      // key10 of every pole knocked down this session
    this.falling = [];            // the handful in motion or lying
    this.groundAt = null;         // (x, z) => what a free-standing pole stands on, if the owner knows
    this._mat = null;
  }

  /**
   * A chunk has just built its lamp masts. `spots` is [[x, z, rot], …] in the
   * SAME order as the instances, so an index here is an index there.
   * Returns the number that were already down, which the caller hides.
   *
   * A chunk can own more than one batch (street columns and park lanterns are
   * different shapes): the first call for a key replaces what the key held,
   * `more` adds to it. `posts.userData.ys` is each lamp's base height when the
   * mesher wrote one (a lamp stands on the PAVEMENT, not on the ground under
   * it), and `posts.userData.kind` names the shape that falls over.
   *
   * `rot` is kept with the pole: the falling mesh starts from the pose the
   * standing one had. Dropped, a column that stood turned to its road went
   * over with its 1.8 m arm snapped round to world -z on the frame it was hit.
   */
  register(key, spots, posts, heads, terrain, more = false) {
    if (!more) this.unregister(key);
    const ys = posts?.userData?.ys, kind = posts?.userData?.kind ?? 'street';
    let gone = 0;
    for (let i = 0; i < spots.length; i++) {
      const [x, z, rot = 0] = spots[i];
      const id = key10(x, z);
      if (this.felled.has(id)) {
        // rebuilt while it was lying in the road: it does not stand up again
        hideInstance(posts, i); hideInstance(heads, i);
        gone++;
        continue;
      }
      const y = ys?.[i] ?? (terrain ? terrain.heightAt(x, z) : 0);
      const p = { x, y, z, id, key, i, posts, heads, kind, rot };
      const ck = cellKey(x, z);
      let arr = this.grid.get(ck);
      if (!arr) this.grid.set(ck, arr = []);
      arr.push(p);
    }
    if (gone) {
      posts.instanceMatrix.needsUpdate = true;
      heads.instanceMatrix.needsUpdate = true;
    }
    return gone;
  }

  /**
   * A single free-standing pole that is not a row in a batch — a traffic
   * signal. `hide` removes the standing visual when it goes over. Returns
   * false when this pole was already felled this session, so the caller can
   * hide it on the spot instead of standing it back up. `rot` is its yaw, so
   * the head still faces its approach as the mast goes over. `look` is for a
   * pole whose falling shape is its own (a trolley mast and its bracket, each
   * one a different length): { geo, mat }, the geometry built about the foot
   * and owned by the pole, so it is disposed when the felled mast is retired.
   */
  registerOne(key, x, y, z, hide, kind = 'signal', rot = 0, look = null) {
    const id = key10(x, z);
    if (this.felled.has(id)) return false;
    const ck = cellKey(x, z);
    let arr = this.grid.get(ck);
    if (!arr) this.grid.set(ck, arr = []);
    // a re-delivered tile re-creates its junctions: same pole, same spot —
    // one collider, not a phantom twin that survives the felling
    if (!arr.some((p) => p.id === id)) arr.push({ x, y, z, id, key, hide, kind, rot, look });
    return true;
  }

  /** Was the pole standing at (x, z) knocked down this session? */
  isFelled(x, z) { return this.felled.has(key10(x, z)); }

  /** A chunk went away: its standing poles go with it. The felled set does not. */
  unregister(key) {
    for (const [ck, arr] of this.grid) {
      const keep = arr.filter((p) => p.key !== key);
      if (keep.length === arr.length) continue;
      if (keep.length) this.grid.set(ck, keep); else this.grid.delete(ck);
    }
  }

  /** Every standing pole within `r` of (x, z). Touches at most four buckets. */
  near(x, z, r, out = []) {
    out.length = 0;
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL);
    const j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    const r2 = r * r;
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const arr = this.grid.get(`${i},${j}`);
        if (!arr) continue;
        for (const p of arr) {
          const dx = p.x - x, dz = p.z - z;
          if (dx * dx + dz * dz <= r2) out.push(p);
        }
      }
    }
    return out;
  }

  /**
   * Is something standing at height `y` on this mast's level: between its
   * foot and its head, or a little under the foot (js/levelsep.js)? A column
   * on a bridge deck is not in the way of the street below, nor a street
   * lamp in the way of the traffic on the viaduct over it. Asked without a
   * height (an old caller), every mast is at every level.
   */
  atLevel(p, y) {
    if (y === undefined) return true;
    // (a signal's recorded foot may be a guess from before its ground loaded: see fell())
    const base = p.kind === 'signal' && this.groundAt ? this.groundAt(p.x, p.z) : p.y;
    return inBand(y, base, POLE_TALL[p.kind] ?? POLE_TALL.street);
  }

  /**
   * Push a point out of any standing mast — the rigid half of the promise.
   * Mutates `pos` and returns true if it moved, matching world.collide().
   */
  collide(pos, radius, y) {
    const rr = POLE_R + radius;
    let pushed = false;
    for (const p of this.near(pos.x, pos.z, rr, _scratch)) {
      if (!this.atLevel(p, y)) continue;
      const dx = pos.x - p.x, dz = pos.z - p.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= rr * rr) continue;
      if (d2 < 1e-9) { pos.x = p.x + rr; pushed = true; continue; }
      const d = Math.sqrt(d2);
      pos.x = p.x + (dx / d) * rr;
      pos.z = p.z + (dz / d) * rr;
      pushed = true;
    }
    return pushed;
  }

  /**
   * Something arrived at (x, z) travelling (vx, vz). Fells every mast it
   * reached and returns how many went down, so the caller can decide what that
   * costs them. Below FELL_SPEED nothing falls and `collide` keeps standing in
   * the way, which is the difference between hitting a lamp post and parking
   * against one.
   */
  strike(x, z, vx, vz, reach = 1.6, y) {
    const sp = Math.hypot(vx, vz);
    if (sp < FELL_SPEED) return 0;
    let n = 0;
    // its OWN array: fell() splices the grid, so the list being walked must not
    // be the one collide() shares
    for (const p of this.near(x, z, reach + POLE_R, _struck)) {
      if (!this.atLevel(p, y)) continue;
      this.fell(p, vx / sp, vz / sp, sp);
      n++;
    }
    return n;
  }

  /** Knock this one down, pushed along (dx, dz). */
  fell(p, dx, dz, speed = 8) {
    if (this.felled.has(p.id)) return;
    this.felled.add(p.id);
    // out of the standing world — a batch row zeroes its matrix, a
    // free-standing pole brought its own way to disappear
    if (p.hide) {
      p.hide();
    } else {
      hideInstance(p.posts, p.i); hideInstance(p.heads, p.i);
      p.posts.instanceMatrix.needsUpdate = true;
      p.heads.instanceMatrix.needsUpdate = true;
    }
    // …out of the collision grid
    const ck = cellKey(p.x, p.z);
    const arr = this.grid.get(ck);
    if (arr) {
      const at = arr.indexOf(p);
      if (at >= 0) arr.splice(at, 1);
      if (!arr.length) this.grid.delete(ck);
    }
    // …and into the world as a real, falling object
    const mesh = new THREE.Mesh(
      p.look ? p.look.geo : p.kind === 'signal' ? signalGeom() : lampFallGeom(LAMP_KINDS.includes(p.kind) ? p.kind : 'street'),
      p.look ? p.look.mat : p.kind === 'signal' ? this.signalMaterial() : this.material());
    // A signal is registered when its tile is indexed, which can be before the
    // ground under it has loaded: its recorded height is then a guess (zero),
    // and the mast fell over two hundred metres under the street. Ask again now.
    const y = p.kind === 'signal' && this.groundAt ? this.groundAt(p.x, p.z) : p.y;
    mesh.position.set(p.x, y, p.z);
    // as it stood, until the first update() tips it
    mesh.quaternion.setFromAxisAngle(_up, p.rot ?? 0);
    mesh.castShadow = true;
    this.scene?.add(mesh);
    // The hinge is horizontal and perpendicular to the blow, so the mast goes
    // over the way it was pushed. The SIGN matters and is easy to get backwards:
    // a right-handed turn about +x carries the top toward +z, so to send it
    // toward the blow the axis is (dz, 0, −dx), not (−dz, 0, dx).
    // A pole of its own shape is a tall thing with a bracket on it, and where it
    // lands is not where it stood: a trolley mast at the back of a verge goes
    // over onto paving 16 cm higher, and lying at its foot's height it was
    // buried in the street, gone. So it comes to rest on the highest ground
    // under its length (a hand over it), its foot lifting as it goes down.
    let lift = 0;
    if (p.look && this.groundAt) {
      let hi = y;
      for (let d = 1; d <= 7; d += 2) hi = Math.max(hi, this.groundAt(p.x + dx * d, p.z + dz * d));
      lift = hi - y + 0.08;
    }
    this.falling.push({
      mesh, ax: dz, az: -dx, t: 0, rot: p.rot ?? 0, own: !!p.look, y0: y, lift,
      // a harder hit takes it over faster, but never so fast it reads as a whip
      rate: Math.min(1.9, 0.75 + speed / 26),
    });
    sfxAt('pole_hit', 1, p.x, p.z, 220);
  }

  update(dt) {
    for (let i = this.falling.length - 1; i >= 0; i--) {
      const f = this.falling[i];
      const was = f.t;
      f.t += dt * f.rate;
      if (was < FALL_T) {
        // a rod hinged at its base does not fall linearly: it barely moves,
        // then goes. t² is close enough and costs nothing.
        const k = Math.min(1, f.t / FALL_T);
        // the tilt about the hinge, applied to the mast AS IT STOOD (its own
        // yaw first): the arm goes over from where it was pointing
        f.mesh.quaternion.setFromAxisAngle(
          _axis.set(f.ax, 0, f.az).normalize(), (Math.PI / 2) * k * k);
        if (f.rot) f.mesh.quaternion.multiply(_yaw.setFromAxisAngle(_up, f.rot));
        if (f.lift) f.mesh.position.y = f.y0 + f.lift * k * k;
        if (f.t >= FALL_T) sfxAt('pole_land', 0.9, f.mesh.position.x, f.mesh.position.z, 200);
      } else if (f.t > LIE_T) {
        this.scene?.remove(f.mesh);
        if (f.own) f.mesh.geometry.dispose();
        this.falling.splice(i, 1);
      }
    }
  }

  material() {
    if (!this._mat) this._mat = new THREE.MeshLambertMaterial({ color: 0x8a8d92 });
    return this._mat;
  }

  signalMaterial() {
    if (!this._sigMat) this._sigMat = new THREE.MeshLambertMaterial({ color: 0x2e3134 });
    return this._sigMat;
  }

  /** Everything, for a world reset. */
  clear() {
    for (const f of this.falling) { this.scene?.remove(f.mesh); if (f.own) f.mesh.geometry.dispose(); }
    this.falling.length = 0;
    this.grid.clear();
    this.felled.clear();
  }
}

const _scratch = [], _struck = [];
const _axis = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0), _yaw = new THREE.Quaternion();
const _zero = new THREE.Matrix4().makeScale(0, 0, 0);
function hideInstance(m, i) { if (m && i < m.count) m.setMatrixAt(i, _zero); }

// What falls is the lamp itself (js/streetlamps.js: steel and lens merged, built
// about its BASE so rotating the mesh swings the top over, which is what a hinge
// at the pavement is). Those geometries are shared by every felled lamp of a
// kind, so retiring one does not dispose them.

// The signal counterpart: the mast and housing js/signalmodel.js builds, as one
// piece. Same base-origin convention as the lamp.
let _sigGeom = null;
function signalGeom() {
  if (!_sigGeom) {
    const A = sigAssets();
    const strip = (g) => { const n = g.index ? g.toNonIndexed() : g.clone(); n.deleteAttribute('uv'); return n; };
    _sigGeom = mergeGeometries([strip(A.pole), strip(A.head)], false);
  }
  return _sigGeom;
}

export const _test = { FELL_SPEED, FALL_T, LIE_T, CELL, key10, cellKey };
