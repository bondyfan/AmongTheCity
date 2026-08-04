// ---- what a Czech street actually has standing on it -----------------------
// Benches, bins, the coloured recycling bells, post boxes, bike racks, bus
// shelters, wayside crosses, gates and bollards — every one of them a node
// somebody surveyed to the metre, and every one of them thrown away by the
// pipeline until now. A town without them reads as a film set between takes:
// correct geometry, nobody's life in it.
//
// Everything here writes into the chunk's shared TriSink, the same way signs
// and zebras do, so a hundred props cost no draw calls of their own. Shapes are
// deliberately blocky — this world is low-poly and a faceted bench beside a
// faceted car is coherent, while a smooth one would not be.
//
// The one rule that matters: props sit on the GROUND, at terrain height, and
// they face something. A bench facing away from the path is worse than no
// bench, so every prop that has a front takes its bearing from the nearest
// footway or road unless OSM gave it a direction.

import { SURF } from './surfaces.js';

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

/** A box standing on the ground, yawed by `h`, in the sink's local frame. */
function box(sink, x, y, z, w, hh, d, h, r, g, b) {
  const c = Math.cos(h), s = Math.sin(h);
  // corners of the footprint, rotated
  const P = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([u, v]) => [x + u * c + v * s, z - u * s + v * c]);
  const y1 = y + hh;
  // sides
  for (let i = 0; i < 4; i++) {
    const [ax, az] = P[i], [bx, bz] = P[(i + 1) % 4];
    sink.quad(ax, y, az, bx, y, bz, bx, y1, bz, ax, y1, az, r, g, b);
  }
  // top
  sink.quad(P[0][0], y1, P[0][1], P[1][0], y1, P[1][1],
    P[2][0], y1, P[2][1], P[3][0], y1, P[3][1], r, g, b);
}

/** A vertical post: two crossed fins read as a cylinder at a fraction of the cost. */
function post(sink, x, z, y0, y1, rad, h, r, g, b) {
  const c = Math.cos(h), s = Math.sin(h);
  for (const [ox, oz] of [[c, -s], [s, c]]) {
    for (const flip of [1, -1]) {
      sink.quad(
        x - ox * rad * flip, y0, z - oz * rad * flip,
        x + ox * rad * flip, y0, z + oz * rad * flip,
        x + ox * rad * flip, y1, z + oz * rad * flip,
        x - ox * rad * flip, y1, z - oz * rad * flip, r, g, b);
    }
  }
}

// ---- the props ------------------------------------------------------------
// Each takes (sink, x, y, z, h, col) where `col` unpacks a hex into r/g/b and
// y is the ground. They may call sink.at() to change surface class.

function bench(sink, x, y, z, h, col) {
  const [wr, wg, wb] = col(C.wood);
  const [mr, mg, mb] = col(C.metal);
  // two cast legs, a seat and a back — 1.7 m wide, facing +h
  for (const side of [-0.7, 0.7]) {
    const lx = x + Math.cos(h) * side, lz = z - Math.sin(h) * side;
    box(sink, lx, y, lz, 0.08, 0.45, 0.5, h, mr, mg, mb);
  }
  box(sink, x, y + 0.42, z, 1.7, 0.07, 0.48, h, wr, wg, wb);
  // backrest, tipped back over the rear edge
  const bx = x - Math.sin(h) * 0.2, bz = z - Math.cos(h) * 0.2;
  box(sink, bx, y + 0.49, bz, 1.7, 0.42, 0.07, h, wr, wg, wb);
}

function bin(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.bin);
  const [lr, lg, lb] = col(C.binLid);
  post(sink, x, z, y, y + 0.95, 0.05, h, ...col(C.post));
  box(sink, x + Math.sin(h) * 0.18, y + 0.42, z + Math.cos(h) * 0.18, 0.36, 0.5, 0.32, h, r, g, b);
  box(sink, x + Math.sin(h) * 0.18, y + 0.92, z + Math.cos(h) * 0.18, 0.4, 0.05, 0.36, h, lr, lg, lb);
}

// The most recognisable object on any Czech street: a cluster of coloured
// bells. Count and colours are hashed off the position so the same corner
// always has the same set.
function recycling(sink, x, y, z, h, col, rnd) {
  const n = 2 + ((rnd(0) * 3) | 0);
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * 1.25;
    const bx = x + Math.cos(h) * off, bz = z - Math.sin(h) * off;
    const [r, g, b] = col(C.bell[(rnd(i + 1) * C.bell.length) | 0]);
    // the bell: a wide skirt, a narrower shoulder, a dark slot
    box(sink, bx, y, bz, 1.05, 0.95, 1.05, h, r, g, b);
    box(sink, bx, y + 0.95, bz, 0.8, 0.35, 0.8, h, r * 0.92, g * 0.92, b * 0.92);
    const [dr, dg, db] = col(0x1c1f22);
    box(sink, bx + Math.sin(h) * 0.4, y + 1.02, bz + Math.cos(h) * 0.4, 0.4, 0.14, 0.06, h, dr, dg, db);
  }
}

function postbox(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.post_box);
  post(sink, x, z, y, y + 1.0, 0.05, h, ...col(C.post));
  box(sink, x, y + 0.95, z, 0.42, 0.55, 0.3, h, r, g, b);
  const [dr, dg, db] = col(0x2a1a08);
  box(sink, x + Math.sin(h) * 0.16, y + 1.32, z + Math.cos(h) * 0.16, 0.3, 0.05, 0.03, h, dr, dg, db);
}

