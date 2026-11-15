// ---- landmarklamps.js: the light of lamps that belong to a landmark model ----
// Main thread (js/lightpools.js calls it). The pools of light on the night
// streets come from the pole registry (world.poles), which holds the masts the
// mesher stood up from the tile. The lanterns of Charles Bridge are not masts:
// they are part of the hand-built model (js/landmarks-karluv.js), and the
// tile's own lamp props on the bridge are suppressed there because they stood
// on the riverbed. So the deck, the brightest walk in Prague at night, had no
// light on it at all. This adds the model's lanterns to the same instanced
// pools and glows, from the model's own list, after the masts.
//
// An old gas lantern on the parapet, four metres up, throws a warmer, smaller
// pool than a street column: centred in over the walkway (the two lanterns of
// a span face each other across the 9.5 m deck), long along the bridge and
// fading to nothing just past the parapet. One pair per arch leaves the dark
// necks between them that the real bridge has.

import * as THREE from 'three';
import { karluvLanterns, LANTERN_UP, KARLUV_BOX } from './landmarks-karluv.js';
import { SWITCH as LANDMARKS_ON } from './landmarks.js';
import { chunkKey } from './geo.js';

const LANTERN_IN = 2.3, LANTERN_LONG = 9, LANTERN_WIDE = 3.4;
const GAS = [1.0, 0.64, 0.30], GAS_POOL = 0.9;

const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const _m = new THREE.Matrix4(), _c = new THREE.Color();
const _lant = [];
const NO_ROADS = [];
let _cells = null;
const roadsAt = (x, z) => _cells.get(chunkKey(x, z))?.roads ?? NO_ROADS;

/**
 * Write the landmark lanterns within `reach` of (cx, cz) into the pool and
 * glow InstancedMeshes from index k on (at most `max`), the pool `lift` over
 * the deck as the masts' pools are. Returns the next free index. Called on a
 * rebuild only (the set of masts changed or the camera moved): 16 deck reads.
 */
export function addLandmarkLamps(pools, glows, world, cx, cz, k, max, reach, lift) {
  const b = KARLUV_BOX, cells = world?.city?.chunkIndex, terr = world?.terrain;
  if (!LANDMARKS_ON.on || !cells || !terr) return k;
  const dx = Math.max(b[0] - cx, 0, cx - b[2]), dz = Math.max(b[1] - cz, 0, cz - b[3]);
  if (dx * dx + dz * dz > reach * reach) return k;
  _cells = cells;
  karluvLanterns(roadsAt, terr, _lant);
  _cells = null;
  for (const q of _lant) {
    if (k >= max) break;
    // the deck height is anchored on the banks: no ground, no deck
    if (terr.ready && !terr.ready(q.x, q.z)) continue;
    _x.set(q.ax, 0, q.az);            // along the bridge
    _z.set(-q.az, 0, q.ax);           // across it
    _y.crossVectors(_z, _x);
    _m.set(
      _x.x * LANTERN_LONG, _y.x, _z.x * LANTERN_WIDE, q.x + q.nx * LANTERN_IN,
      _x.y * LANTERN_LONG, _y.y, _z.y * LANTERN_WIDE, q.deck + lift,
      _x.z * LANTERN_LONG, _y.z, _z.z * LANTERN_WIDE, q.z + q.nz * LANTERN_IN,
      0, 0, 0, 1);
    pools.setMatrixAt(k, _m);
    _m.makeTranslation(q.x, q.deck + LANTERN_UP, q.z);
    glows.setMatrixAt(k, _m);
    pools.setColorAt(k, _c.setRGB(GAS[0] * GAS_POOL, GAS[1] * GAS_POOL, GAS[2] * GAS_POOL));
    glows.setColorAt(k, _c.setRGB(GAS[0], GAS[1], GAS[2]));
    k++;
  }
  return k;
}
