// ==========================================================================
// Vitals — the player's body. 100 HP, 100 of armour, and what the world is
// allowed to take off them.
//
// DEATH IS A FLAG IN THIS MODULE, NOT A GAME MODE. The obvious shape was
// `game.mode = 'wasted'`, and it is wrong: main.js:2484 gates the entire
// postprocess pass on `mode === 'play'`, so the moment the death card appeared
// the bloom, the god rays and the night street lamps would all switch off —
// the city would go flat and cheap for exactly the three seconds the player is
// staring hardest at it. So down() is a boolean here, the render path never
// learns about it, and main.js does the teleport, the hospital fee and the
// revive off the onDown callback.
//
// ---- THE DAMAGE MODEL, which is the whole file -------------------------------
//
// The rule this module works to: DO NOT INVENT PHYSICS. Everything that hurts
// you already happened inside somebody else's integrator, and the only honest
// job here is to read the impulse that integrator applied. Three shapes were
// tried and two of them were killed in review:
//
//   REJECTED — differentiate car.speed. car.speed is LONGITUDINAL BY CONTRACT
//   (vehicles.js:1558 says so at length, and a dozen consumers depend on it).
//   A car that arrives at a wall sideways out of a drift reports almost no
//   car.speed at all, so a 100 km/h broadside cost nothing while a gentle nose
//   tap cost real HP. This is precisely the bug vehicles.js:1697 had already
//   fixed for its own crunch — "a car arriving at a wall sideways out of a
//   drift used to hit it for free" — and re-introducing it one module later
//   would have been embarrassing.
//
//   REJECTED — one global "previous speed" for the player. It bills every
//   TRANSITION as a crash: step out of a car doing 30 m/s, walk two steps, sit
//   down in a parked one, and the next frame differences 30 against 0 and takes
//   most of your health for the crime of sitting down. Boarding, alighting,
//   swapping a car for the helicopter and stepping out of a Gripen are all the
//   same bug. The fix is that the sample is keyed on the VEHICLE IDENTITY: the
//   moment the thing you are riding is not the thing the sample was taken from,
//   the sample is thrown away and this step bills nothing at all.
//
//   REJECTED — read the engine's own accumulator, car.damage. It is the number
//   vehicles.js already computes from the same impacts, so differencing it
//   looks free. It also SATURATES: `Math.min(1.2, …)`. Once your car is a
//   wreck, its damage never rises again, so every subsequent impact would be
//   free and a player who had already crashed twice would be immortal in a
//   write-off. (It is also fed by explosions and gunfire, which are somebody
//   else's bill.)
//
//   KEPT — difference the velocity STATE the engine integrates, in the frame
//   the engine applies its impulses in, and subtract the acceleration the
//   machine could have produced by itself.
//
//        impulse = |Δv| − A_FREE · dt
//
//   A_FREE is what the vehicle can do with its own tyres/rotor/gravity. Below
//   it, the change is driving. Above it, something hit you. The threshold has
//   an enormous margin: the hardest the tyre model can pull is MU_MAX·g = 17.2
//   m/s² (vehicles.js:522), a wall hit dumps 60 % of the ground speed in a
//   SINGLE step, and at the 50 ms dt main.js clamps to those are 0.9 m/s and
//   15 m/s of Δv respectively. Nothing lives in the gap.
//
// WHICH FRAME, per machine, and why it is not the same frame for all three:
//
//   CAR — the BODY frame, (car.speed, car._lat). Every impulse vehicles.js
//   applies it writes into exactly those two scalars (1656–1657 for a car-car
//   shove, 1702 for a wall), and their magnitude is exactly the `impact` the
//   wall branch bills the car for at 1701. Differencing them as a 2-vector
//   therefore reads the engine's impulses and nothing else. The world frame
//   would have been worse: there the velocity vector also rotates with the
//   heading, so holding a drift would read as a permanent 10 m/s² impact.
//
//   HELICOPTER — the WORLD frame, (vx, vy, vz), because that is what
//   helicopter.js integrates and where it applies its wall rebound (462–465)
//   and its ground clamp (428). All three axes count: the machine's vertical
//   speed there is a real dynamic state, bounded by 9.81 m/s² down and 7.2 up
//   (THRUST_MAX at hover), so the ground killing 12 m/s of sink in one step is
//   unmistakable. Note that a HARD arrival deliberately leaves `airborne` true
//   (helicopter.js:439 — "that was an arrival, not a landing"), so a rule built
//   on the landing flag would have missed the one case that should hurt most.
//
//   CAR, VERTICALLY — not differenced, on purpose. A grounded car's `_vy` is
//   not a dynamic state, it is a kinematic constraint: "the ground writes the
//   vertical speed" (vehicles.js:1853), clamped to ±VY_MAX = 9. Clipping a kerb
//   at speed therefore swings _vy by most of that range inside one step with
//   nothing having been hit, and differencing it billed kerbs as crashes. The
//   car's fall is billed off the engine's OWN gate instead: it was airborne for
//   longer than 0.12 s (the same floor vehicles.js:1845 uses to decide the
//   springs made a thump) and now it is not.
//
//   JET — vertical only, and this one is a limitation stated out loud rather
//   than a design. aircraft.js has NO lateral collision model whatsoever: the
//   Gripen flies through buildings, and its horizontal velocity is steered by a
//   lag filter that can swing the vector by tens of m/s in a step with nothing
//   touched (AOA_LIFT, aircraft.js:424), so there is neither anything to bill
//   nor a safe way to bill it. What it does have is a touchdown — `y <= ground`
//   at aircraft.js:472 — and the sink rate at that moment is the honest number.
//   That covers the case the brief cares about: augering a Gripen in at 690 m/s
//   carries hundreds of m/s of sink and is instantly fatal, rather than costing
//   nothing while a kerb strike costs 18 HP.
//
// WHAT I COULD NOT REACH, said loudly. vehicles.js computes the exact scalar
// this module wants — `const impact = …` at vehicles.js:1701 — and then throws
// it away; it is a local, published nowhere. The one-line honest fix is for
// vehicles.js to hang `car.lastImpact` on the car in the frame it hits
// something, and this module to read it. That file is owned elsewhere in this
// run, so it is not touched here: instead the same quantity is reconstructed
// from the two fields the engine DOES publish and that its own `impact` is
// literally built from. car.vGround (1565) is that magnitude, but a magnitude
// is the wrong object — a scalar cannot tell "lost 12 m/s into a wall" from
// "12 m/s of it moved from longitudinal to lateral", so the two components are
// differenced as a vector rather than their published length.
//
// A TELEPORT IS NOT A CRASH. Terrain arriving late drops a car through the
// world and vehicles.js re-seats it (the `jumped` branch, 1825); respawns and
// chunk loads move bodies metres per step. Every rule below therefore refuses
// to bill a fall that did not actually go DOWNWARD, and the sample is dropped
// outright whenever the numbers stop being finite. Being wrong here is cheap in
// one direction (a missed bill) and unforgivable in the other (dying because a
// chunk streamed in).
//
// DETERMINISM. There is none to break: your body is yours alone. No state in
// this file is shared, nothing here is a function of the world seed, and two
// clients are SUPPOSED to disagree about your HP — the wire carries positions,
// not wounds. Local divergence is not merely survivable here, it is the design.
//
// PER-FRAME COST. Two preallocated sample records, reused forever; no array,
// object or closure literal on any path update() touches. update() may be
// called several times per rendered frame (main.js clamps dt to 50 ms and
// loops) and each call is one physics step: a repeated call with an unchanged
// world differences to zero, which is the correct answer.
//
// NO IMPORTS. The contract permits ./prices.js and nothing else, and this file
// takes nothing at all: the body does not spend money. The hospital fee belongs
// to whoever handles onDown — it is charged through wallet.js after the fade,
// not by the wall. Importing a price list to use none of it would only couple
// this module to key names it never reads. Headless-clean by construction: no
// DOM, no WebGL, no clock, no three.js.
// ==========================================================================

