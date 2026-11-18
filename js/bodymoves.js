// ---- bodymoves.js: the poses of doing things ---------------------------------
//
// js/poses.js holds the poses a citizen can simply BE in (standing, sitting,
// thrown) and the four combat gestures. This file holds the ones that are part
// of an ACTION the player takes with the whole body: reaching for a door
// handle and finding it locked, ducking into a car, pulling the door shut,
// jumping, vaulting a bonnet on one hand, getting up off the road.
//
// A pose is a plain record of joint angles. pose(parts, p, w) moves every joint
// the record names from wherever it is now toward the record by w, and leaves
// the rest alone. So the owner writes its base first (stand, walk or sit, every
// step, which is what makes the blend idempotent when the sim runs several
// steps a frame) and lays one or two of these over it.
//
// Signs, as in js/poses.js: the figure faces -z and +x is its RIGHT. A limb
// hangs from its joint and positive x swings its lower end FORWARD; the trunk
// and the head stand on theirs, so the same positive angle tips them BACK.
// Knees bend negative, elbows positive. An arm goes OUT from the body with -z
// on the left shoulder and +z on the right; a leg swings to the figure's right
// with +z.
//
// No three and no state: numbers written onto the joints js/citizen.js hands
// out as `parts`.

const KEYS = [
  ['tx', 'torso', 'x'], ['ty', 'torso', 'y'], ['tz', 'torso', 'z'], ['hx', 'head', 'x'], ['hy', 'head', 'y'],
  ['alx', 'armL', 'x'], ['alz', 'armL', 'z'], ['arx', 'armR', 'x'], ['arz', 'armR', 'z'],
  ['el', 'elbowL', 'x'], ['er', 'elbowR', 'x'],
  ['llx', 'legL', 'x'], ['llz', 'legL', 'z'], ['lrx', 'legR', 'x'], ['lrz', 'legR', 'z'],
  ['kl', 'kneeL', 'x'], ['kr', 'kneeR', 'x'], ['fl', 'footL', 'x'], ['fr', 'footR', 'x'],
];

/** Blend the joints `p` names toward it by w (0 leaves them, 1 sets them).
 *  `by` is the pelvis drop in the figure's own metres. */
export function pose(parts, p, w = 1) {
  if (!(w > 0)) return;
  if (w > 1) w = 1;
  for (let i = 0; i < KEYS.length; i++) {
    const k = KEYS[i], v = p[k[0]];
    if (v === undefined) continue;
    const r = parts[k[1]].rotation;
    r[k[2]] += (v - r[k[2]]) * w;
  }
  if (p.by !== undefined) parts.body.position.y += (p.by - parts.body.position.y) * w;
}

/** Every joint as it stands right now, as a pose (to blend OUT of a ragdoll). */
export function snapshot(parts, out = {}) {
  for (let i = 0; i < KEYS.length; i++) { const k = KEYS[i]; out[k[0]] = parts[k[1]].rotation[k[2]]; }
  out.by = parts.body.position.y;
  return out;
}

// a pose that names EVERY joint: what it leaves out is zero, which is standing
const full = (p) => {
  const o = { by: 0 };
  for (let i = 0; i < KEYS.length; i++) o[KEYS[i][0]] = 0;
  return Object.assign(o, p);
};
// the same pose for the other hand: swap the sides, flip what is sideways
const SWAP = { alx: 'arx', arx: 'alx', el: 'er', er: 'el', llx: 'lrx', lrx: 'llx', kl: 'kr', kr: 'kl', fl: 'fr', fr: 'fl' };
const FLIP = { alz: 'arz', arz: 'alz', llz: 'lrz', lrz: 'llz' };
export function mirrored(p) {
  const o = {};
  for (const k in p) {
    if (SWAP[k]) o[SWAP[k]] = p[k];
    else if (FLIP[k]) o[FLIP[k]] = -p[k];
    else if (k === 'ty' || k === 'tz' || k === 'hy') o[k] = -p[k];
    else o[k] = p[k];
  }
  return o;
}
const smooth = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k * k * (3 - 2 * k));
const seg = (k, a, b) => smooth((k - a) / (b - a));

