// ---- interiors.js: what is under every roof in Pardubice ----
// The city had 9860 footprints and not one of them had an inside. This module
// gives each one a FLOOR PLAN — a deterministic, data-derived description of
// storeys, rooms, corridors, doors, stair shafts, atria and furniture — from
// nothing but the footprint ring, the RÚIAN height/level tags, the OSM
// building type and the name. Nothing here touches three.js: a plan is pure
// numbers, so it is cheap to make, trivial to test, and pieces.js can turn it
// into geometry (or destruction.js into rubble) without this file knowing.
//
// Two ideas carry the whole module:
//
//  1. USE CLASSIFICATION. A block of flats and a shopping centre are not the
//     same building with different paint — they have different plans. OSM
//     gives us `building=*` (residential/retail/industrial/…), RÚIAN gives
//     `building:levels`, and 254 buildings in Pardubice carry a NAME, which is
//     where the real signal hides: "Palác Pardubice" (13 449 m², 3 levels) is
//     a mall, "Kaufland" is a supermarket, "Gymnázium Mozartova" is a school.
//     classify() layers name → type → geometry (area × levels) so the guess
//     degrades gracefully instead of falling off a cliff on `building=yes`.
//
//  2. OBB PLAN SPACE. Layouts are laid out in the footprint's own oriented
//     bounding box (u along the longest edge, v across it), which is the frame
//     an architect would draw in — corridors run down the length, flats sit
//     either side. Every rectangle is then CLIPPED against the true polygon at
//     geometry time, so an L-shaped or trapezoid footprint gets a plausible
//     layout with the parts that fall outside simply trimmed away. No
//     polygon-partitioning library, no failure modes.
//
// All randomness is rnd(seed, salt) over the feature _id: the same building
// keeps the same plan across chunk rebuilds, sessions and machines, which is
// what makes it safe to throw an interior away and rebuild it later.

import { polygonArea, distPointToSegment, pointInPolygon } from './geo.js';
import { INTERIOR, INTERIOR_PALETTES } from './config.js';

const I = INTERIOR;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// same hash as meshes.js — deterministic per (id, salt), no Math.random anywhere
function rnd(id, salt) {
  let t = (id * 374761393 + salt * 668265263) >>> 0;
  t = Math.imul(t ^ (t >>> 13), 1274126177) >>> 0;
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
}
const pickOf = (arr, id, salt) => arr[Math.floor(rnd(id, salt) * arr.length) % arr.length];

// ---- use classification ---------------------------------------------------

// Czech retail reality: the chains below are unmistakable, and a name is worth
// more than any tag — OSM types them anywhere from `commercial` through `civic`
// to plain `yes`, but nobody calls a block of flats "Kaufland".
const NAME_RULES = [
  [/\b(kaufland|lidl|albert|billa|penny|tesco|globus|interspar|spar|makro|norma|coop|flop)\b/i, 'supermarket'],
  [/(hornbach|hobby|obi|baumax|bauhaus|mountfield|asko|sconto|jysk|autosalon|autocentrum)/i, 'supermarket'],
  [/(nákupní|nakupni|obchodní (dům|centrum)|obchodni (dum|centrum)|galerie|arkád|arkad|palác|palac|palace|forum|fórum|atrium|\boc\b|\bod\b)/i, 'mall'],
  [/(škol|skol|gymnázi|gymnazi|univerzit|fakult|učiliš|ucilis|konzervatoř|mateřsk|matersk|internát|internat)/i, 'school'],
  [/(nemocnic|poliklinik|klinik|ordinac|zdravotn|lékařsk|lekarsk|hospic)/i, 'hospital'],
  [/(hotel|penzion|hostel|ubytovn)/i, 'hotel'],
  [/(kostel|katedrál|katedral|kaple|chrám|chram|synagog|bazilik)/i, 'church'],
  // "hala" is the trap: in Czech it is a warehouse far more often than a sports
  // venue ("HALA B" is a 24 000 m² shed), so the industrial rule has to see it
  // FIRST and the civic one may only claim a hala that says what sport it is.
  [/(sklad|hala\b|výrobn|vyrobn|továrn|tovarn|závod|zavod|dílna|dilna|depo|kotelna|montážn|montazn)/i, 'industrial'],
  [/(arena|aréna|stadion|bazén|bazen|tělocvič|telocvic|sportovní|sportovni|zimní stadion)/i, 'civic'],
  [/(garáž|garaz|parkov|parking)/i, 'parking'],
  [/(kancelář|kancelar|administrativ|centrum\b.*(služeb|sluzeb)|pojišťovn|pojistovn|banka|úřad|urad|magistrát|magistrat)/i, 'office'],
];

// OSM building=* → our use class. Anything unlisted falls to the geometry
// heuristics below, which is exactly where `yes`/`no`/`roof` (2400 buildings
// in Pardubice alone) end up.
const TYPE_USE = {
  apartments: 'flats', residential: 'flats', dormitory: 'flats', terrace: 'flats',
  panel: 'flats', house: 'house', detached: 'house', bungalow: 'house',
  semidetached_house: 'house', cabin: 'house', allotment_house: 'house',
  hut: 'garage', shed: 'garage', garage: 'garage', garages: 'garage',
  carport: 'garage', container: 'garage', greenhouse: 'garage',
  industrial: 'industrial', warehouse: 'industrial', manufacture: 'industrial',
  barn: 'industrial', farm_auxiliary: 'industrial', hangar: 'industrial',
  silo: 'industrial', works: 'industrial',
  retail: 'shop', commercial: 'shop', supermarket: 'supermarket',
  kiosk: 'shop', shop: 'shop', mall: 'mall',
  office: 'office', school: 'school', university: 'school', college: 'school',
  kindergarten: 'school', hospital: 'hospital', clinic: 'hospital',
  hotel: 'hotel', church: 'church', chapel: 'church', cathedral: 'church',
  mosque: 'church', synagogue: 'church', temple: 'church',
  parking: 'parking', civic: 'civic', public: 'civic', government: 'civic',
  train_station: 'civic', transportation: 'civic', sports_hall: 'civic',
  grandstand: 'civic', fire_station: 'civic', castle: 'civic', museum: 'civic',
  toilets: 'garage', service: 'garage', elevator: 'garage',
};

// Czech HUD labels — the action hint tells you what you are walking into
export const USE_LABEL = {
  flats: 'Bytový dům', house: 'Rodinný dům', mall: 'Nákupní centrum',
  supermarket: 'Supermarket', shop: 'Obchod', office: 'Administrativní budova',
  school: 'Škola', hospital: 'Nemocnice', hotel: 'Hotel',
  industrial: 'Průmyslová budova', parking: 'Parkovací dům', church: 'Kostel',
  garage: 'Garáž', civic: 'Veřejná budova', restaurant: 'Restaurace',
};

