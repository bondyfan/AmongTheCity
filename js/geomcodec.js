// ---- a built chunk, as bytes -----------------------------------------------
// buildChunkMeshes hands back a THREE.Group whose attributes are all
// Float32Array: 40 bytes a vertex for ground (position 12, normal 12, colour
// 12, surface class 4), and a dense Pardubice chunk is 100–300 k vertices. That
// is fine to render and expensive to MOVE — postMessage structured-CLONES
// anything that is not an ArrayBuffer in the transfer list, and cloning several
// megabytes on the main thread is exactly the frame a mesher-in-a-worker was
// meant to save. Writing the same group to disk has the same problem in a
// different dress: JSON of a Float32Array is ten bytes a number.
//
// So this is the wire format, written ONCE for the two callers that will use
// it: a worker that meshes off the main thread and posts the bytes, and an
// offline baker that writes the same bytes to a file. Both want the identical
// thing — the group flattened to a node list, plus ONE ArrayBuffer holding
// every attribute — so neither gets its own dialect. A magic number and a
// version int ride in the meta so a stale bake is REFUSED rather than drawn as
// garbage; getting that wrong looks like a corrupted city, not like an error.
//
// WHAT IS NOT IN HERE, and why:
//   • materials. They are shared singletons out of makeMaterials() — a
//     MeshStandardMaterial with an onBeforeCompile closure and two sampler2DArray
//     uniforms cannot be serialised and must not be duplicated. Every mesh
//     stores a KEY instead, resolved against the caller's own `mats` on decode,
//     so the decoded group shares the very same material objects (=== identity)
//     and the renderer's program cache never notices a chunk arrived.
//   • the aerial-photo quad and the brand wordmark quads. Their materials are
//     per-supertile and per-chain, built from a <canvas> on the main thread, and
//     neither a worker nor a node baker can produce them at all. encode() throws
//     naming the mesh if it meets one; register them in `mats.codecMats` (a
//     plain key → material object) if the main thread ever wants to encode a
//     group that has them.
//
// PRECISION. Positions quantise to int16 about the geometry's OWN bounding-box
// centre with ONE uniform scale, both stored in the meta. Chunk geometry
// routinely reaches outside its own 120 m chunk — a feature is drawn whole from
// its home chunk, so a 3 km road ribbon lives in one mesh — which is why the
// origin cannot be the chunk corner and the scale cannot be a constant. The
// scale is UNIFORM (the largest half-extent) rather than per-axis for a reason
// that costs nothing to honour and is invisible until it bites: the dequant
// rides on the mesh's own transform, and a non-uniform object scale makes the
// renderer rotate every normal by the inverse-transpose. A ground mesh 120 m
// wide and 2 m tall would have its 45° slopes shaded as if they were flat. A
// uniform scale leaves every normal exactly where the builder put it.
//   step     = half-extent / 32767      → 60 m half-extent ⇒ 1.8 mm
//   per axis = ±half a step             → ≤ 0.92 mm
//   distance = √3 × that, the axes round independently → ≤ 1.6 mm
// The bound is spent on the DISTANCE, which is what "the vertex moved" means
// and what the test measures: 3 mm of it buys a 113 m half-extent. Anything
// bigger — measured at 14 % of the geometries in 60 real Pardubice chunks, all
// of them meshes holding the home of a long way — keeps float32 positions and
// says so per geometry, because a codec whose error bound only holds on the
// easy cases has no error bound. It still pays: normals, colours and classes
// compress regardless, so a chunk with one of those in it comes out 2.1×
// smaller and a fully quantised one 3.05×; 60 real chunks were 43.6 MB of
// attributes and 16.6 MB of bytes, and the worst vertex in 537 000 of them
// moved 2.80 mm.
//
// Normals are int8 — 1/127 a component, which turned the worst normal in those
// 537 000 vertices by 0.32° — vertex colours uint8, and the surface class
// uint8. All of them stay in that form all the way to the
// GPU as three.js NORMALIZED attributes, so decode does no unpacking and the
// vertex buffer that gets uploaded is the one that came off the wire. The
// class is the one exception to "normalized": surfaces.js reads it as
// `attribute float surf` and indexes a texture array with it, so it is an
// UNnormalized uint8 whose integer value arrives as a float untouched.

