// ---- round 5, engine debts: the same world, paid for in smaller coins --------
// Four pieces of work used to land whole in one frame: the rooms of a building
// the player walked up to (up to 258 ms), its residents (14 to 34 ms), the
// earthworks of a terrain tile (up to 45 ms) and the verges a chunk spec asked
// for first (15 to 50 ms). Each is now taken a few milliseconds a frame. What
// these tests pin is the half that cannot be seen in a frame-time table: that
// the SLICED work is the same work, piece for piece and sample for sample, and
// that the paths which must not wait (a rocket) still do not.
// Also here: the two wordmark caches that never let go of a shop name.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
// a canvas with no 2D context: the wordmark and atlas code already has a plain
// fallback for it, and nothing under test here reads a pixel
globalThis.document ??= { createElement: () => ({ getContext: () => null, width: 0, height: 0 }) };

const THREE = await import('three');
const { buildingPlan, hasInterior } = await import('../js/interiors.js');
const { interiorPieces, interiorPiecesGen, shellPieces } = await import('../js/pieces.js');
const { BuildingModel } = await import('../js/destructible.js');
const { Interiors } = await import('../js/interiorsim.js');
const { CityWorld, conformTerrainTile } = await import('../js/city.js');
const { Terrain } = await import('../js/terrain.js');
const { polylineLength, chunkKey, setStreetCity } = await import('../js/geo.js');
const { brandMarkMat, sweepBrandMats, brandMatCount } = await import('../js/meshes.js');
const { CHUNK, INTERIOR } = await import('../js/config.js');

const pardubice = JSON.parse(readFileSync(new URL('../public/data/pardubice.json', import.meta.url), 'utf8'));
let _id = 1;
for (const b of pardubice.buildings) b._id = _id++;
const withRooms = pardubice.buildings.filter(hasInterior);
const planOf = (f) => { delete f._plan; return buildingPlan(f, [], [], 221); };
// the building with the most rooms to furnish among a spread of the city
const BIG = withRooms.filter((_, i) => i % 9 === 0)
  .map((f) => [interiorPieces(planOf(f)).length, f]).sort((a, b) => b[0] - a[0])[0][1];

// ---- (a) rooms -----------------------------------------------------------------

test('rooms worked out in steps are the rooms worked out at once', () => {
  let checked = 0, steps = 0;
  const other = planOf(withRooms[3]);
  for (let i = 0; i < withRooms.length; i += 131) {
    const plan = planOf(withRooms[i]);
    const whole = JSON.stringify(interiorPieces(plan));
    const gen = interiorPiecesGen(plan);
    let it;
    while (!(it = gen.next()).done) {
      // another building's shell goes up between two steps, as it does in play:
      // it resets the colour-jitter counter the emitters share
      if (steps++ % 2 === 0) shellPieces(other);
    }
    assert.equal(JSON.stringify(it.value), whole, `building ${withRooms[i]._id} came out different in steps`);
    checked++;
  }
  assert.ok(checked >= 40, `only ${checked} buildings compared`);
  assert.ok(steps > checked * 5, 'the generator never paused: nothing was sliced');
});

test('a big building is many small steps, not a few big ones', () => {
  const gen = interiorPiecesGen(planOf(BIG));
  let steps = 0, it;
  while (!(it = gen.next()).done) steps++;
  // a floor slab alone is dozens of rows; one step a storey would be the old bite
  assert.ok(steps >= 60, `${it.value.length} pieces came in only ${steps} steps`);
});

const FX = { debris: { spawn() {} }, dust: { puff() {} } };
function shellModel(f) {
  const plan = planOf(f);
  plan.facades = false;
  const m = new BuildingModel(new THREE.Scene(), f, plan, FX, { shellOnly: true });
  m.addShell();
  return m;
}
const piecesOf = (m) => JSON.stringify(m.pieces.map((p) => [p.x, p.y, p.z, p.hx, p.hy, p.hz, p.yaw, p.col, p.kind, p.k, p.leaf ?? '', p.dead]));

