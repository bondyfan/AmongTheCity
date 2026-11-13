// ---- four defects the code review confirmed on buildings and tree pits -------
// Each test pins the cause, not the symptom:
//   - the roof shader laid its tiles from the RAW position attribute, which a
//     worker-built chunk ships as int16 normalised to [-1, 1];
//   - the plain wall band over the storey grid walked its pinned uv into the
//     roof tile column;
//   - near-shell balcony boxes were hung on the top storey, whose cell has no
//     loggia paint;
//   - tree pits were cut into rail yards and gravel.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { buildChunkMeshes, buildBuildingsMesh, makeMaterials } = await import('../js/meshes.js');
const { JUNCTIONS, CLUSTERS, indexJunctions, setStreetCity } = await import('../js/geo.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { buildFacadeMaterial } = await import('../js/facadeatlas.js');
const T = await import('../js/typology.js');
const { buildingPlan, classify } = await import('../js/interiors.js');
const { shellPieces } = await import('../js/pieces.js');
const { pavingUnder } = await import('../js/treepits.js');
const { LAYER_Y } = await import('../js/config.js');

// The wall material paints its atlas on a <canvas>, which node has not got. A
// canvas with no 2D context is a path the atlas already handles (plain
// plaster), and the shader, which is what is under test, is the same either way.
const hadDocument = 'document' in globalThis;
if (!hadDocument) globalThis.document = { createElement: () => ({ getContext: () => null }) };
const FACADE_MAT = buildFacadeMaterial();
if (!hadDocument) delete globalThis.document;

const GROUND = 221;
const rect = (cx, cz, w, d, deg) => {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
};

function worldWith(buildings) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 100;
  for (const b of buildings) { b._id ??= ++id; b._home = '0,0'; }
  const cell = { buildings, roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  indexJunctions([]); setStreetCity(city);
  const terrain = new Terrain(4800, 20);
  const g = new Int16Array(terrain.n * terrain.n).fill(GROUND * 10);
  terrain.grids.set('0,0', g); terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = FACADE_MAT;
  const wordmark = new THREE.MeshBasicMaterial(); mats.brandMat = () => wordmark;
  return { city, terrain, canopy: null, ground: null, mats, wordmark };
}

// ---- finding 4: roof tiles in metres, whichever thread built the chunk --------

// What the facade shader does with one roof vertex, transcribed: the vertex
// stage's two varyings, then the fragment's tile coordinate in repeats.
// `vertex` picks the vertex stage: the shipped one, the old one (raw
// attribute), or world space without the normal snap.
const _p = new THREE.Vector3(), _n = new THREE.Vector3(), _m3 = new THREE.Matrix3();
function roofTile(mesh, i, vertex, metres) {
  const pos = mesh.geometry.attributes.position, nor = mesh.geometry.attributes.normal;
  _p.fromBufferAttribute(pos, i); _n.fromBufferAttribute(nor, i);
  if (vertex !== 'raw') {
    _p.applyMatrix4(mesh.matrixWorld);
    if (vertex === 'shipped') {
      _n.set(Math.floor(_n.x * 127 + 0.5), Math.floor(_n.y * 127 + 0.5), Math.floor(_n.z * 127 + 0.5))
        .divideScalar(127);
    }
    _n.applyMatrix3(_m3.setFromMatrix4(mesh.matrixWorld));
  }
  _n.normalize();
  const sl = Math.sqrt(Math.max(1 - _n.y * _n.y, 0));
  const hx = sl > 0.17 ? -_n.z / sl : 1, hz = sl > 0.17 ? _n.x / sl : 0;
  const ra = _p.x * hx + _p.z * hz;
  const rb = sl > 0.17 ? _p.y / sl : _p.x * -hz + _p.z * hx;
  return [ra / metres, rb / metres];
}

// (Round 5: a roof's uv names its roofing by the column AND by one of ROOF_ROWS
// bands of v, typology.roofIndex, because the roofs now come out of their own
// atlas of ten roofings. This is the shader's decode, transcribed.)
const roofMetres = [];
for (const k of Object.keys(T.ROOF_STYLES)) roofMetres[T.roofIndex(k)] = T.ROOF_STYLES[k].m;
/** The vertices the shader treats as roof, with the metres of their style. */
function roofVerts(mesh) {
  const uv = mesh.geometry.attributes.uv, out = [];
  for (let i = 0; i < uv.count; i++) {
    const col = Math.floor(uv.getX(i) * T.ATLAS_N);
    if (uv.getY(i) > 1 - 1 / T.ATLAS_M && col >= 1 && col <= 5) {
      const row = Math.floor((1 - uv.getY(i)) * T.ATLAS_M * T.ROOF_ROWS);
      out.push([i, roofMetres[col - 1 + 5 * row]]);
    }
  }
  return out;
}

test('the roof shader lays its tiles from world space, with the normal on the codec grid', () => {
  const mat = FACADE_MAT;
  const sh = { uniforms: {}, vertexShader: THREE.ShaderLib.lambert.vertexShader,
    fragmentShader: THREE.ShaderLib.lambert.fragmentShader };
  mat.onBeforeCompile(sh);
  const vs = sh.vertexShader.replace(/\s+/g, ' ');
  assert.ok(vs.includes('vRoofP = (modelMatrix * vec4(position, 1.0)).xyz;'),
    'the roof coordinate is the world position, not the raw (possibly normalised) attribute');
  assert.ok(vs.includes('vRoofN = mat3(modelMatrix) * (floor(normal * 127.0 + 0.5) / 127.0);'),
    'the roof normal is snapped to the int8 grid the codec stores');
  assert.ok(!/vRoofP = position;/.test(vs));
  // a new program, or a cached v2 program would keep drawing the old roofs
  assert.notEqual(mat.customProgramCacheKey(), 'atc-facade-v2');
  // wave 3's night window gain has to survive this edit
  assert.ok(sh.fragmentShader.includes('uNight.y'));
});

test('a roof tiles the same on a worker-built chunk and on a main-thread one', (t) => {
  const world = worldWith([
    { o: rect(40, 60, 22, 22, 0), h: 12, t: 'residential' },           // a flat roof
    { o: rect(84, 30, 14, 9, 23), h: 8, lv: 2, t: 'house', r: 'gabled' },   // pitched, off-axis
    { o: rect(70, 88, 16, 10, 61), h: 9, lv: 2, t: 'house', r: 'hipped' },
  ]);
  const sync = buildChunkMeshes(world.city, 0, 0, world.mats, 'full');
  const got = chunkSpec(world, 0, 0, 'full', { terrain: new Map(), canopy: new Map() });
  const out = buildChunkPayload(makeWorkerState(), structuredClone(got.spec, { transfer: got.transfer }));
  const decMats = { ...world.mats, codecMats: {} };
  for (const k of Object.keys(out.brands || {})) decMats.codecMats[k] = world.wordmark;
  const back = decode(out.payload, decMats);

  // both chunks stand somewhere real: three and a bit kilometres from the
  // origin, which is the lever a wrong course direction is multiplied by
  const far = new THREE.Group();
  far.position.set(3360, 0, -2640);
  far.add(sync, back);
  far.updateMatrixWorld(true);

  const facade = (root) => {
    let m = null;
    root.traverse((o) => { if (o.isMesh && o.material === world.mats._facadeMat) m = o; });
    return m;
  };
  const a = facade(sync), b = facade(back);
  assert.ok(a && b, 'both builds carry a facade mesh');
  assert.ok(b.geometry.attributes.position.normalized && b.scale.x > 10 && b.position.lengthSq() > 0,
    'the decoded mesh really is int16 normalised, scaled and off the origin (or this proves nothing)');
  // Which vertices are roof is read off the float build alone: the wire's
  // uint16 uv puts a cell EDGE a hair either side of its column, and a vertex
  // on an edge is a wall's, not a roof's. The two builds emit the same vertices
  // in the same order, which the position check below holds them to.
  const ra = roofVerts(a), rb = ra;
  assert.ok(ra.length >= 30, `the fixture has roofs (${ra.length} vertices)`);
  assert.equal(a.geometry.attributes.position.count, b.geometry.attributes.position.count);
  for (const [i] of ra) {
    const pa = new THREE.Vector3().fromBufferAttribute(a.geometry.attributes.position, i).applyMatrix4(a.matrixWorld);
    const pb = new THREE.Vector3().fromBufferAttribute(b.geometry.attributes.position, i).applyMatrix4(b.matrixWorld);
    assert.ok(pa.distanceTo(pb) <= MAX_ERR, `vertex ${i} is the same vertex in both builds`);
  }

  const worst = (vertex) => {
    let w = 0;
    for (let k = 0; k < ra.length; k++) {
      const m = ra[k][1];
      const [u0, v0] = roofTile(a, ra[k][0], vertex, m), [u1, v1] = roofTile(b, rb[k][0], vertex, m);
      w = Math.max(w, Math.abs(u0 - u1), Math.abs(v0 - v1));
    }
    return w;
  };
  // SCALE and PHASE: under 2 cm of a 4 m repeat anywhere on any roof, which is
  // the codec's 3 mm of position and nothing else
  const shipped = worst('shipped');
  assert.ok(shipped < 0.005, `roofs disagree by ${shipped.toFixed(4)} repeats between the two encodings`);
  // the defect: the raw attribute is metres on one side and [-1, 1] on the other
  assert.ok(worst('raw') > 5, 'the raw attribute cannot agree (this is what the shader used to read)');
  // and why the normal is snapped: world space alone gets the scale right but
  // lets the codec's 0.3 degrees slide a pitched roof's courses by metres
  const unsnapped = worst('world');
  t.diagnostic(`worst disagreement in repeats: shipped ${shipped.toFixed(5)}, world space unsnapped `
    + `${unsnapped.toFixed(3)}, raw attribute ${worst('raw').toFixed(1)}`);
  assert.ok(unsnapped > 20 * shipped, `unsnapped ${unsnapped.toFixed(3)} against ${shipped.toFixed(4)} repeats`);

  // and the size is right in absolute terms: across one roof plane the tile
  // coordinate advances one repeat per `m` metres of world distance
  let seen = 0;
  for (let k = 0; k + 2 < rb.length; k += 3) {
    const [i0, m] = rb[k], i1 = rb[k + 1][0];
    const p0 = new THREE.Vector3().fromBufferAttribute(b.geometry.attributes.position, i0).applyMatrix4(b.matrixWorld);
    const p1 = new THREE.Vector3().fromBufferAttribute(b.geometry.attributes.position, i1).applyMatrix4(b.matrixWorld);
    const n0 = new THREE.Vector3().fromBufferAttribute(b.geometry.attributes.normal, i0);
    const n1 = new THREE.Vector3().fromBufferAttribute(b.geometry.attributes.normal, i1);
    if (n0.distanceTo(n1) > 1e-6 || p0.distanceTo(p1) < 2) continue;   // one flat face, a real edge
    const t0 = roofTile(b, i0, 'shipped', m).slice(), t1 = roofTile(b, i1, 'shipped', m);
    const repeats = Math.hypot(t1[0] - t0[0], t1[1] - t0[1]);
    assert.ok(Math.abs(repeats * m - p0.distanceTo(p1)) < 0.05,
      `${p0.distanceTo(p1).toFixed(2)} m of roof edge spans ${(repeats * m).toFixed(2)} m of pattern`);
    seen++;
  }
  assert.ok(seen >= 6, `measured ${seen} roof edges`);
});

// ---- finding 5: the plain band stays on its pin texel -------------------------

test('the plain wall band over the storey grid never leaves the plaster pin texel', () => {
  // one storey under 7.4 m: 5.6 m of grid, then 1.3 m of plain wall to the eave
  const b = { _id: 9001, _home: '0,0', o: rect(30, 30, 24.3, 11, 0), h: 7.4, lv: 1, t: 'house' };
  const mat = new THREE.MeshBasicMaterial();
  const city = { chunkIndex: new Map([['0,0', { buildings: [b], roads: [] }]]) };
  const mats = { facades: true, _facadeMat: mat, doorTrim: mat, doorSign: mat, building: mat,
    hidden: null, terrain: { ready: () => true, heightAt: () => GROUND }, brandMat: () => mat };
  const g = buildBuildingsMesh(city, 0, 0, mats);
  const geo = g.children[0].geometry, N = geo.attributes.normal, U = geo.attributes.uv;
  let plain = 0, widest = 0;
  for (let k = 0; k < U.count; k += 6) {            // a wall quad is six vertices
    if (Math.abs(N.getY(k)) > 0.01) continue;
    let u0 = Infinity, u1 = -Infinity, pinned = true;
    for (let j = 0; j < 6; j++) {
      u0 = Math.min(u0, U.getX(k + j)); u1 = Math.max(u1, U.getX(k + j));
      if (Math.abs(U.getY(k + j) - T.PIN_V) > 1e-9) pinned = false;
    }
    if (!pinned) { widest = Math.max(widest, u1 - u0); continue; }
    plain++;
    assert.ok(Math.abs(u0 - T.PIN_U) < 1e-9 && Math.abs(u1 - T.PIN_U) < 1e-9,
      `a plain quad spans u ${u0.toFixed(4)} to ${u1.toFixed(4)}: past 0.125 it samples the roof tile cell`);
  }
  assert.ok(plain >= 8, `the fixture has a plain band (${plain} quads)`);
  // the cells themselves still step a bay at a time: a full piece is one cell wide
  assert.ok(Math.abs(widest - 1 / T.ATLAS_N) < 1e-9, `a four-bay piece spans ${widest} of u`);
});

// ---- finding 6: no balcony where no loggia is painted -------------------------

test('a panel block hangs balconies only on storeys painted with loggias', () => {
  const b = { _id: 4711, o: rect(30, 20, 43.2, 12, 0), h: 8 * 2.9, lv: 8, t: 'apartments' };
  const use = classify(b);
  assert.equal(T.typologyOf(b, use), 'panel');
  const plan = buildingPlan(b, null);
  assert.ok(plan.rows.balc && plan.rows.top && plan.rows.top !== plan.rows.mid,
    'the fixture is a block whose top storey has a cell of its own');
  const per = new Array(plan.storeys).fill(0);
  for (const p of shellPieces(plan)) {
    if (p.balcony && p.kind === 'rail') per[Math.floor((p.y - plan.y0) / plan.sH)]++;
  }
  assert.equal(per[0], 0, 'none on the ground floor');
  assert.equal(per[plan.storeys - 1], 0, 'none on the top storey: its cell paints plain silled windows');
  for (let s = 1; s < plan.storeys - 1; s++) {
    assert.ok(per[s] > 0, `storey ${s} keeps its balconies`);
    assert.equal(T.rowFor(plan.rows, s, plan.storeys, 0), plan.rows.mid);
    assert.equal(per[s], per[1], 'the same bays on every loggia storey');
  }
});

// ---- finding 13: a pit is let into sealed ground only -------------------------

test('a tree in a rail yard or on gravel gets no pit, one on sealed paving does', () => {
  const terrain = { heightAt: () => 220 };
  const sq = [[0, 0], [40, 0], [40, 40], [0, 40]];
  const at = (paved, plates) => pavingUnder({ roads: [], paved }, 20, 20, terrain, plates);
  assert.equal(at([{ t: 'yard', o: sq }]), null, 'an untagged yard is drawn as gravel');
  assert.equal(at([{ t: 'yard', s: 'gravel', o: sq }]), null);
  assert.equal(at([{ t: 'parking', s: 'gravel', o: sq }]), null, 'a gravel car park is not sealed either');
  assert.equal(at([{ t: 'pedestrian', s: 'dirt', o: sq }]), null);
  assert.equal(at([{ t: 'plaza', s: 'grass', o: sq }]), null);
  const pit = (paved, why) => {
    const a = at(paved);
    assert.ok(a && Math.abs(a.y - (220 + LAYER_Y.paved)) < 1e-9 && a.lift === LAYER_Y.paved, why);
  };
  pit([{ t: 'yard', s: 'asphalt', o: sq }], 'a yard a surveyor tagged as asphalt is drawn as asphalt');
  pit([{ t: 'plaza', o: sq }], 'a square');
  pit([{ t: 'parking', o: sq }], 'an untagged car park is concrete');
  pit([{ t: 'platform', s: 'paving', o: sq }], 'a platform');
  // a platform lying inside the railway landuse: the yard is skipped, not final
  pit([{ t: 'yard', o: [[-50, -50], [90, -50], [90, 90], [-50, 90]] }, { t: 'platform', o: sq }],
    'a platform inside a rail yard still counts, whichever comes first');
  pit([{ t: 'platform', o: sq }, { t: 'yard', o: [[-50, -50], [90, -50], [90, 90], [-50, 90]] }],
    'a platform inside a rail yard still counts, whichever comes first');
  // A sealed plate UNDER a yard does not bring the pit back: without the aerial
  // photo the gravel is drawn over the plate, and a pit left on the plate came
  // up through it on a third of the real trees it was measured on.
  const plate = [{ x0: 10, z0: 10, x1: 30, z1: 30 }];
  assert.equal(at([{ t: 'yard', o: sq }], plate), null, 'a plate under yard gravel');
  assert.equal(at([{ t: 'parking', s: 'gravel', o: sq }], plate), null, 'a plate under a gravel car park');
  // ...but where the yard has a hole the plate is the ground, and so it is
  // with no polygon over it at all
  const inHole = at([{ t: 'yard', o: sq, i: [[[15, 15], [25, 15], [25, 25], [15, 25]]] }], plate);
  assert.ok(inHole && inHole.lift === LAYER_Y.inferred, 'a plate showing through a hole in the yard');
  const bare = at([], plate);
  assert.ok(bare && bare.lift === LAYER_Y.inferred, 'a plate with nothing mapped over it');
});
