// ---- OSM tag soup -> the small codes of js/tiledata.js -----------------------
// Three readers, one per round-5 layer: what species a tree is, where a street
// allows parking, what a roof is made of. Each takes an element's raw tags and
// returns the compact value the tile stores, or nothing. The game never sees a
// tag: everything it could misread (a genus spelled five ways, two parking
// schemas, 400 colour names) is settled here, once, offline.
//
// The tables they index live in js/tiledata.js, which the game imports too.

import { TREE_TAXA, TREE_BROADLEAVED, TREE_NEEDLELEAVED, ROOF_MATERIALS, WALL_MATERIALS,
  PARK_NO, PARK_NO_PARKING, PARK_NO_STOPPING, PARK_SEPARATE, PARK_ORIENT, PARK_POSITION,
  parkCode, ROOF_ALONG, ROOF_ACROSS } from '../../js/tiledata.js';

// ---- trees ---------------------------------------------------------------------
// OSM has four places to say what a tree is (genus, species, taxon, and each of
// them again as :cs or :en) and mappers use all of them, in Latin, Czech and
// English, with and without capitals and diacritics: "Tilia", "Tília", "lípa",
// "Lípa malolistá", "Cordata". Every value is folded to bare lower-case ASCII
// and searched for the word-starts below; the EARLIEST hit in the string wins
// and, at the same place, the longest ("Platanus acerifolia" is a plane, not a
// maple; "kaštanovník" is a sweet chestnut, not the horse chestnut "kaštan").
const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ALIASES = {
  tilia: ['tilia', 'lipa', 'lime', 'linden', 'cordata', 'platyphyllos', 'tilioideae', 'srdcita', 'malolista', 'velkolista'],
  acer: ['acer', 'javor', 'maple', 'klen', 'babyka'],
  aesculus: ['aesculus', 'jirovec', 'kastan', 'horse chestnut', 'horse-chestnut', 'hippocastanum', 'madal'],
  platanus: ['platanus', 'platan', 'plane'],
  populus: ['populus', 'topol', 'poplar', 'osika', 'aspen'],
  betula: ['betula', 'briza', 'birch'],
  picea: ['picea', 'smrk', 'spruce'],
  pinus: ['pinus', 'borovice', 'pine'],
  prunus: ['prunus', 'tresen', 'slivon', 'svestka', 'visen', 'merunka', 'broskvon', 'mandlon', 'cerasus', 'cherry', 'plum', 'pflaume', 'avium', 'subhirtella', 'sakura', 'stremcha'],
  malus: ['malus', 'jablon', 'apple'],
  pyrus: ['pyrus', 'hrusen', 'pear'],
  quercus: ['quercus', 'dub', 'oak', 'robur'],
  fagus: ['fagus', 'buk', 'beech'],
  fraxinus: ['fraxinus', 'jasan', 'ash'],
  ulmus: ['ulmus', 'jilm', 'elm'],
  carpinus: ['carpinus', 'habr', 'hornbeam'],
  juglans: ['juglans', 'junglas', 'oresak', 'walnut'],
  robinia: ['robinia', 'akat', 'trnovnik', 'pseudoacacia'],
  salix: ['salix', 'vrba', 'willow'],
  alnus: ['alnus', 'olse', 'alder'],
  sorbus: ['sorbus', 'jerab', 'rowan', 'aucuparia', 'cormus', 'oskeruse'],
  crataegus: ['crataegus', 'hloh', 'hawthorn'],
  ginkgo: ['ginkgo', 'jinan'],
  larix: ['larix', 'modrin', 'larch'],
  abies: ['abies', 'jedle', 'fir'],
  pseudotsuga: ['pseudotsuga', 'douglaska'],
  thuja: ['thuja', 'zerav', 'tuje'],
  taxus: ['taxus', 'tis', 'yew', 'baccata'],
  juniperus: ['juniperus', 'jalovec', 'juniper'],
  castanea: ['castanea', 'kastanovnik', 'sweet chestnut'],
  catalpa: ['catalpa', 'katalpa'],
  corylus: ['corylus', 'liska', 'hazel'],
  morus: ['morus', 'moruse', 'mulberry'],
  styphnolobium: ['styphnolobium', 'sophora', 'jerlin'],
  gleditsia: ['gleditsia', 'drezovec'],
  ailanthus: ['ailanthus', 'pajasan'],
  liriodendron: ['liriodendron', 'liliovnik'],
  paulownia: ['paulownia', 'pavlovnie'],
  magnolia: ['magnolia', 'sacholan'],
  cedrus: ['cedrus', 'cedr', 'cedar'],
  sequoiadendron: ['sequoiadendron', 'sequoia', 'metasequoia', 'sekvoj'],
  cupressaceae: ['chamaecyparis', 'cupressus', 'cyprisek', 'cypris', 'cypress'],
};
const TAXON_IX = new Map(TREE_TAXA.map((t, i) => [t?.id, i]));
const MATCHERS = [];
for (const [id, list] of Object.entries(ALIASES)) {
  const code = TAXON_IX.get(id);
  if (code === undefined) throw new Error(`tagdata: alias for a taxon js/tiledata.js does not have: ${id}`);
  for (const a of list) MATCHERS.push({ a, code, re: new RegExp('(^|[^a-z])' + a.replace(/[-]/g, '\\-')) });
}
function taxonIn(value) {
  const s = fold(value);
  let best = 0, at = Infinity, len = 0;
  for (const m of MATCHERS) {
    const hit = m.re.exec(s);
    if (!hit) continue;
    const i = hit.index + hit[1].length;
    if (i < at || (i === at && m.a.length > len)) { best = m.code; at = i; len = m.a.length; }
  }
  return best;
}
const TAXON_KEYS = ['genus', 'taxon', 'species', 'genus:cs', 'taxon:cs', 'species:cs',
  'genus:en', 'taxon:en', 'species:en', 'name:botanical'];

