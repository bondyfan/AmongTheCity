import test from 'node:test';
import assert from 'node:assert/strict';
import { floorAt, storyStart, trainZ, doorX } from '../js/prologue-route.js';
import { blank, parse, serialize } from '../js/savegame.js';

function follow(points, arrival, y) {
  const [first, ...rest] = points;
  let [x, z] = first;
  for (const [endX, endZ] of rest) {
    const dx = endX - x,
      dz = endZ - z,
      count = Math.ceil(Math.hypot(dx, dz) / 0.06);
    for (let i = 0; i < count; i++) {
      x += dx / count;
      z += dz / count;
      const next = floorAt(x, z, y, arrival);
      assert.notEqual(next, null, 'disconnected floor at ' + [x, z, y]);
      y = next;
    }
  }
  return y;
}
test('the bridge, lower concourse, platform stairs, threshold and carriage aisle connect in both directions', () => {
  const station = [
    [1, 27],
    [1, 2],
    [1, -18],
    [13.7, -18],
    [doorX, -20.9],
    [doorX, trainZ],
    [4.8, trainZ]
  ];
  assert.equal(follow([[0, 68], [1.5, 40], ...station], false, 2.4), 0.18);
  assert.equal(follow([...station].reverse().concat([[1, 28.05]]), true, 0.18), 0);
  assert.equal(floorAt(1, -18, -3.6, true), -3.6);
  assert.equal(floorAt(4, -18, 0, true), null);
  assert.equal(floorAt(5, -21.6, 0, false), null, 'no boarding through a window');
  assert.equal(floorAt(3, 70, 2.4, false), null, 'bridge railing');
});
test('chapter checkpoints round-trip, fresh single player starts in Kolín and legacy saves continue', () => {
  for (const stage of ['bridge', 'station', 'coach', 'arrival', 'forecourt', 'done']) {
    assert.equal(parse(serialize({ ...blank(), prologue: stage })).state.prologue, stage);
    assert.equal(storyStart(true, 'pardubice', stage, false), stage);
  }
  assert.equal(storyStart(true, 'pardubice', null, true), 'bridge');
  assert.equal(storyStart(true, 'pardubice', null, false), null);
  assert.equal(storyStart(true, 'praha', null, true), null);
  assert.equal(storyStart(true, null, null, true), null);
  assert.equal(storyStart(false, 'pardubice', 'arrival', false), null);
  assert.equal(parse('{"v":2,"pos":{"x":20,"z":-121}}').state.prologue, null);
});

test('an evening car park keeps the two door approaches free for the handover', async () => {
  const { ParkingLots } = await import('../js/parkinglots.js');
  const parkedAtNight = (reserved) => {
    const lot = { t: 'parking', o: [[0, 0], [42, 0], [42, 18], [0, 18]] };
    const parked = [];
    const vehicles = { add: (kind, x, z, heading) => ({ kind, x, z, heading }) };
    new ParkingLots({ paved: [lot] }, vehicles, null, parked).update(1, { x: 0, z: 0 }, 0, reserved);
    return parked;
  };
  const regular = parkedAtNight(null);
  assert.ok(regular.length > 6);
  const reserved = regular[4];
  const duringHandover = parkedAtNight(reserved);
  assert.ok(duringHandover.length > 0);
  assert.ok(duringHandover.every(car => Math.hypot(car.x - reserved.x, car.z - reserved.z) >= 5));
});
