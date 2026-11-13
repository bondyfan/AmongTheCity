// ---- terraces.js: the tables a café puts out on the pavement -----------------
// A Czech town in summer is a town of zahrádky: three tables, six chairs and a
// parasol on the pavement in front of every café and hospoda. The tiles carry
// those venues by name and trade (648 in the Pardubice tile, 70 of them places
// you sit down in), and a street with their furniture on it reads as a street
// somebody is about to use.
//
// WHERE. A venue is a point, usually inside its building. The terrace goes
// where its landlord would put it: out through the wall toward the nearest
// way, a table's depth clear of the facade, in a row ALONG that facade. Every
// table is tested on its own: not inside a building, never on or beside a
// carriageway. One that fails is left out; a venue with no legal table gets no
// terrace. Nothing is random: the count, the parasol's colour and the chairs
// are hashed off the venue's position, so every player sees the same terrace.
//
// WHEN. The geometry is always in the chunk; the terrace is put out in the
// morning and taken in at night by one switch on its material (terraceOpen
// below, driven by the shared clock, so co-op players agree about that too).
//
// Pure geometry into a vertex-coloured sink. Worker-safe.

import { pointInPolygon } from './geo.js';
import { at, box, part, drum, post, bar } from './propkit.js';

const EAT = new Set(['cafe', 'restaurant', 'pub', 'bar', 'ice_cream', 'coffee', 'pastry',
  'confectionery', 'tea', 'biergarten']);
const REACH = 26;             // m: how far a venue looks for the way it faces
const CLEAR = 1.25;           // m: terrace centreline, out from the wall
const PITCH = 1.95;           // m between tables along the facade
const ROAD_GAP = 0.9;         // m a table edge keeps from any carriageway
const CANOPY = [0xe9dfc6, 0xb23a2e, 0x2f6b4a, 0x27557d, 0xd9a13a];

/** Open from mid-morning into the evening: tod is 0..1, 0.5 noon. */
export function terraceOpen(tod) { return tod > 0.385 && tod < 0.86; }

const SEAT = 0.45, TABLE = 0.73;

function chair(sink, x, y, z, h, cr, cg, cb, lr, lg, lb) {
  // seat, back, and four thin legs; the sitter faces the prop's front
  part(sink, x, y + SEAT - 0.03, z, h, 0, 0, 0.4, 0.03, 0.4, cr, cg, cb, true);
  part(sink, x, y + SEAT + 0.12, z, h, 0, -0.19, 0.4, 0.3, 0.025, cr, cg, cb, true);
  for (const [u, v] of [[-0.17, -0.17], [0.17, -0.17], [-0.17, 0.17], [0.17, 0.17]]) {
    const p = at(x, z, h, u, v);
    const px = p[0], pz = p[1];
    bar(sink, px, y, pz, px, y + (v < 0 ? SEAT + 0.42 : SEAT - 0.03), pz, 0.025, lr, lg, lb);
  }
}

function table(sink, x, y, z, tr, tg, tb, lr, lg, lb) {
  drum(sink, x, z, y, y + 0.03, 0.2, 0.18, 8, lr, lg, lb, 1);
  post(sink, x, z, y + 0.03, y + TABLE - 0.03, 0.028, lr, lg, lb);
  drum(sink, x, z, y + TABLE - 0.03, y + TABLE, 0.36, 0.36, 10, tr, tg, tb, 2);
}

