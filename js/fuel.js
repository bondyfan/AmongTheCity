// ==========================================================================
// Fuel — every car's tank, in litres, and what a metre of road costs
//
// WHAT THIS IS FOR. A car you can drive forever is a spawn point with wheels.
// The moment a tank can run out, the map acquires pumps, a detour acquires a
// price, and "I'll take the Tesla" becomes a decision instead of a preference.
// That is the whole feature: not a chore, a slow pressure. Every number below
// is tuned so a full tank lasts most of a session in a city the size of
// Pardubice — see THE NUMBERS — because a fuel gauge that empties every ten
// minutes is a leash, and players cut leashes.
//
// ── TYPE IS READ, NOT ROLLED ───────────────────────────────────────────────
//
// A car's drivetrain is NOT a coin flip stored per car. It is derived from the
// engine voice js/audio.js already gives that kind, so it can never contradict
// what the car sounds like — a vehicle that clatters like a diesel and takes
// benzín at the pump is the kind of small lie a player notices once and then
// stops trusting the whole economy over. It also costs co-op exactly zero
// bytes: both clients derive the same answer from the same kind string, so
// there is nothing to send and nothing to disagree about.
//
// The rule, measured against ENG_KINDS in js/audio.js:
//
//     knock >= 0.05 || rpmMax <= 4500   ->  nafta
//     ev (no engine cycle at all)       ->  elektro
//     otherwise                         ->  benzin
//
// which reads the two things that ARE the diesel sound in that synth: the
// 1.8 kHz injection rattle (petrol keeps a trace of it, 0.008–0.015; the van,
// truck and bus are at 0.07–0.10, five times higher) and a redline low enough
// that the firing order never leaves the bottom of the spectrum. Applied to
// the real table:
//
//     octavia  knock .012  rpmMax 6200   benzin
//     fabia    knock .015  rpmMax 6000   benzin
//     bmw      knock .010  rpmMax 7000   benzin
//     mercedes knock .008  rpmMax 6500   benzin
//     van      knock .070  rpmMax 4200   NAFTA   (both tests fire)
//     truck    knock .100  rpmMax 2400   NAFTA   (both tests fire)
//     bus      knock .090  rpmMax 2200   NAFTA   (both tests fire)
//     tesla    ev: 1                     ELEKTRO
//
// So why is the table below hard-coded rather than imported and evaluated?
// Because importing js/audio.js drags the entire Web Audio surface into every
// consumer of this file, and the point of this module is that it runs headless
// under `node --test` with no DOM, no AudioContext and no WebGL. The rule is
// written out above so that a NINTH kind is classified the same way by hand:
// look at its knock and its redline, apply the two lines, add the row. What is
// duplicated here is eight strings, and the rule that produced them is on the
// page — which is the trade js/chatter.js makes for hash32 and js/pedestrians.js
// makes for the same function again, for the same reason.
//
// Aliases resolve exactly as ENG_ALIAS does (sedan/kombi → octavia, hatch →
// fabia, suv → bmw), and an unknown kind lands on the Octavia — the Czech
// default that vehicles.js, audio.js and the geometry cache all fall back to.
// A corrupt save gets a petrol Škoda, not a crash.
//
// ── BURN, AND THE MODEL THAT WAS THROWN AWAY ───────────────────────────────
//
// The first design computed a road load: engine output from `car.pull`, a
// rewrite of tyreStep's force balance, brake-specific fuel consumption, the
// lot. It was measured 8x to 16x wrong depending on the kind, and the reason
// is upstream of the physics: `input.moveZ` is an INTEGER, so the throttle in
// this game is bang-bang — you are either at 100 % or at 0 %, never at the
// 15 % a cruising car actually holds. Integrating a load model over a square
// wave charges you for a full-throttle engine every metre you are not
// braking. The Tesla came out with 1.7 km of range.
//
// So this file does the simple correct thing instead, and the simple correct
// thing is what every manufacturer already publishes:
//
//     litres burned = (l/100 km) / 100 000  ×  metres actually travelled
//
// `car.vGround` is the honest speed js/vehicles.js publishes out of driveStep
// (sqrt of longitudinal² + lateral², so a car crossing a junction sideways is
// not reported as stationary), which means this needs no change to vehicles.js
// at all — not one line. Distance is speed × dt, and it is dt that makes the
// whole thing frame-rate independent for free: stepGame(dt) can run three
// times in one rendered frame (main.js clamps to 50 ms and loops) and three
// partial distances sum to the same metres as one whole one. There is no
// accumulator here, no countdown, and no timer, so there is nothing for a
// missed tick to rot — the lesson js/chatter.js's header spends forty lines on
// simply has no surface to attach to in this module.
//
// The one departure from the brochure figure is a penalty for hard
// acceleration, taken off `car._acc` — which vehicles.js already smooths at
// 6 Hz for the suspension squat, so it is free and it is not jittery:
//
//     factor = 1 + min(1.0, 0.18 × max(0, _acc))
//
// Only POSITIVE acceleration counts, and that is not a rounding-off, it is the
// anti-gaming property: the bill is per metre, so braking can only remove
// metres you were going to pay for anyway. There is no way to make a journey
// cheaper by driving worse. A hot hatch at full throttle holds about 4 m/s²
// smoothed → ×1.72; the ×2.0 ceiling is reached only by the Tesla off the line
// (KIND.tesla accel = 12.0), which is precisely the car whose real range
// collapses when you use the launch. Measured over whole tanks (below), that
// is worth under 1 % on a motorway run and about 15 % if you stop and launch
// every 150 m — because the metres covered while accelerating are a small
// fraction of the metres covered. A cost you feel at the pump, not a curve to
// optimise around.
//
// NO IDLE BURN, deliberately. A parked engine really does drink half a litre
// an hour, and modelling it buys one thing (realism nobody will name) at the
// price of the single worst failure this system could have: a tank that
// empties while the player is stood still reading a map, or away from the
// keyboard, or in a paused tab that main.js will hand us as one long dt. Empty
// is a state you must be able to blame yourself for. Distance travelled is the
// only input, so standing still is always free.
//
// ── THE NUMBERS, AND THE SANITY CHECK ──────────────────────────────────────
//
// Tank sizes are the real ones. Consumption is a little above each car's
// brochure figure, because nobody in this game drives to a brochure. The three
// range columns are MEASURED, not divided: a full tank driven to empty against
// this file's own burn(), through three drive cycles that reproduce vehicles.js's
// `_acc` smoothing (`_acc += (raw − _acc) · min(1, 6·dt)`) so the acceleration
// penalty is charged exactly as it will be in the game. Motorway is a launch and
// then 20 km of cruise; city is 400 m hops at 80 km/h; the last column stops and
// re-launches every 150 m, which is the worst any player can actually drive.
//
//     kind      drivetrain   tank     l/100km   motorway   city   stop-start
//     octavia   benzin        50 L      7.6        655       608      561
//     fabia     benzin        45 L      7.0        640       592      544
//     bmw       benzin        60 L     10.0        598       561      523
//     mercedes  benzin        66 L     10.2        645       604      561
//     van       nafta         70 L      9.5        733       674      619
//     truck     nafta        300 L     32.0        935       861      801
//     bus       nafta        250 L     35.0        711       657      612
//     tesla     elektro       80 kWh   21.0        380       360      338
//
// The brief's two acceptance tests: a Fabia is asked for 500–700 km and does
// 544–640 across every driving style there is; a Tesla is asked for 300–400 and
// does 338–380. Both hold at BOTH ends, which is the only way to state a range
// check that means anything — a single figure would have hidden the fact that
// the penalty is what decides whether the low end clears. The ordering also has
// to survive a glance —
// consumption climbs with mass (fabia 1.15 t → truck 10 t → bus 13 t, straight
// out of KIND in vehicles.js), and the two sixes split on manners rather than
// mass: the BMW revs to 7000 and pops on the overrun, the Mercedes is
// audio.js's "expensive silence", so the heavier car is the thriftier one.
//
// kWh is a LABEL, not a branch. The Tesla's tank is 80 and its rate is 21 and
// the arithmetic underneath is identical to a litre's — which is exactly why
// there is one table and one burn path and not an EV special case waiting to
// drift out of sync with the other seven.
//
// ── WHERE THE FUEL IN A FOUND CAR CAME FROM ────────────────────────────────
//
// Deterministic, from the car's stable slot seed, so that "there's a Fabia by
// the bridge and it's nearly empty" is a fact two players in one room share
// rather than two different rumours. Triangular (the mean of two draws) over
// 0.12–0.98 of the tank: most cars you open are somewhere near half, and both
// a brimmed tank and a car running on fumes are rare enough to be worth
// mentioning to the other player. Uniform would have made every third car a
// small emergency and stopped meaning anything by the tenth.
//
// The seed is `car.ai.seed` for a car the traffic schedule owns — that is
// traffic.js's own per-slot, per-generation integer and it is the same on both
// machines — and otherwise the car's position quantised to the half metre. The
// second case is the parked fleet, and it is exact where it matters: a lot car
// is placed once, at a stall whose coordinates parkinglots.js derives from the
// city geometry, and it does not move until somebody drives it away. Both
// clients hash the same two integers.
//
// THE ONE CASE THAT CAN DIVERGE, stated plainly: a traffic car you STEAL.
// traffic.steal() nulls `car.ai` at the moment you open the door, so if the
// first read of its tank happens after that, we fall through to position — and
// traffic.js's header is explicit that its car positions carry a local lag, so
// two clients may quantise to neighbouring half-metres and seed different
// tanks. This is survivable and not worth a network message: nothing in this
// build sends fuel over the wire at all (see the module contract — wallet,
// vitals and fuel are all local), so the two tanks were never going to be the
// same object. What determinism buys is the PARKED car, the one you plan a
// trip around and tell somebody else about, and that case is exact.
//
// AI TRAFFIC DOES NOT BURN FUEL, and burn() refuses outright for any car that
// still has an `ai` record. Two reasons, and the second is the load-bearing
// one. First, nobody watches an AI car for the eleven minutes it would take to
// matter; traffic.js retires slots on a generation clock long before that.
// Second, and this is a contract violation rather than a waste: traffic.js
// guarantees that a scheduled car drives its route, and a fuel model that can
// reach zero can strand one — a dead Škoda in lane one, blocking a junction,
// with no code anywhere that knows how to tow it. Simulating a resource that
// nothing can replenish is how you get a city that gradually seizes up.
//
// ── DEPENDENCIES ───────────────────────────────────────────────────────────
//
// None. The contract permits importing ./prices.js and this file wants nothing
// from it: fill() returns the litres that actually went into the tank and the
// pump multiplies that by FUEL_PRICE itself, which keeps the one module that
// knows about money knowing about money. An import taken for tidiness is still
// an import, and this way js/fuel.js loads under node with nothing else on
// disk at all.
//
// STATE LIVES ON THE CAR (`_fuel`, `_fuelSeed`, `_fuelGen`), not in a Map
// keyed by car. A Map would pin every car that ever existed against the
// garbage collector — vehicles.remove() drops the mesh and forgets the object,
// and there is no dispose hook for us to hang off. Fields on the car die with
// the car. reset() therefore cannot walk a registry it does not have, so it
// bumps a generation counter instead: any car whose `_fuelGen` is stale
// re-seeds on its next read, which is the same trick pedestrians.js uses to
// retire a slot without chasing the body.
// ==========================================================================

