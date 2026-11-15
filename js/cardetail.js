// ---- cardetail.js: what makes each kind ITS kind ---------------------------
// carbody.js knows how to make smooth sheet metal and how to lay a flat drawing
// onto it. This file is the drawings: glass, pillars, lamp clusters, grilles,
// shut lines, handles, mirrors, exhausts, and for the working vehicles the
// doors, destination box and cargo body. One function per kind, written the
// way the old DETAIL table was, so the brand cues sit next to each other and
// can be compared: the Octavia's wide slit grille against the BMW's kidneys,
// the Tesla's bare nose, the Mercedes' louvres.
//
// buildCar() returns TWO sets of geometry per kind. `near` is the full car
// (about 7k triangles with its wheels). `far` is the same recipe run coarse,
// with the small parts left out, the glass folded into the vertex-coloured
// mesh and the four wheels baked in as static drums: four draw calls and
// about a thousand triangles for a car that is 60 m away.

import * as THREE from 'three';
import { Soup, makeShape, buildHull, drape, rect, rrect, ellipse } from './carbody.js';
import { wheelGeo } from './carwheels.js';
import { TRANSIT_BODY } from './transitbody.js';

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
// fixed-colour finishes: linear rgb, roughness, metalness
const M = {
  dark: { c: lin(0x0d0f12), r: 0.60, m: 0 },        // grained bumper plastic
  gloss: { c: lin(0x040506), r: 0.10, m: 0 },       // piano black: pillars, grille, frit
  liner: { c: lin(0x060708), r: 0.95, m: 0 },       // wheel well
  chrome: { c: lin(0xe4e8ec), r: 0.09, m: 1 },
  satin: { c: lin(0xaeb4bb), r: 0.34, m: 0.9 },
  lens: { c: lin(0x14171c), r: 0.05, m: 0.4 },      // headlamp: black bezel under a clear cover
  ruby: { c: lin(0x4a0609), r: 0.07, m: 0.15 },     // tail lamp lens, unlit
  amber: { c: lin(0xc8690f), r: 0.25, m: 0 },
  white: { c: lin(0xe9eae6), r: 0.5, m: 0 },
  cargo: { c: lin(0xc3c6c1), r: 0.62, m: 0 },
  glassFar: { c: lin(0x0a0e13), r: 0.05, m: 0 },
  mirror: { c: lin(0x9fb0c2), r: 0.04, m: 1 },
  rubber: { c: lin(0x101113), r: 0.9, m: 0 },
};

// Exterior-only knobs per kind. `sts` restyles the nose and tail stations (the
// stations in vehicles.js stay as they are: the cabin is cut from them), and
// only ever OUTWARD of the originals so the interior still fits inside.
export const STYLE = {
  octavia: {
    wheel: 'five', sweepF: 0.15, sweepR: 0.08,
    sts: [[-2.35, 0.27, 0.60, 0.70], [-2.27, 0.21, 0.69, 0.86], [-1.95, 0.18, 0.76, 0.94],
      [-1.10, 0.16, 0.84, 0.99], [-0.65, 0.16, 0.88, 1.00], [0.60, 0.16, 0.90, 1.00],
      [1.55, 0.16, 0.93, 0.975], [2.12, 0.20, 0.93, 0.91], [2.30, 0.24, 0.90, 0.84], [2.35, 0.30, 0.84, 0.78]],
  },
  fabia: {
    wheel: 'five', sweepF: 0.14, sweepR: 0.07,
    sts: [[-2.05, 0.27, 0.60, 0.72], [-1.97, 0.21, 0.68, 0.87], [-1.70, 0.18, 0.74, 0.94],
      [-0.95, 0.16, 0.80, 0.99], [-0.50, 0.16, 0.84, 1.00], [0.55, 0.16, 0.86, 1.00],
      [1.30, 0.16, 0.88, 0.98], [1.85, 0.20, 0.88, 0.94], [2.01, 0.24, 0.86, 0.89], [2.05, 0.30, 0.80, 0.84]],
  },
  bmw: {
    wheel: 'star', sweepF: 0.15, sweepR: 0.08,
    sts: [[-2.35, 0.25, 0.58, 0.72], [-2.27, 0.19, 0.66, 0.87], [-1.90, 0.17, 0.72, 0.945],
      [-1.05, 0.15, 0.80, 0.99], [-0.45, 0.15, 0.84, 1.00], [0.70, 0.15, 0.86, 1.00],
      [1.55, 0.15, 0.88, 0.975], [2.12, 0.19, 0.87, 0.92], [2.30, 0.23, 0.84, 0.85], [2.35, 0.29, 0.78, 0.80]],
  },
  mercedes: {
    wheel: 'multi', sweepF: 0.16, sweepR: 0.09,
    sts: [[-2.45, 0.26, 0.60, 0.71], [-2.37, 0.20, 0.69, 0.86], [-2.00, 0.17, 0.75, 0.945],
      [-1.10, 0.16, 0.82, 0.99], [-0.55, 0.16, 0.87, 1.00], [0.65, 0.16, 0.89, 1.00],
      [1.60, 0.16, 0.91, 0.975], [2.20, 0.20, 0.90, 0.92], [2.40, 0.24, 0.86, 0.85], [2.45, 0.30, 0.80, 0.80]],
  },
  tesla: {
    wheel: 'aero', sweepF: 0.17, sweepR: 0.09, fender: 0.075,
    sts: [[-2.35, 0.26, 0.54, 0.68], [-2.27, 0.19, 0.62, 0.85], [-1.90, 0.16, 0.69, 0.945],
      [-1.15, 0.15, 0.78, 0.99], [-0.70, 0.15, 0.83, 1.00], [0.60, 0.15, 0.86, 1.00],
      [1.55, 0.15, 0.88, 0.975], [2.10, 0.19, 0.88, 0.92], [2.30, 0.23, 0.86, 0.85], [2.35, 0.28, 0.80, 0.80]],
  },
  van: {
    wheel: 'steel', sweepF: 0.10, sweepR: 0.04, crown: 0.03, beltIn: 0.985, gbK: 1.045, gtK: 1.08, badgeFy: 0.715, slab: true,
    sts: [[-2.40, 0.32, 0.84, 0.80], [-2.30, 0.25, 0.94, 0.92], [-2.00, 0.22, 1.00, 0.98],
      [-1.60, 0.20, 1.04, 1.00], [1.80, 0.20, 1.06, 1.00], [2.28, 0.24, 1.05, 0.985],
      [2.40, 0.28, 1.03, 0.96]],
  },
  truck: { wheel: 'steel', sweepF: 0.07, sweepR: 0.0, roofR: 0.16, arches: 'front', archGap: 0.08, sweepLenF: 0.45 },
  semi: { wheel: 'steel', sweepF: 0.07, sweepR: 0.0, roofR: 0.16, arches: 'front', archGap: 0.08, sweepLenF: 0.45 },
  bus: { wheel: 'steel', sweepF: 0.07, sweepR: 0.05, roofR: 0.20, archGap: 0.07, crown: 0.05, sweepLenF: 0.5, sweepLenR: 0.45 },
  trolleybus: { wheel: 'steel', sweepF: 0.06, sweepR: 0.05, roofR: 0.16, archGap: 0.07, crown: 0.04, sweepLenF: 0.5, sweepLenR: 0.45 },
};

