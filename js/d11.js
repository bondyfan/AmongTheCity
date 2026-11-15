// ---- d11.js: the facts of the D11 (and the D35 south of Sedlice) ----
// Pure data and pure functions. Its only imports are its own baked data
// (js/d11lines.js and js/d11data.js, plain constants): the HUD, the GPS,
// traffic, the sign planner and the chunk mesher (main thread AND the mesh
// worker) all read it, so it must never touch three, the DOM or anything
// that does.
//
// WHY a table in code. The tiles carry the D11 as anonymous oneway ribbons
// (t 'motorway', w 11, ln 2/3): no ref, no names, no destinations, no exit
// numbers, and data/raw-region has no motorway_junction nodes at all (the
// splitter never kept them). Everything a driver reads on the real motorway
// (exit 68 Chýšť, km 68,4, "Hradec Králové") therefore lives here, baked once
// from the tiles, the raw OSM tags and real references, and is the ONE answer
// every round 8 package uses. Never re-derive it elsewhere; if it is wrong,
// fix it here.
//
// LINES. Four carriageway centrelines, each in its direction of travel:
//   E  D11 eastbound, Prague (Černý Most, the IP 15a start) to the end of the
//      tile data past exit 108 Jaroměř-jih;
//   W  D11 westbound, back to the end of the motorway at the D0 interchange;
//   S  D35 southbound, from the Sedlice split (where it leaves the D11 W
//      carriageway) past Opatovice, Časy (the Pardubice exit), Dašice and
//      Ostrov to the tunnel Homole (the build drops tunnels, the tiles stop);
//   N  D35 northbound, from the tunnel back to where it joins the D11 E.
// They are the TILE motorway ways chained end to end, picked out by the raw
// OSM chains (ref D11 / D35), every tile vertex kept (the tiles are already
// simplified to 0.5 m; a Douglas-Peucker pass at 0.4 m found nothing to
// drop), stored as decimetre deltas in js/d11lines.js. Across the two holes
// under the green bridges (the build dropped the tunnel ways) the lines follow
// the patches js/roadpatches.js puts there (within 0.4 m), so the line and
// the drawn road agree. Between Sedlice and Plotiště the D11 carriageways
// also carry the D35 (D35_SHARED); there the answer is D11.
// The tile data runs on past the world's terrain (D11_WORLD_END_KM): plan
// nothing beyond it.
//
// KILOMETRES. Czech exit numbers are the motorway kilometre (rounded to the
// nearest, see D11_KM), but the OSM
// chainage puts the interchange centres 0.29 to 1.23 km past their numbers
// (D11_KM below says how that was measured and fixed), so km is
// a piecewise linear calibration of the chainage along E (and S) through
// anchors, extrapolated with slope 1 past the last ones. W gets its km by
// projecting each vertex onto E (N onto S); measured strictly monotonic.
// km grows eastbound on the D11 and southbound on the D35 (cw E and S),
// so `UP[cw]` is +1 there and -1 on W and N.
//
// DIRECTIONS. (dx, dz) is the unit direction of TRAVEL on that carriageway.
// The game's heading is h = atan2(-dx, -dz) (dirX = -sin h, dirZ = -cos h).
// `off` is the signed lateral offset from the centreline, + to the RIGHT of
// travel, i.e. along (-dz, dx): heading east (+x) the right is south (+z).
//
// Co-op: everything here is a function of the constants, so every client and
// thread gets the same answer whatever order its tiles arrived in.

import { E_LINE, W_LINE, S_LINE, N_LINE } from './d11lines.js';
import { EXITS, REST, BRIDGES, ECODUCTS, D35_SHARED, D11_WORLD_END_KM } from './d11data.js';

// The tables are documented where they live (js/d11data.js); EXITS, REST,
// ECODUCTS are deep frozen. BRIDGES is read through onBridge().
export { EXITS, REST, ECODUCTS, D35_SHARED, D11_WORLD_END_KM };

/** Which road each carriageway is, and which way its km run. */
export const ROAD = Object.freeze({ E: 'D11', W: 'D11', S: 'D35', N: 'D35' });
export const UP = Object.freeze({ E: 1, W: -1, S: 1, N: -1 });
/** d11Locate answers null beyond this many metres from every centreline. */
export const LOCATE_R = 25;

