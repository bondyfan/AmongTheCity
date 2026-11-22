// ---- Trains: České dráhy on the real 532 km rail network (v6) ----
// The region ships 1465 rail ways and 25 named stations. Roads needed a
// directed GRAPH because a driver chooses at every junction; a train does not.
// So rails become ROUTES: fragments whose endpoints coincide are chained into
// one long polyline, once, and a train owns a route + a direction and simply
// advances along it. That is why this module has no node/edge machinery at all
// — the hard part is not "where do I go", it is "how does a 130 m articulated
// object sit on a curve and how does 500 tonnes stop".
//
// Three ideas carry the whole file:
//   · CHAINING (buildChains) — an endpoint→ways multimap plus a greedy walk
//     that always takes the STRAIGHTEST continuation, so a turnout keeps the
//     main line and spits the siding out as its own (usually too short) chain.
//   · The SPEED PROFILE (buildProfile) — per route, per direction, the highest
//     speed allowed at each vertex once you account for every curve and the
//     end of the line AHEAD of it, computed once by a backward pass. A train
//     then reads one interpolated number per frame instead of scanning 900 m
//     of polyline (which is what 40 m/s against 0.9 m/s² of brake costs you).
//   · The CONSIST rides by ARC LENGTH — every vehicle is placed from its two
//     BOGIE positions along the route, so the set articulates through a bend
//     the way a real one does instead of sliding through as a rigid box.
//
// Convention (ARCHITECTURE.md): x east, z SOUTH, y up; heading 0 faces −z,
// dir = (−sin h, −cos h), mesh.rotation.y = heading.

import { LAYER_Y } from './config.js';
import { bridgeElevation, distPointToSegment, railGradeY, bridgeDeckHeight } from './geo.js';
import { sfx } from './audio.js';
import { makeCoach, COACH } from './railcoach.js';
import { frameAt } from './traindeck.js';
import { installRide } from './trainride.js';

// ---- chaining + route tunables ----
const JOIN = 3;            // m — endpoints this close are the same rail joint
const JOIN_DOT = 0.25;     // cos ≈ 75°: a continuation sharper than this is a
                           // siding or a wrong turn, never the through line
const MIN_ROUTE = 800;     // m — contract floor for a usable route
const MIN_STEP = 0.4;      // drop duplicate/degenerate polyline points
const STATION_R = 60;      // m — a station POI this close to a route stops on it
const RAILHEAD = LAYER_Y.rail + 0.04;   // meshes.js draws the steel here

// ---- physics: a train must feel HEAVY ----
const VMAX = 40;           // m/s = 144 km/h
const ACCEL = 0.55;        // m/s² — 73 s and 1.45 km from a stand to line speed
const BRAKE = 0.9;         // m/s² — 44 s and 889 m the other way
const A_LAT = 1.5;         // m/s² of comfort through a curve
const CURVE_WIN = 30;      // m each side — curvature is INTEGRATED over this, so
                           // the radius does not depend on OSM's node density
const V_CURVE_MIN = 10;    // …but never crawl below this for geometry alone
const DWELL = 18;          // s standing at a platform, doors open
const DOOR_LEAD = 1.8;     // s before it leaves that the doors start to close
const DOOR_OPENS = 0.69, DOOR_SHUTS = 0.65;   // per second (the campaign's doors)
const TURN_DWELL = 9;      // s at the end of the line before reversing
const ARRIVE_GAP = 0.6;    // m — inside this and slow, we call it a stop
const PAST_STOP = 3;       // m past a platform before it stops being "ahead"

// ---- streaming ----
const KEEP = 6;            // trains alive around the focus
const SPAWN_MIN = 600;     // never materialize one inside the draw distance
const SPAWN_MAX = 3500;
const DESPAWN = 4000;
const SEP = 400;           // m of arc between two trains sharing a route
const SPAWN_EVERY = 1.5;   // s between spawn attempts — a fleet, not a burst
const NEAR_EVERY = 3.0;    // s between route-candidate rescans

// ---- consist geometry ----
// Every vehicle is the campaign's coach (js/railcoach.js, Frank 21 Nov 2026:
// every train is the train from Kolín). A set is a row of them with a cab at
// each end: no locomotive, and the coaches' own slots leave no slack between.
const CAR = COACH.pitch;                                   // m of train per coach
const BOGIE_F = COACH.front - COACH.mid - COACH.bogie;     // slot front → front bogie
const BOGIE_B = COACH.mid - COACH.bogie - COACH.back;      // slot back → rear bogie
const BOGIE_SPAN = COACH.bogie * 2;

// audio proximity gates — cues only fire near the listener
const BELL_R = 140, PASS_R = 70, PASS_V = 14;

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
// normalize into (−π, π] — the cant math differences two headings
const angWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// ============================== route building =============================

// endpoint hash: a JOIN-metre grid. Two ends up to JOIN apart can land in
// neighbouring cells, so lookups always sweep the 3×3 block and then measure —
// the grid prunes, the distance decides.
const cellKey = (x, z) => Math.round(x / JOIN) + ',' + Math.round(z / JOIN);

// per-way cumulative lengths, cached on the feature (bridge ramps need the
// distance from the WAY's own start, not from the chain's)
function wayCum(w) {
  if (w._trCum) return w._trCum;
  const p = w.p, c = new Float64Array(p.length);
  for (let i = 1; i < p.length; i++)
    c[i] = c[i - 1] + Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  w._trCum = c;
  return c;
}

// The railhead's height at distance d along way w. Rail bridges are the only
// relief in Polabí — everything else is the flat deck the rest of the city
// renders at, so this matches meshes.railWay exactly and the wheels sit ON
// the steel rather than hovering over it.
//
// …which was true of a flat world, and has not been since the terrain got its
// real altitudes (round 8 found every train running at y 0.18, 220 m under
// Pardubice, invisible). With the terrain handed in (main.js), a vertex sits
// where meshes.railWay draws the steel: the levelled rail grade
// (geo.railGradeY), the bridge deck on a bridge, the bare ground otherwise,
// plus the railhead.
let _terrain = null;
const UNREADY_Y = 20;      // m: no rail in the region lies this low (see _reheight)
const railY = (w, d, len, q) => {
  if (_terrain) {
    if (w.br) return bridgeDeckHeight(w, d, _terrain) + RAILHEAD;
    const gy = railGradeY(w, d, _terrain);
    return (gy ?? _terrain.heightAt(q[0], q[1])) + RAILHEAD;
  }
  return RAILHEAD + (w.br ? bridgeElevation(d, len) : 0);
};
/** The railhead height over the ground at (x, z): for track spliced on from
 *  outside a chain (js/express.js), which has no way to grade along. */
