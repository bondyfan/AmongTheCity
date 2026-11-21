// Every train is the train from Kolín (Frank, 21 Nov 2026): the campaign's
// coach, doors that open at a platform, a walker who gets on by the door and
// is carried in his coach, and gets off by the door at the next stop.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
const { Trains } = await import('../js/trains.js');
const { COACH } = await import('../js/railcoach.js');
const D = await import('../js/traindeck.js');
const { doorX, PITCH } = await import('../js/prologue-coach.js');

const scene = { add() {}, remove() {} };
// one straight line east-west with two stations 3 km apart
function line() {
  const rails = [];
  for (let x = 3000; x > -6000; x -= 1000) rails.push({ p: [[x, 0], [x - 1000, 0]], t: 'rail', _id: rails.length + 1 });
  const pois = [
    { p: [0, 8], t: 'station', n: 'Pardubice-Pardubičky' },
    { p: [-3000, 8], t: 'station', n: 'Kostěnice' },
  ];
  return { rails, pois, onTileLoaded() {}, chunkIndex: { has: () => true } };
}
function world() {
  const tr = new Trains(scene, line());
  tr.update(0.01, null);
  const R = tr.routes[0];
  // toward the west: the direction in which x falls along the route
  const dir = R.pts[0][0] > R.pts[R.pts.length - 1][0] ? 1 : -1;
  return { tr, R, dir };
}
const step = (tr, t, n, each) => {
  for (let i = 0; i < n; i++) { tr.update(1 / 15, { x: t.x, z: t.z }); if (each?.() === false) return i; }
  return n;
};

test('a train is a row of the campaign\'s coach: a cab at each end, no locomotive', () => {
  const { tr, R, dir } = world();
  const t = tr._spawn(R, 1000, dir, 3);
  assert.equal(t.cars.length, 3, 'three coaches, like the train from Kolín');
  assert.ok(t.cars.every((v) => v.coach && v.len === PITCH), 'every vehicle is the coach');
  assert.equal(t.length, 3 * PITCH);
  assert.ok(t.cars[0].coach.first && t.cars[2].coach.last && !t.cars[1].coach.first && !t.cars[1].coach.last);
  // the coaches stand one slot apart, bogies on the rail
  const xs = t.cars.map((v) => v.mesh.position.x);
  assert.ok(Math.abs(Math.abs(xs[1] - xs[0]) - PITCH) < 0.01 && Math.abs(Math.abs(xs[2] - xs[1]) - PITCH) < 0.01, xs.join(' '));
  // the model the coach is built from is the campaign's own file, not a copy
  const src = fs.readFileSync(new URL('../js/railcoach.js', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bcoach\b[^}]*\} from '\.\/prologue-coach\.js'/);
  assert.ok(!/makeRailVehicle/.test(fs.readFileSync(new URL('../js/trains.js', import.meta.url), 'utf8')), 'the painted slabs are gone');
});

test('the deck of one coach: floor, steps at an open door on both sides, walls, a closed cab', () => {
  const f = D.frameAt(100, 5, 50, 0, true, false, COACH.mid, COACH.rise);   // heading 0: along -z
  const frames = [f];
  const at = (u, v) => D.toWorld(f, u, v);
  let p = at(3, 0);
  assert.deepEqual(D.locate(frames, p.x, p.z)?.i, 0);
  assert.ok(Math.abs(D.deckY(frames, p.x, p.z, 1) - (5 + COACH.rise + D.FLOOR)) < 1e-9, 'the floor, doors shut or not');
  for (const side of [-1, 1]) {
    p = at(doorX, side * 2.3);
    assert.equal(D.deckY(frames, p.x, p.z, 1), -Infinity, 'no step at a shut door');
    const y = D.deckY(frames, p.x, p.z, 0);
    assert.ok(y < 5 + COACH.rise && y > 5 - 0.2, 'the lowest step is about at the rail: ' + y);
    assert.ok(D.atDoor(frames, p.x, p.z, 0) && !D.atDoor(frames, p.x, p.z, 1));
    // through the open door; against it when it is shut
    const w = at(doorX, side * 1.51), q = { ...w };
    assert.equal(D.deckWalls(frames, q, 0.3, 0), false, 'an open door is no wall');
    assert.equal(D.deckWalls(frames, q, 0.3, 1), true, 'a shut one is');
  }
  // the seats are solid either side of the aisle, the cab's wall closes the front
  p = at(0, 1.0);
  assert.equal(D.deckWalls(frames, p, 0.3, 0), true);
  p = at(16.0, 0);
  assert.equal(D.deckWalls(frames, p, 0.3, 0), true, 'the cab end is closed');
  assert.equal(D.insideCoach(f, 16.2, 0), false);
  assert.equal(D.insideCoach(f, -10.3, 0), true, 'the gangway behind is open');
  assert.deepEqual(D.seatNear(0.3), { u: -8.2 + 3 * 2.62 + 0.84, v: 0.61 });
  assert.equal(D.seatNear(14), null, 'no seat in the vestibule');
});

