// ---- cyclists: what a rider does about what is in front of them ---------------
// The plan says where a rider is at each shared second (tests/cyclists-net).
// This file is about the part that is this client's own: slowing for a walker,
// stopping behind a car, waiting at a kerb, and being knocked off. One rider
// on one hand-made ride, so every number below has one cause.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Cyclists } = await import('../js/cyclists.js');
const { buildPlan, planAt } = await import('../js/cycleplan.js');
const { Pedestrians } = await import('../js/pedestrians.js');
const { PAINTS } = await import('../js/bikemodel.js');
const { way, stubScene, T0 } = await import('./cyclists-fixture.mjs');

// A world of the given ways with ONE rider on a ride along `path` (indexes
// into `ways`, each ridden end to end), and nobody else: the slider is at zero.
function world(ways, path, opt = {}) {
  const city = { roads: ways, onTileLoaded() {} };
  let now = T0;
  const peds = opt.realPeds ? new Pedestrians(stubScene, city) : (opt.peds ?? null);
  if (opt.realPeds) { peds.clock = () => now; peds.max = 0; }
  const traffic = opt.traffic ?? null;
  let car = null;
  const cy = new Cyclists(stubScene, city, opt.ground ?? null, { peds, traffic, parked: opt.parked ?? null,
    playerCar: () => car, walker: () => opt.walker ?? null });
  cy.clock = () => now;
  cy.max = 0;
  const legs = path.map((i) => ({ w: cy.net.ways.get(ways[i]), i0: 0, i1: ways[i].p.length - 1 }));
  const v0 = opt.v0 ?? 5;
  const plan = buildPlan(legs, { v0, t0: T0, drive: cy.drive, sites: cy.sites,
    signalWait: traffic?.walkWait ? (...a) => traffic.walkWait(...a) : null });
  const s = { key: 'test/0', ci: 0, cj: 0, k: 0, cell: { ci: 0, cj: 0, len: 0, ways: [] }, seed: 4242, gen: 0, ph: 0, t0: T0, plan,
    arch: 'm30', type: opt.type ?? 0, paint: PAINTS[2], v0, child: false, hint: { k: 0, s: 0 }, body: null, held: 0 };
  const r = cy._attach(s, now);
  // a second rider on the same ride: { v0, head: seconds they set off before the first }
  let r2 = null;
  if (opt.second) {
    const p2 = buildPlan(legs, { v0: opt.second.v0, t0: T0 - opt.second.head, drive: cy.drive, sites: cy.sites,
      signalWait: traffic?.walkWait ? (...a) => traffic.walkWait(...a) : null });
    r2 = cy._attach({ ...s, key: 'test/1', seed: 777, plan: p2, v0: opt.second.v0, t0: p2.t0, hint: { k: 0, s: 0 }, body: null }, now);
  }
  const pos = { x: 5000, z: 5000 };      // the player is nowhere near
  const step = (secs, each = null, hz = 30) => {
    for (let i = 0; i < secs * hz; i++) {
      now += 1 / hz;
      if (peds?.update) { peds.cars = traffic?.cars ? [...traffic.cars] : []; peds.playerCar = car; peds.update(1 / hz, pos); }
      else if (peds) peds.crossers.length = 0;
      cy._sweepT = 1e9;                  // no sweeps: this rider is ours, not the population's
      cy.update(1 / hz, pos);
      each?.(now);
    }
  };
  const lag = () => { const N = {}; planAt(plan, now, { k: 0, s: 0 }, N); return N.arc - r.arc; };
  return { cy, r, r2, s, plan, step, lag, peds, now: () => now, setCar: (c) => { car = c; } };
}

const PATH = () => [way('cycleway', [[0, 0], [600, 0]])];
// a walker as the crowd keeps one: where, which way, how fast
const walker = (x, z, speed = 0, heading = -Math.PI / 2) => ({ x, z, speed, heading, state: 'walk' });

