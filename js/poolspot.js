// ---- poolspot.js: WHERE street light and headlight lie on the road -------------
// No scene, no shader: numbers only. Read by js/lightpools.js, which draws
// them (the pool quads, the fans, the light maps), and by tests/poolspot.test.mjs.
//
// WHY ITS OWN FILE (20 Nov 2026). "To světlo jak kdyby sedí někde, kde tam
// není vůbec surface. A taky když tam jezdí auta: jsou jak kdyby ve vzduchu."
// On the ramp down to the railway underpass in Jana Palacha the pool of a lamp
// hung 1.1 to 1.3 m over the carriageway, a lit sheet in the air with the road
// falling away under it, and the fans of the cars coming over the top of the
// ramp stood up to a metre over the tarmac at their far ends. Two mistakes:
//
//   1. THE POOL ASKED THE HEIGHT GRID. It lay at the higher of the road and
//      "the ground + the layer ladder", and the ground was the 20 m grid. In a
//      cutting the grid arches back over the carriageway between its samples
//      (js/drawnground.js has the whole story), so the higher of the two was
//      ground that is not drawn. A pool lies on what IS drawn at its centre:
//      world.heightAt, the surface feet stand on (carriageway, pavement, path
//      slab, the ground clamped under every corridor), asked at the mast's own
//      level so a deck overhead is not it.
//   2. A FAN WAS A PLANE. One slope, read 13 m ahead, for a 36 m sheet of
//      light. A road is not a plane where its grade changes: over the top of a
//      ramp the far end of the plane is in the air, in the dip under a bridge
//      its middle is in the tarmac. The fan now FOLLOWS what it lies on:
//      three looks along the nose (13 m, the middle of the rest, the far
//      end), each asked at the height the last two say the surface will be,
//      and the fan is laid through them, straight from one to the next
//      (lightpools.js draws a strip and lifts it by beamBend, js/lampmap.js).
//      A look takes the carriageway, and where the nose has left it (a bend,
//      a junction) the pavement or the ground that is drawn there.

import { MAST_OUT, MAST_Y } from './streetlamps.js';
import { LEVEL_GAP, LEVEL_GRADE } from './levelsep.js';
import { mastTint } from './mastlamps.js';

