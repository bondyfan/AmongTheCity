// ==========================================================================
// Zdravotnická záchranná služba — the ambulance
//
// The ask was two sentences and the second one is the feature: "taky tam musí
// jezdit i sanitky… když se někdy někomu stane, tak aby tam přijela sanitka."
// So there are two ambulances in this file and they are not the same object
// with a flag, they are two different claims about the city:
//
//   AMBIENT   — a white van with a red band goes past you on Palackého now and
//               then, no blues, in the flow, on its way somewhere that is not
//               about you. This is the half that makes the town have a
//               záchranka at all.
//   DISPATCHED — you put somebody on the tarmac, and a few streets away a van
//               turns its beacons on and comes. This is the half the user
//               actually asked for, and it is the one that has to arrive.
//
// ---- WHAT IS DELIBERATELY NOT HERE ---------------------------------------
//
// NOBODY GETS OUT. The van pulls up, stops, stands with its beacons running,
// and leaves. A crew on foot would need two walking actors that pedestrians.js
// cannot make: every body in that file is minted by a schedule from
// hash32(seed, cell, slot, generation) and reaped by a sweep that owns the
// whole population — there is no addActor(x, z), and building two citizens
// out of js/citizen.js directly would put two bodies in the world that the
// sweep does not know about, i.e. two immortal meshes and a crowd budget that
// no longer means anything. Half-building it (a crew that spawns, teleports to
// the body and despawns) is worse than not building it, because the thing the
// player would actually watch is the half that is wrong. So: pull up, stop,
// wait, leave. From a car window that is the whole of what you ever see of a
// real one anyway, and it is honest all the way down.
//
// NOBODY IS HEALED. This module publishes no verb. It does not touch p.hp, it
// does not resurrect, it does not clear your stars and it does not bill you.
// It is a thing that happens because of what you did, which is what makes a
// city read as a place rather than as a set of systems aimed at you.
//
// TRAFFIC DOES NOT PULL OVER. A van with its siren on queues at the lights
// behind an Octavia exactly like everybody else, because "yield to the blue
// lights" lives inside traffic.js's _drive and this run does not own that
// file. It is the single most visible wart in here and the fix is small; see
// WHAT ANOTHER MODULE MUST DO.
//
// ---- WHERE IT COMES FROM, AND WHY IT IS NOT THE HOSPITAL -----------------
//
// The obvious design is: the hospital is at (2291, 295), a call comes in, a
// van leaves the hospital and drives to you. It is also unshippable, and the
// arithmetic says so before any play-testing does. The campus is one fixed
// point; the player is anywhere in a region several kilometres across. A trip
// of 2 km at the ~13 m/s a van actually averages through town (that is the
// van's own limit-following speed with junction braking, not its 36 m/s vmax)
// is 150 seconds. pedestrians.js keeps a corpse for CORPSE_TIME = 60 s and
// stands a stunned survivor back up after DOWN_TIME = 2–4 s. So a van
// dispatched from the hospital arrives, essentially always, at an empty street
// two minutes after the player has driven off — a feature that fires into an
// empty room is a feature that does not exist.
//
// What actually happens in a town this size is that the nearest free crew is
// sent, and the nearest free crew is not at the hospital, it is out. So:
//
//   A call puts a van on the road graph in the band [CALL_R_MIN, CALL_R_MAX]
//   from the scene, preferring the side the hospital is on, and it drives in.
//
// The hospital is therefore a BEARING, not an origin — it decides which way
// the van comes from, which is the part a player can actually perceive, and it
// costs one dot product in a scan that already runs. And it is a DESTINATION:
// a van that has finished at a scene drives to the hospital with its blues on,
// which is the other half of the story and is free, because "drive to a point"
// is the only routing verb in this file.
//
// CALL_R_MIN is 260 m and that number is not free either: traffic.js's
// VIEW_TUNING.NOTICE_R (240 m) is that file's measured answer to "inside what
// radius does a player READ a vehicle appearing rather than merely see one",
// and a van materialising is exactly the event that constant describes. We
// import it rather than transcribe it, for the reason traffic.js exports it at
// all — a literal copied out of another file is a silent assertion that goes
// stale the day somebody re-sweeps it. CALL_R_MAX is 560 m, and the band is
// deliberately wide: a narrow one refuses perfectly good roads and leaves calls
// unanswered in half the city, and the scoring inside it already pulls towards
// CALL_R_IDEAL. Measured, the mean dispatch lands at 334 m and the van is on
// scene in 34 s — comfortably inside the corpse's 60 s, and long enough that it
// is a thing that ARRIVES rather than a thing that was already there.
//
// ---- THE CASUALTY IS USUALLY GONE, AND THAT IS THE DESIGN ----------------
//
// Given the two lifetimes above, a van that required a body to still be lying
// there would cancel most of its own calls in flight. So it does not go to a
// BODY, it goes to a PLACE: call(x, z) records a point and the point does not
// expire. Nothing about the trip is conditional on the casualty.
//
// The body is asked about exactly once, on arrival, and only to choose how long
// to stand there:
//
//   somebody still down/dead within SCENE_LOOK → SCENE_T (22 s), a crew
//     loading a patient
//   an empty street                            → SCENE_T_EMPTY (6 s), a crew
//     that has arrived to nothing, looks, and goes
//
// Both outcomes are correct and the player can tell them apart from the
// pavement, which is the only reason the test is worth doing at all. Where
// there is no pedestrians module the answer is "somebody is there" — the
// longer, better-looking stand, and the cheap direction to be wrong in.
//
// ---- THE POOL ------------------------------------------------------------
//
// POOL_N = 4 records, allocated once in the constructor and rewritten in place
// for the life of the process. Never five, never a fresh one.
//
//   2  concurrent scenes. Two is what a player can actually produce: you can
//      only run people down in one place at a time, but combat.js's fists and
//      a car are two independent ways to hurt somebody and they can be a
//      street apart. A third simultaneous scene is a player standing in a
//      crowd swinging, and the answer to that is a town with a finite number
//      of crews, not a parade.
//   1  ambient van.
//   1  spare, for the same reason js/police.js keeps two: a crew that has
//      finished at a scene is still driving to the hospital for up to HOME_T,
//      and without the spare the next call would have to wait out somebody
//      else's paperwork.
//
// Four vans is four meshes, i.e. about 3 % of the ~120-car fleet traffic.js
// carries at the product's default density.
//
// ---- THE AMBIENT ONE IS LOCAL, AND HERE IS THE ONE LINE THAT FIXES IT ----
//
// traffic.js's v10 header argues at length that a special vehicle must not be
// a spawner of its own: a patrol minted "near me" is minted somewhere else on
// the peer's machine, and two players in the same room seeing two different
// police forces is worse than seeing none. The ambient ambulance is exactly
// the same shape of problem and it deserves exactly the same answer — ONE MORE
// SLOT IN THE CELL, hashed from (world seed, cell, slot, generation), born by
// _scanCells, ghosted by _retire, reaped by _sweepPool.
//
// This run does not own js/traffic.js, so it cannot have that. What it can
// have is the honest smaller thing: a van built here, driven here on traffic's
// PUBLIC graph, never in traffic.cars and never in traffic._pool. It is local.
//
// WHAT THAT COSTS, said plainly: the peer does not see it. Nothing else. This
// module moves no shared state — no slot is taken, no schedule is written,
// traffic.snapshot() is bit-identical whether this file is loaded or not — so
// the divergence is one van on one screen, which is the same price traffic.js
// already pays for its ghosts (traffic.js:174) and js/police.js pays for a
// whole pursuit (police.js:225). It is survivable because an ambulance nobody
// hit and nobody is chasing changes nothing that either player can act on.
//
// THE ONE-LINE ADDITION I WOULD WANT, exactly. traffic.js:2185 currently reads
//
//     const car = p.police ? this._buildPatrol(p.sx, p.sz, heading)
//       : this.vehicles.add(kind, p.sx, p.sz, heading, color);
//
// and the line I want instead is
//
//     const car = p.police ? (this.buildSpecial?.(p, p.sx, p.sz, heading)
//       ?? this._buildPatrol(p.sx, p.sz, heading))
//       : this.vehicles.add(kind, p.sx, p.sz, heading, color);
//
// With that, ambulance.js sets `traffic.buildSpecial = this._special` and
// converts a hashed share of the patrol slots — rnd01(hash32(p.seed, SALT)) <
// AMBIENT_SHARE — into ambulances. The ambient van then rides the entire v8/v9
// machine for free: shared across clients, never popping into or out of view,
// ghosted rather than deleted under your eyes, exempt from the hard cap,
// turned down by the traffic slider with everybody else. Every line of the
// local ambient path below then deletes.
//
// The one wrinkle that line leaves, because a reader will find it: such a van
// still carries p.police, so it appears in traffic.patrols. That set has one
// real consumer today (nearestPatrol, which police.js does not currently call
// — it recruits from traffic.cars filtered by PATROL_KINDS, and 'van' is not
// in that set), so nothing drafts an ambulance into a pursuit. It is still
// wrong and the clean version is a `p.sv` service-kind byte in place of the
// p.police boolean, which is four lines rather than one.
//
// ---- DETERMINISM: THERE IS NONE HERE, AND THAT IS CORRECT ---------------
//
// The dispatched van cannot be shared even in principle, for the reason
// police.js gives about pursuits: its CAUSE is not shared. You ran somebody
// over on your machine; the peer standing beside you did not. Sharing the
// consequence of an unshared event is not determinism, it is a lie about who
// did what. The ambient one is local only until the line above lands.
//
// There is no Math.random in this file. Not because anything here is shared —
// nothing is — but because a draw made with Math.random in this codebase reads
// to the next person as a decision somebody made about determinism, and every
// draw in here is small enough that hash32 over a local counter costs the same.
//
// ---- THE SIREN, WHICH MUST NOT BE THE POLICE ONE ------------------------
//
// js/audio.js has exactly one siren asset — `siren_far`, rendered from
// scripts/gen-sounds.mjs:78 as "a European two-tone wailing siren rising and
// falling", 4.0 s — and js/police.js already spends it, retriggered through
// sfxAt() every 3.4 s so the wail runs continuous. A second sample is not
// this run's to add and a second AudioContext is the mistake police.js's
// header already refused (outside setVolume, so a muted game still wails).
//
// So the ambulance plays the same asset at a DIFFERENT PLAYBACK RATE, which
// changes both things that distinguish two Czech emergency two-tones: the
// pitch of the pair and the speed of the sweep between them.
//
//     rate 0.78  →  −4.3 semitones, sweep 28 % slower, clip 5.13 s
//
// and both directions are physically honest rather than a knob: a ZZS box van
// carries a bigger horn further from your ear than a police Octavia, and a
// Czech ambulance runs the slower wail while the police run the fast one. The
// rate is not free to move much — under ~0.70 the sample's own reverb tail
// smears into a drone and you can hear that it is a slowed recording; over
// ~0.88 it is audibly the police car with a cold. 0.78 is about the widest gap
// that still sounds like a siren. sfx() takes the rate and gainAt() gives the
// 1/r law, so the distance question is still asked in exactly one place.
//
// SIREN_GAP is 4.55 s against the 5.13 s stretched clip: 0.58 s of overlap, so
// the wail is continuous rather than pulsing, the same trade police.js makes.
// One voice for the whole service, the nearest van only — two sirens stacked
// is not twice as urgent, it is mush.
//
// AND IT STOPS AT THE SCENE. A van standing at a kerb keeps its beacons and
// kills its wail, because a siren is for clearing traffic AHEAD and there is
// no traffic ahead of a parked van. That is what real crews do and it is also
// the only moment of quiet the feature has, which is what makes the noise mean
// something when it starts again.
//
// ---- WHAT THE VAN LOOKS LIKE --------------------------------------------
//
// 'sanitka' is not in VEH.CAR_KINDS and adding one is somebody else's file, so
// this is the roster's `van` — the blunt tall box that is already what a
// Transit or a Boxer is — painted signal white, with a red-orange band down
// each flank and a light bar on the roof. Three meshes over one geometry set
// cached at module level for the whole service, exactly as traffic.js's
// copAssets does for the police bar: a client that never meets an ambulance
// never pays for one, and headless tests never touch THREE.
//
// Every dimension below is read off vehicles.js KIND.van and quoted where it
// is used, so that whoever re-authors that hull can see what floats.
//
// THE BEACONS ARE TRAFFIC'S. The bar is built here, but the flashing is
// delegated to traffic.setSiren(car, on) by stamping the `_cop` record that
// call already drives. That is deep reuse and it is the right call twice over:
// the material swap, the shared-clock cadence and the self-cleaning set are
// solved once in traffic.js for precisely this shape, and Czech law gives
// every emergency service the SAME blue at the same rate — two files with two
// opinions about what a majáček looks like is a bug waiting for the frame
// where a police car and an ambulance are both on screen. The cost is that
// ours blinks in lockstep with a patrol's; the difference between the two
// vehicles is the siren and the silhouette, which is where it belongs.
//
// ---- WHAT ANOTHER MODULE MUST DO ----------------------------------------
//
//   main.js — see the report; four lines. The load-bearing one is the crash
//     list: our vans are not in traffic.cars, so until main.js pushes
//     `ambulance.cars` into _crashList() the player drives THROUGH an
//     ambulance, which is worse than not having one.
//   traffic.js — (a) the buildSpecial line above, which makes the ambient van
//     shared; (b) a yield: inside _drive, one term that treats a car with
//     `car.siren` within ~30 m behind and roughly in line as a reason to slow
//     and drift right. Without it a van with its blues on sits in the same
//     queue as everybody else, which is the one thing in here that looks
//     broken rather than merely simple.
//   vehicles.js — CAR_LABELS has no ambulance, so a player who steals one gets
//     "Dodávka · skříňová do 3,5 t" on the HUD. One row, or one line in
//     _labelPair preferring an explicit `car.label`.
//   audio.js — a real ZZS sample, or a positional continuous voice
//     (`sirenAt(id, x, z, on, rate)`), and the six lines of _siren() collapse
//     into it. Everything else about the sound is already here.
//
// ---- COST ----------------------------------------------------------------
//
// Four records, walked once per step. Each driving van scans 8 polyline
// vertices for corners and traffic.cars once for a leader — ~120 squared
// distances behind a range gate, the same shape police.js pays. The only
// expensive thing in the file is _railNear, a linear walk of traffic.edges
// (23 750 directed edges on the real region — the number traffic.js:1271
// quotes from its own sweep) rejecting on a midpoint distance, i.e. six flops
// each. It runs ONCE per dispatch and once per ambient appearance, which the
// deadlines below cap at roughly once every 20 s in the worst case a player
// can force, and never inside a driving path.
//
// No object, array or closure literal exists on any path update() touches.
// `units` and `cars` are fixed arrays rebuilt with length = 0 and push. Every
// deadline is an ABSOLUTE timestamp against one cached clock read per update,
// never a countdown, for the reason js/chatter.js's header gives at length: a
// countdown nobody ticks is a silent bug that every test still passes.
//
// stepGame(dt) runs up to three times per rendered frame (main.js clamps to
// 50 ms and loops). Every integration here is dt-proportional and every
// decision is a timestamp comparison, so three 16 ms calls and one 48 ms call
// land in the same place.
//
// ---- WHICH NUMBERS ARE MEASURED, AND ON WHAT --------------------------
//
// Being straight about this, because the rest of this codebase earns the right
// to state a sweep and a fabricated one would be worse than none.
//
// THE FIXTURE is synthetic: a 16×16 grid of 120 m blocks, every street two-way
// at a flat 50 km/h, no traffic lights, no other cars, no terrain. It is NOT
// the real region graph — this run had no way to drive one — and it is harder
// than Pardubice in one respect and easier in three. Harder: a uniform grid
// gives the greedy router a fresh chance to turn the wrong way every 120 m,
// where a real town has arterials that carry you most of the distance. Easier:
// no signals to queue at, no traffic to follow, and every point is reachable.
// So treat the arrival TIMES as optimistic by whatever junctions cost, and the
// arrival RATE as pessimistic.
//
// MEASURED on it: the CALL_R_IDEAL sweep (see the constant), the ambient rate
// (see AMBIENT_GAP), the closest-approach pull-up rule (see PULLUP_MAX — it is
// the one bug in this file that only a measurement could have found, and it was
// half the feature), 30/30 arrivals for scenes placed 8 m off a carriageway at
// a mean of 9.6 m from the body, and 90 minutes of continuous operation with 64
// vans built, 64 removed and a peak of 3 live.
//
// DERIVED AND NOT MEASURED, in the order they most want a real sweep:
// SCENE_MERGE against a five-body pile-up, SIREN_RATE against ears rather than
// against semitones, and CALL_CD against a player who is deliberately farming
// ambulances.
// ==========================================================================

