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
// This process is PUBLIC and unauthenticated: anyone who can reach /ws is a
// player. Everything a socket can do is therefore bounded — frame size, frame
// rate, byte rate, sockets per IP, seats per IP, and how long a socket may sit
// there without ever saying hello. See protocol.js LIMITS.
//
// Run:   npm install && npm start           (listens on PORT, default 8081)
// ==========================================================================

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { LIMITS, MSG, PROTOCOL_VERSION, cleanUid, decode, encode, sendObj } from './protocol.js';
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

// Abuse ceilings. Per-IP caps are what stop one laptop from taking all 20
// seats; MAX_SOCKETS bounds the un-joined sockets too (handshake floods).
const MAX_SOCKETS = Number(process.env.MAX_SOCKETS || 200);
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP || 10);
const MAX_PLAYERS_PER_IP = Number(process.env.MAX_PLAYERS_PER_IP || 6);
const HELLO_TIMEOUT_MS = Number(process.env.HELLO_TIMEOUT_MS || LIMITS.helloMs);
// Behind Caddy every socket looks like 127.0.0.1, which would make the per-IP
// caps either useless or fatal, so X-Forwarded-For wins by default. Set
// TRUST_PROXY=0 when the process is exposed directly: then the header is
// attacker-controlled and must be ignored.
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';

// ---------------------------------------------------------------- room hub ---
const rooms = new Map();               // code -> Room
const emptySince = new Map();          // code -> timestamp it went empty
const socketsPerIp = new Map();        // ip -> open socket count

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
      sockets: wss ? wss.clients.size : 0,  // > players = sockets still pre-hello
      capacity: MAX_PLAYERS,
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
// and this server is an AMPLIFIER — one frame in, up to MAX_PLAYERS-1 frames
// out. 64 KiB in × 19 out is a shrug; 1 MiB × 19 was a free DoS.
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
  const ip = clientIp(req);

  if (wss.clients.size > MAX_SOCKETS) { hardClose(ws, 1013, 'Server busy.'); return; }
  const openHere = (socketsPerIp.get(ip) || 0) + 1;
  if (openHere > MAX_SOCKETS_PER_IP) { hardClose(ws, 4029, 'Too many connections.'); return; }
  socketsPerIp.set(ip, openHere);

  ws.isAlive = true;
  ws.uid = null;
  ws.room = null;
  ws.ip = ip;
  ws.counted = true;
  // rate window: one second of message count + byte count per socket
  ws.winStart = Date.now();
  ws.winMsgs = 0;
  ws.winBytes = 0;
  ws.winOver = false;
  ws.overSeconds = 0;
  // A socket that connects and says nothing used to live forever (and held an
  // IP slot). Give it ten seconds to say hello like a player would.
  ws.helloTimer = setTimeout(() => {
    if (!ws.room) hardClose(ws, 4008, 'Hello timed out.');
  }, HELLO_TIMEOUT_MS);

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (buf, isBinary) => {
    if (isBinary) { fail(ws, 'Binary frames are not part of this protocol.', true); return; }
    const size = buf.length || 0;
    if (!withinRate(ws, size)) return;

    const m = decode(buf);
    if (!m || typeof m.t !== 'string') return;

    // The very first message must be HELLO (join the shared room).
    if (!ws.room) {
      if (m.t !== MSG.HELLO) { fail(ws, 'Say hello first.', true); return; }
      if (size > LIMITS.hello) { fail(ws, 'Hello too large.', true); return; }
      handleHello(ws, m);
      return;
    }

    const room = ws.room;
    switch (m.t) {
      // Per-lane size ceilings, measured on the RAW frame so an oversized
      // packet costs nothing to reject and can never reach p.lastState.
      case MSG.STATE: if (size <= LIMITS.state) room.onState(ws.uid, m.state); break;
      case MSG.EVENT: if (size <= LIMITS.event) room.onEvent(ws.uid, m.ev, cleanUid(m.to) || null); break;
      case MSG.SNAP:  if (size <= LIMITS.snap) room.onSnap(ws.uid, m.snap); break;
      case MSG.META:  if (size <= LIMITS.meta) room.onMeta(ws.uid, m.patch); break;
      // PONG echoes the client's own send stamp and adds the server's clock.
      // That triple (t0 sent, `now` at the server, t1 received) is a complete
      // NTP sample: the client learns the offset AND the round trip, and
      // worldclock.setEpoch keeps the lowest-rtt one. WELCOME's `now` alone is
      // late by one network leg; this is what shrinks the bias to the path
      // asymmetry. `t` is echoed verbatim as a number, so a client that sends
      // nothing gets undefined and simply measures no rtt.
      case MSG.PING:
        sendObj(ws, { t: MSG.PONG, now: Date.now(),
          ...(Number.isFinite(m.ts) ? { ts: m.ts } : {}) });
        break;
      case MSG.BYE:   ws.close(1000, 'bye'); break;
      default: break;
    }
  });

  ws.on('close', () => { leave(ws); releaseIp(ws); });
  ws.on('error', () => { leave(ws); releaseIp(ws); });
});