import * as THREE from 'three';

/** 'ATCG' — written big-endian by pack(), so a baked file opens saying its name. */
export const MAGIC = 0x41544347;
/** Bump on ANY layout change. decode() refuses anything else. */
export const VERSION = 1;
/** The error bound this codec promises, in metres. Also the quantise/keep-float switch. */
export const MAX_ERR = 0.003;

const I16 = 32767, I8 = 127, U8 = 255, U16 = 65535;
const SQRT3 = Math.sqrt(3);           // three axes round independently — see planPositions

// Every material slot a chunk group can carry, in makeMaterials() order so the
// two lists can be diffed by eye. flat draws the ground, the fills, the ribbons
// and the sink; water the river; building or `facade` the walls; doorTrim and
// doorSign the entrances; lampPost/lampHead and trunk/crown the four
// InstancedMeshes. `facade` is the wall material buildBuildingsMesh builds
// lazily and parks on mats._facadeMat, so it has no slot of its own. flatFar is
// unused by the builder today and costs one string to keep honest.
const MAT_SLOTS = ['flat', 'water', 'building', 'trunk', 'flatFar', 'lampPost',
  'lampHead', 'crown', 'doorTrim', 'doorSign'];
const FACADE = 'facade';

// Attribute encodings. `n` is three's `normalized` flag, which is what makes the
// GPU do the division instead of us.
const TYPES = {
  f32: { ctor: Float32Array, size: 4, n: false },
  i16n: { ctor: Int16Array, size: 2, n: true },
  i8n: { ctor: Int8Array, size: 1, n: true },
  u8n: { ctor: Uint8Array, size: 1, n: true },
  u16n: { ctor: Uint16Array, size: 2, n: true },
  u8: { ctor: Uint8Array, size: 1, n: false },
  u16: { ctor: Uint16Array, size: 2, n: false },
  u32: { ctor: Uint32Array, size: 4, n: false },
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Reads component `c` of vertex `i` in real units, whatever the source is. */
function reader(attr) {
  const a = attr.array, w = attr.itemSize;
  // The fast path is the only one a fresh chunk takes (everything the builder
  // makes is plain Float32Array); the slow path exists so a group that has
  // ALREADY been through this codec can go through it again.
  if (!attr.normalized) return (i, c) => a[i * w + c];
  return (i, c) => attr.getComponent(i, c);
}

// ---- the blob ---------------------------------------------------------------
// One ArrayBuffer for the whole chunk, not one per attribute: a chunk is ~30
// attributes across ~8 meshes, and thirty transfer-list entries is thirty
// detach operations and thirty allocations on the far side. Sections are laid
// out in the order they are planned, each start padded to 4 bytes so a
// Float32Array view is always legal at its offset.
class Blob {
  constructor() { this.at = 0; this.parts = []; }
  /** Reserve `bytes` and remember how to fill them once the buffer exists. */
  claim(bytes, fill) {
    const off = this.at;
    this.parts.push({ off, fill });
    this.at = (off + bytes + 3) & ~3;
    return off;
  }
  finish() {
    const buf = new ArrayBuffer(this.at);
    for (const p of this.parts) p.fill(buf, p.off);
    return buf;
  }
}

// ---- materials --------------------------------------------------------------

/** The key a chunk mesh's material is stored under, or null if we cannot name it. */
export function materialKey(mat, mats) {
  if (!mat || !mats) return null;
  for (const k of MAT_SLOTS) if (mats[k] === mat) return k;
  if (mats._facadeMat === mat) return FACADE;
  const extra = mats.codecMats;
  if (extra) for (const k of Object.keys(extra)) if (extra[k] === mat) return k;
  return null;
}

/** The material a key names, against this caller's own singletons. Throws loudly. */
export function resolveMaterial(key, mats) {
  const m = key === FACADE ? mats?._facadeMat
    : MAT_SLOTS.includes(key) ? mats?.[key]
      : mats?.codecMats?.[key];
  if (!m) {
    // The facade wall material is built lazily by the first chunk that draws
    // buildings WITH facades — which, once meshing moves off the main thread,
    // is a chunk the main thread never built. Whoever wires that up has to make
    // one before the first decode, and this is where they find out.
    throw new Error(`geomcodec.decode: no material for key '${key}'`
      + (key === FACADE ? ' — mats._facadeMat has not been built yet' : ''));
  }
  return m;
}

// ---- userData ---------------------------------------------------------------
// The builder writes four keys and they are all plain data: guessedGround,
// missTiles, px (on the group) and localGeom (on the ortho/far quads). Rather
// than whitelist those and silently drop the fifth somebody adds next year, we
// copy everything that survives a JSON round trip and throw on anything that
// does not — a chunk that quietly lost its provenance is the streaming bug that
// takes a week to find.
function jsonSafe(v) {
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'number' || t === 'boolean') return true;
  if (Array.isArray(v)) return v.every(jsonSafe);
  if (t === 'object' && Object.getPrototypeOf(v) === Object.prototype)
    return Object.values(v).every(jsonSafe);
  return false;
}

