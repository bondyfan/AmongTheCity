// Round 8: the R train Pardubice - Praha (js/express.js) on the real Trains
// class: it leaves on the hour of game time from Pardubice hl.n. westward,
// calls only at its own stations, a rider can skip to the next one, and the
// last 6 km into Praha hl.n. are spliced on (js/railstitch.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
const { Trains, chainRailWays } = await import('../js/trains.js');
const { Express, nextDeparture, clockAt, HEADWAY, EXPRESS_STOPS } = await import('../js/express.js');
const { stitchPath } = await import('../js/railstitch.js');

const scene = { add() {}, remove() {} };
function line() {
  // one straight 12 km line east-west, Pardubice at x 0, a halt the express
  // passes, and Přelouč where it calls
  const rails = [];
  for (let x = 2000; x > -10000; x -= 1000) rails.push({ p: [[x, 0], [x - 1000, 0]], t: 'rail', _id: rails.length + 1 });
  const pois = [
    { p: [0, 8], t: 'station', n: 'Pardubice hlavní nádraží' },
    { p: [-2500, 8], t: 'station', n: 'Opočínek' },
    { p: [-6000, 8], t: 'station', n: 'Přelouč' },
  ];
  // tilesReady() on a city with no manifest asks only for the cell
  const city = { rails, pois, onTileLoaded() {}, chunkIndex: { has: () => true } };
  return city;
}

test('the timetable: on the hour of game time, the clock it prints', () => {
  assert.equal(nextDeparture(0), 0);
  assert.equal(nextDeparture(1), HEADWAY);
  assert.equal(nextDeparture(HEADWAY * 5 - 0.5), HEADWAY * 5);
  assert.equal(clockAt(100, 100, 14 / 24), '14:00');
  assert.equal(clockAt(100 + HEADWAY, 100, 14 / 24), '15:00');
  assert.ok(EXPRESS_STOPS.includes('Kolín') && EXPRESS_STOPS.includes('Praha hlavní nádraží'));
});

test('the express stands at Pardubice, runs west, passes the halt and calls at Přelouč', () => {
  const city = line();
  const tr = new Trains(scene, city);
  tr.update(0.01, null);
  const ex = new Express(tr, city);
  const o = ex._origin();
  assert.ok(o, 'Pardubice is on the route');
  ex._spawn(o.R, o.st, 20, 0, { x: 5000, z: 5000 });
  const t = ex.train;
  assert.ok(t && t.halted && t.express === 20, 'standing at the platform');
  assert.equal(t.stopName, 'Pardubice hlavní nádraží');
  const seen = [];
  let last = null;
  for (let i = 0; i < 15 * 400 && seen.length < 2; i++) {
    tr.update(1 / 15, { x: t.x, z: t.z });
    if (t.halted && t.stopName !== last) { last = t.stopName; if (last) seen.push(last); }
    if (!t.halted) last = null;
  }
  assert.ok(t.x < -100, 'it went west');
  assert.ok(!seen.includes('Opočínek'), 'the express does not call at the halt');
  assert.equal(seen[seen.length - 1], 'Přelouč');
});

test('a rider skips to the next station: the train is moved there and stands', async () => {
  const city = line();
  const tr = new Trains(scene, city);
  tr.update(0.01, null);
  const ex = new Express(tr, city);
  const o = ex._origin();
  ex._spawn(o.R, o.st, 20, 0, { x: 5000, z: 5000 });
  const t = ex.train;
  const rider = { pos: { x: t.x, z: t.z }, y: 0 };
  assert.ok(tr.board(t, rider));
  for (let i = 0; i < 15 * 30 && t.halted; i++) tr.update(1 / 15, rider.pos);
  assert.ok(!t.halted, 'left Pardubice');
  const ok = await ex.skip(null);
  assert.ok(ok, 'arrived');
  assert.ok(t.halted && t.stopName === 'Přelouč', 'standing at ' + t.stopName);
  // (the rider sits in the loco, which on a pushed set is at the far end)
  assert.ok(Math.abs(rider.pos.x - -6000) < 160, 'the rider came along: ' + rider.pos.x);
});

