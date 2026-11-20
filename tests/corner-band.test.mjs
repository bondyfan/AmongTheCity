// ---- the corner of a junction is stood on at the height it is drawn -----------
// The kerb band round a junction (js/streets.js) is drawn from the pad's deck at
// its KERB LINE, carried straight out across the band (meshes.ringKerbInto).
// Feet and props asked the deck under themselves instead, out on the band, and
// the deck function there answers for another place: its terrain guard reads
// the ground beside the street. By a crossing under a hillside that was up to
// 3 m more than the paving (K Drahani and Pod Zámečkem, Prague: band drawn at
// 251, answered 254.3), so a lamp on that corner stood in the air and a walker
// stepping onto it was lifted off the paving. One function now says where the
// band is, streets.cornerLevel, and both ask it.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const { buildChunkMeshes, makeMaterials, standingOn } = await import('../js/meshes.js');
const geo = await import('../js/geo.js');
const { cornerLift, cornerLevel } = await import('../js/streets.js');
const { Terrain } = await import('../js/terrain.js');
const { CityWorld } = await import('../js/city.js');
const { LAYER_Y } = await import('../js/config.js');

const G = 221;
const way = (id, p) => ({ t: 'residential', w: 8, d: 1, v: 50, p, _id: id, _home: '0,0', _len: geo.polylineLength(p) });
const house = (id, x, z) => ({ o: [[x, z], [x + 10, z], [x + 10, z + 10], [x, z + 10]], h: 9, t: 'house', _id: id, _home: '0,0' });

/** A kerbed crossroads at (60, 60) on level streets, a hill rising in its +x +z corner. */
function crossing() {
  geo.JUNCTIONS.clear(); geo.CLUSTERS.clear();
  const roads = [way(103, [[60, 2], [60, 60]]), way(104, [[60, 60], [60, 118]]),
    way(105, [[2, 60], [60, 60]]), way(106, [[60, 60], [118, 60]])];
  const cell = { buildings: [house(501, 20, 20), house(502, 90, 20), house(503, 20, 90), house(504, 90, 90)],
    roads, rails: [], water: [], green: [], paved: [], trees: [], signs: [], crossings: [],
    furniture: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  geo.indexJunctions(roads);
  geo.setStreetCity(city);
  // the streets lie on grid lines (x = 60, z = 60), so one raised node at
  // (80, 80) lifts the ground of that corner alone and leaves both profiles level
  const terrain = new Terrain(4800, 20);
  const grid = new Int16Array(terrain.n * terrain.n).fill(G * 10);
  grid[4 * terrain.n + 4] = (G + 40) * 10;
  terrain.grids.set('0,0', grid);
  terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.canopy = null; mats.ground = null; mats.ortho = null;
  mats.hidden = new Set(); mats.facades = false; mats.trees = false;
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, cell, terrain, mats, pad: geo.junctionsIn('0,0')[0] };
}

/** The highest surface the built chunk draws straight over (x, z). */
function drawnTop(group, x, z) {
  let top = -Infinity;
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
    const m = o.matrixWorld.elements;
    const P = (i, k) => { const j = idx ? idx.getX(i) : i; return k === 0 ? pos.getX(j) * m[0] + m[12] : k === 1 ? pos.getY(j) * m[5] + m[13] : pos.getZ(j) * m[10] + m[14]; };
    for (let i = 0; i + 2 < n; i += 3) {
      const ax = P(i, 0), az = P(i, 2), bx = P(i + 1, 0), bz = P(i + 1, 2), cx = P(i + 2, 0), cz = P(i + 2, 2);
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      const y = u * P(i, 1) + v * P(i + 1, 1) + w * P(i + 2, 1);
      if (y > top) top = y;
    }
  });
  return top;
}

