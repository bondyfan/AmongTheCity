// ---- earthworks that are not roads, underpasses, and grades without folds ----
// Wave 7. Three promises, each pinned here on a fixture small enough to reason
// about (the real Pardubice numbers are in the work report: every drivable
// bridge in the four city tiles, grade change per metre along the deck and
// 25 m of each approach, worst 289 %/m before and 24 %/m after):
//   · a terrain STAMP (js/terrainstamps.js) shapes the ground at full
//     resolution, by its rule ('dig' never lifts, 'raise' never lowers), with
//     a hard edge where the profile jumps and the ground kept along a hole;
//     and every Terrain carries the same stamps, the worker's included;
//   · a street under a RAILWAY dips under it (js/underpass.js), on one smooth
//     line, and the railway keeps its level;
//   · a deck meets its approach without a step or a fold.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { makeStamp, applyStamp, STAMPS } = await import('../js/terrainstamps.js');
const { Terrain } = await import('../js/terrain.js');
const { VALY, VALY_FLOOR } = await import('../js/valyring.js');
const geo = await import('../js/geo.js');

// a 40 m square ring, wound either way round
const SQ = [[0, 0], [40, 0], [40, 40], [0, 40]];

test('a dug stamp lowers the ground outside its ring to the floor, and only there', () => {
  for (const pts of [SQ, [...SQ].reverse()]) {
    const st = makeStamp({ pts, closed: true, base: 10, mode: 'dig',
      prof: [[-0.001, 0, 0], [0, 0, 1], [6, 0, 1], [12, 0, 0]] });
    // inside the ring: untouched, however the ring winds
    assert.equal(applyStamp(st, 20, 20, 15), 15);
    assert.equal(applyStamp(st, 1, 20, 15), 15, 'the inside of the wall was dug');
    // just outside, and across the flat band: the floor
    assert.equal(applyStamp(st, -0.5, 20, 15), 10);
    assert.equal(applyStamp(st, -5, 20, 15), 10);
    assert.equal(applyStamp(st, 20, 45, 15), 10);
    // outside a corner (the pseudo-normal): outside on both faces
    assert.equal(applyStamp(st, -3, -3, 15), 10);
    // back up to the survey over the falloff, monotone
    let prev = 10;
    for (let d = 6; d <= 13; d += 0.5) {
      const y = applyStamp(st, -d, 20, 15);
      assert.ok(y >= prev - 1e-9, `the falloff went backwards at ${d} m`);
      prev = y;
    }
    assert.equal(applyStamp(st, -13, 20, 15), 15);
    // 'dig' never lifts ground already under its floor
    assert.equal(applyStamp(st, -3, 20, 8), 8);
  }
});

test('a raise never lowers, a set does both, and a hole keeps the ground', () => {
  const raise = makeStamp({ pts: [[0, 0], [100, 0]], base: [20, 30], mode: 'raise',
    prof: [[-6, 0, 0], [-2, 0, 1], [2, 0, 1], [6, 0, 0]] });
  assert.equal(applyStamp(raise, 50, 0, 10), 25, 'the base is interpolated along the line');
  assert.equal(applyStamp(raise, 50, 0, 40), 40, 'a raise lowered the ground');
  const set = makeStamp({ pts: [[0, 0], [100, 0]], base: 20, mode: 'set',
    prof: [[-6, 0, 0], [-2, 0, 1], [2, 0, 1], [6, 0, 0]],
    holes: [{ pts: [[50, -20], [50, 20]], hw: 3, fall: 2 }] });
  assert.equal(applyStamp(set, 20, 1, 40), 20);
  assert.equal(applyStamp(set, 20, 1, 5), 20);
  assert.equal(applyStamp(set, 50, 0, 40), 40, 'the hole did not keep the causeway');
  const half = applyStamp(set, 54, 0, 40);
  assert.ok(half < 40 && half > 20, 'the hole has no falloff');
});