// The real Prague tiles, when on disk: line 010's end in the Libeň yard is
// joined to Praha hl.n. over about 6.2 km of track (the services survey
// measured 6.19 km with 25 m welds).
const TILES = new URL('../public/data/tiles/', import.meta.url);
test('real tiles: Libeň yard to Praha hl.n.', { skip: !fs.existsSync(new URL('-19_-2.json', TILES)) }, () => {
  const rails = [];
  for (let tx = -20; tx <= -17; tx++) for (let tz = -3; tz <= 0; tz++) {
    const f = new URL(tx + '_' + tz + '.json', TILES);
    if (!fs.existsSync(f)) continue;
    for (const r of JSON.parse(fs.readFileSync(f)).rails ?? []) rails.push({ p: r.p, t: r.t });
  }
  const chains = chainRailWays(rails.filter((r) => r.t !== 'tram').map((r) => ({ ...r })));
  let c = null, atEnd = true;
  for (const ch of chains) for (const e of [0, 1]) {
    const q = e ? ch.pts[ch.pts.length - 1] : ch.pts[0];
    if (Math.hypot(q[0] + 89177, q[1] + 7618) < 30 && (!c || ch.len > c.len)) { c = ch; atEnd = !!e; }
  }
  assert.ok(c, 'the Libeň end is there');
  const pts = atEnd ? c.pts : c.pts.slice().reverse();
  const tail = [];
  for (let i = Math.max(1, pts.length - 60); i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    tail.push({ x: b[0], z: b[1], hx: (b[0] - a[0]) / L, hz: (b[1] - a[1]) / L });
  }
  const r = stitchPath(rails, tail, -94575.7, -5701.1);
  assert.ok(r, 'a path');
  assert.ok(r.len > 5500 && r.len < 7000, 'length ' + r.len);
  const end = r.pts[r.pts.length - 1];
  let near = Infinity;
  for (const q of r.pts) near = Math.min(near, Math.hypot(q[0] + 94575.7, q[1] + 5701.1));
  assert.ok(near < 60, 'it passes the station (' + near.toFixed(0) + ' m)');
  void end;
});

test('two routes chained from both ends join into one line when the piece between arrives', () => {
  const mk = (x0, x1, id) => ({ p: [[x0, 0], [x1, 0]], t: 'rail', _id: id });
  const city = { rails: [mk(3000, 2000, 1), mk(2000, 1000, 2)], pois: [], onTileLoaded() {} };
  const tr = new Trains(scene, city);
  tr.update(0.01, null);
  city.rails.push(mk(-1000, -2000, 3), mk(-2000, -3000, 4));   // the far side, its own route
  tr._pending = true; tr.update(0.01, null);
  assert.equal(tr.routes.length, 2);
  city.rails.push(mk(1000, 0, 5), mk(0, -1000, 6));             // the gap closes
  tr._pending = true; tr.update(0.01, null);
  assert.equal(tr.routes.length, 1, 'one line');
  assert.ok(Math.abs(tr.routes[0].len - 6000) < 1, 'len ' + tr.routes[0].len);
});

test('a short chain doubling back from a route end is not spliced on, and the line on is reachable', () => {
  // measured at Pečky (line 010): the route reached a joint, a 270 m stub ran
  // straight back east from it and was appended, so the route turned on itself
  // there and the express shuttled back to Kolín instead of going on west
  const mk = (pts, id) => ({ p: pts, t: 'rail', _id: id });
  const city = { rails: [mk([[3000, 0], [0, 0]], 1)], pois: [], onTileLoaded() {} };
  const tr = new Trains(scene, city);
  tr.update(0.01, null);
  assert.equal(tr.routes.length, 1);
  city.rails.push(mk([[0, 0], [270, 8]], 2));                    // the stub back
  tr._pending = true; tr.update(0.01, null);
  const R = tr.routes[0];
  const xs = R.pts.map((q) => q[0]);
  assert.ok(Math.min(xs[0], xs[xs.length - 1]) <= 0.5, 'the route still ends at the joint, not on the stub');
  assert.ok(Math.abs(R.len - 3000) < 1, 'len ' + R.len);
  city.rails.push(mk([[0, 0], [-1000, 0]], 3), mk([[-1000, 0], [-2000, 0]], 4));   // the line on
  tr._pending = true; tr.update(0.01, null);
  // a train standing at the joint goes on west (joined, or by a change of route)
  if (R.pts[0][0] < R.pts[R.pts.length - 1][0]) tr._reverseRoute(R);
  const t = tr._spawn(R, 1000, 1, 3);
  t.s = tr._sHi(t); t.speed = 0;
  tr._halt(t, null, 9); t.turning = true;
  const ex = new Express(tr, city);
  ex.train = t;
  const joined = R.len > 4000;
  if (!joined) assert.ok(ex.transfer(t), 'it found the line on');
  t.turning = false;
  for (let i = 0; i < 15 * 60; i++) tr.update(1 / 15, { x: t.x, z: t.z });
  assert.ok(t.x < -200, 'it carried on west, x ' + t.x.toFixed(0));
});

