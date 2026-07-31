// ---- what is the ground where nobody said? --------------------------------
// Measured over a 180 m circle on Pardubice main station, 95 % of the ground
// carries no OSM polygon at all — not after adding platforms, not after adding
// works yards, not after anything. OSM simply does not map the square in front
// of the station, and the runtime's fallback ("ground nobody mapped is a
// field") turns a paved forecourt into a lawn.
//
// Two geometric inferences were tried first and both were MEASURED to fail: the
// forecourt has 0 % road coverage within 25 m while a suburban garden has 65 %,
// so "is this circulation space" separates nothing, and "how close is the
// nearest building" puts a garden and a forecourt within 5 m of each other.
// There is no shape-of-the-data answer here.
//
// What is left is the photograph. It cannot say what a thing IS — that is why
// the world stopped being built out of it — but it can say what COLOUR the
// ground is, and green against grey is exactly the distinction that is missing.
//
// So the photograph is asked ONCE, here, offline, and never again: the answer
// is vectorised into ordinary polygons in the tile, indistinguishable from the
// ones OSM supplied, and the game ships without a photograph in it.
//
// HOW IT DECIDES, and it is deliberately crude, because a crude answer with a
// known failure mode beats a clever one without:
//   · anything OSM already covers is skipped — it has a better source
//   · green (2G − R − B, the standard excess-green index) → leave it as field
//   · not green and bright  → paving / concrete
//   · not green and dark    → asphalt
// then open-close the raster to kill speckle, and emit only regions above a
// minimum area, because a 4 m² patch of "paving" in a meadow is a shadow.
//
// OUTPUT IS A RASTER, NOT POLYGONS. The polygon version shipped nine thousand
// rectangles per city tile (2.3 MB of coordinates for a byte per cell) and,
// worse, a polygon is a plate at a fixed layer height — a levelled road cuts up
// to 14 cm into the hill, so the plate could sit ABOVE the carriageway and bury
// it. The raster is drawn by the client at LAYER_Y.inferred = 4 cm, below every
// OSM fill and below the shallowest possible road, so that conflict cannot
// exist. RLE, ~20–150 kB per city tile, nothing for open country.
//
// Usage: node scripts/classify-ground.mjs [--tiles="-1,-1 0,-2"] [--dry]

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { decodePNG } from './lib/png.mjs';

const TILE = 4800;
const RES = 4;                          // m per classified cell
const N = TILE / RES;                   // 1200 cells a side
const PX = 1200;                        // pixels per WMS request…
const SPAN = TILE / 2;                  // …covering this many metres (2 m/px)
// Tuned against the Pardubice station square, where the paved strips between
// the footways are about ten metres wide: closing with a radius of 2 (an 8 m
// erosion) ate them and put the grass fallback back up from 22 % to 42 %.
const MIN_AREA = 80;                    // m² — under this it is a shadow
const WMS = 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer';
const UA = 'AmongTheCity-dev/0.7 (three.js game prototype; contact: bondyfanfrankwild@gmail.com)';
const DIR = 'public/data/tiles';
const GROUND_DIR = 'public/data/ground';
// The photograph is the slow part and the classifier is the part being tuned,
// so the download is cached on disk. Gitignored, throwaway, and it turns a
// forty-second iteration into a two-second one.
const CACHE = 'data/raw-ortho';

const ONLY = (process.argv.find((a) => a.startsWith('--tiles=')) ?? '').slice(8).split(/\s+/).filter(Boolean);
const DRY = process.argv.includes('--dry');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the photograph --------------------------------------------------------

