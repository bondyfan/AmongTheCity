// ---- flight-lkpr.js: Václav Havel Airport Prague (LKPR, PRG) as plain data ----
// WORKER SAFE and node-importable: no three.js, no DOM, no clock. The flight
// (js/flight.js), the airport's own life (js/flight-life.js), the map marks
// (js/airport-marks.js) and the spawns (js/main.js) read the airport from here,
// the same shape as seychelles() in js/flight-airports.js:
//   { id, iata, region, name, depart, land, taxiOut, taxiIn, exit, stand, desk,
//     terminal, elev, outbound }
//
// Every number below was read from the tile public/data/tiles/-23_-2.json (OSM
// names and rings, read 25 Nov 2026) and checked by tests/flight-lkpr.test.mjs.
// Conventions: x east, z south, metres from Pardubice station; a heading h is
// the direction (-sin h, -cos h), so the heading of (dx, dz) is atan2(-dx, -dz).

import { headingOf } from './flight-path.js';
import { taxiNetwork, nearestNode, shortest } from './flight-taxiways.js';

const bearing = (deg) => -deg * Math.PI / 180; // compass bearing → heading (ARCHITECTURE.md)

// ---- runway 06/24 (tile road t 'runway', ref '06/24', 45 m wide) ----
// 24 is flown west-south-west from the east end, so its threshold is the east
// end (-106233, -9371) and the take-off roll and the landing both run WSW
// (the brief's runway, 06/24 at 3 724 m, as the tile draws it).
const THR = { x: -106233, z: -9371 };
const FAR = { x: -109608, z: -7800 };
const RW_HEADING = headingOf(FAR.x - THR.x, FAR.z - THR.z); // 115 degrees: 240 magnetic
const TRAVEL = [-Math.sin(RW_HEADING), -Math.cos(RW_HEADING)]; // unit vector of the roll
// the line-up sits 30 m past the threshold, on the centreline, facing the roll
const LINEUP_M = 30;
const LINEUP = { x: THR.x + TRAVEL[0] * LINEUP_M, z: THR.z + TRAVEL[1] * LINEUP_M };
// the junction where a landing aircraft leaves 24 for the apron (about 1.27 km
// from the threshold, where tile taxiway 23 meets the runway; the links nearer the
// threshold are the turn-round for departures, not exits)
const EXIT = { x: -107386, z: -8834 };

export const LKPR_PLAN = {
  // Terminál 1: the OSM ring of that name (centroid -106615, -8527; 36 966 m2; 15 m).
  // The bus-stop forecourt runs along its south-west arm, and its piers stand south
  // of it: Prst A (centroid -106564, -8735, 10 m) and Prst B (centroid -106794,
  // -8568, 10 m). Prst C (-106955, -8311) is a 4.3 m block.
  terminal: { name: 'Terminál 1', centre: { x: -106615, z: -8527 } },
  runway: {
    ref: '06/24', threshold: THR, far: FAR, heading: RW_HEADING,
    lineup: LINEUP, lineupM: LINEUP_M,
  },
  exit: EXIT,
  // The remote stand: a narrowbody's place on the apron north of Prst B (80 m from
  // its ring) and west of Prst A. The apron is tile paved t
  // 'apron' (centroid -106751, -8612). Measured from the aircraft's footprint
  // (37.6 m long, 35.8 m wide, js/airliner-layout.js), the nearest building or
  // fence is 60 m away, and the airfield's own machines (js/airfield.js) are
  // more than 500 m away. Heading 330 (nose NNE): the mapped taxilane junction
  // (-106759, -8742) lies 54 m ahead, within 10 degrees of the nose, so it rolls
  // forward onto the taxiway. The tile maps about 28 m of ground between the apron
  // edge and that junction as neither apron nor taxiway (the approach behind the
  // stand has a 33 m gap of the same kind); every candidate stand has one of 20 m or more.
  stand: { x: -106793.3, z: -8700.8, heading: -Math.PI / 6 },
  // The check-in for the flight home: a counter on the ground-level forecourt of
  // the south-west arm, 12 m from the terminal's face (its nearest point is
  // (-106668.9, -8370.7)), with the agent's side toward the terminal and the
  // passenger's on the street side. A footway is 1.3 m away and the nearest
  // drivable road 4.5 m; no bridge or ramp road comes within 65 m. The bus stops
  // are about 32 m off.
  desk: { x: -106659, z: -8364, heading: headingOf(-106668.9 + 106659, -8370.7 + 8364) },
  // the great circle to Dubai leaves Prague on about 113 degrees; the brief's
  // window of 125 to 130 degrees is the rhumb line, so the outbound uses 127
  outbound: bearing(127),
  // the field's published elevation (380 m AMSL); the game's terrain may differ a few metres
  elevM: 380,
  // a spawn 12.5 km out on the extended centreline, 500 m above the field
  arrivalM: 12500,
};

const KINDS = new Set(['taxiway', 'taxilane', 'runway']);
const ON_RUNWAY = 2; // m: a junction this close to a runway line is on the runway