export function railHeadAt(x, z) {
  return (_terrain ? _terrain.heightAt(x, z) : 0) + RAILHEAD;
}
/** The railhead on way w at arclength s (the drawn steel), at (x, z) for the fallback. */
export function railHeadOn(w, s, x, z) {
  return railY(w, s, wayCum(w).at(-1), [x, z]);
}

// THE RIDE IS SAMPLED EVERY SAMPLE_STEP m (round 10). It used to be read at
// the OSM vertices alone, which on this network are 11 to 119 m apart, and
// interpolated straight between them: over a vertical curve the wheels rode
// up to 2.2 m off the drawn rail (Karlin), and even a smooth line read at
// 119 m chords is 0.9 m out. The points added lie ON the segment between two
// vertices, so the route's arclength, its stops and every co-op train
// position (route arc + the shared clock) are unchanged; L^2/8R at R 2000 m
// is 6 mm. Each point also remembers its way and arclength (R.wy / R.ws), so
// a vertex chained before its height tile arrived can be graded once it has.
const SAMPLE_STEP = 10;
/**
 * A spliced path (js/railstitch.js) graded like a chain: `at[i]` is [way, s]
 * for a point that lies on a way, or null (the route's own vertex it starts
 * from, a straight join across a weld). Between two points of one way the
 * rail is sampled every SAMPLE_STEP m; a join is interpolated between its
 * ends. `y0` is the height of pts[0]. Returns { pts, ys, wy, ws }.
 */
export function gradedPath(pts, at, y0) {
  const out = { pts: [], ys: [], wy: [], ws: [] };
  const yOf = (i) => (at[i] ? railHeadOn(at[i][0], at[i][1], pts[i][0], pts[i][1]) : null);
  let yPrev = y0;
  out.pts.push(pts[0]); out.ys.push(y0); out.wy.push(at[0]?.[0] ?? null); out.ws.push(at[0]?.[1] ?? 0);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const yb = yOf(i) ?? yPrev;
    const same = at[i - 1] && at[i] && at[i - 1][0] === at[i][0];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), k = Math.ceil(L / SAMPLE_STEP);
    for (let m = 1; m < k; m++) {
      const u = m / k, q = [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
      if (same) {
        const w = at[i][0], sw = at[i - 1][1] + (at[i][1] - at[i - 1][1]) * u;
        out.pts.push(q); out.ys.push(railHeadOn(w, sw, q[0], q[1])); out.wy.push(w); out.ws.push(sw);
      } else {
        out.pts.push(q); out.ys.push(yPrev + (yb - yPrev) * u); out.wy.push(null); out.ws.push(0);
      }
    }
    out.pts.push(b); out.ys.push(yb); out.wy.push(at[i]?.[0] ?? null); out.ws.push(at[i]?.[1] ?? 0);
    yPrev = yb;
  }
  return out;
}

// direction leaving endpoint `end` of way w, INTO the way (unit)
function endDir(w, end, out) {
  const p = w.p, n = p.length;
  const a = end ? p[n - 1] : p[0], b = end ? p[n - 2] : p[1];
  const dx = b[0] - a[0], dz = b[1] - a[1];
  const L = Math.hypot(dx, dz) || 1e-6;
  out.x = dx / L; out.z = dz / L;
  return out;
}

const _d1 = { x: 0, z: 0 }, _d2 = { x: 0, z: 0 };

/**
 * chainRailWays(ways) → [{ pts, ys, ways, len }]
 * Fragments in, long polylines out. Exported because this is the one piece
 * worth testing headlessly: feed it a fragmented set (some ways needing their
 * point order REVERSED, some branching) and count what comes back.
 *
 * The walk is greedy and directional: standing at the tail of the chain with
 * an incoming heading, every unused way endpoint within JOIN is a candidate
 * and the one whose outgoing direction best matches the incoming one wins. On
 * a turnout that is the through line by construction — a diverging siding
 * scores lower and gets left for its own chain.
 */
export function chainRailWays(ways) {
  const pool = [];
  const index = new Map();
  for (const w of ways) {
    if (!w.p || w.p.length < 2) continue;
    const c = wayCum(w);
    if (c[c.length - 1] < 1) continue;          // degenerate stub
    w._trUsed = false;
    pool.push(w);
    for (const end of [0, 1]) {
      const p = end ? w.p[w.p.length - 1] : w.p[0];
      const k = cellKey(p[0], p[1]);
      let list = index.get(k);
      if (!list) index.set(k, list = []);
      list.push({ x: p[0], z: p[1], w, end });
    }
  }
  // is this endpoint a dead end among the ways still unclaimed? Starting a
  // walk there is what produces MAXIMAL chains — start in the middle of a
  // line and you get two half-length routes instead of one.
  const free = (w, end) => {
    const p = end ? w.p[w.p.length - 1] : w.p[0];
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const list = index.get(cellKey(p[0] + gx * JOIN, p[1] + gz * JOIN));
      if (!list) continue;
      for (const r of list) {
        if (r.w === w || r.w._trUsed) continue;
        if (Math.hypot(r.x - p[0], r.z - p[1]) <= JOIN) return false;
      }
    }
    return true;
  };

  const chains = [];
  // pass 0 starts only at dead ends (maximal chains); pass 1 mops up whatever
  // is left, which is exactly the closed loops and ring lines
  for (let pass = 0; pass < 2; pass++) {
    for (const w of pool) {
      if (w._trUsed) continue;
      let start = -1;
      if (pass === 0) {
        if (free(w, 0)) start = 0;
        else if (free(w, 1)) start = 1;
        if (start < 0) continue;
      } else start = 0;
      chains.push(walkChain(w, start, index));
    }
  }
  return chains;
}

