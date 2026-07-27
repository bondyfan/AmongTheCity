// ---------------------------------------------------------------------------
// traffic v9: NOTHING APPEARS OR DISAPPEARS WHILE YOU ARE LOOKING AT IT.
//
// The user's report was "cars just show up and vanish out of nowhere". These
// tests pin the property that answers it, and — more importantly — they pin
// the thing that property could easily have broken on its way in: the shared
// world. A deferral that is invisible to the schedule is a cosmetic fix; a
// deferral that leaks into the schedule is a co-op desync, and the difference
// is not something you can see by reading the diff.
//
// v9.1 narrows exactly one of these, on purpose and with numbers behind it:
// "inside the cone" became "inside the cone AND within NOTICE_R". A car that
// is minted inside your fog wall and stays in your cone for its whole trip —
// on a motorway, all of the traffic ahead of you — belonged to neither of the
// two places a mesh was allowed to appear, so it never got one, and the road
// ahead ran at 30 % of v8's population. The floor under the deferral is what
// this file now pins: a mesh may fade in at 300 m in the haze, never at 100 m.
// See NOTICE_R in js/traffic.js for the sweep that chose the radius.
//
// What is checked here, in order:
//   1. the viewer API itself, including every fallback
//   2. no mesh is created or destroyed where the player would READ it
//   3. a generation rollover does NOT delete a car you are watching
//   4. …and the slot it vacates is refilled on time anyway
//   5. two clients, one watching and one not, agree on every car — the
//      deferral is provably local
//   6. ghosts are bounded, and have no shared identity
//   7. the schedule drives at a city speed rather than a crawl
//   8. the density knob is not saturated at the top of its range
// ---------------------------------------------------------------------------
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { Traffic, VIEW_TUNING } = await import('../js/traffic.js');
// imported rather than transcribed: a literal 39 in here silently stopped
// testing anything the day GHOST_MAX moved
const { NOTICE_R, GHOST_MAX } = VIEW_TUNING;

// A grid town wide enough that the attach band (~630 m) has road on it in
// every direction, and that a car can drive a full trip without running off
// the edge of the world.
const HALF = 1800, STEP = 120;
function gridRoads() {
  const roads = [];
  const n = Math.floor(HALF / STEP);
  const line = (fn) => { const p = []; for (let j = -n; j <= n; j++) p.push(fn(j * STEP)); return p; };
  for (let i = -n; i <= n; i++) {
    const x = i * STEP, z = i * STEP;
    roads.push({ t: (i % 3 === 0) ? 'primary' : 'residential', d: 1, w: 9, v: 50, p: line((zz) => [x, zz]) });
    roads.push({ t: (i % 4 === 0) ? 'secondary' : 'residential', d: 1, w: 9, v: 50, p: line((xx) => [xx, z]) });
  }
  return roads;
}

function stubVehicles() {
  return {
    scene: { add() {}, remove() {} },
    cars: new Set(),
    add(kind, x, z, heading, color) {
      const car = { mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} },
        wheels: [], x, z, heading, speed: 0, steer: 0, kind, color,
        len: 4.6, wid: 1.8, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car);
      return car;
    },
    remove(car) { this.cars.delete(car); },
  };
}

const T0 = 17_900_000;

// One client, optionally watching. `look` returns {x,z,dirX,dirZ} per second of
// wall time; null means no camera at all (the v8 fallback path).
function client({ maxCars = 90 } = {}) {
  const t = new Traffic({ roads: gridRoads(), signals: [], onTileLoaded() {} }, stubVehicles());
  let now = T0;
  t.clock = () => now;
  t.maxCars = maxCars;
  // every moment a mesh came into or went out of existence, with the answer
  // _visible() would have given for that spot at that instant
  const events = [];
  // APPEARING and DISAPPEARING are held to different standards, and that
  // asymmetry is the whole of v9.1. A car that vanishes was already on screen
  // and being tracked by the eye, so any distance inside the fog wall counts.
  // A car that fades in has to be found first: inside NOTICE_R that is easy
  // and forbidden, out at 300 m in the haze it is not what anyone reported.
  const readable = (x, z) => t._visible(x, z)
    && (x - t._view.x) ** 2 + (z - t._view.z) ** 2 < NOTICE_R * NOTICE_R;
  const oAttach = t._attach.bind(t);
  t._attach = (p, wt, pose) => {
    oAttach(p, wt, pose);
    events.push({ kind: 'attach', x: p.sx, z: p.sz, seen: readable(p.sx, p.sz), ghost: 0, expired: 0 });
  };
  const oDetach = t._detach.bind(t);
  t._detach = (p) => {
    const had = !!p.car;
    const x = p.sx, z = p.sz;
    const expired = p.ghost && p.ghostT > GHOST_MAX - 1 ? 1 : 0;
    oDetach(p);
    if (had) events.push({ kind: 'detach', x, z, seen: t._visible(x, z), ghost: p.ghost ? 1 : 0, expired });
  };
  return {
    t, events,
    at: (s) => { now = T0 + s; },
    // `each(s, q)` is called after every step. It exists because run() restarts
    // its clock at T0 on every call — chopping a drive into slices to sample
    // between them teleports the player back to the start line each time.
    run(secs, hz, pos, look, each) {
      const n = Math.round(secs * hz);
      for (let i = 1; i <= n; i++) {
        const s = i / hz;
        now = T0 + s;
        const q = typeof pos === 'function' ? pos(s) : pos;
        if (look) t.setViewer({ ...look(s), fovRad: 1.19, aspect: 1, fogFar: 634 });
        t.update(1 / hz, q, null);
        if (each) each(s, q);
      }
    },
    // events that happened while the recorder was armed, i.e. after warmup
    arm() { events.length = 0; },
  };
}

