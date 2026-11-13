// ==========================================================================
// Pedestrians v2 — the crowd is a property of the CITY, not of the camera
//
// WHAT WAS WRONG. The user's words: "i chodci se tak ruzně spawnují a je v tom
// bordel". Measured on the real region, driving at 50 km/h: 152 spawns per
// minute, 53 of them inside the forward ±60° cone, 111 of them closer than
// 50 metres. The old rule was `if (d < 18 || d > SPAWN_R) return false` with
// SPAWN_R = 110 — i.e. a citizen was allowed to materialise anywhere from the
// other side of the street outwards, in full view, at full fog opacity (the
// day fog does not even begin to bite until 127 m). On top of that the
// population never held while moving: 34 walkers decayed to 25 because the
// spawner threw 40 darts every 0.4 s at a shortlist rebuilt around the LOCAL
// player and hit with them 4–11 % of the time.
//
// It was also the last system in the game that was still private to one tab.
// 17 calls to Math.random decided who existed, and `_nearby(focus)` built the
// candidate list around whoever was holding the keyboard, so two players in
// one room walked through two unrelated crowds.
//
// THE TWO RULES THIS FILE NOW OBEYS
//
//   1. AN ACTOR MAY NOT APPEAR OR DISAPPEAR WHERE THE PLAYER CAN SEE IT.
//      Every lifecycle decision — attach a body, drop a body, retire a slot —
//      is gated on `_hidden()`: outside the camera's cone, or far enough away
//      that a 1.8 m figure is a handful of pixels in the haze. A decision that
//      is not allowed yet is simply not taken; the walker keeps walking and
//      the sweep asks again in 250 ms. Nothing is ever killed in your face.
//
//   2. POPULATION = f(CELL, TIME), exactly as js/traffic.js does it.
//      The world is diced into PCELL-metre squares — the SAME 256 m dice the
//      traffic uses, deliberately, because two grids for one idea is worse
//      than one grid. A square owes the world a number of pedestrian SLOTS
//      proportional to how much footway it carries. Slot k of cell (i,j) is
//      held by generation g = floor((worldT + phase) / TRIP_T), and that
//      citizen's ENTIRE existence — start path, entry offset, direction,
//      which side of the pavement, walking speed, how far the beat runs, the
//      jacket, the trousers, the hair — is hash32(seed, ci, cj, k, g) and
//      nothing else. Position is a pure function of worldT: no accumulator,
//      no frame-rate dependence, no Math.random anywhere on the shared path.
//      Two clients compute the same crowd from the same four integers.
//
// WHAT MAIN.JS HAS TO HAND OVER: one camera descriptor per frame, and it is
// THE SAME CALL js/traffic.js takes, on purpose —
//
//   const v = { camera, fogFar: scene.fog?.far };
//   traffic.setViewer(v);
//   peds.setViewer(v);            // before update(), once a frame
//
// See setViewer() below for the accepted shapes. Passing nothing is safe: with
// no camera we cannot tell front from back, so we assume every bearing is
// watched out to BLIND_R — six times the radius the old spawner protected.
//
// SHAPE OF A LIFE. A citizen walks an out-and-back beat: a route of connected
// footways up to `span` metres long, walked out and walked back, for as long
// as the generation lasts. The triangle wave is what makes the position a
// closed form — `arc = tri(speed·(t − t0), span)` — and it is also what bounds
// the crowd in space: a walker can never be further from its birth cell than
// span, so the set of citizens who could possibly be near the player is
// exactly the cells within ATTACH_R + ROUTE_MAX. That bound is the whole
// reason this is affordable; without it we would have to run the beat for the
// entire region to know who is about to come round the corner.
//
// WHAT IS DELIBERATELY LOCAL, and why that is survivable — the same doctrine
// traffic.js states for its lag:
//   · Being run over is local. A ragdoll is thrown by one machine's collision
//     test, so a hit citizen is RELEASED from its slot and finishes its life
//     as a free body owned by this tab alone. The slot is held empty until the
//     generation rolls, so the schedule cannot refill a corpse's place under
//     the player's nose.
//   · Panic is local but BOUNDED. A blast makes a walker run, which is a
//     signed offset `rush` on top of its nominal arc; the offset decays back
//     to zero at RUSH_DECAY once they calm down. Same restoring force as the
//     traffic's lag: a transient, never a random walk, so two clients cannot
//     drift apart permanently.
//   · Deferred retirement costs a GHOST, not a divergence. When the generation
//     rolls under a walker you are looking at, the SLOT is retired on time —
//     it leaves _pool that same tick and _scanCells mints the next generation
//     into it two lines later — and only the BODY is deferred: it walks on as
//     a free body owned by this tab, and goes when nobody can see it go. So
//     what differs between two clients is which extra bodies each one draws,
//     never what the schedule says. This is js/traffic.js's v9 ghost, argued
//     out in its header, and it is deliberately the same shape here.
//     It was not always: until the fix that added _toGhost, a watched walker
//     kept its SLOT on the old generation, and two clients standing on the
//     same spot looking opposite ways disagreed in 2–6 rows of snapshot() —
//     one slot was measured stuck 465 s behind, a whole generation skipped.
//   · The graph is STREAMED, and a beat is built once, at birth. A citizen
//     born while the next tile was still in flight dead-ends at the tile
//     border and walks a shorter beat than the same citizen born a second
//     later — so two clients can disagree about span for slots minted right
//     on a streaming boundary. traffic.js carries the same caveat for the
//     same reason; the generation rolls it out within TRIP_T either way.
//
// Cost discipline is unchanged: each citizen is eleven small meshes over
// shared geometry and shared materials, so the body count is what costs, not
// the walking. The schedule layer is scalar math on ~300 objects at 4 Hz.
//
// Hit physics (GTA-lite): main.js hands us `peds.cars` (Set of AI cars) and
// `peds.playerCar` every frame. A moving car whose oriented rectangle overlaps
// a walker launches them into a ragdoll — fly, tumble, bounce once, slide out.
// Fast hits kill; corpses lie on a separate small budget, bleed a pooled decal,
// and can be run over again. Slow hits stun: the ped lies a few seconds, gets
// up and flees. Owners may subscribe:
//   peds.onPedHit    = (ped, impact) => {}        // every qualifying hit
//   peds.onPedKilled = (ped) => {}                // once, when a hit is lethal
//
// ---- ONE DOOR FOR EVERY INJURY -------------------------------------------
//
// Until now the only thing in the world that could hurt a citizen was a car:
// _carHit found the overlap and _launch did EVERYTHING else — released the
// slot, threw the body, set 'rag', fired both hooks and panicked the street. A
// fist and a bullet want every one of those consequences and none of them want
// a Škoda, so the hit path is three layers now instead of one:
//
//   _throw(p, vx, vy, vz, spin)   the PHYSICS, and nothing else. Cut the body
//                                 loose from its schedule, give it a velocity
//                                 and a tumble, put it in the air. Knows
//                                 nothing about damage, blame or sound.
//   hurt(p, blow)                 THE DOOR. Takes hp off, decides whether this
//                                 blow throws the body or merely rocks it,
//                                 fires onPedHit / onPedKilled, panics the
//                                 street. Every injury in the game comes
//                                 through here — a fist, a bullet, a bus.
//   _launch(p, car, s)            the car, unchanged from the outside: it works
//                                 out the impulse a bonnet delivers and hands
//                                 that to hurt().
//
// THE BUG THIS SHAPE EXISTS TO PREVENT, because it shipped once already. The
// first melee build launched a ragdoll on EVERY punch. Hit #1 set state 'rag'
// — and both _hitPass here and the melee sweep in js/combat.js skip anything
// in 'rag' — so hits #2 and #3 landed on nobody and a three-punch combo was
// unreachable by construction. It tested green, because "one punch, one
// ragdoll" is also what a working punch looks like from the outside. Hence the
// rule, which is the whole reason hurt() exists rather than four call sites:
//
//   A BLOW THAT DOES NOT KILL DOES NOT TOUCH p.state. It costs hp, sets a
//   short hitCd, leaves a decal and makes them run — and they are still
//   'walk', still in the hit pass, still standing there to be punched again.
//   Only a LETHAL blow, or one that explicitly says launch:true, throws a body.
//
// p.hp is 100, the same bar js/vitals.js gives the player, so one scale serves
// both sides of a fight. THE CAR DOES NOT SPEND IT: KILL_SPEED (7 m/s) still
// decides on its own whether an impact was fatal. A health bar would make one
// 30 km/h clip survivable for a healthy man and lethal for one who had been
// punched twice, which contradicts both the existing tests and everybody's
// intuition about being hit by a car — so the car's blow carries either the
// whole health bar or none of it, and never a fraction.
//
// 'held' — a citizen standing still with their hands up, because somebody is
// robbing them. It is a STATE and not a flag, and that is not tidiness:
// freezing the schedule arc alone is not enough, because _schedStep passes
// Math.max(0.3, …) as the animation speed, so a victim pinned in place JOGS ON
// THE SPOT. That is the joke breaking rather than landing. 'held' therefore
// leaves the walk loop entirely — no arc, no facing, and above all no
// p.animate at all — and js/combat.js drives the pose and the heading for as
// long as it holds them. The shared schedule keeps walking without them, as it
// must, and the debt is paid back on release through `rush`: the same bounded,
// draining local deviation a panic already uses.
// ==========================================================================

import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { archetypeAt, ARCH_SALT } from './people.js';
import { PLAYER_SCALE, LAYER_Y, CHUNK } from './config.js';
import { worldT } from './worldclock.js';
import { hourAt, isWeekend, crowdK, venueK } from './dayrhythm.js';
import { DW, buildTimeline, sampleTimeline } from './dwell.js';
import { SITE, SiteIndex, RoadIndex, stopSpot, stopBay, STOP_SPREAD, isFoodVenue } from './crowdsites.js';
import { SEAT_H } from './furniture.js';
import { doorsOf } from './transitbody.js';
import { landmarkWalks } from './landmarks-walks.js';

// ---- the shared population ------------------------------------------------
// Same dice as traffic.js on purpose: one grid, one mental model, and a cell
// that already holds "about a city block" of geometry.
const PCELL = 256;
const PCELL_HALF_DIAG = 181.02;        // Math.SQRT2 * PCELL / 2, precomputed
// Metres of walkable footway per pedestrian slot, at density 1. Calibrated by
// running the finished module against the real region: at 62 m per slot the
// eight tiles around the station hold 37 walkers inside ATTACH_R with `max` at
// 34, and 47 with it at 60 — i.e. the setting means roughly what it says while
// density still follows the city rather than the player. Empty country carries
// almost no footway per cell and therefore almost nobody, for free; that is the
// per-place density main.js used to fake with a building count.
const MPW = 62;
const SLOT_MAX = 40;                   // per cell. The station forecourt carries 4.3 km
                                       // of pavement in one 256 m square and would
                                       // otherwise ask for seventy walkers standing on
                                       // each other's feet; 40 is one per 1 640 m²,
                                       // which is a busy pavement and not a crowd riot
// How long one slot holds one identity. LONG on purpose: a generation boundary
// is the one event that cannot be hidden by walking somewhere else, so it must
// be rare. 420 s against ~40 attached walkers is one identity change every
// ~10 s somewhere in the ring — and every one of those is still deferred until
// nobody is looking.
const TRIP_T = 420;
// The beat, walked out and back. ROUTE_MAX is what bounds the phantom radius,
// so it buys reach at the cost of scanning more cells; 380 m of footway is
// four or five blocks, which is as far as a background walker needs to be
// believable.
const ROUTE_MIN = 160, ROUTE_VAR = 220;
const ROUTE_MAX = ROUTE_MIN + ROUTE_VAR;
const ROUTE_STEPS = 22;                // traversals per beat (a hop can cost two:
                                       // the crossing and the way) — a hard stop on
                                       // how far one _grow may walk the graph
const WORLD_SEED = 0x9ed17a3;          // change this and every face in the city is a
                                       // different face. Never change it on a live build.

// ---- radii ----------------------------------------------------------------
// ATTACH_R is up from the old 110 m, and the reason is not reach — it is that
// the rate at which bodies appear is N·2v/(π·R) for a fixed body budget N, so
// a WIDER ring with the same number of people in it pops LESS, linearly. The
// cost is that the same N is spread thinner, which is the trade the comment on
// MPW pays for.
const ATTACH_R = 190;                  // a slot inside this deserves a body…
const DETACH_R = 265;                  // …and keeps it until this. The gap is
                                       // hysteresis: walking the boundary must not
                                       // strobe a body on and off.
// A body with no slot — hit and freed, stunned and fled, or overtaken by its
// own generation while somebody was watching — is a GHOST in exactly the sense
// js/traffic.js gives the word: something one client draws and the peer does
// not. traffic.js bounds its ghosts three ways and so do we. They only exist
// while they are watched, they walk away by themselves, and this is the
// surrender clause for the one that cannot.
//
// THE NUMBER IS NOT traffic.js's 40 s, and the difference is speed, not taste.
// traffic.js can afford 40 s because "a ghost that can move leaves a 116° cone
// in a few seconds" — a car does 13 m/s. A walker does 1.3, so the same clause
// on the same cone would fire on walkers that have simply not had time to get
// anywhere. Measured over 30 min of standing and staring at one bearing, which
// is the worst case there is:
//     cap   ghosts alive (mean)   surrenders, all of them in view
//      40 s        0.97            30 = 1.00/min
//      90 s        1.61            18 = 0.60/min
//     180 s        2.02             3 = 0.10/min
//     300 s        2.08             0
//     none         2.08             0   (longest natural ghost: 243 s)
// So 300 s buys the last of the pops for one extra mesh on a 56-body budget,
// and the curve is flat past it — a ghost left over at 300 s is not slow, it is
// stuck. That is the case the clause exists for, and it stays a HARD bound: the
// worst-case fleet is the ghost birth rate (1.9/min here) times the cap.
// The other half of traffic.js's argument for a short cap does not apply to us
// either. Its immortal ghost is "a car the peer cannot see, standing in the
// middle of a road" — an invisible obstacle. Nothing in this game collides with
// a pedestrian except a car, and being run over is already local, so a ghost
// walker is a cosmetic disagreement and nothing more.
const GHOST_MAX = 300;
// Inside NOTICE_R a citizen is big enough on screen that appearing or
// vanishing reads as a glitch; at 150 m a 1.8 m figure is ~12 px tall and
// three wide on a 1080p screen, which is where "did something just happen
// over there?" stops being answerable. Beyond it we allow lifecycle events
// even head-on, because otherwise the road ahead of a moving player would
// simply be empty — an empty street is a worse bug than a distant pop.
//
// DO NOT PUSH THIS FURTHER OUT. It has been tried, on the grounds that a birth
// at 160 m is still 90 % unfogged on the D11 and so carries real haze weight.
// It does not work, and it fails in both directions at once, because the crowd
// near the player is CAP-bound (max·CAP_SLACK + 4 ≈ 55 bodies, and 57 is what
// the standing measurement actually holds), not radius-bound. Widening the ring
// therefore does not add walkers further away, it spreads the same fifty-five
// thinner. Measured, walkers in the forward cone inside 150 m:
//              driving 50 km/h    standing and staring
//   150 / 190       1.17                 7.53      ← today
//   170 / 210       0.80                 5.71
//   190 / 230       0.63                 4.63
//   200 / 240       0.49                 4.56
//   150 / 270       0.60                 5.30      (band widened alone)
// And the thing it was supposed to buy does not arrive either: attaches inside
// 150 m went UP, 197 → 270 per ten minutes of driving, because a body that
// attaches close in does so BEHIND or BESIDE the player, where NOTICE_R has no
// say, and a thinner ring simply churns faster. Half the street for no gain is
// exactly the regression this pair of numbers was chosen to avoid.
const NOTICE_R = 150;
// Fallback when nobody has given us a camera (headless tests, or a main.js
// that has not been wired to `view` yet). Without a cone we cannot know what
// is behind the player, so we assume EVERYTHING within this radius is watched.
// It is deliberately larger than the old 18 m floor by a factor of six.
const BLIND_R = 110;
// ---- the view cone: the same shape traffic.js protects ---------------------
// VIEW_MARGIN and VIEW_COS_MIN are traffic.js's numbers, deliberately, because
// the two files answer the same question about the same camera and a walker
// and a Škoda must not disagree about where the edge of the screen is. 0.42 rad
// of margin on each side turns a 68° camera into a 116° protected cone, which
// covers a flick of the mouse and the fact that a chase camera is not quite the
// point we test from.
const VIEW_MARGIN = 0.42;
const VIEW_COS_MIN = -0.9;             // never protect more than ~154° each way
// This close, treat it as visible at ANY yaw — mirrors, peripheral vision and a
// wide cockpit view all cheat. traffic.js uses 26 m; a citizen gets 40, because
// a person is at eye level in a chase cam where a car body is mostly below it,
// and because the old bug this replaces was a spawn at 18 m. Measured: with 40,
// the closest a body ever appears while driving is exactly 40 m, against 7–12 m
// before.
const PERIPHERAL_R = 40;
const HIDE_FOG_K = 0.88;               // traffic.js's constant and reasoning: the fog
const HIDE_R_DFLT = 558;               // wall itself is not where a pop stops being
const HIDE_R_MIN = 120;                // catchable. For citizens it is almost always
const HIDE_R_MAX = 900;                // NOTICE_R that binds, not this — see _hidden
const PHANTOM_R = ATTACH_R + ROUTE_MAX + PCELL_HALF_DIAG;

const SWEEP_DT = 0.25;                 // lifecycle bookkeeping at 4 Hz, as traffic does
const BIRTH_BUDGET = 40;               // beats built per sweep. A cold boot owes ~300;
                                       // at 4 Hz that fills in over ~3 s instead of
                                       // costing one long hitch on the first frame
const CAP_SLACK = 1.5;                 // hard body cap = max × this. Density already
                                       // lands near `max`, so this should never bind;
                                       // it exists so a freak dense square cannot
                                       // allocate a thousand meshes.