test('a model furnished in steps holds what a model furnished at once holds', () => {
  const a = shellModel(BIG), b = shellModel(BIG);
  a.ensureInterior();
  const gen = b.ensureInteriorGen();
  let steps = 0;
  const gridKeys = b.grid.size;
  while (!gen.next().done) {
    steps++;
    assert.equal(b.interiorBuilt, false, 'the model claimed its rooms before they were in');
    assert.equal(b.pieces.length, b.shellPieces, 'half a floor was added to a standing model');
    assert.equal(b.grid.size, gridKeys, 'the hash knew of pieces the model did not have yet');
  }
  assert.ok(steps > 10);
  assert.equal(b.interiorBuilt, true);
  assert.equal(piecesOf(b), piecesOf(a));
  assert.equal(b.alive, a.alive);
  // ...and finds them the same way: the spatial hash, cell for cell, in order
  assert.equal(JSON.stringify([...b.grid]), JSON.stringify([...a.grid]));
});

test('a rocket does not wait for the steps, and the rooms are not added twice', () => {
  const a = shellModel(BIG), b = shellModel(BIG);
  a.ensureInterior();
  const gen = b.ensureInteriorGen();
  for (let i = 0; i < 5; i++) gen.next();
  b.ensureInterior();                      // what blast() calls
  assert.equal(b.interiorBuilt, true);
  const n = b.pieces.length;
  while (!gen.next().done) { /* the abandoned steps run out */ }
  assert.equal(b.pieces.length, n, 'the queued rooms were added on top of the blast\'s');
  assert.equal(piecesOf(b), piecesOf(a));
});

// ---- (a) the scan asks, the queues build ----------------------------------------

function mkInteriors(f) {
  const cell = { buildings: [f], roads: [], rails: [] };
  f._home = chunkKey(f.o[0][0], f.o[0][1]);
  const city = { chunkIndex: new Map() };
  // the building is listed in every cell its outline touches, as the index does
  for (const [x, z] of f.o) city.chunkIndex.set(chunkKey(x, z), cell);
  const world = { heightAt: () => 221, mats: { facades: false }, _rebuildBuildings() {} };
  const it = new Interiors(new THREE.Scene(), city, world);
  it.spawned = 0;
  // a resident is a skinned citizen, about a millisecond of work: what is under
  // test is WHEN they are made, so the stand-in costs half of one and no more
  it._spawnOccupant = (m) => {
    it.spawned++; it.occupants.push({ model: m });
    for (const t0 = performance.now(); performance.now() - t0 < 0.5;) { /* dressing */ }
  };
  it._occupantStep = () => {};
  let cx = 0, cz = 0;
  for (const [x, z] of f.o) { cx += x / f.o.length; cz += z / f.o.length; }
  return { it, at: { x: cx, z: cz } };
}

test('walking up to a building builds nothing in the frame the scan notices it', () => {
  const { it, at } = mkInteriors(BIG);
  it.update(1 / 60, at, true);
  const m0 = it.models.get(BIG._id);
  assert.ok(!m0?.interiorBuilt, 'the rooms were built inside the scan');
  assert.ok(it._fullJob || it._fullQ?.length, 'the scan did not ask for the rooms either');
  let frames = 1;
  while (!it.models.get(BIG._id)?.interiorBuilt) {
    it.update(1 / 60, at, true);
    assert.ok(++frames < 5000, 'the rooms never arrived');
  }
  assert.ok(frames > 3, `a ${it.models.get(BIG._id).pieces.length}-piece building was furnished in ${frames} frames`);
  const twin = shellModel(BIG);
  twin.ensureInterior();
  assert.equal(it.models.get(BIG._id).pieces.length, twin.pieces.length, 'not the same rooms');
});

