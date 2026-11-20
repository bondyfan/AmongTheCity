// The chain stores (js/stores/), against the REAL tiles they stand in.
// What can go wrong with a store generated onto a footprint, none of which a
// screenshot taken today would show:
//   · a block of flats with a supermarket under it is rebuilt as a shed;
//   · the door is cut into one wall, the collision leaves another open and the
//     shoppers walk through a third;
//   · the mesh worker builds a different store than the main thread;
//   · two players see different people at different shelves;
//   · a full trolley costs nothing, or a meal heals twice.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { landmarkOf, LandmarkBatch, landmarkSolids, solidHas } = await import('../js/landmarks.js');
const { CHAINS, STORES, chainOfName, standalone, storeChain, isOpen, hoursText } = await import('../js/stores/chains.js');
const { makeSite, siteOf, pickFront, shopRect, inRing, storeKey } = await import('../js/stores/site.js');
const { pinStores } = await import('../js/stores/landmark.js');
const { driveOf } = await import('../js/stores/drive.js');
const { signBrand, parseSign, signQuad } = await import('../js/stores/signs.js');
const { marketLayout, roomOf } = await import('../js/stores/layout.js');
const { eatLayout } = await import('../js/stores/eatlayout.js');
const S = await import('../js/stores/schedule.js');
const { Cart, Bag, Order, CAPACITY } = await import('../js/stores/cart.js');
const { GOODS, goodsOf, goodById, priceAt, menuOf, MENUS, DEPT_NAME, total } = await import('../js/stores/catalog.js');
const { AISLE_CATS } = await import('../js/stores/layout.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, handleMessage } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity } = await import('../js/geo.js');

const CHUNK = 120;
const copy = (f) => JSON.parse(JSON.stringify(f));
const TILES = new Map();
function tile(k) {
  if (!TILES.has(k)) TILES.set(k, JSON.parse(readFileSync(new URL(`../public/data/tiles/${k}.json`, import.meta.url), 'utf8')));
  return TILES.get(k);
}
/** Every standalone store of a tile, each with the roads, parking and houses round it. */
function storesOf(k) {
  const t = tile(k), out = [];
  let id = 0;
  for (const raw of t.buildings) {
    if (!raw.n || !chainOfName(raw.n)) continue;
    const f = copy(raw); f._id = ++id;
    const chain = storeChain(f);
    if (!chain) continue;
    const near = (p) => Math.hypot(p[0] - f.o[0][0], p[1] - f.o[0][1]) < 170;
    const cell = { roads: t.roads.filter((r) => r.p.some(near)), paved: t.paved.filter((g) => g.o.some(near)),
      buildings: t.buildings.filter((b) => b.o.some(near)) };
    out.push({ f, chain, cell, site: siteOf(f, chain, cell) });
  }
  return out;
}
const PCE = [...storesOf('-1_-1'), ...storesOf('0_-1'), ...storesOf('0_0')];
const PRG = storesOf('-20_-2');
const ALL = [...PCE, ...PRG];

test('the chains are recognised by name, and only a store that stands alone is rebuilt', () => {
  assert.equal(chainOfName('Lidl')?.id, 'lidl');
  assert.equal(chainOfName('PENNY')?.id, 'penny');
  assert.equal(chainOfName('Penny Market')?.id, 'penny');
  assert.equal(chainOfName("McDonald's")?.id, 'mcdonalds');
  assert.equal(chainOfName('KFC')?.id, 'kfc');
  assert.equal(chainOfName('Tesco Expres'), null, 'a Tesco Expres is a corner shop, not a hypermarket');
  assert.equal(chainOfName('Albertov'), null);
  assert.equal(chainOfName('Restaurace U Lidlu'), null);
  const box = { n: 'Lidl', u: 'supermarket', t: 'commercial', h: 4.3, o: [[0, 0], [60, 0], [60, 35], [0, 35]] };
  assert.ok(standalone(box, chainOfName('Lidl')));
  assert.ok(!standalone({ ...box, t: 'apartments' }, chainOfName('Lidl')), 'flats over a shop stay flats');
  assert.ok(!standalone({ ...box, h: 19.8 }, chainOfName('Lidl')), 'a six-storey block is not a shed');
  assert.ok(!standalone({ ...box, o: [[0, 0], [10, 0], [10, 10], [0, 10]] }, chainOfName('Lidl')), 'a hundred square metres is a kiosk');
  assert.ok(!standalone({ ...box, u: 'fast_food' }, chainOfName('Lidl')));
  // Pardubice as shipped: the Lidl, both McDonald's, the Albert, the Kaufland and the Globus of tile -1_-1
  const ids = storesOf('-1_-1').map((s) => s.chain.id).sort();
  assert.deepEqual(ids, ['albert', 'globus', 'kaufland', 'lidl', 'mcdonalds', 'mcdonalds']);
  assert.ok(PRG.length >= 10, `only ${PRG.length} standalone stores found in central Prague`);
  // the Lidl in an office block on Wenceslas Square is a tenant, not a hall
  const wenceslas = tile('-20_-2').buildings.find((b) => b.n === 'Lidl' && (b.h ?? 0) > 15);
  assert.ok(wenceslas && !storeChain(copy(wenceslas)));
});

test('the switch turns every store back into a generic building', () => {
  const f = copy(PCE[0].f); delete f._lm; delete f._sf;
  assert.ok(landmarkOf(f)?.store);
  const g = copy(PCE[0].f); delete g._lm;
  STORES.on = false;
  try { assert.equal(landmarkOf(g), null); } finally { STORES.on = true; }
});

test('a store fronts its car park: the Lidl by Pardubice station looks north over it', () => {
  const lidl = storesOf('-1_-1').find((s) => s.chain.id === 'lidl');
  assert.ok(lidl.site.front.len > 60, 'the long side, not the 24 m gable with a service lane beside it');
  assert.ok(lidl.site.nz < -0.95, `front normal (${lidl.site.nx.toFixed(2)}, ${lidl.site.nz.toFixed(2)}) should point north`);
  // the choice is a plain memo: the mesh worker reads it instead of working it out again
  assert.equal(typeof lidl.f._sf, 'number');
  assert.equal(pickFront(lidl.f, lidl.chain, lidl.cell), lidl.f._sf);
});

test('every wall of every store is accounted for, with one door, on the front', () => {
  for (const { f, site } of ALL) {
    const tag = `${f.n} at ${f.o[0]}`;
    const doors = site.segs.filter((s) => s.kind === 'door');
    assert.equal(doors.length, 1, `${tag}: ${doors.length} doors`);
    assert.equal(doors[0].edge, site.front.i, `${tag}: the door is not in the front wall`);
    assert.ok(doors[0].len >= 1.5 && doors[0].len <= 5, `${tag}: a ${doors[0].len.toFixed(1)} m door`);
    // the runs of each edge add up to the edge, in order, without a gap
    const byEdge = new Map();
    for (const s of site.segs) { if (!byEdge.has(s.edge)) byEdge.set(s.edge, []); byEdge.get(s.edge).push(s); }
    for (const e of site.edges) {
      const runs = byEdge.get(e.i);
      assert.ok(runs?.length, `${tag}: edge ${e.i} has no wall at all`);
      const sum = runs.reduce((t, s) => t + s.len, 0);
      assert.ok(Math.abs(sum - e.len) < 1e-6, `${tag}: edge ${e.i} is ${e.len.toFixed(2)} m, its runs ${sum.toFixed(2)}`);
      for (let i = 1; i < runs.length; i++)
        assert.ok(Math.hypot(runs[i].a[0] - runs[i - 1].b[0], runs[i].a[1] - runs[i - 1].b[1]) < 1e-6, `${tag}: a gap in edge ${e.i}`);
    }
    // glass only where the chain has any, and never under the roof line
    assert.ok(site.glassTop < site.hF && site.glassTop > 2.6, `${tag}: glazing to ${site.glassTop}`);
    assert.ok(inRing(f.o, site.door.x - site.nx * 1.2, site.door.z - site.nz * 1.2), `${tag}: a step in from the door is not inside`);
    assert.ok(!inRing(f.o, site.door.x + site.nx * 1.2, site.door.z + site.nz * 1.2), `${tag}: a step out from the door is not outside`);
  }
});

test('the store can be walked into through its door, and through nothing else', () => {
  for (const { f } of ALL) {
    const l = landmarkOf(f);
    assert.ok(l?.store, `${f.n} is not a store landmark`);
    const solids = landmarkSolids(f), site = siteOf(f, l.chain, null);
    const blocked = (x, z) => solids.some((s) => s.bot <= 0.5 && solidHas(s, x, z));
    // the doorway: open across its middle, a metre either way along the wall
    for (const k of [-0.25, 0, 0.25]) {
      const x = site.door.x + site.ux * site.door.w * k - site.nx * 0.12, z = site.door.z + site.uz * site.door.w * k - site.nz * 0.12;
      assert.ok(!blocked(x, z), `${f.n}: the doorway is solid`);
    }
    // every other run of wall is solid in its middle, glass included
    for (const s of site.segs) {
      if (s.kind === 'door' || s.len < 0.6) continue;
      const x = (s.a[0] + s.b[0]) / 2 - s.mx * 0.12, z = (s.a[1] + s.b[1]) / 2 - s.mz * 0.12;
      assert.ok(blocked(x, z), `${f.n}: a ${s.kind} run of ${s.len.toFixed(1)} m can be walked through`);
    }
    // the roof is over head height everywhere, and is something to land on
    const roof = solids.find((s) => s.ring === f.o);
    assert.ok(roof && roof.bot > 3 && roof.top >= l.chain.arch.hF - 1e-9, `${f.n}: roof slab ${roof?.bot}..${roof?.top}`);
  }
});

test('the generator builds sound geometry on every real footprint, signs included', () => {
  let tris = 0;
  for (const { f, cell, chain } of ALL) {
    const l = landmarkOf(f), batch = new LandmarkBatch(), marks = new Map();
    batch.add(l, f, 221, null, cell.roads, { cell, marks });
    const g = batch.geo();
    assert.ok(g, `${f.n}: nothing built`);
    const P = g.attributes.position, K = g.attributes.uv;
    for (let i = 0; i < P.count; i++) {
      assert.ok(Number.isFinite(P.getX(i) + P.getY(i) + P.getZ(i)), `${f.n}: a vertex is not a number`);
      const kind = K.getX(i) * 16;
      assert.ok(Math.abs(kind - Math.round(kind)) < 1e-6 && kind >= 0 && kind <= 13, `${f.n}: surface kind ${kind}`);
    }
    const n = P.count / 3;
    tris += n;
    assert.ok(n > 300 && n < 6000, `${f.n}: ${n} triangles`);
    // a sign on the front, one on the pylon, the hours by the door
    const labels = [...marks.keys()];
    assert.ok(labels.some((k) => k === '@' + chain.id + '/hours'), `${f.n}: no hours board`);
    assert.ok(labels.some((k) => /\/(sq|band)$/.test(k)), `${f.n}: no sign`);
    for (const mk of marks.values()) {
      assert.equal(mk.pos.length % 18, 0); assert.equal(mk.uv.length, mk.pos.length / 18 * 12);
      for (const v of mk.pos) assert.ok(Number.isFinite(v));
      assert.deepEqual(Object.keys(mk.brand).sort(), ['label', 'sign', 'trim'], 'only what crosses from the worker');
    }
  }
  assert.ok(tris / ALL.length < 2600, `a store averages ${Math.round(tris / ALL.length)} triangles`);
});

test('a sign is named so that the worker can carry it', () => {
  for (const c of CHAINS) for (const v of ['sq', 'band', 'hours']) {
    const b = signBrand(c, v), k = parseSign(b.label);
    assert.equal(k.id, c.id); assert.equal(k.variant, v);
  }
  assert.equal(parseSign('Potraviny U Nováka'), null);
  const marks = new Map();
  signQuad(marks, signBrand(CHAINS[0]), 10, 20, 5, 2, 2, 0, 1);
  const mk = [...marks.values()][0];
  assert.equal(mk.pos.length, 18);
  // faces +z: the quad lies in the plane z = 20, two metres wide
  for (let i = 2; i < 18; i += 3) assert.equal(mk.pos[i], 20);
});

// ---- the mesh worker ---------------------------------------------------------
function worldFor(key, source) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const [kx, kz] = key.split(',').map(Number);
  const tx = Math.floor(kx * CHUNK / 4800), tz = Math.floor(kz * CHUNK / 4800);
  const homeOf = (f) => Math.floor(f.o[0][0] / CHUNK) + ',' + Math.floor(f.o[0][1] / CHUNK);
  const buildings = source.buildings.filter((f) => homeOf(f) === key).map((f) => { const g = copy(f); g._id = ++id; g._home = key; return g; });
  const cell = { buildings, roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const terrain = new Terrain(4800, 20);
  const g = new Int16Array(terrain.n * terrain.n);
  for (let j = 0; j < terrain.n; j++) for (let i = 0; i < terrain.n; i++)
    g[j * terrain.n + i] = Math.round((221 + Math.sin(i * 0.31) * 0.6 + Math.cos(j * 0.23) * 0.5) * 10);
  terrain.grids.set(tx + ',' + tz, g);
  terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, terrain, canopy: null, ground: null, mats, wordmark, cell };
}

