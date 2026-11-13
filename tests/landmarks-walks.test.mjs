// The ways INTO the landmarks (js/landmarks-walks.js, js/landmarks-valy.js,
// the passages of js/landmarks-zamek.js and js/landmarks-zamekbrana.js),
// against the real tile 0_-1. What can go wrong and shows in no screenshot:
//   · a walk link that starts or ends where no footway does, so the crowd
//     never joins it (the crowd links paths at their ENDS only);
//   · a link, or the player's way to the courtyard, that runs into a wall of
//     the model it is meant to pass through;
//   · a link that depends on the order tiles arrived in, which in co-op puts
//     two clients' crowds on different paths;
//   · the generic wall drawn across the fortress's own gate and bridge.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const { LANDMARKS, matches, landmarkSolids, solidHas, landmarkClear, landmarkBarrier } = await import('../js/landmarks.js');
const { WALKS, landmarkWalks } = await import('../js/landmarks-walks.js');
const { zamekAxis } = await import('../js/landmarks-zamek.js');
const { zamekBranaAxis } = await import('../js/landmarks-zamekbrana.js');

const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/0_-1.json', import.meta.url), 'utf8'));
const found = new Map();
for (const f of tile.buildings) for (const l of LANDMARKS) if (matches(l, f)) found.set(l.id, f);
const footEnds = [];
for (const r of tile.roads) if (!r.d && r.t === 'footway' && r.p.length >= 2) footEnds.push(r.p[0], r.p[r.p.length - 1]);
const isFootEnd = (q) => footEnds.some((p) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.6);

// every ground-level solid of every landmark (the masonry over a passage is walked under)
const walls = [];
for (const f of found.values()) for (const s of landmarkSolids(f) ?? []) if (s.bot <= 0.5) walls.push(s);
const inWall = (x, z) => walls.some((s) => solidHas(s, x, z));

/** Walk a polyline in 25 cm steps, a body's half width either side of it. */
function blocked(pts, half = 0.4) {
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, az] = pts[i], [bx, bz] = pts[i + 1], L = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / L, dz = (bz - az) / L;
    for (let s = 0; s <= L; s += 0.25) for (const o of [-half, 0, half]) {
      const x = ax + dx * s - dz * o, z = az + dz * s + dx * o;
      if (inWall(x, z)) return [x.toFixed(1), z.toFixed(1)];
    }
  }
  return null;
}

test('every walk link starts and ends at the end of a real footway', () => {
  assert.ok(WALKS.length >= 4);
  for (const w of WALKS) {
    const p = w.way.p;
    assert.ok(isFootEnd(w.anchor), `${w.way._id}: its anchor is no footway end in the tile`);
    assert.deepEqual(p[0], w.anchor, `${w.way._id}: does not start at its anchor`);
    // the far end must meet a footway too, or the crowd walks in and turns round
    assert.ok(isFootEnd(p[p.length - 1]), `${w.way._id}: ends where no footway does`);
    assert.equal(w.way.t, 'footway');
    assert.ok(!w.way.d, 'a walk link is not a carriageway');
  }
});

test('the links pass through the gates and touch no wall', () => {
  for (const w of WALKS) assert.equal(blocked(w.way.p), null, `${w.way._id} runs into a wall at ${blocked(w.way.p)}`);
  // ...and they do go THROUGH: each gate's middle is on its link
  const near = (pts, x, z) => {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1], ex = bx - ax, ez = bz - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / (ex * ex + ez * ez)));
      best = Math.min(best, Math.hypot(ax + ex * t - x, az + ez * t - z));
    }
    return best;
  };
  const by = (id) => WALKS.find((w) => w.way._id === 'lmw:' + id).way.p;
  for (const [id, lm] of [['zelena-brana', 'zelena-brana'], ['zelena-brana', 'predbrani'], ['zamek-brana', 'zamek-brana']]) {
    const f = found.get(lm);
    let x = 0, z = 0;
    for (const p of f.o) { x += p[0]; z += p[1]; }
    assert.ok(near(by(id), x / f.o.length, z / f.o.length) < 1.2, `the ${id} link misses the middle of ${lm}`);
  }
  // the palace portal: the link runs the passage's own axis
  const [a, b] = zamekAxis(found.get('zamek'));
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  assert.ok(near(by('zamek-prujezd'), mid[0], mid[1]) < 0.8, 'the courtyard link is off the passage axis');
  const [c, d] = zamekBranaAxis(found.get('zamek-brana'));
  assert.ok(near(by('zamek-brana'), (c[0] + d[0]) / 2, (c[1] + d[1]) / 2) < 0.8, 'the rampart gate link is off its passage axis');
});

