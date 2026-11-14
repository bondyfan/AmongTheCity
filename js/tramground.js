// ---- tramground.js: the height of the tram panel under a point of the rail -------
// A tram stands on the concrete panel js/meshes.js railWay lays along every
// tile rail with t === 'tram': LAYER_Y.road + 0.03 over the street deck the
// rail is set into (geo.railGradeY), or over the bridge deck on a bridge
// (geo.bridgeDeckHeight). The contact wire is drawn WIRE_H over that same
// level, so a tram stood here touches the wire with its pantograph. The route
// path IS the tile track (99 % of its vertices are rail vertices), so the
// rail feature under a path point is the one within a few centimetres of it.
// Where none is (a route leg that runs on a road feature), the walking
// surface there.

import { LAYER_Y } from './config.js';
import { chunkKey, bridgeDeckHeight, distPointToSegment, railGradeY } from './geo.js';

const TRAM_UP = 0.03;           // js/meshes.js railWay: the panel over the road deck
const ON_RAIL = 0.6;            // m: a path point this close to a rail feature is on it
const _c = { x: 0, z: 0, t: 0 };

/**
 * { groundY(x, z), loadedAt(x, z) } for js/trams.js, over the chunk index of
 * `city` and the terrain of `world`. `fallback(x, z)` (world.walkY) answers
 * where no tram rail is.
 */
export function tramGround(city, terrain, fallback = null) {
  const index = city?.chunkIndex;
  return {
    loadedAt: (x, z) => !!index?.has(chunkKey(x, z)),
    groundY(x, z) {
      const cell = index?.get(chunkKey(x, z));
      let best = null, bd = ON_RAIL;
      for (const r of cell?.rails ?? []) {
        if (r.t !== 'tram' || !r.p || r.p.length < 2) continue;
        let dist = 0;
        for (let i = 0; i < r.p.length - 1; i++) {
          const ax = r.p[i][0], az = r.p[i][1], bx = r.p[i + 1][0], bz = r.p[i + 1][1];
          const L = Math.hypot(bx - ax, bz - az);
          // (a cheap box test first: a rail feature is a few hundred metres)
          if (Math.min(ax, bx) - bd > x || Math.max(ax, bx) + bd < x || Math.min(az, bz) - bd > z || Math.max(az, bz) + bd < z) { dist += L; continue; }
          const d = distPointToSegment(x, z, ax, az, bx, bz, _c);
          if (d < bd) {
            bd = d;
            const along = dist + Math.hypot(_c.x - ax, _c.z - az);
            let y;
            if (r.br) y = bridgeDeckHeight(r, along, terrain);
            else {
              y = railGradeY(r, along, terrain);
              if (y === null || y === undefined) y = terrain?.heightAt(_c.x, _c.z) ?? 0;
            }
            best = y + LAYER_Y.road + TRAM_UP;
          }
          dist += L;
        }
      }
      if (best !== null && Number.isFinite(best)) return best;
      if (fallback) return fallback(x, z);
      return terrain?.heightAt(x, z) ?? 0;
    },
  };
}
