// ---- round 5 phase 2, engine debts: the same world, second pass ---------------
// What these pin is that each cheaper path is the SAME work as the one it
// replaced: the meshes of a building furnished in steps, a chunk spec whose
// coordinates travel as numbers, and the tile index a power line is filed in.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
globalThis.document ??= { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };

const THREE = await import('three');
const { buildingPlan, hasInterior } = await import('../js/interiors.js');
const { interiorPieces } = await import('../js/pieces.js');
const { BuildingModel } = await import('../js/destructible.js');

const pardubice = JSON.parse(readFileSync(new URL('../public/data/pardubice.json', import.meta.url), 'utf8'));
let _id = 1;
for (const b of pardubice.buildings) b._id = _id++;
const withRooms = pardubice.buildings.filter(hasInterior);
const planOf = (f) => { delete f._plan; return buildingPlan(f, [], [], 221); };
const BIG = withRooms.filter((_, i) => i % 9 === 0)
  .map((f) => [interiorPieces(planOf(f)).length, f]).sort((a, b) => b[0] - a[0])[0][1];

const FX = { debris: { spawn() {} }, dust: { puff() {} } };
function shellModel(f) {
  const plan = planOf(f);
  plan.facades = false;
  const m = new BuildingModel(new THREE.Scene(), f, plan, FX, { shellOnly: true });
  m.addShell();
  return m;
}
/** Everything a model hands the GPU: per mesh, its count and its buffers. */
function buffersOf(m) {
  const out = [];
  m.group.traverse((o) => {
    if (!o.isInstancedMesh) return;
    const n = o.count;
    const row = [o.material.uuid ? o.material.type : '', n,
      Array.from(o.instanceMatrix.array.subarray(0, n * 16)).join(','),
      o.instanceColor ? Array.from(o.instanceColor.array.subarray(0, n * 3)).join(',') : ''];
    for (const a of ['aUvRect', 'aLit']) {
      const at = o.geometry.getAttribute(a);
      if (at) row.push(a + ':' + Array.from(at.array.subarray(0, n * 4)).join(','));
    }
    out.push(row.join('|'));
  });
  return out;
}

test('a building furnished in steps hands the GPU what one furnished at once does', () => {
  const a = shellModel(BIG), b = shellModel(BIG);
  a.ensureInterior();
  const before = b.group.children.slice();
  const gen = b.ensureInteriorGen();
  let steps = 0, it;
  while (!(it = gen.next()).done) {
    steps++;
    // the shell keeps standing, untouched, until the swap
    assert.deepEqual(b.group.children, before, 'the meshes changed before the rooms were in');
  }
  assert.ok(steps > 20);
  assert.ok(b.pieces.length > 8000, `the fixture is too small to matter (${b.pieces.length})`);
  assert.deepEqual(buffersOf(b), buffersOf(a));
  assert.equal(b._dirty, false);
});

test('the mesh steps are small: no step writes more than a thousand pieces', () => {
  const b = shellModel(BIG);
  let writes = 0, worst = 0;
  const fill = b._fill;
  b._fill = function (...x) { writes++; return fill.apply(this, x); };
  const gen = b.ensureInteriorGen();
  while (!gen.next().done) { if (writes > worst) worst = writes; writes = 0; }
  assert.ok(worst <= 1024, `${worst} pieces written in one step`);
});

/** Counts the steps taken since the model began filling its new meshes. */
function meshStepsOf(m) {
  const at = { n: -1 };
  const ms = m._meshSet, fill = m._fill;
  m._meshSet = function (...x) { at.n = 0; return ms.apply(this, x); };
  let last = -1;
  m._fill = function (...x) { if (at.n >= 0 && cnt !== last) { last = cnt; at.n++; } return fill.apply(this, x); };
  let cnt = 0;
  const gen0 = m.ensureInteriorGen.bind(m);
  m.ensureInteriorGen = function* () { const g = gen0(); let it; while (!(it = g.next()).done) { cnt++; yield; } return it.value; };
  return at;
}

test('a piece lost between two mesh steps is not drawn standing', () => {
  const a = shellModel(BIG), b = shellModel(BIG);
  a.ensureInterior();
  const fillAt = meshStepsOf(b);
  const gen = b.ensureInteriorGen();
  let steps = 0, killed = -1;
  while (!gen.next().done) {
    // half way through the mesh fill, a wall piece of the shell goes (as a
    // collapse would mark it), and the model is synced as damage does
    if (fillAt.n === 4 && killed < 0) {
      killed = b.pieces.findIndex((p) => !p.dead);
      b.pieces[killed].dead = true; b.alive--; b._dirty = true; b.sync();
    }
  }
  assert.ok(killed >= 0, 'the fixture never reached the mesh steps');
  a.pieces[killed].dead = true; a.alive--; a._dirty = true; a.sync();
  assert.deepEqual(buffersOf(b), buffersOf(a));
});

