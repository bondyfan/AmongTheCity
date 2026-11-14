// ---- landmarks-prahaparts.js: pieces the Prague landmarks are made of ----
// WORKER SAFE: pure maths on the kit (js/landmarkskit.js), no DOM, no clock.
// Prague asks for shapes Pardubice never needed: a strut between two arbitrary
// points (the Petřín lattice is all diagonals, and lathe only turns about a
// vertical axis), a Baroque helmet of any proportion (the great south tower of
// St Vitus), the flying buttresses of a Gothic choir, a stone needle with
// crockets, and a hipped roof that follows a footprint ring of any shape (the
// castle is one 279-vertex outline round its courtyards).

import { K, ringArea } from './landmarkskit.js';
import { GOLD } from './landmarks-parts.js';

/**
 * A prism of n sides between two points A and B ([x, y, z], y above the
 * landmark's ground), radius r. The lattice of a lookout tower, a mast's stay,
 * a sloping pillar. Caps are left off: a strut always ends in something.
 */
export function strut(kit, A, B, r, n = 4, phase = Math.PI / 4) {
  const dx = B[0] - A[0], dy = B[1] - A[1], dz = B[2] - A[2];
  const L = Math.hypot(dx, dy, dz);
  if (L < 1e-6) return;
  const ax = dx / L, ay = dy / L, az = dz / L;
  // two unit vectors square to the axis: from the world axis least like it
  let px, py, pz;
  if (Math.abs(ay) < 0.9) { px = -az; py = 0; pz = ax; } else { px = 0; py = az; pz = -ay; }
  const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
  const qx = ay * pz - az * py, qy = az * px - ax * pz, qz = ax * py - ay * px;
  const off = (i) => {
    const t = phase + i * 2 * Math.PI / n, c = Math.cos(t) * r, s = Math.sin(t) * r;
    return [px * c + qx * s, py * c + qy * s, pz * c + qz * s];
  };
  for (let i = 0; i < n; i++) {
    const o0 = off(i), o1 = off(i + 1);
    const fx = o0[0] + o1[0], fy = o0[1] + o1[1], fz = o0[2] + o1[2];
    kit.quad([A[0] + o0[0], A[1] + o0[1], A[2] + o0[2]], [A[0] + o1[0], A[1] + o1[1], A[2] + o1[2]],
      [B[0] + o1[0], B[1] + o1[1], B[2] + o1[2]], [B[0] + o0[0], B[1] + o0[1], B[2] + o0[2]], fx, fy, fz);
  }
}

/**
 * A Baroque helmet over a tower top at height y, r its widest radius, reaching
 * `top`: a bell, a waist, an open lantern, a second smaller bell, the spike
 * and a gilt ball. Unlike parts.onion its height is free, so the 40 m crown of
 * St Vitus and a 6 m cupola come from one profile.
 */
export function helmet(kit, x, z, y, r, top, hex, n = 8, phase = Math.PI / 8) {
  const h = top - y, Y = (t) => y + h * t;
  kit.set(hex, K.copper);
  kit.lathe(x, z, [[r * 1.04, Y(0)], [r * 1.1, Y(0.05)], [r * 0.98, Y(0.16)], [r * 0.62, Y(0.27)],
    [r * 0.42, Y(0.31)], [r * 0.5, Y(0.36)]], n, phase);
  kit.set(0x2b2723, K.wood);
  kit.lathe(x, z, [[r * 0.36, Y(0.36)], [r * 0.36, Y(0.47)]], n, phase);            // the open lantern
  kit.set(hex, K.copper);
  kit.lathe(x, z, [[r * 0.46, Y(0.47)], [r * 0.5, Y(0.5)], [r * 0.4, Y(0.6)], [r * 0.18, Y(0.66)],
    [r * 0.22, Y(0.7)], [r * 0.16, Y(0.78)], [r * 0.05, Y(0.92)], [0, Y(0.96)]], n, phase);
  kit.set(GOLD, K.metal);
  const b = Math.max(0.25, r * 0.07);
  kit.lathe(x, z, [[0, Y(0.95) - b], [b, Y(0.95)], [0, Y(0.95) + b], [0.08, top], [0, top + 0.05]], 6);
}

/**
 * A Gothic stone needle: an n-sided shaft that tapers from r at y0 to a point
 * at `tip`, with a crocketed band every few metres (a short flare) so it
 * catches the light the way the real tracery does from a distance, and a
 * finial. `hex` is the stone.
 */
export function stoneNeedle(kit, x, z, y0, r, tip, hex, n = 8, bands = 3) {
  kit.set(hex, K.stone);
  const prof = [[r, y0]], h = tip - y0;
  for (let i = 1; i <= bands; i++) {
    const t = i / (bands + 1), rr = r * (1 - t * 0.92), y = y0 + h * t * 0.94;
    prof.push([rr * 1.0, y - 0.35], [rr * 1.22, y], [rr * 0.98, y + 0.35]);
  }
  prof.push([r * 0.04, tip - 1.2], [0, tip]);
  kit.lathe(x, z, prof, n, Math.PI / n);
  kit.set(hex, K.stone);
  kit.lathe(x, z, [[0, tip - 0.9], [r * 0.18, tip - 0.5], [0, tip + 0.4]], 4);   // the finial's cross
}

