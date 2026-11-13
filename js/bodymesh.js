// ---- bodymesh.js: the surface a person is made of --------------------------
//
// A citizen used to be twenty-odd boxes in thirteen meshes. This is the tool
// that replaces the boxes: a small builder that lofts closed, smooth tubes
// through elliptical rings (a torso, a thigh, a skull, a shoe are all the same
// primitive with different numbers) and writes them, with vertex colours and
// two-bone skin weights, into ONE BufferGeometry. One geometry means one
// SkinnedMesh, and one SkinnedMesh means one draw call per person, where the
// box figure paid thirteen.
//
// THE FAR VARIANT COSTS NO SECOND MESH. Every tube also emits a coarse set of
// triangles over the SAME vertices (every other segment, a chosen subset of
// rings), appended after the fine ones in the same index buffer. Switching a
// person to the distance variant is `geometry.setDrawRange(farStart, farCount)`
// and nothing else: no extra buffers, no extra objects, no pop in the skeleton.
// Parts that only matter up close (eyes, ears, collars, zips) simply emit no
// coarse triangles.
//
// Conventions, the same as the rest of the figure: metres, feet at y = 0,
// FACING -z, +x is the figure's right. Ring angle 0 is the FRONT (-z) and it
// increases toward +x.

import * as THREE from 'three';

const _col = new THREE.Color();
const _lin = new Map();
// hex (sRGB, as written in a palette) to linear floats, cached: a wardrobe has
// a few dozen colours and every vertex of a sleeve asks for the same one
function rgb(hex) {
  let c = _lin.get(hex);
  if (!c) { _col.setHex(hex); c = [_col.r, _col.g, _col.b]; _lin.set(hex, c); }
  return c;
}

/** Multiply a hex colour's brightness (a shade for a hem, a cuff, a sole). */
export function shade(hex, k) {
  const r = Math.min(255, ((hex >> 16) & 255) * k) | 0;
  const g = Math.min(255, ((hex >> 8) & 255) * k) | 0;
  const b = Math.min(255, (hex & 255) * k) | 0;
  return (r << 16) | (g << 8) | b;
}

/** Linear mix of two hex colours, t = 0 gives a. */
export function mix(a, b, t) {
  const m = (sa, sb) => Math.round(sa + (sb - sa) * t);
  return (m((a >> 16) & 255, (b >> 16) & 255) << 16)
    | (m((a >> 8) & 255, (b >> 8) & 255) << 8) | m(a & 255, b & 255);
}

// signed power: the superellipse that lets one ring be an ellipse (p = 2), a
// soft box (p = 4) or anything between
const spow = (v, e) => (v < 0 ? -Math.pow(-v, e) : Math.pow(v, e));

export class BodyMesh {
  constructor() {
    this.p = []; this.n = []; this.c = [];
    this.bi = []; this.bw = [];
    this.near = []; this.far = [];
  }

  get count() { return this.p.length / 3; }

  // bone may be an index or [boneA, boneB, weightOfA]
  _vert(x, y, z, hex, bone) {
    const i = this.p.length / 3;
    this.p.push(x, y, z);
    this.n.push(0, 1, 0);
    const c = rgb(hex);
    this.c.push(c[0], c[1], c[2]);
    if (typeof bone === 'number') { this.bi.push(bone, bone, 0, 0); this.bw.push(255, 0, 0, 0); } else {
      const w = Math.max(0, Math.min(255, Math.round(bone[2] * 255)));
      this.bi.push(bone[0], bone[1], 0, 0); this.bw.push(w, 255 - w, 0, 0);
    }
    return i;
  }

