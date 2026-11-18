// ---- the D11 at night: interchange masts, delineators, two sign fixes ------
// Round 9 on the REAL tiles (tests/flow-harness.mjs loads them as the game does):
//   · a lit interchange (js/mwplan.js motorwayLit) is lit by 12 m masts
//     behind the guard rail (js/mastlamps.js), two arms along the motorway,
//     one along its slip roads; no town column stands on the rail any more;
//   · a mast never stands on a carriageway, in a gore without a rail, or in a
//     sign's legs, and each one is owned by exactly one cell;
//   · the open motorway stays dark;
//   · a mast chunk comes back from the mesh worker as built here;
//   · the far field and the pools know a mast's heads;
//   · the delineator glows keep a wider floor at full brightness, every other
//     glow keeps the old one;
//   · exit 95's shields are the I/11 and I/35 the slip leads to.

import test from 'node:test';
import assert from 'node:assert';
import { bootCity, loadAround } from './flow-harness.mjs';

const city = await bootCity();
const THREE = await import('three');
const { Terrain } = await import('../js/terrain.js');
const M = await import('../js/meshes.js');
const D = await import('../js/d11.js');
const S = await import('../js/streetlamps.js');
const ML = await import('../js/mastlamps.js');
const { allMotorwaySigns } = await import('../js/mwsigns.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode } = await import('../js/geomcodec.js');

const terrain = new Terrain(4800, 20);
async function ready(x, z) {
  await loadAround(city, x, z, 180000);
  terrain.ensure(x, z, 1500);
  for (let i = 0; i < 1000 && terrain._pending.size; i++) await new Promise((r) => setTimeout(r, 20));
}
const EX = (n) => D.EXITS.find((e) => e.n === n);

/** Every lamp list over the (2r+1)^2 cells round (x, z), each spot tagged with its cell. */
function plans(x, z, r = 6) {
  const cx = Math.floor(x / 120), cz = Math.floor(z / 120), out = { street: [], mast: [], mast1: [], keys: [] };
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
    const key = (cx + dx) + ',' + (cz + dz), cell = city.chunkIndex.get(key);
    if (!cell) continue;
    const p = M.lampPlan(cell, key, terrain, city);
    out.keys.push(key);
    for (const k of ['street', 'mast', 'mast1']) for (const s of p[k]) out[k].push({ s, key });
  }
  return out;
}
// metres from (x, z) to the asphalt edge of the nearest carriageway of the 3x3 cells round it
function toAsphalt(x, z, accept = () => true) {
  const cx = Math.floor(x / 120), cz = Math.floor(z / 120), seen = new Set();
  let best = Infinity;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    for (const r of city.chunkIndex.get((cx + dx) + ',' + (cz + dz))?.roads ?? []) {
      if (!r.d || !r.p || seen.has(r) || !accept(r)) continue;
      seen.add(r);
      for (let i = 0; i + 1 < r.p.length; i++) {
        const [ax, az] = r.p[i], ex = r.p[i + 1][0] - ax, ez = r.p[i + 1][1] - az, L2 = ex * ex + ez * ez || 1e-9;
        let t = ((x - ax) * ex + (z - az) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
        best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z) - (r.w ?? 3) / 2);
      }
    }
  }
  return best;
}

test('a mast is twelve metres of column with its lenses at the arms\' ends', () => {
  for (const [kind, arms] of [['mast', 2], ['mast1', 1]]) {
    const [post, lens] = S.lampGeoms(kind);
    const lp = lens.attributes.position, zs = new Set();
    for (let i = 0; i < lp.count; i++) {
      assert.ok(Math.abs(lp.getY(i) - S.MAST_Y) < 0.12, `${kind}: a lens vertex at ${lp.getY(i).toFixed(2)} m`);
      zs.add(Math.sign(lp.getZ(i)));
      assert.ok(Math.abs(Math.abs(lp.getZ(i)) - S.MAST_OUT) < 0.45, `${kind}: a lens ${lp.getZ(i).toFixed(2)} m out`);
    }
    assert.equal(zs.size, arms, `${kind}: lenses on ${zs.size} sides`);
    // the first arm is the one over the road: local -z, as a street column's
    assert.ok(zs.has(-1));
    post.computeBoundingBox();
    assert.ok(post.boundingBox.max.y > 12 && post.boundingBox.max.y < 12.5, `${kind}: ${post.boundingBox.max.y.toFixed(2)} m tall`);
    assert.ok(S.lampFallGeom(kind).attributes.position.count > post.attributes.position.count);
  }
});

