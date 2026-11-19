// ---- City data: loading, spatial index, geometry helpers ----
// Everything the game knows about the world comes through here. loadCity()
// speaks BOTH data dialects: the legacy single-city JSON (pardubice.json,
// indexed whole at load) and the region manifest (public/data/manifest.json,
// where the world starts EMPTY and 4.8 km tiles stream in around the player
// via city.ensureTiles). Either way the caller gets one identical `city`
// object whose per-chunk index feeds streaming, collision and traffic — no
// consumer ever learns which dialect fed it. Pure math helpers (point-in-
// polygon, segment distance, bridge ramps) live here too — meshes, traffic
// and player all share one geometry truth.

import { stampPartyWallsSteps } from './partywalls.js';
import { withRoadPatches } from './roadpatches.js';
import { servicesInto } from './d11services.js';
import { CHUNK, BRIDGE_Y, BRIDGE_RAMP } from './config.js';
import { junctionOutline, indexBays, computeVerge, finishJunction, roadRank } from './streets.js';
import { bayAt, WALK_W } from './streets.js';
import { stitchStructures, stitchStructuresSteps, deckNodeLevel } from './underpass.js';
import { releaseStructures } from './underpassrelease.js';
import { workTurn as workTurnOn, queueJob as queueJobOn, guarded, addAllSteps, compactSteps, RELEASE_STATS } from './tilework.js';
import { onQuay } from './quayedge.js';
import { applyDip, underCap } from './dipchain.js';
import { corridorLevel, sameCorridor, inScope as corridorScope, outranks, surveyOf } from './corridorlevel.js';
import { fitSlip } from './slipgrade.js';
import { portalLevel } from './railportal.js';
import { fairLink, applyPins } from './corridorfit.js';
import { parallel as corridorParallel } from './corridorgeom.js';
import { fitCrossingPanels, indexTileCrossings } from './levelxing.js';

// how far ahead of the focus a tile starts loading. View streams ±600 m, so
// 2600 m of headroom means even 130 km/h driving gives a fetch ~55 s before
// its chunks could enter view — tiles are indexed long before they're seen.
const TILE_REACH = 2600;
// …and how far behind it gives its buildings back. The world reaches Prague
// now: driving the D11 end to end crosses ~50 tiles, and holding every
// building of every one of them would be about a gigabyte of live objects on a
// machine that also has to render. So a tile that falls this far behind goes
// SLIM — its buildings and trees are dropped and re-fetched if you come back,
// and once its whole footprint is that far away the rest goes too (evictDeep in
// loadCity), all but the ways, rails, pois, signals and car parks, which the
// session's graphs hold for good.
const EVICT_REACH = 9000;
// A deep-evicted tile also takes back what the session's GRAPHS built from its
// ways (city.onTileReleased): the traffic edges, nodes and lights, the route
// planner's graph, the cycle net, the walkers' paths and sites. Those were 323
// of the 433 MB four central Prague tiles left behind (survey, 14 Nov 2026).
// The ways themselves, the rails, pois, signals and car parks stay kept as
// before, so ids, junction pads and bridge links never change; on return the
// tile hands its kept ways and lights to the graphs again (`again` in the
// onTileLoaded payload). Safe because a tile is only deep-evicted when its
// whole footprint is EVICT_REACH from the player and every co-op peer: no car,
// walker, rider or route schedule is on those ways (all of them live within
// two kilometres of a viewer). false = the round-6 behaviour.
export const RELEASE_GRAPHS = true;
// …and since the round 7 polish the tile gives back its WAYS too: roads,
// rails, signals and car parks leave the flat arrays, the junction pads and
// crossing clusters built from them leave JUNCTIONS and CLUSTERS, and every
// link stitching made from a neighbour's way to them is taken off again
// (underpassrelease.js releaseStructures). Those were 110 of the 137 MB four central
// Prague tiles still left behind after the graph release (57 MB of it the
// junction registry alone, whose arms pinned every way). On return the tile
// is indexed exactly as on a first visit: the same slot-derived ids, fresh
// objects, indexJunctions and the stitching run again. Only the pois stay
// listed (t.poisIn): the pump, police and bus-stop readers file them once and
// they cost next to nothing. false = keep the ways as round 7 did.
export const RELEASE_DATA = true;
// Feature ids must survive that round trip unchanged: _id seeds the tree size
// jitter, the lamp stagger and which shed is a fast-food franchise, so a
// building that came back with a new id would come back as a different
// building. Ids are therefore derived from the tile, not from a global counter.
const IDS_PER_TILE = 1 << 20;

export const chunkKey = (x, z) => Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// distance from point to segment + the closest point (into out {x,z,t})
export function distPointToSegment(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const cx = ax + dx * t, cz = az + dz * t;
  if (out) { out.x = cx; out.z = cz; out.t = t; }
  return Math.hypot(px - cx, pz - cz);
}

// Legacy relative bridge lift, retained for callers that do not have terrain.
export function bridgeElevation(dist, totalLen) {
  const edge = Math.min(dist, totalLen - dist);
  return Math.max(0, Math.min(BRIDGE_Y, (edge / BRIDGE_RAMP) * BRIDGE_Y));
}

// ---- roads are built, not draped ------------------------------------------
// A road laid straight onto bare earth dives into every dell it crosses. The
// real one does not: it is built on a fill, and the fill is why a Czech road
// holds a grade instead of following the ground. DMR 5G is bare earth and OSM
// does not tag embankments, so the fill has to be inferred — and it can be,
// because a road's defining property is a maximum GRADE.
//
// The envelope: sample the terrain along the way, then raise any point that
// would need a steeper descent than a road is allowed, from both directions.
//
//     forward   y[i] = max(y[i], y[i−1] − G·ds)
//     backward  y[i] = max(y[i], y[i+1] − G·ds)
//
// The result never goes BELOW the ground — this fills, it never cuts, because
// cutting into a hill that is really there is a worse lie than a road that
// climbs it. It leaves the two ends exactly on the terrain, which is what keeps
// a road agreeing with the roads it joins: a dip at a junction stays a dip, and
// both ways see the same one.
//
// The fill is capped. Past MAX_FILL the honest reading is not "embankment" but
// "bridge somebody forgot to tag", and inventing a twelve-metre viaduct from a
// grade rule would be worse than the dip.
//
// Lazy, because terrain streams in after the roads do — and only cached once
// every sample is against ground that has actually arrived, the same discipline
// as waterLevel() and groundFor().
// ---- the road's LEVEL, and why it is not the ground's ----------------------
// A road is not a drape over the landscape. It is a surface a machine laid, and
// the thing that makes it read as a road rather than as painted dirt is that it
// is SMOOTH — the ground under Pardubice wanders by a couple of centimetres per
// metre and a real street does not.
//
// Two earlier tries were both the wrong shape. Draping straight onto the ground
// gave a road with every kink of a 20 m height grid in it, which is what "jsou
// takto hrbolaté" was about. Replacing that with a slope-limited envelope was
// worse in a way that took a screenshot to see: an envelope does not fill dips,
// it FLATTENS HILLS. Its cone reaches GRADE_FILL / grade — a hundred metres at
// the constants then in force — so every road running downhill came out on an
// embankment, and the city grew viaducts.
//
// What a road actually is: the smoothest line that stays within reach of the
// ground. So take the ground, blur it, and hold it between two bounds —
//
//   it may CUT into the hill by GRADE_CUT, which is not a free parameter: it is
//   the thickness of the surfacing (LAYER_Y.road, less 2 cm of daylight). The
//   ribbon renders that thickness above its level, so a road cutting by exactly
//   its own depth still lies ON the ground and can never be buried under it.
//   That is the entire trick, and it is nearly free: measured over 321 km of
//   real OSM roads on the Pardubice tile, the worst kink in the median road
//   falls from 2.1 cm to 0.04 cm at this depth alone.
//
//   it may FILL a hollow by GRADE_FILL, which is a real embankment and is
//   capped low, because an embankment nobody built is a viaduct.
//
// The blur and the bounds are applied alternately rather than once, because a
// bound applied to a finished blur puts a corner exactly where it bites — the
// max() of two smooth things is not smooth, and that single mistake was worth
// most of the remaining roughness.
//
// PINS. Every way is levelled alone, so ways meeting at a junction would each
// smooth their own way and arrive at different heights — a step at every
// corner, which is precisely the bumpiness being removed. So a junction node
// gets ONE height, computed from the node's own coordinates and therefore
// identical for every arm, and each arm's profile is pinned to it. junctionY
// averages a small disc rather than sampling a point: the shared height should
// itself be smooth, or the pins would put the ground's roughness straight back.
export const GRADE_CUT = 0.14;      // m the road may sink into the hill — under LAYER_Y.road
const GRADE_FILL = 1.6;      // m of embankment over a hollow, and no more
const GRADE_DS = 2;          // m between profile samples
const SMOOTH_SIGMA = 4;      // m — one blur pass…
const SMOOTH_PASSES = 24;    // …applied this many times, bounds re-imposed between
const PIN_TAPER = 30;        // m a junction's agreed height is blended in over
const BRIDGE_FILL = 12;      // m of embankment a bridge abutment may demand
const JUNCTION_R = 8;        // m — radius the shared junction height averages over

// ---- vertical curves ---------------------------------------------------------
// Where a grade changes, a real road does not fold: it bends through a
// parabola (a crest or a sag) long enough that a car at the design speed feels
// a gentle lift and nothing more. Every change of grade this module makes on
// purpose (an abutment's bank, a deck's ramp, an underpass) goes through these
// three, so none of them can leave a corner for a wheel to hit.
//
// The radius comes from the road's own speed: the vertical acceleration a
// crest or a sag asks of a car is v²/R, and CURVE_A keeps that a small
// fraction of gravity at the speed the road is signed for (386 m at 50 km/h,
// 756 m at 70), never under CURVE_MIN.
const CURVE_A = 0.5;          // m/s² over a crest or through a sag at design speed
const CURVE_MIN = 250;        // m, the tightest vertical curve anything here lays
const SMAX_K = 1.0;           // m over which two grades are blended into one
const DECK_K = 0.3;           // …and on a deck, between its line and its cones
const ABUT_HOLD = 20;         // m of an approach held at its bank's level (levelWay)
const FLOOR_STEEP = 0.2;      // the steepest a deck may climb over ground rising under it
/** The vertical curve radius for a way signed `v` km/h. */
export function curveR(v) {
  const ms = Math.max(30, v || 50) / 3.6;
  return Math.max(CURVE_MIN, ms * ms / CURVE_A);
}
/**
 * How far a bank falls `x` metres from its crest when it falls at grade `g`
 * with the crest rounded to radius `R`: a parabola, tangent to the level at the
 * crest and to the grade where it meets it, so the slope never jumps.
 */
export function crestFall(x, g, R) {
  const xt = g * R;
  return x <= xt ? x * x / (2 * R) : g * (x - xt / 2);
}
/**
 * The higher of two levels with the corner between them rounded: equal to
 * max(a, b) once they are SMAX_K apart, C1 where they cross (a polynomial
 * smooth maximum). Where an embankment's grade meets the road it lifts, this
 * is the sag at its foot.
 */
export function smax(a, b, k = SMAX_K) {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return (a > b ? a : b) + h * h * k / 4;
}
/**
 * The bank of every abutment along a way at arclength sAt: the deck's own
 * cones (crossCones) carried on past the end of the structure, so the bank
 * leaves the deck on the very curve the deck arrives on. The one function
 * levelWay and junctionY share.
 */
function bankAt(hardPins, sAt, g) {
  let E = -Infinity;
  for (const h of hardPins) {
    const x = Math.abs(sAt - h.s);
    for (const c of h.cones) {
      const e = c.y - crestFall(x + c.d, g, c.R);
      E = E === -Infinity ? e : smax(E, e);
    }
  }
  return E;
}
// Lay the abutments' bank under a levelled way: at each one the deck's height,
// rounded over a crest of the road's own radius, falling at BRIDGE_GRADE, and
// met by the road through a sag (smax). Capped like the old taper at
// BRIDGE_FILL over the survey: a bank taller than that is a viaduct somebody
// did not tag, not an embankment.
function hardFloor(y, ground, ds, hardPins, keep) {
  for (const h of hardPins) h.s = h.i * ds;
  for (let j = 0; j < y.length; j++) {
    let E = bankAt(hardPins, j * ds, BRIDGE_GRADE);
    const cap = ground[j] + BRIDGE_FILL;
    if (E > cap) E = cap;
    if (E > y[j] - SMAX_K) y[j] = smax(y[j], E);
  }
  // The blend lifts a level that sits right on the bank by up to SMAX_K/4,
  // and at a junction on the bank the other arms are not lifted with it: the
  // node is put back on its one height, the difference tapered out over
  // KEEP_TAPER metres either side so it leaves no corner.
  const r = Math.max(1, Math.round(KEEP_TAPER / ds));
  for (const k of keep) {
    const d = k.J - y[k.i];
    if (!(Math.abs(d) > 1e-4)) continue;
    for (let j = -r; j <= r; j++) {
      const q = k.i + j;
      if (q < 0 || q >= y.length) continue;
      y[q] += d * (0.5 + 0.5 * Math.cos(Math.PI * Math.abs(j) / r));
    }
  }
}
const KEEP_TAPER = 10;        // m
const CORRIDOR_CUT = 4;       // m a side road may follow a corridor down into its cutting
// m between a corridor and a way lying across it in plan only (an `_ovl`
// node, no shared OSM node) beyond which the two are on different levels
// (an untagged ramp, a carriageway on an embankment beside a slip under a
// bridge) and the overlap is no junction: the slip road was hauled 9 m up
// the trunk's bank 10 m past the deck it passes under.
const OVL_APART = 1.5;

/** One Gaussian pass over a 1-D profile, reflecting at the ends. */
function blurPass(y, out, sigma, ds) {
  const n = y.length, r = Math.max(1, Math.round((sigma * 2) / ds));
  if (n < 3) { for (let i = 0; i < n; i++) out[i] = y[i]; return out; }
  const w = new Float64Array(2 * r + 1);
  let sum = 0;
  for (let k = -r; k <= r; k++) { const v = Math.exp(-((k * ds) ** 2) / (2 * sigma * sigma)); w[k + r] = v; sum += v; }
  for (let i = 0; i < n; i++) {
    let a = 0;
    for (let k = -r; k <= r; k++) {
      // Reflect REPEATEDLY. A single fold is only enough while the kernel is
      // narrower than the profile, and a 30 m way sampled every 2 m is three
      // samples wide against a nine-sample kernel: one fold left the index
      // negative, the read was undefined, and the NaN went all the way out to
      // the vertex buffer — every short road in the city, silently.
      let j = i + k;
      while (j < 0 || j >= n) { if (j < 0) j = -j; if (j >= n) j = 2 * n - 2 - j; }
      a += y[j] * w[k + r];
    }
    out[i] = a / sum;
  }
  return out;
}

/**
 * The one height every road meeting at a node agrees on: the AVERAGE of what
 * its arms would each level themselves to there, left to themselves.
 *
 * The first version averaged the terrain over a disc instead, and it is worth
 * saying why that failed, because it looks reasonable. A disc average is a
 * perfectly good smooth function — it is just a DIFFERENT smooth function from
 * the one each road is computing along its own length, so every pin yanked the
 * profile off its natural line and left a corner. Measured over 197 km of
 * Pardubice roads: 0.05 cm of kink in the median road without pins, 1.22 cm
 * with disc-average pins — the pins were putting back most of the bumpiness the
 * levelling had just removed.
 *
 * Averaging the arms' own answers costs a second pass and fixes it outright:
 * the pin lands within centimetres of where each arm was going anyway, so it
 * corrects rather than overrides, and all the arms still meet exactly.
 */
export function junctionY(node, terrain) {
  if (node._ny !== undefined && node._nyT === terrain
    && (node._nyOk || (node._nyL === (terrain._loads ?? 0)
      && (node._nyF === undefined || !_streets || node._nyF === featStamp())))) return node._ny;
  node._nyT = terrain;
  // recursion guard: bridgeClearance below can wander back into this very
  // node via an approach road's pins — mid-computation reads must take the
  // provisional value, so the cache gate is satisfied UNTIL the real answer
  // (and the real readiness) replace it at the end
  node._nyOk = true;
  node._cones = null;
  node._nyF = undefined;
  node._ny = terrain.heightAt(node.x, node.z);
  // A node on a CORRIDOR (js/corridorlevel.js: heavy rail, the main roads)
  // is at the level of the highest corridor way meeting it, not at an
  // average: the slip road, the side street, the service road lying across
  // a carriageway and the road at a level crossing come to the corridor,
  // never the other way. (An average with a metre between the two pulled
  // the rychlodráha up and down every 20 m: survey 13, roads.md 2.3.)
  if (_streets) {
    let tp = null, ts = 0, top = null, lift = 0;
    if (node._xing) {
      const p = levelWay(node._xing, terrain, null, true);
      if (p?.cor) { tp = p; ts = node._xingS; lift = node._xingLift ?? 0; }
    }
    if (!tp) for (const arm of node.arms) {
      if (!corridorScope(arm.r) || (top && !outranks(arm.r, top))) continue;
      const p = levelWay(arm.r, terrain, null, true);
      if (!p?.cor) continue;
      top = arm.r; tp = p; ts = arm.s ?? 0;
    }
    if (tp) {
      node._ny = sampleProfile(tp, ts) + lift;
      node._apart = false;
      if (node._ovl) for (const arm of node.arms) {
        if (arm.r === top) continue;
        const p = levelWay(arm.r, terrain, null, true);
        if (p && Math.abs(sampleProfile(p, arm.s ?? 0) - node._ny) > OVL_APART) node._apart = true;
      }
      node._nyOk = !!tp.ready;
      node._nyL = terrain._loads ?? 0;
      node._nyF = featStamp();
      if (!tp.ready) terrain.missed = true;
      return node._ny;
    }
  }
  let a = 0, n = 0, allReady = true;
  // (a deck is not levelled like a road, and its draped line pulled the
  // approach down into a dip at the very abutment: the roads decide)
  const onlyDeck = node.arms.every((arm) => arm.r.br);
  for (const arm of node.arms) {
    if (arm.r.br && !onlyDeck) continue;
    const prof = levelWay(arm.r, terrain, null, true);
    if (!prof) continue;
    if (!prof.ready) allReady = false;
    a += sampleProfile(prof, arm.s);
    n++;
  }
  if (n) node._ny = a / n;
  // …unless a bridge meets here that has to clear something. Then the node is
  // as high as the deck needs to be, and the approach roads are embanked up to
  // it — which is what a real road over a railway is: a bridge and two banks.
  // Nothing else in the data says the deck belongs above the rails, so this is
  // where the height enters the world.
  // The node owes the deck what the deck needs HERE: each crossing's headroom
  // less the fall of the structure's grade between the crossing and this end
  // (one cone per crossing, crestFall). Asking for the highest headroom
  // anywhere along it, as this did, banked the approach of a 300 m flyover
  // up to the height it needs over the railway in its middle.
  let abut = false;
  for (const arm of node.arms) {
    if (!arm.r.br) continue;
    abut = true;
    if (!arm.r._cross && !arm.r._chain) continue;
    const cones = crossCones(arm.r, terrain);
    if (!cones.length) continue;
    const { at } = structEnd(arm.r, arm.i);
    const R = curveR(arm.r.v);
    for (const c of cones) {
      const d = Math.abs(c.s - at);
      const need = c.y - crestFall(d, BRIDGE_GRADE, R);
      if (need > node._ny - SMAX_K) {
        (node._cones ??= []).push({ y: c.y, d, R });
        if (need > node._ny) node._ny = need;
        node._hard = true;
      }
    }
  }
  // A junction ON an abutment's bank (a side road joining the ramp up to an
  // overpass) stands on the bank: the same function the way lays it with
  // (levelWay's hardFloor), read at this node, so the bank's way and the side
  // road both land on one height here instead of the bank being clipped short
  // of the junction.
  // (a real node only: the overlap links of a ramp and the street at its foot
  // are not a junction, and lifting them banked the street up the ramp)
  if (!abut && node.arms.every((a) => a.i >= 0)) {
    for (const arm of node.arms) {
      const pins = arm.r._pins;
      if (!pins || pins.length < 2) continue;
      let hard = null;
      for (const p of pins) {
        if (p.node === node || !p.node.arms.some((a) => a.r.br && (a.r._cross || a.r._chain))) continue;
        junctionY(p.node, terrain);
        if (p.node._hard === true && p.node._cones) (hard ??= []).push({ s: p.s, cones: p.node._cones });
      }
      if (!hard) continue;
      let E = bankAt(hard, arm.s, BRIDGE_GRADE);
      const g0 = terrain.heightAt(node.x, node.z) + BRIDGE_FILL;
      if (E > g0) E = g0;
      if (E > node._ny - SMAX_K) { node._ny = smax(node._ny, E); node._bank = true; }
    }
  }
  // A height measured on ground that had not arrived yet must not outlive
  // the ground's arrival — but it must also not be recomputed on every ask,
  // or the loading screen re-levels every arm of every junction per frame.
  // So the guess IS cached, stamped with the terrain load counter: the next
  // height tile invalidates it, readiness makes it final. terrain.missed
  // flags the chunk so the arriving tile rebuilds it and asks again.
  node._nyOk = allReady;
  node._nyL = terrain._loads ?? 0;
  if (!allReady) terrain.missed = true;
  return node._ny;
}

