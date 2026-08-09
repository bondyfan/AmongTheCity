// ---- the square OSM never drew --------------------------------------------
// Náměstí Jana Pernera is thirteen ways and no area at all: five footways on
// sett, three on concrete, two on paving_stones, three concrete service roads
// named after the square. Nothing says the ground BETWEEN them is that same
// paving, so the runtime fell back to its rule for ground nobody mapped — "a
// field" — and grew 13 cm of grass in every gap. Measured on that chunk before
// the fix: 7 % of its ground, in ribbons threaded between the path stamps.
//
// The signal is already in the tiles. A path across a paved square carries
// surface=sett/concrete/paving_stones; a path through a park carries gravel or
// ground or nothing at all. Close the hard-surfaced network and the enclosed
// ground comes with it.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { sealedGrid, sealedRects, isHardWay, _test } = await import('../js/sealed.js');
const { SEAL_RES, N } = _test;

/** A grid of paths 10 m apart across the middle of chunk 0,0, all one surface. */
function web(surface, { x0 = 20, x1 = 100, z0 = 20, z1 = 100, step = 10 } = {}) {
  const roads = [];
  let id = 0;
  for (let x = x0; x <= x1; x += step)
    roads.push({ _id: ++id, t: 'footway', w: 1.8, s: surface, p: [[x, z0], [x, z1]] });
  for (let z = z0; z <= z1; z += step)
    roads.push({ _id: ++id, t: 'footway', w: 1.8, s: surface, p: [[x0, z], [x1, z]] });
  return roads;
}
const cellOf = (o) => ({ roads: [], paved: [], green: [], water: [], buildings: [], ...o });
const at = (g, x, z) => g?.[(((z / SEAL_RES) | 0) * N) + ((x / SEAL_RES) | 0)] === 1;

test('a web of paved footways seals the ground between them', () => {
  const g = sealedGrid(cellOf({ roads: web('paving') }), 0, 0);
  assert.ok(g, 'nothing was sealed at all');
  // dead centre of a 10 m gap, as far from any path as it gets
  assert.ok(at(g, 65, 65), 'the middle of the square is still a field');
});

test('…and sett and concrete count too — a Czech square is rarely asphalt', () => {
  for (const s of ['cobble', 'concrete', 'asphalt']) {
    const g = sealedGrid(cellOf({ roads: web(s) }), 0, 0);
    assert.ok(g && at(g, 65, 65), `surface=${s} sealed nothing`);
  }
});

test('a park keeps its grass however dense the paths', () => {
  // the whole safety of this rests here: the closing must be blind to any
  // surface OSM does not call hard
  for (const s of ['gravel', 'dirt', 'grass', undefined]) {
    const g = sealedGrid(cellOf({ roads: web(s) }), 0, 0);
    assert.equal(g, null, `surface=${s} sealed ground it has no business sealing`);
  }
});

test('one path across a corner seals nothing — a closing needs a network', () => {
  const g = sealedGrid(cellOf({
    roads: [{ _id: 1, t: 'footway', w: 1.8, s: 'paving', p: [[10, 10], [110, 110]] }],
  }), 0, 0);
  assert.equal(g, null, 'a single path grew a square around itself');
});

test('open ground beyond the network is left alone', () => {
  const g = sealedGrid(cellOf({ roads: web('paving', { x0: 20, x1: 60, z0: 20, z1: 60 }) }), 0, 0);
  assert.ok(g, 'the network sealed nothing');
  assert.ok(!at(g, 105, 105), 'the far corner of the chunk was sealed from 45 m away');
});

test('where the map drew a lawn, the lawn wins', () => {
  // The layering hides this while the green fill is drawn — but under the aerial
  // photo it is not drawn, and then the derived paving would be the only thing
  // there. So it comes out of the grid itself, where both readers see it.
  const green = { _id: 99, t: 'grass', o: [[50, 50], [80, 50], [80, 80], [50, 80]] };
  const g = sealedGrid(cellOf({ roads: web('paving'), green: [green] }), 0, 0);
  assert.ok(g, 'nothing sealed');
  assert.ok(!at(g, 65, 65), 'paving was inferred straight over a mapped lawn');
  assert.ok(at(g, 30, 30), 'the rest of the square lost its paving too');
});

test('a building footprint is not a floor', () => {
  const b = { _id: 98, o: [[50, 50], [80, 50], [80, 80], [50, 80]] };
  const g = sealedGrid(cellOf({ roads: web('paving'), buildings: [b] }), 0, 0);
  assert.ok(!at(g, 65, 65), 'paving was laid through the inside of a building');
});

test('the rectangles cover the same ground as the grid, and merge', () => {
  const cell = cellOf({ roads: web('paving') });
  const g = sealedGrid(cell, 0, 0);
  const rects = sealedRects(cell, 0, 0);
  assert.ok(rects.length > 0, 'no rectangles');
  assert.ok(rects.length < 400, `${rects.length} rectangles — they are not merging at all`);
  // every rect is inside the chunk and non-degenerate
  for (const r of rects) {
    assert.ok(r.x1 > r.x0 && r.z1 > r.z0, 'a zero-area rectangle');
    assert.ok(r.x0 >= 0 && r.x1 <= 120 && r.z0 >= 0 && r.z1 <= 120,
      `rectangle ${JSON.stringify(r)} escapes the chunk`);
  }
  // and they agree with the grid at the centre of the square
  const covers = (x, z) => rects.some((r) => x >= r.x0 && x < r.x1 && z >= r.z0 && z < r.z1);
  assert.equal(covers(65, 65), at(g, 65, 65), 'rects and grid disagree');
});