const metres = (v, lo, hi) => {
  if (v === undefined) return 0;
  const m = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*(m|cm)?\s*$/.exec(String(v));
  if (!m) return 0;
  let x = parseFloat(m[1].replace(',', '.'));
  if (m[2] === 'cm') x /= 100;
  return x >= lo && x <= hi ? x : 0;
};

/**
 * The extra fields of a tree record, [taxon, height, crown, girth], with the
 * trailing unknowns already cut: [] for a tree nobody described. Append it to
 * [x, z].
 */
export function treeExtras(t) {
  let taxon = 0;
  for (const k of TAXON_KEYS) if (t[k] && (taxon = taxonIn(t[k]))) break;
  if (!taxon) {
    const leaf = t.leaf_type;
    if (leaf === 'broadleaved') taxon = TREE_BROADLEAVED;
    else if (leaf === 'needleleaved') taxon = TREE_NEEDLELEAVED;
  }
  const h = metres(t.height, 1, 60);
  const crown = metres(t.diameter_crown, 0.5, 45);
  // circumference is metres in OSM, but a surveyor's tape reads centimetres
  // and plenty of them typed what the tape said: nothing has a 15 m trunk
  let girth = metres(t.circumference, 0.05, 1500);
  if (girth > 15) girth /= 100;
  const out = [taxon, +h.toFixed(1), +crown.toFixed(1), +girth.toFixed(2)];
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

// ---- on-street parking ---------------------------------------------------------
// Two schemas are live at once. The NEW one (2022) says where and how in
// separate keys: parking:left=lane|street_side|on_kerb|half_on_kerb|shoulder|
// no|separate|yes, parking:left:orientation=parallel|diagonal|perpendicular,
// parking:left:restriction=no_parking|no_stopping. The OLD one packs both into
// parking:lane:left=parallel|diagonal|perpendicular|no_parking|no_stopping|no|
// marked|separate, with the position as parking:lane:left:parallel=on_street|...
// A side-specific key beats `both`, and the new schema beats the old, because
// a way carrying both was converted and the old keys are the stale ones.
// Misplaced values (an orientation where a position belongs) are understood
// rather than dropped: the mapper's meaning is not in doubt.
const ORIENT = { parallel: 1, diagonal: 2, perpendicular: 3, orthogonal: 3, ortogonal: 3 };
const POSITION = { lane: 1, on_street: 1, street_side: 2, half_on_kerb: 3, on_kerb: 4, shoulder: 5,
  painted_area_only: 1 };
const RESTRICT = { no_parking: PARK_NO_PARKING, no_stopping: PARK_NO_STOPPING,
  no_standing: PARK_NO_STOPPING, fire_lane: PARK_NO_STOPPING, no_stoping: PARK_NO_STOPPING };
for (const k of Object.keys(ORIENT)) if (ORIENT[k] >= PARK_ORIENT.length) throw new Error('tagdata: orientation table');
for (const k of Object.keys(POSITION)) if (POSITION[k] >= PARK_POSITION.length) throw new Error('tagdata: position table');

function sideCode(t, side) {
  const pick = (suffix = '') => t[`parking:${side}${suffix}`] ?? t[`parking:both${suffix}`];
  // ---- new schema
  const v = pick();
  if (v !== undefined) {
    const restr = RESTRICT[pick(':restriction')];
    if (RESTRICT[v]) return RESTRICT[v];
    if (v === 'no') return restr ?? PARK_NO;
    if (v === 'separate') return PARK_SEPARATE;
    const orient = ORIENT[pick(':orientation')] ?? ORIENT[v] ?? 0;
    const pos = POSITION[v] ?? 0;
    if (pos || orient || v === 'yes' || v === 'marked') return parkCode(orient, pos);
    return 0;                                   // a value nobody can read ("blue")
  }
  const restrOnly = RESTRICT[pick(':restriction')];
  if (restrOnly) return restrOnly;
  // an orientation with no position key: cars do park here, nobody said where
  const orientOnly = ORIENT[pick(':orientation')];
  if (orientOnly) return parkCode(orientOnly, 0);
  // ---- old schema
  const o = t[`parking:lane:${side}`] ?? t['parking:lane:both'] ?? t['parking:lane'];
  if (o === undefined) return 0;
  if (RESTRICT[o]) return RESTRICT[o];
  if (o === 'no') return PARK_NO;
  if (o === 'separate') return PARK_SEPARATE;
  const key = Object.keys(ORIENT).find((k) => o.startsWith(k.slice(0, 5)));   // "parallelh", "digonal" aside
  const orient = ORIENT[o] ?? (key ? ORIENT[key] : 0);
  const posTag = orient ? (t[`parking:lane:${side}:${PARK_ORIENT[orient]}`] ?? t[`parking:lane:both:${PARK_ORIENT[orient]}`]) : undefined;
  const pos = POSITION[posTag] ?? 0;
  if (orient || o === 'yes' || o === 'marked') return parkCode(orient, pos);
  return 0;
}

/**
 * [left, right] parking codes of a highway way in the direction its nodes are
 * drawn, or null when OSM says nothing about either side. The caller swaps the
 * two for a way it stores reversed.
 */
export function parkingSides(t) {
  const l = sideCode(t, 'left'), r = sideCode(t, 'right');
  return l || r ? [l, r] : null;
}

// ---- roofs ---------------------------------------------------------------------
// The CSS named colours, because that is the vocabulary roof:colour is written
// in (iD offers them), plus the handful of words mappers use that CSS lacks.
const CSS_COLOURS = {
  aliceblue: 'f0f8ff', antiquewhite: 'faebd7', aqua: '00ffff', aquamarine: '7fffd4', azure: 'f0ffff',
  beige: 'f5f5dc', bisque: 'ffe4c4', black: '000000', blanchedalmond: 'ffebcd', blue: '0000ff',
  blueviolet: '8a2be2', brown: 'a52a2a', burlywood: 'deb887', cadetblue: '5f9ea0', chartreuse: '7fff00',
  chocolate: 'd2691e', coral: 'ff7f50', cornflowerblue: '6495ed', cornsilk: 'fff8dc', crimson: 'dc143c',
  cyan: '00ffff', darkblue: '00008b', darkcyan: '008b8b', darkgoldenrod: 'b8860b', darkgray: 'a9a9a9',
  darkgreen: '006400', darkgrey: 'a9a9a9', darkkhaki: 'bdb76b', darkmagenta: '8b008b',
  darkolivegreen: '556b2f', darkorange: 'ff8c00', darkorchid: '9932cc', darkred: '8b0000',
  darksalmon: 'e9967a', darkseagreen: '8fbc8f', darkslateblue: '483d8b', darkslategray: '2f4f4f',
  darkslategrey: '2f4f4f', darkturquoise: '00ced1', darkviolet: '9400d3', deeppink: 'ff1493',
  deepskyblue: '00bfff', dimgray: '696969', dimgrey: '696969', dodgerblue: '1e90ff', firebrick: 'b22222',
  floralwhite: 'fffaf0', forestgreen: '228b22', fuchsia: 'ff00ff', gainsboro: 'dcdcdc', ghostwhite: 'f8f8ff',
  gold: 'ffd700', goldenrod: 'daa520', gray: '808080', green: '008000', greenyellow: 'adff2f',
  grey: '808080', honeydew: 'f0fff0', hotpink: 'ff69b4', indianred: 'cd5c5c', indigo: '4b0082',
  ivory: 'fffff0', khaki: 'f0e68c', lavender: 'e6e6fa', lavenderblush: 'fff0f5', lawngreen: '7cfc00',
  lemonchiffon: 'fffacd', lightblue: 'add8e6', lightcoral: 'f08080', lightcyan: 'e0ffff',
  lightgoldenrodyellow: 'fafad2', lightgray: 'd3d3d3', lightgreen: '90ee90', lightgrey: 'd3d3d3',
  lightpink: 'ffb6c1', lightsalmon: 'ffa07a', lightseagreen: '20b2aa', lightskyblue: '87cefa',
  lightslategray: '778899', lightslategrey: '778899', lightsteelblue: 'b0c4de', lightyellow: 'ffffe0',
  lime: '00ff00', limegreen: '32cd32', linen: 'faf0e6', magenta: 'ff00ff', maroon: '800000',
  mediumaquamarine: '66cdaa', mediumblue: '0000cd', mediumorchid: 'ba55d3', mediumpurple: '9370db',
  mediumseagreen: '3cb371', mediumslateblue: '7b68ee', mediumspringgreen: '00fa9a',
  mediumturquoise: '48d1cc', mediumvioletred: 'c71585', midnightblue: '191970', mintcream: 'f5fffa',
  mistyrose: 'ffe4e1', moccasin: 'ffe4b5', navajowhite: 'ffdead', navy: '000080', oldlace: 'fdf5e6',
  olive: '808000', olivedrab: '6b8e23', orange: 'ffa500', orangered: 'ff4500', orchid: 'da70d6',
  palegoldenrod: 'eee8aa', palegreen: '98fb98', paleturquoise: 'afeeee', palevioletred: 'db7093',
  papayawhip: 'ffefd5', peachpuff: 'ffdab9', peru: 'cd853f', pink: 'ffc0cb', plum: 'dda0dd',
  powderblue: 'b0e0e6', purple: '800080', rebeccapurple: '663399', red: 'ff0000', rosybrown: 'bc8f8f',
  royalblue: '4169e1', saddlebrown: '8b4513', salmon: 'fa8072', sandybrown: 'f4a460', seagreen: '2e8b57',
  seashell: 'fff5ee', sienna: 'a0522d', silver: 'c0c0c0', skyblue: '87ceeb', slateblue: '6a5acd',
  slategray: '708090', slategrey: '708090', snow: 'fffafa', springgreen: '00ff7f', steelblue: '4682b4',
  tan: 'd2b48c', teal: '008080', thistle: 'd8bfd8', tomato: 'ff6347', turquoise: '40e0d0',
  violet: 'ee82ee', wheat: 'f5deb3', white: 'ffffff', whitesmoke: 'f5f5f5', yellow: 'ffff00',
  yellowgreen: '9acd32',
  // not CSS, but written often enough to be worth knowing
  copper: 'b87333', rust: 'b7410e', sand: 'c2b280', terracotta: 'e2725b', anthracite: '383e42',
  brick: 'b5533c', cream: 'fffdd0',
};
// A roof is never the pure primary a colour NAME stands for: "red" on a roof
// is fired clay and "gray" is weathered concrete tile, not #ff0000 and
// #808080. The names mappers actually use (measured over the world: gray,
// lightgray, red, darkgray, brown, maroon, black, silver, white) get the
// colour of the material they describe; an explicit #hex is taken at its word.
const ROOF_NAMED = {
  red: 'a8523a', maroon: '7a3b2e', brown: '7b5a45', firebrick: '9c4a36', darkred: '7e2f25',
  orange: 'c0703f', orangered: 'b85a36', crimson: '9a3b33', salmon: 'c98a72', darksalmon: 'c08a70',
  indianred: 'b0604f', rosybrown: 'ab8c85', tomato: 'b85c40', coral: 'c2704f',
  gray: '858583', grey: '858583', darkgray: '5e5f60', darkgrey: '5e5f60', lightgray: 'b9b9b4',
  lightgrey: 'b9b9b4', silver: 'b4b7b8', dimgray: '5a5a58', dimgrey: '5a5a58', black: '2e2e30',
  white: 'e6e4de', green: '5d7f5c', blue: '4f6f93', yellow: 'cdb667', beige: 'cfc4a6', tan: 'b89f7c',
};

/** Any colour tag as '#rrggbb' (lower case), or null. `roof` softens bare colour names. */
export function colourHex(v, roof = false) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().toLowerCase().replace(/[\s_-]+/g, '');
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1];
  m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(s);
  if (m) return '#' + m[1] + m[1] + m[2] + m[2] + m[3] + m[3];
  const hex = (roof && ROOF_NAMED[s]) || CSS_COLOURS[s];
  return hex ? '#' + hex : null;
}

