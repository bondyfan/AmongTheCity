// ---- mwtall.js: what stands tall beside and over the D11 ----
// The two green bridges (ekodukty Žehuň and Voleč) and the procedural noise
// walls. Both are seen from far off (a 7 m deck, a 4 m wall), so unlike the
// 0.9 m barriers (js/mwdress.js, 'full' chunks only) meshes.js calls this for
// the 'shell' tier too: nothing here pops in at the 720 m full-ring edge.
// Worker safe: no three, no DOM. Plain functions of js/d11.js's constants, the
// chunk key and the terrain, so every thread and client draws the same thing.

import { roadsideLevel } from './mwroadside.js';
import { SURF } from './surfaces.js';
import { ECODUCTS, d11Line } from './d11.js';

const lin = (hex) => {
  const f = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return [f(((hex >> 16) & 255) / 255), f(((hex >> 8) & 255) / 255), f((hex & 255) / 255)];
};
const CONCRETE = lin(0xa9a59b), CONCRETE_DK = lin(0x8b877e), SOFFIT = lin(0x6f6c66);
const SOIL = lin(0x5d7440), SHRUB = lin(0x3d5a2a), SHRUB2 = lin(0x4f6b31), SCREEN = lin(0x6b5d4a);

// deterministic 0..1 from two ints (the meshes.js rnd recipe)
function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

function quadToward(sink, a, b, c, d, f, col) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * f[0] + ny * f[1] + nz * f[2] >= 0) sink.quad(...a, ...b, ...c, ...d, col[0], col[1], col[2]);
  else sink.quad(...d, ...c, ...b, ...a, col[0], col[1], col[2]);
}

// ---- the green bridges ------------------------------------------------------
// ECODUCTS gives each one's hole in both carriageways (the tile way ends a, b
// either side, travel order). The real structures: Žehuň 50 m, Voleč 78 m of
// deck over the D11, earth and shrubs on top, a screen along both edges so the
// animals crossing do not see the traffic. Drawn as a slab spanning the dug
// trench (js/terrainstamps.js lowers the road through the hump, the earth
// stays about 10 m up either side): two trench walls along the carriageways,
// the soffit, the two headwalls over the portals, soil, shrubs and screens.
export const ECO_CLEAR = 5.6;      // m road to soffit (a Czech motorway needs 4.8 + margin)
const ECO_SLAB = 1.0, ECO_SOIL = 0.35, ECO_WALL_OUT = 15.5, ECO_DECK_OUT = 24, SCREEN_H = 2.2;

/** Where ecoduct `e` sits: { x, z (anchor), ux, uz (along E travel), hl, key }. */
export function ecoductFrame(e) {
  const mEx = (e.E.a[0] + e.E.b[0]) / 2, mEz = (e.E.a[1] + e.E.b[1]) / 2;
  const mWx = (e.W.a[0] + e.W.b[0]) / 2, mWz = (e.W.a[1] + e.W.b[1]) / 2;
  const ex = e.E.b[0] - e.E.a[0], ez = e.E.b[1] - e.E.a[1], L = Math.hypot(ex, ez);
  const x = (mEx + mWx) / 2, z = (mEz + mWz) / 2;
  // the deck is the published length; the hole the build left is about it
  const hl = Math.max(L, e.deck) / 2;
  return { x, z, ux: ex / L, uz: ez / L, hl, mE: [mEx, mEz], mW: [mWx, mWz],
    key: Math.floor(x / 120) + ',' + Math.floor(z / 120) };
}

