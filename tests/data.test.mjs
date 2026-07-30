// ---- sanity tests for the processed city data + traffic-graph viability ----
// Runs headless (node --test). If these pass, the game has a station to spawn
// at, streets to drive and a connected road network — before a browser ever
// opens the page.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const city = JSON.parse(readFileSync(new URL('../public/data/pardubice.json', import.meta.url), 'utf8'));

test('city bounds and layer counts are sane', () => {
  assert.ok(city.buildings.length > 5000, `buildings: ${city.buildings.length}`);
  assert.ok(city.roads.length > 3000, `roads: ${city.roads.length}`);
  assert.ok(city.water.length > 10, 'the Labe should be here');
  assert.ok(city.trees.length > 500, 'street trees');
  for (const b of city.buildings.slice(0, 500)) {
    assert.ok(b.h > 1 && b.h <= 120, `height ${b.h}`);
    assert.ok(b.o.length >= 3, 'ring has 3+ points');
  }
});

test('the main station hall stands at the origin', () => {
  const near = city.buildings.filter(b => {
    const [x, z] = b.o[0];
    return Math.hypot(x, z) < 300 && b.t === 'train_station';
  });
  assert.ok(near.length >= 1, 'train_station building within 300 m of origin');
  const hall = near.sort((a, b) => b.o.length - a.o.length)[0];
  const xs = hall.o.map(p => p[0]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 150, 'the hall is a long building');
});

test('drivable roads form one big connected component', () => {
  // the traffic.js graph recipe: junction nodes are points SHARED between
  // ways (side streets join mid-way through main roads) or way endpoints;
  // edges run along each way between consecutive junction nodes
  const key = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
  const drivable = city.roads.filter(r => r.d);
  const useCount = new Map();
  for (const r of drivable) for (const p of r.p)
    useCount.set(key(p), (useCount.get(key(p)) ?? 0) + 1);
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b); adj.get(b).push(a);
  };
  for (const r of drivable) {
    let prev = key(r.p[0]);
    for (let i = 1; i < r.p.length; i++) {
      const k = key(r.p[i]);
      const isNode = i === r.p.length - 1 || useCount.get(k) > 1;
      if (isNode) { link(prev, k); prev = k; }
    }
  }
  // BFS from the junction with the most arms (safely on the main network)
  let start = null, deg = -1;
  for (const [k, list] of adj) if (list.length > deg) { deg = list.length; start = k; }
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    const n = q.pop();
    for (const m of adj.get(n) ?? []) if (!seen.has(m)) { seen.add(m); q.push(m); }
  }
  const frac = seen.size / adj.size;
  assert.ok(frac > 0.85, `largest component covers ${(frac * 100).toFixed(1)}% of junctions`);
});

test('spawn area has drivable roads close by', () => {
  const SPAWN = { x: 25, z: -122 };
  let best = 1e9;
  for (const r of city.roads) {
    if (!r.d) continue;
    for (const [x, z] of r.p) best = Math.min(best, Math.hypot(x - SPAWN.x, z - SPAWN.z));
  }
  assert.ok(best < 120, `nearest drivable road ${best.toFixed(0)} m from spawn`);
});

// ---------------------------------------------------------------------------
// what the ground is MADE of
// ---------------------------------------------------------------------------

test('the world knows what its surfaces are paved with', async () => {
  // OSM's `surface` tag is the most useful thing in the file for a world that
  // builds its ground rather than photographing it, and every one of them used
  // to be thrown away — the class of the road was the only input, so a grass
  // track and a motorway differed by a guess. Tile -1,-1 carries 1 872 of them.
  const t = JSON.parse(readFileSync('public/data/tiles/-1_-1.json', 'utf8'));
  const tagged = [...t.roads, ...t.paved].filter((f) => f.s);
  assert.ok(tagged.length > 1000,
    `only ${tagged.length} features carry a surface — the tag is being dropped again`);
  // …and every value is one the runtime can map (js/meshes.js TAGGED)
  const known = new Set(['asphalt', 'concrete', 'paving', 'cobble', 'gravel', 'dirt', 'grass']);
  const bad = [...new Set(tagged.map((f) => f.s))].filter((s) => !known.has(s));
  assert.deepEqual(bad, [], `surface codes the client cannot map: ${bad}`);
});

test('station platforms and works yards survive the extraction', () => {
  // The ground in front of a station is mapped in OSM as platform areas, and
  // none of them reached the game: split-extracts kept only rail|tram|light_rail
  // railways, and build-region then demanded area=yes, which OSM barely ever
  // adds to a closed platform way. Between them, all 77 platforms in this tile
  // were dropped and the forecourt fell back to "unmapped ground is a field".
  const t = JSON.parse(readFileSync('public/data/tiles/-1_-1.json', 'utf8'));
  const kinds = new Set(t.paved.map((f) => f.t));
  assert.ok(kinds.has('platform'), 'no station platform survived');
  assert.ok(kinds.has('yard'), 'no works or railway yard survived');
});
