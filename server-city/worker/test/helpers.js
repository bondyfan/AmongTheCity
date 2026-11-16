// Shared plumbing for the Worker tests: spawn `wrangler dev --local` with a
// set of test vars, wait for /health, and talk to it over real WebSockets.
// Every wrangler this file starts is killed in after(), process group and all.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const WORKER_DIR = fileURLToPath(new URL('..', import.meta.url));
// server-city/node_modules (a local install, or the symlink the README
// describes) carries wrangler; WRANGLER overrides it.
const WRANGLER = process.env.WRANGLER
  || fileURLToPath(new URL('../../node_modules/.bin/wrangler', import.meta.url));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

const spawned = new Set();
const rawSockets = new Set();
const tempDirs = new Set();
const servers = new Set();

function killTree(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(t); resolve(); });
  });
}

// Module level on purpose: an after() registered inside a test runs when
// THAT test ends, which once closed the analytics stub under the next one.
after(async () => {
  for (const s of rawSockets) { try { s.destroy(); } catch {} }
  await Promise.all([...servers].map((s) => { try { s.closeAllConnections(); } catch {} return new Promise((r) => s.close(r)); }));
  await Promise.all([...spawned].map(killTree));
  for (const d of tempDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

// Start one wrangler dev. `persist` reuses a storage directory (restart tests).
export async function startWorker(vars = {}, { persist = null } = {}) {
  const port = await freePort();
  const inspector = await freePort();
  const dir = persist || mkdtempSync(join(tmpdir(), 'atc-coop-'));
  tempDirs.add(dir);
  const args = ['dev', '--local', '--port', String(port), '--ip', '127.0.0.1',
    '--inspector-port', String(inspector), '--persist-to', dir,
    '--show-interactive-dev-session=false', '--log-level', 'warn'];
  for (const [k, v] of Object.entries({ TEST_ROOMS: '1', ...vars })) args.push('--var', `${k}:${v}`);
  const child = spawn(WRANGLER, args, {
    cwd: WORKER_DIR,
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_UPDATE_NOTIFIER: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  spawned.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 300 && !up; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`${base}/health`); up = r.ok; } catch {}
    if (!up) await sleep(100);
  }
  if (!up) throw new Error(`wrangler dev did not come up:\n${log.slice(-2000)}`);
  const w = {
    port, base, dir, child, log: () => log,
    async health(room) { return (await fetch(`${base}/health?room=${room}`)).json(); },
    async rawHealth(room) { return fetch(`${base}/health?room=${room}`); },
    async forget(room) { return (await fetch(`${base}/__test/forget?room=${room}`, { method: 'POST' })).json(); },
    client: (room, opts) => client(`ws://127.0.0.1:${port}/ws?room=${room}`, opts),
    async stop() { spawned.delete(child); await killTree(child); },
  };
  return w;
}

// A test client: collects every inbound frame plus the close code.
export function client(url, { headers } = {}) {
  const ws = new WebSocket(url, { headers });
  const c = { ws, msgs: [], _closed: null, reason: '', open: false, error: null };
  // `closed` is the code of the server's close FRAME. The 'close' event alone
  // is not enough here: wrangler dev's local proxy is slow to end the TCP
  // connection of a socket that never sent a frame itself, so ws would only
  // report it after its 30 s close timeout. The frame (and its code) arrives
  // at once, which is what a real client acts on.
  Object.defineProperty(c, 'closed', {
    get() { return c._closed ?? (ws._closeFrameReceived ? ws._closeCode : null); },
  });
  ws.on('error', (e) => { c.error = String(e && e.message || e); });
  ws.on('message', (d) => { try { c.msgs.push(JSON.parse(d.toString())); } catch {} });
  ws.on('close', (code, reason) => { c._closed = code; c.reason = String(reason || ''); });
  c.ready = new Promise((res, rej) => {
    ws.on('open', () => { c.open = true; res(c); });
    ws.on('close', () => rej(new Error('closed before open')));
  }).catch(() => c);
  c.send = (o) => { try { ws.send(typeof o === 'string' ? o : JSON.stringify(o)); } catch {} };
  c.hello = async (uid) => { await c.ready; c.send({ t: 'hello', uid, want: 'join' }); return c; };
  c.wait = async (pred, ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const hit = c.msgs.find(pred);
      if (hit) return hit;
      await sleep(10);
    }
    throw new Error(`timeout waiting for message; got ${JSON.stringify(c.msgs).slice(0, 400)}`);
  };
  c.waitClose = async (ms = 4000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (c.closed !== null) return c.closed; await sleep(10); }
    return null;
  };
  return c;
}

