// ---- shared pedestrians: the same crowd on every screen -------------------
// The user reported two things in one sentence — "i chodci se tak ruzně
// spawnují a je v tom bordel" — and they turned out to be two different bugs
// wearing one coat:
//
//   · POPPING. The old spawner allowed a citizen to materialise anywhere from
//     18 m outwards (`if (d < 18 || d > SPAWN_R) return false`), which is the
//     other side of the street, in full view, at full fog opacity. Measured on
//     the real region at 50 km/h: 148 bodies a minute appearing, 48 of them
//     inside the forward cone closer than 150 m.
//   · TWO CROWDS. Population was drawn at random from a shortlist rebuilt
//     around the LOCAL player, so two people in one co-op room walked through
//     two unrelated cities' worth of pedestrians.
//
// The fix is the one traffic.js already uses: population is a pure function of
// (cell, slot, generation, worldT), and every lifecycle decision is gated on
// whether the player could see it happen. These tests are that claim, stated
// as things two clients must agree about — plus one test that watches a
// simulated player drive through town and asserts that nothing, ever, appears
// or vanishes in front of him.
//
// three.js is not an npm package here, so the resolver hook is registered
// before pedestrians.js is imported. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Pedestrians } = await import('../js/pedestrians.js');

// ---------------------------------------------------------------------------
// fixture: a town of pavements. Crossing ways repeat the EXACT coordinate,
// which is what the junction index needs to weld them into one walk graph,
// exactly as OSM does. Every way is non-drivable, which is what makes it a
// footway as far as this module is concerned.
// ---------------------------------------------------------------------------
// One way per block, not one per street: OSM splits a pavement at every
// junction, and a module that files a way under the cell holding its midpoint
// would be fed a lie by a fixture of 1.8 km straight lines.
const HALF = 900, STEP = 60;
function gridPaths() {
  const roads = [];
  const n = Math.floor(HALF / STEP);
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j < n; j++) {
      const x = i * STEP, z = j * STEP;
      // vertical block, with a kink so the polyline has more than two nodes
      roads.push({ t: 'footway', d: 0, w: 2,
        p: [[x, z], [x + 1.5, z + STEP / 2], [x, z + STEP]] });
      // horizontal block
      roads.push({ t: (i + j) % 3 === 0 ? 'pedestrian' : 'footway', d: 0, w: 2,
        p: [[z, x], [z + STEP / 2, x - 1.5], [z + STEP, x]] });
    }
  }
  // a drivable street, to prove that drivable ways are never walked on
  const road = [];
  for (let j = -n; j <= n; j++) road.push([45, j * STEP]);
  roads.push({ t: 'residential', d: 1, w: 8, p: road });
  return roads;
}

// geo.js stamps _id on every feature before anything downstream sees it
function stamp(roads) {
  let id = 0;
  for (const r of roads) r._id = ++id;
  return roads;
}

const stubScene = { add() {}, remove() {} };

// A world epoch far from zero, like the real one (worldT() is ~1.8e7 and
// climbing): a schedule that only works near t = 0 would be a lie.
const T0 = 17_900_000;

// A camera the way main.js hands one over — the headless shape of
// setViewer(), which is byte for byte the shape traffic.js takes. 55° vertical
// fov at 16:9, chase cam 12 m behind the player, ground-preset fog wall 634 m.
const FOV_RAD = 55 * Math.PI / 180, ASPECT = 16 / 9;
const FOG_FAR = 634;
const VIEW_MARGIN = 0.42;      // must match pedestrians.js AND traffic.js
// The PROTECTED cone (screen half-angle + margin), not the screen itself: the
// tests below assert nothing pops inside the wider one, which is the stronger
// claim of the two and the one the module actually promises.
const TAN_HALF = Math.tan(Math.atan(Math.tan(FOV_RAD / 2) * ASPECT) + VIEW_MARGIN);
const NOTICE_R = 150;          // must match pedestrians.js — the radius inside
                               // which a citizen is big enough on screen to matter
const CAM_BACK = 12;

function viewAt(x, z, hx, hz) {
  return { x: x - hx * CAM_BACK, z: z - hz * CAM_BACK, dirX: hx, dirZ: hz,
    fovRad: FOV_RAD, aspect: ASPECT, fogFar: FOG_FAR };
}

