// node --test tests/treesolid.test.mjs
// A tree trunk is solid (js/treesolid.js): the trunks are read off the same
// instance matrices the chunk draws its trees with, and a car meets one with
// its whole body (js/vehicles.js wallPass), not with four corner discs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const THREE = await import('three');
const TS = await import('../js/treeshapes.js');
const { TreeSolids, decodeTrunks, trunkRadius, crownFold, TRUNK_MIN, TRUNK_MAX } = await import('../js/treesolid.js');
const VEH = await import('../js/vehicles.js');

// A batch as js/meshes.js makes one: the crown matrix and the tagged colour of
// each tree, chunk-local, with `fold` multiplied in as the worker's codec does.
function batch(trees, { gx = 0, gy = 0, gz = 0, fold = 1, bytes = false } = {}) {
  const a = new Float32Array(trees.length * 16), col = bytes ? new Uint8Array(trees.length * 3) : new Float32Array(trees.length * 3);
  const m = new THREE.Matrix4(), c = new THREE.Color(), specs = [];
  trees.forEach((t, i) => {
    const spec = TS.treeSpec({ seed: t.seed ?? i + 1, x: t.x, z: t.z, forest: t.forest, bush: t.bush, h: t.h, tx: t.tx }, 0, {});
    TS.treeMatrices(spec, t.x - gx, (t.y ?? 0) - gy, t.z - gz, m, null);
    for (let j = 0; j < 16; j++) a[i * 16 + j] = m.elements[j] * (j < 12 ? fold : 1);
    TS.crownColor(spec, c);
    const rgb = [c.r, c.g, c.b].map((v) => (bytes ? Math.round(v * 255) : v));
    col.set(rgb, i * 3);
    specs.push({ ...spec });
  });
  return { src: { a, col, n: trees.length, fold, gx, gy, gz }, specs };
}

test('a trunk stands where the tree was planted, whatever the crown leans to', () => {
  const trees = [];
  for (let i = 0; i < 60; i++) trees.push({ x: 10 + i * 1.7, z: 20 + (i % 7) * 3.1, y: 200 + i * 0.1, seed: 1000 + i * 37, forest: i % 2 === 0 });
  for (const opt of [{}, { gx: 60, gy: 190, gz: 60 }, { gx: 60, gy: 190, gz: 60, fold: 7.25, bytes: true }]) {
    const { src, specs } = batch(trees, opt);
    const tr = decodeTrunks(src.a, src.col, src.n, src.fold, src.gx, src.gy, src.gz);
    assert.equal(tr.length, trees.length * 5, 'every tree has a trunk');
    for (let i = 0; i < trees.length; i++) {
      const t = trees[i], s = specs[i];
      // (a worker batch carries its matrices as float32 of a number 7 times as big)
      assert.ok(Math.abs(tr[i * 5] - t.x) < 0.02 && Math.abs(tr[i * 5 + 1] - t.z) < 0.02, `tree ${i} foot x/z`);
      assert.ok(Math.abs(tr[i * 5 + 3] - t.y) < 0.05, `tree ${i} stands on its ground`);
      assert.ok(tr[i * 5 + 2] >= TRUNK_MIN - 1e-6 && tr[i * 5 + 2] <= TRUNK_MAX + 1e-6, `tree ${i} radius ${tr[i * 5 + 2]}`);
      assert.ok(Math.abs(tr[i * 5 + 2] - trunkRadius(s.sp, s.rx)) < 0.01, 'the radius is the species share of the crown');
      assert.ok(tr[i * 5 + 4] > 1.4, 'and the stem is as tall as a car at least');
    }
  }
});

