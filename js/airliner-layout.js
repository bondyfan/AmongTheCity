// ---- airliner-layout.js: the generic narrowbody as plain numbers ----
// Every dimension of the passenger aircraft lives here, once. The exterior mesh
// (js/airliner.js), the cabin (js/airliner-cabin.js), the stair truck
// (js/airstairs.js), the walking code and the sit-down animation all read these
// numbers, so the geometry and the walking can never disagree about where a
// door sill or a seat back is.
//
// WORKER SAFE and node-importable: no three.js, no DOM, no clock.
//
// THE FRAME (plane-local, ARCHITECTURE.md convention once yawed by `heading`):
//   origin  on the GROUND, midway between the two main gear contact points
//   -z      forward, the nose. The nose tip is at z = -20.6, the tail at +17.0
//   +x      the right wing (and the right-hand seats DEF)
//   +y      up. The cabin floor is at y = 3.35, the door sill at the same height
//
// The numbers are a generic A320-class twin jet, not any airline's aircraft.
// Where the brief's own numbers disagree with each other, the choice made here
// is written next to the constant (the cabin ceiling, the window pitch).

// ---- the airframe ----------------------------------------------------------
const DEG = Math.PI / 180;

export const AIRLINER = {
  // overall
  length: 37.6,
  noseZ: -20.6,
  tailZ: 17.0,
  height: 11.76, // to the top of the fin
  span: 35.8, // including the sharklets

  // the gear: main legs at x = ±3.8 (track 7.6), nose leg on the centreline
  wheelbase: 12.64,
  noseGearZ: -12.64,
  mainGearX: 3.8,
  track: 7.6,
  wheelRadius: 0.56, // wheels touch y = 0 at their bottom

  // the fuselage: an ellipse 3.95 wide and 4.14 tall, its bottom 1.32 above the
  // ground, so the hold sits below the floor and the wheels fit under the belly
  fuselageHalfWidth: 1.975,
  fuselageHalfHeight: 2.07,
  fuselageCentreY: 3.39,
  fuselageBottomY: 1.32,
  fuselageTopY: 5.46,
  noseCylinderZ: -14.5, // the ogive runs from here to the nose tip
  tailConeZ: 12.0, // the tail cone starts here and sweeps up
  tailUpsweep: 0.9, // how far the cone's centreline lifts at the tail tip

  // the cabin inside it. The lining sits 12 cm in from the skin. The brief asked
  // for a ceiling 2.15 m over the floor, which would push the lining 5.50 m up,
  // through the 5.46 m crown of a 4.14 m skin. So the ceiling is 2.10 m over the
  // floor (5.45 m): still a 1.85 m passenger standing with room for the bins.
  floorY: 3.35,
  ceilingOverFloor: 2.1,
  ceilingY: 5.45,
  lining: 0.12,
  aisleHalf: 0.24, // the aisle is 0.48 m wide, centred on x = 0
  cockpitBulkheadZ: -17.0, // the closed cockpit door sits in this bulkhead
  cabinEndZ: 13.0, // the rear pressure bulkhead, behind the lavatories

  // the wings: root leading edge at z = -2.6 on the fuselage side, swept 25
  // degrees, 5 degrees of dihedral, root chord 6.0 m and a tip chord of 1.5 m
  wingRootY: 2.9,
  wingRootLeadingZ: -2.6,
  wingHalfSpan: 17.9,
  wingSweepDeg: 25,
  wingDihedralDeg: 5,
  wingRootChord: 6.0,
  wingTipChord: 1.5,
  sharkletHeight: 2.0, // winglet height above the wingtip

  // the engines: pylons at x = ±5.75, nacelle 4.4 m long and 2.0 m across,
  // its underside 0.55 m off the ground
  engineX: 5.75,
  engineY: 1.55,
  engineZ: -2.0,
  nacelleLength: 4.4,
  nacelleDiameter: 2.0,

  // the fin: root leading edge at z = 9.5 on the fuselage, swept 35 degrees
  finRootLeadingZ: 9.5,
  finRootChord: 6.3,
  finTipChord: 3.0,
  finRootY: 5.0,
  finSweepDeg: 35,

  // the tailplane: 12.6 m across, root leading edge at z = 12.0, swept 30
  stabRootLeadingZ: 12.0,
  stabRootChord: 4.5,
  stabTipChord: 1.6,
  stabHalfSpan: 5.4,
  stabSweepDeg: 30,
  stabY: 3.6,
};

// ---- the flight-control surfaces ------------------------------------------
// The trailing-edge flaps and slats droop by these many degrees at full setting.
export const FLAPS = { trailing: 25 * DEG, slat: 20 * DEG };
// The main gear retracts into the belly; the nose gear behind its doors.
export const GEAR = { travel: 1.0 };

