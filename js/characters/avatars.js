// ---- avatars.js: downloaded people, made ready for the game -----------------
//
// An AVATAR is one modelled person: a skinned surface, the skeleton it was
// bound to and a texture. This file turns what a loader hands over (a three.js
// scene with a SkinnedMesh in it) into the record js/characters/human.js draws
// from, and keeps the animation clips baked for each skeleton.
//
// Everything is brought into the game's FIGURE space once, here: metres, feet
// at y = 0, facing -z. The vertices are moved there in their bind pose, and the
// inverse bind matrices are recomputed from the skeleton as it stands, so the
// file's own units, up axis and armature transform stop mattering after this.
//
// No fetch and no GLTFLoader in this file (js/characters/peopleload.js has
// those): it runs headless, and the tests feed it skeletons made by hand.

import * as THREE from 'three';
import { describeRig, SLOT } from './retarget.js';
import { bakeClip, groundClip, rollClip, sameRig } from './clipbank.js';
import { figureMatrices, invertRigid } from './skinpose.js';
import { gaitTable, clipsFor, strikeFrame, GAIT_ROLES } from './animset.js';

const AVATARS = new Map();     // id -> avatar
const SOURCES = [];            // animation files: { family, rig, clips: Map }
let ROLES = {};                // role -> clip name(s), from the manifest
let CLIP_OPTS = {};            // clip name -> { loop, travel, ground, from, to }
let _ready = false;

export const avatar = (id) => AVATARS.get(id) ?? null;
export const avatarIds = () => [...AVATARS.keys()];
export const avatars = () => [...AVATARS.values()];
export const peopleReady = () => _ready && AVATARS.size > 0;
export const setPeopleReady = (v) => { _ready = !!v; };
export const roles = () => ROLES;
export function setRoles(r, clipOpts = {}) { ROLES = r ?? {}; CLIP_OPTS = clipOpts ?? {}; }

/** Forget everything (tests, a hard reset). Disposes the GPU side. */
export function clearPeople() {
  for (const a of AVATARS.values()) { a.geometry.dispose(); a.farGeometry?.dispose(); a.material.dispose?.(); a.farTex?.dispose(); a.hi?.dispose(); if (a.hiDrop) clearTimeout(a.hiDrop); }
  AVATARS.clear(); SOURCES.length = 0; ROLES = {}; CLIP_OPTS = {}; _ready = false;
}

const _m = new THREE.Matrix4(), _s = new THREE.Matrix4(), _v = new THREE.Vector3(), _n = new THREE.Vector3();

// every Bone a skin uses plus the Bones above them, and the one object they all hang from
function boneSet(skeleton) {
  const set = new Set(skeleton.bones);
  for (const b of skeleton.bones) for (let p = b.parent; p && p.isBone; p = p.parent) set.add(p);
  return [...set];
}

// Stand a loaded scene in figure space: returns the frame (identity) it now hangs in.
function standIn(scene, faces) {
  const frame = new THREE.Group(), norm = new THREE.Group();
  frame.add(norm); norm.add(scene);
  if (faces === '+z') norm.rotation.y = Math.PI;
  frame.updateMatrixWorld(true);
  return { frame, norm };
}

// The surface in its bind pose, in figure space, re-indexed to the rig's bone order.
function bindGeometry(mesh, rig) {
  const g = mesh.geometry, sk = mesh.skeleton;
  sk.update();
  const pos = g.attributes.position, nor = g.attributes.normal, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const n = pos.count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), I = new Uint16Array(n * 4), W = new Float32Array(n * 4);
  const toRig = sk.bones.map((b) => rig.bones.indexOf(b));
  const bm = sk.boneMatrices, e = _s.elements;
  const pre = new THREE.Matrix4().multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
  for (let i = 0; i < n; i++) {
    e.fill(0);
    let tot = 0;
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c), j = si.getComponent(i, c);
      I[i * 4 + c] = w > 0 ? Math.max(0, toRig[j]) : 0; W[i * 4 + c] = w; tot += w;
      if (w > 0) for (let k = 0; k < 16; k++) e[k] += bm[j * 16 + k] * w;
    }
    if (tot <= 0) { _s.identity(); W[i * 4] = 1; I[i * 4] = Math.max(0, rig.hips); } else if (Math.abs(tot - 1) > 1e-4) {
      for (let k = 0; k < 16; k++) e[k] /= tot;
      for (let c = 0; c < 4; c++) W[i * 4 + c] /= tot;
    }
    _m.multiplyMatrices(pre, _s).multiply(mesh.bindMatrix);
    _v.fromBufferAttribute(pos, i).applyMatrix4(_m).toArray(P, i * 3);
    if (nor) _n.fromBufferAttribute(nor, i).transformDirection(_m).toArray(N, i * 3);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(P, 3));
  if (nor) out.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (g.attributes.uv) out.setAttribute('uv', g.attributes.uv.clone());
  if (g.attributes.color) out.setAttribute('color', g.attributes.color.clone());
  out.setAttribute('skinIndex', new THREE.BufferAttribute(I, 4));
  out.setAttribute('skinWeight', new THREE.BufferAttribute(W, 4));
  if (g.index) out.setIndex(g.index.clone());
  if (!nor) out.computeVertexNormals();
  out.computeBoundingBox();
  return out;
}

