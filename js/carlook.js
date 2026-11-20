// ---- carlook.js: what a car's paint has been through --------------------------
// Every car used to leave the same paint shop on the same morning: ten colours,
// all of them lacquered and polished. A street does not look like that. This
// module decides, for one car, the colour and the LOOK of its paint:
//
//   finish   full gloss (about three cars in ten), ordinary used lacquer (most),
//            worn and faded, or matte
//   dirt     clean, dust on the sills and lower doors, road film up the flanks,
//            or caked all over with rain streaks
//   leaf     now and then one lies on the bonnet, the windscreen or the roof
//
// Everything is a pure function of a 32-bit seed, so two players who see the
// same car (same traffic slot, same parking space) see the same paint. The look
// travels as ONE BYTE (car.look): the co-op layer packs it above the colour,
// the save keeps it, and the shader gets it as a few uniforms on the car's own
// material (near) or as a per-instance attribute (the distance dress), never
// as an extra draw: js/carbodymat.js.
//
// Pure: no three, no DOM. Works headless (tests/carlook.test.mjs).

// ---- hashing ------------------------------------------------------------------
export function mix32(h) {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
const u01 = (h) => (h >>> 8) / 16777216;
/** the n-th independent draw (0..1) of a seed */
export const draw = (seed, n) => u01(mix32((seed >>> 0) ^ Math.imul(n + 1, 0x9e3779b1)));
/** a seed for a car standing at a mapped place (parking spaces: same on every client) */
export function seedAt(x, z) {
  return mix32(Math.imul(Math.round(x * 4) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(z * 4) | 0, 0x165667b1));
}

// ---- the palette ----------------------------------------------------------------
// [hex, weight, family]. The Czech fleet as it stands at a kerb: a third silver
// and grey, then white, black and dark blue, some red, a little brown, beige
// and dark green, the odd bright one, and gold or pink once in a long while.
const FLEET = [
  [0xb9bec4, 7, 'silver'], [0xa3a8ae, 6, 'silver'], [0xc8ccd0, 4, 'silver'],
  [0x8d9298, 5, 'grey'], [0x6f747a, 5, 'grey'], [0x54585e, 5, 'grey'], [0x3d4046, 4, 'grey'],
  [0x7b7f78, 2, 'grey'], [0x9a958c, 2, 'grey'],
  [0xe8e8e3, 8, 'white'], [0xdcdcd6, 5, 'white'], [0xf0efe9, 4, 'white'], [0xd9d5c8, 2, 'white'],
  [0x15171a, 6, 'black'], [0x1d1f23, 4, 'black'], [0x25272c, 3, 'black'], [0x1a1d24, 2, 'black'],
  [0x1f3048, 4, 'blue'], [0x263c5e, 3, 'blue'], [0x2f4f72, 3, 'blue'], [0x1a2740, 2, 'blue'],
  [0x16365c, 2, 'blue'], [0x3a63a8, 2, 'blue'], [0x4a6f96, 2, 'blue'], [0x5b7fa6, 1, 'blue'], [0x2456a8, 1, 'blue'],
  [0xa61c26, 3, 'red'], [0x8c1a22, 3, 'red'], [0xb8433a, 2, 'red'], [0x6e1820, 2, 'red'], [0xc02a2a, 1, 'red'],
  [0x5a4636, 2, 'brown'], [0x6b5644, 1.5, 'brown'], [0x4a3a30, 1.5, 'brown'],
  [0x9c8b74, 1.5, 'beige'], [0xb3a58e, 1.5, 'beige'], [0x8a7a62, 1, 'beige'],
  [0x24402f, 1.5, 'green'], [0x2f4a38, 1.5, 'green'], [0x476b46, 1, 'green'], [0x3d5245, 1, 'green'], [0x54695d, 0.7, 'green'],
  [0xd9a514, 0.6, 'bright'], [0xd9641e, 0.6, 'bright'], [0x3fa0d8, 0.6, 'bright'], [0x7fb23a, 0.4, 'bright'], [0x1fa39a, 0.4, 'bright'],
  [0x4b2d6b, 0.3, 'bright'],
  [0x9a7b3c, 0.25, 'gold'], [0xb59a5a, 0.2, 'gold'], [0x7a4a66, 0.2, 'pink'], [0xc77a9a, 0.12, 'pink'],
];
// German metal: dark metallics, silver, white, and little else
const PREMIUM = [
  [0x15171b, 8, 'black'], [0x101214, 4, 'black'], [0x22262c, 5, 'black'], [0x2c3138, 5, 'grey'],
  [0x36393f, 4, 'grey'], [0x43464c, 4, 'grey'], [0x6f747a, 3, 'grey'], [0x8a9096, 5, 'silver'], [0xb9bec6, 5, 'silver'],
  [0xe8e8e3, 7, 'white'], [0xf0efe9, 3, 'white'], [0x1f3048, 5, 'blue'], [0x23304a, 4, 'blue'], [0x16365c, 2, 'blue'],
  [0x6e1820, 1.5, 'red'], [0x8c1a22, 1, 'red'], [0x4a3a30, 1.2, 'brown'], [0x24402f, 1, 'green'], [0x9c8b74, 0.6, 'beige'],
];
// the colours that order page really offers
const TESLA = [
  [0xe9eae5, 9, 'white'], [0x17191d, 5, 'black'], [0x3b3e43, 5, 'grey'], [0x8a9096, 3, 'silver'],
  [0x1b3a66, 4, 'blue'], [0xa61c26, 3, 'red'], [0x5a0f1c, 1, 'red'],
];
const ROADSTER = [
  [0xeceee9, 10, 'white'], [0x17191d, 2, 'black'], [0xa61c26, 2, 'red'], [0x8a9096, 1.5, 'silver'], [0x3b3e43, 1.5, 'grey'],
];
const VAN = [
  [0xdcdcd6, 20, 'white'], [0xe8e8e3, 12, 'white'], [0xc4c9cf, 6, 'silver'], [0xa3a8ae, 4, 'silver'], [0x6f747a, 3, 'grey'],
  [0x3d4046, 2, 'grey'], [0x15171a, 2, 'black'], [0x3a63a8, 3, 'blue'], [0x1f3048, 2, 'blue'], [0xb8433a, 2.5, 'red'],
  [0xd9a514, 2, 'bright'], [0x476b46, 1.5, 'green'], [0xd9641e, 1, 'bright'],
];
const TRUCK = [
  [0xd8d5ce, 12, 'white'], [0xe8e8e3, 6, 'white'], [0xbcbfba, 5, 'silver'], [0x8a9096, 4, 'grey'], [0x3a63a8, 4, 'blue'],
  [0x476b46, 3, 'green'], [0xb5271f, 3, 'red'], [0xd9a514, 2, 'bright'], [0x2c3138, 2, 'grey'], [0xd9641e, 1, 'bright'],
];
const BUS = [[0xb5271f, 6, 'red'], [0x9a2822, 2, 'red'], [0xd8d5ce, 1, 'white']];
const TROLLEY = [[0xb5271f, 2, 'red'], [0x9a2822, 1, 'red']];
const POOLS = { bmw: PREMIUM, mercedes: PREMIUM, tesla: TESLA, roadster: ROADSTER, van: VAN, truck: TRUCK, semi: TRUCK, bus: BUS, trolleybus: TROLLEY };
const cumulative = (pool) => { let s = 0; const c = pool.map((e) => (s += e[1])); return { pool, c, s }; };
const _cum = new Map();
function poolFor(kind) {
  const p = POOLS[kind] ?? FLEET;
  let c = _cum.get(p);
  if (!c) _cum.set(p, c = cumulative(p));
  return c;
}
/** A colour for a kind from one 0..1 draw. */
export function pickColor(kind, r) {
  const { pool, c, s } = poolFor(kind);
  const t = (r < 0 ? 0 : r >= 1 ? 0.999999 : r) * s;
  let lo = 0, hi = c.length - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (c[m] > t) hi = m; else lo = m + 1; }
  return pool[lo][0];
}
const _family = new Map();
for (const p of [FLEET, PREMIUM, TESLA, ROADSTER, VAN, TRUCK, BUS, TROLLEY]) for (const e of p) if (!_family.has(e[0])) _family.set(e[0], e[2]);
/** 'silver' | 'grey' | 'white' | 'black' | 'blue' | 'red' | 'brown' | 'beige' | 'green' | 'bright' | 'gold' | 'pink' | 'other' */
export const colorFamily = (hex) => _family.get(hex) ?? 'other';

