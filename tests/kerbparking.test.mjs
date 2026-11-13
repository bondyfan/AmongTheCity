// ---- cars at the kerb, and nothing live on a map feature -----------------------
// js/kerbparking.js parks cars along residential kerbs where js/streets.js says
// a kerb is: never in a junction mouth, on a zebra, at a bus lay-by or on a
// dropped kerb. And neither it nor js/parkinglots.js may hang its cars on the
// features themselves: js/chunkspec.js copies every feature of a cell to the
// mesh workers and refuses a cell holding a class instance, which is how every
// cell with a live car park used to end up building on the main thread.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { indexJunctions, polylineLength, setStreetCity, JUNCTIONS, CLUSTERS } = await import('../js/geo.js');
const { inZone, indexBays, KERB_H } = await import('../js/streets.js');
const { kerbStalls, kerbSideOf, parkable, KerbParking, inKerbStall } = await import('../js/kerbparking.js');
const { ParkingLots } = await import('../js/parkinglots.js');

const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];

/** A 230 m residential street with houses both sides, a side street, a zebra and a bus stop. */
function town() {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const tag = (f) => { f._id = ++id; return f; };
  const main = tag({ t: 'residential', w: 5.5, d: 1, p: [[5, 60], [120, 60], [235, 60]] });
  const side = tag({ t: 'residential', w: 5.5, d: 1, p: [[120, 60], [120, 118]] });
  const roads = [main, side];
  for (const r of roads) r._len = polylineLength(r.p);
  const buildings = [];
  for (let x = 6; x < 232; x += 18) {
    buildings.push(tag({ o: square(x, 38, 9), h: 9, t: 'house' }));
    buildings.push(tag({ o: square(x, 73, 9), h: 9, t: 'house' }));
  }
  const crossings = [tag({ p: [[60, 60]] })];
  const mk = () => ({ buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [], venues: [] });
  const chunkIndex = new Map();
  const cell = (x, z) => {
    const k = Math.floor(x / 120) + ',' + Math.floor(z / 120);
    if (!chunkIndex.has(k)) chunkIndex.set(k, mk());
    return chunkIndex.get(k);
  };
  for (const b of buildings) cell(b.o[0][0], b.o[0][1]).buildings.push(b);
  for (const k of ['0,0', '1,0']) { cell(k === '0,0' ? 10 : 130, 60).roads.push(main); }
  cell(130, 60).roads.push(side);
  cell(60, 60).crossings.push(crossings[0]);
  const pois = [{ t: 'bus_stop', p: [190, 60 + 4.5] }];
  const city = { chunkIndex, tile: 4800, pois, waterways: [], signals: [], paved: [] };
  indexJunctions(roads);
  indexBays(city, pois);
  setStreetCity(city);
  return { city, main, side };
}

test('stalls stand at the kerb, clear of the junction, the zebra and the bus bay', () => {
  const { city, main } = town();
  assert.ok(parkable(main));
  const keys = Object.keys(main).sort();
  const stalls = kerbStalls(city, main);
  assert.ok(stalls.length >= 8, `only ${stalls.length} stalls on 230 m of kerb`);
  const e = kerbSideOf(main);
  for (const st of stalls) {
    // 5 cm inside the kerb line, on the chosen side (the street runs along +x at z = 60)
    assert.ok(Math.abs(Math.abs(st.z - 60) - (2.75 - 0.05)) < 0.02, `stall at z = ${st.z}`);
    assert.equal(Math.sign(st.z - 60), e > 0 ? -1 : 1, 'all on one side of the street');
    for (const k of [-10, 0, 10]) assert.ok(!inZone(main, st.s + k), `stall at s = ${st.s.toFixed(0)} is in a junction mouth`);
    assert.ok(Math.abs(st.x - 60) >= 7, 'parked on the zebra');
    assert.ok(Math.abs(st.s - 185) >= 21, 'parked in the bus lay-by');
    // nose along the street, the way traffic on that side runs
    const fx = -Math.sin(st.h);
    assert.ok(Math.abs(Math.abs(fx) - 1) < 0.01, 'parallel to the kerb');
    assert.equal(Math.sign(fx), e < 0 ? 1 : -1, 'facing the direction of travel on its side');
    assert.ok(st.roll > 0, 'kerb on its right: the right flank is the one on the pavement');
    assert.ok(Math.abs(Math.tan(st.roll) * 1.55 - KERB_H) < 1e-6);
  }
  for (let i = 1; i < stalls.length; i++) assert.ok(stalls[i].s - stalls[i - 1].s >= 6.2, 'room to open a boot');
  // deterministic, and nothing was hung on the way to make it so
  assert.deepEqual(kerbStalls(city, main).map((s) => [s.x, s.z, s.h]), stalls.map((s) => [s.x, s.z, s.h]));
  assert.deepEqual(Object.keys(main).filter((k) => !keys.includes(k)).filter((k) => k !== '_vg' && k !== '_sbb'), [],
    'kerbStalls left something on the road feature');
});

