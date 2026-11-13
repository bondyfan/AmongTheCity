// ---- landmarks-parts.js: pieces more than one landmark is made of ----
// WORKER SAFE. Clock faces, cupolas, storey grids, and the late Gothic church
// the Pernštejns built three times over in Pardubice: a tall hall under one
// steep tiled roof, gables whose edges are cut into little merlons ("stínky"),
// buttresses, a polygonal presbytery and a needle of a ridge turret instead of
// a tower.

import { K } from './landmarkskit.js';

export const COPPER = 0x5fa58c, COPPER_DK = 0x4b8a74, GOLD = 0xdcb648, TILE = 0xa1503a,
  TILE_DK = 0x8c4633, DARK = 0x191b1f;

export const rect = (u0, y0, u1, y1) => [[u0, y0], [u1, y0], [u1, y1], [u0, y1]];
export function circle(uc, yc, r, n) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = i * 2 * Math.PI / n; out.push([uc + Math.cos(a) * r, yc + Math.sin(a) * r]); }
  return out;
}

/** A clock on a wall. S is a frame whose origin lies in the wall and whose front is the wall's. */
export function clockFace(kit, S, y, r, face = 0x17181b) {
  kit.set(GOLD, K.metal); S.slab(circle(0, y, r, 16), 0, 0.1);
  kit.set(face, K.metal); S.slab(circle(0, y, r * 0.87, 16), 0.1, 0.14);
  kit.set(face === 0x17181b ? GOLD : 0x1a1a1a, K.metal);
  S.slab(rect(-r * 0.045, y, r * 0.045, y + r * 0.72), 0.14, 0.17);
  S.slab([[0, y - r * 0.05], [r * 0.05, y + r * 0.03], [r * 0.5, y - r * 0.32], [r * 0.45, y - r * 0.4]], 0.14, 0.17);
}

/** n storeys of windows: rows for wallGrid. `o` overrides per row (arch, glow, hex). */
export function storeys(n, first, sH, h, w, o = {}) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push({ y: first + i * sH, h, w, glow: 0.3, ...o });
  return rows;
}

/** A Baroque cupola: bulb, open lantern, second bulb, spike and gilt ball. */
export function onion(kit, x, z, y, r, hex = COPPER) {
  kit.set(hex, K.copper);
  kit.lathe(x, z, [[r * 1.12, y], [r * 1.2, y + r * 0.35], [r * 1.02, y + r * 0.9], [r * 0.5, y + r * 1.45], [r * 0.36, y + r * 1.6]], 8, Math.PI / 8);
  kit.set(0x2a2622, K.wood);
  kit.lathe(x, z, [[r * 0.34, y + r * 1.6], [r * 0.34, y + r * 2.3]], 8, Math.PI / 8);      // the lantern
  kit.set(hex, K.copper);
  kit.lathe(x, z, [[r * 0.52, y + r * 2.3], [r * 0.56, y + r * 2.5], [r * 0.3, y + r * 2.95], [r * 0.07, y + r * 3.9], [0, y + r * 4.1]], 8, Math.PI / 8);
  kit.set(GOLD, K.metal);
  kit.lathe(x, z, [[0, y + r * 3.95], [r * 0.13, y + r * 4.1], [0, y + r * 4.3]], 6);
  return y + r * 4.3;
}

/** A needle spire on an eight-sided shaft (ridge turrets, corner turrets). */
export function needle(kit, x, z, y0, shaft, r, tip, hex = COPPER) {
  kit.set(hex, K.copper);
  kit.lathe(x, z, [[r, y0], [r, y0 + shaft], [r * 1.38, y0 + shaft + 0.18], [r * 0.2, tip - 0.5], [0, tip]], 8, Math.PI / 8);
  kit.set(GOLD, K.metal);
  kit.lathe(x, z, [[0, tip - 0.25], [0.19, tip], [0, tip + 0.3]], 6);
}

/** A gable whose raking edges are cut into steps (the Pernštejn "stínky"): an outline in (u, y). */
export function steppedGable(u0, u1, yE, yR, steps = 6, lift = 0.7) {
  const um = (u0 + u1) / 2, half = (u1 - u0) / 2, left = [], right = [];
  for (let i = 0; i < steps; i++) {
    const a = half * (1 - i / steps), b = half * (1 - (i + 1) / steps);
    const y = yE + (yR - yE) * ((i + 1) / steps) + lift;
    left.push([um - a, y], [um - b, y]);
    right.push([um + a, y], [um + b, y]);
  }
  // counter-clockwise: along the foot, up the right-hand steps, down the left
  right.pop();                       // the apex is the first point of the way down
  return [[u0, yE], [u1, yE], ...right, ...left.reverse()];
}

/**
 * A late Gothic hall church. The frame's front (v+) is the west end.
 * P: { nave:[u0,u1,v0,v1], H, rise, pres:[u0,u1,v0,v1] (v0 is the tip of the
 *      apse), presH, presRise, turret:{v,top,r}, bays, vest:[u0,u1,v1,H,rise],
 *      wall, roof, glow }
 */
