// ---- City data: loading, spatial index, geometry helpers ----
// Everything the game knows about Pardubice comes through here. loadCity()
// fetches the compact JSON the pipeline produced and buckets every feature
// into CHUNK-sized cells, so streaming, collision and traffic never scan the
// whole city. Pure math helpers (point-in-polygon, segment distance, bridge
// ramps) live here too — meshes, traffic and player all share one geometry
// truth.

import { CHUNK, BRIDGE_Y, BRIDGE_RAMP } from './config.js';

export const chunkKey = (x, z) => Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, z1] = pts[i], [x2, z2] = pts[(i + 1) % n];
    a += x1 * z2 - x2 * z1;
  }
  return a / 2;
}

export function pointInPolygon(x, z, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// distance from point to segment + the closest point (into out {x,z,t})
export function distPointToSegment(px, pz, ax, az, bx, bz, out) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const cx = ax + dx * t, cz = az + dz * t;
  if (out) { out.x = cx; out.z = cz; out.t = t; }
  return Math.hypot(px - cx, pz - cz);
}

// Bridge decks run FLAT at BRIDGE_Y — the river below them is what's sunken
// (WATER_Y), which is how real Pardubice bridges read. Only a short blend at
// each way end eases the curb-height step onto the approach street.
export function bridgeElevation(dist, totalLen) {
  const edge = Math.min(dist, totalLen - dist);
  return Math.max(0, Math.min(BRIDGE_Y, (edge / BRIDGE_RAMP) * BRIDGE_Y));
}

export function polylineLength(p) {
  let L = 0;
  for (let i = 0; i < p.length - 1; i++) L += Math.hypot(p[i + 1][0] - p[i][0], p[i + 1][1] - p[i][1]);
  return L;
}

// iterate chunk keys in a square radius around a world position
export function forEachChunkInRadius(x, z, r, fn) {
  const cx = Math.floor(x / CHUNK), cz = Math.floor(z / CHUNK);
  for (let dx = -r; dx <= r; dx++)
    for (let dz = -r; dz <= r; dz++) fn((cx + dx) + ',' + (cz + dz), cx + dx, cz + dz);
}

// feature bbox → every chunk cell it touches
function bucketize(index, list, kind) {
  for (const f of list) {
    const pts = f.o ?? f.p ?? (Array.isArray(f[0]) ? f : [f]);
    let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
    const ring = f.o ?? f.p ?? (typeof f[0] === 'number' ? [f] : f);
    for (const [x, z] of ring) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    f._home = chunkKey(ring[0][0], ring[0][1]); // rendered once, here
    for (let cx = Math.floor(minX / CHUNK); cx <= Math.floor(maxX / CHUNK); cx++)
      for (let cz = Math.floor(minZ / CHUNK); cz <= Math.floor(maxZ / CHUNK); cz++) {
        const key = cx + ',' + cz;
        let cell = index.get(key);
        if (!cell) index.set(key, cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
        cell[kind].push(f);
      }
  }
}

export async function loadCity(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`city data: HTTP ${res.status}`);
  const city = await res.json();
  let id = 1;
  for (const list of [city.buildings, city.roads, city.rails, city.water, city.green, city.paved])
    for (const f of list) f._id = id++;
  // trees are bare [x,z] pairs — wrap so they can carry _home/_id like the rest
  city.trees = city.trees.map(t => ({ p: [t], _id: id++ }));
  const index = new Map();
  bucketize(index, city.buildings, 'buildings');
  bucketize(index, city.roads, 'roads');
  bucketize(index, city.rails, 'rails');
  bucketize(index, city.water, 'water');
  bucketize(index, city.green, 'green');
  bucketize(index, city.paved, 'paved');
  bucketize(index, city.trees, 'trees');
  city.chunkIndex = index;
  // precompute road lengths once — bridges + traffic both need them
  for (const r of city.roads) r._len = polylineLength(r.p);
  return city;
}