const stand = { x: 0, y: 0, z: 0 };
const lookEast = () => ({ x: 0, z: 0, dirX: 1, dirZ: 0 });

// ---------------------------------------------------------------------------
// 1. the API and its fallbacks
// ---------------------------------------------------------------------------

test('without a viewer nothing is visible — v8 semantics, exactly', () => {
  const A = client();
  A.run(5, 30, stand);
  assert.equal(A.t._visible(0, 0), false, 'no camera must mean no opinion');
  assert.equal(A.t._visible(1e6, 1e6), false);
  // …and the attach radius stays the v8 ring, so the sweep costs what it did
  assert.equal(A.t._attachR(), 520);
});

test('setViewer reads a three.js camera, an explicit direction, or nothing', () => {
  const A = client();
  // explicit form
  A.t.setViewer({ x: 0, z: 0, dirX: 1, dirZ: 0, fovRad: 1.19, aspect: 1, fogFar: 634 });
  assert.ok(A.t._visible(200, 0), 'straight ahead and close must be visible');
  assert.equal(A.t._visible(-200, 0), false, 'directly behind must not be');
  assert.equal(A.t._visible(4000, 0), false, 'past the fog wall must not be');
  assert.ok(A.t._visible(-10, 0), 'a car in your lap is visible whatever the yaw');
  // fogFar is turned into a noticeability distance, not used raw
  assert.ok(A.t._attachR() > 520 && A.t._attachR() < 760);

  // camera form — a duck-typed PerspectiveCamera
  const cam = {
    position: { x: 100, y: 2, z: 0 }, fov: 68, aspect: 1,
    getWorldDirection(v) { v.set(0, 0, -1); return v; },
  };
  A.t.setViewer({ camera: cam, fogFar: 634 });
  assert.ok(A.t._visible(100, -200), 'the camera looks down -z');
  assert.equal(A.t._visible(100, 200), false);

  // rubbish in, fallback out — never a throw and never a half-built viewer
  A.t.setViewer({ x: 0, z: 0, dirX: 0, dirZ: 0 });
  assert.equal(A.t._visible(10, 0), false, 'a zero direction is not a direction');
  A.t.setViewer(null);
  assert.equal(A.t._visible(10, 0), false);
});

test('update() forwards its 4th argument, and three-argument callers keep theirs', () => {
  const A = client();
  A.t.update(1 / 30, stand, null, { x: 0, z: 0, dirX: 1, dirZ: 0, fogFar: 634 });
  assert.ok(A.t._visible(200, 0));
  A.t.update(1 / 30, stand, null);              // v8 call shape: must not clear it
  assert.ok(A.t._visible(200, 0), 'a three-argument update wiped the viewer');
  A.t.update(1 / 30, stand, null, null);        // explicit null: must clear it
  assert.equal(A.t._visible(200, 0), false);
});

// ---------------------------------------------------------------------------
// 2. the property the user asked for
// ---------------------------------------------------------------------------

test('no car is ever given or denied a mesh where the player would read it', () => {
  const A = client({ maxCars: 240 });
  A.run(60, 20, stand, lookEast);              // settle
  A.arm();
  A.run(240, 20, stand, lookEast);
  const seen = A.events.filter((e) => e.seen && !e.expired);
  assert.equal(seen.length, 0,
    `${seen.length} meshes came or went in plain sight, e.g. ${JSON.stringify(seen[0])}`);
  assert.ok(A.events.length > 60, `nothing happened at all (${A.events.length} events) — test is blind`);
});

