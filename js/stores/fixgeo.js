// ---- stores/fixgeo.js: the shapes of shop fittings, one module each ----
// Main thread only. A fitting is authored once, facing +Z with its run along X
// and its foot on y = 0, and drawn as instances (js/stores/fixtures.js). Faces
// that show stock carry uv 0..1 and `tex` 1: the material windows them onto the
// instance's own cell of the goods sheet (js/stores/goodstex.js). Every other
// face has `tex` 0 and takes its vertex colour, so a module of shelving is a
// dozen triangles however full it looks.

import * as THREE from 'three';

const _c = new THREE.Color();

export class Geo {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.tex = []; }
  /** A quad a-b-c-d (counter-clockwise seen from the side its normal n points to). `uv` [u0,v0,u1,v1] makes it show stock. */
  quad(a, b, c, d, n, hex, uv = null) {
    _c.setHex(hex ?? 0xffffff);
    const U = uv ?? [0, 0, 1, 1];
    const pts = [a, b, c, a, c, d], uvs = [[U[0], U[1]], [U[2], U[1]], [U[2], U[3]], [U[0], U[1]], [U[2], U[3]], [U[0], U[3]]];
    for (let i = 0; i < 6; i++) {
      this.pos.push(...pts[i]); this.nrm.push(...n); this.uv.push(...uvs[i]);
      this.col.push(uv ? 1 : _c.r, uv ? 1 : _c.g, uv ? 1 : _c.b); this.tex.push(uv ? 1 : 0);
    }
    return this;
  }
  /**
   * A box. `faces` may give a uv rectangle for 'f' (+z), 'b' (-z), 't' (top),
   * 'l' (-x), 'r' (+x); `skip` is a string of faces to leave out ('d' the bottom is never drawn).
   */
  box(x0, x1, y0, y1, z0, z1, hex, faces = null, skip = '') {
    const F = faces ?? {};
    if (!skip.includes('f')) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], hex, F.f);
    if (!skip.includes('b')) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], hex, F.b);
    if (!skip.includes('l')) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], hex, F.l);
    if (!skip.includes('r')) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], hex, F.r);
    if (!skip.includes('t')) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], hex, F.t);
    return this;
  }
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('tex', new THREE.BufferAttribute(new Float32Array(this.tex), 1));
    return g;
  }
}

const FULL = [0, 0, 1, 1];
const GREY = 0xd6d8d9, DARK = 0x3a3d41, WHITE = 0xf2f3f1, STEEL = 0xb4b9bd;
export const MODULE = 1.3;

