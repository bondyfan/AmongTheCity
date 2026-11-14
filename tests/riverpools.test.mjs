// ---- the Prague Vltava is a staircase of flat pools -------------------------
// js/riverpools.js authors the level of the pooled Prague bodies (one number
// per pool, a short ramp over each weir), js/weirs.js refines the surface at
// the crests, js/naplavky.js digs the lower quays, js/riverbed.js lowers the
// bed under the pools. All of it is pure data and arithmetic, shared by the
// main thread and the mesh workers, so it is tested here headless.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const RP = await import('../js/riverpools.js');
const { refineNearWeirs, paintFlow } = await import('../js/weirs.js');
const { riverbedInto } = await import('../js/riverbed.js');
const { Terrain } = await import('../js/terrain.js');

const tile = (k) => JSON.parse(readFileSync(new URL(`../public/data/tiles/${k}.json`, import.meta.url), 'utf8'));
const MAIN = tile('-20_-2').water[42];
const SOUTH = tile('-21_-1').water[32];
const CERT = tile('-21_-2').water[42];

test('the shipped Prague bodies are recognised by their geometry, nothing else is', () => {
  assert.ok(RP.isPooled(MAIN) && RP.isPooled(SOUTH) && RP.isPooled(CERT));
  // a copy (what a worker receives) is recognised the same
  assert.ok(RP.isPooled(JSON.parse(JSON.stringify(MAIN))));
  // the Labe in Pardubice keeps the generic level
  const pce = tile('0_-1').water ?? [];
  for (const f of pce) assert.strictEqual(RP.riverLevelAt(f, f.o?.[0]?.[0] ?? 0, f.o?.[0]?.[1] ?? 0), null);
});

test('each pool is flat, and across the channel there is one level', () => {
  const { A, B, C, D } = RP.POOLS;
  // Mánesův most: the old field tilted 185.2 west to 190.1 east here
  for (let x = -96370; x <= -96130; x += 20) assert.strictEqual(RP.riverLevelAt(MAIN, x, -6430), C);
  assert.strictEqual(RP.riverLevelAt(MAIN, -96300, -4600), A);   // Palackého most
  assert.strictEqual(RP.riverLevelAt(MAIN, -96350, -5500), B);   // most Legií
  assert.strictEqual(RP.riverLevelAt(MAIN, -96340, -6090), C);   // Karlův most
  assert.strictEqual(RP.riverLevelAt(MAIN, -94000, -7300), D);   // Štvanice north arm
  assert.strictEqual(RP.riverLevelAt(SOUTH, -96300, -3000), A);
  assert.ok(A > B && B > C && C > D, 'pools step down the river');
});

test('a weir is a short ramp from the pool above to the pool below, continuous', () => {
  const w = RP.WEIRS[1];                 // Staroměstský
  const [a, b] = [w.cut[1], w.cut[2]];
  const mx = (a[0] + b[0]) / 2, mz = (a[1] + b[1]) / 2;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), nx = -(b[1] - a[1]) / L, nz = (b[0] - a[0]) / L;
  let prev = null, lo = Infinity, hi = -Infinity;
  for (let s = -12; s <= 12; s += 0.25) {
    const y = RP.riverLevelAt(MAIN, mx + nx * s, mz + nz * s);
    if (prev !== null) assert.ok(Math.abs(y - prev) < 0.25, `a step of ${(y - prev).toFixed(2)} m at ${s}`);
    prev = y; lo = Math.min(lo, y); hi = Math.max(hi, y);
  }
  assert.strictEqual(lo, RP.POOLS.C);
  assert.strictEqual(hi, RP.POOLS.B);
});

test('below the last weir the river is handed back to the generic level', () => {
  assert.strictEqual(RP.riverLevelAt(MAIN, -96600, -9107), null);   // below Troja
});

test('Čertovka runs from pool B at Kampa\'s south end to pool C below Charles Bridge', () => {
  const s = RP.riverLevelAt(CERT, -96621, -5618), n = RP.riverLevelAt(CERT, -96302, -6215);
  assert.ok(Math.abs(s - RP.POOLS.B) < 1e-9 && Math.abs(n - RP.POOLS.C) < 1e-9);
});

