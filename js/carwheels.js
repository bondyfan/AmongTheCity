// ---- carwheels.js: a tyre, an alloy and a brake disc in one mesh -----------
// The old wheel was a 12-sided drum with a grey coin glued on, two meshes a
// corner. This one is a lathed tyre with a rounded shoulder and a sidewall, a
// rim with a lip and a barrel you can see into, a brake disc behind the spokes
// and one of four spoke designs, all merged into a single vertex-coloured
// geometry that rides the shared detail material: ONE draw call a corner and
// no child mesh.
//
// Local frame: the axle is the x axis (rolling = rotation.x, as vehicles.js
// always had it), the wheel is centred on the origin, the dressed face looks
// along +x. wheelGeo() hands back that or its mirror for the other flank.

import * as THREE from 'three';
import { Soup } from './carbody.js';

const lin = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };
const RUBBER = { c: lin(0x131416), r: 0.93, m: 0 };
const WALL = { c: lin(0x191a1d), r: 0.80, m: 0 };
const ALLOY = { c: lin(0xc9ced4), r: 0.26, m: 0.85 };
const ALLOY_D = { c: lin(0x5f646b), r: 0.42, m: 0.8 };     // barrel, in its own shade
const GUN = { c: lin(0x2a2d32), r: 0.36, m: 0.75 };        // dark aero cover / diamond-cut pockets
const STEEL = { c: lin(0x8f959c), r: 0.48, m: 0.7 };
const DISC = { c: lin(0x7c8087), r: 0.38, m: 0.9 };
const VOID = { c: lin(0x050506), r: 0.95, m: 0 };
const WHITE = { c: lin(0xd9dbd8), r: 0.5, m: 0.1 };

// ring of points at radius r, station x (the lathe's one primitive)
function ring(s, base, n, x, r, mat) {
  const ids = [];
  for (let k = 0; k < n; k++) {
    const a = Math.PI * 2 * k / n;
    ids.push(s.v(x, Math.cos(a) * r, Math.sin(a) * r, base + k, mat));
  }
  return ids;
}
// join two rings into a band whose faces look along (nx, nr): nx is the axle
// component, nr the radial one (+ away from the axle, - toward it)
function band(s, A, B, nx, nr) {
  const n = A.length, p = s.p;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n, a = A[k];
    const y = p[a * 3 + 1], z = p[a * 3 + 2], l = Math.hypot(y, z) || 1;
    s.quad(A[k], A[k2], B[k2], B[k], nx, y / l * nr, z / l * nr);
  }
}
// a flat-ish spoke: quad from (r0, half width w0) to (r1, w1) at angle a,
// front face at x0 (hub) → x1 (rim), with two flanks going back `deep`
function spoke(s, a, r0, r1, w0, w1, x0, x1, deep, mat) {
  const ca = Math.cos(a), sa = Math.sin(a);
  const pt = (r, w, x) => [x, ca * r - sa * w, sa * r + ca * w];
  const b = s.base();
  const P = [pt(r0, -w0, x0), pt(r0, w0, x0), pt(r1, w1, x1), pt(r1, -w1, x1)];
  const f = P.map((q, k) => s.v(q[0], q[1], q[2], b + k, mat));
  s.quad(f[0], f[1], f[2], f[3], 1, 0, 0);
  if (deep > 0) {
    // flanks get their own vertices so the spoke edge is a hard chamfer
    for (const [i0, i1, sg] of [[1, 2, 1], [0, 3, -1]]) {
      const q0 = P[i0], q1 = P[i1];
      const v0 = s.v(q0[0], q0[1], q0[2], null, mat), v1 = s.v(q1[0], q1[1], q1[2], null, mat);
      const v2 = s.v(q1[0] - deep, q1[1], q1[2], null, mat), v3 = s.v(q0[0] - deep, q0[1], q0[2], null, mat);
      s.quad(v0, v1, v2, v3, 0, -sa * sg, ca * sg);
    }
  }
}

