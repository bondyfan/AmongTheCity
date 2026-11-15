// ---- mwsignmesh.js: the motorway signs as chunk geometry ----
// Turns the items js/mwsigns.js plans for one chunk into triangles: the steel
// (gantry legs and truss, posts, footings) into the chunk's shared TriSink,
// the faces into a MwDecoSink of textured quads on the motorway atlas
// (js/mwfaces.js uvs, painted by js/mwatlas.js). Runs on the main thread AND
// in the mesh worker: three geometry only, no canvas, and the output is a pure
// function of the plan and the terrain heights, so both builds agree.
//
// Heights. The road level is the terrain under the carriageway centreline
// (the earthworks level the ground under a motorway; a bridge never carries a
// sign, the planner sees to it). Panels hang at fixed heights over THAT
// level, so a gantry clears the lanes whatever the verge does; posts and legs
// reach down to the ground under them, clamped, so a footing on an
// embankment's slope neither floats nor buries the sign. Everything is
// authored at absolute heights and marked fixed: the chunk drape skips it.

import * as THREE from 'three';
import { drum, post, bar, box } from './propkit.js';
import { mwUV } from './mwfaces.js';
import { plannedMotorwaySigns, GANTRY_CLEAR, GANTRY_PANEL_H } from './mwsigns.js';

const _c = new THREE.Color();
const STEEL = 0x8a8d92, STEEL_DK = 0x6f7378, CONCRETE = 0xa7a49c;
const rgb = (hex, k = 1) => { _c.setHex(hex); return [_c.r * k, _c.g * k, _c.b * k]; };

