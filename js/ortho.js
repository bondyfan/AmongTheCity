// ---- Ortho ground: real ČÚZK aerial photos, streamed live from the WMS ----
// v2 shipped 100 pre-fetched JPEGs covering ±2.4 km; v3's world is the whole
// agglomeration (~30×38 km) and no local grid can ship that. The ČÚZK
// ortofoto WMS (open data, CC BY 4.0 — "Podkladová data ČÚZK") answers
// browser fetches with open CORS (verified), so every 480 m supertile is now
// requested STRAIGHT from GetMap at 2400² — 0.20 m/px, which is EXACTLY the
// ČÚZK native ground sample distance. Measured: adjacent-pixel contrast holds
// at 0.21 m/px (5.53) but collapses at 0.105 m/px (3.42) — past 0.20 the WMS
// only interpolates, so this is the finest real detail the public data holds:
// lane arrows and zebra stripes survive a drive-by. Each 120 m chunk still
// gets a flat quad whose UVs window into its 4×4 slice of the shared
// supertile texture, so one photo (and one HTTP request) serves 16 chunks.
//
// meshes.js asks orthoGroundMesh(cx, cz) and falls back to its flat
// COLORS.groundBase plane when we return null. Loading stays lazy and
// fire-and-forget: the quad is handed out immediately with an UNtextured
// material tinted groundBase, and the photo pops in when the JPEG lands.
// (v2 rendered black while in flight; with a remote server in the loop that
// flash gets long enough to read as a bug, so the placeholder now matches
// the flat-ground fallback color instead.)
//
// VRAM is bounded by an LRU over BYTES, not entries, because entries no longer
// cost the same: see the detail tiers below. Evicted entries dispose texture
// AND material. Failed fetches cache null (flat-color fallback, no server
// hammering) and sit in the same LRU, which doubles as a natural retry:
// revisit the area much later and the tile is asked again.

import * as THREE from 'three';
import { CHUNK, ORTHO, COLORS } from './config.js';

// GetMap BBOX needs the local-meters ↔ WGS84 mapping. These constants mirror
// the data pipeline EXACTLY (scripts/fetch-region.mjs → manifest/city JSON:
// same origin node, same meters-per-degree series at that latitude), so the
// photo registers with the OSM-derived geometry to centimeters. Duplicated
// here rather than read from the manifest because chunk builds start before
// any city JSON needs to have arrived — and the origin is the one constant
// of this project that can never change without rebuilding every data file.
const ORIGIN = { lat: 50.0317084, lon: 15.7560881 }; // Pardubice hl.n. — the one world origin
const M_PER_LAT = 111132.9 - 559.8 * Math.cos(2 * ORIGIN.lat * Math.PI / 180);
const M_PER_LON = 111412.8 * Math.cos(ORIGIN.lat * Math.PI / 180)
  - 93.5 * Math.cos(3 * ORIGIN.lat * Math.PI / 180);

const WMS = 'https://ags.cuzk.gov.cz/arcgis1/services/ORTOFOTO/MapServer/WMSServer';
// RESOLUTION BY DISTANCE. The cache used to be a flat 48 supertiles at 2400²,
// and the note above justified that with "chunks die at ≤ ±960 m, a footprint
// of ≤ ~36 supertiles". Flight voided that arithmetic: with the far ground ring
// unrolled, chunks live out to 3.8 km behind a helicopter and 4.6 km behind a
// jet, which is 289 and 400 live supertiles against a cache of 48. The result
// is not a memory problem, it is a THRASH — the same photos evicted and
// re-fetched continuously, each one a request plus a 31 MB texture upload, felt
// as the world hitching every second or so while flying.
//
// It cannot be fixed by raising the cap: 400 × 31 MB is twelve gigabytes. It is
// fixed by noticing that 0.20 m/px is the right detail under your feet and
// absurd four kilometres away. Each tier is a separate cache entry, so walking
// toward a tile upgrades it and flying away lets the coarse one serve.
// 2400² is 30.6 MB a tile, so the near tier is the whole budget on its own and
// its radius has to match what you can actually SEE in detail: 960 m is the
// on-foot chunk radius, i.e. exactly as far as full-detail geometry reaches.
// Past that 0.94 m/px, and past 3 km 1.9 m/px, which at those distances is
// under a screen pixel anyway.
const PX_NEAR = 2400, PX_MID = 512, PX_FAR = 256;
const R_NEAR = 960, R_MID = 3000;    // m from the focus
const LRU_MAX = 480;                 // entries — the tiers keep the bytes sane
const VRAM_MAX = 640e6;              // …and this is the actual budget
const pxBytes = (px) => px * px * 4 * 1.33;   // RGBA + the mip chain
// The world runs from Prague (x ≈ −110 km) to east of Hradec, so the clamp is
// now a bound on the DATA, not on the old 30 km region: past this the WMS would
// be asked for photos of places the game has no map for. ČÚZK covers the whole
// country, so the only cost of being generous here is a wasted request.
// A clamp so a nonsense chunk index never becomes a WMS request. It has to
// cover the WHOLE built world or the world silently loses its photographs
// where the box ends: scripts/lib/world-area.mjs now reaches tx −24..32 and
// tz −6..21, i.e. x ∈ [−115 km, +158 km] and z ∈ [−29 km, +106 km], because
// the world runs from Prague to Zlín. The old +30 km eastern edge stopped
// halfway to Svitavy and would have left every kilometre past it — Olomouc,
// Přerov, Zlín — as flat colour. Kept a tile or two wider than the data on
// every side; ČÚZK serves the whole country, so the margin costs nothing.
const SANITY = { x0: -125000, x1: 168000, z0: -38000, z1: 115000 };