// append one way's points to a chain, reversing its point ORDER when we
// entered through its far end — without this, half of every chain runs
// backwards and the polyline zig-zags between fragment ends
function appendWay(pts, ys, w, rev, skipFirst, wy, ws) {
  const p = w.p, n = p.length, cum = wayCum(w), len = cum[n - 1];
  const put = (q, s) => {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < MIN_STEP) return;
    pts.push(q);
    ys.push(railY(w, s, len, q));
    wy?.push(w); ws?.push(s);
  };
  let prev = -1;
  for (let j = 0; j < n; j++) {
    const i = rev ? n - 1 - j : j;
    if (prev >= 0) {
      // the rail between two vertices, every SAMPLE_STEP m (on the segment)
      const a = p[prev], b = p[i], L = Math.abs(cum[i] - cum[prev]), k = Math.ceil(L / SAMPLE_STEP);
      for (let m = 1; m < k; m++) {
        const u = m / k;
        put([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], cum[prev] + (cum[i] - cum[prev]) * u);
      }
    }
    prev = i;
    if (j === 0 && skipFirst) continue;         // the shared joint, already in
    put(p[i], cum[i]);
  }
}

function walkChain(w0, startEnd, index) {
  const pts = [], ys = [], used = [], wy = [], ws = [];
  appendWay(pts, ys, w0, startEnd === 1, false, wy, ws);
  w0._trUsed = true;
  used.push(w0);
  for (;;) {
    const n = pts.length;
    if (n < 2) break;
    const tx = pts[n - 1][0], tz = pts[n - 1][1];
    let ix = tx - pts[n - 2][0], iz = tz - pts[n - 2][1];
    const iL = Math.hypot(ix, iz) || 1e-6;
    ix /= iL; iz /= iL;
    let best = null, bestDot = JOIN_DOT;
    for (let gx = -1; gx <= 1; gx++) for (let gz = -1; gz <= 1; gz++) {
      const list = index.get(cellKey(tx + gx * JOIN, tz + gz * JOIN));
      if (!list) continue;
      for (const r of list) {
        if (r.w._trUsed) continue;
        if (Math.hypot(r.x - tx, r.z - tz) > JOIN) continue;
        endDir(r.w, r.end, _d1);
        const dot = ix * _d1.x + iz * _d1.z;    // straightest continuation wins
        if (dot > bestDot) { bestDot = dot; best = r; }
      }
    }
    if (!best) break;
    best.w._trUsed = true;
    used.push(best.w);
    appendWay(pts, ys, best.w, best.end === 1, true, wy, ws);
  }
  let len = 0;
  for (let i = 1; i < pts.length; i++)
    len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return { pts, ys, wy, ws, ways: used, len };
}

// cumulative lengths + bbox, recomputed whenever a route grows
function measure(R) {
  const n = R.pts.length;
  const cum = new Float64Array(n);
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < n; i++) {
    if (i) cum[i] = cum[i - 1]
      + Math.hypot(R.pts[i][0] - R.pts[i - 1][0], R.pts[i][1] - R.pts[i - 1][1]);
    const x = R.pts[i][0], z = R.pts[i][1];
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }
  R.cum = cum;
  R.len = cum[n - 1];
  R.minX = minX; R.maxX = maxX; R.minZ = minZ; R.maxZ = maxZ;
}

/**
 * buildProfile(R) — the highest speed allowed AT each vertex, per direction,
 * once every curve and the end of the line ahead of it is accounted for.
 *
 * A train braking at 0.9 m/s² needs 889 m of warning from line speed. Scanning
 * that much polyline per train per frame is silly when the answer never
 * changes: one backward pass (v² = v_next² + 2·b·Δs, capped by the local curve
 * limit) bakes the entire braking envelope into an array the drive loop reads
 * with one lerp. R.vf is for travel toward increasing s, R.vr the other way;
 * each is seeded with a 0 at the end it must stop at.
 */
function buildProfile(R) {
  const n = R.pts.length, pts = R.pts, cum = R.cum;
  const lim = new Float32Array(n);
  lim.fill(VMAX);
  for (let i = 1; i < n - 1; i++) {
    // Curvature is measured over a WINDOW of track, never off one vertex.
    // OSM node spacing on this network runs 11 m (p10) to 119 m (p90) with a
    // median of 27, and surveyors put the nodes CLOSE TOGETHER inside curves —
    // so reading a vertex angle against any assumed constant spacing over-
    // estimates the radius exactly where it must not. Measured over ±CURVE_WIN
    // the answer is the same whether the curve carries four nodes or forty.
    let a = i, b = i;
    while (a > 0 && cum[i] - cum[a] < CURVE_WIN) a--;
    while (b < n - 1 && cum[b] - cum[i] < CURVE_WIN) b++;
    if (a === i || b === i) continue;            // no room at the line's ends
    const ax = pts[i][0] - pts[a][0], az = pts[i][1] - pts[a][1];
    const bx = pts[b][0] - pts[i][0], bz = pts[b][1] - pts[i][1];
    const ang = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (ang <= 0.02) continue;                   // straight enough to ignore
    // the two chords are tangent at their own midpoints, so the angle between
    // them is the arc BETWEEN those midpoints over R — i.e. arc/2R, not arc/R.
    // Then v = √(a_lat·R): a main-line bend barely registers, a yard curve
    // pulls the whole train down to walking pace, which is correct.
    lim[i] = clamp(Math.sqrt(A_LAT * (cum[b] - cum[a]) / (2 * ang)),
      V_CURVE_MIN, VMAX);
  }
  const vf = new Float32Array(n), vr = new Float32Array(n);
  vf[n - 1] = 0;                                 // forward travel ends here
  for (let i = n - 2; i >= 0; i--) {
    const d = cum[i + 1] - cum[i];
    vf[i] = Math.min(lim[i], Math.sqrt(vf[i + 1] * vf[i + 1] + 2 * BRAKE * d));
  }
  vr[0] = 0;                                     // …reverse travel ends here
  for (let i = 1; i < n; i++) {
    const d = cum[i] - cum[i - 1];
    vr[i] = Math.min(lim[i], Math.sqrt(vr[i - 1] * vr[i - 1] + 2 * BRAKE * d));
  }
  R.vf = vf; R.vr = vr;
}

// ---- shared scratch: the per-frame paths below never allocate ----
const _pose = { x: 0, y: 0, z: 0, seg: 0 };
const _seg = { x: 0, z: 0, t: 0 };

