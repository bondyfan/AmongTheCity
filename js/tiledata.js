// ---- tiledata.js: the code tables the tile builder and the game share --------
// Round 5 put four kinds of real data into the tiles (docs/TILE-FORMAT.md is
// the contract): what species a mapped tree is, where a street allows parking,
// what a roof is made of and what colour it is, and the real bus, trolleybus
// and tram lines. Most of it is stored as small integers, because a tile is
// downloaded by every player and "broadleaved" 38 000 times is 400 kB of
// nothing. This module is where those integers get their meaning.
//
// It is read by scripts/build-region.mjs (node) AND by the game (browser, main
// thread and mesh worker alike), so it is PURE DATA and pure functions: no
// three.js, no document, no imports at all.
//
// EVERY TABLE HERE IS APPEND ONLY. The index of an entry is what is written
// into 600 MB of committed tiles: reorder one and every tile lies.

export const TILE_DATA_VERSION = 1;

// ---- trees -------------------------------------------------------------------
// A tree in a tile is [x, z] as it always was, or longer when OSM says more:
//   [x, z, taxon, height, crown, girth]
//   taxon   index into TREE_TAXA (0: nothing known)
//   height  m, crown: crown diameter in m, girth: trunk circumference in m
// Trailing unknowns are cut off and an unknown in the middle is 0, so a
// consumer reads p[2] | 0 and never tests the length.
//
// `sp` is the species CLASS the game can draw: an index into SPECIES of
// js/treeshapes.js (linden 0, maple 1, chestnut 2, plane 3, poplar 4, birch 5,
// spruce 6, pine 7, fruit 8, shrub 9, oak 10), chosen for the nearest crown
// shape, leaf tone and bark. -1 means the entry narrows the choice without
// making it (the two generic leaf types): pick by hash among classes of that
// leaf. The taxon is kept finer than the class on purpose, so a later round
// can give the walnut or the willow a model of its own without a rebuild.
//   leaf  'b' broadleaved, 'n' needleleaved     ever  1: green in winter
const T = (id, cs, sp, leaf = 'b', ever = 0) => ({ id, cs, sp, leaf, ever });
export const TREE_TAXA = [
  null,
  T('broadleaved', 'listnatý strom', -1),
  T('needleleaved', 'jehličnan', -1, 'n', 1),
  T('tilia', 'lípa', 0),
  T('acer', 'javor', 1),
  T('aesculus', 'jírovec', 2),
  T('platanus', 'platan', 3),
  T('populus', 'topol', 4),
  T('betula', 'bříza', 5),
  T('picea', 'smrk', 6, 'n', 1),
  T('pinus', 'borovice', 7, 'n', 1),
  T('prunus', 'třešeň nebo slivoň', 8),
  T('malus', 'jabloň', 8),
  T('pyrus', 'hrušeň', 8),
  T('quercus', 'dub', 10),
  T('fagus', 'buk', 10),
  T('fraxinus', 'jasan', 1),
  T('ulmus', 'jilm', 0),
  T('carpinus', 'habr', 0),
  T('juglans', 'ořešák', 10),
  T('robinia', 'akát', 1),
  T('salix', 'vrba', 1),
  T('alnus', 'olše', 0),
  T('sorbus', 'jeřáb', 8),
  T('crataegus', 'hloh', 8),
  T('ginkgo', 'jinan', 0),
  T('larix', 'modřín', 6, 'n', 0),
  T('abies', 'jedle', 6, 'n', 1),
  T('pseudotsuga', 'douglaska', 6, 'n', 1),
  T('thuja', 'zerav', 6, 'n', 1),
  T('taxus', 'tis', 6, 'n', 1),
  T('juniperus', 'jalovec', 6, 'n', 1),
  T('castanea', 'kaštanovník', 2),
  T('catalpa', 'katalpa', 2),
  T('corylus', 'líska', 0),
  T('morus', 'moruše', 8),
  T('styphnolobium', 'jerlín', 1),
  T('gleditsia', 'dřezovec', 1),
  T('ailanthus', 'pajasan', 1),
  T('liriodendron', 'liliovník', 3),
  T('paulownia', 'pavlovnie', 2),
  T('magnolia', 'šácholan', 8),
  T('cedrus', 'cedr', 7, 'n', 1),
  T('sequoiadendron', 'sekvojovec', 6, 'n', 1),
  T('cupressaceae', 'cypřišek', 6, 'n', 1),
];
export const TREE_BROADLEAVED = 1, TREE_NEEDLELEAVED = 2;

