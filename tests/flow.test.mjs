// ---- traffic keeps flowing, and the seams between the crowd and the street ----
// Wave 3 measured an hour of the real town (tests/flow-harness.mjs) and found
// what the fixtures could not: junctions the tile build had simplified away,
// ghosts standing at the end of a road nobody had laid for them, signal masts
// out in the asphalt of big junction pads, walkers whose side of the path was
// the traffic lane, and a first car parked with its nose in a kiosk. Each is
// pinned here, the pure parts on small fixtures and the rest on the real tiles.
import test from 'node:test';
import assert from 'node:assert';
import { bootCity, loadAround, makeTown, stubVehicles, PLACES, T_NOON } from './flow-harness.mjs';

const city = await bootCity();
await loadAround(city, 25, -122);
const { Traffic, stitchWays } = await import('../js/traffic.js');
const { Buses } = await import('../js/buses.js');
const { Pedestrians } = await import('../js/pedestrians.js');
const { parkSpots, footprintClear, FIRST_CAR } = await import('../js/parkspot.js');
const { SPAWN } = await import('../js/config.js');
const geo = await import('../js/geo.js');
const streets = await import('../js/streets.js');

const quiet = (fn) => { const log = console.log; console.log = () => {}; try { return fn(); } finally { console.log = log; } };

// ------------------------------------------------- the junctions the tiles lost ----
test('a side street that ends on a through street gets its junction back', () => {
  const main = { t: 'primary', d: 1, w: 9, p: [[-100, 0], [100, 0]] };          // no vertex at x = 20
  const side = { t: 'residential', d: 1, w: 6, p: [[20, 60], [20, 0.3]] };       // ends 30 cm short of the line
  const cross = { t: 'residential', d: 1, w: 6, p: [[-40, -50], [-40, 50]] };    // crosses with no shared point
  const over = { t: 'secondary', d: 1, w: 8, br: 1, p: [[60, -50], [60, 50]] };  // a bridge: shares nothing
  const far = { t: 'service', d: 1, w: 4, p: [[80, 40], [80, 3]] };              // 3 m short: not a junction
  const out = stitchWays([main, side, cross, over, far]);
  const m = out.get(main);
  assert.ok(m, 'the through street was not cut');
  const has = (p, x, z) => p.some((q) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - z) < 1e-6);
  assert.ok(has(m, 20, 0) && has(m, -40, 0), `main got ${JSON.stringify(m)}`);
  assert.ok(!has(m, 60, 0) && !has(m, 80, 0), 'a bridge overhead and a lane that stops short are not junctions');
  assert.ok(has(out.get(side), 20, 0), 'the side street now ends ON the main one');
  assert.ok(has(out.get(cross), -40, 0));
  assert.equal(out.has(over), false);
  assert.equal(main.p.length, 2, 'the way the mesher draws is never touched');
  // …and the traffic can turn there now
  const t = quiet(() => new Traffic({ roads: [main, side, cross, over, far], signals: [], onTileLoaded() {} }, stubVehicles()));
  const node = [...t.edges].map((e) => e.b).find((n) => Math.abs(n.x - 20) < 0.1 && Math.abs(n.z) < 0.1);
  assert.ok(node && node.out.length >= 3, 'no junction node where the side street meets the main street');
  // the same junctions whatever order the ways arrived in
  const rev = stitchWays([far, over, cross, side, main]);
  assert.deepEqual(rev.get(main).map((q) => q.join()).sort(), m.map((q) => q.join()).sort());
});

test('through traffic does not turn into a dead end, and nobody is born driving into one', () => {
  const roads = [
    { t: 'residential', d: 1, w: 7, p: [[-300, 0], [0, 0]] },
    { t: 'residential', d: 1, w: 7, p: [[0, 0], [300, 0]] },
    { t: 'service', d: 1, w: 4, p: [[0, 0], [0, 80]] },                // a yard: 80 m and a wall
    { t: 'residential', d: 1, w: 7, p: [[300, 0], [300, 300], [-300, 300], [-300, 0]] },
  ];
  const t = quiet(() => new Traffic({ roads, signals: [], onTileLoaded() {} }, stubVehicles()));
  t._culUpdate();
  const yard = t.edges.filter((e) => e.road.t === 'service');
  assert.ok(yard.some((e) => e.cul) && yard.some((e) => !e.cul), 'into the yard is a dead end, out of it is not');
  const inbound = t.edges.find((e) => e.road.t === 'residential' && Math.abs(e.b.x) < 0.1 && Math.abs(e.b.z) < 0.1);
  for (let h = 1; h < 400; h++) assert.notEqual(t._pickNextDet(inbound, h * 2654435761 | 0).road.t, 'service');
  // a car that IS in the yard still comes out
  const outward = yard.find((e) => !e.cul);
  for (let h = 1; h < 40; h++) assert.equal(t._pickNextDet(outward, h * 2654435761 | 0)?.road.t, 'residential', 'no way out of the yard');
});