// point + elevation at arc length s, resuming from the caller's cached segment
// index. Carriages walk BACKWARD from the engine, so the search has to be able
// to go both ways; each vehicle keeps its own hint, so both loops amortize to
// nothing.
function poseAt(R, s, seg) {
  const pts = R.pts, cum = R.cum, last = pts.length - 2;
  if (s < 0) s = 0; else if (s > R.len) s = R.len;
  seg = seg < 0 ? 0 : seg > last ? last : seg;
  while (seg < last && s > cum[seg + 1]) seg++;
  while (seg > 0 && s < cum[seg]) seg--;
  const a = pts[seg], b = pts[seg + 1];
  const L = (cum[seg + 1] - cum[seg]) || 1e-6;
  const t = clamp((s - cum[seg]) / L, 0, 1);
  _pose.x = a[0] + (b[0] - a[0]) * t;
  _pose.z = a[1] + (b[1] - a[1]) * t;
  _pose.y = R.ys[seg] + (R.ys[seg + 1] - R.ys[seg]) * t;
  _pose.seg = seg;
  return _pose;
}

// The baked profile, linearly interpolated inside the segment that actually
// contains s — and like poseAt this WALKS to it rather than trusting the hint.
// A stale hint (or the plain 0 a freshly spawned train hands in) would clamp
// against the wrong end of a 3 km route and read the limit at vertex 1, which
// on a line that starts at a buffer stop is ~5 m/s: every spawned train would
// crawl for a minute before it worked out it was allowed to move.
function limitAt(R, s, seg, dir) {
  const arr = dir > 0 ? R.vf : R.vr, cum = R.cum, last = R.pts.length - 2;
  let g = seg < 0 ? 0 : seg > last ? last : seg;
  while (g < last && s > cum[g + 1]) g++;
  while (g > 0 && s < cum[g]) g--;
  const L = (cum[g + 1] - cum[g]) || 1e-6;
  const t = clamp((s - cum[g]) / L, 0, 1);
  return arr[g] + (arr[g + 1] - arr[g]) * t;
}

// braking envelope onto a hard stop `gap` metres ahead. The √ term is the
// physics; the linear term is what actually gets the last two metres closed —
// an exponential approach never arrives, and a train that never quite stops
// never opens its doors.
const stopEnvelope = (gap) => gap <= ARRIVE_GAP ? 0
  : Math.min(Math.sqrt(2 * BRAKE * gap), gap * 0.9);

// ================================= Trains ==================================

export class Trains {
  /**
   * @param scene THREE.Scene
   * @param city  the geo.js city (rails/pois GROW as tiles stream)
   * @param opts  { onBoard(train), onAlight({x,y,z}), player, world }
   *   player — anything with `.pos {x,z}`; while riding, update() writes the
   *     train's position into it so the camera and the chunk streamer follow.
   *     May also be handed to board() instead.
   *   world  — optional CityWorld; if present its heightAt() is sampled once
   *     per route point at build time (bridge decks), never per frame.
   */
  constructor(scene, city, opts = {}) {
    this.scene = scene;
    this.city = city;
    this.opts = opts;
    this.player = opts.player ?? null;
    this.world = opts.world ?? null;
    if (opts.terrain) _terrain = opts.terrain;   // rails at their real height (railY)
    this.routes = [];
    this.trains = new Set();
    this.riding = null;
    this.ridePos = { x: 0, y: 0, z: 0 };   // main can read this instead of player
    this._focus = null;                    // last focus handed to update() — the
                                           // rider fallback writes into it
    this._near = [];                       // routes in spawn range of the focus
    this._nearT = 0; this._spawnT = 0;
    this._fx = 0; this._fz = 0;            // last focus — audio proximity gates
    this._stations = [];                   // the t:'station' pois, cached out of
    this._poiN = -1;                       // 2200 others; refreshed when pois grow
    this._pending = true;                  // rails waiting to be chained
    // rails and stations both GROW as region tiles stream, and the callback
    // only carries roads/signals — so we just mark ourselves dirty and rescan
    // city.rails / city.pois on the next update, off the fetch's stack.
    city.onTileLoaded?.(() => { this._pending = true; });
    // A far tile gives its rails back (geo.js RELEASE_DATA) and brings new
    // objects with the same ids when it returns. A route over them is dropped,
    // so the returning rails chain again instead of being spliced onto the old
    // route a second time; which route holds which rail is kept by id. Not a
    // route a train is running on: a line can run from the far tile to within
    // a few hundred metres of the player, and its train would vanish in view.
    this._wids = new Map();                // rail _id -> the route it is part of
    this._rid = 0;                         // route ids: never reused after a drop
    this._tid = 0;                         // train ids, for whoever keeps things per train
    city.onTileReleased?.((t) => this.releaseTile(t));
  }

  /** A released tile's rails: the routes over them go, their other rails chain again. */
  releaseTile(t) {
    if (!t.data || !t.rails?.length) return;
    // (never a route with a train on it, the ridden one included: it stays
    // whole, and its rails are known by id when they come back; a later
    // release that finds it without trains drops it)
    const live = new Set();
    for (const tr of this.trains) live.add(tr.route);
    if (this.riding) live.add(this.riding.route);
    const drop = new Set();
    for (const w of t.rails) {
      const R = this._wids.get(w._id);
      if (R && !live.has(R)) drop.add(R);
    }
    if (!drop.size) return;
    let n = 0;
    for (const R of this.routes) if (!drop.has(R)) this.routes[n++] = R;
    this.routes.length = n;
    for (const [id, R] of this._wids) if (drop.has(R)) this._wids.delete(id);
    for (const w of this.city.rails) if (w._trDone && !this._wids.has(w._id)) w._trDone = false;
    this._near.length = 0; this._nearT = 0;
    this._pending = true;
  }

  // ---- ingestion: rails → routes ----------------------------------------

  // Chain every rail way not already part of a route. Ways that end up in a
  // route are stamped _trDone and never looked at again; ways that only made a
  // SHORT chain stay in the pool, so when the neighbouring tile lands and
  // supplies their other half they get another chance at reaching 800 m.
  _ingest() {
    // Cache the stations FIRST — _scanStops runs against this list, and the
    // region's 2222 pois are 99 % benches and pharmacies. Filtering them once
    // per tile instead of once per route is the difference between a 70 ms
    // hitch on every tile load and a rounding error.
    const stationsGrew = this.city.pois.length !== this._poiN;
    if (stationsGrew) {
      this._poiN = this.city.pois.length;
      this._stations.length = 0;
      for (const p of this.city.pois)
        if (p.t === 'station' && p.p) this._stations.push(p);
    }
    const pool = [];
    for (const w of this.city.rails) {
      if (w.t === 'tram' || w._trDone) continue;   // trams are street furniture
      if (this._wids.has(w._id)) { w._trDone = true; continue; }   // (back, and its route never left)
      pool.push(w);
    }
    let grew = false;
    if (pool.length) {
      for (const c of chainRailWays(pool)) {
        // a chain that continues an existing route is worth keeping whatever
        // its own length — that IS the tile-border case, and without it every
        // 4.8 km seam would become a train reversing in a field
        let R = this._mergeChain(c);              // _append rescans its stops
        if (R) { grew = true; }
        else if (c.len >= MIN_ROUTE) { R = this._addRoute(c); this._scanStops(R); grew = true; }
        else continue;                             // too short, leave it in the pool
        for (const w of c.ways) { w._trDone = true; if (w._id !== undefined) this._wids.set(w._id, R); }
      }
    }
    // a NEW station has to be offered to routes that were already finished
    if (stationsGrew) for (const R of this.routes) this._scanStops(R);
    this._joinRoutes();                            // (cheap: a pass over the route ends)
    if (grew) this._nearT = 0;                     // fresh track joins the spawn pool
  }

