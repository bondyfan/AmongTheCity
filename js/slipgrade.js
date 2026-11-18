// In a motorway gore, the two asphalt ribbons touch for dozens of metres
// before the slip centreline reaches the main carriageway. Level the whole
// shared surface, then taper back to the independent ramp profile.
import { CHUNK } from './config.js';
import { geomOf, nearestOnWay, pointOn } from './corridorgeom.js';
import { applyPins } from './corridorfit.js';
import { laneLayout } from './lanes.js';

const RAMP_BANK_GRADE = 0.065;
const BANK_REACH = 900;

// Carry a motorway merge back through the short OSM pieces of an elevated
// ramp. Its nose may be tens of metres above the valley: fitting just the
// last piece makes the one before it climb the whole rise in 100 m.
function bankFromMerge(way, end, city, terrain, profileOf) {
  const queue = [{ p: way.p[end ? way.p.length - 1 : 0], d: 0 }];
  const seen = new Map();
  let floor = -Infinity, ready = true;
  for (let i = 0; i < queue.length; i++) {
    const { p, d } = queue[i], key = p.join(',');
    if ((seen.get(key) ?? Infinity) <= d) continue;
    seen.set(key, d);
    const cell = city.chunkIndex.get(Math.floor(p[0] / CHUNK) + ',' + Math.floor(p[1] / CHUNK));
    for (const r of cell?.roads ?? []) {
      if (r === way || !r.br || (r.t !== 'motorway' && r.t !== 'motorway_link')) continue;
      const last = r.p.length - 1;
      for (const j of [0, last]) {
        if (r.p[j][0] !== p[0] || r.p[j][1] !== p[1]) continue;
        if (r.t === 'motorway') {
          const m = profileOf(r, terrain);
          if (!m) continue;
          ready &&= m.ready;
          floor = Math.max(floor, m.y[j === 0 ? 0 : m.n - 1] - d * RAMP_BANK_GRADE);
        } else {
          const nd = d + geomOf(r).L;
          if (nd < BANK_REACH) queue.push({ p: r.p[j === 0 ? last : 0], d: nd });
        }
      }
    }
  }
  return { floor, ready };
}

export function fitSlip(way, profile, terrain, city, profileOf) {
  if (!profile || !city || way.t !== 'motorway_link') return profile;
  const L = geomOf(way).L, width = laneLayout(way).ribbonHalf;
  if (way.br) {
    const a = bankFromMerge(way, 0, city, terrain, profileOf);
    const b = bankFromMerge(way, 1, city, terrain, profileOf);
    if (Number.isFinite(a.floor) || Number.isFinite(b.floor)) {
      const y = Float32Array.from(profile.y);
      for (let i = 0; i < y.length; i++) {
        const s = i * profile.ds * L / profile.total;
        y[i] = Math.max(y[i], a.floor - RAMP_BANK_GRADE * s, b.floor - RAMP_BANK_GRADE * (L - s));
      }
      profile = { ...profile, y, ready: profile.ready && a.ready && b.ready };
    }
  }
  const roads = new Set();
  const noses = [pointOn(way, 0), pointOn(way, L)];
  for (const p of noses) p.layer = way.l ?? 0;
  // At a multi-level interchange the same ramp can be split at a layer
  // change shortly before its paved nose. Both pieces share that nose.
  if (way.br) {
    for (const { node } of way._pins ?? []) {
      if (node._ovl) continue;
      for (const arm of node.arms ?? []) {
        const r = arm.r;
        if (r === way || !r.br || r.t !== way.t || !arm.end || geomOf(r).L > 180) continue;
        const other = pointOn(r, arm.i === 0 ? geomOf(r).L : 0);
        other.layer = r.l ?? 0;
        noses.push(other);
      }
    }
  }
  for (const p of noses) {
    const cx = Math.floor(p.x / CHUNK), cz = Math.floor(p.z / CHUNK);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      for (const r of city.chunkIndex.get((cx + dx) + ',' + (cz + dz))?.roads ?? []) {
        if (r.t === 'motorway' && !!r.br === !!way.br && (way.br || (r.l ?? 0) === (way.l ?? 0))) roads.add(r);
      }
    }
  }
  // A ramp that merely passes another road on the map has no shared nose.
  const connected = [...roads].filter(r => noses.some(p => {
    const q = nearestOnWay(r, p.x, p.z);
    // A different layer can meet here only at an actual shared vertex.
    if (way.br && p.layer !== (r.l ?? 0))
      return [r.p[0], r.p.at(-1)].some(a => a[0] === p.x && a[1] === p.z);
    // An acceleration lane can finish on the asphalt away from its centreline.
    return q.d < 1 || (q.d < laneLayout(r).ribbonHalf && q.tx * p.tx + q.tz * p.tz > 0.88);
  }));
  if (!connected.length) return profile;
  // A split in the main OSM way can lie inside the paved nose.
  const joints = new Set(connected.flatMap(r => [r.p[0].join(','), r.p.at(-1).join(',')]));
  const main = [...roads].filter(r => joints.has(r.p[0].join(',')) || joints.has(r.p.at(-1).join(',')))
    .sort((a, b) => a._id - b._id)
    .map(r => ({ r, reach: width + laneLayout(r).ribbonHalf + (way.br ? 1.5 : 0), bb: geomOf(r).bb, profile: profileOf(r, terrain) }));
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
  // Keep a shared upstream joint at its established height if the ribbons
  // do not touch there. Otherwise an offset at the nose propagates through
  // the whole short span and leaves a step on the preceding ramp.
  if (way.br) {
    if (pins[0].s > 0) pins.unshift({ s: 0, d: 0 });
    if (pins.at(-1).s < profile.total - 1e-6) pins.push({ s: profile.total, d: 0 });
  }
  const y = Float32Array.from(profile.y);
  applyPins(y, profile.ds, pins, d => Math.max(40, Math.abs(d) / 0.04), 0);
  return { ...profile, y, ready };
}
