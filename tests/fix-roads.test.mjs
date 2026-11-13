// ---- roads, after the code review ---------------------------------------------
// Five defects the review confirmed on real tiles, each pinned on a fixture
// small enough to read:
//
//   a footway is levelled against, and cut at, the streets of EVERY chunk cell
//   it passes through, not only the cell it is drawn from (and the mesh worker
//   is sent those cells);
//
//   a bus lay-by is carriageway to a footway: no paving slab over the bay;
//
//   a bridge deck overhead is not the floor of somebody on the path under it;
//
//   the kerb round a junction is asked about other carriageways along its long
//   straight runs, not only at their two ends;
//
//   the earthworks level a tile's ways without working out their verges.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { indexJunctions, junctionsIn, polylineLength, streetOf, setStreetCity, roadGradeY,
  bridgeDeckHeight, holdVerges, roadProfile, JUNCTIONS, CLUSTERS } = await import('../js/geo.js');
const { cornerLift, bayAt, indexBays, KERB_H } = await import('../js/streets.js');
const { buildChunkMeshes, makeMaterials, footCellKeys } = await import('../js/meshes.js');
const { CityWorld, conformTerrainTile } = await import('../js/city.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode } = await import('../js/geomcodec.js');
const { Terrain } = await import('../js/terrain.js');
const { SURF } = await import('../js/surfaces.js');
const { LAYER_Y, CHUNK } = await import('../js/config.js');

const G = 221;
const flat = { res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt: () => G };
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
const emptyCell = () => ({ buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
  furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] });

/** Bucket ways and buildings by bbox, the way geo.bucketize does; _home is the first point's cell. */
function cityOf(roads, buildings = [], pois = []) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const chunkIndex = new Map();
  const cellAt = (k) => { let c = chunkIndex.get(k); if (!c) chunkIndex.set(k, c = emptyCell()); return c; };
  let id = 0;
  const put = (f, kind, ring) => {
    f._id = ++id;
    let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
    for (const [x, z] of ring) { a = Math.min(a, x); b = Math.min(b, z); c = Math.max(c, x); d = Math.max(d, z); }
    for (let i = Math.floor(a / CHUNK); i <= Math.floor(c / CHUNK); i++)
      for (let j = Math.floor(b / CHUNK); j <= Math.floor(d / CHUNK); j++) cellAt(i + ',' + j)[kind].push(f);
    f._home = Math.floor(ring[0][0] / CHUNK) + ',' + Math.floor(ring[0][1] / CHUNK);
  };
  for (const r of roads) { r._len = polylineLength(r.p); put(r, 'roads', r.p); }
  for (const b of buildings) put(b, 'buildings', b.o);
  const city = { chunkIndex, tile: 4800, pois, waterways: [], signals: [], roads };
  indexJunctions(roads);
  indexBays(city, pois);
  setStreetCity(city);
  return city;
}

