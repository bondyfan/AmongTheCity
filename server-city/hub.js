// ==========================================================================
// Hub: everything a relay does with a socket, written ONCE for both hosts.
//
//   index.js            Node + `ws` (local play, the test bed in test.js)
//   worker/src/coop.js  Cloudflare Durable Object (the live server)
//
// The hub owns admission (socket caps, per-IP caps), the hello handshake and
// the uid takeover, the rate limits, the per-lane size ceilings, PING/PONG and
// leaving. It never touches a transport API beyond what both hosts have:
//
//   conn.readyState, conn.send(string), conn.close(code, reason)
//   conn.bufferedAmount and conn.terminate() are optional (protocol.js
//   sendRaw reads them when they exist; the Workers WebSocket has neither)
//
// A `conn` is any object with those members. In Node it is the `ws` socket
// itself; in the Worker it is a small adapter around the hibernatable
// WebSocket (worker/src/conn.js). The hub keeps its bookkeeping ON the conn
// (uid, room, ip, rate window), exactly as index.js always did.
//
// Timers are the host's business, because a Durable Object must not hold a
// setTimeout (it keeps the object awake and billed). The host calls
// hub.expire(now) when it wants deadlines checked, and reads hub.deadline()
// to know when that should next happen.
// ==========================================================================

import { LIMITS, MSG, cleanUid, decode, encode, sendObj } from './protocol.js';
import { Room } from './room.js';

const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v != null ? Number(v) : d);

// Read the knobs from a plain object of strings (process.env or Worker env)
// so both hosts share one set of names and one set of defaults.
export function hubOptions(env = {}) {
  return {
    roomCode: String(env.MAIN_ROOM_CODE || 'PARDUBICE').toUpperCase(),
    maxPlayers: num(env.MAX_PLAYERS, 20),
    // three sockets a seat is plenty for reloads and second tabs; every open
    // socket is one that can keep sending billable frames
    maxSockets: num(env.MAX_SOCKETS, 3 * num(env.MAX_PLAYERS, 20)),
    maxSocketsPerIp: num(env.MAX_SOCKETS_PER_IP, 10),
    maxPlayersPerIp: num(env.MAX_PLAYERS_PER_IP, 6),
    helloMs: num(env.HELLO_TIMEOUT_MS, LIMITS.helloMs),
    // No frame at all for this long: the socket is dead (a half-open TCP, a
    // laptop lid). Generous on purpose: a backgrounded tab still pings, but
    // the browser may slow that 25 s timer to about once a minute.
    silenceMs: num(env.SILENCE_MS, 5 * 60 * 1000),
    // Seated but not MOVING for this long: a forgotten tab. 0 = off (Node).
    idleMs: num(env.IDLE_MS, 0),
    // how long a socket the server closed stays on the books (see DEAD_GRACE_MS)
    deadGraceMs: num(env.DEAD_GRACE_MS, DEAD_GRACE_MS),
  };
}

// Close codes a client can tell apart. 4001 and 4000 are the relay's old ones.
export const CLOSE = {
  FAIL: 4000,       // fatal protocol error (message in the ERROR frame)
  REPLACED: 4001,   // the same uid connected again elsewhere
  IDLE: 4002,       // seated and not moving for IDLE_MS
  SILENT: 4003,     // no frame at all for SILENCE_MS (a frozen or dead tab)
  HELLO: 4008,      // never said hello
  SOCKETS: 4029,    // too many sockets from one address
  LIMIT: 4402,      // the monthly budget is used up (Worker only)
  UNMEASURED: 4503, // the account guard cannot measure the account (Worker only)
  BUSY: 1013,
};

// A player has moved when the reported position is more than this far from
// the last anchor. Anything smaller is a parked car rocking in place.
const MOVE_EPS = 1.0;
// A socket the server closed but whose close never came back (a dead peer)
// is dropped from the books after this long, so it cannot hold an IP slot in
// Node, where terminate() really ends it. A Workers socket has no terminate():
// a peer that ignores the close keeps it open, so the Durable Object counts
// its sockets from ctx.getWebSockets() instead (worker/src/coop.js).
export const DEAD_GRACE_MS = 10000;

