// ---- bikeparts.js: the triangles a bicycle is made of ---------------------------
// Split out of js/bikemodel.js: the little sink every part is written into, and
// the parts that are the same on all four bicycles (one wheel, scaled to each;
// the cranks; the glow of a lamp; the pool a headlamp throws on the road).
// js/bikemodel.js builds the frames with the same sink.
//
// Everything faces -z, +x is the bike's right, as in js/bikemodel.js.
//
// Pure geometry: three.js only, nothing from the DOM.

import * as THREE from 'three';

export const C = {
  tyre: 0x17181a, rim: 0xa9adb3, spoke: 0x9a9ea5, steel: 0x8d9299, dark: 0x25272b,
  saddle: 0x2a2320, tan: 0x7a5234, grip: 0x1d1d1f, guard: 0x2c2e33, chrome: 0xb9bdc4,
  wicker: 0x9a7444, white: 0xe8e8e2,
};

// The wheel every bike shares is modelled at this radius and scaled to fit.
export const WHEEL_R = 0.345;

// ---- a small triangle sink ---------------------------------------------------
export class Sink {
  constructor() { this.p = []; this.n = []; this.c = []; this.m = []; this._c = new THREE.Color(); }
  _col(hex) { this._c.setHex(hex); return this._c; }
  _v(x, y, z, nx, ny, nz, col, mask) {
    this.p.push(x, y, z); this.n.push(nx, ny, nz); this.c.push(col.r, col.g, col.b); this.m.push(mask);
  }
  /** A round bar from a to b ([x, y, z] each), radius r (r2 at b), `sides` round. */
  tube(a, b, r, hex, mask = 0, sides = 6, r2 = r) {
    const col = this._col(hex);
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const L = Math.hypot(dx, dy, dz) || 1;
    const tx = dx / L, ty = dy / L, tz = dz / L;
    // any vector not along the bar, then two normals to it
    let ux = 1, uy = 0, uz = 0;
    if (Math.abs(tx) > 0.9) { ux = 0; uy = 1; }
    let vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const vl = Math.hypot(vx, vy, vz); vx /= vl; vy /= vl; vz /= vl;
    ux = vy * tz - vz * ty; uy = vz * tx - vx * tz; uz = vx * ty - vy * tx;
    for (let i = 0; i < sides; i++) {
      const a0 = i / sides * Math.PI * 2, a1 = (i + 1) / sides * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      const n0x = ux * c0 + vx * s0, n0y = uy * c0 + vy * s0, n0z = uz * c0 + vz * s0;
      const n1x = ux * c1 + vx * s1, n1y = uy * c1 + vy * s1, n1z = uz * c1 + vz * s1;
      const q = (P, nx, ny, nz, rr) => this._v(P[0] + nx * rr, P[1] + ny * rr, P[2] + nz * rr, nx, ny, nz, col, mask);
      q(a, n0x, n0y, n0z, r); q(b, n0x, n0y, n0z, r2); q(b, n1x, n1y, n1z, r2);
      q(a, n0x, n0y, n0z, r); q(b, n1x, n1y, n1z, r2); q(a, n1x, n1y, n1z, r);
    }
  }
  /** A bar through several points. */
  path(pts, r, hex, mask = 0, sides = 6) {
    for (let i = 0; i + 1 < pts.length; i++) this.tube(pts[i], pts[i + 1], r, hex, mask, sides);
  }
  /** An axis-aligned box, centre and size. */
  box(cx, cy, cz, sx, sy, sz, hex, mask = 0) {
    const col = this._col(hex), x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const f = (ax, ay, az, bx, by, bz, cx2, cy2, cz2, dx, dy, dz, nx, ny, nz) => {
      this._v(ax, ay, az, nx, ny, nz, col, mask); this._v(bx, by, bz, nx, ny, nz, col, mask); this._v(cx2, cy2, cz2, nx, ny, nz, col, mask);
      this._v(ax, ay, az, nx, ny, nz, col, mask); this._v(cx2, cy2, cz2, nx, ny, nz, col, mask); this._v(dx, dy, dz, nx, ny, nz, col, mask);
    };
    f(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0, 0, 1, 0);
    f(x0, y0, z1, x0, y0, z0, x1, y0, z0, x1, y0, z1, 0, -1, 0);
    f(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 1, 0, 0);
    f(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, -1, 0, 0);
    f(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1);
    f(x1, y0, z0, x0, y0, z0, x0, y1, z0, x1, y1, z0, 0, 0, -1);
  }
  /** A band round the x axis at (y, z): radius R, half width hw, from angle a0 to a1 (0 = up, positive toward +z). */
  band(y, z, R, hw, a0, a1, segs, hex, mask = 0) {
    const col = this._col(hex);
    for (let i = 0; i < segs; i++) {
      const t0 = a0 + (a1 - a0) * i / segs, t1 = a0 + (a1 - a0) * (i + 1) / segs;
      const y0 = y + Math.cos(t0) * R, z0 = z + Math.sin(t0) * R, y1 = y + Math.cos(t1) * R, z1 = z + Math.sin(t1) * R;
      const n0y = Math.cos(t0), n0z = Math.sin(t0), n1y = Math.cos(t1), n1z = Math.sin(t1);
      this._v(-hw, y0, z0, 0, n0y, n0z, col, mask); this._v(hw, y0, z0, 0, n0y, n0z, col, mask); this._v(hw, y1, z1, 0, n1y, n1z, col, mask);
      this._v(-hw, y0, z0, 0, n0y, n0z, col, mask); this._v(hw, y1, z1, 0, n1y, n1z, col, mask); this._v(-hw, y1, z1, 0, n1y, n1z, col, mask);
    }
  }
  build() {
    // Every triangle wound to agree with its own normals. The material is two
    // sided (a mudguard and a spoke are sheets), and on a two sided material
    // three.js turns the normal of whatever it takes for a back face: a tube
    // wound the wrong way round would be lit from the inside.
    const p = this.p, n = this.n, c = this.c;
    for (let i = 0; i < p.length; i += 9) {
      const ux = p[i + 3] - p[i], uy = p[i + 4] - p[i + 1], uz = p[i + 5] - p[i + 2];
      const vx = p[i + 6] - p[i], vy = p[i + 7] - p[i + 1], vz = p[i + 8] - p[i + 2];
      const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
      const ax = n[i] + n[i + 3] + n[i + 6], ay = n[i + 1] + n[i + 4] + n[i + 7], az = n[i + 2] + n[i + 5] + n[i + 8];
      if (gx * ax + gy * ay + gz * az >= 0) continue;
      for (const a of [p, n, c]) for (let k = 0; k < 3; k++) { const t = a[i + 3 + k]; a[i + 3 + k] = a[i + 6 + k]; a[i + 6 + k] = t; }
      const j = i / 3, t = this.m[j + 1]; this.m[j + 1] = this.m[j + 2]; this.m[j + 2] = t;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('paint', new THREE.Float32BufferAttribute(this.m, 1));
    g.userData.tris = this.p.length / 9;
    return g;
  }
}

// ---- the wheel: tyre, rim, hub and the impression of spokes ----------------------
// Sixteen flat blades cross the hub in pairs; at a walk they are spokes, at
// speed they are the flicker a real wheel has. About the origin, axle along x.
export function wheelGeo(far) {
  const s = new Sink(), R = WHEEL_R;
  if (far) {
    // past the distance line: a dark ring and nothing else
    for (const sx of [-0.016, 0.016]) ring(s, R - 0.045, R, sx, 10, C.tyre);
    return s.build();
  }
  const N = 18, r = 0.019;
  const col = s._col(C.tyre).clone();
  const M = 5;
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < M; j++) {
      const q = (ii, jj) => {
        const a = ii / N * Math.PI * 2, c = jj / M * Math.PI * 2;
        const rr = R - r + Math.cos(c) * r, x = Math.sin(c) * r;
        s._v(x, Math.cos(a) * rr, Math.sin(a) * rr, Math.sin(c), Math.cos(a) * Math.cos(c), Math.sin(a) * Math.cos(c), col, 0);
      };
      q(i, j); q(i + 1, j); q(i + 1, j + 1);
      q(i, j); q(i + 1, j + 1); q(i, j + 1);
    }
  }
  // rim: a bright band just inside the tyre, both faces
  for (const sx of [-0.011, 0.011]) ring(s, R - 2 * r - 0.016, R - 2 * r + 0.004, sx, N, C.rim);
  // hub
  s.tube([-0.045, 0, 0], [0.045, 0, 0], 0.018, C.steel, 0, 6);
  // spokes
  const sc = s._col(C.spoke).clone(), rin = R - 2 * r - 0.008, w = 0.005;
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2 + (i & 1 ? 0.12 : -0.12), sx = i & 1 ? 0.022 : -0.022;
    const cy = Math.cos(a), cz = Math.sin(a), ty = -cz * w, tz = cy * w;
    const v = (x, y, z) => s._v(x, y, z, sx > 0 ? 1 : -1, 0, 0, sc, 0);
    v(sx, ty * 2.4, tz * 2.4); v(0.004 * Math.sign(sx), cy * rin + ty, cz * rin + tz); v(0.004 * Math.sign(sx), cy * rin - ty, cz * rin - tz);
    v(sx, ty * 2.4, tz * 2.4); v(0.004 * Math.sign(sx), cy * rin - ty, cz * rin - tz); v(sx, -ty * 2.4, -tz * 2.4);
  }
  return s.build();
}
function ring(s, r0, r1, x, n, hex) {
  const col = s._col(hex).clone(), nx = x > 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
    s._v(x, c0 * r0, s0 * r0, nx, 0, 0, col, 0); s._v(x, c0 * r1, s0 * r1, nx, 0, 0, col, 0); s._v(x, c1 * r1, s1 * r1, nx, 0, 0, col, 0);
    s._v(x, c0 * r0, s0 * r0, nx, 0, 0, col, 0); s._v(x, c1 * r1, s1 * r1, nx, 0, 0, col, 0); s._v(x, c1 * r0, s1 * r0, nx, 0, 0, col, 0);
  }
}

