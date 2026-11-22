// ---- netride.js: riding along in a car another player drives -------------------
//
// In co-op a peer's car is a proxy this client only draws (js/netvehicles.js):
// it is in nobody's physics, nobody's traffic and nobody's crash list, and it
// stays that way. What it gains here is passenger seats. E beside it walks the
// local player round the body to a free seat (the same boarding state machine
// every other car uses, js/player.js), and from then on the body rides the
// proxy while the driver's own client goes on being the only place that car is
// simulated.
//
// Three things had to be agreed for that, and this file is the three of them,
// with no three.js and no DOM in it so node can test each one:
//
//   WHO SITS WHERE. `veh.seats` is a local array nobody else writes, so two
//   passengers could both take the front seat. The seat is announced:
//     event  seat_claim { ho: driver's uid, s: seat, on: 1|0 }   the walk-up
//     state  veh.ho + veh.st                                     once seated
//   Every client keeps the same book of those. Like the helicopter's claim it
//   is advisory: two people who press E inside one round trip both start
//   walking, and then the one with the lower uid keeps the seat and the other
//   is told so. Somebody already SEATED always beats somebody walking up.
//
//   WHAT THE PASSENGER'S EYE RIDES ON. A proxy's pose is eased towards 10 Hz
//   packets at a fixed rate, which is fine to look AT and bad to look FROM:
//   every packet that lands a few milliseconds early or late is a step in the
//   car's velocity, and the camera is rigid to the car. follow() is a
//   critically damped spring towards the dead-reckoned target instead, so a
//   late packet bends the velocity and never breaks it. netvehicles uses it
//   for a proxy only while somebody local is in it or walking up to it.
//
//   WHEN THE RIDE IS OVER WITHOUT ANYBODY PRESSING E. The driver stepped out,
//   left the room, changed cars, or pulled away while the passenger was still
//   walking round the boot. makeRides().update() notices each of those and
//   hands the body back to the street through `leave(why)`.
//
// The driver's seat of a peer's car is not in any of this: seatFor() starts at
// seat 1, so nobody takes a car from under another player with E.

/** Seats a kind has, the driver's included. A seat is an index into
 *  vehicles.js seatAnchor(): odd is the right side, every two a row back. */
const SEATS = { roadster: 2, van: 2, truck: 2, semi: 2, bus: 8, trolleybus: 8 };
export const seatsOf = (kind) => SEATS[kind] ?? 4;

const MAX_SEAT = 7;          // what the wire's `st` is clamped to (netvehicles readState)
const WALK_TTL = 25;         // s a walk-up claim lives without being renewed or seated
const BOOK_MAX = 96;         // claims kept, however many events a client invents
/** A car that pulls away faster than this is not being boarded any more. */
export const WALK_OFF_V = 4.5;
/** Seconds without a packet from the driver before the passenger is told. */
export const QUIET_S = 6;

const okUid = (u) => typeof u === 'string' && u.length > 0 && u.length <= 80;
const okSeat = (s) => Number.isInteger(s) && s >= 1 && s <= MAX_SEAT;

// ---- the seat book -------------------------------------------------------------
// uid → { ho, s, seated, age }. One claim per player: nobody sits in two cars.
export function makeSeatBook({ ttl = WALK_TTL } = {}) {
  const by = new Map();

  // does claim `a` (of uid ua) have the better right to a seat than `b` (of ub)?
  const outranks = (ua, a, ub, b) => (a.seated !== b.seated ? a.seated : ua < ub);

  return {
    /** An event: `uid` is walking up to seat `s` of the car `ho` drives. */
    claim(uid, ho, s) {
      if (!okUid(uid) || !okUid(ho) || !okSeat(s) || uid === ho) return false;
      const c = by.get(uid);
      // (a walk-up event that arrives after the state already shows them
      // seated there must not demote them back to "walking")
      if (c?.seated && c.ho === ho && c.s === s) return true;
      if (!c && by.size >= BOOK_MAX) return false;
      by.set(uid, { ho, s, seated: false, age: 0 });
      return true;
    },
    /** An event: `uid` gave the seat up (walked away, stepped out). */
    release(uid, ho = null, s = null) {
      const c = by.get(uid);
      if (!c) return;
      // a release names what it releases, so one that is overtaken on the wire
      // by the claim for the NEXT car does not wipe that claim out
      if (ho !== null && (c.ho !== ho || c.s !== s)) return;
      by.delete(uid);
    },
    /** A state packet: what `uid` reports sitting in (the `veh` descriptor or null). */
    observe(uid, veh) {
      if (!okUid(uid)) return;
      const s = veh && okUid(veh.ho) && veh.ho !== uid ? Math.round(Number(veh.st)) : 0;
      if (okSeat(s)) {
        if (by.has(uid) || by.size < BOOK_MAX) by.set(uid, { ho: veh.ho, s, seated: true, age: 0 });
      } else if (by.get(uid)?.seated) by.delete(uid);   // they were in, now they are not
    },
    /** Who else has seat `s` of `ho`'s car: the claimant with the best right, or null. */
    holder(ho, s, me = null) {
      let best = null, bc = null;
      for (const [uid, c] of by) {
        if (uid === me || c.ho !== ho || c.s !== s) continue;
        if (!best || outranks(uid, c, best, bc)) { best = uid; bc = c; }
      }
      return best;
    },
    /** The lowest passenger seat of `ho`'s car nobody else has, or -1: full. */
    seatFor(ho, seats, me = null) {
      const n = Math.min(seats, MAX_SEAT + 1);
      for (let s = 1; s < n; s++) if (!this.holder(ho, s, me)) return s;
      return -1;
    },
    /** Somebody with a better right to MY seat: their uid, or null. */
    beaten(me, ho, s, seated) {
      const mine = { seated: !!seated };
      for (const [uid, c] of by) {
        if (uid === me || c.ho !== ho || c.s !== s) continue;
        if (outranks(uid, c, me, mine)) return uid;
      }
      return null;
    },
    /** Walk-up claims run out: the event that would have released one can be lost. */
    tick(dt) {
      for (const [uid, c] of by) {
        if (c.seated) continue;
        if ((c.age += dt) > ttl) by.delete(uid);
      }
    },
    /** `uid` left the room: their seat is free, and so is every seat in their car. */
    forget(uid) {
      by.delete(uid);
      for (const [u, c] of by) if (c.ho === uid) by.delete(u);
    },
    clear() { by.clear(); },
    get size() { return by.size; },
  };
}

