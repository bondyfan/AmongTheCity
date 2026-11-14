// ---- a tile's data has a lifetime: deep eviction and the way back -----------
// geo.js evictDeep gives back everything a far tile filed in the chunk index
// (and its polygons, fences, venues, power lines and furniture) and keeps only
// the ways, the rails, the pois, the signals and the car parks. Since round 7
// it also RELEASES what the graphs built from those ways (geo.js
// RELEASE_GRAPHS, city.onTileReleased): the traffic edges, nodes and lights,
// the route planner's graph, the walkers' paths and sites. These pin both
// halves of that promise on the real Pardubice tiles: while away the data and
// the graphs are GONE (cells, flat arrays, graph structures, and the objects
// themselves once nothing holds them), and coming back gives the SAME world:
// every cell holds the same ids, the kept ways are the same objects and are
// handed to the graphs again, and the graphs come out exactly as a client's
// that never had the tiles and got them in the same order. The last test is
// the co-op half: one tile released and returned while its neighbour stays
// gives the cells, slots and light phases of a fresh build in either order,
// away from the seam (every player is EVICT_REACH from a released tile).

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
  for (let i = 0; i < 1500 && (city.releasing > 0 || city.manifestTiles.some((t) => t.state === 1)); i++)
    await new Promise((r) => setTimeout(r, 20));
};
const settleAt = async ([x, z]) => {
  // one eviction per call, by design: call until nothing is left to do
  for (let i = 0; i < 60; i++) { await city.ensureTiles(x, z); await idle(); }
};

const log = console.log; console.log = () => {};
const { Traffic } = await import('../js/traffic.js');
const { Pedestrians } = await import('../js/pedestrians.js');
const { Navigation } = await import('../js/navigation.js');
const { SITE } = await import('../js/crowdsites.js');
const { Cyclists } = await import('../js/cyclists.js');
await settleAt(SPAWN);
const traffic = new Traffic(city, stubVehicles());
const peds = new Pedestrians({ add() {}, remove() {} }, city);
const nav = new Navigation(city);
const cyc = new Cyclists({ add() {}, remove() {} }, city, null, { peds, traffic });
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

// order-free prints of a traffic graph: what co-op clients have to agree on
const cellPrint = (t, keep = () => true) => {
  t._densK = 1;
  const out = [];
  for (const [k, c] of t._cells) {
    if (!keep(c)) continue;
    const es = t._cellEdges(c).map((e) => e.eid + ':' + e.len.toFixed(3)).join(',');
    out.push(k + '=' + t._slots(c) + '/' + c.len.toFixed(6) + '/' + es);
  }
  return out.sort();
};
// (where a controller stands and its phase; not how many masts it found room
// for: a mast refuses a spot on a junction pad, and how far a pad reaches
// depends on the buildings streamed in at that moment, js/streets.js builtUp)
const juncPrint = (t, keep = () => true) => t._junctions.filter(keep)
  .map((j) => [Math.round(j.x * 10), Math.round(j.z * 10), j.off.toFixed(6)].join(',')).sort();
const edgeSet = (t) => t.edges.map((e) => e.eid + ':' + e.a.x.toFixed(1) + ',' + e.a.z.toFixed(1) + ':' + e.len.toFixed(3)).sort();
// a Traffic over no world at all, fed tile payloads by hand. The ways carry
// one stamp per graph kind (_tg), so it is cleared before every replay.
const unstamp = () => { for (const r of city.roads) r._tg = 0; };
const replay = (payloads) => {
  unstamp();
  const t = new Traffic({ roads: [], signals: [] }, stubVehicles());
  for (const p of payloads) t.addTile(p);
  return t;
};