// Several bound surfaces into one geometry, in the order given. Returns the
// geometry and where each part's triangles sit in its index: [start, count].
function mergeParts(geos, names) {
  const out = new THREE.BufferGeometry(), ranges = {};
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const keys = ['position', 'normal', 'uv', 'color', 'skinIndex', 'skinWeight'].filter((k) => geos.every((g) => g.attributes[k]));
  for (const k of keys) {
    const first = geos[0].attributes[k], arr = new first.array.constructor(nv * first.itemSize);
    let o = 0;
    for (const g of geos) { arr.set(g.attributes[k].array, o); o += g.attributes[k].array.length; }
    out.setAttribute(k, new THREE.BufferAttribute(arr, first.itemSize, first.normalized));
  }
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0, io = 0;
  geos.forEach((g, gi) => {
    const n = g.index ? g.index.count : g.attributes.position.count, start = io;
    for (let i = 0; i < n; i++) idx[io++] = (g.index ? g.index.array[i] : i) + vo;
    vo += g.attributes.position.count;
    const key = names[gi], r = ranges[key];
    // parts of one name are laid next to each other by the caller, so a name is one run
    if (r) r[1] += n; else ranges[key] = [start, n];
  });
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingBox();
  return { geometry: out, ranges };
}

/**
 * Register one person.
 *   id, sex ('m' | 'f'), kind, family (a skeleton family: clips of the same
 *   family are used as recorded), meta (anything the catalogue wants back)
 *   scene     the loaded object holding the meshes
 *   mesh      the SkinnedMesh drawn up close, or
 *   parts     [{ name: 'body' | 'head' | 'hair', mesh }] when the file keeps
 *             them apart: they become one geometry, and `ranges` remembers
 *             where each sits so a head can be drawn on another body
 *   farMesh   optional: a coarser SkinnedMesh on the same bones
 *   material  what to draw it with (shared by every copy of this person)
 *   faces     '+z' when the model looks along +z as loaded (glTF's convention)
 */
