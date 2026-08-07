// ==========================================================================
// Prices — one table, in koruny, and nothing in the game may write to it
//
// WHAT THIS FILE IS FOR. Six modules are about to start asking questions about
// money: the wallet ("can he pay"), the tank ("what does a litre cost HERE"),
// the vitals ("what does a guláš put back"), the garage, the bazaar, the HUD.
// Every one of those answers is a number somebody chose, and the choosing is
// the whole game design. So the numbers live in one file that imports nothing,
// and the modules that use them import this.
//
// THE ALTERNATIVE WE REJECTED, and what went wrong with it. The obvious shape
// is constants where they are used: fuel.js knows the price of a litre because
// fuel.js is the module about litres, statusbar.js knows the repair price
// because it prints the repair price. That lasted exactly as long as it took
// to print a price in two places — the garage charged 2 400 and the HUD
// promised 1 900, and neither file was wrong on its own. Worse than the drift
// is the tuning: balance is not a property of any single number, it is a
// property of the RATIOS between them ("a full tank is two missions"), and you
// cannot tune a ratio you have to grep for. One screen, or no argument.
//
// THE OTHER ALTERNATIVE WE REJECTED: a live economy — inflation over the
// in-game week, per-district multipliers, a difficulty scalar on everything.
// It is three lines to write and it ruins the thing it is meant to serve. A
// price that moves under the player is a price they can never learn, so they
// stop reading prices, and the moment they stop reading prices the money layer
// is just a number in the corner. The feeling the brief actually asks for —
// TIGHT EARLY, COMFORTABLE LATE — can be produced entirely from the INCOME
// side, where the player reads the change as their own progress instead of as
// the world moving the goalposts. So: costs are constants for the life of the
// save, and the curve is in what a job pays. See `PRICE.job`.
//
// WHY FROZEN, DEEPLY. A price that can be written from anywhere will be
// written from somewhere — a "temporary" discount in a shop handler, a test
// that forgot to restore. This module is an ES module and therefore strict
// mode, so `PRICE.gun.pistol = 0` THROWS rather than silently doing nothing:
// freezing is not documentation here, it is an assertion that fires at the
// scene of the crime. deepFreeze walks arrays too, because the car ladder is
// an array and a frozen array of thawed objects protects nothing.
//
// DETERMINISM comes free and matters anyway. Pure data, no clock, no
// Math.random, no import: two clients in one room compute the same price for
// the same pump without a byte crossing the wire, which is the same rule the
// crowd and the traffic already live under.
//
// THE TIGHTNESS, IN ARITHMETIC, because "tight early" is a claim and claims
// get checked. A Fabia's 45-litre tank of Natural 95 at the base price is
// 1 661 Kč. The first missions pay 850. So:
//
//   · a full tank ......... two missions' work, early — and 0.55 of ONE
//                           mission once you are being paid 3 000
//   · a pistol (3 500) .... four early missions, or a bit over one late one
//   · the cheapest car .... 18 000 = 21 early missions, or 6 late ones
//   · dying ............... 300, plus 2 400 if the car has to be dragged in:
//                           most of a tank early, an errand later
//   · a garage (250 000) .. 83 missions at the TOP rate. Deliberately absurd
//                           early; it is the thing you buy last, and it is
//                           priced so that nothing else feels like a purchase
//                           you were talked into on the way there.
//   · a robbed pocket ..... ~130 Kč on average, so twelve of them make a tank.
//                           Crime is bootstrap money and is meant to be WORSE
//                           than work; it buys your first tank, never your
//                           second car.
//
// A NOTE ON THE FORMATTER. kc() builds strings, so it is a formatter for the
// moment a number CHANGES, not a per-frame path — statusbar.js must cache what
// it printed and re-print on the wallet's onChange, exactly the way the rest of
// this codebase treats string work. Same for kc2() and pumpBrand(), whose
// lowercase match allocates one string per call: ask it once per station and
// keep the answer on the station.
// ==========================================================================

