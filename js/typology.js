// ---- typology.js: what KIND of Czech building a footprint is ----
// Pure data. No three.js, no DOM, nothing that cannot run in the mesh worker or
// in a headless test. Everything in here is a function of the feature (its id,
// its footprint, its tile tags) and nothing else, because three different
// renderers have to agree on the answers:
//
//   meshes.js   paints the far tier (one merged mesh per chunk),
//   pieces.js   builds the near shell out of boxes,
//   facadeatlas.js paints the texture cells both of them sample.
//
// If any of the three asked its own question, a building would change face at
// the 160 m swap. So the questions live here: which typology, which atlas
// cells per storey row and per edge, which roof, which windows are lit.

import { polygonArea, pointInPolygon } from './geo.js';
import { roofFromData, ridgeTurn, wallFamily, photoSaysTiled, dataBacksPitch } from './roofdata.js';
import { hasCourtyard } from './roofholes.js';
import { praguePlace, inOldTown } from './praguezone.js';
import { blockCorner } from './partywalls.js';
import { pragueRoof } from './roofgrammar.js';

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
const CELL_OF = {};
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

// ---- footprint shape -------------------------------------------------------
// Oriented bounding box by the longest edge (interiors.frameOf's own rule), the
// fill ratio and whether the outline is a plain rectangle. Cached: plain data.
export function shapeOf(f) {
  if (f._shape) return f._shape;
  const ring = f.o;
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    if (L2 > best) { best = L2; const L = Math.sqrt(L2); ux = dx / L; uz = dz / L; }
  }
  const vx = uz, vz = -ux;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const pu = x * ux + z * uz, pv = x * vx + z * vz;
    if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
    if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
  }
  const L = u1 - u0, W = v1 - v0;
  const area = Math.abs(polygonArea(ring));
  const fill = L * W > 1e-6 ? area / (L * W) : 0;
  return (f._shape = {
    ux, uz, vx, vz, L, W, area, fill,
    cu: (u0 + u1) / 2, cv: (v0 + v1) / 2,
    long: Math.max(L, W), short: Math.min(L, W),
    rect: fill > 0.9 && ring.length <= 6,
  });
}

const levelsOf = (f) => f.lv ?? Math.max(1, Math.round((f.h ?? 6) / 3.1));
const pitchedTag = (f) => !!f.r && f.r !== 'flat';
// neighbourhoods are coherent: one 240 m block of town leans one way
const zoneRnd = (f, salt) => {
  const p = f.o[0];
  return rnd((Math.floor(p[0] / 240) * 7919 + Math.floor(p[1] / 240) * 104729) | 0, salt);
};

/**
 * typologyOf(f, use) -> one of
 *   panel, tenement, block, functional, nova, house, brick, hall, barn, retail,
 *   shop, pavilion, office, civic, church, garage, parking
 * `use` is interiors.classify(f): what the building is FOR. This answers what
 * it is BUILT LIKE, from the storey count, the footprint and the roof tag.
 */