// ---- the drawing context ---------------------------------------------------
// One per (kind, lod). The distance variant lifts every patch a further 2 cm
// and tessellates coarsely: its hull is coarse too, and the two chord errors
// must not be allowed to bury a lamp under the paint.
function context(K, S, lod) {
  const c = {
    K, S, lod,
    paint: new Soup(), glass: lod ? null : new Soup(), detail: new Soup(true),
    head: new Soup(), tail: new Soup(), brake: lod ? null : new Soup(),
  };
  c.head.g = []; c.tail.g = [];
  const E = lod ? 0.022 : 0;
  // Stretches where the plan is dead straight (a bus is, for nine metres): a
  // side patch that lies wholly inside one needs no columns along the car.
  const sts = S.style.sts ?? K.hull.sts, flat = [];
  for (let i = 0; i < sts.length - 1; i++) if (Math.abs(sts[i][3] - sts[i + 1][3]) < 1e-6) flat.push([sts[i][0], sts[i + 1][0]]);
  const o2 = (view, poly, o) => {
    let hu = lod ? Math.max(0.3, o.hu ?? 0) : o.hu;
    if (view === 'side') {
      let a = Infinity, b = -Infinity;
      for (const q of poly) { a = Math.min(a, q[0]); b = Math.max(b, q[0]); }
      for (const f of flat) if (a >= f[0] - 1e-6 && b <= f[1] + 1e-6) hu = 1e6;
    }
    return { ...o, zs: c.zs, eps: (o.eps ?? 0.004) + E, h: lod ? Math.max(0.22, o.h ?? 0) : (o.h ?? 0.07), hu };
  };
  c.put = (soup, view, poly, mat, o = {}) => { if (soup) drape(soup, S, view, poly, mat, o2(view, poly, o)); };
  // a long horizontal band on the flank, cut at the ends of the straight run
  // so the middle is one quad and only the curved ends are tessellated
  c.band = (soup, za, zb, y0, y1, mat, o = {}) => {
    const cuts = [za, zb];
    for (const f of flat) for (const z of f) if (z > za + 0.05 && z < zb - 0.05) cuts.push(z);
    cuts.sort((p, q) => p - q);
    for (let i = 0; i < cuts.length - 1; i++) c.put(soup, 'side', rect(cuts[i], y0, cuts[i + 1], y1), mat, o);
  };
  c.d = (view, poly, mat, o = {}) => c.put(c.detail, view, poly, mat, o);      // fixed-colour trim
  // the black surround under a pane: at distance the pane alone says "window"
  c.frame = (view, poly, mat, o = {}) => { if (!lod) c.put(c.detail, view, poly, mat, o); };
  c.g = (view, poly, o = {}) => (lod                                             // glass
    ? c.put(c.detail, view, poly, M.glassFar, { ...o, eps: (o.eps ?? 0.006) })
    : c.put(c.glass, view, poly, null, { eps: 0.007, ...o }));
  c.near = (fn) => { if (!lod) fn(); };
  return c;
}

const box = (w, h, l, x, y, z, ry = 0, rx = 0) => {
  const g = new THREE.BoxGeometry(w, h, l);
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return g;
};
const cylZ = (r, len, x, y, z, seg = 10) => {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, z);
  return g;
};

// ---- greenhouse: glass, frit, pillars --------------------------------------
// The body under the glass is plain paint; the windows are dark patches laid
// on it, and the pillars are simply where no patch is. A gloss-black surround
// goes down first and the panes sit inside it, which is the window frame and
// the screen's ceramic band in one move.
function greenhouse(c, p = {}) {
  const { S } = c, G = S.green;
  if (!G) return null;
  const gs = c.K.green.sts, n = gs.length;
  const belt = (z) => S.yShoulder(z);
  const hR = (z) => G.roof(z) - belt(z);
  const edge = (z) => S.edgeAt(z, 9)[0];
  // ---- windscreen (drawn in plan) ----
  const w0 = G.z0 + 0.04, w1 = G.z0 + (G.hdrZ - G.z0) * (p.screenTop ?? 0.9);
  const sx0 = edge(w0) - 0.02, sx1 = edge(w1) - 0.015;
  c.frame('top', [[-sx0, w0], [sx0, w0], [sx1, w1], [-sx1, w1]], M.gloss, { eps: 0.003, h: 0.12, hu: 0.3 });
  c.g('top', [[-sx0 + 0.022, w0 + 0.03], [sx0 - 0.022, w0 + 0.03], [sx1 - 0.022, w1 - 0.022], [-sx1 + 0.022, w1 - 0.022]],
    { h: 0.12, hu: 0.26 });
  // ---- backlight ----
  if (!c.K.green.capEnd) {
    const b0 = G.cZ + (G.z1 - G.cZ) * (p.backTop ?? 0.20), b1 = G.z1 - (p.backEnd ?? 0.05);
    const bx0 = edge(b0) - 0.03, bx1 = edge(b1) - (p.backIn ?? 0.05);
    c.frame('top', [[-bx0, b0], [bx0, b0], [bx1, b1], [-bx1, b1]], M.gloss, { eps: 0.003, h: 0.12, hu: 0.3 });
    c.g('top', [[-bx0 + 0.022, b0 + 0.022], [bx0 - 0.022, b0 + 0.022], [bx1 - 0.022, b1 - 0.03], [-bx1 + 0.022, b1 - 0.03]],
      { h: 0.12, hu: 0.26 });
    // high-level brake light: a slim bar at the top of the glass
    c.near(() => c.put(c.brake, 'top', rect(-0.16, b0 + 0.03, 0.16, b0 + 0.05), null, { eps: 0.009 }));
  }
  // ---- side glass (drawn in side view) ----
  const drop = 0.082;                         // the cant rail above the glass
  let zs0 = G.z0;
  for (let k = 1; k <= 40; k++) { zs0 = G.z0 + (G.hdrZ - G.z0) * k / 40; if (hR(zs0) >= (p.sideStart ?? 0.17)) break; }
  const zB0 = gs[2][0] - 0.01, zB1 = n > 4 ? gs[3][0] + 0.01 : zB0;
  // where the daylight opening ends: the roof has come down to `sideEnd` above the belt
  let zE = zB1;
  if (n > 4) {
    const zMax = G.cZ + (G.z1 - G.cZ) * (p.sideBack ?? 0.42);
    for (let k = 0; k <= 60; k++) {
      const z = zB1 + (zMax - zB1) * k / 60;
      if (hR(z) - drop < (p.sideEnd ?? 0.10)) break;
      zE = z;
    }
  } else zE = zB0;
  const pane = (za, zb, inset, lift) => {
    const pts = [[za, belt(za) + lift], [zb, belt(zb) + lift]];
    const m = 10;
    for (let k = 0; k <= m; k++) { const z = zb + (za - zb) * k / m; pts.push([z, belt(z) + hR(z) - drop - inset]); }
    return pts;
  };
  c.frame('side', pane(zs0 - 0.03, zE + 0.025, -0.022, 0.0), p.frame ?? M.gloss, { mirror: true, eps: 0.003, h: 0.16, hu: 0.3 });
  c.g('side', pane(zs0, zB0, 0, 0.022), { mirror: true, h: 0.16, hu: 0.24 });
  if (n > 4 && zE > zB1 + 0.1) c.g('side', pane(zB1, zE, 0, 0.022), { mirror: true, h: 0.16, hu: 0.24 });
  if (p.beltChrome) c.near(() => c.d('side', [[zs0 - 0.03, belt(zs0 - 0.03) - 0.004], [zE + 0.025, belt(zE + 0.025) - 0.004],
    [zE + 0.025, belt(zE + 0.025) + 0.012], [zs0 - 0.03, belt(zs0 - 0.03) + 0.012]], M.chrome, { mirror: true, eps: 0.0075, h: 0.3, hu: 0.25 }));
  return { zs0, zB0, zB1, zE, belt, hR, edge };
}

// ---- lamp clusters ---------------------------------------------------------
// A quad in front elevation: inner edge at xi spanning yi0..yi1, outer edge at
// xo spanning yo0..yo1 (the outer end wraps the bumper corner by itself, since
// the projection follows the body). Housing first, then the light signature.
function headlamp(c, xi, xo, yi0, yi1, yo0, yo1, o = {}) {
  const quad = (a) => [[xi + a, yi0 + a], [xo - a, yo0 + a], [xo - a, yo1 - a], [xi + a, yi1 - a]];
  c.d('front', quad(0), M.lens, { mirror: true, eps: 0.004, h: 0.05, hu: 0.065 });
  // daytime running strip along one edge
  const t = o.drlT ?? 0.016, top = o.drl === 'top';
  const e0 = top ? [yi1, yo1] : [yi0, yo0], sg = top ? -1 : 1;
  c.put(c.head, 'front', [[xi + 0.015, e0[0] + sg * 0.008], [xo - 0.02, e0[1] + sg * 0.008],
    [xo - 0.02, e0[1] + sg * (0.008 + t)], [xi + 0.015, e0[0] + sg * (0.008 + t)]], null, { mirror: true, eps: 0.0075, h: 0.05, hu: 0.06 });
  // projectors: lit only after dark (gate 1)
  const nP = o.proj ?? 2, ym = (f) => (yi0 + yi1) / 2 + ((yo0 + yo1) / 2 - (yi0 + yi1) / 2) * f - sg * 0.006;
  const rad = Math.min(0.034, (Math.min(yi1 - yi0, yo1 - yo0)) * 0.3);
  c.near(() => {
    for (let k = 0; k < nP; k++) {
      const f = (k + 0.7) / (nP + 0.6);
      c.put(c.head, 'front', ellipse(xi + (xo - xi) * f, ym(f), rad, rad, 10), null, { mirror: true, eps: 0.0075, gate: 1, h: 0.04, hu: 0.04 });
    }
  });
  if (c.lod) c.put(c.head, 'front', quad(0.012), null, { mirror: true, eps: 0.0075, gate: 1 });
}
function taillamp(c, xi, xo, yi0, yi1, yo0, yo1, o = {}) {
  const quad = (a, b = a) => [[xi + b, yi0 + a], [xo - b, yo0 + a], [xo - b, yo1 - a], [xi + b, yi1 - a]];
  c.d('rear', quad(0), M.ruby, { mirror: true, eps: 0.004, h: 0.05, hu: 0.065 });
  // night signature: a band along the top of the cluster
  const t = o.t ?? Math.max(0.026, (Math.min(yi1 - yi0, yo1 - yo0)) * 0.38);
  c.put(c.tail, 'rear', [[xi + 0.012, yi1 - 0.008 - t], [xo - 0.012, yo1 - 0.008 - t], [xo - 0.012, yo1 - 0.008], [xi + 0.012, yi1 - 0.008]],
    null, { mirror: true, eps: 0.0075, gate: 0.9, h: 0.05, hu: 0.06 });
  if (c.lod) c.put(c.tail, 'rear', quad(0.01), null, { mirror: true, eps: 0.0075, gate: 0.9 });
  // brake element: the lower half of the cluster, hidden until the car slows
  c.near(() => c.put(c.brake, 'rear', [[xi + 0.02, yi0 + 0.012], [xo - 0.02, yo0 + 0.012], [xo - 0.02, (yo0 + yo1) / 2 + 0.004], [xi + 0.02, (yi0 + yi1) / 2 + 0.004]],
    null, { mirror: true, eps: 0.0095, h: 0.05, hu: 0.06 }));
}

