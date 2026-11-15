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

// The vocabulary, the footprint questions, the roofs and the night windows live
// in their own modules (typologycells.js, typologyshape.js, typologyroof.js,
// typologylit.js) to keep each file small; this module re-exports them, so
// every importer still asks typology.js.

import { wallFamily } from './roofdata.js';
import { praguePlace } from './praguezone.js';
import { blockCorner } from './partywalls.js';
import { rnd, cellRect, TRIM_BANDS, FAMILIES, CELL_OF, PANEL_BALC, HOUSE_BLANK } from './typologycells.js';
import { shapeOf, levelsOf, pitchedTag, zoneRnd } from './typologyshape.js';

export {
  rnd, ATLAS_N, ATLAS_M, ATLAS_PX, BAYS, WIN_W, cellRect, PIN_U, PIN_V, ROOF_ROWS, ROOF_STYLES,
  roofIndex, roofPin, TRIM_CELL, TRIM_BANDS, trimRect, FAMILIES, CELL_LIST, PANEL_BALC, NOVA_RAIL,
  HOUSE_BLANK,
} from './typologycells.js';
export { shapeOf } from './typologyshape.js';
export { roofOf, roofFurniture } from './typologyroof.js';
export { LIT_N, LIT_BANDS, litTexel, litOf, litRow, litStart, litPane } from './typologylit.js';

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
