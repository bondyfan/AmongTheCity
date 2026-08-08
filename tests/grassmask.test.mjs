// ---- the grass mask: rasterise once, look up for ever ----------------------
// The first grass asked, per candidate tuft, "is there a road within half its
// width, a car park, a building, water, a green polygon?" — hundreds of tests
// each, thousands of candidates, inside one frame. That is the stutter the user
// felt when walking. It is also the wrong shape of question: a road is a long
// thin thing and a candidate is a point, so asking every point about every road
// costs O(points × roads) when the answer only varies over the ground the road
// actually covers.
//
// So it is rasterised instead, once per chunk, into a byte of grass height per
// square metre. These tests are about that raster being RIGHT — a wrong mask is
// grass growing through the tarmac, which is worse than no grass at all.

import test from 'node:test';
import assert from 'node:assert';

const { GrassMask, _test } = await import('../js/grassmask.js');
const { UNMAPPED, MOWN, MEADOW } = _test;
const CHUNK = 120;

/** A city with one chunk's worth of features, indexed the way geo.js does it. */
function cityOf(cell) {
  const full = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [], ...cell };
  return { chunkIndex: new Map([['0,0', full]]) };
}

test('ground nobody mapped is a field, because that is what it renders as', () => {
  const m = new GrassMask(cityOf({}));
  assert.equal(m.heightAt(60, 60), -1, 'an unbuilt chunk must answer "unknown", not "bare"');
  // …and asking is what queued it
  m.step(50);
  assert.equal(m.heightAt(60, 60), UNMAPPED);
});

test('a road clears a corridor as wide as the road', () => {
  const m = new GrassMask(cityOf({
    roads: [{ t: 'primary', w: 8, p: [[0, 60], [120, 60]] }],
  }));
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(60, 60), 0, 'grass grew down the middle of a carriageway');
  assert.equal(m.heightAt(60, 63), 0, 'grass grew in the near lane');
  // …and stops. 8 m wide is 4 m of half-width plus 0.6 of kerb: at 6 m out the
  // verge is verge again.
  assert.ok(m.heightAt(60, 67) > 0, 'the road ate the verge six metres away');
});

test('a car park, a building and a river are all bare', () => {
  const sq = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
  const m = new GrassMask(cityOf({
    paved: [{ t: 'parking', o: sq(10, 10, 20) }],
    buildings: [{ o: sq(50, 10, 20) }],
    water: [{ o: sq(90, 10, 20) }],
  }));
  m.request('0,0'); m.step(50);
  for (const [x, what] of [[20, 'a car park'], [60, 'a building'], [100, 'a river']])
    assert.equal(m.heightAt(x, 20), 0, `grass grew on ${what}`);
  assert.ok(m.heightAt(35, 20) > 0, 'the gap between them lost its grass too');
});

test('no beats yes — a park drawn over its own path keeps the path bare', () => {
  // This is the case that decided the order: OSM routinely draws a park polygon
  // straight over the footway running through it, and a tuft standing in the
  // paving is worse than a bare verge.
  const m = new GrassMask(cityOf({
    green: [{ t: 'park', o: [[0, 0], [120, 0], [120, 120], [0, 120]] }],
    roads: [{ t: 'footway', w: 3, p: [[0, 60], [120, 60]] }],
  }));
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(60, 60), 0, 'the park grew grass over its own footpath');
  assert.equal(m.heightAt(60, 20), MOWN, 'the park itself lost its grass');
});

test('a meadow is taller than a lawn, and a pitch has none', () => {
  const ring = (z0) => [[0, z0], [120, z0], [120, z0 + 30], [0, z0 + 30]];
  const m = new GrassMask(cityOf({
    green: [
      { t: 'meadow', o: ring(0) },
      { t: 'grass', o: ring(40) },
      { t: 'pitch', o: ring(80) },
    ],
  }));
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(60, 15), MEADOW);
  assert.equal(m.heightAt(60, 55), MOWN);
  assert.equal(m.heightAt(60, 95), 0, 'a football pitch is mown to the ground');
});

test('a hole in a green polygon is a hole', () => {
  const m = new GrassMask(cityOf({
    green: [{
      t: 'park',
      o: [[0, 0], [120, 0], [120, 120], [0, 120]],
      i: [[[40, 40], [80, 40], [80, 80], [40, 80]]],
    }],
  }));
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(60, 60), UNMAPPED, 'the courtyard inside the park was planted');
  assert.equal(m.heightAt(20, 60), MOWN);
});

test('a feature straddling the border stamps only its own side', () => {
  // Chunks are built independently and a polygon is drawn WHOLE from its home
  // chunk, so a rasteriser that ran off the end of its own grid would corrupt
  // whichever chunk's array happened to follow it in memory.
  const m = new GrassMask(cityOf({
    paved: [{ t: 'parking', o: [[-50, -50], [30, -50], [30, 30], [-50, 30]] }],
  }));
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(10, 10), 0, 'the part inside this chunk was not stamped');
  assert.equal(m.heightAt(60, 60), UNMAPPED, 'the stamp leaked past the polygon');
});

test('a chunk outside the mapped world grows nothing', () => {
  const m = new GrassMask({ chunkIndex: new Map() });
  m.request('0,0'); m.step(50);
  assert.equal(m.heightAt(60, 60), 0);
});

// ---- and the square nobody drew -------------------------------------------
// The mask's rule for ground no polygon covers is "a field", which is right in
// open country and wrong in the middle of a town square. Náměstí Jana Pernera
// is thirteen ways and no area, so 7 % of that chunk grew 13 cm of grass in the
// gaps between its paths. sealed.js closes the hard-surfaced network; this is
// the mask agreeing to it — and refusing to let it overrule a mapped lawn.
const webOf = (surface) => {
  const roads = [];
  for (let x = 20; x <= 100; x += 10)
    roads.push({ t: 'footway', w: 1.8, s: surface, p: [[x, 20], [x, 100]] });
  for (let z = 20; z <= 100; z += 10)
    roads.push({ t: 'footway', w: 1.8, s: surface, p: [[20, z], [100, z]] });
  return roads;
};

test('no grass grows between the paths of a paved square', () => {
  const m = new GrassMask(cityOf({ roads: webOf('paving') }));
  m.request('0,0'); m.step(60000);
  assert.equal(m.heightAt(65, 65), 0,
    'the middle of a paved square is still growing a field');
});

test('…but a park with gravel paths is still a park', () => {
  const m = new GrassMask(cityOf({ roads: webOf('gravel') }));
  m.request('0,0'); m.step(60000);
  assert.ok(m.heightAt(65, 65) > 0,
    'gravel paths through a park mowed the whole park to bare ground');
});

test('a mapped lawn inside a square keeps its grass', () => {
  const m = new GrassMask(cityOf({
    roads: webOf('paving'),
    green: [{ t: 'grass', o: [[50, 50], [80, 50], [80, 80], [50, 80]] }],
  }));
  m.request('0,0'); m.step(60000);
  assert.ok(m.heightAt(65, 65) > 0, 'the derived paving overruled a mapped lawn');
  assert.equal(m.heightAt(30, 30), 0, 'the rest of the square kept its grass');
});
