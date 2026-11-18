import { branches } from './kolin-tracks.js';
import { track } from './prologue-track.js';

function makeRoute(track) {
  const distance = [0];
  for (let i = 1; i < track.length; i++) {
    distance.push(distance[i - 1] + Math.hypot(track[i][0] - track[i - 1][0], track[i][1] - track[i - 1][1]));
  }
  const lineLength = distance.at(-1);

  function railPose(metres) {
    let lo = 0,
      hi = track.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (metres < distance[mid]) hi = mid;
      else lo = mid;
    }
    const [ax, az] = track[lo],
      [bx, bz] = track[hi],
      length = distance[hi] - distance[lo];
    const c = (bx - ax) / length,
      s = (bz - az) / length;
    const offset = Math.min(length, Math.max(0, metres - distance[lo]));
    return { x: ax + c * offset, z: az + s * offset, c, s };
  }
  function nearestMetres(x, z) {
    let best = Infinity,
      metres = 0;
    for (let i = 1; i < track.length; i++) {
      const [ax, az] = track[i - 1],
        [bx, bz] = track[i];
      const length = distance[i] - distance[i - 1];
      const along = Math.max(0, Math.min(length, ((x - ax) * (bx - ax) + (z - az) * (bz - az)) / length));
      const d = Math.hypot(x - ax - ((bx - ax) * along) / length, z - az - ((bz - az) * along) / length);
      if (d < best) {
        best = d;
        metres = distance[i - 1] + along;
      }
    }
    return metres;
  }
  return { lineLength, railPose, nearestMetres };
}
const routes = new Map([[2, makeRoute(track)]]);
export function routeFor(platform) {
  if (!routes.has(platform) && branches[platform]) {
    const { prefix, join } = branches[platform];
    routes.set(platform, makeRoute([...prefix, ...track.slice(join)]));
  }
  return routes.get(platform) ?? routes.get(2);
}
export const { lineLength, railPose, nearestMetres } = routeFor(2);
export const localAt = (p, x, z) => ({
  u: (x - p.x) * p.c + (z - p.z) * p.s,
  v: (z - p.z) * p.c - (x - p.x) * p.s,
});
export const worldAt = (p, u, v) => ({ x: p.x + u * p.c - v * p.s, z: p.z + u * p.s + v * p.c });
