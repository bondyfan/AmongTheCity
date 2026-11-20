// ---- footslab.js: the level a footway's slab is drawn at, for everyone ----------
// Pure: no three, no DOM, worker safe. Read by js/city.js (where feet stand,
// heightAt) and js/meshes.js (where a prop stands, standingOn; the cap on the
// ribbon's own blend, footPullW).
//
// WHY (20 Nov 2026). A footway is its own levelled strip, blended toward the
// carriageway it runs beside: the pavement level of a kerbed street, a touch
// under the asphalt of any other. The feet asked that in city._footPull and
// the props asked their own copy in meshes.standingOn, and the copy had
// drifted: it knew only kerbed streets, asked the pull under the prop instead
// of at the path's centreline, and picked the strongest pull BEFORE the cap.
// So a lamp on a riverside path under an embanked road (Povltavská) stood
// 1.8 m under the paving it was planted in, and one beside the path at the
// foot of Bubenské nábřeží stood 2.2 m over the ground at the street's level.
// One function now, so the paving, the feet on it and the lamp in it get the
// same number.

import { LAYER_Y } from './config.js';
import { roadGradeY, streetOf } from './geo.js';
import { vergeAt, vergeLift, bayAt, FOOT_LIFT, BAY_W } from './streets.js';
import { nearestSeg } from './roadsegments.js';
import { stampShaped } from './quayedge.js';

const VERGE_REACH = 10.5;                    // m past a kerbed street's edge its band still pulls (js/city.js)

// ---- how hard a street may pull a footway off its own level ---------------------
// The pull below (roadRibbon, and streetPull for the feet and the props) takes
// a footway to the level of the street it runs beside, and it asked only how
// FAR the street was, never how much higher or lower. Beside a street on an
// embankment that dragged the path up the full height of the fill, six metres
// out from the kerb: the cycleway under the flyover by Kaufland was drawn on a
// ramp 4.8 m over the ground it lies on, and 1.6 km of footway within 2.4 km
// of the spawn stood more than a metre off its own level.
//
// How much higher or lower can a path beside a street really be? A few steps
// from the kerb, hardly at all: no bank is steep enough, and what the path's
// own profile says there (PULL_SMEAR) is the survey's 20 m grid smearing the
// street's embankment across it. On the street's own band (the pavement, or
// the lawn it draws out to a mapped footway, `band` wide) the path is part of
// that surface by construction. Only a WALL puts a path right beside a kerb on
// another level: the abutment of a bridge, with the path passing under the
// deck, and that is more than PULL_WALL. Further out the path may just as
// well be at the foot of the bank, and its own levelled profile, which has the
// real earthworks in it, is what says which: PULL_FADE past the band the pull
// is whole only while street and path are within PULL_LEVEL of each other, and
// gone by PULL_OFF. Between the two distances the two answers are blended.
// (The lawn itself stops reaching for a footway more than a metre off the
// street's level: geo.levelVerge.) One function, because the paving and the
// feet on it have to get the same number.
const PULL_NEAR = 2.5, PULL_FADE = 2;        // m past the kerb line (or the asphalt edge)
const PULL_LEVEL = 0.5, PULL_OFF = 1.5;      // m between the street's level and the path's own
const PULL_SMEAR = 2, PULL_WALL = 3;         // …and the same right beside the kerb
/**
 * The weight `w` of a street's pull on a footway, capped: `dy` is the level it
 * pulls toward less the footway's own, `xo` the metres past its kerb line,
 * `band` the width of the street's own band there (0: no kerb).
 */
export function footPullW(w, dy, xo, band = 0) {
  const a = dy < 0 ? -dy : dy;
  if (a <= PULL_LEVEL) return w;
  const near = band + 0.3 > PULL_NEAR ? band + 0.3 : PULL_NEAR;
  const kn = a <= PULL_SMEAR ? 1 : a >= PULL_WALL ? 0 : (PULL_WALL - a) / (PULL_WALL - PULL_SMEAR);
  if (xo <= near) return w * kn;
  const kf = a >= PULL_OFF ? 0 : (PULL_OFF - a) / (PULL_OFF - PULL_LEVEL);
  const kx = xo >= near + PULL_FADE ? 0 : (near + PULL_FADE - xo) / PULL_FADE;
  return w * (kf + (kn - kf) * kx);
}

const bbOf = (f) => {
  if (f._sbb) return f._sbb;
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of f.p) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return (f._sbb = [a, b, c, d]);
};
const _near = { d: Infinity, e: 1 };

/**
 * The strongest pull of a carriageway on a footway whose centreline passes
 * (x, z), into `out` ({ w, t }: its weight and the level it pulls toward): the
 * pavement level of a kerbed street out to 6 m and fading over the next 4, a
 * touch under the asphalt of any other within 3.5 m. The same numbers, asked
 * at the same place, as meshes.roadRibbon blends each footway station with,
 * and capped by footPullW against `own`, the footway's own level there: a
 * street up on an embankment does not lift the path at the foot of it.
 */
export function streetPull(cell, x, z, own, terrain, out) {
  let upW = 0, upT = 0;
  // (a stair or ramp down to a Prague lower quay stands where its stamp
  // built it: pulled toward the street over the wall it floated 1.6 m over
  // its own foot. meshes.roadRibbon draws it the same way.)
  if (stampShaped(terrain, x, z)) { out.w = 0; out.t = own; return out; }
  for (const r of cell.roads) {
    if (!r.d || r.br || !r.p) continue;
    const vg = streetOf(r), half = r.w / 2;
    const reach = half + (vg ? VERGE_REACH + (r._bays ? BAY_W : 0) : 5);
    const bb = bbOf(r);
    if (x < bb[0] - reach || x > bb[2] + reach || z < bb[1] - reach || z > bb[3] + reach) continue;
    const bs = nearestSeg(r, x, z, reach, _near);
    const bd = _near.d, be = _near.e;
    if (bd >= reach) continue;
    const gy = roadGradeY(r, bs, terrain);
    if (gy === null || gy === undefined) continue;
    const bay = r._bays ? bayAt(r, bs, be) : 0;
    const xo = bd - half - bay;
    const v = vg ? vergeAt(r, bs, be > 0 ? 1 : 0) : null;
    if (v && v.u) {
      const t = gy + LAYER_Y.road + vergeLift(v.w, v.drop, xo) + FOOT_LIFT;
      const w = footPullW(xo <= 6 ? 1 : xo >= 10 ? 0 : 1 - (xo - 6) / 4, t - own, xo, v.w);
      if (w > upW) { upW = w; upT = t; }
    } else {
      const t = gy + LAYER_Y.road - 0.04;
      const w = footPullW(xo + bay <= 0 ? 1 : 1 - (xo + bay) / 3.5, t - own, xo + bay);
      if (w > upW) { upW = w; upT = t; }
    }
  }
  out.w = upW; out.t = upT;
  return out;
}

const _sp = { w: 0, t: 0 };
/** The level a footway's slab is drawn at where its centreline passes (x, z) and its own level is `own`. */
export function slabLevel(cell, x, z, own, terrain) {
  streetPull(cell, x, z, own, terrain, _sp);
  return own + (_sp.t - own) * _sp.w;
}
