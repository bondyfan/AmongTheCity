// ---- Mahé's own pieces, in one place for main.js ----
// main.js knows the island through this one module, imported only when the
// page is Mahé (js/regions.js), so a Czech game loads none of it. It builds the
// landmarks of Victoria and the granite, and once a second stands them on any
// terrain tile that arrived after them.

import { buildLandmarks, settleLandmarks } from './landmarks.js';
import { buildBoulders, settleBoulders } from './boulders.js';

export async function initIsland({ scene, world }) {
  const terrain = world?.terrain;
  let marks = null, rocks = null, t = 0, loads = -1;
  [marks, rocks] = await Promise.all([
    buildLandmarks(scene, terrain).catch((e) => { console.warn('[mahe] landmarks', e); return null; }),
    buildBoulders(scene, terrain).catch((e) => { console.warn('[mahe] granite', e); return null; }),
  ]);
  return {
    update(dt) {
      t += dt;
      if (t < 1) return;
      t = 0;
      // only when a height map has landed since the last look
      if (terrain && terrain._loads !== loads) {
        loads = terrain._loads;
        settleLandmarks(marks, terrain);
        settleBoulders(rocks, terrain);
      }
    },
  };
}
