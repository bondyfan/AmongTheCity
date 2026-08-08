// ==========================================================================
// Combat — fists, and the money that falls out of people
//
// WHY THERE ARE NO GUNS IN HERE, AND THIS IS THE FIRST THING THE FILE SAYS.
// The original design was a weapon system: a pistol, a magazine, a hitscan
// trace. The review killed the firearm half outright and the arithmetic is the
// reason. A trace is resolved by walking the world in 1.2 m bites the way
// js/weapons.js walks a rocket (weapons.js:12, "at 210 m/s a 60 Hz frame covers
// 3.5 m, which is enough to fly clean through a wall panel") — except a bullet
// is instantaneous, so the whole 110 m of it has to be walked inside ONE frame:
// 92 steps, each one a query against the chunk index, per shot, on a path the
// player is encouraged to spam. Then the same trace has to be run again against
// the crowd, and again against the cars, and a miss costs exactly as much as a
// hit. And after all that the feature is still only as good as its feedback,
// which is muzzle flash, tracers, ricochet decals and recoil — none of which
// exists yet either.
//
// A melee layer that is genuinely good is worth more than a shooting one that
// is rushed. Everything here is short-range, so the search radius is 1.5 m and
// the "trace" is one distance test; there is no projectile, nothing to
// integrate, nothing to sub-step, and no new draw call anywhere in the file.
// What that buys is the budget to get the FEEL right — a swing with a real
// window in it, a three-hit ladder, an input buffer, an arc generous enough to
// connect with somebody who is walking away — which is the half of a fighting
// system players actually judge it on. Guns come back when somebody can afford
// to do the trace properly, and when they do, they add a second verb to this
// file rather than replacing it: aimPose/handsPose already exist in
// js/citizen.js for exactly that.
//
// ---- THE SWING IS THREE DEADLINES, NEVER A COUNTDOWN ----------------------
//
// One attack is 0.35 s long and it has a hole in the middle where the damage
// lives:
//
//     0.00 s   strike() accepted. The arm draws back, the body turns into it
//              (aimLock), and the pose starts running through player.combatPose
//     0.12 s   the window OPENS — every step from here scans for a victim
//     0.22 s   the window SHUTS — a swing that found nobody is a whiff
//     0.35 s   recovery over; the next strike may start
//    +0.10 s   …and a HELD attack button waits this much longer than a tapped
//              one, so a phone (input.touchAttack is a held flag) can fight
//              without being faster than a keyboard
//     1.10 s   the combo window: land a blow later than this on the same person
//              and the ladder starts again at the first punch
//
// All five are ABSOLUTE times against this module's own clock, never
// countdowns, for the reason js/chatter.js's header spends forty lines on: a
// countdown that some path forgets to tick is a silent bug that every test
// still passes. There is nothing here to forget — update() advances one clock
// and every question in the file is a comparison against it.
//
// The clock is LOCAL and accumulated from dt, exactly as js/vitals.js's is, and
// deliberately not worldT(): a swing must live in game time. A tab that is
// hidden mid-punch, or a debugger stopped on a breakpoint, must not come back
// to a fist that has already landed on a world that moved on without it. dt is
// clamped to 0.25 s (five times main.js's own 50 ms clamp) so one enormous step
// cannot skip the entire window between two calls.
//
// stepGame(dt) runs several times per rendered frame, so every one of those
// comparisons has to be idempotent. The window is scanned on EVERY step it is
// open for, but `_landed` is spent once — a swing gets exactly one victim
// however many times it is stepped, and three calls in one frame produce one
// punch, not three.
//
// ---- THE LADDER, AND WHY THESE NUMBERS -----------------------------------
//
// A pedestrian has 100 HP (js/pedestrians.js, `p.hp`). Three blows:
//
//     rung 1   34   right fist   a flinch
//     rung 2   34   left fist    a flinch
//     rung 3   40   a kick       THROWN — launch, spin, off their feet
//                                                          ---
//                                                          108
//
// Two punches is 68 and leaves somebody standing, hurt and running: that is the
// mugging that does not become a killing, and it is the common case. The third
// is the one that ends it, and it is 40 rather than the 32 that would suffice
// so that "three hits and they go down" is a property of THIS file's arithmetic
// and not of an exact-equality boundary in somebody else's — a ladder that
// summed to exactly 100 would depend on whether hurt() tests `<= 0` or `< 0`.
// The margin also means somebody who has already been clipped by a wing mirror
// dies in two, which is the right kind of emergent.
//
// THE LADDER BELONGS TO THE FIGHT, NOT TO THE BUTTON. `_step` counts the blows
// the CURRENT victim has taken; walk away, or turn and hit somebody else, and
// it starts again. Without that, punching two people once each and a third
// person once would kill the third with a single kick, which is not a combo,
// it is a bug that looks like a feature until somebody notices.
//
// A swing's rung is fixed when the swing STARTS, because that is when the
// animation has to be chosen. So a finisher that lands on a stranger really
// does kick the stranger — a kick is a kick whoever catches it — and their own
// ladder then continues from one blow taken. Every path still reaches three
// blows and a body.
//
// WHY THE ARC IS THE SOFT LOCK. Strictly, a fist reaches about 0.70 m past the
// player's centre (0.59 m of arm at PLAYER_SCALE plus half a torso) and a body
// is 0.2 m thick, so honest contact is 0.9 m. At 0.9 m you whiff at anything
// that is not standing perfectly still, because a walker does 1.3 m/s and the
// window is a tenth of a second. So the reach is 1.5 m and the arc is ±50°,
// and THAT generosity is the aim assist — the alternative, turning the body
// toward the nearest target, was rejected because it fights player.aimLock,
// which by contract drives the heading to camYaw for as long as it is set. Two
// systems steering one heading is how a character ends up facing neither way.
//
// ---- MONEY, AND THE WALL CLOCK THAT IS NOT IN IT --------------------------
//
// What is in somebody's pocket is a pure function of their pid and nothing
// else. The first design folded in a quarter-hour bucket "so the same person
// cannot be farmed", and that rationale is simply false: js/pedestrians.js
// retires every identity on TRIP_T = 420 s, so a pid is at most seven minutes
// of the same wallet, and there is no body in the game that outlives its own
// seed. What the bucket WOULD have done is change the contents of a man's
// pockets while you were standing in front of him, and make two players in one
// room disagree about the same corpse — for a defence against an attack the
// generation clock already handles.
//
// So: hash the seed, and only the seed. Two clients rob the same body for the
// same koruny, a test can assert an exact figure, and nothing in here reads a
// clock at all. The shape of the distribution comes from js/prices.js —
// "A pocket is 40 Kč far more often than it is 900", `fat` = 0.06 of people
// carrying real cash — and it is deliberately calibrated to that file's own
// claim that a robbed pocket averages ~130 Kč, twelve of them to a tank:
//
//     94 %   40 + 189·u²      → 40–229 Kč, piled hard against the floor
//      6 %   242 + 658·u      → 242–900 Kč, the pensioner off to pay in cash
//     mean   131 Kč           (measured: 130,7 over 200 000 pids, min 40, max
//                              900, 5,8 % of them fat)
//
// The squared draw in the lean branch is what makes forty koruna the normal
// answer; a uniform 40–900 would have made every third pocket a payday and
// stopped meaning anything by the tenth, which is the same argument js/fuel.js
// makes for its triangular tank.
//
// It is collected on the KILLING BLOW and credited through the wallet handed to
// the constructor. `_robbed` is stamped on the body so nothing can pay twice.
// There is no pickup animation and no dropped-cash prop: the wallet's own
// onChange already carries (balance, delta, 'kapsa') to the HUD, so the feedback
// is a ticker in the corner that costs this file nothing.
//
// ---- EVERYTHING GOES THROUGH peds.hurt() ---------------------------------
//
// Not one line in this file writes a pedestrian's velocity, state, position or
// health. A fist, a bullet and a Škoda all arrive at the same door, and the
// ragdoll, the blood, the panic, onPedHit and onPedKilled are all on the far
// side of it — which is why a punch makes the street react without this module
// knowing that js/chatter.js exists.
//
// That is also why `chatter` is accepted by the constructor and never called.
// The reaction path is peds.hurt() → onPedHit/panic → main.js → chatter, and it
// is already wired for the car that ran somebody over; calling chatter from
// here as well would put two lines through a 0.85 s global reaction floor
// (chatter.js:107) and the one that got dropped would be the one the crowd
// already had. The reference is held because the constructor signature is
// fixed and a later verb may want it — a mugging that needs somebody to say
// "dej sem tu tašku" — not because this pass forgot to use it.
//
// SOUND is two names, `punch_swing` and `punch_hit`, and they are a REQUEST to
// whoever owns the sound generator, in the same spirit as pedestrians.js's
// request to citizen.js. Neither exists on disk today, so audio.js does what it
// does for every missing sample — one 404 per name for the whole session, then
// silence — and the fist still lands, the crowd still screams (that one is
// main.js's, off onPedHit) and nothing anywhere throws.
//
// ---- WHAT IS LOCAL, AND WHY THAT IS FINE ---------------------------------
//
// WHO you punch is local, and it has to be: js/pedestrians.js's header already
// states that being run over is local and that a hit body is released from its
// slot into this tab's ownership. A fist is the same event with a shorter
// range. What IS shared is the only thing that has to be — what was in their
// pocket, which is a function of the world seed and would compute the same on a
// machine that never saw the punch.
//
// The crowd cannot fight back. There is no block, no counter, no pedestrian
// that decides it has had enough and swings at you; a punched citizen flinches,
// panics and runs, which is pedestrians.js's existing behaviour and nothing
// more. That is a stated gap, not an oversight — a crowd that fights needs a
// per-body AI state machine and a reason for the player to ever lose one, and
// neither is in this pass.
//
// ---- DEPENDENCIES AND COST ------------------------------------------------
//
// One import: js/prices.js, which imports nothing itself. peds, chatter, wallet
// and audio all arrive through the constructor and every one of them may be
// null. No three.js, no DOM, no renderer, no clock — the whole file loads and
// runs under `node --test`, and the pedestrian search is handed in, so a test
// can drive a fight against three plain objects.
//
// Nothing on a per-step path allocates. The blow record is ONE object rewritten
// in place for the life of the process (which means peds.hurt() must READ it,
// never keep it — see the note on _blow), the search predicate is one closure
// bound in the constructor that reads scratch fields off `this`, and the pose
// callback handed to player.combatPose is likewise bound once. update() on an
// idle frame is four comparisons and a subtraction.
// ==========================================================================