// ---- the body ------------------------------------------------------------
const HP_MAX = 100;
const ARMOUR_MAX = 100;

// ---- what counts as an impact --------------------------------------------
// m/s² the machine can produce without hitting anything. Cars: MU_MAX·g = 17.2
// is the tyre model's ceiling (vehicles.js:521-522), plus the handbrake scrub
// and the low-speed kinematic pull, so 20 with room to spare. Aircraft: the
// helicopter's vertical authority is gravity down and THRUST_MAX − g = 7.2 up,
// its horizontal is ACC_TILT = 8.5 plus SKID_MU = 6 on the deck; 20 covers all
// of it. Both numbers only matter for a long dt — at main.js's 50 ms clamp they
// are worth under 1 m/s, an order below the injury floors.
const A_FREE_CAR = 20;
const A_FREE_AIR = 20;

// Injury curve, one shape for everything: nothing below `free`, exactly HP_MAX
// at `fatal`, quadratic between (energy goes as v², and a linear ramp made
// every small knock sting while every big one felt identical). It is NOT capped
// at HP_MAX — a lethal impact must go through armour as well, or a vest would
// be a second life rather than a cushion. What that buys, measured: 180 km/h
// into a wall spends the whole vest AND leaves you at 84 HP (hurt, alive, no
// armour); 280 km/h charges 336 points, which is through the vest and through
// the body. A vest is a crash you get to walk away from, not a crash that did
// not happen — and it is not a fatality you can buy your way out of.
const DMG_CAP = 400;