// ---- cranks and pedals: about the bracket axle, the RIGHT arm straight up ----------
// The pedals are short drums along their own axle, so that turning with the
// crank they still look level under a foot.
export function crankGeo() {
  const s = new Sink(), L = 0.165;
  for (const sx of [-1, 1]) {
    const x = sx * 0.075, y = sx * L;
    s.tube([x, 0, 0], [x, y, 0], 0.011, C.steel, 0, 5, 0.008);
    s.tube([x + sx * 0.005, y, 0], [x + sx * 0.095, y, 0], 0.021, C.dark, 0, 6);
  }
  // chainring, on the right
  ring(s, 0.05, 0.085, 0.052, 12, C.steel);
  ring(s, 0.05, 0.085, 0.046, 12, C.steel);
  return s.build();
}

// A lamp's glow: a small octahedron, coloured per instance.
export function lampGeo() {
  const g = new THREE.OctahedronGeometry(1, 1);
  return g;
}

// The pool a headlamp throws on the ground: a soft fan, bright near the bike.
export function poolGeo() {
  const N = 12, pos = [0, 0, 0], col = [1, 1, 1, 0.5], idx = [];
  for (const [r, a] of [[0.5, 0.26], [1, 0]]) {
    for (let i = 0; i < N; i++) {
      const t = i / N * Math.PI * 2;
      pos.push(Math.cos(t) * r, 0, Math.sin(t) * r); col.push(1, 1, 1, a);
    }
  }
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    idx.push(0, 1 + j, 1 + i, 1 + i, 1 + j, 1 + N + j, 1 + i, 1 + N + j, 1 + N + i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}
