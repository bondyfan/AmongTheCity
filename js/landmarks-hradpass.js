// ---- landmarks-hradpass.js: the passages through the wings of Prague Castle ----
// WORKER SAFE (js/landmarks-hrad.js builds the castle on both threads).
//
// The 2nd courtyard is closed on every side by Pacassi's wings, and the ways
// out of it are vaulted passages straight through them. The tile knows each
// one only by its two mouths: the footways stop on a vertex (or a short edge)
// of the outer ring and start again on a vertex of the courtyard hole, so a
// passage is found by those vertices and is built only when they are there.
//
//   matyas  the Matthias Gate (1614), from the 1st courtyard (the old way in)
//   treti   east, to the 3rd courtyard, opening on St Vitus's west front
//   sever   north, to the Powder Bridge over the Stag Moat
//   jih     south-west, out to the Garden on the Bastion
//
// A wall that crosses a passage is cut along the passage's own arch (the
// lateral offset of every point of the wall decides how high the opening is
// there), and the vault is drawn between the two walls as they actually run,
// so an oblique or jagged facade meets its vault without a seam or a stub.
// Collision (passSolids) cuts the same channels out of the footprint.

import { Frame } from './landmarksframe.js';

/**
 * out / in: the mouth vertices on the outer ring and on the courtyard hole
 * (one vertex, or the two ends of a short edge); w, h: clear width and crown
 * height over the floor; cw: the width collision opens, where it is not w
 * (the tile ends both footways of the east passage on the corners of a 5.7 m
 * mouth, and a walker must reach them); floor: the ground at the passage's
 * middle, absolute (measured, js/terrain.js; collision only, the model asks
 * the terrain).
 */
export const PASSAGES = [
  { id: 'matyas', out: [[-97278.3, -6520.2]], in: [[-97264.1, -6527.9]], w: 4.6, h: 7.2, floor: 257.2 },
  { id: 'treti', out: [[-97195.5, -6547.2], [-97197.7, -6552.5]], in: [[-97218.0, -6545.0], [-97216.0, -6539.7]], w: 5.4, h: 6.8, cw: 6.8, floor: 257.26 },
  { id: 'sever', out: [[-97251.6, -6592.8]], in: [[-97245.8, -6564.4]], w: 4.4, h: 6.2, floor: 255.7 },
  { id: 'jih', out: [[-97251.3, -6471.8]], in: [[-97240.3, -6477.9]], w: 3.6, h: 4.8, floor: 257.38 },
];

const nearest = (ring, p) => {
  let best = -1, bd = 2.5;
  for (let i = 0; i < ring.length; i++) {
    const d = Math.hypot(ring[i][0] - p[0], ring[i][1] - p[1]);
    if (d < bd) { bd = d; best = i; }
  }
  return best;
};

/**
 * The passages this footprint has: each with its frame G (v along it, + out
 * of the courtyard), half its length, half its width, the indices of its
 * mouth vertices (mo on the outer ring, mh on hole `hole`).
 */
export function passages(kit, f) {
  const out = [];
  for (const p of PASSAGES) {
    const mo = p.out.map((q) => nearest(f.o, q));
    if (mo.some((i) => i < 0)) continue;
    let hole = -1, mh = null;
    (f.i ?? []).forEach((h, k) => { const ix = p.in.map((q) => nearest(h, q)); if (ix.every((i) => i >= 0)) { hole = k; mh = ix; } });
    if (hole < 0) continue;
    const avg = (ring, ix) => [ix.reduce((s, i) => s + ring[i][0], 0) / ix.length, ix.reduce((s, i) => s + ring[i][1], 0) / ix.length];
    const A = avg(f.o, mo), B = avg(f.i[hole], mh);
    const G = new Frame(kit, (A[0] + B[0]) / 2, (A[1] + B[1]) / 2, A[0] - B[0], A[1] - B[1]);
    out.push({ p, G, half: Math.hypot(A[0] - B[0], A[1] - B[1]) / 2, hw: p.w / 2, mo, hole, mh });
  }
  return out;
}

/**
 * Where the wall a->b (world [x,z]) crosses a passage near one of its mouths:
 * [{ t0, t1, q }] in metres along the edge, sorted. A crossing farther along
 * the passage's line than its mouths (the far side of the courtyard) is not one.
 */
export function cutsOf(a, b, list) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const out = [];
  for (const q of list) {
    const [ua, va] = q.G.local(a[0], a[1]), [ub, vb] = q.G.local(b[0], b[1]);
    let t0, t1;
    if (Math.abs(ub - ua) < 1e-6) {
      if (Math.abs(ua) >= q.hw) continue;
      t0 = 0; t1 = L;
    } else {
      const s0 = (-q.hw - ua) / (ub - ua) * L, s1 = (q.hw - ua) / (ub - ua) * L;
      t0 = Math.max(0, Math.min(s0, s1)); t1 = Math.min(L, Math.max(s0, s1));
    }
    if (t1 - t0 < 0.02) continue;
    const vm = va + (vb - va) * ((t0 + t1) / 2) / L;
    if (Math.abs(vm) > q.half + 2.5) continue;
    out.push({ t0, t1, q });
  }
  return out.sort((x, y) => x.t0 - y.t0);
}

