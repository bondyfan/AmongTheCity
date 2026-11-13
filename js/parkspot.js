// ---- where a parked car may stand ----------------------------------------------
// main.js used to drop its parked cars on fixed offsets from the spawn and on
// the centroid of every nearby parking polygon, at a hashed heading, and then
// ask world.collide() to nudge a 1.2 m disc out of any wall. A car is not a
// 1.2 m disc: the first car a new player is sent to ("get into the marked car")
// stood with its nose inside the Hello! kiosk on the station forecourt, hidden
// from the opening camera by the kiosk itself, and a centroid is as likely to
// be a tree or a lamp as a parking bay.
//
// This module answers the question properly, as a pure function of the map:
// the car's whole FOOTPRINT has to be clear of buildings, fences, water, mapped
// trees and street furniture, and of every carriageway (a parked car in a lane
// is a jam with the traffic queued behind it). A spot that is not clear is
// turned and nudged, in a fixed order, until it is; one that cannot be cleared
// gets no car. Nothing here reads the terrain, the camera or a random number,
// so two clients park the same cars in the same places.
//
// No three.js and no DOM: it walks `city.chunkIndex` only (tests/parkspot).

import { CHUNK } from './config.js';
import { strHash } from './identity.js';

const CAR_LEN = 5.0, CAR_WID = 1.9;      // the footprint tested: a van's, so any kind fits
const PROP_R = 0.75;                     // m a bench, bin, tree trunk or sign keeps a car's side off
const SHELTER_R = 2.6;                   // …and a bus shelter
const WALL_GAP = 0.35;                   // m between a bumper and a wall
const LANE_GAP = 0.3;                    // m between a flank and the edge of a carriageway

