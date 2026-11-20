// ---- a prop beside a path stands on the ground, not at the path's level ------
// A street lamp is planted just off the kerb, and what it stands on is asked of
// meshes.standingOn: the pavement where there is one, a path's slab, the drawn
// ground. A path counted out to 35 cm past its edge, whatever its height, so a
// column a hand off a cycleway that is CARRIED beside the street (on a wall, on
// a terrace) stood at the path's level: 1.9 m over the pavement of 17. listopadu
// north of the Jana Palacha underpass (20 Nov 2026). On the slab, or beside a
// slab that lies on the ground, nothing changed.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');

/** Every street lamp the chunk placed: [x, z, base height]. */
function lamps(roads, heightAt) {
  for (let i = 0; i < roads.length; i++) { roads[i]._id = i + 1; roads[i]._home = '0,0'; }
  const cell = { buildings: [], roads, rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt };
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  const out = [];
  g?.traverse((o) => {
    if (o.name !== 'lampPosts') return;
    const f = o.userData.spots ?? [], ys = o.userData.ys ?? [];
    for (let i = 0; i * 3 + 2 < f.length; i++) out.push([f[i * 3], f[i * 3 + 1], ys[i]]);
  });
  return out;
}
// a 9 m street along x at z = 60; its lamps stand 5.2 m off the centreline
const street = () => ({ t: 'primary', w: 9, d: 1, v: 50, p: [[2, 60], [118, 60]] });
// a cycleway beside its north kerb, its near edge 30 cm past the lamps
const path = () => ({ t: 'cycleway', w: 2.2, d: 0, v: 0, p: [[2, 66.6], [118, 66.6]] });

test('a lamp a hand off a path carried over the street stands on the street\'s side', () => {
  // a terrace: the path runs 2 m over the street, on its wall
  const spots = lamps([street(), path()], (x, z) => (z > 65.4 ? 222 : 220));
  const north = spots.filter(([, z]) => z > 60);
  assert.ok(north.length, 'no lamp on the path\'s kerb: the fixture is wrong');
  for (const [x, z, y] of north) {
    assert.ok(Math.abs(z - 65.2) < 0.01, `the fixture's lamp moved to z = ${z}`);
    assert.ok(y < 220.6, `the lamp at ${x.toFixed(0)}, ${z.toFixed(1)} stands at ${y.toFixed(2)}: the street is at 220.2, the path at 222.16`);
    assert.ok(y > 219.6, 'and not under the street either');
  }
});

test('…and beside a path that lies on the ground it stands where it did', () => {
  const spots = lamps([street(), path()], () => 220);
  const north = spots.filter(([, z]) => z > 60);
  assert.ok(north.length);
  // the path's own level: its slab is the ground there
  for (const [, , y] of north) assert.ok(Math.abs(y - 220.16) < 0.06, `a lamp at ${y.toFixed(2)} beside a path at 220.16`);
});

// ---- the slab a prop stands on is the slab that is drawn -------------------------
// A footway is blended toward the carriageway it runs beside (js/footslab.js),
// and standingOn had a copy of that rule which knew only kerbed streets: on a
// path a step under an un-kerbed road the lamp stood at the path's own level,
// under the paving (1.8 m under it on the riverside path below Povltavská).
const { slabLevel } = await import('../js/footslab.js');

/** The built chunk's surfaces straight under (x, z), top first. */
function drawnAt(group, x, z) {
  const out = [];
  group.updateMatrixWorld(true);
  group.traverse((o) => {
    if (!o.isMesh || o.isInstancedMesh || !o.geometry?.attributes?.position) return;
    const pos = o.geometry.attributes.position, idx = o.geometry.index, n = idx ? idx.count : pos.count;
    const m = o.matrixWorld.elements;
    const P = (i, k) => { const j = idx ? idx.getX(i) : i; return (k === 0 ? pos.getX(j) * m[0] + m[12] : k === 1 ? pos.getY(j) * m[5] + m[13] : pos.getZ(j) * m[10] + m[14]); };
    for (let i = 0; i + 2 < n; i += 3) {
      const ax = P(i, 0), az = P(i, 2), bx = P(i + 1, 0), bz = P(i + 1, 2), cx = P(i + 2, 0), cz = P(i + 2, 2);
      const d = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(d) < 1e-9) continue;
      const u = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / d, v = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / d, w = 1 - u - v;
      if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
      out.push(u * P(i, 1) + v * P(i + 1, 1) + w * P(i + 2, 1));
    }
  });
  return out.sort((a, b) => b - a);
}