import { PRICE } from './prices.js';

// Byte-identical to the hash in js/pedestrians.js, js/traffic.js, js/chatter.js
// and js/fuel.js, and duplicated for the reason every one of them states in its
// own header: the deterministic layers of this game must be pure functions of
// the same integers, and a shared import that somebody later "optimises" would
// silently re-roll the world. Only imul, xor and shift — nothing two engines
// can disagree about. A non-integer argument becomes 0 through `| 0` rather
// than poisoning the result with NaN.
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

// Salts. The 0xca5x block is unused by every other file that hashes:
// js/pedestrians.js burns 0xc17, 0x5eed, 0x1d3 and 0x51, js/traffic.js the
// small integers and 0xb17, js/chatter.js and js/people.js the 0x76xx block,
// js/fuel.js 0xf0ex. A pocket can therefore never accidentally be a jacket
// colour or a fuel level drawn from the same seed.
const S_CASH = 0xca51;      // which kind of pocket this is
const S_DRAW = 0xca52;      // …and how much is in it

// ---- the swing, in seconds ------------------------------------------------
// See THE SWING IS THREE DEADLINES for what each one buys.
const SWING_T = 0.35;       // one attack, start to recovered
const OPEN_T = 0.12;        // the damage window opens…
const SHUT_T = 0.22;        // …and closes. 0.10 s ≈ six steps at 60 fps
const BUFFER_T = 0.12;      // a press this close to the end is remembered, not
                            // eaten — without it every mashed second punch
                            // vanishes and the ladder feels broken, which is
                            // the oldest complaint there is about melee
