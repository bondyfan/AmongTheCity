// The Tesla showroom (js/stores/showlayout.js, showroom.js), on the footprint the
// map really has for it: "Tesla Prague" at V Oblouku 727, Průhonice, tile -18_0.
// What could go wrong and would not show in a screenshot taken today:
//   · the gate is cut into a wall with no room behind it, so no car can stand
//     nose to it, or into the wall the workshop hall stands against;
//   · a display car stands in a wall, or the Roadster cannot be driven straight out;
//   · the mesh worker builds a different showroom than the main thread;
//   · sitting in the car, or rolling it to the gate, already brings the police;
//     driving it away does not; a car the player BOUGHT does;
//   · the stand refills behind a car that was driven away.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { landmarkOf, LandmarkBatch, landmarkSolids, solidHas } = await import('../js/landmarks.js');
const { chainOfName, standalone, storeChain, isOpen } = await import('../js/stores/chains.js');
const { siteOf, inRing, shopRect } = await import('../js/stores/site.js');
const { pinStores } = await import('../js/stores/landmark.js');
const { showLayout, pickShowFront, leftLot, ringDist, watchDisplay, SHOW_CARS, LOT_PAD, THEFT_HEAT } = await import('../js/stores/showlayout.js');
const { paintStoreSign, SIGN_STYLE } = await import('../js/stores/signpaint.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, handleMessage } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity } = await import('../js/geo.js');
const wanted = await import('../js/wanted.js');

const CHUNK = 120;
const copy = (f) => JSON.parse(JSON.stringify(f));
const TILE = JSON.parse(readFileSync(new URL('../public/data/tiles/-18_0.json', import.meta.url), 'utf8'));
const RAW = TILE.buildings.find((b) => b.n === 'Tesla Prague');

/** The showroom with the roads, parking and houses round it, pinned as the streamer pins it. */
function showroom() {
  const f = copy(RAW); f._id = 1;
  const near = (p) => Math.hypot(p[0] - f.o[0][0], p[1] - f.o[0][1]) < 170;
  const cell = { roads: TILE.roads.filter((r) => r.p.some(near)), paved: TILE.paved.filter((g) => g.o.some(near)),
    buildings: [f, ...TILE.buildings.filter((b) => b !== RAW && b.o.some(near)).map(copy)] };
  pinStores(cell);
  const chain = storeChain(f);
  return { f, cell, chain, site: siteOf(f, chain, cell) };
}

test('the map has the showroom, and only a car showroom of that name is one', () => {
  assert.ok(RAW, 'tile -18_0 no longer holds "Tesla Prague"');
  assert.equal(RAW.u, 'car');
  const c = chainOfName('Tesla Prague');
  assert.equal(c?.id, 'tesla');
  assert.equal(c.kind, 'showroom');
  assert.ok(standalone(RAW, c));
  assert.equal(storeChain(copy(RAW))?.id, 'tesla');
  // the same name on a workshop, a pharmacy or a bowling alley is not a showroom
  assert.ok(!standalone({ ...RAW, u: 'car_repair' }, c), 'a service centre is not rebuilt');
  assert.ok(!standalone({ ...RAW, u: undefined }, c));
  assert.equal(chainOfName('Nová Tesla'), null);
  assert.equal(chainOfName('Lékárna Tesla Pardubice'), null);
  assert.equal(chainOfName('Kuželna TJ Tesla Pardubice'), null);
  assert.ok(isOpen(c, 12) && !isOpen(c, 3));
});

test('the gate is in the wall with room behind it, never the one the hall stands against', () => {
  const { f, cell, chain, site } = showroom();
  assert.equal(typeof f._sf, 'number', 'pinStores left the front undecided');
  assert.equal(f._sf, pickShowFront(copy(RAW), chain, cell), 'the pick is not a function of the map');
  const doors = site.segs.filter((s) => s.kind === 'door');
  assert.equal(doors.length, 1);
  assert.ok(Math.abs(doors[0].len - chain.arch.doorW) < 1e-6, `a ${doors[0].len.toFixed(1)} m gate`);
  assert.ok(doors[0].len >= SHOW_CARS.roadster.wid + 2.8, 'a car and its mirrors do not fit the gate');
  // the leaves slide over the wall either side of the gate
  assert.ok(site.front.len >= 2 * chain.arch.doorW, `a ${site.front.len.toFixed(1)} m wall cannot take the leaves`);
  // five metres out of the gate is open air, five metres in is the floor
  const out = [site.door.x + site.nx * 5, site.door.z + site.nz * 5];
  assert.ok(!cell.buildings.some((b) => inRing(b.o, out[0], out[1])), 'the gate opens into a building');
  assert.ok(inRing(f.o, site.door.x - site.nx * 3, site.door.z - site.nz * 3));
  // the walls: the doorway is open to a car, every other run is solid, glass included
  const solids = landmarkSolids(f);
  const blocked = (x, z) => solids.some((s) => s.bot <= 0.5 && solidHas(s, x, z));
  for (const k of [-0.4, 0, 0.4]) {
    const x = site.door.x + site.ux * site.door.w * k - site.nx * 0.12, z = site.door.z + site.uz * site.door.w * k - site.nz * 0.12;
    assert.ok(!blocked(x, z), 'the gateway is solid');
  }
  let glass = 0;
  for (const s of site.segs) {
    if (s.kind === 'glass') glass += s.len;
    if (s.kind === 'door' || s.len < 0.6) continue;
    const x = (s.a[0] + s.b[0]) / 2 - s.mx * 0.12, z = (s.a[1] + s.b[1]) / 2 - s.mz * 0.12;
    assert.ok(blocked(x, z), `a ${s.kind} run of ${s.len.toFixed(1)} m can be driven through`);
  }
  assert.ok(glass > 40, `only ${glass.toFixed(0)} m of the showroom is glazed`);
});

test('the Roadster stands behind the gate, nose out, and the floor is clear ahead of it', () => {
  const { f, site } = showroom();
  const L = showLayout(site);
  assert.equal(L.kind, 'showroom');
  assert.deepEqual(L.stands.map((s) => s.kind), ['roadster', 'tesla'], 'the Roadster and a Model 3 both fit this floor');
  const fwd = (s) => [-Math.sin(s.heading), -Math.cos(s.heading)];
  for (const s of L.stands) {
    const C = SHOW_CARS[s.kind], [fx, fz] = fwd(s);
    // every corner of the car is on the floor, with air between it and the walls
    for (const [l, w] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const x = s.x + fx * l * C.len / 2 + -fz * w * C.wid / 2, z = s.z + fz * l * C.len / 2 + fx * w * C.wid / 2;
      assert.ok(inRing(f.o, x, z), `${s.kind}: a corner is outside the walls`);
      assert.ok(ringDist(f.o, x, z) > 0.3, `${s.kind}: a corner is ${ringDist(f.o, x, z).toFixed(2)} m from a wall`);
    }
    assert.ok(fx * site.nx + fz * site.nz > 0.9, `${s.kind} does not face the front`);
    assert.equal(s.id, site.key + ':' + s.slot);
  }
  // the two cars do not touch
  const [r, m] = L.stands;
  assert.ok(Math.hypot(r.x - m.x, r.z - m.z) > 3.4, 'the two display cars overlap');
  // the Roadster: square to the gate, on its centre line, nothing on the floor between it and the gate
  const [fx, fz] = fwd(r);
  assert.ok(fx * site.nx + fz * site.nz > 0.999, 'the Roadster is not square to the gate');
  const [du] = site.local(site.door.x, site.door.z), [ru] = site.local(r.x, r.z);
  assert.ok(Math.abs(du - ru) < 0.05, 'the Roadster is off the gate\'s centre line');
  const rect = L.room.r, half = SHOW_CARS.roadster.wid / 2 + 0.6;
  for (const fxt of L.fixtures) {
    const u = rect.u0 + fxt.b, a = fxt.a;
    assert.ok(!(Math.abs(u - ru) < half && a < r.a), `a ${fxt.t} stands in the Roadster's way out`);
    const [x, z] = L.room.at(fxt.a, fxt.b);
    assert.ok(inRing(f.o, x, z), `a ${fxt.t} is outside the walls`);
  }
  // a card for each car, an adviser at a desk, all on the floor
  assert.equal(L.points.filter((p) => p.kind === 'spec').length, 2);
  assert.equal(L.staff.length, 1);
  assert.ok(L.fixtures.some((x) => x.t === 'desk'));
  for (const p of [...L.points, ...L.staff]) assert.ok(inRing(f.o, p.x, p.z));
  // the same floor on every machine
  assert.deepEqual(JSON.parse(JSON.stringify(showLayout(showroom().site).stands)), JSON.parse(JSON.stringify(L.stands)));
  assert.ok(shopRect(site, 0.45).v1 - shopRect(site, 0.45).v0 >= SHOW_CARS.roadster.len + 0.9);
});

test('the showroom builds sound geometry with its signs, and its marks are drawn', () => {
  const { f, cell, chain } = showroom();
  const l = landmarkOf(f), batch = new LandmarkBatch(), marks = new Map();
  assert.ok(l?.store && l.chain.id === 'tesla');
  batch.add(l, f, 221, null, cell.roads, { cell, marks });
  const g = batch.geo();
  const P = g.attributes.position;
  for (let i = 0; i < P.count; i++) assert.ok(Number.isFinite(P.getX(i) + P.getY(i) + P.getZ(i)));
  assert.ok(P.count / 3 > 300 && P.count / 3 < 6000, `${P.count / 3} triangles`);
  const labels = [...marks.keys()].sort();
  assert.deepEqual(labels, ['@tesla/band', '@tesla/hours', '@tesla/sq']);
  assert.ok(marks.get('@tesla/band').pos.length / 18 >= 2, 'the name is on one wall only');
  // the painter knows both marks in both styles (a recording canvas: what matters is that it draws)
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => { calls.push(k); return { width: 10 }; }), set: (t, k, v) => { t[k] = v; return true; } });
  const was = SIGN_STYLE.logos;
  for (const style of ['drawn', 'plain']) for (const v of ['sq', 'band', 'hours']) {
    SIGN_STYLE.logos = style; calls.length = 0;
    assert.equal(paintStoreSign(ctx, null, '@tesla/' + v, 0, 0, 256, 256), true);
    assert.ok(calls.includes('fillRect') && (calls.includes('fillText') || calls.includes('fill')), `${style} ${v} drew nothing`);
  }
  SIGN_STYLE.logos = was;
  assert.equal(chain.sign.text, 'TESLA');
});

