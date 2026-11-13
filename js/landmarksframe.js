// ---- landmarksframe.js: a building's own axes ----
// WORKER SAFE. The other half of the modelling kit (js/landmarkskit.js): a
// Frame turns a building's own axes (u along the front from left to right as
// seen from outside, v out through the front, y up from its ground) into world
// space, and fitFrame finds those axes from the footprint itself plus one
// compass hint, so nothing here depends on which vertex a ring starts at.

import * as THREE from 'three';
import { K, lin, obbOf } from './landmarkskit.js';

/** A building's own axes. u: along the front, left to right seen from outside;
 *  v: out through the front; y: up from `y` above the landmark's ground. */
export class Frame {
  constructor(kit, ox, oz, nx, nz, y = 0) {
    const L = Math.hypot(nx, nz) || 1;
    this.k = kit; this.ox = ox; this.oz = oz; this.y = y;
    this.nx = nx / L; this.nz = nz / L;       // front (v)
    this.ux = this.nz; this.uz = -this.nx;    // right-hand side of somebody facing the front
  }
  /** Local (u, v, y) to a world point (y stays relative to the landmark's ground). */
  P(u, v, y) { return [this.ox + u * this.ux + v * this.nx, this.y + y, this.oz + u * this.uz + v * this.nz]; }
  /** Local (u, v) to world [x, z]. */
  xz(u, v) { return [this.ox + u * this.ux + v * this.nx, this.oz + u * this.uz + v * this.nz]; }
  /** A local rectangle as a world [x, z] ring. */
  ring(u0, u1, v0, v1) { return [this.xz(u0, v0), this.xz(u1, v0), this.xz(u1, v1), this.xz(u0, v1)]; }
  /** World [x, z] to local [u, v]. */
  local(x, z) {
    const dx = x - this.ox, dz = z - this.oz;
    return [dx * this.ux + dz * this.uz, dx * this.nx + dz * this.nz];
  }
  /** A local direction as a world one. */
  dir(du, dv) { return [du * this.ux + dv * this.nx, du * this.uz + dv * this.nz]; }
  /** A new frame at local (u, v), raised by y, turned by `turn` quarter-ish radians. */
  sub(u, v, y = 0, turn = 0) {
    const [x, z] = this.xz(u, v);
    const c = Math.cos(turn), s = Math.sin(turn);
    const [nx, nz] = this.dir(s, c);
    return new Frame(this.k, x, z, nx, nz, this.y + y);
  }

