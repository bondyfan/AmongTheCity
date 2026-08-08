// ==========================================================================
// Police — what the patrol does once it wants you
//
// THIS IS A FIRST SLICE AND THE EDGES ARE DELIBERATE. One star puts one car
// behind you; two stars put a second one there. That is the whole feature.
// There are NO roadblocks, NO officers on foot, NO helicopter and NO bust: a
// unit that reaches you sits on your bumper with its siren on and waits for a
// verb that does not exist yet. Above two stars this file does nothing extra —
// js/wanted.js will happily count to five and the third car is not written.
//
// The reason for slicing it there is not laziness, it is that every one of
// those four features needs something this build has not got: a roadblock
// needs to reserve a junction and un-reserve it (traffic.js owns junctions), a
// bust needs a state the player can be IN (there is no jail, no fee, no
// respawn-to-station), and a helicopter needs a second flight AI. A pursuit
// that merely follows you is the one piece that is complete on its own — you
// can be chased, you can be caught up with, and you can lose them — and it is
// worth shipping alone.
//
// ---- THE ONE MEASURED PROBLEM: THEY CANNOT CATCH YOU ----------------------
//
// A traffic car's desired speed is `edge.speed × vK` with vK drawn once per
// car from [0.72, 1.18] (traffic.js:283). On a 50 km/h street — 13.9 m/s —
// that is 10.0 to 16.4 m/s, and the car chasing you is whichever one happened
// to be nearest, so half the time it is the pensioner. The player's Octavia
// tops out at 64 m/s (vehicles.js KIND) and holds 25 m/s through town without
// trying. A patrol drawn from the schedule loses 9 m/s per second, i.e. it is
// not slow, it is not in the race.
//
// So a unit gets a RUBBER BAND: its desire is multiplied by a factor that
// grows with how far behind you it is and is capped hard.
//
//     band(d) = 1 + (BAND_MAX − 1) · clamp01((d − BAND_NEAR)/(BAND_FAR − BAND_NEAR))
//
// and the numbers are chosen so that it catches a CAR and not a Gripen:
//
//   BAND_NEAR = 40 m   Inside this the band is exactly 1 and the unit drives
//                      the street's own limit × 1.15. This is the important
//                      end: the moment a police car within shouting distance
//                      is allowed to cheat, the chase stops reading as driving
//                      and starts reading as a magnet, and the player can feel
//                      that inside one junction.
//   BAND_FAR  = 200 m  Where the band saturates. About the length of street you
//                      can see down in this city, and — see below — the number
//                      that decides where the chase settles.
//   BAND_MAX  = 2.2    On a 50 street that is 13.9 × 1.15 × 2.2 = 35 m/s
//                      (127 km/h) at full stretch. THE NUMBER THAT MATTERS IS
//                      NOT THE TOP OF THE BAND BUT WHERE IT CROSSES YOU: solve
//                      band(d)·15.99 = 25 m/s, the speed a player really can
//                      hold through a grid, and the chase settles at d ≈ 115 m
//                      — close enough to fill your mirror, far enough that they
//                      are not touching you. Above that gap they gain ~10 m/s,
//                      so 200 m of lead is clawed back in twenty seconds; below
//                      it you pull away. It was tuned here from 2.0/260 m,
//                      which put the crossing at 165 m and, measured against
//                      the grid fixture, meant a unit drafted 210 m back was
//                      still 164 m back a minute later: technically a pursuit,
//                      visibly a car that was not gaining. Every mistake — a
//                      corner taken too fast, a queue, a wrong turn — is now
//                      paid straight back.
//   COP_VMAX  = 42 m/s (151 km/h) absolute ceiling, whatever the road says.
//                      This is the "not a Gripen" clause and it is a NUMBER
//                      rather than a hope, checked against vehicles.js's own
//                      KIND table: every CAR there tops 56–72 m/s (fabia 56,
//                      octavia 64, mercedes 67, bmw 69, tesla 72), so a player
//                      who can drive can always out-run a unit in a straight
//                      line on open road. What they cannot do is out-run one in
//                      traffic, because in traffic nobody gets to use their top
//                      speed. Escaping is therefore a driving problem, which is
//                      the point. The three commercial kinds sit BELOW the
//                      ceiling (van 36, bus 29, truck 26) and that is not an
//                      oversight either: steal a bus and you get caught, which
//                      is the correct answer to stealing a bus.
//   COP_VK    = 1.15   The driver, not the car. Deliberately inside traffic's
//                      own [0.72, 1.18] spread: these ARE those cars and those
//                      drivers, they are simply the ones allowed to hurry.
//
// The band is the ONLY cheat. A unit corners on the same envelope traffic uses
// (v² = vc² + 2·b·d, cornerSpeed transcribed below), brakes for the same cars
// and gets shoved by the same collision solver. It is not on rails in the sense
// of being unstoppable — it is on rails in the sense of driving on roads.
//
// ---- BORROWING A CAR, WHICH IS THE DANGEROUS PART -------------------------
//
// A unit is not spawned. It is a car that was already driving past, which is
// why a pursuit starts with a car peeling out of the flow instead of a car
// appearing out of nothing — traffic.js spent its whole v9 rewrite making sure
// nothing appears out of nothing and this file is not going to undo that.
//
// The obvious way to take it — traffic's own `_toGhost(p)` — is WRONG and the
// review caught it before it shipped. _toGhost deletes the slot key from
// `_pool` so that the next generation can be minted on time. But a commandeer
// happens mid-generation, and `update()` runs `_sweepPool` and then
// `_scanCells` in the same tick (traffic.js:1923-1924): _scanCells finds the
// key missing from _pool, re-mints the SAME slot, same generation, same seed,
// and two lines later there are two identical Octavias, one of them with a
// siren. The slot has to stay occupied by something.
//
// The honest door is the one that already exists for exactly this event:
//
//     traffic.steal(car)
//
// It is what main.js calls when the player yanks a door open, and a
// commandeer is the same event performed by the state instead of by you. It
// leaves a TOMBSTONE in _pool with `stolen = 1`, which _sweepPool skips
// (traffic.js:1710) for the rest of the generation, so the slot is neither
// refilled nor duplicated; when the generation rolls over the tombstone is
// reaped and the next car is minted normally. It also hands us a car that
// keeps its mesh, its paint and its position — no attach, no pop, no gate to
// satisfy.
//
// What it does NOT do is give it back, because traffic.js has no such call
// (see WHAT ANOTHER MODULE MUST DO). So the hand-back is ours, and it is the
// ghost pattern traffic.js already argued out: when the pursuit ends the unit
// does not blink out and does not stop dead in the road. It goes back to
// ordinary speed, keeps driving its rail, and the mesh is only released once
// it is RELEASE_R away or RELEASE_T has passed — out of sight in the only
// sense this file can afford to measure, since traffic's view cone is private.
// The cost is one traffic slot per unit for at most one TRIP_T (150 s): two
// cars out of ~120, under 2 %, and they are two cars that are visibly
// somewhere else doing something.
//
// GHOSTS ARE FAIR GAME and are in fact the better catch: a ghost has already
// left the shared population, so stealing one leaves no tombstone at all.
// traffic.steal() handles both cases and we do not have to know which we got.
//
// ---- WHAT DRIVES IT ------------------------------------------------------
//
// A commandeered car is out of traffic's `cars` set, so nothing drives it any
// more. This file re-implements the small half of traffic's rail follower:
// walk an edge, pick the next one at the node, pose off the polyline, lane
// offset, road grade. It reads traffic's PUBLIC graph (`traffic.edges`, and
// the `a`/`b` node objects those edges carry with their `out` lists) and
// touches nothing private.
//
// Route choice is GREEDY, not a search: at each node take the outgoing edge
// whose far end is nearest to where you are going, with a 60 m penalty on a
// U-turn so a unit does not dither at a dead end. There is no A* here, and
// that is a real limitation with a real failure mode — a one-way system can
// walk a unit into a corner and the greedy rule will not plan its way out. Two
// things keep it survivable: a unit stuck at walking pace for STUCK_T is
// released and a fresh one is drafted from the flow, and a chase in which one
// car loses the plot but the other is still on you is a chase, not a bug.
// Slice two can hand this a real router (js/navigation.js already owns one for
// the minimap line); it is one function, `_pickNext`.
//
// Signals are IGNORED. A unit does not stop at a red — that is what the siren
// is for, and a police car queueing politely at a junction while you drive
// away is funny exactly once.
//
// ---- LOSING THEM ---------------------------------------------------------
//
// js/wanted.js owns the heat. This module owns one fact and publishes it:
// whether a unit CURRENTLY HAS YOU. A unit has you when
//
//   · you are within SEE_NEAR (22 m) — that close, nothing is hidden, or
//   · you are within SEE_R (170 m) AND no building stands on the straight line
//     between you.
//
// The line test walks `city.buildingAt` in LOS_STEP samples. It is honest
// about roads (two points on the same street see each other; the roadway is
// not built on) and honest about corners (turn one and the wall between you is
// a real wall), which makes the losing mechanic the right one: you break
// contact by turning out of their sight, not by out-running them in a straight
// line down the same street. Where `city` cannot answer — a bare fixture, or a
// chunk that has not streamed — the answer is "clear", i.e. seen. Being wrong
// towards being seen is the cheap direction: the punishment is that you have
// to try again.
//
// While nobody has you, units drive to the last place somebody did, which is
// what makes a break feel earned rather than switched off. After LOSE_T of
// unbroken no-contact this module stops claiming you and lets go of its cars;
// what that does to your stars is wanted.js's business, and wanted.js should
// be reading `police.sees` to decide.
//
// Note what happens NEXT, because it is the whole reason there is no search
// behaviour in this file: while your stars are still up, the recruiter simply
// drafts again a couple of seconds later — out of the traffic that is near you
// NOW. A patrol quartering the district looking for you is expensive to write
// and reads, from inside a car, as nothing at all; a fresh Octavia peeling out
// of the flow two streets from where you are hiding reads as a manhunt. So
// losing them is not "the pursuit ends", it is "you have to do it again, and
// keep doing it, until the heat runs out".
//
// ---- THE SIREN, AND THE ONE PLACE I COULD NOT DO WHAT THE BRIEF ASKED -----
//
// The brief asks for a procedural two-tone siren built out of js/audio.js's
// positional helpers. audio.js's positional exports are exactly three —
// setListener(), gainAt() and sfxAt() — and none of them can make a tone: the
// AudioContext, the master bus and every oscillator in that file are module
// private, and this run owns only js/police.js. The alternatives, and why they
// were rejected:
//
//   REJECTED — a second AudioContext, created here. It works, and it is
//   outside setVolume(): a player who mutes the game would still be chased by
//   a siren. Browsers also cap contexts per page. Not for a mixing convenience.
//
//   REJECTED — build the two tones out of horn(), the one export with a
//   guaranteed synthesized fallback. It is a horn. It sounds like a horn.
//
//   TAKEN — `siren_far`, which is already on disk (scripts/gen-sounds.mjs:78
//   generates it: "a European two-tone wailing siren rising and falling") and
//   is therefore not a new sample, retriggered on an absolute deadline through
//   sfxAt(), which attenuates it with gainAt()'s 1/r law like every other cue
//   in the city. The two tones are in the asset rather than in this file, and
//   the cadence — one voice for the nearest unit only, never a stack of two —
//   is here.
//
// Two honest costs. The clip is rendered "several streets away" so it is thin
// at your window, and a one-shot cannot be cut off, so the siren FADES over up
// to SIREN_GAP seconds after a pursuit ends instead of stopping dead. Both
// disappear the moment audio.js grows one export — see the report at the
// bottom of this header; the swap is the six lines of `_siren()`.
//
// ---- DETERMINISM: THERE IS NONE HERE, AND THAT IS CORRECT ----------------
//
// Everything else in this game that lives in the street is a pure function of
// (world seed, cell, slot, generation). A pursuit cannot be, because its cause
// is not shared: YOUR crimes raise YOUR heat on YOUR machine, and the peer
// standing beside you is not wanted. So which car is commandeered, where it
// goes and whether it can see you are all local, in the same way and for the
// same reason js/chatter.js's reactions are local (chatter.js:44) and
// traffic.js's ghosts are local (traffic.js:174).
//
// What that costs, said plainly: the peer keeps drawing your police car as an
// ordinary Octavia driving its schedule, because on his machine that slot was
// never stolen. It is survivable because nothing here moves shared state — no
// position in _pool changes, snapshot() is bit-identical either way — and it
// is CURABLE with one line at the net layer, which traffic.js has already
// asked for on its own behalf: broadcast `traffic.slotKey(car)` on a steal so
// the peer can `claimSlot(key)`. That is the same wire message the player's own
// car theft needs; a commandeer is not a new case.
//
// ---- COST -----------------------------------------------------------------
//
// Two units chasing, ever, plus at most two more driving themselves out of the
// picture. Per step each one walks its own polyline and scans traffic.cars once
// for a leader — ~120 squared distances behind a range gate. The expensive
// things (line of sight, drafting a new unit, the siren) hang off ABSOLUTE
// DEADLINES against one cached clock read, never countdowns, for the reason
// js/chatter.js's header gives at length: a countdown nobody ticks is a silent
// bug that every test still passes. No object, array or closure literal exists
// on any path update() touches; the four unit records are allocated once in the
// constructor and rewritten in place forever, and `units` / `cars` are fixed
// arrays rebuilt with length = 0 and push.
//
// stepGame(dt) can run three times per rendered frame (main.js clamps to 50 ms
// and loops). Every integration here is dt-proportional and every deadline is
// a timestamp, so three 16 ms calls and one 48 ms call end in the same place.
//
// ---- WHAT ANOTHER MODULE MUST DO FOR THIS TO WORK -------------------------
//
//   main.js — a commandeered car leaves traffic.cars, and four lists in
//     main.js are keyed on that set, so until this module's cars are added to
//     them a police car is a ghost: `_crashList()` (the player drives THROUGH
//     it), traffic.blockers (the AI drives through it), the minimap, and
//     engineVoices(). The crash list is the one that matters — a pursuit you
//     cannot collide with is not a pursuit. Push `police.cars` (bare car
//     objects, every car we hold) into the physics lists and read
//     `police.units` for the minimap.
//   wanted.js — nothing, as it turns out: it already reads `police.units` and
//     each unit's own `.sees`, which is exactly what this file publishes, and
//     `police.sees` is here as the one-call version of the same fact. Note the
//     two radii are NOT the same number and should not be: SEE_R is 170 m and
//     wanted.js only believes a unit's flag within its own LOCK_R of 150 m. The
//     20 m in between is its guard against a police.js that latches `sees` at
//     spawn, it costs nothing here — the band settles the chase at ~115 m,
//     inside both — and where they disagree, the tighter one wins, which is the
//     right direction for a rule that decides how long you stay wanted.
//   traffic.js — a `release(car)` that re-adopts a car onto a fresh schedule
//     would let a finished unit rejoin the flow instead of being deleted. Not
//     required: without it the cost is one slot per unit per pursuit, bounded
//     by TRIP_T, and the car drives away first.
//   audio.js — a positional continuous voice, e.g.
//     `sirenAt(id, x, z, on)` (or simply exporting the master bus), turns the
//     siren procedural and lets it stop dead. Everything else about it is
//     already here.
// ==========================================================================