/** Points well inside the corner band of the hill's corner: [x, z]. */
function onBand(pad) {
  const out = [];
  for (let x = 64.25; x < 72; x += 0.5) for (let z = 64.25; z < 72; z += 0.5) {
    // (a hand inside the band on every side, so the sample is on its paving and not on its graded back edge)
    if ([[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].every(([a, b]) => cornerLift(pad, x + a, z + b) > 0.1)) out.push([x, z]);
  }
  return out;
}

test('the corner band is where it is drawn, not where the deck function says out on it', () => {
  const w = crossing();
  const group = buildChunkMeshes(w.city, 0, 0, w.mats, 'full');
  const pts = onBand(w.pad);
  assert.ok(pts.length >= 6, `only ${pts.length} points on the corner band: the fixture lost its kerb`);
  let off = 0;
  for (const [x, z] of pts) {
    const drawn = drawnTop(group, x, z);
    const level = cornerLevel(w.pad, x, z, w.terrain, geo.junctionDeckY) + LAYER_Y.road;
    assert.ok(Math.abs(level - drawn) < 0.06, `at ${x}, ${z} the band is drawn at ${drawn.toFixed(2)} and said to be at ${level.toFixed(2)}`);
    const there = geo.junctionDeckY(w.pad, x, z, w.terrain) + LAYER_Y.road + cornerLift(w.pad, x, z);
    if (Math.abs(there - drawn) > 0.3) off++;
  }
  assert.ok(off > 0, 'the fixture is wrong: the deck asked out on the band agrees with the paving everywhere');
  group.traverse((o) => o.geometry?.dispose?.());
});

test('a prop on that corner and the feet of a walker stand on the paving', () => {
  const w = crossing();
  const group = buildChunkMeshes(w.city, 0, 0, w.mats, 'full');
  const stand = standingOn(w.cell, '0,0', w.terrain);
  const world = Object.assign(Object.create(CityWorld.prototype), { city: w.city, terrain: w.terrain });
  const pts = onBand(w.pad);
  assert.ok(pts.length >= 6);
  for (const [x, z] of pts) {
    const drawn = drawnTop(group, x, z);
    const prop = stand.heightAt(x, z);
    assert.ok(Math.abs(prop - drawn) < 0.06, `a lamp at ${x}, ${z} stands at ${prop.toFixed(2)}, the paving is drawn at ${drawn.toFixed(2)}`);
    const feet = world.heightAt(x, z, drawn + 0.3);
    assert.ok(Math.abs(feet - drawn) < 0.06, `feet at ${x}, ${z} stand at ${feet.toFixed(2)}, the paving is drawn at ${drawn.toFixed(2)}`);
  }
  group.traverse((o) => o.geometry?.dispose?.());
});

test('on level ground the corner is a kerb over the pad, as it was', () => {
  geo.JUNCTIONS.clear(); geo.CLUSTERS.clear();
  const roads = [way(103, [[60, 2], [60, 60]]), way(104, [[60, 60], [60, 118]]),
    way(105, [[2, 60], [60, 60]]), way(106, [[60, 60], [118, 60]])];
  const cell = { buildings: [house(501, 20, 20), house(502, 90, 20), house(503, 20, 90), house(504, 90, 90)],
    roads, rails: [] };
  geo.indexJunctions(roads);
  geo.setStreetCity({ chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] });
  const terrain = { res: 20, tile: 4800, missed: false, _loads: 1, ready: () => true, heightAt: () => G };
  const pad = geo.junctionsIn('0,0')[0];
  const pts = onBand(pad);
  assert.ok(pts.length >= 6);
  for (const [x, z] of pts) {
    const old = geo.junctionDeckY(pad, x, z, terrain) + cornerLift(pad, x, z);
    assert.ok(Math.abs(cornerLevel(pad, x, z, terrain, geo.junctionDeckY) - old) < 1e-9, `the level corner at ${x}, ${z} moved`);
  }
  assert.ok(Number.isNaN(cornerLevel(pad, 60, 60, terrain, geo.junctionDeckY)), 'the asphalt of the pad is no corner');
});
