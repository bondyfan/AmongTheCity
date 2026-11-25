// ---- airport-lights-plan.js: where an airport's lights stand, and what each one shows ----
// WORKER SAFE, pure: no three.js, no DOM, no clock. js/airport-lights.js draws
// what this lays out; the tests pin the counts, the spacing and the colours.
// Every player computes the same lights from the same data, so co-op needs
// nothing on the wire.
//
// A light is { kind, x, z, h, c, b, nx, nz, papi?, flash? }:
//   kind  'edge' | 'threshold' | 'wingbar' | 'centre' | 'tdz' | 'approach' | 'flash'
//         | 'papi' | 'taxi' (a blue taxiway edge) | 'taxiline' (a green taxiway centreline)
//   x, z  world metres; h the lamp's height over the ground (or the sea)
//   c     its colour [r, g, b] (linear, 1 = a runway edge light's strength)
//   b     null for a light that shows the same all round; otherwise the
//         colour seen from behind it: from where (eye - light) . (nx, nz) < 0.
//         A real fixture is often two lights back to back: the green
//         threshold is a red runway end from the other side, an edge light in
//         the last 600 m is yellow toward the end it warns of and white back.
//   papi  the box's setting in radians: white seen from above it, red below
//   flash the flasher's place in its sweep, 0 the outermost .. <1 the innermost
//
// What the three airports have (LKPD and LKPR from the Czech eAIP AD 2.14/2.15,
// read 25 Nov 2026; SEZ is not published where it could be read, so it is the
// usual fit for a runway with an ILS, and says so below):
//   LKPD 09/27, 2 500 x 75 m: edge lights every 60 m, white, yellow from 1 900
//   m; green thresholds, red ends, no wing bars, no centreline, no TDZ.
//   27: PALS CAT I 794.5 m with a flashing light system, PAPI left at 3 deg.
//   09: SALS 420 m, PAPI left at 3 deg. Taxiways: blue edge lights, 60 m apart
//   on the straight, 7 m in the turns, no centreline.
//   LKPR: see lkprLights() below.

export const COLOUR = {
  white: [1.0, 0.86, 0.66],   // halogen: a warm white
  yellow: [1.0, 0.6, 0.12],   // the caution zone
  green: [0.18, 1.0, 0.4],
  red: [1.0, 0.09, 0.05],
  blue: [0.2, 0.38, 1.0],
  approach: [1.25, 1.08, 0.84],
  flash: [2.6, 2.6, 2.8],
  papiWhite: [1.5, 1.38, 1.18],
  papiRed: [1.5, 0.12, 0.07],
  alsRed: [1.2, 0.1, 0.06],     // the side rows of a CAT II/III approach
  taxiGreen: [0.12, 0.85, 0.3],
  off: [0, 0, 0],
};
const D2R = Math.PI / 180;
const EDGE_OUT = 1.5;      // m: edge lights stand this far outside the paving
const ROW_STEP = 3;        // m at most between threshold lights
const PAPI = { at: 300, first: 15, step: 9, h: 0.6, blend: 0.06 * D2R };
// for a 3 degree path: the box nearest the runway at 3.5, the outermost at 2.5
const PAPI_SET = [3.5, 3 + 1 / 6, 3 - 1 / 6, 2.5].map((d) => d * D2R);
const TAXI = { straight: 60, turn: 7, bendDeg: 10, out: 1, merge: 4, clear: 4 };
const TAXI_LINE = { straight: 30, turn: 7.5 };      // centreline lights (ICAO: 30 m, 7.5 m in a curve)
const TDZ = { from: 60, step: 30, gauge: 18, n: 3, gap: 1.5 }; // barrettes either side of the centreline
const WBAR = { n: 5, gap: 2.5 };                    // green wing bars out past the edge lights

// ---- a runway's own frame: s along the centreline from end a, e to the right ----
export function runwayFrame(line) {
  const seg = [];
  let L = 0;
  for (let i = 1; i < line.length; i++) {
    const [x0, z0] = line[i - 1], dx = line[i][0] - x0, dz = line[i][1] - z0, l = Math.hypot(dx, dz);
    seg.push({ x0, z0, ux: dx / l, uz: dz / l, s0: L, l });
    L += l;
  }
  /** The point s metres from end a (beyond either end: on along its last segment), e to the right. */
  function at(s, e = 0) {
    let k = 0;
    while (k < seg.length - 1 && s > seg[k].s0 + seg[k].l) k++;
    const g = seg[k], t = s - g.s0;
    return { x: g.x0 + g.ux * t - g.uz * e, z: g.z0 + g.uz * t + g.ux * e, ux: g.ux, uz: g.uz };
  }
  return { L, at, seg };
}

