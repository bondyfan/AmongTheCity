// A BRANCHED BRIDGE (decks joined to decks out over the water, as Jiráskův and
// Hlávkův most are pieced in OSM) holds one level at each joint, a level that
// is the same for every member meeting there, that runs on a straight grade
// between the banks, and that does not depend on which of its tiles arrived
// first (co-op clients stream tiles in any order; js/underpass.js).
import { test } from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { CHUNK } = await import('../js/config.js');
const { Terrain } = await import('../js/terrain.js');
const geo = await import('../js/geo.js');
const { stitchStructures } = await import('../js/underpass.js');

// a river valley 10 m deep between x 110 and 330, its banks rising 3 m per
// 100 m eastward (tile 0,0; the bridges run along z 100 to 200)
function slopeTerrain() {
  const t = new Terrain(4800, 20);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) for (let i = 0; i < t.n; i++) {
    const x = i * 20;
    g[j * t.n + i] = 2000 + Math.round(x * 0.3) - (x > 110 && x < 330 ? 100 : 0);
  }
  t.grids.set('0,0', g);
  t._loads = 1;
  return t;
}

const deck = (p, extra = {}) => ({ p, t: 'secondary', w: 8, d: 1, br: 1, l: 1, ...extra });
const road = (p) => ({ p, t: 'secondary', w: 8, d: 1 });
// West bank road, four deck members with a mid-river joint where a third deck
// branches off north, and the east bank road. The tile edge (x 250) cuts the
// structure: members D3, D4 and the east road come in the second tile.
function world() {
  const W = road([[40, 200], [100, 200]]);
  const D1 = deck([[100, 200], [160, 200]]);
  const D2 = deck([[160, 200], [220, 200]]);
  const B = deck([[160, 200], [160, 140]]);
  const BR = road([[160, 140], [160, 100]]);
  const D3 = deck([[220, 200], [280, 200]]);
  const D4 = deck([[280, 200], [340, 200]]);
  const E = road([[340, 200], [400, 200]]);
  return { tiles: [[W, D1, D2, B, BR], [D3, D4, E]], decks: [D1, D2, B, D3, D4] };
}

function load(city, roads) {
  for (const r of roads) r._len = geo.polylineLength(r.p);
  geo.indexJunctions(roads);
  for (const r of roads) {
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of r.p) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    for (let cx = Math.floor(x0 / CHUNK); cx <= Math.floor(x1 / CHUNK); cx++)
      for (let cz = Math.floor(z0 / CHUNK); cz <= Math.floor(z1 / CHUNK); cz++) {
        const k = cx + ',' + cz;
        if (!city.chunkIndex.has(k)) city.chunkIndex.set(k, { roads: [], rails: [] });
        city.chunkIndex.get(k).roads.push(r);
      }
    city.roads.push(r);
  }
  stitchStructures(city, roads, []);
}

function decksAfter(order) {
  const t = slopeTerrain();
  const w = world();
  const city = { chunkIndex: new Map(), roads: [] };
  for (const i of order) load(city, w.tiles[i]);
  const ys = [];
  for (const d of w.decks) for (let s = 0; s <= d._len; s += 5) ys.push(geo.bridgeDeckHeight(d, s, t));
  return { ys, w, t };
}

test('a branched bridge comes out the same whichever of its tiles arrives first', () => {
  const a = decksAfter([0, 1]).ys, b = decksAfter([1, 0]).ys;
  assert.strictEqual(a.length, b.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `sample ${i}: ${a[i]} vs ${b[i]}`);
});

test('the joints of a branched bridge lie on one grade between its banks, no saw', () => {
  const { w, t } = decksAfter([0, 1]);
  const [D1, D2, , D3, D4] = w.decks;
  // every member meeting a joint agrees on its level there
  const end = (d, e) => geo.bridgeDeckHeight(d, e ? d._len : 0, t);
  assert.ok(Math.abs(end(D1, 1) - end(D2, 0)) < 1e-6, 'D1 and D2 part at their joint');
  assert.ok(Math.abs(end(D2, 1) - end(D3, 0)) < 1e-6, 'D2 and D3 part at their joint');
  assert.ok(Math.abs(end(D3, 1) - end(D4, 0)) < 1e-6, 'D3 and D4 part at their joint');
  // and the deck climbs west to east without a step over a road's grade
  let prev = null;
  for (const d of [D1, D2, D3, D4]) for (let s = 0; s <= d._len; s += 3) {
    const y = geo.bridgeDeckHeight(d, s, t);
    if (prev !== null) assert.ok(Math.abs(y - prev) / 3 <= 0.12, `a ${((y - prev) / 3 * 100).toFixed(0)} % step`);
    prev = y;
  }
  assert.ok(end(D4, 1) > end(D1, 0) + 5, 'the east bank is higher and the deck reaches it');
});

test('a viaduct entering an omitted tunnel carries its level through both short portal ways', () => {
  const rail = (points, bridge) => ({ p: points, t: 'rail', br: bridge, _len: geo.polylineLength(points) });
  const bank = rail([[10, 20], [100, 20]]);
  const bridge = rail([[100, 20], [200, 20]], 1);
  const stub = rail([[200, 20], [215, 20]]), tip = rail([[215, 20], [240, 20]]);
  const ways = [bank, bridge, stub, tip];
  const cells = new Map();
  for (let cx = 0; cx <= 2; cx++) cells.set(cx + ',0', { roads: [], rails: ways });
  const city = { chunkIndex: cells };
  stitchStructures(city, [], ways);
  const hill = { heightAt: x => 196 + Math.max(0, x - 165) * 0.5, ready: () => true };
  for (const w of [bridge, stub, tip]) {
    const heightAt = w.br ? geo.bridgeDeckHeight : geo.railGradeY;
    assert.ok(Math.abs(heightAt(w, 0, hill) - 196) < 0.02);
    assert.ok(Math.abs(heightAt(w, w._len, hill) - 196) < 0.02);
  }
});

test('a short road bridge between surveyed approach roads spreads a steep rise across its span', () => {
  const a = road([[0, 0], [50, 0]]), b = road([[82, 0], [132, 0]]);
  const t = { heightAt: x => x <= 50 ? 220 : x >= 82 ? 227 : 215 };
  const w = deck([[50, 0], [82, 0]], { _ap0: { road: a, at: 50 }, _ap1: { road: b, at: 0 } });
  const start = geo.bridgeDeckHeight(w, 0, t), end = geo.bridgeDeckHeight(w, 32, t);
  assert.ok(Math.abs(end - start - 7) < 0.1);
  for (let s = 10; s <= 22; s++) {
    const y = d => geo.bridgeDeckHeight(w, d, t);
    assert.ok(Math.abs(y(s - 10) - 2 * y(s) + y(s + 10)) < 0.25);
  }
});
