// ---- the ambulance service, on a road nobody has to stream ---------------
// The brief was one sentence — "taky tam musí jezdit i sanitky, když se někdy
// někomu stane, tak aby tam přijela sanitka" — and the first build satisfied
// the letter of it and none of the point: a van WAS dispatched, and it did not
// arrive. Two reasons, both visible only from inside a running city, and both
// the kind of thing a screenshot cannot show you:
//
//   1. _railNear scores a PLACE and not a DIRECTION. traffic.js holds the two
//      carriageways of a two-way street as separate directed edges that are
//      each other's `twin` (traffic.js:1549), so half of all crews woke up
//      pointing away from the scene. Measured in Pardubice: the range to the
//      casualty went 332 → 346 m over the first nine seconds before the
//      U-turn penalty in _pickNext finally let the van turn round.
//   2. A crew on blues drove at the posted limit + 12 %. Routed down a 4.8 m
//      side street — 20 km/h — that is 6.2 m/s, and 6.2 m/s over a 330 m
//      dispatch cannot beat GIVE_UP. The van turned for the hospital 250 m
//      short of the scene, every single time, and no test noticed because
//      there were no tests: the module had none.
//
// So this file is the road, and the assertions are about arriving. The graph
// is a straight two-way street with proper twins, which is the SMALLEST world
// in which either bug reproduces — a one-way stub would have hidden the first
// and a motorway would have hidden the second.
//
// three.js is not an npm package here, so the resolver hook is registered
// before ambulance.js is imported. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Ambulance } = await import('../js/ambulance.js');

// ---- the world ------------------------------------------------------------

// A straight road along +x at z = 0, cut into `n` edges of `seg` metres, each
// with the reverse twin traffic.js would have built. Three points per edge, not
// two: _railNear spawns a van at the edge's MIDDLE VERTEX, and a two-point edge
// has no middle — the van would be born in the junction at the far end, which
// is the one place traffic.js is careful never to put one.
function street({ x0 = -200, seg = 60, n = 18, speed = () => 13.9, w = 8 } = {}) {
  const N = [];
  for (let i = 0; i <= n; i++) N.push({ x: x0 + i * seg, z: 0, out: [] });
  const road = { w, br: 0, name: 'Testovací' };
  const mk = (a, b, eid) => {
    const dx = Math.sign(b.x - a.x);
    const mid = (a.x + b.x) / 2;
    const pts = [[a.x, 0], [mid, 0], [b.x, 0]];
    const half = seg / 2;
    return {
      a, b, pts, cum: [0, half, seg], len: seg, speed: speed(mid), oneway: false, road,
      off0: a.x, offSign: dx,
      fdx: dx, fdz: 0, ldx: dx, ldz: 0,
      vertAng: null, mx: mid, mz: 0, twin: null,
      sig: 0, sigD: 0, sigPh: 0, sigStop: 0, eid,
    };
  };
  const edges = [];
  for (let i = 0; i < n; i++) {
    const fwd = mk(N[i], N[i + 1], i * 2);
    const rev = mk(N[i + 1], N[i], i * 2 + 1);
    fwd.twin = rev; rev.twin = fwd;
    N[i].out.push(fwd);
    N[i + 1].out.push(rev);
    edges.push(fwd, rev);
  }
  return { edges, nodes: N };
}

// The three collaborators, each the smallest thing that answers what
// ambulance.js actually asks of it. `vehicles.add` hands back a car with a stub
// mesh on purpose: _fitLivery bails on a mesh with no .add, which is the
// documented headless path and keeps three.js's canvas out of `node --test`.
function rig({ speed = () => 13.9, hospital = { x: 4000, z: 0 } } = {}) {
  const { edges, nodes } = street({ speed });
  const built = [];
  const traffic = {
    edges,
    cars: new Set(),
    world: null,
    setSiren() {},
  };
  const vehicles = {
    add(kind, x, z, heading, color) {
      const car = {
        kind, x, z, y: 0, heading, speed: 0, steer: 0, color,
        mesh: { position: { set() {} }, rotation: { y: 0 } },
      };
      built.push(car);
      return car;
    },
    remove(car) { const i = built.indexOf(car); if (i >= 0) built.splice(i, 1); },
  };
  let t = 1000;
  const amb = new Ambulance({ traffic, vehicles, city: null, scene: null, peds: null, hospital });
  // The clock seam is a FIELD, not a constructor option — the same shape
  // traffic.js and police.js carry (traffic.js:1198, police.js:496), and it has
  // to be taken before the first update() or every absolute deadline in the
  // module is stamped against the wall clock and none of them ever expire. That
  // is not a hypothetical: the first draft of this file passed `clock` to the
  // constructor, the constructor ignored it, and the arrival test passed for
  // the wrong reason — the van's give-up deadline was ninety seconds after
  // whenever the machine happened to boot.
  amb.clock = () => t;
  return {
    amb, traffic, vehicles, edges, nodes, built,
    now: () => t,
    // One place that advances BOTH clocks, because a step that moves the van
    // without moving the deadline is how a give-up test passes for ever.
    step(dt, ctx) { t += dt; amb.update(dt, ctx ?? { x: 0, z: 0, car: null }); },
  };
}