// ---- the cabin: 30 rows, six abreast ---------------------------------------
export const ROWS = 30;
export const LETTERS = 'ABCDEF';
// Seat pitch 0.76 m, economy. Rows 17 and 25 sit over the wing and are the
// exits: they get 14 cm of extra legroom in front of them (the 0.9 m step), the
// way an exit row does in a real layout.
export const ROW_PITCH = 0.76;
export const EXIT_ROWS = [17, 25];
export const EXIT_EXTRA = 0.14;
const FIRST_ROW_Z = -11.2;

// Row z positions, once. Index 0 is row 1.
export const ROW_Z = (() => {
  const z = new Array(ROWS);
  let at = FIRST_ROW_Z;
  for (let r = 1; r <= ROWS; r++) {
    if (r > 1) at += ROW_PITCH + (EXIT_ROWS.includes(r) ? EXIT_EXTRA : 0);
    z[r - 1] = at;
  }
  return z;
})();

// x of each seat letter: the window seats A and F at ±1.49, the middle seats
// B and E at ±0.99, and the aisle seats C and D at ±0.49 (0.25 m from the aisle).
const SEAT_X = { A: -1.49, B: -0.99, C: -0.49, D: 0.49, E: 0.99, F: 1.49 };
// The seat, measured from its own centre. The cushion is 0.44 m across and
// 0.5 m deep: the back sits 0.25 m behind the centre, the knees 0.2 m in front.
export const SEAT = {
  cushionY: 0.45, // cushion centre above the floor
  backZ: 0.25, // the seat back, toward +z (behind the passenger)
  frontZ: 0.2, // the front of the cushion, toward -z
  halfWidth: 0.22,
  backHeight: 0.62, // the back rises this far above the cushion centre
  headrestHeight: 0.42, // the headrest sits on top of the back
};

export const seatFacing = 0; // passengers face -z: the yaw of a seat, 0 = facing -z

/** Where the cushion of a seat is, in plane-local metres. `letter` is 'A'..'F'. */
export function seatAt(row, letter) {
  const z = ROW_Z[row - 1];
  const x = SEAT_X[letter];
  if (z === undefined || x === undefined) throw new Error(`no seat ${row}${letter}`);
  return { x, z, y: AIRLINER.floorY + SEAT.cushionY };
}

// All 180 seats in row order, A to F within a row. Built once.
export const SEATS = (() => {
  const list = [];
  for (let r = 1; r <= ROWS; r++)
    for (const letter of LETTERS) {
      const p = seatAt(r, letter);
      list.push({ row: r, letter, x: p.x, z: p.z });
    }
  return list;
})();

// ---- the windows ----------------------------------------------------------
// One window per row, on the lining (the outer skin is 12 cm further out), at
// the row's own z. The brief's 0.53 m window pitch cannot hold one window per
// 0.76 m row, so the pitch follows the seats: every row sees its own window.
export const WINDOW = {
  width: 0.23, // along z
  height: 0.33, // up the wall
  centreAbove: 1.15, // of the floor
  radius: 0.05, // the corners are rounded to this, approximately
};

// ---- the L1 door and the galley ------------------------------------------
// L1 sits on the left (-x) just aft of the cockpit. The skin is the outside of
// the fuselage, the sill is the floor. The door swings outward and forward.
export const DOOR_L1 = {
  x: -AIRLINER.fuselageHalfWidth,
  z: -15.6,
  w: 0.81,
  h: 1.85,
  sill: AIRLINER.floorY,
};

/** Is this z inside the door's width (the wall gap a walker passes through)? */
export function inDoorBand(lz) {
  return Math.abs(lz - DOOR_L1.z) <= DOOR_L1.w / 2;
}

// Solid blocks inside the cabin that are not seats: the forward galley on each
// side of the aisle between the door and row 1, and the rear galley and the
// lavatories at the back. Each is { x0, x1, z0, z1 } with x0 < x1 and z0 < z1.
// They reach past the lining on purpose: the walls clamp the walker anyway.
export const BLOCKS = [
  { x0: -2.0, x1: -0.3, z0: -15.2, z1: -12.4 }, // forward galley, left
  { x0: 0.3, x1: 2.0, z0: -15.2, z1: -12.4 }, // forward galley, right
  { x0: -2.0, x1: -0.3, z0: 11.6, z1: 13.0 }, // rear galley, left
  { x0: 0.3, x1: 2.0, z0: 11.6, z1: 13.0 }, // lavatories, right
];

