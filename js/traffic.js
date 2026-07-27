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
//     keep the birth rate low.
//
// The authority SNAP channel is NOT used and does not need to be — see the
// note above _drive() for the byte count it would have cost.
// ==========================================================================

import * as THREE from 'three';
import { TRAFFIC, CAR_COLORS } from './config.js';
import { bridgeElevation, distPointToSegment } from './geo.js';
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
const STRAIGHT = Math.PI / 6; // ±30° reads as "carrying straight on"
// Time a real car loses on a speed dip, per (v−vc)²/(2v) — see _nomTo. The
// planning decel BRAKE, not BRAKE_SOFT: the anticipation envelope is what the
// driving layer actually shapes its approach with.
const RAMP_K = 1 / ACCEL + 1 / BRAKE;
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
const HONK_R = 110;           // m — horn() is an unpanned global one-shot, so only
                              // cars close enough to be plausibly audible get to use it

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
const SIG_CLASS = /^(primary|secondary|tertiary)$/;
const SIG_MAJOR = /^(primary|secondary)$/;           // one of these must be present
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
const PHANTOM_R = TRAFFIC.spawnR + ROUTE_MAX + CELL_HALF_DIAG;
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

export class Traffic {
  constructor(city, vehicles) {
    this.city = city;
    this.vehicles = vehicles;
    this.cars = new Set();          // public — minimap reads this. Only cars with a
                                    // MESH live here; schedules without one are in _pool.
    this.edges = [];                // every DIRECTED edge (reverse twins too)
    // Optional, and the single biggest lever on how well co-op traffic agrees:
    // main.js may fill this with EVERY player in the room — the local one plus
    // the ghost cars from netvehicles — as {x, z, half}. Traffic brakes for all
    // of them, which makes the reactive layer symmetric (client A and client B
    // both see the same three obstacles) instead of each client only braking
    // for itself. Ghost cars must NOT be pushed into this.cars; this list is
    // read-only to us and never touched by the follow bookkeeping.
    this.actors = null;
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
    this._scanT = 0;
    this._cullT = 0;
    this._simT = 0;                 // last simulated instant of SHARED time
    this._wt = 0;
    this._px = 0; this._pz = 0;
    this._densK = 1;
    this._obst = [];                // scratch: things a car must not drive into
    this._hornPool = HONK_POOL;     // global honk budget, refilled at HONK_RATE/s
    // ingest whatever is already loaded (legacy whole-city file, or region tiles
    // that landed before we were constructed), then subscribe for the rest —
    // optional chaining because bare test fixtures pass {roads:[…]} without it
    this.addTile({ roads: city.roads ?? [], signals: city.signals ?? [] });
    city.onTileLoaded?.((t) => this.addTile(t));
  }

