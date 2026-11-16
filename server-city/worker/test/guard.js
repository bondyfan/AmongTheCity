// What only the Durable Object host has: waking from hibernation, the budget
// guard (own caps and the account-wide one), the per-IP caps behind
// Cloudflare's address, the handshake limiter, reaping by alarm, the /health
// isolate cache and a room that survives a restart.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, roomId, sleep, startWorker } from './helpers.js';

test('a wake from hibernation keeps every seat, the authority, the states and the clock', async () => {
  const { M } = await boot();
  const r = roomId('wake');
  const a = M.client(r); await a.hello('boss');
  const wa = await a.wait((m) => m.t === 'welcome');
  const b = M.client(r); await b.hello('guest');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { x: 7, y: 0, z: 8, nm: 'Šéf' } });
  await b.wait((m) => m.t === 'state' && m.from === 'boss');
  a.send({ t: 'snap', snap: [{ x: 1, y: 2, z: 3, r: 9, id: 'boss:1' }] });
  await b.wait((m) => m.t === 'snap');
  const before = await M.health(r);

  assert.equal((await M.forget(r)).ok, true);   // in-memory state gone, as after hibernation

  const after = await M.health(r);
  assert.equal(after.players, 2, 'both seats rebuilt from the attachments');
  assert.equal(after.created, before.created, 'the room clock did not move');
  assert.equal(after.budget.requests >= before.budget.requests, true, 'the budget never counts down');
  // the seats still relay, both ways
  b.send({ t: 'state', state: { x: 3, y: 0, z: 3 } });
  assert.equal((await a.wait((m) => m.t === 'state' && m.from === 'guest')).state.x, 3);
  // the authority is still the authority: its meta patch is accepted
  a.send({ t: 'meta', patch: { state: 'paused' } });
  assert.equal((await b.wait((m) => m.t === 'meta')).meta.state, 'paused');
  // and a joiner gets the restored state blob and the snapshot
  const c = M.client(r); await c.hello('late');
  const wc = await c.wait((m) => m.t === 'welcome');
  assert.equal(wc.meta.created, wa.meta.created);
  const ps = wc.peerStates.find((p) => p.uid === 'boss');
  assert.equal(ps && ps.state.nm, 'Šéf', 'lastState came back from the attachment');
  assert.equal((await c.wait((m) => m.t === 'snap')).snap[0].id, 'boss:1');
  // a reconnect after the wake is still a takeover, not a second seat
  const a2 = M.client(r); await a2.hello('boss');
  await a2.wait((m) => m.t === 'welcome');
  assert.equal(await a.waitClose(), 4001);
  await sleep(200);
  assert.equal((await M.health(r)).players, 3);
});

test('the own budget: a cap closes every socket with 4402, refuses new ones, /health says limit', async () => {
  const { B } = await boot();
  const r = roomId('own');
  const a = B.client(r); await a.hello('player');
  await a.wait((m) => m.t === 'welcome');
  const watcher = B.client(r); await watcher.hello('watcher');
  await watcher.wait((m) => m.t === 'welcome');
  // BUDGET_REQUESTS=10 is 200 inbound messages; dropped ones count too
  for (let i = 0; i < 260 && a.closed === null; i++) {
    a.send({ t: 'state', state: { x: i } });
    if (i % 50 === 49) await sleep(600);
  }
  assert.equal(await a.waitClose(), 4402, 'the sender is closed with 4402');
  assert.equal(await watcher.waitClose(), 4402, 'and so is everybody else');
  assert.equal(a.msgs.some((m) => m.t === 'error' && m.code === 'limit'), true);

  const h = await B.health(r);
  assert.equal(h.ready, false);
  assert.equal(h.reason, 'limit');
  assert.equal(h.scope, 'own');
  assert.match(h.resetsAt, /-13T00:00:00/);

  const late = B.client(r); await late.hello('late');
  assert.equal(await late.waitClose(), 4402, 'a new socket is refused');
  assert.equal(late.msgs.some((m) => m.t === 'error' && m.code === 'limit'), true);
  assert.equal(late.msgs.some((m) => m.t === 'welcome'), false);

  await B.forget(r);   // the limit is in storage, not just in memory
  const h2 = await B.health(r);
  assert.equal(h2.reason, 'limit', 'still limited after a wake');
});

test('the account guard: the first join of a cycle asks the analytics API, and closes co-op when over', async () => {
  const { B, stub } = await boot();
  const r = roomId('acc');
  stub.mode = 'high';
  const from = stub.calls.length;
  const a = B.client(r); await a.hello('first');
  assert.equal(await a.waitClose(6000), 4402, 'closed once the account is over');
  const call = stub.calls[from];
  assert.ok(call, 'the GraphQL API was asked');
  assert.equal(call.auth, 'Bearer test-token');
  assert.equal(call.body.variables.acc, 'b7117cdad0da911d200d1cff741dd934');
  assert.match(call.body.variables.start, /^\d{4}-\d\d-13$/);
  assert.match(call.body.query, /durableObjectsPeriodicGroups/);
  assert.match(call.body.query, /durableObjectsInvocationsAdaptiveGroups/);
  const h = await B.health(r);
  assert.equal(h.ready, false);
  assert.equal(h.scope, 'account');
  assert.equal(h.account.gbs > 1000, true);
  // and it asks again only hourly: another join while limited asks nothing
  const n = stub.calls.length;
  const b = B.client(r); await b.hello('second');
  await b.waitClose();
  await sleep(300);
  assert.equal(stub.calls.length, n, 'no second query');
  stub.mode = 'low';
});