test('alone on a path a rider is exactly where the plan says', () => {
  const w = world(PATH(), [0]);
  let worst = 0;
  w.step(60, () => { worst = Math.max(worst, Math.abs(w.lag())); });
  assert.ok(worst < 0.05, 'lag ' + worst);
  assert.ok(Math.abs(w.r.v - 5) < 1e-6 && w.r.stand === 0 && Math.abs(w.r.roll) < 1e-6);
  assert.ok(Math.abs(w.r.z - 0.45) < 0.01, 'on the right of the path');
  assert.equal(w.cy.fleet.count, 1, 'one bicycle drawn');
});

test('the bicycle follows the ground, and leans into a bend', () => {
  // a path climbing six in a hundred to the east
  let asked = 0;
  const ground = { heightAt: (x) => { asked++; return 100 + 0.06 * x; } };
  const w = world(PATH(), [0], { ground });
  w.step(20);
  assert.ok(Math.abs(w.r.y - (100 + 0.06 * w.r.x)) < 0.04, 'wheels on the slope: ' + (w.r.y - 100 - 0.06 * w.r.x));
  assert.ok(Math.abs(w.r.pitch - Math.atan(0.06)) < 0.01, 'nose up by the gradient: ' + w.r.pitch);
  assert.equal(w.r.mesh.rotation.order, 'YXZ');
  assert.ok(Math.abs(w.r.mesh.rotation.x - w.r.pitch) < 1e-9 && Math.abs(w.r.mesh.position.y - w.r.y) < 1e-9, 'the rider is on the bike');
  assert.ok(asked < 100 / 0.5 + 12, 'the ground is asked once per half metre, not per frame: ' + asked + ' in 100 m');
  // east, then a right turn south
  const bend = world([way('cycleway', [[0, 0], [60, 0]]), way('cycleway', [[60, 0], [60, 200]])], [0, 1]);
  let lean = 0, steer = 0, vMin = 9;
  bend.step(22, () => {
    if (bend.r.roll > lean) lean = bend.r.roll;
    if (bend.r.steer > steer) steer = bend.r.steer;
    if (bend.r.v < vMin) vMin = bend.r.v;
    assert.ok(bend.r.roll > -0.02, 'never out of the bend');
  });
  assert.ok(lean > 0.1 && lean < 0.5, 'leaning right, into it: ' + lean);
  assert.ok(steer > 0.15, 'bars turned right: ' + steer);
  assert.ok(vMin < 3.2 && vMin > 1.5, 'slower round the corner: ' + vMin);
  assert.ok(Math.abs(bend.r.roll) < 0.01 && bend.r.dz > 0.999, 'upright again, heading south');
});

test('a walker ahead: slower, round them with room, and back up to the plan', () => {
  const peds = { peds: [walker(150, 0.45)], crossers: [] };
  const w = world(PATH(), [0], { peds });
  let vMin = 9, closest = 9, shiftMin = 0;
  w.step(45, () => {
    const d = Math.hypot(w.r.x - 150, w.r.z - 0.45);
    if (d < closest) closest = d;
    if (d < 12 && w.r.v < vMin) vMin = w.r.v;
    if (w.r.shift < shiftMin) shiftMin = w.r.shift;
  });
  assert.ok(vMin < 3.3 && vMin > 1.5, 'passes at an easy pace: ' + vMin);
  assert.ok(closest > 0.7, 'with room: ' + closest);
  assert.ok(shiftMin < -0.5, 'on the left');
  assert.ok(w.r.x > 200 && Math.abs(w.r.shift) < 0.02, 'and back on their line');
  assert.ok(w.lag() < 0.5, 'having caught the plan up: ' + w.lag());
});

