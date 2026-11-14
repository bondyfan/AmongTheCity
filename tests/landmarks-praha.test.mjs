// The Old Town of Prague and Charles Bridge (round 7): what the footprint
// tests in tests/landmarks.test.mjs cannot see.
//   · Charles Bridge and the Hus monument have no footprint: they are pieces
//     built by the chunk their anchor lies in (js/landmarks.js EXTRAS). A piece
//     built by two chunks z-fights, a piece built by none is a hole in the
//     bridge, and either depends on nothing a screenshot of today shows.
//   · the generic bridge dressing must go on exactly the Charles Bridge ways,
//     and the statue props the tile stands on the riverbed must go with it;
//   · three gates are lifted over their passages in the tile and stand on the
//     ground in their models: the passage must be open and the walls solid;
//   · the Old Town Square is a paved square, not a field with grass tufts.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { LANDMARKS, EXTRAS, matches, landmarkOf, landmarkSolids, solidHas, inLandmark, landmarkBridge,
  landmarkExtras, landmarkClear, LandmarkBatch } = await import('../js/landmarks.js');
const { AXIS, PIERS, axisAt } = await import('../js/landmarks-karluv.js');
const { HUS } = await import('../js/landmarks-sloup.js');
const { GrassMask, _test: grassT } = await import('../js/grassmask.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, handleMessage } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity, chunkKey } = await import('../js/geo.js');

const load = (k) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${k}.json`, import.meta.url), 'utf8'));
const west = load('-21_-2'), east = load('-20_-2');
const find = (id, t) => { const l = LANDMARKS.find((q) => q.id === id); return t.buildings.find((f) => matches(l, f)); };
const CHUNK = 120;

test('the generic bridge dressing goes on exactly the three ways of Charles Bridge', () => {
  const mine = west.roads.filter((r) => landmarkBridge(r));
  assert.equal(mine.length, 3, `${mine.length} ways taken for Charles Bridge`);
  for (const r of mine) assert.equal(r.n, 'Karlův most');
  // every other bridge in the tile keeps its own parapet, and a non-bridge
  // way named Karlův most (east of the tower) is no bridge at all
  const others = west.roads.filter((r) => r.br && r.n !== 'Karlův most');
  assert.ok(others.length > 20, 'the tile has other bridges to compare with');
  for (const r of others) assert.ok(!landmarkBridge(r));
  assert.ok(!landmarkBridge(west.roads.find((r) => r.n === 'Karlův most' && !r.br)));
  // the same way in Pardubice is not taken (one compare per region refuses it)
  const fake = { ...mine[0], p: mine[0].p.map(([x, z]) => [x + 97000, z + 5400]) };
  assert.ok(!landmarkBridge(fake));
});

test('the statue props on the riverbed and the Hus stone give way to the models, the benches do not', () => {
  const off = (x, z) => {
    // the distance from the bridge centre line
    let best = Infinity;
    for (let i = 1; i + 1 < AXIS.length - 1; i++) {
      const [ax, az] = AXIS[i], [bx, bz] = AXIS[i + 1], ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
    }
    return best;
  };
  // (a tile stores a prop's point flat, [x, z]; the indexed city wraps it)
  const xz = (p) => (Array.isArray(p.p[0]) ? p.p[0] : p.p);
  const on = west.furniture.filter((p) => (p.k === 'memorial' || p.k === 'cross') && off(...xz(p)) < 8);
  assert.ok(on.length >= 24, `only ${on.length} statue props on the bridge`);
  for (const p of on) assert.ok(inLandmark(null, ...xz(p)), `a statue prop at ${xz(p)} is still drawn`);
  // ...and the mapped lamps along the parapet (meshes.js lampSpots skips them:
  // the model has its own lanterns, the tile's stood on the riverbed)
  const lamps = west.furniture.filter((p) => p.k === 'lamp' && off(...xz(p)) < 7);
  assert.ok(lamps.length >= 20, `only ${lamps.length} mapped lamps on the bridge`);
  for (const p of lamps) assert.ok(inLandmark(null, ...xz(p)), `a mapped lamp at ${xz(p)} still stands on the riverbed`);
  const dH = (p) => Math.hypot(xz(p)[0] - HUS[0], xz(p)[1] - HUS[1]);
  const hus = east.furniture.filter((p) => p.k === 'memorial' && dH(p) < 11);
  assert.ok(hus.length >= 1);
  for (const p of hus) assert.ok(inLandmark(null, ...xz(p)));
  const benches = east.furniture.filter((p) => p.k === 'bench' && dH(p) < 18);
  assert.ok(benches.length > 10, 'the ring of benches round Hus is gone from the tile');
  for (const p of benches) assert.ok(!inLandmark(null, ...xz(p)), 'a bench round Hus was taken');
  // no tree of Kampa grows through the deck, and the tower passages are clear
  const [mx, mz] = axisAt(400);
  assert.ok(landmarkClear(mx, mz) && landmarkClear(-96186.7, -6058.4) && landmarkClear(-96671, -6175.5));
  assert.ok(!landmarkClear(mx, mz - 40), 'a clear zone 40 m off the bridge');
});

/** Every piece of every footprint-less landmark, built chunk by chunk over its box. */
function byChunk(ownAll = false) {
  const out = new Map();
  const ctxOf = (key, cx, cz) => ({ key, cx, cz, roads: [], terrain: { heightAt: () => 186 }, chunkOf: ownAll ? () => key : chunkKey });
  for (const e of EXTRAS) {
    const [x0, z0, x1, z1] = e.box;
    for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++) for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) {
      const key = cx + ',' + cz;
      if (!landmarkExtras(cx, cz, CHUNK).includes(e)) continue;
      const b = new LandmarkBatch();
      b.extra(e, ctxOf(key, cx, cz));
      out.set(e.id + '@' + key, b.sink);
      if (ownAll) return out;           // one chunk that owns everything is enough
    }
  }
  return out;
}

test('each piece of the bridge and of the Hus monument is built by exactly one chunk', () => {
  const parts = byChunk();
  const sum = (id) => [...parts].filter(([k]) => k.startsWith(id + '@')).reduce((n, [, s]) => n + s.tris, 0);
  // the whole set, as one chunk that owned every anchor would build it
  const all = (id) => {
    const e = EXTRAS.find((q) => q.id === id), b = new LandmarkBatch();
    b.extra(e, { key: 'k', cx: 0, cz: 0, roads: [], terrain: { heightAt: () => 186 }, chunkOf: () => 'k' });
    return b.sink.tris;
  };
  for (const id of ['karluv-most', 'hus']) {
    const whole = all(id);
    assert.ok(whole > 300, `${id} is ${whole} triangles`);
    assert.equal(sum(id), whole, `${id}: the chunks build ${sum(id)} triangles of ${whole}`);
  }
  assert.ok(all('karluv-most') < 24000, 'Charles Bridge is over budget');
  // the pieces spread over the chunks the bridge crosses, each pier in its own
  const chunks = new Set(PIERS.map((s) => { const [x, z] = axisAt(s); return chunkKey(x, z); }));
  assert.ok(chunks.size >= 4);
  for (const k of chunks) assert.ok(parts.get('karluv-most@' + k)?.tris > 0, `chunk ${k} builds no piece of the bridge`);
  // ...and the same chunk builds the same piece twice
  const again = byChunk();
  for (const [k, s] of parts) assert.deepEqual(again.get(k).pos, s.pos, `${k} is not deterministic`);
  for (const s of parts.values()) for (const a of [s.uv, s.uv1, s.col]) for (const v of a) assert.ok(v >= 0 && v <= 1);
});

test('the lifted gates stand on the ground beside an open passage', () => {
  const cases = [
    // [entry, tile, a point on each mouth of the passage]
    ['otbt', west, [-96192.1, -6059.6], [-96181.4, -6057.1]],
    ['mlst-brana', west, [-96676.0, -6175.7], [-96666.1, -6175.2]],
    ['prasna-brana', east, [-95179.9, -6179.1], [-95166.5, -6175.0]],
  ];
  for (const [id, t, a, b] of cases) {
    const f = find(id, t);
    assert.ok(f && f.y > 0.5, `${id}: the tile no longer lifts it`);
    assert.equal(landmarkOf(f)?.id, id);
    const all = landmarkSolids(f), walls = all.filter((s) => s.bot <= 0.5);
    const inWall = (x, z) => walls.some((s) => solidHas(s, x, z));
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
    for (let s = 0; s <= L; s += 0.5) for (const o of [-1, 0, 1])
      assert.ok(!inWall(a[0] + dx * s - dz * o, a[1] + dz * s + dx * o), `${id}: the passage is blocked ${s} m in`);
    const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
    for (const o of [-3.8, 3.8]) assert.ok(inWall(mx - dz * o, mz + dx * o), `${id}: no wall ${o} m beside the passage`);
    assert.ok(all.some((s) => s.bot > 5 && solidHas(s, mx, mz)), `${id}: nothing over the passage`);
  }
});

test('the Old Town Square is paved, and a lawn on a Prague square is still a lawn', () => {
  const { UNMAPPED, MOWN } = grassT;
  // a square named as such, one hard pedestrian way across it, nothing else mapped
  const at = (cx, cz) => {
    const x0 = cx * CHUNK, z0 = cz * CHUNK;
    const cell = { buildings: [], rails: [], water: [], paved: [], trees: [],
      roads: [{ t: 'pedestrian', s: 'cobble', w: 4, n: 'Staroměstské náměstí', p: [[x0, z0 + 60], [x0 + 120, z0 + 60]] }],
      green: [{ t: 'park', o: [[x0 + 100, z0 + 100], [x0 + 118, z0 + 100], [x0 + 118, z0 + 118], [x0 + 100, z0 + 118]] }] };
    const m = new GrassMask({ chunkIndex: new Map([[cx + ',' + cz, cell]]) });
    m.request(cx + ',' + cz); m.step(50);
    return (x, z) => m.heightAt(x0 + x, z0 + z);
  };
  const pr = at(-797, -52);
  assert.equal(pr(60, 20), 0, 'grass 40 m from the way across the Old Town Square');
  assert.equal(pr(60, 100), 0);
  assert.equal(pr(110, 110), MOWN, 'the lawn on the square lost its grass');
  assert.equal(pr(60, 115), UNMAPPED, 'the square rule reaches past 45 m');
  // the same layout in Pardubice keeps the old rule: one way seals only itself
  const pa = at(12, -6);
  assert.equal(pa(60, 20), UNMAPPED);
});

// ---- the worker builds the footprint-less pieces as the main thread does ------
function worldFor(key) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const [kx, kz] = key.split(',').map(Number);
  const tx = Math.floor(kx * CHUNK / 4800), tz = Math.floor(kz * CHUNK / 4800);
  const cell = { buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const terrain = new Terrain(4800, 20);
  const g = new Int16Array(terrain.n * terrain.n);
  for (let j = 0; j < terrain.n; j++) for (let i = 0; i < terrain.n; i++) g[j * terrain.n + i] = Math.round((188 + Math.sin(i * 0.3) * 1.2) * 10);
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

test('a chunk holding a piece of Charles Bridge or the Hus monument comes back from the worker the same', () => {
  const keys = [chunkKey(HUS[0], HUS[1]), chunkKey(...axisAt(PIERS[4]).slice(0, 2))];
  for (const key of keys) {
    const [cx, cz] = key.split(',').map(Number);
    const world = worldFor(key);
    const sync = buildChunkMeshes(world.city, cx, cz, world.mats, 'full');
    const lmA = [];
    sync?.traverse((o) => { if (o.isMesh && o.material === world.mats.landmark) lmA.push(o); });
    assert.equal(lmA.length, 1, `chunk ${key}: no landmark mesh on the main thread`);
    const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
    const { reply } = handleMessage(makeWorkerState(), { t: 'build', id: 1, spec: structuredClone(got.spec, { transfer: got.transfer }) });
    assert.equal(reply.t, 'done', `the worker failed chunk ${key}: ${reply.error}`);
    const decMats = { ...world.mats, codecMats: {} };
    for (const k of Object.keys(reply.brands)) decMats.codecMats[k] = world.wordmark;
    const back = decode(reply.payload, decMats);
    sync.updateMatrixWorld(true); back.updateMatrixWorld(true);
    const lmB = [];
    back.traverse((o) => { if (o.isMesh && o.material === world.mats.landmark) lmB.push(o); });
    assert.equal(lmB.length, 1, `chunk ${key}: the landmark mesh did not come back`);
    const A = lmA[0].geometry.attributes.position, B = lmB[0].geometry.attributes.position;
    assert.equal(B.count, A.count, `chunk ${key}: vertex count`);
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let worst = 0;
    for (let v = 0; v < A.count; v++) {
      p.fromBufferAttribute(A, v).applyMatrix4(lmA[0].matrixWorld);
      q.fromBufferAttribute(B, v).applyMatrix4(lmB[0].matrixWorld);
      worst = Math.max(worst, p.distanceTo(q));
    }
    assert.ok(worst < MAX_ERR, `chunk ${key}: ${(worst * 1000).toFixed(2)} mm between the two paths`);
  }
});