/** Read a levelled profile at an arclength — Catmull-Rom, clamped (see roadGradeY). */
function sampleProfile(prof, dist) {
  const u = Math.max(0, Math.min(prof.n - 1, dist / prof.ds));
  const i = Math.min(prof.n - 2, Math.floor(u)), f = u - i;
  const y = prof.y, n = prof.n;
  const p0 = y[i > 0 ? i - 1 : 0], p1 = y[i], p2 = y[i + 1], p3 = y[i + 2 < n ? i + 2 : n - 1];
  const v = p1 + 0.5 * f * ((p2 - p0) + f * ((2 * p0 - 5 * p1 + 4 * p2 - p3) + f * (3 * (p1 - p2) + p3 - p0)));
  const lo = p1 < p2 ? p1 : p2, hi = p1 < p2 ? p2 : p1;
  return v < lo ? lo : v > hi ? hi : v;
}

// The earthworks ask for the profile of EVERY way of a 4.8 km terrain tile
// (city.conformTerrainTile, and the slices that warm it), and through the door
// below that used to work out every one of their verges too: 18 000 of the
// 22 000 at the spawn, a second of main thread for streets nobody may ever
// drive down, which is the cost "on first use" exists to avoid. Worse, it
// asked each way's seam questions (does this end meet a road? is another
// carriageway here?) before the neighbouring data tile was indexed, and the
// answer stayed: a kerb closed round the end of a through street at a tile
// border. The bake reads levels, not verges, so it holds them off; the verge
// is then worked out by whoever first needs it, which is a chunk a few
// hundred metres from the player, long after its neighbours are in.
let _vergeHold = 0;
/** +1 to stop roadProfile deriving verges, -1 to let it again. Always paired. */
export function holdVerges(d) { _vergeHold += d; }

// A corridor's line (js/corridorlevel.js) reads every data tile in a window
// round its way, so a guess must also be retired when a DATA tile lands, not
// only a height map: the index's tile counter is the second stamp. A mesh
// worker has no city and no counter, and takes what travelled.
const featStamp = () => INDEX_STATS.tiles;
const corridorFresh = (c) => c.fl === undefined || !_streets || c.fl === featStamp();

export function roadProfile(way, terrain) {
  if (!terrain || !way?.p || way.p.length < 2) return null;
  // Every consumer of a way comes through here first, and so does chunkspec.js
  // before it copies a chunk's roads for the mesh worker: the one door through
  // which a way's verge is guaranteed to exist wherever it is read.
  if (way._vg === undefined && _streets && !_vergeHold) computeVerge(_streets, way);
  if (way._vg && way._vg.lv === undefined && _streets) levelVerge(way, _lvT = terrain);
  const c = way._prof;
  if (c && c.terrain === terrain
    && (c.ready || (c.loads === (terrain._loads ?? 0) && corridorFresh(c)))) return c;
  let prof = levelWay(way, terrain, way._pins ?? null);
  if (way.t === 'motorway_link') prof = fitSlip(way, prof, terrain, _streets, roadProfile);
  const portal = way._portal && portalLevel(way, surveyOf(terrain));
  if (prof && typeof portal === 'number') prof = { ...prof, y: new Float32Array(prof.n).fill(portal) };
  // Terrain answers with a guess while a height tile is still on the way.
  // The guess used to be thrown away — which meant the 24-pass levelling ran
  // AGAIN for every roadGradeY call on an unready way: the whole boot was
  // re-levelling the same roads thousands of times per second. So the guess
  // is cached like any answer, stamped with the terrain load counter; the
  // next height tile retires it, readiness makes it final, and terrain.missed
  // still flags the chunk to rebuild.
  if (prof) {
    prof.loads = terrain._loads ?? 0;
    // The underlying corridor can be final while a pin is still provisional.
    // Its old stamp would make every wheel and mesh vertex re-fit this road.
    if ((prof.cor || prof.crossingStations) && _streets) prof.fl = featStamp();
    way._prof = prof;
    if (!prof.ready) terrain.missed = true;
  }
  return prof;
}

/**
 * Level one way, with or without its junction pins. Called twice per way: once
 * unpinned so the nodes can agree on a height, once pinned to those.
 */
function levelWay(way, terrain, pinList, noDip = false) {
  const base = levelWayBase(way, terrain, pinList);
  // An UNDERPASS (js/underpass.js): the street dips under a railway or a
  // road bridge on one shared grade line for its whole run of ways. Laid on
  // top of the levelled way, never inside it: the unpinned line a junction
  // averages (junctionY) is the street as if nothing crossed it, and the dip
  // reaches the side roads through their pins instead.
  if (noDip || !base) return base;
  const crossings = pinList?.filter(({ node }) => node._xing);
  if (!way._dipChain && !crossings?.length) return base;
  const y = Float32Array.from(base.y);
  const ok = !way._dipChain || applyDip(way, y, base.ds, terrain);
  if (crossings?.length) {
    // A track crossing at grade can lie on an approach to a separate rail
    // bridge. The dip shapes that approach, but its outer taper must still
    // pass through the level of the track the road physically intersects.
    const panels = crossings.map(({ s, node }) => ({ s, y: junctionY(node, terrain) }));
    fitCrossingPanels(y, base.ds, panels);
    // A local road can be completely surveyed while a neighbouring railway
    // tile is still streaming. Keep its panel provisional until the rail
    // level used here is final, even when no new terrain raster arrives.
    const ready = base.ready && ok && crossings.every(({ node }) => node._nyOk);
    return { ...base, y, crossingStations: panels.map(p => p.s), ready };
  }
  return { ...base, y, ready: base.ready && ok };
}
// The pins a corridor way keeps: a node where a way of ANOTHER corridor that
// outranks it meets it (a link at its motorway, a road at a level crossing).
// Junctions with minor roads and overlaps with its own carriageways are not
// pins for it at all: they are where the others come to it.
function pinCorridor(way, cor, pinList, terrain) {
  const fl = featStamp(), keep = [];
  let ready = cor.ready;
  for (const pin of pinList) {
    const node = pin.node;
    let hi = null;
    if (node._xing) hi = node._xing;
    else for (const a of node.arms ?? []) {
      if (a.r === way || !corridorScope(a.r)) continue;
      if (!hi || outranks(a.r, hi)) hi = a.r;
    }
    if (!hi || !outranks(hi, way) || sameCorridor(way, hi, terrain, _streets, fl)) continue;
    const J = junctionY(node, terrain);
    if (node._apart === true) continue;
    if (!node._nyOk) ready = false;
    keep.push({ s: pin.s, J });
  }
  if (!keep.length) return cor;
  const y = Float64Array.from(cor.y);
  const pins = keep.map((k) => ({ s: k.s, d: k.J - sampleProfile(cor, k.s) }));
  applyPins(y, cor.ds, pins, (d) => Math.max(PIN_TAPER, Math.abs(d) / 0.03));
  return { ...cor, y: Float32Array.from(y), ready };
}
const _fairLinks = new WeakMap();
function levelWayBase(way, terrain, pinList) {
  // A way of a CORRIDOR (heavy rail, the main road classes) reads its
  // corridor's one line, and only a higher corridor meeting it may bend it
  // (js/corridorlevel.js). The pins are the residual against what that
  // higher way finally lies at; everything else it meets adapts to it.
  const cor = _streets && corridorScope(way) ? corridorLevel(way, terrain, _streets, featStamp()) : null;
  if (cor) {
    const profile = pinList ? pinCorridor(way, cor, pinList, terrain) : cor;
    if (!way.t.endsWith('_link') || way.br || way._dipChain) return profile;
    const cached = _fairLinks.get(profile);
    if (cached && cached.pins === way._pins && cached.n === way._pins?.length) return cached.value;
    const value = fairLink(profile, way);
    _fairLinks.set(profile, { pins: way._pins, n: way._pins?.length, value });
    return value;
  }
  const rc = way._raw;
  if (!pinList && rc && rc.terrain === terrain
    && (rc.ready || rc.loads === (terrain._loads ?? 0))) return rc;
  const total = way._len ?? polylineLength(way.p);
  if (total < GRADE_DS * 2) return null;
  const n = Math.ceil(total / GRADE_DS) + 1;
  const ds = total / (n - 1);
  const y = new Float32Array(n);
  const gx = new Float32Array(n), gz = new Float32Array(n);
  const top = new Float32Array(n);          // highest ground each sample answers for
  let ready = true;
  // The PRISTINE survey, wherever the earthworks have already moved the grid:
  // a way levelled after its tile was baked read the bake (its neighbours'
  // grades), one levelled before read the survey, so the same street came out
  // two ways by the order the tiles happened to arrive in (a co-op client
  // against another). js/corridorlevel.js surveyOf.
  const sv = surveyOf(terrain);
  // walk the polyline once, sampling at even arclength
  let seg = 0, acc = 0;
  let ax = way.p[0][0], az = way.p[0][1];
  let bx = way.p[1][0], bz = way.p[1][1];
  let segLen = Math.hypot(bx - ax, bz - az);
  for (let i = 0; i < n; i++) {
    const want = i * ds;
    while (want > acc + segLen && seg < way.p.length - 2) {
      acc += segLen; seg++;
      ax = way.p[seg][0]; az = way.p[seg][1];
      bx = way.p[seg + 1][0]; bz = way.p[seg + 1][1];
      segLen = Math.hypot(bx - ax, bz - az) || 1e-6;
    }
    const t = Math.max(0, Math.min(1, (want - acc) / segLen));
    const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
    gx[i] = x; gz[i] = z;
    if (terrain.ready && !terrain.ready(x, z)) ready = false;
    y[i] = sv.heightAt(x, z);
    // The floor is the HIGHEST ground this sample answers for, not the ground
    // exactly under it. roadGradeY reads the profile linearly between samples,
    // so a hummock sitting between two of them would be missed entirely and
    // would come up through the tarmac — measured at 0.22 m with a plain point
    // sample, which is more than the surfacing had to give.
    let hi = y[i];
    const dx = (bx - ax) / (segLen || 1), dz = (bz - az) / (segLen || 1);
    for (let k = -2; k <= 2; k++) {
      if (!k) continue;
      const o = (k / 2) * (ds / 2);
      const h = sv.heightAt(x + dx * o, z + dz * o);
      if (h > hi) hi = h;
    }
    top[i] = hi;
  }
  // AT AN ABUTMENT the ground the road answers to is the bank, not the dell
  // the bridge spans. The survey falls away under the last metres of every
  // approach (the abutment stands at the top of the slope down to the river
  // or the railway), and a road levelled to it sagged into the joint: 20 cm
  // down in the last 3 m, then the deck rising off it (the ring road by
  // Palackého). So over ABUT_HOLD metres from each end that meets a deck the
  // ground is held at the level it has ABUT_HOLD metres in.
  if (way._abut) {
    const h = Math.min(n - 1, Math.round(ABUT_HOLD / ds));
    for (const a of way._abut) {
      if (a < ds) { for (let i = 0; i < h; i++) if (y[i] < y[h]) y[i] = y[h]; }
      else if (a > total - ds) { const e = n - 1 - h; for (let i = n - 1; i > e; i--) if (y[i] < y[e]) y[i] = y[e]; }
    }
  }
  const ground = Float32Array.from(y);

  // The floor never outranks the ceiling. `top` is the highest ground a sample
  // answers for, and at a cliff falling between two samples that is metres
  // above the sample's own ground — taking it literally hauled a road 26 m into
  // the air at the lip of a quarry, one sample before the ground got there. No
  // profile can bridge a cliff it cannot see; the fill cap wins and the road
  // follows the drop.
  const lo = new Float32Array(n), hi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    hi[i] = ground[i] + GRADE_FILL;
    // ground a stamp DUG (a moat, js/terrainstamps.js) is not a hollow for
    // the levelling to fill: the road across the chateau's moat floor rode
    // over it on a 1.6 m bank and the bank's shoulders filled the moat back in
    const sd = terrain.stampDelta ? terrain.stampDelta(gx[i], gz[i]) : 0;
    if (sd < -0.25) hi[i] = ground[i] + 0.1;
    lo[i] = Math.min(top[i] - GRADE_CUT, hi[i]);
    // and in Prague a path on a lower quay or on a ramp or flight down to it
    // (quayedge.onQuay) lies ON the stamped ground: the stamps are drawn to be
    // walked, and a blurred path over a flight of stairs ran a metre under
    // its treads and over its foot. (Carriageways keep their own grade.)
    if (!way.d && onQuay(gx[i], gz[i])) { hi[i] = ground[i] + 0.1; lo[i] = ground[i]; }
  }

  // blur, then put the bounds back, and again — a bound applied once to a
  // finished blur leaves a corner exactly where it bites, and the max() of two
  // smooth things is not smooth.
  let a = Float64Array.from(ground), b = new Float64Array(n);
  for (let k = 0; k < SMOOTH_PASSES; k++) {
    blurPass(a, b, SMOOTH_SIGMA, ds);
    for (let i = 0; i < n; i++) b[i] = b[i] < lo[i] ? lo[i] : b[i] > hi[i] ? hi[i] : b[i];
    const t = a; a = b; b = t;
  }
  for (let i = 0; i < n; i++) y[i] = a[i];

  // ---- junctions, as a correction rather than a command ----
  // Each pin says "every arm here levels to THIS". Nailing the sample to it
  // works and looks terrible: the levelled road arrives a few centimetres off,
  // the nail drags it back over one sample, and the corner that makes is the
  // bumpiness all over again — measured at 1.05 cm of kink in the median
  // Pardubice road against 0.05 cm with the pins simply switched off.
  //
  // So the pin is applied as a taper instead: the whole offset at the node,
  // dying away over PIN_TAPER metres on a raised cosine, which meets the
  // untouched road with matching slope. The node still lands EXACTLY on the
  // agreed height — that is what stops a step between two ways — and the road
  // either side is bent by centimetres over tens of metres instead of being
  // kinked. Neighbouring pins clip each other's reach so their tapers cannot
  // overlap and fight.
  // (an overlap with a corridor on another level is no pin at all, and must
  // not clip the reach of the real ones beside it: junctionY marks it)
  if (pinList?.length && _streets) pinList = pinList.filter((pin) => (junctionY(pin.node, terrain), pin.node._apart !== true));
  if (pinList?.length) {
    const idx = pinList.map((pin) => Math.max(0, Math.min(n - 1, Math.round(pin.s / ds))));
    const order = idx.map((_, k) => k).sort((p, q) => idx[p] - idx[q]);
    const reach = Math.max(1, Math.round(PIN_TAPER / ds));
    const hardPins = [], keepPins = [];
    for (let o = 0; o < order.length; o++) {
      const k = order[o], i = idx[k], node = pinList[k].node;
      let J = junctionY(node, terrain);
      // a side road meeting a street inside its underpass meets it down there
      if (node._dipChain && way._dipChain !== node._dipChain) J = underCap(node._dipChain, node._dipU, J, terrain);
      // (an overlap with a corridor on another level is no junction: junctionY)
      if (node._apart === true) continue;
      // A HARD pin is a bridge abutment: the deck has to clear a railway, so
      // this road is the embankment that gets it up there. It used to be one
      // more taper in this loop, and a taper is clipped at half the distance
      // to the next pin: an approach with a side road joining 12 m short of
      // the abutment climbed its whole 3 m in those 12 m (the ring road
      // overpass by Palackého: 47 % up to the deck, 6.4 m down off it in
      // 8 m), which is the "you hit into the road" report. So an abutment is
      // a FLOOR now, laid after the junction tapers and blind to them
      // (hardFloor below), and the junctions inside its reach are lifted onto
      // the same bank by junctionY, so they still land exactly.
      // (every arm still lands on the node's one height first, the bank then
      // lies under them all alike)
      const hardNode = node._hard === true && !!node._cones;
      if (hardNode) hardPins.push({ i, J, cones: node._cones });
      else if (node._bank === true) keepPins.push({ i, J });
      const d = J - y[i];
      if (!Number.isFinite(d) || Math.abs(d) < 1e-4) continue;
      // never reach past a neighbouring pin, or past the end of the road
      // (a corridor's node only past another corridor node: a driveway's
      // overlap a few metres on clipped the climb onto the main road to 6 m;
      // the minor pins after it land on the bent line, so all still land)
      const corTop = node._nyF !== undefined;
      let prev = -Infinity, next = Infinity;
      for (let q = o - 1; q >= 0; q--) if (!corTop || pinList[order[q]].node._nyF !== undefined) { prev = idx[order[q]]; break; }
      for (let q = o + 1; q < order.length; q++) if (!corTop || pinList[order[q]].node._nyF !== undefined) { next = idx[order[q]]; break; }
      // (a side road meeting a bank climbs onto it at a ramp's grade, and may
      // be filled as high as the bank is)
      const bank = node._bank === true || hardNode;
      // A node ON A CORRIDOR (junctionY: its level is the corridor's, which is
      // hard) is reached like a bank: at a ramp's grade, past this road's own
      // fill and cut, or a side road a metre off the main road's level met it
      // in a 30 m kink, or stopped at its own 1.6 m cap with a step left over.
      const span = bank || corTop ? Math.max(reach, Math.round(Math.abs(d) / BRIDGE_GRADE / ds)) : reach;
      const back = Math.min(span, i, Math.floor((i - prev) / 2));
      const fwd = Math.min(span, n - 1 - i, Math.floor((next - i) / 2));
      for (let j = -back; j <= fwd; j++) {
        const w = j === 0 ? 1
          : 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.abs(j) / (j < 0 ? back : fwd)));
        const v = y[i + j] + d * w;
        const cap = bank || corTop ? ground[i + j] + BRIDGE_FILL : hi[i + j];
        const low = corTop ? ground[i + j] - CORRIDOR_CUT : lo[i + j];
        y[i + j] = v < low ? low : v > cap ? cap : v;
      }
    }
    if (hardPins.length) hardFloor(y, ground, ds, hardPins, keepPins);

  }
  const prof = { terrain, ds, n, y, ground, gx, gz, total, ready,
    loads: terrain._loads ?? 0 };
  if (!pinList) way._raw = prof;
  return prof;
}

/**
 * How far ABOVE the bare earth the built road sits at `dist` along it — the
 * embankment, in metres. Everything that places something on a road adds this:
 * the ribbon, surfaceY, and the traffic AI, so all three agree.
 */
export function roadLift(way, dist, terrain) {
  const prof = roadProfile(way, terrain);
  if (!prof) return 0;
  const u = Math.max(0, Math.min(prof.n - 1, dist / prof.ds));
  const i = Math.min(prof.n - 2, Math.floor(u)), f = u - i;
  const lift0 = prof.y[i] - prof.ground[i];
  const lift1 = prof.y[i + 1] - prof.ground[i + 1];
  return lift0 + (lift1 - lift0) * f;
}

/** The built road's absolute height at `dist` — bare earth plus its embankment. */
export function roadGradeY(way, dist, terrain) {
  const prof = roadProfile(way, terrain);
  if (!prof) return null;
  const u = Math.max(0, Math.min(prof.n - 1, dist / prof.ds));
  const i = Math.min(prof.n - 2, Math.floor(u)), f = u - i;
  // Catmull-Rom, not a straight line between samples. Reading a smooth profile
  // with a straight line puts a corner back at EVERY sample — measured on the
  // Pardubice roads, linear reading left the median road at 1.24 cm of kink
  // against the ground's 2.0, while the levelled profile itself is at 0.07: the
  // interpolation was throwing away almost all of the work.
  const y = prof.y, n = prof.n;
  const p0 = y[i > 0 ? i - 1 : 0], p1 = y[i], p2 = y[i + 1], p3 = y[i + 2 < n ? i + 2 : n - 1];
  const v = p1 + 0.5 * f * ((p2 - p0) + f * ((2 * p0 - 5 * p1 + 4 * p2 - p3) + f * (3 * (p1 - p2) + p3 - p0)));
  // …clamped to the two samples it lies between, so every bound the levelling
  // proved AT the samples — never cut deeper than the surfacing — still holds
  // between them. A spline may overshoot; a road may not.
  const lo = p1 < p2 ? p1 : p2, hi = p1 < p2 ? p2 : p1;
  return v < lo ? lo : v > hi ? hi : v;
}