// One-second budget of messages and bytes per socket. Going over DROPS the
// excess (a laggy client that bunches up frames is not an attacker and must
// not be disconnected mid-game); only three over-budget seconds in a row —
// which no real client can produce — costs the socket.
function withinRate(ws, size) {
  const now = Date.now();
  const gap = now - ws.winStart;
  if (gap >= 1000) {
    // A clean second forgives the last one — and so does a second that carried
    // no traffic AT ALL. The counter only ever advanced on a window that saw a
    // message, so a socket that went over budget and then fell SILENT kept its
    // strike forever: three bursts minutes apart added up to a kill even though
    // every second in between was empty. That is what a backgrounded tab looks
    // like (rAF stops, the socket goes quiet), not what an attacker looks like.
    // gap >= 2000 means at least one whole second passed with nothing sent.
    if (!ws.winOver || gap >= 2000) ws.overSeconds = 0;
    ws.winStart = now; ws.winMsgs = 0; ws.winBytes = 0;
    ws.winOver = false;
  }
  ws.winMsgs++;
  ws.winBytes += size;
  if (ws.winMsgs <= LIMITS.msgsPerSec && ws.winBytes <= LIMITS.bytesPerSec) return true;
  if (!ws.winOver) { ws.winOver = true; ws.overSeconds = (ws.overSeconds || 0) + 1; }
  if (ws.overSeconds >= LIMITS.overSecondsToKill) { fail(ws, 'Too many messages.', true); }
  return false;
}

function releaseIp(ws) {
  if (!ws.counted) return;
  ws.counted = false;
  if (ws.helloTimer) { clearTimeout(ws.helloTimer); ws.helloTimer = null; }
  const n = (socketsPerIp.get(ws.ip) || 1) - 1;
  if (n > 0) socketsPerIp.set(ws.ip, n); else socketsPerIp.delete(ws.ip);
}

function handleHello(ws, m) {
  const uid = cleanUid(m.uid);
  if (!uid) { fail(ws, 'Missing uid.', true); return; }
  // ONE shared world: ignore want/code entirely — everyone lands in the same room.
  const room = mainRoom();
  const rejoin = room.players.get(uid);

  if (!rejoin && room.size >= MAX_PLAYERS) {
    fail(ws, `Server world is full (${MAX_PLAYERS} players) — try again later.`, true);
    return;
  }
  // One machine must not be able to sit in every seat and lock the world out.
  if (!rejoin && seatsFromIp(ws.ip) >= MAX_PLAYERS_PER_IP) {
    fail(ws, 'Too many players from this connection.', true);
    return;
  }

  // ---- one uid can't be in two seats — the RECONNECT case ----
  // Closing the stale socket fires its 'close' → leave(), asynchronously,
  // AFTER the new socket has already taken the seat. leave() used to remove
  // by uid and would therefore delete the player who just arrived: you stayed
  // visible to everyone else and saw nobody, forever. leave() now checks seat
  // ownership (players.get(uid).ws === that socket), so the stale close is a
  // no-op. Carry the old lastState over so peers never lose the avatar.
  let prevState = null;
  if (rejoin) {
    prevState = rejoin.lastState;
    room.players.delete(uid);           // no PEER 'leave': the player is not leaving
    rejoin.ws.uid = null;               // belt and braces: that socket owns nothing
    rejoin.ws.room = null;
    try { rejoin.ws.close(4001, 'replaced'); } catch {}
  }

  if (ws.helloTimer) { clearTimeout(ws.helloTimer); ws.helloTimer = null; }
  ws.uid = uid;
  ws.room = room;
  room.add(uid, ws, prevState);
  emptySince.delete(room.code);
}

// how many SEATED players share this socket's IP
function seatsFromIp(ip) {
  let n = 0;
  for (const c of wss.clients) if (c.room && c.ip === ip) n++;
  return n;
}

function leave(ws) {
  const room = ws.room;
  ws.room = null;
  if (!room || !ws.uid) return;
  // Seat-ownership check — see handleHello. A socket only vacates the seat it
  // still holds; a socket replaced by a reconnect holds nothing.
  const seat = room.players.get(ws.uid);
  if (!seat || seat.ws !== ws) return;
  room.remove(ws.uid);
  dropIfEmpty(room);
}

function fail(ws, msg, fatal = false) {
  sendObj(ws, { t: MSG.ERROR, msg, fatal });
  if (fatal) { try { ws.close(4000, msg.slice(0, 100)); } catch {} }
}

function hardClose(ws, code, msg) {
  ws.on('error', () => {});   // a rejected socket has no other listener yet
  try { ws.send(encode({ t: MSG.ERROR, msg, fatal: true })); } catch {}
  try { ws.close(code, msg); } catch {}
  setTimeout(() => { try { ws.terminate(); } catch {} }, 1000).unref();
}

// ------------------------------------------------------ periodic machinery ---
// reap dead sockets (heartbeat) and long-empty rooms (never the shared world)
const heartbeat = setInterval(() => {
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
heartbeat.unref?.();

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

export { server, rooms, wss }; // for tests
