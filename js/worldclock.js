// ==========================================================================
// World clock — the one time base every client in the room agrees on.
//
// WHY THIS EXISTS. The day used to be a local accumulator: `game.tod` started
// at START_TOD on boot and grew by dt/DAY_LENGTH every frame. Two players
// therefore ran two different days. A minute of extra loading = a permanent
// in-game hour apart, and it is not just cosmetic: main.js scales traffic
// density by the hour (TRAFFIC_HOURS runs 0.06 at 03:00 against 1.45 at
// 16:00 — a 24× spread), so a co-op session could not have matching traffic
// even in principle while the two clocks disagreed. Sky, street lights,
// headlights and car counts all hang off this one number.
//
// THE FIX, in one sentence: world time is a pure function of the real wall
// clock, so nobody has to seed anything or send a tick over the wire.
//
//   worldT()  = (sharedNow() − WORLD_EPOCH_MS) / 1000        seconds, monotonic
//   tod()     = frac(START_TOD + worldT() / DAY_LENGTH)      0..1, 0 = midnight
//
// Both machines have NTP, so `sharedNow()` is just their own wall clock, plus
// a small offset learned from the server's WELCOME. That is the whole design:
// no per-frame sync, no authority tick, no protocol change.
//
// WHAT IF SOMEBODY'S CLOCK IS WRONG? Three cases, and none of them is fatal:
//
//  1. Wrong clock, playing SOLO. setEpoch() was never called with a server
//     time, so world time follows their own wall clock. They get a different
//     hour than anyone else — and it does not matter, because there is nobody
//     to disagree with. The sky is still coherent, the day still runs.
//  2. Wrong clock, joining a room. WELCOME carries the server's `Date.now()`;
//     setEpoch() anchors us to THAT value, not to ours, so the whole error is
//     cancelled the moment we connect no matter how large it is (minutes,
//     hours, a laptop that booted with a dead RTC in 1970). Sync accuracy
//     then depends only on the network, not on either machine's clock.
//  3. Clock stepped MID-SESSION (NTP correction, user edits it, laptop wakes
//     from sleep). We never read Date.now() per frame — the clock advances on
//     performance.now(), which no OS clock step can move. A step is noticed
//     only by the lazy re-anchor below, and while we are server-synced it is
//     absorbed so shared time does not jump.
//
// ACCURACY. Without a round-trip measurement the anchor is late by one
// network leg (~10–60 ms EU-internal) — already inside the ~50 ms budget and
// the same order as NTP's own error. Pass `rttMs` and we subtract half of it,
// which drops the bias to the path asymmetry (single-digit ms). Repeated
// calls keep the LOWEST-rtt sample, the classic NTP heuristic, because a
// sample that took longer to arrive is a worse measurement, not a newer one.
//
// MONOTONICITY. worldT() never goes backwards under normal operation:
// corrections up to CLOCK.stepMs are SLEWED (the offset moves at 0.2 ms per
// ms while real time moves 1 ms per ms, so shared time still advances at
// 0.8× worst case, never negative). The one exception is deliberate: a
// correction larger than CLOCK.stepMs — i.e. a genuinely broken clock — is
// stepped, because slewing an hour would take five days. Consumers must
// tolerate that single jump at join time. Traffic lights and deterministic
// spawns do, since they read worldT() fresh every frame instead of
// integrating it; anything that keeps its own accumulator must not.
//
// UNITS. Seconds, double precision, and NOT wrapped — worldT() is a few tens
// of millions and climbing. That is exact in a float64 (a double still
// resolves ~10 ns there) but it is NOT safe in a float32 shader uniform,
// where 2e7 quantises to ~2 s steps. Shaders want worldPhase(period).
// ==========================================================================

import { DAY_LENGTH, START_TOD, WORLD_EPOCH_MS, CLOCK } from './config.js';

// A clock that cannot be moved by the OS. performance.now() is monotonic and
// immune to wall-clock steps; Date.now() is neither. Node exposes it as a
// global too, so the headless tests take the same path the browser does.
const mono = (typeof performance !== 'undefined' && typeof performance.now === 'function')
  ? () => performance.now()
  : () => Date.now();

// Our local wall clock, rebuilt from a fixed anchor plus monotonic elapsed
// time: localNow() = _wallAnchor + (mono() − _monoAnchor).
let _monoAnchor = mono();
let _wallAnchor = Date.now();

let _offsetMs = 0;        // shared = local + this. Slews toward _targetMs.
let _targetMs = 0;        // where the last accepted sample wants the offset.
let _slewAt = _monoAnchor; // when the slew was last advanced.
let _bestRtt = Infinity;  // round trip of the best sample we have accepted.
let _synced = false;      // has a server time ever been accepted?

