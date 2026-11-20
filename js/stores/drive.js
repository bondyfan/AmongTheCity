// ---- stores/drive.js: where a restaurant's drive-through is ----
// WORKER SAFE, pure. OpenStreetMap maps the lane itself (in Pardubice the two
// ways round the McDonald's are even named "McDrive"), so nothing is invented:
// the lane is the one-way service road that hugs the building, the hand-out
// window is on the wall where the lane comes closest, and the order post
// stands on the lane some fifteen metres before it.
//
// The answer is remembered on the feature as a plain array (`_sd`), worked out
// on the main thread before a chunk's inputs are copied for the mesh worker
// (js/stores/landmark.js pinStores), so both builds stand the post in one place.

const LANE_NEAR = 8.5;        // m from a wall: further off it is somebody else's road
const ORDER_BACK = 15;        // m of lane between the order post and the window

function nearestOnRing(ring, x, z) {
  let best = Infinity, bx = 0, bz = 0, bi = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0], dz = b[1] - a[1], L2 = dx * dx + dz * dz;
    const t = L2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / L2)) : 0;
    const px = a[0] + dx * t, pz = a[1] + dz * t, d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bx = px; bz = pz; bi = i; }
  }
  return { d: best, x: bx, z: bz, i: bi };
}

const isLane = (r) => r.d === 1 && r.p?.length >= 2 && (r.t === 'service' || r.t === 'unclassified')
  && (r.ow === 1 || /drive/i.test(r.n ?? ''));

/**
 * driveOf(f, roads) -> null, or
 *   { wx, wz, mx, mz    the window: a point on the wall and the wall's outward normal
 *     px, pz            where a car stops for it, on the lane
 *     ox, oz, dx, dz    where a car stops to order, and the lane's direction there
 *     sx, sz }          which side of the lane the building is on (unit, toward it)
 */
export function driveOf(f, roads) {
  if (f._sd !== undefined) return unpack(f._sd);
  if (!roads) return null;                       // not decided yet: ask again with the cell
  let hit = null;
  for (const r of roads) {
    if (!isLane(r)) continue;
    // sample the way every 1.5 m
    let acc = 0;
    for (let k = 0; k + 1 < r.p.length; k++) {
      const a = r.p[k], b = r.p[k + 1], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(L / 1.5));
      for (let j = 0; j <= n; j++) {
        const t = j / n, x = a[0] + (b[0] - a[0]) * t, z = a[1] + (b[1] - a[1]) * t;
        const q = nearestOnRing(f.o, x, z);
        const named = /drive/i.test(r.n ?? '') ? 1.5 : 0;
        // a lane point 2.5 to 6 m from the wall with a good run of lane before it is a window
        const score = -Math.abs(q.d - 3.6) + named + Math.min(acc + L * t, ORDER_BACK) * 0.12;
        if (q.d < LANE_NEAR && (!hit || score > hit.score)) hit = { score, r, k, t, x, z, q, s: acc + L * t };
      }
      acc += L;
    }
  }
  if (!hit) { f._sd = 0; return null; }
  // walk back along the way for the order point (as far as the way goes)
  const { r } = hit;
  let back = Math.min(ORDER_BACK, hit.s - 1), k = hit.k, x = hit.x, z = hit.z;
  let dx = r.p[k + 1][0] - r.p[k][0], dz = r.p[k + 1][1] - r.p[k][1];
  while (back > 0 && k >= 0) {
    const a = r.p[k], L = Math.hypot(x - a[0], z - a[1]);
    dx = r.p[k + 1][0] - a[0]; dz = r.p[k + 1][1] - a[1];
    if (L >= back) { x += (a[0] - x) * back / L; z += (a[1] - z) * back / L; back = 0; }
    else { back -= L; x = a[0]; z = a[1]; k--; }
  }
  const dl = Math.hypot(dx, dz) || 1;
  const e = f.o, i = hit.q.i, a = e[i], b = e[(i + 1) % e.length];
  let mx = b[1] - a[1], mz = -(b[0] - a[0]);
  const ml = Math.hypot(mx, mz) || 1;
  mx /= ml; mz /= ml;
  if ((hit.x - hit.q.x) * mx + (hit.z - hit.q.z) * mz < 0) { mx = -mx; mz = -mz; }
  const R = (v) => Math.round(v * 100) / 100;
  f._sd = [R(hit.q.x), R(hit.q.z), R(mx), R(mz), R(hit.x), R(hit.z), R(x), R(z), R(dx / dl), R(dz / dl)];
  return unpack(f._sd);
}

function unpack(a) {
  if (!a) return null;
  const [wx, wz, mx, mz, px, pz, ox, oz, dx, dz] = a;
  // the building's side of the lane at the order point
  let sx = -dz, sz = dx;
  if ((wx - px) * sx + (wz - pz) * sz < 0) { sx = -sx; sz = -sz; }
  return { wx, wz, mx, mz, px, pz, ox, oz, dx, dz, sx, sz };
}
