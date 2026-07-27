// ---- CityNetWS + NetGame: the dedicated-server transport and what it shows ----
// Two layers in one module, both ported from AmongTheWoods rather than invented:
//
//   1. CityNetWS — a near-verbatim port of ../AmongTheWoods/js/netws.js (the
//      proven WS transport): connect/join the shared room, throttled sendState,
//      onPeerState, sendEvent/onEvent, peer join/leave, keepalive ping, and —
//      new — onClose/onStatus, so a session that dies mid-game is something the
//      UI layer can actually say out loud instead of a room that silently stops
//      moving. The protocol matches server-city/protocol.js. Renames only:
//      Woods→City and the uid key 'atw-uid'→'atc-uid' (now owned by identity.js).
//
//   2. NetGame — the game-facing orchestrator main.js drives with ONE call per
//      frame: net.update(dt, ctx). It sends our own state at ~10 Hz, renders
//      every remote player as a citizen (makeCitizen with the look identity.js
//      derives from their uid, so the same player is the same person on every
//      screen) with dead-reckoned interpolation, and relays rocket detonations
//      by POLLING weapons.live — a missile that leaves the list detonated at
//      its last seen position, so weapons.js needs no patch at all.
//
// Import-time safety: this file touches neither WebSocket nor the DOM until a
// connection is actually asked for, so importing it headless (node --check,
// tests, single player) is free. IMPORTANT for degradation: main.js only ever
// constructs a NetGame after the menu chose "Multiplayer" AND the socket is up.

import { SERVER_URL } from '../server-config.js';
import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE, WALK } from './config.js';
import { NameTags } from './nametags.js';
import { strHash, lookForUid, baseUid, localUid, shortId } from './identity.js';
import { setEpoch } from './worldclock.js';

const MSG = {
  HELLO: 'hello', STATE: 'state', EVENT: 'event', SNAP: 'snap', META: 'meta',
  PING: 'ping', BYE: 'bye',
  WELCOME: 'welcome', PEER: 'peer', ERROR: 'error', PONG: 'pong',
};

// the one shared world every "Multiplayer (server)" player lands in — the
// server ignores the code anyway (see server-city/index.js handleHello)
const SHARED_ROOM = 'PARDUBICE';

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function wsUrl() {
  if (!SERVER_URL) return null;
  return SERVER_URL.replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws';
}

