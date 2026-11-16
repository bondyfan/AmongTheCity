// The budget arithmetic and the account guard, tested directly in Node: the
// cycle and its rollover, the overcounting meter, the reservation that makes
// a lost (hibernated) memory count high instead of low, and the GraphQL
// guard against a stubbed fetch.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AWAKE_TAIL_MS, GB_PER_OBJECT, IDLE_EVENT_MS, Meter, cycleBounds } from '../src/budget.js';
import { accountOver, accountUsage, queryDates } from '../src/account.js';
import { utf8Bytes } from '../src/conn.js';

const T = (s) => Date.parse(s);

test('cycle: the 13th to the 13th, from 00:00 UTC', () => {
  const c = cycleBounds(T('2026-11-16T10:00:00Z'), 13);
  assert.equal(c.id, '2026-11-13');
  assert.equal(c.start, T('2026-11-13T00:00:00Z'));
  assert.equal(c.end, T('2026-12-13T00:00:00Z'));
  assert.equal(cycleBounds(T('2026-11-12T23:59:59Z'), 13).id, '2026-10-13', 'before the 13th is last cycle');
  assert.equal(cycleBounds(T('2026-11-13T00:00:00Z'), 13).id, '2026-11-13', 'the boundary belongs to the new one');
  assert.equal(cycleBounds(T('2027-01-05T00:00:00Z'), 13).id, '2026-12-13', 'across the new year');
  const dec = cycleBounds(T('2026-12-20T00:00:00Z'), 13);
  assert.equal(dec.end, T('2027-01-13T00:00:00Z'));
});

test('cycle: a day past the end of a short month is its last day', () => {
  assert.equal(cycleBounds(T('2027-02-28T12:00:00Z'), 31).id, '2027-02-28');
  assert.equal(cycleBounds(T('2028-02-29T12:00:00Z'), 31).id, '2028-02-29', 'leap year');
  assert.equal(cycleBounds(T('2027-02-27T12:00:00Z'), 31).id, '2027-01-31');
  assert.equal(cycleBounds(T('2027-02-27T12:00:00Z'), 31).end, T('2027-02-28T00:00:00Z'));
});

test('meter: rollover resets the counts at the next cycle, and an old record is ignored', () => {
  const m = new Meter({ day: 13 }).load(null, T('2026-12-12T23:59:00Z'));
  m.msg(T('2026-12-12T23:59:00Z'), 400);
  assert.equal(m.requests, 20);
  assert.equal(m.roll(T('2026-12-12T23:59:30Z')), false, 'same cycle');
  assert.equal(m.roll(T('2026-12-13T00:00:01Z')), true, 'the 13th starts a new cycle');
  assert.equal(m.requests, 0);
  assert.equal(m.gbs, 0);
  assert.equal(m.cycle.id, '2026-12-13');
  const old = { cyc: '2026-11-13', ms: 9e9, msgs: 9e9, reqs: 9e9, at: 1 };
  const fresh = new Meter({ day: 13 }).load(old, T('2026-12-14T00:00:00Z'));
  assert.equal(fresh.requests, 0, 'last cycle\'s record does not count');
});

test('meter: 10 Hz traffic is charged the whole wall-clock time, a lone event one tail', () => {
  const t0 = T('2026-11-20T12:00:00Z');
  const m = new Meter().load(null, t0);
  for (let i = 0; i <= 600; i++) m.msg(t0 + i * 100);      // one minute at 10 Hz
  const expected = (60 + AWAKE_TAIL_MS / 1000) * GB_PER_OBJECT;
  assert.ok(Math.abs(m.gbs - expected) < 1e-9, `${m.gbs} vs ${expected}`);
  assert.ok(Math.abs(m.requests - 601 / 20) < 1e-9);
  const lone = new Meter().load(null, t0);
  lone.req(t0); lone.req(t0 + 3600e3);
  assert.equal(lone.gbs, 2 * (AWAKE_TAIL_MS / 1000) * GB_PER_OBJECT, 'a gap is charged one tail, not an hour');
});

test('meter: a wake that forgets the unwritten counts still counts high (reservation)', () => {
  // A minute of dense play, then quiet spells, then a burst, with the object
  // "hibernating" (memory thrown away, the stored record reloaded) at
  // arbitrary moments. The reloaded count must never be below the truth.
  let rnd = 7;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  for (let trial = 0; trial < 50; trial++) {
    const t0 = T('2026-11-20T12:00:00Z');
    let stored = null;
    let m = new Meter().load(stored, t0);
    let truthMsgs = 0;
    let t = t0;
    for (let step = 0; step < 3000; step++) {
      const dense = (step % 700) < 500;
      t += dense ? 100 : 1000 + Math.floor(rand() * 30000);
      const n = dense && rand() < 0.1 ? 40 : 1;          // the odd 40-frame burst
      m.msg(t, n);
      truthMsgs += n;
      if (m.due(t)) stored = m.record(t);
      if (rand() < 0.01) {                                // hibernate: memory is lost
        m = new Meter().load(stored, t + 11000);
        t += 11000;
        assert.ok(m.msgs >= truthMsgs - 0, `trial ${trial}: lost messages ${m.msgs} < ${truthMsgs}`);
      }
    }
  }
});

