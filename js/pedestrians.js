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
//   peds.onPedHit    = (ped, impactSpeed) => {}   // every qualifying hit
//   peds.onPedKilled = (ped) => {}                // once, when a hit is lethal
// ==========================================================================

import * as THREE from 'three';
import { makeCitizen } from './citizen.js';
import { PLAYER_SCALE, LAYER_Y } from './config.js';
import { worldT } from './worldclock.js';

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
const LIE_Y = 0.3;         // lying pivot height: body straddles the road deck
                           // (LAYER_Y.road 0.20) instead of sinking through it
const HALF_PI = Math.PI / 2;
// Panic, expressed as a bounded local deviation instead of a private identity:
// a frightened walker gains ground on its own schedule and then pays it back.
const FLEE_SPEED = 5.4;    // m/s while running from a bang
const RUSH_MAX = 45;       // m of lead a panic may build up before it stops helping
const RUSH_DECAY = 0.55;   // m/s the debt drains at once they calm down
const CALM_T = [6, 4];     // s of panic: base + spread

// ---- blood decals ----
const BLOOD_MAX = 40;      // pooled groups of 3 discs, oldest reused
const BLOOD_GROW = 2;      // s to spread to full size
const BLOOD_LIFE = 70;     // s on the ground, then shrink out over 2 s
const BLOOD_Y = LAYER_Y.road + 0.04; // above the road deck, below markings (0.26)

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

// walkable classes: everything the data marks as not drivable
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'living_street']);

// scratch for camera.getWorldDirection(); a Vector3 rather than a bare object
// because three.js writes into it
const _vdir = new THREE.Vector3();

