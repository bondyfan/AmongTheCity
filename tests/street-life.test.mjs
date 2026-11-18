// ---- street life: the birds ---------------------------------------------------
// (dogs, prams and what people carry: tests/street-props.test.mjs)
// The claims that matter, each against the module that makes it:
//
//   js/birdsites.js    a flock is a pure function of its place and the hour:
//                      the same on every client, whatever order the map came in
//   js/birdflight.js   a scared bird goes up AWAY from what came, and lands on
//                      the seat it was sent to; one that leaves is gone
//   js/birdperches.js  candidates lie in their own chunk and never in a house
//   js/birds.js        flocks get rows near the player only, a car sends them
//                      up, a passer-by makes them hop, and no row leaks
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const S = await import('../js/birdsites.js');
const F = await import('../js/birdflight.js');
const { chunkPerches, waterNear, roofTopAt } = await import('../js/birdperches.js');
const { Birds } = await import('../js/birds.js');
const { BIRD_MAX } = await import('../js/birdmodel.js');
const { CHUNK } = await import('../js/config.js');
const { HEAD_OUT } = await import('../js/streetlamps.js');

const { KIND, SPECIES } = S;

// ------------------------------------------------------------------ flocks ----
test('a flock is a pure function of its place: same answer in any order, on any client', () => {
  const cands = [];
  for (let i = 0; i < 400; i++) cands.push({ kind: 1 + (i % 6), x: i * 7.25 - 900, z: (i * 131) % 977, len: 0.6 });
  const ctx = { urban: 0.8, water: false, hour: 13 };
  const a = cands.map((c) => S.flockAt(c, ctx));
  const b = cands.slice().reverse().map((c) => S.flockAt({ ...c }, { ...ctx })).reverse();
  assert.deepEqual(a, b);
  const some = a.filter(Boolean);
  assert.ok(some.length > 20 && some.length < 200, `some candidates hold a flock, most do not (${some.length} of 400)`);
  for (const f of some) assert.ok(SPECIES[f.species] && f.n >= 1 && f.n <= 11);
  // a quarter of a metre is the same place; a metre is not
  assert.equal(S.siteId(KIND.LAMP, 10.01, 5.02), S.siteId(KIND.LAMP, 10.06, 4.98));
  assert.notEqual(S.siteId(KIND.LAMP, 10, 5), S.siteId(KIND.LAMP, 11, 5));
  assert.notEqual(S.siteId(KIND.LAMP, 10, 5), S.siteId(KIND.SIGN, 10, 5));
});

test('the birds keep the hours of birds, and each kind keeps to its country', () => {
  assert.equal(S.dayK(13, KIND.GROUND), 1);
  assert.equal(S.dayK(1, KIND.GROUND), 0, 'nothing pecks about on the pavement at night');
  assert.ok(S.dayK(1, KIND.LAMP) > 0 && S.dayK(1, KIND.LAMP) < 0.5, 'a few asleep on the lamps');
  assert.ok(S.dayK(20.2, KIND.GROUND) < 1 && S.dayK(20.2, KIND.GROUND) > 0, 'dusk thins them');
  const tally = (ctx, kind) => {
    const n = {};
    for (let i = 0; i < 6000; i++) {
      const f = S.flockAt({ kind, x: i * 3.5, z: i * 1.75 }, ctx);
      if (f) n[f.species] = (n[f.species] ?? 0) + 1;
    }
    return n;
  };
  const town = tally({ urban: 1, hour: 12 }, KIND.GROUND), field = tally({ urban: 0, hour: 12 }, KIND.GROUND);
  assert.ok(town.pigeon > town.crow * 4, 'pigeons own the square');
  assert.ok(field.crow > field.pigeon * 3, 'crows own the field');
  assert.equal(town.gull, undefined, 'no gulls without water');
  assert.ok(tally({ urban: 1, hour: 12, water: true }, KIND.GROUND).gull > 50, 'gulls by the river');
  assert.equal(Object.keys(tally({ urban: 1, hour: 2 }, KIND.GROUND)).length, 0);
  // the slider can only thin or thicken, never move a flock
  const base = S.flockAt({ kind: KIND.GROUND, x: 31.5, z: 12.25 }, { urban: 1, hour: 12, density: 2 });
  for (let i = 0; i < 400; i++) {
    const c = { kind: KIND.GROUND, x: i * 9.5, z: 4 };
    const lo = S.flockAt(c, { urban: 1, hour: 12, density: 0.5 }), hi = S.flockAt(c, { urban: 1, hour: 12, density: 1 });
    if (lo) assert.deepEqual(lo, hi, 'a flock that survives thinning is the same flock');
  }
  void base;
});