test('meter: writes stay at about one a minute in steady play', () => {
  const t0 = T('2026-11-20T12:00:00Z');
  const m = new Meter().load(null, t0);
  let writes = 0;
  for (let i = 0; i < 10 * 60 * 10; i++) {               // ten minutes at 10 Hz from 5 players
    const t = t0 + i * 100;
    m.msg(t, 5);
    if (m.due(t)) { m.record(t); writes++; }
  }
  assert.ok(writes <= 14, `${writes} writes in ten minutes`);
});

test('meter: over() is the cap check', () => {
  const m = new Meter().load(null, T('2026-11-20T12:00:00Z'));
  m.msg(T('2026-11-20T12:00:00Z'), 200);
  assert.equal(m.over({ gbs: 0, requests: 10 }), true);
  assert.equal(m.over({ gbs: 0, requests: 11 }), false);
  assert.equal(m.over({ gbs: 1, requests: 0 }), true, '10 s awake is 1.25 GB-s');
});

test('account guard: the GraphQL answer becomes GB-s and requests', async () => {
  let seen = null;
  const fetch = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ data: { viewer: { accounts: [{
      periodic: [{ sum: { activeTime: 2e12, inboundWebsocketMsgCount: 2000 } }, { sum: { activeTime: 1e12, inboundWebsocketMsgCount: 0 } }],
      invocations: [{ sum: { requests: 900 } }],
    }] } } }), { status: 200 });
  };
  const cyc = cycleBounds(T('2026-11-16T10:00:00Z'), 13);
  const u = await accountUsage({ fetch, url: 'https://x/graphql', token: 'tok', accountId: 'acc1',
    ...queryDates(cyc, T('2026-11-16T10:00:00Z')) });
  assert.equal(u.gbs, 3e6 * 0.125, '3e12 us = 3e6 s at 0.125 GB');
  assert.equal(u.requests, 900 + 100);
  assert.equal(seen.init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(seen.body.variables, { acc: 'acc1', start: '2026-11-13', end: '2026-11-16' });
  assert.equal(accountOver(u, { gbs: 380000, requests: 950000 }), false);
  assert.equal(accountOver(u, { gbs: 375000, requests: 950000 }), true);
  assert.equal(accountOver(u, { gbs: 0, requests: 1000 }), true);
});

test('meter: an event on an object without sockets is charged a sliver, not a tail', () => {
  const t0 = T('2026-11-20T12:00:00Z');
  const m = new Meter().load(null, t0);
  for (let i = 0; i < 360; i++) m.req(t0 + i * 10000, 1, IDLE_EVENT_MS);   // an hour of 10 s menu polls
  assert.ok(m.gbs <= 360 * (IDLE_EVENT_MS / 1000) * GB_PER_OBJECT + 1e-9, `${m.gbs} GB-s`);
  m.msg(t0 + 3600e3 + 100);                                                  // a socket event still gets the gap
  assert.ok(m.gbs > 360 * (IDLE_EVENT_MS / 1000) * GB_PER_OBJECT);
});

const answer = (inv, inbound = 0, activeTime = 0) => async () => new Response(JSON.stringify({ data: { viewer: { accounts: [{
  periodic: [{ sum: { activeTime, inboundWebsocketMsgCount: inbound } }],
  invocations: [{ sum: { requests: inv } }],
}] } } }), { status: 200 });

test('account guard: co-op\'s own hibernated messages count 1/20, not one for one', async () => {
  const args = { token: 't', accountId: 'a', start: '2026-11-13', end: '2026-11-16' };
  // 20 players at 10 Hz for an hour on hibernated sockets: 720,000 invocations
  // in the analytics, 36,000 billed requests
  const own = 720000;
  const u = await accountUsage({ ...args, fetch: answer(own + 5000), ownMsgs: own });
  assert.equal(u.requests, 5000 + own / 20);
  assert.equal(accountOver(u, { gbs: 0, requests: 950000 }), false, 'an hour of a full room does not close co-op');
  // other Workers' invocations stay counted one for one (high, never low)
  assert.equal((await accountUsage({ ...args, fetch: answer(900000) })).requests, 900000);
  // the correction never goes below zero when the analytics lag behind our count
  assert.equal((await accountUsage({ ...args, fetch: answer(100), ownMsgs: 1000 })).requests, 100 / 20);
});

test('account guard: a request that never answers times out', async () => {
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)));
  const t0 = Date.now();
  const keep = setTimeout(() => {}, 5000);   // Node's AbortSignal.timeout timer does not hold the loop open
  await assert.rejects(accountUsage({ token: 't', accountId: 'a', start: 's', end: 'e', fetch: hang, timeoutMs: 200 }));
  clearTimeout(keep);
  assert.ok(Date.now() - t0 < 2000);
});

test('account guard: errors throw instead of reading as "low"', async () => {
  const bad = (status, body) => async () => new Response(JSON.stringify(body), { status });
  const args = { token: 't', accountId: 'a', start: '2026-11-13', end: '2026-11-16' };
  await assert.rejects(accountUsage({ ...args, fetch: bad(403, {}) }), /HTTP 403/);
  await assert.rejects(accountUsage({ ...args, fetch: bad(200, { errors: [{ message: 'not authorized' }] }) }), /not authorized/);
  await assert.rejects(accountUsage({ ...args, fetch: bad(200, { data: { viewer: { accounts: [] } } }) }), /no such account/);
});

test('frame sizes are measured in UTF-8 bytes, like the Node relay', () => {
  assert.equal(utf8Bytes('abc'), 3);
  assert.equal(utf8Bytes('Hráč'), 6);
  assert.equal(utf8Bytes('\u{1f468}'), 4);
  assert.equal(utf8Bytes('€'), 3);
});