const live = (amb) => amb.units.filter((u) => u.onCall);
const dScene = (u) => Math.hypot(u.x - u.sx, u.z - u.sz);
// The direction the van's rail carries it, at the arc it was born on.
function railDir(u) {
  const e = u.edge;
  return { dx: e.fdx, dz: e.fdz };
}

// ---- 1. pointing at it ----------------------------------------------------

test('a dispatched crew is born facing the scene, whichever side it spawns', () => {
  // Both directions, because a fixture that only ever tests one has a 50 %
  // chance of passing against the bug this exists to catch.
  for (const scene of [{ x: 100, z: 0 }, { x: 500, z: 0 }]) {
    const R = rig();
    assert.equal(R.amb.call(scene.x, scene.z), true, `no dispatch to ${scene.x}`);
    const u = live(R.amb)[0];
    assert.ok(u, 'dispatched, but no unit');
    const d = railDir(u);
    const toScene = Math.sign(scene.x - u.x);
    assert.equal(Math.sign(d.dx), toScene,
      `spawned at x=${u.x.toFixed(0)} driving ${d.dx > 0 ? '+x' : '-x'} `
      + `for a scene at x=${scene.x}`);
  }
});

test('the twin swap keeps the van on a real edge of the graph', () => {
  const R = rig();
  R.amb.call(100, 0);
  const u = live(R.amb)[0];
  assert.ok(R.edges.includes(u.edge), 'the chosen rail is not in traffic.edges');
  assert.ok(u.s >= 0 && u.s <= u.edge.len, `arc ${u.s} is off the edge`);
  // Born clear of both junctions — a van three metres from a node spends its
  // first step hopping edges instead of driving.
  assert.ok(u.s >= 3 && u.s <= u.edge.len - 3, `arc ${u.s} sits in a junction`);
});

// ---- 2. the floor under the blues -----------------------------------------

// 20 km/h everywhere west of x = 250 and a proper road east of it. This is the
// shape the bug had in Pardubice: a van cannot be BORN on a side street
// (RAIL_MIN_V rejects anything under 8 m/s), it gets ROUTED onto one, and a
// fixture with one speed limit end to end can never reproduce that.
const SIDE_ST = 5.5555;
const zoned = (mx) => (mx < 250 ? SIDE_ST : 13.9);

test('a crew on blues does not crawl once it is routed into a 20 km/h zone', () => {
  const R = rig({ speed: zoned });
  R.amb.call(100, 0);
  const u = live(R.amb)[0];
  assert.ok(u, 'no dispatch');
  let sawSlow = false, slowest = Infinity;
  for (let i = 0; i < 900; i++) {
    R.step(0.05, { x: 100, z: 25, car: null });
    // Only judge it where the sign is 20 and it is still going somewhere: the
    // pull-up at the far end brakes to zero on purpose.
    if (u.edge?.speed === SIDE_ST && u.mode === 2) {
      sawSlow = true;
      slowest = Math.min(slowest, u.speed);
    }
  }
  assert.ok(sawSlow, 'never reached the slow zone — the fixture, not the van');
  assert.ok(slowest > SIDE_ST * 1.12 + 1,
    `blues on and down to ${slowest.toFixed(1)} m/s on a 20 km/h street`);
  assert.ok(u.speed <= 27.001, `${u.speed.toFixed(1)} m/s is not an ambulance`);
});

