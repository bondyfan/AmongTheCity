// ---- treemodels.js: the trees you stand under ---------------------------------
// The detailed model of each species, built once in code and instanced by
// js/trees.js round the camera. Main thread only.
//
// Every model is authored in CROWN SPACE (see js/treeshapes.js): the crown fills
// the unit sphere at the origin and the ground lies at y = -groundOf(species),
// so the very matrix that places a far crown blob places this model, trunk and
// all, and the two tiers swap without either moving.
//
// A crown is a handful of LOBES, each a geodesic sphere pushed out of round by
// a few waves and overlapping its neighbours. Three things are baked per vertex
// so the shader has nothing to work out:
//   normal   blended toward the crown's centre, so the lobes light as ONE
//            volume with a lit side and a shaded side, not as a bunch of balls
//   aGeoN    the lobe's own normal: where it turns from the eye is where the
//            shader thins the leaves into a ragged edge
//   color    foliage: how open to the sky the vertex is (dark in the creases
//            where lobes meet, dark underneath, dark toward the middle);
//            wood: the bark's own colour
//   uv       x: how much of the wind's sway the vertex takes (0 at the root),
//            y: 1 on foliage, 0 on wood

import * as THREE from 'three';
import { SP, SPECIES, groundOf, geoSphere, smoothNormals } from './treeshapes.js';

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const _col = new THREE.Color();
const lin = (hex) => { _col.setHex(hex); return [_col.r, _col.g, _col.b]; };

class Soup {
  constructor(yg) {
    this.yg = yg;                       // the ground, in crown space
    this.pos = []; this.nor = []; this.geo = []; this.col = []; this.uv = []; this.idx = [];
    this.lobes = [];
  }
  /** Sway weight of a point at height y: nothing at the root, all of it in the crown. */
  sway(y) { return Math.pow(Math.min(1, Math.max(0, (y - this.yg) / (-0.35 - this.yg))), 1.6); }

  /** One mass of foliage: centre, radii, sphere frequency. Shaded in finish(). */
  lobe(cx, cy, cz, rx, ry, rz, freq, rand, rough = 0.13) {
    const s = geoSphere(freq), n = s.pos.length / 3, base = this.pos.length / 3;
    const k = [];
    for (let i = 0; i < 3; i++) k.push((rand() - 0.5) * 9, (rand() - 0.5) * 9, (rand() - 0.5) * 9, rand() * 6.283);
    for (let i = 0; i < n; i++) {
      const x = s.pos[i * 3], y = s.pos[i * 3 + 1], z = s.pos[i * 3 + 2];
      let d = 0;
      for (let j = 0; j < 12; j += 4) d += Math.sin(x * k[j] + y * k[j + 1] + z * k[j + 2] + k[j + 3]);
      const r = 1 + rough * d / 1.7;
      this.pos.push(cx + x * rx * r, cy + y * ry * r, cz + z * rz * r);
    }
    for (let i = 0; i < s.idx.length; i++) this.idx.push(base + s.idx[i]);
    this.lobes.push({ c: [cx, cy, cz], r: [rx, ry, rz], base, n, tris: s.idx });
  }

