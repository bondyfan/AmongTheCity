// ---- quaystairs.js: stone steps and walls down to the Prague lower quays ----
// The ways down to the náplavky are terrain stamps (js/naplavky.js), and a
// stamp can only ever be ground: a flight of stairs was a smooth inclined
// slab of aerial photo, and every hard edge of a stamp (a flight's sides, a
// ramp's, the quay wall's own line) stood as a vertical face of ground, the
// photo smeared down it in one-texel streaks. Here, in stone:
//   * every FLIGHT as treads and risers over the stamp (js/quayflights.js has
//     the numbers), with its sides closed down to the ground under it;
//   * along every HARD EDGE of the quay stamps, where the ground either side
//     differs by more than a kerb, a dressed stone face 4 cm proud of the
//     edge on its low side, from under the low ground to the high one, with a
//     coping; on a flight's open side the face goes on up as a parapet a
//     metre over the steps (the real Palackého and Dvořákovo stairs have one).
// Every piece is built by the chunk holding its midpoint (a flight by its own
// middle), so it exists once whatever order the chunks come in; a pure
// function of constants and the terrain, so the mesh worker builds the same.
// Absolute heights: the caller marks the range fixed, like the bank skirts.
// WORKER SAFE.

import { NAPLAVKY, NAPLAVKA_BEFORE, NAPLAVKA_AFTER } from './naplavky.js';
import { FLIGHTS, groundUnder, treadTop, walkLine } from './quayflights.js';

