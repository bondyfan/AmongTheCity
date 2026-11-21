// ---- Mahé's ground: the height maps and the canopy raster ----
// The Czech world reads ČÚZK's LiDAR (bare earth, js/terrain.js) and the
// difference of its surface and terrain models (js/canopy.js). Neither exists
// for the Seychelles, so this makes the same two files from what does:
//
//   relief   Copernicus DEM GLO-30, 1 arc-second. A SURFACE model: on the
//            forested slopes it stands on the canopy, which C-band radar only
//            half sees into, so a tree-cover pixel is lowered by FOREST_BIAS.
//   coast    the OSM coastline (scripts/mahe/coast.mjs). The DEM says 0 over
//            the sea, which is not a depth; the sea floor is made here from the
//            distance to the shore and the reef, so the lagoon is shallow
//            turquoise and the water past the reef falls away to deep blue.
//   cover    ESA WorldCover 2021, 10 m: tree cover, shrubs, grass, built-up,
//            bare granite, mangroves. It decides where trees stand and, in the
//            two low bits of the stored height, which ZONE they belong to
//            (coastal palms, lowland mix, upland forest, mangrove), which is
//            all js/treeshapes.js needs to grow the right species in the
//            worker without another file.
//
//   node scripts/mahe/ground.mjs
//     → public/data/regions/mahe/terrain/<tx>_<tz>.bin  (int16 dm, 241², js/terrain.js)
//     → public/data/regions/mahe/canopy/<tx>_<tz>.bin   (uint8 ¼ m + zone, 481², js/canopy.js)
//     → public/data/regions/mahe/sea.bin + sea.json     (the lagoon map js/mahe/sea.js reads)