/** The taxon entry of a tile tree point ([x, z, taxon, ...]), or null. */
export const treeTaxon = (p) => TREE_TAXA[p[2] | 0] ?? null;
/** Its drawable species class (index into treeshapes SPECIES), or -1 when unknown. */
export const treeClass = (p) => TREE_TAXA[p[2] | 0]?.sp ?? -1;
/** Surveyed height, crown diameter and trunk girth in metres, 0 where unknown. */
export const treeHeight = (p) => +p[3] || 0;
export const treeCrown = (p) => +p[4] || 0;
export const treeGirth = (p) => +p[5] || 0;

// ---- on-street parking --------------------------------------------------------
// A road may carry `pk: [left, right]`: one code per side, LEFT and RIGHT of
// the direction the stored points run in (the builder swaps the sides of a way
// it reversed). No `pk` at all: OSM says nothing about either side.
//
//   0   nothing mapped for this side
//   1   no parking here (parking:side=no, no reason given)
//   2   no parking sign (zákaz stání): stopping to load is allowed
//   3   no stopping sign (zákaz zastavení)
//   4   the parking of this side is drawn as its own area (amenity=parking is
//       already in `paved`), so a kerb row here would park cars twice
//   8+  parking is allowed; the code packs how:
//         orientation = (code - 8) & 3    0 unknown, 1 parallel, 2 diagonal, 3 perpendicular
//         position    = (code - 8) >> 2   0 unknown, 1 on the carriageway (a lane),
//                                         2 a bay beside it (street_side), 3 two wheels on
//                                         the kerb (half_on_kerb), 4 on the pavement
//                                         (on_kerb), 5 on the shoulder
export const PARK_NONE = 0, PARK_NO = 1, PARK_NO_PARKING = 2, PARK_NO_STOPPING = 3,
  PARK_SEPARATE = 4, PARK_ALLOWED = 8;
export const PARK_ORIENT = ['', 'parallel', 'diagonal', 'perpendicular'];
export const PARK_POSITION = ['', 'lane', 'street_side', 'half_on_kerb', 'on_kerb', 'shoulder'];
export const parkCode = (orient, position) => PARK_ALLOWED + (orient & 3) + (position << 2);
export const parkAllowed = (code) => code >= PARK_ALLOWED;
/** True for the three codes that forbid a kerb row (not for "nothing mapped"). */
export const parkForbidden = (code) => code >= PARK_NO && code <= PARK_NO_STOPPING;
export const parkOrient = (code) => (code >= PARK_ALLOWED ? (code - PARK_ALLOWED) & 3 : 0);
export const parkPosition = (code) => (code >= PARK_ALLOWED ? (code - PARK_ALLOWED) >> 2 : 0);
/** The code of one side of a road feature: side 0 = left, 1 = right of the stored direction. */
export const parkSide = (road, side) => road.pk?.[side] ?? PARK_NONE;

// ---- roofs and walls ----------------------------------------------------------
// building.rm and building.bm are indices here. The names are OSM's own values
// after the spelling variants are folded together.
export const ROOF_MATERIALS = ['', 'roof_tiles', 'metal', 'concrete', 'tar_paper', 'glass',
  'grass', 'copper', 'slate', 'gravel', 'wood', 'plastic', 'eternit', 'stone', 'thatch',
  'solar_panels'];
export const WALL_MATERIALS = ['', 'plaster', 'brick', 'concrete', 'glass', 'wood', 'stone',
  'metal', 'plastic'];
// building.ro: how the ridge runs against the longest side of the footprint
export const ROOF_ALONG = 1, ROOF_ACROSS = 2;

/**
 * The colour to paint a roof, best source first: the roof:colour tag (rc),
 * then the colour read off the aerial photo (rp), else null and the caller's
 * own procedural choice. Both are '#rrggbb'.
 */
export const roofColour = (b) => b.rc ?? b.rp ?? null;

