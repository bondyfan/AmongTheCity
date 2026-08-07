// ---- how wide the streaming window may be, and how it is spent -------------
// Three rings. `view` is FULL detail; `shell` adds a band of ground-and-
// buildings beyond it; `far` a band of ground alone. Altitude decides how far
// you can SEE; speed decides how fast the far edge has to move; and this file
// is where those two arguments are settled against what the machine can hold.
//
// MEASURED, 169 real Pardubice cells (scratch harness, node, facades on):
//
//   tier     mesh time              geometry     draw calls
//   ground   0.69 ms                  211 kB        1.0
//   shell    2.4 ms                   258 kB        2.0
//   full     26.5 + 0.096·features    950 kB        4.9     (160 ms worst)
//
// The mesher pool absorbs the FIRST column and NEITHER OF THE OTHER TWO, and
// that is the whole reason this file exists. Ring area grows quadratically, so
// the old rule — every ring scaled by one saturating `climb` term — asked for
// 69 × 69 = 4761 cells at full climb: 1.39 GB of vertex buffers and ~7700 draw
// calls, beside a 640 MB photo cache. It only ever looked survivable because
// the streamer could not fill it, and not filling it IS the reported bug.
//
// So: the widest window the altitude rule already asks for is the CEILING for
// every window any rule may ask for. Speed may re-spend that budget — trading
// full-detail rings for coverage, which is the trade a fast aircraft wants —
// but it may never enlarge it. Nothing here can cost more than what ships.
//
// (WORTH KNOWING, not fixed here: 211 kB for a ground cell is a 30 × 30
// non-indexed terrain drape at 4 m spacing, held at that density out to the
// fog. Tessellating the far ring coarsely is the one change that would buy
// back real VRAM, and it belongs in meshes.js, not in a ring plan.)

import { CHUNK } from './config.js';

// The altitude caps, unchanged: what a helicopter at 300 m gets today.
export const AIR_VIEW = 10, AIR_SHELL = 10, AIR_FAR = 14;
const FULL_ALT = 300;                  // m AGL at which the air rings are fully out

// Seconds of world in front of the nose. This is the number that used to
// saturate: `Math.min(1, speed / 260)` meant nothing grew past 936 km/h, which
// is exactly the cliff the report describes. A horizon in SECONDS cannot
// saturate — it is the budget above that stops it, and it stops it with a
// reason attached.
const HORIZON_S = 6;

// Where full detail starts giving way to coverage, in m/s. Detail you cross in
// under a second is detail nobody sees: at 420 m/s a cell ten rings out is on
// screen for 2.9 s at the very edge of a motion-blurred frame, and it costs 4.5
// ground cells. Below 140 m/s (504 km/h) nothing changes at all — that is above
// every car and every helicopter in the game.
const DETAIL_FADE_LO = 140, DETAIL_FADE_HI = 420;

const cells = (r) => (2 * r + 1) * (2 * r + 1);
const CELL_KB = { ground: 211, shell: 258, full: 950 };
const CELL_DRAWS = { ground: 1.0, shell: 2.0, full: 4.9 };

/** What a window of these three rings costs the GPU. */
export function windowCost(view, shell, far) {
  const nFull = cells(view);
  const nShell = cells(view + shell) - nFull;
  const nGround = cells(view + shell + far) - cells(view + shell);
  return {
    cells: nFull + nShell + nGround,
    kb: nFull * CELL_KB.full + nShell * CELL_KB.shell + nGround * CELL_KB.ground,
    draws: nFull * CELL_DRAWS.full + nShell * CELL_DRAWS.shell + nGround * CELL_DRAWS.ground,
  };
}

/** The ceiling: the widest window the altitude rule already asks for. */
export const WINDOW = windowCost(AIR_VIEW, AIR_SHELL, AIR_FAR);

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/**
 * The three rings for a machine at `speed` m/s and `agl` metres above ground.
 * `base` is the player's own draw-distance setting, which is a floor on the
 * full-detail ring: it is the one number here the player chose, so the trim
 * below will overrun the budget rather than take it away.
 */
export function planRings(speed, agl, base = 6) {
  const climb = clamp01((agl ?? 0) / FULL_ALT);
  const viewAlt = Math.max(base, Math.round(base + (AIR_VIEW - base) * climb));
  // The shell ring opens FASTER than the others (√climb): altitude is not what
  // makes you see far, ANGLE is. At 120 m over a village you are already
  // looking a kilometre and a half down the valley, and that is exactly the
  // height at which the missing houses were reported.
  const shellAlt = Math.round(AIR_SHELL * Math.sqrt(climb));
  const farAlt = Math.round(AIR_FAR * climb);

  // FULL detail contracts with speed, coverage extends with it. Both are the
  // same decision: at 555 m/s the frontier of the full ring alone asks for
  // (2·view+1) × 4.6 cells a second, and at 26–160 ms each that is several
  // seconds of meshing per second of flight — so the near ring is what has to
  // give, or nothing else gets built at all.
  const rush = clamp01((speed - DETAIL_FADE_LO) / (DETAIL_FADE_HI - DETAIL_FADE_LO));
  let view = Math.max(base, Math.round(viewAlt - (viewAlt - base) * rush));
  let shell = shellAlt;
  // The outer edge is the further of what you can see from up here and what you
  // will have crossed in HORIZON_S seconds.
  const outer = Math.max(viewAlt + shellAlt + farAlt,
    Math.round((speed * HORIZON_S) / CHUNK));
  let far = Math.max(0, outer - view - shell);

  // …and now it has to fit. Give up the OUTER EDGE first, then the buildings
  // band, and the near full-detail ring last: a window that ends closer is a
  // hazier horizon, a window with no coverage is the hole under the nose.
  for (let guard = 0; guard < 200; guard++) {
    const c = windowCost(view, shell, far);
    if (c.kb <= WINDOW.kb && c.draws <= WINDOW.draws) break;
    if (far > 0) far--;
    else if (shell > 0) shell--;
    else if (view > base) view--;
    else break;                          // the player's own setting: leave it
  }
  return { view, shell, far };
}
