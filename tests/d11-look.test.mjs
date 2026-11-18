// ---- the D11 looks like a motorway: barriers, paint, light, the worker ----
// Round 8 MOTORWAY-LOOK on the REAL tiles (tests/flow-harness.mjs loads them
// the way the game does) and the real height maps:
//   · js/mwplan.js plans a median barrier midway between the carriageways and
//     a guard rail on each outer edge, the same in any tile order;
//   · js/mwsolid.js pushes a car out of exactly those lines, at their level;
//   · the open D11 has no rule street lamps, its interchanges do;
//   · a D11 chunk comes back from the mesh worker as the main thread built it
//     (a straight, an interchange, the Chlumec viaduct), so the dressing and
//     the paint agree on both threads.

import test from 'node:test';
import assert from 'node:assert';
import { bootCity, loadAround } from './flow-harness.mjs';

const city = await bootCity();
const THREE = await import('three');
const { Terrain } = await import('../js/terrain.js');
const M = await import('../js/meshes.js');
const P = await import('../js/mwplan.js');
const { barrierCollide, resetBarrierMemo } = await import('../js/mwsolid.js');
const { d11Line } = await import('../js/d11.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');

const terrain = new Terrain(4800, 20);
async function ready(x, z) {
  await loadAround(city, x, z, 180000);
  terrain.ensure(x, z, 1500);
  for (let i = 0; i < 1000 && terrain._pending.size; i++) await new Promise((r) => setTimeout(r, 20));
}
const keyOf = (x, z) => Math.floor(x / 120) + ',' + Math.floor(z / 120);
const KM30 = [-55100, -9687], VIADUCT = [-24999, -10674], EXIT8 = [-75653, -10075];

// nearest distance from (x, z) to a d11.js line
function toLine(cw, x, z) {
  const q = d11Line(cw);
  let best = Infinity;
  for (let i = 0; i + 1 < q.n; i++) {
    const ax = q.x[i], az = q.z[i], ex = q.x[i + 1] - ax, ez = q.z[i + 1] - az;
    // (segment boxes, not vertices: the line has straights a kilometre long)
    if (Math.min(ax, ax + ex) > x + 50 || Math.max(ax, ax + ex) < x - 50 || Math.min(az, az + ez) > z + 50 || Math.max(az, az + ez) < z - 50) continue;
    const L2 = ex * ex + ez * ez || 1e-9;
    let t = ((x - ax) * ex + (z - az) * ez) / L2; t = t < 0 ? 0 : t > 1 ? 1 : t;
    best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
  }
  return best;
}

test('the straight at km 30 gets a median barrier midway and a rail on each edge', async () => {
  await ready(...KM30);
  const key = keyOf(...KM30), cell = city.chunkIndex.get(key);
  const cws = cell.roads.filter((r) => r.t === 'motorway').map(P.cwOf).sort();
  assert.deepEqual(cws, ['E', 'W'], 'the two carriageways are recognised as the D11');
  const plan = P.barrierPlan(cell, key, terrain, 0);
  const med = plan.filter((r) => r.k === P.K_MEDIAN), rail = plan.filter((r) => r.k === P.K_RAIL);
  assert.equal(med.length, 2, 'one median half per carriageway');
  assert.equal(rail.length, 2, 'one outer rail per carriageway');
  for (const r of med) for (let i = 0; i < r.v.length; i += P.STRIDE) {
    const dE = toLine('E', r.v[i], r.v[i + 1]), dW = toLine('W', r.v[i], r.v[i + 1]);
    assert.ok(Math.abs(dE - dW) < 0.15, `median off the midpoint by ${(dE - dW).toFixed(2)} m`);
  }
  for (const r of rail) for (let i = 0; i < r.v.length; i += P.STRIDE) {
    const d = Math.min(toLine('E', r.v[i], r.v[i + 1]), toLine('W', r.v[i], r.v[i + 1]));
    assert.ok(Math.abs(d - 6.85) < 0.2, `outer rail ${d.toFixed(2)} m off its centreline`);
  }
  // the order the roads were listed in decides nothing
  const sig = (pl) => JSON.stringify(pl.map((r) => [r.k, r.id, r.ends, r.v.map((a) => a.toFixed(3))]).sort());
  const shuffled = { ...cell, roads: [...cell.roads].reverse() };
  assert.equal(sig(P.barrierPlan(shuffled, key, terrain, 0)), sig(plan));
});