// One client. `tiles` lets a test stream the region in whatever order it likes.
function client({ tiles = null, max = 34, t0 = T0 } = {}) {
  const roads = stamp(gridPaths());
  const groups = tiles ? tiles(roads) : [roads];
  let onTile = null;
  const city = { roads: groups[0], onTileLoaded(f) { onTile = f; } };
  const peds = new Pedestrians(stubScene, city);
  for (let i = 1; i < groups.length; i++) onTile({ roads: groups[i] });
  let now = t0, elapsed = 0;
  peds.clock = () => now;
  peds.max = max;
  return {
    peds,
    at: (s) => { now = T0 + s; },
    // Run `secs` of wall time at `hz` with the player at pos(t). `mode`:
    //   'view'  — hand over a real chase camera, so the visibility gate is live
    //   'blind' — a camera that can see nothing at all (hideR 0). Lifecycle
    //             decisions are then never deferred, which is what a test that
    //             wants the two clients to agree EXACTLY has to ask for: the
    //             one legitimate way they can differ is a retirement one of
    //             them is politely holding back because you are looking at it.
    run(secs, hz, pos, mode = null) {
      // Time is (base + i/hz), never an accumulator: two clients that reach
      // the same instant by different routes must reach the SAME DOUBLE, or
      // the test measures its own rounding instead of the simulation.
      const n = Math.round(secs * hz), base = elapsed;
      for (let i = 1; i <= n; i++) {
        now = t0 + base + i / hz;
        const q = typeof pos === 'function' ? pos(i / hz) : pos;
        if (mode === 'view') peds.setViewer(viewAt(q.x, q.z, q.hx ?? 1, q.hz ?? 0));
        else if (mode === 'blind') peds.setViewer({ x: q.x, z: q.z, dirX: 1, dirZ: 0, hideR: 0 });
        peds.update(1 / hz, q);
      }
      elapsed = base + n / hz;
    },
  };
}

// Compare two clients' claims about the crowd near (x, z). Returns
// {common, onlyA, onlyB, worst} where `worst` is the largest disagreement in
// how far along its beat a citizen has walked, in metres.
function compare(a, b, x, z, r = 190) {
  const sa = a.peds.snapshot(x, z, r), sb = b.peds.snapshot(x, z, r);
  const mb = new Map(sb.map((o) => [o.key, o]));
  let common = 0, onlyA = 0, worst = 0;
  for (const o of sa) {
    const q = mb.get(o.key);
    if (!q) { onlyA++; continue; }
    common++;
    worst = Math.max(worst, Math.abs(o.arc - q.arc));
    assert.equal(o.seed, q.seed, `seed differs for ${o.key}`);
    assert.equal(o.gen, q.gen, `generation differs for ${o.key}`);
    assert.equal(o.speed, q.speed, `walking speed differs for ${o.key}`);
    assert.equal(o.side, q.side, `side of the pavement differs for ${o.key}`);
    assert.equal(o.span, q.span, `beat length differs for ${o.key}`);
  }
  return { common, onlyA, onlyB: sb.length - common, worst, sa, sb };
}

// ---------------------------------------------------------------------------
// 1. THE SAME CELL GIVES THE SAME PEOPLE — wherever anyone happens to stand
// ---------------------------------------------------------------------------

test('two clients standing 600 m apart agree on every citizen between them', () => {
  const A = client(), B = client();
  A.run(60, 30, { x: -300, z: -60 });
  B.run(60, 30, { x: 300, z: 60 });
  A.at(60); B.at(60);                       // read the world at the same instant
  const r = compare(A, B, 0, 0, 180);
  assert.ok(r.common > 8, `expected an overlapping crowd, got ${r.common}`);
  assert.equal(r.onlyA, 0, 'client A invented people client B never heard of');
  assert.equal(r.onlyB, 0, 'client B invented people client A never heard of');
  assert.ok(r.worst < 1e-9, `beats drifted by ${r.worst} m`);
});

test('the crowd is a function of the cell, not of the route taken to reach it', () => {
  // A walks past the square from the west, B stands on it from the start.
  const A = client(), B = client();
  A.run(70, 30, (s) => ({ x: -600 + 9 * s, z: 0 }));
  B.run(70, 30, { x: 60, z: 40 });
  A.at(70); B.at(70);
  const r = compare(A, B, 60, 40, 170);
  assert.ok(r.common > 6, `too few shared citizens (${r.common})`);
  assert.equal(r.onlyA + r.onlyB, 0, 'the two histories produced different crowds');
  assert.ok(r.worst < 1e-9, `beats drifted by ${r.worst} m`);
});