// D11 km anchors, [metres along E from its first vertex, official km].
// Sources: km 0 is the cs.wikipedia "Dálnice D11" start coordinate; every exit
// N (the exit list of cs.wikipedia "Dálnice D11", confirmed by ŘSD / MD ČR
// closure notices "EXIT 35 MÚK Vrbová Lhota", "EXIT 39 MÚK Kluk") is placed at
// km N at its MEASURED interchange centre (the middle of its first and last
// slip node on either carriageway): the exit number is the km ROUNDED TO THE
// NEAREST, not rounded down. Settled in round 8 (SIGNS package) from the real
// km quoted next to an exit or a service area: the MD ČR notice puts D0
// interchange 60 at km 59.90 to 60.25 (its centre ON 60, impossible if the
// number were the km floored), and the services survey's Beranka 3.1, Vrbová
// Lhota 35.6, Osice 81.1 sit 0.05, 0.33 and 0.43 km from these km against
// 0.46, 0.83 and 0.07 under the old N + 0.5 anchors. Every km baked into
// js/d11data.js and js/mwslips.js was re-baked with the same shift (km - 0.5
// past exit 8, km x 8 / 8.5 before it), so tables and lines still agree.
// Before any anchors: chainage minus the start put the centres 0.29 to 1.23
// km past their numbers (Libice +0.29 to Sadská +1.23, Pravy +1.14); no
// uniform offset fits. Now every diverge lies in [N - 0.7, N + 0.5]
// (tests/d11.test.mjs), the stretch between anchors is 0.91 to 1.13 (0.93 on
// the first 8 km). Exceptions: exit 1 is the D0 interchange the motorway
// begins in (its slips straddle km 0, not anchored), and exit 90 Kukleny is
// two half junctions 1 km apart, anchored at N - 0.15 so both halves fit.
const D11_KM = [
  [508.4, 0],         // km 0: the cs.wikipedia start coordinate 50°05'58"N 14°35'32"E, 1.4 m off E
  [9095.9, 8],        // exit 8 Jirny
  [19309.4, 18],      // exit 18 Bříství
  [26742.4, 25],      // exit 25 Sadská
  [36109.5, 35],      // exit 35 Vrbová Lhota
  [40020.2, 39],      // exit 39 Kluk
  [42802.8, 42],      // exit 42 Libice nad Cidlinou
  [51356.8, 50],      // exit 50 Dobšice
  [62837.7, 62],      // exit 62 Chlumec nad Cidlinou
  [68890.1, 68],      // exit 68 Chýšť
  [77648.8, 76],      // exit 76 Pravy
  [85417.7, 84],      // exit 84 Sedlice
  [91595.6, 89.85],   // exit 90 Kukleny
  [96164.6, 95],      // exit 95 Plotiště
  [105271.3, 104],    // exit 104 Smiřice
  [109014.1, 108],    // exit 108 Jaroměř-jih
];

// D35 km anchors along S, [metres from the Sedlice split, official km]. The D35
// is numbered on its own series (cs.wikipedia "Dálnice D35": Plotiště 126,
// Sedlice 127, the 11 km shared with the D11 counted as one); each exit at
// km N at its measured centre (nearest rounding, as on the D11), except
// Sedlice (the middle of the split and the slip to Praha, at N - 0.1) and
// Opatovice (1.1 km of slips, N - 0.05), so that every diverge lies in
// [N - 0.7, N + 0.5]. Stretch 0.87 to 1.13.
const D35_KM = [
  [570, 126.9],       // exit 127 Sedlice
  [4748.7, 130.95],   // exit 131 Opatovice nad Labem
  [13259.3, 139],     // exit 139 Rokytno
  [17695.1, 144],     // exit 144 Časy
  [22270.9, 148],     // exit 148 Dašice
  [31422.4, 157],     // exit 157 Ostrov
];

// ---------------------------------------------------------------------------
// The lines, decoded once per thread on first use.

const CWS = ['E', 'W', 'S', 'N'];
let LINES = null;

function decode(src) {
  const t = src.trim().split(/\s+/);
  const x = new Float64Array(t.length), z = new Float64Array(t.length);
  let px = 0, pz = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i].indexOf(',');
    px += +t[i].slice(0, c); pz += +t[i].slice(c + 1);
    x[i] = px / 10; z[i] = pz / 10;
  }
  const s = new Float64Array(t.length);
  for (let i = 1; i < t.length; i++) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], z[i] - z[i - 1]);
  return { x, z, s, km: new Float64Array(t.length), n: t.length };
}

