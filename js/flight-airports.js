// ---- flight-airports.js: the two ends of the trip, in one shape ----
// Pure data and arithmetic. The flight (js/flight.js) never asks "am I in
// Pardubice": it asks the airport it is at for a departure runway, a taxi
// route out, an outbound track, a landing runway, the taxi route in and the
// stand. Pardubice comes from js/airport-plan.js; Seychelles International
// (FSIA/SEZ) comes from the Mahé region (REGIONS.mahe.airport of js/regions.js,
// the other session's work) once its data exists.
//
// UNTIL MAHÉ EXISTS the far end is a placeholder that is honest about being
// one: the aircraft flies the whole trip and comes back down on 27 at
// Pardubice, and the HUD says so. Everything a real arrival does (the
// approach, the flare, the rollout, the taxi in, the stairs, getting off) is
// exercised by it, which is why it exists.

import { RUNWAY, LINEUP, TAXI_OUT, TAXI_IN, EXIT_27, STAND } from './airport-plan.js';
import { headingOf } from './flight-path.js';
import { taxiNetwork, nearestNode, shortest } from './flight-taxiways.js';

const bearing = (deg) => -deg * Math.PI / 180; // compass bearing → heading (ARCHITECTURE.md)
const [ax, az] = RUNWAY.a, [bx, bz] = RUNWAY.b;

export const LKPD = {
  id: 'LKPD', iata: 'PED', region: 'cz', name: 'Pardubice',
  // runway frames: { x, z } where the wheels start, heading of travel; y filled from the terrain
  depart: { x: LINEUP.x, z: LINEUP.z, heading: headingOf(bx - ax, bz - az) },
  land: { x: bx, z: bz, heading: headingOf(ax - bx, az - bz) },
  taxiOut: TAXI_OUT,
  taxiIn: TAXI_IN,
  exit: EXIT_27,
  stand: STAND,
  // the great circle to Mahé leaves Pardubice on about 141 degrees
  outbound: bearing(141),
};

/**
 * Seychelles International from the Mahé region's description (REGIONS.mahe
 * .airport of js/regions.js), in region metres:
 *   { runway: { ends: { '13': { x, z, elev }, '31': { x, z, elev } } } (or { a, b }),
 *     stand: { x, z, heading }, terminal: { landside: { x, z } }, taxiOut?, taxiIn? }
 * Landing and departing are both on 13: into the south-east trade wind, from
 * the north-west over the sea. SEZ has no parallel taxiway (the runway lies
 * on reclaimed land, the apron and the terminal by its north-western 13 end),
 * so an aircraft leaving backtracks along the runway to the 13 end, turns on
 * the pad and lines up; one arriving rolls out, turns round on the runway
 * (js/flight-sequence.js) and backtracks to the apron. Those are the
 * routes drawn here when the region gives none. The way home leaves on about
 * 320 degrees, toward Dubai.
 */
export function seychelles(desc, roadsFn = null) {
  const rw = desc?.runway;
  const pa = rw?.ends?.['13'] ? [rw.ends['13'].x, rw.ends['13'].z] : rw?.a;
  const pb = rw?.ends?.['31'] ? [rw.ends['31'].x, rw.ends['31'].z] : rw?.b;
  if (!pa || !pb || !desc.stand) return null;
  const h13 = headingOf(pb[0] - pa[0], pb[1] - pa[1]);
  const dx = -Math.sin(h13), dz = -Math.cos(h13);
  // the runway frame: s metres from the 13 threshold toward 31, e to the right of that
  const at = (s, e) => [pa[0] + dx * s - dz * e, pa[1] + dz * s + dx * e];
  const st = desc.stand;
  const ss = (st.x - pa[0]) * dx + (st.z - pa[1]) * dz, se = (st.x - pa[0]) * -dz + (st.z - pa[1]) * dx;
  const side = Math.sign(se) || 1;
  // behind the stand along its own heading, where a crew lines up to roll onto it
  const back = [st.x + Math.sin(st.heading) * 45, st.z + Math.cos(st.heading) * 45];
  const lineup = at(150, 0);
  // the check-in for the way home: on the forecourt just outside the landside
  // door (the canopy before it is a solid block in the region's data), the
  // agent's side toward the terminal, the passenger's toward the street
  let desk = desc.desk ?? null;
  const ls = desc.terminal?.landside;
  if (!desk && ls) {
    const ex = st.x - ls.x, ez = st.z - ls.z, L = Math.hypot(ex, ez) || 1;
    desk = { x: ls.x - (ex / L) * 1.5, z: ls.z - (ez / L) * 1.5, heading: headingOf(ex, ez) };
  }
  // Without the tile's taxiways (or before they have streamed in): the straight
  // way from the stand to the runway, a backtrack to the 13 end and the pad.
  const plain = {
    out: desc.taxiOut ?? [[st.x, st.z], [st.x + -Math.sin(st.heading) * 30, st.z + -Math.cos(st.heading) * 30],
      at(ss - 60, side * 20), at(ss - 120, 0), at(90, 0), at(28, side * -14), at(28, side * 14), at(95, side * 2), lineup],
    in: desc.taxiIn ?? [at(ss + 70, 0), at(ss + 70, se * 0.55), back, [st.x, st.z]],
  };
  // With them: out along the mapped taxiway to the 13 end, in from the runway
  // by whichever mapped link is nearest the rollout (js/flight-taxiways.js).
  let mapped = null;
  const routes = () => {
    if (mapped || desc.taxiOut || !roadsFn) return mapped ?? plain;
    const roads = roadsFn() ?? [];
    const net = roads.length ? taxiNetwork(roads) : null;
    if (!net || !net.nodes.some((n) => n.runway)) return plain;
    const apron = (n, i) => !n.runway && Math.hypot(n.x - back[0], n.z - back[1]) < 110;
    const end = at(30, 0), roll = at(1400, 0);
    const a = nearestNode(net, st.x, st.z, (n) => !n.runway);
    const goalOut = nearestNode(net, end[0], end[1], (n) => n.runway);
    const out = a >= 0 && goalOut >= 0 ? shortest(net, a, goalOut) : null;
    const r = nearestNode(net, roll[0], roll[1], (n) => n.runway);
    const inn = r >= 0 ? shortest(net, r, (i) => apron(net.nodes[i], i)) : null;
    if (!out || !inn) return plain;
    mapped = { out: [[st.x, st.z], ...out, lineup], in: [...inn, back, [st.x, st.z]] };
    return mapped;
  };
  return {
    id: 'FSIA', iata: 'SEZ', region: 'mahe', name: 'Mahé',
    depart: { x: lineup[0], z: lineup[1], heading: h13 },
    land: { x: pa[0], z: pa[1], heading: h13 },
    get taxiOut() { return routes().out; },
    get taxiIn() { return routes().in; },
    exit: { x: at(ss + 70, 0)[0], z: at(ss + 70, 0)[1] },
    stand: st,
    desk,
    elev: rw?.ends?.['13']?.elev ?? null,
    outbound: bearing(320),
  };
}

/** The airport at the far end of a route: the real SEZ when the region gives one, else the placeholder. */
export function destinationOf(route, mahe = null, roadsFn = null) {
  if (route.to === 'PED') return { airport: LKPD, placeholder: false };
  const sez = seychelles(mahe, roadsFn);
  return sez ? { airport: sez, placeholder: false } : { airport: LKPD, placeholder: true };
}
