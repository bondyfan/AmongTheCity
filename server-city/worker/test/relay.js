// The Node relay's scenarios (../../test.js), run against the Durable Object
// through wrangler dev: reconnect takeover, spoofing, every abuse ceiling.
// Each test gets its own room (TEST_ROOMS), the way test.js gets its own process.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boot, roomId, sleep } from './helpers.js';

const REAL_UID = 'u4f2a1b3c:9k2p';

test('F1: reconnecting with the same uid keeps exactly one seat, not zero', async () => {
  const { M } = await boot();
  const r = roomId('f1');
  const bystander = M.client(r); await bystander.hello('watcher');
  await bystander.wait((m) => m.t === 'welcome');
  const first = M.client(r); await first.hello('samewho');
  await first.wait((m) => m.t === 'welcome');
  assert.equal((await M.health(r)).players, 2, 'two players before the reconnect');

  const second = M.client(r); await second.hello('samewho');
  const welcome = await second.wait((m) => m.t === 'welcome');
  assert.deepEqual(welcome.peers, ['watcher']);
  assert.equal(await first.waitClose(), 4001, 'the stale socket is closed with 4001');

  await sleep(300);
  assert.equal((await M.health(r)).players, 2, 'the reconnected player still holds a seat');
  second.send({ t: 'state', state: { x: 1, y: 0, z: 2 } });
  const relayed = await bystander.wait((m) => m.t === 'state' && m.from === 'samewho');
  assert.equal(relayed.state.x, 1);
  bystander.send({ t: 'state', state: { x: 9, y: 0, z: 9 } });
  const back = await second.wait((m) => m.t === 'state' && m.from === 'watcher');
  assert.equal(back.state.x, 9);
});

test('F1b: a dropped socket DOES free its seat when nobody replaced it', async () => {
  const { M } = await boot();
  const r = roomId('f1b');
  const a = M.client(r); await a.hello('leaver');
  await a.wait((m) => m.t === 'welcome');
  assert.equal((await M.health(r)).players, 1);
  a.ws.close();
  await sleep(300);
  assert.equal((await M.health(r)).players, 0, 'a plain disconnect still leaves');
});

test('F13: ev.from cannot be spoofed', async () => {
  const { M } = await boot();
  const r = roomId('f13');
  const a = M.client(r); await a.hello('honest');
  const b = M.client(r); await b.hello('victim');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'event', ev: { k: 'boom', from: 'victim', x: 1 } });
  const ev = await b.wait((m) => m.t === 'event');
  assert.equal(ev.ev.from, 'honest', 'the server stamps `from`, the client cannot');
  assert.equal(ev.ev.k, 'boom');
});

test('F23: a joiner learns every peer\'s last state immediately', async () => {
  const { M } = await boot();
  const r = roomId('f23');
  const a = M.client(r); await a.hello('early');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { x: 42, y: 0, z: 7, nm: 'Ranger' } });
  await sleep(150);
  const c = M.client(r); await c.hello('late');
  const welcome = await c.wait((m) => m.t === 'welcome');
  assert.deepEqual(welcome.peers, ['early']);
  assert.equal(welcome.peerStates.length, 1);
  assert.equal(welcome.peerStates[0].state.x, 42);
  const st = await c.wait((m) => m.t === 'state' && m.from === 'early');
  assert.equal(st.state.nm, 'Ranger');
});

test('F23b: reconnecting keeps the avatar, lastState survives the new socket', async () => {
  const { M } = await boot();
  const r = roomId('f23b');
  const a = M.client(r); await a.hello('mover');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { x: 5, y: 0, z: 5 } });
  await sleep(150);
  const a2 = M.client(r); await a2.hello('mover');
  await a2.wait((m) => m.t === 'welcome');
  const c = M.client(r); await c.hello('observer');
  const welcome = await c.wait((m) => m.t === 'welcome');
  assert.equal(welcome.peerStates[0].state.x, 5, 'the pre-reconnect state carried over');
});

test('F15: an oversized frame is rejected, never amplified', async () => {
  const { M } = await boot();
  const r = roomId('f15big');
  const a = M.client(r); await a.hello('flooder');
  const b = M.client(r); await b.hello('target');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { blob: 'x'.repeat(1024 * 1024) } });
  await a.waitClose(4000);
  assert.equal(a.closed !== null, true, 'the sender is closed');
  await sleep(200);
  assert.equal(b.msgs.some((m) => m.t === 'state'), false, 'the blob was never relayed');
  assert.equal(b.msgs.some((m) => m.t === 'peer' && m.event === 'leave'), true);
});