import { TRAFFIC, LAYER_Y } from './config.js';
import { distPointToSegment, roadGradeY, bridgeDeckHeight } from './geo.js';
import { sfxAt } from './audio.js';
import { worldT } from './worldclock.js';

// ---- how many, and when --------------------------------------------------
const MAX_UNITS = 2;            // 1 star → 1, 2 stars → 2, above → not yet
// …and two more RECORDS than that, because a unit that has given up does not
// vanish, it drives away (see _letGo). Without the spare slots a chase that
// lost one car would have to wait out the whole RELEASE_T before it could draft
// its replacement, and the second star would go quiet for twenty-five seconds.
const POOL_N = MAX_UNITS + 2;
const RECRUIT_CD = 2.2;         // s between draftings. Long enough that a star
                                // arriving does not turn the whole street blue,
                                // short enough that the second car is on you
                                // within a junction of the second star.

// ---- who gets drafted ----------------------------------------------------
// Only cars a Czech police force would actually be in. A commandeered bus is a
// joke that lasts one pursuit, and a truck cannot make the corners.
const PATROL_KINDS = new Set(['octavia', 'fabia', 'bmw', 'mercedes', 'tesla']);
const PICK_MIN = 70;            // m — nearer than this and the player watches an
                                // ordinary car become a police car in his mirror.
                                // A soft preference, not a rule: see _recruit.