// ---- flanks: shut lines, handles, mirrors, sill ---------------------------
function flanks(c, gh, p = {}) {
  const { S, K } = c;
  const ax = S.arches;
  const yLo = (z) => S.fLo(z);
  const archTop = (z) => {
    let y = 0;
    for (const a of ax) { const d = z - a; if (Math.abs(d) < S.R) y = Math.max(y, S.wheelR + Math.sqrt(S.R * S.R - d * d)); }
    return y;
  };
  const line = (z, y0, y1) => c.d('side', rect(z - 0.0045, y0, z + 0.0045, y1), M.gloss, { mirror: true, eps: 0.0025, h: 0.09 });
  c.near(() => {
    const zs = p.lines ?? [gh.zs0 - 0.10, (gh.zB0 + gh.zB1) / 2, gh.zE + (p.rearLine ?? 0.0)];
    for (const z of zs) line(z, Math.max(yLo(z) + 0.05, archTop(z) + 0.035), gh.belt(z) - 0.012);
    // handles: a dark recess and a body-colour grip standing proud of it
    const hy = (z) => gh.belt(z) - (p.handleDrop ?? 0.085);
    for (const z of p.handles ?? [gh.zB0 - 0.17, gh.zE - 0.20]) {
      if (p.flushHandles) {
        c.d('side', rect(z - 0.08, hy(z) - 0.011, z + 0.08, hy(z) + 0.011), M.chrome, { mirror: true, eps: 0.003, h: 0.05, hu: 0.2 });
      } else {
        c.d('side', rect(z - 0.095, hy(z) - 0.03, z + 0.095, hy(z) + 0.026), M.dark, { mirror: true, eps: 0.003, h: 0.06, hu: 0.2 });
        c.put(c.paint, 'side', rect(z - 0.085, hy(z) - 0.004, z + 0.085, hy(z) + 0.02), null, { mirror: true, eps: 0.016, h: 0.06, hu: 0.2 });
      }
    }
  });
  // sill: unpainted plastic between the arches (vans, city cars)
  if (p.sill && ax.length > 1) {
    const z0 = ax[0] + S.R + 0.02, z1 = ax[1] - S.R - 0.02;
    c.d('side', [[z0, yLo(z0) + 0.012], [z1, yLo(z1) + 0.012], [z1, yLo(z1) + p.sill], [z0, yLo(z0) + p.sill]], M.dark,
      { mirror: true, eps: 0.004, h: 0.08, hu: 0.3 });
  }
  // mirrors: a pebble on a short stalk at the foot of the A-pillar
  const mz = p.mirrorZ ?? gh.zs0 + 0.04, my = gh.belt(mz) + (p.mirrorY ?? 0.075);
  const mx = S.halfAt(mz, gh.belt(mz) + 0.03);
  const ms = p.mirrorS ?? 1;
  for (const sg of [1, -1]) {
    const head = new THREE.SphereGeometry(1, c.lod ? 5 : 10, c.lod ? 3 : 7);
    head.scale(0.095 * ms, 0.062 * ms, 0.05 * ms);
    head.translate(sg * (mx + 0.115 * ms), my, mz);
    c.paint.add(head);
    if (!c.lod) {
      c.detail.add(box(0.11, 0.02, 0.045, sg * (mx + 0.03), my - 0.035, mz), M.dark);
      // the mirror glass: a bright sliver facing back
      const gl = new THREE.CircleGeometry(1, 8);
      gl.scale(0.075 * ms, 0.045 * ms, 1);
      gl.translate(sg * (mx + 0.115 * ms), my, mz + 0.047 * ms);
      c.detail.add(gl, M.mirror);
    }
  }
}

// shark fin on the roof, body colour
function fin(c, z, len = 0.17, h = 0.055) {
  if (c.lod) return;
  const y = c.S.topAt(z, 0) - 0.004, s = c.paint, w = 0.022;
  const b = s.base();
  const v = [[-w, y, z - len * 0.55], [w, y, z - len * 0.55], [w, y, z + len * 0.45], [-w, y, z + len * 0.45],
    [0, y + h * 0.25, z - len * 0.5], [0, y + h, z + len * 0.3]].map((q, k) => s.v(q[0], q[1], q[2], b + k));
  s.tri(v[0], v[4], v[5], -1, 0.3, 0); s.tri(v[0], v[5], v[3], -1, 0.3, 0);
  s.tri(v[1], v[5], v[4], 1, 0.3, 0); s.tri(v[1], v[2], v[5], 1, 0.3, 0);
  s.tri(v[3], v[5], v[2], 0, 0.2, 1); s.tri(v[0], v[1], v[4], 0, 0.2, -1);
}

// wipers parked along the screen base
function wipers(c, gh) {
  if (c.lod) return;
  const z = c.S.green.z0 + 0.075;
  for (const [x0, x1] of [[-0.62, -0.08], [0.02, 0.50]]) {
    c.d('top', [[x0, z + 0.035], [x1, z - 0.006], [x1, z + 0.012], [x0, z + 0.05]], M.dark, { eps: 0.014, h: 0.2, hu: 0.14 });
  }
}

// number-plate recess + lower trims shared by every car face
function plinth(c, rear, y, w = 0.56, h = 0.15) {
  c.near(() => c.d(rear ? 'rear' : 'front', rrect(-w / 2, y - h / 2, w / 2, y + h / 2, 0.012, 2), M.dark, { eps: 0.003, h: 0.08, hu: 0.14 }));
}

