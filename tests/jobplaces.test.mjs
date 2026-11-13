// The named world as jobs see it: which places exist, where a car can stop
// for each of them, and whether the player is standing at a food counter.
// A hand-built city: one street, one yard, three buildings, a few venues.
import test from 'node:test';
import assert from 'node:assert/strict';

import { collectPlaces, resolveStop, foodPlaceAt, nearestStop, snapStopToRoute, FOOD_TYPES } from '../js/jobplaces.js';
import { generateJobs } from '../js/jobgen.js';
import { CHUNK } from '../js/config.js';

function city() {
  const roads = [
    { p: [[-400, 0], [400, 0]], t: 'residential', d: 1, w: 8, n: 'Sladkovského' },
    { p: [[100, 0], [100, 60]], t: 'service', d: 1, w: 4 },                  // a yard, unnamed
    { p: [[-400, 30], [400, 30]], t: 'footway', d: 0, w: 2, n: 'Pěší zóna' }, // not drivable
    { p: [[-400, -200], [400, -200]], t: 'primary', d: 1, w: 12, n: 'Most', br: 1 },
  ];
  const buildings = [
    { o: [[40, 12], [60, 12], [60, 28], [40, 28]], n: 'Hospoda U Kocoura', u: 'pub' },
    { o: [[-60, 12], [-40, 12], [-40, 28], [-60, 28]], n: 'Finanční úřad', u: 'office' },
    { o: [[200, 300], [220, 300], [220, 320], [200, 320]], n: 'Samota', u: 'restaurant' },
    { o: [[380, 12], [396, 12], [396, 28], [380, 28]], n: 'Lékárna U Anděla', u: 'pharmacy' },
    { o: [[-392, 12], [-378, 12], [-378, 28], [-392, 28]], n: 'Hotel Zlatá štika', u: 'hotel' },
    { o: [[0, 12], [10, 12], [10, 20], [0, 20]] },                             // nameless: not a place
  ];
  const venues = [
    { p: [[-10, 14]], t: 'bakery', n: 'Pekařství Kabát' },
    { p: [[104, 52]], t: 'florist', n: 'Květiny Jarmila' },
    { p: [[20, -190]], t: 'cafe', n: 'Kavárna Na Mostě' },
    { p: [[300, 14]], t: 'clothes', n: 'X' },                                  // one-letter name: dropped
  ];
  const pois = [
    { p: [-200, -6], t: 'bus_stop', n: 'Sladkovského' },
    { p: [-210, -6], t: 'fuel', n: 'Shell' },
    { p: [-220, -6], t: 'bus_stop' },                                          // unnamed
  ];
  const chunkIndex = new Map();
  const cellAt = (x, z) => {
    const k = Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);
    if (!chunkIndex.has(k)) chunkIndex.set(k, { roads: [], buildings: [], venues: [] });
    return chunkIndex.get(k);
  };
  // geo.js files a feature in every cell its bbox touches
  for (const r of roads) {
    const seen = new Set();
    const [a, b] = r.p;
    for (let t = 0; t <= 1; t += 0.01) {
      const c = cellAt(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
      if (!seen.has(c)) { seen.add(c); c.roads.push(r); }
    }
  }
  for (const b of buildings) cellAt(b.o[0][0], b.o[0][1]).buildings.push(b);
  for (const v of venues) cellAt(v.p[0][0], v.p[0][1]).venues.push(v);
  return { chunkIndex, roads, buildings, venues, pois };
}

test('places are the named things, each once, with a stable id', () => {
  const c = city();
  const all = collectPlaces(c, 0, 0, 1000);
  const names = all.map((p) => p.name).sort();
  assert.deepEqual(names, ['Finanční úřad', 'Hospoda U Kocoura', 'Hotel Zlatá štika', 'Kavárna Na Mostě',
    'Květiny Jarmila', 'Lékárna U Anděla', 'Pekařství Kabát', 'Samota', 'Sladkovského']);
  const pub = all.find((p) => p.name === 'Hospoda U Kocoura');
  assert.equal(pub.type, 'pub');
  assert.deepEqual([pub.x, pub.z], [50, 20], 'a building is placed at its centroid');
  assert.equal(new Set(all.map((p) => p.id)).size, all.length);
  assert.deepEqual(collectPlaces(c, 0, 0, 1000).map((p) => p.id), all.map((p) => p.id));
  // radius is honoured, and an empty or missing city is an empty list
  assert.ok(!collectPlaces(c, 0, 0, 150).some((p) => p.name === 'Samota'));
  assert.deepEqual(collectPlaces(null, 0, 0, 100), []);
  assert.deepEqual(collectPlaces({}, 0, 0, 100), []);
});

