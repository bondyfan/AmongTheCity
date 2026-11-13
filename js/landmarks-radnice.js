// ---- landmarks-radnice.js: the town hall on Pernštýnské náměstí ----
// Jan Vejrych's Neo-Renaissance town hall of 1892 to 1894 fills the north side
// of the square: four wings round a courtyard, three storeys to the square
// with an arcaded ground floor, sgraffito under the cornice, a tall red roof,
// and the two slim towers with copper cupolas that stand on the two bays the
// footprint itself pushes out of the front.
//
// Walls follow the real outline (and the courtyard); roofs lie wing by wing in
// the building's own axes: u along the square front, v out into the square.

import { K, prism } from './landmarkskit.js';
import { fitFrame } from './landmarksframe.js';
import { clockFace, onion, rect, steppedGable, TILE } from './landmarks-parts.js';

const WALL = 0xe6d9b4, STONE = 0xcfc4a6, SGRAF = 0x8d7c66, PANE = 0x4a5a6a;
// the two towers, in the frame of the square front: centres along it, depth, cornice height
const TOWER_U = [-9.0, 9.0], TOWER_HALF = 2.55, TOWER_V = [-3.3, 1.75], TOWER_H = 27.5;

/**
 * The building's two frames. F: fitted to the footprint, front toward the
 * square. S: the square front itself, which is not quite parallel to the rear
 * wing F was fitted to (2.5 degrees), so everything that sits ON the front
 * gets a frame laid through the two outer corners of that front.
 */
function frames(kit, f) {
  const { F, hu, hv } = fitFrame(kit, f.o, 0.45, 0.89);
  let pl = null, pr = null;
  for (const p of f.o) {
    const q = F.local(p[0], p[1]);
    if (q[1] < hv - 6) continue;
    if (!pl || q[0] < pl[0]) pl = q;
    if (!pr || q[0] > pr[0]) pr = q;
  }
  const du = pr[0] - pl[0], dv = pr[1] - pl[1], half = Math.hypot(du, dv) / 2;
  const S = F.sub((pl[0] + pr[0]) / 2, (pl[1] + pr[1]) / 2, 0, Math.atan2(-dv, du));
  return { F, hu, hv, S, half };
}

export function buildRadnice(kit, f) {
  const { F, hu, hv, S, half } = frames(kit, f);
  const E = 15.2;
  kit.floodFn = (x, y) => (y < E ? 0.62 - 0.14 * (y / E) : 0.34);
  // which way an edge looks decides how it is dressed: the square front gets
  // the arcade and the tall first floor, everything else plain office windows
  const [fx, fz] = F.dir(0, 1);
  const front = [{ y: 0.5, h: 3.7, w: 2.1, arch: 1, hex: PANE, glow: 0.5, rev: 0.3 },
    { y: 6.0, h: 3.0, w: 1.5, arch: 1, hex: PANE, glow: 0.45 }, { y: 10.6, h: 2.5, w: 1.4, hex: PANE, glow: 0.3 }];
  const plain = [{ y: 1.3, h: 2.2, w: 1.3, hex: PANE, glow: 0.3 }, { y: 6.2, h: 2.4, w: 1.3, hex: PANE, glow: 0.3 }, { y: 10.7, h: 2.2, w: 1.3, hex: PANE, glow: 0.25 }];
  const grid = (e) => {
    if (e.len < 3.2) return null;
    const sq = e.nx * fx + e.nz * fz > 0.9;
    return { pitch: sq ? 3.7 : 3.9, inset: 0.5, rows: sq ? front : plain, seed: e.i };
  };
  kit.set(WALL, K.plaster);
  kit.ringWalls(f.o, 0, E, grid);
  for (const h of f.i ?? []) if (h.length >= 3) kit.ringWalls(h, 0, E, (e) => (e.len < 4 ? null : { pitch: 3.9, inset: 0.5, rows: plain, seed: 50 + e.i }), true);
  kit.set(0x55504a, K.metal);
  kit.cap(f.o, f.i, E - 0.03, true);

  // dressed: a rusticated foot, a string course, the sgraffito frieze, the cornice
  kit.set(STONE, K.stone);
  S.slab(rect(-half + 0.2, 0, half - 0.2, 0.5), 0, 0.12);
  S.slab(rect(-half, 4.75, half, 5.15), 0, 0.16);
  kit.set(SGRAF, K.plaster);
  S.slab(rect(-half + 0.3, 13.35, half - 0.3, 14.55), 0, 0.06);
  kit.set(STONE, K.stone);
  S.slab(rect(-half - 0.2, 14.6, half + 0.2, 15.25), -0.2, 0.45);

  // ---- roofs ---------------------------------------------------------------
  kit.set(TILE, K.tile);
  S.roof(-half, half, -11.6, 0, E, E + 6.6, { hip0: 5.5, hip1: 5.5, over: 0.4 });                  // the square wing
  F.roof(-hu, hu - 0.6, -hv, -13.7, E, E + 5.6, { hip0: 5, hip1: 5, over: 0.4 });                  // the rear wing
  F.roof(-18.9, -9.6, -14.5, 11.5, E, E + 4.8, { alongV: true, over: 0.3 });                       // the two side wings
  F.roof(8.6, 17.5, -14.5, 11.5, E, E + 4.8, { alongV: true, over: 0.3 });
  // the middle gable over the front, with the town's arms on a panel
  kit.set(WALL, K.plaster);
  S.slab(steppedGable(-4.6, 4.6, E, E + 6.2, 4, 0.6), -0.5, 0.05);
  kit.set(0x9a2f25, K.plaster);
  S.slab(rect(-1.2, E + 1.2, 1.2, E + 3.8), 0.05, 0.14);
  kit.set(TILE, K.tile);
  S.roof(-4.6, 4.6, -6, -0.5, E, E + 6.2, { alongV: true, hip0: 6, over: 0 });

  // ---- the two towers on the bays -------------------------------------------
  for (const uc of TOWER_U) {
    const a = uc - TOWER_HALF, b = uc + TOWER_HALF, [v0, v1] = TOWER_V, TH = TOWER_H;
    const lights = { cols: 1, rows: [{ y: 2.0, h: 2.4, w: 1.2, arch: 1, hex: PANE, glow: 0.4 }, { y: 7.6, h: 2.6, w: 1.5, arch: 1, hex: 0x241d17, kind: K.wood, rev: 0.3 }] };
    kit.set(WALL, K.plaster);
    const T = S.sub(0, 0, E - 0.3);
    T.box(a, b, v0, v1, 0, TH - E + 0.3, { f: lights, b: lights, l: lights, r: lights }, false);
    kit.set(STONE, K.stone);
    S.box(a - 0.3, b + 0.3, v0 - 0.3, v1 + 0.3, TH - 0.5, TH + 0.1, null, true, true);
    S.box(a - 0.2, b + 0.2, v0 - 0.2, v1 + 0.2, E + 5.6, E + 6.0, null, true, true);
    const [x, z] = S.xz(uc, (v0 + v1) / 2);
    onion(kit, x, z, TH + 0.1, 2.35);
  }
  clockFace(kit, S.sub(0, 0.05, 0, 0), E + 4.9, 0.95, 0xece6d6);
}

/** Solid as built: the four wings to their cornice (l.top), the courtyard open, and the two towers. */
export function radniceSolids(f, l) {
  const { S } = frames(null, f);
  return [prism(f, l.top), ...TOWER_U.map((uc) => (
    { ring: S.ring(uc - TOWER_HALF, uc + TOWER_HALF, TOWER_V[0], TOWER_V[1]), holes: null, top: TOWER_H, bot: 0 }))];
}