// ---- the co-op half, while the town is resident: one tile out and back ----
const tA = city.manifestTiles.find((t) => t.tx === 0 && t.tz === -1);
const tB = city.manifestTiles.find((t) => t.tx === -1 && t.tz === -1);
const payOf = (t) => ({ roads: t.res.roads, signals: t.res.signals, tx: t.tx, tz: t.tz });
const relOf = (t) => ({ roads: t.res.roads, signals: t.res.signals, rect: [t.tx * city.tile, t.tz * city.tile, (t.tx + 1) * city.tile, (t.tz + 1) * city.tile] });
const seam = {};
const stamps = city.roads.map((r) => r._tg);
{
  const off = (x) => Math.abs(x) > 600;                   // the seam is x = 0
  const far = (c) => off((c.ci + 0.5) * 256);
  const farJ = (j) => off(j.x);
  const ab = replay([payOf(tA), payOf(tB)]);
  seam.ab = { cells: cellPrint(ab), far: cellPrint(ab, far), junc: juncPrint(ab, farJ), edges: edgeSet(ab) };
  const ba = replay([payOf(tB), payOf(tA)]);
  seam.ba = { far: cellPrint(ba, far), junc: juncPrint(ba, farJ) };
  // A, B, B out, B back: the graph is A's alone and then A-then-B, everywhere
  const r1 = replay([payOf(tA), payOf(tB)]);
  r1.releaseTile(relOf(tB));
  seam.onlyA = { cells: cellPrint(r1), edges: edgeSet(r1), nodes: r1._nodes.size, usage: r1._usage.size };
  r1.addTile(payOf(tB));
  seam.r1 = { cells: cellPrint(r1), edges: edgeSet(r1) };
  const a = replay([payOf(tA)]);
  seam.a = { cells: cellPrint(a), edges: edgeSet(a), nodes: a._nodes.size, usage: a._usage.size };
  // B, A, B out, B back: "release then return" against a fresh build in the
  // other order, which is what two co-op clients that streamed differently hold
  const r2 = replay([payOf(tB), payOf(tA)]);
  r2.releaseTile(relOf(tB));
  r2.addTile(payOf(tB));
  seam.r2 = { far: cellPrint(r2, far), junc: juncPrint(r2, farJ) };
  for (let i = 0; i < city.roads.length; i++) city.roads[i]._tg = stamps[i];   // the real graph's own
}

const ixA = indexPrint(), trA = trafficPrint(), pdA = pedPrint(), flatA = flat();
const navA = [nav._segs.length, nav._nodeIx.size];
const cycA = [cyc.net.count, cyc.net.nodes.size, cyc._cells.size];
const roadsA = city.roads.slice();
const edgeRef = new WeakRef(traffic.edges[traffic.edges.length >> 1]);
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
  // ...and every graph let go of the town's ways
  assert.equal(traffic.edges.length, 0, 'traffic edges');
  assert.equal(traffic._nodes.size, 0, 'traffic nodes');
  assert.equal(traffic._usage.size, 0, 'traffic usage census');
  assert.equal(traffic._egrid.m.size, 0, 'edge grid');
  assert.equal(traffic._cells.size, 0, 'population cells');
  assert.equal(traffic._junctions.length, 0, 'signal controllers');
  // (what stays are the gate walks of js/landmarks-walks.js: module ways, no tile's)
  for (const r of peds.paths) assert.ok(!roadsA.includes(r), 'a footway of the town is still walked');
  for (const c of peds._cells.values()) for (const r of c.paths) assert.ok(!roadsA.includes(r), 'a square still holds a town footway');
  assert.equal(peds.drive.m.size, 0, 'carriageways the crowd still crosses');
  for (const a of peds.sites.m.values()) for (const st of a) assert.equal(st.kind, SITE.STOP, 'only the bus stops (kept pois) stay sites');
  assert.equal(nav._segs.length, 0, 'route planner segments');
  assert.equal(nav._nodeIx.size, 0, 'route planner nodes');
  assert.deepEqual([cyc.net.count, cyc.net.nodes.size, cyc._cells.size], [0, 0, 0], 'cycle net');
  // (a WeakRef keeps its target alive to the end of the job that last read
  // it: collect, and look, in jobs of their own)
  await new Promise((r) => setTimeout(r, 5));
  gc(); gc();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(greenRef.deref(), undefined, 'an evicted green polygon is still held by something');
  assert.equal(edgeRef.deref(), undefined, 'a released traffic edge is still held by something');
});

