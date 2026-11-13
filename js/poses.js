// ---- poses.js: every fixed pose a citizen can take -------------------------
//
// Split out of js/citizen.js: sitting, the ragdoll splay, standing, and the
// four combat gestures (punch, kick, aim, hands up). They all write joint
// angles on the skeleton citizen.js builds and are handed back to it as
// closures, so the entry points other modules call (sitPose, ragdollPose,
// standPose, punchPose, kickPose, aimPose, handsPose) keep their names and
// signatures.
//
// ADDITIVE POSES. The combat four run AFTER walk() has written the whole
// skeleton and overwrite only the joints they own, so a man can walk and
// punch at the same time. The contract is in the block above punchPose.
//
// Signs, as everywhere in the figure: a limb hangs from its joint and POSITIVE
// rotation.x swings its lower end FORWARD; the trunk stands on its joint, so
// the same positive angle tips it BACK. Knees bend negative, elbows positive.

// ---- combat-pose maths, shared by every citizen ---------------------------
// Clamp to 0..1. NaN fails every comparison, so this returns 0 (the reset)
// instead of passing NaN into a matrix, where it would not throw: the figure
// would fail its own frustum test and vanish with no stack trace to find.
const cl01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0);
const clampAbs = (v, m) => (Number.isFinite(v) ? (v < -m ? -m : v > m ? m : v) : 0);

// Interpolate a joint the walk also owns, from the angle walk() left there
// toward the pose's target. ABSOLUTE, never `+=`: stepGame() can run three
// times for one rendered frame and this has to land in the same place each
// time it is called with the same arguments.
function mixX(joint, from, to, k) {
  joint.rotation.x = from + (to - from) * k;
}

// The swing envelope shared by punch and kick: load, drive, recover.
//   e   how far through the gesture the limb is (0 chambered, 1 extended)
//   b   how much of the pose sits on top of the walk, 0 at BOTH ends of t01,
//       so the first and last frame of a swing write walk()'s own numbers back
// Written into module scratch: nothing on a per-frame path may allocate.
const _swing = { e: 0, b: 0 };
function swingRamp(t01, load, hit) {
  const t = cl01(t01);
  if (t < load) {
    _swing.e = 0; _swing.b = t / load;
  } else if (t < hit) {
    _swing.e = (t - load) / (hit - load); _swing.b = 1;
  } else {
    const v = 1 - (t - hit) / (1 - hit);
    _swing.e = v; _swing.b = v;
  }
  return _swing;
}

/**
 * J: the joints (js/citizen.js). P: { stoop, hunch, headUp, reset } where the
 * first three are the archetype's standing posture in radians and reset()
 * tells the gait its stride was interrupted.
 */