function userDataOut(o, where) {
  const ud = o.userData;
  if (!ud) return null;
  let out = null;
  for (const k of Object.keys(ud)) {
    const v = ud[k];
    // `px` is `mats.ortho?.tierOf?.()`, which is undefined with no ortho
    // manager. Absent and undefined read the same to every caller in the game
    // (`group.userData.px`), so JSON's own semantics are the right ones here.
    if (v === undefined) continue;
    if (!jsonSafe(v)) throw new Error(
      `geomcodec.encode: userData.${k} on ${where} is not plain data (${typeof v})`);
    (out ??= {})[k] = v;
  }
  return out;
}

// ---- encode -----------------------------------------------------------------

/** Bounding box of a position attribute, read through whatever encoding it has. */
function bbox(pos) {
  const get = reader(pos), n = pos.count;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = get(i, 0), y = get(i, 1), z = get(i, 2);
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (!(x0 <= x1)) return null;                 // empty attribute
  return [x0, y0, z0, x1, y1, z1];
}

/**
 * Plan the position attribute: where its origin is, how big one int16 step is,
 * and whether int16 can hold it at all inside MAX_ERR.
 *
 * `about0` is the instanced-template case. There the dequant cannot ride on the
 * mesh transform (three applies the object matrix AFTER instanceMatrix, so a
 * mesh scale would move every instance), it rides on the instance matrices
 * instead — and folding a TRANSLATION into those changes where the instances
 * stand. Templates are authored standing on their own origin, so quantising
 * about zero costs nothing and keeps the fold to a pure scale.
 */
function planPositions(bb, about0, instScale = 1) {
  if (!bb) return { type: 'f32', origin: [0, 0, 0], scale: 1 };
  const [x0, y0, z0, x1, y1, z1] = bb;
  const origin = about0 ? [0, 0, 0]
    : [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2];
  const half = Math.max(
    Math.abs(x0 - origin[0]), Math.abs(x1 - origin[0]),
    Math.abs(y0 - origin[1]), Math.abs(y1 - origin[1]),
    Math.abs(z0 - origin[2]), Math.abs(z1 - origin[2]));
  // A step is scale/32767, rounding costs at most half of one PER AXIS, and the
  // three axes round independently — so the error that matters, the distance
  // the vertex actually moved, is up to √3 half-steps. That factor is not
  // bookkeeping: measured over 25 real Pardubice chunks, a mesh admitted on the
  // per-axis reading (half-extent 195.5 m) moved a vertex 5.01 mm, which is the
  // bound this file promises times 1.7. The budget is spent in metres of
  // DISTANCE, which puts the ceiling at a 113 m half-extent.
  // instScale is what the instance matrices multiply this template by (a
  // measured 2.4 for the tallest scattered tree), so the budget is checked in
  // WORLD metres rather than template metres.
  const err = (half * SQRT3 / (2 * I16)) * instScale;
  if (!(err <= MAX_ERR)) return { type: 'f32', origin: [0, 0, 0], scale: 1 };
  // A single point (or a perfectly flat template) would give a zero scale, and
  // a zero scale is a singular object matrix — three inverts it for the normal
  // matrix and every normal comes out NaN.
  return { type: 'i16n', origin, scale: Math.max(half, 1e-6) };
}