export function typologyOf(f, use) {
  if (f._typ) return f._typ;
  const lv = levelsOf(f), S = shapeOf(f), pitched = pitchedTag(f);
  let t;
  const housing = () => {
    // The slab and the tower. Nothing in the tiles says "panel" (the OSM tag
    // does not occur), but a ruler-drawn rectangle of five storeys and up under
    // a flat roof is prefab housing in this country nine times in ten, and
    // nine storeys and up always. The rectangle matters: the same height and
    // roof on an irregular plot, or around a courtyard, is a city block (the
    // whole of central Prague), and it must not grow loggias.
    if (lv >= 9 || (lv >= 5 && !pitched && S.rect && !(f.i?.length))) return 'panel';
    // Prague's slabs of five to eight storeys are drawn with a jog or two in
    // the outline (stair towers, a staggered section), so they missed the
    // rectangle test and became city blocks: a slab is still long, narrow,
    // nearly full and flat (433 in the centre, 2 201 in the estates, measured)
    if (lv >= 5 && !pitched && !(f.i?.length) && S.fill >= 0.9 && f.o.length <= 12
        && S.long >= 2.2 * S.short && S.short <= 16 && praguePlace(f)) return 'panel';
    if (pitched && lv >= 2) {
      // An old-town house is an irregular plot; a 1950s block is a ruler-drawn
      // rectangle. Five storeys under a pitched roof is a tenement either way.
      const p = (S.rect ? 0.38 : 0.85) + (lv >= 5 ? 0.3 : 0) + (zoneRnd(f, 3) - 0.5) * 0.7;
      return rnd(f._id, 91) < p ? 'tenement' : 'block';
    }
    if (lv >= 3) return rnd(f._id, 92) < (lv >= 5 ? 0.45 : 0.3) + (zoneRnd(f, 4) - 0.5) * 0.4 ? 'functional' : 'block';
    return lv >= 2 || S.area > 260 ? 'block' : 'house';
  };
  switch (use) {
    case 'flats': t = f._nova ? 'nova' : housing(); break;
    case 'hotel': t = housing(); break;
    // A narrow Prague town house of three storeys under its pitched roof, or
    // one built wall to wall between two neighbours, is a town house, not a
    // villa with an overhang and one chimney (230 in the centre, measured)
    case 'house': {
      const party = f._pw && f._pw.length === f.o.length ? f._pw.filter((h) => h > 0).length : 0;
      t = (lv >= 3 && pitched || party >= 2 && lv >= 2) && praguePlace(f) ? housing() : 'house';
      break;
    }
    // An office in a Prague town house under its surveyed pitched roof is a
    // Gruenderzeit or baroque house let to offices, not a curtain wall.
    case 'office': t = pitched && lv <= 8 && praguePlace(f) ? housing() : 'office'; break;
    case 'school': case 'hospital': case 'civic': t = 'civic'; break;
    case 'church': t = 'church'; break;
    case 'garage': t = 'garage'; break;
    case 'parking': t = 'parking'; break;
    case 'restaurant': t = 'pavilion'; break;
    case 'supermarket': case 'mall': t = 'retail'; break;
    case 'shop':
      t = lv >= 2 ? housing() : (S.area >= 320 ? 'retail' : 'shop');
      break;
    case 'industrial':
      t = (f.t === 'barn' || f.t === 'farm_auxiliary') ? 'barn'
        : (f.t === 'manufacture' || (pitched && S.area < 1400 && rnd(f._id, 93) < 0.45)) ? 'brick'
        : 'hall';
      break;
    default: t = 'block';
  }
  return (f._typ = t);
}

// ---- wall colours ----------------------------------------------------------
// The plaster a typology actually wears. A revitalised panelak is pastel, an
// old-town tenement ochre or salmon, a hall silver sheet. Used when the data
// carries no colour of its own.
export const TYPO_WALLS = {
  panel: [0xecdca0, 0xe8c79c, 0xcde0be, 0xc4d8e6, 0xe4e2da, 0xc6c8c8, 0xeee2c2, 0xe2b99a, 0xd0d4d6,
    0xf0d9a8, 0xd9e4c8],
  tenement: [0xe3d2a8, 0xd9c08a, 0xe6dccb, 0xd8b9a0, 0xc9d1b8, 0xd6d6cf, 0xc8b99a, 0xe0c9b6,
    0xbfc8d0, 0xd2c4a0],
  block: [0xd9cfc0, 0xcfc4b2, 0xc9c9c4, 0xd4c8ae, 0xbfb9ad, 0xd6c6b0, 0xcdd0c4, 0xdccfa8],
  functional: [0xe9e6dd, 0xdedad0, 0xd2cfc6, 0xe3dcc8],
  house: [0xf0ebe0, 0xe9dfc8, 0xe6d3a3, 0xd9c7a8, 0xcfd8c4, 0xe2c4a8, 0xd4d4d0, 0xc7b299,
    0xb9b5ac, 0xede2c4, 0xdcd2b8],
  brick: [0xa8644a, 0x9a5a44, 0xb07a5c, 0x8c5a48, 0xa06a52],
  hall: [0xb9bdc2, 0xa8adb3, 0xc9cbc6, 0x8f9aa6, 0xb5b0a2, 0x9aa58f, 0xc2c6ca],
  barn: [0xcfc6b2, 0xbdb3a0, 0xc9bca6, 0xa89c8a],
  retail: [0xe4e2da, 0xd9d6cc, 0xcfd2d4, 0xdcd8cc],
  shop: [0xd8cfbf, 0xcfc8b8, 0xdcd4c4, 0xc9c2b4],
  pavilion: [0xcfc9bd, 0xbfb9ad],
  civic: [0xdcd6c8, 0xe2d8c0, 0xd6cdb8, 0xcfc8b8, 0xe0d2b4],
  church: [0xe4ded0, 0xe8dcc0],
  garage: [0x9d9d98, 0xa8a49c, 0xb0a898, 0x8f8a80, 0xb5b1a8],
  parking: [0xa9aaa6, 0xb5b5b0],
};

