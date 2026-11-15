// Round 8: the long haul, Pardubice to Prague and back. Offered once per game
// day per direction near its depot, timed for the D11 (not the town's half
// hour), paid at the courier rate, and it survives a save mid-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import { haulOffers, gameDay, DEPOTS, HAUL_R } from '../js/haul.js';
import { haulLimitS, courierLimitS, payEstimate, estRouteM, courierPay } from '../js/jobmath.js';
import { JobRunner, validJob } from '../js/jobs.js';

test('offered near its origin depot only, once per game day, same id everywhere', () => {
  const p = DEPOTS.pardubice;
  const a = haulOffers({ x: p.x + 500, z: p.z, day: 7 });
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'haul');
  assert.equal(a[0].to.name, DEPOTS.praha.name);
  assert.ok(a[0].distM > 85000 && a[0].distM < 90000, 'bee line ' + a[0].distM);
  assert.ok(validJob(a[0]));
  assert.deepEqual(haulOffers({ x: p.x + 500, z: p.z, day: 7 }), a, 'deterministic');
  assert.notEqual(haulOffers({ x: p.x, z: p.z, day: 8 })[0].id, a[0].id, 'a new run tomorrow');
  assert.equal(haulOffers({ x: p.x, z: p.z, day: 7, done: new Set([a[0].id]) }).length, 0, 'done today');
  assert.equal(haulOffers({ x: p.x + HAUL_R + 100, z: p.z, day: 7 }).length, 0, 'too far from the depot');
  const back = haulOffers({ x: DEPOTS.praha.x, z: DEPOTS.praha.z, day: 7 });
  assert.equal(back.length, 1);
  assert.equal(back[0].to.name, DEPOTS.pardubice.name);
  assert.equal(gameDay(0, 10.5 / 24, 1440), 0);
  assert.equal(gameDay(1440 * 3 + 5, 10.5 / 24, 1440), 3);
});

test('timed for the motorway and paid fairly against town work', () => {
  const job = haulOffers({ x: DEPOTS.pardubice.x, z: DEPOTS.pardubice.z, day: 1 })[0];
  const routeM = estRouteM(job.distM);
  const lim = haulLimitS(routeM);
  assert.ok(lim >= 2700 && lim <= 7200, 'limit ' + lim);
  assert.ok(lim > courierLimitS(routeM), 'not the town cap');
  assert.equal(courierLimitS(1e7), 1800, 'the courier cap stands');
  const best = payEstimate('haul', job.distM);
  assert.ok(best >= 5000 && best <= 6200, 'best pay ' + best);
  const gross = courierPay({ routeM, timeLeftS: 0, limitS: lim, kind: 'haul' }).gross;
  // about the in-town rate per hour of driving (3 700 Kč/h for a 4 km job)
  assert.ok(gross / (lim / 3600) > 3000 && gross / (lim / 3600) < 6000);
});

test('a haul runs: picked up, timed at once, delivered and paid; a save mid-trip restores', () => {
  const job = haulOffers({ x: DEPOTS.pardubice.x, z: DEPOTS.pardubice.z, day: 3 })[0];
  const r = new JobRunner();
  const ev = [];
  r.on((t, d) => ev.push([t, d]));
  assert.ok(r.accept(job));
  const ctx = (x, z, dt = 0.5) => ({ dt, x, z, speed: 0, inCar: true, carId: 1, carDamage: 0, stars: 0,
    down: false, navDest: null, routeM: null, etaS: null });
  r.update(ctx(job.from.x, job.from.z));
  assert.equal(r.state, 'toDrop');
  r.update(ctx(job.from.x + 100, job.from.z));
  assert.ok(r.limitS >= 2700, 'timed without waiting for a route');
  const saved = JSON.parse(JSON.stringify(r.toJSON()));
  const r2 = new JobRunner();
  const done = [];
  r2.on((t, d) => done.push([t, d]));
  assert.ok(r2.restore(saved), 'restored');
  assert.equal(r2.state, 'toDrop');
  assert.equal(r2.limitS, r.limitS, 'the clock came back with it');
  r2.update(ctx(job.to.x, job.to.z, 1));
  const fin = done.find(([t]) => t === 'done');
  assert.ok(fin, 'delivered');
  assert.ok(fin[1].pay.total > 5000, 'paid ' + fin[1].pay.total);
  assert.equal(r2.state, 'idle');
});