test('exit 8 Jirny is lit by masts behind the rail, and no town column stands on the motorway', async () => {
  const c = EX(8).E.div;
  await ready(c.x, c.z);
  const p = plans(c.x, c.z);
  assert.ok(p.mast.length >= 25, `${p.mast.length} motorway masts`);
  assert.ok(p.mast1.length >= 12, `${p.mast1.length} slip-road masts`);
  for (const { s } of p.street) {
    const l = D.d11Locate(s[0], s[1]);
    assert.ok(!l || Math.abs(l.off) > 12, `a street column ${l?.off.toFixed(1)} m off the D11 at ${s[0].toFixed(0)}, ${s[1].toFixed(0)}`);
  }
  for (const { s } of p.mast) {
    const l = D.d11Locate(s[0], s[1]);
    assert.ok(l && Math.abs(Math.abs(l.off) - (s.length === 4 ? 6.25 - 0.12 : 6.25 + ML.MAST_OFF)) < 0.3,
      `a motorway mast ${l?.off.toFixed(2)} m off its line`);
    if (s.length < 4) assert.ok(toAsphalt(s[0], s[1]) > 1.4, `a mast ${toAsphalt(s[0], s[1]).toFixed(2)} m from asphalt`);
    // the arm reaches over the carriageway: the first head is nearer the line than the foot
    const hx = s[0] - Math.sin(s[2]) * S.MAST_OUT, hz = s[1] - Math.cos(s[2]) * S.MAST_OUT;
    assert.ok(Math.abs(D.d11Locate(hx, hz).off) < Math.abs(l.off) - 2.5, 'the arm points away from the road');
  }
  for (const { s } of p.mast1) {
    if (s.length === 4) continue;
    assert.ok(toAsphalt(s[0], s[1], r => !r.br) >= ML.SLIP_CLEAR - 1e-6);
    assert.ok(toAsphalt(s[0], s[1], r => !r.br && r.t === 'motorway') >= ML.MOTORWAY_CLEAR - 1e-6);
  }
});

test('a lit slip keeps its distant lights and interchange bridge lights stand on the deck', () => {
  const node = EX(8).E.div;
  const ramp = { _id: 13, d: 1, ow: 1, t: 'motorway_link', w: 5.5, p: [[node.x, node.z], [node.x, node.z + 560]] };
  const g = { near: [], inRoad: () => false, onPad: () => false, inHouse: () => false, nearMapped: () => false,
    terrain, mast1: [], mast: [] };
  const plan = r => ML.mastsAlong(r, ML.mastKind(r), node.x - 30, node.z - 10, node.x + 30, node.z + 565, g);
  assert.ok(plan(ramp));
  assert.ok(g.mast1.some(s => s[1] > node.z + 300), 'no light beyond the 250 m interchange radius');
  g.mast1.length = 0;
  assert.ok(plan({ ...ramp, br: 1 }));
  assert.ok(g.mast1.length > 4 && g.mast1.every(s => Number.isFinite(s[3])), 'every deck light has a deck-relative socket');
});