test('nobody drives into a car standing at the kerb of a main road', () => {
  // The player at a taxi pick-up: a hull in the kerb lane of a 60 km/h road.
  // Before: the 22 m the leader rule looks ahead was 15 m of braking for a
  // driver doing 17 m/s, the last metres were closed at a creep that never
  // filled the stop gap (so the car was "held by flow" and hauled through the
  // hull when it fell LAG_MAX behind), and a mesh could arrive 12 m short.
  const roads = [];
  for (let i = -4; i <= 4; i++) {
    const p1 = [], p2 = [];
    for (let j = -4; j <= 4; j++) { p1.push([i * 240, j * 240]); p2.push([j * 240, i * 240]); }
    roads.push({ t: 'primary', d: 1, w: 10.5, v: 60, p: p1 }, { t: 'primary', d: 1, w: 10.5, v: 60, p: p2 });
  }
  const t = quiet(() => new Traffic({ roads, signals: [], onTileLoaded() {} }, stubVehicles()));
  let now = T_NOON;
  t.clock = () => now; t.maxCars = 200;
  const me = { x: 120, z: 4.0, half: 3.9 };          // where jobplaces puts a stop on a road this wide
  t.actors = [me];
  const pos = { x: 120, z: 30 };
  let rams = 0, queued = 0, oncoming = 0;
  const touching = new Set();
  for (let i = 0; i < 600 * 20; i++) {
    now += 1 / 20;
    const a = i / 20 / 90 * Math.PI * 2;              // somebody standing by, looking about
    t.setViewer({ x: pos.x, z: pos.z, dirX: Math.cos(a), dirZ: Math.sin(a) });
    t.update(1 / 20, pos, null);
    for (const c of t.cars) {
      const dx = Math.abs(c.x - me.x), dz = Math.abs(c.z - me.z);
      const hit = dx < (c.len + 4.6) / 2 - 0.15 && dz < (c.wid + 1.8) / 2 - 0.15 && Math.abs(Math.sin(c.heading)) > 0.9;
      if (hit && !touching.has(c)) { touching.add(c); rams++; }
      if (!hit && dx > 12) touching.delete(c);
      if (i % 20) continue;
      if (dx < 12 && dz < 2.5 && Math.abs(c.speed) < 0.3) queued++;
      if (dx < 6 && c.z < -1 && Math.abs(c.speed) > 3) oncoming++;
    }
  }
  assert.equal(rams, 0, `${rams} cars drove into the standing car`);
  // and the test saw traffic: a queue behind the hull, the other lane flowing past it
  assert.ok(queued > 20, `only ${queued} car-seconds stood behind it: nothing came down this lane`);
  assert.ok(oncoming > 50, `only ${oncoming} car-seconds of traffic passed in the other lane`);
});

