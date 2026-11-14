// The Prague weirs as things you can see: a dressed stone sill along each
// crest, the face below it a sheet of white water, and a band of foam that
// fades downstream. The levels and lines are riverpools.js; this module only
// turns them into geometry. Worker safe (meshes.js runs in the mesh worker).
//
// The water surface is tessellated at 8 m, far too coarse to carry a 7 m weir
// face or a foam band, so the triangles near a crest are split down to about
// 1.5 m before the surface is lifted onto the level field. Only there: a
// whole river at that density would be a million triangles.

import * as THREE from 'three';
import { WEIRS, WEIR_HALF, FOAM_LEN, riverFlowAt, crestDist, isPooled } from './riverpools.js';

const FINE = 1.6;                        // m: longest edge near a crest
const NEAR = WEIR_HALF + FOAM_LEN + 4;   // m: how far from a crest the surface is refined

const _f = { fx: 0, fz: 0, foam: 0 };

function crestsNear(x0, z0, x1, z1, m) {
  const out = [];
  for (const w of WEIRS) {
    if (w.downY === null) continue;
    for (const [i, j] of w.crest) {
      const a = w.cut[i], b = w.cut[j];
      if (Math.max(a[0], b[0]) < x0 - m || Math.min(a[0], b[0]) > x1 + m
        || Math.max(a[1], b[1]) < z0 - m || Math.min(a[1], b[1]) > z1 + m) continue;
      out.push({ w, a, b });
    }
  }
  return out;
}

function segDist(x, z, a, b) {
  const ex = b[0] - a[0], ez = b[1] - a[1], L2 = ex * ex + ez * ez;
  let u = ((x - a[0]) * ex + (z - a[1]) * ez) / L2;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(x - a[0] - ex * u, z - a[1] - ez * u);
}

/**
 * Split the triangles of a pooled body's surface that lie near a weir crest.
 * `geo` is non-indexed (terrainTess output). Returns `geo` itself when there
 * is nothing to refine.
 */
export function refineNearWeirs(geo, f, x0, z0, x1, z1) {
  if (!geo || !isPooled(f)) return geo;
  const crests = crestsNear(x0, z0, x1, z1, NEAR + 10);
  if (!crests.length) return geo;
  const src = geo.attributes.position.array;
  const out = [];
  // The split is decided per EDGE, from the edge alone, so the two triangles
  // sharing an edge always agree on it: a decision per triangle left T
  // junctions, and once the vertices are lifted onto the weir ramp those
  // open into slits you can see the sky through.
  const need = (ax, az, bx, bz) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L <= FINE) return false;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    for (const c of crests) if (segDist(mx, mz, c.a, c.b) < NEAR + L / 2) return true;
    return false;
  };
  const split = (ax, ay, az, bx, by, bz, cx, cy, cz, depth) => {
    const sAB = depth < 8 && need(ax, az, bx, bz);
    const sBC = depth < 8 && need(bx, bz, cx, cz);
    const sCA = depth < 8 && need(cx, cz, ax, az);
    const k = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);
    if (!k) { out.push(ax, ay, az, bx, by, bz, cx, cy, cz); return; }
    const d = depth + 1;
    if (k === 3) {
      const abx = (ax + bx) / 2, aby = (ay + by) / 2, abz = (az + bz) / 2;
      const bcx = (bx + cx) / 2, bcy = (by + cy) / 2, bcz = (bz + cz) / 2;
      const cax = (cx + ax) / 2, cay = (cy + ay) / 2, caz = (cz + az) / 2;
      split(ax, ay, az, abx, aby, abz, cax, cay, caz, d);
      split(abx, aby, abz, bx, by, bz, bcx, bcy, bcz, d);
      split(cax, cay, caz, bcx, bcy, bcz, cx, cy, cz, d);
      split(abx, aby, abz, bcx, bcy, bcz, cax, cay, caz, d);
      return;
    }
    // rotate so the split edges come first (AB, then BC), keeping the winding
    if (k === 1) {
      if (sBC) return split(bx, by, bz, cx, cy, cz, ax, ay, az, depth);
      if (sCA) return split(cx, cy, cz, ax, ay, az, bx, by, bz, depth);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      split(ax, ay, az, mx, my, mz, cx, cy, cz, d);
      split(mx, my, mz, bx, by, bz, cx, cy, cz, d);
      return;
    }
    // two edges: the unsplit one must be CA
    if (!sAB) return split(bx, by, bz, cx, cy, cz, ax, ay, az, depth);
    if (!sBC) return split(cx, cy, cz, ax, ay, az, bx, by, bz, depth);
    const abx = (ax + bx) / 2, aby = (ay + by) / 2, abz = (az + bz) / 2;
    const bcx = (bx + cx) / 2, bcy = (by + cy) / 2, bcz = (bz + cz) / 2;
    split(abx, aby, abz, bx, by, bz, bcx, bcy, bcz, d);
    split(ax, ay, az, abx, aby, abz, bcx, bcy, bcz, d);
    split(ax, ay, az, bcx, bcy, bcz, cx, cy, cz, d);
  };
  for (let i = 0; i < src.length; i += 9) {
    split(src[i], src[i + 1], src[i + 2], src[i + 3], src[i + 4], src[i + 5],
      src[i + 6], src[i + 7], src[i + 8], 0);
  }
  if (out.length === src.length) return geo;
  const n = out.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(out), 3));
  const nrm = new Float32Array(out.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(out.length), 3));
  const s = geo.attributes.surf?.array;
  if (s) g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n).fill(s[0]), 1));
  geo.dispose();
  return g;
}

