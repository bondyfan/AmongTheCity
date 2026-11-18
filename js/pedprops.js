// ---- pedprops.js: what a passer-by is doing with their hands, as pure data -----
// A street where everybody walks with empty swinging arms is a street of
// extras. One citizen in three here has something to do with a hand: a bag of
// shopping, a phone at the ear, a pram to push, a dog on a lead.
//
// Import-free, like js/people.js and js/wardrobe.js, and for the same reason:
// the answer has to be the same on every co-op screen and in a headless test,
// so it is a function of the citizen's shared seed and archetype and nothing
// else. js/citizen.js turns it into a held arm and (for the bag and the phone)
// a few triangles in the body's own mesh; js/pedpropdraw.js draws the prams
// and js/dogs.js the dogs, each as rows of one instanced mesh.
//
// SHARED: who has what, which dog, which colour of pram. LOCAL: where exactly
// the dog is sniffing this second (js/dogs.js), which nobody can compare.

export const PROP = Object.freeze({ NONE: 0, BAG: 1, PHONE: 2, PRAM: 3, DOG: 4 });
export const PROP_KEYS = Object.freeze([null, 'bag', 'phone', 'pram', 'dog']);
export const PROP_SALT = 0x9d06c3;

// per hundred walkers of an archetype: [bag, phone, pram, dog]. The rest have
// their hands free. A grandmother carries the shopping; the young are on the
// phone and push the prams; everybody walks dogs; the man with the stick has
// one hand left, and it holds a small dog or nothing.
const SHARE = {
  m30: [9, 13, 4, 7],
  f30: [13, 14, 9, 7],
  f60: [24, 4, 2, 9],
  m60: [14, 6, 1, 10],
  m90: [0, 0, 0, 6],
};

function mix(a, b) {
  let h = (a ^ Math.imul(b | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
const r01 = (h) => (h >>> 8) / 16777216;

export const BAG_TINTS = [0xe9e7e0, 0xe9e7e0, 0xd8c13a, 0x2f66b0, 0xc8452f, 0x3f8f4a, 0xb08a5a, 0xb08a5a];
export const PRAM_TINTS = [0x27324a, 0x3a3d42, 0x1d1f23, 0x7a2f35, 0x4f5640, 0xb3a58a, 0x46586a];
export const DOG_TINTS = [0x1c1b1a, 0x6b4a2a, 0xc9a165, 0xe6e2d8, 0x7a7770, 0xa87a4a, 0x3a2a1c, 0xd8c7a0];
/** The dogs: size against a labrador, how long in the back, how short in the leg, pace of the legs. */
export const DOG_BREEDS = Object.freeze([
  { key: 'small', size: 0.52, long: 1.0, leg: 0.9, lead: 1.25 },      // a terrier
  { key: 'low', size: 0.5, long: 1.28, leg: 0.6, lead: 1.2 },         // a dachshund
  { key: 'medium', size: 0.74, long: 1.0, leg: 1.0, lead: 1.55 },     // a spaniel, a mongrel
  { key: 'large', size: 1.0, long: 1.0, leg: 1.0, lead: 1.7 },        // a labrador, a shepherd
]);

/**
 * What the citizen with this seed carries.
 * Returns { kind: PROP.*, key: 'bag' | 'phone' | 'pram' | 'dog' | null, tint, breed }:
 * tint is the bag's, the pram's or the dog's colour; breed an index into
 * DOG_BREEDS (a dog only). The same seed gives the same answer for ever.
 */
export function propFor(seed, archKey) {
  const sh = SHARE[archKey] ?? SHARE.m30, h = mix(seed >>> 0, PROP_SALT);
  let r = r01(h) * 100, kind = PROP.NONE;
  for (let i = 0; i < 4; i++) { r -= sh[i]; if (r < 0) { kind = i + 1; break; } }
  const v = mix(h, 0x51);
  let tint = 0, breed = 0;
  if (kind === PROP.BAG) tint = BAG_TINTS[v % BAG_TINTS.length];
  else if (kind === PROP.PRAM) tint = PRAM_TINTS[v % PRAM_TINTS.length];
  else if (kind === PROP.DOG) {
    tint = DOG_TINTS[v % DOG_TINTS.length];
    // the old man's dog is a small one; otherwise half are middling
    const b = r01(mix(h, 0x52));
    breed = archKey === 'm90' ? (b < 0.6 ? 0 : 1) : b < 0.2 ? 0 : b < 0.34 ? 1 : b < 0.72 ? 2 : 3;
  }
  return { kind, key: PROP_KEYS[kind], tint, breed };
}

/**
 * Which arm does what for a prop: { L, R } of 'bag' | 'phone' | 'push' |
 * 'leash' | null. `cane`: the right hand is on a stick, so it keeps it.
 */
export function holdFor(key, cane = false) {
  if (key === 'pram') return cane ? null : { L: 'push', R: 'push' };
  if (key === 'dog') return cane ? { L: 'leash', R: null } : { L: null, R: 'leash' };
  if (cane) return null;
  if (key === 'bag') return { L: null, R: 'bag' };
  if (key === 'phone') return { L: null, R: 'phone' };
  return null;
}