test('every Terrain carries the world stamps, and the chateau moat is dug on the main thread and in the worker alike', () => {
  // the worker builds its own Terrain from the same grids (chunkspec.applySpec)
  const a = new Terrain(4800, 20), b = new Terrain(4800, 20);
  assert.strictEqual(a.stamps, STAMPS);
  const flat = new Int16Array(a.n * a.n).fill(2200);
  a.grids.set('0,-1', flat); b.grids.set('0,-1', flat.slice());
  // a point 4 m outside the foot wall: on the moat floor; 3 m inside: up on the berm
  const [p, q] = [VALY[0], VALY[1]];
  const ex = q[0] - p[0], ez = q[1] - p[1], L = Math.hypot(ex, ez);
  const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
  let nx = -ez / L, nz = ex / L;
  // (outward is away from the ring's middle)
  const cx = VALY.reduce((s, v) => s + v[0], 0) / VALY.length, cz = VALY.reduce((s, v) => s + v[1], 0) / VALY.length;
  if ((mx - cx) * nx + (mz - cz) * nz < 0) { nx = -nx; nz = -nz; }
  const floor = (VALY_FLOOR[0] + VALY_FLOOR[1]) / 2;
  const out = a.heightAt(mx + nx * 4, mz + nz * 4), inn = a.heightAt(mx - nx * 1, mz - nz * 1);
  assert.ok(Math.abs(out - floor) < 0.3, `moat floor ${out.toFixed(2)} against ${floor.toFixed(2)}`);
  assert.ok(inn - out > 4, `the wall stands in a moat ${(inn - out).toFixed(2)} m deep`);
  // same answer from the second Terrain, the worker's
  for (const d of [-12, -3, -1, 2, 6, 15]) {
    const x = mx + nx * d, z = mz + nz * d;
    assert.equal(b.heightAt(x, z), a.heightAt(x, z));
  }
  // and far from any stamp the grid is the answer
  assert.equal(a.heightAt(300, -300), 220);
  assert.equal(a.stampDelta(300, -300), 0);
});

// ---- a street under a railway ---------------------------------------------------
function terrainFlat(h = 220) {
  const t = new Terrain(4800, 20);
  t.grids.set('0,0', new Int16Array(t.n * t.n).fill(h * 10));
  t._loads = 1;
  return t;
}
async function cityFrom(data) {
  globalThis.fetch = async () => ({ ok: true, json: async () => data });
  return geo.loadCity('fixture.json');
}

test('a street crossing under a railway bridge dips under it on one smooth line, and the railway stays level', async () => {
  geo.JUNCTIONS.clear(); geo.CLUSTERS.clear();
  // a street running south in two ways (OSM split it), under a three-track railway
  // whose middle piece is the bridge
  const city = await cityFrom({
    roads: [
      { t: 'secondary', w: 8, d: 1, v: 50, p: [[500, 200], [500, 500]] },
      { t: 'secondary', w: 8, d: 1, v: 50, p: [[500, 500], [500, 800]] },
    ],
    rails: [
      { t: 'rail', p: [[200, 510], [490, 510]] },
      { t: 'rail', br: 1, p: [[490, 510], [510, 510]] },
      { t: 'rail', p: [[510, 510], [800, 510]] },
    ],
  });
  const terrain = terrainFlat();
  const [a, b] = city.roads;
  assert.ok(a._dipChain && a._dipChain === b._dipChain, 'the two ways of the street are not one dip');
  const bridge = city.rails.find((r) => r.br);
  const deck = geo.bridgeDeckHeight(bridge, 10, terrain);
  // the railway keeps its bed's level over the street (no hump)
  for (let d = 0; d <= 20; d += 2) assert.ok(Math.abs(geo.bridgeDeckHeight(bridge, d, terrain) - deck) < 0.06, `the deck humps at ${d} m`);
  assert.ok(Math.abs(deck - geo.roadGradeY(city.rails[0], 290, terrain)) < 0.1, 'the deck left its bed');
  // the street under it: headroom (4.5 m) and the deck's depth under the deck
  const yb = geo.roadGradeY(b, 10, terrain);
  assert.ok(deck - yb >= 5.7, `only ${(deck - yb).toFixed(2)} m from street to deck`);
  // one line along both ways: equal at their shared node, no fold anywhere
  assert.ok(Math.abs(geo.roadGradeY(a, 300, terrain) - geo.roadGradeY(b, 0, terrain)) < 0.01, 'a step between the two ways');
  const y = [];
  for (let s = 0; s <= 600; s += 1) y.push(s < 300 ? geo.roadGradeY(a, s, terrain) : geo.roadGradeY(b, s - 300, terrain));
  let worstGrade = 0, worstBend = 0;
  for (let i = 1; i < y.length - 1; i++) {
    worstGrade = Math.max(worstGrade, Math.abs(y[i + 1] - y[i]));
    worstBend = Math.max(worstBend, Math.abs(y[i + 1] - 2 * y[i] + y[i - 1]));
  }
  assert.ok(worstGrade <= 0.08, `the ramp is a ${(worstGrade * 100).toFixed(1)} % climb`);
  assert.ok(worstBend <= 0.01, `the grade folds by ${(worstBend * 100).toFixed(2)} % in a metre`);
  // and far from the railway the street is the street it was
  assert.ok(Math.abs(geo.roadGradeY(a, 5, terrain) - 220) < 0.3);
});

