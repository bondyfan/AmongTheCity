// ---- arrest-card.js: the clock of the ZATČEN card ----
// main.js owns the card (`arrest`: busted makes it, pumpArrest runs it) and
// what each step does. This file is only WHEN, and who owns the body:
//   the hands go up over HELD_IN, the word comes at SHOW_AT,
//   at MOVE_AT the campaign starts again (it has no save), else the card goes
//   black; at BACK_AT the game steps back to the last save; the card lifts
//   once that place exists and LIFT_AT has passed, or after GIVE_UP.
//
// SEJMUT OVERRIDES ZATČEN. A policeman's bullet does not ask whether he is in
// handcuffs (js/copfire.js goes straight to vitals.damage), so he can die on
// his knees. The death handler then owns him: the hospital in free roam, the
// campaign's restart in the campaign. The arrest must let go at once. It used
// to run on: 4.3 s in it stepped back to the last save with the body still
// down, and the hospital's timer then carried that body off a second time and
// charged its fee on top of the arrest's reset (review, 25 Nov 2026).
//
// A CAMPAIGN'S BLACK CARD OWNS HIM TOO. A replay raised while he is held
// would be reset to the last save by the arrest a moment before it starts;
// main.js replayCampaign refuses during an arrest, and this clock lets go if
// a card is up all the same.
// Pure: no three.js, no world. Tested in tests/arrest-card.test.mjs.

export const HELD_IN = 0.9;   // s for the hands to go up
export const SHOW_AT = 1.0;   // s: the word ZATČEN
export const MOVE_AT = 3.4;   // s: the campaign restarts, or the card goes black
export const BACK_AT = 4.3;   // s: back to the last save
export const LIFT_AT = 5.2;   // s: the earliest the card may lift
export const GIVE_UP = 30;    // s: it lifts even over a place that never arrived

/** A new card. `extra` rides along (its element). */
export const arrestCard = (extra) => ({ t: 0, moved: false, shown: false, back: false, ...extra });

/** How far the hands are up, 0..1 (main.js writes it until the card moves him). */
export const heldPose = (o) => Math.min(1, o.t / HELD_IN);

/**
 * One frame of the card. Says what is due this frame:
 *   drop     let go of him and take the card away (he is down, or a campaign
 *            card is up); nothing else is due with it
 *   show     the word comes up
 *   restart  the campaign starts again (`story`); the card goes with it
 *   out      the card goes black
 *   back     the game steps back to the last save
 * `story`: a chapter of the campaign is being played. `card`: the campaign's
 * black card is up.
 */
export function arrestStep(o, dt, { down, story, card }) {
  const due = { drop: false, show: false, restart: false, out: false, back: false };
  if (down || (card && !story)) { due.drop = true; return due; }
  o.t += dt;
  if (!o.shown && o.t > SHOW_AT) due.show = o.shown = true;
  if (!o.moved && o.t > MOVE_AT) {
    o.moved = true;
    if (story) { due.restart = true; return due; }
    due.out = true;
  }
  if (o.moved && !o.back && o.t > BACK_AT) due.back = o.back = true;
  return due;
}

/** May the card lift? Only once he is back at the save. */
export const arrestLift = (o, ready) => o.back && ((ready && o.t > LIFT_AT) || o.t > GIVE_UP);
