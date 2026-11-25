// ==========================================================================
// pocket.js: what is in somebody's pocket, for the fist that robs them
//
// Split out of js/combat.js (Nov 2026), which re-exports pocketOf so the
// callers and tests that import it from there keep working.
//
// ---- MONEY, AND THE WALL CLOCK THAT IS NOT IN IT ---------------------------
//
// What is in somebody's pocket is a pure function of their pid and of
// js/prices.js, so two clients rob the same body for the same koruny and a
// test can assert an exact figure: 94 % carry 40 + 189 u^2 Kc, 6 % carry
// 242 + 658 u (measured mean 131 Kc over 200 000 pids). It is paid once, on the
// killing blow, through the wallet; `_robbed` is stamped on the body.
//
// ==========================================================================

import { PRICE } from './prices.js';

// Byte-identical to the hash in js/pedestrians.js, js/traffic.js,
// js/chatter.js and js/fuel.js, duplicated for the reason every one of them
// gives: the deterministic layers must be pure functions of the same integers,
// and a shared import somebody later "optimises" would silently re-roll the
// world. A non-integer argument becomes 0 through `| 0`.
function hash32(a, b = 0, c = 0, d = 0, e = 0, f = 0) {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < 6; i++) {
    let k = (i === 0 ? a : i === 1 ? b : i === 2 ? c : i === 3 ? d : i === 4 ? e : f) | 0;
    k = Math.imul(k, 0xcc9e2d51); k = (k << 15) | (k >>> 17); k = Math.imul(k, 0x1b873593);
    h ^= k; h = (h << 13) | (h >>> 19); h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}
const rnd01 = (h) => (h >>> 8) / 16777216;
const S_CASH = 0xca51;      // which kind of pocket this is
const S_DRAW = 0xca52;      // …and how much is in it

// ---- money ----------------------------------------------------------------
const POCKET = PRICE.job.pocket;
const P_MIN = POCKET.min;
const P_SPAN = POCKET.max - POCKET.min;
const P_FAT = POCKET.fat;
const LEAN_K = 0.22;
const FAT_K = 0.235;

/**
 * How much cash this pedestrian is carrying, in whole koruny: a pure function
 * of their pid and of js/prices.js, with no clock anywhere in it.
 */
export function pocketOf(pid) {
  const id = Number.isInteger(pid) ? pid : 0;
  const u = rnd01(hash32(id, S_DRAW));
  const k = rnd01(hash32(id, S_CASH)) < P_FAT
    ? FAT_K + (1 - FAT_K) * u
    : LEAN_K * u * u;
  return Math.round(P_MIN + P_SPAN * k);
}
