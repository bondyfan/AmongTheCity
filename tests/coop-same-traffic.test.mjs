// ---- co-op: two players on one corner hold one set of cars ------------------
// Frank, 21 Nov 2026: "hraci v multiplayeru nevidi stejne auta stejny provoz
// atd.... proste kazdy hrac musi videt to stejne co ten druhy/jiny".
//
// The schedule was shared already (tests/traffic-shared.test.mjs). What each
// client DREW was not: a mesh arrives and a finished car drives on as a ghost
// by what the local camera sees, so two players side by side and facing
// opposite ways held two different streets, and a graph cut in the order the
// tiles happened to arrive routed cars down different ones. These tests are
// two clients comparing what is on their screens (js/coopdiff.js); the same
// comparison on the real Pardubice tiles is dev/coopbench.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Traffic } = await import('../js/traffic.js');
const { diffCars, headingGap, whyAlone } = await import('../js/coopdiff.js');
const { peersNear, nearAny, Trail, ROOM_R } = await import('../js/roomview.js');

// ---- fixture: the grid town of the shared-traffic tests ----------------------
const HALF = 800, STEP = 120;
function gridRoads() {
  const roads = [];
  const n = Math.floor(HALF / STEP);
  const line = (fn) => { const p = []; for (let j = -n; j <= n; j++) p.push(fn(j * STEP)); return p; };
  for (let i = -n; i <= n; i++) {
    const x = i * STEP, z = i * STEP;
    roads.push({ t: i % 3 === 0 ? 'primary' : 'residential', d: 1, w: 9, v: 50, p: line((zz) => [x, zz]) });
    roads.push({ t: i % 4 === 0 ? 'secondary' : 'residential', d: 1, w: 9, v: 50, p: line((xx) => [xx, z]) });
  }
  return roads;
}
function stubVehicles() {
  return {
    scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading, color) {
      const car = { mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} },
        wheels: [], x, z, heading, speed: 0, steer: 0, kind, color, len: 4.6, wid: 1.8, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car);
      return car;
    },
    remove(car) { this.cars.delete(car); },
  };
}
const T0 = 17_900_000;
const drawn = (t, x, z, R) => [...t.cars].filter((c) => (c.x - x) ** 2 + (c.z - z) ** 2 < R * R)
  .map((c) => ({ key: c.ai.key, kind: c.kind, color: c.color, x: c.x, z: c.z, h: c.heading, ghost: c.ai.ghost ? 1 : 0 }));

// two clients on the pavement of one street, 3 m apart, each with its own camera
function pair({ room, lookB = -1, secs = 260, warm = 80, maxCars = 150 }) {
  let now = T0;
  const mk = () => { const t = new Traffic({ roads: gridRoads(), signals: [], onTileLoaded() {} }, stubVehicles()); t.clock = () => now; t.maxCars = maxCars; return t; };
  const A = mk(), B = mk();
  const pa = { x: 60, y: 0, z: 9 }, pb = { x: 63, y: 0, z: 9 };
  let n = 0, agree = 0, ghosts = 0, cars = 0, worst = 1, alone = 0;
  const hz = 20;
  for (let k = 1; k <= secs * hz; k++) {
    now = T0 + k / hz;
    for (const [t, me, peer, dx] of [[A, pa, pb, 1], [B, pb, pa, lookB]]) {
      t.actors = [{ x: me.x, z: me.z, half: 2.3 }, { x: peer.x, z: peer.z, half: 2.3 }];
      t.watchers = room ? [{ x: peer.x, z: peer.z, id: 'peer' }] : null;
      t.setViewer({ x: me.x, z: me.z, dirX: dx, dirZ: 0, fovRad: 1.19, aspect: 16 / 9, fogFar: 634 });
      t.update(1 / hz, me, null);
    }
    if (k / hz < warm || k % (5 * hz)) continue;
    const da = drawn(A, pa.x, pa.z, 300), db = drawn(B, pa.x, pa.z, 300);
    // (a car's length or three: two bodies braking for the same queue from
    // 3 m apart sit a few metres off each other, on the same street)
    const d = diffCars(da, db, 15);
    n++; agree += d.agree; cars += da.length; if (d.agree < worst) worst = d.agree;
    alone += (d.onlyA.length + d.onlyB.length) / Math.max(1, da.length + db.length);
    for (const c of da) ghosts += c.ghost;
  }
  return { agree: agree / n, worst, ghosts, cars: cars / n, alone: alone / n, A, B };
}