  /**
   * Loft a closed tube through `rings`, in the order given (either direction).
   * A ring: { x, y, z   centre (x and z default 0)
   *           rx, rz    half width and half depth (rz defaults to rx)
   *           fz, bz    front and back half depth when they differ
   *           p         superellipse exponent (default o.p, default 2)
   *           c | cf    colour, or (j, S) => colour for a per-vertex one
   *           c2 | cf2  a second colour: the ring is emitted twice and the band
   *                     above it starts in c2, which draws a hard line (a belt,
   *                     a hem, a cuff) instead of a gradient
   *           b | bf    bone, [a, b, wa], or (j, S) => either
   *           rf        (j, S) => radial scale of one vertex (hair uses it to
   *                     sink the part of a ring that is face, not hair) }
   * A ring with rx = 0 is a pole and closes the tube.
   * o: { segs, p, m (Matrix4 applied to every point), phase (0.5 shifts the
   *      vertices half a segment, so none sits on the centre line),
   *      far: false | [ring indices kept], farStep (2) }
   */
  tube(rings, o = {}) {
    const S = o.segs ?? 8, ph = o.phase ?? 0, R = rings.length;
    const P = new Float32Array(R * S * 3), C = new Float32Array(R * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < R; i++) {
      const r = rings[i], e = 2 / (r.p ?? o.p ?? 2);
      const rz = r.rz ?? r.rx;
      v.set(r.x ?? 0, r.y, r.z ?? 0); if (o.m) v.applyMatrix4(o.m);
      C[i * 3] = v.x; C[i * 3 + 1] = v.y; C[i * 3 + 2] = v.z;
      for (let j = 0; j < S; j++) {
        const t = (j + ph) / S * Math.PI * 2, sn = Math.sin(t), cs = Math.cos(t);
        const dz = cs > 0 ? (r.fz ?? rz) : (r.bz ?? rz), f = r.rf ? r.rf(j, S) : 1;
        v.set((r.x ?? 0) + spow(sn, e) * r.rx * f, r.y, (r.z ?? 0) - spow(cs, e) * dz * f);
        if (o.m) v.applyMatrix4(o.m);
        const k = (i * S + j) * 3;
        P[k] = v.x; P[k + 1] = v.y; P[k + 2] = v.z;
      }
    }
    // normals off the grid itself: across the ring times along the tube,
    // turned to face away from the ring's centre. A pole points along the axis.
    const N = new Float32Array(R * S * 3);
    for (let i = 0; i < R; i++) {
      const ia = Math.max(0, i - 1), ib = Math.min(R - 1, i + 1);
      for (let j = 0; j < S; j++) {
        const k = (i * S + j) * 3, jp = (i * S + (j + 1) % S) * 3, jm = (i * S + (j + S - 1) % S) * 3;
        const ka = (ia * S + j) * 3, kb = (ib * S + j) * 3;
        const ax = P[jp] - P[jm], ay = P[jp + 1] - P[jm + 1], az = P[jp + 2] - P[jm + 2];
        const bx = P[kb] - P[ka], by = P[kb + 1] - P[ka + 1], bz = P[kb + 2] - P[ka + 2];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        let ox = P[k] - C[i * 3], oy = P[k + 1] - C[i * 3 + 1], oz = P[k + 2] - C[i * 3 + 2];
        let l = Math.hypot(nx, ny, nz);
        if (l < 1e-9 || rings[i].rx === 0) {
          // pole or collapsed ring: straight away from the nearest ring that
          // is not at the same point (a flat cap puts its pole ON the last ring)
          const dir = i === 0 ? 1 : -1;
          for (let q = i + dir; q >= 0 && q < R; q += dir) {
            nx = C[i * 3] - C[q * 3]; ny = C[i * 3 + 1] - C[q * 3 + 1]; nz = C[i * 3 + 2] - C[q * 3 + 2];
            l = Math.hypot(nx, ny, nz);
            if (l > 1e-9) break;
          }
          if (l < 1e-9) { nx = 0; ny = 1; nz = 0; l = 1; }
          ox = nx; oy = ny; oz = nz;
        }
        if (nx * ox + ny * oy + nz * oz < 0) l = -l;
        N[k] = nx / l; N[k + 1] = ny / l; N[k + 2] = nz / l;
      }
    }
    // rows: a seam ring becomes two rows over the same points
    const lo = new Int32Array(R), hi = new Int32Array(R);
    const emit = (i, col, cf) => {
      const r = rings[i], start = this.count;
      for (let j = 0; j < S; j++) {
        const k = (i * S + j) * 3;
        const b = r.bf ? r.bf(j, S) : (r.b ?? o.b ?? 0);
        const idx = this._vert(P[k], P[k + 1], P[k + 2], cf ? cf(j, S) : col, b);
        this.n[idx * 3] = N[k]; this.n[idx * 3 + 1] = N[k + 1]; this.n[idx * 3 + 2] = N[k + 2];
      }
      return start;
    };
    for (let i = 0; i < R; i++) {
      const r = rings[i], c = r.c ?? o.c ?? 0x808080;
      lo[i] = emit(i, c, r.cf);
      hi[i] = (r.c2 != null || r.cf2) ? emit(i, r.c2 ?? c, r.cf2) : lo[i];
    }
    // which way round is outward? ask the first band that has any area
    let flip = false;
    for (let i = 0; i + 1 < R; i++) {
      if (rings[i].rx === 0 || rings[i + 1].rx === 0) continue;
      const a = (i * S) * 3, b = (i * S + 1) * 3, d = ((i + 1) * S) * 3;
      const ux = P[d] - P[a], uy = P[d + 1] - P[a + 1], uz = P[d + 2] - P[a + 2];
      const wx = P[b] - P[a], wy = P[b + 1] - P[a + 1], wz = P[b + 2] - P[a + 2];
      const fx = uy * wz - uz * wy, fy = uz * wx - ux * wz, fz = ux * wy - uy * wx;
      flip = fx * N[a] + fy * N[a + 1] + fz * N[a + 2] < 0;
      break;
    }
    const band = (out, ia, ib, step) => {
      const A = hi[ia], Bq = lo[ib], pa = rings[ia].rx === 0, pb = rings[ib].rx === 0;
      for (let j = 0; j < S; j += step) {
        const j2 = (j + step) % S;
        const a = A + j, b = A + j2, c = Bq + j2, d = Bq + j;
        if (!pa) { if (flip) out.push(a, b, d); else out.push(a, d, b); }
        if (!pb) { if (flip) out.push(b, c, d); else out.push(b, d, c); }
      }
    };
    for (let i = 0; i + 1 < R; i++) band(this.near, i, i + 1, 1);
    if (o.far !== false) {
      const keep = o.far ?? rings.map((_, i) => i).filter((i) => i === 0 || i === R - 1 || i % 2 === 0);
      const step = S % (o.farStep ?? 2) === 0 ? (o.farStep ?? 2) : 1;
      for (let q = 0; q + 1 < keep.length; q++) band(this.far, keep[q], keep[q + 1], step);
    }
    return this;
  }

