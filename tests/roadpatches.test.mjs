// The road ways the tile build dropped (js/roadpatches.js): Celetná through
// the Powder Tower, and the D11 under its two green bridges. What no
// screenshot shows:
//   · a patch whose end misses the tile road it continues by a few
//     centimetres links nothing: every graph welds ways at rounded end points;
//   · a oneway patch that runs against the street it joins is a dead end both ways;
//   · a lane that grazes the masonry of the gate pushes every car out of it;
//   · an id that depends on arrival order, or shifts the tile's own ids,
//     changes what co-op clients hash;
//   · a motorway levelled over the earth of a green bridge is a ten metre
//     hump at 130 km/h, and a hole in it is a dead end for every graph.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const { withRoadPatches, roadPatches, ecoductCuts } = await import('../js/roadpatches.js');
const { LANDMARKS, matches, landmarkSolids, solidHas } = await import('../js/landmarks.js');
const { Navigation } = await import('../js/navigation.js');

const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/-20_-2.json', import.meta.url), 'utf8'));
const [celetna] = roadPatches();
const same = (p, q) => p[0].toFixed(1) === q[0].toFixed(1) && p[1].toFixed(1) === q[1].toFixed(1);

test('the Celetná patch continues the tile road at both faces of the tower, the same way round', () => {
  assert.equal(celetna.tx, -20); assert.equal(celetna.tz, -2);
  const p = celetna.road.p, a = p[0], b = p[p.length - 1];
  // a feature lives in the tile holding its first vertex
  assert.equal(Math.floor(a[0] / 4800), -20); assert.equal(Math.floor(a[1] / 4800), -2);
  const drv = tile.roads.filter((r) => r.d && r.n === 'Celetná');
  const into = drv.filter((r) => same(r.p[r.p.length - 1], a));
  const outOf = drv.filter((r) => same(r.p[0], b));
  assert.equal(into.length, 1, 'no Celetná ends at the west face');
  assert.equal(outOf.length, 1, 'no Celetná starts at the east face');
  // oneway, and the street on either side runs the same direction
  assert.ok(into[0].ow && outOf[0].ow && celetna.road.ow);
  // nothing else of the tile already crosses the gap (the build really dropped it)
  for (const r of tile.roads) if (r.d) for (const q of r.p) {
    const t = ((q[0] - a[0]) * (b[0] - a[0]) + (q[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
    assert.ok(!(t > 0.05 && t < 0.95 && Math.hypot(q[0] - (a[0] + (b[0] - a[0]) * t), q[1] - (a[1] + (b[1] - a[1]) * t)) < 2),
      'the tile has a way through the passage already: the patch would double it');
  }
});

test('a car fits through the arch of the Powder Tower on the patch', () => {
  const l = LANDMARKS.find((q) => q.id === 'prasna-brana');
  const f = tile.buildings.find((g) => matches(l, g));
  assert.ok(f, 'the Powder Tower footprint is gone from the tile');
  const walls = landmarkSolids(f).filter((s) => s.bot <= 0.5);
  assert.ok(walls.length >= 2);
  const p = celetna.road.p, half = 1.2;   // a car's half width and a little
  for (let i = 0; i + 1 < p.length; i++) {
    const [ax, az] = p[i], [bx, bz] = p[i + 1], L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let s = 0; s <= L; s += 0.25) for (const o of [-half, 0, half]) {
      const x = ax + dx * s - dz * o, z = az + dz * s + dx * o;
      assert.ok(!walls.some((w) => solidHas(w, x, z)), `the lane runs into the gate's masonry at ${x.toFixed(1)}, ${z.toFixed(1)}`);
    }
  }
  // ...and the masonry is still there either side of it
  const [mx, mz] = p[1], nx = -(p[2][1] - p[0][1]), nz = p[2][0] - p[0][0], n = Math.hypot(nx, nz);
  for (const e of [-1, 1]) assert.ok(walls.some((w) => solidHas(w, mx + e * 5 * nx / n, mz + e * 5 * nz / n)), 'the gate is open beside its passage');
});

test('ids come from the top of the tile block, fresh records every time, other tiles untouched', () => {
  const top = 7 * (1 << 20);
  const a = withRoadPatches([], -20, -2, top), b = withRoadPatches([], -20, -2, top);
  assert.equal(a.length, 1);
  assert.equal(a[0]._id, top - 1);
  assert.notEqual(a[0], b[0], 'a patch object is shared between two indexings');
  assert.notEqual(a[0].p, b[0].p);
  assert.deepEqual(a[0], b[0]);
  // the call appends in place and hands the same array back
  const roads = [{ p: [[0, 0], [1, 1]], _id: 5 }];
  assert.equal(withRoadPatches(roads, -20, -2, top), roads);
  assert.equal(roads.length, 2); assert.equal(roads[0]._id, 5);
  assert.equal(withRoadPatches([], 0, -1, top).length, 0);
  assert.equal(withRoadPatches([], undefined, undefined, top).length, 0);   // the one-file city
});

test('the GPS drives Celetná through the tower instead of round the block', () => {
  const box = (r) => r.p.some((q) => q[0] > -95700 && q[0] < -94700 && q[1] > -6600 && q[1] < -5700);
  const near = tile.roads.filter((r) => r.d && box(r)).map((r) => ({ ...r, p: r.p.map((q) => q.slice()) }));
  const route = (roads) => {
    const nav = new Navigation({ roads });
    nav.setDestination(-95140, -6169);
    assert.ok(nav.reroute(-95230, -6178.5));
    return nav;
  };
  const before = route(near), after = route(withRoadPatches(near.slice(), -20, -2, 1 << 20));
  const len = (n) => n.remainingM;
  assert.ok(!after.partial, 'no full route along Celetná');
  // straight down Celetná is about 90 m; round the tower it was much more
  assert.ok(len(after) < 110, `the route is ${len(after).toFixed(0)} m`);
  assert.ok(len(before) > len(after) + 40, `the patch saves only ${(len(before) - len(after)).toFixed(0)} m`);
  // (the passage's middle vertex, under the tower: the route keeps a way's points)
  const through = after.route.some((q) => Math.hypot(q[0] - celetna.road.p[1][0], q[1] - celetna.road.p[1][1]) < 0.3);
  assert.ok(through, 'the route does not pass under the tower');
});

// ---- the D11 under the two ecoducts -------------------------------------------
const TILES = new URL('../public/data/tiles/', import.meta.url);
const tileJson = (tx, tz) => JSON.parse(readFileSync(new URL(tx + '_' + tz + '.json', TILES), 'utf8'));
const K = (q) => q[0].toFixed(1) + ',' + q[1].toFixed(1);
const lenOf = (p) => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; };
const heading = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]);
const turn = (h0, h1) => Math.abs(Math.atan2(Math.sin(h1 - h0), Math.cos(h1 - h0))) * 180 / Math.PI;
const ECO = roadPatches().filter((q) => q.road.t === 'motorway');
// every tile the D11 (and the D0 knot it starts in) runs through, with the patches as indexPayload appends them
const D11_TILES = [];
for (let tx = -18; tx <= -1; tx++) D11_TILES.push([tx, -2], [tx, -3]);
for (const tx of [0, 1]) for (let tz = -3; tz >= -6; tz--) D11_TILES.push([tx, tz]);
let _mw = null;
const motorways = () => _mw ??= D11_TILES.flatMap(([tx, tz]) =>
  withRoadPatches(tileJson(tx, tz).roads, tx, tz, 1 << 20).filter((r) => r.t === 'motorway' || r.t === 'motorway_link'));

