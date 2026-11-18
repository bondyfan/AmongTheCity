// ==========================================================================
// Police tuning: what each star buys, and how well a policeman shoots.
//
// Pure numbers and pure functions, no three.js, no DOM, so the pursuit's
// escalation and the gunfire's fairness can be asserted in `node --test`
// without a world (tests/police.test.mjs).
//
// THE LADDER. One star is a patrol that follows you and, if you stop, gets out
// with a pistol. Two stars add a second car that is allowed to shunt you from
// behind. Three stars add a third car that drives AHEAD of you (aims at where
// you will be in a few seconds, so the greedy router brings it down a parallel
// street and it arrives in front: a box), and the tail cars may PIT you. Four
// and five raise the ceiling speed and shorten every reaction: the rubber band
// is wider, rams come sooner, the shooting is quicker and a little better.
//
// NOBODY SHOOTS BELOW THREE STARS (`lethal`). At one and two stars the police
// want you alive: the cars close in and box you (from two stars the second car
// goes ahead to block the road), the officers get out with their hands free,
// run at you and lay hands on you. Stand still beside one, or sit in a stopped
// car with one at the door, and you are arrested (js/policecops.js). The
// pistols come out at three.
//
// THE BAND'S NEAR END (`near`, metres) is where the rubber band stops
// helping. At one star it is police.js's original 40 m: a single patrol sits
// back and follows, and only reaches you when you stop. From two stars it is
// 10 to 14 m, so a unit on a car doing a little over the limit still closes
// the last stretch and gets close enough to ram (policeram.js, FREE_IN).
//
// THE CEILING STAYS UNDER THE PLAYER'S CAR. vehicles.js tops every passenger
// car out at 56 to 72 m/s; the fastest tier here is 52 m/s. An open road is
// still an escape at five stars; a town is not. That is the "not a Gripen"
// clause from police.js, kept at every tier.
//
// FAIRNESS IN THE SHOOTING. A shot is aimed at the centre of what it wants to
// hit and then thrown off by a Gaussian angle. The angle has three parts:
//
//   SIG0     0.035 rad  the steady hand of a man under stress. At 10 m that is
//                       35 cm of scatter, so a standing target is hit about
//                       half the time; at 25 m one shot in six; at 50 m one
//                       in twenty-five (hitChance below, pinned by the test).
//   SIG_MOVE 0.030 rad  added while the SHOOTER walks or runs.
//   SIG_TV   0.0045 rad per m/s of the TARGET's speed (lead error). A man
//                       sprinting at 6 m/s adds 0.027; a car at 20 m/s adds
//                       0.09, so a moving car is mostly safe from a pistol and
//                       a car that has stopped is not.
//
// Each tier divides the sum by its `acc`, so five stars shoot 30 % tighter,
// never perfectly. Before the first shot there is always a raised pistol on
// screen for `react` seconds (plus a random 0 to 0.4 s): the telegraph.
// ==========================================================================

/** Tier records, index = stars. Frozen: a caller that wants other numbers
 *  builds its own table rather than editing the game's. */
export const TIERS = Object.freeze([
  null,
  Object.freeze({ stars: 1, units: 1, near: 40, band: 2.2, vmax: 42, ram: false, pit: false, box: false, lethal: false,
    cops: 1, rate: 0.55, acc: 0.85, react: 1.25, ramCd: 0, ramClose: 0, dmg: 0.85 }),
  Object.freeze({ stars: 2, units: 2, near: 14, band: 2.2, vmax: 42, ram: true, pit: false, box: true, lethal: false,
    cops: 2, rate: 0.7, acc: 1.0, react: 1.0, ramCd: 6.5, ramClose: 5.5, dmg: 1.0 }),
  Object.freeze({ stars: 3, units: 3, near: 12, band: 2.35, vmax: 44, ram: true, pit: true, box: true, lethal: true,
    cops: 2, rate: 0.8, acc: 1.05, react: 0.9, ramCd: 5.0, ramClose: 6.5, dmg: 1.0 }),
  Object.freeze({ stars: 4, units: 4, near: 10, band: 2.6, vmax: 48, ram: true, pit: true, box: true, lethal: true,
    cops: 2, rate: 1.0, acc: 1.2, react: 0.75, ramCd: 3.8, ramClose: 8, dmg: 1.1 }),
  Object.freeze({ stars: 5, units: 5, near: 10, band: 2.8, vmax: 52, ram: true, pit: true, box: true, lethal: true,
    cops: 2, rate: 1.15, acc: 1.3, react: 0.65, ramCd: 3.0, ramClose: 9, dmg: 1.2 }),
]);