// ---- the real Pardubice retail -------------------------------------------
// The city's shops are not generic, and pretending they are is the difference
// between "a supermarket" and "the Kaufland". A Lidl is deliberately the same
// building everywhere in Europe — that is the whole point of a Lidl — while
// Kaufland runs a ~4 200 m² hall carrying about 30 000 lines, and Penny spent
// 2026 converting its clinical discounter aisles to the warmer "Market Hall"
// layout. In the centre, Palác Pardubice (AFI Palác) on Masarykovo náměstí is a
// three-level gallery of 116 units with a Cinema City multiplex under the roof
// and 600 parking spaces, and the 1974 Obchodní dům Prior beside it — 5 850 m²,
// the first escalators in Pardubice — had its two upper levels joined into that
// gallery in the 2022 rebuild, with a grocery store left on the ground floor.
//
// Sources: palacpardubice.cz and nakupni-centra.com (116 units, Cinema City
// IMAX, 600 spaces), cs.wikipedia.org "Obchodní dům Prior (Pardubice)"
// (5 850 m², 1971–74, first escalators, post-2022 layout), retaildetail.eu
// (Kaufland's standard hall size and range), grocerytradenews.com (Penny's
// Market Hall refit, 441 Czech stores).
//
// A brand overrides the geometric guesses: how many levels, how wide a unit,
// how big the void, how many tills, and which props belong on the floor.
// `wall` is the box the chain builds (these are all clad boxes, and the cladding
// colour is part of the brand), `sign` the colour of the illuminated fascia band
// that runs above the entrance — the thing you actually recognise from the road.
const BRANDS = [
  { re: /(pal[áa]c pardubice|afi pal[áa]c|afi palace)/i, use: 'mall', label: 'Nákupní galerie',
    storeys: 3, unitW: 9.5, atriumK: 0.52, cinemaTop: true, units: 116,
    wall: 0xd8d2c6, sign: 0x1f4f9c },
  { re: /(obchodn[íi] d[uů]m prior|\bprior\b)/i, use: 'mall', label: 'Obchodní dům',
    storeys: 3, unitW: 12, atriumK: 0.34, escalators: true, groundGrocery: true,
    wall: 0xcdc7bb, sign: 0xc8362b },
  { re: /(go[čc][áa]rova galerie|^grand$)/i, use: 'mall', label: 'Nákupní centrum',
    storeys: 2, unitW: 8.5, atriumK: 0.42, wall: 0xd6d0c4, sign: 0x2f6b52 },
  // the discounters, in their own colours
  { re: /^kaufland/i, use: 'supermarket', label: 'Kaufland',
    tills: 8, aisles: 9, trolleys: true, bakery: true, backHouse: 0.24,
    wall: 0xe4e2dc, sign: 0xe10915 },                       // white box, red fascia
  { re: /^lidl/i, use: 'supermarket', label: 'Lidl',
    tills: 4, aisles: 6, trolleys: true, bakery: true, middleAisle: true, backHouse: 0.2,
    wall: 0xeceae4, sign: 0x0050aa },                       // white box, blue fascia
  { re: /^penny/i, use: 'supermarket', label: 'Penny Market',
    tills: 3, aisles: 5, trolleys: true, marketHall: true, backHouse: 0.18,
    wall: 0xe8e5de, sign: 0xd51317 },
  { re: /^albert/i, use: 'supermarket', label: 'Albert',
    tills: 6, aisles: 7, trolleys: true, bakery: true, backHouse: 0.2,
    wall: 0xe6e6e2, sign: 0x0a4ea2 },
  { re: /^billa/i, use: 'supermarket', label: 'Billa',
    tills: 5, aisles: 6, trolleys: true, bakery: true, backHouse: 0.2,
    wall: 0xe9e6de, sign: 0xf2c200, fg: 0x1c1c1c },    // dark wordmark on yellow
  { re: /^(coop|flop|norma)/i, use: 'supermarket', label: 'Supermarket',
    tills: 4, aisles: 6, trolleys: true, backHouse: 0.2, wall: 0xe4e2da, sign: 0xd0562a },
  { re: /(globus|interspar|makro|tesco)/i, use: 'supermarket', label: 'Hypermarket',
    tills: 12, aisles: 12, trolleys: true, bakery: true, restaurant: true, backHouse: 0.26,
    wall: 0xe2e0d8, sign: 0x00539b },
  { re: /(uni hobby|hornbach|\bobi\b|bauhaus|baumax|asko|sconto|jysk|mountfield)/i,
    use: 'supermarket', label: 'Hobbymarket',
    tills: 5, aisles: 6, racking: true, backHouse: 0.15, wall: 0xdcd8cc, sign: 0xf07f13 },
  // ---- fast food ----
  // OSM carries no building called "McDonald's" anywhere in the region (the
  // restaurants are amenity NODES, which the data pipeline does not keep), so
  // these are placed onto suitable host buildings by stampFranchises() below.
  // A modern McDonald's is not a beige-plaster box: since the 2010s "Ray Kroc"
  // refit the chain builds grey-brown clad pavilions with a full-glass frontage
  // and an anthracite band over the glazing. `wall` is what the far LOD paints
  // the whole box (buildingWallHex reads it), `clad` the dark band pieces.js
  // hangs over the glass front. KFC builds the same pavilion in light grey with
  // the band in its red.
  { re: /mcdonald/i, use: 'restaurant', label: "McDonald's",
    tills: 4, seats: true, drive: true,
    wall: 0x8d8579, clad: 0x45423e, sign: 0xffc72c, trim: 0xda291c },
  { re: /\bkfc\b/i, use: 'restaurant', label: 'KFC',
    tills: 3, seats: true, drive: true,
    wall: 0xd9d5cc, clad: 0xa31c26, sign: 0xe4002b, trim: 0xf5f5f0 },
];

// ---- franchises ----------------------------------------------------------
// Fast food lives in OSM as amenity nodes on top of unnamed retail sheds, and
// build-city.mjs keeps only a handful of POI kinds, so nothing in the data says
// "McDonald's". Rather than invent coordinates, the restaurants are ATTACHED to
// hosts the data does describe: a small retail/commercial building, preferably
// one standing near a station or a shopping centre, chosen deterministically
// from its own id so the same shed is the same restaurant on every machine and
// in every session. Called once per streamed tile.
const FRANCHISES = [
  // Tuned against the real data, not guessed: over the six tiles around
  // Pardubice (~29 × 29 km, 35 000 buildings) this lands 4 McDonald's and
  // 1 KFC, which is about what that area really has. The old 34/53 on the old
  // host pool made 24 of them in the ONE Pardubice tile.
  { name: "McDonald's" }, { name: "McDonald's" }, { name: 'KFC' },   // 2 : 1, as in life
];
// SHOPS ONLY. `civic` used to be in here, and `civic` is the classifier's
// catch-all — both a common OSM tag and the geometry fallback for any untyped
// footprint over 700 m². Measured on the Pardubice tile, 23 of the 24 stamped
// restaurants landed on one: schools, sports halls, fire stations, a
// `building=transportation`. That is the whole of "everywhere I look it is a
// McDonald's or a KFC". `restaurant` is dead weight here too — an UNNAMED
// building can never classify as one, since only brandOf() yields it and that
// needs the name this function is about to write.
const HOST_USES = new Set(['shop', 'supermarket']);
// …and the OSM type has to agree it is retail. The use alone can be reached by
// the geometry fallback, which knows nothing about what the building sells.
const HOST_TYPES = new Set(['retail', 'commercial', 'supermarket', 'kiosk', 'shop']);
// WHERE A DRIVE-THROUGH ACTUALLY STANDS. Hashing over every retail shed in
// the region put the restaurants nowhere in particular — "McDonald's u
// hlavního nádraží tam není, ale v realitě tam je". A Czech McDonald's is at
// a station, at a hypermarket car park, or on a main road out of town, and
// the data already says where those are: railway=station POIs (kept by the
// pipeline as t:'station') and the big car parks. Requiring an anchor is a
// per-building test — it never depends on which OTHER buildings were picked —
// so a name once given is never taken away, and no chunk is left holding
// signage for a franchise that has moved.
const ANCHOR_R = 260;
// the envelope of a drive-through pavilion, shared by every chain
const FR_MIN_AREA = 150, FR_MAX_AREA = 1400, FR_MAX_H = 9;
function anchorsOf(city) {
  if (!city) return null;
  const n = (city.pois?.length ?? 0) + (city.paved?.length ?? 0);
  if (city._frAnchors && city._frAnchorsN === n) return city._frAnchors;
  const out = [];
  for (const p of city.pois ?? []) if (p.t === 'station') out.push(p.p[0], p.p[1]);
  for (const p of city.paved ?? []) {
    if (p.t !== 'parking' || !p.o || p.o.length < 3) continue;
    // a HYPERMARKET's car park — 8 000 m² is a couple of hundred spaces. At
    // 2 200 every yard behind every shop qualified and the gate stopped
    // gating: the restaurants were scattered exactly as widely as before.
    if (Math.abs(polygonArea(p.o)) < 8000) continue;
    let sx = 0, sz = 0;
    for (const [x, z] of p.o) { sx += x; sz += z; }
    out.push(sx / p.o.length, sz / p.o.length);
  }
  city._frAnchorsN = n;
  return (city._frAnchors = out);
}
export function stampFranchises(buildings, city) {
  const anchors = anchorsOf(city);
  if (!anchors?.length) return;
  // ONE RESTAURANT PER SITE, and it is the nearest suitable building to it —
  // not a hash spread thinly over the whole region. Hashing put the count
  // right and the PLACES wrong: the pavilion by Pardubice hlavní nádraží,
  // which in reality is a McDonald's, drew nothing while sheds in the fields
  // drew several. A site is served once and then remembered, so a name is
  // never given twice and never taken back, however the tiles stream in.
  const served = city._frServed ??= new Set();
  for (let a = 0; a < anchors.length; a += 2) {
    const ax = anchors[a], az = anchors[a + 1];
    const akey = Math.round(ax) + ',' + Math.round(az);
    if (served.has(akey)) continue;
    let best = null, bestD = ANCHOR_R * ANCHOR_R;
    for (const f of buildings) {
      if (f.n || !f.o || f.o.length < 3) continue;    // never rename a real name
      const d = (f.o[0][0] - ax) ** 2 + (f.o[0][1] - az) ** 2;
      if (d >= bestD) continue;
      const area = Math.abs(f._area ??= polygonArea(f.o));
      if (area < FR_MIN_AREA || area > FR_MAX_AREA) continue;
      if ((f.h ?? 0) > FR_MAX_H) continue;   // a drive-through is not six storeys
      const use = classify(f);
      if (!HOST_USES.has(use) || !HOST_TYPES.has(f.t)) continue;
      bestD = d; best = f;
    }
    if (!best) continue;
    // which chain got this site is hashed from the SITE, so it is the same on
    // every machine and does not move when a neighbouring tile arrives
    const fr = FRANCHISES[Math.floor(rnd(Math.abs(Math.round(ax) * 7 + Math.round(az) * 13), 77)
      * FRANCHISES.length) % FRANCHISES.length];
    best.n = fr.name;
    best._use = null; best._brand = undefined;         // re-decide with the name
    classify(best);
    served.add(akey);
  }
}
// A SHOP WITH NO NAME IS STILL A SHOP. Signage is gated entirely on a BRANDS
// match (js/pieces.js brandSigns, js/meshes.js's far-LOD wordmark), so an
// unnamed retail unit got no fascia at all — from the street the only building
// that said anything was a chain, which is most of why stamping chains
// everywhere ever looked like an improvement. These are the plain Czech
// fascias every high street actually wears, and a shop that HAS a name in OSM
// simply wears its own.
const GENERIC_SIGN = {
  shop: { label: 'OBCHOD', sign: 0x35618c, trim: 0xf2f4f6 },
  supermarket: { label: 'POTRAVINY', sign: 0x2e6b45, trim: 0xf2f4f6 },
  restaurant: { label: 'RESTAURACE', sign: 0x7a4326, trim: 0xf6efe4 },
};
export function signBrandOf(f, use) {
  const b = brandOf(f);
  if (b) return b;
  const g = GENERIC_SIGN[use];
  if (!g) return null;
  // an OSM name beats the generic word — "POTRAVINY U NOVÁKA" over the door
  return f.n ? { ...g, label: f.n.toUpperCase().slice(0, 20) } : g;
}
export function brandOf(f) {
  if (f._brand !== undefined) return f._brand;
  let hit = null;
  if (f.n) for (const b of BRANDS) if (b.re.test(f.n)) { hit = b; break; }
  return (f._brand = hit);
}