// ---- the airstairs ---------------------------------------------------------
// A mobile stair truck docked perpendicular to the fuselage at L1, running out
// to -x. A platform at sill height sits just outside the door; then 14 steps
// descend to the ground. The rise is the sill height over 14, so the last step
// lands exactly on the ground.
export const STAIRS = {
  zCentre: DOOR_L1.z,
  width: 1.1, // along z
  platformInner: -2.0, // x of the platform's edge at the door
  platformOuter: -3.2, // x of the platform's far edge
  steps: 14,
  run: 0.3, // the going of one step
  rise: AIRLINER.floorY / 14, // 0.239 m a step, so the 14th tread lands on the ground
  handrailHeight: 0.95,
  handrailOffset: 0.6, // each handrail sits this far out from the centreline
};
// x of the foot of the stairs: the first point on the ground, where the walker
// steps off onto the apron.
export const STAIRS_FOOT_X = STAIRS.platformOuter - STAIRS.steps * STAIRS.run;

// ---- walking ---------------------------------------------------------------
// A walker is a circle of this radius on the floor. 0.16 m is a pair of
// shoulders, and it lets the centre sit anywhere in the 0.48 m aisle.
export const WALKER_R = 0.16;

// ---- the skin ----------------------------------------------------------------
// Half the width of the outside of the fuselage at plane-local z. The nose is an
// ogive that closes to a point at the nose tip, the cylinder is the body, and the
// tail cone tapers to 30% of the width at the tail. The exterior mesh and the
// walls of the cabin both call this, so the walls follow the skin exactly.
const NOSE_EXP = 2.5; // > 2 makes the ogive come to a point rather than a dome
export function skinHalfWidth(z) {
  const L = AIRLINER;
  if (z < L.noseCylinderZ) {
    const t = (L.noseCylinderZ - z) / (L.noseCylinderZ - L.noseZ);
    if (t >= 1) return 0;
    return L.fuselageHalfWidth * Math.sqrt(Math.max(0, 1 - t ** NOSE_EXP));
  }
  if (z > L.tailConeZ) {
    const t = Math.min(1, (z - L.tailConeZ) / (L.tailZ - L.tailConeZ));
    return L.fuselageHalfWidth * (1 - 0.7 * t * t);
  }
  return L.fuselageHalfWidth;
}

/** The skin's cross-section at z: half-width `a`, half-height `b`, and the
 *  centreline height `yc`. The mesh walks rings of these from nose to tail. */
export function skinSection(z) {
  const L = AIRLINER;
  const a = skinHalfWidth(z);
  // the cone's centreline lifts toward the tail, which is the upsweep
  let yc = L.fuselageCentreY;
  if (z > L.tailConeZ) {
    const t = Math.min(1, (z - L.tailConeZ) / (L.tailZ - L.tailConeZ));
    yc += L.tailUpsweep * t * t;
  }
  const b = L.fuselageHalfHeight * Math.sqrt(Math.max(0, a / L.fuselageHalfWidth));
  return { a, b, yc };
}

// The inside of the skin: the lining sits this far in from the outside.
function innerHalfWidth(z) {
  return Math.max(0, skinHalfWidth(z) - AIRLINER.lining);
}

// ---- the solid things a walker meets -----------------------------------------
// Seat rows, as two blocks per row: the aisle-side edge of each block is 0.26 m
// from the centreline, so a walker of radius 0.16 keeps a 0.10 m margin each way
// and the middle of the aisle is always free.
const SEAT_AISLE_EDGE = 0.26;
const SEAT_OUTER = 2.0; // past the lining, the wall clamps the walker anyway
function seatRowBlocksNear(lz, fn, s, r) {
  for (let i = 0; i < ROWS; i++) {
    const z = ROW_Z[i];
    if (lz < z - SEAT.frontZ - r - 0.2 || lz > z + SEAT.backZ + r + 0.2) continue;
    const z0 = z - SEAT.frontZ, z1 = z + SEAT.backZ;
    fn(s, -SEAT_OUTER, -SEAT_AISLE_EDGE, z0, z1, r);
    fn(s, SEAT_AISLE_EDGE, SEAT_OUTER, z0, z1, r);
  }
}

// Handrails along the stairs' outer edges. They are walls for the walker, but
// the stairs themselves are open: a walker on the treads is not stopped.
const RAIL_T = 0.04; // the rail's thickness across z
const RAILS = [
  { x0: STAIRS_FOOT_X, x1: STAIRS.platformOuter,
    z0: STAIRS.zCentre - STAIRS.handrailOffset - RAIL_T, z1: STAIRS.zCentre - STAIRS.handrailOffset + RAIL_T },
  { x0: STAIRS_FOOT_X, x1: STAIRS.platformOuter,
    z0: STAIRS.zCentre + STAIRS.handrailOffset - RAIL_T, z1: STAIRS.zCentre + STAIRS.handrailOffset + RAIL_T },
];