// ---- the look byte ----------------------------------------------------------------
// bits 0-1 finish, 2-3 dirt, 4-6 variant (which dirt, which plate), 7 leaf.
// 0 is a clean, fully polished car: what every car was before this module, and
// what a caller gets who never heard of looks.
export const FINISH = { GLOSS: 0, USED: 1, WORN: 2, MATTE: 3 };
export const packLook = (finish, dirt, variant, leaf) => (finish & 3) | ((dirt & 3) << 2) | ((variant & 7) << 4) | (leaf ? 128 : 0);
export const unpackLook = (look) => ({ finish: look & 3, dirt: (look >> 2) & 3, variant: (look >> 4) & 7, leaf: (look & 128) !== 0 });
/** a fleet vehicle that is washed on a rota: used lacquer, clean */
export const LOOK_FLEET = packLook(FINISH.USED, 0, 0, false);

// per kind: cumulative odds of [gloss, used, worn] (the rest is matte), of
// dirt [clean, sills, film] (the rest is caked), and of a leaf
const ODDS = {
  car: { fin: [0.30, 0.81, 0.94], dirt: [0.42, 0.72, 0.91], leaf: 0.06 },
  premium: { fin: [0.44, 0.87, 0.92], dirt: [0.55, 0.82, 0.95], leaf: 0.04 },
  tesla: { fin: [0.42, 0.90, 0.94], dirt: [0.48, 0.78, 0.94], leaf: 0.04 },
  roadster: { fin: [0.80, 0.95, 0.95], dirt: [0.90, 1.0, 1.0], leaf: 0.0 },
  work: { fin: [0.12, 0.70, 0.97], dirt: [0.22, 0.52, 0.82], leaf: 0.03 },
  transit: { fin: [0.15, 0.92, 1.0], dirt: [0.55, 0.90, 1.0], leaf: 0.0 },
};
const CLASS = { bmw: 'premium', mercedes: 'premium', tesla: 'tesla', roadster: 'roadster',
  van: 'work', truck: 'work', semi: 'work', bus: 'transit', trolleybus: 'transit' };