// ---- which cells a building wears -----------------------------------------
const FAMILY_OF = {
  panel: 'panel', tenement: 'tenement', block: 'block', functional: 'functional',
  nova: 'nova', house: 'house', brick: 'brick', hall: 'hall', barn: 'hall',
  retail: 'retail', shop: 'block', pavilion: 'retail', civic: 'civic',
  church: 'church', garage: 'garage', parking: 'parking',
};
const STORE_TYPES = new Set(['retail', 'commercial', 'supermarket', 'kiosk', 'hotel']);
// the ground-floor trades that put glass on the street
const TRADE_RE = /^(office|bank|post_office|school|kindergarten|library|townhall|museum|hotel|place_of_worship|parking|hospital|clinic|doctors|college|university)$/;
export const hasShopfront = (f, use) =>
  use === 'shop' || use === 'supermarket' || use === 'mall' || use === 'restaurant'
  || (STORE_TYPES.has(f.t) && use !== 'office' && use !== 'hotel' && use !== 'industrial')
  || (!!f.u && !TRADE_RE.test(f.u));

/**
 * The ONE rule for a building's facade: which atlas cells per storey row, where
 * the windows are, which ground-floor edges are shopfront. Indices only, the
 * caller turns them into uv rectangles. `office` is 'bands' | 'grid' for the
 * curtain-wall grammars, anything else is ignored.
 */
export function facadeRows(f, use, office) {
  const typ = typologyOf(f, use);
  let famName = typ === 'office' ? (office === 'grid' ? 'officeGrid' : 'officeBands')
    : (FAMILY_OF[typ] ?? 'block');
  // A tagged wall material repaints the facade where one family IS that
  // material (building:material = brick, glass). Only a windowed wall changes:
  // a hall stays sheet and a church stays a church whatever it is built of,
  // and an office already wears its curtain wall.
  const wf = wallFamily(f);
  if (wf && typ !== 'office' && !FAMILIES[famName].solid) famName = wf;
  const F = FAMILIES[famName], C = CELL_OF[famName];
  const v = Math.floor(rnd(f._id, 9) * 4096);
  const pick = (list) => (list.length ? list[v % list.length] : null);
  const row = (cell, fam = F, extra) => cell && {
    cell, band: fam.band ?? null, frac: fam.frac ?? 0, solid: !!fam.solid, store: !!fam.store,
    ...extra,
  };
  const mid = row(pick(C.mid));
  const rows = {
    typ, family: famName, variant: v,
    mid,
    ground: row(pick(C.ground)),
    top: row(pick(C.top)),
    gable: row(pick(C.gable), { solid: true }),
    door: row(pick(C.door), { solid: true }),
    store: null, front: null,
    // panelak balcony bays, read by the painter's twin in pieces.js
    balc: famName === 'panel' ? PANEL_BALC[(v % F.mid)] : null,
    // bays with no window at all (family houses)
    blank: famName === 'house' ? HOUSE_BLANK[v % F.mid] : null,
    // the walls shared with a neighbour (js/partywalls.js), per outer edge
    party: f._pw && f._pw.length === f.o.length ? f._pw : null,
    // which trim band the parapet or frieze wears
    trim: typ === 'tenement' || typ === 'civic' || typ === 'church' ? TRIM_BANDS.cornice
      : typ === 'hall' || typ === 'retail' || typ === 'pavilion' || typ === 'office'
        || typ === 'nova' || typ === 'parking' ? TRIM_BANDS.metal
      : typ === 'house' || typ === 'barn' || typ === 'garage' ? TRIM_BANDS.eave
      : TRIM_BANDS.coping,
  };
  // The Prague corner shop: where a tenement block turns a street corner,
  // half of them keep a potraviny or a pub in the ground floor, glazed on both
  // corner walls, whether or not the map names it (salt 140).
  let corner = -1;
  if (!hasShopfront(f, use) && typ === 'tenement' && levelsOf(f) >= 4 && rnd(f._id, 140) < 0.5
      && praguePlace(f)) corner = blockCorner(f);
  if (corner >= 0) {
    const n = f.o.length;
    rows.store = row(CELL_OF.store.mid[v % 2], FAMILIES.store);
    rows.front = 'corner';
    rows.corner = [(corner - 1 + n) % n, corner];
  } else if (hasShopfront(f, use)) {
    const S = CELL_OF.store.mid;
    // big boxes glaze their entrance front, small shops the whole ground floor
    const big = typ === 'retail' && use !== 'mall';
    rows.store = row(big ? S[2] : S[v % 2], FAMILIES.store);
    rows.front = use === 'restaurant' ? 'ent3'
      : big || (use !== 'shop' && use !== 'mall') ? 'ent' : 'all';
  }
  return rows;
}

// A wall too short to hold a window: bare plaster, no pane, no light. Footprints
// come with 30 cm jogs in them, and one bay "per edge" used to squeeze a whole
// window onto each.
export const STUB_EDGE = 1.7;
const PLAIN_ROW = { cell: [0, 0], uv: cellRect(0, 0), band: null, frac: 0, solid: true,
  store: false, plain: true };

