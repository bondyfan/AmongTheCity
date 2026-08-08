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

// ---- a forecourt stands BESIDE the road, never across it -------------------
// A station is one OSM node, and that node lands wherever the surveyor put it —
// the shop, the entrance, or a few metres off the kerb. The forecourt built
// around it is 22 m across, so a node 2.5 m from the kerb laid its apron, a
// pump island and a canopy column out in the live carriageway. The road did not
// lose to it — the road ribbon is levelled and drawn on its own deck — but the
// player drove through a petrol station standing in the middle of the street.
//
// The price totem is the same problem inverted: it is SUPPOSED to be out by the
// road, so once the forecourt slid back it walked into the carriageway on its
// own, and on a node mapped on the far side it faced away from the road it
// advertises to.
const ROAD_Z = 60, ROAD_W = 9;
const withRoad = (nodeZ) => build(
  [{ t: 'fuel', p: [60, nodeZ], n: 'Benzina' }],
  [{ d: 1, t: 'primary', w: ROAD_W, v: 50, p: [[0, ROAD_Z], [120, ROAD_Z]] }]);

const allVerts = (group) => {
  const out = [];
  for (const ch of group?.children ?? []) {
    const p = ch.geometry?.attributes?.position;
    if (!p) continue;
    for (let i = 0; i < p.count; i++)
      out.push([p.getX(i) + group.position.x, p.getY(i) + group.position.y,
        p.getZ(i) + group.position.z]);
  }
  return out;
};
// vertices in the carriageway that belong to the station rather than the road
const intruding = (nodeZ) => {
  const bare = build([], [{ d: 1, t: 'primary', w: ROAD_W, v: 50,
    p: [[0, ROAD_Z], [120, ROAD_Z]] }]);
  const kerb = ([x, y, z]) => x > 15 && x < 105 && y > GROUND - 1 && y < GROUND + 8
    && Math.abs(z - ROAD_Z) < ROAD_W / 2 - 0.2;
  return allVerts(withRoad(nodeZ).group).filter(kerb).length
    - allVerts(bare.group).filter(kerb).length;
};

test('no part of the station is left standing in the carriageway', () => {
  for (const [nodeZ, where] of [
    [ROAD_Z + 7, '2.5 m from the kerb'],
    [ROAD_Z + 2, 'almost on the road itself'],
    [ROAD_Z - 6, 'on the far side'],
    [ROAD_Z + 40, 'well clear'],
  ]) {
    const n = intruding(nodeZ);
    assert.equal(n, 0, `a node ${where} put ${n} vertices of the forecourt `
      + 'inside the carriageway');
  }
});

test('…and the totem still stands at the kerb, on the road side', () => {
  // the panel is at 4.0–6.2 m; nothing else on the forecourt reaches that height
  const totemDist = (nodeZ) => {
    const t = allVerts(withRoad(nodeZ).group)
      .filter(([, y]) => y > GROUND + 5.5 && y < GROUND + 6.5);
    assert.ok(t.length, 'the totem is not there at all');
    return Math.min(...t.map(([, , z]) => Math.abs(z - ROAD_Z)));
  };
  for (const nodeZ of [ROAD_Z + 7, ROAD_Z + 2, ROAD_Z - 6]) {
    const d = totemDist(nodeZ);
    assert.ok(d > ROAD_W / 2, `the totem is ${d.toFixed(1)} m from the centreline — `
      + `inside the ${ROAD_W / 2} m carriageway`);
    assert.ok(d < ROAD_W / 2 + 4, `the totem is ${d.toFixed(1)} m out — `
      + 'too far back to read from the road');
  }
});
