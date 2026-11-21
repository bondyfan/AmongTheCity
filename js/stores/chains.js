// ---- stores/chains.js: the chains a Czech town shops and eats at ----
// WORKER SAFE: plain data and pure functions (the chunk mesher imports this
// through js/landmarks.js, the store runtime and the tests import it too).
//
// A chain here is the LOOK and the HABITS of its standalone stores in Czechia:
// what box it builds, where the glass is, what colour the band under the roof
// is, how the shop is laid out inside and when it is open. One generator
// (js/stores/build.js) reads these numbers and fits them to whatever footprint
// OpenStreetMap drew, so a Lidl is recognisably a Lidl on a 1 600 m2 lot and on
// a 2 700 m2 one. Nothing is a fixed model.
//
// Only a store that stands on its own is rebuilt. A supermarket under five
// storeys of flats, or a KFC in a station hall, keeps the generic building it
// is part of (its fascia still names it): see `standalone` below.
//
// arch (metres, hex colours):
//   style    'hall'  one shed under a mono-pitch roof that rises to a glazed
//                    front (the Lidl of the last ten years)
//            'box'   a flat-roofed box with a parapet band and a glazed entrance
//            'pavilion' a small restaurant: glass on two sides, a tall brand fin
//   hF, hB   wall height at the front line and at the back
//   glassF   share of the front that is glazed, glassS of the first side bay
//   wall, base, band, frame, roof, canopy   colours; bandH the band's height
//   door     'corner' or 'centre'; doorW its clear width
// sign: bg and fg of the panel, `square` for a square logo tile
// hours: [opens, closes] in hours of the day; closes 24 means it never shuts

const HOUSING = /^(apartments|residential|dormitory|terrace|panel|house|detached|semidetached_house|bungalow)$/;

const market = (o) => ({ kind: 'market', minA: 520, maxA: 9000, hours: [7, 21], ...o });
const hyper = (o) => ({ kind: 'hyper', minA: 2400, maxA: 60000, hours: [7, 22], ...o });
const fast = (o) => ({ kind: 'fast', minA: 150, maxA: 1400, hours: [6, 24], ...o });
// a car maker's own showroom: a glass box with cars standing in it (js/stores/showroom.js)
const showroom = (o) => ({ kind: 'showroom', minA: 150, maxA: 6000, hours: [9, 20], ...o });