async function fetchQuadrant(tile, qx, qz) {
  const { origin, mPerLat, mPerLon } = tile;
  const x0 = tile.tx * TILE + qx * SPAN, z0 = tile.tz * TILE + qz * SPAN;
  const lonW = origin.lon + x0 / mPerLon, lonE = origin.lon + (x0 + SPAN) / mPerLon;
  // our z axis points SOUTH, so the smaller z is the NORTHERN edge
  const latN = origin.lat - z0 / mPerLat, latS = origin.lat - (z0 + SPAN) / mPerLat;
  const url = `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=CRS:84`
    + `&BBOX=${[lonW, latS, lonE, latN].map((v) => v.toFixed(7)).join(',')}`
    + `&WIDTH=${PX}&HEIGHT=${PX}&FORMAT=image/png`;
  mkdirSync(CACHE, { recursive: true });
  const hit = `${CACHE}/${tile.tx}_${tile.tz}_${qx}${qz}.png`;
  if (existsSync(hit)) return decodePNG(readFileSync(hit));
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      // the WMS reports its own failures as HTTP 200 + an XML ServiceException
      if (buf[0] !== 0x89) throw new Error('not an image: ' + buf.toString('latin1', 0, 120));
      writeFileSync(hit, buf);
      return decodePNG(buf);
    } catch (err) {
      if (attempt >= 4) throw new Error(`${tile.tx},${tile.tz} q${qx}${qz}: ${err.message}`);
      await sleep(1500 + attempt * 2500);
    }
  }
}

// ---- what OSM already answers for -----------------------------------------
// Exactly the layers whose ground the runtime already draws. Anything stamped
// here is left alone: OSM stood on it and the photograph did not.

// GREEN and SEALED are the only two things the photograph decides. PAVING,
// ASPHALT and GRAVEL are what a SEALED region is later found to be MADE of,
// from its context — never from its brightness.
const COVERED = 1, GREEN = 2, SEALED = 3, CLAIMED = 6, UNSEEN = 7;
const PAVING = 10, ASPHALT = 11, GRAVEL = 12;

function stampCovered(mask, tile) {
  const x0 = tile.tx * TILE, z0 = tile.tz * TILE;
  const poly = (o, holes) => fillPolygon(mask, x0, z0, o, holes, COVERED);
  for (const f of tile.buildings) if (f.o?.length >= 3) poly(f.o, f.i);
  for (const f of tile.paved) if (f.o?.length >= 3) poly(f.o, f.i);
  for (const f of tile.water) if (f.o?.length >= 3) poly(f.o, f.i);
// GREEN is trusted. There was a release where the photograph could dispute an
  // OSM green tag; with the output a raster UNDER the OSM fills that dispute
  // cannot render (the mapped green draws on top regardless), so the honest
  // thing is not to make it. Where OSM drew a polygon, OSM decides.
  for (const f of tile.green) if (f.o?.length >= 3) poly(f.o, f.i);
  // ROADS ARE NOT COVERED EITHER, and this was the whole of the remaining bug.
  //
  // Traced at the exact spot the user reported, x 18.1 z −118.4 in front of
  // Pardubice station: the photograph there is RGB 176,175,171 — bright neutral
  // grey, paving, exactly as reported — and the classifier never looked at it,
  // because the cell was stamped COVERED by a two-metre footway. Cells are 4 m,
  // so a cell is blanked whenever its CENTRE falls within the corridor: a 2 m
  // path takes out a 4 m swath, and the ribbon drawn over it is 2 m wide. The
  // difference showed as a lawn down both sides of every path in the city.
  //
  // Narrowing the corridor only moves the error. Removing it costs nothing: a
  // road ribbon draws at LAYER_Y.road, well above this layer, so ground
  // inferred underneath one is invisible — and the margins either side, which
  // are the part you can actually see, finally get classified.
  //
  // Rails keep their stamp: ballast is not a surface the photograph can read
  // usefully, and the sleepers alias into stripes of "paving".
  for (const f of tile.rails) stampLine(mask, x0, z0, f.p, 2);
}

function fillPolygon(m, x0, z0, outer, holes, value) {
  let za = Infinity, zb = -Infinity;
  for (const [, z] of outer) { if (z < za) za = z; if (z > zb) zb = z; }
  const j0 = Math.max(0, Math.floor((za - z0) / RES));
  const j1 = Math.min(N - 1, Math.ceil((zb - z0) / RES));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const zc = z0 + (j + 0.5) * RES;
    xs.length = 0;
    crossings(outer, zc, xs);
    for (const h of holes ?? []) if (h.length >= 3) crossings(h, zc, xs);
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / RES - 0.5));
      const i1 = Math.min(N - 1, Math.floor((xs[k + 1] - x0) / RES - 0.5));
      for (let i = i0; i <= i1; i++) m[j * N + i] = value;
    }
  }
}