function parasol(sink, x, y, z, h, col, hexA, hexB) {
  const [lr, lg, lb] = col(0x5a5d61);
  box(sink, x, y, z, 0.46, 0.07, 0.46, h, lr, lg, lb);
  post(sink, x, z, y + 0.07, y + 2.62, 0.024, lr, lg, lb);
  const A = col(hexA).slice(), B = col(hexB).slice();
  const N = 8, R = 1.5, rim = y + 2.28, top = y + 2.6;
  for (let i = 0; i < N; i++) {
    const a0 = h + (i / N) * Math.PI * 2, a1 = h + ((i + 1) / N) * Math.PI * 2;
    const x0 = x + Math.cos(a0) * R, z0 = z + Math.sin(a0) * R, x1 = x + Math.cos(a1) * R, z1 = z + Math.sin(a1) * R;
    const c = i & 1 ? A : B;
    // the cloth is seen from above AND from the chair under it: both faces,
    // the underside a shade darker
    sink.tri(x, top, z, x1, rim, z1, x0, rim, z0, c[0], c[1], c[2]);
    sink.tri(x, top - 0.01, z, x0, rim - 0.01, z0, x1, rim - 0.01, z1, c[0] * 0.72, c[1] * 0.72, c[2] * 0.72);
    // the valance hanging off the rim
    sink.quad(x1, rim, z1, x0, rim, z0, x0, rim - 0.14, z0, x1, rim - 0.14, z1, c[0] * 0.9, c[1] * 0.9, c[2] * 0.9);
    sink.quad(x0, rim, z0, x1, rim, z1, x1, rim - 0.14, z1, x0, rim - 0.14, z0, c[0] * 0.7, c[1] * 0.7, c[2] * 0.7);
  }
}

/** Every eating place this chunk owns, as [x, z, seed]. */
function venuesOf(cell, key, chunkOf) {
  const out = [];
  for (const v of cell.venues ?? []) {
    const p = v.p?.[0];
    if (p && EAT.has(v.t) && chunkOf(p[0], p[1]) === key) out.push([p[0], p[1]]);
  }
  for (const f of cell.buildings ?? []) {
    if (!f.u || !EAT.has(f.u) || !f.o?.length) continue;
    let sx = 0, sz = 0;
    for (const q of f.o) { sx += q[0]; sz += q[1]; }
    const x = sx / f.o.length, z = sz / f.o.length;
    if (chunkOf(x, z) === key) out.push([x, z]);
  }
  return out;
}

/**
 * Where one venue's tables go: [[x, z], …] plus the facade direction, or null.
 * `blocked(x, z, margin)` is true on or within `margin` of any carriageway.
 */
export function terracePlan(cell, x, z, seed, blocked) {
  // the way this venue faces: the nearest one of any kind
  let best = REACH * REACH, qx = 0, qz = 0;
  for (const r of cell.roads ?? []) {
    if (!r.p || r.p.length < 2 || r.br) continue;
    for (let i = 0; i < r.p.length - 1; i++) {
      const ax = r.p[i][0], az = r.p[i][1], ex = r.p[i + 1][0] - ax, ez = r.p[i + 1][1] - az;
      let t = ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1e-9);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d2 = (x - ax - ex * t) ** 2 + (z - az - ez * t) ** 2;
      if (d2 < best) { best = d2; qx = ax + ex * t; qz = az + ez * t; }
    }
  }
  if (best >= REACH * REACH) return null;
  const D = Math.sqrt(best);
  if (D < 0.5) return null;
  const dx = (qx - x) / D, dz = (qz - z) / D;
  // buildings near enough to matter, by a cheap reach test on their first corner
  const near = [];
  for (const f of cell.buildings ?? []) {
    const o = f.o;
    if (!o?.length) continue;
    let hit = false;
    for (let i = 0; i < o.length && !hit; i += 2) hit = Math.abs(o[i][0] - x) < 45 && Math.abs(o[i][1] - z) < 45;
    if (hit) near.push(o);
  }
  const inside = (px, pz) => { for (const o of near) if (pointInPolygon(px, pz, o)) return true; return false; };
  // …and whatever already stands on that pavement: a table is not laid over a
  // surveyed bench, bin or memorial (one hospoda had its parasol growing out
  // of a stone plinth)
  const taken = (px, pz) => {
    for (const f of cell.furniture ?? []) {
      const q = f.p?.[0];
      if (q && Math.abs(q[0] - px) < 1.7 && Math.abs(q[1] - pz) < 1.7) return true;
    }
    return false;
  };
  // out through the wall
  let t = 0;
  while (t < D && inside(x + dx * t, z + dz * t)) t += 0.35;
  if (t >= D) return null;
  const cx = x + dx * (t + CLEAR), cz = z + dz * (t + CLEAR);
  const fx = -dz, fz = dx;                       // along the facade
  const n = 2 + ((seed * 3) | 0) % 2 + (seed > 0.8 ? 1 : 0);
  const spots = [];
  for (let i = 0; i < n; i++) {
    const o = (i - (n - 1) / 2) * PITCH;
    const px = cx + fx * o, pz = cz + fz * o;
    if (inside(px, pz) || inside(px + dx * 0.55, pz + dz * 0.55) || taken(px, pz)) continue;
    if (inside(px + fx * 0.75, pz + fz * 0.75) || inside(px - fx * 0.75, pz - fz * 0.75)) continue;
    if (blocked(px, pz, ROAD_GAP) || blocked(px + fx * 0.8, pz + fz * 0.8, 0.4) || blocked(px - fx * 0.8, pz - fz * 0.8, 0.4)) continue;
    spots.push([px, pz]);
  }
  return spots.length ? { spots, fx, fz } : null;
}

