// ---- kerbclear.js: what stands where a kerb-parked car would ---------------------
// The two questions js/kerbparking.js asks of the map before it calls a stretch
// of kerb a stall. Pure in the chunk index: no world, no meshes.
//
//   obstructed        the procedural row: a car parallel to the kerb, two
//                     wheels up. A zebra, a mapped footway anywhere near, a
//                     tree, a bench, another carriageway
//   footprintBlocked  a row the map tagged, in whatever orientation: the same
//                     things under the car's whole rectangle, and houses and
//                     fences as well, since a car square to the kerb reaches
//                     four metres past it

import { pointInPolygon } from './geo.js';
import { coveredBy } from './streets.js';
import { PARALLEL } from './kerbrows.js';

const CH = 120;                 // chunk size (config.CHUNK)
const FOOT = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway']);

function ptSeg(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  let t = ((x - ax) * ex + (z - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + ex * t), z - (az + ez * t));
}

// anything standing where the car would: a zebra, a mapped footway, a tree,
// a bench, another carriageway (a driveway that joins without a node)
export function obstructed(city, r, x, z, dx, dz) {
  for (let ci = Math.floor((x - 8) / CH); ci <= Math.floor((x + 8) / CH); ci++) {
    for (let cj = Math.floor((z - 8) / CH); cj <= Math.floor((z + 8) / CH); cj++) {
      const cell = city.chunkIndex?.get(ci + ',' + cj);
      if (!cell) continue;
      for (const c of cell.crossings ?? []) {
        const q = c.p[0];
        if (Math.abs((q[0] - x) * dx + (q[1] - z) * dz) < 7 && Math.hypot(q[0] - x, q[1] - z) < 12) return true;
      }
      for (const t of cell.trees ?? []) {
        const q = t.p ? t.p[0] : t;
        if (Math.hypot(q[0] - x, q[1] - z) < 2.9 && Math.abs((q[0] - x) * dz - (q[1] - z) * dx) < 1.4) return true;
      }
      for (const f of cell.furniture ?? []) {
        const q = f.p[0];
        if (Math.hypot(q[0] - x, q[1] - z) < 2.9 && Math.abs((q[0] - x) * dz - (q[1] - z) * dx) < 1.4) return true;
      }
      for (const o of cell.roads ?? []) {
        if (o === r || o.d || !FOOT.has(o.t) || !o.p) continue;
        for (let i = 0; i < o.p.length - 1; i++) {
          for (const k of [-2, 0, 2]) {
            if (ptSeg(x + dx * k, z + dz * k, o.p[i][0], o.p[i][1], o.p[i + 1][0], o.p[i + 1][1]) < 2.1) return true;
          }
        }
      }
    }
  }
  for (const k of [-2.2, 0, 2.2]) if (coveredBy(city, x + dx * k, z + dz * k, r, 1.3)) return true;
  return false;
}

// ---- what a car that reaches over the verge may not stand in ---------------------
// A parallel car two wheels up never gets past the pavement. One parked square
// to the kerb reaches four metres beyond it, where the map may hold a house, a
// fence, a tree or the footway itself. (Bounding boxes in a WeakMap: see the
// header on why nothing is hung on a feature.)
const _bb = new WeakMap();
function bbOf(f, pts) {
  let b = _bb.get(f);
  if (b) return b;
  b = [1e9, 1e9, -1e9, -1e9];
  for (const q of pts) { if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[0] > b[2]) b[2] = q[0]; if (q[1] > b[3]) b[3] = q[1]; }
  _bb.set(f, b);
  return b;
}
// (7 x 3 points over the car: no two further apart than the 0.55 m a footway is asked at)
const _probe = new Float64Array(42);
const ROWS = [-1, -2 / 3, -1 / 3, 0, 1 / 3, 2 / 3, 1];
export function footprintBlocked(city, r, x, z, fx, fz, kx, kz, P) {
  const o = P.orient === PARALLEL, hl = (o ? P.along : P.across) - 0.15, hwd = (o ? P.across : P.along) - 0.25;
  let n = 0, x0 = 1e9, z0 = 1e9, x1 = -1e9, z1 = -1e9;
  for (const a of ROWS) for (let b = -1; b <= 1; b++) {
    const qx = x + fx * a * hl - fz * b * hwd, qz = z + fz * a * hl + fx * b * hwd;
    _probe[n++] = qx; _probe[n++] = qz;
    if (qx < x0) x0 = qx; if (qx > x1) x1 = qx; if (qz < z0) z0 = qz; if (qz > z1) z1 = qz;
  }
  const near = (qx, qz, d) => { for (let i = 0; i < n; i += 2) if (Math.hypot(_probe[i] - qx, _probe[i + 1] - qz) < d) return true; return false; };
  const line = (pts, d) => {
    for (let i = 0; i < pts.length - 1; i++) for (let k = 0; k < n; k += 2) {
      if (ptSeg(_probe[k], _probe[k + 1], pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]) < d) return true;
    }
    return false;
  };
  for (let ci = Math.floor((x0 - 3) / CH); ci <= Math.floor((x1 + 3) / CH); ci++) {
    for (let cj = Math.floor((z0 - 3) / CH); cj <= Math.floor((z1 + 3) / CH); cj++) {
      const cell = city.chunkIndex?.get(ci + ',' + cj);
      if (!cell) continue;
      for (const c of cell.crossings ?? []) {
        const q = c.p[0];
        if (Math.abs((q[0] - x) * kx + (q[1] - z) * kz) < 4.6 + P.along && Math.hypot(q[0] - x, q[1] - z) < 12) return true;
      }
      for (const t of cell.trees ?? []) { const q = t.p ? t.p[0] : t; if (near(q[0], q[1], 1.25)) return true; }
      for (const f of cell.furniture ?? []) if (near(f.p[0][0], f.p[0][1], 1.25)) return true;
      for (const b of cell.buildings ?? []) {
        if (!b.o) continue;
        const bb = bbOf(b, b.o);
        if (x1 < bb[0] - 0.6 || x0 > bb[2] + 0.6 || z1 < bb[1] - 0.6 || z0 > bb[3] + 0.6) continue;
        for (let i = 0; i < n; i += 2) if (pointInPolygon(_probe[i], _probe[i + 1], b.o)) return true;
        if (line([...b.o, b.o[0]], 0.6)) return true;
      }
      for (const w of cell.barriers ?? []) {
        if (!w.p || w.p.length < 2) continue;
        const bb = bbOf(w, w.p);
        if (x1 < bb[0] - 0.8 || x0 > bb[2] + 0.8 || z1 < bb[1] - 0.8 || z0 > bb[3] + 0.8) continue;
        if (line(w.p, 0.8)) return true;
      }
      for (const w of cell.roads ?? []) {
        if (w === r || w.d || !FOOT.has(w.t) || !w.p) continue;
        // A footway UNDER the car, that is: one that crosses the street here, or
        // lies where the car reaches. The mapped pavement that runs along a
        // tagged street a metre and a half behind the kerb is not in the way
        // of a car two wheels up, and those are the very streets that carry
        // parking tags (the procedural row keeps its wider berth).
        const bb = bbOf(w, w.p);
        if (x1 < bb[0] - 0.55 || x0 > bb[2] + 0.55 || z1 < bb[1] - 0.55 || z0 > bb[3] + 0.55) continue;
        if (line(w.p, 0.55)) return true;
      }
    }
  }
  for (let i = 0; i < n; i += 2) if (coveredBy(city, _probe[i], _probe[i + 1], r, 0.5)) return true;
  return false;
}
