// ---- the fast party-wall pass finds the walls the plain one finds ----
// js/partywalls.js stampPartyWalls runs on the main thread every time a tile
// arrives, so round 7's polish rewrote it for time (one record per edge per
// grid cell, pairs walked cell by cell, each pair once). The rules did not
// change, and this pins that: on made-up towns of terraced streets, turned
// blocks, slab sections and loose villas, its answer equals a brute-force
// reference that tests every edge against every edge with the same tests.

import test from 'node:test';
import assert from 'node:assert';

const { stampPartyWalls } = await import('../js/partywalls.js');

// the rules of partywalls.js, written the slow and obvious way
function reference(buildings) {
  const TOL = 0.35, PAR = 0.06, COVER = 0.7, MIN_EDGE = 1.0;
  const E = [];
  buildings.forEach((f, k) => f.o.forEach((a, i) => {
    const b = f.o[(i + 1) % f.o.length], L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    E.push({ k, i, ax: a[0], az: a[1], L: L < MIN_EDGE ? 0 : L, ux: (b[0] - a[0]) / L, uz: (b[1] - a[1]) / L });
  }));
  const cover = E.map(() => 0), low = E.map(() => Infinity);
  const up = buildings.map((_, k) => k);
  const root = (k) => { while (up[k] !== k) k = up[k]; return k; };
  const slab = buildings.map((f) => (!f.r || f.r === 'flat') && (f.lv ?? (f.h ?? 0) / 3.1) >= 4 && !(f.i?.length));
  for (const a of E) for (const b of E) {
    if (!a.L || !b.L || a.k === b.k) continue;
    if (Math.abs(a.ux * b.uz - a.uz * b.ux) > PAR) continue;
    const px = b.ax - a.ax, pz = b.az - a.az, qx = px + b.ux * b.L, qz = pz + b.uz * b.L;
    if (Math.abs(px * a.uz - pz * a.ux) > TOL || Math.abs(qx * a.uz - qz * a.ux) > TOL) continue;
    const t0 = px * a.ux + pz * a.uz, t1 = qx * a.ux + qz * a.uz;
    const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(a.L, Math.max(t0, t1));
    if (hi - lo < 0.3) continue;
    const ia = E.indexOf(a);
    cover[ia] += hi - lo;
    low[ia] = Math.min(low[ia], buildings[b.k].h ?? 6);
    const ha = buildings[a.k].h ?? 6, hb = buildings[b.k].h ?? 6;
    if (slab[a.k] && slab[b.k] && Math.abs(ha - hb) < 1.6) {
      const ra = root(a.k), rb = root(b.k);
      if (ra !== rb) { if (buildings[ra]._id < buildings[rb]._id) up[rb] = ra; else up[ra] = rb; }
    }
  }
  return buildings.map((f, k) => {
    let pw = null;
    E.forEach((e, j) => {
      if (e.k === k && e.L && cover[j] >= COVER * e.L) {
        pw ??= new Array(f.o.length).fill(0);
        pw[e.i] = Math.max(0.1, Math.round(low[j] * 10) / 10);
      }
    });
    const r = root(k), many = buildings.some((_, m) => m !== k && root(m) === r);
    return [pw, slab[k] && many ? buildings[r]._id : undefined];
  });
}

// a tiny deterministic generator (no Math.random: the test must not flake)
function town(seed) {
  let s = seed >>> 0;
  const rand = () => ((s = (Math.imul(s ^ (s >>> 15), 2246822519) + 0x9e3779b9) >>> 0) / 4294967296);
  const out = [];
  const turn = (x, z, c, sn) => [x * c - z * sn, x * sn + z * c];
  for (let blk = 0; blk < 6; blk++) {
    const ang = rand() * Math.PI, c = Math.cos(ang), sn = Math.sin(ang);
    const ox = blk * 140 + rand() * 20, oz = (blk % 2) * 120;
    let x = 0;
    const n = 6 + Math.floor(rand() * 6), slabRow = rand() < 0.35;
    for (let k = 0; k < n; k++) {
      const w = 6 + rand() * 12, d = 10 + rand() * 6, jit = () => (rand() - 0.5) * 0.3;
      const ring = [[x, 0], [x + w, 0], [x + w, d], [x, d]].map(([px, pz]) => {
        const [rx, rz] = turn(px + jit(), pz + jit(), c, sn);
        return [ox + rx, oz + rz];
      });
      if (rand() < 0.5) ring.reverse();          // neighbours wind their own way
      const h = slabRow ? 15 + rand() : 6 + rand() * 14;
      out.push({ o: ring, h, lv: Math.round(h / 3.1), r: slabRow ? 'flat' : 'gabled' });
      x += w + (rand() < 0.15 ? 3 + rand() * 4 : rand() * 0.2);    // a gap now and then
    }
  }
  for (let v = 0; v < 15; v++) {                  // loose villas with short jogs
    const x = rand() * 800, z = 260 + rand() * 200;
    out.push({ o: [[x, z], [x + 9, z], [x + 9, z + 0.6], [x + 10, z + 0.6], [x + 10, z + 8], [x, z + 8]], h: 7 });
  }
  out.forEach((f, i) => { f._id = 1000 + i * 7; });
  return out;
}

test('the fast party-wall pass equals the brute-force reference', () => {
  let party = 0, slabs = 0;
  for (const seed of [1, 2, 3, 7, 42, 1234]) {
    const B = town(seed);
    stampPartyWalls(B);
    const want = reference(B);
    B.forEach((f, k) => {
      assert.deepStrictEqual(f._pw ?? null, want[k][0], `seed ${seed} building ${k}: walls`);
      assert.strictEqual(f._slab, want[k][1], `seed ${seed} building ${k}: slab`);
      if (f._pw) party++;
      if (f._slab !== undefined) slabs++;
    });
  }
  assert.ok(party > 100 && slabs > 10, `the towns were towns (${party} with party walls, ${slabs} slab sections)`);
});

test('the scratch buffers carry nothing from one tile to the next', () => {
  // a big tile, then a small one: the second answer must not depend on the first
  const big = town(9), small = town(5).slice(0, 20);
  const fresh = JSON.parse(JSON.stringify(small));
  stampPartyWalls(big);
  stampPartyWalls(small);
  stampPartyWalls(fresh);
  assert.deepStrictEqual(small.map((f) => f._pw ?? null), fresh.map((f) => f._pw ?? null));
});
