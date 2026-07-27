// ==========================================================================
// server-city tests — `npm test` inside server-city/ (seconds, not minutes).
//
// Everything here drives a REAL server process over a REAL websocket on a
// free port: the bug this suite exists for (F1, reconnect with the same uid
// deleting the reconnected player) only reproduces through the async close of
// the socket that was replaced, which an in-process unit test would miss.
// ==========================================================================

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const SERVER = fileURLToPath(new URL('./index.js', import.meta.url));
const spawned = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// start a server process and wait until /health answers
async function startServer(env = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  spawned.push(child);
  child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/health`); if (r.ok) break; } catch {}
    await sleep(50);
  }
  return { port, base, child, health: async () => (await fetch(`${base}/health`)).json() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A test client: collects every inbound frame plus the close code.
function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const c = { ws, msgs: [], closed: null, open: false };
  ws.on('error', () => {});
  ws.on('message', (d) => { try { c.msgs.push(JSON.parse(d.toString())); } catch {} });
  ws.on('close', (code) => { c.closed = code; });
  c.ready = new Promise((res, rej) => { ws.on('open', () => { c.open = true; res(c); }); ws.on('close', () => rej(new Error('closed before open'))); })
    .catch(() => c);
  c.send = (o) => { try { ws.send(JSON.stringify(o)); } catch {} };
  c.hello = async (uid) => { await c.ready; c.send({ t: 'hello', uid, want: 'join' }); return c; };
  c.wait = async (pred, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = c.msgs.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error(`timeout waiting for message; got ${JSON.stringify(c.msgs).slice(0, 400)}`);
  };
  return c;
}

after(() => { for (const ch of spawned) { try { ch.kill('SIGKILL'); } catch {} } });

// ---------------------------------------------------------------- F1 ------
test('F1: reconnecting with the same uid keeps exactly one seat, not zero', async () => {
  const s = await startServer();

  const bystander = client(s.port); await bystander.hello('watcher');
  await bystander.wait((m) => m.t === 'welcome');

  const first = client(s.port); await first.hello('samewho');
  await first.wait((m) => m.t === 'welcome');
  await first.wait((m) => m.t === 'state' === false || true); // settle
  assert.equal((await s.health()).players, 2, 'two players before the reconnect');

  // the same uid comes back (second tab / Wi-Fi blip) — the old socket is kicked
  const second = client(s.port); await second.hello('samewho');
  const welcome = await second.wait((m) => m.t === 'welcome');
  assert.deepEqual(welcome.peers, ['watcher']);
  assert.equal(await waitClose(first), 4001, 'the stale socket is closed with 4001');

  // THE REGRESSION: the stale close used to remove the freshly seated player.
  await sleep(300);
  const health = await s.health();
  assert.equal(health.players, 2, 'the reconnected player still holds a seat');

  // and the seat actually works in both directions
  second.send({ t: 'state', state: { x: 1, y: 0, z: 2 } });
  const relayed = await bystander.wait((m) => m.t === 'state' && m.from === 'samewho');
  assert.equal(relayed.state.x, 1);
  bystander.send({ t: 'state', state: { x: 9, y: 0, z: 9 } });
  const back = await second.wait((m) => m.t === 'state' && m.from === 'watcher');
  assert.equal(back.state.x, 9);
});

function waitClose(c, ms = 2000) {
  return (async () => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (c.closed !== null) return c.closed; await sleep(10); }
    return null;
  })();
}

test('F1b: a dropped socket DOES free its seat when nobody replaced it', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('leaver');
  await a.wait((m) => m.t === 'welcome');
  assert.equal((await s.health()).players, 1);
  a.ws.close();
  await sleep(200);
  assert.equal((await s.health()).players, 0, 'a plain disconnect still leaves');
});

// --------------------------------------------------------------- F13 ------
test('F13: ev.from cannot be spoofed', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('honest');
  const b = client(s.port); await b.hello('victim');
  await b.wait((m) => m.t === 'welcome');

  a.send({ t: 'event', ev: { k: 'boom', from: 'victim', x: 1 } });
  const ev = await b.wait((m) => m.t === 'event');
  assert.equal(ev.ev.from, 'honest', 'the server stamps `from`, the client cannot');
  assert.equal(ev.ev.k, 'boom');
});

// --------------------------------------------------------------- F23 ------
test('F23: a joiner learns every peer\'s last state immediately', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('early');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { x: 42, y: 0, z: 7, nm: 'Ranger' } });
  await sleep(100);

  const c = client(s.port); await c.hello('late');
  const welcome = await c.wait((m) => m.t === 'welcome');
  assert.deepEqual(welcome.peers, ['early'], 'peers stays a plain uid array (old clients)');
  assert.equal(welcome.peerStates.length, 1);
  assert.equal(welcome.peerStates[0].uid, 'early');
  assert.equal(welcome.peerStates[0].state.x, 42);
  // …and the shipped client, which reads only STATE frames, gets them too
  const st = await c.wait((m) => m.t === 'state' && m.from === 'early');
  assert.equal(st.state.nm, 'Ranger');
});

test('F23b: reconnecting keeps the avatar — lastState survives the new socket', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('mover');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { x: 5, y: 0, z: 5 } });
  await sleep(100);
  const a2 = client(s.port); await a2.hello('mover');
  await a2.wait((m) => m.t === 'welcome');

  const c = client(s.port); await c.hello('observer');
  const welcome = await c.wait((m) => m.t === 'welcome');
  assert.equal(welcome.peerStates[0].state.x, 5, 'the pre-reconnect state carried over');
});

// --------------------------------------------------------------- F15 ------
test('F15: an oversized frame is rejected, never amplified', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('flooder');
  const b = client(s.port); await b.hello('target');
  await b.wait((m) => m.t === 'welcome');

  a.send({ t: 'state', state: { blob: 'x'.repeat(1024 * 1024) } });  // 1 MiB
  await sleep(300);
  assert.equal(a.closed !== null, true, 'the sender is closed by maxPayload (1009)');
  // the room only hears that the flooder left — the megabyte itself went nowhere
  assert.equal(b.msgs.some((m) => m.t === 'state'), false, 'the blob was never relayed');
  assert.equal(b.msgs.some((m) => m.t === 'peer' && m.event === 'leave'), true);
});

test('F15: an over-limit state frame under maxPayload is dropped, not stored', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('chatty');
  const b = client(s.port); await b.hello('quiet');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'state', state: { blob: 'x'.repeat(8 * 1024) } });     // 8 KiB > LIMITS.state
  await sleep(200);
  assert.equal(b.msgs.some((m) => m.t === 'state'), false, 'oversized state never relayed');
  assert.equal(a.closed, null, 'but the socket survives — it is a drop, not a kill');
});

test('F15: a burst is absorbed, sustained flooding closes the socket', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('spammer');
  const b = client(s.port); await b.hello('bystander');
  await b.wait((m) => m.t === 'welcome');

  // a legitimate spike: one frame draining a full event outbox (netcity caps 33)
  for (let i = 0; i < 40; i++) a.send({ t: 'event', ev: { k: 'boom', i } });
  await sleep(400);
  assert.equal(a.closed, null, 'a burst must never disconnect a real player');
  assert.equal(b.msgs.filter((m) => m.t === 'event').length, 40, 'and all of it is relayed');

  // sustained abuse: hundreds a second, second after second
  for (let sec = 0; sec < 5 && a.closed === null; sec++) {
    for (let i = 0; i < 400; i++) a.send({ t: 'state', state: { x: i } });
    await sleep(1000);
  }
  assert.equal(a.closed !== null, true, 'the flooding socket is closed');
  assert.equal(a.msgs.some((m) => m.t === 'error' && /many/i.test(m.msg)), true);
  assert.equal(b.closed, null, 'the bystander plays on');
});

test('F15: a socket that never says hello is reaped', async () => {
  const s = await startServer({ HELLO_TIMEOUT_MS: '300' });
  const idle = client(s.port);
  await idle.ready;
  assert.equal((await s.health()).sockets, 1);
  const code = await waitClose(idle, 3000);
  assert.equal(code !== null, true, 'silent socket closed');
  await sleep(100);
  assert.equal((await s.health()).sockets, 0);
});

test('F15: talking before hello is fatal', async () => {
  const s = await startServer();
  const a = client(s.port);
  await a.ready;
  a.send({ t: 'state', state: { x: 1 } });
  const err = await a.wait((m) => m.t === 'error');
  assert.equal(err.fatal, true);
  assert.equal(await waitClose(a) !== null, true);
});

test('F15: meta is authority-only and server-owned keys are immutable', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('boss');      // first in = authority
  const b = client(s.port); await b.hello('nobody');
  await b.wait((m) => m.t === 'welcome');

  b.send({ t: 'meta', patch: { host: 'nobody', state: 'hacked' } });
  await sleep(150);
  assert.equal(b.msgs.some((m) => m.t === 'meta'), false, 'a guest patch changes nothing');

  a.send({ t: 'meta', patch: { host: 'nobody', created: 0, state: 'paused' } });
  const meta = await b.wait((m) => m.t === 'meta');
  assert.equal(meta.meta.state, 'paused', 'whitelisted key applied');
  assert.equal(meta.meta.host, 'server', 'host stays server-owned');
  assert.notEqual(meta.meta.created, 0);
});

test('F15: snapshots are authority-only', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('boss');
  const b = client(s.port); await b.hello('guest');
  await b.wait((m) => m.t === 'welcome');
  b.send({ t: 'snap', snap: [{ fake: true }] });
  await sleep(150);
  assert.equal(a.msgs.some((m) => m.t === 'snap'), false, 'a guest cannot dictate the world');
});

test('the snapshot lane accepts the ARRAY the client actually sends', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('boss');
  await a.wait((m) => m.t === 'welcome');
  const b = client(s.port); await b.hello('guest');
  await b.wait((m) => m.t === 'welcome');
  // world.hitLog is an array and applyHits() refuses anything else; a
  // plain-object-only guard dropped every snapshot silently.
  a.send({ t: 'snap', snap: [{ x: 1, y: 2, z: 3, r: 9, id: 'boss:1' }] });
  const relayed = await b.wait((m) => m.t === 'snap');
  assert.equal(Array.isArray(relayed.snap), true, 'relayed verbatim, still an array');
  assert.equal(relayed.snap[0].id, 'boss:1');
  // scalars are still refused
  a.send({ t: 'snap', snap: 'boom' });
  await sleep(150);
  assert.equal(b.msgs.filter((m) => m.t === 'snap').length, 1, 'a scalar snapshot is ignored');
});

test('F15: one IP cannot take every seat', async () => {
  const s = await startServer({ MAX_PLAYERS_PER_IP: '2', MAX_SOCKETS_PER_IP: '10' });
  const a = client(s.port); await a.hello('ip1');
  const b = client(s.port); await b.hello('ip2');
  await b.wait((m) => m.t === 'welcome');
  const c = client(s.port); await c.hello('ip3');
  const err = await c.wait((m) => m.t === 'error');
  assert.match(err.msg, /Too many players/);
  assert.equal((await s.health()).players, 2, 'the room still has its free seats');
});

test('F15: one IP cannot hold unlimited sockets', async () => {
  const s = await startServer({ MAX_SOCKETS_PER_IP: '3' });
  const cs = [client(s.port), client(s.port), client(s.port), client(s.port)];
  await sleep(300);
  const closed = cs.filter((c) => c.closed !== null).length;
  assert.equal(closed >= 1, true, 'the socket over the cap is refused');
});

test('F15: uids are sanitized', async () => {
  const s = await startServer();
  const a = client(s.port);
  await a.hello('<script>x</script>');
  const w = await a.wait((m) => m.t === 'welcome');
  assert.equal(w.uid, 'scriptxscript');
  const b = client(s.port);
  await b.hello('!!!');
  const err = await b.wait((m) => m.t === 'error');
  assert.match(err.msg, /uid/i);
});

// The uid the SHIPPED client actually sends (js/identity.js localUid()).
const REAL_UID = 'u4f2a1b3c:9k2p';

test('the real client uid (base:tab) survives the server unchanged', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello(REAL_UID);
  const w = await a.wait((m) => m.t === 'welcome');
  // Stripping ':' broke TWO things at once: netcity compares the PEER
  // 'authority' uid against its own localUid() (so nobody was ever the host,
  // and the late-joiner snapshot never got sent), and identity.baseUid()
  // splits on ':' (so every player looked one colour to themselves and another
  // to everyone else).
  assert.equal(w.uid, REAL_UID, 'the colon is part of the uid, not punctuation');
  const auth = await a.wait((m) => m.t === 'peer' && m.event === 'authority');
  assert.equal(auth.uid, REAL_UID, 'the authority announcement matches localUid()');

  // …and it still cannot smuggle markup or a control character
  const b = client(s.port); await b.hello('<b>x</b>:tab ');
  const wb = await b.wait((m) => m.t === 'welcome');
  assert.equal(wb.uid, 'bxb:tab');
});

test('a relayed uid keeps its colon end to end', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello(REAL_UID);
  await a.wait((m) => m.t === 'welcome');
  const b = client(s.port); await b.hello('uZZZZZZZZ:aa11');
  const w = await b.wait((m) => m.t === 'welcome');
  assert.deepEqual(w.peers, [REAL_UID]);
  a.send({ t: 'event', ev: { k: 'boom' } });
  const ev = await b.wait((m) => m.t === 'event');
  assert.equal(ev.ev.from, REAL_UID, 'the stamped `from` is the uid the client knows itself by');
});

test('a reconnecting AUTHORITY gets the world snapshot back', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('boss');
  await a.wait((m) => m.t === 'welcome');
  const b = client(s.port); await b.hello('guest');
  await b.wait((m) => m.t === 'welcome');
  a.send({ t: 'snap', snap: [{ x: 1, y: 2, z: 3, r: 9, id: 'boss:1' }] });
  await b.wait((m) => m.t === 'snap');

  // the authority reloads the page — its world comes back EMPTY
  const a2 = client(s.port); await a2.hello('boss');
  await a2.wait((m) => m.t === 'welcome');
  const snap = await a2.wait((m) => m.t === 'snap');
  assert.equal(snap.snap[0].id, 'boss:1', 'the reconnected authority inherits the wreckage too');
});

test('the first player back into the persistent room inherits the wreckage', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('first');
  await a.wait((m) => m.t === 'welcome');
  a.send({ t: 'snap', snap: [{ x: 4, y: 0, z: 4, r: 9, id: 'first:1' }] });
  await sleep(120);
  a.ws.close();                       // everyone leaves; MAIN room persists 24/7
  await sleep(200);
  assert.equal((await s.health()).players, 0);

  const c = client(s.port); await c.hello('later');
  await c.wait((m) => m.t === 'welcome');
  const snap = await c.wait((m) => m.t === 'snap');
  assert.equal(snap.snap[0].id, 'first:1', 'a persistent room keeps a persistent city');
});

test('over-budget seconds separated by silence do not add up to a kill', async () => {
  const s = await startServer();
  const a = client(s.port); await a.hello('bursty');
  await a.wait((m) => m.t === 'welcome');
  // three over-budget seconds, each followed by a backgrounded-tab silence
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 200; i++) a.send({ t: 'state', state: { x: i } });
    await sleep(2500);
  }
  assert.equal(a.closed, null, 'a socket that goes quiet in between is not an attacker');
});

test('health reports what an operator needs', async () => {
  const s = await startServer();
  const h = await s.health();
  assert.equal(h.ready, true);
  assert.equal(h.players, 0);
  assert.equal(h.sockets, 0);
  assert.equal(h.capacity, 20);
});