// ------------------------------------------------------------- the real town ----
test('an hour-shaped slice of Palackého: the traffic flows and nobody is run over', async () => {
  const w = await makeTown(PLACES.palackeho);
  const stood = new Map();
  let cars = 0, stopped = 0, stuck = 0, samples = 0;
  for (let i = 1; i <= 420 * 20; i++) {
    w.step(1 / 20);
    if (i % 20 || i < 60 * 20) continue;
    samples++;
    for (const c of w.traffic.cars) {
      if (Math.hypot(c.x - w.pos.x, c.z - w.pos.z) > 300 || (c.ai?.fixed && c.ai.atStop >= 0)) continue;
      cars++;
      if (Math.abs(c.speed) < 0.5) { stopped++; const n = (stood.get(c) ?? 0) + 1; stood.set(c, n); if (n === 60) stuck++; }
      else stood.delete(c);
    }
    // a ghost has road in front of it for as long as it lives
    for (const p of w.traffic._ghosts) {
      if (!p.car || p.ghostT < 20) continue;
      assert.ok(p.next || p.edge.len - p.s > 2 || p.sR < p.routeEnd - 2 || Math.abs(p.car.speed) > 0.5 || p.blk || p.ctlHold,
        `a ghost stands at the end of its laid road at ${p.sx.toFixed(0)}, ${p.sz.toFixed(0)}`);
    }
  }
  assert.ok(cars / samples > 12, `only ${(cars / samples).toFixed(0)} cars about: the place is not being tested`);
  // measured before this wave on the same harness: 23 % standing, 12 trips stuck an hour
  assert.ok(stopped / cars < 0.16, `${(stopped / cars * 100).toFixed(1)} % of the cars are standing`);
  assert.equal(stuck, 0, `${stuck} cars stood for a minute or more`);
  assert.equal(w.stats.killed, 0, `${w.stats.killed} people were run over: ${JSON.stringify(w.stats.kills.slice(0, 2))}`);

  // SIGNALS STAND AT THE KERB. Every mast the same Traffic built, against the
  // junction outlines the mesher draws: none on the asphalt of a pad (23 of
  // 254 were, before), none in a carriageway, and the junctions kept their masts.
  let n = 0;
  for (const jn of w.traffic._junctions) for (const s of jn.sigs) {
    if (!s.mesh) continue;
    n++;
    const x = s.mesh.position.x, z = s.mesh.position.z;
    assert.equal(w.traffic._onPad(x, z), false, `a signal mast stands in the junction pad at ${x.toFixed(1)}, ${z.toFixed(1)}`);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const k = (Math.floor(x / 120) + i) + ',' + (Math.floor(z / 120) + j);
      for (const o of geo.clustersIn(k) ?? []) {
        const ring = geo.clusterHull(o);
        if (ring && geo.pointInPolygon(x, z, ring)) assert.ok(streets.cornerLift(o, x, z) >= 0, 'inside a cluster outline and not on its kerb band');
      }
    }
  }
  assert.ok(n >= 200, `only ${n} masts were built: the fix must move them, not drop them`);

  // WHO SERVES A STOP DOES NOT DEPEND ON WHEN YOU ASK. A second timetable that
  // has derived nothing yet gives the same next bus as the one that has been
  // running here for seven minutes.
  const fresh = new Buses(w.city, w.traffic);
  fresh.clock = w.life.buses.clock;
  let asked = 0, served = 0;
  for (const poi of w.city.pois) {
    if (poi.t !== 'bus_stop' || Math.hypot(poi.p[0] - w.pos.x, poi.p[1] - w.pos.z) > 900) continue;
    asked++;
    const a = quiet(() => w.life.buses.eta(poi.p[0], poi.p[1], w.now()));
    const b = quiet(() => fresh.eta(poi.p[0], poi.p[1], w.now()));
    assert.equal(a, b, `stop at ${poi.p}: ${a} against ${b}`);
    if (Number.isFinite(a)) served++;
  }
  assert.ok(asked >= 5 && served >= 3, `${served} of ${asked} stops have a bus: not testing the timetable`);
});

// ------------------------------------------------------------------ the crowd ----
function lane() {
  // a footway 4.4 m from the centreline of an 8 m street: on no carriageway
  // itself, but a walker's side of it is half a metre into the lane
  const roads = [
    { t: 'residential', d: 1, w: 8, _id: 1, p: [[-300, 0], [300, 0]] },
    { t: 'footway', d: 0, w: 1.8, _id: 2, p: [[-300, 4.4], [300, 4.4]] },
    { t: 'footway', d: 0, w: 1.8, _id: 3, p: [[-300, -4.4], [300, -4.4]] },
    { t: 'footway', d: 0, w: 1.8, _id: 4, p: [[-300, 40], [300, 40]] },      // well clear of everything
  ];
  const furn = [{ p: [[10, 42.2]], k: 'bench', _id: 9 }];
  const cell = { roads: roads.filter((r) => !r.d), furniture: furn, crossings: [], venues: [] };
  return { roads, chunkIndex: new Map([['0,0', cell]]), pois: [], onTileLoaded() {} };
}

