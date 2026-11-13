// ---- propkit.js: the handful of solids street furniture is built from -------
// A bench is slats and two cast frames, a bin is a drum under a hood, a shelter
// is posts, a roof and glass. All of it is boxes, drums and bars, written as
// triangles into the chunk's shared sink (one draw call for every prop a chunk
// owns). These are those solids, each in the frame every prop uses:
//
//   (x, z)  the prop's origin on the ground, y its base height
//   h       its yaw: the prop's RIGHT is (cos h, -sin h), its FRONT (sin h, cos h)
//   (u, v)  an offset in that frame, u to the right, v to the front
//
// …and DecoSink, the second kind of bucket: textured quads for the things a
// flat colour cannot say (a sign face, a poster, a pane of glass). Its mesh is
// drawn with the street atlas (js/signatlas.js) and is NOT draped: everything
// in it is authored at its absolute height.
//
// Worker-safe: three.js geometry only.

import * as THREE from 'three';
import { cellUV } from './signfaces.js';

/** World position of the offset (u, v) from (x, z) under yaw h. Returns a shared pair. */
const _o = [0, 0];
export function at(x, z, h, u, v) {
  const c = Math.cos(h), s = Math.sin(h);
  _o[0] = x + u * c + v * s; _o[1] = z - u * s + v * c;
  return _o;
}

/** A box: base centre (x, z) at height y, w across, hh tall, d deep, yawed by h. */
export function box(sink, x, y, z, w, hh, d, h, r, g, b, bottom = false) {
  const c = Math.cos(h), s = Math.sin(h);
  const hw = w / 2, hd = d / 2;
  const x0 = x - hw * c - hd * s, z0 = z + hw * s - hd * c;
  const x1 = x + hw * c - hd * s, z1 = z - hw * s - hd * c;
  const x2 = x + hw * c + hd * s, z2 = z - hw * s + hd * c;
  const x3 = x - hw * c + hd * s, z3 = z + hw * s + hd * c;
  const y1 = y + hh;
  // wound so every face looks OUT (the old furniture.box had them all looking
  // in: with back faces culled, a bench was drawn as the inside of itself)
  sink.quad(x1, y, z1, x0, y, z0, x0, y1, z0, x1, y1, z1, r, g, b);
  sink.quad(x2, y, z2, x1, y, z1, x1, y1, z1, x2, y1, z2, r, g, b);
  sink.quad(x3, y, z3, x2, y, z2, x2, y1, z2, x3, y1, z3, r, g, b);
  sink.quad(x0, y, z0, x3, y, z3, x3, y1, z3, x0, y1, z0, r, g, b);
  sink.quad(x3, y1, z3, x2, y1, z2, x1, y1, z1, x0, y1, z0, r, g, b);
  if (bottom) sink.quad(x0, y, z0, x1, y, z1, x2, y, z2, x3, y, z3, r, g, b);
}

/** A box at the offset (u, v) of a prop at (x, z, h): the usual way to place a part. */
export function part(sink, x, y, z, h, u, v, w, hh, d, r, g, b, bottom = false) {
  const p = at(x, z, h, u, v);
  box(sink, p[0], y, p[1], w, hh, d, h, r, g, b, bottom);
}

/**
 * An upright drum from y0 to y1, radius r0 at the foot and r1 at the top, with
 * n sides. `cap` closes the top (1) or both ends (2).
 */
export function drum(sink, x, z, y0, y1, r0, r1, n, r, g, b, cap = 1) {
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    // wound so the outside faces out (counter-clockwise seen from outside)
    sink.quad(x + c1 * r0, y0, z + s1 * r0, x + c0 * r0, y0, z + s0 * r0,
      x + c0 * r1, y1, z + s0 * r1, x + c1 * r1, y1, z + s1 * r1, r, g, b);
    if (cap && r1 > 1e-4) sink.tri(x, y1, z, x + c1 * r1, y1, z + s1 * r1, x + c0 * r1, y1, z + s0 * r1, r, g, b);
    if (cap === 2) sink.tri(x, y0, z, x + c0 * r0, y0, z + s0 * r0, x + c1 * r0, y0, z + s1 * r0, r, g, b);
  }
}