/** Every triangle of the chunk's ground sink in one surface class, as [x, y, z] centroids. */
function trisOf(city, cx, cz, surf, terrain = flat) {
  const mats = makeMaterials();
  mats.terrain = terrain; mats.trees = false; mats.lamps = false; mats.facades = false;
  const group = buildChunkMeshes(city, cx, cz, mats, 'roads');
  const sink = group.children.find((m) => m.isMesh && m.material === mats.flat);
  const pos = sink.geometry.attributes.position, sf = sink.geometry.attributes.surf;
  const out = [];
  for (let i = 0; i < pos.count; i += 3) {
    if (sf.getX(i) !== surf) continue;
    out.push([(pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3 + group.position.x,
      (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3 + group.position.y,
      (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3 + group.position.z]);
  }
  return out;
}

// ---- a footway and the streets of the cells it passes through ------------------
// The street lies wholly in cell 1,0 (and a second one in cell 3,0), with houses
// along it so it comes out kerbed. Both footways START in cell 0,0, which has
// never heard of either street, and are drawn from there. `s: 'cobble'` gives
// them a surface class nothing else in the fixture has.
function seamTown() {
  const street = { t: 'residential', w: 8, d: 1, p: [[124, 60], [180, 60], [236, 60]] };
  const far = { t: 'residential', w: 8, d: 1, p: [[364, 60], [420, 60], [476, 60]] };
  const along = { t: 'footway', w: 1.8, s: 'cobble', p: [[100, 51], [200, 51]] };      // 5 m past the kerb
  const across = { t: 'footway', w: 1.8, s: 'cobble', p: [[110, 30], [150, 30], [150, 90]] };
  const long = { t: 'footway', w: 1.8, s: 'cobble', p: [[90, 69], [450, 69]] };      // reaches cell 3,0
  const buildings = [];
  for (let x = 126; x < 230; x += 20) buildings.push({ o: square(x, 24, 10), h: 9, t: 'house' });
  for (let x = 366; x < 470; x += 20) buildings.push({ o: square(x, 84, 10), h: 9, t: 'house' });
  const city = cityOf([street, far, along, across, long], buildings);
  return { city, street, far, along, across, long };
}

test('a footway rides the pavement of a street its home cell has never heard of', () => {
  const { city, street, along } = seamTown();
  assert.equal(along._home, '0,0');
  assert.ok(!city.chunkIndex.get('0,0').roads.includes(street), 'the fixture put the street in the home cell');
  assert.ok(streetOf(street), 'the street came out with no kerb: nothing to ride');
  const slab = trisOf(city, 0, 0, SURF.cobble).filter(([x, , z]) => x > 150 && x < 190 && Math.abs(z - 51) < 0.8);
  assert.ok(slab.length > 0, 'the footway was not drawn in the neighbouring cell at all');
  const deck = roadGradeY(street, 40, flat) + LAYER_Y.road;
  const top = Math.max(...slab.map((t) => t[1]));
  assert.ok(top > deck + KERB_H - 0.01, `the footway lies ${(top - deck).toFixed(3)} m over the deck, under the pavement beside it`);
  // …and that is where feet stand
  const w = Object.assign(Object.create(CityWorld.prototype), { city, terrain: flat });
  const feet = w.heightAt(170, 51, G + 1);
  assert.ok(Math.abs(feet - top) < 0.02, `feet ${(feet - deck).toFixed(3)} m over the deck, paving ${(top - deck).toFixed(3)}`);
});

test('a footway is cut at a carriageway its home cell has never heard of', () => {
  const { city, street, across } = seamTown();
  assert.equal(across._home, '0,0');
  const deck = roadGradeY(street, 26, flat) + LAYER_Y.road;
  const tris = trisOf(city, 0, 0, SURF.cobble).filter(([x]) => Math.abs(x - 150) < 1.2);
  assert.ok(tris.some(([, , z]) => z > 66 && z < 85) && tris.some(([, , z]) => z < 54),
    'the footway is missing either side of the street');
  // nothing of it on the carriageway, over the asphalt OR a hand under it (two
  // surfaces draped onto a slope four centimetres apart show through each other)
  const on = tris.filter(([, , z]) => Math.abs(z - 60) < 3.6);
  assert.equal(on.length, 0, `${on.length} triangles of footway are drawn on the carriageway, `
    + `${on.length ? (on[0][1] - deck).toFixed(3) : 0} m from its deck`);
  // and it comes up to the kerb either side instead of ending in a step
  const lip = tris.filter(([, , z]) => Math.abs(Math.abs(z - 60) - 5) < 0.9);
  assert.ok(lip.length > 0 && Math.max(...lip.map((t) => t[1])) > deck + 0.01,
    'the footway does not come up to the pavement where it meets the street');
});

test('the cells a footway reads are every cell along it, and the mesh worker gets them', () => {
  const { city, long, far } = seamTown();
  const keys = footCellKeys(long, new Set());
  for (const k of ['0,0', '1,0', '2,0', '3,0']) assert.ok(keys.has(k), `cell ${k} is not among the cells the footway reads`);
  assert.ok(!keys.has('5,0') && !keys.has('0,2'), 'the whole bounding box was taken, not the cells along the way');
  // a diagonal way takes the cells it passes through, not the square round them
  const diag = footCellKeys({ p: [[60, 60], [660, 660]] }, new Set());
  assert.ok(diag.has('2,2') && diag.has('5,5') && !diag.has('5,0') && !diag.has('0,5'));

  // main thread and worker build the same chunk, three cells from the street
  const terrain = new Terrain(4800, 20);
  terrain.grids.set('0,0', new Int16Array(terrain.n * terrain.n).fill(G * 10));
  terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = false;
  const world = { city, terrain, canopy: null, ground: null, mats };
  const sync = buildChunkMeshes(city, 0, 0, mats, 'full');
  const got = chunkSpec(world, 0, 0, 'full', null);
  assert.ok(got.spec.cells['3,0'], 'the spec left out a cell the footway reads its streets from');
  const out = buildChunkPayload(makeWorkerState(), structuredClone(got.spec, { transfer: got.transfer }));
  const back = decode(out.payload, { ...mats, codecMats: {} });
  const count = (g, surf) => {
    let n = 0;
    g.traverse((m) => {
      const sf = m.geometry?.attributes?.surf;
      if (sf) for (let i = 0; i < sf.count; i++) if (sf.getX(i) === surf) n++;
    });
    return n;
  };
  assert.ok(count(sync, SURF.cobble) > 0);
  assert.equal(count(back, SURF.cobble), count(sync, SURF.cobble), 'the worker drew a different footway');
  // and it IS lifted beside the far street, 330 m from where it is drawn from
  const deck = roadGradeY(far, 40, terrain) + LAYER_Y.road;
  const top = Math.max(...trisOf(city, 0, 0, SURF.cobble, terrain)
    .filter(([x, , z]) => x > 390 && x < 440 && Math.abs(z - 69) < 0.8).map((t) => t[1]));
  assert.ok(top > deck + KERB_H - 0.01, `beside the far street the footway is ${(top - deck).toFixed(3)} m over the deck`);
});

test('a footway station is levelled against the streets of its own cell, as feet are', () => {
  // The street lies wholly in cell 1,0, two metres past the cell border; the
  // footway runs along the border on the 0,0 side, six metres from the kerb:
  // inside the pull of a kerbed street, in a cell that does not list it.
  // city.heightAt asks the cell under the feet and leaves the walker on the
  // footway's own level, so that is where the paving has to be.
  const street = { t: 'residential', w: 8, d: 1, p: [[126, 4], [126, 60], [126, 116]] };
  const walk = { t: 'footway', w: 1.8, s: 'cobble', p: [[116, 6], [116, 114]] };
  const buildings = [];
  for (let z = 6; z < 110; z += 20) buildings.push({ o: square(140, z, 10), h: 9, t: 'house' });
  const city = cityOf([street, walk], buildings);
  assert.ok(streetOf(street), 'the street came out with no kerb: nothing would pull');
  assert.ok(!city.chunkIndex.get('0,0').roads.includes(street), 'the fixture put the street in the footway\'s cell');
  const w = Object.assign(Object.create(CityWorld.prototype), { city, terrain: flat });
  const slab = trisOf(city, 0, 0, SURF.cobble).filter(([x, , z]) => Math.abs(x - 116) < 0.8 && z > 40 && z < 80);
  assert.ok(slab.length > 0, 'the footway was not drawn');
  const top = Math.max(...slab.map((t) => t[1])), feet = w.heightAt(116, 60, G + 1);
  assert.ok(Math.abs(feet - top) < 0.02, `feet stand ${(feet - top).toFixed(3)} m off the paving beside a street in the next cell`);
});

// ---- a mapped footway through a generated lay-by -------------------------------
test('a footway through a bus lay-by is cut at the bay, not laid over it', () => {
  const street = { t: 'residential', w: 8, d: 1, v: 30, p: [[5, 60], [115, 60]] };
  // 1.4 m past the kerb line: inside the 3 m bay for the length of the bay
  const walk = { t: 'footway', w: 1.8, s: 'cobble', p: [[8, 65.4], [112, 65.4]] };
  const buildings = [];
  for (let x = 6; x < 110; x += 20) buildings.push({ o: square(x, 24, 10), h: 9, t: 'house' });
  const city = cityOf([street, walk], buildings, [{ t: 'bus_stop', p: [60, 66], n: 'Test' }]);
  assert.ok(street._bays?.length, 'the stop made no lay-by');
  const side = street._bays[1];
  assert.ok(bayAt(street, 55, side) > 2.9, 'the bay is not where the fixture expects it');
  const deck = roadGradeY(street, 55, flat) + LAYER_Y.road;
  const tris = trisOf(city, 0, 0, SURF.cobble);
  const inBay = tris.filter(([x, y]) => x > 54 && x < 66 && y > deck + 0.02);
  assert.equal(inBay.length, 0, `${inBay.length} triangles of footway lie over the bay asphalt, `
    + `${inBay.length ? (inBay[0][1] - deck).toFixed(3) : 0} m up`);
  // clear of the bay and its tapers the footway is still there, on the pavement
  const clear = tris.filter(([x]) => x > 12 && x < 30);
  assert.ok(clear.length > 0, 'the footway was cut away along the whole street');
  assert.ok(Math.max(...clear.map((t) => t[1])) > deck + KERB_H - 0.01, 'clear of the bay the footway is no longer on the pavement');
  // feet in the bay are on its asphalt
  const w = Object.assign(Object.create(CityWorld.prototype), { city, terrain: flat });
  assert.ok(Math.abs(w.heightAt(60, 65.4, G + 1) - deck) < 0.02);
});

// ---- under a bridge, and on it --------------------------------------------------
test('a bridge deck overhead is not the floor of the path under it', () => {
  // a dell three metres deep between x = 30 and x = 90; a footbridge across it,
  // bank to bank, and a path along its floor passing under the bridge
  const dell = (x) => (x <= 30 || x >= 90 ? 0 : x < 40 ? (x - 30) / 10 : x > 80 ? (90 - x) / 10 : 1);
  const terrain = { res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt: (x) => G - 3 * dell(x) };
  const bridge = { t: 'footway', w: 2.4, br: 1, p: [[20, 60], [100, 60]] };
  const under = { t: 'footway', w: 2, p: [[60, 10], [60, 110]] };
  const city = cityOf([bridge, under]);
  const w = Object.assign(Object.create(CityWorld.prototype), { city, terrain });
  const deck = bridgeDeckHeight(bridge, 40, terrain), floor = terrain.heightAt(60, 60);
  assert.ok(deck - floor > 1.6 && deck - floor < 4.1, `the fixture's deck is ${(deck - floor).toFixed(2)} m over the dell: outside the range that went wrong`);
  const path = roadGradeY(under, 50, terrain) + LAYER_Y.footway;
  // on the path, under the bridge: the path
  assert.ok(Math.abs(w.walkY(60, 60) - path) < 0.1, `under the bridge feet are ${(w.walkY(60, 60) - path).toFixed(2)} m over the path`);
  assert.ok(Math.abs(w.walkY(60.6, 59) - path) < 0.1);
  // on the bridge, clear of the path below: the deck, as before
  const deck2 = bridgeDeckHeight(bridge, 28, terrain);
  assert.ok(deck2 - terrain.heightAt(48, 60) > 1.6);
  assert.ok(Math.abs(w.walkY(48, 60) - deck2) < 0.02, `on the bridge feet are ${(w.walkY(48, 60) - deck2).toFixed(2)} m off the deck`);
  // and the path out in the open is untouched
  assert.ok(Math.abs(w.walkY(60, 20) - (roadGradeY(under, 10, terrain) + LAYER_Y.footway)) < 0.02);
});

test('only a bridge is ever overhead: raised ground stays the floor, and a footbridge keeps its walkers over a street', () => {
  // (a) a path across a ditch two and a half metres deep: its levelled strip
  // carries it over on fill, so the floor is that far above the bare ground,
  // and no bridge is anywhere near
  const ditch = (x) => (x > 57 && x < 63 ? 2.5 : 0);
  const t1 = { res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt: (x) => G - ditch(x) };
  const path = { t: 'footway', w: 2, p: [[10, 60], [110, 60]] };
  const c1 = cityOf([path]);
  const w1 = Object.assign(Object.create(CityWorld.prototype), { city: c1, terrain: t1 });
  const own = roadGradeY(path, 50, t1) + LAYER_Y.footway;
  assert.ok(own - t1.heightAt(60, 60) > 1.6, `the fixture's path is only ${(own - t1.heightAt(60, 60)).toFixed(2)} m over the ditch`);
  assert.ok(Math.abs(w1.walkY(60, 60) - own) < 0.05, `over the ditch feet are ${(w1.walkY(60, 60) - own).toFixed(2)} m off the path`);

  // (b) the dell again, with a street along its floor under the footbridge:
  // whoever is at that point of the street is crossing over it
  const dell = (x) => (x <= 30 || x >= 90 ? 0 : x < 40 ? (x - 30) / 10 : x > 80 ? (90 - x) / 10 : 1);
  const t2 = { res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt: (x) => G - 3 * dell(x) };
  const bridge = { t: 'footway', w: 2.4, br: 1, p: [[20, 60], [100, 60]] };
  const street = { t: 'residential', w: 8, d: 1, p: [[60, 4], [60, 116]] };
  const under = { t: 'footway', w: 2, p: [[72, 10], [72, 110]] };
  const c2 = cityOf([bridge, street, under]);
  const w2 = Object.assign(Object.create(CityWorld.prototype), { city: c2, terrain: t2 });
  const deck = bridgeDeckHeight(bridge, 40, t2);
  assert.ok(deck - t2.heightAt(60, 60) > 1.6 && deck - t2.heightAt(60, 60) < 4.1);
  for (const x of [57, 60, 63, 65.5]) assert.ok(Math.abs(w2.walkY(x, 60) - bridgeDeckHeight(bridge, x - 20, t2)) < 0.02,
    `on the footbridge over the street, at x = ${x}, feet are ${(w2.walkY(x, 60) - bridgeDeckHeight(bridge, x - 20, t2)).toFixed(2)} m off the deck`);
  // the path beside the street still passes UNDER the bridge
  const low = roadGradeY(under, 50, t2) + LAYER_Y.footway;
  assert.ok(Math.abs(w2.walkY(72, 60) - low) < 0.1, `under the bridge feet are ${(w2.walkY(72, 60) - low).toFixed(2)} m over the path`);
});

// ---- a junction kerb across a side street ---------------------------------------
test('a junction kerb stops at the mouth of a side street that joins along a straight run', () => {
  // A T: the street runs through, a side street leaves it southwards. The far
  // (north) kerb is one straight run between the two mouths of the through
  // street. A yard road ends ON that run without sharing a node with it.
  const main = { t: 'residential', w: 8, d: 1, p: [[4, 60], [60, 60], [116, 60]] };
  const side = { t: 'residential', w: 8, d: 1, p: [[60, 60], [60, 116]] };
  const yard = { t: 'service', w: 4.8, d: 1, p: [[64, 20], [64, 55.5]] };
  const buildings = [];
  for (let x = 6; x < 110; x += 20) if (Math.abs(x + 5 - 64) > 9) buildings.push({ o: square(x, 28, 10), h: 9, t: 'house' });
  const city = cityOf([main, side, yard], buildings);
  const j = junctionsIn('0,0').find((o) => Math.hypot(o.x - 60, o.z - 60) < 1);
  assert.ok(j, 'the T made no junction');
  // no straight kerb run is left with more than a verge station between its points
  let longest = 0, runPts = 0;
  for (const pc of j._edge) {
    if (!pc.k) continue;
    const m = pc.p.length / 8;
    for (let i = 0; i < m - 1; i++)
      longest = Math.max(longest, Math.hypot(pc.p[i * 8 + 8] - pc.p[i * 8], pc.p[i * 8 + 9] - pc.p[i * 8 + 1]));
    for (let i = 0; i < m; i++) if (pc.p[i * 8 + 1] < 56.5 && pc.any) runPts++;
  }
  assert.ok(longest <= 3.01, `a kerb run of ${longest.toFixed(1)} m is tested at its two ends only`);
  assert.ok(runPts >= 4, 'the far kerb of the T has no band at all: nothing was tested');
  // the band is there beside the mouth, and not across it
  let beside = false;
  for (const x of [50, 51, 52, 53, 54, 55, 56, 57, 71, 72, 73, 74, 75]) if (cornerLift(j, x, 55.2) > 0.05) beside = true;
  assert.ok(beside, 'the fixture has no kerb along the far side of the T');
  for (const x of [63.4, 64, 64.6]) for (const z of [54.4, 55, 55.6])
    assert.ok(!(cornerLift(j, x, z) > 0.02), `a kerb ${cornerLift(j, x, z).toFixed(2)} m high lies across the yard road at (${x}, ${z})`);
  // ...out to its wheel tracks: the band ends at the edge of the asphalt, it
  // does not taper to nothing somewhere inside the mouth
  for (let x = 62.1; x < 66; x += 0.3) for (const z of [54.6, 55.3, 55.6, 55.85])
    assert.ok(!(cornerLift(j, x, z) > 0.02), `a kerb ${cornerLift(j, x, z).toFixed(2)} m high stands in the yard road's lane at (${x.toFixed(1)}, ${z})`);
  // a car turning in rides asphalt, not a 12 cm step
  const w = Object.assign(Object.create(CityWorld.prototype), { city, terrain: flat, ground: { classAt: () => 0 } });
  const deck = roadGradeY(main, 60, flat) + LAYER_Y.road;
  assert.ok(w.surfaceY(64, 55, G + 1).y < deck + 0.05, `the yard road's mouth is ${(w.surfaceY(64, 55, G + 1).y - deck).toFixed(3)} m over the deck`);
});

// ---- the earthworks do not work out verges --------------------------------------
test('levelling a terrain tile leaves every verge for its first real use', () => {
  const main = { t: 'residential', w: 8, d: 1, p: [[4, 60], [60, 60], [116, 60]] };
  const side = { t: 'residential', w: 8, d: 1, p: [[60, 60], [60, 116]] };
  const buildings = [];
  for (let x = 6; x < 110; x += 20) buildings.push({ o: square(x, 24, 10), h: 9, t: 'house' });
  const city = cityOf([main, side], buildings);
  const terrain = new Terrain(4800, 20);
  const g = new Int16Array(terrain.n * terrain.n);
  for (let j = 0; j < terrain.n; j++) for (let i = 0; i < terrain.n; i++)
    g[j * terrain.n + i] = Math.round((G + Math.sin(i * 0.3) * 1.5) * 10);
  terrain.grids.set('0,0', g);
  terrain._loads = 1;
  assert.ok(conformTerrainTile(terrain, city, 0, 0), 'the bake moved no ground: the fixture is flat');
  assert.ok(main._prof, 'the bake did not level the street');
  assert.equal(main._vg, undefined, 'the bake worked out a verge');
  assert.equal(side._vg, undefined);
  // the hold is released: the next ask through either door derives it
  roadProfile(side, terrain);
  assert.ok(side._vg, 'the verge hold was left on after the bake');
  assert.ok(streetOf(main), 'first use did not derive the verge');
  // and it nests
  const other = { t: 'residential', w: 8, d: 1, p: [[4, 90], [50, 90]], _len: 46 };
  holdVerges(1); holdVerges(1); holdVerges(-1);
  roadProfile(other, terrain);
  assert.equal(other._vg, undefined, 'one release undid two holds');
  holdVerges(-1);
  roadProfile(other, terrain);
  assert.notEqual(other._vg, undefined);
});
