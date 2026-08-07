// ---- Who walks around Pardubice: the five bodies, as pure data ----
//
// This file exists to be imported by BOTH js/citizen.js (which builds the mesh
// and therefore imports three.js) and js/chatter.js (which must never import
// three.js, because the half of the speech system worth testing is testable
// headless). A grandmother has to sound like a grandmother, so the module that
// picks her body and the module that picks her voice have to agree on which
// one she is — and the only way to guarantee that without one importing the
// other is a third module that imports nothing at all. So: no imports, no DOM,
// no three, no clock. Numbers and one function.
//
// WHY FIVE. The city used to be one body: eleven identical boxes, and only the
// colours changed. From across the street that reads as a crowd; from the
// pavement it reads as a clone army, and the user's word for it was
// "Minecraft". Five silhouettes is the smallest set where the differences are
// STRUCTURAL rather than palette — a different height, a different shoulder-to-
// hip ratio, a different walk, a stoop, a stick — because structure is what the
// eye picks up at 20 m and colour is not.
//
// The weights are not uniform and that is the point: a real Czech pavement is
// mostly working age, has a good number of pensioners, and a ninety-year-old
// on a stick is something you notice BECAUSE it is rare. Uniform weights would
// have put one in five.
//
// Heights are the finished figure in metres, before PLAYER_SCALE. The adult
// male is 1.78 on purpose: js/netcity.js pins peer name tags at
// `1.75 * PLAYER_SCALE + 0.22` and js/chatter.js hangs speech bubbles off a
// similar constant, both written when every citizen was exactly 1.75 tall.
// Keeping the tallest archetype within a few centimetres of that means nothing
// above anybody's head had to move; the SHORT ones simply carry a little more
// headroom, which reads fine and is what makeCitizen's `headTop` is for when
// it does not.

export const ARCHETYPES = [
  // key    sex  age  weight  height  what makes it read as itself
  { key: 'm30', sex: 'm', age: 30, w: 0.28, h: 1.78 },  // the default bloke
  { key: 'f30', sex: 'f', age: 30, w: 0.26, h: 1.69 },  // narrow shoulders, long hair
  { key: 'f60', sex: 'f', age: 60, w: 0.18, h: 1.63 },  // shorter, fuller waist, bun, coat
  { key: 'm60', sex: 'm', age: 60, w: 0.20, h: 1.76 },  // heavier, greying, shorter stride
  { key: 'm90', sex: 'm', age: 90, w: 0.08, h: 1.67 },  // stooped, thin, slow, walking stick
];

// The salt every caller must use, so pedestrians.js and chatter.js draw the
// SAME archetype for the same citizen. It lives here rather than in either
// caller for exactly the reason the whole file does: a constant that two
// modules must agree on belongs to neither of them.
// pedestrians.js already burns 0xc17 on the wardrobe and traffic.js uses 9 on
// the horn; 0x76fa is inside the block js/chatter.js reserved for the crowd.
export const ARCH_SALT = 0x76fa;

const TOTAL = ARCHETYPES.reduce((n, a) => n + a.w, 0);

/**
 * Pick an archetype from a number in [0, 1). Takes the number rather than a
 * seed so this file can stay import-free: every caller already has the project
 * hash (`rnd01(hash32(seed, ARCH_SALT))`) and there is no reason for a fourth
 * copy of it to live here.
 *
 * Out-of-range or non-finite input lands on the default adult rather than
 * throwing — a corrupt seed should produce a boring citizen, not a crash.
 */
export function archetypeAt(r) {
  const x = Number.isFinite(r) ? (r < 0 ? 0 : r >= 1 ? 0.999999 : r) : 0;
  let acc = 0;
  const t = x * TOTAL;
  for (const a of ARCHETYPES) {
    acc += a.w;
    if (t < acc) return a;
  }
  return ARCHETYPES[0];
}

/** Look up by key; unknown keys fall back to the default adult. */
export function archetype(key) {
  return ARCHETYPES.find((a) => a.key === key) ?? ARCHETYPES[0];
}

export default ARCHETYPES;