test('neighbouring cells share every barrier piece exactly once', async () => {
  await ready(...KM30);
  const [x, z] = KM30, cx = Math.floor(x / 120), cz = Math.floor(z / 120);
  // the E carriageway's outer rail, cell by cell along three cells
  const pieces = new Map();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const key = (cx + dx) + ',' + (cz + dz), cell = city.chunkIndex.get(key);
    if (!cell) continue;
    for (const r of P.barrierPlan(cell, key, terrain, 0)) {
      for (let i = 0; i + P.STRIDE < r.v.length; i += P.STRIDE) {
        const k = r.k + ':' + r.v[i].toFixed(2) + ',' + r.v[i + 1].toFixed(2);
        pieces.set(k, (pieces.get(k) ?? 0) + 1);
      }
    }
  }
  assert.ok(pieces.size > 100, `only ${pieces.size} pieces planned round km 30`);
  for (const [k, n] of pieces) assert.equal(n, 1, `piece ${k} is drawn by ${n} cells`);
});

test('a barrier runs on unbroken where one way of a carriageway meets the next', async () => {
  // every way walks its own 4 m station grid from its first vertex, so its
  // last station falls short of its end node by up to 4 m; the end node is
  // a station too, or each joint of two ways (about one every few hundred
  // metres) left that much daylight in the median and the rails
  let ends = 0;
  for (const at of [KM30, EXIT8, VIADUCT]) {
    await ready(...at);
    const cx = Math.floor(at[0] / 120), cz = Math.floor(at[1] / 120);
    const starts = [], open = [];
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
      const key = (cx + dx) + ',' + (cz + dz), cell = city.chunkIndex.get(key);
      if (!cell) continue;
      for (const r of P.barrierPlan(cell, key, terrain, 0)) {
        const e = r.v.length - P.STRIDE;
        starts.push([r.k, r.sd, r.v[0], r.v[1]]);
        // a run end without a terminal must be met by another run's start
        // (within a bend's mitre: the next way's normal turns at the node)
        if (!(r.ends & 2) && Math.abs(dx) < 3 && Math.abs(dz) < 3) open.push([r.k, r.sd, r.v[e], r.v[e + 1]]);
      }
    }
    for (const [k, sd, x, z] of open) {
      ends++;
      const near = Math.min(...starts.filter((s) => s[0] === k && s[1] === sd).map((s) => Math.hypot(s[2] - x, s[3] - z)));
      assert.ok(near < 0.25 || near > 6, `a ${near.toFixed(2)} m gap in a ${k === P.K_MEDIAN ? 'median' : 'rail'} at ${x.toFixed(1)}, ${z.toFixed(1)}`);
    }
  }
  assert.ok(ends > 50, `only ${ends} run ends checked`);
});

test('a car is pushed out of the rail at its level, and not from an overpass', async () => {
  await ready(...KM30);
  resetBarrierMemo();
  const key = keyOf(...KM30), cell = city.chunkIndex.get(key);
  const rail = P.barrierPlan(cell, key, terrain, 0).find((r) => r.k === P.K_RAIL);
  const v = rail.v, i = P.STRIDE * 3;
  const world = { city, terrain };
  const y = v[i + 2];
  // a probe right on the rail line, road side: pushed toward the road
  const pos = { x: v[i] + v[i + 3] * 0.1, z: v[i + 1] + v[i + 4] * 0.1 };
  assert.ok(barrierCollide(world, pos, 0.5, { y: y + 0.3 }));
  const sd = (pos.x - v[i]) * v[i + 3] + (pos.z - v[i + 1]) * v[i + 4];
  assert.ok(sd > 0.55, `left ${sd.toFixed(2)} m from the rail line, on the road side`);
  // a car going through at 130 km/h lands 0.3 m past the face: still held
  const pos2 = { x: v[i] - v[i + 3] * 0.3, z: v[i + 1] - v[i + 4] * 0.3 };
  barrierCollide(world, pos2, 0.5, { y: y + 0.3 });
  assert.ok((pos2.x - v[i]) * v[i + 3] + (pos2.z - v[i + 1]) * v[i + 4] > 0.5, 'tunnelled through the rail');
  // six metres up (an overpass deck) nothing is in the way, and a caller
  // with no level is never stopped by a guess
  const pos3 = { x: v[i], z: v[i + 1] };
  assert.equal(barrierCollide(world, pos3, 0.5, { y: y + 6 }), false);
  assert.equal(barrierCollide(world, pos3, 0.5), false);
});

