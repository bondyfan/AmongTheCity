// ---- landmarks.js: the buildings that make Pardubice Pardubice, by hand ----
// WORKER SAFE (it is in the mesher's import graph through js/meshes.js).
//
// The generic typology dresses every footprint as a house, a block or a shed,
// which is right for nine thousand buildings and wrong for the dozen a local
// finds his way by. Those are modelled here in code, each ON its real footprint
// out of the tile, so the Green Gate stands exactly where the Green Gate does.
//
// HOW A FOOTPRINT IS RECOGNISED. Never by its place in a tile array (a rebuild
// reorders them) and never by name alone (the station has none in OSM): by
// where its centroid is and how big it is, and, when both sides carry a name,
// by the name agreeing. A rebuilt tile that moved a corner by a metre still
// matches; one that redrew the building does not, and it falls back to the
// generic house rather than wearing a model that no longer fits it.
//
// WHAT A LANDMARK REPLACES. Its whole generic self: the far mesh skips it
// (meshes.js buildBuildingsMesh) and it never gets a near shell or an interior
// (interiorsim.js), so there is one model at every distance and nothing to
// z-fight with. Collision is the landmark's own solids (landmarkSolids, read by
// city.js collide, roofY and buildingHitAt): the footprint to the height of the
// MODEL's walls, not to the tile's guess, and in pieces where one prism would
// lie (the two gates have a passage, the station a hotel twice its hall).

import { LandmarkSink, Kit, ringArea, ringCentroid, prism } from './landmarkskit.js';
import { buildBrana, buildPredbrani, branaSolids } from './landmarks-brana.js';
import { buildZamek, zamekSolids } from './landmarks-zamek.js';
import { buildZamekBrana, zamekBranaSolids } from './landmarks-zamekbrana.js';
import { buildValy, isValyBarrier } from './landmarks-valy.js';
import { buildNadrazi, nadraziSolids } from './landmarks-nadrazi.js';
import { buildRadnice, radniceSolids } from './landmarks-radnice.js';
import { buildBartolomej, buildZvestovani, buildJan, buildZvonice } from './landmarks-kostely.js';
import { buildMlyny, buildSilo, buildMost, mlynySolids } from './landmarks-mlyny.js';
import { buildDivadlo, divadloSolids } from './landmarks-divadlo.js';

/**
 * id: stable key. name: OSM name it must agree with when the feature has one.
 * at: centroid in world metres. area: footprint in square metres.
 * r / tol: how far the centroid and how much the area may drift (defaults 9 m, 30 %).
 * top: how high the model is SOLID, metres above its ground: the top of its
 *   (lowest) walls, as for every other building: roofs and spires are flown
 *   through. The tile's own height is a guess from a tag, up to 13 m off.
 * solids: for a model one prism cannot stand for, (f, l) => all its pieces.
 * grounds: what the landmark owns BEYOND its footprint (the chateau's rampart
 *   wall and bridge), built with it when the builder has the terrain to stand
 *   it on. (kit) => void.
 */