  // Track chained before its tile's height map arrived was given the ground
  // heightAt answers there, 0, i.e. 220 m under Polabí (the real altitudes
  // are 150 to 400 m, so anything under UNREADY_Y is that). A rider skipping
  // ahead was put down there and drowned. Once a second, such vertices are
  // set to the ground now known (plus the railhead; the grade and the bridge
  // decks of railY are lost there, a small error against 220 m).
  // …and a point that knows its way and arclength (R.wy / R.ws) is given the
  // rail's own level, grade and decks: railY, as if chained now.
  _reheight() {
    if (!_terrain) return;
    for (const R of this.routes) {
      if (R._flat === 0) continue;
      let left = 0;
      for (let i = 0; i < R.ys.length; i++) {
        if (R.ys[i] > UNREADY_Y) continue;
        const q = R.pts[i];
        if (_terrain.ready && !_terrain.ready(q[0], q[1])) { left++; continue; }
        const w = R.wy?.[i];
        R.ys[i] = w ? railY(w, R.ws[i], wayCum(w).at(-1), q) : _terrain.heightAt(q[0], q[1]) + RAILHEAD;
      }
      R._flat = left;
    }
  }

  // Two ROUTES whose ends meet are one line. _mergeChain only splices a new
  // chain onto a route, so where the line had already been chained from both
  // sides before the piece between arrived, it stayed two routes meeting end
  // to end, and every train (the express included, round 8) reversed at the
  // seam in open country (measured: line 010 west of Pardubice at x -7080).
  // Joined here the same way: B goes onto A's end, trains on B keep their
  // place (their arc is rebased), B is dropped.
  _joinRoutes() {
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOIN;
    const dirAt = (R, end) => {
      const n = R.pts.length, a = end ? R.pts[n - 2] : R.pts[1], b = end ? R.pts[n - 1] : R.pts[0];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-6;
      return [(b[0] - a[0]) / L, (b[1] - a[1]) / L];   // leaving the route at that end
    };
    for (let guard = 0; guard < 64; guard++) {
      let pair = null;
      search:
      for (const A of this.routes) for (const B of this.routes) {
        if (A === B) continue;
        const ae = A.pts[A.pts.length - 1];
        let rev;
        if (near(ae, B.pts[0])) rev = false;
        else if (near(ae, B.pts[B.pts.length - 1])) rev = true;
        else continue;
        // a continuation, not a turnout's stub meeting the line at an angle
        const da = dirAt(A, true), db = dirAt(B, rev);
        if (-(da[0] * db[0] + da[1] * db[1]) < JOIN_DOT) continue;
        pair = { A, B, rev };
        break search;
      }
      if (!pair) return;
      const { A, B, rev } = pair;
      const off = A.len, blen = B.len;
      this._append(A, { pts: B.pts, ys: B.ys, wy: B.wy, ws: B.ws }, rev);
      for (const t of this.trains) {
        if (t.route !== B) continue;
        t.route = A;
        t.s = off + (rev ? blen - t.s : t.s);
        if (rev) t.dir = -t.dir;
        t.seg = 0;
        for (const v of t.cars) { v.segF = 0; v.segR = 0; }
        // the stop it just left is A's object now (same poi)
        if (t.departed) t.departed = A.stops.find((st) => st.poi === t.departed.poi) ?? null;
        if (t.station) t.station = A.stops.find((st) => st.poi === t.station.poi) ?? t.station;
      }
      const i = this.routes.indexOf(B);
      if (i >= 0) this.routes.splice(i, 1);
      for (const [id, R] of this._wids) if (R === B) this._wids.set(id, A);
      this._near.length = 0; this._nearT = 0;
    }
  }

  _addRoute(c) {
    const R = { id: this._rid++, pts: c.pts, ys: c.ys, wy: c.wy ?? null, ws: c.ws ?? null, stops: [],
      cum: null, len: 0, vf: null, vr: null,
      minX: 0, maxX: 0, minZ: 0, maxZ: 0 };
    measure(R);
    // (a route used to be lifted to world.heightAt at every vertex, the
    // highest surface there: with a world handed in that put a train onto any
    // overpass above its own track. railY already carries the decks; gone.)
    buildProfile(R);
    this.routes.push(R);
    return R;
  }

  // Splice a fresh chain onto an existing route when their ends coincide.
  // Appending leaves every arc position on the route valid, so trains and
  // stops are untouched; the other three orientations are reduced to that
  // case by reversing the chain and/or the route first.
  _mergeChain(c) {
    const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= JOIN;
    const cs = c.pts[0], ce = c.pts[c.pts.length - 1], cn = c.pts.length;
    // A continuation, never a hairpin: the chainer's own JOIN_DOT rule. Without
    // it a short chain that meets a route's end and runs straight BACK beside
    // it was spliced on, and every train reversed in open country at the
    // splice (round 8 review: line 010 at Pečky doubled back 270 m at x
    // -52881, so the line on toward Prague, a route starting at that very
    // point, was never joined and the express shuttled back to Kolín).
    // (o, p): the route's end and the vertex before it; (a, b): the chain's
    // joint and the vertex after it.
    const goesOn = (o, p, a, b) => {
      const ox = o[0] - p[0], oz = o[1] - p[1], ax = b[0] - a[0], az = b[1] - a[1];
      return (ox * ax + oz * az) / (Math.hypot(ox, oz) * Math.hypot(ax, az) || 1e-9) >= JOIN_DOT;
    };
    for (const R of this.routes) {
      const n = R.pts.length, rs = R.pts[0], re = R.pts[n - 1];
      if (near(cs, re) && goesOn(re, R.pts[n - 2], cs, c.pts[1])) { this._append(R, c, false); return R; }
      if (near(ce, re) && goesOn(re, R.pts[n - 2], ce, c.pts[cn - 2])) { this._append(R, c, true); return R; }
      if (near(cs, rs) && goesOn(rs, R.pts[1], cs, c.pts[1])) { this._reverseRoute(R); this._append(R, c, false); return R; }
      if (near(ce, rs) && goesOn(rs, R.pts[1], ce, c.pts[cn - 2])) { this._reverseRoute(R); this._append(R, c, true); return R; }
    }
    return null;
  }

