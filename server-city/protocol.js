// ==========================================================================
// Wire protocol shared by the Among The City client (js/netcity.js) and this
// dedicated server. Every frame on the socket is a single JSON object with a
// `t` (type) field. Ported from ../AmongTheWoods/server/protocol.js — the
// shapes are kept identical so the two servers stay drop-in familiar; the
// city only actually uses HELLO / STATE / EVENT / PING / BYE today, but the
// meta/snap lanes cost nothing to keep and spare a future re-port.
// ==========================================================================

export const PROTOCOL_VERSION = 1;

// --------------------------------------------------------------- limits ----
// The server is PUBLIC and unauthenticated: anybody who can reach /ws can
// speak this protocol, so every lane needs a ceiling. Sizes are in BYTES of
// the raw inbound frame (checked before parsing costs anything) and are sized
// off what the real client sends: a 10 Hz state blob is ~200 B, an event
// ~120 B, HELLO ~90 B. The generous rounding leaves room for future fields
// without leaving room for a 1 MB blob that the relay would amplify ×20.
export const LIMITS = {
  payload: 64 * 1024,       // ws maxPayload — hard cap on any single frame
  hello: 1024,
  state: 4 * 1024,
  event: 4 * 1024,
  meta: 1024,
  snap: 64 * 1024,          // authority-only lane, unused by the v1 client
  // Client budget: 10 state/s + a ping every 25 s + a drained event outbox
  // (capped at 33 in netcity.js), so a legitimate firefight frame can spike to
  // ~45/s. The ceiling sits well above that and a socket is only KILLED after
  // three over-budget seconds in a row — a burst loses frames, a script loses
  // the socket.
  msgsPerSec: 120,
  bytesPerSec: 96 * 1024,
  overSecondsToKill: 3,
  bufferedBytes: 256 * 1024,      // slow reader: start DROPPING relayed frames
  bufferedHardBytes: 1024 * 1024, // stopped reader: kill the socket
  helloMs: 10000,           // a socket that never says hello is not a player
  uidLen: 40,
};

// Room meta the client may patch, with the type each key must have. `host`,
// `created` and anything unlisted are server-owned — a relay whose room meta
// any anonymous socket can rewrite is a griefing lane, not a feature.
export const META_PATCHABLE = { mode: 'string', state: 'string', seed: 'number' };

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
  // WELCOME carries peers TWICE on purpose: `peers` stays a plain uid array
  // (what the shipped client parses) and `peerStates` adds each peer's last
  // known state blob so a joiner can draw avatars on frame one instead of
  // waiting ~100 ms for everyone's next state packet. Additive: an old client
  // ignores the extra key, so client and server deploy independently.
  WELCOME: 'welcome', // { code, role:'authority'|'guest', uid, meta, peers:[uid], peerStates:[{uid,state}] }
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

// ------------------------------------------------------- transport helpers ---
// One writer for the whole server so the back-pressure rule is impossible to
// forget. ws.send() on a client that stopped reading buffers in OUR heap: 20
// stalled sockets × unbounded queue is how a relay dies. A backed-up peer
// loses relayed frames (all of which are superseded ~100 ms later anyway) and
// a truly wedged one gets terminated — the heartbeat would have reaped it too,
// only much later and after the damage.
export function sendRaw(ws, data) {
  if (!ws || ws.readyState !== 1) return false;
  const buffered = ws.bufferedAmount || 0;
  if (buffered > LIMITS.bufferedHardBytes) { try { ws.terminate(); } catch {} return false; }
  if (buffered > LIMITS.bufferedBytes) return false;
  try { ws.send(data); return true; } catch { return false; }
}
export function sendObj(ws, obj) { return sendRaw(ws, encode(obj)); }

// uids land in nametag textures and in every relayed frame, so keep them to a
// charset that can't smuggle markup or blow up a log line.
//
// THE COLON IS PART OF THE UID, NOT PUNCTUATION TO BE SCRUBBED. js/identity.js
// mints 'base:tab' — the base half persists in localStorage (it is what the
// player's look, colour and 'Hráč xxxx' stub are hashed from) and the tab half
// lives in sessionStorage (so two tabs are two bodies, not one re-seated uid).
// While ':' was stripped here the server handed back a uid nobody on the client
// could match:
//   · netcity.js compares PEER 'authority'.uid against its own localUid(), so
//     the comparison failed for everyone and the authority demoted itself to
//     'guest' one frame after WELCOME — which killed the late-joiner world
//     snapshot outright, because main.js only sends it when role === 'host';
//   · identity.baseUid() splits on ':', so with the colon gone a peer's "base"
//     was the WHOLE string: every player looked one colour to themselves and a
//     different one to everybody else (measured: 100 % of uids), which is the
//     exact bug identity.js exists to prevent.
// ':' is inert in markup, in a log line and in JSON, and 'u'+8 + ':' + 4 = 14
// characters sits far inside uidLen.
export function cleanUid(raw) {
  return String(raw == null ? '' : raw).replace(/[^A-Za-z0-9_:-]/g, '').slice(0, LIMITS.uidLen);
}

// A state/event/meta payload must be a plain JSON object. Arrays and scalars
// are rejected rather than coerced: everything downstream spreads them.
export function isPlainPayload(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The SNAP lane is the exception, and it had to be: the world snapshot the
// client sends is city.js's `hitLog`, which is an ARRAY of blast records, and
// the client's applyHits() refuses anything that is not one. Running snaps
// through isPlainPayload dropped every single one on the floor — silently, on
// the authority-only lane, so nothing anywhere reported it and late joiners
// simply never inherited the wreckage. Nothing here spreads the payload: the
// room stores it and relays it verbatim, and the size ceiling (LIMITS.snap) is
// enforced on the raw frame before it ever gets here.
export function isSnapPayload(v) {
  return !!v && typeof v === 'object';
}
