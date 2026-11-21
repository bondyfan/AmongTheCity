// ---- stores/site.js: a store's own axes, its door and where its glass is ----
// WORKER SAFE: pure numbers. The chunk mesher (js/stores/build.js), the solids
// the player collides with, the interior and the people in it all read ONE
// answer from here, so the hole in the wall, the sliding door in it and the
// shopper walking through it cannot disagree.
//
// Everything is derived from the footprint ring OpenStreetMap drew and from the
// edge js/interiors.js entranceOf already picks as the street front (the same
// call the generic buildings make, on both threads, so the two builds agree).
// Local axes: u along the front, left to right seen from outside; v out through
// the front; the origin is the middle of the footprint's box in those axes.

import { entranceOf } from '../interiors.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** A stable integer for one store: its footprint's first corner, to the decimetre. */
export function storeKey(f) {
  const p = f.o[0];
  let h = (Math.round(p[0] * 10) * 73856093) ^ (Math.round(p[1] * 10) * 19349663);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 0..1 from a store key and a salt, the same on every machine. */
export function hashK(key, salt) {
  let h = (key ^ Math.imul(salt + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d) >>> 0; h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

const ringSign = (o) => {
  let a = 0;
  for (let i = 0, n = o.length; i < n; i++) {
    const p = o[i], q = o[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a > 0 ? 1 : -1;
};

/** How far the floor stands above the founding height (js/terrain.js groundFor):
 *  over the highest ground under the footprint, so no turf comes up through it. */
export const floorRel = (f) => clamp((f._gfall ?? 0) * 0.8, 0, 1.6) + 0.06;

/**
 * The paved apron in front of the doors: level with the shop floor at the wall
 * and down to the ground as it lies at its outer edge, so a store on a slope is
 * walked into up a ramp and not over a step. One answer for the mesh that draws
 * it (js/stores/dress.js) and for the feet that walk it (js/stores/world.js):
 * `relAt(x, z)` is the ground's height above the building's founding height.
 * Returns { u0, u1, d, y0, yL, yR } in the door's frame: flat y0 at v = 0,
 * yL / yR at the outer corners (v = d).
 */
export function apronOf(site, relAt) {
  const c = site.spots.canopy, fast = site.chain.kind === 'fast';
  const u0 = fast ? Math.max(site.uL, -9) : c.u0 - 0.4, u1 = fast ? Math.min(site.uR, 9) : c.u1 + 0.4;
  const y0 = Math.max(0.03, site.floor - 0.02);
  let d = fast ? 4.2 : c.d + 0.5;
  // a metre of rise wants five of ramp
  for (let i = 0; i < 2; i++) {
    const a = site.dw(u0, d), b = site.dw(u1, d);
    const rise = y0 - Math.min(relAt(a[0], a[1]), relAt(b[0], b[1]));
    d = Math.max(d, Math.min(9, rise * 5));
  }
  const a = site.dw(u0, d), b = site.dw(u1, d);
  return { u0, u1, d, y0, yL: Math.min(y0, relAt(a[0], a[1]) + 0.03), yR: Math.min(y0, relAt(b[0], b[1]) + 0.03) };
}
/** The apron's height above the founding height at door-frame (u, v), or null off it. */
export function apronY(ap, u, v) {
  if (u < ap.u0 || u > ap.u1 || v < -0.4 || v > ap.d) return null;
  const t = Math.max(0, v) / ap.d, e = ap.yL + (ap.yR - ap.yL) * (u - ap.u0) / (ap.u1 - ap.u0);
  return ap.y0 + (e - ap.y0) * t;
}

/**
 * makeSite(f, chain, ent) -> the store's frame and openings.
 *   ux,uz / nx,nz   unit axes in the world; ox,oz the origin
 *   hu, hv          half extents of the footprint in those axes
 *   edges[]         { i, a, b, len, mx, mz (outward), role }
 *   door            { x, z, w, edge, s0, s1 } on the front edge
 *   segs[]          every wall run: { a, b, len, mx, mz, role, kind, edge }
 *                   kind 'wall' | 'glass' | 'door'
 *   topAt(x, z)     wall and roof height there, metres above the ground
 *   glassTop        how high the glazing reaches (at the front line)
 */
export function makeSite(f, chain, front) {
  const ring = f.o, n = ring.length, A = chain.arch;
  const key = storeKey(f);
  const sgn = ringSign(ring);
  // the front: the edge that was picked, or the longest one
  let fi = front ?? -1;
  if (fi < 0 || fi >= n) {
    let best = -1;
    for (let i = 0; i < n; i++) {
      const p = ring[i], q = ring[(i + 1) % n], L = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (L > best) { best = L; fi = i; }
    }
  }
  const fa = ring[fi], fb = ring[(fi + 1) % n], fL = Math.hypot(fb[0] - fa[0], fb[1] - fa[1]) || 1;
  const nx = sgn * (fb[1] - fa[1]) / fL, nz = -sgn * (fb[0] - fa[0]) / fL;
  const ux = nz, uz = -nx;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ring) {
    const u = p[0] * ux + p[1] * uz, v = p[0] * nx + p[1] * nz;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2;
  const ox = cu * ux + cv * nx, oz = cu * uz + cv * nz;
  const hu = (u1 - u0) / 2, hv = (v1 - v0) / 2;
  const local = (x, z) => [(x - ox) * ux + (z - oz) * uz, (x - ox) * nx + (z - oz) * nz];
  const world = (u, v) => [ox + u * ux + v * nx, oz + u * uz + v * nz];

  const edges = [];
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1], len = Math.hypot(ex, ez);
    if (len < 0.02) continue;
    const mx = sgn * ez / len, mz = -sgn * ex / len;
    const d = mx * nx + mz * nz;
    const role = i === fi ? 'front' : d > 0.6 ? 'front' : d < -0.6 ? 'back' : (mx * ux + mz * uz > 0 ? 'right' : 'left');
    edges.push({ i, a, b, len, mx, mz, role });
  }
  const fe = edges.find((e) => e.i === fi) ?? edges[0];
  // u grows along the front edge or against it
  const along = ((fe.b[0] - fe.a[0]) * ux + (fe.b[1] - fe.a[1]) * uz) > 0 ? 1 : -1;

  // ---- the door, on the front edge ----
  const w = Math.max(1.6, Math.min(A.doorW, fe.len - 1.2));
  let sc = fe.len / 2;                       // metres from fe.a to the door's middle
  const atLow = hashK(key, 3) < 0.5;         // which corner a corner door takes
  if (A.door === 'corner' && fe.len > w + 9) {
    const off = clamp(fe.len * 0.12, w / 2 + 1.6, 7.5);
    sc = atLow ? off : fe.len - off;
  }
  const at = (e, s) => [e.a[0] + (e.b[0] - e.a[0]) * s / e.len, e.a[1] + (e.b[1] - e.a[1]) * s / e.len];
  const dc = at(fe, sc);
  const door = { x: dc[0], z: dc[1], w, edge: fe.i, s0: sc - w / 2, s1: sc + w / 2, sc };

  // ---- heights ----
  const hF = A.hF, hB = A.hB ?? A.hF;
  const topAt = (x, z) => {
    if (hF === hB) return hF;
    const v = (x - ox) * nx + (z - oz) * nz;
    return hB + (hF - hB) * clamp((v + hv) / Math.max(1, 2 * hv), 0, 1);
  };
  const glassTop = A.style === 'hall' ? hF - 1.15 : Math.min(hF - (A.bandH ?? 0) - 0.5, 3.6);

  // ---- wall runs: where each edge is wall, glass or the door ----
  const segs = [];
  const run = (e, s0, s1, kind) => {
    if (s1 - s0 < 0.05) return;
    segs.push({ a: at(e, s0), b: at(e, s1), len: s1 - s0, mx: e.mx, mz: e.mz, role: e.role, kind, edge: e.i });
  };
  for (const e of edges) {
    let g0 = 0, g1 = 0;                      // the glazed stretch of this edge
    if (e === fe) {
      const share = clamp(A.glassF, 0, 1) * e.len;
      if (A.style === 'hall') {
        // from the door's own corner along the car park, the far end closed
        const lowEnd = sc < e.len / 2;
        g0 = lowEnd ? 0.6 : e.len - 0.6 - share * 0.98;
        g1 = lowEnd ? 0.6 + share * 0.98 : e.len - 0.6;
        if (share >= e.len - 1) { g0 = 0.6; g1 = e.len - 0.6; }
      } else {
        g0 = clamp(sc - share / 2, 0.6, e.len - 0.6 - share);
        g1 = g0 + share;
      }
      g0 = clamp(g0, 0.4, e.len - 0.4); g1 = clamp(g1, g0, e.len - 0.4);
      g0 = Math.min(g0, door.s0); g1 = Math.max(g1, door.s1);
      run(e, 0, g0, 'wall');
      run(e, g0, door.s0, 'glass');
      run(e, door.s0, door.s1, 'door');
      run(e, door.s1, g1, 'glass');
      run(e, g1, e.len, 'wall');
      continue;
    }
    // a showroom is glass on every side a passer-by can look in from
    if (A.glassAll && e.role !== 'back' && e.len > 3.2) {
      const m = Math.min(0.6, e.len * 0.12);
      run(e, 0, m, 'wall'); run(e, m, e.len - m, 'glass'); run(e, e.len - m, e.len, 'wall');
      continue;
    }
    // a side wall is glazed from the front corner back, on the side the door is nearer to
    if ((e.role === 'left' || e.role === 'right') && (A.glassS ?? 0) > 0 && e.len > 6) {
      const doorSide = (sc < fe.len / 2 ? -1 : 1) * along < 0 ? 'left' : 'right';
      if (A.style === 'pavilion' || e.role === doorSide) {
        const share = A.glassS * e.len;
        // which end of this edge touches the front line
        const va = local(e.a[0], e.a[1])[1], vb = local(e.b[0], e.b[1])[1];
        if (Math.max(va, vb) > hv - 2.5) {
          if (va > vb) { run(e, 0, 0.6, 'wall'); run(e, 0.6, 0.6 + share, 'glass'); run(e, 0.6 + share, e.len, 'wall'); }
          else { run(e, 0, e.len - 0.6 - share, 'wall'); run(e, e.len - 0.6 - share, e.len - 0.6, 'glass'); run(e, e.len - 0.6, e.len, 'wall'); }
          continue;
        }
      }
    }
    run(e, 0, e.len, 'wall');
  }
  // ---- the door's own frame: u along the front from the door's middle, v out ----
  const uL = -(along > 0 ? sc : fe.len - sc), uR = along > 0 ? fe.len - sc : sc;
  const dw = (u, v) => [door.x + u * ux + v * nx, door.z + u * uz + v * nz];
  // the side of the door with more front to it: where the trolleys stand
  const side = uR >= -uL ? 1 : -1;
  const site = { key, chain, ring, sgn, ux, uz, nx, nz, ox, oz, hu, hv, edges, front: fe, along, door, segs,
    hF, hB, topAt, glassTop, local, world, dw, uL, uR, side,
    // read live: the fall across the footprint is only known once its height map has arrived
    get floor() { return floorRel(f); } };
  site.spots = spotsOf(site);
  return site;
}

/**
 * Where the things outside the door stand, in the door's frame (u along the
 * front, v out from the wall): one answer for the mesh that draws them and for
 * the runtime that lets the player use them.
 *   bay      the trolley bay, or null when the front is too short for one
 *   canopy   the roof over the door { u0, u1, d, y }
 *   totem    the pylon's foot, hours the board beside the door
 */
export function spotsOf(site) {
  const A = site.chain.arch, w = site.door.w, s = site.side;
  const room = s > 0 ? site.uR : -site.uL;        // front left on the trolley side
  const fast = site.chain.kind === 'fast';
  // (trolleys are a grocer's: a restaurant and a showroom have none)
  const bayLen = fast || site.chain.kind === 'showroom' ? 0 : Math.min(6.5, room - w / 2 - 1.6);
  const b0 = w / 2 + 1.1;
  const bay = bayLen >= 2.4 ? { u0: s > 0 ? b0 : -(b0 + bayLen), u1: s > 0 ? b0 + bayLen : -b0, v0: 0.5, v1: 2.5 } : null;
  let canopy;
  if (A.style === 'hall') {
    const far = bay ? b0 + bayLen + 0.6 : w / 2 + 1.4, near = Math.min(w / 2 + 1.4, (s > 0 ? -site.uL : site.uR));
    canopy = { u0: s > 0 ? -near : -far, u1: s > 0 ? far : near, d: 3.7, y: 3.45 };
  } else if (fast) canopy = { u0: -w / 2 - 0.7, u1: w / 2 + 0.7, d: 1.5, y: 2.85 };
  else canopy = { u0: -w / 2 - 2.2, u1: w / 2 + 2.2, d: 2.9, y: 3.2 };
  // the pylon stands off the corner the door is further from
  const far = -site.uL > site.uR ? site.uL - 2.2 : site.uR + 2.2;
  return { bay, canopy, totem: { u: far, v: 2.4 }, hours: { u: -s * (w / 2 + 0.6) }, side: s };
}

// ---- which wall is the front ----------------------------------------------
// A generic house fronts the nearest pavement (interiors.entranceOf). A store
// fronts its CAR PARK: the Lidl by Pardubice station has a service lane three
// metres off its east gable and its car park along the whole south side, and
// the first rule put the doors in the gable. So an edge scores by the parking
// it looks at (the mapped amenity=parking polygons, weighed by size and by how
// squarely the wall faces them), by its length, and by not having a neighbour
// standing in front of it. The pavement rule's answer is the tie-break.

let city = null;
/** The main thread hands the city over: a store then sees the cells round its own. */
export function setStoreCity(c) { city = c; }

/** The roads, parking and buildings round a store: its own cell and, on the main thread, the eight about it. */
export function around(f, cell) {
  if (!city?.chunkIndex || typeof f._home !== 'string') return cell ?? null;
  const k = f._home.indexOf(','), cx = +f._home.slice(0, k), cz = +f._home.slice(k + 1);
  const roads = new Set(), paved = new Set(), buildings = new Set();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const c = city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
    if (!c) continue;
    for (const r of c.roads ?? []) roads.add(r);
    for (const g of c.paved ?? []) paved.add(g);
    for (const b of c.buildings ?? []) buildings.add(b);
  }
  return { roads: [...roads], paved: [...paved], buildings: [...buildings] };
}

/** The index of the ring edge a store's doors are in. Exported for the tests. */
export function pickFront(f, chain, src) {
  const ring = f.o, n = ring.length, sgn = ringSign(ring);
  const ent = entranceOf(f, src?.roads, src?.buildings);
  const lots = [];
  for (const g of src?.paved ?? []) {
    if (g.t !== 'parking' || !g.o || g.o.length < 3) continue;
    let a = 0, cx = 0, cz = 0;
    for (let i = 0; i < g.o.length; i++) {
      const p = g.o[i], q = g.o[(i + 1) % g.o.length], c = p[0] * q[1] - q[0] * p[1];
      a += c; cx += (p[0] + q[0]) * c; cz += (p[1] + q[1]) * c;
    }
    if (Math.abs(a) < 60) continue;
    lots.push({ x: cx / (3 * a), z: cz / (3 * a), area: Math.abs(a / 2) });
  }
  const longK = chain.arch.style === 'hall' ? 0.4 : 0.2;
  let best = ent?.i ?? 0, bestS = -Infinity;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ex = b[0] - a[0], ez = b[1] - a[1], L = Math.hypot(ex, ez);
    if (L < Math.max(6, chain.arch.doorW + 2)) continue;
    const mx = sgn * ez / L, mz = -sgn * ex / L;
    const px = (a[0] + b[0]) / 2, pz = (a[1] + b[1]) / 2;
    let s = Math.min(L, 60) * longK + (i === ent?.i ? 5 : 0);
    for (const g of lots) {
      const dx = g.x - px, dz = g.z - pz, d = Math.hypot(dx, dz);
      if (d > 120) continue;
      const facing = (dx * mx + dz * mz) / (d || 1);
      if (facing > 0.2) s += Math.min(g.area, 3000) / 100 * facing * (1 - d / 130);
    }
    // a neighbour five metres in front of the wall: no car park there, no doors
    for (const o of src?.buildings ?? []) {
      if (o === f || !o.o || o.o.length < 3 || (o.y ?? 0) > 0.5) continue;
      if (inRing(o.o, px + mx * 5, pz + mz * 5)) { s -= 200; break; }
    }
    if (s > bestS + 1e-9) { bestS = s; best = i; }
  }
  return best;
}

const _sites = new WeakMap();
/**
 * The site of a store building, remembered per feature object on this thread.
 * Which wall is the front is a plain memo on the feature (`_sf`): the main
 * thread decides it (js/stores/landmark.js pinStores, before a chunk's inputs
 * are copied) and the mesh worker reads it, so the two builds agree.
 */
export function siteOf(f, chain, cell) {
  let s = _sites.get(f);
  if (!s) {
    if (f._sf === undefined) {
      const src = around(f, cell);
      // with nothing to go by (a test, a fixture with no cell) the answer is not kept
      if (!src) return makeSite(f, chain, -1);
      f._sf = pickFront(f, chain, src);
    }
    s = makeSite(f, chain, f._sf);
    _sites.set(f, s);
  }
  return s;
}

/** Is (x, z) inside the footprint ring? */
export function inRing(o, x, z) {
  let inside = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const a = o[i], b = o[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/**
 * The largest rectangle in the site's own axes that lies inside the footprint,
 * pulled in by `m` metres: the room the fixtures are laid out in. An L-shaped
 * footprint gives its bigger leg. { u0, u1, v0, v1 } in local metres.
 */
export function shopRect(site, m = 0.5) {
  // remembered per margin: the roof plant asks with 1.5 and the floor with 0.45, and whichever
  // came first used to answer for both (a chunk built on the main thread shrank its own shop floor)
  const memo = (site._rects ??= new Map());
  if (memo.has(m)) return memo.get(m);
  const us = new Set(), vs = new Set();
  for (const p of site.ring) {
    const [u, v] = site.local(p[0], p[1]);
    us.add(Math.round(u * 10) / 10); vs.add(Math.round(v * 10) / 10);
  }
  // (a footprint of forty corners has forty of each: every other one is enough)
  const thin = (a) => { while (a.length > 14) a = a.filter((_, i) => i % 2 === 0 || i === a.length - 1); return a; };
  const U = thin([...us].sort((a, b) => a - b)), V = thin([...vs].sort((a, b) => a - b));
  const inside = (u, v) => { const [x, z] = site.world(u, v); return inRing(site.ring, x, z); };
  const ok = (a0, a1, b0, b1) => {
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++)
      if (!inside(a0 + (a1 - a0) * i / 4, b0 + (b1 - b0) * j / 4)) return false;
    return true;
  };
  let best = null, area = 0;
  for (let i = 0; i < U.length; i++) for (let j = i + 1; j < U.length; j++) {
    const a0 = U[i] + m, a1 = U[j] - m;
    if (a1 - a0 < 4) continue;
    for (let k = 0; k < V.length; k++) for (let l = k + 1; l < V.length; l++) {
      const b0 = V[k] + m, b1 = V[l] - m;
      if (b1 - b0 < 4) continue;
      const ar = (a1 - a0) * (b1 - b0);
      if (ar > area && ok(a0, a1, b0, b1)) { area = ar; best = { u0: a0, u1: a1, v0: b0, v1: b1 }; }
    }
  }
  // a ring with no rectangle to speak of (a wedge): a box about its middle
  best ??= { u0: -site.hu * 0.4, u1: site.hu * 0.4, v0: -site.hv * 0.4, v1: site.hv * 0.4 };
  memo.set(m, best);
  return best;
}
