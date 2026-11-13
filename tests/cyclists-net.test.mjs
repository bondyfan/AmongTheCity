// ---- cyclists: the graph a bicycle follows, and the plan of one ride ---------
// js/cyclenet.js decides which ways are ridden and which turn is taken;
// js/cycleplan.js turns that into the line the wheels follow and a timeline.
// Both are pure, and both are shared: every co-op client has to get the same
// answer from the same map, whatever order its tiles arrived in.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { CycleNet, CLS, classOf } = await import('../js/cyclenet.js');
const { buildPlan, planAt, planPose, sideOf, inZone, _tuning } = await import('../js/cycleplan.js');
const { RoadIndex } = await import('../js/crowdsites.js');
const { town, way, T0 } = await import('./cyclists-fixture.mjs');

const legsOf = (legs) => legs.map((l) => l.w.wid + ':' + l.i0 + '>' + l.i1).join(' ');
const lenOf = (legs) => legs.reduce((a, l) => a + Math.abs(l.w.cum[l.i1] - l.w.cum[l.i0]), 0);

test('which ways a bicycle uses', () => {
  assert.equal(classOf({ t: 'cycleway', p: [[0, 0], [1, 0]] }), CLS.CYCLE);
  assert.equal(classOf({ t: 'path', s: 'asphalt', p: [[0, 0], [1, 0]] }), CLS.CYCLE, 'a sealed path is a shared path');
  assert.equal(classOf({ t: 'path', s: 'dirt', p: [[0, 0], [1, 0]] }), CLS.NONE, 'a forest path is not ridden');
  assert.equal(classOf({ t: 'path', p: [[0, 0], [1, 0]] }), CLS.FOOT);
  assert.equal(classOf({ t: 'residential', d: 1, p: [[0, 0], [1, 0]] }), CLS.STREET);
  assert.equal(classOf({ t: 'secondary', d: 1, p: [[0, 0], [1, 0]] }), CLS.NONE, 'main roads are crossed, not ridden');
  assert.equal(classOf({ t: 'steps', p: [[0, 0], [1, 0]] }), CLS.NONE);
  assert.equal(classOf({ t: 'footway', p: [[0, 0], [1, 0]] }), CLS.FOOT);
});

test('a route is the same whatever order the tiles arrived in', () => {
  const roads = town();
  const a = new CycleNet(), b = new CycleNet();
  a.add(roads);
  // the same town in three batches, backwards
  const third = Math.floor(roads.length / 3);
  b.add(roads.slice(2 * third).reverse()); b.add(roads.slice(third, 2 * third)); b.add(roads.slice(0, third).reverse());
  const start = roads.find((r) => r.t === 'cycleway' && r.p[0][0] === 0 && r.p[0][1] === 0);
  let differ = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const ra = a.route(seed, a.ways.get(start), 0, 1, 1200), rb = b.route(seed, b.ways.get(start), 0, 1, 1200);
    assert.ok(lenOf(ra) >= 1200, 'the grid goes on: a route reaches its length');
    assert.equal(legsOf(ra), legsOf(rb));
    if (seed > 1 && legsOf(ra) !== legsOf(a.route(1, a.ways.get(start), 0, 1, 1200))) differ++;
  }
  assert.ok(differ > 30, 'and different seeds take different turns');
});

test('a rider keeps to cycleways where there are cycleways', () => {
  const roads = town();
  const net = new CycleNet();
  net.add(roads);
  const start = roads.find((r) => r.t === 'cycleway' && r.p[0][0] === 0 && r.p[0][1] === -120);
  let street = 0, total = 0;
  for (let seed = 1; seed <= 60; seed++) {
    for (const l of net.route(seed, net.ways.get(start), 0, 1, 1500)) {
      const d = Math.abs(l.w.cum[l.i1] - l.w.cum[l.i0]);
      total += d;
      assert.notEqual(l.w.r.t, 'secondary');
      if (l.w.cls === CLS.STREET) street += d;
    }
  }
  assert.ok(street / total < 0.2, 'the street is there to connect, not to ride down: ' + (street / total).toFixed(2));
  assert.ok(street > 0, 'but it is taken sometimes');
});

test('one-way ways, and the kerb the cars are parked at', () => {
  const net = new CycleNet();
  const ow = way('cycleway', [[0, 0], [50, 0]], { ow: 1 });
  // a street people park along (js/kerbparking.js parkable): one direction has no kerb edge to ride
  const st = way('residential', [[50, 0], [150, 0]], { d: 1, w: 6 });
  net.add([ow, st]);
  assert.equal(net.rideable(net.ways.get(ow), 1), true);
  assert.equal(net.rideable(net.ways.get(ow), -1), false, 'not against a one-way');
  const w = net.ways.get(st);
  assert.ok(w.park === 1 || w.park === -1, 'a 100 m residential street has parked cars on one side');
  assert.equal(net.rideable(w, -w.park), false, 'the direction whose right-hand kerb they stand at is not ridden');
  assert.equal(net.rideable(w, w.park), true);
});