/** Every fitting: its geometry and its footprint half-sizes [along the run, across] for collision. */
export const FITTINGS = {
  // a two-sided aisle gondola, 1.85 m: stock on both faces
  gondola: () => new Geo().box(-0.65, 0.65, 0, 0.14, -0.47, 0.47, DARK)
    .box(-0.65, 0.65, 0.14, 1.85, -0.45, 0.45, GREY, { f: FULL, b: FULL }),
  // pallet racking of a cash and carry: the same, twice as high
  rack: () => new Geo().box(-0.65, 0.65, 0, 0.14, -0.6, 0.6, 0xd8791f)
    .box(-0.65, 0.65, 0.14, 3.4, -0.58, 0.58, 0x4a6ea8, { f: FULL, b: FULL }),
  // one-sided shelving against a wall, 2.1 m
  wallshelf: () => new Geo().box(-0.65, 0.65, 0, 0.14, -0.25, 0.27, DARK)
    .box(-0.65, 0.65, 0.14, 2.1, -0.25, 0.25, GREY, { f: FULL }),
  // a wall of chilled cabinets: white case, lit stock, a dark kick plate
  chiller: () => new Geo().box(-0.65, 0.65, 0, 0.25, -0.38, 0.36, DARK)
    .box(-0.65, 0.65, 0.25, 1.9, -0.38, 0.38, WHITE, { f: FULL })
    .box(-0.65, 0.65, 1.9, 2.1, -0.38, 0.46, WHITE),
  // an island chest freezer: you look down into it
  freezer: () => new Geo().box(-0.65, 0.65, 0, 0.1, -0.46, 0.46, DARK)
    .box(-0.65, 0.65, 0.1, 0.88, -0.48, 0.48, WHITE, { t: FULL }),
  // a fruit and vegetable stand: crates on a slope toward the customer
  produce: () => {
    const g = new Geo().box(-0.6, 0.6, 0, 0.58, -0.5, 0.5, 0x7c5a36);
    g.quad([-0.6, 0.6, 0.5], [0.6, 0.6, 0.5], [0.6, 0.98, -0.5], [-0.6, 0.98, -0.5], [0, 0.93, 0.36], 0xffffff, FULL);
    g.quad([0.6, 0.58, -0.5], [-0.6, 0.58, -0.5], [-0.6, 0.98, -0.5], [0.6, 0.98, -0.5], [0, 0, -1], 0x7c5a36);
    g.quad([-0.6, 0.58, 0.5], [-0.6, 0.6, 0.5], [-0.6, 0.98, -0.5], [-0.6, 0.58, -0.5], [-1, 0, 0], 0x6b4d2e);
    g.quad([0.6, 0.58, -0.5], [0.6, 0.98, -0.5], [0.6, 0.6, 0.5], [0.6, 0.58, 0.5], [1, 0, 0], 0x6b4d2e);
    return g;
  },
  // the bins of the weekly non-food aisle
  bins: () => new Geo().box(-0.65, 0.65, 0, 0.78, -0.55, 0.55, 0xb9bcbf, { t: FULL }),
  // a checkout: belt, scanner, bagging shelf, the cashier's booth and the lane light
  till: () => new Geo()
    .box(-0.2, 1.6, 0, 0.86, -0.35, 0.25, 0xc2c6c9, { t: [0, 0, 1, 1] })
    .box(-0.75, -0.2, 0, 0.86, -0.35, 0.25, 0x2b2e31)
    .box(-1.6, -0.75, 0, 0.72, -0.35, 0.25, STEEL)
    .box(-1.15, 0.15, 0, 0.98, -1.05, -0.95, 0xc2c6c9)
    .box(-1.15, -1.05, 0, 0.98, -0.95, -0.35, 0xc2c6c9)
    .box(-0.72, -0.28, 0, 0.48, -0.86, -0.46, 0x2f3338)          // the cashier's seat
    .box(-0.62, -0.3, 1.02, 1.3, -0.44, -0.38, 0x1d2024)          // the till screen
    .box(-0.5, -0.44, 0.86, 1.02, -0.43, -0.39, 0x1d2024)
    .box(-0.98, -0.86, 0.86, 1.04, 0.08, 0.2, 0x1d2024)           // the card terminal
    .box(1.5, 1.56, 0.86, 2.05, -0.33, -0.27, STEEL)
    .box(1.38, 1.68, 2.05, 2.3, -0.4, -0.2, 0x35d05a),
  // a self-checkout: screen, scanner bed, bagging shelf, the pole light
  self: () => {
    const g = new Geo().box(-0.3, 0.3, 0, 1.02, -0.26, 0.24, 0x33373c)
      .box(0.3, 0.9, 0, 0.62, -0.26, 0.24, STEEL)
      .box(-0.02, 0.02, 1.02, 1.95, -0.24, -0.2, STEEL)
      .box(-0.1, 0.1, 1.95, 2.1, -0.3, -0.14, 0x35d05a);
    g.quad([-0.26, 1.04, 0.2], [0.26, 1.04, 0.2], [0.26, 1.46, -0.02], [-0.26, 1.46, -0.02], [0, 0.46, 0.89], 0xffffff, FULL);
    g.quad([0.26, 1.02, -0.06], [-0.26, 1.02, -0.06], [-0.26, 1.46, -0.06], [0.26, 1.46, -0.06], [0, 0, -1], 0x33373c);
    return g;
  },
  // the one-way gate into the shop: two posts and their arms
  gate: () => new Geo().box(-0.05, 0.05, 0, 1.0, -0.05, 0.05, STEEL).box(0.05, 1.25, 0.82, 0.9, -0.02, 0.02, STEEL)
    .box(0.05, 1.25, 0.4, 0.46, -0.02, 0.02, STEEL),
  // a stack of hand baskets
  baskets: () => new Geo().box(-0.24, 0.24, 0, 0.74, -0.17, 0.17, 0xc9302a).box(-0.2, 0.2, 0.74, 0.92, -0.02, 0.02, 0x22252a),
  // ---- a restaurant ----
  // the service counter, by the metre: timber front, a pale top
  counter: () => new Geo().box(-0.65, 0.65, 0, 1.02, -0.4, 0.4, 0xffffff, { f: FULL })
    .box(-0.66, 0.66, 1.02, 1.08, -0.44, 0.44, 0xe9e7e0),
  // a self-order kiosk: a tall slab with a screen on both faces
  kiosk: () => new Geo().box(-0.34, 0.34, 0, 0.1, -0.2, 0.2, DARK)
    .box(-0.3, 0.3, 0.1, 1.95, -0.07, 0.07, 0x26292d, { f: [0, 0, 1, 1], b: [0, 0, 1, 1] }),
  // the lit menu boards over the counter
  menu: () => new Geo().box(-0.62, 0.62, 2.25, 3.0, -0.05, 0.05, 0x1b1d20, { f: FULL }),
  // a table for four and a table for two
  table4: () => new Geo().box(-0.6, 0.6, 0.7, 0.75, -0.4, 0.4, 0xc9a777).box(-0.05, 0.05, 0, 0.7, -0.05, 0.05, DARK)
    .box(-0.28, 0.28, 0, 0.03, -0.28, 0.28, DARK),
  // a chair: seat and back (the back is at -z, the sitter faces +z)
  chair: () => new Geo().box(-0.21, 0.21, 0.4, 0.45, -0.21, 0.21, 0x7a5a3a).box(-0.21, 0.21, 0.45, 0.86, -0.21, -0.17, 0x7a5a3a)
    .box(-0.19, -0.15, 0, 0.4, -0.19, -0.15, DARK).box(0.15, 0.19, 0, 0.4, -0.19, -0.15, DARK)
    .box(-0.19, -0.15, 0, 0.4, 0.15, 0.19, DARK).box(0.15, 0.19, 0, 0.4, 0.15, 0.19, DARK),
  // an upholstered bench along a wall, by the metre
  bench: () => new Geo().box(-0.65, 0.65, 0, 0.45, -0.28, 0.28, 0x8b2f2a).box(-0.65, 0.65, 0.45, 1.1, -0.28, -0.16, 0x8b2f2a),
  // the bin with the tray shelf on top
  bin: () => new Geo().box(-0.35, 0.35, 0, 1.15, -0.3, 0.3, 0x5b4a3a).box(-0.37, 0.37, 1.15, 1.2, -0.32, 0.32, 0x2a2d31),
  // a plain partition, by the metre: what closes the kitchen off beside the counter
  partition: () => new Geo().box(-0.65, 0.65, 0, 2.7, -0.07, 0.07, 0xf2f3f1),
  // a tray with a meal on it: what the player carries from the counter
  tray: () => new Geo().box(-0.22, 0.22, 0, 0.02, -0.16, 0.16, 0x6b4a33).box(-0.16, -0.02, 0.02, 0.1, -0.1, 0.02, 0xd9a441)
    .box(0.04, 0.14, 0.02, 0.16, -0.08, 0.02, 0xc9302a).box(-0.1, 0.06, 0.02, 0.06, 0.05, 0.13, 0xf1ead6),
  // kitchen steel behind the counter
  // a showroom: the advisers' desk, and the card that stands by each car
  desk: () => new Geo().box(-0.65, 0.65, 0, 0.98, -0.36, 0.36, 0xf4f4f2).box(-0.67, 0.67, 0.98, 1.02, -0.38, 0.38, 0x1f2124),
  stand: () => new Geo().box(-0.03, 0.03, 0, 1.02, -0.03, 0.03, 0x1f2124).box(-0.22, 0.22, 1.02, 1.34, -0.02, 0.02, 0x111315)
    .box(-0.19, 0.19, 1.05, 1.31, 0.02, 0.026, 0xe9edf0),
  steel: () => new Geo().box(-0.65, 0.65, 0, 0.9, -0.38, 0.38, 0xffffff, { f: FULL, t: FULL }).box(-0.65, 0.65, 1.5, 1.95, -0.38, 0.1, 0xb4b9bd),
};

/** Footprint half-sizes [along the run, across] of one module, for collision. */
export const FOOT = {
  gondola: [0.65, 0.47], rack: [0.65, 0.6], wallshelf: [0.65, 0.27], chiller: [0.65, 0.4], freezer: [0.65, 0.48],
  produce: [0.6, 0.5], bins: [0.65, 0.55], till: null, self: [0.6, 0.26], gate: null, baskets: [0.24, 0.17],
  counter: [0.65, 0.42], kiosk: [0.34, 0.2], menu: null, table4: [0.6, 0.4], chair: null, bench: [0.65, 0.28], bin: [0.35, 0.3], steel: [0.65, 0.38], partition: [0.65, 0.1], tray: null,
  desk: [0.65, 0.38], stand: [0.12, 0.12],
};
