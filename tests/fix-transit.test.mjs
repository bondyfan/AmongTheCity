// ---- fixes from the code review: buses, emergency vehicles, street light -------
// One test per defect the review confirmed in this corner of the game, each the
// smallest world in which the defect showed:
//   * a street lamp's pool on a bridge hung in the air past the parapets, and a
//     lamp under a viaduct lit the deck over its head
//   * a headlight fan took its pitch from the bare terrain, so over a valley it
//     dived under the deck
//   * the ambulance's red band ran across the open rear wheel arch
//   * ambulance and police drove through the cars parked along a kerb
//   * a bus the schedule had carried past a stop went on "standing" at it
//   * two regions each grew a bus line over the same stops, and the two buses
//     drove inside one another
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { LightPools, beamSlope } = await import('../js/lightpools.js');
const { Ambulance } = await import('../js/ambulance.js');
const { Police } = await import('../js/police.js');
const VEH = await import('../js/vehicles.js');
const { Traffic } = await import('../js/traffic.js');
const { Buses } = await import('../js/buses.js');
const { outranks, hopKey, SHARE_MIN } = await import('../js/buslines.js');
const { TRAFFIC } = await import('../js/config.js');
const { KERB_INTRUDES } = await import('../js/kerbparking.js');

// ---- street light on a bridge ----------------------------------------------------

// A road along x at z = 0. `deck` lifts it onto a bridge of that height over
// `ground`; `over` adds a second deck above the street (a viaduct crossing it).
// surfaceY answers the way city.js does: the highest surface not over the
// caller's head (near + 1.5), and "road" out to 0.35 m past the carriageway.
function roadWorld({ half = 4.5, ground = 211, deck = 220.2, over = null, grade = 0, slopeGround = 0 } = {}) {
  const surf = { y: 0, road: false };
  const g = (x) => ground + slopeGround * x;
  return {
    terrain: { heightAt: (x) => g(x) },
    surfaceY(x, z, near) {
      const on = Math.abs(z) <= half + 0.35;
      const own = (deck ?? g(x) + 0.2) + grade * x;
      let y = on ? own : g(x) + 0.05;
      surf.road = on;
      if (over !== null && Math.abs(x) <= 6 && !(over > near + 1.5)) { y = over; surf.road = true; }
      surf.y = y;
      return surf;
    },
  };
}
// one mast on the +z kerb, facing the road (rot 0: its local -z is the world's)
function mast(x, y, z) {
  return { x, y, z, i: 0, kind: 'street', posts: { userData: { spots: [x, z, 0] } } };
}
function poolOf(world, p) {
  const lp = new LightPools({ add() {} });
  lp._rebuild({ grid: new Map([['k', [p]]]) }, world, p.x, p.z);
  const m = new THREE.Matrix4();
  lp.pools.getMatrixAt(0, m);
  const at = (lx, lz) => new THREE.Vector3(lx, 0, lz).applyMatrix4(m);
  return { s: p._pool, at };
}

test('a lamp pool on a bridge ends at the edge of the deck', () => {
  const world = roadWorld();                          // 9 m deck, 9 m over the valley
  const { s, at } = poolOf(world, mast(50, 220.2, 4.25));
  const a = at(0, -1), b = at(0, 1);
  for (const v of [a, b]) assert.ok(Math.abs(v.z) <= 4.5 + 1e-6, `the quad reaches z = ${v.z.toFixed(2)}, past a deck that ends at 4.5`);
  assert.ok(Math.abs(a.z - b.z) > 7, `and it still covers the deck (${Math.abs(a.z - b.z).toFixed(1)} m of 9)`);
  assert.ok(s.y > 220.2 && s.y < 220.6, 'lying on the deck');
});

test('a lamp pool on an ordinary street keeps its full width', () => {
  const world = roadWorld({ ground: 220, deck: null });
  const { s, at } = poolOf(world, mast(50, 220, 5.2));
  assert.equal(s.pw, 13);
  assert.ok(Math.abs(at(0, -1).z - at(0, 1).z) > 25);
});