// the lamps, as js/streetlamps.js builds them. A STREET column holds its LED
// head 1.8 m out over the carriageway (the mast's local -z) and 7.5 m up; a
// PARK lantern (p.kind === 'park') carries its light on its own axis, 4 m up,
// and throws a smaller round pool.
export const HEAD_OUT = 1.8, HEAD_Y = 7.5;
export const PARK_Y = 4.0, PARK_POOL = 8.5;
// The pool. A street luminaire at 7 m throws an oval: long along the road,
// shorter across it, and centred a few metres out from the kerb. Lamps stand
// 34 m apart, so 15 m of half-length leaves a visible dark neck between two
// pools, which is what makes a street read as a CHAIN of them.
export const POOL_LONG = 17, POOL_WIDE = 13, POOL_OUT = 3.4;
// A motorway mast (js/mastlamps.js, kinds 'mast' and 'mast1'): heads at 12 m
// on 3 m arms spread wider and longer pools, 40 m apart, centred past the
// head over the carriageway. A two-armed mast throws one pool per arm.
export const MAST_LONG = 24, MAST_WIDE = 17, MAST_POOL_OUT = MAST_OUT + 2.0;
// Direct path only: height of the quads above the road surface. They have to
// clear the lane paint and any kerb or raised pavement (KERB_H 0.12 plus the
// paving), and a quad cannot follow a kerb.
export const LIFT = 0.17;
// A pool on a bridge. The quad is 26 m across and a deck is 9: left alone, eight
// metres of lit sheet hung in the air past each parapet, over the valley (and
// on the light map its height took the street below out of its own lamps'
// light). A pool whose road stands more than DECK_UP over the bare ground is
// measured against the deck: the surface is probed across the road in
// DECK_STEP strides until it falls DECK_DROP away, and the quad is fitted
// between the two edges.
const DECK_UP = 1.0, DECK_DROP = 1.2, DECK_STEP = 0.5;
// city.js surfaceY answers "road" out to 0.35 m past the carriageway (a wheel
// just off the kerb), and the edge lies somewhere inside the last stride:
// taken at its near end, so the quad never reaches past the deck
const DECK_TRIM = 0.35 + DECK_STEP;
// Two kinds of lighting, by district rather than by lamp (a street does not
// alternate): high-pressure sodium, the orange of every Czech housing estate,
// and the warm-white LED that has been replacing it.
const DISTRICT = 260;             // m: the size of a "same lamps" block
const LED_SHARE = 0.34;
// Headlight fans. Dipped beams reach about 35 m and are as wide as the road.
export const BEAM_LEN = 36, BEAM_WIDE = 7.5, BEAM_NOSE = 1.9;
// The fan's pitch is read off the road this far ahead of the car: where most
// of the light lands, and near enough to still be on the deck round a bend.
export const BEAM_AHEAD = 13;
// The road, followed past that first look: once more half way to the fan's
// far end, and at the far end. BEAM_T1 and BEAM_T2 are where the first two
// looks lie along the fan (0 at its near end, 1 at its far end): its nodes.
const BEAM_FAR = BEAM_NOSE + BEAM_LEN, BEAM_MID = (BEAM_AHEAD + BEAM_FAR) / 2;
export const BEAM_T1 = (BEAM_AHEAD - BEAM_NOSE) / BEAM_LEN, BEAM_T2 = (BEAM_MID - BEAM_NOSE) / BEAM_LEN;
// What a look may find and still be what the fan lies on. surfaceY offers the
// highest sheet not more than SNAP_UP (1.5 m, js/city.js) over the height it
// is asked at, and where there is none the lowest one over that: a deck
// overhead. So a surface further over the line than UP_MAX is not the road
// climbing (between two looks 12 m apart a road steepens by a metre at the
// very most), it is another road, a terrace, a wall; and one further under it
// than two things on one level ever are (js/levelsep.js) is the street under
// the deck's end, the valley under a bridge.
const UP_MAX = 1.0;
// A road is no steeper than this (K Bateriím in Prague climbs one in four),
// and a rise that IS steeper than one in five counts as road only when the
// point half way to it lies on the same line: a ramp, not a step.
const GRADE_MAX = 0.4, GRADE_SURE = 0.2, RAMP_TRUE = 0.3;

