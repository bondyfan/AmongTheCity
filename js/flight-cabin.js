// ---- flight-cabin.js: the passenger inside the airliner ----
// Walking up the airstairs, being let in (or not) at the door, down the aisle
// to row 14, in front of seat 14A and down onto it; and on arrival the same
// thing backwards. The aircraft's shape is js/airliner-layout.js (plane-local:
// origin on the ground between the main wheels, −z forward, +x the right
// wing); this file turns world points into that frame and back with the
// aircraft's current pose, and answers the world's three questions for a
// walker (js/city.js supportY and collide, through world.airport):
//   carrying(x, z)          is this point inside the cabin (then only the cabin counts)
//   floor(x, z, maxY)       the cabin floor or a step of the airstairs, absolute
//   collide(pos, r, opts)   the cabin walls, the seat rows, the stair rails, the crew
//
// THE SIT-DOWN is js/prologue-seat.js, the very movement the Kolín train uses
// (Frank asked for that one): it turns a standing man round, folds him at the
// hips and lowers him onto a cushion, in a frame where u runs one way and v
// the other. A window seat is three seats in from the aisle, though, and
// nobody slides through two strangers' laps: so first he SHUFFLES sideways
// along the row (the walk cycle, 0.8 m/s, facing the window), and only then is
// the sit-down handed a frame turned so that its "aisle" is the spot in front
// of 14A and its "seat" is 35 cm behind it, on the cushion.

import { seating } from './prologue-seat.js';
import { AIRLINER, seatAt, inCabin, floorAt, push, DOOR_L1, WALKER_R } from './airliner-layout.js';

const SHUFFLE = 0.8; // m/s along the row
const LEG = 0.35; // m between where he stands in the row and the cushion
const AISLE_V = 0.12; // js/prologue-seat.js stands its sitter at v = 0.12

