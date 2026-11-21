// ---- riding along in a peer's car: the parts with no three.js in them ----------
// js/netride.js: who sits where (the seat book), what a passenger's eye rides
// on (follow), and what ends a ride nobody ended with E (makeRides). The proxy
// car itself and a real Player walking up to it are tests/netride-proxy.test.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { makeSeatBook, seatsOf, follow, rideFate, makeRides, WALK_OFF_V, QUIET_S } from '../js/netride.js';

const A = 'anna:01', B = 'bob:02', C = 'cyril:03', D = 'dana:04';

// ---- seats ---------------------------------------------------------------------
test('the wheel of a peer\'s car is never the seat on offer', () => {
  const book = makeSeatBook();
  for (const kind of ['octavia', 'tesla', 'roadster', 'van', 'bus', 'truck', 'nonsense'])
    assert.ok(book.seatFor(A, seatsOf(kind), B) >= 1, kind + ' offered seat 0');
  // …and a claim on it is not a claim
  assert.equal(book.claim(B, A, 0), false);
  assert.equal(book.size, 0);
});

test('the second passenger gets the next seat, and a full car says so', () => {
  const book = makeSeatBook();
  assert.equal(book.seatFor(A, seatsOf('octavia'), B), 1);
  book.claim(B, A, 1);
  assert.equal(book.seatFor(A, seatsOf('octavia'), C), 2, 'two passengers were offered one seat');
  book.claim(C, A, 2);
  book.claim(D, A, 3);
  assert.equal(book.seatFor(A, seatsOf('octavia'), 'eva:05'), -1, 'a full Octavia still had a seat');
  // my own claim does not make the car full for me
  assert.equal(book.seatFor(A, seatsOf('octavia'), B), 1);
  // a two-seater is full after one
  const r = makeSeatBook();
  r.claim(B, A, 1);
  assert.equal(r.seatFor(A, seatsOf('roadster'), C), -1);
  // a bus seats seven beside its driver
  const bus = makeSeatBook();
  for (let s = 1; s <= 7; s++) { assert.equal(bus.seatFor(A, seatsOf('bus'), 'p:' + s), s); bus.claim('p:' + s, A, s); }
  assert.equal(bus.seatFor(A, seatsOf('bus'), 'late:99'), -1);
});

test('a seat in one car says nothing about the same seat in another', () => {
  const book = makeSeatBook();
  book.claim(B, A, 1);
  assert.equal(book.seatFor(D, seatsOf('octavia'), C), 1);
  assert.equal(book.holder(D, 1), null);
});

test('two who press E inside one round trip: the lower uid keeps the seat', () => {
  // each client hears the other's claim after it has made its own
  const onB = makeSeatBook(), onC = makeSeatBook();
  onB.claim(C, A, 1);
  onC.claim(B, A, 1);
  assert.equal(onB.beaten(B, A, 1, false), null, 'the lower uid gave way');
  assert.equal(onC.beaten(C, A, 1, false), B, 'the higher uid kept walking to a taken seat');
  // a third client sees both and names the same holder
  const onD = makeSeatBook();
  onD.claim(C, A, 1); onD.claim(B, A, 1);
  assert.equal(onD.holder(A, 1), B);
});

test('somebody already seated beats somebody walking up, whatever the uids', () => {
  const book = makeSeatBook();
  book.observe(C, { k: 'car', st: 1, ho: A });          // C is IN seat 1
  assert.equal(book.beaten(B, A, 1, false), C, 'a walk-up took a seat somebody sits in');
  assert.equal(book.seatFor(A, 4, B), 2);
  // and C, seated, is not put out by B's late claim event
  const onC = makeSeatBook();
  onC.claim(B, A, 1);
  assert.equal(onC.beaten(C, A, 1, true), null);
});

test('the state packet is the seat: in while it says so, out when it stops', () => {
  const book = makeSeatBook();
  book.observe(B, { k: 'car', st: 1, ho: A });
  assert.equal(book.holder(A, 1), B);
  book.observe(B, { k: 'car', st: 1, ho: A });
  assert.equal(book.size, 1);
  book.observe(B, null);                                 // stepped out
  assert.equal(book.holder(A, 1), null);
  // a driver's own packet (seat 0, no host) is nobody's passenger
  book.observe(A, { k: 'car', st: 0 });
  assert.equal(book.size, 0);
  // an older client's passenger names no host: not in the book, and not an error
  book.observe(C, { k: 'car', st: 1 });
  assert.equal(book.size, 0);
});

