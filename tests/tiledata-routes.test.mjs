// ---- the real bus, trolleybus and tram lines (docs/TILE-FORMAT.md) ------------
// The lines the game runs used to be derived from stops and the road graph.
// Round 5 took the real ones out of OSM's route relations, and js/buses.js and
// the trolleybuses are built on what this pins:
//
//   1. a relation becomes an ordered path with honest gaps and its calls in
//      order (scripts/lib/routes.mjs), and js/tiledata.js decodes it back
//   2. one route is collected once from seven overlapping regional extracts
//      (scripts/lib/route-collect.mjs)
//   3. the route files on disk are whole, and Pardubice has its trolleybuses
// The other round-5 fields are in tests/tiledata.test.mjs.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TD = await import('../js/tiledata.js');
const { buildRoutes, lineColour } = await import('../scripts/lib/routes.mjs');
const { RouteCollector } = await import('../scripts/lib/route-collect.mjs');

const PUBLIC = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const readJSON = (rel) => JSON.parse(readFileSync(path.join(PUBLIC, rel), 'utf8'));

// ---- relation in, ordered path out --------------------------------

/** A tiny world: metres are degrees * 1e5 so the numbers stay readable. */
const env = {
  px: (lon) => +(lon * 1e5).toFixed(1), pz: (lat) => +(-lat * 1e5).toFixed(1),
  simplify: (pts) => pts, TILE: 4800, tileWanted: (tx, tz) => tx === 0 && tz === -1,
  roadClass: (v) => v === 'tertiary' || v === 'residential',
};
const ll = (x, z) => [-z / 1e5, x / 1e5];
const way = (pts, c = 'h:tertiary', f = 0) => ({ f, c, g: pts.map(([x, z]) => ll(x, z)) });
function miniWorld() {
  const ways = {
    1: way([[100, -100], [200, -100]]),
    2: way([[300, -100], [200, -100]]),                       // drawn against the direction of travel
    // a roundabout, drawn clockwise on the map from its west point: entered at
    // the west, left at the east, so the route keeps the northern arc
    3: way([[300, -100], [310, -110], [320, -100], [310, -90], [300, -100]], 'h:tertiary', 8),
    4: way([[320, -100], [400, -100]]),
    5: way([[600, -100], [700, -100]]),                       // does not touch way 4: a gap
    6: way([[700, -100], [700, -200]], 'h:tertiary', 1),      // a tunnel
    7: way([[40, -95], [60, -95], [60, -92], [40, -92], [40, -95]], 'h:platform', 16),
  };
  ways[7].n = 'Nádraží';
  const node = (x, z, t) => ({ p: ll(x, z), t });
  const nodes = {
    11: node(110, -100, { public_transport: 'stop_position', name: 'Nádraží' }),
    12: node(112, -96, { highway: 'bus_stop', name: 'Nádraží' }),
    13: node(390, -96, { highway: 'bus_stop', name: 'Náměstí' }),
    14: node(690, -104, { highway: 'bus_stop', name: 'Škola' }),   // on the LEFT of travel
    15: node(700, -190, { highway: 'bus_stop', name: 'Konečná' }),
  };
  const members = [['n', 11, 'stop_entry_only'], ['n', 12, 'platform_entry_only'], ['n', 13, 'platform'],
    ['n', 14, 'platform'], ['n', 15, 'platform_exit_only'],
    ['w', 1, ''], ['w', 2, ''], ['w', 3, ''], ['w', 4, ''], ['w', 5, ''], ['w', 6, '']];
  return {
    v: 1, ways, nodes,
    routes: [
      { id: 900, tags: { type: 'route', route: 'trolleybus', ref: '5', name: '5: A - B', from: 'A', to: 'B', network: 'MHD' }, members },
      // the same streets again: the second route must reuse the legs and the stops
      { id: 901, tags: { type: 'route', route: 'bus', ref: '9' }, members: members.filter((m) => m[1] !== 13) },
      // only one call inside the world: nobody's line
      { id: 902, tags: { type: 'route', route: 'bus', ref: 'X' }, members: [['n', 11, 'stop'], ['w', 1, '']] },
      // a legacy relation: stops with no role, a way of the other direction
      { id: 903, tags: { type: 'route', route: 'bus', ref: 'L' }, members: [['n', 12, ''], ['w', 1, 'forward'], ['w', 5, 'backward'], ['w', 2, ''], ['n', 13, '']] },
    ],
    masters: [{ id: 77, tags: { type: 'route_master', route_master: 'trolleybus', ref: '5', colour: 'red' }, members: [900] }],
  };
}

