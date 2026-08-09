// ---- the two-hundred-metre footpath ----------------------------------------
// A way shorter than two profile samples has no profile (levelWay answers
// null), so its ribbon is built in RELATIVE space — centimetres of layer
// offset, draped onto the ground at the end of the chunk build. The blend that
// ramps a footpath onto the deck of the road it meets fed that ribbon an
// ABSOLUTE height (~221 m), the drape then added the ground on top, and every
// short connector stub beside a carriageway stood up as a striped tower into
// the sky — 24 such vertices on náměstí Jana Pernera alone, up to 405 m, with
// partial blend weights making the smaller "fence" panels along the kerb.
// Visible everywhere only since the carriageways widened by their parking
// lane: the stubs used to sit outside the blend's 3.5 m reach.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
register(new URL('./three-alias.mjs', import.meta.url));
const { buildChunkMeshes, makeMaterials } = await import('../js/meshes.js');

const G = 221;

test('a short footway stub beside a road stays on the ground', () => {
  const road = { _id: 1, _home: '0,0', t: 'residential', w: 8, d: 1, v: 30,
    p: [[5, 60], [115, 60]] };
  // 3 m long — under the 2 × GRADE_DS = 4 m profile floor, so it has no
  // profile of its own — and touching the kerb, so the deck blend has full
  // weight over it. The real Pernera culprits measure 0.8–1.3 m.
  const stub = { _id: 2, _home: '0,0', t: 'footway', w: 1.8, d: 0,
    p: [[60, 65], [60, 68]] };
  const cell = { buildings: [], roads: [road, stub], rails: [], water: [],
    green: [], paved: [], trees: [], signs: [], crossings: [] };
  const city = { chunkIndex: new Map([['0,0', cell]]), tile: 4800, pois: [], waterways: [] };
  const mats = makeMaterials();
  mats.terrain = { res: 20, tile: 4800, missed: false, ready: () => true, heightAt: () => G };
  mats.trees = false; mats.facades = false; mats.canopy = null; mats.ground = null; mats.ortho = null;
  const g = buildChunkMeshes(city, 0, 0, mats, 'full');
  let worst = -Infinity;
  for (const c of g?.children ?? []) {
    const p = c.geometry?.attributes?.position;
    if (!p) continue;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i) + g.position.y;
      assert.ok(Number.isFinite(y), 'a non-finite vertex in the chunk');
      if (y > worst) worst = y;
    }
  }
  assert.ok(worst < G + 6,
    `the tallest vertex in a flat chunk with one road and one path stands at `
    + `${worst.toFixed(1)} m over ${G} m ground — the stub is a tower again`);
});
