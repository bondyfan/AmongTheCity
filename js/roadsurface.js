// What is under the wheels: setts or not. The map tags the surface of a street
// (`s: 'cobble'` on a road, from OSM surface=sett / cobblestone), the renderer
// already paves it that way, and until now nothing could hear it. One question,
// asked a few times a second by js/caraudio.js: is this point on a drivable
// street laid in setts?

import { CHUNK } from './config.js';

// geo.js chunkKey(), spelled out: importing geo.js would pull the whole map
// loader into every test that touches the car audio
const chunkKey = (x, z) => Math.floor(x / CHUNK) + ',' + Math.floor(z / CHUNK);

const bbox = (r) => {
  if (r._sbb) return r._sbb;                    // city.js keeps the same cache
  let a = 1e9, b = 1e9, c = -1e9, d = -1e9;
  for (const [x, z] of r.p) { if (x < a) a = x; if (z < b) b = z; if (x > c) c = x; if (z > d) d = z; }
  return (r._sbb = [a, b, c, d]);
};

/** True when (x, z) is within the carriageway of polyline road r. */
function onRoad(r, x, z) {
  const half = (r.w ?? 6) / 2 + 0.6, p = r.p, h2 = half * half;
  for (let i = 0; i + 1 < p.length; i++) {
    const ax = p[i][0], az = p[i][1], dx = p[i + 1][0] - ax, dz = p[i + 1][1] - az;
    const L2 = dx * dx + dz * dz;
    let t = L2 > 0 ? ((x - ax) * dx + (z - az) * dz) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = x - ax - dx * t, ez = z - az - dz * t;
    if (ex * ex + ez * ez < h2) return true;
  }
  return false;
}

/** 1 on a sett street, 0 anywhere else (or where the map has not loaded). */
export function cobbleAt(city, x, z) {
  const cell = city?.chunkIndex?.get(chunkKey(x, z));
  if (!cell?.roads) return 0;
  for (const r of cell.roads) {
    if (r.s !== 'cobble' || !r.d || !r.p) continue;
    const bb = bbox(r), m = (r.w ?? 6) / 2 + 0.6;
    if (x < bb[0] - m || x > bb[2] + m || z < bb[1] - m || z > bb[3] + m) continue;
    if (onRoad(r, x, z)) return 1;
  }
  return 0;
}