// Supertile (sx, sz) covers x ∈ [sx·T, (sx+1)·T), z ∈ [sz·T, (sz+1)·T) local
// meters. CRS:84 BBOX wants lonW,latS,lonE,latN — and because our z axis
// points SOUTH, the tile's smaller-z edge is its NORTH edge, i.e. the LARGER
// latitude: latN comes from sz·T, latS from (sz+1)·T. Get this backwards and
// every photo arrives mirrored top-to-bottom.
function tileUrl(sx, sz, px) {
  const T = ORTHO.tile;
  const lonW = ORIGIN.lon + (sx * T) / M_PER_LON;
  const lonE = ORIGIN.lon + ((sx + 1) * T) / M_PER_LON;
  const latN = ORIGIN.lat - (sz * T) / M_PER_LAT;
  const latS = ORIGIN.lat - ((sz + 1) * T) / M_PER_LAT;
  const bbox = [lonW, latS, lonE, latN].map((v) => v.toFixed(7)).join(',');
  return `${WMS}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=0&STYLES=&CRS=CRS:84`
    + `&BBOX=${bbox}&WIDTH=${px}&HEIGHT=${px}&FORMAT=image/jpeg`;
}

export function initOrtho(terrain = null) {
  const loader = new THREE.TextureLoader(); // default crossOrigin 'anonymous' — the WMS allows it
  const S = ORTHO.tile / CHUNK;             // chunks per supertile edge (480/120 = 4)

  // key "sx,sz" → { tex, mat }, or null once a fetch FAILED. Map iteration
  // order IS the LRU order: a touch deletes + re-inserts the entry, eviction
  // pops the head (the least recently requested tile).
  const tiles = new Map();
  let bytes = 0;                            // live texture bytes, tracked
  let fx = 0, fz = 0;                       // the focus the tiers are measured from

  function evict() {
    while (tiles.size > LRU_MAX || bytes > VRAM_MAX) {
      const [key, entry] = tiles.entries().next().value;
      tiles.delete(key);
      if (entry) { bytes -= entry.bytes; entry.mat.dispose(); entry.tex.dispose(); }
      if (!tiles.size) break;
    }
  }

  // How much detail this supertile deserves, from its distance to the focus.
  function pxFor(sx, sz) {
    const T = ORTHO.tile;
    const cx = (sx + 0.5) * T - fx, cz = (sz + 0.5) * T - fz;
    const d = Math.hypot(cx, cz);
    return d <= R_NEAR ? PX_NEAR : d <= R_MID ? PX_MID : PX_FAR;
  }

  // The coarse version of this supertile, if one is already loaded. Upgrading
  // detail used to REFRESH VISIBLY: the new entry began as a flat grey material
  // and the photo snapped in when the JPEG landed, so approaching anywhere made
  // the ground blink to grey and back. Handing the new entry the old texture as
  // a placeholder means the picture never leaves — it just gets sharper.
  function coarserTex(sx, sz, px) {
    for (const p of [PX_NEAR, PX_MID, PX_FAR]) {
      if (p === px) continue;
      const e = tiles.get(sx + ',' + sz + '@' + p);
      if (e && e.tex && e.mat.map) return e.tex;
    }
    return null;
  }

  function makeEntry(sx, sz, px) {
    const key = sx + ',' + sz + '@' + px;
    // The material starts WITHOUT its map, tinted the flat-ground color:
    // Lambert over a not-yet-loaded texture samples black, and black squares
    // chasing the car read broken. When the JPEG lands, the callback attaches
    // the map and resets the tint to white so the photo shows unfiltered;
    // needsUpdate recompiles the shader with the map define — once per
    // supertile, cheap. (Both callbacks fire async, so `entry` exists.)
    const stale = coarserTex(sx, sz, px);
    const mat = new THREE.MeshLambertMaterial(stale
      ? { map: stale, color: 0xffffff }          // wear the blurry one meanwhile
      : { color: COLORS.groundBase });
    const tex = loader.load(tileUrl(sx, sz, px),
      () => {
        if (tiles.get(key) !== entry) { tex.dispose(); return; } // evicted mid-flight
        mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true;
      },
      undefined,
      // The WMS reports its own failures as HTTP 200 + XML the image decoder
      // rejects, so onError covers server-side errors too, not just network
      // loss. Cache the null: chunks already holding this mat keep a correct
      // flat-colored quad, later chunks take the geometry fallback directly,
      // and the dead tile costs one request until the LRU forgets it.
      () => { if (tiles.get(key) === entry) tiles.set(key, null); });
    tex.colorSpace = THREE.SRGBColorSpace; // JPEGs are sRGB; skip this and the photo washes out
    // Trilinear mips stay ON (v2 disabled them): at 0.23 m/px the far ground
    // minifies ~10:1 and would boil with sparkle on every camera move. The
    // +33% VRAM is inside what the LRU cap already budgets for.
    tex.anisotropy = 4;                    // keeps far streets legible at grazing angles
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; // each chunk samples strictly its own tile
    const entry = { tex, mat, bytes: pxBytes(px) };
    tiles.set(key, entry);
    bytes += entry.bytes;
    evict();
    return entry;
  }

  // Ground quad for streaming chunk (cx, cz) — chunk GRID indices, not meters.
  function orthoGroundMesh(cx, cz) {
    // no fixed extent anymore (the world streams outward as tiles load), just
    // a sanity clamp so absurd indices never turn into WMS requests
    const wx = cx * CHUNK, wz = cz * CHUNK;
    if (wx < SANITY.x0 || wx > SANITY.x1 || wz < SANITY.z0 || wz > SANITY.z1) return null;
    const sx = Math.floor(cx / S), sz = Math.floor(cz / S);
    const px = pxFor(sx, sz), key = sx + ',' + sz + '@' + px;
    let entry = tiles.get(key);
    if (entry === undefined) entry = makeEntry(sx, sz, px); // ?? would re-fetch failed (null) tiles
    if (entry === null) return null;       // known-dead tile → flat-color fallback
    tiles.delete(key); tiles.set(key, entry); // LRU touch — move to the tail

    // UV window: the chunk sits at column lx, row lz inside its supertile
    // (both 0..S−1, counted from the tile's WEST and NORTH edges). u is easy:
    // lx/S → (lx+1)/S west→east. v needs care with signs: image row 0 is the
    // photo's TOP = latN = the SMALLEST z (our z axis points south), and
    // TextureLoader's default flipY puts that top row at v=1. PlaneGeometry's
    // v=1 edge is its local +y edge, which rotateX(−π/2) lands on world −z —
    // north again. North meets north with NO extra flip; the windowed v just
    // counts lz rows DOWN from 1: v ∈ [1−(lz+1)/S, 1−lz/S].
    const lx = cx - sx * S, lz = cz - sz * S;
    // Six segments a side, because the terrain samples are 20 m apart and a
    // chunk is 120 m: every vertex of this quad lands exactly on a height
    // sample, so the photo lies on the ground rather than near it, and two
    // neighbouring photos share their edge vertices and cannot crack apart.
    const SEG = 6;
    const geo = new THREE.PlaneGeometry(CHUNK, CHUNK, SEG, SEG);
    geo.rotateX(-Math.PI / 2);             // face up; local +y → world −z (north)
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++)
      uv.setXY(i, (lx + uv.getX(i)) / S, (S - 1 - lz + uv.getY(i)) / S);

    const mesh = new THREE.Mesh(geo, entry.mat);
    mesh.position.set(cx * CHUNK + CHUNK / 2, 0, cz * CHUNK + CHUNK / 2);
    // …and displace it. The quad is built around its own centre, so a vertex's
    // world position is its local one plus that centre.
    if (terrain) {
      const p = geo.attributes.position, a = p.array;
      const ox = mesh.position.x, oz = mesh.position.z;
      for (let i = 0; i < a.length; i += 3) a[i + 1] = terrain.heightAt(ox + a[i], oz + a[i + 2]);
      p.needsUpdate = true;
      geo.computeVertexNormals();
    }
    mesh.receiveShadow = true;             // buildings/trees drop real shadows onto the photo
    // Static: the quad never moves again on its own. It IS moved once, by
    // meshes.rebase(), which shifts a finished chunk into its own local frame —
    // and that pass knows to call updateMatrix() because of this flag.
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  // main.js calls this each frame with wherever the camera's attention is.
  // The tiers are measured from here, so the detail follows the player rather
  // than the world origin — which is the whole point.
  function setFocus(x, z) { fx = x; fz = z; }

  /**
   * Which detail tier chunk (cx, cz) would get RIGHT NOW. city.js compares this
   * to the tier a chunk was actually built with and rebuilds when they differ —
   * without that a chunk built while its supertile was far away kept the coarse
   * photograph for the rest of the session, however close you drove. That is
   * the "texture is not at full quality compared to its surroundings" seam:
   * two neighbouring supertiles, one upgraded because it happened to be rebuilt
   * for some other reason and one not.
   */
  function tierOf(cx, cz) {
    const S2 = ORTHO.tile / CHUNK;
    return pxFor(Math.floor(cx / S2), Math.floor(cz / S2));
  }

  return { orthoGroundMesh, setFocus, tierOf };
}
