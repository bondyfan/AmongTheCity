// ---- landmarks-farset.js: the other silhouettes of the far skyline ----
// WORKER SAFE (pure kit), used by js/landmarksfar.js. The Old Town's two
// towers (whose near models js/landmarks-staromak.js and -tyn.js build, from
// the heights published in that survey), and the far halves of the wide
// landmarks whose near builders export one.

import { K } from './landmarkskit.js';
import { GOLD } from './landmarks-parts.js';
import { nmFar } from './landmarks-nm.js';
import { zizkovFar, ZIZKOV } from './landmarks-zizkov.js';
import { petrinFar } from './landmarks-petrin.js';
import { vysehradFar } from './landmarks-vysehrad.js';

const DARK_STONE = 0x4a4642, SLATE = 0x3a3d40;

/** Týn: two 80 m towers over the square, each a dark spire with four turrets, and the steep nave roof. */
function tynFar(kit, F) {
  kit.set(0x8b8478, K.stone);
  F.box(-17, 17, -30, 20, 0, 20);
  kit.set(SLATE, K.slate);
  F.roof(-15, 15, -30, 20, 20, 44, { alongV: true, over: 0.3 });
  for (const uc of [-8, 8]) {
    kit.set(DARK_STONE, K.stone);
    F.box(uc - 3.6, uc + 3.6, 20, 27.5, 0, 50);
    const [x, z] = F.xz(uc, 23.75);
    kit.set(SLATE, K.slate);
    kit.lathe(x, z, [[3.4, 50], [3.0, 54], [0.5, 77], [0, 80]], 4, Math.PI / 4);
    for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const [tx, tz] = F.xz(uc + du * 3.2, 23.75 + dv * 3.2);
      kit.lathe(tx, tz, [[0.9, 50], [0.9, 53], [0, 62]], 4, Math.PI / 4);
    }
    kit.set(GOLD, K.metal);
    kit.lathe(x, z, [[0, 79], [0.6, 80], [0, 81]], 6);
  }
}

/** The Old Town Hall tower: an 11 m stone shaft to the gallery at 42.5, its four corner oriels and the steep roof to 69.5. */
function vezFar(kit, F) {
  kit.set(0x9a9284, K.stone);
  F.box(-5.6, 5.6, -5.4, 5.4, 0, 42.5);
  kit.set(0x80786c, K.stone);
  F.box(-6.3, 6.3, -6.1, 6.1, 42.5, 45);
  kit.set(SLATE, K.slate);
  F.pyramid(-5.8, 5.8, -5.6, 5.6, 45, 66, 0.1);
  for (const [du, dv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const [x, z] = F.xz(du * 5.6, dv * 5.4);
    kit.lathe(x, z, [[1.1, 43], [1.1, 47], [0, 55]], 6);
  }
  const [x, z] = F.xz(0, 0);
  kit.lathe(x, z, [[0.5, 66], [0, 69.5]], 4);
}

export const FAR_EXTRA = [
  { id: 'tyn', ground: 192.7, frame: [-95532.0, -6227.9, -0.954, 0.301], box: [-95565, -6262, -95500, -6195], build: tynFar },
  { id: 'nm', ground: 216.6, frame: [-94945.68, -5250.54, -0.6663, -0.7457], box: [-95005, -5310, -94885, -5190], build: nmFar },
  { id: 'zizkov', ground: ZIZKOV.ground, frame: [...ZIZKOV.at, ...ZIZKOV.front], box: [-93525, -5505, -93480, -5465], build: zizkovFar, flood: () => 0.35 },
  { id: 'petrin', ground: 322.14, frame: [-97513.59, -5761.81, -0.6549, -0.7557], box: [-97528, -5776, -97499, -5747], build: petrinFar },
  { id: 'vysehrad', ground: 227.73, frame: [-95881.20, -3639.19, -0.9988, -0.0483], box: [-95912, -3657, -95852, -3622], build: vysehradFar, flood: (x, y) => 0.7 },
  { id: 'radnice-vez', ground: 192.1, frame: [-95680.9, -6155.2, 0.405, 0.914], box: [-95730, -6175, -95660, -6125], build: vezFar },
];
