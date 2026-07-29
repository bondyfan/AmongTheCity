// ---- what the ground says when it does not know ----
// Terrain.heightAt used to answer 0 for any tile whose height map had not
// arrived, and 0 is not a missing value in this world — it is a place, four
// hundred metres below the country. Every consumer took it literally:
//
//   · a park or forest polygon is drawn WHOLE from its home chunk, so one that
//     reaches across the boundary got half its vertices on the hillside and
//     half at sea level. The triangles between them are a sheer wall of
//     stretched photograph hundreds of metres tall — the "jiná dimenze" wall.
//   · and nothing ever repaired it, because "was the ground known?" was asked
//     of the chunk's own CENTRE. A chunk whose centre was fine but whose
//     geometry reached into nothing kept its guess for the rest of the session.
//
// Both halves are tested here: the fallback that stops the cliff forming, and
// the flag that gets the chunk rebuilt once the truth arrives.

import test from 'node:test';
import assert from 'node:assert';

const { Terrain } = await import('../js/terrain.js');

const TILE = 4800, RES = 20;

/** A terrain with one tile filled in at a constant height. */
function withTile(tx, tz, metres) {
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n).fill(Math.round(metres * 10));
  t.grids.set(tx + ',' + tz, g);
  return t;
}

test('known ground is returned exactly', () => {
  const t = withTile(0, 0, 221.4);
  assert.ok(Math.abs(t.heightAt(2400, 2400) - 221.4) < 1e-6);
  assert.equal(t.ready(2400, 2400), true);
});

test('unknown ground answers with the nearest known ground, not sea level', () => {
  const t = withTile(0, 0, 221.4);
  // one tile east: no height map at all
  const x = TILE + 100, z = 2400;
  assert.equal(t.ready(x, z), false, 'the fixture is wrong — that tile is loaded');
  const h = t.heightAt(x, z);
  assert.ok(Math.abs(h - 221.4) < 1e-6,
    `unknown ground answered ${h} — a ${Math.abs(h - 221.4).toFixed(0)} m cliff`);
});

test('a polygon straddling the boundary cannot build a wall', () => {
  // Walk 400 m across the seam, which is what a forest fill's vertices do, and
  // check the ground never steps. 20 m is the sample spacing; a real cliff
  // cannot be steeper than the height map can express.
  const t = withTile(0, 0, 221.4);
  let worst = 0, prev = t.heightAt(TILE - 200, 2400);
  for (let x = TILE - 200; x <= TILE + 200; x += 10) {
    const h = t.heightAt(x, 2400);
    worst = Math.max(worst, Math.abs(h - prev));
    prev = h;
  }
  assert.ok(worst < 0.01, `the ground stepped ${worst.toFixed(1)} m crossing the seam`);
});

test('asking about unknown ground raises `missed`, and only then', () => {
  const t = withTile(0, 0, 221.4);
  t.missed = false;
  t.heightAt(2400, 2400);
  assert.equal(t.missed, false, 'known ground reported itself as a guess');
  t.heightAt(TILE + 100, 2400);
  assert.equal(t.missed, true, 'a guess went unreported — the chunk never rebuilds');
});

test('with nothing loaded at all the world is flat, not a hole', () => {
  const t = new Terrain(TILE, RES);
  assert.equal(t.heightAt(2400, 2400), 0);
  assert.equal(t.missed, true);
});

test('a height map arriving makes the fallback answer better', () => {
  const t = withTile(0, 0, 221.4);
  const x = TILE + 100, z = 2400;
  assert.ok(Math.abs(t.heightAt(x, z) - 221.4) < 1e-6);
  // …now the real tile lands, 90 m higher. The memo must not hold the old one.
  t.grids.set('1,0', new Int16Array(t.n * t.n).fill(3114));
  t._nearMemo?.clear();
  assert.ok(Math.abs(t.heightAt(x, z) - 311.4) < 1e-6,
    'the nearest-known memo went stale and outlived the data');
});

test('the fallback gives up past two tiles rather than inventing a country', () => {
  const t = withTile(0, 0, 221.4);
  // four tiles away is 19 km — nothing there is evidence about anything here
  assert.equal(t.heightAt(TILE * 4 + 100, 2400), 0);
});

test('NoData corners fall back to their neighbours, not to −3276 m', () => {
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n).fill(2214);
  g[0] = -32768;                                  // one bad sample at the origin
  t.grids.set('0,0', g);
  const h = t.heightAt(5, 5);
  assert.ok(Math.abs(h - 221.4) < 1e-6, `NoData dragged the quad to ${h}`);
});