export class Hub {
  constructor(opts = {}, hooks = {}) {
    this.o = { ...hubOptions({}), ...opts };
    this.hooks = hooks;           // onSeat, onUnseat, onState, onAuthority, onSnap, onMeta, onKill, onHardClose
    this.now = opts.now || Date.now;
    this.conns = new Set();       // every open socket, joined or not
    this.room = null;
  }

  get players() { return this.room ? this.room.size : 0; }
  get sockets() { return this.conns.size; }

  // the single shared world, created on first use and then kept for good
  mainRoom() {
    if (!this.room) {
      this.room = new Room(this.o.roomCode, 'coop', 1);
      const hk = this.hooks;
      this.room.onAuthority = (prev, next) => hk.onAuthority?.(prev, next);
    }
    return this.room;
  }

  // ---------------------------------------------------------- admission ---
  // Returns false (and has already closed the socket) when it is refused.
  open(conn, ip) {
    const now = this.now();
    if (this.conns.size >= this.o.maxSockets) { this.hardClose(conn, CLOSE.BUSY, 'Server busy.'); return false; }
    if (this.socketsFromIp(ip) >= this.o.maxSocketsPerIp) {
      this.hardClose(conn, CLOSE.SOCKETS, 'Too many connections.');
      return false;
    }
    this.init(conn, ip, now);
    this.conns.add(conn);
    return true;
  }

  init(conn, ip, now) {
    conn.ip = ip;
    conn.dead = false;
    conn.deadAt = 0;
    conn.uid = null;
    conn.room = null;
    conn.openedAt = now;
    conn.seenAt = now;
    conn.movedAt = now;
    conn.anchor = null;
    conn.winStart = now; conn.winMsgs = 0; conn.winBytes = 0;
    conn.winOver = false; conn.overSeconds = 0;
  }

  socketsFromIp(ip) {
    let n = 0;
    for (const c of this.conns) if (c.ip === ip) n++;
    return n;
  }

  // how many SEATED players share this socket's IP
  seatsFromIp(ip) {
    let n = 0;
    for (const c of this.conns) if (c.room && c.ip === ip) n++;
    return n;
  }

  // ------------------------------------------------------------ messages ---
  // `size` is the frame's size in BYTES (the host knows how to measure it).
  message(conn, data, size, isBinary = false) {
    if (!this.conns.has(conn) || conn.dead) return;
    const now = this.now();
    conn.seenAt = now;
    if (isBinary) { this.fail(conn, 'Binary frames are not part of this protocol.', true); return; }
    if (size > LIMITS.payload) { this.fail(conn, 'Frame too large.', true, 1009); return; }
    if (!this.withinRate(conn, size, now)) return;

    const m = decode(data);
    if (!m || typeof m.t !== 'string') return;

    // The very first message must be HELLO (join the shared room).
    if (!conn.room) {
      if (m.t !== MSG.HELLO) { this.fail(conn, 'Say hello first.', true); return; }
      if (size > LIMITS.hello) { this.fail(conn, 'Hello too large.', true); return; }
      this.hello(conn, m, now);
      return;
    }

    const room = conn.room;
    switch (m.t) {
      // Per-lane size ceilings, measured on the RAW frame so an oversized
      // packet costs nothing to reject and can never reach p.lastState.
      case MSG.STATE:
        if (size <= LIMITS.state && room.onState(conn.uid, m.state)) {
          this.moved(conn, m.state, now);
          this.hooks.onState?.(conn, m.state);
        }
        break;
      case MSG.EVENT: if (size <= LIMITS.event) room.onEvent(conn.uid, m.ev, cleanUid(m.to) || null); break;
      case MSG.SNAP:
        if (size <= LIMITS.snap && room.onSnap(conn.uid, m.snap)) this.hooks.onSnap?.(room.lastSnap);
        break;
      case MSG.META:
        if (size <= LIMITS.meta && room.onMeta(conn.uid, m.patch)) this.hooks.onMeta?.(room.meta);
        break;
      // PONG echoes the client's own send stamp and adds the server's clock:
      // with t0 sent, `now` at the server and t1 received the client has a
      // complete NTP sample (worldclock.setEpoch keeps the lowest-rtt one).
      case MSG.PING:
        sendObj(conn, { t: MSG.PONG, now: Date.now(),
          ...(Number.isFinite(m.ts) ? { ts: m.ts } : {}) });
        break;
      case MSG.BYE: try { conn.close(1000, 'bye'); } catch {} break;
      default: break;
    }
  }

