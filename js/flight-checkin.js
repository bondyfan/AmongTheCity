// ---- flight-checkin.js: the ground half of a flight, from the desk to the stairs ----
// js/flight.js owns the aircraft and the cabin; this owns what happens before
// them, at either kind of airport:
//   Pardubice   the terminal is built inside (js/airport-terminal.js): E at
//               counter 3 or 4 opens the list of destinations, the security
//               arch is walked through, the gate agent scans the pass
//   Prague, SEZ the terminal is the region's solid OSM building: E at the desk
//               in front of it sells, checks and boards in one, and the screen
//               goes dark through the terminal to the apron (js/flight-sez.js)
// and, for both, the five minutes of js/flight-schedule.js with the
// announcements that mark them (js/flight-announce.js).
//
// THE CAMPAIGN. While a part of the Last Train is under way the desks sell
// nothing and say why: the flight reloads the page into another region, and
// the campaign is not saved before its end (js/career.js), so a flight in the
// middle of it would throw the evening away without asking.

import { buyTicket, advance, reached, ROUTES, routesFrom } from './flight-trip.js';
import { newSchedule, scheduleAt, countdownText, STATUS } from './flight-schedule.js';
import { bookingPanel } from './flight-booking.js';
import { lines } from './flight-lines.js';
import { tod } from './worldclock.js';

// one panel for the page: flights are made and dropped as the player comes and goes
let panel = null, current = null;

/**
 * @param c { player, wallet, hud, say(who, what, secs, chime), steps (Pardubice) | null, passage | null,
 *            terminal | null, pa, homeId, storyBusy(), getTrip(), setTrip(t), sold(route) }
 */
