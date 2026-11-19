// ---- drawnground.js: a prop stands on the ground that was DRAWN ----------------
// Pure: no three, no DOM. Worker safe (js/meshes.js builds chunks on both sides).
//
// WHY. The height grid has a sample every 20 m, and a street dipping under a
// railway is a 9 m cutting: the earthworks stamp the street's grade into the
// samples they reach, and between them the bicubic arches straight back over
// the carriageway. The ground MESH does not care, it is clamped under every
// way's corridor vertex by vertex (meshes.clampUnderRoadsGen), and feet stand
// on that clamped ground (city.heightAt, batter.groundUnder). But everything
// with a height that is put down "on the ground" asked the grid: a fence, a
// lamp column, a sign, a bench, a tree. In the Jana Palacha underpass the grid
// reads 217.1 m over a carriageway drawn at 214.3, so the fences along the
// cutting stood on ground that is not there, their feet riding the grid's
// arch up and down over the bank, and the lamps hung 2.8 m over the pavement.
//
// drawnGround() answers heightAt(x, z) the way the mesher draws the ground:
// the grid under the tightest corridor ceiling and over the tallest embankment
// floor (batter.groundUnder, the per-vertex rule itself). Away from every
// corridor it is the grid, to the bit.
//
// It is NOT a Terrain: the levelling caches compare their terrain by identity
// (geo.roadProfile), so grades are still asked with the real one (`.raw`).

import { groundUnder } from './batter.js';

const CELL = 16;                    // m: the bucket the corridors are sorted into
const OFF = 32768;                  // cell indices are kept positive in the key

/**
 * @param terrain  the Terrain (heightAt, ready)
 * @param entries  the corridor entries of the chunk and its neighbours
 *                 (batter.roadCorr / railCorr: { r, bb, hw, flare, ... })
 * @param shaped   (x, z) => is this ground a stamp's own (a Prague lower quay)
 * @returns an object with heightAt(x, z); `terrain` itself when there is nothing to clamp under
 */
export function drawnGround(terrain, entries, shaped = null) {
  if (!terrain || !entries || !entries.length) return terrain;
  const buckets = new Map();
  // the entries whose corridor can reach a 16 m cell: found once per cell
  const near = (x, z) => {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    const k = (cx + OFF) * 65536 + (cz + OFF);
    let list = buckets.get(k);
    if (list === undefined) {
      const x0 = cx * CELL, z0 = cz * CELL, x1 = x0 + CELL, z1 = z0 + CELL;
      list = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i], bb = e.bb, reach = e.hw + (e.flare ?? 0);
        if (x1 < bb[0] - reach || x0 > bb[2] + reach || z1 < bb[1] - reach || z0 > bb[3] + reach) continue;
        list.push(e);
      }
      buckets.set(k, list);
    }
    return list;
  };
  return {
    raw: terrain,
    heightAt(x, z) {
      const g = terrain.heightAt(x, z);
      const list = near(x, z);
      return list.length ? groundUnder(x, z, g, list, terrain, shaped) : g;
    },
    ready: (x, z) => (terrain.ready ? terrain.ready(x, z) : true),
  };
}
