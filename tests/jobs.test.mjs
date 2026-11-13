// Work: the generator, the pay table and the job state machine.
// Everything here is plain numbers. No city is loaded and no clock is read,
// which is the property being tested as much as any single formula.
import test from 'node:test';
import assert from 'node:assert/strict';

import { generateJobs, hash32, rng, dayKey, placeLabel, BOARD_CELL } from '../js/jobgen.js';
import { courierLimitS, courierPay, taxiLimitS, taxiPay, payEstimate, estRouteM,
  Smoothness, fmtClock, fmtDist } from '../js/jobmath.js';
import { JobRunner, validJob, ARRIVE_CAR } from '../js/jobs.js';
import { PRICE } from '../js/prices.js';

// A small town: a grid of named places of mixed trades, 240 m apart.
function town() {
  const types = ['restaurant', 'cafe', 'hotel', 'bus_stop', 'pharmacy', 'office',
    'supermarket', 'pub', 'station', 'school', 'bakery', 'clothes'];
  const out = [];
  let n = 0;
  for (let i = -8; i <= 8; i++) for (let j = -8; j <= 8; j++) {
    out.push({ id: 'p' + String(n).padStart(3, '0'), name: 'Místo ' + n, type: types[n % types.length],
      x: i * 240, z: j * 240, street: 'Ulice ' + (n % 9) });
    n++;
  }
  return out;
}
const ORIGIN = { x: 30, z: -120 };

test('the same day in the same place offers the same jobs', () => {
  const a = generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10' });
  const b = generateJobs({ places: town().reverse(), origin: { x: 400, z: -500 }, day: '2026-11-10' });
  assert.ok(a.length >= 4, `only ${a.length} offers from a town of 289 places`);
  // b reads the board from elsewhere in the SAME cell, with the places handed
  // over in the opposite order: neither may change the board
  assert.equal(Math.floor(400 / BOARD_CELL), Math.floor(ORIGIN.x / BOARD_CELL));
  assert.equal(Math.floor(-500 / BOARD_CELL), Math.floor(ORIGIN.z / BOARD_CELL));
  assert.deepEqual(b, a);
});

test('another day, another shift and another part of town are other boards', () => {
  const ids = (o) => generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10', ...o })
    .map((j) => j.id).join(',');
  const base = ids({});
  assert.notEqual(ids({ day: '2026-11-11' }), base, 'tomorrow has the same jobs as today');
  assert.notEqual(ids({ shift: 1 }), base, 'the next shift repeats the last');
  assert.notEqual(ids({ origin: { x: 1900, z: 1300 } }), base, 'every neighbourhood has one board');
});

test('offers are real pairs: both kinds, sane distances, no place used twice', () => {
  const jobs = generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10' });
  assert.ok(jobs.some((j) => j.kind === 'courier') && jobs.some((j) => j.kind === 'taxi'));
  const seen = new Set();
  for (const j of jobs) {
    assert.ok(validJob(j), 'a generated job does not pass its own validator');
    const [lo, hi] = j.kind === 'courier' ? [350, 2600] : [600, 4200];
    assert.ok(j.distM >= lo && j.distM <= hi, `${j.kind} of ${j.distM} m`);
    assert.equal(j.kind === 'taxi' ? typeof j.who : typeof j.what, 'string');
    assert.notEqual(j.to.type, j.kind === 'taxi' ? 'bus_stop' : '');
    for (const p of [j.from, j.to]) {
      const k = p.x + ',' + p.z;
      assert.ok(!seen.has(k), 'one place serves two offers on the same board');
      seen.add(k);
    }
  }
});

test('a finished job is not offered again, and an unreachable place is skipped', () => {
  const first = generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10' });
  const done = new Set([first[0].id]);
  const again = generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10', done });
  assert.ok(!again.some((j) => j.id === first[0].id), 'a job done today came back');
  // the resolver refuses every third place and moves the rest onto the "road"
  const resolve = (p) => (Number(p.id.slice(1)) % 3 === 0 ? null : { x: p.x + 5, z: p.z, street: 'Kerb' });
  const snapped = generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10', resolve });
  assert.ok(snapped.length >= 3);
  for (const j of snapped) {
    assert.equal(j.from.street, 'Kerb');
    assert.equal((j.from.x - 5) % 240 === 0 || (j.from.x - 5) % 240 === -0, true, 'the stop point was not used');
  }
  assert.deepEqual(generateJobs({ places: town(), origin: ORIGIN, day: '2026-11-10', resolve }), snapped);
});

