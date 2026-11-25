// ---- street names on the HUD disc ------------------------------------------------
// Roads carry `n` on every named street (~23 % of the ways; the rest are
// service aisles and footpaths). A name is only worth ink if it fits ALONG
// the road it names, so the whole feature is one question asked per road:
// what is the longest straight, VISIBLE run of this polyline, and is the name
// narrower than that run is long on screen? If it is not, the road stays
// anonymous: a name spilling past its own street points at the wrong street.
//
// The class list stops at `residential`: a disc has room for about four
// names, and one spent on a parking aisle is one not spent on the street you
// are driving down. The rank doubles as the draw priority.
//
// The disc now turns with the camera, so the scan keeps each run's WORLD
// angle and the draw adds the map's rotation, then flips the text the right
// way up. Picking the names is gated on real movement (or a real zoom step):
// a set that reshuffled every frame would flicker, and a name that flickers
// is unreadable.
//
// A name is drawn as a SPRITE: rendered once, upright, into a small canvas,
// and then only turned with drawImage. Text drawn straight onto a disc that
// turns every frame is rasterised again every frame (the glyph cache is keyed
// by angle), and four outlined names cost about a millisecond of frame time,
// more than the rest of the disc together (measured in the game, A/B).

import { forEachChunkInRadius } from './geo.js';

const ST_RANK = {
  motorway: 0, trunk: 0, primary: 1, secondary: 1,
  tertiary: 2, unclassified: 3, residential: 3,
};
const ST_MAX = 4;        // names drawn per frame
const ST_CAND = 16;      // candidates the scan keeps, best first
const ST_SCAN_M = 10;    // player travel (m) that re-runs the scan
const ST_ZOOM = 0.08;    // …or this relative change of the view radius
const ST_CHUNK_R = 2;    // chunk rings scanned: ≥ 240 m each way
const ST_TURN = 0.28;    // rad a run may bend and still be laid out as one chord
const ST_PAD = 5;        // px of road demanded past each end of the name
const ST_RANK_M = 120;   // metres of "importance" one class rank is worth
const ST_VIEW_K = 0.94;  // names keep this far off the rim (chrome lives there)
const SPRITES_MAX = 48;  // name sprites kept (a disc shows four at a time)
const TAU = Math.PI * 2;

// Segment A→B clipped to a circle, as the parameter range that survives.
const _clip = { t0: 0, t1: 0 };
export function clipCircle(ax, az, bx, bz, cx, cz, r) {
  const dx = bx - ax, dz = bz - az;
  const A = dx * dx + dz * dz;
  if (A < 1e-9) return false;
  const fx = ax - cx, fz = az - cz;
  const B = 2 * (fx * dx + fz * dz);
  const C = fx * fx + fz * fz - r * r;
  const disc = B * B - 4 * A * C;
  if (disc <= 0) return false;
  const sd = Math.sqrt(disc), inv = 0.5 / A;
  let t0 = (-B - sd) * inv, t1 = (-B + sd) * inv;
  if (t0 < 0) t0 = 0;
  if (t1 > 1) t1 = 1;
  if (t1 <= t0) return false;
  _clip.t0 = t0; _clip.t1 = t1;
  return true;
}

/** Text angle on screen for a road at world angle `a` on a map turned by
 *  `rot`: the same line, never upside down (result within ±π/2). */
export function uprightAngle(a, rot) {
  let t = a + rot;
  t -= TAU * Math.floor((t + Math.PI) / TAU);   // → [−π, π)
  if (t > Math.PI / 2) t -= Math.PI;
  else if (t < -Math.PI / 2) t += Math.PI;
  return t;
}

export class StreetLabels {
  constructor(city) {
    this.city = city;
    this._n = 0;
    this._road = new Array(ST_CAND).fill(null);
    this._st = new Float64Array(ST_CAND * 4);   // mx, mz, world angle, visible metres
    this._score = new Float64Array(ST_CAND);
    this._stamp = 0;
    this._x = 1e9; this._z = 1e9; this._r = 0;
    this._box = new Float64Array((ST_MAX + 1) * 4);
    this._drawn = new Array(ST_MAX).fill('');
    this._cell = (key) => this._scanCell(key);
    this._sprites = new Map();                  // font + name → { cv, w, h }
  }