// ---- textured quads on the motorway atlas ----------------------------------
// The street atlas's DecoSink (js/propkit.js) reads signfaces.js; this one
// reads mwfaces.js. Same attribute layout (position, normal, uv), so the
// worker codec carries it like any other deco mesh.
export class MwDecoSink {
  constructor() { this.pos = []; this.nrm = []; this.uv = []; }
  /** Quad of face `name`, corners bottom-left, bottom-right, top-right, top-left as the viewer sees them. */
  quad(name, a, b, c, d, flip = false) {
    const [u0, v0, u1, v1] = mwUV(name);
    const ua = flip ? u1 : u0, ub = flip ? u0 : u1;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2],
      a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2]);
    for (let i = 0; i < 6; i++) this.nrm.push(nx, ny, nz);
    this.uv.push(ua, v0, ub, v0, ub, v1, ua, v0, ub, v1, ua, v1);
  }
  /** Upright panel centred at (x, y, z), w x hh, facing (fx, fz); `back` the cell on its far side. */
  panel(name, x, y, z, w, hh, fx, fz, back = null) {
    const rx = fz * (w / 2), rz = -fx * (w / 2), k = hh / 2;
    this.quad(name, [x - rx, y - k, z - rz], [x + rx, y - k, z + rz],
      [x + rx, y + k, z + rz], [x - rx, y + k, z - rz]);
    if (back) {
      const o = 0.01;
      this.quad(back, [x + rx - fx * o, y - k, z + rz - fz * o], [x - rx - fx * o, y - k, z - rz - fz * o],
        [x - rx - fx * o, y + k, z - rz - fz * o], [x + rx - fx * o, y + k, z + rz - fz * o], true);
    }
  }
  geo() {
    if (!this.pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nrm), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    return g;
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---- gantry -------------------------------------------------------------------
// Two legs (a pair of tubes each, braced, on a concrete footing) beyond the
// crash barriers of both carriageways, and a box truss over the road: four
// chords and a zigzag of diagonals on each face. Panels hang on its face
// toward the oncoming traffic; their galvanised backs face the other way.
const TRUSS_D = 1.1, TRUSS_H = 2.2;
function gantryInto(sink, deco, it, H) {
  const { cx, cz, dx, dz } = it;
  const rx = -dz, rz = dx;                        // right of travel
  const yr = H(cx, cz);
  const y0 = yr + GANTRY_CLEAR + 0.35, y1 = y0 + TRUSS_H;
  const [sr, sg, sb] = rgb(STEEL), [dr, dg, db] = rgb(STEEL_DK), [cr, cg, cb] = rgb(CONCRETE);
  const hd = TRUSS_D / 2;
  const legs = it.cant ? [it.right] : [it.left, it.right];
  // the legs
  for (const off of legs) {
    const lx = cx + rx * off, lz = cz + rz * off;
    const g = clamp(H(lx, lz), yr - 6, yr + 1.5);
    box(sink, lx, g - 0.6, lz, 1.0, 0.85, TRUSS_D + 0.7, Math.atan2(dx, dz), cr, cg, cb);
    for (const s of [-hd, hd]) {
      drum(sink, lx + dx * s, lz + dz * s, g + 0.2, y1 + 0.08, 0.15, 0.15, 8, sr, sg, sb, 1);
    }
    // bracing between the pair, a zigzag every 1.4 m up
    let up = g + 0.4, side = -1;
    while (up + 1.4 < y1) {
      bar(sink, lx + dx * hd * side, up, lz + dz * hd * side, lx - dx * hd * side, up + 1.4, lz - dz * hd * side, 0.07, dr, dg, db);
      up += 1.4; side = -side;
    }
  }
  // the truss: chords from leg to leg, at the front and back faces, top and bottom
  const ax = cx + rx * it.left, az = cz + rz * it.left, bx = cx + rx * it.right, bz = cz + rz * it.right;
  for (const s of [-hd, hd]) {
    for (const y of [y0, y1]) bar(sink, ax + dx * s, y, az + dz * s, bx + dx * s, y, bz + dz * s, 0.13, sr, sg, sb);
  }
  // diagonals: one zigzag per face, about every 1.8 m; ties across at every second node
  const span = it.right - it.left, n = Math.max(2, Math.round(span / 1.8)), step = span / n;
  for (let i = 0; i < n; i++) {
    const o0 = it.left + step * i, o1 = o0 + step;
    const p0x = cx + rx * o0, p0z = cz + rz * o0, p1x = cx + rx * o1, p1z = cz + rz * o1;
    const ya = i & 1 ? y1 : y0, yb = i & 1 ? y0 : y1;
    for (const s of [-hd, hd]) {
      bar(sink, p0x + dx * s, ya, p0z + dz * s, p1x + dx * s, yb, p1z + dz * s, 0.065, dr, dg, db);
    }
    if ((i & 1) === 0) {
      bar(sink, p0x - dx * hd, y0, p0z - dz * hd, p0x + dx * hd, y0, p0z + dz * hd, 0.06, dr, dg, db);
      bar(sink, p0x - dx * hd, y1, p0z - dz * hd, p0x + dx * hd, y1, p0z + dz * hd, 0.06, dr, dg, db);
    }
  }
  // the panels, on the face toward the oncoming traffic (-travel)
  if (!deco) return;
  const fx = -dx, fz = -dz, front = hd + 0.12;
  const yc = yr + GANTRY_CLEAR + GANTRY_PANEL_H / 2;
  for (const p of it.panels) {
    const px = cx + rx * p.off + fx * front, pz = cz + rz * p.off + fz * front;
    deco.panel(p.f, px, yc, pz, p.w, p.h, fx, fz, 'back');
    // two hangers per panel, from the bottom chord down its back
    for (const s of [-0.35, 0.35]) {
      const hx = px + rx * p.w * s - fx * 0.05, hz = pz + rz * p.w * s - fz * 0.05;
      bar(sink, hx, yc - p.h / 2 + 0.1, hz, hx - fx * (front - hd - 0.05), y1, hz - fz * (front - hd - 0.05), 0.06, dr, dg, db);
    }
  }
}

// ---- verge boards -------------------------------------------------------------
function boardInto(sink, deco, it, H) {
  const { cx, cz, dx, dz } = it;
  const rx = -dz, rz = dx, fx = -dx, fz = -dz;
  const yr = H(cx, cz);
  const px = cx + rx * it.off, pz = cz + rz * it.off;
  const yb = yr + it.y;                            // panel bottom
  const yt = yb + it.h;
  const [sr, sg, sb] = rgb(STEEL);
  const twin = it.w >= 2;
  const posts = twin ? [-(it.w / 2 - 0.45), it.w / 2 - 0.45] : [0];
  const rad = twin ? 0.07 : 0.05;
  const lowest = it.sub ? yb - 0.08 - it.sub.h : yb;
  for (const o of posts) {
    const qx = px + rx * o - fx * 0.09, qz = pz + rz * o - fz * 0.09;
    const g = clamp(H(qx, qz), yr - 6, yr + 0.8);
    drum(sink, qx, qz, g - 0.05, g + 0.12, rad * 1.8, rad * 1.4, 6, sr * 0.8, sg * 0.8, sb * 0.8, 1);
    post(sink, qx, qz, g + 0.12, yt - 0.06, rad, sr, sg, sb, 6);
  }
  if (!deco) return;
  deco.panel(it.f, px, yb + it.h / 2, pz, it.w, it.h, fx, fz, 'back');
  if (it.sub) deco.panel(it.sub.f, px, lowest + it.sub.h / 2, pz, it.sub.w, it.sub.h, fx, fz, 'back');
}

// ---- km board (kilometrovník) -------------------------------------------------
const KM_GW = 0.15, KM_GH = 0.24, KM_PAD = 0.07, KM_Y = 1.15;
function kmInto(sink, deco, it, H) {
  const { cx, cz, dx, dz } = it;
  const rx = -dz, rz = dx, fx = -dx, fz = -dz;
  const yr = H(cx, cz);
  const px = cx + rx * it.off, pz = cz + rz * it.off;
  const g = clamp(H(px, pz), yr - 5, yr + 0.6);
  const n = it.text.length, w = n * KM_GW + KM_PAD * 2, h = KM_GH + KM_PAD * 2;
  const yc = yr + KM_Y;
  const [sr, sg, sb] = rgb(STEEL);
  post(sink, px - fx * 0.05, pz - fz * 0.05, g, yc + h / 2 - 0.03, 0.035, sr, sg, sb, 6);
  if (!deco) return;
  deco.panel('kmplate', px, yc, pz, w, h, fx, fz, 'back');
  // the digits, a few millimetres proud of the plate, left to right as seen
  for (let i = 0; i < n; i++) {
    const o = -w / 2 + KM_PAD + KM_GW * (i + 0.5);
    // the viewer's right is (fz, -fx)
    deco.panel('k' + it.text[i], px + fz * o + fx * 0.006, yc, pz - fx * o + fz * 0.006, KM_GW, KM_GH, fx, fz);
  }
}

/**
 * Every motorway sign owned by chunk `key` into the chunk's sinks. `terrain`
 * answers heightAt(x, z) (js/terrain.js, or the worker's copy of it). `shell`: the far tier builds only what is seen
 * from beyond 600 m (gantries and the big boards), never the small posts.
 * Returns the number of items built.
 */
export function motorwaySignsInto(sink, deco, key, terrain, shell = false) {
  const items = plannedMotorwaySigns(key);
  if (!items.length || !terrain) return 0;
  const H = (x, z) => terrain.heightAt(x, z);
  const mark = sink.mark();
  let n = 0;
  for (const it of items) {
    if (it.t === 'gantry') gantryInto(sink, deco, it, H);
    else if (it.t === 'board') { if (shell && it.w < 2) continue; boardInto(sink, deco, it, H); }
    else if (it.t === 'km') { if (shell) continue; kmInto(sink, deco, it, H); }
    n++;
  }
  sink.fixFrom(mark);                              // absolute heights: the drape must skip them
  return n;
}

/**
 * The solid footprint of an item as discs [x, z, r, top], top in metres over
 * the road level at (it.cx, it.cz): the same positions the geometry above is
 * built at, so js/mwsolids.js stops a car exactly where the steel is.
 */
export function discsOf(it, out = []) {
  const { cx, cz, dx, dz } = it;
  const rx = -dz, rz = dx;
  if (it.t === 'gantry') {
    // each leg: its tube pair and footing, as two discs along the travel
    const top = GANTRY_CLEAR + 0.35 + TRUSS_H;
    for (const off of it.cant ? [it.right] : [it.left, it.right]) {
      const lx = cx + rx * off, lz = cz + rz * off;
      for (const s of [-0.45, 0.45]) out.push([lx + dx * s, lz + dz * s, 0.6, top]);
    }
  } else if (it.t === 'board') {
    const px = cx + rx * it.off, pz = cz + rz * it.off;
    const twin = it.w >= 2;
    const top = it.y + it.h;
    for (const o of twin ? [-(it.w / 2 - 0.45), it.w / 2 - 0.45] : [0]) {
      out.push([px + rx * o + dx * 0.09, pz + rz * o + dz * 0.09, twin ? 0.08 : 0.06, top]);
    }
  } else if (it.t === 'km') {
    const px = cx + rx * it.off, pz = cz + rz * it.off;
    out.push([px + dx * 0.05, pz + dz * 0.05, 0.04, KM_Y + 0.3]);
  }
  return out;
}