test('…and while driving, which is when v8 popped the hardest', () => {
  const A = client({ maxCars: 240 });
  const V = 50 / 3.6;
  const pos = (s) => ({ x: V * s, y: 0, z: 0 });
  const look = () => ({ x: 0, z: 0, dirX: 1, dirZ: 0 });
  const drive = (s) => ({ x: V * s, z: 0, dirX: 1, dirZ: 0 });
  A.run(60, 20, pos, drive);
  A.arm();
  A.run(180, 20, pos, drive);
  const seen = A.events.filter((e) => e.seen && !e.expired);
  assert.equal(seen.length, 0, `${seen.length} visible pops while driving`);
  assert.ok(A.events.length > 100, 'no traffic churn to speak of — test is blind');
  void look;
});

test('…and while the player sweeps the camera around, which is the hard case', () => {
  const A = client({ maxCars: 240 });
  const look = (s) => ({ x: 0, z: 0, dirX: Math.cos(0.5 * s), dirZ: Math.sin(0.5 * s) });
  A.run(60, 20, stand, look);
  A.arm();
  A.run(180, 20, stand, look);
  const seen = A.events.filter((e) => e.seen && !e.expired);
  assert.equal(seen.length, 0, `${seen.length} pops while panning: ${JSON.stringify(seen.slice(0, 3))}`);
});

// The other half of the same property, and the one v9.0 shipped without: a
// road that is silent because nothing is allowed to appear on it is not a fix.
// The census is the one the pop harnesses use — of the schedules whose NOMINAL
// pose is in the forward cone within 300 m, what share has a body. Measured on
// this fixture and this circuit: v9.0 30 %, v9.1 47 %. The bar is 40 % — high
// enough that reverting the floor fails it, low enough not to be a thermometer
// for the fixture's own traffic density.
test('…and the road the player is driving down is not empty', () => {
  const A = client({ maxCars: 240 });
  // a 700 m circuit rather than a straight line: the grid fixture is only
  // 1800 m to a side, and a 50 km/h straight run drives off the end of the
  // world in 130 s, which measures the edge of the fixture and not the gate
  const V = 50 / 3.6, R = 700;
  const pos = (s) => ({ x: R * Math.cos(V * s / R), y: 0, z: R * Math.sin(V * s / R) });
  const drive = (s) => {
    const a = V * s / R;
    return { x: R * Math.cos(a), z: R * Math.sin(a), dirX: -Math.sin(a), dirZ: Math.cos(a) };
  };
  let sched = 0, bodied = 0, n = 0;
  A.run(200, 20, pos, drive, (s, at) => {
    if (s < 60 || ++n % 60) return;              // 3 s apart, after the ring is warm
    const v = A.t._view;
    for (const p of A.t._pool.values()) {
      let q = null;
      try { q = p.route ? A.t._nomPose(p, A.t._wt) : null; } catch { continue; }
      if (!q) continue;
      const dx = q.x - at.x, dz = q.z - at.z, d = Math.hypot(dx, dz) || 1e-9;
      if (d > 300 || (dx * v.dx + dz * v.dz) / d < 0.5) continue;   // ±60° of straight ahead
      sched++; if (p.car) bodied++;
    }
  });
  assert.ok(sched > 200, `only ${sched} samples — the fixture stopped producing traffic`);
  assert.ok(bodied / sched > 0.4,
    `only ${(100 * bodied / sched).toFixed(0)} % of the cars ahead of the player have a body`);
});

// ---------------------------------------------------------------------------
// 3+4. the generation rollover, which is what actually kills cars
// ---------------------------------------------------------------------------

test('a generation rollover does not delete the car you are watching', () => {
  const A = client({ maxCars: 240 });
  A.run(90, 20, stand, lookEast);
  // Force the issue: retire every car that currently has a mesh, as the
  // rollover would. Visible ones must survive it with their meshes.
  const watched = [...A.t.cars].filter((c) => !c.ai.ghost && A.t._visible(c.ai.sx, c.ai.sz));
  assert.ok(watched.length > 2, `nothing in view to test with (${watched.length})`);
  for (const c of watched) A.t._retire(c.ai);
  for (const c of watched) {
    assert.ok(c.ai, 'a watched car lost its brain to the reaper');
    assert.ok(A.t.cars.has(c), 'a watched car lost its mesh to the reaper');
    assert.equal(c.ai.ghost, 1, 'it should have become a ghost');
  }
  // and it must still be DRIVING, not frozen at the kerb
  const before = watched.map((c) => c.ai.sR);
  A.run(6, 20, stand, lookEast);
  // not all of them: a ghost can be third in a queue at a red, or have hit a
  // dead end it cannot extend past. The point is that they DRIVE rather than
  // freeze, not that every last one gets clear inside six seconds.
  const moved = watched.filter((c, i) => c.ai && c.ai.sR > before[i] + 1).length;
  assert.ok(moved >= watched.length * 0.7, `only ${moved}/${watched.length} ghosts drove off`);
});