const light = (kind, p, h, c, b = null, nx = 0, nz = 0) => ({ kind, x: p.x, z: p.z, h, c, b, nx, nz });

/**
 * A runway's lights.
 *   rw { line: [[x, z], ...] end a to end b, width, centre?: bool,
 *        a, b: { als?, papi?, tdz?: length, wbar?: bool },  (the ends at the line's start and finish)
 *        avoid?: [{ line, width }] other runways, whose paving no edge or approach light stands on }
 *   als { length, step, bar (lights in a barrette), barW (its width, m),
 *         crossbars: [{ d, half }], flash?: { from } (flashers from this far out),
 *         side?: { to, step, gauge } (red barrettes either side, CAT II/III) }
 */
export function runwayLights(rw) {
  const F = runwayFrame(rw.line), L = F.L, hw = rw.width / 2, out = [];
  const u = F.at(0), v = F.at(L); // the directions at the two ends
  // where another runway crosses, its paving: no edge or approach light stands there
  const onOther = (p, m) => (rw.avoid ?? []).some((r) => lineDist(p.x, p.z, r.line) < r.width / 2 + m);
  // edge lights: both ends and evenly between, never more than 60 m apart
  const n = Math.ceil(L / 60);
  for (let i = 0; i <= n; i++) {
    const s = (L * i) / n, p0 = F.at(s);
    for (const e of [-(hw + EDGE_OUT), hw + EDGE_OUT]) {
      const p = F.at(s, e);
      if (onOther(p, 1)) continue;
      if (s > L - 600) out.push(light('edge', p, 0.35, COLOUR.yellow, COLOUR.white, -p0.ux, -p0.uz));
      else if (s < 600) out.push(light('edge', p, 0.35, COLOUR.yellow, COLOUR.white, p0.ux, p0.uz));
      else out.push(light('edge', p, 0.35, COLOUR.white));
    }
  }
  // a row across each end: green seen from the approach, red seen from the runway
  const k = Math.ceil(rw.width / ROW_STEP);
  for (const [s, ox, oz] of [[-1.5, -u.ux, -u.uz], [L + 1.5, v.ux, v.uz]]) {
    for (let i = 0; i <= k; i++) out.push(light('threshold', F.at(s, -hw + (rw.width * i) / k), 0.3, COLOUR.green, COLOUR.red, ox, oz));
    // wing bars: green, out past the edge lights on both sides, seen from the approach only
    if (rw[s < 0 ? 'a' : 'b']?.wbar) {
      for (let i = 1; i <= WBAR.n; i++) for (const sg of [-1, 1]) {
        out.push(light('wingbar', F.at(s, sg * (hw + EDGE_OUT + WBAR.gap * i)), 0.3, COLOUR.green, COLOUR.off, ox, oz));
      }
    }
  }
  // centreline lights where a runway has them: white, red and white from 900 m
  // before the end you roll toward, red for the last 300 m
  if (rw.centre) {
    const code = (r, i) => (r < 300 || (r < 900 && i % 2) ? COLOUR.red : COLOUR.white);
    for (let i = 0, s = 7.5; s < L; i++, s += 15) {
      const p = F.at(s);
      out.push(light('centre', p, 0.05, code(L - s, i), code(s, i), -p.ux, -p.uz));
    }
  }
  for (const [end, s0, sign, ox, oz] of [['a', 0, -1, -u.ux, -u.uz], ['b', L, 1, v.ux, v.uz]]) {
    const cfg = rw[end];
    const clear = (p) => !onOther(p, 3);
    if (cfg?.als) approachLights(out, F, s0, sign, ox, oz, cfg.als, clear);
    // the touchdown zone: pairs of white barrettes from 60 m in, facing the approach
    if (cfg?.tdz) {
      for (let d = TDZ.from; d <= cfg.tdz + 1e-6; d += TDZ.step) {
        for (let i = 0; i < TDZ.n; i++) for (const sg of [-1, 1]) {
          out.push(light('tdz', F.at(s0 - sign * d, sg * (TDZ.gauge / 2 + TDZ.gap * i)), 0.05, COLOUR.white, COLOUR.off, ox, oz));
        }
      }
    }
    // PAPI: four boxes left of the touchdown zone, abeam the aiming point
    if (cfg?.papi) {
      const s = s0 - sign * PAPI.at, left = sign < 0 ? -1 : 1;
      PAPI_SET.forEach((a, i) => {
        const L1 = light('papi', F.at(s, left * (hw + PAPI.first + PAPI.step * i)), PAPI.h, COLOUR.papiWhite, COLOUR.off, ox, oz);
        L1.papi = a;
        out.push(L1);
      });
    }
  }
  return out;
}