test('no mast in a sign\'s legs or through a board, and each mast has one owner', async () => {
  for (const n of [8, 68, 84]) {
    const c = EX(n).E.div;
    await ready(c.x, c.z);
    const p = plans(c.x, c.z);
    const all = [...p.mast, ...p.mast1];
    assert.ok(all.length > 20, `exit ${n}: ${all.length} masts`);
    const signs = allMotorwaySigns().filter((it) => Math.hypot(it.cx - c.x, it.cz - c.z) < 1200);
    for (const { s } of all) {
      for (const it of signs) {
        const ex = s[0] - it.cx, ez = s[1] - it.cz;
        const along = ex * it.dx + ez * it.dz, across = -ex * it.dz + ez * it.dx;
        assert.ok(!(Math.abs(along) < 12 && Math.abs(across) < 30), `exit ${n}: a mast in the box of a ${it.t} at km ${it.km}`);
      }
    }
    // planned once: no two masts on the same spot from two cells
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      const d = Math.hypot(all[i].s[0] - all[j].s[0], all[i].s[1] - all[j].s[1]);
      assert.ok(d > 5, `exit ${n}: two masts ${d.toFixed(2)} m apart (cells ${all[i].key}, ${all[j].key})`);
    }
  }
});

test('the open D11 at km 30 has no masts', async () => {
  const a = D.d11At(30, 'E');
  await ready(a.x, a.z);
  const p = plans(a.x, a.z, 4);
  assert.equal(p.mast.length + p.mast1.length, 0);
});

