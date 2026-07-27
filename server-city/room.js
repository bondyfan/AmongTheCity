// ==========================================================================
// Room — the one shared Pardubice living on the neutral server.
//
// Port of ../AmongTheWoods/server/room.js MINUS the server-side simulation
// (the Woods Milestone 2 `sim` seam): Among The City is client-authoritative
// v1 — every client runs its own world and the server merely OWNS the room
// (registry, lifecycle, 24/7 persistence, peer join/leave) and RELAYS the
// protocol between connected clients. The Woods "authority" role is kept: it
// costs three lines, announces itself over PEER exactly like the original,
// and gives a future world-sync pass (shared traffic, shared wrecks) a peer
// to hang the job on without a protocol change.
//
// The room trusts NOTHING from the wire: `from` is stamped by the server (a
// client that sets it is overwritten), meta is authority-only + whitelisted,
// and every write goes through sendRaw's back-pressure guard.
// ==========================================================================

import { MSG, META_PATCHABLE, encode, freshMeta, isPlainPayload, isSnapPayload, sendObj, sendRaw } from './protocol.js';

export class Room {
  constructor(code, mode, seed) {
    this.code = code;
    this.meta = freshMeta(mode, seed);
    this.players = new Map();     // uid -> { uid, ws, lastState, joinedAt }
    this.authorityUid = null;     // first player in — a seat for future world sync
    this.lastSnap = null;         // most recent world snapshot (for late joiners)
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  get size() { return this.players.size; }
  get empty() { return this.players.size === 0; }

  // prevState: the state blob the same uid had before a reconnect, so a player
  // who drops and comes back doesn't blink out of everyone's world for a tick.
  add(uid, ws, prevState = null) {
    this.lastActivity = Date.now();
    this.players.set(uid, { uid, ws, lastState: prevState, joinedAt: Date.now() });
    if (!this.authorityUid) this.authorityUid = uid;   // first in holds the seat
    this.meta.state = 'playing';

    const others = [...this.players.values()].filter((p) => p.uid !== uid);
    this.sendTo(uid, {
      t: MSG.WELCOME, code: this.code, uid,
      // THE ROOM'S CLOCK. Everything the two clients are supposed to agree
      // about without talking — where each AI car is on its route, which way a
      // traffic light is showing, what time of day it is — is derived from
      // worldT(), and worldT() was each machine's own Date.now(). Measured on
      // the real schedule: one second of skew between the two wall clocks puts
      // the shared fleet 16.8 m apart on average and 643 m apart at worst (a
      // car near a generation boundary respawns somewhere else entirely), and
      // ten seconds leaves 18 of ~100 cars existing on one screen only. NTP
      // usually keeps two machines inside 50 ms, which is fine — but "usually"
      // is not a guarantee anybody can see, and a laptop that just woke up is
      // seconds out. One field cancels the whole class of failure: the client
      // anchors worldclock.setEpoch() to THIS number instead of its own.
      // Additive, so PROTOCOL_VERSION does not move and an old client that
      // ignores it is exactly as correct as it was yesterday.
      now: Date.now(),
      role: uid === this.authorityUid ? 'authority' : 'guest', meta: this.meta,
      peers: others.map((p) => p.uid),
      // avatars on frame one instead of a blank city for ~100 ms (see protocol)
      peerStates: others.filter((p) => p.lastState).map((p) => ({ uid: p.uid, state: p.lastState })),
    });
    // …and the same thing again as ordinary STATE frames, because the SHIPPED
    // client reads peerStates from nothing yet. These land after WELCOME has
    // resolved its promise and the handlers are attached, so today's client
    // gets instant avatars with no client deploy.
    for (const p of others) {
      if (p.lastState) this.sendTo(uid, { t: MSG.STATE_UP, from: p.uid, state: p.lastState });
    }

    // Everyone who arrives inherits the wreckage — the AUTHORITY INCLUDED.
    // Excluding them read as "it is their own snapshot, they already have it",
    // which stops being true the moment they are ARRIVING: an authority who
    // reloads (or reconnects, F1) brings an empty world back and the exclusion
    // left them staring at an intact city while everyone else stood in rubble —
    // then overwrote lastSnap with their own short hitLog and took the
    // wreckage away from every future joiner too. Same for the first player
    // back into the persistent MAIN room, which keeps lastSnap while empty.
    // Replaying is free: city.js applyHit() de-dupes on the blast id, so a
    // snapshot that only contains hits we already took is a no-op.
    if (this.lastSnap) {
      this.sendTo(uid, { t: MSG.SNAP_UP, snap: this.lastSnap });
    }
    this.broadcast({ t: MSG.PEER, event: 'join', uid }, uid);
    this.broadcast({ t: MSG.PEER, event: 'authority', uid: this.authorityUid });
  }

  remove(uid) {
    this.players.delete(uid);
    this.lastActivity = Date.now();
    this.broadcast({ t: MSG.PEER, event: 'leave', uid });
    // promote a survivor to the authority seat, oldest joiner first
    if (uid === this.authorityUid) {
      this.authorityUid = null;
      const next = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (next) {
        this.authorityUid = next.uid;
        this.broadcast({ t: MSG.PEER, event: 'authority', uid: this.authorityUid });
      }
    }
  }

  // ---- message relay: everyone else gets your state/event, nothing more ----
  onState(uid, state) {
    if (!isPlainPayload(state)) return;
    const p = this.players.get(uid);
    if (!p) return;
    p.lastState = state;          // frame size is capped by the caller (index.js)
    this.lastActivity = Date.now();
    this.broadcast({ t: MSG.STATE_UP, from: uid, state }, uid);
  }

  onEvent(uid, ev, to = null) {
    if (!isPlainPayload(ev)) return;
    if (!this.players.has(uid)) return;
    this.lastActivity = Date.now();
    // `from` LAST: spreading the client's object over it would let anyone sign
    // an event with someone else's uid (rocket kills attributed to a stranger).
    const wire = { ...ev, from: uid };
    // addressed events go to ONE player; the rest broadcast to everyone else
    if (to) { if (this.players.has(to)) this.sendTo(to, { t: MSG.EVENT_UP, ev: wire }); }
    else this.broadcast({ t: MSG.EVENT_UP, ev: wire }, uid);
  }

  onSnap(uid, snap) {
    if (uid !== this.authorityUid) return; // only the authority's snapshot counts
    if (!isSnapPayload(snap)) return;      // an ARRAY is the real shape — see protocol.js
    this.lastSnap = snap;
    this.lastActivity = Date.now();
    this.broadcast({ t: MSG.SNAP_UP, snap }, uid);
  }

  // Room meta belongs to the room, not to whoever shouts last: only the
  // authority may patch it, and only the keys the protocol lists (so `host`
  // and `created` stay server-owned).
  onMeta(uid, patch) {
    if (uid !== this.authorityUid) return;
    if (!isPlainPayload(patch)) return;
    let changed = false;
    for (const [k, want] of Object.entries(META_PATCHABLE)) {
      if (!Object.hasOwn(patch, k)) continue;
      const v = patch[k];
      if (want === 'string' && typeof v === 'string' && v.length <= 16) { this.meta[k] = v; changed = true; }
      else if (want === 'number' && Number.isFinite(v)) { this.meta[k] = v; changed = true; }
    }
    if (!changed) return;
    this.lastActivity = Date.now();
    this.broadcast({ t: MSG.META_UP, meta: this.meta });
  }

  // ---- transport helpers ----
  sendTo(uid, obj) {
    const p = this.players.get(uid);
    if (p) sendObj(p.ws, obj);
  }

  broadcast(obj, exceptUid = null) {
    const data = encode(obj);
    for (const p of this.players.values()) {
      if (p.uid === exceptUid) continue;
      sendRaw(p.ws, data);
    }
  }
}