// The approach lights out from the threshold at s0 (sign: -1 off end a, +1 off
// end b): a barrette on the extended centreline every `step` metres, the
// crossbars, the flashers. They face the approach only.
function approachLights(out, F, s0, sign, ox, oz, als, clear = () => true) {
  const at = (d, e) => F.at(s0 + sign * d, e);
  const put = (p, c) => { if (clear(p)) out.push(light('approach', p, 0.6, c, COLOUR.off, ox, oz)); };
  const flashers = [];
  for (let d = als.step; d <= als.length + 1e-6; d += als.step) {
    for (let i = 0; i < als.bar; i++) put(at(d, als.bar > 1 ? -als.barW / 2 + (als.barW * i) / (als.bar - 1) : 0), COLOUR.approach);
    if (als.flash && d >= als.flash.from && clear(at(d, 0))) flashers.push(d);
  }
  for (const { d, half } of als.crossbars ?? []) {
    if (d > als.length + 1e-6) continue;
    const inner = als.barW / 2 + 2.5, m = Math.max(1, Math.round((half - inner) / 2.5));
    for (let i = 0; i <= m; i++) {
      const e = inner + ((half - inner) * i) / m;
      for (const sgn of [-1, 1]) put(at(d, sgn * e), COLOUR.approach);
    }
  }
  // CAT II/III: red barrettes either side of the inner part, in line with the TDZ
  if (als.side) {
    for (let d = als.side.step; d <= als.side.to + 1e-6; d += als.side.step) {
      for (let i = 0; i < TDZ.n; i++) for (const sg of [-1, 1]) put(at(d, sg * (als.side.gauge / 2 + TDZ.gap * i)), COLOUR.alsRed);
    }
  }
  // the rabbit: from the outermost toward the threshold, twice a second
  flashers.sort((p, q) => q - p).forEach((d, i) => {
    const L1 = light('flash', at(d, 0), 1.2, COLOUR.flash, COLOUR.off, ox, oz);
    L1.flash = i / flashers.length;
    out.push(L1);
  });
}

// ---- taxiways ----------------------------------------------------------------
const segDist = (x, z, ax, az, bx, bz) => {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / L2)) : 0;
  return Math.hypot(x - ax - ex * t, z - az - ez * t);
};
const lineDist = (x, z, p) => {
  let d = Infinity;
  for (let i = 1; i < p.length; i++) d = Math.min(d, segDist(x, z, p[i - 1][0], p[i - 1][1], p[i][0], p[i][1]));
  return d;
};

/**
 * Blue edge lights down both sides of every taxiway: `ways` [{ p: [[x, z], ...], w }],
 * `runways` [{ line, width }] whose paving they never stand on. 60 m apart on
 * the straight, 7 m through a turn; none on another taxiway's paving (a
 * junction is open), none closer than 4 m to another.
 */
export function taxiLights(ways, runways = []) {
  const cand = [];
  for (const w of ways) {
    const off = w.w / 2 + TAXI.out;
    for (const q of alongWay(w.p, TAXI.straight, TAXI.turn)) for (const e of [-off, off]) cand.push({ x: q.x - q.nz * e, z: q.z + q.nx * e });
  }
  const out = [];
  for (const q of cand) {
    if (runways.some((r) => lineDist(q.x, q.z, r.line) < r.width / 2 + TAXI.clear)) continue;
    if (ways.some((w) => lineDist(q.x, q.z, w.p) < w.w / 2 - 1)) continue;
    if (out.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < TAXI.merge)) continue;
    out.push(light('taxi', q, 0.3, COLOUR.blue));
  }
  return out;
}

/**
 * Green lights flush down the middle of every taxiway (where an airport has
 * them in place of edge lights): 30 m apart on the straight, 7.5 m through a
 * turn, stopping short of the runways; where two ways meet, one light.
 */
export function taxiCentreLights(ways, runways = []) {
  const out = [], grid = new Map(), G = TAXI.merge;
  const key = (x, z) => Math.floor(x / G) + ',' + Math.floor(z / G);
  const near = (x, z) => {
    const i = Math.floor(x / G), j = Math.floor(z / G);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      for (const o of grid.get((i + a) + ',' + (j + b)) ?? []) if (Math.hypot(o.x - x, o.z - z) < G) return true;
    }
    return false;
  };
  for (const w of ways) for (const q of alongWay(w.p, TAXI_LINE.straight, TAXI_LINE.turn)) {
    if (runways.some((r) => lineDist(q.x, q.z, r.line) < r.width / 2 + TAXI.clear)) continue;
    if (near(q.x, q.z)) continue;
    const L1 = light('taxiline', q, 0.05, COLOUR.taxiGreen);
    out.push(L1);
    const k = key(q.x, q.z);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(L1);
  }
  return out;
}