export function makePoses(J, P) {
  const { body, pelvis, torso, chest, head, armL, armR, elbowL, elbowR, legL, legR, kneeL, kneeR, footL, footR, cane } = J;
  const { stoop, hunch, headUp } = P;

  // Where the BASE animation left the six joints the combat poses share with
  // it. The poses interpolate from this stamped copy rather than from
  // joint.rotation.x itself, because stepGame() runs several times per
  // rendered frame and a read-modify-write blend is not idempotent.
  const base = { armL: 0, armR: 0, elbL: 0, elbR: 0, legR: 0, kneeR: 0 };
  const stamp = () => {
    base.armL = armL.rotation.x; base.armR = armR.rotation.x;
    base.elbL = elbowL.rotation.x; base.elbR = elbowR.rotation.x;
    base.legR = legR.rotation.x; base.kneeR = kneeR.rotation.x;
  };

  // everything the gait writes that a fixed pose must not inherit
  const settle = () => {
    body.position.set(0, 0, 0);
    pelvis.rotation.set(0, 0, 0);
    torso.rotation.z = 0;
    chest.rotation.set(0 - hunch, 0, 0);
    head.rotation.set(headUp, 0, 0);
    footL.rotation.x = 0; footR.rotation.x = 0;
    cane.rotation.x = 0;
    P.reset();
  };

  // Thrown by a car: splay the limbs ONCE at launch and hold that shape while
  // the owner tumbles the whole group. Randomized per call so no two victims
  // fold the same way.
  const ragdollPose = () => {
    settle();
    torso.rotation.set(-0.1, 0, 0);
    const rn = Math.random;
    armL.rotation.set(-0.4 + rn() * 1.8, 0, -(0.9 + rn() * 1.0));
    armR.rotation.set(-0.4 + rn() * 1.8, 0, 0.9 + rn() * 1.0);
    elbowL.rotation.x = 0.2 + rn() * 1.2;
    elbowR.rotation.x = 0.2 + rn() * 1.2;
    legL.rotation.set(0.35 + rn() * 0.7, 0, -0.1 - rn() * 0.25);
    legR.rotation.set(-0.2 + rn() * 0.6, 0, 0.1 + rn() * 0.25);
    kneeL.rotation.x = -0.2 - rn() * 1.2;
    kneeR.rotation.x = -0.2 - rn() * 1.2;
    footL.rotation.x = -0.5 * rn(); footR.rotation.x = -0.5 * rn();
    head.rotation.set(headUp - 0.3 + rn() * 0.5, rn() - 0.5, 0);
    stamp();
  };

  // Seated. kk (0..1) blends the fold in from standing, so a boarding slide
  // settles a rider over its half second. `car` (default 1) is the posture:
  // 1 is a car seat, low, legs out to the pedals, back against the squab,
  // hands up at the wheel; 0 is a bench or a chair, shins vertical, hands in
  // the lap. A car's cushion sits barely 30 cm over its floor, which is why
  // the two are different shapes and not one.
  const sitPose = (kk = 1, car = 1) => {
    settle();
    const c = cl01(car);
    // 0.50 in a car: measured in the game against all eight kinds, that is the
    // knee that keeps the soles above the lowest floor pan (the Tesla's)
    const hipA = 1.50, kneeA = 0.50 * c + 1.50 * (1 - c);
    torso.rotation.set((0.16 * c - stoop * (1 - c)) * kk - stoop * (1 - kk), 0, 0);
    legL.rotation.set(hipA * kk, 0, -0.07 * kk);
    legR.rotation.set((hipA + 0.03) * kk, 0, 0.07 * kk);
    kneeL.rotation.x = 0 - kneeA * kk;
    kneeR.rotation.x = 0 - (kneeA + 0.04) * kk;
    footL.rotation.x = (kneeA - hipA + 0.25 * c) * kk;
    footR.rotation.x = (kneeA - hipA + 0.20 * c) * kk;
    armL.rotation.set((0.55 * c + 0.30 * (1 - c)) * kk, 0, 0.10 * kk);
    armR.rotation.set((0.55 * c + 0.30 * (1 - c)) * kk, 0, -0.10 * kk);
    elbowL.rotation.x = (0.80 * c + 1.05 * (1 - c)) * kk;
    elbowR.rotation.x = (0.80 * c + 1.05 * (1 - c)) * kk;
    stamp();
  };

  // ==== combat poses: ADDITIVE, and that word is the entire design ==========
  //
  // Four gestures applied AFTER walk() has written the whole skeleton.
  // js/player.js calls _animate() every frame and then combatPose, and each of
  // these overwrites ONLY the joints it owns.
  //
  //   REJECTED: gate them (walk OR pose). The figure froze mid-stride to throw
  //   a jab and slid along the pavement in the pose until the swing finished.
  //   REJECTED: absolute angles scaled by the blend. At k = 0 that writes
  //   ZERO, so the walk swing dies exactly during the blend being watched.
  //   KEPT: every joint walk() also owns is interpolated FROM THE VALUE WALK
  //   JUST WROTE toward the pose target, x = base + (target - base) * k, from
  //   a STAMPED copy of base so the write is idempotent.
  //
  // WHAT A CALLER MUST DO. torso.rotation.y and the shoulders' rotation.z are
  // axes walk() never rewrites, so what a pose puts there stays until
  // something takes it away. Every pose writes those as magnitude * blend,
  // which makes the zero-argument call the reset: finish a swing with
  // punchPose(1, arm), let an aim ramp down to aimPose(0), or call standPose().
  //
  // SIDES: the figure faces -z, so +x is its RIGHT. Swinging an arm INWARD
  // across the chest is -z on the right shoulder and +z on the left, and a
  // positive torso.rotation.y brings the RIGHT shoulder forward.

  // ---- a jab: fist chambered by the ribs with the elbow drawn BACK, then
  // driven out to shoulder height as the elbow opens ----
  const PUNCH_LOAD = 0.24;    // t01: the chamber is fully drawn by here
  const PUNCH_HIT = 0.48;     // t01: arm straight, contact. Half the swing is
                              //   recovery: a fist that snaps back as fast as
                              //   it went out reads as a machine
  const PUNCH_CHAM_X = -0.45; // rad: upper arm 26 degrees BEHIND the body
  const PUNCH_REACH = 1.52;   // rad: upper arm level, fist at its own shoulder
  const PUNCH_CHAM_E = 2.05;  // rad: elbow closed, fist in front of the ribs
  const PUNCH_OPEN = 0.10;    // rad: all but locked (dead straight is a mannequin)
  const PUNCH_CHAM_Z = 0.18;  // rad: elbow flared OUT in the chamber…
  const PUNCH_HIT_Z = -0.11;  // rad: …and the fist crossing IN at contact
  const GUARD_X = 0.75;       // rad: the other upper arm forward…
  const GUARD_E = 1.90;       // rad: …and folded, fist in front of the chin
  const GUARD_IN = 0.30;      // rad: tucked toward the centreline
  const PUNCH_TWIST = 0.24;   // rad: shoulders turn over the hips; the arms
                              //   hang off the trunk, so they ride it
  const PUNCH_WIND = 0.35;    // share of that twist wound the OTHER way first

  /** One jab. t01 runs 0..1; `arm` is 0 for the left fist, 1 for the right.
   *  Arms and trunk only: both legs stay walk()'s. */
  const punchPose = (t01, arm = 1) => {
    const w = swingRamp(t01, PUNCH_LOAD, PUNCH_HIT);
    const e = w.e, b = w.b;
    // the shoulder leads and the elbow whips: the heavy joint does most of
    // its travel early, the forearm is still folded at three quarters
    const lead = e * (2 - e), late = e * e * e;
    const sh = PUNCH_CHAM_X + (PUNCH_REACH - PUNCH_CHAM_X) * lead;
    const el = PUNCH_CHAM_E + (PUNCH_OPEN - PUNCH_CHAM_E) * late;
    const zz = PUNCH_CHAM_Z + (PUNCH_HIT_Z - PUNCH_CHAM_Z) * lead;
    const right = !!arm, sx = right ? 1 : -1;
    const fS = right ? armR : armL, fE = right ? elbowR : elbowL;
    const oS = right ? armL : armR, oE = right ? elbowL : elbowR;
    const fSb = right ? base.armR : base.armL, fEb = right ? base.elbR : base.elbL;
    const oSb = right ? base.armL : base.armR, oEb = right ? base.elbL : base.elbR;
    mixX(fS, fSb, sh, b);
    mixX(fE, fEb, el, b);
    // the guard is looser than the fist: held as hard, it reads as a boxing
    // stance instead of a street fight
    mixX(oS, oSb, GUARD_X, b * 0.85);
    mixX(oE, oEb, GUARD_E, b * 0.85);
    fS.rotation.z = sx * zz * b;
    oS.rotation.z = sx * GUARD_IN * b;
    torso.rotation.y = sx * PUNCH_TWIST * (e - PUNCH_WIND * (b - e));
  };

  // ---- a front snap kick: the hip barely moves between chamber and hit, the
  // gesture is the shin whipping out of a raised knee ----
  const KICK_LOAD = 0.32, KICK_HIT = 0.55;
  const KICK_UP = 1.45;       // rad: thigh level, knee at hip height
  const KICK_OUT = 1.50;      // rad: 3 degrees higher at contact
  const KICK_FOLD = -2.10;    // rad: knee closed, heel under the raised thigh
  const KICK_OPEN = -0.12;    // rad: shin out, just short of locked
  const KICK_ARM = 0.55;      // rad: opposite arm forward…
  const KICK_ARM_BACK = -0.45;// rad: …and the near one back, for balance
  const KICK_ARM_E = 0.60;    // rad: both elbows half closed
  const KICK_TWIST = -0.20;   // rad: shoulders turn AWAY from the kicking leg

  /** A front kick with the RIGHT leg. It OWNS that leg, hip and knee, for the
   *  whole of t01: walk() rewrites both legs every frame and the kick writes
   *  its own back afterwards, so the left keeps striding underneath. */
  const kickPose = (t01) => {
    const w = swingRamp(t01, KICK_LOAD, KICK_HIT);
    const e = w.e, b = w.b;
    const hip = KICK_UP + (KICK_OUT - KICK_UP) * e * (2 - e);
    // squared where the punch's elbow is cubed: the drive is about five
    // frames and a cubed knee puts the whole extension in the last one
    const knee = KICK_FOLD + (KICK_OPEN - KICK_FOLD) * e * e;
    mixX(legR, base.legR, hip, b);
    mixX(kneeR, base.kneeR, knee, b);
    mixX(armL, base.armL, KICK_ARM, b * 0.7);
    mixX(armR, base.armR, KICK_ARM_BACK, b * 0.7);
    mixX(elbowL, base.elbL, KICK_ARM_E, b * 0.7);
    mixX(elbowR, base.elbR, KICK_ARM_E, b * 0.7);
    torso.rotation.y = KICK_TWIST * e;
  };

  // ---- a raised pistol: both arms out, the support hand brought across ----
  const AIM_X = 1.56;         // rad: the gun arm level out of the shoulder
  const AIM_X_SUP = 1.47;     // rad: the support arm a little lower
  const AIM_E_GUN = 0.10;     // rad: gun elbow all but straight
  const AIM_E_SUP = 0.22;     // rad: support elbow soft
  const AIM_IN_GUN = 0.14;    // rad: gun arm just inside the shoulder line
  const AIM_IN_SUP = 0.50;    // rad: support arm crosses the chest to meet it
  const AIM_PITCH = 0.90;     // rad: past that the arm folds over the head

  /** Both arms up and forward, the RIGHT (gun) hand leading. k is the blend
   *  0..1 and k = 0 is the reset. `pitch` in radians, POSITIVE IS UP. */
  const aimPose = (kb = 1, pitch = 0) => {
    const kk = cl01(kb);
    const p = clampAbs(pitch, AIM_PITCH);
    mixX(armR, base.armR, AIM_X + p, kk);
    mixX(elbowR, base.elbR, AIM_E_GUN, kk);
    mixX(armL, base.armL, AIM_X_SUP + p, kk);
    mixX(elbowL, base.elbL, AIM_E_SUP, kk);
    armR.rotation.z = -AIM_IN_GUN * kk;
    armL.rotation.z = AIM_IN_SUP * kk;
  };

  // ---- hands up: upper arms straight out sideways, forearms standing. With
  // the arm abducted the elbow's own axis has rolled upright, which is why
  // the fold that bends a hanging arm forward stands these ones vertical ----
  const HANDS_OUT = 1.55, HANDS_X = 1.10, HANDS_E = 1.95;

  /** Hands up beside the head. k is the blend 0..1 and k = 0 is the reset. */
  const handsPose = (kb = 1) => {
    const kk = cl01(kb);
    mixX(armL, base.armL, HANDS_X, kk);
    mixX(armR, base.armR, HANDS_X, kk);
    mixX(elbowL, base.elbL, HANDS_E, kk);
    mixX(elbowR, base.elbR, HANDS_E, kk);
    armL.rotation.z = -HANDS_OUT * kk;
    armR.rotation.z = HANDS_OUT * kk;
  };

  // Back on their feet: undo any splay or fold so walk() owns the limbs again.
  const standPose = () => {
    settle();
    armL.rotation.set(0, 0, 0);
    armR.rotation.set(0, 0, 0);
    legL.rotation.set(0, 0, 0);
    legR.rotation.set(0, 0, 0);
    elbowL.rotation.x = 0; elbowR.rotation.x = 0;
    kneeL.rotation.x = 0; kneeR.rotation.x = 0;
    // also clears the combat poses' twist, which walk() never touches
    torso.rotation.set(0 - stoop, 0, 0);
    stamp();
  };
  return { stamp, sitPose, ragdollPose, standPose, punchPose, kickPose, aimPose, handsPose };
}