// What the first version got wrong, seen from the driver's seat (round 8 fix):
// the deck top sat 3 to 5 m BELOW the earth hump it is part of (the survey
// keeps the real earthwork, 249 to 252 m beside Žehuň's deck at 246), so the
// soil and the shrubs on it were invisible, a dark 2.2 m screen stood on a thin
// slab, and nothing tied the slab to the slopes: a grey table over the road.
// A real D11 green bridge reads as a short tunnel through a planted hill:
//   · the earth on top is level with the hump either side (ecoducts carry 1 to
//     3 m of soil), so the portal is a tall concrete face, 3 to 4.5 m over
//     the opening, with a light coping;
//   · the deck edges are PLANTED: a hedge and small trees along both portals,
//     over a low timber screen, so the top edge reads green from far off;
//   · wing walls flare from the opening and step down with the cutting, and
//     earth fills behind them and along both sides of the deck down to the
//     ground, so the structure sits IN the hill instead of on it.
// Proportions: Žehuň 50 m and Voleč 78 m along the road (the tunnel holes in
// the tiles), the earth top 48 m across, opening 5.6 m clear.
const ECO_FILL_MAX = 4.5, PARAPET = 0.6, WING_L = 16, WING_FLARE = 0.55, SCREEN_LOW = 1.3;
const TREE = lin(0x5b7f37), TREE_DK = lin(0x3e5d27), HEDGE = lin(0x48682c), HEDGE_DK = lin(0x33501f);
const TRUNK = lin(0x4b3d2f), EARTH = lin(0x627845), COPING = lin(0xb9b5ab), TIMBER = lin(0x7d6a52);

// A rounded bush or crown. The first version was two rings of six round a
// pointed top, and from the road it read as a row of green diamonds (seen in
// game). Three rings of seven, the widest a little under half way up, a
// flattened top and a lumpy silhouette (each vertex pushed out or in by the
// crown's own phase), shaded from a dark underside to a lit top, read as
// foliage at 50 to 200 m for 42 triangles.
const BLOB_N = 7;
const BLOB_RINGS = [[-0.12, 0.78], [0.3, 1.0], [0.68, 0.74]];   // [height, radius] of ry, r
const _ring = [[], [], []];
function blob(sink, x, y, z, r, ry, rot, col, dk) {
  for (let q = 0; q < 3; q++) {
    const ring = _ring[q], [hy, hr] = BLOB_RINGS[q];
    for (let m = 0; m < BLOB_N; m++) {
      const t = rot + (m + q * 0.5) * (2 * Math.PI / BLOB_N);
      const lump = 1 + 0.16 * Math.sin(3 * t + rot * 7) + 0.08 * Math.sin(5 * t - rot * 3);
      ring[m] = [x + Math.cos(t) * r * hr * lump, y + ry * hy * (1 + 0.06 * Math.sin(2 * t + rot)), z + Math.sin(t) * r * hr * lump];
    }
  }
  const top = [x, y + ry * 0.9, z], bot = [x, y - ry * 0.4, z];
  const shade = (k) => [dk[0] + (col[0] - dk[0]) * k, dk[1] + (col[1] - dk[1]) * k, dk[2] + (col[2] - dk[2]) * k];
  const cBot = dk, cLow = shade(0.45), cMid = shade(0.85), cTop = col;
  const out = (a, b, c) => [(a[0] + b[0] + c[0]) / 3 - x, (a[1] + b[1] + c[1]) / 3 - (y + ry * 0.3), (a[2] + b[2] + c[2]) / 3 - z];
  const [r0, r1, r2] = _ring;
  for (let m = 0; m < BLOB_N; m++) {
    const n = (m + 1) % BLOB_N;
    quadTri(sink, r0[m], r0[n], bot, out(r0[m], r0[n], bot), cBot);
    quadTri(sink, r0[m], r0[n], r1[m], out(r0[m], r0[n], r1[m]), cLow);
    quadTri(sink, r0[n], r1[n], r1[m], out(r0[n], r1[n], r1[m]), cLow);
    quadTri(sink, r1[m], r1[n], r2[m], out(r1[m], r1[n], r2[m]), cMid);
    quadTri(sink, r1[n], r2[n], r2[m], out(r1[n], r2[n], r2[m]), cMid);
    quadTri(sink, r2[m], r2[n], top, out(r2[m], r2[n], top), cTop);
  }
}
// one triangle wound to face roughly along f
function quadTri(sink, a, b, c, f, col) {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  if (nx * f[0] + ny * f[1] + nz * f[2] >= 0) sink.tri(...a, ...b, ...c, col[0], col[1], col[2]);
  else sink.tri(...a, ...c, ...b, col[0], col[1], col[2]);
}