test('two people abreast and no room: at their pace, behind them', () => {
  // walking the rider's way at 1.3 m/s, across the whole path
  const a = walker(60, -0.5, 1.3), b = walker(60, 0.6, 1.3);
  const peds = { peds: [a, b], crossers: [] };
  const w = world([way('cycleway', [[0, 0], [600, 0]], { w: 1.6 })], [0], { peds });
  let closest = 99;
  w.step(40, () => {
    a.x += 1.3 / 30; b.x += 1.3 / 30;
    if (w.r.x < a.x) closest = Math.min(closest, a.x - w.r.x);
  });
  assert.ok(w.r.x < a.x, 'never through them');
  assert.ok(closest > 1.0, 'nor on their heels: ' + closest);
  assert.ok(Math.abs(w.r.v - 1.3) < 0.5, 'at walking pace: ' + w.r.v);
  // …and once that has cost them eighty metres on the plan they are this
  // client's own rider: not hauled through the two walkers to catch it up
  assert.ok(w.lag() > 80, 'well behind the plan: ' + w.lag());
  assert.ok(w.r.ghost && w.r.late > 0 && w.s.held === 1 && w.s.body === null, 'cut loose from the shared slot');
  assert.equal(w.cy.stats.late, 1);
});

test('a car across the path: stop short of it, a foot down, and on when it has gone', () => {
  const car = { x: 120, z: 0, heading: 0, speed: 0, len: 4.6, wid: 1.8 };       // facing north: broadside to the path
  const traffic = { cars: new Set([car]), threatens: () => false };
  const w = world(PATH(), [0], { traffic });
  w.step(40);
  const gap = (car.x - car.wid / 2) - w.r.x;
  assert.ok(w.r.v === 0 && gap > 0.6 && gap < 3, 'standing just short of its flank: ' + gap);
  assert.ok(w.r.stand > 0.99 && w.r.roll < -0.1, 'with a foot down, the bike leaning onto it');
  assert.equal(w.cy.stats.knocked, 0);
  traffic.cars.clear();
  w.step(12);
  assert.ok(w.r.x > 140 && w.r.stand === 0, 'and away');
});

test('a car left standing across the path is gone round, not waited for', () => {
  // somebody's car, parked broadside over the cycle path, its middle on the rider's line
  const hull = { x: 120, z: 0.45, heading: 0, speed: 0, len: 4.6, wid: 1.8 };
  const w = world(PATH(), [0], { parked: [hull] });
  let least = 99, widest = 0;
  w.step(50, () => {
    // distance from the rider to the car's body (an oriented box, long axis along z)
    const dx = Math.max(0, Math.abs(w.r.x - hull.x) - hull.wid / 2), dz = Math.max(0, Math.abs(w.r.z - hull.z) - hull.len / 2);
    least = Math.min(least, Math.hypot(dx, dz));
    widest = Math.max(widest, Math.abs(w.r.shift));
  });
  assert.ok(w.r.x > 180, 'past it: ' + w.r.x);
  assert.ok(least > 0.25, 'without touching it: ' + least);
  assert.ok(widest > 1.5, 'by leaving the path: ' + widest);
  assert.ok(Math.abs(w.r.shift) < 0.05, 'and back on it afterwards');
  assert.equal(w.cy.stats.late, 0);
  // a car parked BESIDE the path changes nothing
  const beside = { x: 120, z: 3.2, heading: Math.PI / 2, speed: 0, len: 4.6, wid: 1.8 };
  const w2 = world(PATH(), [0], { parked: [beside] });
  let moved = 0;
  w2.step(40, () => { moved = Math.max(moved, Math.abs(w2.r.shift)); });
  assert.ok(moved < 0.01 && Math.abs(w2.lag()) < 0.05, 'nobody swerves for a car that is not in the way: ' + moved);
});