// Edge roles, shared by both tiers: 0 windowed wall, 1 shopfront, 2 blank gable,
// 3 the garage-door front, 4 a stub too short for a window, 5 a party wall
// (shared with the house next door: blank plaster, never a front).
export const PARTY_ROLE = 5;
export function edgeRoles(ring, rows, entI) {
  const n = ring.length, out = new Uint8Array(n);
  const party = rows.party && rows.party.length === n ? rows.party : null;
  let longest = 0;
  const len = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    len[i] = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // (the street front is the longest wall that is not a neighbour's)
    if (len[i] > longest && !(party && party[i] > 0)) longest = len[i];
  }
  const hasEnt = entI !== undefined && entI !== null && entI >= 0;
  for (let i = 0; i < n; i++) {
    if (len[i] < STUB_EDGE) { out[i] = 4; continue; }
    if (party && party[i] > 0) { out[i] = PARTY_ROLE; continue; }
    if (rows.front) {
      let fr;
      if (rows.front === 'all') fr = len[i] >= 2.2;
      else if (rows.front === 'corner') fr = i === rows.corner[0] || i === rows.corner[1];
      else if (hasEnt) {
        const d = Math.min((i - entI + n) % n, (entI - i + n) % n);
        fr = d === 0 || (rows.front === 'ent3' && d === 1);
      } else fr = len[i] === longest;
      if (fr) { out[i] = 1; continue; }
    }
    if (rows.door && hasEnt && i === entI) { out[i] = 3; continue; }
    // a panelak's end wall is blank: the short edges of an elongated slab
    if (rows.gable && len[i] < longest * 0.72 && len[i] <= 14.5) out[i] = 2;
  }
  return out;
}

/** The row a wall run samples: storey `s` of `storeys`, on an edge of `role`. */
export function rowFor(rows, s, storeys, role) {
  if (role === 4 || role === PARTY_ROLE) return PLAIN_ROW;
  if (role === 2 && rows.gable) return rows.gable;
  if (s === 0) {
    if (role === 1 && rows.store) return rows.store;
    if (role === 3 && rows.door) return rows.door;
    if (rows.ground) return rows.ground;
  }
  if (s === storeys - 1 && storeys >= 2 && rows.top) return rows.top;
  return rows.mid;
}

// ---- roofs -----------------------------------------------------------------
// Czech roofs: fired clay in every shade between new orange and a century of
// soot, brown and anthracite concrete tile on anything built after 1990, grey
// eternit on the cottages nobody re-roofed; dark felt, gravel or a pale
// membrane on the flat ones. The palette is weighted, and a neighbourhood
// leans one way, which is how a village comes out red from the air.
const TILE_HEX = [0xa5553b, 0x9c5a44, 0xb0603f, 0x8f4e3c, 0xa86a4c, 0x96563f, 0xb5694a,   // clay
  0x6e4a3a, 0x604236, 0x7a5444,                                                         // brown
  0x4a4b4f, 0x54555a, 0x45464a,                                                         // anthracite
  0x7d7f80, 0x8a8a86];                                                                  // grey
const FLAT_HEX = { bitumen: [0x4d4e50, 0x56565a, 0x5e5c58, 0x48494b],
  gravel: [0x8f8b82, 0x9a968c, 0x85837c, 0xa29f96],
  membrane: [0xb1b3b2, 0xa5a8a8, 0xbcbdb9] };
const METAL_HEX = [0x7f868c, 0x8d9296, 0x6c7378, 0x9a9d9c, 0x5d646a];
// the typologies a red photograph may hand a pitched roof to (a hall or a
// garage that reads red is painted sheet or mineral felt, not clay)
const PHOTO_PITCH = new Set(['block', 'functional', 'tenement', 'civic', 'shop', 'house', 'brick']);
const CAPPED = new Set(['mansard', 'gambrel', 'round', 'dome', 'onion', 'many', 'hip-and-gable',
  'cone', 'gabled_row', 'crosspitched', 'sawtooth']);

/**
 * roofOf(f, typ) -> { shape, style, hex, ov, src, rise?, attic?, low?, swap?, flip? }
 * shape: flat | gable | hip | halfhip | pyramid | mono | cap
 * style and hex come from the tile where it knows (roofdata.roofFromData: the
 * roof:colour tag, the colour read off the aerial photo, roof:material) and
 * from the procedural palette below where it does not; `src` says which.
 * The optional fields are the tagged roof geometry (roofs.js reads them):
 * rise in metres (roof:height), attic storeys (roof:levels >= 1) or `low`
 * (roof:levels = 0), and how the ridge is turned (roof:direction/orientation).
 * `cap` is the inward-offset roof that follows an L or a courtyard block. A
 * rectangle gets a real ridge whatever its size, which is what closes the two
 * gaps the old rule had: small hipped and pyramidal roofs fell flat, and every
 * gabled house over 300 m2 was given a hip.
 */
