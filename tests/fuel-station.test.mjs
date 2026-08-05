// ---- benzínky ------------------------------------------------------------
// 1 178 amenity=fuel nodes ship in the tiles, most carrying the operator's
// name, and not one of them was ever drawn: the player could cross a region
// the size of Bohemia without passing a petrol station. The forecourt is the
// recognisable part — a wide flat canopy on slim columns with pump islands
// under it — so that is what gets built, and the shop is left to whatever
// building OSM already maps beside it.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { CHUNK } = await import('../js/config.js');

const GROUND = 221;

function build(pois, roads = []) {
  const key = '0,0';
  for (const r of roads) { r._id = 1; r._home = key; }
  const cell = { buildings: [], roads, rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois, waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true,
    heightAt: () => GROUND };
  mats.trees = false; mats.facades = false; mats.ortho = null;
  mats.canopy = null; mats.ground = null;
  return { group: buildChunkMeshes(city, 0, 0, mats, 'full'), mats };
}

/** Every vertex of the chunk, in world Y. */
function verts(group) {
  const out = [];
  for (const ch of group?.children ?? []) {
    const pos = ch.geometry?.attributes?.position;
    if (!pos) continue;
    for (let i = 0; i < pos.count; i++)
      out.push([pos.getX(i) + group.position.x, pos.getY(i) + group.position.y,
        pos.getZ(i) + group.position.z]);
  }
  return out;
}

test('a fuel node grows a forecourt with a canopy over it', () => {
  const road = { d: 1, t: 'secondary', w: 8, p: [[0, 20], [120, 20]] };
  const bare = verts(build([], [road]).group);
  const withFuel = verts(build([{ t: 'fuel', p: [60, 60], n: 'Benzina' }], [road]).group);
  assert.ok(withFuel.length > bare.length + 100,
    `the fuel node added ${withFuel.length - bare.length} vertices — it drew nothing`);

  // the canopy is a roof at about five metres, well clear of a lorry
  const roof = withFuel.filter(([, y]) => y > GROUND + 4.5 && y < GROUND + 7);
  assert.ok(roof.length >= 8, `no canopy: ${roof.length} vertices above 4.5 m`);
  // …and it stands over the node, not somewhere else in the chunk
  const near = roof.filter(([x, , z]) => Math.hypot(x - 60, z - 60) < 16);
  assert.ok(near.length >= 8, 'the canopy is not over the pumps');
  // nothing runs away vertically — a fixture that missed its ground sample
  // used to come out hundreds of metres tall (see the furniture double-drape)
  const tallest = Math.max(...withFuel.map(([, y]) => y));
  assert.ok(tallest < GROUND + 12,
    `something reaches ${(tallest - GROUND).toFixed(1)} m above the forecourt`);
});

test('the forecourt sits ON the ground, not at sea level', () => {
  // absolute-elevation world: the fixture takes one ground sample and the
  // chunk-wide drape must skip it, or the canopy lands 221 m under Pardubice
  const { group } = build([{ t: 'fuel', p: [60, 60], n: 'MOL' }]);
  const low = Math.min(...verts(group).map(([, y]) => y));
  assert.ok(Math.abs(low - GROUND) < 1.5,
    `the lowest vertex is at ${low.toFixed(1)} m, the ground is ${GROUND} m`);
});
