// ---- Traffic: AI cars commuting on the real Pardubice street grid (v8) ----
// The drivable OSM ways (d=1) become a directed graph: way endpoints plus any
// point shared between two drivable ways are nodes, and ways are split into
// edges between consecutive nodes. AI cars then just walk edges — pick an
// outgoing edge at each node, hug the right side of the road, brake for
// corners ahead, for red lights and for the car in front. Visuals come from
// vehicles.add(); we are only the brain, writing x/z/heading/speed and the
// mesh transform directly (no driveStep physics — rail-following is cheaper
// and never wanders off the asphalt).
//
// v3: the graph GROWS — city.onTileLoaded streams 4.8 km region tiles in and
// addTile() ingests their roads/signals incrementally (node keys are rounded
// coordinates, so a way clipped at a tile border reconnects to its other half
// simply by hashing to the same node). Traffic LIGHTS cluster the OSM
// highway=traffic_signals points into 2-phase junction controllers with real
// pole meshes, and cars the player rams (vehicles.js sets _rammedT) go limp,
// slide out on friction, then re-snap onto their rail and drive on.
//
// v7: the city stops crawling. Missing maxspeed falls back to the CZECH
// defaults per road class (the old flat `|| 30` made every untagged street a
// školní zóna), every driver carries a personal speed factor so a 50 street
// holds 36–59 km/h of honest disagreement, blocked drivers HONK (audio.js
// horn(), personal cooldown, global budget), and junctions where main roads
// demonstrably cross get SYNTHESIZED signal controllers — OSM's signal
// coverage out in the region is far too sparse for how the roads are built.
//
// ==========================================================================
// v8: THE SAME CARS ON EVERY SCREEN.
//
// The user asked for co-op where two players see the same traffic. Nothing
// about v7 could do that, for three independent reasons:
//
//   1. POPULATION WAS RELATIVE TO ME. Cars were born inside TRAFFIC.spawnR of
//      the local player and died past despawnR — "of me". Two players 300 m
//      apart drew from the same road graph with two different centres, so
//      even with a shared seed the SEQUENCE of spawns differed and the fleets
//      had nothing in common.
//   2. MOTION WAS A LOCAL INTEGRAL. Position was the accumulated history of
//      one machine's frame times. Twelve of the file's numbers came out of
//      Math.random, and the signal clock was `this._t += dt` — a per-tab
//      accumulator that started at zero whenever the page loaded.
//   3. THE STEP WAS THE FRAME. 144 Hz and 30 Hz integrate the same rules to
//      different answers, so even two identical starts would part ways.
//
// The fix, in one sentence: a car's NOMINAL position is a pure function of
// shared world time, and everything local — braking for the player, queueing
// behind the car in front, being rammed — may only make a car LAG BEHIND that
// nominal, never lead it, and the lag decays back to zero the moment the road
// clears. Divergence therefore cannot accumulate: it is a transient with a
// restoring force, not a random walk.
//
//   POPULATION = f(CELL).  The world is diced into CELL-metre squares. A cell
//   holds a number of car SLOTS proportional to how much drivable road its
//   midpoints carry, so density follows the city rather than the player, and
//   both players compute the same slot count for the same square. Slot k of
//   cell (i,j) is occupied by generation g = floor((worldT + phase)/TRIP_T);
//   the car's every property — start edge, entry offset, kind, paint, driver
//   personality, route, route length — is hash32(cell, k, g) and nothing else.
//   No Math.random survives anywhere on the shared path.
//
//   SCHEDULE = f(TIME).  The nominal is not integrated at 20 Hz from birth —
//   that would make a late joiner pay thousands of steps to catch up. It is a
//   forward recurrence over EDGES: enter edge at time t, cross its segments at
//   min(limit·vK, corner speed), and if the edge carries a signal, arrive at
//   the stop line, ask the light (itself a pure function of worldT) and wait
//   out the red. Catching up a 150-second-old car costs ~20 iterations, so we
//   can afford to keep the nominal alive for every car that could possibly
//   walk into view, whether or not it currently has a mesh.
//
//   FIXED STEP.  The reactive layer runs at SIM_HZ on a grid anchored to
//   SHARED time (floor(worldT/SIM_DT)), never on frame times, and the frame
//   interpolates between the last two steps. 30 fps and 144 fps produce the
//   same simulation.
//
// WHAT STILL DIVERGES, and why that is survivable — read this before trusting
// the word "deterministic" anywhere above:
//
//   · The lag is driven by the local player. Player A blocking a lane is not
//     player B's problem, so those two clients hold different queues. Bounded
//     by LAG_MAX, and it drains at CATCH_K the second the road clears. If
//     main.js fills `traffic.actors` with the ghost cars too (see the note on
//     `actors` below), even this mostly goes away, because then every client
//     brakes for every player, not just for its own.
//   · Math.atan2 and Math.sin are NOT bit-specified by ECMA-262, so two
//     different browser ENGINES can disagree in the last place on turn angles.
//     Every OTHER shared quantity in this file now uses only +−×÷ and sqrt
//     (which IS correctly rounded), including all distances — that is why
//     Math.hypot, whose precision is explicitly implementation-defined, was
//     replaced with `dist()` throughout. Two tabs of the same browser are
//     bit-identical; Chrome vs Safari can in principle differ by an ULP, which
//     only becomes visible if a car arrives at a stop line within 1e-12 s of
//     the amber-to-red boundary.
//   · Junction PHASE is now order-independent (hashed from the cluster's
//     lexicographically smallest quantised signal point, not from whichever
//     point happened to arrive first). Junction MEMBERSHIP still is not: if
//     tiles arrive in a different order, two clients can in principle cluster
//     a borderline pair of poles differently. Real OSM signals ship in the
//     same tile as the roads they govern and _growSignals runs before
//     _synthSignals within one addTile, so this is confined to junctions that
//     straddle a tile border AND have arms in both tiles.
//   · A car materialises where the schedule says, which can be 40 m in front
//     of you. v7 refused to spawn within SPAWN_MIN; a shared world cannot,
//     because "near me" is not a shared fact. TRIP_T is deliberately long to
//     keep the birth rate low.  ← v9 fixes exactly this line; see below.
//
// The authority SNAP channel is NOT used and does not need to be — see the
// note above _drive() for the byte count it would have cost.
//
// ==========================================================================
// v9: NOTHING APPEARS OR DISAPPEARS WHILE YOU ARE LOOKING AT IT.
//
// v8 bought a shared fleet and paid for it with pop. Measured on the real
// region graph (8 tiles around the station, 300 s per scenario), 19–42 % of
// all mesh attachments happened INSIDE 500 m, and every single one of those
// was a car whose schedule had been minted in the same sweep: the world did
// not drive a car into view, it grew one there. On the other side, a meshed
// car was destroyed 24–35 times a minute — generation rollover, end of route,
// density change — with no visibility test whatsoever.
//
// The rule this file now keeps:
//
//   A MESH IS ONLY EVER CREATED OR DESTROYED WHERE THE PLAYER CANNOT SEE IT.
//
// Three pieces make that true, and the first one is new API:
//
//   1. THE VIEWER. setViewer() (below) tells us where the local camera is,
//      which way it faces, how wide it sees, and at what distance the fog
//      makes an appearance unnoticeable. _visible(x,z) is then a real test
//      instead of a guess. WITHOUT a viewer we behave exactly as v8 did —
//      headless tests and any caller that has not been taught the new call
//      keep their old semantics, they just keep the old pop with them.
//
//   2. ATTACH HAPPENS BEHIND YOU, BEYOND THE FOG, OR — FAILING BOTH — AT THE
//      GREATEST DISTANCE THE CAR WILL EVER BE SEEN AT. A schedule outside the
//      cone takes a mesh anywhere inside spawnR, because you are not looking.
//      A schedule inside the cone takes one anywhere from NOTICE_R outwards,
//      and the sweep gives it one at the FIRST opportunity, so in practice
//      that means out at the fog wall in the band [hideR, hideR + RING_W]
//      where a fade-in cannot be read. A car driving towards you therefore
//      always ARRIVES: it crosses the fog wall with a mesh already on. Note
//      that the band sits OUTSIDE TRAFFIC.spawnR — the old ring at 520 m was
//      inside the 634 m fog wall, so even the "honest" ring crossing popped.
//
//      NOTICE_R is v9.1 and it is not a softening for its own sake; see the
//      note on the constant. The one-line version: v9.0 refused the cone at
//      EVERY distance, and a car that is born inside your fog wall and stays
//      in your cone for its whole trip — which on a motorway is all of the
//      traffic ahead of you, because it holds station — then never got a mesh
//      at all. Measured, that emptied the road ahead to 30 % of v8 on the D11.
//
//   3. RETIREMENT IS DEFERRED, AND THE DEFERRAL IS LOCAL. When the schedule
//      says a car is finished (generation rollover, route ended, the cell's
//      slot count shrank) and that car is visible, we do NOT destroy it. It
//      leaves the shared population — the slot is released the same instant,
//      so the schedule is untouched and the next generation is minted on time
//      — and becomes a GHOST: a purely local car that keeps driving, on its
//      own, extending its route as needed, until it is out of sight. Then the
//      mesh goes.
//
// ---- ghosts vs. determinism, which is the delicate part -------------------
// The temptation is to keep the retiring car IN the slot as a tombstone and
// hold the next generation back until it clears. That would be wrong: the
// slot's occupancy is a shared fact, snapshot() would start disagreeing
// between two clients whose views differ, and the whole v8 contract (the
// fleet is a function of the cell and the clock, of nothing else) would be
// broken by something as arbitrary as which way one player's head is turned.
//
// So a ghost is moved OUT of _pool into _ghosts the moment it is created. The
// consequences, deliberately:
//   · _pool, snapshot(), and every hash that feeds them are bit-identical to
//     what they would be without the deferral. The two clients still agree on
//     every car the schedule claims. The determinism tests do not know ghosts
//     exist.
//   · a ghost is a car ONE client draws and the other does not. That is the
//     price, and it is the right one: the alternative — deleting a car from
//     under the player's eyes — is the artefact we were sent to remove, and
//     the peer's screen is not where the artefact was.
//   · a ghost has no shared identity, so slotKey() returns null for it and a
//     steal of one is not broadcast (there is nothing for the peer to claim:
//     on his machine that slot already belongs to the next generation).
//   · ghosts are bounded three ways — they only exist while visible, they
//     drive away by themselves, and GHOST_MAX caps the whole business.
//
// ---- when the deferral cannot be honoured (the lesser evil) ---------------
// A ghost boxed in by the player's own car — parked across its bonnet, being
// stared at — would be held forever. After GHOST_MAX seconds we take the mesh
// anyway. That is a visible pop, and it is the smaller evil: an immortal ghost
// is an ever-growing local fleet, i.e. a frame-rate leak with no upper bound,
// and it is also a car the peer cannot see, standing in the middle of a road.
// Measured over the real region graph AT THE PRODUCT'S OWN DEFAULT DENSITY
// (settings.traffic = 240, i.e. _densK ≈ 2.7, ~120 cars — not the density-1
// fixture the first draft of this paragraph quoted, which is why it claimed a
// third of the true rate): 30 minutes standing still surrenders 1.5 meshes a
// minute, of which 0.03/min are in the forward cone within 300 m and 0.00/min
// within 150 m. That is with GHOST_MAX at its present value; at the 40 s it
// used to be, the same run gave 4.1/min, 0.63/min and 0.07/min — a car
// vanishing in front of you about once every 95 s, which is exactly the
// artefact this file exists to remove, so the constant was tripled. A ghost
// that can move leaves a 116° cone in a few seconds by itself, so the ones
// that reach the deadline are the ones already blocked; the deadline is paid
// for in live ghosts (5.2 → 9.4 on average, peak 12 → 18) and they are cheap.
// Likewise, hideR is CLAMPED to HIDE_R_MAX. From a helicopter the fog wall is
// past 3 km and honouring it would mean thousands of meshes; above the clamp
// we accept the ring pop, at which distance and altitude a car is a couple of
// pixels. Perfect invisibility is not worth a slideshow.
//
// ==========================================================================
// v10: THE POLICE ARE ORDINARY TRAFFIC.
//
// A pursuit system needs police cars on the street before it needs anything
// else, and the obvious way to get them — a little spawner of its own that
// keeps N patrols near the player — is precisely the mistake v8 spent this
// whole file undoing. A patrol minted "near me" is minted somewhere else on
// the other client, and the very first thing co-op does with a police car is
// put two players in the same chase; two players being chased by two
// different cars is worse than no police at all. Two traffic systems would
// also have meant two answers to every question this file has already
// answered once: where a mesh may appear, what happens at a red light, who
// yields at a junction, what a generation rollover does to a car you are
// watching.
//
// So the police are not a system. They are ONE MORE SLOT in the cell —
// minted by _scanCells, driven by _drive, ghosted by _retire, reaped by
// _sweepPool, clamped against the same schedule — with a hash roll in front
// of it deciding whether this cell owes a patrol this generation. Everything
// v9 promises about pops, and everything v8 promises about two screens, the
// patrol gets for free because it is not special.
//
// It cost three corrections, and all three are the kind that pass every test
// while shipping nothing:
//
//   1. THE REAP MUST AGREE WITH THE MINT. _sweepPool retires any slot whose
//      index has fallen outside the cell's allowance (`p.k >= _slots(cell)`),
//      and the patrol has no index inside that allowance to fall outside of.
//      The first draft handed it k = 0x9c0 — bigger than any slot count the
//      cell can ever have, so every patrol was reaped on the first sweep
//      after its own birth and not one of them would ever have been seen.
//      The mirror-image sentinel is no better: a negative index is smaller
//      than every slot count, which makes the patrol immortal — it would have
//      survived the density slider being dragged to zero. Neither is a number
//      problem, so the fix is not a number: `p.police` is stamped on the
//      schedule at birth and the reap asks THAT (see _patrolOwed), which is
//      also the only version a reader can check by eye. Measured over 1800 s
//      on the real region graph: 202 patrol schedules minted and reaped, 0 of
//      them on the sweep after their own birth, median life 130 s of a 150 s
//      generation. Under the first draft all 202 would have read 0 s.
//
//   2. THE ROLL IS f(CELL, GENERATION), NOT f(CELL). Hashing the cell alone
//      is not a low probability, it is a permanent assignment: the same
//      one-in-six squares carry a police car for the life of the world and
//      the rest never see one, so one street in the centre of Pardubice is a
//      permanent beat and the next one over is a guaranteed safe house — and
//      it is guaranteed identically on every client, which makes it a map
//      feature players would learn inside an hour. Folding the generation in
//      costs one more hash argument and re-rolls the whole city every TRIP_T.
//      Measured over 40 minutes — 18 generations — standing in the middle of
//      the real graph: 57 different cells carried a patrol at some point, and
//      the busiest of them carried one in 10 of the 18. With the cell alone,
//      every one of those 57 would have scored all 18 and no other cell would
//      ever have scored one.
//
//   3. THE HARD CAP DELETED EXACTLY THE WRONG CARS. update()'s safety valve
//      trims farthest-first, and the whole shape of a pursuit is that the
//      unit chasing you is the one that went round the block and is coming
//      back — i.e. by construction the police car furthest from the player is
//      the interesting one, and the valve would take it the moment a chase
//      got going. Police are exempt. Measured with the sweep switched off so
//      that the valve is the only thing left that can take a mesh, and the
//      budget slammed to 4 for 60 s: 53 cars trimmed, fleet 108 → 55, police
//      touched 0, the patrol still on the road at the end of it.
//
// WHAT A PATROL IS, since 'policie' is not in VEH.CAR_KINDS and adding one is
// not this file's call: the stock octavia, painted fleet white, wearing the
// Policie ČR flank livery and a light bar, all built here (see copAssets). That
// is what a Czech police car is, and it means the roster, the crash meshes, the
// physics and the labels all keep working without knowing anything happened.
// The bar hangs off the CAR and not off the schedule, so a patrol keeps its
// lights after js/police.js or a player steals it out of the traffic.
//
// ==========================================================================
// v11: "MUSÍ TO FAKT VYPADAT JAKO POLICEJNÍ AUTO."
//
// It did not. A patrol was PATROL_PAINT — 0xe9eae5, fleet white — plus a
// 34 cm blue nub at each end of a roof bar. Photographed at 7 m that reads.
// At 25 m in traffic it is a pale car among pale cars: THREE of the ten paints
// an octavia draws from (config.js CAR_COLORS 0xd8d5ce, 0xc4c9cf, 0x8a9096)
// are already off-white or grey, the bar was 16 cm of a 1.60 m silhouette, and
// from the chase camera's usual 17° depression the pair of lamps presented
// 0.10 m² of lit face. The player did not say "the bar is small". He said the
// car does not look like a police car, which is a different complaint: at 25 m
// you do not read details, you read a LIVERY — a big block of the wrong colour
// in the right place on the flank. Every real cue we were missing was on the
// side of the car, and the side of the car is what traffic shows you.
//
// So the flank gets what a real Policie ČR Octavia has and we did not: a
// broad blue band across the doors, a thin yellow reflective stripe under it,
// and POLICIE in white on the blue. Three cues, one strip of geometry, one
// texture. See LIVERY_STS for how the strip is lofted onto the octavia's own
// hull stations so it cannot leave the panel, and liveryMat for why the
// lettering is ONE canvas for the whole force and not one per car.
//
// WHAT IT COSTS, since the brief asked for the number. Per patrol, over a
// stock car: 4 Meshes and 1 Group — the bar plinth, its two lamps, and the
// livery strip (both flanks in a single indexed BufferGeometry, so the band
// is one draw call and not two). ZERO geometries, ZERO materials and ZERO
// textures per car: 3 geometries (bar, lamp, livery), 4 materials (bar body,
// lamp off, lamp on, livery) and 1 CanvasTexture exist for the whole force.
// Counted, not asserted: a stock octavia traverses to 18 meshes / 11
// geometries / 10 materials / 2 textures, a patrol to 22 / 14 / 13 / 3, and a
// SECOND patrol built after it introduces exactly 0 new geometries and 0 new
// materials. (13 mounted materials, not 14: both lamps hold the one `off`
// until _tickSirens swaps one of them onto the one `on`.)
//
// The shared-asset claim is not a hope, it is copAssets' shape: `_C` is a
// module-scope cache built on the FIRST patrol that takes a mesh and returned
// by identity forever after, so _fitLightBar cannot allocate a second set
// however many times it runs. The livery went into that same cache rather
// than beside it precisely so there is one lifetime to reason about — a
// client that never meets a police car still builds no canvas, and the six
// parked units, the three ambient patrols and every pursuit js/police.js
// spawns all point at the same three geometries. What DOES scale with the
// fleet is 5 Object3D wrappers each, and that is irreducible: a Mesh is a
// transform, and two patrols are in two places.
//
// DENSITY. A patrol needs a cell with real road on it (PATROL_MAJOR) that is
// carrying ordinary traffic at all, so the traffic slider turns the police
// down with everybody else and off at zero. On the real region graph at the
// product's default density, 284 of the 621 cells that carry any road at all
// are eligible, and the roll leaves about ONE patrol wearing a mesh anywhere
// in the 630 m ring at any moment — out of a 95-car fleet, i.e. one car in a
// hundred. A driver passes within 150 m of a different police car about every
// three minutes. See PATROL_P for the sweep those numbers came out of.
// ==========================================================================

import * as THREE from 'three';
import { TRAFFIC, CAR_COLORS } from './config.js';
import { bridgeDeckHeight, distPointToSegment, roadGradeY } from './geo.js';
import { LAYER_Y } from './config.js';
// namespace import on purpose: pickCarColor is a newer export and a named
// import of something a stale vehicles.js doesn't have is a hard link error —
// the typeof check below degrades to CAR_COLORS instead
import * as VEH from './vehicles.js';
import { horn } from './audio.js';   // safe headless — no-ops without an AudioContext
import { worldT } from './worldclock.js';

// AI-local tuning (config.js owns the player-facing numbers)
const ACCEL = 4.0;            // gentle m/s² — commuters, not street racers
const BRAKE = 5.0;            // planning decel: the anticipation envelope
const BRAKE_SOFT = 7.0;       // actual decel when above target (catches up)
const BRAKE_HARD = 14.0;      // slam when something fills the stop gap
const TURN_RATE = 7.0;        // heading exponential-smoothing rate (1/s)
const CORNER_LOOK = 16;       // meters of polyline scanned ahead for curves
const LAT_GATE = 2.0;         // half-width of the follow corridor (m) — an
                              // oncoming car in the opposite lane sits wider
