// ---- campaignparts.js: the parts of the campaign, where each begins, and how ----
// Frank, 25 Nov 2026: "ty mise musí mít vždycky konec, a ne, že to automaticky
// začne další mise ... kampaň 1. Konec, aby tam byla, a potom, když já půjdu na
// nějaký místo, tak začne 2, chápeš, a takhle, aby to bylo u každé kampaně."
// And: "kampan se musi dat ukoncit.. asi v nastaveni - kampan a tam ukoncit".
//
// So every part ends on a card of its own ("Část 1 · Konec") and nothing
// chains on. The next part waits at the place it begins: a mark on both maps
// and a column of light in the world (js/campaignmark.js). Walking or driving
// into it starts the part. A part that is quit, or never finished because the
// tab was closed, waits at its own start the same way.
//
// A new part is one more entry in PARTS: js/career.js says which is next,
// main.js starts it, the Kampaně tab (js/campaignmenu.js) lists it.
// Pure: no three.js, no DOM. Tested in tests/campaignflow.test.mjs.

import { street, kolinPlatform, pardubicePlatform, roofFrame } from './prologue-route.js';
import { start as heistStart } from './heist-route.js';

export const PARTS = Object.freeze([
  Object.freeze({
    id: 'part1', n: 1, title: 'Poslední vlak · část 1', sub: 'Z Kolína posledním vlakem za Vaškem',
    // the pavement of Dukelských hrdinů in Kolín, where the hospital rings
    at: Object.freeze({ x: street.x, z: street.z, h: street.h }), place: 'Kolín · Dukelských hrdinů',
  }),
  Object.freeze({
    id: 'part2', n: 2, title: 'Poslední vlak · část 2', sub: 'Auto pod Kunětickou horou',
    // the pavement at Vašek's door, Dražkovická 119
    at: Object.freeze({ x: heistStart.x, z: heistStart.z, h: heistStart.h }), place: 'Pardubice · Dražkovická 119',
  }),
]);
export const partOf = (id) => PARTS.find((p) => p.id === id) ?? null;

/** The card a part ends on: its number and "Konec", the campaign's name under it. */
export const endCard = (id) => ['Část ' + (partOf(id)?.n ?? '') + ' · Konec', 'Poslední vlak'];

// THE START MARK. A radius to walk into (a car is wider and faster: more), and
// a man who is already standing in it (part one ends ON part two's start, at
// Vašek's door) has to step out of it first: the next part never begins under
// his feet the moment the last one ends.
export const START_R = 3.2;    // m on foot
export const START_R_CAR = 6;  // m at the wheel
export const ARM_OUT = 4;      // m past the radius that arm the mark again

/** A gate for one start mark: { part, armed }. */
export const startGate = () => ({ part: null, armed: false });

/**
 * One frame of the gate. `part` is the waiting part (or null), `x, z` where he
 * is, `inCar` whether he drives. True on the frame he walks or drives in.
 */
export function gateStep(g, part, x, z, inCar) {
  if (!part) { g.part = null; g.armed = false; return false; }
  const r = inCar ? START_R_CAR : START_R;
  const d = Math.hypot(x - part.at.x, z - part.at.z);
  if (g.part !== part.id) { g.part = part.id; g.armed = d > r + ARM_OUT; return false; }
  if (!g.armed) { g.armed = d > r + ARM_OUT; return false; }
  if (d >= r) return false;
  g.armed = false;
  return true;
}

/**
 * Where to stand him when a part is quit, or null to leave him where he is.
 * The campaign's decks go with it: the roof in Kolín, the coach of the last
 * train, the villa's rooms deep under the house. `chapter` is part one's
 * chapter (or null), `aboard` whether he is in the story's coach, `y` his
 * height and `ground` the terrain's under him.
 *   { x, z } stand him there on the ground; { drop: true } on the ground here.
 */
export function quitSpot({ chapter, aboard, inCar, x, z, y, ground }) {
  if (inCar) return null;
  if (aboard) {
    // the train stood in Kolín until it left; after that it is Pardubice's
    const p = chapter === 'station' ? kolinPlatform : pardubicePlatform;
    return { x: p.x, z: p.z };
  }
  const up = y - ground;
  if (up > 2.5) {
    // the one high place of the campaign is the roof in Kolín: down to its street
    if (Math.hypot(x - roofFrame.x, z - roofFrame.z) < 120) return { x: street.x, z: street.z };
    return { drop: true };
  }
  if (up < -2.5) return { drop: true };
  return null;
}

/** What the Kampaně tab says under the part that waits. */
export const startNote = (p) => (p ? 'Další na řadě · začíná: ' + p.place : '');