test('in a bend a walker in the gangway is always in one coach or the other', () => {
  // two coaches of a train on a 120 m radius: 12.7 degrees between them
  const a = 26.7 / 120;
  const f0 = D.frameAt(0, 0, 0, 0, true, false, COACH.mid, COACH.rise);
  const hx = Math.sin(a / 2) * 26.7, hz = Math.cos(a / 2) * 26.7;
  const f1 = D.frameAt(hx, 0, hz, a, false, true, COACH.mid, COACH.rise);
  for (let k = 0; k <= 40; k++) {
    // along the aisle from the back of the front coach into the one behind
    const u = -9.5 - k * 0.05, p = D.toWorld(f0, u, 0);
    const at = D.locate([f0, f1], p.x, p.z);
    assert.ok(at, 'held at u ' + u.toFixed(2));
    assert.ok(Number.isFinite(D.deckY([f0, f1], p.x, p.z, 1)));
  }
});

test('it arrives, stops with its middle at the station, opens, and is boarded by the door', () => {
  const { tr, R, dir } = world();
  const stA = R.stops.find((s) => s.name === 'Pardubice-Pardubičky');
  const t = tr._spawn(R, stA.s - dir * 500, dir, 3);
  assert.ok(!t.halted && t.speed > 5, 'rolling in from up the line');
  assert.equal(t.closed, 1, 'doors shut on the move');
  const rider = { pos: { x: 0, z: 3.4 }, y: t.frames[0].y - COACH.rise };
  tr.player = rider;
  step(tr, t, 15 * 90, () => !t.halted);
  assert.ok(t.halted && t.stopName === 'Pardubice-Pardubičky');
  const xs = t.cars.map((v) => v.mesh.position.x);
  assert.ok(Math.abs((Math.min(...xs) + Math.max(...xs)) / 2) < 4, 'centred on the station: ' + xs.join(' '));
  assert.equal(tr.riding, null, 'standing on the platform is not riding');
  step(tr, t, 15 * 3);
  assert.ok(t.closed < 0.05, 'the doors are open: ' + t.closed);
  // up the steps of the middle coach's door and into the vestibule
  const f = t.frames[1];
  for (const v of [2.4, 1.9, 1.2, 0.4]) {
    Object.assign(rider.pos, D.toWorld(f, doorX, v));
    const y = tr.deck.support(rider.pos.x, rider.pos.z, rider.y + 0.5);
    assert.ok(Number.isFinite(y), 'something to stand on at v ' + v);
    assert.ok(tr.deck.boarding(rider.pos.x, rider.pos.z), 'the way in is open over the track strip');
    rider.y = y;
    step(tr, t, 1);
  }
  assert.equal(tr.riding, t, 'he walked in: he rides');
  assert.ok(tr.deck.carrying(rider.pos.x, rider.pos.z));
  assert.ok(Math.abs(rider.y - tr.floorY()) < 1e-6);

  // down the aisle; it leaves with him, doors shut first
  Object.assign(rider.pos, D.toWorld(f, 2, 0));
  step(tr, t, 1);
  let shutAtStart = null;
  step(tr, t, 15 * 40, () => { if (!t.halted) { shutAtStart = t.closed; return false; } });
  assert.equal(shutAtStart, 1, 'it does not move with a door open');
  const x0 = rider.pos.x;
  step(tr, t, 15 * 20);
  assert.ok(Math.abs(rider.pos.x - x0) > 50, 'carried along');
  let at = D.locate(t.frames, rider.pos.x, rider.pos.z);
  assert.ok(at && at.i === 1 && Math.abs(at.u - 2) < 0.02 && Math.abs(at.v) < 0.02, 'at the same place in his coach');
  // a moving train is no wall and no floor to anyone outside it
  const out = D.toWorld(t.frames[0], 0, 0.9);
  tr.riding = null;
  assert.equal(tr.deck.collide({ ...out }, 0.3, { interior: true, yLo: t.frames[0].y, yHi: t.frames[0].y + 1.8 }), false);
  tr.riding = t;

  // to the next station: it stops, the doors open, he walks out and the ride is over
  step(tr, t, 15 * 400, () => !t.halted);
  assert.ok(t.halted && t.stopName === 'Kostěnice', 'at ' + t.stopName);
  assert.ok(tr.alight === Trains.prototype.alight);
  step(tr, t, 15 * 3);
  at = D.locate(t.frames, rider.pos.x, rider.pos.z);
  assert.ok(at, 'still in his coach at the platform');
  for (const v of [-0.5, -1.2, -2.0, -3.0]) {
    Object.assign(rider.pos, D.toWorld(t.frames[1], doorX, v));
    step(tr, t, 1);
  }
  assert.equal(tr.riding, null, 'out of the door on the other side: on the platform');
});

test('nobody boards while the campaign plays, and a death puts the rider off', () => {
  const { tr, R, dir } = world();
  const stA = R.stops.find((s) => s.name === 'Pardubice-Pardubičky');
  const t = tr._spawn(R, stA.s, dir, 3);
  const rider = { pos: { x: 0, z: 0 }, y: 0 };
  tr.player = rider;
  step(tr, t, 15 * 30, () => !(t.halted && t.closed < 0.05));
  Object.assign(rider.pos, D.toWorld(t.frames[0], 3, 0));
  rider.y = t.frames[0].y + D.FLOOR;
  tr.locked = true;
  step(tr, t, 2);
  assert.equal(tr.riding, null, 'the campaign has its own train');
  assert.equal(tr.deck.boarding(rider.pos.x, rider.pos.z), false);
  tr.locked = false;
  step(tr, t, 2);
  assert.equal(tr.riding, t);
  tr.eject();
  assert.equal(tr.riding, null);
});
