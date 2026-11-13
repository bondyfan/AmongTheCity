// ---- roofdata.js: what the tiles KNOW about a roof and a wall ----
// Pure data, worker safe: no three.js, no DOM, no import at all. typology.js
// asks it one question per building (what does the data say this roof is?)
// and meshes.js one more (what is this wall made of?), and both tiers and both
// threads get the same answer because the answer is a function of the tile
// record alone (docs/TILE-FORMAT.md: rc, rp, rm, bm, rl, rh, rd, ro).
//
// The colour sources, best first:
//   rc  the roof:colour tag. A mapper looked at the roof; taken at its word.
//   rp  the roof as the aerial photograph shows it: sunlit and behind 2 km of
//       haze, so paler and greyer than the material. It is turned BACK into a
//       material colour here (photoToMaterial), because a roof painted in the
//       photographed colour is lit a second time by the game's own sun.
//   nothing: the caller's procedural palette, as before.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/** '#rrggbb' -> 0xrrggbb, or null for anything else. */
export function hexOf(s) {
  if (typeof s !== 'string' || s.length !== 7 || s[0] !== '#') return null;
  const n = parseInt(s.slice(1), 16);
  return Number.isFinite(n) ? n : null;
}

const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const pack = (r, g, b) => (Math.round(clamp(r, 0, 255)) << 16) | (Math.round(clamp(g, 0, 255)) << 8)
  | Math.round(clamp(b, 0, 255));

/**
 * toneOf(hex) -> { y, c, hue, cls }
 * y: luma 0..255, c: chroma (max - min) 0..255, hue in degrees, and the class
 * a roofer would name: red (fired clay), brown, blue, green, or one of the
 * three neutrals dark / grey / pale.
 */
export function toneOf(hex) {
  const r = hex >> 16 & 255, g = hex >> 8 & 255, b = hex & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn, y = luma(r, g, b);
  let hue = 0;
  if (c > 0) {
    hue = mx === r ? ((g - b) / c + 6) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
    hue *= 60;
  }
  let cls;
  const warm = hue >= 335 || hue <= 48;
  if (c >= 30 && warm) cls = 'red';
  else if (c >= 16 && warm) cls = 'brown';
  else if (c >= 22 && hue >= 185 && hue <= 265) cls = 'blue';
  else if (c >= 22 && hue >= 70 && hue < 185) cls = 'green';
  else cls = y < 100 ? 'dark' : y < 162 ? 'grey' : 'pale';
  return { y, c, hue, cls };
}

/**
 * photoToMaterial(hex) -> hex
 * A roof read off the aerial photograph, turned back into the colour of the
 * thing it is made of. Three corrections, all measured on tile 0,-1 where 248
 * roofs carry both a tag and a photo colour:
 *
 *   haze lifts everything toward a pale blue-grey, so chroma comes out at half
 *   of the material's (old-town clay reads #b08778; fired clay is #a8553b).
 *   The chroma vector is scaled back up about the grey axis, which keeps the
 *   hue exactly. Near-neutral roofs are NOT boosted: their faint cast is the
 *   haze's own colour, not the roof's;
 *
 *   a sunlit surface is photographed brighter than its albedo, and the game
 *   lights the roof again, so the value comes down, more for a saturated roof
 *   (the veil is worth most where the material is darkest);
 *
 *   and the result is kept inside what roofing is actually made in.
 */
export function photoToMaterial(hex) {
  const r = hex >> 16 & 255, g = hex >> 8 & 255, b = hex & 255;
  const y = luma(r, g, b), c = Math.max(r, g, b) - Math.min(r, g, b);
  // under 9 of chroma it is the haze talking: pull halfway to neutral. And the
  // haze is blue, so a cool roof gets no boost at all: most "blue" roofs in the
  // photograph are grey ones seen through it.
  const mx = Math.max(r, g, b);
  const cool = c > 0 && mx !== r && !(mx === g && r > b);
  const top = cool ? 1 : PHOTO_GAIN;
  const gain = c < 9 ? 0.5 : 0.5 + (top - 0.5) * sstep(9, 26, c);
  const c2 = Math.min(c * gain, 118);
  const k = c > 0 ? c2 / c : 0;
  const y2 = clamp(PHOTO_Y0 + PHOTO_Y1 * y - PHOTO_YC * c2, 52, 205);
  return pack(y2 + (r - y) * k, y2 + (g - y) * k, y2 + (b - y) * k);
}
const PHOTO_GAIN = 1.5, PHOTO_Y0 = 6, PHOTO_Y1 = 0.9, PHOTO_YC = 0.11;

