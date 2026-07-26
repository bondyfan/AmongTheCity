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
// ==========================================================================

import { MSG, freshMeta, encode } from './protocol.js';

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

  add(uid, ws) {
    this.lastActivity = Date.now();
    this.players.set(uid, { uid, ws, lastState: null, joinedAt: Date.now() });
    if (!this.authorityUid) this.authorityUid = uid;   // first in holds the seat
    this.meta.state = 'playing';
    this.sendTo(uid, {
      t: MSG.WELCOME, code: this.code, uid,
      role: uid === this.authorityUid ? 'authority' : 'guest', meta: this.meta,
      peers: [...this.players.keys()].filter((u) => u !== uid),
    });
    if (this.lastSnap && uid !== this.authorityUid) {
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
    const p = this.players.get(uid);
    if (p) p.lastState = state;
    this.lastActivity = Date.now();
    this.broadcast({ t: MSG.STATE_UP, from: uid, state }, uid);
  }

  onEvent(uid, ev, to = null) {
    this.lastActivity = Date.now();
    const wire = { from: uid, ...ev };
    // addressed events go to ONE player; the rest broadcast to everyone else
    if (to) this.sendTo(to, { t: MSG.EVENT_UP, ev: wire });
    else this.broadcast({ t: MSG.EVENT_UP, ev: wire }, uid);
  }

  onSnap(uid, snap) {
    if (uid !== this.authorityUid) return; // only the authority's snapshot counts
    this.lastSnap = snap;
    this.lastActivity = Date.now();
    this.broadcast({ t: MSG.SNAP_UP, snap }, uid);
  }

  onMeta(uid, patch) {
    Object.assign(this.meta, patch || {});
    this.broadcast({ t: MSG.META_UP, meta: this.meta });
  }

  // ---- transport helpers ----
  sendTo(uid, obj) {
    const p = this.players.get(uid);
    if (p && p.ws.readyState === 1) { try { p.ws.send(encode(obj)); } catch {} }
  }

  broadcast(obj, exceptUid = null) {
    const data = encode(obj);
    for (const p of this.players.values()) {
      if (p.uid === exceptUid) continue;
      if (p.ws.readyState === 1) { try { p.ws.send(data); } catch {} }
    }
  }
}