// The deck's earth top: level with the lower of the two humps beside it (the
// survey, 4 to 12 m past the deck's side, at three stations along it), never
// thinner than slab plus soil, never more than ECO_FILL_MAX over the soffit.
function deckTop(P, hl, yb, terrain) {
  let low = Infinity;
  for (const sgn of [-1, 1]) {
    let sum = 0, n = 0;
    for (const a of [-hl / 2, 0, hl / 2]) for (let c = ECO_DECK_OUT + 4; c <= ECO_DECK_OUT + 12; c += 4) {
      const p = P(a, c * sgn, 0);
      sum += terrain.heightAt(p[0], p[2]); n++;
    }
    low = Math.min(low, sum / n);
  }
  return Math.min(Math.max(low - 0.3, yb + ECO_SLAB + ECO_SOIL), yb + ECO_FILL_MAX);
}

// Earth falling from a top edge (a polyline of [a, c, y]) straight out across
// the road (side `sgn`) at 1 : 1.6 until it meets the survey, its foot 0.3 m
// under the ground so no edge floats. Where the ground is already higher the
// slope is short and the terrain covers it.
function earthSkirt(sink, P, edge, sgn, terrain) {
  const foot = edge.map(([a, c, y]) => {
    let d = 1.5;
    for (; d < 30; d += 1.5) {
      const p = P(a, c + d * sgn, 0);
      if (terrain.heightAt(p[0], p[2]) >= y - d / 1.6) break;
    }
    const p = P(a, c + d * sgn, 0);
    return P(a, c + d * sgn, terrain.heightAt(p[0], p[2]) - 0.3);
  });
  for (let k = 0; k + 1 < edge.length; k++) {
    const [a0, c0, y0] = edge[k], [a1, c1, y1] = edge[k + 1];
    quadToward(sink, P(a0, c0, y0), P(a1, c1, y1), foot[k + 1], foot[k], [0, 1, 0], EARTH);
  }
}

