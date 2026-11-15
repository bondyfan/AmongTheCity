// Round 8 services: the fuel the tiles lack, the canopies lifted, and the
// pump answered from the forecourt as it is drawn (js/forecourt.js), on a
// hand-built tile and on the real Osice tile when it is on disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { servicesInto, liftCanopies, canopyFrame, SYNTH_FUEL, siteNear, sites } from '../js/d11services.js';
import { forecourtFrame, atForecourt, islandsOf, KERB_CLEAR } from '../js/forecourt.js';
import { indexPumps, pumpAt, shopAt, resetPumps } from '../js/pumps.js';
import { foodPlaceAt } from '../js/jobplaces.js';
import { CHUNK } from '../js/config.js';

const at = (f, a, b) => [f.x + f.lx * a + f.cx * b, f.z + f.lz * a + f.cz * b];

test('Osice westbound gets its Benzina pump with its tile, once, in the poi shape', () => {
  const data = { tx: -1, tz: -3, pois: [{ p: [-4000, -11000], t: 'bus_stop' }], buildings: [], roads: [] };
  servicesInto(data);
  const fuel = data.pois.filter((p) => p.t === 'fuel');
  assert.equal(fuel.length, 1);
  assert.deepEqual(fuel[0].p, [...SYNTH_FUEL[0].p]);
  assert.equal(fuel[0].n, 'Benzina');
  servicesInto(data);                                   // indexed twice: no second pump
  assert.equal(data.pois.filter((p) => p.t === 'fuel').length, 1);
  const other = { tx: 0, tz: -3, pois: [], buildings: [], roads: [] };
  servicesInto(other);
  assert.equal(other.pois.length, 0, 'no other tile gets it');
  // a fresh record per payload: never shared between two loads of the tile
  const again = { tx: -1, tz: -3, pois: [], buildings: [], roads: [] };
  servicesInto(again);
  assert.notEqual(again.pois[0], fuel[0]);
});

test('a mapped canopy is lifted to clear height and frames the pump along its lanes', () => {
  // a 24 x 14 m roof, lanes (a service way) running east through it
  const roof = { t: 'roof', h: 4.3, o: [[-12, -7], [12, -7], [12, 7], [-12, 7]] };
  const shop = { t: 'retail', h: 4.3, o: [[-12, 12], [12, 12], [12, 24], [-12, 24]] };
  const data = {
    pois: [{ p: [1, 2], t: 'fuel', n: 'MOL' }],
    buildings: [roof, shop],
    roads: [{ t: 'service', d: 1, w: 3.6, p: [[-30, -3], [30, -3]] }],
  };
  liftCanopies(data);
  assert.ok(roof.y >= 4, 'a lorry fits under it');
  assert.ok(roof.h > roof.y, 'it keeps a slab on top');
  assert.equal(shop.y, undefined, 'the shop stays on the ground');
  const poi = data.pois[0];
  assert.deepEqual(poi.cv, [0, 0, 1, 0, 12, 7]);
  assert.notEqual(poi.cr[0], roof.o[0], 'the ring is a copy');
  const f = forecourtFrame(poi, []);
  assert.equal(f.mapped, true);
  // every pump stands under the roof, and the pump answers there
  const isl = islandsOf(f);
  assert.equal(isl.across.length, 2);
  for (const b of isl.across) for (const a of [-isl.pump, isl.pump]) {
    const [x, z] = at(f, a, b);
    assert.ok(Math.abs(x) <= 12 && Math.abs(z) <= 7, 'pump under the roof');
    assert.ok(atForecourt(f, x, z), 'a car at the pump is at the forecourt');
  }
  assert.ok(!atForecourt(f, 0, 20), 'the shop door is not a pump');
});

test('a canopy with no lane under it follows its longest edge, with a fixed sense', () => {
  const a = canopyFrame([[0, 0], [0, 30], [10, 30], [10, 0]], []);
  const b = canopyFrame([[10, 0], [10, 30], [0, 30], [0, 0]], []);
  assert.deepEqual(a, b);
  assert.equal(Math.abs(a[3]), 1, 'lanes along the 30 m side');
  assert.equal(a[4], 15);
});