const HEAD_GATE = 0.61;       // ±35° same-direction test for AI-AI following
// ---- and the rigid body the follow model is not ----------------------------
// The rule above is a CAR-FOLLOWING model and it is right to be: it only looks
// at cars going roughly the same way, because treating the oncoming lane as a
// leader gridlocks every street. But that means two cars on CROSSING rails —
// the whole point of a junction — never see each other at all, and drive
// straight through one another.
//
// So a second, heading-agnostic test runs beside it: if the paths of two cars
// are about to put them in the same place, one of them stops. Predicting a
// short way ahead rather than testing the current overlap is what makes it a
// yield instead of a collision report — by the time two rectangles intersect
// it is already too late to brake.
//
// Right-hand priority breaks the tie. It is the Czech rule, it needs no shared
// state, and it is antisymmetric, so of any two cars exactly one yields.
// The conflict horizon has to be a BRAKING distance, not a constant: a fixed
// 13 m is 0.7 s of travel at 65 km/h, and stopping from 18 m/s under BRAKE_HARD
// needs 11.6 m plus the frame it takes to notice. So it scales with whichever
// car is moving faster — 8 m standing, 16 m at 65 km/h, which leaves 4.5 m of
// margin on the braking distance.
//
// Not further. At 0.9 m per m/s the reach reaches 24 m and cars start yielding
// to conflicts that resolve themselves, which shows up somewhere unexpected:
// a car held at a junction stays in view longer, so more retirements are
// deferred, and tests/traffic-view.test.mjs caught the ghost population going
// from under its cap to 28. Braking distance plus a margin is the right size;
// generosity past that leaks.
const CROSS_R0 = 8, CROSS_RV = 0.45;
const CROSS_T = 1.1;          // s of travel to look ahead when predicting
const CROSS_CLEAR = 4.2;      // m between centres that counts as "the same place"
const STRAIGHT = Math.PI / 6; // ±30° reads as "carrying straight on"
// (v8's RAMP_K lived here: a flat surcharge for the time a car loses slowing
// to a corner. v9's pieceTime() models the accel/brake ramps explicitly, so
// charging for them a second time is exactly the double-count that made the
// city crawl — see the note in _nomTo.)
const SIG_APPROACH = 8;       // m/s a schedule is doing when it reaches a stop
                              // line. Cars slow for a junction whatever colour
                              // it is; without this the schedule would arrive
                              // at 50 and stop in zero metres.
const RAM_FRICTION = 4.0;     // m/s² a rammed (AI-suspended) car scrubs while sliding out
const FAST_EDGE = 50 / 3.6;   // commercial traffic only bothers with ≥50 km/h roads

// kind pools BY NAME (vehicles.js owns the roster — indexing into it broke the
// day the roster was renamed, names don't): škody dominate Czech roads, so the
// everyday pool is mostly octavia/fabia with the odd German sedan and a tesla;
// commercial metal exists but ONLY rolls on fast edges — a bus threading a
// 30 km/h residential loop looks wrong and corners terribly
const COMMON = ['octavia', 'octavia', 'fabia', 'fabia', 'octavia', 'bmw', 'mercedes', 'tesla'];
const BIG = ['van', 'van', 'truck', 'bus'];
const BIG_CHANCE = 0.22;      // roughly every 5th spawn on a main road is commercial

// per-driver speed factor: desire = edge limit × vK. 0.72 is the pensioner in
// the fabia, 1.18 the sales rep late for Hradec — on a 50 street that spread
// is a genuine 36..59 km/h, on a rural 90 it's 65..106
const VK_MIN = 0.72, VK_VAR = 0.46;

// ---- horn tuning ----
const HONK_FRAC = 0.25;       // "held" = pinned under this fraction of desire…
const HONK_HELD = 6;          // …for this long. 2.5 s honked at ordinary flow.
const HONK_CD_MIN = 25, HONK_CD_VAR = 30; // personal cooldown 25–55 s
const HONK_RATE = 0.35, HONK_POOL = 1;    // global budget ≈ one honk every ~3 s max —
                                          // a horn is an EVENT, not a soundtrack
const HONK_R = 190;           // m — how far away a car may still decide to honk.
                              // This used to be 110 because horn() was UNPANNED:
                              // beyond that a honk was simply implausible at full
                              // volume, which is the only volume there was. Now it
                              // attenuates, so the radius is about the honk BUDGET
                              // (one every ~3 s) being spent on cars you can hear —
                              // audio.js fades the last of it out at 220 m.

// ---- traffic-light tuning ----
const SIG_CLUSTER = 30;       // signal points within 30 m share one junction controller
const SIG_EDGE_R = 30;        // edges ENDING this close to a junction center are governed
const SIG_MIN_EDGE = 14;      // shorter edges live INSIDE the junction box (dual-carriageway
                              // stubs) — governing them would stop cars mid-crossing
const SIG_GREEN = 11, SIG_AMBER = 1.5;
const SIG_CYCLE = 2 * (SIG_GREEN + SIG_AMBER);  // 25 s: green+amber per phase, alternating
const SIG_STOP = 5;           // cars hold this many meters short of the junction node
const SIG_VIS2 = 800 * 800;   // pole meshes render within 800 m of the player (frustum
                              // culling handles the rest; a region's worth of poles never
                              // all draw at once)
// ---- synthesized signals: where lights OUGHT to stand but OSM is silent ----
// Which crossings EARN synthesized lights. Both buckets track main-class arms
// (tertiary included — a primary × tertiary junction is signalized in any real
// town), but at least ONE of the crossing roads must be primary/secondary:
// tertiary × tertiary lit up 80 junctions in view at the spawn alone, which
// both gridlocked the traffic on permanent red waves and put ~1200 pole meshes
// into the scene (measured: 12 fps). Pardubice signalizes its arterials, not
// every pair of sběrné komunikace.
const SIG_CLASS = /^(trunk|primary|secondary|tertiary)$/;
const SIG_MAJOR = /^(trunk|primary|secondary)$/;     // one of these must be present
const SYNTH_CLEAR = 45;       // an existing controller this close owns the crossing already
const SYNTH_BACK = 12;        // fabricated stop-line points stand this far up each approach

// ==== v8: the shared population ==========================================
// CELL is the unit the world's traffic is DEFINED on. 256 m rather than the
// streaming CHUNK (120 m) for two reasons: a 120 m square of a Czech town
// often holds one street and would round to zero or one slot, which quantises
// density into visible stripes; and the candidate sweep below walks every cell
// within PHANTOM_R, so halving the cell size quadruples that walk. 256 m holds
// roughly a city block — enough road for the slot count to be a smooth
// function of how built-up the square is.
const CELL = 256;
const CELL_HALF_DIAG = 181.02;         // Math.SQRT2 * CELL / 2, precomputed
// One slot per this many metres of DIRECTED drivable edge (a two-way street
// contributes twice, once per direction — which is right: it carries two
// streams). Calibrated so that a normal Pardubice street grid inside
// TRAFFIC.spawnR lands near TRAFFIC.maxCars at density 1. Empty country has
// almost no road per cell and therefore almost no traffic, for free — that is
// the per-place density main.js used to fake with a building count.
const MPC = 160;
const MAJOR_RE = /^(motorway|trunk|primary|secondary|tertiary)(_link)?$/;
const SLOT_MAX = 8;                    // per cell — a motorway interchange must not
                                       // fabricate thirty cars out of ramp geometry
// How long one slot holds a car before the next generation takes over. Long,
// on purpose: every generation boundary is a car appearing out of nothing and
// another vanishing, and unlike v7 we cannot hide those events behind "not
// near the local player". 150 s ≈ one birth per slot per two and a half
// minutes; with a handful of slots in the cell you stand in, that is a pop
// somewhere in a 256 m square every ~40 s.
const TRIP_T = 150;
// A trip is bounded in LENGTH, and that bound is what makes the whole scheme
// affordable: a car can never be further from its birth cell than ROUTE_MAX,
// so the set of cars that could possibly be near the player is exactly the
// cells within spawnR + ROUTE_MAX. Without a bound we would have to run the
// schedule for the entire region to know who is about to drive round the
// corner.
const ROUTE_MIN = 700, ROUTE_VAR = 500;
const ROUTE_MAX = ROUTE_MIN + ROUTE_VAR;
// ---- v9: the view cone ---------------------------------------------------
// Half-angle added to each side of the camera's own horizontal half-fov. A
// 68° camera is 34° each way; +24° of margin makes the protected cone 116°
// wide, which covers a quick flick of the mouse (a 180°/s turn needs 0.4 s to
// uncover the edge of it, by which time the sweep has moved on) and the fact
// that the chase camera sits behind and below the player, so its cone is not
// exactly the one we test from.
const VIEW_MARGIN = 0.42;
const VIEW_COS_MIN = -0.9;             // never protect more than ~154° each way:
                                       // past that there is nowhere left to work
const PERIPHERAL_R = 26;               // m — this close, treat it as visible at ANY
                                       // yaw. Mirrors, the wide-angle cockpit view
                                       // and simple peripheral vision all cheat.
// Distance past which an appearance is not NOTICEABLE — which is NOT the fog
// wall itself, and the difference is a real trade rather than a rounding. The
// nearer we put it, the more of the fleet has to wait outside the player's
// cone for a mesh, so the road ahead thins; the further out, the closer a
// fade-in creeps to being catchable. Ground preset (fog 127 m → 634 m),
// measured at 50 km/h through town, forward cone within 250 m, and
// haze-weighted pops per minute over the WHOLE cone:
//     0.74 → 469 m:  81 % populated,  3.9 haze-pops/min
//     0.88 → 558 m:  76 % populated,  0.5 haze-pops/min      ← chosen
//     0.95 → 602 m:  75 % populated,  0.2 haze-pops/min, +11 % fleet to pay
// 0.88 is where the pop curve has already flattened and the fleet has not
// started to cost anything. (v8, for scale: 6.2 haze-pops/min here, and its
// attaches ran all the way in to 30 m.)
const HIDE_FOG_K = 0.88;
const HIDE_R_DFLT = 558;               // ground preset, i.e. 634 × HIDE_FOG_K
const HIDE_R_MIN = 240;                // below this the band would sit inside the
                                       // player's own street and there is no hiding
const HIDE_R_MAX = 760;                // …and above it we stop trying: see the
                                       // helicopter note in the v9 header
const ATTACH_SKIN = 16;                // m of slack the attach gate keeps beyond
                                       // hideR — see _visibleForAttach
const RING_W = 72;                     // width of the in-cone attach band. Wide
                                       // enough that a 90 km/h approach spends ~3 s
                                       // of sweeps inside it, narrow enough not to
                                       // inflate the fleet. Widening it does NOT
                                       // populate the road ahead — measured, 72 →
                                       // 600 moves forward-cone occupancy by 0.00
                                       // cars and costs 3× the fleet, because the
                                       // cars that were missing had never been out
                                       // there to catch. NOTICE_R is what fixes it.
// ---- v9.1: the floor under the deferral ----------------------------------
// v9.0's in-cone rule was "not at any distance", and that turned out to be a
// rule the world cannot always satisfy. A schedule only ever gets a mesh where
// the gate allows one, and there are exactly two allowed places: out of the
// cone, or beyond the fog wall. A car that is minted INSIDE the fog wall in
// front of you and stays in front of you is in neither, ever — and on a
// motorway that is the normal case, not a corner one: everything ahead of you
// in your own direction holds station in the cone at a roughly constant
// distance until its route ends, whereupon the schedule dies unbodied. The
// autopsy: of the schedules that reached the forward cone within 300 m on the
// D11, 79 % were never once in an attachable state — not "the sweep missed
// them", there was no state to catch. Forward-cone occupancy: v8 1.04 cars per
// sample, v9.0 0.57.
//
// So the cone is no longer refused outright, only inside NOTICE_R — the radius
// within which a car appearing is READABLE rather than merely visible. 240 m:
// a 4.6 m car there is ~20 px on a 1080p screen at 78 % fog opacity, and the
// nearest slice of that, 150 m, is the radius the pop measurements have always
// scored as "really readable". Swept against the metric on the real region
// graph (occupancy as a fraction of v8, worst of the four scenarios / births
// per minute inside 150 m):
//     150 m:  0.93 / 0.00       240 m:  0.92 / 0.00      ← chosen
//     260 m:  0.91 / 0.00       300 m:  0.63 / 0.00   (the D11 empties again)
// Occupancy is flat from 150 to 260 and falls off a cliff past that, so the
// choice inside the plateau is simply "as far away as still works": every
// metre of NOTICE_R makes the attaches that do happen in view rarer, farther
// and hazier. Haze-weighted, the whole file still lands at a third of v8.
//
// This does NOT re-open v8's real sin. v8 attached all the way in to 30 m and
// its births inside 150 m ran at 0.46–0.60/min while driving; ours are 0.00.
// The deferral is intact — it just has a floor under it instead of a wall.
const NOTICE_R = 240;
const ATTACH_R_MAX = Math.max(TRAFFIC.spawnR, HIDE_R_MAX + RING_W);
const GHOST_MAX = 120;                 // s a locally-retired car may linger in view
const LOOK_BACK = 6;                   // s a car stays protected after leaving the cone —
                                       // long enough to survive a head turn and a glance back
const GHOST_LEG = 320;                 // m of extra route granted to a ghost that
                                       // runs out of itinerary while still watched
// Worst case only, for the reader: the live bound is _phantomR(), which
// tracks the attach radius the current viewer actually asks for, so a client
// that never calls setViewer keeps v8's cheaper sweep exactly.
const PHANTOM_R_MAX = ATTACH_R_MAX + ROUTE_MAX + CELL_HALF_DIAG;
const V_REACH = 30;                    // m/s ceiling used only to prune young cars
                                       // out of the candidate sweep cheaply
const SCAN_DT = 0.25;                  // candidate sweep rate (4 Hz)
const SCAN_BUDGET = 96;                // new schedules minted per sweep. A cold boot
                                       // owes ~900 of them; at 4 Hz that is 2.3 s of
                                       // filling in, which matches what v7's spawn
                                       // burst felt like, and costs ~1 ms a tick
                                       // instead of one 30 ms hitch
const SIM_HZ = 20, SIM_DT = 1 / SIM_HZ;
const SIM_MAX_STEPS = 6;               // a 300 ms hitch replays 6 steps, then gives up
                                       // and re-anchors — better a small jump than a
                                       // spiral of catch-up on a machine already late
const LAG_MAX = 140;                   // m a car may fall behind its schedule. Past
                                       // this it is being deliberately blockaded and
                                       // we stop pretending the world still agrees.
const CATCH_K = 1.35;                  // catching up is allowed at +35 % of the
                                       // driver's desire, never more — a car doing
                                       // 90 in a 50 to make up a red light is worse
                                       // than the two metres of disagreement it fixes
// …unless nobody can see it. Lag is legitimate while a queue is forming and a
// nuisance once the queue is gone, and the one thing that reliably strands a
// car tens of metres behind its schedule is a light turning green on a queue:
// every nominal launches together, the real cars launch one after another, and
// the tail owes the queue's whole length. Beyond LAG_FREE_R of EVERY player in
// the room that debt is nobody's entertainment, so it is paid off faster. This
// is only symmetric — and therefore only actually helps co-op — when main.js
// fills `actors` with all players; with just the local one, the two clients
// relax different cars, which is still better than neither relaxing any.
const CATCH_FAR = 1.9, LAG_FREE_R = 120;
const RETIRE_GRACE = 6;                // s a finished car may stand at its destination
const RETIRE_R = 90;                   // …or it just goes, if nobody is this close
const WORLD_SEED = 0x50a7d21;          // change this and every car in the city is a
                                       // different car. Never change it on a live build.

// ==== v10: the patrol slot ================================================
// POLICE_K is NOT a slot index and nothing may treat it as one. It is a hash
// lane and a key suffix: real slot indices run 0..cap-1 (cap ≤ round(SLOT_MAX
// × 4) = 32), so a negative one can never collide with a cell's ordinary
// traffic in `_pool`, in hash32(WORLD_SEED, ci, cj, k), or in the string key.
// The REAP does not look at it — see `p.police` in _sweepPool, and the v10
// header for the bug that rule exists to prevent.
const POLICE_K = -1;
const PATROL_SALT = 0x5e17;            // unused by any other draw in this file
// How often an ELIGIBLE cell owes a patrol in a given generation. Not a
// per-cell-per-second rate: like every other slot, the coin is tossed once per
// TRIP_T and the car then lives out its trip, so this is literally "what share
// of the arterial city blocks has a police car on it right now".
//
// Swept on the REAL Pardubice graph at the product's default density — four
// region tiles, 15 minutes driving an outward spiral at 50 km/h and 10 minutes
// standing in the centre. Columns are patrols carrying a mesh anywhere in the
// ~630 m ring while driving, distinct patrols the drive came within 150 m of,
// and the same census standing still:
//     0.16    0.67 live    0.20 /min    0.28 live standing
//     0.30    0.97 live    0.33 /min    1.08 live standing
//     0.45    1.34 live    0.53 /min    1.79 live standing   ← chosen
// The target is ONE patrol somewhere around you at essentially all times and
// not two: the ambient layer's job is to make the town feel policed, and the
// cars that are actually chasing you are js/police.js's to put on the road. If
// this number tries to do the chasing's work as well, a regional Czech town
// reads as a checkpoint. It is free to move — the fleet measured 94 cars at
// every value in the sweep, because a patrol is one car in a hundred.
// RAISED FROM 0.30 after the first person to play it asked "are there even any
// police cars? I cannot see any" — and they were right. 0.30 hits its stated
// target of a MEAN of one patrol in the ring, but a mean of one is a
// distribution, and a third of the time the answer is zero: measured twice at
// the station spawn, once with 3 patrols among 53 cars and once with 0 among
// 48. A police force you meet on a coin flip does not read as a police force,
// it reads as an absence with occasional exceptions. 0.45 is the top of the
// sweep above — 1.34 live, one passed every two minutes rather than every
// three — and it is still comfortably under the "two" the paragraph below
// warns about. The number that makes the police actually VISIBLE is not this
// one though; see spawnPatrol's callers for the ones parked outside stations.
const PATROL_P = 0.45;
// …and ELIGIBLE means the cell carries a real road to patrol. lenMajor counts
// DIRECTED major-class edge, so a two-way arterial contributes twice and 200
// is 100 m of street: enough that a cell merely clipped by the corner of a
// primary does not qualify, little enough that any cell an arterial actually
// crosses does. Cells with no ordinary traffic at all (density knob at zero,
// or open country) owe nothing — the settings slider must be able to empty
// the world, police included.
const PATROL_MAJOR = 200;
// A patrol cruises. It does not race and it does not dawdle, so its personal
// speed factor is a narrow band around the limit instead of VK_MIN..VK_MIN+VAR
// — a police car doing 36 km/h in a 50 reads as broken, and one doing 59
// reads as a chase that is not happening.
const PATROL_VK_MIN = 0.86, PATROL_VK_VAR = 0.20;
// WHAT A PATROL CAR IS, and why it is not a new vehicles.js kind. 'policie' is
// not in VEH.CAR_KINDS and adding one is somebody else's file; _attach's
// roster-drift guard would have silently turned every patrol into the roster's
// first entry anyway. A Czech police car IS a white Octavia in blue-and-yellow
// flank livery with a blue bar on the roof, so that is exactly what we build:
// the stock octavia mesh, the fleet white already in the paint vocabulary, and
// the livery and the bar added here — four meshes, one geometry set for the
// whole force, and no change to the roster.
const PATROL_KIND = 'octavia';
const PATROL_PAINT = 0xe9eae5;
// Octavia roof, from vehicles.js KIND.octavia.green (`sts = [z, yBase, yRoof]`,
// nose at −z): the plateau runs z −0.02..1.30 at y 1.44. The bar stands just
// behind the windscreen header. If the octavia hull is ever re-authored these
// two numbers float the bar; they are here rather than in vehicles.js because
// a light bar is traffic's idea, not the roster's.
const BAR_Y = 1.44, BAR_Z = 0.14, BAR_W = 1.04;
const BAR_H = 0.055;                   // the dark plinth the lamps ride on
// THE LAMPS ARE THE BAR NOW. They used to be two 0.34 × 0.105 nubs at ±0.30,
// which left 36 cm of the 1.04 m bar unlit in the middle and another 10 cm at
// each end — i.e. a blue thing on a white roof, but not a bar. The chase
// camera is what decides this: main.js parks it 6.6 m back and 2.4 m above a
// point 1.1 m over the car, so you look DOWN on your own roof at 17.3°, and at
// that angle a lamp presents (w·h·cos + w·d·sin) of lit face. The old pair
// gave 0.101 m²; 0.47 × 0.135 × 0.185 at ±0.265 gives 0.173 m², +70 %, and it
// leaves a 6 cm dark gap at the centre so the alternating flash still reads as
// two lamps and not as one strobing slab. Still inside the roof: the octavia
// greenhouse tops out at topW 0.68 → ±0.615, and the lamps stop at ±0.50. The
// bar now stands 18.6 cm off the roof where it stood 15.8.
const LAMP_W = 0.47, LAMP_H = 0.135, LAMP_D = 0.185, LAMP_X = 0.265;
const SIREN_T = 0.22;                  // s per lamp — ~4.5 flashes/s across the bar,
                                       // which is what a real majáček does. Driven off
                                       // SHARED time, so two clients blink together.

