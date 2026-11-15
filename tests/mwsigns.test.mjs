// js/mwsigns.js and its mesher: the D11 / D35 signs. What a screenshot would
// not show until a co-op session or a long drive found it:
//   · a gantry on a chunk border built twice (or by neither chunk);
//   · a sign on a bridge deck, floating over the valley;
//   · a board on the asphalt of a slip road;
//   · a face the worker writes uvs for that the atlas never painted;
//   · the worker building a D11 chunk differently from the main thread.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const S = await import('../js/mwsigns.js');
const F = await import('../js/mwfaces.js');
const D = await import('../js/d11.js');
const { SLIPS } = await import('../js/mwslips.js');

const all = S.allMotorwaySigns();
const count = (pred) => all.filter(pred).length;
// the gantry that signs exit n on carriageway cw
const gantryOf = (n, cw) => all.find((i) => i.t === 'gantry' && i.cw === cw && i.panels.some((p) => p.f.startsWith('X|' + n + '|')));

test('every item is owned by exactly the chunk its owner point lies in', () => {
  const seen = new Set();
  let n = 0;
  for (const [key, items] of [...new Set(all.map((i) => i.key))].map((k) => [k, S.plannedMotorwaySigns(k)])) {
    for (const it of items) {
      assert.equal(it.key, key);
      assert.equal(Math.floor(it.ox / 120) + ',' + Math.floor(it.oz / 120), key, 'owner point in another chunk');
      assert.ok(!seen.has(it), 'an item listed under two keys');
      seen.add(it); n++;
    }
  }
  assert.equal(n, all.length);
  assert.equal(S.plannedMotorwaySigns('0,0').length, 0, 'Pardubice centre has motorway signs');
  // the quick tile gate lists exactly the tiles the plan uses
  const tiles = new Set(all.map((i) => Math.floor(i.ox / 4800) + ',' + Math.floor(i.oz / 4800)));
  assert.deepEqual([...tiles].sort(), [...S.SIGN_TILES].sort(), 'SIGN_TILES is out of date');
});

test('the plan has what a Czech driver expects, and in sane numbers', () => {
  const g = count((i) => i.t === 'gantry'), km = count((i) => i.t === 'km');
  // per in-world exit side one gantry (the D0 knot eastbound has none)
  assert.ok(g >= 34 && g <= 42, `${g} gantries`);
  // two km boards a km per carriageway over ~102 + 102 + 32 + 32 km, minus the skipped
  assert.ok(km > 380 && km < 560, `${km} km boards`);
  assert.ok(count((i) => i.kind === 'adv') >= 2 * g - 6, 'advance boards missing');
  assert.equal(count((i) => i.kind === 'ip15'), 4);
  const e68 = gantryOf(68, 'E');
  assert.ok(e68, 'no gantry before exit 68 eastbound');
  assert.ok(e68.panels.some((p) => p.f.startsWith('X|68|') && p.f.includes('Lázně Bohdaneč')));
  // over the right of the road, the through panel left of the exit panel
  const [t, x] = e68.panels;
  assert.ok(t.off < x.off && x.off - x.w / 2 > t.off + t.w / 2, 'panels overlap');
  assert.ok(e68.left < -12 && e68.right > 7, 'legs are not beyond both carriageways');
  // Sedlice eastbound names the D35 destinations
  const sed = gantryOf(84, 'E');
  assert.ok(sed?.panels.some((p) => p.f.includes('Pardubice') && p.f.endsWith('|D35')));
});

test('nothing stands on a bridge deck, past the world, or on a slip road', () => {
  for (const it of all) {
    assert.ok(!D.onBridge(it.km, it.cw, 0.02), `${it.t} ${it.kind ?? ''} on a bridge at ${it.cw} ${it.km}`);
    if (D.ROAD[it.cw] === 'D11') assert.ok(it.km < D.D11_WORLD_END_KM, `${it.cw} ${it.km} past the world`);
    if (it.t === 'gantry' || it.kind === 'gore') continue;
    for (const [id, s] of Object.entries(SLIPS)) {
      if (!id.endsWith(':' + it.cw)) continue;
      if (s[2] != null && s[2] !== s[3]) assert.ok(!(it.km > s[2] && it.km < s[3]), `${it.kind ?? it.t} in slip ${id} at ${it.km}`);
      if (s[5] != null && s[5] !== s[6]) assert.ok(!(it.km > s[5] && it.km < s[6]), `${it.kind ?? it.t} in slip ${id} at ${it.km}`);
    }
  }
});

test('km boards read the official km with a decimal comma', () => {
  assert.equal(S.kmText(68.5), '68,5');
  assert.equal(S.kmText(131), '131,0');
  const b = all.find((i) => i.t === 'km' && i.cw === 'W' && i.km >= 30 && Number.isInteger(i.km));
  assert.ok(b && b.text === b.km + ',0');
  // it stands where d11 says that km is on W, on the right verge
  const p = D.d11At(b.km, 'W');
  const ox = p.x - p.dz * b.off, oz = p.z + p.dx * b.off;
  assert.ok(Math.hypot(ox - b.ox, oz - b.oz) < 0.01);
  const loc = D.d11Locate(b.ox, b.oz);
  assert.ok(loc && loc.cw === 'W' && loc.off > 7, 'the post is not on the right verge');
});