process.env.ATC_REGION = 'mahe';
const W = await import('../lib/world-area.mjs');
const { openTiff, readWindow } = await import('../lib/geotiff.mjs');
const { readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs');

const RAW = 'data/regions/mahe/raw';
const OUT = 'public/data/regions/mahe';
const DEM = `${RAW}/Copernicus_DSM_COG_10_S05_00_E055_00_DEM.tif`;
const COVER = `${RAW}/ESA_WorldCover_10m_2021_v200_S06E054_Map.tif`;
const COAST = 'data/regions/mahe/coast.json';
for (const f of [DEM, COVER, COAST]) if (!existsSync(f)) { console.error('missing ' + f); process.exit(1); }

const T = W.TILE, TR = 20, TN = T / TR + 1;   // terrain: 20 m, 241 a side
const CR = 10, CN = T / CR + 1;               // canopy: 10 m, 481 a side
const FOREST_BIAS = 6;                        // m the radar surface stands above the ground in forest

// ---- the frame of everything below: a 10 m raster over the tiles ------------
const tiles = W.wantedTiles();
let tx0 = Infinity, tx1 = -Infinity, tz0 = Infinity, tz1 = -Infinity;
for (const [tx, tz] of tiles) { tx0 = Math.min(tx0, tx); tx1 = Math.max(tx1, tx); tz0 = Math.min(tz0, tz); tz1 = Math.max(tz1, tz); }
const GX0 = tx0 * T, GZ0 = tz0 * T;
const GW = ((tx1 - tx0 + 1) * T) / CR + 1, GH = ((tz1 - tz0 + 1) * T) / CR + 1;
console.log(`grid ${GW} × ${GH} at ${CR} m over ${tiles.length} tiles`);

// ---- land mask: scanline fill of the coastline rings (even-odd) -------------
const coast = JSON.parse(readFileSync(COAST, 'utf8'));
function fill(rings, grid, value) {
  const xs = [];
  for (let j = 0; j < GH; j++) {
    const z = GZ0 + j * CR;
    xs.length = 0;
    for (const r of rings) {
      for (let i = 0, k = r.length - 1; i < r.length; k = i++) {
        const a = r[k], b = r[i];
        if ((a[1] > z) !== (b[1] > z)) xs.push(a[0] + (z - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
      }
    }
    xs.sort((p, q) => p - q);
    for (let n = 0; n + 1 < xs.length; n += 2) {
      const i0 = Math.max(0, Math.ceil((xs[n] - GX0) / CR)), i1 = Math.min(GW - 1, Math.floor((xs[n + 1] - GX0) / CR));
      for (let i = i0; i <= i1; i++) grid[j * GW + i] = value;
    }
  }
}
const land = new Uint8Array(GW * GH);
fill(coast.land, land, 1);
const reef = new Uint8Array(GW * GH);
fill(coast.reef, reef, 1);
let nLand = 0;
for (const v of land) nLand += v;
console.log(`land ${(nLand * CR * CR / 1e6).toFixed(1)} km² in ${coast.land.length} rings, reef cells ${reef.reduce((s, v) => s + v, 0)}`);

// ---- distance to the shore, both ways (chamfer 3-4, metres) -----------------
function distance(mask, want) {
  const d = new Float32Array(GW * GH);
  const BIG = 1e9;
  for (let k = 0; k < d.length; k++) d[k] = mask[k] === want ? 0 : BIG;
  const a = CR, b = CR * Math.SQRT2;
  for (let j = 0; j < GH; j++) for (let i = 0; i < GW; i++) {
    const k = j * GW + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + a);
    if (j > 0) { v = Math.min(v, d[k - GW] + a); if (i > 0) v = Math.min(v, d[k - GW - 1] + b); if (i < GW - 1) v = Math.min(v, d[k - GW + 1] + b); }
    d[k] = v;
  }
  for (let j = GH - 1; j >= 0; j--) for (let i = GW - 1; i >= 0; i--) {
    const k = j * GW + i; let v = d[k];
    if (i < GW - 1) v = Math.min(v, d[k + 1] + a);
    if (j < GH - 1) { v = Math.min(v, d[k + GW] + a); if (i < GW - 1) v = Math.min(v, d[k + GW + 1] + b); if (i > 0) v = Math.min(v, d[k + GW - 1] + b); }
    d[k] = v;
  }
  return d;
}
const toLand = distance(land, 1);     // in the sea: how far to the beach
const toSea = distance(land, 0);      // on land: how far to the water
const toReef = distance(reef, 1);

// ---- the rasters, read as windows over the island --------------------------
function window(path) {
  const t = openTiff(path);
  if (!t.geo) throw new Error(path + ': no georeference');
  const c0 = Math.floor((W.ENVELOPE.lonW - 0.02 - t.geo.x0) / t.geo.dx);
  const c1 = Math.ceil((W.ENVELOPE.lonE + 0.02 - t.geo.x0) / t.geo.dx);
  const r0 = Math.floor((W.ENVELOPE.latN + 0.02 - t.geo.y0) / t.geo.dy);
  const r1 = Math.ceil((W.ENVELOPE.latS - 0.02 - t.geo.y0) / t.geo.dy);
  const data = readWindow(t, c0, r0, c1 - c0, r1 - r0);
  const out = { data, c0, r0, w: c1 - c0, h: r1 - r0, geo: t.geo, nodata: t.nodata, comp: t.compression, pred: t.predictor };
  t.close();
  return out;
}
const dem = window(DEM), cov = window(COVER);
console.log(`DEM window ${dem.w}×${dem.h} (compression ${dem.comp}, predictor ${dem.pred}), `
  + `cover ${cov.w}×${cov.h} (compression ${cov.comp}, predictor ${cov.pred})`);
const demAt = (lat, lon) => {   // bilinear, pixel centres
  const u = (lon - dem.geo.x0) / dem.geo.dx - 0.5 - dem.c0, v = (lat - dem.geo.y0) / dem.geo.dy - 0.5 - dem.r0;
  const i = Math.max(0, Math.min(dem.w - 2, Math.floor(u))), j = Math.max(0, Math.min(dem.h - 2, Math.floor(v)));
  const fx = Math.min(1, Math.max(0, u - i)), fz = Math.min(1, Math.max(0, v - j));
  const g = (a, b) => { const h = dem.data[b * dem.w + a]; return h === dem.nodata || !(h > -100) ? 0 : h; };
  return g(i, j) * (1 - fx) * (1 - fz) + g(i + 1, j) * fx * (1 - fz) + g(i, j + 1) * (1 - fx) * fz + g(i + 1, j + 1) * fx * fz;
};
const coverAt = (lat, lon) => {   // nearest
  const i = Math.floor((lon - cov.geo.x0) / cov.geo.dx) - cov.c0, j = Math.floor((lat - cov.geo.y0) / cov.geo.dy) - cov.r0;
  return i < 0 || j < 0 || i >= cov.w || j >= cov.h ? 0 : cov.data[j * cov.w + i];
};
// WorldCover classes
const TREE = 10, SHRUB = 20, GRASS = 30, CROP = 40, BUILT = 50, BARE = 60, WATER = 80, WETLAND = 90, MANGROVE = 95;

// ---- the sea floor ------------------------------------------------------------
// Depth from the distance to the shore, along the profile of a fringing-reef
// island: a beach shelf, the lagoon at one to three metres, the reef crest
// awash, then the drop to the open sea. Where OSM maps no reef the lagoon
// simply shelves out (most of the west coast is like that).
function seabed(dl, dr) {
  if (dr === 0) return -0.4;                                      // the reef crest
  const beyond = dr < dl && dr < 400;                             // past the reef, on the ocean side
  if (!beyond && dl < 60) return -0.3 - dl * 0.012;              // beach shelf
  if (!beyond && dl < 500) return -1.0 - (dl - 60) * 0.004;      // lagoon, ~1-3 m
  const from = beyond ? dr : dl - 500;
  return Math.max(-45, (beyond ? -1.2 : -2.8) - from * 0.035);    // the drop-off
}

// ---- the shore, exactly ---------------------------------------------------------
// The land mask is a 10 m raster and the terrain a 20 m grid, so a coast made
// from them is a staircase, and where the sea plane cuts the triangulated
// ground it drew teeth fifty metres long along every beach. Within NEAR of the
// water the height is instead a plane in the TRUE signed distance to the OSM
// coastline (land positive): a triangle mesh represents a plane exactly, so
// the waterline the sea draws is the surveyed one, and a beach shelves into
// the lagoon at the slope of a beach (RAMP, 3 %). Past NEAR it blends back
// into the relief inland and the lagoon floor offshore.
const NEAR = 40, RAMP = 0.03, SB = 50;
const segs = [], sgrid = new Map();
for (const r of coast.land) for (let i = 0; i < r.length; i++) {
  const a = r[i], b = r[(i + 1) % r.length], n = segs.length;
  segs.push(a[0], a[1], b[0], b[1]);
  const i0 = Math.floor((Math.min(a[0], b[0]) - NEAR) / SB), i1 = Math.floor((Math.max(a[0], b[0]) + NEAR) / SB);
  const j0 = Math.floor((Math.min(a[1], b[1]) - NEAR) / SB), j1 = Math.floor((Math.max(a[1], b[1]) + NEAR) / SB);
  for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
    const key = gi + ',' + gj;
    let list = sgrid.get(key);
    if (!list) sgrid.set(key, list = []);
    list.push(n);
  }
}
// unsigned distance to the nearest coast segment, and which side of it (OSM
// keeps the land on the LEFT of a coastline; left of (dx, dz) here is (dz, -dx))
function shore(x, z) {
  const list = sgrid.get(Math.floor(x / SB) + ',' + Math.floor(z / SB));
  if (!list) return null;
  let bd = Infinity, side = 0;
  for (const n of list) {
    const ax = segs[n], az = segs[n + 1], dx = segs[n + 2] - ax, dz = segs[n + 3] - az, L = dx * dx + dz * dz || 1e-9;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / L));
    const qx = ax + dx * t, qz = az + dz * t, d = Math.hypot(x - qx, z - qz);
    if (d < bd) { bd = d; side = (x - ax) * dz - (z - az) * dx; }
  }
  return bd === Infinity ? null : { d: bd, land: side > 0 };
}
const smooth01 = (a, b, v) => { const t = Math.max(0, Math.min(1, (v - a) / (b - a))); return t * t * (3 - 2 * t); };