// ---- a car door: the RIGHT hand, mirrored for the left ------------------------
const REACH = { tx: -0.16, hx: -0.18, arx: 0.70, arz: 0.04, er: 0.22 };
const TUG = { tx: 0.06, hx: -0.12, arx: 0.34, arz: 0.10, er: 1.05, ty: -0.14 };
const SWING = { tx: 0.08, hx: -0.1, arx: 0.38, arz: 0.50, er: 0.80, ty: -0.18 };
const REACH_L = mirrored(REACH), TUG_L = mirrored(TUG), SWING_L = mirrored(SWING);

/** A hand goes out to the handle. k 0..1; right = which hand. Over a stand. */
export function reachPose(parts, k, right) {
  pose(parts, right ? REACH : REACH_L, smooth(k));
}

/** The handle does not give: two short pulls, the shoulders rocking with them.
 *  k runs 0..1 over the whole attempt and ends with the arm coming down. */
export function tugPose(parts, k, right) {
  const out = 1 - seg(k, 0.78, 1);
  pose(parts, right ? REACH : REACH_L, out);
  // two pulls, each a quick draw and a slower give
  const ph = (k * 2.6) % 1, pull = k < 0.77 ? Math.sin(Math.min(1, ph * 1.6) * Math.PI) : 0;
  pose(parts, right ? TUG : TUG_L, pull * out);
}

/** The door comes open in the hand: k is how far it has swung. */
export function swingPose(parts, k, right) {
  pose(parts, right ? REACH : REACH_L, 1);
  pose(parts, right ? SWING : SWING_L, smooth(k));
}

// Hauling somebody out of the seat: both hands in at chest height, then the
// whole body heaves back and round, away from the car.
const GRAB = { tx: -0.38, hx: 0.1, alx: 1.15, arx: 1.15, alz: 0.12, arz: -0.12, el: 0.25, er: 0.25, llx: 0.25, kl: -0.3 };
const HEAVE = { tx: 0.16, ty: -0.55, alx: 0.55, arx: 0.75, alz: -0.5, arz: 0.4, el: 1.1, er: 0.9, llx: -0.2, lrx: 0.3, kl: -0.2, kr: -0.5 };
const HEAVE_L = mirrored(HEAVE);
/** k 0..1: in, grip, heave. right: the door is on the figure's right-hand reach. */
export function haulPose(parts, k, right) {
  pose(parts, GRAB, seg(k, 0, 0.32) * (1 - seg(k, 0.85, 1)));
  pose(parts, right ? HEAVE : HEAVE_L, seg(k, 0.36, 0.62) * (1 - seg(k, 0.8, 1)));
}

// Ducking in. `lead` is the leg that goes in first (true: the right one).
const DUCK = { tx: -0.62, hx: 0.30, alx: 0.55, arx: 0.55, el: 0.7, er: 0.7, lrx: 1.20, kr: -1.25, llx: 0.15, kl: -0.35, by: -0.10 };
const DUCK_L = mirrored(DUCK);

/** Between standing at the door and sitting in the seat: k 0..1. The owner
 *  blends its own sit pose in; this is the stoop and the leading leg, which
 *  peak in the middle and are gone at both ends. */
export function duckPose(parts, k, leadRight) {
  pose(parts, leadRight ? DUCK : DUCK_L, Math.sin(Math.min(1, Math.max(0, k)) * Math.PI) * 0.85);
}

// Seated, the outside arm out to the door. Left arm (the driver's), mirrored.
const PULL_OUT = { alx: 0.75, alz: -0.95, el: 0.35, ty: 0.22, hy: 0.25 };
const PULL_IN = { alx: 0.70, alz: -0.25, el: 1.30, ty: 0.05 };
const PULL_OUT_R = mirrored(PULL_OUT), PULL_IN_R = mirrored(PULL_IN);

/** Reaching out for the open door and drawing it shut: k 0..1 (0 arm out at
 *  the open door, 1 the door shut and the hand coming back). Over a sit. */