test('distance boards count down to the towns ahead', () => {
  const l = S.distLines('E', 63.3);
  assert.deepEqual(l.map((x) => x[0]), ['Pardubice', 'Hradec Králové']);
  assert.equal(l[1][1], 27);
  assert.deepEqual(S.distLines('W', 40).map((x) => x[0]), ['Praha']);
  assert.equal(S.distLines('N', 130.5)[0][1], 88 - 0); // 3.5 km to Sedlice + 84 on the D11
});

test('every face named by the plan has a cell on the atlas, and none overlap', () => {
  const rects = F.mwRects();
  for (const it of all) {
    const names = it.t === 'gantry' ? it.panels.map((p) => p.f) : it.t === 'km' ? [...it.text].map((c) => 'k' + c) : [it.f, it.sub?.f];
    for (const n of names) if (n) assert.ok(rects.has(n), `face ${n} has no cell`);
  }
  // the canvas is made at boot at the fixed MW_ATLAS_H (so the boot never
  // plans the road): the layout must fit inside it
  const H = F.MW_ATLAS_H;
  assert.ok(F.mwAtlasH() <= H, `the layout needs ${F.mwAtlasH()} px, the canvas has ${H}`);
  const list = [...rects.values()];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    assert.ok(a[0] >= 0 && a[1] >= 0 && a[0] + a[2] <= F.MW_ATLAS_W && a[1] + a[3] <= H);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j];
      assert.ok(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1], 'cells overlap');
    }
  }
  const uv = F.mwUV('back');
  assert.ok(uv.every((v) => v > 0 && v < 1));
});

test('Wrocław keeps its Polish ł and Czech names keep their diacritics', () => {
  const keys = [...S.motorwayFaces().keys()].join('\n');
  assert.ok(!keys.includes('Wroclaw'));
  assert.ok(keys.includes('Lázně Bohdaneč'));
});

// ---- the mesher, both ways --------------------------------------------------
const THREE = await import('three');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { Terrain } = await import('../js/terrain.js');
const { chunkSpec } = await import('../js/chunkspec.js');
const { makeWorkerState, buildChunkPayload } = await import('../js/meshworker.js');
const { decode, MAX_ERR } = await import('../js/geomcodec.js');
const { JUNCTIONS, CLUSTERS, setStreetCity } = await import('../js/geo.js');

// the chunk holding the eastbound exit 68 gantry
const gk = gantryOf(68, 'E').key;
const [GX, GZ] = gk.split(',').map(Number);

function world68() {
  JUNCTIONS.clear(); CLUSTERS.clear();
  const t = new Terrain(4800, 20);
  const tx = Math.floor(GX * 120 / 4800), tz = Math.floor(GZ * 120 / 4800);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++)
    g[j * t.n + i] = Math.round((230 + Math.sin(i * 0.3) * 2 + Math.cos(j * 0.2) * 1.5) * 10);
  t.grids.set(tx + ',' + tz, g);
  t._loads = 1;
  const cell = { buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [] };
  const city = { chunkIndex: new Map([[gk, cell]]), tile: 4800, pois: [], waterways: [] };
  setStreetCity(city);
  const mats = makeMaterials();
  mats.terrain = t; mats.hidden = new Set(); mats.facades = false;
  mats._facadeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  return { city, terrain: t, mats };
}

test('a D11 gantry chunk comes back from the worker as the main thread built it', () => {
  for (const lod of ['full', 'shell']) {
    const w = world68();
    const sync = buildChunkMeshes(w.city, GX, GZ, w.mats, lod);
    const names = sync.children.map((c) => c.name);
    assert.ok(names.includes('motorwaySteel') && names.includes('motorwayDeco'), `${lod}: ${names}`);
    const got = chunkSpec(w, GX, GZ, lod, { terrain: new Map(), canopy: new Map() });
    assert.ok(got, 'chunkSpec refused the D11 cell');
    const out = buildChunkPayload(makeWorkerState(), structuredClone(got.spec, { transfer: got.transfer }));
    assert.ok(!out.empty && out.payload, 'the worker built nothing');
    const back = decode(out.payload, { ...w.mats, codecMats: {} });
    assert.equal(back.children.length, sync.children.length);
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    let worst = 0;
    for (let i = 0; i < sync.children.length; i++) {
      const a = sync.children[i], b = back.children[i];
      assert.equal(b.name, a.name);
      assert.strictEqual(b.material, a.material, `${a.name} lost its material`);
      const n = a.geometry.attributes.position.count;
      assert.equal(b.geometry.attributes.position.count, n, `${a.name} vertex count`);
      a.updateMatrixWorld(true); b.updateMatrixWorld(true);
      for (let v = 0; v < n; v++) {
        p.fromBufferAttribute(a.geometry.attributes.position, v).applyMatrix4(a.matrixWorld);
        q.fromBufferAttribute(b.geometry.attributes.position, v).applyMatrix4(b.matrixWorld);
        worst = Math.max(worst, p.distanceTo(q));
      }
    }
    assert.ok(worst < MAX_ERR, `${lod}: ${(worst * 1000).toFixed(2)} mm apart`);
  }
});