function crossings(ring, zc, out) {
  for (let k = 0; k < ring.length; k++) {
    const [ax, az] = ring[k], [bx, bz] = ring[(k + 1) % ring.length];
    if ((az <= zc) === (bz <= zc)) continue;
    out.push(ax + ((zc - az) / (bz - az)) * (bx - ax));
  }
}

function stampLine(m, x0, z0, pts, hw, value = COVERED) {
  if (!pts || pts.length < 2) return;
  const hw2 = hw * hw;
  for (let k = 0; k < pts.length - 1; k++) {
    const ax = pts[k][0], az = pts[k][1], bx = pts[k + 1][0], bz = pts[k + 1][1];
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - hw - x0) / RES));
    const i1 = Math.min(N - 1, Math.ceil((Math.max(ax, bx) + hw - x0) / RES));
    const j0 = Math.max(0, Math.floor((Math.min(az, bz) - hw - z0) / RES));
    const j1 = Math.min(N - 1, Math.ceil((Math.max(az, bz) + hw - z0) / RES));
    const dx = bx - ax, dz = bz - az, len2 = dx * dx + dz * dz || 1e-9;
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * RES;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * RES;
        let t = ((px - ax) * dx + (pz - az) * dz) / len2;
        if (t < 0) t = 0; else if (t > 1) t = 1;
        const ex = px - (ax + dx * t), ez = pz - (az + dz * t);
        if (ex * ex + ez * ez <= hw2) m[j * N + i] = value;
      }
    }
  }
}

// ---- the classifier --------------------------------------------------------

const warmOf = (r, b) => r - b;

/** Average a 2×2 block of 2 m pixels into one 4 m cell, then decide. */
// ---- what the photograph can and cannot see --------------------------------
// Measured on tile 0_-1, against ground OSM states the material of, inside this
// same orthophoto: asphalt roads median luminance 153, paving 148, concrete
// 150, cobble 139, gravel 152. Separating asphalt from paving costs 50.0 %
// balanced error on luminance — EXACTLY CHANCE — and 31.6 % on the best index
// tried. The photograph cannot see material. Every "bright is paving, dark is
// asphalt" rule this file used to contain was reading noise, and the noise it
// was reading was shadow: one grey expanse with dark continents drifting over
// it is what that looks like on screen.
//
// What it CAN see is chlorophyll. Sealed against green, on the normalised
// excess-green index, costs 8.1 % — and 13.8 % inside shadow, where a raw index
// falls apart, because dividing by (R+G+B) is exactly the exposure correction a
// shadow needs. The warm axis is kept alongside it, not as a class of its own
// but to stop a harvested field being called a car park: bare Czech soil is
// strongly red-over-blue and nothing paved is.
//
// So the photograph is asked ONE BIT, and the material is decided afterwards
// from context — which is where the information actually is.
const SEAL_GREEN = 0.055;      // normalised excess green, above this it grows
const SEAL_WARM = 0.07;        // normalised red-over-blue, above this it is soil

// ---- where the photograph cannot see the ground ---------------------------
// An orthophoto is taken from above, and over every street tree it records the
// CROWN, not the pavement under it. Classified naively that is a green cell in
// the middle of a plaza — and a city square came out with ragged green blotches
// scattered all over it, one per tree, which is exactly the mess on the
// user's screenshot. The canopy raster (surface model minus bare earth,
// fetch-canopy.mjs) says precisely where this happens: anything standing
// taller than CANOPY_MIN there is a crown, and the ground under a crown is
// UNSEEN — decided from its neighbours, not from the pixel.
const CANOPY_MIN = 2.5;               // m — under this it is a hedge you can see past
const CANOPY_RES = 10, CANOPY_N = 481;