const PICK_MAX = 340;           // m — further out it would arrive too late to be
                                // the reason you are worried.
const KIND_PEN = 25;            // m of "distance" a non-Octavia costs, so the
                                // Czech default wins a close-run thing.

// ---- the rubber band, argued in the header -------------------------------
const COP_VK = 1.15;
const BAND_NEAR = 40, BAND_FAR = 200, BAND_MAX = 2.2;
const COP_VMAX = 42;            // m/s hard ceiling — the "not a Gripen" clause
const IDLE_VK = 1.0;            // …and what a released car drives at

// ---- the driving model, transcribed from traffic.js so the two agree ------
// Not imported: they are module-private there, and a shared import somebody
// later "optimises" is how two files stop agreeing about what a corner is.
const ACCEL = 5.2;              // m/s² — a shade over traffic's 4.0. A pursuit
                                // car is driven, not commuted.
const BRAKE = 5.0;              // planning decel: the anticipation envelope
const BRAKE_SOFT = 7.5;
const BRAKE_HARD = 15.0;
const TURN_RATE = 7.0;          // heading smoothing (1/s), traffic.js's number
const CORNER_LOOK = 16;         // m of polyline scanned ahead for curves
const LAT_GATE = 2.0;           // half-width of the follow corridor
const RAM_FRICTION = 4.0;       // m/s² a shunted car scrubs while sliding out
const UTURN_PEN = 60;           // m a U-turn must save before it is worth it
const HOP_MAX = 4;              // edges a unit may cross in one step — a guard
                                // against a chain of 0.5 m edges spinning here
const STUCK_V = 0.6;            // m/s under which a unit is not making progress
const STUCK_T = 20;             // s of that before we give the car back

// v = sqrt(a_lat · R), a polyline corner of angle `ang` taken over ~7 m so
// R ≈ 7/ang; with a_lat 4.5 that is sqrt(31.5/ang). A 90° city corner comes out
// at 4.5 m/s. Byte-identical to traffic.js:659 on purpose — a unit that
// cornered on different physics from the traffic it is weaving through would
// either understeer into every kerb or float round bends nothing else can take.
const cornerSpeed = (ang) => Math.max(2.2, Math.sqrt(31.5 / Math.max(ang, 0.06)));

// ---- sight ---------------------------------------------------------------
// HOW FAR A UNIT CAN SEE, and this number is not free to choose: it has to be
// bigger than the gap the rubber band settles at, or a unit doing its job
// perfectly — sitting 115 m back with its siren on — cannot see you, `sees`
// reads false through the whole chase, and wanted.js decays your stars while
// you are being pursued. It was 95 m and did exactly that: measured on the grid
// fixture, a player circling in the open was "seen" 24 % of the time and the
// pursuit went cold and re-drafted its cars every few seconds. 170 m is past
// the band's crossing point with room to spare, and it is honest — a car on a
// straight street plainly sees another car 170 m up it. What ends contact is
// the BUILDING TEST below, which is the mechanic we want doing the work: you
// break sight by turning a corner, not by inching out to 96 m.
const SEE_R = 170;
const SEE_NEAR = 22;            // …and this close nothing is hidden
const SEE_DT = 0.22;            // s between line-of-sight tests (≈4.5 Hz). The
                                // test is the only expensive thing in the file.