test('a chunk with a store comes back from the worker the same as it is built here', () => {
  const homeOf = (f) => Math.floor(f.o[0][0] / CHUNK) + ',' + Math.floor(f.o[0][1] / CHUNK);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  let compared = 0, worst = 0, chunks = 0;
  for (const [tk, pick] of [['-1_-1', ['lidl', 'mcdonalds', 'kaufland']], ['0_0', ['billa', 'penny']], ['0_-1', ['kfc']]]) {
    const stores = storesOf(tk).filter((s) => pick.includes(s.chain.id));
    for (const key of new Set(stores.map((s) => homeOf(s.f)))) {
      const [cx, cz] = key.split(',').map(Number);
      const world = worldFor(key, tile(tk));
      const here = world.cell.buildings.filter((f) => landmarkOf(f)?.store);
      assert.ok(here.length, `chunk ${key} holds no store after all`);
      // THE WORKER FIRST, as the streamer does it: the front wall is pinned, then the inputs are copied
      pinStores(world.cell);
      for (const f of here) assert.equal(typeof f._sf, 'number', 'pinStores left a store undecided');
      const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
      assert.ok(got, `chunkSpec refused chunk ${key}`);
      const { reply } = handleMessage(makeWorkerState(), { t: 'build', id: 1, spec: structuredClone(got.spec, { transfer: got.transfer }) });
      assert.equal(reply.t, 'done', `the worker failed chunk ${key}: ${reply.error}`);
      assert.ok(Object.keys(reply.brands).some((k) => k.startsWith('brand:@')), 'the store signs were not named on the wire');
      const decMats = { ...world.mats, codecMats: {} };
      for (const k of Object.keys(reply.brands)) decMats.codecMats[k] = world.wordmark;
      const back = decode(reply.payload, decMats);
      const sync = buildChunkMeshes(world.city, cx, cz, world.mats, 'full');
      sync.updateMatrixWorld(true); back.updateMatrixWorld(true);
      const lm = (root) => { const out = []; root.traverse((o) => { if (o.isMesh && o.material === world.mats.landmark) out.push(o); }); return out; };
      const A0 = lm(sync), B0 = lm(back);
      assert.equal(A0.length, 1); assert.equal(B0.length, 1);
      const A = A0[0].geometry.attributes, B = B0[0].geometry.attributes;
      assert.equal(B.position.count, A.position.count, `chunk ${key}: vertex count`);
      for (let v = 0; v < A.position.count; v++) {
        p.fromBufferAttribute(A.position, v).applyMatrix4(A0[0].matrixWorld);
        q.fromBufferAttribute(B.position, v).applyMatrix4(B0[0].matrixWorld);
        worst = Math.max(worst, p.distanceTo(q));
        assert.equal(Math.round(B.uv.getX(v) * 16), Math.round(A.uv.getX(v) * 16), `chunk ${key}: surface kind of vertex ${v}`);
        compared++;
      }
      // the signs: the same quads in the same places
      const marks = (root) => { let n = 0; root.traverse((o) => { if (o.isMesh && o.material === world.wordmark) n += o.geometry.attributes.position.count; }); return n; };
      assert.equal(marks(back), marks(sync), `chunk ${key}: the two paths drew different signs`);
      assert.ok(marks(sync) >= 18, `chunk ${key}: no sign quads at all`);
      const count = (root) => { let n = 0; root.traverse((o) => { if (o.isMesh) n++; }); return n; };
      assert.equal(count(back), count(sync), `chunk ${key}: a different set of meshes`);
      chunks++;
    }
  }
  assert.ok(chunks >= 5, `only ${chunks} chunks compared`);
  assert.ok(compared > 15000, `only ${compared} vertices compared`);
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm between the two paths`);
});

// ---- the drive-through ---------------------------------------------------------
test("the McDonald's by Pardubice station has its drive-through where the map has the lane", () => {
  const mc = storesOf('-1_-1').find((s) => s.chain.id === 'mcdonalds' && Math.abs(s.f.o[0][0] + 149.6) < 1);
  const d = driveOf(mc.f, mc.cell.roads);
  assert.ok(d, 'no drive-through found although OSM names two ways "McDrive"');
  // the window is on the wall, the car stops beside it, the post is back along the lane
  const wall = Math.min(...mc.f.o.map((p, i) => {
    const q = mc.f.o[(i + 1) % mc.f.o.length], dx = q[0] - p[0], dz = q[1] - p[1];
    const t = Math.max(0, Math.min(1, ((d.wx - p[0]) * dx + (d.wz - p[1]) * dz) / (dx * dx + dz * dz)));
    return Math.hypot(d.wx - p[0] - dx * t, d.wz - p[1] - dz * t);
  }));
  assert.ok(wall < 0.05, `the window is ${wall.toFixed(2)} m off the wall`);
  const lane = Math.hypot(d.px - d.wx, d.pz - d.wz);
  assert.ok(lane > 1.5 && lane < 8.5, `the car stops ${lane.toFixed(1)} m from the window`);
  assert.ok(!inRing(mc.f.o, d.ox, d.oz) && !inRing(mc.f.o, d.px, d.pz), 'a stopping point inside the building');
  assert.ok(Math.hypot(d.ox - d.px, d.oz - d.pz) > 3, 'the order post and the window are one place');
  assert.ok(Math.abs(Math.hypot(d.dx, d.dz) - 1) < 0.02);
  // asked again it is the memo, whatever roads are passed
  assert.deepEqual(driveOf(mc.f, []), d);
  // a restaurant with no lane has no drive-through, and says so once
  const none = { n: 'KFC', o: [[0, 0], [20, 0], [20, 15], [0, 15]] };
  assert.equal(driveOf(none, [{ p: [[100, 100], [140, 100]], t: 'service', d: 1, ow: 1 }]), null);
  assert.equal(none._sd, 0);
});

// ---- inside ----------------------------------------------------------------------
test('a supermarket is laid out inside its own walls, with tills, aisles and a way through', () => {
  for (const { f, site, chain } of ALL) {
    if (chain.kind === 'fast') continue;
    const L = marketLayout(site), { W, D } = L.room, r = shopRect(site);
    assert.ok(W > 8 && D > 8, `${f.n}: a ${W.toFixed(0)} x ${D.toFixed(0)} m room`);
    for (const [u, v] of [[r.u0, r.v0], [r.u1, r.v0], [r.u1, r.v1], [r.u0, r.v1]]) {
      const [x, z] = site.world(u, v);
      assert.ok(inRing(f.o, x, z), `${f.n}: the shop floor leaves the footprint`);
    }
    assert.ok(L.tills.length >= 1, `${f.n}: no till`);
    assert.ok(L.fixtures.some((x) => x.t === 'gondola' || x.t === 'rack'), `${f.n}: no aisle`);
    assert.ok(L.points.some((p) => p.kind === 'baskets'), `${f.n}: no baskets`);
    for (const x of L.fixtures) {
      assert.ok(Number.isFinite(x.a + x.b + x.len), `${f.n}: ${x.t} at ${x.a}, ${x.b}`);
      assert.ok(x.a > -0.01 && x.a < D + 0.01 && x.b > -0.01 && x.b < W + 0.01, `${f.n}: a ${x.t} outside the room (${x.a.toFixed(1)}, ${x.b.toFixed(1)})`);
      // nothing stands in the way in
      if (x.t !== 'gate' && x.a < L.aAisle0 - 0.2) {
        const half = x.along === 'b' ? x.len / 2 : 0.6;
        assert.ok(x.b + half < L.lane.b0 + 0.5 || x.b - half > L.lane.b1 - 0.5 || x.t === 'baskets', `${f.n}: a ${x.t} in the entry lane`);
      }
    }
    for (const p of L.points) {
      assert.ok(inRing(f.o, p.x, p.z), `${f.n}: a ${p.kind} point outside the walls`);
      if (p.kind === 'shelf') assert.ok(goodsOf(p.cat).length >= 2, `${f.n}: a shelf of '${p.cat}' has nothing to sell`);
    }
    // every department the aisles name is one the catalogue stocks and the boards can name
    for (const row of L.rows) assert.ok(DEPT_NAME[row.cat], `${f.n}: department '${row.cat}'`);
  }
  for (const c of AISLE_CATS) assert.ok(goodsOf(c).length >= 2, `nothing is sold under '${c}'`);
});

test('a restaurant has a counter, kiosks and chairs to sit on, inside its walls', () => {
  let seen = 0;
  for (const { f, site, chain } of ALL) {
    if (chain.kind !== 'fast') continue;
    const L = eatLayout(site);
    assert.ok(L.counter.length >= 1 && L.seats.length >= 8, `${f.n}: ${L.counter.length} counter points, ${L.seats.length} seats`);
    assert.ok(L.points.some((p) => p.kind === 'kiosk') || L.room.D < 10, `${f.n}: no kiosk`);
    for (const s of L.seats) assert.ok(inRing(f.o, s.x, s.z), `${f.n}: a chair outside the walls`);
    for (const s of L.staff) assert.ok(inRing(f.o, s.x, s.z), `${f.n}: a crew member outside the walls`);
    // chairs come in fours round a table and no two share a place
    const at = new Set(L.seats.map((s) => s.a.toFixed(2) + ',' + s.b.toFixed(2)));
    assert.equal(at.size, L.seats.length);
    assert.ok(menuOf(chain.id).length >= 8);
    seen++;
  }
  assert.ok(seen >= 3, `only ${seen} restaurants checked`);
  for (const id of ['mcdonalds', 'kfc', 'burgerking']) assert.ok(MENUS[id].every((d) => d.price > 20 && d.hp > 0 && d.kcal > 0));
});

test('the people in a shop are a function of the store, the slot and the clock, and nothing else', () => {
  for (const { f, site, chain } of ALL.slice(0, 14)) {
    const L = chain.kind === 'fast' ? eatLayout(site) : marketLayout(site), plan = chain.kind === 'fast' ? S.fastPlan : S.marketPlan;
    const P = S.periodOf(L), n = S.slotCount(L), { W, D } = L.room;
    assert.ok(n >= 2 && n <= 12);
    for (let slot = 0; slot < n; slot++) for (let cycle = 0; cycle < 4; cycle++) {
      const a = plan(L, slot, cycle), b = plan(L, slot, cycle);
      assert.deepEqual(a, b, `${f.n}: the same visit planned twice differs`);
      assert.ok(a.dur <= P, `${f.n}: a visit of ${a.dur.toFixed(0)} s in a cycle of ${P}`);
      for (const nd of a.nodes) {
        assert.ok(Number.isFinite(nd.a + nd.b + nd.t0 + nd.t1));
        assert.ok(nd.a < D + 0.01 && nd.b > -2 && nd.b < W + 2, `${f.n}: a visitor sent to (${nd.a.toFixed(1)}, ${nd.b.toFixed(1)}) of a ${D.toFixed(0)} x ${W.toFixed(0)} room`);
      }
      // nobody teleports: a tenth of a second is at most a stride
      let pa = null, pb = null;
      for (let u = 0; u < a.dur; u += 0.1) {
        const st = S.at(a, u, {});
        if (pa !== null) assert.ok(Math.hypot(st.a - pa, st.b - pb) < a.speed * 0.1 + 1e-6, `${f.n}: a jump at ${u.toFixed(1)} s`);
        pa = st.a; pb = st.b;
      }
      assert.ok(!S.at(a, a.dur + 1, {}).present && !S.at(a, -1, {}).present);
    }
    // two machines, one clock: the same slot is on the same visit at the same second
    const v1 = S.visit(L, 3, 81234.5), v2 = S.visit(L, 3, 81234.5);
    assert.deepEqual(v1, v2);
    assert.ok(v1.u >= 0 && v1.u < P);
  }
  assert.ok(S.busyAt(17.5) > S.busyAt(9) && S.busyAt(3) < 0.2);
  assert.equal(S.tillsOpen(0, 12), 0);
  assert.ok(S.tillsOpen(10, 17.5) === 10 && S.tillsOpen(10, 3) >= 1);
});

// ---- money ---------------------------------------------------------------------
test('a cart holds what its carrier can, and costs what the shelf said', () => {
  const c = new Cart(), milk = goodById('mleko'), bread = goodById('chleb');
  assert.equal(c.cap, CAPACITY.hands);
  for (let i = 0; i < 3; i++) assert.ok(c.add(milk, 27));
  assert.ok(!c.add(bread, 42), 'a fourth thing in two hands');
  c.carrier = 'basket';
  assert.ok(c.add(bread, 42));
  assert.equal(c.count(), 4); assert.equal(c.has('mleko'), 3);
  assert.equal(c.total(), 3 * 27 + 42);
  assert.ok(c.remove('mleko')); assert.equal(c.total(), 2 * 27 + 42);
  assert.ok(!c.remove('nic'));
  c.clear(); assert.ok(c.empty);
  // a discounter is under the list, the label ends in ninety
  assert.ok(priceAt('lidl', goodById('kava')) < priceAt('billa', goodById('kava')));
  assert.ok(Math.abs((priceAt('tesco', goodById('kava')) * 10) % 10 - 9) < 1e-6);
  assert.equal(total([{ price: 26.9, n: 2 }, { price: 3.8, n: 5 }]), 73);
  for (const g of GOODS) assert.ok(g.price > 0 && DEPT_NAME[g.dept], `${g.id} has no department`);
});

test('the bag keeps what was bought, across a reload, and a thing is eaten once', () => {
  const store = { v: {}, getItem(k) { return this.v[k] ?? null; }, setItem(k, x) { this.v[k] = x; } };
  const bag = new Bag(store);
  const kept = bag.takeAll([{ id: 'mleko', n: 2 }, { id: 'papir', n: 1 }, { id: 'pizza', n: 1 }]);
  assert.equal(kept, 3, 'toilet paper is bought, not carried about to be eaten');
  assert.equal(new Bag(store).count(), 3, 'the bag did not survive a reload');
  assert.equal(bag.eat('pizza')?.id, 'pizza');
  assert.equal(bag.eat('pizza'), null);
  assert.equal(new Bag(store).count(), 2);
  // a bag somebody tampered with is read as far as it makes sense
  store.v['atc-bag'] = '{"mleko":3,"neexistuje":9,"chleb":-2}';
  assert.equal(new Bag(store).count(), 3);
  store.v['atc-bag'] = 'not json';
  assert.equal(new Bag(store).count(), 0);
});

test('an order is paid once, cooked for a while and worth what its dishes are', () => {
  const o = new Order(), m = menuOf('mcdonalds');
  o.add(m[3]); o.add(m[3]); o.add(m[7]);
  assert.equal(o.count(), 3);
  assert.equal(o.total(), 2 * m[3].price + m[7].price);
  o.place(1000, 47, 123);
  assert.ok(!o.ready(1005) && o.ready(1000 + 21 + 0.01), 'twelve seconds and three a dish');
  const w = o.worth();
  assert.equal(w.hp, 2 * m[3].hp + m[7].hp); assert.equal(w.kcal, 2 * m[3].kcal + m[7].kcal);
  const d = new Order(); d.add(m[0]); d.place(0, 1, 5, true);
  assert.ok(d.ready(8), 'a drive-through order is quicker');
  o.clear(); assert.equal(o.state, 'none'); assert.equal(o.count(), 0);
});

test('opening hours', () => {
  const lidl = CHAINS.find((c) => c.id === 'lidl'), mc = CHAINS.find((c) => c.id === 'mcdonalds');
  assert.ok(isOpen(lidl, 12) && !isOpen(lidl, 22) && !isOpen(lidl, 5));
  assert.ok(isOpen(mc, 23.5) && isOpen(mc, 7) && !isOpen(mc, 3));
  assert.match(hoursText(lidl), /^7:00 . 21:00$/);
  assert.equal(storeKey({ o: [[1.04, 2.01]] }), storeKey({ o: [[1.0, 2.0]] }), 'a store is the same store a few centimetres either way');
});

test("a store's car park fills by day and empties at night, and its bays are the parked cars' own", async () => {
  const { shopLot, shopOccAt, occAt, lotStalls, STALL } = await import('../js/parkinglots.js');
  assert.ok(shopOccAt(17.5 / 24) > 0.8 && shopOccAt(3 / 24) < 0.06, 'a supermarket car park at half past five and at three in the morning');
  assert.ok(occAt(3 / 24) > 0.8, 'a housing estate is the other way round');
  // the big lot along the north side of the Lidl by Pardubice station
  const t = tile('-1_-1'), lidl = storesOf('-1_-1').find((s) => s.chain.id === 'lidl');
  const key = (p) => Math.floor(p[0] / CHUNK) + ',' + Math.floor(p[1] / CHUNK);
  const idx = new Map();
  for (const b of t.buildings) {
    if (!b.o?.length) continue;
    const k = key(b.o[0]);
    if (!idx.has(k)) idx.set(k, { buildings: [] });
    idx.get(k).buildings.push(b);
  }
  const city = { chunkIndex: idx };
  const lots = t.paved.filter((g) => g.t === 'parking' && g.o.some((p) => Math.hypot(p[0] + 420, p[1] + 150) < 60));
  assert.ok(lots.length >= 2);
  assert.ok(lots.some((g) => shopLot(city, g.o)), 'the car park in front of the Lidl is not seen as a shop car park');
  // a lot in the middle of the old town is nobody's supermarket
  assert.ok(!shopLot(city, [[1560, -700], [1570, -700], [1570, -690], [1560, -690]]));
  const big = lots.reduce((m, g) => (g.o.length > m.o.length ? g : m));
  const stalls = lotStalls(big);
  assert.ok(stalls.length >= 4 && stalls.length <= 40);
  for (const s of stalls) assert.ok(Number.isFinite(s.x + s.z + s.h));
  assert.ok(STALL.across > 2.3 && STALL.deep > 4.5);
  assert.ok(lidl.site.front.len > 60);
});
