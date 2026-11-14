// ---- what a Czech street actually has standing on it -----------------------
// Benches, bins, the coloured recycling bells, post boxes, bike racks, bus
// shelters, wayside crosses, gates and bollards — every one of them a node
// somebody surveyed to the metre, and every one of them thrown away by the
// pipeline until now. A town without them reads as a film set between takes:
// correct geometry, nobody's life in it.
//
// Everything here writes into the chunk's shared TriSink, the same way signs
// and zebras do, so a hundred props cost no draw calls of their own. The
// shapes are built from the solids in js/propkit.js: slats, drums, bars. What
// a flat colour cannot say (glass, a poster) goes into the chunk's textured
// sink instead.
//
// The one rule that matters: props stand on what is UNDER them (the caller's
// height field answers with the pavement where there is one), and they face
// something. A bench facing away from the path is worse than no
// bench, so every prop that has a front takes its bearing from the nearest
// footway or road unless OSM gave it a direction.

import { SURF } from './surfaces.js';
import { at, box, part, drum, post, bar } from './propkit.js';
import { AD_COUNT } from './signfaces.js';
import { inLandmark, landmarkProp } from './landmarks.js';

// Colours are held as hex and unpacked through the caller's THREE.Color
// scratch, so this module needs no three.js import of its own.
const C = {
  post: 0x8a8d92,        // galvanised — lamp columns, sign posts, bollards
  postDark: 0x53575c,
  wood: 0x8a6b45,        // bench slats, picnic tables
  woodDark: 0x6d5334,
  bin: 0x3f4a3c,         // dark green municipal bin
  binLid: 0x2c3329,
  bell: [0xd8b52a, 0x2f6fbc, 0x3f8f4a, 0xc0561f],  // yellow / blue / green / orange
  post_box: 0xd77a1a,    // Česká pošta orange
  bike: 0x6f757b,
  shelter: 0x6f757b,
  glass: 0x9fb8c4,
  stone: 0x9a948a,       // crosses, memorials, statues
  stoneDark: 0x736e66,
  metal: 0x4a4d52,
  red: 0xc8332a,
  white: 0xf2f0ea,
};

/** Bearing of the nearest way in `cell`, or a fallback. Used for "facing". */
function facingOf(cell, x, z, fallback = 0) {
  let best = 40 * 40, dx = Math.sin(fallback), dz = Math.cos(fallback);
  const scan = (list) => {
    for (const r of list ?? []) {
      if (!r.p || r.p.length < 2) continue;
      for (let i = 0; i < r.p.length - 1; i++) {
        const [ax, az] = r.p[i], [bx, bz] = r.p[i + 1];
        const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
        let t = ((x - ax) * ex + (z - az) * ez) / L2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = ax + ex * t, qz = az + ez * t;
        const d2 = (x - qx) ** 2 + (z - qz) ** 2;
        if (d2 < best) {
          best = d2;
          // face TOWARD the way, not along it
          const L = Math.sqrt(d2) || 1;
          dx = (qx - x) / L; dz = (qz - z) / L;
        }
      }
    }
  };
  scan(cell?.roads);
  return Math.atan2(dx, dz);
}

// ---- the props ------------------------------------------------------------
// Each takes (sink, x, y, z, h, col, deco, rnd): `col` unpacks a hex into
// r/g/b, y is what the prop stands on, `deco` is the chunk's textured sink
// (glass, posters; may be null) and rnd(i) a deterministic 0..1 for this prop.
// They may call sink.at() to change surface class.

