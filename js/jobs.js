// ---- Jobs: one job at a time, from accepted to paid ----
// The state machine behind the courier and the taxi. It owns no DOM, no mesh
// and no clock: js/career.js feeds it one context a step and listens for
// events, which is what lets tests/jobs.test.mjs drive a whole delivery in a
// loop of plain numbers.
//
//   idle -> toPickup -> (taxi only: loading) -> toDrop -> idle   [done]
//             any state  -> abandon or fail     -> idle
//
// ARRIVING IS STOPPING AT THE MARKER, never a key. E already means "get out of
// the car" before it could mean anything else, and a delivery you complete by
// pulling up at the door is how the genre has always done it.
//
// THE CLOCK STARTS AT THE PICK-UP, and its length comes from navigation.js:
// the moment the route to the drop-off exists, its road metres and free-flow
// seconds replace the straight-line estimate the board showed. Until then the
// estimate stands in, so a job is never untimed.

import { courierLimitS, courierPay, taxiLimitS, taxiPay, estRouteM, haulLimitS, Smoothness } from './jobmath.js';

export const ARRIVE_CAR = 13;     // m: a car has reached a marker
export const ARRIVE_FOOT = 7;     // m: and so has a courier on foot
const STOP_V = 2.2;               // m/s: "stopped" (a rolling stop counts)
const LOAD_S = 1.8;               // s the fare takes to get in
const ROUTE_WAIT = 2.5;           // s to wait for a route before estimating
const OUT_MAX = 30;               // s a fare waits in a car nobody is driving

export const FAIL_TEXT = {
  late: 'Zásilka nedoručena včas',
  patience: 'Zákazníkovi došla trpělivost',
  left: 'Zákazník nevydržel čekat v autě',
  wreck: 'Auto je na odpis, zákazník vystoupil',
  down: 'Zakázka propadla',
  abandon: 'Zakázka zrušena',
};

export class JobRunner {
  constructor() {
    this.state = 'idle';
    this.job = null;
    this.elapsed = 0;          // s since the pick-up
    this.limitS = 0;           // 0 = not known yet
    this.routeM = 0;
    this.smooth = new Smoothness();
    this._listeners = [];
    this._load = 0; this._routeT = 0; this._outT = 0;
    this._dmg = 0; this._dmgLast = null; this._carId = null; this._stars = 0;
    this._hinted = false;
  }

  on(fn) { if (typeof fn === 'function') this._listeners.push(fn); }
  _emit(type, data) { for (const fn of this._listeners) fn(type, data, this.job); }

  get active() { return this.state !== 'idle'; }
  get carrying() { return this.state === 'toDrop'; }
  /** Where the player should be heading right now, or null. */
  get target() {
    if (!this.job) return null;
    return this.state === 'toDrop' ? this.job.to : this.job.from;
  }
  get timeLeft() { return this.limitS > 0 ? this.limitS - this.elapsed : null; }

  accept(job) {
    if (this.active || !job) return false;
    this.job = job;
    this.state = 'toPickup';
    this.elapsed = 0; this.limitS = 0; this.routeM = 0;
    this._load = 0; this._hinted = false;
    this._emit('accepted');
    return true;
  }

  /** The player gave it up. Clean: no pay, no penalty, the board has it back. */
  abandon() { if (this.active) this._end('failed', { reason: 'abandon' }); }

  _end(type, data) {
    const job = this.job;
    this.state = 'idle';
    this.job = null;
    for (const fn of this._listeners) fn(type, data, job);
  }

  _startDrop(ctx) {
    this.state = 'toDrop';
    this.elapsed = 0; this.limitS = 0; this._routeT = 0; this._outT = 0;
    this._dmg = 0; this._dmgLast = null; this._carId = null; this._stars = 0;
    this.routeM = estRouteM(this.job.distM);
    this.smooth.reset();
    this._emit('pickup', { inCar: !!ctx.inCar });
  }

  // The clock's length, once: from the route when navigation has one for THIS
  // destination, from the estimate when it has not produced one in time.
  _settleLimit(ctx) {
    // a haul is timed off the road length at once: 87 km out, the route is
    // partial and its metres include a straight-line gap (js/jobmath.js)
    if (this.job.kind === 'haul') {
      this.limitS = haulLimitS(this.routeM);
      this._emit('timed', { limitS: this.limitS, routeM: this.routeM, routed: false });
      return;
    }
    this._routeT += ctx.dt;
    const to = this.job.to;
    const nd = ctx.navDest;
    const mine = nd && Math.abs(nd.x - to.x) < 2 && Math.abs(nd.z - to.z) < 2;
    const have = mine && Number.isFinite(ctx.routeM) && ctx.routeM > 0;
    if (!have && this._routeT < ROUTE_WAIT) return;
    if (have) this.routeM = ctx.routeM;
    const eta = have && Number.isFinite(ctx.etaS) ? ctx.etaS : null;
    this.limitS = this.job.kind === 'taxi'
      ? taxiLimitS(this.routeM, eta) : courierLimitS(this.routeM, eta);
    this._emit('timed', { limitS: this.limitS, routeM: this.routeM, routed: !!have });
  }