function loadCanopy(tile) {
  try {
    const b = readFileSync(`public/data/canopy/${tile.tx}_${tile.tz}.bin`);
    return b.length >= CANOPY_N * CANOPY_N ? b : null;
  } catch { return null; }
}

/** Blank every classified cell whose ground the photograph never saw. */
function maskCanopy(mask, canopy, tile) {
  if (!canopy) return 0;
  let n = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = mask[j * N + i];
      if (v !== GREEN && v !== SEALED) continue;
      const ci = Math.round(((i + 0.5) * RES) / CANOPY_RES);
      const cj = Math.round(((j + 0.5) * RES) / CANOPY_RES);
      const h = canopy[Math.min(CANOPY_N - 1, cj) * CANOPY_N + Math.min(CANOPY_N - 1, ci)];
      if (h !== 255 && h * 0.25 > CANOPY_MIN) { mask[j * N + i] = UNSEEN; n++; }
    }
  }
  return n;
}

/**
 * Decide UNSEEN cells from their neighbours, ring by ring — ground under a
 * crown is whatever the ground around the crown is. Cells no ring ever reaches
 * (the middle of a wood) default to GREEN, which is what a wood floor is.
 */
function inpaint(mask, rounds = 20) {
  for (let pass = 0; pass < rounds; pass++) {
    const flips = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        if (mask[j * N + i] !== UNSEEN) continue;
        let g = 0, sl = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (!di && !dj) continue;
            const ii = i + di, jj = j + dj;
            if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
            const v = mask[jj * N + ii];
            if (v === GREEN) g++; else if (v === SEALED) sl++;
          }
        }
        if (g || sl) flips.push(j * N + i, sl > g ? SEALED : GREEN);
      }
    }
    if (!flips.length) break;
    for (let k = 0; k < flips.length; k += 2) mask[flips[k]] = flips[k + 1];
  }
  let left = 0;
  for (let k = 0; k < mask.length; k++) if (mask[k] === UNSEEN) { mask[k] = GREEN; left++; }
  return left;
}

/**
 * One 3×3 majority pass over the green/sealed field, then absorb every green
 * island smaller than a real bed. The first straightens the 4 m staircase the
 * raster cuts along every boundary; the second is what "clean" means on a
 * square — a 150 m² lawn is a lawn, a 30 m² speckle is a classifier artefact.
 */
function tidy(mask) {
  const flips = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const v = mask[j * N + i];
      if (v !== GREEN && v !== SEALED) continue;
      let same = 0, other = 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
          const w = mask[jj * N + ii];
          if (w === v) same++;
          else if (w === GREEN || w === SEALED) other++;
        }
      }
      if (other >= 6 && same <= 2) flips.push(j * N + i, v === GREEN ? SEALED : GREEN);
    }
  }
  for (let k = 0; k < flips.length; k += 2) mask[flips[k]] = flips[k + 1];

  const MIN_GREEN = 150;                       // m² — under this it is noise
  const seen = new Uint8Array(N * N);
  const stack = [], region = [];
  let absorbed = 0;
  for (let start = 0; start < N * N; start++) {
    if (seen[start] || mask[start] !== GREEN) continue;
    region.length = 0; stack.length = 0;
    stack.push(start); seen[start] = 1;
    let pure = true;                           // touching only SEALED (and edges)
    while (stack.length) {
      const at = stack.pop();
      region.push(at);
      const i = at % N, j = (at / N) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((di && dj) || (!di && !dj)) continue;
          const ii = i + di, jj = j + dj;
          if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
          const o = jj * N + ii;
          const v = mask[o];
          if (v === GREEN) { if (!seen[o]) { seen[o] = 1; stack.push(o); } }
          else if (v !== SEALED) pure = false; // meets covered/open ground
        }
      }
      if (region.length * RES * RES > MIN_GREEN * 4) pure = false; // early out
    }
    if (pure && region.length * RES * RES < MIN_GREEN) {
      for (const o of region) mask[o] = SEALED;
      absorbed++;
    }
  }
  return absorbed;
}

