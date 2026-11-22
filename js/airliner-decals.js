// ---- airliner-decals.js: the livery decals and the light glow, drawn on canvas ----
// The registration "OK-ATC" on both sides of the rear fuselage and under the left
// wing, and the white wave on the navy fin, are printed onto one atlas canvas and
// laid on as flat planes just off the skin. One texture and one mesh for all of
// them. The light glow is a radial gradient, used as the sprite for the lights.
//
// Canvas is only in the browser. In the node tests there is no document, so the
// textures come back null and the geometry is still built: the tests check
// shapes and counts, not pixels.

import * as THREE from 'three';
import { AIRLINER as A, skinSection } from './airliner-layout.js';
import { PAINT } from './airliner-geom.js';

// Where each drawing sits on the atlas, as uv rectangles [u0, u1, v0, v1]. The
// registration takes the top strip, the wave the lower-left square.
const UV_REG = [0, 1, 0.75, 1];
const UV_WAVE = [0, 0.5, 0, 0.5];

export function makeAtlas() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 512;
  const g = c.getContext('2d');
  // registration, navy on transparent, in the top 128 rows of the canvas
  g.fillStyle = '#1b2f55';
  g.font = 'bold 96px Arial, Helvetica, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('OK-ATC', 256, 64);
  // the wave: three white strokes in the lower-left square (canvas y 256..512)
  g.strokeStyle = '#ffffff';
  g.lineWidth = 26;
  g.lineCap = 'round';
  for (let k = 0; k < 3; k++) {
    g.beginPath();
    for (let x = 30; x <= 226; x += 4) {
      const y = 360 + k * 62 + 24 * Math.sin(((x - 30) / 196) * Math.PI * 2.5 + k * 0.6);
      if (x === 30) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** The skin's surface x at height y on the side of the fuselage at z (the ellipse
 *  of the cross-section), so a decal laid there touches the skin, not a chord. */
function skinX(z, y) {
  const s = skinSection(z);
  const k = Math.max(0, 1 - ((y - s.yc) / s.b) ** 2);
  return s.a * Math.sqrt(k);
}

// One decal: a w x h plane centred at `o`, with its right vector X and up vector Y
// (its normal is X x Y, the side it is seen from), lifted `lift` off the skin.
function plane(o, X, Y, w, h, uv, lift = 0.012) {
  const n = [X[1] * Y[2] - X[2] * Y[1], X[2] * Y[0] - X[0] * Y[2], X[0] * Y[1] - X[1] * Y[0]];
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...X), new THREE.Vector3(...Y), new THREE.Vector3(...n));
  m.setPosition(o[0] + n[0] * lift, o[1] + n[1] * lift, o[2] + n[2] * lift);
  const g = new THREE.PlaneGeometry(w, h).applyMatrix4(m);
  const uvs = g.attributes.uv;
  for (let i = 0; i < uvs.count; i++) {
    uvs.setXY(i, uv[0] + uvs.getX(i) * (uv[1] - uv[0]), uv[2] + uvs.getY(i) * (uv[3] - uv[2]));
  }
  return g;
}

/** Every livery decal, merged into one geometry with uvs into the atlas. */
export function decalGeometry() {
  const parts = [];
  const TOP = (x) => A.wingRootY + x * Math.tan(A.wingDihedralDeg * Math.PI / 180);
  // registration on the rear fuselage, both sides, reading from outside
  const yReg = 3.82, zReg = 9.2;
  parts.push(plane([skinX(zReg, yReg), yReg, zReg], [0, 0, -1], [0, 1, 0], 3.6, 0.5, UV_REG));
  parts.push(plane([-skinX(zReg, yReg), yReg, zReg], [0, 0, 1], [0, 1, 0], 3.6, 0.5, UV_REG));
  // registration under the left wing, reading along the span
  parts.push(plane([-8.0, TOP(8.0) - 0.3, 3.1], [1, 0, 0], [0, 0, 1], 2.4, 0.4, UV_REG));
  // the wave on the fin, both sides
  const zF = 13.95, yF = 8.2;
  parts.push(plane([0.16, yF, zF], [0, 0, -1], [0, 1, 0], 2.0, 2.0, UV_WAVE));
  parts.push(plane([-0.16, yF, zF], [0, 0, 1], [0, 1, 0], 2.0, 2.0, UV_WAVE));

  // merge: non-indexed triangles with position, normal and uv
  const pos = [], nrm = [], uv = [];
  for (const g of parts) {
    const ng = g.index ? g.toNonIndexed() : g;
    const p = ng.attributes.position, n = ng.attributes.normal, t = ng.attributes.uv;
    for (let i = 0; i < p.count; i++) {
      pos.push(p.getX(i), p.getY(i), p.getZ(i));
      nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      uv.push(t.getX(i), t.getY(i));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return out;
}

/** The material for the decals: the atlas, cut out where it is transparent, and
 *  pushed a hair toward the camera so it never fights the skin. */
export function decalMaterial(atlas) {
  return new THREE.MeshLambertMaterial({
    map: atlas,
    color: atlas ? 0xffffff : PAINT.navy,
    transparent: true,
    alphaTest: 0.5,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

/** A soft white disc, the sprite each light is drawn with. Null outside the browser. */
export function makeGlowTexture() {
  if (typeof document === 'undefined') return null;
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.25, 'rgba(255,255,255,0.7)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