test('the gantry clears the lanes by at least 5 m', () => {
  const w = world68();
  const sync = buildChunkMeshes(w.city, GX, GZ, w.mats, 'full');
  const deco = sync.children.find((c) => c.name === 'motorwayDeco');
  const it = all.find((i) => i.key === gk && i.t === 'gantry');
  const yr = w.terrain.heightAt(it.cx, it.cz);
  sync.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  let low = Infinity;
  for (let v = 0; v < deco.geometry.attributes.position.count; v++) {
    p.fromBufferAttribute(deco.geometry.attributes.position, v).applyMatrix4(deco.matrixWorld);
    // only the gantry's panels (within 9 m of the centreline)
    const off = (p.x - it.cx) * -it.dz + (p.z - it.cz) * it.dx;
    if (Math.abs(off) < 6.3) low = Math.min(low, p.y - yr);
  }
  assert.ok(low >= 5.0 && low < 6, `panel bottom ${low.toFixed(2)} m over the road`);
});

// ---- solids and the HUD --------------------------------------------------------
const { mwCollide, mwDiscsNear } = await import('../js/mwsolids.js');
const H = await import('../js/mwhud.js');

test('a car cannot drive through a gantry leg, and a helicopter flies over it', () => {
  const it = gantryOf(68, 'E');
  const lx = it.cx - it.dz * it.right, lz = it.cz + it.dx * it.right;
  const pos = { x: lx + 0.1, z: lz };
  assert.ok(mwCollide(pos, 0.5), 'nothing stopped the car');
  assert.ok(Math.hypot(pos.x - lx, pos.z - lz) > 0.9, 'pushed out too little');
  assert.ok(mwDiscsNear(lx, lz).length > 0);
  const world = { heightAt: () => 200 };
  const air = { x: lx + 0.1, z: lz };
  assert.ok(!mwCollide(air, 0.5, 200 + 30, world), 'the helicopter hit a gantry 30 m below');
  // the lanes themselves are clear
  const lane = { x: it.cx, z: it.cz };
  assert.ok(!mwCollide(lane, 1.0));
});

test('the HUD names the motorway, the km and the way, and only on the carriageway', () => {
  const p = D.d11At(68.4, 'E');
  assert.equal(H.motorwayPlace(p.x, p.z), 'D11, km 68,4, směr Hradec Králové');
  const w = D.d11At(50.04, 'W');
  assert.equal(H.motorwayPlace(w.x, w.z), 'D11, km 50,0, směr Praha');
  assert.equal(H.motorwayPlace(p.x - p.dz * 15, p.z + p.dx * 15), null, 'a slip road 15 m off is not the D11');
  assert.equal(H.motorwayPlace(25, -122), null);
  assert.equal(H.fmtExitDist(1234), '1,2 km');
  assert.equal(H.fmtExitDist(812), '800 m');
});

test('an exit joint is named at a D11 diverge, never when the route carries on', () => {
  const e68 = D.EXITS.find((e) => e.n === 68);
  const d = e68.E.div;
  const off = D.d11At(d.km + 0.2, 'E');
  // the slip leaves: its far end is 30 m right of the carriageway
  const j = H.exitJointAt(d.x, d.z, [off.x - off.dz * 30, off.z + off.dx * 30]);
  assert.deepEqual(j, { exit: 68, street: 'Nové Město, Lázně Bohdaneč' });
  // straight on along the D11
  assert.equal(H.exitJointAt(d.x, d.z, [off.x, off.z]), null);
  // navigation asks a slip without its far end (a slip's first piece can end
  // within 6 m of the carriageway, 54 m long at exit 90 eastbound)
  const e90 = D.EXITS.find((e) => e.n === 90 && e.road === 'D11');
  assert.equal(H.exitJointAt(e90.E.div.x, e90.E.div.z, null)?.exit, 90);
  // Pardubice centre is not a D11 diverge
  assert.equal(H.exitJointAt(25, -122, [30, -122]), null);
  const nav = { nextTurn: { dir: 'exit', exit: 68, street: 'Nové Město, Lázně Bohdaneč', dist: 1180 } };
  assert.equal(H.exitHudText(nav), 'Exit 68 Nové Město, Lázně Bohdaneč, 1,2 km');
  assert.equal(H.exitHudText({ nextTurn: { dir: 'left', dist: 100 } }), '');
});
