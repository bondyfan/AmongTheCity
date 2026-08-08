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
