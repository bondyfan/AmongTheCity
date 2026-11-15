// ---- one release scenario, in a process of its own ---------------------------
// Not a test: the runner tests/tile-data-release.test.mjs starts. geo.js keeps
// its junction registries in module scope, so a "fresh load" to compare a
// released-and-returned world against needs a fresh process. This loads two
// real tiles A and B (in a given order), optionally releases A while a hold
// point keeps B resident, brings A back, and prints what the world holds near
// them: the chunk index, the junction pads and clusters, every derived link on
// every way (pins, abutments, approaches, chains, underpasses, bays), the flat
// arrays and the graphs built over them.
//
//   node tests/release-run.mjs '{"tiles":["0,-1","-1,-1"],"release":"0,-1"}'
//
// Only A and B ever load: every other tile of the manifest is made inert for
// the run (state 2 with nothing indexed, which ensureTiles and both eviction
// stages skip). Their indexing order is forced by holding each tile's fetch
// until the one before it has been indexed.
import { bootCity, stubVehicles } from './flow-harness.mjs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// (ROOT=<dir> runs another checkout's js/, as tests/flow-harness.mjs does)
const ROOT = process.env.ROOT ? path.resolve(process.env.ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const J = (f) => pathToFileURL(path.join(ROOT, 'js', f)).href;

const arg = JSON.parse(process.argv[2]);
const city = await bootCity();
const geo = await import(J('geo.js'));
const { CHUNK } = await import(J('config.js'));
const T = city.tile;
const key = (t) => t.tx + ',' + t.tz;
const want = new Set(arg.tiles);
for (const t of city.manifestTiles) if (!want.has(key(t))) t.state = 2;   // inert
const byKey = new Map(city.manifestTiles.map((t) => [key(t), t]));

// fetch resolution in the order asked for
const raw = globalThis.fetch;
let order = [], gate = Promise.resolve();
const arrived = [];
city.onTileLoaded((t) => {
  arrived.push(t.tx + ',' + t.tz);
  if (!process.env.DEBUGWAY) return;
  const id = +process.env.DEBUGWAY;
  const w = [...city.roads, ...city.rails].find((r) => r._id === id);
  if (!w) return console.error('arrived', t.tx, t.tz, 'way absent');
  const e = w.p[0], k = Math.floor(e[0] / 120) + ',' + Math.floor(e[1] / 120);
  const c = city.chunkIndex.get(k);
  const K = (x, z) => Math.round(x * 50) + ',' + Math.round(z * 50);
  const hits = (c?.rails ?? []).filter((o) => o !== w && o.p.some((q) => K(q[0], q[1]) === K(e[0], e[1]))).map((o) => o._id + (o.br ? 'br' : ''));
  console.error('arrived', t.tx, t.tz, 'ap0', w._ap0?.road?._id, w._ap0?.at, 'cell', k, 'rails', c?.rails.length, 'hits', hits.join(','), 'end', e.join(','));
});
globalThis.fetch = async (url) => {
  const res = await raw(url);
  const t = city.manifestTiles.find((m) => m.f === url);
  if (!t) return res;
  const i = order.indexOf(key(t));
  // wait until every tile ahead of this one in `order` has been indexed
  while (order.slice(0, i).some((k) => !arrived.includes(k))) await new Promise((r) => setTimeout(r, 5));
  return res;
};

const log = console.log; console.log = () => {};
const { Traffic } = await import(J('traffic.js'));
const { Navigation } = await import(J('navigation.js'));
const { Pedestrians } = await import(J('pedestrians.js'));
const { Cyclists } = await import(J('cyclists.js'));
const g = arg.graphs ?? 'tnpc';      // which graphs listen: traffic, nav, peds, cyclists
const traffic = g.includes('t') ? new Traffic(city, stubVehicles()) : null;
const nav = g.includes('n') ? new Navigation(city) : null;
const peds = g.includes('p') ? new Pedestrians({ add() {}, remove() {} }, city) : null;
const cyc = g.includes('c') ? new Cyclists({ add() {}, remove() {} }, city, null, { peds, traffic }) : null;

const idle = async () => {
  for (let i = 0; i < 3000 && (city.releasing > 0 || city.manifestTiles.some((t) => t.state === 1)); i++)
    await new Promise((r) => setTimeout(r, 10));
};
const settle = async (x, z) => { for (let i = 0; i < 12; i++) { await city.ensureTiles(x, z); await idle(); } };
const centre = (t) => [(t.tx + 0.5) * T, (t.tz + 0.5) * T];
const both = arg.tiles.map((k) => byKey.get(k));
const mid = [(centre(both[0])[0] + centre(both[1])[0]) / 2, (centre(both[0])[1] + centre(both[1])[1]) / 2];

order = arg.tiles.slice();
await settle(...mid);
const loaded = both.map((t) => t.state);
let note = {};
if (arg.release) {
  const A = byKey.get(arg.release), B = both.find((t) => t !== A);
  // a hold point beyond B, EVICT_REACH from A's whole footprint
  const ax = centre(A), bx = centre(B);
  const dx = Math.sign(bx[0] - ax[0]), dz = Math.sign(bx[1] - ax[1]);
  const e = A.ext;
  const edge = [dx < 0 ? e[0] : dx > 0 ? e[2] : bx[0], dz < 0 ? e[1] : dz > 0 ? e[3] : bx[1]];
  const H = [edge[0] + dx * 9100, edge[1] + dz * 9100];
  const hold = (out) => out.push(H[0], H[1]);
  city.evictHolds.push(hold);
  // what of A must die: every way (the seam ones first in line to be pinned)
  // and every pad, once nothing resident can reach them
  // (in a function of its own: a block of this module's top level stays on
  // the stack for the whole run, and with it anything it held)
  const weakOf = (t) => {
    const out = [];
    for (const w of [...t.res.roads, ...t.res.rails]) out.push(new WeakRef(w));
    if (process.env.SNAP) { class ReleaseProbe {} const pw = t.res.roads.find((w) => w._id === +process.env.PROBE) ?? t.res.roads[t.res.roads.length >> 1]; pw.__probe = new ReleaseProbe(); }
    const mine = new Set(t.res.roads);
    for (const l of geo.JUNCTIONS.values()) for (const e of l) if (mine.has(e.arms[0].r)) out.push(new WeakRef(e));
    return out;
  };
  let refs = arg.weak ? weakOf(A) : null;
  await settle(1e7, 1e7);
  if (refs) {
    // (a WeakRef keeps its target to the end of the job that read it last)
    for (let i = 0; i < 3; i++) { await new Promise((r) => setTimeout(r, 5)); globalThis.gc(); }
    await new Promise((r) => setTimeout(r, 5));
    note.alive = refs.filter((r) => r.deref()).length;
    if (process.env.DEBUGHOLD) note.which = refs.map((r) => r.deref()).filter(Boolean).slice(0, 3).map((o) => o._id ? 'way ' + o._id + ' ' + o.t : 'node ' + o.x + ',' + o.z);
    if (process.env.SNAP) (await import('node:v8')).writeHeapSnapshot(process.env.SNAP);
    if (process.env.DEBUGHOLD) {
      const live = new Set(refs.map((r) => r.deref()).filter(Boolean));
      const d = {};
      d.flatRoads = city.roads.filter((w) => live.has(w)).length;
      let c = 0; for (const cell of city.chunkIndex.values()) for (const w of cell.roads) if (live.has(w)) c++;
      d.cells = c;
      c = 0; for (const l of geo.JUNCTIONS.values()) for (const e of l) if (e.arms.some((a) => live.has(a.r))) c++;
      d.junc = c;
      c = 0; for (const w of city.roads) for (const p of w._pins ?? []) if (p.node.arms.some((a) => live.has(a.r))) c++;
      d.pins = c;
      d.trafficEdges = traffic ? traffic.edges.filter((e) => live.has(e.road)).length : -1;
      d.tiles = city.manifestTiles.filter((t) => t.kept || t.res).length;
      d.dip = city._dipWays ? [...city._dipWays].filter((w) => live.has(w)).length : 0;
      console.error(JSON.stringify(d));
    }
    note.refs = refs.length;
    refs = null;
  }
  note.away = { A: A.state, B: B.state, poisIn: !!A.poisIn, kept: !!A.kept };
  city.evictHolds.length = 0;
  order = [arg.release];
  await settle(...mid);
}
console.log = log;

// ---- prints ----
const inside = (k) => {
  const i = k.indexOf(','), cx = +k.slice(0, i) * CHUNK, cz = +k.slice(i + 1) * CHUNK;
  return both.some((t) => cx >= t.tx * T - 600 && cx < (t.tx + 1) * T + 600 && cz >= t.tz * T - 600 && cz < (t.tz + 1) * T + 600);
};
const ids = (l) => l.map((f) => f._id).sort((a, b) => a - b).join(',');
const index = [];
for (const [k, c] of city.chunkIndex) {
  if (!inside(k)) continue;
  const row = [];
  for (const kind in c) if (c[kind].length) row.push(kind + ':' + ids(c[kind]));
  index.push(k + '=' + row.join('|'));
}
const r3 = (v) => (v === undefined || v === null ? '-' : typeof v === 'number' ? v.toFixed(3) : String(v));
const armIds = (n) => n.arms.map((a) => a.r._id + '@' + a.i).sort().join('+');
const junc = [];
for (const [k, l] of geo.JUNCTIONS) if (inside(k)) for (const e of l)
  junc.push(k + ':' + r3(e.x) + ',' + r3(e.z) + ':' + r3(e.pad) + ':' + armIds(e) + ':' + (e._cluster ? 'c' : '') + (e._ring ? 'r' : '') + (e._t ?? ''));
for (const [k, l] of geo.CLUSTERS) if (inside(k)) for (const cl of l)
  junc.push('C' + k + ':' + r3(cl.x) + ',' + r3(cl.z) + ':' + r3(cl.padR) + ':' + cl.members.map((m) => r3(m.x) + ',' + r3(m.z)).sort().join(' '));
junc.sort();
const link = (l) => (l && typeof l === 'object' ? l.road._id + '@' + r3(l.at) : r3(l));
const ways = [];
for (const list of [city.roads, city.rails]) for (const w of list) {
  // (not the dead-end flags: streets.computeVerge clears them lazily, the first
  // time a kerb is asked for, from whatever the chunk index holds just then)
  ways.push([w._id, w.p.length, r3(w.w), r3(w._len), r3(w._j0), r3(w._j1),
    (w._abut ?? []).map(r3).sort().join(','), link(w._ap0), link(w._ap1),
    (w._apN0 ?? []).map(link).sort().join(','), (w._apN1 ?? []).map(link).sort().join(','),
    (w._pins ?? []).map((p) => r3(p.s) + '/' + armIds(p.node)).sort().join(','),
    w._chain ? w._chain.members.map((m) => m._id).join('>') + '@' + r3(w._chainOff) + (w._chainRev ? 'r' : '') : '',
    (w._dipX ?? []).map((d) => d.b._id + '@' + r3(d.s)).sort().join(','),
    w._dipChain ? w._dipChain.members.map((m) => m.r._id + (m.rev ? 'r' : 'f')).join('>') : '',
    (w._bays ?? []).map(r3).join(','), (w._cross ?? []).length, w.rb ? 'rb' : '', w._island ? 'i' : ''].join(' '));
}
ways.sort();
const flat = Object.fromEntries(['roads', 'rails', 'paved', 'pois', 'signals', 'buildings', 'trees', 'water', 'green']
  .map((k) => [k, city[k].length]));
const tcells = [], tjunc = [];
let tfar = [];
if (traffic) {
  traffic._densK = 1;
  for (const [k, c] of traffic._cells) tcells.push(k + '=' + traffic._slots(c) + '/' + c.len.toFixed(4) + '/' + traffic._cellEdges(c).map((e) => e.eid + ':' + e.len.toFixed(3)).join(','));
  tcells.sort();
  // the cells a co-op player can stand in: away from the seam (traffic and the
  // route planner split ways at a seam node by what was resident when the way
  // came in, which is the round 7 contract: identical away from the seam)
  const seamFar = (k) => {
    const i = k.indexOf(','), x = (+k.slice(0, i) + 0.5) * 256, z = (+k.slice(i + 1) + 0.5) * 256;
    const [a, b] = both;
    if (a.tx !== b.tx) return Math.abs(x - Math.max(a.tx, b.tx) * T) > 600;
    return Math.abs(z - Math.max(a.tz, b.tz) * T) > 600;
  };
  tfar = tcells.filter((r) => seamFar(r.slice(0, r.indexOf('='))));
  for (const j of traffic._junctions) tjunc.push([Math.round(j.x * 10), Math.round(j.z * 10), j.off.toFixed(6)].join(','));
  tjunc.sort();
}
const graphs = { edges: traffic?.edges.length, nodes: traffic?._nodes.size, usage: traffic?._usage.size, tj: traffic?._junctions.length,
  nav: nav && [nav._segs.length, nav._nodeIx.size], peds: peds && [peds.paths.length, peds.sites.count],
  cyc: cyc && [cyc.net.count, cyc.net.nodes.size, cyc._cells.size] };
const out = { arrived, loaded, note, flat, graphs, n: { index: index.length, junc: junc.length, ways: ways.length, tcells: tcells.length } };
const { createHash } = await import('node:crypto');
const h = (a) => createHash('sha1').update(a.join('\n')).digest('hex').slice(0, 12);
index.sort();
out.hash = { index: h(index), junc: h(junc), ways: h(ways), tcells: h(tcells), tfar: h(tfar), tjunc: h(tjunc), pids: h((peds?.paths ?? []).map((r) => r._pid).sort()) };
if (process.env.DUMP) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.DUMP, JSON.stringify({ index, junc, ways, tcells, tjunc }));
}
console.log(JSON.stringify(out));
process.exit(0);
