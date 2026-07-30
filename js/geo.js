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

import { CHUNK, BRIDGE_Y, BRIDGE_RAMP } from './config.js';

// how far ahead of the focus a tile starts loading. View streams ±600 m, so
// 2600 m of headroom means even 130 km/h driving gives a fetch ~55 s before
// its chunks could enter view — tiles are indexed long before they're seen.
const TILE_REACH = 2600;
// …and how far behind it gives its buildings back. The world reaches Prague
// now: driving the D11 end to end crosses ~50 tiles, and holding every
// building of every one of them would be about a gigabyte of live objects on a
// machine that also has to render. So a tile that falls this far behind goes
// SLIM — its buildings and trees are dropped and re-fetched if you come back,
// while its roads, rails, water and green stay resident forever because the
// world map draws them, the traffic graph is built from them, and they are a
// third of the weight for all of the memory of where you have been.
const EVICT_REACH = 9000;
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
const GRADE_MAX = 0.075;    // 7.5 % — the steepest a Czech road holds for long
const GRADE_DS = 5;         // m between profile samples
const GRADE_FILL = 9;       // m of embankment we are willing to invent. Six was
                            // not enough: measured over real height maps, the cap
                            // bound inside ordinary Polabí dells and handed the
                            // grade guarantee back (a 55 % slope came out 44 %).
                            // At nine the guarantee holds everywhere flat country
                            // is flat — and gives way in the Zlín hills, where a
                            // steep road is not an artefact, it is the hill.
export function roadProfile(way, terrain) {
  if (!terrain || !way?.p || way.p.length < 2) return null;
  if (way._prof && way._prof.terrain === terrain) return way._prof;
  const total = way._len ?? polylineLength(way.p);
  if (total < GRADE_DS * 2) return null;
  const n = Math.ceil(total / GRADE_DS) + 1;
  const ds = total / (n - 1);
  const y = new Float32Array(n);
  const gx = new Float32Array(n), gz = new Float32Array(n);
  let ready = true;
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
    y[i] = terrain.heightAt(x, z);
  }
  const ground = Float32Array.from(y);
  const drop = GRADE_MAX * ds;
  // The fill cap belongs INSIDE the passes, not after them. Clamping a finished
  // envelope puts a clamped sample next to an unclamped one and hands back the
  // step the envelope had just removed — measured over the Zlín hills, a 77 %
  // slope came out at 75.7 %, i.e. the grading had achieved nothing there.
  // Capping as it propagates degrades gracefully instead: the grade holds
  // wherever a GRADE_FILL embankment can hold it, and beyond that the road
  // follows the hill, which in genuinely steep country is the right answer —
  // the alternative is inventing a viaduct out of a grade rule.
  const ceil = (i) => ground[i] + GRADE_FILL;
  for (let i = 1; i < n; i++) {
    const want = y[i - 1] - drop;
    if (y[i] < want) y[i] = Math.min(want, ceil(i));
  }
  for (let i = n - 2; i >= 0; i--) {
    const want = y[i + 1] - drop;
    if (y[i] < want) y[i] = Math.min(want, ceil(i));
  }
  for (let i = 0; i < n; i++) if (y[i] < ground[i]) y[i] = ground[i];  // fill, never cut
  const prof = { terrain, ds, n, y, ground, gx, gz, total };
  if (ready) way._prof = prof;
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
  return prof.y[i] + (prof.y[i + 1] - prof.y[i]) * f;
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
const BRIDGE_GRADE = GRADE_MAX;
export function bridgeDeckHeight(way, dist, terrain) {
  const total = way?._len ?? polylineLength(way?.p ?? []);
  if (!terrain || !way?.p?.length) return bridgeElevation(dist, total);

  let profile = way._bridgeProfile;
  if (!profile || profile.terrain !== terrain) {
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
    const reach = (link, fb) => {
      const y = link && roadGradeY(link.road, link.at, terrain);
      return y === null || y === undefined ? terrain.heightAt(fb[0], fb[1]) : y;
    };
    const first = way.p[0], last = way.p[way.p.length - 1];
    const start = reach(way._ap0, first);
    const end = reach(way._ap1, last);
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
    const deck = Math.max(start, end);
    const rampFor = (rise) => Math.min(total * 0.4,
      Math.max(BRIDGE_RAMP, Math.abs(rise) / BRIDGE_GRADE));
    profile = { terrain, start, end, deck,
      r0: rampFor(deck - start), r1: rampFor(deck - end) };
    // Terrain answers 0 while a height tile is still on the way. Remember the
    // profile only after both approaches are authoritative; the arriving tile
    // then rebuilds the chunk and gets a fresh, correct level.
    const ready = !terrain.ready
      || (terrain.ready(first[0], first[1]) && terrain.ready(last[0], last[1]));
    if (ready) way._bridgeProfile = profile;
  }

  const d = Math.max(0, Math.min(total, dist));
  if (d < profile.r0 && profile.r0 > 0) {
    return profile.start + (profile.deck - profile.start) * (d / profile.r0);
  }
  const back = total - d;
  if (back < profile.r1 && profile.r1 > 0) {
    return profile.end + (profile.deck - profile.end) * (back / profile.r1);
  }
  return profile.deck;
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
const J_MAX_TRIM = 0.35;    // never eat more than this fraction of a short road
function indexJunctions(roads) {
  const at = new Map();
  for (const r of roads) {
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
    }
    if (e.arms.length < J_MIN_ARMS) continue;
    // the pad has to clear the widest road that meets here
    let wMax = 0;
    for (const a of e.arms) wMax = Math.max(wMax, (a.r.w ?? 3) / 2);
    e.pad = wMax + 0.6;
    for (const a of e.arms) {
      if (!a.end) continue;                       // a through-road runs straight on
      const trim = Math.min(e.pad, a.r._len * J_MAX_TRIM);
      if (trim < 0.4) continue;
      if (a.i === 0) a.r._j0 = Math.max(a.r._j0 ?? 0, trim);
      else a.r._j1 = Math.max(a.r._j1 ?? 0, trim);
    }
    // Bucketed by the chunk that holds the CENTRE, so a junction straddling a
    // chunk border is drawn once. A chunk build then costs one map lookup
    // rather than a scan of every junction in the world.
    const k = chunkKey(e.x, e.z);
    let list = JUNCTIONS.get(k);
    if (!list) JUNCTIONS.set(k, list = []);
    if (!list.some((o) => o.x === e.x && o.z === e.z)) list.push(e);
  }
}