// Byte-identical to the hash in js/chatter.js, js/pedestrians.js and
// js/traffic.js, and duplicated for the reason all three of them state: the
// deterministic layers of this game must be pure functions of the same
// integers, and a shared import that somebody later "optimises" would silently
// re-roll the world. Only imul, xor and shift — nothing two engines can
// disagree about. A non-integer argument becomes 0 through `| 0` rather than
// poisoning the result with NaN, which is what makes every caller below safe
// to hand a corrupt coordinate.
function hash32(a, b = 0, c = 0, d = 0, e = 0, f = 0) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < 6; i++) {
    let k = (i === 0 ? a : i === 1 ? b : i === 2 ? c : i === 3 ? d : i === 4 ? e : f) | 0;
    k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}
const rnd01 = (h) => (h >>> 8) / 16777216;

// Salts. js/pedestrians.js burns 0xc17 on the wardrobe, js/traffic.js uses the
// small integers 1–9 and 0x51 on the very seed we re-hash here, and the 0x76xx
// block belongs to the crowd's voices (js/chatter.js) and bodies (js/people.js).
// 0xf0e_ is unused by any of them, so a tank can never accidentally be a
// jacket colour or a horn cooldown drawn from the same seed.
const S_LEVEL = 0xf0e1;      // how full a car you have never opened is
const S_SLOT = 0xf0e2;       // a parked car's identity, from where it stands

