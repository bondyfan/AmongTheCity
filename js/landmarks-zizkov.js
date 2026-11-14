// ---- landmarks-zizkov.js: the Žižkov television tower ----
// Václav Aulický and Jiří Kozák, 1985 to 1992: three concrete tubes on a
// triangle, the main one carrying the transmitters to 216 m, the two others
// ending at 134 m; three cabins hung between them at the restaurant (63 m),
// the observation deck (93 m) and the transmitter floor (100 m), silver
// boxes with dark glass; the white radome from 132 to 175 m and the red and
// white antenna over it; and David Černý's bronze babies crawling up.
//
// The tile has the tower as eleven overlapping rings (one of them upside
// down): the registry hides ten (js/landmarks-hrad.js) and this model stands
// on the largest. Its own geometry is laid out round the OSM mast node, in a
// frame turned with the base building, so it ignores the tile's 120 m cap.

import { K, hash2 } from './landmarkskit.js';
import { Frame } from './landmarksframe.js';

export const ZIZKOV = { at: [-93503.5, -5485.3], front: [0.2691, -0.9631], ground: 254.31 };
const CONC = 0xbfc0bd, SILVER = 0xc4c9cc, GLASS = 0x2c3a46, WHITE = 0xe7e8e4, RED = 0xb8352b;
// the three tubes in the frame: main, and the two short ones (u, v, radius, top)
const TUBES = [[0, 2.2, 3.3, 175], [-6.2, -2.0, 2.5, 134], [6.2, -2.0, 2.5, 134]];
const PODS = [[63, 6.0, 9.5, 6.5], [93, 5.0, 8.5, 5.5], [100.5, 3.6, 7.0, 4.5]];   // y, height, length, depth
const CABIN_C = [0, -0.6];                      // the middle of the triangle

/** The frame of the tower, with its ground set so the model stands on y = 0 at the base. */
export function zizkovFrame(kit, ground) {
  return new Frame(kit, ZIZKOV.at[0], ZIZKOV.at[1], ZIZKOV.front[0], ZIZKOV.front[1], ZIZKOV.ground - ground);
}

/** The three pods of one cabin level: boxes on the three sides of the triangle. */
function pods(kit, F, y, h, len, dep, glow) {
  for (let k = 0; k < 3; k++) {
    const a = k * 2 * Math.PI / 3 + Math.PI;     // outward: away from the triangle's sides
    const S = F.sub(CABIN_C[0] + Math.sin(a) * 4.8, CABIN_C[1] + Math.cos(a) * 4.8, 0, a);
    kit.set(SILVER, K.metal);
    S.box(-len / 2, len / 2, -dep / 2, dep / 2, y, y + h * 0.28);
    S.box(-len / 2, len / 2, -dep / 2, dep / 2, y + h * 0.78, y + h, null, true);
    kit.set(GLASS, K.glassDark);
    const band = { cols: Math.round(len / 1.6), rows: [{ y: 0, h: h * 0.5, w: 1.45, hex: GLASS, glow, rev: 0, dark: true, nx: 1, ny: 2 }], seed: k + y };
    kit.set(SILVER, K.metal);
    S.box(-len / 2 + 0.1, len / 2 - 0.1, -dep / 2 + 0.1, dep / 2 - 0.1, y + h * 0.28, y + h * 0.78, { f: band, l: band, r: band, b: band }, false);
  }
}

