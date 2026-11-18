// Courtyards whose wings cannot carry two parallel ridge rings. Triangulate
// only the solid part of the footprint, then lift shared interior edge
// midpoints and triangle centres in proportion to their distance to an eave.
import { distPointToSegment, pointInPolygon, polygonArea } from './geo.js';
import { segDist } from './roofclear.js';

const MAX_VERTICES = 384;
const area = ring => Math.abs(polygonArea(ring));
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
function clean(ring) {
  return ring.filter((p, i) => !same(p, ring[(i + ring.length - 1) % ring.length]));
}

function sameRing(a, b) {
  if (a.length !== b.length) return false;
  const n = a.length, start = b.findIndex(p => same(p, a[0]));
  return start >= 0 && [1, -1].some(step =>
    a.every((p, i) => same(p, b[(start + step * i + n) % n])));
}

// Coordinates are stored to 0.1 m. At a shared wall that rounding can put a
// courtyard corner just beyond the street edge. Only snap within the point's
// rounding radius; let the topology checks reject deeper crossings.
function roundedCorner(p, outer, winding) {
  if (pointInPolygon(...p, outer)) return p;
  let best = 0.071, result = p;
  const projection = {};
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i], b = outer[(i + 1) % outer.length];
    const distance = distPointToSegment(...p, ...a, ...b, projection);
    if (distance > best) continue;
    const dx = b[0] - a[0], dz = b[1] - a[1], step = winding * 0.001 / Math.hypot(dx, dz);
    best = distance;
    result = [projection.x - dz * step, projection.z + dx * step];
  }
  return result;
}

function courtyardDomain(outline, yards) {
  const outer = clean(outline), raw = yards.map(clean);
  if (raw.reduce((n, r) => n + r.length, outer.length) > MAX_VERTICES) return null;
  const winding = Math.sign(polygonArea(outer));
  const holes = raw.filter((r, i) => !raw.slice(0, i).some(other => sameRing(r, other)))
    .map(r => r.map(p => roundedCorner(p, outer, winding)));
  const rings = [outer, ...holes];
  if (rings.some(r => r.length < 3 || area(r) < 0.01)) return null;
  const edges = rings.flatMap((r, index) => r.map((a, i) => ({
    a, b: r[(i + 1) % r.length], i, index, n: r.length
  })));
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    for (let j = i + 1; j < edges.length; j++) {
      const f = edges[j];
      if (e.index === f.index && (f.i === e.i + 1 || (e.i === 0 && f.i === e.n - 1))) continue;
      if (segDist(e.a, e.b, f.a, f.b) < 1e-6)
        return null;
    }
  }
  for (const h of holes) {
    if (!pointInPolygon(...h[0], outer)) return null;
    if (holes.some(other => h !== other && pointInPolygon(...h[0], other))) return null;
  }
  const solid = area(outer) - holes.reduce((sum, h) => sum + area(h), 0);
  return solid >= 0.01 ? { outer, holes, edges, solid } : null;
}

export function courtyardPitch(sink, outer, holes, topY, colour, pitch, maxRise, tri) {
  const plan = courtyardDomain(outer, holes);
  if (!plan) return 0;
  const points = plan.outer.concat(...plan.holes);
  let faces;
  try { faces = tri(plan.outer, plan.holes); } catch { return 0; }
  if (!faces?.length) return 0;
  // A partial ear clipping can return some triangles. Check its full area
  // before emitting anything, so a broken cap leaves the existing deck intact.
  const covered = faces.reduce((sum, f) => sum + area(f.map(i => points[i])), 0);
  if (Math.abs(covered - plan.solid) > Math.max(0.01, plan.solid * 1e-6)) return 0;

  let rise = 0;
  const lift = (x, z) => {
    let near = Infinity;
    for (const { a, b } of plan.edges) {
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / (dx * dx + dz * dz)));
      near = Math.min(near, (x - a[0] - t * dx) ** 2 + (z - a[1] - t * dz) ** 2);
    }
    const h = Math.min(maxRise, Math.sqrt(near) * pitch);
    rise = Math.max(rise, h);
    return [x, topY + h, z];
  };
  const corners = points.map(([x, z]) => [x, topY, z]), mids = new Map();
  const mid = (i, j) => {
    const key = Math.min(i, j) * points.length + Math.max(i, j);
    if (!mids.has(key)) mids.set(key, lift((points[i][0] + points[j][0]) / 2, (points[i][1] + points[j][1]) / 2));
    return mids.get(key);
  };
  for (const ids of faces) {
    const [a, b, c] = ids.map(i => points[i]);
    const centre = lift((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3);
    for (let k = 0; k < 3; k++) {
      const i = ids[k], j = ids[(k + 1) % 3], m = mid(i, j);
      sink.triFacing(...corners[i], ...m, ...centre, 0, 1, 0, ...colour);
      sink.triFacing(...m, ...corners[j], ...centre, 0, 1, 0, ...colour);
    }
  }
  return rise;
}