function bikerack(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.bike);
  for (let i = 0; i < 4; i++) {
    const off = (i - 1.5) * 0.55;
    const bx = x + Math.cos(h) * off, bz = z - Math.sin(h) * off;
    post(sink, bx, bz, y, y + 0.75, 0.03, h, r, g, b);
  }
  box(sink, x, y + 0.72, z, 1.9, 0.05, 0.05, h, r, g, b);
}

function picnic(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.wood);
  const [dr, dg, db] = col(C.woodDark);
  box(sink, x, y + 0.7, z, 1.6, 0.07, 0.8, h, r, g, b);
  for (const side of [-0.75, 0.75]) {
    const bx = x + Math.sin(h) * side, bz = z + Math.cos(h) * side;
    box(sink, bx, y + 0.42, bz, 1.6, 0.06, 0.28, h, r, g, b);
  }
  for (const side of [-0.6, 0.6]) {
    const lx = x + Math.cos(h) * side, lz = z - Math.sin(h) * side;
    box(sink, lx, y, lz, 0.08, 0.7, 1.5, h, dr, dg, db);
  }
}

function shelter(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.shelter);
  const [gr, gg, gb] = col(C.glass);
  // four columns, a back wall of glass, a flat roof — 3.2 × 1.5 m
  for (const [u, v] of [[-1.5, -0.7], [1.5, -0.7], [-1.5, 0.7], [1.5, 0.7]]) {
    const px2 = x + Math.cos(h) * u + Math.sin(h) * v;
    const pz2 = z - Math.sin(h) * u + Math.cos(h) * v;
    post(sink, px2, pz2, y, y + 2.3, 0.05, h, r, g, b);
  }
  box(sink, x - Math.sin(h) * 0.7, y + 0.4, z - Math.cos(h) * 0.7, 3.2, 1.8, 0.06, h, gr, gg, gb);
  box(sink, x, y + 2.3, z, 3.4, 0.1, 1.7, h, r, g, b);
  bench(sink, x, y, z, h, col);
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
  post(sink, x, z, y, y + 1.15, 0.09, h, pr, pg, pb);
  // the boom, striped, lying across the road at 1 m
  const [rr, rg, rb] = col(C.red);
  const [wr, wg, wb] = col(C.white);
  for (let i = 0; i < 6; i++) {
    const off = 0.4 + i * 0.62;
    const bx = x + Math.cos(h) * off, bz = z - Math.sin(h) * off;
    const on = i % 2 === 0;
    box(sink, bx, y + 0.97, bz, 0.62, 0.09, 0.09, h,
      on ? rr : wr, on ? rg : wg, on ? rb : wb);
  }
}

function gate(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.metal);
  for (const side of [-1.6, 1.6]) {
    const px2 = x + Math.cos(h) * side, pz2 = z - Math.sin(h) * side;
    post(sink, px2, pz2, y, y + 1.6, 0.06, h, r, g, b);
  }
  for (const yy of [0.35, 0.85, 1.35]) {
    box(sink, x, y + yy, z, 3.2, 0.05, 0.04, h, r, g, b);
  }
}

function bollard(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.postDark);
  post(sink, x, z, y, y + 0.85, 0.07, h, r, g, b);
  const [wr, wg, wb] = col(C.white);
  post(sink, x, z, y + 0.7, y + 0.82, 0.075, h, wr, wg, wb);
}

function fountain(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.metal);
  post(sink, x, z, y, y + 0.95, 0.06, h, r, g, b);
  box(sink, x, y + 0.9, z, 0.3, 0.1, 0.3, h, r, g, b);
}

// A lamp COLUMN — the head and its glow are the caller's business (the game
// already instances lamp heads with an emissive material); this is the mast
// only, so an OSM lamp looks like the procedural ones beside it.
function lampMast(sink, x, y, z, h, col) {
  const [r, g, b] = col(C.postDark);
  post(sink, x, z, y, y + 7.0, 0.07, h, r, g, b);
  // the arm reaching over the carriageway
  const ax = x + Math.sin(h) * 0.6, az = z + Math.cos(h) * 0.6;
  box(sink, ax, y + 6.9, az, 0.09, 0.09, 1.3, h, r, g, b);
}

const PROPS = {
  bench, bin, recycling, postbox, bikerack, picnic, shelter,
  cross, memorial, statue, liftgate, gate, bollard, fountain, lamp: lampMast,
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
export function furnitureInto(sink, cell, key, terrain, col, rndAt, chunkOf) {
  if (!cell?.furniture?.length || !terrain) return;
  // ABSOLUTE heights: every prop is placed at terrain.heightAt already, so the
  // chunk-wide drape must skip them. Without the fix mark, a 7 m lamp mast in
  // Pardubice came out 228 m tall — the drape added the ground a second time.
  const mark = sink.mark();
  sink.at(SURF.concrete);
  for (const f of cell.furniture) {
    const [x, z] = f.p[0];
    if (chunkOf(x, z) !== key) continue;
    const draw = PROPS[f.k];
    if (!draw) continue;
    const y = terrain.heightAt(x, z);
    // OSM's own direction when it has one, else facing the nearest road
    const h = f.a !== undefined ? (f.a * Math.PI) / 180 : facingOf(cell, x, z);
    if (f.k === 'recycling') draw(sink, x, y, z, h, col, (i) => rndAt(x, z, i));
    else draw(sink, x, y, z, h, col);
  }
  sink.fixFrom(mark);
}

export const _test = { facingOf, PROPS };