function nodesOf(root) {
  const out = [];
  root.updateMatrixWorld(true);
  const walk = (o) => { for (const c of o.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}
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

test('a chunk with masts comes back from the worker with the same masts', async () => {
  const c = EX(8).E.div;
  await ready(c.x, c.z);
  // the cell owning the most masts of both kinds
  const p = plans(c.x, c.z, 3);
  const count = new Map();
  for (const { key } of [...p.mast, ...p.mast1]) count.set(key, (count.get(key) ?? 0) + 1);
  const key = [...count].sort((a, b) => b[1] - a[1])[0][0];
  const [cx, cz] = key.split(',').map(Number);
  const ms = mats();
  const sync = M.buildChunkMeshes(city, cx, cz, ms, 'full');
  const world = { city, terrain, canopy: null, ground: null, mats: ms };
  const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
  const out = buildChunkPayload(makeWorkerState(), structuredClone(got.spec, { transfer: got.transfer }));
  const dec = { ...ms, codecMats: {} };
  for (const k of Object.keys(out.brands ?? {})) dec.codecMats[k] = ms._wm;
  const back = decode(out.payload, dec);
  let seen = 0;
  for (const name of ['mastPosts', 'mast1Posts']) {
    const a = nodesOf(sync).find((o) => o.name === name), b = nodesOf(back).find((o) => o.name === name);
    if (!a) { assert.ok(!b, `${name} only in the worker's chunk`); continue; }
    assert.ok(b, `${name} missing from the worker's chunk`);
    assert.equal(b.count, a.count);
    assert.equal(b.userData.kind, a.userData.kind);
    assert.deepEqual(b.userData.spots.map((v) => +v.toFixed(3)), a.userData.spots.map((v) => +v.toFixed(3)));
    // the codec folds a template's scale into the instance matrix, so compare
    // where each instance puts the steel in the world, not the matrices
    const ia = new THREE.Matrix4(), ib = new THREE.Matrix4(), pa = new THREE.Vector3(), pb = new THREE.Vector3();
    const ga = a.geometry.attributes.position, gb = b.geometry.attributes.position;
    assert.equal(gb.count, ga.count, 'a different mast template');
    let worst = 0;
    for (let i = 0; i < a.count; i++) {
      a.getMatrixAt(i, ia); b.getMatrixAt(i, ib);
      for (let v = 0; v < ga.count; v += 5) {
        pa.fromBufferAttribute(ga, v).applyMatrix4(ia).applyMatrix4(a.matrixWorld);
        pb.fromBufferAttribute(gb, v).applyMatrix4(ib).applyMatrix4(b.matrixWorld);
        worst = Math.max(worst, pa.distanceTo(pb));
      }
    }
    assert.ok(worst < 0.01, `${name}: ${(worst * 1000).toFixed(1)} mm apart`);
    seen += a.count;
  }
  assert.ok(seen > 0, `no masts in chunk ${key}`);
});

test('the far field puts a point at every mast head, twelve metres up', async () => {
  const { cellPoints } = await import('../js/farlights.js');
  const c = EX(8).E.div;
  await ready(c.x, c.z);
  const p = plans(c.x, c.z, 3);
  const { s, key } = p.mast[0];
  const pts = cellPoints(key, city.chunkIndex.get(key), terrain, false, city);
  const g = terrain.heightAt(s[0], s[1]);
  let heads = 0;
  for (let i = 0; i < pts.length; i += 6) {
    if (Math.hypot(pts[i] - s[0], pts[i + 2] - s[1]) < S.MAST_OUT + 0.01 && Math.abs(pts[i + 1] - g - S.MAST_Y) < 0.01) heads++;
  }
  assert.equal(heads, 2, 'two heads of a two-armed mast');
});

test('a two-armed mast throws two pools, one under each head', async () => {
  const { LightPools } = await import('../js/lightpools.js');
  const c = EX(8).E.div;
  await ready(c.x, c.z);
  const p = plans(c.x, c.z, 3);
  const { s } = p.mast[0];
  const posts = { userData: { spots: [s[0], s[1], s[2]] } };
  const y = terrain.heightAt(s[0], s[1]);
  const poles = { grid: new Map([['a', [{ x: s[0], y, z: s[1], i: 0, posts, kind: 'mast' }]]]) };
  const lp = new LightPools(new THREE.Scene());
  lp._rebuild(poles, { terrain, surfaceY: null }, s[0], s[1]);
  assert.equal(lp.count, 2);
  const m = new THREE.Matrix4(), v = new THREE.Vector3();
  const heads = [];
  for (let k = 0; k < 2; k++) { lp.glows.getMatrixAt(k, m); heads.push(v.setFromMatrixPosition(m).clone()); }
  for (const h of heads) {
    assert.ok(Math.abs(h.y - y - S.MAST_Y) < 0.2, 'a glow not at the head');
    assert.ok(Math.abs(Math.hypot(h.x - s[0], h.z - s[1]) - S.MAST_OUT) < 0.01, 'a glow not at the arm\'s end');
  }
  assert.ok(heads[0].distanceTo(heads[1]) > 2 * S.MAST_OUT - 0.01, 'the two heads on one side');
  // and a street column still throws exactly one
  const one = { grid: new Map([['a', [{ x: 0, y: 0, z: 0, i: 0, posts: { userData: { spots: [0, 0, 0] } }, kind: 'street' }]]]) };
  lp._rebuild(one, { terrain: null, surfaceY: null }, 0, 0);
  assert.equal(lp.count, 1);
});

test('the delineator glows keep a wider floor at full brightness; every other glow is as it was', async () => {
  const { LightPools } = await import('../js/lightpools.js');
  const { MwRetro, retroGain } = await import('../js/mwretro.js');
  const scene = new THREE.Scene();
  const lp = new LightPools(scene);
  assert.equal(lp.glowMat.uniforms.uFloorPx.value, 1.1);
  assert.equal(lp.glowMat.uniforms.uGive.value, 1);
  assert.equal(lp.far.mat.uniforms.uFloorPx.value, 1.1, 'the far field changed');
  const r = new MwRetro(scene);
  r.attach(lp);
  assert.ok(r.mesh.material.uniforms.uFloorPx.value >= 4);
  assert.equal(r.mesh.material.uniforms.uGive.value, 0);
  // the chain recedes: each reflector further out in the beam's core sends back less
  const g = (d) => retroGain(d, 1, 0, 1, 0, 0, 0.75, 0, 1, 0);
  let last = Infinity;
  for (const d of [60, 100, 140, 180]) { assert.ok(g(d) > 0 && g(d) < last, `at ${d} m`); last = g(d); }
});

test('exit 95 signs the I/11 and the I/35 its slips lead to; exit 90 W reads as its tags', () => {
  const e95 = EX(95), e90 = EX(90);
  for (const cw of ['E', 'W']) {
    assert.deepEqual([...e95[cw].refs], ['I/11', 'I/35']);
    assert.ok(!e95[cw].refs.includes('D35'));
  }
  assert.deepEqual([...e90.W.to], ['Nový Bydžov', 'Hradec Králové-Kukleny']);
});