  /** One face of a box. side: 'f' front (v1), 'b' back (v0), 'l' left (u0), 'r' right (u1). */
  face(side, u0, u1, v0, v1, y0, y1, sp = null) {
    const k = this.k;
    let a, b, n;
    if (side === 'f') { a = this.xz(u0, v1); b = this.xz(u1, v1); n = this.dir(0, 1); }
    else if (side === 'b') { a = this.xz(u1, v0); b = this.xz(u0, v0); n = this.dir(0, -1); }
    else if (side === 'l') { a = this.xz(u0, v0); b = this.xz(u0, v1); n = this.dir(-1, 0); }
    else { a = this.xz(u1, v1); b = this.xz(u1, v0); n = this.dir(1, 0); }
    const Y0 = this.y + y0, Y1 = this.y + y1;
    if (sp) k.wallGrid(a, b, Y0, Y1, n[0], n[1], sp);
    else k.wall(a, b, Y0, Y1, n[0], n[1]);
  }
  /**
   * A box. `faces` maps a side letter to a wallGrid spec, `true` for a plain
   * wall or `false` to leave it open; missing sides are plain. `top`/`bottom`
   * add the lids.
   */
  box(u0, u1, v0, v1, y0, y1, faces = null, top = true, bottom = false) {
    for (const s of 'fblr') {
      const sp = faces ? faces[s] : undefined;
      if (sp === false) continue;
      this.face(s, u0, u1, v0, v1, y0, y1, sp && sp !== true ? sp : null);
    }
    if (top) {
      const k = this.k, lid = k.lid;
      if (lid === null) this.flat(u0, u1, v0, v1, y1, true);
      else {
        // a flat roof is felt and gravel, not more of the wall
        const r = k.r, g = k.g, b = k.b, kk = k.k;
        k.set(lid, K.metal); this.flat(u0, u1, v0, v1, y1, true);
        k.r = r; k.g = g; k.b = b; k.k = kk;
      }
    }
    if (bottom) this.flat(u0, u1, v0, v1, y0, false);
  }
  flat(u0, u1, v0, v1, y, up = true) {
    this.k.quad(this.P(u0, v0, y), this.P(u1, v0, y), this.P(u1, v1, y), this.P(u0, v1, y), 0, up ? 1 : -1, 0);
  }
  /**
   * A pitched roof over a rectangle, ridge along u (or along v with `alongV`).
   * hip0 / hip1: how far the ridge is pulled in at each end (0 is a gable,
   * closed with a wall in `gableHex`). `over` is the eaves overhang.
   */
  roof(u0, u1, v0, v1, yE, yR, o = {}) {
    const k = this.k, over = o.over ?? 0;
    const sr = k.r, sg = k.g, sb = k.b, sk = k.k;
    // work in (a, b): a along the ridge, b across it
    const along = !o.alongV;
    const a0 = (along ? u0 : v0) - (o.hip0 ? over : 0), a1 = (along ? u1 : v1) + (o.hip1 ? over : 0);
    const b0 = (along ? v0 : u0) - over, b1 = (along ? v1 : u1) + over;
    const bm = (b0 + b1) / 2;
    const Q = (a, b, y) => (along ? this.P(a, b, y) : this.P(b, a, y));
    const D = (da, db) => (along ? this.dir(da, db) : this.dir(db, da));
    const r0 = a0 + (o.hip0 ?? 0), r1 = a1 - (o.hip1 ?? 0);
    const yO = yE - over * (yR - yE) / Math.max(0.5, (b1 - b0) / 2 - over);   // eaves drop with the slope
    const [d0x, d0z] = D(0, -1), [d1x, d1z] = D(0, 1);
    k.quad(Q(a0, b0, yO), Q(a1, b0, yO), Q(r1, bm, yR), Q(r0, bm, yR), d0x, 1, d0z);
    k.quad(Q(a0, b1, yO), Q(a1, b1, yO), Q(r1, bm, yR), Q(r0, bm, yR), d1x, 1, d1z);
    for (const [end, a, r, hip, da] of [[0, a0, r0, o.hip0, -1], [1, a1, r1, o.hip1, 1]]) {
      const [ex, ez] = D(da, 0);
      if (hip) k.tri(Q(a, b0, yO), Q(a, b1, yO), Q(r, bm, yR), ex, 1, ez);
      else if (o.gableHex !== undefined && o.gableHex !== null) {
        // the masonry triangle under the roof at an open end
        const [gr, gg, gb] = lin(o.gableHex);
        k.r = gr; k.g = gg; k.b = gb; k.k = (o.gableKind ?? K.plaster) / 16;
        const aw = end ? (along ? u1 : v1) : (along ? u0 : v0);
        k.tri(Q(aw, b0 + over, yE), Q(aw, b1 - over, yE), Q(aw, bm, yR - 0.02), ex, 0, ez);
        k.r = sr; k.g = sg; k.b = sb; k.k = sk;
      }
    }
  }
  /** A pyramid (or, with `top` > 0, a truncated one) over a rectangle. */
  pyramid(u0, u1, v0, v1, yE, yA, top = 0) {
    const k = this.k, um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
    const tu = (u1 - u0) / 2 * top, tv = (v1 - v0) / 2 * top;
    const c = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const t = [[um - tu, vm - tv], [um + tu, vm - tv], [um + tu, vm + tv], [um - tu, vm + tv]];
    const f = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4, [fx, fz] = this.dir(f[i][0], f[i][1]);
      if (top > 0) k.quad(this.P(c[i][0], c[i][1], yE), this.P(c[j][0], c[j][1], yE),
        this.P(t[j][0], t[j][1], yA), this.P(t[i][0], t[i][1], yA), fx, 1, fz);
      else k.tri(this.P(c[i][0], c[i][1], yE), this.P(c[j][0], c[j][1], yE), this.P(um, vm, yA), fx, 1, fz);
    }
    if (top > 0) this.flat(um - tu, um + tu, vm - tv, vm + tv, yA, true);
  }
  /**
   * A slab whose outline is drawn in the facade plane: pts are [u, y] pairs
   * (any simple polygon), extruded from v0 to v1. Gables, pediments, attics.
   * With `alongU` the outline is [v, y] and it is extruded from u = v0 to v1.
   */
  slab(pts, v0, v1, alongU = false) {
    const k = this.k;
    const Q = (a, y, d) => (alongU ? this.P(d, a, y) : this.P(a, d, y));
    const D = (da, dd) => (alongU ? this.dir(dd, da) : this.dir(da, dd));
    const v2 = pts.map((p) => new THREE.Vector2(p[0], p[1]));
    if (THREE.ShapeUtils.isClockWise(v2)) v2.reverse();
    const faces = THREE.ShapeUtils.triangulateShape(v2, []);
    const [fx, fz] = D(0, 1);
    for (const [i, j, l] of faces) {
      k.tri(Q(v2[i].x, v2[i].y, v1), Q(v2[j].x, v2[j].y, v1), Q(v2[l].x, v2[l].y, v1), fx, 0, fz);
      k.tri(Q(v2[i].x, v2[i].y, v0), Q(v2[j].x, v2[j].y, v0), Q(v2[l].x, v2[l].y, v0), -fx, 0, -fz);
    }
    // the edge strip: counter-clockwise in (a, y), so the outside is (dy, -da)
    for (let i = 0; i < v2.length; i++) {
      const p = v2[i], q = v2[(i + 1) % v2.length];
      const da = q.x - p.x, dy = q.y - p.y, L = Math.hypot(da, dy);
      if (L < 1e-6) continue;
      const [ox, oz] = D(dy / L, 0);
      k.quad(Q(p.x, p.y, v0), Q(q.x, q.y, v0), Q(q.x, q.y, v1), Q(p.x, p.y, v1), ox, -da / L, oz);
    }
  }
  /**
   * The inside of a gate passage running along v: two walls and a vault, all
   * facing inward. `arch` as in wallGrid (0 flat lintel, 1 round, 2 pointed).
   */
  tunnel(uc, w, v0, v1, h, arch = 1) {
    const k = this.k, rad = w / 2;
    const rise = !arch ? 0 : arch === 2 ? Math.min(rad * 1.45, h * 0.5) : Math.min(rad, h * 0.5);
    const yS = h - rise;
    const [lx, lz] = this.dir(1, 0);
    k.quad(this.P(uc - rad, v0, 0), this.P(uc - rad, v1, 0), this.P(uc - rad, v1, yS), this.P(uc - rad, v0, yS), lx, 0, lz);
    k.quad(this.P(uc + rad, v0, 0), this.P(uc + rad, v1, 0), this.P(uc + rad, v1, yS), this.P(uc + rad, v0, yS), -lx, 0, -lz);
    if (!arch) { this.flat(uc - rad, uc + rad, v0, v1, h, false); return; }
    const N = 5, pt = (t) => {
      const ang = t * Math.PI / 2;
      return [Math.cos(ang) * rad, yS + rise * (arch === 2 ? Math.pow(Math.sin(ang), 0.72) : Math.sin(ang))];
    };
    for (const side of [-1, 1]) for (let i = 0; i < N; i++) {
      const p = pt(i / N), q = pt((i + 1) / N);
      const [ix, iz] = this.dir(-side, 0);
      k.quad(this.P(uc + side * p[0], v0, p[1]), this.P(uc + side * p[0], v1, p[1]),
        this.P(uc + side * q[0], v1, q[1]), this.P(uc + side * q[0], v0, q[1]), ix * 0.5, -1, iz * 0.5);
    }
  }
  /** Battlements along one side of a rectangle's top: merlons mw wide, mh high. */
  merlons(side, u0, u1, v0, v1, y, mh, mw, gap, th = 0.45, swallow = false) {
    const horiz = side === 'f' || side === 'b';
    const L = horiz ? u1 - u0 : v1 - v0;
    const n = Math.max(1, Math.floor((L + gap) / (mw + gap)));
    const pitch = (L - n * mw) / Math.max(1, n - 1) + mw;
    for (let i = 0; i < n; i++) {
      const s0 = (n === 1 ? (L - mw) / 2 : i * pitch), s1 = s0 + mw;
      let a0, a1, b0, b1;
      if (horiz) { a0 = u0 + s0; a1 = u0 + s1; b0 = side === 'f' ? v1 - th : v0; b1 = side === 'f' ? v1 : v0 + th; }
      else { b0 = v0 + s0; b1 = v0 + s1; a0 = side === 'r' ? u1 - th : u0; a1 = side === 'r' ? u1 : u0 + th; }
      if (!swallow) { this.box(a0, a1, b0, b1, y, y + mh); continue; }
      // a swallow-tail merlon: two horns with a notch between them
      this.box(a0, a1, b0, b1, y, y + mh * 0.55);
      if (horiz) {
        const q = (a1 - a0) * 0.36;
        this.box(a0, a0 + q, b0, b1, y + mh * 0.55, y + mh);
        this.box(a1 - q, a1, b0, b1, y + mh * 0.55, y + mh);
      } else {
        const q = (b1 - b0) * 0.36;
        this.box(a0, a1, b0, b0 + q, y + mh * 0.55, y + mh);
        this.box(a0, a1, b1 - q, b1, y + mh * 0.55, y + mh);
      }
    }
  }
}