test('seats: a row sits along its rail, a ground flock spreads out, nobody shares a spot', () => {
  const row = { kind: KIND.LAMP, x: 100, y: 7.5, z: -40, dx: 0.6, dz: 0.8, len: 0.62 };
  const seats = S.seatsFor(row, 'pigeon', 3, 99);
  assert.equal(seats.length, 3);
  for (const s of seats) {
    const ax = s.x - row.x, az = s.z - row.z;
    assert.ok(Math.abs(ax * row.dz - az * row.dx) < 1e-9, 'on the line of the arm');
    assert.ok(Math.hypot(ax, az) <= row.len / 2 + 1e-9, 'and not off the end of it');
    assert.equal(s.y, 7.5);
    // looking across the rail, one way or the other
    const fx = -Math.sin(s.yaw), fz = -Math.cos(s.yaw);
    assert.ok(Math.abs(fx * row.dx + fz * row.dz) < 0.5, 'facing across, not along');
  }
  const ground = S.seatsFor({ kind: KIND.GROUND, x: 5, z: 5 }, 'pigeon', 11, 7, (x, z) => 200 + x * 0.01 + z * 0);
  assert.equal(ground.length, 11);
  for (let i = 0; i < ground.length; i++) {
    assert.ok(Math.abs(ground[i].y - (200 + ground[i].x * 0.01)) < 1e-9, 'each stands on the ground under ITS feet');
    assert.ok(Math.hypot(ground[i].x - 5, ground[i].z - 5) < 3, 'a flock, not a scatter down the street');
    for (let j = 0; j < i; j++) assert.ok(Math.hypot(ground[i].x - ground[j].x, ground[i].z - ground[j].z) > 0.12, 'two birds on one spot');
  }
  assert.deepEqual(S.seatsFor(row, 'pigeon', 3, 99), seats, 'the same seed seats them the same');
});

test('the flocks overhead are a closed form of the shared clock', () => {
  let flights = 0, air = 0;
  for (let slot = 100; slot < 160; slot++) {
    const f = S.skyFlight(3, -2, slot, { urban: 0.7, hour: 12 });
    assert.deepEqual(f, S.skyFlight(3, -2, slot, { urban: 0.7, hour: 12 }));
    if (!f) continue;
    flights++;
    assert.ok(f.t0 >= slot * S.SKY_T && f.t0 < (slot + 1) * S.SKY_T && f.y > 10);
    const o = { x: 0, y: 0, z: 0 }, q = { x: 0, y: 0, z: 0 };
    assert.equal(S.skyBirdAt(f, 0, f.t0 - 1, o), null, 'not yet in the air');
    assert.equal(S.skyBirdAt(f, 0, f.t0 + f.dur + 1, o), null, 'gone');
    for (let t = f.t0 + 1; t < f.t0 + f.dur - 1; t += 2) {
      S.skyBirdAt(f, 1, t, o); S.skyBirdAt(f, 1, t + 0.1, q);
      const v = Math.hypot(q.x - o.x, q.z - o.z) / 0.1;
      assert.ok(v > f.speed * 0.6 && v < f.speed * 1.5, `a bird, not a teleport (${v.toFixed(1)} m/s)`);
      air++;
    }
  }
  assert.ok(flights > 15 && flights < 55 && air > 100);
  assert.equal(S.skyFlight(3, -2, 120, { urban: 0.7, hour: 12, })?.seed, S.skyFlight(3, -2, 120, { urban: 0.7, hour: 12 })?.seed);
  let night = 0;
  for (let slot = 0; slot < 200; slot++) if (S.skyFlight(0, 0, slot, { hour: 1 })) night++;
  assert.ok(night < 60, 'few fly at night');
});

