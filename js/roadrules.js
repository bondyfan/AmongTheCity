// ---- the rules of the road, as arithmetic -------------------------------------
// Three decisions a driver (or a walker) makes at the edge of somebody else's
// right of way, pulled out of js/traffic.js so each can be read and tested as
// the small pure function it is:
//
//   walkPhaseWait   when may a walker start across a signalled road?
//   yieldSpeed      how fast may a car still be going, this far short of a
//                   crossing somebody is on or waiting at?
//   mayEnter        does that other car oblige me to wait at my give-way line?
//
// Only + - x / and sqrt: the walk phase is baked into shared pedestrian
// timelines, so it has to come out the same on every engine.

/** What controls the end of a road at a junction (js/streets.js leg.ctl). */
export const CTL = { NONE: 0, GIVE: 1, STOP: 2 };

/**
 * Seconds until a walker may START crossing.
 *   u0       the junction's clock: shared seconds plus its own offset
 *   bucket   0 or 1: the phase the cars ON THE ROAD BEING CROSSED run in
 *   crossT   seconds the walker needs to get across
 *   cycle    full signal cycle; carT is how long the cars' green and amber last
 * The cars' red is the walkers' green, less the time needed to finish crossing
 * before it ends. A crossing too long for one red still gets a short window at
 * the start of it (the driver who then finds somebody on the zebra waits).
 */
export function walkPhaseWait(u0, bucket, crossT, cycle, carT) {
  let u = (u0 + (bucket ? cycle / 2 : 0)) % cycle;
  if (u < 0) u += cycle;
  const start = carT + 0.6;
  let end = cycle - (crossT > 0 ? crossT : 0) - 0.4;
  if (end < start + 1.5) end = start + 1.5;
  if (u < start) return start - u;
  if (u <= end) return 0;
  return cycle - u + start;
}

/**
 * The speed a car may hold `gap` metres short of where it has to be standing.
 * Returns -1 when the crossing puts no constraint on this car:
 *   · somebody merely WAITING at a zebra (must = false) is given way to only by
 *     a driver who can do it without standing on the brakes (askDecel);
 *   · somebody ON the road (must = true) is braked for as hard as the car can
 *     (hardDecel), and a car that cannot stop even so is not asked to try: the
 *     walker looked before stepping out, so that car was already too close.
 * Otherwise the comfortable envelope v = sqrt(2 x brake x gap), down to a stop.
 */
export function yieldSpeed(gap, v, must, brake, askDecel, hardDecel) {
  if (!(gap > 0)) return -1;
  const need = v * v / (2 * gap);
  if (need > (must ? hardDecel : askDecel)) return -1;
  const g = gap - 0.6;
  return g <= 0 ? 0 : Math.sqrt(2 * brake * g);
}

/** Does braking from v within gap take more than `soft`? (then: brake hard) */
export function needsHardBrake(gap, v, soft) {
  return gap > 0 ? v * v / (2 * gap) > soft : v > 0.5;
}

/**
 * May a driver at a give-way or stop line pull out, as far as ONE other car is
 * concerned? Returns false when that car has priority and is close enough to
 * matter.
 *   dn        that car's distance to the junction node, metres
 *   toward    cosine between its heading and the direction to the node
 *   vo        its speed, m/s
 *   holding   it is itself waiting at a give-way or stop line (so it is not
 *             priority traffic, whatever it is pointing at)
 *   boxR      radius of the junction box
 *   gapT      seconds of clear road the driver wants
 */
export function mayEnter(dn, toward, vo, holding, boxR, gapT) {
  if (dn < boxR) return !(vo > 0.6);          // somebody is in the junction, moving
  if (holding) return true;
  if (toward < 0.5) return true;              // driving away from it, or across the far side
  return dn / (vo > 3 ? vo : 3) >= gapT;
}
