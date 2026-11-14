// ---- trammesh.js: the bodies of the Prague trams, made in code -------------------
// One BufferGeometry per SECTION TYPE (the 15T's cab section A, middle B and
// tail C, and the Tatra T3 car), drawn once and shared by every tram through
// an InstancedMesh per type (js/trams.js): sixty trams round the Old Town are
// four instanced draws per material, not two hundred meshes.
//
// A section is a LOFT: one cross-section profile (skirt, window band, cornice,
// roof) swept along the car, pinched and raked over the last metre and a half
// into a nose. The bands of the profile are the livery: DPP red below the
// windows, the glass band, white (15T) or cream (T3) over it, a light grey
// roof. The glass is its own material (dark and glossy by day, lit warm from
// inside at night) and the lamps theirs (unlit, turned up after dark); every
// other colour rides in the vertex colours of one PBR paint.
//
// Frames as js/trambody.js says: origin midway between the section's two
// bogies, nose towards -z, door side +x, y up from the rail panel.

import * as THREE from 'three';
import { TRAM_BODY, WIRE_H, sectionSpan } from './trambody.js';

export const MAT_PAINT = 0, MAT_GLASS = 1, MAT_LAMP = 2;

const C = {
  red: 0xc4161c, white: 0xebe8e1, cream: 0xeadcb2, roof: 0xbfc3c6, dark: 0x26282b,
  metal: 0x55595e, bogie: 0x1c1d1f, door: 0x3a3f44, head: 0xfff4dc, tail: 0xff2010, bellows: 0x1e1f21,
};
const _col = new THREE.Color();

// ---- a bucketed triangle soup: flat normals, vertex colours, one bucket per material
class Soup {
  constructor() { this.b = [[], [], []].map(() => ({ p: [], c: [] })); }
  tri(m, a, b, c, hex) {
    _col.setHex(hex);
    const B = this.b[m];
    B.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (let i = 0; i < 3; i++) B.c.push(_col.r, _col.g, _col.b);
  }
  // a quad a-b-c-d counter-clockwise seen from outside
  quad(m, a, b, c, d, hex) { this.tri(m, a, b, c, hex); this.tri(m, a, c, d, hex); }
  // an axis-aligned box, every face out
  box(m, x0, x1, y0, y1, z0, z1, hex) {
    const v = (x, y, z) => [x, y, z];
    this.quad(m, v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1), v(x1, y0, z1), hex);   // +x
    this.quad(m, v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0), v(x0, y0, z0), hex);   // -x
    this.quad(m, v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0), hex);   // +y
    this.quad(m, v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1), hex);   // +z
    this.quad(m, v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0), hex);   // -z
  }
  // a square bar of half-thickness r from point a to point b
  bar(m, a, b, r, hex) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const L = Math.hypot(d[0], d[1], d[2]) || 1;
    d[0] /= L; d[1] /= L; d[2] /= L;
    let u = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    let s = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
    const sl = Math.hypot(s[0], s[1], s[2]); s = s.map((q) => q / sl * r);
    u = [d[1] * s[2] - d[2] * s[1], d[2] * s[0] - d[0] * s[2], d[0] * s[1] - d[1] * s[0]].map((q) => q / r * r);
    const P = (p, i, j) => [p[0] + s[0] * i + u[0] * j, p[1] + s[1] * i + u[1] * j, p[2] + s[2] * i + u[2] * j];
    const corners = [[1, 1], [-1, 1], [-1, -1], [1, -1]];
    for (let k = 0; k < 4; k++) {
      const [i0, j0] = corners[k], [i1, j1] = corners[(k + 1) % 4];
      this.quad(m, P(a, i0, j0), P(a, i1, j1), P(b, i1, j1), P(b, i0, j0), hex);
      this.quad(m, P(a, i0, j0), P(b, i0, j0), P(b, i1, j1), P(a, i1, j1), hex);   // both faces: a bar is seen from any side
    }
  }
  geometry() {
    const pos = [], col = [], g = new THREE.BufferGeometry();
    let start = 0;
    for (let m = 0; m < 3; m++) {
      const B = this.b[m];
      for (const q of B.p) pos.push(q);
      for (const q of B.c) col.push(q);
      const n = B.p.length / 3;
      g.addGroup(start, n, m);
      start += n;
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();          // non-indexed: one flat normal per face
    g.computeBoundingSphere();
    return g;
  }
}