const plain = (v, where, seen = new Set()) => {
  if (v === null || typeof v !== 'object' || seen.has(v)) return;
  seen.add(v);
  if (ArrayBuffer.isView(v)) return;
  const proto = Object.getPrototypeOf(v);
  assert.ok(proto === Object.prototype || proto === Array.prototype || proto === null,
    `${where} is a ${v.constructor?.name}: chunkspec would refuse this cell`);
  for (const k of Object.keys(v)) plain(v[k], where + '.' + k, seen);
};
class Group { constructor() { this.position = { set() {} }; } }   // stands in for THREE.Group
function vehicles() {
  return { cars: new Set(),
    add(kind, x, z, heading) { const car = { mesh: new Group(), x, z, y: 221, heading, kind, len: 4.6, wid: 1.8 }; this.cars.add(car); return car; },
    remove(car) { this.cars.delete(car); } };
}

test('kerb cars breathe with the clock, are ordinary parked cars, and leave the map features clean', () => {
  const { city, main } = town();
  const parked = [], veh = vehicles();
  const kp = new KerbParking(city, veh, { terrain: { ready: () => true } }, parked);
  kp.update(10, { x: 400, z: 60 }, 0.0);          // midnight, player down the road: the boot fill
  const night = parked.length;
  assert.ok(night >= 4, `only ${night} cars at the kerb at midnight`);
  assert.equal(kp.sideOf(main), kerbSideOf(main), 'the traffic is told which kerb they stand at');
  for (const car of parked) {
    assert.ok(inKerbStall(car));
    assert.ok(Math.abs(car.y - (221 + KERB_H / 2)) < 1e-9, 'half a kerb up');
    assert.ok(Math.abs(car._gr) > 0.05, 'leaning on it');
  }
  plain(main, 'road');
  for (const cell of city.chunkIndex.values()) for (const r of cell.roads) plain(r, 'road');
  // early afternoon: most have driven to work (the player is far, so they may leave)
  kp.update(10, { x: 400, z: 60 }, 13 / 24);
  assert.ok(parked.length < night, `${parked.length} cars at 13:00 against ${night} at midnight`);
  // a car somebody drove off is no longer "in its stall", and its stall stays empty
  kp.update(10, { x: 400, z: 60 }, 0.0);
  const taken = parked[0];
  parked.splice(0, 1);
  taken.x += 30;
  assert.ok(!inKerbStall(taken));
  const before = parked.length;
  kp.update(10, { x: 400, z: 60 }, 0.0);
  assert.equal(parked.length, before, 'the stall was refilled behind the thief');
});

test('a car park keeps its cars beside the map feature, not on it', () => {
  const lot = { t: 'parking', o: [[0, 0], [40, 0], [40, 30], [0, 30]] };
  const keys = Object.keys(lot);
  const city = { paved: [lot] };
  const parked = [];
  const lots = new ParkingLots(city, vehicles(), null, parked);
  lots.update(10, { x: 20, z: 15 }, 0.0);
  assert.ok(parked.length > 5, 'the lot is empty at midnight');
  assert.deepEqual(Object.keys(lot), keys, 'ParkingLots hung something on the paved polygon');
  plain(lot, 'paved');
});