const REPEAT_GAP = 0.10;    // extra rest between HELD swings (see the header)
const COMBO_T = 1.10;       // how long a fight stays the same fight
const MAX_DT = 0.25;        // vitals.js's clamp, for vitals.js's reason

// ---- reach ----------------------------------------------------------------
const REACH = 1.5;                       // m, centre to centre — see WHY THE
const REACH2 = REACH * REACH;            // ARC IS THE SOFT LOCK
const ARC_COS = 0.64;                    // cos 50° — a ±50° cone in front
// Feet-to-feet. A kerb is 0.15 m and a storey is 3 m, so this separates a
// walker on the pavement below a bridge deck from one you can actually reach
// without pretending to know anything about the terrain. Both sides of the
// comparison are FEET height: p.mesh.position.y is where pedestrians.js puts
// the body (ground + p.y), and player.y is the walk controller's own support
// height. A body with no mesh (a headless test) simply skips the test.
const MAX_DY = 1.4;

// ---- sound ----------------------------------------------------------------
const SFX_SWING = 'punch_swing';
const SFX_HIT = 'punch_hit';
const SFX_R = 60;           // m — a fist is not a car horn

// ---- money ----------------------------------------------------------------
const POCKET = PRICE.job.pocket;
const P_MIN = POCKET.min;                       // 40 Kč
const P_SPAN = POCKET.max - POCKET.min;         // 860 Kč of range
const P_FAT = POCKET.fat;                       // 0.06 carry real cash
// Where the two bands sit inside that range, as fractions of it, so the shape
// survives somebody re-tuning min and max in js/prices.js. LEAN_K is the top of
// the ordinary pocket and FAT_K the bottom of the fat one; the sliver between
// them exists only so the two bands cannot produce the same figure by two
// different routes, which would be invisible to a player and confusing in a
// test. See the table in the header for the mean these produce.
const LEAN_K = 0.22;
const FAT_K = 0.235;
// What the wallet's ticker says. Czech, because it reaches the player's eyes.
const LOOT_LABEL = 'kapsa';

