// ---- treeshapes.js: which tree stands here, and how big it is ---------------
// Every tree in the world used to be the same icosahedron on the same stick in
// one of four greens. This module is the answer to "what IS that tree": a
// species, a height, a crown and a trunk, all a pure function of the tree's id
// and where it stands, so two machines (and the worker and the main thread)
// grow the same linden in the same place.
//
// It is in the WORKER import graph (js/meshes.js imports it), so it is plain
// data and BufferGeometry only: no document, no canvas, no textures.
//
// TWO TIERS, ONE DESCRIPTION. A chunk carries every tree as one instance of a
// cheap template (a picture of the crown on a five-sided trunk, FAR_VERTS
// vertices: see "the far tier" below). js/trees.js swaps the ones near the
// camera for a detailed model.
// For that swap to be invisible both tiers must agree on the tree, and the only
// thing that crosses the worker boundary per instance is a matrix and a colour.
// So the matrix IS the crown (a unit sphere scaled to the crown's radii and
// set at the crown's centre) and the species rides in the low bits of the
// colour, where two bits of red and blue are far below anything the eye reads.
//
// CROWN SPACE. Both tiers author a crown inside the unit sphere at the origin.
// The ground is then at y = -groundOf(species): a constant per species, because
// the crown's bottom is a fixed share of the tree's height (SPECIES[].b). That
// constant is what lets the near model carry its own trunk down to the ground
// under the very matrix the far crown uses.

import * as THREE from 'three';
import { TREE_TAXA } from './tiledata.js';

// (11 to 14 came with the round 5 tiles, which say what genus a mapped tree
// is: the ash, the robinia, the willow and the ornamental cherry are the ones
// that grow here in numbers and looked like nothing the first eleven could
// stand in for. The tag in the colour has four bits: 15 is the last one free.)
export const SP = {
  LINDEN: 0, MAPLE: 1, CHESTNUT: 2, PLANE: 3, POPLAR: 4, BIRCH: 5,
  SPRUCE: 6, PINE: 7, FRUIT: 8, SHRUB: 9, OAK: 10,
  ASH: 11, ROBINIA: 12, WILLOW: 13, CHERRY: 14,
};

// h      height range in metres when nothing measured it
// b      where the crown starts, as a share of the height
// a      crown radius over crown half-height (a poplar is a column, an oak a dome)
// tau    trunk radius at the ground over the crown radius
// crown  leaf colour, bark the trunk's. sRGB hex as seen at noon.
// APPEND ONLY: the index is the tag every client decodes from the colour.
export const SPECIES = [
  { name: 'linden',   h: [11, 17], b: 0.24, a: [0.74, 0.90], tau: 0.070, crown: 0x4f7a36, bark: 0x85786a },
  { name: 'maple',    h: [9, 15],  b: 0.26, a: [0.86, 1.02], tau: 0.062, crown: 0x5c8638, bark: 0x8e8274 },
  { name: 'chestnut', h: [12, 18], b: 0.20, a: [0.80, 0.95], tau: 0.075, crown: 0x41692f, bark: 0x7c6d5f },
  { name: 'plane',    h: [14, 22], b: 0.30, a: [0.82, 0.98], tau: 0.072, crown: 0x648844, bark: 0xa9a892 },
  { name: 'poplar',   h: [18, 28], b: 0.07, a: [0.22, 0.28], tau: 0.110, crown: 0x4c7838, bark: 0x8f8a7c },
  { name: 'birch',    h: [9, 16],  b: 0.30, a: [0.50, 0.62], tau: 0.058, crown: 0x6d9446, bark: 0xe6e3d8 },
  { name: 'spruce',   h: [14, 26], b: 0.10, a: [0.22, 0.28], tau: 0.085, crown: 0x3a6445, bark: 0x7d685a },
  { name: 'pine',     h: [13, 22], b: 0.58, a: [0.95, 1.25], tau: 0.062, crown: 0x4a6d44, bark: 0xa9764f },
  { name: 'fruit',    h: [3.6, 6], b: 0.30, a: [0.95, 1.15], tau: 0.060, crown: 0x639040, bark: 0x7e6c5d },
  { name: 'shrub',    h: [0.9, 1.7], b: 0.02, a: [1.15, 1.55], tau: 0.0, crown: 0x4a7436, bark: 0x5a4d40 },
  { name: 'oak',      h: [14, 22], b: 0.24, a: [0.98, 1.16], tau: 0.082, crown: 0x466e30, bark: 0x776b5f },
  // a tall open oval, grey furrowed bark; light feathery leaf on dark twisted
  // limbs; a low silver dome with its boughs hanging; a small glossy tree with
  // a red-brown banded stem
  { name: 'ash',      h: [14, 24], b: 0.30, a: [0.60, 0.76], tau: 0.068, crown: 0x587e3c, bark: 0x8b8679 },
  { name: 'robinia',  h: [11, 19], b: 0.34, a: [0.62, 0.80], tau: 0.074, crown: 0x76994c, bark: 0x62574b },
  { name: 'willow',   h: [9, 16],  b: 0.14, a: [0.98, 1.20], tau: 0.085, crown: 0x86a468, bark: 0x6e665a },
  { name: 'cherry',   h: [5, 9],   b: 0.30, a: [0.88, 1.08], tau: 0.064, crown: 0x4e7c38, bark: 0x7a5145 },
];

