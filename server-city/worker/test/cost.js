// The review's cost findings, pinned: peers that ignore our close frame, the
// account guard failing closed and surviving a hung request, a menu poll that
// must not count as a connected player, and a snapshot a wake must not lose.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, rawClient, roomId, sleep } from './helpers.js';

test('a peer that never answers our close still holds its slot: the address cannot open more', async () => {
  const { Z } = await boot();
  const r = roomId('zombie');
  const path = `/ws?room=${r}`;
  // two sockets that never say hello: closed with 4008 after 0.5 s, and they
  // never answer, so the runtime keeps them (CLOSING)
  const z = [await rawClient(Z.port, path), await rawClient(Z.port, path)];
  await sleep(1800);   // hello timeout + DEAD_GRACE_MS: the hub has dropped them
  assert.deepEqual(z.map((c) => c.closeCodes[0]), [4008, 4008]);
  assert.equal(z.every((c) => !c.ended), true, 'the peers kept their TCP connections open');
  const h = await Z.health(r);
  assert.equal(h.sockets, 0, 'off the hub\'s books');
  assert.equal(h.held, 2, 'but still held by the runtime');
  // MAX_SOCKETS_PER_IP=2 counts what the runtime holds: a third is refused
  // before it is accepted, so it can never become a third billable zombie
  await assert.rejects(rawClient(Z.port, path), /429/);
  // the frames they keep sending are counted, and served nothing
  const before = (await Z.health(r)).budget.requests;
  for (let i = 0; i < 100; i++) for (const c of z) c.send('{"t":"ping","ts":1}');
  await sleep(500);
  assert.equal((await Z.health(r)).budget.requests >= before + 200 / 20, true, 'counted toward the cap');
  for (const c of z) c.s.destroy();
  await sleep(500);
  assert.equal((await Z.health(r)).held, 0);
  const ok = await rawClient(Z.port, path);   // once they are gone the address may connect again
  ok.s.destroy();
});

test('the account guard fails closed: unmeasurable twice in a row closes co-op, a later success reopens it', async () => {
  const { G, stub2 } = await boot();
  const r = roomId('accclosed');
  stub2.mode = 'gqlerror';
  const a = G.client(r); await a.hello('player');
  await a.wait((m) => m.t === 'welcome');
  assert.equal(await a.waitClose(8000), 4503, 'closed after ACCOUNT_FAILS_TO_CLOSE=2 failed checks');
  assert.equal(a.msgs.some((m) => m.t === 'error' && m.code === 'unmeasured'), true);
  const h = await G.health(r);
  assert.equal(h.ready, false);
  assert.equal(h.reason, 'unmeasured');
  assert.equal(h.account.fails >= 2, true);
  assert.match(h.account.error, /unknown field/);
  const late = G.client(r); await late.hello('late');
  assert.equal(await late.waitClose(), 4503, 'nobody joins unmeasured');
  // the analytics API works again: a menu poll retries, co-op reopens
  stub2.mode = 'low';
  let ready = false;
  for (let i = 0; i < 30 && !ready; i++) { await sleep(300); ready = (await G.health(r)).ready; }
  assert.equal(ready, true, 'reopened by a successful check');
  const b = G.client(r); await b.hello('back');
  await b.wait((m) => m.t === 'welcome');
  b.ws.close();
});

test('a hung analytics request times out and the guard keeps working', async () => {
  const { G, stub2 } = await boot();
  const r = roomId('acchang');
  stub2.mode = 'hang';
  const from = stub2.calls.length;
  const a = G.client(r); await a.hello('player');
  await a.wait((m) => m.t === 'welcome');
  await sleep(600);
  assert.equal(stub2.calls.length > from, true, 'the first check went out and hangs');
  stub2.mode = 'high';
  // ACCOUNT_TIMEOUT_MS=800 ends the hung request, ACCOUNT_RETRY_MS=1000 retries
  assert.equal(await a.waitClose(8000), 4402, 'the retry saw the account over and closed co-op');
  const h = await G.health(r);
  assert.equal(h.scope, 'account');
  stub2.mode = 'low';
});

test('menu polls of an empty room are not charged like a connected player', async () => {
  const { M } = await boot();
  const r = roomId('polls');
  for (let i = 0; i < 10; i++) { await M.health(r); await sleep(200); }
  const h = await M.health(r);
  assert.equal(h.sockets, 0);
  // the old meter charged the first poll a 10 s tail (1.25 GB-s) and every
  // later one the gap since the previous poll
  assert.equal(h.budget.gbs < 0.5, true, `${h.budget.gbs} GB-s for 11 polls`);
});

test('the newest snapshot survives a wake that comes right after it', async () => {
  const { M } = await boot();
  const r = roomId('snapwake');
  const a = M.client(r); await a.hello('boss');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'snap', snap: [{ x: 1, y: 0, z: 1, r: 0, id: 'boss:1' }] });
  await sleep(300);
  a.send({ t: 'snap', snap: [{ x: 1, y: 0, z: 1, r: 0, id: 'boss:1' }, { x: 2, y: 0, z: 2, r: 0, id: 'boss:2' }] });
  await sleep(1500);   // the dirty row's alarm writes it within SAVE_EVERY_MS
  await M.forget(r);
  const c = M.client(r); await c.hello('late');
  const snap = await c.wait((m) => m.t === 'snap');
  assert.deepEqual(snap.snap.map((s) => s.id), ['boss:1', 'boss:2']);
  a.ws.close(); c.ws.close();
});