test('each ecoduct patch continues a tile carriageway at both ends, the same way round, with its attributes and heading', () => {
  assert.equal(ECO.length, 4);
  const tiles = new Map();
  for (const { tx, tz } of ECO) if (!tiles.has(tx + ',' + tz)) tiles.set(tx + ',' + tz, tileJson(tx, tz).roads);
  const all = [...tiles.values()].flat().concat(tileJson(-4, -3).roads);   // the Voleč hole starts at the -4/-3 border
  for (const { tx, tz, road: r } of ECO) {
    const a = r.p[0], b = r.p[r.p.length - 1];
    assert.equal(Math.floor(a[0] / 4800), tx); assert.equal(Math.floor(a[1] / 4800), tz);
    const into = all.filter((o) => o.t === 'motorway' && o.ow && K(o.p[o.p.length - 1]) === K(a));
    const outOf = all.filter((o) => o.t === 'motorway' && o.ow && K(o.p[0]) === K(b));
    assert.equal(into.length, 1, `nothing arrives at ${K(a)}`);
    assert.equal(outOf.length, 1, `nothing leaves from ${K(b)}`);
    // the end points are the tile's own, to the decimetre, and the hole was real: nothing else leaves a / arrives at b
    assert.equal(all.filter((o) => o.t === 'motorway' && K(o.p[0]) === K(a)).length, 0, 'the tile already continues the way');
    for (const o of [into[0], outOf[0]]) for (const f of ['t', 'w', 'v', 'd', 's', 'ow', 'ln']) assert.equal(r[f], o[f], `${f} differs from the neighbour`);
    // no kink at either join: the patch leaves with the heading the way arrived with
    const ip = into[0].p, op = outOf[0].p;
    assert.ok(turn(heading(ip[ip.length - 2], a), heading(a, r.p[1])) < 1, 'a kink where the patch begins');
    assert.ok(turn(heading(r.p[r.p.length - 2], b), heading(b, op[1])) < 1, 'a kink where the patch ends');
    const L = lenOf(r.p);
    assert.ok(L > 45 && L < 82, `patch ${L.toFixed(1)} m`);
  }
});

