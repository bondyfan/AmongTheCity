// ---- the small indexes a released tile has to leave too --------------------
// geo.js RELEASE_GRAPHS (city.onTileReleased): beside the big graphs pinned in
// tests/tile-eviction.test.mjs, the crowd's site and carriageway indexes, the
// cycle net, the derived bus regions and the real lines laid on the traffic
// graph each take back what came from the far tile and nothing else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { SiteIndex, RoadIndex, SITE } = await import('../js/crowdsites.js');
const { CycleNet } = await import('../js/cyclenet.js');
const { Buses } = await import('../js/buses.js');
const { RealLines } = await import('../js/realtransit.js');

const TILE = 1 << 20;

test('sites go by their feature id block, bus stops stay', () => {
  const s = new SiteIndex();
  s.add(SITE.BENCH, 10, 10, 3 * TILE + 5);
  s.add(SITE.ZEBRA, 20, 10, 3 * TILE + 9);
  s.add(SITE.BENCH, 30, 10, 4 * TILE + 1);       // the neighbour tile's
  s.add(SITE.STOP, 12, 12, null, { spot: {} });  // from a kept poi
  assert.equal(s.count, 4);
  assert.equal(s.removeIds(3 * TILE, 4 * TILE), 2);
  assert.equal(s.count, 2);
  assert.deepEqual(s.near(20, 10, 30).map((q) => q.kind).sort(), [SITE.BENCH, SITE.STOP]);
  // and it can come back: the id is free again
  assert.ok(s.add(SITE.BENCH, 10, 10, 3 * TILE + 5));
  assert.equal(s.add(SITE.BENCH, 30, 10, 4 * TILE + 1), null, 'the neighbour is still deduped');
});

test('a carriageway leaves every grid cell it was filed in', () => {
  const ix = new RoadIndex();
  const a = { p: [[0, 0], [200, 0]], w: 6 }, b = { p: [[0, 10], [200, 10]], w: 6 };
  ix.add(a); ix.add(b);
  assert.equal(ix.nearest(100, 2, 30).r, a);
  ix.remove([a]);
  assert.equal(ix.nearest(100, 2, 30).r, b);
  for (const segs of ix.m.values()) for (const g of segs) assert.equal(g.r, b);
});

test('the cycle net lets ways go and takes them back', () => {
  const net = new CycleNet();
  const w1 = { _id: 11, t: 'cycleway', p: [[0, 0], [50, 0]] };
  const w2 = { _id: 12, t: 'cycleway', p: [[50, 0], [100, 0]] };
  net.add([w1, w2]);
  const n0 = net.nodes.size, rev = net.rev;
  assert.equal(net.count, 2);
  const out = net.remove([w2]);
  assert.equal(out.length, 1);
  assert.equal(net.count, 1);
  assert.ok(net.rev > rev);
  assert.equal(net.ways.has(w2), false);
  assert.ok(net.nodes.size < n0);
  for (const a of net.nodes.values()) for (let i = 0; i < a.length; i += 2) assert.equal(a[i].r, w1);
  net.add([w2]);
  assert.equal(net.count, 2);
  assert.equal(net.nodes.size, n0);
});

const stubCity = () => ({ pois: [], tile: 4800, manifestTiles: null, onTileLoaded() {}, onTileReleased() {}, routeFilesNear: () => [] });
const stubTraffic = () => ({ _egrid: { m: new Map() }, hasSlot: () => false, addFixed() {} });

test('bus regions reaching into the tile are forgotten with their lines', () => {
  const b = new Buses(stubCity(), stubTraffic());
  const mk = (id, x, z) => ({ id, stops: [{ x, z }, { x: x + 300, z }], rx: 0, rz: 0 });
  const near = mk(1, 800, 800), far = mk(2, -20000, 800);
  b._regions.set('0,0', [near]);
  b._regions.set('-13,0', [far]);
  b._regions.set('2,2', undefined);               // (underived: nothing to drop but the key)
  b._regions.set('5,5', []);                      // 7200 m and beyond: clear of the tile
  for (const l of [near, far]) {
    b.lines.push(l);
    b._byStop.set('k' + l.id, [{ line: l, i: 0 }]);
    b._hops.set('h' + l.id, [l]);
    b._times.set(l.id + ':7', new Float64Array(2));
  }
  b._gen = 3;
  // tile 0,0 (0..4800 m): region 0,0 reaches in, region -13,0 does not
  b.releaseTile({ rect: [0, 0, 4800, 4800], roads: [] });
  assert.deepEqual([...b._regions.keys()].sort(), ['-13,0', '5,5']);
  assert.deepEqual(b.lines, [far]);
  assert.deepEqual([...b._byStop.keys()], ['k2']);
  assert.deepEqual([...b._hops.keys()], ['h2']);
  assert.deepEqual([...b._times.keys()], ['2:7']);
  assert.ok(b._gen > 3 && b._dirty);
});

test('a real line laid over a released way is laid again', () => {
  const rl = new RealLines(stubCity(), stubTraffic());
  const road = { t: 'primary' }, other = { t: 'primary' };
  const hit = { chains: [{ steps: [{ e: { road: other } }, { e: { road } }] }], gen: 5, whole: true };
  const miss = { chains: [{ steps: [{ e: { road: other } }] }], gen: 5, whole: true };
  rl.lines.push(hit, miss);
  rl.releaseTile({ roads: [road] });
  assert.equal(hit.chains, null); assert.equal(hit.whole, false); assert.equal(hit.gen, -1);
  assert.ok(miss.chains); assert.equal(miss.whole, true);
});
