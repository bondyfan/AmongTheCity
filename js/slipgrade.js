// In a motorway gore, the two asphalt ribbons touch for dozens of metres
// before the slip centreline reaches the main carriageway. Level the whole
// shared surface, then taper back to the independent ramp profile.
import { CHUNK } from './config.js';
import { geomOf, nearestOnWay, pointOn } from './corridorgeom.js';
import { applyPins } from './corridorfit.js';
import { laneLayout } from './lanes.js';

export function fitSlip(way, profile, terrain, city, profileOf) {
  if (!profile || !city || way.t !== 'motorway_link' || way.br) return profile;
  const L = geomOf(way).L, width = laneLayout(way).ribbonHalf;
  const roads = new Set();
  for (const p of [way.p[0], way.p.at(-1)]) {
    const cx = Math.floor(p[0] / CHUNK), cz = Math.floor(p[1] / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const r of city.chunkIndex.get((cx + dx) + ',' + (cz + dz))?.roads ?? []) {
        if (r.t === 'motorway' && !r.br && (r.l ?? 0) === (way.l ?? 0)) roads.add(r);
      }
    }
  }
  // A ramp that merely passes another road on the map has no shared nose.
  const ends = [pointOn(way, 0), pointOn(way, L)];
  const connected = [...roads].filter(r => ends.some(p => {
    const q = nearestOnWay(r, p.x, p.z);
    // An acceleration lane can finish on the asphalt away from its centreline.
    return q.d < 1 || (q.d < laneLayout(r).ribbonHalf && q.tx * p.tx + q.tz * p.tz > 0.88);
  }));
  if (!connected.length) return profile;
  // A split in the main OSM way can lie inside the paved nose.
  const joints = new Set(connected.flatMap(r => [r.p[0].join(','), r.p.at(-1).join(',')]));
  const main = [...roads].filter(r => joints.has(r.p[0].join(',')) || joints.has(r.p.at(-1).join(',')))
    .sort((a, b) => a._id - b._id)
    .map(r => ({ r, reach: width + laneLayout(r).ribbonHalf, bb: geomOf(r).bb, profile: profileOf(r, terrain) }));
  const pins = [];
  let ready = profile.ready;
  for (let i = 0; i < profile.n; i++) {
    const s = i * profile.ds, p = pointOn(way, s * L / profile.total);
    let nearest = Infinity, target;
    for (const { r, reach, bb, profile: m } of main) {
      if (!m || p.x < bb[0] - reach || p.z < bb[1] - reach || p.x > bb[2] + reach || p.z > bb[3] + reach) continue;
      const q = nearestOnWay(r, p.x, p.z);
      if (q.d > reach || q.tx * p.tx + q.tz * p.tz < 0.8 || q.d > nearest) continue;
      const u = Math.min(m.n - 1, q.s / m.ds), j = Math.min(m.n - 2, Math.floor(u));
      target = m.y[j] + (m.y[j + 1] - m.y[j]) * (u - j);
      if (!m.ready) ready = false;
      nearest = q.d;
    }
    if (target !== undefined) pins.push({ s, d: target - profile.y[i] });
  }
  if (!pins.length) return profile;
  const y = Float32Array.from(profile.y);
  applyPins(y, profile.ds, pins, d => Math.max(40, Math.abs(d) / 0.04), 0);
  return { ...profile, y, ready };
}