// ---- the eight cars, as one frozen table ---------------------------------
// `fuel` is the derivation at the top of the header, evaluated by hand against
// ENG_KINDS and written down so nothing at runtime has to touch js/audio.js.
// `tank` is litres, or kWh for the one electric car. `per100` is litres (or
// kWh) per 100 km — see THE NUMBERS for the range each row produces.
const CARS = Object.freeze({
  octavia:  Object.freeze({ fuel: 'benzin',  tank: 50,  per100: 7.6 }),
  fabia:    Object.freeze({ fuel: 'benzin',  tank: 45,  per100: 7.0 }),
  bmw:      Object.freeze({ fuel: 'benzin',  tank: 60,  per100: 10.0 }),
  mercedes: Object.freeze({ fuel: 'benzin',  tank: 66,  per100: 10.2 }),
  van:      Object.freeze({ fuel: 'nafta',   tank: 70,  per100: 9.5 }),
  truck:    Object.freeze({ fuel: 'nafta',   tank: 300, per100: 32.0 }),
  bus:      Object.freeze({ fuel: 'nafta',   tank: 250, per100: 35.0 }),
  tesla:    Object.freeze({ fuel: 'elektro', tank: 80,  per100: 21.0 }),
});

// Exactly ENG_ALIAS in js/audio.js and ALIAS in js/vehicles.js. Pre-v4 saves
// and main.js's spawn list still say these names; resolving them here means an
// old save gets the right pump, not a fallback.
const ALIAS = Object.freeze({ sedan: 'octavia', hatch: 'fabia', kombi: 'octavia', suv: 'bmw' });