test('the chunk with the showroom comes back from the worker the same as it is built here', () => {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const key = Math.floor(RAW.o[0][0] / CHUNK) + ',' + Math.floor(RAW.o[0][1] / CHUNK);
  const [cx, cz] = key.split(',').map(Number);
  const homeOf = (f) => Math.floor(f.o[0][0] / CHUNK) + ',' + Math.floor(f.o[0][1] / CHUNK);
  let id = 0;
  const buildings = TILE.buildings.filter((f) => homeOf(f) === key).map((f) => { const g = copy(f); g._id = ++id; g._home = key; return g; });
  const cell = { buildings, roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const terrain = new Terrain(4800, 20);
  const grid = new Int16Array(terrain.n * terrain.n).fill(2900);
  terrain.grids.set(Math.floor(cx * CHUNK / 4800) + ',' + Math.floor(cz * CHUNK / 4800), grid);
  terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  const world = { city, terrain, canopy: null, ground: null, mats, wordmark, cell };
  assert.ok(cell.buildings.some((f) => landmarkOf(f)?.chain?.id === 'tesla'), 'the chunk holds no showroom');
  pinStores(cell);
  const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
  assert.ok(got, 'chunkSpec refused the chunk');
  const { reply } = handleMessage(makeWorkerState(), { t: 'build', id: 1, spec: structuredClone(got.spec, { transfer: got.transfer }) });
  assert.equal(reply.t, 'done', `the worker failed the chunk: ${reply.error}`);
  assert.ok(Object.keys(reply.brands).some((k) => k === 'brand:@tesla/band'), 'the sign was not named on the wire');
  const decMats = { ...mats, codecMats: {} };
  for (const k of Object.keys(reply.brands)) decMats.codecMats[k] = wordmark;
  const back = decode(reply.payload, decMats);
  const sync = buildChunkMeshes(city, cx, cz, mats, 'full');
  sync.updateMatrixWorld(true); back.updateMatrixWorld(true);
  const lm = (root) => { const out = []; root.traverse((o) => { if (o.isMesh && o.material === mats.landmark) out.push(o); }); return out; };
  const A0 = lm(sync), B0 = lm(back);
  assert.equal(A0.length, 1); assert.equal(B0.length, 1);
  const A = A0[0].geometry.attributes, B = B0[0].geometry.attributes;
  assert.equal(B.position.count, A.position.count, 'vertex count');
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  let worst = 0;
  for (let v = 0; v < A.position.count; v++) {
    p.fromBufferAttribute(A.position, v).applyMatrix4(A0[0].matrixWorld);
    q.fromBufferAttribute(B.position, v).applyMatrix4(B0[0].matrixWorld);
    worst = Math.max(worst, p.distanceTo(q));
  }
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm between the two paths`);
  const marks = (root) => { let n = 0; root.traverse((o) => { if (o.isMesh && o.material === wordmark) n += o.geometry.attributes.position.count; }); return n; };
  assert.equal(marks(back), marks(sync), 'the two paths drew different signs');
});

test('sitting in a display car is free; driving it off the premises is two stars, once', () => {
  const { f, site } = showroom();
  const st = showLayout(site).stands[0];
  // the premises: the floor, the gateway and a car's length of apron
  assert.ok(!leftLot(f.o, st.x, st.z));
  assert.ok(!leftLot(f.o, site.door.x + site.nx * 4, site.door.z + site.nz * 4), 'rolled out onto the apron is not yet taken');
  assert.ok(leftLot(f.o, site.door.x + site.nx * (LOT_PAD + 1), site.door.z + site.nz * (LOT_PAD + 1)));
  const toasts = [];
  const d = { wanted, toast: (t) => toasts.push(t) };
  const car = { x: st.x, z: st.z, kind: 'roadster', _show: { o: f.o, id: st.id, gone: false } };
  wanted.reset();
  assert.equal(watchDisplay(null, d), false);
  assert.equal(watchDisplay({ x: 0, z: 0 }, d), false, 'an ordinary car is nobody\'s business here');
  // seated on the stand, then rolling out through the gate: nothing yet
  for (let k = -3; k <= LOT_PAD - 1; k++) {
    car.x = site.door.x + site.nx * k; car.z = site.door.z + site.nz * k;
    assert.equal(watchDisplay(car, d), false, `charged ${k} m from the gate`);
  }
  assert.equal(wanted.stars(), 0);
  // away: two stars on the spot, and a word about it
  car.x = site.door.x + site.nx * 14; car.z = site.door.z + site.nz * 14;
  assert.equal(watchDisplay(car, d), true);
  assert.equal(wanted.stars(), 2, `${wanted.stars()} stars for a stolen display car`);
  assert.equal(wanted.lastCrime(), 'krádež vystaveného vozu');
  assert.equal(toasts.length, 1);
  // charged once: further away, and brought back and taken again, nothing more
  const heat = wanted.heat();
  car.x += site.nx * 300; car.z += site.nz * 300;
  assert.equal(watchDisplay(car, d), false);
  assert.equal(wanted.heat(), heat);
  // with a star already on the meter it is still at least two, never fewer
  wanted.reset(); wanted.add(20, 'rvačka');
  assert.equal(wanted.stars(), 1);
  const second = { x: car.x, z: car.z, _show: { o: f.o, id: 'x', gone: false } };
  assert.equal(watchDisplay(second, d), true);
  assert.ok(wanted.stars() >= 2);
  // a car the player bought is theirs to drive away
  wanted.reset();
  const bought = { x: car.x, z: car.z, owned: true, _show: { o: f.o, id: 'y', gone: false } };
  assert.equal(watchDisplay(bought, d), false);
  assert.equal(wanted.stars(), 0);
  assert.ok(THEFT_HEAT >= 45 && THEFT_HEAT < 80, 'the price is two stars, not three');
  wanted.reset();
});

test('the display cars are the game\'s own parked cars, and a stand does not refill behind a taken one', async () => {
  const { ShowShop, resetShowrooms } = await import('../js/stores/showroom.js');
  resetShowrooms();
  const { f, site, chain } = showroom();
  const layout = showLayout(site);
  const parked = [], removed = [];
  let driving = null;
  const cars = {
    add: (kind, x, z, heading, color, look) => ({ kind, x, z, heading, color, look }),
    remove: (c) => removed.push(c), parked, driving: () => driving, riding: () => null,
  };
  const d = { cars, hour: () => 12, toast() {}, scene: { add() {} } };
  const rec = { f, chain, site, base: 290, key: site.key };
  let shop = new ShowShop(rec, layout, d);
  assert.equal(parked.length, 2);
  assert.deepEqual(parked.map((c) => c.kind), ['roadster', 'tesla']);
  for (const c of parked) {
    assert.equal(c.unlocked, true, 'a display car is locked');
    assert.equal(c._show.o, f.o);
    assert.equal(c._show.gone, false);
  }
  // two clients stand the same cars in the same places in the same paint
  const other = [];
  new ShowShop(rec, showLayout(showroom().site), { ...d, cars: { ...cars, parked: other } });
  assert.deepEqual(other.map((c) => [c.kind, c.x, c.z, c.heading, c.color, c.look, c._show.id]),
    parked.map((c) => [c.kind, c.x, c.z, c.heading, c.color, c.look, c._show.id]));
  // the hint tells a driver what driving off will cost, and a walker what E does
  const roadster = parked[0];
  assert.match(shop.hint(roadster.x + 2, roadster.z, { onFoot: true }), /^E nasednout · Tesla Roadster/);
  assert.match(shop.hint(roadster.x, roadster.z, { onFoot: false, car: roadster }), /policie/);
  const spec = layout.points.find((p) => p.kind === 'spec');
  assert.equal(shop.use(spec.x, spec.z, { onFoot: true }), true, 'E at a card does nothing');
  assert.equal(shop.use(roadster.x + 2.5, roadster.z + 2.5, { onFoot: true }), false, 'the showroom took E away from the car door');
  // walked away with both cars on their stands: they go with the room, and come back with it
  shop.dispose();
  assert.equal(parked.length, 0);
  assert.equal(removed.length, 2);
  shop = new ShowShop(rec, layout, d);
  assert.equal(parked.length, 2);
  // the Roadster is driven away: it stays the player's, and its stand stays empty this session
  const taken = parked[0];
  driving = taken; parked.splice(0, 1);
  taken.x += 40;
  shop.dispose();
  assert.equal(removed.length, 3, 'the taken car was removed with the room');
  assert.ok(!removed.includes(taken));
  shop = new ShowShop(rec, layout, d);
  assert.deepEqual(parked.map((c) => c.kind), ['tesla'], 'the stand refilled behind the stolen Roadster');
  shop.dispose();
  resetShowrooms();
});
