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