// ---- follow(): one axis of a critically damped chase ---------------------------
// o.x chases a target that is at `g` at the END of this step and moves at `gv`;
// o.v is the chaser's own velocity and is continuous across calls, which is
// the whole point. The step is the exact solution, so it is stable at any dt
// and a frame of 100 ms lands where six frames of 16 ms would.
export function follow(o, g, gv, w, dt) {
  const e0 = o.x - (g - gv * dt), d0 = o.v - gv;
  const k = Math.exp(-w * dt), c = d0 + w * e0;
  o.x = g + (e0 + c * dt) * k;
  o.v = gv + (d0 - w * c * dt) * k;
  return o;
}

// ---- what becomes of a walk-up or a ride this frame ----------------------------
/**
 * veh: the proxy (js/netvehicles.js), with gone / speed / quiet.
 * Returns null (carry on) or why it is over: 'gone' the car is no longer there,
 * 'left' it drove off while we were still walking to it.
 */
export function rideFate(veh, seated, phase) {
  if (!veh || veh.gone) return 'gone';
  if (!seated && phase === 'walk' && Math.abs(veh.speed) > WALK_OFF_V) return 'left';
  return null;
}

// ---- makeRides(): the local player's side of it --------------------------------
// deps: player (js/player.js Player), self() → our uid, send(type, data) → an
// event to the room, leave(why, uid) → main.js puts the body back on the
// street ('gone' | 'left' | 'rival', and whose car or who took the seat),
// quiet(uid) → the driver has stopped answering (said once per ride).
export function makeRides({ player, self, send, leave, quiet }) {
  const book = makeSeatBook();
  let told = null;      // what the room last heard from us: { ho, s }
  let cur = null;       // the proxy that claim is about
  let over = false;     // leave() has been called for this ride
  let hushed = false;   // the "driver is not answering" line has been said

  // the proxy we are in or walking up to, and the seat
  function mine() {
    const b = player.boarding;
    const veh = player.inCar?.proxy ? player.inCar : b?.veh?.proxy ? b.veh : null;
    return veh ? { veh, seat: player.inCar ? player.seat : b.seat, seated: !!player.inCar } : null;
  }

  return {
    book,
    /** The seat E would take in this proxy right now, or -1 when it is full. */
    seatFor(veh) { return book.seatFor(veh.uid, seatsOf(veh.kind), self()); },
    /** A `seat_claim` off the wire (`from` is stamped by the relay). */
    onEvent(ev) {
      if (!ev || !okUid(ev.from)) return;
      if (ev.on) book.claim(ev.from, ev.ho, ev.s);
      else book.release(ev.from, okUid(ev.ho) ? ev.ho : null, ev.s);
    },
    observe(uid, veh) { book.observe(uid, veh); },
    forget(uid) { book.forget(uid); },
    /** The session is over: nobody else is in the book any more. (What we
     *  told the room is squared by update(), which ends our own ride first.) */
    reset() { book.clear(); },

    /** Once a frame, AFTER the proxies have moved (ghosts.update). */
    update(dt) {
      book.tick(dt);
      const m = mine();
      // 1. the room hears what is true now, whichever way it came about (E, an
      //    arrest, a respawn, the car vanishing): one place, so no exit forgets
      if ((m?.veh.uid ?? null) !== (told?.ho ?? null) || (m?.seat ?? 0) !== (told?.s ?? 0)) {
        if (told) send('seat_claim', { ho: told.ho, s: told.s, on: 0 });
        // A walk-up ends itself when the car's mesh leaves the scene (the
        // player's own state machine runs before us in the frame): the reason
        // is still owed, once.
        if (!m && cur?.gone && !over) leave('gone', cur.uid);
        told = m ? { ho: m.veh.uid, s: m.seat } : null;
        cur = m?.veh ?? null;
        over = false; hushed = false;
        if (told) send('seat_claim', { ho: told.ho, s: told.s, on: 1 });
      }
      if (!m) return;
      // 2. the seat is somebody else's by right (two of us pressed E at once)
      const rival = book.beaten(self(), m.veh.uid, m.seat, m.seated);
      if (rival) { over = true; leave('rival', rival); return; }
      // 3. the car itself
      const why = rideFate(m.veh, m.seated, player.boarding?.phase);
      if (why) { over = true; leave(why, m.veh.uid); return; }
      if (!m.seated) return;
      // seated: player.update() mirrored the proxy BEFORE it moved this frame;
      // put the body's own numbers on the pose the car is drawn at, so the
      // camera (rigid to player.pos) and the car never differ by a frame
      player.pos.x = m.veh.x; player.pos.z = m.veh.z;
      player.heading = m.veh.heading;
      player.y = m.veh.y;
      if (!hushed && m.veh.quiet > QUIET_S) { hushed = true; quiet?.(m.veh.uid); }
      else if (hushed && m.veh.quiet < 1) hushed = false;
    },
  };
}