export function roofOf(f, typ) {
  if (f._roof) return f._roof;
  const S = shapeOf(f), r = f.r;
  let shape = 'flat';
  // (a new-build or a pavilion is flat by default, but those two stamps come
  // partly from a hash: where the tile backs its roof shape with a second
  // witness, roofdata.dataBacksPitch, the mapped roof wins)
  // Prague's roof shapes are IPR's survey (strecha), not a builder's guess, so
  // inside the city a pitched tag is its own witness (praguezone.js; the tile
  // carries no "surveyed" mark, the place is the only evidence at run time).
  const flatType = typ === 'retail' || typ === 'office';
  const hashFlat = (typ === 'nova' || typ === 'pavilion') && !dataBacksPitch(f);
  const forceFlat = typ === 'panel' || typ === 'parking'
    || ((flatType || hashFlat) && !praguePlace(f));
  if (r && r !== 'flat' && !forceFlat) {
    // a ridge needs something like a rectangle under it, and a span a real
    // truss could cross; everything else follows its own outline
    const ridge = S.fill > 0.8 && S.short <= 24 && S.short >= 1.6;
    if (r === 'skillion' || r === 'lean_to') shape = ridge ? 'mono' : 'cap';
    else if (CAPPED.has(r)) shape = 'cap';
    else if (!ridge) shape = 'cap';
    else if (r === 'pyramidal') shape = 'pyramid';
    else if (r === 'hipped' || r === 'side_hipped') shape = S.long < S.short * 1.25 ? 'pyramid' : 'hip';
    else if (r === 'half-hipped' || r === 'side_half-hipped') shape = 'halfhip';
    else shape = 'gable';                  // gabled, saltbox, anything unnamed
    // A ridge or a lean-to over a block with a real courtyard would roof the
    // yard over; only the offset roof can follow the yard's own ring
    // (roofholes.js). Small light wells stay under the ridge.
    if (shape !== 'cap' && hasCourtyard(f)) shape = 'cap';
  } else if (!r && !forceFlat && PHOTO_PITCH.has(typ) && S.area <= 2500 && photoSaysTiled(f)) {
    // No shape in the tile (the builder leaves commercial types and five
    // storeys and up flat), but the roof is fired-clay red from the air, and
    // nothing flat is. So it gets the pitched roof it was photographed with.
    shape = S.fill > 0.8 && S.short <= 24 && S.short >= 1.6 ? 'gable' : 'cap';
  }
  let style, hex, src = 'proc';
  const id = f._id;
  const data = roofFromData(f, shape === 'flat', typ, rnd(id, 66), rnd(id, 67));
  if (data) {
    ({ style, hex, src } = data);
  } else if (shape === 'flat') {
    const k = rnd(id, 61);
    const pale = typ === 'retail' || typ === 'nova' || typ === 'pavilion' || typ === 'office';
    const kind = pale ? (k < 0.6 ? 'membrane' : 'gravel')
      : typ === 'hall' || typ === 'garage' ? (k < 0.7 ? 'bitumen' : 'membrane')
      : (k < 0.55 ? 'bitumen' : 'gravel');
    style = kind === 'bitumen' ? 'bitumen' : 'gravel';
    const pal = FLAT_HEX[kind];
    hex = pal[Math.floor(rnd(id, 62) * pal.length) % pal.length];
  } else if (typ === 'hall' || typ === 'barn' && rnd(id, 63) < 0.4) {
    style = 'metal';
    hex = METAL_HEX[Math.floor(rnd(id, 62) * METAL_HEX.length) % METAL_HEX.length];
  } else {
    // weighted pick: the zone decides how red this part of town is
    // (the old town of Prague is all clay from the castle: nearly nothing
    // there was ever re-roofed in concrete or eternit)
    const red = praguePlace(f) && inOldTown(f) ? 0.9
      : 0.5 + (zoneRnd(f, 5) - 0.5) * 0.5 + (typ === 'tenement' ? 0.12 : 0);
    const k = rnd(id, 61);
    const i = k < red ? Math.floor(rnd(id, 62) * 7)
      : k < red + (1 - red) * 0.42 ? 7 + Math.floor(rnd(id, 62) * 3)
      : k < red + (1 - red) * 0.8 ? 10 + Math.floor(rnd(id, 62) * 3)
      : 13 + Math.floor(rnd(id, 62) * 2);
    hex = TILE_HEX[Math.min(TILE_HEX.length - 1, i)];
    style = i >= 13 || rnd(id, 64) < 0.14 ? 'slate' : 'tile';
  }
  // a touch of per-roof lightness, so a terrace of one colour is not one slab
  // (less of it on a photographed roof, which already is its own colour)
  const j = src === 'photo' ? 0.96 + rnd(id, 65) * 0.08 : 0.9 + rnd(id, 65) * 0.2;
  const ch = (s) => Math.max(0, Math.min(255, Math.round(((hex >> s) & 255) * j)));
  hex = (ch(16) << 16) | (ch(8) << 8) | ch(0);
  // eave overhang: generous on a village house, tight on a town block
  const ov = shape === 'flat' ? 0 : typ === 'house' || typ === 'barn' ? 0.45
    : typ === 'hall' || typ === 'garage' ? 0.25 : 0.32;
  const roof = { shape, style, hex, ov, src };
  if (shape !== 'flat') pragueRoof(f, typ, roof, S);
  if (shape !== 'flat') {
    // roof:height. The walls keep the height they have (the storey grid and
    // the near shell stand on it), so a tag that says the building is mostly
    // roof (a spire) is honoured up to the height of the walls under it.
    if (f.rh > 0) roof.rise = Math.min(f.rh, 16, Math.max(1.2, (f.h ?? 6) * 0.9));
    // roof:levels. 0 is an answer: nothing lives under this roof, so it is
    // low. One and up is an attic storey, which needs the height to stand in
    // and shows its windows in the slope.
    if (f.rl >= 1) roof.attic = Math.min(3, Math.round(f.rl));
    else if (f.rl === 0) roof.low = true;
    // a mansard's slope stands up; the offset roof would lean it in like a hip
    if (shape === 'cap' && (r === 'mansard' || r === 'gambrel')) roof.steep = true;
    // roof:direction / roof:orientation. A ridge is only turned across the
    // long side where a truss could still span it.
    if (shape !== 'cap' && shape !== 'pyramid') {
      const t = ridgeTurn(f, S, shape === 'mono');
      if (t.swap && S.long <= 24) roof.swap = true;
      if (t.flip && t.swap === !!roof.swap) roof.flip = true;
    }
  }
  return (f._roof = roof);
}