test('at a chainer seam the express changes onto the route that runs on, instead of reversing', () => {
  const city = { rails: [], pois: [], onTileLoaded() {} };
  const tr = new Trains(scene, city);
  const line = (pts) => ({ pts, ys: pts.map(() => 0.18) });
  // A: 3 km from the east ending at x 0; B: a parallel track 4 m off that
  // swings onto A's line at x 0 and runs on 6 km west
  const A = tr._addRoute(line([[3000, 0], [1500, 0], [0, 0]]));
  const B = tr._addRoute(line([[3000, 4], [200, 4], [0, 0.5], [-6000, 0.5]]));
  const t = tr._spawn(A, 2000, 1, 3);
  t.s = A.len - 1; t.speed = 0;
  tr._halt(t, null, 9); t.turning = true;
  const ex = new Express(tr, city);
  ex.train = t;
  assert.ok(ex.transfer(t), 'it found the route on');
  assert.equal(t.route, B);
  t.turning = false;                         // what Express.update does after a transfer
  for (let i = 0; i < 15 * 90; i++) tr.update(1 / 15, { x: t.x, z: t.z });
  assert.ok(t.x < -300, 'it carried on west, x ' + t.x.toFixed(0));
});

test('at its station the express takes the line toward Prague, not the straightest one', () => {
  const city = { rails: [], pois: [], onTileLoaded() {} };
  const tr = new Trains(scene, city);
  const line = (pts) => ({ pts, ys: pts.map(() => 0.18) });
  // A comes in from the east and bends away south-east after the station at
  // x 0 (as the Kutná Hora line does at Kolín); B runs on west, to Prague
  const A = tr._addRoute(line([[5000, 0], [0, 0], [-300, 0], [3000, 4000]]));
  const B = tr._addRoute(line([[2000, 1], [0, 1], [-8000, 1]]));
  const t = tr._spawn(A, 1000, 1, 3);
  t.s = 5000; t.speed = 0;
  tr._halt(t, { name: 'Kolín', poi: null, s: 5000, x: 0, z: 0 }, 5);
  const ex = new Express(tr, city);
  ex.train = t;
  assert.ok(ex.towardPrague(t), 'it changed lines');
  assert.equal(t.route, B);
  assert.equal(t.dir, 1);
});

test('at Praha-Libeň the express crosses to the platform of the line that calls at Praha hl.n.', () => {
  // Review, seen in game: the express came into Praha-Libeň on a yard route
  // that ends 2 km short of Praha hl.n., while the line through to the main
  // station is a route on a platform track 30 m across. 3 km on, the yard
  // track is NEARER the station than the line (which swings round through
  // the tunnels), so the route that calls at Praha hl.n. must win outright.
  const city = { rails: [], pois: [], onTileLoaded() {} };
  const tr = new Trains(scene, city);
  const line = (pts) => ({ pts, ys: pts.map(() => 0.18) });
  const HX = -94575.7, HZ = -5701.1;
  const libeň = { n: 'Praha-Libeň' }, hln = { n: 'Praha hlavní nádraží' };
  const A = tr._addRoute(line([[HX + 9000, HZ], [HX + 5000, HZ], [HX + 2000, HZ]]));
  const B = tr._addRoute(line([[HX + 9000, HZ + 30], [HX + 5000, HZ + 30], [HX + 4000, HZ + 30], [HX + 3500, HZ - 2500], [HX, HZ + 30]]));
  A.stops = [{ poi: libeň, name: 'Praha-Libeň', s: 4000, x: HX + 5000, z: HZ }];
  B.stops = [{ poi: libeň, name: 'Praha-Libeň', s: 4000, x: HX + 5000, z: HZ + 30 },
    { poi: hln, name: 'Praha hlavní nádraží', s: B.len, x: HX, z: HZ + 30 }];
  const t = tr._spawn(A, 1000, 1, 3);
  t.s = 4000; t.speed = 0;
  tr._halt(t, A.stops[0], 5);
  const ex = new Express(tr, city);
  ex.train = t;
  t.express = 1; t.only = (n) => EXPRESS_STOPS.includes(n);
  assert.ok(ex.towardPrague(t), 'it changed platforms');
  assert.equal(t.route, B);
  assert.equal(t.dir, 1);
  assert.equal(t.station, B.stops[0], 'it stands at the same station, the stop it departs from');
  t.departed = t.station;                    // what trains.js _depart does as the doors close
  assert.equal(tr._nextStop(t)?.name, 'Praha hlavní nádraží');
});