function ecoductInto(sink, e, idx, terrain) {
  const F = ecoductFrame(e);
  const { x, z, ux, uz, hl } = F;
  const vx = -uz, vz = ux;                         // across, toward the E carriageway
  const yr = Math.max(terrain.heightAt(F.mE[0], F.mE[1]), terrain.heightAt(F.mW[0], F.mW[1])) + 0.2;
  // a point at (along a, across c, height y)
  const P = (a, c, y) => [x + ux * a + vx * c, y, z + uz * a + vz * c];
  const yb = yr + ECO_CLEAR, ys = deckTop(P, hl, yb, terrain), yt = ys - ECO_SOIL;
  const ground = (a, c) => { const p = P(a, c, 0); return terrain.heightAt(p[0], p[2]); };
  sink.at(SURF.concrete);
  // the trench walls the deck rests on, facing the carriageways
  for (const sgn of [-1, 1]) {
    const c = ECO_WALL_OUT * sgn;
    quadToward(sink, P(-hl, c, yr - 0.4), P(hl, c, yr - 0.4), P(hl, c, yb), P(-hl, c, yb),
      [-vx * sgn, 0, -vz * sgn], CONCRETE_DK);
  }
  // the soffit, seen from the road as you pass under
  quadToward(sink, P(-hl, -ECO_DECK_OUT, yb), P(hl, -ECO_DECK_OUT, yb), P(hl, ECO_DECK_OUT, yb), P(-hl, ECO_DECK_OUT, yb),
    [0, -1, 0], SOFFIT);
  // the slab's two ends over the earth (the side skirts below mostly bury them)
  for (const sgn of [-1, 1]) {
    const c = ECO_DECK_OUT * sgn;
    quadToward(sink, P(-hl, c, yb), P(hl, c, yb), P(hl, c, yt), P(-hl, c, yt), [vx * sgn, 0, vz * sgn], CONCRETE_DK);
  }
  // the portals: a tall face from the soffit to a parapet over the soil, the
  // full width of the deck, with a light coping
  const yp = ys + PARAPET;
  for (const sgn of [-1, 1]) {
    const a = hl * sgn;
    quadToward(sink, P(a, -ECO_DECK_OUT, yb), P(a, ECO_DECK_OUT, yb), P(a, ECO_DECK_OUT, yp), P(a, -ECO_DECK_OUT, yp),
      [ux * sgn, 0, uz * sgn], CONCRETE);
    // a darker band where the slab edge meets the opening (the lintel)
    quadToward(sink, P(a + 0.02 * sgn, -ECO_WALL_OUT, yb), P(a + 0.02 * sgn, ECO_WALL_OUT, yb),
      P(a + 0.02 * sgn, ECO_WALL_OUT, yb + 0.9), P(a + 0.02 * sgn, -ECO_WALL_OUT, yb + 0.9), [ux * sgn, 0, uz * sgn], CONCRETE_DK);
    quadToward(sink, P(a + 0.15 * sgn, -ECO_DECK_OUT, yp), P(a + 0.15 * sgn, ECO_DECK_OUT, yp),
      P(a - 0.45 * sgn, ECO_DECK_OUT, yp), P(a - 0.45 * sgn, -ECO_DECK_OUT, yp), [0, 1, 0], COPING);
    quadToward(sink, P(a + 0.15 * sgn, -ECO_DECK_OUT, yp - 0.25), P(a + 0.15 * sgn, ECO_DECK_OUT, yp - 0.25),
      P(a + 0.15 * sgn, ECO_DECK_OUT, yp), P(a + 0.15 * sgn, -ECO_DECK_OUT, yp), [ux * sgn, 0, uz * sgn], COPING);
  }
  // the wing walls: from each side of each opening, flaring away from the
  // road and stepping down with the cutting to a foot in the slope; earth
  // fills behind each one (its skirt, below)
  const wings = [];
  for (const sa of [-1, 1]) for (const sc of [-1, 1]) {
    const top = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4, a = sa * (hl + WING_L * t), c = sc * (ECO_WALL_OUT + WING_L * WING_FLARE * t);
      top.push([a, c, Math.max(ground(a, c) + 0.4, yp + (ground(a, c) + 0.4 - yp) * t)]);
    }
    for (let k = 0; k < 4; k++) {
      const [a0, c0, y0] = top[k], [a1, c1, y1] = top[k + 1];
      const f = [-vx * sc, 0, -vz * sc];
      quadToward(sink, P(a0, c0, yr - 0.6), P(a1, c1, yr - 0.6), P(a1, c1, y1), P(a0, c0, y0), f, CONCRETE);
      quadToward(sink, P(a0, c0, y0), P(a1, c1, y1), P(a1, c1 + 0.45 * sc, y1), P(a0, c0 + 0.45 * sc, y0), [0, 1, 0], COPING);
    }
    wings.push([sc, top.map(([a, c, y]) => [a, c + 0.45 * sc, y])]);
  }
  // the earth: on top in two bands so it mounds a little in the middle, then
  // down both sides of the deck and behind every wing wall to the survey
  sink.at(SURF.grass);
  const mid = ys + 0.25;
  for (const [c0, c1, y0, y1] of [[-ECO_DECK_OUT, 0, ys, mid], [0, ECO_DECK_OUT, mid, ys]]) {
    quadToward(sink, P(-hl + 0.4, c0, y0), P(hl - 0.4, c0, y0), P(hl - 0.4, c1, y1), P(-hl + 0.4, c1, y1), [0, 1, 0], SOIL);
  }
  for (const sgn of [-1, 1]) {
    const edge = [];
    const n = Math.max(2, Math.ceil((2 * hl) / 6));
    for (let k = 0; k <= n; k++) edge.push([-hl + (2 * hl * k) / n, ECO_DECK_OUT * sgn, ys]);
    earthSkirt(sink, P, edge, sgn, terrain);
  }
  for (const [sc, top] of wings) earthSkirt(sink, P, top, sc, terrain);
  // planting. A hedge just inside each portal, over the timber screen, so
  // the top edge reads green from the road; small trees behind it; shrubs
  // scattered over the rest. All placed by the ecoduct's own index.
  const yAt = (c) => ys + 0.25 * (1 - Math.abs(c) / ECO_DECK_OUT);
  for (const sa of [-1, 1]) {
    for (let k = 0, c = -ECO_DECK_OUT + 1.5; c < ECO_DECK_OUT - 1.2; k++, c += 2.3) {
      const r = 1.0 + rnd(idx + 51 + sa, k) * 0.7, jc = c + (rnd(idx + 53 + sa, k) - 0.5) * 0.8;
      const a = sa * (hl - 1.7 - rnd(idx + 57 + sa, k) * 0.6);
      const p = P(a, jc, yAt(jc) + r * 0.75);
      blob(sink, p[0], p[1], p[2], r, r * (1.1 + rnd(idx + 59 + sa, k) * 0.5), rnd(idx + 61 + sa, k) * 3, k & 1 ? HEDGE : TREE, HEDGE_DK);
    }
    for (let k = 0, c = -ECO_DECK_OUT + 3 + rnd(idx + 63 + sa, 0) * 3; c < ECO_DECK_OUT - 2.5; k++, c += 5.5 + rnd(idx + 65 + sa, k) * 3) {
      const a = sa * (hl - 4.2 - rnd(idx + 67 + sa, k) * 3.5), y0 = yAt(c);
      const h = 2.2 + rnd(idx + 69 + sa, k) * 2.0, r = 1.5 + rnd(idx + 71 + sa, k) * 1.0;
      treeInto(sink, P(a, c, y0), h, r, rnd(idx + 73 + sa, k) * 3, ux, uz);
    }
  }
  for (let k = 0; k < 30; k++) {
    const a = (rnd(idx + 11, k) * 2 - 1) * (hl - 7), c = (rnd(idx + 23, k) * 2 - 1) * (ECO_DECK_OUT - 3);
    const r = 0.8 + rnd(idx + 41, k) * 1.0, y0 = yAt(c);
    if (k % 3 === 0) treeInto(sink, P(a, c, y0), 1.8 + rnd(idx + 37, k) * 2, r + 0.5, rnd(idx + 43, k) * 3, ux, uz);
    else {
      const p = P(a, c, y0 + r * 0.6);
      blob(sink, p[0], p[1], p[2], r, r * 1.2, rnd(idx + 43, k) * 3, k & 1 ? SHRUB : SHRUB2, HEDGE_DK);
    }
  }
  // the low timber screen along both portals, in front of the hedge (the
  // animals crossing must not see the headlights below)
  sink.at(SURF.concrete);
  for (const sgn of [-1, 1]) {
    const a = (hl - 0.6) * sgn;
    for (const f of [1, -1]) {
      quadToward(sink, P(a, -ECO_DECK_OUT + 0.5, ys), P(a, ECO_DECK_OUT - 0.5, ys),
        P(a, ECO_DECK_OUT - 0.5, ys + SCREEN_LOW), P(a, -ECO_DECK_OUT + 0.5, ys + SCREEN_LOW), [ux * f, 0, uz * f], TIMBER);
    }
  }
}