// The vault's half circle as the chords it is drawn with (vault below); the
// opening in a wall follows the same chords, or the round cut stood above the
// polygon vault and showed the sky through the hollow wing between them.
const SEG = 6;
/** How high the opening reaches at lateral offset u (relative to the kit's ground; -Infinity outside it). */
function archY(q, y0, u) {
  const r = q.hw;
  // cutWall only asks inside a cut, whose ends lie ON the jambs (|u| = r up
  // to rounding): there the opening reaches the springing. Read as outside,
  // a jamb sample dropped to the floor and left a sloped sliver of wall
  // standing in the opening (the Matthias Gate and the east passage).
  if (Math.abs(u) >= r + 1e-3) return -Infinity;
  u = Math.max(-r, Math.min(r, u));
  const a = Math.acos(Math.max(-1, Math.min(1, -u / r))), k = Math.min(SEG - 1, Math.floor(a / Math.PI * SEG));
  const a0 = k / SEG * Math.PI, a1 = (k + 1) / SEG * Math.PI;
  const u0 = -Math.cos(a0) * r, u1 = -Math.cos(a1) * r, t = (u - u0) / (u1 - u0);
  return y0 + q.p.h - r + (Math.sin(a0) + (Math.sin(a1) - Math.sin(a0)) * t) * r;
}

/**
 * The wall a->b from y0 to E with its passage openings: plain wall (or the
 * `grid` of windows) between the openings, and over each opening the wall
 * down to the arch. `body(p, q, yy)` draws one uncut piece.
 */
export function cutWall(kit, a, b, y0, E, nx, nz, cuts, body) {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
  const at = (t) => [a[0] + dx * t, a[1] + dz * t];
  let t = 0;
  for (const c of cuts) {
    if (c.t0 - t > 0.05) body(at(t), at(c.t0), y0);
    const fy = kit.rel(c.q.G.ox, c.q.G.oz);
    const N = 12;
    for (let k = 0; k < N; k++) {
      const e0 = c.t0 + (c.t1 - c.t0) * k / N, e1 = c.t0 + (c.t1 - c.t0) * (k + 1) / N;
      const p0 = at(e0), p1 = at(e1);
      const y0a = Math.max(y0, archY(c.q, fy, c.q.G.local(p0[0], p0[1])[0]));
      const y1a = Math.max(y0, archY(c.q, fy, c.q.G.local(p1[0], p1[1])[0]));
      if (Math.min(y0a, y1a) >= E) continue;
      kit.quad([p0[0], y0a, p0[1]], [p1[0], y1a, p1[1]], [p1[0], E, p1[1]], [p0[0], E, p0[1]], nx, 0, nz);
    }
    t = Math.max(t, c.t1);
  }
  if (L - t > 0.05) body(at(t), b, y0);
}

/**
 * Where the line u = const of a passage meets a ring near one mouth (v nearest
 * `vWant`), or vWant itself when it does not (a mouth vertex that is a corner).
 */
function meet(G, ring, u, vWant) {
  let best = vWant, bd = 6;
  for (let i = 0; i < ring.length; i++) {
    const [ua, va] = G.local(ring[i][0], ring[i][1]);
    const j = (i + 1) % ring.length;
    const [ub, vb] = G.local(ring[j][0], ring[j][1]);
    if ((ua - u) * (ub - u) > 0 || Math.abs(ub - ua) < 1e-9) continue;
    const v = va + (vb - va) * (u - ua) / (ub - ua);
    if (Math.abs(v - vWant) < bd) { bd = Math.abs(v - vWant); best = v; }
  }
  return best;
}

/**
 * The vault of one passage, its two side walls and (optionally) a paved
 * floor, each running from the courtyard wall to the outer wall as those
 * walls actually stand at that lateral offset; `floorHex` paves it. The side walls reach 1.5 m
 * under the floor so a sloping passage (the north one falls 1.4 m) never
 * shows daylight under them.
 */
