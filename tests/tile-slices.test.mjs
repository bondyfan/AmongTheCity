// ---- a tile arrival, a few milliseconds a frame (round 8, HORIZON) ----------
// geo.js indexes a tile as a generator (indexPayloadSteps) when
// city.indexSliceMs is set, the game's in-play setting, and in one go when it
// is not (boot, every other test). Two things are pinned on real D11 tiles:
// the sliced indexing leaves EXACTLY what the single pass leaves (the index
// cell by cell and list by list, the junction pads and clusters, every field
// the stitching and the pads write on a way, the flat arrays and the arrival
// events), and no single slice of a tile's indexing is anywhere near what the
// whole tile costs.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

register(new URL('./three-alias.mjs', import.meta.url));

const PUBLIC = new URL('../public/', import.meta.url);
// tiles answer in the order they were asked for, so two loads index the same
// tiles in the same order (the arrival order is the city's to choose, not
// the file system's)
let chain = Promise.resolve();
globalThis.fetch = (url) => (chain = chain.then(async () => {
  const buf = await readFile(new URL(String(url).replace(/^\//, ''), PUBLIC));
  return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')) };
}));
globalThis.requestAnimationFrame = (cb) => { setImmediate(() => cb(0)); return 0; };

// the D11 on the open straight at km 30 and by Jirny at km 10: tiles -12 and
// -16 to -15, rows -3 and -2, interchanges and bridges included. (A TOWN tile
// still has one long step: stampPartyWalls, 20 to 80 ms in Poděbrady or
// Prague, js/partywalls.js, and the JSON.parse before it.)
const AT = [[-55100, -9687], [-74108, -10302]];

const r3 = (v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v);
function fingerprint(city, geo, events) {
  const h = createHash('sha1');
  for (const k of [...city.chunkIndex.keys()].sort()) {
    const c = city.chunkIndex.get(k);
    h.update(k);
    for (const kind in c) h.update(kind + ':' + c[kind].map((f) => f._id).join(','));
  }
  const byKey = (a, b) => (a[0] < b[0] ? -1 : 1);
  for (const [k, l] of [...geo.JUNCTIONS].sort(byKey)) for (const e of l)
    h.update(k + [e.x, e.z, e.pad, e.padR, e._t, e._ring, e._cluster?.members.length ?? '-',
      JSON.stringify(e._hullRing ?? null), e.arms.map((a) => a.r._id + '/' + a.i + '/' + r3(a.s)).join(',')].map(r3).join('|'));
  for (const [k, l] of [...geo.CLUSTERS].sort(byKey)) for (const c of l)
    h.update(k + [c.x, c.z, c.padR, JSON.stringify(c._ring ?? null), c.members.map((m) => m.x + ',' + m.z).join(';')].map(r3).join('|'));
  for (const r of city.roads)
    h.update([r._id, r.w, r._len, r._j0, r._j1, JSON.stringify(r._jz ?? null), r._de0, r._de1,
      JSON.stringify(r._abut ?? null), r._ap0?.road?._id, r._ap0?.at, r._ap1?.road?._id, r._ap1?.at,
      r._chain ? r._chain.members.map((m) => m._id).join('>') : '', r._cross?.length, JSON.stringify(r._bays ?? null),
      (r._pins ?? []).map((p) => r3(p.s) + '@' + r3(p.node.x) + ',' + r3(p.node.z) + (p.node._ovl ? 'o' : '')).join(';'),
      r.p.flat().map(r3).join(',')].map(r3).join('|'));
  for (const kind of ['buildings', 'trees', 'rails', 'water', 'green', 'paved', 'pois', 'venues', 'signals', 'barriers', 'power'])
    h.update(kind + city[kind].map((f) => f._id ?? JSON.stringify(f)).join(','));
  h.update(events.join('\n'));
  return h.digest('hex');
}

// A fresh geo.js per load (its JUNCTIONS and CLUSTERS are module state).
let fresh = 0;
async function load(sliceMs) {
  const geo = await import(`../js/geo.js?slices=${++fresh}`);
  const city = await geo.loadCity('data/manifest.json');
  if (sliceMs) city.indexSliceMs = sliceMs;
  const events = [];
  city.onTileLoaded((t) => { events.push([t.tx, t.tz, t.roads.length, t.signals.length, t.pois.length, [...t.cells].join(';')].join('|')); });
  for (const [x, z] of AT) await city.ensureTiles(x, z);
  return { geo, city, events };
}

test('a tile indexed in slices is the tile indexed in one go', async () => {
  const whole = await load(0);
  const sliced = await load(1);
  assert.ok(sliced.city.indexStats.slices > 10 * sliced.events.length, 'the indexing was not sliced');
  assert.ok(whole.city.roads.length > 1000 && whole.events.length >= 4, 'the D11 tiles did not load');
  assert.equal(fingerprint(sliced.city, sliced.geo, sliced.events), fingerprint(whole.city, whole.geo, whole.events));
});

test('no slice of a D11 tile costs what the tile does', async (t) => {
  // At the game's 4 ms a tile is indexed in dozens of slices, and almost all
  // of them stay near the budget. Counted rather than timed at the worst: a
  // busy machine (the full suite) can stop the process in the middle of any
  // one slice, which says nothing about the code. The steps that cannot be
  // cut (one indexJunctions bucket, the landing of the index,
  // stitchStructures, the party walls) measured 4 to 15 ms on these tiles on a
  // quiet machine; one-frame indexing, the regression, is one slice a tile
  // (a small rural tile is 6 to 12 slices on a quiet machine, listeners included).
  // (review, round 8) The slices are timed on this thread's CPU clock, not
  // the wall clock: in the full suite twenty test files share the machine and
  // a wall-clock slice also counts the time the process was not running (it
  // failed there with 5 of 14 slices "over 8 ms" and passed alone). geo.js
  // reads performance.now() at every call, so its budget runs on the same clock.
  const wall = performance.now;
  // (the main thread's own CPU time where Node has it: the whole process's
  // also counts the garbage collector's helper threads)
  const cpu = process.threadCpuUsage ?? process.cpuUsage;
  performance.now = () => { const u = cpu(); return (u.user + u.system) / 1000; };
  t.after(() => { performance.now = wall; });
  const geo = await import(`../js/geo.js?slices=${++fresh}`);
  const city = await geo.loadCity('data/manifest.json');
  city.indexSliceMs = 4;
  const st = city.indexStats;
  const perTile = [];
  let s0 = 0, o0 = 0;
  city.onTileLoaded(() => { perTile.push([st.slices - s0, st.over8 - o0]); s0 = st.slices; o0 = st.over8; });
  for (const [x, z] of AT) await city.ensureTiles(x, z);
  assert.ok(perTile.length >= 4, 'the D11 tiles did not load');
  for (const [n, long] of perTile) {
    assert.ok(n >= 4, `a tile was indexed in ${n} slices`);
    assert.ok(long <= Math.max(3, n * 0.25), `${long} of a tile's ${n} slices took over 8 ms`);
  }
});
