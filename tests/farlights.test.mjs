// The far field of night lights (js/farlights.js) and the length of twilight
// (js/sky.js). Pure logic only: what is on screen was looked at in the game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { cellPoints } = await import('../js/farlights.js');
const { nightKOf, sunDirOf } = await import('../js/sky.js');

const terrain = { heightAt: () => 220 };
// one 300 m street through the cell at 0,0 and on into its neighbour, a lane
// too narrow for lamps, and two houses
const cell = {
  roads: [
    { _id: 4, d: 1, w: 7, p: [[-60, 60], [240, 60]] },
    { _id: 5, d: 1, w: 3.5, p: [[10, 0], [10, 119]] },
    { _id: 6, d: 0, w: 9, p: [[0, 20], [119, 20]] },
  ],
  buildings: [
    { _id: 1001, h: 12, o: [[20, 80], [50, 80], [50, 100], [20, 100]] },
    { _id: 1002, h: 6, o: [[130, 80], [150, 80], [150, 100], [130, 100]] },   // belongs next door
  ],
};

// (Round 5: the far points used to walk the centrelines themselves and put a
// lamp ON the road's axis; they now read the mesher's own lamp plan, so each
// stands where its column does, 0.7 m behind the kerb, on alternating sides.
// The two assertions that pinned the centreline are changed on purpose.)
test('far lamps: the mesher\'s plan, every 34 m along the wide drivable road, inside this cell only', () => {
  const pts = cellPoints('0,0', cell, terrain, false);
  assert.ok(pts.length % 6 === 0);
  const n = pts.length / 6;
  // 120 m of the street lie in the cell: three or four columns
  assert.ok(n >= 3 && n <= 4, `${n} lamps`);
  const sides = new Set();
  for (let i = 0; i < pts.length; i += 6) {
    assert.ok(pts[i] >= 0 && pts[i] < 120 && pts[i + 2] >= 0 && pts[i + 2] < 120, 'a lamp outside its cell');
    assert.ok(Math.abs(Math.abs(pts[i + 2] - 60) - 4.2) < 1e-4, 'a lamp that is not at the kerb of the wide road');
    sides.add(Math.sign(pts[i + 2] - 60));
    assert.ok(Math.abs(pts[i + 1] - 227.4) < 1e-3, 'a lamp head is 7.4 m over the ground');
    assert.ok(pts[i + 3] > 0.9 && pts[i + 4] < pts[i + 3] && pts[i + 5] < pts[i + 4], 'lamp light is warm');
  }
  assert.equal(sides.size, 2, 'the columns do not alternate kerbs');
  // the neighbour cell continues the same walk: no lamp twice, even spacing across the border
  const next = cellPoints('1,0', cell, terrain, false);
  const xs = [...Array(n).keys()].map(i => pts[i * 6]).concat([...Array(next.length / 6).keys()].map(i => next[i * 6])).sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 34) < 1e-3, 'spacing breaks at the cell border');
});

test('far lamps: a column the mesher moves or drops is not a point of light where it would have been', () => {
  // A runs along the border inside cell 0,0; its first column would stand
  // 5.2 m to the +z side, in the lane of B, which lies in the next cell
  // (tests/fix-street.test.mjs has the same street for the mesher itself)
  const A = { _id: 1, d: 1, t: 'secondary', w: 9, p: [[22, 116], [118, 116]] };
  const B = { _id: 2, d: 1, t: 'tertiary', w: 8, p: [[2, 122], [118, 122]] };
  // …and a house on A's other building line, where the far kerb's column would come up
  const house = { _id: 9, h: 5, o: [[80, 105], [96, 105], [96, 112.5], [80, 112.5]] };
  const a = { roads: [A], buildings: [house] }, b = { roads: [B], buildings: [] };
  const city = { chunkIndex: new Map([['0,0', a], ['0,1', b]]) };
  const pts = cellPoints('0,0', a, terrain, false, city);
  // The walk gives two stations, x = 54 and x = 88. The first goes to the kerb
  // that is free (z = 110.8, away from B); the second has B's lane on one side
  // and the house on the other, so the mesher plants no column there at all.
  const at = [];
  for (let i = 0; i < pts.length; i += 6) at.push([Math.round(pts[i] * 10) / 10, Math.round(pts[i + 2] * 10) / 10]);
  assert.deepEqual(at, [[54, 110.8]], 'the far lamps are not the columns the mesher plants');
});

test('far windows: only where asked, on the walls of this cell\'s own houses, and deterministic', () => {
  const a = cellPoints('0,0', cell, terrain, true), b = cellPoints('0,0', cell, terrain, true);
  assert.deepEqual([...a], [...b]);
  const lamps = cellPoints('0,0', cell, terrain, false).length;
  for (let i = lamps; i < a.length; i += 6) {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    assert.ok(x >= 20 && x <= 50 && z >= 80 && z <= 100, 'a window off its house');
    assert.ok(y > 220.5 && y < 232, 'a window outside the wall height');
    assert.ok(Math.max(a[i + 3], a[i + 4], a[i + 5]) < 0.6, 'a window as bright as a lamp');
  }
  assert.equal(cellPoints('9,9', undefined, terrain).length, 0);
});

test('twilight takes its time: over an hour from day to full night, most of it after sunset', () => {
  const kAt = (h) => nightKOf(h / 24);
  let first = null, last = null;
  for (let h = 18; h <= 24; h += 1 / 120) {
    const k = kAt(h);
    if (first === null && k > 0.02) first = h;
    if (last === null && k > 0.98) last = h;
  }
  assert.ok(first !== null && last !== null);
  const span = last - first;
  assert.ok(span > 1.1 && span < 2.6, `dusk lasts ${span.toFixed(2)} h`);
  assert.ok(last - 21 > 21 - first, 'most of dusk should come after sunset (21:00)');
  // …and the night never jumps: no step larger than a twentieth in half a minute
  for (let h = 18; h <= 30; h += 1 / 120) assert.ok(Math.abs(kAt(h + 1 / 120) - kAt(h)) < 0.05);
  // the sun crosses the horizon at the speed it arrived with (the old path
  // doubled it): elevation half an hour either side of sunset is about the same
  const el = (h) => Math.asin(sunDirOf(h / 24).y) * 180 / Math.PI;
  assert.ok(Math.abs(el(20.5) + el(21.5)) < 2.5, `asymmetric sunset: ${el(20.5).toFixed(1)} / ${el(21.5).toFixed(1)}`);
});