// ---- roof:material ---------------------------------------------------------
// Index = tile `rm` (tiledata.ROOF_MATERIALS). `p` is the style on a pitched
// roof, `f` on a flat one, `hex` the colours it comes in when nothing says.
const CLAY = [0xa5553b, 0x9c5a44, 0xb0603f, 0x8f4e3c, 0xa86a4c, 0x96563f, 0xb5694a];
const RM = [
  null,
  { p: 'tile', f: 'tile', hex: CLAY },                                       // 1 roof_tiles
  { p: 'metal', f: 'metal', hex: [0x7f868c, 0x8d9296, 0x6c7378, 0x9a9d9c] }, // 2 metal
  { p: 'ctile', f: 'gravel', hex: [0x8f8f8a, 0x85837c, 0x9a968c] },          // 3 concrete
  { p: 'bitumen', f: 'bitumen', hex: [0x4d4e50, 0x56565a, 0x5e5c58] },       // 4 tar_paper
  { p: 'glass', f: 'glass', hex: [0x5f7c8a, 0x6c8a96, 0x587480] },           // 5 glass
  { p: 'grass', f: 'grass', hex: [0x6f8450, 0x7a8a58, 0x66784a] },           // 6 grass
  { p: 'copper', f: 'copper', hex: [0x6fa694, 0x78ab98, 0x67998a] },         // 7 copper (verdigris)
  { p: 'slate', f: 'slate', hex: [0x4b4f57, 0x545860, 0x44474e] },           // 8 slate
  { p: 'gravel', f: 'gravel', hex: [0x8f8b82, 0x9a968c, 0x85837c] },         // 9 gravel
  { p: 'slate', f: 'slate', hex: [0x7a5a40, 0x6e5440, 0x846248] },           // 10 wood (shingle)
  { p: 'metal', f: 'membrane', hex: [0xb1b3b2, 0xa5a8a8, 0xbcbdb9] },        // 11 plastic
  { p: 'slate', f: 'slate', hex: [0x8a8a86, 0x7d7f80, 0x94938e] },           // 12 eternit
  { p: 'slate', f: 'slate', hex: [0x8f8a80, 0x858078, 0x999388] },           // 13 stone
  { p: 'grass', f: 'grass', hex: [0xa89868, 0x9c8c5e] },                     // 14 thatch
  { p: 'glass', f: 'glass', hex: [0x2c3848, 0x323e50] },                     // 15 solar_panels
];

/**
 * photoSaysTiled(f) -> true when the aerial photograph (or the tag) shows
 * fired-clay red. Nothing flat is that colour, so a building the tile left
 * without a roof shape (a "commercial" house in the old town, a five-storey
 * tenement) is given the pitched roof it was photographed with.
 */
export function photoSaysTiled(f) {
  const tag = hexOf(f.rc), photo = hexOf(f.rp);
  if (tag !== null) return toneOf(tag).cls === 'red';
  if (photo === null) return false;
  const T = toneOf(photoToMaterial(photo));
  return T.cls === 'red' && T.c >= 40;
}

// roof:material values that only ever cover a slope: clay or concrete tile,
// copper, slate, shingle, eternit, thatch (indices into RM above)
const PITCH_ONLY = new Set([1, 7, 8, 10, 12, 14]);
/**
 * dataBacksPitch(f) -> true when the tile backs a tagged roof shape with a
 * second witness: a slope-only roofing, an attic storey (roof:levels >= 1),
 * a roof:colour, or clay red in the photograph. The typology stamps some
 * buildings as flat new-builds or pavilions by hash (a third of three to five
 * storey flats); a Vinohrady tenement mapped as gabled, clay tiled, with an
 * attic, must keep the roof it was mapped with.
 */
export function dataBacksPitch(f) {
  if (!f.r || f.r === 'flat') return false;
  return PITCH_ONLY.has(f.rm) || f.rl >= 1 || hexOf(f.rc) !== null || photoSaysTiled(f);
}

/**
 * roofFromData(f, flat, typ, k1, k2) -> { hex, style, src } | null
 * What the tile says this roof is, or null when it says nothing (the caller
 * then keeps its procedural choice). `flat` is whether the SHAPE came out flat,
 * `k1`, `k2` two per-building hashes in 0..1 (passed in, so this module needs
 * no generator of its own). src: 'tag' | 'photo' | 'material'.
 */
