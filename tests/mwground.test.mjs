// ---- no town paving on a motorway verge (round 8 fix) ----------------------
// At exit 68 Chýšť the sealed-ground closing (js/sealed.js) tiled the median,
// the slip-road wedges and the verge in square paving, and near Poříčany the
// shipped classifier raster lays "paving" 8 to 26 m from the carriageways.
// js/mwground.js keeps both inferred layers out of a motorway's verge band.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { bootCity, loadAround } from './flow-harness.mjs';

const { motorwayVerge, cutRects, vergeDrops, VERGE } = await import('../js/mwground.js');
const { sealedGrid, isHardWay } = await import('../js/sealed.js');
const { GroundClass, decodeRLE } = await import('../js/groundclass.js');
const { d11Locate } = await import('../js/d11.js');

// a chunk far from the D11 (Pardubice's tile row is clear of its 25 m reach)
const CX = 10, CZ = 10, X0 = CX * 120, Z0 = CZ * 120;

test('a motorway way puts a band of half width plus VERGE round it, nothing beyond', () => {
  const cell = { roads: [{ t: 'motorway', w: 11, p: [[X0 - 50, Z0 + 60], [X0 + 170, Z0 + 60]] }] };
  const g = motorwayVerge(cell, CX, CZ);
  assert.ok(g);
  const at = (dz) => g[Math.floor((60 + dz) / 2) * 60 + 30];
  assert.equal(at(0), 1);
  assert.equal(at(5.5 + VERGE - 1), 1);
  assert.equal(at(-(5.5 + VERGE - 1)), 1);
  assert.equal(at(5.5 + VERGE + 2), 0);
  assert.equal(motorwayVerge({ roads: [{ t: 'secondary', w: 7, p: cell.roads[0].p }] }, CX, CZ), null);
});

test('a hard network next to a slip road seals nothing in the verge, the rest as before', () => {
  // three asphalt roads closing a 14 m gap, and a slip road along one of them
  const sec = (z) => ({ t: 'secondary', s: 'asphalt', w: 7, p: [[X0, Z0 + z], [X0 + 120, Z0 + z]] });
  const base = { roads: [sec(20), sec(34), { t: 'tertiary', s: 'asphalt', w: 6, p: [[X0 + 60, Z0], [X0 + 60, Z0 + 120]] }] };
  const before = sealedGrid(base, CX, CZ);
  assert.ok(before && before.reduce((a, b) => a + b, 0) > 50, 'the closing fills the gap');
  const link = { t: 'motorway_link', s: 'asphalt', w: 5.5, p: [[X0, Z0 + 8], [X0 + 120, Z0 + 8]] };
  assert.equal(isHardWay(link), false, 'a slip road is not part of a town network');
  const after = sealedGrid({ roads: [...base.roads, link] }, CX, CZ);
  const g = motorwayVerge({ roads: [link] }, CX, CZ);
  for (let k = 0; k < 3600; k++) {
    if (g[k]) assert.equal(after?.[k] ?? 0, 0, 'no sealed cell in the verge');
    else assert.equal(after?.[k] ?? 0, before[k], 'outside the verge nothing changes');
  }
});

test('cutRects drops exactly the 4 m cells the verge touches, and grass agrees', () => {
  const link = { t: 'motorway_link', w: 5.5, p: [[X0, Z0 + 10], [X0 + 120, Z0 + 10]] };
  const g = motorwayVerge({ roads: [link] }, CX, CZ);
  const rects = [{ x0: X0, z0: Z0, x1: X0 + 120, z1: Z0 + 120, c: 1 }, { x0: X0, z0: Z0 + 100, x1: X0 + 8, z1: Z0 + 104, c: 2 }];
  const out = cutRects(rects, g, CX, CZ);
  let area = 0;
  for (const r of out) {
    area += (r.x1 - r.x0) * (r.z1 - r.z0);
    for (let x = r.x0; x < r.x1; x += 4) for (let z = r.z0; z < r.z1; z += 4) {
      assert.equal(vergeDrops(g, CX, CZ, x + 2, z + 2), false);
    }
  }
  // the band reaches 10 + 2.75 + 18 m: whole 4 m rows to z 32 are gone, the rest stays
  let kept = 0;
  for (let z = 0; z < 120; z += 4) if (!vergeDrops(g, CX, CZ, X0 + 2, Z0 + z + 2)) kept++;
  assert.equal(area, kept * 4 * 120 + (vergeDrops(g, CX, CZ, X0 + 2, Z0 + 102) ? 0 : 32));
  assert.ok(kept > 20 && kept < 30);
  assert.strictEqual(cutRects(rects, null, CX, CZ), rects, 'away from motorways the list passes through');
});

test('the D11 lines alone make a verge, covering the median too', () => {
  // km 30 straight: a chunk on the carriageways
  const cx = Math.floor(-55100 / 120), cz = Math.floor(-9687 / 120);
  const g = motorwayVerge({ roads: [] }, cx, cz);
  assert.ok(g, 'no way listed, the d11 lines still answer');
  let n = 0;
  for (let k = 0; k < 3600; k++) n += g[k];
  assert.ok(n > 600, `${n} verge cells`);
  assert.ok(d11Locate(-55100, -9687));
});

test('real tiles: exit 68 and the whole corridor seal nothing beside the motorway', async () => {
  const city = await bootCity();
  await loadAround(city, -17241, -11421, 180000);
  const cx = Math.floor(-17241 / 120), cz = Math.floor(-11421 / 120);
  let near = 0, hardMw = 0;
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const cell = city.chunkIndex.get((cx + dx) + ',' + (cz + dz));
    if (!cell) continue;
    hardMw += cell.roads.filter((r) => r.t === 'motorway' && r.s === 'concrete').length;
    const s = sealedGrid(cell, cx + dx, cz + dz, null);
    const g = motorwayVerge(cell, cx + dx, cz + dz);
    if (s && g) for (let k = 0; k < 3600; k++) near += s[k] & g[k];
  }
  assert.ok(hardMw > 3, 'the interchange is loaded (concrete carriageways)');
  assert.equal(near, 0);
});

test('real raster: no classifier paving left in the verge near Poříčany', () => {
  const gc = new GroundClass();
  const dir = new URL('../public/data/ground/', import.meta.url);
  for (const f of fs.readdirSync(dir)) {
    const [tx, tz] = f.replace('.bin', '').split('_').map(Number);
    const b = fs.readFileSync(new URL(f, dir));
    gc.grids.set(tx + ',' + tz, decodeRLE(b.buffer.slice(b.byteOffset, b.byteOffset + b.length), 1200 * 1200));
  }
  // the chunks along the E line with the most false paving (measured)
  let before = 0, after = 0;
  for (const [cx, cz] of [[-364, -80], [-400, -83], [-385, -82], [-381, -81]]) {
    const g = motorwayVerge({ roads: [] }, cx, cz);
    const rects = gc.rectsIn(cx * 120, cz * 120);
    const inBand = (rs) => {
      let n = 0;
      for (const r of rs) for (let x = r.x0; x < r.x1; x += 4) for (let z = r.z0; z < r.z1; z += 4) {
        if (d11Locate(x + 2, z + 2)) n++;
      }
      return n;
    };
    before += inBand(rects);
    after += inBand(cutRects(rects, g, cx, cz));
  }
  assert.ok(before > 100, `${before} raster cells beside the carriageways before`);
  assert.equal(after, 0);
});