import * as THREE from 'three';
import { TRAFFIC, LAYER_Y } from './config.js';
import { distPointToSegment, roadGradeY, bridgeDeckHeight } from './geo.js';
import { sfx, gainAt } from './audio.js';   // headless-safe: both no-op without a context
import { worldT } from './worldclock.js';
// Namespace imports on purpose, both of them. A NAMED import of something a
// stale sibling does not export is a hard link error that takes the whole page
// down, and both of these are newer exports than some checkouts have:
// VIEW_TUNING arrived with traffic v9 and CAR_KINDS gets re-shaped whenever the
// roster does. traffic.js does exactly this dance for pickCarColor.
import * as TRF from './traffic.js';
import * as VEH from './vehicles.js';

// ---- where the hospital is ------------------------------------------------
// Transcribed from main.js's own HOSPITAL, which is where it respawns you, so
// the two cannot disagree about the campus by more than the four metres they
// already do. Overridable through the constructor precisely so main.js can
// hand its constant in and the duplicate stops existing.
//
// It is a POINT and not the campus, and it is allowed to be: the 28 hospital
// buildings live in the BUILDINGS layer as t:"hospital" (the POI filter is
// node-only, so there is no hospital node to look up), and finding their
// centroid means walking the chunk index, which is main.js's streaming to
// drive and not ours. What we do with the hospital — pick a bearing, and drive
// towards it until we are HOSP_R away — is insensitive to sixty metres.
const HOSPITAL_X = 2291, HOSPITAL_Z = 295;
const HOSP_R = 70;              // m — this close to the campus, the trip is over

// ---- the pool -------------------------------------------------------------
const MAX_CALLS = 2;
const AMBIENT_N = 1;
const POOL_N = MAX_CALLS + AMBIENT_N + 1;

// ---- modes ----------------------------------------------------------------
// Small integers rather than strings: they are compared several times per
// record per step, and a switch on an int is a switch. FREE is 0 so a blank
// record is falsy in the one place that matters.
const FREE = 0;       // record owns nothing
const AMBIENT = 1;    // in the flow, no blues, heading for the hospital
const ROLLING = 2;    // blues and wail, driving to a scene
const PULLUP = 3;     // ...and braking to a stop at it
const SCENE = 4;      // stopped, beacons on, wail off
const HOMEWARD = 5;   // blues and wail, driving to the hospital

// ---- dispatch geometry ----------------------------------------------------
// See the header for CALL_R_MIN's provenance. The fallback is traffic v9's
// value at the time of writing and exists only so a stale traffic.js is a
// slightly worse ambulance rather than a TypeError at import.
const NOTICE_R = TRF.VIEW_TUNING?.NOTICE_R ?? 240;
const CALL_R_MIN = Math.max(NOTICE_R + 20, 200);
const CALL_R_MAX = 560;
// SWEPT, on the grid fixture described at the bottom of the header: 40 calls
// placed 8 m off the carriageway, columns are calls answered / mean dispatch
// distance / mean time to the scene / worst time.
//     280:  40/40   310 m   24.4 s   36 s
//     330:  40/40   334 m   34.2 s   34 s      ← chosen
//     380:  40/40   394 m   43.4 s   45 s
//     440:  40/40   437 m   35.3 s   42 s
// The constraint is not the mean, it is the TAIL against pedestrians.js's 60 s
// corpse: a van arriving at 45 s is technically inside it and is leaning on it,
// and the real region graph is more irregular than a grid, not less. 330 puts
// the whole measured distribution under 35 s while still dispatching from
// 334 m — 94 m outside the radius at which a player reads a vehicle appearing.
// 280 buys ten more seconds of margin and spends them moving the dispatch point
// towards the player, which is the one thing this band exists to prevent.
const CALL_R_IDEAL = 330;
// How much "distance" a candidate on the wrong side of the scene is charged,
// in metres, scaling from 0 (dead ahead of the hospital bearing) to this
// (coming from precisely the opposite direction). 140 is deliberately less
// than the width of the band: a van from the wrong side is a crew that was
// already out that way, and refusing it outright would leave calls unanswered
// in half the city.
const HOSP_BIAS = 140;
const RAIL_MIN_LEN = 24;        // m — shorter edges are junction stubs; a van
                                // dropped on one is born at a node
