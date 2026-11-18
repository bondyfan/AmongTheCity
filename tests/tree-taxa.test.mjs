// ---- a mapped tree is drawn as what it is ---------------------------------------
// The round 5 tiles say what some trees ARE: [x, z, taxon, height, crown, girth]
// (docs/TILE-FORMAT.md). This pins what js/treeshapes.js makes of that:
//
//   1. a genus is drawn as its class, a conifer as a conifer, and a leaf type
//      alone narrows the hashed choice without making it
//   2. a surveyed height, crown and girth are used, and a typing error is not
//   3. a tree the tile knows nothing about is the tree it always was
//   4. the species and the size survive the trip through the mesh worker

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const S = await import('../js/treeshapes.js');
const { TREE_TAXA, treeClass } = await import('../js/tiledata.js');
const { nearModel } = await import('../js/treemodels.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode } = await import('../js/geomcodec.js');
const { setStreetCity, JUNCTIONS, CLUSTERS } = await import('../js/geo.js');

const taxon = (id) => TREE_TAXA.findIndex((e) => e?.id === id);
const feat = (rec, id = 4000) => ({ p: [rec], _id: id });
const spec = (rec, id) => S.treeSpec(S.mappedTree(feat(rec, id)), 0, {});

test('a genus is drawn as its class, and the classes Pardubice has all exist', () => {
  const want = { tilia: 'linden', acer: 'maple', aesculus: 'chestnut', platanus: 'plane', betula: 'birch',
    quercus: 'oak', fraxinus: 'ash', robinia: 'robinia', populus: 'poplar', salix: 'willow',
    pinus: 'pine', picea: 'spruce', prunus: 'cherry', malus: 'fruit' };
  for (const [genus, name] of Object.entries(want)) {
    const tx = taxon(genus);
    assert.ok(tx > 2, `${genus} is not in TREE_TAXA`);
    // whatever the id and wherever it stands
    for (let i = 0; i < 40; i++) {
      const s = spec([i * 31.7, i * -12.3, tx], 100 + i * 7);
      assert.equal(S.SPECIES[s.sp].name, name, `${genus} drawn as ${S.SPECIES[s.sp].name}`);
    }
  }
  // every taxon the table holds resolves to a class that can be drawn, or to "pick one"
  for (let tx = 1; tx < TREE_TAXA.length; tx++) {
    const cls = S.taxonClass(tx);
    assert.ok(cls === -1 || (cls >= 0 && cls < S.SPECIES.length && cls !== S.SP.SHRUB), `taxon ${tx}`);
    // a class of its own never changes the LEAF TYPE the tile table promised
    if (cls >= 0) assert.equal(S.isConifer(cls), TREE_TAXA[tx].leaf === 'n', TREE_TAXA[tx].id);
    if (cls === -1) assert.equal(treeClass([0, 0, tx]), -1);
  }
  // the four new classes are real models, not a fallback to the far blob
  for (const sp of [S.SP.ASH, S.SP.ROBINIA, S.SP.WILLOW, S.SP.CHERRY]) {
    assert.ok(nearModel(sp, 0) && nearModel(sp, 1), S.SPECIES[sp].name);
  }
  assert.ok(S.SPECIES.length <= 16, 'the species tag has four bits');
});

test('a leaf type alone narrows the hashed choice', () => {
  const kinds = new Set();
  for (let i = 0; i < 300; i++) {
    const s = spec([i * 23.1, 500 + i * 3.3, 2], 9000 + i);
    assert.ok(S.isConifer(s.sp), `a needleleaved tree drawn as a ${S.SPECIES[s.sp].name}`);
    kinds.add(s.sp);
    const b = spec([i * 23.1, 500 + i * 3.3, 1], 9000 + i);
    assert.ok(!S.isConifer(b.sp) && b.sp !== S.SP.SHRUB, `a broadleaved tree drawn as a ${S.SPECIES[b.sp].name}`);
    // "broadleaved" is what the hashed street mix already was: nothing moves
    assert.deepEqual(b, spec([i * 23.1, 500 + i * 3.3], 9000 + i));
  }
  assert.equal(kinds.size, 2, 'spruce and pine both');
  // a stand of conifers is mostly one kind: 20 trees of one 72 m block
  const row = [];
  for (let i = 0; i < 20; i++) row.push(spec([150 + i * 3.4, 300, 2], 5000 + i).sp);
  const most = Math.max(row.filter((s) => s === S.SP.SPRUCE).length, row.filter((s) => s === S.SP.PINE).length);
  assert.ok(most >= 13, `the commoner conifer is ${most} of 20`);
});

test('surveyed sizes are used, clamped to what a tree can be', () => {
  const lime = taxon('tilia');
  const a = spec([10, 10, lime, 8]);
  assert.equal(a.h, 8);
  // the crown stands on the surveyed height whatever the species (see groundOf)
  const b = S.SPECIES[a.sp].b;
  assert.ok(Math.abs(a.cy + a.ry - 8) < 1e-9 && Math.abs(a.cy - a.ry - 8 * b) < 1e-9);
  // 12 m of crown is a 6 m radius; the height is then still the species' own guess
  const c = spec([10, 10, lime, 0, 12]);
  assert.equal(c.rx, 6);
  assert.ok(c.h >= S.SPECIES[c.sp].h[0] && c.h <= S.SPECIES[c.sp].h[1]);
  // a girth of 2.2 m is a 35 cm radius; a tape that read 22 m is not believed
  const free = spec([10, 10, lime, 14]);
  const g = spec([10, 10, lime, 14, 0, 2.2]);
  assert.ok(Math.abs(g.rt - 2.2 / (2 * Math.PI)) < 1e-9 && g.rt > free.rt);
  assert.ok(spec([10, 10, lime, 14, 0, 22]).rt <= free.rt * 1.6 + 1e-9);
  // typing errors: 150 "m" of lime, a 0.4 m whip, a crown wider than the tree
  assert.ok(spec([10, 10, lime, 150]).h <= 45);
  assert.equal(spec([10, 10, lime, 0.4]).h, 1.8);
  assert.ok(spec([10, 10, lime, 6, 40]).rx <= 6 * 0.75 + 1e-9);
  assert.ok(spec([10, 10, taxon('malus'), 30]).h <= S.SPECIES[S.SP.FRUIT].h[1] * 2);
  // every number that reaches a matrix is finite and positive, whatever the tile holds
  for (const rec of [[1, 2, 999], [1, 2, lime, -5, -3, -1], [1, 2, 0, 'x', null], [1, 2, 3.7, 9]]) {
    const s = spec(rec);
    for (const k of ['h', 'rx', 'ry', 'cy', 'rt', 'ht']) assert.ok(Number.isFinite(s[k]) && s[k] > 0, `${k} of ${JSON.stringify(rec)}`);
    assert.ok(s.sp >= 0 && s.sp < S.SPECIES.length);
  }
});

test('a tree the tile knows nothing about is the tree it always was', () => {
  for (let i = 0; i < 200; i++) {
    const x = i * 7.3 - 900, z = i * 3.1 + 40, id = 77 + i * 13;
    const before = S.treeSpec({ x, z, seed: id, forest: false }, i % 4 ? 0 : 9, {});
    assert.deepEqual(S.treeSpec(S.mappedTree(feat([x, z], id)), i % 4 ? 0 : 9, {}), before);
    assert.deepEqual(S.treeSpec(S.mappedTree(feat([x, z, 0, 0, 0, 0], id)), i % 4 ? 0 : 9, {}), before);
  }
  // the hashed street mix is still the first eleven: a new class is only ever a mapped genus
  const seen = new Set();
  for (let i = 0; i < 4000; i++) {
    seen.add(S.treeSpec({ x: (i % 80) * 13, z: Math.floor(i / 80) * 17, seed: 30000 + i, forest: i % 2 === 0, park: i % 5 === 0 }, 0, {}).sp);
  }
  for (const sp of [S.SP.ASH, S.SP.ROBINIA, S.SP.WILLOW, S.SP.CHERRY]) assert.ok(!seen.has(sp));
});

// ---- the worker ------------------------------------------------------------------
function world() {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const terrain = new Terrain(4800, 20);
  const g = new Int16Array(terrain.n * terrain.n);
  for (let j = 0; j < terrain.n; j++) for (let i = 0; i < terrain.n; i++)
    g[j * terrain.n + i] = Math.round((221 + Math.sin(i * 0.34) * 2.1 + Math.cos(j * 0.22) * 1.4) * 10);
  terrain.grids.set('0,0', g);
  terrain._loads = 1;
  const recs = [
    [20, 20, taxon('tilia'), 9], [28, 20, taxon('tilia'), 9.5, 7], [36, 20, taxon('tilia'), 0, 0, 1.9],
    [20, 40, taxon('picea'), 17], [28, 40, taxon('pinus')], [36, 40, 2], [44, 40, 1, 6],
    [20, 60, taxon('fraxinus'), 21, 11], [28, 60, taxon('robinia')], [36, 60, taxon('salix'), 12, 13],
    [44, 60, taxon('prunus'), 6], [52, 60], [60, 60, taxon('platanus'), 24, 18, 3.1], [68, 60, taxon('betula'), 13],
  ];
  let id = 500;
  const trees = recs.map((r) => ({ p: [r], _id: ++id, _home: '0,0' }));
  const cell = { buildings: [], roads: [], rails: [], trees, water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const mats = makeMaterials();
  mats.terrain = terrain; mats.hidden = new Set();
  return { city, terrain, mats, recs };
}
const batch = (group, mat) => {
  let hit = null;
  group.traverse((o) => { if (o.isInstancedMesh && o.material === mat) hit = o; });
  return hit;
};

test('species and size survive the worker: the same trees from both paths', () => {
  const w = world();
  const sync = buildChunkMeshes(w.city, 0, 0, w.mats, 'full');
  const got = chunkSpec(w, 0, 0, 'full', { terrain: new Map(), canopy: new Map() });
  assert.ok(got, 'chunkSpec refused the cell');
  const posted = structuredClone(got.spec, { transfer: got.transfer });
  const out = buildChunkPayload(makeWorkerState(), posted);
  assert.ok(!out.empty && out.payload, 'the worker built nothing');
  const back = decode(out.payload, { ...w.mats, codecMats: {} });
  const a = batch(sync, w.mats.crown), b = batch(back, w.mats.crown);
  assert.ok(a && b, 'no crown batch');
  assert.equal(a.count, w.recs.length);
  assert.equal(b.count, a.count);
  // The shader stands a trunk under every crown that the template only holds
  // a placeholder of, so the batch's sphere is grown past what three computes
  // (rebase does it, the codec carries it): without that a wood's edge pops
  // out of view a tree early at the side of the screen and in the shadows
  const ref = new THREE.InstancedMesh(a.geometry, a.material, a.count);
  ref.instanceMatrix.copy(a.instanceMatrix);
  ref.computeBoundingSphere();
  assert.ok(a.userData.boundPad >= S.FAR_BOUND_PAD, 'main thread: the pad is under its floor');
  assert.ok(Math.abs(a.boundingSphere.radius - ref.boundingSphere.radius - a.userData.boundPad) < 1e-3, 'main thread: no pad');
  assert.ok(Math.abs(b.boundingSphere.radius - a.boundingSphere.radius) < 0.05, 'worker: the pad was lost');
  assert.equal(b.name, 'trees-far');
  const ma = new THREE.Matrix4(), mb = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Vector3();
  const ca = a.instanceColor.array, cb = b.instanceColor.array;
  const fa = ca instanceof Float32Array ? 255 : 1, fb = cb instanceof Float32Array ? 255 : 1;
  const names = [];
  for (let i = 0; i < a.count; i++) {
    const spA = S.tagSpecies(Math.round(ca[i * 3] * fa), Math.round(ca[i * 3 + 2] * fa));
    const spB = S.tagSpecies(Math.round(cb[i * 3] * fb), Math.round(cb[i * 3 + 2] * fb));
    assert.equal(spB, spA, `tree ${i}: the worker drew a ${S.SPECIES[spB]?.name}, the main thread a ${S.SPECIES[spA].name}`);
    assert.equal(S.tagVariant(Math.round(cb[i * 3 + 1] * fb)), S.tagVariant(Math.round(ca[i * 3 + 1] * fa)));
    names.push(S.SPECIES[spA].name);
    // the crown: the same sphere in the same place (the worker folds the
    // template's quantisation into the matrix, so compare what it DRAWS)
    a.getMatrixAt(i, ma); b.getMatrixAt(i, mb);
    const pa = a.geometry.getAttribute('position'), pb = b.geometry.getAttribute('position');
    for (let v = 0; v < pa.count; v += 5) {
      p.fromBufferAttribute(pa, v).applyMatrix4(ma).applyMatrix4(a.matrixWorld);
      q.fromBufferAttribute(pb, v).applyMatrix4(mb).applyMatrix4(b.matrixWorld);
      assert.ok(p.distanceTo(q) < 0.02, `tree ${i} vertex ${v}: ${(p.distanceTo(q) * 1000).toFixed(1)} mm apart`);
    }
  }
  assert.deepEqual(names.slice(0, 6), ['linden', 'linden', 'linden', 'spruce', 'pine', names[5]]);
  assert.ok(names[5] === 'spruce' || names[5] === 'pine');
  assert.deepEqual(names.slice(7, 11), ['ash', 'robinia', 'willow', 'cherry']);
  assert.deepEqual(names.slice(12), ['plane', 'birch']);
  // and the surveyed plane really is 24 m tall and 18 m across on screen
  a.getMatrixAt(12, ma);
  const e = ma.elements, ry = Math.hypot(e[4], e[5], e[6]), rx = Math.hypot(e[0], e[1], e[2]);
  assert.ok(Math.abs(ry * 2 / (1 - S.SPECIES[S.SP.PLANE].b) - 24) < 1e-3, `plane ${ry} m half height`);
  assert.ok(Math.abs(rx - 9) < 1e-3);
});

test('a genus that borrows a class keeps its own size', () => {
  // a thuja is drawn as a spruce, a hazel as a lime: neither as tall as them
  for (let i = 0; i < 60; i++) {
    const th = spec([i * 9.1, 40, taxon('thuja')], 700 + i), co = spec([i * 9.1, 80, taxon('corylus')], 900 + i);
    assert.equal(th.sp, S.SP.SPRUCE);
    assert.ok(th.h >= 4 && th.h <= 9, `thuja ${th.h.toFixed(1)} m`);
    assert.equal(co.sp, S.SP.LINDEN);
    assert.ok(co.h >= 3 && co.h <= 6, `hazel ${co.h.toFixed(1)} m`);
  }
  // a surveyed height still wins, clamped to twice the genus's own top
  assert.equal(spec([0, 0, taxon('thuja'), 12]).h, 12);
  assert.equal(spec([0, 0, taxon('thuja'), 40]).h, 18);
  // and a lime is still a lime
  const lime = spec([5, 5, taxon('tilia')], 33);
  assert.ok(lime.h >= 11 && lime.h <= 17);
});
