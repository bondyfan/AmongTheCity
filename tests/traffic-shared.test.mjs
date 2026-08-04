// ---- shared traffic: the same cars on every screen ------------------------
// The user's requirement was one sentence — "chci abychom kolem sebe viděli
// stejné auta" — and every test here is a way the v7 traffic could not deliver
// it:
//
//   · population was a function of DISTANCE FROM ME (TRAFFIC.spawnR "of me"),
//     so two players 300 m apart drew two different fleets from one seed;
//   · twelve calls to Math.random decided which car, which paint, which turn
//     at every junction;
//   · the signal clock was `this._t += dt`, a per-tab accumulator starting at
//     zero on page load, so nobody's lights matched anybody's;
//   · the integration step WAS the frame, so 30 fps and 144 fps parted ways
//     even from an identical start;
//   · the graph is streamed, and a junction's light phase was hashed from
//     whichever signal point happened to arrive first — i.e. from the order
//     the region loaded, which is different for every player.
//
// v8 answers all five with one idea: a car's position is a pure function of
// (cell, slot, generation, worldT). `traffic.snapshot()` is that claim in
// serialisable form, and these tests are two clients comparing notes.
//
// three.js is not an npm package here, so the resolver hook is registered
// before traffic.js is imported. See tests/three-alias.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Traffic } = await import('../js/traffic.js');