// Freeze the whole tree, arrays included. The isFrozen test is not an
// optimisation, it is the cycle guard: FUEL_PRICE is frozen before PRICE is
// built and is referenced from inside it, and any future shortcut of the same
// shape would otherwise recurse forever.
function deepFreeze(o) {
  if (o === null || typeof o !== 'object' || Object.isFrozen(o)) return o;
  Object.freeze(o);
  for (const k of Object.keys(o)) deepFreeze(o[k]);
  return o;
}

// ---- fuel: the anchor is the pump price on a Pardubice bypass in 2026 ------
// Natural 95 sat around 35,50 through 2025 and the diesel spread stayed just
// about a koruna under it; 36,90 / 35,80 is that pair carried forward one
// year. They are the two numbers a Czech player can check against reality
// without leaving the game, which is why they are the anchor and everything
// else in the fuel group is expressed as an offset from them.
//
// Electricity is anchored differently: 8,80 is a public DC fast charger, the
// only kind a car in this game can use, and it is deliberately NOT the price
// of charging at home (~4 Kč) — the Tesla is not cheap to run here because
// nothing in this city is a driveway with a wallbox.
export const FUEL_PRICE = Object.freeze({
  benzin: 36.90,   // Kč / l — Natural 95
  nafta: 35.80,    // Kč / l — diesel
  elektro: 8.80,   // Kč / kWh — public DC
});

// Per-brand offset, in the same unit as the base above. The spread exists for
// one reason: there has to be a REASON to drive to a particular pump. Orlen
// Benzina is the brand on every second forecourt and prices like it; ČEPRO's
// unmanned TANKOMAT and the discount sheds undercut it by about the same
// amount in the other direction. That is 2,40 Kč of spread on Natural 95 —
// 108 Kč on a 45-litre tank, which is enough to be worth a two-minute detour
// and not enough to make filling up at the nearest pump a mistake. A bigger
// spread would turn every refuel into homework.
//
// The same absolute offsets are applied to kWh, and that is not laziness: a
// koruna of spread on 8,80 is ±14 %, which is very close to the real gap
// between a motorway charger and a supermarket one.
//
// `dc` is whether the site has a fast charger at all. A Tesla at a Tank ONO is
// a Tesla at a shed selling diesel from a tank on legs.
//
// `tags` are what the WORLD might call the place, lowercase and already
// stripped of diacritics — see pumpBrand(). They are authored per row rather
// than derived from the id because the id is a short key and a short key makes
// a dangerous substring: 'ono' is inside "ekonomik", and a fuel price that
// depends on an accident of spelling is a bug nobody will ever find. Anything
// listed here is a whole word or most of one.
const BRANDS = [
  { id: 'benzina', name: 'Orlen Benzina', d: 1.20, dc: true, tags: ['benzina', 'orlen'] },
  { id: 'shell', name: 'Shell', d: 1.00, dc: true, tags: ['shell'] },
  { id: 'omv', name: 'OMV', d: 0.80, dc: true, tags: ['omv'] },
  { id: 'mol', name: 'MOL', d: 0.50, dc: false, tags: ['mol'] },
  // EuroOil is ČEPRO's MANNED brand and is listed before the unmanned one, so
  // "ČEPRO EuroOil" resolves to the forecourt with a till in it.
  { id: 'eurooil', name: 'EuroOil', d: -0.30, dc: false, tags: ['eurooil', 'euro oil'] },
  { id: 'tankomat', name: 'ČEPRO TANKOMAT', d: -1.10, dc: false, tags: ['tankomat', 'cepro'] },
  { id: 'ono', name: 'Tank ONO', d: -1.20, dc: false, tags: ['tank ono'] },
  // The fallback, and the last entry on purpose: an unbranded forecourt off
  // the OSM data with a name nobody recognises sells at the base price. It has
  // no tags, so nothing can match it by accident — it is reached by falling
  // off the end of the list and no other way.
  { id: 'jina', name: 'Čerpací stanice', d: 0, dc: false, tags: [] },
];

