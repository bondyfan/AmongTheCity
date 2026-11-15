// ---- where a game begins: Pardubice or Praha --------------------------------
// js/startplace.js decides where boot stands the player, which hospital you
// wake up in and when a city's parked fleet may be laid out. The pure half is
// pinned on numbers; the data half on the real tiles: a Prague start asks for
// Prague tiles only (no Pardubice tile is fetched, so none is pinned), its
// square passes main.js's boot gate, and the Prague hospital point stands
// clear of buildings and of the carriageway, as the Pardubice one does.

import test from 'node:test';
import assert from 'node:assert/strict';
import { bootCity } from './flow-harness.mjs';

const { START_PLACES, HOSPITALS, FLEET_STRIDE, CHUNK } = await import('../js/config.js');
const SP = await import('../js/startplace.js');
const geo = await import('../js/geo.js');
const { parkSpots } = await import('../js/parkspot.js');

const PARDUBICE = START_PLACES[0], PRAHA = START_PLACES[1];

test('the places: Pardubice first (its fleet keeps claim keys 0..), Praha second', () => {
  assert.equal(PARDUBICE.id, 'pardubice');
  assert.equal(PRAHA.id, 'praha');
  assert.deepEqual([PARDUBICE.x, PARDUBICE.z], [25, -122]);
  assert.ok(FLEET_STRIDE >= 16 && Number.isInteger(FLEET_STRIDE));
  assert.equal(SP.placeIndex(PRAHA), 1);
});

test('placeOf: the nearer city, also along the D11 corridor', () => {
  assert.equal(SP.placeOf(1690, -780), PARDUBICE);
  assert.equal(SP.placeOf(-95270, -5517), PRAHA);
  assert.equal(SP.placeOf(-30000, -9000), PARDUBICE);   // Kolín side
  assert.equal(SP.placeOf(-80000, -8000), PRAHA);       // Úvaly side
  assert.equal(SP.placeOf(NaN, 0), PARDUBICE);
});

test('startPoint: a save continues in its own city, the other city starts on its square', () => {
  const inPard = { x: 1690, z: -780.3, h: 1.2 }, inPraha = { x: -95300, z: -5600, h: 0.4 };
  // fresh game: the picked square, or Pardubice when nothing was picked
  assert.deepEqual(SP.startPoint('praha', null), { x: PRAHA.x, z: PRAHA.z, heading: PRAHA.heading, place: PRAHA, saved: false });
  assert.equal(SP.startPoint(null, null).place, PARDUBICE);
  assert.equal(SP.startPoint('nowhere', null).place, PARDUBICE);
  // a save in the picked city (or no pick): where it was
  assert.deepEqual(SP.startPoint('pardubice', inPard), { x: 1690, z: -780.3, heading: 1.2, place: PARDUBICE, saved: true });
  assert.deepEqual(SP.startPoint(null, inPraha), { x: -95300, z: -5600, heading: 0.4, place: PRAHA, saved: true });
  // the other city: its square, the save's spot is not used
  const sp = SP.startPoint('praha', inPard);
  assert.equal(sp.saved, false);
  assert.deepEqual([sp.x, sp.z], [PRAHA.x, PRAHA.z]);
});

test('the hospital you wake up in is the one of the city you fell in', () => {
  assert.equal(SP.nearestHospital(100, 100), HOSPITALS[0]);
  assert.deepEqual([HOSPITALS[0].x, HOSPITALS[0].z], [2291, 295]);
  const h = SP.nearestHospital(-95636, -6206);
  assert.equal(h, HOSPITALS[1]);
  assert.ok(Math.hypot(h.x + 95636, h.z + 6206) < 3000, 'within reach of the Old Town Square');
});

test('a death out on the D11 wakes you at the nearest services, not 50 km back', () => {
  // km 41 between Kluk and Libice: Dobšice (the Shell off exit 50) or Vrbová Lhota
  const h = SP.nearestHospital(-44000, -9900);
  assert.ok(/^Odpočívka /.test(h.name), h.name);
  assert.ok(Math.hypot(h.x + 44000, h.z + 9900) < 12000);
  // near either city it is still that city's hospital
  assert.equal(SP.nearestHospital(-90000, -7600), HOSPITALS[1]);
  assert.equal(SP.nearestHospital(-5000, -5000), HOSPITALS[0]);
  // Dolní Roveň (D35) has no fuel poi: its point is the slip roads' midpoint,
  // on the carriageway, so nobody is put down there (round 8 review)
  const r = SP.nearestHospital(17500, 1700);
  assert.ok(!/Roveň/.test(r.name ?? ''), r.name);
});

test('the boot cover names the city', () => {
  assert.equal(SP.arriveText(PARDUBICE), 'Přijíždíte do Pardubic…');
  assert.equal(SP.arriveText(PRAHA), 'Přijíždíte do Prahy…');
});