/** How far below the crown's centre the ground is, in crown radii (see header). */
export const groundOf = (sp) => { const b = SPECIES[sp].b; return (1 + b) / (1 - b); };

// The same hash js/meshes.js draws its jitter from, copied rather than imported
// because meshes.js imports THIS file. Same numbers for the same (id, salt).
export function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
function cellHash(gx, gz, salt) {
  let h = Math.imul(gx ^ 0x9e3779b1, 2654435761);
  h = Math.imul(h ^ Math.imul(gz, 0x27d4eb2d), 2246822519);
  h = Math.imul(h ^ salt, 3266489917);
  h ^= h >>> 15;
  return (h >>> 0) % 1000003;
}

// ---- which species ---------------------------------------------------------
// Most trees in the tiles carry no species (see "a mapped tree that says what
// it is" below for the ones that do), so the mix is made from what a tree IS
// in the data: a mapped street or park point, a slot in a wood polygon, a
// slot in a big park, a measured canopy sample nobody drew a polygon for, or
// ornamental planting. Weights follow what actually grows in the Polabí
// lowland: lime, maple and chestnut avenues, pine and oak woods on the sand
// east of Pardubice, poplars on the floodplain, fruit trees in gardens.
const { LINDEN, MAPLE, CHESTNUT, PLANE, POPLAR, BIRCH, SPRUCE, PINE, FRUIT, SHRUB, OAK,
  ASH, ROBINIA, WILLOW, CHERRY } = SP;
const STREET = [[LINDEN, 30], [MAPLE, 20], [CHESTNUT, 10], [PLANE, 10], [OAK, 7], [BIRCH, 8], [POPLAR, 4], [FRUIT, 11]];
const PARK = [[LINDEN, 22], [MAPLE, 18], [CHESTNUT, 14], [OAK, 14], [PLANE, 8], [BIRCH, 10], [SPRUCE, 6], [PINE, 4], [FRUIT, 4]];
const STAND = [[PINE, 34], [OAK, 26], [SPRUCE, 16], [BIRCH, 10], [LINDEN, 8], [POPLAR, 6]];
const ADMIX = [[BIRCH, 30], [OAK, 25], [PINE, 20], [SPRUCE, 10], [MAPLE, 15]];
const LOW = [[FRUIT, 68], [BIRCH, 10], [SPRUCE, 10], [MAPLE, 12]];
const MID = [[BIRCH, 18], [MAPLE, 20], [LINDEN, 18], [FRUIT, 12], [SPRUCE, 14], [PINE, 6], [OAK, 12]];
const TALL = [[LINDEN, 20], [OAK, 22], [MAPLE, 12], [POPLAR, 14], [SPRUCE, 12], [PINE, 10], [PLANE, 6], [CHESTNUT, 4]];
function pick(table, u) {
  let sum = 0;
  for (const e of table) sum += e[1];
  let x = u * sum;
  for (const e of table) { if ((x -= e[1]) < 0) return e[0]; }
  return table[table.length - 1][0];
}