// ------------------------------------------------------------------ flight ----
const fly = (b, sp, secs = 40) => {
  const log = [];
  for (let i = 0; i < secs * 60 && b.mode !== F.MODE.SEAT && b.mode !== F.MODE.GONE; i++) {
    F.stepBird(b, 1 / 60, sp);
    log.push([b.x, b.y, b.z, b.mode]);
  }
  return log;
};

test('a scared bird waits its nerve, goes up away from the threat, and lands on its new seat', () => {
  for (const key of Object.keys(SPECIES)) {
    const sp = SPECIES[key];
    const b = F.makeBird({ x: 0, y: 0, z: 0, yaw: 0 }, 0.4);
    assert.equal(F.stepBird(b, 1 / 60, sp), false, 'a seated bird costs nothing');
    const seat = { x: 38, y: 7.5, z: 12, yaw: 1.2 };
    // the threat is at +x: away is -x, although the new seat lies at +x
    F.launch(b, -1, 0, { pts: F.routeTo(0, 0, 0, seat.x, seat.y, seat.z, -1, 0, 0, 0.4), seat }, 0.3, [0.3, 0.6, 0.5]);
    for (let i = 0; i < 17; i++) F.stepBird(b, 1 / 60, sp);
    assert.equal(b.mode, F.MODE.WAIT, 'still on the ground inside its delay');
    assert.equal(b.x, 0);
    const log = fly(b, sp);
    assert.equal(b.mode, F.MODE.SEAT, `${key} lands`);
    assert.deepEqual([b.x, b.y, b.z, b.yaw], [seat.x, seat.y, seat.z, seat.yaw]);
    const early = log[Math.min(log.length - 1, 45)];
    assert.ok(early[0] < -0.5 && early[1] > 0.8, `${key} leaves away from the threat and upward (${early})`);
    assert.ok(Math.min(...log.map((r) => r[1])) > -0.3, 'never under the ground it left');
    assert.ok(log.length < 60 * 30, 'in reasonable time');
    for (let i = 1; i < log.length; i++) {
      const v = Math.hypot(log[i][0] - log[i - 1][0], log[i][1] - log[i - 1][1], log[i][2] - log[i - 1][2]) * 60;
      assert.ok(v < sp.cruise * 2.2 + 6, `${key}: no jump in the path (${v.toFixed(1)} m/s at step ${i})`);
    }
    // settled: the wings close and it goes quiet again
    for (let i = 0; i < 120; i++) F.stepBird(b, 1 / 60, sp);
    assert.equal(b.spread, 0);
    assert.equal(F.stepBird(b, 1 / 60, sp), false);
  }
});

test('a flock that leaves is gone, and a hop is short and low', () => {
  const sp = SPECIES.pigeon;
  const b = F.makeBird({ x: 0, y: 3, z: 0, yaw: 0 }, 0.1);
  F.launch(b, 0, 1, { pts: F.routeAway(0, 3, 0, 0, 1, 0.5), seat: null }, 0);
  fly(b, sp, 60);
  assert.equal(b.mode, F.MODE.GONE);
  assert.ok(Math.hypot(b.x, b.z) > 120 && b.y > 20, 'far and high when it goes');
  const h = F.makeBird({ x: 0, y: 0, z: 0, yaw: 0 }, 0.7), seat = { x: 5, y: 0, z: 1, yaw: 2 };
  F.launch(h, 1, 0, { pts: F.routeHop(0, 0, 0, 5, 0, 1), seat }, 0);
  const log = fly(h, sp);
  assert.equal(h.mode, F.MODE.SEAT);
  assert.ok(Math.max(...log.map((r) => r[1])) < 3.2, 'a hop stays under head height or so');
  assert.ok(log.length < 60 * 6, 'and is over in a few seconds');
});

