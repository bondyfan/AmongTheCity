// ---- revs and gears ---------------------------------------------------------
// js/drivetrain.js turns a speed and a pedal into what an engine voice needs.
// The old voice had no gearbox to speak of: revs were a function of road speed
// alone. These pin the things a driver would notice if they broke: the box
// goes up through the gears in order, shifts later under a heavy foot, kicks
// down, does not hunt, cuts fuel on the overrun and bounces off the limiter.

import test from 'node:test';
import assert from 'node:assert';
import { makeDrivetrain, drivetrainStep, throttleFromMotion } from '../js/drivetrain.js';
import { ENGINE_KINDS, engineKind, engineKey } from '../js/enginekinds.js';

const DT = 1 / 60;
/** Floor it (or part throttle) from rest with a simple car and log the drive. */
function run(kind, th, seconds, accelScale = 1) {
  const K = ENGINE_KINDS[kind], d = makeDrivetrain(K.box), log = [];
  let v = 0;
  for (let t = 0; t < seconds; t += DT) {
    v += K.accel * accelScale * th * (1 - (v / K.vmax) ** 2) * DT;
    drivetrainStep(d, v, th, DT);
    log.push({ t, v, rpm: d.rpm, gear: d.gear, load: d.load, cut: d.cut });
  }
  return { d, log };
}

test('floored from rest, every kind climbs the box one gear at a time and never over the line', () => {
  for (const kind of Object.keys(ENGINE_KINDS)) {
    const { d, log } = run(kind, 1, 60);
    let top = 0;
    for (let i = 1; i < log.length; i++) {
      const dg = log[i].gear - log[i - 1].gear;
      assert.ok(dg === 0 || dg === 1, `${kind} went from gear ${log[i - 1].gear + 1} to ${log[i].gear + 1}`);
      assert.ok(log[i].rpm <= d.B.redline + 1, `${kind} over the redline at ${log[i].t.toFixed(1)} s`);
      assert.ok(log[i].rpm >= d.B.idle - 1, `${kind} under idle`);
      top = Math.max(top, log[i].gear);
    }
    assert.ok(top >= 3, `${kind} only reached gear ${top + 1} flat out`);
  }
});

test('an upshift drops the revs, and the revs fall rather than jump', () => {
  const { log } = run('octavia', 1, 8);
  const i = log.findIndex((f, k) => k && f.gear === 1 && log[k - 1].gear === 0);
  assert.ok(i > 0, 'never left first');
  const before = log[i - 1].rpm, after = log[i + 30].rpm;
  assert.ok(after < before * 0.8, `revs ${before | 0} -> ${after | 0}: no drop into second`);
  for (let k = i; k < i + 30; k++) {
    assert.ok(Math.abs(log[k].rpm - log[k - 1].rpm) < 330, 'the revs stepped instead of falling');
  }
  assert.equal(log[i + 2].load, 0, 'the drive is broken through an upshift: no fuel');
});

test('a light foot shifts early, a heavy one holds the gear', () => {
  const up = (th) => {
    const { log } = run('octavia', th, 30);
    const i = log.findIndex((f, k) => k && f.gear === 1 && log[k - 1].gear === 0);
    return log[i - 1].rpm;
  };
  const light = up(0.25), heavy = up(1);
  assert.ok(light < 2600, `quarter throttle held first to ${light | 0} rpm`);
  assert.ok(heavy > 5500, `floored, it shifted at only ${heavy | 0} rpm`);
});

test('flooring it at a cruise kicks down more than one gear', () => {
  const d = makeDrivetrain(ENGINE_KINDS.octavia.box), v = 60 / 3.6;
  for (let t = 0; t < 4; t += DT) drivetrainStep(d, v, 0.2, DT);
  const cruising = d.gear;
  assert.ok(cruising >= 4, `cruising at 60 in gear ${cruising + 1}`);
  for (let t = 0; t < 1.5; t += DT) drivetrainStep(d, v, 1, DT);
  assert.ok(cruising - d.gear >= 2, `kickdown went from ${cruising + 1} to ${d.gear + 1}`);
  assert.ok(d.rpm > 3000, 'and the engine is not up where the power is');
});

test('at a steady speed and pedal the box settles and stays put', () => {
  for (const kind of Object.keys(ENGINE_KINDS)) {
    const K = ENGINE_KINDS[kind];
    for (const frac of [0.15, 0.3, 0.5, 0.7, 0.95]) {
      for (const th of [0.15, 0.4, 0.8]) {
        const d = makeDrivetrain(K.box), v = K.vmax * frac;
        for (let t = 0; t < 4; t += DT) drivetrainStep(d, v, th, DT);
        const g = d.gear;
        for (let t = 0; t < 8; t += DT) {
          drivetrainStep(d, v, th, DT);
          assert.equal(d.gear, g, `${kind} hunts at ${(v * 3.6) | 0} km/h, throttle ${th}`);
        }
      }
    }
  }
});

