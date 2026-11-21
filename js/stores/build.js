// ---- stores/build.js: a chain store's shell, fitted to its real footprint ----
// WORKER SAFE. Called by js/landmarks.js for every building js/stores/chains.js
// recognises as a standalone store, on the main thread and in the mesh worker
// alike, so it must emit the same triangles in the same order on both.
//
// The shell is the walls on the footprint's own edges (never a fixed model),
// with the glazing and the door where js/stores/site.js put them, a roof, and
// the INSIDE of the same box: floor, ceiling and the inner faces of the walls.
// The glazing is a real hole. The glass in it, the sliding door and everything
// that stands on the floor belong to the store runtime (js/stores/world.js),
// which only exists near the player; from further off the hole shows a lit,
// empty hall, which is what a supermarket is from across its car park.

import * as THREE from 'three';
import { K } from '../landmarkskit.js';
import { siteOf, shopRect, hashK } from './site.js';
import { dressStore } from './dress.js';

const INNER = 0xe9e9e4, FLOOR = 0xcfd0cd, CEIL = 0xf0f0ec;
const T_WALL = 0.3;                    // wall thickness, outer face to inner face
export const DOOR_H = 2.55;            // clear height of the sliding door
const FOOT = -0.9;                     // the walls go this far below the founding height

/** How the glazing of a run is divided: posts every ~1.7 m, never under 1.1. */
export function mullions(len) {
  const n = Math.max(1, Math.round(len / 1.7));
  return { n, pitch: len / n };
}

// A post or bar of the glazing frame: a box from p to q (world [x, y, z]) with
// a square section of half-width hw, three faces drawn (the fourth is inside).
function bar(kit, p, q, hw, mx, mz) {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const upright = Math.abs(dy) > Math.hypot(dx, dz);
  // across the bar, in the wall plane
  let ax, ay, az;
  if (upright) { ax = -mz; ay = 0; az = mx; } else { ax = 0; ay = 1; az = 0; }
  const o = 0.06, d = 0.16;            // proud of the wall line, and its depth inward
  const c = (pt, s, out) => [pt[0] + ax * hw * s + mx * (out ? o : o - d), pt[1] + ay * hw * s, pt[2] + az * hw * s + mz * (out ? o : o - d)];
  kit.quad(c(p, -1, 1), c(p, 1, 1), c(q, 1, 1), c(q, -1, 1), mx, 0, mz);
  kit.quad(c(p, -1, 0), c(p, 1, 0), c(q, 1, 0), c(q, -1, 0), -mx, 0, -mz);
  kit.quad(c(p, 1, 1), c(p, 1, 0), c(q, 1, 0), c(q, 1, 1), ax, ay, az);
  kit.quad(c(p, -1, 1), c(p, -1, 0), c(q, -1, 0), c(q, -1, 1), -ax, -ay, -az);
}

/** One run of wall: its outer skin in three courses, its opening, its inner face. */
function wallRun(kit, site, seg) {
  const A = site.chain.arch, fl = site.floor;
  const { a, b, mx, mz } = seg;
  const ta = site.topAt(a[0], a[1]), tb = site.topAt(b[0], b[1]);
  const P = (p, y) => [p[0], y, p[1]];
  const out = (ya0, yb0, ya1, yb1) => {
    if (ya1 - ya0 < 0.01 && yb1 - yb0 < 0.01) return;
    kit.quad(P(a, ya0), P(b, yb0), P(b, yb1), P(a, ya1), mx, 0, mz);
  };
  const bandH = A.bandH ?? 0;
  const open = seg.kind !== 'wall';
  // glazing stops under the band; over a door it starts at the door's head
  const gt = Math.min(site.glassTop, ta - bandH - 0.25, tb - bandH - 0.25);
  const sill = fl + (seg.kind === 'door' ? 0 : 0.1);
  // ---- outer skin ----
  kit.ao = true;
  kit.set(A.base, K.metal);
  out(FOOT, FOOT, open ? sill : 0.5, open ? sill : 0.5);
  kit.set(A.wall, A.wallKind ?? K.panel);
  if (open) out(gt, gt, ta - bandH, tb - bandH);
  else out(0.5, 0.5, ta - bandH, tb - bandH);
  if (bandH > 0) { kit.set(A.band, K.metal); out(ta - bandH, tb - bandH, ta, tb); }
  // ---- the frame of an opening ----
  if (open) {
    kit.ao = false;
    kit.set(A.frame, K.metal);
    const along = (s, y) => [a[0] + (b[0] - a[0]) * s / seg.len, y, a[1] + (b[1] - a[1]) * s / seg.len];
    const head = seg.kind === 'door' ? fl + DOOR_H : gt;
    bar(kit, along(0, sill), along(0, gt), 0.06, mx, mz);
    bar(kit, along(seg.len, sill), along(seg.len, gt), 0.06, mx, mz);
    bar(kit, along(0, gt), along(seg.len, gt), 0.07, mx, mz);
    if (seg.kind === 'door') bar(kit, along(0, head), along(seg.len, head), 0.07, mx, mz);
    else {
      const { n, pitch } = mullions(seg.len);
      for (let i = 1; i < n; i++) bar(kit, along(i * pitch, sill), along(i * pitch, gt), 0.035, mx, mz);
      if (gt - sill > 3.4) bar(kit, along(0, fl + DOOR_H), along(seg.len, fl + DOOR_H), 0.035, mx, mz);
      bar(kit, along(0, sill), along(seg.len, sill), 0.05, mx, mz);
    }
    kit.ao = true;
  }
  // ---- inner face: the room side of the same wall, lit after dark ----
  const ia = [a[0] - mx * T_WALL, a[1] - mz * T_WALL], ib = [b[0] - mx * T_WALL, b[1] - mz * T_WALL];
  kit.ao = false;
  kit.set(INNER, K.plaster); kit.gl = 0.5;
  const inn = (y0, ya1, yb1) => {
    if (ya1 - y0 < 0.01) return;
    kit.quad(P(ib, y0), P(ia, y0), P(ia, ya1), P(ib, yb1), -mx, 0, -mz);
  };
  if (open) inn(gt, ta - 0.25, tb - 0.25); else inn(fl - 0.05, ta - 0.25, tb - 0.25);
  kit.gl = 0; kit.ao = true;
}