test('a stop is the nearest drivable road, and its street is the address', () => {
  const c = city();
  const pub = resolveStop(c, { x: 50, z: 20 });
  // (changed on purpose: the stop used to be ON the centreline, where a stopped
  // car stood astride both lanes. It is in the lane against the pub's own kerb
  // now: the street is 8 m wide, so the car's middle is 2.75 m off the centre.)
  assert.deepEqual([pub.x, pub.z], [50, 2.8]);
  assert.equal(pub.street, 'Sladkovského');
  // the fare is on the pub's side, behind the kerb: off the 4 m of carriageway
  assert.equal(pub.wx, 50);
  assert.ok(pub.wz > 4.9 && pub.wz < 6, `the fare waits at z ${pub.wz}`);
  // a place the map put on the asphalt itself still gets a fare on the pavement
  const mid = resolveStop(c, { x: 70, z: 1 });
  assert.ok(Math.abs(mid.wz) > 4.9, `a fare on the carriageway (z ${mid.wz})`);
  assert.ok(Math.abs(mid.z) <= 2.8 && Math.sign(mid.z) === Math.sign(mid.wz), 'car and fare on one side');
  // …and never on the asphalt of the yard that joins there
  const corner = resolveStop(c, { x: 101, z: 9 });
  assert.ok(Math.abs(corner.wx - 100) >= 2.3 || corner.wz < 0, `the fare stands in the yard mouth (${corner.wx}, ${corner.wz})`);
  // the footway 10 m from the door is nearer than the street and is not a road
  assert.notEqual(pub.z, 30);
});

test('a named street beats a nearer yard, unless the yard is much nearer', () => {
  const c = city();
  // 8 m from the yard, 14 m from the street: the address wins
  const nearBoth = resolveStop(c, { x: 108, z: 14 });
  assert.equal(nearBoth.z, 2.8, 'on the street, pulled in to the near kerb');
  assert.equal(nearBoth.street, 'Sladkovského');
  // deep in the yard: stop in the yard, and still say which street it is off
  const florist = resolveStop(c, { x: 104, z: 52 });
  assert.ok(Math.abs(florist.x - 100) <= 2 && florist.z === 52, 'in the yard lane, on the florist\'s side of it');
  assert.equal(florist.street, 'Sladkovského');
});

test('no road in reach, a bridge, or no map: no stop', () => {
  const c = city();
  assert.equal(resolveStop(c, { x: 210, z: 310 }), null, 'a farm 300 m from any road got a kerb');
  // the café sits beside a bridge deck: the bridge is skipped, the street is too far
  assert.equal(resolveStop(c, { x: 20, z: -190 }), null);
  assert.equal(resolveStop(null, { x: 0, z: 0 }), null);
  assert.equal(resolveStop({}, { x: 0, z: 0 }), null);
});

test('the food counter: a venue point, or the eatery whose building you are at', () => {
  const c = city();
  assert.deepEqual(foodPlaceAt(c, -8, 12), { name: 'Pekařství Kabát', type: 'bakery' });
  assert.deepEqual(foodPlaceAt(c, 50, 20), { name: 'Hospoda U Kocoura', type: 'pub' }, 'inside the pub');
  assert.deepEqual(foodPlaceAt(c, 50, 8), { name: 'Hospoda U Kocoura', type: 'pub' }, 'at the pub door');
  assert.equal(foodPlaceAt(c, 50, -6), null, 'across the street is not at the pub');
  assert.equal(foodPlaceAt(c, -50, 20), null, 'the tax office does not serve lunch');
  assert.equal(foodPlaceAt(c, 104, 50), null, 'nor does the florist');
  assert.equal(foodPlaceAt(null, 0, 0), null);
  assert.ok(FOOD_TYPES.has('supermarket') && FOOD_TYPES.has('restaurant'));
});

test('the nearest reachable place of a kind, inside a distance band', () => {
  const c = city();
  const t = nearestStop(c, -300, 0, FOOD_TYPES, 100, 900);
  assert.equal(t.name, 'Pekařství Kabát');
  assert.equal(t.street, 'Sladkovského');
  assert.deepEqual([t.x, t.z], [-10, 2.8]);
  // the bakery is inside the minimum now; the pub is next, the unreachable ones are skipped
  assert.equal(nearestStop(c, -60, 0, FOOD_TYPES, 100, 900).name, 'Hospoda U Kocoura');
  assert.equal(nearestStop(c, -300, 0, new Set(['cinema']), 0, 900), null);
});

