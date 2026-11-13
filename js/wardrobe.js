// ---- wardrobe.js: what a person of Pardubice is wearing, as pure data ------
//
// Import-free on purpose, like js/people.js: js/identity.js (which the net
// layer and the tests load headless) derives a player's outfit from it, and
// js/citizen.js turns the same record into geometry. No three, no DOM, no
// clock, and NO randomness of its own: every choice comes from the `rnd`
// function the caller hands in, so the crowd (a hash of the citizen's seed),
// a player (a hash of the uid) and a test (a counter) all get a deterministic
// person out of the same code. Two co-op clients therefore dress the same
// citizen identically without ever talking about it.
//
// The palette is a Czech pavement on an ordinary day: navy, charcoal, olive,
// denim, beige, a lot of black. One top in six is a strong colour, because a
// street where nobody wears red is as wrong as one where everybody does.
// Palette arrays are APPEND-ONLY: an index is somebody's jacket.

// lightest first: the draw is squared, so the pale end of the list is common
// and the dark end is the occasional face it is in a Czech town
export const SKINS = [0xf2cfb2, 0xedc4a3, 0xe8ba97, 0xf5d8be, 0xe1ad88, 0xd69d76, 0xc48a62, 0xa9744e, 0x86583b];
export const HAIRS = [0x2a1d14, 0x1a1816, 0x4a342a, 0x6b4f2e, 0x9a7b4f, 0xc2a063, 0x7a3b22, 0x3a2a1a];
// Age shows in the hair before it shows anywhere else: the sixty-year-olds
// draw from the greying set and the ninety-year-old from the white one.
export const HAIRS_GREY = [0x8a8a86, 0x9a978f, 0x6f6d68];
export const HAIRS_WHITE = [0xcfcdc6, 0xbdbab2];

export const TOPS_MUTED = [0x2b3445, 0x1d1f23, 0x3a3d42, 0x6f7479, 0x4f5640, 0x7d7558, 0xb3a58a,
  0x6b2d35, 0x5a4636, 0x4a6282, 0x6b7a8c, 0x33503f, 0xd9d6ce, 0x8c6b5f, 0x46586a, 0x9a9488];
export const TOPS_STRONG = [0xb8322c, 0xc9972e, 0x1f7a78, 0xc7607f, 0x2f55a4, 0xd0652a, 0x6c4a9a, 0x3f8f4a];
export const SHIRTS = [0xe6e3da, 0xcfd8e3, 0xb9c7d6, 0xd9c9b0, 0x9fb0c4, 0x2a2d33, 0xa8b89a, 0xe0b8b8];
export const JEANS = [0x33435c, 0x4a5f80, 0x26303f, 0x5c718f, 0x1f242c];
export const PANTS = [0x202227, 0x4b4e53, 0x7a6f57, 0x4a3e33, 0x262d3d, 0x3d4450, 0x5a5248];
export const PANTS_OLD = [0xa39679, 0x6e6658, 0x4b4e53, 0x5a4a3a, 0x7c7a70];
export const SKIRTS = [0x2b3445, 0x1d1f23, 0x6b2d35, 0x7d7558, 0x4a6282, 0x5a4636, 0x8a3d4f, 0x3a3d42];
export const SHOES = [0x1c1b1a, 0x33302c, 0x4a3a2c, 0xe4e2dc, 0x6a6c70, 0x2b3445, 0x7a2f2a];
export const BAGS = [0x1d1f23, 0x4a3a2c, 0x6b2d35, 0x2b3445, 0x7d7558, 0x8a5a3a, 0x3f5a4a];

// [value, weight] tables per archetype. Shorts only come out with a light top
// (see below), and a dress brings its own skirt.
const W = {
  m30: {
    top: [['hoodie', 25], ['jacket', 24], ['tee', 20], ['shirt', 12], ['puffer', 10], ['coat', 9]],
    bottom: [['jeans', 50], ['trousers', 30], ['shorts', 20]],
    hair: [['short', 42], ['crop', 22], ['part', 22], ['bald', 6], ['pony', 8]],
    hat: [[null, 78], ['cap', 14], ['beanie', 8]],
    bag: [[null, 68], ['backpack', 24], ['shoulder', 8]],
    glasses: 0.16, strong: 0.16,
  },
  f30: {
    top: [['jacket', 20], ['coat', 15], ['hoodie', 12], ['shirt', 15], ['tee', 15], ['dress', 13], ['puffer', 10]],
    bottom: [['jeans', 40], ['leggings', 15], ['skirt', 20], ['trousers', 15], ['shorts', 10]],
    hair: [['long', 34], ['pony', 20], ['bob', 20], ['bun', 12], ['short', 8], ['part', 6]],
    hat: [[null, 88], ['beanie', 8], ['cap', 4]],
    bag: [[null, 34], ['shoulder', 42], ['backpack', 14], ['hand', 10]],
    glasses: 0.16, strong: 0.24,
  },
  f60: {
    top: [['coat', 34], ['jacket', 20], ['sweater', 20], ['puffer', 14], ['dress', 12]],
    bottom: [['skirt', 40], ['trousers', 60]],
    hair: [['curly', 46], ['bob', 24], ['bun', 20], ['short', 10]],
    hat: [[null, 84], ['scarf', 12], ['beanie', 4]],
    bag: [[null, 22], ['hand', 52], ['shoulder', 26]],
    glasses: 0.42, strong: 0.2,
  },
  m60: {
    top: [['jacket', 34], ['shirt', 20], ['coat', 14], ['puffer', 12], ['sweater', 20]],
    bottom: [['trousers', 70], ['jeans', 30]],
    hair: [['short', 38], ['bald', 36], ['part', 26]],
    hat: [[null, 76], ['flat', 18], ['cap', 6]],
    bag: [[null, 74], ['hand', 18], ['shoulder', 8]],
    glasses: 0.36, strong: 0.08,
  },
  m90: {
    top: [['coat', 40], ['jacket', 30], ['sweater', 30]],
    bottom: [['trousers', 100]],
    hair: [['bald', 60], ['short', 40]],
    hat: [[null, 46], ['flat', 46], ['beanie', 8]],
    bag: [[null, 100]],
    glasses: 0.6, strong: 0.04,
  },
};