export const CHAINS = [
  market({ id: 'lidl', re: /^lidl\b/i, label: 'Lidl',
    arch: { style: 'hall', hF: 7.4, hB: 5.2, glassF: 0.66, glassS: 0, wall: 0xf1f1ee, base: 0x8b8f93,
      band: 0xdfe2e4, bandH: 0, frame: 0x2f3338, roof: 0x9aa0a4, canopy: 0xe9ebec, door: 'corner', doorW: 3.6 },
    sign: { bg: 0x0050aa, fg: 0xfff000, square: true },
    shop: { aisles: 5, tills: 5, self: 6, bakery: true, middle: true } }),
  hyper({ id: 'kaufland', re: /^kaufland\b/i, label: 'Kaufland',
    arch: { style: 'box', hF: 8.2, hB: 8.2, glassF: 0.3, glassS: 0, wall: 0xb4b7ba, base: 0x6d6e71,
      band: 0xe10915, bandH: 1.1, frame: 0x3a3d42, roof: 0x8f9498, canopy: 0xe10915, door: 'centre', doorW: 4.4, portal: 0xe10915 },
    sign: { bg: 0xe10915, fg: 0xffffff, square: true, big: 'K' },
    shop: { aisles: 10, tills: 10, self: 8, bakery: true, butcher: true } }),
  market({ id: 'albert', re: /^albert\b/i, label: 'Albert', maxA: 30000,
    arch: { style: 'box', hF: 6.4, hB: 6.4, glassF: 0.45, glassS: 0, wall: 0xe9eaea, base: 0x8e9296,
      band: 0x0072bc, bandH: 1.3, frame: 0x34383d, roof: 0x8f9498, canopy: 0xf2f3f3, door: 'centre', doorW: 3.6 },
    sign: { bg: 0x0072bc, fg: 0xffffff },
    shop: { aisles: 7, tills: 6, self: 6, bakery: true } }),
  market({ id: 'billa', re: /^(oc )?billa\b/i, label: 'Billa',
    arch: { style: 'box', hF: 6.2, hB: 6.2, glassF: 0.55, glassS: 0.2, wall: 0xf4f2ea, base: 0x8e9296,
      band: 0xe2001a, bandH: 1.4, frame: 0x2f3338, roof: 0x8f9498, canopy: 0xffe600, door: 'corner', doorW: 3.4, portal: 0xc9a777 },
    sign: { bg: 0xe2001a, fg: 0xffe600, text: 'BILLA' },
    shop: { aisles: 6, tills: 5, self: 4, bakery: true, deli: true } }),
  market({ id: 'penny', re: /^penny\b/i, label: 'Penny',
    arch: { style: 'box', hF: 5.8, hB: 5.8, glassF: 0.4, glassS: 0, wall: 0xf0efea, base: 0x8e9296,
      band: 0xcd1414, bandH: 1.2, frame: 0x33373c, roof: 0x8f9498, canopy: 0xcd1414, door: 'corner', doorW: 3.2 },
    sign: { bg: 0xcd1414, fg: 0xffffff, square: true, text: 'PENNY' },
    shop: { aisles: 5, tills: 4, self: 4, bakery: true } }),
  hyper({ id: 'tesco', re: /^tesco\b(?! expres)/i, label: 'Tesco', minA: 900,
    arch: { style: 'box', hF: 7.6, hB: 7.6, glassF: 0.35, glassS: 0, wall: 0xeceeef, base: 0x8e9296,
      band: 0x00539f, bandH: 1.2, frame: 0x34383d, roof: 0x8f9498, canopy: 0xeceeef, door: 'centre', doorW: 4.2 },
    sign: { bg: 0xffffff, fg: 0x00539f, rule: 0xee1c2e, text: 'TESCO' },
    shop: { aisles: 10, tills: 10, self: 8, bakery: true } }),
  hyper({ id: 'globus', re: /^globus\b/i, label: 'Globus',
    arch: { style: 'box', hF: 9, hB: 9, glassF: 0.3, glassS: 0, wall: 0xf1efe8, base: 0x8e9296,
      band: 0xf39200, bandH: 1.3, frame: 0x34383d, roof: 0x8f9498, canopy: 0x00843d, door: 'centre', doorW: 4.6, portal: 0x00843d },
    sign: { bg: 0xffffff, fg: 0x00843d },
    shop: { aisles: 12, tills: 12, self: 8, bakery: true, butcher: true } }),
  market({ id: 'norma', re: /^norma\b/i, label: 'Norma',
    arch: { style: 'box', hF: 5.6, hB: 5.6, glassF: 0.3, glassS: 0, wall: 0xf0eee6, base: 0x8e9296,
      band: 0xe30613, bandH: 1.0, frame: 0x33373c, roof: 0x8f9498, canopy: 0xf0eee6, door: 'corner', doorW: 3.2 },
    sign: { bg: 0xffed00, fg: 0xe30613 },
    shop: { aisles: 4, tills: 3, self: 0 } }),
  hyper({ id: 'makro', re: /^makro\b/i, label: 'Makro', minA: 4000,
    arch: { style: 'box', hF: 9.5, hB: 9.5, glassF: 0.2, glassS: 0, wall: 0xe8e9ea, base: 0x8e9296,
      band: 0x003d7d, bandH: 1.4, frame: 0x34383d, roof: 0x8f9498, canopy: 0xffe500, door: 'centre', doorW: 4.6 },
    sign: { bg: 0x003d7d, fg: 0xffe500 },
    shop: { aisles: 12, tills: 10, self: 0, racking: true } }),
  fast({ id: 'mcdonalds', re: /mcdonald/i, label: "McDonald's",
    arch: { style: 'pavilion', hF: 4.6, hB: 4.6, glassF: 0.8, glassS: 0.7, wall: 0xb9b3a8, base: 0x5a5753,
      band: 0x7a746c, bandH: 0.9, frame: 0x26282b, roof: 0x77797b, canopy: 0xffc72c, door: 'centre', doorW: 2.4,
      fin: 0x8a6b45, finH: 6.4, accent: 0xffc72c },
    sign: { bg: 0x3a3836, fg: 0xffc72c, big: 'M' },
    eat: { kiosks: 4, tills: 3, play: true, drive: true, cafe: true } }),
  fast({ id: 'kfc', re: /\bkfc\b/i, label: 'KFC', hours: [8, 23],
    arch: { style: 'pavilion', hF: 4.8, hB: 4.8, glassF: 0.75, glassS: 0.6, wall: 0xf2f1ee, base: 0x3a3937,
      band: 0xe4002b, bandH: 1.0, frame: 0x26282b, roof: 0x77797b, canopy: 0xe4002b, door: 'centre', doorW: 2.4,
      fin: 0xe4002b, finH: 6.8, accent: 0xe4002b, stripes: true },
    sign: { bg: 0xe4002b, fg: 0xffffff },
    eat: { kiosks: 3, tills: 3, drive: true } }),
  fast({ id: 'burgerking', re: /burger king/i, label: 'Burger King', hours: [8, 23],
    arch: { style: 'pavilion', hF: 4.6, hB: 4.6, glassF: 0.75, glassS: 0.6, wall: 0xa9805f, base: 0x4a4541,
      band: 0x6e3a22, bandH: 0.9, frame: 0x26282b, roof: 0x77797b, canopy: 0xd62300, door: 'centre', doorW: 2.4,
      fin: 0xf5ebdc, finH: 6.2, accent: 0xff8732 },
    sign: { bg: 0xf5ebdc, fg: 0xd62300 },
    eat: { kiosks: 3, tills: 3, drive: true } }),
  // Tesla Centrum Praha, V Oblouku 727, Průhonice (the map's "Tesla Prague"): a
  // glazed strip round the corner of its workshop hall. Its door is a gate a
  // car is driven out through; `show.cars` are what stands on the floor.
  showroom({ id: 'tesla', re: /^tesla\b/i, label: 'Tesla',
    // (ceil: the hall behind is 4.3 m to its eaves, and they reach in over the back wall)
    arch: { style: 'box', hF: 6.2, hB: 6.2, ceil: 3.95, glassF: 0.94, glassS: 0, glassAll: true, wall: 0xf3f3f1, base: 0x2b2d30,
      band: 0x191a1c, bandH: 1.3, frame: 0x1f2124, roof: 0x8f9498, canopy: 0x191a1c, door: 'centre', doorW: 5.2 },
    sign: { bg: 0x191a1c, fg: 0xffffff, accent: 0xe82127, text: 'TESLA', square: true },
    show: { cars: ['roadster', 'tesla'] } }),
];