/**
 * The frame a footprint suggests: its bounding rectangle, turned so that the
 * front (v) is the side of the rectangle nearest the world direction (hx, hz).
 * The hint is a compass direction ("the front looks at the square"), so the
 * answer survives a tile rebuild that reorders or nudges the ring.
 * `byEdge` takes the axes from the LONGEST wall instead of the smallest
 * rectangle: a long building with wings stepped to one side has a smallest
 * rectangle that lies skew to every wall it has (the station, by 3 degrees).
 * @returns {{F: Frame, hu: number, hv: number}} half extents along u and v
 */
export function fitFrame(kit, ring, hx, hz, byEdge = false) {
  let o = obbOf(ring);
  if (byEdge) {
    let L = -1, ex = 1, ez = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i], q = ring[(i + 1) % ring.length];
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (l > L + 1e-6) { L = l; ex = (q[0] - p[0]) / l; ez = (q[1] - p[1]) / l; }
    }
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const r of ring) {
      const a = r[0] * ex + r[1] * ez, b = -r[0] * ez + r[1] * ex;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
    o = { cx: ma * ex - mb * ez, cz: ma * ez + mb * ex, ux: ex, uz: ez, hl: (a1 - a0) / 2, hw: (b1 - b0) / 2 };
  }
  const c = [[o.ux, o.uz, o.hw, o.hl], [-o.ux, -o.uz, o.hw, o.hl],
    [-o.uz, o.ux, o.hl, o.hw], [o.uz, -o.ux, o.hl, o.hw]];
  let best = c[0], bd = -Infinity;
  for (const k of c) { const d = k[0] * hx + k[1] * hz; if (d > bd + 1e-9) { bd = d; best = k; } }
  return { F: new Frame(kit, o.cx, o.cz, best[0], best[1], 0), hu: best[2], hv: best[3] };
}