test('a citizen keeps their identity when you leave the street and come back', () => {
  const A = client();
  A.run(20, 30, { x: 0, z: 0 });
  A.at(20);
  const before = A.peds.snapshot(0, 0, 150);
  A.run(90, 30, { x: 1400, z: 1400 });       // walk far enough to drop every schedule
  A.at(110);
  assert.equal(A.peds.snapshot(0, 0, 150).length, 0, 'the far crowd was not released');
  A.run(20, 30, { x: 0, z: 0 });
  A.at(130);
  const after = A.peds.snapshot(0, 0, 150);
  const m = new Map(after.map((o) => [o.key, o]));
  let checked = 0;
  for (const o of before) {
    const q = m.get(o.key);
    if (!q) continue;                        // may have rolled a generation
    if (q.gen !== o.gen) continue;
    checked++;
    assert.equal(q.seed, o.seed, `${o.key} came back as somebody else`);
    assert.equal(q.span, o.span, `${o.key} came back walking a different beat`);
  }
  assert.ok(checked > 5, `expected to re-meet the same people, matched ${checked}`);
});

test('streaming the region in a different order gives the same crowd', () => {
  const forward = client({ tiles: (r) => [r.slice(0, 6), r.slice(6, 20), r.slice(20)] });
  const shuffled = client({
    tiles: (r) => {
      const rest = r.slice(6);
      return [r.slice(0, 6), rest.slice().reverse(), []];
    },
  });
  forward.run(40, 30, { x: 0, z: 0 });
  shuffled.run(40, 30, { x: 0, z: 0 });
  forward.at(40); shuffled.at(40);
  const r = compare(forward, shuffled, 0, 0, 170);
  assert.ok(r.common > 6, `too few shared citizens (${r.common})`);
  assert.equal(r.onlyA + r.onlyB, 0, 'load order changed who exists');
  assert.ok(r.worst < 1e-9, `load order moved people by ${r.worst} m`);
});

// ---------------------------------------------------------------------------
// 2. NOTHING ON THE SHARED PATH MAY ROLL A DIE
// ---------------------------------------------------------------------------

test('nothing on the spawn path draws from Math.random', () => {
  const real = Math.random;
  let leaked = 0;
  Math.random = () => { leaked++; return real(); };
  try {
    const A = client();
    A.run(30, 30, (s) => ({ x: 6 * s, z: 0 }), 'view');
  } finally { Math.random = real; }
  // makeCitizen() is lent a deterministic draw for the length of one call, so
  // the counter must not move even while dozens of citizens are being built.
  assert.equal(leaked, 0, `${leaked} calls to Math.random on the shared path`);
});

test('17 fps and 144 fps produce the same crowd', () => {
  const slow = client(), fast = client();
  slow.run(45, 17, { x: 30, z: -30 });
  fast.run(45, 144, { x: 30, z: -30 });
  slow.at(45); fast.at(45);
  const r = compare(slow, fast, 30, -30, 170);
  assert.ok(r.common > 6, `too few shared citizens (${r.common})`);
  assert.equal(r.onlyA + r.onlyB, 0, 'the frame rate changed who exists');
  assert.ok(r.worst < 1e-9, `the frame rate moved people by ${r.worst} m`);
});

test('a late joiner walks into the crowd already on the pavement', () => {
  // Both blind, so neither is deferring a retirement: this test is about the
  // schedule, and the schedule may not care how long anyone has been watching.
  const early = client();
  early.run(200, 30, { x: 0, z: 0 }, 'blind');
  const late = client({ t0: T0 + 200 });      // boots 200 s into the world
  // Fifteen seconds is how long the birth budget needs to fill a cold ring —
  // the same few seconds the traffic takes to populate on a fresh boot.
  late.run(15, 30, { x: 0, z: 0 }, 'blind');
  early.run(15, 30, { x: 0, z: 0 }, 'blind'); // both now read t = T0 + 215
  const r = compare(early, late, 0, 0, 170);
  assert.ok(r.common > 6, `the late joiner found ${r.common} of the same people`);
  assert.equal(r.onlyA + r.onlyB, 0, 'the late joiner built a different crowd');
  assert.ok(r.worst < 1e-9, `the late joiner is ${r.worst} m out of step`);
});

