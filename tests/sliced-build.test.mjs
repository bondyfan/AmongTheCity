// ---- one chunk build, spread over many frames ------------------------------
// buildChunkMeshes used to be atomic: 29–319 ms of main thread in one call
// (measured over Palackého), and while driving the queue is never empty, so
// every arriving chunk was a dropped frame — "když jedu rychle, tak se to
// posekává". The builder is a generator now; js/city.js pumps slices of it
// against a per-frame budget and swaps the finished group in whole.
//
// This test holds the two contracts that make that safe: the sliced build
// must produce EXACTLY the geometry the atomic build did, and it must
// actually consist of more than one slice — a generator that never yields
// is the old hitch wearing a new signature.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { buildChunkMeshes, buildChunkMeshesGen, makeMaterials } =
  await import('../js/meshes.js');
const { CityWorld } = await import('../js/city.js');

const GROUND = 221;
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];

/** A street chunk with enough kinds of feature to cross several stages. */
function makeCity() {
  let id = 0;
  const road = { d: 1, t: 'residential', w: 7, p: [[5, 60], [115, 60]] };
  const green = { t: 'grass', o: square(10, 10, 40) };
  const paved = { t: 'parking', o: square(70, 70, 40) };
  const fence = { k: 'fence', p: [[10, 90], [60, 90]] };
  for (const f of [road, green, paved, fence]) { f._id = ++id; f._home = '0,0'; }
  const cell = { buildings: [], roads: [road], rails: [], water: [],
    green: [green], paved: [paved], trees: [], barriers: [fence] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800 };
  const mats = makeMaterials();
  mats.terrain = { res: 20, ready: () => true, heightAt: () => GROUND, missed: false };
  mats.trees = false;
  mats.facades = false;
  mats.ortho = null;
  return { city, mats };
}

const vertsOf = (group) => {
  let n = 0;
  group.traverse((o) => { n += o.geometry?.attributes?.position?.count ?? 0; });
  return n;
};

test('the sliced build produces the same geometry as the atomic one, in slices', () => {
  const a = makeCity();
  const sync = buildChunkMeshes(a.city, 0, 0, a.mats, 'full');
  assert.ok(sync, 'the atomic build produced nothing at all');

  const b = makeCity();
  const gen = buildChunkMeshesGen(b.city, 0, 0, b.mats, 'full');
  let slices = 0, it;
  do { it = gen.next(); slices++; } while (!it.done);
  const sliced = it.value;
  assert.ok(sliced, 'the sliced build produced nothing at all');
  assert.equal(vertsOf(sliced), vertsOf(sync),
    'pausing between features changed what got built');
  assert.ok(slices > 3,
    `a street chunk should build in several slices, got ${slices}`);
});

// While a build is in flight its key sits in neither `built` nor the queue,
// and the per-frame ring scan used to re-enqueue it — so every chunk
// expensive enough to pause (exactly the expensive ones) was built twice,
// doubling the very cost the slicing exists to remove.
test('a multi-frame sliced build is not rebuilt a second time', () => {
  const { city, mats } = makeCity();
  mats.canopy = null; mats.ground = null;
  const adds = [];
  const scene = { add: (g) => adds.push(g.name), remove: () => {} };
  const w = Object.assign(Object.create(CityWorld.prototype), {
    scene, city, mats,
    terrain: { ready: () => true, grids: new Map() },
    interiors: { update() {} },
    built: new Map(), queue: [], _queued: new Set(),
    viewChunks: 0, shellChunks: 0, farChunks: 0,
    chunksPerFrame: 2, buildBudgetMs: 0.0001, buildCooldownMs: 0,
    _detail: new Map(), _px: new Map(), _hadTerrain: new Map(), _missBy: new Map(),
    _tileT: 1e9,
  });
  const focus = { x: 60, z: 60 };
  for (let frame = 0; frame < 400; frame++) w.update(1 / 60, focus, {});
  const chunkAdds = adds.filter((n) => n === 'chunk:0,0').length;
  assert.equal(chunkAdds, 1,
    `chunk 0,0 was added to the scene ${chunkAdds} times — built more than once`);
});
