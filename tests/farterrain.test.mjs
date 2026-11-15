// ---- the far landscape lies under the streamed ground (round 8, HORIZON) ----
// js/farterrain.js draws one coarse patch per terrain tile beyond the streamed
// window, and inside the window the real ground must win the depth test
// everywhere, or the far land pokes through fields and motorway cuttings. Real
// D11 tiles: the km 30 straight, the Žehuň ecoduct's dig (a stamp the grid
// does not have) and the Labe at Poděbrady. Also pinned: what it costs and
// that it is a function of the ground alone. And js/openness.js, which decides
// where it is shown.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';

register(new URL('./three-alias.mjs', import.meta.url));

const PUBLIC = new URL('../public/', import.meta.url);
globalThis.fetch = async (url) => {
  try {
    const buf = await readFile(new URL(String(url).replace(/^\//, ''), PUBLIC));
    return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch { return { ok: false, status: 404 }; }
};

const { Terrain } = await import('../js/terrain.js');
const { patchHeights, buildPatchGeometry, FarTerrain } = await import('../js/farterrain.js');
const { sightShare, opennessOf, Openness } = await import('../js/openness.js');

// the tiles under the km 30 straight, the Žehuň ecoduct (x -32560) and Poděbrady
const TILES = [[-12, -3], [-7, -3], [-9, -2]];

async function terrainWith(tiles) {
  const t = new Terrain(4800, 20);
  for (const [tx, tz] of tiles) t.ensure(tx * 4800 + 2400, tz * 4800 + 2400, 10);
  for (let i = 0; i < 400 && t._pending.size; i++) await new Promise((r) => setTimeout(r, 10));
  for (const [tx, tz] of tiles) assert.ok(t.grids.get(tx + ',' + tz), `no height map for ${tx},${tz}`);
  return t;
}

test('every point of a patch lies under the ground it stands for', async () => {
  const t = await terrainWith(TILES);
  for (const [tx, tz] of TILES) {
    const { n, step, h } = patchHeights(t, tx, tz);
    const x0 = tx * 4800, z0 = tz * 4800;
    let worst = Infinity;
    // every 10 m, between samples too, the patch interpolated bilinearly as it is drawn
    for (let z = 0; z < 4800; z += 10) for (let x = 0; x < 4800; x += 10) {
      const i = Math.min(n - 2, Math.floor(x / step)), j = Math.min(n - 2, Math.floor(z / step));
      // (however the cell is split into triangles, the surface over it is under
      // its highest corner, which is what is checked)
      const far = Math.max(h[j * n + i], h[j * n + i + 1], h[(j + 1) * n + i], h[(j + 1) * n + i + 1]);
      const gap = t.heightAt(x0 + x, z0 + z) - far;
      if (gap < worst) worst = gap;
    }
    assert.ok(worst > 0.3, `tile ${tx},${tz}: the far land stands ${(-worst).toFixed(2)} m over the ground`);
  }
});

test('a patch costs a few milliseconds and a few thousand triangles, and is the same every time', async () => {
  const t = await terrainWith(TILES);
  buildPatchGeometry(t, -12, -3);                    // warm
  const t0 = performance.now();
  const g = buildPatchGeometry(t, -7, -3);
  const ms = performance.now() - t0;
  const tris = g.index.count / 3;
  assert.ok(tris < 9000, `${tris} triangles a patch`);
  assert.ok(ms < 60, `a patch took ${ms.toFixed(1)} ms`);
  const g2 = buildPatchGeometry(t, -7, -3);
  assert.deepEqual([...g2.attributes.position.array], [...g.attributes.position.array]);
});

test('openness: a street is shut, a field is open, the river half', () => {
  const idx = new Map();
  const cell = (cx, cz) => {
    const k = cx + ',' + cz;
    if (!idx.has(k)) idx.set(k, { buildings: [], trees: [] });
    return idx.get(k);
  };
  // a field: cells, nothing in them
  for (let cx = -5; cx <= 5; cx++) for (let cz = -5; cz <= 5; cz++) cell(cx, cz);
  assert.equal(sightShare(idx, 60, 60), 1);
  assert.equal(opennessOf(1), 1);
  // a street: houses every 20 m all round
  const town = new Map();
  for (let x = -400; x <= 400; x += 20) for (let z = -400; z <= 400; z += 20) {
    if (Math.abs(x) < 15 && Math.abs(z) < 15) continue;
    const k = Math.floor(x / 120) + ',' + Math.floor(z / 120);
    if (!town.has(k)) town.set(k, { buildings: [], trees: [] });
    town.get(k).buildings.push({ o: [[x, z]] });
  }
  assert.equal(sightShare(town, 0, 0), 0);
  assert.equal(opennessOf(0), 0);
  // a river 200 m wide running east-west through the town: open along it
  const river = new Map();
  for (const [k, c] of town) river.set(k, { buildings: c.buildings.filter((b) => Math.abs(b.o[0][1]) > 100), trees: [] });
  const share = sightShare(river, 0, 0);
  assert.ok(share > 0.15 && share < 0.6, `the river's share is ${share}`);
  // nothing indexed: no answer, and the eased value stays where it was
  assert.equal(sightShare(new Map(), 0, 0), -1);
  const o = new Openness();
  assert.equal(o.update(0.1, new Map(), 0, 0), 0);
  assert.equal(o.update(0.1, idx, 60, 60), 0, 'measured once a second');
  o._t = 0;
  assert.equal(o.update(0.1, idx, 60, 60), 1, 'the first answer is taken as it is');
});

// (review, round 8) The layer's bookkeeping: patches behind are let go even
// while the layer is hidden (a drive from the open D11 into a town), and the
// far photos are asked for two at a time, not a dozen at once.
test('the far land lets patches go when hidden, and asks for its photos two at a time', async () => {
  const t = await terrainWith(TILES);
  const scene = { add() {} };
  const ft = new FarTerrain(scene, t);
  const asked = [];
  ft._loader = { load: (url, onLoad, _p, onError) => { asked.push({ onLoad, onError }); return { image: null, dispose() {} }; } };
  // three tiles' height maps are there: at km 30 one is within reach
  for (let f = 0; f < 10; f++) ft.update(-55100, -9687, true, null);
  assert.equal(ft.patches.size, 1, 'the tile under the km 30 straight');
  assert.equal(asked.length, 1);
  // by Poděbrady the other two (and km 30's falls behind); its photo is still in flight
  for (let f = 0; f < 60; f++) ft.update(-38000, -10000, true, null);
  assert.deepEqual([...ft.patches.keys()].sort(), ['-7,-3', '-9,-2']);
  assert.equal(asked.length, 2, 'two photos in flight, the third waits');
  asked[0].onError();                                  // a dead WMS tile frees its place
  ft.update(-38000, -10000, true, null);
  assert.equal(asked.length, 3);
  // hidden, far away: everything goes within a scan
  for (let f = 0; f < 40; f++) ft.update(-200000, -12000, false, null);
  assert.equal(ft.patches.size, 0, 'hidden patches far behind were kept');
});

// (review, round 8) The earthworks bake (city.js conformTileGen) lowers the
// grid in place AFTER a far patch may have been built from it: seen in game,
// a patch built before the bake stood 5 to 7 m over the D11 at x -62400. A
// patch whose grid version moved is built again, under the new ground.
test('a patch is built again when the earthworks move its ground', async () => {
  const t = await terrainWith(TILES);
  const ft = new FarTerrain({ add() {} }, t);
  ft.photos = false;
  for (let f = 0; f < 10; f++) ft.update(-55100, -9687, true, null);
  const p = ft.patches.get('-12,-3');
  assert.ok(p, 'the km 30 patch was built');
  // dig 10 m into a 200 m square of the grid, as a bake would, and say so
  const g = t.grids.get('-12,-3'), n = t.n;
  for (let j = 100; j < 110; j++) for (let i = 100; i < 110; i++) g[j * n + i] -= 100;
  t._gridVer = new Map([['-12,-3', 1]]);
  const before = p.mesh.geometry;
  for (let f = 0; f < 25; f++) ft.update(-55100, -9687, true, null);
  assert.notEqual(p.mesh.geometry, before, 'the patch kept its old heights');
  const { n: pn, h } = patchHeights(t, -12, -3);
  const pos = p.mesh.geometry.attributes.position.array;
  for (let v = 0; v < pn * pn; v++) assert.equal(pos[v * 3 + 1], h[v]);
  // and nothing more is rebuilt while the ground stands still
  const now = p.mesh.geometry;
  for (let f = 0; f < 45; f++) ft.update(-55100, -9687, true, null);
  assert.equal(p.mesh.geometry, now);
});

// (review, round 8) While the view closes (main.js eases the fog back in over
// a second or two, e.g. after a teleport into Prague) the layer shows what it
// has but lays no new patch.
test('a closing view builds no new patch', async () => {
  const t = await terrainWith(TILES);
  const ft = new FarTerrain({ add() {} }, t);
  ft.photos = false;
  for (let f = 0; f < 30; f++) ft.update(-55100, -9687, true, null, false);
  assert.equal(ft.patches.size, 0);
  assert.equal(ft.group.visible, true);
  for (let f = 0; f < 30; f++) ft.update(-55100, -9687, true, null);
  assert.equal(ft.patches.size, 1);
});
