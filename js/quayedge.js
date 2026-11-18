// ---- quayedge.js: the drawn ground at a stamp's hard edge ----
// Split out of js/terrainstamps.js (which keeps the stamps themselves and the
// heights they make): where a ground vertex near a Prague quay wall, ramp or
// stair side is drawn (quaySnap, used by js/quayground.js, meshes.js and
// ortho.js), and which ground belongs to the quays and the ways down to them
// (onQuay, stampShaped, used by city.js, geo.js and meshes.js).
// WORKER SAFE: plain arithmetic over the stamps.

import { STAMP_REGIONS, CELL, regionList, applyStamp } from './terrainstamps.js';
import { onWallFlight } from './quayflights.js';

// ---- the drawn ground at a hard edge ------------------------------------------
// The ground is drawn as triangles 4 to 6 m across (meshes.js terrainQuad, the
// carved ground and the fills, ortho.js), and a stamp's hard edge (a quay
// wall's face, a ramp's side) falls between their vertices: the triangles
// across it stood as a row of sloping wedges, up to 4 m out from the wall onto
// the quay, jagged where the mesh met the wall at an angle ("sails" along
// Dvořákovo nábřeží). So a vertex within reach of a hard edge of a stamp that
// asks for it (`snap`) is moved onto the edge, keeping the height of ITS OWN
// side: a triangle across the edge then stands up as a vertical face on the
// wall's line (where the retaining wall is drawn) instead of leaning out over
// the quay. js/quayground.js refines the coarser meshes near the edges first.
// A pure function of (x, z), so chunks either side of a border agree.
// m: a 4 m grid running at 45 degrees to a wall keeps its nearest vertex
// either side up to 2.83 m away (the diagonal's half), and a side whose
// nearest vertex was not moved leaned a wedge out from the wall again
export const SNAP = 2.9;
// m: on an UNrefined 4 m grid (the plain ground quad, the uncarved photo) the
// triangle across a wall can have its far corner a cell diagonal away, so
// there every vertex within one diagonal goes onto the wall's line
export const GRID_SNAP = 5.7;
const BACK_OFF = 0.15;        // m behind the face (a barrier is drawn 0.06 m thick)
const _hard = { d: 0, x: 0, z: 0, nx: 0, nz: 0, s: 0 };
// the nearest snapping hard edge within `reach` of (x, z) into _hard; false if none
function nearestHard(x, z, reach) {
  const R = STAMP_REGIONS[1];
  const b = R.box;
  if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) return false;
  const near = regionList(R, x, z);
  if (!near) return false;
  let bestD = reach, found = false;
  for (const st of near) {
    if (!st.hard.length || x < st.x0 || x > st.x1 || z < st.z0 || z > st.z1) continue;
    const gi = Math.floor((x - st.x0) / CELL), gj = Math.floor((z - st.z0) / CELL);
    const list = st.grid[gj * st.gw + gi];
    if (!list) continue;
    let best = Infinity, bk = -1, bt = 0, braw = 0;
    for (let q = 0; q < list.length; q++) {
      const k = list[q];
      const raw = ((x - st.sx[k]) * st.ex[k] + (z - st.sz[k]) * st.ez[k]) / (st.len[k] * st.len[k]);
      const t = raw < 0 ? 0 : raw > 1 ? 1 : raw;
      const d = Math.hypot(x - st.sx[k] - st.ex[k] * t, z - st.sz[k] - st.ez[k] * t);
      if (d < best) { best = d; bk = k; bt = t; braw = raw; }
    }
    // along a segment only: at a corner or past an end there is no single
    // direction to move in
    if (bk < 0 || braw < 0 || braw > 1) continue;
    const px = st.sx[bk] + st.ex[bk] * bt, pz = st.sz[bk] + st.ez[bk] * bt;
    const nx = st.nx[bk], nz = st.nz[bk];
    const sd = (x - px) * nx + (z - pz) * nz;
    for (const e of st.hard) {
      const off = Math.abs(sd - e);
      if (off >= bestD) continue;
      bestD = off; found = true;
      _hard.d = off; _hard.x = px + nx * e; _hard.z = pz + nz * e;
      _hard.nx = nx; _hard.nz = nz; _hard.s = sd >= e ? 1 : -1;
    }
  }
  return found;
}
/** Distance from (x, z) to the nearest snapping hard edge (Infinity past `reach`). */
export function hardEdgeDist(x, z, reach = 8) {
  return nearestHard(x, z, reach) ? _hard.d : Infinity;
}
/** The same, signed by the side of the edge (+ on its normal's side), NaN past `reach`. */
export function hardEdgeSide(x, z, reach = 8) {
  return nearestHard(x, z, reach) ? _hard.d * _hard.s : NaN;
}
const _snap = [0, 0, 0];
// The stone mesh carries the treads and both landings. On their river side
// the underlying photograph and paving must follow the lower quay. Lifting
// one ground vertex onto the stone and its neighbour onto the quay draws a
// textured triangle through the retaining wall at a landing corner.
export function quayGroundY(terrain, x, z) {
  const y = terrain.heightAt(x, z);
  if (!onWallFlight(x, z)) return y;
  const near = regionList(STAMP_REGIONS[1], x, z);
  if (near) for (const st of near) if (st.quayFloor) return applyStamp(st, x, z, y);
  return y;
}
/**
 * Where the ground vertex at (x, z) is drawn: null to leave it, or a shared
 * [x, y, z] (overwritten by the next call) on the nearest snapping hard edge,
 * at the height of the vertex's own side of it.
 */