test('a lamp on a path beside a higher road stands on the paving that is drawn there', () => {
  // the road at 220, the ground from just past its kerb 0.8 m lower, and a path along the foot of it
  const roads = [street(), { t: 'footway', w: 1.8, d: 0, v: 0, p: [[2, 66], [118, 66]] }];
  for (let i = 0; i < roads.length; i++) { roads[i]._id = i + 1; roads[i]._home = '0,0'; }
  const cell = { buildings: [], roads, rails: [], water: [], green: [], paved: [], trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: (x, z) => (z > 65 ? 219.2 : 220) };
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  let posts = null;
  g.traverse((o) => { if (o.name === 'lampPosts') posts = o; });
  const f = posts.userData.spots, ys = posts.userData.ys;
  let seen = 0;
  for (let i = 0; i * 3 + 2 < f.length; i++) {
    const x = f[i * 3], z = f[i * 3 + 1], y = ys[i];
    if (z < 60) continue;                                   // (the far kerb: no path there)
    seen++;
    assert.ok(Math.abs(z - 65.2) < 0.01, 'the fixture\'s lamp moved');
    const slab = slabLevel(cell, x, 66, 219.2 + 0.16, mats.terrain);
    assert.ok(slab > 219.6, `the fixture's path is not pulled toward the road (slab at ${slab.toFixed(2)})`);
    assert.ok(Math.abs(y - slab) < 0.02, `the lamp stands at ${y.toFixed(2)}, the slab is at ${slab.toFixed(2)} (the path's own level is 219.36)`);
    const under = drawnAt(g, x, z).filter((h) => h <= y + 0.05);
    assert.ok(under.length && y - under[0] < 0.06, `and the paving drawn under it is at ${under[0]?.toFixed(2)}`);
  }
  assert.ok(seen > 0, 'no lamp on the path\'s side');
});

test('no lamp stands in a tram\'s track', () => {
  // a street with a track along its kerb line: every kerb offset on that side falls on the rails
  const roads = [street()];
  for (let i = 0; i < roads.length; i++) { roads[i]._id = i + 1; roads[i]._home = '0,0'; }
  const tram = { t: 'tram', p: [[2, 65.5], [118, 65.5]], _id: 9, _home: '0,0' };
  const build = (rails) => {
    const cell = { buildings: [], roads, rails, water: [], green: [], paved: [], trees: [], signs: [], crossings: [] };
    const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
    const mats = makeMaterials();
    mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: () => 220 };
    mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
    const out = [];
    buildChunkMeshes(city, 0, 0, mats, 'full')?.traverse((o) => {
      if (o.name !== 'lampPosts') return;
      const f = o.userData.spots ?? [];
      for (let i = 0; i * 3 + 2 < f.length; i++) out.push([f[i * 3], f[i * 3 + 1]]);
    });
    return out;
  };
  const before = build([]);
  assert.ok(before.some(([, z]) => Math.abs(z - 65.2) < 0.01), 'the fixture has no lamp where the track will be');
  const spots = build([tram]);
  assert.ok(spots.length, 'the street went dark altogether');
  for (const [x, z] of spots) assert.ok(Math.abs(z - 65.5) >= 1.5, `a lamp at ${x.toFixed(0)}, ${z.toFixed(1)} stands ${Math.abs(z - 65.5).toFixed(2)} m from the track's centreline`);
});
