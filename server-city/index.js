// ==========================================================================
// Among The City — dedicated co-op server (client-authority relay).
//
//   • GET /health           → JSON liveness the main menu polls to enable the
//                             "Multiplayer (server)" button ONLY when it's up.
//   • WebSocket  /ws        → the game transport (see protocol.js).
//
// Port of ../AmongTheWoods/server/index.js minus the server-side simulation:
// no boot.mjs / three hook is needed here, so `node index.js` is the whole
// start. ONE shared world — every player joins the same PARDUBICE room.
//
// Run:   npm install && npm start           (listens on PORT, default 8081)
// ==========================================================================

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { MSG, PROTOCOL_VERSION, decode, encode } from './protocol.js';
import { Room } from './room.js';

const PORT = Number(process.env.PORT || 8081);
// ONE shared server world: every "Multiplayer" player joins THE SAME room, so
// there are no per-room codes to create or join. (MAIN_ROOM_CODE to rename.)
const MAIN_ROOM = (process.env.MAIN_ROOM_CODE || 'PARDUBICE').toUpperCase();
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS || 20); // shared-world seat cap
const HOST = process.env.HOST || '0.0.0.0'; // set 127.0.0.1 behind a reverse proxy
const EMPTY_ROOM_TTL_MS = Number(process.env.EMPTY_ROOM_TTL_MS || 120000);
const HEARTBEAT_MS = 30000;
const STARTED_AT = Date.now();

// ---------------------------------------------------------------- room hub ---
const rooms = new Map();               // code -> Room
const emptySince = new Map();          // code -> timestamp it went empty

// the single shared world — created on first join, then kept alive 24/7
function mainRoom() {
  let room = rooms.get(MAIN_ROOM);
  if (!room) { room = new Room(MAIN_ROOM, 'coop', 1); rooms.set(MAIN_ROOM, room); }
  return room;
}

function dropIfEmpty(room) {
  if (room.empty) emptySince.set(room.code, Date.now());
  else emptySince.delete(room.code);
}

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
      rooms: rooms.size,
      players: [...rooms.values()].reduce((n, r) => n + r.size, 0),
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
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.uid = null;
  ws.room = null;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf) => {
    const m = decode(buf);
    if (!m || typeof m.t !== 'string') return;

    // The very first message must be HELLO (join the shared room).
    if (!ws.room) {
      if (m.t !== MSG.HELLO) { fail(ws, 'Say hello first.'); return; }
      handleHello(ws, m);
      return;
    }

    const room = ws.room;
    switch (m.t) {
      case MSG.STATE: room.onState(ws.uid, m.state); break;
      case MSG.EVENT: room.onEvent(ws.uid, m.ev, m.to || null); break;
      case MSG.SNAP:  room.onSnap(ws.uid, m.snap); break;
      case MSG.META:  room.onMeta(ws.uid, m.patch); break;
      case MSG.PING:  safeSend(ws, { t: MSG.PONG }); break;
      case MSG.BYE:   ws.close(1000, 'bye'); break;
      default: break;
    }
  });

  ws.on('close', () => leave(ws));
  ws.on('error', () => leave(ws));
});

function handleHello(ws, m) {
  const uid = String(m.uid || '').slice(0, 40);
  if (!uid) { fail(ws, 'Missing uid.', true); return; }
  // ONE shared world: ignore want/code entirely — everyone lands in the same room.
  const room = mainRoom();
  if (!room.players.has(uid) && room.size >= MAX_PLAYERS) {
    fail(ws, `Server world is full (${MAX_PLAYERS} players) — try again later.`, true);
    return;
  }

  // one uid can't be in two seats — kick the stale socket
  if (room.players.has(uid)) {
    const prev = room.players.get(uid);
    try { prev.ws.close(4001, 'replaced'); } catch {}
    room.players.delete(uid);
  }

  ws.uid = uid;
  ws.room = room;
  room.add(uid, ws);
  emptySince.delete(room.code);
}

function leave(ws) {
  if (!ws.room || !ws.uid) return;
  const room = ws.room;
  room.remove(ws.uid);
  ws.room = null;
  dropIfEmpty(room);
}

function fail(ws, msg, fatal = false) {
  safeSend(ws, { t: MSG.ERROR, msg, fatal });
  if (fatal) { try { ws.close(4000, msg); } catch {} }
}
function safeSend(ws, obj) { if (ws.readyState === 1) { try { ws.send(encode(obj)); } catch {} } }

// ------------------------------------------------------ periodic machinery ---
// reap dead sockets (heartbeat) and long-empty rooms (never the shared world)
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} return; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
  const now = Date.now();
  for (const [code, since] of emptySince) {
    if (code === MAIN_ROOM) continue; // the shared world persists even when empty
    if (now - since > EMPTY_ROOM_TTL_MS) { rooms.delete(code); emptySince.delete(code); }
  }
}, HEARTBEAT_MS);

server.listen(PORT, HOST, () => {
  console.log(`[city-server] listening on ${HOST}:${PORT}  (health /health, ws /ws, room ${MAIN_ROOM})`);
});

// graceful shutdown so systemd restarts are clean
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[city-server] ${sig} — closing`);
    for (const ws of wss.clients) { try { ws.close(1012, 'server restarting'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export { server, rooms }; // for tests
