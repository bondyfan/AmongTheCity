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
import { LANDMARKS_OLD, EXTRAS_OLD, ZONES_OLD, CLEAR_OLD, isOldBridgeWay } from './landmarks-praha.js';
import { LANDMARKS_WIDE, CLEAR_WIDE, PROP_WIDE } from './landmarks-hrad.js';

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
 * region: 'praha' for Prague; none means 'pardubice'. Each region is one box
 *   the prefilter refuses the rest of the world with.
 * lifted: matches a footprint the tile lifts (y > 0.5: a gate over its
 *   passage) that is NOT a sky bridge; the model and its solids stand on the ground.
 * kind: the footprint's own type (f.t) must be this.
 * hide: the generic footprint is suppressed and nothing is built for it (a
 *   companion part a neighbouring model already draws); may match many.
 * reach: how far (m) its model and solids may stand beyond the footprint's
 *   box (the National Theatre's porch, the Žižkov tower's pods); default 1 for
 *   solids, 3.5 for the model. Checked by tests/landmarks.test.mjs.
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
  ...LANDMARKS_OLD,
  ...LANDMARKS_WIDE,
];
const NOTHING = () => {};
for (const l of LANDMARKS) if (l.hide) { l.build = NOTHING; l.solids = () => []; }

/**
 * Landmarks with no footprint of their own (a monument on a square, a bridge
 * over a river): { id, region, box: [x0, z0, x1, z1], build(kit, ctx) } with
 * ctx { key, cx, cz, roads, terrain, chunkOf }. Every chunk whose square meets
 * `box` asks the builder, which emits only the pieces whose anchor point lies
 * in THAT chunk (ctx.chunkOf(x, z) === ctx.key), so each piece is built by
 * exactly one chunk, whatever the order tiles arrived in. The kit's ground is
 * zero: heights are absolute.
 */
export const EXTRAS = [...EXTRAS_OLD];

/** Dev and test switch: off, every footprint is a generic building again
 *  (the before half of a before/after measurement). Not a setting. */
export const SWITCH = { on: true };

const BY_ID = new Map(LANDMARKS.map((l) => [l.id, l]));
// One box per region that every landmark of it lies in, so the nine thousand
// houses of a town (and the whole corridor between two towns) are refused in
// a compare or two. A single box round Pardubice AND Prague would be 99 km wide.
const REGIONS = new Map();
const regionOf = (l) => l.region ?? 'pardubice';
const boxFor = (r) => {
  let b = REGIONS.get(r);
  if (!b) REGIONS.set(r, b = { x0: Infinity, x1: -Infinity, z0: Infinity, z1: -Infinity, list: [] });
  return b;
};
for (const l of LANDMARKS) {
  const b = boxFor(regionOf(l));
  b.x0 = Math.min(b.x0, l.at[0] - 200); b.x1 = Math.max(b.x1, l.at[0] + 200);
  b.z0 = Math.min(b.z0, l.at[1] - 200); b.z1 = Math.max(b.z1, l.at[1] + 200);
  b.list.push(l);
}
for (const e of EXTRAS) {
  const b = boxFor(regionOf(e));
  b.x0 = Math.min(b.x0, e.box[0] - 200); b.x1 = Math.max(b.x1, e.box[2] + 200);
  b.z0 = Math.min(b.z0, e.box[1] - 200); b.z1 = Math.max(b.z1, e.box[3] + 200);
}
const BOXES = [...REGIONS.values()];
/** The landmarks of the region (x, z) lies in, or null: the prefilter. */
function regionAt(x, z) {
  for (const b of BOXES) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return b;
  return null;
}
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Does this footprint match that entry? Exported for the tests. */
export function matches(l, f) {
  if (!f?.o || f.o.length < 3) return false;
  if (l.kind && f.t !== l.kind) return false;
  const up = (f.y ?? 0) > 0.5;
  // a sky bridge only ever matches a lifted footprint; a `lifted` gate either
  // (a rebuild that drops its min_height still finds it); anything else a grounded one
  if (l.sky ? !up : up && !l.lifted) return false;
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
  const box = p ? regionAt(p[0], p[1]) : null;
  if (box) for (const l of box.list) if (matches(l, f)) { hit = l; break; }
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
    if (l.hide) return;                  // a duplicate footprint: nothing at all
    const kit = new Kit(this.sink, ground, terrain, ways);
    l.build(kit, f, l);
    if (terrain && l.grounds) l.grounds(kit, f, l);
  }
  /** The pieces of a footprint-less landmark (EXTRAS) chunk (cx, cz) owns. */
  extra(e, ctx) {
    const kit = new Kit(this.sink, 0, ctx.terrain, ctx.roads);
    e.build(kit, ctx);
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
    s = l.hide ? [] : l.solids ? l.solids(f, l) : [prism(f, l.top, l.bot ?? 0)];
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
  if (SWITCH.on && inCapsules(ZONES, x, z)) return true;
  if (!buildings) return false;
  for (const f of buildings) if (f._lm !== '' && landmarkOf(f) && inRing(f.o, x, z)) return true;
  return false;
}

