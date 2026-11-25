// ---- flight-life.js: when the airports and their flight exist ----
// main.js holds one of these and calls update() once a frame; it keeps the
// rest of main.js down to a handful of lines. It owns:
//   · world.airport (js/airport-hooks.js), with the Pardubice terminal's near
//     set (js/airport-terminal.js) plugged in on the Czech side;
//   · the flight (js/flight.js) of the airport the player is at: Pardubice or
//     Prague at home, Seychelles International on Mahé. Made when he comes
//     within 2.5 km of one, disposed past 3.5 km unless a trip is under way,
//     which keeps the airliner, its cabin and its sound out of every frame
//     that is nowhere near an airport. It is made during the campaign too
//     (Frank, 25 Nov 2026: in Pardubice "nevidím možnost letět"): the desks
//     then say why they sell nothing, instead of the airport standing empty;
//   · the check-in sets before the terminals that are solid OSM buildings
//     (Prague's Terminal 1, SEZ) and the doors through them to the apron;
//   · the departure boards' rows;
//   · the arrival from another region (a flight that was in the air when the
//     page switched): resumed at the airport it lands at, as soon as the world
//     exists.

import { createFlight } from './flight.js';
import { AirportTerminal } from './airport-terminal.js';
import { airportHooks } from './airport-hooks.js';
import { FRAME } from './airport-plan.js';
import { ROUTES } from './flight-trip.js';
import { seychelles } from './flight-airports.js';
import { prague } from './flight-lkpr.js';
import { sezDesk } from './flight-sezdesk.js';
import { prgDesk } from './flight-prgdesk.js';
import { doorToward } from './flight-sez.js';
import { airportPeople, deskStaff } from './airport-people.js';
import { CHUNK } from './config.js';

const NEAR = 2500, FAR = 3500;
// the airport a route lands at, by its IATA code
const ARRIVES = { PED: 'LKPD', PRG: 'LKPR', SEZ: 'SEZ' };

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
  // the people in Pardubice's terminal: agents, officers, passengers (js/airport-people.js)
  const people = czech ? airportPeople(scene, world) : null;
  // the airports of this page: where each is, its desk set and the terminal the passage goes through
  const prg = czech ? prague() : null, sez = czech ? null : seychelles(region.mahe);
  const ports = czech
    ? [{ id: 'LKPD', centre: { x: FRAME.x, z: FRAME.z } },
      // (at Prague the way in from the apron is the non-Schengen pier, Prst B, between the stand and Terminal 1)
      ...(prg ? [{ id: 'LKPR', centre: prg.stand, desc: prg, set: prgDesk, terminal: /^Prst B$/ }] : [])]
    : sez ? [{ id: 'SEZ', centre: sez.stand, desc: sez, set: sezDesk, terminal: /terminal/i }] : [];
  let flight = null, port = null, boardT = 0, boardKey = '', pending = null, doorT = 0;

  function make(p) {
    port = p;
    flight = createFlight({
      scene, world, player: o.player(), map: o.map(), sky: o.sky(), wallet: o.wallet, terminal, region, coop: o.coop,
      home: p.id, storyBusy: o.storyBusy,
    });
    world.airport.flight = flight;
  }
  function drop() {
    flight?.dispose();
    flight = null;
    port = null;
    world.airport.flight = null;
  }
  function boards() {
    if (!terminal) return;
    const rows = flight?.home === 'LKPD' ? flight.boardRows()
      : [{ time: 'do 5 min', no: ROUTES.out.no, to: 'Mahé (SEZ)', via: ROUTES.out.via, gate: ROUTES.out.gate, status: 'Odbavení' }];
    const key = JSON.stringify(rows);
    if (key !== boardKey) { boardKey = key; terminal.setBoard(rows); }
  }
  // The parked aircraft and the desk sets stand on the terrain as it is when they are made:
  // made before the tile under them has streamed in (a teleport to Prague, 100 km out)
  // they would stand at height 0, under the ground. So they wait for it.
  const groundAt = (c) => world.terrain?.ready?.(c.x, c.z) ?? true;
  const nearest = (p) => {
    let best = null, bd = Infinity;
    for (const q of ports) {
      const d = Math.hypot(p.x - q.centre.x, p.z - q.centre.z);
      if (d < bd) { bd = d; best = q; }
    }
    return { port: best, d: bd };
  };

  return {
    get flight() { return flight; },
    /** A flight that was in the air when the page switched (enterRegion's carry). */
    resume(carry) { pending = carry ?? null; },
    update(dt, nightK = 0) {
      const player = o.player();
      if (!player) return;
      const p = player.pos;
      terminal?.update(dt, { x: p.x, z: p.z, nightK });
      if (pending && !flight) {
        // the aircraft is made at the airport it lands at
        const id = ARRIVES[ROUTES[pending.trip?.dir]?.to];
        const at = ports.find((q) => q.id === id) ?? ports[0];
        if (at) make(at);
      }
      if (pending && flight) { flight.resume(pending); pending = null; }
      const { port: here, d } = nearest(p);
      if (!flight && here && d < NEAR && groundAt(here.centre)) make(here);
      else if (flight && port && Math.hypot(p.x - port.centre.x, p.z - port.centre.z) > FAR && !flight.busy && !flight.flying) drop();
      flight?.update(dt);
      // the desk sets, built the first time their airport's flight exists, kept after
      for (const q of ports) if (q.set && !q.built && flight && port === q && q.desc.desk && groundAt(q.desc.desk)) {
        q.built = q.set(scene, world, q.desc.desk);
        q.staff = deskStaff(scene, world, q.desc.desk, q.id === 'LKPR' ? 3 : 2);
      }
      for (const q of ports) { q.built?.update(nightK); q.staff?.update(dt, player); }
      people?.update(dt, player);
      // the terminal's door toward the stand: looked for twice a second until its building is in
      if (flight && port?.terminal && !port.airside && (doorT -= dt) <= 0) {
        doorT = 0.5;
        port.airside = findAirside(world, port.desc.stand, port.terminal);
      }
      if (flight && port?.airside) flight.setAirside(port.airside);
      if ((boardT -= dt) <= 0) { boardT = 1; boards(); }
    },
    dispose() {
      drop();
      terminal?.dispose();
      for (const q of ports) { q.built?.dispose(); q.staff?.dispose(); }
      people?.dispose();
      world.airport = null;
    },
  };
}

/** A terminal (the building named so, nearest the stand) and the door on its face toward the stand. */
function findAirside(world, stand, name, max = 700) {
  const idx = world.city?.chunkIndex;
  if (!idx) return null;
  const cx = Math.floor(stand.x / CHUNK), cz = Math.floor(stand.z / CHUNK);
  let best = null, bd = max;
  const R = Math.ceil(max / CHUNK);
  for (let dx = -R; dx <= R; dx++) for (let dz = -R; dz <= R; dz++) {
    for (const f of idx.get((cx + dx) + ',' + (cz + dz))?.buildings ?? []) {
      if (!name.test(f.n ?? '') || !f.o?.length) continue;
      const door = doorToward(f.o, stand, 3);
      const dd = door ? Math.hypot(door.x - stand.x, door.z - stand.z) : Infinity;
      if (dd < bd) { bd = dd; best = door; }
    }
  }
  return best;
}