test('nobody walks with a shoulder in the traffic lane, and the old man takes his time', () => {
  const peds = new Pedestrians({ add() {}, remove() {} }, lane());
  let now = T_NOON;
  peds.clock = () => now;
  peds.max = 120; peds.rhythm = false;
  let near = 0, far = 0, old = 0, young = 0;
  for (let i = 0; i < 90 * 20; i++) {
    now += 1 / 20;
    peds.setViewer({ x: 0, z: 20, dirX: 1, dirZ: 0, hideR: 0 });
    peds.update(1 / 20, { x: 0, z: 20 });
    if (i % 10) continue;
    for (const p of peds.peds) {
      if (p.state !== 'walk' || p.pose) continue;
      if (Math.abs(p.z) < 20) {
        near++;
        // the carriageway is |z| < 4; a body is 0.35 m across the shoulders
        assert.ok(Math.abs(p.z) >= 4.3, `walking at z = ${p.z.toFixed(2)}, in the lane of a street they are not crossing`);
      } else if (Math.abs(p.z - 40) < 3) { far++; }
    }
  }
  assert.ok(near > 200, `only ${near} samples beside the street`);
  // out on the open path people still keep to a side of it
  let aside = 0;
  for (const p of peds.peds) if (p.state === 'walk' && !p.pose && Math.abs(p.z - 40) < 3 && Math.abs(p.z - 40) > 0.5) aside++;
  assert.ok(far > 50 && aside >= 1, 'everybody was pulled onto the centreline, everywhere');
  for (const s of peds._pool.values()) {
    const isOld = s.speed < 0.9;
    if (isOld) { old++; assert.ok(s.speed > 0.55 && s.speed < 0.82, `the old man walks at ${s.speed.toFixed(2)} m/s`); }
    else { young++; assert.ok(s.speed >= 1.15, `somebody strolls at ${s.speed.toFixed(2)} m/s`); }
  }
  assert.ok(old >= 2 && young > old * 3, `${old} slow walkers among ${old + young}`);
});

test('two people on one bench take a half each, and a third stands', () => {
  const peds = new Pedestrians({ add() {}, remove() {} }, lane());
  let now = T_NOON;
  peds.clock = () => now;
  // three strangers at the same bench, arriving one after another
  const site = { sid: 9, x: 10, z: 42.2, h: Math.PI };
  const mk = (key, seed, kindAt) => ({ key, seed, rs: seed, pair: 0, stops: [{ site, kind: 1 }],
    tl: null, seat: null, _at: kindAt });
  const a = mk('0,0/1', 11), b = mk('0,0/2', 12), c = mk('0,0/3', 13);
  for (const s of [a, b, c]) peds._pool.set(s.key, s);
  peds._benchers.set(9, new Set([a, b, c]));
  // timelines: a sits from 100, b from 110, c from 120, all until 200
  const tl = (t0) => ({ n: 3, i: 0, t: [0, t0, 200], a: [0, 5, 5], k: [0, 1, 0], r: [-1, 0, -1], d: [0, 5, 5] });
  a.tl = tl(100); b.tl = tl(110); c.tl = tl(120);
  const ha = peds._seatOf(a, 0, 100), hb = peds._seatOf(b, 0, 110), hc = peds._seatOf(c, 0, 120);
  assert.ok(Math.abs(ha) === 1 && Math.abs(hb) === 1, `seats ${ha}, ${hb}`);
  assert.notEqual(ha, hb, 'two strangers on the same half of the bench');
  assert.equal(hc, 0, 'a third squeezed onto a bench for two');
  // asked in the other order (another client, who met them in another order): the same seats
  for (const s of [a, b, c]) s.seat = null;
  assert.equal(peds._seatOf(c, 0, 120), 0);
  assert.equal(peds._seatOf(b, 0, 110), hb);
  assert.equal(peds._seatOf(a, 0, 100), ha);
});

// ------------------------------------------------------------ the first minute ----
test('the first car stands clear, in view, facing a free way out; no parked car is inside anything', () => {
  const spots = parkSpots(city, SPAWN);
  assert.ok(spots.length >= 4, `only ${spots.length} parked cars`);
  for (const s of spots) {
    assert.ok(footprintClear(city, s.x, s.z, s.h, 5, 1.9, { lanes: false }),
      `a parked car at ${s.x.toFixed(1)}, ${s.z.toFixed(1)} stands in a building, a prop or a tree`);
  }
  // where it used to stand: nose in the Hello! kiosk
  assert.equal(footprintClear(city, SPAWN.x + 9, SPAWN.z + 8, 1.2), false, 'the fixture changed: the old spot was inside a kiosk');
  const first = spots[0];
  assert.ok(Math.hypot(first.x - SPAWN.x, first.z - SPAWN.z) < 8, 'the marked car is a few steps from where the player wakes up');
  assert.ok(Math.hypot(first.x - SPAWN.x, first.z - SPAWN.z) > 3, '…and not on top of them');
  // the opening camera stands behind the player looking along their heading:
  // the car has to be in front of that camera and inside its field of view
  const fx = -Math.sin(SPAWN.heading), fz = -Math.cos(SPAWN.heading);
  const camX = SPAWN.x - fx * 6, camZ = SPAWN.z - fz * 6;
  const dx = first.x - camX, dz = first.z - camZ, d = Math.hypot(dx, dz);
  assert.ok((dx * fx + dz * fz) / d > Math.cos(0.7), 'the first car is outside the opening view');
  // nothing between the camera and the car
  for (let k = 1; k < 10; k++) {
    const x = camX + dx * k / 10, z = camZ + dz * k / 10;
    assert.ok(footprintClear(city, x, z, 0, 0.4, 0.4, { lanes: false }), 'a kiosk stands between the camera and the car');
  }
  // …and 30 m of clear ground ahead of its bonnet (it used to face a wall)
  const hx = -Math.sin(first.h), hz = -Math.cos(first.h);
  for (let k = 4; k <= 30; k += 2) {
    assert.ok(footprintClear(city, first.x + hx * k, first.z + hz * k, first.h, 2, 1.9, { lanes: false }),
      `${k} m ahead of the first car is not free`);
  }
  assert.equal(FIRST_CAR.h, -Math.PI / 2);
  // the same cars whoever computes them
  assert.deepEqual(parkSpots(city, SPAWN), spots);
});

