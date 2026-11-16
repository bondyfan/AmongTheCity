// ==========================================================================
// Among The City: co-op relay for LOCAL play (Node + ws).
//
//   GET /health   JSON liveness the main menu polls to enable the
//                 "Multiplayer (server)" button ONLY when it is up.
//   WebSocket /ws the game transport (see protocol.js).
//
// The live server is the Cloudflare Durable Object in worker/. Both run the
// same room and protocol logic (hub.js, room.js, protocol.js); this file is
// only the Node transport around it, so `npm test` here still covers every
// rule the live server enforces.
//
// This process is PUBLIC and unauthenticated: anyone who can reach /ws is a
// player. Everything a socket can do is therefore bounded: frame size, frame
// rate, byte rate, sockets per IP, seats per IP, and how long a socket may sit
// there without ever saying hello. See protocol.js LIMITS and hub.js.
//
// Run:   npm install && npm start           (listens on PORT, default 8081)
// ==========================================================================

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { LIMITS, PROTOCOL_VERSION } from './protocol.js';
import { CLOSE, Hub, hubOptions } from './hub.js';

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0'; // set 127.0.0.1 behind a reverse proxy
const HEARTBEAT_MS = 30000;
const STARTED_AT = Date.now();
// Behind a reverse proxy every socket looks like 127.0.0.1, which would make
// the per-IP caps either useless or fatal, so X-Forwarded-For wins by default.
// Set TRUST_PROXY=0 when the process is exposed directly: then the header is
// attacker-controlled and must be ignored.
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';

// The ws heartbeat below reaps dead sockets here, so the hub's own silence
// and idle deadlines stay off (they exist for the Durable Object).
const hub = new Hub({ ...hubOptions(process.env), silenceMs: 0, idleMs: 0 }, {
  // a refused or killed socket gets one second to take its ERROR frame
  onHardClose(ws) {
    ws.on('error', () => {});
    setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref();
  },
});
const rooms = new Map();   // kept for the old export shape: code -> Room

// ------------------------------------------------------------- http server ---
const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    const body = JSON.stringify({
      status: 'ok',
      ready: true,                          // the client button gates on this
      service: 'among-the-city',
      protocol: PROTOCOL_VERSION,
      uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
      rooms: hub.room ? 1 : 0,
      players: hub.players,
      sockets: hub.sockets,                 // > players = sockets still pre-hello
      capacity: hub.o.maxPlayers,
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',   // the static client is on another origin
      'cache-control': 'no-store',
    });
    res.end(body);
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

// -------------------------------------------------------- websocket server ---
// maxPayload is the single most important knob here: the ws default is 100 MiB
// and this server is an AMPLIFIER, one frame in, up to MAX_PLAYERS-1 frames
// out. 64 KiB in x 19 out is a shrug; 1 MiB x 19 was a free DoS.
const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: LIMITS.payload,
  perMessageDeflate: false,   // no compression bombs, no per-socket zlib heap
  clientTracking: true,
});

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length) {
      const first = xff.split(',')[0].trim();
      if (first) return first.slice(0, 64);
    }
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

wss.on('connection', (ws, req) => {
  ws.on('close', () => hub.closed(ws));
  ws.on('error', () => hub.closed(ws));
  if (!hub.open(ws, clientIp(req))) return;
  if (hub.room) rooms.set(hub.room.code, hub.room);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // A socket that connects and says nothing used to live forever (and held an
  // IP slot). Give it ten seconds to say hello like a player would.
  const helloTimer = setTimeout(() => {
    if (!ws.room && hub.conns.has(ws)) hub.hardClose(ws, CLOSE.HELLO, 'Hello timed out.');
  }, hub.o.helloMs);
  ws.on('close', () => clearTimeout(helloTimer));

  ws.on('message', (buf, isBinary) => {
    hub.message(ws, buf, buf.length || 0, isBinary);
    if (hub.room) rooms.set(hub.room.code, hub.room);
  });
});

// ------------------------------------------------------ periodic machinery ---
// reap dead sockets (heartbeat); the shared world itself lives for good
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, HEARTBEAT_MS);
heartbeat.unref?.();

server.listen(PORT, HOST, () => {
  console.log(`[city-server] listening on ${HOST}:${PORT}  (health /health, ws /ws, room ${hub.o.roomCode})`);
});

// graceful shutdown so restarts are clean
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[city-server] ${sig}, closing`);
    for (const ws of wss.clients) { try { ws.close(1012, 'server restarting'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export { server, rooms, wss, hub }; // for tests
