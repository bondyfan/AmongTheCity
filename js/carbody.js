// ---- carbody.js: the sheet metal -------------------------------------------
// A car body here is ONE continuous surface described by a handful of curves
// along the car (underside, shoulder, half width, roofline) and a cross-section
// that rides them. vehicles.js keeps the nine-station silhouette per kind (the
// cabin, the seats and the first-person eye are all derived from it); this
// module turns that silhouette into something with no visible facets:
//
//   * the station columns are interpolated with a monotone cubic, so a nose
//     that was three straight chords becomes one curve and never overshoots,
//   * every ring carries 27 points with a real section (rocker tuck, flat door,
//     a shoulder crease, tumblehome into the glass, a crowned roof),
//   * the wheel arches are CUT: rings are placed at equal angles round each
//     arch and the flank points under the arc are lifted onto it, so the
//     opening is a true circle with a returned lip and a dark well behind,
//   * the nose and tail are swept in plan so bumper corners curve away.
//
// Everything that is not sheet metal (glass, lamps, grilles, shut lines,
// trims) is DRAPED: a flat outline drawn in side, front, rear or top view is
// tessellated and projected onto the same analytic surface a few millimetres
// proud. That keeps the paint hull one smooth indexed mesh (which is what
// dentCar wants to crumple) and lets a lamp be any shape rather than whatever
// the ring grid happens to offer.
//
// Pure geometry: no materials, no scene, no DOM. Everything is local to the
// car: origin on the ground under the centre, -z is the nose, +x the right.

import * as THREE from 'three';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Monotone cubic (Fritsch-Carlson). A plain Catmull-Rom through nine stations
// overshoots at the bumper lip and puts a dimple in the bonnet; this one is
// guaranteed to stay inside the data, which is what "a believable curve
// through a designer's stations" needs.
export function pchip(xs, ys) {
  const n = xs.length;
  if (n === 1) return () => ys[0];
  const h = [], d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = (ys[i + 1] - ys[i]) / h[i]; }
  const end = (h0, h1, d0, d1) => {
    let s = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1);
    if (s * d0 <= 0) s = 0;
    else if (d0 * d1 <= 0 && Math.abs(s) > 3 * Math.abs(d0)) s = 3 * d0;
    return s;
  };
  if (n === 2) m[0] = m[1] = d[0];
  else {
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) m[i] = 0;
      else {
        const w1 = 2 * h[i] + h[i - 1], w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
      }
    }
    m[0] = end(h[0], h[1], d[0], d[1]);
    m[n - 1] = end(h[n - 2], h[n - 3], d[n - 2], d[n - 3]);
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i++;
    const t = (x - xs[i]) / h[i], t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h[i] * m[i]
      + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h[i] * m[i + 1];
  };
}

