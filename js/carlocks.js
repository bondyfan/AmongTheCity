// ---- carlocks.js: which parked cars can be opened ---------------------------
//
// A parked car is somebody's, and somebody locked it. Ninety-nine in a hundred
// refuse the handle; one was left open. Which one is a property of the CAR, not
// of the moment you try it, so the same car answers the same way every time and
// on every co-op screen: the draw is hashed from where the car was first seen
// standing and what it is.
//
// Never locked:
//   * the car the player owns (js/garage.js sets `owned`),
//   * a car the story hands over (`unlocked`: Vašek's estate, a dev spawn),
//   * a car the player has already sat in (main.js marks it `unlocked` when
//     the seat is reached: you do not lock yourself out of a car you took),
//   * anything that is not a parked car at all. A car in traffic has a driver
//     in it, and that is js/carjack.js's business, not a lock's.
//
// Pure numbers: no three, no DOM, so the tests and the net layer can read it.

/** Share of parked cars somebody forgot to lock. */
export const OPEN_SHARE = 0.01;

// The same integer mix the crowd and the traffic use for their draws.
function mix(a, b, c) {
  let h = (a | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (b | 0), 0x85ebca6b); h ^= h >>> 13;
  h = Math.imul(h ^ (c | 0), 0xc2b2ae35); h ^= h >>> 16;
  h = Math.imul(h, 0x27d4eb2f); h ^= h >>> 15;
  return h >>> 0;
}

function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h | 0;
}

/**
 * The car's draw, 0..1, fixed the first time it is asked for. A fleet car has
 * a key the whole room shares (parkIdx); any other parked car is known by the
 * spot it stood on when it was first tried, to the nearest half metre.
 */
export function lockDraw(car) {
  if (car._lockDraw !== undefined) return car._lockDraw;
  const k = strHash(String(car.kind ?? ''));
  const h = Number.isInteger(car.parkIdx)
    ? mix(0x51ed, car.parkIdx, k)
    : mix(Math.round((car.x ?? 0) * 2), Math.round((car.z ?? 0) * 2), k);
  return (car._lockDraw = h / 4294967296);
}

/** Does this parked car refuse the handle? */
export function isLocked(car) {
  if (!car || car.owned || car.unlocked) return false;
  return lockDraw(car) >= OPEN_SHARE;
}

/** The car is open from now on (the story's car, a car the player has taken). */
export function unlock(car) {
  if (car) car.unlocked = true;
}
