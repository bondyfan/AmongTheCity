// ---- CityNetWS + NetGame: the dedicated-server transport and what it shows ----
// Two layers in one module, both ported from AmongTheWoods rather than invented:
//
//   1. CityNetWS — a near-verbatim port of ../AmongTheWoods/js/netws.js (the
//      proven WS transport): connect/join the shared room, throttled sendState,
//      onPeerState, sendEvent/onEvent, peer join/leave, keepalive ping. The
//      protocol matches server-city/protocol.js. Renames only: Woods→City and
//      the uid key 'atw-uid'→'atc-uid'.
//
//   2. NetGame — the game-facing orchestrator main.js drives with ONE call per
//      frame: net.update(dt, ctx). It sends our own state at ~10 Hz, renders
//      every remote player as a citizen (makeCitizen, a jacket colour hashed
//      from their uid so the same player is always the same colour) with simple
//      interpolation, and relays rocket detonations by POLLING weapons.live —
//      a missile that leaves the list detonated at its last seen position, so
//      weapons.js needs no patch at all.
//
// Import-time safety: this file touches neither WebSocket nor the DOM until a
// connection is actually asked for, so importing it headless (node --check,
// tests, single player) is free. IMPORTANT for degradation: main.js only ever
// constructs a NetGame after the menu chose "Multiplayer" AND the socket is up.

import { SERVER_URL } from '../server-config.js';
import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE, WALK } from './config.js';
import { NameTags } from './nametags.js';

const MSG = {
  HELLO: 'hello', STATE: 'state', EVENT: 'event', SNAP: 'snap', META: 'meta',
  PING: 'ping', BYE: 'bye',
  WELCOME: 'welcome', PEER: 'peer', ERROR: 'error', PONG: 'pong',
};