const BY_ID = new Map(CHAINS.map((c) => [c.id, c]));
export const chainById = (id) => BY_ID.get(id) ?? null;

/** Dev and measurement switch: off, every chain store is a generic building again. */
export const STORES = { on: true };

/** The chain a name belongs to, or null. */
export function chainOfName(name) {
  if (!name) return null;
  for (const c of CHAINS) if (c.re.test(name)) return c;
  return null;
}

const ringArea = (o) => {
  let a = 0;
  for (let i = 0, n = o.length; i < n; i++) {
    const p = o[i], q = o[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a / 2);
};

/**
 * Does this building stand on its own as a store of its chain? A footprint in
 * housing, a tall block, a station or a mall is not rebuilt: the chain is a
 * tenant there, and its hall would replace somebody's home.
 */
export function standalone(f, chain) {
  if (!f?.o || f.o.length < 4 || (f.y ?? 0) > 0.5) return false;
  if (HOUSING.test(f.t ?? '') || f.t === 'train_station' || f.t === 'transportation') return false;
  if ((f.h ?? 4.3) > 11 || (f.lv ?? 1) > 3) return false;
  const a = f._area !== undefined ? Math.abs(f._area) : ringArea(f.o);
  // a courtyard makes it a block, not a shed; a light well a few metres across does not
  let hole = 0;
  for (const h of f.i ?? []) if (h.length >= 3) hole += ringArea(h);
  if (hole > a * 0.12) return false;
  const u = f.u ?? '';
  if (chain.kind === 'showroom' ? u !== 'car'
    : chain.kind === 'fast' ? u !== 'fast_food' && u !== 'restaurant'
    : !/^(supermarket|hypermarket|wholesale|convenience)$/.test(u)) return false;
  return a >= chain.minA && a <= chain.maxA;
}

/** The chain whose standalone store this building is, or null. */
export function storeChain(f) {
  if (!STORES.on || !f?.n) return null;
  const c = chainOfName(f.n);
  return c && standalone(f, c) ? c : null;
}

/** Is the store open at this hour of the day (0..24)? */
export function isOpen(chain, hour) {
  const [a, b] = chain.hours;
  return b >= 24 ? hour >= a || a === 0 : hour >= a && hour < b;
}

/** "7:00 - 21:00", as the board by the door says it. */
export function hoursText(chain) {
  const [a, b] = chain.hours;
  return b >= 24 && a <= 6 ? (a === 0 ? 'NONSTOP' : a + ':00 – 24:00') : a + ':00 – ' + b + ':00';
}