// ---- burn constants ------------------------------------------------------
const L_PER_M = 1e-5;        // (l/100 km) → litres per metre: /100 then /1000
const ACC_K = 0.18;          // extra fraction burned per m/s² of acceleration
const ACC_CAP = 1.0;         // …never more than double. See the header.
const MOVING = 0.05;         // m/s below which a car is parked, not creeping
// A single step is never more than main.js's 50 ms clamp. Anything larger is a
// tab that was hidden or a debugger that was paused, and in both cases the car
// did NOT travel vGround × dt metres while the screen was frozen — charging it
// would empty a tank behind the player's back. Clamp rather than reject, so a
// slightly-over frame still bills the metres it really covered.
const DT_MAX = 0.1;

// Bumped by reset(); a car whose stamp does not match re-seeds on next read.
let _gen = 1;

/** The row for a kind, resolving aliases; unknown kinds get the Octavia. */
function specOf(kind) {
  const k = typeof kind === 'string' ? kind : '';
  return CARS[k] ?? CARS[ALIAS[k]] ?? CARS.octavia;
}

/** 'benzin' | 'nafta' | 'elektro' — what this kind takes at the pump. */
export function fuelTypeOf(kind) {
  return specOf(kind).fuel;
}

/** Tank capacity: litres, or kWh for the electric one. */
export function tankOf(kind) {
  return specOf(kind).tank;
}

// The car's stable identity, stamped once so it survives traffic.steal()
// nulling `ai` and survives the car being driven away from its stall. See
// WHERE THE FUEL IN A FOUND CAR CAME FROM for what each branch is worth.
function seedOf(car) {
  const s = car._fuelSeed;
  if (Number.isInteger(s)) return s;
  const ai = car.ai?.seed;
  const v = Number.isFinite(ai)
    ? (ai | 0)
    : hash32(Math.round(car.x * 2), Math.round(car.z * 2), S_SLOT);
  return (car._fuelSeed = v);
}

