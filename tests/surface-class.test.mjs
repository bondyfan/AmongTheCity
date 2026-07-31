// ---- the ground was grey and drawn with a grass texture ---------------------
// Reported as "stále je tam zelená zem" at Pardubice hlavní nádraží, over and
// over, while every measurement upstream said the ground there was paving: the
// photograph classified it as paving, the tile contained the polygon, the
// server served it, the client indexed it and the chunk builder turned it into
// geometry. All true, and all beside the point.
//
// terrainTess subdivides a flat polygon so it can be draped over a hillside,
// and it rebuilt the geometry out of position and colour ALONE. The surface
// class went in and did not come out. mergeSurfaceGeometries then found a
// geometry with no `surf` attribute and helpfully filled one in with
// SURF.grass — a defensive default that turned a real bug into a silent one.
//
// So every polygon fill in the world — parks, car parks, plazas, station
// platforms, and every square inferred from the orthophoto — was drawn with the
// GRASS texture. The vertex colour was still right, which is what made it so
// hard to see: a grey car park times a green grass texture is a green car park.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { SURF } = await import('../js/surfaces.js');
const { LAYER_Y, CHUNK } = await import('../js/config.js');

const GROUND = 221;
const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];

/** One chunk holding exactly the features given, indexed the way geo.js does. */
function chunkWith(paved = [], green = []) {
  let id = 0;
  for (const f of [...paved, ...green]) { f._id = ++id; f._home = '0,0'; }
  const cell = { buildings: [], roads: [], rails: [], water: [], green, paved, trees: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800 };
  const mats = makeMaterials();
  mats.terrain = { res: 20, ready: () => true, heightAt: () => GROUND, missed: false };
  mats.trees = false;
  mats.facades = false;
  mats.ortho = null;
  return buildChunkMeshes(city, 0, 0, mats, 'full');
}

/** Every distinct surface class found at a given height above the ground. */
function classesAt(group, layer) {
  const out = new Set();
  for (const m of group.children) {
    const pos = m.geometry?.attributes?.position, sf = m.geometry?.attributes?.surf;
    if (!pos || !sf) continue;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - (GROUND + layer)) < 1e-3) out.add(sf.getX(i));
    }
  }
  return out;
}

test('a paved polygon is drawn with a PAVED surface, not a grass one', () => {
  const g = chunkWith([{ t: 'inferred', s: 'paving', o: square(20, 20, 40) }]);
  assert.ok(g, 'the chunk built nothing at all');
  const found = classesAt(g, LAYER_Y.paved);
  assert.ok(found.has(SURF.paving),
    `the paving layer carries ${[...found]} — SURF.paving is ${SURF.paving},`
    + ` SURF.grass is ${SURF.grass}`);
  assert.ok(!found.has(SURF.grass), 'grass texture on a paved surface');
});

test('what OSM says a thing is paved with wins over the guess from its type', () => {
  // `surface=sett` on a car park is a surveyor who stood on it; "parking" is a
  // word. 1 869 features in the Pardubice tile carry the tag.
  const g = chunkWith([{ t: 'parking', s: 'cobble', o: square(20, 20, 40) }]);
  assert.ok(classesAt(g, LAYER_Y.paved).has(SURF.cobble));
});

test('a green polygon keeps ITS class through the same path', () => {
  // The bug was in terrainTess, which every polygon fill goes through — so a
  // wood was being drawn with the lawn texture for exactly the same reason.
  const g = chunkWith([], [{ t: 'wood', o: square(20, 20, 40) }]);
  assert.ok(classesAt(g, LAYER_Y.green).has(SURF.forest));
});

test('a subdivided polygon keeps its class on EVERY vertex, not just the corners', () => {
  // terrainTess splits a polygon until no edge is longer than its threshold, so
  // a big one comes back with many more vertices than it went in with. Every
  // one of them has to carry the class, or the class is a coin flip per
  // triangle — which is worse than losing it outright, because it looks random.
  const g = chunkWith([{ t: 'plaza', o: square(5, 5, CHUNK - 10) }]);
  let n = 0, wrong = 0;
  for (const m of g.children) {
    const pos = m.geometry?.attributes?.position, sf = m.geometry?.attributes?.surf;
    if (!pos || !sf) continue;
    for (let i = 0; i < pos.count; i++) {
      if (Math.abs(pos.getY(i) - (GROUND + LAYER_Y.paved)) > 1e-3) continue;
      n++;
      if (sf.getX(i) !== SURF.paving) wrong++;
    }
  }
  assert.ok(n > 12, `only ${n} vertices — the fixture did not subdivide`);
  assert.equal(wrong, 0, `${wrong} of ${n} vertices lost the class`);
});