const ROOF_MAT = {
  roof_tiles: 'roof_tiles', tile: 'roof_tiles', tiles: 'roof_tiles', clay: 'roof_tiles',
  metal: 'metal', metal_sheet: 'metal', 'metal sheet': 'metal', tin: 'metal', zinc: 'metal', steel: 'metal',
  sheet_metal: 'metal', plech: 'metal',
  concrete: 'concrete', tar_paper: 'tar_paper', asphalt: 'tar_paper', bitumen: 'tar_paper',
  asphalt_shingle: 'tar_paper', shingles: 'tar_paper', shingle: 'tar_paper',
  glass: 'glass', acrylic_glass: 'glass', grass: 'grass', copper: 'copper',
  slate: 'slate', shale: 'slate', gravel: 'gravel', wood: 'wood', plastic: 'plastic',
  eternit: 'eternit', asbestos: 'eternit', stone: 'stone', limestone: 'stone', thatch: 'thatch',
  solar_panels: 'solar_panels',
};
const WALL_MAT = {
  plaster: 'plaster', brick: 'brick', bricks: 'brick', masonry: 'brick', concrete: 'concrete',
  ferroconcrete: 'concrete', cement_block: 'concrete', glass: 'glass', mirror: 'glass', wood: 'wood',
  timber_framing: 'wood', stone: 'stone', sandstone: 'stone', limestone: 'stone', metal: 'metal',
  steel: 'metal', iron: 'metal', metal_plates: 'metal', plastic: 'plastic',
};
const COMPASS = { n: 0, nne: 22.5, ne: 45, ene: 67.5, e: 90, ese: 112.5, se: 135, sse: 157.5, s: 180,
  ssw: 202.5, sw: 225, wsw: 247.5, w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
  north: 0, north_east: 45, east: 90, south_east: 135, south: 180, south_west: 225, west: 270, north_west: 315 };

