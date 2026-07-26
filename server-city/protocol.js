// ==========================================================================
// Wire protocol shared by the Among The City client (js/netcity.js) and this
// dedicated server. Every frame on the socket is a single JSON object with a
// `t` (type) field. Ported from ../AmongTheWoods/server/protocol.js — the
// shapes are kept identical so the two servers stay drop-in familiar; the
// city only actually uses HELLO / STATE / EVENT / PING / BYE today, but the
// meta/snap lanes cost nothing to keep and spare a future re-port.
// ==========================================================================

export const PROTOCOL_VERSION = 1;

export const MSG = {
  // ---- client -> server ----
  HELLO: 'hello',   // { uid, want:'join', code? }  (one shared room — code ignored)
  STATE: 'state',   // { state }   throttled own player-state blob
  EVENT: 'event',   // { ev }      one-shot gameplay event (rocket boom / …)
  SNAP:  'snap',    // { snap }    world snapshot (only the room authority sends)
  META:  'meta',    // { patch }   room-meta patch
  PING:  'ping',    // { }         heartbeat (server replies PONG)
  BYE:   'bye',     // { }         clean leave

  // ---- server -> client ----
  WELCOME: 'welcome', // { code, role:'authority'|'guest', uid, meta, peers:[uid] }
  META_UP: 'meta',    // { meta }              full meta after a change
  STATE_UP:'state',   // { from, state }       a peer's state blob
  EVENT_UP:'event',   // { ev }                an event addressed to this client
  SNAP_UP: 'snap',    // { snap }              latest world snapshot
  PEER:    'peer',    // { event:'join'|'leave'|'authority', uid }
  ERROR:   'error',   // { msg, fatal? }
  PONG:    'pong',    // { }
};

// A room's shared meta — same shape as the Woods server so clients written
// against either protocol read it without surprises.
export function freshMeta(mode, seed) {
  return {
    host: 'server',           // the neutral server owns the room (not a player)
    mode,                     // 'coop'
    seed,                     // shared world seed (the city map is static, kept for parity)
    state: 'waiting',
    created: Date.now(),
  };
}

// 4-char room codes — unused while everyone shares MAIN, kept for parity.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function genCode(rand = Math.random) {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
  return s;
}

export function encode(obj) { return JSON.stringify(obj); }
export function decode(buf) {
  try { return JSON.parse(typeof buf === 'string' ? buf : buf.toString('utf8')); }
  catch { return null; }
}
