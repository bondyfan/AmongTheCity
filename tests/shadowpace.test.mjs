// ---- the shadow map's redraw rate --------------------------------------------
// Below the high tier the moon's shadows are redrawn every other frame; by day,
// and on the high tier, every frame. See js/shadowpace.js for the measurement.
import test from 'node:test';
import assert from 'node:assert';
import { shadowDue } from '../js/shadowpace.js';

const run = (settings, nightK, frames = 60) => {
  let n = 0;
  for (let i = 0; i < frames; i++) if (shadowDue(settings, nightK)) n++;
  return n;
};

test('by day the shadow map is drawn every frame on every tier', () => {
  for (const shadowRes of [1024, 2048, 4096])
    assert.equal(run({ shadowRes }, 0), 60);
  assert.equal(run({ shadowRes: 2048 }, 0.5), 60, 'twilight still has the sun');
});

test('at night the medium tier draws it every other frame and never skips two', () => {
  assert.equal(run({ shadowRes: 2048 }, 1), 30);
  let gap = 0, worst = 0;
  for (let i = 0; i < 40; i++) {
    if (shadowDue({ shadowRes: 2048 }, 1)) gap = 0; else worst = Math.max(worst, ++gap);
  }
  assert.equal(worst, 1);
});

test('the high tier pays for every frame at night too', () => {
  assert.equal(run({ shadowRes: 4096 }, 1), 60);
  assert.equal(run(undefined, 0), 60, 'no settings at all must not switch shadows off');
});