test('member ways are turned to follow each other, a roundabout gives one arc, a break is a gap', () => {
  const { files, tileIndex, stats } = buildRoutes(miniWorld(), env);
  assert.deepEqual([...files.keys()], ['0_-1'], 'owned by the tile of the first call');
  const file = files.get('0_-1');
  assert.equal(stats.kept, 3);
  assert.equal(stats.outside, 0);
  assert.equal(stats.noStops, 1, 'one call is not a line');
  const r = file.routes.find((q) => q.id === 900);
  assert.equal(r.m, TD.MODE_TROLLEYBUS);
  assert.deepEqual([r.ref, r.n, r.fr, r.to, r.nw, r.ms], ['5', '5: A - B', 'A', 'B', 'MHD', 77]);
  assert.equal(r.c, '#ff0000', 'the colour comes down from the route master');
  // way 1 forward, way 2 BACKWARDS, the arc, way 4, a gap, way 5, way 6
  assert.deepEqual(r.p.map(Math.sign), [1, -1, 1, 1, 0, 1, 1]);
  assert.equal(r.g, 1);
  const { pts, cuts, flags } = TD.routePath(file, r);
  const xz = [];
  for (let i = 0; i < pts.length; i += 2) xz.push(pts[i] + ',' + pts[i + 1]);
  assert.deepEqual(xz, ['100,-100', '200,-100', '300,-100', '310,-110', '320,-100', '400,-100',
    '600,-100', '700,-100', '700,-200'], 'one line, joints not doubled, the northern arc only');
  assert.deepEqual(cuts, [6], 'the piece after the gap starts at point 6');
  assert.equal(flags.length, xz.length);
  assert.equal(flags[7] & TD.LEG_TUNNEL, TD.LEG_TUNNEL, 'the segment leaving point 7 is the tunnel');
  assert.equal(flags[7] & TD.LEG_OFF_ROAD_LAYER, TD.LEG_OFF_ROAD_LAYER, 'and a tunnel is not in the road layer');
  assert.equal(flags[0], 0);
  let L = 0;
  for (let i = 2; i < pts.length; i += 2) L += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  assert.equal(r.L, Math.round(L), 'L is the length of the decoded line, the jump over the gap included');
  assert.deepEqual(r.bb, [100, -200, 700, -96], 'the box holds the path and the calls');
  assert.ok(TD.routeNear(r, 900, -100, 250) && !TD.routeNear(r, 1000, -100, 250));
  assert.deepEqual([...tileIndex.keys()], ['0_-1']);
  assert.deepEqual([...tileIndex.get('0_-1')], ['0_-1']);
});