test('a walk-up claim survives packets that still show the walker on foot', () => {
  const book = makeSeatBook();
  book.claim(B, A, 1);
  for (let i = 0; i < 30; i++) book.observe(B, null);    // three seconds of walking
  assert.equal(book.holder(A, 1), B, 'the walk-up lost its seat to its own packets');
  // …and the claim event arriving after the seated packet does not un-seat him
  book.observe(B, { k: 'car', st: 1, ho: A });
  book.claim(B, A, 1);
  assert.equal(book.beaten(C, A, 1, false), B);
  book.tick(60);
  assert.equal(book.holder(A, 1), B, 'a seated passenger timed out');
});

test('a claim nobody released runs out; a release names what it releases', () => {
  const book = makeSeatBook({ ttl: 25 });
  book.claim(B, A, 1);
  book.tick(24);
  assert.equal(book.holder(A, 1), B);
  book.tick(2);
  assert.equal(book.holder(A, 1), null, 'a lost release locked the seat for good');
  // the release for the last car arrives after the claim for the next one
  book.claim(B, D, 2);
  book.release(B, A, 1);
  assert.equal(book.holder(D, 2), B, 'an old release wiped the new claim');
  book.release(B, D, 2);
  assert.equal(book.size, 0);
});

test('a peer who leaves frees their seat and everything in their car', () => {
  const book = makeSeatBook();
  book.claim(B, A, 1); book.claim(C, A, 2); book.claim(D, B, 1);
  book.forget(A);
  assert.equal(book.holder(A, 1), null);
  assert.equal(book.holder(A, 2), null);
  assert.equal(book.holder(B, 1), D);
});

test('the wire is parsed, never trusted', () => {
  const book = makeSeatBook();
  for (const [uid, ho, s] of [[B, A, 1.5], [B, A, 8], [B, A, -1], [B, A, '1'], [B, B, 1], [B, '', 1],
    [B, 'x'.repeat(200), 1], [null, A, 1], [B, A, NaN]])
    assert.equal(book.claim(uid, ho, s), false, JSON.stringify([uid, ho, s]));
  book.observe(B, { st: 1, ho: B });                     // in his own car as a passenger
  book.observe(B, { st: 99, ho: A });
  book.observe(B, { st: 'x', ho: A });
  assert.equal(book.size, 0);
  // a flood of invented claimants cannot grow the book without bound
  for (let i = 0; i < 5000; i++) book.claim('bot:' + i, A, 1 + (i % 7));
  assert.ok(book.size <= 96, 'the book holds ' + book.size + ' claims');
});

// ---- the passenger's eye -------------------------------------------------------
test('follow: no lag at a steady speed', () => {
  const o = { x: 0, v: 20 };
  let g = 0;
  for (let i = 0; i < 600; i++) { g += 20 / 60; follow(o, g, 20, 9, 1 / 60); }
  assert.ok(Math.abs(o.x - g) < 1e-6, 'the rider trails the car by ' + (g - o.x).toFixed(3) + ' m');
  assert.ok(Math.abs(o.v - 20) < 1e-6);
});

test('follow: a packet that lands late bends the velocity, it does not break it', () => {
  // 25 m/s; the target jumps half a metre (a packet 20 ms late). The fixed-rate
  // ease netvehicles uses for a car nobody rides turns that into a step of
  // 0.5 m × 12/s = 6 m/s in ONE frame, and the camera is rigid to the car.
  const dt = 1 / 60, o = { x: 0, v: 25 };
  let g = 0, worst = 0, prev = 25;
  for (let i = 0; i < 240; i++) {
    g += 25 * dt;
    if (i === 60) g += 0.5;
    follow(o, g, 25, 9, dt);
    worst = Math.max(worst, Math.abs(o.v - prev));
    prev = o.v;
  }
  assert.ok(worst < 0.75, 'the velocity stepped by ' + worst.toFixed(2) + ' m/s in one frame');
  assert.ok(Math.abs(o.x - g) < 0.01, 'and the half metre was never made up');
});

test('follow: one long frame lands where many short ones do', () => {
  const a = { x: 0, v: 3 }, b = { x: 0, v: 3 };
  follow(a, 5 + 2 * 0.1, 2, 9, 0.1);
  for (let i = 1; i <= 100; i++) follow(b, 5 + 2 * 0.001 * i, 2, 9, 0.001);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.v - b.v) < 1e-6);
  // and a huge step is stable rather than explosive
  const c = { x: 0, v: 40 };
  follow(c, 10, 0, 9, 5);
  assert.ok(Math.abs(c.x - 10) < 1e-3 && Math.abs(c.v) < 1e-3);
});

