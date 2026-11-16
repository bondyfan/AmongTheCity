// ==========================================================================
// The co-op's own budget: what this Durable Object has cost this billing
// cycle, counted by the object itself and counted HIGH on purpose.
//
// Workers Paid includes, per month and shared by every Worker on the account:
//   1,000,000 Durable Object requests (an inbound WebSocket message is 1/20)
//   400,000 GB-s of Durable Object duration (128 MB per object, i.e. 0.125 GB
//   for every second the object is awake)
// This file is pure (no Workers APIs), so test.js runs it directly in Node.
//
// How it overcounts, deliberately:
//   - awake time: every event is charged the gap since the previous event, up
//     to AWAKE_TAIL_MS (the runtime hibernates an idle object after 10 s). The
//     first event after a wake is charged a whole tail, which pays for the
//     tail after the last event before the object slept. With 10 Hz state
//     traffic that is the whole wall-clock time anyone is connected.
//   - requests: every fetch and every alarm is one, every inbound message is
//     1/20, the dropped and refused ones included, and every close is 1/20.
//   - memory loss: the counters live in memory and are written to storage at
//     most about once a minute. A wake from hibernation forgets what was not
//     written yet, so every write already contains a RESERVATION for what the
//     next minute may bring at the current rate, and an early write happens
//     the moment the unwritten part outgrows it. After a wake the reservation
//     is simply kept as if it had been used: the count can only come out high.
// ==========================================================================

export const GB_PER_OBJECT = 0.125;       // 128 MB
export const MSGS_PER_REQUEST = 20;        // inbound WebSocket messages per billed request
export const AWAKE_TAIL_MS = 10000;
export const FLUSH_MS = 60000;
// what one event on an object without sockets is charged (a /health poll)
export const IDLE_EVENT_MS = 100;

// ------------------------------------------------------------- the cycle ---
// The billing cycle runs from CYCLE_DAY to CYCLE_DAY, starting 00:00 UTC.
// A day past the end of a short month means that month's last day.
function dayIn(y, m, day) {
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(y, m, Math.min(Math.max(1, day), last));
}

export function cycleBounds(nowMs, day = 13) {
  const d = new Date(nowMs);
  let y = d.getUTCFullYear(), m = d.getUTCMonth();
  let start = dayIn(y, m, day);
  if (nowMs < start) { m -= 1; if (m < 0) { m = 11; y -= 1; } start = dayIn(y, m, day); }
  let ny = y, nm = m + 1;
  if (nm > 11) { nm = 0; ny += 1; }
  const end = dayIn(ny, nm, day);
  return { id: new Date(start).toISOString().slice(0, 10), start, end };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// --------------------------------------------------------------- meter ---
export class Meter {
  constructor({ day = 13, tailMs = AWAKE_TAIL_MS, flushMs = FLUSH_MS } = {}) {
    this.day = day;
    this.tailMs = tailMs;
    this.flushMs = flushMs;
    this.cycle = null;
    this.ms = 0; this.msgs = 0; this.reqs = 0;   // counted this cycle
    this.last = 0;                               // previous event in THIS instance (0 = just woke)
    this.flushedAt = 0;
    this.base = { ms: 0, msgs: 0, reqs: 0 };     // the counted values at the last write
    this.reserve = { ms: tailMs, msgs: MSGS_PER_REQUEST, reqs: 2 };
  }

  // Load the stored record (or null). A record from another cycle is ignored.
  load(rec, now) {
    this.roll(now);
    if (rec && rec.cyc === this.cycle.id) {
      this.ms = Number(rec.ms) || 0;
      this.msgs = Number(rec.msgs) || 0;
      this.reqs = Number(rec.reqs) || 0;
      this.flushedAt = Number(rec.at) || 0;
    }
    this.base = { ms: this.ms, msgs: this.msgs, reqs: this.reqs };
    return this;
  }

  // Move to the cycle `now` is in. True when a new cycle started (counters reset).
  roll(now) {
    const c = this.cycle;
    if (c && now >= c.start && now < c.end) return false;
    const fresh = !c;
    this.cycle = cycleBounds(now, this.day);
    if (fresh) return false;
    this.ms = 0; this.msgs = 0; this.reqs = 0;
    this.base = { ms: 0, msgs: 0, reqs: 0 };
    this.flushedAt = 0;
    return true;
  }

  // `maxMs` caps what this one event may be charged. The host passes a small
  // value for an event on an object with no sockets at all (a /health poll
  // of an empty room): nothing keeps such an object awake after its handler,
  // so charging it the gap or a whole tail would make a menu left open count
  // like a connected player.
  awake(now, maxMs = this.tailMs) {
    const cap = Math.min(maxMs, this.tailMs);
    this.ms += this.last ? clamp(now - this.last, 0, cap) : cap;
    this.last = Math.max(this.last, now);
  }

  msg(now, n = 1, maxMs) { this.awake(now, maxMs); this.msgs += n; }
  req(now, n = 1, maxMs) { this.awake(now, maxMs); this.reqs += n; }

  get gbs() { return (this.ms / 1000) * GB_PER_OBJECT; }
  get requests() { return this.reqs + this.msgs / MSGS_PER_REQUEST; }

  over(caps) {
    return (caps.gbs > 0 && this.gbs >= caps.gbs) || (caps.requests > 0 && this.requests >= caps.requests);
  }

  // Time to write: a minute passed, or the unwritten part outgrew its reservation.
  due(now) {
    const b = this.base, r = this.reserve;
    return now - this.flushedAt >= this.flushMs
      || this.ms - b.ms >= r.ms || this.msgs - b.msgs >= r.msgs || this.reqs - b.reqs >= r.reqs;
  }

  // What to store: the count plus a reservation for the next minute at the
  // rate of the last window (never less than one tail, one request).
  record(now) {
    const b = this.base;
    const win = this.flushedAt ? Math.max(1000, now - this.flushedAt) : this.flushMs;
    const scale = this.flushMs / win;
    this.reserve = {
      ms: clamp(1.25 * (this.ms - b.ms) * scale, this.tailMs, this.flushMs),
      msgs: Math.max(MSGS_PER_REQUEST, Math.ceil(1.5 * (this.msgs - b.msgs) * scale)),
      reqs: Math.max(2, Math.ceil(1.5 * (this.reqs - b.reqs) * scale)),
    };
    this.base = { ms: this.ms, msgs: this.msgs, reqs: this.reqs };
    this.flushedAt = now;
    return {
      cyc: this.cycle.id,
      ms: Math.round(this.ms + this.reserve.ms),
      msgs: this.msgs + this.reserve.msgs,
      reqs: this.reqs + this.reserve.reqs,
      at: now,
    };
  }

  summary() {
    return {
      cycle: this.cycle.id,
      resetsAt: new Date(this.cycle.end).toISOString(),
      gbs: Math.round(this.gbs * 10) / 10,
      requests: Math.round(this.requests),
    };
  }
}
