// ---- typologyshape.js: the footprint questions every typology rule asks ----
// Pure data (no three, no DOM), split out of typology.js (which re-exports
// shapeOf): the oriented box, the storey count, the roof tag and the 240 m
// neighbourhood hash that typologyOf, roofOf and the furniture all lean on.

import { polygonArea } from './geo.js';
import { rnd } from './typologycells.js';

// ---- footprint shape -------------------------------------------------------
// Oriented bounding box by the longest edge (interiors.frameOf's own rule), the
// fill ratio and whether the outline is a plain rectangle. Cached: plain data.
export function shapeOf(f) {
  if (f._shape) return f._shape;
  const ring = f.o;
  let best = 0, ux = 1, uz = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i], [bx, bz] = ring[(i + 1) % ring.length];
    const dx = bx - ax, dz = bz - az, L2 = dx * dx + dz * dz;
    if (L2 > best) { best = L2; const L = Math.sqrt(L2); ux = dx / L; uz = dz / L; }
  }
  const vx = uz, vz = -ux;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (const [x, z] of ring) {
    const pu = x * ux + z * uz, pv = x * vx + z * vz;
    if (pu < u0) u0 = pu; if (pu > u1) u1 = pu;
    if (pv < v0) v0 = pv; if (pv > v1) v1 = pv;
  }
  const L = u1 - u0, W = v1 - v0;
  const area = Math.abs(polygonArea(ring));
  const fill = L * W > 1e-6 ? area / (L * W) : 0;
  return (f._shape = {
    ux, uz, vx, vz, L, W, area, fill,
    cu: (u0 + u1) / 2, cv: (v0 + v1) / 2,
    long: Math.max(L, W), short: Math.min(L, W),
    rect: fill > 0.9 && ring.length <= 6,
  });
}

export const levelsOf = (f) => f.lv ?? Math.max(1, Math.round((f.h ?? 6) / 3.1));
export const pitchedTag = (f) => !!f.r && f.r !== 'flat';
// neighbourhoods are coherent: one 240 m block of town leans one way
export const zoneRnd = (f, salt) => {
  const p = f.o[0];
  return rnd((Math.floor(p[0] / 240) * 7919 + Math.floor(p[1] / 240) * 104729) | 0, salt);
};