test('the same slot always wears the same clothes', () => {
  const A = client(), B = client();
  A.run(40, 30, { x: 0, z: 0 });
  B.run(40, 60, { x: 120, z: 0 });           // different position AND frame rate
  const look = new Map();
  for (const p of A.peds.peds) if (p.sch) look.set(p.sch.key, p.look);
  let checked = 0;
  for (const p of B.peds.peds) {
    if (!p.sch) continue;
    const l = look.get(p.sch.key);
    if (!l) continue;
    checked++;
    assert.deepEqual(p.look, l, `${p.sch.key} is wearing a different outfit on the two clients`);
  }
  assert.ok(checked > 3, `expected shared bodies to compare, got ${checked}`);
});

test('density is a knob on the same world, not a different one', () => {
  const busy = client({ max: 60 }), quiet = client({ max: 12 });
  busy.run(40, 30, { x: 0, z: 0 });
  quiet.run(40, 30, { x: 0, z: 0 });
  busy.at(40); quiet.at(40);
  const keys = new Set(busy.peds.snapshot(0, 0, 180).map((o) => o.key));
  const thin = quiet.peds.snapshot(0, 0, 180);
  assert.ok(thin.length > 0 && thin.length < keys.size,
    `expected a subset, got ${thin.length} of ${keys.size}`);
  for (const o of thin)
    assert.ok(keys.has(o.key), `the quiet world invented ${o.key}, which the busy one has never heard of`);
});

// ---------------------------------------------------------------------------
// 3. NOBODY APPEARS OR DISAPPEARS WHERE THE PLAYER IS LOOKING
// ---------------------------------------------------------------------------

// Drive a player around and diff the live body list every frame, exactly the
// way the eye would: a body that was not there last frame and is there now, or
// the other way round, is an event. Count the ones the camera could see.
function watch(pathFn, { secs = 120, hz = 30, max = 34 } = {}) {
  const C = client({ max });
  const live = new Set();
  let inCone = 0, total = 0, closest = Infinity;
  const n = Math.round(secs * hz);
  for (let i = 1; i <= n; i++) {
    const t = i / hz;
    C.at(t);
    const q = pathFn(t);
    C.peds.setViewer(viewAt(q.x, q.z, q.hx, q.hz));
    const v = { x: q.x - q.hx * CAM_BACK, z: q.z - q.hz * CAM_BACK, fx: q.hx, fz: q.hz };
    C.peds.update(1 / hz, q);
    if (t > 20) {                            // let the ring fill first
      const now = new Set(C.peds.peds);
      const judge = (p) => {
        const dx = p.x - v.x, dz = p.z - v.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        const along = dx * v.fx + dz * v.fz;
        const lateral = Math.abs(dx * -v.fz + dz * v.fx);
        total++;
        if (d < NOTICE_R && along > 0 && lateral <= along * TAN_HALF) {
          inCone++;
          closest = Math.min(closest, d);
        }
      };
      for (const p of now) if (!live.has(p)) judge(p);
      for (const p of live) if (!now.has(p)) judge(p);
      live.clear();
      for (const p of now) live.add(p);
    } else {
      live.clear();
      for (const p of C.peds.peds) live.add(p);
    }
  }
  return { inCone, total, closest, pop: C.peds.peds.length };
}

test('nobody appears or vanishes inside the visible cone — standing still', () => {
  const r = watch(() => ({ x: 0, z: 0, hx: 1, hz: 0 }));
  assert.ok(r.total > 0, 'the crowd never changed at all — the test is not testing anything');
  assert.equal(r.inCone, 0, `${r.inCone} of ${r.total} lifecycle events happened in plain sight`);
});

test('nobody appears or vanishes inside the visible cone — driving at 50 km/h', () => {
  const v = 50 / 3.6;
  const r = watch((t) => ({ x: v * t - 600, z: 0, hx: 1, hz: 0 }));
  assert.ok(r.total > 40, `expected a busy street, only ${r.total} events`);
  assert.equal(r.inCone, 0, `${r.inCone} of ${r.total} lifecycle events happened in plain sight`);
});