// scratch poses, reused so the per-frame walk allocates nothing
const _P = { x: 0, z: 0, dx: 0, dz: 0 };
const _A = { x: 0, z: 0, dx: 0, dz: 0 };
const _B = { x: 0, z: 0, dx: 0, dz: 0 };

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
    this._ingest(city.roads);
    city.onTileLoaded?.((t) => this._ingest(t.roads));
  }

  now() { return this.clock ? this.clock() : worldT(); }

  // ---------------------------------------------------------------- graph ----

  // Keep only paths long enough to walk, give each one an identity that does
  // not depend on load order, file them under the cell holding their arc
  // midpoint, and index their endpoints so a junction lookup is a bucket read
  // rather than a scan of eight thousand ways.
  _ingest(roads) {
    for (const r of roads ?? []) {
      if (r.d || !FOOT.has(r.t) || r.p.length < 2) continue;
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

  // How many walkers this square of city owes the world. Two players with the
  // same density setting compute the same number for the same square, which is
  // the whole point. Quantising the knob to eighths is what makes "the same
  // setting" survive main.js easing it — two clients whose value differs by 3 %
  // still land on one number.
  _slots(c) {
    const k = this._densK;
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
  _walkPose(steps, arc, sign, side, span, out) {
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
    const opts = [];
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

  // Mint one citizen's entire existence from hash32(cell, slot, generation).
  _birth(sk, c, k, wt) {
    const arr = this._cellPaths(c);
    if (!arr.length) return;
    const ss = hash32(WORLD_SEED, c.ci, c.cj, k);
    const ph = rnd01(hash32(ss, 7)) * TRIP_T;    // slots must not all flip together
    const gen = Math.floor((wt + ph) / TRIP_T);
    const seed = hash32(ss, gen, 0x1d3);

    // start path: first candidate long enough, from a hashed offset into the
    // cell's canonical list — never index 0, which would pile every generation
    // onto the same pavement
    let r = null;
    const i0 = (rnd01(hash32(seed, 1)) * arr.length) | 0;
    for (let n = 0; n < 4 && n < arr.length; n++) {
      const cand = arr[(i0 + n) % arr.length];
      if (cand._plen >= MIN_PATH) { r = cand; break; }
    }
    if (!r) return;

    const total = r._plen;
    const dir = (hash32(seed, 3) & 1) ? 1 : -1;
    // leave at least 8 m of path in front of them, else the first step is a
    // turn-around on the spot
    const room = Math.max(0, total - 8);
    const off = dir > 0 ? rnd01(hash32(seed, 2)) * room : 8 + rnd01(hash32(seed, 2)) * room;
    const first = { r, off, dir, base: 0, len: dir > 0 ? total - off : off };

    const s = {
      key: sk, ci: c.ci, cj: c.cj, k, cell: c, seed, gen,
      t0: gen * TRIP_T - ph,
      speed: SPEED_MIN + rnd01(hash32(seed, 4)) * SPEED_VAR,
      side: (hash32(seed, 5) & 1) ? 1 : -1,
      routeM: ROUTE_MIN + rnd01(hash32(seed, 6)) * ROUTE_VAR,
      steps: [first], span: first.len,
      body: null,      // the mesh, when one is warranted
      held: 0,         // 1 = this slot lost its citizen to a car; stays empty
                       // until the generation rolls, so a corpse's place is not
                       // quietly refilled while the player stands over it
    };
    this._grow(s);
    if (s.span < 4) return;             // a stub with nowhere to go: skip the slot
    this._pool.set(sk, s);
  }

  // Build the beat out to routeM at birth, not lazily. Lazy growth would make
  // `span` depend on how long the client has been watching, and span is what
  // the triangle wave folds against — two clients must agree on it exactly.
  _grow(s) {
    while (s.span < s.routeM && s.steps.length < ROUTE_STEPS) {
      let last = s.steps[s.steps.length - 1];
      const nx = this._nextStep(last, hash32(s.seed, s.steps.length, 0x51));
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

  // Where the beat says this citizen is at shared time `wt`. Out and back:
  // fold the distance walked into [0, 2·span) and reflect. `sign` is +1 while
  // walking out, −1 on the way home, and it is what flips the heading and the
  // side of the pavement without any state.
  _arcAt(s, wt) {
    const span = s.span;
    const d = s.speed * (wt - s.t0);
    if (!(span > 0)) return { arc: 0, sign: 1, walked: d };
    const per = span * 2;
    let q = d % per;
    if (q < 0) q += per;
    return q <= span ? { arc: q, sign: 1, walked: d } : { arc: per - q, sign: -1, walked: d };
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
    for (const p of this.peds) {
      if (p.hitCd > 0) p.hitCd -= dt;
      if (p.state !== 'walk') { this._ragStep(p, dt); continue; }
      if (p.free) this._freeStep(p, dt);
      else this._schedStep(p, dt, wt);
    }

    this._bloodStep(dt);
  }

  // A walker on its schedule: position is read from shared time, never
  // integrated. `rush` is the only local term and it is a debt that drains.
  _schedStep(p, dt, wt) {
    const s = p.sch;
    const a = this._arcAt(s, wt);
    let extra = 0;
    if (p.calm > 0) {
      // panicking: gain ground on the nominal, in whichever direction takes
      // them away from the bang (p.fleeSign was set when they were scared)
      p.calm -= dt;
      extra = (FLEE_SPEED - s.speed) * dt * p.fleeSign;
      p.rush += extra;
      if (p.rush > RUSH_MAX) p.rush = RUSH_MAX;
      else if (p.rush < -RUSH_MAX) p.rush = -RUSH_MAX;
    } else if (p.rush !== 0) {
      // calm again: pay the lead back by walking a little slower (or a little
      // faster) until the debt is zero. Bounded transient with a restoring
      // force — the same guarantee traffic.js gives for its lag.
      const step = RUSH_DECAY * dt;
      extra = -Math.sign(p.rush) * Math.min(step, Math.abs(p.rush));
      p.rush += extra;
    }
    let arc = a.arc + p.rush;
    if (arc < 0) arc = 0; else if (arc > s.span) arc = s.span;

    // Which way are they actually MOVING? The nominal advances at s.speed·sign
    // and `rush` adds to that, and a citizen running from a bang can perfectly
    // well be going the opposite way to their own schedule. Face and pass the
    // real direction, or a fleeing walker moonwalks down the pavement — and
    // walks down the wrong side of it, since which side is "the right side"
    // depends on which way you are heading.
    const vArc = s.speed * a.sign + extra / (dt || 1e-3);
    this._walkPose(s.steps, arc, vArc < 0 ? -1 : 1, s.side, s.span, _P);
    p.x = _P.x;
    p.z = _P.z;
    const dx = _P.dx, dz = _P.dz;
    // fresh off the ground after a stun: ease from where they lay back onto
    // the walk position instead of snapping
    if (p.blend > 0) {
      p.blend = Math.max(0, p.blend - dt * 0.8);
      p.x += (p.bx - p.x) * p.blend;
      p.z += (p.bz - p.z) * p.blend;
    }
    const speed = Math.abs(vArc);
    this._face(p, dx, dz, dt);
    // Stride phase from DISTANCE WALKED, so it is shared like everything else
    // and survives the turn-around at the end of the beat without a hitch.
    // `rushT` is the extra ground a panic covered — zero for everyone who has
    // not been scared, which is everyone, almost always.
    p.rushT += Math.abs(extra);
    p.walkT = (a.walked + p.rushT) * 1.6;
    p.speed = speed;
    p.mesh.position.set(p.x, this._gy(p.x, p.z), p.z);
    p.mesh.rotation.y = p.heading;
    p.animate(p.walkT, Math.max(0.3, Math.min(1.3, speed / 1.4)));
  }

  /** Ground under a pedestrian — 0 while the height map for that tile is absent. */
  _gy(x, z) { return this.terrain ? this.terrain.heightAt(x, z) : 0; }

  // A body that left its slot — hit, stunned, got up and ran. Its motion is
  // this tab's business alone, so it integrates locally along the beat it was
  // walking and is dropped as soon as nobody can see it go.
  _freeStep(p, dt) {
    if (p.calm > 0 && (p.calm -= dt) <= 0) p.speed = SPEED_MIN + SPEED_VAR * 0.5;
    p.fArc += p.speed * p.fDir * dt;
    if (p.fArc <= 0) { p.fArc = 0; p.fDir = 1; }
    else if (p.fArc >= p.fSpan) { p.fArc = p.fSpan; p.fDir = -1; }
    this._walkPose(p.steps, p.fArc, p.fDir, p.side, p.fSpan, _P);
    p.x = _P.x;
    p.z = _P.z;
    const dx = _P.dx, dz = _P.dz;
    if (p.blend > 0) {
      p.blend = Math.max(0, p.blend - dt * 0.8);
      p.x += (p.bx - p.x) * p.blend;
      p.z += (p.bz - p.z) * p.blend;
    }
    this._face(p, dx, dz, dt);
    p.walkT += p.speed * dt * 1.6;
    p.mesh.position.set(p.x, this._gy(p.x, p.z), p.z);
    p.mesh.rotation.y = p.heading;
    p.animate(p.walkT, Math.max(0.3, Math.min(1.3, p.speed / 1.4)));
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
    const cap = Math.round((this.max ?? MAX_PEDS) * CAP_SLACK) + 4;

    // 1. ghosts: free bodies (ragdolls, corpses, runners, walkers the
    //    generation left behind) — no slot, own rules
    for (let i = this.peds.length - 1; i >= 0; i--) {
      const p = this.peds[i];
      if (!p.free) continue;
      if (p.state === 'dead') {
        if (p.deadT <= 0 && this._hidden(p.x, p.z, fx, fz)) this._drop(i);
        continue;
      }
      if (p.state !== 'walk') continue;                 // mid-flight: let it land
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
      const ss = hash32(WORLD_SEED, s.ci, s.cj, s.k);
      const gen = Math.floor((wt + rnd01(hash32(ss, 7)) * TRIP_T) / TRIP_T);
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
      this._walkPose(s.steps, a.arc, a.sign, s.side, s.span, _P);
      if (dist(_P.x - fx, _P.z - fz) > ATTACH_R) continue;
      if (!this._hidden(_P.x, _P.z, fx, fz)) continue;  // not in front of you, ever
      this._attach(s, wt);
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
      c = makeCitizen();
    } finally { Math.random = real; }

    // people share ONE scale with the player — a half-size hero among
    // full-size passers-by reads as a bug, whatever the constant is set to
    c.group.scale.setScalar(PLAYER_SCALE);
    this.scene.add(c.group);

    const a = this._arcAt(s, wt);
    this._walkPose(s.steps, a.arc, a.sign, s.side, s.span, _P);
    const p = {
      mesh: c.group, animate: c.walk,
      ragdollPose: c.ragdollPose, standPose: c.standPose, dispose: c.dispose,
      sch: s, free: 0, look: c.look,
      steps: s.steps, side: s.side,
      // Face the right way and stand at the right point of the stride from the
      // first frame: _face() eases over ~0.2 s, which would otherwise be a body
      // pirouetting into position the moment it arrives.
      x: _P.x, z: _P.z, heading: Math.atan2(-_P.dx, -_P.dz),
      walkT: a.walked * 1.6, speed: s.speed,
      rush: 0, rushT: 0, calm: 0, fleeSign: 1,
      // free-body state, only meaningful once released. ghostT is the seconds
      // this body has outlived its slot; GHOST_MAX collects it.
      fArc: 0, fDir: 1, fSpan: s.span, ghostT: 0,
      // hit-physics state: walk | rag (flying/sliding) | down (stunned) | dead
      state: 'walk', dead: false, y: 0, lieY: 0,
      vx: 0, vy: 0, vz: 0, avx: 0, avz: 0, bounced: false,
      hitCd: 0, hurtS: 0, downT: 0, deadT: 0,
      blend: 0, bx: 0, bz: 0,
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
    p.fSpan = s.span;
    // carry on from where the schedule had them, in the direction they faced
    const a = this._arcAt(s, this.now());
    p.fArc = Math.max(0, Math.min(s.span, a.arc + p.rush));
    p.fDir = a.sign;
    p.rush = 0;
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
    const s = Math.abs(car.speed);
    if (s <= HIT_MIN_SPEED) return false;
    const dx = p.x - car.x, dz = p.z - car.z;
    if (Math.abs(dx) > car.len || Math.abs(dz) > car.len) return false;
    // a car on a bridge deck (LAYER_Y.road + BRIDGE_Y ≈ 1.05) must not squash
    // the walker on the riverside path BELOW it; street cars sit at y ≈ 0.2
    if (Math.abs((car.y || 0) - p.y) > 0.9) return false;
    const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading);
    const rx = -fz, rz = fx;                     // right of travel
    const hl = car.len / 2, hw = car.wid / 2;
    const lying = p.state !== 'walk';
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
  // shove off the bonnet's centerline, tumble spin, splayed limbs
  _launch(p, car, s) {
    this._release(p);                            // physics owns them now, not the beat
    const dirS = car.speed >= 0 ? 1 : -1;        // reversing hits launch backward
    const fx = -Math.sin(car.heading) * dirS, fz = -Math.cos(car.heading) * dirS;
    const k = p.state === 'dead' ? NUDGE_K : 1;  // rolling a corpse, gently
    const kick = (s * 0.9 + 2) * k;
    const side = (p.x - car.x) * -fz + (p.z - car.z) * fx < 0 ? -1 : 1;
    p.vx = fx * kick - fz * side * 1.2 * k;      // lateral = right-of-travel × side
    p.vz = fz * kick + fx * side * 1.2 * k;
    p.vy = Math.min(6, 1.5 + s * 0.25) * k;
    const spin = Math.min(9, 2 + s * 0.6);
    p.avx = spin * (Math.random() * 1.4 - 0.7);
    p.avz = spin * (Math.random() * 1.4 - 0.7);
    p.state = 'rag';
    p.bounced = false;
    p.hitCd = HIT_COOLDOWN;
    p.hurtS = s;
    p.ragdollPose();
    const wasDead = p.dead;
    if (!wasDead && s > KILL_SPEED) p.dead = true;
    // SOUND: body thud (+ scream if fatal) belongs here — subscribe to onPedHit
    this.onPedHit?.(p, s);
    if (p.dead && !wasDead) this.onPedKilled?.(p);
    // SOUND: bystander screams — the crowd scatters
    this.panic(p.x, p.z, PANIC_R);
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
      if (p.deadT < CORPSE_FADE)                 // sink away — see CORPSE_FADE note
        m.position.y = p.lieY - (1 - Math.max(0, p.deadT) / CORPSE_FADE) * 1.2;
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
    d.g.position.set(x, this._gy(x, z) + BLOOD_Y, z);
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
        speed: s.speed, side: s.side, x: _P.x, z: _P.z, body: !!s.body,
      });
    }
    out.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
    return out;
  }
}