const MAX_PEDS = 34;                   // the reference population `max` is measured in
const SIDE = 0.9;                      // how far off the path centerline they walk
// Both of these exist because a walker's POSITION must be continuous, not just
// its schedule. The pavement offset is perpendicular to travel, so at a 90°
// corner the raw offset rotates a quarter turn in one frame — a 1.3 m sidestep
// — and at the far end of the beat, where the direction of travel reverses,
// the offset flips outright: 1.8 m of teleport, measured. So the direction is
// taken from a CHORD SIDE_SMOOTH metres either side of the walker (a corner
// rounds off over 2.4 m instead of snapping), and the offset TAPERS to zero
// over the last SIDE_TAPER metres of the beat, which turns the reversal into a
// walker drifting to the middle of the pavement, turning, and drifting back.
const SIDE_SMOOTH = 1.2;
const SIDE_TAPER = 6;
const JOIN_R = 7;                      // path ends within this distance connect
const SPEED_MIN = 1.15, SPEED_VAR = 0.4; // m/s — a stroll to a brisk walk
const OLD_SPEED_MIN = 0.62, OLD_SPEED_VAR = 0.16;   // …and the ninety-year-old's: about 0.7
const MIN_PATH = 12;                   // driveway stubs aren't worth a walker

// ---- hit / ragdoll tuning ----
const HIT_MIN_SPEED = 1.5; // m/s — a car crawling slower than this can't hit
const KILL_SPEED = 7;      // m/s (~25 km/h) — impact above this is lethal
const PED_R = 0.35;        // standing collision circle
const LIE_R = 0.4;         // lying capsule: circles of this radius…
const LIE_HALF = 0.55;     // …sampled at ± this along the lying body axis
const GRAV = 18;           // slightly heavy gravity reads punchier than 9.8
const RESTITUTION = 0.3;   // one bounce, then slide
const SLIDE_FRICTION = 8;  // m/s² ground decel while sliding to rest
const NUDGE_K = 0.55;      // re-running-over a corpse relaunches at this energy
const HIT_COOLDOWN = 0.5;  // s — one car can't machine-gun hits on one ped
const PANIC_R = 25;        // bystanders inside this radius flee a hit
const DOWN_TIME = [2, 4];  // stunned survivors lie this long before getting up
const CORPSE_TIME = 60;    // s a corpse stays…
const CORPSE_FADE = 1.5;   // …then sinks away over this long (materials are
                           // SHARED across citizens, so opacity-fade would
                           // ghost every walker on screen — sinking won't)
const CORPSE_MAX = 10;     // visible-corpse budget, separate from the walk cap
const LIE_Y = 0.13;        // lying pivot height: the back of a js/citizen.js
                           // body is 0.126 behind its axis, and feet already
                           // stand on world.footing (0.3 hovered 17 cm up)
const HALF_PI = Math.PI / 2;
// Panic, expressed as a bounded local deviation instead of a private identity:
// a frightened walker gains ground on its own schedule and then pays it back.
const FLEE_SPEED = 5.4;    // m/s while running from a bang
const RUSH_MAX = 45;       // m of lead a panic may build up before it stops helping
const RUSH_DECAY = 0.55;   // m/s the debt drains at once they calm down
const CALM_T = [6, 4];     // s of panic: base + spread

// ---- damage: one door, one scale ----
// A citizen starts on the same 100 the player does (js/vitals.js), so whoever
// tunes a fist or a bullet has ONE number to think in and can read "this kills
// a man in three hits" straight off their own table. The car deliberately does
// not spend it — see _launch, and the header. Exported so js/combat.js and
// js/weapons.js can state their damage as a fraction of a man rather than
// copying the literal 100 into two more files.
export const PED_HP = 100;
// A blow that does not kill still has to stop two sources billing one punch
// inside a single 50 ms step. SHORTER THAN ANY SWING, deliberately: hitCd is
// read by _hitPass and by nothing else — hurt() never tests it — but a combo
// whose second punch arrived inside a long cooldown would be silently
// swallowed, which is the exact failure this whole refactor exists to avoid.
const FLINCH_CD = 0.18;
const FLINCH_BLOOD = 0.45; // a split lip, against 1.0–1.4 for a corpse
// What the hooks are told a blow was worth when the caller does not say. The
// car has real metres per second; a fist has hp. main.js screams past 3 and
// js/chatter.js witnesses past 3, so a quarter puts a 14 HP punch (3.5)
// exactly where a punch belongs: audible, and not a car crash.
const IMPACT_PER_HP = 0.25;
// The street reacts to where the blow CAME FROM — one stride back up its own
// direction — rather than to the body it landed on. For a car that is the
// bonnet and changes nothing; for a fist it is the difference between the
// victim running away from their attacker and running away from themselves.
const PANIC_BACK = 1.2;
const C_CAR = 'sražení autem';   // Czech: it ends up stamped on a body

// ---- blood decals ----
const BLOOD_MAX = 40;      // pooled groups of 3 discs, oldest reused
const BLOOD_GROW = 2;      // s to spread to full size
const BLOOD_LIFE = 70;     // s on the ground, then shrink out over 2 s
// A stain lies ON whatever the victim lies on. This used to be a height above
// the bare ground (LAYER_Y.road + 0.04), which was right while every surface in
// town was the road deck; since pavements ride a kerb above it, a stain on one
// was drawn inside the paving. The ground handed to this module is the walking
// surface itself now (world.footing), so the stain needs only enough daylight
// to clear the paint a zebra is drawn with.
const BLOOD_LIFT = (LAYER_Y.marking - LAYER_Y.road) + 0.012;

// ---- doing things: benches, stops, windows, kerbs (see js/dwell.js) --------
const PAIR_P = 0.24;           // share of even slots that walk with a companion
const PAIR_IN = 0.45, PAIR_OUT = 1.5;   // how far off the centreline each of the two walks (x SIDE)
const KERB_SHY = 0.5;          // m a walking line keeps from the edge of a carriageway it is not crossing
const BAY_CLEAR = 0.4;         // m behind the kerb of a bus lay-by the line nearest the road passes
const LAT_EASE = 3;           // m over which a walker moves in from the side of the path, and back out
const FREE_HOLD = 14;          // s a walker with no schedule waits at a kerb for a gap before going anyway
const ALONG_MAX = 30;          // m of carriageway in one run past which a beat is walking ALONG the road, not over it
const SEAT_Y = SEAT_H;         // top of a bench seat over the paving: the bench's own number (js/furniture.js)
const BENCH_END = 1.25;        // m from the middle of a bench somebody stands who found it full
const SEAT_HALF = 0.42;        // two people on its 1.7 m of slats sit this far either side of the middle
const SEAT_KEEP = 420;         // s a schedule is remembered at its bench after its generation: see _seatOf
const BENCH_R = 6.5, STOP_R = 10, SHOP_R = 9;   // how far off the beat each is still "beside it"
const STEP_SPEED = 1.1;        // m/s walking over to a bench or a shelter
const SIT_BLEND = 0.45;        // s folding into the seat
const BOARD_P = 0.28, ALIGHT_P = 0.24;  // share of walkers passing a served stop who take the bus
// s: nobody waits longer than this for a bus. Five minutes, not two and a
// half: the derived lines ran every 330 s, the real ones every ten minutes
// (trolleybus) or fifteen (bus) as DPMP's do, and at 150 s three walkers in
// four found no bus worth waiting for and the stops stood empty.
const BOARD_MAX_WAIT = 300;
const LATE_MAX = 75;            // s past that a boarder still waits for a bus they can see coming
const BOARD_GRACE = 22;        // s after the timetable a boarder still stands there (buses run late)
const BOARD_WALK_MAX = 12;     // s somebody keeps making for the door of a bus before it has been missed
const BOARD_RUN_D = 5, BOARD_RUN = 3.2;   // further from the door than this (m), they run for it (m/s)
// Where the doors of the bus are, in metres back from its nose along the kerb
// side: the middle of the front leaf and of the centre pair. js/cardetail.js
// draws them there (door glass 0.47 to 1.43 m and 4.63 to 5.97 m behind the
// nose of the 11 m body); at the old 2.2 m people walked into a window pane
// and stepped out of one.
// (Those two numbers live in js/transitbody.js now, one row per body: the
// twelve-metre trolleybus has its middle door 6.1 m back.)
const KERB_NEAR = 1.3;         // m short of the asphalt a walker counts as stepping out
const GAP_LOOK = 55;           // m a walker looks up the road before crossing
const HOLD_MAX = 16;           // m of beat a walker may fall behind waiting for a gap,
                               // then they go anyway: the guard a real person has
const BODY_FRESH = 12;         // s a corpse in the road is stopped for; after that drivers crawl past

// Every distance in the SHARED half of this file. Math.hypot is not what this
// is: the spec leaves hypot's precision implementation-defined, and a value
// that feeds a shared schedule may not vary between browsers. Multiplication,
// addition and sqrt are all exactly specified. (traffic.js says the same in
// its own words; the two files must agree bit for bit or the crowd and the
// cars would disagree about where a cell is.)
const dist = (dx, dz) => Math.sqrt(dx * dx + dz * dz);

// ---- integer hashing: the only randomness a shared world may use ----------
// Byte-for-byte the murmur3 finaliser traffic.js uses. Duplicated rather than
// imported because pedestrians.js must not depend on traffic.js — they are two
// consumers of one idea, not a stack — but the mixing MUST be identical in
// spirit: Math.imul, xor and shift only, no Math.sin, no float rounding that
// two engines could disagree about.
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
const q4 = (v) => Math.round(v * 4) | 0;      // 25 cm quantisation for hashing

// Stable total order over footways, so "the third path in this cell" means the
// same thing on every client no matter which order the tiles streamed in. pid
// first (uniform, cheap), geometry as the tie-break — a hash collision must not
// become a coin flip.
function cmpPath(a, b) {
  return ((a._pid >>> 0) - (b._pid >>> 0)) || (a._plen - b._plen)
    || (a.p[0][0] - b.p[0][0]) || (a.p[0][1] - b.p[0][1]);
}

// point-in-expanded-rect: (u,v) is the circle center in the car's frame
function rectCircle(u, v, hl, hw, r) {
  const du = u < -hl ? u + hl : u > hl ? u - hl : 0;
  const dv = v < -hw ? v + hw : v > hw ? v - hw : 0;
  return du * du + dv * dv < r * r;
}

// ONE geometry + material for every blood disc ever, made on first need so
// merely importing this module (tests) allocates nothing
let _bloodGeo = null, _bloodMat = null;
function bloodAssets() {
  if (!_bloodGeo) {
    _bloodGeo = new THREE.CircleGeometry(1, 14);
    _bloodMat = new THREE.MeshBasicMaterial({
      color: 0x6a0f0f, transparent: true, opacity: 0.75, depthWrite: false,
    });
  }
}

/** Is the citizen this seed builds the ninety-year-old? (the roll _attach makes the body from) */
const isOld = (seed) => archetypeAt(rnd01(hash32(seed, ARCH_SALT))).key === 'm90';

// walkable classes: everything the data marks as not drivable
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'living_street']);

// scratch for camera.getWorldDirection(); a Vector3 rather than a bare object
// because three.js writes into it
const _vdir = new THREE.Vector3();

// scratch poses, reused so the per-frame walk allocates nothing
const _P = { x: 0, z: 0, dx: 0, dz: 0 };
const _A = { x: 0, z: 0, dx: 0, dz: 0 };
const _B = { x: 0, z: 0, dx: 0, dz: 0 };
const _T = { x: 0, z: 0, dx: 0, dz: 0 };
const _Q = { x: 0, z: 0, dx: 0, dz: 0 };
const _D = { x: 0, z: 0, dx: 0, dz: 0, moving: false, sit: 0 };   // _dwellPose's answer
const _LB = { push: 0, nx: 0, nz: 0, dx: 0, dz: 0 };              // RoadIndex.layby's answer
// _arcAt's one answer (see js/dwell.js sampleTimeline)
const _SL = { arc: 0, sign: 1, walked: 0, kind: 0, ref: -1, i: 0, tIn: 0, tOut: 0, v: 1 };   // _seatOf's own
const _TL = { arc: 0, sign: 1, walked: 0, kind: 0, ref: -1, i: 0, tIn: 0, tOut: 0, v: 1 };
// _launch's blow record, rewritten in place. hurt() reads it and keeps no
// reference, so one object serves every impact for the life of the process.
// It belongs to _launch alone: an outside caller building a blow should write
// its own literal — a hit is an event, not a frame, and it can afford one.
const _blow = {
  dmg: 0, launch: false, vx: 0, vy: 0, vz: 0,
  spin: 0, impact: 0, panic: 0, cause: '',
};

export class Pedestrians {
  constructor(scene, city, terrain = null) {
    this.scene = scene;
    this.city = city;
    // The ground. Without it every pedestrian in the game walks at y = 0, which
    // in Pardubice is 220 m underground — they were all there, walking their
    // beats, just below the map.
    this.terrain = terrain;
    this.peds = [];                // LIVE bodies (attached or freed) — the list
                                   // main.js, weapons.js and the hit pass iterate
    this.paths = [];               // usable footways, grown as tiles stream
    this._seenIds = new Set();     // road _id already ingested
    this._cells = new Map();       // "ci,cj" → { ci, cj, paths, len, sorted }
    this._ends = new Map();        // JOIN_R bucket → [{ r, node }] for junctions
    this._pool = new Map();        // "ci,cj/k" → schedule (with or without a body)
    this._dud = new Map();         // "ci,cj/k" → the generation _plan found nothing to walk in
    this._sweepT = 0;
    this._densK = 1;
    this.max = MAX_PEDS;
    // The normalised camera, written only by setViewer(): {x, z, dx, dz, cos,
    // hideR}, the same record traffic.js keeps. null until somebody calls it.
    this.view = null;
    this.clock = null;             // test seam: () => shared seconds. null = worldT()
    this.cars = null;              // main.js refreshes both every frame before update()
    this.playerCar = null;
    this.onPedHit = null;          // (ped, impactSpeed) — audio/main subscribe here
    this.onPedKilled = null;       // (ped)
    this._blood = [];              // pooled decals, grown lazily to BLOOD_MAX
    this._bloodN = 0;              // round-robin reuse cursor = oldest decal
    // ---- the day and the things to do in it ----
    // false = the crowd ignores the hour (a test that wants one fixed density)
    this.rhythm = true;
    this.sites = new SiteIndex();  // benches, stops, windows, zebras (js/crowdsites.js)
    this._benchers = new Map();    // bench id -> the slots whose beat stops at it (see _seatOf)
    this._benchRev = 0;            // bumped when a schedule that was already under way turns up at a bench
    this.drive = new RoadIndex();  // carriageways: what a beat has to cross
    this._food = new Map();        // "ci,cj" -> places serving food or drink there
    this._foodRev = 0;
    this._poiN = 0;                // how much of city.pois has been read
    this._kStreet = 1; this._kVenue = 1;
    // Three questions this module cannot answer itself and main.js wires up.
    // Each is a pure function of shared facts, or the timelines built on them
    // would not be shared either. All optional: without them nobody waits for
    // a light and nobody takes a bus, and nothing else changes.
    //   signalWait(x, z, rdx, rdz, t, crossT) -> seconds until a walker arriving
    //     at t may cross the road running (rdx, rdz) at (x, z)
    //   busEta(stopX, stopZ, t) -> shared second the next bus calls there, or Infinity
    //   busAt(stopX, stopZ) -> the bus standing at that stop right now, or null
    //   roadBusy(cx, cz, hw, need, stops) -> is a car about to drive over that
    //     point of a road? (js/traffic.js threatens; local, like the lag it makes)
    this.signalWait = null;
    this.busEta = null;
    this.busAt = null;
    this.busNear = null;           // busNear(stopX, stopZ) -> is a late bus for that stop coming down the street?
    this.roadBusy = null;
    // What the traffic has to give way to, rebuilt every update(): one record
    // per walker on a carriageway or about to step onto one. js/traffic.js
    // reads it through main.js (traffic.walkers = peds.crossers).
    this.crossers = [];
    this._crossPool = [];
    this._ingest(city.roads);
    this._ingest(landmarkWalks(city.roads));     // the ways through the gates (js/landmarks-walks.js)
    this._ingestCells(city.chunkIndex?.keys());
    this._ingestPois();
    city.onTileLoaded?.((t) => {
      this._ingest(t.roads); this._ingest(landmarkWalks(t.roads)); this._ingestCells(t.cells); this._ingestPois();
      this._dud.clear();           // more map, so a beat that had nowhere to go may have somewhere now
    });
  }

  now() { return this.clock ? this.clock() : worldT(); }

  // ---------------------------------------------------------------- graph ----

  // Keep only paths long enough to walk, give each one an identity that does
  // not depend on load order, file them under the cell holding their arc
  // midpoint, and index their endpoints so a junction lookup is a bucket read
  // rather than a scan of eight thousand ways.
  _ingest(roads) {
    for (const r of roads ?? []) {
      if (!r.p || r.p.length < 2) continue;
      if (r.d) {
        // a carriageway: not walked on, but every beat has to know where they are
        if (r._pedDrv) continue;
        r._pedDrv = 1;
        this.drive.add(r);
        continue;
      }
      if (!FOOT.has(r.t)) continue;
      if (this._seenIds.has(r._id)) continue;
      this._seenIds.add(r._id);
      const cum = this._cum(r);
      const total = cum[cum.length - 1];
      if (total < MIN_PATH) continue;
      r._plen = total;
      const n = r.p.length;
      const mid = this._along(r, total / 2, _P);
      r._pmx = mid.x; r._pmz = mid.z;
      r._pid = hash32(q4(r.p[0][0]), q4(r.p[0][1]), q4(r.p[n - 1][0]), q4(r.p[n - 1][1]),
        q4(mid.x), q4(mid.z));
      this.paths.push(r);
      this._cellAdd(r);
      this._endAdd(r, 0);
      this._endAdd(r, n - 1);
    }
  }