// ---- the level a rail way is laid at ---------------------------------------------
// Heavy rail is its own earthwork: levelled like a road, flatter, on its own
// bed, and that profile is its level. A TRAM is not. Its track is a concrete
// panel let into a street, and the street has a levelled profile of its own:
// two lines smoothed separately over the same ground, which agree only where
// the ground is flat. Laid on the tram's line the panel stood up to 0.56 m
// proud of the asphalt it is set in, or lay buried under it (Prague tile
// -20_-2: of 25 631 samples of track inside a carriageway 2 793 more than
// 10 cm proud and 3 976 more than 10 cm under), and feet stepped onto an
// invisible plateau either side of it.
//
// So a tram takes each station's level from the carriageway that CONTAINS it:
// the deck of a drivable way, not a bridge, whose half width covers the
// station. Where no carriageway does (a reservation, a loop, a depot) it
// keeps its own profile, and the two are blended over TRAM_BLEND metres of
// track so the panel leaves the street without a step. A street more than
// TRAM_APART off the tram's own level is not the street it runs in but one
// passing over or under it, and is not asked.
//
// Where SEVERAL carriageways cover the station (the two halves of a boulevard
// are two ways, each drawn its full width, and levelled apart they overlap on
// different levels) it is the HIGHEST: that is the asphalt the eye sees there,
// and under it a panel laid on the nearer, lower one was buried (1 082 of the
// 23 789 in-street samples of that tile). And inside a crossing there is one
// more sheet of asphalt, the junction's pad, with a height of its own
// (junctionDeckY: the nearest arm's deck, never under the ground less the
// cut), drawn over the ways that run on through it: the track across a pad
// lies on whichever of the two is on top (tramPadY), or it disappeared under
// one crossing in three (1 421 of 4 838 samples on pads).
//
// One helper, because three things must give the same number: the panel
// (meshes.railWay), the feet on it (city.heightAt) and the mesh worker, which
// has no streets to ask. Like a road's profile the answer is worked out on the
// main thread, cached on the way (`_tg`, the shape sampleProfile reads) and
// carried to the worker by js/chunkspec.js.
const TRAM_APART = 1.5;      // m between a tram's own level and a street's: beyond it, another level
const TRAM_BLEND = 8;        // m of track from the street's deck back to the tram's own bed
const _tgC = [];             // the carriageways near the tram in hand: [way, x0, z0, x1, z1] flat
function tramGrade(way, terrain) {
  const c = way._tg;
  if (c && c.terrain === terrain && (c.ready || c.loads === (terrain._loads ?? 0))) return c;
  // a mesh worker has no city: what travelled is the answer, or there is none
  if (!_streets) return c && c.terrain === terrain ? c : null;
  const prof = roadProfile(way, terrain);
  if (!prof) return null;
  const n = prof.n, y = new Float32Array(n), dl = new Float32Array(n), has = new Uint8Array(n);
  let ready = prof.ready;
  // every carriageway that can contain a point of this track
  let a = Infinity, b = Infinity, c2 = -Infinity, d = -Infinity;
  for (const q of way.p) { if (q[0] < a) a = q[0]; if (q[1] < b) b = q[1]; if (q[0] > c2) c2 = q[0]; if (q[1] > d) d = q[1]; }
  a -= 16; b -= 16; c2 += 16; d += 16;
  _tgC.length = 0;
  for (let i = Math.floor(a / CHUNK); i <= Math.floor(c2 / CHUNK); i++) {
    for (let j = Math.floor(b / CHUNK); j <= Math.floor(d / CHUNK); j++) {
      for (const o of _streets.chunkIndex.get(i + ',' + j)?.roads ?? []) {
        if (!o.d || o.br || !o.p || o.p.length < 2 || !((o.w ?? 0) > 0) || _tgC.includes(o)) continue;
        let oa = Infinity, ob = Infinity, oc = -Infinity, od = -Infinity;
        for (const q of o.p) { if (q[0] < oa) oa = q[0]; if (q[1] < ob) ob = q[1]; if (q[0] > oc) oc = q[0]; if (q[1] > od) od = q[1]; }
        if (oc < a || oa > c2 || od < b || ob > d) continue;
        _tgC.push(o, oa, ob, oc, od);
      }
    }
  }
  for (let i = 0; i < n && _tgC.length; i++) {
    const x = prof.gx[i], z = prof.gz[i];
    // the highest deck among the carriageways that cover this station
    let top = -Infinity, br = null;
    for (let q = 0; q < _tgC.length; q += 5) {
      const o = _tgC[q], half = o.w / 2;
      if (x < _tgC[q + 1] - half || x > _tgC[q + 3] + half || z < _tgC[q + 2] - half || z > _tgC[q + 4] + half) continue;
      const op = o.p;
      let al = 0, bd = half, bs = -1;
      for (let k = 0; k < op.length - 1; k++) {
        const ax = op[k][0], az = op[k][1], ex = op[k + 1][0] - ax, ez = op[k + 1][1] - az;
        const L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
        let t = ((x - ax) * ex + (z - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dd = Math.hypot(x - ax - ex * t, z - az - ez * t);
        if (dd < bd) { bd = dd; bs = al + L * t; }
        al += L;
      }
      if (bs < 0) continue;
      const g = roadGradeY(o, bs, terrain);
      if (g === null || Math.abs(g - prof.y[i]) > TRAM_APART || g <= top) continue;
      top = g; br = o;
    }
    if (!br) continue;
    dl[i] = top - prof.y[i]; has[i] = 1;
    if (!br._prof?.ready) ready = false;
  }
  // between two stretches of street, and off the end of one: the difference
  // is carried across a short gap, and dies away along a long one
  const reach = Math.max(1, Math.round(TRAM_BLEND / prof.ds));
  for (let i = 0; i < n; i++) {
    if (has[i]) continue;
    let j = i;
    while (j < n && !has[j]) j++;
    const L = i - 1, R = j < n ? j : -1, len = j - i;
    for (let k = i; k < j; k++) {
      if (L >= 0 && R >= 0 && len <= 2 * reach) dl[k] = dl[L] + (dl[R] - dl[L]) * ((k - L) / (R - L));
      else {
        const fl = L >= 0 && k - L < reach ? dl[L] * (0.5 + 0.5 * Math.cos(Math.PI * (k - L) / reach)) : 0;
        const fr = R >= 0 && R - k < reach ? dl[R] * (0.5 + 0.5 * Math.cos(Math.PI * (R - k) / reach)) : 0;
        dl[k] = fl + fr;
      }
    }
    i = j;
  }
  for (let i = 0; i < n; i++) y[i] = prof.y[i] + dl[i];
  return (way._tg = { terrain, ds: prof.ds, n, y, has, own: prof.y, gx: prof.gx, gz: prof.gz, ready, loads: terrain._loads ?? 0 });
}

// The level of the junction pad a tram station lies on, or null where it lies
// on none. Asked LIVE and not baked into `_tg`: a pad's deck is floored by the
// ground as it stands (junctionDeckY), the earthworks move that ground after
// the first chunk has asked, and the pad's own mesh and the feet on it read
// the height afresh every time. The buckets are read as they stand, with the
// pad's outline only (geo.junctionHull): nothing here decides when a pad's
// kerb is worked out (js/streets.js on WHEN), and a mesh worker holds the
// buckets of every pad a rail homed in its chunk can reach (chunkspec
// padKeys). The same TRAM_APART as a street: a crossing on a flyover over the
// track is not the track's.
function tramPadY(tg, dist, terrain) {
  const u = Math.max(0, Math.min(tg.n - 1, dist / tg.ds));
  const i = Math.min(tg.n - 2, Math.floor(u)), f = u - i;
  const x = tg.gx[i] + (tg.gx[i + 1] - tg.gx[i]) * f, z = tg.gz[i] + (tg.gz[i + 1] - tg.gz[i]) * f;
  const own = tg.own[i] + (tg.own[i + 1] - tg.own[i]) * f;
  const ci = Math.floor(x / CHUNK), cj = Math.floor(z / CHUNK);
  let y = null;
  for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
    const k = (ci + a) + ',' + (cj + b);
    for (let pass = 0; pass < 2; pass++) {
      const list = pass ? CLUSTERS.get(k) : JUNCTIONS.get(k);
      if (!list) continue;
      for (const j of list) {
        // a member answers through its cluster, a roundabout node has no pad
        if (j._cluster || (!pass && j._ring)) continue;
        const R = (j.padR ?? j.pad ?? 6) + 1;
        if ((x - j.x) * (x - j.x) + (z - j.z) * (z - j.z) > R * R) continue;
        const ring = pass ? clusterHull(j) : junctionHull(j);
        if (!ring || !pointInPolygon(x, z, ring)) continue;
        // (the pad is drawn 12 mm over its deck height)
        const g = (pass ? clusterDeckY(j, x, z, terrain) : junctionDeckY(j, x, z, terrain)) + 0.012;
        if (Math.abs(g - own) <= TRAM_APART && (y === null || g > y)) y = g;
      }
    }
  }
  return y;
}

/** The absolute height a rail way is laid at, `dist` along it: a tram's street, a railway's own bed. */
export function railGradeY(way, dist, terrain) {
  if (way.t === 'tram' && !way.br && terrain) {
    const tg = tramGrade(way, terrain);
    if (tg) {
      const y = sampleProfile(tg, dist), pad = tramPadY(tg, dist, terrain);
      if (pad === null) return y;
      // on a pad: the pad, or the carriageway that runs over it where one does
      // (a station no carriageway covers has only its own bed in `y`)
      const i = Math.max(0, Math.min(tg.n - 1, Math.round(dist / tg.ds)));
      return tg.has[i] && y > pad ? y : pad;
    }
  }
  return roadGradeY(way, dist, terrain);
}

/** roadProfile for a rail way, with a tram's street level worked out too: what chunkspec forces before it copies. */
export function railProfile(way, terrain) {
  const prof = roadProfile(way, terrain);
  if (prof && way.t === 'tram' && !way.br) tramGrade(way, terrain);
  return prof;
}

// Absolute bridge-deck height. Adding bridgeElevation() to the terrain at every
// point makes a road faithfully copy the river valley below it, so the span
// holds ONE level across the middle of the OSM bridge way — the higher bank
// owns it, and the deck never dives into either side.
//
// But a level that runs edge to edge does not touch the ground at either end,
// and the approach road does: it is a separate OSM way, it drapes onto the
// terrain, and the two meet at a shared node. The difference is the abutment
// step — BRIDGE_Y at the high bank and the whole bank-to-bank drop plus
// BRIDGE_Y at the low one — and it is visible as a bridge floating clear of
// the road with daylight under the join.
//
// So the deck RAMPS: it leaves the ground at exactly the height the approach
// road has there, climbs to the span level, holds it, and comes back down. The
// endpoints are the one place the two ways are guaranteed to agree, because
// both are the same terrain sample at the same coordinate — even in the case
// the old comment worried about, an endpoint tagged out over the water, where
// the approach road dips to meet it just the same and no gap can open.
//
// The ramp is as long as the climb needs rather than a fixed 6 m: a 4 m rise
// over 6 m is a 66 % wall. Two fifths of the span is the ceiling, so a short
// bridge keeps a level middle instead of becoming two ramps that meet — and
// when the two limits fight, the length wins. A steep approach is a bridge you
// drive up; a vertical step is the gap this exists to close.
// A bridge ramp is a ROAD, so it climbs at a road's grade — the same 7.5 % the
// embankment grading uses. At the 25 % this used to allow, BRIDGE_Y's own 0.85 m
// of deck clearance came down over six metres, which is a 14 % kick right at
// the abutment and reads as "there is no ramp at all".
const BRIDGE_GRADE = 0.06;   // 6 % — what a real bridge approach climbs at
const FOOT_BRIDGE = new Set(['footway', 'path', 'steps', 'cycleway', 'pedestrian']);
export function bridgeDeckHeight(way, dist, terrain) {
  const total = way?._len ?? polylineLength(way?.p ?? []);
  if (!terrain || !way?.p?.length) return bridgeElevation(dist, total);
  // A deck of a CORRIDOR lies on its corridor's line, which carries the
  // headroom over what it crosses and the ground under its span as floors
  // (js/corridorlevel.js): approach and deck are one curve. (The worker
  // reads the same line, which travelled as `_prof`.)
  const railDeck = way.t === 'rail' || way.t === 'tram';
  if (!railDeck && corridorScope(way) && roadProfile(way, terrain)?.cor) return roadGradeY(way, dist, terrain);

  // ---- a chained bridge reads the CHAIN's grade, not its own --------------
  // One grade for the whole viaduct: anchored on the real approaches at its
  // two ends, lifted where a crossing demands headroom, climbing at a road's
  // 6 % — the upper envelope of the anchor line and one cone per clearance.
  if (way._chain) {
    const ch = way._chain;
    let prof = ch.profile;
    if (!prof || prof.terrain !== terrain
      || (!prof.ready && prof.loads !== (terrain._loads ?? 0))) {
      const anchor = (w, end) => {
        const link = end === 0 ? w._ap0 : w._ap1;
        const y = link && (railDeck ? railGradeY : roadGradeY)(link.road, link.at, terrain);
        if (y !== null && y !== undefined) return y;
        const yn = link ? null : deckNodeLevel(w, end, terrain, railDeck ? railGradeY : roadGradeY);
        if (yn !== null) return yn;
        const p = w.p[end === 0 ? 0 : w.p.length - 1];
        return terrain.heightAt(p[0], p[1]);
      };
      const hasA = ch.headJoint || (ch.headEnd === 0 ? ch.headWay._ap0 : ch.headWay._ap1) || deckNodeLevel(ch.headWay, ch.headEnd === 0 ? 0 : 1, terrain) !== null;
      const hasB = ch.tailJoint || (ch.tailEnd === 0 ? ch.tailWay._ap0 : ch.tailWay._ap1) || deckNodeLevel(ch.tailWay, ch.tailEnd === 0 ? 0 : 1, terrain) !== null;
      const headApproach = (ch.headEnd === 0 ? ch.headWay._ap0 : ch.headWay._ap1)?.road;
      const tailApproach = (ch.tailEnd === 0 ? ch.tailWay._ap0 : ch.tailWay._ap1)?.road;
      const headPortal = railDeck && portalLevel(headApproach, surveyOf(terrain)) !== null;
      const tailPortal = railDeck && portalLevel(tailApproach, surveyOf(terrain)) !== null;
      let A = anchor(ch.headWay, ch.headEnd === 0 ? 0 : 1);
      let B = anchor(ch.tailWay, ch.tailEnd === 0 ? 0 : 1);
      // (one end on a road and the other on nothing: the deck holds the road's level)
      if (hasA && !hasB && (way.d || railDeck)) B = A;
      else if (hasB && !hasA && (way.d || railDeck)) A = B;
      const cones = [];
      let samplesReady = true;
      const rdy = (x, z) => { if (terrain.ready && !terrain.ready(x, z)) samplesReady = false; };
      for (const c of crossCones(way, terrain)) { rdy(c.x, c.z); cones.push([c.s, c.y, 1]); }
      // ---- the terrain along the chain is a FLOOR --------------------------
      // A bridge is the thing that is above the ground along its whole line;
      // the profile so far only knew the ground at its crossings, so a smooth
      // hill shoulder mid-span rose straight through the deck. Sample the
      // ground at stations along every member and let each station push the
      // deck up, at the same 6 % the clearance cones use.
      const DS = 6, FLOOR = 0.2;
      for (const m of ch.members) {
        const mLen = m._len ?? polylineLength(m.p);
        let along = 0;
        for (let k = 0; k < m.p.length - 1; k++) {
          const [ax, az] = m.p[k], [bx, bz] = m.p[k + 1];
          const seg = Math.hypot(bx - ax, bz - az);
          for (let d = 0; d < seg; d += DS) {
            const t = d / seg;
            const sAt = along + d;
            const local = m._chainRev ? mLen - sAt : sAt;
            const fx2 = ax + (bx - ax) * t, fz2 = az + (bz - az) * t;
            rdy(fx2, fz2);
            const station = m._chainOff + local;
            // The survey measures the hillside over an unmapped rail tunnel.
            // At its open end the viaduct enters the hill at rail grade.
            const nearOpenRailEnd = (headPortal && station < 80) || (tailPortal && ch.total - station < 80);
            if (!nearOpenRailEnd) cones.push([station, terrain.heightAt(fx2, fz2) + FLOOR, 0]);
          }
          along += seg;
        }
      }
      // ---- and the anchors are LAW -----------------------------------------
      // An unclamped cone near an abutment lifted the deck's END above the
      // approach it lands on — a step in the carriageway, mid-air. The deck
      // must equal A at s=0 and B at s=total. Headroom over a crossing is a
      // hard constraint, so its cone keeps its height and STEEPENS instead —
      // just enough slope to fall back to each anchor, up to a 20 % worst
      // case; only past that is the height itself shaved. Terrain floors are
      // aesthetic, so they yield at the ruling grade.
      // The cones are crests now (crestFall, the road's own radius), and the
      // approaches are banked on the same curve (junctionY), so a crossing
      // near an end no longer steepens its cone to fall back to the anchor
      // inside the span: the bank carries the fall on, and the cap below only
      // bites where the bank could not be built (BRIDGE_FILL, a road too short).
      // A terrain floor near an end may steepen (up to FLOOR_STEEP) and
      // tighten its crest to fall back to the anchor in time: ground rising
      // at 9 % into the abutment would otherwise come up through the deck.
      const R0 = curveR(way.v);
      for (const c of cones) {
        const [cs, cy, hard] = c;
        let g = BRIDGE_GRADE, R = R0;
        if (!hard) {
          const dA = Math.max(cs, 1e-3), dB = Math.max(ch.total - cs, 1e-3);
          // (with the crest a quarter of the run, the fall over the run is
          // 7/8 of the straight grade's: hence the 0.875)
          g = Math.min(FLOOR_STEEP, Math.max(g, (cy - A) / (0.875 * dA), (cy - B) / (0.875 * dB)));
          R = Math.min(R0, Math.max(20, Math.min(dA, dB) / (4 * g)));
        }
        const cap = Math.min(A + crestFall(cs, g, R), B + crestFall(ch.total - cs, g, R));
        if (c[1] > cap) c[1] = cap;
        c[3] = R; c[4] = g;
      }
      // …and readiness means EVERY sampled point, not the two ends: a chain
      // crossing three tiles used to cache a profile whose middle was measured
      // on a tile that had not arrived, and keep it for the session.
      let ready = !terrain.ready;
      if (!ready) {
        const hp = ch.headWay.p[ch.headEnd === 0 ? 0 : ch.headWay.p.length - 1];
        const tp = ch.tailWay.p[ch.tailEnd === 0 ? 0 : ch.tailWay.p.length - 1];
        ready = terrain.ready(hp[0], hp[1]) && terrain.ready(tp[0], tp[1]) && samplesReady;
      }
      prof = { terrain, A, B, cones, total: ch.total, ready,
        loads: terrain._loads ?? 0 };
      ch.profile = prof;
      if (!ready) terrain.missed = true;
    }
    const local = way._chainRev ? total - Math.max(0, Math.min(total, dist))
      : Math.max(0, Math.min(total, dist));
    const s = way._chainOff + local;
    let y = prof.A + (prof.B - prof.A) * (s / prof.total);
    // (the blend narrows to nothing at the two ends, where the deck must be
    // exactly what its approach is)
    // The blend between the line and a cone is narrow (DECK_K: a 10 m round
    // where 6 % meets the line) and fades out over the last 10 m to each end,
    // so its lift grows from nothing instead of putting a step at the joint.
    const e = Math.min(1, Math.min(s, prof.total - s) / 10);
    const k = DECK_K * e * e * (3 - 2 * e);
    for (const [cs, cy, , R, g] of prof.cones) {
      const v = cy - crestFall(Math.abs(s - cs), g, R);
      y = k > 1e-3 ? smax(y, v, k) : v > y ? v : y;
    }
    return y;
  }

  let profile = way._bridgeProfile;
  if (!profile || profile.terrain !== terrain
    || (!profile.ready && profile.loads !== (terrain._loads ?? 0))) {
    // The APPROACH heights when the junction index found them (see
    // indexJunctions), and the endpoint only as a fallback for a bridge that
    // joins nothing — a footbridge over a stream with no road at either end.
    // The APPROACH heights when the junction index found them (see
    // indexJunctions) — the HIGHEST point on each approach, which is the crest
    // of the embankment the real road is built on. The endpoint is only a
    // fallback, for a bridge that joins nothing: a footbridge over a stream.
    // The height the road that CONTINUES is actually built at, right where the
    // two meet. roadProfile has already put the embankment under it, so this is
    // the crest without having to go looking for one.
    const reach = (link, fb, end) => {
      // (only a link OBJECT is a link: a footbridge's d is 0, and `0 && ...`
      // once handed back the number 0, a ramp down to sea level)
      const y = link && typeof link === 'object' ? roadGradeY(link.road, link.at, terrain) : null;
      if (y !== null && y !== undefined) return y;
      const yn = deckNodeLevel(way, end, terrain);
      return yn !== null ? yn : terrain.heightAt(fb[0], fb[1]);
    };
    const first = way.p[0], last = way.p[way.p.length - 1];
    // (a drivable deck with a road at one end only holds that road's level:
    // the survey under its other end is the dell, and the ramp down into it
    // was a 25 % wall on nábřeží Václava Havla. Unless that other end is a
    // joint with more decks: it then holds the joint's level, which every
    // member meeting there shares, js/underpass.js deckNodeLevel)
    const a0 = way._ap0 ?? (way.d && !way._apN0 ? way._ap1 : undefined);
    const a1 = way._ap1 ?? (way.d && !way._apN1 ? way._ap0 : undefined);
    const start = reach(a0, first, 0);
    const end = reach(a1, last, 1);
    // the grade each approach arrives with, along the deck (the ramps leave it on that)
    const slope = (link, sign) => {
      if (!link) return 0;
      const L = link.road._len ?? polylineLength(link.road.p);
      const away = link.at < L / 2 ? 1 : -1;
      const y0 = roadGradeY(link.road, link.at, terrain), y1 = roadGradeY(link.road, link.at + 2 * away, terrain);
      if (y0 === null || y1 === null || y0 === undefined || y1 === undefined) return 0;
      const m = sign * (y1 - y0) / 2;
      return m > 0.08 ? 0.08 : m < -0.08 ? -0.08 : m;
    };
    const m0 = way._ap0 ? slope(way._ap0, -1) : 0, m1 = way._ap1 ? slope(way._ap1, 1) : 0;
    // The deck sits at the height of the HIGHER road it joins, and nothing on
    // top of that. BRIDGE_Y's 0.85 m used to be added here, and it is a fossil:
    // it dates from a flat world, where a deck had to be lifted off the plane to
    // read as a bridge at all. On real terrain the BANK is already above the
    // water, so the lift buys nothing and costs the only thing that was wrong
    // with these crossings — it is the entire reason a ramp existed. At Kpt.
    // Bartoše the real road runs flat onto a flat bridge; ours climbed 0.85 m
    // and came back down, because of a constant that stopped meaning anything
    // the day the ground got a shape.
    //
    // A ramp now appears only where the two banks are at DIFFERENT heights,
    // which is the one case a real bridge ramps too.
    // …and never below what has to fit underneath. The approaches are embanked
    // to the same height (junctionY), so on a well-mapped crossing these agree;
    // the floor is here for the case where they could not get there.
    const need = bridgeClearance(way, terrain);
    let deck = Math.max(start, end, need ?? -Infinity);
    // The terrain along the span is a FLOOR here just as on a chain: a lone
    // bridge=yes way slanting across a hill shoulder had the smooth ground
    // rising straight through its level middle, because the deck only knew
    // the two banks and whatever it explicitly crosses.
    {
      let along = 0;
      for (let k = 0; k < way.p.length - 1; k++) {
        const [ax, az] = way.p[k], [bx, bz] = way.p[k + 1];
        const seg = Math.hypot(bx - ax, bz - az);
        for (let d2 = 0; d2 < seg; d2 += 6) {
          const t = d2 / seg;
          const h = terrain.heightAt(ax + (bx - ax) * t, az + (bz - az) * t) + 0.05;
          if (h > deck) deck = h;
        }
        along += seg;
      }
    }
    // A FOOTBRIDGE climbs by stairs, not by a road's 6 % ramp. Held to road
    // grade, a lávka lifted 5 m to clear the street below spent 16 m climbing
    // on each side of a 40 m span — two 31 % slopes meeting at a point, which
    // with the parapets on rendered as a row of huge black TENTS over the
    // Pardubice flyover. Stairs are ~50 %: short steep ends, long flat deck,
    // which is what a footbridge is.
    const foot = FOOT_BRIDGE.has(way.t);
    // Ground rising through the span (a deck slanting over a hill shoulder)
    // is the chain's case: one grade over the floor of the whole span, its
    // crests rounded, instead of a level at the knoll's top and two ramps.
    // A short road deck between two mapped approaches can have more rise
    // than a road-grade ramp can absorb. Use the whole span between those
    // fixed ends, with its ground and crossing clearance floors. Climbing
    // the full difference in the last two fifths made a near-vertical wall.
    const steepBanks = way.d && way._ap0 && way._ap1 && Math.abs(end - start) > 0.12 * total;
    if (!foot && (deck > Math.max(start, end) + 0.3 || steepBanks)) {
      const L = way._len ?? polylineLength(way.p);
      way._chain = { total: L, members: [way], headWay: way, headEnd: 0, tailWay: way, tailEnd: way.p.length - 1 };
      way._chainOff = 0; way._chainRev = false;
      return bridgeDeckHeight(way, dist, terrain);
    }
    const rampFor = (rise) => (foot
      ? Math.min(total * 0.3, Math.max(3, Math.abs(rise) / 0.5))
      : Math.min(total * 0.4, Math.max(BRIDGE_RAMP, Math.abs(rise) / BRIDGE_GRADE)));
    profile = { terrain, start, end, deck, m0, m1,
      r0: rampFor(deck - start), r1: rampFor(deck - end) };
    // A foot RAMP is a ramp along its whole length. The spiral serving the
    // Pardubice footbridge connects the ground to the deck five metres up, and
    // the flat-middle model made it jump in its first metres and then run
    // LEVEL round the loop, wrapped in a parapet falling all the way to the
    // ground — the tall black C. When a foot way's two ends differ by more
    // than a storey's worth, the whole way IS the climb.
    if (foot && Math.abs(end - start) > 1.5) profile.linear = true;
    // A SHORT deck between banks a little apart is one grade, not a level
    // and a ramp: held to the higher bank, a 14 m span 0.9 m out of level
    // came down 18 % in its last 5 m. One cubic from bank to bank, on the
    // grades the approaches arrive with, where nothing under it asks for more.
    else if (!foot && deck <= Math.max(start, end) + 0.01 && Math.abs(end - start) > 0.05
      && Math.abs(end - start) / BRIDGE_GRADE > total * 0.4 && Math.abs(end - start) <= 0.12 * total) profile.whole = true;
    // Terrain answers 0 while a height tile is still on the way. Remember the
    // profile only after both approaches are authoritative; the arriving tile
    // then rebuilds the chunk and gets a fresh, correct level.
    profile.ready = !terrain.ready
      || (terrain.ready(first[0], first[1]) && terrain.ready(last[0], last[1]));
    profile.loads = terrain._loads ?? 0;
    way._bridgeProfile = profile;
    if (!profile.ready) terrain.missed = true;
  }

  const d = Math.max(0, Math.min(total, dist));
  if (profile.linear) return profile.start + (profile.end - profile.start) * (d / total);
  if (profile.whole) return hermite(profile.start, profile.m0 ?? 0, profile.end, profile.m1 ?? 0, total, d);
  // The ramps are cubic (Hermite): they leave the bank on the grade the
  // approach arrives with and meet the deck level, so neither end of a ramp
  // is a fold. A straight ramp put two corners of up to 18 % into every
  // bridge whose banks differ (Na Haldě, Prokopův most).
  if (d < profile.r0 && profile.r0 > 0) return hermite(profile.start, profile.m0 ?? 0, profile.deck, 0, profile.r0, d);
  const back = total - d;
  if (back < profile.r1 && profile.r1 > 0) return hermite(profile.end, -(profile.m1 ?? 0), profile.deck, 0, profile.r1, back);
  return profile.deck;
}

/** Cubic from (0, y0) leaving at slope m0 to (L, y1) arriving at slope m1, read at x. */
function hermite(y0, m0, y1, m1, L, x) {
  const t = x / L, t2 = t * t, t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * L * m0 + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * L * m1;
}

// ---- roads are curves, and OSM stores them as corners ----------------------
// A mapper puts a vertex where the road changes direction, not where it is
// changing direction — so a sweeping bend arrives as three or four points with a
// 30° kink at each. Everything downstream inherits that: the ribbon renders a
// faceted corner, and the traffic AI, which takes its heading from the segment
// it is on, snaps a car through 30° in a single frame. That is the "roboticky,
// nereálně a fakt rychle" turn, and it is the same defect as the visible one.
//
// So the corners are ROUNDED once, here, before anything reads them — the mesh,
// the AI's rails, surfaceY and the minimap all see the same line, which is the
// whole reason to do it at load rather than in the renderer.
//
// A fillet, not a spline. The obvious move is Catmull-Rom through the existing
// points, and it is wrong: uniform Catmull-Rom overshoots wildly when segment
// lengths are uneven, and OSM road geometry is nothing but uneven. Measured
// over three tiles it threw a service road 75 m off its own right-of-way. A
// quadratic Bézier tucked into each corner cannot do that — it lives strictly
// inside the triangle formed by the two cut points and the corner, so the
// deviation is bounded by the cut, by construction rather than by luck.
//
// The first and last joints are never rounded: those are junctions, and a
// junction that moves comes apart from the road it joins.
const BEND_MIN = 0.22;      // rad (~13°) — below this a joint reads as straight,
                            // and rounding it would double the road vertex count for
                            // corners nobody can see
const BEND_CUT = 0.4;       // at most this fraction of a segment goes into a corner
const BEND_MAX_CUT = 9;     // m — and no more than this, however long the road
const BEND_MAX_PTS = 600;   // a motorway interchange is not worth ten thousand points
function smoothBends(p, isBridge) {
  // A bridge is a straight deck by definition and its height is interpolated
  // between the two abutments; rounding it would fight that.
  if (isBridge || !p || p.length < 3 || p.length > BEND_MAX_PTS) return p;
  const out = [p[0]];
  let any = false;
  for (let i = 1; i < p.length - 1; i++) {
    const a = p[i - 1], b = p[i], c = p[i + 1];
    const ax = b[0] - a[0], az = b[1] - a[1];
    const cx = c[0] - b[0], cz = c[1] - b[1];
    const la = Math.hypot(ax, az), lc = Math.hypot(cx, cz);
    if (la < 1 || lc < 1) { out.push(b); continue; }
    const turn = Math.acos(Math.max(-1, Math.min(1,
      (ax * cx + az * cz) / (la * lc))));
    if (turn < BEND_MIN) { out.push(b); continue; }
    // Never more than BEND_CUT of either neighbour, so two adjacent corners
    // cannot eat into each other however short the segment between them is.
    const cut = Math.min(la * BEND_CUT, lc * BEND_CUT, BEND_MAX_CUT);
    if (cut < 0.5) { out.push(b); continue; }
    const s0 = [b[0] - (ax / la) * cut, b[1] - (az / la) * cut];
    const s2 = [b[0] + (cx / lc) * cut, b[1] + (cz / lc) * cut];
    // pieces follow how far it turns: 9° is two, a right angle is five
    const n = Math.max(2, Math.min(6, 2 + Math.round(turn / 0.45)));
    out.push(s0);
    for (let k = 1; k < n; k++) {
      const t = k / n, u = 1 - t, w0 = u * u, w1 = 2 * u * t, w2 = t * t;
      out.push([w0 * s0[0] + w1 * b[0] + w2 * s2[0],
        w0 * s0[1] + w1 * b[1] + w2 * s2[1]]);
    }
    out.push(s2);
    any = true;
  }
  out.push(p[p.length - 1]);
  return any ? out : p;
}

// ---- junctions are places, not accidents of overlap -----------------------
// Every OSM way is drawn as its own ribbon, so where three of them meet, three
// ribbons lie across each other at three angles, each with a rounded cap on its
// end. What you see is the seams between them and the caps poking out of the
// tarmac — the roads "bulging into each other".
//
// A real junction is one surface. So: the ways that END at a shared node are
// pulled BACK from it, far enough to clear the widest road there, and the hole
// they leave is filled with a single pad built from the arms themselves. A way
// that merely PASSES THROUGH the node (the top of a T) is not touched — it is
// already continuous, and the pad only has to fill the corners beside it, which
// is exactly what a real junction looks like from above.
//
// Nodes are found by exact coincidence. OSM ways share a node by identity, the
// pipeline converts every one of them through the same projection, and
// smoothBends() never moves a first or last point — so the coordinates are
// equal to the bit, and a 2 cm hash is generous.
const J_KEY = (x, z) => Math.round(x * 50) + ',' + Math.round(z * 50);
const J_MIN_ARMS = 3;       // two ways meeting is a way that was split, not a junction
// ---- overlaps that share no node -------------------------------------------
// Two carriageways can cover the same ground without OSM ever joining them: the
// parallel ways of one street, a service road along a kerb, a driveway crossed
// by a lane. Each is levelled on its own and nothing ties them, so one ends up
// lying ON the other — "je to jako vyšší layer... s autem nadskočím".
//
// Measured over one Pardubice tile: 5 474 overlapping samples. The median step
// is 5 mm and harmless, but 368 exceed 15 cm and the worst is 1.69 m between
// two 3.6 m service roads. Real junctions were never the problem — where two
// ways genuinely share a node the pins already agree to within a centimetre
// (795 junctions measured, worst 1 cm).
//
// So an overlap becomes a junction node too. junctionY then averages the arms
// exactly as it does at a crossroads, and levelWay's existing taper bends both
// ways into agreement over PIN_TAPER metres instead of stepping. Where the two
// already agree the average is a no-op, which is why this can be done blind at
// index time, before any terrain has loaded.
//
// `layer` is what keeps a real flyover out of it: a road bridging another is
// SUPPOSED to sit higher. In the tile above every one of the 368 bad overlaps
// was on the same layer — but the tag is in the data now, and the guard costs
// one comparison.
const OVL_STEP = 20;   // m between nodes along a long overlap — 40 left the
                       // mid-span of a parallel pair unreconciled; below 20 the
                       // segment pairs themselves run out and nothing changes
const OVL_NEAR = 18;   // m — a real shared node this close already agrees
const OVL_G = 60;      // m bucket for the segment index

function pointAt(r, s) {
  let run = 0;
  for (let i = 0; i < r.p.length - 1; i++) {
    const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
    const L = Math.hypot(bx - ax, bz - az) || 1e-9;
    if (run + L >= s || i === r.p.length - 2) {
      const t = Math.max(0, Math.min(1, (s - run) / L));
      return [ax + (bx - ax) * t, az + (bz - az) * t];
    }
    run += L;
  }
  return [r.p[0][0], r.p[0][1]];
}

function nearestOn(r, x, z) {
  let best = Infinity, bs = 0, run = 0;
  for (let i = 0; i < r.p.length - 1; i++) {
    const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + ex * t), z - (az + ez * t));
    if (d < best) { best = d; bs = run + L * t; }
    run += L;
  }
  return { d: best, s: bs };
}