const below = (r, c) => { let i = 0; while (i < c.length && r >= c[i]) i++; return i; };
/** The look byte of a car of `kind` born from `seed`. */
export function lookFromSeed(kind, seed) {
  const o = ODDS[CLASS[kind] ?? 'car'];
  const finish = below(draw(seed, 11), o.fin);
  let dirt = below(draw(seed, 12), o.dirt);
  // a car somebody polishes is not left caked, and a matte wrap is looked after
  if ((finish === FINISH.GLOSS || finish === FINISH.MATTE) && dirt > 1) dirt -= 1;
  const variant = (draw(seed, 13) * 8) | 0;
  const leaf = draw(seed, 14) < o.leaf;
  return packLook(finish, dirt, variant, leaf);
}
/** The colour and the look together: { color, look }. */
export function paintFromSeed(kind, seed) {
  return { color: pickColor(kind, draw(seed, 10)), look: lookFromSeed(kind, seed) };
}

// ---- what the shader needs ----------------------------------------------------------
// gloss      strength of the clear lacquer, 1 freshly polished .. 0 none
// ccRough    how sharp the lacquer's reflection is
// rough      added to the base coat's roughness: (1 - gloss) * ROUGH_K, the
//            same line the distance dress evaluates per instance in its shader
// fade       0..1, the colour chalked toward a pale grey (old solid paint)
// dirt       0..1 amount; seed 0..1 picks where it sits
export const ROUGH_K = 0.28, METAL_LO = 0.55;   // metalness keeps METAL_LO of itself with no lacquer
const FIN = [
  { gloss: 1.0, ccRough: 0.10, fade: 0 },
  { gloss: 0.62, ccRough: 0.24, fade: 0.03 },
  { gloss: 0.26, ccRough: 0.46, fade: 0.14 },
  { gloss: 0.0, ccRough: 0.60, fade: 0 },
];
const DIRT = [0, 0.34, 0.62, 1.0];
export function lookParams(look) {
  const u = unpackLook(look | 0), f = FIN[u.finish];
  return { finish: u.finish, gloss: f.gloss, ccRough: f.ccRough, rough: (1 - f.gloss) * ROUGH_K, fade: f.fade,
    dirt: DIRT[u.dirt], seed: (u.variant + 0.5) / 8, leaf: u.leaf, variant: u.variant };
}
/** the colour after the sun has been at it: [r, g, b] 0..1 in, the same out */
export function fadeRgb(r, g, b, fade) {
  if (!(fade > 0)) return [r, g, b];
  const l = 0.3 * r + 0.59 * g + 0.11 * b, pale = 0.5 + l * 0.35;
  return [r + (pale - r) * fade, g + (pale - g) * fade, b + (pale - b) * fade];
}

// ---- the leaf -------------------------------------------------------------------------
// Where it lies in the car's own frame (x right, z back, nose at -z), from the
// kind's greenhouse: on the bonnet, at the foot of the screen where the wipers
// catch it, or on the roof. Returns [x, z, angle, half length (m), tint 0..1]
// or null when this look has no leaf (or the kind has no bonnet to hold one).
export function leafSpot(K, look, hex = 0) {
  const u = unpackLook(look | 0);
  if (!u.leaf || !K?.green) return null;
  const s = mix32((hex >>> 0) ^ Math.imul(u.variant + 1, 0x85ebca6b));
  const a = u01(mix32(s ^ 1)), b = u01(mix32(s ^ 2)), c = u01(mix32(s ^ 3)), d = u01(mix32(s ^ 4));
  const gs = K.green.sts, z0 = K.hull.sts[0][0], gz0 = gs[0][0], hdr = gs[1][0], roofEnd = gs[gs.length - 2][0];
  const half = K.wid / 2;
  let x, z;
  const where = u.variant % 3;
  if (where === 0) {            // on the bonnet
    z = z0 + 0.45 + (gz0 - 0.15 - (z0 + 0.45)) * a; x = (b - 0.5) * half * 1.1;
  } else if (where === 1) {     // at the foot of the screen
    z = gz0 + 0.05 + (hdr - gz0) * 0.22 * a; x = (b - 0.5) * half * 1.0;
  } else {                      // on the roof
    z = hdr + 0.1 + (roofEnd - hdr - 0.2) * a; x = (b - 0.5) * half * 0.8;
  }
  return [x, z, c * Math.PI * 2, 0.042 + 0.022 * d, d];
}
