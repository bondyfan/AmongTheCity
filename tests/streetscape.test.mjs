// ---- what stands on a street, and where --------------------------------------
// The streetscape pass made lamps, signs, furniture and café terraces out of
// data the tiles already held. Geometry can only be judged on screen; what can
// be pinned here is the LOGIC that decides where things go: a lamp reaches
// over the road it belongs to, a whole street is lit rather than its first
// hundred metres, a sign stands on the right-hand kerb facing the driver it
// speaks to, and nothing is ever put on a carriageway.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { plannedSigns, crossingSigns } = await import('../js/streetsigns.js');
const { terracePlan, terraceOpen } = await import('../js/terraces.js');
const { cellUV, SIGNS, PANELS } = await import('../js/signfaces.js');
const { lampGeoms, HEAD_OUT, HEAD_Y } = await import('../js/streetlamps.js');
const { box } = await import('../js/propkit.js');
const { propFacing, SEAT_H } = await import('../js/furniture.js');

const G = 220;
function chunk(roads, extra = {}, cx = 0, cz = 0) {
  roads.forEach((r, i) => { r._id ??= i + 1; r._home ??= '0,0'; });
  const cell = { buildings: [], roads, rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [], furniture: [], venues: [], ...extra };
  const index = new Map([['0,0', cell], ['1,0', cell]]);
  const city = { chunkIndex: index, tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: () => G };
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
  return buildChunkMeshes(city, cx, cz, mats, 'full');
}
const spotsOf = (g, name) => {
  const o = g?.getObjectByName(name), f = o?.userData.spots ?? [], out = [];
  for (let i = 0; i + 2 < f.length; i += 3) out.push([f[i], f[i + 1], f[i + 2]]);
  return out;
};

test('a street lamp holds its head over the carriageway, not along the kerb', () => {
  const g = chunk([{ t: 'primary', w: 9, d: 1, v: 50, p: [[2, 60], [118, 60]] }]);
  const spots = spotsOf(g, 'lampPosts');
  assert.ok(spots.length >= 2, 'no lamps along a 116 m street');
  for (const [x, z, rot] of spots) {
    // the head is HEAD_OUT along the instance's local -z, which a yaw of `rot`
    // carries to (-sin rot, -cos rot)
    const hz = z - Math.cos(rot) * HEAD_OUT, hx = x - Math.sin(rot) * HEAD_OUT;
    assert.ok(Math.abs(z - 60) > 4.5, `the column at ${z.toFixed(1)} stands in the road`);
    assert.ok(Math.abs(hz - 60) < 4.5, `the head at z ${hz.toFixed(1)} is not over the 9 m carriageway`);
    assert.ok(Math.abs(hx - x) < 0.05, 'the arm runs along the kerb');
  }
  // and the template really does reach that far, that high, toward -z
  const lens = lampGeoms('street')[1].attributes.position;
  let zmin = 0, y = 0;
  for (let i = 0; i < lens.count; i++) { zmin = Math.min(zmin, lens.getZ(i)); y = Math.max(y, lens.getY(i)); }
  assert.ok(Math.abs(-zmin - HEAD_OUT) < 0.4 && Math.abs(y - HEAD_Y) < 0.15,
    `the lens sits at ${(-zmin).toFixed(2)} m out, ${y.toFixed(2)} m up: lightpools.js is told ${HEAD_OUT}, ${HEAD_Y}`);
});

test('a street is lit for its whole length, not only in the cell it starts in', () => {
  // one way that begins in cell 0,0 and runs on through 1,0: the second cell
  // used to get no lamps at all, which is why residential streets were black
  const road = () => [{ t: 'residential', w: 5.5, d: 1, v: 30, p: [[10, 60], [230, 60]] }];
  const here = spotsOf(chunk(road(), {}, 0, 0), 'lampPosts');
  const next = spotsOf(chunk(road(), {}, 1, 0), 'lampPosts');
  assert.ok(here.length >= 2, 'the home cell lost its lamps');
  assert.ok(next.length >= 2, `the next cell along got ${next.length} lamps`);
  for (const [x] of next) assert.ok(x >= 120 && x < 240, 'a cell placed a lamp outside itself');
  // the two cells walk the way identically, so the spacing carries across
  const xs = [...here, ...next].map((s) => s[0]).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 34) < 0.01, 'the 34 m rhythm broke at the cell edge');
});

