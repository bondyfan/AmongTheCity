// ==========================================================================
// among-the-city-coop: the Worker in front of the co-op Durable Object.
//
//   GET /health   what the main menu polls (CORS *). Answered from a copy
//                 kept in this isolate for HEALTH_TTL_MS, so a menu left open
//                 does not wake the Durable Object on every poll (the Cache
//                 API does nothing on workers.dev, an isolate variable does).
//   GET /ws       the WebSocket, handed to the ONE room: idFromName('PARDUBICE')
//                 with a European location hint.
//
// Cheap refusals happen HERE, before the Durable Object is billed for them:
// too many handshakes from one address (UPGRADES_PER_MIN), and, once the
// object has said the month's budget is used up, every new socket.
// ==========================================================================

import { CoopRoom } from './coop.js';

export { CoopRoom };

const MAIN_ROOM = 'PARDUBICE';
const LIMIT_MEMORY_MS = 5 * 60 * 1000;   // how long this isolate trusts a 'limit' it heard

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

// isolate memory: per room name (one in production, many under TEST_ROOMS)
const healthCache = new Map();   // name -> { body, until, inflight }
const limitUntil = new Map();    // name -> ms
const upgrades = new Map();      // ip -> { at, n }

function roomName(env, url) {
  if (env.TEST_ROOMS !== '1') return MAIN_ROOM;
  const r = String(url.searchParams.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return r || MAIN_ROOM;
}

function room(env, name) {
  return env.COOP.get(env.COOP.idFromName(name), { locationHint: 'weur' });
}

function reply(body, status = 200) {
  return new Response(body, {
    status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

async function health(env, name) {
  const now = Date.now();
  const ttl = num(env.HEALTH_TTL_MS, 30000);
  let e = healthCache.get(name);
  if (e && e.body && now < e.until) return e.body;
  if (e && e.inflight) return e.inflight;
  if (!e) { e = { body: null, until: 0, inflight: null }; healthCache.set(name, e); }
  e.inflight = (async () => {
    let body, until;
    try {
      const res = await room(env, name).fetch('https://coop/health');
      body = await res.text();
      const j = JSON.parse(body);
      until = now + ttl;
      if (j && j.ready === false && j.reason === 'limit') {
        const reset = Date.parse(j.resetsAt) || 0;
        const keep = Math.min(reset || now + 60000, now + LIMIT_MEMORY_MS);
        limitUntil.set(name, keep);
        until = Math.max(until, keep);   // nothing will change before then anyway
      } else {
        limitUntil.delete(name);
      }
    } catch {
      body = JSON.stringify({ status: 'error', ready: false, reason: 'unreachable' });
      until = now + Math.min(ttl, 5000);
    }
    e.body = body;
    e.until = until;
    return body;
  })().finally(() => { e.inflight = null; });
  return e.inflight;
}

// handshakes per address per minute, counted in this isolate
const UPGRADE_KEYS = 5000;
function allowUpgrade(env, ip) {
  const per = num(env.UPGRADES_PER_MIN, 30);
  const now = Date.now();
  let e = upgrades.get(ip);
  if (!e || now - e.at >= 60000) {
    upgrades.delete(ip);
    // Full: drop the OLDEST windows (a Map iterates in insertion order), never
    // the whole map, so a flood from many addresses cannot reset everyone's
    // counter, only push out windows that are about to expire anyway.
    for (const k of upgrades.keys()) { if (upgrades.size < UPGRADE_KEYS) break; upgrades.delete(k); }
    e = { at: now, n: 0 };
    upgrades.set(ip, e);
  }
  e.n++;
  return e.n <= per;
}

// The month is over: say so on a socket this Worker accepts itself, so the
// client shows the reason and the Durable Object is not billed for it.
function refuseLimit() {
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  try {
    server.send(JSON.stringify({ t: 'error', msg: 'The co-op budget for this month is used up.', fatal: true, code: 'limit' }));
    server.close(4402, 'limit');
  } catch {}
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const name = roomName(env, url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    if (url.pathname === '/health' || url.pathname === '/') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply('{"error":"method"}', 405);
      return reply(await health(env, name));
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
      const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 64);
      if (!allowUpgrade(env, ip)) {
        return new Response('Too many connection attempts.', { status: 429, headers: { 'Retry-After': '60' } });
      }
      if ((limitUntil.get(name) || 0) > Date.now()) return refuseLimit();
      // The address the per-IP caps use comes from Cloudflare, never from the
      // client: x-coop-ip is overwritten here whatever the request carried.
      const headers = new Headers(request.headers);
      headers.set('x-coop-ip', ip);
      const res = await room(env, name).fetch(new Request('https://coop/ws', { headers }));
      if (res.headers.get('x-coop-state') === 'limit') {
        const reset = Number(res.headers.get('x-coop-reset')) || 0;
        limitUntil.set(name, Math.min(reset || Date.now() + 60000, Date.now() + LIMIT_MEMORY_MS));
        healthCache.delete(name);
      }
      return res;
    }

    if (url.pathname === '/__test/forget' && env.TEST_ROOMS === '1' && request.method === 'POST') {
      healthCache.delete(name);
      const res = await room(env, name).fetch('https://coop/__test/forget');
      return reply(await res.text(), res.status);
    }

    return new Response('Among The City co-op server', { status: 404 });
  },
};