/** Piecewise linear through [s, km] anchors, slope 1 beyond both ends. */
function calibrate(anchors, s) {
  const n = anchors.length;
  if (s <= anchors[0][0]) return anchors[0][1] + (s - anchors[0][0]) / 1000;
  if (s >= anchors[n - 1][0]) return anchors[n - 1][1] + (s - anchors[n - 1][0]) / 1000;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (anchors[m][0] <= s) lo = m; else hi = m; }
  const a = anchors[lo], b = anchors[hi];
  return a[1] + (b[1] - a[1]) * (s - a[0]) / (b[0] - a[0]);
}

// Each vertex of `L` projected onto `R` (the reference line, same road, the
// other way round): R's km at the nearest point. L runs against R, so walk L
// from its LAST vertex while the match on R only moves forward; a window of
// 400 segments ahead is far more than a carriageway pair ever needs.
function projectKm(L, R) {
  let j = 0;
  for (let i = L.n - 1; i >= 0; i--) {
    const px = L.x[i], pz = L.z[i];
    let best = Infinity, bj = j, bt = 0;
    const j0 = Math.max(0, j - 20), j1 = Math.min(R.n - 1, j + 400);
    for (let k = j0; k < j1; k++) {
      const ax = R.x[k], az = R.z[k], ex = R.x[k + 1] - ax, ez = R.z[k + 1] - az;
      const L2 = ex * ex + ez * ez || 1e-9;
      let t = ((px - ax) * ex + (pz - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = ax + ex * t - px, qz = az + ez * t - pz, d = qx * qx + qz * qz;
      if (d < best) { best = d; bj = k; bt = t; }
    }
    j = bj;
    // past either end of R, extrapolate along its end segment rather than
    // clamp, so the km keeps running (N passes the S start at Sedlice)
    if (bj === 0 || bj === R.n - 2) {
      const ax = R.x[bj], az = R.z[bj], ex = R.x[bj + 1] - ax, ez = R.z[bj + 1] - az;
      const t = ((px - ax) * ex + (pz - az) * ez) / (ex * ex + ez * ez || 1e-9);
      if ((bj === 0 && t < 0) || (bj === R.n - 2 && t > 1)) bt = t;
    }
    L.km[i] = R.km[bj] + (R.km[bj + 1] - R.km[bj]) * bt;
  }
}

// The bucket grid for d11Locate: each segment is filed under every cell its
// box, grown by LOCATE_R, touches, so a query reads ONE cell and is O(1)
// (the HUD asks every frame, the mesher every chunk).
const CELL = 64;
const cellKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);

function lines() {
  if (LINES) return LINES;
  const L = { E: decode(E_LINE), W: decode(W_LINE), S: decode(S_LINE), N: decode(N_LINE) };
  for (let i = 0; i < L.E.n; i++) L.E.km[i] = calibrate(D11_KM, L.E.s[i]);
  for (let i = 0; i < L.S.n; i++) L.S.km[i] = calibrate(D35_KM, L.S.s[i]);
  projectKm(L.W, L.E);
  projectKm(L.N, L.S);
  const grid = new Map();
  CWS.forEach((cw, li) => {
    const q = L[cw];
    for (let i = 0; i + 1 < q.n; i++) {
      const x0 = Math.floor((Math.min(q.x[i], q.x[i + 1]) - LOCATE_R) / CELL);
      const x1 = Math.floor((Math.max(q.x[i], q.x[i + 1]) + LOCATE_R) / CELL);
      const z0 = Math.floor((Math.min(q.z[i], q.z[i + 1]) - LOCATE_R) / CELL);
      const z1 = Math.floor((Math.max(q.z[i], q.z[i + 1]) + LOCATE_R) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) {
        const k = cellKey(cx, cz);
        let a = grid.get(k);
        if (!a) grid.set(k, a = []);
        a.push(li * 65536 + i);
      }
    }
  });
  LINES = { L, grid };
  return LINES;
}

/**
 * A carriageway's centreline as read-only typed arrays, in travel order:
 * { x, z, s (metres from its first vertex), km, n }. For consumers that walk
 * the whole line (planners, the horizon); never write into them.
 */
export function d11Line(cw) { return lines().L[cw] ?? null; }

/** The km range a carriageway covers, [low, high]. */
export function kmRange(cw) {
  const q = lines().L[cw];
  return UP[cw] > 0 ? [q.km[0], q.km[q.n - 1]] : [q.km[q.n - 1], q.km[0]];
}

/**
 * The point at official `km` on carriageway `cw` ('E' | 'W' on the D11,
 * 'S' | 'N' on the D35) and the unit direction of travel there:
 * { x, z, dx, dz }, written into `out` when given. null outside the line.
 */
export function d11At(km, cw = 'E', out = null) {
  const q = lines().L[cw];
  if (!q) return null;
  const up = UP[cw], n = q.n;
  // km is monotonic along the vertex order: increasing for E/S, decreasing for W/N
  const first = q.km[0], last = q.km[n - 1];
  if (up > 0 ? (km < first || km > last) : (km > first || km < last)) return null;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if ((q.km[m] - km) * up <= 0) lo = m; else hi = m;
  }
  const k0 = q.km[lo], k1 = q.km[hi];
  const t = k1 !== k0 ? (km - k0) / (k1 - k0) : 0;
  const ex = q.x[hi] - q.x[lo], ez = q.z[hi] - q.z[lo], len = Math.hypot(ex, ez) || 1;
  const o = out ?? {};
  o.x = q.x[lo] + ex * t; o.z = q.z[lo] + ez * t;
  o.dx = ex / len; o.dz = ez / len;
  return o;
}

