// The hand-made landmarks of Pardubice (js/landmarks*.js), against the REAL
// tile they are meant for: public/data/tiles/0_-1.json. Three things can go
// wrong with a model pinned to a footprint and none of them shows in a
// screenshot taken today:
//   · a tile rebuild reorders or nudges the footprints and the model lands on
//     the wrong house, or on none;
//   · the mesher worker builds a different chunk than the main thread, so the
//     tower changes shape when its chunk is re-meshed;
//   · the gate that is meant to be walked through is solid.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { LANDMARKS, SWITCH, matches, landmarkOf, LandmarkBatch, landmarkSolids, solidHas, inLandmark } = await import('../js/landmarks.js');
const { ringArea, ringCentroid, obbOf } = await import('../js/landmarkskit.js');
const { fitFrame } = await import('../js/landmarksframe.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, handleMessage } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity } = await import('../js/geo.js');
const { pointInPolygon } = await import('../js/geo.js');

const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/0_-1.json', import.meta.url), 'utf8'));
const GROUND = 221;
const copy = (f) => JSON.parse(JSON.stringify(f));
/** The footprint each entry matches in the tile as shipped. */
const found = new Map();
for (const f of tile.buildings) for (const l of LANDMARKS) if (matches(l, f)) {
  assert.ok(!found.has(l.id), `${l.id} matches two footprints`);
  found.set(l.id, f);
}

test('every landmark finds exactly one footprint in the shipped tile, and no footprint two', () => {
  for (const l of LANDMARKS) assert.ok(found.has(l.id), `${l.id} matches nothing in tile 0_-1`);
  for (const f of tile.buildings) {
    const n = LANDMARKS.filter((l) => matches(l, f)).length;
    assert.ok(n <= 1, `one footprint is ${n} landmarks`);
  }
  assert.ok(LANDMARKS.length >= 8, 'fewer than eight landmarks registered');
});

test('a landmark is found by where and how big it is, not by its place in the tile', () => {
  for (const l of LANDMARKS) {
    const f = copy(found.get(l.id));
    // what a rebuild does: the ring starts elsewhere, runs the other way, every
    // vertex lands up to 40 cm off, and the name may be gone
    const k = 3 % f.o.length;
    f.o = f.o.slice(k).concat(f.o.slice(0, k)).reverse()
      .map(([x, z], i) => [x + 0.4 * Math.sin(i * 1.7), z + 0.4 * Math.cos(i * 2.3)]);
    delete f.n;
    assert.ok(matches(l, f), `${l.id} lost after a nudge`);
    assert.equal(landmarkOf(f), l, `${l.id}: landmarkOf disagrees with matches`);
    assert.equal(f._lm, l.id, 'the answer is remembered as plain data');
    // ...and what must NOT match: the neighbour 40 m away, a redrawn outline,
    // a building that carries somebody else's name
    const moved = copy(found.get(l.id)); moved.o = moved.o.map(([x, z]) => [x + 40, z]);
    assert.ok(!matches(l, moved), `${l.id} matched 40 m from where it stands`);
    const [cx, cz] = ringCentroid(f.o);
    const grown = copy(found.get(l.id)); grown.o = grown.o.map(([x, z]) => [cx + (x - cx) * 1.4, cz + (z - cz) * 1.4]);
    assert.ok(!matches(l, grown), `${l.id} matched an outline twice the size`);
    if (l.name) {
      const other = copy(found.get(l.id)); other.n = 'Penny Market';
      assert.ok(!matches(l, other), `${l.id} matched a footprint with another name`);
    }
  }
  const house = { o: [[1500, -700], [1510, -700], [1510, -690], [1500, -690]], h: 9 };
  assert.equal(landmarkOf(house), null);
  assert.equal(house._lm, '', 'a plain house is remembered as not a landmark');
});

const BY = (id) => LANDMARKS.find((l) => l.id === id);
/** One landmark built alone, as plain arrays. */
function build(l, f) {
  const b = new LandmarkBatch();
  b.add(l, f, GROUND);
  return b.sink;
}

test('each model stands on its own footprint, on the ground, and is sound geometry', () => {
  let total = 0;
  for (const l of LANDMARKS) {
    const f = found.get(l.id), s = build(l, f);
    assert.ok(s.tris > 100, `${l.id} is only ${s.tris} triangles`);
    assert.ok(s.tris < 12000, `${l.id} is ${s.tris} triangles: over budget`);
    total += s.tris;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < s.pos.length; i += 3) {
      const x = s.pos[i], y = s.pos[i + 1], z = s.pos[i + 2];
      assert.ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${l.id}: a vertex is not a number`);
      const n = Math.hypot(s.nrm[i], s.nrm[i + 1], s.nrm[i + 2]);
      assert.ok(Math.abs(n - 1) < 1e-6, `${l.id}: a normal of length ${n}`);
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    // the codec ships both uv pairs as u16 only while they stay inside 0..1
    for (const a of [s.uv, s.uv1, s.col]) for (const v of a)
      assert.ok(v >= 0 && v <= 1, `${l.id}: an attribute value of ${v}`);
    // on the footprint: the model's box is the footprint's box, give or take
    // eaves, buttresses and a balcony (3.5 m)
    let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
    for (const [x, z] of f.o) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z); }
    const slack = 3.5;
    assert.ok(x0 > fx0 - slack && x1 < fx1 + slack && z0 > fz0 - slack && z1 < fz1 + slack,
      `${l.id} overhangs its footprint: model ${[x0, x1, z0, z1].map((v) => v.toFixed(1))} footprint ${[fx0, fx1, fz0, fz1].map((v) => v.toFixed(1))}`);
    assert.ok(x0 < fx0 + slack + 2 && x1 > fx1 - slack - 2 && z0 < fz0 + slack + 2 && z1 > fz1 - slack - 2,
      `${l.id} does not fill its footprint`);
    if (l.sky) assert.ok(y0 > GROUND + 6, 'the bridge is a bridge: nothing of it reaches the yard');
    // (the chateau and its gatehouse reach 1.5 to 1.8 m down on purpose: the
    // palace's footprint falls three metres to the north and both passages
    // climb, so a wall founded at one height would float over the low side
    // and a passage wall would leave a slot under it. Everything else starts
    // at its ground.)
    else if (l.id.startsWith('zamek')) assert.ok(y0 - GROUND > -1.85 && y0 - GROUND < 0.01, `${l.id} starts ${(y0 - GROUND).toFixed(2)} m off its ground`);
    else assert.ok(Math.abs(y0 - GROUND) < 0.01, `${l.id} starts ${(y0 - GROUND).toFixed(2)} m off its ground`);
    assert.ok(y1 - GROUND > 8, `${l.id} is only ${(y1 - GROUND).toFixed(1)} m tall`);
    if (l.id === 'zelena-brana') assert.ok(Math.abs(y1 - GROUND - 59) < 1, `Zelená brána is 59 m, the model ${(y1 - GROUND).toFixed(1)}`);
  }
  assert.ok(total < 60000, `the landmarks are ${total} triangles in all`);
});

test('the same footprint gives the same model, whichever vertex the ring starts at', () => {
  for (const l of LANDMARKS) {
    const f = found.get(l.id);
    const a = build(l, f), b = build(l, copy(f));
    assert.deepEqual(a.pos, b.pos, `${l.id} is not deterministic`);
    assert.deepEqual(a.uv1, b.uv1);
    // a rebuilt ring: other start, other winding. The frame comes from the
    // shape and a compass hint, so the model must come out the same size and
    // in the same place (vertex order may differ, the box may not)
    const g = copy(f), k = 5 % g.o.length;
    g.o = g.o.slice(k).concat(g.o.slice(0, k)).reverse();
    const c = build(l, g);
    assert.equal(c.tris, a.tris, `${l.id} changes triangle count with the ring's start`);
    const box = (s) => {
      const o = [Infinity, -Infinity, Infinity, -Infinity, -Infinity];
      for (let i = 0; i < s.pos.length; i += 3) {
        o[0] = Math.min(o[0], s.pos[i]); o[1] = Math.max(o[1], s.pos[i]);
        o[2] = Math.min(o[2], s.pos[i + 2]); o[3] = Math.max(o[3], s.pos[i + 2]); o[4] = Math.max(o[4], s.pos[i + 1]);
      }
      return o;
    };
    const p = box(a), q = box(c);
    for (let i = 0; i < 5; i++) assert.ok(Math.abs(p[i] - q[i]) < 0.02, `${l.id} moved ${Math.abs(p[i] - q[i]).toFixed(2)} m with the ring's start`);
  }
});

test('the Green Gate and its fore-gate can be walked through, and only they', () => {
  for (const id of ['zelena-brana', 'predbrani']) {
    const f = copy(found.get(id));
    const all = landmarkSolids(f);
    // what stops somebody on the ground: the two walls. The third piece is the
    // masonry over the arch, which a walker passes under (city.js collide)
    const rings = all.filter((s) => s.bot <= 0.5).map((s) => s.ring);
    assert.equal(rings.length, 2, `${id} should be two walls beside a passage`);
    const over = all.filter((s) => s.bot > 0.5);
    assert.equal(over.length, 1, `${id} should be solid over its arch`);
    assert.ok(over[0].bot > 4 && over[0].top > over[0].bot + 4);
    const o = obbOf(f.o);
    assert.ok(solidHas(over[0], o.cx, o.cz), `the masonry over the arch of ${id} is not over its middle`);
    const inSolid = (x, z) => rings.some((r) => pointInPolygon(x, z, r));
    assert.ok(!inSolid(o.cx, o.cz), `the middle of ${id} is solid`);
    // the street runs east-north-east through both: 3 m along it is still clear,
    // 3.3 m across it is masonry
    const ax = 0.907, az = -0.421;
    for (const t of [-3, -1.5, 1.5, 3]) assert.ok(!inSolid(o.cx + ax * t, o.cz + az * t), `${id}: the passage is blocked ${t} m along`);
    for (const t of [-3.3, 3.3]) assert.ok(inSolid(o.cx - az * t, o.cz + ax * t), `${id}: no wall ${t} m beside the passage`);
    // every solid lies inside the footprint's own rectangle: the passage adds no collision
    for (const r of rings) for (const [x, z] of r) {
      const a = (x - o.cx) * o.ux + (z - o.cz) * o.uz, b = -(x - o.cx) * o.uz + (z - o.cz) * o.ux;
      assert.ok(Math.abs(a) < o.hl + 0.05 && Math.abs(b) < o.hw + 0.05);
    }
  }
  assert.equal(landmarkSolids({ o: [[0, 0], [9, 0], [9, 9], [0, 9]] }), null);
});

test('the passages are paved: no gate leaves the aerial photo of its own roof for a floor', () => {
  for (const id of ['zelena-brana', 'predbrani']) {
    const f = copy(found.get(id));
    f._gfall = 0.5;                       // a footprint on a slope, as groundFor would leave it
    const s = build(BY(id), f), o = obbOf(f.o);
    // an upward triangle a hand above the ground, under the middle of the gate
    let floor = false;
    for (let i = 0; i < s.pos.length && !floor; i += 9) {
      if (s.nrm[i + 1] < 0.99) continue;
      const y = s.pos[i + 1] - GROUND;
      if (y < 0.4 || y > 0.5) continue;   // four fifths of the fall, and 4 cm
      const tri = [[s.pos[i], s.pos[i + 2]], [s.pos[i + 3], s.pos[i + 5]], [s.pos[i + 6], s.pos[i + 8]]];
      floor = pointInPolygon(o.cx, o.cz, tri) || pointInPolygon(o.cx + 0.3, o.cz + 0.2, tri);
    }
    assert.ok(floor, `${id} has no floor in its passage`);
  }
});

test('a landmark is solid as high as its model stands, not as high as the tile guessed', () => {
  const at = (id, x, z, y) => landmarkSolids(found.get(id)).some((s) => y >= s.bot && y <= s.top && solidHas(s, x, z));
  for (const l of LANDMARKS) {
    const f = found.get(l.id), sink = build(l, f);
    let top = 0;
    for (let i = 1; i < sink.pos.length; i += 3) top = Math.max(top, sink.pos[i] - GROUND);
    const all = landmarkSolids(f);
    assert.ok(all.length >= 1, `${l.id} has no solid`);
    let fx0 = Infinity, fx1 = -Infinity, fz0 = Infinity, fz1 = -Infinity;
    for (const [x, z] of f.o) { fx0 = Math.min(fx0, x); fx1 = Math.max(fx1, x); fz0 = Math.min(fz0, z); fz1 = Math.max(fz1, z); }
    for (const s of all) {
      assert.ok(s.ring.length >= 3 && s.top > s.bot, `${l.id}: a solid of no size`);
      assert.ok(s.top <= top + 0.01, `${l.id} is solid to ${s.top} m, the model only stands ${top.toFixed(1)}`);
      for (const [x, z] of s.ring) assert.ok(x > fx0 - 1 && x < fx1 + 1 && z > fz0 - 1 && z < fz1 + 1, `${l.id}: a solid outside its footprint`);
    }
    // nothing invisible above the model (above), and its walls are there: only
    // roofs and spires rise over the solid, as on every other building
    // (9 m for every tall model; the chateau's gatehouse has 7 m walls under a
    // 3.3 m hipped roof, and its roof is flown through like any other)
    const hi = Math.max(...all.map((s) => s.top));
    assert.ok(hi >= Math.min(9, top * 0.65), `${l.id} is solid only to ${hi} m of ${top.toFixed(1)}`);
  }
  // the station: the hotel stands over the hall, the hall over the wings
  const st = found.get('nadrazi');
  const { F } = fitFrame(null, st.o, 0, -1, true);
  const [hx, hz] = F.xz(38, -6), [ax, az] = F.xz(-14, -6), [wx, wz] = F.xz(-110, -18);
  assert.ok(at('nadrazi', hx, hz, 22) && !at('nadrazi', hx, hz, 24), 'the hotel is not 23.4 m of solid');
  assert.ok(at('nadrazi', ax, az, 10) && !at('nadrazi', ax, az, 12), 'the hall is not 10.6 m of solid');
  assert.ok(at('nadrazi', wx, wz, 6) && !at('nadrazi', wx, wz, 9), 'a wing is not 7.3 m of solid');
  // the chateau: its courtyards are open, its wings are not
  const za = found.get('zamek');
  const hole = za.i.find((h) => h.length >= 3), [cx, cz] = ringCentroid(hole);
  assert.ok(!at('zamek', cx, cz, 5), 'the chateau courtyard is solid');
  const zf = fitFrame(null, za.o, -0.33, 0.94).F, [tx, tz] = zf.xz(-9, 4), [ex, ez] = zf.xz(20, 0);
  assert.ok(at('zamek', ex, ez, 12) && !at('zamek', ex, ez, 16), 'the east wing is not solid to its cornice');
  assert.ok(at('zamek', tx, tz, 28), 'the clock tower is flown through');
  // the bridge is solid in the air only
  const mo = found.get('mlyny-most'), [mx, mz] = ringCentroid(mo.o);
  assert.ok(at('mlyny-most', mx, mz, 14) && !at('mlyny-most', mx, mz, 4));
});

test('the frame of a footprint follows a compass hint, not the vertex order', () => {
  const ring = [[0, 0], [30, 0], [30, 10], [0, 10]];
  for (const [hx, hz] of [[0, -1], [0, 1], [1, 0], [-1, 0]]) {
    const { F, hu, hv } = fitFrame(null, ring, hx, hz);
    assert.ok(F.nx * hx + F.nz * hz > 0.99, 'the front does not face the hint');
    assert.ok(Math.abs(hu * hv - 75) < 1e-6);
    // u is the right hand of somebody looking AT the front from outside
    const [ux, uz] = F.dir(1, 0);
    assert.ok(Math.abs(ux - F.nz) < 1e-9 && Math.abs(uz + F.nx) < 1e-9);
    const rev = fitFrame(null, ring.slice().reverse(), hx, hz);
    assert.ok(Math.abs(rev.F.nx - F.nx) < 1e-9 && Math.abs(rev.hu - hu) < 1e-9);
  }
  assert.ok(Math.abs(Math.abs(ringArea(ring)) - 300) < 1e-9);
});

// ---- the real chunks, on both sides of the wire ------------------------------
const CHUNK = 120;
const homeOf = (f) => Math.floor(f.o[0][0] / CHUNK) + ',' + Math.floor(f.o[0][1] / CHUNK);

function worldFor(key) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const buildings = tile.buildings.filter((f) => homeOf(f) === key).map((f) => {
    const g = copy(f); g._id = ++id; g._home = key; return g;
  });
  const cell = { buildings, roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  // a real slope, so a landmark founded at the wrong height would show
  const terrain = new Terrain(4800, 20);
  const g = new Int16Array(terrain.n * terrain.n);
  for (let j = 0; j < terrain.n; j++) for (let i = 0; i < terrain.n; i++)
    g[j * terrain.n + i] = Math.round((GROUND + Math.sin(i * 0.31) * 1.4 + Math.cos(j * 0.23) * 1.1) * 10);
  terrain.grids.set('0,-1', g);
  terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, terrain, canopy: null, ground: null, mats, wordmark, cell };
}