/**
 * Draw every terrace this chunk owns.
 * @param sink    a vertex-coloured TriSink (its mesh wears mats.terrace)
 * @param stand   { heightAt }: the pavement where there is one
 * @param col     (hex) => [r, g, b]
 * @param rnd     (x, z, i) => 0..1 deterministic
 * @param blocked (x, z, margin) => on a carriageway
 * @param chunkOf (x, z) => chunk key
 */
export function terracesInto(sink, cell, key, stand, col, rnd, blocked, chunkOf) {
  if (!stand) return 0;
  let n = 0;
  for (const [x, z] of venuesOf(cell, key, chunkOf)) {
    const plan = terracePlan(cell, x, z, rnd(x, z, 0), blocked);
    if (!plan) continue;
    const { spots, fx, fz } = plan;
    const wicker = rnd(x, z, 1) < 0.5;
    const [cr, cg, cb] = col(wicker ? 0x80603c : 0xb4b8bd);
    const [lr, lg, lb] = col(wicker ? 0x3d2f20 : 0x8d9196);
    const [tr, tg, tb] = col(rnd(x, z, 2) < 0.5 ? 0xe8e4da : 0x8a6b45);
    // a chair's front is (sin h, cos h): one looks along +f, its twin back along -f
    const hA = Math.atan2(fx, fz), hB = hA + Math.PI;
    for (const [px, pz] of spots) {
      const y = stand.heightAt(px, pz);
      table(sink, px, y, pz, tr, tg, tb, lr, lg, lb);
      const ax = px - fx * 0.62, az = pz - fz * 0.62, bx = px + fx * 0.62, bz = pz + fz * 0.62;
      chair(sink, ax, stand.heightAt(ax, az), az, hA, cr, cg, cb, lr, lg, lb);
      chair(sink, bx, stand.heightAt(bx, bz), bz, hB, cr, cg, cb, lr, lg, lb);
    }
    // one parasol over the middle of the row, between two tables where it can
    const m = spots[(spots.length - 1) >> 1], m2 = spots[spots.length >> 1];
    const ux = (m[0] + m2[0]) / 2 + fz * 0.42, uz = (m[1] + m2[1]) / 2 - fx * 0.42;
    const k = (rnd(x, z, 3) * CANOPY.length) | 0;
    parasol(sink, ux, stand.heightAt(ux, uz), uz, hA, col, CANOPY[k], rnd(x, z, 4) < 0.5 ? CANOPY[0] : CANOPY[k]);
    n++;
  }
  return n;
}