// ---- a mapped tree that says what it is ---------------------------------------
// Since round 5 a tile tree may be [x, z, taxon, height, crown, girth]
// (docs/TILE-FORMAT.md). js/tiledata.js gives every taxon a class out of the
// first eleven; the genera below have had a class of their own since, and the
// taxon was kept finer than the class for exactly this. A taxon this build has
// never heard of (a newer tile) reads as "nothing known".
const GENUS_CLASS = {
  fraxinus: ASH, ailanthus: ASH,
  robinia: ROBINIA, styphnolobium: ROBINIA, gleditsia: ROBINIA,
  salix: WILLOW,
  prunus: CHERRY,
};
const TAXON_CLASS = TREE_TAXA.map((e) => (e ? GENUS_CLASS[e.id] ?? e.sp : -1));
// A genus that borrows another's class keeps its OWN size. A thuja hedge drawn
// as a spruce must not stand 20 m tall over a garden fence, nor a hazel as tall
// as the lime it borrows its crown from. Metres, mature, as planted in a town;
// only used when nothing surveyed the tree.
const GENUS_H = {
  thuja: [4, 9], taxus: [3, 7], juniperus: [2.5, 6], cupressaceae: [4, 10], sequoiadendron: [18, 32],
  sorbus: [6, 12], crataegus: [4, 8], magnolia: [4, 8], morus: [6, 10],
  carpinus: [8, 15], corylus: [3, 6], ginkgo: [10, 18], alnus: [10, 18],
  catalpa: [7, 12], paulownia: [9, 15], juglans: [10, 18],
};
const TAXON_H = TREE_TAXA.map((e) => (e ? GENUS_H[e.id] ?? null : null));
const CONIFER = [[SPRUCE, 55], [PINE, 45]];
const NEEDLED = new Set([SPRUCE, PINE]);

/** Is this class a conifer (drawn as a cone or a pine, green all year)? */
export const isConifer = (sp) => NEEDLED.has(sp);

/** The class a taxon index is drawn as, or -1: a leaf type only, or nothing known. */
export const taxonClass = (tx) => TAXON_CLASS[tx] ?? -1;

/**
 * The scatter record of a mapped tree feature ({ p: [record], _id }): where it
 * stands, plus whatever the tile knows about it. A bare [x, z] gives all four
 * zero, and such a tree is exactly the tree it was before the tiles knew more.
 *   tx  taxon index      th  height, m      tc  crown diameter, m      tg  girth, m
 */
export function mappedTree(f) {
  const p = f.p[0];
  return { x: p[0], z: p[1], seed: f._id, forest: false,
    tx: p[2] | 0, th: +p[3] || 0, tc: +p[4] || 0, tg: +p[5] || 0 };
}

// What a surveyor can have written and what is a typing error: a "tree" under
// 1.8 m is a whip that will not stay that size, nothing here passes 45 m, and
// no species grows to twice the top of its usual range.
const H_MIN = 1.8, H_MAX = 45, CROWN_MAX = 12;

// An avenue is ONE planting: the trees of a 72 m block of street share a
// species and an age, with the odd replacement among them. A wood is a mix of
// STANDS some 90 m across, each mostly one species with others let in.
const BLOCK = 72, STAND_M = 90;

/**
 * What stands at a scatter spot. `t` is the record js/meshes.js scatters:
 * { x, z, seed, forest, bush, h, park, wild }. `measured` is the canopy
 * raster's height there (0 when unknown). Writes into `out` and returns it:
 *   sp          species index
 *   h           height, m            rx, ry   crown radii, m
 *   cy          crown centre over the ground, m
 *   rt, ht      trunk radius at the ground and trunk length, m
 *   yaw, lean, leanDir   radians
 *   light       lightness offset of the leaf colour, -1..1 scale of a few %
 *   variant     0 or 1: which of the species' near models
 */