// ---------------------------------------------------------------------------
// fixture: a grid town. Crossing ways repeat the EXACT coordinate, which is
// what traffic.js needs to weld them into one graph, exactly as OSM does.
// ---------------------------------------------------------------------------
const HALF = 800, STEP = 120;
function gridRoads() {
  const roads = [];
  const n = Math.floor(HALF / STEP);
  const line = (fn) => { const p = []; for (let j = -n; j <= n; j++) p.push(fn(j * STEP)); return p; };
  for (let i = -n; i <= n; i++) {
    const x = i * STEP, z = i * STEP;
    const tv = (i % 3 === 0) ? 'primary' : 'residential';
    const th = (i % 4 === 0) ? 'secondary' : 'residential';
    roads.push({ t: tv, d: 1, w: 9, v: 50, p: line((zz) => [x, zz]) });
    roads.push({ t: th, d: 1, w: 9, v: 50, p: line((xx) => [xx, z]) });
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

// A world epoch far from zero, like the real one (worldT() is ~1.8e7 and
// climbing): a schedule that only works near t=0 would be a lie.
const T0 = 17_900_000;

// One client. `tiles` lets a test stream the region in whatever order it likes.
function client({ tiles = null, maxCars = 90 } = {}) {
  const roads = gridRoads();
  const groups = tiles ? tiles(roads) : [roads];
  const t = new Traffic({ roads: groups[0], signals: [], onTileLoaded() {} }, stubVehicles());
  for (let i = 1; i < groups.length; i++) t.addTile({ roads: groups[i], signals: [] });
  let now = T0;
  t.clock = () => now;
  t.maxCars = maxCars;
  return {
    t,
    at: (s) => { now = T0 + s; },
    // run `secs` of wall time at `hz`, with the player standing (or driving) at pos(t)
    run(secs, hz, pos) {
      const n = Math.round(secs * hz);
      for (let i = 1; i <= n; i++) {
        now = T0 + i / hz;
        t.update(1 / hz, typeof pos === 'function' ? pos(i / hz) : pos, null);
      }
    },
  };
}

// Compare two clients' claims about the world near (x, z). Returns
// {common, onlyA, onlyB, worst} where `worst` is the largest disagreement in
// route arc-length, in metres.
function compare(a, b, x, z, r = 260) {
  const sa = a.t.snapshot(x, z, r), sb = b.t.snapshot(x, z, r);
  const mb = new Map(sb.map((o) => [o.key, o]));
  let common = 0, onlyA = 0, worst = 0;
  for (const o of sa) {
    const q = mb.get(o.key);
    if (!q) { onlyA++; continue; }
    common++;
    worst = Math.max(worst, Math.abs(o.arc - q.arc));
    assert.equal(o.seed, q.seed, `seed differs for ${o.key}`);
    assert.equal(o.gen, q.gen, `generation differs for ${o.key}`);
    assert.equal(o.vK, q.vK, `driver personality differs for ${o.key}`);
  }
  return { common, onlyA, onlyB: sb.length - common, worst, sa, sb };
}

// ---------------------------------------------------------------------------
// 1. THE SAME CELL GIVES THE SAME CARS — and does not care where anyone stands
// ---------------------------------------------------------------------------

test('two clients standing 650 m apart agree on every car between them', () => {
  const A = client(), B = client();
  A.run(60, 60, { x: -320, z: -120 });
  B.run(60, 60, { x: 320, z: 120 });
  A.at(60); B.at(60);                       // read the world at the same instant
  const r = compare(A, B, 0, 0, 260);
  assert.ok(r.common > 8, `expected an overlapping fleet, got ${r.common}`);
  assert.equal(r.onlyA, 0, 'client A invented cars client B never heard of');
  assert.equal(r.onlyB, 0, 'client B invented cars client A never heard of');
  assert.ok(r.worst < 1e-6, `schedules drifted by ${r.worst} m`);
});

test('the fleet is a function of the cell, not of the route taken to reach it', () => {
  // A drives past the cell from the west, B parks on top of it from the start.
  const A = client(), B = client();
  A.run(70, 60, (s) => ({ x: -700 + 12 * s, z: 0 }));
  B.run(70, 60, { x: 60, z: 40 });
  A.at(70); B.at(70);
  const r = compare(A, B, 60, 40, 240);
  assert.ok(r.common > 6, `too few shared cars (${r.common})`);
  assert.equal(r.onlyA + r.onlyB, 0, 'the two histories produced different fleets');
  assert.ok(r.worst < 1e-6, `schedules drifted by ${r.worst} m`);
});

test('a car keeps its identity when you leave the street and come back', () => {
  const A = client();
  A.run(40, 60, { x: 0, z: 0 });
  A.at(40);
  const before = new Map(A.t.snapshot(0, 0, 200).map((o) => [o.key, o]));
  assert.ok(before.size > 3);
  // 3 km away and back: every schedule around the origin is reaped and rebuilt
  A.run(6, 60, { x: 3000, z: 3000 });
  assert.equal(A.t.snapshot(0, 0, 200).length, 0, 'schedules should be reaped when out of range');
  A.run(6, 60, { x: 0, z: 0 });
  A.at(52);
  let checked = 0;
  for (const o of A.t.snapshot(0, 0, 200)) {
    const b = before.get(o.key);
    if (!b || b.gen !== o.gen) continue;      // a generation may legitimately have rolled
    checked++;
    assert.equal(o.seed, b.seed, `${o.key} came back as a different car`);
    assert.equal(o.vK, b.vK);
  }
  assert.ok(checked > 0, 'nothing survived the round trip to compare');
});

// ---------------------------------------------------------------------------
// 2. INDEPENDENCE FROM ORDER — of tiles, and of Math.random
// ---------------------------------------------------------------------------

test('streaming the region in a different order gives the same traffic', () => {
  // Three GEOGRAPHIC tiles with ways CLIPPED at the borders, which is exactly
  // what scripts/build-region.mjs emits and city.js streams — the shared
  // border point is what lets traffic.js weld the halves back into one edge.
  // The two clients get the same three tiles in opposite orders, which is the
  // difference between two players approaching a town from opposite sides.
  const band = (x) => (x < -HALF / 3 ? 0 : x < HALF / 3 ? 1 : 2);
  const split = (roads) => {
    const g = [[], [], []];
    for (const r of roads) {
      let cur = [r.p[0]], b = band((r.p[0][0] + r.p[1][0]) / 2);
      for (let i = 1; i < r.p.length; i++) {
        const nb = i + 1 < r.p.length ? band((r.p[i][0] + r.p[i + 1][0]) / 2) : b;
        cur.push(r.p[i]);
        if (nb !== b) { g[b].push({ ...r, p: cur }); cur = [r.p[i]]; b = nb; }
      }
      if (cur.length > 1) g[b].push({ ...r, p: cur });
    }
    return g;
  };
  const A = client({ tiles: split });
  const B = client({ tiles: (roads) => split(roads).reverse() });
  A.run(60, 60, { x: 0, z: 0 });
  B.run(60, 60, { x: 0, z: 0 });
  A.at(60); B.at(60);

  // the junctions themselves must be phased identically, or every schedule
  // downstream of one is off by up to a full 25 s cycle
  const ja = A.t._junctions.map((j) => [Math.round(j.x), Math.round(j.z), j.off]).sort();
  const jb = B.t._junctions.map((j) => [Math.round(j.x), Math.round(j.z), j.off]).sort();
  assert.deepEqual(ja, jb, 'traffic-light phases depend on the tile order');

  const r = compare(A, B, 0, 0, 300);
  assert.ok(r.common > 8, `too few shared cars (${r.common})`);
  assert.equal(r.onlyA + r.onlyB, 0, 'tile order changed which cars exist');
  assert.ok(r.worst < 1e-6, `tile order moved cars by ${r.worst} m`);
});

test('nothing on the shared path draws from Math.random', () => {
  // Two clients handed two completely different random streams. Anything that
  // still reaches for Math.random to decide a car, a paint or a turn shows up
  // here as a mismatch — the honk cooldown may use it, nothing else may.
  const real = Math.random;
  let A, B;
  try {
    Math.random = () => 0.01;
    A = client(); A.run(45, 60, { x: 0, z: 0 }); A.at(45);
    Math.random = () => 0.99;
    B = client(); B.run(45, 60, { x: 0, z: 0 }); B.at(45);
  } finally { Math.random = real; }
  const r = compare(A, B, 0, 0, 300);
  assert.ok(r.common > 8);
  assert.equal(r.onlyA + r.onlyB, 0, 'Math.random decided which cars exist');
  assert.ok(r.worst < 1e-9, `Math.random moved cars by ${r.worst} m`);
  // …and the visible choices too
  const ka = new Map([...A.t.cars].map((c) => [c.ai.key, c]));
  let seen = 0;
  for (const c of B.t.cars) {
    const o = ka.get(c.ai.key);
    if (!o) continue;
    seen++;
    assert.equal(c.kind, o.kind, `${c.ai.key} is a different model on the two clients`);
    assert.equal(c.color, o.color, `${c.ai.key} is a different colour on the two clients`);
  }
  assert.ok(seen > 5, 'no shared meshes to compare');
});

// ---------------------------------------------------------------------------
// 3. INDEPENDENCE FROM THE FRAME — and from when you joined
// ---------------------------------------------------------------------------

test('17 fps and 144 fps simulate the same world', () => {
  const A = client(), B = client();
  A.run(50, 17, { x: 0, z: 0 });
  B.run(50, 144, { x: 0, z: 0 });
  A.at(50); B.at(50);
  const r = compare(A, B, 0, 0, 300);
  assert.ok(r.common > 8);
  assert.equal(r.onlyA + r.onlyB, 0, 'the frame rate changed which cars exist');
  assert.ok(r.worst < 1e-9, `the frame rate moved schedules by ${r.worst} m`);
  // the rendered cars — where the lag layer lives — must land close too
  const kb = new Map([...B.t.cars].map((c) => [c.ai.key, c]));
  const d = [];
  for (const c of A.t.cars) {
    const o = kb.get(c.ai.key);
    if (o) d.push(Math.hypot(c.x - o.x, c.z - o.z));
  }
  d.sort((x, y) => x - y);
  assert.ok(d.length > 5, 'no shared meshes to compare');
  assert.ok(d[d.length >> 1] < 0.05, `median rendered gap ${d[d.length >> 1]} m`);
});

test('a late joiner arrives into the world already in progress', () => {
  const A = client();
  A.run(120, 60, { x: 0, z: 0 });
  // B is constructed 120 s later and only ever sees "now"
  const B = client();
  B.at(120);
  for (let i = 0; i < 60 * 4; i++) { B.at(120 + i / 60); B.t.update(1 / 60, { x: 0, z: 0 }, null); }
  A.at(120 + 4); B.at(120 + 4);
  const r = compare(A, B, 0, 0, 260);
  assert.ok(r.common > 8, `the late joiner found ${r.common} of A's cars`);
  assert.equal(r.onlyA, 0, 'the late joiner is missing cars the veteran can see');
  assert.ok(r.worst < 1e-6, `the late joiner's catch-up landed ${r.worst} m off`);
});

// ---------------------------------------------------------------------------
// 4. THE PARTS OF v7 THAT WERE ALREADY RIGHT
// ---------------------------------------------------------------------------

test('density is a knob on the same world, not a different one', () => {
  const A = client({ maxCars: 90 }), B = client({ maxCars: 45 });
  A.run(45, 60, { x: 0, z: 0 });
  B.run(45, 60, { x: 0, z: 0 });
  A.at(45); B.at(45);
  const sa = A.t.snapshot(0, 0, 300), sb = B.t.snapshot(0, 0, 300);
  assert.ok(sb.length < sa.length, 'the sparse client should see fewer cars');
  assert.ok(sb.length > 0, 'the sparse client should still see some');
  const ka = new Map(sa.map((o) => [o.key, o]));
  for (const o of sb) {
    const q = ka.get(o.key);
    assert.ok(q, `${o.key} exists at low density but not at high — slots must be removed from the top`);
    assert.equal(o.seed, q.seed);
    assert.ok(Math.abs(o.arc - q.arc) < 1e-6, `${o.key} drove differently at a different density`);
  }
});

test('cars still respect road class, driver personality and stub edges', () => {
  const A = client();
  A.run(45, 60, { x: 0, z: 0 });
  assert.ok(A.t.cars.size > 10, 'no traffic at all');
  for (const c of A.t.cars) {
    assert.ok(c.vK >= 0.72 && c.vK <= 1.18, `driver factor out of band: ${c.vK}`);
    assert.ok(Math.abs(c.speed) <= c.ai.edge.speed * c.vK * 1.9 + 0.5,
      'a car is exceeding even the catch-up allowance');
    assert.ok(Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.y));
    assert.ok(c.ai.edge.road.t !== 'service', 'traffic is spawning in car parks again');
  }
});

test('stealing a car empties its slot instead of cloning it', () => {
  const A = client();
  A.run(40, 60, { x: 0, z: 0 });
  const car = [...A.t.cars][0];
  const key = A.t.slotKey(car);
  assert.ok(key, 'a driven car must expose a stable slot id for the net layer');
  A.t.steal(car);
  assert.equal(car.ai, null);
  assert.ok(!A.t.cars.has(car));
  A.run(8, 60, { x: 0, z: 0 });
  assert.ok(![...A.t.cars].some((c) => c.ai.key === key), 'the slot refilled behind the player');
  // …and a peer can burn the same slot over the wire without ever having built it
  const B = client();
  B.at(40);
  B.t.claimSlot(key);
  for (let i = 0; i < 60 * 8; i++) { B.at(40 + i / 60); B.t.update(1 / 60, { x: 0, z: 0 }, null); }
  assert.ok(![...B.t.cars].some((c) => c.ai.key === key), 'claimSlot did not hold the slot');
});

test('a traffic light stands on the ground, not at sea level', async () => {
  // Every semafor in the country was built at y = 0 while this world is drawn
  // in ABSOLUTE elevation — 220 m under the asphalt at Pardubice, 380 under
  // Prague. They were lit, phase-cycling, parented to the scene, and buried
  // inside the terrain solid for the whole life of the feature: "stále nikde
  // nejsou semafory" was the literal truth.
  const THREE = await import('three');
  const GROUND = 221.4;
  const road = { _id: 1, t: 'primary', w: 9, v: 50, d: 1,
    p: [[-60, 0], [0, 0], [60, 0]] };
  const cross = { _id: 2, t: 'secondary', w: 8, v: 50, d: 1,
    p: [[0, -60], [0, 0], [0, 60]] };
  const scene = new THREE.Scene();
  const city = { roads: [road, cross], signals: [[0, 0]] };
  const world = { terrain: { heightAt: () => GROUND } };
  const t = new Traffic(city, { scene, cars: new Set() }, world);
  const poles = t._junctions.flatMap((j) => j.sigs);
  assert.ok(poles.length >= 2, `only ${poles.length} poles at a signalised crossroads`);
  for (const s of poles) {
    assert.ok(s.mesh, 'a pole must hand back its mesh so late terrain can re-seat it');
    assert.ok(Math.abs(s.mesh.position.y - GROUND) < 0.2,
      `pole at y=${s.mesh.position.y} with the ground at ${GROUND} — buried by`
      + ` ${(GROUND - s.mesh.position.y).toFixed(0)} m`);
  }
});
