// ---- airliner-body.js: the fuselage skin, its livery, windows and the L1 door ----
// The skin is a single lofted tube from the nose tip to the tail cone, built from
// the same cross-section function the walls use (skinSection in the layout), so
// the outside and the cabin lining can never drift apart. It is FrontSide: from
// inside the cabin the back of the skin is culled, which is exactly why the
// passenger sees the sky through the window openings and not a grey wall.
//
// The door is cut out of the tube (quads inside the door's outline are skipped),
// and the L1 door is a separate panel that pivots on its forward edge, so it can
// swing open. Windows are dark quads laid on the skin just outside it.

import * as THREE from 'three';
import { AIRLINER as A, DOOR_L1, WINDOW, skinSection, skinHalfWidth } from './airliner-layout.js';
import { PAINT, tube, boxAt } from './airliner-geom.js';

// Stations along z: every 0.4 m, plus the door's two edges so the cut is clean.
export const BODY_STATIONS = (() => {
  const zs = [];
  for (let z = A.noseZ; z < A.tailZ; z += 0.4) zs.push(z);
  zs.push(A.tailZ, DOOR_L1.z - DOOR_L1.w / 2, DOOR_L1.z + DOOR_L1.w / 2);
  zs.sort((p, q) => p - q);
  return zs.filter((z, i) => i === 0 || z - zs[i - 1] > 1e-6);
})();

// A quad on the skin is skipped when its centre is inside the door's outline.
// Left side only (x < 0), from just below the sill to just above the head.
function skipDoor(zc, xc, yc) {
  return xc < -1.0 && Math.abs(zc - DOOR_L1.z) <= DOOR_L1.w / 2 + 1e-3 &&
    yc > DOOR_L1.sill - 0.03 && yc < DOOR_L1.sill + DOOR_L1.h + 0.03;
}

// Paint by height: white crown, light grey below the window line, a slim navy
// cheatline at the window bottoms. Evaluated per vertex.
export function fuselagePaint(x, y) {
  if (y > 4.02 && y < 4.22) return PAINT.navy;
  if (y < 2.6) return PAINT.belly;
  return PAINT.white;
}

/** The fuselage tube, with the door cut out. Painted by fuselagePaint. */
export function fuselageGeometry() {
  return tube(BODY_STATIONS, (z) => {
    const s = skinSection(z);
    return { xc: 0, yc: s.yc, a: s.a, b: s.b };
  }, 40, skipDoor);
}

// A point on the skin at longitudinal z and ellipse angle th (0 = right side,
// pi/2 = top), lifted `off` metres off the skin so the glass does not z-fight.
function skinPoint(z, th, off = 0.03) {
  const s = skinSection(z);
  return [(s.a + off) * Math.cos(th), s.yc + (s.b + off) * Math.sin(th), z];
}

// A flat quad from four points, wound so its normal faces away from the tube's
// axis at that point. The window faces out, where it can be seen, and its back
// is culled, so from inside it is see-through like the skin.
function quadGeom(p) {
  const cx = (p[0][0] + p[1][0] + p[2][0] + p[3][0]) / 4;
  const cy = (p[0][1] + p[1][1] + p[2][1] + p[3][1]) / 4;
  const cz = (p[0][2] + p[1][2] + p[2][2] + p[3][2]) / 4;
  const oy = cy - skinSection(cz).yc;
  const a = p[0], b = p[1], c = p[2];
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const flip = n[0] * cx + n[1] * oy < 0;
  const order = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
  const pos = [];
  for (const i of order) pos.push(p[i][0], p[i][1], p[i][2]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

// One passenger window on one side (side = +1 right, -1 left) at row z. The
// window's corners are placed on the skin's own ellipse, so it lies on the curve.
function sideWindowAt(z, side) {
  const half = WINDOW.width / 2;
  const y0 = A.floorY + WINDOW.centreAbove - WINDOW.height / 2;
  const y1 = y0 + WINDOW.height;
  const at = (zz, y) => {
    const s = skinSection(zz);
    const k = Math.max(0, 1 - ((y - s.yc) / s.b) ** 2);
    return [side * (s.a + 0.03) * Math.sqrt(k), y, zz];
  };
  return quadGeom([at(z - half, y0), at(z + half, y0), at(z + half, y1), at(z - half, y1)]);
}

/** The glass: a window per passenger row on both sides, the cockpit side windows
 *  and the windscreen across the top front of the nose. Poured into `dark`. */
export function addGlass(dark, rowZ) {
  for (const z of rowZ) {
    dark.add(sideWindowAt(z, 1), PAINT.glass);
    dark.add(sideWindowAt(z, -1), PAINT.glass);
  }
  // The cockpit glass lies on the most curved part of the airframe: one flat
  // quad across it sank into the skin in its middle and showed only its edges
  // (a black bracket on each cheek). So each pane is a small grid of quads that
  // follows the skin: the two windscreens on the forward slope of the nose, the
  // sliding side window and the one behind it on each side.
  const top = Math.PI / 2;
  const patch = (z0, z1, th0, th1) => {
    const NZ = 3, NT = 6;
    for (let i = 0; i < NZ; i++)
      for (let j = 0; j < NT; j++) {
        const za = z0 + (z1 - z0) * i / NZ, zb = z0 + (z1 - z0) * (i + 1) / NZ;
        const ta = th0 + (th1 - th0) * j / NT, tb = th0 + (th1 - th0) * (j + 1) / NT;
        dark.add(quadGeom([skinPoint(za, ta, 0.035), skinPoint(za, tb, 0.035), skinPoint(zb, tb, 0.035), skinPoint(zb, ta, 0.035)]),
          PAINT.glass);
      }
  };
  patch(-19.2, -18.45, top - 0.62, top - 0.04); // windscreen, right
  patch(-19.2, -18.45, top + 0.04, top + 0.62); // windscreen, left
  for (const sg of [1, -1]) {
    const a = sg > 0 ? 0.32 : Math.PI - 0.92, b = sg > 0 ? 0.92 : Math.PI - 0.32;
    patch(-18.4, -17.75, a, b);                  // the sliding side window
    patch(-17.65, -17.15, sg > 0 ? 0.42 : Math.PI - 0.86, sg > 0 ? 0.86 : Math.PI - 0.42); // the one behind it
  }
}

/** The tail cap: a disc closing the open end of the tube, so it is not hollow. */
export function tailCapGeometry() {
  const s = skinSection(A.tailZ);
  const pos = [];
  const seg = 40;
  for (let j = 0; j < seg; j++) {
    const t0 = (j / seg) * Math.PI * 2, t1 = ((j + 1) / seg) * Math.PI * 2;
    pos.push(0, s.yc, A.tailZ,
      s.a * Math.cos(t0), s.yc + s.b * Math.sin(t0), A.tailZ,
      s.a * Math.cos(t1), s.yc + s.b * Math.sin(t1), A.tailZ);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return g;
}

/** The L1 door panel in a frame whose origin is its forward hinge, on the skin's
 *  line, running aft to +z. rotation.y of the mesh swings it out. */
export function doorGeometry() {
  const w = DOOR_L1.w, h = DOOR_L1.h;
  return boxAt(0, DOOR_L1.sill + h / 2, w / 2, 0.06, h, w);
}

/** Where the door's hinge sits in plane-local metres: just outside the skin. */
export const DOOR_HINGE = {
  x: -(skinHalfWidth(DOOR_L1.z) + 0.03),
  y: 0,
  z: DOOR_L1.z - DOOR_L1.w / 2,
};