  // One-second budget of messages and bytes per socket. Going over DROPS the
  // excess (a laggy client that bunches up frames is not an attacker and must
  // not be disconnected mid-game); only three over-budget seconds in a row,
  // which no real client can produce, cost the socket. A second with no
  // traffic at all forgives too (gap >= 2000): a backgrounded tab that went
  // over once and then fell silent must not carry the strike forever.
  withinRate(conn, size, now = this.now()) {
    const gap = now - conn.winStart;
    if (gap >= 1000) {
      if (!conn.winOver || gap >= 2000) conn.overSeconds = 0;
      conn.winStart = now; conn.winMsgs = 0; conn.winBytes = 0;
      conn.winOver = false;
    }
    conn.winMsgs++;
    conn.winBytes += size;
    if (conn.winMsgs <= LIMITS.msgsPerSec && conn.winBytes <= LIMITS.bytesPerSec) return true;
    if (!conn.winOver) { conn.winOver = true; conn.overSeconds = (conn.overSeconds || 0) + 1; }
    if (conn.overSeconds >= LIMITS.overSecondsToKill) this.fail(conn, 'Too many messages.', true);
    return false;
  }

  moved(conn, s, now) {
    const x = Number(s.x), z = Number(s.z);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const a = conn.anchor;
    if (!a || Math.hypot(x - a.x, z - a.z) > MOVE_EPS) { conn.anchor = { x, z }; conn.movedAt = now; }
  }

  hello(conn, m, now) {
    const uid = cleanUid(m.uid);
    if (!uid) { this.fail(conn, 'Missing uid.', true); return; }
    // ONE shared world: want/code are ignored, everyone lands in the same room.
    const room = this.mainRoom();
    const rejoin = room.players.get(uid);
    const max = this.o.maxPlayers;

    if (!rejoin && room.size >= max) {
      this.fail(conn, `Server world is full (${max} players), try again later.`, true);
      return;
    }
    // One machine must not be able to sit in every seat and lock the world out.
    if (!rejoin && this.seatsFromIp(conn.ip) >= this.o.maxPlayersPerIp) {
      this.fail(conn, 'Too many players from this connection.', true);
      return;
    }

    // ---- one uid can't be in two seats: the RECONNECT case ----
    // Closing the stale socket fires its close -> leave(), asynchronously,
    // AFTER the new socket has already taken the seat. leave() therefore
    // checks seat ownership (players.get(uid).ws === that socket), so the
    // stale close is a no-op. The old lastState carries over so peers never
    // lose the avatar.
    let prevState = null;
    if (rejoin) {
      prevState = rejoin.lastState;
      room.players.delete(uid);           // no PEER 'leave': the player is not leaving
      const old = rejoin.ws;
      old.uid = null;                     // that socket owns nothing any more
      old.room = null;
      this.hooks.onUnseat?.(old);
      this.kill(old, now);
      try { old.close(CLOSE.REPLACED, 'replaced'); } catch {}
    }

    conn.uid = uid;
    conn.room = room;
    conn.movedAt = now;
    room.add(uid, conn, prevState);
    this.hooks.onSeat?.(conn);
  }