// ---- the table ------------------------------------------------------------
export const PRICE = deepFreeze({
  fuel: {
    base: FUEL_PRICE,
    brands: BRANDS,
    // What the pump calls it and what it sells it by. The unit is here rather
    // than in the HUD because "litr" and "kWh" are a property of the fuel, and
    // a second copy of that fact in statusbar.js is the drift this file exists
    // to prevent.
    label: { benzin: 'Natural 95', nafta: 'Nafta', elektro: 'Elektřina DC' },
    unit: { benzin: 'l', nafta: 'l', elektro: 'kWh' },
  },

  // ---- staying alive ------------------------------------------------------
  // The hospital fee is the anchor of this group and it is small on purpose.
  // Death already costs you the walk back and whatever you were in the middle
  // of; a fee that also emptied the wallet would make dying a save-reload
  // instead of a setback. 300 Kč is a fifth of a tank — it stings for the
  // first hour and is invisible by the fourth, which is the correct shape for
  // a punishment the player will collect dozens of.
  hospital: { fee: 300 },

  // Food heals, and it is the ONLY thing that heals without a fee, so it is
  // priced per hit point rather than per plate: 3,75 Kč/hp at the párek end
  // down to 2,90 at the svíčková end. The discount for eating properly is
  // deliberate — it makes the expensive item the right answer when you are
  // badly hurt and the cheap one the right answer when you are topping up,
  // which is a decision, and a menu without a decision is a vending machine.
  // hp values assume vitals.js's 100-point scale; if that moves, these move.
  food: [
    { id: 'parek', name: 'Párek v rohlíku', price: 45, hp: 12 },
    // Local colour costs nothing and the city is Pardubice — chatterlines.js
    // already leans on that and players quote it back.
    { id: 'pernik', name: 'Pardubický perník', price: 55, hp: 15 },
    { id: 'langos', name: 'Langoš s česnekem', price: 75, hp: 22 },
    { id: 'smazak', name: 'Smažák v housce', price: 95, hp: 30 },
    { id: 'gulas', name: 'Guláš s knedlíkem', price: 145, hp: 48 },
    { id: 'svickova', name: 'Svíčková', price: 180, hp: 62 },
  ],

  // ---- iron ---------------------------------------------------------------
  // 3 500 is not what a pistol costs. A CZ P-10 in a shop is four times this
  // and needs a licence the player is never going to have; 3 500 is what it
  // costs from a man in a garage with the numbers gone, and the gap between
  // those two prices IS the fiction. Ammunition at 8 Kč a round is close to
  // the real counter price for 9 mm, which is the joke: the gun is criminal,
  // the bullets are just shopping.
  //
  // The vest is not in the original brief and is here because vitals.js has an
  // addArmour() that somebody has to price; 2 200 for 50 points puts a full
  // set of armour at two thirds of a pistol, so the first big purchase is a
  // real choice instead of an obvious one.
  gun: {
    pistol: 3500,
    ammo: 8,                              // Kč / round
    box: { rounds: 50, price: 340 },      // 6,80 a round — the bulk price
    vest: { price: 2200, armour: 50 },
  },

  // ---- steel --------------------------------------------------------------
  // The ladder is keyed by the kind names in js/vehicles.js. It is NOT alias-
  // aware: this module imports nothing, so a caller holding a legacy kind
  // ('sedan', 'hatch', 'kombi', 'suv') must launder it through
  // vehicles.normalizeKind() before looking it up here. truck and bus are
  // absent deliberately — nobody sells you a bus; you take one.
  //
  // The anchor is the bottom rung. 18 000 is the real floor of the Czech
  // small-ads column: a fifteen-year-old Fabia with 240 000 km and STK into
  // the spring. Everything above it is spaced so each rung is a decision you
  // save up for rather than a number you pass on the way to the next one.
  cars: [
    { kind: 'fabia', name: 'Škoda Fabia', price: 18000, note: '15 let, STK do jara' },
    { kind: 'octavia', name: 'Škoda Octavia', price: 46000, note: 'nájezd 240 tis.' },
    { kind: 'van', name: 'Dodávka', price: 62000, note: 'ex-firemní, bez oken' },
    { kind: 'bmw', name: 'BMW řady 3', price: 88000, note: 'zadokolka, zimní jinde' },
    { kind: 'mercedes', name: 'Mercedes-Benz třídy E', price: 105000, note: 'servisní knížka' },
    { kind: 'tesla', name: 'Tesla Model 3', price: 120000, note: 'baterie na 88 %' },
  ],

  // A bent car is 1 700 of mechanical work; a scraped one is 700 of paint;
  // most cars that reach a garage in this game are both, which is where the
  // brief's 2 400 comes from. Priced against the tank on purpose: one bad
  // afternoon costs about what a tank and a half costs, so driving badly is
  // expensive without being a wipe.
  //
  // The garage itself is the long goal. 250 000 is what a lock-up actually
  // sells for in a Czech town, and it is the only number here that is meant to
  // look impossible the first time it is read.
  garage: { repair: 1700, respray: 700, full: 2400, buy: 250000 },

  // ---- income, which is where the difficulty curve lives ------------------
  // Everything above is a constant. This is the group that moves, and it moves
  // because the PLAYER moved: missions start at `first` and walk toward `max`
  // as the mission module's own progression says they should. The ends are
  // here so the ratios in the header stay true; the shape of the walk between
  // them belongs to whoever writes the missions.
  //
  // Delivery is the floor: always available, never fast. Base 240 plus 42 a
  // kilometre makes a typical 4 km run about 410 Kč against roughly 13 Kč of
  // petrol burnt, so three runs are one early mission. It exists so a player
  // who has crashed their last car and spent their last koruna still has a way
  // back that is not mugging pensioners.
  //
  // A pocket is 40 Kč far more often than it is 900. `fat` is the share of
  // people carrying real cash — a pensioner on the way to pay the sloučenka in
  // cash, against a student with a card and forty korun for the tram.
  job: {
    mission: { first: 850, min: 800, max: 3000 },
    delivery: { base: 240, perKm: 42, bonus: 150 },
    pocket: { min: 40, max: 900, fat: 0.06 },
  },
});