export function prepareAvatar({ id, sex = 'm', kind = 'adult', family = '', meta = {}, scene, mesh = null, parts = null, farMesh = null,
  material, farMaterial = null, faces = '+z' }) {
  const order = { body: 0, head: 1, hair: 2 };
  const list = (parts ?? [{ name: 'body', mesh }]).slice().sort((a, b) => (order[a.name] ?? 0) - (order[b.name] ?? 0));
  const { frame, norm } = standIn(scene, faces);
  const set = new Set();
  for (const p of list) for (const b of boneSet(p.mesh.skeleton)) set.add(b);
  if (farMesh) for (const b of boneSet(farMesh.skeleton)) set.add(b);
  // The bones in the order the family's first body has them: a baked clip is
  // rotations by bone INDEX, and files of one family do not all list their
  // bones the same way round.
  const first = familyRep({ family });
  const at = (b) => { const i = first ? first.rig.names.indexOf(b.name) : -1; return i < 0 ? 1e6 : i; };
  const bones = [...set].sort((x, y) => at(x) - at(y));
  let rig = describeRig(bones, frame);
  if (rig.missing.length) throw new Error(`avatar ${id}: no bone for ${rig.missing.join(', ')}`);
  // feet on the ground, hips over the origin, then measure again
  let minY = Infinity;
  for (const p of list) { const g = bindGeometry(p.mesh, rig); if (g.boundingBox.min.y < minY) minY = g.boundingBox.min.y; g.dispose(); }
  const h = rig.hips;
  norm.position.set(-rig.worldP[h * 3], -minY, -rig.worldP[h * 3 + 2]);
  frame.updateMatrixWorld(true);
  rig = describeRig(bones, frame);
  const geos = list.map((p) => bindGeometry(p.mesh, rig));
  const { geometry, ranges } = geos.length === 1 ? { geometry: geos[0], ranges: {} } : mergeParts(geos, list.map((p) => p.name));
  if (geos.length > 1) for (const g of geos) g.dispose();
  const top = rig.bones[0].parent;
  const root = new Float32Array(top.matrixWorld.elements);
  const rest = figureMatrices(rig, rig.restQ, null, root, new Float32Array(rig.n * 16));
  const inv = invertRigid(rest, rig.n, new Float32Array(rig.n * 16));
  const a = {
    id, sex, kind, family, meta, rig, root, rest, inv, geometry, ranges, material,
    farGeometry: farMesh ? bindGeometry(farMesh, rig) : null, farMaterial: farMaterial ?? material,
    height: geometry.boundingBox.max.y,
    tris: (geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3,
    clips: new Map(), cls: null, kin: false, gaits: null, idles: null, fidgets: null, farTex: null, farRows: null,
    tile: null, hi: null, hiUrl: null, hiUsers: 0,
  };
  // the same skeleton as somebody already here: they share one set of clips
  const sameBones = (o) => o.rig.n === rig.n && o.rig.names.every((nm, i) => nm === rig.names[i]);
  for (const o of AVATARS.values()) if (o.family === family && !o.cls && sameBones(o) && sameRig(o.rig, rig)) { a.cls = o; break; }
  // bone for bone the family's first body: clips used as recorded are baked once for all such
  a.kin = !!first && sameBones(first);
  AVATARS.set(id, a);
  return a;
}

/**
 * One part of a person's surface as a geometry of its own: 'body' (everything
 * but the head) or 'head' (the head with its hair). It shares every buffer
 * with the whole and differs only in what it draws. Null when the file did
 * not keep the parts apart.
 */
export function partGeometry(av, part) {
  const r = av.ranges, b = r?.body, h = r?.head;
  if (!b || !h) return null;
  av.partGeo ??= {};
  if (av.partGeo[part]) return av.partGeo[part];
  const g = new THREE.BufferGeometry(), src = av.geometry;
  for (const k in src.attributes) g.setAttribute(k, src.attributes[k]);
  g.setIndex(src.index);
  const hair = r.hair ?? [h[0] + h[1], 0];
  if (part === 'body') g.setDrawRange(b[0], b[1]); else g.setDrawRange(h[0], hair[0] + hair[1] - h[0]);
  g.boundingBox = src.boundingBox;
  return (av.partGeo[part] = g);
}

// ---- the sharp texture, only while somebody stands near ---------------------------
// A person's own atlas is a few megabytes of video memory; forty of them are
// too many to keep for a crowd that is mostly sixty metres away. Every
// material therefore starts on the person's small tile of the shared far atlas
// (av.tile), and the atlas proper (av.hiUrl) is fetched when the first near
// body of that person appears and let go half a minute after the last has gone.
let _fetchTexture = null;
export const setTextureFetcher = (fn) => { _fetchTexture = fn; };
const HI_LINGER = 30000;
export function retainHi(av) {
  av.hiUsers++;
  if (av.hiDrop) { clearTimeout(av.hiDrop); av.hiDrop = 0; }
  if (av.hi || av.hiWait || !av.hiUrl || !_fetchTexture) return av.hiWait ?? null;
  av.hiWait = _fetchTexture(av.hiUrl).then((tex) => {
    av.hiWait = null;
    if (!tex) return;
    if (av.hiUsers <= 0) { tex.dispose(); return; }
    av.hi = tex; av.material.map = tex;
  }, () => { av.hiWait = null; });
  return av.hiWait;
}
export function releaseHi(av) {
  av.hiUsers = Math.max(0, av.hiUsers - 1);
  if (av.hiUsers || !av.hi || av.hiDrop) return;
  av.hiDrop = setTimeout(() => {
    av.hiDrop = 0;
    if (av.hiUsers || !av.hi) return;
    av.material.map = av.tile;
    av.hi.dispose(); av.hi = null;
  }, HI_LINGER);
}

/**
 * Register the clips of one animation file. `scene` holds the skeleton they
 * were made on. `clips` is a list of AnimationClips, or a Map of name to a
 * function returning one (js/characters/rawclips.js builds them on demand).
 */
export function addClipSource({ family = '', scene, clips, faces = '+z', moved = null }) {
  const { frame } = standIn(scene, faces);
  const lazy = clips instanceof Map ? clips : new Map(clips.map((c) => [c.name, () => c]));
  // every node the clips move: the bones, and whatever stands above them and
  // is animated too (a Biped's root is the armature object, not a bone)
  const names = new Set(moved ?? []);
  if (!moved) for (const c of clips) for (const t of c.tracks) names.add(t.name.slice(0, t.name.lastIndexOf('.')));
  const bones = [];
  scene.traverse((o) => { if (o.isBone || (o !== scene && names.has(o.name))) bones.push(o); });
  const rig = describeRig(bones, frame);
  const src = { family, rig, clips: lazy };
  SOURCES.push(src);
  return src;
}

export function clipNames() {
  const out = [];
  for (const s of SOURCES) out.push(...s.clips.keys());
  return out;
}

// the lower ankle of a frame, in figure space, on this body
const _fig = [];
function ankleY(av, bk, f) {
  const n = av.rig.n;
  const fig = _fig[0] && _fig[0].length >= n * 16 ? _fig[0] : (_fig[0] = new Float32Array(n * 16));
  figureMatrices(av.rig, bk.q.subarray(f * n * 4, (f + 1) * n * 4), bk.hip.subarray(f * 3, f * 3 + 3), av.root, fig);
  const l = av.rig.slotBone[SLOT.footL], r = av.rig.slotBone[SLOT.footR];
  return { y: Math.min(fig[l * 16 + 13], fig[r * 16 + 13]), dz: fig[l * 16 + 14] - fig[r * 16 + 14] };
}

const isGait = (name) => GAIT_ROLES.some((r) => clipsFor(ROLES, r, 'm').includes(name) || clipsFor(ROLES, r, 'f').includes(name));

/**
 * The clip `name` baked for this avatar, or null when no file has it. Baked on
 * first use: rotations once per skeleton class, the hips' path per body (a
 * longer leg stands higher), every looping gait turned to start on the same foot.
 */
export function clipFor(av, name) {
  if (av.clips.has(name)) return av.clips.get(name);
  let bk = null;
  const src = SOURCES.find((s) => s.clips.has(name));
  if (src) {
    // a clip of the body's own family is used as recorded, so its rotations
    // are the same for every body of the family: one bake serves them all
    const direct = !!src.family && src.family === av.family;
    const rep = direct ? (av.kin ? familyRep(av) : av) : av.cls ?? av;
    const o = CLIP_OPTS[name] ?? {};
    let raw = rep === av ? null : clipFor(rep, name);
    if (rep === av) {
      const clip = src.clips.get(name)();
      raw = bakeClip(clip, src.rig, av.rig, { loop: o.loop ?? true, travel: o.travel ?? 'none',
        from: o.from ?? null, to: o.to ?? clip.duration, fps: o.fps ?? (clip.duration > 3 ? 15 : 30), name,
        direct: direct ? true : null });
      if (raw.loop && isGait(name)) rollClip(raw, strikeFrame(raw.frames, (f) => ankleY(av, raw, f).dz));
      bk = raw;
    } else if (raw) {
      const k = (av.rig.dims.thigh + av.rig.dims.shin) / (rep.rig.dims.thigh + rep.rig.dims.shin);
      bk = { ...raw, hip: raw.hip.map((v) => v * k), travel: raw.travel * k };
      // undo the class body's own grounding before this body gets its own
      const dy = (raw.grounded ?? 0) * k;
      for (let f = 0; f < bk.frames; f++) bk.hip[f * 3 + 1] -= dy;
      const restA = av.rig.worldP[av.rig.hips * 3 + 1], restR = rep.rig.worldP[rep.rig.hips * 3 + 1];
      for (let f = 0; f < bk.frames; f++) bk.hip[f * 3 + 1] += restR * k - restA;
    }
    // a seated clip sits wherever its OWNER puts the hips (a bench, a chair in a
    // cafe): the game lowers the whole figure to the seat, as it always has, so
    // the recording's own drop to its chair is taken out
    if (bk && o.seat) { if (bk === raw && rep !== av) bk = { ...raw, hip: raw.hip.slice() }; for (let f = 0; f < bk.frames; f++) bk.hip[f * 3 + 1] = 0; }
    if (bk && o.ground !== false && !o.seat) bk.grounded = groundClip(bk, (f) => ankleY(av, bk, f).y, av.rig.worldP[av.rig.slotBone[SLOT.footL] * 3 + 1]);
  }
  av.clips.set(name, bk);
  return bk;
}
// the first body registered of a family (null when there is none yet)
function familyRep(av) {
  if (av.family) for (const o of AVATARS.values()) if (o.family === av.family) return o;
  return av.rig ? av : null;
}

/** The first clip a role has for this body, or null. */
export function roleClip(av, role) {
  for (const n of clipsFor(ROLES, role, av.sex)) { const c = clipFor(av, n); if (c) return c; }
  return null;
}
/** Every clip a role has for this body. */
export function roleClips(av, role) {
  return clipsFor(ROLES, role, av.sex).map((n) => clipFor(av, n)).filter(Boolean);
}

/** The locomotion and standing sets of one body (cached on it). */
export function motionSet(av) {
  if (!av.gaits) {
    av.gaits = gaitTable(ROLES, av.sex, (n) => clipFor(av, n));
    av.idles = roleClips(av, 'idle');
    av.fidgets = roleClips(av, 'fidget').map((c) => { c.loop = false; return c; });
  }
  return av;
}