/**
 * roofFurniture(f, typ, roof, storeys) -> [{ k, u, v, w, d, h, hex }]
 * Boxes in the footprint's own frame (u along the long axis, v across, both in
 * metres from the OBB centre), `h` above the wall top. k: 'chimney' rides the
 * roof slope up to above the ridge, everything else stands on a flat deck.
 * Deterministic, capped, and every box is tested against the real outline so
 * an L-shaped block does not grow a lift house over its courtyard.
 */
export function roofFurniture(f, typ, roof, storeys) {
  const S = shapeOf(f), id = f._id, out = [];
  if (S.area < 28 || S.short < 3.2) return out;
  const inside = (u, v, m) => {
    for (const [du, dv] of [[0, 0], [m, m], [-m, m], [m, -m], [-m, -m]]) {
      const pu = S.cu + u + du, pv = S.cv + v + dv;
      if (!pointInPolygon(pu * S.ux + pv * S.vx, pu * S.uz + pv * S.vz, f.o)) return false;
    }
    for (const h of f.i ?? []) {
      if (h.length < 3) continue;
      const pu = S.cu + u, pv = S.cv + v;
      if (pointInPolygon(pu * S.ux + pv * S.vx, pu * S.uz + pv * S.vz, h)) return false;
    }
    return true;
  };
  const add = (k, u, v, w, d, h, hex, m) => {
    if (out.length < 14 && inside(u, v, m ?? Math.max(w, d) * 0.5 + 0.3)) out.push({ k, u, v, w, d, h, hex });
  };
  // the ridge axis in metres: L runs along u when the frame's L is the longer
  // (and a tagged roof:direction can turn the ridge across it)
  const along = (S.L >= S.W) !== !!roof.swap;
  const hl = (along ? S.L : S.W) / 2, hw = (along ? S.W : S.L) / 2;
  const at = (a, c) => (along ? [a, c] : [c, a]);
  if (roof.shape !== 'flat') {
    if (typ === 'hall' || typ === 'garage' || typ === 'church' || typ === 'barn') return out;
    // nobody builds a chimney stack through patent glazing or a sedum roof
    if (roof.style === 'glass' || roof.style === 'grass') return out;
    // chimneys: one on a house, a row of them on a tenement, brick or rendered
    const n = typ === 'house' ? (rnd(id, 70) < 0.86 ? 1 : 0)
      : Math.max(1, Math.min(5, Math.round(hl * 2 / 9)));
    const brick = rnd(id, 71) < 0.6 ? 0x8a5644 : 0xb9b3a7;
    for (let i = 0; i < n; i++) {
      const a = (n === 1 ? (rnd(id, 72) - 0.5) * 0.9 : ((i + 0.5) / n - 0.5) * 1.7) * hl;
      const c = (rnd(id, 73 + i) < 0.5 ? -1 : 1) * hw * (0.16 + rnd(id, 80 + i) * 0.2);
      const [u, v] = at(a, c);
      add('chimney', u, v, 0.62, 0.62, 0, brick, 0.9);
    }
    return out;
  }
  if (typ === 'panel' || ((typ === 'block' || typ === 'functional' || typ === 'nova'
      || typ === 'civic' || typ === 'tenement') && storeys >= 4)) {
    // lift machine rooms, one per staircase section (a section is about 18 m)
    const n = Math.max(1, Math.min(4, Math.round(hl * 2 / 19)));
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n - 0.5) * 2 * hl + (rnd(id, 74 + i) - 0.5) * 2;
      const [u, v] = at(a, (rnd(id, 75) < 0.5 ? -1 : 1) * hw * 0.22);
      const [w, d] = at(3.4, 4.2);
      add('box', u, v, w, d, 2.5, 0xb5b3ad);
    }
  }
  if (typ === 'panel' || typ === 'block' || typ === 'functional' || typ === 'nova'
      || typ === 'civic' || typ === 'office') {
    // vent stacks: small, many, the thing a flat roof is actually covered in
    const n = Math.min(5, 1 + Math.floor(S.area / 220));
    for (let i = 0; i < n; i++) {
      const [u, v] = at((rnd(id, 76 + i) - 0.5) * 1.6 * hl, (rnd(id, 86 + i) - 0.5) * 1.3 * hw);
      add('box', u, v, 0.6, 0.6, 0.75 + rnd(id, 96 + i) * 0.5, 0x8f9092);
    }
  }
  if (typ === 'retail' || typ === 'hall' || typ === 'office' || typ === 'pavilion'
      || typ === 'shop' || typ === 'civic') {
    // air handling units, and on a hall the strip rooflights
    const n = Math.min(6, 1 + Math.floor(S.area / 420));
    for (let i = 0; i < n; i++) {
      const [u, v] = at((rnd(id, 77 + i) - 0.5) * 1.5 * hl, (rnd(id, 87 + i) - 0.5) * 1.2 * hw);
      const [w, d] = at(2.2 + rnd(id, 97 + i) * 1.4, 1.3);
      add('box', u, v, w, d, 1.05, 0xbfc3c6);
    }
    if (typ === 'hall' && hw > 6) {
      const n2 = Math.min(4, Math.floor(hl * 2 / 16));
      for (let i = 0; i < n2; i++) {
        const [u, v] = at(((i + 0.5) / n2 - 0.5) * 2 * hl, 0);
        const [w, d] = at(1.4, hw * 1.2);
        add('box', u, v, w, d, 0.32, 0xcfd8dc);
      }
    }
  }
  return out;
}