// THE BENCH, and the contract other code sits people on: the seat is centred
// on the mapped node (x, z), its top is SEAT_H above what the bench stands on,
// 1.8 m wide along the prop's right, and the sitter looks along the prop's
// FRONT, which is the world direction (sin h, cos h). The backrest is behind.
export const SEAT_H = 0.45;
function bench(sink, x, y, z, h, col) {
  const [wr, wg, wb] = col(C.wood);
  const [dr, dg, db] = col(C.woodDark);
  const [mr, mg, mb] = col(C.metal);
  // two cast side frames: a front leg, a back leg that carries on up as the
  // back's upright, a foot rail between them and an armrest on top
  for (const u of [-0.82, 0.82]) {
    part(sink, x, y, z, h, u, 0.2, 0.05, SEAT_H - 0.035, 0.05, mr, mg, mb);
    part(sink, x, y, z, h, u, -0.24, 0.05, 0.86, 0.05, mr, mg, mb);
    part(sink, x, y + 0.06, z, h, u, -0.02, 0.045, 0.04, 0.4, mr, mg, mb);
    part(sink, x, y + 0.63, z, h, u, 0.0, 0.055, 0.035, 0.5, mr, mg, mb);
    part(sink, x, y + SEAT_H, z, h, u, 0.2, 0.045, 0.19, 0.045, mr, mg, mb);
  }
  // the seat: four slats with daylight between them
  for (let i = 0; i < 4; i++) {
    const v = -0.15 + i * 0.118;
    part(sink, x, y + SEAT_H - 0.035, z, h, 0, v, 1.7, 0.035, 0.092, i & 1 ? dr : wr, i & 1 ? dg : wg, i & 1 ? db : wb, true);
  }
  // the back: three slats, each a little further back than the one below
  for (let i = 0; i < 3; i++) {
    part(sink, x, y + 0.55 + i * 0.115, z, h, 0, -0.215 - i * 0.022, 1.7, 0.09, 0.03, i & 1 ? dr : wr, i & 1 ? dg : wg, i & 1 ? db : wb, true);
  }
}

// The municipal bin: a ribbed drum hung on a post, under a hood that keeps the
// rain out and has the stub plate on top.
function bin(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.bin);
  const [lr, lg, lb] = col(C.binLid);
  const [pr, pg, pb] = col(C.postDark);
  const p = at(x, z, h, 0, 0.2);
  const bx = p[0], bz = p[1];
  post(sink, x, z, y, y + 1.08, 0.035, pr, pg, pb);
  drum(sink, bx, bz, y + 0.3, y + 0.86, 0.165, 0.19, 10, r, g, b, 2);
  drum(sink, bx, bz, y + 0.84, y + 0.87, 0.2, 0.2, 10, lr, lg, lb, 1);       // the rim
  drum(sink, bx, bz, y + 1.0, y + 1.05, 0.21, 0.16, 10, lr, lg, lb, 2);      // the hood
  part(sink, x, y + 0.86, z, h, 0, 0.09, 0.03, 0.16, 0.03, pr, pg, pb);
}

// The most recognisable object on any Czech street: a row of coloured bells
// for paper, glass and plastic. Count and colours are hashed off the position
// so the same corner always has the same set.
function recycling(sink, x, y, z, h, col, deco, rnd) {
  const n = 2 + ((rnd(0) * 3) | 0);
  const [dr, dg, db] = col(0x1c1f22);
  const [wr, wg, wb] = col(C.white);
  for (let i = 0; i < n; i++) {
    const [r, g, b] = col(C.bell[(rnd(i + 1) * C.bell.length) | 0]);
    const p = at(x, z, h, (i - (n - 1) / 2) * 1.3, 0);
    const bx = p[0], bz = p[1];
    // the bell: a skirt, the body, the shoulder closing to the lifting eye
    drum(sink, bx, bz, y, y + 0.1, 0.5, 0.56, 10, dr, dg, db, 0);
    drum(sink, bx, bz, y + 0.1, y + 1.05, 0.56, 0.58, 10, r, g, b, 0);
    drum(sink, bx, bz, y + 1.05, y + 1.5, 0.58, 0.2, 10, r * 0.9, g * 0.9, b * 0.9, 1);
    drum(sink, bx, bz, y + 1.5, y + 1.62, 0.05, 0.05, 6, dr, dg, db, 1);
    // the slot you post bottles through, and the label under it
    const q = at(bx, bz, h, 0, 0.565);
    box(sink, q[0], y + 1.12, q[1], 0.34, 0.12, 0.05, h, dr, dg, db);
    box(sink, q[0], y + 0.62, q[1], 0.3, 0.26, 0.03, h, wr, wg, wb);
  }
}