// Where a landmark with no footprint draws its own props: the tile's statue
// props on Charles Bridge stand on the riverbed under the deck, and the Hus
// monument is a 1.4 m stone in the furniture. Capsules [ax, az, bx, bz, r].
const ZONES = [...ZONES_OLD];
const inCapsules = (list, x, z) => {
  if (!regionAt(x, z)) return false;
  for (const c of list) {
    const ex = c[2] - c[0], ez = c[3] - c[1], l2 = ex * ex + ez * ez;
    let t = l2 > 1e-9 ? ((x - c[0]) * ex + (z - c[1]) * ez) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = x - c[0] - ex * t, dz = z - c[1] - ez * t;
    if (dx * dx + dz * dz < c[4] * c[4]) return true;
  }
  return false;
};

/**
 * The footprint-less landmarks chunk (cx, cz) of size `size` may own a piece
 * of. WORKER SAFE (meshes.js buildBuildingsMesh, both threads).
 */
export function landmarkExtras(cx, cz, size) {
  if (!SWITCH.on || !EXTRAS.length) return NO_EXTRAS;
  const x0 = cx * size, z0 = cz * size, x1 = x0 + size, z1 = z0 + size;
  let out = NO_EXTRAS;
  for (const e of EXTRAS) {
    const b = e.box;
    if (b[2] < x0 || b[0] > x1 || b[3] < z0 || b[1] > z1) continue;
    if (out === NO_EXTRAS) out = [];
    out.push(e);
  }
  return out;
}
const NO_EXTRAS = [];

/**
 * Is this road way one a landmark draws itself (Charles Bridge: its parapets,
 * piers and arches are the model's)? Then the generic bridge dressing (fascia,
 * parapet, slim piers) is not drawn; the deck is. WORKER SAFE.
 */
export function landmarkBridge(f) {
  if (!SWITCH.on || !f?.br || !f.p?.length) return false;
  const p = f.p[0];
  return !!regionAt(p[0], p[1]) && isOldBridgeWay(f);
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
  ...CLEAR_OLD,
  [1546.5, -691.2, 1580.5, -708.0, 4.5],     // Zelenobranská through both gates, to the mouth of the square
  [1578, -1018, 1524, -1046, 4.5],           // the chateau: over the bridge and through the gate
  [1524, -1046, 1477, -1066.3, 3.5],         // ...across the outer court
  [1477, -1066.5, 1462, -1026.5, 4],         // ...over the inner bridge and through the portal
  [1461.2, -1014.6, 1461.2, -1014.5, 11],    // ...into the courtyard
];
CLEAR.push(...CLEAR_WIDE);
/** Does a landmark keep (x, z) free of trees? WORKER SAFE. */
export function landmarkClear(x, z) {
  return SWITCH.on && inCapsules(CLEAR, x, z);
}

/**
 * Is (x, z) where a landmark stands OUTSIDE any footprint, so the tile's prop
 * there must not be drawn (St Wenceslas has no footprint: the tile has him as
 * five memorial boxes)? An explicit list of points, no tile data. WORKER SAFE:
 * js/furniture.js asks on both threads.
 */
export function landmarkProp(x, z) {
  if (!SWITCH.on) return false;
  for (const p of PROP_WIDE) if ((x - p[0]) * (x - p[0]) + (z - p[1]) * (z - p[1]) < p[2] * p[2]) return true;
  return false;
}
