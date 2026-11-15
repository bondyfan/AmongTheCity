// ---- a far pin: the route goes on over the region's major roads -------------
// js/coarseroute.js builds one graph of the overview's motorways, trunks,
// primaries and secondaries; js/navigation.js hands it the part of a route the
// streamed roads cannot reach. Pinned here: Pardubice station to the Old Town
// Square takes the D11 (the overview has no slip roads, and before the dangling
// ends were joined the route went round by the old roads, 165 km and 141
// minutes), and a partial fine route carries on to the pin with its turns kept.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { CoarseRoutes } = await import('../js/coarseroute.js');
const { Navigation } = await import('../js/navigation.js');

const overview = JSON.parse(await readFile(new URL('../public/data/overview.json', import.meta.url), 'utf8'));

test('Pardubice station to the Old Town Square goes by the D11', async () => {
  const c = await CoarseRoutes.create(overview.roads);
  assert.ok(c.n > 20000 && c.m > 20000, `${c.n} nodes, ${c.m} edges`);
  const r = c.route(25, -122, -95636, -6206);
  assert.ok(r, 'no route');
  assert.ok(r.len > 100e3 && r.len < 150e3, (r.len / 1000).toFixed(1) + ' km');
  assert.ok(r.secs < 90 * 60, (r.secs / 60).toFixed(0) + ' min');
  const end = r.pts[r.pts.length - 1];
  assert.ok(Math.hypot(end[0] + 95636, end[1] + 6206) < 1500, 'ends ' + end.map(Math.round));
  assert.equal(r.speeds.length, r.pts.length);
  // half the way it runs on the motorway: along the D11 west of Pardubice
  // (x -20 to -60 km) it keeps north of z -11.5 km and south of z -9 km
  const mid = r.pts.filter((p) => p[0] < -20e3 && p[0] > -60e3);
  assert.ok(mid.length > 10 && mid.every((p) => p[1] > -12e3 && p[1] < -9e3), 'not on the D11');
  // the same graph built at once answers the same
  const d = new CoarseRoutes(overview.roads).route(25, -122, -95636, -6206);
  assert.equal(d.pts.length, r.pts.length);
  assert.equal(d.secs, r.secs);
  // a pin in a field far from every major road gets no coarse line
  assert.equal(c.route(25, -122, 400000, 400000), null);
});

test('a route that stops short of the pin goes on over the coarse graph', () => {
  // the streamed roads: one street, 1 km; the pin 11 km on, where nothing has
  // streamed (further than the planner snaps a pin, navigation.js MAX_RING)
  const street = { d: 1, t: 'secondary', v: 50, n: 'ulice', p: [[0, 0], [500, 0], [1000, 0]] };
  const nav = new Navigation({ roads: [street] });
  nav.setDestination(12000, 40);
  assert.ok(nav.reroute(20, 0));
  assert.ok(nav.partial);
  assert.equal(nav.coarseFrom, -1, 'no coarse graph yet: the route ends where the streets do');
  const shortEnd = nav.route[nav.route.length - 1];
  assert.ok(shortEnd[0] <= 1000.5);
  // the major road beyond, as the overview has it
  nav.coarse = new CoarseRoutes([{ t: 'secondary', p: [[1000, 0], [6000, 0], [12000, 0]] }]);
  assert.ok(nav.reroute(20, 0));
  assert.ok(nav.partial, 'still partial: the fine planner takes it back as tiles arrive');
  assert.ok(nav.coarseFrom > 0);
  const end = nav.route[nav.route.length - 1];
  assert.ok(Math.hypot(end[0] - 12000, end[1]) < 1, 'ends ' + end);
  // the distance left is the road's, plus the last 40 m to the pin
  assert.ok(Math.abs(nav.remainingM - (11980 + 40)) < 30, nav.remainingM.toFixed(0));
  assert.ok(Number.isFinite(nav.etaS) && nav.etaS > 11980 / 25, nav.etaS.toFixed(0));
});
