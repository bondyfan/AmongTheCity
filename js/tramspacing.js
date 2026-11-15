// ---- tramspacing.js: one tram on a piece of track at a time ---------------------
// Lines share track (Karlovo náměstí, Lazarská, Jindřišská, the embankment)
// and cross one another at the junctions, and their timetables
// (js/tramlines.js) know nothing of each other: by the timetable alone two
// trams can be due on the same metres of rail. Round 7 let the second one wait
// behind the first, decided from where they stood, and two trams that came
// into sight together (or met nose to nose where two rails converge) drove
// through each other while each waited for the other.
//
// THE RULE. A tram CLAIMS the rail under its body plus its braking distance
// ahead of the nose. A tram whose way ahead (braking distance plus a margin)
// is fouled by another's claim, anywhere a body would touch (FOUL between
// centrelines, so a junction diamond and the converging blades of a switch
// count as well as a shared track), waits short of it, unless the other one
// waits for it. When both foul each other's way, who goes first is decided by
// facts both co-op clients hold:
//   1. a tram whose BODY already stands in the other's way goes on (it is in
//      the junction, stopping there blocks it for both);
//   2. otherwise the one DUE there first by the timetable (dueAt: the shared
//      second its nose reaches the conflict, a pure function of route, trip
//      and arc) goes, and an exact tie goes by key.
// Waiting is local, like every hold (js/trams.js): it delays this screen's
// tram, never the shared timetable, and it is made up afterwards.
//
// A tram that COMES INTO BEING where another already stands (two trips that
// enter the scan in the same half second over shared track, a teleport, a
// line departing a terminus another line is still standing at) is set back
// behind the other's tail once, before it is drawn: the one moment a tram may
// move backwards, because nobody has seen it yet.

import { projectOnPath } from './realines.js';
import { BRAKE, pathAtExt, dueAt } from './tramlines.js';

export const FOUL = 2.4;       // m between centrelines at which two 2.46 m bodies touch
const STEP = 2;                // m between the points of a body tested (a body crossing at right angles is caught)
export const GAP = 4;          // m a waiting nose keeps short of the other's body
const CLAIM_PAD = 3;           // m of rail beyond its braking distance a moving tram claims
const LOOK_PAD = 14;           // m beyond its braking distance a tram looks for a claim in its way
const PLACE_BACK = 90;         // m behind a new tram's nose its rail is searched for a body in the way

const _pt = { x: 0, z: 0, dx: 0, dz: 0 }, _q = { d: 0, a: 0 };
const _w = { x: 0, z: 0, r: 0 }, _wo = { x: 0, z: 0, r: 0 };
const _f = { any: Infinity, body: Infinity }, _g = { any: Infinity, body: Infinity };

const claimOf = (t) => t.v * t.v / (2 * BRAKE) + CLAIM_PAD;
export const lookOf = (t) => t.v * t.v / (2 * BRAKE) + LOOK_PAD;

// The circle round me's rail between arcs lo and hi (an arc is never shorter
// than its chord, so every point of it is within half its length of the middle)
function windowOf(me, lo, hi, w) {
  pathAtExt(me.line.P, (lo + hi) / 2, _pt);
  w.x = _pt.x; w.z = _pt.z; w.r = (hi - lo) / 2 + FOUL;
  return w;
}

/**
 * Where tram `o` (body and, with `claim`, the rail it claims ahead) fouls
 * `me`'s rail between arcs lo and hi: res.any the first arc fouled by any of
 * it, res.body the first fouled by the body alone (Infinity: none). `w` is
 * windowOf(me, lo, hi): a point outside it fouls nothing and is not projected.
 */
