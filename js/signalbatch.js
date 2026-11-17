// ---- signalbatch.js: every traffic signal in range, in one draw call ---------
// A mast used to be a Group of seven Meshes (mast, heads, three vehicle lenses,
// two pedestrian lenses), and a light changed by swapping the material on its
// lens meshes. Each of those was its own draw call: 287 of them at
// Václavské náměstí for 14 000 triangles, at some 6 to 7 microseconds of CPU
// apiece in a frame that is CPU-bound. The GPU never noticed them.
//
// Now the whole mast is ONE geometry (js/signalmodel.js's parts merged, the
// lenses with them) and every standing mast within SIG_VIS2 of the player is
// one instance of ONE InstancedMesh. What a lens shows is a per-instance
// float, the pole's state, and a per-vertex lens index says which lens a
// vertex belongs to; the vertex shader picks the off or the lit colour from
// that pair, and the lit colour's glow goes into the emissive term exactly as
// the old lit material's emissive did, so bloom and js/signalmodel.js's
// signalNight() (which holds a lit lens at one brightness to the eye after
// dark) see the same numbers as before. A state flip writes one float.
//
// The live set is compact: a pole entering range takes the next slot, one
// leaving gives its slot to the last pole (swap-remove), so `count` is always
// the number of standing masts in range and the buffers upload only on the
// half-second _cullSignals pass that changed membership, or on a phase flip.
// A felled mast (js/poles.js registerOne's hide callback) gives up its slot
// for good. Instance matrices are composed once from the pose and only
// rewritten when js/traffic.js re-seats a mast on late terrain.
//
// The old way is kept, whole, as the A/B side of js/batchflags.js
// (`__batch.signals = false`): a Group of seven Meshes per standing mast in
// range, built when it first comes into range, lit by swapping the lens
// materials, frozen matrices. Same records, same calls, so js/traffic.js does
// not know which of the two is drawing.
//
// Pure presentation: which lens is lit comes from js/traffic.js's _phase, a
// function of the shared clock, so nothing here can disagree between two
// co-op clients.

import * as THREE from 'three';
import { mergeGeometries } from '../libs/BufferGeometryUtils.js';
import { sigAssets, LAMP_Y, LAMP_Z, PED_Y, PED_X } from './signalmodel.js';
import { BATCH, onBatchFlag } from './batchflags.js';

// lens indices (the per-vertex `sigLens`); -1 is the mast and its heads
const RED = 0, AMB = 1, GRN = 2, PSTOP = 3, PWALK = 4;
/** The state a mast shows before its junction's first tick: every vehicle lens dark. */
export const SIG_DARK = 3;

const _c = new THREE.Color();
// sRGB hex to the linear working space, which is what a vertex colour is read as
function lin(hex, out, o) { _c.setHex(hex); out[o] = _c.r; out[o + 1] = _c.g; out[o + 2] = _c.b; }