// a small tree: a square trunk and one crown
function treeInto(sink, base, h, r, rot, ux, uz) {
  const [bx, by, bz] = base, t = 0.14;
  const px = -uz * t, pz = ux * t, qx = ux * t, qz = uz * t;
  const corners = [[px + qx, pz + qz], [-px + qx, -pz + qz], [-px - qx, -pz - qz], [px - qx, pz - qz]];
  for (let m = 0; m < 4; m++) {
    const c0 = corners[m], c1 = corners[(m + 1) % 4];
    quadToward(sink, [bx + c0[0], by - 0.2, bz + c0[1]], [bx + c1[0], by - 0.2, bz + c1[1]],
      [bx + c1[0], by + h, bz + c1[1]], [bx + c0[0], by + h, bz + c0[1]], [(c0[0] + c1[0]), 0, (c0[1] + c1[1])], TRUNK);
  }
  blob(sink, bx, by + h + r * 0.35, bz, r, r * 1.35, rot, TREE, TREE_DK);
}

// ---- noise walls where the village is close and OSM maps none ----------------
// Measured on the tiles (buildings 2.5 m and taller, 12 to 180 m off the
// eastbound line, 100 m bins of official km; mapped noise walls located by
// js/d11.js d11Locate): OSM has walls at Horní Počernice north (W km 1.84 to
// 2.56), Jirny (E 7.24 to 7.99) and Bříství (E 17.7 to 18.6), and none at
// Černý Most south (E km 0.8 to 1.9, houses 21 to 31 m off), on the north side
// before the mapped one (W 1.0 to 1.84, 48 m), Nehvizdy (north, 10.1 to 11.4,
// 125 to 172 m) and Sadská (south, 25.0 to 25.45, 74 m). The services at
// Vrbová Lhota and Dobšice are not villages. `cw` is the carriageway whose
// right-hand verge the wall stands on (W runs north of the D11, E south).
export const NOISE_RUNS = Object.freeze([
  Object.freeze({ cw: 'E', km0: 0.85, km1: 1.95, n: 'Černý Most' }),
  Object.freeze({ cw: 'W', km0: 1.0, km1: 1.84, n: 'Horní Počernice' }),
  Object.freeze({ cw: 'W', km0: 2.56, km1: 2.75, n: 'Horní Počernice' }),
  Object.freeze({ cw: 'W', km0: 10.1, km1: 11.4, n: 'Nehvizdy' }),
  Object.freeze({ cw: 'E', km0: 25.0, km1: 25.45, n: 'Sadská' }),
]);
export const NOISE_OFF = 8.35;     // m right of the centreline: behind the guard rail (6.85)
export const NOISE_H = 4.0;        // m
const NOISE_STEP = 4;              // m, one panel between two posts
const PANEL = lin(0x74827a), PANEL_DK = lin(0x5d6a63), NPOST = lin(0x4f5458), PLINTH = lin(0x9a968c);

