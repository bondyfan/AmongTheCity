// ---- What counts as "the world", in one place ----
// v3's world was a rectangle: 30×38 km around Pardubice, 72 tiles, every one of
// them fetched. v8 stretches to Prague, 110 km west — and a rectangle that wide
// would be 252 tiles, most of them farmland nobody will ever drive through.
//
// So the world is now a UNION of shapes: the original agglomeration box, a
// BAND along the D11 (the motorway the player actually drives, plus the
// villages strung along it), and a box over Prague. A tile is built if it
// touches any of them. Everything downstream — the splitter, the builder, the
// manifest — asks this module, so the world's shape is one edit away and the
// two scripts can never disagree about it.
//
// Coordinates: the origin is Pardubice hlavní nádraží and always will be. Every
// data file ever produced is in metres from that node, so moving it would
// invalidate the whole pipeline (and the ortho WMS registration in js/ortho.js,
// which duplicates these constants on purpose).

export const ORIGIN = { lat: 50.0317084, lon: 15.7560881 };
export const M_PER_LAT = 111132.9 - 559.8 * Math.cos(2 * ORIGIN.lat * Math.PI / 180);
export const M_PER_LON = 111412.8 * Math.cos(ORIGIN.lat * Math.PI / 180)
  - 93.5 * Math.cos(3 * ORIGIN.lat * Math.PI / 180);
export const TILE = 4800;

export const xOf = (lon) => (lon - ORIGIN.lon) * M_PER_LON;
export const zOf = (lat) => (ORIGIN.lat - lat) * M_PER_LAT;   // south positive
export const lonOf = (x) => ORIGIN.lon + x / M_PER_LON;
export const latOf = (z) => ORIGIN.lat - z / M_PER_LAT;

// The envelope every node is tested against before it enters the index. Wider
// than the shapes below by a comfortable margin so a way that leaves the world
// and comes back still resolves all its nodes.
export const ENVELOPE = { latS: 49.06, latN: 50.36, lonW: 14.12, lonE: 17.96 };

// ---- the shapes ----------------------------------------------------------
// The D11 centreline, sampled at its junctions from Prague's eastern edge to
// Hradec Králové, then down the D35/I-37 spur that ties Hradec to Pardubice.
// A band this wide (±8 km) holds every village that reads as "beside the
// motorway" — Jirny, Sadská, Poděbrady, Libice, Žiželice, Chlumec, Dobřenice —
// without dragging in the whole Polabí plain.
const D11 = [
  [50.1085, 14.5820],  // Praha, Černý Most / Chlumecká — the motorway's head
  [50.1160, 14.6960],  // exit 8 Jirny
  [50.1280, 14.8280],  // exit 18 Bříství
  [50.1410, 14.9520],  // exit 25 Sadská
  [50.1495, 15.0880],  // exit 35 Poděbrady
  [50.1455, 15.1800],  // exit 42 Libice nad Cidlinou
  [50.1500, 15.2900],  // exit 49 Žiželice
  [50.1545, 15.4100],  // exit 56 Chlumec nad Cidlinou
  [50.1720, 15.5600],  // exit 62 Dobřenice
  [50.1930, 15.7100],  // exit 76 Hradec Králové-jih
  [50.2130, 15.8000],  // Hradec Králové, the D11/D35 knot
];
const HK_PCE = [       // D35 + I/37: Hradec → Opatovice → Pardubice
  [50.2130, 15.8000],
  [50.1500, 15.7900],  // Opatovice nad Labem
  [50.0700, 15.7700],  // Pardubice, Rosice
  [50.0317, 15.7561],  // the origin itself
];
// …and the long haul east: Pardubice to Zlín, the I/35 through Vysoké Mýto,
// Litomyšl, Svitavy and Moravská Třebová, the D35 down from Mohelnice to
// Olomouc, then the D55 through Přerov and Hulín to Otrokovice and up the
// Dřevnice valley into Zlín. Roughly 200 km, which is longer than the whole
// Prague world put together, so it gets a narrower band: at ±8 km a connector
// this long would add more tiles than the rest of the world has, and most of
// them are Haná farmland. ±5.5 km still holds every town the road runs
// through, which is what makes a drive feel like it goes somewhere.
const PCE_ZLIN = [
  [50.0317, 15.7561],  // the origin — Pardubice hlavní nádraží
  [49.9880, 15.9560],  // Zámrsk / Cerekvice, where the I/35 leaves the Labe plain
  [49.9531, 16.1614],  // Vysoké Mýto
  [49.8722, 16.3097],  // Litomyšl
  [49.7556, 16.4694],  // Svitavy
  [49.7583, 16.6644],  // Moravská Třebová
  [49.7778, 16.9203],  // Mohelnice — the D35 begins
  [49.7000, 17.0800],  // Litovel
  [49.5938, 17.2509],  // Olomouc
  [49.4553, 17.4509],  // Přerov
  [49.3167, 17.4644],  // Hulín
  [49.2097, 17.5333],  // Otrokovice
  [49.2265, 17.6706],  // Zlín
];
const CORRIDOR_HALF_W = 8000;   // m either side of the D11 centreline
const LONG_HALF_W = 5500;       // …and of the Pardubice–Zlín connector

