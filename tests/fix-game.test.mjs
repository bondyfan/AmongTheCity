// The gameplay layer's seams, each of which was a confirmed defect:
//   a bought car that stands in a stall is nobody's but yours (car park AND kerb),
//   and comes back from a reload without a twin on the same spot;
//   a tile that streams in brings its POIs (fuel pumps on the map);
//   a dry tank still has a foot brake;
//   the wanted level and the hospital bill survive closing the tab.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

// ---- a browser thin enough for js/career.js --------------------------------
// localStorage as a Map, and a DOM that swallows whatever the panels and the
// toasts build into it (text set on any node is kept, so a toast can be read).
// Set up BEFORE the imports: career.js opens its store when it is loaded.
const disk = new Map();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k) => (disk.has(k) ? disk.get(k) : null),
  setItem: (k, v) => { disk.set(k, String(v)); },
  removeItem: (k) => { disk.delete(k); },
} });
const said = [];
const dom = new Proxy(function () {}, {
  get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === Symbol.iterator ? function* () {} : k === 'length' ? 0 : dom),
  set: (t, k, v) => { if ((k === 'textContent' || k === 'innerHTML') && typeof v === 'string') said.push(v); return true; },
  apply: () => dom, construct: () => dom,
});
globalThis.document = dom;
globalThis.window = dom;

// js/toasts.js shows four cards at a time off one 250 ms timer and drops a
// message that is already up, so what a session SAID is only readable once the
// stack has been run dry. From the first test that raises a toast on, time is
// the test's: setTimeout and performance.now are stepped by hand. (The tile
// test above those needs the real timer, and runs before them.)
let clock = 0, faked = false;
function fakeTimers() {
  if (faked) return;
  faked = true;
  mock.timers.enable({ apis: ['setTimeout'] });
  Object.defineProperty(globalThis.performance, 'now', { configurable: true, value: () => clock });
}
/** Show every queued toast and let it expire: afterwards `said` holds them all. */
function flushToasts() {
  for (let i = 0; i < 6; i++) { clock += 60000; mock.timers.tick(400); }
}

const { indexJunctions, polylineLength, setStreetCity, JUNCTIONS, CLUSTERS, loadCity } = await import('../js/geo.js');
const { indexBays } = await import('../js/streets.js');
const { KerbParking } = await import('../js/kerbparking.js');
const { ParkingLots, standsIn } = await import('../js/parkinglots.js');
const { Garage } = await import('../js/garage.js');
const { driveStep } = await import('../js/vehicles.js');
const { SAVE_KEY } = await import('../js/savegame.js');
const { PRICE } = await import('../js/prices.js');
const wallet = await import('../js/wallet.js');
const vitals = await import('../js/vitals.js');
const wanted = await import('../js/wanted.js');
const fuel = await import('../js/fuel.js');
const career = await import('../js/career.js');