// deterministic, allocation-free hash of two integers to 0..1
function hash2(i, j) {
  let h = Math.imul(i | 0, 374761393) ^ Math.imul(j | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Everything about one mast's pool that does not change while it stands.
 * A two-armed motorway mast gets a second record, `twin`, for its back arm.
 * `p`: the registry's record (js/poles.js: x, y, z, i, kind, posts).
 */
export function poolSpot(p, world) {
  const rot = p.posts.userData?.spots?.[p.i * 3 + 2] ?? 0;
  if (p.kind === 'mast' || p.kind === 'mast1') {
    const tint = mastTint(p.x, p.z);
    const s = pool(p, world, rot, 'mast', tint);
    if (p.kind === 'mast') s.twin = pool(p, world, rot + Math.PI, 'mast', tint);
    return s;
  }
  return pool(p, world, rot, p.kind === 'park' ? 'park' : 'street', null);
}

// one pool under one head of mast p, whose arm points along heading `rot`
function pool(p, world, rot, kind, tint) {
  // The mast's local axes in the world (a Y rotation by rot): +x runs ALONG
  // the kerb, and −z points at the carriageway it was placed beside (rot is a
  // heading, and a heading's forward is −z).
  const ax = Math.cos(rot), az = -Math.sin(rot);        // along the road
  const rx = -Math.sin(rot), rz = -Math.cos(rot);       // toward the road
  const park = kind === 'park', mast = kind === 'mast';
  const out = park ? 0 : mast ? MAST_POOL_OUT : POOL_OUT, ho = park ? 0 : mast ? MAST_OUT : HEAD_OUT;
  const wide = mast ? MAST_WIDE : POOL_WIDE;
  let x = p.x + rx * out, z = p.z + rz * out;
  // surfaceY hands back ONE reused object: take the number, not the object.
  // It is told where the mast's foot is (p.y), so a lamp on the street UNDER
  // a viaduct lights the street and not the deck over its head.
  const ground = world.terrain?.heightAt?.(x, z) ?? p.y;
  const sf = world.surfaceY?.(x, z, p.y);
  const y0 = sf?.y ?? ground;
  let yc = y0, sealed = !!sf?.road;         // the surface at the pool's CENTRE (it may move, below)
  let pw = park ? PARK_POOL : wide;
  if (!park && world.surfaceY && y0 - ground > DECK_UP) {
    const a = deckEdge(world, x, z, rx, rz, y0), b = deckEdge(world, x, z, -rx, -rz, y0);
    if (a + b < 2 * POOL_WIDE) {
      // between the two edges, so the window (lampmap.js poolShape) is zero
      // where the deck ends. Where only one side falls away (a street cut
      // into a slope) the pool moves over no further than it already hangs
      // out from its mast, and gives up the width instead.
      const sh = Math.max(-POOL_OUT, Math.min(POOL_OUT, (a - b) / 2));
      x += rx * sh; z += rz * sh;
      pw = Math.max(1, Math.min(a - sh, b + sh));
      // ...and it lies on what is THERE. Where decks of two heights run side
      // by side (a tram's beside the carriageway's on Čechův most) the centre
      // moved onto the other one and kept the first one's height, 1.2 m under
      // the asphalt it was meant to light.
      if (sh !== 0) { const q = world.surfaceY(x, z, y0); yc = q.y; sealed = q.road; }
    }
  }
  const y1 = world.surfaceY?.(x + ax * 8, z + az * 8, yc)?.y ?? yc;
  const y2 = world.surfaceY?.(x - ax * 8, z - az * 8, yc)?.y ?? yc;
  // a graded road or a bridge ramp tilts the pool with it; a sample that fell
  // off the road onto a bank (more than a metre away in height) is ignored
  const slope = (Math.abs(y1 - yc) < 1.2 && Math.abs(y2 - yc) < 1.2) ? (y1 - y2) / 16 : 0;
  const cellI = Math.floor(p.x / DISTRICT), cellJ = Math.floor(p.z / DISTRICT);
  return {
    x, z, ax, az, slope,
    y: poolLevel(world, x, z, p.y, yc, ground, sealed),
    // the head hangs TOWARD the road (it used to be drawn along the kerb)
    hx: p.x + rx * ho, hy: p.y + (park ? PARK_Y : mast ? MAST_Y : HEAD_Y) - 0.12, hz: p.z + rz * ho,
    pl: park ? PARK_POOL : mast ? MAST_LONG : POOL_LONG, pw,
    led: hash2(cellI, cellJ) < LED_SHARE, tint,
    var: 0.88 + 0.24 * hash2(Math.round(p.x * 10), Math.round(p.z * 10)),
    twin: null,
  };
}

/**
 * The height a pool's quad lies at: LIFT over the surface that is DRAWN at
 * (x, z), at the level of the mast's foot `foot`. `y0`: what surfaceY said
 * there, `sealed`: its road flag (a carriageway, a pad, a car park, a deck's
 * asphalt), `ground`: the grid.
 *
 * A world that can say what is drawn (city.js heightAt: the carriageway, the
 * pavement, a path's slab, the ground under every corridor's ceiling) is asked
 * that. The carriageway is in both answers. A car park or a square is only in
 * surfaceY's, a thin layer over the grid, and a deck's asphalt lies 20 cm over
 * what the feet are told: those count while they are within half a metre of
 * what is drawn (in a cutting the grid, and any layer on it, is not there).
 * A world that cannot (a fixture with surfaceY alone) gets the old rule: the
 * road where there is one, else the whole layer ladder over the bare ground.
 */
export function poolLevel(world, x, z, foot, y0, ground, sealed = true) {
  const drawn = world.heightAt ? world.heightAt(x, z, foot) : NaN;
  if (!Number.isFinite(drawn)) return Math.max(y0 + LIFT, ground + 0.20 + LIFT);
  return (sealed && y0 > drawn && y0 - drawn < 0.5 ? y0 : drawn) + LIFT;
}

// How far from (x, z) the deck at height y0 runs in the direction (ux, uz),
// POOL_WIDE at most: the last stride that was still on it.
function deckEdge(world, x, z, ux, uz, y0) {
  for (let d = DECK_STEP; d <= POOL_WIDE; d += DECK_STEP) {
    if (y0 - world.surfaceY(x + ux * d, z + uz * d, y0).y > DECK_DROP) return Math.max(0, d - DECK_TRIM);
  }
  return POOL_WIDE;
}

// The pitch of the road in front of a car standing at height carY: rise over
// run to the surface BEAM_AHEAD metres along its nose. `carY` tells surfaceY
// which of two stacked roads is meant, so a car on a bridge reads the deck.
// Where the look ahead lands beside the road (a bend, a T junction) it reads
// what is drawn there (the lie of the land, for a world that cannot say), and
// a car on a deck (nothing but air out there) keeps its fan level. Anything
// steeper than one in five is a drop, not a road, unless the point half way
// lies on the same line: then it is a street on a hillside.
export function beamSlope(world, x, z, fx, fz, carY) {
  return beamLie(world, x, z, fx, fz, carY, _lie).ahead;
}

const _lie = { ahead: 0, slope: 0, y0: 0, b1: 0, b2: 0 };
// What the light lands on at (x, z): the carriageway where there is one, else
// what is drawn there (the pavement, a path's slab, the ground:
// world.heightAt). `line` is where the looks before say the surface will be,
// `prev` what the last one found: the surface may lie anywhere from a step
// over the higher of the two (a hillside that flattens out is over the line,
// and not over the last look) down to one level under the lower. NaN where
// nothing is within that reach (a deck overhead, the valley under a bridge,
// a wall).
function litAt(world, x, z, line, prev = line) {
  const ask = line > prev ? line : prev;
  const hi = ask + UP_MAX, lo = (line < prev ? line : prev) - LEVEL_GAP;
  const q = world.surfaceY(x, z, ask);
  let y = q && q.road ? q.y : NaN;
  if (y <= hi && y >= lo) return y;
  if (!world.heightAt) return NaN;
  y = world.heightAt(x, z, ask);
  return y <= hi && y >= lo ? y : NaN;
}
/**
 * How a car's fan lies on what is in front of it. Into `out`:
 *   ahead  the pitch read BEAM_AHEAD m along the nose (beamSlope's number)
 *   slope  rise over run of the fan's chord, from its near end to its far end
 *   y0     the surface's height at the fan's NEAR end, over carY (the chord
 *          starts there, not at the car)
 *   b1,b2  how far the surface stands over (+) or under (-) that chord at
 *          the fan's two inner nodes (BEAM_T1, BEAM_T2); 0 and 0 for a plane
 * The surface is FOLLOWED: the look at BEAM_AHEAD, then one half way to the
 * far end and one at the far end, each asked where the last two say it will
 * be. A look takes the carriageway, and where the nose has left it (a bend, a
 * junction, a lay-by) what is drawn there instead: light lands on the
 * pavement and the lawn as well. Where both further looks find a surface the
 * fan is laid through all of them: over the top of a ramp, through the dip
 * under a bridge, out over the verge of a bend. Where one does not (the end
 * of a deck, another level, a wall) the fan is the plane it was.
 */
export function beamLie(world, x, z, fx, fz, carY, out = {}) {
  const terr = world?.terrain;
  const ax = x + fx * BEAM_AHEAD, az = z + fz * BEAM_AHEAD;
  let slope = 0, y1 = NaN, sealed = false;
  // (the first look takes what it always took: surfaceY hands a climbing
  // street back for want of anything lower, and the grade rule below is what
  // tells it from a deck)
  const s = world?.surfaceY?.(ax, az, carY);
  if (s?.road) { y1 = s.y; slope = (y1 - carY) / BEAM_AHEAD; sealed = true; }
  else if (world?.heightAt && world.surfaceY) {
    // beside the road: the ground that is drawn there, not the grid under it
    y1 = world.heightAt(ax, az, carY);
    slope = (y1 - carY) / BEAM_AHEAD;
  } else if (terr?.heightAt) {
    const here = terr.heightAt(x, z);
    if (carY - here < DECK_UP) slope = (terr.heightAt(ax, az) - here) / BEAM_AHEAD;
  }
  if (slope > GRADE_SURE || slope < -GRADE_SURE) {
    // steeper than one in five: a street on a hillside, or a drop.
    let ok = false;
    if (sealed) {
      // A street passes through the point half way; a deck or a terrace does not.
      if (slope <= GRADE_MAX && slope >= -GRADE_MAX) {
        const hy = litAt(world, x + fx * BEAM_AHEAD / 2, z + fz * BEAM_AHEAD / 2, carY + (y1 - carY) / 2);
        ok = Math.abs(hy - (carY + y1) / 2) <= RAMP_TRUE * Math.abs(y1 - carY);
      }
    } else {
      // Beside the road: the hillside falling away where the road ends or
      // turns is still where the light lands, as far down as one level
      // reaches (js/levelsep.js); the valley under a deck is not. Ground
      // RISING that fast is a wall.
      ok = y1 === y1 && slope < 0 && carY - y1 <= LEVEL_GAP + LEVEL_GRADE * BEAM_AHEAD;
    }
    if (!ok) { slope = 0; y1 = NaN; }
  }
  out.ahead = out.slope = slope; out.b1 = out.b2 = 0; out.y0 = slope * BEAM_NOSE;
  if (y1 !== y1) return out;
  const y2 = litAt(world, x + fx * BEAM_MID, z + fz * BEAM_MID, y1 + slope * (BEAM_MID - BEAM_AHEAD), y1);
  if (y2 !== y2) return flat(out);
  const g2 = (y2 - y1) / (BEAM_MID - BEAM_AHEAD);
  if (g2 > GRADE_MAX || g2 < -GRADE_MAX) return flat(out);
  // (a far end that does not bear the middle look out leaves the plane: one
  // look alone can be a sheet beside the road, and the fan run on along it
  // stood three metres in the air)
  const y3 = litAt(world, x + fx * BEAM_FAR, z + fz * BEAM_FAR, y2 + g2 * (BEAM_FAR - BEAM_MID), y2);
  if (y3 !== y3 || Math.abs(y3 - y2) > GRADE_MAX * (BEAM_FAR - BEAM_MID)) return flat(out);
  const near = carY + slope * BEAM_NOSE;
  const chord = (y3 - near) / BEAM_LEN;
  if (chord > GRADE_MAX || chord < -GRADE_MAX) return flat(out);
  out.slope = chord; out.y0 = near - carY;
  out.b1 = y1 - (near + chord * (BEAM_AHEAD - BEAM_NOSE));
  out.b2 = y2 - (near + chord * (BEAM_MID - BEAM_NOSE));
  return out;
}
// The plane a fan stays when the further looks do not bear the first one out.
// A pitch steeper than one in five was taken on trust that the surface goes
// on like that (a street on a hillside, the bank where a road ends); with
// nothing found further along it is one look, and 36 m of plane laid at that
// pitch ends eight metres under or over the road that turned away: level.
function flat(out) {
  if (out.slope > GRADE_SURE || out.slope < -GRADE_SURE) out.ahead = out.slope = out.y0 = 0;
  return out;
}

/** The fan's height over the car's own, `d` m along its nose (BEAM_NOSE to the far end), as it is drawn. */
export function fanHeight(lie, d) {
  const t = (d - BEAM_NOSE) / BEAM_LEN;
  const b = t < BEAM_T1 ? lie.b1 * t / BEAM_T1
    : t < BEAM_T2 ? lie.b1 + (lie.b2 - lie.b1) * (t - BEAM_T1) / (BEAM_T2 - BEAM_T1)
      : lie.b2 * (1 - t) / (1 - BEAM_T2);
  return lie.y0 + lie.slope * (d - BEAM_NOSE) + b;
}
