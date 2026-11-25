// ---- trainride.js: getting on a train by its door, riding it, sitting down ----
// Frank, 21 Nov 2026: "aby všechny vlaky byly tak, jako je to, když nastupuje
// jako z Kolína ... nastoupit, sednout si tam a tak dále. A musí opravdu ten
// vlak přijet, potom se odjet fyzicky."
//
// Until now E beside a standing train hid the player and parked him in the
// cab. Now a train is a place: its doors open at a platform, he walks up the
// steps, down the aisle, sits on a seat with the campaign's own movement
// (js/prologue-seat.js), and the train leaves with him in it. Nothing is a
// cut. He is "riding" from the step he takes into a coach to the step he
// takes out of one; in between the train carries him by keeping him at the
// same place in his coach's own frame (js/traindeck.js), every frame.
//
// These are methods of Trains (js/trains.js), kept here for the 400-line rule.

import { trainStart, trainStop, trainSet } from './audio.js';
import { locate, toWorld, deckY, deckWalls, atDoor, seatNear, FLOOR, DOOR_OPEN } from './traindeck.js';
import { doorX } from './prologue-coach.js';
import { seating } from './prologue-seat.js';

const BODY = 2.8;      // m of coach over its base a walker's body can meet
const STEP_UP = 1.54;  // m a walker's feet may be off the floor and still be "in" (the campaign's)
const near = (t, x, z) => Math.abs(x - t.x) + Math.abs(z - t.z) < t.length + 40;