// A car: belt, crumple zone, a cage. 6 m/s of delta-v (21 km/h) is the
// no-injury band real crash data draws, and 28 m/s (100 km/h) in a single hit
// is the end of it. Calibrated against the engine, which SCRUBS rather than
// stops — a 90 km/h wall hit keeps 40 % of the speed (vehicles.js:1702), so its
// delta-v is 15 m/s. Measured at 60 fps: 50 km/h into a wall costs 0.8 HP,
// 90 km/h costs 15.5, 130 km/h costs 48.6 — two of those and you are gone —
// and 180 km/h kills outright. The same 90 km/h arriving SIDEWAYS costs 25.8,
// because the lateral scrub is harsher (×0.3, not ×0.4) and because there is a
// door where the bonnet should be.
const HIT_FREE = 6, HIT_FATAL = 28;
// Landing that car after a jump. The springs eat the first part of it —
// vehicles.js only calls it a thump past 2 m/s and saturates its squat at 9 —
// so the cabin gets a higher floor than the walls do, and the same lethal sink
// as a fall on foot.
const LAND_FREE = 8, LAND_FATAL = 26;
// Aircraft are the fragile ones and should be: no belt worth the name, no
// crumple zone, a fuel tank overhead. A 3 m/s set-down is free by construction
// (helicopter.js clamps anything gentler than HARD_VS), 10 m/s of sink costs
// 18 HP, and 18 m/s — 65 km/h straight down — is fatal.
const AIR_FREE = 4, AIR_FATAL = 18;
// On foot, under the game's 21 m/s² gravity (player.js:59): 9 m/s is a 1.9 m
// drop and free, 15 m/s (5 m, a first-floor window) costs 13, 20 m/s (9.5 m)
// costs 41, and 26 m/s — a 16 m fall, five storeys — kills outright.
const FALL_FREE = 9, FALL_FATAL = 26;

// The engine's own airborne gate, so "was the car flying" means here exactly
// what it means at vehicles.js:1845 and the two can never drift apart.
const CAR_AIR_MIN = 0.12;
// A landing has to have gone downward. Slack is generous because the sample
// straddles one physics step either side of touchdown; anything that ROSE was
// re-seated, not landed.
const DROP_EPS = -0.25;

// ---- regeneration --------------------------------------------------------
// A slow trickle back to a FLOOR, not to full. Reasoning: there are no medkits
// in this game yet, so with no regeneration at all one unlucky kerb in the
// first minute leaves you at 12 HP for the rest of the session with reloading
// the page as the only cure — and reloading the page is not a game mechanic.
// Full regeneration is the opposite failure: it makes every crash free, which
// deletes the reason to drive well. So the body walks off a scrape and nothing
// more. Above the floor you stay hurt until something heals you, which is what
// gives the hospital a job. Armour never comes back — it is bought, not grown.
const REGEN_FLOOR = 50;      // HP the body will climb back to on its own
const REGEN_RATE = 1.6;      // HP/s — 0 → floor takes about half a minute
const REGEN_CALM = 8;        // s of not being hurt before it starts

// Reviving hands the bar back full and the vest back empty: the wreck took the
// armour with it, and a hospital that returned you fully kitted would make the
// armour shop pointless.
const REVIVE_HP = HP_MAX;

// ---- causes, Czech, because they end up on a death card ------------------
// Passed to damage() and forwarded to onDown listeners, which is the only
// place they surface. Lower case nouns: the caller capitalises for the card.
const C_HIT = 'náraz';
const C_LAND = 'tvrdý dopad';
const C_CRASH = 'havárie';
const C_FALL = 'pád';
const C_OTHER = 'zranění';