// ---- the ladder -----------------------------------------------------------
// Frozen for the reason js/prices.js freezes its table: a "temporary" tweak
// written from a handler is a tweak nobody can find again, and an ES module is
// strict mode, so a write here THROWS at the scene of the crime.
//
// `arm` follows js/citizen.js's punchPose contract (0 = left, 1 = right) and
// alternates so a combo reads as a combo. `push` is metres per second along the
// strike direction; the flinches get a shove that hurt() may or may not spend,
// the kick gets a real launch. `spin` is for _throw's tumble and is ignored by
// anything that does not read it.
const LADDER = Object.freeze([
  Object.freeze({ dmg: 34, kick: 0, arm: 1, launch: false, push: 1.6, vy: 0, spin: 0, cause: 'pěst' }),
  Object.freeze({ dmg: 34, kick: 0, arm: 0, launch: false, push: 1.8, vy: 0, spin: 0, cause: 'pěst' }),
  // The finisher. 5.6 m/s and 3.0 up against pedestrians.js's GRAV = 18 is
  // about 0.35 s of air and a metre and a half of slide before SLIDE_FRICTION
  // takes it — they land at your feet, not in the next street. A car doing 60
  // throws them four times as far, and it should.
  Object.freeze({ dmg: 40, kick: 1, arm: 0, launch: true, push: 5.6, vy: 3.0, spin: 4.5, cause: 'kopanec' }),
]);

// The two crime keys, spelled without diacritics ON PURPOSE. They are KEYS
// crossing a module boundary into js/wanted.js, not display text — the accented
// Czech noun that reaches the HUD is that file's business, and a key that has
// to survive a copy-paste through four editors should not depend on a háček.
const CRIME_FIGHT = 'rvacka';
const CRIME_KILL = 'zabiti';

const NO_CTX = Object.freeze({});

/**
 * How much cash this pedestrian is carrying, in whole koruny — a pure function
 * of their pid and of js/prices.js, with no clock anywhere in it.
 *
 * Exported so that the mugging verb, a test, and anything that ever wants to
 * show the number before it takes it all get the SAME answer from the same
 * place. A body with no usable pid (a hand-built test object) hashes as 0
 * rather than returning NaN into somebody's wallet.
 */
export function pocketOf(pid) {
  const id = Number.isInteger(pid) ? pid : 0;
  const u = rnd01(hash32(id, S_DRAW));
  const k = rnd01(hash32(id, S_CASH)) < P_FAT
    ? FAT_K + (1 - FAT_K) * u          // the fat pocket, flat across its band
    : LEAN_K * u * u;                  // the ordinary one, piled on the floor
  return Math.round(P_MIN + P_SPAN * k);
}

