// ---- buses: lines derived from stops, trips that are traffic ------------------
// The tiles have stops and no routes, so js/buslines.js derives the lines and
// js/buses.js runs trips along them as ordinary traffic schedules. What has to
// hold: a line is a drivable route that passes each of its stops on the kerb
// side, the same lines come out whatever order the data arrived in, a trip's
// timetable is a pure function of the shared clock, and the cars give way to
// the people (and do not get hauled through them by the schedule).
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Traffic } = await import('../js/traffic.js');
const { Buses } = await import('../js/buses.js');
const { snapStop, roadCost } = await import('../js/buslines.js');

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
// A main street 2.4 km long with side streets every 200 m, and a stop on each
// kerb every 300 m: the eastbound ones on the south side (z > 0 is the right
// of somebody driving +x, since right of (dx, dz) is (-dz, dx)).
function town(order = 1) {
  const roads = [];
  for (let x = -1200; x < 1200; x += 200) roads.push({ t: 'primary', d: 1, w: 9, v: 50, p: [[x, 0], [x + 200, 0]] });
  for (let x = -1200; x <= 1200; x += 200) roads.push({ t: 'residential', d: 1, w: 6, v: 50, p: [[x, -300], [x, 0], [x, 300]] });
  const pois = [];
  for (let x = -1050; x <= 1050; x += 300) {
    pois.push({ t: 'bus_stop', p: [x, 6], n: 'E' + x });
    pois.push({ t: 'bus_stop', p: [x + 20, -6], n: 'W' + x });
  }
  if (order < 0) { roads.reverse(); pois.reverse(); }
  return { roads, pois, signals: [], onTileLoaded() {} };
}
function world(order = 1) {
  const city = town(order);
  const traffic = new Traffic(city, vehicles());
  let now = T0;
  traffic.clock = () => now;
  const buses = new Buses(city, traffic);
  buses.clock = () => now;
  for (let rx = -2; rx <= 1; rx++) for (let rz = -1; rz <= 0; rz++) buses._derive(rx, rz);
  return { city, traffic, buses, at: (t) => { now = t; }, now: () => now };
}
const sig = (b) => b.lines.map((l) => l.id + ':' + l.stops.map((s) => s.n).join('>')).sort();

test('lines come out of stops and roads, each stop on the kerb side of the bus that serves it', () => {
  const { buses } = world();
  assert.ok(buses.lines.length >= 2, `only ${buses.lines.length} lines`);
  for (const l of buses.lines) {
    assert.ok(l.stops.length >= 4 && l.len >= 900, 'a line worth running');
    const side = l.stops[0].n[0];
    assert.ok(l.stops.every((s) => s.n[0] === side), `a line that changes kerb: ${l.stops.map((s) => s.n)}`);
    const xs = l.stops.map((s) => s.x);
    const east = xs[1] > xs[0];
    assert.equal(east, side === 'E', 'eastbound buses call at the south kerb, which is on their right');
    for (let i = 1; i < xs.length; i++) assert.equal(xs[i] > xs[i - 1], east, 'and do not double back');
    for (let i = 1; i < l.route.length; i++) {
      assert.equal(l.route[i - 1].e.b, l.route[i].e.a, 'the route is one continuous drive');
      assert.ok(Math.abs(l.route[i].base - (l.route[i - 1].base + l.route[i - 1].e.len)) < 1e-6);
    }
    for (let i = 1; i < l.stops.length; i++) assert.ok(l.stops[i].arc > l.stops[i - 1].arc + 19);
  }
});

test('the same lines whatever order the roads and stops arrived in', () => {
  assert.deepEqual(sig(world(1).buses), sig(world(-1).buses));
});

test('a stop is snapped to the direction of travel that has it on the right', () => {
  const { traffic } = world();
  const hit = snapStop(150, 6, traffic.edges);
  assert.ok(hit && hit.e.fdx > 0.9, 'a stop on the south kerb is served by the eastbound edge');
  const back = snapStop(150, -6, traffic.edges);
  assert.ok(back && back.e.fdx < -0.9, 'and one on the north kerb by the westbound');
  assert.ok(roadCost({ t: 'primary' }) < roadCost({ t: 'residential' }), 'main roads first');
  assert.ok(roadCost({ t: 'primary', tw: 1 }) < roadCost({ t: 'primary' }), 'trolley wire first of all');
});

