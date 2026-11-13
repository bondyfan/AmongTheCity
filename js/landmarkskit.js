// ---- landmarkskit.js: the modelling kit the hand-made landmarks are built with ----
// WORKER SAFE: pure maths and typed arrays, no DOM, no clock, no Math.random.
// The same builder runs on the main thread and in the mesher worker and has to
// emit the same triangles in the same order (tests/landmarks.test.mjs).
//
// A landmark is a few hundred to a few thousand flat-shaded triangles in one
// sink per chunk, drawn with one material (js/landmarksmat.js). Every vertex
// carries, beside position, normal and colour:
//   uv.x   what the surface is MADE of (K.*, in sixteenths): the shader lays
//          tile courses, brick bond or ashlar joints in world metres from it
//   uv.y   window light: 0 for anything that is not a lit pane at night
//   uv1.x  floodlight: how much of the monument lighting reaches this vertex
//   uv1.y  spare, always 0
//   ...except on a window pane (K.glass, K.glassDark), where uv1 is the pane's
//   own coordinate instead, in eighths of a light: the shader draws the frame
//   and the glazing bars from it, so a window costs two triangles, not twenty.
// Both pairs stay inside 0..1 so the chunk codec ships them as u16 (geomcodec).
//
// Coordinates: world metres, y up, x east, z south. A Frame (landmarksframe.js)
// turns a building's own axes into world space, so a builder is written the
// way the building is described: "the front has nine bays".

import * as THREE from 'three';

/** Surface kinds. Append only: the shader switches on the numbers. */
export const K = { plaster: 0, tile: 1, brick: 2, stone: 3, copper: 4, glass: 5,
  slate: 6, wood: 7, metal: 8, clad: 9, glassDark: 10 };

const _c = new THREE.Color();
/** sRGB hex to the linear triple vertex colours are stored in. */
export function lin(hex) { _c.setHex(hex); return [_c.r, _c.g, _c.b]; }

/** A deterministic 0..1 from two integers and a salt (window lights, tone). */
export function hash2(a, b, s = 0) {
  let h = (Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(s | 0, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export class LandmarkSink {
  constructor() { this.pos = []; this.nrm = []; this.col = []; this.uv = []; this.uv1 = []; }
  get tris() { return this.pos.length / 9; }
  geo() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(this.uv1), 2));
    return g;
  }
}

/** One solid piece of a landmark (js/landmarks.js landmarkSolids): the whole
 *  footprint, courtyards open, solid from `bot` to `top` metres above its ground. */
export const prism = (f, top, bot = 0) => ({ ring: f.o, holes: f.i ?? null, top, bot });

/** Signed area of an [x,z] ring (positive and negative only tell the winding). */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/** Area centroid of a ring. */
export function ringCentroid(ring) {
  let a = 0, cx = 0, cz = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    const c = p[0] * q[1] - q[0] * p[1];
    a += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c;
  }
  if (Math.abs(a) < 1e-9) return [ring[0][0], ring[0][1]];
  return [cx / (3 * a), cz / (3 * a)];
}

/**
 * The smallest rectangle around a ring whose sides follow one of its edges.
 * @returns {{cx,cz,ux,uz,hl,hw}} centre, unit long axis, half length, half width
 */
export function obbOf(ring) {
  let best = null;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    let ux = q[0] - p[0], uz = q[1] - p[1];
    const L = Math.hypot(ux, uz);
    if (L < 0.5) continue;
    ux /= L; uz /= L;
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const r of ring) {
      const a = r[0] * ux + r[1] * uz, b = -r[0] * uz + r[1] * ux;
      if (a < a0) a0 = a; if (a > a1) a1 = a;
      if (b < b0) b0 = b; if (b > b1) b1 = b;
    }
    const area = (a1 - a0) * (b1 - b0);
    // strictly smaller only: the first edge wins a tie, whatever the platform
    if (!best || area < best.area - 1e-6) best = { area, ux, uz, a0, a1, b0, b1 };
  }
  const { ux, uz, a0, a1, b0, b1 } = best;
  const ma = (a0 + a1) / 2, mb = (b0 + b1) / 2;
  let o = { cx: ma * ux - mb * uz, cz: ma * uz + mb * ux, ux, uz, hl: (a1 - a0) / 2, hw: (b1 - b0) / 2 };
  if (o.hw > o.hl) o = { cx: o.cx, cz: o.cz, ux: -uz, uz: ux, hl: o.hw, hw: o.hl };
  return o;
}