test('no places, no jobs, no throw', () => {
  assert.deepEqual(generateJobs({ places: [], origin: ORIGIN, day: 'x' }), []);
  assert.deepEqual(generateJobs({ places: null, origin: ORIGIN, day: 'x' }), []);
  assert.deepEqual(generateJobs({ places: town(), origin: null, day: 'x' }), []);
});

test('the hash and the stream are stable across runs', () => {
  assert.equal(hash32('2026-11-10|0|0,-1|courier'), hash32('2026-11-10|0|0,-1|courier'));
  assert.notEqual(hash32('a'), hash32('b'));
  const r1 = rng(42), r2 = rng(42);
  for (let i = 0; i < 20; i++) { const v = r1(); assert.equal(v, r2()); assert.ok(v >= 0 && v < 1); }
  assert.equal(dayKey(new Date(2026, 10, 9, 23, 59)), '2026-11-09');
  assert.equal(placeLabel({ name: 'Albert', street: 'Jana Zajíce' }), 'Albert, Jana Zajíce');
  assert.equal(placeLabel({ name: 'Albert', street: null }), 'Albert');
});

// ---- pay ------------------------------------------------------------------

test('courier pay: distance sets it, time left adds to it', () => {
  const d = PRICE.job.delivery;
  const slow = courierPay({ routeM: 2000, timeLeftS: 0, limitS: 300 });
  assert.equal(slow.total, Math.round(d.base + d.perKm * 2));
  assert.equal(slow.bonus, 0);
  const fast = courierPay({ routeM: 2000, timeLeftS: 150, limitS: 300 });
  assert.equal(fast.bonus, d.bonus, 'half the clock left is the full bonus');
  assert.equal(fast.total, slow.total + d.bonus);
  const mid = courierPay({ routeM: 2000, timeLeftS: 75, limitS: 300 });
  assert.ok(mid.total > slow.total && mid.total < fast.total);
  assert.ok(courierPay({ routeM: 6000, timeLeftS: 0, limitS: 300 }).total > slow.total, 'a longer run pays the same');
});

test('courier pay: crashes and the police come off it, down to a floor', () => {
  const clean = courierPay({ routeM: 3000, timeLeftS: 100, limitS: 300 });
  const bent = courierPay({ routeM: 3000, timeLeftS: 100, limitS: 300, damage: 0.2 });
  const wanted = courierPay({ routeM: 3000, timeLeftS: 100, limitS: 300, stars: 2 });
  assert.ok(bent.total < clean.total && wanted.total < clean.total);
  assert.equal(bent.cut, clean.total - bent.total, 'the breakdown does not add up');
  const worst = courierPay({ routeM: 3000, timeLeftS: 100, limitS: 300, damage: 5, stars: 5 });
  assert.ok(worst.total >= Math.floor(clean.total * 0.25) && worst.total > 0, 'a delivered parcel paid nothing');
  for (const bad of [NaN, -1, undefined]) {
    const p = courierPay({ routeM: 3000, timeLeftS: 100, limitS: 300, damage: bad, stars: bad });
    assert.ok(Number.isFinite(p.total) && p.total > 0);
  }
});

test('taxi pay: the metres, plus a smooth-driving share', () => {
  const t = PRICE.job.taxi;
  const rough = taxiPay({ routeM: 4000, smooth: 0 });
  const silk = taxiPay({ routeM: 4000, smooth: 1 });
  assert.equal(rough.total, Math.round(t.flag + t.perKm * 4));
  assert.equal(silk.total, Math.round((t.flag + t.perKm * 4) * (1 + t.smooth)));
  assert.equal(taxiPay({ routeM: 4000, smooth: 7 }).total, silk.total, 'smoothness above 1 paid extra');
  assert.ok(taxiPay({ routeM: 4000, smooth: 0.5 }).total > rough.total);
  // the two jobs have to be worth choosing between
  const courier = payEstimate('courier', 3000), taxi = payEstimate('taxi', 3000);
  assert.ok(taxi > courier * 0.8 && taxi < courier * 1.8, `taxi ${taxi} against courier ${courier}`);
});