  /** An ellipsoid, as a tube with poles. */
  blob(cx, cy, cz, rx, ry, rz, c, b, o = {}) {
    const n = o.rings ?? 4, rings = [];
    for (let i = 0; i <= n; i++) {
      const a = -Math.PI / 2 + Math.PI * i / n, k = i === 0 || i === n ? 0 : Math.cos(a);
      rings.push({ x: cx, y: cy + Math.sin(a) * ry, z: cz, rx: rx * k, rz: rz * k, c, b });
    }
    return this.tube(rings, { segs: o.segs ?? 6, far: o.far ?? false, m: o.m });
  }

  /**
   * Free triangles: verts [[x, y, z], ...], tris [[a, b, c], ...] wound
   * counter-clockwise seen from outside. A vertex may carry its own colour and
   * bone as a 4th and 5th entry. Normals are the average of the faces round
   * each vertex, or o.normal for a flat patch. Near only unless o.far is true.
   */
  poly(verts, tris, c, b, o = {}) {
    const base = this.count;
    for (const q of verts) this._vert(q[0], q[1], q[2], q[3] ?? c, q[4] ?? b);
    const acc = new Float32Array(verts.length * 3);
    for (const t of tris) {
      const A = verts[t[0]], B = verts[t[1]], Cc = verts[t[2]];
      const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
      const wx = Cc[0] - A[0], wy = Cc[1] - A[1], wz = Cc[2] - A[2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      // o.normal also says which way is out, so a patch cannot be wound wrong
      // (or o.from, a point inside the solid the triangles wrap)
      const out = o.from ? [(A[0] + B[0] + Cc[0]) / 3 - o.from[0], (A[1] + B[1] + Cc[1]) / 3 - o.from[1], (A[2] + B[2] + Cc[2]) / 3 - o.from[2]] : o.normal;
      if (out && nx * out[0] + ny * out[1] + nz * out[2] < 0) {
        const q = t[1]; t[1] = t[2]; t[2] = q; nx = -nx; ny = -ny; nz = -nz;
      }
      for (const i of t) { acc[i * 3] += nx; acc[i * 3 + 1] += ny; acc[i * 3 + 2] += nz; }
      this.near.push(base + t[0], base + t[1], base + t[2]);
      if (o.far) this.far.push(base + t[0], base + t[1], base + t[2]);
    }
    for (let i = 0; i < verts.length; i++) {
      const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]) || 1;
      const k = (base + i) * 3;
      if (o.normal) { this.n[k] = o.normal[0]; this.n[k + 1] = o.normal[1]; this.n[k + 2] = o.normal[2]; } else {
        this.n[k] = acc[i * 3] / l; this.n[k + 1] = acc[i * 3 + 1] / l; this.n[k + 2] = acc[i * 3 + 2] / l;
      }
    }
    return this;
  }

  /** A flat convex patch as a fan round its first vertex (an eye, a button). */
  fan(verts, c, b, o = {}) {
    const tris = [];
    for (let i = 1; i + 1 < verts.length; i++) tris.push([0, i, i + 1]);
    return this.poly(verts, tris, c, b, o);
  }

  /**
   * The finished geometry. userData carries the two draw ranges:
   * { nearCount, farStart, farCount, tris: { near, far } }.
   */
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint8Array(this.bi), 4));
    g.setAttribute('skinWeight', new THREE.BufferAttribute(new Uint8Array(this.bw), 4, true));
    const nN = this.near.length, nF = this.far.length;
    const idx = new Uint16Array(nN + nF);
    idx.set(this.near, 0); idx.set(this.far, nN);
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, nN);
    g.userData = { nearCount: nN, farStart: nN, farCount: nF, tris: { near: nN / 3, far: nF / 3 } };
    return g;
  }
}