export function treeSpec(t, measured, out) {
  const id = t.seed;
  let sp, coherent;
  if (t.bush) {
    sp = SHRUB; coherent = rnd(id, 11);
  } else if (t.wild) {
    // measured, unmapped: the height says what kind of thing it can be
    const h = t.h, cell = cellHash(Math.floor(t.x / STAND_M), Math.floor(t.z / STAND_M), 77);
    const table = h < 7 ? LOW : h < 13 ? MID : TALL;
    sp = rnd(id, 12) < 0.62 ? pick(table, rnd(cell, 3)) : pick(table, rnd(id, 13));
    coherent = rnd(cell, 5);
  } else if (t.forest && !t.park) {
    const cell = cellHash(Math.floor(t.x / STAND_M), Math.floor(t.z / STAND_M), 31);
    sp = rnd(id, 12) < 0.74 ? pick(STAND, rnd(cell, 3)) : pick(ADMIX, rnd(id, 13));
    coherent = rnd(cell, 5);
  } else {
    const cell = cellHash(Math.floor(t.x / BLOCK), Math.floor(t.z / BLOCK), t.park ? 53 : 19);
    const table = t.park ? PARK : STREET;
    sp = rnd(id, 12) < (t.park ? 0.45 : 0.86) ? pick(table, rnd(cell, 3)) : pick(table, rnd(id, 13));
    coherent = rnd(cell, 5);
    if (t.tx) {
      // the tile says what it is: the genus where it names one, and where it
      // only says "conifer" or "broadleaved" the hashed choice is held to that
      const cls = taxonClass(t.tx), leaf = TREE_TAXA[t.tx]?.leaf;
      if (cls >= 0) sp = cls;
      else if (leaf === 'n') sp = rnd(id, 12) < 0.8 ? pick(CONIFER, rnd(cell, 6)) : pick(CONIFER, rnd(id, 14));
      else if (leaf === 'b' && NEEDLED.has(sp)) sp = pick(STREET, rnd(cell, 3));
    }
  }
  const S = SPECIES[sp], H = (t.tx && TAXON_H[t.tx]) || S.h;
  // Height: the surface model where it has one, the species' range otherwise.
  // The raster is 10 m nearest-neighbour and cannot tell a lime from the roof
  // beside it, so a reading far outside what the species grows to is a roof.
  let h;
  if (t.bush) h = t.h;
  else if (t.wild) h = Math.max(3.2, Math.min(34, t.h)) * (0.92 + 0.16 * rnd(id, 4));
  else if (t.th > 0) h = Math.max(H_MIN, Math.min(H_MAX, H[1] * 2, t.th));   // as surveyed
  else {
    const guess = H[0] + (H[1] - H[0]) * (0.25 + 0.5 * coherent + 0.25 * rnd(id, 4));
    h = measured >= 3.5 && measured <= H[1] * 1.25
      ? Math.max(H[0] * 0.62, measured) * (0.94 + 0.12 * rnd(id, 4)) : guess;
  }
  const ry = h * (1 - S.b) / 2;
  // (a surveyed crown is a diameter; one wider than a tree and a half is tall
  // was measured across two trees)
  const rx = t.tc > 0 && !t.bush ? Math.max(0.5, Math.min(CROWN_MAX, h * 0.75, t.tc / 2))
    : Math.min(7.5, ry * (S.a[0] + (S.a[1] - S.a[0]) * rnd(id, 6)));
  out.sp = sp; out.h = h; out.rx = rx; out.ry = ry; out.cy = h * S.b + ry;
  out.rt = Math.max(0.04, Math.min(0.62, S.tau * rx));
  // A surveyed girth sets the far trunk and the pit cut round it. The near
  // model's stem is a fixed share of its crown, so the two tiers may only
  // disagree by what nobody can see across the swap band.
  if (t.tg > 0 && !t.bush) out.rt = Math.max(out.rt * 0.7, Math.min(out.rt * 1.6, 0.9, t.tg / (2 * Math.PI)));
  // the far trunk runs to the crown's centre, where the blob hides its end; a
  // spruce keeps its leader almost to the tip
  out.ht = sp === SPRUCE || sp === POPLAR ? out.cy + ry * 0.6 : out.cy;
  out.yaw = rnd(id, 5) * Math.PI * 2;
  out.leanDir = rnd(id, 8) * Math.PI * 2;
  // street trees are staked and pruned; forest stock leans for the light
  out.lean = (t.bush ? 0 : t.forest ? 0.075 : 0.035) * rnd(id, 9) * (sp === SPRUCE || sp === POPLAR ? 0.4 : 1);
  out.light = (rnd(id, 7) - 0.5) * (t.forest ? 0.11 : 0.06);
  out.variant = rnd(id, 10) < 0.5 ? 0 : 1;
  return out;
}

