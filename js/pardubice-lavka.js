import { STEPS, lanes } from './station-layout.js';
import { plate } from './stationkit.js';

// The footbridge at the western end of Pardubice hlavní nádraží (opened 31 May
// 2024): 290 m of covered red steel on concrete piers from the bus terminal to
// the Dukla estate, with moving stairs under red hoops down to platforms 2, 3
// and 4. The shipped tiles hold its line and its lift towers but no deck, so
// it is built here. Station frame (x = u, z = v), y from `ground`; where it
// may be walked is js/station-layout.js (deck, ramps).
const HEAD = 2.9; // roof above the deck

// What is left of [a, b] spans after a gap is cut out of them.
const without = (spans, lo, hi) =>
  spans.flatMap(([a, b]) => (hi <= a || lo >= b ? [[a, b]] : [[a, Math.max(a, lo)], [Math.min(b, hi), b]].filter(([x, y]) => y - x > 0.05)));

export function buildBridge(s, k, Y, ground) {
  const { deck } = s,
    D = deck.y - ground,
    uc = (deck.u0 + deck.u1) / 2,
    wide = deck.u1 - deck.u0,
    long = deck.v1 - deck.v0,
    vc = (deck.v0 + deck.v1) / 2;
  // the deck on its two box girders
  k.box(uc, D - 0.09, vc, wide, 0.18, long, 'concrete');
  for (const side of [-1, 1]) k.box(uc + side * (wide / 2 - 0.22), D - 0.75, vc, 0.44, 1.15, long, 'red');
  k.box(uc, D - 1.3, vc, wide - 0.5, 0.1, long, 'red');
  // its walls: a red parapet and glass to the roof, open where a ramp comes in
  for (const side of [-1, 1]) {
    let spans = [[deck.v0, deck.v1]];
    if (side > 0) for (const f of s.ramps) if (f.axis === 'u') spans = without(spans, f.c - f.half, f.c + f.half);
    for (const [a, b] of spans) {
      const u = uc + (side * wide) / 2;
      k.box(u, D + 0.55, (a + b) / 2, 0.1, 1.1, b - a, 'red');
      k.box(u, D + 1.95, (a + b) / 2, 0.04, 1.7, b - a, 'glass');
    }
  }
  k.box(uc, D + 0.55, deck.v1, wide, 1.1, 0.1, 'red');
  k.box(uc, D + 1.95, deck.v1, wide, 1.7, 0.04, 'glass');
  // the roof, a red hoop every four metres and a lamp under every other one
  k.box(uc, D + HEAD, vc, wide + 0.5, 0.1, long + 0.4, 'steel');
  for (let v = deck.v0 + 2, n = 0; v < deck.v1; v += 4, n++) {
    for (const side of [-1, 1]) k.box(uc + (side * wide) / 2, D + HEAD / 2, v, 0.13, HEAD, 0.13, 'red');
    k.box(uc, D + HEAD - 0.1, v, wide, 0.13, 0.13, 'red');
    if (n % 2) k.box(uc, D + HEAD - 0.08, v + 2, 0.16, 0.05, 1.4, 'led');
  }
  // piers, each pair under a crosshead, standing between the tracks
  for (const v of deck.piers) {
    for (const side of [-1.15, 1.15]) {
      const foot = Y(uc + side, v),
        top = D - 1.35;
      k.box(uc + side, (foot + top) / 2 - 0.2, v, 0.8, top - foot + 0.4, 1.0, 'concrete');
    }
    k.box(uc, D - 1.62, v, wide + 0.2, 0.55, 1.4, 'concrete');
  }

  function ramp(f) {
    const base = f.base - ground,
      rise = D - base,
      length = f.b - f.a,
      dir = Math.sign(length),
      run = Math.abs(length),
      tread = run / STEPS,
      tilt = Math.atan2(rise, run),
      slope = Math.hypot(rise, run),
      mid = (f.a + f.b) / 2,
      my = base + rise / 2;
    const put = (p, y, q, len, h, w, finish, lean = 0) =>
      f.axis === 'u'
        ? k.box(p, y, f.c + q * dir, len, h, w, finish, lean ? { z: lean * dir } : null)
        : k.box(f.c - q * dir, y, p, w, h, len, finish, lean ? { x: -lean * dir } : null);
    const groundAt = (p) => (f.axis === 'u' ? Y(p, f.c) : Y(f.c, p));
    // the red stringers it hangs between, its glass, its roof
    for (const side of [-f.half, f.half]) {
      put(mid, my - 0.2, side, slope, 1.0, 0.14, 'red', tilt);
      put(mid, my + 1.5, side, slope, 2.2, 0.04, 'glass', tilt);
    }
    put(mid, my - 0.72, 0, slope, 0.1, 2 * f.half, 'red', tilt);
    put(mid, my + HEAD - 0.1, 0, slope + 0.6, 0.08, 2 * f.half + 0.4, 'steel', tilt);
    for (let d = 1.2; d < slope; d += 2.6) {
      const t = d / slope,
        p = f.a + length * t,
        y = base + rise * t;
      for (const side of [-f.half, f.half]) put(p, y + HEAD / 2 - 0.1, side, 0.12, HEAD, 0.12, 'red');
      put(p, y + HEAD - 0.16, 0, 0.12, 0.12, 2 * f.half, 'red');
    }
    for (const lane of lanes(f)) {
      const q = (lane.q0 + lane.q1) / 2,
        w = lane.q1 - lane.q0;
      if (lane.move) {
        put(mid, my - 0.28, q, slope, 0.3, w, 'dark', tilt);
        for (const side of [lane.q0 + 0.09, lane.q1 - 0.09]) {
          put(mid, my + 0.4, side, slope, 0.8, 0.07, 'steel', tilt);
          put(mid, my + 0.84, side, slope, 0.07, 0.1, 'dark', tilt);
        }
        put(f.a - dir * 0.3, base + 0.012, q, 0.6, 0.024, w - 0.2, 'steel');
        continue;
      }
      for (let i = 0; i < STEPS; i++) {
        const p = f.a + dir * (i + 0.5) * tread,
          h = base + ((i + 1) * rise) / STEPS;
        put(p, h - 0.13, q, tread + 0.005, 0.26, w, 'step');
        put(p - dir * (tread / 2 - 0.035), h + 0.007, q, 0.07, 0.014, w - 0.12, 'nosing');
      }
    }
    // a pier under its upper half
    const p = f.a + length * 0.6,
      top = base + rise * 0.6 - 0.9,
      foot = groundAt(p);
    put(p, (foot + top) / 2 - 0.2, 0, 0.7, top - foot + 0.4, 2 * f.half - 0.9, 'concrete');
    // where it goes, over its foot and again up on the deck
    const up = { 2: ['sídliště Dukla  ↑', 'terminál B'], 3: ['sídliště Dukla  ↑', 'terminál B'], 4: ['sídliště Dukla  ↑', 'terminál B'], terminal: ['Hlavní nádraží · koleje 1 až 9  ↑', 'sídliště Dukla'], Dukla: ['Hlavní nádraží  ↑', 'terminál B · centrum'] }[f.from];
    const down = { 2: 'Koleje 4 · 5', 3: 'Koleje 6 · 7', 4: 'Koleje 8 · 9', terminal: 'terminál B · hala', Dukla: 'sídliště Dukla' }[f.from];
    const yaw = f.axis === 'u' ? (-dir * Math.PI) / 2 : dir > 0 ? Math.PI : 0;
    const [su, sv] = f.axis === 'u' ? [f.a + dir * 0.6, f.c] : [f.c, f.a + dir * 0.6];
    k.sign(su + Math.sin(yaw) * 0.08, base + 2.62, sv + Math.cos(yaw) * 0.08, 2 * f.half - 0.2, 0.62, yaw, 512, plate(up, '#f4f2ea', '#1b2f55'), 'up' + f.from);
    if (f.axis === 'u') {
      k.box(uc, D + 2.42, f.c, 2.5, 0.42, 0.05, 'navy');
      k.sign(uc, D + 2.42, f.c - 0.03, 2.4, 0.36, Math.PI, 384, plate(['←  ' + down]), 'downA' + f.from);
      k.sign(uc, D + 2.42, f.c + 0.03, 2.4, 0.36, 0, 384, plate([down + '  →']), 'downB' + f.from);
    }
  }
  for (const f of s.ramps) ramp(f);
}
