// The underground of the two stations (js/station-layout.js), against the
// shipped tiles: Pardubice hlavní nádraží has five platforms and two
// underpasses, every flight comes up on the platform it is signed for, and
// everything below ground is one connected space reached from the hall.
import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  definitions, prepare, PARDUBICE, worldAt, landing, floorAt, flightY, nearestInside, deckAt, nearestOnDeck, fencedOut, lanes, along, inRect,
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

test('the footbridge: over every track on piers that miss them, reached from platforms 2, 3 and 4', () => {
  const s = station(1);
  s.deck.y = 220 + s.deck.rise;
  for (const f of s.ramps) {
    f.base = 220;
    f.top = s.deck.y;
  }
  assert.ok(s.deck.v1 - s.deck.v0 > 250, 'it is some 290 m with its stairs');
  assert.deepEqual(s.ramps.filter((f) => f.kind === 'escalator').map((f) => f.from), [2, 3, 4, 'terminal']);
  // the rails it crosses, and how far each pier column is from the nearest
  const uc = (s.deck.u0 + s.deck.u1) / 2;
  const railGap = (u, v) => {
    let best = Infinity;
    for (const way of rails)
      for (let i = 1; i < way.p.length; i++) {
        const [a, b] = [way.p[i - 1], way.p[i]].map(([x, z]) => [(x - s.x) * s.c + (z - s.z) * s.s, (z - s.z) * s.c - (x - s.x) * s.s]);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1,
          t = Math.max(0, Math.min(1, ((u - a[0]) * (b[0] - a[0]) + (v - a[1]) * (b[1] - a[1])) / (len * len)));
        best = Math.min(best, Math.hypot(u - a[0] - t * (b[0] - a[0]), v - a[1] - t * (b[1] - a[1])));
      }
    return best;
  };
  for (const v of s.deck.piers) for (const side of [-1.15, 1.15]) assert.ok(railGap(uc + side, v) > 2.1, `pier at v=${v} stands ${railGap(uc + side, v).toFixed(2)} m from a rail`);
  for (const f of s.ramps) {
    const [u, v] = f.axis === 'u' ? [f.a, f.c] : [f.c, f.a];
    assert.ok(railGap(u, v) > 2.4, 'the foot of the ramp from ' + f.from + ' is clear of the rails');
  }
  // somebody on the platform under it is not on it; somebody at its level is
  const foot = s.ramps[0];
  assert.equal(deckAt(s, uc, 10, 220.55), null);
  assert.equal(deckAt(s, uc, 10, s.deck.y + 0.55), s.deck.y);
  assert.ok(Math.abs(deckAt(s, foot.a - 0.05, foot.c, 220.55) - 220) < 0.05, 'the ramp is stepped onto at its foot');
  assert.equal(deckAt(s, (foot.a + foot.b) / 2, foot.c, 220.55), null, 'and walked under further up');
  // the glass holds him: a step through the deck's wall comes back
  const out = nearestOnDeck(s, s.deck.u0 - 0.4, 100, 0.38);
  assert.ok(out.d > 0.7 && out.d < 0.9 && out.y === s.deck.y);
  // and every ramp is joined to the deck
  for (const f of s.ramps) {
    const dir = Math.sign(f.b - f.a),
      top = f.axis === 'u' ? [f.b + dir * 0.6, f.c] : [f.c, f.b + dir * 0.6];
    assert.ok(nearestOnDeck(s, ...top, 0.38).d < 1e-9, 'the head of the ramp from ' + f.from + ' is on the bridge');
    assert.ok(inRect(s.deck, ...top), 'and inside the deck');
  }
});

test('a stair mouth is fenced: nobody on the platform drops into it from the side', () => {
  const s = station(1),
    f = s.flights.find((x) => x.to === 2 && x.kind === 'stairs' && x.a < 10),
    mid = (f.a + f.b) / 2;
  // walking across the middle of the mouth at platform level: put back outside it
  const out = fencedOut(s, mid, f.c + f.half - 0.1, f.top, 0.38);
  assert.ok(out && out.v > f.c + f.half + 0.38 - 1e-6 && Math.abs(out.u - mid) < 1e-9);
  // on the top steps, and climbing the stairs themselves, nobody is pushed
  assert.equal(fencedOut(s, f.b - 0.4, f.c, f.top, 0.38), null);
  assert.equal(fencedOut(s, mid, f.c, s.bottom + (f.top - s.bottom) / 2 + 0.1, 0.38), null);
  // beside the mouth there is nothing to be pushed from
  assert.equal(fencedOut(s, mid, f.c + f.half + 1, f.top, 0.38), null);
  // the hall's door onto platform 1 is left free by the mouth in front of it
  const p1 = s.flights.find((x) => x.to === 1 && x.a < 10);
  assert.ok(p1.span.u0 - 0.38 > 1.4 + 2, 'two metres of the door bay stay clear of the stairs');
  // Kolín's mouths stay as they were: open
  assert.ok(!station(0).walled);
});

test('the way out of Pardubice for the campaign follows the new underpass', async () => {
  const { wayOut, stationExit } = await import('../js/prologue-route.js');
  const s = station(1);
  for (const from of [-40, 30]) {
    const path = wayOut(from),
      [first] = path;
    // it starts at the head of a flight from platform 2 in the western underpass
    const flight = s.flights.find((f) => f.to === 2 && Math.abs(f.a) < 3 && Math.sign(f.b) === Math.sign(first[0]));
    assert.ok(Math.abs(first[0] - flight.b) < 1.6 && Math.abs(first[1] - flight.c) < flight.half);
    // ...passes along the corridor and ends in the hall, by the door to the square
    assert.ok(path.some(([u, v]) => inRect(s.rooms[0], u, v)));
    const last = path.at(-1);
    assert.ok(inRect(PARDUBICE.hall, ...last));
    const exit = { u: (stationExit.x - s.x) * s.c + (stationExit.z - s.z) * s.s, v: (stationExit.z - s.z) * s.c - (stationExit.x - s.x) * s.s };
    assert.ok(Math.hypot(exit.u - last[0], exit.v - last[1]) < 8, 'the last turn is at the doors to the forecourt');
  }
});
