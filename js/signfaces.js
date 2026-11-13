// ---- signfaces.js: where each face lives on the street atlas ----------------
// One 1024 x 1024 canvas (painted by js/signatlas.js on the main thread) holds
// every picture a street needs: the Czech road signs, the grey backs of the
// same plates, four posters for the lit panel of a bus shelter, a timetable and
// a pane of glass. This file is only the MAP of that canvas, as plain numbers,
// so the chunk mesher (which also runs in a worker, where there is no canvas)
// can write uvs for a picture it never sees.
//
// A sign cell is 128 px square and its glyph keeps an 8 px clear margin, so a
// mip level four steps down still does not bleed into its neighbour.

export const ATLAS_PX = 1024;
export const SIGN_PX = 128;
/** Side of the quad a sign cell is drawn on, metres (the glyph itself is 7/8 of it). */
export const SIGN_M = 0.88;

// shape of the plate: what the grey back is cut to
export const SIGNS = {
  give_way: [0, 0, 'tri'], stop: [1, 0, 'oct'], main_road: [2, 0, 'diamond'], no_entry: [3, 0, 'disc'],
  one_way: [4, 0, 'square'], speed30: [5, 0, 'disc'], speed50: [6, 0, 'disc'], speed70: [7, 0, 'disc'],
  crossing: [0, 1, 'square'], roundabout: [1, 1, 'disc'], parking: [2, 1, 'square'], bus: [3, 1, 'square'],
  zone30: [4, 1, 'tall'], dead_end: [5, 1, 'square'], speed90: [6, 1, 'disc'], main_end: [7, 1, 'diamond'],
};
/** Sign backs are the same grid, this many pixels further down the canvas. */
export const BACK_DY = 512;

// everything that is not a sign, as [x, y, w, h] in canvas pixels
export const PANELS = {
  ad0: [0, 256, 128, 192], ad1: [128, 256, 128, 192], ad2: [256, 256, 128, 192], ad3: [384, 256, 128, 192],
  timetable: [520, 264, 64, 96],
  glass: [608, 272, 48, 48],
  // a blank plate colour, for the edge of a panel
  frame: [680, 280, 16, 16],
};
/** How many posters there are (a shelter picks one by hash). */
export const AD_COUNT = 4;

const _uv = [0, 0, 0, 0];
/**
 * [u0, v0, u1, v1] of a cell: v0 is its BOTTOM edge (the canvas is uploaded
 * flipped, as three does by default). `back:<sign>` names the grey back of a
 * sign. Returns one shared array: read it before asking again.
 */
export function cellUV(name) {
  let x, y, w, h;
  const back = name.startsWith('back:');
  const sg = SIGNS[back ? name.slice(5) : name];
  if (sg) { x = sg[0] * SIGN_PX; y = sg[1] * SIGN_PX + (back ? BACK_DY : 0); w = h = SIGN_PX; }
  else {
    const p = PANELS[name] ?? PANELS.frame;
    x = p[0]; y = p[1]; w = p[2]; h = p[3];
  }
  const e = 0.5;       // half a texel in from the edge
  _uv[0] = (x + e) / ATLAS_PX; _uv[1] = 1 - (y + h - e) / ATLAS_PX;
  _uv[2] = (x + w - e) / ATLAS_PX; _uv[3] = 1 - (y + e) / ATLAS_PX;
  return _uv;
}