// ---- looking a pump up ----------------------------------------------------

/**
 * Resolve whatever the world calls a filling station into a brand row. Takes
 * anything — an id, an OSM `brand`/`name` tag, a whole station object, null —
 * and always returns a row, because a HUD that prints "undefined Kč" over a
 * forecourt is worse than one that quietly charges the base price.
 *
 * Substring, not equality, and diacritic-blind: OSM carries "Benzina ORLEN",
 * "ORLEN Benzina" and plain "Benzina" for one company, and Czech arrives both
 * with and without its háčky ("ČEPRO", "CEPRO", "Cepro"). Folding the input
 * once and matching authored tags keeps that whole mess in this function
 * instead of in every caller's if-chain.
 *
 * It allocates two strings per call — call it once per station and keep the
 * row on the station, exactly as the header says. It is never on a frame path.
 */
export function pumpBrand(tag) {
  const raw = typeof tag === 'string' ? tag : (tag?.brand ?? tag?.id ?? tag?.name);
  const fallback = BRANDS[BRANDS.length - 1];
  if (typeof raw !== 'string' || !raw) return fallback;
  // NFD splits "Č" into "C" + a combining caron, and \p{M} deletes the caron.
  // Cheaper and far shorter than a transliteration table, and it cannot get a
  // letter wrong because it never invents one.
  const s = raw.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  // EXACT id first, and this pass is not optional. A caller is expected to
  // resolve a station once and keep the cheap `id` on it — the whole point of
  // the caching note above — so pumpBrand('ono') has to come back with Tank
  // ONO. It cannot come from the tag pass, because 'ono' is exactly the kind
  // of three-letter substring the tags were narrowed to avoid; matching the id
  // by EQUALITY is safe where matching it by inclusion is not.
  for (const b of BRANDS) if (s === b.id) return b;
  for (const b of BRANDS) for (const t of b.tags) if (s.includes(t)) return b;
  return fallback;
}