export const LANDMARKS = [
  { id: 'zelena-brana', name: 'Zelená brána', at: [1565.4, -700.4], area: 70, top: 38, build: buildBrana, solids: branaSolids },
  { id: 'predbrani', at: [1555.1, -695.4], area: 86, r: 5, top: 10, build: buildPredbrani, solids: branaSolids },
  { id: 'zamek', name: 'zámek Pardubice', at: [1462.2, -1021.4], area: 3512, r: 15, top: 13.6, build: buildZamek, solids: zamekSolids, grounds: buildValy },
  // the gatehouse in the east rampart: unnamed, the only 80 m2 footprint the road from Příhrádek runs into
  { id: 'zamek-brana', at: [1532.0, -1041.3], area: 81, r: 4, top: 7, build: buildZamekBrana, solids: zamekBranaSolids },
  // no name in OSM: the only 7 400 m2 footprint on the forecourt
  { id: 'nadrazi', at: [6.8, -74.2], area: 7444, r: 20, top: 7.3, build: buildNadrazi, solids: nadraziSolids },
  { id: 'radnice', name: 'Magistrát města Pardubic', at: [1621.8, -800.6], area: 1882, r: 12, top: 15.2, build: buildRadnice, solids: radniceSolids },
  { id: 'bartolomej', name: 'Svatý Bartoloměj', at: [1521.7, -790.5], area: 702, top: 14.5, build: buildBartolomej },
  { id: 'zvonice', at: [1541.7, -751.8], area: 100, r: 5, top: 20, build: buildZvonice },
  { id: 'zvestovani', name: 'Zvěstování Panny Marie', at: [1759.2, -745.4], area: 470, top: 12.5, build: buildZvestovani },
  { id: 'jan-krtitel', name: 'sv. Jana Křtitele', at: [1095.1, -450.0], area: 325, top: 9.5, build: buildJan },
  { id: 'mlyny', name: 'Gočárova galerie', at: [1826.6, -1118.1], area: 1391, r: 12, top: 20.4, build: buildMlyny, solids: mlynySolids },
  { id: 'silo', name: 'silo', at: [1853.8, -1088.6], area: 322, r: 8, top: 29, build: buildSilo },
  // the bridge between them is a skyway in the tile (y 12.4): `sky` lets it match
  { id: 'mlyny-most', at: [1846.8, -1081.9], area: 14.6, r: 4, sky: true, top: 18.2, bot: 9.2, build: buildMost },
  { id: 'divadlo', name: 'Východočeské divadlo', at: [1550.2, -568.4], area: 1153, r: 12, top: 14.6, build: buildDivadlo, solids: divadloSolids },
];

/** Dev and test switch: off, every footprint is a generic building again
 *  (the before half of a before/after measurement). Not a setting. */
export const SWITCH = { on: true };

const BY_ID = new Map(LANDMARKS.map((l) => [l.id, l]));
// the box every landmark lies in, so nine thousand houses are refused in one compare
let X0 = Infinity, X1 = -Infinity, Z0 = Infinity, Z1 = -Infinity;
for (const l of LANDMARKS) {
  X0 = Math.min(X0, l.at[0] - 200); X1 = Math.max(X1, l.at[0] + 200);
  Z0 = Math.min(Z0, l.at[1] - 200); Z1 = Math.max(Z1, l.at[1] + 200);
}
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Does this footprint match that entry? Exported for the tests. */
export function matches(l, f) {
  if (!f?.o || f.o.length < 3) return false;
  if ((f.y ?? 0) > 0.5 !== !!l.sky) return false;
  const [cx, cz] = ringCentroid(f.o);
  if (Math.hypot(cx - l.at[0], cz - l.at[1]) > (l.r ?? 9)) return false;
  const a = Math.abs(ringArea(f.o)), tol = l.tol ?? 0.3;
  if (a < l.area * (1 - tol) || a > l.area * (1 + tol)) return false;
  if (l.name && f.n && !norm(f.n).includes(norm(l.name))) return false;
  return true;
}

/**
 * The landmark a building feature is, or null. The answer is remembered on the
 * feature as its id (a string: plain data, so it crosses to the worker in the
 * chunk spec and both threads agree without matching twice).
 */
export function landmarkOf(f) {
  if (!SWITCH.on) return null;
  const c = f._lm;
  if (c !== undefined) return c ? BY_ID.get(c) ?? null : null;
  let hit = null;
  const p = f.o?.[0];
  if (p && p[0] > X0 && p[0] < X1 && p[1] > Z0 && p[1] < Z1)
    for (const l of LANDMARKS) if (matches(l, f)) { hit = l; break; }
  f._lm = hit ? hit.id : '';
  return hit;
}

/** One chunk's landmarks: a sink that fills as the building loop meets them. */
export class LandmarkBatch {
  constructor() { this.sink = new LandmarkSink(); }
  /**
   * @param ground the same founding height the generic building would get
   * @param terrain the height field, when the caller has one (the chunk
   *   builders do, on both threads): the model's passages then follow the
   *   ground, and what it owns round its footprint is built with it
   * @param ways the chunk cell's roads, when the caller has them: paving is
   *   laid over the ground as it is DRAWN near them (landmarks-passage floorAt)
   */
  add(l, f, ground, terrain = null, ways = null) {
    const kit = new Kit(this.sink, ground, terrain, ways);
    l.build(kit, f, l);
    if (terrain && l.grounds) l.grounds(kit, f, l);
  }
  geo() { return this.sink.geo(); }
}