test('coming back gives the same world', async () => {
  let payloads = [];
  city.onTileLoaded((t) => payloads.push(t));
  await settleAt(SPAWN);
  const back = payloads.filter((t) => loadedA.includes(t.tx + ',' + t.tz));
  assert.ok(back.length >= loadedA.length, 'the town tiles were not fetched again');
  let ways = 0;
  for (const t of back) {
    // the graphs gave the ways back, so they are handed over again: the KEPT
    // objects, not new ones; the pois never left and are not re-delivered
    assert.equal(t.again, true);
    assert.equal(t.pois.length, 0);
    for (const r of t.roads) assert.ok(roadsA.includes(r), 'a way that is a new object');
    ways += t.roads.length;
  }
  assert.ok(ways > 1000, ways + ' ways handed back');
  // (every tile that arrived, in the order it did: the graphs heard them all)
  const replayed = payloads.map((t) => ({ roads: t.roads, signals: t.signals }));
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
  // the graphs: what a client that never had these tiles builds from the same
  // payloads in the same order, to the edge, the cell, the slot and the phase
  traffic.addTile({ roads: [], signals: [] });
  const here = { cells: cellPrint(traffic), junc: juncPrint(traffic), edges: edgeSet(traffic), n: traffic._nodes.size, u: traffic._usage.size };
  const fresh = replay(replayed);
  assert.deepEqual(here.edges, edgeSet(fresh), 'traffic edges');
  assert.deepEqual(here.cells, cellPrint(fresh), 'population cells and slots');
  assert.deepEqual(here.junc, juncPrint(fresh), 'signal controllers and phases');
  assert.equal(here.n, fresh._nodes.size); assert.equal(here.u, fresh._usage.size);
  assert.ok(here.edges.length > 0.9 * trA.split('/')[0], 'the town drives again');
  // walkers: the same paths, ids and sites as before the tour (the list in
  // the order the tiles came back; every reader sorts a square's paths first)
  const pids = (p) => p.split('/')[1].split(',').sort().join(',');
  assert.equal(pedPrint().split('/')[0], pdA.split('/')[0]);
  assert.equal(pids(pedPrint()), pids(pdA));
  assert.equal(peds.sites.count, +pdA.split('/')[2]);
  // the route planner too: what a fresh one builds from the same payloads
  const navHere = [nav._segs.length, nav._nodeIx.size];
  for (const r of city.roads) r._ng = 0;
  const nav2 = new Navigation({ roads: [] });
  for (const p of replayed) nav2._growGraph(p.roads);
  assert.deepEqual(navHere, [nav2._segs.length, nav2._nodeIx.size], 'route planner');
  assert.ok(navHere[0] > 0.9 * navA[0], 'the planner has the town again');
  // the cycle net keys its ways by object and its nodes by position: the same net
  assert.deepEqual([cyc.net.count, cyc.net.nodes.size, cyc._cells.size], cycA, 'cycle net');
});

test('one tile out and back: the graph its neighbour sees is a fresh build in either order', () => {
  // A then B, B released: exactly A alone
  assert.deepEqual(seam.onlyA.edges, seam.a.edges, 'edges after the release');
  assert.deepEqual(seam.onlyA.cells, seam.a.cells, 'cells after the release');
  assert.equal(seam.onlyA.nodes, seam.a.nodes);
  assert.equal(seam.onlyA.usage, seam.a.usage);
  // ...and back: A then B, everywhere
  assert.deepEqual(seam.r1.edges, seam.ab.edges);
  assert.deepEqual(seam.r1.cells, seam.ab.cells);
  // B, A, B out and back against the other order: identical away from the
  // seam, which is the only place a co-op player can be
  assert.ok(seam.ab.far.length > 100, seam.ab.far.length + ' cells compared');
  assert.deepEqual(seam.r2.far, seam.ab.far, 'cells and slots');
  assert.deepEqual(seam.r2.junc, seam.ab.junc, 'signal phases');
  assert.deepEqual(seam.ba.far, seam.ab.far, '(and the two fresh orders agree there too)');
});
