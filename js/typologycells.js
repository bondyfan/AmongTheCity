// ---- typologycells.js: the facade atlas grid and the cell families ----
// Pure data (no three, no DOM), split out of typology.js, which re-exports all
// of it: the grid every facade and roof triangle samples, the trim bands and the
// cell families with the window positions both tiers cut and paint. Nothing
// here asks about a building; it is the vocabulary typology.js answers in.

// deterministic per-feature jitter, the same generator meshes.js and pieces.js use
export function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}

// ---- the atlas grid --------------------------------------------------------
// 8 x 8 cells of 256 px on a 2048 x 2048 canvas. One cell is ONE storey row by
// FOUR window bays (a cell cannot wrap-repeat, so walls split into runs of at
// most four bays). Row 0 is reserved: the plain plaster PIN cell every untextured
// triangle samples, five ROOF cells the facade shader tiles in metres, and a
// TRIM cell holding the parapet and cornice bands.
export const ATLAS_N = 8, ATLAS_M = 8, ATLAS_PX = 2048, BAYS = 4;
export const WIN_W = 2.7;
export const cellRect = (ci, ri) =>
  [ci / ATLAS_N, 1 - (ri + 1) / ATLAS_M, (ci + 1) / ATLAS_N, 1 - ri / ATLAS_M];
export const PIN_U = 0.5 / ATLAS_N, PIN_V = 1 - 0.5 / ATLAS_M;

// Roof surfaces. A roof triangle's (constant) uv only NAMES its surface: the
// atlas COLUMN 1..5 of row 0, and which of ROOF_ROWS thin bands of that row its
// v lands in. The facade shader reads the pair as an index into the roof
// atlas (js/roofatlas.js, its own texture: the facade atlas has no cell to
// spare) and lays the pattern out in metres. `m` is metres per repeat.
export const ROOF_ROWS = 4;
export const ROOF_STYLES = {
  tile:     { col: 1, m: 4.0 },   // fired clay pantile, in courses
  slate:    { col: 2, m: 4.0 },   // slate, eternit and fibre-cement, flat and thin
  bitumen:  { col: 3, m: 7.0 },   // torch-on felt sheets on a flat roof
  gravel:   { col: 4, m: 6.0 },   // ballast gravel
  metal:    { col: 5, m: 4.0 },   // standing seam sheet
  ctile:    { col: 1, row: 1, m: 4.0 },   // flat concrete tile
  copper:   { col: 2, row: 1, m: 4.8 },   // seamed copper gone green
  glass:    { col: 3, row: 1, m: 4.8 },   // patent glazing, and solar panels
  membrane: { col: 4, row: 1, m: 8.0 },   // pale welded sheet on a flat roof
  grass:    { col: 5, row: 1, m: 6.0 },   // a sedum roof
};
/** A style's cell in the roof atlas, which is also what the shader decodes. */
export const roofIndex = (style) => {
  const S = ROOF_STYLES[style];
  return (S.col - 1) + 5 * (S.row ?? 0);
};
export const roofPin = (style) => {
  const S = ROOF_STYLES[style];
  return [(S.col + 0.5) / ATLAS_N, 1 - ((S.row ?? 0) + 0.5) / (ATLAS_M * ROOF_ROWS)];
};
export const TRIM_CELL = [6, 0];
// The trim cell is four horizontal bands, top to bottom; a parapet or frieze
// quad samples exactly one of them.
export const TRIM_BANDS = { coping: 0, cornice: 1, metal: 2, eave: 3 };
export function trimRect(band) {
  const r = cellRect(TRIM_CELL[0], TRIM_CELL[1]);
  const h = (r[3] - r[1]) / 4;
  // inset a little so mips do not pull the next band in
  return [r[0], r[3] - (band + 1) * h + h * 0.06, r[2], r[3] - band * h - h * 0.06];
}

// ---- cell families ---------------------------------------------------------
// A family is one typology's paint: `mid` storey variants, optional `ground`
// and `top` rows (plinth, cornice), an optional blank `gable`, a `door` row.
// `band` is where the window sits in a storey measured FROM THE FLOOR UP, and
// `frac` how much of a 2.7 m bay it takes. pieces.js cuts its real opening from
// these numbers, facadeatlas.js paints the glass from them, so they are the one
// place a window's position is written down. `solid` families have no opening
// at all (the near shell builds them as whole painted panels).
export const FAMILIES = {
  panel:       { band: [0.30, 0.76], frac: 0.62, mid: 4, ground: 1, top: 1, gable: 1 },
  tenement:    { band: [0.22, 0.80], frac: 0.44, mid: 4, ground: 2, top: 1 },
  block:       { band: [0.29, 0.74], frac: 0.54, mid: 4, ground: 2, top: 2 },
  functional:  { band: [0.34, 0.74], frac: 0.74, mid: 2, ground: 1 },
  nova:        { band: [0.24, 0.88], frac: 0.60, mid: 1, ground: 1 },
  house:       { band: [0.30, 0.74], frac: 0.56, mid: 4, ground: 4 },
  brick:       { band: [0.29, 0.74], frac: 0.50, mid: 3 },
  civic:       { band: [0.24, 0.80], frac: 0.66, mid: 2, ground: 1 },
  officeBands: { band: [0.30, 0.88], frac: 0.91, mid: 2 },
  officeGrid:  { band: [0.20, 0.84], frac: 0.64, mid: 2 },
  hall:        { solid: true, mid: 3 },
  retail:      { solid: true, mid: 2 },
  garage:      { solid: true, mid: 1, door: 1 },
  church:      { solid: true, mid: 1 },
  parking:     { solid: true, mid: 1 },
  store:       { band: [0.055, 0.80], frac: 0.86, mid: 3, store: true },
};
// Every painted cell in atlas order: [family, role, variant]. Cell index 7 is
// the last cell of row 0, the first one the reserved cells leave free. The
// painter walks this list and so does CELL_OF.
export const CELL_LIST = [];
export const CELL_OF = {};
{
  let k = TRIM_CELL[0] + 1;
  for (const [fam, F] of Object.entries(FAMILIES)) {
    CELL_OF[fam] = {};
    for (const role of ['mid', 'ground', 'top', 'gable', 'door']) {
      const n = F[role] ?? 0;
      CELL_OF[fam][role] = [];
      for (let v = 0; v < n; v++, k++) {
        const ci = k % ATLAS_N, ri = (k / ATLAS_N) | 0;
        CELL_LIST.push({ fam, role, v, ci, ri });
        CELL_OF[fam][role].push([ci, ri]);
      }
    }
  }
  if (k > ATLAS_N * ATLAS_M) throw new Error('typology: the facade atlas is over-subscribed');
}

// Balcony bays of each panel mid variant (bay 0..3 of a four-bay cell). The
// painter draws a loggia front there and pieces.js hangs its balcony boxes on
// the same bays, so the paint and the boxes land on the same windows.
export const PANEL_BALC = [[0, 1, 1, 0], [1, 0, 0, 1], [0, 0, 1, 0], [0, 1, 0, 1]];
// French-balcony rails of the novostavba cell, by bay.
export const NOVA_RAIL = [1, 0, 1, 1];
// A family house has fewer windows than it has 2.7 m bays: one bay in four is
// blank wall, a different one per variant. Painter and shell both read this.
export const HOUSE_BLANK = [[0, 0, 1, 0], [0, 1, 0, 0], [0, 0, 0, 1], [1, 0, 0, 0]];