// sRGB to the linear triples vertex colours are stored in (the quay walls'
// own stone, js/quaywall.js; the retaining walls' grey, meshes.js BARRIER_SPEC)
const lin = (h) => [16, 8, 0].map((s) => { const c = ((h >> s) & 255) / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
const TREAD = [0.52, 0.49, 0.44], RISER = [0.38, 0.36, 0.32], STONE = [0.44, 0.41, 0.36];
const CAP = [0.56, 0.53, 0.47], RETAIN = lin(0x8d8880);

const PROUD = 0.04;          // m: a face stands this far out from the edge, over the ground's own
const FOOT = 0.3;            // m: and reaches this far under the low ground
const STEP = 0.25;           // m: less than this either side is a kerb, not a wall
const COPE_W = 0.35, COPE_H = 0.08;
const PARAPET_H = 1.0, PARAPET_T = 0.3;
const DROP_MIN = 0.45;       // m under the steps before the open side has a parapet

// ---- the hard edges ------------------------------------------------------------
// Each quay stamp's profile says where its hard edges are (two entries at one
// d, the weight jumping), as js/terrainstamps.js makeStamp reads it. A piece
// is a short run of one such edge: the stamp's own line offset by that d.
function hardEdges(prof) {
  const out = [];
  for (let i = 0; i < prof.length - 1; i++) {
    if (prof[i + 1][0] - prof[i][0] < 0.01 && Math.abs(prof[i + 1][2] - prof[i][2]) > 0.5) {
      // which way the stamp's own ground lies from the edge: +1 to the right
      out.push({ d: (prof[i][0] + prof[i + 1][0]) / 2, inside: prof[i + 1][2] > prof[i][2] ? 1 : -1 });
    }
  }
  return out;
}

let PIECES = null;
function pieces() {
  if (PIECES) return PIECES;
  PIECES = [];
  const flightOf = new Map(FLIGHTS.map((F) => [F.name, F]));
  const defs = [...NAPLAVKY.map((d) => ({ d, quay: true })),
    ...[...NAPLAVKA_BEFORE, ...NAPLAVKA_AFTER].map((d) => ({ d, quay: false }))];
  for (const { d: def, quay } of defs) {
    const F = flightOf.get(def.name) ?? null;
    const pts = def.pts, step = quay ? 2 : 0.75;
    for (const e of hardEdges(def.prof)) {
      let prev = null;                       // the run of pieces along this edge
      for (let i = 0; i < pts.length - 1; i++) {
        const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
        const L = Math.hypot(bx - ax, bz - az);
        if (L < 1e-3) continue;
        const ux = (bx - ax) / L, uz = (bz - az) / L, nx = -uz, nz = ux;
        const n = Math.max(1, Math.ceil(L / step));
        for (let k = 0; k < n; k++) {
          const t0 = L * k / n, t1 = L * (k + 1) / n;
          const p0x = ax + ux * t0 + nx * e.d, p0z = az + uz * t0 + nz * e.d;
          const p1x = ax + ux * t1 + nx * e.d, p1z = az + uz * t1 + nz * e.d;
          // along the flight: s at both ends, for the parapet over the steps
          const s0 = F ? (p0x - F.a[0]) * F.ux + (p0z - F.a[1]) * F.uz : 0;
          const s1 = F ? (p1x - F.a[0]) * F.ux + (p1z - F.a[1]) * F.uz : 0;
          const pc = { p0x, p0z, p1x, p1z, ix: nx * e.inside, iz: nz * e.inside,
            mx: (p0x + p1x) / 2, mz: (p0z + p1z) / 2, quay, F, s0, s1, prev, next: null };
          if (prev) prev.next = pc;
          PIECES.push(pc);
          prev = pc;
        }
      }
    }
  }
  return PIECES;
}

// the box everything here lies in (the quay lines reach furthest)
let BOX = null;
function box() {
  if (BOX) return BOX;
  BOX = { x0: Infinity, z0: Infinity, x1: -Infinity, z1: -Infinity };
  const grow = (x, z) => { BOX.x0 = Math.min(BOX.x0, x - 5); BOX.x1 = Math.max(BOX.x1, x + 5); BOX.z0 = Math.min(BOX.z0, z - 5); BOX.z1 = Math.max(BOX.z1, z + 5); };
  for (const p of pieces()) { grow(p.p0x, p.p0z); grow(p.p1x, p.p1z); }
  for (const F of FLIGHTS) { grow(F.x0, F.z0); grow(F.x1, F.z1); }
  return BOX;
}

// ---- drawing -------------------------------------------------------------------
// a quad a-b-c-d (each [x, y, z]) wound to face (fx, fy, fz)
function quad(sink, A, B, C, D, fx, fy, fz, c) {
  sink.triFacing(A[0], A[1], A[2], B[0], B[1], B[2], C[0], C[1], C[2], fx, fy, fz, c[0], c[1], c[2]);
  sink.triFacing(A[0], A[1], A[2], C[0], C[1], C[2], D[0], D[1], D[2], fx, fy, fz, c[0], c[1], c[2]);
}
const shade = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
// a stone's tone, a little different tread to tread (a pure hash of its place)
const tone = (i, k) => 0.93 + 0.12 * (((Math.imul(i * 7919 + k, 2654435761) >>> 0) % 1000) / 1000);

/** One flight: treads, risers, and its two sides closed to the ground under it. */
function flightInto(sink, F) {
  const { a, ux, uz, nx, nz, l, r, n, g, h, y0 } = F;
  const P = (s, d, y) => [a[0] + ux * s + nx * d, y, a[1] + uz * s + nz * d];
  for (let k = 1; k <= n; k++) {
    const sA = (k - 1) * g, sB = k * g, T = y0 + k * h;
    const lo = k === 1 ? groundUnder(F, 0) - 0.05 : T - h - 0.02;
    const tk = tone(F.i, k);
    quad(sink, P(sA, -l, T), P(sB, -l, T), P(sB, r, T), P(sA, r, T), 0, 1, 0, shade(TREAD, tk));
    quad(sink, P(sA, -l, lo), P(sA, r, lo), P(sA, r, T), P(sA, -l, T), -ux, 0, -uz, shade(RISER, tk));
    // the step's ends, down to the ground under it (inside a side wall
    // where there is one, the flight's own edge where there is not)
    const gA = groundUnder(F, sA) - 0.03, gB = groundUnder(F, sB) - 0.03;
    for (const [d, sg] of [[-l, -1], [r, 1]]) {
      quad(sink, P(sA, d, gA), P(sB, d, gB), P(sB, d, T), P(sA, d, T), nx * sg, 0, nz * sg, shade(RISER, 0.9));
    }
  }
}

// The ground either side of piece p, just off the edge, into _h; on a flight
// the inside is the steps, not the ground under them. Does it carry a parapet?
const _h = { inA: 0, inB: 0, outA: 0, outB: 0, topA: 0, topB: 0, par: false };
function sides(p, terrain) {
  const { ix, iz, F } = p;
  const inA = terrain.heightAt(p.p0x + ix * 0.08, p.p0z + iz * 0.08);
  const inB = terrain.heightAt(p.p1x + ix * 0.08, p.p1z + iz * 0.08);
  const outA = terrain.heightAt(p.p0x - ix * 0.08, p.p0z - iz * 0.08);
  const outB = terrain.heightAt(p.p1x - ix * 0.08, p.p1z - iz * 0.08);
  const topA = F ? Math.max(inA, treadTop(F, p.s0) + (p.s0 > 0 && p.s0 < F.L ? 0.02 : 0)) : inA;
  const topB = F ? Math.max(inB, treadTop(F, p.s1) + (p.s1 > 0 && p.s1 < F.L ? 0.02 : 0)) : inB;
  let par = false;
  if (F && (topA - outA > STEP || topB - outB > STEP) && p.s1 > 0) {
    par = walkLine(F, Math.max(0, p.s0)) - outA > DROP_MIN || walkLine(F, Math.max(0, p.s1)) - outB > DROP_MIN;
  }
  Object.assign(_h, { inA, inB, outA, outB, topA, topB, par });
  return _h;
}
const parOf = (p, terrain) => !!p && sides(p, terrain).par;

/** One piece of a hard edge: the face on its low side, a coping or a parapet. */
function pieceInto(sink, p, terrain) {
  const { ix, iz, F } = p;
  // (whether the pieces either side carry a parapet: its end is closed only where they do not)
  const capA = !parOf(p.prev, terrain), capB = !parOf(p.next, terrain);
  const { inA, inB, outA, outB, topA, topB, par } = sides(p, terrain);
  const col = p.quay ? RETAIN : STONE;
  const at = (x, z, y, o) => [x + ix * o, y, z + iz * o];
  if (topA - outA > STEP || topB - outB > STEP) {
    // the inside stands higher: the face looks out, from under the outside
    // ground up to the inside's top
    const o = -PROUD;
    if (F) {
      // a flight's open side: its stringer, and a parapet where the steps
      // stand high enough over the ground beside them to need one
      const wA = walkLine(F, Math.max(0, p.s0)), wB = walkLine(F, Math.max(0, p.s1));
      // (its top runs with the feet, smooth over the steps, not stepped with them)
      const hA = par ? wA + PARAPET_H : topA, hB = par ? wB + PARAPET_H : topB;
      quad(sink, at(p.p0x, p.p0z, outA - FOOT, o), at(p.p1x, p.p1z, outB - FOOT, o),
        at(p.p1x, p.p1z, hB, o), at(p.p0x, p.p0z, hA, o), -ix, 0, -iz, STONE);
      if (par) {
        const q = PARAPET_T;
        // its inner face, down into the steps, and its coping
        quad(sink, at(p.p0x, p.p0z, groundUnder(F, p.s0) - 0.05, q), at(p.p1x, p.p1z, groundUnder(F, p.s1) - 0.05, q),
          at(p.p1x, p.p1z, hB, q), at(p.p0x, p.p0z, hA, q), ix, 0, iz, STONE);
        quad(sink, at(p.p0x, p.p0z, hA, o), at(p.p1x, p.p1z, hB, o), at(p.p1x, p.p1z, hB, q),
          at(p.p0x, p.p0z, hA, q), 0, 1, 0, CAP);
        // its ends, where the parapet starts or stops
        const ux = p.p1x - p.p0x, uz = p.p1z - p.p0z;
        if (capA) quad(sink, at(p.p0x, p.p0z, topA - 0.1, o), at(p.p0x, p.p0z, topA - 0.1, q), at(p.p0x, p.p0z, hA, q),
          at(p.p0x, p.p0z, hA, o), -ux, 0, -uz, STONE);
        if (capB) quad(sink, at(p.p1x, p.p1z, topB - 0.1, o), at(p.p1x, p.p1z, topB - 0.1, q), at(p.p1x, p.p1z, hB, q),
          at(p.p1x, p.p1z, hB, o), ux, 0, uz, STONE);
      }
      return;
    }
    quad(sink, at(p.p0x, p.p0z, outA - FOOT, o), at(p.p1x, p.p1z, outB - FOOT, o),
      at(p.p1x, p.p1z, topB, o), at(p.p0x, p.p0z, topA, o), -ix, 0, -iz, col);
    return;
  }
  if (outA - topA > STEP || outB - topB > STEP) {
    // the outside stands higher (the street, the embankment the flight is
    // cut into): the face looks in, from under the steps or the quay up to
    // the outside ground, and a coping lies on the edge of that ground
    const o = PROUD;
    const lowA = (F ? Math.min(inA, groundUnder(F, p.s0)) : inA) - FOOT;
    const lowB = (F ? Math.min(inB, groundUnder(F, p.s1)) : inB) - FOOT;
    quad(sink, at(p.p0x, p.p0z, lowA, o), at(p.p1x, p.p1z, lowB, o),
      at(p.p1x, p.p1z, outB + COPE_H, o), at(p.p0x, p.p0z, outA + COPE_H, o), ix, 0, iz, col);
    const back = -COPE_W;
    quad(sink, at(p.p0x, p.p0z, outA + COPE_H, o), at(p.p1x, p.p1z, outB + COPE_H, o),
      at(p.p1x, p.p1z, outB + COPE_H, back), at(p.p0x, p.p0z, outA + COPE_H, back), 0, 1, 0, p.quay ? col : CAP);
  }
}

/**
 * The flights and the stone faces of the quay stamps' hard edges that chunk
 * [x0, x1) x [z0, z1) owns, into `sink` (absolute heights). Returns at its
 * first compare anywhere away from the Prague quays.
 */
export function quayStairsInto(sink, x0, z0, x1, z1, terrain) {
  if (!terrain) return;
  const b = box();
  if (x1 < b.x0 || x0 > b.x1 || z1 < b.z0 || z0 > b.z1) return;
  for (const F of FLIGHTS) if (F.mx >= x0 && F.mx < x1 && F.mz >= z0 && F.mz < z1) flightInto(sink, F);
  for (const p of pieces()) if (p.mx >= x0 && p.mx < x1 && p.mz >= z0 && p.mz < z1) pieceInto(sink, p, terrain);
}
