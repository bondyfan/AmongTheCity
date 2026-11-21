// ---- What Mahé needs beyond the tiles ----
// Run after build-region and ground.mjs. From the Seychelles extract, the coast
// and the land cover it writes the small files the island's own modules read:
//
//   places.json     the gazetteer (Victoria, Beau Vallon, Anse Royale …) in the
//                   format js/place.js and the world map read
//   landmarks.json  where Victoria's landmarks stand, from their OSM features:
//                   the Clock Tower, the Sir Selwyn Selwyn-Clarke Market, the
//                   Cathedral of the Immaculate Conception, the Hindu temple,
//                   the harbour; js/mahe/landmarks.js builds them there
//   airport.json    Seychelles International as OSM surveyed it: the runway's
//                   two thresholds, its width, the terminal and the apron
//   boulders.json   the granite: boulders where WorldCover sees bare rock by the
//                   sea and on the glacis slopes, and every mapped natural=rock
//
//   node scripts/mahe/extras.mjs   → public/data/regions/mahe/{places,landmarks,airport,boulders}.json

process.env.ATC_REGION = 'mahe';
const { readPbf } = await import('../lib/osmpbf.mjs');
const W = await import('../lib/world-area.mjs');
const { openTiff, readWindow } = await import('../lib/geotiff.mjs');
const { readFileSync, writeFileSync, existsSync } = await import('node:fs');

const PBF = 'data/regions/mahe/raw/seychelles.osm.pbf';
const COVER = 'data/regions/mahe/raw/ESA_WorldCover_10m_2021_v200_S06E054_Map.tif';
const OUT = 'public/data/regions/mahe';
const E = W.ENVELOPE;
const inside = (lat, lon) => lat >= E.latS && lat <= E.latN && lon >= E.lonW && lon <= E.lonE;
const P = (lat, lon) => [+W.xOf(lon).toFixed(1), +W.zOf(lat).toFixed(1)];

const nodes = new Map();
const places = [], rocks = [], named = [];
const ways = [];   // { id, refs, t } for the few kinds asked about below
const RANK = { city: 0, town: 1, village: 2, suburb: 3, quarter: 4, neighbourhood: 4, hamlet: 4, locality: 5, isolated_dwelling: 5 };
// what to look for, by name (any language tag) or by tags
const LANDMARKS = [
  { id: 'clocktower', re: /clock\s*tower|lorloz|little ben/i, tag: (t) => t.man_made === 'clock' || t.amenity === 'clock' || t.historic === 'monument' },
  { id: 'market', re: /selwyn|market/i, tag: (t) => t.amenity === 'marketplace' || !!t.building },
  { id: 'cathedral', re: /immaculate|cathedral/i, tag: (t) => t.amenity === 'place_of_worship' || t.building === 'cathedral' || t.building === 'church' },
  { id: 'temple', re: /vinayagar|navasakthi|hindu|temple/i, tag: (t) => t.amenity === 'place_of_worship' || !!t.building },
  { id: 'anglican', re: /st\.?\s*paul|saint paul/i, tag: (t) => t.amenity === 'place_of_worship' || !!t.building },
  { id: 'statehouse', re: /state house/i, tag: () => true },
  { id: 'bicentennial', re: /bicentennial|trwa zwazo|zwazo/i, tag: () => true },
];
const nameOf = (t) => t.name ?? t['name:en'] ?? t['name:fr'] ?? '';

readPbf(PBF, {
  onNode(id, lat, lon, t) {
    if (!inside(lat, lon)) return;
    nodes.set(id, [lat, lon]);
    if (!t) return;
    if (t.place && RANK[t.place] !== undefined && t.name) places.push({ n: t.name, t: t.place, r: RANK[t.place], p: P(lat, lon) });
    if (t.natural === 'rock' || t.natural === 'stone') rocks.push({ p: P(lat, lon), big: t.natural === 'rock' ? 1 : 0 });
    const n = nameOf(t);
    if (n) named.push({ kind: 'node', n, t, p: P(lat, lon) });
  },
  onWay(id, refs, t) {
    if (!t) return;
    if (t.aeroway === 'runway' || t.aeroway === 'terminal' || t.aeroway === 'apron' || t.aeroway === 'parking_position'
      || t.natural === 'bare_rock' || (nameOf(t) && (t.building || t.amenity || t.historic || t.tourism)))
      ways.push({ id, refs, t });
  },
});
const geom = (refs) => refs.map((r) => nodes.get(r)).filter(Boolean).map(([la, lo]) => P(la, lo));
const centroid = (pts) => { let x = 0, z = 0; for (const p of pts) { x += p[0]; z += p[1]; } return [+(x / pts.length).toFixed(1), +(z / pts.length).toFixed(1)]; };
// the long axis of a footprint, for a heading (0 faces north, dirX = -sin h, dirZ = -cos h)
function axis(pts) {
  let best = 0, h = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const dx = pts[i + 1][0] - pts[i][0], dz = pts[i + 1][1] - pts[i][1], l = Math.hypot(dx, dz);
    if (l > best) { best = l; h = Math.atan2(-dx, -dz); }
  }
  return +h.toFixed(3);
}

