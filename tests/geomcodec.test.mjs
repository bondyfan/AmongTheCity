// ---- the chunk has to survive the trip ---------------------------------------
// js/geomcodec.js exists so a built chunk can be MOVED: posted from a mesher
// worker, or written to disk by a baker and read back months later. Both paths
// have the same failure mode, and it is a nasty one — the geometry still draws,
// it is just subtly wrong. A dropped attribute, a material resolved to the
// wrong singleton, a quantisation origin taken from the chunk instead of from
// the geometry (a road is drawn WHOLE from its home chunk and reaches
// kilometres past it), and the city looks almost right: grass with the wrong
// texture, a fence sunk 40 cm into the pavement, a forest culled because its
// bounding sphere stayed template-sized at the origin.
//
// So this test builds a REAL chunk — roads with lamps along them, buildings,
// water, a wood full of scattered trees, fills, street furniture — encodes it,
// decodes it, and compares the two mesh for mesh and vertex for vertex in WORLD
// space, which is the only space that matters. It asserts the documented error
// bound rather than "close enough", and it asserts that a payload whose version
// is not this one is refused instead of drawn.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const codec = await import('../js/geomcodec.js');
const { encode, decode, pack, unpack, materialKey, resolveMaterial,
  rawByteLength, MAX_ERR, MAGIC, VERSION } = codec;

const GROUND = 221;                       // Pardubice is 220 m above the sea

/** A chunk with one of everything the builder can put in a group. */
function denseChunk() {
  // A ground that MOVES: a flat fixture would let a codec that dropped the y
  // axis pass, and it would give every ground triangle the same normal.
  const terrain = {
    res: 20, missed: false, ready: () => true,
    heightAt: (x, z) => GROUND + Math.sin(x * 0.037) * 2.4 + Math.cos(z * 0.021) * 1.7,
  };
  const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
  let id = 0;
  const tag = (f) => { f._id = ++id; f._home = '0,0'; return f; };

  // wide + drivable, or no street lamps are placed (LAMP_MIN_W is 5.4 m)
  const roads = [
    tag({ t: 'primary', w: 12, d: 1, v: 50, p: [[2, 60], [118, 62]] }),
    tag({ t: 'residential', w: 7, d: 1, v: 30, p: [[60, 2], [58, 118]] }),
  ];
  const trees = [];
  for (let i = 0; i < 40; i++)
    trees.push(tag({ p: [[6 + (i % 8) * 13, 20 + Math.floor(i / 8) * 9]] }));
  const cell = {
    buildings: [tag({ o: square(10, 10, 22), h: 12 }), tag({ o: square(80, 80, 26), h: 18 })],
    roads, rails: [], trees,
    // a river across the bottom edge: the water mesh has its own material and
    // its own onBeforeRender, and it is the only mesh that carries neither
    water: [tag({ o: [[0, 100], [120, 104], [120, 118], [0, 114]] })],
    green: [tag({ t: 'wood', o: square(4, 80, 40) })],
    paved: [tag({ t: 'parking', s: 'asphalt', o: square(84, 8, 30) })],
    furniture: [tag({ p: [[30, 70]], k: 'bench' }), tag({ p: [[40, 70]], k: 'lamp' })],
    signs: [], crossings: [], calming: [], barriers: [], power: [],
  };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [] };
  const mats = makeMaterials();
  mats.terrain = terrain;
  // the facade atlas and the brand wordmarks are painted on a <canvas>; there
  // is no document here, and a worker would not have one either
  mats.facades = false;
  mats.ortho = null;
  return { group: buildChunkMeshes(city, 0, 0, mats, 'full'), mats };
}

const FIX = denseChunk();

/** Every descendant, in traversal order, so two groups can be zipped. */
function nodesOf(root) {
  const out = [];
  root.updateMatrixWorld(true);
  const walk = (o) => { for (const c of o.children) { out.push(c); walk(c); } };
  walk(root);
  return out;
}

const _v = new THREE.Vector3(), _m = new THREE.Matrix4();

/** World position of vertex i of a mesh, dequantised by its own matrix. */
function worldVert(mesh, i, out = _v) {
  const p = mesh.geometry.attributes.position;
  out.set(p.getX(i), p.getY(i), p.getZ(i));
  return out.applyMatrix4(mesh.matrixWorld);
}

