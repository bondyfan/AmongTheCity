// ---- round 8 look fixes: the green bridges and the delineators at night ----
//   · js/mwtall.js draws each ecoduct sitting IN its earth hump (deck top
//     level with the hump, wing walls, earth down to the survey, planting),
//     the same on the main thread and in the mesh worker, in both tiers;
//   · js/mwretro.js finds the reflectors at the stations js/mwdress.js draws
//     and lights only those in the player's beams, facing the player.

import test from 'node:test';
import assert from 'node:assert';
import { bootCity, loadAround } from './flow-harness.mjs';

const city = await bootCity();
const THREE = await import('three');
const { Terrain } = await import('../js/terrain.js');
const M = await import('../js/meshes.js');
const T = await import('../js/mwtall.js');
const R = await import('../js/mwretro.js');
const { barrierPlan } = await import('../js/mwplan.js');
const { ECODUCTS, d11At } = await import('../js/d11.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');

const terrain = new Terrain(4800, 20);
async function ready(x, z) {
  await loadAround(city, x, z, 180000);
  terrain.ensure(x, z, 1500);
  for (let i = 0; i < 1000 && terrain._pending.size; i++) await new Promise((r) => setTimeout(r, 20));
}

// a stand-in sink that records triangles
function sink() {
  return { pos: [], tris: 0, layer: 0, mark() { return this.pos.length; }, fixFrom() {}, at(l) { this.layer = l; return this; },
    tri(...a) { this.pos.push(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], a[8]); this.tris++; },
    quad(...a) { this.tri(...a.slice(0, 9)); this.tri(a[0], a[1], a[2], a[6], a[7], a[8], a[9], a[10], a[11]); } };
}

test('each green bridge sits in its hump: deck top level with the earth beside it, planted, cheap', async () => {
  for (const e of ECODUCTS) {
    const F = T.ecoductFrame(e);
    await ready(F.x, F.z);
    const s = sink();
    T.motorwayTallInto(s, { roads: [] }, F.key, terrain);
    assert.ok(s.tris > 600 && s.tris < 6000, `${e.name}: ${s.tris} triangles`);
    // the top of what is drawn over the deck: planting stands 2 to 6 m over
    // the hump beside the deck (the earth either side, 30 m out)
    let top = -Infinity;
    const vx = -F.uz, vz = F.ux;
    for (let i = 0; i < s.pos.length; i += 3) {
      const a = (s.pos[i] - F.x) * F.ux + (s.pos[i + 2] - F.z) * F.uz, c = (s.pos[i] - F.x) * vx + (s.pos[i + 2] - F.z) * vz;
      if (Math.abs(a) < F.hl && Math.abs(c) < 20) top = Math.max(top, s.pos[i + 1]);
    }
    const hump = Math.min(terrain.heightAt(F.x + vx * 32, F.z + vz * 32), terrain.heightAt(F.x - vx * 32, F.z - vz * 32));
    assert.ok(top > hump + 1.5 && top < hump + 9, `${e.name}: planting top ${top.toFixed(1)} over a hump at ${hump.toFixed(1)}`);
    // and nothing floats far out: every vertex within the wing walls' reach
    for (let i = 0; i < s.pos.length; i += 3) {
      const a = (s.pos[i] - F.x) * F.ux + (s.pos[i + 2] - F.z) * F.uz;
      assert.ok(Math.abs(a) < F.hl + 20, 'a vertex past the wing walls');
    }
  }
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

for (const e of ECODUCTS) for (const tier of ['full', 'shell']) {
  test(`the ${e.name} chunk (${tier}) comes back from the worker as built here`, async () => {
    const F = T.ecoductFrame(e);
    await ready(F.x, F.z);
    const ms = mats();
    const cx = Math.floor(F.x / 120), cz = Math.floor(F.z / 120);
    const sync = M.buildChunkMeshes(city, cx, cz, ms, tier);
    assert.ok(sync, 'nothing built');
    const world = { city, terrain, canopy: null, ground: null, mats: ms };
    const got = chunkSpec(world, cx, cz, tier, { terrain: new Map(), canopy: new Map() });
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

test('reflectors stand where the delineators are drawn, every 48 m, both colours', async () => {
  const k30 = d11At(30, 'E');
  await ready(k30.x, k30.z);
  // a 5 x 5 block of cells round km 30: about 600 m of both carriageways
  const pts = [];
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const key = (Math.floor(k30.x / 120) + dx) + ',' + (Math.floor(k30.z / 120) + dz);
    const cell = city.chunkIndex.get(key);
    if (cell) pts.push(...R.reflectorsOf(barrierPlan(cell, key, terrain, 0)));
  }
  const n = pts.length / 8;
  // four lines (two rails, both faces of the median) every 48 m
  assert.ok(n >= 30 && n <= 70, `${n} reflectors along 600 m of dual carriageway`);
  let amber = 0, white = 0;
  for (let i = 0; i < pts.length; i += 8) {
    if (pts[i + 6] < 0.6) amber++; else white++;
    assert.ok(Math.abs(Math.hypot(pts[i + 3], pts[i + 4]) - 1) < 1e-6);
    const g = terrain.heightAt(pts[i], pts[i + 2]);
    assert.ok(pts[i + 1] > g && pts[i + 1] < g + 3, 'reflector height');
  }
  assert.ok(amber >= 2 && white >= 2, `${amber} amber, ${white} white`);
});

test('a reflector shines only in the beam, facing the car, within reach', () => {
  // car at the origin heading +x (h = -pi/2: dirX = -sin h = 1), lamps 0.75 m up
  const g = (x, z, tx = -1, tz = 0) => R.retroGain(x, 1, z, tx, tz, 0, 0.75, 0, 1, 0);
  // a delineator serving the car's own direction of travel faces back at it
  assert.equal(R.retroGain(100, 1, 3, 1, 0, 0, 0.75, 0, 1, 0) > 0.5, true, 'ahead, in the beam, facing');
  assert.equal(R.retroGain(100, 1, 3, -1, 0, 0, 0.75, 0, 1, 0), 0, 'the other carriageway\'s face');
  assert.equal(R.retroGain(-50, 1, 3, 1, 0, 0, 0.75, 0, 1, 0), 0, 'behind the car');
  assert.equal(R.retroGain(60, 1, 40, 1, 0, 0, 0.75, 0, 1, 0), 0, 'off to the side, out of the beam');
  assert.equal(R.retroGain(400, 1, 3, 1, 0, 0, 0.75, 0, 1, 0), 0, 'beyond the beam\'s reach');
  assert.ok(R.retroGain(200, 1, 6, 1, 0, 0, 0.75, 0, 1, 0) < R.retroGain(100, 1, 3, 1, 0, 0, 0.75, 0, 1, 0), 'fades with distance');
  assert.ok(typeof g === 'function');
});