  // Benches, zebras and shop fronts, from the chunk cells a tile touched. A cell
  // can be touched by two tiles, so the index dedupes by feature id.
  _ingestCells(keys) {
    const idx = this.city.chunkIndex;
    if (!idx || !keys) return;
    for (const k of keys) {
      const cell = idx.get(k);
      if (!cell) continue;
      const before = this.sites.count;
      this.sites.addCell(cell);
      if (this.sites.count === before) continue;
      for (const v of cell.venues ?? []) {
        if (v._pedV || !isFoodVenue(v.t)) continue;
        v._pedV = 1;
        const q = v.p[0];
        const fk = Math.floor(q[0] / PCELL) + ',' + Math.floor(q[1] / PCELL);
        this._food.set(fk, (this._food.get(fk) ?? 0) + 1);
        this._foodRev++;
      }
    }
  }

  // Bus stops live in city.pois, which only ever grows.
  _ingestPois() {
    const pois = this.city.pois;
    if (!pois) return;
    for (; this._poiN < pois.length; this._poiN++) {
      const poi = pois[this._poiN];
      if (poi.t !== 'bus_stop' || !poi.p) continue;
      const x = poi.p[0], z = poi.p[1];
      const road = this.drive.nearest(x, z, 30, true) ?? this.drive.nearest(x, z, 30);
      // behind the lay-by where there is one: the bus drives into it (js/crowdsites.js stopBay)
      const bay = stopBay(x, z, road);
      let spot = stopSpot(x, z, road, bay);
      // …but not through the wall of a house. The map has no lay-by, the game
      // made one, and now and then a house stands where the pavement behind it
      // would be (one stop in 176 round Pardubice: its waiters stood 0.7 m
      // inside the wall). There they wait in front of the wall, down to a
      // foot's length behind the stepped-out kerb: the flank of the bus in the
      // bay still passes 0.8 m short of that kerb.
      for (let n = 1; bay > 0 && n <= 4 && this._spotWalled(spot); n++) spot = stopSpot(x, z, road, Math.max(0, bay - 0.2 * n));
      this.sites.add(SITE.STOP, x, z, null, { spot });
    }
  }

  // Would somebody waiting at this stop stand inside a house? Asked in the
  // middle of the kerb they spread along and at both ends of it.
  _spotWalled(sp) {
    return this._inBuilding(sp.x, sp.z)
      || this._inBuilding(sp.x + sp.ax * STOP_SPREAD, sp.z + sp.az * STOP_SPREAD)
      || this._inBuilding(sp.x - sp.ax * STOP_SPREAD, sp.z - sp.az * STOP_SPREAD);
  }

  _cellAdd(r) {
    const ci = Math.floor(r._pmx / PCELL), cj = Math.floor(r._pmz / PCELL);
    const key = ci + ',' + cj;
    let c = this._cells.get(key);
    if (!c) this._cells.set(key, c = { ci, cj, paths: [], len: 0, sorted: null });
    c.paths.push(r);
    c.len += r._plen;
    c.sorted = null;                    // canonical order is rebuilt on demand
  }

  _cellPaths(c) {
    if (!c.sorted) c.sorted = c.paths.slice().sort(cmpPath);
    return c.sorted;
  }

  _endAdd(r, node) {
    const [x, z] = r.p[node];
    const key = Math.floor(x / JOIN_R) + ',' + Math.floor(z / JOIN_R);
    let b = this._ends.get(key);
    if (!b) this._ends.set(key, b = []);
    b.push({ r, node });
  }

  // The share of the slider that is out in square `c` at this hour (a square
  // with no paths in it, c undefined, is an ordinary street).
  _dayK(c) {
    if (!c || !(this._kVenue > this._kStreet)) return this._kStreet;
    if (c._fr !== this._foodRev) {
      c._fr = this._foodRev;
      c._vs = Math.min(1, (this._food.get(c.ci + ',' + c.cj) ?? 0) / 5);
    }
    return this._kStreet + (this._kVenue - this._kStreet) * c._vs;
  }

  // How many walkers this square of city owes the world. Two players with the
  // same density setting compute the same number for the same square, which is
  // the whole point. Quantising the knob to eighths is what makes "the same
  // setting" survive main.js easing it — two clients whose value differs by 3 %
  // still land on one number.
  _slots(c) {
    // …and the HOUR is part of "the same setting": the slider is the ceiling,
    // the shared clock says how much of it is out (js/dayrhythm.js), and a
    // square with restaurants and pubs in it keeps its evening after the
    // streets round it have gone home. Quantised like the knob, so two clients
    // a few milliseconds apart on the clock still land on one number.
    const k = Math.round(this._densK * this._dayK(c) * 32) / 32;
    if (k <= 0) return 0;
    const f = c.len * k / MPW;
    if (f >= SLOT_MAX) return SLOT_MAX;
    // Dither the fractional slot instead of truncating it: at the "Málo"
    // setting most cells ask for less than one walker, and flooring would
    // empty the whole town rather than thin it. The extra body goes to a
    // hash-chosen share of cells — deterministic dithering, not a dice roll.
    const n = Math.floor(f);
    return n + (rnd01(hash32(c.ci, c.cj, 0x5eed)) < f - n ? 1 : 0);
  }

  // ------------------------------------------------------------ geometry ----

  // cumulative arc length of a polyline, cached on the road record (traffic.js
  // stamps its own `_tg` the same way). Float64 so two clients that computed
  // the same sum get the same bits.
  _cum(r) {
    let c = r._pedCum;
    if (!c) {
      const p = r.p;
      c = new Float64Array(p.length);
      for (let i = 1; i < p.length; i++)
        c[i] = c[i - 1] + dist(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
      r._pedCum = c;
    }
    return c;
  }

  // world position + unit travel direction at arc `s` from node 0
  _along(r, s, out) {
    const c = this._cum(r), p = r.p, n = p.length;
    const total = c[n - 1];
    if (!(s > 0)) s = 0; else if (s > total) s = total;
    let i = 1;
    while (i < n - 1 && c[i] < s) i++;
    const a = p[i - 1], b = p[i];
    const segl = (c[i] - c[i - 1]) || 1;
    const t = (s - c[i - 1]) / segl;
    out.x = a[0] + (b[0] - a[0]) * t;
    out.z = a[1] + (b[1] - a[1]) * t;
    out.dx = (b[0] - a[0]) / segl;
    out.dz = (b[1] - a[1]) / segl;
    return out;
  }

  // A beat is a list of directed traversals. Step = { r, off, dir, base, len }:
  // walking `a` metres into the step sits at absolute arc `off + dir·a` on `r`.
  _stepPose(st, a, out) {
    this._along(st.r, st.off + st.dir * a, out);
    if (st.dir < 0) { out.dx = -out.dx; out.dz = -out.dz; }
    return out;
  }

  // Where a WALKER is, as opposed to where the centreline is: the beat position
  // plus the pavement offset, both smoothed so the result is continuous. See
  // SIDE_SMOOTH / SIDE_TAPER. `sign` is +1 walking out, −1 coming back.
  /**
   * How much of their sideways offset a walker keeps at `arc`, heading `sign`:
   * 1 on open pavement, 0 through a stretch _crossings marked tight, eased
   * over LAT_EASE metres either side so nobody sidesteps.
   */
  _latK(tight, arc, sign) {
    const t = tight ? tight[sign < 0 ? 1 : 0] : null;
    if (!t || !t.length) return 1;
    let k = 1;
    for (let i = 0; i < t.length; i += 2) {
      const d = arc < t[i] ? t[i] - arc : arc > t[i + 1] ? arc - t[i + 1] : 0;
      if (d >= LAT_EASE) continue;
      const v = d / LAT_EASE;
      if (v < k) k = v;
    }
    return k;
  }

  _walkPose(steps, arc, sign, side, span, out, bay = null) {
    this._poseOn(steps, arc, out);
    this._poseOn(steps, Math.max(0, arc - SIDE_SMOOTH), _A);
    this._poseOn(steps, Math.min(span, arc + SIDE_SMOOTH), _B);
    let dx = _B.x - _A.x, dz = _B.z - _A.z;
    const l = dist(dx, dz);
    if (l > 1e-6) { dx /= l; dz /= l; } else { dx = out.dx; dz = out.dz; }
    if (sign < 0) { dx = -dx; dz = -dz; }
    // Two tapers, and the second one is not cosmetic. The chord is 2·SIDE_SMOOTH
    // long on a straight, shorter through a corner, and near ZERO where the beat
    // hairpins — two pavements two metres apart that meet at one node, which the
    // real graph is full of. A near-zero chord has an unstable direction, so the
    // perpendicular would swing through 180° between frames and throw the walker
    // 1.8 m sideways (measured). Fading the offset out as the chord shortens
    // makes that impossible: where the route doubles back, the walker is simply
    // on the centreline.
    const kc = Math.min(1, l / (2 * SIDE_SMOOTH));
    const k = kc * Math.min(1, Math.max(0, Math.min(arc, span - arc)) / SIDE_TAPER);
    out.x += -dz * SIDE * side * k;
    out.z += dx * SIDE * side * k;
    if (bay) {
      // round the bus lay-by (_crossings worked out how far, metre by metre)
      let i = arc | 0;
      const n = (bay.length >> 1) - 2;
      if (i > n) i = n;
      const f = arc - i, gx = bay[2 * i + 2] - bay[2 * i], gz = bay[2 * i + 3] - bay[2 * i + 1];
      out.x += bay[2 * i] + gx * f;
      out.z += bay[2 * i + 1] + gz * f;
      if (gx !== 0 || gz !== 0) {
        // …facing the way they really move while the line bends out and back
        dx += gx * sign; dz += gz * sign;
        const m = dist(dx, dz);
        if (m > 1e-6) { dx /= m; dz /= m; }
      }
    }
    out.dx = dx; out.dz = dz;
    return out;
  }

  _poseOn(steps, arc, out) {
    let i = steps.length - 1;
    while (i > 0 && arc < steps[i].base) i--;
    const st = steps[i];
    let a = arc - st.base;
    if (a < 0) a = 0; else if (a > st.len) a = st.len;
    return this._stepPose(st, a, out);
  }

  // At a path end, step onto another path that starts nearby — a real junction
  // of pavements. The candidate list is CANONICALLY SORTED before the hash
  // picks from it, which is what makes two clients that streamed the region in
  // different orders walk the same route.
  //
  // Returns [link, step] or [step]. THE LINK IS NOT COSMETIC. Two ways "meet"
  // if their ends are within JOIN_R, and JOIN_R is 7 m because OSM pavements
  // routinely stop a few metres short of the kerb they continue over. Without
  // a link the walker jumps that gap in one frame — measured at up to 5.9 m,
  // which is a teleport, i.e. exactly the class of bug this file was rewritten
  // to kill. The link is a two-node synthetic way across the gap: they walk
  // the crossing instead of blinking over it.
  _nextStep(st, h) {
    const endA = st.off + st.dir * st.len;
    this._along(st.r, endA, _P);
    const ex = _P.x, ez = _P.z;
    const bi = Math.floor(ex / JOIN_R), bj = Math.floor(ez / JOIN_R);
    let opts = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const b = this._ends.get((bi + i) + ',' + (bj + j));
      if (!b) continue;
      for (const e of b) {
        if (e.r === st.r) continue;
        const [x, z] = e.r.p[e.node];
        if (dist(x - ex, z - ez) > JOIN_R) continue;
        opts.push(e);
      }
    }
    if (!opts.length) return null;
    opts.sort((a, b) => cmpPath(a.r, b.r) || (a.node - b.node));
    // PEOPLE CROSS AT THE CROSSING. Two pavement ends "meet" across up to 7 m
    // of gap, and that gap is often a carriageway with no zebra on it. Where
    // the junction offers any way onward that is not a walk through traffic,
    // the ones that are drop out of the draw. (When every way onward crosses,
    // they cross: a town where nobody ever jaywalks is not this town.)
    if (opts.length > 1) {
      let safe = 0;
      for (const o of opts) { o.jay = this._jaywalks(ex, ez, o, st.r.l); if (!o.jay) safe++; }
      if (safe && safe < opts.length) opts = opts.filter((o) => !o.jay);
    }
    const e = opts[(rnd01(h) * opts.length) | 0];
    const total = e.r._plen;
    const [nx, nz] = e.r.p[e.node];
    const next = e.node === 0
      ? { r: e.r, off: 0, dir: 1, base: 0, len: total }
      : { r: e.r, off: total, dir: -1, base: 0, len: total };
    const gap = dist(nx - ex, nz - ez);
    if (gap < 0.25) return [next];
    const bridge = { p: [[ex, ez], [nx, nz]], _plen: gap };
    return [{ r: bridge, off: 0, dir: 1, base: 0, len: gap }, next];
  }

  // ---------------------------------------------------------- population ----

  // Walk the cells that could hold a walker who ends up near the player and
  // make sure every slot in them has a beat. Everything here is a function of
  // (cell, slot, generation); the player's position only decides WHERE WE
  // LOOK, never what we find.
  _scanCells(wt, fx, fz) {
    const ci0 = Math.floor((fx - PHANTOM_R) / PCELL), ci1 = Math.floor((fx + PHANTOM_R) / PCELL);
    const cj0 = Math.floor((fz - PHANTOM_R) / PCELL), cj1 = Math.floor((fz + PHANTOM_R) / PCELL);
    let budget = BIRTH_BUDGET;
    for (let ci = ci0; ci <= ci1; ci++) {
      for (let cj = cj0; cj <= cj1; cj++) {
        const key = ci + ',' + cj;
        const c = this._cells.get(key);
        if (!c) continue;
        const cd = dist((ci + 0.5) * PCELL - fx, (cj + 0.5) * PCELL - fz) - PCELL_HALF_DIAG;
        if (cd > ATTACH_R + ROUTE_MAX) continue;
        const slots = this._slots(c);
        for (let k = 0; k < slots; k++) {
          const sk = key + '/' + k;
          if (this._pool.has(sk)) continue;
          if (budget-- <= 0) return;
          this._birth(sk, c, k, wt);
        }
      }
    }
  }

  // Does the hop from (ex, ez) onto path end `o` cross a real carriageway where
  // no zebra is painted? Driveways and car park aisles do not count: a pavement
  // is cut by one every thirty metres and nobody detours for them.
  _jaywalks(ex, ez, o, layer) {
    const [nx, nz] = o.r.p[o.node];
    if (dist(nx - ex, nz - ez) < 0.25) return false;
    const hits = this.drive.crossSeg(ex, ez, nx, nz, layer, []);
    for (const h of hits) {
      if (h.r.t === 'service') continue;
      if (!this.sites.has(SITE.ZEBRA, h.cx, h.cz, 5)) return true;
    }
    return false;
  }

  // WHO WALKS TOGETHER. An odd slot whose even neighbour drew the pair roll is
  // that neighbour's companion: it takes the neighbour's schedule seed, so the
  // two share a generation, a beat, a pace and a timetable, and differ only in
  // who they are and which side of each other they walk on. Two ordinary slots
  // with one timeline: nothing in the sweep has to know that pairs exist, and
  // when the density thins the companion (the higher index) is the one to go.
  _lead(ci, cj, k) {
    const lead = k & ~1;
    return rnd01(hash32(WORLD_SEED, ci, cj, lead, 0x9a17)) < PAIR_P ? lead : -1;
  }

  // Mint one citizen's entire existence from hash32(cell, slot, generation).
  _birth(sk, c, k, wt) {
    const arr = this._cellPaths(c);
    if (!arr.length) return;
    const lead = this._lead(c.ci, c.cj, k);
    const ss = hash32(WORLD_SEED, c.ci, c.cj, k);
    // the SCHEDULE seed: a companion's is its leader's
    const sr = lead >= 0 ? hash32(WORLD_SEED, c.ci, c.cj, lead) : ss;
    const ph = rnd01(hash32(sr, 7)) * TRIP_T;    // slots must not all flip together
    const gen = Math.floor((wt + ph) / TRIP_T);
    if (this._dud.get(sk) === gen) return;       // already planned this generation, and nothing to walk
    const seed = hash32(ss, gen, 0x1d3);         // who they are: face, clothes, voice
    const rs = lead >= 0 ? hash32(sr, gen, 0x1d3) : seed;   // where they go, and when

    // start path: first candidate long enough, from a hashed offset into the
    // cell's canonical list — never index 0, which would pile every generation
    // onto the same pavement
    let r = null;
    const i0 = (rnd01(hash32(rs, 1)) * arr.length) | 0;
    for (let n = 0; n < 4 && n < arr.length; n++) {
      const cand = arr[(i0 + n) % arr.length];
      if (cand._plen >= MIN_PATH) { r = cand; break; }
    }
    if (!r) return;

    const total = r._plen;
    const dir = (hash32(rs, 3) & 1) ? 1 : -1;
    // leave at least 8 m of path in front of them, else the first step is a
    // turn-around on the spot
    const room = Math.max(0, total - 8);
    const off = dir > 0 ? rnd01(hash32(rs, 2)) * room : 8 + rnd01(hash32(rs, 2)) * room;
    const first = { r, off, dir, base: 0, len: dir > 0 ? total - off : off };
    const side = (hash32(rs, 5) & 1) ? 1 : -1;

    // THE OLD MAN SETS THE PACE. A ninety-year-old with a stick (js/people.js
    // m90, whose short shuffling stride js/gait.js draws) was walked at the
    // crowd's 1.15 to 1.55 m/s, hurrying along like a wound-up toy. He walks
    // at his own pace, and whoever walks with him walks at it too. Who is old
    // is read from the same seeds the bodies are built from, so the timeline
    // (which is cut from this speed) stays shared.
    let old = isOld(seed);
    if (lead >= 0) old = old || isOld(hash32(hash32(WORLD_SEED, c.ci, c.cj, k === lead ? lead + 1 : lead), gen, 0x1d3));

    const s = {
      key: sk, ci: c.ci, cj: c.cj, k, cell: c, seed, gen, rs, ph,
      t0: gen * TRIP_T - ph,
      speed: old ? OLD_SPEED_MIN + rnd01(hash32(rs, 4)) * OLD_SPEED_VAR : SPEED_MIN + rnd01(hash32(rs, 4)) * SPEED_VAR,
      side,
      // signed distance off the centreline, in units of SIDE: a pair shares a
      // side of the pavement and walks shoulder to shoulder on it
      lat: side * (lead < 0 ? 1 : k === lead ? PAIR_IN : PAIR_OUT),
      pair: lead < 0 ? 0 : k === lead ? 1 : 2,
      routeM: ROUTE_MIN + rnd01(hash32(rs, 6)) * ROUTE_VAR,
      steps: [first], span: first.len,
      stops: null, cross: null, tl: null,   // the day: see _plan
      bay: null,       // how far the walking line steps out round a bus lay-by, per metre (see _crossings)
      body: null,      // the mesh, when one is warranted
      held: 0,         // 1 = this slot lost its citizen to a car (or to a bus);
                       // stays empty until the generation rolls, so a corpse's
                       // place is not quietly refilled while the player stands over it
    };
    this._grow(s);
    if (s.span < 4) return;             // a stub with nowhere to go: skip the slot
    if (!this._plan(s)) {               // …or one whose walkable part is that short (see _plan)
      // The sweep asks for every empty slot four times a second, and finding
      // this out again costs a walk down the whole beat: remember the answer
      // for the generation (0.6 ms a sweep round the old town otherwise).
      if (this._dud.size > 4096) this._dud.clear();
      this._dud.set(sk, gen);
      return;
    }
    this._pool.set(sk, s);
  }

