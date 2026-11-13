// ---- landmarks-mlyny.js: the Winternitz automatic mills ----
// Josef Gočár's mill on the Chrudimka (1909 to 1911), since 2023 the Gočár
// gallery: a long cliff of red brick laid in patterns, pilaster strips
// carrying round arches under the parapet, and battlements all along the top
// that made people call it the Ishtar Gate. The grain silo across the yard
// came in 1924, joined to the mill by a brick bridge on an arch, crowned with
// swallow-tail merlons and, since the conversion, with a glass hall that
// glows over the river at night.
//
// Three footprints, three entries (mill, silo, bridge), one look. The mill's
// frame comes from its longest wall: u runs SOUTH along the river front, v
// west toward the water.

import { K, prism } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { storeys, rect } from './landmarks-parts.js';

const BRICK = 0x9b4b36, BRICK_DK = 0x7a3a2b, RENDER = 0xd9d1bc, PANE = 0x44535f, STEEL = 0x55595c;
const WEST = [-0.97, 0.25];
// the mill's three blocks, north to south, in the frame below: [u0, u1, v0, v1, height, storeys]
const NORTH = [-39.5, -2.9, -10.7, 9.3, 20.4, 5], MID = [-2.9, 32.3, -6.2, 9.3, 24.2, 6], STAIR = [32.3, 39.6, -6.1, 10.7, 29.6, 7];

/** A brick block with a window grid, pilaster strips on the listed sides, a frieze and battlements. */
function millBlock(kit, F, u0, u1, v0, v1, H, n, o = {}) {
  const sH = (H - 2.4) / n;
  const rows = storeys(n, 1.5, sH, sH * 0.55, 1.7, { hex: PANE, glow: 0.4, dark: true });
  rows[n - 1] = { ...rows[n - 1], arch: 1, h: sH * 0.68 };          // the arcade under the parapet
  const g = (len, seed) => ({ cols: Math.max(1, Math.round(len / 3.9)), inset: 0.5, rows, seed });
  kit.set(BRICK, K.brick);
  F.box(u0, u1, v0, v1, 0, H, { f: g(u1 - u0, o.seed ?? 1), b: g(u1 - u0, (o.seed ?? 1) + 1),
    l: o.l === false ? true : g(v1 - v0, (o.seed ?? 1) + 2), r: o.r === false ? true : g(v1 - v0, (o.seed ?? 1) + 3) });
  // pilaster strips between the bays of the two long sides
  kit.set(BRICK_DK, K.brick);
  const cols = Math.max(1, Math.round((u1 - u0) / 3.9)), bay = (u1 - u0 - 1) / cols;
  for (let i = 0; i <= cols; i++) {
    const u = u0 + 0.5 + bay * i;
    F.slab(rect(Math.max(u0, u - 0.3), 0, Math.min(u1, u + 0.3), H), v1, v1 + 0.14);
    F.slab(rect(Math.max(u0, u - 0.3), 0, Math.min(u1, u + 0.3), H), v0 - 0.14, v0);
  }
  // the rendered frieze, the parapet and its battlements
  kit.set(RENDER, K.plaster);
  F.box(u0 - 0.16, u1 + 0.16, v0 - 0.16, v1 + 0.16, H - 0.9, H - 0.25, null, false);
  kit.set(BRICK, K.brick);
  F.box(u0 - 0.2, u1 + 0.2, v0 - 0.2, v1 + 0.2, H - 0.25, H + 0.9, null, false);
  F.flat(u0, u1, v0, v1, H + 0.1, true);
  for (const s of 'fblr') F.merlons(s, u0 - 0.2, u1 + 0.2, v0 - 0.2, v1 + 0.2, H + 0.9, o.mh ?? 1.1, 1.3, 1.1, 0.5, !!o.swallow);
}