test('the residents move in over frames, all of them, and a blast brings them at once', () => {
  const { it, at } = mkInteriors(BIG);
  const want = Math.min(planOf(BIG).occupants, 90);
  assert.ok(want >= 4, 'the fixture building has nobody living in it');
  let frames = 0, perFrameMax = 0;
  while (it.spawned < want) {
    const before = it.spawned;
    it.update(1 / 60, at, true);
    perFrameMax = Math.max(perFrameMax, it.spawned - before);
    assert.ok(++frames < 8000, `only ${it.spawned} of ${want} residents ever arrived`);
  }
  assert.equal(it.spawned, want);
  assert.ok(perFrameMax < want, 'everybody moved in in one frame');
  for (let i = 0; i < 30; i++) it.update(1 / 60, at, true);
  assert.equal(it.spawned, want, 'the queue kept making people');

  // the other door: activate() is what damage() calls, and it may not queue
  const b = mkInteriors(BIG);
  b.it.focus = b.at;
  const m = b.it.activate(BIG);
  assert.equal(m.interiorBuilt, true);
  assert.equal(b.it.spawned, want, 'a blast found the building half empty');
  assert.ok(!b.it._popQ?.length);
});

test('boarding a car stops the furnishing, and coming back finishes it', () => {
  const { it, at } = mkInteriors(BIG);
  it.update(1 / 60, at, true);
  it.update(1 / 60, at, true);
  it.update(1 / 60, at, false);            // in a car now
  assert.ok(!it._fullJob && !it._fullQ?.length, 'rooms were still being built for a driver');
  for (let i = 0; i < 40; i++) it.update(1 / 60, at, false);
  assert.ok(!it.models.get(BIG._id)?.interiorBuilt);
  let frames = 0;
  while (!it.models.get(BIG._id)?.interiorBuilt) { it.update(1 / 60, at, true); assert.ok(++frames < 5000); }
});

// ---- (c) earthworks ----------------------------------------------------------------

const TILE = 4800, RES = 20;
function lumpyTerrain() {
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++)
    g[j * t.n + i] = Math.round(2200 + 8 * Math.sin(i * 0.9) + 6 * Math.sin(j * 1.3));
  t.grids.set('0,0', g);
  return t;
}
function cityWith(roads, extra = {}) {
  let id = 0;
  const chunkIndex = new Map();
  const cellAt = (k) => {
    let c = chunkIndex.get(k);
    if (!c) chunkIndex.set(k, c = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [], crossings: [] });
    return c;
  };
  for (const r of roads) {
    r._id = ++id; r._len = polylineLength(r.p);
    for (let k = 0; k < r.p.length - 1; k++) {
      const [ax, az] = r.p[k], [bx, bz] = r.p[k + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 60);
      for (let s = 0; s <= steps; s++) {
        const c = cellAt(chunkKey(ax + (bx - ax) * (s / steps), az + (bz - az) * (s / steps)));
        if (!c.roads.includes(r)) c.roads.push(r);
      }
    }
  }
  return { chunkIndex, ...extra };
}
const grid = (n = 160) => {
  const roads = [];
  for (let k = 0; k < n; k++) {
    roads.push({ d: 1, t: 'residential', w: 6, p: [[100 + k * 25, 300], [130 + k * 25, 1300], [100 + k * 25, 2300]] });
    if (k % 4 === 0) roads.push({ d: 1, t: 'tertiary', w: 8, p: [[60, 320 + k * 12], [4200, 350 + k * 12]] });
  }
  return roads;
};
function bakingWorld(roads) {
  const terrain = lumpyTerrain(), city = cityWith(roads);
  const w = Object.assign(Object.create(CityWorld.prototype), { terrain, city, dropped: 0 });
  w._dropTileChunks = () => { w.dropped++; };
  return w;
}

test('a tile baked a slice a frame is the tile baked in one bite', () => {
  const whole = lumpyTerrain();
  assert.equal(conformTerrainTile(whole, cityWith(grid()), 0, 0), true);

  const w = bakingWorld(grid());
  const survey = w.terrain.grids.get('0,0').slice();
  w.conformBudgetMs = 1e-6;                // nothing fits: one step a frame
  w._startBake('0,0', 0, 0, null);
  let frames = 1;
  while (w._bake) {
    if (!w._bake.st.applied)
      assert.deepEqual(w.terrain.grids.get('0,0'), survey, 'the grid moved before the stamping was complete');
    w._bakeStep();
    assert.ok(++frames < 100000, 'the bake never finished');
  }
  assert.ok(frames > 40, `the whole tile was baked in ${frames} frames: nothing was paced`);
  assert.deepEqual(w.terrain.grids.get('0,0'), whole.grids.get('0,0'));
  assert.equal(w.terrain._conformed.has('0,0'), true);
  assert.equal(w.terrain._gridVer.get('0,0'), whole._gridVer.get('0,0'));
  assert.equal(w.dropped, 1, 'the chunks over the tile were not asked to rebuild exactly once');
});