  // Build the beat out to routeM at birth, not lazily. Lazy growth would make
  // `span` depend on how long the client has been watching, and span is what
  // the timeline folds against: two clients must agree on it exactly.
  _grow(s) {
    while (s.span < s.routeM && s.steps.length < ROUTE_STEPS) {
      let last = s.steps[s.steps.length - 1];
      const nx = this._nextStep(last, hash32(s.rs, s.steps.length, 0x51));
      if (!nx) break;                   // dead end, or the next tile has not
                                        // streamed yet: the beat is simply shorter
      for (const step of nx) {          // [crossing, way] or just [way]
        step.base = last.base + last.len;
        s.steps.push(step);
        s.span = step.base + step.len;
        last = step;
      }
    }
    if (s.span > s.routeM) s.span = s.routeM;
  }

  // ---- the day: what this citizen does along the beat ----------------------
  // Everything a walker will do for the whole generation is decided HERE, once:
  // which stretches of the beat are carriageway, which benches, stops and
  // windows stand beside it, whether they arrive by bus or leave by one. The
  // answer is a timeline (js/dwell.js), and from then on where they are is a
  // lookup in it. Inputs are the beat, the seed and pure functions of the
  // shared clock, so it is the same timeline on every client.
  _plan(s) {
    const rs = s.rs;
    s.cross = this._crossings(s);
    // NOBODY TURNS ROUND IN THE MIDDLE OF THE ROAD. A beat is cut to length,
    // and the cut (or the hashed starting point) can land on a carriageway:
    // the walker then reached the turn-around, stood on the asphalt and walked
    // back, which is where a share of the people run over were standing. The
    // two ends are pulled in to the pavement: `lo` is where the walk starts
    // and turns at the near end, `span` at the far one.
    //
    // AND NOBODY WALKS ALONG ONE. A footway the map drew inside a street's own
    // width (a pavement three metres from the centreline of a way tagged eight
    // metres wide) reads here as a "crossing" a hundred metres long: the walker
    // spent a minute on what the traffic takes for asphalt, and every car on
    // the street crawled behind them for that minute (27 of the 750 beats round
    // the old town, and most of the cars standing in Husova). A run that long
    // is not somewhere to cross: the beat ends on the pavement before it.
    for (const c of s.cross) {
      if (c.g1 - c.g0 <= ALONG_MAX || c.g0 <= 1.5) continue;
      const g0 = c.g0;
      s.span = Math.max(0, g0 - 1.5);
      s.cross = s.cross.filter((q) => q.g0 < g0);
      break;
    }
    s.lo = 0;
    if (s.cross.length && s.cross[0].g0 <= 1.5) {
      s.lo = Math.min(s.span, s.cross[0].g1 + 1.5);
      s.cross = s.cross.filter((c) => c.g0 > 1.5);
    }
    const lastX = s.cross[s.cross.length - 1];
    if (lastX && lastX.g1 >= s.span - 1.5) {
      s.span = Math.max(s.lo, lastX.g0 - 1.5);
      const g0 = lastX.g0;
      s.cross = s.cross.filter((c) => c.g0 !== g0);
    }
    // WHAT IS LEFT HAS TO BE A WALK. _birth's own "stub with nowhere to go"
    // guard ran before the two ends were pulled in, and a short beat that
    // starts or ends on a road can be left with a pavement of a metre or two:
    // its walker turned round every second step for seven minutes (up to 105
    // turns a minute, measured), and with under half a metre the timeline had
    // one key and no position at all. Same answer as for the stub: no slot.
    // (A pair shares the beat, so the two of them go together.)
    if (s.span - s.lo < 4) return false;
    s.stops = this._stopsBeside(s);
    s.seat = null; s.seatRev = this._benchRev;
    const now = this.now();
    for (const st of s.stops) {
      if (st.kind !== DW.BENCH) continue;
      let u = this._benchers.get(st.sid);
      if (!u) this._benchers.set(st.sid, u = new Set());
      // out go the generations nobody on this bench can have sat beside any
      // more, and an earlier copy of this very one (a slot minted again after
      // the viewer went away and came back)
      for (const o of u) if (now > o.t0 + TRIP_T + SEAT_KEEP || (o.key === s.key && o.gen === s.gen)) u.delete(o);
      u.add(s);
      // Somebody whose day began before this client knew of them (a cold
      // boot, a square that has just come into range) may have been on the
      // bench before people already seated by _seatOf without them: those
      // answers are worked out again, with everybody in.
      if (now - s.t0 > 1) this._benchRev++;
    }
    const groups = this._groups(s.cross);
    const o = {
      t0: s.t0, tEnd: s.t0 + TRIP_T + 2, span: s.span, lo: s.lo, speed: s.speed, seed: rs,
      stops: s.stops, cross: groups, talk: s.pair > 0,
    };
    if (this.signalWait) {
      // a group under lights waits for the member that makes it wait longest
      o.waitAt = (i, t) => {
        const g = groups[i];
        if (!g.sig) return 0;
        let w = 0;
        for (const c of g.m) {
          if (!c.sig) continue;
          const v = this.signalWait(c.cx, c.cz, c.rdx, c.rdz, t, (g.a1 - g.a0) / s.speed) ?? 0;
          if (v > w) w = v;
        }
        return w;
      };
    }
    // …by bus. One roll per ROUTE seed, so a pair travels together. A boarder
    // walks to the first served stop on the way out and is gone when the bus
    // calls; an alighter does not exist until a bus has called, and steps off it.
    s.board = -1; s.alight = null;
    if (this.busEta) {
      const roll = rnd01(hash32(rs, 0xb05));
      const want = roll < BOARD_P ? 1 : roll < BOARD_P + ALIGHT_P ? 2 : 0;
      for (let i = 0; want && i < s.stops.length; i++) {
        const st = s.stops[i];
        if (st.kind !== DW.STOP) continue;
        if (want === 1) {
          const tAt = s.t0 + st.arc / s.speed;        // earliest they can be there
          const eta = this.busEta(st.site.x, st.site.z, tAt + 3);
          if (!(eta - tAt < BOARD_MAX_WAIT)) continue;
          s.board = i;
          o.board = { stop: i, until: (t) => {
            const e = this.busEta(st.site.x, st.site.z, t + 3);
            return e - t < BOARD_MAX_WAIT ? e + BOARD_GRACE : NaN;
          } };
        } else {
          const eta = this.busEta(st.site.x, st.site.z, s.t0 + rnd01(hash32(rs, 0xa117)) * 90);
          if (!(eta < s.t0 + TRIP_T * 0.55)) continue;
          s.alight = { stop: i, arc: st.arc, t: eta + 4 };
          o.alight = s.alight;
        }
        break;
      }
    }
    s.tl = buildTimeline(o);
    return true;
  }

  // The stretches of the beat that lie on a carriageway, one record PER ROAD:
  // [{ a0, a1, kerb, zebra, sig, cx, cz, rdx, rdz, hw, g0, g1 }]. `kerb` says it
  // is a road worth stopping to look at (not a driveway), `zebra` that a
  // crossing is painted there, `sig` that lights govern it. Crossings that
  // touch (a junction mouth, the two halves of a dual carriageway with no
  // refuge between) form one GROUP, g0..g1: a walker decides at the group's
  // kerb and then walks the whole of it, and never stops between two lanes.
  _crossings(s) {
    // WALKED, not intersected. Testing each piece of the beat against each
    // carriageway centreline finds the clean crossings and misses the rest: a
    // path that ends at the edge of a car park aisle, one that clips the
    // corner of a junction mouth, one that runs a few metres along a service
    // road before leaving it. Those are exactly where people were being run
    // over. So the beat is walked a metre at a time and asked "whose asphalt
    // is this?", and a crossing is a run of the same answer.
    const out = [], open = [], hits = [];
    // WHERE THE PAVEMENT IS TOO NARROW TO WALK ASIDE. A walker keeps to one
    // side of the path (and the outer one of a pair a step and a half out),
    // and a footway that runs beside a street puts that side over the kerb:
    // the path itself is on no carriageway, so no crossing is recorded and no
    // driver told, and the body is half a metre into the lane. Every person
    // the traffic killed in half an hour of the old town was walking like
    // that, hit by a wing mirror at 30 to 60 km/h. So the beat also remembers,
    // per direction of travel, the stretches where its walking line would be
    // on or within KERB_SHY of asphalt, and there the walker keeps to the
    // middle of the path (_latK). Pure geometry of the beat: shared.
    const tight = s.tight = [[], []];
    // AND ROUND THE BUS LAY-BY, NOT THROUGH IT. The map draws no lay-bys; the
    // game makes one at a stop (js/streets.js), three metres of asphalt taken
    // out of the pavement, and the bus pulls into it. A footway mapped a metre
    // behind the street's nominal kerb (one lay-by in three has one) then runs
    // through the bay: its walkers were under the bus as it pulled in, or
    // walked into its side while it stood there. The kerb steps out round the
    // bay and so does the walking line: per metre of beat, how far it has to
    // move out to pass BAY_CLEAR behind that kerb. Only where the path runs
    // ALONG the street: one that crosses it there is a crossing. A function of
    // the beat and the map, like `tight`.
    let bay = null, walled = null;
    const bayN = Math.floor(s.span) + 3, bayOut = BAY_CLEAR + SIDE * (s.pair ? PAIR_OUT : 1);
    const close = (run) => {
      const mid = run.hit;
      const zebra = this.sites.has(SITE.ZEBRA, mid.qx, mid.qz, 5);
      out.push({ a0: Math.max(0, run.a0 - 0.6), a1: Math.min(s.span, run.a1 + 0.6),
        kerb: mid.r.t !== 'service' && mid.hw >= 2, zebra: !!zebra, sig: false,
        cx: mid.qx, cz: mid.qz, rdx: mid.dx, rdz: mid.dz, hw: mid.hw, g0: 0, g1: 0 });
    };
    let si = 0;
    for (let a = 0; a <= s.span; a += 1) {
      while (si < s.steps.length - 1 && a >= s.steps[si + 1].base) si++;
      this._poseOn(s.steps, a, _P);
      const lb = this.drive.layby(_P.x, _P.z, s.steps[si].r.l, bayOut, _LB);
      if (lb && Math.abs(lb.dx * _P.dx + lb.dz * _P.dz) > 0.7) {
        // (not out of the bay and onto the asphalt of the street behind it, or
        // through the wall of a house that stands where the bay was made: there
        // the line stays where the map drew it)
        const qx = _P.x + lb.nx * lb.push, qz = _P.z + lb.nz * lb.push, far = bayOut - BAY_CLEAR;
        if (!this.drive.on(qx, qz, s.steps[si].r.l, KERB_SHY)
          && !this._inBuilding(qx, qz) && !this._inBuilding(qx + lb.nx * far, qz + lb.nz * far)) {
          bay ??= new Float32Array(2 * bayN);
          bay[2 * a] = lb.nx * lb.push; bay[2 * a + 1] = lb.nz * lb.push;
        } else (walled ??= new Uint8Array(bayN))[a] = 1;
      }
      hits.length = 0;
      this.drive.onAll(_P.x, _P.z, s.steps[si].r.l, hits);
      // …and the same question for where they will actually WALK, which is to
      // one side of the path: see tightOf
      // (asphalt the path itself is crossing here does not count: a walker on
      // a zebra is on the road by right, and keeps their side of it)
      if (s.lat) {
        for (let d = 0; d < 2; d++) {
          this._walkPose(s.steps, a, d ? -1 : 1, s.lat, s.span, _T);
          const o = this.drive.on(_T.x, _T.z, s.steps[si].r.l, KERB_SHY, !!s.steps[si].r.br);
          if (!o) continue;
          let own = false;
          for (const h of hits) if (h.r === o.r) own = true;
          if (own) continue;
          const t = tight[d], n = t.length;
          if (n && a - t[n - 1] <= 2.5) t[n - 1] = a; else t.push(a, a);
        }
      }
      for (const h of hits) {
        let run = null;
        for (const o of open) if (o.r === h.r) run = o;
        if (!run) open.push(run = { r: h.r, a0: a, a1: a, hit: h, deep: h.d });
        else {
          run.a1 = a;
          // the record of the crossing is taken where the walker is deepest in
          if (h.d < run.deep) { run.deep = h.d; run.hit = h; }
        }
      }
      for (let i = open.length - 1; i >= 0; i--) {
        if (a - open[i].a1 > 1.6) { close(open[i]); open.splice(i, 1); }
      }
    }
    for (const run of open) close(run);
    if (bay) {
      // ease in and out over a few metres, so nobody sidesteps where the path
      // turns away from the street half way along a bay
      const tmp = new Float32Array(bay.length);
      for (let pass = 0; pass < 3; pass++) {
        tmp.set(bay);
        for (let i = 2; i < bay.length - 2; i++) bay[i] = walled && walled[i >> 1] ? 0 : (tmp[i - 2] + 2 * tmp[i] + tmp[i + 2]) / 4;
      }
    }
    s.bay = bay;
    out.sort((p, q) => (p.a0 - q.a0) || (p.cx - q.cx) || (p.cz - q.cz));
    for (let i = 0, k = 0; i <= out.length; i++) {
      // k..i-1 is a group once i starts beyond its reach (or the list ends)
      if (i === out.length || (i > k && out[i].a0 > out[k].g1 + 1.5)) {
        for (let j = k; j < i; j++) { out[j].g0 = out[k].a0; out[j].g1 = out[k].g1; }
        k = i;
      }
      if (i === out.length) break;
      if (i === k) out[k].g1 = out[i].a1;
      else if (out[i].a1 > out[k].g1) out[k].g1 = out[i].a1;
    }
    // Lights: only the traffic knows which junction's clock a crossing runs
    // on, so the hook has the last word (null = nothing governs this spot).
    for (const c of out)
      c.sig = !!(this.signalWait && c.kerb && this.signalWait(c.cx, c.cz, c.rdx, c.rdz, s.t0, 0) !== null);
    return out;
  }