test('a player walks from the outer court through the portal into the courtyard', () => {
  const za = found.get('zamek'), [a, b] = zamekAxis(za);
  // from 3 m before the portal to 4 m past the courtyard wall, at a body's width
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]), dx = (b[0] - a[0]) / L, dz = (b[1] - a[1]) / L;
  const path = [[a[0] - dx * 3, a[1] - dz * 3], [b[0] + dx * 4, b[1] + dz * 4]];
  assert.equal(blocked(path, 0.6), null, `the passage is blocked at ${blocked(path, 0.6)}`);
  // the wings beside it are still solid
  assert.ok(inWall(a[0] + dx * 10 - dz * 4, a[1] + dz * 10 + dx * 4) && inWall(a[0] + dx * 10 + dz * 4, a[1] + dz * 10 - dx * 4),
    'the north wing is open beside its passage');
  // and the masonry over the passage is still there for a rocket
  const over = landmarkSolids(za).filter((s) => s.bot > 0.5);
  assert.ok(over.some((s) => solidHas(s, a[0] + dx * 10, a[1] + dz * 10)), 'nothing over the passage');
});

test('the links arrive with the tile that holds their anchor, whatever the order', () => {
  const ids = (roads) => landmarkWalks(roads).map((w) => w._id).sort();
  const all = ids(tile.roads);
  assert.deepEqual([...new Set(all)], WALKS.map((w) => w.way._id).sort(), 'not every link found its anchor');
  // shuffled (deterministically): the same links, the same objects
  const sh = tile.roads.map((r, i) => [((i * 2654435761) >>> 0) % 1009, r]).sort((p, q) => p[0] - q[0]).map((p) => p[1]);
  assert.deepEqual(ids(sh), all);
  const once = landmarkWalks(tile.roads), twice = landmarkWalks(sh);
  for (const w of once) assert.ok(twice.includes(w), 'a link is a new object on the second batch');
  // a batch without the anchors brings nothing, and nothing breaks on none
  assert.deepEqual(landmarkWalks(tile.roads.filter((r) => r.d)), []);
  assert.deepEqual(landmarkWalks(null), []);
});

test('the fortress replaces the generic walls on its own lines, and only those', () => {
  const mine = tile.barriers.filter((b) => landmarkBarrier(b));
  assert.equal(mine.filter((b) => b.k === 'citywall').length, 1, 'the foot wall of the ramparts');
  assert.equal(mine.filter((b) => b.k === 'wall').length, 2, 'the two parapets of the inner moat');
  assert.equal(mine.length, 3);
  // a wall with the same first point but another shape stays generic
  const w = mine.find((b) => b.k === 'wall');
  assert.ok(!landmarkBarrier({ ...w, p: w.p.concat([[0, 0]]) }));
});

test('the doorways of the landmarks are kept clear of trees', () => {
  // in the tower arch, across the little yard, in the chateau gate and courtyard
  for (const [x, z] of [[1565.4, -700.4], [1560, -698], [1532, -1041.3], [1461, -1015]])
    assert.ok(landmarkClear(x, z), `no clear zone at ${x}, ${z}`);
  // a tree on the square beside the gate, or in the park round the ramparts, stays
  for (const [x, z] of [[1565, -690], [1420, -950], [25, -122]])
    assert.ok(!landmarkClear(x, z), `a clear zone at ${x}, ${z}`);
});
