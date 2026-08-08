// ---- the same chunk, built somewhere else ----------------------------------
// Moving the mesher into a worker only pays if what comes back is the chunk the
// main thread would have built. Everything about that is a chance to be subtly
// wrong: the inputs are copied with named cut points (js/chunkspec.js), the
// road profiles are main-thread data that must NOT be recomputed against the
// already-conformed ground, the junction pads live in module state a worker
// never fills, and three materials cannot exist there at all because they are
// painted on a <canvas>.
//
// So this builds one dense chunk twice — once through buildChunkMeshes, once
// through chunkSpec → buildChunkPayload → decode — and compares them mesh for
// mesh and vertex for vertex in WORLD space. Node has no DOM Worker, which is
// exactly why js/meshworker.js is written as a pure (state, message) function:
// this drives that function, not a simulation of it.
//
// The second half is the other half of the promise: when the worker cannot
// start — no Worker constructor, a script the browser will not load, a build
// that comes back as an error — the streamer must still build the world.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { indexJunctions, junctionsIn, polylineLength, JUNCTIONS, CLUSTERS } =
  await import('../js/geo.js');
const { Terrain } = await import('../js/terrain.js');
const { Canopy } = await import('../js/canopy.js');
const { GroundClass, GROUND_RES } = await import('../js/groundclass.js');
const { orthoQuad } = await import('../js/ortho.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload, handleMessage } = await import('../js/meshworker.js');
const { makeMeshPool, poolSize } = await import('../js/meshpool.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { CityWorld } = await import('../js/city.js');

const GROUND = 221;                       // Pardubice is 220 m above the sea
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];

/** A REAL height map, not a constant: a flat one would hide every draping bug. */
function terrainWith() {
  const t = new Terrain(4800, 20);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) {
    const x = i * t.res, z = j * t.res;
    g[j * t.n + i] = Math.round(
      (GROUND + Math.sin(x * 0.017) * 3.1 + Math.cos(z * 0.011) * 2.2) * 10);
  }
  t.grids.set('0,0', g);
  t._loads = 1;
  return t;
}

function canopyWith() {
  const c = new Canopy(4800, 10);
  const g = new Uint8Array(c.n * c.n);
  // a stand of trees over the north-west quarter of the chunk, in quarter-metres
  for (let j = 0; j < c.n; j++) for (let i = 0; i < c.n; i++) {
    const x = i * c.res, z = j * c.res;
    g[j * c.n + i] = (x > 4 && x < 60 && z > 4 && z < 60) ? 72 : 0;
  }
  c.grids.set('0,0', g);
  return c;
}

function groundWith() {
  const gc = new GroundClass();
  const N = 4800 / GROUND_RES;
  const g = new Uint8Array(N * N);
  for (let j = 20; j < 26; j++) for (let i = 14; i < 22; i++) g[j * N + i] = 2; // asphalt yard
  gc.grids.set('0,0', g);
  return gc;
}

