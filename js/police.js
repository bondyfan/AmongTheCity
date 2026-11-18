// ==========================================================================
// Police — what the patrol does once it wants you
//
// WHAT IT DOES NOW (round 7). The stars buy cars and the cars do things:
//
//   1 star   one patrol. It follows; if you stop, it pulls up and the officer
//            gets out, takes cover behind the car and draws a pistol.
//   2 stars  two patrols, and the tail car may RAM you (telegraphed: it lines
//            up behind you, sounds its horn, then commits).
//   3 stars  three, and the third aims AHEAD of you so it comes down a
//            parallel street and blocks the road; the tail cars may PIT you.
//   4, 5     four and five cars, a higher ceiling speed and shorter reactions.
//
// The numbers per star are js/policetune.js. The last thirty metres (follow,
// ram, PIT, pull up, block) are js/policeram.js: there a unit leaves its rail
// and drives at you as a free body, and every contact is vehicles.js's own
// car-to-car solver. The officers on foot are js/policecops.js and their
// rounds js/copfire.js: real traces that can miss, hit the car or hit you,
// through vitals.damage(), so dying to them is the ordinary death card, the
// hospital, the fee and the fine. Units are real patrol cars (traffic.js's
// livery and light bar): an ambient patrol is commandeered when one is near,
// otherwise one is called in on a road out of your sight.
//
// The sections below are the pursuit as first written (the rail chase, the
// rubber band, losing them); they still describe how a unit drives until it
// is close.
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
import { tierFor, MAX_UNITS, motorwayVmax } from './policetune.js';
import { mwCornerV } from './mwtraffic.js';
import { wantsFree, enterFree, freeStep, rejoin, BLEND } from './policeram.js';
import { Officers } from './policecops.js';
import { Gunfire } from './copfire.js';
import * as VITALS from './vitals.js';
import { sameLevel } from './levelsep.js';

