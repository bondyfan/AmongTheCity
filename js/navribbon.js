// ---- navribbon: the geometry of the satnav line on the road -------------------
// Pure arithmetic for js/navline.js, kept apart so it can be tested without a
// GPU. Given a slice of route ahead (js/routeahead.js sliceAhead) it lays a
// ribbon of constant width:
//
//   · in the LANE, not on the centreline. The route runs down the middle of
//     the way; a two-way street is driven on one half of it, so each spine
//     point is moved `off` metres to the right of travel (negative = left,
//     Mahé). The old line sat on the centre stripe, beside the car.
//   · out of the CAR. The first `blendM` metres past the car bend from where
//     the car really is onto that lane line, so the ribbon starts at the
//     bonnet even mid lane change, instead of in the lane next to it.
//   · mitred at the corners, so it keeps its width through a bend, with the
//     mitre capped so a hairpin cannot fire a spike.
//
// Writes positions (x, y, z per vertex, two vertices per spine point: left of
// travel then right) and the arclength of each vertex relative to `sBase`,
// which the shader uses to cut everything behind the car per pixel.

const MITRE_MIN = 0.42;   // cos floor: a corner widens the ribbon 2.4× at most
export const BLEND_MAX = 5;  // m of lateral offset the head will still bend out to

/**
 * @param sl     { x, z, s } spine arrays from sliceAhead, n points
 * @param offs   signed lateral offset per spine point (m, + = right of travel)
 * @param half   ribbon half width (m)
 * @param pos    Float32Array(≥ n·6) out: vertex positions
 * @param aS     Float32Array(≥ n·2) out: vertex arclength − sBase
 * @param yAt    (x, z) → y, or null for a flat `yFlat`
 * @param car    { x, z, s } the car and its arclength, or null for no blend
 * @param blendM metres over which the head bends onto the lane line
 * @param ctr    optional { x, z } arrays (≥ n) out: the ribbon's centre line
 * @returns n
 */
export function buildRibbon(sl, n, offs, half, pos, aS, sBase, yAt, yFlat, car, blendM, ctr = null) {
  if (n < 2) return 0;
  ensureRibbonScratch(n);
  const X = sl.x, Z = sl.z, S = sl.s;
  // the lane line first: centreline + offset along the mitred right normal
  let hx = 0, hz = 0, hs = -1;                   // lane-line point at the car
  for (let k = 0; k < n; k++) {
    mitre(X, Z, n, k, _m);
    const o = offs ? offs[k] : 0;
    // right of travel is −(left)
    _cx[k] = X[k] - _m.nx * o * _m.w;
    _cz[k] = Z[k] - _m.nz * o * _m.w;
  }
  // where the car's arclength falls on that line, and how far off it the car is
  let lat = 0, rx = 0, rz = 0;
  if (car && blendM > 0) {
    let k = 0;
    while (k < n - 2 && S[k + 1] < car.s) k++;
    const L = (S[k + 1] - S[k]) || 1e-9;
    const t = Math.max(0, Math.min(1, (car.s - S[k]) / L));
    hx = _cx[k] + (_cx[k + 1] - _cx[k]) * t;
    hz = _cz[k] + (_cz[k + 1] - _cz[k]) * t;
    hs = car.s;
    let tx = X[k + 1] - X[k], tz = Z[k + 1] - Z[k];
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    rx = -tz; rz = tx;                           // right of travel
    lat = (car.x - hx) * rx + (car.z - hz) * rz; // lateral only: ahead/behind is the cut's job
    // a car across a car park is not "in another lane": past BLEND_MAX the
    // line simply starts in its own lane rather than swinging out to it
    if (Math.abs(lat) > BLEND_MAX) { lat = 0; hs = -1; }
  }
  for (let k = 0; k < n; k++) {
    mitre(X, Z, n, k, _m);
    let cx = _cx[k], cz = _cz[k];
    if (hs >= 0) {
      const u = (S[k] - hs) / blendM;
      const w = u <= 0 ? 1 : u >= 1 ? 0 : 1 - u * u * (3 - 2 * u);
      cx += rx * lat * w; cz += rz * lat * w;
    }
    if (ctr) { ctr.x[k] = cx; ctr.z[k] = cz; }
    const w = half * _m.w;
    const y = yAt ? yAt(cx, cz) : yFlat;
    const v = k * 6;
    pos[v] = cx + _m.nx * w; pos[v + 1] = y; pos[v + 2] = cz + _m.nz * w;
    pos[v + 3] = cx - _m.nx * w; pos[v + 4] = y; pos[v + 5] = cz - _m.nz * w;
    aS[k * 2] = aS[k * 2 + 1] = S[k] - sBase;
  }
  return n;
}