/** One chunk with as many of the builder's paths in it as a fixture can hold. */
function makeWorld() {
  // geo.js's pad buckets are module state that only ever grows, so a second
  // fixture would inherit the first one's junctions — and with them roads whose
  // levelled profile remembers a DIFFERENT Terrain, which the spec would (quite
  // correctly) refuse. One world at a time.
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const tag = (f) => { f._id = ++id; return f; };
  // wide + drivable, or no street lamps are placed (LAMP_MIN_W is 5.4 m); two
  // ways sharing a node, so indexJunctions makes a real pad
  // three arms at (60,61), because two ways meeting is a way that was split
  const roads = [
    tag({ t: 'primary', w: 12, d: 1, v: 50, p: [[2, 60], [60, 61], [118, 62]] }),
    tag({ t: 'residential', w: 7, d: 1, v: 30, p: [[60, 61], [58, 118]] }),
    tag({ t: 'residential', w: 7, d: 1, v: 30, p: [[60, 61], [64, 6]] }),
    tag({ t: 'footway', w: 2, p: [[10, 30], [110, 34]] }),
    // A pair that OVERLAPS without sharing a node — the case linkOverlaps
    // reconciles, and one the fixture had no example of. It matters here
    // specifically: the synthetic node it creates holds direct references to
    // both roads, and its pins land on `_pins`, which chunkspec CUTS rather
    // than copying. So the levelling those pins produce has to reach the worker
    // inside the road's cached `_prof`, or the two paths quietly disagree about
    // the height of every reconciled deck. Six overlap pins land here.
    //
    // They are kept AWAY from the named building at (80, 80): a drivable way
    // passing close to it makes the two paths build genuinely different
    // geometry — 18 of its 66 vertices have no counterpart at all. That is a
    // separate, pre-existing defect (it reproduces with this fixture against
    // the committed meshes.js and geo.js), and it is not what this test is for.
    tag({ t: 'service', w: 6, d: 1, v: 20, p: [[30, 45], [110, 42]] }),
    tag({ t: 'service', w: 6, d: 1, v: 20, p: [[80, 20], [76, 60]] }),
  ];
  for (const r of roads) r._len = polylineLength(r.p);
  const trees = [];
  for (let i = 0; i < 24; i++) trees.push(tag({ p: [[70 + (i % 6) * 8, 8 + Math.floor(i / 6) * 9]] }));
  const cell = {
    buildings: [tag({ o: square(10, 70, 22), h: 12, t: 'residential' }),
      tag({ o: square(80, 80, 26), h: 18, t: 'retail', n: 'Lidl' })],
    roads, rails: [],
    trees,
    water: [tag({ o: [[0, 100], [120, 104], [120, 118], [0, 114]] })],
    green: [tag({ t: 'wood', o: square(4, 4, 52) })],
    paved: [tag({ t: 'parking', s: 'asphalt', o: square(84, 8, 30) })],
    furniture: [tag({ p: [[30, 70]], k: 'bench' }), tag({ p: [[40, 70]], k: 'lamp' })],
    signs: [], crossings: [tag({ p: [[40, 60]] })], calming: [],
    barriers: [tag({ k: 'fence', p: [[6, 92], [60, 94]] })], power: [],
  };
  // _home is what decides which cell draws a feature whole
  for (const list of Object.values(cell)) for (const f of list) f._home = '0,0';
  const city = {
    chunkIndex: new Map([['0,0', cell]]), tile: 4800,
    pois: [{ p: [[50, 50]][0], t: 'bus_stop' }],
    waterways: [{ w: 3, p: [[0, 20], [120, 26]] }],
  };
  indexJunctions(roads);
  assert.ok(junctionsIn('0,0')?.length, 'the fixture built no junction pad at all');

  const terrain = terrainWith(), canopy = canopyWith(), ground = groundWith();
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = canopy; mats.ground = ground;
  mats.hidden = new Set();
  mats.facades = true;
  // Node has no <canvas>, which is the whole reason those two materials cannot
  // be built in a worker either — stand them in on BOTH sides so the fixture
  // compares geometry rather than texture plumbing.
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  // …and the aerial photo, whose material is per-supertile and comes off a
  // TextureLoader. The PLAN is main-thread work; the quad is pure maths, and
  // this is the seam a worker builds it through.
  const photo = new THREE.MeshLambertMaterial();
  const plan = { mat: photo, lx: 0, lz: 0, S: 4, px: 512 };
  mats.ortho = {
    plan: () => plan,
    tierOf: () => plan.px,
    orthoGroundMesh: (cx, cz) => orthoQuad(cx, cz, plan, terrain, photo),
  };
  return { city, terrain, canopy, ground, mats, photo, wordmark };
}