test('an ambient van keeps to the limit — the floor is for the blues only', () => {
  const R = rig();
  // Past BOOT_GAP so _ambient mints one, with the player on the street so the
  // spawn ring has road in it.
  for (let i = 0; i < 1600; i++) R.step(0.05, { x: 300, z: 25, car: null });
  const idle = R.amb.units.filter((u) => !u.onCall);
  assert.ok(idle.length, 'no ambient van appeared in 80 s');
  for (const u of idle) {
    assert.ok(u.speed <= u.edge.speed * 0.95 + 0.01,
      `an ambient van is doing ${u.speed.toFixed(1)} m/s where the limit is ${u.edge.speed}`);
  }
});

// ---- 3. arriving ----------------------------------------------------------

test('a dispatched crew reaches the scene, and does it well inside the give-up', () => {
  const R = rig();
  const scene = { x: 100, z: 0 };
  assert.equal(R.amb.call(scene.x, scene.z), true);
  const u = live(R.amb)[0];
  const d0 = dScene(u);
  assert.ok(d0 > 250, `spawned only ${d0.toFixed(0)} m out — the trip is not a trip`);

  let t = 0, arrived = -1;
  // 20 Hz for 80 s: GIVE_UP is 90, so a run that needs the whole window has
  // already failed the thing this test is about.
  for (let i = 0; i < 1600 && arrived < 0; i++) {
    R.step(0.05, { x: 100, z: 25, car: null });
    t += 0.05;
    if (u.mode === 4) arrived = t;          // SCENE
  }
  assert.ok(arrived > 0,
    `never arrived: ${dScene(u).toFixed(0)} m short after ${t.toFixed(0)} s, mode ${u.mode}`);
  assert.ok(arrived < 60, `took ${arrived.toFixed(0)} s to cover ${d0.toFixed(0)} m`);
  assert.ok(dScene(u) < 20, `stopped ${dScene(u).toFixed(0)} m from the casualty`);
});

test('the trip is a trip and not an excursion — no wrong-way leg at the start', () => {
  const R = rig();
  R.amb.call(100, 0);
  const u = live(R.amb)[0];
  const d0 = dScene(u);
  let worst = 0;
  for (let i = 0; i < 200; i++) {          // the first ten seconds
    R.step(0.05, { x: 100, z: 25, car: null });
    worst = Math.max(worst, dScene(u) - d0);
  }
  // The lane offset alone moves the van a couple of metres sideways, so this is
  // not zero — but fourteen metres the wrong way is the bug.
  assert.ok(worst < 5, `drove ${worst.toFixed(1)} m AWAY from the scene first`);
  assert.ok(dScene(u) < d0 - 80, `only closed ${(d0 - dScene(u)).toFixed(0)} m in 10 s`);
});

test('a crew that arrives stands at the scene and then goes home', () => {
  const R = rig();
  R.amb.call(100, 0);
  const u = live(R.amb)[0];
  for (let i = 0; i < 1600 && u.mode !== 4; i++) R.step(0.05, { x: 100, z: 25, car: null });
  assert.equal(u.mode, 4, 'never got to the scene');
  assert.equal(u.speed, 0, 'standing at a scene at speed');
  // peds is null in this rig, which _casualtyNear reads as "somebody is down"
  // — the longer stand. It has to end anyway.
  for (let i = 0; i < 1200 && u.mode === 4; i++) R.step(0.05, { x: 100, z: 25, car: null });
  assert.equal(u.mode, 5, `stuck at the scene in mode ${u.mode}`);   // HOMEWARD
  assert.equal(u.tx, 4000, 'went home to somewhere that is not the hospital');
});

// ---- 4. the rules that keep it from being a parade ------------------------

test('a second casualty at the same corner joins the call rather than adding a van', () => {
  const R = rig();
  assert.equal(R.amb.call(100, 0), true);
  const n = live(R.amb).length;
  assert.equal(R.amb.call(120, 0), true, 'the merge was reported as a failure');
  assert.equal(live(R.amb).length, n, 'a second van came to the same scene');
});

test('call() refuses inside the cooldown and never throws without a world', () => {
  const R = rig();
  R.amb.call(100, 0);
  assert.equal(R.amb.call(900, 0), false, 'dispatched twice inside the cooldown');
  const bare = new Ambulance({});
  assert.doesNotThrow(() => bare.update(0.05, { x: 0, z: 0, car: null }));
  assert.doesNotThrow(() => bare.call(0, 0));
  assert.deepEqual(bare.units, []);
});
