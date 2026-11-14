// ---- a tile's data has a lifetime: deep eviction and the way back -----------
// geo.js evictDeep gives back everything a far tile filed in the chunk index
// (and its polygons, fences, venues, power lines and furniture) and keeps only
// what the session's graphs hold: the ways, the rails, the pois, the signals
// and the car parks. These pin the two halves of that promise on the real
// Pardubice tiles: while away the data is GONE (cells, flat arrays, and the
// objects themselves once nothing holds them), and coming back gives the SAME
// world: every cell holds the same ids, the kept ways are the same objects,
// and the traffic and walker graphs built from them did not move.

import test from 'node:test';
import assert from 'node:assert';
import v8 from 'node:v8';
import vm from 'node:vm';
import { bootCity, stubVehicles } from './flow-harness.mjs';

v8.setFlagsFromString('--expose_gc');
const gc = vm.runInNewContext('gc');

const SPAWN = [25, -122];
const NOWHERE = [1e7, 1e7];          // outside the manifest: nothing loads there
const city = await bootCity();
const idle = async () => {
  for (let i = 0; i < 1500 && city.manifestTiles.some((t) => t.state === 1); i++)
    await new Promise((r) => setTimeout(r, 20));
};
const settleAt = async ([x, z]) => {
  // one eviction per call, by design: call until nothing is left to do
  for (let i = 0; i < 60; i++) { await city.ensureTiles(x, z); await idle(); }
};

const log = console.log; console.log = () => {};
const { Traffic } = await import('../js/traffic.js');
const { Pedestrians } = await import('../js/pedestrians.js');
await settleAt(SPAWN);
const traffic = new Traffic(city, stubVehicles());
const peds = new Pedestrians({ add() {}, remove() {} }, city);
console.log = log;

const near = (k, R = 6000) => {
  const i = k.indexOf(','), cx = +k.slice(0, i), cz = +k.slice(i + 1);
  return Math.abs(cx * 120 - SPAWN[0]) <= R && Math.abs(cz * 120 - SPAWN[1]) <= R;
};
const indexPrint = () => {
  const out = new Map();
  for (const [k, c] of city.chunkIndex) {
    if (!near(k)) continue;
    const row = [];
    for (const kind in c) row.push(kind + ':' + c[kind].map((f) => f._id).sort((a, b) => a - b).join(','));
    out.set(k, row.join('|'));
  }
  return out;
};
const trafficPrint = () => {
  let h = 0;
  for (const e of traffic.edges) {
    for (const v of [e.a.x, e.a.z, e.b.x, e.b.z, e.len, e.road._id]) h = (h * 31 + Math.round(v * 100)) | 0;
  }
  return [traffic.edges.length, traffic._nodes.size, traffic._junctions.length, h].join('/');
};
const pedPrint = () => [peds.paths.length, peds.paths.map((r) => r._pid).join(','), peds.sites.count].join('/');
const flat = () => Object.fromEntries(['buildings', 'trees', 'roads', 'rails', 'water', 'green', 'paved', 'power',
  'venues', 'barriers', 'pois', 'signals', 'waterways'].map((k) => [k, city[k].length]));

const ixA = indexPrint(), trA = trafficPrint(), pdA = pedPrint(), flatA = flat();
const roadsA = city.roads.slice();
const greenRef = new WeakRef(city.green.find((f) => near(f._home)));
const loadedA = city.manifestTiles.filter((t) => t.state === 2).map((t) => t.tx + ',' + t.tz).sort();

test('the spawn tiles are loaded and filed', () => {
  assert.ok(loadedA.length >= 4, `only ${loadedA.length} tiles round the spawn`);
  assert.ok(ixA.size > 5000, `${ixA.size} cells`);
  assert.ok(greenRef.deref(), 'no green polygon round the spawn');
});

test('a co-op peer standing in the town keeps its tiles', async () => {
  const hold = (out) => out.push(SPAWN[0], SPAWN[1]);
  city.evictHolds.push(hold);
  try {
    await settleAt(NOWHERE);
    for (const t of city.manifestTiles) {
      if (!loadedA.includes(t.tx + ',' + t.tz)) continue;
      assert.notEqual(t.state, 0, `tile ${t.tx},${t.tz} was evicted under a peer`);
      assert.equal(t.kept, null);
    }
  } finally { city.evictHolds.splice(city.evictHolds.indexOf(hold), 1); }
});

test('far away, the data of the town is gone', async () => {
  await settleAt(NOWHERE);
  const deep = city.manifestTiles.filter((t) => loadedA.includes(t.tx + ',' + t.tz));
  for (const t of deep) {
    assert.equal(t.state, 0, `tile ${t.tx},${t.tz} is in state ${t.state}`);
    assert.ok(t.kept && t.res === null && t.cells === null, `tile ${t.tx},${t.tz} kept nothing, or kept it all`);
  }
  let left = 0;
  for (const k of city.chunkIndex.keys()) if (near(k)) left++;
  assert.equal(left, 0, `${left} cells round the spawn outlived every tile that filed them`);
  const f = flat();
  for (const k of ['buildings', 'trees', 'water', 'green', 'power', 'venues', 'barriers', 'waterways'])
    assert.equal(f[k], 0, `${f[k]} ${k} still listed`);
  // ...and the kept kinds were not touched
  for (const k of ['roads', 'rails', 'pois', 'signals']) assert.equal(f[k], flatA[k], k);
  assert.ok(f.paved > 0 && f.paved < flatA.paved, 'only the car parks stay listed');
  // (a WeakRef keeps its target alive to the end of the job that last read
  // it: collect, and look, in jobs of their own)
  await new Promise((r) => setTimeout(r, 5));
  gc(); gc();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(greenRef.deref(), undefined, 'an evicted green polygon is still held by something');
});

test('coming back gives the same world', async () => {
  let payloads = [];
  city.onTileLoaded((t) => payloads.push(t));
  await settleAt(SPAWN);
  const back = payloads.filter((t) => loadedA.includes(t.tx + ',' + t.tz));
  assert.ok(back.length >= loadedA.length, 'the town tiles were not fetched again');
  for (const t of back) {
    // the graphs never hear about ways they already have
    assert.equal(t.roads.length, 0); assert.equal(t.signals.length, 0); assert.equal(t.pois.length, 0);
  }
  payloads = null;
  const ixB = indexPrint();
  assert.equal(ixB.size, ixA.size, 'a different set of cells');
  let differ = 0, first = '';
  for (const [k, v] of ixA) if (ixB.get(k) !== v) { differ++; first ||= k + '\n' + v.slice(0, 200) + '\n' + ixB.get(k)?.slice(0, 200); }
  assert.equal(differ, 0, `${differ} cells hold other features: ${first}`);
  assert.deepEqual(flat(), flatA);
  assert.equal(city.roads.length, roadsA.length);
  for (let i = 0; i < roadsA.length; i++) if (city.roads[i] !== roadsA[i]) assert.fail(`way ${i} is a new object`);
  for (const t of city.manifestTiles) assert.equal(t.kept ?? null, t.state === 0 ? t.kept ?? null : null);
  // the graphs see the same thing (and are asked again, as the game does)
  traffic.addTile({ roads: [], signals: [] });
  assert.equal(trafficPrint(), trA);
  assert.equal(pedPrint(), pdA);
});