test('the open D11 is dark, its interchange lit', async () => {
  const near = (plan, x, z) => plan.street.some((s) => {
    for (const cw of ['E', 'W']) if (toLine(cw, s[0], s[1]) < 12) return true;
    return false;
  });
  await ready(...KM30);
  let lit = 0;
  const [x, z] = KM30;
  for (let dx = -480; dx <= 480; dx += 120) {
    const key = keyOf(x + dx, z), cell = city.chunkIndex.get(key);
    if (cell && near(M.lampPlan(cell, key, terrain, city), x, z)) lit++;
  }
  assert.equal(lit, 0, 'rule lamps along the open motorway');
  assert.ok(P.motorwayLit(-75653, -10075), 'exit 8 Jirny is a lit interchange');
  assert.ok(!P.motorwayLit(...KM30), 'km 30 is open motorway');
});

/** Every descendant, in traversal order. */
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

for (const [name, at] of [['straight km 30', KM30], ['interchange exit 8', EXIT8], ['Chlumec viaduct', VIADUCT]]) {
  test(`a D11 chunk (${name}) comes back from the worker as built here`, async () => {
    await ready(...at);
    const ms = mats();
    const cx = Math.floor(at[0] / 120), cz = Math.floor(at[1] / 120);
    const sync = M.buildChunkMeshes(city, cx, cz, ms, 'full');
    assert.ok(sync, 'nothing built');
    const world = { city, terrain, canopy: null, ground: null, mats: ms };
    const got = chunkSpec(world, cx, cz, 'full', { terrain: new Map(), canopy: new Map() });
    assert.ok(got, 'chunkSpec refused the cell');
    const out = buildChunkPayload(makeWorkerState(), structuredClone(got.spec, { transfer: got.transfer }));
    assert.ok(!out.empty && out.payload, 'the worker built nothing');
    const dec = { ...ms, codecMats: {} };
    for (const k of Object.keys(out.brands ?? {})) dec.codecMats[k] = ms._wm;
    const back = decode(out.payload, dec);
    const a = nodesOf(sync), b = nodesOf(back);
    assert.equal(b.length, a.length, 'a different set of meshes');
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let worst = 0, checked = 0;
    for (let i = 0; i < a.length; i++) {
      if (!a[i].isMesh || a[i].isInstancedMesh) continue;
      const n = a[i].geometry.attributes.position.count;
      assert.equal(b[i].geometry.attributes.position.count, n, `${a[i].name || a[i].type} vertex count`);
      const pa = a[i].geometry.attributes.position, pb = b[i].geometry.attributes.position;
      for (let v = 0; v < n; v++) {
        p.set(pa.getX(v), pa.getY(v), pa.getZ(v)).applyMatrix4(a[i].matrixWorld);
        q.set(pb.getX(v), pb.getY(v), pb.getZ(v)).applyMatrix4(b[i].matrixWorld);
        worst = Math.max(worst, p.distanceTo(q)); checked++;
      }
    }
    assert.ok(checked > 5000, `only ${checked} vertices`);
    assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm apart`);
  });
}

test('noise walls stand only where the runs say, behind the rail, and each green bridge has one owner', async () => {
  const T = await import('../js/mwtall.js');
  const { d11At, ECODUCTS } = await import('../js/d11.js');
  // pure of the lines: a cell needs only its road list for the slip-road gaps
  const empty = { roads: [] };
  let pieces = 0;
  for (const run of T.NOISE_RUNS) {
    const a = d11At((run.km0 + run.km1) / 2, run.cw);
    const key = keyOf(a.x - a.dz * T.NOISE_OFF, a.z + a.dx * T.NOISE_OFF);
    const P = T.noisePieces(empty, key);
    assert.ok(P.length >= 6, `no wall at ${run.n}`);
    for (let i = 0; i < P.length; i += 6) {
      // (a cell may hold another run's panels too: the nearer carriageway)
      const d = Math.min(toLine('E', P[i], P[i + 1]), toLine('W', P[i], P[i + 1]));
      assert.ok(Math.abs(d - T.NOISE_OFF) < 0.3, `${run.n}: panel ${d.toFixed(2)} m off the line`);
    }
    pieces += P.length / 6;
  }
  assert.ok(pieces > 50);
  // km 30 is open country
  const k30 = d11At(30, 'E');
  assert.equal(T.noisePieces(empty, keyOf(k30.x, k30.z)).length, 0);
  // one chunk draws each green bridge, the one holding its anchor
  for (const e of ECODUCTS) {
    const F = T.ecoductFrame(e);
    assert.equal(F.key, keyOf(F.x, F.z));
    assert.ok(F.hl * 2 >= e.deck - 0.01, `${e.name} drawn shorter than its deck`);
  }
});

test('a D11 viaduct stands its piers side by side under both decks', async () => {
  await ready(...VIADUCT);
  const ways = [];
  for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
    const cell = city.chunkIndex.get((Math.floor(VIADUCT[0] / 120) + dx) + ',' + (Math.floor(VIADUCT[1] / 120) + dz));
    for (const r of cell?.roads ?? []) if (r.br && P.cwOf(r) && r._len > 400 && !ways.includes(r)) ways.push(r);
  }
  assert.equal(ways.length, 2, 'the two 540 m decks');
  const piers = ways.map((f) => {
    const q = f.p, along = [0];
    for (let i = 1; i < q.length; i++) along.push(along[i - 1] + Math.hypot(q[i][0] - q[i - 1][0], q[i][1] - q[i - 1][1]));
    const fr = { q, along };
    const S = P.mwPierStations(f, fr, 0, along[along.length - 1], 22);
    return S.map((s) => { let i = 0; while (i < q.length - 2 && along[i + 1] < s) i++; const t = (s - along[i]) / (along[i + 1] - along[i]);
      return [q[i][0] + (q[i + 1][0] - q[i][0]) * t, q[i][1] + (q[i + 1][1] - q[i][1]) * t]; });
  });
  assert.ok(piers[0].length > 15 && Math.abs(piers[0].length - piers[1].length) <= 1);
  // every pier of one deck has its twin across the median, within 2 m along
  for (const [x, z] of piers[0].slice(1, -1)) {
    const near = Math.min(...piers[1].map(([a, b]) => Math.hypot(a - x, b - z)));
    assert.ok(near < 14.5, `a pier with no twin (${near.toFixed(1)} m)`);
  }
});

test('the exit 8 slip has its own guard rail clear of the other asphalt ribbons', async () => {
  const { nearestOnWay } = await import('../js/corridorgeom.js');
  const { laneLayout } = await import('../js/lanes.js');
  await ready(...EXIT8);
  const cx = Math.floor(EXIT8[0] / 120), cz = Math.floor(EXIT8[1] / 120);
  let checked = 0;
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const key = (cx + dx) + ',' + (cz + dz), cell = city.chunkIndex.get(key);
    if (!cell) continue;
    for (const run of P.barrierPlan(cell, key, terrain, 0, city)) {
      const way = cell.roads.find(r => r._id === run.id);
      if (!way || !P.interchangeSlip(way)) continue;
      assert.equal(run.k, P.K_RAIL);
      for (let i = 0; i < run.v.length; i += P.STRIDE) {
        for (const other of cell.roads) {
          if (!other.d || other === way || (other.l ?? 0) !== (way.l ?? 0)) continue;
          assert.ok(nearestOnWay(other, run.v[i], run.v[i + 1]).d >= (laneLayout(other)?.ribbonHalf ?? (other.w ?? 3) / 2));
        }
        checked++;
      }
    }
  }
  assert.ok(checked >= 10, 'the exit should have at least ten slip guard rail stations');
});

test('a noise wall parallel to a raised motorway stands on the deck at its station', async () => {
  const { roadsideLevel } = await import('../js/mwroadside.js');
  const t = { heightAt: () => 180 };
  const m = { p: [[0, 0], [100, 0]], t: 'motorway', d: 1, _id: 1,
    _prof: { terrain: t, ready: true, ds: 100, n: 2, y: [186, 188] } };
  assert.equal(roadsideLevel([m], 50, 8, 1, 0, t), P.deckY(m, 50, 50, 0, t));
  assert.equal(roadsideLevel([m], 50, 8, 0, 1, t), 180);
});