test('a surveyed lamp becomes a lit lamp, and the rule stands down beside it', () => {
  const roads = [{ t: 'primary', w: 9, d: 1, v: 50, p: [[2, 60], [118, 60]] }];
  const rule = spotsOf(chunk(roads.map((r) => ({ ...r }))), 'lampPosts');
  const [rx] = rule[0];
  const furniture = [
    { p: [[rx + 3, 65.6]], k: 'lamp', _id: 900 },        // by the kerb: a street column
    { p: [[60, 100]], k: 'lamp', _id: 901 },             // off in a park: a lantern
  ];
  const g = chunk(roads.map((r) => ({ ...r })), { furniture });
  const street = spotsOf(g, 'lampPosts'), park = spotsOf(g, 'parkPosts');
  assert.ok(street.some(([x, z]) => Math.abs(x - rx - 3) < 0.01 && Math.abs(z - 65.6) < 0.01), 'the surveyed column is missing');
  assert.ok(!street.some(([x]) => Math.abs(x - rx) < 0.01), 'the rule doubled a surveyed lamp 3 m away');
  assert.equal(park.length, 1, 'the lamp away from any road is not a lantern');
  // it faces the road: the head over z = 60
  const [x, z, rot] = street.find(([sx]) => Math.abs(sx - rx - 3) < 0.01);
  assert.ok(Math.abs(z - Math.cos(rot) * HEAD_OUT - 60) < 4.5, 'the surveyed column turned its back on the road');
  assert.ok(x > 0);
  // lamps stand where the mesher says: every batch carries one height a lamp
  for (const n of ['lampPosts', 'parkPosts']) {
    const o = g.getObjectByName(n);
    assert.equal(o.userData.ys.length * 3, o.userData.spots.length);
    for (const y of o.userData.ys) assert.ok(y >= G && y < G + 0.6, `a lamp base at ${y}`);
  }
});

test('derived signs stand on the right-hand kerb and face the driver', () => {
  const r = { _id: 4, _home: '0,0', t: 'residential', w: 6, d: 1, ow: 1, v: 30, _len: 112, p: [[4, 60], [116, 60]] };
  const cell = { roads: [r], signs: [] };
  const out = plannedSigns(cell, '0,0', [], () => false, () => '0,0');
  const by = (k) => out.find((q) => q[4] === k);
  const oneWay = by('one_way'), noEntry = by('no_entry');
  assert.ok(oneWay && noEntry, 'a one-way street got no one-way and no-entry pair');
  // travel is +x; right of +x is +z in this world (x east, z south)
  assert.ok(oneWay[1] > 63 && oneWay[2] === 1, 'IP 4a is not on the right of the way in');
  assert.ok(noEntry[1] < 57 && noEntry[2] === -1, 'B 2 does not face the driver coming the wrong way');
  assert.ok(by('zone30'), 'the 30 zone is not signed');
  // nothing is planned where the post would stand on another carriageway
  assert.equal(plannedSigns(cell, '0,0', [], () => true, () => '0,0').length, 0);
  // …or in somebody else's cell
  assert.equal(plannedSigns(cell, '0,0', [], () => false, () => '9,9').length, 0);
});

test('a zebra is announced once per approach', () => {
  const out = [];
  crossingSigns(50, 60, 1, 0, { w: 8 }, () => false, out);
  assert.equal(out.length, 2);
  assert.ok(out[0][0] < 50 && out[0][1] > 64, 'the first plate is not before the zebra on the right kerb');
  assert.ok(out[1][0] > 50 && out[1][1] < 56);
  const one = [];
  crossingSigns(50, 60, 1, 0, { w: 8, ow: 1 }, () => false, one);
  assert.equal(one.length, 1, 'a one-way street was signed against the flow');
});