export const MAX_UNITS = 5;

// Round 8, the D11. The tier ceilings above are town numbers (151 to 187
// km/h), and a player cruising the motorway at 180 could not be caught below
// five stars. On a carriageway the ceiling rises with the player: a few m/s
// over what they are doing, up to MW_COP_VMAX (223 km/h, what a Škoda Superb
// pursuit car does), never under the tier's own.
export const MW_COP_VMAX = 62;
export const MW_COP_OVER = 4;
/** The pursuit ceiling (m/s) on a motorway carriageway, from the tier's and the player's speed. */
export function motorwayVmax(base, pspeed) {
  const v = (pspeed > 0 ? pspeed : 0) + MW_COP_OVER;
  return v > base ? (v < MW_COP_VMAX ? v : MW_COP_VMAX) : base;
}

/** The tier for a star count, or null at zero. Non-finite reads as zero. */
export function tierFor(stars) {
  const s = Number.isFinite(stars) ? Math.floor(stars) : 0;
  if (s <= 0) return null;
  return TIERS[s > 5 ? 5 : s];
}

// ---- the gunfire -----------------------------------------------------------

export const SIG0 = 0.035;
export const SIG_MOVE = 0.030;
export const SIG_TV = 0.0045;
export const FIRE_R = 55;          // m: a pistol past this is noise, not a threat

/** What a shot is aimed at. Half extents of the silhouette the shooter sees. */
export const FOOT_HW = 0.26, FOOT_HH = 0.85, FOOT_CY = 0.95, FOOT_R = 0.28, FOOT_H = 1.8;
export const CAR_HH = 0.66, CAR_CY = 0.78, CAR_H = 1.45;

/** The scatter angle, radians, of one shot. */
export function aimSigma(shooterMoving, targetSpeed, acc = 1) {
  const tv = Number.isFinite(targetSpeed) ? Math.min(30, Math.abs(targetSpeed)) : 0;
  const a = Number.isFinite(acc) && acc > 0 ? acc : 1;
  return (SIG0 + (shooterMoving ? SIG_MOVE : 0) + tv * SIG_TV) / a;
}

// erf by Abramowitz and Stegun 7.1.26: 1.5e-7 is plenty for a probability.
function erf(x) {
  const s = x < 0 ? -1 : 1, ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

/**
 * The chance that one shot at range `d` lands inside a target of half width
 * `hw` and half height `hh`, with scatter `sigma` radians on both axes. The
 * shot model in js/copfire.js draws exactly this distribution, so this is the
 * expected hit rate and the test can hold the game to a stated band.
 */
export function hitChance(d, sigma, hw = FOOT_HW, hh = FOOT_HH) {
  if (!(d > 0) || !(sigma > 0)) return 1;
  const s = d * sigma * Math.SQRT2;
  return erf(hw / s) * erf(hh / s);
}

/** Half the width a car shows a shooter looking along `rel` radians off its
 *  axis: the box's shadow on the line of sight. */
export function carHalfWidth(len, wid, rel) {
  return Math.abs(Math.sin(rel)) * len / 2 + Math.abs(Math.cos(rel)) * wid / 2;
}

/** One standard normal draw from a uniform source (Box and Muller). */
export function gauss(rnd) {
  let u = rnd();
  if (!(u > 1e-9)) u = 1e-9;
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Damage of one pistol hit, before the tier's `dmg`. On foot it is the man;
 *  through a car body most of it stays in the metal. */
export const HIT_FOOT = [9, 14];
export const HIT_CABIN = [6, 10];
export const CABIN_P = 0.3;        // chance a round that hits the car reaches you
