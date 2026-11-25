// ---- flight-trip.js: the passenger's side of a flight, as a small state machine ----
// Pure: no three.js, no DOM, no clock of its own. The wallet is handed in, so
// a test can pay with a stub and the game pays with js/wallet.js.
//
// A trip goes one way only, and each step needs the one before it, the way an
// airport insists:
//
//   none ──buy──▶ ticket ──security──▶ airside ──gate──▶ boarding ──aboard──▶
//   aboard ──sit──▶ seated ──depart──▶ flying ──land──▶ arrived ──leave──▶ done
//
// What it refuses is as much the point as what it allows: no seat without a
// ticket, no gate before the security lane (walking round the terminal over
// the grass gets you as far as the airstairs, where the cabin crew turn you
// back), no second ticket while one is unused. The flight itself (the doors,
// the taxi, the take-off) is js/flight.js; this file only knows where the
// PASSENGER is in it.
//
// THE TWO FLIGHTS. Pardubice (PED) to the Seychelles (SEZ) is about 7 800 km:
// no narrowbody does it in one, and nobody flies it direct, so the trip is
// sold with a stop in Dubai, about ten hours door to door, as the brief asks.
// The carrier is invented (the game copies no airline): its code is ATC.

import { PRICE } from './prices.js';

export const ROUTES = {
  out: {
    dir: 'out', no: 'ATC 740', from: 'PED', to: 'SEZ', fromName: 'Pardubice', toName: 'Mahé (Seychely)',
    via: 'Dubaj', fare: PRICE.flight.mahe, gate: '2', seat: '14A', hours: 10.2, tzShift: 3, region: 'mahe',
  },
  home: {
    dir: 'home', no: 'ATC 741', from: 'SEZ', to: 'PED', fromName: 'Mahé', toName: 'Pardubice',
    via: 'Dubaj', fare: PRICE.flight.mahe, gate: '1', seat: '14A', hours: 10.6, tzShift: -3, region: 'cz',
  },
};
const ORDER = ['none', 'ticket', 'airside', 'boarding', 'aboard', 'seated', 'flying', 'arrived', 'done'];

export function newTrip() {
  return { state: 'none', dir: null, no: null, seat: null, gate: null, paid: 0, depMin: null };
}
export const stepOf = (trip) => ORDER.indexOf(trip.state);
/** Is the trip at least at `state`? */
export const reached = (trip, state) => stepOf(trip) >= ORDER.indexOf(state);

/**
 * The departure time the boards show, in minutes after midnight: the next
 * five minutes that leave half an hour for check-in, security and boarding.
 * (A game hour is one real minute, so the half hour is thirty real seconds of
 * nobody minding a dawdler: the aircraft waits for its passenger.)
 */
export function departureMinute(tod01) {
  const now = (((tod01 % 1) + 1) % 1) * 1440;
  return Math.ceil((now + 30) / 5) * 5 % 1440;
}
export const clockText = (min) => {
  const m = ((Math.round(min) % 1440) + 1440) % 1440;
  return Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0');
};

/**
 * Buy the ticket for `dir` at a counter. `wallet` is { canPay(n), pay(n, what) }.
 * → { ok, trip, why } where why is 'have' (already holding it), 'money' or 'busy'.
 */
export function buyTicket(trip, wallet, dir, tod01 = 0) {
  const r = ROUTES[dir];
  if (!r) return { ok: false, trip, why: 'route' };
  if (trip.state !== 'none' && trip.state !== 'done') {
    return { ok: trip.dir === dir, trip, why: trip.dir === dir ? 'have' : 'busy' };
  }
  if (!wallet.canPay(r.fare) || !wallet.pay(r.fare, 'letenka ' + r.no)) return { ok: false, trip, why: 'money' };
  const next = { state: 'ticket', dir, no: r.no, seat: r.seat, gate: r.gate, paid: r.fare, depMin: departureMinute(tod01) };
  return { ok: true, trip: next, why: null };
}

// Each event moves the trip on by exactly one step, and only from the step
// before it. Anything else leaves it as it was and says why.
const EVENTS = {
  security: ['ticket', 'airside'],
  gate: ['airside', 'boarding'],
  aboard: ['boarding', 'aboard'],
  sit: ['aboard', 'seated'],
  depart: ['seated', 'flying'],
  land: ['flying', 'arrived'],
  leave: ['arrived', 'done'],
};
/** → { ok, trip, why }. `why` names the step that is missing. */
export function advance(trip, event) {
  const e = EVENTS[event];
  if (!e) return { ok: false, trip, why: 'event' };
  if (trip.state === e[1]) return { ok: true, trip, why: null };         // already there: harmless
  if (trip.state !== e[0]) return { ok: false, trip, why: trip.state };
  return { ok: true, trip: { ...trip, state: e[1] }, why: null };
}

/**
 * What the cabin crew at the top of the airstairs say to someone who arrives
 * with this trip, or null to let him in. Czech: the player reads it.
 */
export function crewCheck(trip) {
  if (trip.state === 'none' || trip.state === 'done') return 'Palubní vstupenku, prosím. Letenky prodávají u přepážek v terminálu.';
  if (trip.state === 'ticket') return 'Nejdřív musíte projít bezpečnostní kontrolou v terminálu.';
  if (trip.state === 'airside') return 'Nástup začne u gate ' + trip.gate + '. Nechte si tam naskenovat palubní vstupenku.';
  return null;
}

// ---- the hand-over across the region switch -----------------------------------
// The other region is another page (js/regions.js of the Mahé work reloads the
// game with ?region=), so everything the far side needs travels as JSON:
// the trip, the hour the montage ended on, and where the aircraft is.
export const CARRY_V = 1;
/** The flight's part of enterRegion's `carry`. */
export function carryFor(trip, extra = {}) {
  return { v: CARRY_V, trip: { ...trip }, ...extra };
}
/**
 * Read a carry back. → the trip, or null when it is not one of ours, is from
 * another version, or does not describe a flight in the air.
 */
export function tripFromCarry(c) {
  if (!c || c.v !== CARRY_V || !c.trip || !ROUTES[c.trip.dir]) return null;
  if (c.trip.state !== 'flying') return null;
  const t = newTrip();
  for (const k of Object.keys(t)) if (k in c.trip) t[k] = c.trip[k];
  return t;
}

/**
 * The sky's hour across the trip: `k` 0..1 of the way from take-off to
 * landing, `dep` the departure hour 0..1 at home. The clock in the window
 * runs the flight's hours and jumps the time zone at the stop, so it lands
 * at the local hour of the far side. → hour of the day 0..1.
 */
export function skyHour(route, dep, k) {
  const h = route.hours * k + (k > 0.55 ? route.tzShift : 0);
  const t = dep + h / 24;
  return t - Math.floor(t);
}
/** The local hour on arrival, 0..1. */
export const arrivalHour = (route, dep) => skyHour(route, dep, 1);