test('a lamp on the street under a viaduct lights the street, not the deck above it', () => {
  const world = roadWorld({ ground: 220, deck: null, over: 228 });
  const { s } = poolOf(world, mast(0, 220, 5.2));
  assert.ok(s.y < 221, `the pool lies at y = ${s.y.toFixed(2)}; the street is at 220.2 and the deck at 228`);
});

test('a headlight fan lies on the deck of a bridge, not on the valley under it', () => {
  // the valley falls away under a level deck: 9 m deep, 35 m either side of x = 60
  const world = roadWorld();
  world.terrain.heightAt = (x) => 220 - 9 * Math.max(0, 1 - Math.abs(x - 60) / 35);
  assert.equal(beamSlope(world, 30, 0, 1, 0, 220.2), 0, 'level deck, level fan');
  const lp = new LightPools({ add() {} });
  const car = { x: 30, z: 0, heading: Math.atan2(-1, 0), mesh: { position: { y: 220.2 } } };   // nose to +x
  assert.equal(lp._beam(0, car, 30, 0, world), 1);
  const m = new THREE.Matrix4();
  lp.beams.getMatrixAt(0, m);
  const far = new THREE.Vector3(0, 0, -1).applyMatrix4(m);    // local -z is the far end
  assert.ok(far.x > 60, 'the fan points along the nose');
  assert.ok(Math.abs(far.y - 220.2) < 0.4, `its far end is at y = ${far.y.toFixed(2)} over a deck at 220.2`);
});

test('the fan follows a ramp, and keeps level where the look ahead leaves the deck', () => {
  const ramp = roadWorld({ grade: 0.05 });
  assert.ok(Math.abs(beamSlope(ramp, 0, 0, 1, 0, 220.2) - 0.05) < 1e-9, 'a deck climbing one in twenty');
  // nose across the deck: 13 m ahead is air, and the valley floor is no guide
  assert.equal(beamSlope(roadWorld(), 30, 0, 0, 1, 220.2), 0);
  // on the ground the same look ahead falls back to the lie of the land
  const hill = roadWorld({ ground: 220, deck: null, slopeGround: 0.03 });
  const s = beamSlope(hill, 0, 0, 0, 1, 220.2);
  assert.equal(s, 0, 'across the slope: level');
  hill.surfaceY = () => ({ y: 0, road: false });
  assert.ok(Math.abs(beamSlope(hill, 0, 0, 1, 0, 220.2) - 0.03) < 1e-9, 'up the slope, beside the road: the terrain');
});

test('the fan eases to a new pitch, it does not jump there', () => {
  const world = roadWorld({ grade: 0 });
  const lp = new LightPools({ add() {} });
  const car = { x: 0, z: 0, heading: Math.atan2(-1, 0), mesh: { position: { y: 220.2 } } };
  const farY = () => { const m = new THREE.Matrix4(); lp.beams.getMatrixAt(0, m); return new THREE.Vector3(0, 0, -1).applyMatrix4(m).y; };
  lp._beam(0, car, 0, 0, world);
  const level = farY();
  // the road ahead tips up one in ten (the foot of a ramp)
  const ramp = roadWorld({ grade: 0.1 });
  ramp.surfaceY = ((f) => (x, z, n) => { const s = f(x, z, n); s.y = 220.2 + 0.1 * Math.max(0, x); return s; })(ramp.surfaceY);
  let prev = level, worst = 0;
  for (let i = 0; i < 60; i++) {
    lp._frame++;
    lp._beam(0, car, 0, 0, ramp);
    worst = Math.max(worst, Math.abs(farY() - prev));
    prev = farY();
  }
  assert.ok(prev - level > 3.5, `after a second the fan lies on the ramp (its far end rose ${(prev - level).toFixed(2)} m)`);
  assert.ok(worst < 1.2, `and no single frame moved its far end more than ${worst.toFixed(2)} m of those ${(prev - level).toFixed(2)}`);
});

// ---- the ambulance's band ----------------------------------------------------------