test('follow: when the packets stop the car comes to rest, without flying on', () => {
  const dt = 1 / 60, o = { x: 0, v: 25 };
  let peak = 0;
  for (let i = 0; i < 180; i++) { follow(o, 0, 0, 9, dt); peak = Math.max(peak, o.x); }
  assert.ok(peak < 1.2, 'it ran on ' + peak.toFixed(2) + ' m past where the driver was last heard');
  assert.ok(Math.abs(o.x) < 0.01 && Math.abs(o.v) < 0.01);
});

// ---- what ends a ride ----------------------------------------------------------
test('rideFate: gone, driven off, or carry on', () => {
  const veh = { gone: false, speed: 0 };
  assert.equal(rideFate(veh, false, 'walk'), null);
  assert.equal(rideFate({ ...veh, speed: WALK_OFF_V + 0.1 }, false, 'walk'), 'left');
  assert.equal(rideFate({ ...veh, speed: -(WALK_OFF_V + 0.1) }, false, 'walk'), 'left', 'reversing away counts');
  // a hand already on the handle goes with the car; so does a seated body
  assert.equal(rideFate({ ...veh, speed: 9 }, false, 'open'), null);
  assert.equal(rideFate({ ...veh, speed: 40 }, true, undefined), null);
  assert.equal(rideFate({ ...veh, gone: true }, true, undefined), 'gone');
  assert.equal(rideFate({ ...veh, gone: true }, false, 'walk'), 'gone');
  assert.equal(rideFate(null, true), 'gone');
});

// a Player reduced to what makeRides reads and writes
function rig(me = B) {
  const sent = [], left = [], quiet = [];
  const player = { pos: { x: 0, z: 0 }, y: 0, heading: 0, inCar: null, seat: 0, boarding: null };
  const rides = makeRides({
    player, self: () => me,
    send: (type, data) => sent.push({ type, ...data }),
    // what main.js does with it: the body leaves the car
    leave: (why, uid) => { left.push([why, uid]); player.boarding = null; player.inCar = null; },
    quiet: (uid) => quiet.push(uid),
  });
  const proxy = (uid = A) => ({ proxy: true, uid, kind: 'octavia', x: 10, z: 20, y: 1, heading: 0.5,
    speed: 0, quiet: 0, gone: false, seats: [] });
  return { player, rides, sent, left, quiet, proxy };
}

test('the room hears the walk-up, and hears the seat given back whichever way the ride ends', () => {
  const { player, rides, sent, proxy } = rig();
  const car = proxy();
  rides.update(1 / 60);
  assert.equal(sent.length, 0, 'on foot, alone, and something was sent');
  player.boarding = { veh: car, seat: rides.seatFor(car), phase: 'walk' };
  rides.update(1 / 60);
  assert.deepEqual(sent, [{ type: 'seat_claim', ho: A, s: 1, on: 1 }]);
  // seated in the same seat: nothing more to say (the state packet carries it now)
  player.boarding = null; player.inCar = car; player.seat = 1;
  for (let i = 0; i < 300; i++) rides.update(1 / 60);
  assert.equal(sent.length, 1);
  // out by ANY path: an arrest, a respawn and E all just clear inCar
  player.inCar = null;
  rides.update(1 / 60);
  assert.deepEqual(sent[1], { type: 'seat_claim', ho: A, s: 1, on: 0 });
  rides.update(1 / 60);
  assert.equal(sent.length, 2);
});

test('a local car, a helicopter and a parked car are none of its business', () => {
  const { player, rides, sent, left } = rig();
  player.inCar = { kind: 'octavia', x: 0, z: 0, heading: 0, seats: [] };   // no `proxy`
  player.seat = 1;
  for (let i = 0; i < 10; i++) rides.update(1 / 60);
  assert.equal(sent.length, 0);
  assert.equal(left.length, 0);
  assert.deepEqual(player.pos, { x: 0, z: 0 });
});

test('the seat it offers is the one the book leaves free', () => {
  const { rides, proxy } = rig();
  const car = proxy();
  assert.equal(rides.seatFor(car), 1);
  rides.onEvent({ type: 'seat_claim', from: C, ho: A, s: 1, on: 1 });
  assert.equal(rides.seatFor(car), 2);
  rides.observe(D, { k: 'car', st: 2, ho: A });
  assert.equal(rides.seatFor(car), 3);
  rides.onEvent({ type: 'seat_claim', from: C, ho: A, s: 1, on: 0 });
  assert.equal(rides.seatFor(car), 1);
  rides.forget(D);
  // an event the relay did not sign, or one that is not a claim at all
  rides.onEvent({ type: 'seat_claim', ho: A, s: 1, on: 1 });
  rides.onEvent(null);
  assert.equal(rides.seatFor(car), 1);
});

