// ---- what colour is this roof, according to the aerial photograph ------------
// OSM has roof:colour on 11 000 of two million buildings. The ČÚZK ortofoto has
// every roof in the country, and scripts/classify-ground.mjs already keeps the
// part of it that covers Pardubice and a strip of Prague on disk: 1200 px PNGs
// of 2400 m, one per tile quadrant, data/raw-ortho/<tx>_<tz>_<qx><qz>.png.
// This asks each of those photographs one question per building, offline, and
// writes the answer into the tile as `rp`. The game ships no photograph for it.
//
// GEOREFERENCE (the same arithmetic as classify-ground.mjs fetchQuadrant, which
// requested the images): quadrant (qx, qz) of tile (tx, tz) starts at
//   x0 = tx * 4800 + qx * 2400,  z0 = tz * 4800 + qz * 2400
// and its pixel (i, j) covers x0 + 2i .. x0 + 2i + 2 east and z0 + 2j .. + 2
// SOUTH: row 0 is the northern edge, because +z is south and a WMS image has
// north up. The game frame is linear in longitude and latitude and so is the
// CRS:84 request, so this is exact, not an approximation.
//
// THE STATISTIC. At 2 m to the pixel a family house is some thirty pixels, of which
// the rim is half wall, half garden, and the far pitch is in its own shade. So:
//   1. only pixels whose CENTRE is inside the footprint and at least 1.5 m from
//      every wall count (a whole pixel of roof); a small building relaxes that
//      to 0.7 m and then to "inside at all", and one with under two pixels gets
//      no answer rather than its neighbour's lawn;
//   2. a tree hanging over the roof is green in the way no roofing is (excess
//      green, 2G - R - B), and is dropped unless that would drop nearly all;
//   3. of what is left the darkest 30 % (the shaded pitch, chimney and dormer
//      shadows) and the brightest 5 % (skylights, glare off metal) are cut, and
//      the answer is the per-channel MEDIAN of the rest. A median does not
//      invent a colour that is on no pixel, which a mean of a red pitch and a
//      grey one does;
//   4. an answer that is STILL leaf green is a tree, not a roof: no answer.

import { existsSync, readFileSync } from 'node:fs';

const TILE = 4800, SPAN = 2400, PX = 1200, M = SPAN / PX;   // 2 m per pixel
// green the way foliage and lawn are and no roofing is: excess green, 2G - R - B
const isLeaf = (r, g, b) => 2 * g - r - b > 18 && g > r;

export class RoofPhoto {
  /** @param dir data/raw-ortho  @param decodePNG scripts/lib/png.mjs */
  constructor(dir, decodePNG) {
    this.dir = dir; this.decode = decodePNG;
    this.cache = new Map();
    this.sampled = 0; this.tried = 0;
  }

  /** The quadrant image holding global pixel (gi, gj), or null where no photo is on disk. */
  _quad(gi, gj) {
    const qi = Math.floor(gi / PX), qj = Math.floor(gj / PX);
    const k = qi + ',' + qj;
    let q = this.cache.get(k);
    if (q !== undefined) return q;
    const tx = Math.floor(qi / 2), tz = Math.floor(qj / 2);
    const file = `${this.dir}/${tx}_${tz}_${qi - tx * 2}${qj - tz * 2}.png`;
    q = null;
    if (existsSync(file)) {
      const img = this.decode(readFileSync(file));
      if (img.w === PX && img.h === PX) q = { rgb: img.rgb, i0: qi * PX, j0: qj * PX };
    }
    this.cache.set(k, q);
    return q;
  }

  /** Is any of this tile photographed? (cheap: decides whether to try its buildings at all) */
  covers(tx, tz) {
    for (let q = 0; q < 4; q++)
      if (existsSync(`${this.dir}/${tx}_${tz}_${q >> 1}${q & 1}.png`)) return true;
    return false;
  }

  /** RGB of the pixel over game point (x, z) as [r, g, b], or null. */
  at(x, z) {
    const gi = Math.floor(x / M), gj = Math.floor(z / M);
    const q = this._quad(gi, gj);
    if (!q) return null;
    const o = ((gj - q.j0) * PX + (gi - q.i0)) * 3;
    return [q.rgb[o], q.rgb[o + 1], q.rgb[o + 2]];
  }