test('a road bridge leaves its approach on the approach’s own grade: no step, no fold', async () => {
  geo.JUNCTIONS.clear(); geo.CLUSTERS.clear();
  // a 14 m span between banks 0.9 m apart, the case that came down 18 % in its last 5 m
  const terrain = { ready: () => true, _loads: 1,
    heightAt: (x) => (x < 100 ? 219.7 + (x - 100) * 0.01 : x > 114 ? 218.8 - (x - 114) * 0.01 : 214) };
  const city = await cityFrom({ roads: [
    { t: 'tertiary', w: 7, d: 1, v: 50, p: [[0, 50], [100, 50]] },
    { t: 'tertiary', w: 7, d: 1, v: 50, br: 1, p: [[100, 50], [114, 50]] },
    { t: 'tertiary', w: 7, d: 1, v: 50, p: [[114, 50], [214, 50]] },
  ] });
  const [w0, br, w1] = city.roads;
  const at = (x) => (x < 100 ? geo.roadGradeY(w0, x, terrain) : x <= 114 ? geo.bridgeDeckHeight(br, x - 100, terrain) : geo.roadGradeY(w1, x - 114, terrain));
  let worstStep = 0, worstBend = 0;
  for (let x = 80; x <= 134; x += 0.5) {
    worstStep = Math.max(worstStep, Math.abs(at(x + 0.5) - at(x)));
    worstBend = Math.max(worstBend, Math.abs(at(x + 0.5) - 2 * at(x) + at(x - 0.5)) / 0.25);
  }
  assert.ok(worstStep < 0.06, `a ${(worstStep * 100).toFixed(1)} cm step in half a metre`);
  assert.ok(worstBend < 0.06, `the grade changes ${(worstBend * 100).toFixed(1)} % per metre`);
});

test('a returning tile finds crossings with neighbours loaded while its ways were absent', async (t) => {
  const files = {
    manifest: { tile: 4800, tiles: [{ tx: 0, tz: 0, f: 'road' }, { tx: 1, tz: 0, f: 'rail' }] },
    road: { roads: [{ t: 'secondary', w: 8, d: 1, p: [[4700, 2000], [4900, 2000]] }] },
    rail: { rails: [{ t: 'rail', p: [[4850, 1900], [4850, 2100]] }] },
  };
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: () => structuredClone(files[url]) }));
  for (const first of [0, 1]) {
    const city = await geo.loadCity('manifest');
    const views = [100, 9500];
    const owner = city.manifestTiles[first];
    await city.ensureTiles(views[first], 2000);
    // The tile retains its graph objects while its spatial index is empty.
    for (let i = 0; i < 4 && owner.state !== 0; i++) {
      await city.ensureTiles(30000, 2000);
      while (city.releasing) await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(owner.kept);
    await city.ensureTiles(views[1 - first], 2000);
    assert.equal(owner.state, 0);
    await city.ensureTiles(4800, 2000);
    const [road] = city.roads, [rail] = city.rails;
    const pins = road._pins?.filter(p => p.node._xing === rail) ?? [];
    assert.equal(pins.length, 1, 'missing crossing when the ' + owner.f + ' returns');
    assert.equal(pins[0].s, 150);
    const terrain = { heightAt: (_x, z) => 220 + 4 * Math.exp(-((z - 2000) ** 2) / 20) };
    const asphalt = geo.roadGradeY(road, 150, terrain) + 0.20;
    const track = geo.railGradeY(rail, 100, terrain) + 0.14;
    assert.ok(Math.abs(asphalt - track) < 0.001, 'road and track do not meet');
  }
});

test('a surveyed crossing waits for its railway corridor to finish streaming', async () => {
  const city = await cityFrom({
    roads: [{ t: 'secondary', w: 8, d: 1, p: [[4500, 1000], [4500, 1100]] }],
    rails: [{ t: 'rail', p: [[4300, 1050], [4600, 1050]] }],
  });
  const neighbour = { tx: 1, tz: 0, state: 1 };
  city.tile = 4800;
  city.manifestTiles = [neighbour];
  geo.setStreetCity(city);
  const terrain = terrainFlat();
  const road = city.roads[0], count = geo.INDEX_STATS.tiles;
  try {
    const first = geo.roadProfile(road, terrain);
    assert.ok(first.crossingStations.length);
    assert.equal(first.ready, false);
    neighbour.state = 2;
    geo.INDEX_STATS.tiles++;
    const final = geo.roadProfile(road, terrain);
    assert.notStrictEqual(final, first);
    assert.equal(final.ready, true);
  } finally {
    geo.INDEX_STATS.tiles = count;
    geo.setStreetCity(null);
  }
});