/** Junction pads, bucketed by chunk key. meshes.js asks for its own. */
export const JUNCTIONS = new Map();
export function junctionsIn(chunkK) { return JUNCTIONS.get(chunkK) ?? null; }

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

function bucketize(index, list, kind, touched) {
  for (const f of list) {
    const ring = forEachCellOf(f, (key) => {
      let cell = index.get(key);
      if (!cell) index.set(key, cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
      cell[kind].push(f);
      touched?.add(key);
    });
    f._home = chunkKey(ring[0][0], ring[0][1]); // rendered once, here
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
// roads and polygons never left, so re-indexing them would double them.
function indexPayload(city, data, touched, slot = 0, heavyOnly = false) {
  let next = slot * IDS_PER_TILE;
  const stamp = (list) => { for (const f of list ?? []) f._id = ++next; return list ?? []; };
  const buildings = stamp(data.buildings);
  // trees are bare [x,z] pairs — wrap so they can carry _home/_id like the rest
  const trees = (data.trees ?? []).map(t => ({ p: [t], _id: ++next }));
  bucketize(city.chunkIndex, buildings, 'buildings', touched);
  bucketize(city.chunkIndex, trees, 'trees', touched);
  appendAll(city.buildings, buildings);
  appendAll(city.trees, trees);
  const heavy = { buildings, trees };
  if (heavyOnly) return { roads: [], signals: [], heavy };

  // ids for the resident layers continue past the heavy ones in the same slot
  const roads = stamp(data.roads), rails = stamp(data.rails),
    water = stamp(data.water), green = stamp(data.green), paved = stamp(data.paved);
  for (const r of roads) { r.p = smoothBends(r.p, r.br); r._len = polylineLength(r.p); }
  indexJunctions(roads);
  for (const r of rails) r.p = smoothBends(r.p, r.br);
  bucketize(city.chunkIndex, roads, 'roads', touched);
  bucketize(city.chunkIndex, rails, 'rails', touched);
  bucketize(city.chunkIndex, water, 'water', touched);
  bucketize(city.chunkIndex, green, 'green', touched);
  bucketize(city.chunkIndex, paved, 'paved', touched);
  appendAll(city.roads, roads);
  appendAll(city.rails, rails);
  appendAll(city.water, water);
  appendAll(city.green, green);
  appendAll(city.paved, paved);
  appendAll(city.waterways, data.waterways ?? []); // not bucketized — minimap-only
  appendAll(city.pois, data.pois ?? []);           // not bucketized — HUD/labels
  const signals = data.signals ?? [];              // [[x,z],…] — traffic lights v3
  appendAll(city.signals, signals);
  return { roads, signals, heavy };
}

const _resolved = Promise.resolve(); // ensureTiles' no-work answer, allocated once

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
    buildings: [], roads: [], rails: [], water: [], waterways: [],
    green: [], paved: [], trees: [], pois: [], signals: [],
    chunkIndex: new Map(), _nextId: 1,
  };
  // tile-arrival listeners: cb({roads, signals, tx, tz, cells}) fires AFTER a
  // tile is indexed — roads/signals are that tile's slices (with _id/_len),
  // cells the chunk keys that gained features. Legacy mode registers fine and
  // simply never fires (everything is already there).
  const listeners = [], unloadListeners = [];
  city.onTileLoaded = (cb) => { listeners.push(cb); };
  // …and the other direction: cb({cells}) after a tile went slim, so built
  // chunk groups holding its buildings can be dropped.
  city.onTileUnloaded = (cb) => { unloadListeners.push(cb); };
  // A building the player has wrecked must not be evicted out from under the
  // wreck; interiors installs this guard.
  city.keepAlive = null;

  if (!data.tiles) { // legacy single-city file — index it all right now
    indexPayload(city, data);
    city.ensureTiles = () => _resolved; // uniform API: city.js calls this blindly
    return city;
  }

  // ---- manifest mode: the world starts empty and streams in ----
  const T = data.tile;
  // state: 0 idle / 1 loading / 2 indexed / 3 slim (buildings + trees evicted,
  // everything else still resident). A failed fetch rolls back to its previous
  // state so the next ensureTiles pass retries — the network hiccuped, or the
  // region download may still be filling the server; either way we self-heal.
  const tiles = data.tiles.map((t, i) => ({
    tx: t.tx, tz: t.tz, f: t.f, wb: t.wb,
    state: 0, slot: i + 1, heavy: null,
  }));
  // The world map needs the region's EXTENT before any of it has streamed —
  // fitting to the loaded arrays alone showed Pardubice and hid 400 villages.
  city.manifestTiles = tiles;
  // distance² from a point to a tile's rectangle (clamp-to-rect, then measure)
  const distSqTo = (t, x, z) => {
    const dx = Math.max(t.tx * T - x, 0, x - (t.tx + 1) * T);
    const dz = Math.max(t.tz * T - z, 0, z - (t.tz + 1) * T);
    return dx * dx + dz * dz;
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
      await indexGate();
      const touched = new Set();
      const { roads, signals, heavy } = indexPayload(city, payload, touched, t.slot, back === 3);
      t.heavy = heavy;
      t.state = 2;
      for (const cb of listeners) cb({ roads, signals, tx: t.tx, tz: t.tz, cells: touched });
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
      const gone = new Set(buildings);
      for (const f of trees) gone.add(f);
      const cells = new Set();
      for (const f of buildings) forEachCellOf(f, (k) => cells.add(k));
      for (const f of trees) forEachCellOf(f, (k) => cells.add(k));
      for (const key of cells) {
        const cell = city.chunkIndex.get(key);
        if (!cell) continue;
        cell.buildings = cell.buildings.filter(f => !gone.has(f));
        cell.trees = cell.trees.filter(f => !gone.has(f));
      }
      // in place — every consumer holds this array by reference, forever
      const compact = (arr) => {
        let w = 0;
        for (let i = 0; i < arr.length; i++) if (!gone.has(arr[i])) arr[w++] = arr[i];
        arr.length = w;
      };
      compact(city.buildings);
      compact(city.trees);
      t.heavy = null;
      t.state = 3;
      for (const cb of unloadListeners) cb({ tx: t.tx, tz: t.tz, cells });
      // ONE per call. Each eviction walks every cell the tile touched and then
      // compacts the whole (six-figure) building array, and a jet leaves half a
      // dozen tiles behind at once — doing them all in one tick is a freeze in
      // its own right. ensureTiles runs every second, so the backlog drains in
      // seconds and nothing is ever more than a tile or two over budget.
      return;
    }
  }
  return city;
}
