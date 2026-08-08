// ==========================================================================
// Wanted — heat, stars, and being seen
//
// WHAT THIS IS. One scalar, `heat`, and five thresholds on it. Crimes push the
// scalar up in discrete lumps; time pulls it down continuously, but ONLY while
// nobody is looking at you. That is the whole model, and every interesting
// decision in this file is about the three words "while nobody is looking".
//
// The feature this pays for is not the star icon. It is the moment where you
// have run two streets, you are stood in a doorway off Sladkovského, and you
// are watching a number you cannot see tick down while a Škoda with a light bar
// goes past the end of the road. A wanted level that only counts crimes is a
// score; a wanted level that decays under a condition you can influence is a
// game. So the condition has to be legible, and it has to be one the player can
// actually work against — which is why the failure modes below are all failures
// of LEGIBILITY rather than of arithmetic.
//
// ── WHY THERE IS NO LINE OF SIGHT, SAID OUT LOUD ───────────────────────────
//
// The obvious design is "the police can see you if a ray from a police car to
// your chest is unobstructed". It is not implemented here, and it is not an
// omission. Three separate things kill it and any one of them is enough:
//
//   1. THE INTERFACE DOES NOT CONTAIN THE WORLD. update(dt, ctx) is handed
//      { x, z, onFoot, car, police }. There is no city, no chunk index, no
//      collision world in it, and widening that ctx is a change to a contract
//      that seven files are being written against at once. A module cannot
//      raycast geometry it was never given.
//
//   2. THE ONE RAYCAST WE COULD HAVE BORROWED IS BLIND EXACTLY WHERE IT MATTERS.
//      city.buildingHitAt(x, y, z) is the height-aware footprint test the
//      rocket uses, and js/city.js:1395 says `if (this.interiors.hidden.has(
//      b._id)) continue;`. js/interiorsim.js:341 puts EVERY building it has
//      given a shell to into that set — and it shells everything inside
//      INTERIOR.drawR, 160 m by default and 80–450 m off the "Dohlednost budov"
//      settings knob. So the entire radius over which a policeman could
//      plausibly recognise you is the exact radius in which buildingHitAt
//      returns null through four floors of brick. An LOS test built on it does
//      not merely have a bug; it is a check that always passes, which is the
//      single worst thing a gating condition can be. It would have shipped
//      looking like a feature and behaving like a constant.
//
//   3. THE OTHER CANDIDATE IS THE WRONG SHAPE AND ALLOCATES. city.buildingAt(
//      x, z) does not consult `hidden`, so a ray marched through it would at
//      least see walls — but it is a FOOTPRINT test with no height (it stops
//      sight through a bridge deck and an arcade), and its inner test is
//      `(b.i ?? []).some(h => …)`, a closure and possibly an array literal per
//      building per sample. A 60 m ray at 4 m steps is fifteen chunk lookups
//      and a hundred-odd closures per query, on a path that has to be free.
//      "Nothing that runs every second may allocate" is not negotiable for a
//      test whose answer would still be wrong about bridges.
//
// So seeing you is a matter of RANGE and of THE PURSUIT'S OWN STATE, and the
// radius is doing the honest work of an abstraction rather than pretending to
// be optics. SEE_R is picked against the actual street grid this city is built
// on, not against eyesight: Pardubice blocks run 40–80 m and its streets 10–25 m
// wide, so 62 m on foot is "this street and the mouth of the next one" and
// 88 m in a car is the same judgement widened for a thing that is four metres
// long, painted, and making a noise. On top of that a unit may publish its own
// `sees` flag — police.js knows whether it has locked on to you and that is
// real information — but it is trusted only out to LOCK_R, 150 m. A pursuit
// module that set `sees = true` at spawn would otherwise make heat undecayable
// from half a kilometre away, and a wanted level you cannot lose is worse than
// one you lose too easily.
//
// THE COST OF THIS CHOICE, stated rather than hidden: standing inside a shop
// with a patrol car outside the window counts as seen. The day something
// publishes "the player is indoors", ctx.inside below turns that from a bug
// into a mechanic; until then it is one line that reads a field nobody sets.
//
// ── ONE DEAD PEDESTRIAN IS ONE CRIME ───────────────────────────────────────
//
// js/pedestrians.js fires BOTH callbacks on a lethal hit — _launch does
// `this.onPedHit?.(p, s)` and then `if (p.dead && !wasDead) this.onPedKilled?.(p)`
// in consecutive lines (pedestrians.js:1193-1194), and the combat refactor moves
// those same two calls into hurt(), so a fatal PUNCH will fire the pair too, on
// top of the 'rvacka' that combat.onCrime already reports. Wire each callback to
// its own add() and one corpse buys three rungs of the ladder.
//
// THE DE-DUPLICATION LIVES HERE, in add(), and it lives here for a reason that
// is not convenience: this module is the only one that sees every crime from
// every source. pedestrians.js cannot fix it — it does not know combat.js
// exists. main.js could fix it at the wiring, but only for the two callbacks it
// happens to be wiring today, and the next source (a bullet, a Skoda, a
// grenade) would re-open it silently. A rule that has to be re-applied at each
// call site is a rule that will be missed at one of them.
//
// The rule: crimes arriving within COINCIDE (0.4 s) of the first one are ONE
// INCIDENT, and an incident is charged at the MAXIMUM of its crimes, never the
// sum. Charging is incremental — each arrival pays only max(0, its heat − the
// incident's peak so far) — so heat never dips, the order of the callbacks does
// not matter, and the label ends up on the most serious thing you did. Hit then
// kill charges 34 then 18: fifty, which is `zabití`, once. Kill then hit
// charges 52 then nothing. A punch that kills charges rvačka, then the
// difference up to zabití, and stops.
//
// The window does NOT extend on each arrival, deliberately. Extending it would
// let a car dragging through a crowd merge a whole massacre into one charge;
// not extending means the pair that fires inside a single call is merged (which
// is the bug) while two people you run over a second apart are two crimes
// (which is the truth). 0.4 s is comfortably over main.js's 50 ms step clamp
// and comfortably under any two things a human does on purpose.
//
// ── THE DECAY IS SLOW BECAUSE THE POLICE ARE FAR ───────────────────────────
//
// Measured on the real graph, patrol density near the player is about ONE slot
// inside TRAFFIC.spawnR — which is 520 m (config.js:154). A car covering 520 m
// of town at a realistic 12 m/s through junctions and lights is forty to sixty
// seconds away from you before it has even been dispatched. So a heat that
// bleeds off in ten seconds is not a lenient wanted system, it is a wanted
// system with no police in it: the star clears before the first unit arrives
// and the entire pursuit is dead code that nobody ever sees run.
//
// Hence two separate brakes, and they multiply rather than overlap:
//
//   CALM = 28 s in which nothing bleeds AT ALL after your last crime. This is
//   the dispatch window. It alone guarantees the unit has time to get near
//   enough to latch `seen`, at which point decay stops for as long as it holds
//   you.
//
//   T_SHED = 34 s of NOT BEING SEEN per star. The rate is derived, not typed:
//   each band's rate is (its width / T_SHED), so shedding the fifth star and
//   shedding the first take about the same wall time even though the fifth band
//   is nearly four times as wide. A single typed rate would have made five
//   stars a twenty-minute sentence and one star a rounding error.
//
// What that buys, integrated against this file's own numbers, unseen throughout:
//
//     one punch (22)              wanted for 41.7 s
//     one killing (52)            wanted for 90.9 s, two stars for the first 42.9
//     hit and run (34 + 18)       two stars, 90.9 s
//     four killings (208)         five stars, 219.3 s — over three minutes hiding
//
// Every one of those clears the 40–60 s a patrol needs to arrive, which is the
// acceptance test that actually matters.
//
// ── HYSTERESIS, AND WHAT IT IS REALLY PROTECTING ───────────────────────────
//
// A bare threshold makes the star ladder a knife edge, and heat spends most of
// its life sitting on one: the last crime is what put it there and decay is
// slow. A player at two stars trading punches sits at 45.4, 45.1, 44.9 → one
// star, punches → 71 → two stars, decays → one star, over and over.
//
// The HUD flicker is the visible half of that and the cheap half. The
// expensive half is onStars: police.js listens on that edge to decide whether a
// pursuit exists, so a star that toggles twelve times is twelve pursuits spawned
// and despawned — cars appearing and vanishing at the end of the street, which
// looks less like a bug and more like the world being broken. So stars go UP at
// STAR_AT[n] and only come DOWN at STAR_AT[n] − HYST × (band width), and HYST is
// 0.18 because that is about five seconds of decay at every band's own rate:
// long enough that a star, once earned, has to be properly lost, short enough
// that it never reads as the meter being stuck.
//
// The same idea guards `seen` from the other direction. It is a LATCH, not an
// instantaneous test: any qualifying unit stamps _seenAt = now + SEEN_HOLD (6 s),
// so a patrol car weaving across the edge of SEE_R cannot chatter the decay on
// and off at frame rate, and "they had eyes on me four seconds ago" correctly
// still counts as not being clear yet.
//
// ── THE CLOCK ──────────────────────────────────────────────────────────────
//
// Every cooldown in here is an ABSOLUTE DEADLINE against this module's own
// stepped clock, for the reason js/chatter.js's header spends forty lines on: a
// countdown nobody ticks is a silent bug that every test still passes. Nothing
// in this file counts down.
//
// The clock is `_now`, advanced by update() alone, and NOT worldT(). js/vitals.js
// argues this for regeneration and the argument is stronger here: on a wall
// clock, alt-tabbing for two minutes would clear your wanted level while the
// pursuit cars sat frozen in a hidden tab, and you would come back clean with
// three police Octavias parked around you. On a stepped clock a frozen game
// freezes the calm window, the sight latch and the decay together — the whole
// state stops being consistent with itself, instead of half of it advancing.
//
// update() is safe called several times per rendered frame (main.js clamps dt to
// 50 ms and loops): decay is linear in dt so three partial steps integrate to
// the same heat as one whole one, and every deadline is compared against the
// same monotonic _now whichever substep asks.
//
// ── DETERMINISM: NONE, ON PURPOSE ──────────────────────────────────────────
//
// This is the player's own local state, exactly like the traffic horn
// (traffic.js:2291) and exactly like js/vitals.js's HP. It is not a function of
// the world seed and it never will be, because the input is what YOU did. Two
// clients are SUPPOSED to disagree about your wanted level — in co-op you and
// the other player have committed different crimes and are wanted for different
// things, and a shared star meter would be the bug.
//
// Local divergence is survivable because this module moves nothing in the shared
// world. It publishes a number and an edge. Whoever converts that edge into cars
// on the street owns the question of whether those cars are shared, and that
// question belongs in js/police.js's header, not in this one.
//
// ── DEPENDENCIES: NONE ─────────────────────────────────────────────────────
//
// Not the clock, not the wallet, not three.js, not the DOM. The crime table is
// six rows of Czech and it is cheaper to hold them than to import them. This
// file loads under `node --test` with nothing else on disk.
//
// PER-FRAME COST. No object, array or closure literal on any path update()
// touches. The sight scan runs at SIGHT_HZ (4 Hz) against an absolute deadline —
// sight is not a per-frame quantity and SEEN_HOLD is twenty-four times the
// sample interval, so nothing can be missed — and it indexes police.units
// directly when it is array-shaped, which is the case that will actually run.
// The one path that does allocate is add(), which normalises a crime name: that
// is an EVENT path taken a few times a minute, not a frame path, and the house
// rule is about the second kind.
// ==========================================================================

