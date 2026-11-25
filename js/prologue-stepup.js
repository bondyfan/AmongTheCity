// Stepping up onto the coping of the roof, as a movement.
// Frank, 25 Nov 2026: "jak přejde na tu hráz té střechy, tak ať fakt opravdu
// tam jako vyjde, udělá krok, jako pěkná animace, protože teďka tam jako tak
// jako přehupsne bez animace". He used to slide from the felt to the coping
// along a little arc. Now: two short paces up to the wall, the right foot is
// lifted and set on the coping, the weight goes forward over it and the leg
// straightens under him, and the left foot is brought up beside it. Stepping
// back down is the same movement played backwards.
//
// k runs 0 (a step back from the wall, on the felt) to 1 (standing on the
// coping). Pure: the pose for a k, nothing else. Lengths in metres, angles in
// radians; a hip turns the thigh forward for a positive angle, a knee folds
// the shin back for a negative one, the trunk leans forward for a negative.
export const WALK_IN = 0.3;   // the share of k spent walking up to the wall
export const UP_TIME = 2.4;   // seconds from the felt to the coping
export const DOWN_TIME = 1.9; // and back
const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// value at t on a track of [t, value] keys, eased between neighbours
function track(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [b, vb] = keys[i];
    if (t <= b) {
      const [a, va] = keys[i - 1];
      return va + (vb - va) * smooth((t - a) / (b - a));
    }
  }
  return keys.at(-1)[1];
}
// the step itself, t 0..1: [t, value]
const K = {
  // the right foot comes up onto the coping, then that leg lifts him
  hipR: [[0, 0], [0.26, 1.3], [0.34, 1.12], [0.72, 0.1], [1, 0]],
  kneeR: [[0, 0], [0.22, -1.5], [0.34, -1.28], [0.72, -0.12], [1, 0]],
  // the left leg pushes off, trails, folds and is brought up beside the other
  hipL: [[0, 0], [0.3, -0.1], [0.62, -0.42], [0.84, 0.46], [1, 0]],
  kneeL: [[0, 0], [0.34, -0.06], [0.62, -0.62], [0.84, -1.2], [1, 0]],
  // the body: forward over the bent knee, up, and upright again
  lean: [[0, 0], [0.3, -0.2], [0.55, -0.34], [0.8, -0.12], [1, 0]],
  rise: [[0, 0], [0.34, 0.03], [0.74, 0.97], [1, 1]],
  reach: [[0, 0], [0.3, 0.1], [0.74, 0.86], [1, 1]],
  dip: [[0, 0], [0.24, -0.035], [0.4, 0], [1, 0]],
  // the free arm goes forward as a counterweight
  arm: [[0, 0], [0.34, 0.5], [0.7, 0.3], [1, 0]],
};

/**
 * The pose at k. `walk` is how far along the two paces he is (0..1) while he
 * still walks, else null; `step` is the step's own 0..1; `forward` and `up`
 * are 0..1 of the way from the felt to the coping; the rest are joint angles.
 */
export function stepUp(k) {
  k = Math.max(0, Math.min(1, k));
  if (k < WALK_IN) {
    const w = k / WALK_IN;
    return { walk: w, step: 0, forward: 0.5 * w, up: 0, dip: 0, hipR: 0, kneeR: 0, hipL: 0, kneeL: 0, lean: 0, arm: 0 };
  }
  const t = (k - WALK_IN) / (1 - WALK_IN);
  return {
    walk: null, step: t,
    forward: 0.5 + 0.5 * track(K.reach, t),
    up: track(K.rise, t),
    dip: track(K.dip, t),
    hipR: track(K.hipR, t), kneeR: track(K.kneeR, t),
    hipL: track(K.hipL, t), kneeL: track(K.kneeL, t),
    lean: track(K.lean, t), arm: track(K.arm, t),
  };
}