test('the generator and the collector agree: a real board from a real map', () => {
  const c = city();
  const places = collectPlaces(c, 0, 0, 1000);
  // one kind at a time: on a street this short the two kinds compete for the
  // same handful of places, which is the fixture's size and not a rule
  for (const counts of [{ courier: 2, taxi: 0 }, { courier: 0, taxi: 1 }]) {
    const run = () => generateJobs({ places, origin: { x: 0, z: 0 }, day: '2026-11-10',
      counts, resolve: (p) => resolveStop(c, p) });
    const jobs = run();
    assert.ok(jobs.length >= 1, `no ${counts.taxi ? 'taxi' : 'courier'} job on a street with nine named places`);
    assert.deepEqual(run(), jobs);
    for (const j of jobs) {
      assert.equal(j.from.street, 'Sladkovského');
      assert.notEqual(j.to.name, 'Samota', 'a job ends somewhere no road reaches');
      assert.notEqual(j.to.type, 'bus_stop');
      assert.ok(Number.isFinite(j.from.wx) && Number.isFinite(j.to.wz), 'no kerb point for the fare');
    }
  }
});

// ---- the stop follows the GPS line ----------------------------------------
// The yard stop of the florist is the case from the real map: the navigator
// will not drive into the yard and ends its route on the street 52 m away.
const navTo = (t, end, partial = false) => ({
  destination: { x: t.x, z: t.z }, route: [[-300, 0], end], partial,
});

test('a stop moves to where the route really ends, once, kerb on the place side', () => {
  const c = city();
  const t = { name: 'Květiny Jarmila', x: 100, z: 52, wx: 103.4, wz: 52, street: null };
  assert.equal(snapStopToRoute(t, navTo(t, [100, 0]), c), true);
  // (changed on purpose, as above: at the end of the line, pulled in to the kerb)
  assert.deepEqual([t.x, t.z], [100, 2.8]);
  assert.ok(Math.hypot(t.x - 100, t.z) < 6, 'still within an arrival of where the GPS line ends');
  assert.equal(t.street, 'Sladkovského', 'the address is the street the stop is on now');
  // (the line ends in the mouth of the yard, so the fare waits a few steps along the kerb from it)
  assert.ok(t.wz > 4.9 && Math.abs(t.wx - 100) >= 2.4 && Math.abs(t.wx - 100) < 8,
    `the fare is behind the kerb on the shop's side, out of the yard mouth (${t.wx}, ${t.wz})`);
  assert.equal(t.snap, 1);
  // a second route that ends somewhere else does not drag the stop about
  assert.equal(snapStopToRoute(t, navTo(t, [160, 0]), c), false);
  assert.deepEqual([t.x, t.z], [100, 2.8]);
});

test('a stop the route already reaches is left alone and not asked again', () => {
  const c = city();
  const t = { name: 'Pekařství Kabát', x: -10, z: 0, wx: -10, wz: 5.4, street: 'Sladkovského' };
  assert.equal(snapStopToRoute(t, navTo(t, [-10.4, 0.2]), c), false);
  assert.deepEqual([t.x, t.z, t.wz], [-10, 0, 5.4]);
  assert.equal(t.snap, 1);
});

test('no route, somebody else\'s route and a far partial route decide nothing', () => {
  const c = city();
  const fresh = () => ({ name: 'Květiny Jarmila', x: 100, z: 52, wx: 103.4, wz: 52, street: null });
  let t = fresh();
  assert.equal(snapStopToRoute(t, { destination: { x: 100, z: 52 }, route: null, partial: false }, c), false);
  assert.equal(snapStopToRoute(t, null, c), false);
  // the player's own pin: the route on screen is not the job's
  assert.equal(snapStopToRoute(t, { destination: { x: 0, z: 0 }, route: [[-300, 0], [0, 0]], partial: false }, c), false);
  // tiles still streaming: the line stops a kilometre short, so ask again later
  assert.equal(snapStopToRoute(t, navTo(t, [-900, 0], true), c), false);
  assert.equal(t.snap, undefined, 'nothing above settled the question');
  assert.deepEqual([t.x, t.z], [100, 52]);
  // a COMPLETE route that ends far away is an answer: give up, keep the stop
  assert.equal(snapStopToRoute(t, navTo(t, [-900, 0], false), c), false);
  assert.equal(t.snap, 1);
  // a partial route that already ends at the door is as good as a whole one
  t = fresh();
  assert.equal(snapStopToRoute(t, navTo(t, [100, 0], true), c), true);
  assert.deepEqual([t.x, t.z], [100, 2.8]);
});