// ---- the crimes, and what each is worth ----------------------------------
// Czech nouns because they end up on the HUD next to the stars. Lower case: the
// caller capitalises if its typography wants that. The heat column is tuned
// against STAR_AT below and the four sample escapes in the header — read them
// together, because moving one number without the other silently re-tunes the
// whole ladder.
//
//   rvacka   22  one punch is a nuisance: one star, and so is the second (44,
//                still under 45). The THIRD is two stars — a scuffle is one
//                thing and a man who will not stop hitting people is another.
//                It was 26 for an afternoon, which made two punches (52) cost
//                exactly what a killing costs, and that is not a ladder anybody
//                would believe.
//   kradez   24  taking a car is a shade worse than a punch: property crime
//                with an owner who reports it. Still one star, as the genre
//                established and as players expect.
//   srazeni  34  running a man down is heavier than hitting him, and two of
//                them (68) is two stars.
//   ujeti    18  never happens alone — it lands on top of a srazeni, and
//                34 + 18 = 52 is the point: stop and it is one star, drive
//                away and it is two. That is a whole mechanic for one row.
//   zabiti   52  a killing is two stars on the spot. Four of them is exactly
//                208, over the five-star line: a spree of four is the maximum.
//   naraz    50  ramming a police car is very nearly a killing, and it is the
//                one crime you can commit against a stationary patrol with a
//                clean record.
const CRIMES = Object.freeze({
  rvacka:  Object.freeze({ key: 'rvacka',  heat: 22, noun: 'rvačka' }),
  zabiti:  Object.freeze({ key: 'zabiti',  heat: 52, noun: 'zabití' }),
  srazeni: Object.freeze({ key: 'srazeni', heat: 34, noun: 'sražení chodce' }),
  ujeti:   Object.freeze({ key: 'ujeti',   heat: 18, noun: 'ujetí od nehody' }),
  kradez:  Object.freeze({ key: 'kradez',  heat: 24, noun: 'krádež auta' }),
  naraz:   Object.freeze({ key: 'naraz',   heat: 50, noun: 'náraz do policie' }),
});
export { CRIMES };

