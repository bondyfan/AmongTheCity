// ==========================================================================
// CoopRoom: the ONE shared Pardubice as a Durable Object (SQLite class).
//
// The room and protocol logic is the Node relay's (hub.js, room.js,
// protocol.js); this class is only the Durable Object host around it:
//
//   - WebSocket Hibernation API: ctx.acceptWebSocket and the webSocket*
//     handlers. No setInterval, no setTimeout: an idle object hibernates and
//     costs nothing, and an alarm exists only while sockets do.
//   - Waking up: the hub is rebuilt from the sockets' attachments (seat,
//     joinedAt, authority, the last state blob) and from storage (room meta
//     with its `created` time, the world snapshot, the budget).
//   - The budget guard (budget.js, account.js): every event is counted, and
//     when a cap is reached every socket is closed with 4402 'limit', new ones
//     are refused and /health answers { ready: false, reason: 'limit' } until
//     the next billing cycle. With the account guard's secret set and the
//     account not measurable, co-op closes too (4503 'unmeasured').
//   - Socket caps count what the RUNTIME holds (ctx.getWebSockets, tagged by
//     address), not the hub's books: a Workers socket cannot be terminated,
//     and a peer that ignores our close frame keeps it open and billable.
// ==========================================================================

import { PROTOCOL_VERSION } from '../../protocol.js';
import { CLOSE, Hub } from '../../hub.js';
import { IDLE_EVENT_MS, Meter } from './budget.js';
import { accountOver, accountUsage, queryDates } from './account.js';
import { WsConn, attachmentOf, config, seatFrom, utf8Bytes } from './conn.js';