test('a stop position and its platform are one call, and calls lie along the path in order', () => {
  const { files } = buildRoutes(miniWorld(), env);
  const file = files.get('0_-1');
  const r = file.routes.find((q) => q.id === 900);
  const calls = TD.routeStops(file, r);
  assert.deepEqual(calls.map((c) => c.n), ['Nádraží', 'Náměstí', 'Škola', 'Konečná']);
  // the first call has both halves: x,z on the carriageway, px,pz the pole
  assert.deepEqual([calls[0].k, calls[0].x, calls[0].z, calls[0].px, calls[0].pz], [3, 110, -100, 112, -96]);
  assert.equal(calls[0].f, TD.CALL_ENTRY_ONLY);
  assert.equal(calls[3].f, TD.CALL_EXIT_ONLY);
  // a platform alone: x,z IS the platform
  assert.deepEqual([calls[1].k, calls[1].x, calls[1].z, calls[1].px, calls[1].pz], [2, 390, -96, 390, -96]);
  // arcs: 10 m in; then 200 + the arc (2 * 14.14) + 70; then over the gap; then the end
  assert.equal(calls[0].d, 10);
  assert.equal(calls[1].d, Math.round(200 + 2 * Math.hypot(10, 10) + 70));
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i].d > calls[i - 1].d, 'in order');
  assert.ok(calls[3].d <= r.L);
  // the second route shares every leg and every stop entry it can
  const r2 = file.routes.find((q) => q.id === 901);
  assert.deepEqual(r2.p, r.p);
  assert.deepEqual(r2.s, r.s.filter((_, i) => i !== 1));
  assert.equal(file.legs.length, 6, 'six ways, six legs, whoever uses them');
  // the legacy relation: unroled stops read from their tags, the backward way skipped
  const r3 = file.routes.find((q) => q.id === 903);
  // its first call is the pole alone, which is a different entry from the pole
  // paired with its stop position: four calls of the line above plus this one
  assert.equal(file.stops.length, 5);
  assert.deepEqual(file.stops[r3.s[0]], ['Nádraží', 2, 112, -96]);
  assert.deepEqual(TD.routeStops(file, r3).map((c) => c.n), ['Nádraží', 'Náměstí']);
  assert.equal(r3.p.length, 2);
  assert.ok(!r3.g);
  // a stop the mapped path never comes near keeps its place in the order, gets
  // an arc between its neighbours and says that the arc is a guess
  const w = miniWorld();
  w.nodes[16] = { p: ll(250, -600), t: { highway: 'bus_stop', name: 'Jinde' } };
  w.routes[0].members.splice(2, 0, ['n', 16, 'platform']);
  const f2 = buildRoutes(w, env).files.get('0_-1');
  const c2 = TD.routeStops(f2, f2.routes.find((q) => q.id === 900));
  assert.deepEqual(c2.map((c) => c.n), ['Nádraží', 'Jinde', 'Náměstí', 'Škola', 'Konečná']);
  assert.equal(c2[1].f, TD.CALL_OFF_PATH);
  assert.ok(c2[1].d > c2[0].d && c2[1].d < c2[2].d);
  assert.deepEqual([c2[1].x, c2[1].z], [250, -600]);
  assert.equal(c2[2].f, 0);
});

test('a leg is the way in whole decimetres and decodes either way round', () => {
  const leg = [0, 1000, -2000, 15, -5, 100, 0];
  assert.deepEqual(TD.legPoints(leg), [100, -200, 101.5, -200.5, 111.5, -200.5]);
  assert.deepEqual(TD.legPoints(leg, true), [111.5, -200.5, 101.5, -200.5, 100, -200]);
  const out = [1, 2];
  TD.legPoints(leg, true, out);
  assert.deepEqual(out.slice(0, 4), [1, 2, 111.5, -200.5], 'appends');
  assert.deepEqual(TD.routePath({ legs: [leg] }, { p: [0, 1, 0, 0, -1] }), {
    pts: [100, -200, 101.5, -200.5, 111.5, -200.5, 111.5, -200.5, 101.5, -200.5, 100, -200],
    cuts: [3], flags: [0, 0, 0, 0, 0, 0],
  }, 'a leading gap is no cut; a gap between two pieces keeps both ends');
});

test('a route is collected once however many extracts hold a piece of it', () => {
  const c = new RouteCollector();
  const tags = { type: 'route', route: 'bus', ref: '1' };
  const members = [{ type: 'node', ref: 5, role: 'platform' }, { type: 'way', ref: 10, role: '' }, { type: 'way', ref: 20, role: '' }];
  // extract A knows way 10 and the stop, extract B knows way 20
  c.node(5, { highway: 'bus_stop', name: 'U Kostela' });
  c.way(10, { highway: 'tertiary', bridge: 'yes' });
  assert.ok(c.relation(1, members, tags, { way: (r) => (r === 10 ? [{ lat: 50, lon: 15 }, { lat: 50.001, lon: 15 }] : null), node: () => [50, 15] }));
  c.endExtract();
  c.way(20, { highway: 'residential', tunnel: 'yes', oneway: '-1' });
  assert.ok(c.relation(1, members, tags, { way: (r) => (r === 20 ? [{ lat: 50.001, lon: 15 }, { lat: 50.002, lon: 15 }] : null), node: () => null }));
  assert.ok(!c.relation(2, [], { type: 'multipolygon', building: 'yes' }, {}), 'not a route: left to the splitter');
  assert.ok(!c.relation(3, [], { type: 'route', route: 'hiking' }, {}));
  assert.ok(c.relation(4, [{ type: 'relation', ref: 1, role: '' }], { type: 'route_master', route_master: 'bus' }, {}));
  const raw = JSON.parse(c.toJSON());
  assert.equal(raw.routes.length, 1);
  assert.deepEqual(raw.routes[0].members, [['n', 5, 'platform'], ['w', 10, ''], ['w', 20, '']]);
  assert.deepEqual([raw.ways[10].f, raw.ways[10].c], [2, 'h:tertiary']);
  assert.deepEqual([raw.ways[20].f, raw.ways[20].c], [1 | 64, 'h:residential']);
  assert.equal(raw.nodes[5].t.name, 'U Kostela');
  assert.deepEqual(raw.masters[0].members, [1]);
  assert.equal(lineColour('#0AF'), '#00aaff');
  assert.equal(lineColour('ED1C24'), '#ed1c24');
  assert.equal(lineColour('green'), '#008000');
  assert.equal(lineColour('stripes'), null);
});