const hash = (i, j, s) => {
  let h = Math.imul(i ^ 0x9e3779b1, 2654435761) ^ Math.imul(j ^ s, 0x27d4eb2d);
  h ^= h >>> 15; h = Math.imul(h, 2246822519); h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

mkdirSync(`${OUT}/terrain`, { recursive: true });
mkdirSync(`${OUT}/canopy`, { recursive: true });
const gridAt = (x, z) => {
  const i = Math.round((x - GX0) / CR), j = Math.round((z - GZ0) / CR);
  return Math.max(0, Math.min(GH - 1, j)) * GW + Math.max(0, Math.min(GW - 1, i));
};
let peak = -1e9, peakAt = null, canopyCells = 0, zoneN = [0, 0, 0, 0], landTiles = 0;
for (const [tx, tz] of tiles) {
  // terrain
  const g = new Int16Array(TN * TN);
  let anyLand = false;
  for (let j = 0; j < TN; j++) for (let i = 0; i < TN; i++) {
    const x = tx * T + i * TR, z = tz * T + j * TR, k = gridAt(x, z);
    const lat = W.latOf(z), lon = W.lonOf(x);
    let h;
    const near = (land[k] ? toSea[k] : toLand[k]) < NEAR + 20 ? shore(x, z) : null;
    // the side: the mask, except right at the water, where the exact line decides
    const isLand = near && near.d < 15 ? near.land : !!land[k];
    if (isLand) {
      anyLand = true;
      h = demAt(lat, lon);
      if (coverAt(lat, lon) === TREE) h -= FOREST_BIAS * Math.min(1, toSea[k] / 120);
      // a beach rises out of the water at a beach's slope, whatever the radar saw
      h = Math.max(0.35, Math.min(h, 0.35 + toSea[k] * 0.35));
      if (near && near.d < NEAR) { const w = smooth01(NEAR / 2, NEAR, near.d); h = (1 - w) * RAMP * near.d + w * h; }
      if (h > peak) { peak = h; peakAt = [lat, lon]; }
    } else {
      h = seabed(toLand[k], toReef[k]);
      if (near && near.d < NEAR) { const w = smooth01(NEAR / 2, NEAR, near.d); h = (1 - w) * -RAMP * near.d + w * h; }
    }
    g[j * TN + i] = Math.round(h * 10);
  }
  writeFileSync(`${OUT}/terrain/${tx}_${tz}.bin`, Buffer.from(g.buffer));
  if (!anyLand) continue;
  landTiles++;
  // canopy: quarter metres, the two low bits the zone (see header)
  const c = new Uint8Array(CN * CN);
  for (let j = 0; j < CN; j++) for (let i = 0; i < CN; i++) {
    const x = tx * T + i * CR, z = tz * T + j * CR, k = gridAt(x, z);
    if (!land[k]) continue;
    const lat = W.latOf(z), lon = W.lonOf(x), cls = coverAt(lat, lon);
    const elev = demAt(lat, lon), r = hash(i + tx * CN, j + tz * CN, 7);
    let hgt = 0, zone;
    const coastal = toSea[k] < 350 && elev < 40;
    zone = cls === MANGROVE ? 3 : coastal ? 0 : elev < 250 ? 1 : 2;
    if (cls === TREE) hgt = zone === 0 ? 15 + r * 9 : zone === 1 ? 14 + r * 10 : 9 + r * 9;
    else if (cls === MANGROVE) hgt = 5 + r * 3;
    else if (cls === SHRUB) hgt = r < 0.5 ? 3 + r * 4 : 0;
    // the gardens of the built-up coast: a palm or a breadfruit here and there
    else if (cls === BUILT) hgt = r < 0.10 ? 10 + r * 60 : 0;
    else if (cls === GRASS || cls === CROP) hgt = r < 0.04 ? 9 + r * 100 : 0;
    if (!(hgt > 0)) continue;
    let q = Math.min(252, Math.round(hgt));   // whole metres …
    c[j * CN + i] = Math.min(251, q * 4 + zone);   // … times four, plus the zone (255 is NO_DATA)
    canopyCells++; zoneN[zone]++;
  }
  writeFileSync(`${OUT}/canopy/${tx}_${tz}.bin`, Buffer.from(c.buffer));
}

// ---- the lagoon map for the water shader ---------------------------------------
// Two bytes per 20 m: the depth in decimetres (land is 0, the shallowest the
// water gets, so a filtered sample along the coast is a beach and not the
// average of "land" and a depth), and the reef crest as its own channel, for
// the same reason. For the
// whole island box, read once by js/mahe/sea.js.
const SR = 20, SW = Math.ceil((GW - 1) * CR / SR) + 1, SH = Math.ceil((GH - 1) * CR / SR) + 1;
const sea = new Uint8Array(SW * SH * 2);
for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
  const k = gridAt(GX0 + i * SR, GZ0 + j * SR), o = (j * SW + i) * 2;
  sea[o] = land[k] ? 0 : Math.min(255, Math.round(-seabed(toLand[k], toReef[k]) * 10));
  sea[o + 1] = reef[k] ? 255 : 0;
}
writeFileSync(`${OUT}/sea.bin`, Buffer.from(sea.buffer));
writeFileSync(`${OUT}/sea.json`, JSON.stringify({ x0: GX0, z0: GZ0, res: SR, w: SW, h: SH, unit: 0.1, channels: ['depth', 'reef'] }));
console.log(`terrain: ${tiles.length} tiles; highest point ${peak.toFixed(0)} m at ${peakAt?.map((v) => v.toFixed(4)).join(', ')}`
  + ` (Morne Seychellois is 905 m)`);
console.log(`canopy: ${landTiles} tiles, ${canopyCells.toLocaleString()} tree cells; zones coast/low/high/mangrove ${zoneN.join('/')}`);
console.log(`sea map ${SW}×${SH} at ${SR} m → ${OUT}/sea.bin`);