// ---- a street with a kerb to park at, and a car park ------------------------
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
function town() {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const tag = (f) => { f._id = ++id; return f; };
  const main = tag({ t: 'residential', w: 5.5, d: 1, p: [[5, 60], [120, 60], [235, 60]] });
  main._len = polylineLength(main.p);
  const mk = () => ({ buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [], venues: [] });
  const chunkIndex = new Map();
  const cell = (x, z) => {
    const k = Math.floor(x / 120) + ',' + Math.floor(z / 120);
    if (!chunkIndex.has(k)) chunkIndex.set(k, mk());
    return chunkIndex.get(k);
  };
  for (let x = 6; x < 232; x += 18) {
    for (const z of [38, 73]) { const b = tag({ o: square(x, z, 9), h: 9, t: 'house' }); cell(b.o[0][0], b.o[0][1]).buildings.push(b); }
  }
  cell(10, 60).roads.push(main); cell(130, 60).roads.push(main);
  const lot = { t: 'parking', o: [[300, 0], [340, 0], [340, 30], [300, 30]] };
  // filed in its cell as geo.js files every polygon: since round 7 the car
  // parks are found through the chunk index around the player (parkinglots.js
  // lotsNear), not by scanning every lot the session ever loaded
  cell(300, 0).paved.push(lot);
  const city = { chunkIndex, tile: 4800, pois: [], waterways: [], signals: [], paved: [lot] };
  indexJunctions([main]); indexBays(city, []); setStreetCity(city);
  return city;
}
// vehicles.js's own add() needs a canvas: a fleet that keeps the same books
// (and the same aliases: the car parks still ask for a 'sedan')
const ALIAS = { sedan: 'octavia', hatch: 'fabia', kombi: 'octavia', suv: 'bmw' };
function fleet() {
  return { cars: new Set(), removed: new Set(),
    add(kind, x, z, heading, color) { const c = { kind: ALIAS[kind] ?? kind, x, z, heading, color, speed: 0, y: 0 }; this.cars.add(c); return c; },
    remove(c) { this.removed.add(c); this.cars.delete(c); } };
}
function parkingWorld() {
  const city = town(), vehicles = fleet(), parked = [];
  const lots = new ParkingLots(city, vehicles, null, parked);
  const kerb = new KerbParking(city, vehicles, null, parked);
  const garage = new Garage({ game: { car: null }, parked, parkedFleet: [], vehicles, world: { city }, parkingLots: lots });
  const sweep = (pos) => { lots.update(10, pos, 0); kerb.update(10, pos, 0); };   // t01 = 0: midnight, full
  return { city, vehicles, parked, lots, kerb, garage, sweep };
}
const HERE = { lot: { x: 320, z: 15 }, kerb: { x: 120, z: 60 } };
const mine = (which) => (c) => (which === 'lot' ? c._lot : c._kerb);
// every OTHER parked car standing in the space the owned one takes up
const onTopOf = (w) => w.parked.filter((c) => c !== w.garage.car && standsIn(c.x, c.z, w.garage.car.x, w.garage.car.z, w.garage.car.heading));

test('the space a parked car takes is the car, not its neighbours', () => {
  assert.ok(standsIn(10, 20, 10, 20, 0.3));
  // heading 0 faces -z: the next stall in a row is 2.75 m to the side, the next
  // row 6 m ahead, the next kerb stall 6.3 m ahead
  assert.ok(!standsIn(12.75, 20, 10, 20, 0), 'the stall beside it');
  assert.ok(!standsIn(10, 26, 10, 20, 0), 'the row in front');
  assert.ok(!standsIn(10, 13.7, 10, 20, 0), 'the next car along the kerb');
  assert.ok(standsIn(10, 23.15, 10, 20, 0), 'parked half way between two kerb stalls is in both');
  // turned a quarter: along and across swap
  assert.ok(standsIn(13, 20, 10, 20, Math.PI / 2));
  assert.ok(!standsIn(10, 23, 10, 20, Math.PI / 2));
  // a car left ACROSS the row has its nose in the stall beside it, which its
  // centre alone does not say: with both headings known that stall is taken too
  assert.ok(standsIn(12.75, 20, 10, 20, 0, Math.PI / 2), 'crosswise over the next stall');
  assert.ok(!standsIn(16, 20, 10, 20, 0, Math.PI / 2), 'two stalls away is clear even crosswise');
  assert.equal(standsIn(12.75, 20, 10, 20, 0, 0), standsIn(12.75, 20, 10, 20, 0), 'the same heading is the plain box');
});