  // Fresh crash damage on whatever is being driven. A change of car rebases:
  // the wreck you swapped into did not happen to the parcel.
  _trackDamage(ctx) {
    if (!ctx.inCar) { this._dmgLast = null; this._carId = null; return; }
    const d = Number.isFinite(ctx.carDamage) ? ctx.carDamage : 0;
    if (ctx.carId !== this._carId) {
      this._carId = ctx.carId; this._dmgLast = d; this.smooth.rebase();
      return;
    }
    if (this._dmgLast !== null && d > this._dmgLast) this._dmg += d - this._dmgLast;
    this._dmgLast = d;
  }

  /**
   * One step. ctx = {
   *   dt, x, z, speed, inCar, carId, carDamage, stars, down,
   *   navDest: {x,z}|null, routeM, etaS      (navigation's current answer)
   * }
   */
  update(ctx) {
    if (!this.active) return;
    const job = this.job, taxi = job.kind === 'taxi';
    if (ctx.down) { this._end('failed', { reason: 'down' }); return; }
    const tgt = this.target;
    const d = Math.hypot(tgt.x - ctx.x, tgt.z - ctx.z);
    const stopped = Math.abs(ctx.speed || 0) < STOP_V;
    const here = ctx.inCar ? d < ARRIVE_CAR && stopped : !taxi && d < ARRIVE_FOOT;

    if (this.state === 'toPickup' || this.state === 'loading') {
      if (taxi && !ctx.inCar && d < ARRIVE_CAR && !this._hinted) {
        // on foot at the kerb: say why nothing is happening, once
        this._hinted = true;
        this._emit('needCar');
      }
      if (!here) { if (this.state === 'loading') { this.state = 'toPickup'; this._load = 0; } return; }
      if (!taxi) { this._startDrop(ctx); return; }
      if (this.state === 'toPickup') { this.state = 'loading'; this._load = 0; this._emit('loading'); }
      this._load += ctx.dt;
      if (this._load >= LOAD_S) this._startDrop(ctx);
      return;
    }

    // ---- toDrop ----
    this.elapsed += ctx.dt;
    if (!this.limitS) this._settleLimit(ctx);
    this._trackDamage(ctx);
    if ((ctx.stars | 0) > this._stars) this._stars = ctx.stars | 0;
    if (taxi) {
      if (ctx.inCar) {
        this._outT = 0;
        this.smooth.sample(ctx.dt, ctx.speed, ctx.carDamage);
        if (ctx.carDamage >= 1) { this._end('failed', { reason: 'wreck' }); return; }
      } else {
        this._outT += ctx.dt;
        if (this._outT > OUT_MAX) { this._end('failed', { reason: 'left' }); return; }
      }
    }
    if (this.limitS && this.elapsed >= this.limitS) {
      this._end('failed', { reason: taxi ? 'patience' : 'late' });
      return;
    }
    if (!here) return;
    const left = this.limitS ? this.limitS - this.elapsed : 0;
    if (taxi) {
      const pay = taxiPay({ routeM: this.routeM, smooth: this.smooth.score });
      this._end('done', { pay, smooth: this.smooth.score, routeM: this.routeM, timeS: this.elapsed });
    } else {
      const limitS = this.limitS || courierLimitS(this.routeM);
      const pay = courierPay({ routeM: this.routeM, timeLeftS: this.limitS ? left : limitS / 2,
        limitS, damage: this._dmg, stars: this._stars, kind: job.kind });
      this._end('done', { pay, routeM: this.routeM, timeS: this.elapsed,
        timeLeftS: left, limitS, damage: this._dmg, stars: this._stars });
    }
  }

  // ---- persistence ---------------------------------------------------------
  // Only two stages survive a reload: on the way to the pick-up, and a courier
  // with the parcel aboard (the parcel is on the PLAYER). A fare sitting in a
  // car cannot be restored into a session that starts on foot, so that one is
  // simply not written.
  toJSON() {
    if (!this.active) return null;
    if (this.state === 'toDrop' && this.job.kind === 'taxi') return null;
    return {
      job: this.job,
      state: this.state === 'loading' ? 'toPickup' : this.state,
      elapsed: Math.round(this.elapsed), limitS: this.limitS, routeM: Math.round(this.routeM),
      dmg: +this._dmg.toFixed(3), stars: this._stars,
    };
  }

  restore(data) {
    if (this.active || !data || !validJob(data.job)) return false;
    if (data.state !== 'toPickup' && data.state !== 'toDrop') return false;
    if (data.state === 'toDrop' && data.job.kind === 'taxi') return false;
    this.job = data.job;
    this.state = data.state;
    this.elapsed = num(data.elapsed); this.limitS = num(data.limitS);
    this.routeM = num(data.routeM) || estRouteM(this.job.distM);
    this._dmg = num(data.dmg); this._stars = num(data.stars) | 0;
    this._dmgLast = null; this._carId = null; this._routeT = 0; this._outT = 0;
    this._load = 0; this._hinted = false;
    this.smooth.reset();
    this._emit('restored');
    return true;
  }
}

const num = (v) => (Number.isFinite(v) && v > 0 ? v : 0);
const okPlace = (p) => p && typeof p.name === 'string' && Number.isFinite(p.x) && Number.isFinite(p.z);

/** A job read back from storage is player-editable text: check its shape. */
export function validJob(j) {
  return !!j && typeof j.id === 'string' && (j.kind === 'courier' || j.kind === 'taxi' || j.kind === 'haul')
    && okPlace(j.from) && okPlace(j.to) && Number.isFinite(j.distM);
}