export function quaySnap(terrain, x, z, reach = SNAP) {
  if (!nearestHard(x, z, reach)) return null;
  const { x: hx, z: hz, nx, nz, s } = _hard;
  const own = quayGroundY(terrain, hx + nx * 0.05 * s, hz + nz * 0.05 * s);
  const other = quayGroundY(terrain, hx - nx * 0.05 * s, hz - nz * 0.05 * s);
  // (no step worth the name: a raise against a higher street did nothing here)
  if (Math.abs(own - other) < 0.3) return null;
  // Both sides' vertices go to a line BACK_OFF behind the face, on the high
  // side: on the face itself the ground's vertical triangles shared a plane
  // with the retaining wall drawn there and fought it, a saw of light ground
  // through the grey stone; just behind it the wall hides them.
  const hi = own > other ? s : -s;
  _snap[0] = hx + nx * BACK_OFF * hi; _snap[1] = own; _snap[2] = hz + nz * BACK_OFF * hi;
  return _snap;
}

/**
 * Is the ground at (x, z) shaped by a stamp, so that nothing of the streets
 * around may stand on it: no embankment bank (meshes.clampUnderRoadsGen draws
 * none, city.heightAt offers none), no pavement verge or junction corner
 * reaching out over the wall, no pull lifting a footway toward the street?
 * On a Prague lower quay or a ramp or flight down to one, whatever the survey
 * under it (onQuay): where the survey already lay near the quay floor the dig
 * moved nothing, and the street's bank stood 2 m over the foot of the stairs
 * there all the same. Only there: "anywhere a stamp dug" also took the banks
 * off the Pardubice causeway over the chateau moat (2.3 m lower by the gate)
 * and the pavements off Rašínovo nábřeží where its bridgehead hump is dug,
 * whose streets are meant to keep them. (`terrain` is kept for the callers.)
 */
export function stampShaped(terrain, x, z) {
  return onQuay(x, z);
}
/** Inside the box of the Prague stamps (quays, ramps, stairs, Vyšehrad)? */
export function inPragueStamps(x, z) {
  const b = STAMP_REGIONS[1].box;
  return x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1;
}
/**
 * On a Prague lower quay, or on one of the ramps and stairs down to it: any of
 * those stamps has a say at (x, z) (it would move a sentinel height). Not the
 * Rašínovo bridgehead or Vyšehrad, whose streets keep their pavements.
 */
export function onQuay(x, z) {
  if (!inPragueStamps(x, z)) return false;
  const near = regionList(STAMP_REGIONS[1], x, z);
  if (!near) return false;
  for (let i = 0; i < near.length; i++) {
    const st = near[i];
    if (!st.quay || x < st.x0 || x > st.x1 || z < st.z0 || z > st.z1) continue;
    if (st.mode !== 'raise' && applyStamp(st, x, z, 1e4) < 1e4 - 0.01) return true;
    if (st.mode !== 'dig' && applyStamp(st, x, z, -1e4) > -1e4 + 0.01) return true;
  }
  return false;
}