export function pullDoorPose(parts, k, left) {
  const a = left ? PULL_OUT : PULL_OUT_R, b = left ? PULL_IN : PULL_IN_R;
  const on = seg(k, -0.25, 0.1) * (1 - seg(k, 0.85, 1.15));
  pose(parts, a, on);
  pose(parts, b, smooth(k) * on);
}

// ---- jumping ---------------------------------------------------------------------
const J_PUSH = { by: -0.10, tx: -0.30, llx: 0.55, lrx: 0.55, kl: -1.0, kr: -1.0, fl: 0.4, fr: 0.4, alx: -0.7, arx: -0.7, el: 0.3, er: 0.3 };
const J_RISE = { by: 0, tx: -0.14, hx: -0.08, llx: 1.00, lrx: 0.10, kl: -1.35, kr: -0.55, fl: -0.2, fr: -0.5, alx: 0.35, arx: 1.25, el: 1.0, er: 0.9, alz: -0.2, arz: 0.2 };
const J_FALL = { by: 0, tx: -0.20, llx: 0.42, lrx: 0.18, kl: -0.55, kr: -0.32, fl: -0.25, fr: -0.25, alx: 0.35, alz: -0.75, arx: 0.35, arz: 0.75, el: 0.5, er: 0.5 };
const J_STAND_RISE = { by: 0, tx: -0.05, llx: 0.35, lrx: 0.35, kl: -0.8, kr: -0.8, fl: -0.4, fr: -0.4, alx: 1.9, arx: 1.9, el: 0.4, er: 0.4, alz: -0.25, arz: 0.25 };
const J_LAND = { by: -0.17, tx: -0.40, llx: 0.78, lrx: 0.62, kl: -1.30, kr: -1.12, fl: 0.48, fr: 0.48, alx: 0.55, arx: 0.55, alz: -0.3, arz: 0.3, el: 0.8, er: 0.8 };

/**
 * In the air. t: seconds since the feet left the ground; vy: vertical speed
 * (rising positive); run 0..1: how much of it is a running jump (a knee drives
 * up and the arms pump) against a standing one (both arms thrown up).
 */
export function jumpPose(parts, t, vy, run) {
  const push = 1 - seg(t, 0, 0.11);
  const up = run > 0.5 ? J_RISE : J_STAND_RISE;
  pose(parts, up, 1 - push * 0.6);
  if (push > 0) pose(parts, J_PUSH, push * 0.6);
  // coming down: open out and feel for the ground
  pose(parts, J_FALL, seg(-vy, -1.0, 3.0));
}

/** The knees take the landing: k 0..1 from touchdown to upright again. `hard`
 *  0..1 is how deep. Over a stand or a walk. */
export function landPose(parts, k, hard = 1) {
  const w = (k < 0.25 ? seg(k, 0, 0.25) : 1 - seg(k, 0.25, 1)) * (0.45 + 0.55 * hard);
  pose(parts, J_LAND, w);
}

// ---- vaulting: one hand down, both legs over to the other side -----------------
// Left hand plants, the legs go over to the right; mirrored for the other hand.
const V_REACH = { tx: -0.48, hx: 0.15, alx: 1.30, alz: -0.10, el: 0.12, arx: -0.35, er: 0.6, llx: 0.55, kl: -0.95, lrx: 0.05, kr: -0.25, by: -0.05 };
const V_OVER = { tx: -0.50, tz: 0.38, hx: 0.25, alx: 0.55, alz: -0.55, el: 0.08, arx: 0.35, arz: 1.0, er: 0.45,
  llx: 1.38, lrx: 1.22, llz: 0.60, lrz: 0.60, kl: -0.85, kr: -1.15, fl: -0.3, fr: -0.3, by: 0 };
const V_EXIT = { tx: -0.22, tz: 0.10, alx: -0.55, alz: -0.2, el: 0.35, arx: 0.55, er: 0.6, llx: 0.75, lrx: 0.30, llz: 0.15, lrz: 0.1, kl: -0.55, kr: -0.5, by: 0 };
const V_REACH_R = mirrored(V_REACH), V_OVER_R = mirrored(V_OVER), V_EXIT_R = mirrored(V_EXIT);