// The bisector of the left normals either side of point k (left of travel is
// (dz, −dx) in this frame: x east, z south), and the mitre scale 1/cos(θ/2).
const _m = { nx: 0, nz: 0, w: 1 };
function mitre(X, Z, n, k, out) {
  let ix = 0, iz = 0, ox = 0, oz = 0;
  if (k > 0) {
    ix = X[k] - X[k - 1]; iz = Z[k] - Z[k - 1];
    const L = Math.hypot(ix, iz) || 1; ix /= L; iz /= L;
  }
  if (k < n - 1) {
    ox = X[k + 1] - X[k]; oz = Z[k + 1] - Z[k];
    const L = Math.hypot(ox, oz) || 1; ox /= L; oz /= L;
  }
  if (k === 0) { ix = ox; iz = oz; }
  if (k === n - 1) { ox = ix; oz = iz; }
  let nx = iz + oz, nz = -(ix + ox);
  const L = Math.hypot(nx, nz);
  if (L < 1e-6) { nx = iz; nz = -ix; } else { nx /= L; nz /= L; }   // a full U-turn
  const cos = nx * iz + nz * -ix;
  out.nx = nx; out.nz = nz;
  out.w = 1 / Math.max(MITRE_MIN, Math.abs(cos));
}

// lane-line scratch, grown on demand (the ribbon is capped at a few hundred points)
let _cx = new Float64Array(512), _cz = new Float64Array(512);
export function ensureRibbonScratch(n) {
  if (_cx.length >= n) return;
  _cx = new Float64Array(n); _cz = new Float64Array(n);
}

// ---- the per-pixel cut -------------------------------------------------------
// What the fragment shader does with each pixel's arclength, as GLSL for
// js/navline.js and as the same arithmetic in JS for the tests. `a` is
// (start, fadeIn, end, fadeOut): the line begins at `start` (the car plus a
// metre) and ramps in over fadeIn; with fadeOut > 0 it dissolves before `end`.
// `b` is (car x, car z, forward x, forward z): past KEEP metres of route, a
// pixel that lies behind the car in space belongs to a leg coming BACK past
// you, and fades out over BACK metres. Inside KEEP nothing is cut by bearing,
// or the far side of a roundabout would vanish while you drive round it.
export const CUT_KEEP = 40;
export const CUT_BACK = 6;
export const NAV_CUT_GLSL = `
{
  float ds = vNavS - uNavA.x;
  float a = clamp(ds / uNavA.y, 0.0, 1.0);
  if (uNavA.w > 0.0) a = min(a, clamp((uNavA.z - vNavS) / uNavA.w, 0.0, 1.0));
  if (ds > ${CUT_KEEP.toFixed(1)}) a = min(a, clamp((dot(vNavXZ - uNavB.xy, uNavB.zw) + ${CUT_BACK.toFixed(1)}) / ${CUT_BACK.toFixed(1)}, 0.0, 1.0));
  diffuseColor.a *= a * a * (3.0 - 2.0 * a);
}`;
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** The shader's alpha factor for a pixel at arclength s and position (x, z). */
export function navCut(s, x, z, a, b) {
  const ds = s - a[0];
  let k = clamp01(ds / a[1]);
  if (a[3] > 0) k = Math.min(k, clamp01((a[2] - s) / a[3]));
  if (ds > CUT_KEEP) k = Math.min(k, clamp01(((x - b[0]) * b[2] + (z - b[1]) * b[3] + CUT_BACK) / CUT_BACK));
  return k * k * (3 - 2 * k);
}