// ---- architectural identity (v7) -------------------------------------------
// The complaint this answers: "the branding is right but every building is the
// same Soviet box". classify() stamps two colour identities straight onto the
// FEATURE (f.c, the "#rrggbb" the data format already carries), because
// meshes.js's buildingWallHex honours f.c — so the far LOD and the near shell
// agree on the new identity with zero meshes.js edits.
//
// NOVOSTAVBY are hash-scattered, NOT data-derived: OSM has no "year built"
// here, so ~30 % of the low blocks of flats (3–5 storeys, not panel type) are
// picked deterministically by id hash and rendered as new builds — white
// plaster, tall windows, French balconies (pieces.js reads plan.nova).
const NOVA_WALLS = ['#e9e7e1', '#e3e3e0', '#dcdad4', '#e7e1d8'];
// offices go cool grey/blue-grey — the curtain-wall shell wears wallHex, so
// the flat-colour far box has to be the same cool grey or the LODs disagree
const OFFICE_WALLS = ['#9fa9b4', '#93a1af', '#a9b3bd', '#8d99a7'];

// Uses whose ground floor is one big open volume — no corridor, no partitions,
// just a hall with things standing in it.
const OPEN_USES = new Set(['industrial', 'parking', 'church', 'garage',
  'supermarket', 'shop', 'mall', 'restaurant']);

/**
 * classify(f) → use-class string. Cached on the feature as `_use`.
 * Order matters: an explicit shop/amenity tag from the data pipeline (`u`)
 * wins, then the NAME, then the OSM type, then pure geometry.
 */
export function classify(f) {
  if (f._use) return f._use;
  const area = Math.abs(f._area ??= polygonArea(f.o));
  const lv = f.lv ?? Math.max(1, Math.round((f.h ?? 6) / 3.1));
  let use = null;

  // the build scripts may emit `u` = shop=*/amenity=* for a building; when a
  // rebuilt dataset carries it, it beats every guess below
  if (f.u) {
    if (/^(mall|department_store)$/.test(f.u)) use = 'mall';
    else if (/^(supermarket|hypermarket|wholesale|doityourself|hardware|furniture|car)$/.test(f.u)) use = 'supermarket';
    else if (/^(school|college|university|kindergarten)$/.test(f.u)) use = 'school';
    else if (/^(hospital|clinic|doctors)$/.test(f.u)) use = 'hospital';
    else if (/^(hotel|hostel|guest_house)$/.test(f.u)) use = 'hotel';
    else if (/^(place_of_worship)$/.test(f.u)) use = 'church';
    else if (/^(parking|parking_space)$/.test(f.u)) use = 'parking';
    else if (f.u) use = 'shop';
  }
  // a chain we actually know beats every other signal — OSM types Kaufland as
  // `commercial`, Albert as `civic` and Palác Pardubice as `retail`
  if (!use) use = brandOf(f)?.use ?? null;
  if (!use && f.n) for (const [re, u] of NAME_RULES) if (re.test(f.n)) { use = u; break; }
  if (!use) use = TYPE_USE[f.t] ?? null;

  // geometry fallback for the untyped mass (`yes`, `no`, `roof`, `service`):
  // a 40 m² thing with one storey is a garden shed, a 4000 m² thing with one
  // storey is a hall, and five storeys over 300 m² is housing.
  if (!use) {
    use = area < 55 ? 'garage'
      : area > 2600 && lv <= 2 ? 'industrial'
      : lv >= 3 ? 'flats'
      : area > 700 ? 'civic' : 'house';
  }

  // promotions the type alone can't see: a 3-storey 13 000 m² "retail" IS a
  // mall, a single-storey 2000 m² one is a supermarket, and a 60 m² "flats"
  // is somebody's cottage.
  if (use === 'shop') {
    if (area >= 3500 && lv >= 2) use = 'mall';
    // a multi-storey `commercial` is an office building, not six floors of shop
    else if (f.t === 'commercial' && lv >= 3) use = 'office';
    else if (area >= 900) use = 'supermarket';
  }
  if (use === 'flats' && (area < 130 || lv <= 2) && f.t !== 'apartments') use = 'house';
  if (use === 'house' && lv >= 4) use = 'flats';
  if (use === 'garage' && area > 400) use = 'industrial';

  // identity stamps (see the NOVA_WALLS block above): mutate f.c only when the
  // data gave none and the building is unnamed — named landmarks keep their own
  // face, and a real OSM colour always wins over an invented one
  if (use === 'flats' && !f.n && f.t !== 'panel' && lv >= 3 && lv <= 5
      && rnd(f._id, 77) < 0.3) {
    f._nova = true;
    if (!f.c) f.c = NOVA_WALLS[Math.floor(rnd(f._id, 78) * NOVA_WALLS.length) % NOVA_WALLS.length];
  }
  if (use === 'office' && !f.n && !f.c)
    f.c = OFFICE_WALLS[Math.floor(rnd(f._id, 79) * OFFICE_WALLS.length) % OFFICE_WALLS.length];
  return (f._use = use);
}

// ---- footprint frame (the OBB every plan is drawn in) ---------------------
// u runs along the footprint's longest edge — for the overwhelming majority of
// Czech buildings that IS the street frontage, so corridors laid along u come
// out parallel to the street, which is what makes the plans look intentional.
function frameOf(ring) {
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
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  return {
    ux, uz, vx, vz,
    cx: ux * cu + vx * cv, cz: uz * cu + vz * cv,
    hu: (u1 - u0) / 2, hv: (v1 - v0) / 2,
    // yaw that maps a mesh's local +x onto the u axis: rotation.y = θ sends
    // (1,0,0) → (cos θ, 0, −sin θ), so θ = atan2(−uz, ux). v-aligned pieces
    // simply add π/2 (verified: that lands on (uz, −ux) = the v axis).
    yaw: Math.atan2(-uz, ux),
  };
}

// plan space (u,v are offsets from the footprint centre) → world meters
export function planToWorld(fr, u, v, out) {
  out.x = fr.cx + fr.ux * u + fr.vx * v;
  out.z = fr.cz + fr.uz * u + fr.vz * v;
  return out;
}