/**
 * A flying buttress in a frame F whose u runs across the choir: from the top
 * of a pier at uPier (pier height yP) to the clerestory wall at uWall (meeting
 * it at yW), w thick along v, at v. The underside is a quarter arch.
 */
export function flyer(F, v, uPier, uWall, yP, yW, w = 0.7) {
  const s = uWall > uPier ? 1 : -1, span = Math.abs(uWall - uPier), th = 1.1;
  const pts = [[uPier, yP], [uPier, yP + th]];
  pts.push([uWall, yW + th], [uWall, yW - 1.6]);
  // the arch under it, from the wall back down to the pier
  for (let i = 1; i < 5; i++) {
    const t = i / 5, a = t * Math.PI / 2;
    pts.push([uWall - s * span * (1 - Math.cos(a)), yW - 1.6 - (yW - 1.6 - (yP - 2.2)) * Math.sin(a)]);
  }
  pts.push([uPier, yP - 2.2]);
  F.slab(pts, v - w / 2, v + w / 2);
}

/** Does a ring cross itself? (O(n^2): a footprint, once, at build time.) */
export function selfCrossing(ring) {
  const n = ring.length;
  const side = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = ring[j], d = ring[(j + 1) % n];
      if (side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0) return true;
    }
  }
  return false;
}

/**
 * The inset of a ring that is still a simple ring: d metres in (out with a
 * negative d), halved until it no longer folds through a thin wing; null if
 * even a metre folds. Signed areas keep the winding honest.
 */
export function safeInset(kit, ring, d) {
  const a0 = ringArea(ring);
  for (let k = 0; k < 4; k++, d /= 2) {
    const r = kit.offsetRing(ring, d), a = ringArea(r);
    if (Math.sign(a) !== Math.sign(a0)) continue;
    if (d > 0 ? Math.abs(a) >= Math.abs(a0) : Math.abs(a) <= Math.abs(a0)) continue;
    if (!selfCrossing(r)) return { ring: r, d };
  }
  return null;
}

/**
 * A hipped roof that follows a footprint and its courtyards: from every eave
 * at yE a slope rises `rise` over `depth` metres into the wing, and a flat lid
 * closes the top. One strip per edge, mitred at the corners by the inset ring
 * itself, so a 279-vertex castle gets a roof without a frame per wing.
 */
export function ringRoof(kit, ring, holes, yE, depth, rise, over = 0.35) {
  const outer = safeInset(kit, ring, depth);
  const eave = kit.offsetRing(ring, -over);
  const dropE = yE - over * rise / depth;
  const strips = (R, E, I, yI) => {
    const n = R.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ex = R[j][0] - R[i][0], ez = R[j][1] - R[i][1];
      if (Math.hypot(ex, ez) < 0.02) continue;
      // outward is from the inset point to the eave
      const mx = (E[i][0] + E[j][0] - I[i][0] - I[j][0]) / 2, mz = (E[i][1] + E[j][1] - I[i][1] - I[j][1]) / 2;
      kit.quad([E[i][0], dropE, E[i][1]], [E[j][0], dropE, E[j][1]], [I[j][0], yI, I[j][1]], [I[i][0], yI, I[i][1]], mx, Math.hypot(mx, mz), mz);
    }
  };
  if (!outer) { kit.cap(ring, holes, yE, true); return; }
  const yI = yE + rise * outer.d / depth;
  strips(ring, eave, outer.ring, yI);
  const lidHoles = [];
  for (const h of holes ?? []) {
    if (h.length < 3) continue;
    const ins = safeInset(kit, h, -depth);
    const he = kit.offsetRing(h, over);
    if (!ins) { lidHoles.push(h); continue; }
    strips(h, he, ins.ring, yE + rise * Math.abs(ins.d) / depth);
    lidHoles.push(ins.ring);
  }
  kit.cap(outer.ring, lidHoles, yI, true);
}

/**
 * Window rows for a wall founded at y0 whose cornice is at E, counted DOWN
 * from the cornice so every wall of a long building on a slope keeps its
 * storeys level with its neighbours': `pitch` per storey, the top one a short
 * mezzanine. Sills are relative to y0, as wallGrid wants them.
 */
export function rowsFromTop(y0, E, pitch, h, w, o = {}, max = 8, attic = 1.6) {
  const rows = [];
  let top = E - attic;
  for (let i = 0; i < max; i++) {
    const hh = i === 0 && o.mezz ? h * 0.55 : h;
    const sill = top - hh - y0;
    if (sill < (o.foot ?? 1.0)) break;
    rows.push({ y: sill, h: hh, w, glow: o.glow ?? 0.25, hex: o.hex, rev: o.rev ?? 0, arch: o.arch ?? 0 });
    top -= i === 0 && o.mezz ? pitch * 0.6 : pitch;
  }
  return rows.reverse();
}