export function vault(kit, f, q, floorHex = 0) {
  const { G, hw, half, hole } = q;
  const y0 = kit.rel(G.ox, G.oz), H = q.p.h;
  const vOut = (u) => meet(G, f.o, u, half) + 0.05, vIn = (u) => meet(G, f.i[hole], u, -half) - 0.05;
  const N = SEG, prof = [];
  for (let k = 0; k <= N; k++) {
    const a = k / N * Math.PI;
    prof.push([-Math.cos(a) * hw, y0 + H - hw + Math.sin(a) * hw]);
  }
  const P = (u, v, y) => { const [x, z] = G.xz(u, v); return [x, y, z]; };
  for (const s of [-1, 1]) {
    const u = s * hw, v0 = vIn(u), v1 = vOut(u), [lx, lz] = G.dir(-s, 0);
    kit.quad(P(u, v0, y0 - 1.5), P(u, v1, y0 - 1.5), P(u, v1, y0 + H - hw), P(u, v0, y0 + H - hw), lx, 0, lz);
  }
  for (let k = 0; k < N; k++) {
    const [u0, y0k] = prof[k], [u1, y1k] = prof[k + 1];
    const um = (u0 + u1) / 2, [ix, iz] = G.dir(-um / hw, 0);
    kit.quad(P(u0, vIn(u0), y0k), P(u0, vOut(u0), y0k), P(u1, vOut(u1), y1k), P(u1, vIn(u1), y1k), ix * 0.5, -1, iz * 0.5);
  }
  if (floorHex) {
    kit.set(floorHex, kit.k * 16);
    const vi = Math.max(vIn(-hw), vIn(hw)), vo = Math.min(vOut(-hw), vOut(hw));
    kit.quad(P(-hw, vi, y0 + 0.05), P(hw, vi, y0 + 0.05), P(hw, vo, y0 + 0.05), P(-hw, vo, y0 + 0.05), 0, 1, 0);
  }
}

/** Signed area. */
const area2 = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/**
 * Cut the channel of passage q (|u| < hw) out of a simple ring that it
 * crosses once from side to side: the two pieces either side of it, or null
 * when the ring is not crossed that way (then it is left whole).
 */
function split(ring, q) {
  const { G, hw, half } = q;
  const L = ring.map((p) => G.local(p[0], p[1]));
  const sideOf = (s) => {
    const hits = [];
    for (let i = 0; i < ring.length; i++) {
      const j = (i + 1) % ring.length, [ua, va] = L[i], [ub, vb] = L[j];
      if ((ua - s) * (ub - s) >= 0) continue;
      const t = (s - ua) / (ub - ua), v = va + (vb - va) * t;
      if (Math.abs(v) > half + 6) continue;
      hits.push({ i, v, p: [ring[i][0] + (ring[j][0] - ring[i][0]) * t, ring[i][1] + (ring[j][1] - ring[i][1]) * t] });
    }
    if (hits.length < 2) return null;
    // a jagged facade may cross the line more than once at a mouth: the
    // innermost and the outermost crossing are the passage's two ends
    let lo = hits[0], hi = hits[0];
    for (const h of hits) { if (h.v < lo.v) lo = h; if (h.v > hi.v) hi = h; }
    const [h1, h2] = lo.i < hi.i ? [lo, hi] : [hi, lo];
    // the two arcs of the ring between the crossings; keep the one on the far side of s
    const arc = (from, to) => { const r = []; for (let k = (from + 1) % ring.length; ; k = (k + 1) % ring.length) { r.push(k); if (k === to) break; } return r; };
    const A1 = arc(h1.i, h2.i), A2 = arc(h2.i, h1.i);
    const away = (ix) => ix.reduce((n, k) => n + (Math.sign(L[k][0] - s) === Math.sign(s) ? 1 : -1), 0);
    const keep = away(A1) >= away(A2) ? [h1, A1, h2] : [h2, A2, h1];
    return [keep[0].p, ...keep[1].map((k) => ring[k]), keep[2].p];
  };
  const a = sideOf(hw), b = sideOf(-hw);
  return a && b ? [a, b] : null;
}

/**
 * Collision for every passage but the first (the Matthias Gate is cut by the
 * keyhole in js/landmarks-hrad.js, which also joins the courtyard to the
 * outside): `pieces` are simple rings, each passage splits the one it
 * crosses. Returns the pieces and the masonry over each passage as pieces of
 * landmarkSolids (top over `base`, the footprint's founding height).
 */
export function passSolids(pieces, list, base, top) {
  let rings = pieces.slice();
  const over = [];
  for (const q of list) {
    const hw = (q.p.cw ?? q.p.w) / 2 - 0.3;
    const qq = { ...q, hw };
    for (let k = 0; k < rings.length; k++) {
      const s = split(rings[k], qq);
      if (!s) continue;
      rings.splice(k, 1, ...s.filter((r) => Math.abs(area2(r)) > 1));
      break;
    }
    const { G, half } = q;
    over.push({ ring: [G.xz(-hw - 0.4, -half), G.xz(hw + 0.4, -half), G.xz(hw + 0.4, half), G.xz(-hw - 0.4, half)], holes: null, top, bot: q.p.floor - base + q.p.h });
  }
  return { rings, over };
}
