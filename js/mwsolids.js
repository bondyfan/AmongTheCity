// ---- mwsolids.js: the motorway signs are solid ----
// Gantry legs and sign posts as a static grid of discs, built once from the
// sign plan (js/mwsigns.js, through mwsignmesh.discsOf so the discs stand
// exactly where the steel is drawn). Main thread only; city.collide asks it.
//
// NOT through js/poles.js: a pole there can be struck and felled
// (vehicles.js strike), and a car at 130 km/h does not fell a gantry.
// A plan is a pure function of the d11 constants, so every client has the
// same solids whatever its tiles did.

import { allMotorwaySigns, SIGN_TILES } from './mwsigns.js';
import { discsOf } from './mwsignmesh.js';

const CELL = 20;
let GRID = null;                 // Map cellKey -> [[x, z, r, top, cx, cz], ...]
const ck = (i, j) => (i + 32768) * 65536 + (j + 32768);

function grid() {
  if (GRID) return GRID;
  GRID = new Map();
  const tmp = [];
  for (const it of allMotorwaySigns()) {
    tmp.length = 0;
    for (const d of discsOf(it, tmp)) {
      const rec = [d[0], d[1], d[2], d[3], it.cx, it.cz];
      const i0 = Math.floor((d[0] - d[2]) / CELL), i1 = Math.floor((d[0] + d[2]) / CELL);
      const j0 = Math.floor((d[1] - d[2]) / CELL), j1 = Math.floor((d[1] + d[2]) / CELL);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = ck(i, j);
        let a = GRID.get(k);
        if (!a) GRID.set(k, a = []);
        a.push(rec);
      }
    }
  }
  return GRID;
}

/** Discs whose reach (r + radius) could touch (x, z). For tests and debugging. */
export function mwDiscsNear(x, z) {
  return grid().get(ck(Math.floor(x / CELL), Math.floor(z / CELL))) ?? [];
}

/**
 * Push `pos` ({x, z}) of a body of `radius` out of any sign leg or post.
 * `aboveY` (optional): the body's own height; a disc whose top is below it is
 * flown over (`world` answers heightAt for the road level then). Mutates pos,
 * returns true if it moved, like world.collide.
 */
let _tx = NaN, _tz = NaN, _tin = false;   // the last tile asked about: a key string per tile change, not per call
export function mwCollide(pos, radius, aboveY, world) {
  // nowhere near the motorway (Pardubice, Prague): no grid, no plan built
  const tx = Math.floor(pos.x / 4800), tz = Math.floor(pos.z / 4800);
  if (tx !== _tx || tz !== _tz) { _tx = tx; _tz = tz; _tin = SIGN_TILES.has(tx + ',' + tz); }
  if (!_tin && !GRID) return false;
  const g = grid();
  // a body is at most a few metres across: its own cell and the eight around
  const ci = Math.floor(pos.x / CELL), cj = Math.floor(pos.z / CELL);
  let pushed = false;
  for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
    const a = g.get(ck(i, j));
    if (!a) continue;
    for (let k = 0; k < a.length; k++) {
      const d = a[k], rr = d[2] + radius;
      const ex = pos.x - d[0], ez = pos.z - d[1], d2 = ex * ex + ez * ez;
      if (d2 >= rr * rr) continue;
      if (aboveY !== undefined && world && world.heightAt(d[4], d[5]) + d[3] <= aboveY) continue;
      if (d2 < 1e-9) { pos.x = d[0] + rr; pushed = true; continue; }
      const L = Math.sqrt(d2);
      pos.x = d[0] + ex / L * rr; pos.z = d[1] + ez / L * rr;
      pushed = true;
    }
  }
  return pushed;
}