test('facing opposite ways, two players in a room draw the same cars in the same places', () => {
  const r = pair({ room: true });
  assert.ok(r.cars > 4, `a street with traffic on it (${r.cars.toFixed(1)} cars)`);
  assert.ok(r.ghosts > 0, 'some of what they share are cars driving on past the end of their trip');
  assert.ok(r.alone < 0.03, `cars on one screen only: ${(r.alone * 100).toFixed(1)} %`);
  assert.ok(r.agree > 0.88, `agreement ${r.agree.toFixed(3)}, worst sample ${r.worst.toFixed(2)}`);
});

test('…which each camera deciding for itself did not give them', () => {
  const r = pair({ room: false });
  assert.ok(r.alone > 0.15, `the game before: ${(r.alone * 100).toFixed(1)} % of the cars were on one screen only`);
  assert.ok(r.agree < 0.75, `…and agreement was ${r.agree.toFixed(3)}`);
});

test('alone, the camera cone still decides (nothing of the room applies)', () => {
  const t = new Traffic({ roads: gridRoads(), signals: [], onTileLoaded() {} }, stubVehicles());
  t.setViewer({ x: 0, z: 0, dirX: 1, dirZ: 0, fovRad: 1.19, aspect: 16 / 9, fogFar: 634 });
  assert.equal(t._visible(100, 0), true, 'ahead');
  assert.equal(t._visible(-100, 0), false, 'behind');
  t.watchers = [];
  assert.equal(t._visible(-100, 0), false, 'an empty room is no room');
  t.watchers = [{ x: 3, z: 0, id: 'p' }];
  assert.equal(t._visible(-100, 0), true, 'with somebody beside us, behind us is watched too');
  assert.equal(t._visible(-900, 0), false, 'past every fog wall it is not');
});

test('a car that drove in from outside is handed to a newcomer, one born beside the player is not', () => {
  let now = T0;
  const t = new Traffic({ roads: gridRoads(), signals: [], onTileLoaded() {} }, stubVehicles());
  t.clock = () => now; t.maxCars = 150;
  // the peer has stood at the origin all along; we are 700 m away (our circles do not touch)
  t.watchers = [{ x: 0, z: 0, id: 'p' }];
  for (let k = 1; k <= 40; k++) { now = T0 + k / 4; t.update(0.25, { x: 700, y: 0, z: 9 }, null); }
  let inside = 0, outside = 0;
  for (const p of t._pool.values()) {
    if (!p.route || p.fixed) continue;
    t._bornWatched(p, 256);
    const born = Math.hypot(p.bx, p.bz) < 256;
    if (Math.hypot(p.bx - 700, p.bz - 9) < 256) continue;         // (born beside US: watched as well)
    const pose = t._nomPose(p, now);
    if (!pose || Math.hypot(pose.x, pose.z) >= 240) continue;      // only the ones beside the peer now
    const x = pose.x, z = pose.z;
    if (born && p.t0 > T0) { inside++; assert.equal(t._readableForAttach(x, z, p), true, 'born in his circle: no mesh yet'); }
    if (!born) { outside++; assert.equal(t._readableForAttach(x, z, p), false, 'drove in: he has it, so do we'); }
  }
  assert.ok(outside > 0, 'the fixture has cars that drove in');
});

// ---- the graph does not depend on the order the tiles came in -----------------
test('a way of a later tile that joins an earlier one mid-polyline cuts it, in either order', () => {
  // a main road with an interior vertex at (0, 0), and a side street of the
  // NEXT tile that ends exactly there
  const main = () => ({ t: 'primary', d: 1, w: 9, v: 50, p: [[-300, 0], [0, 0], [300, 0]] });
  const side = () => ({ t: 'residential', d: 1, w: 8, v: 50, p: [[0, 0], [0, 200], [150, 320]] });
  const cross = () => ({ t: 'residential', d: 1, w: 8, v: 50, p: [[300, -200], [300, 0], [300, 200]] });
  const build = (first, second) => {
    const t = new Traffic({ roads: first, signals: [], onTileLoaded() {} }, stubVehicles());
    t.addTile({ roads: second, signals: [] });
    return t;
  };
  const key = (e) => `${e.a.x},${e.a.z}>${e.b.x},${e.b.z}:${e.len.toFixed(2)}`;
  const A = build([main(), cross()], [side()]);
  const B = build([side()], [main(), cross()]);
  const ka = A.edges.map(key).sort(), kb = B.edges.map(key).sort();
  assert.deepEqual(ka, kb, 'the same edges, whichever tile came first');
  const node = [...A._nodes.values()].find((n) => n.x === 0 && n.z === 0);
  assert.ok(node, 'the junction is a node');
  assert.equal(node.out.length, 3, 'and the main road can be left there, both ways and up the side street');
});