// ---- state ---------------------------------------------------------------
let _hp = HP_MAX;
let _armour = 0;
let _down = false;
// The module's own monotonic clock, in seconds of stepped game time, and the
// ABSOLUTE deadline the regeneration waits for — never a countdown, for the
// reason js/chatter.js's header sets out: a countdown nobody ticks is a silent
// bug that every test still passes. The deadline and the healing ride the same
// clock on purpose, so a clock that stops (paused, hidden tab, no update() at
// all) stops both. The failure mode of this design is "no regeneration"; the
// failure mode of a wall clock would have been "alt-tab for a minute and come
// back healed", which is a cheat rather than an inconvenience.
let _now = 0;
let _calmAt = 0;

const _downFns = [];
const _reviveFns = [];

// ---- samples -------------------------------------------------------------
// Two records, allocated once at module load and rewritten in place forever.
// `veh` is the IDENTITY the sample was taken from: the instant it stops
// matching what you are riding, the sample is void and this step bills nothing.
// That single check is what stops boarding, alighting and swapping machines
// from being billed as collisions.
const RIDE_NONE = 0, RIDE_CAR = 1, RIDE_HELI = 2, RIDE_JET = 3;

const _ride = { veh: null, kind: RIDE_NONE, vx: 0, vy: 0, vz: 0, air: 0, y: 0 };
const _foot = { valid: false, grounded: true, vy: 0, y: 0 };
const _s = { vx: 0, vy: 0, vz: 0, air: 0, y: 0 };   // scratch for one reading
const _noCtx = Object.freeze({});

// ---- helpers -------------------------------------------------------------
// Missing is 0 (vehicles.js reads its own optional fields as `?? 0` and a
// hand-built test car arrives without half of them); anything present but not
// finite becomes NaN and poisons the finiteness check below, which throws the
// whole sample away rather than billing a crash for a corrupt number.
const nz = (v) => (v === undefined || v === null ? 0 : +v);

/** HP for an impact of `v` m/s. 0 below `free`, HP_MAX at `fatal`, quadratic
 *  between, and it keeps climbing past that so armour cannot soak a fatality. */
function curve(v, free, fatal) {
  if (!(v > free)) return 0;
  const k = (v - free) / (fatal - free);
  const d = HP_MAX * k * k;
  return d > DMG_CAP ? DMG_CAP : d;
}

/** Which machine is this? The same ducks player.js:78-79 uses, and for the
 *  same reason: main.js keeps game.car / game.heli / game.jet in three slots,
 *  but player.inCar holds whichever one you actually sat in, so a helicopter
 *  can and does arrive through a field called `car`. Classify the object, never
 *  the slot it came in. */
function classify(v) {
  if (!v || typeof v !== 'object') return RIDE_NONE;
  if (v.rotorSpeed !== undefined) return RIDE_HELI;
  if (v.throttle !== undefined && v.reheat !== undefined) return RIDE_JET;
  return RIDE_CAR;
}

/** Read the velocity state of `veh` into _s. false = unreadable, drop it. */
function readRide(veh, kind) {
  if (kind === RIDE_CAR) {
    // BODY frame: longitudinal and lateral, the two scalars every impulse in
    // vehicles.js is written into. _vy is read but only the landing rule uses
    // it — see the header on why a grounded car's vertical is not differenced.
    _s.vx = nz(veh.speed); _s.vz = nz(veh._lat); _s.vy = nz(veh._vy);
    _s.air = nz(veh.air);
  } else if (kind === RIDE_HELI) {
    _s.vx = nz(veh.vx); _s.vy = nz(veh.vy); _s.vz = nz(veh.vz);
    _s.air = veh.airborne ? 1 : 0;
  } else {
    // Jet: vertical only. aircraft.js has no lateral collision model at all.
    _s.vx = 0; _s.vz = 0; _s.vy = nz(veh.vy);
    _s.air = veh.airborne ? 1 : 0;
  }
  _s.y = nz(veh.y);
  // One check for all of them: NaN and ±Infinity both poison the sum.
  return Number.isFinite(_s.vx + _s.vy + _s.vz + _s.air + _s.y);
}

/** _s → _ride, tagged with the identity it came from. */
function keepRide(veh, kind) {
  _ride.veh = veh; _ride.kind = kind;
  _ride.vx = _s.vx; _ride.vy = _s.vy; _ride.vz = _s.vz;
  _ride.air = _s.air; _ride.y = _s.y;
}