export function installRide(Trains, VMAX) {
  // (descriptors, not Object.assign: the getters must stay getters)
  Object.defineProperties(Trains.prototype, Object.getOwnPropertyDescriptors({
    /**
     * The train's floor, walls and doors for the world (main.js hands it to
     * city.js as world.rideDeck): the same four questions the campaign's
     * coach answers as world.storyCoach.
     */
    get deck() {
      return (this._deck ??= {
        // inside the train he rides: nothing else in the world holds or stops him
        carrying: (x, z) => {
          const t = this.riding;
          return !!t && !this.locked && near(t, x, z) && locate(t.frames, x, z) !== null;
        },
        support: (x, z, limit) => {
          if (this.locked) return -Infinity;
          let y = -Infinity;
          for (const t of this.trains) {
            if ((t !== this.riding && !t.halted) || !near(t, x, z)) continue;
            const h = deckY(t.frames, x, z, t.closed);
            if (h > y) y = h;
          }
          return this._deck.carrying(x, z) || y <= limit + 0.02 ? y : -Infinity;
        },
        // a train on the move is no wall to anyone outside it, as before
        collide: (pos, r, opts) => {
          if (this.locked || !opts?.interior) return false;
          let moved = false;
          for (const t of this.trains) {
            if ((t !== this.riding && !t.halted) || !near(t, pos.x, pos.z)) continue;
            const base = t.frames[0].y;
            if (opts.yLo > base + BODY || opts.yHi < base) continue;
            if (deckWalls(t.frames, pos, r, t.closed)) moved = true;
          }
          return moved;
        },
        // the step from the platform's edge to an open door crosses the strip
        // of track js/railbarrier.js keeps walkers off: this is the way in
        boarding: (x, z) => {
          if (this.locked) return false;
          for (const t of this.trains) {
            if ((t !== this.riding && !t.halted) || !near(t, x, z)) continue;
            if (locate(t.frames, x, z) || atDoor(t.frames, x, z, t.closed)) return true;
          }
          return false;
        },
      });
    },

    /** The nearest station to (x, z) within r: { name, x, z, d }, or null (js/phone-tickets.js). */
    stationNear(x, z, r = Infinity) {
      let best = null, bd = r;
      for (const p of this._stations) {
        const d = Math.hypot(p.p[0] - x, p.p[1] - z);
        if (d < bd) { bd = d; best = p; }
      }
      return best ? { name: best.n ?? 'Zastávka', x: best.p[0], z: best.p[1], d: bd } : null;
    },

    /** The floor under the rider's feet, or null. */
    floorY() {
      const t = this.riding, at = this._at;
      return t && at ? t.frames[Math.min(at.i, t.frames.length - 1)].y + FLOOR : null;
    },

    // Before the trains move: where is he in his coach? Did he step in, or out?
    _rideBefore() {
      const p = this.player;
      if (!p?.pos) return;
      const t = this.riding;
      if (this.locked) { if (t) this._leave(); return; }
      if (t) {
        if (!this.trains.has(t)) { this._leave(); return; }
        if (this._seat?.taken) return;                 // the seat holds him
        const at = locate(t.frames, p.pos.x, p.pos.z);
        if (at) { this._at = at; this._baseY = t.frames[at.i].y; }
        else if (t.halted) this._leave();              // he walked out of the door
        // (not in it and it is moving: he is put back where he last stood)
        return;
      }
      if (p.inCar || p.boarding || p.exiting || p.ragdoll) return;
      for (const o of this.trains) {
        if (!o.halted || o.closed >= DOOR_OPEN || !near(o, p.pos.x, p.pos.z)) continue;
        const at = locate(o.frames, p.pos.x, p.pos.z);
        if (!at) continue;
        const floor = o.frames[at.i].y + FLOOR;
        if (typeof p.y === 'number' && Math.abs(p.y - floor) > STEP_UP) continue;
        this._enter(o, at);
        return;
      }
    },

    // After they moved: the same place in the coach, wherever that is now.
    _rideAfter() {
      const t = this.riding;
      if (!t) return;
      this._syncRide();
      trainSet(Math.abs(t.speed) / VMAX);
    },

    _enter(t, at) {
      this.riding = t;
      this._at = at;
      this._baseY = t.frames[at.i].y;
      trainStart();
      this.opts.onBoard?.(t);
    },

    _leave() {
      const p = this.player;
      this.riding = null;
      this._at = null;
      this._seat?.clear();
      trainStop();
      if (p?.pos) { this.ridePos.x = p.pos.x; this.ridePos.z = p.pos.z; }
      if (typeof p?.y === 'number') this.ridePos.y = p.y;
      this.opts.onAlight?.(this.ridePos);
    },

    /** Out of it at once, wherever it is: a death, a teleport, the campaign taking over. */
    eject() {
      if (this.riding) this._leave();
    },

    /**
     * Put a rider aboard a standing train without the walk: its first coach's
     * aisle. For tests and scripts; the player gets on by the door.
     */
    board(train, player) {
      if (!train || !this.trains.has(train) || !train.halted || this.riding) return false;
      if (player) this.player = player;
      this._enter(train, { i: 0, u: 3, v: 0 });
      this._syncRide(true);
      return true;
    },

    /**
     * The same the other way: off a standing train onto the station's side of
     * the track. False while it moves.
     */
    alight() {
      const t = this.riding;
      if (!t || !t.halted) return false;
      const f = t.frames[Math.min(this._at?.i ?? 0, t.frames.length - 1)];
      const st = t.station;
      const side = st && (st.z - f.z) * f.c - (st.x - f.x) * f.s < 0 ? -1 : 1;
      const w = toWorld(f, doorX, side * 4.6);
      const tgt = this._rideTarget();
      if (tgt) { tgt.x = w.x; tgt.z = w.z; }
      if (this.player && typeof this.player.y === 'number') this.player.y = f.y - 0.6;
      this._leave();
      return true;
    },

    // Where the rider's position has to be written: the player's, or (a Trains
    // built without one) the focus update() was last given, which under
    // main.js is player.pos itself.
    _rideTarget() {
      const p = this.player;
      if (p?.pos && typeof p.pos.x === 'number') return p.pos;
      const f = this._focus;
      return f && typeof f.x === 'number' ? f : null;
    },

    // Keep him at his place in his coach. `set` puts his feet on the floor
    // outright (boarding without the walk, a skip to the next station).
    _syncRide(set = false) {
      const t = this.riding, at = this._at, p = this.player;
      if (!t || !at) return;
      const f = t.frames[Math.min(at.i, t.frames.length - 1)];
      if (!this._seat?.taken) {
        const w = toWorld(f, at.u, at.v), tgt = this._rideTarget();
        if (tgt) { tgt.x = w.x; tgt.z = w.z; }
        if (p && typeof p.y === 'number') {
          if (set) { p.y = f.y + FLOOR; if (typeof p.vy === 'number') p.vy = 0; }
          else p.y += f.y - this._baseY;
        }
        this.ridePos.x = w.x; this.ridePos.z = w.z;
      }
      this.ridePos.y = f.y + FLOOR;
      this._baseY = f.y;
    },

    // ---- the seat ----------------------------------------------------------
    _seatCtl() {
      const p = this.player;
      if (!this._seat && p?.mesh && p._sit) this._seat = seating(p);
      return this._seat ?? null;
    },

    /** What E would do for him now: 'rise', 'sit' or null. */
    get seatAction() {
      if (!this.riding || !this._at) return null;
      const seat = this._seatCtl();
      if (!seat) return null;
      if (seat.taken) return seat.settled ? 'rise' : 'busy';
      return seatNear(this._at.u) ? 'sit' : null;
    },
    get seated() { return !!this._seat?.settled; },

    /** E aboard: sit down on the nearest seat, or get up from it. */
    use() {
      const act = this.seatAction;
      if (!act) return false;
      if (act === 'rise') this._seat.rise();
      else if (act === 'sit') {
        const at = this._at, target = seatNear(at.u);
        this._seat.sit(target, at.u, at.v, this.player.heading);
      }
      return true;
    },

    /** The seated body for this frame (main.js, in place of the walk). */
    posePlayer(dt) {
      const seat = this._seat, t = this.riding;
      if (!seat?.taken || !t || !this._at) return false;
      const f = t.frames[Math.min(this._at.i, t.frames.length - 1)];
      return seat.pose(dt, {
        worldAt: (u, v) => toWorld(f, u, v),
        floor: f.y + FLOOR,
        facing: Math.atan2(f.c, f.s),      // the seat looks back along the coach
      });
    },
  }));
}
