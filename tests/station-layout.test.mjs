// The underground of the two stations (js/station-layout.js), against the
// shipped tiles: Pardubice hlavní nádraží has five platforms and two
// underpasses, every flight comes up on the platform it is signed for, and
// everything below ground is one connected space reached from the hall.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  definitions, prepare, PARDUBICE, worldAt, landing, floorAt, flightY, nearestInside, lanes, along, inRect,
  HALF, WIDTH, DEPTH, STEPS,
} from '../js/station-layout.js';
import { tracksOf, sectorAt } from '../js/pardubice-signs.js';
import { pointInPolygon } from '../js/geo.js';

const tile = (name) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${name}.json`, import.meta.url)));
const paved = ['0_-1', '-1_-1', '0_0', '-1_0'].flatMap((n) => tile(n).paved.filter((p) => p.t === 'platform'));
const rails = ['0_-1', '-1_-1', '0_0', '-1_0'].flatMap((n) => tile(n).rails);

function station(index, top = 220) {
  const s = prepare(definitions[index]);
  for (const f of s.flights) f.top = top;
  s.bottom = top - DEPTH;
  return s;
}
const onPlatform = (s, u, v) => {
  const p = worldAt(s, u, v);
  return paved.some((poly) => pointInPolygon(p.x, p.z, poly.o));
};

test('Pardubice: five platforms carry tracks 1 to 11', () => {
  assert.equal(PARDUBICE.platforms.length, 5);
  assert.deepEqual([1, 2, 3, 4, 5].flatMap(tracksOf), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  assert.deepEqual(PARDUBICE.platforms.map((p) => p.tracks), [[null, 3], [4, 5], [6, 7], [8, 9], [10, 11]]);
  assert.deepEqual(PARDUBICE.bay.tracks, [1, 2]);
  assert.equal(sectorAt(10), 'E');
  assert.equal(sectorAt(-100), 'H');
  assert.equal(sectorAt(200), 'A');
});

test('Pardubice: two underpasses, each from the hall to all five platforms', () => {
  const s = station(1);
  for (const axis of [PARDUBICE.A, PARDUBICE.B]) {
    const mine = s.flights.filter((f) => f.axis === 'u' && Math.abs((f.a + f.b) / 2 - axis) < 22);
    assert.deepEqual([...new Set(mine.map((f) => f.to))].sort(), [1, 2, 3, 4, 5], 'underpass at u=' + axis);
  }
  const wells = s.flights.filter((f) => f.kind === 'hall');
  assert.equal(wells.length, 2);
  for (const f of wells) {
    const top = landing(f);
    assert.ok(inRect(PARDUBICE.hall, top.u, top.v - 1), 'a well opens in the hall floor');
    assert.ok(inRect(PARDUBICE.hall, f.span.u0, f.span.v0) && f.span.u1 < PARDUBICE.hall.u1, 'and lies inside the hall');
  }
  // the western underpass has moving stairs on every island, the eastern one none
  const moving = s.flights.filter((f) => f.kind === 'escalator');
  assert.deepEqual(moving.map((f) => f.to).sort(), [2, 3, 4, 5]);
  assert.ok(moving.every((f) => Math.abs(f.a) < 3));
});

test('Pardubice: every flight comes up on its own platform and none crosses a rail', () => {
  const s = station(1);
  for (const f of s.flights) {
    if (f.to === 'hall') continue;
    const pl = PARDUBICE.platforms[f.to - 1],
      { span } = f;
    assert.ok(span.v0 > pl.v0 && span.v1 < pl.v1, `flight to ${f.to} at v=${f.c} is within the platform's width`);
    for (const [u, v] of [[span.u0, span.v0], [span.u1, span.v0], [span.u0, span.v1], [span.u1, span.v1]])
      assert.ok(onPlatform(s, u, v), `corner ${u},${v} of the flight to ${f.to} is on paving`);
    const top = landing(f),
      dir = Math.sign(f.b - f.a);
    assert.ok(onPlatform(s, top.u + dir * 1.5, top.v), 'and it lands on the platform');
  }
  // no stair mouth over a track
  for (const f of s.flights) {
    if (f.to === 'hall') continue;
    for (const way of rails)
      for (const [x, z] of way.p) {
        const u = (x - s.x) * s.c + (z - s.z) * s.s,
          v = (z - s.z) * s.c - (x - s.x) * s.s;
        assert.ok(!inRect(f.span, u, v, 1), 'a rail vertex inside the mouth of the flight to ' + f.to);
      }
  }
});