function forgetRide() { _ride.veh = null; _ride.kind = RIDE_NONE; }

// ---- the two rules -------------------------------------------------------

function trackRide(veh, kind, dt) {
  if (kind === RIDE_NONE || !readRide(veh, kind)) { forgetRide(); return; }
  // A different machine — or the same slot holding a different object after a
  // respawn — is a fresh baseline and nothing else. THE transition fix.
  if (veh !== _ride.veh || kind !== _ride.kind) { keepRide(veh, kind); return; }

  if (kind !== RIDE_JET) {
    // Δv of the integrated velocity state, minus what the machine could have
    // done to itself in this step. The helicopter's vertical is part of the
    // vector; a car's is deliberately not (header).
    const dx = _s.vx - _ride.vx;
    const dz = _s.vz - _ride.vz;
    const dy = kind === RIDE_HELI ? _s.vy - _ride.vy : 0;
    const air = kind === RIDE_HELI;
    const free = (air ? A_FREE_AIR : A_FREE_CAR) * dt;
    const imp = Math.sqrt(dx * dx + dy * dy + dz * dz) - free;
    if (imp > 0) {
      const d = air ? curve(imp, AIR_FREE, AIR_FATAL) : curve(imp, HIT_FREE, HIT_FATAL);
      if (d > 0) damage(d, air ? C_CRASH : C_HIT);
    }
  }

  // Touchdown, for the two machines whose vertical is not in the vector above.
  // The sink rate is the PREVIOUS sample's: by the time we see the landing both
  // engines have already zeroed it (vehicles.js:1857, aircraft.js:474). That
  // costs at most one step of gravity — under 0.5 m/s — and under-bills, which
  // is the direction to be wrong in.
  if (kind === RIDE_CAR) {
    if (_ride.air > CAR_AIR_MIN && _s.air <= 0 && _ride.y - _s.y > DROP_EPS) {
      const d = curve(-_ride.vy, LAND_FREE, LAND_FATAL);
      if (d > 0) damage(d, C_LAND);
    }
  } else if (kind === RIDE_JET) {
    if (_ride.air > 0 && _s.air <= 0 && _ride.y - _s.y > DROP_EPS) {
      const d = curve(-_ride.vy, AIR_FREE, AIR_FATAL);
      if (d > 0) damage(d, C_CRASH);
    }
  }

  keepRide(veh, kind);
}

/** Falls, on foot. The landing frame is the only one that costs anything, and
 *  the speed it costs is the one from the step before it: player.js:220 sets
 *  vy = 0 and grounded = true together, so by the time the landing is visible
 *  the number that caused it is gone. Sampling every step keeps it. */
function trackFoot(p) {
  if (!p) { _foot.valid = false; return; }
  const y = nz(p.y), vy = nz(p.vy);
  const grounded = p.grounded !== false;
  if (!Number.isFinite(y + vy)) { _foot.valid = false; return; }
  if (_foot.valid && grounded && !_foot.grounded) {
    // …and it has to have gone DOWN. A support arriving above your feet snaps
    // you up onto it and grounds you (player.js:215) with a big negative vy
    // still on the books — a chunk streaming in, not a fall.
    if (_foot.y - y > DROP_EPS) {
      const d = curve(-_foot.vy, FALL_FREE, FALL_FATAL);
      if (d > 0) damage(d, C_FALL);
    }
  }
  _foot.valid = true; _foot.grounded = grounded; _foot.vy = vy; _foot.y = y;
}

function fire(list, arg) {
  for (let i = 0; i < list.length; i++) {
    // A listener that throws must not take the body with it. player.js:144-152
    // is the cautionary tale: one TypeError raised inside stepGame froze co-op
    // on the last drawn frame, every frame, for as long as it kept being
    // raised. A death card that fails to open is a bug; a dead renderer is a
    // dead game.
    try { list[i](arg); } catch (e) { console.warn('[vitals] listener:', e); }
  }
}

// ---- public ---------------------------------------------------------------

/** Current health. A float on purpose — the bar wants the fraction. A caller
 *  PRINTING it should use Math.ceil, not Math.round: anything above 0 is alive
 *  and "0 HP" over a living body is the oldest bug in the genre. */
export function hp() { return _hp; }
export function hpMax() { return HP_MAX; }
export function armour() { return _armour; }
export function down() { return _down; }