// ---- lit windows -----------------------------------------------------------
// The night texture is 256 x 256 texels and every texel is ONE window bay: a
// wall run of up to four bays samples four neighbours on one row. Rows come in
// four palettes of 64 (homes, shops, offices, dim yards) and inside a palette
// the row index is the DENSITY: row q lights q/63 of its bays. So a building
// picks a row for how alive it is and a column for which pattern it gets, and
// pieces.js can ask this module for the very same texel to light the very same
// pane on the near shell.
export const LIT_N = 256;
export const LIT_BANDS = { home: 0, shop: 1, office: 2, dim: 3 };
const _lt = [0, 0, 0, 0];
/** Texel (x, y) -> out[r, g, b, rank] bytes (sRGB colour); returns lit or not. */
export function litTexel(x, y, out = _lt) {
  const band = y >> 6, q = y & 63, id = (y * 256 + x) | 0;
  out[0] = out[1] = out[2] = 0; out[3] = 255;
  if (x === 0 || rnd(id, 11) >= q / 63) return false;
  const k = rnd(id, 12), b = 0.62 + rnd(id, 13) * 0.38;
  let r, g, bl, rank = 0.04 + rnd(id, 14) * 0.9;
  if (band === 1) {                         // shop: neutral white, on early
    r = 1; g = 0.95; bl = 0.84; rank *= 0.35;
    if (k < 0.2) { g = 0.84; bl = 0.6; }
  } else if (band === 2) {                  // office: cool tubes
    r = 0.86; g = 0.94; bl = 1;
    if (k < 0.15) { r = 1; g = 0.9; bl = 0.72; }
  } else if (band === 3) {                  // yard and stair lights: sodium
    r = 1; g = 0.78; bl = 0.46;
  } else if (k < 0.70) {                    // a warm room, the common case
    r = 1; g = 0.74 + rnd(id, 15) * 0.1; bl = 0.40 + rnd(id, 16) * 0.16;
  } else if (k < 0.80) {                    // television
    r = 0.50; g = 0.66; bl = 1; rank = 0.3 + rank * 0.7;
  } else if (k < 0.89) {                    // a cold LED kitchen
    r = 0.88; g = 0.95; bl = 1;
  } else if (k < 0.95) {                    // one shaded lamp
    r = 1; g = 0.58; bl = 0.26;
  } else {                                  // coloured curtains
    r = 0.95; g = 0.72; bl = 0.62;
  }
  out[0] = Math.round(255 * r * b); out[1] = Math.round(255 * g * b);
  out[2] = Math.round(255 * bl * b); out[3] = Math.round(255 * rank);
  return true;
}