test('a built forecourt: slid off the kerb, and every pump island is inside the pump radius', () => {
  // the node 3 m from a 7 m street: the old rule slides it to w/2 + 12
  const roads = [{ t: 'residential', d: 1, w: 7, p: [[-100, 0], [100, 0]] }];
  const f = forecourtFrame({ p: [5, 3] }, roads);
  assert.equal(f.mapped, false);
  assert.ok(Math.abs(f.z - (3.5 + KERB_CLEAR)) < 1e-9, 'centre ' + f.z);
  assert.ok(Math.abs(f.x - 5) < 1e-9);
  const isl = islandsOf(f);
  for (const b of isl.across) for (const a of [-isl.pump, isl.pump]) {
    const [x, z] = at(f, a, b);
    assert.ok(atForecourt(f, x, z));
  }
  // the street outside is not the forecourt: a car stopped in the lane
  assert.ok(!atForecourt(f, 5, 1.5), 'the carriageway is not a pump');
  // 17 m from the node at the far island used to be refused (14 m radius)
  const [fx, fz] = at(f, isl.pump, isl.across[1]);
  assert.ok(Math.hypot(fx - 5, fz - 3) > 14 && atForecourt(f, fx, fz));
});

test('pumps.js: the pump and the fuel shop answer from the drawn frame', () => {
  resetPumps();
  const road = { t: 'residential', d: 1, w: 7, p: [[-100, 0], [100, 0]] };
  const chunkIndex = new Map([['0,0', { roads: [road], buildings: [], venues: [] }]]);
  const city = { chunkIndex };
  const poi = { p: [50, 3], t: 'fuel', n: 'Shell' };
  indexPumps([poi, { p: [60, 60], t: 'bus_stop' }]);
  assert.equal(pumpAt(city, 50, 15.5), poi, 'at the islands');
  assert.equal(pumpAt(city, 50, 1.5), null, 'on the street');
  assert.equal(shopAt(city, 50, 25), poi, 'on foot by the shop');
  // E on foot at a forecourt with no eatery: the shop menu, named by brand
  const fp = foodPlaceAt(city, 50, 25);
  assert.deepEqual(fp, { name: 'Shell · prodejna', type: 'fuel', menu: 'shop' });
  assert.ok(CHUNK >= 100);
  resetPumps();
});

test('the services table: every D11 side, Osice W through its synthetic pump', () => {
  const all = sites();
  const osW = all.find((s) => s.id === 'osice' && s.side === 'W');
  assert.ok(osW);
  assert.deepEqual([osW.x, osW.z], [...SYNTH_FUEL[0].p]);
  assert.equal(siteNear(-64028, -11167)?.id, 'bristvi', 'the Bříství lorry park');
  assert.equal(siteNear(25, -122), null, 'Pardubice station is not a services');
});

// The real tile, when the repository has it: the synthetic pump lands under
// the mapped canopy, and every D11 station with a roof is framed on it.
const TILES = new URL('../public/data/tiles/', import.meta.url);
test('real tiles: Osice W framed under its canopy, the roof passable', { skip: !fs.existsSync(new URL('-1_-3.json', TILES)) }, () => {
  const data = JSON.parse(fs.readFileSync(new URL('-1_-3.json', TILES)));
  servicesInto(data);
  const w = data.pois.find((p) => p.t === 'fuel' && p.n === 'Benzina' && Math.hypot(p.p[0] + 4133.5, p.p[1] + 11917) < 1);
  assert.ok(w?.cv, 'framed');
  const roofs = data.buildings.filter((b) => b.t === 'roof' && b.y > 0);
  assert.ok(roofs.length >= 2, 'both Osice canopies lifted');
  const f = forecourtFrame(w, []);
  assert.ok(f.LA > 8 && f.LB > 8, 'a forecourt-sized roof');
});