/**
 * Write the water shader's per-vertex data into the colour attribute:
 * r, g = the downstream direction (0.5 + 0.5 * dir), b = foam. Every water
 * geometry is painted (still water gets 0.5, 0.5, 0) so the shader can trust
 * the channel. `f` null paints still water.
 */
export function paintFlow(geo, f) {
  if (!geo) return geo;
  const p = geo.attributes.position.array;
  let col = geo.attributes.color;
  if (!col || col.array.length !== p.length) {
    col = new THREE.BufferAttribute(new Float32Array(p.length), 3);
    geo.setAttribute('color', col);
  }
  const c = col.array;
  for (let i = 0; i < p.length; i += 3) {
    if (f) riverFlowAt(f, p[i], p[i + 2], _f);
    else { _f.fx = 0; _f.fz = 0; _f.foam = 0; }
    c[i] = 0.5 + 0.5 * _f.fx; c[i + 1] = 0.5 + 0.5 * _f.fz; c[i + 2] = _f.foam;
  }
  col.needsUpdate = true;
  return geo;
}

// the sill: dressed granite along the crest, a little proud of the pool above
const SILL_W = 1.4, SILL_UP = 0.12, PIECE = 10;
const SILL = [0.30, 0.29, 0.27];

/**
 * Stone sills of every weir crest whose pieces have their midpoint in this
 * chunk (one owner per piece, so neighbours never double them). Absolute
 * heights: the caller marks them fixed like the bank skirts.
 */
export function weirSillsInto(sink, x0, z0, x1, z1) {
  for (const c of crestsNear(x0, z0, x1, z1, PIECE)) {
    const { w, a, b } = c;
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    const ux = ex / L, uz = ez / L;
    // which side of the crest is upstream: probe both normals
    let nx = -uz, nz = ux;
    const px = (a[0] + b[0]) / 2 + nx * 6, pz = (a[1] + b[1]) / 2 + nz * 6;
    if (crestUpstream(w, px, pz) === false) { nx = -nx; nz = -nz; }
    const n = Math.max(1, Math.ceil(L / PIECE));
    const top = w.upY + SILL_UP;
    for (let k = 0; k < n; k++) {
      const s0 = (L * k) / n, s1 = (L * (k + 1)) / n;
      const mx = a[0] + ux * (s0 + s1) / 2, mz = a[1] + uz * (s0 + s1) / 2;
      if (mx < x0 || mx >= x1 || mz < z0 || mz >= z1) continue;
      // the sill sits on the upstream edge of the ramp
      const o0 = WEIR_HALF + SILL_W * 0.6, o1 = WEIR_HALF - SILL_W * 0.4;
      const A0x = a[0] + ux * s0 + nx * o0, A0z = a[1] + uz * s0 + nz * o0;
      const B0x = a[0] + ux * s1 + nx * o0, B0z = a[1] + uz * s1 + nz * o0;
      const A1x = a[0] + ux * s0 + nx * o1, A1z = a[1] + uz * s0 + nz * o1;
      const B1x = a[0] + ux * s1 + nx * o1, B1z = a[1] + uz * s1 + nz * o1;
      sink.triFacing(A0x, top, A0z, B0x, top, B0z, B1x, top, B1z, 0, 1, 0, SILL[0], SILL[1], SILL[2]);
      sink.triFacing(A0x, top, A0z, B1x, top, B1z, A1x, top, A1z, 0, 1, 0, SILL[0], SILL[1], SILL[2]);
      // upstream face into the pool, downstream face down the start of the ramp
      const lo = w.upY - 0.5, drop = w.upY - (w.upY - w.downY) * 0.3;
      sink.triFacing(A0x, top, A0z, B0x, top, B0z, B0x, lo, B0z, nx, 0, nz, SILL[0], SILL[1], SILL[2]);
      sink.triFacing(A0x, top, A0z, B0x, lo, B0z, A0x, lo, A0z, nx, 0, nz, SILL[0], SILL[1], SILL[2]);
      sink.triFacing(A1x, top, A1z, B1x, top, B1z, B1x, drop, B1z, -nx, 0, -nz, SILL[0] * 0.8, SILL[1] * 0.8, SILL[2] * 0.8);
      sink.triFacing(A1x, top, A1z, B1x, drop, B1z, A1x, drop, A1z, -nx, 0, -nz, SILL[0] * 0.8, SILL[1] * 0.8, SILL[2] * 0.8);
    }
  }
}

// true when (x, z) lies on the upstream side of weir `w` (outside its loop)
function crestUpstream(w, x, z) {
  // the loop polygon holds everything downstream
  let c = false;
  const poly = w.ring;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const zi = poly[i][1], zj = poly[j][1];
    if ((zi > z) !== (zj > z)
      && x < (poly[j][0] - poly[i][0]) * (z - zi) / (zj - zi) + poly[i][0]) c = !c;
  }
  return !c;
}

export { crestDist };