function classify(mask, quads) {
  let sealed = 0, green = 0, unknown = 0;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      if (mask[j * N + i]) continue;
      const qx = i < N / 2 ? 0 : 1, qz = j < N / 2 ? 0 : 1;
      const img = quads[qz * 2 + qx];
      if (!img) continue;
      const px0 = (i - qx * (N / 2)) * 2, pz0 = (j - qz * (N / 2)) * 2;
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const o = ((pz0 + dy) * img.w + (px0 + dx)) * 3;
          r += img.rgb[o]; g += img.rgb[o + 1]; b += img.rgb[o + 2];
        }
      }
      r /= 4; g /= 4; b /= 4;
      const sum = r + g + b || 1;
      const nexg = (2 * g - r - b) / sum;
      const nwarm = (r - b) / sum;
      if (nexg < SEAL_GREEN && nwarm < SEAL_WARM) { mask[j * N + i] = SEALED; sealed++; }
      else { mask[j * N + i] = GREEN; green++; }
    }
  }
  return { sealed, green, unknown };
}

/**
 * What a SEALED region is MADE OF, decided from context rather than brightness
 * — because brightness was measured to be worth nothing for it (see classify
 * above) and context is not.
 *
 * Ordered, first match wins, and every rule is a thing you could point at:
 *   · inside a works, depot, railway yard or car park → asphalt. That is what
 *     those are made of.
 *   · mostly ringed by carriageway                    → asphalt. A bay, a
 *     turning head, the space a service road opens into: the road, spread out.
 *   · touching a platform or a plaza                  → paving. The same
 *     surface, continuing past where OSM stopped drawing it.
 *   · anything else                                   → paving, which is what
 *     unmapped sealed ground in a Czech town nearly always is.
 *
 * Components are found first and the small ones dropped, so the decision is
 * made once for a whole yard rather than once per cell — which is the whole
 * difference between a square and a square with the weather on it.
 */
function materialise(mask, road, tile) {
  const x0 = tile.tx * TILE, z0 = tile.tz * TILE;
  // A WORKS zone (railway, industrial, depot, port, quarry) is the one context
  // where unmapped sealed ground is asphalt rather than paving. `urban` zones —
  // commercial, retail — are deliberately NOT here: they span whole town-centre
  // blocks, squares and streets alike, and voting them asphalt is what painted
  // Palackého třída dark.
  const yard = new Uint8Array(N * N);
  for (const f of tile.zones ?? []) {
    if (f.t === 'works' && f.o?.length >= 3) fillPolygon(yard, x0, z0, f.o, f.i, 1);
  }
  for (const f of tile.paved ?? []) {
    if (!f.o || f.o.length < 3 || f.t === 'inferred') continue;
    if (f.t === 'yard' || f.t === 'parking') fillPolygon(yard, x0, z0, f.o, f.i, 1);
  }
  const seen = new Uint8Array(N * N);
  const stack = [], region = [];
  const stats = { paving: 0, asphalt: 0, dropped: 0 };
  for (let start = 0; start < N * N; start++) {
    if (seen[start] || mask[start] !== SEALED) continue;
    region.length = 0; stack.length = 0;
    stack.push(start); seen[start] = 1;
    let inYard = 0;
    while (stack.length) {
      const at = stack.pop();
      region.push(at);
      if (yard[at]) inYard++;
      const i = at % N, j = (at / N) | 0;
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          if ((di && dj) || (!di && !dj)) continue;      // 4-connected
          const ii = i + di, jj = j + dj;
          if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
          const o = jj * N + ii;
          if (mask[o] !== SEALED || seen[o]) continue;
          // a kerb bounds a region: a carriageway is not the pavement beside it
          if (road[o] !== road[at]) continue;
          seen[o] = 1; stack.push(o);
        }
      }
    }
    if (region.length * RES * RES < MIN_AREA) {
      for (const o of region) mask[o] = 0;
      stats.dropped++;
      continue;
    }
    // ASPHALT ONLY WHERE A POLYGON SAYS SO. The rule that guessed it from being
    // ringed by carriageway is what put ragged dark continents all over the
    // station square: every pocket of ground beside a road became tarmac, with
    // a boundary made of 4 m rectangles, and the square stopped reading as a
    // square. It also had nothing to add — the roads are already drawn as
    // ribbons from OSM, at their own layer, above this one. What is left over
    // beside them is pavement, and in a Czech town that is what it nearly
    // always is.
    const mat = inYard > region.length / 2 ? ASPHALT : PAVING;
    for (const o of region) mask[o] = mat;
    stats[mat === ASPHALT ? 'asphalt' : 'paving']++;
  }
  return stats;
}


