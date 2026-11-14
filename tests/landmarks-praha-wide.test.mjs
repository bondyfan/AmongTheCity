// The wide Prague landmarks (js/landmarks-hrad.js and the builders it
// registers) and the far skyline (js/landmarksfar.js), against the REAL tiles
// and terrain they are meant for: tiles -21_-2, -20_-2 and -20_-1. What would
// go wrong unseen in a screenshot taken today:
//   · a model lands on the wrong footprint, on two, or on none; a duplicate
//     ring at Žižkov is drawn twice, or a hide entry eats a neighbour;
//   · the worker builds another chunk than the main thread;
//   · the Matthias Gate is solid, or the castle wing beside it is not;
//   · the far skyline's baked frames drift away from the near models.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { LANDMARKS, matches, landmarkOf, LandmarkBatch, landmarkSolids, solidHas, landmarkProp, landmarkClear } = await import('../js/landmarks.js');
const { ringArea, ringCentroid } = await import('../js/landmarkskit.js');
const { fitFrame } = await import('../js/landmarksframe.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain, groundFor } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, handleMessage } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity } = await import('../js/geo.js');
const { CHUNK } = await import('../js/config.js');
const { FAR_SET, buildFar } = await import('../js/landmarksfar.js');
const { FAR_GROUND, buildFarGround } = await import('../js/landmarks-farground.js');
const { Kit, LandmarkSink } = await import('../js/landmarkskit.js');

const KEYS = ['-21_-2', '-20_-2', '-20_-1'];
const TILES = Object.fromEntries(KEYS.map((k) => [k, JSON.parse(readFileSync(new URL(`../public/data/tiles/${k}.json`, import.meta.url), 'utf8'))]));
const terrain = new Terrain(4800, 20);
for (const k of [...KEYS, '-21_-1']) {
  const b = readFileSync(new URL(`../public/data/terrain/${k}.bin`, import.meta.url));
  terrain.grids.set(k.replace('_', ','), new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + terrain.n * terrain.n * 2)));
}
terrain._loads = 1;
const copy = (f) => JSON.parse(JSON.stringify(f));
const PRAHA = LANDMARKS.filter((l) => l.region === 'praha');
// every Prague entry takes part in the matching checks (a hide entry must not eat an old-town
// footprint either), but the models checked here are this package's own (js/landmarks-hrad.js)
const { LANDMARKS_WIDE } = await import('../js/landmarks-hrad.js');
const WIDE = new Set(LANDMARKS_WIDE.map((l) => l.id));
const MAIN = PRAHA.filter((l) => !l.hide && WIDE.has(l.id));

/** Every footprint of the three tiles each Prague entry matches: [tileKey, index, feature]. */
const hits = new Map(PRAHA.map((l) => [l.id, []]));
for (const k of KEYS) TILES[k].buildings.forEach((f, i) => { for (const l of PRAHA) if (matches(l, f)) hits.get(l.id).push([k, i, f]); });
const found = (id) => hits.get(id)[0][2];

test('each wide Prague landmark finds exactly one footprint, and no footprint is two landmarks', () => {
  assert.ok(MAIN.length >= 8, 'fewer than eight wide landmarks registered');
  for (const l of MAIN) assert.equal(hits.get(l.id).length, 1, `${l.id} matches ${hits.get(l.id).length} footprints`);
  for (const k of KEYS) for (const f of TILES[k].buildings) {
    const n = PRAHA.filter((l) => matches(l, f)).length;
    assert.ok(n <= 1, `one footprint is ${n} landmarks`);
  }
  // first match wins in landmarkOf; it must agree with matches()
  for (const l of MAIN) { const f = copy(found(l.id)); assert.equal(landmarkOf(f)?.id, l.id); }
});

test('the hide entries take out only the duplicates they are meant for', () => {
  // Žižkov: eleven rings of one tower; the theatre: the porch the model builds
  const expected = { 'zizkov-x1': 3, 'zizkov-x2': 2, 'zizkov-x3': 2, 'zizkov-x4': 1, 'zizkov-x5': 1, 'zizkov-x6': 1, 'zizkov-x7': 1, 'nd-sever': 1 };
  for (const l of PRAHA.filter((e) => e.hide)) {
    const h = hits.get(l.id);
    assert.equal(h.length, expected[l.id], `${l.id} hides ${h.length} footprints`);
    for (const [, , f] of h) {
      const [cx, cz] = ringCentroid(f.o);
      const home = l.id.startsWith('zizkov') ? [-93500, -5486] : [-96195, -5516];
      assert.ok(Math.hypot(cx - home[0], cz - home[1]) < 12, `${l.id} hides a footprint ${Math.hypot(cx - home[0], cz - home[1]).toFixed(0)} m away`);
    }
    const s = new LandmarkBatch(); s.add(l, copy(h[0][2]), 250, terrain); assert.equal(s.sink.tris, 0, `${l.id} draws something`);
    const f = copy(h[0][2]); assert.deepEqual(landmarkSolids(f), [], `${l.id} is solid`);
  }
});

