// ---- the shared day clock: two machines, one sun ----
// worldclock.js is deliberately free of three.js and of the DOM, so the whole
// "do two players see the same hour" question is answerable headless.
//
// The trick these tests lean on: a module is a singleton, so a SECOND client
// is a second instance of the module — obtained with a cache-busting import
// specifier. That lets one process play both laptops, including the one whose
// system clock is seven hours wrong.

import test from 'node:test';
import assert from 'node:assert';
import { DAY_LENGTH, START_TOD, WORLD_EPOCH_MS, CLOCK } from '../js/config.js';

const URL_ = new URL('../js/worldclock.js', import.meta.url).href;
const REAL_NOW = Date.now;
let n = 0;

// A fresh, independent instance of the clock = one more "client". Every one
// of its exports is invoked with Date.now() swapped for that client's own
// system clock, so a machine whose clock is seven hours wrong stays wrong for
// its whole session instead of quietly healing between calls. `setSkew` moves
// that clock mid-session, which is how an NTP step or a wake-from-sleep looks
// from inside the process. node:test runs top-level tests sequentially, so
// the swap can never leak into another test.
async function client(skewMs = 0) {
  let skew = skewMs;
  const fake = () => REAL_NOW() + skew;
  const under = (fn) => {
    Date.now = fake;
    try { return fn(); } finally { Date.now = REAL_NOW; }
  };
  const m = await under(() => import(`${URL_}?c=${n++}`));
  const api = { setSkew: (v) => { skew = v; } };
  for (const k of Object.keys(m)) api[k] = (...a) => under(() => m[k](...a));
  return api;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('unsynced clock follows this machine and stays in range', async () => {
  const c = await client();
  assert.ok(!c.isSynced(), 'nothing adopted yet');
  assert.strictEqual(c.offsetMs(), 0);
  assert.ok(Math.abs(c.nowMs() - Date.now()) < 50, 'tracks the local wall clock');

  const t = c.worldT();
  assert.ok(Number.isFinite(t) && t > 0, `worldT ${t}`);
  assert.ok(Math.abs(t - (Date.now() - WORLD_EPOCH_MS) / 1000) < 0.05);

  const d = c.tod();
  assert.ok(d >= 0 && d < 1, `tod ${d}`);
});

test('tod is worldT folded by DAY_LENGTH with START_TOD as the phase', async () => {
  const c = await client();
  const t = c.worldT(), d = c.tod();
  const want = START_TOD + t / DAY_LENGTH;
  assert.ok(Math.abs(d - (want - Math.floor(want))) < 1e-6, `${d} vs ${want}`);
  // …and the epoch itself is the declared spawn hour, which is the property
  // that lets a solo player reason about the clock at all.
  assert.ok(Math.abs(START_TOD - 10.5 / 24) < 1e-12);
});

test('a seven-hour-wrong clock is fixed by one WELCOME timestamp', async () => {
  const SKEW = 7 * 3600 * 1000;
  const good = await client();
  const bad = await client(SKEW);

  // Before the server speaks, the broken machine lives seven hours away —
  // ~17 in-game days of day/night, i.e. a totally different sky and a 24×
  // different traffic density.
  assert.ok(Math.abs(bad.worldT() - good.worldT()) > 6 * 3600, 'skew is real');

  // WELCOME carries the SERVER's Date.now() (which is right), and we hand it
  // over with the round trip we measured for it.
  const rtt = 40;
  bad.setEpoch(REAL_NOW() - rtt / 2, rtt);
  assert.ok(bad.isSynced());
  assert.ok(Math.abs(bad.offsetMs() + SKEW) < 100, `offset ${bad.offsetMs()}`);

  const dt = Math.abs(bad.worldT() - good.worldT()) * 1000;
  assert.ok(dt < 50, `still ${dt.toFixed(1)} ms apart, budget is 50`);
  const dd = Math.abs(bad.tod() - good.tod()) * DAY_LENGTH * 1000;
  assert.ok(dd < 50, `tod ${dd.toFixed(1)} ms apart`);
});

test('an OS clock step mid-session cannot move a synced world', async () => {
  // The nasty one: the player is already driving when NTP corrects their
  // machine by four hours (or the laptop wakes from sleep). Shared time must
  // NOT jump — we are anchored to the server, and the re-anchor has to absorb
  // the delta rather than adopt it.
  const good = await client();
  const c = await client();
  c.setEpoch(REAL_NOW(), 20);
  const before = c.worldT();
  c.setSkew(4 * 3600 * 1000);      // the OS clock lurches four hours forward
  await sleep(20);
  const after = c.worldT();
  assert.ok(after >= before, 'never goes backwards');
  assert.ok((after - before) < 0.5, `jumped ${(after - before).toFixed(3)} s`);
  assert.ok(Math.abs(after - good.worldT()) < 0.05, 'still agrees with the server');
});

test('a solo player follows their own machine across a sleep', async () => {
  // Same event with no server: adopting the new wall clock is the RIGHT
  // answer here — a sky frozen at bedtime is worse than a jump, and there is
  // nobody to disagree with.
  const c = await client();
  const before = c.worldT();
  c.setSkew(8 * 3600 * 1000);
  await sleep(20);
  const after = c.worldT();
  assert.ok(after - before > 7 * 3600, `only moved ${(after - before).toFixed(0)} s`);
  assert.ok(!c.isSynced());
});

test('small corrections slew instead of stepping, and never rewind', async () => {
  const c = await client();
  const now = Date.now();
  c.setEpoch(now, 300);            // first sample: stepped into place
  const o0 = c.offsetMs();
  c.setEpoch(now + 1000, 60);      // better rtt, 1 s off → must SLEW, not step
  assert.ok(Math.abs(c.offsetMs() - o0) < 200, 'no instant jump');

  let prev = -Infinity;
  for (let i = 0; i < 12; i++) {
    const t = c.worldT();
    assert.ok(t >= prev, `worldT went backwards: ${t} < ${prev}`);
    prev = t;
    await sleep(4);
  }
  // slew rate is bounded, so the correction is still landing
  assert.ok(Math.abs(c.offsetMs() - (o0 + 1000)) > 1, 'converges gradually');
});

test('a correction bigger than stepMs is stepped, because slewing it would take days', async () => {
  const c = await client();
  const now = Date.now();
  c.setEpoch(now, 20);
  c.setEpoch(now + 3 * CLOCK.stepMs, 10);
  assert.ok(Math.abs(c.offsetMs() - 3 * CLOCK.stepMs) < 100, `offset ${c.offsetMs()}`);
});

test('only a better-measured sample displaces the one in use', async () => {
  const c = await client();
  const now = Date.now();
  c.setEpoch(now, 30);
  const o = c.offsetMs();
  c.setEpoch(now + 5000, 900);   // slower round trip = worse measurement
  assert.strictEqual(c.offsetMs(), o, 'a laggier sample must not win');
  c.setEpoch(now + 5000, null);  // unmeasured cannot displace measured either
  assert.strictEqual(c.offsetMs(), o);
});

test('setEpoch(null) drops back to this machine — the single-player path', async () => {
  const c = await client();
  c.setEpoch(Date.now() + 90000, 20);
  assert.ok(c.isSynced());
  assert.strictEqual(c.setEpoch(null), 0);
  assert.ok(!c.isSynced());
  assert.ok(Math.abs(c.nowMs() - Date.now()) < 50, 'back on the local clock');
  // garbage is treated as "no server", never as a time
  c.setEpoch(NaN); assert.ok(!c.isSynced());
  c.setEpoch(undefined); assert.ok(!c.isSynced());
});

test('worldPhase folds worldT small enough for a float32 uniform', async () => {
  const c = await client();
  const p = c.worldPhase(25);
  assert.ok(p >= 0 && p < 25, `phase ${p}`);
  assert.ok(Math.abs(p - (c.worldT() % 25)) < 0.05);
  assert.strictEqual(c.worldPhase(0), 0);
  assert.strictEqual(c.worldPhase(-1), 0);
  // …and two synced clients must land on the SAME phase bucket
  const b = await client();
  assert.ok(Math.abs(b.worldPhase(25) - p) < 0.05);
});

test('resetClock re-anchors locally', async () => {
  const c = await client();
  c.setEpoch(Date.now() + 60000, 10);
  c.resetClock();
  assert.ok(!c.isSynced());
  assert.strictEqual(c.offsetMs(), 0);
  assert.ok(Math.abs(c.nowMs() - Date.now()) < 50);
});