// ---- public transport routes --------------------------------------------------
// Routes live in their own small files, public/data/routes/<tx>_<tz>.json, one
// per tile that OWNS at least one route (the tile of the route's first stop
// inside the world). A manifest tile entry lists in `rt` the keys of every
// route file with a route passing through that tile; geo.js turns that into
// city.routeFilesNear(x, z, reach). See docs/TILE-FORMAT.md for the file.
export const ROUTE_MODES = ['bus', 'trolleybus', 'tram'];
export const MODE_BUS = 0, MODE_TROLLEYBUS = 1, MODE_TRAM = 2;
// stop table entry: [name, kind, x, z] or [name, 3, x, z, px, pz]
export const STOP_POSITION = 1, STOP_PLATFORM = 2;
// per-call flags in route.sf
// CALL_OFF_PATH: the mapped path never comes within 60 m of this stop, so its
// `sd` is interpolated between its neighbours (the stop's own x,z is still real)
export const CALL_ENTRY_ONLY = 1, CALL_EXIT_ONLY = 2, CALL_ON_DEMAND = 4, CALL_OFF_PATH = 8;
// leg flag (leg[0])
export const LEG_TUNNEL = 1, LEG_BRIDGE = 2, LEG_RAIL = 4, LEG_OFF_ROAD_LAYER = 8;

/**
 * One leg as a flat [x0, z0, x1, z1, ...] in game metres. A leg is stored as
 * [flags, x0, z0, dx1, dz1, ...] in whole decimetres, each point a delta from
 * the one before: the same 10 cm grid every tile layer is rounded to.
 */
export function legPoints(leg, reversed = false, out = []) {
  const n = (leg.length - 1) >> 1, base = out.length;
  let x = 0, z = 0;
  for (let i = 0; i < n; i++) {
    x += leg[1 + i * 2]; z += leg[2 + i * 2];
    const o = base + (reversed ? n - 1 - i : i) * 2;
    out[o] = x / 10; out[o + 1] = z / 10;
  }
  return out;
}

/**
 * The path of a route, decoded: { pts, cuts, flags }.
 *   pts    flat [x, z, ...] in game metres, in the direction of travel
 *   cuts   point indices where a new piece begins after a GAP (a member way
 *          that is missing, lies outside the world or does not connect). The
 *          points either side of a cut are not joined by a road.
 *   flags  one entry per point: the leg flags of the segment that STARTS there
 * `route.p` is a list of signed leg references: +k is legs[k - 1] as stored,
 * -k the same leg run backwards, 0 a gap.
 */
export function routePath(file, route) {
  const pts = [], cuts = [], flags = [];
  let gap = false;
  for (const ref of route.p) {
    const leg = ref === 0 ? null : file.legs[Math.abs(ref) - 1];
    if (!leg) { gap = pts.length > 0; continue; }
    const at = pts.length;
    legPoints(leg, ref < 0, pts);
    if (gap) { cuts.push(at / 2); gap = false; }
    else if (at >= 2 && pts[at] === pts[at - 2] && pts[at + 1] === pts[at - 1]) {
      pts.splice(at, 2);            // the junction vertex two joined legs share...
      flags[at / 2 - 1] = leg[0];   // ...and the segment leaving it is this leg's
    }
    while (flags.length < pts.length / 2) flags.push(leg[0]);
  }
  return { pts, cuts, flags };
}

/**
 * The calls of a route in order: [{ n, k, x, z, px, pz, f, d }].
 *   n      stop name ('' when OSM has none)
 *   k      bit 1: x,z is a stop position ON the carriageway; bit 2: a platform
 *          (pole, shelter) is known. With only bit 2 set, x,z IS the platform.
 *   px,pz  the platform, where passengers wait (equal to x,z when k is 2)
 *   f      CALL_* flags      d  metres along routePath(...).pts to the call
 */
export function routeStops(file, route) {
  const out = [];
  for (let i = 0; i < route.s.length; i++) {
    const e = file.stops[route.s[i]];
    out.push({
      n: e[0], k: e[1], x: e[2], z: e[3], px: e[4] ?? e[2], pz: e[5] ?? e[3],
      f: route.sf?.[i] ?? 0, d: route.sd?.[i] ?? 0,
    });
  }
  return out;
}

/** Does the route's bounding box come within `r` metres of (x, z)? */
export function routeNear(route, x, z, r) {
  const b = route.bb;
  return x >= b[0] - r && x <= b[2] + r && z >= b[1] - r && z <= b[3] + r;
}