test('at a kerb: wait for the gap, tell the drivers while on the asphalt, do not wait for ever', () => {
  const ways = [way('cycleway', [[0, 0], [300, 0]]), way('secondary', [[150, -100], [150, 100]], { d: 1, w: 8 })];
  let busy = true, asked = [];
  const traffic = { cars: new Set(), threatens: (cx, cz, hw, need, stops) => { asked.push({ cx, hw, stops }); return busy; } };
  const peds = { peds: [], crossers: [] };
  const w = world(ways, [0], { traffic, peds });
  assert.equal(w.plan.cross.length, 1);
  const c = w.plan.cross[0];
  w.step(40);
  assert.ok(w.r.v === 0 && w.r.arc < c.a0 && w.r.arc > c.a0 - 2.5, 'standing at the kerb: ' + (c.a0 - w.r.arc));
  assert.ok(asked.length > 10 && Math.abs(asked[0].cx - 150) < 0.5 && asked[0].stops === false, 'having asked for a gap on that road');
  assert.equal(peds.crossers.length, 0, 'waiting where there is no zebra is their own business');
  busy = false;
  let told = 0, must = true;
  w.step(8, () => { for (const o of peds.crossers) { told++; must = must && o.must && Math.abs(o.cx - 150) < 0.5; } });
  assert.ok(w.r.arc > c.a1, 'across');
  assert.ok(told > 30 && must, 'and every driver was told while they were on the road: ' + told);
  // a road that never clears: after a quarter of a minute they go anyway
  const w2 = world(ways.map((r) => way(r.t, r.p, r)), [0], { traffic: { cars: new Set(), threatens: () => true }, peds: { peds: [], crossers: [] } });
  w2.step(70);
  assert.ok(w2.r.arc > w2.plan.cross[0].a1, 'nobody grows roots at a kerb');
});

test('a red light is in the plan: they stand at it, and ride on green', () => {
  const ways = [way('cycleway', [[0, 0], [300, 0]]), way('secondary', [[150, -100], [150, 100]], { d: 1, w: 8 })];
  const traffic = { cars: new Set(), threatens: () => false, walkWait: (x, z, rdx, rdz, t) => Math.max(0, T0 + 50 - t) };
  const w = world(ways, [0], { traffic });
  const c = w.plan.cross[0];
  assert.equal(c.sig, true);
  w.step(45);
  assert.ok(w.r.v === 0 && Math.abs(w.r.arc - c.a0) < 0.05 && w.r.stand > 0.99, 'standing at the line on red');
  assert.ok(Math.abs(w.lag()) < 0.05, 'exactly where every other client has them');
  w.step(12);
  assert.ok(w.r.arc > c.a1, 'and across on green');
});

test('a faster rider goes round a slower one, and two at one red light do not ride off as one', () => {
  // the first rider at 6.5 m/s, the second at 4 with eight seconds' start
  const w = world(PATH(), [0], { v0: 6.5, second: { v0: 4, head: 8 } });
  assert.ok(w.r2.x > w.r.x + 25);
  let closest = 99, passedAt = -1;
  w.step(40, (t) => {
    const d = Math.hypot(w.r.x - w.r2.x, w.r.z - w.r2.z);
    if (d < closest) closest = d;
    if (passedAt < 0 && w.r.x > w.r2.x + 3) passedAt = t;
  });
  assert.ok(passedAt > 0, 'the faster one got past');
  assert.ok(closest > 0.75, 'with room between the handlebars: ' + closest);
  assert.ok(Math.abs(w.r.shift) < 0.02 && w.lag() < 0.5, 'and is back on the line and on the plan');
  // lights that hold BOTH at the same kerb, then let them go at the same second
  const ways = [way('cycleway', [[0, 0], [300, 0]]), way('secondary', [[150, -100], [150, 100]], { d: 1, w: 8 })];
  const traffic = { cars: new Set(), threatens: () => false, walkWait: (x, z, rdx, rdz, t) => Math.max(0, T0 + 60 - t) };
  const g = world(ways, [0], { traffic, v0: 5, second: { v0: 5.2, head: 6 } });
  let least = 99;
  g.step(85, () => { least = Math.min(least, Math.hypot(g.r.x - g.r2.x, g.r.z - g.r2.z)); });
  assert.ok(g.r.x > 200 && g.r2.x > 200, 'both across');
  assert.ok(least > 0.7, 'and never one bicycle: ' + least);
});

// ---- cars ------------------------------------------------------------------------