test('a rocket during the mesh steps leaves one set of meshes, the blast\'s', () => {
  const a = shellModel(BIG), b = shellModel(BIG);
  a.ensureInterior();
  const fillAt = meshStepsOf(b);
  const gen = b.ensureInteriorGen();
  while (fillAt.n < 4) assert.equal(gen.next().done, false);
  b.ensureInterior();                      // what blast() calls
  while (!gen.next().done) { /* the abandoned steps run out */ }
  assert.deepEqual(buffersOf(b), buffersOf(a));
  assert.equal(b.group.children.length, a.group.children.length);
});

// ---- chunk specs: coordinates travel as numbers -----------------------------

const { chunkSpec, applySpec } = await import('../js/chunkspec.js');

test('a spec\'s point lists come back from the worker as the same nested arrays', () => {
  const shared = [30, 40];                          // one point two features both hold
  const road = { _id: 1, _home: '0,0', t: 'residential', w: 6,
    p: [[10, 10], [50, 12.25], [110, 60.000001], [119.5, 119.5]] };
  const house = { _id: 2, _home: '0,0', h: 9, o: [[20, 20], [40, 20], [40, 35], [20, 35]],
    i: [[[25, 25], [30, 25], [30, 30]]] };
  const wall = { _id: 3, _home: '0,0', p: [[60, 60, 1.5], [70, 61, 1.5], [80, 63, 2]] };
  const sign = { _id: 4, _home: '0,0', p: [shared], k: 'stop' };
  const crossing = { _id: 5, _home: '0,0', p: [shared, [31, 41]] };
  const cell = { buildings: [house], roads: [road], rails: [], water: [], green: [], paved: [],
    trees: [], signs: [sign], crossings: [crossing], power: [], furniture: [], calming: [],
    barriers: [wall], venues: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), pois: [], waterways: [] };
  const world = { city, terrain: null, canopy: null, ground: null, mats: { hidden: new Set() } };
  const got = chunkSpec(world, 0, 0, 'full', null);
  assert.ok(got.spec.pts instanceof Float64Array && got.spec.pts.length > 0, 'nothing was packed');
  assert.ok(got.transfer.includes(got.spec.pts.buffer), 'the packed points are not transferred');
  const back = applySpec(structuredClone(got.spec, { transfer: got.transfer }), { terrain: null, canopy: null });
  const c = back.city.chunkIndex.get('0,0');
  assert.deepEqual(c.roads[0].p, road.p);
  assert.deepEqual(c.buildings[0].o, house.o);
  assert.deepEqual(c.buildings[0].i, house.i);
  assert.deepEqual(c.barriers[0].p, wall.p);
  assert.deepEqual(c.signs[0].p, [[30, 40]]);
  assert.deepEqual(c.crossings[0].p, [[30, 40], [31, 41]]);
  // a point reached on its own BEFORE any list holding it keeps its identity
  assert.equal(c.signs[0].p[0], c.crossings[0].p[0], 'a shared point was split in two');
  for (const list of [c.roads[0].p, c.buildings[0].o, c.barriers[0].p])
    for (const pt of list) assert.ok(Array.isArray(pt), 'a point came back as something else');
});

test('a spec still names the path to a value that cannot cross', () => {
  const road = { _id: 1, _home: '0,0', p: [[10, 10], [50, 12]], _surprise: { deep: [{ re: /x/ }] } };
  const cell = { buildings: [], roads: [road], rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [], power: [], furniture: [], calming: [], barriers: [] };
  const world = { city: { chunkIndex: new Map([['0,0', cell]]), pois: [], waterways: [] },
    terrain: null, canopy: null, ground: null, mats: { hidden: new Set() } };
  assert.throws(() => chunkSpec(world, 0, 0, 'full', null),
    /cell 0,0\.roads\[0\]\._surprise\.deep\[0\]\.re is a RegExp/);
});

// ---- the tile index: a power line is filed where it stands ------------------

const { loadCity, chunkKey: ck } = await import('../js/geo.js');
const { CHUNK } = await import('../js/config.js');

test('a power line is filed in the cells its towers and spans are drawn in, and a tile owns its cells', async () => {
  // 400 kV across the whole tile on a diagonal: by its bounding box it was in
  // every one of the 1 600 cells, and in every cell of the box past the tile
  const line = { v: 400000, p: [] };
  for (let i = 0; i <= 40; i++) line.p.push([-200 + i * 130, -300 + i * 127]);
  const files = {
    'm.json': { origin: [50, 15], mPerLat: 111000, mPerLon: 71000, tile: 4800,
      tiles: [{ tx: 0, tz: 0, f: 't.json' }] },
    't.json': { buildings: [], roads: [], power: [line] },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => structuredClone(files[u]) });
  globalThis.requestAnimationFrame ??= (cb) => setTimeout(() => cb(0), 0);
  try {
    const city = await loadCity('m.json');
    await city.ensureTiles(2400, 2400);
    const p = city.power[0].p;
    const want = new Set();
    for (let i = 0; i < p.length; i++) {
      want.add(ck(p[i][0], p[i][1]));
      if (i) want.add(ck((p[i - 1][0] + p[i][0]) / 2, (p[i - 1][1] + p[i][1]) / 2));
    }
    const filed = new Set();
    for (const [k, c] of city.chunkIndex) if (c.power.length) {
      assert.equal(c.power.length, 1, `the line is filed ${c.power.length} times in ${k}`);
      filed.add(k);
    }
    assert.deepEqual([...filed].sort(), [...want].sort());
    // every cell of the loaded tile exists (a chunk with no cell is not meshed)
    for (let cx = 0; cx < 4800 / CHUNK; cx++) for (let cz = 0; cz < 4800 / CHUNK; cz++)
      assert.ok(city.chunkIndex.has(cx + ',' + cz), `cell ${cx},${cz} of the loaded tile is missing`);
    // ...and nothing beyond it was made for the line's box alone
    assert.ok(!city.chunkIndex.has('-2,-2') || want.has('-2,-2'));
    assert.ok(city.chunkIndex.size < 1600 + 20, `${city.chunkIndex.size} cells for one tile`);
    // an unused list is the one shared frozen array: nothing may push into it
    const empty = city.chunkIndex.get('39,0');
    assert.ok(Object.isFrozen(empty.buildings));
  } finally { globalThis.fetch = realFetch; }
});