// the one shared world every "Multiplayer (server)" player lands in — the
// server ignores the code anyway (see server-city/index.js handleHello)
const SHARED_ROOM = 'PARDUBICE';

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
  _handlers: { meta: null, peerState: null, event: null, snap: null, peer: null },

  uid() {
    if (this._uid) return this._uid;
    let u = null;
    try { u = localStorage.getItem('atc-uid'); } catch {}
    if (!u) { u = 'u' + Math.random().toString(36).slice(2, 10); try { localStorage.setItem('atc-uid', u); } catch {} }
    this._uid = u; return u;
  },

  // open the socket and send HELLO; resolves with { code, meta } once WELCOME
  // arrives. want = 'create' | 'join' (the city server treats both the same).
  _connect(want, { code = null, mode = 'coop', seed = 1 } = {}) {
    const url = wsUrl();
    if (!url) return Promise.reject(new Error('No server configured.'));
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
          this.code = m.code;
          this.role = m.role === 'authority' ? 'host' : 'guest';
          this.peers = new Set(Array.isArray(m.peers) ? m.peers : []);
          if (this.peers.size) this.partnerUid = [...this.peers][0];
          this._startPing();
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
      ws.onclose = () => { this._stopPing(); if (!settled) { settled = true; clearTimeout(failTimer); reject(new Error('Server connection closed.')); } };
    });
  },

  _dispatch(m) {
    switch (m.t) {
      case MSG.META:  this._handlers.meta?.(m.meta); break;
      case MSG.STATE: this._handlers.peerState?.(m.from, m.state); break;
      case MSG.EVENT: this._handlers.event?.(m.ev); break;
      case MSG.SNAP:  this._handlers.snap?.(m.snap); break;
      case MSG.PEER:
        if (m.event === 'join') { this.peers.add(m.uid); this.partnerUid ??= m.uid; }
        else if (m.event === 'leave') {
          this.peers.delete(m.uid);
          if (m.uid === this.partnerUid) this.partnerUid = [...this.peers][0] ?? null;
          this._handlers.peerState?.(m.uid, null); // their avatar goes away
        }
        else if (m.event === 'authority') this.role = (m.uid === this.uid()) ? 'host' : 'guest';
        this._handlers.peer?.(m);
        break;
      default: break;
    }
  },

  _startPing() { this._stopPing(); this._ping = setInterval(() => this._send({ t: MSG.PING }), 25000); },
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
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
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
  becomeHost() { /* server-driven; role flips on the PEER 'authority' message */ return Promise.resolve(); },

  leave() {
    this._stopPing();
    this._send({ t: MSG.BYE });
    try { this._ws?.close(); } catch {}
    this._ws = null; this.role = null; this.code = null; this.partnerUid = null;
    this.peers = new Set();
    this._handlers = { meta: null, peerState: null, event: null, snap: null, peer: null };
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
// remote jacket wardrobe: brighter than the pedestrian palette on purpose, so
// the other PLAYERS read as players across a street full of citizens. Picked
// by uid hash — bounded, so the citizen material cache stays shared.
const REMOTE_JACKETS = [0xc0392b, 0x27ae60, 0xd9a13a, 0x8e44ad,
  0x2e9ac4, 0xd35490, 0x7fb069, 0xb96b3c];

// Where the nickname floats, in metres above the avatar's feet (or above the
// seat anchor when they are riding). A citizen's hair tops out at 1.75 m in
// model space and netcity scales the whole figure by PLAYER_SCALE, so this
// clears the head by a hand's width no matter what PLAYER_SCALE becomes.
const TAG_HEAD_H = 1.75 * PLAYER_SCALE + 0.22;
const TAG_VEH_H = 2.1;   // fallback when we never found their real seat

function strHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

// approximate vehicle identity for v1: colour+kind hash. Two clients seeing
// "the same" stolen Škoda agree often enough for a name tag / seat lookup.
export function vehId(car) {
  return strHash((car.kind ?? 'car') + ':' + (car.color ?? 0));
}

class NetGame {
  constructor(net) {
    this.net = net;
    this.remotes = new Map();     // uid -> remote avatar record
    // ---- SIBLING HOOK (seating) ----
    // netcity does NOT implement vehicle seating. When the seat API lands,
    // fill this with (uid, veh, remote) → {x,y,z,heading}|null (an anchor to
    // park the avatar at) — until then window.__atc.seatAnchor is tried, and
    // failing both the avatar simply stands at the vehicle's position.
    this.onRemoteVehicle = null;
    this.tags = new NameTags(null);   // scene arrives with the first update()
    this.showNames = true;
    this._scene = null;
    this._sendT = 0;
    this._missiles = new Map();   // live missile object -> last seen {x,y,z}
    this._inbox = [];             // peer events, applied in update (ctx needed)
    net.onPeerState((uid, s) => this._peerState(uid, s));
    net.onEvent((ev) => { if (this._inbox.length < 64) this._inbox.push(ev); });
  }

  get uid() { return this.net.uid(); }
  get peers() { return this.net.peers; }

  // ---- inbound ----
  _peerState(uid, s) {
    if (s === null) { this._drop(uid); return; }
    let r = this.remotes.get(uid);
    if (!r) {
      // WELCOME carries uids only, never nicknames, so a player who joins a
      // busy room knows nobody until each of them sends a STATE (≤100 ms).
      // Until then wear a scrap of the uid rather than a blank tag.
      r = { uid, cit: null, state: null, lastSeen: 0,
        name: 'Hráč ' + sanitizeName(uid).slice(-4),
        x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0, h: s.h ?? 0,
        tagY: (s.y ?? 0) + TAG_HEAD_H,   // sane until the first _updateRemotes
        speed: 0, walkT: 0 };
      this.remotes.set(uid, r);
    }
    // re-sanitize: this string came off the wire and is headed for a texture
    if (typeof s.nm === 'string') {
      const nm = sanitizeName(s.nm);
      if (nm) r.name = nm;
    }
    r.state = s;
    r.lastSeen = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  }

  // the nickname of a connected peer, or '' — for HUD/kill-feed callers that
  // want a name without walking `remotes` themselves
  peerName(uid) { return this.remotes.get(uid)?.name ?? ''; }

  _drop(uid) {
    const r = this.remotes.get(uid);
    if (!r) return;
    if (r.cit && this._scene) this._scene.remove(r.cit.group);
    this.tags.remove(uid);      // sprite + material + its share of the texture
    this.remotes.delete(uid);
  }

  // ---- outbound: watch the rocket pod without touching weapons.js ----
  // weapons.live is the observable truth: fire() pushes, a detonation splices.
  // We shadow each live missile's position; one that vanished from the list
  // went off at (approximately — one frame of flight) its last seen spot.
  _watchWeapons(weapons) {
    const live = weapons?.live;
    if (!live) return;
    for (const [m, p] of this._missiles) {
      if (!live.includes(m)) {
        this._missiles.delete(m);
        queueEvent('boom', { x: +p.x.toFixed(1), y: +p.y.toFixed(1), z: +p.z.toFixed(1) });
      }
    }
    for (const m of live) {
      let p = this._missiles.get(m);
      if (!p) { p = { x: 0, y: 0, z: 0 }; this._missiles.set(m, p); }
      p.x = m.x; p.y = m.y; p.z = m.z;
    }
  }

  // a peer's rocket goes off in OUR world too: same blast FX, same demolition,
  // resolved locally by the very method the pod itself uses. b=null makes
  // damageBuilding find every building the sphere touches — identical to a
  // ground/airburst hit, so approximate positions still wreck the right wall.
  _applyEvent(ev, ctx) {
    if (ev.type === 'boom' && ctx.weapons
        && Number.isFinite(ev.x) && Number.isFinite(ev.y) && Number.isFinite(ev.z)) {
      ctx.weapons.detonate(ev.x, ev.y, ev.z, null, { cars: ctx.cars, peds: ctx.peds });
    }
  }

  // ---- own state, ~10 Hz ----
  // { x,y,z, h(eading), s(peed), wt(walkT), veh:{k,id,seat}|null, nm } — the
  // whole v1 protocol. player.pos mirrors the car/heli while inside, so
  // position is always just player state and veh only adds "and I'm sitting in
  // this". `nm` rides INSIDE state on purpose: the relay treats state as an
  // opaque blob it re-broadcasts untouched (server-city/room.js onState), so
  // the nickname needs no server change — whereas HELLO is parsed field by
  // field and would have needed a redeploy. It goes out on every packet rather
  // than once at join, so a player who joins later learns the names of everyone
  // already in the room within 100 ms; 14 bytes at 10 Hz is ~140 B/s.
  _sendState(ctx) {
    const p = ctx.player, g = ctx.game;
    const veh = g.heli ? { k: 'heli', id: 0, seat: 0 }
      : g.car ? { k: 'car', id: vehId(g.car), seat: 0 } : null;
    this.net.sendState({
      x: +p.pos.x.toFixed(2), y: +(p.y ?? 0).toFixed(2), z: +p.pos.z.toFixed(2),
      h: +p.heading.toFixed(3),
      s: +p.speed.toFixed(2), wt: +(p.walkT % (Math.PI * 2)).toFixed(2),
      veh,
      ...(_myName ? { nm: _myName } : {}),
    }, 0);   // our own 10 Hz gate already throttled; don't double-gate
  }

  // main.js may also set the nickname through the session it already holds
  setPlayerName(name) { return setMyName(name); }

  // ---- remote avatars: lerp toward the last state, ease the heading ----
  _updateRemotes(dt) {
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const k = Math.min(1, dt * 8);
    for (const [uid, r] of this.remotes) {
      const s = r.state;
      if (!s) continue;
      if (now - r.lastSeen > REAP_MS) { this._drop(uid); continue; }
      if (!r.cit) {
        if (!this._scene) continue;
        const jacket = REMOTE_JACKETS[strHash(uid) % REMOTE_JACKETS.length];
        r.cit = makeCitizen({ jacket });
        r.cit.group.scale.setScalar(PLAYER_SCALE);
        r.x = s.x; r.y = s.y ?? 0; r.z = s.z; r.h = s.h ?? 0;
        this._scene.add(r.cit.group);
      }
      // position: plain lerp toward the newest packet — at 10 Hz this walks a
      // remote smoothly with ~1 packet of lag, which is the honest v1 trade
      r.x += (s.x - r.x) * k;
      r.y += ((s.y ?? 0) - r.y) * k;
      r.z += (s.z - r.z) * k;
      // heading: shortest arc, slightly quicker so turns lead the body
      let dh = (s.h ?? 0) - r.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      r.h += dh * Math.min(1, dt * 10);

      if (s.veh) {
        // sitting in a car/heli — ask the sibling's seat API for an anchor;
        // with no API the avatar stands at the vehicle position (their pos
        // already mirrors the vehicle, sent by their own player.update)
        const a = this.onRemoteVehicle?.(uid, s.veh, r)
          ?? (typeof window !== 'undefined' ? window.__atc?.seatAnchor?.(s.veh) : null);
        if (a) {
          r.cit.group.position.set(a.x, a.y ?? r.y, a.z);
          r.cit.group.rotation.y = a.heading ?? r.h;
          // the seat anchor sits at cushion height inside the cabin — a metre
          // over it clears the roofline of every kind including the bus
          r.tagY = (a.y ?? r.y) + 1.0;
        } else {
          r.cit.group.position.set(r.x, r.y, r.z);
          r.cit.group.rotation.y = r.h;
          r.tagY = r.y + TAG_VEH_H;
        }
        r.speed = 0;
        r.cit.walk(0, 0);   // limbs still — no running man on a car roof
      } else {
        // stride phase advances with the reported speed, eased so a stale
        // packet winds the legs down instead of freezing them mid-swing
        r.speed += ((s.s ?? 0) - r.speed) * k;
        r.walkT += r.speed * dt * 1.6;
        r.cit.group.position.set(r.x, r.y, r.z);
        r.cit.group.rotation.y = r.h;
        r.tagY = r.y + TAG_HEAD_H;
        r.cit.walk(r.walkT, Math.min(1.25, r.speed / WALK.jog));
      }
    }
  }

  // ---- the one per-frame call main.js makes ----
  // ctx = { scene, player, game, weapons, world, cars, peds, camera? }
  update(dt, ctx) {
    this._scene = ctx.scene;
    this._watchWeapons(ctx.weapons);
    while (_outbox.length) this.net.sendEvent(_outbox.shift());
    while (this._inbox.length) this._applyEvent(this._inbox.shift(), ctx);
    this._sendT -= dt;
    if (this._sendT <= 0 && ctx.player) { this._sendT = SEND_S; this._sendState(ctx); }
    this._updateRemotes(dt);
    // Name tags after the avatars moved, so a tag never trails its owner by a
    // frame. The camera is not in ctx today; __atc.camera is the same fallback
    // the seat anchor already uses, and ctx.camera wins the day main.js passes
    // one. No camera at all (a headless pump) simply draws no tags.
    this.tags.enabled = this.showNames;
    this.tags.scene = ctx.scene ?? this.tags.scene;
    this.tags.update(this.remotes,
      ctx.camera ?? (typeof window !== 'undefined' ? window.__atc?.camera : null));
  }

  dispose() {
    for (const uid of [...this.remotes.keys()]) this._drop(uid);
    this.tags.dispose();
    this.net.leave();
  }
}

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