/** One landmark built alone on the real terrain, as plain arrays. */
function build(l, f) {
  const b = new LandmarkBatch();
  const g = groundFor(f, terrain);
  b.add(l, f, g, terrain);
  return { s: b.sink, g };
}

test('each wide model is sound geometry, on its footprint and within its triangle budget', () => {
  let total = 0;
  for (const l of MAIN) {
    const f = copy(found(l.id)), { s, g } = build(l, f);
    const budget = l.id === 'hrad' ? 20000 : 15000;
    assert.ok(s.tris > 500, `${l.id} is only ${s.tris} triangles`);
    assert.ok(s.tris < budget, `${l.id} is ${s.tris} triangles: over budget`);
    total += s.tris;
    let y1 = -Infinity;
    for (let i = 0; i < s.pos.length; i += 3) {
      assert.ok(Number.isFinite(s.pos[i]) && Number.isFinite(s.pos[i + 1]) && Number.isFinite(s.pos[i + 2]), `${l.id}: a vertex is not a number`);
      assert.ok(Math.abs(Math.hypot(s.nrm[i], s.nrm[i + 1], s.nrm[i + 2]) - 1) < 1e-6, `${l.id}: a normal is not unit`);
      if (s.pos[i + 1] > y1) y1 = s.pos[i + 1];
    }
    for (const a of [s.uv, s.uv1, s.col]) for (const v of a) assert.ok(v >= 0 && v <= 1, `${l.id}: an attribute value of ${v}`);
    // the same footprint, the ring started elsewhere and run backwards, gives the same model
    const g2 = copy(found(l.id)); g2.o = g2.o.slice(5).concat(g2.o.slice(0, 5)).reverse();
    const b2 = build(l, g2).s;
    assert.ok(Math.abs(b2.tris - s.tris) <= s.tris * 0.02, `${l.id}: ${s.tris} triangles, ${b2.tris} from the reordered ring`);
    // a second build is the same, triangle for triangle
    const again = build(l, copy(found(l.id))).s;
    assert.deepEqual(again.pos, s.pos, `${l.id} is not deterministic`);
    const tall = { hrad: 40, vit: 96, nd: 30, tancici: 28, nm: 60, zizkov: 215, petrin: 63, vysehrad: 57 }[l.id];
    if (tall) assert.ok(y1 - g > tall, `${l.id} is only ${(y1 - g).toFixed(1)} m tall`);
  }
  assert.ok(total < 90000, `the wide landmarks are ${total} triangles in all`);
});

test('the Matthias Gate is open and the wing either side of it is solid', () => {
  const f = copy(found('hrad'));
  groundFor(f, terrain);
  const S = landmarkSolids(f), g = f._gy;
  const solid = (x, z, y) => S.some((s) => solidHas(s, x, z) && y >= s.bot && y < s.top);
  const above = (x, z, h) => terrain.heightAt(x, z) - g + h;
  assert.ok(!solid(-97271, -6524, above(-97271, -6524, 1.5)), 'the passage is solid at head height');
  assert.ok(solid(-97271, -6524, above(-97271, -6524, 12)), 'nothing over the passage');
  for (const [x, z] of [[-97266, -6514], [-97270.5, -6530], [-97264, -6522]]) assert.ok(solid(x, z, above(x, z, 1.5)), `the wing at ${x},${z} is open`);
  for (const [x, z] of [[-97228, -6513], [-97292, -6530]]) assert.ok(!solid(x, z, above(x, z, 1.5)), `the courtyard at ${x},${z} is solid`);
  // the walls are founded on the ground under them: no wall of the court floats
  const { s } = build(LANDMARKS.find((l) => l.id === 'hrad'), copy(found('hrad')));
  let low = Infinity;
  for (let i = 1; i < s.pos.length; i += 3) low = Math.min(low, s.pos[i]);
  assert.ok(low < g + 0.5, 'the castle does not reach its lowest ground');
});

test('the tower and the lookout are open where they are open', () => {
  const pz = copy(found('petrin')); groundFor(pz, terrain);
  const P = landmarkSolids(pz), [cx, cz] = ringCentroid(pz.o);
  const at = (S, x, z, y) => S.some((s) => solidHas(s, x, z) && y >= s.bot && y < s.top);
  assert.ok(!at(P, cx + 10, cz, 8), 'Petřín is a solid box between its legs');
  assert.ok(at(P, cx, cz, 30), 'Petřín has no core');
  const zz = copy(found('zizkov')); groundFor(zz, terrain);
  const Z = landmarkSolids(zz);
  assert.ok(at(Z, -93503.5, -5485.3 - 3.5, 93 + 2), 'the observation cabin is not solid');
  assert.ok(Z.some((s) => s.top > 170), 'the main tube is not solid to the radome');
});