/** World position of vertex i of instance k. */
function instVert(mesh, k, i, out = new THREE.Vector3()) {
  const p = mesh.geometry.attributes.position;
  mesh.getMatrixAt(k, _m);
  out.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(_m);
  return out.applyMatrix4(mesh.matrixWorld);
}

test('a real chunk comes back mesh for mesh, with the same materials', () => {
  const { group, mats } = FIX;
  const back = decode(encode(group, mats), mats);

  assert.equal(back.name, group.name);
  assert.deepEqual(back.position.toArray(), group.position.toArray());
  assert.equal(back.userData.guessedGround, group.userData.guessedGround);
  assert.deepEqual(back.userData.missTiles, group.userData.missTiles);

  const a = nodesOf(group), b = nodesOf(back);
  assert.ok(a.length >= 8, `the fixture only built ${a.length} nodes — it missed a path`);
  assert.equal(b.length, a.length, 'the decoded group has a different shape');
  let instanced = 0, groups = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i], at = `node ${i} (${x.name || x.type})`;
    assert.equal(!!y.isMesh, !!x.isMesh, at);
    assert.equal(!!y.isInstancedMesh, !!x.isInstancedMesh, at);
    assert.equal(y.name, x.name, at);
    if (x.isInstancedMesh) instanced++;
    if (!x.isMesh) { groups++; continue; }
    // the SAME material object, not a copy: a duplicate would be a second
    // shader program and a second texture-array binding per chunk
    assert.strictEqual(y.material, x.material, `${at} lost its material identity`);
    assert.equal(y.castShadow, x.castShadow, at);
    assert.equal(y.receiveShadow, x.receiveShadow, at);
    assert.equal(y.geometry.attributes.position.count,
      x.geometry.attributes.position.count, `${at} changed vertex count`);
    assert.deepEqual(Object.keys(y.geometry.attributes).sort(),
      Object.keys(x.geometry.attributes).sort(), `${at} lost an attribute`);
    assert.equal(!!y.geometry.index, !!x.geometry.index, `${at} lost its index`);
    if (x.geometry.index)
      assert.deepEqual([...y.geometry.index.array], [...x.geometry.index.array], at);
  }
  assert.equal(groups, 1, 'the nested buildings group did not survive as a group');
  assert.equal(instanced, 4, `${instanced} instanced meshes — lamps and trees are four`);
});

