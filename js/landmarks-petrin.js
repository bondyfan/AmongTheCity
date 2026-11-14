// ---- landmarks-petrin.js: the Petřín lookout tower ----
// Built for the Jubilee Exhibition of 1891 after the Eiffel tower, at a fifth
// of its height but on a hill 135 m over the river, so its top stands as
// high as the Paris one: an octagonal truncated pyramid of riveted lattice,
// painted rusty red-brown, round a tube that carries the two spiral stairs,
// with a gallery a third of the way up and the upper one under the lantern.
//
// The tile has its octagonal footprint (way 7645353, 27.7 m across), which is
// where the legs come down; the small entrance pavilion stands among them.
// Collision is the pavilion, the core and the two decks (walked under).

import { K } from './landmarkskit.js';
import { strut } from './landmarks-prahaparts.js';
import { ringCentroid } from './landmarkskit.js';

const STEEL = 0x7b3a2b, STEEL_DK = 0x5e2c21, DECK = 0x6b5444;
const R0 = 12.4, R1 = 3.5, TOP = 52, CORE = 1.9, CORE_TOP = 56, TIP = 63.5;
const DECKS = [[20, 8.6], [TOP, 4.6]];          // y, radius
const PHASE = Math.PI / 8;

const rAt = (y) => R0 + (R1 - R0) * (y / TOP);
const leg = (cx, cz, i, y) => { const a = PHASE + i * Math.PI / 4, r = rAt(y); return [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r]; };

export function buildPetrin(kit, f) {
  const [cx, cz] = ringCentroid(f.o);
  kit.floodFn = (x, y) => (y < 30 ? 0.7 : 0.55);
  // the pavilion among the legs
  kit.set(0xd9cdb2, K.plaster);
  const pav = kit.offsetRing(f.o, 5.5);
  kit.ringWalls(pav, 0, 3.8, (e) => (e.len < 2.5 ? null : { pitch: 2.6, inset: 0.3, rows: [{ y: 0.3, h: 2.6, w: 1.5, arch: 1, hex: 0x4a5560, glow: 0.4, rev: 0.15 }], seed: e.i }));
  kit.set(0x6d4a3a, K.tile);
  kit.lathe(cx, cz, [[8.4, 3.8], [3.5, 5.6], [0, 5.9]], 8, PHASE);
  // the lattice: eight legs, a ring every tier, crossed diagonals in every panel
  kit.set(STEEL, K.metal);
  const tiers = [0, 7, 14, 20, 27, 34, 41, 47, TOP];
  for (let t = 0; t + 1 < tiers.length; t++) {
    const y0 = tiers[t], y1 = tiers[t + 1];
    for (let i = 0; i < 8; i++) {
      const a0 = leg(cx, cz, i, y0), a1 = leg(cx, cz, i, y1), b0 = leg(cx, cz, (i + 1) % 8, y0), b1 = leg(cx, cz, (i + 1) % 8, y1);
      kit.set(STEEL_DK, K.metal);
      strut(kit, a0, a1, 0.42, 4);
      kit.set(STEEL, K.metal);
      strut(kit, a1, b1, 0.18, 4);
      strut(kit, a0, b1, 0.12, 4);
      strut(kit, b0, a1, 0.12, 4);
    }
  }
  // the core: the stair tube to the lantern
  kit.set(STEEL_DK, K.metal);
  kit.lathe(cx, cz, [[CORE, 0], [CORE, CORE_TOP]], 8, PHASE);
  // the galleries: decks and railings
  for (const [y, r] of DECKS) {
    kit.set(DECK, K.wood);
    kit.lathe(cx, cz, [[0, y - 0.35], [r, y - 0.35], [r, y], [0, y]], 8, PHASE);
    kit.set(STEEL, K.metal);
    kit.lathe(cx, cz, [[r, y], [r, y + 1.1], [r - 0.06, y + 1.1]], 8, PHASE);
  }
  // the lantern and its little roof
  kit.set(0xd6cdb8, K.plaster);
  kit.lathe(cx, cz, [[3.0, TOP], [3.0, CORE_TOP + 2]], 8, PHASE);
  kit.set(STEEL_DK, K.metal);
  kit.lathe(cx, cz, [[3.4, CORE_TOP + 2], [1.4, CORE_TOP + 4.8], [0.3, TIP - 0.8], [0, TIP]], 8, PHASE);
}

/** Solid: the pavilion, the core tube, and the two decks over people's heads. */
export function petrinSolids(f, l) {
  const [cx, cz] = ringCentroid(f.o);
  const oct = (r) => { const out = []; for (let i = 0; i < 8; i++) { const a = PHASE + i * Math.PI / 4; out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]); } return out; };
  return [{ ring: oct(8.2), holes: null, top: l.top, bot: 0 }, { ring: oct(CORE), holes: null, top: CORE_TOP, bot: 0 },
    ...DECKS.map(([y, r]) => ({ ring: oct(r), holes: null, top: y, bot: y - 0.4 }))];
}

/** For the far skyline: the frustum of the lattice as four see-through sides of struts, the lantern. */
export function petrinFar(kit, F) {
  const cx = F.ox, cz = F.oz;
  kit.set(STEEL, K.metal);
  for (let i = 0; i < 8; i++) strut(kit, leg(cx, cz, i, 0), leg(cx, cz, i, TOP), 0.7, 4);
  for (const y of [14, 27, 41, TOP]) for (let i = 0; i < 8; i++) strut(kit, leg(cx, cz, i, y), leg(cx, cz, (i + 1) % 8, y), 0.45, 4);
  for (const [y, r] of DECKS) kit.lathe(cx, cz, [[0, y - 0.4], [r, y - 0.4], [r, y + 1], [0, y + 1]], 8, PHASE);
  kit.lathe(cx, cz, [[CORE, 0], [CORE, CORE_TOP]], 6, PHASE);
  kit.lathe(cx, cz, [[3.4, CORE_TOP + 2], [0, TIP]], 8, PHASE);
}