test('time limits follow the route, with a floor and a ceiling', () => {
  assert.equal(courierLimitS(10), 75, 'a job across the street is untimed or impossible');
  assert.ok(courierLimitS(5000) > courierLimitS(1000));
  assert.equal(courierLimitS(1e7), 1800);
  // navigation's free-flow seconds win over the straight-line guess
  assert.equal(courierLimitS(2000, 100), Math.round(100 * 1.55 + 40));
  assert.ok(taxiLimitS(2000, 100) > courierLimitS(2000, 100), 'a fare is less patient than a parcel');
  assert.equal(estRouteM(1000), 1350);
});

test('smoothness: braking hard and hitting things cost points, cruising does not', () => {
  const s = new Smoothness();
  let v = 0;
  for (let i = 0; i < 600; i++) { v = Math.min(14, v + 4 * 0.05); s.sample(0.05, v, 0); }
  assert.equal(s.score, 1, 'accelerating and cruising was penalised');
  for (let i = 0; i < 20; i++) { v = Math.max(0, v - 12 * 0.05); s.sample(0.05, v, 0); }
  const afterBrake = s.score;
  assert.ok(afterBrake < 1 && afterBrake > 0.8, `an emergency stop scored ${afterBrake}`);
  s.sample(0.05, 0, 0.15);
  assert.ok(s.score < afterBrake - 0.3, 'a crash cost almost nothing');
  s.rebase(); s.sample(0.05, 0, 0.9);
  assert.ok(s.score > 0, 'the next car\'s old dents were billed to this fare');
  s.reset();
  assert.equal(s.score, 1);
});

test('clock and distance read the way the HUD prints them', () => {
  assert.equal(fmtClock(245), '4:05');
  assert.equal(fmtClock(-3), '0:00');
  assert.equal(fmtClock(59.2), '1:00');
  assert.equal(fmtDist(84), '80 m');
  assert.equal(fmtDist(2440), '2,4 km');
});

// ---- the state machine ------------------------------------------------------

const JOB = (kind) => ({ id: kind + '1', kind,
  from: { name: 'Pizzerie', type: 'restaurant', x: 0, z: 0, street: 'A' },
  to: { name: 'Albert', type: 'supermarket', x: 1000, z: 0, street: 'B' },
  distM: 1000, who: kind === 'taxi' ? 'pan Dvořák' : null, what: 'oběd' });

function rig(kind) {
  const r = new JobRunner();
  const log = [];
  r.on((type, data, job) => log.push({ type, data, job }));
  const ctx = { dt: 0.1, x: -200, z: 0, speed: 10, inCar: true, carId: 1, carDamage: 0,
    stars: 0, down: false, navDest: null, routeM: null, etaS: null };
  assert.equal(r.accept(JOB(kind)), true);
  const run = (s) => { for (let t = 0; t < s; t += ctx.dt) r.update(ctx); };
  return { r, log, ctx, run, last: () => log[log.length - 1] };
}

test('a full courier job: pick up, drive, deliver, get paid by the route', () => {
  const { r, log, ctx, run, last } = rig('courier');
  assert.equal(r.state, 'toPickup');
  assert.deepEqual(r.target, JOB('courier').from);
  run(1);
  assert.equal(r.state, 'toPickup', 'picked up from 200 m away');
  ctx.x = 3; run(0.3);
  assert.equal(r.state, 'toPickup', 'a drive-by at 36 km/h counted as a stop');
  ctx.speed = 0; run(0.2);
  assert.equal(r.state, 'toDrop');
  assert.equal(last().type, 'pickup');
  // navigation still holds the OLD destination for a frame: must not be used
  ctx.navDest = { x: 0, z: 0 }; ctx.routeM = 5; ctx.etaS = 1; run(0.2);
  assert.equal(r.limitS, 0, 'the route to the pick-up timed the delivery');
  ctx.navDest = { x: 1000, z: 0 }; ctx.routeM = 1400; ctx.etaS = 120; run(0.1);
  assert.equal(r.limitS, courierLimitS(1400, 120));
  assert.equal(r.routeM, 1400);
  ctx.speed = 12; ctx.x = 500; run(60);
  assert.ok(r.timeLeft > 0 && r.timeLeft < r.limitS);
  ctx.x = 995; ctx.speed = 0; run(0.2);
  assert.equal(r.state, 'idle');
  const done = last();
  assert.equal(done.type, 'done');
  assert.equal(done.job.id, 'courier1');
  assert.equal(done.data.pay.total,
    courierPay({ routeM: 1400, timeLeftS: done.data.timeLeftS, limitS: r.limitS || done.data.limitS }).total);
  assert.ok(done.data.pay.total > PRICE.job.delivery.base);
  assert.equal(log.filter((e) => e.type === 'done').length, 1, 'paid twice');
});