// One part of the mast with its constant colour and lens bookkeeping attached.
function part(src, lens, off, on, glow, dx = 0, dy = 0, dz = 0) {
  const g = src.clone();
  if (dx || dy || dz) g.translate(dx, dy, dz);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3), onA = new Float32Array(n * 3), gl = new Float32Array(n * 3);
  const li = new Float32Array(n).fill(lens);
  for (let i = 0; i < n; i++) { lin(off, col, i * 3); lin(on, onA, i * 3); lin(glow, gl, i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('sigOn', new THREE.BufferAttribute(onA, 3));
  g.setAttribute('sigGlow', new THREE.BufferAttribute(gl, 3));
  g.setAttribute('sigLens', new THREE.BufferAttribute(li, 1));
  return g;
}

let _base = null, _mat = null;
// The merged mast, in the frame js/signalmodel.js authors it in (base on the
// origin, vehicle lenses on the head's -z face). Colours are the old
// materials' own: poleMat, headMat, the three off lenses and the lit ones.
function baseGeom() {
  if (_base) return _base;
  const A = sigAssets();
  const hex = (m) => m.color.getHex();          // Color.getHex gives back the sRGB hex
  const ghex = (m) => m.emissive.getHex();
  const parts = [
    part(A.pole, -1, hex(A.poleMat), 0, 0),
    part(A.head, -1, hex(A.headMat), 0, 0),
    part(A.lamp, RED, hex(A.redOff), hex(A.redOn), ghex(A.redOn), 0, LAMP_Y[0], LAMP_Z),
    part(A.lamp, AMB, hex(A.ambOff), hex(A.ambOn), ghex(A.ambOn), 0, LAMP_Y[1], LAMP_Z),
    part(A.lamp, GRN, hex(A.grnOff), hex(A.grnOn), ghex(A.grnOn), 0, LAMP_Y[2], LAMP_Z),
    part(A.ped, PSTOP, hex(A.redOff), hex(A.redOn), ghex(A.redOn), PED_X, PED_Y[0], 0),
    part(A.ped, PWALK, hex(A.grnOff), hex(A.grnOn), ghex(A.grnOn), PED_X, PED_Y[1], 0),
  ];
  _base = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return _base;
}

// One material for all of it. DoubleSide because the lens hoods are open
// tubes seen from inside (the old head material was double-sided too); a
// back face of the mast or a lens is always behind a front face of the same
// solid, so nothing else changes on screen.
function batchMat() {
  if (_mat) return _mat;
  const A = sigAssets();
  _mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
    emissive: 0xffffff, emissiveIntensity: A.redOn.emissiveIntensity });
  _mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute float sigLens;
attribute float sigState;
attribute vec3 sigOn;
attribute vec3 sigGlow;
varying vec3 vSigGlow;`)
      .replace('#include <color_vertex>', `#include <color_vertex>
	vSigGlow = vec3( 0.0 );
	{
		int sl = int( floor( sigLens + 0.5 ) ), st = int( floor( sigState + 0.5 ) );
		// red holds at 2, amber at 1, green at 0; the people cross while the
		// cars of this approach are held at red, and the stop lens is lit otherwise
		bool on = sl == 0 ? st == 2 : sl == 1 ? st == 1 : sl == 2 ? st == 0
			: sl == 3 ? st != 2 : sl == 4 ? st == 2 : false;
		if ( on ) { vColor = sigOn; vSigGlow = sigGlow; }
	}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSigGlow;')
      .replace('vec3 totalEmissiveRadiance = emissive;', 'vec3 totalEmissiveRadiance = emissive * vSigGlow;');
  };
  _mat.customProgramCacheKey = () => 'sigbatch-1';
  // signalNight() keeps a lit lens at one brightness to the eye; it reads this
  A.batchMat = _mat;
  return _mat;
}

const START_CAP = 512;

// every SignalBatch alive (one per Traffic), for the console's flag
const _all = new Set();
onBatchFlag('signals', (on) => {
  for (const r of _all) { const b = r.deref(); if (b) b.setLegacy(!on); else _all.delete(r); }
});

// ---- the old mast, for the A/B: seven Meshes, a material swap per lens ----
function oldMast(p) {
  const A = sigAssets();
  const g = new THREE.Group();
  g.position.copy(p.mesh.position);
  g.rotation.y = p.mesh.rotation.y;
  const lamps = [];
  g.add(new THREE.Mesh(A.pole, A.poleMat), new THREE.Mesh(A.head, A.headMat));
  for (let i = 0; i < 3; i++) {                // red / amber / green, top down
    const L = new THREE.Mesh(A.lamp, A.redOff);
    L.position.set(0, LAMP_Y[i], LAMP_Z);
    g.add(L); lamps.push(L);
  }
  for (let i = 0; i < 2; i++) {                // the pedestrian head: stop over walk
    const L = new THREE.Mesh(A.ped, A.redOff);
    L.position.set(PED_X, PED_Y[i], 0);
    g.add(L); lamps.push(L);
  }
  for (const c of g.children) { c.updateMatrix(); c.matrixAutoUpdate = false; }
  g.updateMatrix(); g.matrixAutoUpdate = false;
  g.userData.lamps = lamps;
  p.obj = g;
  paintOld(p);
  return g;
}

