// ---- forecourt.js: where a petrol station's pumps stand, for everyone ----
// Pure maths, no imports: the chunk mesher (main thread AND the mesh worker,
// js/meshes.js fuelInto), the pump in js/main.js (hold F), the fuel shop's
// food counter (js/pumps.js) and the tile hook (js/d11services.js) all ask
// this ONE module, so the pump you fill at is the pump that is drawn.
//
// WHY. A station is ONE amenity=fuel node in the tiles, and the forecourt
// drawn round it is not centred on it: fuelInto slides it back until it
// clears the kerb (up to 11.4 m on the D11, Osice eastbound), while the pump
// used to be "within 14 m of the node". A car at the far island of a shifted
// forecourt stood up to 17 m from the node, under the canopy, and was told
// there was no pump. Now both read the frame below.
//
// TWO KINDS OF FORECOURT.
//  - Built: no canopy in the map. The old rule, unchanged: face the nearest
//    drivable road of the chunk, slide off it to qw/2 + 12 m, a 22 x 16 m
//    apron, canopy, two islands across the road direction.
//  - Mapped: OSM has the canopy as a building=roof (the tiles keep it as
//    t 'roof'; every D11 station has one within 4 m of its node). The tile
//    hook (d11services.js liftCanopies) lifts that roof off the ground so it
//    reads and collides as a canopy, and hands the node `cv`, the roof's
//    frame: [cx, cz, lx, lz, LA, LB] = centre, unit direction the LANES run
//    (the islands lie along it), half-length along the lanes, half-width
//    across. The mesher then draws only islands, pumps and the fascia under
//    the real roof instead of a second canopy beside it.
//
// The frame is { x, z, lx, lz, cx, cz, LA, LB, mapped } with (lx, lz) along
// the lanes and (cx, cz) across them; a point is x + lx*a + cx*b.

/** How far a built forecourt stands off its road, past the half width. */
export const KERB_CLEAR = 12;
const SEARCH2 = 60 * 60;          // m^2: roads further than 60 m do not orient it

/**
 * The frame of the forecourt drawn for fuel poi `poi` ({ p: [x, z], cv? })
 * among `roads` (the chunk cell's roads: what fuelInto reads). Writes into
 * `out` when given. Pure: the same poi and roads give the same frame on every
 * thread.
 */
export function forecourtFrame(poi, roads, out = {}) {
  const cv = poi.cv;
  if (cv) {
    out.x = cv[0]; out.z = cv[1];
    out.lx = cv[2]; out.lz = cv[3];
    out.cx = -cv[3]; out.cz = cv[2];
    out.LA = cv[4]; out.LB = cv[5];
    out.mapped = true;
    return out;
  }
  let x = poi.p[0], z = poi.p[1];
  // the nearest drivable road (fuelInto's loop, verbatim in effect)
  let dx = 0, dz = -1, best = SEARCH2, qx = x, qz = z, qw = 0;
  for (const r of roads ?? []) {
    if (!r.d || !r.p) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const ax = r.p[i][0], az = r.p[i][1], bx = r.p[i + 1][0], bz = r.p[i + 1][1];
      const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
      let t = ((x - ax) * ex + (z - az) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (x - (ax + ex * t)) ** 2 + (z - (az + ez * t)) ** 2;
      if (d2 < best) {
        best = d2; const L = Math.sqrt(L2); dx = ex / L; dz = ez / L;
        qx = ax + ex * t; qz = az + ez * t; qw = r.w ?? 0;
      }
    }
  }
  const ux = -dz, uz = dx;                       // across the road
  const need = qw / 2 + KERB_CLEAR;
  const gap = Math.sqrt(best);
  const near = best < SEARCH2;
  const away = near && (x - qx) * ux + (z - qz) * uz < 0 ? -1 : 1;
  if (near && gap < need) {
    x += ux * (need - gap) * away;
    z += uz * (need - gap) * away;
  }
  // a built forecourt's islands run ACROSS the road it faces (u), so the
  // lanes are u and the road direction is across them
  out.x = x; out.z = z;
  out.lx = ux; out.lz = uz;
  out.cx = dx; out.cz = dz;
  out.LA = 11; out.LB = 8;                       // the apron, fuelInto's A and B
  out.mapped = false;
  // what the mesher's totem and local axes need of the road it faces
  out.rdx = dx; out.rdz = dz; out.qw = qw; out.need = need; out.gap = gap;
  out.near = near; out.away = away;
  return out;
}

/** Where the pump islands go in a frame: `across`, the island centres
 *  across the lanes; `half`, an island's half length along them; `pump`,
 *  each pump's offset from its island's middle. A built forecourt has its
 *  two islands; a mapped canopy gets one per 7.5 m of width (a lane, an
 *  island, a lane), one to five, spread evenly under it. */
export function islandsOf(f) {
  if (!f.mapped) return { across: BUILT_ISLANDS, half: 5.2, pump: 3.2 };
  const n = Math.max(1, Math.min(5, Math.round((2 * f.LB) / 7.5)));
  const step = (2 * f.LB) / n;
  const across = [];
  for (let k = 0; k < n; k++) across.push(Math.round(((k + 0.5) * step - f.LB) * 100) / 100);
  const half = Math.max(2.2, Math.min(5.2, f.LA * 0.62));
  return { across, half, pump: Math.min(3.2, half * 0.62) };
}
const BUILT_ISLANDS = Object.freeze([-2.6, 2.6]);

/**
 * Is (x, z) at this forecourt's pumps: inside its apron (built) or under its
 * roof (mapped), grown by `margin` metres? A car stopped at either island,
 * or in the lane beside it, is; the road outside is not (a built apron's
 * edge is 1 m past the kerb, so no margin across the road there).
 */
export function atForecourt(f, x, z, margin = 1.5) {
  const ox = x - f.x, oz = z - f.z;
  const a = ox * f.lx + oz * f.lz, b = ox * f.cx + oz * f.cz;
  const ma = f.mapped ? margin : 0;
  return Math.abs(a) <= f.LA + ma && Math.abs(b) <= f.LB + margin;
}

/** Squared distance from (x, z) to the frame centre. */
export function frameDist2(f, x, z) { return (x - f.x) ** 2 + (z - f.z) ** 2; }