export function roofFromData(f, flat, typ, k1, k2) {
  const tag = hexOf(f.rc), photo = hexOf(f.rp);
  const M = RM[f.rm] ?? null;
  if (tag === null && photo === null && !M) return null;
  let hex, src;
  if (tag !== null) {
    hex = tag; src = 'tag';
    // A named colour is ONE tone for a whole street of roofs (165 old-town
    // roofs are all "maroon"), and a CSS name nobody translated is a primary
    // no roofing comes in ("teal" is #008080; the roofs are pale verdigris).
    // Where the photograph agrees about the kind of roof, half of the
    // photographed roof comes back in (more of it against a primary), which
    // is what makes each roof its own age.
    if (photo !== null) {
      const m = photoToMaterial(photo), a = toneOf(tag), b = toneOf(m);
      const warmA = a.cls === 'red' || a.cls === 'brown', warmB = b.cls === 'red' || b.cls === 'brown';
      if (a.c > 100) hex = mixHex(material(tag), m, 0.6);
      else if (warmA === warmB) hex = mixHex(tag, m, 0.5);
    } else hex = material(tag);
  } else if (photo !== null) {
    hex = photoToMaterial(photo); src = 'photo';
  } else {
    hex = M.hex[Math.floor(k2 * M.hex.length) % M.hex.length]; src = 'material';
  }
  const T = toneOf(hex);
  let style;
  if (M) {
    style = flat ? M.f : M.p;
    // "roof_tiles" is concrete tile as often as clay: a neutral one is concrete
    if (style === 'tile' && T.cls !== 'red' && T.cls !== 'brown') style = 'ctile';
  } else if (flat) {
    const shed = typ === 'hall' || typ === 'barn' || typ === 'retail';
    if (T.cls === 'pale') style = shed && k1 < 0.55 ? 'metal' : 'membrane';
    else if (T.cls === 'grey') style = shed ? (k1 < 0.5 ? 'metal' : 'bitumen') : (k1 < 0.7 ? 'gravel' : 'bitumen');
    else if (T.cls === 'blue') style = 'metal';
    else if (T.cls === 'green') style = T.c < 40 ? 'gravel' : typ === 'church' || typ === 'civic' ? 'copper' : 'metal';
    else {
      // dark, or the red-brown mineral grit of torch-on felt. A flat roof that
      // photographs red is not clay: its chroma is brought back to what felt has.
      style = 'bitumen';
      if (T.cls === 'red' || T.cls === 'brown') hex = mixHex(hex, pack(T.y, T.y, T.y), 0.45);
    }
  } else {
    // a pitched roof. A hall or a barn is sheeted; a garage row is felt or
    // sheet whatever the outline says; everything else is the Czech mix of
    // clay, concrete tile, eternit and the odd sheet roof.
    const shed = typ === 'hall' || typ === 'barn', lowly = typ === 'garage';
    if (T.cls === 'red') style = k1 < 0.9 ? 'tile' : 'ctile';
    else if (T.cls === 'brown') style = lowly ? 'bitumen' : k1 < 0.5 ? 'tile' : 'ctile';
    else if (T.cls === 'blue') style = shed || lowly || k1 < 0.5 ? 'metal' : 'slate';
    else if (T.cls === 'green') style = typ === 'church' || typ === 'civic' ? 'copper' : 'metal';
    else if (shed) style = T.cls === 'dark' && k1 < 0.4 ? 'bitumen' : 'metal';
    else if (lowly) style = T.cls === 'pale' ? 'metal' : T.cls === 'dark' || k1 < 0.6 ? 'bitumen' : 'metal';
    else if (T.cls === 'pale') style = k1 < 0.45 ? 'slate' : k1 < 0.8 ? 'metal' : 'ctile';
    else if (T.cls === 'grey') style = k1 < 0.45 ? 'slate' : k1 < 0.85 ? 'ctile' : 'metal';
    else style = k1 < 0.55 ? 'ctile' : k1 < 0.85 ? 'slate' : 'bitumen';
  }
  return { hex, style, src };
}

