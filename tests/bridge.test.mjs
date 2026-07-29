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
  const deck = 12 + BRIDGE_Y;                  // the higher bank owns the level

  // The SPAN is level — that is the whole point of a bridge, and it must not
  // follow the −4 m river bed underneath it.
  for (const distance of [12, 15, 20])
    assert.equal(bridgeDeckHeight(way, distance, terrain), deck);
  // …and it never dives below either bank anywhere.
  for (let d = 0; d <= 30; d += 0.5)
    assert.ok(bridgeDeckHeight(way, d, terrain) >= 10 - 1e-9, `deck dived at ${d} m`);
});

test('the deck comes down to meet the road at both abutments', () => {
  // A level that runs edge to edge does not touch the ground, and the approach
  // road — a separate OSM way that drapes onto the terrain — does. The
  // difference is a bridge floating clear of the road with daylight under the
  // join, which is what "mosty nenavazují na silnice a je mezi tím mezera"
  // was. The endpoints are where the two ways share a node, so that is where
  // the deck has to agree with the ground exactly.
  const way = { p: [[0, 0], [0, 30]], _len: 30 };
  const terrain = {
    ready: () => true,
    heightAt: (_x, z) => z <= 0 ? 10 : z >= 30 ? 12 : -4,
  };
  assert.equal(bridgeDeckHeight(way, 0, terrain), 10, 'gap at the near abutment');
  assert.equal(bridgeDeckHeight(way, 30, terrain), 12, 'gap at the far abutment');

  // the climb is monotone — no hump, no dip on the way up
  let prev = -Infinity;
  for (let d = 0; d <= 8; d += 0.25) {
    const y = bridgeDeckHeight(way, d, terrain);
    assert.ok(y >= prev - 1e-9, `ramp went backwards at ${d} m`);
    prev = y;
  }
  // …and it is not a wall: 2.85 m of climb may not happen in 6 m
  const grade = (bridgeDeckHeight(way, 1, terrain) - 10) / 1;
  assert.ok(grade <= 0.26, `approach ramp is a ${(grade * 100).toFixed(0)} % climb`);
  // the deck still holds a level middle — the ramps must not eat the span
  assert.equal(bridgeDeckHeight(way, 15, terrain), 12 + BRIDGE_Y);
});

test('a short bridge stays a bridge instead of becoming two ramps', () => {
  // The ramp is capped at a quarter of the span from each end, so even a big
  // step still leaves half the deck level.
  const way = { p: [[0, 0], [0, 20]], _len: 20 };
  const terrain = { ready: () => true, heightAt: (_x, z) => (z <= 0 ? 4 : z >= 20 ? 14 : 0) };
  const deck = 14 + BRIDGE_Y;
  for (const d of [8, 10, 12]) assert.equal(bridgeDeckHeight(way, d, terrain), deck);
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