// ---- what is on disk ---------------------------------------------------------

const manifest = readJSON('data/manifest.json');
const haveRoutes = !!manifest.routes && existsSync(path.join(PUBLIC, 'data/routes/0_-1.json'));

test('Pardubice has its trolleybuses and buses, whole and in order', { skip: !haveRoutes && 'no route files built' }, () => {
  const lines = new Map();
  const dir = manifest.routes;
  const keys = new Set();
  for (const t of manifest.tiles) if (Math.abs(t.tx) <= 2 && Math.abs(t.tz) <= 2) for (const k of t.rt ?? []) keys.add(k);
  let all = 0;
  for (const k of keys) {
    const file = readJSON(`${dir}${k}.json`);
    assert.equal(file.v, 1);
    assert.equal(file.tx + '_' + file.tz, k);
    for (const r of file.routes) {
      all++;
      // structure, for every route of every file near the city
      assert.ok(r.s.length >= 2 && r.sd.length === r.s.length && r.bb.length === 4);
      for (const i of r.s) assert.ok(file.stops[i], 'a call names a stop of this file');
      for (const ref of r.p) assert.ok(ref === 0 || file.legs[Math.abs(ref) - 1], 'a path names a leg of this file');
      for (let i = 1; i < r.sd.length; i++) assert.ok(r.sd[i] >= r.sd[i - 1], `route ${r.id}: calls out of order`);
      if (r.nw !== 'MHD Pardubice') continue;
      const key = TD.ROUTE_MODES[r.m] + ' ' + r.ref;
      if (!lines.has(key)) lines.set(key, []);
      lines.get(key).push({ file, r });
    }
  }
  assert.ok(all >= 60);
  const trolley = [...lines.keys()].filter((k) => k.startsWith('trolleybus ')).map((k) => k.slice(11)).sort((a, b) => a - b);
  const bus = [...lines.keys()].filter((k) => k.startsWith('bus ')).map((k) => k.slice(4));
  for (const ref of ['1', '2', '3', '4', '5', '7', '11', '13']) assert.ok(trolley.includes(ref), `trolleybus ${ref} of ${trolley}`);
  for (const ref of ['6', '8', '9', '10', '16', '18']) assert.ok(bus.includes(ref), `bus ${ref}`);
  // the city network is mapped completely: no gaps, every line has its path
  for (const list of lines.values()) for (const { file, r } of list) {
    assert.ok(!r.g, `line ${r.ref} (${r.id}) has ${r.g} gaps`);
    const { pts, cuts } = TD.routePath(file, r);
    assert.equal(cuts.length, 0);
    assert.ok(pts.length > 40 && r.L > 2500 && r.L < 25000, `line ${r.ref} is ${r.L} m`);
    const calls = TD.routeStops(file, r);
    for (const c of calls) assert.ok(c.n, `line ${r.ref}: a stop with no name`);
    assert.ok(calls[calls.length - 1].d > r.L * 0.9, `line ${r.ref}: the last call is at the end`);
  }
  // line 3 really goes from the main station to the spa town, 9 km to the north-west
  const three = lines.get('trolleybus 3').map(({ file, r }) => TD.routeStops(file, r));
  const out = three.find((c) => c[0].n === 'Hlavní nádraží');
  assert.ok(out, 'trolleybus 3 starts at the main station');
  assert.match(out[out.length - 1].n, /Lázně Bohdaneč/);
  assert.ok(Math.hypot(out[0].x - 25, out[0].z + 122) < 400, 'and the main station is where the game spawns');
  assert.ok(out[out.length - 1].x < -5000 && out[out.length - 1].z < -4000);
  // both directions of a line exist as separate routes
  assert.ok(lines.get('trolleybus 5').length >= 2);
});