test('without a budget (boot, tests) the bake is one bite, as it always was', () => {
  const w = bakingWorld(grid(40));
  w._startBake('0,0', 0, 0, null);
  assert.equal(w._bake, undefined);
  assert.equal(w.terrain._conformed.has('0,0'), true);
  assert.equal(w.dropped, 1);
});

test('a height map landing under a bake drops it before it has written anything', () => {
  const w = bakingWorld(grid());
  const survey = w.terrain.grids.get('0,0').slice();
  w.conformBudgetMs = 1e-6;
  w._startBake('0,0', 0, 0, null);
  for (let i = 0; i < 12; i++) w._bakeStep();
  assert.ok(w._bake && !w._bake.st.applied);
  w.terrain._loads = (w.terrain._loads ?? 0) + 1;      // the levels it read have moved
  w._bakeStep();
  assert.equal(w._bake, null);
  assert.deepEqual(w.terrain.grids.get('0,0'), survey);
  assert.ok(!w.terrain._conformed?.has('0,0'), 'an abandoned bake marked its tile done');
  assert.equal(w.dropped, 0);
});

test('roads that land while a tile is being warmed are stamped into it all the same', () => {
  // The warm-up hands its list of the tile's ways to the bake. A data tile
  // arriving in between (a border road reaching into this tile) is not on it.
  const late = { d: 1, t: 'primary', w: 9, p: [[300, 3000], [2400, 3300], [4500, 3000]] };
  const whole = lumpyTerrain();
  assert.equal(conformTerrainTile(whole, cityWith([...grid(40), { ...late, p: late.p.map((q) => [...q]) }]), 0, 0), true);

  const w = bakingWorld(grid(40));
  w.conformBudgetMs = 1e-6;                // one way a frame
  for (let i = 0; i < 5; i++) assert.equal(w._warmRoads('0,0', 0, 0), false);
  // the tile lands: the index gains the way, then the world is told
  late._id = 9999; late._len = polylineLength(late.p);
  for (let x = 300; x <= 4500; x += 60) {
    const z = x <= 2400 ? 3000 + (x - 300) / 7 : 3300 - (x - 2400) / 7;
    const k = chunkKey(x, z);
    let c = w.city.chunkIndex.get(k);
    if (!c) w.city.chunkIndex.set(k, c = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [], crossings: [] });
    if (!c.roads.includes(late)) c.roads.push(late);
  }
  w._dataLanded({ roads: [late], tx: 0, tz: 0 });
  // what the once-a-second pass does from here on
  let frames = 0;
  while (!w._warmRoads('0,0', 0, 0)) assert.ok(++frames < 100000, 'the warm-up never finished');
  const roads = w._warm?.key === '0,0' ? w._warm.roads : null;
  w._warm = null;
  w._startBake('0,0', 0, 0, roads);
  while (w._bake) w._bakeStep();
  assert.deepEqual(w.terrain.grids.get('0,0'), whole.grids.get('0,0'), 'the late road was left out of the earthworks');
  // a tile that brings no roads (one coming back from slim) does not restart the warm-up
  const w2 = bakingWorld(grid(40));
  w2.conformBudgetMs = 1e-6;
  for (let i = 0; i < 5; i++) w2._warmRoads('0,0', 0, 0);
  const s = w2._warm;
  w2._dataLanded({ roads: [], tx: 0, tz: 0 });
  assert.equal(w2._warm, s);
});

// ---- (c) verges ------------------------------------------------------------------------