test('a footway is only a bridge, and a stub is not entered', () => {
  const net = new CycleNet();
  const a = way('cycleway', [[0, 0], [100, 0]]);
  const far = way('cycleway', [[130, 0], [400, 0]]);
  const bridge = way('footway', [[100, 0], [130, 0]]);
  const maze = way('footway', [[100, 0], [100, 300]]);          // goes off into an estate
  const stub = way('cycleway', [[100, 0], [100, -15]]);         // fifteen metres to a bike rack
  net.add([a, far, bridge, maze, stub]);
  assert.equal(net.leads(net.ways.get(bridge), 0, 1), true, 'thirty metres of footway to the next cycleway');
  assert.equal(net.leads(net.ways.get(maze), 0, 1), false, 'three hundred metres of footway to nowhere');
  assert.equal(net.leads(net.ways.get(stub), 0, 1), false);
  for (let seed = 1; seed <= 30; seed++) {
    const legs = net.route(seed, net.ways.get(a), 0, 1, 350);
    assert.deepEqual(legs.map((l) => l.w.r), [a, bridge, far], 'every rider takes the bridge and carries on');
  }
});

test('a rider turns round at most once', () => {
  const net = new CycleNet();
  const only = way('cycleway', [[0, 0], [200, 0], [400, 0]]);
  net.add([only]);
  const legs = net.route(7, net.ways.get(only), 1, 1, 5000);
  assert.equal(legs.length, 2, 'to the end and back: ' + legs.length);
  assert.ok(lenOf(legs) <= 600.001);
});

// ---- the plan -----------------------------------------------------------------

function straightNet() {
  const net = new CycleNet();
  const a = way('cycleway', [[0, 0], [200, 0]]);
  const b = way('cycleway', [[200, 0], [200, 200]]);
  const road = way('tertiary', [[100, -80], [100, 80]], { d: 1, w: 8 });   // crosses the first way at x = 100
  net.add([a, b, road]);
  const drive = new RoadIndex();
  drive.add(road);
  return { net, a, b, road, drive };
}

test('the line keeps right of the centreline, and rounds the corner', () => {
  const { net, a, b } = straightNet();
  const legs = [{ w: net.ways.get(a), i0: 0, i1: 1 }, { w: net.ways.get(b), i0: 0, i1: 1 }];
  const plan = buildPlan(legs, { v0: 5, t0: T0 });
  const off = sideOf(net.ways.get(a));
  assert.ok(off > 0.3 && off < 0.6);
  const P = {}, hint = { k: 0, s: 0 };
  planPose(plan, 50, hint, P);
  // heading east (+x): right of travel is +z (south)
  assert.ok(Math.abs(P.z - off) < 0.02 && Math.abs(P.dx - 1) < 1e-6, JSON.stringify(P));
  assert.equal(P.curv, 0);
  // the turn south at (200, 0) is a right turn: positive curvature, and no jump
  let maxCurv = 0, prev = null;
  for (let s = 180; s < 220; s += 0.25) {
    planPose(plan, s, hint, P);
    if (prev) assert.ok(Math.hypot(P.x - prev.x, P.z - prev.z) < 0.3, 'continuous at ' + s);
    prev = { x: P.x, z: P.z };
    if (P.curv > maxCurv) maxCurv = P.curv;
    assert.ok(P.curv > -0.02, 'never bends left on a right turn');
  }
  assert.ok(maxCurv > 0.2 && maxCurv < 1.2, 'a corner a bicycle can take: ' + maxCurv);
  // on the second way (heading south, +z) right of travel is -x
  planPose(plan, plan.len - 50, hint, P);
  assert.ok(Math.abs(P.x - (200 - off)) < 0.02 && P.dz > 0.999);
});