// Česká pošta: the orange box on its own post, a dark flap, a white plate.
function postbox(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.post_box);
  const [pr, pg, pb] = col(C.postDark);
  post(sink, x, z, y, y + 0.95, 0.04, pr, pg, pb);
  box(sink, x, y + 0.92, z, 0.44, 0.52, 0.27, h, r, g, b, true);
  // the rounded top, as two shallower steps
  box(sink, x, y + 1.44, z, 0.4, 0.05, 0.24, h, r * 0.93, g * 0.93, b * 0.93);
  box(sink, x, y + 1.49, z, 0.3, 0.035, 0.18, h, r * 0.88, g * 0.88, b * 0.88);
  const [dr, dg, db] = col(0x2a1a08);
  const [wr, wg, wb] = col(C.white);
  const q = at(x, z, h, 0, 0.14);
  box(sink, q[0], y + 1.3, q[1], 0.32, 0.045, 0.02, h, dr, dg, db);
  box(sink, q[0], y + 1.02, q[1], 0.26, 0.2, 0.012, h, wr, wg, wb);
}

// Sheffield stands: four hoops you lean a bicycle on, set across the frontage.
function bikerack(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.bike);
  for (let i = 0; i < 4; i++) {
    const u = (i - 1.5) * 0.62;
    const a = at(x, z, h, u, -0.34), ax = a[0], az = a[1];
    const c = at(x, z, h, u, 0.34), cx = c[0], cz = c[1];
    bar(sink, ax, y, az, ax, y + 0.78, az, 0.045, r, g, b);
    bar(sink, cx, y, cz, cx, y + 0.78, cz, 0.045, r, g, b);
    bar(sink, ax, y + 0.78, az, cx, y + 0.78, cz, 0.045, r, g, b);
  }
}

function picnic(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.wood);
  const [dr, dg, db] = col(C.woodDark);
  for (let i = 0; i < 5; i++) part(sink, x, y + 0.7, z, h, 0, -0.32 + i * 0.16, 1.6, 0.045, 0.14, r, g, b, true);
  for (const v of [-0.75, 0.75]) {
    part(sink, x, y + 0.41, z, h, 0, v - 0.07, 1.6, 0.04, 0.13, r, g, b, true);
    part(sink, x, y + 0.41, z, h, 0, v + 0.07, 1.6, 0.04, 0.13, r, g, b, true);
  }
  for (const u of [-0.6, 0.6]) {
    part(sink, x, y + 0.36, z, h, u, 0, 0.07, 0.05, 1.7, dr, dg, db);
    part(sink, x, y, z, h, u, -0.4, 0.07, 0.7, 0.07, dr, dg, db);
    part(sink, x, y, z, h, u, 0.4, 0.07, 0.7, 0.07, dr, dg, db);
  }
}