test('the ambulance band stays on the flank between the wheel arches', () => {
  let livery = null;
  Ambulance.prototype._fitLivery.call(null, { mesh: { add(g) { livery = g; } } });
  const band = livery.children[0].geometry;
  band.computeBoundingBox();
  const { min, max } = band.boundingBox;
  const van = VEH.bodySurface('van');
  for (let z = min.z; z <= max.z + 1e-9; z += 0.01) {
    assert.ok(van.archTop(z) <= min.y + 1e-6,
      `at z = ${z.toFixed(2)} the wheel arch is open up to y = ${van.archTop(z).toFixed(3)} and the band starts at ${min.y.toFixed(3)}`);
  }
  assert.ok(max.z - min.z >= 2.4, 'and it is still a band, not a patch');
});

// ---- emergency vehicles and the cars parked along a kerb ---------------------------

// one straight edge along +x on a 5.5 m street; right of travel is +z
function edge(offSign) {
  return { pts: [[0, 0], [30, 0], [60, 0]], cum: [0, 30, 60], len: 60, road: { w: 5.5, br: 0 }, off0: 0, offSign };
}
function placed(Cls, wid, offSign, kerbSide) {
  const self = { traffic: { kerbOf: () => kerbSide, kerbIntrudes: KERB_INTRUDES }, _roadY: () => 0, _write() {} };
  const u = { edge: edge(offSign), s: 30, seg: 0, heading: Math.atan2(-1, 0), laneOff: 0, car: { wid } };
  Cls.prototype._place.call(self, u, 10);              // dt 10: the easing lands at once
  return u;
}

for (const [name, Cls, wid] of [['an ambulance', Ambulance, 1.9], ['a patrol car', Police, 1.81]]) {
  test(`${name} keeps off the cars parked along its kerb`, () => {
    const parkedFrom = 5.5 / 2 - KERB_INTRUDES;        // where the parked hulls begin
    const u = placed(Cls, wid, 1, -1);                 // they stand at THIS direction's kerb
    assert.ok(u.z + wid / 2 <= parkedFrom - 0.3,
      `its flank runs at ${(u.z + wid / 2).toFixed(2)} m and the parked cars start at ${parkedFrom.toFixed(2)}`);
    assert.ok(u.z >= 0, 'without crossing the centreline');
    // the other direction, and a street nobody parks along, drive as before
    const usual = Math.min(TRAFFIC.laneOffsetK * 5.5, TRAFFIC.laneOffsetMax);
    assert.ok(Math.abs(placed(Cls, wid, -1, -1).z - usual) < 1e-9);
    assert.ok(Math.abs(placed(Cls, wid, 1, 0).z - usual) < 1e-9);
  });
}

// ---- buses ---------------------------------------------------------------------------