// ---- Soup: an indexed triangle bag with optional per-vertex colour ---------
// Vertices weld by KEY, not by position: two faces that should shade as one
// surface ask for the same key, two that meet at a crease ask for different
// ones. computeVertexNormals then gives smooth metal and hard panel edges
// without a normal ever being written by hand.
export class Soup {
  constructor(colored = false) {
    this.p = []; this.i = [];
    this.c = colored ? [] : null;     // linear rgb
    this.q = colored ? [] : null;     // roughness, metalness
    this.g = null;                    // optional lamp gate (see carpaint.js)
    this.map = new Map();
    this._serial = 0;
  }
  // a fresh key range for one patch, so its vertices weld only to each other
  base() { return (++this._serial) * 1e6; }
  v(x, y, z, key = null, mat = null, gate = 0) {
    if (key !== null) { const e = this.map.get(key); if (e !== undefined) return e; }
    const n = this.p.length / 3;
    this.p.push(x, y, z);
    if (this.c) { const m = mat ?? MAT_FALLBACK; this.c.push(m.c[0], m.c[1], m.c[2]); this.q.push(m.r, m.m); }
    if (this.g) this.g.push(gate);
    if (key !== null) this.map.set(key, n);
    return n;
  }
  _area2(a, b, c) {
    const p = this.p;
    const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
    const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
    _n[0] = uy * vz - uz * vy; _n[1] = uz * vx - ux * vz; _n[2] = ux * vy - uy * vx;
    return _n[0] * _n[0] + _n[1] * _n[1] + _n[2] * _n[2];
  }
  // one triangle, wound so its normal agrees with (dx, dy, dz). Degenerates
  // (an arch collapses whole cells onto its rim) are dropped here, once.
  tri(a, b, c, dx, dy, dz) {
    if (a === b || b === c || a === c) return;
    if (this._area2(a, b, c) < 1e-13) return;
    if (_n[0] * dx + _n[1] * dy + _n[2] * dz < 0) this.i.push(a, c, b);
    else this.i.push(a, b, c);
  }
  // …or wound so it faces AWAY from a point (the hull: away from its own axis)
  triFrom(a, b, c, ox, oy, oz) {
    const p = this.p;
    const cx = (p[a * 3] + p[b * 3] + p[c * 3]) / 3 - ox;
    const cy = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3 - oy;
    const cz = (p[a * 3 + 2] + p[b * 3 + 2] + p[c * 3 + 2]) / 3 - oz;
    this.tri(a, b, c, cx, cy, cz);
  }
  quad(a, b, c, d, dx, dy, dz) { this.tri(a, b, c, dx, dy, dz); this.tri(a, c, d, dx, dy, dz); }
  // append a ready-made THREE geometry (mirror head, exhaust tip) unchanged
  add(geo, mat = null, gate = 0) {
    const pos = geo.attributes.position, off = this.p.length / 3;
    for (let k = 0; k < pos.count; k++) this.v(pos.getX(k), pos.getY(k), pos.getZ(k), null, mat, gate);
    if (geo.index) { const ix = geo.index.array; for (let k = 0; k < ix.length; k++) this.i.push(off + ix[k]); }
    else for (let k = 0; k < pos.count; k++) this.i.push(off + k);
    return this;
  }
  get empty() { return this.i.length === 0; }
  warp(fn) {
    const p = this.p;
    for (let k = 0; k < p.length; k += 3) { _w[0] = p[k]; _w[1] = p[k + 1]; _w[2] = p[k + 2]; fn(_w); p[k] = _w[0]; p[k + 1] = _w[1]; p[k + 2] = _w[2]; }
    return this;
  }
  build() {
    if (this.empty) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    if (this.c) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      g.setAttribute('pbr', new THREE.Float32BufferAttribute(this.q, 2));
    }
    if (this.g) g.setAttribute('gate', new THREE.Float32BufferAttribute(this.g, 1));
    g.setIndex(this.p.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.i, 1) : new THREE.Uint16BufferAttribute(this.i, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}
const _n = [0, 0, 0], _w = [0, 0, 0];
const MAT_FALLBACK = { c: [0.5, 0.5, 0.5], r: 0.6, m: 0 };

// ---- makeShape(K, style) → the analytic body -------------------------------
// K is the vehicles.js KIND entry (untouched). style carries the exterior-only
// knobs: plan sweep, crown, arch gap, optional replacement stations for the
// nose and tail. The object returned answers "where is the surface" for the
// hull builder and for every draped detail, so the two can never disagree.
export function makeShape(K, style = {}) {
  const half = K.wid / 2;
  const sts = style.sts ?? K.hull.sts;
  const zs = sts.map((s) => s[0]);
  const fLo = pchip(zs, sts.map((s) => s[1]));
  const fHi = pchip(zs, sts.map((s) => s[2]));
  const fW = pchip(zs, sts.map((s) => s[3] * half));
  const z0 = zs[0], z1 = zs[zs.length - 1];
  const g = K.green ?? null;
  const box = !g;
  const ax = K.axle ?? (K.len / 2 - K.wheelR - 0.35);
  const R = K.wheelR + (style.archGap ?? 0.055);
  const arches = (style.arches ?? [-ax, ax]).filter((a) => a - R > z0 + 0.02 && a + R < z1 - 0.02);
  const bw = style.bw ?? K.hull.bw;
  const crown = style.crown ?? 0.028;
  const fender = style.fender ?? 0.085;       // metal the wing keeps over the tyre
  const beltIn = style.beltIn ?? 0.90;        // how far the glass base steps in from the door skin

  // ---- greenhouse: roofline as its own curve over [gz0, gz1] ----
  let gz0 = 0, gz1 = 0, fRoof = null, gb = 0, tum = 0, hdrZ = 0, cZ = 0;
  if (g) {
    const gs = g.sts, n = gs.length;
    gz0 = gs[0][0];
    gz1 = g.capEnd ? z1 : gs[n - 1][0];
    hdrZ = gs[1][0];
    cZ = g.capEnd ? z1 : gs[n - 2][0];
    // style.gbK / gtK widen the glasshouse beyond the interior's own trapezoid
    // (a van's upper body is nearly as wide as its lower)
    gb = g.baseW * half * (style.gbK ?? 1);
    let hMax = 0;
    for (const s of gs) hMax = Math.max(hMax, s[2] - s[1]);
    tum = (gb - g.topW * half * (style.gtK ?? 1)) / hMax;
    // The screen is kept nearly straight for most of its length and rolls into
    // the roof over the last fifth, and the backlight leaves the roof the same
    // way: a monotone cubic through the raw stations alone bows both into
    // bubbles. The curve starts and ends ON the shoulder so the glass grows
    // out of the body instead of standing on a 3 cm step.
    const rz = [], ry = [];
    const y0 = fHi(gz0), ya = gs[1][2];
    rz.push(gz0, gz0 + (hdrZ - gz0) * 0.8, hdrZ);
    ry.push(y0, y0 + (ya - y0) * 0.86, ya);
    for (let k = 2; k < n - 1; k++) { rz.push(gs[k][0]); ry.push(gs[k][2]); }
    if (g.capEnd) {
      rz.push(gs[n - 1][0], z1); ry.push(gs[n - 1][2], gs[n - 1][2] - 0.012);
    } else {
      const zc = gs[n - 2][0], yc = gs[n - 2][2], ye = fHi(gz1);
      rz.push(zc + (gz1 - zc) * 0.22, gz1); ry.push(yc + (ye - yc) * 0.13, ye);
    }
    fRoof = pchip(rz, ry);
  }

  // shoulder height: the hull's own, lifted into a soft hump wherever a wheel
  // arch would otherwise cut through the wing top (the Tesla's low nose does)
  const yShoulder = (z) => {
    let y = fHi(z);
    if (!box) for (const a of arches) {
      const hy = K.wheelR + R + fender - 0.30 * (z - a) * (z - a);
      if (hy > y) y = hy;
    }
    return y;
  };

  // ---- the cross-section (right half, rocker up to the roof centre) ----
  const M = box ? 11 : 14;
  const jFlank = box ? 5 : 6;        // last point that belongs to the door skin
  const FR = [0.72, 0.45, 0.2, 0];
  function profile(z, xs, ys) {
    const W = fW(z), lo = fLo(z), hi = fHi(z);
    if (box) {
      const H = hi - lo, rr = Math.min(style.roofR ?? 0.14, W * 0.3), cr = style.crown ?? 0.035;
      xs[0] = W * bw; ys[0] = lo;
      xs[1] = W; ys[1] = lo + 0.05;
      xs[2] = W; ys[2] = lo + 0.20 * H;
      xs[3] = W; ys[3] = lo + 0.42 * H;
      xs[4] = W; ys[4] = lo + 0.64 * H;
      xs[5] = W; ys[5] = hi - rr * 1.15;
      xs[6] = W - rr * 0.10; ys[6] = hi - rr * 0.55;
      xs[7] = W - rr * 0.42; ys[7] = hi - rr * 0.16;
      xs[8] = W - rr; ys[8] = hi;
      xs[9] = (W - rr) * 0.5; ys[9] = hi + cr * 0.75;
      xs[10] = 0; ys[10] = hi + cr;
      return W;
    }
    const yS = yShoulder(z), H = yS - lo;
    xs[0] = W * bw - 0.02; ys[0] = lo;
    xs[1] = W * (bw + (1 - bw) * 0.75); ys[1] = lo + 0.035;
    xs[2] = W * 0.997; ys[2] = lo + 0.20 * H;
    xs[3] = W; ys[3] = lo + 0.42 * H;
    // a faint hollow under the character line; a panel van's side is a slab
    xs[4] = W * (style.slab ? 0.999 : 0.986); ys[4] = lo + 0.68 * H;
    xs[5] = W * (style.slab ? 0.996 : 0.990); ys[5] = lo + 0.85 * H;
    xs[6] = W * 0.948; ys[6] = lo + 0.955 * H;    // shoulder rolling over
    const xb = g ? Math.min(gb, W * beltIn) : W * beltIn;
    let hR = 0;
    if (g && z > gz0 && z <= gz1) hR = Math.max(0, fRoof(z) - yS);
    xs[7] = xb; ys[7] = yS;                        // the belt
    // corner: how far the roof edge steps in from the glass plane. 4 cm keeps
    // the roof rail outside the cabin's pillar trims, which are built to topW.
    const cant = Math.min(0.075, hR * 0.45), corner = Math.min(0.04, hR * 0.5);
    xs[8] = xb - tum * (hR - cant); ys[8] = yS + hR - cant;
    xs[9] = xb - tum * hR - corner; ys[9] = yS + hR;
    const xr = xs[9], yC = hi + hR + crown * (0.6 + 0.4 * W / half);
    for (let k = 0; k < 4; k++) {
      xs[10 + k] = xr * FR[k];
      ys[10 + k] = yC + (ys[9] - yC) * Math.pow(FR[k], 2.2);
    }
    return W;
  }

  // ---- surface queries (unswept: the plan sweep is applied to vertices) ----
  const _xs = new Float64Array(M), _ys = new Float64Array(M);
  let _pz = NaN;
  const prof = (z) => { if (z !== _pz) { profile(z, _xs, _ys); _pz = z; } };
  // half width of the body at height y: the widest crossing of the section
  function halfAt(z, y) {
    prof(z);
    let best = -1;
    for (let j = 0; j < M - 1; j++) {
      const a = _ys[j], b = _ys[j + 1];
      if ((y < a && y < b) || (y > a && y > b)) continue;
      const t = Math.abs(b - a) < 1e-9 ? 0 : (y - a) / (b - a);
      const x = _xs[j] + (_xs[j + 1] - _xs[j]) * t;
      if (x > best) best = x;
    }
    return best;
  }
  // height of the top skin (bonnet, screen, roof, boot) at |x|
  function topAt(z, x) {
    prof(z);
    x = Math.abs(x);
    for (let j = M - 1; j > 0; j--) {
      const a = _xs[j], b = _xs[j - 1];           // walking outward and down
      if (x >= a && x <= b) {
        const t = b - a < 1e-9 ? 0 : (x - a) / (b - a);
        return _ys[j] + (_ys[j - 1] - _ys[j]) * t;
      }
    }
    return -1;
  }
  const inside = (x, y, z) => y >= fLo(z) - 1e-6 && halfAt(z, y) >= Math.abs(x);
  // first z, walking in from the nose (dir +1) or the tail (dir -1), at which
  // the point (x, y) of the elevation is inside the body
  function endZ(x, y, dir) {
    let a = dir > 0 ? z0 : z1;
    if (inside(x, y, a)) return a;
    const span = (z1 - z0) * 0.5;
    let b = a, hit = false;
    for (let s = 1; s <= 24; s++) {             // coarse march, then bisect
      b = a + dir * span * s / 24;
      if (inside(x, y, b)) { hit = true; break; }
    }
    if (!hit) return null;
    a = b - dir * span / 24;
    for (let k = 0; k < 18; k++) {
      const m = (a + b) / 2;
      if (inside(x, y, m)) b = m; else a = m;
    }
    return b;
  }

  // ---- plan sweep: bumper corners curve back, in the nose and in the tail ----
  const sf = style.sweepF ?? 0.13, sr = style.sweepR ?? 0.07;
  const lf = style.sweepLenF ?? 0.6, lr = style.sweepLenR ?? 0.5, sp = style.sweepPow ?? 2.3;
  function warp(p) {
    const u = Math.min(1, Math.abs(p[0]) / half);
    const k = Math.pow(u, sp);
    const tf = 1 - (p[2] - z0) / lf, tr = 1 - (z1 - p[2]) / lr;
    if (tf > 0) p[2] += sf * k * tf * tf;
    if (tr > 0) p[2] -= sr * k * tr * tr;
  }

  // The four ways a flat drawing lands on the body. u, v are the drawing's own
  // axes; each returns a point on the UNSWEPT surface or null off the body.
  const proj = {
    side: { n: [1, 0, 0], p: (z, y, o) => { const x = halfAt(z, y); if (x < 0) return null; o[0] = x; o[1] = y; o[2] = z; return o; } },
    top: { n: [0, 1, 0], p: (x, z, o) => { const y = topAt(z, x); if (y < 0) return null; o[0] = x; o[1] = y; o[2] = z; return o; } },
    front: { n: [0, 0, -1], p: (x, y, o) => { const z = endZ(x, y, 1); if (z === null) return null; o[0] = x; o[1] = y; o[2] = z; return o; } },
    rear: { n: [0, 0, 1], p: (x, y, o) => { const z = endZ(x, y, -1); if (z === null) return null; o[0] = x; o[1] = y; o[2] = z; return o; } },
  };

  return {
    K, style, half, z0, z1, M, jFlank, box, arches, R, wheelR: K.wheelR,
    green: g ? { z0: gz0, z1: gz1, hdrZ, cZ, gb, tum, roof: fRoof } : null,
    fLo, fHi, fW, yShoulder, profile, halfAt, topAt, endZ, warp, proj,
    // one named point of the section at z: [x, y] (9 is the roof corner)
    edgeAt(z, j) { prof(z); return [_xs[j], _ys[j]]; },
    // a warped point on the front / rear face at height y on the centreline,
    // with the surface normal there: where a plate or a badge sits
    facePoint(y, rear = false, x = 0) {
      const dir = rear ? -1 : 1, e = 0.012;
      const z = endZ(x, y, dir);
      if (z === null) return null;
      const zu = endZ(x, y + e, dir) ?? z, zd = endZ(x, y - e, dir) ?? z;
      const p = [x, y, z];
      warp(p);
      // slope of the face in the side view: dz/dy; the normal leans back by it
      const s = (zu - zd) / (2 * e);
      const nz = rear ? 1 : -1, ny = rear ? -s : s, l = Math.hypot(ny, nz);
      return { x, y, z: p[2], ny: ny / l, nz: nz / l, pitch: Math.atan(Math.abs(s)) * (s * dir > 0 ? 1 : -1) };
    },
  };
}

// where the rings go: fixed features first (ends, arch angles, glass corners),
// then filler so no gap is wider than `gap`
function ringZs(S, lod) {
  const fixed = [S.z0, S.z1];
  const N = lod ? 3 : 9;
  for (const a of S.arches) for (let k = 0; k <= N; k++) fixed.push(a - S.R * Math.cos(k * Math.PI / N));
  if (S.green) {
    const G = S.green;
    fixed.push(G.z0, G.hdrZ);
    if (!lod) fixed.push(G.z0 + (G.hdrZ - G.z0) * 0.5, G.z0 + (G.hdrZ - G.z0) * 0.8, G.z0 + (G.hdrZ - G.z0) * 0.92);
    if (G.z1 < S.z1 - 0.01) {
      fixed.push(G.z1, G.cZ);
      if (!lod) fixed.push(G.cZ + (G.z1 - G.cZ) * 0.22, G.cZ + (G.z1 - G.cZ) * 0.6);
    }
  }
  fixed.sort((a, b) => a - b);
  const out = [];
  for (const z of fixed) if (!out.length || z - out[out.length - 1] > 0.006) out.push(z);
  // filler: tight at the two ends where the plan and the profile both turn
  const want = [];
  const ends = lod ? [0.12, 0.4] : [0.03, 0.075, 0.14, 0.23, 0.36];
  for (const e of ends) want.push(S.z0 + e, S.z1 - e);
  const gap = lod ? 1.5 : (S.box ? 0.5 : 0.21);
  for (const z of want) {
    let ok = true;
    for (const f of out) if (Math.abs(f - z) < (lod ? 0.1 : 0.028)) { ok = false; break; }
    if (ok) out.push(z);
  }
  out.sort((a, b) => a - b);
  for (let i = 0; i < out.length - 1; i++) {
    const d = out[i + 1] - out[i];
    if (d > gap) {
      const n = Math.ceil(d / gap);
      for (let k = 1; k < n; k++) out.splice(i + k, 0, out[i] + d * k / n);
      i += n - 1;
    }
  }
  return out;
}

// ---- buildHull(S, {lod, paint, dark, lipMat}) -------------------------------
// Lofts the rings into `paint`, cuts the arches, returns the lip into `paint`
// and the well into `dark`. Smoothing: the door skin below the character line,
// the shoulder above it and the greenhouse are three groups, so the crease and
// the belt are hard edges and everything else is one smooth panel.
export function buildHull(S, o) {
  const { paint, dark, lod = false, linerMat } = o;
  // The distance variant keeps every ring's SHAPE (the arch cut needs the full
  // section) but lofts only a subset of its points: 17 a ring instead of 27.
  const J = !lod ? Array.from({ length: S.M }, (_, j) => j)
    : (S.box ? [0, 1, 3, 5, 7, 8, 10] : [0, 2, 3, 5, 7, 8, 9, 11, 13]);
  const M = J.length, NK = 2 * M - 1, zs = ringZs(S, lod), n = zs.length;
  const xs = new Float64Array(S.M), ys = new Float64Array(S.M);
  const P = [];                                    // P[i] = Float64Array(NK*3)
  const rims = S.arches.map(() => []);             // per arch: clamped rim points (right side)
  const groupOf = S.box ? () => 0 : (jj) => { const j = J[jj]; return j < 5 ? 0 : j < 7 ? 1 : 2; };
  for (let i = 0; i < n; i++) {
    const z = zs[i];
    S.profile(z, xs, ys);
    // arch cut: lift every door-skin point under the arc ONTO the arc
    for (let a = 0; a < S.arches.length; a++) {
      const dz = z - S.arches[a];
      if (Math.abs(dz) >= S.R - 1e-6) {
        if (Math.abs(Math.abs(dz) - S.R) < 1e-6) rims[a].push([xs[0], ys[0], z, 0]);
        continue;
      }
      const yb = S.wheelR + Math.sqrt(S.R * S.R - dz * dz);
      let xb = xs[S.jFlank];
      for (let j = 0; j < S.jFlank; j++) {
        if (yb >= ys[j] && yb <= ys[j + 1]) {
          xb = xs[j] + (xs[j + 1] - xs[j]) * (yb - ys[j]) / Math.max(1e-9, ys[j + 1] - ys[j]);
          break;
        }
      }
      for (let j = 0; j <= S.jFlank; j++) if (ys[j] < yb) { xs[j] = xb; ys[j] = yb; }
      rims[a].push([xb, yb, z, 1]);
    }
    const r = new Float64Array(NK * 3);
    for (let k = 0; k < NK; k++) {
      const j = J[k < M ? k : NK - 1 - k];
      r[k * 3] = k < M ? xs[j] : -xs[j]; r[k * 3 + 1] = ys[j]; r[k * 3 + 2] = z;
    }
    P.push(r);
  }
  const vid = (i, k, grp) => paint.v(P[i][k * 3], P[i][k * 3 + 1], P[i][k * 3 + 2], i * 4096 + k * 8 + grp);
  for (let i = 0; i < n - 1; i++) {
    const zm = (zs[i] + zs[i + 1]) / 2;
    const ym = (S.fLo(zm) + S.fHi(zm)) / 2;
    for (let k = 0; k < NK - 1; k++) {
      const j = k < M - 1 ? k : NK - 2 - k, grp = groupOf(j);
      const a = vid(i, k, grp), b = vid(i, k + 1, grp), c = vid(i + 1, k + 1, grp), d = vid(i + 1, k, grp);
      paint.triFrom(a, b, c, 0, ym, zm);
      paint.triFrom(a, c, d, 0, ym, zm);
    }
  }
  // end caps: strips between a point and its mirror, split across so the plan
  // sweep can bow them. Car noses share the ring's vertices (the bumper edge
  // rolls over); slab-sided kinds keep a crisp face.
  const cols = lod ? 2 : 5;
  for (const end of [0, n - 1]) {
    const dir = end === 0 ? -1 : 1, r = P[end];
    const id = (j, c) => {
      const x = r[j * 3] * (2 * c / cols - 1);
      if (!S.box && (c === 0 || c === cols)) return vid(end, c === cols ? j : NK - 1 - j, groupOf(Math.min(j, M - 2)));
      return paint.v(x, r[j * 3 + 1], r[j * 3 + 2], 5e7 + end * 1e5 + j * 64 + c);
    };
    for (let j = 0; j < M - 1; j++) for (let c = 0; c < cols; c++) {
      paint.quad(id(j, c), id(j, c + 1), id(j + 1, c + 1), id(j + 1, c), 0, 0, dir);
    }
  }
  // arch returns: a body-colour lip turned in, then the dark well
  const lip = lod ? 0 : 0.028, depth = 0.34;
  for (let a = 0; a < S.arches.length; a++) {
    const rim = rims[a];
    if (rim.length < 3) continue;
    const zc = S.arches[a], yc = S.wheelR;
    let xMin = Infinity;
    for (const p of rim) xMin = Math.min(xMin, p[0]);
    const xin = Math.max(0.2, xMin - depth);
    for (const sgn of [1, -1]) {
      const kb = paint.base(), db = dark.base();
      const hub = dark.v(sgn * xin, yc + 0.08, zc, db + 9999, linerMat);
      for (let k = 0; k < rim.length - 1; k++) {
        const p = rim[k], q = rim[k + 1];
        // facing direction: toward the axle, from the middle of this piece of rim
        const fy = yc - (p[1] + q[1]) / 2, fz = zc - (p[2] + q[2]) / 2;
        let p1, q1;
        if (lip > 0) {
          const p0 = paint.v(sgn * p[0], p[1], p[2], kb + k * 4), q0 = paint.v(sgn * q[0], q[1], q[2], kb + k * 4 + 4);
          p1 = paint.v(sgn * (p[0] - lip), p[1], p[2], kb + k * 4 + 1); q1 = paint.v(sgn * (q[0] - lip), q[1], q[2], kb + k * 4 + 5);
          paint.quad(p0, q0, q1, p1, 0, fy, fz);
        }
        const d0 = dark.v(sgn * (p[0] - lip), p[1], p[2], db + k * 4, linerMat), e0 = dark.v(sgn * (q[0] - lip), q[1], q[2], db + k * 4 + 4, linerMat);
        const d1 = dark.v(sgn * xin, p[1], p[2], db + k * 4 + 1, linerMat), e1 = dark.v(sgn * xin, q[1], q[2], db + k * 4 + 5, linerMat);
        dark.quad(d0, e0, e1, d1, 0, fy, fz);
        // back wall, as its own flat-shaded fan
        const w0 = dark.v(sgn * xin, p[1], p[2], db + k * 4 + 2, linerMat), w1 = dark.v(sgn * xin, q[1], q[2], db + k * 4 + 6, linerMat);
        dark.tri(hub, w0, w1, sgn, 0, 0);
      }
    }
  }
  return { zs, rims };
}

// ---- drape: a flat convex outline, tessellated and laid on the body --------
// poly is [[u, v], …] in the projection's own axes (see makeShape.proj), convex,
// either winding. It is cut into scanline bands no taller than `h` and each
// band into the same number of columns, so the patch is a watertight indexed
// grid whose own chords stay within a millimetre of the curved panel under it.
// `eps` lifts it off the paint along the true surface normal.
const _a = [0, 0, 0], _b = [0, 0, 0], _c = [0, 0, 0], _d = [0, 0, 0], _e = [0, 0, 0];
let DRAPE_DEBUG = false;
export function setDrapeDebug(on) { DRAPE_DEBUG = !!on; }
export function drape(soup, S, view, poly, mat, o = {}) {
  const pr = S.proj[view];
  const eps = o.eps ?? 0.004, h = o.h ?? 0.07, gate = o.gate ?? 0;
  const sides = o.mirror ? [1, -1] : [o.flip ? -1 : 1];
  // scanlines
  const all = poly.map((p) => p[1]);
  // In plan the scan axis IS the car's length, so the hull's own ring stations
  // are scanned too: where the roof rolls into the screen the patch then bends
  // exactly where the paint under it bends, and cannot cut the corner.
  if (o.zs && view === 'top') {
    const lo = Math.min(...all), hi = Math.max(...all);
    for (const z of o.zs) if (z > lo + 0.012 && z < hi - 0.012) all.push(z);
  }
  all.sort((a, b) => a - b);
  const vs = [];
  for (const v of all) if (!vs.length || v - vs[vs.length - 1] > 1e-5) vs.push(v);
  const lines = [];
  for (let i = 0; i < vs.length; i++) {
    lines.push(vs[i]);
    if (i < vs.length - 1) {
      const d = vs[i + 1] - vs[i], m = Math.ceil(d / h);
      for (let k = 1; k < m; k++) lines.push(vs[i] + d * k / m);
    }
  }
  const span = (v) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      if ((v < a[1] - 2e-5 && v < b[1] - 2e-5) || (v > a[1] + 2e-5 && v > b[1] + 2e-5)) continue;
      if (Math.abs(b[1] - a[1]) < 2e-5) { lo = Math.min(lo, a[0], b[0]); hi = Math.max(hi, a[0], b[0]); continue; }
      const u = a[0] + (b[0] - a[0]) * clamp((v - a[1]) / (b[1] - a[1]), 0, 1);
      lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
    return [lo, hi];
  };
  const spans = lines.map(span);
  let wMax = 0;
  for (const s of spans) wMax = Math.max(wMax, s[1] - s[0]);
  const cols = Math.max(1, Math.ceil(wMax / (o.hu ?? h)));
  const D = 0.012;
  for (const sg of sides) {
    const base = soup.base();
    const ids = [], nrm = [];
    let ok = true;
    for (let r = 0; r < lines.length && ok; r++) {
      const row = [], nrow = [];
      for (let c = 0; c <= cols; c++) {
        const u = spans[r][0] + (spans[r][1] - spans[r][0]) * c / cols, v = lines[r];
        if (!pr.p(u, v, _a)) { ok = false; break; }
        // surface normal by central differences, flipped onto the view's side
        let nx = pr.n[0], ny = pr.n[1], nz = pr.n[2];
        if (pr.p(u + D, v, _b) && pr.p(u - D, v, _c) && pr.p(u, v + D, _d) && pr.p(u, v - D, _e)) {
          const ux = _b[0] - _c[0], uy = _b[1] - _c[1], uz = _b[2] - _c[2];
          const vx = _d[0] - _e[0], vy = _d[1] - _e[1], vz = _d[2] - _e[2];
          let cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
          const l = Math.hypot(cx, cy, cz);
          if (l > 1e-12) {
            if (cx * nx + cy * ny + cz * nz < 0) { cx = -cx; cy = -cy; cz = -cz; }
            nx = cx / l; ny = cy / l; nz = cz / l;
          }
        }
        row.push(soup.v(sg * (_a[0] + nx * eps), _a[1] + ny * eps, _a[2] + nz * eps, base + r * 512 + c, mat, gate));
        nrow.push(sg * nx, ny, nz);
      }
      ids.push(row); nrm.push(nrow);
    }
    if (!ok) { if (DRAPE_DEBUG) console.warn('[carbody] patch fell off the body:', view, o.name ?? '', poly.slice(0, 3).map((q) => q.map((n) => +n.toFixed(2)).join(',')).join(' | ')); continue; }
    for (let r = 0; r < ids.length - 1; r++) for (let c = 0; c < cols; c++) {
      // wound by the SURFACE normal at the quad, not by the view direction: a
      // lamp that wraps a bumper corner ends up facing sideways, where the
      // view direction no longer says anything about which side is out
      const q = nrm[r];
      soup.quad(ids[r][c], ids[r][c + 1], ids[r + 1][c + 1], ids[r + 1][c], q[c * 3], q[c * 3 + 1], q[c * 3 + 2]);
    }
  }
}

// ---- outline helpers: everything draped is one of these --------------------
export const rect = (u0, v0, u1, v1) => [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
// rounded rectangle, r clamped to the short side, `seg` points per corner
export function rrect(u0, v0, u1, v1, r, seg = 3) {
  r = Math.min(r, (u1 - u0) / 2, (v1 - v0) / 2);
  const out = [];
  const arc = (cu, cv, a0) => { for (let k = 0; k <= seg; k++) { const a = a0 + (Math.PI / 2) * k / seg; out.push([cu + Math.cos(a) * r, cv + Math.sin(a) * r]); } };
  arc(u1 - r, v1 - r, 0); arc(u0 + r, v1 - r, Math.PI / 2); arc(u0 + r, v0 + r, Math.PI); arc(u1 - r, v0 + r, Math.PI * 1.5);
  return out;
}
export function ellipse(cu, cv, ru, rv, seg = 14) {
  const out = [];
  for (let k = 0; k < seg; k++) { const a = Math.PI * 2 * k / seg; out.push([cu + Math.cos(a) * ru, cv + Math.sin(a) * rv]); }
  return out;
}