// ---- how many, and when --------------------------------------------------
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
// A real patrol car first: an ambient one (traffic.js, livery and light bar)
// nearer than this is commandeered; otherwise one is called in on a road
// SPAWN_MIN to SPAWN_MAX from you, out of your sight when there is a choice.
const PATROL_R = 420;
const SPAWN_MIN = 170, SPAWN_MAX = 330, SPAWN_IDEAL = 230;
const SPAWN_SEEN_PEN = 90;      // m of score a road you can see costs
const DEPLOY_R = 26;            // m: a unit stopped this near a stopped player parks
const DEPLOY_SLOW_T = 0.8;      // s the player must have been stopped first
const FOOT_DEPLOY_R = 120;      // m: on foot off the road, the crew walks from this far
const FOOT_STALL_T = 2.5;       // s of not closing before a unit gives up on the lane
const LEAVE_T = 1.5;            // s a parked unit waits after its crew is back in

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

    // ---- round 7: escalation, rams, officers, gunfire ----
    this.rnd = typeof opts.rnd === 'function' ? opts.rnd : Math.random;
    this.vitals = opts.vitals ?? VITALS;
    /** The star tier in force (js/policetune.js), null at zero stars. */
    this.tier = null;
    /** Counters for tests and the dev overlay. Never reset by the chase. */
    this.stats = { recruits: 0, commandeered: 0, spawned: 0, civilian: 0, deploys: 0,
      contacts: 0, rams: 0, ramTries: 0, pits: 0, pitTries: 0 };
    /** Where the player is, how fast and which way: one record, rewritten. */
    this.P = { x: 0, z: 0, y: 0, car: null, onFoot: true, heading: 0, speed: 0,
      fx: 0, fz: -1, rx: 1, rz: 0, slow: true, slowSince: 0, valid: false };
    const city = this.city;
    this._groundAt = city && typeof city.walkY === 'function' ? (x, z) => city.walkY(x, z)
      : (city?.footing?.heightAt ? (x, z) => city.footing.heightAt(x, z) : null);
    this.gunfire = new Gunfire({ scene: this.scene, city, vitals: this.vitals, rnd: this.rnd });
    this.officers = new Officers({
      scene: this.scene, gunfire: this.gunfire, groundAt: this._groundAt,
      los: (ax, az, bx, bz, d) => d <= SEE_NEAR * 0.5 || this._los(ax, az, bx, bz, d),
      blocked: (x, z) => this._blocked(x, z),
      makeBody: opts.makeBody, say: opts.say ?? null, wanted: this.wanted, rnd: this.rnd,
      onArrest: opts.onArrest ?? null, onTackle: opts.onTackle ?? null,
    });
    this._ramGateAt = 0;          // the force-wide gap between two shunts
    /** Standing hulls for traffic.blockers (main.js): a stopped unit and the
     *  officers on foot, so the traffic waits behind them instead of driving
     *  through. Records are pooled and rewritten in _sync. */
    this.blockers = [];
    this._blk = [];
    for (let i = 0; i < POOL_N + 12; i++) this._blk.push({ x: 0, z: 0, half: 0 });
    this._notOurs = (c) => !!(c.ai && c.ai.edge && c.ai.edge.pts);
    this._copCtx = { t: 0, px: 0, pz: 0, py: 0, pcar: null, onFoot: true, pspeed: 0, tier: null, down: false, lying: false };
  }

  _now() { return this.clock ? this.clock() : worldT(); }

  _blank() {
    return {
      free: true, car: null, edge: null, s: 0, seg: 0,
      x: 0, z: 0, y: 0, heading: 0, speed: 0, laneOff: 0,
      sees: false, seenAt: -1e9, sightAt: 0, stuckT: 0,
      release: false, releaseAt: 0,
      // round 7
      mode: 'rail', sub: '', subAt: 0, role: 0, freeAt: 0, blindAt: 0, wallT: 0,
      contactAt: -1e9, ramCdAt: 0, pitSide: 1, bx: 0, bz: 0, blendNew: false,
      parkedAt: 0, warned: false, spawned: false, dead: false,
      bestD: Infinity, bestAt: 0, stall: false,
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
    // On foot unless in a car; a caller that knows (main.js passes it) can say
    // "neither" for the helicopter and the jet, which nobody shoots at.
    const onFoot = pcar ? false : (ctx.onFoot !== undefined ? !!ctx.onFoot : true);

    // How many cars this heat level is worth, and how they behave: the tier.
    const stars = this._stars();
    const tier = tierFor(stars);
    this.tier = tier;
    const want = tier ? tier.units : 0;
    const P = this._player(px, pz, pcar, onFoot, ctx, step);

    // Sight first: it decides where everybody drives this step, and it decides
    // whether the pursuit is still warm.
    this._sight(px, pz);

    // The aim point. While somebody has you it leads your own velocity, so a
    // unit at a junction picks the street you turned into rather than the one
    // you were in when it got there. While nobody has you it is the last place
    // anybody did; that stale target is the whole feel of a break.
    let tx = px, tz = pz, lead = 0;
    if (this.sees) {
      if (pcar) {
        lead = Math.min(LEAD_MAX, P.speed * LEAD_T);
        tx = px + P.fx * lead;
        tz = pz + P.fz * lead;
      }
      this._lastX = px; this._lastZ = pz; this._hasLast = true;
      this._coldAt = this._t + LOSE_T;
    } else if (this._hasLast) {
      tx = this._lastX; tz = this._lastZ;
    }

    // THE COLD RULE, and the ordering matters. "Cold" means no unit has had you
    // for LOSE_T, and the answer to that is to give the cars back. Going cold
    // must NOT stop the recruiter: two seconds later a patrol that is actually
    // NEAR you is drafted, which is the manhunt (see LOSING THEM above).
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
    this._roles();

    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free) continue;
      // Each unit its own aim (the box): the first follows your lead, the
      // second leads you twice as far, the third and later aim well AHEAD and
      // to one side, so the greedy router brings them in from in front.
      let ax = tx, az = tz;
      if (this.sees && pcar && !u.release) {
        // (with only two cars out, at two stars, the second is the one that
        // goes ahead to block: there is no third to do it)
        const boxer = tier && tier.box && u.role >= Math.min(2, tier.units - 1);
        if (u.role === 1 && !boxer) { ax = px + P.fx * lead * 2; az = pz + P.fz * lead * 2; }
        else if (boxer) {
          const ahead = Math.min(160, 30 + P.speed * 5);
          const side = (u.role & 1) ? 22 : -22;
          ax = px + P.fx * ahead + P.rx * side;
          az = pz + P.fz * ahead + P.rz * side;
        }
      }
      this._drive(u, step, ax, az, px, pz, onFoot, P.slow, tier);
      if (u.release && (this._t >= u.releaseAt
        || dist(u.x - px, u.z - pz) > RELEASE_R)) this._drop(u);
    }

    // The officers on foot, and their rounds.
    const cc = this._copCtx;
    cc.t = this._t; cc.px = px; cc.pz = pz; cc.py = P.y; cc.pcar = pcar;
    cc.onFoot = onFoot; cc.pspeed = P.speed; cc.tier = tier;
    cc.down = typeof this.vitals?.down === 'function' ? !!this.vitals.down() : false;
    cc.lying = !!ctx.lying;        // thrown to the ground: he is not going anywhere
    this.officers.update(step, cc);
    this.gunfire.update(step);
    // An officer on foot who has you is the unit having you: wanted.js reads
    // the units' flags, and a man being shot at is not "unseen".
    const out = this.officers.out;
    for (let i = 0; i < out.length; i++) {
      const r = out[i];
      if (r.sees && r.state !== 'down' && r.unit && !r.unit.release) {
        r.unit.sees = true; r.unit.seenAt = this._t; this.sees = true;
        this._lastX = px; this._lastZ = pz; this._hasLast = true;
        this._coldAt = this._t + LOSE_T;
      }
    }

    this._siren(px, pz);
    this._sync();
  }

  // The player record every unit and officer reads: where, which way, how
  // fast (a car's own speed, or the distance the feet covered), and whether he
  // has STOPPED, which is what turns a chase into officers on foot.
  _player(px, pz, pcar, onFoot, ctx, step) {
    const P = this.P;
    let h = P.heading, v = 0;
    if (pcar) { h = Number.isFinite(pcar.heading) ? pcar.heading : h; v = Math.abs(pcar.speed ?? 0); }
    else if (P.valid && step > 0) {
      const dx = px - P.x, dz = pz - P.z, d = dist(dx, dz);
      if (d < 20) {                               // a teleport is not a sprint
        v = d / step;
        if (d > 0.02) h = Math.atan2(-dx, -dz);
      }
    }
    P.x = px; P.z = pz; P.car = pcar; P.onFoot = onFoot; P.valid = true;
    P.heading = h; P.speed = v;
    P.fx = -Math.sin(h); P.fz = -Math.cos(h); P.rx = -P.fz; P.rz = P.fx;
    if (Number.isFinite(ctx.y)) P.y = ctx.y;
    else if (pcar && Number.isFinite(pcar.y)) P.y = pcar.y;
    else if (this._groundAt) { const g = this._groundAt(px, pz); if (Number.isFinite(g)) P.y = g; }
    const slow = onFoot || (!!pcar && v < ARRIVE_V);
    if (slow && !P.slow) P.slowSince = this._t;
    P.slow = slow;
    return P;
  }

  // Box roles, by pool order among the live units: 0 tails, 1 leads, 2+ head
  // you off. Stable, because the pool order is.
  _roles() {
    let r = 0;
    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free || u.release) continue;
      u.role = r++;
    }
  }

  // Rebuild the two public lists in place — length = 0 and push, so a caller
  // iterating them every frame never sees a fresh array and we never allocate.
  _sync() {
    this.units.length = 0;
    this.cars.length = 0;
    this.blockers.length = 0;
    let nb = 0;
    const blk = this._blk;
    for (let i = 0; i < this._pool.length; i++) {
      const u = this._pool[i];
      if (u.free) continue;
      if (u.car) {
        this.cars.push(u.car);
        if (Math.abs(u.speed) < 1 && nb < blk.length) {
          const b = blk[nb++];
          b.x = u.car.x; b.z = u.car.z; b.half = (u.car.len ?? 4.4) / 2 + 0.35; b.y = u.car.y;
          this.blockers.push(b);
        }
      }
      if (!u.release) this.units.push(u);
    }
    const out = this.officers?.out;
    if (out) for (let i = 0; i < out.length && nb < blk.length; i++) {
      const b = blk[nb++];
      b.x = out[i].x; b.z = out[i].z; b.half = 0.9; b.y = out[i].y;
      this.blockers.push(b);
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
    let u = null;
    for (let i = 0; i < this._pool.length && !u; i++)
      if (this._pool[i].free) u = this._pool[i];
    if (!u) return;
    const tr = this.traffic;
    let car = null, spawned = false;

    // 1. A real patrol already on the road near you: it keeps its livery and
    //    its bar, and the transformation is just its blues coming on.
    if (typeof tr.nearestPatrol === 'function') {
      const c = tr.nearestPatrol(px, pz, PATROL_R, this._notOurs);
      if (c && c.ai && c.ai.edge && c.ai.edge.pts) {
        const p = c.ai;
        u.edge = p.edge; u.s = p.s; u.seg = p.seg; u.laneOff = p.laneOff ?? 0;
        u.x = c.x; u.z = c.z; u.y = c.y ?? 0;
        u.heading = c.heading; u.speed = Math.max(0, c.speed ?? 0);
        tr.steal(c);
        car = c;
        this.stats.commandeered++;
      }
    }
    // 2. Called in: a patrol built on a road out of your sight, driving your way.
    if (!car && typeof tr.spawnPatrol === 'function') {
      const e = this._spawnRail(px, pz);
      if (e) {
        const s = Math.min(e.len - 2, Math.max(2, e.len * 0.5));
        const pose = poseOn(e, s, 0);
        const heading = Math.atan2(-pose.dx, -pose.dz);
        const off = Math.min(TRAFFIC.laneOffsetK * (e.road?.w ?? 6), TRAFFIC.laneOffsetMax);
        u.edge = e; u.s = s; u.seg = pose.seg; u.laneOff = off;
        u.heading = heading;
        u.x = pose.x - pose.dz * off; u.z = pose.z + pose.dx * off;
        u.y = this._roadY(u);
        u.speed = Math.min(e.speed, 12);
        car = tr.spawnPatrol(u.x, u.z, heading);
        if (car) {
          car.y = u.y;
          if (car.mesh) { car.mesh.position.set(u.x, u.y, u.z); car.mesh.rotation.y = heading; }
          spawned = true;
          this.stats.spawned++;
        }
      }
    }
    // 3. The first slice's fallback, for a traffic without patrols (a bare
    //    fixture): the nearest car a patrol would be in, out of the flow.
    if (!car) {
      const cars = tr.cars;
      if (!cars || !cars.size) return;
      let best = null, bestScore = Infinity;
      for (const c of cars) {
        const p = c.ai;
        if (!p || !p.edge || !p.edge.pts) continue;   // not traffic's to lend
        if (!PATROL_KINDS.has(c.kind)) continue;
        const d = dist(c.x - px, c.z - pz);
        if (d > PICK_MAX) continue;
        let score = d;
        if (d < PICK_MIN) score += (PICK_MIN - d) * 2.5;
        if (c.kind !== 'octavia') score += KIND_PEN;
        if (score < bestScore) { bestScore = score; best = c; }
      }
      if (!best) return;                              // no patrol, no pursuit
      const p = best.ai;
      // Copy the rail state BEFORE the steal: steal() nulls car.ai.
      u.edge = p.edge; u.s = p.s; u.seg = p.seg;
      u.laneOff = p.laneOff ?? 0;
      u.x = best.x; u.z = best.z; u.y = best.y ?? 0;
      u.heading = best.heading; u.speed = Math.max(0, best.speed ?? 0);
      // THE one door out of the schedule. See the header: _toGhost would let
      // _scanCells re-mint this exact slot two lines later.
      tr.steal(best);
      car = best;
      this.stats.civilian++;
    }
    u.sees = false; u.seenAt = -1e9; u.sightAt = 0; u.stuckT = 0;
    u.release = false; u.releaseAt = 0;
    u.mode = 'rail'; u.sub = ''; u.bx = 0; u.bz = 0; u.blendNew = false;
    u.contactAt = -1e9; u.ramCdAt = 0; u.warned = false; u.dead = false;
    u.bestD = Infinity; u.bestAt = this._t; u.stall = false;
    u.spawned = spawned;
    u.free = false;
    // vehicles.update() reads a car with no `ai` and no `_grounded` as an
    // abandoned one and would re-seat it on the terrain once, dropping it off
    // its embankment for a frame. We put this car on the road every step.
    car._grounded = true;
    car.police = true;
    car._rammedT = 0;
    u.car = car;
    try { tr.setSiren?.(car, true); } catch (err) { /* a fixture without bars */ }
    this.stats.recruits++;
    this._sirenAt = this._t;                        // wail on the next update
    // A fresh pursuit starts WARM, and it stays warm for as long as this car
    // plausibly needs to arrive (see the note on APPROACH_V).
    const away = dist(u.x - px, u.z - pz);
    this._coldAt = Math.max(this._coldAt,
      this._t + LOSE_T + Math.min(APPROACH_MAX, away / APPROACH_V));
  }

  // A road to call a unit in on: SPAWN_MIN to SPAWN_MAX away, a real street
  // (long and fast enough to be one), running TOWARDS you, and preferably one
  // you cannot see from where you stand. A linear walk of traffic.edges, run at
  // most once per RECRUIT_CD; the sight test runs only for a candidate that
  // already beats the best, so it is a handful of samples, not thousands.
  _spawnRail(px, pz, any = false) {
    const edges = this.traffic?.edges;
    if (!edges || !edges.length) return null;
    let best = null, bestScore = Infinity;
    const r0 = SPAWN_MIN * SPAWN_MIN, r1 = SPAWN_MAX * SPAWN_MAX;
    // Round 8: a player on a motorway carriageway is chased on THAT
    // carriageway. A unit born on the other one, running at the player, can
    // only reach them across the central barrier (or kilometres round an
    // interchange): it is born behind them on their own side instead.
    const pc = any ? null : this._carriageway(px, pz);
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (!e.pts || e.pts.length < 2 || !(e.len >= 20) || !(e.speed >= 7)) continue;
      if (pc && (e.mw !== 1 || e.fdx * pc.dx + e.fdz * pc.dz < 0.5)) continue;
      if (e.road?.br) continue;                       // never born on a bridge deck
      const mx = e.mx ?? e.pts[0][0], mz = e.mz ?? e.pts[0][1];
      const dx = px - mx, dz = pz - mz, d2 = dx * dx + dz * dz;
      if (d2 < r0 || d2 > r1) continue;
      const d = Math.sqrt(d2);
      const toward = (e.fdx * dx + e.fdz * dz) / d;   // running at you?
      if (toward < 0.2) continue;
      let score = Math.abs(d - SPAWN_IDEAL) + (1 - toward) * 60;
      if (score >= bestScore) continue;
      if (this._los(mx, mz, px, pz, d) && d < SEE_R + 40) score += SPAWN_SEEN_PEN;
      if (score < bestScore) { bestScore = score; best = e; }
    }
    // (nothing on their side in range: the old rule, rather than no unit at all)
    if (!best && pc) return this._spawnRail(px, pz, true);
    return best;
  }

  // The direction of the motorway carriageway the player is on, or null
  // (within 8 m of a carriageway centreline: the lanes and the shoulder).
  _carriageway(px, pz) {
    const g = this.traffic?._egrid;
    if (!g?.near) return null;
    let best = 64, out = null;
    g.near(px, pz, (e) => {
      if (e.mw !== 1) return;
      const P = e.pts;
      for (let k = 0; k < P.length - 1; k++) {
        const ax = P[k][0], az = P[k][1], ex = P[k + 1][0] - ax, ez = P[k + 1][1] - az;
        const L2 = ex * ex + ez * ez;
        if (!(L2 > 1e-6)) continue;
        let t = ((px - ax) * ex + (pz - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = px - ax - ex * t, qz = pz - az - ez * t, d2 = qx * qx + qz * qz;
        if (d2 < best) { best = d2; const L = Math.sqrt(L2); out = { dx: ex / L, dz: ez / L }; }
      }
    });
    return out;
  }

  // ---------------------------------------------------------- releasing ----

  // Stop chasing, keep driving. The car goes back to ordinary speed and
  // carries on down its rail until it is far enough away — or until
  // RELEASE_T gives up — and only then is the mesh taken.
  _letGo(u) {
    if (u.free || u.release) return;
    u.release = true;
    u.releaseAt = u.dead ? Infinity : this._t + RELEASE_T;
    u.sees = false;
    this.officers.recall(u);
    try { this.traffic?.setSiren?.(u.car, false); } catch (err) { /* fixture */ }
  }

  // The mesh goes. There is no way to hand a car back to traffic.js (see the
  // header), so this is a deletion — deferred as long as we can afford, which
  // is the same trade traffic.js makes for its own ghosts.
  _drop(u) {
    this.officers.dropUnit(u);
    if (u.car) {
      try { this.traffic?.setSiren?.(u.car, false); } catch (err) { /* fixture */ }
      this.vehicles?.remove(u.car);
    }
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

  _drive(u, dt, tx, tz, px, pz, onFoot, slow, tier) {
    const car = u.car;
    if (!car) { u.stuckT += dt; return; }
    if (dt <= 0) return;

    // ---- round 7: parked with its crew out, or off the rail near you ------
    if (u.mode === 'parked') { this._parked(u, dt); return; }
    if (u.mode === 'free') {
      if (!u.release && freeStep(this, u, dt, this.P, tier)) {
        this._maybeDeploy(u, tier);
        return;
      }
      if (!rejoin(this, u)) {
        // no lane in reach: a released car simply goes, a chasing one waits
        // for the stuck valve
        if (u.release) { this._drop(u); return; }
        u.stuckT += dt;
        if (u.stuckT > STUCK_T) this._letGo(u);
        return;
      }
    }
    if (!u.edge) { u.stuckT += dt; return; }

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
    // The tier widens the band and lifts the ceiling from four stars up.
    const bandMax = tier ? tier.band : BAND_MAX;
    const near = tier ? tier.near : BAND_NEAR;
    const band = chase
      ? 1 + (bandMax - 1) * clamp01((dPlayer - near) / (BAND_FAR - near))
      : 1;
    const vk = chase ? COP_VK : IDLE_VK;
    let ceil = tier ? tier.vmax : COP_VMAX;
    // (round 8: on a motorway carriageway the ceiling follows the player up,
    // js/policetune.js motorwayVmax, or no D11 chase could ever be won)
    if (chase && e.mw === 1) ceil = motorwayVmax(ceil, this.P?.speed ?? 0);
    let tgt = Math.min(e.speed * vk * band, ceil);

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
        // (a motorway vertex is a long gentle turn, js/mwtraffic.js mwCornerV)
        const vc = e.mw ? mwCornerV(a, Math.min(e.cum[k] - e.cum[k - 1], e.cum[k + 1] - e.cum[k])) : cornerSpeed(a);
        const v = Math.sqrt(vc * vc + 2 * BRAKE * d);
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
        const vc = e.mw && nx?.mw ? mwCornerV(ang, Math.min(e.cum[e.pts.length - 1] - e.cum[e.pts.length - 2], nx.cum[1])) : cornerSpeed(ang);
        const v = Math.sqrt(vc * vc + 2 * BRAKE * Math.max(dEnd, 0));
        if (v < tgt) tgt = v;
      }
    }

    // ---- what is in the way ---------------------------------------------
    this._leader(u, tgt, px, pz, onFoot);
    tgt = _lim.v;
    let hard = _lim.hard;

    // ---- arrived: there is nothing left to chase --------------------------
    let arrived = chase && slow && dPlayer < ARRIVE_R;
    // A man on foot off the carriageway (a forecourt, a park, a yard): the
    // lane never gets nearer than it is. Once a unit that can see him has
    // stopped closing for FOOT_STALL_T it pulls up where it is and the crew
    // goes the rest of the way on foot.
    if (chase && onFoot && u.sees && dPlayer < FOOT_DEPLOY_R) {
      if (dPlayer < u.bestD - 2) { u.bestD = dPlayer; u.bestAt = this._t; }
      else if (this._t - u.bestAt > FOOT_STALL_T) { arrived = true; u.stall = true; }
    } else { u.bestD = Infinity; u.bestAt = this._t; u.stall = false; }
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

    // Close, in sight, something on the ground to drive at: off the rail.
    if (chase && tier && wantsFree(u, this.P, dist(u.x - px, u.z - pz))) {
      enterFree(u, this.P, this._t, tier);
      return;
    }
    if (arrived) this._maybeDeploy(u, tier);
  }

  // A unit that has pulled up near a stopped player parks and puts its crew
  // out. Once: a unit with officers out is 'parked' until they are back in.
  _maybeDeploy(u, tier) {
    const P = this.P;
    if (u.release || !tier || !P.slow || !u.sees) return;
    if (this._t - P.slowSince < DEPLOY_SLOW_T) return;
    if (Math.abs(u.speed) > 0.7) return;
    if (!P.car && !P.onFoot) return;
    if (dist(u.x - P.x, u.z - P.z) > (u.stall ? FOOT_DEPLOY_R : DEPLOY_R)) return;
    u.mode = 'parked'; u.sub = ''; u.parkedAt = this._t; u.warned = false;
    u.speed = 0;
    if (u.car) { u.car.speed = 0; u.car._lat = 0; }
    this.officers.deploy(u, tier.cops);
    this.stats.deploys++;
  }

  // Parked: the car is a solid, still thing (the solver may shove it, and we
  // keep what it did). When the crew is back in it leaves: back to the lane.
  _parked(u, dt) {
    const car = u.car;
    u.x = car.x; u.z = car.z; u.heading = car.heading;
    const s = car.speed ?? 0;
    car.speed = s > 0 ? Math.max(0, s - 8 * dt) : Math.min(0, s + 8 * dt);
    car.x += -Math.sin(car.heading) * car.speed * dt;
    car.z += -Math.cos(car.heading) * car.speed * dt;
    u.x = car.x; u.z = car.z; u.speed = car.speed;
    if ((car._rammedT ?? 0) > 0) car._rammedT = Math.max(0, car._rammedT - dt);
    if (car.mesh) { car.mesh.position.set(car.x, car.y, car.z); car.mesh.rotation.y = car.heading; }
    const O = this.officers;
    if (O.allDown(u)) {
      // nobody left to drive it: it stands where it is until you are far away
      if (!u.dead) { u.dead = true; this._letGo(u); u.releaseAt = Infinity; }
      return;
    }
    if (!O.allIn(u)) { u.parkedAt = this._t; return; }
    if (this._t - u.parkedAt < LEAVE_T) return;
    if (!rejoin(this, u)) { u.mode = 'free'; enterFree(u, this.P, this._t, this.tier); }
  }

  // Free-mode height: the player's own height carried over the terrain
  // difference, so a unit beside you on a bridge deck is on the deck too.
  _freeY(u, P) {
    const g = this._groundAt;
    const ref = P.car ? P.car.y : P.y;
    if (!Number.isFinite(ref)) return u.y;
    if (!g) return ref;
    const gp = g(P.x, P.z), gu = g(u.x, u.z);
    if (!Number.isFinite(gp) || !Number.isFinite(gu)) return ref;
    return Math.abs(ref - gp) < 1.2 ? gu + (ref - gp) + (P.car ? 0 : LAYER_Y.road) : ref;
  }

  _blocked(x, z) {
    const city = this.city;
    if (this._losOff || !city || typeof city.buildingAt !== 'function') return false;
    try { return !!city.buildingAt(x, z); } catch (err) { this._losOff = true; return false; }
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
        if (!sameLevel(u.y, o.y, fwd)) continue;     // on another level (js/levelsep.js)
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
      if (!sameLevel(u.y, o.y, fwd)) continue;
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
    let offTgt = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    // Cars parked along this kerb (js/kerbparking.js): keep off their flanks,
    // exactly as traffic.js does for its own cars. This file restated the lane
    // offset before kerb parking existed, and the car drove through the row.
    const tr = this.traffic;
    if (tr?.kerbOf && e.road && tr.kerbOf(e.road) === -e.offSign)
      offTgt = Math.max(0, Math.min(offTgt, e.road.w / 2 - tr.kerbIntrudes - 0.35 - (u.car?.wid ?? 1.81) / 2));
    u.laneOff += (offTgt - u.laneOff) * Math.min(1, 3 * dt);
    const hx = -Math.sin(u.heading), hz = -Math.cos(u.heading);
    const rx = pose.x - hz * u.laneOff;            // right of heading = (−hz, hx)
    const rz = pose.z + hx * u.laneOff;
    // Coming back from free driving (or a shunt) the car is where the physics
    // left it, not on the lane: carry the difference and let it decay, so it
    // steers back over a second instead of popping sideways.
    if (u.blendNew) { u.bx = u.x - rx; u.bz = u.z - rz; u.blendNew = false; }
    // `|| 0`: a record built by hand (a test, an old pool) has no blend at all
    if (!u.bx) u.bx = 0;
    if (!u.bz) u.bz = 0;
    if (u.bx !== 0 || u.bz !== 0) {
      const k = Math.exp(-BLEND * dt);
      u.bx *= k; u.bz *= k;
      if (Math.abs(u.bx) + Math.abs(u.bz) < 0.02) { u.bx = 0; u.bz = 0; }
    }
    u.x = rx + u.bx;
    u.z = rz + u.bz;
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
    u.x = car.x; u.z = car.z; u.blendNew = true;    // steer back, do not snap
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
    this.blockers.length = 0;
    this.sees = false;
    this._t = this._now();
    this._recruitAt = 0;
    this._sirenAt = 0;
    this._coldAt = 0;
    this._hasLast = false;
    this.officers.reset();
    this.P.valid = false;
  }

  dispose() {
    this.reset();
    this.officers.dispose();
    this.gunfire.dispose();
    this.traffic = null;
    this.vehicles = null;
    this.wanted = null;
    this.city = null;
    this.scene = null;
  }
}

export default Police;
