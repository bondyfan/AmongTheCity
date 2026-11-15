// Round 8: a metre at 130 km/h costs more than a metre at 90, and nothing
// changes at town speeds (tests/economy.test.mjs keeps its range bands at
// 25 m/s because of that).
import test from 'node:test';
import assert from 'node:assert/strict';
import { speedFactor, burn, levelOf } from '../js/fuel.js';

test('speedFactor: 1 up to 25 m/s, x1.35 at 130 km/h, capped at x1.8', () => {
  for (const v of [0, 5, 13.9, 25]) assert.equal(speedFactor(v), 1);
  assert.ok(Math.abs(speedFactor(130 / 3.6) - 1.35) < 1e-9);
  assert.ok(speedFactor(150 / 3.6) > 1.75 && speedFactor(150 / 3.6) <= 1.8);
  assert.equal(speedFactor(200 / 3.6), 1.8);
  assert.equal(speedFactor(NaN), 1);
  let last = 1;
  for (let v = 25; v < 70; v += 0.5) { const f = speedFactor(v); assert.ok(f >= last); last = f; }
});

test('burn: the same 1 km costs 35 % more at 130 km/h than at 90', () => {
  const run = (v) => {
    const car = { kind: 'octavia', x: 1, z: 2, vGround: v, _acc: 0 };
    const l0 = levelOf(car);
    for (let m = 0; m < 1000 - 1e-6; m += v * 0.05) burn(car, 0.05);
    return (l0 - levelOf(car)) / (Math.ceil(1000 / (v * 0.05)) * v * 0.05);   // litres per metre
  };
  const r = run(130 / 3.6) / run(25);
  assert.ok(Math.abs(r - 1.35) < 0.01, 'ratio ' + r);
});