test('two pressed E at once: the one with the higher uid is walked away, and says so once', () => {
  const { player, rides, left, sent, proxy } = rig(C);      // we are Cyril; Bob has the lower uid
  const car = proxy();
  player.boarding = { veh: car, seat: 1, phase: 'walk' };
  rides.update(1 / 60);
  rides.onEvent({ type: 'seat_claim', from: B, ho: A, s: 1, on: 1 });   // his claim crosses ours
  rides.update(1 / 60);
  assert.deepEqual(left, [['rival', B]]);
  rides.update(1 / 60);
  assert.equal(left.length, 1);
  assert.deepEqual(sent.at(-1), { type: 'seat_claim', ho: A, s: 1, on: 0 });
  // pressing E again takes the seat that IS free
  assert.equal(rides.seatFor(car), 2);
});

test('…and the one with the lower uid just keeps walking', () => {
  const { player, rides, left, proxy } = rig(B);
  player.boarding = { veh: proxy(), seat: 1, phase: 'walk' };
  rides.update(1 / 60);
  rides.onEvent({ type: 'seat_claim', from: C, ho: A, s: 1, on: 1 });
  for (let i = 0; i < 60; i++) rides.update(1 / 60);
  assert.equal(left.length, 0);
});

test('the driver pulls away during the walk-up: the walk is over', () => {
  const { player, rides, left, proxy } = rig();
  const car = proxy();
  player.boarding = { veh: car, seat: 1, phase: 'walk' };
  car.speed = 2.5;                                 // creeping: keep after it
  rides.update(1 / 60);
  assert.equal(left.length, 0);
  car.speed = 8;
  rides.update(1 / 60);
  assert.deepEqual(left, [['left', A]]);
});

test('the car disappears under a seated passenger: put down, once', () => {
  const { player, rides, left, sent, proxy } = rig();
  const car = proxy();
  player.inCar = car; player.seat = 1;
  rides.update(1 / 60);
  car.gone = true;                                 // the driver stepped out, or left the room
  rides.update(1 / 60);
  assert.deepEqual(left, [['gone', A]]);
  rides.update(1 / 60);
  assert.equal(left.length, 1);
  assert.deepEqual(sent.at(-1), { type: 'seat_claim', ho: A, s: 1, on: 0 });
});

test('a seated body is on the pose the car is DRAWN at this frame', () => {
  const { player, rides, proxy } = rig();
  const car = proxy();
  player.inCar = car; player.seat = 1;
  car.x = 123.4; car.z = -55.5; car.y = 7.25; car.heading = 1.25;
  rides.update(1 / 60);
  assert.deepEqual(player.pos, { x: 123.4, z: -55.5 });
  assert.equal(player.y, 7.25);
  assert.equal(player.heading, 1.25);
});

test('a driver whose packets stop is mentioned once, and the passenger stays seated', () => {
  const { player, rides, left, quiet, proxy } = rig();
  const car = proxy();
  player.inCar = car; player.seat = 1;
  for (let t = 0; t < 20; t += 0.5) { car.quiet = t; rides.update(0.5); }
  assert.deepEqual(quiet, [A], 'said ' + quiet.length + ' times');
  assert.equal(left.length, 0, 'a lag spike threw the passenger out');
  assert.ok(QUIET_S > 2, 'an ordinary hiccup must not reach the hint');
  // he comes back, goes quiet again: it may be said again
  car.quiet = 0.1; rides.update(0.5);
  car.quiet = QUIET_S + 1; rides.update(0.5);
  assert.equal(quiet.length, 2);
});

test('the session ending forgets everybody else and still squares our own seat', () => {
  const { player, rides, sent, left, proxy } = rig();
  const car = proxy();
  rides.onEvent({ type: 'seat_claim', from: C, ho: A, s: 2, on: 1 });
  player.inCar = car; player.seat = 1;
  rides.update(1 / 60);
  car.gone = true;                                 // every proxy dies with the session
  rides.reset();
  rides.update(1 / 60);
  assert.equal(rides.book.size, 0);
  assert.deepEqual(left, [['gone', A]]);
  rides.update(1 / 60);
  assert.deepEqual(sent.at(-1), { type: 'seat_claim', ho: A, s: 1, on: 0 });
});