// ---- places ----------------------------------------------------------------
places.sort((a, b) => a.r - b.r);
writeFileSync(`${OUT}/places.json`, JSON.stringify({ origin: W.ORIGIN, offset: W.OFFSET, mPerLat: W.M_PER_LAT, mPerLon: W.M_PER_LON, places }));

// ---- landmarks -----------------------------------------------------------------
const marks = {};
for (const L of LANDMARKS) {
  const w = ways.find((x) => L.re.test(nameOf(x.t)) && L.tag(x.t));
  if (w) {
    const g = geom(w.refs);
    if (g.length > 2) { marks[L.id] = { name: nameOf(w.t), p: centroid(g.slice(0, -1)), h: axis(g), o: g.slice(0, -1), osm: 'way/' + w.id }; continue; }
  }
  const n = named.find((x) => L.re.test(x.n) && L.tag(x.t));
  if (n) marks[L.id] = { name: n.n, p: n.p, osm: 'node' };
}
writeFileSync(`${OUT}/landmarks.json`, JSON.stringify(marks));

// ---- the airport -----------------------------------------------------------------
const air = { runways: [], terminal: null, aprons: [], stands: [] };
for (const w of ways) {
  const g = geom(w.refs);
  if (g.length < 2) continue;
  if (w.t.aeroway === 'runway') air.runways.push({ ref: w.t.ref ?? '', width: parseFloat(w.t.width) || 45, a: g[0], b: g[g.length - 1], len: Math.hypot(g[g.length - 1][0] - g[0][0], g[g.length - 1][1] - g[0][1]) });
  else if (w.t.aeroway === 'terminal') { const c = centroid(g); if (!air.terminal || /international/i.test(nameOf(w.t))) air.terminal = { name: nameOf(w.t), p: c, o: g.slice(0, -1) }; }
  else if (w.t.aeroway === 'apron') air.aprons.push({ p: centroid(g), o: g.slice(0, -1) });
  else if (w.t.aeroway === 'parking_position') air.stands.push({ ref: w.t.ref ?? '', a: g[0], b: g[g.length - 1] });
}
air.runways.sort((p, q) => q.len - p.len);
writeFileSync(`${OUT}/airport.json`, JSON.stringify(air));

// ---- the granite -------------------------------------------------------------------
// Bare-rock cells of WorldCover (class 60) on land: a boulder group per 40 m
// cell, hashed so it is the same rock on every machine and every rebuild.
const boulders = rocks.map((r) => [r.p[0], r.p[1], r.big ? 4 + (r.p[0] * 7 % 3) : 1.4]);
if (existsSync(COVER)) {
  const t = openTiff(COVER);
  const c0 = Math.floor((E.lonW - t.geo.x0) / t.geo.dx), c1 = Math.ceil((E.lonE - t.geo.x0) / t.geo.dx);
  const r0 = Math.floor((E.latN - t.geo.y0) / t.geo.dy), r1 = Math.ceil((E.latS - t.geo.y0) / t.geo.dy);
  const w = c1 - c0, h = r1 - r0, data = readWindow(t, c0, r0, w, h);
  t.close();
  const hash = (i, j) => { let v = Math.imul(i ^ 0x9e3779b1, 2654435761) ^ Math.imul(j, 0x27d4eb2d); v ^= v >>> 15; v = Math.imul(v, 2246822519); return ((v ^ (v >>> 13)) >>> 0) / 4294967296; };
  for (let j = 0; j < h; j += 4) for (let i = 0; i < w; i += 4) {
    let bare = 0;
    for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) if (data[(j + b) * w + i + a] === 60) bare++;
    if (bare < 3) continue;
    const lon = t.geo.x0 + (c0 + i + 2) * t.geo.dx, lat = t.geo.y0 + (r0 + j + 2) * t.geo.dy, u = hash(c0 + i, r0 + j);
    const p = P(lat, lon);
    const k = 1 + Math.floor(u * 3);
    for (let n = 0; n < k; n++) {
      const v = hash(c0 + i + n * 17, r0 + j + n * 31);
      boulders.push([+(p[0] + (v - 0.5) * 30).toFixed(1), +(p[1] + (hash(n, c0 + i) - 0.5) * 30).toFixed(1), +(1.2 + v * v * 6).toFixed(1)]);
    }
  }
}
writeFileSync(`${OUT}/boulders.json`, JSON.stringify({ b: boulders }));

console.log(`places ${places.length}: ${places.slice(0, 8).map((p) => p.n).join(', ')}`);
console.log('landmarks:', Object.entries(marks).map(([k, v]) => `${k}=${v.name} @${v.p}`).join(' | ') || 'none found');
console.log(`airport: ${air.runways.map((r) => `${r.ref} ${r.len.toFixed(0)} m × ${r.width} m`).join(', ') || 'no runway'}`
  + `, terminal ${air.terminal?.name ?? 'none'}, ${air.aprons.length} aprons, ${air.stands.length} stands`);
console.log(`granite: ${rocks.length} mapped rocks, ${boulders.length} boulders in all`);