// ---- the flank livery: the cue that was missing --------------------------
// A wrapped stripe is not a decal quad floating beside the car — it has to sit
// ON a lofted, tapering flank or it peels off at the wings. So it is lofted
// along the octavia's OWN hull stations, transcribed here from vehicles.js
// KIND.octavia.hull.sts as [z, yLo, yHi, wFrac] (nose at −z, wFrac a fraction
// of wid/2). Transcribed and not imported because KIND is private to
// vehicles.js and exporting it is somebody else's file — the same trade BAR_Y
// already makes. If the octavia hull is re-authored, these six rows float the
// stripe exactly as those two numbers float the bar, and it only ever has to
// fit PATROL_KIND.
//
// The run stops at the bumper corners (−1.95 / 2.10) rather than the hull ends
// (−2.35 / 2.35): past those the loft is folding into the nose and tail caps,
// where a band would wrap round the corner and read as a painted bumper.
const LIVERY_STS = [
  [-1.95, 0.18, 0.74, 0.93],
  [-1.10, 0.16, 0.84, 0.99],
  [-0.65, 0.16, 0.88, 1.00],
  [0.60, 0.16, 0.90, 1.00],
  [1.55, 0.16, 0.93, 0.97],
  [2.10, 0.20, 0.90, 0.89],
];
const LIVERY_HALF = 1.81 / 2;          // KIND.octavia.wid / 2
// WHERE THE BAND SITS, in the hull ring's own parameter space rather than in
// metres. bodyHull() builds each station ring with the doorline at
// yLo + (yHi−yLo)·yB (0.80) and the arch line at ·yA (0.34), and BETWEEN those
// two the flank is exactly vertical — x is w·half at every height. Anything
// inside [0.34, 0.80] is therefore on a planar strip of panel by construction,
// at any station, whatever the belt does. Absolute metres would have been the
// obvious choice and it is the wrong one: the octavia's belt climbs 19 cm from
// the front wing to the rear, so a band at a fixed y is on the door at the
// B-pillar and off the panel over the arch. Riding the ring is also what a
// real wrap does — it follows the shoulder line.
const LIVERY_F0 = 0.36, LIVERY_F1 = 0.80;
// …and 1.6 cm proud of it, measured, not guessed. The flank already carries
// two body-colour beams that stand off it: the doorline crease (vehicles.js
// DETAIL.octavia, out to x = 0.917) and the door-handle stubs (out to 0.915),
// against a widest-station flank at 0.905. At +0.006 the stripe would z-fight
// nothing but the crease would draw a WHITE line straight through the middle
// of POLICIE; +0.016 puts the band at 0.921 and swallows both wherever the
// body is at full width, which is z −0.85..0.74 — the doors, which is where
// the lettering goes. Aft of that the body tucks in under a crease that does
// not, and the crease's last 0.9 m emerges through the blue, by 3 mm at the
// rear door and 36 mm where it ends at z 1.65 — a white swage line, which is
// what a swage line under a wrap looks like anyway. The
// alternative — a constant-x band wide enough to swallow the crease
// everywhere — stands 8 cm off the front wing and is a running board, not a
// stripe. The handles emerging is not a defect at all: a real patrol has white
// door handles sitting on the blue.
const LIVERY_OUT = 0.016;
// Policejní modrá, and the reflective yellow under it. Held as hex like every
// other colour in this file (PATROL_PAINT, the lamp pair) and turned into CSS
// where the canvas needs it — two spellings of one colour is how the fallback
// material and the painted band end up disagreeing.
const LIVERY_BLUE = 0x1750b5;
const LIVERY_YEL = 0xf2cf12;
const LIVERY_YEL_V = 0.17;             // bottom fraction of the band that is yellow
const LIVERY_TEXT_U = 0.47;            // POLICIE's centre along the run — the middle
                                       // of the crease-free window, not of the car
const LIVERY_TEXT_MAX = 0.34;          // …and the widest slice of the run it may take
const LIVERY_PX = 1024;                // canvas width; the height is DERIVED (liveryMat)

// Czech speed defaults where the data carries no maxspeed, by road class: 130
// is motorway law but 110 reads right at this fidelity, the rural 90 kicks in
// on primaries/secondaries once out of the built-up area, secondary/tertiary
// default to the between-towns 70, town streets to the blanket 50, obytná
// zóna to 20. THE bug this table replaces: a flat `|| 30` that made every
// untagged street — i.e. most of the region — crawl at 30 km/h.
const SPEED_DFLT = {
  motorway: 110, trunk: 110, tertiary: 70,
  residential: 50, unclassified: 50, living_street: 20, service: 30,
  motorway_link: 60, trunk_link: 60, primary_link: 60, secondary_link: 60, tertiary_link: 60,
};
const BUILT_UP_R = 1800;      // m from the origin ≈ the edge of Pardubice proper — the
                              // Polabí is flat and the town roughly round, so a radius works
function defaultV(t, x, z) {
  if (t === 'primary' || t === 'secondary')
    return dist(x, z) > BUILT_UP_R ? 90 : (t === 'primary' ? 50 : 70);
  return SPEED_DFLT[t] ?? 50;
}

// Every distance in this file. Math.hypot is NOT what this is: the spec leaves
// hypot's precision implementation-defined, and a value that feeds a shared
// schedule may not vary between browsers. Multiplication, addition and sqrt
// are all exactly specified, so this one is bit-identical everywhere.
const dist = (dx, dz) => Math.sqrt(dx * dx + dz * dz);

// 10 cm snapping welds shared OSM nodes without gluing near-misses — ways that
// meet at a junction repeat the exact same coordinate, so toFixed(1) is safe.
// This is ALSO what stitches tiles: build-region clips ways at tile borders,
// and both halves carry the border point, so they hash to the same node.
const keyOf = (x, z) => x.toFixed(1) + ',' + z.toFixed(1);

// ---- integer hashing: the only randomness a shared world may use ----------
// murmur3-style finaliser over int32 lanes. Everything here is Math.imul, xor
// and shift — integer operations, identical on every engine down to the bit.
// The old hash01() was `Math.sin(x*12.9898 + z*78.233) * 43758.5453`, and for
// coordinates a few kilometres out the ARGUMENT to sin runs to ~4e5, where one
// ULP of engine disagreement in the range reduction becomes ~2e-6 before the
// floor — enough to hand two browsers different junction phases. Integers
// cannot do that.
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
// 0..1 with 24 bits of mantissa — plenty for "which of eight paints", and the
// division by a power of two is exact.
const rnd01 = (h) => (h >>> 8) / 16777216;
// quantise a coordinate to 25 cm for hashing. Two clients that built the same
// geometry from the same tile agree exactly; the quantisation only has to
// survive the float noise of a running centroid.
const q4 = (v) => Math.round(v * 4) | 0;

// stable total order over directed edges, so "the third edge in this cell" and
// "the second way out of this junction" mean the same thing on every client no
// matter which order the tiles streamed in. eid first (uniform, cheap), then
// geometry as the tie-break — a hash collision must not become a coin flip.
function cmpEdge(a, b) {
  return ((a.eid >>> 0) - (b.eid >>> 0)) || (a.len - b.len) || (a.mx - b.mx) || (a.mz - b.mz);
}

// ---- spatial hash: what made Prague loadable at all -----------------------
// Four passes here used to answer "what is near this point?" by scanning every
// junction or every edge. That is honest bookkeeping for Pardubice — 2 000 roads
// and 40 controllers — and quadratic death for a world that reaches Prague: one
// central tile alone carries 18 000 roads, so binding its ~40 000 edges against
// a few thousand controllers is hundreds of millions of distance tests per tile,
// and the tab simply stops. Every one of those queries has a radius of at most
// SYNTH_CLEAR (45 m), so a 64 m bucket grid answers all of them from the 3×3
// neighbourhood of the query point — with a cell that big, nothing within 45 m
// can be further than one cell away.
const GRID = 64;
class Buckets {
  constructor() { this.m = new Map(); }
  static key(x, z) { return Math.floor(x / GRID) + ',' + Math.floor(z / GRID); }
  add(x, z, v) {
    const k = Buckets.key(x, z);
    let a = this.m.get(k);
    if (!a) this.m.set(k, a = []);
    a.push(v);
    return k;
  }
  remove(k, v) {
    const a = this.m.get(k);
    if (!a) return;
    const i = a.indexOf(v);
    if (i >= 0) a.splice(i, 1);
  }
  // A polyline occupies every cell it passes through, not just its endpoints'
  // — a pole can stand beside the middle of a 400 m edge. Walking each segment
  // in half-cell steps cannot skip a cell, and the Set keeps one entry per
  // cell per line.
  addLine(pts, v) {
    const seen = new Set();
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = dist(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / (GRID / 2)));
      for (let s = 0; s <= n; s++) {
        const t = s / n, k = Buckets.key(ax + (bx - ax) * t, az + (bz - az) * t);
        if (seen.has(k)) continue;
        seen.add(k);
        let a = this.m.get(k);
        if (!a) this.m.set(k, a = []);
        a.push(v);
      }
    }
    return seen;
  }
  near(x, z, fn) {
    const cx = Math.floor(x / GRID), cz = Math.floor(z / GRID);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = this.m.get((cx + i) + ',' + (cz + j));
      if (a) for (let k = 0; k < a.length; k++) fn(a[k]);
    }
  }
}
// normalize any angle (or angle difference) into (-π, π] — branchless and
// immune to accumulated drift, worth the two trig calls at 120 cars
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
// v = sqrt(a_lat · R): treat a polyline corner of angle `ang` as an arc taken
// over ~7 m, so R ≈ 7/ang and with a_lat 4.5 → v = sqrt(31.5/ang). A 90° city
// corner comes out ~4.5 m/s, a lane kink barely registers.
const cornerSpeed = (ang) => Math.max(2.2, Math.sqrt(31.5 / Math.max(ang, 0.06)));
// …and the same, but "no corner here" means "no limit", which is what the
// schedule needs: cornerSpeed(0) is 22.9 m/s and would quietly cap motorways.
const cornerLimit = (ang) => (ang > 0.06 ? cornerSpeed(ang) : Infinity);

// shared scratch — update paths never allocate
const _pose = { x: 0, z: 0, dx: 0, dz: 0, seg: 0 };
const _cand = [], _straight = [];
const _snap = { x: 0, z: 0, t: 0 };
// scratch for camera.getWorldDirection(); a Vector3 rather than a bare object
// because three.js writes into it with .set() and returns it
const _vdir = new THREE.Vector3();
const _caps = { v0: 0, v1: 0 };

// How long a real car needs to cover `L` metres when it may enter at v0, must
// leave at v1, and would cruise at vc in between: accelerate at ACCEL, brake at
// BRAKE, trapezoid if it gets to vc, triangle if it does not. Only + − × ÷ and
// sqrt, so it is bit-identical on every engine — the schedule depends on it.
//
// This replaces v8's model, which was "cross the whole piece at the slower of
// the two corner speeds, then add a ramp charge on top". That double-counted
// the corner: the piece was already being crawled, and then it was billed for
// slowing down to the crawl as well. Over the real Pardubice graph it cost the
// city 43 % of its speed — measured 20.0 km/h of schedule against 35.1 km/h of
// driver desire, with the rendered cars sitting 2.5 m behind the schedule, i.e.
// the reactive layer was never the problem, the schedule was.
function pieceTime(L, v0, v1, vc) {
  const a = ACCEL, b = BRAKE;
  // peak speed reachable inside L when accelerating from v0 and braking to v1
  const vp2 = (2 * a * b * L + b * v0 * v0 + a * v1 * v1) / (a + b);
  const vp = Math.sqrt(vp2 > 0 ? vp2 : 0);
  // Too short to honour both ends: a real driver would have started braking
  // before this piece (the driving layer's lookahead does exactly that). The
  // mean of the endpoints is the honest approximation and keeps the schedule
  // from claiming a stop it cannot make.
  if (vp <= v0 || vp <= v1) return 2 * L / (v0 + v1);
  if (vp >= vc) {
    const d1 = (vc * vc - v0 * v0) / (2 * a);
    const d3 = (vc * vc - v1 * v1) / (2 * b);
    const cruise = L - d1 - d3;
    return (vc - v0) / a + (vc - v1) / b + (cruise > 0 ? cruise / vc : 0);
  }
  return (vp - v0) / a + (vp - v1) / b;
}
const _pts = [];              // fabricated signal points, reused per synth junction

// point + direction at arc-length s along an edge. `seg` is the caller's
// cached segment index — s only ever grows within an edge, so the while loop
// amortizes to O(1) per frame.
function poseAt(edge, s, seg) {
  const { pts, cum } = edge;
  const last = pts.length - 2;
  if (seg > last) seg = last;
  if (seg < 0) seg = 0;
  while (seg > 0 && s < cum[seg]) seg--;
  while (seg < last && s > cum[seg + 1]) seg++;
  const a = pts[seg], b = pts[seg + 1];
  const L = (cum[seg + 1] - cum[seg]) || 1e-6;
  const t = Math.max(0, Math.min(1, (s - cum[seg]) / L));
  _pose.x = a[0] + (b[0] - a[0]) * t;
  _pose.z = a[1] + (b[1] - a[1]) * t;
  _pose.dx = (b[0] - a[0]) / L;
  _pose.dz = (b[1] - a[1]) / L;
  _pose.seg = seg;
  return _pose;
}

// ---- shared traffic-light assets (built lazily — headless tests never touch THREE) ----
// One geometry + material set for EVERY pole in the region; a light "changes"
// by swapping the material reference on its three lamp meshes, nothing else.
let _S = null;
function sigAssets() {
  if (_S) return _S;
  const pole = new THREE.CylinderGeometry(0.055, 0.09, 3.6, 6);
  pole.translate(0, 1.8, 0);                       // base at ground, per the group origin
  const head = new THREE.BoxGeometry(0.26, 0.66, 0.18);
  head.translate(0, 3.08, 0);                      // 3-lamp housing near the pole top
  const lamp = new THREE.BoxGeometry(0.13, 0.13, 0.06);
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c });
  // lit lamps are overbright like the car lights (×2.2) so bloom bites at night
  const lit = (c, e) => new THREE.MeshLambertMaterial({ color: c, emissive: e, emissiveIntensity: 2.2 });
  _S = {
    pole, head, lamp,
    poleMat: mat(0x2e3134), headMat: mat(0x1f2224),
    redOff: mat(0x371313), ambOff: mat(0x38290f), grnOff: mat(0x11301a),
    redOn: lit(0xff3524, 0xff2418), ambOn: lit(0xffb02e, 0xffa018), grnOn: lit(0x3dff6a, 0x22ff55),
  };
  return _S;
}

// How long the stripe is, following the flank rather than the axis. This is
// the denominator of every u below and of the canvas aspect, and measuring it
// along z alone is only 0.17 % short overall — but 0.9 % short on the rear
// wing segment alone, which is where the taper is 7.5° and where any error
// shows as a stripe whose lettering creeps off-centre. It costs six square
// roots at boot to be right. Pure arithmetic on LIVERY_STS, no allocation, and
// called exactly twice (once by the loft, once by the canvas).
function liveryRun() {
  let run = 0;
  for (let i = 1; i < LIVERY_STS.length; i++) {
    const a = LIVERY_STS[i - 1], b = LIVERY_STS[i];
    const dz = b[0] - a[0], dx = (b[3] - a[3]) * LIVERY_HALF;
    run += Math.sqrt(dx * dx + dz * dz);
  }
  return run;
}