// ---- per tile --------------------------------------------------------------

const tiles = readdirSync(DIR).filter((f) => f.endsWith('.json'))
  .map((f) => f.slice(0, -5))
  .filter((k) => !ONLY.length || ONLY.includes(k.replace('_', ',')));

console.log(`classifying ${tiles.length} tiles from the ČÚZK orthophoto at ${RES} m`);
let done = 0, added = 0;
for (const key of tiles) {
  const file = `${DIR}/${key}.json`;
  const tile = JSON.parse(readFileSync(file, 'utf8'));
  // re-runnable: drop what a previous run inferred before inferring again
  tile.paved = tile.paved.filter((f) => f.t !== 'inferred');

  const mask = new Uint8Array(N * N);
  stampCovered(mask, tile);
  const open = mask.reduce((a, v) => a + (v ? 0 : 1), 0);
  if (open < 400) { done++; continue; }        // nothing worth a download

  const quads = [];
  for (let qz = 0; qz < 2; qz++) for (let qx = 0; qx < 2; qx++) quads.push(await fetchQuadrant(tile, qx, qz));
  // --probe=x,z ... : say exactly what happened to those cells. Guessing why a
  // classifier said what it said is how an afternoon disappears.
  const probes = process.argv.filter((a) => a.startsWith('--probe='))
    .map((a) => a.slice(8).split(',').map(Number));
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    const before = mask[j * N + i];
    const qx = i < N / 2 ? 0 : 1, qz = j < N / 2 ? 0 : 1;
    const img = quads[qz * 2 + qx];
    const ix = (i - qx * (N / 2)) * 2, iz = (j - qz * (N / 2)) * 2;
    const o = (iz * img.w + ix) * 3;
    const r = img.rgb[o], g = img.rgb[o + 1], b = img.rgb[o + 2];
    console.log(`  probe ${px},${pz}: cell ${i},${j} covered=${before} rgb=${r},${g},${b}`
      + ` exg=${(2 * g - r - b).toFixed(0)} lum=${(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(0)}`
      + ` warm=${r - b}`);
  }
  const stats = classify(mask, quads);
  // the photograph never saw the ground under a crown — decide those cells
  // from their surroundings instead of from a picture of a tree
  const crowned = maskCanopy(mask, loadCanopy(tile), tile);
  const unfilled = inpaint(mask);
  const absorbed = tidy(mask);
  const NAME = { 0: 'open', 1: 'covered', 2: 'green', 3: 'sealed', 10: 'paving', 11: 'asphalt' };
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    console.log(`    → the photograph says ${NAME[mask[j * N + i]]}`);
  }
  // A kerb bounds a region (a carriageway is not the pavement beside it), and
  // the material comes from CONTEXT — never from brightness, which is measured
  // to be worth nothing for it.
  const roadCells = new Uint8Array(N * N);
  for (const f of tile.roads) stampLine(roadCells, tile.tx * TILE, tile.tz * TILE, f.p, (f.w ?? 3) / 2, 1);
  const made = materialise(mask, roadCells, tile);
  // ---- junction mouths are asphalt ----------------------------------------
  // OSM draws a road at its width, and at a junction the real carriageway fans
  // out well past it — turn lanes, corner radii, the splay. The photograph
  // classifies that fan as sealed (it is), and with material coming from
  // context it came out PAVING: light-grey patches sitting in the middle of
  // every big crossing. The context that decides it is "this is the junction,
  // spread out": sealed cells near a node where three or more drivable arms
  // meet, and still within reach of a carriageway, are the carriageway.
  const MOUTH_R = 13, MOUTH_REACH = 4.5;
  {
    const wide = new Uint8Array(N * N);
    for (const f of tile.roads) {
      if (!f.d) continue;
      stampLine(wide, tile.tx * TILE, tile.tz * TILE, f.p, (f.w ?? 3) / 2 + MOUTH_REACH, 1);
    }
    const arms = new Map();
    for (const f of tile.roads) {
      if (!f.d || !f.p || f.p.length < 2) continue;
      for (const q of f.p) {
        const k = Math.round(q[0] * 2) + ',' + Math.round(q[1] * 2);
        arms.set(k, (arms.get(k) ?? 0) + 1);
      }
    }
    const rc = Math.ceil(MOUTH_R / RES);
    for (const [k, n] of arms) {
      if (n < 3) continue;                       // two arms is a street split
      const [qx2, qz2] = k.split(',').map(Number);
      const nx = qx2 / 2 - tile.tx * TILE, nz = qz2 / 2 - tile.tz * TILE;
      const ci = Math.round(nx / RES), cj = Math.round(nz / RES);
      for (let dj = -rc; dj <= rc; dj++) {
        for (let di = -rc; di <= rc; di++) {
          if ((di * di + dj * dj) * RES * RES > MOUTH_R * MOUTH_R) continue;
          const ii = ci + di, jj = cj + dj;
          if (ii < 0 || ii >= N || jj < 0 || jj >= N) continue;
          const o = jj * N + ii;
          if (mask[o] === PAVING && wide[o]) mask[o] = ASPHALT;
        }
      }
    }
  }
  for (const [px, pz] of probes) {
    const i = Math.floor((px - tile.tx * TILE) / RES), j = Math.floor((pz - tile.tz * TILE) / RES);
    console.log(`    → made of ${NAME[mask[j * N + i]]}`);
  }

  // ---- ship it as the raster it is --------------------------------------
  // No carriageway subtraction and no corridor games: the client draws this
  // at LAYER_Y.inferred, below every levelled road, so sealed ground under a
  // ribbon is simply invisible — which is what "under" should have meant all
  // along. And the tile sheds the nine thousand rectangles a previous version
  // pushed into `paved`; stripping them here is what un-ships them.
  const out = Buffer.allocUnsafe(N * N * 3);
  let bytes3 = 0, cells = 0;
  let run = 0, val = mask[0] === PAVING ? 1 : mask[0] === ASPHALT ? 2 : 0;
  const flush = (v, n) => {
    while (n > 0) {
      const take = Math.min(n, 65535);
      out.writeUInt16LE(take, bytes3); out.writeUInt8(v, bytes3 + 2);
      bytes3 += 3; n -= take;
    }
  };
  for (let k = 0; k < N * N; k++) {
    const v = mask[k] === PAVING ? 1 : mask[k] === ASPHALT ? 2 : 0;
    if (v) cells++;
    if (v === val) { run++; continue; }
    flush(val, run); val = v; run = 1;
  }
  flush(val, run);
  const n = cells;
  added += n;
  if (!DRY) {
    mkdirSync(GROUND_DIR, { recursive: true });
    writeFileSync(`${GROUND_DIR}/${key}.bin`, out.subarray(0, bytes3));
    writeFileSync(file, JSON.stringify(tile));   // …with the inferred polygons stripped
  }
  done++;
  console.log(`  ${key}: ${(100 * open / (N * N)).toFixed(0)}% unmapped → `
    + `${stats.sealed} sealed / ${stats.green} green cells → `
    + `${made.paving} paved regions, ${made.asphalt} asphalt, ${made.dropped} too small`
    + `; ${crowned} under canopy (${unfilled} unfilled), ${absorbed} speckles absorbed`
    + ` → ${(bytes3 / 1024).toFixed(0)} kB raster (${cells} cells)`);
  await sleep(200);                            // be a good citizen of a free service
}
console.log(`
${done} tiles, ${(added / 1e3).toFixed(0)}k sealed cells rastered${DRY ? ' (dry run, nothing written)' : ''}`);