export function church(kit, F, P) {
  const [u0, u1, v0, v1] = P.nave, H = P.H, um = (u0 + u1) / 2;
  const wall = P.wall ?? 0xe7e0d0, roof = P.roof ?? TILE, pane = 0x3d4c5e;
  const lancet = { y: 3.2, h: H - 5.4, w: 1.5, arch: 2, hex: pane, glow: P.glow ?? 0.2, rev: 0.3 };
  const bays = P.bays ?? 3;
  const side = { cols: bays, rows: [lancet], seed: 5 };
  const west = { cols: 1, rows: [{ y: Math.max(P.vest ? P.vest[3] + 5.5 : 4, 5), h: H * 0.34, w: 2.0, arch: 2, hex: pane, glow: 0.4, rev: 0.3 }] };
  kit.set(wall, K.plaster);
  F.box(u0, u1, v0, v1, 0, H, { l: side, r: side, f: west }, false);
  // buttresses between the windows and at the corners, weathered at the top
  const bay = (v1 - v0) / bays;
  for (let i = 0; i <= bays; i++) {
    const v = Math.min(v1 - 0.45, Math.max(v0 + 0.45, v0 + bay * i));
    F.slab([[u0 - 1.5, 0], [u0, 0], [u0, H * 0.78], [u0 - 1.5, H * 0.56]], v - 0.45, v + 0.45);
    F.slab([[u1, 0], [u1 + 1.5, 0], [u1 + 1.5, H * 0.56], [u1, H * 0.78]], v - 0.45, v + 0.45);
  }
  // the roof, as tall as the walls, and the two cut gables
  kit.set(roof, K.tile);
  F.roof(u0, u1, v0 + 0.5, v1 - 0.5, H, H + P.rise, { alongV: true, over: 0.35 });
  kit.set(wall, K.plaster);
  const gable = steppedGable(u0, u1, H, H + P.rise, 7, 0.75);
  F.slab(gable, v1 - 0.55, v1);
  F.slab(gable, v0, v0 + 0.55);
  // cornices across the west gable, as the Renaissance repair left it
  kit.set(0xcfc6b2, K.plaster);
  for (const t of [0, 0.34, 0.66]) {
    const w = (u1 - u0) / 2 * (1 - t) + 0.12;
    F.slab(rect(um - w, H + P.rise * t - 0.12, um + w, H + P.rise * t + 0.12), v1, v1 + 0.14);
  }

  // the presbytery: narrower, five sides of an octagon at the east end
  if (P.pres) {
    const [p0, p1, pv0, pv1] = P.pres, pw = p1 - p0, cut = Math.min(pw * 0.3, 3.2), PH = P.presH ?? H;
    const ring = [F.xz(p0, pv1), F.xz(p0, pv0 + cut), F.xz(p0 + cut, pv0), F.xz(p1 - cut, pv0), F.xz(p1, pv0 + cut), F.xz(p1, pv1)];
    kit.set(wall, K.plaster);
    kit.ringWalls(ring, 0, PH, (e) => (e.i === 5 ? false : e.len > 2.4
      ? { cols: Math.max(1, Math.round(e.len / 4.6)), rows: [{ ...lancet, h: PH - 5.4, w: 1.25 }], seed: 9 } : null));
    kit.cap(ring, null, PH, true);
    kit.set(roof, K.tile);
    const rr = P.presRise ?? P.rise * 0.8;
    F.roof(p0, p1, pv0 + cut * 0.4, pv1 + 0.4, PH, PH + rr, { alongV: true, hip0: pw / 2, over: 0.25 });
  }
  // the porch before the west door
  if (P.vest) {
    const [a0, a1, av1, VH, vr] = P.vest;
    kit.set(wall, K.plaster);
    F.box(a0, a1, v1, av1, 0, VH, { f: { cols: 1, rows: [{ y: 0, h: 3.3, w: 2.0, arch: 2, door: true, rev: 0.35 }] },
      l: { cols: 1, rows: [{ y: 2.2, h: 2.4, w: 1.0, arch: 2, hex: pane }] }, r: { cols: 1, rows: [{ y: 2.2, h: 2.4, w: 1.0, arch: 2, hex: pane }] }, b: false }, false);
    kit.set(roof, K.tile);
    F.roof(a0, a1, v1, av1 - 0.4, VH, VH + vr, { alongV: true, over: 0.3 });
    kit.set(wall, K.plaster);
    F.slab(steppedGable(a0, a1, VH, VH + vr, 4, 0.55), av1 - 0.45, av1);
  }
  // the ridge turret: the only "tower" these churches have, and it is a needle
  if (P.turret) {
    const [x, z] = F.xz(um, P.turret.v), y = H + P.rise - 1.2, r = P.turret.r ?? 0.95;
    const was = kit.floodFn;
    kit.floodFn = () => P.turretFlood ?? 0.5;       // the needle is lit: it is the skyline
    kit.set(COPPER_DK, K.copper);
    kit.lathe(x, z, [[r, y], [r, y + 3.4]], 8, Math.PI / 8);
    needle(kit, x, z, y + 3.4, 1.6, r * 0.9, P.turret.top);
    kit.floodFn = was;
  }
}