test('the D11 is one oneway motorway chain per direction from the D0 to the edge of the world', () => {
  const roads = motorways();
  const starts = new Map();
  for (const r of roads) if (r.t === 'motorway' && r.ow) {
    const k = K(r.p[0]); (starts.get(k) ?? starts.set(k, []).get(k)).push(r);
  }
  const reach = (from) => {
    const dist = new Map([[from, 0]]), prev = new Map(), open = [[0, from]];
    while (open.length) {
      let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i;
      const [d, k] = open.splice(bi, 1)[0];
      if (d > dist.get(k)) continue;
      for (const r of starts.get(k) ?? []) {
        const e = K(r.p[r.p.length - 1]), nd = d + lenOf(r.p);
        if (nd < (dist.get(e) ?? Infinity)) { dist.set(e, nd); prev.set(e, r); open.push([nd, e]); }
      }
    }
    const nodes = [...dist].map(([k, d]) => [...k.split(',').map(Number), d, k]);
    const path = (k) => { const out = []; for (let r; (r = prev.get(k)); k = K(r.p[0])) out.push(r); return out; };
    return { nodes, path };
  };
  // eastbound: from the first D11 way out of the D0 knot at Horní Počernice
  // past Plotiště and the Trotina bridge, off the tiles at x 6588
  const E = reach(K([-83831, -7745.9])), east = E.nodes.filter(([x]) => x > 6500);
  assert.ok(east.length, 'the eastbound D11 does not reach the end of the world');
  assert.ok(east[0][2] > 104000 && east[0][2] < 106500, `eastbound ${(east[0][2] / 1000).toFixed(2)} km`);
  // westbound: from the first way on the tiles back into the D0 knot
  const W = reach(K([6353.7, -29952.9])), west = W.nodes.filter(([x, z]) => Math.hypot(x + 83316.7, z + 7685.3) < 1);
  assert.ok(west.length, 'the westbound D11 does not reach the D0');
  assert.ok(west[0][2] > 103000 && west[0][2] < 105500, `westbound ${(west[0][2] / 1000).toFixed(2)} km`);
  // both run through the ecoduct patches
  const onPath = new Set([...E.path(east[0][3]), ...W.path(west[0][3])]);
  for (const { road } of ECO) assert.ok([...onPath].some((r) => K(r.p[0]) === K(road.p[0]) && K(r.p[r.p.length - 1]) === K(road.p[road.p.length - 1])),
    `the chain does not use the patch at ${K(road.p[0])}`);
  // …and no oneway motorway beside the D11 ends or begins in thin air: the
  // 100 m cells the two chains cross, outside the D0 knot (x < -83000)
  const C = 100, cells = new Set();
  for (const r of onPath) for (let i = 1; i < r.p.length; i++) {
    const [ax, az] = r.p[i - 1], [bx, bz] = r.p[i], n = Math.ceil(Math.hypot(bx - ax, bz - az) / 20);
    for (let k = 0; k <= n; k++) cells.add(Math.floor((ax + (bx - ax) * k / n) / C) + ',' + Math.floor((az + (bz - az) * k / n) / C));
  }
  const near = ([x, z]) => x > -83000 && cells.has(Math.floor(x / C) + ',' + Math.floor(z / C));
  const ends = new Set(), begins = new Set();
  for (const r of roads) { begins.add(K(r.p[0])); ends.add(K(r.p[r.p.length - 1])); }
  let checked = 0;
  for (const r of roads) if (r.t === 'motorway' && r.ow) {
    const a = r.p[0], b = r.p[r.p.length - 1];
    if (near(b) && b[0] < 6500) { checked++; assert.ok(begins.has(K(b)), `a motorway dead-ends at ${K(b)}`); }
    if (near(a) && a[0] < 6300) { checked++; assert.ok(ends.has(K(a)), `a motorway begins from nothing at ${K(a)}`); }
  }
  assert.ok(checked > 800, `only ${checked} ends checked`);
});

