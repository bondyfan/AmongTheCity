// ---- positioned one-shots: a horn has a side, a distance and a delay -------
// Frank, 21 Nov 2026: horns of the traffic around him all sounded "strasne
// blizko", at one volume and from one side. js/spatialsfx.js places them; this
// pins what an ear would notice, against a fake AudioContext that records the
// parameters instead of making sound.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceGain, panFor, airCutoff, wetFor, behindness, pickVoice, createSpatial, VOICES, SOUND_MS,
} from '../js/spatialsfx.js';

class Param {
  constructor(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  setValueAtTime(v) { this.value = v; }
  cancelScheduledValues() {}
}
class Node {
  constructor() { this.to = []; }
  connect(n) { this.to.push(n); return n; }
  disconnect() { this.to = []; }
}
function fakeCtx() {
  const made = { sources: [] };
  const ctx = {
    currentTime: 0,
    createGain() { const n = new Node(); n.gain = new Param(1); return n; },
    createBiquadFilter() { const n = new Node(); n.frequency = new Param(350); n.Q = new Param(1); return n; },
    createStereoPanner() { const n = new Node(); n.pan = new Param(0); return n; },
    createBufferSource() {
      const n = new Node();
      n.playbackRate = new Param(1);
      n.start = (t) => { n.startAt = t; };
      n.stop = () => { n.stopped = true; n.onended?.(); };
      made.sources.push(n);
      return n;
    },
  };
  return { ctx, made };
}
// the voice a source was wired into: source -> env -> voice gain -> lowpass -> panner
function voiceOf(src) {
  const g = src.to[0].to[0], lp = g.to[0], pan = lp.to[0];
  return { g, lp, pan };
}

test('a horn gets quieter and duller the further away it is, and is silent at the edge of range', () => {
  let last = Infinity, lastF = Infinity;
  for (const d of [3, 10, 30, 60, 120, 200]) {
    const g = distanceGain(d, 5, 220), f = airCutoff(d, 220);
    assert.ok(g < last || d <= 5, `gain falls at ${d} m`);
    assert.ok(f < lastF, `cutoff falls at ${d} m`);
    last = g; lastF = f;
  }
  assert.equal(distanceGain(4, 5, 220), distanceGain(0, 5, 220) * (1 - 4 / 220));
  assert.equal(distanceGain(220, 5, 220), 0);
  assert.ok(distanceGain(20, 5, 220) < 0.25, 'three cars back is well under your own horn');
  assert.ok(airCutoff(180, 220) < 2500, 'a far horn has lost its top');
  assert.ok(airCutoff(5, 220) > 15000, 'a near one keeps it');
  assert.ok(wetFor(200, 220) > wetFor(20, 220), 'more of a far horn is the street answering');
});

test('a horn is on the side it comes from, whichever way you face', () => {
  // facing north (−z): east is to the right
  assert.ok(panFor(30, 0, 0, -1) > 0.9);
  assert.ok(panFor(-30, 0, 0, -1) < -0.9);
  assert.ok(Math.abs(panFor(0, -30, 0, -1)) < 1e-9, 'straight ahead is the middle');
  // facing east (+x): north is to the left
  assert.ok(panFor(0, -30, 1, 0) < -0.9);
  // one metre away is not hard left just because of a shoulder
  assert.ok(Math.abs(panFor(-1, 0, 0, -1)) < 0.5);
  assert.equal(behindness(0, 30, 0, -1), 1);
  assert.equal(behindness(0, -30, 0, -1), 0);
  assert.ok(airCutoff(50, 220, 1) < airCutoff(50, 220, 0), 'behind you is a little darker');
});

test('the voice pool: free voices first, the quietest stolen only by something louder', () => {
  const v = [{ busy: true, level: 0.3 }, { busy: false, level: 0 }, { busy: true, level: 0.1 }];
  assert.equal(pickVoice(v, 0.05), 1);
  v[1].busy = true; v[1].level = 0.5;
  assert.equal(pickVoice(v, 0.05), -1, 'quieter than everything playing: dropped');
  assert.equal(pickVoice(v, 0.2), 2, 'louder than the quietest: it takes that one');
});

test('createSpatial places a horn, delays it by the speed of sound and follows the ears', () => {
  const { ctx, made } = fakeCtx();
  const sp = createSpatial(ctx, new Node(), () => null);
  sp.listener(0, 0, 0, -1);
  assert.equal(sp.play({ duration: 1 }, 0.7, 1, 40, 0, 5, 220), true);
  const src = made.sources[0];
  const { g, lp, pan } = voiceOf(src);
  assert.ok(pan.pan.value > 0.9, 'a car to the east of a north-facing ear is on the right');
  assert.ok(Math.abs(g.gain.value - distanceGain(40, 5, 220)) < 1e-9);
  assert.ok(lp.frequency.value < 12000);
  assert.ok(Math.abs(src.startAt - 40 / SOUND_MS) < 1e-9, 'heard when the sound has got here');
  // turn to face the car: it is in the middle now
  ctx.currentTime = 0.05;
  sp.listener(0, 0, 1, 0);
  assert.ok(Math.abs(pan.pan.value) < 1e-6);
  // drive away from it: quieter
  ctx.currentTime = 0.1;
  sp.listener(-60, 0, 1, 0);
  assert.ok(g.gain.value < distanceGain(40, 5, 220));
  // when it ends the voice is free again
  src.onended();
  assert.equal(sp.busy(), 0);
});

test('the budget: never more than VOICES at once, and a far horn does not steal a near one', () => {
  const { ctx } = fakeCtx();
  const sp = createSpatial(ctx, new Node(), () => null);
  sp.listener(0, 0, 0, -1);
  for (let i = 0; i < VOICES; i++) assert.equal(sp.play({}, 0.7, 1, 15, i, 5, 220), true);
  assert.equal(sp.busy(), VOICES);
  assert.equal(sp.play({}, 0.7, 1, 150, 0, 5, 220), false, 'a horn 150 m away waits its turn');
  assert.equal(sp.play({}, 0.7, 1, 4, 0, 5, 220), true, 'one 4 m away takes the quietest voice');
  assert.equal(sp.busy(), VOICES);
  assert.equal(sp.play({}, 0.7, 1, 400, 0, 5, 220), false, 'out of range is never played');
});