// ---- the tag in the colour ---------------------------------------------------
// A leaf colour is quantised to bytes (the worker ships instanceColor as u8
// anyway), then the species takes the two low bits of red and blue and the
// model variant the low bit of green. Both build paths write the SAME bytes, so
// the far shader and js/trees.js decode the same species from either.
const _col = new THREE.Color();
/** Leaf colour of a spec as three tagged byte values, each stored as byte/255. */
export function crownColor(spec, out) {
  _col.setHex(SPECIES[spec.sp].crown);
  _col.offsetHSL(0, 0, spec.light);
  const r = (Math.round(_col.r * 255) & ~3) | (spec.sp >> 2);
  const g = (Math.round(_col.g * 255) & ~1) | spec.variant;
  const b = (Math.round(_col.b * 255) & ~3) | (spec.sp & 3);
  out.setRGB(r / 255, g / 255, b / 255);
  return out;
}
export function barkColor(spec, out) {
  out.setHex(SPECIES[spec.sp].bark);
  return out;
}
/** Species and variant back out of three colour bytes. */
export const tagSpecies = (r, b) => ((r & 3) << 2) | (b & 3);
export const tagVariant = (g) => g & 1;

// ---- geometry helpers shared by both tiers ----------------------------------
const _spheres = new Map();
/**
 * A geodesic sphere of frequency n: every face of an icosahedron cut into n*n
 * triangles and pushed out to radius 1. 10n²+2 vertices, indexed, which is the
 * point: a crown lobe shades smooth because its triangles SHARE their corners.
 */