// Seven people are wiring this at once and they will not all spell a key the
// same way. `zabiti`, `zabití`, `ZABITI` and `kradez_auta` all have to land on
// the same row, because the alternative is a crime that charges the fallback
// price and a bug nobody notices for a week. Normalisation is fold to lower
// case, strip diacritics, drop everything that is not a letter — so the Czech
// noun itself is a valid key, which is what a caller reaching for the HUD
// string will naturally pass.
const _INDEX = new Map();
function normKey(s) {
  // NFD splits 'á' into 'a' + U+0301; the range U+0300–U+036F is the whole
  // combining-diacritics block, so this is diacritic-stripping without a table.
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z]/g, '');
}
for (const k in CRIMES) {
  const row = CRIMES[k];
  _INDEX.set(normKey(k), row);          // 'rvacka'
  _INDEX.set(normKey(row.noun), row);   // 'srazenichodce', 'ujetiodnehody', …
}
// The short forms of the two-word nouns, so 'srazeni' and 'kradez' work too.
_INDEX.set('srazeni', CRIMES.srazeni);
_INDEX.set('ujeti', CRIMES.ujeti);
_INDEX.set('kradez', CRIMES.kradez);
_INDEX.set('naraz', CRIMES.naraz);

// A name we do not know still has to cost something — dropping it silently is
// how a whole category of crime turns out to have been free since March. It
// costs a punch, and it complains ONCE per distinct name so the wiring bug is
// visible without becoming a per-frame console flood.
const UNKNOWN_HEAT = CRIMES.rvacka.heat;
const _warned = new Set();