test('knocked off by the player: the crowd takes the body, the bicycle falls', () => {
  const w = world(PATH(), [0], { realPeds: true });
  const hits = [], kills = [];
  w.peds.onPedHit = (p, v) => hits.push([p, v]);
  w.peds.onPedKilled = (p) => kills.push(p);
  w.step(4);
  // the player's car from behind at 15 m/s
  const car = { x: w.r.x - 2, z: w.r.z, heading: -Math.PI / 2, speed: 15, len: 4.6, wid: 1.8 };
  w.setCar(car);
  w.step(1 / 30);
  assert.equal(w.cy.riders.length, 0, 'off the bike');
  assert.equal(w.cy.stats.knocked, 1);
  assert.equal(w.cy.wrecks.length, 1);
  assert.equal(w.s.held, 1, 'the slot stays empty: nobody rides out of thin air over the wreck');
  assert.equal(w.peds.peds.length, 1, 'and is the crowd\'s body now');
  const p = w.peds.peds[0];
  assert.equal(p.state, 'rag');
  assert.ok(hits.length === 1 && hits[0][0] === p && hits[0][1] >= 15 && p.by === car, 'the hook says whose car it was');
  assert.equal(kills.length, 1, 'at that speed it is fatal (the crowd\'s own rule)');
  assert.equal(p.mesh.rotation.order, 'XYZ', 'in the crowd\'s own conventions');
  w.setCar(null);
  // the crowd's ragdoll runs it to rest; the bicycle slides and lies down
  w.step(8, () => {
    for (const q of [p.x, p.z, p.mesh.position.y, p.mesh.rotation.x]) assert.ok(Number.isFinite(q));
  });
  assert.equal(p.state, 'dead');
  const wr = w.cy.wrecks[0];
  assert.ok(Math.abs(Math.abs(wr.roll) - 1.43) < 0.02 && Math.hypot(wr.vx, wr.vz) < 0.06, 'the bicycle is on its side and still');
  assert.ok(wr.x > 20, 'having slid on from where it was hit');
  assert.equal(w.cy.fleet.count, 1, 'and is still drawn');
});

test('a slow knock: they get up and walk away along the path', () => {
  const w = world(PATH(), [0], { realPeds: true });
  w.step(4);
  const car = { x: w.r.x - 2.2, z: w.r.z, heading: -Math.PI / 2, speed: 9.5, len: 4.6, wid: 1.8 };
  // (9.5 against a rider doing 5: closing at 4.5; the CAR's speed decides the injury, and under 7 nobody dies…)
  car.speed = 6.9;
  w.setCar(car);
  w.step(0.2);
  assert.equal(w.cy.stats.knocked, 1);
  w.setCar(null);
  const p = w.peds.peds[0];
  assert.equal(p.dead, false);
  let states = new Set();
  w.step(14, () => { states.add(p.state); for (const q of [p.x, p.z, p.mesh.position.y]) assert.ok(Number.isFinite(q)); });
  assert.ok(states.has('down') && states.has('walk'), 'down, then up: ' + [...states]);
  assert.ok(Math.abs(p.z) < 3, 'and back on the line of the path: ' + p.z);
});

test('the traffic: a car passing at the kerb is not a collision, a car driving into them is', () => {
  const st = way('residential', [[0, 0], [400, 0]], { d: 1, w: 6, ow: 1 });
  const mk = (car) => world([way(st.t, st.p, st)], [0], { traffic: { cars: new Set([car]), threatens: () => false }, realPeds: true });
  // in its lane (js/traffic.js: flank half a metre off the kerb), overtaking at 13 m/s
  const pass = { x: -30, z: 3 - 0.5 - 0.9, heading: -Math.PI / 2, speed: 13, len: 4.6, wid: 1.8 };
  const w = mk(pass);
  w.step(12, () => { pass.x += 13 / 30; });
  assert.ok(pass.x > w.r.x + 20, 'the car went by');
  assert.equal(w.cy.stats.knocked, 0, 'and nobody was knocked off');
  assert.equal(w.cy.riders.length, 1);
  // a lorry in the same lane is wider, and its flank is where the car's was
  const lorry = { x: -30, z: 3 - 0.5 - 1.2, heading: -Math.PI / 2, speed: 11, len: 8, wid: 2.4 };
  const wl = mk(lorry);
  wl.step(14, () => { lorry.x += 11 / 30; });
  assert.equal(wl.cy.stats.knocked, 0, 'nor by a lorry');
  // nose first, on the rider's own line
  const ram = { x: -30, z: 3 - 0.25, heading: -Math.PI / 2, speed: 13, len: 4.6, wid: 1.8 };
  const w2 = mk(ram);
  w2.step(10, () => { ram.x += 13 / 30; });
  assert.equal(w2.cy.stats.knocked, 1, 'that one is a collision');
  // …and one keeping pace behind is not
  const pace = { x: -8, z: 3 - 0.25, heading: -Math.PI / 2, speed: 5, len: 4.6, wid: 1.8 };
  const w3 = mk(pace);
  w3.step(6, () => { pace.x = w3.r.x - 3.2; });
  assert.equal(w3.cy.stats.knocked, 0);
});