// ---- the kinds -------------------------------------------------------------
const DRESS = {
  // Škoda Octavia IV: wide hexagonal grille pulled up to the bonnet edge, slim
  // lamps that touch it, a crystalline C-shaped tail lamp, liftback glass
  octavia(c) {
    const gh = greenhouse(c, { sideBack: 0.5 });
    flanks(c, gh, {});
    fin(c, 1.15); wipers(c, gh);
    headlamp(c, 0.44, 0.83, 0.585, 0.665, 0.60, 0.685, { drl: 'top' });
    const gy0 = 0.43, gy1 = 0.655;
    c.d('front', [[-0.36, gy0], [0.36, gy0], [0.43, gy0 + 0.11], [0.40, gy1], [-0.40, gy1], [-0.43, gy0 + 0.11]], M.chrome, { eps: 0.003, h: 0.05, hu: 0.1 });
    c.d('front', [[-0.345, gy0 + 0.014], [0.345, gy0 + 0.014], [0.412, gy0 + 0.11], [0.385, gy1 - 0.014], [-0.385, gy1 - 0.014], [-0.412, gy0 + 0.11]], M.gloss, { eps: 0.0055, h: 0.05, hu: 0.1 });
    c.near(() => { for (let k = -6; k <= 6; k++) if (k) c.d('front', rect(k * 0.055 - 0.005, gy0 + 0.03, k * 0.055 + 0.005, gy1 - 0.028), M.satin, { eps: 0.0075, h: 0.08 }); });
    c.d('front', [[-0.50, 0.245], [0.50, 0.245], [0.58, 0.36], [-0.58, 0.36]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.near(() => c.d('front', [[0.60, 0.275], [0.73, 0.29], [0.73, 0.345], [0.60, 0.335]], M.gloss, { mirror: true, eps: 0.004, h: 0.05, hu: 0.07 }));
    plinth(c, false, c.K.plateF, 0.56, 0.14);
    taillamp(c, 0.36, 0.80, 0.69, 0.80, 0.71, 0.835);
    plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.62, 0.30], [0.62, 0.30], [0.56, 0.40], [-0.56, 0.40]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    c.near(() => {
      c.d('rear', rect(-0.80, 0.655, 0.80, 0.664), M.gloss, { eps: 0.0025, h: 0.05, hu: 0.1 });
      c.d('rear', rect(0.64, 0.42, 0.78, 0.45), M.ruby, { mirror: true, eps: 0.004, h: 0.05 });
    });
  },
  fabia(c) {
    const gh = greenhouse(c, { sideBack: 0.55, sideEnd: 0.16, backTop: 0.14 });
    flanks(c, gh, { sill: 0.07 });
    fin(c, 1.20, 0.14, 0.05); wipers(c, gh);
    headlamp(c, 0.42, 0.80, 0.575, 0.665, 0.60, 0.69, { drl: 'bottom' });
    const gy0 = 0.44, gy1 = 0.645;
    c.d('front', [[-0.33, gy0], [0.33, gy0], [0.40, gy0 + 0.10], [0.37, gy1], [-0.37, gy1], [-0.40, gy0 + 0.10]], M.chrome, { eps: 0.003, h: 0.05, hu: 0.1 });
    c.d('front', [[-0.315, gy0 + 0.014], [0.315, gy0 + 0.014], [0.382, gy0 + 0.10], [0.355, gy1 - 0.014], [-0.355, gy1 - 0.014], [-0.382, gy0 + 0.10]], M.gloss, { eps: 0.0055, h: 0.05, hu: 0.1 });
    c.near(() => { for (let k = -5; k <= 5; k++) if (k) c.d('front', rect(k * 0.058 - 0.005, gy0 + 0.03, k * 0.058 + 0.005, gy1 - 0.028), M.satin, { eps: 0.0075, h: 0.08 }); });
    c.d('front', [[-0.46, 0.245], [0.46, 0.245], [0.54, 0.36], [-0.54, 0.36]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    plinth(c, false, c.K.plateF, 0.56, 0.14);
    // upright lamps either side of the hatch
    taillamp(c, 0.50, 0.78, 0.62, 0.86, 0.66, 0.86, { t: 0.03 });
    plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.66, 0.29], [0.66, 0.29], [0.62, 0.42], [-0.62, 0.42]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
  },
  // BMW 3: twin kidneys, slim lamps with two hexagonal light guides, L tail lamps
  bmw(c) {
    const gh = greenhouse(c, { sideBack: 0.38, sideEnd: 0.14, beltChrome: false, backEnd: 0.06 });
    flanks(c, gh, {});
    fin(c, 1.10); wipers(c, gh);
    headlamp(c, 0.42, 0.84, 0.555, 0.635, 0.575, 0.65, { drl: 'bottom', proj: 2 });
    for (const sg of [1, -1]) {
      const k = (a) => [[0.035, 0.42 + a], [0.30 - a, 0.44 + a], [0.34 - a, 0.53], [0.30 - a, 0.63 - a], [0.035, 0.635 - a]].map((q) => [q[0] * sg, q[1]]);
      c.d('front', k(0), M.chrome, { eps: 0.003, h: 0.05, hu: 0.08 });
      c.d('front', k(0.016).map((q) => [q[0] + sg * 0.014, q[1]]), M.gloss, { eps: 0.0055, h: 0.05, hu: 0.08 });
      c.near(() => { for (let j = 1; j <= 4; j++) c.d('front', rect(sg * (0.035 + j * 0.052) - 0.004, 0.455, sg * (0.035 + j * 0.052) + 0.004, 0.605), M.satin, { eps: 0.0075, h: 0.08 }); });
    }
    c.d('front', [[-0.40, 0.235], [0.40, 0.235], [0.44, 0.34], [-0.44, 0.34]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.d('front', [[0.52, 0.25], [0.74, 0.28], [0.74, 0.37], [0.52, 0.345]], M.gloss, { mirror: true, eps: 0.004, h: 0.05, hu: 0.07 });
    plinth(c, false, c.K.plateF, 0.56, 0.13);
    taillamp(c, 0.30, 0.83, 0.67, 0.745, 0.66, 0.775, { t: 0.022 });
    plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.66, 0.26], [0.66, 0.26], [0.60, 0.37], [-0.60, 0.37]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    c.near(() => {
      c.d('rear', rect(-0.82, 0.65, 0.82, 0.659), M.gloss, { eps: 0.0025, h: 0.05, hu: 0.1 });
      for (const x of [-0.50, 0.50]) c.detail.add(cylZ(0.042, 0.10, x, 0.30, c.S.z1 - 0.03, 12), M.chrome);
    });
  },
  // Mercedes E: a wide two-louvre grille with the star in it, swept lamps, a
  // chrome belt, long horizontal tail lamps
  mercedes(c) {
    const gh = greenhouse(c, { sideBack: 0.40, sideEnd: 0.13, beltChrome: true });
    flanks(c, gh, {});
    fin(c, 1.22); wipers(c, gh);
    headlamp(c, 0.46, 0.85, 0.575, 0.66, 0.60, 0.69, { drl: 'top', proj: 2 });
    c.d('front', rrect(-0.42, 0.42, 0.42, 0.655, 0.07, 3), M.chrome, { eps: 0.003, h: 0.05, hu: 0.1 });
    c.d('front', rrect(-0.402, 0.436, 0.402, 0.639, 0.058, 3), M.gloss, { eps: 0.0055, h: 0.05, hu: 0.1 });
    c.near(() => { for (const y of [0.50, 0.575]) for (const sg of [1, -1]) c.d('front', rect(sg > 0 ? 0.13 : -0.39, y - 0.011, sg > 0 ? 0.39 : -0.13, y + 0.011), M.chrome, { eps: 0.0075, h: 0.05, hu: 0.1 }); });
    c.d('front', [[-0.52, 0.24], [0.52, 0.24], [0.60, 0.35], [-0.60, 0.35]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.near(() => c.d('front', rect(-0.52, 0.262, 0.52, 0.274), M.chrome, { eps: 0.0065, h: 0.05, hu: 0.12 }));
    plinth(c, false, c.K.plateF, 0.56, 0.13);
    taillamp(c, 0.26, 0.84, 0.69, 0.775, 0.69, 0.80, { t: 0.02 });
    plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.66, 0.27], [0.66, 0.27], [0.60, 0.37], [-0.60, 0.37]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
    c.near(() => {
      c.d('rear', rect(-0.60, 0.385, 0.60, 0.398), M.chrome, { eps: 0.0055, h: 0.05, hu: 0.14 });
      for (const sg of [1, -1]) c.d('rear', rrect(sg * 0.50 - 0.10, 0.285, sg * 0.50 + 0.10, 0.345, 0.02, 2), M.chrome, { eps: 0.0065, h: 0.05, hu: 0.07 });
    });
  },
  // Tesla Model 3: no grille at all, a small lower intake, teardrop lamps, one
  // glass canopy from the header to the boot, flush chrome handles
  tesla(c) {
    const gh = greenhouse(c, { sideBack: 0.5, sideEnd: 0.12, frame: M.gloss });
    flanks(c, gh, { flushHandles: true });
    wipers(c, gh);
    // the glass roof: header to the backlight in one piece
    const G = c.S.green, r0 = G.hdrZ + 0.10, r1 = G.cZ + (G.z1 - G.cZ) * 0.12;
    const rx = (z) => gh.edge(z) - 0.06;
    c.g('top', [[-rx(r0), r0], [rx(r0), r0], [rx(r1), r1], [-rx(r1), r1]], { h: 0.2, hu: 0.25 });
    headlamp(c, 0.50, 0.84, 0.56, 0.60, 0.55, 0.655, { drl: 'top', proj: 1 });
    c.d('front', [[-0.40, 0.235], [0.40, 0.235], [0.47, 0.31], [-0.47, 0.31]], M.dark, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.near(() => c.d('front', [[0.56, 0.255], [0.73, 0.28], [0.73, 0.345], [0.56, 0.325]], M.gloss, { mirror: true, eps: 0.004, h: 0.05, hu: 0.07 }));
    plinth(c, false, c.K.plateF, 0.54, 0.13);
    taillamp(c, 0.34, 0.83, 0.70, 0.765, 0.69, 0.80, { t: 0.02 });
    plinth(c, true, c.K.plateR);
    c.d('rear', [[-0.62, 0.25], [0.62, 0.25], [0.56, 0.35], [-0.56, 0.35]], M.dark, { eps: 0.004, h: 0.05, hu: 0.14 });
  },
  // panel van: tall upright lamps, a grey bumper that wraps the corners, rub
  // strips down the flank, blind panels behind the cab, two rear door windows
  van(c) {
    const gh = greenhouse(c, { sideStart: 0.22 });
    flanks(c, gh, { sill: 0.10, lines: [gh.zs0 - 0.12, gh.zB0 + 0.07, 0.62, 1.58], handles: [gh.zB0 - 0.10, 0.50], handleDrop: 0.12, mirrorS: 1.35, mirrorY: 0.12 });
    wipers(c, gh);
    c.band(c.detail, -1.15, 1.15, 0.50, 0.585, M.dark, { mirror: true, eps: 0.006, h: 0.09, hu: 0.4 });      // rub strip
    c.near(() => c.d('side', rect(0.66, 1.10, 1.95, 1.118), M.dark, { flip: false, eps: 0.004, h: 0.09, hu: 0.4 }));   // slider rail
    headlamp(c, 0.52, 0.86, 0.66, 0.84, 0.70, 0.90, { drl: 'bottom', proj: 2, drlT: 0.02 });
    c.d('front', rrect(-0.46, 0.63, 0.46, 0.80, 0.03, 2), M.gloss, { eps: 0.004, h: 0.05, hu: 0.12 });
    c.near(() => { for (const y of [0.69, 0.745]) c.d('front', rect(-0.44, y - 0.008, 0.44, y + 0.008), M.satin, { eps: 0.0065, h: 0.05, hu: 0.12 }); });
    c.d('front', [[-0.93, 0.30], [0.93, 0.30], [0.93, 0.56], [-0.93, 0.56]], M.dark, { eps: 0.004, h: 0.06, hu: 0.07 });   // bumper
    plinth(c, false, c.K.plateF, 0.56, 0.13);
    // rear: barn doors
    c.d('rear', [[-0.92, 0.30], [0.92, 0.30], [0.92, 0.50], [-0.92, 0.50]], M.dark, { eps: 0.004, h: 0.06, hu: 0.1 });
    taillamp(c, 0.76, 0.875, 0.72, 1.16, 0.72, 1.16, { t: 0.05 });
    for (const sg of [1, -1]) {
      c.d('rear', rrect(sg > 0 ? 0.08 : -0.70, 1.20, sg > 0 ? 0.70 : -0.08, 1.72, 0.05, 2), M.gloss, { eps: 0.003, h: 0.1, hu: 0.2 });
      c.g('rear', rrect(sg > 0 ? 0.10 : -0.68, 1.22, sg > 0 ? 0.68 : -0.10, 1.70, 0.04, 2), { h: 0.1, hu: 0.2 });
    }
    c.near(() => {
      c.d('rear', rect(-0.005, 0.52, 0.005, 1.86), M.gloss, { eps: 0.0025, h: 0.12 });
      c.d('rear', rect(-0.10, 0.98, -0.03, 1.01), M.dark, { eps: 0.008, h: 0.1 });
      c.put(c.brake, 'rear', rect(-0.14, 1.80, 0.14, 1.82), null, { eps: 0.009 });
    });
    plinth(c, true, c.K.plateR);
  },
};

// cab-over box truck: a tall upright cab with a one-piece screen and a black
// mask under it, a roof deflector, then chassis, tank and a ribbed box body
DRESS.truck = (c) => {
  const { S, K } = c, z0 = S.z0, W = K.wid / 2, rr = c.lod ? rect : rrect;
  // cab glass
  c.d('front', rr(-1.00, 1.60, 1.00, 2.27, 0.07, 3), M.gloss, { eps: 0.003, h: 0.12, hu: 0.2 });
  c.g('front', rr(-0.975, 1.625, 0.975, 2.245, 0.06, 3), { h: 0.12, hu: 0.2 });
  c.d('side', rr(z0 + 0.20, 1.52, z0 + 1.02, 2.20, 0.06, 2), M.gloss, { mirror: true, eps: 0.003, h: 0.12, hu: 0.2 });
  c.g('side', rr(z0 + 0.225, 1.545, z0 + 0.995, 2.175, 0.05, 2), { mirror: true, h: 0.12, hu: 0.2 });
  // mask, bumper, lamps
  c.d('front', rr(-0.88, 0.98, 0.88, 1.44, 0.05, 2), M.gloss, { eps: 0.004, h: 0.1, hu: 0.2 });
  c.near(() => { for (const y of [1.08, 1.20, 1.32]) c.d('front', rect(-0.82, y - 0.012, 0.82, y + 0.012), M.satin, { eps: 0.0065, h: 0.1, hu: 0.25 }); });
  c.d('front', [[-1.06, 0.40], [1.06, 0.40], [1.06, 0.84], [-1.06, 0.84]], M.dark, { eps: 0.004, h: 0.1, hu: 0.1 });
  headlamp(c, 0.60, 1.00, 0.52, 0.72, 0.52, 0.72, { drl: 'top', proj: 2, drlT: 0.02 });
  c.near(() => {
    c.d('front', rect(-0.99, 2.275, 0.99, 2.30), M.dark, { eps: 0.006, h: 0.1, hu: 0.25 });        // visor lip
    c.d('side', rect(z0 + 1.10, 0.95, z0 + 1.109, 2.32), M.gloss, { mirror: true, eps: 0.0025, h: 0.2 });   // door shut
    c.d('side', rect(z0 + 0.10, 0.95, z0 + 0.109, 2.32), M.gloss, { mirror: true, eps: 0.0025, h: 0.2 });
    c.d('side', rr(z0 + 0.86, 1.30, z0 + 1.04, 1.36, 0.02, 2), M.dark, { mirror: true, eps: 0.004, h: 0.1 });
    c.d('side', rect(z0 + 0.14, 0.42, z0 + 0.34, 0.92), M.dark, { mirror: true, eps: 0.004, h: 0.12 });      // step well
  });
  // tall mirrors on two arms
  for (const sg of [1, -1]) {
    c.detail.add(box(0.10, 0.44, 0.07, sg * (W + 0.20), 1.88, z0 + 0.14), M.dark);
    if (!c.lod) {
      c.detail.add(box(0.24, 0.025, 0.03, sg * (W + 0.09), 2.07, z0 + 0.14), M.dark);
      c.detail.add(box(0.24, 0.025, 0.03, sg * (W + 0.09), 1.69, z0 + 0.14), M.dark);
    }
  }
  // roof deflector, body colour: a wedge from the cab roof up to the box
  const cg = K.cargo, top = cg.y + cg.h, bz = cg.z - cg.l / 2;
  {
    const s = c.paint, b = s.base(), zr = bz - 0.06, zf = S.z0 + 0.9, yf = S.topAt(zf, 0) - 0.01, wf = W * 0.80, wr = W * 0.92;
    const v = [[-wf, yf, zf], [wf, yf, zf], [wr, yf, zr], [-wr, yf, zr], [wr, top - 0.04, zr], [-wr, top - 0.04, zr]].map((q, k) => s.v(q[0], q[1], q[2], b + k));
    s.quad(v[0], v[1], v[4], v[5], 0, 1, -0.6);
    const v2 = [[wf, yf, zf], [wr, yf, zr], [wr, top - 0.04, zr], [-wf, yf, zf], [-wr, yf, zr], [-wr, top - 0.04, zr]].map((q) => s.v(q[0], q[1], q[2]));
    s.tri(v2[0], v2[1], v2[2], 1, 0, 0); s.tri(v2[3], v2[4], v2[5], -1, 0, 0);
  }
  // ---- chassis and box body ----
  const D = c.detail;
  D.add(box(cg.w, cg.h, cg.l, 0, cg.y + cg.h / 2, cg.z), M.cargo);
  D.add(box(1.0, 0.34, cg.l + 0.5, 0, 0.70, cg.z - 0.2), M.dark);                // rails
  D.add(box(cg.w + 0.02, 0.07, cg.l + 0.02, 0, cg.y + 0.035, cg.z), M.satin);    // floor rail
  const rz = bz + cg.l;
  if (!c.lod) {
    for (const sg of [1, -1]) {
      D.add(box(0.05, cg.h, 0.05, sg * (cg.w / 2), cg.y + cg.h / 2, rz - 0.01), M.satin);       // rear corner posts
      D.add(box(0.05, cg.h, 0.05, sg * (cg.w / 2), cg.y + cg.h / 2, bz + 0.01), M.satin);
      D.add(box(0.04, 0.04, cg.l, sg * (cg.w / 2), top - 0.01, cg.z), M.satin);                 // cant rails
      D.add(box(0.035, 0.10, 2.3, sg * (W - 0.04), 0.52, 0.55), M.dark);                        // side under-run bars
      D.add(box(0.035, 0.10, 2.3, sg * (W - 0.04), 0.72, 0.55), M.dark);
      // rear mudguard: a dark hoop over the tyre
      const mg = new THREE.CylinderGeometry(K.wheelR + 0.10, K.wheelR + 0.10, 0.42, 12, 1, true, -Math.PI / 2, Math.PI);
      mg.rotateZ(Math.PI / 2);
      mg.translate(sg * (W - 0.23), K.wheelR + 0.02, K.axle);
      D.add(mg, M.dark);
      c.tail.add(box(0.16, 0.10, 0.03, sg * 0.86, 0.78, rz + 0.07), null, 0.9);
      if (c.brake) c.brake.add(box(0.10, 0.10, 0.035, sg * 0.70, 0.78, rz + 0.07));
    }
    D.add(box(0.012, cg.h - 0.1, 0.012, 0, cg.y + cg.h / 2, rz + 0.004), M.dark);               // door split
    for (const y of [cg.y + 0.45, cg.y + 1.6]) for (const x of [-0.5, 0.5]) D.add(box(0.03, 0.03, 0.03, x * 2.1, y, rz + 0.01), M.satin);
    D.add(box(2.2, 0.12, 0.08, 0, 0.60, rz + 0.04), M.dark);                                    // rear under-run
    D.add(box(2.2, 0.10, 0.05, 0, 0.78, rz + 0.03), M.dark);
    const tank = new THREE.CylinderGeometry(0.27, 0.27, 1.1, 12);
    tank.rotateX(Math.PI / 2);
    tank.translate(-(W - 0.34), 0.62, -0.55);
    D.add(tank, M.satin);
  } else {
    for (const sg of [1, -1]) c.tail.add(box(0.2, 0.14, 0.03, sg * 0.86, 0.78, rz + 0.07), null, 0.9);
  }
};

// Round 8: the tractor of an articulated lorry (js/semitrailer.js hangs the
// trailer on its fifth wheel). The cab is the box truck's, taller roof
// deflector up to the trailer's 4 m, and behind it bare chassis: rails, the
// fifth-wheel plate, tanks, the drive axle's mudguards. The box truck's lamps
// at the end of the frame would sit under the trailer; the trailer carries
// the rear lamps.
DRESS.semi = (c) => {
  const { S, K } = c, z0 = S.z0, W = K.wid / 2, rr = c.lod ? rect : rrect;
  c.d('front', rr(-1.00, 1.60, 1.00, 2.27, 0.07, 3), M.gloss, { eps: 0.003, h: 0.12, hu: 0.2 });
  c.g('front', rr(-0.975, 1.625, 0.975, 2.245, 0.06, 3), { h: 0.12, hu: 0.2 });
  c.d('side', rr(z0 + 0.20, 1.52, z0 + 1.02, 2.20, 0.06, 2), M.gloss, { mirror: true, eps: 0.003, h: 0.12, hu: 0.2 });
  c.g('side', rr(z0 + 0.225, 1.545, z0 + 0.995, 2.175, 0.05, 2), { mirror: true, h: 0.12, hu: 0.2 });
  c.d('front', rr(-0.88, 0.98, 0.88, 1.44, 0.05, 2), M.gloss, { eps: 0.004, h: 0.1, hu: 0.2 });
  c.near(() => { for (const y of [1.08, 1.20, 1.32]) c.d('front', rect(-0.82, y - 0.012, 0.82, y + 0.012), M.satin, { eps: 0.0065, h: 0.1, hu: 0.25 }); });
  c.d('front', [[-1.06, 0.40], [1.06, 0.40], [1.06, 0.84], [-1.06, 0.84]], M.dark, { eps: 0.004, h: 0.1, hu: 0.1 });
  headlamp(c, 0.60, 1.00, 0.52, 0.72, 0.52, 0.72, { drl: 'top', proj: 2, drlT: 0.02 });
  c.near(() => {
    c.d('front', rect(-0.99, 2.275, 0.99, 2.30), M.dark, { eps: 0.006, h: 0.1, hu: 0.25 });
    c.d('side', rect(z0 + 1.10, 0.95, z0 + 1.109, 2.32), M.gloss, { mirror: true, eps: 0.0025, h: 0.2 });
    c.d('side', rect(z0 + 0.10, 0.95, z0 + 0.109, 2.32), M.gloss, { mirror: true, eps: 0.0025, h: 0.2 });
    c.d('side', rect(z0 + 0.14, 0.42, z0 + 0.34, 0.92), M.dark, { mirror: true, eps: 0.004, h: 0.12 });
  });
  for (const sg of [1, -1]) {
    c.detail.add(box(0.10, 0.44, 0.07, sg * (W + 0.20), 1.88, z0 + 0.14), M.dark);
    if (!c.lod) {
      c.detail.add(box(0.24, 0.025, 0.03, sg * (W + 0.09), 2.07, z0 + 0.14), M.dark);
      c.detail.add(box(0.24, 0.025, 0.03, sg * (W + 0.09), 1.69, z0 + 0.14), M.dark);
    }
  }
  // roof deflector up to the trailer's roof line, and the cab's back wall
  const top = 3.86, bz = S.z1 + 0.25;
  {
    const s = c.paint, b = s.base(), zr = bz, zf = z0 + 0.9, yf = S.topAt(zf, 0) - 0.01, wf = W * 0.80, wr = W * 0.92;
    const v = [[-wf, yf, zf], [wf, yf, zf], [wr, yf, zr], [-wr, yf, zr], [wr, top - 0.04, zr], [-wr, top - 0.04, zr]].map((q, k) => s.v(q[0], q[1], q[2], b + k));
    s.quad(v[0], v[1], v[4], v[5], 0, 1, -0.6);
    const v2 = [[wf, yf, zf], [wr, yf, zr], [wr, top - 0.04, zr], [-wf, yf, zf], [-wr, yf, zr], [-wr, top - 0.04, zr]].map((q) => s.v(q[0], q[1], q[2]));
    s.tri(v2[0], v2[1], v2[2], 1, 0, 0); s.tri(v2[3], v2[4], v2[5], -1, 0, 0);
    // (the back of the deflector, so a car overtaking does not look into it)
    const v3 = [[-wr, yf, zr], [wr, yf, zr], [wr, top - 0.04, zr], [-wr, top - 0.04, zr]].map((q) => s.v(q[0], q[1], q[2]));
    s.quad(v3[0], v3[1], v3[2], v3[3], 0, 0, 1);
  }
  const D = c.detail, zEnd = S.z0 + K.len;
  D.add(box(1.0, 0.30, zEnd - S.z1, 0, 0.78, (zEnd + S.z1) / 2), M.dark);                      // rails
  D.add(box(2.0, 0.12, 1.4, 0, 1.06, K.axle - 0.45), M.dark);                                     // fifth-wheel plate
  D.add(box(0.12, 0.30, 0.9, 0, 1.22, K.axle - 0.45), M.dark);                                    // its jaw
  if (!c.lod) {
    for (const sg of [1, -1]) {
      const mg = new THREE.CylinderGeometry(K.wheelR + 0.10, K.wheelR + 0.10, 0.62, 12, 1, true, -Math.PI / 2, Math.PI);
      mg.rotateZ(Math.PI / 2);
      mg.translate(sg * (W - 0.33), K.wheelR + 0.02, K.axle);
      D.add(mg, M.dark);
      const tank = new THREE.CylinderGeometry(0.30, 0.30, 1.0, 12);
      tank.rotateX(Math.PI / 2);
      tank.translate(sg * (W - 0.36), 0.66, S.z1 + 0.75);
      D.add(tank, M.satin);
    }
  } else D.add(box(K.wid - 0.4, 0.5, 1.0, 0, 0.66, S.z1 + 0.75), M.satin);
  // a tail lamp each side at the end of the frame (seen with no trailer on)
  for (const sg of [1, -1]) c.tail.add(box(0.16, 0.10, 0.03, sg * 0.86, 0.78, zEnd + 0.02), null, 0.9);
};

// SOR NS 12 in DPMP red: a flat face with a deep one-piece screen and a lit
// destination box, one black glazing band down each flank with the pillars
// inside it, three curbside doors, white livery bands, the A/C pod on the roof
DRESS.bus = (c) => {
  const { S, K } = c, z0 = S.z0, z1 = S.z1, W = K.wid / 2, rr = c.lod ? rect : rrect;
  // ---- face ----
  c.d('front', rr(-1.14, 1.22, 1.14, 2.58, 0.10, 3), M.gloss, { eps: 0.003, h: 0.15, hu: 0.25 });
  c.g('front', rr(-1.11, 1.25, 1.11, 2.55, 0.09, 3), { h: 0.15, hu: 0.25 });
  c.d('front', rr(-0.92, 2.60, 0.92, 2.86, 0.03, 2), M.gloss, { eps: 0.004, h: 0.1, hu: 0.25 });
  displays(c, 'bus');
  headlamp(c, 0.64, 1.08, 0.64, 0.84, 0.64, 0.84, { drl: 'top', proj: 2, drlT: 0.022 });
  c.d('front', [[-1.18, 0.30], [1.18, 0.30], [1.18, 0.60], [-1.18, 0.60]], M.dark, { eps: 0.004, h: 0.1, hu: 0.1 });
  c.d('front', rect(-1.16, 0.94, 1.16, 1.16), M.white, { eps: 0.004, h: 0.1, hu: 0.2 });
  c.near(() => {
    for (const [x0, x1] of [[-0.95, -0.25], [0.15, 0.85]]) c.d('front', [[x0, 1.30], [x0 + 0.03, 1.30], [x1 + 0.03, 1.36], [x1, 1.36]], M.dark, { eps: 0.014, h: 0.1, hu: 0.2 });
  });
  // ---- flanks: livery, glazing band, panes ----
  const y0 = 1.42, y1 = 2.44;
  for (const sg of [1, -1]) {
    const f = { flip: sg < 0, h: 0.5, hu: 0.25 };
    c.band(c.detail, z0 + 0.35, z1 - 0.3, 1.16, 1.38, M.white, { ...f, eps: 0.004 });
    c.band(c.detail, z0 + 0.35, z1 - 0.3, 2.48, 2.66, M.white, { ...f, eps: 0.004 });
    // the black band the panes sit in; at distance one long pane stands in for both
    if (!c.lod) c.band(c.detail, z0 + 0.30, z1 - 0.25, y0 - 0.02, y1 + 0.02, M.gloss, { ...f, eps: 0.003 });
    else c.band(c.detail, z0 + 0.30, z1 - 0.25, y0, y1, M.glassFar, { ...f, eps: 0.004 });
    // the curb side (x > 0) loses three bays to the doors
    const panes = sg > 0 ? [[-3.9, -2.5], [-2.42, -1.02], [0.62, 1.50], [2.92, 4.0], [4.08, 5.18]]
      : [[-5.1, -3.95], [-3.87, -2.5], [-2.42, -1.02], [-0.94, 0.5], [0.58, 2.0], [2.08, 3.5], [3.58, 5.18]];
    if (!c.lod) for (const [a, b] of panes) c.g('side', rr(a, y0, b, y1, 0.05, 2), { ...f });
  }
  for (const [a, b] of [[-5.08, -4.02], [-0.92, 0.52], [1.60, 2.82]]) {
    c.d('side', rr(a, 0.40, b, y1 + 0.02, 0.04, 2), M.gloss, { h: 0.5, hu: 0.3, eps: 0.0045 });
    const m = (a + b) / 2;
    c.g('side', rr(a + 0.05, 0.52, m - 0.02, y1 - 0.02, 0.03, 2), { h: 0.5, hu: 0.3, eps: 0.0075 });
    c.g('side', rr(m + 0.02, 0.52, b - 0.05, y1 - 0.02, 0.03, 2), { h: 0.5, hu: 0.3, eps: 0.0075 });
  }
  // ---- tail ----
  c.d('rear', rr(-0.98, 1.86, 0.98, 2.56, 0.08, 3), M.gloss, { eps: 0.003, h: 0.15, hu: 0.25 });
  c.g('rear', rr(-0.95, 1.89, 0.95, 2.53, 0.07, 3), { h: 0.15, hu: 0.25 });
  c.d('rear', rr(-0.85, 0.92, 0.85, 1.56, 0.05, 2), M.dark, { eps: 0.004, h: 0.15, hu: 0.25 });
  c.near(() => { for (let k = 0; k < 6; k++) c.d('rear', rect(-0.78, 1.0 + k * 0.09, 0.78, 1.03 + k * 0.09), M.gloss, { eps: 0.0065, h: 0.1, hu: 0.3 }); });
  c.d('rear', [[-1.18, 0.30], [1.18, 0.30], [1.18, 0.58], [-1.18, 0.58]], M.dark, { eps: 0.004, h: 0.1, hu: 0.1 });
  taillamp(c, 0.96, 1.14, 0.70, 1.26, 0.70, 1.26, { t: 0.06 });
  c.near(() => c.put(c.brake, 'rear', rect(-0.2, 2.62, 0.2, 2.65), null, { eps: 0.009 }));
  // ---- roof: A/C pod and hatches, livery white ----
  const ry = S.topAt(0.9, 0) - 0.02;
  c.detail.add(box(1.75, 0.24, 2.7, 0, ry + 0.12, 0.9), M.white);
  if (!c.lod) {
    c.detail.add(box(1.55, 0.03, 2.5, 0, ry + 0.25, 0.9), M.satin);
    c.detail.add(box(0.8, 0.07, 0.8, 0, S.topAt(-3.2, 0) + 0.02, -3.2), M.white);
    c.detail.add(box(0.8, 0.07, 0.8, 0, S.topAt(3.9, 0) + 0.02, 3.9), M.white);
  }
  // long-arm mirrors hanging off the screen pillars
  for (const sg of [1, -1]) {
    c.detail.add(box(0.11, 0.36, 0.07, sg * (W + 0.20), 2.12, z0 + 0.02), M.dark);
    if (!c.lod) c.detail.add(box(0.30, 0.03, 0.03, sg * (W + 0.07), 2.36, z0 + 0.10), M.dark);
  }
};

// The housings of the three destination displays (front, kerb side, rear). The
// lit faces are js/destsign.js: they change with the line, the body does not.
// A flat box each, because a display IS a flat box and the face of a bus is
// not: the front one stands a hand proud of the screen header.
function displays(c, kind) {
  const B = TRANSIT_BODY[kind].sign, { S, K } = c, W = K.wid / 2;
  const f = B.front, r = B.rear, sd = B.side;
  c.detail.add(box(f.w + 0.1, f.h + 0.07, 0.16, f.x, f.y, S.z0 - f.out + 0.085), M.gloss);
  c.detail.add(box(r.w + 0.06, r.h + 0.05, 0.10, r.x, r.y, S.z1 + r.out - 0.055), M.gloss);
  if (!c.lod) c.detail.add(box(0.06, sd.h + 0.05, sd.w + 0.08, S.halfAt(sd.z, sd.y) - 0.012, sd.y, sd.z), M.gloss);
}

// Škoda 32Tr (SOR TNS 12): the solo low-floor trolleybus. A black mask from the
// screen header down to the lamps, a glazing band with three double doors cut
// through it on the kerb side, and on the roof what makes it a trolleybus: the
// long traction container, the frame the two pole bases turn on, the hooks the
// poles are tied down under, and the two rope retrievers on the tail.
DRESS.trolleybus = (c) => {
  const { S, K } = c, z0 = S.z0, z1 = S.z1, W = K.wid / 2, rr = c.lod ? rect : rrect;
  // ---- face ----
  c.d('front', rr(-1.17, 1.02, 1.17, 2.90, 0.12, 3), M.gloss, { eps: 0.003, h: 0.15, hu: 0.25 });
  c.g('front', rr(-1.12, 1.24, 1.12, 2.54, 0.10, 3), { h: 0.15, hu: 0.25 });
  displays(c, 'trolleybus');
  headlamp(c, 0.66, 1.10, 0.62, 0.80, 0.64, 0.84, { drl: 'top', proj: 2, drlT: 0.022 });
  c.d('front', [[-1.20, 0.28], [1.20, 0.28], [1.20, 0.56], [-1.20, 0.56]], M.dark, { eps: 0.004, h: 0.1, hu: 0.1 });
  c.d('front', rect(-0.62, 0.86, 0.62, 0.98), M.white, { eps: 0.004, h: 0.1, hu: 0.2 });
  c.near(() => {
    for (const [x0, x1] of [[-0.98, -0.22], [0.12, 0.88]]) c.d('front', [[x0, 1.28], [x0 + 0.03, 1.28], [x1 + 0.03, 1.35], [x1, 1.35]], M.dark, { eps: 0.014, h: 0.1, hu: 0.2 });
  });
  // ---- flanks: the white skirt band, the glazing band, the panes ----
  const y0 = 1.36, y1 = 2.44;
  const doors = [[-5.78, -4.46], [-0.72, 0.72], [4.46, 5.78]];
  for (const sg of [1, -1]) {
    const f = { flip: sg < 0, h: 0.5, hu: 0.25 };
    c.band(c.detail, z0 + 0.35, z1 - 0.3, 0.62, 0.80, M.white, { ...f, eps: 0.004 });
    c.band(c.detail, z0 + 0.35, z1 - 0.3, 2.52, 2.74, M.white, { ...f, eps: 0.004 });
    if (!c.lod) c.band(c.detail, z0 + 0.30, z1 - 0.25, y0 - 0.02, y1 + 0.02, M.gloss, { ...f, eps: 0.003 });
    else c.band(c.detail, z0 + 0.30, z1 - 0.25, y0, y1, M.glassFar, { ...f, eps: 0.004 });
    const panes = sg > 0 ? [[-4.38, -2.92], [-2.84, -0.80], [0.80, 2.84], [2.92, 4.38]]
      : [[-5.72, -4.50], [-4.42, -2.96], [-2.88, -1.42], [-1.34, 0.12], [0.20, 1.74], [1.82, 3.36], [3.44, 4.98], [5.06, 5.80]];
    if (!c.lod) for (const [a, b] of panes) c.g('side', rr(a, y0, b, y1, 0.05, 2), { ...f });
  }
  // three double doors, glazed to the floor
  for (const [a, b] of doors) {
    c.d('side', rr(a, 0.36, b, y1 + 0.04, 0.04, 2), M.gloss, { h: 0.5, hu: 0.3, eps: 0.0045 });
    const m = (a + b) / 2;
    c.g('side', rr(a + 0.05, 0.48, m - 0.02, y1, 0.03, 2), { h: 0.5, hu: 0.3, eps: 0.0075 });
    c.g('side', rr(m + 0.02, 0.48, b - 0.05, y1, 0.03, 2), { h: 0.5, hu: 0.3, eps: 0.0075 });
  }
  // ---- tail ----
  c.d('rear', rr(-1.00, 1.78, 1.00, 2.60, 0.08, 3), M.gloss, { eps: 0.003, h: 0.15, hu: 0.25 });
  c.g('rear', rr(-0.97, 1.81, 0.97, 2.57, 0.07, 3), { h: 0.15, hu: 0.25 });
  c.d('rear', rr(-0.80, 0.98, 0.80, 1.50, 0.05, 2), M.dark, { eps: 0.004, h: 0.15, hu: 0.25 });
  c.d('rear', [[-1.20, 0.28], [1.20, 0.28], [1.20, 0.56], [-1.20, 0.56]], M.dark, { eps: 0.004, h: 0.1, hu: 0.1 });
  taillamp(c, 0.98, 1.16, 0.74, 1.34, 0.74, 1.34, { t: 0.06 });
  c.near(() => c.put(c.brake, 'rear', rect(-0.2, 2.66, 0.2, 2.69), null, { eps: 0.009 }));
  // ---- roof gear ----
  const D = c.detail, P = TRANSIT_BODY.trolleybus.poles;
  const top = (z) => S.topAt(z, 0) - 0.02;
  D.add(box(1.80, 0.25, 1.9, 0, top(-4.3) + 0.125, -4.3), M.white);                 // air conditioning
  D.add(box(1.96, 0.30, 4.2, 0, top(-0.9) + 0.15, -0.9), M.white);                  // traction container
  D.add(box(1.30, 0.12, 1.0, 0, top(P.z) + 0.06, P.z), M.dark);                     // the frame the bases turn on
  for (const sg of [1, -1]) {
    // the turntable under each pole base
    const t = new THREE.CylinderGeometry(0.17, 0.2, 0.16, c.lod ? 6 : 12);
    t.translate(sg * P.gap / 2, top(P.z) + 0.18, P.z);
    D.add(t, M.satin);
  }
  if (!c.lod) {
    D.add(box(1.78, 0.03, 4.0, 0, top(-0.9) + 0.31, -0.9), M.satin);
    for (const z of [-2.6, -0.9, 0.8]) D.add(box(1.98, 0.26, 0.05, 0, top(z) + 0.14, z), M.satin);   // container ribs
    D.add(box(1.60, 0.03, 1.7, 0, top(-4.3) + 0.26, -4.3), M.satin);
    // the hooks at the tail, a bar on two posts: where a lowered pole is held
    D.add(box(1.5, 0.04, 0.05, 0, P.restY - 0.07, z1 - 0.55), M.dark);
    for (const sg of [1, -1]) D.add(box(0.05, P.restY - 0.07 - top(z1 - 0.55), 0.05, sg * 0.7, (P.restY - 0.07 + top(z1 - 0.55)) / 2, z1 - 0.55), M.dark);
    // rope retrievers on the tail panel
    for (const sg of [1, -1]) {
      const r = new THREE.CylinderGeometry(0.11, 0.11, 0.09, 12);
      r.rotateX(Math.PI / 2);
      r.translate(sg * 0.42, 1.62, z1 + 0.05);
      D.add(r, M.dark);
    }
  }
  // long-arm mirrors hanging off the screen pillars
  for (const sg of [1, -1]) {
    c.detail.add(box(0.11, 0.38, 0.07, sg * (W + 0.20), 2.10, z0 + 0.02), M.dark);
    if (!c.lod) c.detail.add(box(0.30, 0.03, 0.03, sg * (W + 0.07), 2.36, z0 + 0.10), M.dark);
  }
};

// ---- buildCar(kind, K) -----------------------------------------------------
function assemble(kind, K, lod, cut) {
  const st = STYLE[kind] ?? {};
  const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
  const style = { ...st, arches: st.arches === 'front' ? [-ax] : undefined };
  const S = makeShape(K, style);
  const c = context(K, S, lod);
  c.zs = buildHull(S, { paint: c.paint, dark: c.detail, lod, linerMat: M.liner }).zs;
  (DRESS[kind] ?? DRESS.octavia)(c);
  // Door-top ledges, for the one car the player sits in. From the driver's
  // seat the door skin is a backface, so between the top of the door card and
  // the foot of the glass there would be a slot straight down to the road.
  // cut is vehicles.js's cabinCut(): the same numbers the interior is built to.
  if (cut && !lod) {
    const n = 6, b = c.detail.base();
    for (const sg of [1, -1]) {
      for (let k = 0; k <= n; k++) {
        const z = cut.deckZ0 + (cut.z1 - cut.deckZ0) * k / n, y = S.yShoulder(z) - 0.008;
        c.detail.v(sg * (cut.xIn - 0.05), y, z, b + (sg > 0 ? 0 : 500) + k * 2, M.dark);
        c.detail.v(sg * (S.edgeAt(z, 7)[0] - 0.003), y, z, b + (sg > 0 ? 0 : 500) + k * 2 + 1, M.dark);
      }
      for (let k = 0; k < n; k++) {
        const o = c.detail.map.get(b + (sg > 0 ? 0 : 500) + k * 2);
        c.detail.quad(o, o + 1, o + 3, o + 2, 0, 1, 0);
      }
    }
  }
  // a dark floor between the axles: nothing shows through under the sills
  const fy = Math.max(S.fLo(0), 0.1) + 0.03;
  const fl = new THREE.PlaneGeometry(S.fW(0) * 1.7, K.len * 0.86);
  fl.rotateX(Math.PI / 2);
  fl.translate(0, fy, 0);
  c.detail.add(fl, M.liner);
  // wheels: the tyre's outer face sits a finger inside the arch lip, per axle
  const W = K.wheelW ?? (K.wheelR > 0.34 ? 0.25 : 0.225);
  const wx = [-ax, ax].map((z) => S.halfAt(z, K.wheelR + S.R * 0.55) - 0.022 - W / 2);
  const design = st.wheel ?? 'five';
  if (lod) {
    for (let i = 0; i < 4; i++) {
      const side = i & 1 ? 1 : -1, g = wheelGeo(K.wheelR, W, design, side, true).clone();
      g.translate(side * wx[i < 2 ? 0 : 1], K.wheelR, (i < 2 ? -1 : 1) * ax);
      // carry the baked wheel's own colours across
      const pos = g.attributes.position, col = g.attributes.color, pb = g.attributes.pbr, off = c.detail.p.length / 3;
      for (let k = 0; k < pos.count; k++) {
        c.detail.v(pos.getX(k), pos.getY(k), pos.getZ(k), null, { c: [col.getX(k), col.getY(k), col.getZ(k)], r: pb.getX(k), m: pb.getY(k) });
      }
      const ix = g.index.array;
      for (let k = 0; k < ix.length; k++) c.detail.i.push(off + ix[k]);
    }
  }
  for (const s of [c.paint, c.glass, c.detail, c.head, c.tail, c.brake]) if (s) s.warp(S.warp);
  return {
    S, wx, W, design,
    paint: c.paint.build(), glass: c.glass ? c.glass.build() : null, detail: c.detail.build(),
    head: c.head.build(), tail: c.tail.build(), brake: c.brake ? c.brake.build() : null,
  };
}

export function buildCar(kind, K, cut = null) {
  const near = assemble(kind, K, false, cut), far = assemble(kind, K, true, null);
  const S = near.S;
  return {
    shape: S, near, far, wx: near.wx, style: STYLE[kind] ?? {},
    wheel: [-1, 1].map((side) => wheelGeo(K.wheelR, near.W, near.design, side, false)),
  };
}