// ---- the ladder ----------------------------------------------------------
// Heat needed for n stars. The widths (18, 27, 35, 50, 70) grow because the
// crimes that reach the upper bands are themselves worth more — four killings
// is 208 and lands exactly on five — and because a flat ladder would have made
// the fifth star as easy to reach as the second.
const STAR_AT = Object.freeze([0, 18, 45, 80, 130, 200]);
// Above this nothing accumulates. Without a cap, ten minutes of rampage banks
// an hour of decay and the escape stops being a thing you play — it becomes a
// thing you wait out. 260 is thirty seconds of margin over five stars.
const HEAT_MAX = 260;

const HYST = 0.18;        // a star is lost 18 % of its band BELOW where it was won
const T_SHED = 34;        // s of not being seen to shed one star, any star
const CALM = 28;          // s after a crime in which nothing decays at all
const SEEN_HOLD = 6;      // s that one sighting keeps you "seen" for
const COINCIDE = 0.4;     // s — crimes this close together are one incident

const SEE_R_FOOT = 62;    // m — see the street-grid argument in the header
const SEE_R_CAR = 88;     // m — a car is bigger, louder, and on their road
const INSIDE_K = 0.35;    // × the radius when ctx.inside says you are indoors
const LOCK_R = 150;       // m — how far a unit's own `sees` flag is believed
const SIGHT_HZ = 4;       // scans/s — SEEN_HOLD is 24 samples wide, so this is free
const SIGHT_DT = 1 / SIGHT_HZ;