test('the level is a pure function: the same bits whatever order it is asked in', () => {
  const pts = [];
  for (let i = 0; i < 400; i++) pts.push([-96800 + (i * 37.3) % 3400, -7700 + (i * 91.7) % 4000]);
  const a = pts.map(([x, z]) => RP.riverLevelAt(MAIN, x, z));
  const b = pts.slice().reverse().map(([x, z]) => RP.riverLevelAt(JSON.parse(JSON.stringify(MAIN)), x, z)).reverse();
  assert.deepStrictEqual(a, b);
});

test('the surface refined at a weir crest has no T junctions (no slits on the ramp)', () => {
  // a strip of 8 m triangles straddling the Staroměstský crest
  const pos = [];
  for (let x = -96400; x < -96300; x += 8) for (let z = -5960; z < -5860; z += 8) {
    pos.push(x, 0, z, x, 0, z + 8, x + 8, 0, z, x + 8, 0, z, x, 0, z + 8, x + 8, 0, z + 8);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  const r = refineNearWeirs(g, MAIN, -96400, -5960, -96300, -5860);
  const p = r.attributes.position.array;
  assert.ok(p.length > pos.length * 4, 'the crest was refined');
  // every edge inside the strip must be shared by exactly two triangles
  const key = (i) => Math.round(p[i] * 1000) + ',' + Math.round(p[i + 2] * 1000);
  const edges = new Map();
  for (let i = 0; i < p.length; i += 9) {
    const v = [key(i), key(i + 3), key(i + 6)];
    for (let k = 0; k < 3; k++) {
      const e = [v[k], v[(k + 1) % 3]].sort().join('|');
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [e, n] of edges) {
    if (n === 2) continue;
    const [[x0, z0], [x1, z1]] = e.split('|').map((s) => s.split(',').map((v) => v / 1000));
    const onRim = (x0 === x1 && (x0 === -96400 || x0 === -96296)) || (z0 === z1 && (z0 === -5960 || z0 === -5856));
    if (!onRim) open++;
  }
  assert.strictEqual(open, 0, `${open} interior edges belong to one triangle only`);
  paintFlow(r, MAIN);
  const c = r.attributes.color.array;
  let foam = 0;
  for (let i = 2; i < c.length; i += 3) foam = Math.max(foam, c[i]);
  assert.ok(foam > 0.9, 'white water below the crest');
});

test('culverted streams are recognised by their first vertex', () => {
  let n = 0;
  for (const k of ['-21_-2', '-20_-1']) for (const w of tile(k).waterways ?? []) if (RP.isCulvert(w)) n++;
  assert.strictEqual(n, 9);
});

test('the náplavky are dug to their pool plus the quay height, the street side untouched', () => {
  const t = new Terrain(4800, 20);
  // a flat survey at 193 m under Rašínovo nábřeží
  for (const k of ['-21,-1', '-20,-1', '-21,-2', '-20,-2']) t.grids.set(k, new Int16Array(t.n * t.n).fill(1930));
  t._loads = 1;
  const floor = RP.POOLS.A + 1.6;
  assert.ok(Math.abs(t.heightAt(-96185, -4450) - floor) < 0.05, 'the lower quay');
  assert.ok(Math.abs(t.heightAt(-96140, -4450) - 193) < 1e-6, 'Rašínovo nábřeží');
  // Pardubice is untouched by the Prague stamps (one box per city)
  t.grids.set('0,-1', new Int16Array(t.n * t.n).fill(2170));
  assert.ok(Math.abs(t.heightAt(1400, -1300) - 217) < 1e-6);
});

test('the riverbed sinks under the pools, never near a bank', () => {
  const n = 241, g = new Int16Array(n * n).fill(1880);
  const moved = riverbedInto(g, -21, -2, n, 20, 4800);
  assert.ok(moved > 500);
  // mid-channel by Karlův most (x -96340, z -6080): 2.5 m under pool C
  const i = Math.round((-96340 + 100800) / 20), j = Math.round((-6080 + 9600) / 20);
  assert.strictEqual(g[j * n + i], Math.round((RP.POOLS.C - 2.5) * 10));
  // Old Town Square is not the river
  const i2 = Math.round((-95640 + 100800) / 20), j2 = Math.round((-6200 + 9600) / 20);
  assert.strictEqual(i2 < n ? g[j2 * n + i2] : 1880, 1880);
});