// ==========================================================================
// layer 1 — the transport (netws.js port)
// ==========================================================================
export const CityNetWS = {
  role: null,          // 'host' (relay authority seat) | 'guest'
  code: null,
  partnerUid: null,
  peers: new Set(),    // every OTHER uid currently in the room
  _ws: null,
  _uid: null,
  _lastStateSend: 0,
  _ping: null,
  _left: false,        // leave() was called — a close after this is expected
  _handlers: { meta: null, peerState: null, event: null, snap: null, peer: null,
    close: null, status: null },

  // identity.js owns the uid now. It is 'base:tab' — the base half survives
  // across sessions (so a player keeps their look and their name), the tab half
  // does not (so two tabs of the same browser are two DIFFERENT players in the
  // room instead of one uid the relay keeps re-seating).
  uid() { return (this._uid ??= localUid()); },

  get online() { return !!(this._ws && this._ws.readyState === 1); },

  // open the socket and send HELLO; resolves with { code, meta } once WELCOME
  // arrives. want = 'create' | 'join' (the city server treats both the same).
  _connect(want, { code = null, mode = 'coop', seed = 1 } = {}) {
    const url = wsUrl();
    if (!url) return Promise.reject(new Error('No server configured.'));
    this._left = false;
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this._ws = ws;
      const failTimer = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch {} reject(new Error('Server did not respond.')); } }, 8000);

      ws.onopen = () => ws.send(JSON.stringify({ t: MSG.HELLO, uid: this.uid(), want, code, mode, seed }));

      ws.onmessage = (e) => {
        let m; try { m = JSON.parse(e.data); } catch { return; }
        if (!settled && m.t === MSG.WELCOME) {
          settled = true; clearTimeout(failTimer);
          // ADOPT THE ROOM'S CLOCK, before anything else in this branch. The
          // shared traffic schedule, the traffic lights and the time of day are
          // all pure functions of worldclock.worldT(), which until now was this
          // machine's own Date.now(): two players agreed about the city only as
          // far as their two operating systems agreed about the time. Measured
          // against the real schedule, one second of skew is 16.8 m of average
          // disagreement per car and 643 m at worst — i.e. "we don't see the
          // same cars" with no bug anywhere in the traffic code.
          this._syncClock(m.now);
          this.code = m.code;
          this.role = m.role === 'authority' ? 'host' : 'guest';
          this.peers = new Set(Array.isArray(m.peers) ? m.peers : []);
          if (this.peers.size) this.partnerUid = [...this.peers][0];
          this._startPing();
          this._emitStatus();
          resolve({ code: m.code, meta: m.meta });
          return;
        }
        if (!settled && m.t === MSG.ERROR) {
          settled = true; clearTimeout(failTimer);
          try { ws.close(); } catch {}
          reject(new Error(m.msg || 'Server refused the connection.'));
          return;
        }
        this._dispatch(m);
      };

      ws.onerror = () => { if (!settled) { settled = true; clearTimeout(failTimer); reject(new Error("Can't reach the server.")); } };

      // A close BEFORE the join settles rejects the connect promise — that path
      // is unchanged. A close AFTER it used to do nothing but stop the ping, so
      // co-op simply died in silence: peers frozen in the street, the HUD still
      // claiming N players online, and no way for the UI to know. Now the room
      // is torn down properly (every avatar dropped through the same peerState
      // null path a real leave uses) and onClose/onStatus fire.
      ws.onclose = (e) => {
        this._stopPing();
        if (!settled) {
          settled = true; clearTimeout(failTimer);
          reject(new Error('Server connection closed.'));
          return;
        }
        if (this._ws !== ws) return;    // a socket we already replaced
        this._ws = null;
        const gone = [...this.peers];
        this.peers = new Set();
        this.partnerUid = null;
        for (const uid of gone) { try { this._handlers.peerState?.(uid, null); } catch {} }
        this._emitStatus();
        this._handlers.close?.({
          code: e?.code ?? 0, reason: e?.reason ?? '',
          clean: !!e?.wasClean, expected: this._left,
        });
      };
    });
  },

  _dispatch(m) {
    switch (m.t) {
      case MSG.META:  this._handlers.meta?.(m.meta); break;
      case MSG.STATE: this._handlers.peerState?.(m.from, m.state); break;
      case MSG.EVENT: this._handlers.event?.(m.ev); break;
      case MSG.SNAP:  this._handlers.snap?.(m.snap); break;
      case MSG.PONG: this._syncClock(m.now, m.ts); break;
      case MSG.PEER:
        if (m.event === 'join') { this.peers.add(m.uid); this.partnerUid ??= m.uid; }
        else if (m.event === 'leave') {
          this.peers.delete(m.uid);
          if (m.uid === this.partnerUid) this.partnerUid = [...this.peers][0] ?? null;
          this._handlers.peerState?.(m.uid, null); // their avatar goes away
        }
        else if (m.event === 'authority') this.role = (m.uid === this.uid()) ? 'host' : 'guest';
        this._emitStatus();
        this._handlers.peer?.(m);
        break;
      default: break;
    }
  },

  _emitStatus() {
    this._handlers.status?.({ online: this.online, count: this.peers.size, uids: [...this.peers] });
  },

  // Feed a server timestamp to the world clock. `sentAt` is the Date.now() we
  // stamped on the PING the server is answering, so the full round trip is
  // measurable and setEpoch can subtract half of it; WELCOME has no such stamp
  // and is accepted unmeasured (setEpoch keeps whichever sample has the lowest
  // rtt, and an unmeasured one can never displace a measured one). A server
  // that predates this field sends nothing and we stay on our own clock, which
  // is exactly the behaviour of yesterday's build.
  _syncClock(serverNowMs, sentAt = null) {
    if (!Number.isFinite(serverNowMs)) return;
    const rtt = Number.isFinite(sentAt) ? Math.max(0, Date.now() - sentAt) : null;
    try { setEpoch(serverNowMs, rtt); } catch {}
  },

  // The heartbeat doubles as the clock sample — no extra traffic, and 25 s is
  // often enough to correct any drift the two machines pick up in a session.
  // The first one is sent immediately: waiting 25 s for a measured sample when
  // WELCOME's unmeasured one is already in force is 25 s of avoidable bias.
  _pingOnce() { this._send({ t: MSG.PING, ts: Date.now() }); },
  _startPing() { this._stopPing(); this._pingOnce(); this._ping = setInterval(() => this._pingOnce(), 25000); },
  _stopPing() { if (this._ping) { clearInterval(this._ping); this._ping = null; } },
  _send(obj) { const ws = this._ws; if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify(obj)); } catch {} } },

  // ---- WoodsNet-shaped API (kept whole so a future port stays a swap) ----
  async createGame(mode = 'coop') { const r = await this._connect('create', { mode }); return { code: r.code, meta: r.meta }; },
  async joinGame(code) {
    code = String(code || '').trim().toUpperCase();
    const r = await this._connect('join', { code });
    this.partnerUid = this.partnerUid || 'server';
    return r.meta;
  },
  // city entry point: everyone shares the one Pardubice room
  async joinShared() { return this.joinGame(SHARED_ROOM); },

  onMeta(fn) { this._handlers.meta = fn; },
  updateMeta(patch) { this._send({ t: MSG.META, patch }); return Promise.resolve(); },

  sendState(state, minMs = 100) {
    const now = nowMs();
    if (now - this._lastStateSend < minMs) return;
    this._lastStateSend = now;
    this._send({ t: MSG.STATE, state });
  },
  onPeerState(fn) { this._handlers.peerState = fn; },
  setPartner(uid) { this.partnerUid = uid; },

  // toUid: server routes the event to that ONE player; omitted = broadcast
  sendEvent(obj, toUid = null) {
    const clean = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) clean[k] = v;
    this._send({ t: MSG.EVENT, ev: clean, ...(toUid ? { to: toUid } : {}) });
  },
  onEvent(fn) { this._handlers.event = fn; },

  sendSnap(snap) { this._send({ t: MSG.SNAP, snap }); },
  onSnap(fn) { this._handlers.snap = fn; },

  onPeer(fn) { this._handlers.peer = fn; },
  // fn({ code, reason, clean, expected }) — the socket went away. `expected`
  // is true only when leave() asked for it, so the UI can stay quiet on a
  // deliberate exit and shout on a real drop.
  onClose(fn) { this._handlers.close = fn; },
  // fn({ online, count, uids }) — every membership change, plus WELCOME.
  onStatus(fn) { this._handlers.status = fn; },
  becomeHost() { /* server-driven; role flips on the PEER 'authority' message */ return Promise.resolve(); },

  leave() {
    this._left = true;
    this._stopPing();
    this._send({ t: MSG.BYE });
    try { this._ws?.close(); } catch {}
    this._ws = null; this.role = null; this.code = null; this.partnerUid = null;
    this.peers = new Set();
    this._handlers = { meta: null, peerState: null, event: null, snap: null, peer: null,
      close: null, status: null };
  },
};

