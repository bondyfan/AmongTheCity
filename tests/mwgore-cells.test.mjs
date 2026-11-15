// ---- a motorway piece paints its gore against the slip roads of every cell
// along it, on the main thread and in the mesh worker alike ----
// A motorway piece is drawn by its home chunk over its whole length, but the
// home cell lists only the ways touching that chunk. Read from it alone,
// 9 of the 70 D11 pieces with a slip road lost their whole gore and 30 more
// lost part of it (round 8 review). js/mwpaint.js goreCellKeys gathers the
// cells and js/chunkspec.js ships the same ones to the worker.

import test from 'node:test';
import assert from 'node:assert';
import { bootCity, loadAround } from './flow-harness.mjs';

const city = await bootCity();
const THREE = await import('three');
const { Terrain } = await import('../js/terrain.js');
const M = await import('../js/meshes.js');
const { goreCellKeys } = await import('../js/mwpaint.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');

const terrain = new Terrain(4800, 20);
async function ready(x, z) {
  await loadAround(city, x, z, 180000);
  terrain.ensure(x, z, 1500);
  for (let i = 0; i < 1000 && terrain._pending.size; i++) await new Promise((r) => setTimeout(r, 20));
}
// chunks homing a D11 piece whose slip road leaves it away from the home
// chunk (measured: the most paint lost)
const CHUNKS = [[-402, -83], [16, -101]];

test('the slip roads a piece paints against include ones its home cell does not list', async () => {
  let extra = 0;
  for (const [cx, cz] of CHUNKS) {
    await ready(cx * 120 + 60, cz * 120 + 60);
    const key = cx + ',' + cz, cell = city.chunkIndex.get(key);
    for (const f of cell.roads) {
      if (f._home !== key || f.t !== 'motorway') continue;
      for (const k of goreCellKeys(city, f, new Set())) {
        for (const r of city.chunkIndex.get(k).roads) if (r.t === 'motorway_link' && !cell.roads.includes(r)) extra++;
      }
    }
  }
  assert.ok(extra > 0, 'no slip road beyond the home cells');
});

function mats() {
  const m = M.makeMaterials();
  m.terrain = terrain; m.canopy = null; m.ground = null; m.ortho = null;
  m.hidden = new Set(); m.facades = true;
  m._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const wm = new THREE.MeshBasicMaterial();
  m.brandMat = () => wm;
  m._wm = wm;
  return m;
}
function nodesOf(root) {
  const out = [];
  root.updateMatrixWorld(true);
  const walk = (o) => { for (const c of o.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

for (const [cx, cz] of CHUNKS) {
  test(`the gore chunk ${cx},${cz} comes back from the worker as built here`, async () => {
    await ready(cx * 120 + 60, cz * 120 + 60);
    const ms = mats();
    const sync = M.buildChunkMeshes(city, cx, cz, ms, 'full');
    assert.ok(sync, 'nothing built');
    const world = { city, terrain, canopy: null, ground: null, mats: ms };
    const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
    const out = buildChunkPayload(makeWorkerState(), structuredClone(got.spec, { transfer: got.transfer }));
    assert.ok(!out.empty && out.payload, 'the worker built nothing');
    const dec = { ...ms, codecMats: {} };
    for (const k of Object.keys(out.brands ?? {})) dec.codecMats[k] = ms._wm;
    const a = nodesOf(sync), b = nodesOf(decode(out.payload, dec));
    assert.equal(b.length, a.length, 'a different set of meshes');
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let worst = 0, checked = 0;
    for (let i = 0; i < a.length; i++) {
      if (!a[i].isMesh || a[i].isInstancedMesh) continue;
      const pa = a[i].geometry.attributes.position, pb = b[i].geometry.attributes.position;
      assert.equal(pb.count, pa.count, `${a[i].name} vertex count`);
      for (let v = 0; v < pa.count; v++) {
        p.set(pa.getX(v), pa.getY(v), pa.getZ(v)).applyMatrix4(a[i].matrixWorld);
        q.set(pb.getX(v), pb.getY(v), pb.getZ(v)).applyMatrix4(b[i].matrixWorld);
        worst = Math.max(worst, p.distanceTo(q)); checked++;
      }
    }
    assert.ok(checked > 3000, `only ${checked} vertices`);
    assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm apart`);
  });
}