const LOS_STEP = 9;             // m between building samples along the sight
                                // line. Nine rather than seven so the longer
                                // radius costs no more calls than the short one
                                // used to: a footprint narrower than 9 m along
                                // the line can be threaded, and a sight line
                                // that only clips a corner was a judgement call
                                // either way.
const LOS_MAX = 20;             // …and never more samples than this
const LOSE_T = 9;               // s of nobody having you before the pursuit is
                                // cold. Long enough that ducking behind one bus
                                // is not an escape, short enough that a real
                                // corner-and-alley break pays inside ten seconds.
// …plus the time a freshly drafted car deserves to GET to you, which is not the
// same thing at all. Measured on the grid fixture: a unit is typically drafted
// 150–250 m away and closes at about 7–12 m/s, so on the bare LOSE_T it went
// cold — while accelerating, having never laid eyes on anybody — released the
// car it had just taken, drafted another, and did that for ever. The pursuit
// churned two cars a minute and never held more than one unit. A car answering
// a call has been TOLD where you are; it has not lost you, it has not arrived.
// So the grace is the distance it must cover at an honest closing speed, capped
// so that a draft from the far edge of PICK_MAX cannot buy half a minute of
// immunity for a player who is already gone.
const APPROACH_V = 12;          // m/s of closing speed the grace assumes
const APPROACH_MAX = 22;        // s — the cap on that grace

// ---- letting go ----------------------------------------------------------
const RELEASE_R = 250;          // m from you at which a released car is deleted
const RELEASE_T = 25;           // s after which it is deleted anyway. The
                                // surrender clause, exactly like traffic's
                                // GHOST_MAX: an immortal car is a frame-rate
                                // leak with no upper bound.
const FOOT_GAP = 7;             // m a unit holds off a player ON FOOT. There is
                                // no arrest in this slice, so driving over him
                                // is the only other option and it is worse.
// ARRIVING. A unit does not brake for a car you are DRIVING — that is the
// difference between a patrol and a pursuit, and being shunted at speed is the
// good half of being chased. But when the thing it has caught is not moving,
// carrying on is not aggression, it is comedy: measured on the grid fixture,
// units reached a parked player at 7 m, drove straight past, and the greedy
// router took them round the block and back, over and over, at 5 m and 100 m
// alternately. So a unit that is ON you and has nothing left to chase simply
// stops where it is, siren running — which is what the top of this header
// claims happens and, until this rule existed, did not.
const ARRIVE_R = 9;             // m — close enough to call it caught up
const ARRIVE_V = 3;             // m/s of PLAYER speed under which that applies
const LEAD_T = 1.6;             // s of the player's own velocity the aim point
const LEAD_MAX = 40;            // …leads by, capped. Aiming where you are GOING
                                // is what makes the greedy junction choice pick
                                // the street you just turned into.

// ---- siren ---------------------------------------------------------------
const SIREN_R = 210;            // m — where it stops being worth a voice
const SIREN_GAP = 3.4;          // s between retriggers. siren_far is 4.0 s long,
                                // so each cue overlaps the tail of the last and
                                // the wail runs continuous instead of pulsing.
const SIREN_VOL = 0.85;

const DT_MAX = 0.1;             // a step longer than this is a debugger, not a
                                // frame — main.js already clamps to 0.05

// ---- scratch, reused forever ---------------------------------------------
const _pose = { x: 0, z: 0, dx: 0, dz: 0, seg: 0 };
const _snap = { x: 0, z: 0, t: 0 };
const _lim = { v: 0, hard: false };

const dist = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// Point and tangent at arc length `s` along an edge's polyline. traffic.js has
// the same eight lines (poseAt) and does not export them; duplicated rather
// than reached for, for the reason above cornerSpeed.
function poseOn(e, s, seg) {
  const pts = e.pts, cum = e.cum;
  const last = pts.length - 2;
  if (seg > last) seg = last;
  if (seg < 0) seg = 0;
  while (seg > 0 && s < cum[seg]) seg--;
  while (seg < last && s > cum[seg + 1]) seg++;
  const a = pts[seg], b = pts[seg + 1];
  const L = (cum[seg + 1] - cum[seg]) || 1e-6;
  const t = s <= cum[seg] ? 0 : s >= cum[seg + 1] ? 1 : (s - cum[seg]) / L;
  _pose.x = a[0] + (b[0] - a[0]) * t;
  _pose.z = a[1] + (b[1] - a[1]) * t;
  _pose.dx = (b[0] - a[0]) / L;
  _pose.dz = (b[1] - a[1]) / L;
  _pose.seg = seg;
  return _pose;
}

export class Police {
  /**
   * { traffic, vehicles, wanted, city, scene }
   *
   * All five are optional and every one of them is null-checked on use: this
   * module must be constructible before the world has streamed, and a caller
   * that hands in nothing gets an object whose update() is a no-op rather than
   * a throw inside stepGame — js/vitals.js's header has the cautionary tale
   * about one TypeError inside the step loop freezing the renderer.
   *
   * `city` is wanted for ONE method, `buildingAt(x, z)`; hand in the CityWorld
   * and sight lines are blocked by architecture, hand in the raw city data (or
   * nothing) and they are not. `scene` is held and not yet used — see the note
   * on the beacon in _recruit.
   */
  constructor(opts = {}) {
    this.traffic = opts.traffic ?? null;
    this.vehicles = opts.vehicles ?? null;
    this.wanted = opts.wanted ?? null;
    this.city = opts.city ?? null;
    this.scene = opts.scene ?? null;

    // The pool. Four records, allocated here, rewritten in place forever;
    // `free` is what makes a slot reusable without ever allocating a fifth.
    this._pool = [];
    for (let i = 0; i < POOL_N; i++) this._pool.push(this._blank());

    /** Live pursuit cars, for the minimap and for wanted.js. Read-only.
     *  Each entry is a UNIT, not a bare car: `.x`, `.z`, `.heading`, `.speed`
     *  mirror the car it is driving (so a minimap that reads those three off a
     *  traffic car works unchanged), `.car` is the vehicles.js object itself,
     *  and `.sees` is whether this unit currently has the player. */
    this.units = [];

    /** Every car this module is holding, chasing or driving away — bare
     *  vehicles.js car objects, the same shape traffic.cars holds. Read-only.
     *  This, not `units`, is the list main.js's _crashList() and
     *  traffic.blockers want: a unit that has given up is still four metres of
     *  solid metal for the twenty seconds it takes to leave, and a car you can
     *  drive through is worse than a car that should not have been there. */
    this.cars = [];

    /** True while ANY unit has the player. js/wanted.js's seen() wants this. */
    this.sees = false;

    // Test seam, exactly the one traffic.js carries (traffic.js:741) and for
    // exactly the reason: every deadline in this file is an absolute time
    // against worldT(), and worldT() runs on the wall clock, so a headless test
    // that steps 600 frames in a millisecond would see none of them expire and
    // would silently measure nothing. null = worldT().
    this.clock = null;
    this._t = this._now();       // cached clock, one read per update()
    this._losOff = false;        // set once if buildingAt ever throws
    this._recruitAt = 0;         // absolute deadline, never a countdown
    this._sirenAt = 0;
    this._coldAt = 0;            // when the pursuit goes cold if nobody re-sees
    this._lastX = 0;             // where somebody last had you
    this._lastZ = 0;
    this._hasLast = false;
  }