// A single step is never more than main.js's 50 ms clamp. Anything past 0.25 s
// is a debugger or a tab that was hidden, and neither of those is time the
// player spent evading the police — clamping is what stops an alt-tab from
// being an escape route.
const DT_MAX = 0.25;

// Derived once at load, never at runtime. Typed arrays so the two numbers the
// per-frame path reads (RATE[_stars], DROP_AT[s]) are unboxed doubles rather
// than a possibly-holey Array that V8 has to check the shape of every step.
const DROP_AT = new Float64Array(6);
const RATE = new Float64Array(6);
for (let s = 1; s <= 5; s++) {
  const band = STAR_AT[s] - STAR_AT[s - 1];
  DROP_AT[s] = STAR_AT[s] - HYST * band;
  RATE[s] = band / T_SHED;
}
// At zero stars there is still residue to bleed; it bleeds at the first band's
// rate, because that is the band it is in.
RATE[0] = RATE[1];

// ---- state ---------------------------------------------------------------
let _heat = 0;
let _stars = 0;
let _now = 0;             // this module's own stepped clock — see THE CLOCK
let _calmAt = 0;          // deadline: no decay before this
let _seenAt = 0;          // deadline: they had eyes on you until this
let _scanAt = 0;          // deadline: next sight scan
let _incAt = 0;           // deadline: the open incident closes at this
let _incHeat = 0;         // the peak already charged inside the open incident
let _crime = '';          // Czech noun of the most serious recent charge

const _starFns = [];
const _noCtx = Object.freeze({});

// ---- helpers -------------------------------------------------------------

/** Where in the ladder `h` sits, ANCHORED on the star you already had. Rising
 *  uses STAR_AT, falling uses DROP_AT — the gap between the two IS the
 *  hysteresis, and anchoring is what makes it path-dependent rather than a
 *  second threshold table nobody can keep in step with the first. */
function ladder(h, prev) {
  let s = prev < 0 ? 0 : prev > 5 ? 5 : prev;
  while (s < 5 && h >= STAR_AT[s + 1]) s++;
  while (s > 0 && h < DROP_AT[s]) s--;
  return s;
}

/** A listener that throws must not take the wanted system with it. vitals.js
 *  fires its own callbacks the same way and for the same reason: one TypeError
 *  raised inside stepGame froze co-op on the last drawn frame, every frame. A
 *  HUD that fails to update is a bug; a dead renderer is a dead game. */
function fire(stars, prev) {
  for (let i = 0; i < _starFns.length; i++) {
    try { _starFns[i](stars, prev); } catch (e) { console.warn('[wanted] listener:', e); }
  }
}