function segDist(a1x, a1z, a2x, a2z, b1x, b1z, b2x, b2z) {
  // proper crossings first: a driveway cutting a lane meets it at ONE point a
  // few metres long, which endpoint tests alone would walk straight past
  const dax = a2x - a1x, daz = a2z - a1z, dbx = b2x - b1x, dbz = b2z - b1z;
  const den = dax * dbz - daz * dbx;
  if (Math.abs(den) > 1e-9) {
    const t = ((b1x - a1x) * dbz - (b1z - a1z) * dbx) / den;
    const u = ((b1x - a1x) * daz - (b1z - a1z) * dax) / den;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
      return { d: 0, x: a1x + dax * t, z: a1z + daz * t };
  }
  let best = Infinity, bx = a1x, bz = a1z;
  const test = (px, pz, q1x, q1z, q2x, q2z) => {
    const ex = q2x - q1x, ez = q2z - q1z, L2 = ex * ex + ez * ez || 1e-9;
    let t = ((px - q1x) * ex + (pz - q1z) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = q1x + ex * t, cz = q1z + ez * t;
    const d = Math.hypot(px - cx, pz - cz);
    if (d < best) { best = d; bx = (px + cx) / 2; bz = (pz + cz) / 2; }
  };
  test(a1x, a1z, b1x, b1z, b2x, b2z);
  test(a2x, a2z, b1x, b1z, b2x, b2z);
  test(b1x, b1z, a1x, a1z, a2x, a2z);
  test(b2x, b2z, a1x, a1z, a2x, a2z);
  return { d: best, x: bx, z: bz };
}

function* linkOverlaps(roads, at) {
  const usable = roads.filter((r) => r.d && !r.br && r.p?.length > 1 && r.w > 0);
  if (usable.length < 2) return;
  for (const r of usable) r._len ??= polylineLength(r.p);
  // bucket SEGMENTS, not whole ways: an overlap at a crossing is only a few
  // metres long, and sampling a way at intervals walks past almost all of them
  // — the first version of this pass sampled every 40 m and missed 297 of the
  // 368 bad overlaps in the tile, which are exactly the crossings.
  const grid = new Map();
  let built = 0;
  for (const r of usable) {
    if ((++built & 127) === 0) yield;
    let run = 0;
    for (let i = 0; i < r.p.length - 1; i++) {
      const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
      const L = Math.hypot(bx - ax, bz - az) || 1e-9;
      const seg = { r, ax, az, bx, bz, run, L };
      const x0 = Math.floor(Math.min(ax, bx) / OVL_G), x1 = Math.floor(Math.max(ax, bx) / OVL_G);
      const z0 = Math.floor(Math.min(az, bz) / OVL_G), z1 = Math.floor(Math.max(az, bz) / OVL_G);
      for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
        const k = gx + ',' + gz;
        let a = grid.get(k);
        if (!a) grid.set(k, a = []);
        a.push(seg);
      }
      run += L;
    }
  }
  yield;
  const made = new Set();
  let step = 0;
  for (const segs of grid.values()) {
    // (a bucket of the two D11 carriageways, which overlap along their whole
    // length, is the expensive kind: every pair is a hit and a nearestOn)
    if ((++step & 63) === 0) yield;
    for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
      const A = segs[i].r, B = segs[j].r;
      if (A === B || (A.l ?? 0) !== (B.l ?? 0)) continue;
      // the two carriageways of one corridor read one line: nothing to agree
      if (corridorScope(A) && corridorScope(B) && corridorParallel(A, B)) continue;
      const reach = (A.w + B.w) / 2;
      const hit = segDist(segs[i].ax, segs[i].az, segs[i].bx, segs[i].bz,
        segs[j].ax, segs[j].az, segs[j].bx, segs[j].bz);
      if (hit.d > reach) continue;
      const lo = A._id < B._id ? A : B, hi = A._id < B._id ? B : A;
      const sLo = nearestOn(lo, hit.x, hit.z), sHi = nearestOn(hi, hit.x, hit.z);
      // …but not where they already meet properly
      let shared = false;
      for (const pin of lo._pins ?? []) {
        if (Math.abs(pin.s - sLo.s) > OVL_NEAR) continue;
        if ((pin.node.arms ?? []).some((arm) => arm.r === hi)) { shared = true; break; }
      }
      if (shared) continue;
      const tag = lo._id + ':' + hi._id + ':' + Math.round(sLo.s / OVL_STEP);
      if (made.has(tag)) continue;
      made.add(tag);
      const node = { x: hit.x, z: hit.z, _ovl: true,
        arms: [{ r: lo, i: -1, end: false, s: sLo.s }, { r: hi, i: -1, end: false, s: sHi.s }] };
      (lo._pins ??= []).push({ s: sLo.s, node });
      (hi._pins ??= []).push({ s: sHi.s, node });
    }
  }
}