test('the vacated slot is refilled on time — the ghost is not a tombstone', () => {
  const A = client({ maxCars: 240 });
  A.run(90, 20, stand, lookEast);
  // …a live one: this.cars holds ghosts too, and a ghost has no slot to vacate
  const victim = [...A.t.cars].find((c) => !c.ai.ghost && A.t._visible(c.ai.sx, c.ai.sz));
  assert.ok(victim, 'nothing in view to retire');
  const key = victim.ai.key;
  assert.ok(A.t._pool.has(key));
  A.t._retire(victim.ai);
  assert.equal(A.t._pool.has(key), false, 'the slot must be released the same instant');
  assert.equal(A.t.cars.has(victim), true, '…without the car going anywhere');
  // the following sweeps mint the slot's next occupant (SCAN_BUDGET spreads a
  // burst of them over a few ticks, so give it more than one)
  A.run(4, 20, stand, lookEast);
  assert.ok(A.t._pool.has(key), 'the schedule left a hole where the ghost used to be');
  assert.notEqual(A.t._pool.get(key), victim.ai);
});

test('a car that finishes its route in your face drives on instead of blinking out', () => {
  const A = client({ maxCars: 240 });
  A.run(90, 20, stand, lookEast);
  // pick a watched car and hand it an arrival
  const c = [...A.t.cars].find((x) => !x.ai.ghost && A.t._visible(x.ai.sx, x.ai.sz));
  assert.ok(c, 'nothing in view');
  const p = c.ai;
  p.dead = 1;                                   // what _drive's arrival block does
  A.run(1, 20, stand, lookEast);
  assert.ok(A.t.cars.has(c), 'an arriving car was deleted in plain sight');
  assert.equal(p.ghost, 1);
  const s0 = p.sR;
  A.run(8, 20, stand, lookEast);
  assert.ok(p.sR > s0 + 2, 'it stopped dead instead of driving away');
});

// ---------------------------------------------------------------------------
// 5. THE ONE THAT MATTERS FOR CO-OP: the deferral is local, and only local
// ---------------------------------------------------------------------------

test('a client that is looking and one that is not agree on every single car', () => {
  // Same place, same clock, same settings. A has a camera pointed east and is
  // therefore deferring attachments and ghosting retirements all over the
  // place; B has never heard of a camera. If any of that reached the schedule,
  // their snapshots diverge — which is exactly the desync a naive tombstone
  // implementation would have shipped.
  const A = client({ maxCars: 240 });
  const B = client({ maxCars: 240 });
  A.run(150, 20, stand, lookEast);
  B.run(150, 20, stand);
  A.at(150); B.at(150);
  const sa = A.t.snapshot(0, 0, 400), sb = B.t.snapshot(0, 0, 400);
  assert.ok(sa.length > 8, `too few cars to be a test (${sa.length})`);
  assert.deepEqual(sa.map((o) => o.key), sb.map((o) => o.key),
    'the viewer changed WHICH cars the shared world contains');
  let worst = 0;
  for (let i = 0; i < sa.length; i++) {
    assert.equal(sa[i].seed, sb[i].seed);
    assert.equal(sa[i].gen, sb[i].gen);
    worst = Math.max(worst, Math.abs(sa[i].arc - sb[i].arc));
  }
  assert.ok(worst < 1e-9, `the viewer moved the schedule by ${worst} m`);
});

test('two clients looking in opposite directions still share the schedule', () => {
  const A = client({ maxCars: 240 });
  const B = client({ maxCars: 240 });
  A.run(150, 20, stand, () => ({ x: 0, z: 0, dirX: 1, dirZ: 0 }));
  B.run(150, 20, stand, () => ({ x: 0, z: 0, dirX: -1, dirZ: 0 }));
  A.at(150); B.at(150);
  const sa = A.t.snapshot(0, 0, 400), sb = B.t.snapshot(0, 0, 400);
  assert.ok(sa.length > 8);
  assert.deepEqual(sa.map((o) => o.key), sb.map((o) => o.key));
  for (let i = 0; i < sa.length; i++) assert.ok(Math.abs(sa[i].arc - sb[i].arc) < 1e-9);
});

