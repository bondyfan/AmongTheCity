import { chunkKey, distPointToSegment } from './geo.js';
import { railHeadOn, railHeadAt } from './trains.js';

// The height of the rail head under a point of the story train's route.
// Keeps the rail bed under the wheels even when a road passes overhead; a
// curve can cross several mapped ways without leaving the same cell.
export function railbed(world) {
  let last = null;
  const near = {};
  return function railHeight(x, z) {
    const rails = world.city.chunkIndex.get(chunkKey(x, z))?.rails;
    if (last && rails === last.rails) {
      const { a, b, way, start } = last;
      if (distPointToSegment(x, z, ...a, ...b, near) < 0.04)
        return railHeadOn(way, start + Math.hypot(near.x - a[0], near.z - a[1]), x, z);
    }
    for (const way of rails ?? []) {
      if (way.t !== 'rail') continue;
      let start = 0;
      for (let i = 1; i < way.p.length; i++) {
        const a = way.p[i - 1],
          b = way.p[i];
        if (distPointToSegment(x, z, ...a, ...b, near) < 0.04) {
          last = { rails, way, a, b, start };
          return railHeadOn(way, start + Math.hypot(near.x - a[0], near.z - a[1]), x, z);
        }
        start += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    }
    return railHeadAt(x, z);
  };
}
