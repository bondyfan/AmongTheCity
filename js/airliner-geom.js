// ---- airliner-geom.js: the small geometry kit the airliner is built from ----
// The airliner is a few hundred pieces (wings, panels, windows, gear) and the
// game wants them in a handful of draw calls. So every piece is built as its own
// geometry, painted, and then poured into a Bag that merges them into one buffer
// per material. The shapes come from four builders:
//   tube   a smooth lofted tube along z (fuselage, nacelles): vertex normals,
//          so the body reads round and not like a box
//   slab   a flat planform with a thickness (wings, fin, tailplane): flat faces,
//          because a real wing has crisp edges
//   prism  a flat outline extruded across x (sharklets, fin cores)
//   mirror a copy of a piece on the other side of the aircraft, wound correctly
// No three.js example files are needed: BufferGeometryUtils is not used, so the
// merge is a few lines and the vertex layout is exactly what the materials expect.

import * as THREE from 'three';

// Paint, as sRGB hex. The livery in brief: white skin, light grey belly, navy
// cheatline and fin, dark glass.
export const PAINT = {
  white: 0xf4f6f8,
  belly: 0xc3c9cf,
  navy: 0x1b2f55,
  glass: 0x18242f,
  intake: 0x1d2024,
  wheel: 0x2b2e33,
  strut: 0xb4bcc4,
  steel: 0x7d868f,
  spinner: 0xe6e9ec,
  fan: 0x3a3f46,
  nozzle: 0x4b4f55,
  frame: 0x9aa3ab,
};

/** A growing list of triangles in flat arrays, all painted by vertex colour. */
export class Bag {
  constructor() {
    this.pos = [];
    this.nrm = [];
    this.col = [];
  }
  /** Pour `geom` into the bag, moved by matrix `m`, painted `color`. `color` is a
   *  hex number, or a function (x, y, z) -> hex for paint that changes across the
   *  surface (the fuselage's belly and cheatline), evaluated per vertex. */
  add(geom, color, m = null) {
    const g = geom.index ? geom.toNonIndexed() : geom;
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal;
    const paint = typeof color === 'function' ? null : new THREE.Color(color);
    const nm = m ? new THREE.Matrix3().getNormalMatrix(m) : null;
    const v = new THREE.Vector3(), w = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      if (m) v.applyMatrix4(m);
      w.fromBufferAttribute(n, i);
      if (nm) w.applyMatrix3(nm).normalize();
      const c = paint || new THREE.Color(color(v.x, v.y, v.z));
      this.pos.push(v.x, v.y, v.z);
      this.nrm.push(w.x, w.y, w.z);
      this.col.push(c.r, c.g, c.b);
    }
    return this;
  }
  get vertexCount() {
    return this.pos.length / 3;
  }
  /** One buffer geometry from everything poured so far. Non-indexed, so the
   *  per-vertex normals and colours are exactly the ones added. */
  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    return g;
  }
}

/** A mirror image across the plane x = 0. Negating x turns the triangles inside
 *  out, so every triangle's vertex order is swapped as well, and the flat normals
 *  are recomputed from the new winding. */
export function mirrorX(geom) {
  const g = geom.index ? geom.toNonIndexed() : geom.clone();
  const p = g.attributes.position;
  const a = new Float32Array(p.count * 3);
  for (let t = 0; t < p.count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const src = t + (k === 1 ? 2 : k === 2 ? 1 : 0);
      a[(t + k) * 3] = -p.getX(src);
      a[(t + k) * 3 + 1] = p.getY(src);
      a[(t + k) * 3 + 2] = p.getZ(src);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(a, 3));
  out.computeVertexNormals();
  return out;
}

// Signed volume of a triangle list about a centre: positive when the faces point
// outward. A tube with open ends is still nearly closed, so this is a safe sign.
function signedVolume(pos, idx, c) {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3, b = idx[i + 1] * 3, d = idx[i + 2] * 3;
    const ax = pos[a] - c[0], ay = pos[a + 1] - c[1], az = pos[a + 2] - c[2];
    const bx = pos[b] - c[0], by = pos[b + 1] - c[1], bz = pos[b + 2] - c[2];
    const cx = pos[d] - c[0], cy = pos[d + 1] - c[1], cz = pos[d + 2] - c[2];
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v;
}

/**
 * A smooth lofted tube along z. `zs` are the stations (ascending), `section(z)`
 * gives the cross-section there as { xc, yc, a, b } (an ellipse of half-width a
 * and half-height b centred on (xc, yc)). `skip(zc, xc, yc)` drops a quad when it
 * returns true, which is how the door opening is cut out of the skin.
 * Vertex normals are smooth, and the winding is checked to point outward.
 */