// ---------------------------------------------------------------------------
// 6. ghosts stay in their box
// ---------------------------------------------------------------------------

test('ghosts never enter the shared world and never pile up', () => {
  const A = client({ maxCars: 240 });
  A.run(240, 20, stand, lookEast);
  const snapKeys = new Set(A.t.snapshot(0, 0, 700).map((o) => o.key));
  for (const p of A.t._ghosts) {
    assert.equal(snapKeys.has(p.key), false, 'a ghost turned up in snapshot()');
    assert.equal(A.t._pool.has(p.key), false, 'a ghost is still holding a slot');
    assert.ok(p.key.includes('#g'), 'a ghost kept the live slot string as its id');
    assert.equal(A.t.slotKey(p.car), null, 'a ghost must not be broadcast as a slot');
  }
  assert.ok(A.t._ghosts.size < 25, `${A.t._ghosts.size} ghosts is a leak, not a deferral`);
  // and no ghost outlives its cap by a sweep or two
  for (const p of A.t._ghosts) assert.ok(p.ghostT <= GHOST_MAX + 1, `ghost lived ${p.ghostT}s`);
});

test('stealing a ghost does not broadcast a slot the peer would delete', () => {
  const A = client({ maxCars: 240 });
  A.run(120, 20, stand, lookEast);
  const c = [...A.t.cars].find((x) => !x.ai.ghost && A.t._visible(x.ai.sx, x.ai.sz));
  A.t._retire(c.ai);
  assert.equal(A.t.slotKey(c), null);
  A.t.steal(c);
  assert.equal(A.t._ghosts.has(c.ai ?? {}), false);
  assert.equal(A.t.cars.has(c), false);
});

// ---------------------------------------------------------------------------
// 7+8. the two regressions the critic left behind
// ---------------------------------------------------------------------------

test('the schedule drives at a city speed, not a walking pace', () => {
  // v8 crossed every polyline segment at the slower of its two corner caps and
  // then billed a separate ramp charge for the braking it had already paid
  // for. On the real graph that came out at 57 % of what the drivers wanted,
  // with the rendered cars only 2.5 m behind — i.e. the schedule, not the
  // driving layer, was the slow one.
  const A = client({ maxCars: 240 });
  A.run(120, 20, stand, lookEast);
  let v = 0, want = 0, n = 0;
  for (const car of A.t.cars) {
    const p = car.ai;
    if (!p || !p.edge || p.nwait > 0 || p.ndone) continue;
    v += A.t._nomV(p); want += p.edge.speed * p.vK; n++;
  }
  assert.ok(n > 8, `only ${n} cars to measure`);
  assert.ok(v / want > 0.72, `the schedule runs at ${(100 * v / want).toFixed(0)} % of desire`);
});

test('the rendered cars still track the schedule they were given', () => {
  // The speed fix would be a regression if it made the schedule faster than a
  // real car can drive: the lag would grow, cars would pin at LAG_MAX and get
  // dragged through obstacles. Lag is the check that says the two layers agree.
  const A = client({ maxCars: 240 });
  A.run(150, 20, stand, lookEast);
  const lags = [];
  for (const car of A.t.cars) {
    const p = car.ai;
    if (!p || p.ghost || !p.route) continue;
    lags.push(A.t._nomArc(p, A.t._wt) - p.sR);
  }
  lags.sort((a, b) => a - b);
  assert.ok(lags.length > 8);
  assert.ok(lags[lags.length >> 1] < 25, `median lag ${lags[lags.length >> 1].toFixed(1)} m`);
  assert.ok(lags[lags.length - 1] < 140, 'a car is pinned at the lag clamp');
});

test('the density knob is not saturated at the top of its own range', () => {
  // settings.traffic is 240 on medium AND high, and main.js multiplies it by a
  // time-of-day curve that peaks at 1.15 (08:00) and 1.45 (16:00). v8 clamped
  // _densK at 3 and capped every cell at SLOT_MAX regardless of density, so
  // 192, 276 and 348 requested cars all produced the same fleet.
  const fleet = (maxCars) => {
    const C = client({ maxCars });
    C.run(100, 20, stand, lookEast);
    return C.t.cars.size;
  };
  const noon = fleet(192), eight = fleet(276), four = fleet(348);
  assert.ok(eight > noon * 1.1, `08:00 (${eight}) is no busier than midday (${noon})`);
  assert.ok(four > eight * 1.1, `16:00 (${four}) is no busier than 08:00 (${eight})`);
});