// ------------------------------------------------------------------ perches ----
function town() {
  // one chunk: a footway, a quiet street, a trolley street, a house, a lamp
  const b = { _id: 7, h: 9, o: [[20, 20], [40, 20], [40, 34], [20, 34]] };
  const cell = {
    buildings: [b],
    roads: [
      { t: 'footway', d: 0, w: 2.4, p: [[5, 60], [110, 60]] },
      { t: 'footway', d: 0, w: 2.4, p: [[10, 27], [50, 27]] },          // straight through the house
      { t: 'residential', d: 1, w: 7, p: [[60, 0], [60, 119]] },
      { t: 'secondary', d: 1, w: 10, tw: 1, p: [[0, 100], [119, 100]] },
    ],
    water: [],
  };
  const lamps = [{ x: 30, y: 2, z: 64, rot: 0, kind: 'street' }, { x: 80, y: 2, z: 64, rot: Math.PI / 2, kind: 'street' },
    { x: 50, y: 2, z: 80, kind: 'park' }, { x: 130, y: 2, z: 64, rot: 0, kind: 'street' }];
  return {
    cell, lamps,
    env: {
      city: { chunkIndex: new Map([['0,0', cell]]) },
      terrain: { heightAt: () => 2, ready: () => true },
      poles: { near: () => lamps },
      signs: (key) => (key === '0,0' ? [[12, 50, 4.7, 1, 0]] : []),
      sites: null, hidden: null,
    },
  };
}

test('perches: in their own chunk, out of the houses, each where its fixture stands', () => {
  const { env, lamps } = town();
  const { cands, urban } = chunkPerches('0,0', env);
  assert.ok(urban > 0 && urban < 0.2);
  const by = (k) => cands.filter((c) => c.kind === k);
  for (const c of cands) {
    assert.ok(c.x >= 0 && c.x < CHUNK && c.z >= 0 && c.z < CHUNK, 'inside the chunk');
    assert.equal(c.water, false);
  }
  // lamps: the two columns inside the chunk, each perch out along its own arm
  const L = by(KIND.LAMP);
  assert.equal(L.length, 2, 'the lamp in the next chunk is the next chunk\'s');
  assert.ok(Math.abs(L[0].z - (lamps[0].z - (HEAD_OUT - 0.42))) < 1e-9 && L[0].x === 30, 'rot 0 reaches toward -z');
  assert.ok(Math.abs(L[1].x - (80 - (HEAD_OUT - 0.42))) < 1e-9, 'rot 90 degrees reaches toward -x');
  assert.ok(L[0].y > 9 && L[0].y < 10, 'on the arm, seven and a half metres over its base');
  assert.equal(by(KIND.POST).length, 1);
  assert.equal(by(KIND.SIGN).length, 1);
  assert.ok(Math.abs(by(KIND.SIGN)[0].dx) < 1e-9 && Math.abs(by(KIND.SIGN)[0].dz) === 1, 'along the plate, across the travel');
  // the wire: over the trolley street, 5.5 m up
  const wires = by(KIND.WIRE);
  assert.ok(wires.length >= 3);
  for (const w of wires) assert.ok(Math.abs(w.y - (2 + 5.5 + 0.035)) < 1e-9 && Math.abs(w.z - 100) < 3);
  // the ground: some, and none inside the house the second footway runs through
  const G = by(KIND.GROUND);
  assert.ok(G.length >= 4);
  for (const g of G) assert.ok(!(g.x > 20 && g.x < 40 && g.z > 20 && g.z < 34), 'no pigeons indoors');
  // the roof: on the outline of the house, at its top
  const R = by(KIND.ROOF);
  assert.ok(R.length >= 2);
  for (const r of R) {
    assert.ok(r.y >= 11 && r.y < 11.7, 'at the eaves (ground 2 + 9 m), plus an upstand at most');
    const edge = Math.min(Math.abs(r.x - 20), Math.abs(r.x - 40), Math.abs(r.z - 20), Math.abs(r.z - 34));
    assert.ok(edge < 0.2, 'on the wall line');
  }
  // the order things arrived in changes nothing
  const again = town();
  again.env.poles = { near: () => again.lamps.slice().reverse() };
  again.cell.roads.reverse();
  const ids = (cs) => cs.map((c) => S.siteId(c.kind, c.x, c.z)).sort();
  assert.deepEqual(ids(chunkPerches('0,0', again.env).cands), ids(cands));
});