// ------------------------------------------------------------------- the bus ----
test('a boarder waits for a late bus that is really coming, and not for one that is not', () => {
  const peds = new Pedestrians({ add() {}, remove() {} }, lane());
  let now = T_NOON;
  peds.clock = () => now;
  const site = { x: 50, z: 6 };
  const s = { key: 'x/1', board: 0, stops: [{ site }], span: 100, lo: 0, tl: { n: 2, i: 0, t: [0, 1], a: [10, 10], k: [0, 0], r: [-1, -1], d: [0, 0] } };
  const body = () => ({ sch: s, pose: 1, rush: 0, x: 50, z: 6, standPose() {}, mesh: { position: { set() {} }, rotation: {} } });
  // nobody coming: they give up at once, as before
  peds.busAt = () => null; peds.busNear = () => false;
  let p = body();
  peds._depart(p, s, 0);
  assert.equal(p.free, 1, 'stood on at a stop no bus is coming to');
  // one in sight: they stay…
  peds.busNear = () => true;
  p = body();
  peds._depart(p, s, 0);
  assert.notEqual(p.free, 1, 'walked off with the bus in sight');
  // …board it when it pulls in…
  const bus = { x: 52, z: 2, heading: -Math.PI / 2, len: 11, wid: 2.5 };
  peds.busAt = () => bus;
  peds._depart(p, s, 0);
  assert.equal(p.state, 'board');
  assert.equal(p.boardCar, bus);
  // …and do not wait for ever for one that never arrives
  peds.busAt = () => null;
  p = body();
  peds._depart(p, s, 0);
  now += 80;
  peds._depart(p, s, 0);
  assert.equal(p.free, 1, 'still waiting 80 s after the timetable gave up');
});

test('a boarder a dozen metres from the door runs and makes it; a bus that pulls away is missed, and nobody vanishes on the paving', () => {
  // The two stops on the station forecourt stand 13 m from the kerb their bus
  // calls at. Boarders walked for seven seconds and were switched off where
  // they stood, in the open, a few metres short of the door.
  const peds = new Pedestrians({ add() {}, remove() {} }, lane());
  const bus = { x: 52, z: 2, heading: -Math.PI / 2, len: 11, wid: 2.5, speed: 0 };
  const body = () => ({ state: 'board', boardCar: bus, boardT: 0, boardDone: false, x: 50, z: 18.5, heading: 0, walkT: 0, speed: 0,
    gx: 1e9, gz: 1e9, gy: null, blend: 0, animate() {}, standPose() {}, mesh: { visible: true, position: { set() {} }, rotation: {} } });
  let p = body(), t = 0, top = 0;
  while (!p.boardDone && p.state === 'board' && t < 20) { peds._boardStep(p, 1 / 20); t += 1 / 20; if (p.speed > top) top = p.speed; }
  assert.ok(p.boardDone && !p.mesh.visible, 'never reached the door');
  // the doors stand open nine seconds (js/buses.js DWELL), and boarding starts with two of them gone
  assert.ok(t < 7, `took ${t.toFixed(1)} s to cover 15 m: the bus has left`);
  assert.ok(top > 2.5 && p.speed < 2, 'runs while far, walks the last steps');
  // the bus pulls away with them half way there
  p = body();
  for (let i = 0; i < 40; i++) peds._boardStep(p, 1 / 20);
  bus.speed = 4;
  peds._boardStep(p, 1 / 20);
  assert.equal(p.state, 'walk', 'still chasing a bus that has gone');
  assert.ok(p.mesh.visible && !p.boardDone && p.boardCar === null, 'vanished in the open');
  assert.equal(p.blend, 1, 'walks back to the beat from where they stand');
});
