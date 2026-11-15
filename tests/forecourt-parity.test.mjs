// Round 8 services: a forecourt under its lifted canopy (js/d11services.js,
// meshes.js canopyFuelInto) and a built one (fuelInto through
// js/forecourt.js) come out of the mesh worker exactly as the main thread
// builds them. tests/meshworker.test.mjs covers a town chunk with no fuel;
// this is the same comparison on a chunk with both kinds of station.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { polylineLength, JUNCTIONS, CLUSTERS, setStreetCity, indexJunctions } = await import('../js/geo.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { servicesInto } = await import('../js/d11services.js');
const { Canopy } = await import('../js/canopy.js');
const { GroundClass, GROUND_RES } = await import('../js/groundclass.js');
const { orthoQuad } = await import('../js/ortho.js');

function terrainWith() {
  const t = new Terrain(4800, 20);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++)
    g[j * t.n + i] = Math.round((240 + Math.sin(i * 0.3) * 1.5 + Math.cos(j * 0.2)) * 10);
  t.grids.set('0,0', g);
  t._loads = 1;
  return t;
}

const world_extra = {};
function makeWorld() {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const tag = (f) => { f._id = ++id; return f; };
  const roads = [
    tag({ t: 'service', w: 3.6, d: 1, ow: 1, p: [[5, 30], [115, 34]] }),        // the lanes under the canopy
    // a street for the built one (5 m: under LAMP_MIN_W, so no street lamps:
    // their placement is not what this compares)
    tag({ t: 'residential', w: 5, d: 1, p: [[5, 95], [115, 95]] }),
  ];
  for (const r of roads) r._len = polylineLength(r.p);
  const roof = tag({ t: 'roof', h: 4.3, o: [[30, 20], [70, 20], [70, 44], [30, 44]] });
  const shop = tag({ t: 'retail', h: 4.3, o: [[30, 50], [60, 50], [60, 62], [30, 62]] });
  const payload = {
    tx: 0, tz: 0, roads, buildings: [roof, shop],
    pois: [{ p: [48, 33], t: 'fuel', n: 'MOL' }, { p: [90, 88], t: 'fuel', n: 'Shell' }],
  };
  servicesInto(payload);
  assert.ok(payload.pois[0].cv && roof.y > 0, 'the canopy was lifted and framed');
  assert.ok(!payload.pois[1].cv, 'the second station has no mapped roof');
  const cell = {
    buildings: payload.buildings, roads, rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [],
  };
  for (const list of Object.values(cell)) for (const f of list) f._home = '0,0';
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: payload.pois, waterways: [] };
  indexJunctions(roads);
  setStreetCity(city);
  const terrain = terrainWith();
  const mats = makeMaterials();
  mats.terrain = terrain; mats.hidden = new Set(); mats.facades = true;
  // the same supporting cast tests/meshworker.test.mjs builds with
  const canopy = new Canopy(4800, 10);
  canopy.grids.set('0,0', new Uint8Array(canopy.n * canopy.n));
  const ground = new GroundClass();
  ground.grids.set('0,0', new Uint8Array((4800 / GROUND_RES) ** 2));
  mats.canopy = canopy; mats.ground = ground;
  const photo = new THREE.MeshLambertMaterial();
  const plan = { mat: photo, lx: 0, lz: 0, S: 4, px: 512 };
  mats.ortho = { plan: () => plan, tierOf: () => plan.px,
    orthoGroundMesh: (cx, cz) => orthoQuad(cx, cz, plan, terrain, photo) };
  world_extra.photo = photo; world_extra.canopy = canopy; world_extra.ground = ground;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wordmark = new THREE.MeshBasicMaterial();
  mats.brandMat = () => wordmark;
  return { city, terrain, mats, wordmark, ...world_extra };
}

function nodesOf(root) {
  const out = [];
  root.updateMatrixWorld(true);
  const walk = (o) => { for (const c of o.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

test('a chunk with a canopied and a built forecourt: worker = main thread', () => {
  const world = makeWorld();
  const sync = buildChunkMeshes(world.city, 0, 0, world.mats, 'full');
  assert.ok(sync, 'nothing built');
  const got = chunkSpec(world, 0, 0, 'full', { terrain: new Map(), canopy: new Map() });
  assert.ok(got, 'chunkSpec refused the cell');
  const posted = structuredClone(got.spec, { transfer: got.transfer });
  const out = buildChunkPayload(makeWorkerState(), posted);
  assert.ok(!out.empty && out.payload, 'the worker built nothing');
  const decMats = { ...world.mats, codecMats: { ortho: world.photo } };
  for (const k of Object.keys(out.brands)) decMats.codecMats[k] = world.wordmark;
  const back = decode(out.payload, decMats);
  const a = nodesOf(sync), b = nodesOf(back);
  assert.equal(b.length, a.length, 'different shape');
  let worst = 0, checked = 0;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x.isMesh) continue;
    const n = x.geometry.attributes.position.count;
    assert.equal(y.geometry.attributes.position.count, n, `node ${i} changed vertex count`);
    for (let v = 0; v < n; v++) {
      p.fromBufferAttribute(x.geometry.attributes.position, v).applyMatrix4(x.matrixWorld);
      q.fromBufferAttribute(y.geometry.attributes.position, v).applyMatrix4(y.matrixWorld);
      const d = p.distanceTo(q);
      if (d > worst) { worst = d; globalThis.__w = `node ${i} ${x.name || x.material?.name || x.type} v${v} of ${n} main ${p.toArray().map((c) => c.toFixed(2))} worker ${q.toArray().map((c) => c.toFixed(2))}`; }
      checked++;
    }
  }
  assert.ok(checked > 1000, `only ${checked} vertices`);
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm apart at ${globalThis.__w}`);
});