const J_MAX_TRIM = 0.35;    // never eat more than this fraction of a short road
const CLUSTER_LINK = 32;    // m of shared way that makes two nodes one crossing
const CLUSTER_RANK = 2;     // …if that way is at least a residential street
export function indexJunctions(roads) {
  const it = indexJunctionsSteps(roads);
  let r;
  do r = it.next(); while (!r.done);
  const land = r.value();
  do r = land.next(); while (!r.done);
}
// indexJunctions in steps (round 8, HORIZON: one D11 tile spent up to 250 ms
// here in one frame, almost all of it in linkOverlaps). The steps only touch
// THIS call's ways and nodes; nothing reaches JUNCTIONS or CLUSTERS until
// the function it returns is called, which registers the pads, forms the
// clusters and shapes them in one go (geo.js indexPayloadSteps calls it in
// the step that puts the tile's roads in the index). linkOverlaps used to
// run last; it runs before the clusters now, which therefore leave its
// pins out: they are not junction pins, and the shaping never read them.
function* indexJunctionsSteps(roads) {
  const at = new Map();
  const fresh = [];            // nodes registered by THIS call, shaped at the end
  const cand = [];             // [chunk key, node]: the pads, registered on landing
  let step = 0;
  for (const r of roads) {
    if ((++step & 255) === 0) yield;
    if (!r.d || !r.p || r.p.length < 2) continue;
    for (let i = 0; i < r.p.length; i++) {
      const k = J_KEY(r.p[i][0], r.p[i][1]);
      let e = at.get(k);
      if (!e) at.set(k, e = { x: r.p[i][0], z: r.p[i][1], arms: [] });
      e.arms.push({ r, i, end: i === 0 || i === r.p.length - 1 });
    }
  }
  // ---- where a bridge actually MEETS the road ----
  // A bridge deck has to arrive at the height of the road that continues, and
  // its own tagged endpoint is the wrong place to ask: OSM routinely ends a
  // bridge way out over the water, where the bare-earth model reads the river
  // rather than the bank. Measured on the Labe crossing by Pardubice's Zámek —
  // the deck ramped down to 216.4 m while the road it joins sits at 220.9, a
  // FOUR METRE hole at the abutment. (Before this the deck ran level edge to
  // edge instead, which left it floating clear of the road; both are wrong, and
  // for the same reason — neither asked the approach.)
  //
  // The node knows. Every arm at it is here, so for a bridge END, find a
  // non-bridge road sharing the node and remember a point ten metres along it,
  // away from the water. bridgeDeckHeight samples the terrain there.
  for (const e of at.values()) {
    if ((++step & 255) === 0) yield;
    for (const a of e.arms) {
      if (!a.r.br || !a.end) continue;
      const road = e.arms.find((o) => o.r !== a.r && !o.r.br && o.r.p.length > 1);
      if (!road) continue;
      // Remember WHICH road continues and where along it the node sits. The
      // deck then meets that road's own BUILT height there — the graded profile,
      // embankment included — which is the only height the two can agree on.
      // Reaching for the crest of the bank instead (the previous attempt) put
      // the deck above where the road actually is at the join, and left a gap.
      const q = road.r.p;
      // arclength of the node along that road, so bridgeDeckHeight can ask it
      let at = 0;
      for (let i = 0; i < road.i; i++) at += Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]);
      const link = { road: road.r, at };
      if (a.i === 0) a.r._ap0 = link; else a.r._ap1 = link;
      // every road leaving the deck's end stands on its bank (levelWay)
      for (const o of e.arms) {
        if (o.r.br || o.r === a.r) continue;
        let oa = 0;
        for (let i = 0; i < o.i; i++) oa += Math.hypot(o.r.p[i + 1][0] - o.r.p[i][0], o.r.p[i + 1][1] - o.r.p[i][1]);
        (o.r._abut ??= []).push(oa);
      }
    }
    // A way that ENDS where nothing else arrives is a dead end, and a kerbed
    // street closes its kerb round it (meshes.roadRibbon). Remembered on the
    // way as a plain flag: the pins that could answer this later do not cross
    // to the mesh worker.
    if (e.arms.length === 1 && e.arms[0].end) {
      if (e.arms[0].i === 0) e.arms[0].r._de0 = 1; else e.arms[0].r._de1 = 1;
    }
    // Every arm at a shared node remembers where along itself the node is, so
    // roadProfile can pin its level there. Two arms is already a junction for
    // this purpose — it is where OSM split one street into two ways, and a step
    // in the middle of a street is exactly as wrong as one at a crossroads.
    if (e.arms.length >= 2) {
      for (const a of e.arms) {
        const q = a.r.p;
        let at = 0;
        for (let i = 0; i < a.i; i++) at += Math.hypot(q[i + 1][0] - q[i][0], q[i + 1][1] - q[i][1]);
        a.s = at;                       // junctionY reads every arm at its own node
        (a.r._pins ??= []).push({ s: at, node: e });
      }
    }
    // Three DIRECTIONS meeting is a junction, however OSM cut the ways: a side
    // street joining the middle of a continuous way is two arms and three
    // directions, and it is the commonest junction a town has. It used to get
    // no pad at all (the side road's ribbon simply ran into the centreline of
    // the other), which is exactly where a kerb radius belongs. `_t` marks the
    // nodes this admits, so the clustering below can leave them out: a street
    // with a driveway every fifteen metres must not become one long crossing.
    let deg = 0;
    for (const a of e.arms) deg += a.end ? 1 : 2;
    if (deg < J_MIN_ARMS) continue;
    e._t = e.arms.length < J_MIN_ARMS ? 1 : 0;
    // the pad has to clear the widest road that meets here
    let wMax = 0;
    for (const a of e.arms) wMax = Math.max(wMax, (a.r.w ?? 3) / 2);
    e.pad = wMax + 0.6;
    e.padR = Math.hypot(e.pad, wMax) + 0.1;  // bounding radius of the hull corners
    // A node ON a roundabout ring is not a crossing that needs filling: its
    // pad's convex hull bulged INTO the island as a clean-edged asphalt
    // quad. No pad, and no trims either — the exit ribbon runs right onto
    // the ring and the overlap is the same asphalt.
    e._ring = e.arms.some((a) => a.r.rb);
    if (!e._ring) {
      for (const a of e.arms) {
        if (!a.end) continue;                     // a through-road runs straight on
        const trim = Math.min(e.pad, a.r._len * J_MAX_TRIM);
        if (trim < 0.4) continue;
        if (a.i === 0) a.r._j0 = Math.max(a.r._j0 ?? 0, trim);
        else a.r._j1 = Math.max(a.r._j1 ?? 0, trim);
      }
    }
    // Bucketed by the chunk that holds the CENTRE, so a junction straddling a
    // chunk border is drawn once. A chunk build then costs one map lookup
    // rather than a scan of every junction in the world.
    cand.push(chunkKey(e.x, e.z), e);
  }
  // …and finally the overlaps that never got a node of their own.
  yield* linkOverlaps(roads, at);
  yield;
  return () => landJunctions(roads, cand, fresh);
}

// The landing half of indexJunctions: what other tiles' chunks can see. The
// pads and the clusters are registered in its first step; the outlines are
// shaped in the steps after, each only if no reader has shaped it already
// (junctionHull and clusterHull shape on first use, the same function).
function* landJunctions(roads, cand, fresh) {
  for (let i = 0; i < cand.length; i += 2) {
    const k = cand[i], e = cand[i + 1];
    let list = JUNCTIONS.get(k);
    if (!list) JUNCTIONS.set(k, list = []);
    if (!list.some((o) => o.x === e.x && o.z === e.z)) { list.push(e); fresh.push(e); }
  }

  // ---- CLUSTERS: several nodes, one real crossing ------------------------
  // A dual carriageway crossing a dual carriageway is FOUR nodes a few
  // metres apart, and four separate pads leave slivers of ground, mismatched
  // shades and orphaned paint between them — the "bordel" at náměstí Jana
  // Pernera. Two nodes joined by a SHORT stretch of the same way (the link
  // between carriageways) belong to one crossing; union-find over the pin
  // lists gives the components, and each multi-node component becomes one
  // CLUSTER that meshes draws (and physics stands on) as a single surface.
  const find = (n) => { while (n._cRoot && n._cRoot !== n) n = n._cRoot; return n; };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) rb._cRoot = ra;
    a._cRoot ??= ra; b._cRoot ??= ra;
  };
  for (const r of roads) {
    // a roundabout's ring is a chain of short segments with a node at every
    // exit — exactly the shape the union rule looks for, and clustering it
    // poured one giant pad over the whole circle, island included
    if (r.rb) continue;
    // …and so is a chain of service ways: the aisles of a car park and the
    // loop of a station forecourt are a node every fifteen metres, and they
    // dragged the real crossing beside them into one seventy-metre blob (the
    // "big junction" west of Pardubice station was fourteen nodes, ten of them
    // forecourt). A crossing is made of streets.
    if (roadRank(r) < CLUSTER_RANK) continue;
    if (!r._pins || r._pins.length < 2) continue;
    const ps = r._pins.filter((p) => !p.node._ovl).sort((p1, p2) => p1.s - p2.s);   // (see indexJunctionsSteps)
    if (ps.length < 2) continue;
    for (let i = 0; i < ps.length - 1; i++) {
      if (ps[i + 1].s - ps[i].s < CLUSTER_LINK
        && ps[i].node.pad !== undefined && ps[i + 1].node.pad !== undefined
        && !ps[i].node._t && !ps[i + 1].node._t) {
        union(ps[i].node, ps[i + 1].node);
      }
    }
  }
  const groups = new Map();
  const newClusters = [];
  for (const list2 of JUNCTIONS.values()) {
    for (const e of list2) {
      if (!e._cRoot) continue;
      const root = find(e);
      let g = groups.get(root);
      if (!g) groups.set(root, g = []);
      if (!g.includes(e)) g.push(e);
    }
  }
  for (const members of groups.values()) {
    if (members.length < 2) { for (const m of members) m._cluster = null; continue; }
    let cx = 0, cz = 0;
    for (const m of members) { cx += m.x; cz += m.z; }
    cx /= members.length; cz /= members.length;
    let padR = 0;
    for (const m of members) padR = Math.max(padR, Math.hypot(m.x - cx, m.z - cz) + m.padR);
    const cl = { members, x: cx, z: cz, padR, pad: padR };
    // a later tile can re-form a cluster these nodes already belonged to —
    // retire the old record or the chunk draws the crossing twice
    for (const m of members) {
      const old = m._cluster;
      if (old && old !== cl) {
        const l = CLUSTERS.get(chunkKey(old.x, old.z));
        const i = l ? l.indexOf(old) : -1;
        if (i >= 0) l.splice(i, 1);
      }
      m._cluster = cl;
    }
    const ck = chunkKey(cx, cz);
    let clist = CLUSTERS.get(ck);
    if (!clist) CLUSTERS.set(ck, clist = []);
    clist.push(cl);
    newClusters.push(cl);
  }
  // the union-find marks are scoped to THIS call — a later tile must not see
  // half-built roots on nodes it never touched
  for (const list2 of JUNCTIONS.values()) for (const e of list2) delete e._cRoot;
  // ---- the outlines: kerb radii, mouths, and the kerb's own stretches ------
  // Shaped here rather than on first use, because the outline decides how far
  // each mouth reaches (lg.m), and the ribbons need that before any chunk is
  // built: their kerb stops where the junction's kerb starts.
  yield;
  let step = 0;
  for (const cl of newClusters) { if (cl._ring === undefined) shapeCluster(cl); if ((++step & 31) === 0) yield; }
  for (const e of fresh) {
    if (!e._cluster && !e._ring && e._hullRing === undefined) shapeJunction(e);
    if ((++step & 31) === 0) yield;
  }
}

// ---- roundabouts have a MIDDLE ------------------------------------------------
// OSM draws a roundabout as its ring and nothing else, cut into a way per exit,
// so the game drew a ring of asphalt round whatever ground happened to be there.
// The island is derived here: the ring's ways are gathered by their shared end
// nodes, a circle is fitted to them, and ONE way of the ring (the lowest id, so
// it is the same way on every machine) is told about it. meshes.js draws the
// island with that way's ribbon, which is what makes it appear exactly once.
export function indexRoundabouts(roads) {
  const ring = roads.filter((r) => r.rb && r.d && r.p?.length > 1);
  if (!ring.length) return;
  const root = new Map(), parent = new Map();
  const find = (w) => { while (parent.get(w) !== w) w = parent.get(w); return w; };
  for (const w of ring) parent.set(w, w);
  for (const w of ring) {
    for (const e of [0, w.p.length - 1]) {
      const k = J_KEY(w.p[e][0], w.p[e][1]);
      const o = root.get(k);
      if (o) parent.set(find(w), find(o)); else root.set(k, w);
    }
  }
  const groups = new Map();
  for (const w of ring) {
    const g = find(w);
    let l = groups.get(g);
    if (!l) groups.set(g, l = []);
    l.push(w);
  }
  for (const ws of groups.values()) {
    let sx = 0, sz = 0, sl = 0, hw = 0;
    for (const w of ws) {
      hw = Math.max(hw, (w.w ?? 6) / 2);
      for (let i = 0; i < w.p.length - 1; i++) {
        const L = Math.hypot(w.p[i + 1][0] - w.p[i][0], w.p[i + 1][1] - w.p[i][1]);
        sx += (w.p[i][0] + w.p[i + 1][0]) / 2 * L; sz += (w.p[i][1] + w.p[i + 1][1]) / 2 * L; sl += L;
      }
    }
    if (sl < 12) continue;
    const cx = sx / sl, cz = sz / sl;
    let R = 0, lo = Infinity, hi = 0;
    for (const w of ws) for (const q of w.p) {
      const d = Math.hypot(q[0] - cx, q[1] - cz);
      R += d; if (d < lo) lo = d; if (d > hi) hi = d;
    }
    let n = 0;
    for (const w of ws) n += w.p.length;
    R /= n;
    // a closed, roughly round ring: its length is its circumference, and no
    // vertex strays far off the circle (a "roundabout" tag on a square loop of
    // streets round a park is not an island to pave)
    if (Math.abs(sl - 2 * Math.PI * R) > 0.3 * 2 * Math.PI * R || hi - lo > 0.45 * R || R > 60) continue;
    // (the LONGEST piece, lowest id on a tie: the island is drawn with its
    // owner's levelled ribbon, and a ring is often cut into pieces a few
    // metres long that are too short to be levelled at all. Owned by one of
    // those, the island was never drawn.)
    const lenOf = (w) => w._len ?? polylineLength(w.p);
    const owner = ws.reduce((a, b) => {
      const la = lenOf(a), lb = lenOf(b);
      return la > lb + 1e-6 ? a : lb > la + 1e-6 ? b : ((a._id ?? 0) <= (b._id ?? 0) ? a : b);
    });
    owner._isl = [cx, cz, lo - hw];
  }
}

// ---- junction outlines ------------------------------------------------------
// The direction a way leaves vertex i in, measured a few metres out: a rounded
// bend ends in half-metre pieces whose own bearing is noise.
function legDir(p, i, dir) {
  let k = i;
  while (k + dir >= 0 && k + dir < p.length) {
    k += dir;
    if (Math.hypot(p[k][0] - p[i][0], p[k][1] - p[i][1]) >= 3) break;
  }
  const dx = p[k][0] - p[i][0], dz = p[k][1] - p[i][1], L = Math.hypot(dx, dz) || 1;
  return [dx / L, dz / L];
}

/** One leg per direction a way leaves the node in (a through-way has two). */
function legsOf(node) {
  const legs = [];
  for (const a of node.arms) {
    const p = a.r.p;
    if (!p || p.length < 2 || a.i < 0) continue;
    const len = a.r._len ?? polylineLength(p);
    let s = a.s;
    if (s === undefined) { s = 0; for (let i = 0; i < a.i; i++) s += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]); }
    for (const dir of a.end ? [a.i === 0 ? 1 : -1] : [1, -1]) {
      const [ux, uz] = legDir(p, a.i, dir);
      legs.push({ nx: node.x, nz: node.z, ux, uz, hw: (a.r.w ?? 3) / 2, pad: node.pad,
        avail: dir > 0 ? len - s : s, r: a.r, s, dir, m: node.pad });
    }
  }
  return legs;
}

/** The stretch of each leg's way that lies inside the mouth: no ribbon kerb there. */
function zonesFrom(legs) {
  for (const lg of legs) {
    const z = (lg.r._jz ??= []);
    if (lg.dir > 0) z.push(lg.s, lg.s + lg.m); else z.push(lg.s - lg.m, lg.s);
  }
}

/** The pad's old footprint: two cross-section corners per leg at the pad radius. */
function padCorners(node, pts = []) {
  for (const a of node.arms) {
    const p = a.r.p;
    const i = a.i;
    const k = a.i === 0 ? Math.min(p.length - 1, 1) : Math.max(0, p.length - 2);
    let dx = p[k][0] - p[i][0], dz = p[k][1] - p[i][1];
    if (!a.end) {
      const lo = Math.max(0, i - 1), hi = Math.min(p.length - 1, i + 1);
      dx = p[hi][0] - p[lo][0]; dz = p[hi][1] - p[lo][1];
    }
    const L = Math.hypot(dx, dz) || 1;
    const ux = dx / L, uz = dz / L, hw = (a.r.w ?? 3) / 2;
    for (const side of [-1, 1]) {
      for (const dir of a.end ? [1] : [1, -1]) {
        pts.push([node.x + ux * dir * node.pad - uz * side * hw,
          node.z + uz * dir * node.pad + ux * side * hw]);
      }
    }
  }
  return pts;
}

function ringRadius(ring, x, z) {
  let R = 0;
  for (const q of ring) R = Math.max(R, Math.hypot(q[0] - x, q[1] - z));
  return R + 0.1;
}

function shapeJunction(node) {
  const legs = legsOf(node);
  const out = legs.length >= 2 ? junctionOutline(legs, node.x, node.z) : null;
  node._legs = legs;
  if (out && pointInPolygon(node.x, node.z, out.ring)) {
    node._hullRing = out.ring; node._edge = out.edge;
    node.padR = ringRadius(out.ring, node.x, node.z);
  } else {
    // not a simple polygon (arms folded over each other): the convex hull this
    // always was, with no kerb of its own
    const pts = padCorners(node);
    node._hullRing = pts.length >= 3 ? convexHull(pts) : null;
    node._edge = [];
    for (const lg of legs) lg.m = node.pad;
  }
  zonesFrom(legs);
}

function shapeCluster(cl) {
  const members = new Set(cl.members);
  const legs = [], inner = [];
  for (const m of cl.members) {
    for (const lg of legsOf(m)) {
      // a leg that leads straight to another member is the crossing's own inside
      let link = 0;
      for (const pin of lg.r._pins ?? []) {
        if (pin.node === m || !members.has(pin.node)) continue;
        const d = (pin.s - lg.s) * lg.dir;
        if (d > 0.01 && d <= CLUSTER_LINK + 2 && (!link || d < link)) link = d;
      }
      if (link) { lg.m = link; inner.push(lg); } else legs.push(lg);
    }
  }
  const out = legs.length >= 2 ? junctionOutline(legs, cl.x, cl.z) : null;
  cl._legs = legs;
  if (out && cl.members.every((m) => pointInPolygon(m.x, m.z, out.ring))) {
    cl._ring = out.ring; cl._edge = out.edge;
    cl.padR = cl.pad = ringRadius(out.ring, cl.x, cl.z);
  } else {
    const pts = [];
    for (const m of cl.members) padCorners(m, pts);
    cl._ring = pts.length >= 3 ? convexHull(pts) : null;
    cl._edge = [];
    for (const lg of legs) lg.m = lg.pad;
  }
  zonesFrom(legs);
  zonesFrom(inner);
}

/** Junction clusters, bucketed like the pads. */
export function clustersIn(chunkK) {
  const l = CLUSTERS.get(chunkK) ?? null;
  if (l && _streets) for (const cl of l) if (!cl._kd) { clusterHull(cl); finishJunction(_streets, cl, streetOf); }
  return l;
}

/** The cluster's one footprint: the outline round its outer legs (see streets.js). */
export function clusterHull(cl) {
  if (cl._ring === undefined) shapeCluster(cl);
  return cl._ring;
}

/** The cluster's surface height at (x, z): the deck of the nearest arm of any
 * member — the same pointwise continuation a single pad uses. */
export function clusterDeckY(cl, x, z, terrain) {
  let best = Infinity, y = null;
  for (const m of cl.members) {
    const d2 = (x - m.x) ** 2 + (z - m.z) ** 2;
    if (d2 < best) { best = d2; y = junctionDeckY(m, x, z, terrain); }
  }
  return y ?? terrain.heightAt(x, z);
}

// ---- what a bridge is a bridge OVER -------------------------------------
// A bridge deck used to be levelled to the roads at its two ends and nothing
// else, and on flat ground that puts it exactly where the railway is. The
// screenshot that started this: a road crossing the Pardubice lines with the
// rails running THROUGH the tarmac, because nothing in the data said the two
// were at different heights. OSM does not say it either — it tags the road
// `bridge=yes` and the railway `layer=-1` at best, and neither is a height.
//
// The height comes from what has to fit underneath. So find where a bridge way
// actually crosses a railway or another road WITHOUT sharing a node with it —
// sharing a node is a junction, crossing without one is one passing over the
// other — and demand the standard headroom over it.
//
// The clearances are the Czech ones and they are not decoration: 5.6 m over a
// railway is what the overhead line needs (ČSN 73 6201 asks 5.6 m over an
// electrified track), 4.5 m over a road is the signed minimum.
// A path is not a road: demanding 4.5 m over a footway turned a five-metre
// flight of steps that happens to cross one into a bridge on a 4.5 m bank.
const CLEAR_RAIL = 5.6, CLEAR_ROAD = 4.5, CLEAR_FOOT = 2.6;
const FOOT_TYPES = new Set(['footway', 'cycleway', 'path', 'steps', 'pedestrian', 'track']);
const clearanceOver = (f) => (FOOT_TYPES.has(f.t) ? CLEAR_FOOT : CLEAR_ROAD);

/** Where two segments cross, or null. Endpoints touching does not count. */
function segCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz;
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-9) return null;                  // parallel
  const t = ((cx - ax) * sz - (cz - az) * sx) / den;
  const u = ((cx - ax) * rz - (cz - az) * rx) / den;
  if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
  return [ax + rx * t, az + rz * t];
}