// the lens materials for state `p._st`, by the rule the batch's shader keeps
function paintOld(p) {
  const S = sigAssets(), L = p.obj.userData.lamps, st = p._st;
  L[0].material = st === 2 ? S.redOn : S.redOff;
  L[1].material = st === 1 ? S.ambOn : S.ambOff;
  L[2].material = st === 0 ? S.grnOn : S.grnOff;
  L[3].material = st === 2 ? S.redOff : S.redOn;
  L[4].material = st === 2 ? S.grnOn : S.grnOff;
}

/**
 * Stands in for the Group a junction used to own. `visible` shows or hides
 * every mast in it (js/traffic.js _cullSignals flips it), `add` takes a pole
 * record from SignalBatch.pole().
 */
class SigGroup {
  constructor(batch) { this.batch = batch; this.poles = []; this._vis = false; batch.groups.add(this); }
  get visible() { return this._vis; }
  set visible(v) {
    v = !!v;
    if (v === this._vis) return;
    this._vis = v;
    for (const p of this.poles) if (v) this.batch._show(p); else this.batch._hide(p);
  }
  add(p) { this.poles.push(p); if (this._vis) this.batch._show(p); }
  /** The junction left with its tile: its masts give their slots back. */
  dispose() {
    this.visible = false;
    for (const p of this.poles) this.batch._drop(p);
    this.poles.length = 0;
    this.batch.groups.delete(this);
  }
}

export class SignalBatch {
  /** @param scene  where the InstancedMesh goes (null or a stub in headless tests) */
  constructor(scene) {
    this.scene = scene ?? null;
    this.mesh = null;
    this.cap = 0;
    this.live = [];          // pole records in slot order
    this._dm = false;        // matrices / membership changed since the last flush
    this._ds = false;        // a lens state changed since the last flush
    this.groups = new Set(); // every junction's SigGroup, for a switch of mode
    this.legacy = !BATCH.signals;
    _all.add(new WeakRef(this));
  }

  /**
   * Draw with the one InstancedMesh (false) or the old per-mast Groups (true).
   * Every junction in range is hidden, the mode flips, and they are shown
   * again, so the slots and the Groups never both hold a mast.
   */
  setLegacy(on) {
    on = !!on;
    if (on === this.legacy) return;
    const shown = [];
    for (const g of this.groups) if (g.visible) { shown.push(g); g.visible = false; }
    if (!on) for (const g of this.groups) for (const p of g.poles) this._drop(p);
    this.legacy = on;
    for (const g of shown) g.visible = true;
    this.flush();
  }

  group() { return new SigGroup(this); }

  /**
   * A pole record. `mesh` keeps the shape the tests and _regroundSignals read
   * (a position and a yaw) without being an Object3D in the scene.
   */
  pole(x, y, z, rot) {
    return { mesh: { position: new THREE.Vector3(x, y, z), rotation: { y: rot } },
      _slot: -1, _down: false, _st: SIG_DARK, obj: null };
  }

  /** The mast was knocked over (or was down before it was built): never drawn again. */
  fell(p) { p._down = true; this._hide(p); }

  /** What the pole's lenses show: 0 green, 1 amber, 2 red (js/traffic.js _phase). */
  state(p, st) {
    if (p._st === st) return;
    p._st = st;
    if (p.obj) paintOld(p);
    if (p._slot >= 0) { this.mesh.geometry.attributes.sigState.array[p._slot] = st; this._ds = true; }
  }

  /** The pole's position.y moved (late terrain): rewrite its matrix. */
  reseat(p) {
    if (p.obj) { p.obj.position.y = p.mesh.position.y; p.obj.updateMatrix(); }
    if (p._slot >= 0) { this._writeM(p._slot, p); this._dm = true; }
  }