  /**
   * A limb: a tube through pts ([x, y, z, radius] each), `sides` round. col0 at
   * the first point, col1 at the last. Open ended: both ends are buried.
   */
  tube(pts, sides, col0, col1) {
    const base = this.pos.length / 3, m = pts.length;
    // ONE reference for the whole limb, picked from where it is going overall:
    // a reference chosen per ring would twist the tube where a limb bends
    const oy = pts[m - 1][1] - pts[0][1];
    const steep = Math.abs(oy) > 0.8 * Math.hypot(pts[m - 1][0] - pts[0][0], oy, pts[m - 1][2] - pts[0][2]);
    for (let i = 0; i < m; i++) {
      const p = pts[i], a = pts[Math.max(0, i - 1)], b = pts[Math.min(m - 1, i + 1)];
      let tx = b[0] - a[0], ty = b[1] - a[1], tz = b[2] - a[2];
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // a frame round the limb: any reference not along it will do
      let ux, uy, uz;
      if (!steep) { ux = -tz; uy = 0; uz = tx; } else { ux = 0; uy = tz; uz = -ty; }
      const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const f = i / (m - 1), w = this.sway(p[1]);
      for (let s = 0; s < sides; s++) {
        const an = s / sides * Math.PI * 2, ca = Math.cos(an), sa = Math.sin(an);
        const nx = ux * ca + vx * sa, ny = uy * ca + vy * sa, nz = uz * ca + vz * sa;
        this.pos.push(p[0] + nx * p[3], p[1] + ny * p[3], p[2] + nz * p[3]);
        this.nor.push(nx, ny, nz); this.geo.push(nx, ny, nz);
        this.col.push(col0[0] + (col1[0] - col0[0]) * f, col0[1] + (col1[1] - col0[1]) * f, col0[2] + (col1[2] - col0[2]) * f);
        this.uv.push(w, 0);
      }
    }
    for (let i = 0; i < m - 1; i++) for (let s = 0; s < sides; s++) {
      const a = base + i * sides + s, b = base + i * sides + (s + 1) % sides, c = a + sides, d = b + sides;
      this.idx.push(a, b, c, b, d, c);
    }
  }

