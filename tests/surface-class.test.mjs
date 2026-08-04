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
const geoForTest = await import('../js/geo.js');
const chunkOf = (city, mats) => buildChunkMeshes(city, 0, 0, mats, 'full');
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

test('a green median cannot rise above the deck of the road it lies in', () => {
  // Palackého třída: OSM maps the median as a green polygon, drawn draped on
  // the terrain, while the carriageway is LEVELLED and may cut up to 14 cm into
  // a bump. Over the bump the median at terrain + 0.05 stood above the deck —
  // grass in the middle of the road with the lane dashes floating over it.
  const bump = (x) => GROUND + (x > 40 && x < 80 ? 0.5 : 0);
  let id = 0;
  const road = { d: 1, t: 'primary', w: 9, p: [[0, 60], [120, 60]] };
  const green = { t: 'grass', o: [[30, 55], [95, 55], [95, 65], [30, 65]] };
  for (const f of [road, green]) { f._id = ++id; f._home = '0,0'; }
  road._len = 120;
  const cell = { buildings: [], roads: [road], rails: [], water: [], green: [green], paved: [], trees: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800 };
  const mats = makeMaterials();
  mats.terrain = { res: 20, ready: () => true, heightAt: (x) => bump(x), missed: false };
  mats.trees = false; mats.facades = false; mats.ortho = null;
  const g = chunkOf(city, mats);
  assert.ok(g, 'nothing built');

  const { roadGradeY } = geoForTest;
  let breaches = 0, inCorridor = 0;
  for (const m of g.children) {
    const pos = m.geometry?.attributes?.position, sf = m.geometry?.attributes?.surf;
    if (!pos || !sf) continue;
    for (let i = 0; i < pos.count; i++) {
      if (sf.getX(i) !== SURF.grass) continue;
      const x = pos.getX(i), z = pos.getZ(i);
      if (z < 60 - 4.5 || z > 60 + 4.5) continue;         // outside the corridor
      if (x < 30 || x > 95) continue;                     // outside the median ring
      // …and only GROUND-height vertices: lamp posts merge into the same mesh
      // and inherit the default grass class, and a pole is allowed to stand
      // above a deck — that is what a pole is.
      if (pos.getY(i) > bump(x) + 0.25) continue;
      inCorridor++;
      const gy = roadGradeY(road, x, mats.terrain);
      if (gy !== null && pos.getY(i) > gy + LAYER_Y.road - 0.04) breaches++;
    }
  }
  assert.ok(inCorridor >= 4, `only ${inCorridor} median vertices landed in the corridor`);
  assert.equal(breaches, 0, `${breaches} of ${inCorridor} median vertices stand above the deck`);
});

test('a huge sliver polygon is ground down evenly, not one corner at a time', () => {
  // A 5 ha meadow strip in Polabiny came out of earcut as a fan of slivers,
  // one of them 287 m long. The tess budget (TESS_MAX) was spent depth-first:
  // one corner refined to 6 m, the rest emitted exactly as earcut left it.
  // drape() then lifted that sliver at its three corners only, and the chord
  // between them cut through a rise in the ground — a leaning grass-green
  // wall taller than the player, reported as "co ta zelená čára?". The work
  // queue is a max-heap now: when the budget runs out, what remains is
  // uniformly as fine as the budget could afford, never a monster.
  //
  // The fixture is that field, abstracted: a long jagged strip, far bigger
  // than one budget can fully refine, whose earcut fan is all slivers.
  const ring = [];
  const L = 900, W = 130, TEETH = 6;
  for (let i = 0; i <= TEETH; i++) ring.push([(L / TEETH) * i, i % 2 ? 25 : 0]);
  for (let i = TEETH; i >= 0; i--) ring.push([(L / TEETH) * i, i % 2 ? W : W - 25]);
  const g = chunkWith([], [{ t: 'grass', o: ring }]);
  assert.ok(g, 'nothing built');
  let maxEdge = 0, tris = 0;
  for (const m of g.children) {
    const pos = m.geometry?.attributes?.position, sf = m.geometry?.attributes?.surf;
    if (!pos || !sf) continue;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      if (sf.getX(i) !== SURF.grass) continue;
      let ground = true;
      for (let k = 0; k < 3; k++) if (Math.abs(pos.getY(i + k) - (GROUND + LAYER_Y.green)) > 1e-3) ground = false;
      if (!ground) continue;
      tris++;
      for (let k = 0; k < 3; k++) {
        const a = i + k, b = i + ((k + 1) % 3);
        maxEdge = Math.max(maxEdge, Math.hypot(pos.getX(b) - pos.getX(a), pos.getZ(b) - pos.getZ(a)));
      }
    }
  }
  assert.ok(tris > 1000, `only ${tris} grass triangles — the fixture missed the fill path`);
  assert.ok(maxEdge <= 40,
    `a ${maxEdge.toFixed(0)} m edge survived tessellation — the budget died depth-first again`);
});

test('street furniture stands on the ground, not on twice the ground', () => {
  // Props are placed at terrain.heightAt already, so they are ABSOLUTE and the
  // chunk-wide drape must skip them. Without the fix mark a 7 m lamp mast in
  // Pardubice came out 228 m tall, because the drape added the 221 m ground a
  // second time — the same class of bug that once buried every traffic light.
  const props = [
    { p: [[30, 30]], k: 'lamp', _id: 91, _home: '0,0' },
    { p: [[40, 40]], k: 'bench', _id: 92, _home: '0,0' },
    { p: [[50, 50]], k: 'recycling', _id: 93, _home: '0,0' },
  ];
  const cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [],
    trees: [], furniture: props, calming: [], barriers: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800 };
  const mats = makeMaterials();
  mats.terrain = { res: 20, ready: () => true, heightAt: () => GROUND, missed: false };
  mats.trees = false; mats.facades = false; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  assert.ok(g, 'nothing built');
  let top = -Infinity;
  for (const m of g.children) {
    const pos = m.geometry?.attributes?.position;
    if (!pos || m.isInstancedMesh) continue;
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  }
  // the tallest prop here is the 7 m lamp mast, so nothing may reach 10 m up
  assert.ok(top < GROUND + 10,
    `furniture reaches ${(top - GROUND).toFixed(0)} m above a ${GROUND} m ground`
    + ' — the drape lifted it a second time');
  assert.ok(top > GROUND + 5, `nothing tall was drawn at all (top ${top})`);
});

test('a chunk carrying a power line builds without throwing', () => {
  // A call to islandInto() once sat at the tail of wireSpan(), where the
  // variable it tested does not exist. Every chunk with a transmission line
  // in it threw ReferenceError and stopped building halfway — a whole missing
  // neighbourhood per pylon, and the error only ever showed in the browser.
  const cell = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [], furniture: [], calming: [], barriers: [],
    power: [{ p: [[10, 10], [70, 40], [110, 90]], v: 110, _id: 71, _home: '0,0' }] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, ready: () => true, heightAt: () => GROUND, missed: false };
  mats.trees = false; mats.facades = false; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  assert.ok(g, 'the chunk built nothing at all');
  let top = -Infinity;
  for (const m of g.children) {
    const pos = m.geometry?.attributes?.position;
    if (!pos || m.isInstancedMesh) continue;
    for (let i = 0; i < pos.count; i++) top = Math.max(top, pos.getY(i));
  }
  // a 110 kV pylon is 32 m, so the line has to reach well above the ground
  assert.ok(top > GROUND + 20, `nothing tall was drawn (top ${(top - GROUND).toFixed(1)} m)`);
});