test('nobody appears or vanishes inside the visible cone — driving a bend at 90 km/h', () => {
  const v = 90 / 3.6, R = 400;
  const r = watch((t) => {
    const a = (v * t) / R;
    return { x: R * Math.cos(a), z: R * Math.sin(a), hx: -Math.sin(a), hz: Math.cos(a) };
  });
  assert.ok(r.total > 40, `expected a busy street, only ${r.total} events`);
  assert.equal(r.inCone, 0, `${r.inCone} of ${r.total} lifecycle events happened in plain sight`);
});

test('without a camera nothing pops inside the blind radius either', () => {
  // main.js may not have been wired to setViewer() yet, and an un-wired build
  // must still be better than the old 18 m floor, not worse.
  const C = client();
  const live = new Set();
  let worst = Infinity;
  for (let i = 1; i <= 30 * 120; i++) {
    const t = i / 30;
    C.at(t);
    const q = { x: 12 * t - 700, z: 0 };
    C.peds.update(1 / 30, q);
    const now = new Set(C.peds.peds);
    if (t > 20) {
      const judge = (p) => { worst = Math.min(worst, Math.hypot(p.x - q.x, p.z - q.z)); };
      for (const p of now) if (!live.has(p)) judge(p);
      for (const p of live) if (!now.has(p)) judge(p);
    }
    live.clear();
    for (const p of now) live.add(p);
  }
  assert.ok(worst > 105, `a body appeared ${worst.toFixed(0)} m from the player with no camera set`);
});

// ---------------------------------------------------------------------------
// 4. THE LOCAL LAYER MAY DEVIATE, BUT ONLY IN WAYS THAT HEAL
// ---------------------------------------------------------------------------

test('a blast scatters the crowd without evicting anyone from it', () => {
  const C = client();
  C.run(40, 30, { x: 0, z: 0 }, 'view');
  const before = C.peds.peds.length;
  assert.ok(before > 4, `expected a crowd to scare, got ${before}`);
  C.peds.panic(0, 0, 200);
  const scared = C.peds.peds.filter((p) => p.calm > 0).length;
  assert.ok(scared > 0, 'nobody heard the bang');
  C.run(20, 30, { x: 0, z: 0 }, 'view');
  assert.ok(C.peds.peds.length >= before - 2,
    `panic cost the district ${before - C.peds.peds.length} citizens`);
  // and the debt drains: after everyone has calmed down and walked it off, the
  // whole crowd is back on its schedule
  C.run(180, 30, { x: 0, z: 0 }, 'view');
  for (const p of C.peds.peds)
    if (!p.free) assert.ok(Math.abs(p.rush) < 1e-6,
      `${p.sch.key} is still ${p.rush.toFixed(1)} m off its schedule`);
});

test('a citizen a car threw is released from their slot, and the slot stays empty', () => {
  const C = client();
  C.run(40, 30, { x: 0, z: 0 }, 'view');
  const victim = C.peds.peds.find((p) => !p.free);
  assert.ok(victim, 'no walkers to run over');
  const slot = victim.sch;
  // a car right on top of them, doing 60
  C.peds.playerCar = {
    x: victim.x, z: victim.z, y: 0, heading: 0, speed: 16.7, len: 4.6, wid: 1.8,
  };
  C.run(1, 30, { x: 0, z: 0 }, 'view');
  assert.equal(victim.free, 1, 'the victim is still being driven by the schedule');
  assert.equal(slot.body, null, 'the slot still points at the body it lost');
  assert.equal(slot.held, 1, 'the slot is free to hand out a replacement over the corpse');
  C.peds.playerCar = null;
  C.run(30, 30, { x: 0, z: 0 }, 'view');
  assert.equal(slot.body, null, 'a fresh citizen walked out of the dead one\'s slot');
});

test('walkers stay on the pavement and off the road', () => {
  const C = client();
  C.run(40, 30, { x: 0, z: 0 }, 'view');
  assert.ok(C.peds.peds.length > 4, 'nobody showed up');
  for (const p of C.peds.peds) {
    // the fixture's one drivable street runs down x = 45; a walker must never
    // be on it (drivable ways are not ingested at all)
    assert.ok(Math.abs(p.x - 45) > 2 || Math.abs(p.z) > HALF,
      `a citizen is walking down the middle of the road at ${p.x.toFixed(0)}, ${p.z.toFixed(0)}`);
  }
});