// Points along a polyline: `straight` m apart, `turn` m on the segments either
// side of a vertex where it bends by more than a few degrees; each with the
// way's direction there (at a vertex the mean of the two).
function alongWay(p, straight, turn) {
  const pts = [];
  if (!p || p.length < 2) return pts;
  const cosBend = Math.cos(TAXI.bendDeg * D2R), dir = [];
  for (let i = 1; i < p.length; i++) {
    const dx = p[i][0] - p[i - 1][0], dz = p[i][1] - p[i - 1][1], l = Math.hypot(dx, dz) || 1;
    dir.push([dx / l, dz / l, l]);
  }
  const bend = p.map((_, i) => i > 0 && i < p.length - 1 && dir[i - 1][0] * dir[i][0] + dir[i - 1][1] * dir[i][1] < cosBend);
  for (let i = 0; i < dir.length; i++) {
    const [ux, uz, l] = dir[i], step = bend[i] || bend[i + 1] ? turn : straight;
    const m = Math.max(1, Math.ceil(l / step)), last = i === dir.length - 1;
    for (let j = 0; j <= (last ? m : m - 1); j++) {
      const t = (l * j) / m;
      let nx = ux, nz = uz;
      if (j === 0 && i > 0) { nx = ux + dir[i - 1][0]; nz = uz + dir[i - 1][1]; const k = Math.hypot(nx, nz) || 1; nx /= k; nz /= k; }
      pts.push({ x: p[i][0] + ux * t, z: p[i][1] + uz * t, nx, nz });
    }
  }
  return pts;
}

// ---- the three airports --------------------------------------------------------
// Calvert crossbars every 150 m, each a little wider than the one before, so
// that together they draw two lines converging on the runway beyond the threshold.
const calvert = (len) => [150, 300, 450, 600, 750].filter((d) => d <= len).map((d) => ({ d, half: 15 * (d + 300) / 600 }));
export const ALS = {
  palsCat1: (length, flash) => ({ length, step: 30, bar: 5, barW: 4, crossbars: calvert(length), flash: flash ? { from: 300 } : null }),
  sals: (length) => ({ length, step: 60, bar: 3, barW: 3, crossbars: [{ d: 300, half: 15 }] }),
  // CAT II/III: the CAT I system with red side rows over the inner 270 m; the
  // crossbars inside that only fill the gap between the centre and the side rows
  cat23: (length, flash) => ({
    ...ALS.palsCat1(length, flash),
    crossbars: calvert(length).map((c) => (c.d < 270 ? { d: c.d, half: TDZ.gauge / 2 - 1.5 } : c)),
    side: { to: 270, step: 30, gauge: TDZ.gauge },
  }),
};

/** Pardubice: `plan` is js/airport-plan.js (RUNWAY, TAXI_OUT, TAXI_IN). */
export function lkpdLights(plan) {
  const R = plan.RUNWAY;
  const rw = { line: [R.a, R.mid, R.b], width: R.width, centre: false,
    a: { als: ALS.sals(420), papi: true }, b: { als: ALS.palsCat1(794.5, true), papi: true } };
  // the routes the airliner taxis, from where they leave the apron (the
  // stand's loop is apron, which has no edge lights down its middle)
  const ways = [{ p: plan.TAXI_OUT.slice(9), w: 23 }, { p: plan.TAXI_IN.slice(0, 16), w: 23 }];
  return { centre: mid(rw.line), lights: [...runwayLights(rw), ...taxiLights(ways, [rw])] };
}

/**
 * Seychelles International: `desc` is REGIONS.mahe.airport, `roads` the tile's
 * taxiway lines when they have streamed in (the narrow service ways are left dark).
 * The approach lighting of 13 is assumed: a 600 m CAT I system without flashers
 * (it comes in over the sea), PAPI left at both ends.
 */