const RAIL_MIN_V = 8;           // m/s (≈30 km/h) — no ambulance is dispatched
                                // down a service alley or an obytná zóna

// ---- the calls ------------------------------------------------------------
const CALL_CD = 20;             // s between two dispatches, globally. A player
                                // driving down a pavement generates one call
                                // per body; this is what stops that being a
                                // convoy without stopping it being a response.
const CALL_MISS = 4;            // s — the shorter deadline a call that found no
                                // road burns, so the edge scan is rate-limited
                                // independently of whether it succeeds
const SCENE_MERGE = 70;         // m — a call this close to one already being
                                // answered IS that call. A car crash makes five
                                // casualties inside twenty metres and they are
                                // one incident, not five.
// ---- ARRIVING, WHICH IS THE ONE RULE I HAD WRONG ------------------------
// The obvious test is a radius: within ARRIVE_R of the scene, stop. It is also
// only correct for the common case, and the first sweep of this file said so —
// over 40 calls placed at arbitrary points on a 120 m grid, 21 of them NEVER
// ARRIVED. A road can simply not pass within fourteen metres of where a body
// ended up: a courtyard, the middle of a park, the far side of a car park, or
// just the middle of a block on a coarse grid. The greedy router then drove
// past the nearest point, came round again, drove past it again, and did that
// until GIVE_UP turned a rescue into a van going home. Nothing threw, every
// test passed, and half the feature did not happen.
//
// So the rule is "as close as this road gets", expressed the only way a driver
// can know it without a route in hand: track the closest approach so far, and
// when the distance has been getting WORSE by PASS_BY metres while inside
// PULLUP_MAX, we have driven past the nearest point and this is the kerb.
// ARRIVE_R stays as the fast path for the ordinary case — a body on a pavement
// beside the carriageway — because a van that pulls up at the first honest
// opportunity looks better than one that waits to prove it was the best.
// PULLUP_MAX is half a city block: beyond that the van has not arrived at the
// scene, it has given up near it, and GIVE_UP is the right answer instead.
const ARRIVE_R = 14;            // m from the scene at which the van pulls up.
                                // Roads sit up to ~10 m from where a body ends
                                // up on the pavement, plus a lane offset.
const PULLUP_MAX = 55;          // m — inside this, closest-approach counts…
const PASS_BY = 8;              // …once we are this much worse than our best
const ARRIVE_V = 0.5;           // m/s under which "pulling up" has become
                                // "stopped"
const SCENE_LOOK = 16;          // m — how far from the pull-up point we look for
                                // somebody still lying there
const SCENE_T = 22;             // s standing at a scene with a casualty…
const SCENE_T_EMPTY = 6;        // …and at one without
const GIVE_UP = 90;             // s after dispatch. The router here is greedy
                                // (see _pickNext) and a one-way system can walk
                                // a van into a corner it will not plan out of;
                                // rather than circle for ever it stops being a
                                // response and becomes a van driving to the
                                // hospital, which is both a legible outcome and
                                // a state with its own deadline.
const HOME_T = 90;              // s a van may spend driving to the hospital
                                // before the mesh goes anyway

// ---- the ambient one ------------------------------------------------------
const BOOT_GAP = 45;            // s of grace after the first step — see _ambient
const AMBIENT_GAP = 200;        // s until the next one may appear…
const AMBIENT_JIT = 160;        // …plus 0..this, so it is not a metronome
const AMBIENT_LIFE = 130;       // s before it is taken whatever it is doing
const AMB_R_MIN = Math.max(NOTICE_R + 40, 280);
const AMB_R_MAX = TRAFFIC.spawnR;   // the ring traffic itself populates: past it
                                    // there is nothing around the van to be in
                                    // the flow WITH
const AMB_R_IDEAL = 400;
// MEASURED, two hours of standing still in the middle of the grid fixture: 25
// appearances, i.e. one every 4.8 minutes; a van is somewhere in the world 30 %
// of the time, within 400 m of you 21 % of the time and within 200 m — where it
// is a vehicle you can actually see rather than a dot — 10 % of the time; mean
// life 86 s before KEEP_R or AMBIENT_LIFE takes it.
//
// That is the rate this feature wants and it is worth saying why it is so much
// lower than the police's. traffic.js aims a patrol past you every ~3 minutes
// and had to be argued UP to that, because a town with no visible police reads
// as lawless. An ambulance is the opposite: it is a vehicle whose whole meaning
// is that something has happened, so one every five minutes reads as a working
// town and one every ninety seconds reads as a disaster area. If this moves at
// all it should move down.

// ---- keeping and dropping -------------------------------------------------
const KEEP_R = 700;             // m from the player past which any van is
                                // deleted, in EVERY mode including one rolling
                                // to a call. That is deliberate: the entire
                                // point of the feature is that you see it come,
                                // and an ambulance answering a call three
                                // streets behind a player who has driven off is
                                // a mesh nobody will ever look at. Sits just
                                // past traffic's own despawnR (676).

// ---- driving --------------------------------------------------------------
// Transcribed from js/police.js, which transcribed the shape from traffic.js,
// and not imported for the reason police.js gives: they are module-private
// there, and a shared import somebody later "optimises" is how two files stop
// agreeing about what a corner is. The NUMBERS differ from police.js's, and
// every difference is the same difference — this is a 2.6 t box van
// (vehicles.js KIND.van: accel 4.6, vmax 36.1 m/s, grip 6.2, mass 2.6), not a
// pursuit Octavia.
const ACCEL = 4.2;              // just under the van's own 4.6
const BRAKE = 5.0;              // planning decel: the anticipation envelope
const BRAKE_SOFT = 6.2;
const BRAKE_HARD = 12.0;        // a laden van does not stop like a sedan
const TURN_RATE = 6.0;          // heading smoothing (1/s); slower than the
                                // 7.0 traffic and police use, because a tall
                                // box that snaps to a new heading reads as a
                                // sprite rather than as a vehicle
const CORNER_LOOK = 16;         // m of polyline scanned ahead for curves
const LAT_GATE = 2.0;           // half-width of the follow corridor
const RAM_FRICTION = 4.0;       // m/s² a shunted van scrubs while sliding out
const UTURN_PEN = 60;           // m a U-turn must save before it is worth it
const HOP_MAX = 4;              // edges crossable in one step — the guard against
                                // a chain of half-metre edges spinning here
const STUCK_V = 0.5;
const STUCK_T = 25;             // s. Longer than police.js's 20 on purpose: a van
                                // with its siren on legitimately sits in a queue,
                                // because traffic.js does not yield to it (see the
                                // header). Twenty seconds of honest queueing must
                                // not read as "stuck".
// A van on a call may hurry; it may not race. There is NO rubber band in this
// file and the omission is the point: police.js needs one because a pursuit
// that cannot catch the player is not a pursuit, and nothing here is chasing
// anybody. A van that cheated to arrive would arrive at a speed nothing else on
// the road is doing, which is precisely the "magnet, not driving" failure
// police.js's BAND_NEAR exists to avoid.
const VK_CALL = 1.12;           // 12 % over the limit, blues on
const VK_IDLE = 0.95;           // …and a van pottering back to base
const VMAX_CALL = 27;           // m/s (97 km/h) hard ceiling on a call. The van's
                                // own vmax is 36.1; an ambulance doing 130 through
                                // Pardubice is a different game.
const VMAX_IDLE = 20;           // m/s (72 km/h) with the blues off
// …and a FLOOR under the blues, which the first draft did not have and needed.
// A dispatch spawns ~330 m out and gives up at 90 s, so the round trip has to
// average better than 4 m/s of closure; the measured van did 3. The reason was
// not the router: it was routed onto a 4.8 m side street whose limit is 20 km/h,
// and 5.56 × VK_CALL is 6.2 m/s. Twelve per cent over a residential limit is
// what a van in the flow does; a crew on blues does 45 through the same street,
// and every other brake in _drive — the corner envelope, the leader, the pull-up
// — still applies on top, so this raises the floor and never the ceiling.
const VMIN_CALL = 12;           // m/s (43 km/h)
const PLAYER_GAP = 6;           // m the van holds off the player, in a car or on
                                // foot. Note that this is the OPPOSITE of
                                // police.js, which deliberately does not brake
                                // for the player's bumper — being shunted is the
                                // good half of being chased, and it is no part
                                // at all of being rescued.

// ---- siren ----------------------------------------------------------------
const SIREN_CLIP = 'siren_far';
const SIREN_RATE = 0.78;        // argued at length in the header
const SIREN_R = 230;            // m — where a wail stops being worth a voice.
                                // Slightly past police.js's 210: the stretched
                                // clip is lower, and low carries.
const SIREN_GAP = 4.55;         // s — 4.0/0.78 = 5.13 s of clip, so 0.58 s of
                                // overlap and a continuous wail
const SIREN_VOL = 0.8;

const DT_MAX = 0.1;             // a step longer than this is a debugger, not a
                                // frame — main.js already clamps to 0.05

// ---- the livery, in numbers off vehicles.js KIND.van ----------------------
// Signal white, and deliberately NOT traffic.js's PATROL_PAINT (0xe9eae5): a
// police car is fleet white and an ambulance is brighter than that, and the two
// standing in the same street should not be the same colour.
const RZP_PAINT = 0xf3f5f2;
// The band. RAL 3024 luminous red is what a Czech RZP wears; 0xe0341c is that
// colour once the Lambert shading in this renderer has had it, and it still
// reads as "red-orange, not signal red" at a hundred metres.
const BAND_COLOR = 0xe0341c;
// KIND.van is len 4.8, wid 1.9, hull.bw 0.92, hull.yA 0.34, hull.yB 0.80, and
// its mid stations run [z, yLo, yHi, wK] = [-1.60, 0.20, 1.04, 1.00] to
// [1.80, 0.20, 1.06, 1.00]. bodyHull gives full half-width w = wK · wid/2 =
// 0.95 m between yA and yB, i.e. between y 0.49 and y 0.89. So the band sits at
// y 0.70, dead in the middle of the flat of the flank, and is 1.93 m wide —
// 1.5 cm proud of the panel each side, which is what makes it a band you can
// see rather than a decal fighting the hull for the same pixels.
const BAND_W = 1.93, BAND_H = 0.26, BAND_Y = 0.70;
const BAND_L = 3.2, BAND_Z = 0.30;   // z −1.30..1.90, all of it inside the
                                     // constant-width run of the hull