test('verges are made ahead of the spec, a few a frame, for the cells round the player', () => {
  const roads = grid(60);
  const city = cityWith(roads);
  setStreetCity(city);
  const w = Object.assign(Object.create(CityWorld.prototype), { city, viewChunks: 2 });
  const fx = Math.floor(900 / CHUNK), fz = Math.floor(900 / CHUNK);

  // no budget (boot, flight, every other test): nothing is made ahead
  w._warmVerges(fx, fz);
  assert.ok(roads.every((r) => r._vg === undefined), 'verges were derived with no budget set');

  w.vergeBudgetMs = 1e-6;                              // one step a frame
  const inRing = new Set();
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++)
    for (const r of city.chunkIndex.get((fx + dx) + ',' + (fz + dz))?.roads ?? []) inRing.add(r);
  assert.ok(inRing.size > 20 && inRing.size < roads.length, 'the fixture does not straddle the ring');
  let frames = 0;
  while (!w._vergeWarm?.done) {
    const before = [...inRing].filter((r) => r._vg !== undefined).length;
    w._warmVerges(fx, fz);
    const after = [...inRing].filter((r) => r._vg !== undefined).length;
    assert.ok(after - before <= 1, 'more than the budget allows in one frame');
    assert.ok(++frames < 5000, 'the warm-up never finished');
  }
  assert.ok(frames >= inRing.size, 'it finished in fewer frames than there were ways');
  for (const r of inRing) assert.notStrictEqual(r._vg, undefined, 'a way in the ring was left for the spec');
  assert.ok(roads.some((r) => r._vg === undefined), 'ways far outside the ring were derived too');

  // a new cell under the player starts the walk again; the same one does not
  const s = w._vergeWarm;
  w._warmVerges(fx, fz);
  assert.equal(w._vergeWarm, s);
  w._warmVerges(fx + 1, fz);
  assert.notEqual(w._vergeWarm, s);
  setStreetCity(null);
});

test('a cell is not warmed while the data tile its verges read is still on the way', () => {
  const roads = grid(20);
  const tiles = [{ tx: 0, tz: 0, state: 1 }];
  const city = cityWith(roads, { tile: TILE, manifestTiles: tiles });
  setStreetCity(city);
  const w = Object.assign(Object.create(CityWorld.prototype), { city, viewChunks: 2, vergeBudgetMs: 50 });
  const fx = Math.floor(400 / CHUNK), fz = Math.floor(900 / CHUNK);
  w._warmVerges(fx, fz);
  assert.ok(roads.every((r) => r._vg === undefined), 'a verge was derived before its houses were indexed');
  tiles[0].state = 2;
  w._vergeWarm = null;                    // what the tile-arrival handler does
  while (!w._vergeWarm?.done) w._warmVerges(fx, fz);
  assert.ok(roads.some((r) => r._vg !== undefined));
  setStreetCity(null);
});

test('a verge worked out in steps, with other streets derived between them, is the verge worked out at once', async () => {
  // Real streets and real houses (the synthetic grid above has no buildings, so
  // every verge there is null and the segment loop never runs). Between two
  // steps of one way ANOTHER way is derived whole, as a chunk spec or a wheel
  // does in play: that refills the scratch lists the paused way was reading.
  const { computeVerge, computeVergeGen } = await import('../js/streets.js');
  const VG_DS = 2.5;                        // js/streets.js: station spacing along a way
  const near = (x, z) => x > 900 && x < 2100 && z > -1300 && z < -200;
  const roads = pardubice.roads.filter((r) => r.p.some(([x, z]) => near(x, z)))
    .map((r) => ({ ...r, p: r.p.map((q) => [q[0], q[1]]) }));
  const city = cityWith(roads);
  for (const b of pardubice.buildings) {
    if (!b.o || !near(b.o[0][0], b.o[0][1])) continue;
    const c = city.chunkIndex.get(chunkKey(b.o[0][0], b.o[0][1]));
    if (c) c.buildings.push(b);
  }
  const vgOf = (v) => v && JSON.stringify([v.n, [...v.u], [...v.w[0]], [...v.w[1]], [...v.t[0]], [...v.t[1]], [...v.d[0]], [...v.d[1]]]);
  const kerbed = roads.filter((r) => r.d && r._len >= 8);
  let made = 0, paused = 0, inside = 0;
  for (let i = 0; i < kerbed.length; i++) {
    const r = kerbed[i], other = kerbed[(i * 7 + 3) % kerbed.length];
    const de0 = r._de0, de1 = r._de1;
    const whole = vgOf(computeVerge(city, r));
    const ends = [r._de0, r._de1];
    r._vg = undefined; r._de0 = de0; r._de1 = de1;
    const gen = computeVergeGen(city, r);
    let it, steps = 0;
    while (!(it = gen.next()).done) { steps++; if (other !== r) computeVerge(city, other); }
    assert.equal(vgOf(it.value), whole, `way ${r._id} (${r.t}, ${Math.round(r._len)} m) came out different in steps`);
    assert.deepEqual([r._de0, r._de1], ends, 'the dead-end marks came out different in steps');
    assert.equal(r._vg, undefined, 'the stepped derivation published its own answer');
    if (it.value) made++;
    paused += steps;
    // the pauses there would be without the one inside a straight: one a
    // segment at most, and one every sixteenth built-up question
    const n = Math.max(2, Math.ceil(r._len / VG_DS) + 1);
    let asks = 0;
    for (let k = 0; k < n; k += 4) if ((k & 63) === 60) asks++;
    if (steps > r.p.length - 1 + asks) inside++;
  }
  assert.ok(made >= 100, `only ${made} of ${kerbed.length} ways have a verge: the fixture is not a town`);
  assert.ok(paused > made, 'the derivation never paused');
  assert.ok(inside > 0, 'no way paused inside a long straight: that pause is untested');
});