/** The largest scale factor any instance applies to its template. */
function maxInstanceScale(mesh) {
  const a = mesh.instanceMatrix.array, n = Math.min(mesh.count, a.length / 16);
  let m = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    for (let c = 0; c < 3; c++) {
      const l = Math.hypot(a[o + c * 4], a[o + c * 4 + 1], a[o + c * 4 + 2]);
      if (l > m) m = l;
    }
  }
  return m || 1;
}

function planGeometry(geo, blob, where, opts = {}) {
  const pos = geo.attributes.position;
  if (!pos) throw new Error(`geomcodec.encode: ${where} has no position attribute`);
  const count = pos.count;
  const out = { attrs: {} };

  // ONE pass over the positions for both the quantisation and the sphere: this
  // runs over every vertex of every chunk in the city, twice would be twice.
  const bb = bbox(pos);
  const plan = planPositions(bb, !!opts.about0, opts.instScale ?? 1);
  out.origin = plan.origin;
  out.scale = plan.scale;
  out.attrs.position = section(blob, pos, plan.type, 3, plan);

  for (const name of Object.keys(geo.attributes)) {
    if (name === 'position') continue;
    const a = geo.attributes[name];
    if (a.count !== count) throw new Error(
      `geomcodec.encode: ${where}.${name} has ${a.count} items for ${count} vertices`);
    if (name === 'normal') out.attrs.normal = section(blob, a, 'i8n', 3);
    else if (name === 'color') out.attrs.color = section(blob, a, 'u8n', a.itemSize);
    else if (name === 'uv' || name === 'uv1' || name === 'uv2') {
      // Atlas windows and the photo's uv window are all inside the unit square,
      // where uint16 is 1.5e-5 of a texture — a hundredth of a pixel on the
      // 1024 px facade atlas. Anything that tiles (u running 0..12 along a wall)
      // would clip, so those keep float32 and the meta says which happened.
      out.attrs[name] = section(blob, a, unitRange(a) ? 'u16n' : 'f32', a.itemSize);
    } else if (name === 'surf') out.attrs.surf = section(blob, a, 'u8', 1);
    else throw new Error(
      `geomcodec.encode: ${where} carries an attribute this codec does not know: '${name}'`);
  }

  const idx = geo.index;
  if (idx) out.index = section(blob, idx, count > U16 ? 'u32' : 'u16', 1);
  // Draw groups ride along verbatim. A building chunk has them without meaning
  // to — ExtrudeGeometry splits sides from caps and mergeGeometries keeps the
  // ranges — and three ignores them for a single-material mesh, but a codec
  // that drops parts of a geometry it did not expect is how a format starts
  // lying. (A mesh with an ARRAY of materials is refused earlier, by name.)
  if (geo.groups?.length)
    out.groups = geo.groups.map((g) => [g.start, g.count, g.materialIndex ?? 0]);
  // The bounding sphere three would otherwise compute lazily on the first
  // frustum test — a full pass over up to 300 k vertices, on the main thread,
  // in the first frame the chunk is visible. It is derived from the bbox rather
  // than from a second exact pass, so it can be up to 41 % wide on a cube: a
  // conservative sphere costs a few uncullable draws, never a missing one.
  out.sphere = sphereOf(bb, plan);
  return out;
}

function unitRange(a) {
  const get = reader(a), n = a.count, w = a.itemSize;
  for (let i = 0; i < n; i++) for (let c = 0; c < w; c++) {
    const v = get(i, c);
    if (!(v >= 0 && v <= 1)) return false;
  }
  return true;
}

/** Sphere over the QUANTISED space the decoded geometry will live in. */
function sphereOf(bb, plan) {
  if (!bb) return null;
  const s = plan.type === 'i16n' ? plan.scale : 1;
  const o = plan.origin;
  const cx = ((bb[0] + bb[3]) / 2 - o[0]) / s;
  const cy = ((bb[1] + bb[4]) / 2 - o[1]) / s;
  const cz = ((bb[2] + bb[5]) / 2 - o[2]) / s;
  const r = Math.hypot(bb[3] - bb[0], bb[4] - bb[1], bb[5] - bb[2]) / 2 / s;
  return [cx, cy, cz, r];
}