export function fouls(o, me, lo, hi, claim, res, w = windowOf(me, lo, hi, _wo)) {
  res.any = Infinity; res.body = Infinity;
  const top = o.sr + (claim ? claimOf(o) : 0), tail = o.sr - o.len;
  // (all of o lies within this of its nose: nothing to do when that misses the window)
  const ext = Math.max(top - o.sr, o.len) + w.r;
  if ((o.x - w.x) ** 2 + (o.z - w.z) ** 2 > ext * ext) return res;
  const r2 = w.r * w.r;
  for (let a = top; ; a -= STEP) {
    const aa = a < tail ? tail : a;
    pathAtExt(o.line.P, aa, _pt);
    if ((_pt.x - w.x) ** 2 + (_pt.z - w.z) ** 2 > r2) { if (aa <= tail) break; continue; }
    projectOnPath(me.line.P, _pt.x, _pt.z, lo, hi, _q);
    if (_q.d < FOUL) {
      if (_q.a < res.any) res.any = _q.a;
      if (aa <= o.sr + 1e-6 && _q.a < res.body) res.body = _q.a;
    }
    if (aa <= tail) break;
  }
  return res;
}

// (cheap reject: nothing of o can reach me, from my tail to `look` past my nose)
const near = (me, o, look) => {
  const r = me.len + o.len + look + claimOf(o) + 6;
  return (o.x - me.x) ** 2 + (o.z - me.z) ** 2 < r * r;
};

/**
 * Does `me` go before `o` where each is in the other's way? `f` is where o
 * fouls me's way, `g` where me fouls o's (both from fouls(.., claim)).
 */
function goesFirst(me, o, f, g) {
  const meIn = g.body < Infinity, oIn = f.body < Infinity;
  if (meIn !== oIn) return meIn;
  // a new tram gives way to one that was there before it
  if (me.fresh !== o.fresh) return !me.fresh;
  const dm = me.k == null ? 0 : dueAt(me.line, me.k, f.any);
  const dO = o.k == null ? 0 : dueAt(o.line, o.k, g.any);
  if (dm !== dO) return dm < dO;
  return me.key < o.key;
}

/**
 * The arc `me`'s nose has to stay short of for the other trams in `list`
 * (Infinity: none). Never behind where it stands (that is standing still).
 */
export function spacingHold(me, list) {
  let hold = Infinity;
  const look = lookOf(me);
  const lo = me.sr - 0.5, hi = me.sr + look;
  windowOf(me, lo, hi, _w);
  for (const o of list) {
    if (o === me || !near(me, o, look)) continue;
    fouls(o, me, lo, hi, true, _f, _w);
    if (_f.any === Infinity) continue;
    fouls(me, o, o.sr - 0.5, o.sr + lookOf(o), true, _g);
    if (_g.any < Infinity && goesFirst(me, o, _f, _g)) continue;
    const h = _f.any - GAP;
    if (h < hold) hold = h;
  }
  return hold < me.sr ? me.sr : hold;
}

/**
 * A new tram (`me.fresh`) standing in another's body: the arc to set its nose
 * back to, behind every body it overlaps (a few passes, one body may push it
 * into the next), or me.sr when it is clear.
 */
export function placeNew(me, list) {
  let s = me.sr;
  const save = me.sr;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    for (const o of list) {
      if (o === me || o.fresh && o.key > me.key) continue;    // (two new ones: the first by key stays)
      // (me.x, me.z is where its nose came into being: a nose set back by
      // save - s is at most that much further from it, or a body it was
      // pushed onto is rejected here and the two stand in each other)
      if (!near(me, o, save - s)) continue;
      me.sr = s;
      // the other's body on my rail from my tail to just past my nose
      fouls(o, me, s - me.len - 1, s + 0.5, false, _f);
      if (_f.body === Infinity) continue;
      // …and where that body begins on my rail, searched further back
      fouls(o, me, s - me.len - o.len - PLACE_BACK, s + 0.5, false, _f);
      const to = _f.body - GAP;
      if (to < s) { s = to; moved = true; }
    }
    if (!moved) break;
  }
  me.sr = save;
  return s;
}
