// ---- typologyroof.js: which roof a building wears, and what stands on it ----
// Pure data (no three, no DOM), split out of typology.js, which re-exports
// roofOf and roofFurniture: the answers roofs.js builds in both tiers and the
// mesh worker, so they live with the other typology questions and not in the
// geometry.

import { pointInPolygon } from './geo.js';
import { roofFromData, ridgeTurn, photoSaysTiled, dataBacksPitch } from './roofdata.js';
import { hasCourtyard } from './roofholes.js';
import { praguePlace, inOldTown } from './praguezone.js';
import { pragueRoof } from './roofgrammar.js';
import { rnd } from './typologycells.js';
import { shapeOf, zoneRnd } from './typologyshape.js';
import { region } from './regions.js';
const CZ_ROOFS = region().czech;

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
    // …nor on a tin roof at 4 degrees south, where nothing is ever heated
    // (Mahé, js/regions.js: the kitchen is outside, the stove burns gas)
    if (!CZ_ROOFS) return out;
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