test('a chunk with a landmark comes back from the worker the same as it is built here', () => {
  const keys = [...new Set(LANDMARKS.map((l) => homeOf(found.get(l.id))))];
  let compared = 0, worst = 0, meshes = 0;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (const key of keys) {
    const [cx, cz] = key.split(',').map(Number);
    const world = worldFor(key);
    const here = world.cell.buildings.filter((f) => landmarkOf(f));
    assert.ok(here.length, `chunk ${key} holds no landmark after all`);
    const sync = buildChunkMeshes(world.city, cx, cz, world.mats, 'full');
    assert.ok(sync, `chunk ${key} built nothing`);
    const lmA = [];
    sync.traverse((o) => { if (o.isMesh && o.material === world.mats.landmark) lmA.push(o); });
    assert.equal(lmA.length, 1, `chunk ${key}: ${lmA.length} landmark meshes on the main thread, one expected`);
    assert.ok(lmA[0].castShadow && lmA[0].receiveShadow, 'a landmark casts and takes shadow');

    const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
    assert.ok(got, `chunkSpec refused chunk ${key}`);
    const { reply } = handleMessage(makeWorkerState(),
      { t: 'build', id: 1, spec: structuredClone(got.spec, { transfer: got.transfer }) });
    assert.equal(reply.t, 'done', `the worker failed chunk ${key}: ${reply.error}`);
    const decMats = { ...world.mats, codecMats: {} };
    for (const k of Object.keys(reply.brands)) decMats.codecMats[k] = world.wordmark;
    const back = decode(reply.payload, decMats);
    sync.updateMatrixWorld(true); back.updateMatrixWorld(true);
    const lmB = [];
    back.traverse((o) => { if (o.isMesh && o.material === world.mats.landmark) lmB.push(o); });
    assert.equal(lmB.length, 1, `chunk ${key}: the landmark mesh did not come back wearing its material`);
    const A = lmA[0].geometry.attributes, B = lmB[0].geometry.attributes;
    assert.deepEqual(Object.keys(B).sort(), Object.keys(A).sort(), `chunk ${key}: attribute set`);
    assert.equal(B.position.count, A.position.count, `chunk ${key}: vertex count`);
    for (let v = 0; v < A.position.count; v++) {
      p.fromBufferAttribute(A.position, v).applyMatrix4(lmA[0].matrixWorld);
      q.fromBufferAttribute(B.position, v).applyMatrix4(lmB[0].matrixWorld);
      const d = p.distanceTo(q);
      if (d > worst) worst = d;
      // material kind, window light, floodlight and pane coordinate all survive
      for (const name of ['uv', 'uv1']) for (let c = 0; c < 2; c++)
        assert.ok(Math.abs(B[name].getComponent(v, c) - A[name].getComponent(v, c)) < 2e-5,
          `chunk ${key}: ${name} of vertex ${v} changed on the wire`);
      // the kind must come back as the same whole number of sixteenths
      assert.equal(Math.round(B.uv.getX(v) * 16), Math.round(A.uv.getX(v) * 16));
      compared++;
    }
    // every generic building of the chunk is still there on both sides, minus the landmarks
    const count = (root) => { let n = 0; root.traverse((o) => { if (o.isMesh) n++; }); return n; };
    assert.equal(count(back), count(sync), `chunk ${key}: the two paths built a different set of meshes`);
    meshes++;
  }
  assert.ok(meshes >= 6, `only ${meshes} chunks compared`);
  assert.ok(compared > 60000, `only ${compared} landmark vertices compared`);
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm between the two paths`);
});

test('a landmark stays out of the generic mesh, and comes back when the switch is off', () => {
  const key = homeOf(found.get('zelena-brana'));
  const [cx, cz] = key.split(',').map(Number);
  const tris = (root, mat) => {
    let n = 0;
    root.traverse((o) => { if (o.isMesh && o.material === mat) n += o.geometry.attributes.position.count / 3; });
    return n;
  };
  const on = worldFor(key);
  const a = buildChunkMeshes(on.city, cx, cz, on.mats, 'full');
  // the shell tier, which drops small buildings, must not drop a landmark
  const shell = worldFor(key);
  shell.mats.shellLod = true;
  const s = buildChunkMeshes(shell.city, cx, cz, shell.mats, 'shell');
  assert.equal(tris(s, shell.mats.landmark), tris(a, on.mats.landmark), 'the shell tier builds a different landmark');
  // a hidden id (a near shell that somehow got made) cannot take it out either
  const hid = worldFor(key);
  for (const f of hid.cell.buildings) if (landmarkOf(f)) hid.mats.hidden.add(f._id);
  const h = buildChunkMeshes(hid.city, cx, cz, hid.mats, 'full');
  assert.equal(tris(h, hid.mats.landmark), tris(a, on.mats.landmark));
  SWITCH.on = false;
  try {
    const off = worldFor(key);
    const b = buildChunkMeshes(off.city, cx, cz, off.mats, 'full');
    assert.equal(tris(b, off.mats.landmark), 0, 'switched off, a landmark mesh was still built');
    assert.ok(tris(b, off.mats._facadeMat) > tris(a, on.mats._facadeMat),
      'the generic mesh did not shrink when the landmarks took their footprints');
  } finally { SWITCH.on = true; }
});

test('a prop the tile puts inside a landmark is not drawn in its passage', () => {
  // OSM maps the relief on the fore-gate as a statue node, 30 cm inside its west arch
  const statue = tile.furniture.find((p) => p.k === 'statue' && Math.hypot(p.p[0] - 1551.6, p.p[1] + 693) < 1);
  assert.ok(statue, 'the statue node in the fore-gate is gone from the tile: this test wants another example');
  assert.ok(inLandmark([found.get('predbrani')], statue.p[0], statue.p[1]));
  assert.ok(!inLandmark([found.get('predbrani')], statue.p[0] - 6, statue.p[1] + 3), 'a prop on the pavement outside was taken too');
  assert.ok(!inLandmark([{ o: [[1540, -700], [1560, -700], [1560, -680], [1540, -680]] }], statue.p[0], statue.p[1]), 'a plain house swallowed a prop');
  // ...and through the real chunk build: with the statue as the chunk's only
  // prop the ground mesh is the same as with none, on this side of the wire
  const key = homeOf(found.get('predbrani'));
  const [cx, cz] = key.split(',').map(Number);
  const verts = (withProp) => {
    const w = worldFor(key);
    if (withProp) w.cell.furniture = [{ p: [statue.p], k: statue.k, a: statue.a, _id: 99001 }];
    let n = 0;
    buildChunkMeshes(w.city, cx, cz, w.mats, 'full').traverse((o) => { if (o.isMesh) n += o.geometry.attributes.position.count; });
    return n;
  };
  assert.equal(verts(true), verts(false), 'the statue was drawn inside the fore-gate');
  SWITCH.on = false;
  try { assert.ok(verts(true) > verts(false), 'this test cannot see a prop at all'); } finally { SWITCH.on = true; }
});