// ==========================================================================
// layer 2 — the game-facing session
// ==========================================================================

// Outbound one-shot events. Module-level so ANY module can queue without
// holding the NetGame instance; capped so single player (nobody draining)
// can never grow it. NetGame.update drains it into sendEvent each frame.
const _outbox = [];
export function queueEvent(type, data) {
  if (_outbox.length > 32) _outbox.length = 0;   // nobody listening — drop, don't leak
  _outbox.push({ type, ...(data || {}) });
}

// ---- nickname ----
// Same rule as AmongTheWoods: strip anything that could become markup, trim,
// 14 characters. Applied TWICE — once here on the way out, once again on every
// packet that comes back in — because the wire is not a trusted source and the
// string ends up in a canvas (and, one day, maybe a DOM chat line).
//
// The class also drops every character that renders as NOTHING (U+200B,
// U+3164, U+2800, the C0/C1 controls …) or reverses the text after it (U+202E).
// String.trim() knows none of those, so a hand-rolled client could otherwise
// wear a blank or a text-reversing nameplate no matter what the menu accepted —
// which is exactly why the filter runs again HERE and not only there. Keep this
// body identical to menu.sanitizeName and nametags.clean.
const STRIP = /[<>&"'`\u0000-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B\u200C\u200E\u200F\u2028\u2029\u202A-\u202E\u2060-\u206F\u2800\u3164\uFEFF\uFFA0\uFFF9-\uFFFC\u{1D173}-\u{1D17A}\u{E0000}-\u{E007F}]/gu;
// …and the backstop for every blank NOBODY has enumerated yet. Naming the
// characters one at a time is whack-a-mole: the first version of this list
// caught U+200B and U+3164 and still waved through U+034F (combining grapheme
// joiner), U+17B5 (Khmer inherent vowel), U+FE0F (variation selector) and the
// whole U+E00xx tag block — every one of them a perfectly empty nameplate,
// verified against the shipped function. So the rule is also stated
// positively: a nickname must contain at least one character that puts INK on
// the canvas — not whitespace, not a combining mark, not a format control, not
// a surrogate, not private-use, not unassigned. U+200D (ZWJ) and the variation
// selectors deliberately survive the strip above, so a family emoji stays one
// glyph and a thumbs-up keeps its colour; both are format/mark characters, so
// a name made of nothing but them is still refused right here.
const INK = /[^\s\p{Mn}\p{Me}\p{Cf}\p{Cc}\p{Cs}\p{Cn}\p{Co}]/u;
export function sanitizeName(s) {
  const n = String(s ?? '').replace(STRIP, '').trim().slice(0, 14).trim();
  return INK.test(n) ? n : '';
}

// Module-level, not a NetGame field: main.js knows the nickname the moment the
// menu resolves, which is BEFORE the socket (and therefore the NetGame) exists.
let _myName = '';
function setMyName(name) { return (_myName = sanitizeName(name)); }
export { setMyName as setPlayerName };
export function getPlayerName() { return _myName; }

const SEND_S = 0.1;         // own state at ~10 Hz
const REAP_MS = 30000;      // a peer silent this long crashed — reap the avatar
                            // (30 s, not less: a backgrounded tab also goes quiet)
const TAU = Math.PI * 2;

// ---- dead reckoning ----
// A 10 Hz sampler, one send window and half an RTT stack up to well over a
// tenth of a second of staleness; at 25 m/s that is a car six metres behind
// where it really is, which is a car parked inside the one behind it. So the
// sender differentiates its own position and ships vx/vz, and the receiver
// aims at last + v·age instead of at a position it knows is old.
const LEAD_S = SEND_S / 2;  // the packet was already half a window old when made
const EXTRAP_MAX_S = 0.5;   // never coast further than this on a stale packet:
                            // a peer whose tab froze must STOP, not fly to Brno
const MAX_V = 120;          // m/s — anything above is a teleport, not a speed

// ---- how far away a peer still gets a BODY ----
// This used to be a flat 240 m with a comment calling it "deliberately wider
// than NameTags' own 120 m cutoff". NameTags' cutoff has not been 120 m for a
// while: it defaults to 400 m and the settings panel offers 2 km. So at the
// DEFAULT setting a peer standing 300 m away was a nickname hovering over an
// empty street — measured, not guessed — and on "Přes celé město" the tag
// outran the body over 88 % of its range. A floating name with nobody under it
// is a worse bug than a body you can barely see, so the build radius follows
// the tag radius (with the same hysteresis band, and never smaller than the
// 240 m it used to be). MAX_PLAYERS is 20, so the ceiling on this is 20 citizen
// groups — a rounding error next to a street of pedestrians.
const SEE_MIN = 240;
const SEE_BAND = 20;    // m of hysteresis, so somebody on the boundary does not strobe

// Beyond this the newest packet is not a step, it is a different place: a
// respawn, a train ride, a tile stream-in. Lerping across it drags the avatar
// through 400 m of buildings at walking pace. Woods uses the same 20 m.
const SNAP_D2 = 20 * 20;

// ---- interest management ----
// Building a citizen for someone across the map costs a group of nine meshes
// that then casts shadows nobody can see. Build lazily at SEE_IN, and once
// built toggle .visible with hysteresis so a peer jogging along the boundary
// does not strobe. Deliberately wider than NameTags' own 120 m cutoff.


// Where the nickname floats, in metres above the avatar's feet (or above the
// seat anchor when they are riding). A citizen's hair tops out at 1.75 m in
// model space and netcity scales the whole figure by PLAYER_SCALE, so this
// clears the head by a hand's width no matter what PLAYER_SCALE becomes.
const TAG_HEAD_H = 1.75 * PLAYER_SCALE + 0.22;
const TAG_VEH_H = 2.1;   // fallback when we never found their real seat

// player.js:63 owns this number and does not export it. Seat anchors give the
// CUSHION TOP; a citizen group's origin is its FEET, so a rider has to drop
// this far to sit on the cushion instead of standing with their head through
// the headliner. Duplicated here rather than imported because netcity does not
// own player.js — if that constant moves, this one has to move with it.
const SIT_DROP = 0.78 * PLAYER_SCALE;

// approximate vehicle identity for v1: colour+kind hash. Two clients seeing
// "the same" stolen Škoda agree often enough for a name tag / seat lookup.
export function vehId(car) {
  return strHash((car.kind ?? 'car') + ':' + (car.color ?? 0));
}

// Duck tests, one per machine class, and they must be asked in this order:
// a Fighter has `throttle` and no `rotorSpeed`, a Helicopter has `rotorSpeed`,
// a car has neither. Keep them identical to player.js's pair — that module
// picks the seat anchor with the same three questions, and the day they
// disagree a pilot sits on the wing.
const isHeli = (v) => v && v.rotorSpeed !== undefined;   // ducks, quacks, hovers
const isJet = (v) => v && v.throttle !== undefined && v.reheat !== undefined;

class NetGame {
  constructor(net) {
    this.net = net;
    this.remotes = new Map();     // uid -> remote avatar record
    // ---- SIBLING HOOK (seating) ----
    // (uid, veh, remote) → { x, y, z, heading? } | null, where x/y/z is the
    // WORLD-space cushion top of the seat the peer says they are in. main.js
    // fills this with its own resolver; netvehicles.js (ghost cars) can chain
    // in front of it. There is no window.__atc fallback any more and there must
    // not be one: __atc.seatAnchor is player.js's worldSeatAnchor(veh, i), which
    // wants a live VEHICLE OBJECT. Handing it the wire descriptor made veh.x
    // undefined, undefined + a.x·c = NaN, position.set(NaN) — and a mesh with a
    // NaN matrix stops rasterising, which is why a friend in a car used to be
    // a name tag flying down the street with no body under it.
    this.onRemoteVehicle = null;
    this.tags = new NameTags(null);   // scene arrives with the first update()
    this.showNames = true;
    this._scene = null;
    this._sendAt = -1e9;          // ms of the last state packet (wall clock)
    this._lastSent = null;        // { t, x, z } — our own velocity is differentiated
    this._weapons = null;         // the pod we are subscribed to…
    this._unwatch = null;         // …and how to let go of it
    this._inbox = [];             // peer events, applied in update (ctx needed)
    this._onClose = null;
    this._onStatus = null;
    net.onPeerState((uid, s) => this._peerState(uid, s));
    net.onEvent((ev) => { if (this._inbox.length < 64) this._inbox.push(ev); });
    net.onClose((info) => this._onClose?.(info));
    net.onStatus(() => this._emitStatus());
  }

  get uid() { return this.net.uid(); }
  get peers() { return this.net.peers; }
  get online() { return this.net.online; }

  // ---- UI hooks (netui.js) ----
  // fn({ code, reason, clean, expected }) — the session ended.
  onClose(fn) { this._onClose = fn; }
  // fn({ online, count, names }) — membership or a nickname changed. Fires
  // immediately on registration so the HUD never starts out lying.
  onStatus(fn) { this._onStatus = fn; this._emitStatus(); }
  _emitStatus() {
    if (!this._onStatus) return;
    const uids = [...this.net.peers];
    this._onStatus({
      online: this.net.online,
      count: uids.length,
      // RECORDS, not bare strings, and netui has always been able to take them
      // (rosterOf keys on uid when it gets objects and on the NAME when it gets
      // strings). Keying on the name had three consequences, all of them things
      // a player sees: every join printed TWO toasts, because WELCOME carries
      // uids and the nickname arrives one packet later — "Hráč 4f2a se
      // připojil" and then "…je teď Bondy"; two players sharing a nickname
      // collapsed into one roster key, so the second got no join toast and the
      // first got no leave toast; and the colour swatch beside the toast was
      // dead code, since `color` was always null. The jacket comes from the
      // same lookForUid(baseUid(...)) that dresses the body, so the square next
      // to the name is the person you are looking for on the street.
      names: uids.map((u) => ({
        uid: u,
        name: this.remotes.get(u)?.name || fallbackName(u),
        color: lookForUid(baseUid(u)).jacket,
      })),
    });
  }

  // ---- inbound ----
  _peerState(uid, s) {
    // null is OUR OWN leave signal (see _dispatch / onclose) — drop the avatar.
    if (s === null) { this._drop(uid); return; }
    // Anything else has to look like a state before it is allowed to touch a
    // record. A `{t:'state'}` with no `state` field used to be a TypeError on
    // s.x for a peer we had not seen, and for one we had it still stamped
    // lastSeen — which is worse than the crash, because the reap timer then
    // never fires and the avatar stands in the street until the tab closes.
    if (typeof s !== 'object' || !Number.isFinite(s.x) || !Number.isFinite(s.z)) return;

    let r = this.remotes.get(uid);
    if (!r) {
      // WELCOME carries uids only, never nicknames, so a player who joins a
      // busy room knows nobody until each of them sends a STATE (≤100 ms).
      // Until then wear a scrap of the uid rather than a blank tag.
      r = { uid, cit: null, state: null, lastSeen: 0, name: fallbackName(uid),
        // ix/iy/iz/ih is the SMOOTHED state we integrate; x/y/z/h is where the
        // avatar was actually drawn this frame. They differ whenever a seat
        // anchor wins, and everything outside this module (name tags, minimap,
        // world map) must read the drawn one — a tag on the interpolated one
        // is the tag that tears loose and floats beside a moving car.
        ix: s.x, iy: s.y ?? 0, iz: s.z, ih: s.h ?? 0,
        x: s.x, y: s.y ?? 0, z: s.z, h: s.h ?? 0,
        tagY: (s.y ?? 0) + TAG_HEAD_H,   // sane until the first _updateRemotes
        speed: 0, walkT: 0, seated: false, near: false };
      this.remotes.set(uid, r);
    }
    // re-sanitize: this string came off the wire and is headed for a texture
    if (typeof s.nm === 'string') {
      const nm = sanitizeName(s.nm);
      if (nm && nm !== r.name) { r.name = nm; this._emitStatus(); }
    }
    r.state = s;
    r.lastSeen = nowMs();
  }

  // the nickname of a connected peer, or '' — for HUD/kill-feed callers that
  // want a name without walking `remotes` themselves
  peerName(uid) { return this.remotes.get(uid)?.name ?? ''; }

  // [{ uid, name, x, z, color }] — the shape worldMap/minimap take for peers.
  // Built off the DRAWN position, same as the name tags.
  peerList() {
    const out = [];
    for (const r of this.remotes.values()) {
      if (!r.state) continue;
      out.push({ uid: r.uid, name: r.name, x: r.x, z: r.z, color: lookForUid(baseUid(r.uid)).jacket });
    }
    return out;
  }

  _drop(uid) {
    const r = this.remotes.get(uid);
    if (!r) return;
    // dispose(), not scene.remove(). citizen.js says so in as many words: the
    // remove-and-stop version leaves eleven meshes hanging off the group, and
    // anything still holding the record keeps that whole subtree resident.
    // player.js:461 already does it this way for the local body; the network
    // path did not, which made the two ends of the same object asymmetric — and
    // it is the network path that runs twenty times an hour on a public server.
    // dispose() detaches itself, so the _scene guard is gone with it.
    r.cit?.dispose?.();
    this.tags.remove(uid);      // sprite + material + its share of the texture
    this.remotes.delete(uid);
    this._emitStatus();
  }

  // ---- outbound: the rocket pod, through its own seam ----
  // This used to POLL weapons.live and infer a blast from a missile that had
  // left the array. Two things were wrong with that and both are visible in
  // game. It is a whole frame LATE — at 210 m/s that is 3.5 m of flight at
  // 60 fps and 10 m on a throttled tab, so the peer demolished a neighbouring
  // wall. And an inferred blast has no IDENTITY, so the same explosion arriving
  // twice (live now, and again inside the authority's snapshot when somebody
  // joins) wrecked the building twice.
  //
  // weapons.js grew the seam for exactly this: onDetonate fires synchronously
  // from inside the blast, carries the city's own `id`, and — the part that
  // makes it safe to subscribe — is NOT fired for a blast replayed with
  // {remote:true}, so a relayed explosion cannot bounce back onto the wire and
  // round the room forever. Subscribed once per weapons instance, and the
  // unsubscribe is kept so dispose() lets go.
  _watchWeapons(weapons) {
    if (!weapons || weapons === this._weapons) return;
    this._unwatch?.();
    this._weapons = weapons;
    this._unwatch = weapons.onDetonate?.((h) => queueEvent('boom', {
      x: +h.x.toFixed(1), y: +h.y.toFixed(1), z: +h.z.toFixed(1),
      ...(Number.isFinite(h.r) ? { r: +h.r.toFixed(1) } : {}),
      ...(h.id ? { id: h.id } : {}),
    })) ?? null;
  }

  // a peer's rocket goes off in OUR world too: same blast FX, same demolition,
  // resolved locally by the very method the pod itself uses. b=null makes
  // damageBuilding find every building the sphere touches — identical to a
  // ground/airburst hit, so approximate positions still wreck the right wall.
  _applyEvent(ev, ctx) {
    if (ev.type === 'boom' && ctx.weapons
        && Number.isFinite(ev.x) && Number.isFinite(ev.y) && Number.isFinite(ev.z)) {
      // {remote:true} is not a nicety. Without it weapons.js treats a peer's
      // rocket as our own: it SHAKES OUR CAMERA (somebody three kilometres away
      // rattling the pilot's teeth) and plays the flat mono report at full
      // volume in the headphones whatever the distance. And `id` is what makes
      // the same blast idempotent — it arrives live now and again inside the
      // authority's snapshot the next time somebody joins, and city.applyHit
      // de-dupes on exactly this field.
      ctx.weapons.detonate(ev.x, ev.y, ev.z, null,
        { cars: ctx.cars, peds: ctx.peds },
        { remote: true, ...(ev.id ? { id: ev.id } : {}) });
    }
  }

  // ---- the vehicle descriptor (the wire contract) ----
  // veh = { k:'car'|'heli'|'train', kd:<kind>, cl:<int>, x, z, h, sp, st:<seat> }
  //
  // Derived from player.inCar, NOT from game.car/game.heli. game.car is only
  // ever set for the DRIVER, so a front passenger used to send veh:null with
  // s = the car's speed — and every other client dutifully ran his little legs
  // along the tarmac at 100 km/h beside the car he was sitting in.
  //
  // A train ride is a third thing: trains own the rider outright and leave
  // player.inCar null, so it never appeared in the protocol at all and a
  // commuter looked like a man sprinting down the rails.
  _vehDesc(ctx) {
    const p = ctx.player;
    if (!p) return null;

    // ctx.trains would be better than the global; main.js does not put it in
    // the context yet, and window.__atc is the same fallback the camera uses.
    const trains = ctx.trains ?? (typeof window !== 'undefined' ? window.__atc?.trains : null);
    const t = trains?.riding;
    if (t) {
      const m = t.cars?.[0]?.mesh;
      return {
        k: 'train', kd: 'train', cl: 0,
        x: +num(m?.position.x, p.pos.x).toFixed(2),
        z: +num(m?.position.z, p.pos.z).toFixed(2),
        h: +num(m?.rotation.y, p.heading).toFixed(3),
        sp: +num(t.speed, 0).toFixed(2),
        st: 0, seat: 0,
      };
    }

    const v = p.inCar;
    if (!v) return null;
    const seat = p.seat ?? 0;
    // Three machine classes, and the duck test has to name all three. Before
    // this it named one: anything without `rotorSpeed` was a CAR, so a Gripen
    // at 8 km and 600 km/h went on the wire as k:'car' with kd:'car'. Every
    // other client then built a black Octavia, snapped it to the road surface
    // (a car sends no y — the road decides it), teleported it ~69 m per packet,
    // and fed it to traffic.actors as a 3.9 m obstacle: every AI car under the
    // flight path stood on the brakes for a fighter jet.
    const k = isJet(v) ? 'jet' : isHeli(v) ? 'heli' : 'car';
    const flying = k !== 'car';
    return {
      k,
      kd: v.kind ?? k,
      cl: v.color ?? 0,
      x: +num(v.x, p.pos.x).toFixed(2),
      z: +num(v.z, p.pos.z).toFixed(2),
      // ALTITUDE. A car derives y from the road under it, so it does not send
      // one; an aircraft must, or the ghost flies along y = 0 and the seat
      // anchor built on it drags the pilot's avatar through the riverbed.
      // (main.js used to patch this back in from state.y — that patch is now a
      // no-op, which is what it said it wanted to become.)
      ...(flying ? { y: +num(v.y, p.y ?? 0).toFixed(2) } : {}),
      h: +num(v.heading, p.heading).toFixed(3),
      // The helicopter has no scalar speed at all, so this used to ship a flat
      // zero for every flight — which switches OFF the receiver's dead
      // reckoning (netvehicles extrapolates last + v·age) and leaves the ghost
      // hanging metres behind its pilot. Ground speed is the number that
      // extrapolation wants.
      sp: +(Number.isFinite(v.speed) ? v.speed
        : Math.hypot(num(v.vx, 0), num(v.vz, 0))).toFixed(2),
      st: seat,
    };
  }

  // ---- own state, ~10 Hz ----
  // { x,y,z, h(eading), s(peed), vx,vz, wt(walkT), veh|null, nm } — the whole
  // v1 protocol. player.pos mirrors the car/heli while inside, so position is
  // always just player state and veh only adds "and I'm sitting in this". `nm`
  // rides INSIDE state on purpose: the relay treats state as an opaque blob it
  // re-broadcasts untouched (server-city/room.js onState), so the nickname
  // needs no server change — whereas HELLO is parsed field by field and would
  // have needed a redeploy. The same is true of the fatter `veh`: it is inside
  // the blob, so no relay redeploy for that either.
  _sendState(ctx, t = nowMs()) {
    const p = ctx.player;
    const x = +p.pos.x.toFixed(2), y = +(p.y ?? 0).toFixed(2), z = +p.pos.z.toFixed(2);

    // Velocity by differentiating the position we actually SENT, not by reading
    // speed·heading: that would be wrong for anything that moves sideways (a
    // helicopter drifting, a passenger in a car that is spinning, a train).
    let vx = 0, vz = 0;
    const prev = this._lastSent;
    if (prev) {
      const dts = (t - prev.t) / 1000;
      // A window this side of sane only. A backgrounded tab hands us a ten
      // second gap, and dividing a legitimate 400 m by it is a velocity that
      // then gets extrapolated into the next district.
      if (dts > 0.02 && dts < 0.35) {
        vx = (x - prev.x) / dts; vz = (z - prev.z) / dts;
        const sp2 = vx * vx + vz * vz;
        if (sp2 > MAX_V * MAX_V) { const c = MAX_V / Math.sqrt(sp2); vx *= c; vz *= c; }
      }
    }
    this._lastSent = { t, x, z };

    this.net.sendState({
      x, y, z,
      h: +num(p.heading, 0).toFixed(3),
      // num() and not p.speed.toFixed: a vehicle class without a scalar speed
      // (the helicopter has vx/vy/vz and nothing else) used to make this line
      // throw from inside stepGame — which killed the render for the rest of
      // the session. player.js now always fills a finite speed; this is the
      // belt to that pair of braces, because a state packet is not worth a
      // crash under any circumstances.
      s: +num(p.speed, 0).toFixed(2),
      vx: +vx.toFixed(2), vz: +vz.toFixed(2),
      wt: +(p.walkT % TAU).toFixed(2),
      veh: this._vehDesc(ctx),
      ...(_myName ? { nm: _myName } : {}),
    }, 0);   // our own 10 Hz gate already throttled; don't double-gate
  }

  // main.js may also set the nickname through the session it already holds
  setPlayerName(name) { return setMyName(name); }

  // ---- remote avatars: extrapolate, then ease toward the target ----
  _updateRemotes(dt, ctx) {
    const now = nowMs();
    const k = Math.min(1, dt * 8);
    // our own eye, for interest management. The camera is the honest origin
    // when there is no player yet (a headless pump), and 0,0 when there is
    // neither — which simply means nothing is near and nothing gets built.
    const ox = num(ctx?.player?.pos?.x, num(ctx?.camera?.position?.x, 0));
    const oz = num(ctx?.player?.pos?.z, num(ctx?.camera?.position?.z, 0));

    for (const [uid, r] of this.remotes) {
      // Reap FIRST. It used to sit behind `if (!s) continue`, so a record that
      // never got a valid packet — or one whose peer vanished before the first
      // one — could never time out, and its avatar stood there forever.
      if (now - r.lastSeen > REAP_MS) { this._drop(uid); continue; }
      const s = r.state;
      if (!s) continue;

      // ---- dead-reckoned target ----
      const age = Math.min(EXTRAP_MAX_S, (now - r.lastSeen) / 1000 + LEAD_S);
      const tx = s.x + (Number.isFinite(s.vx) ? s.vx : 0) * age;
      const tz = s.z + (Number.isFinite(s.vz) ? s.vz : 0) * age;
      const ty = Number.isFinite(s.y) ? s.y : 0;
      const th = Number.isFinite(s.h) ? s.h : 0;

      const ddx = tx - r.ix, ddy = ty - r.iy, ddz = tz - r.iz;
      if (ddx * ddx + ddy * ddy + ddz * ddz > SNAP_D2) {
        // a respawn, a train boarding, a tile that just streamed in — teleport
        r.ix = tx; r.iy = ty; r.iz = tz; r.ih = th;
      } else {
        r.ix += ddx * k; r.iy += ddy * k; r.iz += ddz * k;
        // heading: shortest arc, slightly quicker so turns lead the body
        let dh = th - r.ih;
        dh = Math.atan2(Math.sin(dh), Math.cos(dh));
        r.ih += dh * Math.min(1, dt * 10);
      }

      // ---- interest management, BEFORE any of the expensive work ----
      // The gate is deliberately the first thing after the interpolation: the
      // seat resolver is a linear scan of every parked and moving car in the
      // district, and running it every frame for a peer 5 km away is pure
      // waste. Hysteresis on the band so somebody jogging along the boundary
      // does not strobe in and out.
      const dx0 = r.ix - ox, dz0 = r.iz - oz;
      const d2 = dx0 * dx0 + dz0 * dz0;
      const seeIn = Math.max(SEE_MIN, this.showNames ? (this.tags.opt.maxDist || 0) : 0);
      const seeOut = seeIn + SEE_BAND;
      r.near = r.near ? d2 < seeOut * seeOut : d2 < seeIn * seeIn;
      if (!r.near) {
        // still tracked and still public (the world map draws a dot for a peer
        // across town) — just not built, not posed and not casting a shadow
        r.x = r.ix; r.y = r.iy; r.z = r.iz; r.h = r.ih;
        r.tagY = r.iy + TAG_HEAD_H;
        if (r.cit) r.cit.group.visible = false;
        continue;
      }

      // ---- where the body actually goes this frame ----
      let px = r.ix, py = r.iy, pz = r.iz, ph = r.ih;
      let seated = false, tagY = py + TAG_HEAD_H;
      if (s.veh) {
        seated = true;
        const a = this.onRemoteVehicle?.(uid, s.veh, r);
        // Every component checked: one NaN in a seat anchor poisons the whole
        // matrix and the avatar stops being rendered at all, silently.
        if (a && Number.isFinite(a.x) && Number.isFinite(a.y) && Number.isFinite(a.z)) {
          px = a.x; py = a.y - SIT_DROP; pz = a.z;
          if (Number.isFinite(a.heading)) ph = a.heading;
          // clear the roofline AND the head, whichever is higher
          tagY = Math.max(a.y + 1.0, py + TAG_HEAD_H);
        } else {
          // their car has not streamed in on our side; they stay at the
          // position they reported (which already mirrors the vehicle)
          tagY = py + TAG_VEH_H;
        }
      }
      // the DRAWN pose is the public one — name tags and maps read these
      r.x = px; r.y = py; r.z = pz; r.h = ph; r.tagY = tagY;

      if (!r.cit) {
        // built lazily, the first frame they are worth drawing. The record has
        // been interpolating all along, so they appear where they belong
        // instead of sliding in from wherever the last owner of the record was.
        if (!this._scene) continue;
        r.cit = makeCitizen(lookForUid(baseUid(uid)));
        r.cit.group.scale.setScalar(PLAYER_SCALE);
        this._scene.add(r.cit.group);
      }
      r.cit.group.position.set(px, py, pz);
      r.cit.group.rotation.y = ph;
      r.cit.group.visible = true;

      if (seated) {
        // citizen.js has had sitPose since the boarding work landed and the net
        // layer never called it, so every passenger rode bolt upright with his
        // head through the roof. walk() only drives rotation.x, so the fold has
        // to be undone by standPose() on the way out or the splay survives.
        if (!r.seated) { r.seated = true; r.cit.sitPose(1); }
        r.speed = 0;
      } else {
        if (r.seated) { r.seated = false; r.cit.standPose(); }
        // stride phase advances with the reported speed, eased so a stale
        // packet winds the legs down instead of freezing them mid-swing
        r.speed += (num(s.s, 0) - r.speed) * k;
        r.walkT = (r.walkT + r.speed * dt * 1.6) % TAU;
        // …and is pulled onto the phase the OWNER is at, shortest arc, so two
        // screens show the same foot forward instead of drifting apart over a
        // minute of jogging. This is what `wt` is for; it was being sent and
        // thrown away.
        if (Number.isFinite(s.wt)) {
          let dp = s.wt - r.walkT;
          dp = Math.atan2(Math.sin(dp), Math.cos(dp));
          r.walkT += dp * Math.min(1, dt * 3);
        }
        r.cit.walk(r.walkT, Math.min(1.25, r.speed / WALK.jog));
      }
    }
  }

  // ---- the one per-frame call main.js makes ----
  // ctx = { scene, player, game, weapons, world, cars, peds, camera?, trains? }
  update(dt, ctx) {
    this._scene = ctx.scene;
    this._watchWeapons(ctx.weapons);
    while (_outbox.length) this.net.sendEvent(_outbox.shift());
    while (this._inbox.length) this._applyEvent(this._inbox.shift(), ctx);
    // Own state on a WALL CLOCK, not on a dt accumulator. The accumulator this
    // replaces did `this._sendT = SEND_S` after firing, which throws the
    // overshoot away and makes the real period SEND_S + one frame — ~7.7 Hz at
    // 60 fps and worse the slower the machine, i.e. a rate that quietly depends
    // on the sender's frame time. Switching that to `-=` fixes the drift and
    // buys a burst instead: a backgrounded tab comes back owing hundreds of
    // periods. A clock has neither problem, and it is what netws.js's own
    // minMs gate does one layer down.
    const tNow = nowMs();
    if (ctx.player && tNow - this._sendAt >= SEND_S * 1000) {
      this._sendAt = tNow;
      this._sendState(ctx, tNow);
    }
    this._updateRemotes(dt, ctx);
    // Name tags after the avatars moved, so a tag never trails its owner by a
    // frame. The camera is not in ctx today; __atc.camera is the fallback, and
    // ctx.camera wins the day main.js passes one. No camera at all (a headless
    // pump) simply draws no tags.
    this.tags.enabled = this.showNames;
    this.tags.scene = ctx.scene ?? this.tags.scene;
    this.tags.update(this.remotes,
      ctx.camera ?? (typeof window !== 'undefined' ? window.__atc?.camera : null));
  }

  dispose() {
    this._onClose = null; this._onStatus = null;
    // The pod outlives the session (main.js keeps it for single player), so an
    // un-cancelled subscription would keep queueing 'boom' into an outbox with
    // nobody left to drain it.
    this._unwatch?.(); this._unwatch = null; this._weapons = null;
    for (const uid of [...this.remotes.keys()]) this._drop(uid);
    this.tags.dispose();
    this.net.leave();
  }
}

// A peer we have a uid for but no nickname yet — WELCOME carries uids only, so
// a player joining a busy room knows nobody for the ≤100 ms until each of them
// sends a STATE. identity.js's shortId does the work: it reads the BASE half of
// the uid (so both tabs of one person read the same) and keeps only [a-z0-9],
// which is a stronger guarantee than sanitizeName's for a string headed to a
// canvas texture.
function fallbackName(uid) { return 'Hráč ' + shortId(uid); }

// first finite of (v, fallback) — the wire and half the game objects are full
// of optional fields, and one undefined in a position is a mesh that stops
// being drawn rather than an exception anybody sees
function num(v, d) { return Number.isFinite(v) ? v : d; }

// what main.js awaits after the menu picked "Multiplayer (server)": join the
// shared room, hand back the per-frame session. Throws if the server is gone
// between the menu's health check and now — main falls back to single player.
// name is optional: pass the nickname the menu collected and it is sanitized
// and armed before the first state packet leaves, so peers never see a frame
// of the uid fallback. setPlayerName() beforehand does the same thing.
export async function connectCity(name) {
  if (name !== undefined) setMyName(name);
  await CityNetWS.joinShared();
  return new NetGame(CityNetWS);
}