export class Combat {
  /**
   * All four are optional and all four may be null:
   *   peds    js/pedestrians.js — needs hurt() and nearest(). Without both,
   *           this module is inert rather than broken (see _resolve).
   *   chatter held, deliberately never called — see the header.
   *   wallet  js/wallet.js, or the module namespace; earn() is all we use.
   *   audio   js/audio.js, or the module namespace; sfxAt() is all we use.
   */
  constructor({ peds, chatter, wallet, audio } = {}) {
    this.peds = peds ?? null;
    this.chatter = chatter ?? null;
    this.wallet = wallet ?? null;
    this.audio = audio ?? null;

    /** True from the moment a swing starts until it has recovered. main.js
     *  suppresses the other on-foot verbs against this. */
    this.busy = false;

    // ---- the clock, and the deadlines against it ----
    this._now = 0;
    this._t0 = 0;            // when this swing started
    this._openAt = 0;
    this._shutAt = 0;
    this._endAt = 0;
    this._repeatAt = 0;      // a HELD button may not start another swing before
    this._live = false;      // a swing is running
    this._landed = false;    // …and it has already spent its one hit
    this._queued = false;    // a press buffered — see strike()
    this._queueAt = 0;       // …and the deadline it expires on
    this._t01 = 0;           // 0..1 through the swing — what the pose reads

    // ---- the fight ----
    this._foe = null;        // who we are hitting. Cleared on a kill and when
    this._foeAt = 0;         // the combo goes cold, so no corpse is ever pinned
    this._step = 0;          // blows this foe has taken = the next rung
    this._rung = 0;          // which rung THIS swing is, fixed when it started

    // ---- the player, remembered so reset() can unhook without one ----
    this._player = null;
    this._ready = false;     // update()'s verdict on whether a punch is legal
    this._camYaw = 0;
    this._hasYaw = false;
    this._lockedAim = false; // we set player.aimLock, so we may clear it

    this._crimeFns = [];

    // ---- scratch: nothing below is ever reallocated ----
    // ONE blow record for the life of the process. peds.hurt() must READ these
    // fields, not keep the object — the next punch rewrites it in place. That
    // is the same contract every other scratch record in this codebase carries
    // (js/chatter.js's _cand, js/vitals.js's _s), and it is what keeps a verb
    // the player can spam off the allocator.
    this._blow = { dmg: 0, launch: false, vx: 0, vz: 0, vy: 0, spin: 0, cause: '' };
    // Bound once. nearest(x, z, r, want) gets this same function forever, and
    // it reads the search frame off the fields below rather than closing over
    // arguments, so a strike allocates nothing either.
    this._want = (p) => this._inArc(p);
    // Likewise: player.combatPose is handed THIS reference, so hooking and
    // unhooking is an assignment and the identity test in _unhook is exact.
    this._pose = () => this._poseStep();
    this._sx = 0; this._sz = 0; this._sy = 0;    // where the swing came from
    this._dx = 0; this._dz = -1;                 // …and which way it went

    // Resolved lazily from whatever the player hands us — see _hook.
    this._poseFrom = null;
    this._punchFn = null;
    this._kickFn = null;
  }

  // ---------------------------------------------------------------- frame ----

  /**
   * One physics step. ctx = { player, onFoot, camYaw, input }, all optional.
   *
   * MUST be called every step, on foot or not: it is the only thing that
   * advances the clock, and it is what cancels a swing the moment the player
   * stops being able to throw one (got in a car, died, went through a door).
   */
  update(dt, ctx) {
    const c = ctx || NO_CTX;
    // A NaN dt would poison the clock permanently, and a huge one is a hidden
    // tab rather than a frame. Clamp rather than reject, so a slightly-over
    // step still advances the swing by the time it really covered.
    const step = Number.isFinite(dt) && dt > 0 ? (dt > MAX_DT ? MAX_DT : dt) : 0;
    this._now += step;

    const player = c.player ?? null;
    if (Number.isFinite(c.camYaw)) { this._camYaw = c.camYaw; this._hasYaw = true; }
    // A different body — a respawn, a second local player, a teardown — voids
    // everything that referred to the old one, swing included. Same rule
    // js/vitals.js applies to a vehicle it was sampling, for the same reason:
    // a sample (here, a half-thrown punch) taken from one object may not be
    // spent against another. _cancel() unhooks the OLD player, which is why it
    // has to happen before the field is reassigned.
    if (player !== this._player) {
      this._cancel();
      this._player = player;
      this._poseFrom = null;
      this._punchFn = null;
      this._kickFn = null;
    }

    const onFoot = c.onFoot !== undefined ? !!c.onFoot : !!player && !player.inCar;
    this._ready = this._able(player, onFoot);
    if (!this._ready) {
      // The ONE place a buffered press is thrown away for a reason other than
      // its own deadline: the player is in a car, mid-door or dead, and a punch
      // remembered through that would land seconds later on whatever they were
      // stood next to when they got out.
      this._cancel();
      this._queued = false;
      return;
    }

    if (this._live) {
      const t = (this._now - this._t0) / SWING_T;
      this._t01 = t < 0 ? 0 : t > 1 ? 1 : t;
      // Scanned on every step the window is open for, spent exactly once —
      // stepGame can run this three times in one rendered frame.
      if (!this._landed && this._now >= this._openAt && this._now <= this._shutAt) {
        this._resolve(player);
      }
      if (this._now >= this._endAt) this._end(player);
    }

    // The buffered press first, then the held button. Both go through _begin,
    // so a queued strike cannot skip the rules a fresh one obeys. The queue is
    // spent whether or not it was still in date: a press that waited out its
    // BUFFER_T is gone, not pending.
    if (!this._live) {
      if (this._queued) {
        this._queued = false;
        if (this._now <= this._queueAt) this._begin(player);
      } else if (c.input && c.input.attackHeld && this._now >= this._repeatAt) {
        this._begin(player);
      }
    }

    // The fight goes cold. Clearing the reference matters as much as clearing
    // the ladder: js/chatter.js is careful never to pin a body it is finished
    // with, and a `_foe` left behind would hold a disposed citizen for as long
    // as this object lives.
    if (this._foe && this._now > this._foeAt) { this._foe = null; this._step = 0; }
  }