test('a trip is a schedule: due times are pure, in order, and it stands at its stops', () => {
  const { buses, traffic } = world();
  // (a line that RUNS: the first one derived here is the short westbound line
  // of region -1,-1, which shares two hops with the longer one of region 0,-1
  // and is retired now, so it answers no eta; see tests/fix-transit.test.mjs)
  const line = buses.lines.find((l) => !l.shadow);
  const k = Math.floor(T0 / 240 - line.phase) + 2;
  const a = [...buses._tripTimes(line, k)], b = [...traffic.fixedTimes(buses._spec(line, k))];
  assert.deepEqual(a, b, 'the timetable is a function of the trip, not of when it was asked');
  const t0 = buses.depart(line, k);
  for (let i = 0; i < a.length; i++) {
    assert.ok(Number.isFinite(a[i]) && a[i] > t0, `stop ${i} is never reached`);
    if (i) assert.ok(a[i] > a[i - 1] + 9, 'a dwell and a drive between two stops');
  }
  // the schedule is AT the stop, standing, a few seconds after it is due there
  const p = traffic._fixed(buses._spec(line, k));
  traffic._nomTo(p, a[2] + 4);
  assert.ok(p.nwait > 0, 'doors open');
  assert.ok(Math.abs(traffic._nomArc(p, a[2] + 4) - line.stops[2].arc) < 1e-6, 'at the stop');
  // eta() answers from the same numbers
  const eta = buses.eta(line.stops[2].x, line.stops[2].z, a[2] - 30);
  assert.ok(eta <= a[2] + 1e-9 && eta >= a[2] - 30, `eta ${eta} against due ${a[2]}`);
});

test('two clients run the same buses in the same places', () => {
  const A = world(1), B = world(-1);
  const drive = (w, pos, secs) => {
    for (let i = 1; i <= secs * 20; i++) {
      w.at(T0 + i / 20);
      w.traffic.update(1 / 20, pos, null);
      w.buses.update(1 / 20, pos);
    }
  };
  drive(A, { x: -200, z: 40 }, 90);
  drive(B, { x: 250, z: -60 }, 90);
  const rows = (w) => w.traffic.snapshot(0, 0, 1500).filter((r) => String(r.key).startsWith('bus:'));
  const ra = rows(A), rb = rows(B);
  assert.ok(ra.length >= 2, `only ${ra.length} buses on the road`);
  assert.deepEqual(ra.map((r) => r.key), rb.map((r) => r.key));
  for (let i = 0; i < ra.length; i++) assert.ok(Math.abs(ra[i].arc - rb[i].arc) < 1e-6, `${ra[i].key} is in two places`);
  let meshed = 0;
  for (const c of A.traffic.cars) if (c.kind === 'bus') { meshed++; assert.ok(c.ai.fixed, 'every bus on the road is on a line'); }
  assert.ok(meshed >= 1, 'no bus took a mesh');
});

test('a bus standing at its stop is the one people board', () => {
  const w = world();
  const pos = { x: 0, z: 60 };
  let seen = null;
  for (let i = 1; i <= 400 * 20 && !seen; i++) {
    w.at(T0 + i / 20);
    w.traffic.update(1 / 20, pos, null);
    w.buses.update(1 / 20, pos);
    if (i % 10) continue;
    for (const l of w.buses.lines) for (const s of l.stops) {
      const car = w.buses.standingAt(s.x, s.z);
      if (car) seen = { car, s };
    }
  }
  assert.ok(seen, 'in 400 s no bus ever stood at a stop with its doors open');
  assert.equal(seen.car.kind, 'bus');
  assert.ok(Math.hypot(seen.car.x - seen.s.x, seen.car.z - seen.s.z) < 14, 'and it is AT that stop');
});