test('tilesReady: every tile within reach indexed, and at least one', () => {
  const tiles = [{ tx: 0, tz: 0, state: 2 }, { tx: 1, tz: 0, state: 2 }, { tx: 5, tz: 5, state: 0 }];
  const city = { tile: 1000, manifestTiles: tiles };
  assert.equal(SP.tilesReady(city, 500, 500), true);
  assert.equal(SP.tilesReady(city, 990, 500), true);
  tiles[1].state = 3;                                   // slim: its buildings are gone
  assert.equal(SP.tilesReady(city, 990, 500), false);
  assert.equal(SP.tilesReady(city, 500, 500), true);    // 500 m from tile 1, beyond 400
  assert.equal(SP.tilesReady(city, -9000, -9000), false);
  // legacy single file: the cell exists or not
  const legacy = { chunkIndex: new Map([['0,0', {}]]) };
  assert.equal(SP.tilesReady(legacy, 10, 10, 400, CHUNK), true);
  assert.equal(SP.tilesReady(legacy, -95668, -6192, 400, CHUNK), false);
});

// ---- the real tiles ----------------------------------------------------------
const city = await bootCity();
const fetched = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url) => { fetched.push(String(url)); return realFetch(url); };
const idle = async () => {
  for (let i = 0; i < 1500 && city.manifestTiles.some((t) => t.state === 1); i++)
    await new Promise((r) => setTimeout(r, 20));
};
const sp = SP.startPoint('praha', null);
await city.ensureTiles(sp.x, sp.z);
await idle();
globalThis.fetch = realFetch;

test('a Praha start fetches Prague tiles only, no Pardubice tile is ever loaded', () => {
  const tiles = fetched.filter((u) => /data\/tiles\//.test(u));
  assert.ok(tiles.length >= 2, 'the Old Town and its neighbours: ' + tiles.join(' '));
  for (const u of tiles) {
    const [tx] = u.match(/(-?\d+)_(-?\d+)\.json/).slice(1).map(Number);
    assert.ok(tx <= -17, 'a Prague tile, not ' + u);
  }
  for (const t of city.manifestTiles) if (t.tx >= -1 && t.tx <= 1) assert.equal(t.state, 0, 'Pardubice tile ' + t.tx + ',' + t.tz);
});

test('the Prague square passes the boot gate, stands clear, and has its fleet', () => {
  const cell = city.chunkIndex.get(Math.floor(sp.x / CHUNK) + ',' + Math.floor(sp.z / CHUNK));
  assert.ok(cell && cell.roads.length, 'main.js boot: the start cell exists and has a way');
  assert.equal(SP.tilesReady(city, PRAHA.x, PRAHA.z), true);
  assert.equal(SP.tilesReady(city, PARDUBICE.x, PARDUBICE.z), false);
  for (const [x, z, what] of [[PRAHA.x, PRAHA.z, 'start'], [HOSPITALS[1].x, HOSPITALS[1].z, 'hospital']]) {
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      const c = city.chunkIndex.get((Math.floor(x / CHUNK) + dx) + ',' + (Math.floor(z / CHUNK) + dz));
      for (const b of c?.buildings ?? []) assert.ok(!b.o || !geo.pointInPolygon(x, z, b.o), what + ' inside ' + (b.n || b.t));
    }
  }
  // the hospital point is beside a street, not on it
  let kerb = Infinity;
  const [hx, hz] = [HOSPITALS[1].x, HOSPITALS[1].z];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c = city.chunkIndex.get((Math.floor(hx / CHUNK) + dx) + ',' + (Math.floor(hz / CHUNK) + dz));
    for (const r of c?.roads ?? []) {
      if (r.d !== 1) continue;
      for (let i = 0; i + 1 < r.p.length; i++) {
        const o = {};
        geo.distPointToSegment(hx, hz, r.p[i][0], r.p[i][1], r.p[i + 1][0], r.p[i + 1][1], o);
        kerb = Math.min(kerb, Math.hypot(o.x - hx, o.z - hz) - (r.w ?? 6) / 2);
      }
    }
  }
  assert.ok(kerb > 5 && kerb < 25, 'hospital point ' + kerb.toFixed(1) + ' m from the kerb');
  const spots = parkSpots(city, PRAHA);
  assert.ok(spots.length >= 2 && spots.length <= FLEET_STRIDE, spots.length + ' Prague fleet spots');
  assert.ok(Math.hypot(spots[0].x - PRAHA.x, spots[0].z - PRAHA.z) < 10, 'the first car a few steps away');
  assert.deepEqual(parkSpots(city, PRAHA), spots, 'a pure function of the map');
});