// ---------------------------------------------------------------------------
// the ground you sample must be the ground that is drawn
// ---------------------------------------------------------------------------

test('heightAt returns the triangle the renderer draws, not a bilinear patch', () => {
  // A cell whose corners TWIST — high on one diagonal, low on the other. This
  // is where bilinear interpolation and a triangulated quad part company, and
  // it is why the aerial photograph used to cover the tarmac: the road was laid
  // 20 cm above the bilinear answer while the renderer drew the ground higher
  // still. Measured over a real tile before the fix: up to 1.82 m of daylight,
  // exceeding LAYER_Y.road across 0.82 % of the ground.
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n);
  const at = (i, j) => j * t.n + i;
  g[at(0, 0)] = 100; g[at(1, 0)] = 0;      // decimetres
  g[at(0, 1)] = 0;   g[at(1, 1)] = 100;    // a saddle: twist = 200 dm = 20 m
  t.grids.set('0,0', g);

  // The cell's own diagonal runs from (0,0) to (1,1) in sample space; the mesh
  // splits it the OTHER way, on fx + fz = 1. A point ON that split line is
  // shared by both triangles, so both readings must agree there.
  const P = (u, v) => t.heightAt(u * RES, v * RES);
  assert.ok(Math.abs(P(0.5, 0.5) - 0) < 1e-6,
    `the split edge should read 0 m, got ${P(0.5, 0.5)}`);
  // …and bilinear would have said 5 m there (the average of 10, 0, 0, 10).
  assert.notEqual(Math.round(P(0.5, 0.5)), 5);

  // inside the h00 triangle, the plane through (10, 0, 0)
  assert.ok(Math.abs(P(0.25, 0.25) - 5) < 1e-6, `got ${P(0.25, 0.25)}`);
  // inside the h11 triangle, the plane through (0, 0, 10)
  assert.ok(Math.abs(P(0.75, 0.75) - 5) < 1e-6, `got ${P(0.75, 0.75)}`);
  // the corners are still exactly themselves
  assert.equal(P(0, 0), 10);
  assert.equal(P(1, 1), 10);
  assert.equal(P(1, 0), 0);
  assert.equal(P(0, 1), 0);
});

test('the ground is PLANAR inside a triangle, which is what roads rely on', () => {
  // meshes.js cuts a road at every line the ground bends on — the two cell
  // edges and the diagonal — so each piece lies inside one triangle. That only
  // buys anything if the ground really is a plane in there: if heightAt curved
  // at all, a straight ribbon across it would still cut in.
  //
  // Measured with that resampler over the Zlín height map: 0 breakthroughs in
  // 2 178 974 samples, worst case −0.1995 m — the road sitting exactly its own
  // 20 cm above the ground everywhere. With a uniform 10 m step instead it
  // broke through at 0.90 % of points, by up to 1.32 m.
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) {
    for (let i = 0; i < t.n; i++) g[j * t.n + i] = Math.round(90 * Math.sin(i * 0.7 + j * 1.3));
  }
  t.grids.set('0,0', g);

  let worst = 0;
  for (let k = 0; k < 5000; k++) {
    // three points inside ONE triangle: pick a cell, a half, and barycentrics
    const i = 1 + ((Math.random() * 8) | 0), j = 1 + ((Math.random() * 8) | 0);
    const lower = Math.random() < 0.5;
    const pt = () => {
      let a = Math.random(), b = Math.random();
      if (a + b > 1) { a = 1 - a; b = 1 - b; }          // uniform in the triangle
      const fx = lower ? a : 1 - a, fz = lower ? b : 1 - b;
      return [(i + fx) * RES, (j + fz) * RES];
    };
    const P = [pt(), pt(), pt()];
    const h = P.map(([x, z]) => t.heightAt(x, z));
    // the midpoint of two of them must be the average of their heights — the
    // definition of planar, and false for a bilinear patch
    const mid = [(P[0][0] + P[1][0]) / 2, (P[0][1] + P[1][1]) / 2];
    worst = Math.max(worst, Math.abs(t.heightAt(mid[0], mid[1]) - (h[0] + h[1]) / 2));
  }
  assert.ok(worst < 1e-6, `the ground bends inside a triangle by ${worst.toFixed(4)} m`);
});
