// ---- roofs and walls from the tile data (round 5) -----------------------------
// The tiles now say what a roof is: its tagged colour (rc), the colour read off
// the aerial photograph (rp), its material (rm), its height, storeys and ridge
// direction (rh, rl, rd, ro), and what the wall is made of (bm). These tests
// hold the three promises the consumer makes:
//   - the preference order and the photograph-to-material conversion;
//   - one answer for the far mesh, the near shell and the roof mesh between;
//   - one answer on the main thread and in the mesh worker.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const D = await import('../js/roofdata.js');
const T = await import('../js/typology.js');
const { linRGB } = await import('../js/roofs.js');
const { buildChunkMeshes, buildBuildingsMesh, buildingWallHex, roofGeometry, makeMaterials }
  = await import('../js/meshes.js');
const { JUNCTIONS, CLUSTERS, indexJunctions, setStreetCity } = await import('../js/geo.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { buildFacadeMaterial } = await import('../js/facadeatlas.js');
const { buildingPlan, classify } = await import('../js/interiors.js');
const { ROOF_MATERIALS, WALL_MATERIALS } = await import('../js/tiledata.js');

// node has no <canvas>: both atlases fall back to a plain texel, and the
// geometry, which is what is under test, is the same either way
const hadDocument = 'document' in globalThis;
if (!hadDocument) globalThis.document = { createElement: () => ({ getContext: () => null }) };
const FACADE_MAT = buildFacadeMaterial();
if (!hadDocument) delete globalThis.document;

const GROUND = 221;
const rect = (cx, cz, w, d, deg = 0) => {
  const c = Math.cos(deg * Math.PI / 180), s = Math.sin(deg * Math.PI / 180);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([x, z]) => [cx + x * c - z * s, cz + x * s + z * c]);
};
const isRoofUv = (u, v) => v > 1 - 1 / T.ATLAS_M && Math.floor(u * T.ATLAS_N) >= 1 && Math.floor(u * T.ATLAS_N) <= 5;
const typOf = (b) => T.typologyOf(b, classify(b));
const roofOf = (b) => T.roofOf(b, typOf(b));
const warm = (hex) => { const c = D.toneOf(hex).cls; return c === 'red' || c === 'brown'; };

// ---- the photograph ----------------------------------------------------------

test('a photographed roof is turned back into the colour of its material', () => {
  // old-town clay as the photograph has it, and as the kiln made it
  const clay = D.photoToMaterial(0xb08778), before = D.toneOf(0xb08778), after = D.toneOf(clay);
  assert.equal(after.cls, 'red', 'photographed clay comes back red');
  assert.ok(after.c > before.c * 1.3, `the haze took the chroma: ${before.c} to ${after.c}`);
  assert.ok(Math.abs(after.hue - before.hue) < 4, `the hue is kept (${before.hue.toFixed(1)} to ${after.hue.toFixed(1)})`);
  assert.ok(after.y < before.y, 'a sunlit roof is photographed brighter than it is');
  // a grey roof stays grey: its faint cast is the haze's colour, not its own
  for (const g of [0x868c8a, 0xcfd8da, 0x545d5b, 0xbbb7b3]) {
    const m = D.toneOf(D.photoToMaterial(g));
    assert.ok(m.c <= D.toneOf(g).c + 1, `grey #${g.toString(16)} gained chroma`);
    assert.ok(['dark', 'grey', 'pale'].includes(m.cls), `grey #${g.toString(16)} came back ${m.cls}`);
  }
  // the haze is blue, so a cool roof is never boosted
  assert.ok(D.toneOf(D.photoToMaterial(0x7d8f96)).c <= D.toneOf(0x7d8f96).c);
  // and the order of lightness survives: pale stays paler than dark
  assert.ok(D.toneOf(D.photoToMaterial(0xd5ddda)).y > D.toneOf(D.photoToMaterial(0x656665)).y + 60);
});