// ---- the cross-sections --------------------------------------------------------------
// [x, y, band]: the right half bottom to top; the band colours the strip from
// this vertex to the next. The left half is the mirror.
function profileOf(body) {
  if (body === '15T') {
    return [[1.2, 0.24, 'red'], [1.23, 1.02, 'glass'], [1.19, 2.46, 'white'],
      [1.12, 2.86, 'roof'], [0.8, 3.12, 'roof'], [0, 3.2, null]];
  }
  return [[1.22, 0.5, 'red'], [1.25, 1.42, 'cream'], [1.25, 1.6, 'glass'],
    [1.21, 2.56, 'cream'], [1.1, 2.82, 'roof'], [0.72, 3.0, 'roof'], [0, 3.06, null]];
}
const bandMat = (b) => (b === 'glass' ? MAT_GLASS : MAT_PAINT);
const bandHex = (b, body) => (b === 'glass' ? 0x9aa4ab : b === 'white' ? (body === 'T3' ? C.cream : C.white) : C[b] ?? C.dark);

// The rings of a nose, from the tip back: u metres in, x pinched by k, and the
// part over the sill raked back by r per metre of height (the 15T's wrap-round
// windscreen leans back; the T3's rounded front hardly does).
const NOSE = {
  '15T': [{ u: 0, k: 0.84, r: 0.32, t: 0.16 }, { u: 0.3, k: 0.92, r: 0.16, t: 0.08 }, { u: 0.8, k: 0.98, r: 0.03, t: 0.02 }, { u: 1.5, k: 1, r: 0 }],
  T3: [{ u: 0, k: 0.52, r: 0.08 }, { u: 0.16, k: 0.72, r: 0.05 }, { u: 0.45, k: 0.88, r: 0.02 }, { u: 0.9, k: 0.97, r: 0 }, { u: 1.5, k: 1, r: 0 }],
};
const TAIL15 = [{ u: 0, k: 0.84, r: 0.12 }, { u: 0.3, k: 0.93, r: 0.05 }, { u: 0.8, k: 0.98, r: 0 }, { u: 1.4, k: 1, r: 0 }];

// one ring: the profile at z, pinched by k (and by t more towards the top:
// the 15T's angular nose narrows over the sill) and raked by r towards +dir
function ring(prof, z, k, r, dir, sill, t = 0) {
  const out = [];
  const kx = (y) => k * (1 - t * Math.max(0, y - sill) / 2.2);
  const zr = (y) => z + dir * r * Math.max(0, Math.min(y, 2.9) - sill);
  for (const [x, y] of prof) out.push([x * kx(y), y, zr(y)]);
  for (let i = prof.length - 2; i >= 0; i--) out.push([-prof[i][0] * kx(prof[i][1]), prof[i][1], zr(prof[i][1])]);
  return out;
}

// sweep between two rings (ra ahead at smaller z, rb behind), outward faces
function sweep(S, prof, ra, rb, body) {
  const n = prof.length, m = ra.length;
  for (let i = 0; i < m - 1; i++) {
    // the band of this strip: right half i, left half mirrored
    const band = i < n - 1 ? prof[i][2] : prof[m - 2 - i][2];
    S.quad(bandMat(band), ra[i], ra[i + 1], rb[i + 1], rb[i], bandHex(band, body));
  }
  S.quad(MAT_PAINT, ra[m - 1], ra[0], rb[0], rb[m - 1], C.dark);       // the underside
}

// the flat face closing a ring, in horizontal bands (the windscreen is a band
// right across the front); `out` is +1 when the face looks along +z
function cap(S, prof, R, out, body) {
  const n = prof.length, m = R.length;
  for (let i = 0; i < n - 1; i++) {
    const band = prof[i][2];
    const a = R[i], b = R[i + 1], c = R[m - 2 - i], d = R[m - 1 - i];
    if (out > 0) S.quad(bandMat(band), a, b, c, d, bandHex(band, body));
    else S.quad(bandMat(band), d, c, b, a, bandHex(band, body));
  }
}

function endRings(prof, shape, zEdge, dir, sill) {
  // dir -1: a nose at the front (z grows into the body); +1: a tail at the back
  return shape.map((s) => ring(prof, zEdge - dir * s.u, s.k, s.r, -dir, sill, s.t ?? 0));
}

/**
 * The geometry of one section type: 'A', 'B', 'C' (15T) or 'T' (T3).
 */
