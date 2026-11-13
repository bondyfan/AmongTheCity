// ---- Job maths: how long a job may take and what it pays ----
// Pure numbers, no DOM, no three.js, no clock of its own: every function here
// is a formula over its arguments, so tests/jobs.test.mjs can pin the whole
// pay table without booting a city. js/jobs.js is the only caller in the game.
//
// Money is returned in whole koruna (the wallet rounds anyway, but a breakdown
// whose parts do not add up to its total is the kind of bug a player spots).

import { PRICE } from './prices.js';

// A straight line is what the board knows before anybody has routed anything.
// Pardubice's grid and its two rivers put the road distance at about a third
// over the bee line; the real figure replaces this the moment navigation.js
// has a route (see JobRunner in js/jobs.js).
export const ROUTE_K = 1.35;
export function estRouteM(straightM) {
  return Math.max(0, straightM) * ROUTE_K;
}

// Average speed a careful driver holds through town, lights included. Only the
// fallback uses it: with a route in hand the limit comes from the route's own
// free-flow seconds, which already know a 30 zone from a ring road.
const TOWN_V = 9;            // m/s, about 32 km/h
const LIMIT_MIN = 75;        // s: a job across the street still gets a minute
const LIMIT_MAX = 1800;      // s: and nothing runs longer than half an hour

function clampLimit(s) {
  return Math.round(Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, s)));
}

/** Seconds a courier has from pick-up to drop-off. `etaS` is navigation's
 *  free-flow time for the route, or null when there is no route yet. */
export function courierLimitS(routeM, etaS = null) {
  const base = Number.isFinite(etaS) && etaS > 0 ? etaS * 1.55 : routeM / TOWN_V;
  return clampLimit(base + 40);
}

/** How long a fare will sit in the car before getting out. Generous on
 *  purpose: the taxi is the calm job, its skill is smoothness and not haste. */
export function taxiLimitS(routeM, etaS = null) {
  const base = Number.isFinite(etaS) && etaS > 0 ? etaS * 2.4 : routeM / TOWN_V * 1.6;
  return clampLimit(base + 75);
}

const DMG_STEP = 0.08;       // payout lost per 0.1 of fresh crash damage
const DMG_CAP = 0.5;
const STAR_STEP = 0.15;      // payout lost per wanted star earned on the job
const STAR_CAP = 0.45;
const PAY_FLOOR = 0.25;      // a delivered parcel always pays something

/**
 * Courier pay. Distance sets the rate, the time left sets the bonus, and what
 * the parcel went through on the way (crashes, the police) comes off the top.
 * Returns the breakdown the result toast prints.
 */
export function courierPay({ routeM, timeLeftS, limitS, damage = 0, stars = 0 }) {
  const d = PRICE.job.delivery;
  const km = Math.max(0, routeM) / 1000;
  const gross = d.base + d.perKm * km;
  // Full bonus with half the clock still to run: a bonus that only pays for a
  // perfect run is one nobody ever sees.
  const frac = limitS > 0 ? Math.min(1, Math.max(0, timeLeftS) / (limitS * 0.5)) : 0;
  const bonus = d.bonus * frac;
  // a corrupt reading is no damage, not a NaN payout
  const dmg = Number.isFinite(damage) && damage > 0 ? damage : 0;
  const st = Number.isFinite(stars) && stars > 0 ? stars : 0;
  const cutDamage = Math.min(DMG_CAP, dmg / 0.1 * DMG_STEP);
  const cutFines = Math.min(STAR_CAP, st * STAR_STEP);
  const keep = Math.max(PAY_FLOOR, 1 - cutDamage - cutFines);
  // The parts are rounded FIRST and the total is made of the rounded parts:
  // the toast prints all three, and 701 + 280 must not be paid out as 982.
  const g = Math.round(gross), b = Math.round(bonus);
  const total = Math.round((g + b) * keep);
  return { gross: g, bonus: b, cut: g + b - total, cutDamage, cutFines, total };
}

/** Taxi fare: the flag fall plus the metres, and up to `smooth` on top for a
 *  ride the passenger did not have to hold on through. `smooth` is 0..1. */
export function taxiPay({ routeM, smooth = 0 }) {
  const t = PRICE.job.taxi;
  const km = Math.max(0, routeM) / 1000;
  const fare = t.flag + t.perKm * km;
  const k = Math.min(1, Math.max(0, smooth));
  const f = Math.round(fare), b = Math.round(fare * t.smooth * k);
  return { fare: f, bonus: b, total: f + b };     // parts first, as in courierPay
}

/** What the board prints before the job starts: the best case, honestly
 *  labelled "až" by the UI. */
export function payEstimate(kind, straightM) {
  const routeM = estRouteM(straightM);
  if (kind === 'taxi') return taxiPay({ routeM, smooth: 1 }).total;
  const limitS = courierLimitS(routeM);
  return courierPay({ routeM, timeLeftS: limitS, limitS }).total;
}

// ---- smooth driving -------------------------------------------------------
// The score a fare gives the ride. Two things cost points: standing on the
// brakes AT SPEED, and hitting things. Acceleration is free (the cars here pull
// five metres a second squared and nobody minds) and so is cornering, because
// the road network asks for it.
//
// The brake pedal is a key, so every stop is a full 11 m/s2 stop; what the
// driver controls is how fast they were going when they pressed it. So the
// cost of a second on the brakes scales with speed: lifting off early and
// rolling up to the lights is nearly free, an emergency stop from 50 km/h is
// about four points, and five of those in one ride cost a fifth of the bonus.
const HARSH_A = 7.5;         // m/s2 of deceleration that throws a passenger forward
const HARSH_PTS = 6;         // points per second spent past it at V_REF
const V_REF = 14;            // m/s (50 km/h): the speed a hard stop is priced at
const CRASH_PTS = 260;       // points per 1.0 of crash damage (a 0.1 tap = 26)

export class Smoothness {
  constructor() { this.reset(); }
  reset() { this.pts = 0; this._v = null; this._dmg = null; }
  /** One step: ground speed in m/s, the car's damage scalar. */
  sample(dt, speed, damage) {
    if (!(dt > 0)) return;
    const v = Math.abs(speed) || 0;
    if (this._v !== null) {
      const a = (v - this._v) / dt;
      // dt is clamped upstream; a spike here would bill one long frame as an
      // emergency stop
      if (a < -HARSH_A && dt < 0.2) this.pts += HARSH_PTS * dt * Math.min(1.5, this._v / V_REF);
    }
    this._v = v;
    const dmg = Number.isFinite(damage) ? damage : 0;
    if (this._dmg !== null && dmg > this._dmg) this.pts += (dmg - this._dmg) * CRASH_PTS;
    this._dmg = dmg;
  }
  /** Changing cars mid-fare must not bill the new car's old dents. */
  rebase() { this._v = null; this._dmg = null; }
  get score() { return Math.min(1, Math.max(0, 1 - this.pts / 100)); }
}

/** "4:05", and "0:00" rather than a negative clock. */
export function fmtClock(s) {
  const t = Math.max(0, Math.ceil(s));
  return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}

/** "850 m" / "2,4 km": Czech decimal comma, the way the map prints it. */
export function fmtDist(m) {
  if (!(m >= 0)) return '';
  if (m < 950) return Math.round(m / 10) * 10 + ' m';
  return (m / 1000).toFixed(1).replace('.', ',') + ' km';
}
