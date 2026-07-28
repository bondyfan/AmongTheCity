import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { carveOrtho } = await import('../js/meshes.js');
const { loadCity } = await import('../js/geo.js');

test('the aerial-photo ground is cut away above mapped water', () => {
  // Match ortho.js exactly: the old carve sampled vertices 0,1,2 from this
  // subdivided plane. They share one row, so its affine fit silently aborted.
  const geometry = new THREE.PlaneGeometry(120, 120, 6, 6);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(60, 0, 60);

  const river = [[45, 0], [75, 0], [75, 120], [45, 120]];
  carveOrtho(mesh, 0, 0, 120, 120, [river]);
  mesh.updateMatrixWorld(true);

  const down = new THREE.Vector3(0, -1, 0);
  const dryRay = new THREE.Raycaster(new THREE.Vector3(20, 10, 60), down);
  const waterRay = new THREE.Raycaster(new THREE.Vector3(60, 10, 60), down);
  assert.ok(dryRay.intersectObject(mesh).length > 0, 'dry bank disappeared with the river');
  assert.equal(waterRay.intersectObject(mesh).length, 0,
    'opaque aerial ground still roofs the water shader');
});

test('the carved ground stays on the hillside, not at sea level', () => {
  // The carve replaces ortho.js's terrain-displaced 6x6 grid with a fresh
  // outline triangulation, and for the whole life of the terrain it built that
  // outline at y = 0 and stopped. Pardubice is 221 m up, so every chunk a river
  // ran through dropped its photographic ground to the bottom of the world and
  // left the roads hanging in the sky — which is exactly what the report
  // "chybí zem a reálná zem je až někde dole v nadmořské výšce 0" described.
  //
  // A sloping stub terrain makes both halves of the fix measurable at once:
  // the ground has to be LIFTED, and it has to be lifted per-vertex, which it
  // cannot be unless the outline was subdivided first.
  const terrain = { heightAt: (x) => 200 + x * 0.1, ready: () => true };
  const geometry = new THREE.PlaneGeometry(120, 120, 6, 6);
  geometry.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  mesh.position.set(60, 0, 60);

  const river = [[45, 0], [75, 0], [75, 120], [45, 120]];
  carveOrtho(mesh, 0, 0, 120, 120, [river], terrain);
  mesh.updateMatrixWorld(true);

  const p = mesh.geometry.attributes.position;
  let worst = 0, lowest = Infinity;
  for (let i = 0; i < p.count; i++) {
    worst = Math.max(worst, Math.abs(p.getY(i) - terrain.heightAt(p.getX(i))));
    lowest = Math.min(lowest, p.getY(i));
  }
  assert.ok(lowest > 190, `ground sank to ${lowest.toFixed(1)} m — it is at sea level again`);
  assert.ok(worst < 0.5, `ground departs from the terrain by ${worst.toFixed(2)} m`);

  // …and the photo must still register: UVs are derived from x/z, so the
  // subdivision must not have shifted them.
  const uv = mesh.geometry.attributes.uv;
  assert.equal(uv.count, p.count, 'a vertex was added without a UV');
  let uMin = Infinity, uMax = -Infinity;
  for (let i = 0; i < uv.count; i++) { uMin = Math.min(uMin, uv.getX(i)); uMax = Math.max(uMax, uv.getX(i)); }
  assert.ok(uMin > -0.01 && uMax < 1.01, `UVs ran off the tile: ${uMin} .. ${uMax}`);

  // and the river is still a hole
  const waterRay = new THREE.Raycaster(new THREE.Vector3(60, 400, 60), new THREE.Vector3(0, -1, 0));
  assert.equal(waterRay.intersectObject(mesh).length, 0, 'the carve stopped carving');
});

test('the manifest exposes the distant owner of the Labe polygon', async () => {
  const manifest = JSON.parse(await (await import('node:fs/promises'))
    .readFile(new URL('../public/data/manifest.json', import.meta.url), 'utf8'));
  const owner = manifest.tiles.find((t) => t.tx === 0 && t.tz === -2);
  assert.ok(owner?.wb, 'the river owner has no water bounds');
  const [x0, z0, x1, z1] = owner.wb;
  assert.ok(x0 <= -802 && x1 >= -802 && z0 <= -995 && z1 >= -995,
    'the manifest does not reveal that the Labe reaches the Pardubice bridge');
});

test('streaming loads a remote tile when its river reaches the player', async () => {
  const realFetch = globalThis.fetch;
  let remoteFetches = 0;
  const empty = {
    buildings: [], roads: [], rails: [], water: [], waterways: [],
    green: [], paved: [], trees: [], pois: [], signals: [],
  };
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => {
      if (url === 'manifest') return {
        tile: 4800,
        tiles: [{ tx: 10, tz: 10, f: 'remote', n: 1, wb: [-10, -10, 10, 10] }],
      };
      remoteFetches++;
      return empty;
    },
  });
  try {
    const city = await loadCity('manifest');
    await city.ensureTiles(0, 0);
    assert.equal(remoteFetches, 1, 'the distant river owner was not fetched');
    // First call marks its distant heavy layers slim; the next must not fetch
    // them again merely because the already-resident river still reaches us.
    await city.ensureTiles(0, 0);
    await city.ensureTiles(0, 0);
    assert.equal(remoteFetches, 1, 'long river caused a load/evict loop');
  } finally {
    globalThis.fetch = realFetch;
  }
});
