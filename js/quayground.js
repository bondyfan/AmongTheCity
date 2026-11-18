// The drawn ground along a Prague quay wall. The quays, ramps and stairs are
// terrain stamps with HARD edges (js/terrainstamps.js, js/naplavky.js): the
// height jumps four or five metres at a wall's face. Every ground mesh is
// sampled at its vertices, 4 to 6 m apart (the ortho photo, the carved ground
// of a river chunk, the paved and green fills), so a triangle straddling the
// face leaned from the quay up to the street as a wedge, and along an
// embankment the wedges stood in a row like sails. quayedge.quaySnap
// moves a vertex near a hard edge onto it (at its own side's height); this
// module makes sure there ARE vertices near the edge, by splitting the
// triangles that come within reach of one, and lifts a geometry the snapping
// way. Away from the Prague quays every function here returns at its first
// test. WORKER SAFE (meshes.js runs in the mesh worker): geometry only.

import * as THREE from 'three';
import { quaySnap, quayGroundY, hardEdgeDist, hardEdgeSide, SNAP } from './quayedge.js';
import { FLIGHTS, inStairBox } from './quayflights.js';

const FINE = 2;            // m: longest edge within reach of a hard edge
const DEPTH = 8;           // splits at most (a 12 m edge needs three)

/**
 * Split the triangles of a flat position list (x, y, z per vertex, three
 * vertices a triangle) whose edges pass near a hard edge, until those edges
 * are FINE. Decided per EDGE, from the edge alone, so two triangles sharing
 * an edge agree on it and no T junction opens. Returns `p` itself when
 * nothing needed splitting.
 */
export function quayRefineArray(p) {
  if (!p || p.length < 9) return p;
  // nothing near a quay: one pass over the vertices, the common case
  let near = false;
  for (let i = 0; i < p.length && !near; i += 9) {
    const cx = (p[i] + p[i + 3] + p[i + 6]) / 3, cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
    if (hardEdgeDist(cx, cz, 12) < 12) near = true;
  }
  if (!near) return p;
  const out = [];
  // An edge is split when it CROSSES a hard edge or ends within SNAP of one
  // (and is longer than FINE). Not "its midpoint within SNAP + L/2": that
  // also caught long edges running beside a wall, spent the depth on them
  // and left the edges across it whole (a fan of wedges from one vertex).
  const need = (ax, az, bx, bz) => {
    const L = Math.hypot(bx - ax, bz - az);
    if (L <= FINE) return false;
    const da = hardEdgeSide(ax, az, SNAP + L), db = hardEdgeSide(bx, bz, SNAP + L);
    if (da !== da && db !== db) return false;               // (NaN: none near)
    if (Math.abs(da) < SNAP || Math.abs(db) < SNAP) return true;
    return da * db < 0;
  };
  const tri = (ax, ay, az, bx, by, bz, cx, cy, cz, d) => {
    const sAB = d < DEPTH && need(ax, az, bx, bz);
    const sBC = d < DEPTH && need(bx, bz, cx, cz);
    const sCA = d < DEPTH && need(cx, cz, ax, az);
    const k = (sAB ? 1 : 0) + (sBC ? 1 : 0) + (sCA ? 1 : 0);
    if (!k) { out.push(ax, ay, az, bx, by, bz, cx, cy, cz); return; }
    const n = d + 1;
    if (k === 3) {
      const abx = (ax + bx) / 2, aby = (ay + by) / 2, abz = (az + bz) / 2;
      const bcx = (bx + cx) / 2, bcy = (by + cy) / 2, bcz = (bz + cz) / 2;
      const cax = (cx + ax) / 2, cay = (cy + ay) / 2, caz = (cz + az) / 2;
      tri(ax, ay, az, abx, aby, abz, cax, cay, caz, n);
      tri(abx, aby, abz, bx, by, bz, bcx, bcy, bcz, n);
      tri(cax, cay, caz, bcx, bcy, bcz, cx, cy, cz, n);
      tri(abx, aby, abz, bcx, bcy, bcz, cax, cay, caz, n);
      return;
    }
    // rotate so the split edges come first (AB, then BC), keeping the winding
    if (k === 1) {
      if (sBC) return tri(bx, by, bz, cx, cy, cz, ax, ay, az, d);
      if (sCA) return tri(cx, cy, cz, ax, ay, az, bx, by, bz, d);
      const mx = (ax + bx) / 2, my = (ay + by) / 2, mz = (az + bz) / 2;
      tri(ax, ay, az, mx, my, mz, cx, cy, cz, n);
      tri(mx, my, mz, bx, by, bz, cx, cy, cz, n);
      return;
    }
    if (!sAB) return tri(bx, by, bz, cx, cy, cz, ax, ay, az, d);
    if (!sBC) return tri(cx, cy, cz, ax, ay, az, bx, by, bz, d);
    const abx = (ax + bx) / 2, aby = (ay + by) / 2, abz = (az + bz) / 2;
    const bcx = (bx + cx) / 2, bcy = (by + cy) / 2, bcz = (bz + cz) / 2;
    tri(abx, aby, abz, bx, by, bz, bcx, bcy, bcz, n);
    tri(ax, ay, az, abx, aby, abz, bcx, bcy, bcz, n);
    tri(ax, ay, az, bcx, bcy, bcz, cx, cy, cz, n);
  };
  for (let i = 0; i < p.length; i += 9) {
    tri(p[i], p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6], p[i + 7], p[i + 8], 0);
  }
  return out.length === p.length ? p : new Float32Array(out);
}

