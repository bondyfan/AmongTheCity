// ---- flight-terminal.js: check-in, security and the gate at Pardubice ----
// What the passenger does on foot in Terminál Jana Kašpara, read off the plan
// (js/airport-plan.js) in the terminal's own frame: where he can buy the
// ticket (counters 3 and 4, the two open for the Seychelles), where the
// walk-through arch is (crossing its line with a ticket IS the security
// check), and where the gate agent scans the pass. No three.js: the drawing
// is js/airport-terminal.js, and this file only answers "what is here" and
// "what does E do here".
//
// THE OFFICER AT THE LANES. Somebody without a boarding pass who walks into a
// security lane is stopped at its mouth (collide below) and told why: the
// only way airside is through the lanes, and the only way through them is
// with a ticket. With one, he walks straight through the arch.

import { toLocal, toWorld, COUNTERS, MAHE_COUNTERS, LANES, GATES, zoneAt, inBuilding } from './airport-plan.js';
import { reached } from './flight-trip.js';

const REACH = 1.7; // m from a counter's or a desk's front where E works
const LANE_MOUTH = 7.4, LANE_END = 12.6;

export function terminalSteps() {
  const open = COUNTERS.filter((c) => MAHE_COUNTERS.includes(c.no));
  let lastV = null, lastLane = -1;
  const laneOf = (u) => LANES.findIndex((l) => Math.abs(u - l.u) < 1.1);

  return {
    /** Is (x, z) inside the terminal building? */
    inside(x, z) { const { u, v } = toLocal(x, z); return inBuilding(u, v); },
    zone(x, z) { const { u, v } = toLocal(x, z); return zoneAt(u, v); },
    /** The open counter the player stands at, or null. */
    counterAt(x, z) {
      const { u, v } = toLocal(x, z);
      return open.find((c) => Math.abs(u - c.u) < 1.3 && v < c.v && c.v - v < REACH) ?? null;
    },
    /** The gate whose desk the player stands at, or null. */
    deskAt(x, z, gateId) {
      const { u, v } = toLocal(x, z);
      const g = GATES.find((g) => g.id === gateId);
      return g && Math.hypot(u - g.desk.u, v - g.desk.v) < REACH + 0.4 ? g : null;
    },
    /**
     * Called every frame with the player's feet: → 'security' on the frame
     * a ticket holder crosses an arch, null otherwise.
     */
    step(x, z, trip) {
      const { u, v } = toLocal(x, z);
      const lane = laneOf(u);
      let event = null;
      if (lastV !== null && lane >= 0 && lane === lastLane) {
        const arch = LANES[lane].arch;
        if (lastV < arch && v >= arch && trip.state === 'ticket') event = 'security';
      }
      lastV = v; lastLane = lane;
      return event;
    },
    /** Where the next thing to do is, for the waypoint: world { x, z } or null. */
    target(trip, gateId) {
      if (!reached(trip, 'ticket') || trip.state === 'done') {
        const c = open[0];
        return toWorld((open[0].u + open[open.length - 1].u) / 2, c.v - 1.2);
      }
      if (trip.state === 'ticket') return toWorld(LANES[0].u, LANE_MOUTH - 1.5);
      if (trip.state === 'airside') {
        const g = GATES.find((g) => g.id === gateId);
        return toWorld(g.desk.u, g.desk.v - 1.4);
      }
      return null;
    },
    /** The officer at the lanes: a walker without a ticket is held at the mouth. */
    collide(pos, r, trip) {
      if (reached(trip, 'ticket') && trip.state !== 'done') return false;
      const { u, v } = toLocal(pos.x, pos.z);
      if (u < 18 || u > 32 || v < LANE_MOUTH - r || v > LANE_END) return false;
      const p = toWorld(u, LANE_MOUTH - r);
      pos.x = p.x; pos.z = p.z;
      return true;
    },
    /** Was a walker without a ticket just turned back at the lanes? (for the caption) */
    atLanes(x, z) {
      const { u, v } = toLocal(x, z);
      return u > 18 && u < 32 && v > LANE_MOUTH - 1.2 && v < LANE_MOUTH + 0.5;
    },
  };
}
