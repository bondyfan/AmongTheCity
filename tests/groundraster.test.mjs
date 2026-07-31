// ---- the classifier's ground ships as a raster, not as polygons -------------
// The polygon version failed twice: nine thousand rectangles per city tile, and
// a polygon is a plate at a fixed layer height — a levelled road cuts up to
// 14 cm into the hill, so the plate could sit ABOVE the carriageway and bury
// it ("silnice mizí a pod nimi je dlažba"). The raster is drawn by the client
// at LAYER_Y.inferred, below every OSM fill and every levelled road, so that
// conflict cannot be expressed at all. These tests hold the seams of that.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { GroundClass, decodeRLE, GROUND_RES } = await import('../js/groundclass.js');
const { LAYER_Y } = await import('../js/config.js');
const { SURF } = await import('../js/surfaces.js');
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');

const TILE = 4800, N = TILE / GROUND_RES;

/** Build an RLE buffer the way the classifier writes one. */
function rle(runs) {
  const out = [];
  for (const [n, v] of runs) {
    let left = n;
    while (left > 0) {
      const take = Math.min(left, 65535);
      out.push(take & 255, take >> 8, v);
      left -= take;
    }
  }
  return new Uint8Array(out).buffer;
}

/** A GroundClass with one tile's cells set from a paint callback. */
function groundWith(paint) {
  const g = new GroundClass();
  const arr = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    arr[j * N + i] = paint((i + 0.5) * GROUND_RES, (j + 0.5) * GROUND_RES) | 0;
  }
  g.grids.set('0,0', arr);
  return g;
}

test('the RLE round-trips, including runs past the uint16 ceiling', () => {
  const total = N * N;
  const out = decodeRLE(rle([[70000, 0], [5, 1], [total - 70005, 0]]), total);
  assert.equal(out[69999], 0);
  assert.equal(out[70000], 1);
  assert.equal(out[70004], 1);
  assert.equal(out[70005], 0);
  assert.throws(() => decodeRLE(rle([[10, 1]]), total), /short/,
    'a truncated raster must fail loudly, not ship a half-empty world');
});

test('an unloaded tile is a MISS and an absent one is open country', () => {
  const g = new GroundClass();
  g.missed = false;
  assert.equal(g.classAt(100, 100), 0);
  assert.equal(g.missed, true, 'a pending tile must mark the chunk as guessed');
  g.grids.set('0,0', null);                 // the 404 path: never classified
  g.missed = false;
  assert.equal(g.classAt(100, 100), 0);
  assert.equal(g.missed, false, 'open country is definitive, not a guess');
});

test('rectsIn merges a square into one rectangle, not nine hundred', () => {
  // a 60×60 m paved square inside the first chunk
  const g = groundWith((x, z) => (x >= 20 && x < 80 && z >= 20 && z < 80 ? 1 : 0));
  const rects = g.rectsIn(0, 0);
  assert.equal(rects.length, 1, `got ${rects.length} rects for one square`);
  const r = rects[0];
  assert.deepEqual([r.x0, r.z0, r.x1, r.z1, r.c], [20, 20, 80, 80, 1]);
});

test('rectsIn keeps materials apart and stays inside its chunk', () => {
  const g = groundWith((x, z) =>
    (z >= 40 && z < 60 ? (x < 60 ? 1 : x < 200 ? 2 : 0) : 0));
  const rects = g.rectsIn(0, 0);
  const paving = rects.filter((r) => r.c === 1), asphalt = rects.filter((r) => r.c === 2);
  assert.equal(paving.length, 1);
  assert.equal(asphalt.length, 1);
  assert.equal(asphalt[0].x1, 120, 'a rect ran past its own chunk');
  // …and the neighbour picks the rest of the asphalt up itself
  assert.ok(g.rectsIn(120, 0).some((r) => r.c === 2 && r.x0 === 120));
});

test('the chunk mesh draws the raster UNDER every levelled road', () => {
  const g = groundWith((x, z) => (x < 120 && z < 120 ? 1 : 0));
  const cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: TILE };
  const mats = makeMaterials();
  mats.terrain = { res: 20, ready: () => true, heightAt: () => 200, missed: false };
  mats.ground = g;
  mats.trees = false; mats.facades = false; mats.ortho = null;
  const group = buildChunkMeshes(city, 0, 0, mats, 'full');
  assert.ok(group, 'chunk built nothing');
  let found = 0;
  for (const m of group.children) {
    const pos = m.geometry?.attributes?.position, sf = m.geometry?.attributes?.surf;
    if (!pos || !sf) continue;
    for (let i = 0; i < pos.count; i++) {
      if (sf.getX(i) !== SURF.paving) continue;
      found++;
      assert.ok(Math.abs(pos.getY(i) - (200 + LAYER_Y.inferred)) < 1e-3,
        `inferred paving at +${(pos.getY(i) - 200).toFixed(2)} — it must sit at LAYER_Y.inferred`);
    }
  }
  assert.ok(found > 0, 'the raster produced no geometry at all');
  // the layer itself is the invariant: below the shallowest possible road
  const GRADE_CUT = 0.14;                    // geo.js — a levelled road's deepest cut
  assert.ok(LAYER_Y.inferred < LAYER_Y.road - GRADE_CUT,
    'LAYER_Y.inferred can reach above a road in full cutting — the burial is back');
  assert.ok(LAYER_Y.inferred < LAYER_Y.green,
    'inferred ground outranks mapped OSM green — OSM must win');
});

test('no grass grows on raster-sealed ground', async () => {
  const { GrassMask } = await import('../js/grassmask.js');
  const g = groundWith((x, z) => (x >= 40 && x < 80 && z >= 40 && z < 80 ? 1 : 0));
  const cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] };
  const m = new GrassMask({ chunkIndex: new Map([['0,0', cell]]) }, g);
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(60, 60), 0, 'grass grew through the inferred paving');
  assert.ok(m.heightAt(20, 20) > 0, 'the sealed square took the whole chunk with it');
});