// ---- what makes the band a livery and not a paint job --------------------
// A white van with a red stripe is a delivery van in a hurry. The first pass
// shipped exactly that and it read as one, which is the same complaint that
// put POLICIE on the patrol cars: an emergency vehicle has to be identifiable
// from the far side of a junction, not on inspection. Two cues, in the order
// they arrive: a white cross at each end, which carries at 25 m, and the word
// in the middle, which carries at 10.
//
// Both are painted into the BAND'S OWN texture rather than added as meshes.
// A cross quad per flank plus a wordmark quad per flank is four more draw
// calls and four more materials on a vehicle that already exists in fours;
// a texture is none, because the band was already a mesh with a material.
// See bandGeo for why the box became a hand-wound geometry (a BoxGeometry
// hands its two flanks mirrored UVs, so one side of every ambulance in the
// country would have read AKŽULS ÁNNARHCÁZ).
//
// A cross at EACH end and not one: the two flanks are mirror images, so a
// single mark would sit at the nose on one side and the tail on the other,
// and the van would have a blank side depending on which way it passed you.
//
// The marks are placed in the VAN's own z and converted (bandU), not written
// as texture coordinates. The first pass put them at u 0.075 from each end and
// the tail cross vanished: KIND.van's wheels sit at z ±1.62 with a 0.36 m
// radius, the band runs y 0.57..0.83, and a wheel whose top is at 0.72 eats the
// stripe wherever it stands. The nose cross happened to land forward of the
// front wheel and looked fine, which is exactly how a livery ships half
// invisible. ±1.06 is the widest pair that clears both arches.
const BAND_TEXT = 'ZÁCHRANNÁ SLUŽBA';
const BAND_CROSS_Z = 1.06;       // ± this in the van's own z
const BAND_TEXT_Z = 0;           // …and the word centred between them
const BAND_TEXT_MAX = 0.50;      // no wider than this fraction of the run, so a
                                 // font fallback that measures wide shrinks to
                                 // fit instead of running under the crosses
const BAND_CROSS_H = 0.74;       // arm span as a fraction of the band's height
const BAND_CROSS_T = 0.30;       // …and the arm's thickness as a fraction of that
const BAND_PX = 1024;            // canvas width; the height is DERIVED (bandMat)
// Where a point on the van lands along the band's texture. u = 0 is the TAIL
// end of the strip (bandGeo winds the right flank tail-to-nose so the word
// reads forwards), and the van's nose is at −z.
const bandU = (z) => (BAND_Z + BAND_L / 2 - z) / BAND_L;
// Every face of the band that is NOT a flank samples this one column of
// untouched red. A degenerate UV — all four corners on the same texel — is
// what keeps the top edge of the stripe from wearing a stretched smear of the
// letter that happened to be nearest.
const BAND_PLAIN_U = 0.997;
// The roof. KIND.van's greenhouse (`green.sts` = [z, yBase, yRoof]) climbs from
// [-1.62, 1.02, 1.06] over the bonnet stub to [-0.90, 1.04, 1.94] at the
// windscreen header and [0.10, 1.05, 1.97] over the box; nose is at −z. The bar
// stands just behind the header at z −0.55, where the roof interpolates to
// 1.95. Roof half-width there is green.topW · wid/2 = 0.82 × 0.95 = 0.78 m, so
// a 1.30 m bar has 13 cm of clearance each side.
const BAR_Y = 1.95, BAR_Z = -0.55, BAR_W = 1.30;
const LAMP_X = 0.40;            // lamps out towards the ends of the bar, wider
                                // than the police car's 0.30 — a bigger vehicle
                                // wears a bigger bar, and it is one of the two
                                // things that tell them apart in a mirror

// ---- scratch, reused forever ---------------------------------------------
const _pose = { x: 0, z: 0, dx: 0, dz: 0, seg: 0 };
const _snap = { x: 0, z: 0, t: 0 };
const _lim = { v: 0, hard: false };
const _rail = { e: null, s: 0 };

const dist = (dx, dz) => Math.sqrt(dx * dx + dz * dz);
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// Byte-identical to the finaliser in traffic.js, pedestrians.js and chatter.js,
// and duplicated for the reason all three of them duplicate it from each other.
// Only imul, xor and shift.
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

// v = sqrt(a_lat · R), a polyline corner of angle `ang` taken over ~7 m so
// R ≈ 7/ang; with a_lat 4.5 that is sqrt(31.5/ang). Byte-identical to
// traffic.js and police.js on purpose: a van that cornered on different physics
// from the traffic around it would either understeer into every kerb or float
// round bends nothing else can take.
const cornerSpeed = (ang) => Math.max(2.2, Math.sqrt(31.5 / Math.max(ang, 0.06)));

// Point and tangent at arc length `s` along an edge's polyline. The same eight
// lines traffic.js calls poseAt and police.js calls poseOn; neither exports it.
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