/** A round post: a six-sided drum. */
export function post(sink, x, z, y0, y1, rad, r, g, b, n = 6) {
  drum(sink, x, z, y0, y1, rad, rad, n, r, g, b, 1);
}

/**
 * A straight square bar between two points in space (a rail, a hoop's leg, a
 * parasol's rib). `t` is its thickness.
 */
export function bar(sink, ax, ay, az, bx, by, bz, t, r, g, b) {
  let dx = bx - ax, dy = by - ay, dz = bz - az;
  const L = Math.hypot(dx, dy, dz) || 1;
  dx /= L; dy /= L; dz /= L;
  // two axes across the bar: one horizontal where it can be, the other square to both
  let px = -dz, py = 0, pz = dx;
  let pl = Math.hypot(px, pz);
  if (pl < 1e-4) { px = 1; pz = 0; pl = 1; }
  px /= pl; pz /= pl;
  const qx = dy * pz - dz * py, qy = dz * px - dx * pz, qz = dx * py - dy * px;
  const k = t / 2;
  const C = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let i = 0; i < 4; i++) {
    const [u0, v0] = C[i], [u1, v1] = C[(i + 1) % 4];
    const ox0 = (px * u0 + qx * v0) * k, oy0 = (py * u0 + qy * v0) * k, oz0 = (pz * u0 + qz * v0) * k;
    const ox1 = (px * u1 + qx * v1) * k, oy1 = (py * u1 + qy * v1) * k, oz1 = (pz * u1 + qz * v1) * k;
    // facing: out along the mean of the two corner offsets
    sink.triFacing(ax + ox0, ay + oy0, az + oz0, ax + ox1, ay + oy1, az + oz1, bx + ox1, by + oy1, bz + oz1,
      ox0 + ox1, oy0 + oy1, oz0 + oz1, r, g, b);
    sink.triFacing(ax + ox0, ay + oy0, az + oz0, bx + ox1, by + oy1, bz + oz1, bx + ox0, by + oy0, bz + oz0,
      ox0 + ox1, oy0 + oy1, oz0 + oz1, r, g, b);
  }
}

// ---- textured quads -----------------------------------------------------------
export class DecoSink {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; }
  /**
   * One quad showing atlas cell `name`, given as its bottom-left, bottom-right,
   * top-right and top-left corners AS THE VIEWER SEES THEM. The normal follows
   * from that order, so a face can never come out mirrored or inside out.
   * `flip` mirrors the picture left to right (the grey back of a sign).
   */
  quad(name, a, b, c, d, flip = false) {
    const [u0, v0, u1, v1] = cellUV(name);
    const ua = flip ? u1 : u0, ub = flip ? u0 : u1;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
      a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 6; i++) this.nrm.push(nx, ny, nz);
    this.uv.push(ua, v0, ub, v0, ub, v1, ua, v0, ub, v1, ua, v1);
  }
  /**
   * An upright panel: centre (x, y, z), w wide and hh tall, facing the
   * horizontal direction (fx, fz). `back` names the cell on its other side.
   */
  panel(name, x, y, z, w, hh, fx, fz, back = null) {
    // the viewer stands in front, looking along -f: their right is up x f
    const rx = fz * (w / 2), rz = -fx * (w / 2), k = hh / 2;
    this.quad(name, [x - rx, y - k, z - rz], [x + rx, y - k, z + rz],
      [x + rx, y + k, z + rz], [x - rx, y + k, z - rz]);
    if (back) {
      const o = 0.006;
      this.quad(back, [x + rx - fx * o, y - k, z + rz - fz * o], [x - rx - fx * o, y - k, z - rz - fz * o],
        [x - rx - fx * o, y + k, z - rz - fz * o], [x + rx - fx * o, y + k, z + rz - fz * o], true);
    }
  }
  geo() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    return g;
  }
}