export function indexBridgeCrossings(roads, rails) {
  const it = indexBridgeCrossingsSteps(roads, rails);
  while (!it.next().done);
}
// (in steps for indexPayloadSteps: only this tile's ways are written)
function* indexBridgeCrossingsSteps(roads, rails) {
  const bridges = roads.filter((r) => r.br && r.p?.length > 1);
  if (!bridges.length) return;
  // A bridge shares nodes with the roads it JOINS; those are junctions, not
  // crossings, and a coordinate-keyed set is enough to tell them apart because
  // OSM shares nodes by identity.
  const grid = new Map();                                  // chunk key → segments
  const put = (f, clear) => {
    for (let i = 0; i < f.p.length - 1; i++) {
      const [ax, az] = f.p[i], [bx, bz] = f.p[i + 1];
      const seg = [ax, az, bx, bz, clear];
      // every chunk the segment's bounding box touches, not just the two its
      // ENDS fall in — a 400 m railway registered at its endpoints alone is
      // invisible in the 120 m chunk the bridge actually crosses it in
      for (let cx = Math.floor(Math.min(ax, bx) / CHUNK); cx <= Math.floor(Math.max(ax, bx) / CHUNK); cx++) {
        for (let cz = Math.floor(Math.min(az, bz) / CHUNK); cz <= Math.floor(Math.max(az, bz) / CHUNK); cz++) {
          const k = cx + ',' + cz;
          let list = grid.get(k);
          if (!list) grid.set(k, list = []);
          list.push(seg);
        }
      }
    }
  };
  for (const r of rails ?? []) if (r.p?.length > 1) put(r, CLEAR_RAIL);
  let step = 0;
  for (const r of roads) { if (!r.br && r.p?.length > 1) put(r, clearanceOver(r)); if ((++step & 511) === 0) yield; }
  yield;

  // ---- chained bridges are ONE structure ---------------------------------
  // A viaduct arrives from OSM as a chain of bridge ways sharing endpoints.
  // Each used to level itself alone: its neighbours are bridges too, so the
  // approach search found nothing, fell back to the terrain under the span —
  // street level — and the clearance rule then hoisted the middle into a
  // peak. A row of black tents over the railway is what a viaduct looks like
  // when every segment believes it is its own bridge. Chains are indexed
  // here; bridgeDeckHeight lays ONE grade along the whole structure.
  {
    const byNode = new Map();
    for (const b of bridges) {
      for (const e of [0, b.p.length - 1]) {
        const k = J_KEY(b.p[e][0], b.p[e][1]);
        let list = byNode.get(k);
        if (!list) byNode.set(k, list = []);
        list.push({ b, e });
      }
    }
    const seen = new Set();          // way OBJECTS — chaining must not depend
    for (const b0 of bridges) {      // on _id having been stamped yet
      if (seen.has(b0)) continue;
      // walk the component
      const comp = [];
      const stack = [b0];
      seen.add(b0);
      let branched = false;
      while (stack.length) {
        const w = stack.pop();
        comp.push(w);
        for (const e of [0, w.p.length - 1]) {
          const k = J_KEY(w.p[e][0], w.p[e][1]);
          const arms = byNode.get(k) ?? [];
          if (arms.length > 2) branched = true;
          for (const a of arms) {
            if (!seen.has(a.b)) { seen.add(a.b); stack.push(a.b); }
          }
        }
      }
      if (branched || comp.length < 2) continue;   // lone spans keep their own law
      // order the chain from one terminal, accumulating offsets
      const degree = (w, e) => (byNode.get(J_KEY(w.p[e][0], w.p[e][1])) ?? []).length;
      let head = comp.find((w) => degree(w, 0) === 1 || degree(w, w.p.length - 1) === 1);
      if (!head) continue;                          // a loop — leave it be
      let enterEnd = degree(head, 0) === 1 ? 0 : head.p.length - 1;
      const chain = { total: 0, members: [] };
      const used = new Set();
      while (head && !used.has(head)) {
        used.add(head);
        const L = head._len ?? polylineLength(head.p);
        // reversed = the chain runs against this way's own arclength
        const reversed = enterEnd !== 0;
        head._chain = chain;
        head._chainOff = chain.total;
        head._chainRev = reversed;
        chain.members.push(head);
        chain.total += L;
        const exitEnd = reversed ? 0 : head.p.length - 1;
        const k = J_KEY(head.p[exitEnd][0], head.p[exitEnd][1]);
        const next = (byNode.get(k) ?? []).find((a) => !used.has(a.b));
        if (!next) { chain.tailWay = head; chain.tailEnd = exitEnd; break; }
        head = next.b;
        enterEnd = next.e;
      }
      chain.headWay = chain.members[0];
      chain.headEnd = chain.members[0]._chainRev ? chain.members[0].p.length - 1 : 0;
    }
  }
  yield;
  for (const b of bridges) {
    if ((++step & 15) === 0) yield;
    const nodes = new Set(b.p.map(([x, z]) => J_KEY(x, z)));
    const found = [];
    for (let i = 0; i < b.p.length - 1; i++) {
      const [ax, az] = b.p[i], [bx, bz] = b.p[i + 1];
      for (let cx = Math.floor(Math.min(ax, bx) / CHUNK); cx <= Math.floor(Math.max(ax, bx) / CHUNK); cx++) {
       for (let cz = Math.floor(Math.min(az, bz) / CHUNK); cz <= Math.floor(Math.max(az, bz) / CHUNK); cz++) {
        for (const g of grid.get(cx + ',' + cz) ?? []) {
          // a way that ENDS on this bridge is joining it, not passing under it
          if (nodes.has(J_KEY(g[0], g[1])) || nodes.has(J_KEY(g[2], g[3]))) continue;
          const at = segCross(ax, az, bx, bz, g[0], g[1], g[2], g[3]);
          if (at) found.push({ x: at[0], z: at[1], clear: g[4] });
        }
       }
      }
    }
    if (found.length) b._cross = found;
  }
  // A lone span that crosses something reads its grade the way a viaduct
  // does (cones from its crossings, anchored on its approaches): a chain of
  // one. Its flat deck at the highest headroom was a flyover with no grade
  // on it at all, and the whole climb pushed onto approaches that are often
  // a 40 m way ending at a junction.
  for (const b of bridges) {
    if (b._chain || !b._cross) continue;
    const L = b._len ?? polylineLength(b.p);
    b._chain = { total: L, members: [b], headWay: b, headEnd: 0, tailWay: b, tailEnd: b.p.length - 1 };
    b._chainOff = 0; b._chainRev = false;
  }
}

/**
 * Every headroom a structure owes, as cones along it: `s` the crossing's
 * arclength along the chain (or the lone bridge), `y` the deck height there.
 * One list, read by the deck (bridgeDeckHeight) and by the banks of its
 * approaches (junctionY, levelWay), so the two lay the same curve.
 */
export function crossCones(way, terrain) {
  const ch = way._chain;
  const members = ch ? ch.members : [way];
  const out = [];
  for (const m of members) {
    for (const c of m._cross ?? []) {
      let along = 0, sAt = 0, bestD = Infinity;
      for (let k = 0; k < m.p.length - 1; k++) {
        const [ax, az] = m.p[k], [bx, bz] = m.p[k + 1];
        const dx = bx - ax, dz = bz - az;
        const L2 = dx * dx + dz * dz || 1e-9;
        let t = ((c.x - ax) * dx + (c.z - az) * dz) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d2 = (c.x - ax - dx * t) ** 2 + (c.z - az - dz * t) ** 2;
        const seg = Math.sqrt(L2);
        if (d2 < bestD) { bestD = d2; sAt = along + seg * t; }
        along += seg;
      }
      const mLen = m._len ?? polylineLength(m.p);
      const local = ch ? (m._chainRev ? mLen - sAt : sAt) : sAt;
      out.push({ s: (ch ? m._chainOff : 0) + local, y: terrain.heightAt(c.x, c.z) + c.clear, x: c.x, z: c.z });
    }
  }
  return out;
}
/** Where along its structure (chain or lone span) a bridge member's end `i` lies, and the structure's length. */
function structEnd(way, i) {
  const L = way._len ?? polylineLength(way.p);
  const local = i === 0 ? 0 : L;
  if (!way._chain) return { at: local, total: L };
  return { at: way._chainOff + (way._chainRev ? L - local : local), total: way._chain.total };
}

/**
 * How high this bridge's deck has to be to clear what runs under it — null if
 * it crosses nothing, which is most bridges (a river needs no headroom).
 */
export function bridgeClearance(way, terrain) {
  if (!way?._cross || !terrain) return null;
  let need = null;
  for (const c of way._cross) {
    const y = terrain.heightAt(c.x, c.z) + c.clear;
    if (need === null || y > need) need = y;
  }
  return need;
}

/**
 * The height of a junction's PAD at (x, z): the deck of the nearest arm at its
 * closest point, floored by the local terrain less the cut budget. This is the
 * one definition of the pad surface — the mesh draws it and the physics stands
 * on it, from this same function, because the first time those two disagreed a
 * player sank into a pad up to the neck.
 */
/**
 * The pad's FOOTPRINT: the ordered outline round the arm mouths, with a kerb
 * radius in every corner (streets.js junctionOutline), or the old convex hull
 * of the mouth corners where that outline would not be a simple polygon.
 * Cached on the node; meshes.js draws this ring and city.js stands on it,
 * so the two can never disagree about where the pad ends.
 */
export function junctionHull(node) {
  if (node._hullRing === undefined) shapeJunction(node);
  return node._hullRing;
}

/** Andrew's monotone chain. Small inputs (≤ 16 points), so the sort is free. */
function convexHull(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return null;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (src) => {
    const h = [];
    for (const q of src) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], q) <= 0) h.pop();
      h.push(q);
    }
    h.pop();
    return h;
  };
  const ring = [...half(p), ...half(p.slice().reverse())];
  return ring.length >= 3 ? ring : null;
}

export function junctionDeckY(node, x, z, terrain) {
  if (!terrain) return 0;
  let segs = node._deckSegs;
  if (!segs) {
    segs = node._deckSegs = [];
    for (const a of node.arms) {
      const p = a.r.p;
      if (!p || p.length < 2 || a.s === undefined) continue;
      const len = (k) => Math.hypot(p[k + 1][0] - p[k][0], p[k + 1][1] - p[k][1]);
      const k0 = Math.max(0, a.i - 2), k1 = Math.min(p.length - 2, a.i + 1);
      for (let k = k0; k <= k1; k++) {
        let s0 = a.s;
        if (k >= a.i) { for (let m = a.i; m < k; m++) s0 += len(m); }
        else { for (let m = k; m < a.i; m++) s0 -= len(m); }
        segs.push({ r: a.r, s0, ax: p[k][0], az: p[k][1], bx: p[k + 1][0], bz: p[k + 1][1] });
      }
    }
  }
  let best = Infinity, gy = null, onCrossing = false;
  for (const g of segs) {
    const dx = g.bx - g.ax, dz = g.bz - g.az;
    const L2 = dx * dx + dz * dz || 1e-9;
    let t = ((x - g.ax) * dx + (z - g.az) * dz) / L2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const px = g.ax + dx * t, pz = g.az + dz * t;
    const d2 = (x - px) ** 2 + (z - pz) ** 2;
    if (d2 < best) {
      best = d2;
      const s2 = Math.max(0, g.s0 + Math.hypot(px - g.ax, pz - g.az));
      gy = g.r.br ? bridgeDeckHeight(g.r, s2, terrain) : roadGradeY(g.r, s2, terrain);
      onCrossing = g.r._prof?.crossingStations?.some(s => Math.abs(s - s2) < 3.5);
    }
  }
  // The rail sets the elevation of a crossing panel even when an adjacent
  // surveyed embankment is higher. The visible pad and its wheel surface
  // both call this function, including in a mesh worker.
  if (onCrossing && gy != null) return gy;
  // the terrain guard, sampling a small neighbourhood like the road cut does
  let hi = terrain.heightAt(x, z);
  for (const [ox, oz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const h = terrain.heightAt(x + ox, z + oz);
    if (h > hi) hi = h;
  }
  return Math.max(gy ?? junctionY(node, terrain), hi - GRADE_CUT);
}

/** Junction pads, bucketed by chunk key. meshes.js asks for its own. */
export const JUNCTIONS = new Map();
// Exported because js/chunkspec.js has to hand a chunk's crossing clusters to the
// mesh worker: the worker has no live city object, so everything a build reads
// has to be nameable and copyable. clustersIn() stays the reader for callers
// that are on this side of the boundary.
export const CLUSTERS = new Map();

// A released tile's pads (RELEASE_DATA). indexJunctions only ever sees one
// tile's ways, so a record with a released arm is that tile's own (measured
// on six Pardubice and four Prague tiles: not one record had arms from two
// tiles, and no record was dropped as a duplicate of a neighbour's), and it
// goes whole; a crossing cluster goes with its members. In place: a bucket
// array may be held by a reader for the length of a build.
function* releaseJunctions(ways, keys) {
  const hit = (e) => e.arms.some((a) => ways.has(a.r));
  let n = 0, step = 0;
  for (const k of keys) {
    if ((++step & 1023) === 0) yield;
    const l = JUNCTIONS.get(k);
    if (!l) continue;
    let w = 0;
    for (let i = 0; i < l.length; i++) if (!hit(l[i])) l[w++] = l[i];
    n += l.length - w;
    l.length = w;
    if (!w) JUNCTIONS.delete(k);
  }
  yield;
  for (const [k, l] of CLUSTERS) {
    if ((++step & 1023) === 0) yield;
    let w = 0;
    for (let i = 0; i < l.length; i++) if (!l[i].members.some(hit)) l[w++] = l[i];
    l.length = w;
    if (!w) CLUSTERS.delete(k);
  }
  return n;
}

export function junctionsIn(chunkK) {
  const l = JUNCTIONS.get(chunkK) ?? null;
  // the kerb and the control of each pad, worked out the first time anybody
  // asks for the bucket (see js/streets.js on WHEN)
  if (l && _streets) for (const j of l) if (!j._kd && !j._cluster && !j._ring) { junctionHull(j); finishJunction(_streets, j, streetOf); }
  return l;
}

// ---- streets: the verge of a way, on first use --------------------------------
// The city whose chunk index the street derivations read. Set by loadCity on
// the main thread; a mesh worker never sets it, and reads what travelled.
let _streets = null;
export function setStreetCity(city) { _streets = city; }
/** r._vg, worked out now if this thread can and has not yet. null: no kerb. */
export function streetOf(r) {
  if (r._vg === undefined && _streets) computeVerge(_streets, r);
  if (r._vg && r._vg.lv === undefined && _lvT && _streets) levelVerge(r, _lvT);
  return r._vg ?? null;
}

// ---- a lawn does not reach out to a footway on another level --------------------
// Where a footway is mapped alongside a kerbed street, the street's band is a
// lawn from the kerb out to it (streets.computeVerge), drawn and stood on at
// the street's level. The derivation is plan only: beside a street up on an
// embankment the footway at the foot of the bank is "alongside" too, and the
// lawn became a shelf five metres wide at deck height, three or four metres
// over the path it was reaching for (the flyover approach by Kaufland; the
// kerb pull then dragged the path up onto it, meshes.footPullW). So once the
// street's levelled profile is known, every lawn station is asked how far the
// footway's OWN grade is from the street's there, and where that is more than
// VERGE_LEVEL the street gets what it would have had with no footway mapped:
// the plain paved band. The bank between the two is the terrain's.
//
// Done once per way, in place, behind the same two doors the verge itself is
// worked out behind, so no reader sees the arrays before it; it waits for a
// profile that is final (a guess over a height tile still loading is asked
// again). The worker never does this: the arrays arrive done.
const VERGE_LEVEL = 1.0;        // m between the street's grade and the footway's own
const LAWN_WALKS = new Set(['footway', 'cycleway', 'pedestrian']);   // streets.js WALKS
let _lvT = null;                // the terrain grades are read off: the last one roadProfile was asked with
const _lvC = [];                // the footways near the way in hand: [way, x0, z0, x1, z1] flat
function levelVerge(way, terrain) {
  const vg = way._vg;
  vg.lv = 0;                    // in hand: the profile below comes back in through the door
  const prof = roadProfile(way, terrain);
  if (!prof || !prof.ready) { vg.lv = undefined; return; }
  vg.lv = 1;
  const n = vg.n, T0 = vg.t[0], T1 = vg.t[1];
  let any = false;
  for (let k = 0; k < n && !any; k++) any = T0[k] === 2 || T1[k] === 2;
  if (!any) return;
  // the walked ways that can be the one a lawn of this street reaches (6.5 m
  // past the kerb line of a lay-by, and a metre of slack)
  const p = way.p, hw = (way.w ?? 3) / 2, m = hw + 11;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const q of p) { if (q[0] < a) a = q[0]; if (q[1] < b) b = q[1]; if (q[0] > c) c = q[0]; if (q[1] > d) d = q[1]; }
  a -= m; b -= m; c += m; d += m;
  _lvC.length = 0;
  for (let i = Math.floor(a / CHUNK); i <= Math.floor(c / CHUNK); i++) {
    for (let j = Math.floor(b / CHUNK); j <= Math.floor(d / CHUNK); j++) {
      for (const o of _streets.chunkIndex.get(i + ',' + j)?.roads ?? []) {
        if (o.d || o.br || !LAWN_WALKS.has(o.t) || !o.p || o.p.length < 2 || _lvC.includes(o)) continue;
        let oa = Infinity, ob = Infinity, oc = -Infinity, od = -Infinity;
        for (const q of o.p) { if (q[0] < oa) oa = q[0]; if (q[1] < ob) ob = q[1]; if (q[0] > oc) oc = q[0]; if (q[1] > od) od = q[1]; }
        if (oc < a || oa > c || od < b || ob > d) continue;
        _lvC.push(o, oa, ob, oc, od);
      }
    }
  }
  if (!_lvC.length) return;
  // the footway's own grade at the point a lawn station reaches, or null
  const gradeAt = (x, z) => {
    let best = 1.5, y = null;
    for (let q = 0; q < _lvC.length; q += 5) {
      if (x < _lvC[q + 1] - 1.5 || x > _lvC[q + 3] + 1.5 || z < _lvC[q + 2] - 1.5 || z > _lvC[q + 4] + 1.5) continue;
      const o = _lvC[q], op = o.p;
      let al = 0;
      for (let i = 0; i < op.length - 1; i++) {
        const ax = op[i][0], az = op[i][1], ex = op[i + 1][0] - ax, ez = op[i + 1][1] - az;
        const L2 = ex * ex + ez * ez || 1e-9, L = Math.sqrt(L2);
        let t = ((x - ax) * ex + (z - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dd = Math.hypot(x - ax - ex * t, z - az - ez * t);
        if (dd < best) { const g = roadGradeY(o, al + L * t, terrain); if (g !== null) { best = dd; y = g; } }
        al += L;
      }
    }
    return y;
  };
  // walk the stations as streets.stationsOf lays them: even arclength, and the
  // band's side by the segment's own normal
  const off = [new Uint8Array(n), new Uint8Array(n)];
  let seg = 0, acc = 0, L = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) || 1e-6;
  for (let k = 0; k < n; k++) {
    if (T0[k] !== 2 && T1[k] !== 2) continue;
    const s = k * vg.ds;
    while (s > acc + L + 1e-9 && seg < p.length - 2) {
      acc += L; seg++;
      L = Math.hypot(p[seg + 1][0] - p[seg][0], p[seg + 1][1] - p[seg][1]) || 1e-6;
    }
    const t = Math.max(0, Math.min(1, (s - acc) / L));
    const dx = (p[seg + 1][0] - p[seg][0]) / L, dz = (p[seg + 1][1] - p[seg][1]) / L;
    const x = p[seg][0] + dx * L * t, z = p[seg][1] + dz * L * t;
    const gy = roadGradeY(way, s, terrain);
    if (gy === null) continue;
    for (let side = 0; side < 2; side++) {
      if (vg.t[side][k] !== 2) continue;
      const e = side ? 1 : -1;
      // (the lawn is 0.2 m wider than the footway's centreline is far)
      const out = hw + bayAt(way, s, e) + vg.w[side][k] * 0.1 - 0.2;
      const fy = gradeAt(x + dz * e * out, z - dx * e * out);
      if (fy !== null && Math.abs(gy - fy) > VERGE_LEVEL) off[side][k] = 1;
    }
  }
  const plain = Math.round(WALK_W * 10);
  for (let side = 0; side < 2; side++) {
    const O = off[side], T = vg.t[side], W = vg.w[side];
    // one station of a different mind between two that agree is noise
    for (let k = 1; k < n - 1; k++) if (O[k - 1] === O[k + 1] && T[k] === 2 && T[k - 1] === 2 && T[k + 1] === 2) O[k] = O[k - 1];
    for (let k = 0; k < n; k++) if (O[k]) { T[k] = 1; W[k] = plain; }
  }
}

export function polylineLength(p) {
  let L = 0;
  for (let i = 0; i < p.length - 1; i++) L += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  return L;
}

// iterate chunk keys in a square radius around a world position
export function forEachChunkInRadius(x, z, r, fn) {
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) fn((cx + dx) + ',' + (cz + dz), cx + dx, cz + dz);
}