const LIMIT_MSG = 'The co-op budget for this month is used up.';
const UNMEASURED_MSG = 'The co-op server cannot check its budget right now.';
const ATTACH_EVERY_MS = 2000;   // a socket's attachment is rewritten at most this often
// The snapshot and meta rows: written at most this often, and a dirty row
// holds an alarm until it is written, so a wake never finds an older one.
const SAVE_EVERY_MS = 1000;
const ipTag = (ip) => `ip:${ip}`;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export class CoopRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.cfg = config(env);
    this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
    this.alarmAt = null;
    ctx.blockConcurrencyWhile(async () => { this.alarmAt = await ctx.storage.getAlarm(); });
    this.wake();
  }

  // ------------------------------------------------------------ storage ---
  get(k) {
    const row = this.sql.exec('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    if (!row) return null;
    try { return JSON.parse(row.v); } catch { return null; }
  }
  put(k, v) {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v',
      k, JSON.stringify(v));
  }

  // Everything that lives in memory, (re)built from the sockets and storage.
  // The constructor calls it; so does the test-only /__test/forget, which is
  // exactly what a wake from hibernation looks like from in here.
  wake() {
    const now = Date.now();
    this.byWs = new Map();
    this.dirty = { snap: false, meta: false };
    this.savedAt = { snap: 0, meta: 0 };
    this.checking = null;
    this.hub = new Hub(this.cfg.hub, {
      // a seat may make the account check due: schedule() after the message
      // sets the alarm that runs it
      onSeat: (c) => this.attach(c, true),
      onUnseat: (c) => this.attach(c, true),
      onKill: (c) => this.attach(c, true),
      onAuthority: (prev, next) => {
        for (const uid of [prev, next]) { const c = this.seatConn(uid); if (c) this.attach(c, true); }
      },
      // every accepted state blob goes into the attachment at once: the last
      // one before a quiet spell is exactly the one a wake must not lose
      onState: (c) => this.attach(c, true),
      onSnap: () => { this.dirty.snap = true; },
      onMeta: () => { this.dirty.meta = true; },
    });
    const room = this.hub.mainRoom();
    // The room's `created` is part of what clients are told; it must not jump
    // because the object slept or moved, so it is written once and kept.
    const meta = this.get('meta');
    if (meta && Number.isFinite(meta.created)) room.meta = { ...room.meta, ...meta, host: 'server' };
    else this.put('meta', room.meta);
    room.createdAt = room.meta.created;
    const snap = this.get('snap');
    if (snap) room.lastSnap = snap;

    for (const ws of this.ctx.getWebSockets()) {
      let att = null;
      try { att = ws.deserializeAttachment(); } catch {}
      if (att && att.dead) { try { ws.close(1000, 'closed'); } catch {} continue; }
      const seat = seatFrom(att);
      const conn = new WsConn(ws);
      this.byWs.set(ws, conn);
      this.hub.restore(conn, seat ? seat.ip : 'unknown', seat, now);
    }

    this.meter = new Meter({ day: this.cfg.cycleDay, tailMs: this.cfg.tailMs, flushMs: this.cfg.flushMs })
      .load(this.get('budget'), now);
    this.acct = this.get('account');
    this.limited = this.limitState();
  }

  seatConn(uid) {
    const p = uid && this.hub.room ? this.hub.room.players.get(uid) : null;
    return p ? p.ws : null;
  }

  attach(conn, force = false) {
    const now = Date.now();
    if (!force && now - conn.attAt < ATTACH_EVERY_MS) return;
    conn.attAt = now;
    const att = conn.dead ? { dead: true } : attachmentOf(conn, this.hub.room);
    try { conn.ws.serializeAttachment(att); }
    catch { try { conn.ws.serializeAttachment({ ...att, ls: null }); } catch {} }
  }

  // ------------------------------------------------------------- budget ---
  // null, or why co-op is closed: 'own' (this object's caps), 'account' (the
  // whole account is over its limits), 'unmeasured' (the account guard is on
  // but its last checks all failed: fail closed).
  limitState() {
    if (this.meter.over(this.cfg.caps)) return 'own';
    const a = this.acct, cfg = this.cfg.account;
    if (!a || a.cyc !== this.meter.cycle.id) return null;
    if (a.okAt && accountOver(a, cfg.limits)) return 'account';
    if (cfg.token && (a.fails || 0) >= cfg.failsToClose) return 'unmeasured';
    return null;
  }

  // Count one event; trip the guard the moment a cap is reached. `maxMs`
  // caps the awake time charged (see Meter.awake).
  charge(kind, now, maxMs) {
    if (this.meter.roll(now)) this.put('budget', this.meter.record(now));   // a new cycle
    if (kind === 'msg') this.meter.msg(now, 1, maxMs); else this.meter.req(now, 1, maxMs);
    this.relimit(now);
  }

  relimit(now) {
    const was = this.limited;
    this.limited = this.limitState();
    if (this.limited && !was) this.trip(now);
  }

  // Close one socket with the reason co-op is shut.
  refuse(conn) {
    if (this.limited === 'unmeasured') this.hub.hardClose(conn, CLOSE.UNMEASURED, UNMEASURED_MSG, { code: 'unmeasured' });
    else this.hub.hardClose(conn, CLOSE.LIMIT, LIMIT_MSG, { code: 'limit' });
  }

  trip(now) {
    this.persist(now, true);
    for (const c of [...this.hub.conns]) if (!c.dead) this.refuse(c);
  }

  persist(now, force = false) {
    if (force || this.meter.due(now)) this.put('budget', this.meter.record(now));
    const room = this.hub.room;
    for (const k of ['snap', 'meta']) {
      if (!this.dirty[k] || (!force && now - this.savedAt[k] < SAVE_EVERY_MS)) continue;
      this.put(k, k === 'snap' ? room.lastSnap : room.meta);
      this.dirty[k] = false;
      this.savedAt[k] = now;
    }
  }

  // When the account guard should next run, or 0 for not at all: never
  // without the secret, never once this cycle is already closed for good,
  // never with nobody seated (except to recover from 'unmeasured'), at once
  // for a cycle not measured yet (its first player), then hourly, and after
  // a failure sooner.
  accountDueAt() {
    const a = this.cfg.account;
    if (!a.token || this.limited === 'own' || this.limited === 'account') return 0;
    if (!this.hub.players && this.limited !== 'unmeasured') return 0;
    const r = this.acct;
    if (!r || r.cyc !== this.meter.cycle.id) return 1;
    return r.checkedAt + (r.fails ? a.retryMs : a.everyMs);
  }

  // Start the check when it is due; the promise (or null) never rejects.
  maybeCheckAccount(now) {
    if (this.checking) return this.checking;
    const due = this.accountDueAt();
    if (!due || due > now) return null;
    this.checking = this.checkAccount(now).finally(() => { this.checking = null; });
    return this.checking;
  }

  async checkAccount(now) {
    const a = this.cfg.account, cyc = this.meter.cycle;
    const prev = this.acct && this.acct.cyc === cyc.id ? this.acct : null;
    let rec;
    try {
      if (!a.id) throw new Error('CF_ACCOUNT_ID is not set');
      const u = await accountUsage({ fetch: (u, i) => fetch(u, i), url: a.url, token: a.token,
        accountId: a.id, ...queryDates(cyc, now), ownMsgs: this.meter.msgs, timeoutMs: a.timeoutMs });
      rec = { cyc: cyc.id, gbs: u.gbs, requests: u.requests, checkedAt: now, okAt: now, fails: 0 };
    } catch (e) {
      // Could not measure: keep the last good numbers of this cycle (an
      // earlier "over" stays over), count the failure, retry sooner. After
      // failsToClose failures in a row limitState() says 'unmeasured'.
      rec = { cyc: cyc.id, gbs: prev ? prev.gbs : 0, requests: prev ? prev.requests : 0,
        checkedAt: now, okAt: prev ? prev.okAt || 0 : 0, fails: (prev ? prev.fails || 0 : 0) + 1,
        error: String(e && e.message || e).slice(0, 120) };
    }
    this.acct = rec;
    this.put('account', rec);
    const t = Date.now();
    this.relimit(t);
    this.schedule(t);
  }

  // ------------------------------------------------------------- alarms ---
  // One alarm, set only while sockets exist, at the earliest deadline: a
  // hello that is due, a silent or idle socket, a dead one to drop, a dirty
  // snapshot or meta row, the account check. Moving it later never costs a
  // write.
  schedule(now) {
    if (this.hub.conns.size === 0) {
      if (this.alarmAt) { this.alarmAt = null; this.ctx.storage.deleteAlarm(); }
      return;
    }
    let t = this.hub.deadline();
    const take = (v) => { if (v > 0 && (!t || v < t)) t = v; };
    take(this.accountDueAt());
    for (const k of ['snap', 'meta']) if (this.dirty[k]) take(this.savedAt[k] + SAVE_EVERY_MS);
    if (!t) return;
    t = Math.max(t, now + 50);
    if (this.alarmAt && this.alarmAt <= t + 250) return;
    this.alarmAt = t;
    this.ctx.storage.setAlarm(t);
  }

  async alarm() {
    const now = Date.now();
    this.alarmAt = null;
    try {
      this.charge('req', now);
      this.hub.expire(now, (c) => this.byWs.delete(c.ws));
      // bounded by the fetch timeout in accountUsage
      const check = this.maybeCheckAccount(now);
      if (check) await check;
    } finally {
      const t = Date.now();
      this.persist(t);
      this.schedule(t);
    }
  }

  // -------------------------------------------------------------- fetch ---
  async fetch(request) {
    const now = Date.now();
    // an object without sockets is not kept awake after this handler
    const empty = this.ctx.getWebSockets().length === 0;
    this.charge('req', now, empty ? IDLE_EVENT_MS : undefined);
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      // Closed as unmeasured: nobody can join, so a menu poll is what retries
      // the check (at most every ACCOUNT_RETRY_MS). Not awaited; the fetch
      // has its own timeout and keeps the object alive while it runs.
      if (this.limited === 'unmeasured') {
        const check = this.maybeCheckAccount(now);
        if (check) { try { this.ctx.waitUntil?.(check); } catch {} }
      }
      this.persist(now);
      return json(this.health());
    }
    if (url.pathname === '/__test/forget' && this.cfg.testRooms) { this.wake(); return json({ ok: true }); }
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });

    const ip = (request.headers.get('x-coop-ip') || 'unknown').slice(0, 64);
    // The caps count every socket the runtime still holds, the ones we have
    // closed but whose peer never answered included: refused here, before
    // acceptWebSocket, nothing new can be held open.
    const h = this.cfg.hub;
    if (this.ctx.getWebSockets(ipTag(ip)).length >= h.maxSocketsPerIp) {
      return new Response('Too many connections.', { status: 429, headers: { 'Retry-After': '60' } });
    }
    if (this.ctx.getWebSockets().length >= h.maxSockets) {
      return new Response('Server busy.', { status: 503, headers: { 'Retry-After': '60' } });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [ipTag(ip)]);
    const conn = new WsConn(server);
    this.byWs.set(server, conn);
    const headers = {};
    if (this.limited) {
      // accepted only to say why: the client shows the reason, not a dead socket
      this.refuse(conn);
      if (this.limited !== 'unmeasured') {
        headers['x-coop-state'] = 'limit';
        headers['x-coop-reset'] = String(this.meter.cycle.end);
      }
    } else {
      this.hub.open(conn, ip);    // a refusal has already closed it (dead)
    }
    this.attach(conn, true);
    this.persist(now);
    this.schedule(now);
    return new Response(null, { status: 101, webSocket: client, headers });
  }

  // --------------------------------------------------------- websockets ---
  async webSocketMessage(ws, data) {
    const now = Date.now();
    this.charge('msg', now);
    const conn = this.byWs.get(ws);
    if (!conn) { try { ws.close(1011, 'unknown socket'); } catch {} return; }
    // closed by us: a peer that keeps talking is billed (counted above), never served
    if (conn.dead) return;
    if (this.limited) { this.refuse(conn); this.schedule(now); return; }
    const bin = typeof data !== 'string';
    this.hub.message(conn, data, bin ? data.byteLength : utf8Bytes(data), bin);
    if (!conn.dead) this.attach(conn);
    this.persist(now);
    this.schedule(now);
  }

  async webSocketClose(ws, code) { this.gone(ws, code); }
  async webSocketError(ws) { this.gone(ws, 1011); }

  gone(ws, code) {
    const now = Date.now();
    this.charge('msg', now);
    // complete the closing handshake (a no-op where the runtime already did)
    try { ws.close(code >= 3000 && code < 5000 ? code : 1000, 'closed'); } catch {}
    const conn = this.byWs.get(ws);
    this.byWs.delete(ws);
    if (conn) this.hub.closed(conn);
    this.persist(now, this.hub.conns.size === 0);
    this.schedule(now);
  }

  // ------------------------------------------------------------- health ---
  health() {
    const m = this.meter.summary(), lim = this.limited, a = this.cfg.account, r = this.acct;
    const cur = r && r.cyc === m.cycle ? r : null;
    return {
      status: 'ok',
      ready: !lim,
      ...(lim ? { reason: lim === 'unmeasured' ? 'unmeasured' : 'limit', scope: lim, resetsAt: m.resetsAt } : {}),
      service: 'among-the-city',
      protocol: PROTOCOL_VERSION,
      rooms: 1,
      players: this.hub.players,
      sockets: this.hub.sockets,
      held: this.ctx.getWebSockets().length,
      capacity: this.cfg.hub.maxPlayers,
      created: this.hub.room.meta.created,
      budget: { ...m, capGbs: this.cfg.caps.gbs, capRequests: this.cfg.caps.requests },
      account: a.token ? {
        checkedAt: cur ? new Date(cur.checkedAt).toISOString() : null,
        measuredAt: cur && cur.okAt ? new Date(cur.okAt).toISOString() : null,
        gbs: cur && cur.okAt ? cur.gbs : null,
        requests: cur && cur.okAt ? cur.requests : null,
        fails: cur ? cur.fails || 0 : 0,
        limitGbs: a.limits.gbs, limitRequests: a.limits.requests,
        ...(cur && cur.error ? { error: cur.error } : {}),
      } : null,
    };
  }
}