// ---- street entrance -----------------------------------------------------
// Where the front door goes. Cut into the FACADE by meshes.js and into the
// interior lining by pieces.js from this one answer, so the two holes line up
// by construction, and marked in the world by main.js so you can SEE it from
// across the street. Cached on the feature — chunk rebuilds must not move a
// door the player has already walked through.
//
// Four things decide the edge, in order of how much they matter:
//
//  1. IS IT REACHABLE? A door on a party wall opens into the neighbour's
//     living room, and Czech street blocks are terraced, so this is the common
//     case rather than the exception. An outward probe 2.5 m off the edge
//     midpoint that lands inside ANOTHER building disqualifies that edge
//     outright — an edge with no open ground in front of it LOSES, whatever
//     its other virtues (the −400 dwarfs every positive term). The first
//     version had no such test, and that is why some buildings genuinely had
//     no way in; 1.4 m was the second version, and it still let doors open
//     into half-metre slots between terraced houses.
//  2. DOES IT FACE THE STREET, not merely stand near one? Distance to the
//     nearest way matters, but so does DIRECTION: the winning edge's outward
//     normal must point TOWARD the nearest drivable road, or a corner house
//     30 m from two streets puts its door on the flank that happens to be a
//     metre closer while facing the neighbour's fence. When a drivable way
//     runs within 35 m, dot(normal, direction-to-road) earns up to ±14 —
//     enough to overturn a few metres of raw distance.
//  3. IS IT WIDE ENOUGH TO BE A FRONT? Frontage length, capped — a 60 m flank
//     is not more of a front than a 26 m one.
export function entranceOf(f, roads, neighbours) {
  if (f._ent !== undefined) return f._ent;
  const ring = f.o;
  if (!ring || ring.length < 3) return (f._ent = null);
  const out = (polygonArea(ring) > 0 ? 1 : -1);
  let best = null, bestScore = -1e9;
  const probe = { x: 0, z: 0, t: 0 };
  const mk = (i, ax, az, bx, bz, L, w) => ({
    i, len: L, x: (ax + bx) / 2, z: (az + bz) / 2,
    // outward normal: a positive-area ring keeps its INTERIOR on (−dz, dx)
    // (the convention meshes.js's skirtRing and wallQuad already share), so
    // outward is the other one.
    nx: out * (bz - az) / L, nz: -out * (bx - ax) / L,
    t: 0.5, w,                        // t = 0..1 centre param along the edge
  });
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz);
    if (L < I.entryW + 1.0) continue;
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const nx = out * dz / L, nz = -out * dx / L;
    // 1. blocked by a neighbour?
    let blocked = false;
    if (neighbours) {
      const px = mx + nx * 2.5, pz = mz + nz * 2.5;
      for (const o of neighbours) {
        if (o === f || !o.o || o.o.length < 3) continue;
        if (pointInPolygon(px, pz, o.o)) { blocked = true; break; }
      }
    }
    // 2. how far to a street — and which way does the nearest DRIVABLE one lie?
    let road = 40, drd = 1e9, drx = 0, drz = 0;
    if (roads) {
      for (const r of roads) {
        if (!r.p) continue;
        // footways count: a door onto a pavement is still a door
        for (let k = 0; k < r.p.length - 1; k++) {
          const d = distPointToSegment(mx, mz, r.p[k][0], r.p[k][1],
            r.p[k + 1][0], r.p[k + 1][1], probe);
          if (d < road) road = d;
          if (r.d === 1 && d < drd) { drd = d; drx = probe.x; drz = probe.z; }
        }
        if (road < 3 && drd < 3) break;
      }
    }
    let score = Math.min(L, 26) * 1.4 - road * 1.9 - (blocked ? 400 : 0);
    if (drd < 35) {
      // reward an edge that FACES the carriageway, punish one turned away
      const ddx = drx - mx, ddz = drz - mz, dl = Math.hypot(ddx, ddz);
      score += 14 * (dl > 1e-6 ? (nx * ddx + nz * ddz) / dl : 1);
    }
    if (score > bestScore) {
      bestScore = score;
      best = mk(i, ax, az, bx, bz, L, Math.min(I.entryW, L - 0.8));
    }
  }
  if (!best) {                                  // every edge shorter than a door
    // take the longest one anyway and squeeze the opening into it: a 2 m² kiosk
    // still has to be enterable, or "every building" is a lie
    let li = 0, lL = 0;
    for (let i = 0; i < ring.length; i++) {
      const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
      const L = Math.hypot(bx - ax, bz - az);
      if (L > lL) { lL = L; li = i; }
    }
    const [ax, az] = ring[li], [bx, bz] = ring[(li + 1) % ring.length];
    best = mk(li, ax, az, bx, bz, lL || 1, Math.max(0.95, Math.min(1.4, lL * 0.75)));
  }
  return (f._ent = best);
}

// ---- room-kind vocabularies ----------------------------------------------
// Each use class hands its rooms a kind, and pieces.js furnishes by kind. The
// order is deliberate: the first entry lands in the biggest room of a unit.
const UNIT_KINDS = {
  flats: ['living', 'bedroom', 'bedroom', 'kitchen', 'bath'],
  house: ['living', 'kitchen', 'bedroom', 'bedroom', 'bath'],
  hotel: ['hotelroom'],
  school: ['classroom'],
  hospital: ['ward'],
  office: ['office'],
  civic: ['office'],
  mall: ['unit'],
  shop: ['unit'],
};
// unit frontage (m) along the corridor, per use — a classroom is 8.5 m wide,
// a hotel room 4.2, a flat 9. This single number is most of what makes the
// plans of a school and a hotel feel different from the corridor.
const UNIT_W = {
  flats: 9.2, house: 7, hotel: 4.4, school: 8.6, hospital: 5.6,
  office: 5.2, civic: 6.4, mall: 11, shop: 8,
};

// ---- plan construction ---------------------------------------------------

const rect = (u0, v0, u1, v1) => ({ u0, v0, u1, v1 });
const rw = (r) => r.u1 - r.u0;
const rd = (r) => r.v1 - r.v0;

// A wall runs from (u0,v0) to (u1,v1) at floor level, `hTop` tall, with `gaps`
// = [t0,t1] parameter windows along its length left open for doors. Every
// partition this module emits is axis-aligned in plan space; that is what lets
// pieces.js panel them without a general clipper.
function wall(u0, v0, u1, v1, hTop, gaps, kind) {
  return { u0, v0, u1, v1, hTop, hBot: 0, gaps: gaps ?? [], kind: kind ?? 'wall' };
}
// door gap centred at parameter `c` (0..1) of a wall of length L
function gapAt(L, c, width) {
  const h = Math.min(0.45, (width ?? I.doorW) / 2 / Math.max(L, 0.5));
  return [clamp(c - h, 0, 1), clamp(c + h, 0, 1)];
}

// Recursive binary subdivision. Each cut becomes ONE wall with ONE door, so
// the result is a tree of rooms in which every room is reachable from the unit
// entrance — a layout that is connected by construction, never by luck.
function subdivide(r, seed, salt, minSide, minArea, depth, rooms, walls, h) {
  const w = rw(r), d = rd(r);
  if (depth <= 0 || w * d < minArea * 2 || (w < minSide * 2 && d < minSide * 2)) {
    rooms.push(r);
    return;
  }
  const alongU = w >= d;
  const len = alongU ? w : d;
  if (len < minSide * 2) { rooms.push(r); return; }
  const f = 0.36 + rnd(seed, salt) * 0.28;
  const cut = (alongU ? r.u0 : r.v0) + len * f;
  const span = alongU ? d : w;
  const g = gapAt(span, 0.25 + rnd(seed, salt + 1) * 0.5);
  walls.push(alongU ? wall(cut, r.v0, cut, r.v1, h, [g])
    : wall(r.u0, cut, r.u1, cut, h, [g]));
  const a = alongU ? rect(r.u0, r.v0, cut, r.v1) : rect(r.u0, r.v0, r.u1, cut);
  const b = alongU ? rect(cut, r.v0, r.u1, r.v1) : rect(r.u0, cut, r.u1, r.v1);
  subdivide(a, seed, salt * 2 + 11, minSide, minArea, depth - 1, rooms, walls, h);
  subdivide(b, seed, salt * 2 + 17, minSide, minArea, depth - 1, rooms, walls, h);
}

