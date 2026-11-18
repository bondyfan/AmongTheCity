// ---- landmarks-certovka.js: the mill wheel on the Čertovka ----
// WORKER SAFE (a footprint-less landmark, js/landmarks.js EXTRAS).
//   The wheel of the Velkopřevorský mlýn on Kampa: a big wooden undershot
//   wheel on the Čertovka, hung from the east wall of the mill over the
//   channel, the picture every visitor to the Lennon wall's corner takes. The
//   tile has it as a point ("kolo Velkopřevorského mlýna", tile -21_-2), 2.4 m
//   out from the mill's wall line (OSM building "Velkopřevorský mlýn"), and
//   nothing to draw. Here: two rims, eight spokes a side, sixteen paddles, a
//   hub and the axle back into the wall, its foot 0.6 m in the water of the
//   channel (js/riverpools.js, the Čertovka's own level). Static; about 700
//   triangles. Built by the chunk the wheel's centre lies in.

import { K } from './landmarkskit.js';
import { riverLevelAt } from './riverpools.js';

export const MLYN_KOLO = [-96618.5, -6065.2];
// the channel's west bank along the mill (tile -21_-2, the Čertovka ring):
// the wheel turns in the plane of the flow, its axle square to the bank
const BANK = [[-96621.3, -6058.9], [-96618.2, -6103.7]];
const R = 3.0, WIDTH = 1.0, SUNK = 0.6;      // m
const RIM_D = 0.24, RIM_T = 0.12, SEG = 24, SPOKES = 8, PADDLES = 16;

// the Čertovka's level at the wheel, as the water surface itself reads it
const WATER = riverLevelAt({ _rp: 'certovka' }, MLYN_KOLO[0], MLYN_KOLO[1]);

const WOOD = 0x4a3b2c, WOOD_DK = 0x3a2f24, IRON = 0x2e2d2b;

