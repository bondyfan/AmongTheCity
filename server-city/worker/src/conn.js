// ==========================================================================
// The Workers side of the socket contract hub.js expects, plus the config.
//
// A hibernatable WebSocket has send/close/readyState but no bufferedAmount
// and no terminate(), and it forgets everything we hang on it when the
// object hibernates. WsConn carries the hub's bookkeeping in memory and
// writes the part that must survive a wake into the socket's attachment
// (serializeAttachment, at most 2 KB).
// ==========================================================================

import { hubOptions } from '../../hub.js';
import { GRAPHQL_URL } from './account.js';

export class WsConn {
  constructor(ws) {
    this.ws = ws;
    this.attAt = 0;        // when the attachment was last written
  }
  get readyState() { try { return this.ws.readyState; } catch { return 3; } }
  get bufferedAmount() { return 0; }   // unknown on Workers; the runtime buffers
  send(data) { this.ws.send(data); }
  close(code, reason) { this.ws.close(code, reason); }
  terminate() { try { this.ws.close(1011, 'stalled'); } catch {} }
}

// UTF-8 byte length without allocating (the limits are in bytes, as in Node).
export function utf8Bytes(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

// A state blob goes into the attachment only while it is small enough to
// keep the whole attachment far under 2 KB (V8 may store it two bytes a char).
const ATTACH_STATE_CHARS = 700;

export function attachmentOf(conn, room) {
  const seat = conn.uid && room ? room.players.get(conn.uid) : null;
  const own = seat && seat.ws === conn;
  let ls = null;
  if (own && seat.lastState) {
    try { const j = JSON.stringify(seat.lastState); if (j.length <= ATTACH_STATE_CHARS) ls = j; } catch {}
  }
  return {
    ip: String(conn.ip || 'unknown').slice(0, 64),
    o: conn.openedAt || 0,
    s: conn.seenAt || 0,
    m: conn.movedAt || 0,
    uid: own ? conn.uid : null,
    j: own ? seat.joinedAt : 0,
    a: own && room.authorityUid === conn.uid,
    ls,
  };
}

export function seatFrom(att) {
  if (!att || typeof att !== 'object') return null;
  let lastState = null;
  if (typeof att.ls === 'string') { try { lastState = JSON.parse(att.ls); } catch {} }
  return {
    ip: att.ip || 'unknown',
    openedAt: att.o, seenAt: att.s, movedAt: att.m,
    uid: att.uid || null, joinedAt: att.j, authority: !!att.a, lastState,
  };
}

// ------------------------------------------------------------- config ---
const num = (v, d) => {
  if (v === undefined || v === null || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

export function config(env = {}) {
  return {
    hub: {
      ...hubOptions(env),
      // a forgotten tab must not burn the month: 30 min without moving
      idleMs: num(env.IDLE_MS, 30 * 60 * 1000),
    },
    // the object's OWN caps for one billing cycle
    caps: { gbs: num(env.BUDGET_GBS, 50000), requests: num(env.BUDGET_REQUESTS, 300000) },
    cycleDay: num(env.CYCLE_DAY, 13),
    tailMs: num(env.AWAKE_TAIL_MS, 10000),
    flushMs: num(env.FLUSH_MS, 60000),
    // the optional account-wide guard (secret CF_ANALYTICS_TOKEN)
    account: {
      token: env.CF_ANALYTICS_TOKEN || '',
      id: env.CF_ACCOUNT_ID || '',
      url: env.GRAPHQL_URL || GRAPHQL_URL,
      limits: { gbs: num(env.ACCOUNT_GBS_LIMIT, 380000), requests: num(env.ACCOUNT_REQUESTS_LIMIT, 950000) },
      everyMs: num(env.ACCOUNT_CHECK_MS, 60 * 60 * 1000),
      // a failed check is retried this soon; this many failures in a row and
      // co-op closes (fail closed: unmeasured is not the same as cheap)
      retryMs: num(env.ACCOUNT_RETRY_MS, 2 * 60 * 1000),
      failsToClose: Math.max(1, num(env.ACCOUNT_FAILS_TO_CLOSE, 2)),
      timeoutMs: num(env.ACCOUNT_TIMEOUT_MS, 10000),
    },
    testRooms: env.TEST_ROOMS === '1',
  };
}
