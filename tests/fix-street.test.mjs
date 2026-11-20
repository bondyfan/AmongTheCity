// ---- street furniture, after the code review ---------------------------------
// Five defects the review confirmed on the real Pardubice tile, each pinned here
// on the smallest fixture that still produces it:
//
//   a lamp offset across a cell border stood in the NEIGHBOUR's carriageway or
//     on its junction pad (the mast was tested against its own cell's lists);
//   a lamp came up through a house on the building line;
//   a lamp stood in a bus lay-by, 0.7 m past the lane edge;
//   a "main road" sign on a curving approach stood in the lane of its own road;
//   a felled lamp or signal snapped round to world -z as it was hit.
//
// The lamp fixtures go through buildChunkMeshes, the way the game does, and the
// pad one is built a second time from its spec the way a mesh worker builds it:
// a rule the two threads disagree on is a chunk that changes when it is rebuilt.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const geo = await import('../js/geo.js');
const { cornerLift } = await import('../js/streets.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec, applySpec, withJunctions } = await import('../js/chunkspec.js');
const { plannedSigns } = await import('../js/streetsigns.js');
const { Poles } = await import('../js/poles.js');
const { LAYER_Y } = await import('../js/config.js');

const G = 221;
const way = (id, t, w, p, extra) => ({ t, w, d: 1, v: 50, p, _id: id, _len: geo.polylineLength(p), ...extra });
const house = (id, o, extra) => ({ o, h: 4.3, t: 'residential', _id: id, ...extra });
const square = (x0, z0, x1, z1) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];

/** A little city from { key: { roads, buildings } }, indexed as loadCity would. */
function world(cells) {
  // the pad buckets are module state that only ever grows: one world at a time
  geo.JUNCTIONS.clear(); geo.CLUSTERS.clear();
  const chunkIndex = new Map(), all = new Set();
  for (const [key, c] of Object.entries(cells)) {
    for (const f of [...(c.roads ?? []), ...(c.buildings ?? [])]) {
      // a feature is homed where its first vertex is, as the tiles have it
      const q = (f.p ?? f.o)[0];
      f._home ??= geo.chunkKey(q[0], q[1]);
    }
    for (const r of c.roads ?? []) all.add(r);
    chunkIndex.set(key, { buildings: c.buildings ?? [], roads: c.roads ?? [], rails: [],
      water: [], green: [], paved: [], trees: [], signs: [], crossings: [], furniture: [],
      calming: [], barriers: [], power: [] });
  }
  const city = { chunkIndex, tile: 4800, pois: [], waterways: [] };
  geo.indexJunctions([...all]);
  geo.setStreetCity(city);
  const terrain = new Terrain(4800, 20);
  terrain.grids.set('0,0', new Int16Array(terrain.n * terrain.n).fill(G * 10));
  terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = false; mats.trees = false;
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, terrain, canopy: null, ground: null, mats };
}

/** The lamp plan a built chunk carries: { lampPosts: [x, z, rot, ...], parkPosts } */
function planOf(group) {
  const out = { lampPosts: [], parkPosts: [] };
  group?.traverse((o) => { if (o.name in out) out[o.name] = Array.from(o.userData.spots ?? []); });
  group?.traverse((o) => o.geometry?.dispose?.());
  return out;
}
const pairs = (flat) => { const o = []; for (let i = 0; i + 2 < flat.length; i += 3) o.push([flat[i], flat[i + 1]]); return o; };
const lampsMain = (w, cx, cz) => planOf(buildChunkMeshes(w.city, cx, cz, w.mats, 'full'));

/**
 * The same chunk from its spec, as js/meshworker.js builds it. A real worker has
 * ONLY the pad buckets the spec shipped and no city to derive a kerb from; this
 * process has all of them, so they are taken away for the length of the build.
 */