/**
 * Take `n` HP off the body, armour first. `cause` is a short Czech noun that
 * rides along to the onDown listeners; anything is accepted, nothing is parsed.
 * No-op while down — the dead do not get deader, and firing onDown twice would
 * charge two hospital bills for one crash.
 */
export function damage(n, cause) {
  if (_down) return;
  const d = Number.isFinite(n) ? n : 0;      // a corrupt number is not an injury
  if (d <= 0) return;
  _calmAt = _now + REGEN_CALM;               // absolute deadline, never a timer
  let rest = d;
  if (_armour > 0) {
    const eaten = _armour < rest ? _armour : rest;
    _armour -= eaten; rest -= eaten;
  }
  if (rest <= 0) return;
  _hp -= rest;
  if (_hp > 0) return;
  _hp = 0;
  _down = true;                              // set BEFORE the callbacks, so a
  fire(_downFns, cause || C_OTHER);          // listener may revive() re-entrantly
}

/** Heal, up to the cap. Ignored while down: coming back is revive()'s job, and
 *  a heal that quietly resurrected you would leave every onRevive listener —
 *  the death card among them — believing you were still dead. */
export function heal(n) {
  if (_down) return;
  const d = Number.isFinite(n) ? n : 0;
  if (d <= 0) return;
  _hp = _hp + d > HP_MAX ? HP_MAX : _hp + d;
}

export function addArmour(n) {
  const d = Number.isFinite(n) ? n : 0;
  if (d <= 0) return;
  _armour = _armour + d > ARMOUR_MAX ? ARMOUR_MAX : _armour + d;
}

/**
 * One physics step of the body. ctx = { car, heli, jet, player, onFoot }, all
 * optional; a missing player simply means falls are not billed this step.
 * Safe to call several times per rendered frame — each call is one step, and a
 * repeated call over an unchanged world differences to zero.
 */
export function update(dt, ctx) {
  // Defensive: a NaN dt would poison the clock permanently. 0.25 is five times
  // main.js's own 50 ms clamp — past that the caller is a debugger, not a frame.
  const step = Number.isFinite(dt) && dt > 0 ? (dt > 0.25 ? 0.25 : dt) : 0;
  _now += step;
  const c = ctx || _noCtx;
  // First non-null wins, then the object is classified by what it IS. onFoot,
  // when the caller states it, is authoritative: it is the only thing that can
  // tell "stepped out and game.car is stale" from "still sitting in it".
  const onFoot = c.onFoot !== undefined ? !!c.onFoot : false;
  const veh = onFoot ? null : (c.jet || c.heli || c.car || (c.player && c.player.inCar) || null);
  trackRide(veh, classify(veh), step);
  trackFoot(onFoot || !veh ? c.player : null);
  regen(step);
}

function regen(dt) {
  // Cannot tick while down — three separate reasons, and any one of them alone
  // would do: the dead do not heal, _hp climbing off 0 would contradict down(),
  // and a body that healed past the floor while the death card was up would
  // stand up mid-animation.
  if (_down || dt <= 0) return;
  if (_hp >= REGEN_FLOOR || _now < _calmAt) return;
  const v = _hp + REGEN_RATE * dt;
  _hp = v > REGEN_FLOOR ? REGEN_FLOOR : v;
}

/** fn(cause) — cause is the Czech noun from the killing damage() call. */
export function onDown(fn) { if (typeof fn === 'function') _downFns.push(fn); }
export function onRevive(fn) { if (typeof fn === 'function') _reviveFns.push(fn); }

/**
 * Back on your feet: full health, no vest, and every sample voided. The voiding
 * is not housekeeping — the caller teleports the body (and possibly its car)
 * before calling this, and a stale sample would bill the teleport as the crash
 * that killed you all over again.
 */
export function revive() {
  if (!_down) return;
  _down = false;
  _hp = REVIVE_HP;
  _armour = 0;
  _calmAt = _now;
  forgetRide();
  _foot.valid = false;
  fire(_reviveFns, null);
}

/**
 * New game, or a dev key. Resets the BODY and not the subscriptions: main.js
 * registers onDown once at boot, and quietly unhooking the death handler on a
 * restart would leave the player at 0 HP with the game still running.
 */
export function reset() {
  _hp = HP_MAX;
  _armour = 0;
  _down = false;
  _now = 0;
  _calmAt = 0;
  forgetRide();
  _foot.valid = false;
}