test('every vertex lands within the documented 3 mm', () => {
  const { group, mats } = FIX;
  const payload = encode(group, mats);
  // the bound is only interesting if the codec actually quantised something
  const kinds = payload.meta.nodes.filter((n) => n.geo)
    .map((n) => n.geo.attrs.position.t);
  assert.ok(kinds.includes('i16n'), `no geometry was quantised at all (${kinds})`);
  const back = decode(payload, mats);

  const a = nodesOf(group), b = nodesOf(back);
  let worst = 0, worstAt = '', worstN = 0, worstNL = 0, worstC = 0, worstUV = 0, checked = 0;
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (!x.isMesh) continue;
    const px = x.geometry.attributes, py = y.geometry.attributes;
    const n = px.position.count;
    if (x.isInstancedMesh) {
      // an instanced template is quantised about its own origin and the
      // dequant is folded into the instance matrices — the invariant is where
      // the drawn vertices END UP, not what the matrices say
      assert.equal(y.count, x.count, 'instance count changed');
      for (let k = 0; k < x.count; k++) for (let v = 0; v < n; v++) {
        const d = instVert(x, k, v, p).distanceTo(instVert(y, k, v, q));
        if (d > worst) { worst = d; worstAt = `instance ${k} of ${x.name || 'batch'}`; }
        checked++;
      }
    } else {
      for (let v = 0; v < n; v++) {
        const d = worldVert(x, v, p).distanceTo(worldVert(y, v, q));
        if (d > worst) { worst = d; worstAt = `vertex ${v} of node ${i}`; }
        checked++;
      }
    }
    for (let v = 0; v < n; v++) {
      if (px.normal) {
        // DIRECTION, not the vector: the three components round independently
        // so an int8 normal is up to 0.34 % off unit length, and the fragment
        // shader normalizes the interpolated normal anyway.
        const ax = px.normal.getX(v), ay = px.normal.getY(v), az = px.normal.getZ(v);
        const bx = py.normal.getX(v), by = py.normal.getY(v), bz = py.normal.getZ(v);
        const la = Math.hypot(ax, ay, az) || 1, lb = Math.hypot(bx, by, bz) || 1;
        worstN = Math.max(worstN, 1 - (ax * bx + ay * by + az * bz) / (la * lb));
        worstNL = Math.max(worstNL, Math.abs(lb - 1));
      }
      if (px.color) for (const c of ['getX', 'getY', 'getZ'])
        worstC = Math.max(worstC, Math.abs(px.color[c](v) - py.color[c](v)));
      if (px.uv) worstUV = Math.max(worstUV,
        Math.abs(px.uv.getX(v) - py.uv.getX(v)), Math.abs(px.uv.getY(v) - py.uv.getY(v)));
      // the surface class indexes a texture array: one off and the car park is
      // drawn with the grass texture, which is a bug this repo has shipped
      if (px.surf) assert.equal(py.surf.getX(v), px.surf.getX(v),
        `surface class changed on vertex ${v} of node ${i}`);
    }
  }
  assert.ok(checked > 15000, `only ${checked} vertices compared — the fixture is too thin`);
  assert.ok(worst < MAX_ERR,
    `${(worst * 1000).toFixed(2)} mm of positional error at ${worstAt}`);
  // int8 normals: 1/127 a component, so a third of a degree at worst
  assert.ok(Math.acos(1 - worstN) < 0.5 * Math.PI / 180,
    `normals turned by ${(Math.acos(1 - worstN) * 180 / Math.PI).toFixed(2)}°`);
  assert.ok(worstNL < 0.005, `an int8 normal came back ${worstNL.toFixed(4)} off unit length`);
  // uint8 colour and uint16 uv are exactly one step of their own quantisation
  assert.ok(worstC <= 1 / 255 / 2 + 1e-6, `colour drifted by ${worstC}`);
  assert.ok(worstUV <= 1 / 65535 / 2 + 1e-6, `uv drifted by ${worstUV}`);
});

test('the bounding spheres still contain the geometry they were quantised with', () => {
  // The dequant rides on the mesh matrix, so the geometry's sphere is written
  // in the [-1,1] space the int16 positions live in. three culls with
  // sphere.applyMatrix4(matrixWorld) — a sphere that came out too small is a
  // chunk that vanishes when you look at it slightly off-centre, which is the
  // hardest kind of streaming bug to reproduce on purpose.
  const { group, mats } = FIX;
  const back = decode(encode(group, mats), mats);
  const nodes = nodesOf(back);
  let spheres = 0;
  const s = new THREE.Sphere(), p = new THREE.Vector3();
  for (const o of nodes) {
    if (!o.isMesh || o.isInstancedMesh) continue;
    assert.ok(o.geometry.boundingSphere, 'a decoded geometry arrived unbounded');
    spheres++;
    s.copy(o.geometry.boundingSphere).applyMatrix4(o.matrixWorld);
    const n = o.geometry.attributes.position.count;
    for (let i = 0; i < n; i++) {
      const d = worldVert(o, i, p).distanceTo(s.center);
      assert.ok(d <= s.radius + 1e-3,
        `vertex ${i} sits ${(d - s.radius).toFixed(3)} m outside its own bounding sphere`);
    }
  }
  assert.ok(spheres >= 3, `only ${spheres} plain meshes checked`);
});

test('the instanced batches keep their colours, count and bounding sphere', () => {
  const { group, mats } = FIX;
  const back = decode(encode(group, mats), mats);
  const a = nodesOf(group).filter((o) => o.isInstancedMesh);
  const b = nodesOf(back).filter((o) => o.isInstancedMesh);
  assert.equal(b.length, a.length);
  let withColor = 0;
  for (let i = 0; i < a.length; i++) {
    assert.equal(b[i].count, a[i].count);
    assert.ok(a[i].boundingSphere, 'the builder left an instanced batch unbounded');
    // world-space instances against a template-sized sphere is a forest that
    // vanishes when you look at it from the side
    assert.ok(b[i].boundingSphere, 'the decoded batch has no bounding sphere');
    assert.ok(b[i].boundingSphere.center.distanceTo(a[i].boundingSphere.center) < 1e-6);
    assert.ok(Math.abs(b[i].boundingSphere.radius - a[i].boundingSphere.radius) < 1e-6);
    assert.equal(!!b[i].instanceColor, !!a[i].instanceColor);
    if (!a[i].instanceColor) continue;
    withColor++;
    for (let k = 0; k < a[i].count; k++) for (const c of ['getX', 'getY', 'getZ'])
      assert.ok(Math.abs(a[i].instanceColor[c](k) - b[i].instanceColor[c](k)) <= 1 / 255,
        'a tree crown changed colour');
  }
  assert.equal(withColor, 1, 'the crowns are the batch that carries instanceColor');
});