// Stair core: a 2.95 m × (19 × 0.29 m) shaft holding a straight run beside an
// equally wide landing. The run half is a HOLE in every slab above the floor it
// starts on — that hole is how you actually emerge upstairs — while the landing
// half keeps its slab on every level and carries the door to the corridor.
// Runs alternate ends floor by floor, so climbing is one continuous zig-zag
// with no dead landing to walk around, exactly like a panelák staircase.
//
// Placement is the one part of a plan that MUST land inside the real polygon.
// Everything else is clipped at geometry time and degrades gracefully — a
// corridor that runs off the end of an L-shaped wing just gets shorter — but a
// stairwell clipped away leaves upper floors you cannot reach. (That is exactly
// what happened to the 305 m station hall: its OBB is far wider than the
// building at the point the shaft was parked, so all 19 treads were rejected
// and the first floor became unreachable.) So: candidate positions are tried
// against the footprint, and a building where none fits becomes single-storey
// rather than a lie.
//
// Of the candidates that DO fit, the one closest to the front door wins —
// nobody builds the staircase at the far end of the corridor from the
// entrance — with two hard vetoes: the shaft may never contain the entrance
// midpoint (the front door cannot open into the stairs; a candidate that
// would is SHIFTED along u until it clears, or dies), and a block that needs
// a lift strongly prefers a candidate with room for its shaft beside the
// stair, landing side, so one lobby serves both doors.
const LIFT_W = 1.9, LIFT_D = 2.1;         // výtah shaft, u × v
function placeCore(fr, seed, sH, inside, ent, needLift) {
  const steps = Math.max(6, Math.round(sH / I.stepRise));
  const runL = steps * I.stepGo;
  const W = I.coreW;
  if (fr.hu * 2 < runL + 2.4 || fr.hv * 2 < W + 0.8) return null;

  // u: long buildings want it in the middle (nobody walks 150 m to the stairs),
  // short ones against the gable the way row housing does; then a sweep along
  // the length, which is what saves wings and L-shapes.
  const mid = fr.hu * 2 > 40;
  const uLo = -fr.hu + 0.55, uHi = fr.hu - 0.55 - runL, uMid = -runL / 2;
  const uCand = mid ? [uMid, uLo, uHi] : [uLo, uMid, uHi];
  for (let k = 1; k <= 7; k++) uCand.push(uLo + (k / 8) * (uHi - uLo));

  // v: hug a long wall (a stairwell is a wall thing), else straddle the centre
  const vSide = rnd(seed, 91) < 0.5 ? -1 : 1;
  const vCand = fr.hv * 2 < W + 4 ? [-W / 2]
    : [vSide > 0 ? fr.hv - 0.5 - W : -fr.hv + 0.5,
       vSide > 0 ? -fr.hv + 0.5 : fr.hv - 0.5 - W,
       -W / 2];

  const M = 1.5;      // u clearance around the door: a vestibule's half-width
  const MV = 0.8;     // v slack for "the shaft sits on the door"
  let best = null, bestScore = -1e9;
  for (const uc of uCand) {
    if (uc < uLo - 1e-6 || uc > uHi + 1e-6) continue;
    for (const v0 of vCand) {
      let u0 = uc;
      if (ent && ent.v > v0 - MV && ent.v < v0 + W + MV
          && ent.u > u0 - M && ent.u < u0 + runL + M) {
        // the front door would open into the shaft: slide along u, the
        // shorter way first, and drop the candidate if neither end has room
        const right = ent.u + M, left = ent.u - M - runL;
        const opts = Math.abs(right - u0) < Math.abs(left - u0)
          ? [right, left] : [left, right];
        u0 = null;
        for (const o of opts) if (o >= uLo - 1e-6 && o <= uHi + 1e-6) { u0 = o; break; }
        if (u0 === null) continue;
      }
      const s = rect(u0, v0, u0 + runL, v0 + W);
      if (!rectInside(s, inside, 0.3)) continue;
      // The LANDING must be the half nearer the building's middle, or the door
      // out of the shaft would open into the outside wall and the corridor
      // could never reach it. coreHalves(): runSide 1 → run is the far half.
      const centreV = (s.v0 + s.v1) / 2;
      const runSide = centreV >= 0 ? 1 : 0;
      // the lift leans against the stair at either end, its door flush with
      // the face the landing door is on — try the entrance side first
      let lift = null;
      if (needLift) {
        const landV1 = runSide ? s.v0 + W / 2 : s.v1;
        const doorOnV1 = landV1 >= s.v1 - 1e-6;
        const lv0 = doorOnV1 ? s.v1 - LIFT_D : s.v0;
        const sides = ent && ent.u < (s.u0 + s.u1) / 2 ? [-1, 1] : [1, -1];
        for (const sd of sides) {
          const lr = sd > 0 ? rect(s.u1, lv0, s.u1 + LIFT_W, lv0 + LIFT_D)
                            : rect(s.u0 - LIFT_W, lv0, s.u0, lv0 + LIFT_D);
          if (!rectInside(lr, inside, 0.25)) continue;
          if (ent && ent.u > lr.u0 - 0.6 && ent.u < lr.u1 + 0.6
              && ent.v > lr.v0 - MV && ent.v < lr.v1 + MV) continue; // door into the lift: no
          lift = { shaft: lr, doorOnV1, side: sd };
          break;
        }
      }
      let score = 0;
      if (ent) score -= Math.hypot(u0 + runL / 2 - ent.u, centreV - ent.v);
      if (needLift && !lift) score -= 1000;   // a walk-up tower is the last resort
      if (score > bestScore) {
        bestScore = score;
        best = { shaft: s, runSide, steps, runL, mid, lift };
      }
    }
  }
  return best;
}

// A rectangle counts as inside when nine probes — corners, edge midpoints and
// centre, all inset by `m` — are all within the footprint. Cheap, and it
// rejects exactly the cases that matter (a corner poking out of a wing).
function rectInside(r, inside, m) {
  const us = [r.u0 + m, (r.u0 + r.u1) / 2, r.u1 - m];
  const vs = [r.v0 + m, (r.v0 + r.v1) / 2, r.v1 - m];
  for (const u of us) for (const v of vs) if (!inside(u, v)) return false;
  return true;
}

// the two halves of a core shaft: the climbing run and the standing landing
function coreHalves(core) {
  const s = core.shaft, half = rd(s) / 2;
  const a = rect(s.u0, s.v0, s.u1, s.v0 + half);
  const b = rect(s.u0, s.v0 + half, s.u1, s.v1);
  return core.runSide ? { run: b, land: a } : { run: a, land: b };
}

// ---- per-use floor layouts ----------------------------------------------

// Double-loaded corridor: the workhorse of flats, schools, hotels, hospitals,
// offices and civic buildings. A 2.35 m corridor runs the length of the OBB;
// the bands either side are chopped into units of the use's own frontage; each
// unit gets a door onto the corridor and, for flats and houses, an internal
// subdivision into rooms.
function corridorLayout(f, plan, fi, use) {
  const fr = plan.fr, seed = f._id, sH = plan.sH;
  const wallH = sH - I.slabT;
  const walls = [], rooms = [];
  const cw = I.corridorW / 2;
  // The corridor has to run PAST the stairwell door or the upper floors are
  // sealed off from the flats they serve. The shaft's door is on the face its
  // landing touches (see the core block in buildingPlan), so the corridor is
  // laid immediately outside that face; only when there is no core, or no room
  // for one, does it fall back to a jittered centre line.
  const core = plan.core;
  let cv;
  if (core) {
    const { land } = coreHalves(core);
    const s = core.shaft;
    const doorOnV1 = land.v1 >= s.v1 - 1e-6;
    const want = doorOnV1 ? s.v1 + cw : s.v0 - cw;
    cv = Math.max(-fr.hv + cw, Math.min(fr.hv - cw, want));
  } else {
    const bias = (rnd(seed, 30 + fi) - 0.5) * Math.min(2.5, fr.hv * 0.4);
    cv = fr.hv * 2 > I.corridorW + 9 ? bias : 0;
  }
  const bands = [];
  if (cv - cw > -fr.hv + 2.4) bands.push(rect(-fr.hu, -fr.hv, fr.hu, cv - cw));
  if (cv + cw < fr.hv - 2.4) bands.push(rect(-fr.hu, cv + cw, fr.hu, fr.hv));
  if (!bands.length) bands.push(rect(-fr.hu, -fr.hv, fr.hu, fr.hv)); // too thin
                                                                     // for a corridor
  const unitW = UNIT_W[use] ?? 7;
  const kinds = UNIT_KINDS[use] ?? ['office'];

  for (const band of bands) {
    const side = rd(band) > 0 && band.v1 <= cv - cw + 1e-6 ? -1 : 1; // which side of the corridor
    const doorV = side < 0 ? band.v1 : band.v0;                      // the corridor face
    // the core — stair AND lift shaft, when there is one — eats its slice out
    // of whichever band it overlaps
    const carve = core ? coreSpanOf(plan) : null;
    const segs = [];
    if (carve && rectOverlaps(carve, band)) {
      if (carve.u0 - band.u0 > unitW * 0.6) segs.push(rect(band.u0, band.v0, carve.u0, band.v1));
      if (band.u1 - carve.u1 > unitW * 0.6) segs.push(rect(carve.u1, band.v0, band.u1, band.v1));
      if (!segs.length) continue;                        // core fills this band
    } else segs.push(band);

    for (const seg of segs) {
      const n = Math.max(1, Math.round(rw(seg) / unitW));
      const uw = rw(seg) / n;
      for (let k = 0; k < n; k++) {
        const u0 = seg.u0 + k * uw, u1 = u0 + uw;
        const unit = rect(u0, seg.v0, u1, seg.v1);
        // party wall between units (no door — flats don't connect)
        if (k > 0) walls.push(wall(u0, seg.v0, u0, seg.v1, wallH, []));
        // ...and the unit's own door onto the corridor, punched into the
        // corridor wall segment that this unit fronts
        const dc = 0.3 + rnd(seed, 400 + fi * 31 + k) * 0.4;
        walls.push(wall(u0, doorV, u1, doorV, wallH,
          [gapAt(uw, dc, use === 'mall' || use === 'shop' ? uw * 0.62 : I.doorW)],
          'wall'));
        // interior rooms
        if (use === 'flats' || use === 'house') {
          const sub = [], subWalls = [];
          subdivide(unit, seed, 700 + fi * 53 + k, 2.5, 9, 2, sub, subWalls, wallH);
          for (const w of subWalls) walls.push(w);
          sub.sort((a, b) => (rw(b) * rd(b)) - (rw(a) * rd(a)));
          sub.forEach((r, ri) => rooms.push({ ...r, kind: kinds[Math.min(ri, kinds.length - 1)] }));
        } else {
          rooms.push({ ...unit, kind: kinds[0] });
        }
      }
      // gable end walls where a unit run stops short of the shell
      if (seg.u0 > -fr.hu + 0.6) walls.push(wall(seg.u0, seg.v0, seg.u0, seg.v1, wallH, []));
      if (seg.u1 < fr.hu - 0.6) walls.push(wall(seg.u1, seg.v0, seg.u1, seg.v1, wallH, []));
    }
  }
  rooms.push({ ...rect(-fr.hu, cv - cw, fr.hu, cv + cw), kind: 'corridor' });
  return { walls, rooms, corridorV: cv };
}

function rectOverlaps(a, b) {
  return a.u0 < b.u1 - 1e-6 && a.u1 > b.u0 + 1e-6 && a.v0 < b.v1 - 1e-6 && a.v1 > b.v0 + 1e-6;
}