/**
 * quayRefineArray for a non-indexed geometry whose other attributes are one
 * value repeated (terrainTess output: a colour and a surface class per fill).
 */
export function quayRefine(geo) {
  if (!geo || geo.index) return geo;
  const src = geo.attributes.position.array;
  const p = quayRefineArray(src);
  if (p === src) return geo;
  const n = p.length / 3;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  const nrm = new Float32Array(p.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const c = geo.attributes.color?.array;
  if (c) {
    const col = new Float32Array(p.length);
    for (let i = 0; i < col.length; i += 3) { col[i] = c[0]; col[i + 1] = c[1]; col[i + 2] = c[2]; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const s = geo.attributes.surf?.array;
  if (s) g.setAttribute('surf', new THREE.BufferAttribute(new Float32Array(n).fill(s[0]), 1));
  geo.dispose();
  return g;
}

/**
 * Lift the vertices of a flat position list onto the ground, adding to the
 * height each already has (a fill's layer offset), with the vertices near a
 * hard edge moved onto it. (ox, oz): what to add to x and z to get world
 * coordinates (a mesh built around its own centre); `reach`: GRID_SNAP for a
 * plain 4 m grid that was not refined.
 */
export function quayLiftArray(a, terrain, ox = 0, oz = 0, reach = SNAP) {
  let nearStairs = false;
  for (let i = 0; i < a.length; i += 3) {
    const x = a[i] + ox, z = a[i + 2] + oz;
    if (!nearStairs && inStairBox(x, z)) nearStairs = true;
    const q = quaySnap(terrain, x, z, reach);
    if (q) { a[i] = q[0] - ox; a[i + 1] += q[1]; a[i + 2] = q[2] - oz; }
    else a[i + 1] += quayGroundY(terrain, x, z);
  }
  return nearStairs;
}

// At a landing corner two different edges meet. Even after snapping, an
// individual triangle can run from the quay up to a vertex on the street
// side of the wall. The photograph and paving run up to its foot; only the
// stone stair mesh should draw the face above them.
export function quayLiftTriangles(a, terrain) {
  if (!quayLiftArray(a, terrain)) return;
  for (let i = 0; i < a.length; i += 9) {
    const x = (a[i] + a[i + 3] + a[i + 6]) / 3, z = (a[i + 2] + a[i + 5] + a[i + 8]) / 3;
    if (!inStairBox(x, z)) continue;
    const low = Math.min(a[i + 1], a[i + 4], a[i + 7]);
    const high = Math.max(a[i + 1], a[i + 4], a[i + 7]);
    if (high - low < 0.3) continue;
    for (const F of FLIGHTS) {
      if (!F.wall || Math.abs(low - F.y0) > 0.2 || x < F.x0 - FINE || x > F.x1 + FINE ||
          z < F.z0 - FINE || z > F.z1 + FINE) continue;
      const dx = x - F.a[0], dz = z - F.a[1], s = dx * F.ux + dz * F.uz, d = dx * F.nx + dz * F.nz;
      if (s < -F.e0 - FINE || s > F.L + F.e1 + FINE || d < -F.l - FINE || d > F.r + FINE) continue;
      a[i + 1] = a[i + 4] = a[i + 7] = low;
      break;
    }
  }
}

/** meshes.js drape() for a ground fill, the quay way (no fixed ranges). */
export function quayDrape(geo, terrain) {
  if (!terrain || !geo) return geo;
  const p = geo.attributes.position;
  if (geo.index) quayLiftArray(p.array, terrain);
  else quayLiftTriangles(p.array, terrain);
  p.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}
