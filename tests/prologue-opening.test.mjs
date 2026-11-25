// The start of the campaign (Frank, 25 Nov 2026): no helicopters by the house,
// a real step up onto the coping, an announcement as loud as he is near, and
// the evening light the opening is shot in.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import fs from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
const { stepUp, WALK_IN, UP_TIME } = await import('../js/prologue-stepup.js');
const { paLevel, PA_FULL, PA_REACH } = await import('../js/prologue-voice.js');
const { skyHours, storyClock } = await import('../js/prologue-clock.js');
const clock = await import('../js/worldclock.js');
const { roofWalk } = await import('../js/prologue-ladder.js');
const { world2 } = await import('../js/prologue-roof.js');
const { AIRFIELDS } = await import('../js/airfield.js');
const src = (f) => fs.readFileSync(new URL('../js/' + f, import.meta.url), 'utf8');

test('the roof holds the walker who is on it and nothing else: no helicopter is carried to Kolín', () => {
  const world = { city: { chunkIndex: { get: () => null } }, terrain: { heightAt: () => 200 } };
  const roof = roofWalk(world, { pos: { x: 0, z: 0 } }, { keys: new Set() });
  roof.begin();
  const top = roof.ladderTop().y;
  const walker = { interior: true, yLo: top, yHi: top + 1.8 };
  // a machine parked at an airport asks world.collide every frame
  for (const f of AIRFIELDS) {
    const heli = { x: f.heli.x, z: f.heli.z };
    assert.equal(roof.collide(heli, 4, { aboveY: 221 }), false);
    assert.equal(roof.collide(heli, 4, walker), false, 'even a walker that far away is not the roof\'s');
    assert.deepEqual(heli, { x: f.heli.x, z: f.heli.z }, f.name + ': the helicopter was moved');
  }
  // somebody on the pavement under the house is not on the roof
  const below = world2(0, 3);
  assert.equal(roof.collide({ ...below }, 0.3, { interior: true, yLo: top - 14, yHi: top - 12.2 }), false);
  // the man on the roof still cannot walk off its edge
  const over = world2(0.5, 0.1), p = { ...over };
  assert.equal(roof.collide(p, 0.3, walker), true);
  assert.ok(Math.hypot(p.x - over.x, p.z - over.z) > 0.5, 'he was not put back from the edge');
  const inside = world2(0.5, 5), q = { ...inside };
  assert.equal(roof.collide(q, 0.3, walker), false);
  assert.match(src('prologue.js'), /roofCtl\.collide\(pos, r, opts\)/);
});

test('up onto the coping is a step: two paces, a foot lifted and set down, the weight over it, the other foot after', () => {
  const a = stepUp(0), z = stepUp(1);
  assert.deepEqual([a.forward, a.up, a.hipR, a.kneeR], [0, 0, 0, 0], 'he starts standing on the felt');
  assert.ok(Math.abs(z.forward - 1) < 1e-9 && Math.abs(z.up - 1) < 1e-9, 'and ends on the coping');
  for (const j of ['hipR', 'kneeR', 'hipL', 'kneeL', 'lean', 'arm']) assert.ok(Math.abs(z[j]) < 1e-9, j + ' is not at rest on the coping');
  let last = a, lifted = 0, pushed = false, trailed = false;
  for (let i = 1; i <= 200; i++) {
    const k = i / 200, m = stepUp(k);
    assert.ok(m.forward >= last.forward - 1e-9, 'he never slides back at k ' + k);
    assert.ok(m.up >= last.up - 1e-9, 'he never sinks back at k ' + k);
    assert.ok(Math.abs(m.forward - last.forward) < 0.03 && Math.abs(m.up - last.up) < 0.03, 'a jump at k ' + k);
    if (k < WALK_IN) assert.ok(m.walk !== null && m.up === 0, 'he walks to the wall first');
    else {
      assert.equal(m.walk, null);
      // the foot is up on the coping before the body has risen
      if (m.up < 0.1) lifted = Math.max(lifted, m.hipR);
      if (m.up > 0.3 && m.up < 0.9 && m.hipR < lifted - 0.2) pushed = true;
      if (m.up > 0.6 && m.kneeL < -0.5) trailed = true;
    }
    last = m;
  }
  assert.ok(lifted > 1.0, 'the right thigh comes up before he rises: ' + lifted);
  assert.ok(pushed, 'the leg straightens under him as he rises');
  assert.ok(trailed, 'the left knee folds as it is brought up');
  assert.ok(UP_TIME >= 1.8 && UP_TIME <= 2.6, 'it fits the film\'s 2.6 s beat and is not a hop');
  const roof = src('prologue-roof.js');
  assert.match(roof, /stepUp\(1 - step\)/);
  assert.ok(!/const hop = /.test(roof), 'the hop is gone');
});

test('the station is heard by how near he is to it', () => {
  assert.equal(paLevel(0), 1);
  assert.equal(paLevel(PA_FULL), 1, 'full in the hall and on the platforms');
  assert.equal(paLevel(PA_FULL + PA_REACH), 0);
  assert.equal(paLevel(400), 0, 'nothing from far away');
  let last = 1;
  for (let d = 0; d <= 200; d += 5) { const k = paLevel(d); assert.ok(k <= last + 1e-12 && k >= 0 && k <= 1); last = k; }
  // where the announcement starts (120 m from the entrance) it is a murmur
  assert.ok(paLevel(120) < 0.25 && paLevel(120) > 0.05, String(paLevel(120)));
  // and the recording follows him while it plays
  const voice = src('prologue-voice.js');
  assert.match(voice, /speech\?\.set\(1\.7 \* base \* heard/);
  assert.match(src('prologue.js'), /sound\.hear\(/);
});

test('the opening is lit later than its clock: low sun, then dusk, and the HUD still says eight', () => {
  // the sun of this sky sets at 21:00
  assert.ok(skyHours(20) > 20.4 && skyHours(20) < 20.9, 'the street is in the last low sun: ' + skyHours(20));
  assert.ok(skyHours(20.05) > 21.1 && skyHours(20.05) < 21.5, 'the roof is after sunset: ' + skyHours(20.05));
  let last = -1;
  for (let h = 19; h <= 24; h += 0.01) { const s = skyHours(h); assert.ok(s >= last - 1e-9, 'the light ran backwards at ' + h); assert.ok(s >= h - 1e-9); last = s; }
  assert.equal(skyHours(2.5), 2.5, 'part two keeps the clock\'s own light');
  assert.ok(Math.abs(skyHours(23) - 23) < 1e-9, 'and the two meet again after the table');
  storyClock.start(20);
  assert.ok(Math.abs(clock.tod() * 24 - 20) < 1e-6, 'the clock he reads');
  assert.ok(Math.abs(clock.skyTod() * 24 - skyHours(20)) < 1e-6, 'the hour the sky is shown');
  storyClock.release();
  assert.ok(Math.abs(clock.skyTod() - clock.tod()) < 1e-6, 'the story over, the sky is the clock\'s again');
  assert.match(src('main.js'), /updateSky\(sky, skyTod\(\)/);
});