  _now() { return this.clock ? this.clock() : worldT(); }

  _blank() {
    return {
      free: true, car: null, edge: null, s: 0, seg: 0,
      x: 0, z: 0, y: 0, heading: 0, speed: 0, laneOff: 0,
      sees: false, seenAt: -1e9, sightAt: 0, stuckT: 0,
      release: false, releaseAt: 0,
    };
  }

  // ------------------------------------------------------------- frame ----

  /**
   * ctx = { x, z, car, dt } — where the player is, and the car they are
   * driving (null on foot). `dt` in the context is accepted and ignored; the
   * argument is the authority, because that is the one main.js clamps.
   */
  update(dt, ctx) {
    const step = Number.isFinite(dt) && dt > 0 ? (dt > DT_MAX ? DT_MAX : dt) : 0;
    this._t = this._now();
    if (!ctx || !this.traffic || !this.vehicles) { this.sees = false; this._sync(); return; }

    const px = Number.isFinite(ctx.x) ? ctx.x : 0;
    const pz = Number.isFinite(ctx.z) ? ctx.z : 0;
    const pcar = ctx.car ?? null;
    const onFoot = !pcar;

    // How many cars this heat level is worth. Above two stars we do not add a
    // third — the header says so out loud rather than silently capping.
    const stars = this._stars();
    const want = stars <= 0 ? 0 : stars === 1 ? 1 : MAX_UNITS;

    // Sight first: it decides where everybody drives this step, and it decides
    // whether the pursuit is still warm.
    this._sight(px, pz);

    // The aim point. While somebody has you it leads your own velocity, so a
    // unit at a junction picks the street you turned into rather than the one
    // you were in when it got there. While nobody has you it is the last place
    // anybody did — that stale target is the whole feel of a break.
    let tx = px, tz = pz;
    if (this.sees) {
      if (pcar) {
        const v = Math.abs(pcar.speed ?? 0);
        const lead = Math.min(LEAD_MAX, v * LEAD_T);
        tx = px - Math.sin(pcar.heading ?? 0) * lead;
        tz = pz - Math.cos(pcar.heading ?? 0) * lead;
      }
      this._lastX = px; this._lastZ = pz; this._hasLast = true;
      this._coldAt = this._t + LOSE_T;
    } else if (this._hasLast) {
      tx = this._lastX; tz = this._lastZ;
    }

    // THE COLD RULE, and the ordering matters. "Cold" means no unit has had you
    // for LOSE_T, and the answer to that is to give the cars back — a unit
    // driving for ever at a target it last saw a minute ago is not searching,
    // it is lost. What replaces the search is the draft: two seconds later a
    // patrol that is actually NEAR you gets pulled out of the flow, which is
    // both cheaper and more frightening than a car quartering the district. So
    // going cold must NOT stop the recruiter — an earlier draft of this file
    // made "release everything" and "draft one" two arms of the same `if`, and
    // once the pursuit went cold with no live unit the condition stayed true
    // for ever and the police never came back at all.
    if (want <= 0) {
      for (let i = 0; i < this._pool.length; i++) this._letGo(this._pool[i]);
      this._hasLast = false;
    } else {
      if (this._t >= this._coldAt) {
        for (let i = 0; i < this._pool.length; i++) this._letGo(this._pool[i]);
        this._hasLast = false;
      }
      const live = this._liveCount();
      if (live > want) {
        for (let i = this._pool.length - 1; i >= 0 && this._liveCount() > want; i--)
          if (!this._pool[i].free && !this._pool[i].release) this._letGo(this._pool[i]);
      } else if (live < want && this._t >= this._recruitAt) {
        // One draft per cooldown, whether or not it succeeds: an empty street
        // must not be re-scanned every frame for the car it has not got.
        this._recruitAt = this._t + RECRUIT_CD;
        this._recruit(px, pz);
      }
    }

    // "Slow" is the whole of what a unit needs to know about your motion: on
    // foot you are always slow, and a car under ARRIVE_V is stopped as far as
    // a pursuit is concerned.
    const slow = onFoot || Math.abs(pcar?.speed ?? 0) < ARRIVE_V;

    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free) continue;
      this._drive(u, step, tx, tz, px, pz, onFoot, slow);
      if (u.release && (this._t >= u.releaseAt
        || dist(u.x - px, u.z - pz) > RELEASE_R)) this._drop(u);
    }

    this._siren(px, pz);
    this._sync();
  }

  // Rebuild the two public lists in place — length = 0 and push, so a caller
  // iterating them every frame never sees a fresh array and we never allocate.
  _sync() {
    this.units.length = 0;
    this.cars.length = 0;
    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free) continue;
      if (u.car) this.cars.push(u.car);
      if (!u.release) this.units.push(u);
    }
  }

  _liveCount() {
    let n = 0;
    for (let i = 0; i < this._pool.length; i++)
      if (!this._pool[i].free && !this._pool[i].release) n++;
    return n;
  }

  _stars() {
    const w = this.wanted;
    if (!w) return 0;
    const s = typeof w.stars === 'function' ? w.stars() : w.stars;
    return Number.isFinite(s) ? s : 0;
  }

  // --------------------------------------------------------- recruiting ----

  /**
   * Take the most suitable car out of the flow. "Suitable" is nearest, in a
   * car a patrol would be in, with a soft push away from the first PICK_MIN
   * metres so the transformation does not happen in the player's mirror.
   *
   * NOTE ON WHAT IT DOES NOT DO: it does not repaint the car and does not put
   * a light bar on the roof. A livery belongs on the model in vehicles.js /
   * meshes.js, both owned elsewhere this run, and the two things this file
   * could do from outside are both wrong. A quad bolted to the roof needs a
   * roof HEIGHT, and KIND is not exported — it would float over four of the
   * five hulls. A THREE light created when a pursuit starts changes the
   * scene's light count, which recompiles every material in the scene: a hitch
   * at the exact moment the player needs frames. So in this slice a unit is
   * identified by its siren and by the minimap, `scene` is held for the beacon
   * that arrives with the livery, and nothing is guessed at.
   */
  _recruit(px, pz) {
    const cars = this.traffic.cars;
    if (!cars || !cars.size) return;
    let best = null, bestScore = Infinity;
    for (const car of cars) {
      const p = car.ai;
      if (!p || !p.edge || !p.edge.pts) continue;   // not traffic's to lend
      if (!PATROL_KINDS.has(car.kind)) continue;
      const d = dist(car.x - px, car.z - pz);
      if (d > PICK_MAX) continue;
      let score = d;
      if (d < PICK_MIN) score += (PICK_MIN - d) * 2.5;
      if (car.kind !== 'octavia') score += KIND_PEN;
      if (score < bestScore) { bestScore = score; best = car; }
    }
    if (!best) return;                              // no patrol, no pursuit

    let u = null;
    for (let i = 0; i < this._pool.length && !u; i++)
      if (this._pool[i].free) u = this._pool[i];
    if (!u) return;
    const p = best.ai;
    // Copy the rail state BEFORE the steal — steal() nulls car.ai, and `p` is
    // the only place the edge, the arc and the lane offset live.
    u.edge = p.edge; u.s = p.s; u.seg = p.seg;
    u.laneOff = p.laneOff ?? 0;
    u.x = best.x; u.z = best.z; u.y = best.y ?? 0;
    u.heading = best.heading; u.speed = Math.max(0, best.speed ?? 0);
    u.sees = false; u.seenAt = -1e9; u.sightAt = 0; u.stuckT = 0;
    u.release = false; u.releaseAt = 0;
    u.free = false;
    // THE one door out of the schedule. See the header: _toGhost would let
    // _scanCells re-mint this exact slot two lines later.
    this.traffic.steal(best);
    // steal() nulls car.ai, and vehicles.update() reads a car with no `ai` and
    // no `_grounded` as an abandoned one that has never been put on the ground:
    // it would write car.y from surfaceY() once, on whichever frame it runs
    // before us, and drop the car off its embankment for that frame. We put
    // this car on the road ourselves every step, so claim the flag now.
    best._grounded = true;
    u.car = best;
    this._sirenAt = this._t;                        // wail on the next update
    // A fresh pursuit starts WARM, and it stays warm for as long as this car
    // plausibly needs to arrive. Without the first term the unit is drafted
    // with no sight of you, `_coldAt` is still in the past, and the very next
    // update releases the car it just took; without the second the same thing
    // happens nine seconds later, while it is still closing. Both were real:
    // see the note on APPROACH_V.
    const away = dist(best.x - px, best.z - pz);
    this._coldAt = Math.max(this._coldAt,
      this._t + LOSE_T + Math.min(APPROACH_MAX, away / APPROACH_V));
  }

  // ---------------------------------------------------------- releasing ----

  // Stop chasing, keep driving. The car goes back to ordinary speed and
  // carries on down its rail until it is far enough away — or until
  // RELEASE_T gives up — and only then is the mesh taken.
  _letGo(u) {
    if (u.free || u.release) return;
    u.release = true;
    u.releaseAt = this._t + RELEASE_T;
    u.sees = false;
  }

  // The mesh goes. There is no way to hand a car back to traffic.js (see the
  // header), so this is a deletion — deferred as long as we can afford, which
  // is the same trade traffic.js makes for its own ghosts.
  _drop(u) {
    if (u.car) this.vehicles?.remove(u.car);
    u.car = null; u.edge = null;
    u.free = true; u.release = false; u.sees = false;
  }

  // -------------------------------------------------------------- sight ----

  // Who currently has the player, on an absolute-deadline clock per unit so
  // the building samples run at ~4.5 Hz and not three times a frame.
  _sight(px, pz) {
    let any = false;
    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free || u.release) { u.sees = false; continue; }
      if (this._t >= u.sightAt) {
        u.sightAt = this._t + SEE_DT;
        const d = dist(u.x - px, u.z - pz);
        u.sees = d <= SEE_NEAR || (d <= SEE_R && this._los(u.x, u.z, px, pz, d));
        if (u.sees) u.seenAt = this._t;
      }
      if (u.sees) any = true;
    }
    this.sees = any;
  }

  // Is the straight line clear of architecture? Samples every LOS_STEP metres,
  // exclusive of both ends (a unit standing in a gateway must not blind
  // itself). A missing city, a city without buildingAt, or an unstreamed chunk
  // all answer "clear" — see the header on which direction it is cheap to be
  // wrong in.
  _los(ax, az, bx, bz, d) {
    const city = this.city;
    if (this._losOff || !city || typeof city.buildingAt !== 'function') return true;
    let n = Math.ceil(d / LOS_STEP);
    if (n > LOS_MAX) n = LOS_MAX;
    // The try is not decoration. buildingAt reaches through `city.chunkIndex`,
    // which a partially-built or hand-made city may not have, and a TypeError
    // raised inside stepGame does not merely lose a sight test — js/vitals.js's
    // header has the case where one of those froze the renderer on its last
    // drawn frame, every frame. One failure switches the test off for the
    // session and the pursuit falls back to plain distance.
    try {
      for (let i = 1; i < n; i++) {
        const t = i / n;
        if (city.buildingAt(ax + (bx - ax) * t, az + (bz - az) * t)) return false;
      }
    } catch (err) {
      this._losOff = true;
      console.warn('[police] line of sight disabled:', err);
    }
    return true;
  }

  // -------------------------------------------------------------- siren ----

  // One voice for the whole pursuit, the nearest unit's, retriggered on an
  // absolute deadline. Two sirens on top of each other is not twice as
  // frightening, it is mush — the same argument audio.js makes for capping the
  // spoken lines at three.
  _siren(px, pz) {
    if (this._t < this._sirenAt) return;
    let near = null, nd = SIREN_R;
    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free || u.release) continue;
      const d = dist(u.x - px, u.z - pz);
      if (d < nd) { nd = d; near = u; }
    }
    if (!near) return;
    this._sirenAt = this._t + SIREN_GAP;
    // sfxAt applies gainAt's 1/r law and refuses anything inaudible, so the
    // distance question is asked in exactly one place in the whole game.
    sfxAt('siren_far', SIREN_VOL, near.x, near.z, SIREN_R);
  }

  // ------------------------------------------------------------- driving ----

  _drive(u, dt, tx, tz, px, pz, onFoot, slow) {
    const car = u.car;
    if (!car || !u.edge) { u.stuckT += dt; return; }
    if (dt <= 0) return;

    // The player rammed us. vehicles.js has already rewritten car.speed,
    // car.heading and car.x/z through its collision solver, so for the next
    // 2.5 s the physics owns the car and we only scrub it and keep it upright
    // — the same surrender traffic.js makes in _rammedStep, and for the same
    // reason: a car that snapped back onto its rail mid-shunt would read as an
    // immovable object rather than as a car you just hit.
    if ((car._rammedT ?? 0) > 0) { this._ram(u, dt); return; }

    const e = u.edge;
    const chase = !u.release;
    const dPlayer = dist(u.x - px, u.z - pz);

    // ---- the rubber band, and nothing else, is the cheat -----------------
    const band = chase
      ? 1 + (BAND_MAX - 1) * clamp01((dPlayer - BAND_NEAR) / (BAND_FAR - BAND_NEAR))
      : 1;
    const vk = chase ? COP_VK : IDLE_VK;
    let tgt = Math.min(e.speed * vk * band, COP_VMAX);

    // ---- corners, on traffic.js's own braking envelope -------------------
    // v² = vc² + 2·b·d, so speed bleeds off on the approach instead of at the
    // apex. The look-ahead has to scale with speed or a 150 km/h unit meets
    // every bend as an emergency.
    const look = Math.max(CORNER_LOOK, u.speed * u.speed / (2 * BRAKE) + 6);
    for (let k = u.seg + 1; k <= u.seg + 8 && k < e.pts.length - 1; k++) {
      const d = e.cum[k] - u.s;
      if (d > look) break;
      if (d < 0) continue;
      const a = e.vertAng[k];
      if (a > 0.06) {
        const v = Math.sqrt(cornerSpeed(a) ** 2 + 2 * BRAKE * d);
        if (v < tgt) tgt = v;
      }
    }
    // …and the turn at the end of this edge, which the polyline cannot know
    // about because it happens between two polylines.
    const dEnd = e.len - u.s;
    if (dEnd < look + 10) {
      const nx = this._pickNext(e, tx, tz);
      let ang = Math.PI;                       // no way on → crawl into the U-turn
      if (nx) {
        const dot = e.ldx * nx.fdx + e.ldz * nx.fdz;
        const crs = e.ldx * nx.fdz - e.ldz * nx.fdx;
        ang = Math.abs(Math.atan2(crs, dot));
      }
      if (ang > 0.06) {
        const v = Math.sqrt(cornerSpeed(ang) ** 2 + 2 * BRAKE * Math.max(dEnd, 0));
        if (v < tgt) tgt = v;
      }
    }

    // ---- what is in the way ---------------------------------------------
    this._leader(u, tgt, px, pz, onFoot);
    tgt = _lim.v;
    let hard = _lim.hard;

    // ---- arrived: there is nothing left to chase --------------------------
    const arrived = chase && slow && dPlayer < ARRIVE_R;
    if (arrived) { tgt = 0; hard = true; }

    // ---- integrate -------------------------------------------------------
    if (u.speed < tgt) u.speed = Math.min(tgt, u.speed + ACCEL * dt);
    else u.speed = Math.max(tgt, u.speed - (hard ? BRAKE_HARD : BRAKE_SOFT) * dt);

    // Standing still on purpose is not being stuck. Without the `arrived` term
    // a unit that has correctly pulled up beside a parked player is released
    // twenty seconds later for making no progress, and the pursuit throws away
    // the one car that had actually done its job.
    u.stuckT = (u.speed < STUCK_V && !arrived) ? u.stuckT + dt : 0;
    if (chase && u.stuckT > STUCK_T) { this._letGo(u); return; }

    // ---- advance along the rail, crossing nodes as needed ----------------
    // The loop condition reads u.edge, NOT the `e` captured at the top of this
    // method: after the first hop they are different edges, and comparing the
    // new arc against the old length is how a unit runs off the end of a short
    // edge and keeps the overshoot for ever. HOP_MAX bounds the whole thing —
    // a chain of half-metre edges must not spin here at 150 km/h.
    u.s += u.speed * dt;
    for (let hop = 0; hop < HOP_MAX && u.s >= u.edge.len; hop++) {
      const over = u.s - u.edge.len;
      const nx = this._pickNext(u.edge, tx, tz);
      if (!nx) { u.s = u.edge.len; u.speed = 0; break; }   // nowhere to go
      u.edge = nx; u.seg = 0; u.s = over;
    }
    if (u.s > u.edge.len) u.s = u.edge.len;
    if (!(u.s >= 0)) u.s = 0;

    this._place(u, dt);
  }

  // Nearest thing ahead in our corridor caps the speed. Every other car in the
  // city counts, including the other unit; the PLAYER does not, unless he is on
  // foot — a unit that brakes for your bumper can never reach it, and not
  // braking is the difference between a patrol and a pursuit. On foot he does
  // count, at FOOT_GAP, because there is no arrest in this slice and driving
  // over him is the only other thing that could happen.
  _leader(u, tgt, px, pz, onFoot) {
    const fx = -Math.sin(u.heading), fz = -Math.cos(u.heading);
    let v = tgt, hard = false;
    const reach = TRAFFIC.lookAhead, reach2 = reach * reach;
    const cars = this.traffic?.cars;
    if (cars) {
      for (const o of cars) {
        const rx = o.x - u.x, rz = o.z - u.z;
        if (rx * rx + rz * rz > reach2) continue;
        const fwd = rx * fx + rz * fz;
        if (fwd <= 0 || fwd > reach) continue;
        if (Math.abs(fx * rz - fz * rx) > LAT_GATE) continue;
        const gap = fwd - 3.9;                       // centres → bumpers
        if (gap < TRAFFIC.stopGap) { v = 0; hard = true; }
        else { const fv = (gap - TRAFFIC.stopGap) / 2; if (fv < v) v = fv; }
      }
    }
    for (let i = 0; i < this._pool.length; i++) {
      const o = this._pool[i];
      if (o === u || o.free) continue;
      const rx = o.x - u.x, rz = o.z - u.z;
      if (rx * rx + rz * rz > reach2) continue;
      const fwd = rx * fx + rz * fz;
      if (fwd <= 0 || fwd > reach) continue;
      if (Math.abs(fx * rz - fz * rx) > LAT_GATE) continue;
      const gap = fwd - 3.9;
      if (gap < TRAFFIC.stopGap) { v = 0; hard = true; }
      else { const fv = (gap - TRAFFIC.stopGap) / 2; if (fv < v) v = fv; }
    }
    if (onFoot) {
      const rx = px - u.x, rz = pz - u.z;
      const fwd = rx * fx + rz * fz;
      if (fwd > 0 && fwd < reach && Math.abs(fx * rz - fz * rx) < LAT_GATE + 1) {
        const gap = fwd - 2.4;
        if (gap < FOOT_GAP) { v = 0; hard = true; }
        else { const fv = (gap - FOOT_GAP) / 2; if (fv < v) v = fv; }
      }
    }
    _lim.v = v; _lim.hard = hard;
  }

  /**
   * Which way out of this edge's far node. Greedy: the outgoing edge whose far
   * end is nearest the aim point, with UTURN_PEN charged against turning back
   * the way we came. No search, no memory — see the header for the failure mode
   * this buys and the valve that covers it.
   */
  _pickNext(e, tx, tz) {
    const node = e.b;
    const outs = node && node.out;
    if (!outs || !outs.length) return null;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < outs.length; i++) {
      const c = outs[i];
      if (!c.pts || c.pts.length < 2) continue;
      let score = dist(c.b.x - tx, c.b.z - tz);
      // reversing: the new edge's first direction against our last one
      if (e.ldx * c.fdx + e.ldz * c.fdz < -0.5) score += UTURN_PEN;
      if (score < bestScore) { bestScore = score; best = c; }
    }
    return best;
  }

  // Pose from the polyline: centreline point, smoothed heading, right-hand lane
  // offset, and the height of the ROAD rather than of the ground — a car put on
  // raw terrain drives in the ditch beside the embankment the road is built on,
  // and under the deck of every bridge.
  _place(u, dt) {
    const e = u.edge;
    const pose = poseOn(e, u.s, u.seg);
    u.seg = pose.seg;
    const targetH = Math.atan2(-pose.dx, -pose.dz);
    u.heading = angWrap(u.heading + angWrap(targetH - u.heading) * Math.min(1, TURN_RATE * dt));
    const offTgt = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    u.laneOff += (offTgt - u.laneOff) * Math.min(1, 3 * dt);
    const hx = -Math.sin(u.heading), hz = -Math.cos(u.heading);
    u.x = pose.x - hz * u.laneOff;                 // right of heading = (−hz, hx)
    u.z = pose.z + hx * u.laneOff;
    u.y = this._roadY(u);
    this._write(u, dt);
  }

  _roadY(u) {
    const e = u.edge, rd = e.road;
    const terrain = this.traffic?.world?.terrain ?? null;
    const along = e.off0 + e.offSign * u.s;
    const y = rd.br
      ? bridgeDeckHeight(rd, along, terrain)
      : (roadGradeY(rd, along, terrain) ?? (terrain?.heightAt(u.x, u.z) ?? 0));
    return (Number.isFinite(y) ? y : 0) + LAYER_Y.road;
  }

  // Publish the pose onto the car AND onto its mesh. vehicles.update() would do
  // the mesh for us — it syncs every car it owns from x/z/y/heading — but only
  // if main.js happens to call it after us, and a police car one frame behind
  // its own position is exactly the kind of stutter nobody can source. Writing
  // both makes the order not matter, which is what traffic.js does too.
  _write(u, dt) {
    const car = u.car;
    car.x = u.x; car.z = u.z; car.y = u.y;
    // Front wheels point where the car is turning. Traffic never sets this, so
    // its cars slide round corners on straight wheels; ours costs one line.
    const dh = angWrap(u.heading - car.heading);
    car.steer = Math.max(-0.6, Math.min(0.6, dh / Math.max(dt, 1e-3) * 0.35));
    car.heading = u.heading;
    car.speed = u.speed;
    const m = car.mesh;
    if (m) {
      m.position.set(u.x, u.y, u.z);
      m.rotation.y = u.heading;
    }
  }

  // A shunt: let it slide on the heading the impulse gave it, scrubbing
  // friction, then find our own edge again. The recovery searches only the edge
  // we were already on — a collision rarely moves a car more than a lane, and
  // hunting the whole graph for a better rail is how a rammed car ends up
  // driving down the pavement.
  _ram(u, dt) {
    const car = u.car;
    car._rammedT -= dt;
    const s = car.speed;
    car.speed = s > 0 ? Math.max(0, s - RAM_FRICTION * dt)
      : Math.min(0, s + RAM_FRICTION * dt);
    car.x += -Math.sin(car.heading) * car.speed * dt;
    car.z += -Math.cos(car.heading) * car.speed * dt;
    u.x = car.x; u.z = car.z; u.heading = car.heading; u.speed = car.speed;
    // y is left exactly where it was: for the 2.5 s of a shunt the car has no
    // arc length worth trusting, and re-reading the road grade off a bogus one
    // would drop it through a bridge deck into the Labe.
    const m = car.mesh;
    if (m) { m.position.set(car.x, car.y, car.z); m.rotation.y = car.heading; }
    if (car._rammedT > 0) return;

    const e = u.edge, pts = e.pts;
    let bd = 1e9, bs = u.s, bseg = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distPointToSegment(car.x, car.z, pts[i][0], pts[i][1],
        pts[i + 1][0], pts[i + 1][1], _snap);
      if (d < bd) { bd = d; bseg = i; bs = e.cum[i] + _snap.t * (e.cum[i + 1] - e.cum[i]); }
    }
    u.s = bs; u.seg = bseg;
    u.speed = Math.max(0, car.speed);
  }

  // --------------------------------------------------------------- admin ----

  /**
   * Every unit gone, now. A restart, a teleport or a dev key is not a moment
   * for the polite drive-away: the cars are deleted where they stand, because
   * whatever is about to happen to the world would strand them anyway.
   */
  reset() {
    for (let i = 0; i < this._pool.length; i++) this._drop(this._pool[i]);
    this.units.length = 0;
    this.cars.length = 0;
    this.sees = false;
    this._t = this._now();
    this._recruitAt = 0;
    this._sirenAt = 0;
    this._coldAt = 0;
    this._hasLast = false;
  }

  dispose() {
    this.reset();
    this.traffic = null;
    this.vehicles = null;
    this.wanted = null;
    this.city = null;
    this.scene = null;
  }
}

export default Police;