export function geoSphere(n) {
  let s = _spheres.get(n);
  if (s) return s;
  const base = new THREE.IcosahedronGeometry(1, 0).getAttribute('position').array;
  const pos = [], idx = [], seen = new Map();
  const vert = (x, y, z) => {
    const l = Math.hypot(x, y, z); x /= l; y /= l; z /= l;
    const k = Math.round(x * 4096) + ',' + Math.round(y * 4096) + ',' + Math.round(z * 4096);
    let i = seen.get(k);
    if (i === undefined) { i = pos.length / 3; pos.push(x, y, z); seen.set(k, i); }
    return i;
  };
  for (let f = 0; f < base.length; f += 9) {
    const A = [base[f], base[f + 1], base[f + 2]], B = [base[f + 3], base[f + 4], base[f + 5]],
      C = [base[f + 6], base[f + 7], base[f + 8]];
    const at = (i, j) => {
      const u = i / n, v = j / n, w = 1 - u - v;
      return vert(A[0] * w + B[0] * u + C[0] * v, A[1] * w + B[1] * u + C[1] * v, A[2] * w + B[2] * u + C[2] * v);
    };
    for (let i = 0; i < n; i++) for (let j = 0; j < n - i; j++) {
      idx.push(at(i, j), at(i + 1, j), at(i, j + 1));
      if (i + j < n - 1) idx.push(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  _spheres.set(n, s = { pos: new Float32Array(pos), idx: new Uint16Array(idx) });
  return s;
}

/** Smooth per-vertex normals of an indexed soup (area-weighted). */
export function smoothNormals(pos, idx, out = new Float32Array(pos.length)) {
  out.fill(0);
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, c = idx[i + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    out[a] += nx; out[a + 1] += ny; out[a + 2] += nz;
    out[b] += nx; out[b + 1] += ny; out[b + 2] += nz;
    out[c] += nx; out[c + 1] += ny; out[c + 2] += nz;
  }
  for (let i = 0; i < out.length; i += 3) {
    const l = Math.hypot(out[i], out[i + 1], out[i + 2]) || 1;
    out[i] /= l; out[i + 1] /= l; out[i + 2] /= l;
  }
  return out;
}

// ---- the far tier: a picture of the crown on a real trunk --------------------
// Every tree beyond the near radius, and every tree on the low preset's far
// field, is ONE instance of ONE template in ONE InstancedMesh per chunk. It
// used to be two batches (a 42-vertex crown blob and a trunk with a matrix of
// its own) and the blob was what every square in Prague showed from 60 m: a
// smooth ball on a stick. Now the crown is an IMPOSTOR, a quad the shader turns
// to face the eye and paints with a picture of the species' own near model
// (js/treeimpostor.js renders those once at start-up, with their normals, so
// the picture is lit by the real sun), and the trunk is folded into the same
// template. One draw call per chunk instead of two, in the main pass and in
// the shadow pass, and 22 triangles per tree instead of 100.
//
// The trunk is authored in CROWN SPACE like the near models (header): the
// crown matrix that places the picture also places the trunk, down to the
// ground at y = -groundOf(species). That depth differs by species, so the
// template cannot hold it: it holds a PARAMETRIC trunk instead (uv.x the
// height along it, 0 at the ground and 1 at the top; uv.y the radius over the
// root flare's; the normal the radial direction) and the vertex shader builds
// the species' trunk from a small table (js/treeshader.js).
//
// THE CODEC. The worker ships an instanced template quantised about zero by
// its largest coordinate, with that scale folded into the instance matrices.
// Every coordinate here is inside [-1, 1] with the quad's corners ON 1, so the
// scale is exactly 1, the fold is the identity and the shader may treat the
// template as crown space on either path. farCrownExtent() says 1 and
// js/trees.js still divides by it, so nothing downstream had to learn this.
//
// Telling them apart: the quad's normal points straight down (no trunk normal
// does, they are radial with a little lift), which survives the codec's
// eight-bit normals and needs no attribute the codec does not carry.
export const FAR_VERTS = 4 + 15;
export const FAR_QUAD_NY = -1;       // the quad's marker normal (0, -1, 0)
/** The largest |coordinate| of the far template: see trees.js _treesOf(). */
export function farCrownExtent() { return 1; }

let _far = null;
function buildFar() {
  const pos = [], nor = [], col = [], uv = [], idx = [];
  // the quad: corners on +-1, uv the corner (the shader sizes and turns it)
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
    pos.push(u * 2 - 1, v * 2 - 1, 0); nor.push(0, FAR_QUAD_NY, 0); col.push(1, 1, 1); uv.push(u, v);
  }
  idx.push(0, 1, 2, 0, 2, 3);
  // the trunk: five sides, a root flare under it, darker toward the top where
  // the crown stands over it. Positions are placeholders inside the unit box
  // (the shader replaces them); only uv and the normal matter.
  const SIDES = 5, rings = [[0, 1.45, 1.0], [0.07, 1.0, 1.0], [1, 0.5, 0.62]];
  for (const [t, r, shade] of rings) {
    for (let k = 0; k < SIDES; k++) {
      const a = k / SIDES * Math.PI * 2, cx = Math.cos(a), cz = Math.sin(a);
      pos.push(cx * r * 0.05, -0.9 + t * 0.8, cz * r * 0.05);
      nor.push(cx * 0.9928, 0.1196, cz * 0.9928);   // unit length
      col.push(shade, shade, shade); uv.push(t, r / 1.45);
    }
  }
  for (let j = 0; j < rings.length - 1; j++) for (let k = 0; k < SIDES; k++) {
    const a = 4 + j * SIDES + k, b = 4 + j * SIDES + (k + 1) % SIDES, c = a + SIDES, d = b + SIDES;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(idx);
  return g;
}

/**
 * The far template, CLONED: a chunk owns its geometry and disposes it when it
 * unloads, so a shared template would lose its GPU buffers.
 */
export function farTemplate() {
  if (!_far) _far = buildFar();
  return _far.clone();
}

// How far a far batch's bounding sphere is grown past what three computes from
// the template: the template's trunk is a placeholder (the real one runs to
// the ground, up to 3.8 crown radii below the crown) and the picture may be
// 1.75 crown radii wide, so the computed sphere is too small by a tree.
export const FAR_BOUND_PAD = 14;

// How far under the ground a far trunk starts, so a slope cannot show daylight
// under its downhill side (the far shader sinks its trunk by the same metres).
export const TRUNK_SINK = 0.3;

const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(),
  _s = new THREE.Vector3(), _ax = new THREE.Vector3(), _upv = new THREE.Vector3(0, 1, 0);
/**
 * The instance matrices of a tree standing at (x, y, z): `crown` is the unit
 * crown sphere set at the crown's centre, `trunk` (optional: the far template
 * carries its trunk in crown space now) the unit trunk on the ground. The lean
 * turns both about the foot of the tree.
 */
export function treeMatrices(spec, x, y, z, crown, trunk) {
  _ax.set(Math.cos(spec.leanDir), 0, Math.sin(spec.leanDir));
  _q.setFromAxisAngle(_ax, spec.lean);
  _q2.setFromAxisAngle(_upv, spec.yaw);
  _q.multiply(_q2);
  _v.set(0, spec.cy, 0).applyQuaternion(_q);
  _v.x += x; _v.y += y; _v.z += z;
  _s.set(spec.rx, spec.ry, spec.rx);
  crown.compose(_v, _q, _s);
  if (!trunk) return;
  _v.set(x, y - TRUNK_SINK, z);
  _s.set(spec.rt, spec.ht + TRUNK_SINK, spec.rt);
  trunk.compose(_v, _q, _s);
}