/** Reserve and schedule one attribute; returns its meta descriptor. */
function section(blob, attr, type, itemSize, plan = null) {
  const T = TYPES[type];
  const n = attr.count * itemSize;
  const get = reader(attr);
  const off = blob.claim(n * T.size, (buf, at) => {
    const dst = new T.ctor(buf, at, n);
    if (type === 'f32') {
      for (let i = 0, k = 0; i < attr.count; i++)
        for (let c = 0; c < itemSize; c++) dst[k++] = get(i, c);
    } else if (type === 'i16n') {
      const o = plan.origin, s = plan.scale;
      for (let i = 0, k = 0; i < attr.count; i++)
        for (let c = 0; c < itemSize; c++)
          dst[k++] = Math.round(clamp((get(i, c) - o[c]) / s, -1, 1) * I16);
    } else if (type === 'i8n') {
      for (let i = 0, k = 0; i < attr.count; i++)
        for (let c = 0; c < itemSize; c++) dst[k++] = Math.round(clamp(get(i, c), -1, 1) * I8);
    } else if (type === 'u8n') {
      for (let i = 0, k = 0; i < attr.count; i++)
        for (let c = 0; c < itemSize; c++) dst[k++] = Math.round(clamp(get(i, c), 0, 1) * U8);
    } else if (type === 'u16n') {
      for (let i = 0, k = 0; i < attr.count; i++)
        for (let c = 0; c < itemSize; c++) dst[k++] = Math.round(clamp(get(i, c), 0, 1) * U16);
    } else {                                    // u8 / u16 / u32: plain integers
      const lim = type === 'u8' ? U8 : type === 'u16' ? U16 : 4294967295;
      for (let i = 0, k = 0; i < attr.count; i++)
        for (let c = 0; c < itemSize; c++) {
          const v = get(i, c);
          if (!(v >= 0 && v <= lim)) throw new RangeError(
            `geomcodec.encode: ${v} does not fit a ${type} attribute`);
          dst[k++] = v;
        }
    }
  });
  return { t: type, w: itemSize, n: attr.count, o: off };
}

/**
 * Flatten a built chunk group into transferable bytes.
 *
 * @param {THREE.Group} group   what buildChunkMeshes returned (already rebased)
 * @param {object} mats         the same materials object it was built with
 * @returns {{meta: object, buffers: ArrayBuffer[]}}
 *   `buffers` holds ONE ArrayBuffer in v1; pass it straight to postMessage's
 *   transfer list — nothing here is ever structured-cloned.
 */