const T0 = 17_899_320;      // half past noon on the shared clock
const mesh = () => ({ position: { set() {} }, rotation: { y: 0 }, userData: {}, add() {} });
function vehicles() {
  return { scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading) {
      const car = { mesh: mesh(), wheels: [], x, z, heading, speed: 0, steer: 0, kind,
        len: kind === 'bus' ? 11 : 4.6, wid: kind === 'bus' ? 2.5 : 1.8, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car); return car;
    },
    remove(car) { this.cars.delete(car); } };
}
// tests/transit.test.mjs's town, to any length: a main street along x with a
// stop on each kerb every 300 m. It straddles z = 0 and x = 0, which are both
// region borders, so every stop lies in the box of four regions.
function town(half) {
  const roads = [];
  for (let x = -half; x < half; x += 200) roads.push({ t: 'primary', d: 1, w: 9, v: 50, p: [[x, 0], [x + 200, 0]] });
  for (let x = -half; x <= half; x += 200) roads.push({ t: 'residential', d: 1, w: 6, v: 50, p: [[x, -300], [x, 0], [x, 300]] });
  const pois = [];
  for (let x = -half + 150; x <= half - 150; x += 300) {
    pois.push({ t: 'bus_stop', p: [x, 6], n: 'E' + x });
    pois.push({ t: 'bus_stop', p: [x + 20, -6], n: 'W' + x });
  }
  return { roads, pois, signals: [], onTileLoaded() {} };
}
function world(half = 1800) {
  const city = town(half);
  const traffic = new Traffic(city, vehicles());
  const w = { city, traffic, now: T0 };
  traffic.clock = () => w.now;
  w.buses = new Buses(city, traffic);
  w.buses.clock = () => w.now;
  w.step = (dt, pos) => { w.now += dt; traffic.update(dt, pos, null); w.buses.update(dt, pos); };
  return w;
}
const REGIONS = [];
for (let rx = -3; rx <= 2; rx++) for (let rz = -1; rz <= 0; rz++) REGIONS.push([rx, rz]);
const running = (b) => b.lines.filter((l) => !l.shadow).map((l) => (l.id >>> 0) + ':' + l.stops.map((s) => s.n).join('>')).sort();
const shared = (a, b) => {
  const hops = new Set();
  for (let i = 0; i + 1 < a.stops.length; i++) hops.add(hopKey(a.stops[i], a.stops[i + 1]));
  let n = 0;
  for (let i = 0; i + 1 < b.stops.length; i++) if (hops.has(hopKey(b.stops[i], b.stops[i + 1]))) n++;
  return n;
};

test('two regions do not both run a line over the same kerbs', () => {
  const { buses } = world();
  for (const [rx, rz] of REGIONS) buses._derive(rx, rz);
  const all = buses.lines, run = all.filter((l) => !l.shadow);
  let dup = 0;
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) if (shared(all[a], all[b]) >= SHARE_MIN) dup++;
  assert.ok(dup >= 1, 'the fixture has no duplicated line: it tests nothing');
  for (let a = 0; a < run.length; a++) for (let b = a + 1; b < run.length; b++) {
    assert.ok(shared(run[a], run[b]) < SHARE_MIN,
      `two running lines share ${shared(run[a], run[b])} hops: ${run[a].stops.map((s) => s.n)} and ${run[b].stops.map((s) => s.n)}`);
  }
  // the one that gives way is the one the other outranks, and it is silent
  for (const l of all.filter((x) => x.shadow)) {
    assert.ok(all.some((o) => o !== l && outranks(o, l) && shared(o, l) >= SHARE_MIN));
    for (let i = 0; i < l.stops.length - 1; i++) {
      const s = l.stops[i];
      const others = all.some((o) => !o.shadow && o.stops.some((q, j) => q.id === s.id && j < o.stops.length - 1));
      if (!others) assert.equal(buses.eta(s.x, s.z, T0), Infinity, `a retired line still answers at ${s.n}`);
    }
  }
  assert.ok(run.length >= 3, `only ${run.length} lines left running`);
});

test('the lines that run are the same whatever order the regions were derived in', () => {
  const sigs = [];
  for (const order of [REGIONS, REGIONS.slice().reverse(), REGIONS.slice().sort((a, b) => (a[0] * 7 + a[1] * 3) % 5 - (b[0] * 7 + b[1] * 3) % 5)]) {
    const { buses } = world();
    for (const [rx, rz] of order) buses._derive(rx, rz);
    sigs.push(running(buses));
  }
  assert.deepEqual(sigs[1], sigs[0]);
  assert.deepEqual(sigs[2], sigs[0]);
});

test('whether a bus calls at a stop does not depend on what had been derived when it was asked', () => {
  const full = world();
  for (const [rx, rz] of REGIONS) full.buses._derive(rx, rz);
  let settled = 0;
  for (const poi of full.city.pois) {
    const [x, z] = poi.p;
    const fresh = world();                              // a client that has derived nothing yet
    const before = fresh.buses._regions.size;
    const a = fresh.buses.eta(x, z, T0), b = full.buses.eta(x, z, T0);
    assert.equal(a, b, `at ${poi.n} a client asking first is told ${a - T0}, one that had the whole town ${b - T0}`);
    // (the question derived a region that does not hold the stop itself:
    // the one whose line retires a line that calls here)
    const r0 = Math.floor((x - 800) / 1600), r1 = Math.floor((x + 800) / 1600);
    for (const k of fresh.buses._regions.keys()) { const rx = +k.split(',')[0]; if (rx < r0 || rx > r1) { settled++; break; } }
    assert.ok(fresh.buses._regions.size > before);
  }
  assert.ok(settled >= 1, 'no stop in the fixture needed a neighbouring region: it tests nothing');
});