/** Every descendant, in traversal order, so two groups can be zipped. */
function nodesOf(root) {
  const out = [];
  root.updateMatrixWorld(true);
  const walk = (o) => { for (const c of o.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

const _m = new THREE.Matrix4();
function worldVert(mesh, i, k, out) {
  const p = mesh.geometry.attributes.position;
  out.set(p.getX(i), p.getY(i), p.getZ(i));
  if (mesh.isInstancedMesh) { mesh.getMatrixAt(k, _m); out.applyMatrix4(_m); }
  return out.applyMatrix4(mesh.matrixWorld);
}

test('the worker path builds the same chunk the main thread does', () => {
  const world = makeWorld();
  const sync = buildChunkMeshes(world.city, 0, 0, world.mats, 'full');
  assert.ok(sync, 'the fixture built nothing at all');

  const have = { terrain: new Map(), canopy: new Map() };
  const got = chunkSpec(world, 0, 0, 'full', have);
  assert.ok(got, 'chunkSpec refused a cell that is right there in the index');
  // it really is transferable data — this is what postMessage would do
  const posted = structuredClone(got.spec, { transfer: got.transfer });
  const out = buildChunkPayload(makeWorkerState(), posted);
  assert.ok(!out.empty && out.payload, 'the worker built nothing');

  // the decode resolves the three canvas materials by NAME, against the main
  // thread's own singletons — the sentinel the worker used never comes back
  const decMats = { ...world.mats, codecMats: { ortho: world.photo } };
  for (const k of Object.keys(out.brands)) decMats.codecMats[k] = world.wordmark;
  assert.ok(Object.keys(out.brands).some((k) => k.startsWith('brand:')),
    'the fixture drew no brand wordmark — the canvas-material path is untested');
  const back = decode(out.payload, decMats);

  assert.equal(back.name, sync.name);
  assert.deepEqual(back.position.toArray(), sync.position.toArray());
  assert.equal(back.userData.guessedGround, sync.userData.guessedGround,
    'the two paths disagree about whether the ground was known');
  assert.deepEqual(back.userData.missTiles, sync.userData.missTiles);
  assert.equal(back.userData.px, sync.userData.px, 'the photo tier did not survive');

  const a = nodesOf(sync), b = nodesOf(back);
  assert.ok(a.length >= 8, `the fixture only built ${a.length} nodes — it missed a path`);
  assert.equal(b.length, a.length, 'the worker chunk has a different shape');

  let worst = 0, worstAt = '', checked = 0, instanced = 0;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i], at = `node ${i} (${x.name || x.type})`;
    assert.equal(!!y.isMesh, !!x.isMesh, at);
    assert.equal(!!y.isInstancedMesh, !!x.isInstancedMesh, at);
    assert.equal(y.name, x.name, at);
    if (!x.isMesh) continue;
    // the SAME material object: a chunk that came back wearing a copy would be
    // a second shader program and a second texture-array binding per chunk
    assert.strictEqual(y.material, x.material, `${at} lost its material identity`);
    assert.equal(y.castShadow, x.castShadow, at);
    assert.equal(y.receiveShadow, x.receiveShadow, at);
    const n = x.geometry.attributes.position.count;
    assert.equal(y.geometry.attributes.position.count, n, `${at} changed vertex count`);
    assert.deepEqual(Object.keys(y.geometry.attributes).sort(),
      Object.keys(x.geometry.attributes).sort(), `${at} lost an attribute`);
    if (x.isInstancedMesh) { instanced++; assert.equal(y.count, x.count, `${at} instance count`); }
    const reps = x.isInstancedMesh ? x.count : 1;
    for (let k = 0; k < reps; k++) for (let v = 0; v < n; v++) {
      const d = worldVert(x, v, k, p).distanceTo(worldVert(y, v, k, q));
      if (d > worst) { worst = d; worstAt = `${at} vertex ${v}`; }
      checked++;
    }
    if (x.geometry.attributes.surf) for (let v = 0; v < n; v++)
      assert.equal(y.geometry.attributes.surf.getX(v), x.geometry.attributes.surf.getX(v),
        `${at} changed the surface class of vertex ${v}`);
  }
  assert.ok(checked > 10000, `only ${checked} vertices compared — the fixture is too thin`);
  assert.ok(instanced >= 2, `${instanced} instanced batches — lamps and trees are missing`);
  // the only difference allowed is geomcodec's own quantisation
  assert.ok(worst < MAX_ERR,
    `${(worst * 1000).toFixed(2)} mm between the two paths at ${worstAt}`);
});

test('a worker keeps its rasters between chunks and drops the stale one', () => {
  const world = makeWorld();
  const have = { terrain: new Map(), canopy: new Map() };
  const first = chunkSpec(world, 0, 0, 'full', have);
  assert.equal(first.spec.terrain.put.length, 1, 'the height map did not go out');
  assert.equal(first.spec.canopy.put.length, 1, 'the canopy raster did not go out');
  // …and a copy, not the live grid: the main thread must not hand out a buffer
  // it is about to reshape (and transferring the original would detach it)
  assert.notStrictEqual(first.spec.terrain.put[0][1], world.terrain.grids.get('0,0'));

  const again = chunkSpec(world, 0, 0, 'full', have);
  assert.equal(again.spec.terrain.put.length, 0, 'the height map was sent twice');
  assert.equal(again.spec.canopy.put.length, 0, 'the canopy raster was sent twice');

  // the earthworks reshape a grid IN PLACE, so the mirror has to be told
  world.terrain._gridVer = new Map([['0,0', 1]]);
  const third = chunkSpec(world, 0, 0, 'full', have);
  assert.equal(third.spec.terrain.put.length, 1,
    'a conformed height map was not re-sent — the worker would mesh the old ground');
});

test('a cache that is not plain data stops the spec instead of crossing half-way', () => {
  const world = makeWorld();
  // exactly the shape of the real hazards: interiors.brandOf memoises an object
  // holding a RegExp, and levelWay's profile holds the Terrain it was measured
  // against. One is cut by name, the other becomes a sentinel; anything else
  // has to be loud.
  world.city.chunkIndex.get('0,0').roads[0]._surprise = { re: /Lidl/ };
  assert.throws(() => chunkSpec(world, 0, 0, 'full', null),
    /_surprise\.re is a RegExp/,
    'a class instance crossed into the spec without anybody noticing');
});

test('the worker reports a failed build rather than throwing it away', () => {
  const state = makeWorkerState();
  const reply = handleMessage(state, { t: 'build', id: 7, spec: { v: 999, cx: 1, cz: 2 } });
  assert.equal(reply.reply.t, 'fail');
  assert.equal(reply.reply.id, 7);
  assert.match(reply.reply.error, /1,2/, 'the failure does not say which chunk');
  assert.deepEqual(reply.transfer, []);
});

// ---- the fallback ----------------------------------------------------------

test('a pool that cannot spawn a worker retires itself', () => {
  const warn = console.warn; console.warn = () => {};
  try {
    const pool = makeMeshPool({ spawn: () => { throw new Error('Worker is not defined'); } });
    assert.equal(pool.dead, true, 'a pool with no workers must not accept builds');
    assert.equal(pool.size, 0);
    assert.equal(pool.free(), 0);
    assert.equal(pool.submit({}, 0, 0, 'full'), null,
      'submit must say null so the caller falls back, not throw');
  } finally { console.warn = warn; }
});

test('poolSize leaves the render thread a core and never asks for none', () => {
  const was = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const set = (n) => Object.defineProperty(globalThis, 'navigator',
    { value: { hardwareConcurrency: n }, configurable: true, writable: true });
  try {
    set(8);
    assert.equal(poolSize(4), 4);
    assert.equal(poolSize(16), 7);
    set(1);
    assert.equal(poolSize(4), 1, 'a single-core machine still gets one mesher');
  } finally {
    if (was) Object.defineProperty(globalThis, 'navigator', was);
    else delete globalThis.navigator;
  }
});

test('the world still streams when the workers are gone', () => {
  const world = makeWorld();
  world.mats.canopy = null; world.mats.ground = null;   // keep the fixture cheap
  const adds = [];
  const scene = { add: (g) => adds.push(g.name), remove: () => {} };
  const warn = console.warn; console.warn = () => {};
  let pool;
  try {
    pool = makeMeshPool({ spawn: () => { throw new Error('no Worker in here'); } });
  } finally { console.warn = warn; }
  const w = Object.assign(Object.create(CityWorld.prototype), {
    scene, city: world.city, mats: world.mats, terrain: world.terrain,
    canopy: null, ground: null,
    interiors: { update() {} },
    built: new Map(), queue: [], _queued: new Set(), _inflight: new Map(),
    pool, _poolFails: 0,
    viewChunks: 0, shellChunks: 0, farChunks: 0,
    chunksPerFrame: 2, buildBudgetMs: 0.0001, buildCooldownMs: 0,
    _detail: new Map(), _px: new Map(), _hadTerrain: new Map(), _missBy: new Map(),
    _tileT: 1e9,
  });
  const focus = { x: 60, z: 60 };
  for (let frame = 0; frame < 400; frame++) w.update(1 / 60, focus, {});
  assert.ok(w.built.get('0,0'), 'the chunk was never built at all');
  const chunkAdds = adds.filter((n) => n === 'chunk:0,0').length;
  assert.equal(chunkAdds, 1,
    `chunk 0,0 was added ${chunkAdds} times — the fallback lost the in-flight skip`);
});

// Several chunks in flight at once is the point of the pool, and it is also
// what breaks the streamer's oldest assumption: a cell being built is in
// NEITHER `built` nor the queue, so every pass that reasons about cells has to
// consult `_inflight` — which used to hold one entry and now holds a Map.
test('the streamer keeps its books with a whole pool in flight', () => {
  const world = makeWorld();
  const adds = [], removes = [];
  const scene = { add: (g) => adds.push(g.name), remove: (g) => removes.push(g.name) };
  // Three real mesher states behind three fake postMessage pipes: this runs
  // js/meshworker.js's own handleMessage, so the only thing being faked is the
  // thread. Replies are delivered between frames, which is when a real worker's
  // message event would land.
  const inbox = [];
  const spawn = () => {
    const state = makeWorkerState();
    const w = {
      postMessage(msg, transfer) {
        const posted = structuredClone(msg, { transfer });
        const { reply, transfer: back } = handleMessage(state, posted);
        inbox.push(() => w.onmessage({ data: structuredClone(reply, { transfer: back }) }));
      },
      terminate() {},
    };
    return w;
  };
  // eight more cells with something in them, so all three lanes have work — a
  // ring of empty neighbours would be answered instantly and never overlap
  let id = 5000;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    if (!dx && !dz) continue;
    const k = dx + ',' + dz, x0 = dx * 120, z0 = dz * 120;
    const road = { t: 'residential', w: 7, d: 1, v: 30,
      p: [[x0 + 5, z0 + 60], [x0 + 115, z0 + 62]], _id: ++id, _home: k };
    road._len = polylineLength(road.p);
    const b = { o: square(x0 + 12, z0 + 12, 24), h: 11, t: 'residential', _id: ++id, _home: k };
    world.city.chunkIndex.set(k, { buildings: [b], roads: [road], rails: [], water: [],
      green: [], paved: [], trees: [], signs: [], crossings: [], power: [],
      furniture: [], calming: [], barriers: [] });
  }

  const pool = makeMeshPool({ spawn, max: 3 });
  assert.equal(pool.size, 3, 'the pool did not open three lanes');
  // the two canvas materials the worker could not build, resolved by name
  world.mats.codecMats = { ortho: world.photo, 'brand:Lidl': world.wordmark };
  const w = Object.assign(Object.create(CityWorld.prototype), {
    scene, city: world.city, mats: world.mats, terrain: world.terrain,
    canopy: world.canopy, ground: world.ground,
    interiors: { update() {} },
    built: new Map(), queue: [], _queued: new Set(), _inflight: new Map(),
    pool, _poolFails: 0,
    viewChunks: 1, shellChunks: 0, farChunks: 0,      // 3×3 cells
    chunksPerFrame: 4, buildBudgetMs: 5, buildCooldownMs: 0,
    _detail: new Map(), _px: new Map(), _hadTerrain: new Map(), _missBy: new Map(),
    _tileT: 1e9,
  });
  const focus = { x: 60, z: 60 };
  let mostInFlight = 0;
  for (let frame = 0; frame < 60; frame++) {
    w.update(1 / 60, focus, {});
    mostInFlight = Math.max(mostInFlight, w._inflight.size);
    // a real worker answers when it answers — every other frame here, so the
    // books are asked to hold several open flights at once
    if (frame % 2) while (inbox.length) inbox.shift()();
  }
  while (inbox.length) inbox.shift()();
  w.update(1 / 60, focus, {});
  assert.ok(mostInFlight > 1,
    `never more than ${mostInFlight} chunk in flight — the pool is running one lane`);
  assert.equal(w.built.size, 9, `${w.built.size} of the nine view cells were built`);
  assert.ok(w.built.get('0,0'), 'the one cell with data in it never arrived');
  assert.equal(w._inflight.size, 0, 'a flight was left in the books after it landed');
  const chunkAdds = adds.filter((n) => n === 'chunk:0,0').length;
  assert.equal(chunkAdds, 1,
    `chunk 0,0 was added ${chunkAdds} times — the ring scan re-enqueued a cell in flight`);
  // the tier the photo was FETCHED at, recorded from what the chunk carries and
  // not from a tierOf() call dozens of frames after the fact
  assert.equal(w._px.get('0,0'), 512, 'the photo tier did not come back with the chunk');
  assert.equal(w._detail.get('0,0'), 'full');
});