// ==== on a bicycle ============================================================
//
// Seated on the saddle, back bent toward the bars, hands ON the grips. The
// trunk and the arms are this module's; the legs go round with the cranks and
// are js/gait.js makePedal's. Both are solved against one record, the bike's
// `fit` (js/bikemodel.js): where the saddle, the bracket and the grips are for
// the reference rider. Every length is scaled by this rider's own leg, so a
// short woman and a tall man both reach the same bar of a bike drawn to their
// size (js/bikefleet.js scales the bicycle by the same factor).
//
// A FIXED POSE in the sense of the block at the top: it writes absolute angles
// and whoever takes the rider off the bike calls standPose() or ragdollPose(),
// which put back everything this touches.
//
// `parts` is makeCitizen().parts. Returns ride(fit, steer, stand):
//   steer  radians the bars are turned, positive to the RIGHT: the outside
//          hand goes forward with its grip
//   stand  0 riding .. 1 stopped with a foot down: the hips come off the
//          saddle and the back straightens
// Nothing allocates.
const RIDE_REF_THIGH = 0.415;   // js/bodyshape.js REF.hipY - REF.kneeY: the leg `fit` was measured for

export function makeRidePose(parts) {
  const { body, pelvis, torso, chest, head, armL, armR, elbowL, elbowR, legL, kneeL, handL } = parts;
  const k = (0 - kneeL.position.y) / RIDE_REF_THIGH;
  const hipY = legL.position.y;
  const spine = chest.position.y;                       // hip to the upper-back hinge
  const collar = armL.parent;
  const shUp = collar.position.y, shX = Math.abs(collar.position.x);
  const U = 0 - elbowL.position.y, F = 0 - handL.position.y + 0.065 * k;   // to the elbow, to the grip in the fist
  const acosC = (v) => Math.acos(v < -1 ? -1 : v > 1 ? 1 : v);

  // One arm, shoulder to grip, in three dimensions (a grip is wider than a
  // shoulder on a town bike and narrower on drop bars, so a solve in the side
  // view alone left the fist beside the bar). Everything below is in the
  // figure's own frame: +x its right, +y up, -z ahead.
  //   S the shoulder, T the grip; the elbow goes where two bones of length U
  //   and F meet, on the side of the line S-T that the POLE points to (down,
  //   a little out and back: where a rider's elbows hang).
  // The shoulder is then turned so the upper arm lies along S-E with its
  // hinge square to the bend, and the elbow closes by `flex`.
  const reach = (arm, elbow, sx, fit, steer, shF, shH, lean) => {
    const gF = fit.gripF * k - sx * Math.sin(steer) * fit.gripX * k;   // the grip swings with the bar
    const sX = sx * shX, sZ = 0 - shF;
    let ux = sx * fit.gripX * k - sX, uy = fit.gripY * k - shH, uz = 0 - gF - sZ;
    let d = Math.sqrt(ux * ux + uy * uy + uz * uz);
    ux /= d; uy /= d; uz /= d;
    const max = (U + F) * 0.995;
    if (d > max) d = max; else if (d < 0.1) d = 0.1;
    const flex = Math.PI - acosC((U * U + F * F - d * d) / (2 * U * F));
    const al = acosC((U * U + d * d - F * F) / (2 * U * d));
    // the pole, made square to the line
    let wx = sx * 0.35, wy = -1, wz = 0.25;
    const pu = wx * ux + wy * uy + wz * uz;
    wx -= pu * ux; wy -= pu * uy; wz -= pu * uz;
    const wl = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
    wx /= wl; wy /= wl; wz /= wl;
    const ca = Math.cos(al), sa = Math.sin(al);
    // d1: along the upper arm. d2: along the forearm. n: square to d1, in the bend.
    const d1x = ca * ux + sa * wx, d1y = ca * uy + sa * wy, d1z = ca * uz + sa * wz;
    const d2x = (d * ux - U * d1x) / F, d2y = (d * uy - U * d1y) / F, d2z = (d * uz - U * d1z) / F;
    const cf = Math.cos(flex), sf = Math.sin(flex) || 1e-6;
    const nx = (d2x - cf * d1x) / sf, ny = (d2y - cf * d1y) / sf, nz = (d2z - cf * d1z) / sf;
    // the upper arm's own axes: x the hinge (d1 x n), y back up the bone, z = x cross y
    let ax = d1y * nz - d1z * ny, ay = d1z * nx - d1x * nz, az = d1x * ny - d1y * nx;
    let bx = 0 - d1x, by = 0 - d1y, bz = 0 - d1z;
    let cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    // …seen from the collar, which leans with the chest (lean, about x) and
    // stands off the ribs by its resting angle (about z)
    const cl = Math.cos(lean), sl = Math.sin(lean), rz = 0 - arm.parent.rotation.z, cr = Math.cos(rz), sr = Math.sin(rz);
    let t;
    t = ay * cl - az * sl; az = ay * sl + az * cl; ay = t; t = ax * cr - ay * sr; ay = ax * sr + ay * cr; ax = t;
    t = by * cl - bz * sl; bz = by * sl + bz * cl; by = t; t = bx * cr - by * sr; by = bx * sr + by * cr; bx = t;
    t = cy * cl - cz * sl; cz = cy * sl + cz * cl; cy = t; t = cx * cr - cy * sr; cy = cx * sr + cy * cr; cx = t;
    // the rotation whose columns are a, b, c, as a quaternion
    const tr = ax + by + cz;
    let qx, qy, qz, qw;
    if (tr > 0) { const q = 0.5 / Math.sqrt(tr + 1); qw = 0.25 / q; qx = (bz - cy) * q; qy = (cx - az) * q; qz = (ay - bx) * q; }
    else if (ax > by && ax > cz) { const q = 2 * Math.sqrt(1 + ax - by - cz); qw = (bz - cy) / q; qx = 0.25 * q; qy = (bx + ay) / q; qz = (cx + az) / q; }
    else if (by > cz) { const q = 2 * Math.sqrt(1 + by - ax - cz); qw = (cx - az) / q; qx = (bx + ay) / q; qy = 0.25 * q; qz = (cy + bz) / q; }
    else { const q = 2 * Math.sqrt(1 + cz - ax - by); qw = (ay - bx) / q; qx = (cx + az) / q; qy = (cy + bz) / q; qz = 0.25 * q; }
    arm.quaternion.set(qx, qy, qz, qw);
    elbow.rotation.x = flex;
  };

  return (fit, steer = 0, stand = 0) => {
    const st = stand > 0 ? (stand < 1 ? stand : 1) : 0;
    const seatY = (fit.seatY - fit.standDrop * st) * k, seatF = (fit.seatF + fit.standF * st) * k;
    body.position.set(0, seatY - hipY, 0 - seatF);
    pelvis.rotation.set(0, 0, 0);
    const lean = fit.lean * (1 - 0.3 * st);
    const a1 = lean * 0.7;
    torso.rotation.set(0 - a1, 0, 0);
    chest.rotation.set(0 - (lean - a1), 0, 0);
    // eyes on the road ahead, not on the front wheel
    head.rotation.set(lean * 0.8, 0, 0);
    // the shoulders, by forward kinematics up the bent back
    const shF = seatF + Math.sin(a1) * spine + Math.sin(lean) * shUp;
    const shH = seatY + Math.cos(a1) * spine + Math.cos(lean) * shUp;
    reach(armL, elbowL, -1, fit, steer, shF, shH, lean);
    reach(armR, elbowR, 1, fit, steer, shF, shH, lean);
  };
}