test('the tag comes first, then the photograph, then nothing', () => {
  const f = (o) => D.roofFromData(o, false, 'house', 0.3, 0.3);
  assert.equal(f({}), null, 'a building the tile says nothing about keeps the procedural roof');
  assert.equal(f({ rc: 'red', rp: 12 }), null, 'a malformed colour is not a colour');
  const tag = f({ rc: '#a8523a' }), photo = f({ rp: '#b08778' }), both = f({ rc: '#858583', rp: '#b08778' });
  assert.equal(tag.src, 'tag'); assert.equal(tag.hex, 0xa8523a);
  assert.equal(photo.src, 'photo'); assert.equal(photo.hex, D.photoToMaterial(0xb08778));
  // a grey tag is not talked into red by a red photograph
  assert.equal(both.src, 'tag'); assert.equal(both.hex, 0x858583);
  // where they agree, the photograph makes each tagged roof its own age
  const a = f({ rc: '#7a3b2e', rp: '#b08778' }), b = f({ rc: '#7a3b2e', rp: '#8e6a60' });
  assert.ok(warm(a.hex) && warm(b.hex) && a.hex !== b.hex);
  // a CSS primary nobody translated is brought inside what roofing comes in
  const teal = D.toneOf(f({ rc: '#008080' }).hex);
  assert.ok(teal.c <= 64 && teal.y >= 130 && teal.cls === 'green', `teal came out c ${teal.c}, y ${teal.y}`);
  assert.ok(D.toneOf(f({ rc: '#ff2600' }).hex).c <= 121);
  // and a hex picked off the imagery (paler than any tile) is treated as a photograph
  assert.ok(D.toneOf(f({ rc: '#ecbe95' }).hex).c > D.toneOf(0xecbe95).c * 1.2);
});

test('roof:material decides the texture, on a pitched roof and on a flat one', () => {
  const want = { roof_tiles: ['tile', 'tile'], metal: ['metal', 'metal'], concrete: ['ctile', 'gravel'],
    tar_paper: ['bitumen', 'bitumen'], glass: ['glass', 'glass'], grass: ['grass', 'grass'],
    copper: ['copper', 'copper'], slate: ['slate', 'slate'], gravel: ['gravel', 'gravel'] };
  for (const [name, [p, fl]] of Object.entries(want)) {
    const rm = ROOF_MATERIALS.indexOf(name);
    assert.ok(rm > 0, `tiledata knows ${name}`);
    const a = D.roofFromData({ rm }, false, 'house', 0.3, 0.3), b = D.roofFromData({ rm }, true, 'block', 0.3, 0.3);
    assert.equal(a.style, p, `${name} on a pitched roof`);
    assert.equal(b.style, fl, `${name} on a flat roof`);
    assert.equal(a.src, 'material');
    assert.ok(T.ROOF_STYLES[a.style] && T.ROOF_STYLES[b.style]);
  }
  // every index the builder can write has an answer
  for (let rm = 1; rm < ROOF_MATERIALS.length; rm++)
    assert.ok(T.ROOF_STYLES[D.roofFromData({ rm }, false, 'house', 0.5, 0.5).style], ROOF_MATERIALS[rm]);
  // copper is green unless somebody says otherwise, and tiles tagged grey are concrete
  assert.equal(D.toneOf(D.roofFromData({ rm: 7 }, false, 'church', 0, 0).hex).cls, 'green');
  assert.equal(D.roofFromData({ rm: 1, rc: '#858583' }, false, 'house', 0, 0).style, 'ctile');
  assert.equal(D.roofFromData({ rm: 1, rc: '#a8523a' }, false, 'house', 0, 0).style, 'tile');
});

test('every roofing has its own cell in the roof atlas and its own uv to name it', () => {
  const idx = new Set(), pins = new Set();
  for (const style of Object.keys(T.ROOF_STYLES)) {
    const i = T.roofIndex(style), [u, v] = T.roofPin(style);
    assert.ok(Number.isInteger(i) && i >= 0 && i < 16, `${style} is cell ${i}`);
    assert.ok(!idx.has(i), `${style} shares a cell`); idx.add(i);
    pins.add(u + ',' + v);
    // the pin lands in row 0, columns 1..5 (what the shader tests for), and
    // decodes back to the index the way the shader decodes it
    const col = Math.floor(u * T.ATLAS_N), row = Math.floor((1 - v) * T.ATLAS_M * T.ROOF_ROWS);
    assert.ok(v > 1 - 1 / T.ATLAS_M && col >= 1 && col <= 5, `${style} pinned outside the roof cells`);
    assert.equal(col - 1 + 5 * row, i);
    // and survives the worker codec's uint16 uv
    const q = (x) => Math.round(x * 65535) / 65535;
    assert.equal(Math.floor(q(u) * T.ATLAS_N) - 1 + 5 * Math.floor((1 - q(v)) * T.ATLAS_M * T.ROOF_ROWS), i);
  }
  assert.equal(pins.size, Object.keys(T.ROOF_STYLES).length);
});