test('a retired line puts no bus on the road', () => {
  const w = world();
  const pos = { x: -900, z: 40 };
  for (let i = 0; i < 400 * 4; i++) w.step(1 / 4, pos);   // more than one headway
  const dead = w.buses.lines.filter((l) => l.shadow);
  assert.ok(dead.length >= 1, 'nothing was retired near the player');
  let buses = 0;
  for (const p of w.traffic._pool.values()) {
    if (!p.fixed) continue;
    buses++;
    assert.ok(!p.fixed.tag.shadow, `a trip of retired line ${p.fixed.tag.id >>> 0} is running`);
  }
  assert.ok(buses >= 1, 'no bus at all');
});

test('a client that has just booted runs no trip the settled town does not', () => {
  // the regions arrive one per pass; a line a region still to come will retire
  // must not get its buses out first (they would run to the end of their trip,
  // a quarter of an hour, on this screen and no other)
  const cold = world(), warm = world();
  for (const [rx, rz] of REGIONS) warm.buses._derive(rx, rz);
  const pos = { x: -900, z: 40 };
  const trips = (w) => { const s = new Set(); for (const [k, p] of w.traffic._pool) if (p.fixed) s.add(k); return s; };
  let seen = 0;
  for (let i = 0; i < 40 * 4; i++) {
    cold.step(1 / 4, pos); warm.step(1 / 4, pos);
    const a = trips(cold), b = trips(warm);
    for (const k of a) assert.ok(b.has(k), `${k} is on the road ${(i / 4).toFixed(1)} s after boot and is not part of the settled timetable`);
    seen = Math.max(seen, a.size);
  }
  assert.ok(seen >= 1, 'the booted client never ran a bus at all');
  assert.deepEqual([...trips(cold)].sort(), [...trips(warm)].sort(), 'and in the end it runs every trip of it');
});

test('a bus the schedule has carried past a stop does not stand at it from down the road', () => {
  const w = world(1200);
  w.traffic.maxCars = 0;                                // the buses alone
  const pos = { x: 0, z: 60 };
  let bus = null;
  for (let i = 0; i < 600 * 20 && !bus; i++) {
    w.step(1 / 20, pos);
    for (const c of w.traffic.cars) {
      const p = c.ai;
      if (!p?.stops || p.ghost || p.stand < 1 || p.stand >= p.stops.length - 1) continue;
      const d = p.stops[p.stand].arc - p.sR;
      if (d > 40 && d < 70 && c.speed > 5) bus = c;
    }
  }
  assert.ok(bus, 'no bus came down the street in ten minutes');
  const p = bus.ai, missed = p.stand;
  // this client hitches for half a minute and the shared clock runs on: the
  // schedule calls at the stop and leaves, and the car is put back on it
  w.now += 30;
  w.step(1 / 20, pos);
  assert.ok(p.stops[missed].arc - p.sR < -20, 'the bus was not carried past its stop: the fixture tests nothing');
  let stood = 0;
  for (let i = 0; i < 40 * 20 && bus.ai === p && !p.ghost; i++) {
    w.step(1 / 20, pos);
    const at = w.traffic.standingAt(p, w.now);
    if (!at) continue;
    stood++;
    assert.ok(Math.abs(at.stop.arc - p.sR) < 3,
      `doors open "at" a stop ${Math.abs(at.stop.arc - p.sR).toFixed(0)} m away`);
  }
  assert.ok(p.stand > missed, 'the stop it missed was given up');
  assert.ok(stood > 0, 'and it stood at the next one, in person');
});