test('a courier may finish on foot, and with no route gets an estimated clock', () => {
  const { r, ctx, run, last } = rig('courier');
  ctx.inCar = false; ctx.speed = 3; ctx.x = 5;
  run(0.2);
  assert.equal(r.state, 'toDrop', 'on foot at the door did not collect the parcel');
  run(3);
  assert.equal(r.limitS, courierLimitS(estRouteM(1000)), 'no route and still no clock');
  ctx.x = 996; run(0.2);
  assert.equal(last().type, 'done');
});

test('a late parcel fails cleanly, and so does an abandoned one', () => {
  const a = rig('courier');
  a.ctx.x = 0; a.ctx.speed = 0; a.run(0.2);
  a.ctx.x = 400; a.ctx.speed = 1; a.run(400);
  assert.equal(a.r.state, 'idle');
  assert.deepEqual(a.last().data, { reason: 'late' });
  assert.equal(a.last().type, 'failed');
  assert.equal(a.r.job, null);
  assert.equal(a.r.target, null);
  a.r.update(a.ctx);                       // idle update is a no-op
  assert.equal(a.r.accept(JOB('courier')), true, 'the runner is stuck after a failure');

  const b = rig('taxi');
  assert.equal(b.r.accept(JOB('courier')), false, 'two jobs at once');
  b.r.abandon();
  assert.deepEqual(b.last().data, { reason: 'abandon' });
  b.r.abandon();
  assert.equal(b.log.filter((e) => e.type === 'failed').length, 1);
});

test('damage and stars on the way reduce a delivery; another car\'s old dents do not', () => {
  const { r, ctx, run, last } = rig('courier');
  ctx.x = 0; ctx.speed = 0; ctx.carDamage = 0.5; run(0.2);     // arrived already bent
  ctx.navDest = { x: 1000, z: 0 }; ctx.routeM = 1400; ctx.etaS = 120;
  ctx.speed = 10; ctx.x = 300; run(1);
  ctx.carDamage = 0.7; run(1);                                  // +0.2 fresh
  ctx.carId = 2; ctx.carDamage = 1.1; run(1);                   // swapped into a wreck
  ctx.stars = 2; run(1); ctx.stars = 0;
  ctx.x = 1000; ctx.speed = 0; run(0.2);
  const d = last().data;
  assert.ok(Math.abs(d.damage - 0.2) < 1e-9, `billed ${d.damage} of damage`);
  assert.equal(d.stars, 2, 'the stars cooled off and were forgotten');
  assert.ok(d.pay.cut > 0);
});

