// A motorway noise wall follows its carriageway over an embankment or deck.
// A wall crossing the road below the bridge keeps its own ground height.
import { nearestOnWay } from './corridorgeom.js';
import { deckY } from './mwplan.js';

export const WALL_REACH = 16;

export function roadsideLevel(roads, x, z, tx, tz, terrain) {
  let best = WALL_REACH, support = null, station = 0;
  for (const road of roads ?? []) {
    if (road.t !== 'motorway' && road.t !== 'motorway_link') continue;
    const q = nearestOnWay(road, x, z);
    if (Math.abs(q.tx * tx + q.tz * tz) < 0.88 || q.d > best) continue;
    if (q.d === best && support && support._id < road._id) continue;
    support = road;
    best = q.d;
    station = q.s;
  }
  return support ? deckY(support, station, x, z, terrain) : terrain.heightAt(x, z);
}

// Include road cells on the far side of a cell boundary from the wall. The
// worker needs the same roads as the main-thread mesh even on long OSM ways.
export function wallRoadCells(wall, keys) {
  const p = wall.p, step = 20;
  for (let i = 1; i < p.length; i++) {
    const [x, z] = p[i - 1], dx = p[i][0] - x, dz = p[i][1] - z;
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / step));
    for (let k = 0; k <= n; k++) {
      const a = x + dx * k / n, b = z + dz * k / n, r = WALL_REACH + step / 2;
      for (let cx = Math.floor((a - r) / 120); cx <= Math.floor((a + r) / 120); cx++)
        for (let cz = Math.floor((b - r) / 120); cz <= Math.floor((b + r) / 120); cz++)
          keys.add(cx + ',' + cz);
    }
  }
  return keys;
}

export function wallRoads(city, wall) {
  const roads = new Set();
  for (const k of wallRoadCells(wall, new Set())) {
    for (const road of city.chunkIndex.get(k)?.roads ?? [])
      if (road.t === 'motorway' || road.t === 'motorway_link') roads.add(road);
  }
  return roads;
}