export function tube(zs, section, seg = 40, skip = null) {
  const n = zs.length;
  const pos = [];
  const sec = [];
  for (let i = 0; i < n; i++) {
    const s = section(zs[i]);
    sec.push(s);
    for (let j = 0; j < seg; j++) {
      const t = (j / seg) * Math.PI * 2;
      pos.push(s.xc + s.a * Math.cos(t), s.yc + s.b * Math.sin(t), zs[i]);
    }
  }
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < seg; j++) {
      const j1 = (j + 1) % seg;
      const a = i * seg + j, b = i * seg + j1, c = (i + 1) * seg + j1, d = (i + 1) * seg + j;
      if (skip) {
        // the quad's centre, from its four corners
        const zc = (zs[i] + zs[i + 1]) / 2;
        const xc = (pos[a * 3] + pos[b * 3] + pos[c * 3] + pos[d * 3]) / 4;
        const yc = (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1] + pos[d * 3 + 1]) / 4;
        if (skip(zc, xc, yc)) continue;
      }
      idx.push(a, d, b, b, d, c);
    }
  }
  // the centre of the whole tube, to tell the outside from the inside
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < pos.length; i += 3) {
    cx += pos[i];
    cy += pos[i + 1];
    cz += pos[i + 2];
  }
  const k = pos.length / 3;
  const c = [cx / k, cy / k, cz / k];
  if (signedVolume(pos, idx, c) < 0) for (let i = 0; i < idx.length; i += 3) {
    const t = idx[i + 1];
    idx[i + 1] = idx[i + 2];
    idx[i + 2] = t;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A flat planform with thickness. `plan` is the outline as [x, z] pairs (convex
 * for every piece this aircraft uses), `topY(x)` is the top surface's height at
 * that x (the dihedral lives there), and `t` the thickness, taken downward.
 * Faces are flat. Each triangle is turned to point away from the solid's centre,
 * so the winding is right whatever order the outline came in.
 */
export function slab(plan, topY, t) {
  const n = plan.length;
  const P = [];
  for (const [x, z] of plan) P.push([x, topY(x), z]);
  for (const [x, z] of plan) P.push([x, topY(x) - t, z]);
  let cx = 0, cy = 0, cz = 0;
  for (const p of P) {
    cx += p[0];
    cy += p[1];
    cz += p[2];
  }
  const C = [cx / P.length, cy / P.length, cz / P.length];
  const pts2 = plan.map(([x, z]) => new THREE.Vector2(x, z));
  const tris = THREE.ShapeUtils.triangulateShape(pts2, []);
  const T = [];
  for (const [a, b, c] of tris) {
    T.push([a, b, c]);
    T.push([n + a, n + c, n + b]);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    T.push([i, j, n + j], [i, n + j, n + i]);
  }
  const pos = [];
  for (let [a, b, c] of T) {
    const A = P[a], B = P[b], Cc = P[c];
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const v = [Cc[0] - A[0], Cc[1] - A[1], Cc[2] - A[2]];
    const N = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const mid = [(A[0] + B[0] + Cc[0]) / 3 - C[0], (A[1] + B[1] + Cc[1]) / 3 - C[1], (A[2] + B[2] + Cc[2]) / 3 - C[2]];
    if (N[0] * mid[0] + N[1] * mid[1] + N[2] * mid[2] < 0) [b, c] = [c, b];
    for (const q of [P[a], P[b], P[c]]) pos.push(q[0], q[1], q[2]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A flat outline in the (z, y) plane, extruded across x from `x0` to `x0 + t`.
 * `poly` is [[z, y], ...]. Used for the fin, the sharklets and the nacelle pylons:
 * anything that is a profile seen from the side.
 */
export function prismZY(poly, t, x0) {
  const shape = new THREE.Shape(poly.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, steps: 1 });
  // (shape x, shape y, extrude depth) -> (x, y, z) = (depth + x0, y, -shape x).
  // The determinant of that map is +1, so the winding stays outward.
  const m = new THREE.Matrix4().set(0, 0, 1, x0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1);
  g.applyMatrix4(m);
  g.computeVertexNormals();
  return g;
}

/** A plain box, centred on (x, y, z), sized (w, h, d). */
export function boxAt(x, y, z, w, h, d) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(x, y, z);
  return g;
}

/** A cylinder with its axis along y (wheels and struts are turned with rotateX/Z). */
export function cylAt(x, y, z, r, h, seg = 12) {
  return new THREE.CylinderGeometry(r, r, h, seg).translate(x, y, z);
}
