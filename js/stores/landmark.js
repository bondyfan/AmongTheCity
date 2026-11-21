// ---- stores/landmark.js: a chain store as a landmark of the chunk mesher ----
// WORKER SAFE. js/landmarks.js asks storeLandmark(f) for every building that is
// no hand-made landmark. A standalone store of a known chain (js/stores/chains.js)
// answers with an entry shaped like the hand-made ones: the generic building is
// then skipped by the far mesh and by the destructible interiors, and the
// store's own generator (js/stores/build.js) draws it in every tier.

import { CHAINS, STORES, storeChain, chainOfName } from './chains.js';
import { buildStore, storeSolids } from './build.js';
import { siteOf, around } from './site.js';
import { driveOf } from './drive.js';
import { pickShowFront } from './showlayout.js';

/** One landmark entry per chain: `id` is what a feature remembers (`_lm`). */
export const STORE_LANDMARKS = CHAINS.map((chain) => ({
  id: 'store:' + chain.id, store: true, chain,
  top: Math.max(chain.arch.hF, chain.arch.hB ?? 0),
  build: buildStore,
  solids: (f, l) => storeSolids(f, l, null),
}));
const BY_CHAIN = new Map(STORE_LANDMARKS.map((l) => [l.chain.id, l]));

/** The store entry of a building, or null. */
export function storeLandmark(f) {
  const c = storeChain(f);
  return c ? BY_CHAIN.get(c.id) : null;
}

/**
 * Decide, on the main thread, everything about a cell's stores that both
 * builds must agree on and that depends on the cell's roads: which wall is the
 * front and where the drive-through is. The answers are plain memos on the
 * feature, so they travel to the mesh worker in the chunk's inputs.
 */
export function pinStores(cell) {
  if (!cell?.buildings) return;
  for (const f of cell.buildings) {
    if (!f.n || f._lm === '') continue;
    // switched off (a before-and-after measurement): say so in the memo the
    // worker reads, or its own copy of the switch would still build the store
    if (!STORES.on) { if (f._lm === undefined && chainOfName(f.n)) f._lm = ''; continue; }
    const c = storeChain(f);
    if (!c) continue;
    // a showroom's gate goes where a car can stand behind it (js/stores/showlayout.js)
    if (c.kind === 'showroom' && f._sf === undefined) {
      const i = pickShowFront(f, c, around(f, cell));
      if (i >= 0) f._sf = i;
    }
    siteOf(f, c, cell);
    if (c.eat?.drive) driveOf(f, around(f, cell)?.roads);
  }
}