// is (x, z) on the asphalt (grown by `grow`) of a drivable road in the cell
function onRoad(cell, x, z, grow) {
  for (const o of cell.roads ?? []) {
    if (!o.d || !o.p || o.br) continue;
    const half = (o.w ?? 3) / 2 + grow, p = o.p;
    for (let k = 0; k < p.length - 1; k++) {
      const ax = p[k][0], az = p[k][1], ex = p[k + 1][0] - ax, ez = p[k + 1][1] - az;
      if (x < Math.min(ax, ax + ex) - half || x > Math.max(ax, ax + ex) + half
        || z < Math.min(az, az + ez) - half || z > Math.max(az, az + ez) + half) continue;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      if ((x - ax - ex * t) ** 2 + (z - az - ez * t) ** 2 < half * half) return true;
    }
  }
  return false;
}

/**
 * The noise-wall panels of one cell, as [x0, z0, x1, z1, nx, nz] pieces (n
 * toward the motorway). Stations every NOISE_STEP m of the d11.js line's
 * own arclength; a piece belongs to the cell its midpoint is in.
 */
export function noisePieces(cell, key) {
  const c = key.indexOf(','), x0 = +key.slice(0, c) * 120, z0 = +key.slice(c + 1) * 120;
  const out = [];
  for (const run of NOISE_RUNS) {
    const q = d11Line(run.cw);
    const lo = Math.min(run.km0, run.km1), hi = Math.max(run.km0, run.km1);
    let prev = null;
    for (let i = 0; i + 1 < q.n; i++) {
      const ka = q.km[i], kb = q.km[i + 1];
      if (Math.max(ka, kb) < lo || Math.min(ka, kb) > hi) { prev = null; continue; }
      const ex = q.x[i + 1] - q.x[i], ez = q.z[i + 1] - q.z[i], L = Math.hypot(ex, ez);
      if (L < 1e-6) continue;
      const ux = ex / L, uz = ez / L, rx = -uz, rz = ux;
      for (let s = Math.ceil(q.s[i] / NOISE_STEP) * NOISE_STEP; s < q.s[i + 1]; s += NOISE_STEP) {
        const t = (s - q.s[i]) / L, km = ka + (kb - ka) * t;
        if (km < lo || km > hi) { prev = null; continue; }
        const px = q.x[i] + ex * t + rx * NOISE_OFF, pz = q.z[i] + ez * t + rz * NOISE_OFF;
        const ok = !onRoad(cell, px, pz, 1.0);
        if (prev && ok) {
          const mx = (prev[0] + px) / 2, mz = (prev[1] + pz) / 2;
          if (mx >= x0 && mx < x0 + 120 && mz >= z0 && mz < z0 + 120) out.push(prev[0], prev[1], px, pz, -rx, -rz);
        }
        prev = ok ? [px, pz] : null;
      }
    }
  }
  return out;
}