test('a shrub is not a trunk, and a hidden instance is nothing', () => {
  const { src } = batch([{ x: 5, z: 5, bush: true, h: 1.2 }, { x: 9, z: 5 }, { x: 13, z: 5 }]);
  for (let j = 0; j < 12; j++) src.a[2 * 16 + j] = 0;            // the third one zeroed out of the batch
  const tr = decodeTrunks(src.a, src.col, src.n, src.fold, 0, 0, 0);
  assert.equal(tr.length, 5);
  assert.ok(Math.abs(tr[0] - 9) < 0.01);
  assert.equal(trunkRadius(TS.SP.SHRUB, 2), 0);
});

test('the fold of a quantised template is its real extent over the one it has', () => {
  const pos = (k) => ({ count: 3, getX: (i) => [0.5, -1, 0.2][i] / k, getY: () => 0.1 / k, getZ: () => -0.3 / k });
  assert.equal(crownFold(pos(1)), 1);
  assert.ok(Math.abs(crownFold(pos(7.25)) - 7.25) < 1e-9);
});

test('somebody on foot is pushed out of a trunk by the nearest way, and only on its level', () => {
  const S = new TreeSolids(120);
  const { src } = batch([{ x: 30, z: 40, y: 10, seed: 5 }]);
  S.register('0,0', src);
  const r = decodeTrunks(src.a, src.col, 1, 1, 0, 0, 0)[2];
  const p = { x: 30.1, z: 40 };
  assert.equal(S.collide(p, 0.38, 10.3), true);
  assert.ok(Math.abs(Math.hypot(p.x - 30, p.z - 40) - (r + 0.38)) < 1e-3, 'out to the bark plus the shoulders');
  assert.ok(p.x > 30 && Math.abs(p.z - 40) < 1e-6, 'the way it was already going');
  assert.equal(S.collide(p, 0.38, 10.3), false, 'and then it is clear');
  // dead centre still comes out
  const q = { x: 30, z: 40 };
  assert.equal(S.collide(q, 0.38, 10.3), true);
  assert.ok(Math.hypot(q.x - 30, q.z - 40) > r);
  // a deck over the tree: not in the way. The street under it: neither.
  assert.equal(S.collide({ x: 30.1, z: 40 }, 0.38, 10 + 40), false);
  assert.equal(S.collide({ x: 30.1, z: 40 }, 0.38, 10 - 6), false);
  // no height asked: every trunk counts
  assert.equal(S.collide({ x: 30.1, z: 40 }, 0.38, undefined), true);
});

test('a wood is found across chunk edges, and goes with its chunk', () => {
  const S = new TreeSolids(120);
  const A = [], B = [];
  for (let i = 0; i < 400; i++) A.push({ x: 2 + (i % 20) * 5.9, z: 2 + Math.floor(i / 20) * 5.9, seed: 7 + i, forest: true });
  for (let i = 0; i < 400; i++) B.push({ x: 122 + (i % 20) * 5.9, z: 2 + Math.floor(i / 20) * 5.9, seed: 9000 + i, forest: true });
  S.register('0,0', batch(A, { gx: 60, gz: 60 }).src);
  S.register('1,0', batch(B, { gx: 180, gz: 60, fold: 3, bytes: true }).src);
  const out = [];
  // brute force agrees with the grid, anywhere, at any reach
  const all = [...A, ...B];
  for (const [x, z, reach] of [[60, 60, 9], [119.5, 30, 6], [121, 61, 14], [5, 5, 3], [239, 119, 20], [118, 2, 0.5]]) {
    const n = S.near(x, z, reach, undefined, out);
    let want = 0;
    for (const t of all) if (Math.hypot(t.x - x, t.z - z) <= reach + TRUNK_MIN) want++;
    let got = 0;
    for (let i = 0; i < n; i++) if (Math.hypot(out[i * 3] - x, out[i * 3 + 1] - z) <= reach + TRUNK_MIN) got++;
    assert.equal(got, want, `at ${x},${z} within ${reach}`);
    assert.ok(n >= want);
  }
  assert.ok(S.near(121, 61, 14, undefined, out) > 0);
  S.unregister('1,0');
  for (let i = 0, n = S.near(150, 61, 14, undefined, out); i < n; i++) assert.ok(out[i * 3] < 121, 'only the first chunk is left');
  S.register('0,0', null);
  assert.equal(S.near(60, 60, 30, undefined, out), 0);
});