test('the props the wide landmarks replace are not drawn, and the courtyards keep no trees', () => {
  assert.ok(landmarkProp(-95032.3, -5347.1), 'the memorial boxes under St Wenceslas');
  assert.ok(landmarkProp(-95034, -5345), 'a saint beside him');
  assert.ok(!landmarkProp(-95060, -5380), 'a bench down the square');
  assert.ok(!landmarkProp(1565, -700), 'a prop in Pardubice');
  assert.ok(landmarkClear(-97228, -6513) && landmarkClear(-97295, -6530), 'trees in the castle courtyards');
});

function worldFor(key) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const [cx, cz] = key.split(',').map(Number);
  const buildings = [];
  for (const k of KEYS) for (const f of TILES[k].buildings)
    if (Math.floor(f.o[0][0] / CHUNK) === cx && Math.floor(f.o[0][1] / CHUNK) === cz) { const g = copy(f); g._id = ++id; g._home = key; buildings.push(g); }
  const cell = { buildings, roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, terrain, canopy: null, ground: null, mats, wordmark, cell };
}

test('a Prague chunk with a wide landmark comes back from the worker the same as it is built here', () => {
  const keys = [...new Set(MAIN.map((l) => { const f = found(l.id); return Math.floor(f.o[0][0] / CHUNK) + ',' + Math.floor(f.o[0][1] / CHUNK); }))];
  let compared = 0, worst = 0;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const key of keys) {
    const [cx, cz] = key.split(',').map(Number);
    const world = worldFor(key);
    const sync = buildChunkMeshes(world.city, cx, cz, world.mats, 'full');
    const lmA = [];
    sync.traverse((o) => { if (o.isMesh && o.material === world.mats.landmark) lmA.push(o); });
    assert.equal(lmA.length, 1, `chunk ${key}: ${lmA.length} landmark meshes`);
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
    const A = lmA[0].geometry.attributes, B = lmB[0].geometry.attributes;
    assert.equal(B.position.count, A.position.count, `chunk ${key}: vertex count`);
    for (let v = 0; v < A.position.count; v++) {
      p.fromBufferAttribute(A.position, v).applyMatrix4(lmA[0].matrixWorld);
      q.fromBufferAttribute(B.position, v).applyMatrix4(lmB[0].matrixWorld);
      worst = Math.max(worst, p.distanceTo(q));
      assert.equal(Math.round(B.uv.getX(v) * 16), Math.round(A.uv.getX(v) * 16));
      compared++;
    }
  }
  assert.ok(keys.length >= 7, `only ${keys.length} chunks compared`);
  assert.ok(compared > 100000, `only ${compared} vertices compared`);
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm between the two paths`);
});

test('the far skyline stands where the near models do, and builds the same every time', () => {
  // each baked frame is the near builder's own fitFrame on the shipped footprint
  const hint = { vit: [-0.93, 0.36], nm: [-0.67, -0.74], petrin: [0, -1], vysehrad: [-1, 0] };
  for (const e of FAR_SET) {
    const g1 = buildFar(e), g2 = buildFar(e);
    assert.ok(g1 && g1.attributes.position.count > 0, `${e.id} builds nothing`);
    assert.ok(g1.attributes.position.count / 3 < 9000, `${e.id} is too heavy for a silhouette`);
    assert.deepEqual(Array.from(g1.attributes.position.array), Array.from(g2.attributes.position.array), `${e.id} is not deterministic`);
    for (const a of ['uv', 'uv1', 'color']) for (const v of g1.attributes[a].array) assert.ok(v >= 0 && v <= 1);
    if (hint[e.id]) {
      const f = found(e.id), { F } = fitFrame(null, f.o, ...hint[e.id]);
      if (e.id === 'petrin') { const [cx, cz] = ringCentroid(f.o); assert.ok(Math.hypot(cx - e.frame[0], cz - e.frame[1]) < 0.1, 'Petřín far is off its centre'); }
      else {
        assert.ok(Math.hypot(F.ox - e.frame[0], F.oz - e.frame[1]) < 0.1, `${e.id}: far frame ${e.frame} vs near ${F.ox},${F.oz}`);
        assert.ok(F.nx * e.frame[2] + F.nz * e.frame[3] > 0.9999, `${e.id}: far frame faces elsewhere`);
      }
      assert.ok(Math.abs(groundFor(copy(f), terrain) - e.ground) < 0.05, `${e.id}: far ground ${e.ground}`);
    }
  }
  for (const g of FAR_GROUND) {
    const s = new LandmarkSink(); buildFarGround(new Kit(s, 0), terrain, g.box);
    assert.ok(s.tris > 100, `far ground ${g.id} is empty`);
    for (let i = 1; i < s.pos.length; i += 3) assert.ok(s.pos[i] > 150 && s.pos[i] < 400, `far ground ${g.id} at ${s.pos[i]}`);
  }
});