test('a way that is cut again takes the schedules routed over it with it, and they come back', () => {
  let now = T0;
  const roads = gridRoads();
  const t = new Traffic({ roads, signals: [], onTileLoaded() {} }, stubVehicles());
  t.clock = () => now; t.maxCars = 150;
  for (let k = 1; k <= 40; k++) { now = T0 + k / 4; t.update(0.25, { x: 0, y: 0, z: 9 }, null); }
  const before = t._pool.size;
  assert.ok(before > 10);
  // a lane of a later tile joining the first horizontal street between two of its vertices' ends
  const z0 = roads[1].p[0][1], mid = roads[1].p[3];
  t.addTile({ roads: [{ t: 'residential', d: 1, w: 6, v: 30, p: [[mid[0], mid[1]], [mid[0] + 7, z0 + 60]] }], signals: [] });
  for (const p of t._pool.values()) for (const st of p.route) assert.ok(st.e.a.out.includes(st.e), 'no schedule is left on an edge that has gone');
  for (let k = 1; k <= 8; k++) { now += 0.25; t.update(0.25, { x: 0, y: 0, z: 9 }, null); }
  assert.ok(t._pool.size >= before - 2, `the slots are minted again (${t._pool.size} of ${before})`);
});

// ---- the measuring stick itself ------------------------------------------------
test('diffCars pairs by identity first, then by place, and counts the rest once', () => {
  const A = [{ key: 'a', kind: 'sedan', color: 1, x: 0, z: 0, h: 0 }, { key: 'b', kind: 'van', color: 2, x: 50, z: 0, h: 0 },
    { key: 'g#1', kind: 'suv', color: 3, x: 90, z: 0, h: 0, ghost: 1 }, { key: null, kind: 'hatch', color: 4, x: 200, z: 0, h: 1 }];
  const B = [{ key: 'a', kind: 'sedan', color: 1, x: 0.5, z: 0, h: 0 }, { key: 'b', kind: 'van', color: 2, x: 70, z: 0, h: 0 },
    { key: null, kind: 'hatch', color: 4, x: 201, z: 0.5, h: 1 }, { key: 'z', kind: 'sedan', color: 9, x: -80, z: 0, h: 0 }];
  const d = diffCars(A, B, 2);
  assert.equal(d.same, 2, 'a by its key, the keyless one by its place');
  assert.equal(d.sameLook, 2);
  assert.equal(d.moved, 1, 'b is on both screens, 20 m apart');
  assert.deepEqual(d.onlyA.map((c) => c.key), ['g#1']);
  assert.deepEqual(d.onlyB.map((c) => c.key), ['z']);
  assert.equal(d.agree, 2 / 5);
  assert.deepEqual(whyAlone(d.onlyA), { ghost: 1, shared: 0, local: 0 });
  assert.equal(diffCars([], []).agree, 1);
  assert.ok(Math.abs(headingGap(3.1, -3.1) - (2 * Math.PI - 6.2)) < 1e-9);
});

test('peersNear keeps the peers within reach, nearAny asks about a point, a Trail remembers', () => {
  const remotes = new Map([['u1', { uid: 'u1', x: 10, z: 0 }], ['u2', { uid: 'u2', x: ROOM_R + 50, z: 0 }], ['u3', { uid: 'u3', x: NaN, z: 0 }]]);
  const out = peersNear(remotes.values(), 0, 0, [{ x: 9, z: 9, id: 'old' }, { x: 1, z: 1, id: 'older' }]);
  assert.deepEqual(out, [{ x: 10, z: 0, id: 'u1' }]);
  assert.equal(nearAny(out, 100, 0, 95), true);
  assert.equal(nearAny(out, 100, 0, 85), false);
  assert.equal(nearAny(null, 0, 0, 10), false);
  const tr = new Trail(), q = { x: 0, z: 0 };
  assert.equal(tr.at(5, q), null);
  for (let s = 0; s <= 300; s++) tr.push(1000 + s, s, -s);
  assert.equal(tr.at(1250, q).x, 250);
  assert.equal(tr.at(1251, q).x, 250, 'the sample at or before');
  assert.ok(tr.at(0, q).x >= 98 && tr.at(0, q).x <= 102, 'before the trail began: where it begins (200 s deep)');
  assert.equal(tr.at(9999, q).x, 300);
  tr.push(500, 7, 7);                       // the clock was stepped back
  assert.equal(tr.at(9999, q).x, 7);
});