for (const which of ['lot', 'kerb']) {
  const name = which === 'lot' ? 'car park' : 'kerb stall';

  test(`a car bought in a ${name} is not tidied away when you walk off`, () => {
    const w = parkingWorld();
    const here = HERE[which];
    w.sweep(here);
    const pool = w.parked.filter(mine(which));
    assert.ok(pool.length >= 8, `only ${pool.length} cars to choose from`);
    const car = pool[0];
    wallet.setMoney(5e7);
    assert.equal(w.garage.buy(w.garage.carAt(car.x, car.z)), true);
    assert.equal(w.garage.car, car);
    // a kilometre away on foot and back, one sweep every 50 m
    for (let d = 0; d <= 1000; d += 50) w.sweep({ x: here.x, z: here.z + d });
    for (let d = 1000; d >= 0; d -= 50) w.sweep({ x: here.x, z: here.z + d });
    assert.ok(!w.vehicles.removed.has(car), 'the parking streamer deleted a car that was paid for');
    assert.ok(w.parked.includes(car) && w.vehicles.cars.has(car));
    assert.deepEqual(onTopOf(w), [], 'its stall grew another car on top of it');
    // and the rest of the street is parked up again: one stall was given up, not the lot
    const others = w.parked.filter((c) => c !== car && mine(which)(c)).length;
    assert.ok(others >= pool.length - 3 && others < pool.length, `${others} of ${pool.length} stall cars came back`);
    // the working day thins the street out and the evening fills it, seen from 200 m
    for (const t of [0.4, 0.55, 0.9, 0]) { const p = { x: here.x, z: here.z + 200 }; w.lots.update(10, p, t); w.kerb.update(10, p, t); }
    assert.ok(!w.vehicles.removed.has(car) && w.parked.includes(car));
    assert.deepEqual(onTopOf(w), []);
    // sold in part exchange, it is an ordinary parked car again and still nobody removes it
    const other = w.parked.filter(mine(which)).find((c) => c !== car);
    assert.equal(w.garage.buy(other), true);
    assert.equal(car.owned, false);
    for (let d = 0; d <= 1000; d += 50) w.sweep({ x: here.x, z: here.z + d });
    assert.ok(!w.vehicles.removed.has(car) && !w.vehicles.removed.has(other));
  });

  // main.js steps the parking streamers before career.update, so on the first
  // frame of a continued game the stalls are full BEFORE the save is applied;
  // the other order is kept honest too.
  for (const stallsFirst of [true, false]) {
    test(`reloading with the car still in its ${name} leaves one car there (${stallsFirst ? 'stalls fill first' : 'save applied first'})`, () => {
      const a = parkingWorld();
      const here = HERE[which];
      a.sweep(here);
      const pool = a.parked.filter(mine(which));
      const car = pool[Math.min(3, pool.length - 1)];
      wallet.setMoney(5e7);
      assert.equal(a.garage.buy(car), true);
      const snap = JSON.parse(JSON.stringify(a.garage.snapshot()));

      const b = parkingWorld();                       // the reload: everything built again
      if (stallsFirst) b.sweep(here);
      b.garage.restore(snap, true);
      b.sweep(here);
      b.sweep({ x: here.x, z: here.z + 200 });        // out of sight but in reach, where stalls may refill
      b.sweep(here);
      const own = b.garage.car;
      assert.ok(own && own.owned && b.parked.includes(own));
      assert.ok(Math.hypot(own.x - car.x, own.z - car.z) < 0.01);
      assert.deepEqual(onTopOf(b).map((c) => c.kind), [], 'a twin stands on the saved car');
      assert.ok(!b.vehicles.removed.has(own));
      const others = b.parked.filter((c) => c !== own && mine(which)(c)).length;
      assert.ok(others >= pool.length - 3 && others < pool.length, `${others} of ${pool.length} stall cars round it`);
    });
  }
}