/**
 * Litres in this car's tank, seeded on first read.
 *
 * Lazy on purpose: nothing spawns a car through this module, so there is no
 * hook to seed at birth, and a car nobody ever opens must not cost a hash.
 */
export function levelOf(car) {
  if (!car) return 0;
  const v = car._fuel;
  if (car._fuelGen === _gen && typeof v === 'number' && v >= 0) return v;

  const spec = specOf(car.kind);
  const s = seedOf(car);
  // Triangular, not uniform: the mean of two independent draws piles the mass
  // around 0.55 of a tank and makes both extremes rare. 0.12 is the floor so
  // that a found car is never dead on the spot — being stranded should be
  // something you drove into, not something you opened a door into.
  const a = rnd01(hash32(s, S_LEVEL, 1));
  const b = rnd01(hash32(s, S_LEVEL, 2));
  car._fuelGen = _gen;
  return (car._fuel = spec.tank * (0.12 + 0.43 * (a + b)));
}

/** 0..1 — what a gauge needle should read. Clamped, so a corrupt tank cannot
 *  push a needle off its dial. */
export function frac(car) {
  if (!car) return 0;
  const f = levelOf(car) / specOf(car.kind).tank;
  return f > 0 ? (f < 1 ? f : 1) : 0;
}

/**
 * Spend the fuel this car used over `dt`. Call it for the car a human is
 * driving and for nothing else — an AI car is refused outright, and a parked
 * car simply never gets called.
 */
export function burn(car, dt) {
  if (!car || car.ai) return;              // traffic's own cars never burn
  if (!(dt > 0)) return;                   // NaN, 0 and negatives all land here

  // vGround is the honest speed including the sideways component; the |speed|
  // fallback covers a car that has not been through driveStep yet (a lot car
  // the player just climbed into on the very first frame).
  let v = car.vGround;
  if (!(v >= 0)) v = Math.abs(car.speed ?? 0);
  if (!(v > MOVING)) return;               // standing still is free — see header

  const d = v * (dt < DT_MAX ? dt : DT_MAX);
  // Positive acceleration only. Braking gives a negative _acc and is therefore
  // free, which is the point: you cannot lower a per-metre bill by driving
  // badly, only by driving fewer metres.
  const a = car._acc;
  const pen = a > 0 ? ACC_K * a : 0;
  const spec = specOf(car.kind);
  const used = spec.per100 * L_PER_M * d * (1 + (pen < ACC_CAP ? pen : ACC_CAP));

  const left = levelOf(car) - used;
  // `used` is finite by construction (v, d and pen are all guarded above), so
  // this comparison cannot be tricked into zeroing a tank by a NaN.
  car._fuel = left > 0 ? left : 0;
}

/**
 * Put fuel in. Returns how much ACTUALLY went in, which is what the pump
 * bills — a customer who asked for forty litres into a tank with room for six
 * pays for six. Pass Infinity for "fill it up".
 */
export function fill(car, amount) {
  if (!car || !(amount > 0)) return 0;
  const now = levelOf(car);
  const room = specOf(car.kind).tank - now;
  if (!(room > 0)) return 0;
  const put = amount < room ? amount : room;
  car._fuel = now + put;
  car._fuelGen = _gen;
  return put;
}

/** True when the engine has nothing left to run on. */
export function dry(car) {
  return !!car && levelOf(car) <= 0;
}

/**
 * Forget every tank. Used by a restart and by the dev console.
 *
 * There is no registry to walk — see the note at the end of the header — so
 * this bumps a generation and lets each car re-seed the next time anybody
 * asks. `_fuelSeed` is deliberately NOT cleared: a car's factory tank is a
 * property of that car, so the Fabia by the bridge comes back with the same
 * fumes it had before, which is what a reset is supposed to mean.
 */
export function reset() {
  _gen++;
}