test('a bird sees every building in its way, the near ones with rooms built too', () => {
  const { env } = town();
  assert.equal(roofTopAt(env.city, env.terrain, 30, 27), 11, 'the top of the house: ground 2 + 9 m');
  assert.equal(roofTopAt(env.city, env.terrain, 70, 70), 0, 'open sky over the street');
  assert.equal(roofTopAt(env.city, env.terrain, 5000, 5000), 0, 'and where no map is loaded');
});

test('water is near when its bank is', () => {
  const cell = { water: [{ o: [[0, 0], [100, 0], [100, 30], [0, 30]] }] };
  assert.ok(waterNear(cell, 50, 15), 'standing in it');
  assert.ok(waterNear(cell, 50, 80, 70), 'fifty metres from the bank');
  assert.ok(!waterNear(cell, 50, 140, 70));
  assert.ok(!waterNear({}, 0, 0));
});

// ------------------------------------------------------------------ the manager ----
function birdWorld() {
  const cell = { buildings: [], roads: [], water: [] };
  // a square of footways dense enough that flocks certainly live on it
  for (let z = 6; z < 118; z += 8) cell.roads.push({ t: 'pedestrian', d: 0, w: 4, p: [[2, z], [118, z]] });
  for (let i = 0; i < 30; i++) cell.buildings.push({ _id: 100 + i, h: 2, o: [[500 + i, 500], [500.5 + i, 500], [500.5 + i, 500.5]] });
  const world = {
    terrain: { heightAt: () => 0, ready: () => true }, walkY: () => 0, roofY: () => 0, poles: { near: () => [] },
    built: new Map([['0,0', {}]]), interiors: { hidden: new Set() },
  };
  const scene = new THREE.Scene();
  const birds = new Birds(scene, { city: { chunkIndex: new Map([['0,0', cell]]) }, world, sites: null, signs: () => [],
    hourOf: () => 12, clock: () => 0 });
  return { birds, scene, world };
}
const run = (birds, secs, focus, th = null, view = null) => { for (let i = 0; i < secs * 30; i++) birds.update(1 / 30, focus, view, th); };

test('birds get rows near the player, give them back far away, and never leak one', () => {
  const { birds, scene } = birdWorld();
  assert.equal(scene.children.length, 1, 'one mesh for every bird there will ever be');
  const here = { x: 60, z: 60 };
  run(birds, 2, here);
  const seated = [...birds.flocks.values()].filter((f) => f.birds);
  assert.ok(seated.length >= 3, `flocks on the square (${seated.length})`);
  const n = birds.count - birds.sky.rows;                 // (the flocks passing overhead have rows too)
  assert.ok(n >= 6 && birds.count <= BIRD_MAX);
  assert.equal(birds.mesh.count, birds.count);
  assert.equal(n, seated.reduce((s, f) => s + f.birds.length, 0), 'every row is somebody');
  for (const f of seated) for (const b of f.birds) assert.equal(birds.live[b.row], b);
  // a kilometre away: nothing is left
  run(birds, 2, { x: 1500, z: 60 });
  assert.equal(birds.count, birds.sky.rows);
  assert.equal(birds.flocks.size, 0, 'and the chunk is forgotten');
  // back: the same flocks, on the same seats
  run(birds, 2, here);
  assert.equal(birds.count - birds.sky.rows, n, 'the same birds are back');
  birds.dispose();
  assert.equal(scene.children.length, 0);
});