test('ecoduct ids sit at the top of their own tile block, in a fixed order, whatever order the tiles come in', () => {
  const man = JSON.parse(readFileSync(new URL('../public/data/manifest.json', import.meta.url), 'utf8'));
  const IDS = 1 << 20;
  const slot = (tx, tz) => man.tiles.findIndex((t) => t.tx === tx && t.tz === tz) + 1;   // geo.js: slot i + 1
  const index = (order) => {
    const ids = new Map();
    for (const [tx, tz] of order) {
      const top = (slot(tx, tz) + 1) * IDS;
      const roads = withRoadPatches(tileJson(tx, tz).roads, tx, tz, top);
      const own = roads.length - ECO.filter((q) => q.tx === tx && q.tz === tz).length;
      for (const r of roads.slice(own)) {
        assert.ok(r._id < top && r._id >= top - 8, 'not at the top of the block');
        assert.ok(r._id > slot(tx, tz) * IDS + own + 1e5, 'the block is crowded');
        ids.set(K(r.p[0]), r._id);
      }
    }
    return ids;
  };
  const a = index([[-7, -3], [-3, -3]]), b = index([[-3, -3], [-7, -3]]);
  assert.equal(a.size, 4);
  assert.deepEqual([...a].sort(), [...b].sort());
  // two patches in one tile: the first listed gets top - 1, the next top - 2
  const top = 9 * IDS, two = withRoadPatches([], -7, -3, top);
  assert.deepEqual(two.map((r) => r._id), [top - 1, top - 2]);
  assert.ok(two[0].p[1][0] > two[0].p[0][0], 'the eastbound patch is not the first');
});

