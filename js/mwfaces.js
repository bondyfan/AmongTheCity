// ---- mwfaces.js: where each motorway sign face lives on its atlas ----
// The MAP of the one canvas js/mwatlas.js paints (main thread only), as plain
// numbers, so the chunk mesher (main thread and mesh worker alike) can write
// uvs for a picture it never sees. Pure: the face list comes from the sign
// planner (js/mwsigns.js), which is a function of the d11 constants, and the
// layout below is a function of that list, so every thread computes the same
// rectangles.
//
// Pixel sizes follow the panel sizes in metres (mwsigns SIZE) at about 58 px
// per metre: four times what a 1600 px wide screen resolves of a 4 m panel at
// 80 m, enough to read it at 20 m without the atlas costing more than one
// 2048 px wide texture.

import { motorwayFaces } from './mwsigns.js';

export const MW_ATLAS_W = 2048;
// The atlas height, FIXED rather than read off the layout: the material is made
// at boot (meshes.js makeMaterials) and its canvas needs its final size then,
// and asking the layout would plan the whole motorway (20 to 30 ms) on every
// boot, also for a player who never leaves Pardubice. tests/mwsigns.test.mjs
// checks the layout still fits.
export const MW_ATLAS_H = 1792;
const PAD = 4;                       // px between cells: a mip three steps down stays its own

/** Pixel size [w, h] of a face, by its type. */
export const FACE_PX = {
  exit: [232, 152], thru: [264, 150], rest: [232, 144], dist: [232, 116], gore: [116, 88],
  ip15: [96, 96], plate: [128, 32], kmplate: [64, 48], glyph: [32, 48], back: [16, 16],
};

let LAYOUT = null;   // { rects: Map key -> [x, y, w, h], h }

// Shelf packing, tallest first, ties in the planner's order: deterministic.
function layout() {
  if (LAYOUT) return LAYOUT;
  const faces = [...motorwayFaces().entries()].map(([k, s], i) => ({ k, s, i, px: FACE_PX[s.type] }));
  faces.sort((a, b) => (b.px[1] - a.px[1]) || (a.i - b.i));
  const rects = new Map();
  let x = 0, y = 0, rowH = 0;
  for (const f of faces) {
    const [w, h] = f.px;
    if (x + w > MW_ATLAS_W) { x = 0; y += rowH + PAD; rowH = 0; }
    rects.set(f.k, [x, y, w, h]);
    x += w + PAD;
    if (h > rowH) rowH = h;
  }
  return (LAYOUT = { rects, h: y + rowH });
}

/** Height in px the layout actually uses (at most MW_ATLAS_H, the canvas height). */
export function mwAtlasH() { return layout().h; }
/** Every face rectangle, key -> [x, y, w, h] in canvas pixels (y down). */
export function mwRects() { return layout().rects; }

const _uv = [0, 0, 0, 0];
/**
 * [u0, v0, u1, v1] of face `key`: v0 is its BOTTOM edge (the canvas is uploaded
 * flipped, as three does by default). Shared array: read it before asking again.
 */
export function mwUV(key) {
  const L = layout();
  const r = L.rects.get(key) ?? L.rects.get('back');
  const e = 0.5, W = MW_ATLAS_W, H = MW_ATLAS_H;
  _uv[0] = (r[0] + e) / W; _uv[1] = 1 - (r[1] + r[3] - e) / H;
  _uv[2] = (r[0] + r[2] - e) / W; _uv[3] = 1 - (r[1] + e) / H;
  return _uv;
}