export function encode(group, mats) {
  if (!group?.isObject3D) throw new TypeError('geomcodec.encode: not an Object3D');
  const blob = new Blob();
  const nodes = [];

  const walk = (obj, parent) => {
    for (const o of obj.children) {
      const where = `${o.name || o.type}${o.parent?.name ? ' in ' + o.parent.name : ''}`;
      const node = {
        k: o.isInstancedMesh ? 'i' : o.isMesh ? 'm' : 'g',
        p: parent,
        name: o.name || '',
        t: [o.position.x, o.position.y, o.position.z],
        cs: !!o.castShadow, rs: !!o.receiveShadow,
        ud: userDataOut(o, where),
      };
      // Only the departures from the defaults, because every chunk has a
      // hundred nodes and the meta is JSON.
      const q = o.quaternion;
      if (q.x || q.y || q.z || q.w !== 1) node.q = [q.x, q.y, q.z, q.w];
      if (o.scale.x !== 1 || o.scale.y !== 1 || o.scale.z !== 1)
        node.s = [o.scale.x, o.scale.y, o.scale.z];
      // The aerial quad bakes its matrix once and never moves again; losing the
      // flag would cost a matrix rebuild per frame per chunk, and losing the
      // updateMatrix() that goes with it would draw it at the origin.
      if (!o.matrixAutoUpdate) node.mau = false;
      if (!o.visible) node.vis = false;
      if (!o.frustumCulled) node.fc = false;
      if (o.renderOrder) node.ro = o.renderOrder;

      if (node.k !== 'g') {
        if (Array.isArray(o.material)) throw new Error(
          `geomcodec.encode: ${where} has an array of materials, which v${VERSION} does not carry`);
        const key = materialKey(o.material, mats);
        if (!key) throw new Error(
          `geomcodec.encode: ${where} carries a material this codec cannot name`
          + ` (${o.material?.type}). The aerial photo and the brand wordmarks are`
          + ' built from a canvas on the main thread — register them in'
          + ' mats.codecMats to encode a group that has them.');
        node.mat = key;
        if (node.k === 'i') {
          const k = maxInstanceScale(o);
          node.geo = planGeometry(o.geometry, blob, where, { about0: true, instScale: k });
          // The instance transforms go out in WORLD metres with the template's
          // dequant scale already folded into their basis columns: the decoder
          // then has literally nothing to do, and the fold is exact because
          // right-multiplying compose(p,q,s) by a uniform scale only changes s.
          // Translations are untouched — see planPositions' about0.
          node.inst = instanceSection(blob, o, node.geo.scale, node.geo.attrs.position.t);
          if (o.instanceColor) node.icol = section(blob, o.instanceColor, 'u8n', 3);
          // Placed instances live in world space, so the batch's own sphere is
          // the only thing standing between a forest and being culled against a
          // template-sized ball at the chunk origin. rebase() computes it; it
          // has to arrive with the bytes or the trees blink out.
          const bs = o.boundingSphere;
          if (bs) node.bs = [bs.center.x, bs.center.y, bs.center.z, bs.radius];
        } else {
          node.geo = planGeometry(o.geometry, blob, where);
        }
      }
      const at = nodes.push(node) - 1;
      walk(o, at);
    }
  };
  walk(group, -1);

  return {
    meta: {
      magic: MAGIC,
      version: VERSION,
      name: group.name || '',
      pos: [group.position.x, group.position.y, group.position.z],
      ud: userDataOut(group, group.name || 'the chunk group'),
      nodes,
    },
    buffers: [blob.finish()],
  };
}

/** instanceMatrix, with the template's dequant scale folded into its basis. */
function instanceSection(blob, mesh, scale, posType) {
  const src = mesh.instanceMatrix.array;
  const n = mesh.count * 16;
  const k = posType === 'i16n' ? scale : 1;
  const off = blob.claim(n * 4, (buf, at) => {
    const dst = new Float32Array(buf, at, n);
    dst.set(src.subarray(0, n));
    if (k === 1) return;
    for (let i = 0; i < n; i += 16) {
      for (let c = 0; c < 3; c++) {           // columns 0..2 are the basis…
        dst[i + c * 4] *= k;
        dst[i + c * 4 + 1] *= k;
        dst[i + c * 4 + 2] *= k;
      }                                        // …12,13,14 are the translation
    }
  });
  return { n: mesh.count, o: off };
}

// ---- decode -----------------------------------------------------------------

const _v = new THREE.Vector3(), _q = new THREE.Quaternion();

/**
 * The node's own transform, with the position dequant folded in when there is
 * one. A quantised mesh's local matrix has to be
 *   T(t) · R · S(s) · T(origin) · S(half)
 * and that product is still a plain TRS: the origin reaches the translation
 * through the node's own rotation and scale, and `half` — the bounding-box
 * half-extent, i.e. metres per unit of the [-1,1] range the int16s live in —
 * multiplies the scale. It is uniform, which is the whole reason the normals
 * can be left alone.
 *
 * Instanced meshes are NOT touched here — three applies the object matrix after
 * instanceMatrix, so a mesh scale would move every instance. Their dequant is
 * folded into the instance matrices at encode time instead.
 */
