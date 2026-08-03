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
    && (node._nyOk || node._nyL === (terrain._loads ?? 0))) return node._ny;
  node._nyT = terrain;
  // recursion guard: bridgeClearance below can wander back into this very
  // node via an approach road's pins — mid-computation reads must take the
  // provisional value, so the cache gate is satisfied UNTIL the real answer
  // (and the real readiness) replace it at the end
  node._nyOk = true;
  node._ny = terrain.heightAt(node.x, node.z);
  let a = 0, n = 0, allReady = true;
  for (const arm of node.arms) {
    const prof = levelWay(arm.r, terrain, null);
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
  for (const arm of node.arms) {
    if (!arm.r.br) continue;
    const need = bridgeClearance(arm.r, terrain);
    if (need !== null && need > node._ny) { node._ny = need; node._hard = true; }
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

export function roadProfile(way, terrain) {
  if (!terrain || !way?.p || way.p.length < 2) return null;
  const c = way._prof;
  if (c && c.terrain === terrain
    && (c.ready || c.loads === (terrain._loads ?? 0))) return c;
  const prof = levelWay(way, terrain, way._pins ?? null);
  // Terrain answers with a guess while a height tile is still on the way.
  // The guess used to be thrown away — which meant the 24-pass levelling ran
  // AGAIN for every roadGradeY call on an unready way: the whole boot was
  // re-levelling the same roads thousands of times per second. So the guess
  // is cached like any answer, stamped with the terrain load counter; the
  // next height tile retires it, readiness makes it final, and terrain.missed
  // still flags the chunk to rebuild.
  if (prof) {
    prof.loads = terrain._loads ?? 0;
    way._prof = prof;
    if (!prof.ready) terrain.missed = true;
  }
  return prof;
}

/**
 * Level one way, with or without its junction pins. Called twice per way: once
 * unpinned so the nodes can agree on a height, once pinned to those.
 */
function levelWay(way, terrain, pinList) {
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
      const h = terrain.heightAt(x + dx * o, z + dz * o);
      if (h > hi) hi = h;
    }
    top[i] = hi;
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
    lo[i] = Math.min(top[i] - GRADE_CUT, hi[i]);
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
  if (pinList?.length) {
    const idx = pinList.map((pin) => Math.max(0, Math.min(n - 1, Math.round(pin.s / ds))));
    const order = idx.map((_, k) => k).sort((p, q) => idx[p] - idx[q]);
    const reach = Math.max(1, Math.round(PIN_TAPER / ds));
    for (let o = 0; o < order.length; o++) {
      const k = order[o], i = idx[k], node = pinList[k].node;
      const d = junctionY(node, terrain) - y[i];
      if (!Number.isFinite(d) || Math.abs(d) < 1e-4) continue;
      // A HARD pin is a bridge abutment: the deck has to clear a railway, so
      // this road is the embankment that gets it up there. It may therefore
      // break the fill cap — the cap exists to stop the levelling INVENTING an
      // embankment, and this one is not invented, it is holding up a bridge —
      // and it takes as long as a road climbing at BRIDGE_GRADE needs.
      const hard = node._hard === true;
      const rise = Math.abs(d);
      const span = hard ? Math.max(reach, Math.round(rise / BRIDGE_GRADE / ds)) : reach;
      // never reach past a neighbouring pin, or past the end of the road
      const prev = o > 0 ? idx[order[o - 1]] : -Infinity;
      const next = o < order.length - 1 ? idx[order[o + 1]] : Infinity;
      const back = Math.min(span, i, Math.floor((i - prev) / 2));
      const fwd = Math.min(span, n - 1 - i, Math.floor((next - i) / 2));
      for (let j = -back; j <= fwd; j++) {
        const w = j === 0 ? 1
          : 0.5 + 0.5 * Math.cos(Math.PI * Math.min(1, Math.abs(j) / (j < 0 ? back : fwd)));
        const v = y[i + j] + d * w;
        const cap = hard ? ground[i + j] + BRIDGE_FILL : hi[i + j];
        y[i + j] = v < lo[i + j] ? lo[i + j] : v > cap ? cap : v;
      }
    }
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
        const y = link && roadGradeY(link.road, link.at, terrain);
        if (y !== null && y !== undefined) return y;
        const p = w.p[end === 0 ? 0 : w.p.length - 1];
        return terrain.heightAt(p[0], p[1]);
      };
      const A = anchor(ch.headWay, ch.headEnd === 0 ? 0 : 1);
      const B = anchor(ch.tailWay, ch.tailEnd === 0 ? 0 : 1);
      const cones = [];
      let samplesReady = true;
      const rdy = (x, z) => { if (terrain.ready && !terrain.ready(x, z)) samplesReady = false; };
      for (const m of ch.members) {
        for (const c of m._cross ?? []) {
          // arclength of the crossing along the chain
          let along = 0, sAt = 0, bestD = Infinity;
          for (let k = 0; k < m.p.length - 1; k++) {
            const [ax, az] = m.p[k], [bx, bz] = m.p[k + 1];
            const dx = bx - ax, dz = bz - az;
            const L2 = dx * dx + dz * dz || 1e-9;
            let t = ((c.x - ax) * dx + (c.z - az) * dz) / L2;
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const px2 = ax + dx * t, pz2 = az + dz * t;
            const d2 = (c.x - px2) ** 2 + (c.z - pz2) ** 2;
            const seg = Math.sqrt(L2);
            if (d2 < bestD) { bestD = d2; sAt = along + seg * t; }
            along += seg;
          }
          const mLen = m._len ?? polylineLength(m.p);
          const local = m._chainRev ? mLen - sAt : sAt;
          rdy(c.x, c.z);
          cones.push([m._chainOff + local, terrain.heightAt(c.x, c.z) + c.clear, 1]);
        }
      }
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
            cones.push([m._chainOff + local, terrain.heightAt(fx2, fz2) + FLOOR, 0]);
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
      const STEEP = 0.2;
      for (const c of cones) {
        const [cs, , hard] = c;
        let g = BRIDGE_GRADE;
        if (hard) {
          g = Math.max(g, (c[1] - A) / Math.max(cs, 1e-6),
            (c[1] - B) / Math.max(ch.total - cs, 1e-6));
          if (g > STEEP) g = STEEP;
        }
        const cap = Math.min(A + cs * g, B + (ch.total - cs) * g);
        if (c[1] > cap) c[1] = cap;
        c[2] = g;
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
    for (const [cs, cy, cg] of prof.cones) {
      const v = cy - Math.abs(s - cs) * cg;
      if (v > y) y = v;
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
    const rampFor = (rise) => (foot
      ? Math.min(total * 0.3, Math.max(3, Math.abs(rise) / 0.5))
      : Math.min(total * 0.4, Math.max(BRIDGE_RAMP, Math.abs(rise) / BRIDGE_GRADE)));
    profile = { terrain, start, end, deck,
      r0: rampFor(deck - start), r1: rampFor(deck - end) };
    // A foot RAMP is a ramp along its whole length. The spiral serving the
    // Pardubice footbridge connects the ground to the deck five metres up, and
    // the flat-middle model made it jump in its first metres and then run
    // LEVEL round the loop, wrapped in a parapet falling all the way to the
    // ground — the tall black C. When a foot way's two ends differ by more
    // than a storey's worth, the whole way IS the climb.
    if (foot && Math.abs(end - start) > 1.5) profile.linear = true;
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
export function indexJunctions(roads) {
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
    if (e.arms.length < J_MIN_ARMS) continue;
    // the pad has to clear the widest road that meets here
    let wMax = 0;
    for (const a of e.arms) wMax = Math.max(wMax, (a.r.w ?? 3) / 2);
    e.pad = wMax + 0.6;
    e.padR = Math.hypot(e.pad, wMax) + 0.1;  // bounding radius of the hull corners
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

  // ---- CLUSTERS: several nodes, one real crossing ------------------------
  // A dual carriageway crossing a dual carriageway is FOUR nodes a few
  // metres apart, and four separate pads leave slivers of ground, mismatched
  // shades and orphaned paint between them — the "bordel" at náměstí Jana
  // Pernera. Two nodes joined by a SHORT stretch of the same way (the link
  // between carriageways) belong to one crossing; union-find over the pin
  // lists gives the components, and each multi-node component becomes one
  // CLUSTER that meshes draws (and physics stands on) as a single surface.
  const CLUSTER_LINK = 32;
  const find = (n) => { while (n._cRoot && n._cRoot !== n) n = n._cRoot; return n; };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) rb._cRoot = ra;
    a._cRoot ??= ra; b._cRoot ??= ra;
  };
  for (const r of roads) {
    if (!r._pins || r._pins.length < 2) continue;
    const ps = [...r._pins].sort((p1, p2) => p1.s - p2.s);
    for (let i = 0; i < ps.length - 1; i++) {
      if (ps[i + 1].s - ps[i].s < CLUSTER_LINK
        && ps[i].node.pad !== undefined && ps[i + 1].node.pad !== undefined) {
        union(ps[i].node, ps[i + 1].node);
      }
    }
  }
  const groups = new Map();
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
  }
  // the union-find marks are scoped to THIS call — a later tile must not see
  // half-built roots on nodes it never touched
  for (const list2 of JUNCTIONS.values()) for (const e of list2) delete e._cRoot;
}

/** Junction clusters, bucketed like the pads. */
export function clustersIn(chunkK) { return CLUSTERS.get(chunkK) ?? null; }

/** The cluster's one footprint: convex hull of every member's hull points. */
export function clusterHull(cl) {
  if (cl._ring !== undefined) return cl._ring;
  const pts = [];
  for (const m of cl.members) {
    const r = junctionHull(m);
    if (r) pts.push(...r);
  }
  return (cl._ring = pts.length >= 3 ? convexHull(pts) : null);
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
  for (const r of roads) if (!r.br && r.p?.length > 1) put(r, clearanceOver(r));

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
  for (const b of bridges) {
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
 * The pad's FOOTPRINT: convex hull of the arm mouths — two cross-section
 * corners per arm at the pad radius, both directions for a through-road.
 * Cached on the node; meshes.js draws this ring and city.js stands on it,
 * so the two can never disagree about where the pad ends.
 */
export function junctionHull(node) {
  if (node._hullRing !== undefined) return node._hullRing;
  const pts = [];
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
  return (node._hullRing = pts.length >= 3 ? convexHull(pts) : null);
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
  let best = Infinity, gy = null;
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
    }
  }
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
const CLUSTERS = new Map();

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
      if (!cell) index.set(key, cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [], signs: [], crossings: [] });
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
  for (const r of rails) r.p = smoothBends(r.p, r.br);
  indexJunctions(roads);
  indexBridgeCrossings(roads, rails);
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
  // road signs — typed {p:[x,z], k:'give_way'|'stop'|'priority'}; wrapped like
  // trees so bucketize can hand each chunk its own posts
  const signs = (data.signs ?? []).map((g) => ({ p: [g.p], k: g.k, _id: ++next }));
  bucketize(city.chunkIndex, signs, 'signs', touched);
  // pedestrian crossings — bare [x,z] zebra points on the way
  const crossings = (data.crossings ?? []).map((c) => ({ p: [c], _id: ++next }));
  bucketize(city.chunkIndex, crossings, 'crossings', touched);
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