/**
 * Where (x, z) is on the motorway: { road: 'D11' | 'D35', cw, km, off, dx, dz }
 * for the nearest centreline within LOCATE_R metres, else null. `off` is + to
 * the right of travel. O(1): one grid cell. Pass `out` to avoid allocating
 * (the HUD calls this every frame).
 */
export function d11Locate(x, z, out = null) {
  const { L, grid } = lines();
  const cell = grid.get(cellKey(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!cell) return null;
  let best = LOCATE_R * LOCATE_R, bl = -1, bi = 0, bt = 0;
  for (let k = 0; k < cell.length; k++) {
    const li = (cell[k] / 65536) | 0, i = cell[k] - li * 65536, q = L[CWS[li]];
    const ax = q.x[i], az = q.z[i], ex = q.x[i + 1] - ax, ez = q.z[i + 1] - az;
    const L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const qx = x - ax - ex * t, qz = z - az - ez * t, d = qx * qx + qz * qz;
    if (d <= best) { best = d; bl = li; bi = i; bt = t; }
  }
  if (bl < 0) return null;
  const cw = CWS[bl], q = L[cw];
  const ex = q.x[bi + 1] - q.x[bi], ez = q.z[bi + 1] - q.z[bi], len = Math.hypot(ex, ez) || 1;
  const dx = ex / len, dz = ez / len;
  const o = out ?? {};
  o.road = ROAD[cw]; o.cw = cw;
  o.km = q.km[bi] + (q.km[bi + 1] - q.km[bi]) * bt;
  o.off = (x - q.x[bi] - ex * bt) * -dz + (z - q.z[bi] - ez * bt) * dx;
  o.dx = dx; o.dz = dz;
  return o;
}

// next entry of `list` on `cw` whose `pick(side)` km lies ahead of km
function ahead(list, km, cw, pick) {
  const up = UP[cw], road = ROAD[cw];
  let best = null, bk = 0;
  for (const e of list) {
    if (e.road !== road || !e[cw]) continue;
    const k = pick(e[cw]);
    if ((k - km) * up <= 0) continue;
    if (!best || (k - bk) * up < 0) { best = e; bk = k; }
  }
  return best;
}

/**
 * The next exit on carriageway `cw` whose diverge lies ahead of `km` in the
 * direction of travel, or null. Distance to it: |exit[cw].div.km - km| km.
 */
export function exitAhead(km, cw = 'E') { return ahead(EXITS, km, cw, (s) => s.div.km); }

/** The next rest area / services on `cw` ahead of `km`, or null. */
export function restAhead(km, cw = 'E') {
  return ahead(REST, km, cw, (s) => (s.div ? s.div.km : s.km));
}

/**
 * The exit whose diverge, merge or junction centre lies nearest (x, z),
 * within r metres, or null. For the GPS at a motorway_link node.
 */
export function exitNear(x, z, r = 150) {
  let best = null, bd = r * r;
  for (const e of EXITS) {
    for (const cw of CWS) {
      const s = e[cw];
      if (!s) continue;
      // three named points, not an array literal: no garbage per call
      for (let k = 0; k < 3; k++) {
        const p = k === 0 ? s.div : k === 1 ? s.mer : s.alt;
        if (!p) continue;
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d <= bd) { bd = d; best = e; }
      }
    }
  }
  return best;
}

/** Whether `km` on `cw` lies on (or within `pad` km of) a bridge deck. */
export function onBridge(km, cw = 'E', pad = 0) {
  const list = BRIDGES[cw];
  if (!list) return false;
  for (let i = 0; i < list.length; i++) {
    if (km >= list[i][0] - pad && km <= list[i][1] + pad) return true;
  }
  return false;
}