// ---- the real city -------------------------------------------------------------

const load = (name) => {
  const tile = JSON.parse(readFileSync(new URL(`../public/data/tiles/${name}.json`, import.meta.url), 'utf8'));
  let id = 1;
  for (const b of tile.buildings) b._id = id++;
  return tile.buildings.filter((b) => b.o && b.o.length >= 3);
};

test('central Pardubice takes its roofs from the photograph', () => {
  const B = load('0_-1');
  const src = { tag: 0, photo: 0, material: 0, proc: 0 };
  let redPhoto = 0, redTiled = 0, greyPhoto = 0, greyRed = 0, promoted = 0;
  for (const b of B) {
    const roof = roofOf(b);
    src[roof.src]++;
    assert.ok(T.ROOF_STYLES[roof.style], `unknown roof style ${roof.style}`);
    assert.ok(roof.hex > 0 && roof.hex <= 0xffffff);
    if (b.rc || !b.rp) continue;
    const m = D.toneOf(D.photoToMaterial(D.hexOf(b.rp)));
    if (m.cls === 'red' && roof.shape !== 'flat') {
      redPhoto++;
      if (roof.style === 'tile' || roof.style === 'ctile') redTiled++;
      if (!b.r) promoted++;
    }
    if (m.cls === 'dark' || m.cls === 'grey' || m.cls === 'pale') {
      greyPhoto++;
      if (warm(roof.hex)) greyRed++;
    }
  }
  assert.ok(src.photo > 9000 && src.tag > 200, `sources: ${JSON.stringify(src)}`);
  assert.ok(redPhoto > 2000, `red roofs in the photograph: ${redPhoto}`);
  assert.equal(redTiled, redPhoto, 'a roof that is red from the air is tiled');
  assert.ok(greyPhoto > 4000 && greyRed < greyPhoto * 0.01,
    `${greyRed} of ${greyPhoto} grey roofs came out red`);
  // the builder leaves commercial houses and five storeys and up without a
  // shape; the ones photographed clay red get their pitched roof back
  assert.ok(promoted > 30, `flat-by-default buildings given the roof they were photographed with: ${promoted}`);
});

test('a tile with no photograph and no tags is exactly the procedural city', () => {
  // south of the railway: no rp, no rc. Nothing may have moved there.
  const B = load('0_0').filter((b) => !b.rp && !b.rc && !b.rm && b.rl === undefined);
  assert.ok(B.length > 8000);
  for (let i = 0; i < B.length; i += 7) {
    const roof = roofOf(B[i]);
    assert.equal(roof.src, 'proc');
    assert.ok(!roof.rise && !roof.attic && !roof.low && !roof.swap && !roof.flip && !roof.steep);
    assert.ok(['tile', 'slate', 'bitumen', 'gravel', 'metal'].includes(roof.style));
  }
});

// ---- the tagged shape ----------------------------------------------------------