export function checkIn(c) {
  const { player, wallet } = c;
  let clock = 0, sched = null, phase = null, missedSaid = false, waitSaid = false, buyQuick = false;
  const busy = (t) => t.state !== 'none' && t.state !== 'done';
  // on the aircraft or about to be: from the cabin door to stepping off at the far end
  const midTrip = (t) => reached(t, 'aboard') && t.state !== 'done';
  const route = () => ROUTES[c.getTrip().dir] ?? routesFrom(c.homeId)[0];
  const deskTitle = () => c.homeId === 'SEZ' ? 'Letíme domů' : 'Kam letíme?';

  function openList() {
    // (one panel for the page, so its buttons always ask the flight that is here now)
    panel ??= bookingPanel({ money: () => current?.money() ?? 0, onBuy: (d) => current?.buy(d) ?? false });
    current = { money: () => (typeof wallet.money === 'function' ? wallet.money() : 0), buy };
    panel.open(c.homeId, deskTitle());
  }
  function buy(d) {
    if (busy(c.getTrip()) || c.storyBusy()) return false;
    const r = buyTicket(c.getTrip(), wallet, d.route, tod());
    if (!r.ok) {
      if (r.why === 'money') c.say('Odbavení', lines.noMoney(ROUTES[d.route].fare), 6);
      return false;
    }
    let t = r.trip;
    // the desks that are the whole terminal: security and the gate are behind the black
    if (c.passage) t = advance(advance(t, 'security').trip, 'gate').trip;
    c.setTrip(t);
    c.sold(ROUTES[d.route]);
    buyQuick = !!c.passage;
    sched = newSchedule(clock, buyQuick);
    phase = null; missedSaid = false; waitSaid = false;
    c.say(c.passage ? 'Odbavení' : 'Přepážka', c.passage ? lines.soldThrough(t, ROUTES[d.route]) : lines.sold(t, ROUTES[d.route]), 9);
    if (c.passage) setTimeout(() => c.passage.through(true), 900);
    return true;
  }

  /** E. → true when the desk side took the key. */
  function use(at) {
    const trip = c.getTrip();
    if (c.steps?.counterAt(at.x, at.z)) {
      if (busy(trip)) c.say('Přepážka', lines.haveTicket(trip), 5);
      else if (c.storyBusy()) c.say('Přepážka', lines.storyFirst, 8);
      else openList();
      return true;
    }
    if (c.steps && trip.state === 'airside' && c.steps.deskAt(at.x, at.z, trip.gate)) {
      const s = sched && scheduleAt(sched, clock);
      if (s && !s.open) { c.say('Gate ' + trip.gate, lines.notYet(s.toBoarding), 5); return true; }
      c.setTrip(advance(trip, 'gate').trip);
      c.terminal?.setGate(trip.gate, true);
      c.say('Gate ' + trip.gate, lines.boarding, 8);
      return true;
    }
    if (c.passage && !c.passage.busy && c.passage.nearDesk(at)) {
      if (busy(trip) && !reached(trip, 'aboard')) c.passage.through(true);
      else if (c.storyBusy()) c.say('Odbavení', lines.storyFirst, 8);
      else if (!busy(trip)) openList();
      return true;
    }
    // after a flight in: the terminal's door out to the forecourt
    if (c.passage && !c.passage.busy && c.passage.nearAirside(at) && !midTrip(trip)) {
      c.passage.through(false);
      return true;
    }
    return false;
  }

  /** The E button's label here, or '' when the desks have nothing to offer. */
  function action(at) {
    const trip = c.getTrip();
    const fare = (routesFrom(c.homeId)[0]?.fare ?? 0).toLocaleString('cs-CZ') + ' Kč';
    if (c.steps?.counterAt(at.x, at.z)) return busy(trip) ? '' : 'Vybrat let (' + fare + ')';
    if (c.steps && trip.state === 'airside' && c.steps.deskAt(at.x, at.z, trip.gate)) return 'Naskenovat palubní vstupenku';
    if (c.passage?.nearDesk(at)) return busy(trip) && !reached(trip, 'aboard') ? 'Projít na plochu' : busy(trip) ? '' : (c.homeId === 'SEZ' ? 'Letenka domů' : 'Vybrat let') + ' (' + fare + ')';
    if (c.passage?.nearAirside(at) && !midTrip(trip)) return 'Projít terminálem ven';
    return '';
  }

  /** Each frame: the clock, the announcements, a missed flight. */
  function tick(dt) {
    clock += dt;
    const trip = c.getTrip();
    if (!sched || !busy(trip) || reached(trip, 'flying')) return;
    const s = scheduleAt(sched, clock), r = route();
    if (s.phase !== phase) {
      phase = s.phase;
      const id = { boarding: 'board-', lastCall: 'last-', closing: 'close-' }[phase];
      if (id && !reached(trip, 'aboard')) {
        c.pa?.say(id + r.pa, { where: 'terminal' });
        c.say('Hlášení', c.pa?.subtitle?.(id + r.pa) || lines.pa(phase, r), 9);
      }
    }
    if (s.phase !== 'due') return;
    if (!reached(trip, 'boarding')) {
      // never reached the gate: on the next one, free, boarding at once
      sched = newSchedule(clock, true);
      phase = null;
      if (!missedSaid) { missedSaid = true; c.say('Odbavení', lines.missed(trip, r), 10); }
    } else if (!reached(trip, 'seated') && !waitSaid) {
      waitSaid = true;
      c.say('Palubní průvodčí', lines.waiting, 7);
    }
  }

  /** The boarding pass's two times: { board, dep }. */
  function when() {
    if (!sched) return null;
    const s = scheduleAt(sched, clock);
    return { board: s.open ? 'probíhá' : countdownText(s.toBoarding), dep: countdownText(s.left) };
  }
  /** The departure boards' rows for this airport. `phase` is the aircraft's. */
  function boardRows(seqPhase) {
    const trip = c.getTrip();
    return routesFrom(c.homeId).map((r) => {
      const mine = trip.dir === r.dir && busy(trip);
      let time = 'do 5 min', status = 'Odbavení';
      if (mine && reached(trip, 'flying')) { time = 'nyní'; status = seqPhase === 'doors' || seqPhase === 'taxiOut' ? 'Odlétá' : 'Odletěl'; }
      else if (mine && sched) { const s = scheduleAt(sched, clock); time = countdownText(s.left); status = STATUS[s.phase]; }
      return { time, no: r.no, to: r.to === 'SEZ' ? 'Mahé (SEZ)' : r.toName + ' (' + r.to + ')', via: r.via, gate: r.gate, status };
    });
  }

  return { use, action, tick, when, boardRows, buy, get schedule() { return sched && scheduleAt(sched, clock); },
    close() { panel?.close(); } };
}