// The flank strip: BOTH sides in one indexed BufferGeometry, so a patrol pays
// one draw call for its whole livery and not two.
//
// The loft is exact where it matters. bodyHull() splits each flank quad into
// two triangles, so a point at ring fraction f between two stations is NOT in
// general on the triangulated surface — but only its Y is affected: x depends
// on the station index alone, so it interpolates identically either way. The
// band therefore hugs the panel in the one axis a stripe can peel off in, and
// the few millimetres of Y wobble just move the stripe a hair up or down.
//
// Normals are the flat flank normal (±1, 0, 0) rather than the true tapered
// one. The taper never exceeds 7.5° (the rear wing, the worst station pair),
// and matching the panel's own near-vertical normal is the POINT: a decal that
// shades differently from the paint under it reads as a separate object stuck
// to the car, which is exactly the thing a livery must not do.
function liveryGeo() {
  const n = LIVERY_STS.length, run = liveryRun();
  const pos = [], uvs = [], nor = [], idx = [];
  for (let s = -1; s <= 1; s += 2) {
    const base = pos.length / 3;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const st = LIVERY_STS[i];
      if (i) {
        const p = LIVERY_STS[i - 1];
        const dz = st[0] - p[0], dx = (st[3] - p[3]) * LIVERY_HALF;
        along += Math.sqrt(dx * dx + dz * dz);
      }
      const x = s * (st[3] * LIVERY_HALF + LIVERY_OUT);
      const yLo = st[1], span = st[2] - st[1];
      pos.push(x, yLo + span * LIVERY_F0, st[0], x, yLo + span * LIVERY_F1, st[0]);
      nor.push(s, 0, 0, s, 0, 0);
      // MIND THE u DIRECTION. Seen from outside, the left flank's screen-right
      // is +z and the right flank's is −z, so a u that ran with z on both sides
      // would hand one of them a mirrored POLICIE. js/meshes.js:markWall walks
      // into the identical trap on shop fascias and says so at length; the
      // window atlas gets away with it because windows are symmetric and text
      // is not.
      const u = s < 0 ? along / run : 1 - along / run;
      uvs.push(u, 0, u, 1);
    }
    for (let i = 0; i < n - 1; i++) {
      // lo/hi at station i, then at i+1. Winding is per side: the two flanks
      // face opposite ways, so one order would leave half the livery
      // backface-culled — invisible from the street it is meant to be read from.
      const a = base + i * 2, b = a + 1, c = a + 2, d = a + 3;
      if (s < 0) idx.push(a, c, d, a, d, b);
      else idx.push(a, b, d, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  return g;
}

// ONE texture for the whole force, and the reason it is a texture at all.
// js/nametags.js rasterises text too, and it is the wrong tool here: a tag is
// a Sprite with its OWN material because every player's name differs, so a
// nametag-shaped livery is a canvas, a texture and a material per patrol —
// nine of them parked and driving before a pursuit even starts, and disposed
// and rebuilt every time a schedule rolls over. js/meshes.js:brandMarkMat is
// the right prior art instead: every Kaufland in the region shares one
// 1024-wide canvas out of a module-scope Map, because every Kaufland says the
// same word. So does every police car.
//
// The canvas HEIGHT is derived from the band's own proportions rather than
// picked, so a glyph drawn round on the canvas arrives round on the car. Hard
// aspect ratios are how a wordmark ends up stretched the day somebody retunes
// LIVERY_F0/F1 and nothing else looks wrong enough to notice.
//
// No <canvas> — a headless import, or a null 2d context under memory pressure
// — falls back to flat blue rather than uploading the void (brandMarkMat's own
// rule). The band is the cue that carries at 25 m; the lettering is the one
// that carries at 10, and losing it is survivable in an environment that by
// definition has no screen.
function liveryMat() {
  const flat = () => new THREE.MeshLambertMaterial({ color: LIVERY_BLUE });
  if (typeof document === 'undefined') return flat();
  const cv = document.createElement('canvas');
  const w = LIVERY_PX;
  // the door station — the widest, and where POLICIE lands
  const band = (LIVERY_STS[3][2] - LIVERY_STS[3][1]) * (LIVERY_F1 - LIVERY_F0);
  const h = Math.max(16, Math.round(w * band / liveryRun()));
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  if (!g) return flat();
  const css = (hex) => '#' + hex.toString(16).padStart(6, '0');
  // v = 0 is the BOTTOM of the band and CanvasTexture flips Y by default, so
  // canvas row 0 is the top of the stripe: blue first, yellow last.
  const yel = Math.round(h * (1 - LIVERY_YEL_V));
  g.fillStyle = css(LIVERY_BLUE);
  g.fillRect(0, 0, w, yel);
  // Reflexní žlutá along the bottom edge. Thin on purpose — it is the accent
  // that tells you the blue is a livery and not a paint job, and a fat one
  // turns the car into a breakdown truck.
  g.fillStyle = css(LIVERY_YEL);
  g.fillRect(0, yel, w, h - yel);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = Math.round(h * 0.80);
  g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  // A font fallback that measures wider than Arial would push the word out of
  // the crease-free window; shrink to fit rather than let it wander, exactly
  // as brandMarkMat does for "Penny Market".
  const max = LIVERY_TEXT_MAX * w;
  const tw = g.measureText('POLICIE').width;
  if (tw > max) {
    size = Math.max(8, Math.floor(size * max / tw));
    g.font = `bold ${size}px Arial, Helvetica, sans-serif`;
  }
  g.fillText('POLICIE', LIVERY_TEXT_U * w, yel / 2);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;                    // a flank is read at grazing angles
  return new THREE.MeshLambertMaterial({ map: tex });
}

// ---- the light bar and the livery, on the same lazy terms as the poles ----
// One geometry + material set for every patrol car in the country, built the
// first time one actually takes a mesh — headless tests never touch THREE, and
// a client that never meets a police car never pays for one, canvas included.
// A bar "flashes" by swapping the material reference on two boxes, exactly as
// a traffic light changes: no per-frame allocation, and the swap only happens
// on the ~0.22 s state flip rather than every frame.
let _C = null;
function copAssets() {
  if (_C) return _C;
  const bar = new THREE.BoxGeometry(BAR_W, BAR_H, 0.19);
  bar.translate(0, BAR_Y + BAR_H / 2 - 0.004, BAR_Z);   // sitting ON the roof, slightly sunk
  const lamp = new THREE.BoxGeometry(LAMP_W, LAMP_H, LAMP_D);
  _C = {
    bar, lamp, livery: liveryGeo(),
    barMat: new THREE.MeshLambertMaterial({ color: 0x24272c }),
    // dark navy when idle so the bar reads as a bar and not as a roof rack…
    off: new THREE.MeshLambertMaterial({ color: 0x18294d }),
    // …and overbright like the car lights and the green lamp (×2.2) so the
    // bloom pass bites at night. Blue only: Czech law, and it is also what
    // makes a patrol legible at 200 m, where the livery has stopped resolving.
    on: new THREE.MeshLambertMaterial({ color: 0x4c78ff, emissive: 0x2a4cff, emissiveIntensity: 2.2 }),
    liveryMat: liveryMat(),
  };
  return _C;
}

// How long a driver arriving at time `t` on phase bucket `b` has to sit. Pure
// arithmetic on shared time, so both clients compute the same wait to the last
// bit — this, not the car code, is what keeps two fleets in step across a
// junction. Amber counts as red for the schedule: an arriving nominal stops.
function redWait(jn, bucket, t) {
  let u = (t + jn.off) % SIG_CYCLE;
  if (bucket) u += SIG_CYCLE / 2;
  u %= SIG_CYCLE;
  if (u < 0) u += SIG_CYCLE;
  return u < SIG_GREEN ? 0 : SIG_CYCLE - u;
}

// The two numbers the "nothing pops" tests have to agree with us about. They
// were transcribed into tests/traffic-view.test.mjs as literals and went stale
// the moment either moved, which is a silent way to turn a real assertion into
// a tautology — so they travel with the file instead.
export const VIEW_TUNING = { NOTICE_R, GHOST_MAX, LOOK_BACK };

export class Traffic {
  constructor(city, vehicles, world = null) {
    this.city = city;
    this.vehicles = vehicles;
    // Only for the ground: the AI writes car poses directly and has to put them
    // on the terrain itself. Optional so the traffic tests can keep handing in
    // a bare { roads: [...] } city with no world at all.
    this.world = world;
    this.cars = new Set();          // public — minimap reads this. Only cars with a
                                    // MESH live here; schedules without one are in _pool.
    // v10 — public, read-only, and a strict SUBSET of this.cars: the ambient
    // patrol cars traffic is currently driving. js/police.js reads it to find
    // a unit worth pressing into a pursuit (see nearestPatrol) and the minimap
    // reads it to draw them; both want the small set, not a filter over the
    // whole fleet every frame. A car leaves it the instant it loses its mesh
    // or somebody calls steal() on it. Cars from spawnPatrol() are NOT in here
    // — they have no schedule and traffic does not drive them.
    this.patrols = new Set();
    this.edges = [];                // every DIRECTED edge (reverse twins too)
    // Optional, and the single biggest lever on how well co-op traffic agrees:
    // main.js may fill this with EVERY player in the room — the local one plus
    // the ghost cars from netvehicles — as {x, z, half}. Traffic brakes for all
    // of them, which makes the reactive layer symmetric (client A and client B
    // both see the same three obstacles) instead of each client only braking
    // for itself. Ghost cars must NOT be pushed into this.cars; this list is
    // read-only to us and never touched by the follow bookkeeping.
    this.actors = null;
    this.blockers = null;   // parked hulls from main.js — see _obst below
    // How thick the police are on the ground, 0..1, from the settings panel —
    // the same shape as maxCars above it. It is a SETTING and not a constant
    // because the honest answer to "how many patrols should a regional Czech
    // town have" turned out to be a preference and not a fact: the swept
    // default reads as a police force to nobody, and the value that reads as
    // one to a player reads as a checkpoint to the sweep. Two rounds of "I
    // cannot see any police" is enough evidence that this belongs to the
    // person playing it. null = use PATROL_P.
    this.patrolP = null;
    this.urbanAt = null;    // (x,z) -> 0.15..1 settlement factor, wired by main.js
    // (x, z) — a car in this city just leaned on its horn. Single-slot sink,
    // the same shape peds.onPedHit uses, and fired from BOTH honk sites below.
    // js/chatter.js subscribes so a honk gets shouted back at; anything else
    // that wants to know a horn went off can chain it the usual way. It is not
    // an audio hook — audio.js already got its horn() call one line earlier.
    this.onHonk = null;
    this.clock = null;              // test seam: () => shared seconds. null = worldT()
    this._nodes = new Map();        // keyOf(x,z) → { x, z, out: [] }
    this._usage = new Map();        // keyOf → {n, last}: PERSISTENT so later tiles
                                    // can still detect junctions against earlier ways
    this._junctions = [];           // traffic-light controllers (grow with tiles)
    this._jgrid = new Buckets();    // …indexed by position (see Buckets above)
    this._egrid = new Buckets();    // every edge, in every cell its polyline crosses
    this._cells = new Map();        // CELL key → { ci, cj, edges, len, sorted } — the
                                    // shared population lives on this, not on _near
    this._pool = new Map();         // slot key → schedule (with or without a mesh)
    this._ghosts = new Set();       // v9: cars the schedule has finished with but
                                    // the local player can still see. NOT part of
                                    // the shared world — see the v9 header.
    this._view = null;              // v9: {x,z,dx,dz,cos,hideR} or null = no camera
    this._scanT = 0;
    this._cullT = 0;
    this._simT = 0;                 // last simulated instant of SHARED time
    this._wt = 0;
    this._px = 0; this._pz = 0;
    this._densK = 1;
    this._obst = [];                // scratch: things a car must not drive into
    this._sirens = new Set();       // cars whose light bar is currently flashing.
                                    // Kept apart from `patrols` on purpose: a unit
                                    // police.js has stolen (or spawned itself) is no
                                    // longer a patrol of ours but its bar still has
                                    // to blink. Self-cleaning — see _tickSirens.
    this._hornPool = HONK_POOL;     // global honk budget, refilled at HONK_RATE/s
    // ingest whatever is already loaded (legacy whole-city file, or region tiles
    // that landed before we were constructed), then subscribe for the rest —
    // optional chaining because bare test fixtures pass {roads:[…]} without it
    this.addTile({ roads: city.roads ?? [], signals: city.signals ?? [] });
    city.onTileLoaded?.((t) => this.addTile(t));
    // a pole placed before its height map landed guessed its ground; the road
    // conform then moves that ground again. Re-seat them whenever either lands.
    world?.terrain?.onTileLoaded?.(() => this._regroundSignals());
  }

  now() { return this.clock ? this.clock() : worldT(); }

  // ---- v9: where the local player is LOOKING -------------------------------
  //
  //   setViewer(v)
  //
  // Call it once per frame, BEFORE update() (or hand the same object to
  // update()'s 4th argument, which just forwards here). Three accepted shapes,
  // all optional-fielded:
  //
  //   setViewer(null)                       forget the camera. Everything falls
  //                                         back to v8 behaviour — see below.
  //
  //   setViewer({ camera, fogFar })         camera: a THREE.PerspectiveCamera
  //                                         (anything with .position, .fov in
  //                                         DEGREES, .aspect and .getWorldDirection).
  //
  //   setViewer({ x, z, dirX, dirZ,         explicit, headless-friendly. dirX/dirZ
  //               fovRad, aspect, fogFar })  need not be normalised. fovRad is the
  //                                         VERTICAL field of view in radians and
  //                                         is combined with `aspect` into the
  //                                         horizontal one, exactly as three.js
  //                                         does it. Defaults: fovRad 1.05 (60°),
  //                                         aspect 16/9.
  //
  // WHAT TO PASS FOR THE DEPTH: `fogFar` — literally `scene.fog.far` — and we
  // work out the distance at which a fade-in stops being noticeable (see
  // HIDE_FOG_K). Callers that would rather say it outright may pass `hideR`
  // instead and it wins. Neither given, we assume the ground preset. The
  // result is clamped into [HIDE_R_MIN, HIDE_R_MAX]; the upper clamp is the
  // deliberate surrender documented in the v9 header.
  //
  // WHAT HAPPENS WITHOUT IT: `_visible()` answers "no" to everything, which is
  // precisely v8 — cars attach anywhere inside spawnR and are destroyed the
  // instant the schedule is done with them. Nothing breaks, nothing improves.
  // That is why every existing headless test still measures what it used to.
  setViewer(v) {
    if (!v) { this._view = null; return; }
    let x = v.x, z = v.z, dx = v.dirX, dz = v.dirZ;
    let fov = v.fovRad, aspect = v.aspect;
    const cam = v.camera;
    if (cam) {
      x = cam.position?.x ?? x; z = cam.position?.z ?? z;
      if (typeof cam.getWorldDirection === 'function') {
        cam.getWorldDirection(_vdir);
        dx = _vdir.x; dz = _vdir.z;
      }
      if (Number.isFinite(cam.fov)) fov = cam.fov * Math.PI / 180;
      if (Number.isFinite(cam.aspect)) aspect = cam.aspect;
    }
    if (!Number.isFinite(x) || !Number.isFinite(z)) { this._view = null; return; }
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (!(dl > 1e-6)) { this._view = null; return; }
    if (!Number.isFinite(fov) || fov <= 0) fov = 1.05;
    if (!Number.isFinite(aspect) || aspect <= 0) aspect = 16 / 9;
    // three.js `fov` is vertical; the horizontal half-angle a car can hide
    // outside of is atan(tan(vfov/2) · aspect).
    const half = Math.atan(Math.tan(Math.min(fov, 3.0) / 2) * aspect) + VIEW_MARGIN;
    const hide = Math.max(HIDE_R_MIN, Math.min(HIDE_R_MAX,
      Number.isFinite(v.hideR) ? v.hideR
        : Number.isFinite(v.fogFar) ? v.fogFar * HIDE_FOG_K
          : HIDE_R_DFLT));
    const cos = Math.max(VIEW_COS_MIN, Math.cos(half));
    this._view = { x, z, dx: dx / dl, dz: dz / dl,
      cos, sin: Math.sqrt(1 - cos * cos), hideR: hide };
  }

  // Could the local player plausibly SEE something at (x, z) right now? The
  // only question this file ever asks about the camera, and the only place
  // where "the player" leaks into a decision that used to be shared. It never
  // feeds the schedule — only whether a mesh may come or go this instant.
  _visible(x, z) {
    const v = this._view;
    if (!v) return false;                       // no camera → v8 semantics
    const dx = x - v.x, dz = z - v.z;
    const d2 = dx * dx + dz * dz;
    if (d2 >= v.hideR * v.hideR) return false;  // out past the fog wall
    return this._inCone(x, z);
  }

  /**
   * The same question, asked the way RETIREMENT has to ask it: not "is it in
   * the cone right now" but "could the player still be holding it in mind".
   *
   * The instantaneous test is exactly right for deciding where to ATTACH a
   * mesh, and exactly wrong for deciding when to destroy one, because looking
   * away is not the same as forgetting. Turn your head at a junction and every
   * car you were just looking at leaves the cone; with the raw test they are
   * all destroyed that frame, and turning back gives you an empty street. That
   * is the "vidím auto, otočím se a otočím se zpět a ono už tam není" report,
   * and it is not a pop in the usual sense — nothing vanishes ON screen, the
   * world merely rearranges itself behind your back.
   *
   * So a car stays protected for LOOK_BACK seconds after it was last seen. The
   * cost is a handful of extra live cars for a few seconds; against GHOST_MAX
   * (120 s) it is noise.
   */
  _heldVisible(p) {
    if (this._visible(p.sx, p.sz)) { p._seenT = this._t ?? 0; return true; }
    return (this._t ?? 0) - (p._seenT ?? -1e9) < LOOK_BACK;
  }

  // The same question, asked the way ATTACHING has to ask it. Two reasons the
  // gate must be more cautious than the instantaneous test:
  //   · we test the SCHEDULE's pose, but the car is placed a lane-offset off
  //     the centreline (up to TRAFFIC.laneOffsetMax) — at the boundary that
  //     alone is enough to land a car a metre inside the line we just cleared;
  //   · a decision taken now stands until the next sweep 250 ms later, during
  //     which a 90 km/h car covers 6 m of the margin by itself.
  // ATTACH_SKIN buys both. It only ever moves the band outward, so it cannot
  // create a pop, only cost a couple of metres of ring.
  _visibleForAttach(x, z) {
    const v = this._view;
    if (!v) return false;
    const dx = x - v.x, dz = z - v.z;
    const lim = v.hideR + ATTACH_SKIN;
    const d2 = dx * dx + dz * dz;
    if (d2 >= lim * lim) return false;
    if (d2 <= (PERIPHERAL_R + ATTACH_SKIN) * (PERIPHERAL_R + ATTACH_SKIN)) return true;
    const d = Math.sqrt(d2);
    // ATTACH_SKIN metres of SIDEWAYS slack, converted into an angle at this
    // distance and added to the cone: cos(A+B) = cosA·cosB − sinA·sinB with
    // sinB = skin/d. Near the camera that widens the cone a lot and far away
    // hardly at all, which is exactly how a fixed metric error behaves.
    const sinB = Math.min(0.6, ATTACH_SKIN / d);
    const cosB = Math.sqrt(1 - sinB * sinB);
    const thr = v.cos * cosB - v.sin * sinB;
    return (dx * v.dx + dz * v.dz) / d >= thr;
  }

  // Would a mesh appearing here be READ, as opposed to merely being inside the
  // technically-visible cone? This — not _visibleForAttach — is what the attach
  // gate refuses, and the difference between the two is NOTICE_R (see the
  // constant for the measurements and for why v9.0's "refuse the whole cone"
  // could not be honoured). Distance is taken from the CAMERA, because the
  // camera is the thing that would do the reading; everything else in the
  // sweep measures from the player, who sits a few metres in front of it.
  _readableForAttach(x, z) {
    const v = this._view;
    if (!v) return false;
    if (!this._visibleForAttach(x, z)) return false;   // behind you, or past the fog
    const dx = x - v.x, dz = z - v.z;
    // the same skin as the cone gets, and never past the fog wall itself — with
    // hideR at its 240 m floor the two coincide and this degenerates to v9.0
    const lim = Math.min(NOTICE_R, v.hideR) + ATTACH_SKIN;
    return dx * dx + dz * dz < lim * lim;
  }

  // The cone alone, with no distance term. Needed separately because the two
  // halves of the attach rule ask different questions: "is it in front of me"
  // decides WHICH radius applies, "can he see it" decides whether attaching is
  // allowed at all.
  _inCone(x, z) {
    const v = this._view;
    if (!v) return false;
    const dx = x - v.x, dz = z - v.z;
    const d2 = dx * dx + dz * dz;
    if (d2 <= PERIPHERAL_R * PERIPHERAL_R) return true;
    const d = Math.sqrt(d2);
    return (dx * v.dx + dz * v.dz) / d >= v.cos;
  }

  // Furthest a schedule may be handed a mesh. Out of the cone that is the
  // plain v8 ring; inside it, the band beyond the fog wall (see v9 header).
  _attachR() {
    return this._view ? Math.max(TRAFFIC.spawnR, this._view.hideR + RING_W) : TRAFFIC.spawnR;
  }
  // A car can never be more than ROUTE_MAX from its birth cell, so the cells
  // that could deliver one into attach range are exactly these. The ceiling is
  // belt and braces: _attachR() is clamped already, and the sweep walks the
  // SQUARE of this radius, so a viewer with a nonsense fog distance must not be
  // able to turn one frame into a region-wide scan.
  _phantomR() {
    return Math.min(PHANTOM_R_MAX, this._attachR() + ROUTE_MAX + CELL_HALF_DIAG);
  }

  // ---- incremental ingestion: roads → graph edges, signals → junctions ----

  // One region tile (or the initial city payload). Node keys are shared-map
  // rounded coordinates, so edges from THIS tile weld onto nodes older tiles
  // created at the border — no explicit stitching pass needed. New edges then
  // look for a governing junction and new junctions claim pre-existing edges.
  addTile({ roads, signals }) {
    const e0 = this.edges.length;
    this._growGraph(roads ?? []);
    let grown = this._growSignals(signals ?? []);
    // real OSM clusters first, THEN synthesis — an actual signal within
    // SYNTH_CLEAR of a crossing suppresses the fabricated one, never vice versa
    const synth = this._synthSignals();
    if (synth) { if (grown) for (const j of synth) grown.add(j); else grown = synth; }
    // bind: every NEW edge asks the junction grid what stands near its END
    // node; every new/updated junction asks the edge grid which edges pass
    // nearby. _tryBind keeps the nearest junction and gates on SIG_EDGE_R, so
    // revisiting an already-bound pair is harmless — which is why the second
    // sweep does not bother excluding the edges the first one just did.
    for (let i = e0; i < this.edges.length; i++) {
      const e = this.edges[i];
      this._jgrid.near(e.b.x, e.b.z, (jn) => this._tryBind(e, jn));
    }
    if (grown)
      for (const jn of grown)
        this._egrid.near(jn.x, jn.z, (e) => this._tryBind(e, jn));
  }

  _growGraph(roads) {
    // pass 1 — count DISTINCT drivable ways touching each snapped point, into
    // the PERSISTENT usage map (a T-junction whose main road came in an earlier
    // tile still reads n≥2 when the side street arrives). A point can repeat
    // inside one way (loops); comparing the last way ref keeps that from
    // inflating the count. _tg stamps guard against double ingestion if the
    // constructor's snapshot and a tile callback ever overlap.
    const drivable = [];
    for (const r of roads) {
      if (r.d !== 1 || !r.p || r.p.length < 2 || r._tg) continue;
      r._tg = 1;
      drivable.push(r);
      for (const [x, z] of r.p) {
        const k = keyOf(x, z);
        const u = this._usage.get(k);
        if (!u) this._usage.set(k, { n: 1, last: r });
        else if (u.last !== r) { u.n++; u.last = r; }
      }
    }
    // pass 2 — split each way at nodes: both ends, plus interior points that
    // another drivable way also uses (that's where junctions live in OSM).
    // startOff tracks meters from the WAY start to the edge start, so bridge
    // ramps can later ask "how far along the whole way am I?"
    // Known incremental blind spot, accepted: if a LATER tile's way crosses an
    // ALREADY-BUILT edge mid-polyline, that old edge is not retro-split (cars
    // on it drive past the new junction; cars arriving on the new way can only
    // continue along it). Cross-tile connections are overwhelmingly clipped
    // way ENDPOINTS — which are always nodes — so this stays a non-issue in
    // practice and spares us remapping the `s` of every car on a split edge.
    for (const r of drivable) {
      const p = r.p;
      let start = 0, startOff = 0, d = 0;
      for (let i = 1; i < p.length; i++) {
        d += dist(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
        if (i === p.length - 1 || this._usage.get(keyOf(p[i][0], p[i][1])).n >= 2) {
          this._addEdge(r, p.slice(start, i + 1), startOff);
          start = i; startOff = d;
        }
      }
      if (r._len == null) r._len = d; // loadCity sets it; tests may not
    }
  }

  _node(x, z) {
    const k = keyOf(x, z);
    let n = this._nodes.get(k);
    // deg counts incident ARMS (edge segments, direction-agnostic) and inn the
    // incoming directed edges — both feed the synthetic-signal junction scan.
    // outS is the canonically ORDERED copy of out (see cmpEdge): route walks
    // must not depend on which tile arrived first.
    if (!n) this._nodes.set(k, n = { x, z, out: [], outS: null, inn: [], deg: 0 });
    return n;
  }

  _addEdge(road, pts, off) {
    const n = pts.length;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++)
      cum[i] = cum[i - 1] + dist(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const len = cum[n - 1];
    if (len < 0.5) return;                       // degenerate/duplicate points
    // km/h → m/s, with the Czech class defaults standing in for missing data —
    // rural-vs-town judged at the EDGE's midpoint, not the whole way's.
    // CAVEAT about the data: build-city.mjs never reads the real maxspeed tag —
    // it stamps a CLASS-TABLE speed on every way, and its residential=30 is
    // what made the whole town crawl. Czech law is 50 in a built-up area unless
    // signed, so the two table values that misstate it are corrected here;
    // living_street (obytná zóna, genuinely 20) and service stay.
    const mid = pts[n >> 1];
    let kmh = road.v || defaultV(road.t, mid[0], mid[1]);
    if (road.t === 'residential' && kmh === 30) kmh = 50;
    else if (road.t === 'unclassified' && kmh === 40) kmh = 50;
    const speed = kmh / 3.6;
    const fwd = this._makeEdge(road, pts, cum, len, speed, off, 1);
    // junction bookkeeping for the synthetic-signal scan: this edge is one arm
    // at each end node; arms of main-class roads also register which bearing
    // BUCKET they leave the node in (N-S-ish vs E-W-ish — the same split the
    // 2-phase controller uses), so the scan can later ask "do mains genuinely
    // CROSS here, or does one road merely continue through a way split?"
    fwd.a.deg++; fwd.b.deg++;
    if (SIG_CLASS.test(road.t)) {
      (Math.abs(fwd.fdz) >= Math.abs(fwd.fdx) ? (fwd.a.ns ??= new Set()) : (fwd.a.ew ??= new Set())).add(road);
      (Math.abs(fwd.ldz) >= Math.abs(fwd.ldx) ? (fwd.b.ns ??= new Set()) : (fwd.b.ew ??= new Set())).add(road);
      // leaving directions, per arm — the compass buckets above are blind to
      // two mains crossing at 45° (both land in one bucket), so the founding
      // gate measures real angles from these instead
      (fwd.a.dirs ??= []).push([fwd.fdx, fwd.fdz, road]);
      (fwd.b.dirs ??= []).push([-fwd.ldx, -fwd.ldz, road]);
    }
    if (!road.ow) {
      // two-way street: a mirrored twin walks it the other way. off0 is the
      // way-offset of THIS direction's start, offSign walks it backwards, so
      // off0 + offSign·s is always true meters-from-way-start (bridge ramps).
      const rpts = pts.slice().reverse();
      const rcum = new Float32Array(n);
      for (let i = 1; i < n; i++)
        rcum[i] = rcum[i - 1] + dist(rpts[i][0] - rpts[i - 1][0], rpts[i][1] - rpts[i - 1][1]);
      // len MUST be this array's own last entry, not the forward edge's. cum is
      // a Float32Array, and summing the same segment lengths in the opposite
      // order rounds to a DIFFERENT float32: measured on the real region, 1826
      // of 23750 edges — every one of them a twin — had cum[n-1] !== len, by up
      // to 4.9e-4 m. Where the reverse total rounded LOW (941 edges) _nomTo
      // deadlocked at that edge's end: `p.na >= limit - 1e-9` stayed false while
      // tgt === p.na, so the loop made zero progress and span to its 4000-step
      // guard, every call, for ever. 42 % of the rendered fleet was driving on a
      // schedule frozen seconds-to-minutes in the past, and the wasted spinning
      // was 4.7 ms of the 4 Hz sweep. `off + len` below stays the FORWARD length
      // — that is this edge's start measured from the way's start, which is a
      // fact about the way, not about the rounding of this sum.
      const rev = this._makeEdge(road, rpts, rcum, rcum[n - 1], speed, off + len, -1);
      fwd.twin = rev; rev.twin = fwd;
    }
  }

  _makeEdge(road, pts, cum, len, speed, off0, offSign) {
    const n = pts.length;
    // interior turn angles, precomputed so the per-frame curve scan is a read
    const vertAng = new Float32Array(n);
    for (let i = 1; i < n - 1; i++) {
      const ax = pts[i][0] - pts[i - 1][0], az = pts[i][1] - pts[i - 1][1];
      const bx = pts[i + 1][0] - pts[i][0], bz = pts[i + 1][1] - pts[i][1];
      vertAng[i] = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    }
    const Lf = cum[1] || 1, Ll = (cum[n - 1] - cum[n - 2]) || 1;
    const m = pts[n >> 1];
    const e = {
      a: this._node(pts[0][0], pts[0][1]),
      b: this._node(pts[n - 1][0], pts[n - 1][1]),
      pts, cum, len, speed, oneway: !!road.ow, road, off0, offSign,
      fdx: (pts[1][0] - pts[0][0]) / Lf,  fdz: (pts[1][1] - pts[0][1]) / Lf,
      ldx: (pts[n - 1][0] - pts[n - 2][0]) / Ll, ldz: (pts[n - 1][1] - pts[n - 2][1]) / Ll,
      vertAng, mx: m[0], mz: m[1], twin: null,
      // traffic-light governance, bound later: the junction at our far node,
      // its distance (nearest wins), our phase bucket, and where to hold
      sig: null, sigD: 1e9, sigPh: 0, sigStop: 0,
      // stable identity: quantised geometry only, so both clients agree on it
      // whatever order the tiles landed in. Direction matters (a twin has its
      // endpoints swapped and is a different edge to route along).
      eid: 0,
    };
    e.eid = hash32(q4(pts[0][0]), q4(pts[0][1]), q4(pts[n - 1][0]), q4(pts[n - 1][1]), q4(m[0]), q4(m[1]));
    e.a.out.push(e);
    e.a.outS = null;
    e.b.inn.push(e);   // incoming list: where a synthetic junction plants its poles
    this.edges.push(e);
    this._egrid.addLine(pts, e);
    this._cellAdd(e);
    return e;
  }

  // ---- the population grid ------------------------------------------------
  // A directed edge belongs to exactly ONE cell — the one holding its midpoint.
  // Not "every cell it crosses": double-counting a 400 m arterial across three
  // cells would triple the traffic it generates. Service ways and obytné zóny
  // are excluded here rather than at spawn time, exactly as v7 excluded them
  // from _near: cars still ROUTE through car parks and courtyards, they simply
  // are not born there (60 % of the graph around the station is parking aisle,
  // and spawning uniformly put most of the fleet in one at 20 km/h).
  _cellAdd(e) {
    const t = e.road.t;
    if (t === 'service' || t === 'living_street') return;
    if (e.len < 14) return;                       // stub edges make sad spawns
    const ci = Math.floor(e.mx / CELL), cj = Math.floor(e.mz / CELL);
    const k = ci + ',' + cj;
    let c = this._cells.get(k);
    if (!c) this._cells.set(k, c = { ci, cj, edges: [], len: 0, lenMajor: 0, sorted: null });
    c.edges.push(e);
    c.len += e.len;
    if (MAJOR_RE.test(t)) c.lenMajor += e.len;
    c.sorted = null;                              // order is rebuilt on demand
    c._u = undefined;                             // urban factor: recount on growth
  }

  _cellEdges(c) {
    if (!c.sorted) c.sorted = c.edges.slice().sort(cmpEdge);
    return c.sorted;
  }

  // How many cars this square of city owes the world. Two players with the
  // SAME density setting compute the same number for the same square, which is
  // the whole point; two players with DIFFERENT settings deliberately live in
  // different worlds (the sparser one sees a subset — slots are removed from
  // the top, so the cars that remain are the same cars). Quantising to eighths
  // is what makes "the same setting" survive main.js easing its density knob:
  // two clients whose eased value differs by 3 % still land on one number.
  _slots(c) {
    const k = this._densK;
    if (k <= 0) return 0;
    // A kilometre of village lane owes the world far fewer cars than a
    // kilometre of Palackého. Major-class length keeps full weight (a trunk
    // through empty fields still carries traffic); residential length is
    // scaled by how built-up the square actually is, which is what separates
    // a sídliště from a hamlet with the same metres of asphalt.
    if (c._u === undefined) c._u = this.urbanAt ? this.urbanAt(c.ci * CELL + CELL / 2, c.cj * CELL + CELL / 2) : 1;
    const f = (c.lenMajor + (c.len - c.lenMajor) * c._u) * k / MPC;
    // SLOT_MAX exists to stop a motorway interchange fabricating thirty cars
    // out of ramp geometry — that is a statement about ROAD LENGTH, so it has
    // to scale with the density knob, or the knob stops working. It did stop
    // working: at density 2.5+ the cap bound in most downtown cells and the
    // 07:00 / 08:00 / 16:00 fleets came out within four cars of each other
    // however hard the settings pushed. Quantised the same way _densK is, so
    // two clients still agree.
    const cap = k > 1 ? Math.round(SLOT_MAX * k) : SLOT_MAX;
    if (f >= cap) return cap;
    // DITHER the fractional slot instead of truncating it. At 03:00 main.js
    // asks for 6 % of the daytime fleet, which is well under one car per cell:
    // a plain floor() would empty the entire region, and "no traffic at all at
    // night" is not what a 24× density curve means. The extra car is granted
    // to a hash-chosen share of cells, so it is still the same cells on every
    // client — deterministic dithering, not a dice roll.
    const n = Math.floor(f);
    return n + (rnd01(hash32(c.ci, c.cj, 0x5eed)) < f - n ? 1 : 0);
  }

  // Is this square of city the sort of place that owes the world a patrol at
  // all? Geometry and the density knob only — the COIN (which generation) lives
  // in _scanCells, so that both callers cannot drift apart on the eligibility
  // half of the question while the mint and the reap argue about the other.
  // _slots() > 0 is deliberate: it makes the traffic slider turn the police
  // down with everybody else (and off at zero), and because _slots is
  // non-decreasing in density, a sparse client's patrols are always a SUBSET of
  // a dense one's — the same containment the ordinary slots promise.
  _patrolOwed(c) {
    return !!c && c.lenMajor >= PATROL_MAJOR && this._slots(c) > 0;
  }

  // ---- traffic lights: clustering, poles, per-frame phase machine ----

  // Fold a batch of [x,z] signal points into junction controllers. Points
  // within SIG_CLUSTER of an existing controller JOIN it (its center is the
  // running centroid — a big crossing's four poles pull the center into the
  // middle of the box); anything else founds a new controller with a hashed
  // phase offset. Returns the set of touched junctions (or null) so addTile
  // can re-run edge binding for them.
  _growSignals(list) {
    let grown = null;
    for (const pt of list) {
      const x = pt[0], z = pt[1];
      let jn = null, bd = SIG_CLUSTER;
      this._jgrid.near(x, z, (j) => {
        const d = dist(j.x - x, j.z - z);
        if (d < bd) { bd = d; jn = j; }
      });
      if (!jn) {
        jn = { x, z, n: 0, off: 0, kx: 0x7fffffff, kz: 0x7fffffff, st0: -1, st1: -1,
          sigs: [], group: new THREE.Group() };
        this.vehicles.scene?.add(jn.group);
        this._junctions.push(jn);
        jn._gk = this._jgrid.add(x, z, jn);
      }
      // duplicate guard — a re-delivered tile must not sprout twin poles
      let dup = false;
      for (const s of jn.sigs) if (dist(s.x - x, s.z - z) < 1) { dup = true; break; }
      if (dup) continue;
      // PHASE IS ORDER-INDEPENDENT. v7 hashed the coordinates of whichever
      // point happened to found the cluster, and which point that is depends
      // on the order the region streamed — so two players got two different
      // green waves through the same town. The offset now hangs off the
      // lexicographically smallest quantised point in the cluster, which is a
      // property of the SET, not of the arrival order. It can still be revised
      // while a cluster is growing (a smaller point arrives later and re-phases
      // that junction once); that settles as soon as the tile is fully in.
      const qx = q4(x), qz = q4(z);
      if (qx < jn.kx || (qx === jn.kx && qz < jn.kz)) {
        jn.kx = qx; jn.kz = qz;
        jn.off = rnd01(hash32(qx, qz, 0x9e3779b9 | 0)) * SIG_CYCLE;
        jn.st0 = jn.st1 = -1;
      }
      jn.x = (jn.x * jn.n + x) / (jn.n + 1);
      jn.z = (jn.z * jn.n + z) / (jn.n + 1);
      jn.n++;
      // the running centroid can walk the controller into a different cell
      // (never further than SIG_CLUSTER, so at most one) — re-file it, or the
      // grid would stop answering for it
      const gk = Buckets.key(jn.x, jn.z);
      if (gk !== jn._gk) { this._jgrid.remove(jn._gk, jn); this._jgrid.add(jn.x, jn.z, jn); jn._gk = gk; }
      jn.sigs.push(this._makePole(x, z, jn.group));
      jn.st0 = jn.st1 = -1;         // force a lamp refresh — new poles start unlit
      (grown ??= new Set()).add(jn);
    }
    return grown;
  }

  // OSM maps maybe a tenth of the region's real signals, so we synthesize the
  // rest from the road graph itself: a node where ≥3 arms meet AND at least
  // two DISTINCT main-class roads leave in both bearing buckets (i.e. mains
  // cross, not merely continue through a way split) gets a fabricated signal
  // cluster — one stop-line point per approach, fed through the exact same
  // _growSignals/_makePole path as real OSM points, so poles, phases and the
  // car-braking logic cannot drift apart. Runs per addTile over ALL nodes:
  // a node that fails today may qualify when the next tile adds its fourth
  // arm, so only nodes that RESOLVED (built, or owned by a controller that
  // will never go away) are stamped done. Fully deterministic — geometry and
  // hash32 only, no Math.random — so every session grows the same city.
  _synthSignals() {
    let grown = null, made = 0;
    // CANONICAL ORDER, not Map insertion order. Two qualifying crossings
    // within SYNTH_CLEAR of each other suppress one another, and whichever is
    // visited first wins — which under insertion order means "whichever road
    // the region streamed first", i.e. a different answer for every player.
    // Sorting the candidates by quantised position makes that a property of
    // the map. (Across SEPARATE addTile calls the tie is still broken by
    // arrival: a node only qualifies once its arms are all in, so this remains
    // order-dependent for crossings whose arms straddle a tile border. Region
    // tiles are 4.8 km and carry their own signals, so that is a handful of
    // junctions at the seams, kilometres from anyone.)
    const cands = [];
    for (const n of this._nodes.values()) {
      // any main-class arm qualifies a node for CONSIDERATION — the strict
      // both-bearings test moves into the no-owner branch below, because a
      // node beside a real OSM signal deserves poles even when the cross
      // street is residential (OSM already said the crossing is signalised)
      if (n._sg || n.deg < 3) continue;
      if (!n.dirs || !n.dirs.length) continue;
      cands.push(n);
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (q4(a.x) - q4(b.x)) || (q4(a.z) - q4(b.z)));
    for (const n of cands) {
      let owner = null, ownerD = SYNTH_CLEAR;   // a real cluster (or an earlier synthetic
      this._jgrid.near(n.x, n.z, (j) => {       // one) within SYNTH_CLEAR owns this crossing
        const d = dist(j.x - n.x, j.z - n.z);
        if (d < ownerD) { ownerD = d; owner = j; }
      });
      if (owner) {
        // …but OSM routinely maps ONE signal node for a whole signalised
        // crossing, leaving the owner a single lonely pole. Top it up with
        // the same per-approach stop points — attached to the owner
        // DIRECTLY, not through _growSignals: a Jana-Pernera-sized box is
        // wider than the cluster radius, and clustering would either drop
        // the far approaches or found a rival controller with its own green.
        n._sg = 1;
        let added = false;
        for (const e of n.inn) {
          if (e.len < SIG_MIN_EDGE) continue;
          const pose = poseAt(e, e.len - Math.min(SYNTH_BACK, e.len * 0.45), 0);
          let dup = false;
          for (const sg of owner.sigs) {
            if (dist(sg.x - pose.x, sg.z - pose.z) < 6) { dup = true; break; }
          }
          if (dup) continue;
          owner.sigs.push(this._makePole(pose.x, pose.z, owner.group));
          added = true;
        }
        if (added) {
          owner.st0 = owner.st1 = -1;
          made++;
          (grown ??= new Set()).add(owner);
        }
        continue;
      }
      // NO owner: this would FOUND a signal cluster, and that keeps the
      // strict rule — two DISTINCT main roads genuinely crossing, an arterial
      // among them. Measured as arm angles, not compass buckets: the old
      // ns/ew test never saw a diagonal crossing (both mains in one bucket)
      // and Czech grids are full of 45° streets. "Crossing" = some pair of
      // arms from different roads separated by 50°–130° — a Y-fork is not a
      // crossing, and neither is one road bending through the node.
      if (!n.dirs || n.dirs.length < 2) continue;
      let crossing = false, major = false;
      for (let i = 0; i < n.dirs.length && !crossing; i++) {
        for (let j = i + 1; j < n.dirs.length; j++) {
          if (n.dirs[i][2] === n.dirs[j][2]) continue;
          const dot = n.dirs[i][0] * n.dirs[j][0] + n.dirs[i][1] * n.dirs[j][1];
          const crs = n.dirs[i][0] * n.dirs[j][1] - n.dirs[i][1] * n.dirs[j][0];
          const a = Math.abs(Math.atan2(crs, dot));
          if (a > 0.87 && a < 2.27) { crossing = true; break; }   // 50°–130°
        }
      }
      if (!crossing) continue;
      for (const [, , r] of n.dirs) if (SIG_MAJOR.test(r.t)) { major = true; break; }
      // NOT stamped on failure: the arterial arm may arrive with a later
      // tile, and a stamp here would blind the node to it forever
      if (!major) continue;
      // one stop-line point per approach, planted a few meters back up the
      // incoming edge. Capping at 45 % of the edge keeps the point past the
      // halfway mark, so _makePole's "which direction does this pole serve"
      // test can never flip it onto the departing lane of a short edge.
      _pts.length = 0;
      for (const e of n.inn) {
        if (e.len < SIG_MIN_EDGE) continue;     // junction-box stub — ungoverned anyway
        const pose = poseAt(e, e.len - Math.min(SYNTH_BACK, e.len * 0.45), 0);
        _pts.push([pose.x, pose.z]);
      }
      if (_pts.length < 2) continue;            // stub-only today; retry as tiles grow arms
      n._sg = 1; made++;
      const g = this._growSignals(_pts);
      if (g) { grown ??= new Set(); for (const j of g) grown.add(j); }
    }
    if (made) console.log(`semafory: +${made} syntetických`);
    return grown;
  }

  // Build one pole at a signal point: find the nearest drivable edge, stand
  // the pole on the RIGHT curb of that approach, face the lamps back down the
  // road at oncoming drivers, and derive the phase bucket from the road's
  // bearing (N-S-ish roads go on phase 0, E-W-ish on phase 1 — the classic
  // 2-phase crossing). One-time cost per signal; meshes freeze their matrices
  // because nothing about a pole ever moves again.
  _makePole(x, z, group) {
    const A = sigAssets();
    let best = null, bestD = 25, bestS = 0;
    // the edge grid holds every edge in every cell its polyline crosses, so the
    // 3×3 neighbourhood is a superset of everything inside the 25 m cap
    this._egrid.near(x, z, (e) => {
      const p = e.pts;
      for (let i = 0; i < p.length - 1; i++) {
        const d = distPointToSegment(x, z, p[i][0], p[i][1], p[i + 1][0], p[i + 1][1], _snap);
        if (d < bestD) { bestD = d; best = e; bestS = e.cum[i] + _snap.t * (e.cum[i + 1] - e.cum[i]); }
      }
    });
    let px = x, pz = z, dx = 0, dz = -1;         // orphan fallback: face north in place
    if (best) {
      // of the two directions sharing this asphalt, pick the one whose END is
      // closer — signals stand at the stop line just before their junction,
      // so the approach with the junction ahead is the one this pole serves
      if (best.twin && bestS < best.len - bestS) { bestS = best.len - bestS; best = best.twin; }
      const pose = poseAt(best, bestS, 0);
      dx = pose.dx; dz = pose.dz;
      const w2 = (best.road.w || 6) * 0.5 + 0.7; // right curb: half width + shoulder
      px = pose.x - dz * w2;                     // right of travel = (-dz, dx)
      pz = pose.z + dx * w2;
    }
    const g = new THREE.Group();
    // ON THE GROUND. This said `0` — and this world is drawn in ABSOLUTE
    // elevation, so every traffic light in the country stood at sea level:
    // 220 m under the asphalt at Pardubice, 380 under Prague. They were built,
    // lit, phase-cycling and parented to the scene the whole time, buried
    // inside the terrain solid. "stále nikde nejsou semafory" was literal.
    g.position.set(px, this._groundAt(px, pz), pz);
    // lamps are authored on the head's −z face; forward of a mesh yawed by h
    // is (−sin h, −cos h), and we want that pointing AGAINST travel (at the
    // drivers rolling up), so sin h = dx, cos h = dz
    g.rotation.y = Math.atan2(dx, dz);
    const lamps = [];
    g.add(new THREE.Mesh(A.pole, A.poleMat), new THREE.Mesh(A.head, A.headMat));
    for (let i = 0; i < 3; i++) {                // red / amber / green, top down
      const L = new THREE.Mesh(A.lamp, i === 0 ? A.redOff : i === 1 ? A.ambOff : A.grnOff);
      L.position.set(0, 3.3 - i * 0.22, -0.10);  // poking through the head's front face
      g.add(L);
      lamps.push(L);
    }
    // hundreds of static poles: freeze every matrix once, render for free after
    for (const c of g.children) { c.updateMatrix(); c.matrixAutoUpdate = false; }
    g.updateMatrix(); g.matrixAutoUpdate = false;
    group.add(g);
    return { x, z, b: Math.abs(dz) >= Math.abs(dx) ? 0 : 1, lamps, mesh: g };
  }

  // govern edge `e` by junction `jn` if e ENDS at it and no closer junction
  // claimed it yet. The phase bucket comes from the edge's FINAL bearing (the
  // approach direction into the box), the hold point sits SIG_STOP short of
  // the node so stopped cars don't block the crossing itself.
  _tryBind(e, jn) {
    if (e.len < SIG_MIN_EDGE) return;
    const d = dist(jn.x - e.b.x, jn.z - e.b.z);
    if (d >= SIG_EDGE_R || d >= e.sigD) return;
    e.sig = jn; e.sigD = d;
    e.sigPh = Math.abs(e.ldz) >= Math.abs(e.ldx) ? 0 : 1;
    e.sigStop = Math.max(1, e.len - SIG_STOP);
  }

  // phase state for one bucket of a junction: 0 green, 1 amber, 2 red. The
  // whole city shares one clock — worldT(), not a per-tab accumulator, which
  // is the single line that used to make two players' lights blink out of
  // step. Each junction's hashed offset staggers it, and bucket 1 lives half a
  // cycle out of phase, which guarantees the two directions are NEVER green
  // together (red covers the other side's green AND amber).
  _phase(jn, bucket, wt) {
    let t = (wt + jn.off) % SIG_CYCLE;
    if (bucket) t = (t + SIG_CYCLE / 2) % SIG_CYCLE;
    return t < SIG_GREEN ? 0 : t < SIG_GREEN + SIG_AMBER ? 1 : 2;
  }

  // advance lamp visuals — pure arithmetic per junction per frame, material
  // swaps only on the ~11 s state flips, and only on ≤3 meshes per pole
  _tickSignals(wt) {
    for (const jn of this._junctions) {
      const s0 = this._phase(jn, 0, wt), s1 = this._phase(jn, 1, wt);
      if (s0 === jn.st0 && s1 === jn.st1) continue;
      jn.st0 = s0; jn.st1 = s1;
      for (const sg of jn.sigs) {
        const st = sg.b ? s1 : s0;
        sg.lamps[0].material = st === 2 ? _S.redOn : _S.redOff;
        sg.lamps[1].material = st === 1 ? _S.ambOn : _S.ambOff;
        sg.lamps[2].material = st === 0 ? _S.grnOn : _S.grnOff;
      }
    }
  }

  // ---- the light bar, per frame -------------------------------------------

  // Alternate the two lamps off SHARED time, so two clients watching the same
  // patrol see the same flash rather than two blinkers beating against each
  // other. `wt % (2·SIREN_T)` rather than a counter or `Math.floor(wt/T) & 1`
  // on purpose: worldT() is ~1.8e7 and climbing, and an integer lane that
  // large is one long session away from losing its low bit — the modulo is
  // exact for as long as a double can hold the clock at all.
  //
  // Allocation-free and swap-free in the common case: the state is compared
  // against the cached one and only ~4.5 material assignments a second per
  // car survive. The set self-cleans on a mesh that has left the scene, which
  // is how a unit js/police.js spawned and then disposed of stops costing us
  // anything without police.js having to remember to switch it off.
  _tickSirens(wt) {
    const A = copAssets();
    for (const car of this._sirens) {
      const c = car._cop;
      if (!c || !car.mesh || !car.mesh.parent) { this._sirens.delete(car); continue; }
      const st = (wt % (SIREN_T * 2)) < SIREN_T ? 1 : 2;
      if (st === c.st) continue;
      c.st = st;
      c.l.material = st === 1 ? A.on : A.off;
      c.r.material = st === 2 ? A.on : A.off;
    }
  }

  // ---- what js/police.js and js/main.js hold on to -------------------------

  /**
   * Turn a patrol car's majáček on or off. Works on an ambient patrol, on one
   * that has been stolen out of the traffic, and on one spawnPatrol() made
   * from nothing — the bar hangs off the CAR, not off the schedule, precisely
   * so that taking a car out of the shared population does not put its lights
   * out. No-ops harmlessly on any other car and in any headless fixture.
   */
  setSiren(car, on) {
    if (!car) return;
    car.siren = !!on;
    const c = car._cop;
    if (!c) return;
    if (on) { this._sirens.add(car); return; }
    this._sirens.delete(car);
    if (c.st) { const A = copAssets(); c.l.material = A.off; c.r.material = A.off; c.st = 0; }
  }

  /**
   * The nearest ambient patrol to (x, z) within `r`, or null. `want(car)` is
   * an optional filter — police.js uses it to skip units it has already taken.
   * The natural pursuit opening is nearestPatrol() followed by steal(): the
   * car keeps its mesh, its paint and its bar, leaves this.cars and this.patrols
   * and becomes the caller's to drive, and slotKey() hands the net layer the
   * string the peer needs to stop driving its own copy of it.
   */
  nearestPatrol(x, z, r = 500, want = null) {
    let best = null, bd = r * r;
    for (const car of this.patrols) {
      if (want && !want(car)) continue;
      const dx = car.x - x, dz = car.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bd) { bd = d2; best = car; }
    }
    return best;
  }

  /**
   * A patrol car with no schedule and no brain, for a caller that wants to
   * drive one itself — a unit called in from off-map, or a roadblock. It is
   * NOT in this.cars and NOT in this.patrols, traffic will never touch it, and
   * disposing of it is `vehicles.remove(car)` (call setSiren(car, false) first
   * or let _tickSirens notice the mesh has left the scene). It exists so that
   * "what a police car is" is answered in one place; see _buildPatrol.
   */
  spawnPatrol(x, z, heading = 0) { return this._buildPatrol(x, z, heading); }

  // ---- routes: a deterministic walk of the graph --------------------------

  // choose the outgoing edge at the far node of `edge`, using a hash instead of
  // Math.random and the CANONICALLY ORDERED out-list instead of insertion
  // order — the two changes that make one car's whole itinerary reproducible
  // on another machine. Oneways are already respected by construction (a
  // oneway never grew a reverse twin). U-turns only when the node is otherwise
  // a dead end.
  _pickNextDet(edge, h) {
    const node = edge.b;
    if (!node.outS || node.outS.length !== node.out.length) node.outS = node.out.slice().sort(cmpEdge);
    _cand.length = 0; _straight.length = 0;
    for (const o of node.outS) {
      if (o === edge.twin) continue;
      _cand.push(o);
      const dot = edge.ldx * o.fdx + edge.ldz * o.fdz;
      const crs = edge.ldx * o.fdz - edge.ldz * o.fdx;
      if (Math.abs(Math.atan2(crs, dot)) < STRAIGHT) _straight.push(o);
    }
    // Dead end (or oneway trap): the trip is over HERE. Turning on a heel and
    // driving back down the same street read as a glitch, because it is one —
    // real cul-de-sac visitors park, and the retire grace does exactly that.
    if (!_cand.length) return null;
    // city traffic mostly flows through; side streets soak up the remainder
    const pool = (_straight.length && rnd01(hash32(h, 0x5f1)) < 0.7) ? _straight : _cand;
    return pool[(rnd01(hash32(h, 0xb17)) * pool.length) | 0];
  }

  // Grow the itinerary until step `want` exists (or the route is complete).
  // Deliberately LAZY and deliberately STATELESS: step i is hash32(seed, i),
  // not the i-th draw of a sequential generator. That means a client whose
  // region streamed in late — and whose graph therefore grew an extra arm at
  // some junction after another client had already routed through it — can
  // recompute any step in isolation and get the same answer as everybody else,
  // provided the graph agrees. What it CANNOT fix is a step committed while
  // the continuation was still unloaded: the pick is made from the out-list as
  // it stands. Lookahead is one step, ~10 s of driving, so this only bites at
  // the streaming frontier, kilometres from any player.
  _routeEnsure(p, want) {
    while (p.route.length <= want) {
      const last = p.route[p.route.length - 1];
      const end = last.base + last.e.len;
      if (end >= p.routeM) { p.routeEnd = Math.min(p.routeM, end); return; }
      const nx = this._pickNextDet(last.e, hash32(p.seed, p.route.length, 0x51));
      if (!nx) { p.routeEnd = end; return; }     // dead end: the trip is over here
      const dot = last.e.ldx * nx.fdx + last.e.ldz * nx.fdz;
      const crs = last.e.ldx * nx.fdz - last.e.ldz * nx.fdx;
      const ang = Math.abs(Math.atan2(crs, dot));
      last.turnOut = ang;
      p.route.push({ e: nx, base: end, turnIn: ang, turnOut: 0 });
    }
  }

  // ---- the schedule: position as a pure function of shared time -----------

  // How fast this segment may be ENTERED and LEFT. Both ends limit it: an
  // interior polyline kink through vertAng, and at the edge's first/last
  // segment the TURN onto/off the edge, which vertAng cannot know because it
  // lives in the neighbouring edge.
  //
  // v8 collapsed the two into one number — min(entry, exit) — and applied it
  // to the whole segment, which is where the city lost a third of its speed:
  // the median OSM segment on this graph is 11 m long and half of them carry a
  // kink at one end, and "crawl all eleven metres because one vertex bends"
  // is not what a car does. They are end conditions, not a speed limit.
  _segCaps(st, seg, vMax, out) {
    const e = st.e, A = e.vertAng, n = e.pts.length;
    const a0 = seg === 0 ? st.turnIn : A[seg];
    const a1 = seg === n - 2 ? st.turnOut : A[seg + 1];
    let v0 = Math.min(vMax, cornerLimit(a0)); if (!(v0 > 2)) v0 = 2;
    let v1 = Math.min(vMax, cornerLimit(a1)); if (!(v1 > 2)) v1 = 2;
    out.v0 = v0; out.v1 = v1;
    return out;
  }

  // Advance the schedule until it is at, or straddles, shared time T. Each
  // iteration crosses ONE piece — a polyline segment, or the stretch up to a
  // stop line, or a red wait — so a car that has existed for TRIP_T costs a
  // few dozen iterations to catch up, not TRIP_T·SIM_HZ. That is what lets us
  // keep a schedule alive for every car in a 1.9 km radius whether or not it
  // has a mesh.
  _nomTo(p, T) {
    let guard = 0;
    while (!p.ndone && guard++ < 4000) {
      if (p.nwait > 0) {
        if (T < p.nt + p.nwait) return;
        p.nt += p.nwait; p.nwait = 0;
      }
      this._routeEnsure(p, p.ni + 1);
      const st = p.route[p.ni], e = st.e;
      const limit = Math.min(e.len, p.routeEnd - st.base);
      if (p.na >= limit - 1e-9) {
        if (st.base + limit >= p.routeEnd - 1e-9 || !p.route[p.ni + 1]) {
          p.ndone = 1; p.nv = 0; p.na = limit; return;
        }
        p.ni++; p.na = 0; p.nseg = 0;
        const ne = p.route[p.ni].e;
        p.vMax = ne.speed * p.vK;
        p.nsig = 0;
        continue;
      }
      while (p.nseg < e.pts.length - 2 && p.na >= e.cum[p.nseg + 1]) p.nseg++;
      const segEnd = Math.min(e.cum[p.nseg + 1], limit);
      let tgt = segEnd;
      let sigHere = false;
      if (!p.nsig && e.sig && e.sigStop > p.na && e.sigStop < tgt) { tgt = e.sigStop; sigHere = true; }
      const L = tgt - p.na;
      // FORWARD PROGRESS IS NOT OPTIONAL. `tgt` is a Float32Array read and
      // `limit` a double, so a piece of zero (or negative) length is a rounding
      // artefact, never geometry — and taking it costs dur = 0, which leaves
      // p.na and p.nt exactly where they were and spins this loop to its guard
      // on every future call, freezing the schedule for good (see the note on
      // rcum in _addEdge for the case that actually shipped). Snapping to the
      // edge's own end lets the next iteration take the hand-off branch.
      if (!(L > 1e-9)) { p.na = limit; continue; }
      // THE PIECE, AS A REAL CAR WOULD TAKE IT. v8 crossed the whole piece at
      // the slower of its two corner caps and then billed a separate ramp
      // charge for the deceleration it had already been charged for; the
      // median piece here is 11 m long, so that was a car crawling an entire
      // block because one vertex of the polyline had a kink in it. Now the
      // corner caps are the piece's END CONDITIONS — enter at v0, leave at v1,
      // cruise at the driver's desire in between — and pieceTime() integrates
      // the trapezoid. The reactive layer plans with the very same ACCEL and
      // BRAKE, so the two stay in step: measured lag is unchanged at ~2 m
      // while the city runs a third faster.
      this._segCaps(st, p.nseg, p.vMax, _caps);
      const atStart = p.na <= e.cum[p.nseg] + 1e-6;
      const atSegEnd = tgt >= segEnd - 1e-6;
      const atRouteEnd = st.base + tgt >= p.routeEnd - 1e-6;
      // resuming mid-segment (just past a stop line, or out of a red) we carry
      // the speed we actually left the last piece at, not the corner's
      const v0 = atStart ? _caps.v0 : Math.min(p.vMax, p.nvOut > 2 ? p.nvOut : 2);
      // …and we must be able to STOP at a destination and be slow at a stop
      // line, whatever colour it turns out to be
      const v1 = atRouteEnd ? 2
        : sigHere ? Math.min(p.vMax, SIG_APPROACH)
          : atSegEnd ? _caps.v1 : p.vMax;
      const dur = pieceTime(L, v0, v1, p.vMax);
      p.nv = L / dur;                            // piecewise-constant, as before
      if (p.nt + dur > T) return;                // T falls inside this piece
      p.na = tgt; p.nt += dur; p.nvOut = v1;
      if (sigHere) {
        p.nsig = 1; p.nwait = redWait(e.sig, e.sigPh, p.nt);
        if (p.nwait > 0) p.nvOut = 2;            // it waited: it pulls away from rest
      }
    }
  }

  // Route arc-length of the schedule at time T (call _nomTo(p, T) first).
  _nomArc(p, T) {
    if (p.ndone) return p.routeEnd;
    const st = p.route[p.ni];
    if (p.nwait > 0) return st.base + p.na;
    return st.base + p.na + p.nv * (T > p.nt ? T - p.nt : 0);
  }
  _nomV(p) { return (p.ndone || p.nwait > 0) ? 0 : p.nv; }

  // ---- population sweep ---------------------------------------------------

  // Walk the cells that could possibly hold a car that ends up near the player
  // and make sure every slot in them has a schedule. Everything here is a
  // function of (cell, slot, generation, worldT); the player's position only
  // decides WHERE WE LOOK, never what we find.
  _scanCells(wt, px, pz) {
    const R = this._attachR();
    const phR = this._phantomR();
    const ci0 = Math.floor((px - phR) / CELL), ci1 = Math.floor((px + phR) / CELL);
    const cj0 = Math.floor((pz - phR) / CELL), cj1 = Math.floor((pz + phR) / CELL);
    let budget = SCAN_BUDGET;
    for (let ci = ci0; ci <= ci1; ci++) {
      for (let cj = cj0; cj <= cj1; cj++) {
        const key = ci + ',' + cj;
        const c = this._cells.get(key);
        if (!c) continue;
        const cd = dist((ci + 0.5) * CELL - px, (cj + 0.5) * CELL - pz) - CELL_HALF_DIAG;
        if (cd > R + ROUTE_MAX) continue;
        const slots = this._slots(c);
        for (let k = 0; k < slots; k++) {
          const sk = key + '/' + k;
          if (this._pool.has(sk)) continue;
          const ss = hash32(WORLD_SEED, ci, cj, k);
          const ph = rnd01(hash32(ss, 7)) * TRIP_T;   // slots don't all flip together
          const gen = Math.floor((wt + ph) / TRIP_T);
          const t0 = gen * TRIP_T - ph;
          if (wt < t0) continue;
          // cheap reach bound: a car cannot have travelled further than its age
          // times an absurd speed, nor further than its route is long. Skips
          // most of the ring without ever building a route for it.
          const reach = Math.min(ROUTE_MAX, (wt - t0) * V_REACH);
          if (cd - reach > R) continue;
          if (budget-- <= 0) return;
          this._birth(sk, c, k, ss, gen, t0, wt);
        }
        // ---- and the extra slot: this cell's patrol car -------------------
        // Everything above, once more, with POLICE_K in place of k and a roll
        // in front of it. The roll is the whole of the difference between a
        // police force and a taxi rank: an ordinary slot always holds a car,
        // this one holds one only when the cell wins its coin.
        //
        // THE COIN IS TOSSED PER (CELL, GENERATION). Hashing the cell alone —
        // which is what the first draft did — is not a low probability, it is
        // a PERMANENT ASSIGNMENT: the same 16 % of squares carry a police car
        // for the entire life of the world and the other 84 % never see one,
        // so one street in the centre is a permanent patrol beat and the next
        // one over is a guaranteed safe house. Folding `gen` in re-rolls every
        // cell every TRIP_T, which is what makes the police a presence rather
        // than a map feature, and it costs exactly one more hash argument.
        if (slots > 0 && c.lenMajor >= PATROL_MAJOR) {
          const pk = key + '/' + POLICE_K;      // inside the gate: an ineligible
                                                // cell must not build a string 4× a
                                                // second for a slot it cannot have
          if (!this._pool.has(pk)) {
            const ss = hash32(WORLD_SEED, ci, cj, POLICE_K);
            const ph = rnd01(hash32(ss, 7)) * TRIP_T;
            const gen = Math.floor((wt + ph) / TRIP_T);
            const t0 = gen * TRIP_T - ph;
            if (wt >= t0 && rnd01(hash32(ss, gen, PATROL_SALT)) < (this.patrolP ?? PATROL_P)) {
              const reach = Math.min(ROUTE_MAX, (wt - t0) * V_REACH);
              if (cd - reach <= R) {
                if (budget-- <= 0) return;
                this._birth(pk, c, POLICE_K, ss, gen, t0, wt, 1);
              }
            }
          }
        }
      }
    }
  }

  // Mint one car's entire existence from hash32(cell, slot, generation).
  // `police` is the ONE thing about a schedule that is not derived from that
  // hash, because it is not a property of the slot but of WHICH slot: the cell
  // has n ordinary ones and, some generations, one more. It is stamped on the
  // record so that every later decision — the reap, the hard cap, the mesh —
  // can ask the record instead of pattern-matching an index.
  _birth(sk, c, k, ss, gen, t0, wt, police = 0) {
    const arr = this._cellEdges(c);
    if (!arr.length) return;
    const seed = hash32(ss, gen, 0x1d3);
    let e = null;
    const i0 = (rnd01(hash32(seed, 1)) * arr.length) | 0;
    // A patrol gets more darts because it is fussier: it must start on a
    // main-class road (a police car creeping out of a residential loop is not
    // what a patrol is), and in a cell that qualified on lenMajor there is at
    // least one such edge to find. If eight darts all miss, this cell simply
    // has no patrol this generation — deterministic, and the next roll is 150 s
    // away, so it is not a busy loop.
    const tries = police ? 8 : 4;
    for (let n = 0; n < tries && n < arr.length; n++) {
      const cand = arr[(i0 + n) % arr.length];
      // never mint a car on the last edge of a cul-de-sac: it would be born
      // driving into the wall and spend its whole life parked at the end
      if (cand.len < 14 || cand.a.deg <= 1 || cand.b.deg <= 1) continue;
      if (police && !MAJOR_RE.test(cand.road.t)) continue;
      e = cand; break;
    }
    if (!e) return;
    const sIn = 2 + rnd01(hash32(seed, 2)) * (e.len - 4);
    const vK = police ? PATROL_VK_MIN + rnd01(hash32(seed, 4)) * PATROL_VK_VAR
      : VK_MIN + rnd01(hash32(seed, 4)) * VK_VAR;
    const p = {
      key: sk, ci: c.ci, cj: c.cj, k, cell: c, seed, gen, t0, vK, police,
      routeM: ROUTE_MIN + rnd01(hash32(seed, 3)) * ROUTE_VAR,
      route: [{ e, base: -sIn, turnIn: 0, turnOut: 0 }],
      routeEnd: 0,
      // schedule state
      ni: 0, na: sIn, nt: t0, nseg: 0, nv: 0, nvOut: 0, nwait: 0, nsig: 0,
      vMax: e.speed * vK, ndone: 0,
      // rendered state (only meaningful while attached)
      car: null, sR: 0, ri: 0, edge: e, s: sIn, seg: 0, next: null, laneOff: 0,
      sx: 0, sz: 0, sy: 0, sh: 0, px: 0, pz: 0, py: 0, ph: 0,
      heldT: 0, sigQ: false, graceT: 0, stolen: 0, dead: 0,
      // v9: local-only. A ghost has left the shared population and drives on
      // by itself until the player stops looking at it.
      ghost: 0, ghostT: 0,
    };
    p.routeEnd = p.routeM;
    p.nsig = (e.sig && e.sigStop <= sIn) ? 1 : 0;
    this._pool.set(sk, p);
    this._nomTo(p, wt);
  }

  // Attach / detach meshes and reap dead or out-of-range schedules. Attaching
  // is the ONLY place a car gets a mesh, it happens because the schedule says
  // the car is near — never because "it is time to spawn one" — and since v9
  // it additionally never happens where the player would watch it happen.
  _sweepPool(wt, px, pz) {
    const aR = this._attachR(), inR2 = aR * aR;
    const ringR2 = TRAFFIC.spawnR * TRAFFIC.spawnR;   // the plain v8 ring, behind you
    const phR = this._phantomR();
    // A mesh may live a little past the attach band, so that a car hovering on
    // the boundary does not flicker on and off; it is dropped as soon as it is
    // both out there and out of sight.
    const outR = Math.max(TRAFFIC.despawnR, aR + 60), outR2 = outR * outR;
    for (const p of this._pool.values()) {
      // generation rollover: this slot's car has served its time. A STOLEN slot
      // (or one claimed over the wire before we ever built it) sits here as a
      // tombstone for exactly that long, so the schedule cannot quietly refill
      // the car out from under the player driving it.
      const ss = hash32(WORLD_SEED, p.ci, p.cj, p.k);
      const gen = Math.floor((wt + rnd01(hash32(ss, 7)) * TRIP_T) / TRIP_T);
      if (gen !== p.gen) { this._retire(p); continue; }
      if (p.stolen) continue;                    // the player drives it now; not ours
      const cd = dist((p.ci + 0.5) * CELL - px, (p.cj + 0.5) * CELL - pz) - CELL_HALF_DIAG;
      // THE REAP HAS TO AGREE WITH THE MINT, and for the patrol slot the
      // ordinary test cannot: `p.k >= slots` asks "is this index still inside
      // the cell's allowance", and the patrol has no index inside that
      // allowance to be inside. Whichever sentinel POLICE_K had been given,
      // one side of that comparison was going to be wrong — a big one (the
      // first draft's 0x9c0) is >= every possible slot count and reaped the
      // patrol on the very next sweep after its birth, so not one police car
      // would ever have appeared on screen; a negative one is < every slot
      // count and would have made the patrol immortal, surviving even the
      // density knob being turned to zero. So the flag decides, not the index:
      // an ordinary slot is owed while its index fits, a patrol while its cell
      // still qualifies. The generation check above has already re-tested the
      // coin, so all that is left here is eligibility, which is exactly what
      // can change under a settings change or a late tile.
      const owed = p.police ? this._patrolOwed(p.cell) : p.k < this._slots(p.cell);
      if (cd > phR || !owed) { this._retire(p); continue; }
      if (p.car) {
        if (p.dead) { this._retire(p); continue; }
        const dx = p.sx - px, dz = p.sz - pz;
        // detaching is not destroying — the schedule keeps running and the car
        // can come back — but it is still a mesh vanishing, so it waits for
        // the same privacy the reaper does.
        if (dx * dx + dz * dz > outR2 && !this._visible(p.sx, p.sz)) this._detach(p);
        continue;
      }
      // detached: the schedule still runs, cheaply, so we know when it arrives
      this._nomTo(p, wt);
      if (p.ndone && p.nwait <= 0) { p.dead = 1; continue; }
      const pose = this._nomPose(p, wt);
      if (!pose) continue;
      // THE ATTACH GATE, and it is two rules, not one:
      //   · BEHIND you (outside the cone) nothing has changed since v8 — the
      //     mesh appears anywhere inside TRAFFIC.spawnR, because you are not
      //     looking at any of it. Reaching further out there would only cost
      //     meshes for nothing.
      //   · IN FRONT of you the permitted range is [NOTICE_R, attachR), and
      //     because the sweep attaches at the first legal opportunity, a car
      //     the player is driving TOWARDS is picked up out at the fog wall in
      //     [hideR, attachR) where a fade-in cannot be read; it crosses the
      //     wall already bodied and drives in. The stretch between NOTICE_R
      //     and hideR is not for those cars. It exists for the ones with no
      //     other chance at all — minted inside your fog wall, in your cone,
      //     and staying there — which v9.0 left permanently invisible and
      //     which is most of a motorway. See NOTICE_R.
      const dx = pose.x - px, dz = pose.z - pz;
      const d2 = dx * dx + dz * dz;
      if (d2 >= inR2) continue;
      if (this._readableForAttach(pose.x, pose.z)) continue;
      if (d2 > ringR2 && !this._inCone(pose.x, pose.z)) continue;
      this._attach(p, wt, pose);
    }
  }

  // The schedule is done with this car. If nobody can see it, that is the end
  // of it; if somebody can, the car leaves the shared population NOW (so the
  // slot is free and the next generation is minted on time, and snapshot() is
  // bit-identical to what it would have been) and carries on locally as a
  // ghost until it is out of sight. See the v9 header for why the slot is
  // released rather than held as a tombstone.
  _retire(p) {
    if (p.car && !p.stolen && this._heldVisible(p)) { this._toGhost(p); return; }
    this._reap(p);
  }

  _toGhost(p) {
    this._pool.delete(p.key);
    p.ghost = 1;
    p.ghostT = 0;
    p.dead = 0;                  // the ghost is driving again, not expiring
    p.stolen = 0;
    // A ghost must not collide with the live slot in any map keyed by
    // car.ai.key — the next generation is about to take that exact string.
    p.key = p.key + '#g' + p.gen;
    this._ghosts.add(p);
  }

  // Ghost bookkeeping, on the same 4 Hz timer as the pool sweep. A ghost dies
  // the moment it is unobserved, which is nearly always within a few seconds:
  // it is still driving, and a 116° cone is a small share of the directions a
  // moving car can take. GHOST_MAX is the surrender clause.
  _ghostSweep(dt) {
    for (const p of this._ghosts) {
      if (!p.car) { this._ghosts.delete(p); continue; }   // stolen, or hard-capped away
      p.ghostT += dt;
      if (p.ghostT > GHOST_MAX || !this._heldVisible(p)) {
        this._detach(p);
        this._ghosts.delete(p);
      }
    }
  }

  // world pose of the SCHEDULE (no lag, no lane offset) — used to decide
  // whether a car is close enough to deserve a mesh, and to place it on birth.
  _nomPose(p, T) {
    const arc = this._nomArc(p, T);
    let i = p.ni;
    while (i > 0 && arc < p.route[i].base) i--;
    while (i + 1 < p.route.length && arc >= p.route[i + 1].base) i++;
    const st = p.route[i];
    const s = Math.max(0, Math.min(st.e.len, arc - st.base));
    return poseAt(st.e, s, 0);
  }

  _attach(p, wt, pose) {
    const e0 = p.route[0].e;
    // paint must be the same on both screens. vehicles.pickCarColor() reaches
    // for Math.random and does not take a seed; rather than reimplement its
    // per-kind bias table (which lives in vehicles.js and is not ours to fork)
    // we lend it a deterministic draw for exactly one synchronous call.
    // REQUEST to the owner of vehicles.js: `pickCarColor(kind, r)` taking an
    // optional 0..1, and this hack disappears.
    let kind = null, color = 0;
    if (!p.police) {
      const bigOk = e0.speed >= FAST_EDGE && rnd01(hash32(p.seed, 5)) < BIG_CHANCE;
      const pool = bigOk ? BIG : COMMON;
      kind = pool[(rnd01(hash32(p.seed, 6)) * pool.length) | 0];
      if (!VEH.CAR_KINDS.includes(kind)) kind = VEH.CAR_KINDS[0]; // roster drift guard
      const u = rnd01(hash32(p.seed, 8));
      if (typeof VEH.pickCarColor === 'function') {
        const real = Math.random;
        try { Math.random = () => u; color = VEH.pickCarColor(kind); }
        finally { Math.random = real; }
      } else {
        color = CAR_COLORS[(u * CAR_COLORS.length) | 0];
      }
    }
    this._setRendered(p, this._nomArc(p, wt));
    const e = p.edge;
    const heading = Math.atan2(-pose.dx, -pose.dz);
    p.laneOff = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    p.sh = p.ph = heading;
    p.sx = p.px = pose.x - pose.dz * p.laneOff;   // right of travel = (-dz, dx)
    p.sz = p.pz = pose.z + pose.dx * p.laneOff;
    // LAYER_Y.road is the thickness of the asphalt over the GROUND, not a
    // height above the sea. The AI drives its cars by writing this pose
    // directly (it never goes through driveStep), so it is the one place that
    // has to add the terrain itself — without it the whole city's traffic
    // drove 220 m under Pardubice, invisible but perfectly well behaved.
    // …and the embankment the road is BUILT on, or the AI drives in the ditch
    // beside a road the player is riding over the top of
    const gnd = this._groundAt(p.sx, p.sz);
    const bridgeY = e.road.br
      ? bridgeDeckHeight(e.road, e.off0 + e.offSign * p.s, this.world?.terrain)
      : (roadGradeY(e.road, e.off0 + e.offSign * p.s, this.world?.terrain) ?? gnd);
    p.sy = p.py = bridgeY + LAYER_Y.road;
    const car = p.police ? this._buildPatrol(p.sx, p.sz, heading)
      : this.vehicles.add(kind, p.sx, p.sz, heading, color);
    car.vK = p.vK;
    car.speed = this._nomV(p);
    car.ai = p;
    car.y = p.sy;
    car.mesh.position.set(p.sx, p.sy, p.sz);
    car.mesh.rotation.y = heading;
    p.car = car;
    this.cars.add(car);
    if (p.police) this.patrols.add(car);
  }

  // The one place in the program that knows what a police car looks like, so
  // that an ambient patrol and a pursuit unit js/police.js spawns for itself
  // cannot end up looking like two different forces. See PATROL_PAINT for why
  // this is an octavia and not a roster entry of its own.
  _buildPatrol(x, z, heading) {
    const kind = VEH.CAR_KINDS.includes(PATROL_KIND) ? PATROL_KIND : VEH.CAR_KINDS[0];
    const car = this.vehicles.add(kind, x, z, heading, PATROL_PAINT);
    car.police = true;
    // A policista does not lean out of the window and shout at the traffic.
    // js/chatter.js picks its driver-shout candidates by `car._shoutAt` being
    // in the past (it is a deadline, not a countdown — see chatter's _cool),
    // so a deadline that never arrives takes this car out of that pool without
    // chatter needing to know the police exist.
    car._shoutAt = Infinity;
    this._fitLightBar(car);
    return car;
  }

  // Bolt the bar and the livery on. Silently does nothing when the car's mesh
  // is not a real THREE.Object3D — the headless fixtures hand back a plain
  // object with a stub .position, and a patrol without a bar is exactly as
  // testable as one with it. Nothing below this line runs headless, which is
  // also what keeps copAssets' canvas out of `node --test`.
  _fitLightBar(car) {
    const m = car.mesh;
    if (!m || typeof m.add !== 'function') return;
    const A = copAssets();
    const g = new THREE.Group();
    const base = new THREE.Mesh(A.bar, A.barMat);
    const l = new THREE.Mesh(A.lamp, A.off), r = new THREE.Mesh(A.lamp, A.off);
    const lampY = BAR_Y + BAR_H + LAMP_H / 2 - 0.004;   // standing on the plinth
    l.position.set(-LAMP_X, lampY, BAR_Z);
    r.position.set(LAMP_X, lampY, BAR_Z);
    // The stripe is PAINT, so it must not cast: a band 1.6 cm proud of the
    // panel casting onto the panel it covers is shadow acne with extra steps,
    // and the shadow would be hidden by the thing that cast it anyway. It does
    // receive, so a bridge's shade crosses the blue exactly as it crosses the
    // white either side of it.
    const livery = new THREE.Mesh(A.livery, A.liveryMat);
    livery.receiveShadow = true;
    // vehicles.add() has already run its castShadow traverse by the time we get
    // here, so the bar has to arrange its own shadow or it floats.
    base.castShadow = l.castShadow = r.castShadow = true;
    base.updateMatrix(); base.matrixAutoUpdate = false;
    l.updateMatrix(); l.matrixAutoUpdate = false;
    r.updateMatrix(); r.matrixAutoUpdate = false;
    livery.updateMatrix(); livery.matrixAutoUpdate = false;
    g.add(base, l, r, livery);
    g.updateMatrix(); g.matrixAutoUpdate = false;   // the CAR moves; the bar never moves on it
    // …but the SHELL moves on the car, and that is a different parent. The
    // group used to hang off car.mesh, whose origin is on the road; vehicles.js
    // puts every panel inside userData.body and then rolls it up to 0.05 rad in
    // a corner, pitches it under braking, and drops it 20 cm on a wreck. On
    // car.mesh a livery 1.6 cm proud of the flank sinks into the door on one
    // side of every corner and floats 3 cm off it on the other, and a written-
    // off patrol wears its stripe at window height. Parented to the shell, the
    // static local matrix above is still exactly right — three multiplies it by
    // whatever the body is doing this frame — so matrixAutoUpdate stays off and
    // the bar stops sliding off a rolling roof into the bargain. Falls back to
    // the mesh itself for any car that has no shell to hang on.
    const shell = m.userData?.body;
    (shell && typeof shell.add === 'function' ? shell : m).add(g);
    car._cop = { l, r, st: 0 };
  }

  _detach(p) {
    if (!p.car) return;
    this.cars.delete(p.car);
    this.patrols.delete(p.car);
    this._sirens.delete(p.car);
    this.vehicles.remove(p.car);
    p.car.ai = null;
    p.car = null;
  }

  // Drop the schedule entirely. The slot stays empty until the generation
  // flips or the cell comes back into range, at which point _birth mints the
  // identical car again from the same hash — re-entering a street you left
  // does not reshuffle its traffic.
  _reap(p) {
    this._detach(p);
    if (p.ghost) this._ghosts.delete(p);
    this._pool.delete(p.key);
  }

  // ---- per-frame ----

  // A frame does three things and only the middle one is simulation:
  //   1. bookkeeping on SHARED time (lights, the candidate sweep),
  //   2. zero or more FIXED steps of the reactive layer, on a grid anchored to
  //      shared time so 30 fps and 144 fps produce the same answer,
  //   3. interpolate the two most recent steps into the meshes.
  //
  // ON THE SNAP CHANNEL, since the brief asked for a number: we do not need
  // one. A corrective snapshot of the cars within 300 m of a player is ~40
  // vehicles × (2 B slot id + 3 B arc + 1 B speed) ≈ 240 B, at 4 Hz ≈ 1 kB/s
  // per player, and it would buy nothing — the schedule already IS the
  // authority, it costs no bandwidth at all, and the only quantity a snapshot
  // could correct (the lag) is exactly the quantity that is legitimately
  // different on the two clients because their players are in different
  // places. If a future need appears, the hooks are `p.key` (a stable string
  // id) and `p.sR` (one float), and nothing else has to travel.
  // `viewer` is optional and simply forwarded to setViewer() — pass it here or
  // call setViewer() yourself, whichever suits the caller. Passing `undefined`
  // (i.e. calling update with three arguments, as every v8 caller does) leaves
  // whatever viewer was last set alone; passing `null` clears it.
  update(dt, playerPos, playerCar, viewer) {
    if (viewer !== undefined) this.setViewer(viewer);
    this._t = (this._t ?? 0) + dt;      // monotonic seconds, for _heldVisible
    if (!this.edges.length || !playerPos) return;
    const wt = this._wt = this.now();
    if (this._junctions.length) this._tickSignals(wt);
    if (this._sirens.size) this._tickSirens(wt);

    const px = this._px = playerPos.x, pz = this._pz = playerPos.z;
    // Density knob, quantised to 1/32 so two clients standing together, whose eased density
    // knobs differ by a percent or two, still land on the same number and
    // therefore the same fleet. REQUEST to main.js: pass
    // `base * trafficTimeK(tod())` and DROP trafficPlaceK — how built-up a
    // place is now comes out of the road length per cell, which is a property
    // of the world rather than of whoever is standing in it, and while a
    // per-player place factor is in the product two players in genuinely
    // different surroundings will scale the shared world differently.
    // The ceiling was 3 and it was WRONG, measurably. settings.traffic is 240
    // on both medium and high, and trafficTimeK peaks at 1.15 (08:00) and 1.45
    // (16:00) — raw 3.07 and 3.87, both of which used to land on the same 3.
    // The whole rush-hour curve above ~2.8 was a flat line: measured 65.8 cars
    // at 08:00 and 65.8 at 16:00, and 62.0 at midday, when the settings ask for
    // 192 / 276 / 348. 4 clears the top of the product's range (240 × 1.45).
    const raw = (this.maxCars ?? TRAFFIC.maxCars) / (TRAFFIC.maxCars || 1);
    this._densK = Math.max(0, Math.min(4, Math.round(raw * 32) / 32));

    this._scanT -= dt;
    if (this._scanT <= 0) {
      const since = SCAN_DT - this._scanT;      // wall time this sweep covers
      this._scanT = SCAN_DT;
      // ORDER MATTERS. Sweep first: a slot whose generation just rolled over is
      // released (or ghosted) here, and _scanCells immediately behind mints the
      // next generation into the same slot in the same tick. The shared fleet
      // therefore never has a hole, whatever the local deferral decided.
      this._sweepPool(wt, px, pz);
      this._scanCells(wt, px, pz);
      if (this._ghosts.size) this._ghostSweep(since);
    }
    // distant pole meshes stop rendering entirely — cheap, and unrelated to
    // the simulation, so it rides its own lazy timer
    this._cullT -= dt;
    if (this._cullT <= 0) {
      this._cullT = 2.0;
      for (const jn of this._junctions) {
        const dx = jn.x - px, dz = jn.z - pz;
        jn.group.visible = dx * dx + dz * dz < SIG_VIS2;
      }
    }
    // hard cap as a SAFETY VALVE only. With matching settings the cell budget
    // already lands near maxCars, so this should never bind; when it does (a
    // freak stretch of six-lane interchange, or a settings change mid-drive)
    // it thins farthest-first, and THAT is a divergence — the two clients trim
    // different cars because "farthest" is measured from different players.
    // Kept because a 400-car frame is worse than a cosmetic disagreement.
    const max = this.maxCars ?? TRAFFIC.maxCars;
    for (let k = 0; k < 2 && this.cars.size > max + 8; k++) {
      let worst = null, wd = -1;
      for (const car of this.cars) {
        const p = car.ai;
        if (!p) continue;
        // v9: the valve may not be the thing that pops a car in your face.
        // Visible cars are simply not candidates; if the whole overflow is
        // visible we leave the fleet over budget for a moment rather than
        // delete something from the middle of the screen.
        //
        // v10: NEITHER MAY IT BE THE THING THAT ENDS A CHASE. The valve trims
        // FARTHEST-FIRST, and the whole point of a pursuit is that the unit
        // chasing you is the one that just went round the block and is a
        // street away rather than on your bumper — i.e. by construction the
        // farthest police car is the interesting one, and it is the only car
        // in the fleet whose deletion the player would read as the game
        // cheating rather than as scenery thinning out. There are at most a
        // handful of patrols inside the ring (see PATROL_P), so exempting
        // them costs the valve a rounding error of its budget.
        if (p.police || this._heldVisible(p)) continue;
        const d = (car.x - px) ** 2 + (car.z - pz) ** 2;
        if (d > wd) { wd = d; worst = car; }
      }
      if (!worst) break;
      const p = worst.ai;
      this._detach(p);
      if (p.ghost) this._ghosts.delete(p);
    }

    // obstacle list: every player in the room if main.js provides one (see
    // this.actors), else just ours. Cars brake for these at any orientation —
    // parked across the road IS a wall.
    this._obst.length = 0;
    if (this.actors && this.actors.length) {
      for (const a of this.actors)
        if (Number.isFinite(a?.x) && Number.isFinite(a?.z))
          this._obst.push(a.x, a.z, a.half ?? 3.9);
    } else {
      this._obst.push(playerCar ? playerCar.x : playerPos.x,
        playerCar ? playerCar.z : playerPos.z, playerCar ? 3.9 : 2.3);
    }
    // …and every parked hull main.js reports (the player's abandoned car
    // included). Same wall rule as players: a car standing on the lane stops
    // the queue, whoever left it there.
    if (this.blockers) {
      for (const b of this.blockers)
        if (Number.isFinite(b?.x) && Number.isFinite(b?.z))
          this._obst.push(b.x, b.z, b.half ?? 2.6);
    }

    // ---- fixed steps on a SHARED grid ----
    const grid = Math.floor(wt / SIM_DT) * SIM_DT;
    let n = Math.round((grid - this._simT) / SIM_DT);
    if (!(n >= 0)) { this._simT = grid; n = 0; }             // clock stepped back
    if (n > SIM_MAX_STEPS) { this._simT = grid - SIM_MAX_STEPS * SIM_DT; n = SIM_MAX_STEPS; }
    for (let i = 0; i < n; i++) {
      this._simT += SIM_DT;
      this._step(SIM_DT, this._simT);
    }
    // ---- render: interpolate between the last two steps ----
    const alpha = Math.max(0, Math.min(1, (wt - this._simT) / SIM_DT));
    for (const car of this.cars) {
      const p = car.ai;
      if (!p) continue;
      car.x = p.px + (p.sx - p.px) * alpha;
      car.z = p.pz + (p.sz - p.pz) * alpha;
      car.y = p.py + (p.sy - p.py) * alpha;
      car.heading = angWrap(p.ph + angWrap(p.sh - p.ph) * alpha);
      car.mesh.position.set(car.x, car.y, car.z);
      car.mesh.rotation.y = car.heading;
    }
  }

  _step(dt, T) {
    this._hornPool = Math.min(HONK_POOL, this._hornPool + HONK_RATE * dt);
    for (const car of this.cars) {
      const p = car.ai;
      if (!p) continue;
      p.px = p.sx; p.pz = p.sz; p.py = p.sy; p.ph = p.sh;
      this._drive(p, dt, T);
    }
  }

  // main calls this when the player yanks a door open: the car keeps its mesh
  // and state, we just stop driving it. The slot is burned for this generation
  // — the schedule keeps existing (so the slot is not refilled behind the
  // player's back) but never gets its mesh back.
  // REQUEST to the net layer: broadcast `slotKey(car)` on a steal so the other
  // client can call `claimSlot(key)`; otherwise the peer keeps driving a
  // phantom copy of the car you just took.
  steal(car) {
    const p = car.ai;
    this.cars.delete(car);
    // …including out of `patrols`, which promises to list the patrols TRAFFIC
    // drives. `car.police` and the bar stay on the car — whoever took it is
    // driving a police car, and js/police.js's own unit list is its business,
    // not ours. This is also how a player steals a patrol car and keeps the
    // lights: setSiren() never asked for a schedule.
    this.patrols.delete(car);
    car.ai = null;
    if (p) { p.stolen = 1; p.car = null; if (p.ghost) this._ghosts.delete(p); }
    return car;
  }

  // null for a GHOST on purpose. A ghost has no slot any more — on the peer's
  // machine that string already names the next generation's car — so there is
  // nothing for him to claim and broadcasting the key would make him delete a
  // perfectly good car of his own.
  slotKey(car) {
    const p = car?.ai;
    return (!p || p.ghost) ? null : p.key;
  }

  // A peer took this car. Kill our copy and hold the slot empty for the rest
  // of the generation. Works even if we never built the schedule (the peer may
  // be a street ahead of our streaming frontier) — the tombstone carries the
  // slot's real cell/index so the generation rollover reaps it on time.
  claimSlot(key) {
    const p = this._pool.get(key);
    if (p) { this._detach(p); p.stolen = 1; return; }
    // the third group takes a SIGN because of the patrol slot: POLICE_K is -1
    // and a tombstone that would not parse is a peer quietly driving a police
    // car we also keep a copy of — the exact ghosting the tombstone exists to
    // prevent, and the one car in the fleet where two of them is a bug the
    // player is guaranteed to notice.
    const m = /^(-?\d+),(-?\d+)\/(-?\d+)$/.exec(String(key));
    if (!m) return;
    const ci = +m[1], cj = +m[2], k = +m[3];
    const ss = hash32(WORLD_SEED, ci, cj, k);
    const wt = this._wt || this.now();
    const gen = Math.floor((wt + rnd01(hash32(ss, 7)) * TRIP_T) / TRIP_T);
    this._pool.set(key, { key, ci, cj, k, gen, cell: null, stolen: 1, car: null, route: null,
      police: k === POLICE_K ? 1 : 0 });
  }

  // A rammed car (vehicles.js stamped _rammedT on impact) is momentum, not
  // brain: the collision impulse already rewrote its speed and yawed it, so we
  // just let it slide along wherever it now points, scrubbing RAM_FRICTION of
  // speed per second, until the timer runs out — then snap back to the rail.
  // Being rammed is by definition a local event (only one client's player did
  // the ramming), so this is pure lag: the schedule keeps rolling, the wreck
  // falls behind, and the catch-up term walks it back into agreement once it
  // is driving again.
  _rammedStep(p, dt) {
    const car = p.car;
    // vehicles.js wrote the impulse straight onto car.speed and car.heading;
    // adopt the yaw as-is (no interpolation for the 2.5 s of the shunt — the
    // impulse can turn the car faster than a lerp between two 20 Hz poses
    // would ever show) and keep integrating position from it.
    p.sh = p.ph = car.heading;
    // getting rammed is the one honk that doesn't wait 2.5 s — but it still
    // draws the global budget, so a pile-up gets a couple of blasts, not a
    // brass section, and the ram spends the personal cooldown too
    if (!car._hornRam) {
      car._hornRam = 1;
      if (this._hornPool >= 1) {
        this._hornPool -= 1;
        car._hornCd = HONK_CD_MIN + rnd01(hash32(p.seed, 9)) * HONK_CD_VAR;
        horn(car.x, car.z);
        this.onHonk?.(car.x, car.z);
      }
    }
    car._rammedT -= dt;
    const s = car.speed;
    car.speed = s > 0 ? Math.max(0, s - RAM_FRICTION * dt) : Math.min(0, s + RAM_FRICTION * dt);
    p.sx += -Math.sin(p.sh) * car.speed * dt;
    p.sz += -Math.cos(p.sh) * car.speed * dt;
    if (car._rammedT > 0) return;
    // recovery: nearest point of the car's OWN edge — the shove rarely moves a
    // car more than a lane over, so its old rail is the right one. The arc it
    // lands on becomes the new rendered position; the lag against the schedule
    // is whatever the shunt cost, and the normal drive step eases position and
    // heading back over the next second.
    const e = p.edge, pts = e.pts;
    let bestD = 1e9, bestS = p.s, bestSeg = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const d = distPointToSegment(p.sx, p.sz, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], _snap);
      if (d < bestD) { bestD = d; bestSeg = i; bestS = e.cum[i] + _snap.t * (e.cum[i + 1] - e.cum[i]); }
    }
    p.seg = bestSeg;
    this._setRendered(p, p.route[p.ri].base + bestS);
    car.speed = Math.max(0, car.speed);           // rails only run forward
    car._hornRam = 0;                             // next ram may honk again
  }

  // A ghost about to run out of itinerary gets another leg. This is the piece
  // that makes "let it drive out of sight" actually terminate: without it a
  // ghost created near the end of its trip would stop at the kerb 30 m in
  // front of the player, still visible, and sit there until GHOST_MAX gave up
  // and popped it — which is the artefact we are here to remove. The picks
  // come from the same deterministic chooser the schedule uses, seeded past
  // the shared range, purely so a ghost drives like a car rather than like a
  // random walk; nothing about it needs to agree with anybody else.
  _ghostExtend(p) {
    if (!p.route) return;
    const was = p.routeEnd;
    p.routeM = Math.max(p.routeM, p.sR + GHOST_LEG);
    // MAX_SAFE_INTEGER, not a step count: _routeEnsure's real terminator is
    // "the itinerary now covers routeM" (or a dead end), and it is the branch
    // that writes routeEnd. Asking for a step number instead would push one
    // leg and leave routeEnd stale.
    this._routeEnsure(p, Number.MAX_SAFE_INTEGER);
    if (p.routeEnd > was + 0.5) { p.ndone = 0; p.nwait = 0; }
    // a dead end cannot be extended: routeEnd stays put, the ghost coasts to a
    // stop there, and GHOST_MAX eventually collects it
  }

  // Place the rendered car at route arc `arc`: find the step it falls in and
  // publish (edge, s, seg, next) for the driving code, which is otherwise
  // unchanged from v7 and still thinks in terms of one edge at a time.
  _setRendered(p, arc) {
    if (!(arc >= 0)) arc = 0;
    if (arc > p.routeEnd) arc = p.routeEnd;
    p.sR = arc;
    let i = p.ri ?? 0;
    while (i > 0 && arc < p.route[i].base) i--;
    while (i + 1 < p.route.length && arc >= p.route[i + 1].base) i++;
    if (i !== p.ri) { p.ri = i; p.seg = 0; }
    const st = p.route[i];
    p.edge = st.e;
    p.s = Math.max(0, Math.min(st.e.len, arc - st.base));
    p.next = p.route[i + 1] ? p.route[i + 1].e : null;
  }

  _drive(p, dt, T) {
    const car = p.car;
    if (!car) return;
    if (car._rammedT > 0) { this._rammedStep(p, dt); return; } // AI suspended

    // A GHOST has no schedule any more (the slot belongs to the next
    // generation), so there is nothing to clamp against and nothing to catch
    // up to: it just drives, and when its itinerary runs out we lengthen it.
    // Free-running is still frame-rate independent — this is the same fixed
    // step every other car takes — it is simply not SHARED, which is exactly
    // what a ghost is.
    let Snom = Infinity, lag = 0;
    if (p.ghost) {
      if (p.sR > p.routeEnd - 60) this._ghostExtend(p);
      Snom = p.routeEnd;
    } else {
      this._nomTo(p, T);
      Snom = this._nomArc(p, T);
      lag = Snom - p.sR;
    }
    const e = p.edge;

    // ---- target speed: this DRIVER's desire (limit × vK), corners ahead, the
    // junction, the car in front. Unchanged from v7 in shape — the schedule
    // uses the same corner model, so the two agree to within the accel ramp
    // and the lag stays small. Curve/turn limits use the braking envelope
    // v² = vc² + 2·b·d, so speed bleeds off smoothly on approach instead of at
    // the apex. On a straight edge nothing here fires — vertAng sits under the
    // 0.06 rad noise floor — so steady speed genuinely reaches desire.
    const desire = e.speed * p.vK;
    // the ONE new term: a car behind its schedule may exceed its desire by
    // CATCH_K to close the gap, and a car that is not behind may not. The hard
    // clamp below is what actually forbids running ahead; this only sets how
    // briskly the gap shuts.
    let catchK = 1;
    if (lag > 0.5) {
      catchK = CATCH_K;
      let near = false;
      for (let i = 0; i < this._obst.length && !near; i += 3)
        near = dist(this._obst[i] - p.sx, this._obst[i + 1] - p.sz) < LAG_FREE_R;
      if (!near) catchK = CATCH_FAR;
    }
    let tgt = desire * catchK;
    // the envelope's reach must scale with speed: 16 m of lookahead is a city
    // number, a 90 km/h driver needs v²/2b (~62 m) of warning or every rural
    // bend becomes an emergency stop
    const look = Math.max(CORNER_LOOK, car.speed * car.speed / (2 * BRAKE) + 6);
    for (let k = p.seg + 1; k <= p.seg + 8 && k < e.pts.length - 1; k++) {
      const d = e.cum[k] - p.s;
      if (d > look) break;
      if (d < 0) continue;
      const a = e.vertAng[k];
      if (a > 0.06) tgt = Math.min(tgt, Math.sqrt(cornerSpeed(a) ** 2 + 2 * BRAKE * d));
    }
    const dEnd = e.len - p.s;
    if (dEnd < look + 10) {
      let ang = Math.PI;                          // dead end → crawl into the U-turn
      if (p.next) {
        const dot = e.ldx * p.next.fdx + e.ldz * p.next.fdz;
        const crs = e.ldx * p.next.fdz - e.ldz * p.next.fdx;
        ang = Math.abs(Math.atan2(crs, dot));
      }
      if (ang > 0.06)
        tgt = Math.min(tgt, Math.sqrt(cornerSpeed(ang) ** 2 + 2 * BRAKE * Math.max(dEnd, 0)));
      // slower road ahead: aim at ITS desire by the handoff, so nobody blasts
      // into a village at 110 and stands on the brakes between the houses
      if (p.next && p.next.speed < e.speed)
        tgt = Math.min(tgt, Math.sqrt((p.next.speed * p.vK) ** 2 + 2 * BRAKE * Math.max(dEnd, 0)));
    }

    // ---- traffic lights are the SCHEDULE's job, not this layer's.
    // v7 tested the phase here and braked for it; doing that on top of a
    // schedule that already stopped for the same light is the one change that
    // measurably broke the shared world. A car a couple of metres behind its
    // schedule arrives at the stop line a fraction of a second later, and if
    // the light flipped in that fraction, this layer would hold it for a whole
    // 25 s cycle while the schedule drove on — 300 m of lag out of a 2 m
    // disagreement, clamped at LAG_MAX and then dragged through the red
    // anyway. The clamp against Snom stops the car at the line all by itself,
    // because the schedule is stopped there. Queues form behind it through the
    // ordinary follow rule.
    // `sigHeld` survives only to keep the horn quiet: you honk at the idiot
    // ignoring a green, not at the light.
    const sigHeld = p.nwait > 0;

    // ---- follow whatever is ahead in our corridor. AI-AI additionally wants
    // similar heading (±35°) so the opposite lane doesn't gridlock us; players
    // block at ANY orientation. `held` marks the frames where a LEADER is the
    // binding constraint — the honk logic keys off it, so corners and lights
    // never get honked at. Positions read here are the FIXED-STEP poses, not
    // the interpolated render ones: the simulation must not depend on when the
    // frame happened to land.
    const fx = -Math.sin(p.sh), fz = -Math.cos(p.sh);
    let hard = false, held = false, leader = null, leadD = 1e9;
    // …and whether a PHYSICAL hull is in the way, which is a different thing
    // from being held by flow: flow resolves itself, a parked car does not.
    let blocked = false;
    for (const other of this.cars) {
      const o = other.ai;
      if (!o || o === p) continue;
      const rx = o.sx - p.sx, rz = o.sz - p.sz;
      const fwd = rx * fx + rz * fz;
      if (fwd <= 0 || fwd > TRAFFIC.lookAhead) continue;
      const lat = fx * rz - fz * rx;
      if (Math.abs(lat) > LAT_GATE || Math.abs(angWrap(o.sh - p.sh)) > HEAD_GATE) {
        // Not a leader — but possibly a collision. Only pairs the follow model
        // has ALREADY discarded reach here, so the two rules never fight.
        const d2 = rx * rx + rz * rz;
        const reach = CROSS_R0 + Math.max(car.speed, other.speed) * CROSS_RV;
        if (d2 < reach * reach) {
          const ofx = -Math.sin(o.sh), ofz = -Math.cos(o.sh);
          const vs = car.speed, vo = other.speed;
          const px = p.sx + fx * vs * CROSS_T, pz = p.sz + fz * vs * CROSS_T;
          const qx = o.sx + ofx * vo * CROSS_T, qz = o.sz + ofz * vo * CROSS_T;
          if ((px - qx) ** 2 + (pz - qz) ** 2 < CROSS_CLEAR * CROSS_CLEAR) {
            // Give way to the right — but "to the right" is not antisymmetric
            // between two cars on different headings, and both reading the
            // other as being on their LEFT is exactly the case where neither
            // yields and they drive through each other. So each car also works
            // out where IT sits in the other's frame, and yields unless the
            // other one is going to. Ties yield on both sides: two cars both
            // stopping is a moment of hesitation, two cars both continuing is
            // the bug.
            const olat = ofx * -rz - ofz * -rx;
            if (lat > 0 || olat <= 0) { tgt = 0; hard = true; held = true; }
          }
        }
        continue;
      }
      const gap = fwd - 3.9;                      // center distance → bumpers
      if (fwd < leadD) { leadD = fwd; leader = o; }
      if (gap < TRAFFIC.stopGap) { tgt = 0; hard = true; held = true; }
      else { const fv = (gap - TRAFFIC.stopGap) / 2;         // gap/2s rule
             if (fv < tgt) { tgt = fv; held = true; } }
    }
    for (let i = 0; i < this._obst.length; i += 3) {
      const rx = this._obst[i] - p.sx, rz = this._obst[i + 1] - p.sz;
      const fwd = rx * fx + rz * fz;
      if (fwd <= 0 || fwd > TRAFFIC.lookAhead) continue;
      if (Math.abs(fx * rz - fz * rx) > LAT_GATE) continue;
      const gap = fwd - this._obst[i + 2];
      if (gap < TRAFFIC.stopGap) { tgt = 0; hard = true; held = true; blocked = true; }
      else { const fv = (gap - TRAFFIC.stopGap) / 2;
             if (fv < tgt) { tgt = fv; held = true; } }
    }

    // ---- the horn. A driver pinned under 30 % of what they WANT to do, for
    // long enough that it's clearly not just flow (2.5 s), by whoever is ahead
    // — the player, mostly — leans on it. Personal 6–16 s cooldown so no one
    // machine-guns, the global pool caps the whole city at ~2/s, red lights
    // are exempt (sigHeld — you honk at the idiot ignoring a green, not at the
    // light), and the honk budget being global, only cars near enough to
    // be plausibly audible fire it. Deliberately NOT deterministic across
    // clients: a horn is a reaction to a local player and there is no reason
    // for two people to hear the same one.
    car._hornCd = (car._hornCd || 0) - dt;
    // Patience propagates down a queue: the first car at a red is sigHeld, and
    // everyone pinned behind a car that is itself waiting for a reason inherits
    // that reason (_sigQ, one frame late — good enough).
    p.sigQ = sigHeld || (leader ? !!leader.sigQ : false);
    if (held && !p.sigQ && car.speed < desire * HONK_FRAC) p.heldT += dt;
    else p.heldT = 0;
    if (p.heldT > HONK_HELD && car._hornCd <= 0 && this._hornPool >= 1 &&
        dist(p.sx - this._px, p.sz - this._pz) < HONK_R) {
      this._hornPool -= 1;
      car._hornCd = HONK_CD_MIN + Math.random() * HONK_CD_VAR;
      p.heldT = 0;                                // re-arm: the next honk waits its 2.5 s again
      horn(p.sx, p.sz);
      this.onHonk?.(p.sx, p.sz);
    }

    // ---- integrate speed, advance along the rail, then CLAMP against the
    // schedule. The clamp is the entire multiplayer contract in three lines:
    //   · never ahead of the schedule (so a client cannot invent progress),
    //   · never more than LAG_MAX behind (past that we admit disagreement
    //     rather than let a car drift half a block out of the shared world),
    //   · when pinned at the schedule, adopt the schedule's own speed, so the
    //     wheels and the engine hum match what the car is actually doing.
    if (car.speed < tgt) car.speed = Math.min(tgt, car.speed + ACCEL * dt);
    else car.speed = Math.max(tgt, car.speed - (hard ? BRAKE_HARD : BRAKE_SOFT) * dt);
    let arc = p.sR + car.speed * dt;
    if (arc >= Snom) { arc = Snom; const nv = p.ghost ? 0 : this._nomV(p); if (car.speed > nv) car.speed = nv; }
    if (!p.ghost && arc < Snom - LAG_MAX) {
      // Dragged forward against the brakes: this car has fallen so far behind
      // the shared schedule that the two clients would draw it a block apart.
      //
      // But NOT through a hull. That is what this used to do — eleven seconds
      // after you left your car in the lane, the queue behind it was hauled
      // forward and drove straight through, which is the whole "auta stále
      // projíždějí jako ghosts mým autem" report. A car physically stopped by
      // something solid LEAVES the shared population instead: it becomes a
      // local ghost, keeps its nose against the obstruction like a real
      // driver, and the sweeper retires it once nobody is looking. Desync is
      // the honest answer here — the obstruction is local to this client.
      if (blocked) {
        if (!p.ghost) { p.ghost = 1; p.ghostT = 0; this._ghosts.add(p); }
      } else {
        arc = Snom - LAG_MAX;
        car.speed = Math.max(car.speed, (arc - p.sR) / dt);
      }
    }
    this._setRendered(p, arc);

    // ---- arrival. The schedule ran out of route; the car finishes whatever
    // lag it still owes, then stands there, and is marked done. `dead` is only
    // a REQUEST to the sweep — _retire() decides what actually happens to the
    // mesh, and if the player is watching, the answer is "it drives off as a
    // ghost", not "it blinks out". RETIRE_R survives as the no-camera
    // fallback: without a viewer _visible() is false for everything, so this
    // is the only thing standing between a v8 caller and a car evaporating in
    // its own mirror. RETIRE_GRACE is what stops a finished car standing at
    // the kerb for ever when nobody is near enough for RETIRE_R to matter.
    if (!p.ghost && p.ndone && p.sR >= p.routeEnd - 0.05) {
      p.graceT += dt;
      if (p.graceT > RETIRE_GRACE ||
          dist(p.sx - this._px, p.sz - this._pz) > RETIRE_R) p.dead = 1;
    }

    // ---- pose: centerline point + smoothed heading + right-lane offset
    const re = p.edge;
    const pose = poseAt(re, p.s, p.seg);
    p.seg = pose.seg;
    const targetH = Math.atan2(-pose.dx, -pose.dz);
    // exponential smoothing kills the heading snap at polyline corners and at
    // edge handoffs; wrap keeps the -π/π seam from spinning the car around
    p.sh = angWrap(p.sh + angWrap(targetH - p.sh) * Math.min(1, TURN_RATE * dt));
    // the lane offset rides on the SMOOTHED heading, so through a corner the
    // car sweeps across its lane instead of teleporting at each vertex; the
    // magnitude eases too because road width changes between edges
    const offTgt = Math.min(TRAFFIC.laneOffsetK * re.road.w, TRAFFIC.laneOffsetMax);
    p.laneOff += (offTgt - p.laneOff) * Math.min(1, 3 * dt);
    const hx = -Math.sin(p.sh), hz = -Math.cos(p.sh);
    p.sx = pose.x - hz * p.laneOff;               // right of heading = (-hz, hx)
    p.sz = pose.z + hx * p.laneOff;
    // off0 + offSign·s = meters from the WAY start (not the edge), which is
    // what the shared ramp math wants — decks rise only near the way's ends.
    const gnd2 = this._groundAt(p.sx, p.sz);
    const bridgeY = re.road.br
      ? bridgeDeckHeight(re.road, re.off0 + re.offSign * p.s, this.world?.terrain)
      : (roadGradeY(re.road, re.off0 + re.offSign * p.s, this.world?.terrain) ?? gnd2);
    p.sy = bridgeY + LAYER_Y.road;
  }

  /** Ground under a point. 0 for the bare {roads:[…]} fixtures the tests use. */
  _groundAt(x, z) { return this.world?.terrain?.heightAt(x, z) ?? 0; }

  // Poles freeze their matrix (hundreds of static meshes render for free that
  // way), so re-seating one means writing position.y AND updating the matrix
  // by hand — a plain assignment would move nothing on screen.
  _regroundSignals() {
    for (const jn of this._junctions) {
      for (const s of jn.sigs) {
        const m = s.mesh;
        if (!m) continue;
        const y = this._groundAt(m.position.x, m.position.z);
        if (Math.abs(y - m.position.y) > 0.05) { m.position.y = y; m.updateMatrix(); }
      }
    }
  }

  // ---- diagnostics / test seams ------------------------------------------

  // Everything the shared world claims about the cars near (x, z) right now,
  // independent of whether they have meshes. Two clients calling this with the
  // same shared time must get the same list — that is the property the tests
  // in tests/traffic-shared.test.mjs pin down.
  // NOTE: reads the clock, not the last simulated frame, and advancing a
  // schedule is a mutation — two clients must call this at the same shared
  // instant or they are comparing different moments, not different worlds.
  snapshot(x, z, r = TRAFFIC.spawnR) {
    const wt = this.now();
    const out = [];
    for (const p of this._pool.values()) {
      if (p.stolen || !p.route) continue;
      this._nomTo(p, wt);
      const pose = this._nomPose(p, wt);
      if (!pose) continue;
      const dx = pose.x - x, dz = pose.z - z;
      if (dx * dx + dz * dz > r * r) continue;
      out.push({ key: p.key, gen: p.gen, seed: p.seed, vK: p.vK, police: !!p.police,
        arc: this._nomArc(p, wt), x: pose.x, z: pose.z, done: !!p.ndone });
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }
}