  /** Once a frame, after the lamps have been ticked: upload what changed. */
  flush() {
    const m = this.mesh;
    if (!m) return;
    if (this._dm) {
      m.count = this.live.length;
      m.visible = this.live.length > 0;
      m.instanceMatrix.needsUpdate = true;
      m.boundingSphere = null;            // recomputed over the live set on the next cull
      this._ds = true;                    // slots moved, so their states did too
    }
    if (this._ds) m.geometry.attributes.sigState.needsUpdate = true;
    this._dm = this._ds = false;
  }

  _ensure(n) {
    if (n <= this.cap) return;
    let cap = Math.max(START_CAP, this.cap);
    while (cap < n) cap *= 2;
    const geo = new THREE.BufferGeometry();
    const base = baseGeom();
    for (const k in base.attributes) geo.setAttribute(k, base.attributes[k]);
    const st = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(SIG_DARK), 1);
    st.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('sigState', st);
    geo.boundingSphere = base.boundingSphere ?? (base.computeBoundingSphere(), base.boundingSphere);
    geo.boundingBox = base.boundingBox ?? (base.computeBoundingBox(), base.boundingBox);
    const mesh = new THREE.InstancedMesh(geo, batchMat(), cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.name = 'signals';
    mesh.count = 0;
    mesh.matrixAutoUpdate = false;        // the instances carry the poses; the mesh never moves
    mesh.updateMatrix();
    const old = this.mesh;
    if (old) {
      mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, this.live.length * 16));
      st.array.set(old.geometry.attributes.sigState.array.subarray(0, this.live.length));
      old.removeFromParent();
      // the merged mast's own attributes are shared with the new geometry:
      // take them off before dispose, which would free their GPU buffers
      for (const k in base.attributes) old.geometry.deleteAttribute(k);
      old.geometry.dispose();
      old.dispose();
    }
    this.mesh = mesh;
    this.cap = cap;
    this.scene?.add?.(mesh);
    this._dm = true;
  }

  _writeM(slot, p) {
    const e = this.mesh.instanceMatrix.array, o = slot * 16;
    const { x, y, z } = p.mesh.position, h = p.mesh.rotation.y;
    const c = Math.cos(h), s = Math.sin(h);
    // T(x, y, z) · Ry(h), column-major
    e[o] = c; e[o + 1] = 0; e[o + 2] = -s; e[o + 3] = 0;
    e[o + 4] = 0; e[o + 5] = 1; e[o + 6] = 0; e[o + 7] = 0;
    e[o + 8] = s; e[o + 9] = 0; e[o + 10] = c; e[o + 11] = 0;
    e[o + 12] = x; e[o + 13] = y; e[o + 14] = z; e[o + 15] = 1;
  }

  _show(p) {
    if (p._down) return;
    if (this.legacy) {
      if (!p.obj) { p.obj = oldMast(p); this.scene?.add?.(p.obj); }
      p.obj.visible = true;
      return;
    }
    if (p._slot >= 0) return;
    this._ensure(this.live.length + 1);
    const slot = this.live.length;
    this.live.push(p);
    p._slot = slot;
    this._writeM(slot, p);
    this.mesh.geometry.attributes.sigState.array[slot] = p._st;
    this._dm = true;
  }

  /** The mast's old-style Group, if it has one, leaves the scene for good. */
  _drop(p) {
    if (!p.obj) return;
    p.obj.removeFromParent();
    p.obj = null;
  }

  _hide(p) {
    if (p.obj) p.obj.visible = false;
    const slot = p._slot;
    if (slot < 0) return;
    p._slot = -1;
    const last = this.live.pop();
    if (last !== p) {
      this.live[slot] = last;
      last._slot = slot;
      this._writeM(slot, last);
      this.mesh.geometry.attributes.sigState.array[slot] = last._st;
    }
    this._dm = true;
  }
}