test('the road under each ecoduct is one smooth grade once its trench is dug, and a hump without it', async () => {
  const { Terrain } = await import('../js/terrain.js');
  const { makeStamp, applyStamp, STAMP_REGIONS } = await import('../js/terrainstamps.js');
  const geo = await import('../js/geo.js');
  const { readFile } = await import('node:fs/promises');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    try {
      const buf = await readFile(new URL('../public/' + String(url).replace(/^\//, ''), import.meta.url));
      return { ok: true, status: 200, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
    } catch { return { ok: false, status: 404 }; }
  };
  const T = new Terrain();
  try {
    for (const { road } of ECO) T.ensure(road.p[0][0], road.p[0][1], 500);
    for (let i = 0; T._pending.size && i < 500; i++) await new Promise((r) => setTimeout(r, 10));
  } finally { globalThis.fetch = realFetch; }
  assert.equal(T._pending.size, 0, 'the height maps did not load');
  // the game's terrain digs the trenches once terrainstamps.js lists them;
  // until then this applies them on top of it (and says so)
  const cuts = ecoductCuts().map(makeStamp);
  const wired = ecoductCuts().every((c) => STAMP_REGIONS.some((g) => {
    const [x, z] = c.pts[1]; const b = g.box; return x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1;
  }));
  // (stampDelta as Terrain has it: geo.levelWay pins a road to ground a stamp
  // dug, and a stand-in without it hid a 0.6 m kink at the end of a trench)
  const stamped = (x, z) => { let h = T.heightAt(x, z); for (const s of cuts) h = applyStamp(s, x, z, h); return h; };
  const dug = wired ? T : { ready: (x, z) => T.ready(x, z), get _loads() { return T._loads; },
    stampDelta: (x, z) => stamped(x, z) - T.heightAt(x, z), heightAt: stamped };
  if (!wired) test.diagnostic?.('ecoductCuts() are not in terrainstamps.js yet: applied by the test');
  const all = [-7, -4, -3].flatMap((tx) => tileJson(tx, -3).roads);
  const grade = (patch, terrain) => {
    const a = patch.p[0], b = patch.p[patch.p.length - 1];
    const A = structuredClone(all.find((o) => o.t === 'motorway' && K(o.p[o.p.length - 1]) === K(a)));
    const B = structuredClone(all.find((o) => o.t === 'motorway' && K(o.p[0]) === K(b)));
    const P = structuredClone(patch);
    const roads = [A, P, B];
    for (const r of roads) { r._len = lenOf(r.p); r.w += 1.5; r._paved = true; }
    geo.indexJunctions(roads);
    // 150 m either side (or the whole approach way): past the trench's ends,
    // where its floor has to give way to the survey again
    const OUT = 150, ys = [];
    for (let s = Math.max(0, A._len - OUT); s < A._len; s += 2) ys.push(geo.roadGradeY(A, s, terrain));
    const i0 = ys.length;
    for (let s = 0; s < P._len; s += 2) ys.push(geo.roadGradeY(P, s, terrain));
    const i1 = ys.length;
    ys.push(geo.roadGradeY(P, P._len, terrain));
    for (let s = 2; s <= Math.min(OUT, B._len); s += 2) ys.push(geo.roadGradeY(B, s, terrain));
    const step = Math.max(Math.abs(geo.roadGradeY(A, A._len, terrain) - geo.roadGradeY(P, 0, terrain)),
      Math.abs(geo.roadGradeY(P, P._len, terrain) - geo.roadGradeY(B, 0, terrain)));
    let curv = 0, over = 0;
    for (let i = 1; i + 1 < ys.length; i++) curv = Math.max(curv, Math.abs(ys[i + 1] - 2 * ys[i] + ys[i - 1]));
    // how far the patch rises over the line between the approaches 40 m out
    const j0 = Math.max(0, i0 - 20), j1 = Math.min(ys.length - 1, i1 + 20);
    for (let i = i0; i <= i1; i++) over = Math.max(over, ys[i] - (ys[j0] + (ys[j1] - ys[j0]) * (i - j0) / (j1 - j0)));
    return { curv, over, step, mid: ys[(i0 + i1) >> 1] };
  };
  for (const { road } of ECO) {
    const raw = grade(road, T), cut = grade(road, dug);
    // the elevation model holds the green bridge's earth: undug, the road climbs it
    if (!wired) assert.ok(raw.over > 5, `no mound under ${K(road.p[0])}? (${raw.over.toFixed(2)} m)`);
    assert.ok(cut.step < 0.01, `a step of ${cut.step.toFixed(3)} m at a join`);
    assert.ok(cut.over < 0.5, `the patch rides ${cut.over.toFixed(2)} m over its approaches`);
    // (0.058 is the median bend at an ordinary join of two D11 ways; the
    // worst 300 m of the D11 near the ecoducts bends 0.142)
    assert.ok(cut.curv < 0.06, `the grade bends ${cut.curv.toFixed(3)} m per 2 m step`);
    // …and the earth either side of the trench stays for the deck to rest on
    const [mx, mz] = road.p[road.p.length >> 1], [ax, az] = road.p[0], [bx, bz] = road.p[road.p.length - 1];
    const L = Math.hypot(bx - ax, bz - az), nx = -(bz - az) / L, nz = (bx - ax) / L;
    const side = Math.max(dug.heightAt(mx + nx * 28, mz + nz * 28), dug.heightAt(mx - nx * 28, mz - nz * 28));
    assert.ok(side > cut.mid + 5, `no ecoduct earth beside the trench (${(side - cut.mid).toFixed(1)} m)`);
  }
});