test('a cell somebody else already surfaces is ceded, not double-plated', () => {
  const cell = cellOf({ roads: web('paving') });
  const all = sealedRects(cell, 0, 0);
  const some = sealedRects(cell, 0, 0, (x, z) => x > 60);
  const area = (rs) => rs.reduce((a, r) => a + (r.x1 - r.x0) * (r.z1 - r.z0), 0);
  assert.ok(area(some) < area(all) * 0.75,
    'the skip predicate did not remove the ground it was asked to');
  for (const r of some)
    assert.ok(r.x0 < 62, `a rectangle at x=${r.x0} survived a skip covering x > 60`);
});

test('isHardWay is the whole gate, and it is conservative', () => {
  assert.ok(isHardWay({ s: 'asphalt' }) && isHardWay({ s: 'cobble' }));
  for (const s of ['gravel', 'dirt', 'grass', null, undefined])
    assert.ok(!isHardWay({ s }), `${s} counted as a hard surface`);
  assert.ok(!isHardWay(null) && !isHardWay(undefined));
});

// ---- the hillside that must NOT be a square --------------------------------
// Jinonice: a 35 % bank laced with footways and staircases grew paving tiles
// leaning off the terrain ("kachličky na křivo nad terénem"). Three separate
// mistakes fed it, each pinned below: stairs counted as seeds, no cell cared
// how steep it stood, and the plate was clamped against a kerb-only corridor
// while the ground under it was benched over a far wider one.

test('stairs do not seed sealing — a staircase climbs a bank', () => {
  const steps = web('paving').map((r) => ({ ...r, t: 'steps' }));
  assert.equal(sealedGrid(cellOf({ roads: steps }), 0, 0), null,
    'a web of staircases tiled the bank they climb');
});

test('ground too steep to be a square falls out, cell by cell', () => {
  // flat until z=60, then a 40 % bank — Pernera measures 0.031 max, the
  // Jinonice bank 0.19 median, so 0.15 separates them with real margin
  const tilt = { heightAt: (x, z) => 200 + Math.max(0, z - 60) * 0.4, ready: () => true };
  const g = sealedGrid(cellOf({ roads: web('paving') }), 0, 0, tilt);
  assert.ok(g, 'the gate threw the flat half away too');
  assert.ok(at(g, 65, 40), 'the flat half of the square was lost');
  assert.ok(!at(g, 65, 90), 'a 40 % bank got tiled');
});

test('a plate beside a road cut lies on the bench, not on the raw hillside', async () => {
  // A plateau at 228 m dropping to lowland at 222, a street in the lowland,
  // and a paved web crossing it. The chunk ground inside the street's corridor
  // is benched to the deck; the plate over the same cells must be too —
  // clamped against a kerb-only list it kept raw plateau height and stood
  // 4 m proud, which in Jinonice measured as 18 % of the paving floating,
  // 2.22 m worst.
  const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
  const terrain = { res: 20, tile: 4800, missed: false, ready: () => true,
    heightAt: (x, z) => (z < 55 ? 228 : 222) };
  const roads = [{ _id: 1, _home: '0,0', t: 'residential', w: 9, d: 1, v: 30,
    p: [[5, 64], [115, 64]] }];
  let id = 1;
  for (let x = 20; x <= 100; x += 10)
    roads.push({ _id: ++id, _home: '0,0', t: 'footway', w: 1.8, s: 'paving', d: 0,
      p: [[x, 10], [x, 100]] });
  for (let z = 10; z <= 100; z += 10)
    roads.push({ _id: ++id, _home: '0,0', t: 'footway', w: 1.8, s: 'paving', d: 0,
      p: [[20, z], [100, z]] });
  const cell = { buildings: [], roads, rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = terrain;
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  // the probe strip: sealed plateau cells inside the street's corridor bench,
  // between two web lines so no footway ribbon reaches into it
  let worst = -Infinity, n = 0;
  for (const c of g?.children ?? []) {
    const p = c.geometry?.attributes?.position;
    if (!p) continue;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i) + g.position.x, y = p.getY(i) + g.position.y, z = p.getZ(i) + g.position.z;
      if (x > 63 && x < 67 && z > 51.8 && z < 54) { n++; if (y > worst) worst = y; }
    }
  }
  assert.ok(n > 0, 'the probe strip holds no geometry at all — fixture broke');
  // bench cap there: deck 222 + rise over the flare ≈ 223.8; raw plateau is 228
  assert.ok(worst < 225,
    `geometry in the corridor bench stands at ${worst.toFixed(2)} m — the plate `
    + 'is on the raw hillside, leaning off a 4 m cut');
});
