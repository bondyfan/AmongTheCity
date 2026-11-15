// ---- a far tile gives back its ways, and gets the same ones back ------------
// geo.js RELEASE_DATA: a deep-evicted tile's roads, rails, signals and car
// parks leave the flat arrays, its junction pads and clusters leave the
// registries, and every link stitching made from a neighbour's way to them is
// taken off (underpassrelease.js releaseStructures). Pinned here on real tile pairs,
// one released while its neighbour stays resident, in both load orders: while
// away nothing of it is reachable any more (every way and pad collectable),
// and once back the world near the pair is what a client that loaded the two
// tiles in the same order and never released anything holds, to the cell,
// the pad, every derived link on every way, the traffic cells and light
// phases away from the seam, and the walkers' paths. Pardubice across x = 0,
// and Prague across the river (x -96000, the castle side and the Old Town). Each scenario runs in a process of its own
// (tests/release-run.mjs): geo.js keeps its junction registries in module
// scope, so a fresh load needs a fresh process.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RUN = fileURLToPath(new URL('./release-run.mjs', import.meta.url));
const runOne = (arg) => new Promise((done, fail) => {
  const p = spawn(process.execPath, ['--expose-gc', '--max-old-space-size=6144', RUN, JSON.stringify(arg)],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  p.on('close', (code) => {
    if (code !== 0) return fail(new Error(`release-run ${JSON.stringify(arg)} exited ${code}: ${err.slice(-800)}`));
    try { done(JSON.parse(out)); } catch (e) { fail(new Error('release-run printed ' + out.slice(0, 300) + err.slice(-300))); }
  });
});
// a few at a time: the Prague ones hold a gigabyte or two each
async function runAll(args, width = 3) {
  const res = new Array(args.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < args.length) { const i = next++; res[i] = await runOne(args[i]); }
  }));
  return res;
}

// [released tile, the neighbour that stays]: loaded in both orders, released,
// back. (Prague once, the earlier-loaded tile out: the order whose links had to
// be found again. All five pairs and orders, Prague across z -4800 too, passed
// when this was written; they cost three minutes of CPU, so the suite keeps three.)
const PAIRS = [['0,-1', '-1,-1'], ['-21,-2', '-20,-2']];
const scenarios = [];
for (const [a, b] of PAIRS) {
  const back = [b, a];                                   // the order the ways last came in
  const orders = a.startsWith('-2') ? [[a, b]] : [[a, b], [b, a]];
  for (const o of orders) scenarios.push({ name: `${a} out and back, loaded ${o.join(' then ')}`, rel: { tiles: o, release: a, weak: true }, fresh: back });
}
const freshKeys = [...new Set(scenarios.map((s) => s.fresh.join('|')))];
const results = await runAll([...scenarios.map((s) => s.rel), ...freshKeys.map((k) => ({ tiles: k.split('|') }))]);
const fresh = new Map(freshKeys.map((k, i) => [k, results[scenarios.length + i]]));

for (let i = 0; i < scenarios.length; i++) {
  const s = scenarios[i], r = results[i], f = fresh.get(s.fresh.join('|'));
  test(s.name, () => {
    assert.equal(r.note.away.A, 0, 'the tile was not deep-evicted');
    assert.equal(r.note.away.B, 3, 'the neighbour did not stay');
    assert.equal(r.note.away.kept, false, 'the tile kept its ways');
    assert.equal(r.note.away.poisIn, true);
    assert.ok(r.note.refs > 1000, r.note.refs + ' ways and pads watched');
    assert.equal(r.note.alive, 0, `${r.note.alive} released ways or pads are still reachable`);
    assert.deepEqual(r.loaded, [2, 2]);
    assert.deepEqual(r.flat, f.flat, 'flat arrays');
    assert.ok(r.n.ways > 5000 && r.n.junc > 500, JSON.stringify(r.n));
    assert.equal(r.hash.index, f.hash.index, 'chunk index');
    assert.equal(r.hash.junc, f.hash.junc, 'junction pads and clusters');
    assert.equal(r.hash.ways, f.hash.ways, 'derived links on the ways');
    assert.equal(r.hash.tfar, f.hash.tfar, 'traffic cells and slots away from the seam');
    assert.equal(r.hash.tjunc, f.hash.tjunc, 'signal controllers and phases');
    assert.equal(r.hash.pids, f.hash.pids, 'walker paths');
    assert.deepEqual(r.graphs.peds, f.graphs.peds, 'walker paths and sites');
    assert.deepEqual(r.graphs.cyc, f.graphs.cyc, 'cycle net');
  });
}