export function sectionGeometry(type) {
  const body = type === 'T' ? 'T3' : '15T';
  const B = TRAM_BODY[body];
  const sec = B.sections.find((s) => s.type === type);
  const { mid, front, back } = sectionSpan(body, sec);
  const prof = profileOf(body), sill = prof[1][1];
  const S = new Soup();
  const atFront = sec.z0 === 0, atBack = sec.z1 === B.len;
  // the body ends 0.22 m short of a joint, where the bellows takes over
  const zf = atFront ? front : front + 0.22, zb = atBack ? back : back - 0.22;
  const rings = [];
  if (atFront) for (const r of endRings(prof, NOSE[body], zf, -1, sill)) rings.push(r);
  else rings.push(ring(prof, zf, 1, 0, 1, sill));
  const tail = atBack ? endRings(prof, body === 'T3' ? NOSE.T3 : TAIL15, zb, 1, sill).reverse() : [ring(prof, zb, 1, 0, 1, sill)];
  for (const r of tail) rings.push(r);
  for (let i = 0; i < rings.length - 1; i++) sweep(S, prof, rings[i], rings[i + 1], body);
  cap(S, prof, rings[0], -1, body);
  cap(S, prof, rings[rings.length - 1], 1, body);
  // ---- bellows at a joint: a dark concertina reaching to the joint plane
  const bell = (z0, z1) => {
    const k = 0.94, bp = prof.map(([x, y]) => [x, y]);
    const r0 = ring(bp, z0, k, 0, 1, sill), r1 = ring(bp, z1, k, 0, 1, sill);
    const m = r0.length;
    for (let i = 0; i < m - 1; i++) S.quad(MAT_PAINT, r0[i], r0[i + 1], r1[i + 1], r1[i], C.bellows);
    cap(S, prof.map(([x, y]) => [x, y, 'dark']), z1 > z0 ? r1 : r0, z1 > z0 ? 1 : -1, body);
  };
  if (!atFront) bell(zf, front);
  if (!atBack) bell(zb, back);
  // ---- doors on the right: a glazed leaf pair standing a hand proud of the side
  const halfAt = (y) => (y < sill ? prof[0][0] + (prof[1][0] - prof[0][0]) * (y - prof[0][1]) / (sill - prof[0][1]) : prof[1][0]);
  const dW = body === '15T' ? 1.3 : 1.25, dY0 = body === '15T' ? 0.3 : 0.55, dY1 = body === '15T' ? 2.3 : 2.4;
  for (const dz of B.doors) {
    if (dz < sec.z0 + 0.8 || dz > sec.z1 - 0.8) continue;
    const z = dz - mid, x = Math.max(halfAt(dY0), halfAt(dY1)) + 0.012;
    S.quad(MAT_PAINT, [x, dY0 - 0.04, z + dW / 2 + 0.05], [x, dY0 - 0.04, z - dW / 2 - 0.05], [x, dY1 + 0.05, z - dW / 2 - 0.05], [x, dY1 + 0.05, z + dW / 2 + 0.05], C.door);
    for (const s of [-1, 1]) {
      const za = z + s * 0.02, zc = z + s * (dW / 2 - 0.04);
      const p = [x + 0.004, dY0 + 0.05], q = [x + 0.004, dY1 - 0.05];
      const [z0, z1] = s > 0 ? [zc, za] : [za, zc];
      S.quad(MAT_GLASS, [p[0], p[1], z0], [p[0], p[1], z1], [q[0], q[1], z1], [q[0], q[1], z0], 0x8a949b);
    }
  }
  // ---- window pillars over the glass band, both sides: the T3's cream
  // frames between its big windows, the 15T's slim black ones
  const gi = prof.findIndex((q) => q[2] === 'glass');
  const g0 = prof[gi], g1 = prof[gi + 1];
  const pw = body === '15T' ? 0.07 : 0.11, step = body === '15T' ? 1.55 : 1.3;
  const pHex = body === '15T' ? 0x121416 : C.cream;
  const zA = zf + (atFront ? 1.5 : 0.3), zB = zb - (atBack ? 1.4 : 0.3);
  const nP = Math.max(1, Math.round((zB - zA) / step));
  for (let k = 0; k <= nP; k++) {
    const z = zA + (zB - zA) * k / nP;
    for (const side of [1, -1]) {
      // no pillar across a door
      if (side > 0 && B.doors.some((dz) => Math.abs(dz - mid - z) < dW / 2 + 0.1)) continue;
      const xa = side * (g0[0] + 0.006), xb = side * (g1[0] + 0.006);
      const a = [xa, g0[1], z - pw], b = [xa, g0[1], z + pw], c = [xb, g1[1], z + pw], d = [xb, g1[1], z - pw];
      if (side > 0) S.quad(MAT_PAINT, b, a, d, c, pHex); else S.quad(MAT_PAINT, a, b, c, d, pHex);
    }
  }
  // ---- roof equipment: converter and cooling boxes, light grey
  const roofY = prof[prof.length - 1][1];
  if (type === 'A' || type === 'C') S.box(MAT_PAINT, -0.75, 0.75, roofY - 0.08, roofY + 0.28, -2.6, 2.6, C.roof);
  if (type === 'T') S.box(MAT_PAINT, -0.6, 0.6, roofY - 0.06, roofY + 0.2, 2.2, 4.6, C.metal);
  // ---- the pantograph, raised to the wire: a single arm (js/trambody.js WIRE_H)
  if (B.pantograph.section === B.sections.indexOf(sec)) {
    const z = B.pantograph.at - mid, y0 = roofY + 0.06;
    S.box(MAT_PAINT, -0.7, 0.7, y0, y0 + 0.16, z - 1.1, z + 1.1, C.metal);       // base frame on insulators
    const hinge = [0, y0 + 0.28, z + 0.85], knee = [0, (y0 + WIRE_H) / 2 + 0.15, z - 0.7], head = [0, WIRE_H - 0.12, z + 0.2];
    S.bar(MAT_PAINT, [-0.25, hinge[1], hinge[2]], knee, 0.035, C.dark);
    S.bar(MAT_PAINT, [0.25, hinge[1], hinge[2]], knee, 0.035, C.dark);
    S.bar(MAT_PAINT, knee, head, 0.028, C.dark);
    S.bar(MAT_PAINT, [-0.42, head[1], head[2]], [0.42, head[1], head[2]], 0.03, C.dark);
    // the collector strip: 1.6 m across, touching the wire
    S.box(MAT_PAINT, -0.8, 0.8, WIRE_H - 0.07, WIRE_H - 0.01, head[2] - 0.06, head[2] + 0.06, C.metal);
    for (const s of [-1, 1]) S.bar(MAT_PAINT, [s * 0.8, WIRE_H - 0.04, head[2]], [s * 1.0, WIRE_H - 0.22, head[2]], 0.02, C.metal);
  }
  // ---- running gear under the skirt
  const b0 = B.bogies[sec.b0] - mid, b1 = B.bogies[sec.b1] - mid;
  const gearTop = body === '15T' ? 0.36 : 0.66;
  for (const bz of [b0, b1]) S.box(MAT_PAINT, -0.95, 0.95, 0.02, gearTop, bz - 1.0, bz + 1.0, C.bogie);
  // ---- lamps: head lamps low on a nose, tail lamps on a tail
  const lampY = body === '15T' ? 0.72 : 0.95;
  const lamp = (z, out, hex, x0) => {
    for (const s of [-1, 1]) {
      const xa = s * x0, xb = s * (x0 + 0.24);
      const [xl, xr] = out < 0 ? [Math.max(xa, xb), Math.min(xa, xb)] : [Math.min(xa, xb), Math.max(xa, xb)];
      S.quad(MAT_LAMP, [xl, lampY - 0.07, z], [xr, lampY - 0.07, z], [xr, lampY + 0.07, z], [xl, lampY + 0.07, z], hex);
    }
  };
  const wF = prof[0][0] * (atFront ? NOSE[body][0].k : 1);
  if (atFront) lamp(front - 0.012, -1, C.head, wF - 0.45);
  if (atBack) lamp(back + 0.012, 1, C.tail, wF - 0.45);
  return S.geometry();
}