  // The name as an upright sprite in `font`: a dark outline and a light fill,
  // rendered once. w is the text's own width (what has to fit the street).
  _sprite(name, font, fs, g) {
    const key = font + '|' + name;
    let sp = this._sprites.get(key);
    if (sp) return sp;
    const doc = typeof document !== 'undefined' ? document : null;
    if (!doc) return null;
    g.font = font;
    const w = g.measureText(name).width;
    const pad = Math.ceil(fs * 0.3) + 2;
    const cv = doc.createElement('canvas');
    cv.width = Math.ceil(w + pad * 2);
    cv.height = Math.ceil(fs * 1.5 + pad);
    const c = cv.getContext('2d');
    c.font = font;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.lineJoin = 'round';
    c.lineWidth = Math.max(2.5, fs * 0.32);
    c.strokeStyle = 'rgba(8,11,16,0.9)';
    c.strokeText(name, cv.width / 2, cv.height / 2);
    c.fillStyle = '#e8edf5';
    c.fillText(name, cv.width / 2, cv.height / 2);
    sp = { cv, w, hw: cv.width / 2, hh: cv.height / 2 };
    if (this._sprites.size >= SPRITES_MAX) this._sprites.delete(this._sprites.keys().next().value);
    this._sprites.set(key, sp);
    return sp;
  }

  /** Forget the candidates (the data under them changed). */
  reset() { this._x = 1e9; }

  /** Re-pick the streets worth naming, if the player moved or zoomed enough. */
  scan(px, pz, viewR) {
    const dx = px - this._x, dz = pz - this._z;
    if (dx * dx + dz * dz <= ST_SCAN_M * ST_SCAN_M && Math.abs(viewR - this._r) <= this._r * ST_ZOOM) return;
    this._n = 0;
    this._x = px; this._z = pz; this._r = viewR;
    if (!this.city?.chunkIndex) return;
    this._stamp++;
    forEachChunkInRadius(px, pz, ST_CHUNK_R, this._cell);
  }

  _scanCell(key) {
    const cell = this.city.chunkIndex.get(key);
    if (!cell) return;
    const stamp = this._stamp;
    for (const f of cell.roads) {
      if (!f.n || f._mmSt === stamp) continue;
      f._mmSt = stamp;
      const rank = ST_RANK[f.t];
      if (rank === undefined) continue;
      this._consider(f, rank);
    }
  }

  // The best placement for ONE road: the longest straight run of its polyline,
  // clipped to the view circle (OSM chops a street at every driveway, so one
  // segment alone would fit almost nothing).
  _consider(f, rank) {
    const p = f.p, n = p.length;
    if (n < 2) return;
    const px = this._x, pz = this._z, r = this._r * ST_VIEW_K;
    let bestL = 0, bmx = 0, bmz = 0, bang = 0;
    for (let i = 0; i < n - 1;) {
      const ax = p[i][0], az = p[i][1];
      const a0 = Math.atan2(p[i + 1][1] - az, p[i + 1][0] - ax);
      let j = i + 1;
      while (j < n - 1) {
        let d = Math.atan2(p[j + 1][1] - p[j][1], p[j + 1][0] - p[j][0]) - a0;
        if (d > Math.PI) d -= TAU; else if (d < -Math.PI) d += TAU;
        if (d > ST_TURN || d < -ST_TURN) break;
        j++;
      }
      const bx = p[j][0], bz = p[j][1];
      if (clipCircle(ax, az, bx, bz, px, pz, r)) {
        const dx = bx - ax, dz = bz - az;
        const L = Math.sqrt(dx * dx + dz * dz) * (_clip.t1 - _clip.t0);
        if (L > bestL) {
          bestL = L;
          const t = (_clip.t0 + _clip.t1) / 2;
          bmx = ax + dx * t; bmz = az + dz * t;
          bang = Math.atan2(dz, dx);
        }
      }
      i = j > i + 1 ? j : i + 1;
    }
    if (bestL <= 0) return;
    const score = bestL + (3 - rank) * ST_RANK_M;
    const cand = this._st, sc = this._score;
    let at = this._n;
    if (at >= ST_CAND) { if (score <= sc[ST_CAND - 1]) return; at = ST_CAND - 1; }
    else this._n++;
    while (at > 0 && sc[at - 1] < score) {
      sc[at] = sc[at - 1];
      this._road[at] = this._road[at - 1];
      for (let q = 0; q < 4; q++) cand[at * 4 + q] = cand[at * 4 - 4 + q];
      at--;
    }
    sc[at] = score;
    this._road[at] = f;
    cand[at * 4] = bmx; cand[at * 4 + 1] = bmz;
    cand[at * 4 + 2] = bang; cand[at * 4 + 3] = bestL;
  }