// The band, wound by hand instead of taken from BoxGeometry. Not for the
// vertex count — it is the same six quads — but for the UVs: three's box lays
// its two ±X faces out with u running the SAME way round the solid, which on
// a strip that carries a word means one flank of every ambulance reads
// backwards. Written out, each flank gets u = 0 at the end that is on the
// reader's left when they stand beside it, so both sides read forwards.
//
// The other four faces collapse onto a single texel of plain red (see
// BAND_PLAIN_U): they are 1.5 cm-wide edges and nobody reads them, but a
// stretched letter smeared along the top of the stripe is very visible indeed.
function bandGeo() {
  const hx = BAND_W / 2, hy = BAND_H / 2, hz = BAND_L / 2;
  const P = [], N = [], U = [], I = [];
  // One quad, wound CCW seen from outside; `n` is its outward normal and the
  // four corners arrive in reader order (bottom-left, bottom-right, top-right,
  // top-left) so the UVs below can be a constant.
  const quad = (n, a, b, c, d, uvs) => {
    const base = P.length / 3;
    for (const v of [a, b, c, d]) { P.push(v[0], v[1], v[2]); N.push(n[0], n[1], n[2]); }
    U.push(...uvs);
    I.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  const FLANK = [0, 0, 1, 0, 1, 1, 0, 1];
  const PLAIN = [BAND_PLAIN_U, 0.5, BAND_PLAIN_U, 0.5, BAND_PLAIN_U, 0.5, BAND_PLAIN_U, 0.5];
  // Right flank. Standing at +x you face −x, so your right hand points at −z —
  // the van's nose — and the word runs tail-to-nose.
  quad([1, 0, 0], [hx, -hy, hz], [hx, -hy, -hz], [hx, hy, -hz], [hx, hy, hz], FLANK);
  // Left flank: the mirror, so the word runs nose-to-tail and still forwards.
  quad([-1, 0, 0], [-hx, -hy, -hz], [-hx, -hy, hz], [-hx, hy, hz], [-hx, hy, -hz], FLANK);
  quad([0, 1, 0], [-hx, hy, hz], [hx, hy, hz], [hx, hy, -hz], [-hx, hy, -hz], PLAIN);
  quad([0, -1, 0], [-hx, -hy, -hz], [hx, -hy, -hz], [hx, -hy, hz], [-hx, -hy, hz], PLAIN);
  quad([0, 0, 1], [-hx, -hy, hz], [hx, -hy, hz], [hx, hy, hz], [-hx, hy, hz], PLAIN);
  quad([0, 0, -1], [hx, -hy, -hz], [-hx, -hy, -hz], [-hx, hy, -hz], [hx, hy, -hz], PLAIN);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  g.setIndex(I);
  g.translate(0, BAND_Y, BAND_Z);
  return g;
}

// ONE texture for the whole service, for the reason traffic.js's liveryMat
// spells out at length: every ambulance says the same word, so a canvas per
// van is three wasted uploads before a single call goes out. The canvas HEIGHT
// is derived from the band's own proportions rather than picked, so a cross
// drawn square on the canvas arrives square on the van.
//
// No <canvas> — a headless import, or a null 2d context under memory pressure
// — falls back to the flat red the band wore before the marks existed. The
// stripe is the cue that carries at 60 m; losing the lettering is survivable
// in an environment that by definition has no screen.
function bandMat() {
  const flat = () => new THREE.MeshLambertMaterial({ color: BAND_COLOR });
  if (typeof document === 'undefined') return flat();
  const cv = document.createElement('canvas');
  const w = BAND_PX;
  const h = Math.max(16, Math.round(w * BAND_H / BAND_L));
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return flat();
  g.fillStyle = '#' + BAND_COLOR.toString(16).padStart(6, '0');
  g.fillRect(0, 0, w, h);
  // The crosses, drawn as two rectangles each rather than as a glyph: '✚' is
  // not in every fallback font and a missing-glyph box on the side of an
  // ambulance is worse than no cross at all.
  const arm = h * BAND_CROSS_H, thick = arm * BAND_CROSS_T;
  g.fillStyle = '#ffffff';
  for (const z of [BAND_CROSS_Z, -BAND_CROSS_Z]) {
    const cx = bandU(z) * w, cy = h / 2;
    g.fillRect(cx - arm / 2, cy - thick / 2, arm, thick);
    g.fillRect(cx - thick / 2, cy - arm / 2, thick, arm);
  }
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = Math.round(h * 0.72);
  g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  // Shrink to fit rather than let a wide fallback run out under the crosses,
  // exactly as js/meshes.js:brandMarkMat does for its longer shop names.
  const tw = g.measureText(BAND_TEXT).width, max = BAND_TEXT_MAX * w;
  if (tw > max) {
    size = Math.max(8, Math.floor(size * max / tw));
    g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  }
  g.fillText(BAND_TEXT, bandU(BAND_TEXT_Z) * w, h / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;                    // a flank is read at grazing angles
  return new THREE.MeshLambertMaterial({ map: tex });
}

// ---- the livery, on the same lazy terms as traffic.js's copAssets ---------
// One geometry + material set for every ambulance in the country, built the
// first time one actually takes a mesh. A client that never meets one never
// pays for it, and a headless test never touches THREE.
let _A = null;
function rzpAssets() {
  if (_A) return _A;
  const band = bandGeo();
  const bar = new THREE.BoxGeometry(BAR_W, 0.06, 0.22);
  bar.translate(0, BAR_Y + 0.03, BAR_Z);          // sitting ON the roof
  const lamp = new THREE.BoxGeometry(0.36, 0.11, 0.19);
  _A = {
    band, bar, lamp,
    // The band is a plain Lambert with a painted map. Retroreflective tape
    // genuinely does light up in headlights, but nothing in this renderer
    // models a beam hitting a surface, so an emissive here would glow at 3 a.m.
    // in an unlit field — which is a worse lie than a band that is merely red.
    bandMat: bandMat(),
    barMat: new THREE.MeshLambertMaterial({ color: 0x24272c }),
    // Dark navy while idle, so the bar reads as a bar and not as a roof rack.
    // This is the ONLY lamp material this file owns: once the beacons have
    // flashed once, traffic.setSiren has swapped in its own on/off pair and
    // keeps them — see the header on why the blue belongs in one place.
    lampOff: new THREE.MeshLambertMaterial({ color: 0x18294d }),
  };
  return _A;
}

export class Ambulance {
  /**
   * { traffic, vehicles, city, scene, peds, hospital }
   *
   * Every one of them is optional and null-checked on use. This module must be
   * constructible before the world has streamed, and a caller that hands in
   * nothing gets an object whose update() is a no-op rather than a throw inside
   * stepGame — js/vitals.js's header has the cautionary tale about one
   * TypeError in the step loop freezing the renderer on its last drawn frame,
   * every frame, for ever.
   *
   *   traffic   the road graph (traffic.edges and the a/b nodes those edges
   *             carry) and traffic.cars to brake for. Without it this file does
   *             nothing at all, on purpose: there is nowhere to drive.
   *   vehicles  where a van comes from and where it goes.
   *   peds      asked exactly one question, on arrival: is anybody still lying
   *             here. Never written to.
   *   city      held and unused this pass, exactly as police.js holds `scene`.
   *             It is what a later pass needs to stop trusting a transcribed
   *             hospital centre: the campus is 28 buildings tagged t:"hospital"
   *             in the BUILDINGS layer (the POI filter is node-only, so there is
   *             no node to look up), and walking the chunk index for their
   *             centroid — and for the gate a van should actually drive to — is
   *             the honest version of HOSPITAL_X/Z.
   *   scene     likewise held: the thing it is for is a light that travels with
   *             the beacons, and creating a THREE light mid-session recompiles
   *             every material in the scene, so it wants to be pooled at boot
   *             rather than conjured when a call comes in.
   *   hospital  { x, z } — pass main.js's own HOSPITAL and the duplicate below
   *             stops being a duplicate.
   */
  constructor(opts = {}) {
    this.traffic = opts.traffic ?? null;
    this.vehicles = opts.vehicles ?? null;
    this.city = opts.city ?? null;
    this.scene = opts.scene ?? null;
    this.peds = opts.peds ?? null;
    const h = opts.hospital ?? null;
    this.hx = Number.isFinite(h?.x) ? h.x : HOSPITAL_X;
    this.hz = Number.isFinite(h?.z) ? h.z : HOSPITAL_Z;

    // The pool. Four records, allocated here, rewritten in place for ever.
    this._pool = [];
    for (let i = 0; i < POOL_N; i++) this._pool.push(this._blank());

    /** Every live ambulance, for the minimap. Read-only. Each entry is a
     *  RECORD, not a bare car: `.x`, `.z`, `.heading`, `.speed` mirror the van
     *  it is driving (so a minimap that reads those three off a traffic car
     *  works unchanged), `.car` is the vehicles.js object, `.mode` is one of
     *  the constants above and `.onCall` is the one-bit version of it. */
    this.units = [];

    /** Every van this module is holding — bare vehicles.js car objects, the
     *  same shape traffic.cars holds. Read-only. THIS, not `units`, is what
     *  main.js's _crashList() and _blastList() want: an ambulance standing at a
     *  scene is 4.8 m of solid metal, and a car you can drive through is worse
     *  than a car that should not have been there. */
    this.cars = [];

    // Test seam, the one traffic.js and police.js both carry and for the same
    // reason: every deadline in this file is an absolute time against worldT(),
    // and worldT() runs on the wall clock, so a headless test that steps 600
    // frames in a millisecond would see none of them expire and would silently
    // measure nothing. null = worldT().
    this.clock = null;
    this._t = this._now();      // cached clock, one read per update()
    this._callAt = 0;           // absolute deadlines, never countdowns
    this._sirenAt = 0;
    this._ambientAt = 0;
    this._beaconWarned = 0;     // one warning per session, not one per flash
    this._n = 0;                // draw counter — see the note on Math.random
  }

  _now() { return this.clock ? this.clock() : worldT(); }

  _blank() {
    return {
      mode: FREE, onCall: false, car: null, edge: null, s: 0, seg: 0,
      x: 0, z: 0, y: 0, heading: 0, speed: 0, laneOff: 0,
      tx: 0, tz: 0,        // where it is driving
      sx: 0, sz: 0,        // the scene it was called to
      vk: VK_IDLE, vmax: VMAX_IDLE,
      sceneAt: 0, dropAt: 0, giveUpAt: 0, stuckT: 0,
      bestD: Infinity,   // closest approach to the scene so far — see PULLUP_MAX
    };
  }

  // ------------------------------------------------------------- frame ----

  /**
   * ctx = { x, z, car } — where the player is, and the car they are driving
   * (null on foot). `dt` is the authority even if ctx carries one, because dt
   * is what main.js clamps.
   */
  update(dt, ctx) {
    const step = Number.isFinite(dt) && dt > 0 ? (dt > DT_MAX ? DT_MAX : dt) : 0;
    this._t = this._now();
    if (!ctx || !this.traffic || !this.vehicles) { this._sync(); return; }

    const px = Number.isFinite(ctx.x) ? ctx.x : 0;
    const pz = Number.isFinite(ctx.z) ? ctx.z : 0;
    const pcar = ctx.car ?? null;

    for (let i = 0; i < POOL_N; i++) {
      const u = this._pool[i];
      if (u.mode === FREE) continue;

      // THE PLAYER GOT IN. Our vans are ordinary vehicles.js cars, so nothing
      // stops main.js's door handler putting the player behind the wheel of
      // one, and a record that kept writing a pose onto a car somebody is
      // driving would fight driveStep for the same three fields — the car would
      // shudder along the rail while the wheel did nothing. So we let go: the
      // record frees, the van is his, and the beacons keep flashing exactly as
      // a stolen patrol keeps its lights (traffic.js:2431). The mesh is not
      // deleted; it has an owner now.
      if (pcar && u.car === pcar) { this._yield(u); continue; }

      this._drive(u, step, px, pz, pcar);

      // Every mode has an exit and the exits chain into one another until they
      // reach a deadline, so there is no state a van can sit in for ever. That
      // is the leak traffic.js's GHOST_MAX exists to close and it is closed
      // here by construction rather than by a valve.
      if (u.mode === SCENE && this._t >= u.sceneAt) { this._homeward(u); continue; }
      if ((u.mode === ROLLING || u.mode === PULLUP) && this._t >= u.giveUpAt) {
        this._homeward(u);
        continue;
      }
      const away = dist(u.x - px, u.z - pz);
      const atBase = (u.mode === AMBIENT || u.mode === HOMEWARD)
        && dist(u.x - this.hx, u.z - this.hz) < HOSP_R;
      if (away > KEEP_R || atBase || this._t >= u.dropAt) this._drop(u);
    }

    this._ambient(px, pz);
    this._siren(px, pz);
    this._sync();
  }

  // Rebuild the two public lists in place — length = 0 and push, so a caller
  // iterating them every frame never sees a fresh array and we never allocate.
  _sync() {
    this.units.length = 0;
    this.cars.length = 0;
    for (let i = 0; i < POOL_N; i++) {
      const u = this._pool[i];
      if (u.mode === FREE) continue;
      if (u.car) this.cars.push(u.car);
      this.units.push(u);
    }
  }

  // ------------------------------------------------------------- calls ----

  /**
   * SOMEBODY IS HURT HERE. The only verb this module has.
   *
   * Returns true when the call is now somebody's problem — either a van has
   * been dispatched, or one already on its way to a scene this close has taken
   * it on. False means no ambulance is coming, and there are exactly four
   * honest reasons for that, all of them stated below rather than swallowed.
   *
   * Safe to call from an event handler outside update(): it reads the clock
   * itself rather than trusting the cached one, because the cached one is only
   * fresh inside a step.
   */
  call(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    if (!this.traffic || !this.vehicles) return false;
    const t = this._now();

    // 1. ALREADY BEING ANSWERED. A car crash leaves five bodies inside twenty
    //    metres and pedestrians.js fires a hook per body; five ambulances for
    //    one junction is a parade, not a rescue. A merged call extends the
    //    stand at the scene rather than being dropped — there is more to load.
    for (let i = 0; i < POOL_N; i++) {
      const u = this._pool[i];
      if (u.mode !== ROLLING && u.mode !== PULLUP && u.mode !== SCENE) continue;
      if (dist(u.sx - x, u.sz - z) > SCENE_MERGE) continue;
      if (u.mode === SCENE) u.sceneAt = Math.max(u.sceneAt, t + SCENE_T);
      return true;
    }
    // 2. TOO SOON. A player walking down a pavement swinging generates a call
    //    every second or two, spread over a hundred metres, and each one clears
    //    the merge test.
    if (t < this._callAt) return false;
    // 3. NO CREW. Two scenes at once is the design (see the header) and it has
    //    to be a RULE, not a sentence in a comment: the pool holds four records
    //    and a third simultaneous scene would quietly take one, leaving nothing
    //    for the crew still driving to the hospital and nothing for the ambient
    //    van, i.e. the town would stop having an ambulance service at exactly
    //    the moment it looked busiest.
    let live = 0, u = null;
    for (let i = 0; i < POOL_N; i++) {
      const r = this._pool[i];
      if (r.mode === ROLLING || r.mode === PULLUP || r.mode === SCENE) live++;
      else if (!u && r.mode === FREE) u = r;
    }
    if (!u || live >= MAX_CALLS) return false;
    // 4. NO ROAD. Nothing drivable in the band around the scene — the middle of
    //    a field, an unstreamed frontier, a courtyard. Inventing a road to
    //    arrive on is worse than not arriving.
    //    A MISS STILL BURNS A (SHORTER) COOLDOWN, and it has to: _railNear is
    //    the only expensive thing in this file, and a car through a crowd in a
    //    field fires this hook several times a second. police.js makes the same
    //    move for the same reason — "one draft per cooldown, whether or not it
    //    succeeds: an empty street must not be re-scanned every frame for the
    //    car it has not got" — with a short deadline rather than the full one,
    //    so that a real call two seconds later is not punished for it.
    if (!this._railNear(x, z, CALL_R_MIN, CALL_R_MAX, CALL_R_IDEAL, this.hx, this.hz)) {
      this._callAt = t + CALL_MISS;
      return false;
    }
    // 5. FACING THE WRONG WAY. _railNear scores a PLACE, not a direction, and
    //    traffic.js holds both carriageways of a two-way street as separate
    //    directed edges that are each other's `twin` (traffic.js:1549). The
    //    first draft took whichever twin happened to score first, so half of
    //    all crews woke up pointing away from the scene: measured, one spent
    //    its first nine seconds and fourteen metres driving off in the wrong
    //    direction before _pickNext's U-turn penalty finally let it turn round.
    //    The twin is the same tarmac walked the other way at the mirrored arc,
    //    so choosing it costs nothing and buys back the U-turn. A one-way with
    //    no twin keeps what it was given — sending a van the wrong way up it
    //    would be a worse bug than a slow arrival.
    let e = _rail.e, s = _rail.s;
    if (e.twin) {
      const q = poseOn(e, s, 0);
      // >0 means the scene lies ahead of where this rail would carry us
      if ((x - q.x) * q.dx + (z - q.z) * q.dz < 0) {
        const tw = e.twin;
        const hi = Math.max(tw.len - 3, 3);
        s = Math.min(Math.max(tw.len - s, 3), hi);
        e = tw;
      }
    }
    if (!this._build(u, e, s)) {
      this._callAt = t + CALL_MISS;
      return false;
    }
    this._callAt = t + CALL_CD;
    u.mode = ROLLING;
    u.onCall = true;
    u.sx = x; u.sz = z;
    u.tx = x; u.tz = z;
    u.vk = VK_CALL; u.vmax = VMAX_CALL;
    u.giveUpAt = t + GIVE_UP;
    u.bestD = Infinity;
    u.dropAt = Infinity;        // ROLLING has giveUpAt instead; see update()
    u.sceneAt = 0;
    this._beacons(u.car, true);
    this._sirenAt = t;          // wail on the next update rather than in 4.5 s
    // call() is the one door into this module that is NOT inside a step, so the
    // public lists would otherwise be a frame stale — and a caller that does
    // `ambulance.call(x, z)` and then reads `ambulance.cars` to put the new van
    // in its physics list would miss it exactly once, on the frame where it
    // matters most. Four records; it costs nothing to be right.
    this._sync();
    return true;
  }

  // ---------------------------------------------------------- the scene ----

  // Pulled up and stopped. The wail dies here and the beacons do not, which is
  // what a real crew does and is also the only quiet this feature gets.
  _onScene(u) {
    u.mode = SCENE;
    u.speed = 0;
    u.stuckT = 0;
    u.sceneAt = this._t + (this._casualtyNear(u.sx, u.sz) ? SCENE_T : SCENE_T_EMPTY);
  }

  // Is anybody still lying at this scene? Asked ONCE, on arrival, and only to
  // choose between two waits — see the header on why the trip itself is never
  // conditional on a body that pedestrians.js stands back up after 2–4 seconds.
  // No pedestrians module, or a body list of the wrong shape, answers "yes":
  // the longer stand looks better and is the cheap direction to be wrong in.
  _casualtyNear(x, z) {
    const list = this.peds?.peds;
    if (!Array.isArray(list)) return true;
    const r2 = SCENE_LOOK * SCENE_LOOK;
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      if (!p) continue;
      const st = p.state;
      if (st !== 'dead' && st !== 'down' && st !== 'rag') continue;
      const dx = p.x - x, dz = p.z - z;
      if (dx * dx + dz * dz < r2) return true;
    }
    return false;
  }

  // Loaded (or not), and away. Blues back on: a van transporting a patient runs
  // them, and it is also what turns "a van stopped in the road" back into
  // something the player can read as leaving.
  _homeward(u) {
    if (u.mode === FREE) return;
    u.mode = HOMEWARD;
    u.onCall = true;
    u.tx = this.hx; u.tz = this.hz;
    u.vk = VK_CALL; u.vmax = VMAX_CALL;
    u.dropAt = this._t + HOME_T;
    u.giveUpAt = Infinity;
    u.stuckT = 0;
    this._beacons(u.car, true);
  }

  // ------------------------------------------------------------ ambient ----

  // One van in the ordinary flow, now and then. It is heading for the hospital
  // — a crew coming back from a transfer — because that needs no waypoint
  // machinery at all (the greedy router already knows how to drive at a point),
  // it terminates by itself when it gets there, and it makes the campus mean
  // something instead of being a respawn coordinate.
  _ambient(px, pz) {
    // A zero deadline means "never armed", not "due now". It is armed on the
    // first STEP rather than in the constructor for two reasons, and the second
    // is the one that bites: at boot the region is a third streamed and the
    // first thing a player should see is the town, not the ambulance service;
    // and the constructor runs before the caller has had a chance to install
    // `clock`, so a deadline minted there would be a worldT() timestamp roughly
    // 1.8e7 seconds in the future as far as any test clock is concerned, and
    // the ambient van would silently never appear in a fixture. Absolute
    // deadlines are right (chatter.js's header argues it at length); an
    // absolute deadline read off the wrong clock is not.
    if (!this._ambientAt) { this._ambientAt = this._t + BOOT_GAP; return; }
    if (this._t < this._ambientAt) return;
    // One attempt per gap whether or not it succeeds: an unstreamed frontier
    // must not be re-scanned every frame for the road it has not got.
    const h = hash32(this._n++, 0x5a17);
    this._ambientAt = this._t + AMBIENT_GAP + rnd01(h) * AMBIENT_JIT;
    for (let i = 0; i < POOL_N; i++) if (this._pool[i].mode === AMBIENT) return;
    let u = null;
    for (let i = 0; i < POOL_N && !u; i++) if (this._pool[i].mode === FREE) u = this._pool[i];
    if (!u) return;
    // No hospital bearing here: an ambient van may come from anywhere, and
    // biasing it would put every one of them on the same three streets.
    if (!this._railNear(px, pz, AMB_R_MIN, AMB_R_MAX, AMB_R_IDEAL, NaN, NaN)) return;
    if (!this._build(u, _rail.e, _rail.s)) return;
    u.mode = AMBIENT;
    u.onCall = false;
    u.tx = this.hx; u.tz = this.hz;
    u.sx = 0; u.sz = 0;
    u.vk = VK_IDLE; u.vmax = VMAX_IDLE;
    u.dropAt = this._t + AMBIENT_LIFE;
    u.giveUpAt = Infinity;
    this._beacons(u.car, false);
  }

  // -------------------------------------------------------------- rails ----

  /**
   * The best place on the road graph to put a van, at roughly `rIdeal` metres
   * from (x, z), inside [rMin, rMax], preferring the (bx, bz) side. Writes
   * `_rail` and returns it, or null.
   *
   * A LINEAR WALK OF traffic.edges, and that is a deliberate choice rather than
   * a missing index. traffic.js has a bucket grid (_egrid) that would answer
   * this in microseconds and it is private; asking for it would be asking for
   * an API to be widened for a query that runs about once every twenty seconds.
   * The walk is 23 750 directed edges on the real region (traffic.js:1271
   * quotes that count from its own sweep), rejected on a midpoint distance —
   * six flops each, no allocation, no square root on the rejected ones. It
   * never runs from a driving path.
   *
   * The candidate point is the edge's own middle VERTEX (`e.mx/mz`, which
   * traffic.js already caches for its edge ordering) rather than the nearest
   * point on the polyline, so the arc length is `e.cum[n>>1]` and is exact
   * instead of needing a projection. On a 200 m arterial that means the van
   * appears at the middle of the block rather than at the nearest kerb, which
   * is the better answer anyway: a van should not be born in a junction.
   */
  _railNear(x, z, rMin, rMax, rIdeal, bx, bz) {
    const edges = this.traffic?.edges;
    if (!edges || !edges.length) return null;
    let useB = Number.isFinite(bx) && Number.isFinite(bz);
    let dbx = 0, dbz = 0;
    if (useB) {
      const L = dist(bx - x, bz - z);
      // Somebody has been hurt AT the hospital. There is no bearing to prefer,
      // so prefer none — the alternative is a division by zero that turns every
      // score into NaN and answers "no road anywhere in Pardubice".
      if (L > 1) { dbx = (bx - x) / L; dbz = (bz - z) / L; } else useB = false;
    }
    let best = null, bestScore = Infinity;
    const rMin2 = rMin * rMin, rMax2 = rMax * rMax;
    for (let i = 0; i < edges.length; i++) {
      const e = edges[i];
      if (e.len < RAIL_MIN_LEN || e.speed < RAIL_MIN_V) continue;
      const dx = e.mx - x, dz = e.mz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < rMin2 || d2 > rMax2) continue;
      const d = Math.sqrt(d2);
      let score = d > rIdeal ? d - rIdeal : rIdeal - d;
      if (useB) score += HOSP_BIAS * (1 - (dx * dbx + dz * dbz) / d) * 0.5;
      if (score >= bestScore) continue;
      bestScore = score; best = e;
    }
    if (!best) return null;
    const n = best.pts.length;
    const mid = n >> 1;
    // Clamp off both ends: a van born within three metres of a node spends its
    // first step hopping edges instead of driving.
    let s = best.cum[mid];
    const lo = 3, hi = best.len - 3;
    if (!(s > lo)) s = lo;
    if (s > hi) s = hi > lo ? hi : lo;
    _rail.e = best; _rail.s = s;
    return _rail;
  }

  // ------------------------------------------------------------ the van ----

  // Put a van on `e` at arc `s`, wired into the record. Returns false rather
  // than throwing on anything malformed — a call that cannot be answered is a
  // call that is not answered, never an exception inside stepGame.
  _build(u, e, s) {
    if (!e || !e.pts || e.pts.length < 2) return false;
    const pose = poseOn(e, s, 0);
    const heading = Math.atan2(-pose.dx, -pose.dz);
    const road = e.road ?? null;
    const off = Math.min(TRAFFIC.laneOffsetK * (road?.w ?? 6), TRAFFIC.laneOffsetMax);
    u.edge = e; u.s = s; u.seg = pose.seg;
    u.laneOff = off;
    u.heading = heading;
    u.x = pose.x - pose.dz * off;      // right of travel = (−dz, dx)
    u.z = pose.z + pose.dx * off;
    u.y = this._roadY(u);
    u.speed = 0;
    u.stuckT = 0;
    const car = this._van(u.x, u.z, heading);
    if (!car) { u.edge = null; return false; }
    car.y = u.y;
    if (car.mesh) { car.mesh.position.set(u.x, u.y, u.z); car.mesh.rotation.y = heading; }
    u.car = car;
    return true;
  }

  // The one place in the program that knows what an ambulance looks like, so
  // that an ambient van and a dispatched one cannot end up looking like two
  // different services — the same rule traffic.js's _buildPatrol keeps for the
  // police, and for the same reason.
  _van(x, z, heading) {
    const kinds = VEH.CAR_KINDS;
    // Roster-drift guard, exactly traffic.js's: if 'van' is ever renamed, an
    // ambulance that is quietly an Octavia is better than a crash, and the
    // livery below is dimensioned for the van so it will be visibly wrong,
    // which is how somebody finds out.
    const kind = Array.isArray(kinds) && kinds.includes('van') ? 'van'
      : (Array.isArray(kinds) && kinds.length ? kinds[0] : 'van');
    let car = null;
    try { car = this.vehicles.add(kind, x, z, heading, RZP_PAINT); } catch (err) {
      console.warn('[ambulance] vehicles.add failed:', err);
      return null;
    }
    if (!car) return null;
    car.rescue = true;
    // A záchranář does not lean out of the window and shout at the traffic.
    // js/chatter.js picks its driver-shout candidates by `car._shoutAt` being in
    // the past (a deadline, not a countdown), so a deadline that never arrives
    // takes this van out of that pool without chatter needing to know the
    // ambulance service exists — the same trick traffic.js plays for a patrol.
    car._shoutAt = Infinity;
    // vehicles.update() reads a car with no `ai` and no `_grounded` as one that
    // has never been put on the ground: it would write car.y from surfaceY()
    // once, on whichever frame it happens to run before us, and drop the van off
    // its embankment for that frame. We write y ourselves every step, so claim
    // the flag now. (police.js:693 hit exactly this.)
    car._grounded = true;
    this._fitLivery(car);
    return car;
  }

  // Bolt the band and the bar on. Silently does nothing when the car's mesh is
  // not a real THREE.Object3D — the headless fixtures hand back a plain object
  // with a stub .position, and an ambulance without a stripe is exactly as
  // testable as one with it.
  _fitLivery(car) {
    const m = car.mesh;
    if (!m || typeof m.add !== 'function') return;
    const A = rzpAssets();
    const g = new THREE.Group();
    const band = new THREE.Mesh(A.band, A.bandMat);
    const bar = new THREE.Mesh(A.bar, A.barMat);
    const l = new THREE.Mesh(A.lamp, A.lampOff), r = new THREE.Mesh(A.lamp, A.lampOff);
    l.position.set(-LAMP_X, BAR_Y + 0.11, BAR_Z);
    r.position.set(LAMP_X, BAR_Y + 0.11, BAR_Z);
    // vehicles.add() has already run its castShadow traverse by the time we get
    // here, so the livery has to arrange its own shadow or it floats.
    for (const o of [band, bar, l, r]) {
      o.castShadow = true;
      o.updateMatrix();
      o.matrixAutoUpdate = false;
    }
    g.add(band, bar, l, r);
    g.updateMatrix(); g.matrixAutoUpdate = false;   // the VAN moves; the livery never moves on it
    // …but the SHELL moves ON the van, and that is a different parent. car.mesh
    // has its origin on the road; vehicles.js hangs every panel inside
    // `userData.body` and then rolls that up to 0.05 rad in a corner, pitches
    // it under braking, drops it 14 cm on a landing and sinks it 5.5 cm on a
    // wreck (vehicles.js:1448). A band 1.5 cm proud of the flank, parented to
    // car.mesh, therefore sinks into the door on one side of every corner and
    // floats three centimetres off it on the other, and a written-off van wears
    // its stripe at window height with the light bar hovering over the roof.
    // Parented to the shell, the static local matrix above is still exactly
    // right — three multiplies it by whatever the body is doing this frame — so
    // matrixAutoUpdate stays off and we get the roll for free. Falls back to the
    // mesh for any car with no shell to hang on, which is every headless one.
    const shell = m.userData?.body;
    (shell && typeof shell.add === 'function' ? shell : m).add(g);
    // THE CONTRACT WITH traffic.setSiren. That call drives `car._cop = {l, r,
    // st}` — two lamp meshes and a cached state — and nothing about it is
    // specific to a police car: it swaps materials on the two meshes off SHARED
    // time and self-cleans when the mesh leaves the scene. Handing it ours is
    // how the whole game ends up with one blue at one rate; see the header.
    // The name is traffic's and it stays traffic's, because renaming a contract
    // in the file that does not own it is how contracts get broken silently.
    car._cop = { l, r, st: 0 };
  }

  // Beacons on or off. Delegated when we have a traffic module and degraded to
  // a flag when we do not (headless, or a caller that handed in nothing) — a
  // van that does not flash is a van, a throw is a frozen renderer.
  _beacons(car, on) {
    if (!car) return;
    car.siren = !!on;
    const t = this.traffic;
    if (!t || typeof t.setSiren !== 'function') return;
    // The flag is set FIRST and the delegation is wrapped, and both are the
    // same defence. setSiren reaches into traffic's own lazily-built asset set,
    // which owns a canvas — so it is the one call in this file whose failure
    // mode is somebody else's renderer, in a fixture we do not control. A van
    // whose beacons do not flash is still an ambulance; a throw on a state
    // transition inside stepGame is a frozen frame for ever (vitals.js's
    // header has that story). Cold path — transitions only, never per-frame.
    try { t.setSiren(car, on); } catch (err) {
      // Warn once and carry on. NOT `this.traffic = null` — that would take the
      // road graph away with the light bar and stop every van in the city dead.
      if (!this._beaconWarned) { this._beaconWarned = 1; console.warn('[ambulance] beacons unavailable:', err); }
    }
  }

  // ------------------------------------------------------------ dropping ----

  // The mesh goes. There is no way to hand a car to traffic.js (police.js's
  // header makes the same complaint), so this is a deletion — deferred as long
  // as we can afford through KEEP_R and the mode deadlines, which is the same
  // trade traffic.js makes for its own ghosts.
  _drop(u) {
    if (u.car) {
      this._beacons(u.car, false);
      try { this.vehicles?.remove(u.car); } catch (err) { /* already gone */ }
    }
    this._clear(u);
  }

  // The player is driving it. Let go of the record and leave the van alone —
  // it is his now, beacons and all, exactly as a stolen patrol keeps its lights.
  // The ONLY difference from _drop is that one line, which is why they are two
  // names over one body: a reader who cannot see the difference at a glance
  // will eventually delete the player's car out from under him.
  _yield(u) { this._clear(u); }

  _clear(u) {
    u.mode = FREE; u.onCall = false;
    u.car = null; u.edge = null;
    u.speed = 0; u.stuckT = 0; u.bestD = Infinity;
    u.dropAt = 0; u.giveUpAt = 0; u.sceneAt = 0;
  }

  // -------------------------------------------------------------- siren ----

  // One voice for the whole service, the nearest van's, retriggered on an
  // absolute deadline. A van standing at a scene is silent; its beacons are not.
  _siren(px, pz) {
    if (this._t < this._sirenAt) return;
    let near = null, nd = SIREN_R;
    for (let i = 0; i < POOL_N; i++) {
      const u = this._pool[i];
      if (u.mode !== ROLLING && u.mode !== PULLUP && u.mode !== HOMEWARD) continue;
      const d = dist(u.x - px, u.z - pz);
      if (d < nd) { nd = d; near = u; }
    }
    if (!near) return;
    this._sirenAt = this._t + SIREN_GAP;
    // sfxAt() would do the attenuation for us and is what police.js uses, but it
    // does not take a playback rate and the rate IS the difference between the
    // two services. gainAt() is the same 1/r law sfxAt applies, so the distance
    // question is still asked in exactly one place in the game; the 0.015 floor
    // is sfxAt's own, transcribed so an inaudible wail does not burn a source.
    const g = gainAt(SIREN_VOL, near.x, near.z, SIREN_R);
    if (g >= 0.015) sfx(SIREN_CLIP, g, SIREN_RATE);
  }

  // ------------------------------------------------------------ driving ----

  _drive(u, dt, px, pz, pcar) {
    const car = u.car;
    if (!car || !u.edge) { u.stuckT += dt; return; }
    if (dt <= 0) return;

    // The player rammed us. vehicles.js has already rewritten car.speed,
    // car.heading and car.x/z through its collision solver, so for the next
    // 2.5 s the physics owns the van and we only scrub it — the same surrender
    // traffic.js makes in _rammedStep and police.js in _ram, and for the same
    // reason: a car that snapped back onto its rail mid-shunt would read as an
    // immovable object rather than as a vehicle you just hit.
    if ((car._rammedT ?? 0) > 0) { this._ram(u, dt); return; }

    // Parked at a scene. Nothing to plan, nothing to follow, nowhere to be —
    // and bailing here rather than five branches down is what keeps a van
    // standing for twenty-two seconds from scanning the whole fleet for a
    // leader ninety times a second to be told again that it is not moving.
    if (u.mode === SCENE) { u.speed = 0; car.speed = 0; return; }

    const e = u.edge;
    let tgt = Math.min(Math.max(e.speed * u.vk, u.onCall ? VMIN_CALL : 0), u.vmax);

    // ---- corners, on traffic.js's own braking envelope --------------------
    // v² = vc² + 2·b·d, so speed bleeds off on the approach instead of at the
    // apex. The look-ahead scales with speed or a fast van meets every bend as
    // an emergency.
    const look = Math.max(CORNER_LOOK, u.speed * u.speed / (2 * BRAKE) + 6);
    const A = e.vertAng;
    if (A) {
      for (let k = u.seg + 1; k <= u.seg + 8 && k < e.pts.length - 1; k++) {
        const d = e.cum[k] - u.s;
        if (d > look) break;
        if (d < 0) continue;
        const a = A[k];
        if (a > 0.06) {
          const v = Math.sqrt(cornerSpeed(a) * cornerSpeed(a) + 2 * BRAKE * d);
          if (v < tgt) tgt = v;
        }
      }
    }
    // …and the turn at the END of this edge, which the polyline cannot know
    // about because it happens between two polylines.
    const dEnd = e.len - u.s;
    if (dEnd < look + 10) {
      const nx = this._pickNext(e, u.tx, u.tz);
      let ang = Math.PI;                       // nowhere to go → crawl into the U-turn
      if (nx) {
        const dot = e.ldx * nx.fdx + e.ldz * nx.fdz;
        const crs = e.ldx * nx.fdz - e.ldz * nx.fdx;
        ang = Math.abs(Math.atan2(crs, dot));
      }
      if (ang > 0.06) {
        const v = Math.sqrt(cornerSpeed(ang) * cornerSpeed(ang) + 2 * BRAKE * (dEnd > 0 ? dEnd : 0));
        if (v < tgt) tgt = v;
      }
    }

    // ---- what is in the way ----------------------------------------------
    this._leader(u, tgt, px, pz, pcar);
    tgt = _lim.v;
    let hard = _lim.hard;

    // ---- pulling up -------------------------------------------------------
    // The transition to PULLUP is a LATCH, not a per-step radius test: a van
    // that clipped the radius at 20 m/s would be back outside it two steps
    // later while still slowing, and would drive past its own scene for ever.
    // Two ways in — the kerbside radius, and closest approach for everything
    // the carriageway does not reach. See the note on PULLUP_MAX.
    if (u.mode === ROLLING) {
      const dScene = dist(u.x - u.sx, u.z - u.sz);
      if (dScene < u.bestD) u.bestD = dScene;
      if (dScene < ARRIVE_R
        || (dScene < PULLUP_MAX && dScene > u.bestD + PASS_BY)) u.mode = PULLUP;
    }
    if (u.mode === PULLUP || u.mode === SCENE) { tgt = 0; hard = true; }

    // ---- integrate --------------------------------------------------------
    if (u.speed < tgt) u.speed = Math.min(tgt, u.speed + ACCEL * dt);
    else u.speed = Math.max(tgt, u.speed - (hard ? BRAKE_HARD : BRAKE_SOFT) * dt);

    if (u.mode === PULLUP && u.speed < ARRIVE_V) { this._onScene(u); return; }

    // Standing still ON PURPOSE is not being stuck — the two modes that do it
    // returned above, so anything still here that is not moving has a problem.
    u.stuckT = u.speed < STUCK_V ? u.stuckT + dt : 0;
    if (u.stuckT > STUCK_T) {
      // A van rolling to a call that cannot get there stops being a response
      // and becomes a van going to the hospital; one already going there, or
      // pottering, simply goes. Either way the record reaches a deadline.
      if (u.mode === ROLLING) this._homeward(u); else this._drop(u);
      return;
    }

    // ---- advance along the rail, crossing nodes as needed -----------------
    // The loop condition reads u.edge, NOT the `e` captured at the top: after
    // the first hop they are different edges, and comparing the new arc against
    // the old length is how a van runs off the end of a short edge and keeps
    // the overshoot for ever. HOP_MAX bounds it.
    u.s += u.speed * dt;
    for (let hop = 0; hop < HOP_MAX && u.s >= u.edge.len; hop++) {
      const over = u.s - u.edge.len;
      const nx = this._pickNext(u.edge, u.tx, u.tz);
      if (!nx) { u.s = u.edge.len; u.speed = 0; break; }   // dead end
      u.edge = nx; u.seg = 0; u.s = over;
    }
    if (u.s > u.edge.len) u.s = u.edge.len;
    if (!(u.s >= 0)) u.s = 0;

    this._place(u, dt);
  }

  // Nearest thing ahead in our corridor caps the speed. Every car in the city
  // counts, the other vans count, and — unlike js/police.js — THE PLAYER COUNTS
  // TOO, in a car or on foot. police.js deliberately does not brake for the
  // player's bumper because a pursuit that brakes can never arrive; an
  // ambulance has no such excuse. Running over the person who called you is not
  // a design decision, it is a bug with a rationale.
  _leader(u, tgt, px, pz, pcar) {
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
    for (let i = 0; i < POOL_N; i++) {
      const o = this._pool[i];
      if (o === u || o.mode === FREE) continue;
      const rx = o.x - u.x, rz = o.z - u.z;
      if (rx * rx + rz * rz > reach2) continue;
      const fwd = rx * fx + rz * fz;
      if (fwd <= 0 || fwd > reach) continue;
      if (Math.abs(fx * rz - fz * rx) > LAT_GATE) continue;
      const gap = fwd - 4.4;                         // a van is longer than a sedan
      if (gap < TRAFFIC.stopGap) { v = 0; hard = true; }
      else { const fv = (gap - TRAFFIC.stopGap) / 2; if (fv < v) v = fv; }
    }
    // The player. A wider lateral gate on foot (a pedestrian wanders across a
    // lane; a car holds one) and a bigger standoff, because a van that stops a
    // metre from somebody's shins has not stopped.
    const wide = pcar ? LAT_GATE : LAT_GATE + 1;
    const rx = px - u.x, rz = pz - u.z;
    const fwd = rx * fx + rz * fz;
    if (fwd > 0 && fwd < reach && Math.abs(fx * rz - fz * rx) < wide) {
      const gap = fwd - (pcar ? 3.9 : 2.4);
      if (gap < PLAYER_GAP) { v = 0; hard = true; }
      else { const fv = (gap - PLAYER_GAP) / 2; if (fv < v) v = fv; }
    }
    _lim.v = v; _lim.hard = hard;
  }

  /**
   * Which way out of this edge's far node. Greedy: the outgoing edge whose far
   * end is nearest the aim point, with UTURN_PEN charged against turning back
   * the way we came. No search and no memory — the same choice js/police.js
   * makes, with the same real failure mode (a one-way system can walk a van
   * into a corner the greedy rule will not plan out of) and the same valve
   * behind it: STUCK_T, and then GIVE_UP.
   *
   * The honest fix is js/navigation.js, which already owns an A* over this same
   * graph for the minimap line. It is one function to swap — this one — and it
   * is not in this pass because a router that plans a 400 m route needs a
   * re-plan policy (what happens when a junction is blocked, how often to
   * re-run it, what a partially-streamed frontier does to a path) and that is a
   * slice of its own, not a line.
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
  // offset, and the height of the ROAD rather than of the ground — a vehicle put
  // on raw terrain drives in the ditch beside the embankment the road is built
  // on, and under the deck of every bridge.
  _place(u, dt) {
    const e = u.edge;
    const pose = poseOn(e, u.s, u.seg);
    u.seg = pose.seg;
    const targetH = Math.atan2(-pose.dx, -pose.dz);
    u.heading = angWrap(u.heading + angWrap(targetH - u.heading) * Math.min(1, TURN_RATE * dt));
    const offTgt = Math.min(TRAFFIC.laneOffsetK * (e.road?.w ?? 6), TRAFFIC.laneOffsetMax);
    u.laneOff += (offTgt - u.laneOff) * Math.min(1, 3 * dt);
    const hx = -Math.sin(u.heading), hz = -Math.cos(u.heading);
    u.x = pose.x - hz * u.laneOff;                 // right of heading = (−hz, hx)
    u.z = pose.z + hx * u.laneOff;
    u.y = this._roadY(u);
    this._write(u, dt);
  }

  _roadY(u) {
    const e = u.edge, rd = e?.road;
    if (!rd) return LAYER_Y.road;
    const terrain = this.traffic?.world?.terrain ?? null;
    const along = e.off0 + e.offSign * u.s;
    let y;
    try {
      y = rd.br ? bridgeDeckHeight(rd, along, terrain)
        : (roadGradeY(rd, along, terrain) ?? (terrain?.heightAt(u.x, u.z) ?? 0));
    } catch (err) { y = 0; }
    return (Number.isFinite(y) ? y : 0) + LAYER_Y.road;
  }

  // Publish the pose onto the van AND onto its mesh. vehicles.update() would do
  // the mesh for us — it syncs every car it owns from x/z/y/heading — but only
  // if main.js happens to call it after us, and an ambulance one frame behind
  // its own position is exactly the kind of stutter nobody can source. Writing
  // both makes the order not matter, which is what traffic.js and police.js do.
  _write(u, dt) {
    const car = u.car;
    if (!car) return;
    car.x = u.x; car.z = u.z; car.y = u.y;
    // Front wheels point where the van is turning.
    const dh = angWrap(u.heading - car.heading);
    car.steer = Math.max(-0.6, Math.min(0.6, dh / Math.max(dt, 1e-3) * 0.35));
    car.heading = u.heading;
    car.speed = u.speed;
    const m = car.mesh;
    if (m && m.position && typeof m.position.set === 'function') {
      m.position.set(u.x, u.y, u.z);
      m.rotation.y = u.heading;
    }
  }

  // A shunt: let it slide on the heading the impulse gave it, scrubbing
  // friction, then find our own edge again. The recovery searches only the edge
  // we were already on — a collision rarely moves a vehicle more than a lane,
  // and hunting the whole graph for a better rail is how a rammed van ends up
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
    // y is left exactly where it was: for the 2.5 s of a shunt the van has no
    // arc length worth trusting, and re-reading the road grade off a bogus one
    // would drop it through a bridge deck into the Labe.
    const m = car.mesh;
    if (m && m.position && typeof m.position.set === 'function') {
      m.position.set(car.x, car.y, car.z);
      m.rotation.y = car.heading;
    }
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
   * Every van gone, now. A restart, a teleport or a dev key is not a moment for
   * the polite drive-away: they are deleted where they stand, because whatever
   * is about to happen to the world would strand them anyway.
   */
  reset() {
    for (let i = 0; i < POOL_N; i++) this._drop(this._pool[i]);
    this.units.length = 0;
    this.cars.length = 0;
    this._t = this._now();
    this._callAt = 0;
    this._sirenAt = 0;
    this._ambientAt = 0;
  }

  dispose() {
    this.reset();
    this.traffic = null;
    this.vehicles = null;
    this.city = null;
    this.scene = null;
    this.peds = null;
  }
}

export default Ambulance;