// ---- the car ---------------------------------------------------------------------
function worldWith(S) {
  return {
    surfaceY: () => ({ y: 0, road: true }), heightAt: () => 0, collide: () => false,
    trunksNear: (x, z, reach, y, out) => S.near(x, z, reach, y, out),
  };
}
const mkCar = (kind, over) => {
  const k = VEH.kindOf(kind);
  return { kind, x: 0, z: 0, heading: 0, speed: 0, steer: 0, len: k.len, wid: k.wid, _lat: 0, yaw: 0, offroad: 0, y: 0, mesh: { userData: {} }, ...over };
};

test('a car driven at a trunk stops on it: dead centre, off centre, fast and slow, forwards and in reverse', () => {
  for (const kind of ['fabia', 'octavia', 'tesla', 'roadster', 'van', 'bus']) {
    for (const v0 of [4, 14, 33]) for (const off of [0, 0.35, -0.7]) for (const rev of [false, true]) {
      const S = new TreeSolids(120);
      // heading 0 is nose along -z: the tree stands ahead (or behind, reversing)
      const tz = rev ? 14 : -14;
      const { src } = batch([{ x: off, z: tz, seed: 11 }]);
      S.register(Math.floor(off / 120) + ',' + Math.floor(tz / 120), src);
      const r = decodeTrunks(src.a, src.col, 1, 1, 0, 0, 0)[2];
      const car = mkCar(kind, { speed: rev ? -v0 : v0 });
      const world = worldWith(S);
      let hit = 0;
      for (let i = 0; i < 240; i++) {
        VEH.driveStep(car, { gas: rev ? -1 : 1, steer: 0, brake: false }, 1 / 60, world, null);
        hit = Math.max(hit, car.impactV ?? 0);
        // never through it: the trunk's centre stays outside the body
        const dx = off - car.x, dz = tz - car.z, ch = Math.cos(car.heading), sh = Math.sin(car.heading);
        const lx = Math.abs(dx * ch - dz * sh), lz = Math.abs(dx * sh + dz * ch);
        assert.ok(lx > car.wid / 2 - 0.02 || lz > car.len / 2 - 0.02,
          `${kind} at ${v0} m/s, ${off} m off${rev ? ', reversing' : ''}: the trunk is inside the car at step ${i}`);
      }
      assert.ok(hit > Math.min(v0, 8) * 0.5, `${kind} at ${v0}: an impact of ${hit.toFixed(1)} m/s was felt`);
      // (square on, it stays there; a glancing hit is turned aside and may go round)
      if (off === 0) assert.ok(Math.abs(car.z) < 14 + car.len, `${kind} at ${v0}: it did not get past (z ${car.z.toFixed(1)}, trunk r ${r.toFixed(2)})`);
      if (v0 >= 14) assert.ok((car.damage ?? 0) > 0, `${kind} at ${v0}: and it is bent`);
    }
  }
});

test('a car passing beside a trunk is not touched, and one on the deck above does not meet it', () => {
  const S = new TreeSolids(120);
  const { src } = batch([{ x: 1.9, z: -14, seed: 11 }, { x: 0, z: -30, y: -9, seed: 12 }]);
  S.register('0,-1', src);
  const car = mkCar('octavia', { speed: 20 });
  const world = worldWith(S);
  for (let i = 0; i < 120; i++) {
    VEH.driveStep(car, { gas: 0.4, steer: 0, brake: false }, 1 / 60, world, null);
    assert.equal(car.impactV ?? 0, 0, `nothing was hit at step ${i}`);
  }
  assert.ok(car.z < -35, 'and it drove on');
});