test('the payload really is transferable — it survives a postMessage', () => {
  // This is the whole point of the format: structuredClone with a transfer list
  // MOVES the bytes (the source ArrayBuffer is detached afterwards) instead of
  // copying several megabytes on the main thread.
  const { group, mats } = FIX;
  const payload = encode(group, mats);
  assert.ok(payload.buffers.every((b) => b instanceof ArrayBuffer),
    'a buffer is a typed-array view — postMessage would clone it, not transfer it');
  const bytes = payload.buffers[0].byteLength;
  const posted = structuredClone(payload, { transfer: payload.buffers });
  assert.equal(payload.buffers[0].byteLength, 0, 'the source buffer was copied, not moved');
  assert.equal(posted.buffers[0].byteLength, bytes);
  const back = decode(posted, mats);
  assert.equal(nodesOf(back).length, nodesOf(group).length);
});

test('an unknown version is refused, loudly', () => {
  const { group, mats } = FIX;
  const good = encode(group, mats);
  const bad = { meta: { ...good.meta, version: VERSION + 1 }, buffers: good.buffers };
  assert.throws(() => decode(bad, mats), /version/i,
    'a payload from another format version was decoded anyway');
  const alien = { meta: { ...good.meta, magic: 0xdeadbeef }, buffers: good.buffers };
  assert.throws(() => decode(alien, mats), /magic/i);
  assert.throws(() => decode({ meta: good.meta }, mats), /encoded chunk/i);
  // …and the same refusal on the baker's file, before a byte of it is believed
  const file = new Uint8Array(pack(good));
  new DataView(file.buffer).setUint32(4, VERSION + 7, true);
  assert.throws(() => unpack(file), /version/i);
});

test('pack/unpack is a byte-for-byte round trip through a file', () => {
  const { group, mats } = FIX;
  const payload = encode(group, mats);
  const file = pack(payload);
  assert.equal(new DataView(file).getUint32(0), MAGIC, 'the file does not start with ATCG');
  const round = unpack(new Uint8Array(file));
  assert.deepStrictEqual(round.meta, JSON.parse(JSON.stringify(payload.meta)));
  assert.equal(round.buffers.length, 1);
  assert.deepEqual(new Uint8Array(round.buffers[0]), new Uint8Array(payload.buffers[0]));
  // and it decodes to the same thing the in-memory payload does
  const back = decode(round, mats);
  assert.equal(nodesOf(back).length, nodesOf(group).length);
});

test('the meta is plain data — it crosses a worker boundary as JSON', () => {
  const { group, mats } = FIX;
  const meta = encode(group, mats).meta;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(meta)), meta,
    'something in the meta does not survive JSON — a Map, a Vector3 or an undefined');
});

test('every material a chunk can carry has a key, and it resolves back', () => {
  // The enumeration IS the contract: a material the codec cannot name is a
  // mesh it cannot encode, and we would rather find that here than by a chunk
  // that silently fails to arrive.
  const mats = makeMaterials();
  for (const k of Object.keys(mats)) {
    if (!mats[k]?.isMaterial) continue;
    assert.equal(materialKey(mats[k], mats), k, `makeMaterials().${k} has no codec key`);
    assert.strictEqual(resolveMaterial(k, mats), mats[k]);
  }
  // the facade wall material is built lazily by the first chunk that draws
  // buildings with facades, and lives on mats._facadeMat rather than in the table
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  assert.equal(materialKey(mats._facadeMat, mats), 'facade');
  assert.strictEqual(resolveMaterial('facade', mats), mats._facadeMat);
  assert.throws(() => resolveMaterial('facade', makeMaterials()), /_facadeMat/,
    'a decode with no facade material must say which one is missing');
  assert.throws(() => resolveMaterial('nonesuch', mats), /nonesuch/);
});