/** Over the top. k 0..1 from the first step up to the feet coming down;
 *  leftHand: which hand takes the weight. Over a stand. */
export function vaultPose(parts, k, leftHand = true) {
  const a = leftHand ? V_REACH : V_REACH_R, b = leftHand ? V_OVER : V_OVER_R, c = leftHand ? V_EXIT : V_EXIT_R;
  pose(parts, a, seg(k, 0, 0.22));
  pose(parts, b, seg(k, 0.18, 0.46));
  pose(parts, c, seg(k, 0.62, 0.86));
  if (k > 0.86) pose(parts, J_LAND, seg(k, 0.86, 1) * 0.5);
}

// ---- getting up off the ground ---------------------------------------------------
// Two ways up, because there are two ways to lie. Face down: hands under the
// shoulders, up onto all fours, one foot forward, stand. Face up: sit up, pull
// the feet in under, rock forward into a squat, stand. The owner turns the
// whole figure and lifts it (js/ejection.js riseCurve has the matching pitch
// and height); these are the limbs that make that turn a person's.
const G_READY = full({ alx: -0.25, alz: -0.55, arx: -0.25, arz: 0.55, el: 2.15, er: 2.15, hx: 0.25, llx: 0.05, lrx: 0.05, kl: -0.1, kr: -0.1 });
const G_ALL4 = full({ alx: 1.50, arx: 1.50, el: 0.10, er: 0.10, hx: 0.55, llx: 1.50, lrx: 1.50, kl: -1.55, kr: -1.55, fl: -0.6, fr: -0.6 });
const G_KNEEL = full({ tx: -0.15, hx: 0.25, alx: 0.25, el: 0.3, arx: 1.05, er: 0.75, llx: 0.50, kl: -1.60, fl: -0.7, lrx: 1.70, kr: -1.50, fr: 0.2 });
const G_SIT = full({ tx: -0.18, hx: -0.1, alx: -0.75, alz: -0.25, arx: -0.75, arz: 0.25, el: 0.25, er: 0.25, llx: 1.37, lrx: 1.37, kl: -0.30, kr: -0.42 });
const G_SQUAT = full({ tx: -0.30, hx: 0.25, alx: 0.95, arx: 0.95, el: 0.45, er: 0.45, llx: 1.95, lrx: 1.90, kl: -2.30, kr: -2.25, fl: 0.65, fr: 0.65 });
const G_UP = full({});

/**
 * k 0..1 through the whole get-up; faceUp: lying on the back; from: the
 * snapshot of how the body lay (the thrown splay), which the first move
 * blends out of. Writes every joint: no base pose is needed under it.
 */
export function getUpPose(parts, k, faceUp, from) {
  if (from) pose(parts, from, 1);
  if (faceUp) {
    pose(parts, G_SIT, seg(k, 0, 0.30));
    pose(parts, G_SQUAT, seg(k, 0.34, 0.62));
    pose(parts, G_UP, seg(k, 0.66, 1));
  } else {
    pose(parts, G_READY, seg(k, 0, 0.20));
    pose(parts, G_ALL4, seg(k, 0.22, 0.48));
    pose(parts, G_KNEEL, seg(k, 0.52, 0.72));
    pose(parts, G_UP, seg(k, 0.76, 1));
  }
}

// Hands behind the head, on the knees: an arrest (js/arrest.js).
const HANDS_HEAD = { alx: 2.0, alz: -0.85, el: 2.2, arx: 2.0, arz: 0.85, er: 2.2, hx: -0.15, tx: -0.05 };
const KNEES = full({ ...HANDS_HEAD, llx: 0.0, lrx: 0.0, kl: -1.57, kr: -1.57, fl: -0.9, fr: -0.9, by: -0.44 });
/** Giving up: k 0..1 from standing to kneeling with the hands on the head. */
export function surrenderPose(parts, k) {
  pose(parts, HANDS_HEAD, seg(k, 0, 0.45));
  pose(parts, KNEES, seg(k, 0.4, 1));
}