/** Recompute the star count and announce the EDGE if it moved. Called once per
 *  update() and once per charged crime — never inside a loop, so a rampage that
 *  crosses two thresholds in one lump fires one call with (3, 1) rather than
 *  two, which is exactly what a pursuit spawner wants to hear. */
function relevel() {
  const s = ladder(_heat, _stars);
  if (s === _stars) return;
  const prev = _stars;
  _stars = s;
  fire(s, prev);
}

/** Read a unit's world position. police.units may hold cars directly or hold
 *  records that wrap one; both are cheap to support and guessing wrong would
 *  mean the sight test silently never fires. NaN when there is nothing to read,
 *  which fails the range comparison rather than passing it. */
function unitX(u) { return typeof u.x === 'number' ? u.x : (u.car ? u.car.x : NaN); }
function unitZ(u) { return typeof u.z === 'number' ? u.z : (u.car ? u.car.z : NaN); }

/** Is any police unit close enough to have you? See WHY THERE IS NO LINE OF
 *  SIGHT — this is the whole of "they can see you", and it is deliberately a
 *  radius plus the pursuit's own flag rather than a raycast that would always
 *  have returned true. */
function anyEyesOn(c) {
  const src = c.police;
  if (!src) return false;
  // Accept the module or the bare list: main.js may hand over either, and a
  // wanted level that quietly never decays because it was handed the wrong
  // shape is not a failure anybody would think to look for.
  const units = src.units !== undefined ? src.units : src;
  if (!units) return false;

  const px = c.x, pz = c.z;
  if (!Number.isFinite(px) || !Number.isFinite(pz)) return false;   // cannot judge

  let r = c.onFoot === false ? SEE_R_CAR : SEE_R_FOOT;
  // Optional and currently unset by anybody: the day interiors publishes "the
  // player is inside a building", this turns the one acknowledged cost of the
  // range model into a mechanic. Until then it reads a field nobody writes.
  if (c.inside) r *= INSIDE_K;
  const r2 = r * r, lock2 = LOCK_R * LOCK_R;

  // Indexed when it is array-shaped — which is what `police.units` is — so the
  // common path allocates nothing at all. The for..of fallback costs one
  // iterator per SCAN, i.e. four a second, and only for a Set or a generator.
  const n = typeof units.length === 'number' ? units.length : -1;
  if (n >= 0) {
    for (let i = 0; i < n; i++) {
      const u = units[i];
      if (u && eyes(u, px, pz, r2, lock2)) return true;
    }
    return false;
  }
  for (const u of units) if (u && eyes(u, px, pz, r2, lock2)) return true;
  return false;
}

/** One unit against one player position. `u.sees` is the pursuit's own state —
 *  police.js knows whether it has locked on, and that is better information
 *  than any distance — but it is believed only inside LOCK_R, because a module
 *  that set the flag at spawn would otherwise make heat undecayable from half a
 *  kilometre and turn a wanted level into a life sentence. */
function eyes(u, px, pz, r2, lock2) {
  const dx = unitX(u) - px, dz = unitZ(u) - pz;
  const d2 = dx * dx + dz * dz;
  if (!(d2 >= 0)) return false;             // NaN from an unreadable unit
  return d2 <= (u.sees ? lock2 : r2);
}

// Scratch for the (amount, noun) pair add() resolves. Two module-level slots
// rather than a returned object: add() is an event path and could afford the
// literal, but two scalars are simpler than a record nobody else reads.
let _rAmt = 0, _rNoun = '';

/**
 * Work out what this call is charging and what to call it. Deliberately
 * forgiving about argument order and type, because the alternative is a wiring
 * mistake that charges the wrong price silently:
 *
 *   add(52, 'zabiti')      explicit price, name resolved to 'zabití' for the HUD
 *   add('zabiti')          both out of the table
 *   add('zabiti', 60)      table row, caller's price
 *   add(12, 'něco')        explicit price, caller's own label passed through
 *   add('kradezauta')      normalised onto krádež auta
 */