/**
 * The nearest named shop/eatery/office within `maxD` metres, or null — the
 * venues indexPayload bucketized, i.e. the trade that did NOT get folded into a
 * building of its own. This is how a unit inside a gallery or the third of four
 * shops along a block says its real OSM name instead of nothing.
 *
 * Reads the 3×3 cells around the point rather than a flat list: at 120 m chunks
 * that is every venue within reach and a couple of dozen distance tests, which
 * is what makes it safe to call from the HUD every frame.
 */
export function venueAt(city, x, z, maxD = 8) {
  let best = null, bestD = maxD * maxD;
  forEachChunkInRadius(x, z, 1, (key) => {
    const cell = city?.chunkIndex?.get(key);
    if (!cell?.venues) return;
    for (const v of cell.venues) {
      const p = v.p?.[0];
      if (!p) continue;
      const d = (p[0] - x) ** 2 + (p[1] - z) ** 2;
      if (d < bestD) { bestD = d; best = v; }
    }
  });
  return best;
}

// feature bbox → every chunk cell it touches. `touched` (optional Set)
// collects the keys of cells that gained features — tile streaming hands it
// to CityWorld so already-built chunk meshes can be invalidated PRECISELY
// (long rivers/roads overhang their tile by kilometers; guessing bounds from
// the tile rectangle would miss those cells).
// The cells one feature occupies. Split out of bucketize because eviction has
// to find exactly the same set again to unpick a feature from the index, and
// two copies of this loop would be two chances to disagree.
function forEachCellOf(f, fn) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  const ring = f.o ?? f.p ?? (typeof f[0] === 'number' ? [f] : f);
  for (const [x, z] of ring) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++)
    for (let cz = Math.floor(minZ / CHUNK); cz <= Math.floor(maxZ / CHUNK); cz++)
      fn(cx + ',' + cz);
  return ring;
}

// ---- what an index cell weighs ----------------------------------------------
// Counted after a teleport tour of six places (13 Nov 2026, twenty tiles seen):
// 625 791 cells, 562 MB of a 1 000 MB heap, more than every road, polygon and
// building of those tiles together. Two things made it so. A cell was born
// with fourteen arrays of its own and most cells use one or two of them, so
// the lists nothing was ever put in are now ONE shared, frozen array (a stray
// push into it throws, which is the point: every list is still only ever
// filled here). And see bucketizeLine below for the other.
const NONE = Object.freeze([]);
const newCell = () => ({ buildings: NONE, roads: NONE, rails: NONE, water: NONE, green: NONE,
  paved: NONE, trees: NONE, signs: NONE, crossings: NONE, power: NONE, furniture: NONE,
  calming: NONE, barriers: NONE, venues: NONE });
const CELL_KINDS = Object.keys(newCell());
function cellPut(index, key, kind, f, touched) {
  let cell = index.get(key);
  if (!cell) index.set(key, cell = newCell());
  const list = cell[kind];
  if (list === NONE) cell[kind] = [f]; else list.push(f);
  touched?.add(key);
}

function bucketize(index, list, kind, touched) {
  for (const f of list) {
    const ring = forEachCellOf(f, (key) => cellPut(index, key, kind, f, touched));
    f._home = chunkKey(ring[0][0], ring[0][1]); // rendered once, here
  }
}

// A TRANSMISSION LINE IS NOT ITS BOUNDING BOX. bucketize() above files a
// feature under every cell of its bbox, which is right for a pond and
// harmless for a street, and for a 400 kV line running fifty kilometres on a
// diagonal it is every cell of a fifty-kilometre square: ONE line of 484
// vertices sat in 329 074 cells of that tour, most of them outside any tile
// that was loaded and 460 000 outside the world altogether, and 352 683 cells
// existed for no other reason. The only reader of `cell.power` is the mesher
// (meshes.js: a tower in the cell its vertex stands in, a span in the cell of
// its midpoint), so those are exactly the cells a line is filed under.
function bucketizeLine(index, list, kind, touched) {
  for (const f of list) {
    const p = f.p;
    let last = '';
    const put = (x, z) => {
      const key = chunkKey(x, z);
      if (key === last) return;
      last = key;
      if (index.get(key)?.[kind].includes(f)) return;
      cellPut(index, key, kind, f, touched);
    };
    for (let i = 0; i < p.length; i++) {
      if (i) put((p[i - 1][0] + p[i][0]) / 2, (p[i - 1][1] + p[i][1]) / 2);
      put(p[i][0], p[i][1]);
    }
    f._home = chunkKey(p[0][0], p[0][1]);
  }
}

// push(...src) blows the argument stack on region-sized arrays — loop instead
function appendAll(dst, src) { for (const f of src) dst.push(f); }

// Index ONE data payload into the city — the legacy whole-city JSON and a
// region tile share the exact same compact format, so this is the single
// place that stamps _id (continuing counter — dedupe at mesh time keys on
// it), wraps bare tree points, precomputes road _len (bridges + traffic both
// need it), buckets everything into the chunk index and GROWS the flat city
// arrays (traffic builds its first graph from city.roads; minimap redraws
// from all of them). Returns the slices tile listeners care about.
// `slot` is the tile's index in the manifest — it makes _id deterministic, so
// a building that is evicted and re-fetched keeps the identity everything
// downstream hashes from. `heavyOnly` is the re-fetch of a SLIM tile: its
// ---- the road you see from the air is wider than its carriageway ----------
// The widths in the tiles are the CARRIAGEWAY — the running lanes and nothing
// else. What the ČÚZK orthophoto shows, and therefore what the player compares
// us against, is the whole sealed surface: the lanes plus the hard shoulder,
// the gutter, and on a town street the parking lane that is almost always
// there. Measured against the photo the ribbons read visibly too narrow, and
// the error is not a constant fraction — a motorway is a metre out, a
// residential street nearly doubles. So this is an ADDITION per class, not a
// percentage: residential 5.5 -> 8.0, tertiary 7 -> 8.5, secondary 8 -> 9.5,
// primary 9 -> 10.5, motorway 11 -> 12.5, all of which land inside what ČSN
// 73 6110 / 73 6101 actually build.
//
// Footways, cycleways and paths get NOTHING. They are not carriageways and
// they have no shoulder; widening a pavement would only make it wrong.
//
// Applied HERE, once per feature at index time, because r.w is read by a
// dozen consumers — the ribbon, the junction pads, the kerb, the corridors
// the ground is clamped under, the lamp spacing. Widening only the ribbon
// would leave the terrain clamped to the old width and put grass back on the
// asphalt, which is a bug class this project has already paid for once.
// (This is the interim runtime form; the widths belong in build-region.mjs
// and should move there at the next data rebuild.)
const PAVED_EXTRA = {
  motorway: 1.5, trunk: 1.5, primary: 1.5, secondary: 1.5, tertiary: 1.5,
  motorway_link: 1.0, trunk_link: 1.0, primary_link: 1.0,
  secondary_link: 1.0, tertiary_link: 1.0,
  unclassified: 2.5, residential: 2.5,   // the parking lane is the difference
  living_street: 1.5, service: 1.2, track: 0.5,
};
function pave(r) {
  if (r._paved || !(r.w > 0)) return;   // idempotent: a tile may be re-indexed
  r._paved = true;
  const extra = PAVED_EXTRA[r.t];
  if (extra) r.w = +(r.w + extra).toFixed(2);
}

// roads and polygons never left, so re-indexing them would double them.
//
// A GENERATOR since round 8 (HORIZON): one rural D11 tile used to cost 40 to
// 400 ms of main thread here in ONE frame, a Prague tile two seconds, so in
// play (city.indexSliceMs, set by main.js) loadTile drains it a few
// milliseconds a frame; at boot and in tests indexPayload below drains it at
// once. Everything up to the landing only works on this tile's own objects
// and files them in a private STAGE index: nothing the game reads (the chunk
// index, the flat arrays, JUNCTIONS) sees the tile until the stage is merged
// in, and what needs the merged index (the junction pads and their shapes,
// the bridge stitching, the bays) runs in the steps after it. So the result
// is the same, list for list and in the same order, as the old single pass
// (tests/tile-slices.test.mjs compares the two).
function indexPayload(city, data, touched, slot = 0, heavyOnly = false, kept = null, poisIn = false) {
  const it = indexPayloadSteps(city, data, touched, slot, heavyOnly, kept, poisIn);
  for (;;) { const r = it.next(); if (r.done) return r.value; }
}
const IDX_STEP = 256;          // features between two yields of a loop below
function* stepEach(list, fn) {
  for (let i = 0; i < list.length; i++) { fn(list[i]); if ((i % IDX_STEP) === IDX_STEP - 1) yield; }
}
// (bucketize and bucketizeLine one slice at a time, into the stage)
function* bucketizeSteps(index, list, kind, touched, line = false) {
  for (let i = 0; i < list.length; i += IDX_STEP) {
    (line ? bucketizeLine : bucketize)(index, list.slice(i, i + IDX_STEP), kind, touched);
    yield;
  }
}
// The stage into the city's index: a cell nobody had yet is taken whole, a
// shared one gets this tile's features after the ones already filed there,
// exactly where the old in-place bucketize put them.
function mergeStage(index, stage) {
  for (const [key, s] of stage) {
    const cell = index.get(key);
    if (!cell) { index.set(key, s); continue; }
    for (const kind of CELL_KINDS) {
      const add = s[kind];
      if (add === NONE) continue;
      if (cell[kind] === NONE) cell[kind] = add; else appendAll(cell[kind], add);
    }
  }
}
function* indexPayloadSteps(city, data, touched, slot = 0, heavyOnly = false, kept = null, poisIn = false) {
  servicesInto(data);   // fuel the tiles lack, forecourt canopies lifted (js/d11services.js)
  let next = slot * IDS_PER_TILE;
  const stamp = (list) => { for (const f of list ?? []) f._id = ++next; return list ?? []; };
  const stage = new Map();
  let landJ = null;            // indexJunctions' landing half, run when the roads land
  const buildings = stamp(data.buildings);
  // Open canopies at the two station entrances are mapped as roof outlines
  // without min_height. Keep their cover overhead and the doors beneath clear.
  for (const b of buildings) {
    if (b.t !== 'roof' || b.y || !b.o?.length) continue;
    const [x,z] = b.o[0];
    if (Math.hypot(x+38850,z-739)<125 || Math.hypot(x-16,z+70)<130) b.y = Math.max(2.8,b.h-0.4);
  }
  yield;
  // f._pw: shared walls, this tile only, a few thousand edges a step (partywalls.js)
  yield* stampPartyWallsSteps(buildings);
  yield;
  // trees are bare [x,z] pairs — wrap so they can carry _home/_id like the rest
  const trees = (data.trees ?? []).map(t => ({ p: [t], _id: ++next }));
  yield* bucketizeSteps(stage, buildings, 'buildings', touched);
  yield* bucketizeSteps(stage, trees, 'trees', touched);
  const heavy = { buildings, trees };
  if (heavyOnly) {
    mergeStage(city.chunkIndex, stage);
    appendAll(city.buildings, buildings);
    appendAll(city.trees, trees);
    return { roads: [], signals: [], heavy };
  }

  // ids for the resident layers continue past the heavy ones in the same slot
  let roads = stamp(data.roads), rails = stamp(data.rails), paved = stamp(data.paved);
  const water = stamp(data.water), green = stamp(data.green);
  roads = withRoadPatches(roads, data.tx, data.tz, (slot + 1) * IDS_PER_TILE);   // ways the build dropped (js/roadpatches.js)
  if (kept) {
    // A tile coming back from DEEP eviction (evictDeep below): its ways never
    // left, because the traffic, route and walker graphs hold them, so the
    // ones just parsed only advanced the id counter and are dropped again. The
    // kept objects carry their smoothing, widths, junctions and bays already.
    roads = kept.roads; rails = kept.rails;
    paved = paved.map((f) => kept.lots.get(f._id) ?? f);
  } else {
    yield* stepEach(roads, (r) => { r.p = smoothBends(r.p, r.br); r._len = polylineLength(r.p); pave(r); });
    yield* stepEach(rails, (r) => { r.p = smoothBends(r.p, r.br); });
    landJ = yield* indexJunctionsSteps(roads);
    yield* indexBridgeCrossingsSteps(roads, rails);
    yield;
    indexRoundabouts(roads);
    yield;
  }
  yield* bucketizeSteps(stage, roads, 'roads', touched);
  yield* bucketizeSteps(stage, rails, 'rails', touched);
  yield* bucketizeSteps(stage, water, 'water', touched);
  yield* bucketizeSteps(stage, green, 'green', touched);
  yield* bucketizeSteps(stage, paved, 'paved', touched);
  const signals = kept ? [] : data.signals ?? [];  // [[x,z],...]: traffic lights v3
  // road signs — typed {p:[x,z], k:'give_way'|'stop'|'priority'}; wrapped like
  // trees so bucketize can hand each chunk its own posts
  const signs = (data.signs ?? []).map((g) => ({ p: [g.p], k: g.k, _id: ++next }));
  yield* bucketizeSteps(stage, signs, 'signs', touched);
  // pedestrian crossings — bare [x,z] zebra points on the way
  const crossings = (data.crossings ?? []).map((c) => ({ p: [c], _id: ++next }));
  yield* bucketizeSteps(stage, crossings, 'crossings', touched);
  // transmission lines — every vertex is a pylon, wires hang between them.
  // Bucketized like any polyline so each chunk raises its own towers.
  const power = stamp(data.power);
  // (a tile's line by the cells it stands in; the one-file city, which is as
  // big as it will ever get, keeps the box it always had)
  yield* bucketizeSteps(stage, power, 'power', touched, !!slot);
  // street furniture — every prop is a point, wrapped like trees so bucketize
  // can hand each chunk its own benches, bins, lamps and crosses
  const furniture = (data.furniture ?? []).map((f) => ({ p: [f.p], k: f.k, a: f.a, _id: ++next }));
  yield* bucketizeSteps(stage, furniture, 'furniture', touched);
  // retardéry ride the road they sit on, so they are points too
  const calming = (data.calming ?? []).map((c) => ({ p: [c.p], k: c.k, _id: ++next }));
  yield* bucketizeSteps(stage, calming, 'calming', touched);
  // THE NAMED TRADE OSM SURVEYED — {p:[[x,z]], t:'supermarket'|'cafe'|…, n:name}.
  // A venue standing in a footprint of its own was folded INTO that building at
  // build time, so its name is already on `f.n` and its trade on `f.u`
  // (scripts/lib/venues.mjs); what arrives here is everything no footprint
  // absorbed — the other four tenants of a block, the units inside a gallery,
  // a stall on a market square. Bucketized like the signs rather than kept in a
  // flat list: the only question anyone asks of it is "what stands HERE", and
  // the flat list holds every tile not yet deep-evicted (evictDeep), so a
  // linear scan would be the size of everywhere the session has been lately.
  const venues = (data.venues ?? []).map((v) => ({ p: [v.p], t: v.t, n: v.n, b: v.b, _id: ++next }));
  yield* bucketizeSteps(stage, venues, 'venues', touched);
  // fences and walls are POLYLINES: one owner chunk per line, like a road
  const barriers = stamp(data.barriers);
  yield* bucketizeSteps(stage, barriers, 'barriers', touched);
  yield;

  // ---- the tile lands: the index first, then what reads it -----------------
  // (in a few steps: the tile is 2.6 km ahead of the player when it lands, so
  // nothing in view is built between them, and every cell they touch is
  // re-queued once the tile is through, CityWorld's listener)
  mergeStage(city.chunkIndex, stage);
  yield;
  if (landJ) yield* landJ();
  // Neighbours may have arrived while a retained tile was absent from the
  // spatial index. Reconcile both arrival orders; existing pairs are deduplicated.
  yield* indexTileCrossings(city, roads, rails, stage.keys());
  appendAll(city.buildings, buildings);
  appendAll(city.trees, trees);
  yield;
  // bridge ends that meet a way of another tile, rail decks, underpasses
  yield* stitchStructuresSteps(city, roads, rails);
  yield;
  // lay-bys: the kerb steps out around them (js/streets.js)
  if (!kept) indexBays(city, data.pois);
  // (what deep eviction keeps never left the flat arrays: roads, rails, the
  // car parks, the pois and the signals; see evictDeep)
  if (!kept) appendAll(city.roads, roads);
  if (!kept) appendAll(city.rails, rails);
  appendAll(city.water, water);
  appendAll(city.green, green);
  appendAll(city.paved, kept ? paved.filter((f) => !kept.lots.has(f._id)) : paved);
  appendAll(city.waterways, data.waterways ?? []); // not bucketized: minimap-only
  if (!kept && !poisIn) appendAll(city.pois, data.pois ?? []); // (not bucketized: HUD, labels; listed once, RELEASE_DATA)
  appendAll(city.signals, signals);
  appendAll(city.power, power);
  appendAll(city.venues, venues);
  appendAll(city.barriers, barriers);
  // everything this tile filed outside its heavy half, for evictDeep
  const res = { roads, rails, water, green, paved, signs, crossings, power, furniture,
    calming, venues, barriers, waterways: data.waterways ?? [] };
  // (not filed in the index, so not a kind evictDeep visits: what the graphs
  // built from this tile's lights is released with them, see RELEASE_GRAPHS)
  Object.defineProperty(res, 'signals', { value: kept ? (kept.signals ?? []) : signals, enumerable: false });
  return { roads: kept ? [] : roads, signals, heavy, res };
}

const _resolved = Promise.resolve(); // ensureTiles' no-work answer, allocated once

// ---- a tile's indexing, a few milliseconds a frame (round 8, HORIZON) -----
// What one tile arrival costs the main thread, slice by slice: slices run,
// the longest one (ms, indexing and listeners apart), and the tile count.
// tests/tile-slices.test.mjs and the dev probe read it (city.indexStats).
export const INDEX_STATS = { tiles: 0, slices: 0, maxMs: 0, lastMs: 0, listenerMaxMs: 0, over8: 0 };
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
function noteSlice(ms, listener) {
  INDEX_STATS.slices++; INDEX_STATS.lastMs = ms;
  if (ms > 8) INDEX_STATS.over8++;
  if (listener) { if (ms > INDEX_STATS.listenerMaxMs) INDEX_STATS.listenerMaxMs = ms; }
  else if (ms > INDEX_STATS.maxMs) INDEX_STATS.maxMs = ms;
}
// Run `it` to its end: at once when city.indexSliceMs is unset (boot, tests),
// else that many milliseconds a frame on the index gate. Resolves to its value.
async function drainSliced(city, it) {
  const budget = city.indexSliceMs;
  if (!(budget < Infinity)) { for (;;) { const r = it.next(); if (r.done) return r.value; } }
  for (;;) {
    const t0 = nowMs();
    let r;
    do r = it.next(); while (!r.done && nowMs() - t0 < budget);
    noteSlice(nowMs() - t0, false);
    if (r.done) return r.value;
    await indexGate();
  }
}

// One tile is indexed per frame, at most, and never in the same task as the
// one before it. Everything queued here is main-thread work measured in tens of
// milliseconds, so the ONLY thing that keeps it from being felt is spreading it
// out. Chained promises give the serialisation; the rAF gives the frame break.
let _indexChain = _resolved;
function indexGate() {
  _indexChain = _indexChain.then(() => new Promise((done) => {
    // rAF alone would DEADLOCK the world: a tab that is not the foreground tab
    // never paints, so the frame callback never comes, so no tile ever indexes
    // — and boot, which awaits the spawn tiles, hangs on the loading spinner
    // forever. The timer is the floor that keeps streaming alive off-screen;
    // whichever fires first wins.
    let fired = false;
    const go = () => { if (!fired) { fired = true; done(); } };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go);
    setTimeout(go, 50);
  }));
  return _indexChain;
}

// ---- a tile's release, a few milliseconds per frame (js/tilework.js) -------
// Slim and deep eviction and every graph's release are jobs of small steps
// that run up to a few milliseconds a frame on this same gate, and tile
// indexing takes its turn in the same queue (workTurn).
const workTurn = () => workTurnOn(indexGate);
const queueJob = (steps, onEnd) => queueJobOn(indexGate, steps, onEnd);