// ---- (b) wordmarks ------------------------------------------------------------------------

test('a shop name nothing wears for two sweeps gives its board back', () => {
  const n0 = brandMatCount();
  const a = brandMarkMat({ label: 'Test Potraviny A', sign: 0xcc0000 });
  const b = brandMarkMat({ label: 'Test Potraviny B', sign: 0x0000cc });
  assert.equal(brandMatCount(), n0 + 2);
  assert.equal(brandMarkMat({ label: 'Test Potraviny A', sign: 0xcc0000 }), a, 'the cache is not a cache');
  const worn = new Set([a]);
  assert.equal(sweepBrandMats(worn), null, 'a board was freed the first time it was seen idle');
  // worn again in between: its count starts over
  assert.equal(sweepBrandMats(new Set([a, b])), null);
  assert.equal(sweepBrandMats(worn), null);
  const gone = sweepBrandMats(worn);
  assert.deepEqual(gone, [b]);
  assert.equal(brandMatCount(), n0 + 1);
  assert.notEqual(brandMarkMat({ label: 'Test Potraviny B', sign: 0x0000cc }), b, 'a freed board was handed out again');
  sweepBrandMats(new Set()); sweepBrandMats(new Set());      // leave the cache as it was found
});

test('the streamer forgets a freed wordmark, and keeps the ones on built chunks', () => {
  const a = brandMarkMat({ label: 'Test Lahůdky A', sign: 0x118833 });
  const b = brandMarkMat({ label: 'Test Lahůdky B', sign: 0x883311 });
  a.map = { dispose() { a.freed = true; } };          // as a real board: a canvas texture
  b.map = { dispose() { b.freed = true; } };
  const group = new THREE.Group();
  group.add(new THREE.Mesh(new THREE.BufferGeometry(), a));
  const w = Object.assign(Object.create(CityWorld.prototype), {
    built: new Map([['0,0', group], ['0,1', null]]), _detail: new Map([['0,0', 'full']]),
    interiors: { models: new Map() }, mats: { codecMats: { 'brand:a': a, 'brand:b': b, ortho: {} } },
  });
  w._sweepMarks();
  assert.ok(w.mats.codecMats['brand:b'], 'forgotten after one idle sweep');
  w._sweepMarks();
  assert.equal(w.mats.codecMats['brand:b'], undefined);
  assert.equal(b.freed, true);
  assert.equal(w.mats.codecMats['brand:a'], a);
  assert.ok(!a.freed, 'the board on a built chunk lost its texture');
  assert.ok(w.mats.codecMats.ortho, 'the sweep took something that is not a wordmark');
  w.built.clear();
  w._sweepMarks(); w._sweepMarks();
});