test('in the lane the traffic is told, at the kerb it is not', () => {
  const st = way('residential', [[0, 0], [200, 0], [400, 0]], { d: 1, w: 6, ow: 1 });
  const cross = way('tertiary', [[200, -80], [200, 0], [200, 80]], { d: 1, w: 8 });
  const city = [st, cross];
  const w = world(city, [0], { traffic: { cars: new Set(), threatens: () => false } });
  const list = [];
  let atKerb = 0, inJunction = 0;
  w.step(70, () => {
    list.length = 0; w.cy.blockInto(list);
    if (w.r.x > 60 && w.r.x < 150) atKerb += list.length;
    if (w.r.x > 192 && w.r.x < 204) { inJunction += list.length; if (list.length) assert.ok(Math.abs(list[0].x - w.r.x) < 0.01 && list[0].half > 0.5); }
  });
  assert.ok(w.r.x > 300, 'rode the street: ' + w.r.x);
  assert.equal(atKerb, 0, 'a rider at the kerb edge is passed');
  assert.ok(inJunction > 20, 'a rider crossing a junction is a hull in the lane: ' + inJunction);
});

test('somebody coming the other way: not pulled out into, and never ridden through', () => {
  // A walker stands on the rider's line 150 m along a two-way path, and a
  // second rider comes the other way, timed (a second apart, case by case) to
  // be level with the walker just as the first would be pulling out round
  // them. Before riders looked at who was coming, four pairs in ten minutes
  // of the real Palackého passed through each other exactly like this.
  let nearest = 9, worstCase = 0, waited = 0;
  for (let head = 50; head <= 70; head += 1) {
    const ways = PATH();
    const peds = { peds: [walker(150, 0.45)], crossers: [] };
    const w = world(ways, [0], { peds });
    const wy = w.cy.net.ways.get(ways[0]);
    const back = buildPlan([{ w: wy, i0: 1, i1: 0 }], { v0: 5, t0: T0 - head, drive: w.cy.drive, sites: w.cy.sites, signalWait: null });
    const q = w.cy._attach({ ...w.s, key: 'test/9', seed: 99, plan: back, t0: back.t0, hint: { k: 0, s: 0 }, body: null }, w.now());
    let least = 9, vMin = 9;
    w.step(50, () => {
      const d = Math.hypot(w.r.x - q.x, w.r.z - q.z);
      if (d < least) least = d;
      if (w.r.x > 120 && w.r.x < 150 && w.r.v < vMin) vMin = w.r.v;
      assert.ok(Math.hypot(w.r.x - 150, w.r.z - 0.45) > 0.6, 'nor through the walker');
    });
    if (least < nearest) { nearest = least; worstCase = head; }
    if (vMin < 0.6) waited++;
    assert.ok(w.r.x > 200 && q.x < 100, `both got past (head ${head}): ${w.r.x.toFixed(0)}, ${q.x.toFixed(0)}`);
    assert.ok(Math.abs(q.z + 0.45) < 0.5, 'the one coming kept to their own side: ' + q.z);
  }
  assert.ok(nearest > 0.6, `never through each other: ${nearest.toFixed(2)} m apart at the nearest (set off ${worstCase} s before)`);
  assert.ok(waited >= 1, 'and at least once the first rider held back behind the walker to let them by');
});