// the footprint the whole core occupies in plan space: the stair shaft plus,
// when the building has one, the lift shaft leaning against it
function coreSpanOf(plan) {
  const s = plan.core.shaft, l = plan.lift?.shaft;
  return l ? rect(Math.min(s.u0, l.u0), Math.min(s.v0, l.v0),
    Math.max(s.u1, l.u1), Math.max(s.v1, l.v1)) : s;
}

// ---- the panelák ground floor ---------------------------------------------
// Nobody in a Czech block of flats lives on the ground floor of the stair
// core's own building the way the corridor layout pretended: you come in
// through the zádveří (a ~2.6 m vestibule), past the bank of mailboxes, onto
// the landing where the stairs and the výtah wait — and the rest of the level
// is sklepy, the run of storage cells every resident owns one of, plus the
// kočárkárna for the prams and bikes. Flats start on floor 1. This layout
// draws exactly that, reusing the corridor line the upper floors already
// share so the staircase lands on a corridor on every level.
function flatsGroundLayout(f, plan) {
  const fr = plan.fr, wallH = plan.sH - I.slabT;
  const walls = [], rooms = [];
  const cw = I.corridorW / 2;
  const core = plan.core, s = core.shaft;
  const { land } = coreHalves(core);
  const doorOnV1 = land.v1 >= s.v1 - 1e-6;
  const cv = clamp(doorOnV1 ? s.v1 + cw : s.v0 - cw, -fr.hv + cw, fr.hv - cw);

  // the entrance, in plan space
  const e = plan.entrance;
  let eu = 0, ev = -fr.hv, nu = 0, nv = -1;
  if (e) {
    eu = (e.x - fr.cx) * fr.ux + (e.z - fr.cz) * fr.uz;
    ev = (e.x - fr.cx) * fr.vx + (e.z - fr.cz) * fr.vz;
    nu = e.nx * fr.ux + e.nz * fr.uz;
    nv = e.nx * fr.vx + e.nz * fr.vz;
  }
  const gable = Math.abs(nu) > Math.abs(nv);   // front door on a short end

  rooms.push({ ...rect(-fr.hu, cv - cw, fr.hu, cv + cw), kind: 'corridor' });

  // zádveří: front door to the landing corridor, walls either side. A door on
  // a gable, or one the corridor already runs along, skips the walls — the
  // lobby is then just the mouth of the corridor, widened.
  const vw = 1.3;
  let lobby;
  if (gable) {
    const u0 = nu > 0 ? fr.hu - 3.2 : -fr.hu;
    lobby = rect(u0, Math.max(-fr.hv, Math.min(ev, cv) - vw),
      u0 + 3.2, Math.min(fr.hv, Math.max(ev, cv) + vw));
  } else {
    const ue = clamp(eu, -fr.hu + vw + 0.1, fr.hu - vw - 0.1);
    lobby = ev <= cv ? rect(ue - vw, -fr.hv, ue + vw, cv - cw)
                     : rect(ue - vw, cv + cw, ue + vw, fr.hv);
    if (rd(lobby) > 0.6) {
      walls.push(wall(lobby.u0, lobby.v0, lobby.u0, lobby.v1, wallH, []));
      walls.push(wall(lobby.u1, lobby.v0, lobby.u1, lobby.v1, wallH, []));
    } else {
      // the corridor hugs the front wall: the door opens straight onto it
      lobby = rect(ue - 1.6, cv - vw, ue + 1.6, cv + vw);
    }
  }
  rooms.push({ ...lobby, kind: 'lobby' });

  // the rest of the level: sklepy off a back corridor, plus the kočárkárna
  const span = coreSpanOf(plan);
  const bands = [];
  if (cv - cw > -fr.hv + 1.9) bands.push(rect(-fr.hu, -fr.hv, fr.hu, cv - cw));
  if (cv + cw < fr.hv - 1.9) bands.push(rect(-fr.hu, cv + cw, fr.hu, fr.hv));
  let pramDone = false;
  for (const band of bands) {
    const low = band.v1 <= cv - cw + 1e-6;     // below the corridor?
    const doorV = low ? band.v1 : band.v0;     // its corridor face
    // carve the core span and the lobby out of the run of u
    const cuts = [];
    if (rectOverlaps(span, band)) cuts.push([span.u0, span.u1]);
    if (rectOverlaps(lobby, band)) cuts.push([lobby.u0, lobby.u1]);
    cuts.sort((a, b) => a[0] - b[0]);
    const segs = [];
    let u = band.u0;
    for (const [a, b] of cuts) { if (a - u > 2.3) segs.push([u, a]); u = Math.max(u, b); }
    if (band.u1 - u > 2.3) segs.push([u, band.u1]);

    // a run of cells: dividers + one door each onto their own back corridor,
    // which takes a single door off the landing corridor
    const cells = (u0, u1) => {
      const segL = u1 - u0, depth = rd(band);
      if (depth >= 3.4) {
        const cellFace = low ? band.v1 - 1.35 : band.v0 + 1.35;
        const c0 = low ? band.v0 : cellFace, c1 = low ? cellFace : band.v1;
        const n = Math.max(2, Math.round(segL / 2.3));
        const uw = segL / n;
        const gaps = [];
        for (let k = 0; k < n; k++) gaps.push(gapAt(segL, (k + 0.5) / n, 0.85));
        walls.push(wall(u0, doorV, u1, doorV, wallH,
          [gapAt(segL, clamp((eu - u0) / segL, 0.12, 0.88), I.doorW)]));
        walls.push(wall(u0, cellFace, u1, cellFace, wallH, gaps));
        for (let k = 1; k < n; k++)
          walls.push(wall(u0 + k * uw, c0, u0 + k * uw, c1, wallH, []));
        for (let k = 0; k < n; k++)
          rooms.push({ ...rect(u0 + k * uw, c0, u0 + (k + 1) * uw, c1), kind: 'cellar' });
        rooms.push({ ...rect(u0, low ? cellFace : band.v0, u1, low ? band.v1 : cellFace),
          kind: 'corridor' });
      } else {
        // too shallow for a cell run: one store room straight off the corridor
        walls.push(wall(u0, doorV, u1, doorV, wallH, [gapAt(segL, 0.5, I.doorW)]));
        rooms.push({ ...rect(u0, band.v0, u1, band.v1), kind: 'cellar' });
      }
    };

    for (let [u0, u1] of segs) {
      // end walls where the seg stops short of the shell
      if (u0 > -fr.hu + 0.6) walls.push(wall(u0, band.v0, u0, band.v1, wallH, []));
      if (u1 < fr.hu - 0.6) walls.push(wall(u1, band.v0, u1, band.v1, wallH, []));
      if (!pramDone) {
        // kočárkárna: carved off the end of the first seg, nearest the door
        const pl = Math.min(u1 - u0, 4.6);
        const atLo = Math.abs(u0 - eu) <= Math.abs(u1 - eu);
        const p0 = atLo ? u0 : u1 - pl, p1 = atLo ? u0 + pl : u1;
        walls.push(wall(p0, doorV, p1, doorV, wallH, [gapAt(pl, 0.5, I.doorW)]));
        if (u1 - u0 - pl > 0.4)
          walls.push(wall(atLo ? p1 : p0, band.v0, atLo ? p1 : p0, band.v1, wallH, []));
        rooms.push({ ...rect(p0, band.v0, p1, band.v1), kind: 'pram' });
        pramDone = true;
        if (atLo) u0 = p1; else u1 = p0;
        if (u1 - u0 < 2.3) continue;
      }
      cells(u0, u1);
    }
  }
  return { walls, rooms, corridorV: cv };
}

