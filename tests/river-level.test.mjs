// ---- a river flows downhill, and so must its surface ----------------------
// The water level used to be ONE number per body: the minimum ground height
// anywhere along its outline, shared by every chunk the body touched. That is
// right for a pond and wrong for a watercourse, because OSM maps a river as a
// single polygon and a single polygon runs downhill. The minimum is then its
// lowest point ANYWHERE, so the upstream end rendered metres under its own
// banks — a canyon with a blue floor. Swept over the 342 shipped tiles, 95
// bodies came out more than 3 m below their typical bank and the worst sat
// 29 m down.
//
// The level is a smooth field now (a distance-weighted soft minimum of the
// ground along the nearby outline), which has to satisfy two things at once:
// follow the valley down, and agree exactly where two chunks meet.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');
const { CHUNK } = await import('../js/config.js');

// A straight river running east, in ground that falls 20 m over the same run.
const LEN = 1200, HALF = 14;
const GROUND_AT = (x) => 240 - (x / LEN) * 20;      // 240 m down to 220 m
const BANK = 1.0;                                    // the banks stand this proud

function riverCity() {
  const top = [], bot = [];
  for (let x = 0; x <= LEN; x += 25) { top.push([x, -HALF]); bot.push([x, HALF]); }
  const f = { t: 'water', _id: 1, o: [...top, ...bot.reverse()] };
  const terrain = {
    res: 20, tile: 4800, missed: false,
    ready: () => true,
    // the channel floor is the river; everything outside it is the bank
    heightAt: (x, z) => GROUND_AT(Math.max(0, Math.min(LEN, x)))
      + (Math.abs(z) <= HALF ? 0 : BANK),
  };
  return { f, terrain };
}

/** Build one chunk of the river and return its water surface vertices. */
function waterAt(cx, cz) {
  const { f, terrain } = riverCity();
  const key = cx + ',' + cz;
  f._home = key;
  const cell = { buildings: [], roads: [], rails: [], water: [f],
    green: [], paved: [], trees: [] };
  const city = { chunkIndex: new Map([[key, cell]]), tile: 4800, waterways: [] };
  const mats = makeMaterials();
  mats.terrain = terrain;
  mats.trees = false; mats.facades = false; mats.ortho = null;
  mats.canopy = null; mats.ground = null;
  const g = buildChunkMeshes(city, cx, cz, mats, 'full');
  if (!g) return null;
  const pts = [];
  for (const ch of g.children) {
    if (ch.material !== mats.water) continue;
    const pos = ch.geometry?.attributes?.position;
    for (let i = 0; i < pos.count; i++)
      pts.push([pos.getX(i) + g.position.x, pos.getY(i) + g.position.y]);
  }
  return pts.length ? pts : null;
}

test('the water surface follows the valley instead of pooling at the lowest point', () => {
  // Every vertex is judged against the ground AT ITS OWN x — the whole point
  // is that the surface is no longer one height, so a single number for a
  // whole chunk would be measuring the slope, not the error.
  for (const cx of [0, 3, 6, 9]) {
    const pts = waterAt(cx, -1);
    assert.ok(pts, `no water built in chunk ${cx},-1`);
    let worst = 0, at = 0;
    for (const [x, y] of pts) {
      const below = GROUND_AT(Math.max(0, Math.min(LEN, x))) - y;
      if (Math.abs(below - 0.35) > Math.abs(worst - 0.35)) { worst = below; at = x; }
    }
    assert.ok(worst >= -0.2 && worst <= 2.0,
      `at x≈${Math.round(at)} the water sits ${worst.toFixed(1)} m below its own `
      + 'channel — it should hug it (the old whole-body minimum sank it ~20 m)');
  }
});

test('two chunks meeting on the river agree about where the water is', () => {
  // The seam is one plane, so the two builds must produce the same height for
  // the same x. A level computed per chunk from a hard local minimum steps
  // here — the staircase the old whole-feature minimum existed to avoid.
  const seam = 5 * CHUNK;
  const a = waterAt(4, -1), b = waterAt(5, -1);
  assert.ok(a && b);
  const near = (pts) => pts.filter(([x]) => Math.abs(x - seam) < 0.5).map(([, y]) => y);
  const ya = near(a), yb = near(b);
  assert.ok(ya.length && yb.length, 'neither chunk put a vertex on the seam');
  const step = Math.abs(Math.max(...ya) - Math.max(...yb));
  assert.ok(step < 0.05,
    `the surface steps ${step.toFixed(3)} m across the chunk boundary`);
});