  // After a Durable Object wakes up: put a socket back in its seat without
  // telling anybody (nobody left, nobody joined, the object just slept).
  restore(conn, ip, seat = null, now = this.now()) {
    this.init(conn, ip, now);
    if (seat && seat.openedAt) conn.openedAt = seat.openedAt;
    if (seat && seat.seenAt) conn.seenAt = Math.min(now, seat.seenAt);
    if (seat && seat.movedAt) conn.movedAt = Math.min(now, seat.movedAt);
    this.conns.add(conn);
    if (!seat || !seat.uid) return;
    const room = this.mainRoom();
    const uid = cleanUid(seat.uid);
    if (!uid || room.players.has(uid)) return;
    conn.uid = uid;
    conn.room = room;
    room.restore(uid, conn, seat.lastState ?? null, seat.joinedAt || now, !!seat.authority);
  }

  // ---------------------------------------------------------- leaving ----
  closed(conn) {
    if (!this.conns.delete(conn)) return false;
    const room = conn.room;
    conn.room = null;
    if (!room || !conn.uid) return true;
    // A socket only vacates the seat it still holds; a socket replaced by a
    // reconnect holds nothing.
    const seat = room.players.get(conn.uid);
    if (!seat || seat.ws !== conn) return true;
    room.remove(conn.uid);
    return true;
  }

  // Mark a socket the server is closing: it says nothing more, and expire()
  // drops it from the books if its close event never arrives.
  kill(conn, now = this.now()) {
    if (conn.dead) return;
    conn.dead = true;
    conn.deadAt = now;
    this.hooks.onKill?.(conn);
  }

  fail(conn, msg, fatal = false, code = CLOSE.FAIL) {
    sendObj(conn, { t: MSG.ERROR, msg, fatal });
    if (fatal) { this.kill(conn); try { conn.close(code, msg.slice(0, 100)); } catch {} }
  }

  hardClose(conn, code, msg, extra = {}) {
    this.kill(conn);
    try { conn.send(encode({ t: MSG.ERROR, msg, fatal: true, ...extra })); } catch {}
    try { conn.close(code, msg.slice(0, 100)); } catch {}
    this.hooks.onHardClose?.(conn);
  }

  // Close every socket (the budget guard, a shutdown). The closes arrive
  // later as ordinary close events.
  closeAll(code, msg, extra = {}) {
    for (const c of [...this.conns]) this.hardClose(c, code, msg, extra);
  }

  // --------------------------------------------------------- deadlines ---
  // The earliest moment something has to be checked, or 0 for never.
  deadline() {
    let t = 0;
    const take = (v) => { if (v > 0 && (!t || v < t)) t = v; };
    for (const c of this.conns) {
      if (c.dead) { take(c.deadAt + this.o.deadGraceMs); continue; }
      if (!c.room) take(c.openedAt + this.o.helloMs);
      if (this.o.silenceMs > 0) take(c.seenAt + this.o.silenceMs);
      if (c.room && this.o.idleMs > 0) take(c.movedAt + this.o.idleMs);
    }
    return t;
  }

  // Close whatever is past its deadline. Returns how many were closed.
  // `onDrop(conn)` hears about the dead ones taken off the books.
  expire(now = this.now(), onDrop = null) {
    let n = 0;
    for (const c of [...this.conns]) {
      if (c.dead) {
        if (now - c.deadAt >= this.o.deadGraceMs) { this.closed(c); onDrop?.(c); }
        continue;
      }
      if (!c.room && now - c.openedAt >= this.o.helloMs) { this.hardClose(c, CLOSE.HELLO, 'Hello timed out.'); n++; }
      else if (this.o.silenceMs > 0 && now - c.seenAt >= this.o.silenceMs) {
        this.hardClose(c, CLOSE.SILENT, 'Silent too long.', { code: 'silent' }); n++;
      }
      else if (c.room && this.o.idleMs > 0 && now - c.movedAt >= this.o.idleMs) {
        this.hardClose(c, CLOSE.IDLE, 'Idle too long.', { code: 'idle' }); n++;
      }
    }
    return n;
  }
}