test('F15: a frame over 64 KiB but under the runtime limit closes the sender too', async () => {
  const { M } = await boot();
  const r = roomId('f15mid');
  const a = M.client(r); await a.hello('fat');
  const b = M.client(r); await b.hello('thin');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { blob: 'x'.repeat(100 * 1024) } });
  assert.equal(await a.waitClose(), 1009, 'Frame too large: 1009, like ws maxPayload');
  assert.equal(b.msgs.some((m) => m.t === 'state'), false);
});

test('F15: an over-limit state frame under maxPayload is dropped, not stored', async () => {
  const { M } = await boot();
  const r = roomId('f15st');
  const a = M.client(r); await a.hello('chatty');
  const b = M.client(r); await b.hello('quiet');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { blob: 'x'.repeat(8 * 1024) } });
  await sleep(300);
  assert.equal(b.msgs.some((m) => m.t === 'state'), false, 'oversized state never relayed');
  assert.equal(a.closed, null, 'but the socket survives: a drop, not a kill');
});

test('F15: a burst is absorbed, sustained flooding closes the socket', async () => {
  const { M } = await boot();
  const r = roomId('f15fl');
  const a = M.client(r); await a.hello('spammer');
  const b = M.client(r); await b.hello('bystander');
  await b.wait((m) => m.t === 'welcome');
  for (let i = 0; i < 40; i++) a.send({ t: 'event', ev: { k: 'boom', i } });
  await sleep(600);
  assert.equal(a.closed, null, 'a burst must never disconnect a real player');
  assert.equal(b.msgs.filter((m) => m.t === 'event').length, 40, 'and all of it is relayed');
  for (let sec = 0; sec < 6 && a.closed === null; sec++) {
    for (let i = 0; i < 400; i++) a.send({ t: 'state', state: { x: i } });
    await sleep(1000);
  }
  assert.equal(a.closed !== null, true, 'the flooding socket is closed');
  assert.equal(a.msgs.some((m) => m.t === 'error' && /many/i.test(m.msg)), true);
  assert.equal(b.closed, null, 'the bystander plays on');
});

test('F15: a socket that never says hello is reaped (by the alarm)', async () => {
  const { M } = await boot();
  const r = roomId('f15hi');
  const idle = M.client(r);
  await idle.ready;
  assert.equal((await M.health(r)).sockets, 1);
  const code = await idle.waitClose(6000);
  assert.equal(code, 4008, 'silent socket closed with 4008');
  await sleep(200);
  assert.equal((await M.health(r)).sockets, 0);
});

test('F15: talking before hello is fatal', async () => {
  const { M } = await boot();
  const r = roomId('f15pre');
  const a = M.client(r);
  await a.ready;
  a.send({ t: 'state', state: { x: 1 } });
  const err = await a.wait((m) => m.t === 'error');
  assert.equal(err.fatal, true);
  assert.equal(await a.waitClose() !== null, true);
});

test('F15: binary frames are refused', async () => {
  const { M } = await boot();
  const r = roomId('f15bin');
  const a = M.client(r); await a.ready;
  a.ws.send(Buffer.from([1, 2, 3]));
  const err = await a.wait((m) => m.t === 'error');
  assert.match(err.msg, /Binary/);
  assert.equal(await a.waitClose(), 4000);
});

test('F15: meta is authority-only and server-owned keys are immutable', async () => {
  const { M } = await boot();
  const r = roomId('f15me');
  const a = M.client(r); await a.hello('boss');
  await a.wait((m) => m.t === 'welcome');
  const b = M.client(r); await b.hello('nobody');
  await b.wait((m) => m.t === 'welcome');
  b.send({ t: 'meta', patch: { host: 'nobody', state: 'hacked' } });
  await sleep(200);
  assert.equal(b.msgs.some((m) => m.t === 'meta'), false, 'a guest patch changes nothing');
  a.send({ t: 'meta', patch: { host: 'nobody', created: 0, state: 'paused' } });
  const meta = await b.wait((m) => m.t === 'meta');
  assert.equal(meta.meta.state, 'paused');
  assert.equal(meta.meta.host, 'server');
  assert.notEqual(meta.meta.created, 0);
});