test('a terrace goes out through the wall, along the facade, and never on a road', () => {
  const cell = {
    roads: [{ d: 1, w: 7, t: 'tertiary', p: [[0, 80], [120, 80]] }],
    buildings: [{ o: [[40, 40], [70, 40], [70, 70], [40, 70]] }],
  };
  const onRoad = (x, z, m) => Math.abs(z - 80) < 3.5 + m;
  const plan = terracePlan(cell, 55, 55, 0.5, onRoad);
  assert.ok(plan && plan.spots.length >= 2, 'a café 10 m from the kerb put out no tables');
  for (const [x, z] of plan.spots) {
    assert.ok(z > 70.5 && z < 75.6, `a table at z ${z.toFixed(1)} is in the wall or on the road`);
    assert.ok(x > 40 && x < 70);
  }
  assert.ok(Math.abs(plan.fx) > 0.99, 'the row does not run along the facade');
  // a café whose wall IS the kerb line has nowhere legal to put one
  const tight = { roads: cell.roads, buildings: [{ o: [[40, 40], [70, 40], [70, 76.4], [40, 76.4]] }] };
  assert.equal(terracePlan(tight, 55, 60, 0.5, onRoad), null);
  // same venue, same terrace: nothing random in it
  assert.deepEqual(terracePlan(cell, 55, 55, 0.5, onRoad), plan);
  // a table is not laid over something surveyed on that pavement (a memorial
  // stood in the middle of one terrace, the parasol growing out of it)
  const [tx, tz] = plan.spots[0];
  const busy = { ...cell, furniture: [{ k: 'memorial', p: [[tx + 0.4, tz - 0.3]] }] };
  const left = terracePlan(busy, 55, 55, 0.5, onRoad);
  assert.equal(left.spots.length, plan.spots.length - 1, 'a table was set on top of a memorial');
});

test('terraces are out by day and in by night', () => {
  assert.equal(terraceOpen(0.5), true);
  assert.equal(terraceOpen(0.0), false);
  assert.equal(terraceOpen(0.95), false);
});

test('every face of the street atlas has its own patch of canvas', () => {
  const rects = [];
  for (const n of Object.keys(SIGNS)) { rects.push([n, [...cellUV(n)]]); rects.push(['back:' + n, [...cellUV('back:' + n)]]); }
  for (const n of Object.keys(PANELS)) rects.push([n, [...cellUV(n)]]);
  for (const [n, [u0, v0, u1, v1]] of rects) {
    assert.ok(u0 >= 0 && v0 >= 0 && u1 <= 1 && v1 <= 1 && u1 > u0 && v1 > v0, `${n} is off the canvas`);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i][1], b = rects[j][1];
      const apart = a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1];
      assert.ok(apart, `${rects[i][0]} and ${rects[j][0]} share canvas`);
    }
  }
});

test('a prop box faces outward on every side', () => {
  // the old furniture box was wound inside out: with back faces culled a bench
  // was drawn as the inside of itself
  const tris = [];
  const sink = {
    tri(ax, ay, az, bx, by, bz, cx, cy, cz) { tris.push([ax, ay, az, bx, by, bz, cx, cy, cz]); },
    quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz) {
      this.tri(ax, ay, az, bx, by, bz, cx, cy, cz); this.tri(ax, ay, az, cx, cy, cz, dx, dy, dz);
    },
  };
  box(sink, 10, 5, 20, 2, 1, 3, 0.7, 1, 1, 1, true);
  assert.equal(tris.length, 12);
  for (const [ax, ay, az, bx, by, bz, cx, cy, cz] of tris) {
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const mx = (ax + bx + cx) / 3 - 10, my = (ay + by + cy) / 3 - 5.5, mz = (az + bz + cz) / 3 - 20;
    assert.ok(nx * mx + ny * my + nz * mz > 0, 'a face looks into the box');
  }
});

test('a bench says where its sitter sits and which way they look', () => {
  // the contract the crowd code relies on: seat on the node, SEAT_H up, the
  // sitter looking along (sin h, cos h), toward the nearest way
  const cell = { roads: [{ p: [[0, 50], [100, 50]] }] };
  const h = propFacing(cell, { p: [[40, 40]], k: 'bench' });
  assert.ok(Math.abs(Math.sin(h)) < 1e-6 && Math.cos(h) > 0.999, 'the bench does not face the path 10 m south of it');
  assert.ok(Math.abs(propFacing(cell, { p: [[40, 40]], k: 'bench', a: 90 }) - Math.PI / 2) < 1e-9);
  assert.ok(SEAT_H > 0.4 && SEAT_H < 0.5);
});