export function buildZizkov(kit, f) {
  const F = zizkovFrame(kit, kit.ground);
  kit.floodFn = (x, y) => 0.35;
  // the entrance building on the real outline
  kit.set(0x9fa3a5, K.metal);
  kit.ringWalls(f.o, 0, 5.5, (e) => (e.len < 3 ? null : { pitch: 2.2, inset: 0.3, rows: [{ y: 0.4, h: 3.8, w: 1.9, hex: GLASS, glow: 0.4, rev: 0.1, dark: true }], seed: e.i }));
  kit.set(0x55585a, K.metal);
  kit.cap(f.o, f.i, 5.5, true);
  // the tubes
  kit.set(CONC, K.plaster);
  for (const [u, v, r, top] of TUBES) {
    const [x, z] = F.xz(u, v);
    kit.lathe(x, z, [[r * 1.08, F.y - 0.3], [r, F.y + 6], [r, F.y + top], [0, F.y + top]], 12);
  }
  for (const [y, h, len, dep] of PODS) pods(kit, F, y, h, len, dep, y < 70 ? 0.6 : 0.4);
  // the radome and the antenna
  const [mx, mz] = F.xz(TUBES[0][0], TUBES[0][1]);
  kit.set(WHITE, K.plaster);
  kit.lathe(mx, mz, [[3.6, F.y + 132], [3.6, F.y + 172], [2.4, F.y + 175], [1.0, F.y + 176]], 12);
  for (let i = 0; i < 8; i++) {
    kit.set(i % 2 ? WHITE : RED, K.metal);
    kit.lathe(mx, mz, [[0.75 - i * 0.06, F.y + 176 + i * 5], [0.7 - i * 0.06, F.y + 181 + i * 5]], 6);
  }
  kit.set(RED, K.metal);
  kit.lathe(mx, mz, [[0.25, F.y + 216 - 1], [0, F.y + 216]], 4);
  // Černý's babies, crawling up the tubes
  kit.set(0x2b2a26, K.metal);
  for (let i = 0; i < 6; i++) {
    const t = TUBES[i % 3], a = 1.3 + hash2(i, 5, 3) * 4, y = 22 + i * 9 + hash2(i, 2, 7) * 6;
    const [cx, cz] = F.xz(t[0], t[1]);
    const x = cx + Math.cos(a) * (t[2] + 0.5), z = cz + Math.sin(a) * (t[2] + 0.5);
    kit.lathe(x, z, [[0, F.y + y], [0.5, F.y + y + 0.4], [0.6, F.y + y + 1.4], [0.42, F.y + y + 2.2], [0.5, F.y + y + 2.7], [0, F.y + y + 3.4]], 6);
  }
}

/** Solid: the entrance building, the tubes to their tops, and the cabins (walked under: bot > 0). */
export function zizkovSolids(f, l) {
  const g = f._gy ?? ZIZKOV.ground;
  const F = zizkovFrame(null, g), dy = F.y;
  const circ = (u, v, r) => { const out = []; for (let i = 0; i < 10; i++) { const a = i * Math.PI / 5; out.push(F.xz(u + Math.cos(a) * r, v + Math.sin(a) * r)); } return out; };
  const out = [{ ring: f.o, holes: f.i ?? null, top: l.top, bot: 0 }];
  for (const [u, v, r, top] of TUBES) out.push({ ring: circ(u, v, r), holes: null, top: dy + top, bot: 0 });
  for (const [y, h] of PODS) out.push({ ring: circ(CABIN_C[0], CABIN_C[1], 9.5), holes: null, top: dy + y + h, bot: dy + y });
  return out;
}

/** For the far skyline: tubes, cabins, radome, antenna. */
export function zizkovFar(kit, F) {
  kit.set(CONC, K.plaster);
  for (const [u, v, r, top] of TUBES) { const [x, z] = F.xz(u, v); kit.lathe(x, z, [[r, 0], [r, top], [0, top]], 8); }
  for (const [y, h, len, dep] of PODS) for (let k = 0; k < 3; k++) {
    const a = k * 2 * Math.PI / 3 + Math.PI;
    const S = F.sub(CABIN_C[0] + Math.sin(a) * 4.8, CABIN_C[1] + Math.cos(a) * 4.8, 0, a);
    kit.set(SILVER, K.metal); S.box(-len / 2, len / 2, -dep / 2, dep / 2, y, y + h);
  }
  const [mx, mz] = F.xz(TUBES[0][0], TUBES[0][1]);
  kit.set(WHITE, K.plaster);
  kit.lathe(mx, mz, [[3.6, 132], [3.6, 172], [1.0, 176]], 8);
  kit.set(RED, K.metal);
  kit.lathe(mx, mz, [[0.8, 176], [0.3, 216], [0, 216.5]], 4);
}