function inPoly(x, z, o) {
  let inside = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const xi = o[i][0], zi = o[i][1], xj = o[j][0], zj = o[j][1];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
function segDist(x, z, ax, az, bx, bz) {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  let t = ((x - ax) * ex + (z - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + ex * t), z - (az + ez * t));
}

/**
 * Is a car `len` by `wid`, centred on (x, z) and facing game heading `h`
 * (forward is (-sin h, -cos h)), clear of everything the map says is solid
 * and of every carriageway? `opts.lanes: false` lets it stand on asphalt.
 */
export function footprintClear(city, x, z, h, len = CAR_LEN, wid = CAR_WID, opts = null) {
  const idx = city?.chunkIndex;
  if (!idx) return true;
  const fx = -Math.sin(h), fz = -Math.cos(h), rx = -fz, rz = fx;
  const hl = len / 2, hw = wid / 2;
  // the point (px, pz) in the car's own frame: [along, across]
  const along = (px, pz) => (px - x) * fx + (pz - z) * fz;
  const across = (px, pz) => (px - x) * rx + (pz - z) * rz;
  const within = (px, pz, m) => Math.abs(along(px, pz)) < hl + m && Math.abs(across(px, pz)) < hw + m;
  // the footprint as a lattice of points half a metre apart, edges included
  const pts = [];
  const na = Math.ceil(len / 0.5), nw = Math.ceil(wid / 0.5);
  for (let i = 0; i <= na; i++) for (let j = 0; j <= nw; j++) {
    const a = -hl + (len * i) / na, c = -hw + (wid * j) / nw;
    pts.push(x + fx * a + rx * c, z + fz * a + rz * c);
  }
  const R = hl + 3;
  const c0 = Math.floor((x - R) / CHUNK), c1 = Math.floor((x + R) / CHUNK);
  const d0 = Math.floor((z - R) / CHUNK), d1 = Math.floor((z + R) / CHUNK);
  const seen = new Set();
  for (let ci = c0; ci <= c1; ci++) for (let cj = d0; cj <= d1; cj++) {
    const cell = idx.get(ci + ',' + cj);
    if (!cell) continue;
    for (const b of cell.buildings ?? []) {
      if (seen.has(b) || !b.o || b.y > 0.5) continue;      // (an arch overhead is not in the way)
      seen.add(b);
      for (let i = 0; i < pts.length; i += 2) if (inPoly(pts[i], pts[i + 1], b.o)) return false;
      // …and no wall through it or within a hand of it (a thin kiosk between two lattice points)
      for (let i = 0, j = b.o.length - 1; i < b.o.length; j = i++) {
        const ax = b.o[j][0], az = b.o[j][1], bx = b.o[i][0], bz = b.o[i][1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
        for (let k = 0; k <= n; k++) if (within(ax + (bx - ax) * k / n, az + (bz - az) * k / n, WALL_GAP)) return false;
      }
    }
    for (const w of cell.water ?? []) {
      if (seen.has(w) || !w.o) continue;
      seen.add(w);
      for (let i = 0; i < pts.length; i += 2) if (inPoly(pts[i], pts[i + 1], w.o)) return false;
    }
    for (const f of cell.barriers ?? []) {
      if (seen.has(f) || !f.p) continue;
      seen.add(f);
      for (let i = 1; i < f.p.length; i++) {
        const ax = f.p[i - 1][0], az = f.p[i - 1][1], bx = f.p[i][0], bz = f.p[i][1];
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
        for (let k = 0; k <= n; k++) if (within(ax + (bx - ax) * k / n, az + (bz - az) * k / n, 0.2)) return false;
      }
    }
    for (const f of cell.furniture ?? []) {
      const q = f.p?.[0];
      if (q && within(q[0], q[1], PROP_R)) return false;
    }
    for (const t of cell.trees ?? []) {
      const q = t.p ? t.p[0] : t;
      if (q && within(q[0], q[1], PROP_R)) return false;
    }
    for (const s of cell.signs ?? []) {
      const q = s.p ? (Array.isArray(s.p[0]) ? s.p[0] : s.p) : null;
      if (q && within(q[0], q[1], PROP_R)) return false;
    }
    if (opts?.lanes !== false) {
      for (const r of cell.roads ?? []) {
        if (seen.has(r) || !r.p || r.br) continue;
        seen.add(r);
        // a carriageway, or a path people walk: neither is a parking space
        const reach = (r.w ?? (r.d === 1 ? 6 : 2)) / 2 + (r.d === 1 ? LANE_GAP : 0);
        for (let s = 1; s < r.p.length; s++) {
          const ax = r.p[s - 1][0], az = r.p[s - 1][1], bx = r.p[s][0], bz = r.p[s][1];
          if (segDist(x, z, ax, az, bx, bz) > reach + hl + 0.5) continue;
          for (let i = 0; i < pts.length; i += 2) if (segDist(pts[i], pts[i + 1], ax, az, bx, bz) < reach) return false;
        }
      }
    }
  }
  for (const q of city.pois ?? []) {
    if (q.t !== 'bus_stop' || !q.p) continue;
    if (within(q.p[0], q.p[1], SHELTER_R)) return false;
  }
  return true;
}

// the nudges tried, in order: turned on the spot first, then moved out in rings
const TURNS = [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4];
const RINGS = [1.5, 3, 4.5, 6, 8];

/**
 * The clear footprint nearest (x, z, h): { x, z, h }, or null when the car has
 * to be left out. Deterministic: the same candidates in the same order.
 */
export function clearSpot(city, x, z, h, len = CAR_LEN, wid = CAR_WID, opts = null) {
  for (const t of TURNS) if (footprintClear(city, x, z, h + t, len, wid, opts)) return { x, z, h: h + t };
  for (const r of RINGS) {
    for (let a = 0; a < 8; a++) {
      const px = x + Math.cos(a * Math.PI / 4) * r, pz = z + Math.sin(a * Math.PI / 4) * r;
      for (const t of TURNS) if (footprintClear(city, px, pz, h + t, len, wid, opts)) return { x: px, z: pz, h: h + t };
    }
  }
  return null;
}

// deterministic 0..1 from a world position plus a salt (main.js spotRnd, same quantisation)
const spotRnd = (x, z, salt) => strHash(salt + ':' + Math.round(x * 10) + ',' + Math.round(z * 10)) / 4294967296;

// THE FIRST CAR. The introduction's first objective is "get into the marked
// car", so it stands where the opening camera shows it: a few steps to the
// right of the player, on the paving between the kiosks' footway and the
// forecourt lane, nose east along that lane (which is one way, eastbound, and
// empty in front of it). Offsets from the spawn point, and a game heading.
export const FIRST_CAR = { dx: -5, dz: 0.65, h: -Math.PI / 2 };
const SECOND_CAR = { dx: -14, dz: 12, h: 1.9 };

/**
 * Every car main.js parks at boot: the two by the spawn and one in each of the
 * eight nearest car parks, each on a clear footprint. Returns
 * [{ x, z, h, kx, kz }]; (kx, kz) is the spot as the map gave it, which is
 * what the car's kind and colour are hashed from, so a nudge does not repaint it.
 */
export function parkSpots(city, spawn) {
  const want = [
    [spawn.x + FIRST_CAR.dx, spawn.z + FIRST_CAR.dz, FIRST_CAR.h],
    [spawn.x + SECOND_CAR.dx, spawn.z + SECOND_CAR.dz, SECOND_CAR.h],
  ];
  const lots = [];
  for (const p of city.paved ?? []) {
    if (p.t !== 'parking' || !p.o?.length) continue;
    let cx = 0, cz = 0;
    for (const [x, z] of p.o) { cx += x; cz += z; }
    cx /= p.o.length; cz /= p.o.length;
    if (Math.hypot(cx - spawn.x, cz - spawn.z) > 260) continue;
    lots.push([cx, cz]);
  }
  // sorted by position before the cap, so the cut-off is a fact about the map
  // and not about the order the tiles arrived in
  lots.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (const [cx, cz] of lots.slice(0, 8)) want.push([cx, cz, spotRnd(cx, cz, 'h') * Math.PI * 2]);
  const out = [];
  for (const [x, z, h] of want) {
    // a car park is asphalt, some of it mapped as aisles: there a car may stand on a lane
    const s = clearSpot(city, x, z, h) ?? (out.length >= 2 ? clearSpot(city, x, z, h, CAR_LEN, CAR_WID, { lanes: false }) : null);
    if (!s) continue;
    // …and not on top of one already placed
    if (out.some((o) => Math.hypot(o.x - s.x, o.z - s.z) < 5.5)) continue;
    out.push({ x: s.x, z: s.z, h: s.h, kx: x, kz: z });
  }
  return out;
}