export function buildMlynskeKolo(kit, ctx) {
  const [cx, cz] = MLYN_KOLO;
  if (ctx.chunkOf(cx, cz) !== ctx.key) return;
  kit.ground = 0;
  kit.ao = false;
  // t along the bank (in the wheel's plane), a square to it toward the water
  const bl = Math.hypot(BANK[1][0] - BANK[0][0], BANK[1][1] - BANK[0][1]);
  const tx = (BANK[1][0] - BANK[0][0]) / bl, tz = (BANK[1][1] - BANK[0][1]) / bl;
  const ax = -tz, az = tx;                        // east, into the channel
  const yc = WATER - SUNK + R;
  // a point of the wheel: x along the axle from the centre plane, at angle q, radius r
  const P = (x, q, r) => [cx + ax * x + tx * Math.cos(q) * r, yc + Math.sin(q) * r, cz + az * x + tz * Math.cos(q) * r];
  const rad = (q) => [tx * Math.cos(q), Math.sin(q), tz * Math.cos(q)];   // outward at q
  const step = 2 * Math.PI / SEG;
  // the two rims: a box section run round the wheel
  kit.set(WOOD_DK, K.wood);
  for (const xr of [-WIDTH / 2 + RIM_T / 2, WIDTH / 2 - RIM_T / 2]) {
    const x0 = xr - RIM_T / 2, x1 = xr + RIM_T / 2, r0 = R - RIM_D;
    for (let i = 0; i < SEG; i++) {
      const q0 = i * step, q1 = q0 + step, o = rad(q0 + step / 2);
      kit.quad(P(x0, q0, R), P(x1, q0, R), P(x1, q1, R), P(x0, q1, R), o[0], o[1], o[2]);
      kit.quad(P(x0, q0, r0), P(x1, q0, r0), P(x1, q1, r0), P(x0, q1, r0), -o[0], -o[1], -o[2]);
      kit.quad(P(x0, q0, r0), P(x0, q0, R), P(x0, q1, R), P(x0, q1, r0), -ax, 0, -az);
      kit.quad(P(x1, q0, r0), P(x1, q0, R), P(x1, q1, R), P(x1, q1, r0), ax, 0, az);
    }
  }
  // the spokes, hub to rim, on each rim's plane
  kit.set(WOOD, K.wood);
  const sp = 0.05;
  for (const xr of [-WIDTH / 2 + RIM_T / 2, WIDTH / 2 - RIM_T / 2]) {
    for (let i = 0; i < SPOKES; i++) {
      const q = i * 2 * Math.PI / SPOKES + step / 2, w = sp / R;
      // a square bar: its two faces across the wheel and its two along the axle
      const rIn = 0.3, rOut = R - RIM_D + 0.02, dq = (r) => sp / r;
      const a0 = P(xr - sp, q - dq(rIn), rIn), a1 = P(xr + sp, q - dq(rIn), rIn);
      const b0 = P(xr - sp, q - w, rOut), b1 = P(xr + sp, q - w, rOut);
      const c0 = P(xr - sp, q + dq(rIn), rIn), c1 = P(xr + sp, q + dq(rIn), rIn);
      const d0 = P(xr - sp, q + w, rOut), d1 = P(xr + sp, q + w, rOut);
      const tq = [-tx * Math.sin(q), Math.cos(q), -tz * Math.sin(q)];   // along the turn
      kit.quad(a0, b0, b1, a1, -tq[0], -tq[1], -tq[2]);
      kit.quad(c0, d0, d1, c1, tq[0], tq[1], tq[2]);
      kit.quad(a0, b0, d0, c0, -ax, 0, -az);
      kit.quad(a1, b1, d1, c1, ax, 0, az);
    }
  }
  // the paddles: boards rim to rim, standing out past the rims
  kit.set(WOOD, K.wood);
  const pr0 = R - 0.55, pr1 = R + 0.18, pt = 0.03 / R;
  for (let i = 0; i < PADDLES; i++) {
    const q = i * 2 * Math.PI / PADDLES, tq = [-tx * Math.sin(q), Math.cos(q), -tz * Math.sin(q)], o = rad(q);
    const xa = -WIDTH / 2, xb = WIDTH / 2;
    kit.quad(P(xa, q - pt, pr0), P(xb, q - pt, pr0), P(xb, q - pt, pr1), P(xa, q - pt, pr1), -tq[0], -tq[1], -tq[2]);
    kit.quad(P(xa, q + pt, pr0), P(xb, q + pt, pr0), P(xb, q + pt, pr1), P(xa, q + pt, pr1), tq[0], tq[1], tq[2]);
    kit.quad(P(xa, q - pt, pr1), P(xb, q - pt, pr1), P(xb, q + pt, pr1), P(xa, q + pt, pr1), o[0], o[1], o[2]);
    kit.quad(P(xa, q - pt, pr0), P(xb, q - pt, pr0), P(xb, q + pt, pr0), P(xa, q + pt, pr0), -o[0], -o[1], -o[2]);
  }
  // the hub and the axle into the mill's wall (the bank line, 2.4 m back)
  const wallX = -((cx - BANK[0][0]) * ax + (cz - BANK[0][1]) * az) - 0.4;
  for (const [x0, x1, r, hex] of [[-WIDTH / 2 - 0.05, WIDTH / 2 + 0.05, 0.34, WOOD_DK], [wallX, WIDTH / 2 + 0.25, 0.13, IRON]]) {
    kit.set(hex, hex === IRON ? K.metal : K.wood);
    for (let i = 0; i < 8; i++) {
      const q0 = i * Math.PI / 4, q1 = q0 + Math.PI / 4, o = rad(q0 + Math.PI / 8);
      kit.quad(P(x0, q0, r), P(x1, q0, r), P(x1, q1, r), P(x0, q1, r), o[0], o[1], o[2]);
    }
  }
}

/** The entry for js/landmarks.js EXTRAS (through js/landmarks-praha.js EXTRAS_OLD). */
export const MLYN_KOLO_EXTRA = { id: 'certovka-kolo', region: 'praha',
  box: [MLYN_KOLO[0] - 6, MLYN_KOLO[1] - 6, MLYN_KOLO[0] + 6, MLYN_KOLO[1] + 6], build: buildMlynskeKolo };