// Prague: the administrative city plus a little of its ring, which is what
// makes the approach along the D11 feel like arriving somewhere.
const PRAHA = { latS: 49.9350, latN: 50.1900, lonW: 14.2150, lonE: 14.7350 };
// The original v3 world, kept whole — Pardubice, Hradec, Chrudim and the
// villages between them are the game's home ground.
const HOME = { latS: 49.92, latN: 50.26, lonW: 15.55, lonE: 15.97 };
// Zlín and the hills it is built into: Kudlov and Jaroslavice on the ridge
// south of the centre, Březůvky beyond them, Otrokovice and Napajedla down on
// the Morava, Fryšták to the north, Vizovice up the Dřevnice. The box is
// deliberately taller than the city because Zlín IS its valley — the interest
// is in the ridges, and they are what the DMR 5G has to say about the place.
const ZLIN = { latS: 49.100, latN: 49.320, lonW: 17.400, lonE: 17.900 };

// ---- tile selection ------------------------------------------------------
// Everything below works in local metres: a tile is the rectangle
// x ∈ [tx·TILE, (tx+1)·TILE), z ∈ [tz·TILE, (tz+1)·TILE).

const boxToRect = (b) => ({
  x0: xOf(b.lonW), x1: xOf(b.lonE), z0: zOf(b.latN), z1: zOf(b.latS),
});
const RECTS = [PRAHA, HOME, ZLIN].map(boxToRect);
const toLocal = (pts) => pts.map(([la, lo]) => [xOf(lo), zOf(la)]);
// Each entry is one polyline plus the half-width it claims, so routes of very
// different lengths can be given very different bands without the tile test
// having to know which is which.
const BANDS = [
  { line: toLocal(D11), half: CORRIDOR_HALF_W },
  { line: toLocal(HK_PCE), half: CORRIDOR_HALF_W },
  { line: toLocal(PCE_ZLIN), half: LONG_HALF_W },
];

// squared distance from a point to a segment, the flat-2D staple
function distSq(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const cx = ax + dx * t - px, cz = az + dz * t - pz;
  return cx * cx + cz * cz;
}

// A tile is in the corridor if ANY of its rectangle comes within half-width of
// the centreline. Sampling the rectangle (corners + edge midpoints + centre)
// rather than solving segment-to-rectangle exactly is plenty at a 4.8 km tile
// against an 8 km band — the error is a tile that joins the world one row too
// early, never one that goes missing.
function nearLine(tx, tz) {
  const x0 = tx * TILE, x1 = x0 + TILE, z0 = tz * TILE, z1 = z0 + TILE;
  const xm = x0 + TILE / 2, zm = z0 + TILE / 2;
  const pts = [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [xm, z0], [xm, z1], [x0, zm], [x1, zm], [xm, zm]];
  for (const { line, half } of BANDS) {
    const r2 = half * half;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i], b = line[i + 1];
      for (const [px, pz] of pts) if (distSq(px, pz, a[0], a[1], b[0], b[1]) <= r2) return true;
    }
  }
  return false;
}

function tileWantedRaw(tx, tz) {
  const x0 = tx * TILE, x1 = x0 + TILE, z0 = tz * TILE, z1 = z0 + TILE;
  for (const r of RECTS) if (x1 > r.x0 && x0 < r.x1 && z1 > r.z0 && z0 < r.z1) return true;
  return nearLine(tx, tz);
}

// The world's shape never changes at run time, so every answer below is a pure
// function of a tile index and worth remembering. The reason it MATTERS: the
// test sweeps nine points of the tile against every segment of three
// polylines, which is ~350 distance solves, and the splitter asks it once per
// feature across seven extracts.
const _wantMemo = new Map();
export function tileWanted(tx, tz) {
  const k = tx + ',' + tz;
  let v = _wantMemo.get(k);
  if (v === undefined) { v = tileWantedRaw(tx, tz); _wantMemo.set(k, v); }
  return v;
}

