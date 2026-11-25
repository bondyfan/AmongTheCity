// ---- story-over.js: the clock of the black card between a failure and the restart ----
// main.js owns the card itself (`storyOver`: failStory makes it, pumpStoryOver
// runs it) and what the move does. This file is only WHEN:
//   the body goes back to the start once the card is fully black (MOVE_AT),
//   the card lifts once the street there exists again and LIFT_AT has passed,
//   or after GIVE_UP seconds whatever the street says.
//
// KILLED AGAIN UNDER THE CARD. Between the move and the lift he stands alive at
// the start while that street is still being built, and the world goes on: a
// car, a tackle or a crowd can kill him there. The death handler then asks for
// a new failure, the card is still up, so that request is dropped, and the one
// revive of this card is already spent. He stayed down for the rest of the
// session: no keys, no fists, no damage, no heal (review of 25 Nov 2026).
// So the clock looks at the body every frame: a body that is down after the
// move puts the card back before it, and the move (with its revive) runs again.
// Pure: no three.js, no world. Tested in tests/story-over.test.mjs.

export const MOVE_AT = 1.4;   // s into the card: it is black, the body goes back
export const LIFT_AT = 3.4;   // s into the card: the earliest it may lift
export const GIVE_UP = 30;    // s: it lifts even over a street that never arrived
export const AGAIN_IN = 1;    // s from a death under the card to the next move

/** A new card. `extra` rides along (its element, the part being replayed). */
export const overCard = (extra) => ({ t: 0, moved: false, again: 0, ...extra });

/**
 * One frame of the card. True on the frame the body has to be put back at the
 * start and revived: once per card, and once more for every death under it.
 */
export function dueMove(o, dt, down) {
  o.t += dt;
  if (o.moved && down) {
    o.moved = false;
    o.t = MOVE_AT - AGAIN_IN;
    o.again++;
    return false;
  }
  if (o.moved || o.t <= MOVE_AT) return false;
  o.moved = true;
  return true;
}

/** May the card lift? Only after the move, so never over a body that is down. */
export const dueLift = (o, ready) => o.moved && ((ready && o.t > LIFT_AT) || o.t > GIVE_UP);

// WHERE A DEATH GOES. In the campaign there is no hospital: it starts again
// ('story'). The campaign is a chapter of part one that is not over, part two
// running, or a CARD that is up. The card has to count on its own, because a
// replay's card (the Kampaně tab) is up over a save that still says 'done':
// part one's chapter only begins at the card's move, and part two is not made
// before the card lifts. A death in that window used to take the hospital's
// timer: the card revived him at the start, and 4 s after the death he was
// carried to a hospital, billed, and the replay was gone (review, 25 Nov 2026).
export const deathGoesTo = ({ chapter, journeys, heist, card }) =>
  (journeys && !!chapter && chapter !== 'done') || heist || card ? 'story' : 'hospital';