// A tagged colour brought inside what roofing comes in. Almost every tag
// already is (the builder turns the common names into material tones); what
// is left is the CSS primary: "teal" on the verdigris copper of the old town,
// a pure red. Its hue is kept, its chroma comes down to what paint, patina and
// fired clay can do, and a cool one is lifted, because patina is pale.
//
// The other tag that is not a material is the hex a mapper picked off the
// aerial imagery (whole streets of Prague: #dfb293, #ecbe95). Fired clay is
// never that pale: a warm tag brighter than any tile is the photographed roof,
// and is turned back like one.
function material(hex) {
  const a = toneOf(hex), warm = a.cls === 'red' || a.cls === 'brown';
  if (warm && a.y > 150) return mixHex(hex, photoToMaterial(hex), sstep(150, 188, a.y));
  const cap = warm ? 120 : 62;
  if (a.c <= cap) return hex;
  const k = cap / a.c, y = warm ? a.y : Math.max(a.y, 138);
  return pack(y + ((hex >> 16 & 255) - a.y) * k, y + ((hex >> 8 & 255) - a.y) * k, y + ((hex & 255) - a.y) * k);
}

function mixHex(a, b, t) {
  const m = (s) => (a >> s & 255) * (1 - t) + (b >> s & 255) * t;
  return pack(m(16), m(8), m(0));
}

// ---- building:material -----------------------------------------------------
// Index = tile `bm` (tiledata.WALL_MATERIALS). The wall colour a material comes
// in when the building carries no colour of its own, and the facade family that
// paints it (typology.FAMILIES), where one family is that material.
const BM = [
  null,
  null,                                                                       // 1 plaster: today's palettes
  { fam: 'brick', hex: [0xa8644a, 0x9a5a44, 0xb07a5c, 0x8c5a48, 0xa06a52] },  // 2 brick
  { fam: 'panel', minLv: 4, hex: [0xb9b7b0, 0xa9a8a2, 0xc4c2ba, 0x9d9c96] },  // 3 concrete
  { fam: 'officeGrid', hex: [0xa9b9c4, 0x9fb0bb, 0xb4c0c6, 0x8fa3b0] },       // 4 glass
  { hex: [0x8a6a4a, 0x7c6046, 0x96785a, 0x6e563e] },                          // 5 wood
  { hex: [0xcbbf9f, 0xbfb394, 0xd4c8a8, 0xb3a98f, 0xa8a090] },                // 6 stone (opuka, sandstone)
  { hex: [0xb9bdc2, 0xa8adb3, 0xc9cbc6, 0x8f9aa6] },                          // 7 metal
  { hex: [0xe4e2da, 0xd9d6cc, 0xcfd2d4] },                                    // 8 plastic
];
/** The wall colour of a tagged material (k in 0..1 picks the shade), or null. */
export function wallTone(f, k) {
  const M = BM[f.bm];
  return M ? M.hex[Math.floor(k * M.hex.length) % M.hex.length] : null;
}
/**
 * The facade family a tagged wall material is painted with, or null. Concrete
 * is a panel block (panelak) only from four storeys up: a concrete house or a
 * two-storey annexe is poured or blockwork, and keeps the typology's own cells.
 */
export function wallFamily(f) {
  const M = BM[f.bm];
  if (!M?.fam) return null;
  return (f.lv ?? 0) >= (M.minLv ?? 0) ? M.fam : null;
}

// ---- roof:direction, roof:orientation --------------------------------------
/**
 * ridgeTurn(f, S, mono) -> { swap, flip }
 * `S` is typology.shapeOf(f): u along the longest edge, v = (uz, -ux).
 * swap: the ridge (or a monopitch's level edge) runs along the SHORT side of
 * the box instead of the long one. flip: a monopitch falls the other way.
 * rd (compass degrees the main slope faces, 0 north, 90 east; z points south)
 * beats ro (1 along the longest side, 2 across).
 */
export function ridgeTurn(f, S, mono) {
  const longU = S.L >= S.W;
  if (Number.isFinite(f.rd)) {
    const a = f.rd * Math.PI / 180, dx = Math.sin(a), dz = -Math.cos(a);
    const du = dx * S.ux + dz * S.uz, dv = dx * S.vx + dz * S.vz;
    // the slope faces along whichever box axis the direction is nearer to, so
    // the ridge runs along the other one
    const faceU = Math.abs(du) > Math.abs(dv);
    const swap = faceU === longU;
    // monoRoof falls toward -b, where b is v when the ridge runs along u
    const flip = mono ? (faceU ? du : dv) > 0 : false;
    return { swap, flip };
  }
  return { swap: f.ro === 2, flip: false };
}