function build(R, W, design, lod) {
  const s = new Soup(true);
  const n = lod ? 8 : 20;
  const rr = R * (design === 'steel' ? 0.60 : 0.665);          // rim radius
  const hw = W / 2, hgt = R - rr;
  if (lod) {
    // distance wheel: a chamfered drum and a bright disc, about 60 triangles
    const a = ring(s, s.base(), n, hw - 0.01, rr, WALL), b = ring(s, s.base(), n, hw - 0.02, R - 0.02, RUBBER);
    const c = ring(s, s.base(), n, -hw, R - 0.02, RUBBER);
    band(s, a, b, 1, 0); band(s, b, c, 0, 1);
    const hub = s.v(hw - 0.015, 0, 0, null, design === 'aero' ? GUN : design === 'steel' ? STEEL : ALLOY);
    const e = ring(s, s.base(), n, hw - 0.012, rr, design === 'aero' ? GUN : design === 'steel' ? STEEL : ALLOY);
    for (let k = 0; k < n; k++) s.tri(hub, e[k], e[(k + 1) % n], 1, 0, 0);
    return s.build();
  }
  // ---- tyre: inner bead → sidewall → shoulder → tread → and back down ----
  const prof = [
    [-hw, rr + hgt * 0.30, WALL], [-hw * 0.90, R - 0.022, RUBBER], [-hw * 0.66, R, RUBBER],
    [hw * 0.66, R, RUBBER], [hw * 0.90, R - 0.022, RUBBER], [hw, rr + hgt * 0.62, WALL], [hw, rr + hgt * 0.28, WALL],
    [hw * 0.88, rr, WALL],
  ];
  let prev = null, px = 0, pr = 0;
  for (const [x, r, m] of prof) {
    const cur = ring(s, s.base(), n, x, r, m);
    // the profile runs inner bead → tread → outer bead, so its left-hand
    // normal (-dr, dx) is the outside of the tyre all the way round
    if (prev) band(s, prev, cur, -(r - pr), x - px);
    prev = cur; px = x; pr = r;
  }
  // ---- rim: lip, barrel, and a dark floor to stop the eye ----
  const xf = hw * 0.88;                                  // the wheel's face plane
  const lip0 = ring(s, s.base(), n, xf, rr, ALLOY), lip1 = ring(s, s.base(), n, xf - 0.004, rr - 0.016, ALLOY);
  band(s, lip0, lip1, 1, 0);
  const bar0 = ring(s, s.base(), n, xf - 0.004, rr - 0.016, ALLOY_D), bar1 = ring(s, s.base(), n, xf - 0.075, rr - 0.022, ALLOY_D);
  band(s, bar0, bar1, 0, -1);
  const floorC = s.v(xf - 0.075, 0, 0, null, VOID), fl = ring(s, s.base(), n, xf - 0.075, rr - 0.022, VOID);
  for (let k = 0; k < n; k++) s.tri(floorC, fl[k], fl[(k + 1) % n], 1, 0, 0);
  // ---- brake disc: a steel annulus you glimpse between the spokes ----
  const d0 = ring(s, s.base(), n, xf - 0.055, rr * 0.80, DISC), d1 = ring(s, s.base(), n, xf - 0.055, rr * 0.30, DISC);
  band(s, d0, d1, 1, 0);
  // ---- the face ----
  const rin = rr - 0.02, xh = xf - 0.022, xr = xf - 0.008;      // dished: hub sits back
  const hubR = rr * 0.24;
  const cap = (r, x, mat) => {
    const c = s.v(x + 0.004, 0, 0, null, mat), e = ring(s, s.base(), 10, x, r, mat);
    for (let k = 0; k < 10; k++) s.tri(c, e[k], e[(k + 1) % 10], 1, 0, 0);
  };
  if (design === 'five') {
    // five split spokes, each a slim V: the everyday Czech alloy
    for (let k = 0; k < 5; k++) {
      const a = Math.PI * 2 * k / 5 + 0.3;
      spoke(s, a - 0.10, hubR * 0.7, rin, 0.012, 0.016, xh, xr, 0.02, ALLOY);
      spoke(s, a + 0.10, hubR * 0.7, rin, 0.012, 0.016, xh, xr, 0.02, ALLOY);
    }
    cap(hubR, xh + 0.004, ALLOY);
  } else if (design === 'multi') {
    // ten thin blades: the German multi-spoke
    for (let k = 0; k < 10; k++) spoke(s, Math.PI * 2 * k / 10, hubR * 0.8, rin, 0.011, 0.013, xh, xr, 0.018, ALLOY);
    cap(hubR, xh + 0.004, ALLOY);
  } else if (design === 'star') {
    // five broad Y spokes, dark pockets: a sport wheel
    for (let k = 0; k < 5; k++) {
      const a = Math.PI * 2 * k / 5 + 0.1;
      spoke(s, a, hubR * 0.6, rin * 0.62, 0.030, 0.022, xh, xh + 0.006, 0.02, ALLOY);
      spoke(s, a - 0.16, rin * 0.56, rin, 0.014, 0.014, xh + 0.005, xr, 0.018, ALLOY);
      spoke(s, a + 0.16, rin * 0.56, rin, 0.014, 0.014, xh + 0.005, xr, 0.018, ALLOY);
    }
    cap(hubR, xh + 0.004, GUN);
  } else if (design === 'aero') {
    // a closed dark cover with five light blades: the electric car's wheel
    const c = s.v(xh + 0.012, 0, 0, null, GUN), e = ring(s, s.base(), n, xr, rin, GUN);
    for (let k = 0; k < n; k++) s.tri(c, e[k], e[(k + 1) % n], 1, 0, 0);
    for (let k = 0; k < 5; k++) spoke(s, Math.PI * 2 * k / 5 + 0.2, hubR * 0.9, rin * 0.97, 0.03, 0.012, xh + 0.014, xr + 0.003, 0, ALLOY);
    cap(hubR * 0.8, xh + 0.013, ALLOY);
  } else {
    // steel: a dished disc, a ring of hand holes, a proud hub. Vans, trucks, buses.
    const m = design === 'steelw' ? WHITE : STEEL;
    const e0 = ring(s, s.base(), n, xr, rin, m), e1 = ring(s, s.base(), n, xh - 0.015, rr * 0.5, m);
    band(s, e0, e1, 1, 0);
    const c = s.v(xh + 0.02, 0, 0, null, m), e2 = ring(s, s.base(), n, xh - 0.015, rr * 0.5, m);
    for (let k = 0; k < n; k++) s.tri(c, e2[k], e2[(k + 1) % n], 1, 0, 0);
    for (let k = 0; k < 8; k++) {
      const a = Math.PI * 2 * k / 8, r = rr * 0.72;
      const h = s.v(xh - 0.004, Math.cos(a) * r, Math.sin(a) * r, null, VOID);
      const b = s.base(), q = [];
      for (let j = 0; j < 6; j++) {
        const t = Math.PI * 2 * j / 6;
        q.push(s.v(xh - 0.004 + (xr - xh) * 0.45, Math.cos(a) * r + Math.cos(t) * rr * 0.085, Math.sin(a) * r + Math.sin(t) * rr * 0.085, b + j, VOID));
      }
      for (let j = 0; j < 6; j++) s.tri(h, q[j], q[(j + 1) % 6], 1, 0, 0);
    }
  }
  return s.build();
}

const _cache = new Map();
// side: +1 dressed face toward +x (right-hand wheels), -1 toward -x
export function wheelGeo(R, W, design, side = 1, lod = false) {
  const key = `${R}|${W}|${design}|${side}|${lod ? 1 : 0}`;
  let g = _cache.get(key);
  if (g) return g;
  g = build(R, W, design, lod);
  if (side < 0) {
    // mirror through x and flip the winding with it
    g.scale(-1, 1, 1);
    const ix = g.index.array;
    for (let k = 0; k < ix.length; k += 3) { const t = ix[k + 1]; ix[k + 1] = ix[k + 2]; ix[k + 2] = t; }
    g.computeVertexNormals();
  }
  _cache.set(key, g);
  return g;
}