  /**
   * Throw one attack. Called from the attack input in main.js — NOT from
   * update(), which only handles the held-button repeat.
   *
   * Returns true when a swing started on the spot. A press this call cannot
   * spend is BUFFERED for BUFFER_T, and there are two of them:
   *
   *   · the recovery tail of a swing already running. A press at the very
   *     START of one is a double-tap and is dropped instead, because buffering
   *     that would let a mash queue a phantom combo nobody asked for.
   *   · a press that arrives before update() has ever run — main.js binds the
   *     attack key at boot and the browser will happily deliver a keydown
   *     between that and the first stepGame. Without the buffer the first punch
   *     of the session is eaten, which is a bug report ("it didn't register")
   *     that nobody can ever reproduce.
   *
   * A press thrown at a moment the player demonstrably CANNOT fight in — at the
   * wheel, mid-door, dead — is refused outright and remembered by nobody, which
   * is the difference between a buffer and a trap: a punch that queued through a
   * car journey would land on whoever the player happened to park next to.
   */
  strike() {
    if (this._live) {
      if (this._now >= this._endAt - BUFFER_T) this._queue();
      return false;
    }
    // No player yet means update() has not run, so we do not KNOW whether this
    // press is legal — buffer it and let the next step decide. A player we HAVE
    // seen and that update() called unfightable is a different answer entirely:
    // refuse outright, and do not remember it.
    if (!this._player) { this._queue(); return false; }
    if (!this._ready) return false;
    this._begin(this._player);
    return true;
  }

  _queue() { this._queued = true; this._queueAt = this._now + BUFFER_T; }

  /** fn(kind, x, z) — 'rvacka' on a landed blow, 'zabiti' when one kills.
   *  Exactly one crime per blow: the kill supersedes the fight, it does not
   *  accompany it. */
  onCrime(fn) {
    if (typeof fn === 'function' && this._crimeFns.indexOf(fn) < 0) this._crimeFns.push(fn);
  }

  /** New game, or a hard scene reset. Drops the swing and the fight, unhooks
   *  the player, and KEEPS the listeners — main.js subscribes once at boot, and
   *  quietly unhooking the crime route on a restart would leave the police
   *  blind for the rest of the session. */
  reset() {
    this._cancel();
    this._foe = null;
    this._foeAt = 0;
    this._step = 0;
    this._queued = false;
    this._queueAt = 0;
    this._repeatAt = 0;
  }

  // ---------------------------------------------------------------- swing ----

  _able(player, onFoot) {
    if (!player || !onFoot) return false;
    if (player.inCar || player.boarding || player.exiting) return false;
    return !!player.pos;
  }