// Every wanted tile, ordered by distance from the origin so a downloader or a
// builder that is interrupted has already done the tiles nearest the spawn.
let _wanted = null;
export function wantedTiles() {
  if (_wanted) return _wanted;
  const txMin = Math.floor(xOf(ENVELOPE.lonW) / TILE), txMax = Math.floor(xOf(ENVELOPE.lonE) / TILE);
  const tzMin = Math.floor(zOf(ENVELOPE.latN) / TILE), tzMax = Math.floor(zOf(ENVELOPE.latS) / TILE);
  const out = [];
  for (let tz = tzMin; tz <= tzMax; tz++)
    for (let tx = txMin; tx <= txMax; tx++) if (tileWanted(tx, tz)) out.push([tx, tz]);
  out.sort((a, b) => (a[0] ** 2 + a[1] ** 2) - (b[0] ** 2 + b[1] ** 2));
  _wanted = out;
  return out;
}

// ---- node retention -------------------------------------------------------
// The splitter has to keep every node a wanted way might reference, and it used
// to decide that with the ENVELOPE rectangle. That was honest while the world
// was a corridor across Bohemia; with Zlín in it the envelope is 145 × 275 km
// and mostly empty, and keeping every node inside it means holding tens of
// millions of coordinates for country the game will never show — measured in
// gigabytes, and the reason to care is that the splitter has to hold them ALL
// AT ONCE to resolve ways.
//
// So retention follows the world's actual SHAPE, dilated by four tiles. The
// dilation is the margin the envelope used to provide: a way is dropped whole
// if any of its nodes is missing ("half a road is worse than no road"), so the
// keep-region has to be wider than the build-region by more than the longest
// way that pokes out of it. 19.2 km is comfortably that.
//
// It is a bitmap lookup rather than a shape test because it runs once per node
// — a hundred million times per extract — so it cannot afford a string key, let
// alone the nine-point segment sweep tileWanted() does.
const DILATE = 4;
let _mask = null;
function mask() {
  if (_mask) return _mask;
  const txMin = Math.floor(xOf(ENVELOPE.lonW) / TILE) - DILATE;
  const txMax = Math.floor(xOf(ENVELOPE.lonE) / TILE) + DILATE;
  const tzMin = Math.floor(zOf(ENVELOPE.latN) / TILE) - DILATE;
  const tzMax = Math.floor(zOf(ENVELOPE.latS) / TILE) + DILATE;
  const w = txMax - txMin + 1, h = tzMax - tzMin + 1;
  const g = new Uint8Array(w * h);
  for (let tz = tzMin; tz <= tzMax; tz++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      if (!tileWanted(tx, tz)) continue;
      for (let dj = -DILATE; dj <= DILATE; dj++) {
        for (let di = -DILATE; di <= DILATE; di++) {
          const jj = tz - tzMin + dj, ii = tx - txMin + di;
          if (jj >= 0 && jj < h && ii >= 0 && ii < w) g[jj * w + ii] = 1;
        }
      }
    }
  }
  _mask = { g, txMin, tzMin, w, h };
  return _mask;
}

/** Is this node close enough to the world to be worth remembering? */
export function nodeWanted(lat, lon) {
  const m = mask();
  const i = Math.floor(((lon - ORIGIN.lon) * M_PER_LON) / TILE) - m.txMin;
  const j = Math.floor(((ORIGIN.lat - lat) * M_PER_LAT) / TILE) - m.tzMin;
  if (i < 0 || i >= m.w || j < 0 || j >= m.h) return false;
  return m.g[j * m.w + i] === 1;
}

// The wanted tile nearest a point, for parking a feature whose own tile is
// outside the world (a river arriving from beyond the envelope). Deterministic:
// same feature, same tile, every run.
// Memoised for the same reason, and more urgently: this ran a full scan of the
// world PER FEATURE that fell outside it. With the envelope now 145 × 275 km
// that is 2 508 tiles × ~350 distance solves, ~880 000 operations, for every
// river and railway that reaches in from beyond the border — and there are
// hundreds of thousands of them. Measured on the Zlín rebuild: Prague, which
// lies entirely INSIDE the world and so never reached this function, split in
// 3.9 seconds; Královéhradecký, which does not, took 983.
const _nearMemo = new Map();
export function nearestWanted(x, z) {
  const tx = Math.floor(x / TILE), tz = Math.floor(z / TILE);
  if (tileWanted(tx, tz)) return [tx, tz];
  const k = tx + ',' + tz;
  const hit = _nearMemo.get(k);
  if (hit) return hit;
  let best = null, bestD = Infinity;
  for (const [wx, wz] of wantedTiles()) {
    const d = (wx - tx) ** 2 + (wz - tz) ** 2;
    if (d < bestD) { bestD = d; best = [wx, wz]; }
  }
  _nearMemo.set(k, best);
  return best;
}