/**
 * Where the displays of a body hang, in the frame of the section that carries
 * them: { sec, x, y, z, ry, rx, w, h } for 'front', 'side' and 'rear'.
 */
export function signFrames(body) {
  const B = TRAM_BODY[body], sg = B.sign, prof = profileOf(body), sill = prof[1][1];
  const first = B.sections[0], last = B.sections[B.sections.length - 1];
  const sf = sectionSpan(body, first), sl = sectionSpan(body, last);
  const rake = (body === '15T' ? NOSE['15T'][0].r : NOSE.T3[0].r);
  const tailR = body === '15T' ? TAIL15[0].r : NOSE.T3[0].r;
  const kN = body === '15T' ? NOSE['15T'][0].k : NOSE.T3[0].k;
  return {
    front: { sec: 0, x: 0, y: sg.front.y, z: sf.front + rake * (Math.min(sg.front.y, 2.9) - sill) - 0.025, ry: Math.PI, rx: -Math.atan(rake), w: Math.min(sg.front.w, 2 * prof[2][0] * kN - 0.2), h: sg.front.h },
    side: { sec: 0, x: prof[2][0] + 0.02, y: sg.side.y, z: sg.side.at - sf.mid, ry: Math.PI / 2, rx: 0, w: sg.side.w, h: sg.side.h },
    rear: { sec: B.sections.length - 1, x: 0.45, y: sg.rear.y, z: sl.back - tailR * (Math.min(sg.rear.y, 2.9) - sill) + 0.025, ry: 0, rx: -Math.atan(tailR), w: sg.rear.w, h: sg.rear.h },
    _last: last,
  };
}

export const SECTION_TYPES = ['A', 'B', 'C', 'T'];