test('per-IP caps hold, and a client cannot pick its own address', async () => {
  const { C } = await boot();
  const r = roomId('ip');
  // x-coop-ip is what the Durable Object reads; the Worker must overwrite it
  const spoof = (n) => ({ headers: { 'x-coop-ip': `10.0.0.${n}` } });
  const a = C.client(r, spoof(1)); await a.hello('ip1');
  await a.wait((m) => m.t === 'welcome');
  const b = C.client(r, spoof(2)); await b.hello('ip2');
  await b.wait((m) => m.t === 'welcome');
  const c = C.client(r, spoof(3)); await c.hello('ip3');
  const err = await c.wait((m) => m.t === 'error');
  assert.match(err.msg, /Too many players/, 'MAX_PLAYERS_PER_IP=2 holds');
  await c.waitClose();
  assert.equal((await C.health(r)).players, 2);

  const r2 = roomId('ipsock');
  const cs = [1, 2, 3, 4].map((n) => C.client(r2, spoof(n)));
  await sleep(800);
  // the Durable Object refuses the upgrade itself (HTTP 429) once the runtime
  // holds MAX_SOCKETS_PER_IP sockets for the address
  const refused = cs.filter((x) => x.closed === 4029 || /429/.test(x.error || ''));
  assert.equal(refused.length, 1, 'MAX_SOCKETS_PER_IP=3 holds');
  for (const x of [a, b, ...cs]) x.ws.close();
});

test('the Worker refuses a handshake flood itself (429), before the Durable Object is billed', async () => {
  const { C } = await boot();
  const r = roomId('flood');
  const cs = [];
  for (let i = 0; i < 20; i++) { cs.push(C.client(r)); await sleep(20); }
  await sleep(800);
  const refused = cs.filter((c) => /429/.test(c.error || '')).length;
  assert.equal(refused > 0, true, 'some handshakes got 429');
  const h = await C.health(r);
  assert.equal(h.budget.requests < cs.length, true, `the room only saw what got through (${h.budget.requests})`);
  for (const c of cs) { try { c.ws.close(); } catch {} }
});

test('a silent seated socket is reaped by the alarm', async () => {
  const { S } = await boot();
  const r = roomId('silent');
  const a = S.client(r); await a.hello('quiet');
  await a.wait((m) => m.t === 'welcome');
  assert.equal(await a.waitClose(6000), 4003, 'SILENCE_MS=1500 closed it, with its own code');
  assert.equal(a.msgs.some((m) => m.t === 'error' && m.code === 'silent'), true);
});

test('a seated socket that never moves is closed as idle; a moving one stays', async () => {
  const { S } = await boot();
  const r = roomId('idle');
  const still = S.client(r); await still.hello('afk');
  const mover = S.client(r); await mover.hello('active');
  await still.wait((m) => m.t === 'welcome');
  await mover.wait((m) => m.t === 'welcome');
  for (let i = 0; i < 12 && still.closed === null; i++) {
    still.send({ t: 'state', state: { x: 10, y: 0, z: 10 } });
    mover.send({ t: 'state', state: { x: 10 + i * 5, y: 0, z: 10 } });
    await sleep(450);
  }
  assert.equal(await still.waitClose(3000), 4002, 'IDLE_MS=3000 closed the parked tab');
  assert.equal(still.msgs.some((m) => m.t === 'error' && m.code === 'idle'), true);
  assert.equal(mover.closed, null, 'the player who moves plays on');
  mover.ws.close();
});

test('/health is answered from the isolate cache, not by waking the object every poll', async () => {
  const { S } = await boot();
  const r = roomId('cache');
  const h1 = await S.health(r);
  const h2 = await S.health(r);
  const h3 = await S.health(r);
  assert.equal(h2.budget.requests, h1.budget.requests, 'the second poll did not reach the object');
  assert.equal(h3.budget.requests, h1.budget.requests);
  await sleep(1700);
  const h4 = await S.health(r);
  assert.equal(h4.budget.requests > h1.budget.requests, true, 'after HEALTH_TTL_MS it asks again');
});

test('the room clock, the wreckage and the budget survive a restart of the server', async () => {
  const W1 = await startWorker({ HEALTH_TTL_MS: '0', UPGRADES_PER_MIN: '1000' });
  const r = 'KEEP';
  const a = W1.client(r); await a.hello('boss');
  const w1 = await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'snap', snap: [{ x: 1, y: 2, z: 3, r: 9, id: 'boss:9' }] });
  await sleep(300);
  a.ws.close();
  await sleep(400);
  const h1 = await W1.health(r);
  const dir = W1.dir;
  await W1.stop();

  const W2 = await startWorker({ HEALTH_TTL_MS: '0', UPGRADES_PER_MIN: '1000' }, { persist: dir });
  const b = W2.client(r); await b.hello('later');
  const w2 = await b.wait((m) => m.t === 'welcome');
  assert.equal(w2.meta.created, w1.meta.created, 'meta.created is stored, not re-minted');
  assert.equal((await b.wait((m) => m.t === 'snap')).snap[0].id, 'boss:9');
  const h2 = await W2.health(r);
  assert.equal(h2.budget.requests >= h1.budget.requests, true, 'the cycle count carried over');
  assert.equal(h2.budget.gbs >= h1.budget.gbs, true);
  b.ws.close();
  await W2.stop();
});