function pickW(rnd, table) {
  let total = 0;
  for (const t of table) total += t[1];
  let r = rnd() * total;
  for (const t of table) { r -= t[1]; if (r < 0) return t[0]; }
  return table[table.length - 1][0];
}
const pickA = (rnd, arr) => arr[Math.min(arr.length - 1, (rnd() * arr.length) | 0)];

// The two uniforms. Fixed, not drawn: an officer who looked different on every
// screen would not be a uniform.
const ROLES = {
  // Czech police on the beat: navy fatigues, the yellow reflective vest, cap
  police: {
    top: 'jacket', topColor: 0x1b2438, top2: 0x1b2438, bottom: 'trousers', bottomColor: 0x1b2438,
    shoes: 'boot', shoeColor: 0x121212, hat: 'police', hatColor: 0x1b2438, bag: null,
    vest: 0xd8e021, strips: 0xc9cfd4, glasses: false,
  },
  // záchranka: red suit, yellow shoulders and reflective bands
  medic: {
    top: 'jacket', topColor: 0xc4261d, top2: 0xc4261d, bottom: 'trousers', bottomColor: 0xc4261d,
    shoes: 'boot', shoeColor: 0x161616, hat: null, bag: null,
    yoke: 0xe6d11f, strips: 0xd9dde0, glasses: false,
  },
};

/**
 * The whole outfit for one person. `rnd` is a () => [0, 1) the caller owns;
 * `over` may pin any field (jacket/pants/skin/hair are the legacy names for
 * topColor/bottomColor/skin/hair and win over the draw), and over.role picks
 * a uniform. The same `rnd` sequence always gives the same record.
 */
export function pickOutfit(archKey, rnd, over = {}) {
  const w = W[archKey] ?? W.m30;
  const old = archKey === 'm60' || archKey === 'f60', ancient = archKey === 'm90';
  const fem = archKey === 'f30' || archKey === 'f60';
  // The first four draws are colours in the order the old figure drew them
  // (jacket, trousers, skin, hair), so a pinned look and a rolled one consume
  // the generator identically.
  const strong = rnd() < w.strong;
  const topColor = strong ? pickA(rnd, TOPS_STRONG) : pickA(rnd, TOPS_MUTED);
  const r2 = rnd();
  const rs = rnd(), skin = SKINS[Math.min(SKINS.length - 1, (rs * rs * SKINS.length) | 0)];
  const hair = pickA(rnd, ancient ? HAIRS_WHITE : old ? HAIRS_GREY : HAIRS);

  let top = pickW(rnd, w.top);
  let bottom = pickW(rnd, w.bottom);
  if (top === 'dress') bottom = 'skirt';
  // nobody wears shorts under a winter coat
  if (bottom === 'shorts' && (top === 'coat' || top === 'puffer' || top === 'jacket')) bottom = 'jeans';
  const pal = bottom === 'jeans' ? JEANS : bottom === 'skirt' ? SKIRTS : (old || ancient) ? PANTS_OLD : PANTS;
  const bottomColor = pal[Math.min(pal.length - 1, (r2 * pal.length) | 0)];
  const o = {
    arch: archKey, role: null,
    skin, hair,
    hairStyle: pickW(rnd, w.hair),
    hat: pickW(rnd, w.hat),
    hatColor: pickA(rnd, TOPS_MUTED),
    glasses: rnd() < w.glasses,
    top, topColor,
    top2: pickA(rnd, SHIRTS),          // what shows in an open collar
    open: rnd() < 0.45,                // jacket or coat worn open
    bottom, bottomColor,
    shoes: (old || ancient) ? 'shoe' : pickW(rnd, [['sneaker', 55], ['shoe', 25], ['boot', 20]]),
    shoeColor: pickA(rnd, SHOES),
    bag: pickW(rnd, w.bag),
    bagColor: pickA(rnd, BAGS),
    cane: ancient,
    vest: null, yoke: null, strips: null,
    fem,
    beard: !fem && rnd() < (ancient ? 0.15 : 0.28),
    eyes: pickA(rnd, [0x3a2a1c, 0x3a2a1c, 0x4a6070, 0x55684a, 0x2a2420]),
  };
  // a white trainer is a trainer; a white brogue is a mistake
  if (o.shoes !== 'sneaker' && o.shoeColor === 0xe4e2dc) o.shoeColor = 0x33302c;
  if (o.hat === 'scarf') o.hatColor = pickA(rnd, TOPS_STRONG);
  if (over.jacket != null) o.topColor = over.jacket;
  if (over.pants != null) o.bottomColor = over.pants;
  if (over.skin != null) o.skin = over.skin;
  if (over.hair != null) o.hair = over.hair;
  for (const k of ['hairStyle', 'hat', 'hatColor', 'glasses', 'top', 'top2', 'open', 'bottom',
    'shoes', 'shoeColor', 'bag', 'bagColor', 'cane']) if (over[k] !== undefined) o[k] = over[k];
  if (o.top === 'dress') o.bottom = 'skirt';
  const role = ROLES[over.role];
  if (role) { Object.assign(o, role); o.role = over.role; o.open = false; o.cane = false; }
  return o;
}

/** A deterministic () => [0, 1) from an integer seed (mulberry32). */
export function seededRnd(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ROLE_KEYS = Object.keys(ROLES);