function resolve(a, b) {
  let amt = NaN, row = null, label = '';

  // A string in EITHER position is looked up; a number in either position is
  // an explicit price and the later one wins, which is the only ordering that
  // makes both (price, kind) and (kind, price) mean what they read as.
  if (typeof a === 'number') amt = a;
  else if (typeof a === 'string') { row = _INDEX.get(normKey(a)) || null; if (!row) label = a; }

  if (typeof b === 'number') amt = b;
  else if (typeof b === 'string') {
    const hit = _INDEX.get(normKey(b));
    if (hit) row = hit; else if (!row) label = b;
  }

  // Only a name we could neither price nor recognise is a wiring bug worth
  // shouting about. A caller who passed their own number AND their own label
  // knew what they were doing — 'výtržnictví' for 12 is a legitimate one-off,
  // not a typo — so it is charged as asked and passes through to the HUD silently.
  const priced = Number.isFinite(amt);
  if (!priced) amt = row ? row.heat : UNKNOWN_HEAT;
  if (!row && !priced && label && !_warned.has(label)) {
    _warned.add(label);
    console.warn('[wanted] unknown crime "' + label + '" — charged ' + UNKNOWN_HEAT);
  }

  _rAmt = amt > 0 ? amt : 0;
  _rNoun = row ? row.noun : label;
}

// ---- public --------------------------------------------------------------

/** The raw scalar. Nothing outside a debug overlay should read this — the
 *  player is told about stars, not about points. */
export function heat() { return _heat; }

/** 0..5. The number the HUD draws and the number police.js acts on. */
export function stars() { return _stars; }

/** How far through the CURRENT star you are, 0..1 — for a HUD that wants to
 *  show the next star filling rather than just the icons. Pinned at 1 on five,
 *  because there is nothing above it to fill towards. */
export function frac() {
  if (_stars >= 5) return 1;
  const lo = STAR_AT[_stars], hi = STAR_AT[_stars + 1];
  const f = (_heat - lo) / (hi - lo);
  return f > 0 ? (f < 1 ? f : 1) : 0;
}

/** The Czech noun of the most serious thing in the most recent incident, or ''
 *  — a HUD ticker line ("hledán pro: zabití"). Survives the incident closing;
 *  cleared only by clear() and reset(). */
export function lastCrime() { return _crime; }

/** True while the police can currently see you — a LATCH with SEEN_HOLD of
 *  memory, so it cannot chatter at frame rate as a car crosses the radius. It
 *  is only ever refreshed while you are wanted: at zero stars nobody is looking
 *  for you, which is also why the scan is skipped in the 99 % case. */
export function seen() { return _now < _seenAt; }

/**
 * Raise the heat. `n` is the amount and `crime` the Czech noun for the HUD —
 * but see resolve(): a crime KEY in either position is looked up in CRIMES, so
 * `add('zabiti')`, `add(52, 'zabiti')` and `add(CRIMES.zabiti.heat,
 * CRIMES.zabiti.noun)` all do the same thing and none of them can be spelled
 * into a silent no-op.
 *
 * Returns the heat actually charged, which is 0 for an echo of an incident
 * already paid for — see ONE DEAD PEDESTRIAN IS ONE CRIME. Callers may ignore
 * it; tests should not.
 */