/** A lid over the footprint whose height follows `yAt(x, z)`. */
function lid(kit, site, yAt, up) {
  const o = site.ring.map((p) => new THREE.Vector2(p[0], p[1]));
  if (THREE.ShapeUtils.isClockWise(o)) o.reverse();
  const faces = THREE.ShapeUtils.triangulateShape(o, []);
  const V = (v) => [v.x, yAt(v.x, v.y), v.y];
  for (const [i, j, k] of faces) kit.tri(V(o[i]), V(o[j]), V(o[k]), 0, up ? 1 : -1, 0);
}

/** Roof plant: the boxes every flat retail roof carries, where the shop floor is. */
function roofPlant(kit, site, deck) {
  const r = shopRect(site, 1.5);
  const n = site.chain.kind === 'fast' ? 2 : site.chain.kind === 'hyper' ? 6 : 3;
  kit.set(0xa9adb0, K.metal);
  for (let i = 0; i < n; i++) {
    const u = r.u0 + (r.u1 - r.u0) * (0.15 + 0.7 * hashK(site.key, 40 + i));
    const v = r.v0 + (r.v1 - r.v0) * (0.15 + 0.55 * hashK(site.key, 60 + i));
    const w = 1.1 + hashK(site.key, 80 + i) * 1.3, d = 0.8 + hashK(site.key, 90 + i) * 0.7, h = 0.9 + hashK(site.key, 95 + i) * 0.6;
    const c = [[u - w, v - d], [u + w, v - d], [u + w, v + d], [u - w, v + d]].map(([a, b]) => site.world(a, b));
    const y0 = deck(c[0][0], c[0][1]) - 0.05, y1 = y0 + h;
    for (let k = 0; k < 4; k++) {
      const p = c[k], q = c[(k + 1) % 4];
      const ex = q[0] - p[0], ez = q[1] - p[1], L = Math.hypot(ex, ez);
      kit.wall(p, q, y0, y1, ez / L, -ex / L);
    }
    kit.quad([c[0][0], y1, c[0][1]], [c[1][0], y1, c[1][1]], [c[2][0], y1, c[2][1]], [c[3][0], y1, c[3][1]], 0, 1, 0);
  }
}

/**
 * The landmark builder (js/landmarks.js LandmarkBatch.add): `l.chain` is the
 * chain, `ctx` carries the chunk cell and the chunk's wordmark stream.
 */
export function buildStore(kit, f, l, ctx) {
  // A footprint nobody foresaw must cost one store its dressing, never the
  // chunk it stands in: a throw here would take the whole chunk's build down.
  try { shell(kit, f, l, ctx); } catch (e) {
    if (!buildStore.warned) { buildStore.warned = true; console.warn('[stores] ' + (f.n ?? '?') + ' at ' + f.o?.[0] + ' could not be built:', e); }
  }
}

function shell(kit, f, l, ctx) {
  const chain = l.chain, A = chain.arch;
  const site = siteOf(f, chain, ctx?.cell);
  for (const seg of site.segs) wallRun(kit, site, seg);

  // ---- the roof ----
  const flat = site.hF === site.hB;
  const deck = (x, z) => site.topAt(x, z) - (flat ? 0.45 : -0.02);
  kit.ao = false;
  kit.set(A.roof, K.metal);
  lid(kit, site, deck, true);
  if (flat) {
    // the parapet's own inner face, from the deck to the coping
    kit.set(A.base, K.metal);
    for (const e of site.edges) kit.wall(e.b, e.a, site.hF - 0.45, site.hF, -e.mx, -e.mz);
  }
  roofPlant(kit, site, deck);
  // ---- the room: ceiling and floor ----
  kit.set(CEIL, K.plaster); kit.gl = 0.75;
  lid(kit, site, (x, z) => Math.min(site.topAt(x, z) - (flat ? 0.75 : 0.3), (A.ceil ?? Infinity) + 0.03), false);
  kit.set(FLOOR, K.paving); kit.gl = 0.2;
  lid(kit, site, () => site.floor, true);
  kit.gl = 0; kit.ao = true;

  dressStore(kit, f, site, ctx);
}

/**
 * What of a store is solid: every run of wall as a thin strip, the door left
 * open, and the roof as a slab over head height. Heights are above the
 * building's own ground (js/landmarks.js landmarkSolids).
 */
export function storeSolids(f, l, cell) {
  const site = siteOf(f, l.chain, cell);
  const out = [];
  const strip = (seg, top, bot) => {
    const { a, b, mx, mz } = seg;
    out.push({ ring: [[a[0] + mx * 0.05, a[1] + mz * 0.05], [b[0] + mx * 0.05, b[1] + mz * 0.05],
      [b[0] - mx * T_WALL, b[1] - mz * T_WALL], [a[0] - mx * T_WALL, a[1] - mz * T_WALL]], holes: null, top, bot });
  };
  for (const seg of site.segs) strip(seg, site.hF, seg.kind === 'door' ? site.floor + DOOR_H : 0);
  out.push({ ring: f.o, holes: null, top: Math.max(site.hF, site.hB), bot: Math.min(site.hF, site.hB) - 0.8 });
  return out;
}