/**
 * The roof and wall fields of a building, as an object to assign onto it:
 *   rc '#rrggbb' roof:colour      rm index into ROOF_MATERIALS
 *   bm index into WALL_MATERIALS  rl roof:levels (0 is an answer: no attic)
 *   rh roof:height, m             rd roof:direction, compass degrees the slope faces
 *   ro 1 ridge along the longest side, 2 across it
 * Only keys OSM actually answers are present.
 */
export function roofTags(t) {
  const out = {};
  const rc = colourHex(t['roof:colour'] ?? t['roof:color'], true);
  if (rc) out.rc = rc;
  const rm = ROOF_MATERIALS.indexOf(ROOF_MAT[String(t['roof:material'] ?? '').toLowerCase()]);
  if (rm > 0) out.rm = rm;
  const bm = WALL_MATERIALS.indexOf(WALL_MAT[String(t['building:material'] ?? t['building:facade:material'] ?? '').toLowerCase()]);
  if (bm > 0) out.bm = bm;
  const rlRaw = t['roof:levels'];
  if (rlRaw !== undefined && /^\d+(\.\d+)?$/.test(String(rlRaw).trim())) {
    const rl = parseFloat(rlRaw);
    if (rl <= 6) out.rl = rl;
  }
  const rh = metres(t['roof:height'], 0.05, 60);
  if (rh) out.rh = +rh.toFixed(1);
  let dir = t['roof:direction'], ori = t['roof:orientation'];
  if (dir === 'along' || dir === 'across') { ori ??= dir; dir = undefined; }   // filed under the wrong key
  if (dir !== undefined) {
    const s = String(dir).trim().toLowerCase();
    const deg = COMPASS[s] ?? (/^-?\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN);
    if (Number.isFinite(deg)) out.rd = +(((deg % 360) + 360) % 360).toFixed(1);
  }
  if (ori === 'along') out.ro = ROOF_ALONG;
  else if (ori === 'across') out.ro = ROOF_ACROSS;
  return out;
}
