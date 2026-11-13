// Landmark paving against the ground as it is DRAWN (js/landmarks-passage.js
// floorAt). The photo ground is lifted toward a way's levelled deck inside its
// corridor (meshes.js clampUnderRoadsGen), so paving laid a fixed hand over
// the terrain lay under the photo in the chateau's courtyard, where the
// footway's deck stands 0.6 m over the terrain, and the roofs' shadow in the
// photo showed through in dark patches. What is pinned here:
//   . paving clears the photo's lifted floor near a way and stays under the
//     way's own deck, and is the plain lift away from every way;
//   . the courtyard of the real tile is paved that way;
//   . the worker builds the chateau chunk the same with the ways in it.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { LANDMARKS, matches, landmarkOf, LandmarkBatch } = await import('../js/landmarks.js');
const { floorAt } = await import('../js/landmarks-passage.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, handleMessage } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity, roadProfile } = await import('../js/geo.js');
const { CHUNK } = await import('../js/config.js');
const { orthoQuad } = await import('../js/ortho.js');

const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/0_-1.json', import.meta.url), 'utf8'));
const copy = (f) => JSON.parse(JSON.stringify(f));
const GROUND = 220;

// a slope with bumps the levelled ways cannot follow, so decks leave the terrain
function terrain() {
  const t = new Terrain(4800, 20);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++)
    g[j * t.n + i] = Math.round((GROUND + Math.sin(i * 0.9) * 0.8 + Math.cos(j * 0.7) * 0.6) * 10);
  t.grids.set('0,-1', g);
  t._loads = 1;
  return t;
}

test('away from every way, and with no ways, paving is the plain lift over the terrain', () => {
  setStreetCity({ chunkIndex: new Map(), tile: 4800, pois: [], waterways: [] });
  const t = terrain();
  const way = { _id: 9001, t: 'footway', d: 0, w: 1.8, p: [[1400, -1100], [1460, -1060], [1520, -1100]] };
  const kit = { terrain: t, ground: 219, ways: [way], rel: (x, z) => t.heightAt(x, z) - 219 };
  assert.equal(floorAt(kit, 1700, -1300, 0.07), kit.rel(1700, -1300) + 0.07);
  assert.equal(floorAt({ ...kit, ways: null }, 1460, -1060, 0.07), kit.rel(1460, -1060) + 0.07);
  // and never under it near one
  for (let x = 1390; x <= 1530; x += 3.7) for (let z = -1120; z <= -1040; z += 2.9)
    assert.ok(floorAt(kit, x, z, 0.07) >= kit.rel(x, z) + 0.07 - 1e-9);
});

// the chateau's chunk with the real buildings and ways of its cell
const zamek = LANDMARKS.find((l) => l.id === 'zamek');
const palace = tile.buildings.find((f) => matches(zamek, f));
const key = Math.floor(zamek.at[0] / CHUNK) + ',' + Math.floor(zamek.at[1] / CHUNK);
const [cx, cz] = key.split(',').map(Number);
function chateauWorld(photo = false) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const x0 = cx * CHUNK, z0 = cz * CHUNK, x1 = x0 + CHUNK, z1 = z0 + CHUNK;
  const touches = (p) => p.some((q) => q[0] >= x0 - 1 && q[0] <= x1 + 1 && q[1] >= z0 - 1 && q[1] <= z1 + 1);
  let id = 0;
  const buildings = [palace].map((f) => { const g = copy(f); g._id = ++id; g._home = key; return g; });
  const roads = tile.roads.filter((r) => r.p.length >= 2 && touches(r.p)).map((r) => { const g = copy(r); g._id = ++id; g._home = key; return g; });
  const cell = { buildings, roads, rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const t = terrain();
  // the earthworks, as js/city.js runs them: the ways are levelled against the
  // survey FIRST and the grid is stamped after, in place, so between its 20 m
  // samples a deck can stand well clear of the ground (0.6 m in the courtyard
  // of the live world). Here: profiles, then the samples round the palace dug
  // 0.6 m down.
  for (const r of roads) roadProfile(r, t);
  const g = t.grids.get('0,-1'), n = t.n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = i * 20, z = -4800 + j * 20;
    if (Math.hypot(x - 1462, z + 1015) < 30) g[j * n + i] -= 6;
  }
  const mats = makeMaterials();
  mats.terrain = t; mats.canopy = null; mats.ground = null;
  // the real photo quad (js/ortho.js), so meshes.js lifts it by its own rule
  const photoMat = new THREE.MeshBasicMaterial();
  mats.ortho = photo ? { orthoGroundMesh: (x, z) => orthoQuad(x, z, { lx: 0, lz: 0, S: 1 }, t, photoMat), tierOf: () => 1 } : null;
  mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, terrain: t, canopy: null, ground: null, mats, wordmark, cell };
}