export function cabinPassenger(player, seatName = '14A') {
  const row = parseInt(seatName, 10), letter = seatName.replace(/\d+/g, '');
  const seat = seatAt(row, letter);
  const sitter = seating(player);
  let pose = null; // { x, y, z, heading, c, s } of the aircraft while it can be walked in
  let stage = 'off'; // off | shuffle-in | sitting | seated | rising | shuffle-out
  let k = 0, crewLine = null, docked = false, open = false, walk = false;

  const toLocal = (x, z) => {
    const dx = x - pose.x, dz = z - pose.z;
    return { lx: dx * pose.c - dz * pose.s, lz: dx * pose.s + dz * pose.c };
  };
  const toWorld = (lx, lz) => ({ x: pose.x + lx * pose.c + lz * pose.s, z: pose.z - lx * pose.s + lz * pose.c });
  const floorY = () => pose.y + AIRLINER.floorY;
  // the row's aisle end and the spot in front of the seat, plane-local
  const aisleSpot = { lx: Math.sign(seat.x) * 0.15, lz: seat.z - LEG };
  const rowSpot = { lx: seat.x, lz: seat.z - LEG };
  // js/prologue-seat.js frame: u = lx, v = how far in front of the cushion (+ AISLE_V)
  const frame = {
    worldAt: (u, v) => toWorld(u, seat.z - (v - AISLE_V) - LEG),
    get floor() { return floorY(); },
    get facing() { return pose.heading; },
  };

  function place(lx, lz, heading) {
    const p = toWorld(lx, lz);
    player.pos.x = p.x; player.pos.z = p.z;
    player.y = floorY();
    player.vy = 0; player.speed = 0; player.grounded = true;
    player.heading = heading;
    player.mesh.position.set(p.x, player.y, p.z);
    player.mesh.rotation.y = heading;
  }

  return {
    get stage() { return stage; },
    get seated() { return stage === 'seated'; },
    get busy() { return stage !== 'off'; },
    get crewLine() { return crewLine; },
    /**
     * Every frame: where the aircraft is and whether it can be walked
     * (`docked` stairs, `open` door), and what the crew say to this trip at
     * the door (null lets him in).
     */
    setPose(p, isDocked, isOpen, crew, canWalk = true) {
      walk = canWalk;
      if (!p) { pose = null; return; }
      pose ??= {};
      pose.x = p.x; pose.y = p.y; pose.z = p.z; pose.heading = p.heading;
      pose.c = Math.cos(p.heading); pose.s = Math.sin(p.heading);
      docked = isDocked; open = isOpen; crewLine = crew;
    },
    /** Is the player inside the cabin (plane-local test)? */
    aboard() {
      if (!pose) return false;
      if (stage !== 'off') return true;
      const { lx, lz } = toLocal(player.pos.x, player.pos.z);
      return inCabin(lx, lz) && Math.abs(player.y - floorY()) < 1.2;
    },
    /** Standing in the aisle beside his row? (the E offer "Sednout si") */
    nearSeat() {
      if (!pose || stage !== 'off') return false;
      const { lx, lz } = toLocal(player.pos.x, player.pos.z);
      return Math.abs(lz - aisleSpot.lz) < 0.75 && Math.abs(lx) < 0.6 && Math.abs(player.y - floorY()) < 0.5;
    },
    sit() {
      if (stage !== 'off' || !pose) return false;
      stage = 'shuffle-in'; k = 0;
      return true;
    },
    /** Already in the seat (the far side of a page switch resumes him there). */
    seatNow() {
      if (!pose) return false;
      sitter.sit({ u: seat.x, v: AISLE_V - LEG }, seat.x, AISLE_V - LEG, pose.heading);
      sitter.pose(5, frame);
      stage = 'seated';
      return true;
    },
    rise() {
      if (stage !== 'seated') return false;
      sitter.rise();
      stage = 'rising';
      return true;
    },
    /** Write the body (js/main.js posePlayer). → true while this owns it. */
    posePlayer(dt) {
      if (!pose || stage === 'off') return false;
      const walkTo = (a, b, face) => {
        const dist = Math.hypot(b.lx - a.lx, b.lz - a.lz);
        k = Math.min(1, k + (dt * SHUFFLE) / Math.max(0.2, dist));
        place(a.lx + (b.lx - a.lx) * k, a.lz + (b.lz - a.lz) * k, face);
        player.walkT = (player.walkT ?? 0) + dt * 7.5;
        player._animate(player.walkT, 0.5, 0, SHUFFLE);
        return k >= 1;
      };
      // a sidestep faces the way he is going: the window going in, the aisle coming out
      const toWindow = pose.heading + Math.sign(-seat.x) * Math.PI / 2;
      if (stage === 'shuffle-in') {
        if (walkTo(aisleSpot, rowSpot, toWindow)) {
          stage = 'sitting';
          sitter.sit({ u: seat.x, v: AISLE_V - LEG }, seat.x, AISLE_V, toWindow);
        }
        return true;
      }
      if (stage === 'shuffle-out') {
        if (walkTo(rowSpot, aisleSpot, toWindow + Math.PI)) { stage = 'off'; player._stand(); }
        return true;
      }
      const still = sitter.pose(dt, frame);
      if (stage === 'sitting' && sitter.settled) stage = 'seated';
      if (stage === 'rising' && !still) { stage = 'shuffle-out'; k = 0; }
      return true;
    },
    // ---- the world's questions, while the aircraft can be walked in ----
    carrying(x, z) {
      if (!pose || !walk) return false;
      const { lx, lz } = toLocal(x, z);
      return inCabin(lx, lz);
    },
    floor(x, z, maxY) {
      if (!pose || !walk) return -Infinity;
      if (Math.abs(x - pose.x) + Math.abs(z - pose.z) > 40) return -Infinity;
      const { lx, lz } = toLocal(x, z);
      const h = floorAt(lx, lz, docked);
      if (h == null) return -Infinity;
      const y = pose.y + h;
      return y <= maxY + 0.02 ? y : -Infinity;
    },
    collide(pos, r, opts) {
      if (!pose || !walk || !opts?.interior) return false;
      if (Math.abs(pos.x - pose.x) + Math.abs(pos.z - pose.z) > 40) return false;
      // js/player.js asks with aboveY = feet + 0.3; the cabin is built for a
      // walker of its own size (a 48 cm aisle), not the street's 0.38 m disc
      const feet = (opts.aboveY ?? 0.3) - 0.3;
      if (feet < pose.y - 0.5 || feet > pose.y + AIRLINER.floorY + 2.2) return false;
      r = Math.min(r, WALKER_R + 0.02);
      const { lx, lz } = toLocal(pos.x, pos.z);
      let q = push(lx, lz, r);
      // the doorway itself: shut, or the crew standing in it for someone without a pass
      const atDoor = Math.abs(lz - DOOR_L1.z) < DOOR_L1.w / 2 + r && lx < DOOR_L1.x + 0.6 && lx > DOOR_L1.x - 1.4;
      if (atDoor && (!open || crewLine) && feet > pose.y + AIRLINER.floorY - 0.6) {
        const nx = Math.min(q?.x ?? lx, DOOR_L1.x - 0.75 - r);
        q = { x: nx, z: q?.z ?? lz };
      }
      if (!q) return false;
      const p = toWorld(q.x, q.z);
      pos.x = p.x; pos.z = p.z;
      return true;
    },
    clear() { sitter.clear(); stage = 'off'; },
  };
}