/** Distance from (x, z) to the nearest segment of any of the polylines `ways`. */
function distToWays(x, z, ways) {
  let best = Infinity;
  for (const w of ways) {
    for (let i = 1; i < w.p.length; i++) {
      const [ax, az] = w.p[i - 1], [bx, bz] = w.p[i];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2));
      best = Math.min(best, Math.hypot(x - ax - ex * t, z - az - ez * t));
    }
  }
  return best;
}

/**
 * Prague's airport. `roadsFn(stand)` gives the mapped taxiway, taxilane and runway
 * roads round the stand as they stream in (js/flight.js passes its own), or null
 * until they have. Without them the routes are the plain ones below: straight
 * from the stand to the exit, along 24 to the threshold and onto the line-up.
 */
export function prague(roadsFn = null) {
  const st = LKPR_PLAN.stand;
  const fx = -Math.sin(st.heading), fz = -Math.cos(st.heading);
  const ahead = [st.x + fx * 40, st.z + fz * 40]; // where the nose points, the roll-out side
  const behind = [st.x - fx * 40, st.z - fz * 40]; // where a taxi in arrives from
  const thr = [THR.x, THR.z], line = [LINEUP.x, LINEUP.z];
  const plain = {
    out: [[st.x, st.z], ahead, [EXIT.x, EXIT.z], thr, line],
    in: [[EXIT.x, EXIT.z], behind, [st.x, st.z]],
  };
  let mapped = null;
  const routes = () => {
    if (mapped) return mapped;
    const roads = roadsFn ? roadsFn(st) : null;
    if (!roads?.length) return plain;
    mapped = mappedRoutes(roads, { st, ahead, behind, thr, line }) ?? plain;
    return mapped;
  };
  return {
    id: 'LKPR', iata: 'PRG', region: 'cz', name: 'Praha',
    depart: { x: LINEUP.x, z: LINEUP.z, heading: RW_HEADING },
    land: { x: THR.x, z: THR.z, heading: RW_HEADING },
    get taxiOut() { return routes().out; },
    get taxiIn() { return routes().in; },
    exit: { x: EXIT.x, z: EXIT.z },
    stand: { x: st.x, z: st.z, heading: st.heading },
    desk: { ...LKPR_PLAN.desk },
    terminal: { name: LKPR_PLAN.terminal.name },
    elev: null,
    outbound: LKPR_PLAN.outbound,
  };
}

// The routes over the mapped network: out from the apron ahead of the nose to the
// threshold (on the taxiway, then along 24), then onto the line-up; in from the
// runway exit to the apron behind the stand, then straight into the stand, nose first.
function mappedRoutes(roads, p) {
  const ways = roads.filter((r) => KINDS.has(r.t) && r.p?.length > 1);
  const runways = ways.filter((r) => r.t === 'runway');
  if (!runways.length) return null;
  const net = taxiNetwork(ways);
  // the runway flag of taxiNetwork is set by whichever way created a junction first,
  // so the test here is geometric: a junction on a runway line is on the runway
  const onRunway = net.nodes.map((n) => distToWays(n.x, n.z, runways) < ON_RUNWAY);
  const apron = (n, i) => !onRunway[i];
  const fromN = nearestNode(net, p.ahead[0], p.ahead[1], apron);
  const holdN = nearestNode(net, p.thr[0], p.thr[1], (n, i) => onRunway[i]);
  const exitN = nearestNode(net, EXIT.x, EXIT.z, (n, i) => onRunway[i]);
  const backN = nearestNode(net, p.behind[0], p.behind[1], apron);
  if (fromN < 0 || holdN < 0 || exitN < 0 || backN < 0) return null;
  const out = shortest(net, fromN, holdN), inn = shortest(net, exitN, backN);
  if (!out || !inn) return null;
  return {
    out: [[p.st.x, p.st.z], ...out, p.line],
    in: [...inn, p.behind, [p.st.x, p.st.z]],
  };
}

// ---- the spawns (js/regions.js registerSpawns('cz', PRG_SPAWNS) in js/main.js) ----
const DESK_FRONT_M = 2.2; // the passenger stands this far out from the counter, on the street side
const desk = LKPR_PLAN.desk;
const approach = [THR.x - TRAVEL[0] * LKPR_PLAN.arrivalM, THR.z - TRAVEL[1] * LKPR_PLAN.arrivalM];

export const PRG_SPAWNS = {
  // on final for 24, 12.5 km out on the extended centreline, 500 m above the field
  'prg-arrival': {
    x: approach[0], z: approach[1], y: LKPR_PLAN.elevM + 500, heading: RW_HEADING,
  },
  // on foot on the forecourt in front of the check-in, facing the counter
  'prg-airport': {
    x: desk.x + Math.sin(desk.heading) * DESK_FRONT_M,
    z: desk.z + Math.cos(desk.heading) * DESK_FRONT_M,
    heading: desk.heading,
  },
};