  /**
   * Lay the surviving names along their streets. T is the disc's transform
   * ({ cx, cy, k, c, s, ox, oz, rot }); `keep` is a box (half size, px) around
   * the centre that no name may cover: the player's arrow. `clipped`: the
   * caller already holds the disc clip.
   */
  draw(g, T, R, font, fs, keep, clipped = false) {
    if (!this._n) return;
    const st = this._st, boxes = this._box, drawn = this._drawn;
    const hh = fs * 0.62, rim = R - 3;
    // the arrow's box goes in first, as if it were a name already placed
    boxes[0] = T.cx - keep; boxes[1] = T.cy - keep; boxes[2] = T.cx + keep; boxes[3] = T.cy + keep;
    let nb = 1, n = 0;
    if (!clipped) {
      g.save();
      g.beginPath();
      g.arc(T.cx, T.cy, R, 0, TAU);
      g.clip();
    }
    for (let i = 0; i < this._n && n < ST_MAX; i++) {
      const f = this._road[i], b = i * 4;
      const sp = this._sprite(f.n, font, fs, g);
      if (!sp) continue;
      const w = sp.w;
      if (w + ST_PAD * 2 > st[b + 3] * T.k) continue;
      let dup = false;
      for (let q = 0; q < n; q++) if (drawn[q] === f.n) { dup = true; break; }
      if (dup) continue;
      const rx = st[b] - T.ox, rz = st[b + 1] - T.oz;
      const sx = T.cx + (rx * T.c - rz * T.s) * T.k, sy = T.cy + (rx * T.s + rz * T.c) * T.k;
      const ang = uprightAngle(st[b + 2], T.rot), ca = Math.cos(ang), sa = Math.sin(ang);
      const ex = Math.abs(ca) * w / 2 + Math.abs(sa) * hh;
      const ey = Math.abs(sa) * w / 2 + Math.abs(ca) * hh;
      const fx = Math.abs(sx - T.cx) + ex, fy = Math.abs(sy - T.cy) + ey;
      if (fx * fx + fy * fy > rim * rim) continue;
      let hit = false;
      for (let q = 0, e = nb * 4; q < e; q += 4)
        if (sx - ex < boxes[q + 2] && sx + ex > boxes[q]
          && sy - ey < boxes[q + 3] && sy + ey > boxes[q + 1]) { hit = true; break; }
      if (hit) continue;
      boxes[nb * 4] = sx - ex; boxes[nb * 4 + 1] = sy - ey;
      boxes[nb * 4 + 2] = sx + ex; boxes[nb * 4 + 3] = sy + ey;
      nb++;
      drawn[n++] = f.n;
      g.save();
      g.translate(sx, sy);
      g.rotate(ang);
      g.drawImage(sp.cv, -sp.hw, -sp.hh);
      g.restore();
    }
    if (!clipped) g.restore();
  }
}