// How alive a typology is after dark: [palette, share of windows lit]
const LIT_OF = {
  panel: ['home', 0.4], tenement: ['home', 0.36], block: ['home', 0.38],
  functional: ['home', 0.36], nova: ['home', 0.42], house: ['home', 0.46],
  brick: ['home', 0.16], civic: ['office', 0.07], office: ['office', 0.12],
  shop: ['home', 0.26], retail: ['shop', 0], pavilion: ['shop', 0.5],
  hall: ['dim', 0], barn: ['dim', 0], garage: ['dim', 0], church: ['dim', 0],
  parking: ['dim', 0],
};
/** Per-building night character: { band, dens } */
export function litOf(f, typ) {
  const [band, base] = LIT_OF[typ] ?? LIT_OF.block;
  // some houses are out, some have everybody home; a few offices work late
  let dens = base * (0.35 + rnd(f._id, 21) * 1.3);
  if (band === 'office' && rnd(f._id, 22) < 0.12) dens = 0.45;
  return { band: LIT_BANDS[band], dens: Math.min(0.9, dens) };
}
/** The texture row for storey `s` (shopfront rows are their own palette). */
export function litRow(lit, id, s, store) {
  if (store) return (LIT_BANDS.shop << 6) | Math.round((0.72 + rnd(id, 23) * 0.25) * 63);
  if (lit.dens <= 0) return 0;
  const d = Math.max(0, Math.min(1, lit.dens * (0.55 + rnd(id, 30 + s) * 0.9)));
  return (lit.band << 6) | Math.round(d * 63);
}
/** First texel column of bay run `run` on (storey, edge): 1..251, never wraps. */
export const litStart = (id, s, edge, run) =>
  1 + ((Math.floor(rnd(id, 400 + s * 37 + edge * 11) * 251) + run * BAYS) % 248);
/**
 * litPane(lit, id, s, edge, bay, store) -> [r, g, b, rank] bytes or null.
 * The near shell's twin of the far tier's uv1 lookup: same row, same column.
 */
export function litPane(lit, id, s, edge, bay, store) {
  const y = litRow(lit, id, s, store);
  const x = litStart(id, s, edge, (bay / BAYS) | 0) + (bay % BAYS);
  const o = [0, 0, 0, 0];
  return litTexel(x, y, o) ? o : null;
}

// ---- signs -----------------------------------------------------------------
// Where a fascia band hangs. A shed signs its parapet; a shop under four
// storeys of flats signs the strip over its own window, not the roof line of
// the block above it.
export function signBand(y0, top, sH, overGround) {
  if (overGround) {
    const H = 0.62, yT = y0 + Math.min(sH, 4.4) + 0.12;
    return { H, yT, yB: yT - H };
  }
  const H = Math.min(1.6, Math.max(0.7, (top - y0) * 0.22));
  return { H, yT: top - 0.4, yB: top - 0.4 - H };
}

const RETAIL_USES = new Set(['shop', 'supermarket', 'mall', 'restaurant']);
/** Does the fascia belong over the ground floor (a shop under flats) or on the parapet? */
export const signOverGround = (use, storeys) => storeys >= 2 && !RETAIL_USES.has(use);

// ---- parapets --------------------------------------------------------------
// A flat roof ends in an upstand; a shed, a garage and a bungalow just end.
export const PARAPET_H = 0.55;
export const hasParapet = (typ, roof, area) => roof.shape === 'flat' && area >= 70
  && typ !== 'house' && typ !== 'garage' && typ !== 'barn' && typ !== 'church';