// A machine that suspended (or an OS clock step) shows up as our monotonic
// wall clock drifting away from Date.now(). Re-anchor when that gets big.
// Server-synced, the delta is ABSORBED into the offset so shared time stays
// continuous — the base moved, the answer must not. Unsynced (solo) we let
// it through on purpose: after an 8-hour sleep, following the real clock is
// more correct than a sky frozen at bedtime.
function _reanchor(t) {
  const wall = Date.now();
  const d = wall - (_wallAnchor + (t - _monoAnchor));
  if (!(Math.abs(d) > CLOCK.reanchorMs)) return;  // !(>) also swallows NaN
  _wallAnchor = wall; _monoAnchor = t;
  if (_synced) { _offsetMs -= d; _targetMs -= d; }
}

// Advance the slew. Lazy — driven by whoever reads the clock, so there is no
// timer to leak and a paused tab costs nothing.
function _slew(t) {
  if (_offsetMs === _targetMs) { _slewAt = t; return; }
  const step = CLOCK.slewRate * Math.max(0, t - _slewAt);
  _slewAt = t;
  const d = _targetMs - _offsetMs;
  _offsetMs = Math.abs(d) <= step ? _targetMs : _offsetMs + Math.sign(d) * step;
}

// ---- public API ----

// Adopt the server's clock. `serverNowMs` is the server's Date.now() as it
// appeared in WELCOME (or any later message); `rttMs`, when known, is the
// full round trip of the exchange that carried it, half of which is how old
// the timestamp already is. Pass null to fall back to this machine's own
// wall clock — the single-player path, and the correct reset on disconnect.
// Safe to call repeatedly (e.g. from PONG): a sample is accepted only if it
// is our first or measurably better than the one we are using.
// Returns the offset now in force, in ms, for logging.
export function setEpoch(serverNowMs, rttMs = null) {
  const t = mono();
  _reanchor(t); _slew(t);

  if (serverNowMs == null || !Number.isFinite(serverNowMs)) {
    _offsetMs = _targetMs = 0; _bestRtt = Infinity; _synced = false;
    return 0;
  }
  const rtt = (Number.isFinite(rttMs) && rttMs >= 0) ? rttMs : null;
  // Keep the best measurement, not the newest one. An unmeasured sample can
  // never displace a measured one; without any measurement, first wins and
  // later calls are no-ops (re-anchoring on every heartbeat would inject the
  // jitter we are trying to keep out).
  if (_synced && (rtt === null || rtt > _bestRtt)) return _offsetMs;

  const local = _wallAnchor + (t - _monoAnchor);
  const want = serverNowMs + (rtt === null ? 0 : rtt / 2) - local;
  // First sync, or a clock so wrong that slewing it would take days: step.
  // Everything else slews, which is what keeps worldT() monotonic.
  if (!_synced || Math.abs(want - _offsetMs) > CLOCK.stepMs) _offsetMs = _targetMs = want;
  else _targetMs = want;

  _synced = true;
  if (rtt !== null) _bestRtt = rtt;
  return _offsetMs;
}

// Shared wall clock in ms — the same value on every client in the room.
// Use it for timestamps that cross the wire (snapshot ages, lag readouts);
// use worldT() for anything the simulation integrates.
export function nowMs() {
  const t = mono();
  _reanchor(t); _slew(t);
  return _wallAnchor + (t - _monoAnchor) + _offsetMs;
}

// Seconds of shared world time. Monotonic (see the header for the one
// exception), identical on two synced clients to a few ms, and the input
// every deterministic system should key off: traffic-light phase, scheduled
// spawns, anything that must line up between machines without a message.
export function worldT() {
  return (nowMs() - WORLD_EPOCH_MS) / 1000;
}

// Time of day, 0..1 with 0 = midnight — what sky.js, the HUD clock and the
// traffic-density curve consume. START_TOD is the phase at WORLD_EPOCH_MS,
// so the world reads 10:30 at every real UTC midnight rather than at the
// moment you happened to press Play. Two players who boot an hour apart now
// share an hour; the cost is that a solo player no longer always spawns
// mid-morning, which is the trade the shared world requires.
export function tod() {
  const d = START_TOD + worldT() / DAY_LENGTH;
  return d - Math.floor(d);   // frac(), correct for negative d (pre-epoch)
}

// worldT() folded into [0, period) — shared and deterministic like worldT()
// but small enough for a float32 shader uniform or a cycle-phase lookup.
export function worldPhase(period) {
  if (!(period > 0)) return 0;
  const p = worldT() % period;
  return p < 0 ? p + period : p;
}

// Diagnostics for the net HUD: are we on the server's clock, and by how much
// did adopting it move us? A large offset here is the smoking gun when a
// player reports "it's night for me and day for everyone else".
export function isSynced() { return _synced; }
export function offsetMs() { return _offsetMs; }

// Test hook / hard reset — forget the server and re-anchor to this machine.
export function resetClock() {
  _monoAnchor = mono();
  _wallAnchor = Date.now();
  _slewAt = _monoAnchor;
  _offsetMs = _targetMs = 0;
  _bestRtt = Infinity;
  _synced = false;
}
