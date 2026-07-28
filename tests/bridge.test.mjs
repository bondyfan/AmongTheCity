import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { bridgeDeckHeight } from '../js/geo.js';
import { BRIDGE_Y } from '../js/config.js';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { bridgeResample } = await import('../js/meshes.js');

test('a bridge holds one flat deck over a terrain valley', () => {
  const way = { p: [[0, 0], [0, 30]], _len: 30 };
  const terrain = {
    ready: () => true,
    heightAt: (_x, z) => z <= 0 ? 10 : z >= 30 ? 12 : -4,
  };
  const deck = 12 + BRIDGE_Y;

  for (const distance of [0, 1, 6, 15, 24, 29, 30])
    assert.equal(bridgeDeckHeight(way, distance, terrain), deck);
});

test('a long straight bridge is split into short fascia sections', () => {
  const points = bridgeResample([[0, 0], [0, 60]]);
  assert.ok(points.length > 2, 'the bridge is still only one long GPU chord');
  for (let i = 1; i < points.length; i++) {
    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    assert.ok(d <= 3.001, `bridge chord remained ${d} m long`);
  }
});

test('regional data retains the Labe road and footbridge tags', () => {
  const tile = JSON.parse(readFileSync(
    new URL('../public/data/tiles/-1_-1.json', import.meta.url), 'utf8'));
  const crossing = tile.roads.filter((r) => r.p.length === 2
    && r.p.every(([x, z]) => x > -830 && x < -760 && z > -1070 && z < -915)
    && (r.t === 'primary' || r.t === 'footway'));
  assert.equal(crossing.length, 4);
  assert.ok(crossing.every((r) => r.br === 1),
    'the region builder dropped bridge=yes from a Labe crossing');
});