export async function loadCity(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`city data: HTTP ${res.status}`);
  const data = await res.json();
  // One city shape for BOTH dialects. The arrays only ever GROW — consumers
  // (traffic's graph, minimap's redraw) may hold the references forever.
  const city = {
    name: data.name ?? 'Region',
    origin: data.origin, mPerLat: data.mPerLat, mPerLon: data.mPerLon,
    tile: data.tile, // manifest tile size in meters (undefined in legacy mode)
    buildings: [], roads: [], rails: [], water: [], waterways: [], power: [],
    green: [], paved: [], trees: [], pois: [], venues: [], signals: [], barriers: [],
    chunkIndex: new Map(), _nextId: 1,
  };
  setStreetCity(city);
  // tile-arrival listeners: cb({roads, signals, tx, tz, cells}) fires AFTER a
  // tile is indexed — roads/signals are that tile's slices (with _id/_len),
  // cells the chunk keys that gained features. Legacy mode registers fine and
  // simply never fires (everything is already there).
  const listeners = [], unloadListeners = [];
  city.onTileLoaded = (cb) => { listeners.push(cb); };
  // …and the other direction: cb({cells}) after a tile went slim, so built
  // chunk groups holding its buildings can be dropped.
  city.onTileUnloaded = (cb) => { unloadListeners.push(cb); };
  // …and the graphs' side of a deep eviction: cb({ tx, tz, rect, roads, rails,
  // signals, venues, cells, ids: [lo, hi] }), one listener per frame AFTER
  // evictDeep has emptied the tile's cells (so a listener works from the
  // lists in the event, never from city.chunkIndex), so every graph built
  // from those ways (traffic, navigation, cyclists, walkers) can drop what it
  // derived from them. See RELEASE_GRAPHS.
  const releaseListeners = [];
  city.onTileReleased = (cb) => { releaseListeners.push(cb); };
  city.releaseGraphs = RELEASE_GRAPHS;
  city.releaseData = RELEASE_GRAPHS && RELEASE_DATA;
  city.releasing = 0;              // release jobs still queued (tests wait on it)
  city.releaseStats = RELEASE_STATS;
  city.indexStats = INDEX_STATS;
  // Milliseconds a frame a tile's indexing may take (drainSliced); main.js
  // sets it in play. Unset, a tile is indexed in one go as before.
  city.indexSliceMs = Infinity;
  // A building the player has wrecked must not be evicted out from under the
  // wreck; interiors installs this guard.
  city.keepAlive = null;
  // Where else this client is looking from, beside the point ensureTiles is
  // called with: each fn(out) pushes x, z pairs (the player, co-op peers). No
  // tile within EVICT_REACH of any of them is evicted.
  city.evictHolds = [];

  if (!data.tiles) { // legacy single-city file — index it all right now
    indexPayload(city, data);
    city.ensureTiles = () => _resolved; // uniform API: city.js calls this blindly
    city.routeFilesNear = () => [];     // one city file carries no transit routes
    return city;
  }

  // ---- manifest mode: the world starts empty and streams in ----
  const T = data.tile;
  // state: 0 idle / 1 loading / 2 indexed / 3 slim (buildings + trees evicted,
  // everything else still resident). A failed fetch rolls back to its previous
  // state so the next ensureTiles pass retries — the network hiccuped, or the
  // region download may still be filling the server; either way we self-heal.
  const tiles = data.tiles.map((t, i) => ({
    tx: t.tx, tz: t.tz, f: t.f, wb: t.wb, rt: t.rt,
    state: 0, slot: i + 1, heavy: null,
    res: null, cells: null, ext: null, kept: null,   // see evictDeep
  }));
  const tileBy = new Map();
  for (const t of tiles) tileBy.set(t.tx + ',' + t.tz, t);
  // The world map needs the region's EXTENT before any of it has streamed —
  // fitting to the loaded arrays alone showed Pardubice and hid 400 villages.
  city.manifestTiles = tiles;
  // distance² from a point to a tile's rectangle (clamp-to-rect, then measure)
  const distSqTo = (t, x, z) => {
    const dx = Math.max(t.tx * T - x, 0, x - (t.tx + 1) * T);
    const dz = Math.max(t.tz * T - z, 0, z - (t.tz + 1) * T);
    return dx * dx + dz * dz;
  };
  // PUBLIC TRANSPORT ROUTES are not a tile layer: a line is ten kilometres
  // long and has ONE owner file (docs/TILE-FORMAT.md, js/tiledata.js). What a
  // manifest tile carries is `rt`, the keys of every route file with a line
  // passing through that tile, so the lines near a point are known from the
  // manifest alone, before a single tile has streamed. Returns the URLs to
  // fetch (app-root-relative, like a tile's `f`), each once, in a stable
  // order. Allocates: ask about once a second, not per frame.
  city.routeFilesNear = (x, z, reach = T) => {
    const keys = new Set();
    for (const t of tiles)
      if (t.rt && distSqTo(t, x, z) <= reach * reach) for (const k of t.rt) keys.add(k);
    const dir = data.routes ?? 'data/routes/';
    return [...keys].sort().map((k) => `${dir}${k}.json`);
  };
  const distSqToBounds = (b, x, z) => {
    if (!b || b.length !== 4) return Infinity;
    const dx = Math.max(b[0] - x, 0, x - b[2]);
    const dz = Math.max(b[1] - z, 0, z - b[3]);
    return dx * dx + dz * dz;
  };
  const loadTile = async (t, back) => {
    try {
      const res = await fetch(t.f); // f is app-root-relative, like CITY_DATA_URL
      if (!res.ok) throw new Error(`tile ${t.tx},${t.tz}: HTTP ${res.status}`);
      const payload = await res.json();
      // Measured on a Prague tile: 6.5 MB, 55 ms to parse and 47 ms to index —
      // 100 ms of BLOCKED main thread. Fetches finish whenever the network says
      // so, so three tiles landing together used to freeze a third of a second
      // in one frame, which is exactly the hitch you feel crossing a city at
      // 700 m/s. The gate serialises the indexing and puts each tile on its own
      // frame: the same total work, but never two hitches back to back, and
      // never one while the renderer is trying to present.
      // (and after any release queued before it: see workTurn)
      const finish = await workTurn();
      try {
      const touched = new Set();
      const kept = back === 0 ? t.kept : null;
      const poisIn = back === 0 && !!t.poisIn;     // a released tile's pois never left (RELEASE_DATA)
      const { roads, signals, heavy, res: filed } = await drainSliced(city,
        indexPayloadSteps(city, payload, touched, t.slot, back === 3, kept, poisIn));
      // A LOADED TILE OWNS ITS CELLS. A chunk with no cell is "outside the
      // mapped city" and is not meshed at all (meshes.buildChunkMeshesGen), so
      // whether open country had ground used to hang on some feature's
      // bounding box happening to cover it: 31 885 of the 32 000 cells of
      // twenty tiles did exist, 23 of them only under a power line's box and
      // 115 not at all. Now that a line is filed by where it stands, the tile
      // says so itself: every cell of its rectangle exists once it is indexed.
      if (back !== 3) {
        const c0 = Math.floor((t.tx * T) / CHUNK), c1 = Math.floor(((t.tx + 1) * T - 1e-6) / CHUNK);
        const d0 = Math.floor((t.tz * T) / CHUNK), d1 = Math.floor(((t.tz + 1) * T - 1e-6) / CHUNK);
        for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
          const key = cx + ',' + cz;
          if (!city.chunkIndex.has(key)) { city.chunkIndex.set(key, newCell()); touched.add(key); }
        }
      }
      t.heavy = heavy;
      t.state = 2;
      INDEX_STATS.tiles++;
      // what deep eviction has to find again: every cell this tile filed
      // anything in, and the box they span
      if (back !== 3) { t.res = filed; t.cells = touched; t.ext = cellsBox(touched); t.kept = null; }
      else if (t.cells) for (const k of touched) t.cells.add(k);
      // `pois` rides along too: the pump and police-station indexes (main.js)
      // and the map's fuel marks (career.js) all read t.pois, and without it
      // they only ever knew the tiles that were loaded at boot. A tile coming
      // back from slim re-indexes its heavy half only, so it brings none, and
      // nor does one coming back from deep eviction (its pois never left).
      // A tile whose graphs were RELEASED (evictDeep) hands its kept ways and
      // lights over again, exactly as on a first visit: every graph that holds
      // ways let go of this tile's, and builds them again from these.
      const again = kept && t.released;
      t.released = false;
      const ev = { roads: again ? kept.roads : roads, signals: again ? kept.signals ?? [] : signals,
        pois: back === 3 || kept || poisIn ? [] : payload.pois ?? [], tx: t.tx, tz: t.tz, cells: touched, again,
        ids: [t.slot * IDS_PER_TILE, (t.slot + 1) * IDS_PER_TILE] };
      // In play every listener gets a frame of its own (the traffic graph,
      // the route planner, the walkers and the cycle net each cost tens of
      // milliseconds on a rural tile), in the order they registered, so
      // CityWorld's re-queue still comes first; at boot and in tests they run
      // together as they always did. One that returns a generator is drained
      // in slices like the indexing.
      const sliced = city.indexSliceMs < Infinity;
      for (const cb of listeners) {
        if (sliced) await indexGate();
        const t0 = sliced ? nowMs() : 0;
        const it = cb(ev);
        if (sliced) noteSlice(nowMs() - t0, true);
        if (it && typeof it.next === 'function') await drainSliced(city, it);
      }
      } finally { finish(); }
    } catch (err) {
      t.state = back;
      throw err;
    }
  };
  // Kick off every idle tile whose BOUNDS come within TILE_REACH of (x,z).
  // Resolves when the tiles this call started are all indexed; already-inflight
  // tiles are someone else's promise. Called ~1×/s from CityWorld.update —
  // the linear scan over the manifest (≤ ~200 entries) is nothing at that rate.
  city.ensureTiles = (x, z) => {
    let batch = null;
    for (const t of tiles) {
      if (t.state === 1 || t.state === 2) continue;   // in flight, or already full
      const ownerNear = distSqTo(t, x, z) <= TILE_REACH * TILE_REACH;
      // State 0 has no resident layers yet, so a long river reaching this
      // location may pull in its distant owner tile. State 3 already retained
      // water/roads/rails; only proximity to the owner should re-fetch its
      // evicted buildings and trees, otherwise a long river would cause an
      // endless load → slim → load loop.
      const waterNear = t.state === 0
        && distSqToBounds(t.wb, x, z) <= TILE_REACH * TILE_REACH;
      if (!ownerNear && !waterNear) continue;
      const back = t.state;                            // 0 = never seen, 3 = slim
      t.state = 1;
      (batch ??= []).push(loadTile(t, back));
    }
    evictFar(x, z);
    return batch ? Promise.all(batch) : _resolved;
  };

  // Unpick one tile's buildings and trees from the index and from the flat
  // arrays. Everything is done by identity against a Set of the tile's own
  // features, so a cell shared with a neighbouring tile keeps that neighbour's
  // features untouched.
  function evictFar(x, z) {
    for (const t of tiles) {
      if (t.state !== 2 || !t.heavy) continue;
      if (distSqTo(t, x, z) <= EVICT_REACH * EVICT_REACH) continue;
      const { buildings, trees } = t.heavy;
      if (city.keepAlive && buildings.some(city.keepAlive)) continue;
      // slim at once for ensureTiles; the work itself is a job (queueJob),
      // and a heavy half coming back waits for it to finish
      t.heavy = null;
      t.state = 3;
      city.releasing++;
      queueJob(slimSteps(t, buildings, trees), () => { city.releasing--; });
      // ONE per call. Each eviction walks every cell the tile touched and then
      // compacts the whole (six-figure) building array, and a jet leaves half a
      // dozen tiles behind at once — doing them all in one tick is a freeze in
      // its own right. ensureTiles runs every second, so the backlog drains in
      // seconds and nothing is ever more than a tile or two over budget.
      return;
    }
    // (nothing went slim this call: the next stage, one tile at most)
    for (const t of tiles) {
      if (t.state !== 3 || !t.res || !t.ext || !t.cells) continue;
      if (!farFromAll(t.ext, x, z)) continue;
      evictDeep(t);
      return;
    }
  }

  function* slimSteps(t, buildings, trees) {
    const gone = new Set();
    yield* addAllSteps(gone, buildings);
    yield* addAllSteps(gone, trees);
    const cells = new Set();
    for (let i = 0; i < buildings.length; i++) { forEachCellOf(buildings[i], (k) => cells.add(k)); if ((i & 511) === 511) yield; }
    for (let i = 0; i < trees.length; i++) { forEachCellOf(trees[i], (k) => cells.add(k)); if ((i & 2047) === 2047) yield; }
    let n = 0;
    for (const key of cells) {
      const cell = city.chunkIndex.get(key);
      if (!cell) continue;
      if (cell.buildings !== NONE) { const l = cell.buildings.filter(f => !gone.has(f)); cell.buildings = l.length ? l : NONE; }
      if (cell.trees !== NONE) { const l = cell.trees.filter(f => !gone.has(f)); cell.trees = l.length ? l : NONE; }
      if ((++n & 255) === 0) yield;
    }
    // in place, every consumer holds these arrays by reference, forever
    yield* compactSteps(city.buildings, gone);
    yield* compactSteps(city.trees, gone);
    for (const cb of unloadListeners) cb({ tx: t.tx, tz: t.tz, cells });
  }

  // ---- DEEP EVICTION: the rest of a tile's data, not only its houses -------
  // Going slim gives back the buildings and trees, and that used to be all:
  // a teleport tour of six places (13 Nov 2026, headless, city data only) ended
  // at 588 MB, of which the chunk index of the tiles left behind was 143 MB,
  // their green, water and paved polygons most of 83 MB and their fences,
  // venues, power lines and street furniture most of 56 MB. Nothing near the
  // player reads any of it, and a long drive only ever added more.
  //
  // So a slim tile whose WHOLE footprint (every cell any of its features is
  // filed in, not only its rectangle: a river or a long road overhangs into its
  // neighbours) is EVICT_REACH from the focus, from the player and from every
  // co-op peer this client knows of (city.evictHolds) gives back the rest too,
  // and goes back to state 0 so it is fetched again when it comes in reach.
  //
  // (What follows is the round 7 rule, still what RELEASE_DATA = false gives.
  // With it on, the default since the round 7 polish, the ways, signals and
  // car parks go too and only the pois stay listed: see RELEASE_DATA.)
  // What does NOT go, and why: the roads and rails, the pois, the signals and
  // the car parks. The traffic, navigation, cyclist and walker graphs and the
  // trains hold the way objects for the whole session (traffic.js _growGraph,
  // navigation.js, cyclists.js, pedestrians.js, trains.js), the bus stop and
  // station readers walk city.pois by a cursor that assumes it only grows, the
  // signals are traffic's, and the stalls of a car park are remembered by the
  // lot object itself (parkinglots.js): a stall the player took a car from must
  // stay empty. Dropping any of them would give the session a second copy when
  // the tile came back. They are kept (`t.kept`) and stay in the flat arrays;
  // only their chunk-index entries go, and they are filed again on return. The
  // junction and bridge records hang off the kept ways, so they stay too.
  //
  // Coming back, the tile's file is fetched and indexed as on its first visit
  // with the kept objects standing in for the ones just parsed, so every id
  // (slot-derived, see IDS_PER_TILE) and every chunk built from it is the one
  // it was.
  const holdPts = [];
  function farFromAll(b, x, z) {
    const R2 = EVICT_REACH * EVICT_REACH;
    if (distSqToBounds(b, x, z) <= R2) return false;
    holdPts.length = 0;
    for (const fn of city.evictHolds) fn(holdPts);
    for (let i = 0; i + 1 < holdPts.length; i += 2)
      if (distSqToBounds(b, holdPts[i], holdPts[i + 1]) <= R2) return false;
    return true;
  }
  // a cell outlives the tile being evicted while a tile that OWNS it (its
  // rectangle holds the cell) is still indexed: see "a loaded tile owns its cells"
  function ownerResident(key, gone) {
    const i = key.indexOf(',');
    const cx = +key.slice(0, i), cz = +key.slice(i + 1);
    const o = tileBy.get(Math.floor((cx * CHUNK + 1e-3) / T) + ',' + Math.floor((cz * CHUNK + 1e-3) / T));
    return !!o && o !== gone && (o.state === 2 || o.state === 3);
  }
  function evictDeep(t) {
    const r = t.res, tileCells = t.cells;
    // the graphs' release runs after the cells below are emptied, from the
    // tile's own lists in `ev`
    const release = city.releaseGraphs && releaseListeners.length > 0;
    // (the ways themselves go too, RELEASE_DATA; never without the graphs'
    // release, which is what lets go of every other reference to them)
    const data = release && city.releaseData;
    const lots = new Map();
    for (const f of r.paved) if (f.t === 'parking') lots.set(f._id, f);
    const ev = release ? { tx: t.tx, tz: t.tz, rect: [t.tx * T, t.tz * T, (t.tx + 1) * T, (t.tz + 1) * T],
      roads: r.roads, rails: r.rails, signals: r.signals ?? [], venues: r.venues, cells: tileCells,
      ids: [t.slot * IDS_PER_TILE, (t.slot + 1) * IDS_PER_TILE], data, lots: [...lots.values()] } : null;
    // Gone at once as far as ensureTiles is concerned (state 0: fetched again
    // when it comes in reach, and indexed only once this job is through); the
    // work is a job of small steps, see queueJob.
    if (data) {
      t.kept = null;
      t.poisIn = true;
      t.released = false;
    } else {
      t.kept = { roads: r.roads, rails: r.rails, lots, signals: r.signals ?? [] };
      t.released = release;
    }
    t.res = null; t.cells = null; t.ext = null; t.heavy = null;
    t.state = 0;
    city.releasing++;
    queueJob(deepSteps(t, r, tileCells, ev, data, lots), () => { city.releasing--; });
  }
  function* deepSteps(t, r, tileCells, ev, data, lots) {
    const mine = new Set();
    for (const kind in r) if (kind !== 'waterways') yield* addAllSteps(mine, r[kind]);
    yield;
    // (its rectangle too: a cell some neighbour's feature made first was not
    // this tile's to record, but it is this tile's to own)
    const visit = new Set(tileCells);
    const c0 = Math.floor((t.tx * T) / CHUNK), c1 = Math.floor(((t.tx + 1) * T - 1e-6) / CHUNK);
    const d0 = Math.floor((t.tz * T) / CHUNK), d1 = Math.floor(((t.tz + 1) * T - 1e-6) / CHUNK);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) visit.add(cx + ',' + cz);
    let n = 0;
    for (const key of visit) {
      if ((++n & 127) === 0) yield;
      const cell = city.chunkIndex.get(key);
      if (!cell) continue;
      let empty = true;
      for (const kind of CELL_KINDS) {
        const list = cell[kind];
        if (list === NONE) continue;
        const left = list.filter((f) => !mine.has(f));
        cell[kind] = left.length ? left : NONE;
        if (left.length) empty = false;
      }
      if (empty && !ownerResident(key, t)) city.chunkIndex.delete(key);
    }
    // what leaves the flat arrays: everything filed above but the kept kinds
    // (with RELEASE_DATA nothing is kept but the pois, which were never filed)
    let gone = mine;            // (with RELEASE_DATA the same set: everything it filed,
    if (data) {                 // and the two kinds it lists without filing them)
      for (const s of r.signals ?? []) mine.add(s);
      for (const w of r.waterways) mine.add(w);
    } else {
      gone = new Set();
      for (const kind in r) {
        if (kind === 'roads' || kind === 'rails') continue;
        if (kind === 'paved') { for (const f of r.paved) if (!lots.has(f._id)) gone.add(f); continue; }
        yield* addAllSteps(gone, r[kind]);
      }
    }
    yield;
    // in place: every consumer holds these arrays by reference, forever
    for (const arr of [city.water, city.green, city.paved, city.power, city.venues, city.barriers, city.waterways])
      yield* compactSteps(arr, gone);
    if (r.waterways.length) delete city._wwChunks;   // meshes.js rebuilds it from city.waterways
    if (data) {
      for (const arr of [city.roads, city.rails, city.signals]) yield* compactSteps(arr, gone);
      // the pads and the stitching: nothing resident may still reach a released
      // way, or it stays alive and stands in for its successor on return
      const ways = new Set();
      yield* addAllSteps(ways, r.roads);
      yield* addAllSteps(ways, r.rails);
      yield* releaseJunctions(ways, visit);
      const ring = new Set(visit);
      let m = 0;
      for (const key of visit) {
        if ((++m & 511) === 0) yield;
        const i = key.indexOf(','), cx = +key.slice(0, i), cz = +key.slice(i + 1);
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) ring.add((cx + a) + ',' + (cz + b));
      }
      yield;
      yield* releaseStructures(city, ways, ring);
    }
    for (const cb of unloadListeners) cb({ tx: t.tx, tz: t.tz, cells: visit, deep: true });
    // every graph built from the tile's ways lets go of them, each in steps
    if (ev) for (const cb of releaseListeners) { yield; yield* guarded(cb, ev); }
  }
  return city;
}

// The box, in metres, of a set of chunk keys.
function cellsBox(keys) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const key of keys) {
    const i = key.indexOf(',');
    const cx = +key.slice(0, i), cz = +key.slice(i + 1);
    if (cx < x0) x0 = cx; if (cx > x1) x1 = cx;
    if (cz < z0) z0 = cz; if (cz > z1) z1 = cz;
  }
  return x0 > x1 ? null : [x0 * CHUNK, z0 * CHUNK, (x1 + 1) * CHUNK, (z1 + 1) * CHUNK];
}
