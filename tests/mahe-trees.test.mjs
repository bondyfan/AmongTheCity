// The trees of Mahé (js/treeshapes.js TROPIC_ZONES). The canopy raster
// carries a zone in the two low bits of its height (scripts/mahe/ground.mjs);
// the worker and the main thread must read the same zone and grow the same
// species from it, and the Czech world must never grow a palm.
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

const probe = `
  globalThis.location = { search: process.env.Q };
  const { register } = await import('node:module');
  register(new URL('./tests/three-alias.mjs', 'file://' + process.cwd() + '/'));
  const S = await import('./js/treeshapes.js');
  const count = {};
  for (let zone = 0; zone < 4; zone++) {
    const n = new Array(S.SPECIES.length).fill(0);
    for (let i = 0; i < 3000; i++) {
      const h = 18 * 4 + zone;   // what ground.mjs stores: whole metres times four, plus the zone
      const t = { x: (i % 60) * 9, z: Math.floor(i / 60) * 9, seed: 1000 + i, wild: true, h: h / 4 };
      n[S.treeSpec(t, h / 4, {}).sp]++;
    }
    count[zone] = n;
  }
  console.log(JSON.stringify({ count, palm: S.SP.PALM, willow: S.SP.WILLOW, shrub: S.SP.SHRUB }));`;
const run = (search) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
  { cwd: new URL('..', import.meta.url), env: { ...process.env, Q: search } }).toString());

test('the coast of Mahé is palms, its swamps are mangrove, its hills are forest', () => {
  const { count, palm, willow, shrub } = run('?region=mahe');
  const share = (zone, sp) => count[zone][sp] / 3000;
  assert.ok(share(0, palm) > 0.4, 'coastal palms ' + share(0, palm));
  assert.ok(share(1, palm) > 0.05 && share(1, palm) < 0.3, 'lowland palms ' + share(1, palm));
  assert.equal(share(2, palm), 0, 'no coconut palms in the hill forest');
  assert.ok(share(3, willow) + share(3, shrub) === 1, 'the mangrove is low domes and scrub');
});

test('the Czech world never grows a palm', () => {
  const { count, palm } = run('');
  for (let zone = 0; zone < 4; zone++) assert.equal(count[zone][palm], 0);
});