export function sezLights(desc, roads = []) {
  const e = desc.runway.ends;
  const rw = { line: [[e['13'].x, e['13'].z], [e['31'].x, e['31'].z]], width: desc.runway.width, centre: false,
    a: { als: ALS.palsCat1(600, false), papi: true }, b: { papi: true } };
  const ways = roads.filter((r) => r.t === 'taxiway' && (r.w ?? 0) >= 15 && r.p?.length > 1).map((r) => ({ p: r.p, w: r.w }));
  return { centre: mid(rw.line), lights: [...runwayLights(rw), ...taxiLights(ways, [rw])] };
}
/**
 * Václav Havel Prague: `plan` is LKPR_PLAN (js/flight-lkpr.js), `roads` the
 * tile's taxiway lines once streamed. From the eAIP AD 2.14 and AD 2.9:
 *   06/24, 3 715 x 45 m: edge lights every 60 m, yellow the last 600 m;
 *   centreline every 15 m with the colour code; green thresholds, red ends.
 *   24: CAT II/III 900 m with flashers, TDZ 900 m, green wing bars, PAPI left 3 deg.
 *   06: CAT I 480 m with flashers, PAPI left 3 deg.
 *   12/30, 3 250 x 45 m: edge lights as above, no centreline.
 *   30: CAT I 900 m with flashers, green wing bars, PAPI left. 12: SALS 420 m,
 *   PAPI left. 12/30 crosses 06/24 about 55 m past 12's threshold: where one
 *   runway's edge lights would stand on the other's paving they are left out,
 *   while 06/24's centreline (flush in the paving) runs on through.
 *   Taxiways: centreline lights on most; edge lights only on a few named
 *   stretches, which the tile cannot tell apart, so those are left out.
 */
export const LKPR_12_30 = [[-108242.3, -8488.7], [-105640, -6534.3]]; // tile -23_-2 (OSM), 12 the north-west end
/** Prague's two runways as runwayLights() takes them: [06/24 (end a 06), 12/30 (end a 12)]. */
export function lkprRunways(plan) {
  const R = plan.runway;
  const main = { line: [[R.far.x, R.far.z], [R.threshold.x, R.threshold.z]], width: 45, centre: true,
    a: { als: ALS.palsCat1(480, true), papi: true }, b: { als: ALS.cat23(900, true), papi: true, tdz: 900, wbar: true } };
  const cross = { line: LKPR_12_30, width: 45, centre: false,
    a: { als: ALS.sals(420), papi: true }, b: { als: ALS.palsCat1(900, true), papi: true, wbar: true } };
  main.avoid = [cross]; cross.avoid = [main];
  return [main, cross];
}
export function lkprLights(plan, roads = []) {
  const [main, cross] = lkprRunways(plan);
  const ways = roads.filter((r) => r.t === 'taxiway' && (r.w ?? 0) >= 15 && r.p?.length > 1).map((r) => ({ p: r.p, w: r.w }));
  return { centre: mid(main.line), lights: [...runwayLights(main), ...runwayLights(cross), ...taxiCentreLights(ways, [main, cross])] };
}
const mid = (line) => ({ x: (line[0][0] + line[line.length - 1][0]) / 2, z: (line[0][1] + line[line.length - 1][1]) / 2 });

// ---- what a light shows from where the eye is ----------------------------------
/** Does this light's colour depend on the eye or the clock? (the rest are written once) */
export const isDynamic = (L) => !!L.b || L.papi !== undefined || L.flash !== undefined;

/**
 * The colour light `L` shows to an eye at (ex, ey, ez), the lamp standing at
 * height ly, t seconds on the clock, into `out` [r, g, b].
 */
export function lightColour(L, ex, ey, ez, ly, t, out) {
  const back = L.b && (ex - L.x) * L.nx + (ez - L.z) * L.nz < 0;
  let c = back ? L.b : L.c, k = 1;
  if (L.papi !== undefined && !back) {
    const a = Math.atan2(ey - ly, Math.hypot(ex - L.x, ez - L.z));
    let w = (a - L.papi) / PAPI.blend * 0.5 + 0.5;
    w = w < 0 ? 0 : w > 1 ? 1 : w;
    const r = COLOUR.papiRed, h = COLOUR.papiWhite;
    out[0] = r[0] + (h[0] - r[0]) * w; out[1] = r[1] + (h[1] - r[1]) * w; out[2] = r[2] + (h[2] - r[2]) * w;
    return out;
  }
  if (L.flash !== undefined && !back) {
    // twice a second: the sweep takes 0.4 s of the 0.5, each flash 20 ms
    const cyc = (t * 2) % 1, q = (cyc - L.flash * 0.8) / 0.04;
    k = Math.exp(-q * q);
  }
  out[0] = c[0] * k; out[1] = c[1] * k; out[2] = c[2] * k;
  return out;
}
