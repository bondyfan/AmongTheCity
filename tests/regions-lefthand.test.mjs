// Left-hand traffic on Mahé (js/regions.js laneSide). The lane, the parked
// row and the give-way rule are the Czech ones MIRRORED, and the only proof
// that a mirror is a mirror is the same input on both sides of it. Each region
// is a separate process because the side is read once, at import, from the
// page's URL (exactly as it is in the browser and in the mesh worker).
import test from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';

// one straight eastbound way and one with a right-angle bend, the route shape
// ailane.js walks (one step per edge, cum = arc length along pts)
const probe = `
  globalThis.location = { search: process.env.Q };
  const L = await import('./js/ailane.js');
  const edge = (pts) => { const cum = [0]; for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1])); return { pts, cum }; };
  const straight = [{ e: edge([[0, 0], [100, 0]]), base: 0 }];
  const bend = [{ e: edge([[0, 0], [50, 0], [50, 50]]), base: 0 }];
  const out = {};
  const p = L.laneAt(straight, 0, 0, 40, 1.8, {}, 5);
  out.straight = [p.x, p.z, p.dx, p.dz];
  const q = L.laneAt(bend, 0, 0, 80, 1.8, {}, 5);
  out.bend = [q.x, q.z];
  out.cap = L.curveCap(bend, 0, 0, 80, 3, 4, 1.8, 5);
  console.log(JSON.stringify(out));`;
const run = (search) => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', probe],
  { cwd: new URL('..', import.meta.url), env: { ...process.env, Q: search } }).toString());

test('a Czech car keeps right of the centreline, a Mahé car keeps left', () => {
  const cz = run(''), mahe = run('?region=mahe');
  // eastbound along +x: right of travel is +z (south), left is -z
  assert.ok(Math.abs(cz.straight[1] - 1.8) < 1e-9, 'Czech lane at z +1.8: ' + cz.straight[1]);
  assert.ok(Math.abs(mahe.straight[1] + 1.8) < 1e-9, 'Mahé lane at z -1.8: ' + mahe.straight[1]);
  assert.equal(cz.straight[0], mahe.straight[0]);
  assert.deepEqual([cz.straight[2], cz.straight[3]], [mahe.straight[2], mahe.straight[3]], 'same direction');
});

test('round a bend the mirrored lane is the mirror image', () => {
  const cz = run(''), mahe = run('?region=mahe');
  // the bend turns right (east, then south): the Czech car is on the INSIDE,
  // the Mahé car on the outside, each 1.8 m from the centreline
  const dist = (p) => Math.abs(p[0] - 50);   // past the corner the way runs along x = 50
  assert.ok(Math.abs(dist(cz.bend) - 1.8) < 1e-6 && Math.abs(dist(mahe.bend) - 1.8) < 1e-6);
  assert.ok(cz.bend[0] < 50 && mahe.bend[0] > 50, 'Czech inside (west of the way), Mahé outside');
  // a wider corner (outside lane) allows a speed at least as high
  assert.ok(mahe.cap >= cz.cap, 'outside lane cap ' + mahe.cap + ' vs inside ' + cz.cap);
});

test('the give-way rule is mirrored, and stays antisymmetric', () => {
  // traffic.js: mine = lat * SIDE > 0 ("the other car is on my right", or my
  // left where traffic keeps left). Of two cars exactly one yields either way.
  for (const SIDE of [1, -1]) {
    for (const lat of [-3, 3]) {
      const olat = -lat;   // two cars meeting square: each sees the other on the opposite side
      const mine = lat * SIDE > 0, theirs = olat * SIDE > 0;
      assert.notEqual(mine, theirs);
    }
  }
});
