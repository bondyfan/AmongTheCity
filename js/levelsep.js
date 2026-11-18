// ---- levelsep.js: two things on different LEVELS do not meet --------------------
// Pure: no three, no DOM, no state.
//
// WHY. The world has decks: a road over a road, a railway over a street, a
// footbridge over a carriageway. Every test of "are these two in each other's
// way" in the game was written on a flat plan, in x and z: two discs touch, a
// car is ahead in my lane, a walker stands in my path, a mast is at my nose.
// With a deck in the picture each of those is true of things six metres
// apart, one over the other: the player's car under a bridge crashed into the
// traffic crossing it, a queue under a viaduct waited for a pedestrian on it,
// and a mast on the deck fell to a car below.
//
// ONE RULE, so every test separates the same pairs. Two things are on the
// same level when the heights they stand at differ by no more than LEVEL_GAP,
// plus what a road may climb over the plan distance between them (a leader
// forty metres up a ramp is still my leader). The heights are where each
// STANDS (wheels, feet, a mast's base), not where its roof is.
//
// The numbers: a car is about 1.5 m tall, a bus 3.2. The lowest deck the
// levelling builds over a footpath clears 2.6 m and carries a metre of
// structure (js/underpass.js CLEAR_FOOT, DECK_DEPTH), over a carriageway
// 4.5 m: so surfaces of two levels are never less than about 3.6 m apart,
// and nothing that can touch is more than 2.4 m apart in height (a kerb, a
// ramp's foot, a flight of steps). An unknown height (undefined, NaN) never
// separates: what cannot be told apart behaves as it always did.

/** m: the most two things on ONE level differ by in height where they stand. */
export const LEVEL_GAP = 2.4;
/** The grade a road may hold between two things `dist` m apart in plan. */
export const LEVEL_GRADE = 0.08;

/**
 * Are heights ya and yb (where two things stand) on one level?
 * `dist`: the plan distance between them, for tests that look far ahead.
 */
export function sameLevel(ya, yb, dist = 0) {
  const d = ya - yb;
  if (d !== d) return true;                     // an unknown height separates nothing
  const gap = LEVEL_GAP + LEVEL_GRADE * (dist > 0 ? dist : 0);
  return d <= gap && d >= -gap;
}

/**
 * Does a thing standing at `y` reach into the band a body occupies from
 * `base` up to `base + tall` (a mast, a hull, a tram)? Used where one of the
 * two is TALL and the other is asked at its own level.
 */
export function inBand(y, base, tall, below = LEVEL_GAP) {
  if (!Number.isFinite(y) || !Number.isFinite(base)) return true;    // unknown: as it always was
  return y <= base + tall && y >= base - below;
}