  /** Shade the lobes (they need to know about each other) and hand back a geometry. */
  finish(blend = 0.7) {
    const P = this.pos, wood = this.nor.length / 3;
    const nor = new Float32Array(P.length), geo = new Float32Array(P.length),
      col = new Float32Array(P.length), uv = new Float32Array(P.length / 3 * 2);
    // wood was appended to nor/geo/col/uv as it was built, in order, and every
    // tube is added AFTER the lobes (see the species builders), so it sits at
    // the tail of the position array
    const woodAt = P.length / 3 - wood;
    for (let i = 0; i < wood; i++) {
      const o = (woodAt + i) * 3;
      nor[o] = this.nor[i * 3]; nor[o + 1] = this.nor[i * 3 + 1]; nor[o + 2] = this.nor[i * 3 + 2];
      geo[o] = this.geo[i * 3]; geo[o + 1] = this.geo[i * 3 + 1]; geo[o + 2] = this.geo[i * 3 + 2];
      col[o] = this.col[i * 3]; col[o + 1] = this.col[i * 3 + 1]; col[o + 2] = this.col[i * 3 + 2];
      uv[(woodAt + i) * 2] = this.uv[i * 2]; uv[(woodAt + i) * 2 + 1] = 0;
    }
    for (const L of this.lobes) {
      const sub = new Float32Array(L.n * 3);
      for (let i = 0; i < L.n * 3; i++) sub[i] = P[L.base * 3 + i];
      const tn = smoothNormals(sub, L.tris);
      for (let i = 0; i < L.n; i++) {
        const o = (L.base + i) * 3, x = P[o], y = P[o + 1], z = P[o + 2];
        // how far outside every OTHER lobe this vertex is: the crease where
        // two masses of leaves meet sees no sky
        let open = 1;
        for (const M of this.lobes) {
          if (M === L) continue;
          const d = Math.hypot((x - M.c[0]) / M.r[0], (y - M.c[1]) / M.r[1], (z - M.c[2]) / M.r[2]) - 1;
          if (d < open) open = d;
        }
        const crease = smooth(-0.10, 0.32, open);
        const rad = Math.hypot(x, y, z), up = smooth(-1.0, 0.45, y);
        const ao = (0.54 + 0.46 * crease) * (0.72 + 0.28 * smooth(0.25, 0.95, rad)) * (0.66 + 0.34 * up);
        col[o] = ao * (0.93 + 0.07 * up); col[o + 1] = ao; col[o + 2] = ao * (0.98 - 0.10 * up);
        geo[o] = tn[i * 3]; geo[o + 1] = tn[i * 3 + 1]; geo[o + 2] = tn[i * 3 + 2];
        const rl = rad || 1;
        let nx = tn[i * 3] * (1 - blend) + x / rl * blend, ny = tn[i * 3 + 1] * (1 - blend) + y / rl * blend,
          nz = tn[i * 3 + 2] * (1 - blend) + z / rl * blend;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nor[o] = nx / nl; nor[o + 1] = ny / nl; nor[o + 2] = nz / nl;
        uv[(L.base + i) * 2] = 1; uv[(L.base + i) * 2 + 1] = 1;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aGeoN', new THREE.BufferAttribute(geo, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    return g;
  }
}

// ---- the trunk every broadleaf shares -----------------------------------------
// Root flare, a slight bend, a fork low in the crown and limbs out to the
// masses of leaves they carry. `tips` are the points the limbs reach for.
function woodInto(S, sp, rand, forkY, tips, leaderTo) {
  const yg = S.yg, tau = SPECIES[sp].tau;
  const bark = lin(SPECIES[sp].bark), dark = bark.map((c) => c * 0.8);
  const bx = (rand() - 0.5) * 0.14, bz = (rand() - 0.5) * 0.14, len = forkY - yg;
  S.tube([
    [0, yg - 0.06, 0, tau * 1.7], [0, yg + len * 0.07, 0, tau * 1.08],
    [bx * 0.6, yg + len * 0.45, bz * 0.6, tau * 0.94], [bx, forkY, bz, tau * 0.82],
  ], 8, bark, bark);
  S.tube([[bx, forkY - 0.02, bz, tau * 0.66], [bx * 0.6 + leaderTo[0] * 0.4, (forkY + leaderTo[1]) / 2, bz * 0.6 + leaderTo[2] * 0.4, tau * 0.46],
    [leaderTo[0], leaderTo[1], leaderTo[2], tau * 0.16]], 6, bark, dark);
  for (const t of tips) {
    const mx = bx + (t[0] - bx) * 0.5, mz = bz + (t[2] - bz) * 0.5, my = forkY + (t[1] - forkY) * 0.36;
    S.tube([[bx, forkY - 0.03, bz, tau * 0.56], [mx, my, mz, tau * 0.38], [t[0], t[1], t[2], tau * 0.13]], 5, bark, dark);
  }
}

// A broadleaf crown by numbers. A: the wide lower ring of lobes, B: the upper
// ring, then a top and a skirt of small low ones. Every species below is this
// one function with a different table, which is how they stay one family while
// a chestnut still reads as a dome and a plane as an open, lighter tree.
const BROAD = {
  [SP.LINDEN]:   { core: [0.60, 0.70], A: [5, 0.50, -0.27, 0.46, 0.92], B: [4, 0.35, 0.40, 0.40, 1.0], top: [0.72, 0.30], low: [3, 0.54, -0.66, 0.30], fork: -0.74 },
  [SP.MAPLE]:    { core: [0.62, 0.64], A: [5, 0.52, -0.16, 0.45, 0.95], B: [4, 0.38, 0.40, 0.42, 0.95], top: [0.66, 0.34], low: [2, 0.50, -0.62, 0.30], fork: -0.72 },
  [SP.CHESTNUT]: { core: [0.66, 0.70], A: [4, 0.46, -0.24, 0.54, 0.95], B: [3, 0.34, 0.36, 0.48, 1.0], top: [0.64, 0.38], low: [3, 0.52, -0.64, 0.34], fork: -0.76 },
  [SP.PLANE]:    { core: [0.50, 0.62], A: [4, 0.54, -0.20, 0.40, 0.90], B: [3, 0.42, 0.34, 0.38, 0.95], top: [0.70, 0.30], low: [2, 0.50, -0.60, 0.26], fork: -0.80 },
  [SP.OAK]:      { core: [0.60, 0.62], A: [6, 0.56, -0.18, 0.42, 0.80], B: [4, 0.40, 0.34, 0.42, 0.85], top: [0.62, 0.36], low: [3, 0.60, -0.56, 0.30], fork: -0.78 },
  [SP.FRUIT]:    { core: [0.60, 0.62], A: [4, 0.46, -0.12, 0.46, 0.95], B: [0, 0, 0, 0, 1], top: [0.56, 0.40], low: [2, 0.46, -0.56, 0.32], fork: -0.82 },
  // an ash carries its leaf high and upswept, with little under it; a robinia
  // is a few separate masses on dark limbs with the sky between them (the
  // small core is the point); a cherry is a vase: nothing hangs below the fork
  [SP.ASH]:      { core: [0.52, 0.66], A: [4, 0.50, -0.10, 0.42, 1.05], B: [3, 0.36, 0.44, 0.38, 1.10], top: [0.74, 0.28], low: [2, 0.44, -0.58, 0.26], fork: -0.70 },
  [SP.ROBINIA]:  { core: [0.38, 0.50], A: [3, 0.56, -0.08, 0.40, 0.85], B: [3, 0.44, 0.42, 0.36, 0.90], top: [0.70, 0.26], low: [1, 0.52, -0.50, 0.24], fork: -0.62 },
  [SP.CHERRY]:   { core: [0.56, 0.58], A: [5, 0.48, -0.04, 0.42, 0.90], B: [3, 0.34, 0.42, 0.38, 0.90], top: [0.62, 0.34], low: [0, 0, 0, 0], fork: -0.86 },
};
const SMALL = new Set([SP.FRUIT, SP.CHERRY]);    // a 6 m tree: coarser lobes are enough
function broadleaf(sp, variant) {
  const T = BROAD[sp], rand = rng(977 * (sp + 1) + 131 * variant), S = new Soup(-groundOf(sp));
  const big = SMALL.has(sp) ? 2 : 3;
  S.lobe((rand() - 0.5) * 0.08, 0.04, (rand() - 0.5) * 0.08, T.core[0], T.core[1], T.core[0], 2, rand);
  const tips = [], a0 = rand() * 6.283;
  for (let i = 0; i < T.A[0]; i++) {
    const a = a0 + (i + (rand() - 0.5) * 0.5) / T.A[0] * 6.283, d = T.A[1] * (0.88 + 0.24 * rand());
    const y = T.A[2] + (rand() - 0.5) * 0.2, r = T.A[3] * (0.9 + 0.2 * rand());
    S.lobe(Math.cos(a) * d, y, Math.sin(a) * d, r, r * T.A[4], r, big, rand);
    if (tips.length < 4) tips.push([Math.cos(a) * d * 0.72, y - 0.05, Math.sin(a) * d * 0.72]);
  }
  const b0 = rand() * 6.283;
  for (let i = 0; i < T.B[0]; i++) {
    const a = b0 + (i + (rand() - 0.5) * 0.5) / T.B[0] * 6.283, d = T.B[1] * (0.85 + 0.3 * rand());
    const y = T.B[2] + (rand() - 0.5) * 0.16, r = T.B[3] * (0.9 + 0.2 * rand());
    S.lobe(Math.cos(a) * d, y, Math.sin(a) * d, r, r * T.B[4], r, 2, rand);
  }
  const tx = (rand() - 0.5) * 0.16, tz = (rand() - 0.5) * 0.16;
  S.lobe(tx, T.top[0], tz, T.top[1], T.top[1], T.top[1], 2, rand);
  const l0 = rand() * 6.283;
  for (let i = 0; i < T.low[0]; i++) {
    const a = l0 + (i + (rand() - 0.5) * 0.6) / T.low[0] * 6.283, r = T.low[3] * (0.9 + 0.2 * rand());
    S.lobe(Math.cos(a) * T.low[1], T.low[2] + (rand() - 0.5) * 0.1, Math.sin(a) * T.low[1], r, r * 0.78, r, 2, rand);
  }
  woodInto(S, sp, rand, T.fork, tips, [tx * 0.5, 0.25, tz * 0.5]);
  return S.finish();
}

// A Lombardy poplar: a column of lobes round a stem that runs to the top. The
// crown is five times taller than wide, so a lobe flat in crown space is a
// tall one in the world.
function poplar(variant) {
  const sp = SP.POPLAR, rand = rng(4421 + 77 * variant), S = new Soup(-groundOf(sp));
  for (let i = 0; i < 8; i++) {
    const t = i / 7, y = -0.84 + t * 1.62;
    const r = 0.80 * (1 - 0.52 * Math.pow(t, 1.6)) * (0.9 + 0.2 * rand()) * (i === 0 ? 0.8 : 1);
    S.lobe((rand() - 0.5) * 0.26, y, (rand() - 0.5) * 0.26, r, 0.19, r, 2, rand, 0.11);
  }
  const bark = lin(SPECIES[sp].bark), tau = SPECIES[sp].tau;
  S.tube([[0, S.yg - 0.02, 0, tau * 1.6], [0, S.yg + 0.05, 0, tau], [0.02, -0.5, 0.01, tau * 0.8], [0, 0.5, 0, tau * 0.25]], 7, bark, bark);
  return S.finish(0.7);
}

// A birch: small masses of leaf hung round a white stem, with air between them.
function birch(variant) {
  const sp = SP.BIRCH, rand = rng(8803 + 59 * variant), S = new Soup(-groundOf(sp));
  const tips = [];
  for (let i = 0; i < 10; i++) {
    const t = i / 9, y = -0.74 + t * 1.5, a = i * 2.39996 + rand() * 0.6;
    const d = (0.46 - 0.30 * Math.max(0, y)) * (0.8 + 0.4 * rand()) * (i === 9 ? 0.2 : 1);
    const r = 0.36 - 0.07 * t + 0.05 * rand();
    S.lobe(Math.cos(a) * d, y, Math.sin(a) * d, r, r * 1.12, r, 2, rand, 0.16);
    if (i % 3 === 1) tips.push([Math.cos(a) * d * 0.8, y + 0.05, Math.sin(a) * d * 0.8]);
  }
  const white = lin(SPECIES[sp].bark), foot = lin(0x5a534b), twig = lin(0x4d4238), tau = SPECIES[sp].tau;
  const bx = (rand() - 0.5) * 0.1;
  S.tube([[0, S.yg - 0.03, 0, tau * 1.5], [0, S.yg + 0.12, 0, tau * 1.05]], 7, foot, foot);
  S.tube([[0, S.yg + 0.12, 0, tau * 1.05], [bx, -0.9, 0, tau * 0.8], [bx * 0.5, 0, 0.02, tau * 0.5], [0, 0.72, 0, tau * 0.14]], 7, white, white);
  for (const t of tips) S.tube([[bx * 0.7, t[1] - 0.3, 0, tau * 0.3], [t[0], t[1], t[2], tau * 0.1]], 4, twig, twig);
  return S.finish(0.62);
}

// A spruce is not lobes but TIERS: skirts of branches, each drooping a little
// over the one below, drawn as one turned profile whose rim waves in and out.
function spruce(variant) {
  const sp = SP.SPRUCE, rand = rng(1907 + 43 * variant), yg = -groundOf(sp);
  const TIERS = 8, SEG = 10, Y0 = -0.80, RISE = 1.80 / TIERS;
  const pos = [], nor = [], col = [], uv = [], idx = [];
  const ring = (y, r, shade, wave, ph, wob) => {
    for (let s = 0; s < SEG; s++) {
      const a = s / SEG * 6.283, k = 1 + wave * (Math.sin(5 * a + ph) * 0.7 + Math.sin(3 * a + ph * 1.7) * 0.4);
      const x = Math.cos(a) * r * k, z = Math.sin(a) * r * k;
      pos.push(x, y + wob * Math.sin(2 * a + ph), z);
      // a cone's normal: outward and a little up, the same all the way round a tier
      nor.push(Math.cos(a) * 0.88, 0.47, Math.sin(a) * 0.88);
      col.push(shade * 0.96, shade, shade * 0.94); uv.push(1, 1);
    }
  };
  ring(Y0 - 0.03, 0.06, 0.45, 0, 0, 0);
  for (let i = 0; i < TIERS; i++) {
    const t = i / TIERS, y = Y0 + i * RISE, R = 1.38 * Math.pow(1 - t, 0.9) + 0.05, ph = rand() * 6.283;
    // the rim hangs below where the skirt starts, and the skirt climbs to ABOVE
    // the next rim: each tier overlaps the one over it, as drooping boughs do
    ring(y - 0.07, R, 0.80 + 0.20 * t, 0.17, ph, 0.02);
    ring(y + RISE * 1.08, R * 0.34, 0.52 + 0.2 * t, 0.06, ph, 0);
  }
  ring(1.04, 0.012, 1.0, 0, 0, 0);
  const rows = pos.length / 3 / SEG;
  for (let j = 0; j < rows - 1; j++) for (let s = 0; s < SEG; s++) {
    const a = j * SEG + s, b = j * SEG + (s + 1) % SEG, c = a + SEG, d = b + SEG;
    idx.push(a, c, b, b, c, d);
  }
  const P = new Float32Array(pos), geoN = smoothNormals(P, idx);
  // the stem, appended by hand: this model has no Soup
  const S = new Soup(yg), bark = lin(SPECIES[sp].bark), tau = SPECIES[sp].tau;
  S.tube([[0, yg - 0.02, 0, tau * 1.7], [0, yg + 0.06, 0, tau], [0, 0.2, 0, tau * 0.35]], 7, bark, bark);
  const off = pos.length / 3;
  const g = new THREE.BufferGeometry();
  const cat = (a, b) => { const o = new Float32Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
  g.setAttribute('position', new THREE.BufferAttribute(cat(P, S.pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(cat(nor, S.nor), 3));
  g.setAttribute('aGeoN', new THREE.BufferAttribute(cat(geoN, S.geo), 3));
  g.setAttribute('color', new THREE.BufferAttribute(cat(col, S.col), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(cat(uv, S.uv), 2));
  const all = new Uint16Array(idx.length + S.idx.length);
  all.set(idx); for (let i = 0; i < S.idx.length; i++) all[idx.length + i] = S.idx[i] + off;
  g.setIndex(new THREE.BufferAttribute(all, 1));
  return g;
}

// A Scots pine: a long bare stem, grey at the foot and fox-orange under the
// crown, and a flat-topped crown of a few broad cushions.
function pine(variant) {
  const sp = SP.PINE, rand = rng(6113 + 31 * variant), S = new Soup(-groundOf(sp));
  S.lobe(0.02, 0.22, 0, 0.58, 0.36, 0.58, 3, rand, 0.15);
  const tips = [], a0 = rand() * 6.283;
  for (let i = 0; i < 4; i++) {
    const a = a0 + (i + (rand() - 0.5) * 0.6) / 4 * 6.283, d = 0.52 * (0.85 + 0.3 * rand());
    const y = -0.22 + rand() * 0.42, r = 0.44 * (0.9 + 0.2 * rand());
    S.lobe(Math.cos(a) * d, y, Math.sin(a) * d, r, r * 0.66, r, 3, rand, 0.15);
    tips.push([Math.cos(a) * d * 0.7, y - 0.12, Math.sin(a) * d * 0.7]);
  }
  S.lobe((rand() - 0.5) * 0.3, 0.60, (rand() - 0.5) * 0.3, 0.40, 0.28, 0.40, 2, rand, 0.15);
  const foot = lin(0x6e6157), fox = lin(SPECIES[sp].bark), tau = SPECIES[sp].tau, yg = S.yg;
  const bx = (rand() - 0.5) * 0.3, bz = (rand() - 0.5) * 0.3;
  S.tube([[0, yg - 0.05, 0, tau * 1.5], [0, yg + 0.2, 0, tau * 1.05], [bx * 0.4, yg * 0.55, bz * 0.4, tau * 0.9],
    [bx, -0.95, bz, tau * 0.72], [bx * 0.6, 0.1, bz * 0.6, tau * 0.3]], 8, foot, fox);
  for (const t of tips) S.tube([[bx, -0.9, bz, tau * 0.42], [t[0] * 0.6 + bx * 0.4, (t[1] - 0.9) / 2 - 0.1, t[2] * 0.6 + bz * 0.4, tau * 0.3], [t[0], t[1], t[2], tau * 0.12]], 5, fox, fox);
  // the dead stubs every pine keeps below its crown
  for (let i = 0; i < 2; i++) {
    const a = rand() * 6.283, y = -1.25 - i * 0.55 - rand() * 0.3, l = 0.22 + rand() * 0.14;
    S.tube([[bx * 0.6, y, bz * 0.6, tau * 0.2], [bx * 0.6 + Math.cos(a) * l, y + 0.07, bz * 0.6 + Math.sin(a) * l, tau * 0.07]], 4, foot, foot);
  }
  return S.finish(0.62);
}

// A white willow: a low dome whose boughs arch over at the shoulder and hang
// in curtains most of the way to the ground. The curtains are tall thin lobes
// set round the rim, which is the one silhouette no other tree here has.
function willow(variant) {
  const sp = SP.WILLOW, rand = rng(5231 + 67 * variant), S = new Soup(-groundOf(sp));
  S.lobe((rand() - 0.5) * 0.06, 0.34, (rand() - 0.5) * 0.06, 0.60, 0.50, 0.60, 3, rand, 0.12);
  const tips = [], a0 = rand() * 6.283;
  for (let i = 0; i < 5; i++) {
    const a = a0 + (i + (rand() - 0.5) * 0.5) / 5 * 6.283, d = 0.50 * (0.9 + 0.2 * rand());
    const y = 0.14 + (rand() - 0.5) * 0.14, r = 0.40 * (0.9 + 0.2 * rand());
    S.lobe(Math.cos(a) * d, y, Math.sin(a) * d, r, r * 0.82, r, 3, rand, 0.12);
    if (tips.length < 4) tips.push([Math.cos(a) * d * 0.7, y + 0.08, Math.sin(a) * d * 0.7]);
  }
  const c0 = rand() * 6.283;
  for (let i = 0; i < 7; i++) {
    const a = c0 + (i + (rand() - 0.5) * 0.6) / 7 * 6.283, d = 0.66 * (0.92 + 0.16 * rand());
    const r = 0.21 * (0.85 + 0.3 * rand()), ry = 0.44 * (0.85 + 0.3 * rand());
    S.lobe(Math.cos(a) * d, -0.26 + (rand() - 0.5) * 0.12, Math.sin(a) * d, r, ry, r, 2, rand, 0.10);
  }
  woodInto(S, sp, rand, -0.56, tips, [0, 0.30, 0]);
  return S.finish(0.6);
}

// A shrub never becomes a near model (js/trees.js keeps it on the far tier at
// any distance), but the far tier paints every crown from a model
// (js/treeimpostor.js), so it gets one for that: a low cushion of overlapping
// lobes reaching down to the ground, no wood worth drawing.
export function shrubModel(variant) {
  const sp = SP.SHRUB, rand = rng(3301 + 53 * variant), S = new Soup(-groundOf(sp));
  S.lobe((rand() - 0.5) * 0.08, -0.16, (rand() - 0.5) * 0.08, 0.64, 0.76, 0.64, 2, rand, 0.15);
  const a0 = rand() * 6.283;
  for (let i = 0; i < 5; i++) {
    const a = a0 + (i + (rand() - 0.5) * 0.5) / 5 * 6.283, d = 0.44 * (0.85 + 0.3 * rand());
    const r = 0.42 * (0.85 + 0.3 * rand());
    S.lobe(Math.cos(a) * d, -0.42 + rand() * 0.3, Math.sin(a) * d, r, r * 0.9, r, 2, rand, 0.17);
  }
  S.lobe((rand() - 0.5) * 0.2, 0.42, (rand() - 0.5) * 0.2, 0.40, 0.34, 0.40, 2, rand, 0.15);
  return S.finish(0.6);
}

/** The near model of a species: 0 or 1 for the two builds of it. Cached by the caller. */
export function nearModel(sp, variant) {
  if (BROAD[sp]) return broadleaf(sp, variant);
  if (sp === SP.WILLOW) return willow(variant);
  if (sp === SP.POPLAR) return poplar(variant);
  if (sp === SP.BIRCH) return birch(variant);
  if (sp === SP.SPRUCE) return spruce(variant);
  if (sp === SP.PINE) return pine(variant);
  return null;                 // a shrub is small enough to stay the far blob
}