function noiseInto(sink, cell, key, terrain) {
  const P = noisePieces(cell, key);
  sink.at(SURF.concrete);
  for (let i = 0; i < P.length; i += 6) {
    const ax = P[i], az = P[i + 1], bx = P[i + 2], bz = P[i + 3], nx = P[i + 4], nz = P[i + 5];
    const len = Math.hypot(bx - ax, bz - az) || 1, alongX = (bx - ax) / len, alongZ = (bz - az) / len;
    const ga = roadsideLevel(cell.roads, ax, az, alongX, alongZ, terrain) - 0.3;
    const gb = roadsideLevel(cell.roads, bx, bz, alongX, alongZ, terrain) - 0.3;
    // a concrete plinth, then the absorbent panels, both faces
    for (const f of [1, -1]) {
      const ox = nx * 0.06 * f, oz = nz * 0.06 * f;
      quadToward(sink, [ax + ox, ga, az + oz], [bx + ox, gb, bz + oz], [bx + ox, gb + 0.8, bz + oz], [ax + ox, ga + 0.8, az + oz],
        [nx * f, 0, nz * f], PLINTH);
      quadToward(sink, [ax + ox, ga + 0.8, az + oz], [bx + ox, gb + 0.8, bz + oz], [bx + ox, gb + NOISE_H, bz + oz], [ax + ox, ga + NOISE_H, az + oz],
        [nx * f, 0, nz * f], f > 0 ? PANEL : PANEL_DK);
    }
    quadToward(sink, [ax - nx * 0.06, ga + NOISE_H, az - nz * 0.06], [bx - nx * 0.06, gb + NOISE_H, bz - nz * 0.06],
      [bx + nx * 0.06, gb + NOISE_H, bz + nz * 0.06], [ax + nx * 0.06, ga + NOISE_H, az + nz * 0.06], [0, 1, 0], PANEL_DK);
    // the post at the piece's start (an H steel column standing proud of the panels)
    const tx = (bx - ax) * 0.03, tz = (bz - az) * 0.03;
    for (const f of [1, -1]) {
      const ox = nx * 0.14 * f, oz = nz * 0.14 * f;
      quadToward(sink, [ax - tx + ox, ga, az - tz + oz], [ax + tx + ox, ga, az + tz + oz],
        [ax + tx + ox, ga + NOISE_H + 0.1, az + tz + oz], [ax - tx + ox, ga + NOISE_H + 0.1, az - tz + oz], [nx * f, 0, nz * f], NPOST);
    }
  }
}

/**
 * The tall D11 features this chunk owns: the green bridge whose anchor lies
 * in it, and its pieces of the procedural noise walls. Absolute heights (the sink range is marked fixed).
 */
export function motorwayTallInto(sink, cell, key, terrain) {
  if (!terrain) return 0;
  const v0 = sink.pos.length;
  const mark = sink.mark();
  ECODUCTS.forEach((e, i) => { if (ecoductFrame(e).key === key) ecoductInto(sink, e, i, terrain); });
  if (cell?.roads) noiseInto(sink, cell, key, terrain);
  sink.fixFrom(mark);
  return (sink.pos.length - v0) / 3;
}