  _append(R, c, rev) {
    R._flat = -1;                                  // new vertices: check their heights
    const n = c.pts.length;
    for (let j = 1; j < n; j++) {                  // j=0 is the shared joint
      const i = rev ? n - 1 - j : j;
      const last = R.pts[R.pts.length - 1];
      if (Math.hypot(c.pts[i][0] - last[0], c.pts[i][1] - last[1]) < MIN_STEP) continue;
      R.pts.push(c.pts[i]);
      R.ys.push(c.ys[i]);
      if (R.wy) { R.wy.push(c.wy?.[i] ?? null); R.ws.push(c.ws?.[i] ?? 0); }
    }
    measure(R);
    buildProfile(R);
    this._scanStops(R);
  }

  // Flip a route's parameterization. Physically nothing moves: every train on
  // it keeps its place (s → len − s) and merely counts arc the other way, and
  // its consist labelling (which end the loco is on) is untouched.
  _reverseRoute(R) {
    R.pts.reverse(); R.ys.reverse(); R.wy?.reverse(); R.ws?.reverse();
    const len = R.len;
    measure(R);
    buildProfile(R);
    for (const st of R.stops) st.s = len - st.s;
    R.stops.sort((a, b) => a.s - b.s);
    for (const t of this.trains) {
      if (t.route !== R) continue;
      t.s = len - t.s;
      t.dir = -t.dir;
      t.seg = 0;
      for (const v of t.cars) { v.segF = 0; v.segR = 0; }
    }
  }

  // Station POIs within STATION_R of the route become platform stops. Stop
  // OBJECTS are reused across rescans when the name matches, because trains
  // hold a reference to the one they just left — rebuilding the array from
  // scratch would make a departing train brake for the platform behind it.
  _scanStops(R) {
    const old = R.stops;
    const out = [];
    for (const poi of this._stations) {
      const x = poi.p[0], z = poi.p[1];
      if (x < R.minX - STATION_R || x > R.maxX + STATION_R
        || z < R.minZ - STATION_R || z > R.maxZ + STATION_R) continue;
      let bd = STATION_R, bs = 0;
      for (let i = 0; i < R.pts.length - 1; i++) {
        const a = R.pts[i], b = R.pts[i + 1];
        const d = distPointToSegment(x, z, a[0], a[1], b[0], b[1], _seg);
        if (d < bd) { bd = d; bs = R.cum[i] + _seg.t * (R.cum[i + 1] - R.cum[i]); }
      }
      if (bd >= STATION_R) continue;
      // identity is the POI OBJECT, not its name: city.pois entries are stable
      // for the session, whereas half the region's halts share the fallback
      // name and matching on that would fuse two platforms into one stop.
      let st = null;
      for (const o of old) if (o.poi === poi) { st = o; break; }
      if (st) { st.s = bs; st.x = x; st.z = z; }
      else st = { poi, name: poi.n ?? 'Zastávka', s: bs, x, z };
      out.push(st);
    }
    out.sort((a, b) => a.s - b.s);
    R.stops = out;
  }

  // ---- per-frame ---------------------------------------------------------

  update(dt, focus) {
    if (this._pending) { this._pending = false; this._ingest(); }
    this._reheightT = (this._reheightT ?? 0) - dt;
    if (this._reheightT <= 0) { this._reheightT = 1; this._reheight(); }
    if (!focus) return;
    // Remembered, not copied. main.js builds its focus as `game.car ?? player
    // .pos`, so while you are riding a train the object handed in here IS the
    // player's position — which lets a Trains built with no `player` option
    // still drag the camera and the chunk streamer along with the train. See
    // _rideTarget().
    this._focus = focus;
    dt = Math.min(dt, 1 / 15);            // a tab-return spike must not teleport
    this._fx = focus.x; this._fz = focus.z;
    this._stream(dt, focus.x, focus.z);
    // where the walker is in his coach, before it moves (js/trainride.js)…
    this._rideBefore();
    for (const t of this.trains) {
      this._drive(t, dt);
      this._place(t, dt);
    }
    // …and the same place in it afterwards
    this._rideAfter();
  }

  _stream(dt, px, pz) {
    // despawn first, so the top-up below immediately refills the fleet ahead
    // of us instead of a frame later. The train being RIDDEN is exempt at
    // every step — pulling the floor out from under the player is not a
    // streaming decision we are allowed to make.
    for (const t of this.trains) {
      if (t === this.riding) continue;
      if (Math.hypot(t.x - px, t.z - pz) > DESPAWN) this._remove(t);
    }
    this._nearT -= dt;
    if (this._nearT <= 0) {
      this._nearT = NEAR_EVERY;
      this._near.length = 0;
      for (const R of this.routes) {
        const dx = Math.max(R.minX - px, 0, px - R.maxX);
        const dz = Math.max(R.minZ - pz, 0, pz - R.maxZ);
        if (dx * dx + dz * dz < SPAWN_MAX * SPAWN_MAX) this._near.push(R);
      }
    }
    this._spawnT -= dt;
    if (this._spawnT <= 0 && this.trains.size < KEEP) {
      this._spawnT = SPAWN_EVERY;
      this._trySpawn(px, pz);
    }
  }