function placeNode(o, node) {
  const g = node.k === 'm' ? node.geo : null;
  const quant = g && g.attrs.position.t === 'i16n' ? g : null;
  if (node.q) o.quaternion.set(node.q[0], node.q[1], node.q[2], node.q[3]);
  if (!quant) {
    o.position.set(node.t[0], node.t[1], node.t[2]);
    if (node.s) o.scale.set(node.s[0], node.s[1], node.s[2]);
    return;
  }
  _v.set(quant.origin[0], quant.origin[1], quant.origin[2]);
  if (node.s) _v.set(_v.x * node.s[0], _v.y * node.s[1], _v.z * node.s[2]);
  if (node.q) _v.applyQuaternion(_q.set(node.q[0], node.q[1], node.q[2], node.q[3]));
  o.position.set(node.t[0] + _v.x, node.t[1] + _v.y, node.t[2] + _v.z);
  const s = quant.scale;
  if (node.s) o.scale.set(node.s[0] * s, node.s[1] * s, node.s[2] * s);
  else o.scale.setScalar(s);
}

/**
 * Rebuild the group. The result renders identically to what encode() was
 * given: same meshes in the same order, the same material objects, the same
 * flags and userData.
 *
 * The one visible difference is bookkeeping: a quantised mesh carries the
 * dequant in its own transform (position += origin, scale = the half-extent in
 * metres) and its position attribute is int16 in [-1,1]. Nothing in the game
 * reads chunk geometry back — the streamer only adds, disposes and traverses
 * it — and the alternative is unpacking a megabyte into Float32Array on the
 * main thread, which is the cost this whole format exists to avoid.
 */
export function decode(payload, mats) {
  const meta = payload?.meta;
  const buf = payload?.buffers?.[0];
  if (!meta || !buf) throw new TypeError('geomcodec.decode: not an encoded chunk');
  if (meta.magic !== MAGIC) throw new Error(
    `geomcodec.decode: bad magic 0x${(meta.magic >>> 0).toString(16)}`
    + ` — expected 0x${MAGIC.toString(16)}`);
  if (meta.version !== VERSION) throw new Error(
    `geomcodec.decode: format version ${meta.version}, this build speaks ${VERSION}`
    + ' — rebuild the bake, do not draw it');

  const group = new THREE.Group();
  group.name = meta.name;
  group.position.set(meta.pos[0], meta.pos[1], meta.pos[2]);
  if (meta.ud) Object.assign(group.userData, meta.ud);

  const made = [];
  for (const node of meta.nodes) {
    let o;
    if (node.k === 'g') {
      o = new THREE.Group();
    } else {
      const geo = buildGeometry(node.geo, buf);
      const mat = resolveMaterial(node.mat, mats);
      if (node.k === 'i') {
        o = new THREE.InstancedMesh(geo, mat, 0);
        o.instanceMatrix = new THREE.InstancedBufferAttribute(
          new Float32Array(buf, node.inst.o, node.inst.n * 16), 16);
        o.count = node.inst.n;
        if (node.icol) o.instanceColor = new THREE.InstancedBufferAttribute(
          view(node.icol, buf), 3, true);
        if (node.bs) o.boundingSphere = new THREE.Sphere(
          new THREE.Vector3(node.bs[0], node.bs[1], node.bs[2]), node.bs[3]);
      } else {
        o = new THREE.Mesh(geo, mat);
      }
      // The water surface animates from a uniform ticked in onBeforeRender. A
      // closure cannot cross a postMessage boundary, so it is re-attached here
      // by material key — without it the river is a still lid.
      if (node.mat === 'water' && mats.water?.uniforms?.uTime) {
        o.onBeforeRender = () => {
          mats.water.uniforms.uTime.value = performance.now() * 0.001;
        };
      }
    }
    placeNode(o, node);
    o.name = node.name;
    o.castShadow = node.cs;
    o.receiveShadow = node.rs;
    if (node.vis === false) o.visible = false;
    if (node.fc === false) o.frustumCulled = false;
    if (node.ro) o.renderOrder = node.ro;
    if (node.ud) Object.assign(o.userData, node.ud);
    if (node.mau === false) { o.matrixAutoUpdate = false; o.updateMatrix(); }
    made.push(o);
    (node.p < 0 ? group : made[node.p]).add(o);
  }
  return group;
}

function view(d, buf) {
  const T = TYPES[d.t];
  return new T.ctor(buf, d.o, d.n * d.w);
}