// Shopping centre. The plan is the one everybody has walked: a rectangular
// ATRIUM void through the upper slabs, a concourse ring around it, and a band
// of shop units against the shell whose fronts are 62 % glass. Escalators sit
// at the atrium's short ends and alternate direction per level, so you ride up
// one side and down the other. Ground level keeps its slab (that's the floor
// of the atrium) and grows a couple of free-standing kiosks in the middle.
function mallLayout(f, plan, fi) {
  const fr = plan.fr, seed = f._id, sH = plan.sH, wallH = sH - I.slabT;
  const brand = plan.brand;
  const walls = [], rooms = [], open = [], rails = [];
  const unitD = clamp(Math.min(fr.hu, fr.hv) * 0.42, 6, 15);   // shop depth
  const aK = brand?.atriumK ?? 0.42;
  const au = Math.max(6, fr.hu - unitD - 4.5), av = Math.max(5, fr.hv - unitD - 4.5);
  const atrium = rect(-Math.min(au, fr.hu * aK), -Math.min(av, fr.hv * aK),
    Math.min(au, fr.hu * aK), Math.min(av, fr.hv * aK));
  if (fi > 0) { open.push(atrium); rails.push(atrium); }
  rooms.push({ ...atrium, kind: fi > 0 ? 'void' : 'atrium' });
  // AFI Palác keeps its Cinema City under the roof: the top level is not a ring
  // of shops, it is a block of auditoria off a foyer. One flag, and the plan of
  // the real building appears.
  if (brand?.cinemaTop && fi === plan.storeys - 1 && plan.storeys > 1) {
    const halls = clamp(Math.round(fr.hu / 11), 2, 6);
    const hu = (fr.hu * 2 - 1.2) / halls;
    const hv0 = -fr.hv + 0.6, hv1 = atrium.v0 - 1.2;
    if (hv1 - hv0 > 8) {
      for (let k = 0; k < halls; k++) {
        const u0 = -fr.hu + 0.6 + k * hu;
        if (k > 0) walls.push(wall(u0, hv0, u0, hv1, wallH, []));
        walls.push(wall(u0, hv1, u0 + hu, hv1, wallH, [gapAt(hu, 0.5, 1.6)]));
        rooms.push({ ...rect(u0, hv0, u0 + hu, hv1), kind: 'cinema' });
      }
      rooms.push({ ...rect(-fr.hu, hv1, fr.hu, atrium.v0), kind: 'foyer' });
    }
  }

  // four bands of units against the shell; corners are given to the long sides
  const bandU = [rect(-fr.hu, -fr.hv, fr.hu, -fr.hv + unitD),
    rect(-fr.hu, fr.hv - unitD, fr.hu, fr.hv)];
  const bandV = [rect(-fr.hu, -fr.hv + unitD, -fr.hu + unitD, fr.hv - unitD),
    rect(fr.hu - unitD, -fr.hv + unitD, fr.hu, fr.hv - unitD)];
  let k = 0;
  for (const b of bandU) {
    if (rd(b) < 4) continue;
    const front = b.v0 < 0 ? b.v1 : b.v0;
    const n = Math.max(1, Math.round(rw(b) / UNIT_W.mall));
    const uw = rw(b) / n;
    for (let j = 0; j < n; j++, k++) {
      const u0 = b.u0 + j * uw;
      if (j > 0) walls.push(wall(u0, b.v0, u0, b.v1, wallH, []));
      walls.push(wall(u0, front, u0 + uw, front, wallH, [gapAt(uw, 0.5, uw * 0.62)], 'shopfront'));
      rooms.push({ ...rect(u0, b.v0, u0 + uw, b.v1), kind: 'unit' });
    }
  }
  for (const b of bandV) {
    if (rw(b) < 4 || rd(b) < 4) continue;
    const front = b.u0 < 0 ? b.u1 : b.u0;
    const n = Math.max(1, Math.round(rd(b) / UNIT_W.mall));
    const vw = rd(b) / n;
    for (let j = 0; j < n; j++, k++) {
      const v0 = b.v0 + j * vw;
      if (j > 0) walls.push(wall(b.u0, v0, b.u1, v0, wallH, []));
      walls.push(wall(front, v0, front, v0 + vw, wallH, [gapAt(vw, 0.5, vw * 0.62)], 'shopfront'));
      rooms.push({ ...rect(b.u0, v0, b.u1, v0 + vw), kind: 'unit' });
    }
  }
  rooms.push({ ...rect(atrium.u1, -fr.hv + unitD, fr.hu - unitD, fr.hv - unitD), kind: 'concourse' });
  rooms.push({ ...rect(-fr.hu + unitD, -fr.hv + unitD, atrium.u0, fr.hv - unitD), kind: 'concourse' });
  return { walls, rooms, open, rails };
}

// A single open volume with things standing in it: warehouse racking, parking
// decks, supermarket aisles, a church nave, a garage. `props` does the talking;
// the only walls are the back-of-house strip a supermarket hides its pallets in.
function openLayout(f, plan, fi, use) {
  const fr = plan.fr, seed = f._id, wallH = plan.sH - I.slabT;
  const brand = plan.brand;
  const walls = [], rooms = [];
  if (use === 'supermarket' && fr.hu * 2 > 22) {
    // Back-of-house against the far gable with one set of swing doors, and — for
    // a known chain — an ENTRANCE VESTIBULE at the door end holding the trolley
    // bay and (Lidl, Kaufland, Albert, Globus) the in-store bakery, which is
    // where every Czech shopper's route actually starts.
    const bk = brand?.backHouse ?? 0.22;
    const bu = fr.hu - clamp(fr.hu * bk * 2, 4, 12);
    walls.push(wall(bu, -fr.hv, bu, fr.hv, wallH, [gapAt(fr.hv * 2, 0.5, 2.6)]));
    rooms.push({ ...rect(bu, -fr.hv, fr.hu, fr.hv), kind: 'storage' });
    let salesU0 = -fr.hu;
    if (brand?.trolleys && fr.hu * 2 > 34) {
      const vu = -fr.hu + clamp(fr.hu * 0.18, 4, 9);
      // a low screen, not a wall: you can see the tills over it
      walls.push(wall(vu, -fr.hv, vu, fr.hv, Math.min(1.4, wallH), []));
      rooms.push({ ...rect(-fr.hu, -fr.hv, vu, fr.hv), kind: 'vestibule' });
      salesU0 = vu;
    }
    rooms.push({ ...rect(salesU0, -fr.hv, bu, fr.hv), kind: 'sales' });
  } else if (use === 'industrial' && fr.hu * 2 > 26 && rnd(seed, 61) < 0.8) {
    // a mezzanine-less site office boxed into a corner, 3 m tall inside the hall
    const ow = clamp(fr.hu * 0.3, 5, 11), od = clamp(fr.hv * 0.5, 4, 8);
    const u0 = -fr.hu + 0.6, v0 = -fr.hv + 0.6;
    const oh = Math.min(3.1, wallH);
    walls.push(wall(u0 + ow, v0, u0 + ow, v0 + od, oh, [gapAt(od, 0.6, 1.1)]));
    walls.push(wall(u0, v0 + od, u0 + ow, v0 + od, oh, []));
    rooms.push({ ...rect(u0, v0, u0 + ow, v0 + od), kind: 'office' });
    rooms.push({ ...rect(-fr.hu, -fr.hv, fr.hu, fr.hv), kind: 'hall' });
  } else {
    rooms.push({
      ...rect(-fr.hu, -fr.hv, fr.hu, fr.hv),
      kind: use === 'church' ? 'nave' : use === 'parking' ? 'deck'
        : use === 'garage' ? 'garage' : use === 'restaurant' ? 'diner'
        : use === 'shop' ? 'sales' : 'hall',
    });
  }
  return { walls, rooms };
}

// A detached house has no corridor to speak of — the stair lands in the living
// room and everything opens off it, so straight subdivision is the honest plan.
function houseLayout(f, plan, fi) {
  const fr = plan.fr, wallH = plan.sH - I.slabT;
  const walls = [], rooms = [];
  const sub = [];
  subdivide(rect(-fr.hu, -fr.hv, fr.hu, fr.hv), f._id, 200 + fi * 37,
    2.6, 10, fr.hu * fr.hv > 60 ? 3 : 2, sub, walls, wallH);
  sub.sort((a, b) => (rw(b) * rd(b)) - (rw(a) * rd(a)));
  const kinds = fi === 0 ? ['living', 'kitchen', 'hall', 'bath', 'bedroom']
    : ['bedroom', 'bedroom', 'bath', 'hall', 'bedroom'];
  sub.forEach((r, ri) => rooms.push({ ...r, kind: kinds[Math.min(ri, kinds.length - 1)] }));
  return { walls, rooms };
}

// ---- the plan ------------------------------------------------------------

/**
 * buildingPlan(f, roads?) → plan, cached on the feature as `_plan`.
 * Pure data. See the top-of-file contract for the shape; the fields geometry
 * and gameplay actually read are: use, label, y0, sH, storeys, fr, pal,
 * floors[{y, walls, rooms, open, rails}], core, entrance, occupants, tile.
 */