test('a tile that streams in hands its POIs to the listeners', async () => {
  const T = 4800;
  const files = {
    'm.json': { name: 'x', origin: [0, 0], mPerLat: 1, mPerLon: 1, tile: T,
      tiles: [{ tx: 0, tz: 0, f: 't0.json' }, { tx: 3, tz: 0, f: 't1.json' }] },
    't0.json': { roads: [], pois: [{ t: 'fuel', p: [100, 100], n: 'boot pump' }] },
    't1.json': { roads: [], pois: [{ t: 'fuel', p: [3 * T + 100, 100], n: 'streamed pump' }, { t: 'police', p: [3 * T + 300, 100] }] },
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => ({ ok: true, json: async () => JSON.parse(JSON.stringify(files[u])) });
  try {
    const city = await loadCity('m.json');
    await city.ensureTiles(100, 100);
    const got = [];
    city.onTileLoaded((t) => got.push(t.pois));
    await city.ensureTiles(3 * T + 100, 100);
    assert.equal(got.length, 1);
    assert.deepEqual(got[0].map((p) => p.t), ['fuel', 'police']);
    assert.equal(city.pois.filter((p) => p.t === 'fuel').length, 2);
  } finally { globalThis.fetch = realFetch; }
});

test('a dry tank still has its foot brake, and no drive either way', () => {
  fakeTimers();                                       // "Došlo palivo" is a toast
  const FLAT = { collide: () => false, surfaceY: () => ({ y: 0, road: true }) };
  const mk = (dry, v) => {
    const car = { x: 0, z: 0, y: 0, heading: 0, speed: v, steer: 0, len: 4.2, wid: 1.8, kind: 'octavia' };
    fuel.levelOf(car);                                // seeds the tank
    if (dry) car._fuel = 0;
    return car;
  };
  const run = (car, pedal, s) => {
    for (let t = 0; t < s; t += 1 / 60) driveStep(car, { gas: career.throttle(car, pedal), steer: 0, brake: 0 }, 1 / 60, FLAT, []);
    return Math.hypot(car.x, car.z);
  };
  for (const kmh of [30, 50, 120]) {
    const full = run(mk(false, kmh / 3.6), -1, 1.0 + kmh / 30);     // heading 0 drives toward -z
    const dry = mk(true, kmh / 3.6);
    assert.ok(fuel.dry(dry));
    const d = run(dry, -1, 1.0 + kmh / 30);
    const coast = run(mk(true, kmh / 3.6), 0, 1.0 + kmh / 30);
    assert.ok(d < coast * 0.75, `S did nothing at ${kmh} km/h: ${d.toFixed(1)} m against ${coast.toFixed(1)} m coasting`);
    // S is held until the car stops and for seconds after: the brake, never reverse
    const at = { x: dry.x, z: dry.z };
    run(dry, -1, 12);
    assert.ok(Math.abs(dry.speed) < 0.2, `a dry car is moving at ${dry.speed} m/s under S`);
    assert.ok(dry.z <= at.z + 0.3, 'a dry car backed up on S');
    void full;
  }
  // from rest neither pedal moves it
  for (const pedal of [1, -1]) assert.ok(run(mk(true, 0), pedal, 3) < 0.05, 'a dry car drove off');
  // rolling backwards, W is the brake
  const back = mk(true, -6);
  const free = run(mk(true, -6), 0, 2);
  assert.ok(run(back, 1, 2) < free * 0.75);
  // and a car with fuel in it is not touched at all
  const ok = mk(false, 5);
  assert.equal(career.throttle(ok, 1), 1);
  assert.equal(career.throttle(ok, -1), -1);
  assert.equal(career.throttle(null, 0.5), 0.5);
});

// ---- the save across a reload: wanted, and dying on the way out --------------
const host = (px = 10, pz = 20) => ({ game: { mode: 'play', car: null }, input: { onKey() {} }, parked: [], parkedFleet: [],
  player: { pos: { x: px, z: pz }, heading: 0, grounded: true }, world: { city: { pois: [], paved: [] } },
  vehicles: { add: (kind, x, z, heading, color) => ({ kind, x, z, heading, color }), remove() {} } });
const onDisk = () => JSON.parse(disk.get(SAVE_KEY));
let loads = 0;
// A page load: the wallet, the body and the wanted level start over, and a
// fresh copy of career.js reads the save. (The copies from earlier "sessions"
// stay subscribed to vitals, as nothing unsubscribes in a real page either;
// they were attached first, so the live copy's save is the one left on disk.)
async function reload() {
  fakeTimers();
  wanted.clear(); vitals.reset(); wallet.setMoney(wallet.START);
  const c = await import('../js/career.js?load=' + (++loads));
  c.choose({ mode: 'single' });
  const h = host();
  await c.spawn(h.player, {});
  c.attach(h);
  flushToasts();                 // whatever the session before was still saying
  said.length = 0;
  c.update(1 / 60);              // the first step applies the save
  flushToasts();
  return { c, h };
}

test('the wanted level and the hospital bill outlive the tab', async () => {
  disk.clear();
  let { c, h } = await reload();
  wallet.setMoney(5000);
  for (let i = 0; i < 4; i++) { wanted.update(1, {}); wanted.add('zabiti'); }
  const stars = wanted.stars(), heat = wanted.heat();
  assert.ok(stars >= 3, 'the test did not get itself wanted');
  c.update(1 / 60);
  assert.equal(c.save(), true);
  assert.ok(Math.abs(onDisk().wanted.heat - heat) < 0.1);
  assert.equal(onDisk().owed, null);

  // F5 with the stars up: still wanted, nothing paid, same wallet
  ({ c, h } = await reload());
  assert.equal(wanted.stars(), stars, 'a reload wiped the wanted level');
  assert.equal(wanted.lastCrime(), 'zabití');
  assert.equal(wallet.money(), 5000);
  assert.ok(said.some((t) => t.includes('Vítej zpět')));

  // sejmut, and the tab is closed on the death card (before main.js's 4 s are up)
  h.player.pos.x = 900; h.player.pos.z = -400;
  c.update(1 / 60);
  vitals.damage(9999, 'test');
  assert.equal(vitals.down(), true);
  assert.equal(c.save(), false, 'still no ordinary save while down');
  const s = onDisk();
  assert.deepEqual(s.owed, { stars });
  assert.equal(s.money, 5000, 'the bill is charged on load, through the wallet, not baked into the number');
  assert.deepEqual([s.pos.x, s.pos.z], [2291, 295], 'you wake at the hospital, not where you fell');
  assert.equal(s.jobs.active, null);
  assert.equal(s.wanted.heat, 0);

  ({ c, h } = await reload());
  const bill = PRICE.hospital.fee + stars * PRICE.fine.perStar;
  assert.equal(wallet.money(), 5000 - bill, 'closing the tab on the death card dodged the bill');
  assert.equal(vitals.down(), false, 'reloaded onto the death card');
  assert.equal(vitals.hp(), vitals.hpMax());
  assert.equal(wanted.stars(), 0);
  assert.deepEqual([h.player.pos.x, h.player.pos.z], [2291, 295]);
  assert.ok(said.some((t) => t.includes('Probouzíš se v nemocnici')), 'nothing told the player where the money went');
  assert.ok(!said.some((t) => t.includes('Vítej zpět')));
  // the settled game replaces the open bill within a second, so it is paid once
  for (let i = 0; i < 60; i++) c.update(1 / 60);
  assert.equal(onDisk().owed, null);
  assert.equal(onDisk().money, 5000 - bill);
  ({ c, h } = await reload());
  assert.equal(wallet.money(), 5000 - bill, 'the bill was charged twice');

  // broke: the bed is all-or-nothing (as in main.js), the fine takes what there is
  wallet.setMoney(PRICE.hospital.fee + 150);
  for (let i = 0; i < 4; i++) { wanted.update(1, {}); wanted.add('zabiti'); }
  c.update(1 / 60);
  vitals.damage(9999, 'test');
  ({ c, h } = await reload());
  assert.equal(wallet.money(), 0);
  assert.equal(wanted.stars(), 0);
});

test('a browser that keeps nothing is said out loud, once', async () => {
  disk.clear();
  const ls = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('SecurityError'); } });
  try {
    const { c } = await reload();
    assert.equal(said.filter((t) => t.includes('Hra se neukládá')).length, 1, 'the player was never told nothing is saved');
    assert.ok(said.some((t) => t.includes('Prohlížeč nepovolil úložiště. Postup po zavření zmizí.')));
    assert.ok(!said.join(' ').includes(String.fromCharCode(0x2014)), 'an em dash in UI text');
    assert.equal(c.save(), false);
    said.length = 0;
    for (let i = 0; i < 25 * 60; i++) c.update(1 / 60);          // an autosave comes due and fails
    flushToasts();
    assert.equal(said.filter((t) => t.includes('Hra se neukládá')).length, 0, 'said twice');
  } finally { Object.defineProperty(globalThis, 'localStorage', ls); }
  // and with working storage nothing of the kind is said
  await reload();
  assert.ok(!said.some((t) => t.includes('Hra se neukládá')));
});
