// ---- flight-life.js: when the airport and its flight exist ----
// main.js holds one of these and calls update() once a frame; it keeps the
// rest of main.js down to a handful of lines. It owns:
//   · world.airport (js/airport-hooks.js), with the terminal's near set
//     (js/airport-terminal.js) plugged in on the Czech side;
//   · the flight (js/flight.js): created when the player comes within 2.5 km
//     of the airport (and no part of the campaign is running), disposed past
//     3.5 km unless a trip is under way, which keeps the airliner, its cabin
//     and its sound out of every frame that is nowhere near an airport;
//   · the departure boards' rows;
//   · the arrival from another region (a flight that was in the air when the
//     page switched): resumed as soon as the world exists.

import { createFlight } from './flight.js';
import { AirportTerminal } from './airport-terminal.js';
import { airportHooks } from './airport-hooks.js';
import { FRAME } from './airport-plan.js';
import { ROUTES, departureMinute, clockText, reached } from './flight-trip.js';
import { tod } from './worldclock.js';
import { seychelles } from './flight-airports.js';
import { sezDesk } from './flight-sezdesk.js';

const NEAR = 2500, FAR = 3500;

/**
 * @param o { scene, world, player: () => player, map: () => worldMap, sky: () => sky, wallet, coop: () => bool,
 *            storyBusy: () => bool, region: { id, mahe, enter } }
 */
export function airportLife(o) {
  const { scene, world } = o;
  const region = o.region ?? { id: 'cz', mahe: null, enter: null };
  world.airport = airportHooks();
  const czech = region.id !== 'mahe';
  const terminal = czech ? new AirportTerminal(scene, world) : null;
  world.airport.terminal = terminal;
  // where the airport is: the terminal at home, the stand at SEZ
  const centre = czech ? { x: FRAME.x, z: FRAME.z } : region.mahe?.stand ?? null;
  let flight = null, boardT = 0, boardKey = '', pending = null, desk = null;
  // on Mahé: the counter for the flight home, built when the airport is first near
  const sez = czech ? null : seychelles(region.mahe);

  function make() {
    flight = createFlight({
      scene, world, player: o.player(), map: o.map(), sky: o.sky(), wallet: o.wallet, terminal, region, coop: o.coop,
      home: czech ? 'LKPD' : 'SEZ',
    });
    world.airport.flight = flight;
  }
  function drop() {
    flight?.dispose();
    flight = null;
    world.airport.flight = null;
  }
  function boards() {
    const t = flight?.trip, ph = flight?.phase ?? 'stand';
    const dep = t?.depMin ?? departureMinute(tod());
    const status = !t || t.state === 'none' || t.state === 'done'
      ? (ph === 'stand' ? 'Odbavení' : 'Odletěl')
      : t.state === 'ticket' ? 'Odbavení'
        : t.state === 'airside' ? 'Nástup brzy'
          : reached(t, 'flying') ? (ph === 'doors' || ph === 'taxiOut' ? 'Odlétá' : 'Odletěl') : 'Nástup';
    const r = ROUTES.out;
    const rows = [{ time: clockText(dep), no: r.no, to: 'Mahé (SEZ)', via: r.via, gate: r.gate, status }];
    const key = JSON.stringify(rows);
    if (key !== boardKey) { boardKey = key; terminal?.setBoard(rows); }
  }

  return {
    get flight() { return flight; },
    /** A flight that was in the air when the page switched (enterRegion's carry). */
    resume(carry) { pending = carry ?? null; },
    update(dt, nightK = 0) {
      const player = o.player();
      if (!player) return;
      const p = player.pos;
      terminal?.update(dt, { x: p.x, z: p.z, nightK });
      if (pending && !flight) make();
      if (pending && flight) { flight.resume(pending); pending = null; }
      if (centre) {
        const d = Math.hypot(p.x - centre.x, p.z - centre.z);
        if (!flight && d < NEAR && !o.storyBusy()) make();
        else if (flight && d > FAR && !flight.busy && !flight.flying) drop();
      }
      flight?.update(dt);
      if (sez?.desk && !desk && flight) desk = sezDesk(scene, world, sez.desk);
      desk?.update(nightK);
      if (terminal && (boardT -= dt) <= 0) { boardT = 1; boards(); }
    },
    dispose() { drop(); terminal?.dispose(); desk?.dispose(); world.airport = null; },
  };
}