export function buildingPlan(f, roads, neighbours, ground = 0) {
  // The plan is cached, but the ground under it is discovered ASYNCHRONOUSLY —
  // a height map can land after the first plan was drawn. A plan founded on a
  // different ground than the one we now know is a plan for a different
  // building, so it is thrown away rather than reused.
  if (f._plan && f._plan.ground === ground) return f._plan;
  if (f._plan) f._plan = null;
  const use = classify(f);
  const brand = brandOf(f);
  const ring = f.o;
  const fr = frameOf(ring);
  const area = Math.abs(f._area ??= polygonArea(ring));
  // `f.y` is a skyway's underside ABOVE ITS OWN GROUND, and `f.h` its total
  // height above the same — so the ground is added once, here, and everything
  // downstream keeps working in absolute metres.
  const y0 = ground + (f.y ?? 0);
  const total = Math.max(2.4, (f.h ?? 6) - (f.y ?? 0));
  // the roof eats the top of the extrusion; what's left is habitable
  const usable = Math.max(2.4, total - 0.5);
  let levels = f.lv ?? Math.max(1, Math.round(usable / 3.1));

  // Uses that are one tall volume regardless of what the level tag claims. A
  // named supermarket ALWAYS is: a Kaufland or a Lidl is a single hall under a
  // flat roof, whatever RÚIAN's 10.5 m height tag divides into.
  const singleVolume = use === 'industrial' || use === 'church' || use === 'garage'
    || use === 'restaurant'
    || (use === 'supermarket' && (brand ? !brand.storeys : usable < 12))
    || (use === 'shop' && usable < 7.5);
  if (singleVolume) levels = 1;
  else if (brand?.storeys) levels = brand.storeys;
  levels = clamp(Math.round(levels), 1, Math.max(1, Math.floor(usable / I.minStorey)));
  let sH = clamp(usable / levels, I.minStorey, I.maxStorey);
  let storeys = Math.max(1, Math.min(levels, Math.floor(usable / sH + 0.01)));
  if (storeys === 1) sH = Math.min(usable, singleVolume ? usable : I.maxStorey);

  const plan = {
    // `brand` drives the LOOK (wall colour, cladding, storey rules) and must
    // stay a real chain; `sign` is only what goes over the door, so retail
    // that no chain claims still gets lettering.
    use, label: brand?.label ?? USE_LABEL[use] ?? 'Budova', brand,
    sign: signBrandOf(f, use),
    id: f._id, name: f.n ?? null,
    fr, ring, holes: f.i ?? null, area,
    y0, sH, storeys, top: y0 + total, usable, ground,
    pal: INTERIOR_PALETTES[use] ?? INTERIOR_PALETTES.civic,
    entrance: entranceOf(f, roads, neighbours),
    core: null, lift: null, floors: [], occupants: 0,
    // Huge footprints coarsen their slab tiles instead of blowing the budget:
    // a 13 000 m² mall on 1.9 m tiles would be 3600 pieces of FLOOR alone.
    tile: I.tile * clamp(Math.sqrt(area / 420), 1, 2.9),
    panel: I.panel * clamp(Math.sqrt(area / 900), 1, 2.2),
    // v7 architectural identity — pieces.js keys its facade grammar off these:
    // the OSM type (panelák balconies), the novostavba stamp (tall windows,
    // French balconies, no atlas), and a hash-picked curtain-wall variant for
    // offices (continuous glass bands vs a grid of dark-framed windows).
    osmT: f.t ?? null,
    nova: !!f._nova,
    officeVar: use === 'office' ? (rnd(f._id, 80) < 0.5 ? 'bands' : 'grid') : null,
  };

  // Multi-storey buildings need a way up or their upper floors are a lie.
  // If the core does not fit anywhere inside the real outline, the building
  // becomes one storey — which for the 55 m² garden sheds and awkward slivers
  // that hit this path is the right answer.
  if (storeys > 1) {
    const probe = { x: 0, z: 0 };
    const inside = (u, v) => {
      planToWorld(fr, u, v, probe);
      if (!pointInPolygon(probe.x, probe.z, ring)) return false;
      for (const h of f.i ?? []) if (h.length >= 3 && pointInPolygon(probe.x, probe.z, h)) return false;
      return true;
    };
    // the entrance in plan space, so the core can court it — and dodge it
    const e = plan.entrance;
    const entUV = e ? {
      u: (e.x - fr.cx) * fr.ux + (e.z - fr.cz) * fr.uz,
      v: (e.x - fr.cx) * fr.vx + (e.z - fr.cz) * fr.vz,
    } : null;
    plan.core = placeCore(fr, f._id, sH, inside, entUV,
      use === 'flats' && storeys >= 4);       // ≥4 storeys of flats want a výtah
    if (plan.core) plan.lift = plan.core.lift ?? null;
    else { plan.storeys = storeys = 1; plan.sH = sH = Math.min(usable, I.maxStorey); }
  }

  const openUse = OPEN_USES.has(use) && use !== 'mall';
  for (let fi = 0; fi < storeys; fi++) {
    // The ground floor stands one threshold above the terrain — see
    // INTERIOR.groundLift; putting it in the PLAN rather than only in the slab
    // keeps walls, stairs, furniture and the people all on the same surface.
    const floor = { y: y0 + fi * sH + (fi === 0 ? I.groundLift : 0),
      walls: [], rooms: [], open: [], rails: [], props: [] };
    let L;
    if (use === 'mall') L = mallLayout(f, plan, fi);
    else if (openUse || (use === 'shop' && fi === 0 && storeys === 1)) L = openLayout(f, plan, fi, use);
    else if (use === 'house') L = houseLayout(f, plan, fi);
    else if (use === 'hotel' && fi === 0) L = openLayout(f, plan, fi, 'shop');   // lobby
    else if (use === 'flats' && fi === 0 && storeys >= 3 && plan.core)
      L = flatsGroundLayout(f, plan);        // zádveří + sklepy, flats from floor 1
    else L = corridorLayout(f, plan, fi, use);
    floor.walls = L.walls; floor.rooms = L.rooms;
    floor.open = L.open ?? []; floor.rails = L.rails ?? [];
    floor.corridorV = L.corridorV;
    plan.floors.push(floor);
  }

  // the core: shaft walls on every level, a slab hole over the run, a stair
  // run per level below the top, and a landing door onto the corridor
  if (plan.core) {
    const { run, land } = coreHalves(plan.core);
    plan.core.run = run; plan.core.land = land;
    for (let fi = 0; fi < storeys; fi++) {
      const floor = plan.floors[fi];
      if (fi > 0) floor.open.push(run);       // you emerge THROUGH this hole
      const s = plan.core.shaft, wallH = sH - I.slabT;
      // shaft enclosure — the door goes in whichever face the landing touches
      const doorOnV1 = land.v1 >= s.v1 - 1e-6;
      floor.walls.push(wall(s.u0, s.v0, s.u1, s.v0, wallH,
        doorOnV1 ? [] : [gapAt(rw(s), 0.5, 1.2)], 'core'));
      floor.walls.push(wall(s.u0, s.v1, s.u1, s.v1, wallH,
        doorOnV1 ? [gapAt(rw(s), 0.5, 1.2)] : [], 'core'));
      floor.walls.push(wall(s.u0, s.v0, s.u0, s.v1, wallH, [], 'core'));
      floor.walls.push(wall(s.u1, s.v0, s.u1, s.v1, wallH, [], 'core'));
      floor.rails.push(run);                  // guard the stair well
      if (fi < storeys - 1) {
        // alternate the climb direction per level: the top of one flight is
        // the bottom of the next, so the shaft reads as one continuous
        // switchback instead of a stack of unrelated ramps
        floor.stair = { rect: run, steps: plan.core.steps, dir: fi % 2 === 0 ? 1 : -1,
          axis: 'u', y0: floor.y, y1: floor.y + sH };
      }
    }
  }

  // the výtah: shaft walls on every level (structural — the shaft is what a
  // panelák's slabs actually hang off), a slab hole through every floor above
  // ground so the shaft is one continuous void, and a door face toward the
  // landing. pieces.js adds the metal door panel per floor and parks the cab
  // at ground level.
  if (plan.lift) {
    const ls = plan.lift.shaft, dOnV1 = plan.lift.doorOnV1, wallH = sH - I.slabT;
    for (let fi = 0; fi < storeys; fi++) {
      const floor = plan.floors[fi];
      if (fi > 0) floor.open.push(ls);
      floor.walls.push(wall(ls.u0, ls.v0, ls.u1, ls.v0, wallH,
        dOnV1 ? [] : [gapAt(rw(ls), 0.5, 1.1)], 'core'));
      floor.walls.push(wall(ls.u0, ls.v1, ls.u1, ls.v1, wallH,
        dOnV1 ? [gapAt(rw(ls), 0.5, 1.1)] : [], 'core'));
      // the face shared with the stair shaft is already the stair's own wall
      if (plan.lift.side < 0) floor.walls.push(wall(ls.u0, ls.v0, ls.u0, ls.v1, wallH, [], 'core'));
      else floor.walls.push(wall(ls.u1, ls.v0, ls.u1, ls.v1, wallH, [], 'core'));
    }
  }

  // how many people live/work here — pieces.js ignores this, interiorsim.js
  // spawns from it. Density per use class, capped so one panelák doesn't eat
  // the whole citizen budget.
  // m² of floor per person, per use — a school corridor at break time is not a
  // warehouse night shift. Deliberately generous: a demolition sandbox in which
  // the building you just opened up turns out to be empty is a much duller
  // sandbox, and the panic is most of the point.
  const DENS = { flats: 26, house: 45, hotel: 30, office: 14, school: 9,
    hospital: 18, mall: 22, supermarket: 30, shop: 28, civic: 24, restaurant: 12,
    industrial: 120, parking: 260, church: 45, garage: 1e9 };
  plan.occupants = Math.min(26, Math.floor(area * storeys / (DENS[use] ?? 30)));
  return (f._plan = plan);
}

// A cheap "is there anything worth walking into" test, used by the activation
// scan before it commits to a full plan: sheds and 2 m² transformer huts have
// no inside worth building.
export function hasInterior(f) {
  if (!f.o || f.o.length < 3) return false;
  if ((f.y ?? 0) > 0.5) return false;                 // skyways/arches
  const area = Math.abs(f._area ??= polygonArea(f.o));
  return area >= 14 && (f.h ?? 0) >= 2.3;
}