test('lifting off at speed cuts the fuel, and standing still it idles', () => {
  const d = makeDrivetrain(ENGINE_KINDS.octavia.box);
  for (let t = 0; t < 3; t += DT) drivetrainStep(d, 30, 0.5, DT);
  for (let t = 0; t < 1; t += DT) drivetrainStep(d, 30, 0, DT);
  assert.equal(d.load, 0, 'coasting in gear still burns fuel');
  assert.ok(d.rpm > d.B.idle + 300, 'the wheels are not turning the engine');
  for (let t = 0; t < 4; t += DT) drivetrainStep(d, 0, 0, DT);
  assert.ok(Math.abs(d.rpm - d.B.idle) < 20, `standing still at ${d.rpm | 0} rpm`);
  assert.ok(Math.abs(d.load - d.B.idleLoad) < 1e-6, 'idling takes the idle throttle');
  assert.equal(d.gear, 0);
});

test('pulling away, the clutch holds the engine above idle before the wheels catch up', () => {
  const d = makeDrivetrain(ENGINE_KINDS.octavia.box);
  for (let t = 0; t < 0.5; t += DT) drivetrainStep(d, 0.5, 1, DT);
  assert.ok(d.rpm > 1800, `floored at walking pace the engine sits at ${d.rpm | 0} rpm`);
});

test('spinning the wheels in first runs into the limiter and bounces', () => {
  const d = makeDrivetrain(ENGINE_KINDS.bmw.box);
  let cuts = 0, alive = 0, max = 0;
  for (let t = 0; t < 4; t += DT) {
    drivetrainStep(d, 14, 1, DT, 1);       // 50 km/h, sideways, foot down
    if (t > 1) { cuts += d.cut; alive += 1 - d.cut; max = Math.max(max, d.rpm); }
  }
  assert.ok(max <= d.B.redline, 'revved through the limiter');
  assert.ok(cuts > 20 && alive > 20, `limiter should cut in bursts: ${cuts} frames dead, ${alive} alive`);
});

test('a voice that starts on a car at speed starts in the right gear', () => {
  const d = makeDrivetrain(ENGINE_KINDS.octavia.box);
  drivetrainStep(d, 130 / 3.6, 0.3, DT);
  assert.ok(d.gear >= 5, `joined at 130 km/h in gear ${d.gear + 1}`);
  assert.ok(d.rpm > 1800 && d.rpm < 4000, `at ${d.rpm | 0} rpm`);
});

test('a bad frame cannot poison the revs', () => {
  const d = makeDrivetrain(ENGINE_KINDS.van.box);
  drivetrainStep(d, NaN, NaN, DT, NaN);
  drivetrainStep(d, 10, 0.5, 0);
  drivetrainStep(d, 10, 0.5, 5);           // a hidden tab hands over seconds
  assert.ok(Number.isFinite(d.rpm) && Number.isFinite(d.load));
});

test('every kind is geared to reach its own top speed under the redline', () => {
  for (const [kind, K] of Object.entries(ENGINE_KINDS)) {
    const kph = K.box.kph;
    for (let i = 1; i < kph.length; i++) assert.ok(kph[i] > kph[i - 1], `${kind} ratios are not in order`);
    const rpmAtVmax = K.vmax * 3600 / kph[kph.length - 1];
    assert.ok(rpmAtVmax < K.eng.redline, `${kind} would need ${rpmAtVmax | 0} rpm in top at its top speed`);
    assert.equal(K.box.idle ?? 800, K.eng.idle, `${kind}: box and engine disagree about idle`);
    assert.equal(K.box.redline ?? 6500, K.eng.redline, `${kind}: box and engine disagree about the redline`);
  }
});

test('the electric kinds have no piston engine, and old names still resolve', () => {
  assert.equal(engineKind('tesla'), null);
  assert.equal(engineKey('trolleybus'), null);
  assert.equal(engineKey('kombi'), 'octavia');
  assert.equal(engineKey('nonsense'), 'octavia');
  assert.equal(engineKind('semi'), ENGINE_KINDS.semi);
});

test('the pedal guessed for traffic: more to gain speed, none to lose it', () => {
  assert.equal(throttleFromMotion(20, -3), 0);
  const cruise = throttleFromMotion(20, 0), pulling = throttleFromMotion(20, 2);
  assert.ok(cruise > 0.1 && cruise < 0.5);
  assert.ok(pulling > cruise + 0.2);
  assert.ok(throttleFromMotion(35, 0) > throttleFromMotion(10, 0), 'holding a higher speed takes more');
  assert.equal(throttleFromMotion(20, 50), 1);
});

test('braking hard, the box comes down through the gears and never changes up', () => {
  const d = makeDrivetrain(ENGINE_KINDS.bmw.box);
  let v = 30;
  for (let t = 0; t < 3; t += DT) drivetrainStep(d, v, 0.3, DT);
  const from = d.gear;
  let ups = 0, prev = d.gear;
  for (let t = 0; t < 2.4; t += DT) {
    v = Math.max(0, v - 11 * DT);
    drivetrainStep(d, v, 0, DT);
    if (d.gear > prev) ups++;
    prev = d.gear;
  }
  assert.equal(ups, 0, 'it changed up in the middle of an emergency stop');
  assert.ok(d.gear < from - 2, `from gear ${from + 1} it only came down to ${d.gear + 1}`);
});