test('the courtyard and the passage of the real chateau are paved over the photo ground as it is drawn', () => {
  const w = chateauWorld(true);
  const group = buildChunkMeshes(w.city, cx, cz, w.mats, 'full');
  group.updateMatrixWorld(true);
  const photos = [], lms = [];
  group.traverse((o) => { if (o.isMesh && o.material?.isMeshBasicMaterial && o.geometry.attributes.uv && !o.geometry.attributes.color) photos.push(o); });
  group.traverse((o) => { if (o.isMesh && o.material === w.mats.landmark) lms.push(o); });
  assert.equal(photos.length, 1, 'the chunk drew no photo ground');
  assert.equal(lms.length, 1);
  const f = w.cell.buildings[0];
  const court = (f.i ?? []).filter((h) => h.length >= 3).sort((a, b) => b.length - a.length)[0];
  const inRing = (ring, x, z) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, zi] = ring[i], [xj, zj] = ring[j];
      if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
    }
    return c;
  };
  const off = (ring, x, z, m) => {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [ax, az] = ring[j], [bx, bz] = ring[i], ex = bx - ax, ez = bz - az;
      const u = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez || 1)));
      if (Math.hypot(x - ax - ex * u, z - az - ez * u) < m) return false;
    }
    return true;
  };
  const rc = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), p = new THREE.Vector3();
  const geo = lms[0].geometry, pos = geo.attributes.position, nor = geo.attributes.normal;
  let checked = 0, lifted = 0, worst = Infinity;
  for (let v = 0; v < pos.count; v += 1) {
    if (nor.getY(v) < 0.99) continue;
    p.fromBufferAttribute(pos, v).applyMatrix4(lms[0].matrixWorld);
    const ground = w.terrain.heightAt(p.x, p.z);
    // a sill, a cornice: not a floor; nor the foot of a reveal buried under one
    if (p.y > ground + 1.2 || p.y < ground + 0.05) continue;
    // the court, off its walls (the arcade's reveals face up at their foot), or the passage under the north wing
    const where = inRing(court, p.x, p.z) ? off(court, p.x, p.z, 1.5) : inRing(f.o, p.x, p.z) && off(f.o, p.x, p.z, 0.8);
    if (!where) continue;
    rc.set(new THREE.Vector3(p.x, p.y + 5, p.z), down);
    const hit = rc.intersectObject(photos[0], false)[0];
    if (!hit) continue;
    const gap = p.y - hit.point.y;
    if (gap < worst) worst = gap;
    if (hit.point.y > ground + 0.1) lifted++;
    checked++;
  }
  assert.ok(checked > 300, `only ${checked} paving vertices over the photo`);
  assert.ok(lifted > 20, 'nowhere was the photo lifted over the terrain: the test proves nothing');
  assert.ok(worst > 0.02, `paving ${(worst * 100).toFixed(1)} cm over the photo at worst`);
});

test('the worker builds the chateau chunk with its ways the same as the main thread', () => {
  const w = chateauWorld();
  const sync = buildChunkMeshes(w.city, cx, cz, w.mats, 'full');
  const lmA = [];
  sync.traverse((o) => { if (o.isMesh && o.material === w.mats.landmark) lmA.push(o); });
  assert.equal(lmA.length, 1);
  const got = chunkSpec(w, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
  const { reply } = handleMessage(makeWorkerState(),
    { t: 'build', id: 1, spec: structuredClone(got.spec, { transfer: got.transfer }) });
  assert.equal(reply.t, 'done', `the worker failed: ${reply.error}`);
  const decMats = { ...w.mats, codecMats: {} };
  for (const k of Object.keys(reply.brands)) decMats.codecMats[k] = w.wordmark;
  const back = decode(reply.payload, decMats);
  sync.updateMatrixWorld(true); back.updateMatrixWorld(true);
  const lmB = [];
  back.traverse((o) => { if (o.isMesh && o.material === w.mats.landmark) lmB.push(o); });
  assert.equal(lmB.length, 1);
  const A = lmA[0].geometry.attributes.position, B = lmB[0].geometry.attributes.position;
  assert.equal(B.count, A.count, 'vertex count');
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  let worst = 0;
  for (let v = 0; v < A.count; v++) {
    p.fromBufferAttribute(A, v).applyMatrix4(lmA[0].matrixWorld);
    q.fromBufferAttribute(B, v).applyMatrix4(lmB[0].matrixWorld);
    worst = Math.max(worst, p.distanceTo(q));
  }
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm between the two paths`);
});