  _begin(player) {
    this._live = true;
    this.busy = true;
    this._landed = false;
    this._t01 = 0;
    this._t0 = this._now;
    this._openAt = this._now + OPEN_T;
    this._shutAt = this._now + SHUT_T;
    this._endAt = this._now + SWING_T;
    this._repeatAt = this._now + SWING_T + REPEAT_GAP;
    this._rung = this._step < LADDER.length ? this._step : 0;

    // Turn into it. player.aimLock is the contract's own word for this state —
    // heading follows camYaw, strafing, walk capped — and it is exactly what a
    // swing wants. The heading is ALSO written outright, and the redundancy is
    // deliberate: if aimLock has not landed in js/player.js yet, a punch must
    // still visibly go where the camera is pointing rather than out of the
    // player's ear. Both agree on the same angle, so neither can fight the
    // other.
    if (this._hasYaw) player.heading = this._camYaw;
    player.aimLock = true;
    this._lockedAim = true;

    this._hook(player);
    this.audio?.sfxAt?.(SFX_SWING, 0.45, player.pos.x, player.pos.z, SFX_R);
  }

  // The swing is over. The pose is applied ONE last time at t01 = 1 before
  // player.combatPose is dropped, and that is not tidiness: walk() writes
  // rotation.x every frame and would take the arms back by itself, but anything
  // the pose set on another axis would survive it — precisely the trap
  // js/citizen.js documents for ragdollPose ("the z-splay set here survives
  // until standPose"). punchPose(1) / kickPose(1) must therefore leave every
  // joint they touched where they found it.
  _end(player) {
    this._t01 = 1;
    this._poseStep();
    this._live = false;
    this.busy = false;
    this._unhook(player);
  }

  // Cheap on the common path: when there is no swing and no lock there is
  // nothing to undo, and this runs on every step the player spends driving.
  //
  // A cancelled swing still gets its closing pose, for the same reason _end
  // does and one more: the cases that reach here are death and boarding, and
  // the walk cycle that resumes afterwards writes rotation.x only. An arm left
  // splayed on another axis by a punch that was interrupted would stay splayed
  // for the rest of the session.
  // It deliberately does NOT touch the buffered press: a swing is a property of
  // a body and a press is a property of the player's intent, and the two die of
  // different causes. See update(), which is the one place intent is dropped.
  _cancel() {
    if (!this._live && !this._lockedAim) return;
    if (this._live) { this._t01 = 1; this._poseStep(); }
    this._live = false;
    this.busy = false;
    this._landed = true;
    this._t01 = 0;
    this._unhook(this._player);
  }

  // ----------------------------------------------------------------- pose ----

  // js/player.js exposes combatPose but not the citizen's own poses, so this
  // finds them wherever they are: on the player directly if that file chose to
  // forward them, otherwise on the citizen record it holds. Resolved once per
  // player object, never per frame. Both may end up null — a build whose
  // js/citizen.js has not grown punchPose yet still fights, it just does not
  // animate, which is the right way round to degrade.
  _hook(player) {
    if (this._poseFrom !== player) {
      this._poseFrom = player;
      const src = typeof player.punchPose === 'function'
        ? player
        : (player._cit ?? player.cit ?? player.citizen ?? null);
      this._punchFn = typeof src?.punchPose === 'function' ? src.punchPose : null;
      this._kickFn = typeof src?.kickPose === 'function' ? src.kickPose : null;
    }
    player.combatPose = this._pose;
  }

  _unhook(player) {
    if (player && player.combatPose === this._pose) player.combatPose = null;
    if (this._lockedAim) {
      this._lockedAim = false;
      if (player) player.aimLock = false;
    }
  }

  // Called by js/player.js AFTER _animate has written the whole skeleton, so
  // this is purely additive and only ever touches the arms (and, for the kick,
  // one leg) — exactly the way sitPose is already used by the boarding machine.
  // It reads _t01 rather than integrating its own clock: there is one clock in
  // this file, and if player.update() happens to run before combat.update() the
  // pose is at most one step behind the swing, which at 0.35 s is invisible.
  _poseStep() {
    const r = LADDER[this._rung];
    if (r.kick) this._kickFn?.(this._t01);
    else this._punchFn?.(this._t01, r.arm);
  }

  // ------------------------------------------------------------- the blow ----

