// ---- cyclists in the real town ----------------------------------------------
// The fixtures say the parts work. This is the whole of it on the real tiles,
// the way the game runs it: the traffic, the crowd and the riders round the
// Palackého crossing for three minutes of a weekday noon (tests/flow-harness.mjs
// builds the town). What it pins was each measured going wrong first:
//   - the first build had passing lorries knocking riders off the kerb edge
//     (two in three minutes); the traffic and the riders now share a street
//   - riders that hold the lane, or wait at kerbs, must not jam the cars
//   - one ride in ten was a kilometre lost among the footways of an estate

import test from 'node:test';
import assert from 'node:assert';
import { bootCity, makeTown, PLACES } from './flow-harness.mjs';

await bootCity();      // the real tiles, and the resolver that finds three.js
const { Cyclists } = await import('../js/cyclists.js');
const { planAt } = await import('../js/cycleplan.js');
const { CLS } = await import('../js/cyclenet.js');

test('three minutes of Palackého with riders in it: nobody knocked off, nobody jammed, everybody on a real ride', async (t) => {
  const w = await makeTown(PLACES.palackeho, { spin: 60 });
  const cy = new Cyclists({ add() {}, remove() {} }, w.city, null, { peds: w.peds, traffic: w.traffic });
  cy.clock = w.now;
  const blockers = [];
  w.traffic.blockers = blockers;
  const N = {}, t00 = w.now();
  let bodies = 0, samples = 0, cars = 0, stopped = 0, most = 0, told = 0;
  for (let i = 1; i <= 180 * 20; i++) {
    blockers.length = 0;
    cy.blockInto(blockers);                       // main.js: before the traffic's update
    w.step(1 / 20);
    const a = (w.now() - t00) / 60 * Math.PI * 2;
    cy.setViewer({ x: w.pos.x, z: w.pos.z, dirX: Math.cos(a), dirZ: Math.sin(a) });
    cy.update(1 / 20, w.pos);
    for (const o of w.peds.crossers) if (o === cy.riders.find((r) => r.note === o)?.note) told++;
    if (i % 20) continue;
    samples++;
    bodies += cy.riders.length;
    if (cy.riders.length > most) most = cy.riders.length;
    for (const r of cy.riders) {
      assert.ok(Number.isFinite(r.x) && Number.isFinite(r.z) && Number.isFinite(r.y) && Number.isFinite(r.roll), 'a rider somewhere real');
      planAt(r.s.plan, w.now() - r.late, { k: 0, s: 0 }, N);
      assert.ok(r.arc <= N.arc + 1e-6, 'never ahead of the plan');
    }
    if (i < 45 * 20) continue;
    for (const c of w.traffic.cars) {
      if (Math.hypot(c.x - w.pos.x, c.z - w.pos.z) > 300 || (c.ai?.fixed && c.ai.atStop >= 0)) continue;
      cars++;
      if (Math.abs(c.speed) < 0.5) stopped++;
    }
  }
  t.diagnostic(`attached ${cy.stats.attached}, bodies ${(bodies / samples).toFixed(1)} (most ${most}), told ${told}, cars standing ${(stopped / cars * 100).toFixed(1)} %`);
  assert.ok(cy.stats.attached >= 6 && bodies / samples > 1.5, `riders about: ${cy.stats.attached} came by, ${(bodies / samples).toFixed(1)} at a time`);
  assert.ok(most <= 16, 'and never a crowd of them: ' + most);
  assert.equal(cy.stats.knocked, 0, 'nobody was knocked off by the traffic');
  assert.equal(w.stats.killed, 0, 'and nobody on foot was run over either');
  assert.ok(told > 20, 'drivers were told about riders on crossings: ' + told);
  // the same bound tests/flow.test.mjs holds the town to without riders
  assert.ok(stopped / cars < 0.16, `${(stopped / cars * 100).toFixed(1)} % of the cars are standing`);

  // the rides themselves, every one minted round here
  let cycle = 0, street = 0, foot = 0, turns = 0, n = 0, short = 0;
  for (const s of cy._pool.values()) {
    n++;
    const legs = s.plan.legs;
    if (s.plan.len < 400) short++;
    for (let q = 0; q < legs.length; q++) {
      const l = legs[q], d = Math.min(l.a1, s.plan.len) - l.a0;
      if (!(d > 0)) continue;
      if (l.w.cls === CLS.CYCLE) cycle += d; else if (l.w.cls === CLS.STREET) street += d; else foot += d;
      if (q && legs[q - 1].w === l.w && legs[q - 1].i1 === l.i0 && legs[q - 1].d !== l.d) turns++;
    }
  }
  const total = cycle + street + foot;
  t.diagnostic(`rides ${n}: cycle ${(cycle / total * 100).toFixed(0)} %, street ${(street / total * 100).toFixed(0)} %, foot ${(foot / total * 100).toFixed(0)} %, turns ${(turns / n).toFixed(2)}, short ${short}`);
  assert.ok(n > 60, 'schedules in reach: ' + n);
  assert.ok(cycle / total > 0.65, `mostly on cycleways: ${(cycle / total * 100).toFixed(0)} %`);
  assert.ok(street / total > 0.03 && street / total < 0.38, `on streets where the network carries on that way: ${(street / total * 100).toFixed(0)} %`);
  assert.ok(foot / total < 0.12, `and hardly on footways: ${(foot / total * 100).toFixed(0)} %`);
  assert.ok(turns / n < 0.6, `turning round is rare: ${(turns / n).toFixed(2)} a ride`);
  assert.ok(short / n < 0.25, `and most rides go somewhere: ${short} of ${n} under 400 m`);
});