// The ridge of a roof mesh: its highest ROOF vertices (the chimney, which
// stands over it, is pinned to the plain texel and is left out).
const span = (g) => {
  const p = g.attributes.position, uv = g.attributes.uv;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y1 = -Infinity;
  const roofV = (i) => isRoofUv(uv.getX(i), uv.getY(i));
  for (let i = 0; i < p.count; i++) if (roofV(i)) y1 = Math.max(y1, p.getY(i));
  for (let i = 0; i < p.count; i++) {
    if (!roofV(i) || p.getY(i) < y1 - 0.05) continue;
    x0 = Math.min(x0, p.getX(i)); x1 = Math.max(x1, p.getX(i));
    z0 = Math.min(z0, p.getZ(i)); z1 = Math.max(z1, p.getZ(i));
  }
  return { top: y1, dx: x1 - x0, dz: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
};
// a house 12 m along x and 8 m along z, wall top at y = 10
const house = (extra) => ({ _id: 4242, o: rect(0, 0, 12, 8), h: 7, lv: 2, t: 'house', r: 'gabled', ...extra });

test('roof:height, roof:levels and the ridge direction shape the roof', () => {
  const plain = span(roofGeometry(house({}), 10, 0xd0c8b8));
  assert.ok(plain.dx > 8 && plain.dz < 1.5, 'untagged: the ridge runs along the long side');
  // roof:height is the rise
  const tall = span(roofGeometry(house({ rh: 4.5 }), 10, 0xd0c8b8));
  const low = span(roofGeometry(house({ rh: 1.5 }), 10, 0xd0c8b8));
  assert.ok(Math.abs((tall.top - low.top) - 3) < 0.05, `3 m more roof:height is ${(tall.top - low.top).toFixed(2)} m more roof`);
  // roof:levels: an attic storey stands up, a roof over nothing lies down
  const attic = roofOf(house({ rl: 1, _id: 4243 })), none = roofOf(house({ rl: 0, _id: 4244 }));
  assert.equal(attic.attic, 1); assert.equal(none.low, true);
  const gA = roofGeometry(house({ rl: 1, _id: 4243 }), 10, 0xd0c8b8);
  const gN = roofGeometry(house({ rl: 0, _id: 4244 }), 10, 0xd0c8b8);
  assert.ok(span(gA).top > span(gN).top + 1, 'an attic roof is taller than a roof over nothing');
  // the attic shows its windows: dark panes that the plain roof has not got
  const dark = (g) => {
    const c = g.attributes.color; let n = 0;
    for (let i = 0; i < c.count; i++) if (c.getX(i) < 0.06 && c.getZ(i) > c.getX(i) * 1.5) n++;
    return n;
  };
  assert.ok(dark(gA) >= 12 && dark(gN) === 0, `skylight vertices: ${dark(gA)} with an attic, ${dark(gN)} without`);
  // roof:orientation = across turns the ridge to the short side
  const across = span(roofGeometry(house({ ro: 2, _id: 4245 }), 10, 0xd0c8b8));
  assert.ok(across.dz > 5 && across.dx < 1.5, 'ro = 2: the ridge runs across the long side');
  // roof:direction (the way the slope faces) does the same, and beats ro
  const east = span(roofGeometry(house({ rd: 90, ro: 1, _id: 4246 }), 10, 0xd0c8b8));
  assert.ok(east.dz > 5 && east.dx < 1.5, 'slopes facing east and west: the ridge runs north to south');
  const north = span(roofGeometry(house({ rd: 0, ro: 2, _id: 4247 }), 10, 0xd0c8b8));
  assert.ok(north.dx > 8 && north.dz < 1.5, 'slopes facing north and south: the ridge runs east to west');
  // a monopitch falls the way it is tagged: z is SOUTH, so facing north (0)
  // puts the high edge at +z, facing south (180) at -z
  const mono = (rd, id) => span(roofGeometry({ ...house({ rd, _id: id }), r: 'skillion' }, 10, 0xd0c8b8));
  assert.ok(mono(0, 4248).cz > 3 && mono(180, 4249).cz < -3, 'a skillion falls toward its roof:direction');
  assert.ok(mono(90, 4250).cx < -4 && mono(270, 4251).cx > 4);
});

// ---- three renderers, one answer ------------------------------------------------

function worldWith(buildings) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 100;
  for (const b of buildings) { b._id ??= ++id; b._home = '0,0'; }
  const cell = { buildings, roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  indexJunctions([]); setStreetCity(city);
  const terrain = new Terrain(4800, 20);
  terrain.grids.set('0,0', new Int16Array(terrain.n * terrain.n).fill(GROUND * 10)); terrain._loads = 1;
  const mats = makeMaterials();
  mats.terrain = terrain; mats.hidden = new Set(); mats.facades = true;
  mats._facadeMat = FACADE_MAT;
  const wordmark = new THREE.MeshBasicMaterial(); mats.brandMat = () => wordmark;
  return { city, terrain, canopy: null, ground: null, mats, wordmark };
}
// one of everything the tile can say (the blocks are named: an unnamed block of
// flats is a flat-roofed novostavba three times in ten, by hash)
const tagged = () => [
  { o: rect(20, 20, 12, 8, 10), h: 7, lv: 2, t: 'house', r: 'gabled', rp: '#b08778' },
  { o: rect(44, 20, 12, 8, 0), h: 7, lv: 2, t: 'house', r: 'gabled', rc: '#7a3b2e', rp: '#9e786b', rl: 1 },
  { o: rect(68, 20, 12, 8, 25), h: 9, lv: 2, t: 'house', r: 'hipped', rm: 7, rh: 4, ro: 2 },
  { o: rect(96, 22, 14, 9, 0), h: 8, lv: 2, t: 'house', r: 'skillion', rm: 2, rd: 135 },
  { o: rect(24, 50, 24, 14, 0), h: 16, lv: 5, t: 'apartments', n: 'A', rp: '#cfd8da', bm: 2 },
  { o: rect(60, 52, 20, 16, 5), h: 14, lv: 4, t: 'apartments', n: 'B', r: 'mansard', rl: 1, rc: '#858583', bm: 6 },
  { o: rect(92, 56, 18, 18, 0), h: 12, lv: 3, t: 'civic', rm: 5, bm: 4 },
  { o: rect(30, 90, 26, 16, 0), h: 10, lv: 3, t: 'apartments', n: 'C', rp: '#a77768' },
  { o: rect(76, 94, 30, 18, 0), h: 7, lv: 1, t: 'industrial', rp: '#545d5b', bm: 7 },
];
const facade = (root, mats) => {
  let m = null;
  root.traverse((o) => { if (o.isMesh && o.material === mats._facadeMat) m = o; });
  return m;
};

test('the worker builds the tagged roofs and walls the main thread builds', () => {
  const world = worldWith(tagged());
  const sync = buildChunkMeshes(world.city, 0, 0, world.mats, 'full');
  const got = chunkSpec(world, 0, 0, 'full', { terrain: new Map(), canopy: new Map() });
  // the worker gets a structured clone, and the fields with it
  const spec = structuredClone(got.spec, { transfer: got.transfer });
  const sent = spec.cells['0,0'].buildings;
  for (const k of ['rc', 'rp', 'rm', 'bm', 'rl', 'rh', 'rd', 'ro'])
    assert.ok(sent.some((b) => b[k] !== undefined), `the chunk spec carries ${k}`);
  const out = buildChunkPayload(makeWorkerState(), spec);
  const decMats = { ...world.mats, codecMats: {} };
  for (const k of Object.keys(out.brands || {})) decMats.codecMats[k] = world.wordmark;
  const back = decode(out.payload, decMats);
  const a = facade(sync, world.mats), b = facade(back, world.mats);
  assert.ok(a && b, 'both builds carry a facade mesh');
  const pa = a.geometry.attributes.position, pb = b.geometry.attributes.position;
  assert.equal(pa.count, pb.count, 'the two threads emit the same vertices');
  sync.updateMatrixWorld(true); back.updateMatrixWorld(true);
  const ca = a.geometry.attributes.color, cb = b.geometry.attributes.color;
  const ua = a.geometry.attributes.uv, ub = b.geometry.attributes.uv;
  const va = new THREE.Vector3(), vb = new THREE.Vector3();
  let roofs = 0, worstC = 0;
  const styles = new Set();
  for (let i = 0; i < pa.count; i++) {
    va.fromBufferAttribute(pa, i).applyMatrix4(a.matrixWorld);
    vb.fromBufferAttribute(pb, i).applyMatrix4(b.matrixWorld);
    assert.ok(va.distanceTo(vb) <= MAX_ERR, `vertex ${i} moved ${va.distanceTo(vb).toFixed(3)} m between threads`);
    worstC = Math.max(worstC, Math.abs(ca.getX(i) - cb.getX(i)), Math.abs(ca.getY(i) - cb.getY(i)),
      Math.abs(ca.getZ(i) - cb.getZ(i)));
    if (!isRoofUv(ua.getX(i), ua.getY(i))) continue;
    roofs++;
    // the same roofing, after the codec's uint16 uv
    const sty = (U, k) => Math.floor(U.getX(k) * T.ATLAS_N) - 1 + 5 * Math.floor((1 - U.getY(k)) * T.ATLAS_M * T.ROOF_ROWS);
    assert.equal(sty(ua, i), sty(ub, i), `vertex ${i} names a different roofing in the worker`);
    styles.add(sty(ua, i));
  }
  assert.ok(roofs >= 90, `roof vertices compared: ${roofs}`);
  assert.ok(worstC < 0.006, `colours differ by ${worstC.toFixed(4)} between threads (the codec stores 8 bits)`);
  assert.ok(styles.size >= 6, `the fixture wears ${styles.size} different roofings`);
});

test('the far mesh, the shell roof and the shell deck are one colour and one roofing', () => {
  const B = tagged();
  const world = worldWith(B);
  const mesh = facade(buildBuildingsMesh(world.city, 0, 0, world.mats), world.mats);
  const col = mesh.geometry.attributes.color, uv = mesh.geometry.attributes.uv, pos = mesh.geometry.attributes.position;
  // every roof-pinned colour in the far mesh, by roofing
  const far = new Map();
  for (let i = 0; i < uv.count; i++) {
    if (!isRoofUv(uv.getX(i), uv.getY(i))) continue;
    const k = uv.getX(i).toFixed(5) + ',' + uv.getY(i).toFixed(5);
    if (!far.has(k)) far.set(k, []);
    far.get(k).push([col.getX(i), col.getY(i), col.getZ(i), pos.getX(i), pos.getZ(i)]);
  }
  const near = (list, rgb, f) => list.some((c) => Math.abs(c[0] - rgb[0]) < 1e-4 && Math.abs(c[1] - rgb[1]) < 1e-4
    && Math.abs(c[2] - rgb[2]) < 1e-4 && Math.hypot(c[3] - f.o[0][0], c[4] - f.o[0][1]) < 40);
  let pitched = 0, flat = 0;
  for (const f of B) {
    const roof = roofOf(f), pin = T.roofPin(roof.style), rgb = linRGB(roof.hex);
    const list = far.get(pin[0].toFixed(5) + ',' + pin[1].toFixed(5));
    assert.ok(list && near(list, rgb, f), `the far mesh does not wear ${roof.style} #${roof.hex.toString(16)} on building ${f._id}`);
    // the near shell is planned from the very same roof object
    const plan = buildingPlan(f, [], [], GROUND);
    assert.equal(plan.roof, roof, 'the shell plans its deck from another roof');
    assert.equal(plan.rows.family, T.facadeRows(f, classify(f), plan.officeVar).family);
    // and a pitched roof's own mesh carries that colour under that pin
    const g = roofGeometry(f, plan.top, buildingWallHex(f));
    if (roof.shape === 'flat') { flat++; continue; }
    pitched++;
    const gc = g.attributes.color, gu = g.attributes.uv;
    let hit = 0;
    for (let i = 0; i < gu.count; i++)
      if (Math.abs(gu.getX(i) - pin[0]) < 1e-6 && Math.abs(gu.getY(i) - pin[1]) < 1e-6
        && Math.abs(gc.getX(i) - rgb[0]) < 1e-4 && Math.abs(gc.getZ(i) - rgb[2]) < 1e-4) hit++;
    assert.ok(hit >= 6, `the shell roof of building ${f._id} lost its ${roof.style}`);
  }
  assert.ok(pitched >= 5 && flat >= 2, `${pitched} pitched and ${flat} flat roofs checked`);
});

// ---- walls ----------------------------------------------------------------------

test('building:material paints the wall, and a tagged colour still wins', () => {
  const mk = (extra, id) => ({ _id: id, o: rect(0, 0, 24, 14), h: 13, lv: 4, t: 'apartments', n: 'Dům', ...extra });
  const brick = mk({ bm: WALL_MATERIALS.indexOf('brick') }, 7001);
  assert.ok(warm(buildingWallHex(brick)), 'a brick wall is brick red');
  assert.equal(T.facadeRows(brick, classify(brick)).family, 'brick', 'and wears the brick cells');
  const glass = mk({ bm: WALL_MATERIALS.indexOf('glass') }, 7002);
  assert.equal(T.facadeRows(glass, classify(glass)).family, 'officeGrid', 'a glass wall is a curtain wall');
  // both tiers read the same rows, so the shell is cut from the same cells
  for (const f of [brick, glass]) {
    const plan = buildingPlan(f, [], [], 0), rows = T.facadeRows(f, classify(f), plan.officeVar);
    assert.deepEqual(plan.rows.mid.cell, rows.mid.cell);
    assert.equal(plan.wallHex ?? buildingWallHex(f), buildingWallHex(f));
  }
  const stone = mk({ bm: WALL_MATERIALS.indexOf('stone') }, 7003), plain = mk({}, 7003);
  assert.notEqual(buildingWallHex(stone), buildingWallHex(plain), 'stone is not the plaster palette');
  assert.equal(T.facadeRows(stone, classify(stone)).family, T.facadeRows(plain, classify(plain)).family,
    'a material with no family of its own keeps the typology');
  // poured concrete four storeys up is a panel block; a low one keeps its cells
  const panel = mk({ bm: WALL_MATERIALS.indexOf('concrete') }, 7006);
  assert.equal(T.facadeRows(panel, classify(panel)).family, 'panel', 'a concrete block of flats is a panelak');
  const low = { ...mk({ bm: WALL_MATERIALS.indexOf('concrete') }, 7007), lv: 2, h: 7 };
  const lowPlain = { ...mk({}, 7007), lv: 2, h: 7 };
  assert.equal(T.facadeRows(low, classify(low)).family, T.facadeRows(lowPlain, classify(lowPlain)).family);
  // building:colour beats the material
  const painted = mk({ bm: 2, c: '#3060c0' }, 7004);
  assert.equal(buildingWallHex(painted), 0x3060c0);
  // plaster, and a material nobody listed, change nothing
  assert.equal(D.wallTone({ bm: 1 }, 0.5), null);
  assert.equal(D.wallTone({ bm: 99 }, 0.5), null);
  assert.equal(D.wallTone({}, 0.5), null);
  // a hall stays sheet whatever it is tagged
  const hall = { _id: 7005, o: rect(0, 0, 60, 40), h: 9, lv: 1, t: 'industrial', bm: 2 };
  assert.equal(T.facadeRows(hall, classify(hall)).family, 'hall');
});

test('a new-build stamp does not flatten a roof the tile backs with a second witness', () => {
  // the typology stamps a third of three to five storey flats as flat new-builds
  // by hash; a Vinohrady tenement mapped gabled, clay tiled and with an attic
  // keeps its pitched roof, and a bare shape tag alone does not overrule the stamp
  const mk = (extra, id) => ({ _id: id, o: rect(0, 0, 24, 12), h: 16, lv: 5, t: 'residential', r: 'gabled', ...extra });
  const tiled = mk({ rm: ROOF_MATERIALS.indexOf('roof_tiles') }, 7101);
  const attic = mk({ rl: 1 }, 7102), bare = mk({}, 7103), metal = mk({ rm: ROOF_MATERIALS.indexOf('metal') }, 7104);
  assert.equal(D.dataBacksPitch(tiled), true);
  assert.equal(D.dataBacksPitch(attic), true);
  assert.equal(D.dataBacksPitch(bare), false, 'a shape tag needs a second witness');
  assert.equal(D.dataBacksPitch(metal), false, 'a sheet roof can be flat');
  assert.equal(D.dataBacksPitch({ ...tiled, r: 'flat' }), false);
  assert.notEqual(T.roofOf(tiled, 'nova').shape, 'flat');
  assert.equal(T.roofOf(attic, 'pavilion').attic, 1);
  assert.equal(T.roofOf(bare, 'nova').shape, 'flat');
  // the slab and the office tower stay flat whatever the tags say
  assert.equal(T.roofOf(mk({ rm: 1 }, 7105), 'panel').shape, 'flat');
});