function lampsWorker(w, cx, cz, read = planOf) {
  const got = chunkSpec(w, cx, cz, 'full', null);
  const posted = structuredClone(got.spec);
  const J = new Map(geo.JUNCTIONS), C = new Map(geo.CLUSTERS);
  geo.JUNCTIONS.clear(); geo.CLUSTERS.clear(); geo.setStreetCity(null);
  try {
    const a = applySpec(posted, { terrain: null, canopy: null });
    return read(withJunctions(a.junctions, a.clusters,
      () => buildChunkMeshes(a.city, cx, cz, a.mats, 'full')));
  } finally {
    for (const [k, v] of J) geo.JUNCTIONS.set(k, v);
    for (const [k, v] of C) geo.CLUSTERS.set(k, v);
    geo.setStreetCity(w.city);
  }
}

const segD = (x, z, ax, az, bx, bz) => {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  let t = ((x - ax) * ex + (z - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + ex * t), z - (az + ez * t));
};
/** Distance from (x, z) to a way's centreline. */
function offLine(p, x, z) {
  let d = Infinity;
  for (let k = 0; k < p.length - 1; k++) d = Math.min(d, segD(x, z, p[k][0], p[k][1], p[k + 1][0], p[k + 1][1]));
  return d;
}

// ---- the neighbour's carriageway --------------------------------------------
test('a lamp offset across a cell border does not stand in the neighbour\'s road', () => {
  // A runs along the border inside cell 0,0. Its first mast falls at x = 54 on
  // the +z kerb, 5.2 m out: z = 121.2, which is cell 0,1, where B (bucketed
  // there alone, as its bbox is) has its lane.
  const A = way(1, 'secondary', 9, [[22, 116], [118, 116]]);
  const B = way(2, 'tertiary', 8, [[2, 122], [118, 122]]);
  const w = world({ '0,0': { roads: [A] }, '0,1': { roads: [B] } });
  const spots = pairs(lampsMain(w, 0, 0).lampPosts);
  assert.ok(spots.length >= 2, `only ${spots.length} lamps: the fixture lost its street`);
  for (const [x, z] of spots) {
    const inside = B.w / 2 - offLine(B.p, x, z);
    assert.ok(inside <= 0, `a mast at ${x.toFixed(1)}, ${z.toFixed(1)} stands ${inside.toFixed(2)} m `
      + 'inside the carriageway of the next cell');
  }
  // it went to the far kerb, it was not just deleted
  assert.ok(spots.some(([x, z]) => Math.abs(x - 54) < 0.1 && Math.abs(z - 110.8) < 0.1),
    'the mast at x = 54 did not move to the kerb that is free');
});

// ---- the neighbour's junction, on both threads --------------------------------
/** A crossing just inside cell 0,2, and a way that reaches it through cell 0,1. */
function padWorld() {
  // C is homed in 0,0 and only PASSES through 0,1: nothing is homed in the
  // cell that is built. Its station at z = 237 offsets a mast 5.2 m to either
  // side, onto the rounded corners of the crossing at (60, 244): pad asphalt
  // that is no way's own lane, and a pad bucketed under 0,2.
  const C = way(103, 'secondary', 9, [[60, 103], [60, 244]]);
  const C2 = way(104, 'secondary', 9, [[60, 244], [60, 356]]);
  const B1 = way(105, 'secondary', 9, [[2, 244], [60, 244]]);
  const B2 = way(106, 'secondary', 9, [[60, 244], [118, 244]]);
  return world({ '0,0': { roads: [C] }, '0,1': { roads: [C] }, '0,2': { roads: [C, C2, B1, B2] } });
}
function onPadAsphalt(x, z) {
  for (const j of geo.junctionsIn('0,2') ?? []) {
    const ring = geo.junctionHull(j);
    if (ring && geo.pointInPolygon(x, z, ring) && cornerLift(j, x, z) < 0) return true;
  }
  return false;
}

