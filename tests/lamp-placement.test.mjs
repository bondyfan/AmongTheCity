// ---- a lamp stands on the kerb, never in the road --------------------------
// The mast offset is perpendicular to the way it belongs to, and wherever
// another carriageway runs close — a junction, a slip road, the far half of a
// dual carriageway — perpendicular to one road points straight into the other.
// Measured over the Pardubice tile before the fix: 106 of 2 083 lamps stood on
// a carriageway, 61 of them more than a metre in, the worst 4.42 m inside a 9 m
// primary, which is the middle of it. Now that a mast is solid and fellable
// (poles.js) this stopped being ugly and became a hazard in the running lane.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');

const G = 220;
/** Every lamp mast the chunk placed, in world coordinates. */
function lamps(roads) {
  for (let i = 0; i < roads.length; i++) { roads[i]._id = i + 1; roads[i]._home = '0,0'; }
  const cell = { buildings: [], roads, rails: [], water: [], green: [], paved: [],
    trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: () => G };
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  let out = [];
  g?.traverse((o) => {
    if (o.name !== 'lampPosts') return;
    const f = o.userData.spots ?? [];
    for (let i = 0; i + 2 < f.length; i += 3) out.push([f[i], f[i + 1]]);
  });
  return out;
}
const segD = (x, z, ax, az, bx, bz) => {
  const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
  let t = ((x - ax) * ex + (z - az) * ez) / L2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (ax + ex * t), z - (az + ez * t));
};
/** How far inside any drivable carriageway this point stands (0 = clear). */
function intrusion(roads, x, z) {
  let worst = 0;
  for (const r of roads) {
    if (!r.d) continue;
    for (let k = 0; k < r.p.length - 1; k++) {
      const d = segD(x, z, r.p[k][0], r.p[k][1], r.p[k + 1][0], r.p[k + 1][1]);
      worst = Math.max(worst, (r.w ?? 3) / 2 - d);
    }
  }
  return worst;
}

test('a crossroads puts no mast in either carriageway', () => {
  // the shape that produced the worst real offenders: two wide roads meeting,
  // so one road's kerb offset lands inside the other
  const roads = [
    { t: 'primary', w: 9, d: 1, v: 50, p: [[2, 60], [118, 60]] },
    // at x = 68, not 60: the masts land every 34 m from a staggered start, so a
    // crossing has to be placed where one actually falls or the fixture proves
    // nothing. Verified by removing the fix — this fails, x = 60 does not.
    { t: 'primary', w: 9, d: 1, v: 50, p: [[68, 2], [68, 118]] },
  ];
  const spots = lamps(roads);
  assert.ok(spots.length, 'no lamps were placed at all — the fixture is wrong');
  for (const [x, z] of spots) {
    const inside = intrusion(roads, x, z);
    assert.ok(inside <= 0, `a mast stands ${inside.toFixed(2)} m inside a carriageway `
      + `at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
});

test('two carriageways running close keep the masts outside both', () => {
  // a dual carriageway: the offset from one half points into the other
  const roads = [
    // 8 m apart: a mast sits 5.2 m off its own centreline, so it lands inside
    // the other 9 m carriageway with 1.7 m to spare
    { t: 'primary', w: 9, d: 1, v: 50, p: [[2, 56], [118, 56]] },
    { t: 'primary', w: 9, d: 1, v: 50, p: [[2, 64], [118, 64]] },
  ];
  const spots = lamps(roads);
  for (const [x, z] of spots) {
    const inside = intrusion(roads, x, z);
    assert.ok(inside <= 0,
      `a mast stands ${inside.toFixed(2)} m inside a carriageway at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
});

test('a lone street still gets its lamps — the fix must not just delete them', () => {
  const roads = [{ t: 'primary', w: 9, d: 1, v: 50, p: [[2, 60], [118, 60]] }];
  assert.ok(lamps(roads).length >= 2,
    'a 116 m street at 34 m spacing produced fewer than two lamps');
});