export function buildMlyny(kit, f) {
  const { F } = fitFrame(kit, f.o, WEST[0], WEST[1], true);
  kit.lid = 0x4f5053;
  kit.floodFn = (x, y) => 0.42 - 0.12 * Math.min(1, y / 26);
  millBlock(kit, F, ...NORTH, { seed: 1 });
  millBlock(kit, F, ...MID, { seed: 11, l: false });
  // the stair tower at the south end, where the bridge leaves for the silo
  millBlock(kit, F, ...STAIR, { seed: 21, mh: 1.4 });
  // the centre bay Gočár pushed forward and carried up through the parapet
  kit.set(BRICK, K.brick);
  F.box(-15.9, -7.3, 9.3, 10.0, 0, 23.6, { f: { cols: 1, rows: [{ y: 0, h: 4.4, w: 3.2, arch: 1, door: true, rev: 0.4 },
    { y: 6.5, h: 12.5, w: 4.2, arch: 1, hex: PANE, glow: 0.6, rev: 0.35 }] } });
  F.merlons('f', -15.9, -7.3, 9.3, 10.0, 23.6, 1.2, 1.3, 1.1, 0.5);
}

/** Solid as built: the footprint to the lowest parapet (l.top), the two taller blocks over it. */
export function mlynySolids(f, l) {
  const { F } = fitFrame(null, f.o, WEST[0], WEST[1], true);
  const over = ([u0, u1, v0, v1, top]) => ({ ring: F.ring(u0, u1, v0, v1), holes: null, top, bot: 0 });
  return [prism(f, l.top), over(MID), over(STAIR)];
}

export function buildSilo(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, WEST[0], WEST[1], true);
  kit.lid = 0x4f5053;
  kit.floodFn = (x, y) => 0.4 - 0.1 * Math.min(1, y / 30);
  const H = 29;
  // a grain bin has no windows: tall blind arches keep the brick from being a wall
  const blind = (cols, seed) => ({ cols, inset: 0.8, seed,
    rows: [{ y: 0.6, h: 3.0, w: 1.7, hex: PANE, glow: 0.5 }, { y: 5.2, h: H - 9.5, w: 1.9, arch: 1, hex: BRICK_DK, kind: K.brick, rev: 0.3 }] });
  kit.set(BRICK, K.brick);
  F.box(-hu, hu, -hv, hv, 0, H, { f: blind(8, 1), b: blind(8, 2), l: blind(2, 3), r: blind(2, 4) }, false);
  kit.set(RENDER, K.plaster);
  F.box(-hu - 0.16, hu + 0.16, -hv - 0.16, hv + 0.16, H - 3.2, H - 2.5, null, false);
  kit.set(BRICK, K.brick);
  F.flat(-hu, hu, -hv, hv, H - 0.1, true);
  for (const s of 'fblr') F.merlons(s, -hu - 0.1, hu + 0.1, -hv - 0.1, hv + 0.1, H, 1.7, 1.5, 1.0, 0.55, true);
  // the glass hall the conversion set on the roof
  const hall = (cols, seed) => ({ cols, rows: [{ y: 0.25, h: 3.9, w: 2.3, hex: 0x50626e, glow: 0.95, rev: 0.08, dark: true }], seed });
  kit.set(STEEL, K.metal);
  F.box(-hu + 2.2, hu - 2.2, -hv + 1.7, hv - 1.7, H - 0.1, H + 4.5, { f: hall(10, 5), b: hall(10, 6), l: hall(2, 7), r: hall(2, 8) });
}

/** The bridge between mill and silo: a brick box riding on one round arch. */
export function buildMost(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, WEST[0], WEST[1]);
  kit.floodFn = () => 0.35;
  const top = 18.2, spring = 9.2, crown = 12.6, pts = [];
  for (let i = 0; i <= 10; i++) { const t = Math.PI * i / 10; pts.push([-hv * Math.cos(t), spring + (crown - spring) * Math.sin(t)]); }
  pts.push([hv, top], [-hv, top]);
  kit.set(BRICK, K.brick);
  F.slab(pts, -hu, hu, true);
  // three small lights each side of the crossing (the outline is [v, y], so
  // the two long faces are the ones at u = -hu and u = +hu)
  kit.set(0x1c242c, K.metal);
  for (const v of [-hv * 0.5, 0, hv * 0.5]) {
    kit.gl = 0.5;
    F.slab(rect(v - 0.5, 14.2, v + 0.5, 16.2), hu, hu + 0.04, true);
    F.slab(rect(v - 0.5, 14.2, v + 0.5, 16.2), -hu - 0.04, -hu, true);
  }
  kit.gl = 0;
  kit.set(BRICK, K.brick);
  F.merlons('l', -hu, hu, -hv, hv, top, 1.0, 1.1, 0.9, 0.4);
  F.merlons('r', -hu, hu, -hv, hv, top, 1.0, 1.1, 0.9, 0.4);
}