// THE BUS SHELTER, and the contract for whoever waits in it: its bench is on
// the mapped node (x, z), seat top SEAT_H up, 2.0 m wide along the prop's
// right, and a sitter looks out along the FRONT (sin h, cos h), which is the
// open side toward the road. The glass back is 0.5 m behind the node, the roof
// covers 0.6 m behind to 1.15 m in front, and the lit poster panel closes the
// right-hand end (u = +1.7). Standing room is the 1.1 m in front of the bench.
export const SHELTER = { back: -0.5, front: 1.15, half: 1.7, seatHalf: 1.0 };
function shelter(sink, x, y, z, h, col, deco, rnd) {
  const [r, g, b] = col(C.shelter);
  const [dr, dg, db] = col(C.postDark);
  const [wr, wg, wb] = col(C.wood);
  const S = SHELTER, H = 2.35;
  // four slim posts and the roof they carry, with a fascia all round
  for (const [u, v] of [[-S.half, S.back], [S.half, S.back], [-S.half, S.front - 0.1], [S.half, S.front - 0.1]]) {
    const p = at(x, z, h, u, v);
    post(sink, p[0], p[1], y, y + H, 0.035, r, g, b);
  }
  const mid = (S.back + S.front) / 2, deep = S.front - S.back + 0.25;
  part(sink, x, y + H, z, h, 0, mid, S.half * 2 + 0.3, 0.07, deep, dr, dg, db, true);
  part(sink, x, y + H + 0.07, z, h, 0, mid, S.half * 2 + 0.1, 0.03, deep - 0.2, r, g, b);
  // rails the glass is clamped in, top and bottom of the back and the left end
  for (const yy of [0.32, 2.12]) {
    part(sink, x, y + yy, z, h, 0, S.back, S.half * 2, 0.04, 0.04, r, g, b, true);
    part(sink, x, y + yy, z, h, -S.half, (S.back + 0.55) / 2, 0.04, 0.04, 0.55 - S.back, r, g, b, true);
  }
  // the bench: three slats on two brackets, and the rail you lean on
  for (let i = 0; i < 3; i++) part(sink, x, y + SEAT_H - 0.035, z, h, 0, -0.13 + i * 0.125, S.seatHalf * 2, 0.035, 0.1, wr, wg, wb, true);
  for (const u of [-0.75, 0.75]) part(sink, x, y, z, h, u, 0, 0.05, SEAT_H - 0.035, 0.34, dr, dg, db);
  // the lit panel at the right-hand end: a dark case, a poster on both faces
  part(sink, x, y + 0.3, z, h, S.half, 0.32, 0.14, 1.95, 1.3, dr, dg, db, true);
  if (deco) {
    const c = Math.cos(h), s = Math.sin(h);
    const Fx = s, Fz = c, Rx = c, Rz = -s;
    // glass: the back, and the left end
    const gb = at(x, z, h, 0, S.back);
    deco.panel('glass', gb[0], y + 1.22, gb[1], S.half * 2 - 0.08, 1.76, Fx, Fz, 'glass');
    const gl = at(x, z, h, -S.half, (S.back + 0.55) / 2);
    deco.panel('glass', gl[0], y + 1.22, gl[1], 0.55 - S.back - 0.06, 1.76, Rx, Rz, 'glass');
    // posters, one facing into the shelter and one facing the street beyond
    const ad = 'ad' + ((rnd(7) * AD_COUNT) | 0), ad2 = 'ad' + ((rnd(8) * AD_COUNT) | 0);
    const pi = at(x, z, h, S.half - 0.076, 0.32);
    deco.panel(ad, pi[0], y + 1.3, pi[1], 1.16, 1.74, -Rx, -Rz);
    const po = at(x, z, h, S.half + 0.076, 0.32);
    deco.panel(ad2, po[0], y + 1.3, po[1], 1.16, 1.74, Rx, Rz);
    // the timetable, on the back glass by the open end
    const tt = at(x, z, h, -S.half + 0.5, S.back + 0.03);
    deco.panel('timetable', tt[0], y + 1.45, tt[1], 0.42, 0.63, Fx, Fz);
  }
}

// Boží muka: the single most Czech object in the dataset, 1 623 of them at
// field crossroads and village entrances.
function cross(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.stone);
  const [dr, dg, db] = col(C.stoneDark);
  box(sink, x, y, z, 0.85, 0.28, 0.85, h, dr, dg, db);          // plinth
  box(sink, x, y + 0.28, z, 0.5, 1.7, 0.5, h, r, g, b);         // shaft
  const [mr, mg, mb] = col(C.metal);
  box(sink, x, y + 1.98, z, 0.09, 0.95, 0.09, h, mr, mg, mb);   // cross, upright
  box(sink, x, y + 2.55, z, 0.55, 0.09, 0.09, h, mr, mg, mb);   // …and arms
}

function memorial(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.stone);
  const [dr, dg, db] = col(C.stoneDark);
  box(sink, x, y, z, 1.4, 0.22, 1.0, h, dr, dg, db);
  box(sink, x, y + 0.22, z, 0.9, 1.3, 0.45, h, r, g, b);
}

function statue(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.stoneDark);
  const [fr, fg, fb] = col(0x6b6f63);       // weathered bronze
  box(sink, x, y, z, 1.1, 1.2, 1.1, h, r, g, b);
  box(sink, x, y + 1.2, z, 0.42, 1.7, 0.32, h, fr, fg, fb);
  box(sink, x, y + 2.9, z, 0.26, 0.3, 0.26, h, fr, fg, fb);
}