test('a lamp does not stand on the junction pad of the next cell', () => {
  const w = padWorld();
  assert.equal(geo.junctionsIn('0,1'), null, 'the fixture put a pad in the built cell');
  assert.ok(onPadAsphalt(65.2, 237) && onPadAsphalt(54.8, 237),
    'the fixture is wrong: neither kerb spot at z = 237 is on the pad');
  const spots = pairs(lampsMain(w, 0, 1).lampPosts);
  assert.ok(spots.length >= 2, `only ${spots.length} lamps along 120 m of street`);
  for (const [x, z] of spots) {
    assert.ok(!onPadAsphalt(x, z),
      `a mast stands on the asphalt of the crossing at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
});

test('the worker is sent the pads of all nine cells and plans the same lamps', () => {
  const w = padWorld();
  const { spec } = chunkSpec(w, 0, 1, 'full', null);
  assert.ok(spec.junctions?.['0,2']?.length,
    'no way is homed in cell 0,1, and the pad bucket of the next cell did not travel');
  const here = lampsMain(w, 0, 1), there = lampsWorker(w, 0, 1);
  assert.ok(here.lampPosts.length, 'no lamps at all');
  assert.deepEqual(there, here, 'the worker planned different lamps from the main thread');
});

// ---- the corner of the neighbour's junction ----------------------------------
// A pad is bucketed by its centre and drawn whole by that chunk, kerb band and
// all, so the corner of a crossing a few metres over the border is paving in
// THIS chunk. What a prop stands on (meshes.standingOn) asked its own bucket
// only: the lamp on that corner stood on the ground under the band, 32 cm
// under the paving here and over a metre under an embanked crossing.
/** Every street lamp of a built chunk with the height it stands at: [x, z, y]. */
function basesOf(group) {
  const out = [];
  group?.traverse((o) => {
    if (o.name !== 'lampPosts') return;
    const f = o.userData.spots ?? [], ys = o.userData.ys ?? [];
    for (let i = 0; i * 3 + 2 < f.length; i++) out.push([f[i * 3], f[i * 3 + 1], ys[i]]);
  });
  group?.traverse((o) => o.geometry?.dispose?.());
  return out;
}
/** A kerbed crossing 6 m inside cell 0,2, its street coming up through cell 0,1. */
function cornerWorld() {
  // (the ids of padWorld: where along a way its lamps fall is seeded by its id,
  // and with this one a mast comes at z = 237, 5.2 m off, on the rounded corner)
  const C = way(103, 'residential', 8, [[60, 103], [60, 246]]);
  const C2 = way(104, 'residential', 8, [[60, 246], [60, 356]]);
  const B1 = way(105, 'residential', 8, [[2, 246], [60, 246]]);
  const B2 = way(106, 'residential', 8, [[60, 246], [118, 246]]);
  // houses along the street: what makes it a kerbed one (js/streets.js)
  const hs = [];
  for (let z = 126, id = 500; z < 232; z += 20) {
    hs.push(house(++id, square(70, z, 80, z + 10), { _home: '0,1' }), house(++id, square(40, z, 50, z + 10), { _home: '0,1' }));
  }
  return world({ '0,0': { roads: [C] }, '0,1': { roads: [C], buildings: hs }, '0,2': { roads: [C, C2, B1, B2] } });
}

test('a lamp on the corner of the next cell\'s crossing stands on its paving, on both threads', () => {
  const w = cornerWorld();
  assert.equal(geo.junctionsIn('0,1'), null, 'the fixture put a pad in the built cell');
  const j = geo.junctionsIn('0,2')[0];
  const here = basesOf(buildChunkMeshes(w.city, 0, 1, w.mats, 'full'));
  const on = here.filter(([x, z]) => cornerLift(j, x, z) >= 0);
  assert.ok(on.length, 'the fixture is wrong: no lamp of cell 0,1 is on the corner band of the crossing');
  for (const [x, z, y] of on) {
    const band = geo.junctionDeckY(j, x, z, w.terrain) + LAYER_Y.road + cornerLift(j, x, z);
    assert.ok(Math.abs(y - band) < 0.01, `the lamp at ${x.toFixed(1)}, ${z.toFixed(1)} stands at ${y.toFixed(2)}: `
      + `the corner it is planted in is drawn at ${band.toFixed(2)}`);
  }
  // ...and a lamp along the street, off the corner, stands on the pavement it always did
  const off = here.filter(([x, z]) => cornerLift(j, x, z) < 0);
  assert.ok(off.length >= 2);
  for (const [, , y] of off) assert.ok(Math.abs(y - (G + LAYER_Y.road + 0.12)) < 0.01, `a lamp along the street at ${y.toFixed(2)}`);
  assert.deepEqual(lampsWorker(w, 0, 1, basesOf), here, 'the worker stood the lamps at other heights');
});

// ---- houses ------------------------------------------------------------------
test('a lamp does not come up through a house, and a courtyard is not a house', () => {
  // masts at x = 54 (+z kerb, z = 65.2) and x = 88 (-z kerb, z = 54.8)
  const A = way(1, 'secondary', 9, [[22, 60], [118, 60]]);
  const onLine = house(11, square(50, 64.8, 58, 72));        // facade on the building line
  const yard = house(12, square(80, 44, 96, 55.4), { i: [square(86, 53, 90, 55.3)] });
  const bare = pairs(lampsMain(world({ '0,0': { roads: [A] } }), 0, 0).lampPosts);
  assert.ok(bare.some(([x, z]) => Math.abs(x - 54) < 0.1 && Math.abs(z - 65.2) < 0.1)
    && bare.some(([x, z]) => Math.abs(x - 88) < 0.1 && Math.abs(z - 54.8) < 0.1),
    'the fixture is wrong: the masts are not where the houses were put');
  const spots = pairs(lampsMain(world({ '0,0': { roads: [A], buildings: [onLine, yard] } }), 0, 0).lampPosts);
  for (const [x, z] of spots) {
    assert.ok(!geo.pointInPolygon(x, z, onLine.o),
      `a mast stands inside the house at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
  assert.ok(spots.some(([x, z]) => Math.abs(x - 54) < 0.1 && Math.abs(z - 54.8) < 0.1),
    'the mast in the house did not cross to the free kerb');
  assert.ok(spots.some(([x, z]) => Math.abs(x - 88) < 0.1 && Math.abs(z - 54.8) < 0.1),
    'the mast in the courtyard was taken for one in the house');
});

test('a lamp offset across a cell border does not come up through the next cell\'s house', () => {
  // A runs along the border inside cell 0,0, as in the first test: its mast at
  // x = 54 is offset to z = 121.2, in cell 0,1. The house there does not reach
  // back over the border, so it is in the list of cell 0,1 alone, which a mesh
  // worker is not sent: it gets the outlines near the border instead.
  const A = () => way(1, 'secondary', 9, [[22, 116], [118, 116]]);
  const next = house(21, square(50, 120.5, 58, 130));
  const bare = pairs(lampsMain(world({ '0,0': { roads: [A()] }, '0,1': {} }), 0, 0).lampPosts);
  assert.ok(bare.some(([x, z]) => Math.abs(x - 54) < 0.1 && Math.abs(z - 121.2) < 0.1),
    'the fixture is wrong: no mast where the house was put');
  const w = world({ '0,0': { roads: [A()] }, '0,1': { buildings: [next] } });
  const here = lampsMain(w, 0, 0);
  for (const [x, z] of pairs(here.lampPosts)) {
    assert.ok(!geo.pointInPolygon(x, z, next.o),
      `a mast stands inside the house of the next cell at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
  assert.ok(pairs(here.lampPosts).some(([x, z]) => Math.abs(x - 54) < 0.1 && Math.abs(z - 110.8) < 0.1),
    'the mast in the house did not cross to the free kerb');
  const { spec } = chunkSpec(w, 0, 0, 'full', null);
  assert.equal(spec.cells['0,1'].houses?.length, 1, 'the outline of the house did not travel');
  assert.equal(spec.cells['0,1'].buildings.length, 0, 'a neighbour\'s buildings travelled whole');
  assert.deepEqual(lampsWorker(w, 0, 0), here, 'the worker planned different lamps from the main thread');
});

// ---- bus lay-bys -------------------------------------------------------------
test('a lamp at a bus lay-by stands behind the bay, not in it', () => {
  // the mast at x = 54 is 32 m along, on the +z kerb: side -1 of the ribbon
  const A = way(1, 'secondary', 9, [[22, 60], [118, 60]], { _bays: [32, -1] });
  const spots = pairs(lampsMain(world({ '0,0': { roads: [A] } }), 0, 0).lampPosts);
  const at = spots.find(([x]) => Math.abs(x - 54) < 0.1);
  assert.ok(at, 'the lamp at the lay-by was dropped instead of stepping out');
  // lane edge 4.5 m out, the bay 3 m more, the mast 0.7 m behind its kerb
  assert.ok(Math.abs(at[1] - 68.2) < 0.05,
    `the mast stands at z ${at[1].toFixed(2)}: the bay asphalt runs to 67.5`);
  // ...and away from the bay the kerb is where it always was
  assert.ok(spots.some(([x, z]) => Math.abs(x - 88) < 0.1 && Math.abs(z - 54.8) < 0.1),
    'a mast far from the lay-by moved too');
});

test('another street\'s lamp keeps out of a lay-by as well', () => {
  // S meets the bay side of A square on. Its one mast, 32 m along and 0.7 m
  // off its own lane at (54.8, 66) or (65.2, 66), is clear of A's lanes (they
  // end at z = 64.5) and inside A's bay either way.
  const A = way(1, 'secondary', 9, [[22, 60], [118, 60]], { _bays: [38, -1] });
  const S = way(18, 'residential', 9, [[60, 98], [60, 60]]);
  const spots = pairs(lampsMain(world({ '0,0': { roads: [A, S] } }), 0, 0).lampPosts);
  assert.ok(spots.length, 'no lamps at all');
  for (const [x, z] of spots) {
    const s = x - 22, d = Math.abs(s - 38);
    const bay = z > 60 ? (d <= 6.5 ? 3 : 3 * Math.max(0, 1 - (d - 6.5) / 10)) : 0;
    assert.ok(Math.abs(z - 60) >= 4.5 + bay,
      `a mast at ${x.toFixed(1)}, ${z.toFixed(1)} stands in the lay-by of the other street`);
  }
});

// ---- the main-road sign on a curving approach --------------------------------
test('a main-road sign follows a curving approach instead of its tangent at the node', () => {
  // a tertiary leaving the node eastwards and bending steadily to -z, the side
  // the sign for traffic coming IN stands on
  const R = way(1, 'tertiary', 8.5, [[0, 0], [6, 0], [12, -1], [18, -3.2], [24, -6.5], [40, -17]]);
  const side = way(2, 'residential', 6, [[0, 0], [0, 40]]);
  const hw = R.w / 2, m = 10.7;
  const node = { x: 0, z: 0, _legs: [
    { nx: 0, nz: 0, ux: 1, uz: 0, hw, r: R, s: 0, dir: 1, m, avail: R._len },
    { nx: 0, nz: 0, ux: 0, uz: 1, hw: 3, r: side, s: 0, dir: 1, m: 6, avail: 40, ctl: 'give' },
  ] };
  // where the tangent projection put it: 20.7 m out along +x, then to the kerb
  const oldX = m + 10, oldZ = -(hw + 0.75);
  assert.ok(offLine(R.p, oldX, oldZ) < hw - 1,
    'the fixture is wrong: the straight-line spot is not in the lane');
  const out = plannedSigns({ roads: [], signs: [] }, '0,0', [node], () => false, () => '0,0');
  const main = out.filter((q) => q[4] === 'main_road');
  assert.equal(main.length, 1, 'the approach lost its main-road sign');
  const [px, pz, dx, dz] = main[0];
  const off = offLine(R.p, px, pz);
  assert.ok(off >= hw + 0.5, `the post stands ${off.toFixed(2)} m from the centreline `
    + `of a ${R.w} m road: ${(hw - off).toFixed(2)} m inside the lane`);
  // it speaks to the driver coming IN along the way as it runs THERE
  assert.ok(dx < -0.8 && dz > 0.3, `it faces travel (${dx.toFixed(2)}, ${dz.toFixed(2)})`);
  assert.ok(out.some((q) => q[4] === 'give_way'), 'the yielding arm lost its sign');
});

// ---- a felled mast keeps the way it was turned --------------------------------
const UP = new THREE.Vector3(0, 1, 0);
function batch(spots) {
  const g = new THREE.BoxGeometry(0.2, 7.2, 0.2), mm = new THREE.MeshBasicMaterial();
  const posts = new THREE.InstancedMesh(g, mm, spots.length);
  const heads = new THREE.InstancedMesh(g, mm, spots.length);
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), one = new THREE.Vector3(1, 1, 1);
  for (let i = 0; i < spots.length; i++) {
    m4.compose(new THREE.Vector3(spots[i][0], G, spots[i][1]), q.setFromAxisAngle(UP, spots[i][2]), one);
    posts.setMatrixAt(i, m4); heads.setMatrixAt(i, m4);
  }
  posts.userData.ys = spots.map(() => G); posts.userData.kind = 'street';
  return [posts, heads];
}

test('a felled lamp goes over from the pose it stood in', () => {
  const lens = new THREE.Vector3(0, 7.46, -1.81);          // the head, out on its arm
  for (const rot of [0, Math.PI / 2, Math.PI, -2.2]) {
    const p = new Poles(new THREE.Group());
    const spots = [[100, 50, rot]];
    p.register('0,0', spots, ...batch(spots), null);
    assert.equal(p.strike(100, 50.5, 0, -15), 1, 'the mast survived');
    const mesh = p.falling[0].mesh;
    const yaw = new THREE.Quaternion().setFromAxisAngle(UP, rot);
    const stood = lens.clone().applyQuaternion(yaw);
    assert.ok(mesh.quaternion.angleTo(yaw) < 1e-6, `rot ${rot}: it is spawned turned to world -z`);
    p.update(1 / 60);
    const jump = lens.clone().applyQuaternion(mesh.quaternion).distanceTo(stood);
    assert.ok(jump < 0.05, `rot ${rot}: the head jumped ${jump.toFixed(2)} m on the frame it was hit`);
    for (let i = 0; i < 200; i++) p.update(1 / 60);
    // flat, the way it was pushed (-z), whatever it was turned to
    const top = new THREE.Vector3(0, 7.2, 0).applyQuaternion(mesh.quaternion);
    assert.ok(top.z < -7 && Math.abs(top.y) < 0.1, `rot ${rot}: it came to rest at ${top.toArray().map((v) => v.toFixed(1))}`);
    // ...and the arm is still on the side of the mast it was on
    const rest = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(-1, 0, 0), Math.PI / 2).multiply(yaw);
    assert.ok(mesh.quaternion.angleTo(rest) < 1e-3, `rot ${rot}: it lies turned about its own axis`);
  }
});

test('a felled signal mast keeps its yaw too', () => {
  const p = new Poles(new THREE.Group());
  let hidden = false;
  assert.equal(p.registerOne('sig', 10, G, 10, () => { hidden = true; }, 'signal', 1.2), true);
  assert.equal(p.strike(10, 10.4, 0, -15), 1);
  assert.ok(hidden, 'the standing signal was not hidden');
  const yaw = new THREE.Quaternion().setFromAxisAngle(UP, 1.2);
  assert.ok(p.falling[0].mesh.quaternion.angleTo(yaw) < 1e-6, 'the falling mast forgot which way it faced');
  p.update(1 / 60);
  assert.ok(p.falling[0].mesh.quaternion.angleTo(yaw) < 0.01, 'its head snapped round as it was hit');
});