test('a car sends a flock up, a passer-by makes it hop, a bang clears the square', () => {
  const { birds } = birdWorld();
  const here = { x: 60, z: 60 };
  run(birds, 2, here);
  const flocks = [...birds.flocks.values()].filter((f) => f.birds && f.state === 'sit');
  const far = (f) => Math.hypot(f.x - here.x, f.z - here.z) > 12;
  const f = flocks.find(far);
  assert.ok(f, 'a flock away from the player');
  const home = { x: f.x, z: f.z }, y0 = f.birds[0].y;
  // a car at 14 m/s passes two metres from it
  const car = { x: f.x + 2, z: f.z, speed: 14 };
  run(birds, 0.4, here, { x: here.x, z: here.z, speed: 0, inCar: false, cars: [car], peds: [] });
  assert.notEqual(f.state, 'sit', 'up they go');
  run(birds, 1.5, here);
  assert.ok(f.birds === null || f.birds.some((b) => b.y > y0 + 1.5), 'and they are in the air');
  // a walker through another flock: it lands a few metres off, still on the ground
  const g = flocks.find((q) => q !== f && far(q) && q.state === 'sit');
  assert.ok(g, 'a second flock');
  const gx = g.x, gz = g.z;
  run(birds, 0.4, here, { x: here.x, z: here.z, speed: 0, inCar: false, cars: [], peds: [{ x: g.x + 0.3, z: g.z, state: 'walk', speed: 1.3 }] });
  assert.equal(g.state, 'air');
  run(birds, 8, here);
  assert.equal(g.state, 'sit');
  const hop = Math.hypot(g.x - gx, g.z - gz);
  assert.ok(hop > 2 && hop < 9, `a hop, not a migration (${hop.toFixed(1)} m)`);
  // a bang: everything still sitting within earshot goes
  const before = [...birds.flocks.values()].filter((q) => q.state === 'sit').length;
  assert.ok(before > 0);
  birds.scare(here.x, here.z, 30);
  assert.equal([...birds.flocks.values()].filter((q) => q.state === 'sit' && Math.hypot(q.x - here.x, q.z - here.z) < 55).length, 0);
  // and when the player has gone and come back, the first flock is home again
  run(birds, 2, { x: 1500, z: 60 });
  run(birds, 2, here);
  const again = birds.flocks.get(f.id);
  assert.ok(again && Math.hypot(again.x - home.x, again.z - home.z) < 1e-9, 'back on its shared seat');
  assert.equal(birds.count, [...birds.flocks.values()].reduce((s, q) => s + (q.birds?.length ?? 0), 0) + birds.sky.rows);
});

test('the hour is a new answer about the same places: night sends the ground flocks home without a new search', () => {
  const cell = { buildings: [], roads: [], water: [] };
  for (let z = 6; z < 118; z += 8) cell.roads.push({ t: 'pedestrian', d: 0, w: 4, p: [[2, z], [118, z]] });
  let hour = 12;
  const world = { terrain: { heightAt: () => 0, ready: () => true }, walkY: () => 0, poles: { near: () => [] }, built: new Map([['0,0', {}]]) };
  const birds = new Birds(new THREE.Scene(), { city: { chunkIndex: new Map([['0,0', cell]]) }, world, signs: () => [], hourOf: () => hour, clock: () => 0 });
  const here = { x: 60, z: 60 };
  run(birds, 3, here);
  const ch = birds.chunks.get('0,0'), cands = ch.cands, day = birds.count - birds.sky.rows;
  assert.ok(day > 6);
  hour = 23.5;
  run(birds, 12, here);
  assert.equal(birds.chunks.get('0,0').cands, cands, 'the candidates were not searched for again');
  assert.equal([...birds.flocks.values()].filter((f) => f.state === 'sit').length, 0, 'nobody is left sitting on the pavement');
  run(birds, 60, here);
  assert.equal(birds.count - birds.sky.rows, 0, 'and they have all flown home');
  hour = 12;
  run(birds, 12, { x: 1500, z: 60 });
  run(birds, 12, here);
  assert.equal(birds.count - birds.sky.rows, day, 'in the morning the same flocks are back');
});

test('switched off, the birds cost nothing and show nothing', () => {
  const { birds } = birdWorld();
  birds.enabled = false;
  run(birds, 2, { x: 60, z: 60 });
  assert.equal(birds.mesh.visible, false);
  assert.equal(birds.count, 0);
});