function liftgate(sink, x, y, z, h, col) {
  const [pr, pg, pb] = col(C.post);
  const [dr, dg, db] = col(C.postDark);
  box(sink, x, y, z, 0.28, 1.05, 0.34, h, pr, pg, pb);          // the drive cabinet
  box(sink, x, y + 1.05, z, 0.32, 0.04, 0.38, h, dr, dg, db);
  // the boom, striped, lying across the road at 1 m
  const [rr, rg, rb] = col(C.red);
  const [wr, wg, wb] = col(C.white);
  for (let i = 0; i < 6; i++) {
    const p = at(x, z, h, 0.45 + i * 0.62, 0);
    const on = i % 2 === 0;
    box(sink, p[0], y + 0.93, p[1], 0.62, 0.09, 0.07, h,
      on ? rr : wr, on ? rg : wg, on ? rb : wb, true);
  }
}

function gate(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.metal);
  for (const u of [-1.6, 1.6]) {
    const p = at(x, z, h, u, 0);
    post(sink, p[0], p[1], y, y + 1.6, 0.045, r, g, b);
  }
  for (const yy of [0.3, 1.45]) part(sink, x, y + yy, z, h, 0, 0, 3.2, 0.05, 0.04, r, g, b, true);
  for (let i = 0; i < 11; i++) part(sink, x, y + 0.35, z, h, -1.45 + i * 0.29, 0, 0.03, 1.1, 0.03, r, g, b);
}

// A bollard: a dark steel post with a domed cap and the white band that makes
// it visible in headlights.
function bollard(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.postDark);
  const [wr, wg, wb] = col(C.white);
  drum(sink, x, z, y, y + 0.62, 0.065, 0.06, 8, r, g, b, 0);
  drum(sink, x, z, y + 0.62, y + 0.74, 0.062, 0.062, 8, wr, wg, wb, 0);
  drum(sink, x, z, y + 0.74, y + 0.86, 0.06, 0.055, 8, r, g, b, 0);
  drum(sink, x, z, y + 0.86, y + 0.9, 0.055, 0.025, 8, r, g, b, 1);
}

function fountain(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.metal);
  drum(sink, x, z, y, y + 0.9, 0.09, 0.07, 8, r, g, b, 1);
  box(sink, x, y + 0.9, z, 0.3, 0.08, 0.3, h, r, g, b, true);
}

// (A mapped LAMP is not drawn here any more. It is a lamp like the generated
// ones: instanced, lit, solid and fellable, so meshes.lampSpots takes it.)
const PROPS = {
  bench, bin, recycling, postbox, bikerack, picnic, shelter,
  cross, memorial, statue, liftgate, gate, bollard, fountain,
};

/**
 * Draw every prop this chunk owns into the sink.
 * @param sink   the chunk's TriSink
 * @param cell   the indexed chunk (for facing)
 * @param key    chunk key, so a prop is drawn by exactly one chunk
 * @param terrain height field
 * @param col    (hex) => [r,g,b] — the caller's colour scratch
 * @param rndAt  (x, z, i) => 0..1 deterministic
 * @param chunkOf (x, z) => key
 */
export function furnitureInto(sink, cell, key, terrain, col, rndAt, chunkOf, deco = null) {
  if (!cell?.furniture?.length || !terrain) return;
  // ABSOLUTE heights: every prop is placed at terrain.heightAt already, so the
  // chunk-wide drape must skip them. Without the fix mark, a 7 m lamp mast in
  // Pardubice came out 228 m tall: the drape added the ground a second time.
  const mark = sink.mark();
  sink.at(SURF.concrete);
  for (const f of cell.furniture) {
    const [x, z] = f.p[0];
    if (chunkOf(x, z) !== key) continue;
    const draw = PROPS[f.k];
    if (!draw) continue;
    if (inLandmark(cell.buildings, x, z)) continue;   // it would stand in the gate's passage
    if (landmarkProp(x, z)) continue;                 // a landmark built there without a footprint
    const y = terrain.heightAt(x, z);
    draw(sink, x, y, z, propFacing(cell, f), col, deco, (i) => rndAt(x, z, i));
  }
  sink.fixFrom(mark);
}

/**
 * The yaw a prop is drawn with: OSM's own direction when it has one, else
 * facing the nearest way. A prop's FRONT is the world direction (sin h, cos h).
 * Exported so that anything seating or queueing people at a prop asks the same
 * question the mesh did.
 */
export function propFacing(cell, f) {
  return f.a !== undefined ? (f.a * Math.PI) / 180 : facingOf(cell, f.p[0][0], f.p[0][1]);
}

export const _test = { facingOf, PROPS };