// A raw WebSocket client over TCP that NEVER answers the server's close
// frame (a hostile or broken peer): the server cannot end it, only wait.
// Resolves once the handshake is through; rejects with the HTTP status line
// when the upgrade is refused.
export function rawClient(port, path) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    rawSockets.add(s);
    const key = crypto.randomBytes(16).toString('base64');
    const c = { s, closeCodes: [], up: false, ended: false };
    let buf = Buffer.alloc(0);
    s.on('connect', () => s.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\n`
      + `Connection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!c.up) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const status = buf.slice(0, i).toString().split('\r\n')[0];
        buf = buf.slice(i + 4);
        if (!/ 101 /.test(status)) { s.destroy(); reject(new Error(status)); return; }
        c.up = true; resolve(c);
      }
      while (buf.length >= 2) {
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) return;
        const p = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (op === 8) c.closeCodes.push(p.length >= 2 ? p.readUInt16BE(0) : 0);
      }
    });
    s.on('close', () => { c.ended = true; });
    s.on('error', (e) => { if (!c.up) reject(e); });
    c.send = (str) => {
      if (c.ended) return;
      const p = Buffer.from(str), m = crypto.randomBytes(4);
      const h = Buffer.from([0x81, 0x80 | p.length]);   // short text frames only
      const mp = Buffer.alloc(p.length);
      for (let i = 0; i < p.length; i++) mp[i] = p[i] ^ m[i & 3];
      try { s.write(Buffer.concat([h, m, mp])); } catch {}
    };
  });
}

// A stand-in for the GraphQL Analytics API: answers with whatever `usage`
// says, remembers every request it got. mode: 'low' | 'high' | 'fail' (HTTP
// 500) | 'gqlerror' (a GraphQL error, as for a wrong field) | 'hang' (never
// answers).
export async function analyticsStub() {
  const stub = { mode: 'low', usage: { activeUs: 1e6, inbound: 20, requests: 1 }, calls: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      stub.calls.push({ auth: req.headers.authorization, body: parsed });
      if (stub.mode === 'fail') { res.writeHead(500); res.end('nope'); return; }
      if (stub.mode === 'hang') return;
      if (stub.mode === 'gqlerror') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: null, errors: [{ message: 'unknown field "activeTime"' }] }));
        return;
      }
      const u = stub.mode === 'high'
        ? { activeUs: 1e13, inbound: 0, requests: 10 }   // 1.25 million GB-s
        : stub.usage;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { viewer: { accounts: [{
        periodic: [{ sum: { activeTime: u.activeUs, inboundWebsocketMsgCount: u.inbound } }],
        invocations: [{ sum: { requests: u.requests } }],
      }] } }, errors: null }));
    });
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  servers.add(server);
  stub.url = `http://127.0.0.1:${port}/graphql`;
  return stub;
}

// The instances most tests share, started together (wrangler takes seconds).
let booted = null;
export function boot() {
  booted ??= (async () => {
    const stub = await analyticsStub();
    const stub2 = await analyticsStub();
    const quick = { HEALTH_TTL_MS: '0', UPGRADES_PER_MIN: '100000' };
    const [M, C, B, S, Z, G] = await Promise.all([
      // the relay scenarios: defaults, but a hello timeout a test can wait out
      startWorker({ ...quick, HELLO_TIMEOUT_MS: '1500' }),
      // the per-IP caps and the handshake limiter
      startWorker({ HEALTH_TTL_MS: '0', MAX_PLAYERS_PER_IP: '2', MAX_SOCKETS_PER_IP: '3', UPGRADES_PER_MIN: '14' }),
      // the budget guard: a tiny own cap and an account guard on the stub
      startWorker({ ...quick, BUDGET_REQUESTS: '10', CF_ANALYTICS_TOKEN: 'test-token',
        GRAPHQL_URL: stub.url, ACCOUNT_GBS_LIMIT: '1000', ACCOUNT_REQUESTS_LIMIT: '100000' }),
      // reaping and the isolate's /health cache
      startWorker({ UPGRADES_PER_MIN: '100000', HEALTH_TTL_MS: '1500', SILENCE_MS: '1500', IDLE_MS: '3000' }),
      // peers that never answer a close: short hello and dead-grace times
      startWorker({ ...quick, MAX_SOCKETS_PER_IP: '2', HELLO_TIMEOUT_MS: '500', DEAD_GRACE_MS: '500' }),
      // the account guard failing: a short fetch timeout and retry
      startWorker({ ...quick, CF_ANALYTICS_TOKEN: 'test-token', GRAPHQL_URL: stub2.url,
        ACCOUNT_TIMEOUT_MS: '800', ACCOUNT_RETRY_MS: '1000' }),
    ]);
    return { M, C, B, S, Z, G, stub, stub2 };
  })();
  return booted;
}

let roomSeq = 0;
export const roomId = (tag) => `${tag}${++roomSeq}`.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