/**
 * What one litre (or kWh) costs at this pump, in Kč. Unknown fuel type falls
 * back to petrol rather than NaN — a station that sells "something" at the
 * price of Natural 95 is a survivable wrong answer; NaN propagates into the
 * wallet and turns a purchase into a silent no-op.
 *
 * The result is rounded to whole haléře so that price × litres cannot leave a
 * fraction of a koruna nobody can see rattling around in the wallet.
 */
export function pumpPrice(brand, type) {
  const base = FUEL_PRICE[type] ?? FUEL_PRICE.benzin;
  const b = pumpBrand(brand);
  const p = base + (Number.isFinite(b.d) ? b.d : 0);
  return Math.round(Math.max(p, 0.5) * 100) / 100;
}

// ---- money, as Czech prints it --------------------------------------------

// U+202F NARROW NO-BREAK SPACE, and it is used for BOTH gaps — between the
// thousands and before the unit. A normal space anywhere in a money string is
// a place the HUD is allowed to wrap "1 660" onto two lines, and a full-width
// no-break space between groups reads as two numbers standing next to each
// other rather than as one number. One narrow gap throughout is the only
// version that is unambiguous at HUD size in both.
const NBSP = ' ';

// Above this, String(v) starts printing exponents and the group loop below
// would happily emit "1 e+2 1". Clamping is the defensive answer the house
// rule asks for: a corrupt balance prints as an absurd number, not as garbage,
// and never throws.
const MAX = 9e15;

// Anything that is not a usable number becomes 0. undefined, null, NaN, '',
// 'dvanáct', a Proxy — the HUD prints "0 Kč" and the game carries on.
function num(n) {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return 0;
  return v > MAX ? MAX : v < -MAX ? -MAX : v;
}

// Group a run of digits from the right. Written as a loop rather than the
// usual /\B(?=(\d{3})+$)/ replace because the regex costs a fresh RegExp match
// object and this is the one string function the HUD calls often enough for
// that to be worth caring about at all.
function group(digits) {
  const n = digits.length;
  if (n <= 3) return digits;
  const head = ((n - 1) % 3) + 1;
  let out = digits.slice(0, head);
  for (let i = head; i < n; i += 3) out += NBSP + digits.slice(i, i + 3);
  return out;
}

/**
 * Format whole koruny: kc(1660) → "1 660 Kč" (narrow no-break spaces).
 *
 * Rounds FIRST and takes the sign from the ROUNDED value, which is the whole
 * trick to never printing "-0 Kč": −0.4 rounds to −0, and −0 < 0 is false in
 * JavaScript, so the minus is dropped exactly where a reader would expect it
 * to be. Testing the sign of the input instead would print a debt of nothing.
 *
 * The minus is a plain ASCII hyphen. U+2212 is the typographically correct
 * character and it is not worth the day somebody's equality test, written in
 * an editor that helpfully substituted one for the other, fails on a glyph.
 */
export function kc(n) {
  const v = Math.round(num(n));
  const a = v < 0 ? -v : v;
  return (v < 0 ? '-' : '') + group(String(a)) + NBSP + 'Kč';
}

/**
 * Format with haléře, for the one place they exist: a pump price board.
 * kc2(36.9) → "36,90 Kč". Czech writes the decimal comma, and a fuel price
 * without its two decimals ("37 Kč za litr") is not a price anybody in this
 * country has ever seen on a sign.
 *
 * A value that rounds to zero haléře is never negative — a rounding artefact
 * of a tenth of a haléř must not print as a debt.
 */
export function kc2(n) {
  const v = num(n);
  const c = Math.round(Math.abs(v) * 100);
  const whole = Math.floor(c / 100), frac = c % 100;
  const sign = v < 0 && c > 0 ? '-' : '';
  return sign + group(String(whole)) + ',' + (frac < 10 ? '0' : '') + frac + NBSP + 'Kč';
}

export default PRICE;