// ---- a bridge deck is the same whichever came first, the deck or the bake -----

const { Terrain } = await import('../js/terrain.js');
const { conformTerrainTile } = await import('../js/city.js');
const { bridgeDeckHeight, polylineLength } = await import('../js/geo.js');

function bridgeTown() {
  const t = new Terrain(4800, 20);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++)
    g[j * t.n + i] = Math.round(2200 + 60 * Math.exp(-((((i * 20) - 600) / 40) ** 2)));   // a knoll at x = 600
  t.grids.set('0,0', g);
  t._loads = 1;
  // a street the bake shapes the ground for, and a footbridge across it
  const street = { _id: 1, d: 1, t: 'primary', w: 9, p: [[200, 600], [1000, 600]] };
  const deck = { _id: 2, br: 1, t: 'footway', w: 3, p: [[600, 588], [600, 612]] };
  const chunkIndex = new Map();
  for (const r of [street, deck]) {
    r._len = polylineLength(r.p);
    r._home = ck(r.p[0][0], r.p[0][1]);
    for (let x = Math.min(...r.p.map((q) => q[0])); x <= Math.max(...r.p.map((q) => q[0])); x += 30)
      for (let z = Math.min(...r.p.map((q) => q[1])); z <= Math.max(...r.p.map((q) => q[1])); z += 30) {
        const k = ck(x, z);
        let c = chunkIndex.get(k);
        if (!c) chunkIndex.set(k, c = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
        if (!c.roads.includes(r)) c.roads.push(r);
      }
  }
  return { t, deck, city: { chunkIndex } };
}
const deckLine = (deck, t) => [0, 4, 8, 12, 16, 20, 24].map((s) => bridgeDeckHeight(deck, s, t).toFixed(4)).join(' ');

test('a deck worked out before the earthworks is forgotten by them, and comes out as if after', () => {
  const after = bridgeTown();
  conformTerrainTile(after.t, after.city, 0, 0);
  const want = deckLine(after.deck, after.t);

  const before = bridgeTown();
  const early = deckLine(before.deck, before.t);    // meshed first: a deck over the survey
  const st = {};
  assert.equal(conformTerrainTile(before.t, before.city, 0, 0, st), true);
  assert.ok(st.decks?.has(before.deck._home), 'the bake did not name the deck\'s home cell to mesh again');
  assert.equal(before.deck._bridgeProfile, null, 'the deck kept the level it had over the survey');
  assert.equal(deckLine(before.deck, before.t), want);
  assert.notEqual(early, want, 'the fixture is flat: the bake moved nothing under the deck');
});

// ---- boot: the reveal waits for every tile in view -----------------------------

const { CityWorld } = await import('../js/city.js');

test('the reveal waits for every tile under the window, and only those', () => {
  const t = new Terrain(4800, 20);
  for (const k of ['0,-1', '-1,-1', '0,0', '-1,0', '0,-2', '1,-1'])
    t.grids.set(k, new Int16Array(t.n * t.n).fill(2210));
  t.ready = () => true;
  const w = Object.assign(Object.create(CityWorld.prototype), { city: { tile: 4800 }, terrain: t,
    viewChunks: 4, shellChunks: 0, farChunks: 0, built: new Map(), _guessDropWanted: false });
  const spawn = { x: 25, z: -122 };
  // the spawn stands 25 m from a corner: four tiles in view, the next ones not
  const inView = [...t.grids.keys()].filter((k) => w._tileInView(...k.split(',').map(Number), spawn)).sort();
  assert.deepEqual(inView, ['-1,-1', '-1,0', '0,-1', '0,0']);
  for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) w.built.set((dx + 0) + ',' + (dz - 2), {});
  t._conformed = new Set(['0,-1']);
  assert.equal(w.readyFull(spawn), false, 'revealed with three tiles in view still to be shaped');
  t._conformed = new Set(['0,-1', '-1,-1', '0,0']);
  t._conformTried = new Map([['-1,0', t._loads ?? 0]]);   // a rim tile that cannot be final
  assert.equal(w.readyFull(spawn), true, 'the tiles out of view held the reveal');
});
