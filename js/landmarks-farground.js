// ---- landmarks-farground.js: the hills the far skyline stands on ----
// MAIN-THREAD data, worker-safe code (pure kit over a height field).
// Beyond the streamed ring nothing is drawn, so the far castle hung in the
// sky over Malá Strana with blue under its walls (seen in game from Charles
// Bridge). The castle hill, Petřín and the Vyšehrad rock are therefore also
// built coarsely, from the SAME terrain the city stands on (js/terrain.js,
// 30 m cells), coloured as the eye reads them from a kilometre: wooded
// slopes, gardens on the ridge, roofs in the valley, water in the river bed.
// It is drawn with the far material, so it is discarded where the streamed
// ground is, and it lies 1.2 m under the terrain, so where both are drawn
// the real ground wins the depth test.

import { K, hash2 } from './landmarkskit.js';

/** The rectangles [x0, z0, x1, z1] of ground the far skyline carries. */
export const FAR_GROUND = [
  { id: 'hradcany', box: [-98100, -7300, -95700, -5200] },
  { id: 'vysehrad', box: [-96250, -4000, -95450, -3300] },
];
const CELL = 30, SINK = 1.2;

/** Is the height field there for the whole box (a missing tile would read as a hole at sea level)? */
export function groundReady(terrain, box) {
  const [x0, z0, x1, z1] = box;
  for (let x = x0; x <= x1; x += 600) for (let z = z0; z <= z1; z += 600) if (!terrain.ready(Math.min(x, x1), Math.min(z, z1))) return false;
  return !!terrain.ready(x1, z1);
}

/** One box of far ground into a kit whose ground is 0 (absolute heights). */
export function buildFarGround(kit, terrain, box) {
  const [x0, z0, x1, z1] = box;
  const nx = Math.round((x1 - x0) / CELL), nz = Math.round((z1 - z0) / CELL);
  const H = new Float32Array((nx + 1) * (nz + 1));
  for (let j = 0; j <= nz; j++) for (let i = 0; i <= nx; i++) H[j * (nx + 1) + i] = terrain.heightAt(x0 + i * CELL, z0 + j * CELL) - SINK;
  const at = (i, j) => H[j * (nx + 1) + i];
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = at(i, j), b = at(i + 1, j), c = at(i + 1, j + 1), d = at(i, j + 1);
    const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d), slope = (hi - lo) / CELL;
    const h = hash2(i + Math.round(x0 / CELL), j + Math.round(z0 / CELL), 77);
    let hex;
    if (hi < 187.5) hex = 0x55666c;                               // the river
    else if (slope > 0.16) hex = h < 0.8 ? 0x435c37 : 0x50683f;   // wooded slopes
    else if (lo > 232) hex = h < 0.55 ? 0x56713f : h < 0.8 ? 0x8f8a80 : 0xa1563f;   // the ridge: gardens and roofs
    else hex = h < 0.42 ? 0x9d553d : h < 0.7 ? 0x86827a : h < 0.86 ? 0x4f6a3d : 0xb8ad98;  // the town below
    kit.set(hex, K.metal);
    const X = x0 + i * CELL, Z = z0 + j * CELL;
    kit.quad([X, a, Z], [X + CELL, b, Z], [X + CELL, c, Z + CELL], [X, d, Z + CELL], 0, 1, 0);
  }
}
