// ---- zastávkový záliv ------------------------------------------------------
// OSM does not map these. Checked against the real tile at Kpt. Bartoše in
// Polabiny, where the orthophoto plainly shows a lay-by: inside 45 m the data
// holds the street, footways, a cycleway and two bus_stop NODES — and no area
// at all. So the bay is generated from the stop, and these are the three
// things that have to stay true about it.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');

const G = 221, ROAD_Z = 60, ROAD_W = 8;

function build(pois, w = ROAD_W, t = 'residential') {
  const road = { _id: 1, _home: '0,0', d: 1, t, w, v: 30, p: [[5, ROAD_Z], [115, ROAD_Z]] };
  const cell = { buildings: [], roads: [road], rails: [], water: [], green: [],
    paved: [], trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois, waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: () => G };
  mats.trees = false; mats.facades = false; mats.ortho = null; mats.canopy = null; mats.ground = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  const out = [];
  for (const c of g?.children ?? []) {
    const p = c.geometry?.attributes?.position;
    if (!p) continue;
    for (let i = 0; i < p.count; i++)
      out.push([p.getX(i) + g.position.x, p.getY(i) + g.position.y, p.getZ(i) + g.position.z]);
  }
  return out;
}

const beside = (v, lo, hi) => v.filter(([x, y, z]) =>
  Math.abs(y - G) < 0.4 && z > lo && z < hi && x > 40 && x < 80);

test('a bus stop widens the carriageway into a lay-by on its own side', () => {
  const bare = build([]);
  const withStop = build([{ t: 'bus_stop', p: [60, 66], n: 'Test' }]);
  assert.ok(withStop.length > bare.length + 40,
    `the stop added only ${withStop.length - bare.length} vertices — no bay was built`);
  // the kerb is at ROAD_W/2 = 4 m; the bay is the 3 m beyond it
  const bay = beside(withStop, ROAD_Z + ROAD_W / 2 - 0.5, ROAD_Z + ROAD_W / 2 + 3.5);
  assert.ok(bay.length > 50, `only ${bay.length} vertices lie in the bay strip`);
  // …and it is at DECK level, not draped: a bay that follows raw terrain
  // leaves a lip along the kerb on any road in cut or on fill
  for (const [, y] of bay)
    assert.ok(Math.abs(y - G) < 0.4, `a bay vertex sits ${(y - G).toFixed(2)} m off the deck`);
});

test('the far kerb gets nothing — a bay belongs to the stop that asked for it', () => {
  const bare = beside(build([]), ROAD_Z - ROAD_W / 2 - 3.5, ROAD_Z - ROAD_W / 2 + 0.5).length;
  const withStop = beside(build([{ t: 'bus_stop', p: [60, 66], n: 'Test' }]),
    ROAD_Z - ROAD_W / 2 - 3.5, ROAD_Z - ROAD_W / 2 + 0.5).length;
  assert.equal(withStop, bare, 'a bay appeared on the opposite kerb too');
});

test('a lane too narrow to give 3 m away keeps all of it', () => {
  // a living street or a 4.5 m service road has no room for a lay-by, and
  // nobody builds one there
  const bare = build([], 4.5, 'living_street');
  const withStop = build([{ t: 'bus_stop', p: [60, 64], n: 'Test' }], 4.5, 'living_street');
  const bay = beside(withStop, ROAD_Z + 2.0, ROAD_Z + 5.5).length
    - beside(bare, ROAD_Z + 2.0, ROAD_Z + 5.5).length;
  assert.ok(bay < 20, `a narrow street grew a ${bay}-vertex bay it has no room for`);
});