test('a worker whose builds keep failing hands the world back to the main thread', () => {
  const world = makeWorld();
  world.mats.canopy = null; world.mats.ground = null;
  const adds = [];
  const scene = { add: (g) => adds.push(g.name), remove: () => {} };
  // a worker that answers every build with an error, which is what a mesher
  // that met a cache it could not read would do
  const sent = [];
  const fake = { postMessage(msg) { sent.push(msg); queue.push(msg.id); }, terminate() {} };
  const queue = [];
  const pool = makeMeshPool({ spawn: () => fake, max: 1 });
  assert.equal(pool.dead, false, 'the fake worker did not take');
  const w = Object.assign(Object.create(CityWorld.prototype), {
    scene, city: world.city, mats: world.mats, terrain: world.terrain,
    canopy: null, ground: null,
    interiors: { update() {} },
    built: new Map(), queue: [], _queued: new Set(), _inflight: new Map(),
    pool, _poolFails: 0,
    viewChunks: 0, shellChunks: 0, farChunks: 0,
    chunksPerFrame: 2, buildBudgetMs: 0.0001, buildCooldownMs: 0,
    _detail: new Map(), _px: new Map(), _hadTerrain: new Map(), _missBy: new Map(),
    _tileT: 1e9,
  });
  const focus = { x: 60, z: 60 };
  const warn = console.warn; console.warn = () => {};
  try {
    for (let frame = 0; frame < 400; frame++) {
      w.update(1 / 60, focus, {});
      while (queue.length) fake.onmessage({ data: { t: 'fail', id: queue.shift(), error: 'nope' } });
    }
  } finally { console.warn = warn; }
  assert.ok(sent.length >= 3, `only ${sent.length} builds were tried before giving up`);
  assert.equal(w.pool, null, 'the pool was never retired despite failing every build');
  assert.ok(w.built.get('0,0'), 'the chunk was never built after the workers gave up');
});