test('traffic stops for somebody on the road and is not hauled through them', () => {
  const traffic = new Traffic(town(), vehicles());
  let now = T0;
  traffic.clock = () => now;
  traffic.maxCars = 400;
  // somebody standing in the eastbound lane of the main street at x = 100 (the
  // lane runs 2.1 m right of the centreline, and right of +x is +z)
  traffic.walkers = [{ cx: 100, cz: 0, rdx: 1, rdz: 0, hw: 4.5, must: true, x: 100, z: 2.1, body: false }];
  const pos = { x: 100, z: 30 };
  const east = (c) => Math.abs(c.z - 2.1) < 1.2 && -Math.sin(c.heading) > 0.9;   // in that lane, driving +x
  let closest = Infinity, queued = 0, arrived = 0;
  for (let i = 1; i <= 240 * 20; i++) {
    now = T0 + i / 20;
    traffic.update(1 / 20, pos, null);
    let q = 0;
    for (const c of traffic.cars) {
      if (!east(c)) continue;
      const d = 100 - (c.x + c.len / 2);            // nose to the person
      if (c.x < 102 && c.x > 0) { arrived++; if (d < closest) closest = d; }
      assert.ok(!(c.x > 97.5 && c.x < 102.5), `a car drove over the person (x = ${c.x.toFixed(1)}, t = ${(i / 20).toFixed(1)} s)`);
      if (c.x < 100 && c.x > 20 && c.speed < 0.5) q++;
    }
    // (headless there is no camera, so a car held past LAG_MAX leaves as a
    // ghost at once: the queue is counted while it stands, not at the end)
    if (q > queued) queued = q;
  }
  assert.ok(arrived > 0, 'no eastbound car ever came: the fixture is not testing this');
  assert.ok(closest > 0.3, `a car stopped ${closest.toFixed(2)} m from them`);
  assert.ok(queued >= 2, `a queue of ${queued}: the cars behind did not stop behind the first`);
  // …and when they have crossed, the road flows again
  traffic.walkers = [];
  let passed = 0;
  for (let i = 1; i <= 40 * 20; i++) {
    now += 1 / 20;
    traffic.update(1 / 20, pos, null);
    for (const c of traffic.cars) if (east(c) && c.x > 104 && c.x < 140 && c.speed > 3) passed++;
  }
  assert.ok(passed > 0, 'nobody moved after the road cleared');
});

// Somebody lying in the eastbound lane at x = 100. With a camera on the spot, so
// that a car held past LAG_MAX stays (as a local ghost) instead of leaving.
function bodyRun(stale, secs) {
  const traffic = new Traffic(town(), vehicles());
  let now = T0;
  traffic.clock = () => now;
  traffic.maxCars = 400;
  traffic.walkers = [{ cx: 100, cz: 2.1, rdx: 0, rdz: 0, hw: 1, must: true, x: 100, z: 2.1, body: true, stale }];
  const pos = { x: 100, z: 30 };
  const east = (c) => Math.abs(c.z - 2.1) < 1.2 && -Math.sin(c.heading) > 0.9;
  const seen = new Map();
  let stood = 0, firstStop = Infinity, firstPast = Infinity, fastest = 0;
  for (let i = 1; i <= secs * 20; i++) {
    now = T0 + i / 20;
    traffic.setViewer({ x: 100, z: 60, dirX: 0, dirZ: -1, hideR: 0 });
    traffic.update(1 / 20, pos, null);
    for (const c of traffic.cars) {
      if (!east(c)) continue;
      const nose = c.x + c.len / 2;
      let s = seen.get(c);
      if (!s) seen.set(c, s = { t: 0, before: false });
      if (nose < 99) s.before = true;
      if (!s.before) continue;                       // took its mesh beyond the body
      // Standing AT THE BODY: the head of the queue. (Changed on purpose: this
      // counted every car in the last 11 m, so somebody waiting two seconds
      // behind a driver who was crawling over the body, exactly as asked, read
      // as "stood at a stale body". What the test is about is the driver with
      // nothing in front of them but the body.)
      let head = true;
      for (const o of traffic.cars) if (o !== c && east(o) && o.x > c.x && o.x < c.x + 9) head = false;
      if (head && nose > 88 && nose < 99.5 && c.speed < 0.2) {
        s.t += 1 / 20;
        if (s.t > stood) stood = s.t;
        if (i / 20 < firstStop) firstStop = i / 20;
      }
      if (nose > 99.5 && c.x - c.len / 2 < 100 && c.speed > fastest) fastest = c.speed;
      if (c.x - c.len / 2 > 100.5 && i / 20 < firstPast) firstPast = i / 20;
    }
  }
  return { stood, firstStop, firstPast, fastest };
}

test('a driver waits at a body in the road, then rolls past it at a crawl and does not stall', () => {
  const r = bodyRun(false, 150);
  assert.ok(r.stood > 5, `nobody stood for the body (${r.stood.toFixed(1)} s)`);
  // patience is 9 to 14 s and the crawl over is a few seconds more: a driver
  // who became patient again the moment they moved off took minutes
  assert.ok(r.firstPast - r.firstStop < 45, `the first car needed ${(r.firstPast - r.firstStop).toFixed(0)} s to get past`);
  assert.ok(r.fastest < 2.5, `a car went over them at ${r.fastest.toFixed(1)} m/s`);
});

test('a body that has lain in the road a while is crawled past without standing', () => {
  const r = bodyRun(true, 90);
  assert.ok(Number.isFinite(r.firstPast), 'no car ever came past: the fixture is not testing this');
  assert.ok(r.stood < 2, `a car stood ${r.stood.toFixed(1)} s at a stale body`);
  assert.ok(r.fastest < 2.5, `a car went over them at ${r.fastest.toFixed(1)} m/s`);
});