  // Is (x, z) inside the footprint of a building? Asked a few dozen times for a
  // beat that passes a lay-by, never per frame. A roof on posts (a bus shelter,
  // a canopy) is not a wall: people walk under those.
  _inBuilding(x, z) {
    const cell = this.city.chunkIndex?.get(Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK));
    if (!cell?.buildings) return false;
    for (const b of cell.buildings) {
      const o = b.o;
      if (!o || b.t === 'roof') continue;
      let inside = false;
      for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
        const zi = o[i][1], zj = o[j][1];
        if ((zi > z) !== (zj > z) && x < (o[j][0] - o[i][0]) * (z - zi) / (zj - zi) + o[i][0]) inside = !inside;
      }
      if (inside) return true;
    }
    return false;
  }

  // The groups of s.cross, as js/dwell.js wants them: one kerb per group.
  _groups(cross) {
    const out = [];
    for (const c of cross) {
      let g = out[out.length - 1];
      if (!g || g.a0 !== c.g0) out.push(g = { a0: c.g0, a1: c.g1, kerb: false, sig: false, m: [] });
      if (c.kerb) g.kerb = true;
      if (c.sig) g.sig = true;
      g.m.push(c);
    }
    return out;
  }

  // The things beside the beat a walker may stop at, as js/dwell.js wants them.
  // The beat is sampled every 4 m; a site belongs to the sample nearest it.
  _stopsBeside(s) {
    const found = new Map(), near = [];
    for (let a = 0; a <= s.span; a += 4) {
      this._poseOn(s.steps, a, _P);
      near.length = 0;
      this.sites.near(_P.x, _P.z, STOP_R, near);
      for (const q of near) {
        if (q.kind === SITE.ZEBRA) continue;
        const d = dist(q.x - _P.x, q.z - _P.z);
        const f = found.get(q);
        if (!f || d < f.d) found.set(q, { d, arc: a });
      }
    }
    const out = [];
    for (const [q, f] of found) {
      // refine to the metre, so the walker turns off the path opposite the bench
      let arc = f.arc, bd = f.d;
      for (let a = Math.max(0, f.arc - 3); a <= Math.min(s.span, f.arc + 3); a += 1) {
        this._poseOn(s.steps, a, _P);
        const d = dist(q.x - _P.x, q.z - _P.z);
        if (d < bd) { bd = d; arc = a; }
      }
      if (arc < s.lo + 2 || arc > s.span - 2) continue;       // not at the turn-around
      let onRoad = false;
      for (const c of s.cross) if (arc > c.g0 - 2 && arc < c.g1 + 2) onRoad = true;
      if (onRoad) continue;
      if (q.kind === SITE.BENCH) {
        if (bd > BENCH_R) continue;
        const rd = this.drive.nearest(q.x, q.z, 8);
        if (rd && rd.d < rd.hw + 0.3) continue;        // a bench mapped in the road
        out.push({ arc, kind: DW.BENCH, p: 0.42, min: 24, vr: 44, sid: q.sid, site: q, d: bd });
      } else if (q.kind === SITE.STOP) {
        out.push({ arc, kind: DW.STOP, p: 0.2, min: 10, vr: 26, sid: q.sid, site: q, d: bd });
      } else if (bd <= SHOP_R) {
        const food = q.kind === SITE.FOOD;
        out.push({ arc, kind: food ? DW.FOOD : DW.WINDOW, p: food ? 0.2 : 0.16,
          min: food ? 8 : 4, vr: food ? 18 : 8, sid: q.sid, site: q, d: bd });
      }
    }
    // canonical order: the timeline hashes by site, but ties in arc must not
    // depend on the order a Map happened to be filled in
    out.sort((a, b) => (a.arc - b.arc) || (a.sid - b.sid));
    return out;
  }

  // Where the timeline says this citizen is at shared time `wt`: how far along
  // the beat, which way they are heading (`sign`, +1 out, -1 home), how far
  // they have walked in all, and what they are doing there (kind, ref, tIn,
  // tOut, v: see sampleTimeline). Returns ONE shared scratch record: read it
  // before the next call.
  _arcAt(s, wt) {
    return sampleTimeline(s.tl, wt, _TL);
  }

  // ------------------------------------------------------------ visibility ----

  // Tell us where the local camera is. THE SIGNATURE IS traffic.js's, field for
  // field, so main.js builds one descriptor a frame and hands the same object
  // to both — two systems asking the same question of the same camera may not
  // disagree about the answer:
  //
  //   const v = { camera, fogFar: scene.fog?.far };
  //   traffic.setViewer(v);
  //   peds.setViewer(v);
  //
  // Accepted shapes, all optional-fielded:
  //   setViewer(null)                     forget the camera (see below)
  //   setViewer({ camera, fogFar })       camera: a THREE.PerspectiveCamera —
  //                                       anything with .position, .fov in
  //                                       DEGREES, .aspect, .getWorldDirection
  //   setViewer({ x, z, dirX, dirZ,       explicit and headless-friendly.
  //               fovRad, aspect, fogFar })  dirX/dirZ need not be normalised;
  //                                       fovRad is the VERTICAL fov in radians
  //                                       and is combined with `aspect` into the
  //                                       horizontal one, exactly as three.js
  //                                       does. Defaults 1.05 rad and 16/9.
  // `hideR` may be given outright instead of fogFar and wins.
  //
  // WITHOUT IT this file does NOT fall back to "nothing is visible" the way
  // traffic.js does, and the difference is deliberate: a car's old spawn radius
  // was 520 m, so v8 semantics were merely unimproved, whereas a pedestrian's
  // was 18 m, and re-enabling that is the actual bug. No camera ⇒ we cannot
  // tell front from back ⇒ we assume every direction is watched out to BLIND_R.
  setViewer(v) {
    if (!v) { this.view = null; return; }
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
    if (!Number.isFinite(x) || !Number.isFinite(z)) { this.view = null; return; }
    const dl = Math.sqrt(dx * dx + dz * dz);
    if (!(dl > 1e-6)) { this.view = null; return; }
    if (!Number.isFinite(fov) || fov <= 0) fov = 1.05;
    if (!Number.isFinite(aspect) || aspect <= 0) aspect = 16 / 9;
    // three.js `fov` is vertical; the horizontal half-angle something can hide
    // outside of is atan(tan(vfov/2) · aspect).
    const half = Math.atan(Math.tan(Math.min(fov, 3.0) / 2) * aspect) + VIEW_MARGIN;
    const hide = Math.max(HIDE_R_MIN, Math.min(HIDE_R_MAX,
      Number.isFinite(v.hideR) ? v.hideR
        : Number.isFinite(v.fogFar) ? v.fogFar * HIDE_FOG_K
          : HIDE_R_DFLT));
    this.view = { x, z, dx: dx / dl, dz: dz / dl,
      cos: Math.max(VIEW_COS_MIN, Math.cos(half)), hideR: hide };
  }

  // "Would the player fail to notice something happening here?" — the one
  // question every lifecycle decision in this file is gated on.
  //
  // Note which radius does the work. traffic.js hides its cars behind the fog
  // (hideR ≈ 558 m on the ground preset) because a car is 4.6 m of bodywork and
  // it can afford a 600 m ring. A citizen is 1.8 m of small boxes and the body
  // budget is a tenth of the fleet's, so what protects a pedestrian is not fog
  // but ANGULAR SIZE: past NOTICE_R (150 m) a walker is about twelve pixels
  // tall on a 1080p screen and one more or less of them is not a thing a person
  // can catch. hideR is still honoured — it only ever binds in weather thick
  // enough to close in tighter than 150 m.
  _hidden(x, z, px, pz) {
    const v = this.view;
    if (!v) return dist(x - px, z - pz) > BLIND_R;
    const dx = x - v.x, dz = z - v.z;
    const d = dist(dx, dz);
    if (d >= v.hideR) return true;                 // swallowed by the weather
    if (d >= NOTICE_R) return true;                // a few pixels in the haze
    if (d <= PERIPHERAL_R) return false;           // too close to risk, any bearing
    return (dx * v.dx + dz * v.dz) / d < v.cos;    // outside the protected cone
  }

  // ----------------------------------------------------------------- loop ----

  update(dt, focus) {
    const wt = this.now();
    const fx = focus.x, fz = focus.z;

    this._sweepT -= dt;
    if (this._sweepT <= 0) {
      const since = SWEEP_DT - this._sweepT;   // wall time this sweep covers
      this._sweepT = SWEEP_DT;
      const raw = (this.max ?? MAX_PEDS) / MAX_PEDS;
      this._densK = Math.max(0, Math.min(4, Math.round(raw * 32) / 32));
      if (this.rhythm) {
        const h = hourAt(wt), we = isWeekend(wt);
        this._kStreet = crowdK(h, we); this._kVenue = venueK(h, we);
      } else this._kStreet = this._kVenue = 1;
      // ORDER MATTERS, and it is traffic.js's order for traffic.js's reason: a
      // slot whose generation just rolled is retired (or ghosted) in the sweep,
      // and _scanCells immediately behind mints the next generation into the
      // same slot in the same tick. The shared crowd therefore never has a
      // hole, whatever the local camera made us defer.
      this._sweep(wt, fx, fz, since);
      this._scanCells(wt, fx, fz);
    }

    // --- cars vs. people ---
    this._hitPass();

    // --- walk / ragdoll ---
    this.crossers.length = 0;
    for (const p of this.peds) {
      if (p.hitCd > 0) p.hitCd -= dt;
      // 'held' before everything, because it is the one state this file does
      // NOT drive: no arc, no facing, no animate. See hold().
      if (p.state === 'held') { this._heldStep(p); continue; }
      if (p.state === 'board') { this._boardStep(p, dt); continue; }
      if (p.state !== 'walk') {
        this._ragStep(p, dt);
        // somebody lying in the road, or sliding across it, is something a
        // driver stops for too (and does not drive on over after a bump)
        this._noteBody(p);
        continue;
      }
      if (p.free) this._freeStep(p, dt);
      else this._schedStep(p, dt, wt);
    }

    this._bloodStep(dt);
  }

  // A walker on its schedule: position is read from shared time, never
  // integrated. `rush` is the only local term and it is a debt that drains:
  // ground gained running from a bang, or lost standing at a kerb while a car
  // went by.
  _schedStep(p, dt, wt) {
    const s = p.sch;
    const a = this._arcAt(s, wt);
    // _TL is one shared record: take what this frame needs before anything
    // below asks the timeline another question
    const nomArc = a.arc, sign = a.sign, kind = a.kind, ref = a.ref, visit = a.i;
    const tIn = a.tIn, tOut = a.tOut, walked = a.walked;
    const nomV = a.v * s.speed;
    // The timetable says they have left (by bus). Whether a bus is really
    // standing there is this client's to see: see _depart.
    if (kind === DW.GONE) { this._depart(p, s, ref); return; }

    const prev = p.rush;
    let holding = false;
    if (p.calm > 0) {
      // panicking: gain ground on the nominal, in whichever direction takes
      // them away from the bang (p.fleeSign was set when they were scared)
      p.calm -= dt;
      p.rush += (FLEE_SPEED - s.speed) * dt * p.fleeSign;
      if (p.rush > RUSH_MAX) p.rush = RUSH_MAX;
      else if (p.rush < -RUSH_MAX) p.rush = -RUSH_MAX;
    } else {
      // AT THE KERB, LOOK. The timeline already stopped them there for a
      // moment (and for the lights, where there are lights); what it cannot
      // know is the car coming down the road right now. A walker about to step
      // out stays where they are while something is bearing down on the
      // crossing, falls behind their own schedule by that much, and walks it
      // off afterwards. Bounded by HOLD_MAX, so two drivers waving each other
      // through cannot hold anybody for ever.
      if (Math.abs(p.rArc - nomArc) < HOLD_MAX
        && (this._kerbUnsafe(s.cross, p.rArc, sign, s.speed) || this._carInWay(p, s.cross, sign))) {
        holding = true;
        p.rush = p.rArc - nomArc;
      } else if (p.rush !== 0) {
        // pay the debt back: a little faster than their own pace while the
        // schedule walks, at a full stride while it stands waiting for them
        const step = (nomV > 0 ? Math.max(RUSH_DECAY, 0.4 * s.speed) : 1.3 * s.speed) * dt;
        p.rush -= Math.sign(p.rush) * Math.min(step, Math.abs(p.rush));
      }
    }
    const extra = p.rush - prev;
    let arc = nomArc + p.rush;
    if (arc < 0) arc = 0; else if (arc > s.span) arc = s.span;

    // Which way are they actually MOVING? The nominal advances at s.speed·sign
    // and `rush` adds to that, and a citizen running from a bang can perfectly
    // well be going the opposite way to their own schedule. Face and pass the
    // real direction, or a fleeing walker moonwalks down the pavement — and
    // walks down the wrong side of it, since which side is "the right side"
    // depends on which way you are heading.
    const vArc = (arc - p.rArc) / (dt || 1e-3);
    p.rArc = arc;
    const still = Math.abs(vArc) < 0.08;
    const dirS = still ? sign : (vArc < 0 ? -1 : 1);
    this._walkPose(s.steps, arc, dirS, s.lat * this._latK(s.tight, arc, dirS), s.span, _P, s.bay);
    let x = _P.x, z = _P.z, dx = _P.dx, dz = _P.dz;
    let moving = !still, sit = 0;
    this._noteCrossing(s.cross, arc, dirS, still, x, z);

    // ---- doing something there (js/dwell.js) ----
    if (still && nomV === 0 && kind !== DW.WALK && p.rush === 0 && !holding) {
      const d = this._dwellPose(p, s, kind, ref, tIn, tOut, visit);
      x = d.x; z = d.z; dx = d.dx; dz = d.dz; moving = d.moving; sit = d.sit;
      if (moving) p.stepT += STEP_SPEED * dt;
    }
    p.x = x;
    p.z = z;
    // fresh off the ground after a stun (or off a bus): ease from where they
    // were back onto the walk position instead of snapping
    if (p.blend > 0) {
      p.blend = Math.max(0, p.blend - dt * p.blendK);
      p.x += (p.bx - p.x) * p.blend;
      p.z += (p.bz - p.z) * p.blend;
      if (p.blend > 0.05) moving = true;
    }
    this._face(p, dx, dz, dt);
    // Stride phase from DISTANCE WALKED, so it is shared like everything else
    // and survives the turn-around at the end of the beat without a hitch.
    // `rushT` is the extra ground a panic covered — zero for everyone who has
    // not been scared, which is everyone, almost always.
    p.rushT += Math.abs(extra);
    p.walkT = (walked + p.rushT + p.stepT) * 1.6;
    p.speed = moving ? Math.max(Math.abs(vArc), sit ? 0 : 0.6) : 0;
    p.mesh.position.set(p.x, this._feet(p) - sit * p.sitDrop, p.z);
    p.mesh.rotation.y = p.heading;
    if (sit > 0) {
      // folded onto the seat. sitPose is a blend from standing, so easing `sit`
      // in and out is the whole animation.
      p.pose = 2;
      p.sitPose(sit, 0);   // 0: an upright bench seat, not the car posture (js/citizen.js)
    } else if (moving) {
      if (p.pose) { p.pose = 0; p.standPose(); }
      const sp = Math.abs(vArc) > 0.3 ? Math.abs(vArc) : STEP_SPEED;
      p.animate(p.walkT, Math.max(0.3, Math.min(1.3, sp / 1.4)), 0, sp);
    } else if (p.pose !== 1) {
      // STANDING. Not animate() with a floor of 0.3: that is a man jogging on
      // the spot at a bus stop (the same trap 'held' documents in the header).
      p.pose = 1;
      p.standPose();
    }
  }

  // On a carriageway, or within 5 m of stepping onto one?
  _nearRoad(cross, arc, sign) {
    if (!cross) return false;
    for (let i = 0; i < cross.length; i++) {
      const c = cross[i];
      if (sign > 0 ? (arc > c.g0 - 5 && arc < c.g1 + 0.5) : (arc < c.g1 + 5 && arc > c.g0 - 0.5)) return true;
    }
    return false;
  }

  // Is a walker at `arc`, heading `sign`, standing at a kerb they should not
  // step off yet? At the kerb means within KERB_NEAR short of a GROUP of
  // crossings; unsafe means any road of that group has something coming.
  _kerbUnsafe(cross, arc, sign, speed) {
    if (!cross) return false;
    for (let i = 0; i < cross.length; i++) {
      const c = cross[i];
      const de = sign > 0 ? c.g0 - arc : arc - c.g1;
      if (de < -0.05 || de > KERB_NEAR) continue;
      if (this._gapUnsafe(c, speed)) return true;
    }
    return false;
  }

  // Half way over, is there a car where the next stride goes? The look at the
  // kerb was honest, but a car can pull out of a side road afterwards, or stand
  // across the zebra in a queue; nobody walks into the wing of one. Only asked
  // of somebody actually on a carriageway.
  _carInWay(p, cross, sign) {
    if (!cross) return false;
    let on = false;
    for (let i = 0; i < cross.length && !on; i++) on = p.rArc > cross[i].g0 - 0.6 && p.rArc < cross[i].g1 + 0.6;
    if (!on) return false;
    // one stride ahead, the way they are facing
    const qx = p.x - Math.sin(p.heading) * 0.9, qz = p.z - Math.cos(p.heading) * 0.9;
    const pc = this.playerCar;
    if (pc && this._overCar(pc, qx, qz)) return true;
    const cars = this.cars;
    if (cars) for (const car of cars) if (car !== pc && this._overCar(car, qx, qz)) return true;
    return false;
  }

  _overCar(car, x, z) {
    const dx = x - car.x, dz = z - car.z;
    if (Math.abs(dx) > car.len || Math.abs(dz) > car.len) return false;
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    return Math.abs(dx * fx + dz * fz) < car.len / 2 + 0.5 && Math.abs(dx * fz - dz * fx) < car.wid / 2 + 0.5;
  }

  // Is something about to drive over crossing `c`? A walker asks before
  // stepping out. On a zebra (or under lights) drivers are expected to stop,
  // so only a car that physically cannot is a reason to wait; anywhere else
  // the walker needs a gap long enough to get across.
  _gapUnsafe(c, speed) {
    // time to be clear of THIS road, counted from the group's kerb
    const need = Math.min(8, (c.g1 - c.g0) / speed + 1.2);
    const pc = this.playerCar;
    if (pc && this._bearsDown(pc, c, need)) return true;
    // The traffic knows each car's ROUTE, which a look at its bonnet does not:
    // a car about to turn into this street is a threat a heading cannot see.
    if (this.roadBusy) return this.roadBusy(c.cx, c.cz, c.hw, need, c.zebra || c.sig);
    const cars = this.cars;
    if (cars) for (const car of cars) if (car !== pc && this._bearsDown(car, c, need)) return true;
    return false;
  }

  _bearsDown(car, c, need) {
    const v = car.vGround ?? Math.abs(car.speed);
    if (!(v > 1.6)) return false;
    const rx = c.cx - car.x, rz = c.cz - car.z;
    if (rx * rx + rz * rz > GAP_LOOK * GAP_LOOK) return false;
    const sg = car.speed < 0 ? -1 : 1;
    const hx = -Math.sin(car.heading) * sg, hz = -Math.cos(car.heading) * sg;
    const along = rx * hx + rz * hz;
    if (along < -1) return false;                       // already past
    if (Math.abs(rx * hz - rz * hx) > c.hw + 1.8) return false;   // not coming through here
    if (c.zebra || c.sig) return v * v / (2 * Math.max(0.5, along - 5)) > 5.5;
    return (along - 2.5) / v < need;
  }

  // Tell the traffic about a walker on a carriageway or about to be. `must`:
  // on the asphalt, or stepping onto it (a driver brakes as hard as it takes).
  // Otherwise the walker is WAITING at the kerb of a zebra, which a driver who
  // can stop comfortably does stop for; waiting anywhere else is the walker's
  // own business and is not reported at all.
  _noteCrossing(cross, arc, sign, still, x, z) {
    if (!cross) return;
    for (let i = 0; i < cross.length; i++) {
      const c = cross[i];
      // on the group's asphalt at all: every road of it is told, because the
      // walker is about to be on each of them
      let must = arc > c.g0 - 0.3 && arc < c.g1 + 0.3;
      if (must) {
        // …except the roads of the group already behind them
        if (sign > 0 ? arc > c.a1 + 0.3 : arc < c.a0 - 0.3) continue;
      } else {
        const de = sign > 0 ? c.g0 - arc : arc - c.g1;
        if (de < 0 || de > KERB_NEAR + 0.6) continue;
        if (still) { if (!c.zebra) continue; }
        else must = true;
      }
      const n = this.crossers.length;
      const o = this._crossPool[n] ??= { cx: 0, cz: 0, rdx: 0, rdz: 0, hw: 0, must: false, x: 0, z: 0, body: false, stale: false };
      o.cx = c.cx; o.cz = c.cz; o.rdx = c.rdx; o.rdz = c.rdz; o.hw = c.hw;
      o.must = must; o.x = x; o.z = z; o.body = false; o.stale = false;
      this.crossers.push(o);
    }
  }

  _noteBody(p) {
    // A corpse that has sunk into the ground is nothing to stop for. It stays
    // in the list until nobody is looking (the sweep's rule), and while it was
    // reported every car on that road stood for an empty patch of asphalt.
    if (p.state === 'dead' && p.deadT < CORPSE_FADE) return;
    const o = this._crossPool[this.crossers.length] ??= { cx: 0, cz: 0, rdx: 0, rdz: 0, hw: 0, must: false, x: 0, z: 0, body: false, stale: false };
    o.cx = o.x = p.x; o.cz = o.z = p.z; o.rdx = 0; o.rdz = 0; o.hw = 1; o.must = true; o.body = true;
    // …and one that has lain there a while is driven round at a crawl, not
    // stood at: a minute of every driver in turn waiting out their patience at
    // the same body was a jam across the whole junction (js/traffic.js).
    o.stale = p.state === 'dead' && p.deadT < CORPSE_TIME - BODY_FRESH;
    this.crossers.push(o);
  }

  // Where a walker stands, and which way they face, while the timeline has
  // them DOING something: on the bench, under the shelter, at the window. The
  // way over there and back is walked (u runs 0 to 1 and back), so nobody
  // slides sideways onto a seat. Reads the path pose from _P, answers in _D.
  // ---- who sits where on a bench ----------------------------------------
  // A bench seats two. Which half a walker takes used to be one hashed bit of
  // their own, so two strangers whose bits agreed sat in each other's laps.
  // Now it is first come, first seated: a walker has the half they would have
  // picked unless somebody who sat down EARLIER has it, then the other half,
  // and with both taken they stand at the end of the bench. A pair sits down
  // together or not at all.
  //
  // THE ANSWER IS A FUNCTION OF THE SCHEDULES AND OF NOTHING THIS CLIENT DID.
  // Three things made it depend on the client, and each put two people on one
  // seat or seated the same person differently on two screens:
  //   - it was remembered per BENCH, and a walker passes the same bench on
  //     every leg of the beat: the half taken on the way out was sat on again
  //     on the way back, whoever had sat down there in between (the overlaps
  //     still measured: a pair, and a stranger in the lap of one of them).
  //     One VISIT is one keyframe of the timeline, and that is what is
  //     remembered now.
  //   - "who was there before me" was asked of the slots in _pool at the
  //     moment a BODY first needed the answer, so it turned on when this
  //     client gave whom a body: somebody whose generation had rolled since
  //     was forgotten, somebody not minted yet was not counted. A schedule now
  //     stays in the bench's list for SEAT_KEEP seconds after its generation
  //     and answers for the time it was alive, and a schedule that turns up
  //     late (_plan) has every answer worked out again with it in.
  //   - arrival times were rebuilt as now() - tIn. They are read off the
  //     timelines' own keyframes: the same bits on every client, so "the same
  //     instant, lower key first" is exact.
  // What a client cannot know is a generation that ended before it arrived
  // (it mints only the living): somebody seated beside one may sit on the
  // other half there for the rest of that visit. Never two on one seat.
  _seatPref(s, q) { return (s.pair === 1 || (!s.pair && (hash32(s.seed, q.sid, 0x5ea7) & 1))) ? 1 : -1; }

  /**
   * +1 or -1: the half of the bench at stop `ref` this slot sits on for the
   * visit that began at `tA` (the keyframe's own second, s.tl.t[i]); 0: no room.
   */
  _seatOf(s, ref, tA) {
    if (s.seatRev !== this._benchRev) { s.seatRev = this._benchRev; s.seat?.clear(); }
    const memo = s.seat ??= new Map();
    const had = memo.get(tA);
    if (had !== undefined) return had;
    const q = s.stops[ref].site;
    let plus = false, minus = false;
    const users = this._benchers.get(q.sid);
    if (users) for (const o of users) {
      if (o === s || o.rs === s.rs || !o.tl) continue;   // myself, or the one I walk with
      if (tA >= o.t0 + TRIP_T) continue;                 // their generation had rolled: gone from the bench
      sampleTimeline(o.tl, tA, _SL);
      // (_SL is one record and the call below writes it again: read it first)
      const oref = _SL.ref;
      if (_SL.kind !== DW.BENCH || oref < 0 || o.stops[oref]?.site !== q) continue;
      const tB = o.tl.t[_SL.i];
      // there before me (two who arrive in the same instant: the lower key first)
      if (!(tB < tA || (tB === tA && o.key < s.key))) continue;
      const h = this._seatOf(o, oref, tB);
      if (h > 0 || (h && o.pair)) plus = true;
      if (h < 0 || (h && o.pair)) minus = true;
    }
    const pref = this._seatPref(s, q);
    let half;
    if (s.pair) half = (plus || minus) ? 0 : pref;
    else half = !(pref > 0 ? plus : minus) ? pref : !(pref > 0 ? minus : plus) ? -pref : 0;
    memo.set(tA, half);
    return half;
  }

  _dwellPose(p, s, kind, ref, tIn, tOut, visit) {
    const px = _P.x, pz = _P.z;
    let tx = px, tz = pz, fx = _P.dx, fz = _P.dz, sits = false;
    const st = ref >= 0 ? s.stops[ref] : null;
    const q = st?.site;
    if (kind === DW.BENCH && q) {
      // furniture.js bench(): front along (sin h, cos h), slats along (cos h, -sin h)
      const sh = Math.sin(q.h), ch = Math.cos(q.h);
      const half = this._seatOf(s, ref, s.tl.t[visit]);
      if (half) {
        const so = half * SEAT_HALF;
        tx = q.x + ch * so + sh * 0.06; tz = q.z - sh * so + ch * 0.06;
        sits = true;
      } else {
        // no room: stand at the end of the bench, by whoever is on it
        const so = (this._seatPref(s, q) > 0 ? 1 : -1) * (BENCH_END + (s.pair === 2 ? 0.6 : 0));
        tx = q.x + ch * so + sh * 0.3; tz = q.z - sh * so + ch * 0.3;
      }
      fx = sh; fz = ch;
    } else if (kind === DW.STOP && q) {
      const sp = q.spot;
      const off = (rnd01(hash32(s.seed, q.sid, 0x57a9)) - 0.5) * 2 * STOP_SPREAD;
      tx = sp.x + sp.ax * off; tz = sp.z + sp.az * off;
      fx = sp.fx; fz = sp.fz;
    } else if ((kind === DW.WINDOW || kind === DW.FOOD) && q) {
      const vx = q.x - px, vz = q.z - pz, d = dist(vx, vz) || 1;
      const step = Math.min(1.3, Math.max(0, d - 1.4)) * (s.pair === 2 ? 0.5 : 1);
      tx = px + (vx / d) * step; tz = pz + (vz / d) * step;
      fx = vx / d; fz = vz / d;
    } else if (kind === DW.TALK) {
      // the two of a pair turn to each other across the half metre between them
      const out = s.side * (s.pair === 2 ? -1 : 1);
      fx = -_P.dz * out; fz = _P.dx * out;
    }
    const gap = dist(tx - px, tz - pz);
    const M = Math.max(0.5, gap / STEP_SPEED);
    const tm = Math.min(tIn, tOut);
    let u = tm >= M ? 1 : tm / M;
    _D.sit = 0; _D.moving = false;
    if (u < 1 && gap > 0.25) {
      _D.moving = true;
      const out = tIn <= tOut ? 1 : -1;               // going over, or coming back
      fx = (tx - px) / gap * out; fz = (tz - pz) / gap * out;
    } else {
      u = 1;
      if (sits) { const k = (tm - M) / SIT_BLEND; _D.sit = k < 0 ? 0 : k > 1 ? 1 : k; }
      // a boarder watches for the bus (every sixteenth frame is plenty)
      if (kind === DW.STOP && s.board === ref && this.busAt && (p.checkT = (p.checkT + 1) & 15) === 0) {
        const car = this.busAt(q.x, q.z);
        if (car) this._board(p, s, car);
      }
    }
    _D.x = px + (tx - px) * u; _D.z = pz + (tz - pz) * u;
    _D.dx = fx; _D.dz = fz;
    return _D;
  }

  // The timeline has this citizen gone by bus. If a bus is in fact standing at
  // their stop they walk to its door; if it is not (held up round the corner by
  // somebody's abandoned car, say), they give up on it and walk off, a free
  // body like any other, and are collected when nobody can see.
  _depart(p, s, ref) {
    const st = s.board >= 0 ? s.stops[s.board] : null;
    const car = st && this.busAt ? this.busAt(st.site.x, st.site.z) : null;
    if (car) { this._board(p, s, car); return; }
    // THE BUS IS LATE, NOT CANCELLED. The timeline lets a boarder go BOARD_GRACE
    // after the bus is due, and a bus held up at two crossings and a give-way
    // line is later than that: watched at a stop, three people stood waiting,
    // walked off, and the bus pulled in ten seconds afterwards to nobody. With
    // one really on its way down the street they stay where they are (the body
    // is this screen's; in the shared world the slot has left either way), for
    // LATE_MAX seconds at most.
    if (st && this.busNear && this.busNear(st.site.x, st.site.z)) {
      const t = this.now();
      if (p.lateS !== s) { p.lateS = s; p.lateT0 = t; }
      if (t - p.lateT0 < LATE_MAX) return;
    }
    this._cutLoose(p, s);
    s.held = 1;
  }

  _board(p, s, car) {
    this._cutLoose(p, s);
    s.held = 1;                         // the slot rides the bus for the rest of its life
    p.state = 'board';
    p.boardCar = car; p.boardT = 0; p.boardDone = false;
    if (p.pose) { p.pose = 0; p.standPose(); }
  }

  // Walking to the door of a waiting bus, and through it. Purely local: the
  // schedule already has them gone.
  _boardStep(p, dt) {
    const car = p.boardCar;
    p.boardT += dt;
    if (!car) { p.boardDone = true; p.mesh.visible = false; return; }
    // the front door: kerb side (right of travel), just behind the nose
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    // (where that is depends on the body: js/transitbody.js)
    const door = doorsOf(car).front;
    const tx = car.x - fz * (car.wid / 2 + 0.3) + fx * (car.len / 2 - door);
    const tz = car.z + fx * (car.wid / 2 + 0.3) + fz * (car.len / 2 - door);
    const dx = tx - p.x, dz = tz - p.z, d = dist(dx, dz);
    if (d < 0.4) { p.boardDone = true; p.mesh.visible = false; return; }
    // MISSED IT. A stop can stand a dozen metres from the kerb its bus calls at
    // (the two on the station forecourt do), and this used to give everybody
    // seven seconds at a walk and then switch them off wherever they had got
    // to: in the open, half way across the paving. Nobody vanishes short of
    // the door now. They run for a bus that is further than a few steps off,
    // and one that pulls away without them (or is not reached in BOARD_WALK_MAX)
    // has been missed: they stop, and walk back to their beat like anybody
    // cut loose.
    if (p.boardT > BOARD_WALK_MAX || (Math.abs(car.speed) > 1.5 && d > 1.2)) {
      p.state = 'walk'; p.boardCar = null;
      p.bx = p.x; p.bz = p.z; p.blend = 1; p.blendK = 0.35;
      return;
    }
    const v = d > BOARD_RUN_D ? BOARD_RUN : 1.7;
    const step = Math.min(d, v * dt);
    p.x += (dx / d) * step; p.z += (dz / d) * step;
    this._face(p, dx / d, dz / d, dt);
    p.walkT += step * 1.6;
    p.speed = v;
    p.mesh.position.set(p.x, this._feet(p), p.z);
    p.mesh.rotation.y = p.heading;
    p.animate(p.walkT, Math.min(1.3, v / 1.4), 0, v);
  }

  /** Ground under a pedestrian — 0 while the height map for that tile is absent. */
  _gy(x, z) { return this.terrain ? this.terrain.heightAt(x, z) : 0; }

  // The same, for a body on its feet, asked only when it has MOVED. The walking
  // surface is the most expensive question in this file (world.footing looks
  // through every way of the chunk cell for kerbs, pavements and decks:
  // measured at 0.9 ms a frame for seventy bodies, more than everything else
  // here together), and somebody on a bench or at a bus stop asked it sixty
  // times a second about the same paving stone. Fifteen centimetres is under a
  // quarter of a stride and well inside the run of a dropped kerb.
  _feet(p) {
    const dx = p.x - p.gx, dz = p.z - p.gz;
    if (dx * dx + dz * dz > 0.0225 || p.gy === null) {
      p.gx = p.x; p.gz = p.z;
      p.gy = this._gy(p.x, p.z);
    }
    return p.gy;
  }

  // Somebody with their hands up. We keep them standing where they were grabbed
  // and re-seat them on the ground (a tile can stream in underneath a mugging),
  // and that is ALL: p.animate is never called, so whatever pose js/combat.js
  // last wrote survives the frame. Calling it with a floor of 0.3, which is
  // what _schedStep would do, is a man jogging on the spot — see the header.
  // p.heading is read here rather than written, so the holder can turn the
  // victim to face them just by assigning it.
  _heldStep(p) {
    p.speed = 0;
    p.mesh.position.set(p.x, this._feet(p), p.z);
    p.mesh.rotation.y = p.heading;
  }

  // A body that left its slot — hit, stunned, got up and ran. Its motion is
  // this tab's business alone, so it integrates locally along the beat it was
  // walking and is dropped as soon as nobody can see it go.
  _freeStep(p, dt) {
    if (p.calm > 0 && (p.calm -= dt) <= 0) p.speed = SPEED_MIN + SPEED_VAR * 0.5;
    // SOMEBODY CUT LOOSE STILL LOOKS BEFORE STEPPING OUT. The timeline is what
    // stops a scheduled walker at the kerb, and a free one has none: they
    // walked their beat straight across every road on it without a glance, with
    // a driver told only when they were already at the kerb. Same two questions the
    // schedule asks (is something bearing down on this crossing, is a car
    // where my next stride goes), for at most FREE_HOLD seconds, so nobody
    // grows roots at a kerb. Somebody running from a bang does not look.
    let hold = false;
    if (!(p.calm > 0)) {
      p.rArc = p.fArc;
      if (p.fHold < FREE_HOLD
        && (this._kerbUnsafe(p.cross, p.fArc, p.fDir, p.speed > 0.5 ? p.speed : 1.2) || this._carInWay(p, p.cross, p.fDir))) {
        hold = true;
        p.fHold += dt;
      } else if (p.fHold > 0) p.fHold = Math.max(0, p.fHold - dt * 0.5);
    }
    if (!hold) p.fArc += p.speed * p.fDir * dt;
    // A free walker turns where the schedule turned them: at `lo`, not at 0.
    // The first metres of a beat can lie on a carriageway (_plan pulls the
    // turn-around in to the pavement and drops that crossing from the list),
    // and somebody cut loose walked back down to 0, stood in the lane that no
    // driver had been told about and was run over there. (Not a clamp: a body
    // that got up below lo walks out of it, it is not put anywhere.)
    if (p.fArc <= p.fLo && p.fDir < 0) { if (p.fArc < 0) p.fArc = 0; p.fDir = 1; }
    else if (p.fArc >= p.fSpan) { p.fArc = p.fSpan; p.fDir = -1; }
    this._walkPose(p.steps, p.fArc, p.fDir, p.side * this._latK(p.tight, p.fArc, p.fDir), p.fSpan, _P, p.bay);
    p.x = _P.x;
    p.z = _P.z;
    const dx = _P.dx, dz = _P.dz;
    this._noteCrossing(p.cross, p.fArc, p.fDir, false, p.x, p.z);
    if (p.blend > 0) {
      p.blend = Math.max(0, p.blend - dt * p.blendK);
      p.x += (p.bx - p.x) * p.blend;
      p.z += (p.bz - p.z) * p.blend;
    }
    this._face(p, dx, dz, dt);
    p.mesh.position.set(p.x, this._feet(p), p.z);
    p.mesh.rotation.y = p.heading;
    if (hold && !(p.blend > 0.05)) {
      // standing at the kerb: a stance, not a walk cycle on the spot
      if (p.pose !== 1) { p.pose = 1; p.standPose(); }
      return;
    }
    if (p.pose) { p.pose = 0; p.standPose(); }
    p.walkT += p.speed * dt * 1.6;
    p.animate(p.walkT, Math.max(0.3, Math.min(1.3, p.speed / 1.4)), 0, p.speed);
  }

  // heading faces the walk direction: dir = (−sin h, −cos h) ⇒ h = atan2(−dx, −dz)
  _face(p, dx, dz, dt) {
    const want = Math.atan2(-dx, -dz);
    let d = want - p.heading;
    d = ((d + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
    p.heading += d * Math.min(1, dt * 6);
  }

  // -------------------------------------------------------------- sweep ----

  // Attach bodies, drop bodies, retire slots — and refuse to do any of it
  // where the player would see it happen. A decision that is not allowed is
  // not queued and not forced; the sweep simply asks again in 250 ms, which
  // is why nothing in this function can ever pop.
  _sweep(wt, fx, fz, since = SWEEP_DT) {
    // THE HOUR SCALES THE CAP TOO. In town the slots within reach outnumber
    // the cap two to one at any hour between six and ten at night, so with a
    // fixed cap the curve of js/dayrhythm.js thinned the SLOTS and the player
    // saw the same ninety bodies at ten in the morning as in the rush: the
    // day only had a shape after midnight. The cap follows the same share as
    // the squares round the viewer (the busiest of the nine, so an evening
    // beside the pubs is still an evening). Bodies are local, like the cap.
    let dayK = 0;
    const vi = Math.floor(fx / PCELL), vj = Math.floor(fz / PCELL);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const k = this._dayK(this._cells.get((vi + i) + ',' + (vj + j)));
      if (k > dayK) dayK = k;
    }
    const cap = Math.round((this.max ?? MAX_PEDS) * CAP_SLACK * dayK) + 4;

    // 1. ghosts: free bodies (ragdolls, corpses, runners, walkers the
    //    generation left behind) — no slot, own rules
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (!p.free) continue;
      if (p.state === 'dead') {
        if (p.deadT <= 0 && this._hidden(p.x, p.z, fx, fz)) this._drop(i);
        continue;
      }
      // mid-flight: let it land. A HELD ghost ages like a walking one on
      // purpose — the alternative is a body that is immortal for as long as
      // whoever grabbed it forgets to let go, which is exactly the leak
      // GHOST_MAX exists to close. js/combat.js must therefore tolerate its
      // victim vanishing, the same way it must when the sweep detaches a
      // scheduled one.
      // through the bus door: the one place a citizen may vanish in plain sight
      if (p.state === 'board') { if (p.boardDone) this._drop(i); continue; }
      if (p.state !== 'walk' && p.state !== 'held') continue;
      // A ghost owns no slot, so nothing shared is waiting on it and it may go
      // the instant nobody can see it go — which is what the header has always
      // promised ("they run until they are out of sight and then quietly stop
      // existing"). The rule used to ALSO demand dist > DETACH_R, and that
      // conjunction is why a freed walker was immortal: fSpan is 160–380 m, so
      // the beat rarely leaves 265 m, and _hidden() is true for most bearings
      // from 40 m out. Measured: six bodies released in view at t=120 s were
      // all six still on the heap at t=600 s. GHOST_MAX is the surrender
      // clause for the one that can be seen and cannot get away.
      p.ghostT += since;
      if (p.ghostT > GHOST_MAX || this._hidden(p.x, p.z, fx, fz)) this._drop(i);
    }

    // 2. schedules
    let alive = 0;
    for (const p of this.peds) if (!p.free) alive++;
    for (const s of this._pool.values()) {
      const gen = Math.floor((wt + s.ph) / TRIP_T);   // s.ph: the pair's shared phase
      const cd = dist((s.ci + 0.5) * PCELL - fx, (s.cj + 0.5) * PCELL - fz) - PCELL_HALF_DIAG;
      const stale = gen !== s.gen || cd > PHANTOM_R || s.k >= this._slots(s.cell);

      if (s.body) {
        const b = s.body;
        const hidden = this._hidden(b.x, b.z, fx, fz);
        // A retired slot whose citizen is on screen KEEPS WALKING — but the
        // SLOT does not wait with it. Deferring the slot is what made two
        // clients disagree: the one who was looking kept `0,0/5` on generation
        // g while the peer had already minted g+1 into it, and snapshot()
        // differed in 2–6 rows for as long as somebody kept watching (one slot
        // measured 465 s = 111 % of TRIP_T behind, a whole generation skipped).
        // So the slot is retired on time and the BODY becomes a ghost: it walks
        // on, locally, until it is hidden or GHOST_MAX runs out. Same trade
        // js/traffic.js makes, argued out at length in its v9 header — a car
        // one client draws and the other does not is cheap; two clients that
        // disagree about who the crowd IS is not.
        if (stale) {
          if (hidden) this._detach(s);                  // nobody looking: just go
          else this._toGhost(s);                        // somebody is: walk it off
          alive--;
          continue;
        }
        // Still this citizen's slot, so rule 1 applies in full: a body on
        // screen is not touched, and we ask again in 250 ms.
        if (!hidden) continue;
        if (dist(b.x - fx, b.z - fz) > DETACH_R) { this._detach(s); alive--; }
        continue;
      }

      if (stale) { this._pool.delete(s.key); continue; }
      if (s.held) continue;                             // corpse's slot, left empty
      if (alive >= cap) continue;

      // the WALK pose, not the centreline: the pavement offset is up to 0.9 m
      // and that is enough to put a body on the wrong side of the cone edge
      const a = this._arcAt(s, wt);
      if (a.kind === DW.GONE) continue;                 // on a bus, or not off one yet
      // NOT ON THE ROAD, and not in the last few metres before it. A body is
      // what a driver sees and what looks up the road before stepping out, so
      // somebody who took a body in mid-carriageway was somebody no car had
      // had the chance to brake for. They get it once they are across.
      if (this._nearRoad(s.cross, a.arc, a.sign)) continue;
      this._walkPose(s.steps, a.arc, a.sign, s.lat * this._latK(s.tight, a.arc, a.sign), s.span, _P, s.bay);
      if (dist(_P.x - fx, _P.z - fz) > ATTACH_R) continue;
      // …with ONE exception to "not in front of you": somebody stepping off a
      // bus that is standing at its stop appears at its door, which is exactly
      // where a person is expected to appear from.
      let bus = null;
      if (s.alight && this.busAt && wt >= s.alight.t && wt - s.alight.t < 5) {
        const q = s.stops[s.alight.stop].site;
        bus = this.busAt(q.x, q.z);
      }
      if (!bus && !this._hidden(_P.x, _P.z, fx, fz)) continue;  // not in front of you, ever
      const b = this._attach(s, wt);
      if (bus) {
        const hx = -Math.sin(bus.heading), hz = -Math.cos(bus.heading);
        // on by the front door, off by the middle one, as on any town bus
        // (the middle door of THIS body: a trolleybus is longer than a bus)
        const door = doorsOf(bus).mid;
        b.bx = bus.x - hz * (bus.wid / 2 + 0.5) + hx * (bus.len / 2 - door);
        b.bz = bus.z + hx * (bus.wid / 2 + 0.5) + hz * (bus.len / 2 - door);
        b.blend = 1; b.blendK = 0.3;
        b.x = b.bx; b.z = b.bz;
        b.mesh.position.set(b.x, this._gy(b.x, b.z), b.z);
      }
      alive++;
    }
  }

  // Give a slot a body. Everything visible about the citizen is hashed, so the
  // same slot wears the same jacket on every screen.
  _attach(s, wt) {
    // makeCitizen() picks jacket/trousers/skin/hair with Math.random and takes
    // no seed. Rather than fork its wardrobe into this file — two palettes for
    // one city is exactly the kind of drift that makes a co-op world look
    // subtly wrong — we lend it a deterministic draw for the length of one
    // synchronous call, the same trick traffic.js plays on pickCarColor().
    // REQUEST to the owner of citizen.js: makeCitizen({ rnd }) taking an
    // optional () => 0..1, and this wrapper disappears.
    const real = Math.random;
    let n = 0, c;
    try {
      Math.random = () => rnd01(hash32(s.seed, 0xc17, n++));
      // WHICH BODY is not part of the wardrobe draw and must not ride on it:
      // it comes off its own salt so that js/chatter.js can compute the same
      // answer without replaying the jacket, the trousers, the skin and the
      // hair in the same order. A grandmother has to sound like a grandmother,
      // and that only works if the module choosing her shape and the module
      // choosing her voice reach the same conclusion from the seed alone.
      c = makeCitizen({ archetype: archetypeAt(rnd01(hash32(s.seed, ARCH_SALT))).key });
    } finally { Math.random = real; }

    // people share ONE scale with the player — a half-size hero among
    // full-size passers-by reads as a bug, whatever the constant is set to
    c.group.scale.setScalar(PLAYER_SCALE);
    this.scene.add(c.group);

    const a = this._arcAt(s, wt);
    this._walkPose(s.steps, a.arc, a.sign, s.lat * this._latK(s.tight, a.arc, a.sign), s.span, _P, s.bay);
    // How far the figure has to come down to sit: its hip joint stands this
    // high (citizen.js hangs the legs off it), and the hips of somebody seated
    // rest a thigh's thickness over the slats.
    const hipY = (c.parts?.legL?.position?.y ?? 0.9) * PLAYER_SCALE;
    const p = {
      mesh: c.group, animate: c.walk, sitPose: c.sitPose,
      ragdollPose: c.ragdollPose, standPose: c.standPose, dispose: c.dispose,
      sch: s, free: 0, look: c.look,
      // The PERSON, as opposed to the slot. s.seed is already the shared
      // integer that decided this citizen's jacket, route and pace, so it is
      // the only identity two clients can agree on — but _cutLoose() nulls
      // `sch`, and being run over or ghosted is exactly when a body most needs
      // to still be somebody (js/chatter.js keys a voice and a cooldown on it).
      // Copying it here costs one int per body and survives every path.
      pid: s.seed,
      // The health bar every blow in the game spends, and the ONE place it is
      // initialised: js/vitals.js's 100, so a weapon does the same arithmetic
      // whichever way it is pointed. Nothing but hurt() may change it. Note
      // that a car ignores it entirely — KILL_SPEED is its rule, and the
      // header says why at length.
      hp: PED_HP,
      // feet-to-hair, this person's own — js/chatter.js floats their speech
      // bubble off it. The five archetypes span 15 cm, which is exactly the
      // amount that makes a fixed 1.75 m assumption look like a bug.
      headTop: c.headTop,
      steps: s.steps, side: s.lat, cross: s.cross, tight: s.tight, bay: s.bay,
      // what the body is doing right now: 0 walking, 1 standing, 2 seated; the
      // arc it was last drawn at; ground covered stepping off the path to a
      // bench; and the bus it is boarding, if it is
      pose: 0, rArc: a.arc, stepT: 0, sitDrop: Math.max(0, hipY - SEAT_Y - 0.1),
      boardCar: null, boardT: 0, boardDone: false, checkT: 0, blendK: 0.8,
      lateS: null, lateT0: 0,           // the schedule whose bus is late, and since when (_depart)
      gx: 1e9, gz: 1e9, gy: null,       // where the ground was last asked, and its answer (_feet)
      // Face the right way and stand at the right point of the stride from the
      // first frame: _face() eases over ~0.2 s, which would otherwise be a body
      // pirouetting into position the moment it arrives.
      x: _P.x, z: _P.z, heading: Math.atan2(-_P.dx, -_P.dz),
      walkT: a.walked * 1.6, speed: s.speed,
      rush: 0, rushT: 0, calm: 0, fleeSign: 1,
      // free-body state, only meaningful once released. ghostT is the seconds
      // this body has outlived its slot; GHOST_MAX collects it.
      fArc: 0, fDir: 1, fSpan: s.span, fLo: s.lo ?? 0, ghostT: 0,
      // hit-physics state:
      //   walk | held (hands up, somebody else drives the pose) |
      //   rag (flying/sliding) | down (stunned) | dead
      state: 'walk', dead: false, y: 0, lieY: 0,
      vx: 0, vy: 0, vz: 0, avx: 0, avz: 0, bounced: false,
      hitCd: 0, hurtS: 0, downT: 0, deadT: 0,
      blend: 0, bx: 0, bz: 0,
      // Where the beat had them when they were grabbed, and what killed them.
      // Declared here rather than stamped on at the moment of need: this object
      // is the hot shape the whole walk loop reads, and a property added later
      // costs every body a hidden-class transition to save eight bytes.
      heldArc: 0, cause: null,
    };
    c.group.position.set(p.x, this._gy(p.x, p.z), p.z);
    s.body = p;
    this.peds.push(p);
    return p;
  }

  // Take the body away and forget the slot. Only ever called from _sweep, and
  // only when _hidden() said yes.
  _detach(s) {
    const i = this.peds.indexOf(s.body);
    if (i >= 0) this._drop(i);
    s.body = null;
    this._pool.delete(s.key);
  }

  _drop(idx) {
    const p = this.peds[idx];
    if (p.sch && p.sch.body === p) p.sch.body = null;
    // citizen.js owns the teardown: geometry and materials are SHARED, so the
    // conventional `traverse(o => o.geometry.dispose())` would free buffers
    // forty other walkers are still drawing from.
    p.dispose();
    this.peds.splice(idx, 1);
  }

  // Cut a body loose from its schedule: from here on this tab alone decides
  // where it goes and how long it lasts. Shared by the only two ways a body
  // stops being the schedule's — being run over (_release) and being overtaken
  // by its own generation (_toGhost) — because they differ in exactly one
  // thing, what happens to the slot, and nothing else should drift between
  // them.
  _cutLoose(p, s) {
    s.body = null;
    p.sch = null;
    p.free = 1;
    p.ghostT = 0;                       // the GHOST_MAX clock starts here
    p.fHold = 0;                        // seconds stood at a kerb waiting for a gap (see _freeStep)
    p.fSpan = s.span;
    p.fLo = s.lo ?? 0;                  // the near end of the beat may lie on a road: see _plan
    // carry on from where the schedule had them, in the direction they faced
    const a = this._arcAt(s, this.now());
    p.fArc = Math.max(0, Math.min(s.span, a.arc + p.rush));
    p.fDir = a.sign;
    p.rush = 0;
    // …and from where they actually ARE: somebody cut loose on a bench is
    // 5 m off the beat, and gets up and walks back to it rather than blinking
    if (p.pose) {
      p.pose = 0; p.standPose();
      p.bx = p.x; p.bz = p.z; p.blend = 1; p.blendK = 0.35;
    }
  }

  // Run over. The slot is HELD rather than reopened, so the beat cannot walk a
  // fresh citizen over the body of the last one; it is released for real when
  // the generation rolls (see _sweep).
  _release(p) {
    const s = p.sch;
    if (!s) return;
    this._cutLoose(p, s);
    s.held = 1;
  }

  // The generation rolled while somebody was looking. The SLOT goes back to the
  // world this instant — _scanCells, on the next line of update(), mints the
  // next generation into it in the same tick, so _pool and everything hashed
  // from it stay bit-identical to what they would be if nobody had a camera at
  // all. Only the body is deferred, and it is a ghost from here on.
  _toGhost(s) {
    const p = s.body;
    this._pool.delete(s.key);
    if (p) this._cutLoose(p, s);
  }

  // ---------------------------------------------------------------- hits ----

  // Player car first (it's the one doing 60 through Třída Míru), then the AI
  // fleet. Everything is bbox-gated before any trig; peds already flying are
  // immune until they land, then a corpse/stunned body can be run over again.
  _hitPass() {
    const pc = this.playerCar, cars = this.cars;
    for (const p of this.peds) {
      if (p.hitCd > 0 || p.state === 'rag') continue;
      if (pc && this._carHit(pc, p)) continue;
      if (cars) for (const c of cars) {
        if (c === pc) continue;
        if (this._carHit(c, p)) break;
      }
    }
  }

  // oriented rectangle (len×wid around heading) vs. the ped's circle —
  // standing peds are one 0.35 m circle at the feet, lying bodies a capsule
  // sampled as three circles along the body axis
  _carHit(car, p) {
    // GROUND speed where the player's car has one. car.speed is the component
    // along the nose, so a car arriving sideways out of a drift at 25 m/s used
    // to report almost nothing and pass harmlessly through the walker. AI cars
    // are rail-followed and carry no lateral component, so they fall back to
    // the scalar and behave exactly as before.
    const s = car.vGround ?? Math.abs(car.speed);
    if (s <= HIT_MIN_SPEED) return false;
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > car.len || Math.abs(dz) > car.len) return false;
    // A car on a bridge deck must not squash the walker on the riverside path
    // BELOW it — but the two heights have to be in the same frame to say so.
    // car.y became an ABSOLUTE altitude the day the terrain landed; p.y never
    // did, it is still the walker's height ABOVE THE GROUND (0 on foot, lifted
    // mid-flight). So this compared 221 against 0 in Pardubice and threw away
    // every hit in the city: the whole ragdoll, blood and run-over system was
    // wired, tested and correct, and unreachable behind one line.
    if (Math.abs((car.y || 0) - (this._gy(p.x, p.z) + p.y)) > 0.9) return false;
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    const rx = -fz, rz = fx;                     // right of travel
    const hl = car.len / 2, hw = car.wid / 2;
    // A held citizen is on their feet with their hands up, so they are a
    // standing circle and not a capsule — being robbed does not make you
    // easier to run over lengthways.
    const lying = p.state !== 'walk' && p.state !== 'held' && p.state !== 'board';
    let hit = rectCircle(dx * fx + dz * fz, dx * rx + dz * rz,
      hl, hw, lying ? LIE_R : PED_R);
    if (!hit && lying) {                         // head/feet ends of the capsule
      const bx = Math.sin(p.heading) * LIE_HALF, bz = Math.cos(p.heading) * LIE_HALF;
      hit = rectCircle((dx + bx) * fx + (dz + bz) * fz, (dx + bx) * rx + (dz + bz) * rz, hl, hw, LIE_R)
        || rectCircle((dx - bx) * fx + (dz - bz) * fz, (dx - bx) * rx + (dz - bz) * rz, hl, hw, LIE_R);
    }
    if (!hit) return false;
    this._launch(p, car, s);
    return true;
  }

  // the moment of impact: velocity along the car's travel, a kick upward, a
  // shove off the bonnet's centerline, tumble spin, splayed limbs. Everything
  // that FOLLOWS from it — the health, the hooks, the blood, the panic — is
  // hurt()'s, so a bonnet and a fist cannot drift apart on any of it.
  _launch(p, car, s) {
    const dirS = car.speed >= 0 ? 1 : -1;        // reversing hits launch backward
    const fx = -Math.sin(car.heading) * dirS, fz = -Math.cos(car.heading) * dirS;
    const k = p.state === 'dead' ? NUDGE_K : 1;  // rolling a corpse, gently
    const kick = (s * 0.9 + 2) * k;
    const side = (p.x - car.x) * -fz + (p.z - car.z) * fx < 0 ? -1 : 1;
    const b = _blow;
    // THE CAR KEEPS ITS OWN KILL RULE, and the rule is a SPEED and not a health
    // bar: above KILL_SPEED the blow carries the whole 100, below it, nothing
    // at all. Billing a car proportionally would mean a 30 km/h clip killed a
    // man who had been punched twice and left a healthy one standing — two
    // different answers to "was I run over?", which is a question the tests and
    // the player both expect exactly one answer to.
    b.dmg = s > KILL_SPEED ? PED_HP : 0;
    b.launch = true;                             // a car always throws a body
    b.vx = fx * kick - fz * side * 1.2 * k;      // lateral = right-of-travel × side
    b.vz = fz * kick + fx * side * 1.2 * k;
    b.vy = Math.min(6, 1.5 + s * 0.25) * k;
    b.spin = Math.min(9, 2 + s * 0.6);
    b.impact = s;                                // the hooks want metres per second
    b.panic = PANIC_R;
    b.cause = C_CAR;
    b.by = car;                                  // see p.by in hurt()
    this.hurt(p, b);
  }

  /**
   * THE DOOR EVERY INJURY GOES THROUGH. A fist, a bullet, a bus, whatever
   * weapons.js grows next: this is the only function in the game that takes a
   * citizen's health, and therefore the only one that can fire onPedHit,
   * onPedKilled or scatter the street. Nothing outside this file should be
   * reaching past it to _throw — a body thrown without consequences is a body
   * nobody screamed at and no policeman ever heard about.
   *
   * blow = {
   *   dmg     hp to take off. 0 is legal: a blow may be pure physics.
   *   launch  true = throw them whatever the damage did (a car, a rocket). A
   *           punch leaves it alone and gets a flinch — see the header for the
   *           combo this rule exists to keep reachable.
   *   vx, vz  where the body goes, in m/s. A non-launching blow reads only the
   *   vy      DIRECTION of it, to work out where the blow came from, so a fist
   *           may hand over a unit vector and nothing moves.
   *   spin    rad/s of tumble; defaults to something proportional to the throw.
   *   impact  what the hooks are told this was worth. Defaults to the damage
   *           through IMPACT_PER_HP.
   *   panic   metres of street that hears it. Defaults to PANIC_R; 0 for a
   *           silenced weapon, or a mugging nobody is supposed to notice.
   *   cause   a short Czech noun, stamped on the body for whoever reads it.
   * }
   *
   * Returns true if there was somebody there to hurt.
   *
   * IT DOES NOT TEST hitCd. hitCd is the CAR's gate — decremented in update(),
   * read in _hitPass — and a melee combo forced to wait on it would drop its
   * second and third punch on the floor. Rate limiting a weapon is the
   * weapon's job, and js/combat.js has an absolute deadline of its own for it.
   */
  hurt(p, blow) {
    if (!p || !blow || !p.mesh) return false;
    // Being hit ends a mugging: the hands come down before the body does.
    if (p.state === 'held') this.hold(p, false);

    const dmg = blow.dmg > 0 ? blow.dmg : 0;
    const wasDead = p.dead;
    // A corpse has no health left to lose; skipping it here is also what keeps
    // onPedKilled a once-per-body event when a car rolls one down the street.
    if (dmg > 0 && !wasDead) {
      p.hp -= dmg;
      if (!(p.hp > 0)) { p.hp = 0; p.dead = true; }
    }
    const imp = Number.isFinite(blow.impact) ? blow.impact : dmg * IMPACT_PER_HP;
    p.hurtS = imp;
    if (blow.cause) p.cause = blow.cause;
    // WHO did it, when anybody did. onPedHit fires for EVERY car in the city,
    // including AI traffic mowing somebody down two streets away — so a wanted
    // system that charges the player on that hook alone hands out stars for
    // accidents they were not part of. The blow carries its author; main.js
    // compares it against the car the player is actually driving.
    p.by = blow.by ?? null;

    const vx = blow.vx || 0, vy = blow.vy || 0, vz = blow.vz || 0;
    if (p.dead || blow.launch === true) {
      // Lethal, or the caller insisted. Off their feet they go.
      const spin = Number.isFinite(blow.spin)
        ? blow.spin
        : Math.min(9, 2 + Math.sqrt(vx * vx + vz * vz) * 0.6);
      this._throw(p, vx, vy, vz, spin);
      p.hitCd = HIT_COOLDOWN;
    } else if (p.state === 'walk') {
      // THE FLINCH, and the whole point of this branch is what it does NOT do:
      // it never touches p.state. They rock, they bleed, they run — and they
      // are still standing there in 'walk' for the next punch of the combo.
      p.hitCd = FLINCH_CD;
      if (dmg > 0) this._spawnBlood(p.x, p.z, FLINCH_BLOOD);
    }

    // SOUND: body thud (+ scream if fatal) belongs here — subscribe to onPedHit
    this.onPedHit?.(p, imp);
    if (p.dead && !wasDead) this.onPedKilled?.(p);

    // SOUND: bystander screams — the crowd scatters. The bang is placed one
    // stride back up the blow, i.e. roughly where whoever threw it is standing:
    // panic() decides which way is "away" by sampling the beat, and away from
    // the victim's own feet is not a direction. For a car the origin lands on
    // the bonnet and nothing measurable changes.
    const r = Number.isFinite(blow.panic) ? blow.panic : PANIC_R;
    if (r > 0) {
      let ox = p.x, oz = p.z;
      const l = Math.sqrt(vx * vx + vz * vz);
      if (l > 1e-4) { ox -= (vx / l) * PANIC_BACK; oz -= (vz / l) * PANIC_BACK; }
      this.panic(ox, oz, r);
    }
    return true;
  }

  /**
   * The physics half of a launch: cut the body loose from its schedule, give
   * it a velocity and a tumble, and put it in the air. It does not know what
   * hit it, does not read or write hp, fires no hooks and makes no sound —
   * which is precisely what lets a fist, a bullet and a Škoda all arrive at the
   * same ragdoll through one function instead of three copies that drift.
   * Private on purpose: the consequences live in hurt(), and a caller who
   * skipped them would be inventing a second kind of death.
   */
  _throw(p, vx, vy, vz, spin) {
    if (p.state === 'held') this.hold(p, false);
    this._release(p);                            // physics owns them now, not the
                                                 // beat; a no-op if already free
    p.vx = vx; p.vy = vy; p.vz = vz;
    const s = Number.isFinite(spin) ? spin : 0;
    p.avx = s * (Math.random() * 1.4 - 0.7);
    p.avz = s * (Math.random() * 1.4 - 0.7);
    p.state = 'rag';
    p.bounced = false;
    p.ragdollPose();
  }

  /**
   * Put a citizen into — or out of — 'held': standing still with their hands
   * up while somebody goes through their pockets. Returns true if the state
   * actually changed.
   *
   * THE POSE IS NOT OURS. 'held' means this file stops driving the body
   * altogether: no arc, no facing, and no p.animate at all. js/combat.js writes
   * p.heading and calls the citizen's handsPose() every frame for as long as it
   * holds them. Freezing the schedule and leaving the walk cycle running is the
   * version that does not work — the animation floor of 0.3 turns a robbery
   * into a man jogging on the spot.
   */
  hold(p, on) {
    if (!p || !p.mesh) return false;
    if (on) {
      if (p.state !== 'walk') return false;      // only somebody on their feet
      p.state = 'held';
      p.speed = 0;
      p.calm = 0;                                // frozen, not fleeing
      // Where the beat had them at the moment of the grab, debt included. The
      // schedule is shared and walks on without them; this is what we owe it.
      const s = p.sch;
      p.heldArc = s ? this._arcAt(s, this.now()).arc + p.rush : p.fArc;
      p.standPose();
      return true;
    }
    if (p.state !== 'held') return false;
    p.state = 'walk';
    const s = p.sch;
    if (s) {
      // Pay the standing still back through `rush` — the same bounded, draining
      // deviation a panic uses — so a mugged citizen rejoins their own schedule
      // instead of snapping forward to wherever it got to without them. A very
      // long hold saturates at RUSH_MAX; `blend` below eases whatever is left
      // over, which is the only reason it is safe to clamp at all.
      const d = p.heldArc - this._arcAt(s, this.now()).arc;
      p.rush = d > RUSH_MAX ? RUSH_MAX : d < -RUSH_MAX ? -RUSH_MAX : d;
    } else {
      p.fArc = p.heldArc;                        // a ghost integrates its own arc
    }
    p.bx = p.x; p.bz = p.z; p.blend = 1;
    p.calm = CALM_T[0];                          // just robbed: they leg it
    return true;
  }

  /**
   * The nearest live citizen to (x, z) within `r`, or null. `want(p)` is an
   * optional filter — "somebody on their feet", "not the one I am already
   * holding" — and it is only asked about bodies that are ALREADY closer than
   * the best candidate so far, so a caller may make it as expensive as it likes
   * without turning this into an O(n) predicate sweep.
   *
   * A scan, not an index, and no allocation on any path: an indexed loop rather
   * than for..of (which mints an iterator per call, and a combat module aiming
   * at the crowd calls this every frame), no array of candidates, no sort, no
   * closure. The fleet is capped near 55 bodies — js/chatter.js's pair scan
   * does eighty times that work four times a second and is not on anybody's
   * profile, so a spatial index here would be more code and less speed.
   */
  nearest(x, z, r, want = null) {
    let bd = r > 0 ? r * r : 0;
    if (!(bd > 0)) return null;
    const peds = this.peds;
    let best = null;
    for (let i = 0; i < peds.length; i++) {
      const p = peds[i];
      const dx = p.x - x, dz = p.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= bd) continue;
      if (want && !want(p)) continue;
      best = p; bd = d2;
    }
    return best;
  }

  // one ragdoll/corpse per frame: fly under gravity while tumbling, bounce
  // once, slide out flat; then lie stunned (get up, flee) or stay a corpse
  _ragStep(p, dt) {
    const m = p.mesh;
    if (p.state === 'down') {                    // stunned, face in the gutter
      if ((p.downT -= dt) <= 0) this._getUp(p);
      return;
    }
    if (p.state === 'dead') {
      p.deadT -= dt;                             // removal in the sweep
      // sink away (see the CORPSE_FADE note). From where it LIES: this wrote the
      // height over the ground as if it were the height, so in a town that
      // stands 220 m above the sea the body did not sink, it blinked out.
      if (p.deadT < CORPSE_FADE)
        m.position.y = this._gy(p.x, p.z) + p.lieY - (1 - Math.max(0, p.deadT) / CORPSE_FADE) * 1.2;
      return;
    }
    // state 'rag' — airborne or sliding
    p.x += p.vx * dt;
    p.z += p.vz * dt;
    p.vy -= GRAV * dt;
    p.y += p.vy * dt;
    m.rotation.x += p.avx * dt;
    m.rotation.z += p.avz * dt;
    if (p.y <= 0) {
      p.y = 0;
      if (!p.bounced && p.vy < -2.5) {           // one honest bounce
        p.bounced = true;
        p.vy = -p.vy * RESTITUTION;
        p.vx *= 0.65; p.vz *= 0.65;
        p.avx *= 0.5; p.avz *= 0.5;
        // SOUND: tumble-thud on the tarmac
      } else {
        p.vy = 0;                                // sliding out
        const sp = Math.hypot(p.vx, p.vz);
        const ns = Math.max(0, sp - SLIDE_FRICTION * dt);
        const fk = sp > 1e-4 ? ns / sp : 0;
        p.vx *= fk; p.vz *= fk;
        const damp = Math.min(1, dt * 6);        // spin dies on contact…
        p.avx -= p.avx * damp;
        p.avz -= p.avz * damp;
        const ease = Math.min(1, dt * 5);        // …and the body settles flat
        const tx = Math.round((m.rotation.x - HALF_PI) / Math.PI) * Math.PI + HALF_PI;
        const tz = Math.round(m.rotation.z / Math.PI) * Math.PI;
        m.rotation.x += (tx - m.rotation.x) * ease;
        m.rotation.z += (tz - m.rotation.z) * ease;
        p.lieY += (LIE_Y - p.lieY) * ease;
        if (ns < 0.3 && Math.abs(p.avx) < 0.5 && Math.abs(p.avz) < 0.5)
          this._settle(p, tx, tz);
      }
    }
    m.position.set(p.x, this._gy(p.x, p.z) + p.y + p.lieY, p.z);
  }

  // the slide has stopped: become a corpse (blood, budget) or lie stunned
  _settle(p, tx, tz) {
    p.mesh.rotation.x = tx;
    p.mesh.rotation.z = tz;
    p.lieY = LIE_Y;
    p.vx = p.vz = p.avx = p.avz = 0;
    p.mesh.position.set(p.x, this._gy(p.x, p.z) + p.lieY, p.z);
    if (p.dead) {
      p.state = 'dead';
      p.deadT = CORPSE_TIME;
      this._spawnBlood(p.x, p.z, 1.0 + Math.random() * 0.4);
      // corpse budget: past CORPSE_MAX the oldest one starts sinking now
      let n = 0, oldest = null;
      for (const q of this.peds) if (q.state === 'dead') {
        n++;
        if (!oldest || q.deadT < oldest.deadT) oldest = q;
      }
      if (n > CORPSE_MAX && oldest && oldest.deadT > CORPSE_FADE) oldest.deadT = CORPSE_FADE;
    } else {
      p.state = 'down';
      p.downT = DOWN_TIME[0] + Math.random() * (DOWN_TIME[1] - DOWN_TIME[0]);
      if (p.hurtS > 5) this._spawnBlood(p.x, p.z, 0.8);  // hurt but alive
    }
  }

  // a survivor picks themself up and legs it — they are a free body from here
  // on, so they run until they are out of sight and then quietly stop existing
  _getUp(p) {
    p.state = 'walk';
    p.standPose();
    p.mesh.rotation.set(0, p.heading, 0);
    p.y = 0; p.lieY = 0;
    // re-anchor to the nearest point of the beat they were walking; the slide
    // left them off the pavement, and `blend` covers the leftover gap
    let best = 0, bd = Infinity;
    const span = p.fSpan || 1;
    for (let a = 0; a <= span; a += 4) {
      this._poseOn(p.steps, a, _P);
      const d = (_P.x - p.x) ** 2 + (_P.z - p.z) ** 2;
      if (d < bd) { bd = d; best = a; }
    }
    p.fArc = best;
    p.bx = p.x; p.bz = p.z; p.blend = 1;
    p.speed = 4.2;                               // flee!
    p.calm = CALM_T[0];
  }

  // --------------------------------------------------------------- blood ----

  // 2–3 overlapping discs per stain — shape decided once at spawn, then the
  // stain spreads over ~2 s. Pool of BLOOD_MAX groups, oldest reused. Purely
  // local decoration: blood is a consequence of a hit, and hits are already
  // this tab's own business.
  _spawnBlood(x, z, size) {
    bloodAssets();
    let d;
    if (this._blood.length < BLOOD_MAX) {
      const g = new THREE.Group();
      const discs = [];
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(_bloodGeo, _bloodMat);
        m.rotation.x = -HALF_PI;
        m.renderOrder = 2;                       // after the road decks
        g.add(m); discs.push(m);
      }
      d = { g, discs, ts: [0, 0, 0], t: 0, on: false };
      this.scene.add(g);
      this._blood.push(d);
    } else {
      d = this._blood[this._bloodN];
    }
    this._bloodN = (this._bloodN + 1) % BLOOD_MAX;
    d.t = 0; d.on = true;
    d.g.visible = true;
    d.g.position.set(x, this._gy(x, z) + BLOOD_LIFT, z);
    for (let i = 0; i < 3; i++) {
      const m = d.discs[i];
      m.visible = i < 2 || Math.random() < 0.6;        // 2–3 discs
      m.position.set((Math.random() - 0.5) * size * 0.6, i * 0.002,
        (Math.random() - 0.5) * size * 0.6);
      d.ts[i] = size * (i === 0 ? 0.9 + Math.random() * 0.3 : 0.35 + Math.random() * 0.3);
      m.scale.setScalar(0.01);
    }
  }

  _bloodStep(dt) {
    for (const d of this._blood) {
      if (!d.on) continue;
      d.t += dt;
      let k = Math.min(1, d.t / BLOOD_GROW);
      k = 1 - (1 - k) * (1 - k);                 // ease-out spread
      if (d.t > BLOOD_LIFE) {                    // dry up and vanish
        const f = (d.t - BLOOD_LIFE) / 2;
        if (f >= 1) { d.on = false; d.g.visible = false; continue; }
        k *= 1 - f;
      }
      for (let i = 0; i < 3; i++) d.discs[i].scale.setScalar(Math.max(0.01, d.ts[i] * k));
    }
  }

  // A blast on the street: everyone within reach runs the other way down their
  // own pavement. They keep their SLOT — a frightened person is still the same
  // person, and evicting thirty citizens from the population every time a
  // grenade goes off would empty the district for the next seven minutes.
  // Running shows up as `rush`, a signed lead on their own schedule that drains
  // back to zero once they calm down (see _schedStep).
  panic(x, z, r) {
    const wt = this.now();
    for (const p of this.peds) {
      if (p.state !== 'walk') continue;   // the flying and the dead don't flee
      const d = dist(p.x - x, p.z - z);
      if (d > r) continue;
      if (p.free) {                       // no schedule to lead: just turn and run
        this._poseOn(p.steps, Math.min(p.fSpan, p.fArc + 6 * p.fDir), _P);
        if (dist(_P.x - x, _P.z - z) < d) p.fDir = -p.fDir;
        p.speed = FLEE_SPEED;
        p.calm = CALM_T[0] + CALM_T[1] * 0.5;
        continue;
      }
      // which way along the beat leads AWAY from the bang? Sample six metres
      // further on and compare — deterministic, no dice, and it respects the
      // graph (a citizen sprinting across the Labe would be a worse bug than
      // one sprinting the wrong way).
      const s = p.sch;
      const a = this._arcAt(s, wt);
      const ahead = Math.max(0, Math.min(s.span, a.arc + p.rush + 6 * a.sign));
      this._poseOn(s.steps, ahead, _P);
      p.fleeSign = (dist(_P.x - x, _P.z - z) < d ? -1 : 1) * a.sign;
      p.calm = CALM_T[0] + CALM_T[1] * 0.5;
    }
  }

  // ------------------------------------------------------------ snapshot ----

  // What this client believes the crowd near (x, z) is: one row per SLOT,
  // whether or not it currently carries a mesh, sorted so two clients can be
  // diffed line by line. The co-op tests are two clients comparing notes with
  // this; nothing in the game reads it.
  snapshot(x, z, r = ATTACH_R) {
    const wt = this.now();
    const out = [];
    for (const s of this._pool.values()) {
      const a = this._arcAt(s, wt);
      this._poseOn(s.steps, a.arc, _P);
      if (dist(_P.x - x, _P.z - z) > r) continue;
      out.push({
        key: s.key, seed: s.seed, gen: s.gen, arc: a.arc, span: s.span,
        speed: s.speed, side: s.side, x: _P.x, z: _P.z, body: !!s.body, doing: a.kind,
      });
    }
    out.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    return out;
  }
}