  now() { return this.clock ? this.clock() : worldT(); }

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
    if (!c) this._cells.set(k, c = { ci, cj, edges: [], len: 0, sorted: null });
    c.edges.push(e);
    c.len += e.len;
    c.sorted = null;                              // order is rebuilt on demand
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
    const f = c.len * k / MPC;
    if (f >= SLOT_MAX) return SLOT_MAX;
    // DITHER the fractional slot instead of truncating it. At 03:00 main.js
    // asks for 6 % of the daytime fleet, which is well under one car per cell:
    // a plain floor() would empty the entire region, and "no traffic at all at
    // night" is not what a 24× density curve means. The extra car is granted
    // to a hash-chosen share of cells, so it is still the same cells on every
    // client — deterministic dithering, not a dice roll.
    const n = Math.floor(f);
    return n + (rnd01(hash32(c.ci, c.cj, 0x5eed)) < f - n ? 1 : 0);
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
      if (n._sg || n.deg < 3 || !n.ns || !n.ew) continue;
      cands.push(n);
    }
    if (!cands.length) return null;
    cands.sort((a, b) => (q4(a.x) - q4(b.x)) || (q4(a.z) - q4(b.z)));
    for (const n of cands) {
      let distinct = n.ns.size;                 // union of the two bucket sets —
      for (const r of n.ew) if (!n.ns.has(r)) distinct++;  // one road bent 90° isn't a crossing
      if (distinct < 2) continue;
      // …and the crossing must involve an ARTERIAL — see SIG_MAJOR above
      let major = false;
      for (const r of n.ns) if (SIG_MAJOR.test(r.t)) { major = true; break; }
      if (!major) for (const r of n.ew) if (SIG_MAJOR.test(r.t)) { major = true; break; }
      if (!major) { n._sg = 1; continue; }
      let owned = false;                        // a real cluster (or an earlier synthetic
      this._jgrid.near(n.x, n.z, (j) => {       // one) within SYNTH_CLEAR owns this crossing
        if (dist(j.x - n.x, j.z - n.z) < SYNTH_CLEAR) owned = true;
      });
      if (owned) { n._sg = 1; continue; }
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
    g.position.set(px, 0, pz);
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
    return { x, z, b: Math.abs(dz) >= Math.abs(dx) ? 0 : 1, lamps };
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
    if (!_cand.length) return edge.twin ?? null;  // oneway trap → null → route ends
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

  // Nominal speed on segment `seg` of this step's edge. Both ends of the
  // segment limit it: an interior polyline kink through vertAng, and at the
  // edge's first/last segment the TURN onto/off the edge, which vertAng cannot
  // know because it lives in the neighbouring edge.
  _segV(st, seg, vMax) {
    const e = st.e, A = e.vertAng, n = e.pts.length;
    const a0 = seg === 0 ? st.turnIn : A[seg];
    const a1 = seg === n - 2 ? st.turnOut : A[seg + 1];
    const v = Math.min(vMax, cornerLimit(a0), cornerLimit(a1));
    return v > 2 ? v : 2;
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
      let tgt = Math.min(e.cum[p.nseg + 1], limit);
      let sigHere = false;
      if (!p.nsig && e.sig && e.sigStop > p.na && e.sigStop < tgt) { tgt = e.sigStop; sigHere = true; }
      const raw = this._segV(st, p.nseg, p.vMax);
      const L = tgt - p.na;
      // FORWARD PROGRESS IS NOT OPTIONAL. `tgt` is a Float32Array read and
      // `limit` a double, so a piece of zero (or negative) length is a rounding
      // artefact, never geometry — and taking it costs dur = 0, which leaves
      // p.na and p.nt exactly where they were and spins this loop to its guard
      // on every future call, freezing the schedule for good (see the note on
      // rcum in _addEdge for the case that actually shipped). Snapping to the
      // edge's own end lets the next iteration take the hand-off branch.
      if (!(L > 1e-9)) { p.na = limit; continue; }
      // THE RAMP CHARGE, and it is the difference between a schedule that
      // holds and one that quietly runs away. The schedule changes speed at a
      // segment boundary instantly; a real car cannot, and the time it loses
      // slowing to a corner and winding back up is, exactly,
      //   (v−vc)²/(2·v) · (1/a + 1/b).
      // Left uncharged, that is ~1.2 s per corner — a car with a junction
      // every eight seconds falls 15 % behind its own schedule for ever, the
      // catch-up term saturates, and after a minute half the fleet is pinned
      // at LAG_MAX. Measured before this term: 15 cars of 97 more than 2 m
      // behind, the worst at the clamp. Charging it as a slightly lower speed
      // ACROSS the slow piece (rather than as a pause, which would stutter)
      // keeps the position curve smooth and the total time honest, so lag
      // oscillates a few metres around zero instead of drifting.
      let v = raw;
      if (raw < p.nvPrev && L > 0) {
        const d = p.nvPrev - raw;
        const pen = d * d * RAMP_K / (2 * p.nvPrev);
        v = Math.max(1.5, L / (L / raw + pen));
      }
      p.nv = v;
      const dur = L / v;
      if (p.nt + dur > T) return;                // T falls inside this piece
      p.na = tgt; p.nt += dur; p.nvPrev = raw;
      if (sigHere) { p.nsig = 1; p.nwait = redWait(e.sig, e.sigPh, p.nt); }
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
    const R = TRAFFIC.spawnR;
    const ci0 = Math.floor((px - PHANTOM_R) / CELL), ci1 = Math.floor((px + PHANTOM_R) / CELL);
    const cj0 = Math.floor((pz - PHANTOM_R) / CELL), cj1 = Math.floor((pz + PHANTOM_R) / CELL);
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
      }
    }
  }

  // Mint one car's entire existence from hash32(cell, slot, generation).
  _birth(sk, c, k, ss, gen, t0, wt) {
    const arr = this._cellEdges(c);
    if (!arr.length) return;
    const seed = hash32(ss, gen, 0x1d3);
    let e = null;
    const i0 = (rnd01(hash32(seed, 1)) * arr.length) | 0;
    for (let n = 0; n < 4 && n < arr.length; n++) {
      const cand = arr[(i0 + n) % arr.length];
      if (cand.len >= 14) { e = cand; break; }
    }
    if (!e) return;
    const sIn = 2 + rnd01(hash32(seed, 2)) * (e.len - 4);
    const vK = VK_MIN + rnd01(hash32(seed, 4)) * VK_VAR;
    const p = {
      key: sk, ci: c.ci, cj: c.cj, k, cell: c, seed, gen, t0, vK,
      routeM: ROUTE_MIN + rnd01(hash32(seed, 3)) * ROUTE_VAR,
      route: [{ e, base: -sIn, turnIn: 0, turnOut: 0 }],
      routeEnd: 0,
      // schedule state
      ni: 0, na: sIn, nt: t0, nseg: 0, nv: 0, nvPrev: 0, nwait: 0, nsig: 0,
      vMax: e.speed * vK, ndone: 0,
      // rendered state (only meaningful while attached)
      car: null, sR: 0, ri: 0, edge: e, s: sIn, seg: 0, next: null, laneOff: 0,
      sx: 0, sz: 0, sy: 0, sh: 0, px: 0, pz: 0, py: 0, ph: 0,
      heldT: 0, sigQ: false, graceT: 0, stolen: 0, dead: 0,
    };
    p.routeEnd = p.routeM;
    p.nsig = (e.sig && e.sigStop <= sIn) ? 1 : 0;
    this._pool.set(sk, p);
    this._nomTo(p, wt);
  }

  // Attach / detach meshes and reap dead or out-of-range schedules. Attaching
  // is the ONLY place a car gets a mesh, and it happens because the schedule
  // says the car is near — never because "it is time to spawn one".
  _sweepPool(wt, px, pz) {
    const inR2 = TRAFFIC.spawnR * TRAFFIC.spawnR;
    const outR2 = TRAFFIC.despawnR * TRAFFIC.despawnR;
    for (const p of this._pool.values()) {
      // generation rollover: this slot's car has served its time. A STOLEN slot
      // (or one claimed over the wire before we ever built it) sits here as a
      // tombstone for exactly that long, so the schedule cannot quietly refill
      // the car out from under the player driving it.
      const ss = hash32(WORLD_SEED, p.ci, p.cj, p.k);
      const gen = Math.floor((wt + rnd01(hash32(ss, 7)) * TRIP_T) / TRIP_T);
      if (gen !== p.gen) { this._reap(p); continue; }
      if (p.stolen) continue;                    // the player drives it now; not ours
      const cd = dist((p.ci + 0.5) * CELL - px, (p.cj + 0.5) * CELL - pz) - CELL_HALF_DIAG;
      if (cd > PHANTOM_R || p.k >= this._slots(p.cell)) { this._reap(p); continue; }
      if (p.car) {
        if (p.dead) { this._reap(p); continue; }
        const dx = p.sx - px, dz = p.sz - pz;
        if (dx * dx + dz * dz > outR2) this._detach(p);
        continue;
      }
      // detached: the schedule still runs, cheaply, so we know when it arrives
      this._nomTo(p, wt);
      if (p.ndone && p.nwait <= 0) { p.dead = 1; continue; }
      const pose = this._nomPose(p, wt);
      if (!pose) continue;
      const dx = pose.x - px, dz = pose.z - pz;
      if (dx * dx + dz * dz < inR2) this._attach(p, wt, pose);
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
    const bigOk = e0.speed >= FAST_EDGE && rnd01(hash32(p.seed, 5)) < BIG_CHANCE;
    const pool = bigOk ? BIG : COMMON;
    let kind = pool[(rnd01(hash32(p.seed, 6)) * pool.length) | 0];
    if (!VEH.CAR_KINDS.includes(kind)) kind = VEH.CAR_KINDS[0]; // roster drift guard
    const u = rnd01(hash32(p.seed, 8));
    let color;
    if (typeof VEH.pickCarColor === 'function') {
      const real = Math.random;
      try { Math.random = () => u; color = VEH.pickCarColor(kind); }
      finally { Math.random = real; }
    } else {
      color = CAR_COLORS[(u * CAR_COLORS.length) | 0];
    }
    this._setRendered(p, this._nomArc(p, wt));
    const e = p.edge;
    const heading = Math.atan2(-pose.dx, -pose.dz);
    p.laneOff = Math.min(TRAFFIC.laneOffsetK * e.road.w, TRAFFIC.laneOffsetMax);
    p.sh = p.ph = heading;
    p.sx = p.px = pose.x - pose.dz * p.laneOff;   // right of travel = (-dz, dx)
    p.sz = p.pz = pose.z + pose.dx * p.laneOff;
    p.sy = p.py = LAYER_Y.road +
      (e.road.br ? bridgeElevation(e.off0 + e.offSign * p.s, e.road._len) : 0);
    const car = this.vehicles.add(kind, p.sx, p.sz, heading, color);
    car.vK = p.vK;
    car.speed = this._nomV(p);
    car.ai = p;
    car.y = p.sy;
    car.mesh.position.set(p.sx, p.sy, p.sz);
    car.mesh.rotation.y = heading;
    p.car = car;
    this.cars.add(car);
  }

  _detach(p) {
    if (!p.car) return;
    this.cars.delete(p.car);
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
  update(dt, playerPos, playerCar) {
    if (!this.edges.length || !playerPos) return;
    const wt = this._wt = this.now();
    if (this._junctions.length) this._tickSignals(wt);

    const px = this._px = playerPos.x, pz = this._pz = playerPos.z;
    // Density knob, quantised to 1/32 so two clients standing together, whose eased density
    // knobs differ by a percent or two, still land on the same number and
    // therefore the same fleet. REQUEST to main.js: pass
    // `base * trafficTimeK(tod())` and DROP trafficPlaceK — how built-up a
    // place is now comes out of the road length per cell, which is a property
    // of the world rather than of whoever is standing in it, and while a
    // per-player place factor is in the product two players in genuinely
    // different surroundings will scale the shared world differently.
    const raw = (this.maxCars ?? TRAFFIC.maxCars) / (TRAFFIC.maxCars || 1);
    this._densK = Math.max(0, Math.min(3, Math.round(raw * 32) / 32));

    this._scanT -= dt;
    if (this._scanT <= 0) {
      this._scanT = SCAN_DT;
      this._sweepPool(wt, px, pz);
      this._scanCells(wt, px, pz);
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
        const d = (car.x - px) ** 2 + (car.z - pz) ** 2;
        if (d > wd) { wd = d; worst = car; }
      }
      if (!worst || !worst.ai) break;
      this._detach(worst.ai);
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
    car.ai = null;
    if (p) { p.stolen = 1; p.car = null; }
    return car;
  }

  slotKey(car) { return car?.ai?.key ?? null; }

  // A peer took this car. Kill our copy and hold the slot empty for the rest
  // of the generation. Works even if we never built the schedule (the peer may
  // be a street ahead of our streaming frontier) — the tombstone carries the
  // slot's real cell/index so the generation rollover reaps it on time.
  claimSlot(key) {
    const p = this._pool.get(key);
    if (p) { this._detach(p); p.stolen = 1; return; }
    const m = /^(-?\d+),(-?\d+)\/(\d+)$/.exec(String(key));
    if (!m) return;
    const ci = +m[1], cj = +m[2], k = +m[3];
    const ss = hash32(WORLD_SEED, ci, cj, k);
    const wt = this._wt || this.now();
    const gen = Math.floor((wt + rnd01(hash32(ss, 7)) * TRIP_T) / TRIP_T);
    this._pool.set(key, { key, ci, cj, k, gen, cell: null, stolen: 1, car: null, route: null });
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
        horn();
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

    this._nomTo(p, T);
    const Snom = this._nomArc(p, T);
    const lag = Snom - p.sR;
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
    for (const other of this.cars) {
      const o = other.ai;
      if (!o || o === p) continue;
      const rx = o.sx - p.sx, rz = o.sz - p.sz;
      const fwd = rx * fx + rz * fz;
      if (fwd <= 0 || fwd > TRAFFIC.lookAhead) continue;
      if (Math.abs(fx * rz - fz * rx) > LAT_GATE) continue;
      if (Math.abs(angWrap(o.sh - p.sh)) > HEAD_GATE) continue;
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
      if (gap < TRAFFIC.stopGap) { tgt = 0; hard = true; held = true; }
      else { const fv = (gap - TRAFFIC.stopGap) / 2;
             if (fv < tgt) { tgt = fv; held = true; } }
    }

    // ---- the horn. A driver pinned under 30 % of what they WANT to do, for
    // long enough that it's clearly not just flow (2.5 s), by whoever is ahead
    // — the player, mostly — leans on it. Personal 6–16 s cooldown so no one
    // machine-guns, the global pool caps the whole city at ~2/s, red lights
    // are exempt (sigHeld — you honk at the idiot ignoring a green, not at the
    // light), and horn() being an unpanned one-shot, only cars near enough to
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
      horn();
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
    if (arc >= Snom) { arc = Snom; const nv = this._nomV(p); if (car.speed > nv) car.speed = nv; }
    if (arc < Snom - LAG_MAX) {
      // Dragged forward against the brakes. This is the failure mode, not a
      // feature: something (a player parked across the lane, eleven seconds of
      // it) has held this car so far behind the shared world that we would
      // rather it drive through the obstruction than stand a block away from
      // where the other client draws it. vehicles.js will read the resulting
      // overlap as a collision, which is a fair description of what parking
      // across a road does.
      arc = Snom - LAG_MAX;
      car.speed = Math.max(car.speed, (arc - p.sR) / dt);
    }
    this._setRendered(p, arc);

    // ---- arrival. The schedule ran out of route; the car finishes whatever
    // lag it still owes, then stands there. It is removed once it is out of
    // sight (RETIRE_R) or after RETIRE_GRACE, whichever comes first — a car
    // blinking out 90 m away behind buildings is nearly invisible, one
    // blinking out in your mirror is not. Both clients compute the same
    // arrival point and the same stop; only the moment of removal is local,
    // and by construction it only differs for players too far away to see it.
    if (p.ndone && p.sR >= p.routeEnd - 0.05) {
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
    p.sy = LAYER_Y.road + (re.road.br ? bridgeElevation(re.off0 + re.offSign * p.s, re.road._len) : 0);
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
      out.push({ key: p.key, gen: p.gen, seed: p.seed, vK: p.vK,
        arc: this._nomArc(p, wt), x: pose.x, z: pose.z, done: !!p.ndone });
    }
    out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    return out;
  }
}