/**
 * What of a landmark is solid, as pieces [{ ring, holes, top, bot }]: an [x,z]
 * ring, its courtyards, and the heights (metres above the landmark's ground)
 * it is solid between. `bot` above zero is masonry OVER a passage: walked and
 * driven under, but still there for a rocket or a landing helicopter. Null for
 * anything that is not a landmark. MAIN THREAD ONLY in practice (city.js), and
 * remembered per feature without touching it.
 */
const _solids = new WeakMap();
export function landmarkSolids(f) {
  if (f._lm === '') return null;
  const l = landmarkOf(f);
  if (!l) return null;
  let s = _solids.get(f);
  if (!s) {
    s = l.solids ? l.solids(f, l) : [prism(f, l.top, l.bot ?? 0)];
    _solids.set(f, s);
  }
  return s;
}

const inRing = (o, x, z) => {
  let inside = false;
  for (let i = 0, j = o.length - 1; i < o.length; j = i++) {
    const a = o[i], b = o[j];
    if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};

/** Is (x, z) inside this piece of landmarkSolids (in its ring, in none of its courtyards)? */
export function solidHas(s, x, z) {
  if (!inRing(s.ring, x, z)) return false;
  if (s.holes) for (const h of s.holes) if (h.length >= 3 && inRing(h, x, z)) return false;
  return true;
}

/**
 * Is (x, z) inside a landmark's footprint? A bench or a statue the tile puts
 * there (OSM maps the relief ON the fore-gate as a statue node in its arch) was
 * hidden inside the generic box; in a hand-made model it would stand in the
 * passage. WORKER SAFE: js/furniture.js asks on both threads, with the chunk's
 * own building list, which is the same list on both.
 */
export function inLandmark(buildings, x, z) {
  if (!buildings) return false;
  for (const f of buildings) if (f._lm !== '' && landmarkOf(f) && inRing(f.o, x, z)) return true;
  return false;
}

/**
 * Is this barrier of the tile one a landmark models itself (the chateau's foot
 * wall)? Then the generic ribbon is not drawn: it would stand across the gate.
 * WORKER SAFE: js/meshes.js asks on both threads.
 */
export function landmarkBarrier(f) { return SWITCH.on && isValyBarrier(f); }

// ---- clear zones -------------------------------------------------------------
// The surface model the scattered trees come from sees a tower as tall green,
// and plants a lime in front of its arch. A landmark keeps the ground it is
// LOOKED AT and WALKED INTO through free of trees: capsules [ax, az, bx, bz, r].
// Nothing in the tile is touched; a mapped tree inside one is merely not drawn.
const CLEAR = [
  [1546.5, -691.2, 1580.5, -708.0, 4.5],     // Zelenobranská through both gates, to the mouth of the square
  [1578, -1018, 1524, -1046, 4.5],           // the chateau: over the bridge and through the gate
  [1524, -1046, 1477, -1066.3, 3.5],         // ...across the outer court
  [1477, -1066.5, 1462, -1026.5, 4],         // ...over the inner bridge and through the portal
  [1461.2, -1014.6, 1461.2, -1014.5, 11],    // ...into the courtyard
];
/** Does a landmark keep (x, z) free of trees? WORKER SAFE. */
export function landmarkClear(x, z) {
  if (!SWITCH.on || x < X0 || x > X1 || z < Z0 || z > Z1) return false;
  for (const c of CLEAR) {
    const ex = c[2] - c[0], ez = c[3] - c[1], l2 = ex * ex + ez * ez;
    let t = l2 > 1e-9 ? ((x - c[0]) * ex + (z - c[1]) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - c[0] - ex * t, dz = z - c[1] - ez * t;
    if (dx * dx + dz * dz < c[4] * c[4]) return true;
  }
  return false;
}