  // Find one victim and put them through the one door. Called on every step the
  // window is open for until it finds somebody.
  _resolve(player) {
    const peds = this.peds;
    // A half-wired build is silent, not broken. Both of these are ADDITIONS to
    // js/pedestrians.js landing in the same run as this file, and without them
    // there is no honest way to hurt anybody — reaching into ped physics from
    // out here is the one thing this module must never do.
    if (!peds || typeof peds.nearest !== 'function' || typeof peds.hurt !== 'function') return;

    // The search frame, into scratch, for the predicate to read.
    this._sx = player.pos.x;
    this._sz = player.pos.z;
    this._sy = Number.isFinite(player.y) ? player.y : 0;
    // ARCHITECTURE.md's convention, the same two lines js/player.js uses for
    // the camera-relative stick: dir(yaw) = (−sin yaw, −cos yaw). Live camYaw
    // rather than the angle captured at the start of the swing, so the arc
    // tracks the camera exactly as aimLock is tracking the body.
    const yaw = this._camYaw;
    this._dx = -Math.sin(yaw);
    this._dz = -Math.cos(yaw);

    const p = peds.nearest(this._sx, this._sz, REACH, this._want);
    if (!p) return;                          // nobody yet; the window is still open

    this._landed = true;
    const r = LADDER[this._rung];
    const b = this._blow;
    b.dmg = r.dmg;
    b.launch = r.launch;
    b.vx = this._dx * r.push;
    b.vz = this._dz * r.push;
    b.vy = r.vy;
    b.spin = r.spin;
    b.cause = r.cause;

    const wasDead = p.dead === true;
    const x = p.x, z = p.z;                  // read BEFORE hurt() moves them
    peds.hurt(p, b);
    const killed = !wasDead && (p.dead === true || !(p.hp > 0));

    this.audio?.sfxAt?.(SFX_HIT, killed ? 0.85 : 0.7, x, z, SFX_R);

    // The pocket, once. `_robbed` is stamped on the body rather than kept in a
    // Set here, for js/fuel.js's reason: a Map or Set keyed by body pins every
    // corpse that ever existed against the collector, and pedestrians.js has no
    // dispose hook for us to hang off. A field on the body dies with the body.
    if (killed && !p._robbed) {
      p._robbed = 1;
      const kc = pocketOf(p.pid);
      if (kc > 0) this.wallet?.earn?.(kc, LOOT_LABEL);
    }

    // One crime per blow. The kill supersedes the brawl rather than joining it:
    // firing both would charge js/wanted.js twice for one punch.
    this._crime(killed ? CRIME_KILL : CRIME_FIGHT, x, z);

    // The ladder is the FIGHT's, not the button's — see the header.
    if (p !== this._foe) this._step = 0;
    this._step = (this._step + 1) % LADDER.length;
    if (killed) { this._foe = null; this._step = 0; }
    else { this._foe = p; this._foeAt = this._now + COMBO_T; }
  }

  // The `want` predicate handed to peds.nearest(). It is what makes "nearest"
  // mean "nearest one I can actually hit" — testing the arc AFTERWARDS would
  // let one pedestrian standing behind the player shield everybody in front of
  // them, which is the same shielding bug js/chatter.js's proximity scan had to
  // fix with a `continue`.
  _inArc(p) {
    if (!p || p.dead) return false;
    // 'held' is the mugging grip. 'rag', 'down' and 'dead' are not targets: the
    // ladder is chest-height animation and kicking a body on the tarmac needs a
    // pose and a reason that this pass does not have.
    const st = p.state;
    if (st !== 'walk' && st !== 'held') return false;

    const dx = p.x - this._sx, dz = p.z - this._sz;
    const d2 = dx * dx + dz * dz;
    if (!(d2 <= REACH2)) return false;       // !(<=) also refuses a NaN position
    if (d2 > 1e-6) {
      const d = Math.sqrt(d2);
      if ((dx * this._dx + dz * this._dz) / d < ARC_COS) return false;
    }
    // Feet against feet, and only when there is a mesh to ask. See MAX_DY.
    const my = p.mesh?.position?.y;
    if (Number.isFinite(my) && Math.abs(my - this._sy) > MAX_DY) return false;
    return true;
  }

  // -------------------------------------------------------------- crimes ----

  _crime(kind, x, z) {
    const list = this._crimeFns;
    for (let i = 0; i < list.length; i++) {
      // A listener that throws must not take the fist with it. js/vitals.js
      // tells the story: one TypeError raised inside stepGame froze the game on
      // the last drawn frame, every frame, for as long as it kept being raised.
      try { list[i](kind, x, z); } catch (e) { console.warn('[combat] onCrime:', e); }
    }
  }
}

export default Combat;