test('the timeline: never over the cruising speed, never an impossible brake', () => {
  const { net, a, b, drive } = straightNet();
  const legs = [{ w: net.ways.get(a), i0: 0, i1: 1 }, { w: net.ways.get(b), i0: 0, i1: 1 }];
  const plan = buildPlan(legs, { v0: 5.5, t0: T0, drive });
  const { T, S, V } = plan;
  assert.equal(T[0], T0);
  for (let i = 1; i < T.length; i++) {
    assert.ok(T[i] >= T[i - 1] && S[i] >= S[i - 1] - 1e-9, 'time and distance only go forward');
    assert.ok(V[i] <= 5.5 + 1e-9);
    const dt = T[i] - T[i - 1];
    if (dt > 1e-6) {
      const acc = (V[i] - V[i - 1]) / dt;
      assert.ok(acc <= _tuning.ACC + 1e-6 && acc >= -_tuning.BRK - 1e-6, 'acceleration ' + acc);
    }
  }
  // where the plan says they are moves no faster than they ride
  const N = {}, hint = { k: 0, s: 0 };
  let prev = 0;
  for (let t = T0; t < plan.tEnd; t += 0.1) {
    planAt(plan, t, hint, N);
    assert.ok(N.arc >= prev - 1e-9 && N.arc - prev <= 5.5 * 0.1 + 1e-6);
    prev = N.arc;
  }
  assert.ok(Math.abs(prev - plan.len) < 1, 'and reaches the end');
  // they slowed for the road and for the corner
  const vAt = (arc) => { for (let i = 1; i < S.length; i++) if (S[i] >= arc) return V[i]; return 0; };
  assert.equal(plan.cross.length, 1);
  const c = plan.cross[0];
  assert.ok(c.give && !c.sig && !c.zebra && Math.abs(c.cx - 100) < 0.5, JSON.stringify(c));
  assert.ok(c.a0 > 90 && c.a0 < 97 && c.a1 > 103 && c.a1 < 110, 'the crossing is the width of the road: ' + c.a0 + '..' + c.a1);
  assert.ok(vAt(c.a0) <= 2.2 + 1e-9, 'slow enough to look: ' + vAt(c.a0));
  assert.ok(vAt(198) < 3, 'and round the corner');
});

test('a red light stops them at the kerb, a green one does not', () => {
  const { net, a, drive } = straightNet();
  const legs = [{ w: net.ways.get(a), i0: 0, i1: 1 }];
  const run = (wait) => buildPlan(legs, { v0: 5, t0: T0, drive, signalWait: wait });
  // lights that are red until t = T0 + 40, then green
  const red = run((x, z, rdx, rdz, t) => Math.max(0, T0 + 40 - t));
  const green = run(() => 0);
  const none = run(() => null);
  assert.equal(red.cross[0].sig, true);
  assert.equal(none.cross[0].sig, false, 'null: no lights govern this spot');
  const a0 = red.cross[0].a0;
  let stoodFrom = -1, stoodTo = -1;
  for (let i = 0; i < red.T.length; i++) {
    if (red.V[i] === 0 && Math.abs(red.S[i] - a0) < 0.01) { if (stoodFrom < 0) stoodFrom = red.T[i]; stoodTo = red.T[i]; }
  }
  assert.ok(stoodFrom > 0, 'they stand at the kerb');
  assert.ok(stoodTo >= T0 + 40 && stoodTo < T0 + 42, 'until it turns: ' + (stoodTo - T0));
  assert.ok(stoodFrom < T0 + 40, 'having arrived on red');
  for (let i = 0; i < green.T.length; i++) assert.ok(green.V[i] > 0 || i === green.T.length - 1, 'on green nobody stops');
  assert.ok(green.tEnd < red.tEnd - 10);
  // and it is a function of the inputs: built twice, the same bits
  const again = run((x, z, rdx, rdz, t) => Math.max(0, T0 + 40 - t));
  assert.deepEqual(Array.from(again.T), Array.from(red.T));
  assert.deepEqual(Array.from(again.S), Array.from(red.S));
});

test('on a street: the kerb edge, and the lane through a junction', () => {
  const net = new CycleNet();
  const st = way('residential', [[0, 0], [100, 0], [200, 0]], { d: 1, w: 6, ow: 1 });   // one-way: nobody parks it shut
  const cross = way('tertiary', [[100, -60], [100, 0], [100, 60]], { d: 1, w: 8 });
  net.add([st, cross]);
  const drive = new RoadIndex();
  drive.add(st); drive.add(cross);
  const w = net.ways.get(st);
  const plan = buildPlan([{ w, i0: 0, i1: 1 }, { w, i0: 1, i1: 2 }], { v0: 5, t0: T0, drive });
  const P = {}, hint = { k: 0, s: 0 };
  planPose(plan, 40, hint, P);
  assert.ok(Math.abs(P.z - (3 - 0.25)) < 0.02, 'a quarter of a metre in from the kerb: ' + P.z);
  assert.equal(inZone(plan, 40), false, 'at the kerb the traffic passes');
  assert.equal(inZone(plan, 95), true, 'through the junction a rider is in the lane');
  assert.equal(inZone(plan, 150), false);
  assert.equal(plan.cross.length, 1, 'the bigger road is something to give way to');
  assert.ok(plan.cross[0].give && plan.cross[0].street);
});