test('a material the codec cannot name stops the encode instead of guessing', () => {
  // The aerial photograph and the brand wordmarks are the real cases: their
  // materials are per-supertile and per-chain, painted on a canvas on the main
  // thread. Silently substituting mats.flat would draw a grey square where the
  // photo should be, and nobody would know which chunk did it.
  const mats = makeMaterials();
  const group = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 0, 1], 3));
  const stranger = new THREE.MeshBasicMaterial({ color: 0x123456 });
  group.add(new THREE.Mesh(geo, stranger));
  assert.throws(() => encode(group, mats), /cannot name/);
  // …and the documented way in: register it under a key both sides agree on
  mats.codecMats = { 'brand:Lidl': stranger };
  const back = decode(encode(group, mats), mats);
  assert.strictEqual(back.children[0].material, stranger);
});

test('the bound holds at the edge of the budget, not just on easy chunks', () => {
  // The easy chunk above spends a fifth of the budget, so it would pass a codec
  // whose threshold was wrong by a factor of two — and the first version's was:
  // it spent the 3 mm PER AXIS, and three axes rounding independently moved a
  // vertex of a real 391 m Pardubice mesh 5.01 mm. This fixture sits just under
  // the ceiling on all three axes at once, which is where that shows.
  const mats = makeMaterials();
  const near = (half) => {
    const group = new THREE.Group();
    const pos = [];
    // a scatter of odd offsets, so the rounding lands everywhere in the step
    for (let i = 0; i < 4000; i++) {
      const t = i * 0.7548, u = i * 1.3417, w = i * 0.4271;
      pos.push(half * Math.sin(t) * 0.999 + half * 1e-4,
        GROUND + half * Math.sin(u) * 0.999,
        half * Math.sin(w) * 0.999);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    group.add(new THREE.Mesh(geo, mats.flat));
    return group;
  };
  const group = near(113);
  const payload = encode(group, mats);
  assert.equal(payload.meta.nodes[0].geo.attrs.position.t, 'i16n',
    'a 226 m mesh should still be worth quantising');
  const back = decode(payload, mats);
  group.updateMatrixWorld(true); back.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  let worst = 0;
  for (let i = 0; i < 4000; i++)
    worst = Math.max(worst, worldVert(group.children[0], i, p)
      .distanceTo(worldVert(back.children[0], i, q)));
  assert.ok(worst < MAX_ERR, `${(worst * 1000).toFixed(2)} mm at the threshold`);
  assert.ok(worst > MAX_ERR / 3,
    `only ${(worst * 1000).toFixed(2)} mm — this fixture is not near the edge at all`);
  // …and one step further out is refused rather than quantised badly
  assert.equal(encode(near(140), mats).meta.nodes[0].geo.attrs.position.t, 'f32');
});

test('a geometry too big for int16 keeps float32 rather than break the bound', () => {
  // A 3 km rural road is ONE mesh — features draw whole from their home chunk —
  // and 3 km over 65536 steps is 46 mm, fifteen times the bound this codec
  // promises. So it is not quantised, and the meta says so.
  const mats = makeMaterials();
  const group = new THREE.Group();
  const pos = [];
  for (let i = 0; i < 300; i++) pos.push(i * 10, GROUND + (i % 7) * 0.1, 3000 - i * 10);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  group.add(new THREE.Mesh(geo, mats.flat));
  const payload = encode(group, mats);
  assert.equal(payload.meta.nodes[0].geo.attrs.position.t, 'f32');
  const back = decode(payload, mats);
  back.updateMatrixWorld(true);
  const p = new THREE.Vector3(), q = new THREE.Vector3();
  const src = group.children[0], out = back.children[0];
  group.updateMatrixWorld(true);
  for (let i = 0; i < 300; i++)
    assert.equal(worldVert(src, i, p).distanceTo(worldVert(out, i, q)), 0,
      'the float32 fallback is supposed to be exact');
});

test('the encoded chunk is worth the trouble — under half the raw bytes', () => {
  const { group, mats } = FIX;
  const before = rawByteLength(group);
  const after = encode(group, mats).buffers[0].byteLength;
  assert.ok(before > 500000, `the fixture is only ${before} B — too small to measure`);
  assert.ok(after * 2 < before,
    `${after} B against ${before} B is not a compression worth a codec`);
});