// Push a point out of one rectangle, along the axis of least penetration. `s`
// is the walker, mutated in place. The walker is a circle of radius r, so the
// rectangle is grown by r on every side.
function pushRect(s, x0, x1, z0, z1, r) {
  const x = s.x, z = s.z;
  if (x <= x0 - r || x >= x1 + r || z <= z0 - r || z >= z1 + r) return;
  const left = x - (x0 - r), right = x1 + r - x;
  const back = z - (z0 - r), fwd = z1 + r - z;
  const m = Math.min(left, right, back, fwd);
  if (m === left) s.x = x0 - r;
  else if (m === right) s.x = x1 + r;
  else if (m === back) s.z = z0 - r;
  else s.z = z1 + r;
}
function pushRail(s, _x0, _x1, _z0, _z1, r) {
  for (const rail of RAILS) pushRect(s, rail.x0, rail.x1, rail.z0, rail.z1, r);
}
function pushBlock(s, x0, x1, z0, z1, r) {
  pushRect(s, x0, x1, z0, z1, r);
}

// Is the point inside one of the cabin's solid blocks (seats or galleys)?
function inBlock(lx, lz) {
  for (const b of BLOCKS) if (lx > b.x0 && lx < b.x1 && lz > b.z0 && lz < b.z1) return true;
  let hit = false;
  seatRowBlocksNear(lz, (s, x0, x1, z0, z1) => {
    if (s.x > x0 && s.x < x1 && s.z > z0 && s.z < z1) hit = true;
  }, { x: lx, z: lz }, 0);
  return hit;
}

// ---- the public queries -------------------------------------------------------
/** Can a walker stand here inside the cabin? The aisle, the galleys, the space in
 *  front of row 1, the door way, and the rows only where there is no seat. */
export function inCabin(lx, lz) {
  const L = AIRLINER;
  if (lz < L.cockpitBulkheadZ || lz > L.cabinEndZ) return false;
  const ax = Math.abs(lx);
  if (ax > skinHalfWidth(lz)) return false;
  if (ax > innerHalfWidth(lz)) return lx < 0 && inDoorBand(lz); // the door's gap in the skin
  return !inBlock(lx, lz);
}

/** The walkable height at (lx, lz), plane-local metres, or null where there is no
 *  aircraft under the walker. Inside the cabin it is the floor; outside the door,
 *  when the stairs are docked, it is the platform and then the steps down. */
export function floorAt(lx, lz, stairsDocked = false) {
  if (inCabin(lx, lz)) return AIRLINER.floorY;
  if (!stairsDocked) return null;
  const S = STAIRS;
  if (Math.abs(lz - S.zCentre) > S.width / 2) return null;
  if (lx <= S.platformInner && lx >= S.platformOuter) return AIRLINER.floorY;
  if (lx < S.platformOuter && lx >= STAIRS_FOOT_X) {
    // the tread under the walker: the first step is the one nearest the platform
    const k = Math.min(S.steps - 1, Math.floor((S.platformOuter - lx) / S.run));
    return AIRLINER.floorY - S.rise * (k + 1);
  }
  return null;
}

// One scratch point, reused by push(): a walker is moved through several walls
// per call and the walls only read and write x and z.
const _s = { x: 0, z: 0 };

/** Push a walker of radius r out of the cabin walls, seats, galleys and stair
 *  handrails. Returns { x, z } where he now stands, or null when nothing moved.
 *  The door's gap in the skin is not a wall: he can walk out through L1. */
export function push(lx, lz, r = WALKER_R) {
  const L = AIRLINER;
  _s.x = lx;
  _s.z = lz;
  for (let pass = 0; pass < 2; pass++) {
    const z = _s.z;
    // the skin: keep the walker inside the lining, except through the door band
    if (z >= L.cockpitBulkheadZ - 0.5 && z <= L.cabinEndZ + 0.5) {
      const a = skinHalfWidth(z), inner = innerHalfWidth(z) - r;
      const ax = Math.abs(_s.x);
      if (ax > inner && ax < a + r && !(_s.x < 0 && inDoorBand(z))) _s.x = Math.sign(_s.x) * inner;
      if (ax < inner + r) {
        // the cockpit bulkhead and the rear bulkhead close the cabin in z
        if (_s.z < L.cockpitBulkheadZ + r && _s.z > L.cockpitBulkheadZ - 0.5) _s.z = L.cockpitBulkheadZ + r;
        if (_s.z > L.cabinEndZ - r && _s.z < L.cabinEndZ + 0.5) _s.z = L.cabinEndZ - r;
      }
    }
    seatRowBlocksNear(_s.z, pushBlock, _s, r);
    for (const b of BLOCKS) pushBlock(_s, b.x0, b.x1, b.z0, b.z1, r);
    pushRail(_s, 0, 0, 0, 0, r);
  }
  if (_s.x === lx && _s.z === lz) return null;
  return { x: _s.x, z: _s.z };
}