  /**
   * The roof colour of a footprint: outer ring `o` and hole rings `holes` in
   * game metres. '#rrggbb' or null (no photo there, or too small to read).
   * `dx, dz` shift the footprint over the photo, for the registration check.
   */
  sample(o, holes, dx = 0, dz = 0) {
    this.tried++;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of o) {
      if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
      if (p[1] < z0) z0 = p[1]; if (p[1] > z1) z1 = p[1];
    }
    const i0 = Math.floor((x0 + dx) / M), i1 = Math.floor((x1 + dx) / M);
    const j0 = Math.floor((z0 + dz) / M), j1 = Math.floor((z1 + dz) / M);
    // most of the world has no photograph: say so before any geometry is done
    if (!this._quad(i0, j0) && !this._quad(i1, j0) && !this._quad(i0, j1) && !this._quad(i1, j1)) return null;
    // a works hall is tens of thousands of pixels and every fourth says the same
    const step = (i1 - i0 + 1) * (j1 - j0 + 1) > 24000 ? 2 : 1;
    const rings = holes?.length ? [o, ...holes] : [o];
    const px = [];          // r, g, b, distance to the nearest wall
    for (let gj = j0; gj <= j1; gj += step) {
      const z = (gj + 0.5) * M - dz;
      for (let gi = i0; gi <= i1; gi += step) {
        const x = (gi + 0.5) * M - dx;
        // inside the outer ring and outside every hole: one even-odd pass over all rings
        let inside = false, d2 = Infinity;
        for (const ring of rings) {
          for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
            const ax = ring[a][0], az = ring[a][1], bx = ring[b][0], bz = ring[b][1];
            if ((az > z) !== (bz > z) && x < (bx - ax) * (z - az) / (bz - az) + ax) inside = !inside;
            const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez;
            let u = L2 ? ((x - ax) * ex + (z - az) * ez) / L2 : 0;
            u = u < 0 ? 0 : u > 1 ? 1 : u;
            const qx = ax + ex * u - x, qz = az + ez * u - z, q = qx * qx + qz * qz;
            if (q < d2) d2 = q;
          }
        }
        if (!inside) continue;
        const q = this._quad(gi, gj);
        if (!q) continue;
        const at = ((gj - q.j0) * PX + (gi - q.i0)) * 3;
        px.push(q.rgb[at], q.rgb[at + 1], q.rgb[at + 2], Math.sqrt(d2));
      }
    }
    const n = px.length / 4;
    if (n < 2) return null;
    // 1. the innermost ring of pixels that still leaves enough to judge by
    let keep = null;
    for (const [inset, need] of [[1.5, 8], [0.7, 4], [0, 2]]) {
      const got = [];
      for (let i = 0; i < n; i++) if (px[i * 4 + 3] >= inset) got.push(i);
      if (got.length >= need) { keep = got; break; }
    }
    if (!keep) return null;
    // 2. leaves over the roof
    const bare = keep.filter((i) => !isLeaf(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]));
    if (bare.length >= Math.max(2, keep.length * 0.3)) keep = bare;
    // 3. shade and glare
    const luma = (i) => 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    keep.sort((a, b) => luma(a) - luma(b));
    const lo = Math.floor(keep.length * 0.30), hi = Math.max(lo + 1, Math.ceil(keep.length * 0.95));
    const mid = keep.slice(lo, hi);
    const med = (c) => {
      const v = mid.map((i) => px[i * 4 + c]).sort((a, b) => a - b);
      const h = v.length >> 1;
      return v.length & 1 ? v[h] : Math.round((v[h - 1] + v[h]) / 2);
    };
    const r = med(0), g = med(1), b = med(2);
    // 4. still leaf green after all that: the crown covers the roof and the
    //    photograph never saw it. No answer beats the colour of a lime tree
    //    (measured: 498 of 28 257, nearly all sheds and garages under 80 m²,
    //    none over 1 000 m², so no real green hall loses its roof to this).
    if (isLeaf(r, g, b)) return null;
    this.sampled++;
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
}