test('Pardubice: each underpass is one space, from its well in the hall to every landing', () => {
  const s = station(1),
    r = 0.38,
    step = 0.25;
  const ok = (u, v) => nearestInside(s, u, v, r).d < 1e-6;
  const key = (i, j) => i * 100000 + j;
  const reach = (well) => {
    const top = landing(well),
      seen = new Set(),
      queue = [[Math.round(top.u / step), Math.round((top.v + 1) / step)]];
    assert.ok(ok(queue[0][0] * step, queue[0][1] * step), 'the top of the hall well is inside');
    seen.add(key(...queue[0]));
    while (queue.length) {
      const [i, j] = queue.pop();
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const a = i + di,
          b = j + dj;
        if (seen.has(key(a, b)) || !ok(a * step, b * step)) continue;
        seen.add(key(a, b));
        queue.push([a, b]);
      }
    }
    return seen;
  };
  const wells = s.flights.filter((f) => f.kind === 'hall'),
    spaces = wells.map(reach);
  for (const f of s.flights) {
    const top = landing(f),
      dir = Math.sign(f.b - f.a),
      u = f.axis === 'u' ? top.u - dir * 0.5 : top.u,
      v = f.axis === 'v' ? top.v - dir * 0.5 : top.v,
      cell = key(Math.round(u / step), Math.round(v / step));
    assert.equal(spaces.filter((space) => space.has(cell)).length, 1, `the landing of the flight to ${f.to} at ${top.u},${top.v} is reached from one well`);
  }
  // from either well a walker can come up on all five platforms
  for (const space of spaces) {
    const platforms = new Set();
    for (const f of s.flights) {
      const top = landing(f),
        dir = Math.sign(f.b - f.a);
      if (f.axis === 'u' && space.has(key(Math.round((top.u - dir * 0.5) / step), Math.round(top.v / step)))) platforms.add(f.to);
    }
    assert.deepEqual([...platforms].sort(), [1, 2, 3, 4, 5]);
  }
});

test('floors: a flight climbs from the corridor to its landing, the surface is not the corridor', () => {
  for (const index of [0, 1]) {
    const s = station(index);
    for (const f of s.flights) {
      const dir = Math.sign(f.b - f.a),
        at = (p) => (f.axis === 'u' ? [p, f.c] : [f.c, p]);
      assert.ok(Math.abs(flightY(s, f, ...at(f.b - dir * 0.01)) - f.top) < 0.02);
      assert.ok(flightY(s, f, ...at(f.a + dir * 0.01)) < s.bottom + (f.top - s.bottom) / STEPS + 1e-9);
      let last = -Infinity;
      for (let i = 0; i <= 60; i++) {
        const y = flightY(s, f, ...at(f.a + ((f.b - f.a) * i) / 60));
        assert.ok(y >= last - 1e-9 && y - Math.max(last, s.bottom) < 0.56, 'no step a walker cannot take');
        last = y;
      }
    }
    const room = s.rooms[0],
      u = (room.u0 + room.u1) / 2,
      v = (room.v0 + room.v1) / 2 + 7.3;
    assert.equal(floorAt(s, u, v, s.bottom + 1), s.bottom);
    assert.equal(floorAt(s, u, v, s.bottom + DEPTH + 1), null, 'somebody on the platform above is not in the corridor');
  }
});

test('Kolín is as the campaign was built round it', () => {
  const s = station(0, 200);
  assert.deepEqual(s.flights.map((f) => f.c), [-57, -41, -15, 0, 19, 35]);
  assert.deepEqual(s.rooms, [{ u0: -HALF, u1: HALF, v0: -57 - WIDTH, v1: 35 + WIDTH }]);
  const old = (u) => s.bottom + (200 - s.bottom) * Math.min(1, Math.ceil((Math.max(0, u - 2.3) / 13.8) * 24) / 24);
  for (const stop of [-57, 0, 35])
    for (let u = 2.3; u <= 16.1; u += 0.37) {
      assert.ok(Math.abs(floorAt(s, u, stop + 0.4, 999) - old(u)) < 1e-9, `step at u=${u}`);
    }
  assert.equal(floorAt(s, 0, -30, s.bottom + 1), s.bottom);
  assert.equal(floorAt(s, 0, 40, s.bottom + 1), null);
  assert.equal(floorAt(s, 16.2, 0, 999), null);
});

test('a moving stair carries up on the right of whoever climbs it', () => {
  const s = station(1);
  for (const f of s.flights) {
    const moving = lanes(f).filter((l) => l.move);
    if (f.kind === 'stairs') assert.equal(moving.length, 0);
    else {
      assert.deepEqual(moving.map((l) => l.move), [-1, 1]);
      assert.ok(moving[1].q0 >= moving[0].q1 - 1e-9, 'up is to the right of down');
    }
  }
  // climbing east, the right hand is south (+v); climbing west it is north
  const east = s.flights.find((f) => f.kind === 'escalator' && f.b > f.a),
    west = s.flights.find((f) => f.kind === 'escalator' && f.b < f.a);
  assert.ok(along(east, east.a + 1, east.c + 1).q > 0);
  assert.ok(along(west, west.a - 1, west.c - 1).q > 0);
});
