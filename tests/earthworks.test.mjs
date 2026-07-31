// ---- earthworks: the terrain conforms to the roads --------------------------
// Every visual disaster this project fought — terrain lying across a
// carriageway, torn edges, two-metre kerb walls — came from roads negotiating
// with a fixed terrain. The survey is not ground anyone built on; a real road
// comes with earthworks. These tests pin the contract: under a deck the ground
// IS the deck's grade, the shoulder blends smoothly back into the survey, and
// ground no road reaches keeps every decimetre the surveyor measured.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { Terrain } = await import('../js/terrain.js');
const { conformTerrainTile } = await import('../js/city.js');
const { roadGradeY, polylineLength, chunkKey } = await import('../js/geo.js');

const TILE = 4800, RES = 20;

/** A tile whose survey is a lumpy sine field — creases everywhere. */
function lumpyTerrain() {
  const t = new Terrain(TILE, RES);
  const g = new Int16Array(t.n * t.n);
  for (let j = 0; j < t.n; j++) {
    for (let i = 0; i < t.n; i++) {
      g[j * t.n + i] = Math.round((2200 + 8 * Math.sin(i * 0.9) + 6 * Math.sin(j * 1.3)));
    }
  }
  t.grids.set('0,0', g);
  return t;
}

function cityWith(roads) {
  let id = 0;
  const chunkIndex = new Map();
  for (const r of roads) {
    r._id = ++id;
    r._len = polylineLength(r.p);
    for (const [x, z] of r.p) {
      const k = chunkKey(x, z);
      let c = chunkIndex.get(k);
      if (!c) chunkIndex.set(k, c = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
      if (!c.roads.includes(r)) c.roads.push(r);
    }
    // …and every chunk between consecutive points, the way bucketize does
    for (let k = 0; k < r.p.length - 1; k++) {
      const [ax, az] = r.p[k], [bx, bz] = r.p[k + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, bz - az) / 60);
      for (let s = 0; s <= steps; s++) {
        const kk = chunkKey(ax + (bx - ax) * (s / steps), az + (bz - az) * (s / steps));
        let c = chunkIndex.get(kk);
        if (!c) chunkIndex.set(kk, c = { buildings: [], roads: [], rails: [], water: [], green: [], paved: [], trees: [] });
        if (!c.roads.includes(r)) c.roads.push(r);
      }
    }
  }
  return { chunkIndex };
}

test('under the deck, the ground IS the grade', () => {
  const t = lumpyTerrain();
  const road = { d: 1, t: 'primary', w: 9, p: [[200, 600], [1000, 600]] };
  const city = cityWith([road]);
  assert.equal(conformTerrainTile(t, city, 0, 0), true, 'the bake reported nothing moved');

  let worst = 0;
  for (let x = 260; x <= 940; x += RES) {
    const gy = roadGradeY(road, x - 200, t);
    worst = Math.max(worst, Math.abs(t.heightAt(x, 600) - gy));
  }
  assert.ok(worst < 0.06,
    `ground under the carriageway strays ${worst.toFixed(2)} m from the deck grade`);
});

test('the shoulder blends, and the far field keeps the survey', () => {
  const t = lumpyTerrain();
  const raw = t.grids.get('0,0').slice();
  const road = { d: 1, t: 'primary', w: 9, p: [[200, 600], [1000, 600]] };
  conformTerrainTile(t, cityWith([road]), 0, 0);
  const g = t.grids.get('0,0');
  // 30 m out: beyond hw 4.5 + fall 14, the survey must be untouched
  let touched = 0;
  for (let j = 0; j < t.n; j++) {
    for (let i = 0; i < t.n; i++) {
      const z = j * RES;
      if (Math.abs(z - 600) < 30) continue;
      if (g[j * t.n + i] !== raw[j * t.n + i]) touched++;
    }
  }
  assert.equal(touched, 0, `${touched} samples moved outside the earthworks`);
});

test('a second bake starts from the survey, not from the last bake', () => {
  const t = lumpyTerrain();
  const road = { d: 1, t: 'primary', w: 9, p: [[200, 600], [1000, 600]] };
  const city = cityWith([road]);
  conformTerrainTile(t, city, 0, 0);
  const after1 = t.grids.get('0,0').slice();
  // a data tile arrives; the world re-marks the terrain tile un-conformed
  t._conformed.clear();
  conformTerrainTile(t, city, 0, 0);
  const after2 = t.grids.get('0,0');
  let drift = 0;
  for (let o = 0; o < after1.length; o++) if (after1[o] !== after2[o]) drift++;
  assert.equal(drift, 0, `${drift} samples drifted on re-bake — it compounded`);
});