export function add(n, crime) {
  resolve(n, crime);
  let amt = _rAmt;
  const noun = _rNoun;
  if (!(amt > 0)) return 0;

  if (_now < _incAt) {
    // Inside the open incident: this is the same event arriving down a second
    // callback. Pay the ESCALATION only, and never anything for a lesser or
    // equal echo. Charging the difference rather than replacing means heat is
    // monotonic through the merge — a dip, however brief, would cross a drop
    // threshold and fire a spurious onStars edge.
    const up = amt - _incHeat;
    if (up <= 0) return 0;
    _incHeat = amt;
    amt = up;
  } else {
    _incAt = _now + COINCIDE;       // NOT extended by later arrivals — see header
    _incHeat = _rAmt;
  }
  if (noun) _crime = noun;          // the label follows the heaviest charge

  _heat += amt;
  if (_heat > HEAT_MAX) _heat = HEAT_MAX;
  // Every charge re-arms the dispatch window. An absolute deadline: nothing in
  // this file counts down, so nothing here can rot if a frame is missed.
  _calmAt = _now + CALM;
  relevel();
  return amt;
}

/**
 * One step. ctx = { x, z, onFoot, car, police }, all optional — a missing
 * `police` simply means nobody can see you, which is the correct reading of
 * "the police module is not wired yet" and not a reason to throw.
 *
 * `car` is accepted and not read: onFoot is the authoritative flag (it is the
 * only thing that can tell "stepped out and the slot is stale" from "still
 * sitting in it") and the radius is the only thing the vehicle would have
 * changed. The parameter stays in the signature because it is in the contract
 * and because the first thing anybody adds here will want it.
 */
export function update(dt, ctx) {
  const step = Number.isFinite(dt) && dt > 0 ? (dt > DT_MAX ? DT_MAX : dt) : 0;
  _now += step;
  const c = ctx || _noCtx;

  // SIGHT. Only while wanted: at zero stars there is no pursuit and nobody is
  // looking for you, so this whole branch — the only per-frame work in the
  // module — is skipped for almost the entire session. 4 Hz because SEEN_HOLD
  // is six seconds wide; a sighting cannot fall between two samples.
  if (_stars > 0 && _now >= _scanAt) {
    _scanAt = _now + SIGHT_DT;
    if (anyEyesOn(c)) _seenAt = _now + SEEN_HOLD;
  }

  // DECAY. Two absolute deadlines gate it and both must have passed: the
  // dispatch window since your last crime, and the memory of the last sighting.
  // The rate is the current band's own, so every star costs about T_SHED
  // seconds of successful hiding regardless of which star it is.
  if (_heat > 0 && _now >= _calmAt && _now >= _seenAt) {
    _heat -= RATE[_stars] * step;
    if (_heat < 0) _heat = 0;
  }
  relevel();
}

/**
 * You lost them, you were arrested, or you paid the fine: the record goes to
 * zero and the pursuit is told to stand down through the same onStars edge it
 * was started on. The clock and the listeners survive — this is an event in the
 * session, not the end of it.
 */
export function clear() {
  _heat = 0;
  _seenAt = 0;
  _calmAt = 0;
  _incAt = 0;
  _incHeat = 0;
  _crime = '';
  relevel();
}

/**
 * New game, or a dev key. Everything, including the clock.
 *
 * It fires onStars(0, prev) through clear() rather than assigning _stars = 0
 * quietly, because a listener that missed the edge would be left holding a
 * pursuit for a player who no longer exists. Subscriptions are NOT dropped:
 * main.js registers once at boot, and unhooking the police on a restart would
 * leave a city with no law in it and no error to explain why.
 */
export function reset() {
  clear();                 // fires the stand-down edge while _stars is still real
  _now = 0;
  _scanAt = 0;
  _warned.clear();         // a fresh session gets to hear about its wiring again
}

/** fn(stars, prev) — fired once per CHANGE, never per frame, and never twice
 *  for one lump of heat even when it crosses two thresholds at once. */
export function onStars(fn) { if (typeof fn === 'function') _starFns.push(fn); }

// A bundled default as well as the named exports, because `new Police({ wanted })`
// wants an object and `import * as wanted` and `import wanted from` should not be
// a decision anybody has to get right. Every function above is module-level and
// closes over nothing, so neither form can lose its binding.
export default { CRIMES, heat, stars, frac, lastCrime, seen, add, update, clear, reset, onStars };