export class Kit {
  /**
   * @param {LandmarkSink} sink
   * @param {number} ground absolute height the building stands on
   */
  constructor(sink, ground, terrain = null, ways = null) {
    this.s = sink; this.ground = ground;
    this.terrain = terrain;   // the height field, when the builder was handed one (see rel)
    this.ways = ways;         // the chunk's ways, whose levelled decks the ground is drawn to (landmarks-passage floorAt)
    this.r = 1; this.g = 1; this.b = 1; this.k = 0; this.gl = 0;
    this.floodFn = null;      // (x, y, z) -> 0..1, y relative to the ground
    this.ao = true;           // darken walls toward the pavement
    this.lid = null;          // colour of a box's top when it is a flat roof (hex), or null
  }
  /**
   * The ground at (x, z) in the model's own heights (metres above `ground`).
   * A landmark is founded at ONE height, and a long one stands on ground that
   * is not level: whatever must meet the ground it is walked on (the floor of
   * a passage, the foot of a rampart wall) asks here. Zero without a terrain.
   */
  rel(x, z) { return this.terrain ? this.terrain.heightAt(x, z) - this.ground : 0; }
  /** Colour and material of everything emitted from here on. Chains. */
  set(hex, kind = K.plaster) {
    _c.setHex(hex); this.r = _c.r; this.g = _c.g; this.b = _c.b; this.k = kind / 16; this.gl = 0;
    return this;
  }
  _v(p, nx, ny, nz, pane = null) {
    const s = this.s, y = p[1] + this.ground;
    s.pos.push(p[0], y, p[2]);
    s.nrm.push(nx, ny, nz);
    // the pavement end of a wall sits in its own shade, like the generic houses
    let a = 1;
    if (this.ao && ny > -0.3 && ny < 0.3) { const t = p[1] / 4; a = 0.8 + 0.2 * (t < 0 ? 0 : t > 1 ? 1 : t); }
    s.col.push(this.r * a, this.g * a, this.b * a);
    s.uv.push(this.k, this.gl);
    if (pane) { s.uv1.push(pane[0], pane[1]); return; }
    let f = this.floodFn ? this.floodFn(p[0], p[1], p[2]) : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    s.uv1.push(f, 0);
  }
  /** One triangle, wound so that it faces (fx,fy,fz). Points are [x, y, z], y above ground. */
  tri(A, B, C, fx, fy, fz, pa = null, pb = null, pc = null) {
    let nx = (B[1] - A[1]) * (C[2] - A[2]) - (B[2] - A[2]) * (C[1] - A[1]);
    let ny = (B[2] - A[2]) * (C[0] - A[0]) - (B[0] - A[0]) * (C[2] - A[2]);
    let nz = (B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]);
    const L = Math.hypot(nx, ny, nz);
    if (L < 1e-9) return;
    nx /= L; ny /= L; nz /= L;
    if (nx * fx + ny * fy + nz * fz < 0) {
      let t = B; B = C; C = t; t = pb; pb = pc; pc = t;
      nx = -nx; ny = -ny; nz = -nz;
    }
    this._v(A, nx, ny, nz, pa); this._v(B, nx, ny, nz, pb); this._v(C, nx, ny, nz, pc);
  }
  /** A window pane: corners low-left, low-right, top-right, top-left, split into nx by ny lights. */
  pane(A, B, C, D, fx, fz, nx, ny) {
    const u = Math.min(8, Math.max(1, nx)) / 8, v = Math.min(8, Math.max(1, ny)) / 8;
    this.tri(A, B, C, fx, 0, fz, [0, 0], [u, 0], [u, v]);
    this.tri(A, C, D, fx, 0, fz, [0, 0], [u, v], [0, v]);
  }
  quad(A, B, C, D, fx, fy, fz) { this.tri(A, B, C, fx, fy, fz); this.tri(A, C, D, fx, fy, fz); }

  /** A plain vertical wall from a to b ([x,z]) facing (nx,nz). */
  wall(a, b, y0, y1, nx, nz) {
    this.quad([a[0], y0, a[1]], [b[0], y0, b[1]], [b[0], y1, b[1]], [a[0], y1, a[1]], nx, 0, nz);
  }

  /**
   * A wall with a grid of openings cut into it.
   * @param {object} sp
   *   cols   number of bays, or `pitch` metres per bay (rounded to fit)
   *   inset  blank wall at both ends, metres
   *   rows   [{ y, h, w, arch, glow, hex, rev, door }]: sill above y0, opening
   *          height and width, arch 0 square / 1 round / 2 pointed, `glow` the
   *          share of panes lit at night, `hex` the pane colour, `rev` reveal,
   *          `kind` what the pane is made of, `open` for a real hole (no pane),
   *          `nx`/`ny` lights across and up, `dark` for dark metal frames
   *   seed   salt for which panes are lit
   *   skip   (col, row) => true for a blank bay
   */
  wallGrid(a, b, y0, y1, nx, nz, sp) {
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    if (L < 0.05) return;
    const dx = ex / L, dz = ez / L;
    const inset = Math.min(sp.inset ?? 0, L * 0.4);
    const run = L - 2 * inset;
    const cols = Math.max(1, sp.cols ?? Math.round(run / (sp.pitch ?? 3)));
    const bay = run / cols;
    const rows = (sp.rows ?? []).filter((r) => r.y >= 0 && r.y + r.h <= y1 - y0 + 1e-6)
      .slice().sort((p, q) => p.y - q.y);
    const wr = this.r, wg = this.g, wb = this.b, wk = this.k;
    const P = (s, y) => [a[0] + dx * s, y, a[1] + dz * s];
    const band = (s0, s1, ya, yb) => {
      if (s1 - s0 < 1e-4 || yb - ya < 1e-4) return;
      this.quad(P(s0, ya), P(s1, ya), P(s1, yb), P(s0, yb), nx, 0, nz);
    };
    let yAt = y0;
    for (let ri = 0; ri < rows.length; ri++) {
      const R = rows[ri], ya = y0 + R.y, yb = ya + R.h;
      if (ya < yAt - 1e-6) continue;                       // overlapping row: ignore it
      band(0, L, yAt, ya);
      const w = Math.min(R.w, bay - 0.12), rev = R.rev ?? 0.14;
      let sAt = 0;
      for (let c = 0; c < cols; c++) {
        if (sp.skip && sp.skip(c, ri)) continue;
        const sc = inset + bay * (c + 0.5), s0 = sc - w / 2, s1 = sc + w / 2;
        band(sAt, s0, ya, yb);
        sAt = s1;
        // the pane, set back into the wall, and the four sides of the hole
        const rx = -nx * rev, rz = -nz * rev;
        if (!R.open) {                                     // open: a real hole, a passage follows
        const q = (s, y) => [a[0] + dx * s + rx, y, a[1] + dz * s + rz];
        const lit = R.glow ? hash2(c, ri, (sp.seed ?? 0) + 7) < R.glow : false;
        this.r = wr * 0.74; this.g = wg * 0.74; this.b = wb * 0.74;
        this.quad(P(s0, ya), q(s0, ya), q(s0, yb), P(s0, yb), dx, 0, dz);
        this.quad(P(s1, ya), q(s1, ya), q(s1, yb), P(s1, yb), -dx, 0, -dz);
        this.quad(P(s0, ya), P(s1, ya), q(s1, ya), q(s0, ya), 0, 1, 0);
        if (!R.arch) this.quad(P(s0, yb), P(s1, yb), q(s1, yb), q(s0, yb), 0, -1, 0);
        const [pr, pg, pb] = lin(R.hex ?? (R.door ? 0x3a2a1c : 0x4b5f72));
        this.r = pr; this.g = pg; this.b = pb; this.k = (R.kind ?? (R.door ? K.wood : K.glass)) / 16;
        this.gl = lit ? 0.45 + 0.55 * hash2(c, ri, (sp.seed ?? 0) + 19) : 0;
        if (R.kind === undefined && !R.door) {
          // glass: the shader draws the frame and the bars, one light every
          // 1.1 m across and 1.5 m up unless the row says otherwise
          if (R.dark) this.k = K.glassDark / 16;
          this.pane(q(s0, ya), q(s1, ya), q(s1, yb), q(s0, yb), nx, nz,
            R.nx ?? Math.round(w / 1.1), R.ny ?? Math.round(R.h / 1.5));
        } else this.quad(q(s0, ya), q(s1, ya), q(s1, yb), q(s0, yb), nx, 0, nz);
        this.r = wr; this.g = wg; this.b = wb; this.k = wk; this.gl = 0;
        // An arched opening set back into the wall needs the underside of its
        // arch: without it a deep arcade showed the sky through every crown.
        if (R.arch && rev > 0.3) {
          const rad = w / 2, rise = R.arch === 2 ? Math.min(rad * 1.45, R.h * 0.5) : Math.min(rad, R.h * 0.5);
          const yS = yb - rise, N = 8;
          this.r = wr * 0.74; this.g = wg * 0.74; this.b = wb * 0.74;
          const arc = (k) => {
            const ang = k / N * Math.PI, c = Math.cos(ang), sn = Math.sin(ang);
            return [sc + rad * c, yS + rise * (R.arch === 2 ? Math.pow(sn, 0.72) : sn), c, sn];
          };
          for (let k = 0; k < N; k++) {
            const [sa, ya2, ca, na] = arc(k), [sb, yb2, cb, nb] = arc(k + 1);
            const cm = (ca + cb) / 2, nm = (na + nb) / 2;
            this.quad(P(sa, ya2), q(sa, ya2), q(sb, yb2), P(sb, yb2), -cm * dx, -nm, -cm * dz);
          }
          this.r = wr; this.g = wg; this.b = wb;
        }
        }
        // an arched head: the wall comes back over the two top corners
        if (R.arch) {
          const rad = w / 2, rise = R.arch === 2 ? Math.min(rad * 1.45, R.h * 0.5) : Math.min(rad, R.h * 0.5);
          const yS = yb - rise, N = 5;
          for (const side of [-1, 1]) {
            const corner = P(sc + side * rad, yb);
            let prev = P(sc + side * rad, yS);
            for (let k = 1; k <= N; k++) {
              const t = k / N;
              // round: a quarter circle; pointed: the same arc pulled up to a point
              const ang = t * Math.PI / 2;
              const ax = Math.cos(ang), ay = R.arch === 2 ? Math.pow(Math.sin(ang), 0.72) : Math.sin(ang);
              const cur = P(sc + side * rad * ax, yS + rise * ay);
              this.tri(corner, prev, cur, nx, 0, nz);
              prev = cur;
            }
          }
        }
      }
      band(sAt, L, ya, yb);
      yAt = yb;
    }
    band(0, L, yAt, y1);
  }

  /**
   * Walls right round a footprint ring, facing outward (inward for a courtyard
   * hole). `spec(edge)` may return a wallGrid spec for an edge {i, len, nx, nz},
   * null for a blank wall, or false to leave the edge open.
   */
  ringWalls(ring, y0, y1, spec = null, hole = false) {
    const S = (ringArea(ring) > 0 ? 1 : -1) * (hole ? -1 : 1);
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
      if (L < 0.02) continue;
      const nx = S * ez / L, nz = -S * ex / L;
      const sp = spec ? spec({ i, len: L, nx, nz, a, b }) : null;
      if (sp === false) continue;                        // an edge that is no wall at all
      if (sp) this.wallGrid(a, b, y0, y1, nx, nz, sp);
      else this.wall(a, b, y0, y1, nx, nz);
    }
  }

  /** A flat lid over a ring (with holes) at height y, facing up or down. */
  cap(ring, holes, y, up = true) {
    const o = ring.map((p) => new THREE.Vector2(p[0], p[1]));
    const hs = (holes ?? []).filter((h) => h.length >= 3).map((h) => h.map((p) => new THREE.Vector2(p[0], p[1])));
    // triangulateShape wants the outline one way and the holes the other
    if (THREE.ShapeUtils.isClockWise(o)) o.reverse();
    for (const h of hs) if (!THREE.ShapeUtils.isClockWise(h)) h.reverse();
    const faces = THREE.ShapeUtils.triangulateShape(o, hs);
    const all = o.concat(...hs);
    for (const [i, j, k] of faces)
      this.tri([all[i].x, y, all[i].y], [all[j].x, y, all[j].y], [all[k].x, y, all[k].y], 0, up ? 1 : -1, 0);
  }

  /** A ring pushed in (d > 0) or out by d metres, mitred. Convex-ish rings only. */
  offsetRing(ring, d) {
    const S = ringArea(ring) > 0 ? 1 : -1, n = ring.length, out = [];
    for (let i = 0; i < n; i++) {
      const p = ring[(i + n - 1) % n], c = ring[i], q = ring[(i + 1) % n];
      let ax = c[0] - p[0], az = c[1] - p[1], bx = q[0] - c[0], bz = q[1] - c[1];
      const la = Math.hypot(ax, az) || 1, lb = Math.hypot(bx, bz) || 1;
      ax /= la; az /= la; bx /= lb; bz /= lb;
      // inward normals of the two edges, and the mitre along their bisector
      const n1x = -S * az, n1z = S * ax, n2x = -S * bz, n2z = S * bx;
      let mx = n1x + n2x, mz = n1z + n2z;
      const ml = Math.hypot(mx, mz);
      if (ml < 1e-6) { out.push([c[0] + n1x * d, c[1] + n1z * d]); continue; }
      mx /= ml; mz /= ml;
      const k = Math.min(3, 1 / Math.max(0.3, mx * n1x + mz * n1z));
      out.push([c[0] + mx * d * k, c[1] + mz * d * k]);
    }
    return out;
  }

  /**
   * A surface of revolution about a vertical axis: spires, drums, cupolas,
   * onion domes, columns. Flat facets, n sides.
   * @param {number[][]} prof [[radius, y], ...] from the bottom up; radius 0 closes to a point
   */
  lathe(cx, cz, prof, n = 8, phase = 0, sx = 1, sz = 1) {
    const ring = (r, y) => {
      const out = [];
      for (let i = 0; i < n; i++) {
        const a = phase + i * 2 * Math.PI / n;
        out.push([cx + Math.cos(a) * r * sx, y, cz + Math.sin(a) * r * sz]);
      }
      return out;
    };
    for (let j = 0; j + 1 < prof.length; j++) {
      const [r0, y0] = prof[j], [r1, y1] = prof[j + 1];
      if (r0 < 1e-6 && r1 < 1e-6) continue;
      const A = ring(r0, y0), B = ring(r1, y1);
      for (let i = 0; i < n; i++) {
        const i2 = (i + 1) % n;
        // the facet's own outward direction: its middle, away from the axis,
        // tipped up or down with the slope so a flat ring still gets a facing
        const mx = (A[i][0] + A[i2][0] + B[i][0] + B[i2][0]) / 4 - cx;
        const mz = (A[i][2] + A[i2][2] + B[i][2] + B[i2][2]) / 4 - cz;
        const ml = Math.hypot(mx, mz) || 1;
        const run = r0 - r1, rise = y1 - y0;
        const fy = Math.abs(rise) < 1e-6 ? (run > 0 ? 1 : -1) : run / Math.abs(rise) * 0.999;
        const fx = Math.abs(rise) < 1e-6 ? 0 : mx / ml, fz = Math.abs(rise) < 1e-6 ? 0 : mz / ml;
        if (r1 < 1e-6) this.tri(A[i], A[i2], B[i], fx, fy, fz);
        else if (r0 < 1e-6) this.tri(A[i], B[i2], B[i], fx, fy, fz);
        else this.quad(A[i], A[i2], B[i2], B[i], fx, fy, fz);
      }
    }
  }
}