  // Find a slot on a nearby route that is far enough away to appear unseen and
  // close enough to matter, with no other train breathing down its neck.
  _trySpawn(px, pz) {
    if (!this._near.length) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      const R = this._near[(Math.random() * this._near.length) | 0];
      const dir = Math.random() < 0.5 ? 1 : -1;
      const nCars = 3;                                     // the train from Kolín: three coaches
      const len = this._consistLength(nCars);
      if (R.len < len + MIN_ROUTE * 0.5) continue;
      const s = len + Math.random() * (R.len - len);
      const pose = poseAt(R, s, 0);
      const d = Math.hypot(pose.x - px, pose.z - pz);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      let clash = false;
      for (const o of this.trains)
        if (o.route === R && Math.abs(o.s - s) < SEP) { clash = true; break; }
      if (clash) continue;
      this._spawn(R, s, dir, nCars);
      return;
    }
  }

  _consistLength(nCars) {
    return nCars * CAR;
  }

  _spawn(R, s, dir, nCars, opts = {}) {
    // flip = "the consist is labelled back-to-front along the route". A
    // reversing train does NOT turn around, it just gets pushed — so the loco
    // stays physically put while the head end changes ends.
    const flip = Math.random() < 0.5 ? 1 : 0;
    const cars = [];
    nCars = Math.max(2, nCars | 0);
    let off = 0;
    for (let i = 0; i < nCars; i++) {
      const coach = makeCoach({ first: i === 0, last: i === nCars - 1, destination: opts.destination });
      this.scene.add(coach.group);
      coach.lamps(flip);
      cars.push({ mesh: coach.group, body: coach.body, coach, len: CAR, off, frame: {},
        segF: 0, segR: 0, roll: 0, prevH: 0, hasH: false });
      off += CAR;
    }
    const t = {
      id: ++this._tid, route: R, dir, s: 0, seg: 0, speed: 0, cars,
      length: off, flip,
      // every coach's own frame, front to back as built (js/traindeck.js), and
      // the doors: 1 shut … 0 open
      frames: cars.map((v) => v.frame), closed: 1,
      dwellT: 0, station: null, departed: null, halted: false, turning: false,
      // plain mirrors of the state above, kept for the HUD so main.js never
      // has to reach into a stop object: name of the platform we stand at, the
      // one we are running for, and the seconds left before "odjezd"
      stopName: null, nextStopName: null, dwellLeft: 0,
      x: 0, y: 0, z: 0, heading: 0, _passT: 0,
    };
    t.s = clamp(s, this._sLo(t), this._sHi(t));
    // Rolling, not parked — but never faster than it could still stop from:
    // dropped in at line speed 300 m short of a platform it would blow
    // straight through it, and 889 m of braking distance is unforgiving.
    const st = this._nextStop(t);
    t.speed = Math.min(VMAX * 0.7, limitAt(R, t.s, 0, dir),
      stopEnvelope(this._toEnd(t)), st ? stopEnvelope((this.stopS(t, st) - t.s) * dir) : VMAX);
    this.trains.add(t);
    this._place(t, 0);
    return t;
  }

  _remove(t) {
    this.trains.delete(t);
    this.onRemove?.(t);
    for (const v of t.cars) this.scene.remove(v.mesh);
  }

  /** Where the HEAD stands when the set is at stop `st`: the middle of the
   *  train at the station, not its nose (an 80 m set stopped with its head at
   *  the building had two coaches out past the platform's end). */
  stopS(t, st) {
    return clamp(st.s + t.dir * t.length / 2, this._sLo(t), this._sHi(t));
  }

  // the arc window the HEAD may occupy: the tail must stay on the route too,
  // and which end that constrains depends on the direction of travel
  _sLo(t) { return t.dir > 0 ? t.length : 0; }
  _sHi(t) { return t.dir > 0 ? t.route.len : t.route.len - t.length; }
  /** metres of track left before the buffer stop at this end of the line */
  _toEnd(t) { return t.dir > 0 ? this._sHi(t) - t.s : t.s - this._sLo(t); }

  // the next platform ahead, or null. Scanned rather than indexed because a
  // route has a handful of stops and an index goes stale every time a tile
  // splices track onto the end of the line.
  _nextStop(t) {
    let best = null, bd = 1e9;
    for (const st of t.route.stops) {
      // a fast train calls at its own stations only (js/express.js `only`)
      if (t.only && !t.only(st.name)) continue;
      const d = (this.stopS(t, st) - t.s) * t.dir;
      if (st === t.departed) { if (d < -30) t.departed = null; continue; }
      if (d < -PAST_STOP) continue;
      if (d < bd) { bd = d; best = st; }
    }
    return best;
  }

  _drive(t, dt) {
    // held by a skip to the next station (js/express.js): it places the train
    if (t.hold) { t.speed = 0; return; }
    const R = t.route;
    if (t.halted) {                           // standing at a platform / turning
      t.dwellT -= dt;
      t.dwellLeft = t.dwellT > 0 ? t.dwellT : 0;
      t.speed = 0;
      // the doors: open at a platform, shut again before it moves, and it
      // does not move until they are (a walker in the doorway is not dragged)
      const open = !!t.station && !t.turning && t.dwellT > DOOR_LEAD;
      if (!open && t.closed < 1 && !t._shutting) {
        t._shutting = true;
        if (this._hears(t)) sfx('train_doors', 0.5);
      }
      this._doors(t, open ? t.closed - DOOR_OPENS * dt : t.closed + DOOR_SHUTS * dt);
      if (t.dwellT > 0 || t.closed < 1) return;
      this._depart(t);
      return;
    }
    // target speed: the baked curve/end-of-line profile, then the platform we
    // are running at, whichever is lower
    let tgt = Math.min(VMAX, limitAt(R, t.s, t.seg, t.dir));
    const st = this._nextStop(t);
    t.nextStopName = st ? st.name : null;
    if (st) tgt = Math.min(tgt, stopEnvelope((this.stopS(t, st) - t.s) * t.dir));
    tgt = Math.min(tgt, stopEnvelope(this._toEnd(t)));
    if (tgt < 0) tgt = 0;
    // 0.55 up, 0.9 down: everything about the way this accelerates says the
    // thing weighs 400 tonnes, and that is the entire point
    if (t.speed < tgt) t.speed = Math.min(tgt, t.speed + ACCEL * dt);
    else t.speed = Math.max(tgt, t.speed - BRAKE * dt);
    t.s = clamp(t.s + t.dir * t.speed * dt, this._sLo(t), this._sHi(t));
    // arrival tests — a platform first, the buffer stop second
    if (st && t.speed < 0.5 && (this.stopS(t, st) - t.s) * t.dir <= ARRIVE_GAP) {
      t.s = this.stopS(t, st);
      this._halt(t, st, t.dwellFor?.(st) ?? DWELL);
    } else if (t.speed < 0.5 && this._toEnd(t) <= ARRIVE_GAP) {
      this._halt(t, null, TURN_DWELL);
      t.turning = true;
    }
  }

  _halt(t, st, wait) {
    t.speed = 0;
    t.dwellT = wait;
    t.dwellLeft = wait;
    t.halted = true;
    t.station = st;
    t.stopName = st ? st.name : null;
    t.nextStopName = t.stopName;
    t._shutting = false;
    // the ČD platform chime, then the doors — but only if anyone is close
    // enough to hear it, otherwise a region's worth of trains chimes at once
    if (this._hears(t)) {
      if (st) sfx('station_bell', 0.5);
      if (st) sfx('train_doors', 0.55);
    }
  }

  _depart(t) {
    t.dwellT = 0;
    t.dwellLeft = 0;
    t.halted = false;
    this._doors(t, 1);
    const near = this._hears(t);
    if (t.turning) {
      // end of the line: the head end swaps to the other end of the consist
      // and the labelling flips with it, so the loco stays exactly where it
      // is and starts pushing — which is what a Czech push-pull set does.
      t.turning = false;
      t.s = t.s - t.dir * t.length;
      t.dir = -t.dir;
      t.flip ^= 1;
      t.seg = 0;
      for (const v of t.cars) {
        v.segF = 0; v.segR = 0; v.hasH = false;
        v.coach.lamps(t.flip);                // the red end walks with the flip
      }
      t.s = clamp(t.s, this._sLo(t), this._sHi(t));
      // …and the "don't brake for the platform behind me" exemption dies with
      // the direction. Keeping it would make the train run back through the
      // last station it served without stopping — the one place on the whole
      // line where a passenger is definitely standing waiting for it.
      t.departed = null;
    } else if (t.station) {
      t.departed = t.station;                 // don't brake for the one we left
      if (near) sfx('train_horn', 0.45);
    }
    t.station = null;
    t.stopName = null;
  }

  // close enough to be heard: the platform, or aboard
  _hears(t) {
    return t === this.riding || Math.hypot(t.x - this._fx, t.z - this._fz) < BELL_R;
  }

  // The doors of every coach, 1 shut … 0 open.
  _doors(t, closed) {
    closed = clamp(closed, 0, 1);
    if (closed === t.closed) return;
    t.closed = closed;
    for (const v of t.cars) v.coach.doors(closed);
  }

  // Place every vehicle from its two BOGIE positions along the route. This is
  // the difference between a train and a caterpillar of boxes: the body sits
  // on the chord between its bogies, so through a curve each carriage is
  // slightly off the arc exactly like the real thing, and the set articulates
  // instead of sliding round as one rigid object.
  _place(t, dt) {
    const R = t.route;
    const head = poseAt(R, t.s, t.seg);
    t.seg = head.seg;
    const flip = t.flip;
    for (let i = 0; i < t.cars.length; i++) {
      const v = t.cars[i];
      // distance of this vehicle's front/rear bogie BEHIND the head end
      const base = flip ? t.length - v.off - v.len : v.off;
      // (a flipped coach has its BACK toward the head of the set)
      const lead = base + (flip ? BOGIE_B : BOGIE_F);
      const pf = poseAt(R, t.s - t.dir * lead, v.segF);
      const fx = pf.x, fy = pf.y, fz = pf.z;
      v.segF = pf.seg;
      const pr = poseAt(R, t.s - t.dir * (lead + BOGIE_SPAN), v.segR);
      const rx = pr.x, ry = pr.y, rz = pr.z;
      v.segR = pr.seg;
      let dx = fx - rx, dz = fz - rz;
      const L = Math.hypot(dx, dz);
      if (L > 1e-4) { dx /= L; dz /= L; }
      else { dx = 0; dz = -1; }
      // heading 0 faces −z, so a mesh moving along (dx,dz) is yawed like this;
      // a flipped consist is being PUSHED, so its vehicles face the other way
      let h = Math.atan2(-dx, -dz);
      if (flip) h += Math.PI;
      v.mesh.position.set((fx + rx) / 2, (fy + ry) / 2, (fz + rz) / 2);
      v.mesh.rotation.y = h;
      // cant: lean INTO the curve (unlike the cars, which roll outward on
      // their suspension) by the rate the heading is turning × speed
      if (dt > 0) {
        const rate = v.hasH ? angWrap(h - v.prevH) / dt : 0;
        const tgt = clamp(rate * t.speed * 0.012, -0.055, 0.055);
        v.roll += (tgt - v.roll) * Math.min(1, 4 * dt);
        v.body.rotation.z = v.roll;
      }
      v.prevH = h; v.hasH = true;
      const m = v.mesh.position;
      frameAt(m.x, m.y, m.z, h, v.coach.first, v.coach.last, COACH.mid, COACH.rise, v.frame);
      v.coach.lod(Math.hypot(m.x - this._fx, m.z - this._fz));
      if (i === 0) {                       // the loco is the train's own pose
        t.x = v.mesh.position.x; t.y = v.mesh.position.y; t.z = v.mesh.position.z;
        // …but t.heading is where the TRAIN is going, not which way the loco
        // faces: on a flipped set the two differ by π and a chase camera that
        // believed the loco would spend the ride staring at the track behind.
        t.heading = flip ? angWrap(h + Math.PI) : h;
      }
    }
    // a train tearing past at 144 km/h has to be heard even from the pavement
    t._passT -= dt;
    if (t !== this.riding && t._passT <= 0 && t.speed > PASS_V
      && Math.hypot(t.x - this._fx, t.z - this._fz) < PASS_R) {
      t._passT = 6;
      if (this.storyPass) this.storyPass();
      else sfx('train_pass', 0.6);
    }
  }

  // ---- riding ------------------------------------------------------------

  /**
   * The nearest HALTED train whose body comes within r of (x, z) — a stopped
   * train only, because stepping into a moving one is not boarding. Distance
   * is measured to each carriage's bogie chord, so any door along a 130 m set
   * is a valid place to get on.
   */
  nearestBoardable(x, z, r) {
    let best = null, bd = r;
    for (const t of this.trains) {
      if (!t.halted) continue;
      for (const v of t.cars) {
        const m = v.mesh.position;
        const hx = -Math.sin(v.mesh.rotation.y) * (v.len / 2 - 0.5);
        const hz = -Math.cos(v.mesh.rotation.y) * (v.len / 2 - 0.5);
        const d = distPointToSegment(x, z, m.x - hx, m.z - hz, m.x + hx, m.z + hz, _seg);
        if (d < bd) { bd = d; best = t; }
      }
    }
    return best;
  }
}

// boarding by the door, the ride, the seat: js/trainride.js
installRide(Trains, VMAX);