function buildGeometry(g, buf) {
  const geo = new THREE.BufferGeometry();
  for (const name of Object.keys(g.attrs)) {
    const d = g.attrs[name];
    geo.setAttribute(name, new THREE.BufferAttribute(view(d, buf), d.w, TYPES[d.t].n));
  }
  if (g.index) geo.setIndex(new THREE.BufferAttribute(view(g.index, buf), 1));
  if (g.groups) for (const [start, count, materialIndex] of g.groups)
    geo.addGroup(start, count, materialIndex);
  if (g.sphere) geo.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(g.sphere[0], g.sphere[1], g.sphere[2]), g.sphere[3]);
  return geo;
}

// ---- one file on disk -------------------------------------------------------
// The baker needs the meta and the blob to be ONE thing it can write and read
// back byte for byte. Same magic and version as the meta carries, so a
// truncated or stale file is caught before any of it is believed.
//
//   0  u32 magic, BIG-endian — the one field that is, so the four bytes on disk
//         spell ATCG and `head -c 4` on a bake answers "what is this file"
//   4  u32 version
//   8  u32 meta JSON length (bytes, then padded to 4)
//  12  u32 buffer count
//  16  u32 × count  buffer lengths (each padded to 4)
//      meta JSON, then the buffers back to back

const pad4 = (n) => (n + 3) & ~3;

/** @returns {ArrayBuffer} the whole payload, ready for writeFile. */
export function pack(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload.meta));
  const bufs = payload.buffers;
  const head = 16 + bufs.length * 4;
  let total = pad4(head) + pad4(json.length);
  for (const b of bufs) total += pad4(b.byteLength);
  const out = new ArrayBuffer(total);
  const dv = new DataView(out), u8 = new Uint8Array(out);
  dv.setUint32(0, MAGIC);            // big-endian: see the layout above
  dv.setUint32(4, VERSION, true);
  dv.setUint32(8, json.length, true);
  dv.setUint32(12, bufs.length, true);
  for (let i = 0; i < bufs.length; i++) dv.setUint32(16 + i * 4, bufs[i].byteLength, true);
  let at = pad4(head);
  u8.set(json, at);
  at += pad4(json.length);
  for (const b of bufs) {
    u8.set(new Uint8Array(b), at);
    at += pad4(b.byteLength);
  }
  return out;
}

/** @returns {{meta: object, buffers: ArrayBuffer[]}} — the inverse of pack(). */
export function unpack(bytes) {
  const ab = bytes instanceof ArrayBuffer ? bytes
    : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (ab.byteLength < 16) throw new Error('geomcodec.unpack: file is too short to be a chunk');
  const dv = new DataView(ab);
  const magic = dv.getUint32(0), version = dv.getUint32(4, true);
  if (magic !== MAGIC) throw new Error(
    `geomcodec.unpack: bad magic 0x${magic.toString(16)} — expected 0x${MAGIC.toString(16)}`);
  if (version !== VERSION) throw new Error(
    `geomcodec.unpack: format version ${version}, this build speaks ${VERSION}`);
  const jsonLen = dv.getUint32(8, true), count = dv.getUint32(12, true);
  const head = 16 + count * 4;
  const lens = [];
  for (let i = 0; i < count; i++) lens.push(dv.getUint32(16 + i * 4, true));
  let at = pad4(head);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, at, jsonLen)));
  at += pad4(jsonLen);
  const buffers = [];
  for (const len of lens) {
    // sliced, not viewed: the caller must be free to transfer these on.
    buffers.push(ab.slice(at, at + len));
    at += pad4(len);
  }
  return { meta, buffers };
}

/** Attribute bytes a group is carrying right now — the "before" of any measurement. */
export function rawByteLength(group) {
  let n = 0;
  group.traverse((o) => {
    if (o.geometry) {
      for (const a of Object.values(o.geometry.attributes)) n += a.array.byteLength;
      if (o.geometry.index) n += o.geometry.index.array.byteLength;
    }
    if (o.isInstancedMesh) {
      n += o.count * 64;
      if (o.instanceColor) n += o.instanceColor.array.byteLength;
    }
  });
  return n;
}