test('a full taxi ride: needs a car, loads the fare, pays for smoothness', () => {
  const { r, log, ctx, run, last } = rig('taxi');
  ctx.inCar = false; ctx.x = 2; ctx.speed = 0; run(0.3);
  assert.equal(r.state, 'toPickup', 'a fare got into a car that is not there');
  assert.equal(log.filter((e) => e.type === 'needCar').length, 1, 'the hint fired every frame');
  ctx.inCar = true; run(0.5);
  assert.equal(r.state, 'loading');
  ctx.speed = 8; run(0.2);
  assert.equal(r.state, 'toPickup', 'drove off mid-boarding and still got the fare');
  ctx.speed = 0; run(2.2);
  assert.equal(r.state, 'toDrop');
  ctx.navDest = { x: 1000, z: 0 }; ctx.routeM = 1500; ctx.etaS = 130; run(0.1);
  assert.equal(r.limitS, taxiLimitS(1500, 130));
  // pull away, cruise and pull up the way a passenger likes it: 3 m/s2 at most
  for (let v = 0; v < 12; v += 0.3) { ctx.speed = v; r.update(ctx); }
  ctx.speed = 12; ctx.x = 600; run(30);
  for (let v = 12; v > 1; v -= 0.3) { ctx.speed = v; r.update(ctx); }
  ctx.x = 1000 - ARRIVE_CAR + 1; ctx.speed = 1; run(0.2);
  const d = last();
  assert.equal(d.type, 'done');
  assert.equal(d.data.smooth, 1);
  assert.equal(d.data.pay.total, taxiPay({ routeM: 1500, smooth: 1 }).total);
});

test('a taxi fare walks out of a wreck, an empty car and a ride that never ends', () => {
  const ride = () => { const g = rig('taxi'); g.ctx.x = 0; g.ctx.speed = 0; g.run(2.5);
    assert.equal(g.r.state, 'toDrop'); g.ctx.x = 300; return g; };
  const a = ride(); a.ctx.carDamage = 1.05; a.run(0.2);
  assert.deepEqual(a.last().data, { reason: 'wreck' });
  const b = ride(); b.ctx.inCar = false; b.run(20);
  assert.equal(b.r.state, 'toDrop', 'a short stop lost the fare');
  b.run(15);
  assert.deepEqual(b.last().data, { reason: 'left' });
  const c = ride(); c.ctx.speed = 0.5; c.run(600);
  assert.deepEqual(c.last().data, { reason: 'patience' });
  const d = ride(); d.ctx.down = true; d.run(0.1);
  assert.deepEqual(d.last().data, { reason: 'down' });
});

test('a job survives a reload at the two stages that can, and nowhere else', () => {
  const a = rig('courier');
  const early = JSON.parse(JSON.stringify(a.r.toJSON()));
  assert.equal(early.state, 'toPickup');
  a.ctx.x = 0; a.ctx.speed = 0; a.run(0.2);
  a.ctx.navDest = { x: 1000, z: 0 }; a.ctx.routeM = 1400; a.ctx.etaS = 120; a.run(20);
  const mid = JSON.parse(JSON.stringify(a.r.toJSON()));
  assert.equal(mid.state, 'toDrop');
  const r2 = new JobRunner();
  assert.equal(r2.restore(mid), true);
  assert.equal(r2.limitS, a.r.limitS);
  assert.ok(Math.abs(r2.elapsed - a.r.elapsed) <= 1);
  assert.equal(r2.target.name, 'Albert');
  assert.equal(r2.restore(early), false, 'restored over a running job');
  // a fare in the back seat is not written at all
  const t = rig('taxi'); t.ctx.x = 0; t.ctx.speed = 0; t.run(2.5);
  assert.equal(t.r.toJSON(), null);
  // and garbage is refused rather than adopted
  for (const bad of [null, {}, { job: { id: 1 }, state: 'toDrop' }, { job: JOB('taxi'), state: 'toDrop' },
    { job: JOB('courier'), state: 'flying' }]) assert.equal(new JobRunner().restore(bad), false);
});

// The result toast prints the parts next to the total ("jízdné 701 Kč,
// plynulost +280 Kč, +982 Kč" was seen on screen): whatever the route length,
// the printed parts must sum to what the wallet receives.
test('a pay breakdown always adds up to its total', () => {
  for (let m = 137; m < 9000; m += 211) {
    for (const k of [0, 0.31, 0.5, 0.77, 1]) {
      const t = taxiPay({ routeM: m, smooth: k });
      assert.equal(t.fare + t.bonus, t.total, 'taxi at ' + m + ' m, smooth ' + k);
      const c = courierPay({ routeM: m, timeLeftS: 200 * k, limitS: 300, damage: 0.3 * k, stars: k > 0.6 ? 1 : 0 });
      assert.equal(c.gross + c.bonus - c.cut, c.total, 'courier at ' + m + ' m');
      assert.ok(c.cut >= 0);
    }
  }
});