test('F15: snapshots are authority-only, and the ARRAY the client sends is relayed', async () => {
  const { M } = await boot();
  const r = roomId('f15sn');
  const a = M.client(r); await a.hello('boss');
  await a.wait((m) => m.t === 'welcome');
  const b = M.client(r); await b.hello('guest');
  await b.wait((m) => m.t === 'welcome');
  b.send({ t: 'snap', snap: [{ fake: true }] });
  await sleep(200);
  assert.equal(a.msgs.some((m) => m.t === 'snap'), false, 'a guest cannot dictate the world');
  a.send({ t: 'snap', snap: [{ x: 1, y: 2, z: 3, r: 9, id: 'boss:1' }] });
  const relayed = await b.wait((m) => m.t === 'snap');
  assert.equal(Array.isArray(relayed.snap), true);
  assert.equal(relayed.snap[0].id, 'boss:1');
  a.send({ t: 'snap', snap: 'boom' });
  await sleep(200);
  assert.equal(b.msgs.filter((m) => m.t === 'snap').length, 1, 'a scalar snapshot is ignored');
});

test('F15: uids are sanitized, the real base:tab uid survives unchanged', async () => {
  const { M } = await boot();
  const r = roomId('f15uid');
  const a = M.client(r); await a.hello('<script>x</script>');
  assert.equal((await a.wait((m) => m.t === 'welcome')).uid, 'scriptxscript');
  const b = M.client(r); await b.hello('!!!');
  assert.match((await b.wait((m) => m.t === 'error')).msg, /uid/i);
  const c = M.client(r); await c.hello(REAL_UID);
  assert.equal((await c.wait((m) => m.t === 'welcome')).uid, REAL_UID);
  const d = M.client(r); await d.hello('uZZZZZZZZ:aa11');
  await d.wait((m) => m.t === 'welcome');
  c.send({ t: 'event', ev: { k: 'boom' } });
  const ev = await d.wait((m) => m.t === 'event');
  assert.equal(ev.ev.from, REAL_UID, 'the stamped `from` keeps its colon');
});

test('a reconnecting AUTHORITY gets the world snapshot back', async () => {
  const { M } = await boot();
  const r = roomId('auth');
  const a = M.client(r); await a.hello('boss');
  await a.wait((m) => m.t === 'welcome');
  const b = M.client(r); await b.hello('guest');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'snap', snap: [{ x: 1, y: 2, z: 3, r: 9, id: 'boss:1' }] });
  await b.wait((m) => m.t === 'snap');
  const a2 = M.client(r); await a2.hello('boss');
  await a2.wait((m) => m.t === 'welcome');
  const snap = await a2.wait((m) => m.t === 'snap');
  assert.equal(snap.snap[0].id, 'boss:1');
});

test('the first player back into the persistent room inherits the wreckage', async () => {
  const { M } = await boot();
  const r = roomId('back');
  const a = M.client(r); await a.hello('first');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'snap', snap: [{ x: 4, y: 0, z: 4, r: 9, id: 'first:1' }] });
  await sleep(150);
  a.ws.close();
  await sleep(300);
  assert.equal((await M.health(r)).players, 0);
  const c = M.client(r); await c.hello('later');
  await c.wait((m) => m.t === 'welcome');
  const snap = await c.wait((m) => m.t === 'snap');
  assert.equal(snap.snap[0].id, 'first:1');
});

test('over-budget seconds separated by silence do not add up to a kill', async () => {
  const { M } = await boot();
  const r = roomId('bursty');
  const a = M.client(r); await a.hello('bursty');
  await a.wait((m) => m.t === 'welcome');
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 200; i++) a.send({ t: 'state', state: { x: i } });
    await sleep(2500);
  }
  assert.equal(a.closed, null, 'a socket that goes quiet in between is not an attacker');
});

test('PING gets a PONG with the server clock and the echoed stamp', async () => {
  const { M } = await boot();
  const r = roomId('ping');
  const a = M.client(r); await a.hello('clock');
  const w = await a.wait((m) => m.t === 'welcome');
  assert.equal(Number.isFinite(w.now), true, 'WELCOME carries the server clock');
  assert.equal(Math.abs(w.now - Date.now()) < 5000, true);
  a.send({ t: 'ping', ts: 12345 });
  const p = await a.wait((m) => m.t === 'pong');
  assert.equal(p.ts, 12345);
  assert.equal(Number.isFinite(p.now), true);
});

test('health reports what an operator needs, with CORS for the game page', async () => {
  const { M } = await boot();
  const r = roomId('health');
  const res = await M.rawHealth(r);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const h = await res.json();
  assert.equal(h.ready, true);
  assert.equal(h.players, 0);
  assert.equal(h.sockets, 0);
  assert.equal(h.capacity, 20);
  assert.equal(h.account, null, 'no secret, no account guard');
  assert.equal(typeof h.budget.gbs, 'number');
});
