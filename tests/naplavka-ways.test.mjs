// THE WAYS DOWN TO THE NÁPLAVKY (js/naplavky.js): every ramp and flight of
// stairs is a terrain stamp, and the ground along its line has to run from the
// lower quay's floor to the street it comes up to, at a grade feet can climb.
// Round 7 dug the quays and left no way down; a first version of the stairs
// was 'raise' only, and the three whose OSM line runs just on the street side
// of the wall stood at street level and never reached the quay.
// Also the drawn ground at a stamp's hard edge (terrainstamps.quaySnap): a
// vertex near a quay wall goes onto the wall's line at its own side's height.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { Terrain } = await import('../js/terrain.js');
const { NAPLAVKA_BEFORE, NAPLAVKA_AFTER } = await import('../js/naplavky.js');
const { quaySnap, SNAP } = await import('../js/quayedge.js');

// a flat survey over both quays (Rašínovo and Dvořákovo nábřeží), 193 m by
// default: the street level, above every ramp's foot
function flatPrague(y = 193) {
  const t = new Terrain(4800, 20);
  for (const k of ['-21,-1', '-20,-1', '-21,-2', '-20,-2']) t.grids.set(k, new Int16Array(t.n * t.n).fill(y * 10));
  t._loads = 1;
  return t;
}

test('every ramp and stair runs from the quay floor to the street at a climbable grade', () => {
  // A 'set' way makes its own ground whatever the survey; a 'raise' ramp
  // only builds up, so it is read over a survey below both quay floors (on
  // the street-level one its terrace would read the survey where that is
  // higher than the ramp, which the real street is not).
  const high = flatPrague(), low = flatPrague(185);
  for (const s of [...NAPLAVKA_BEFORE, ...NAPLAVKA_AFTER]) {
    const t = s.mode === 'raise' ? low : high;
    // the way's own vertices, without the run-on past either end
    const pts = s.pts.slice(1, -1), base = s.base.slice(1, -1);
    const ys = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i], [bx, bz] = pts[i + 1];
      const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / 0.5));
      for (let k = 0; k <= n; k++) ys.push(t.heightAt(ax + (bx - ax) * k / n, az + (bz - az) * k / n));
    }
    assert.ok(Math.abs(ys[0] - base[0]) < 0.25, `${s.name}: starts at ${ys[0].toFixed(2)}, not ${base[0].toFixed(2)}`);
    assert.ok(Math.abs(ys.at(-1) - base.at(-1)) < 0.25, `${s.name}: ends at ${ys.at(-1).toFixed(2)}, not ${base.at(-1).toFixed(2)}`);
    let worst = 0;
    for (let i = 1; i < ys.length; i++) worst = Math.max(worst, Math.abs(ys[i] - ys[i - 1]));
    // 0.5 m apart: 0.375 m is a 75 % flight, steeper than any of the real ones
    assert.ok(worst < 0.375, `${s.name}: a ${(worst / 0.5 * 100).toFixed(0)} % step`);
  }
});

test('a ground vertex by a quay wall is drawn on the wall line, at its own side', () => {
  const t = flatPrague();
  // Dvořákovo nábřeží: the wall runs from (-95794.6, -6780.8) to (-95842.3, -6760.4),
  // the quay to the north (river side), the street to the south
  const ax = -95794.6, az = -6780.8, bx = -95842.3, bz = -6760.4;
  const L = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / L, uz = (bz - az) / L;
  const mx = (ax + bx) / 2, mz = (az + bz) / 2;
  // the normal towards the street (south: +z)
  const nx = uz > 0 ? -uz : uz, nz = uz > 0 ? ux : -ux;
  const sn = nz > 0 ? 1 : -1;
  for (const side of [1, -1]) {
    const x = mx + nx * sn * side * 1.5, z = mz + nz * sn * side * 1.5;
    const own = t.heightAt(x, z);
    const q = quaySnap(t, x, z, SNAP);
    assert.ok(q, `snapped (${side > 0 ? 'street' : 'quay'} side)`);
    const off = (q[0] - mx) * nx * sn + (q[2] - mz) * nz * sn;
    assert.ok(off >= 0 && off < 0.3, `on the line, a hair behind the face (${off.toFixed(2)})`);
    assert.ok(Math.abs(q[1] - own) < 0.3, `its own side's height: ${q[1].toFixed(2)} vs ${own.toFixed(2)}`);
  }
  // far from any wall: left alone
  assert.strictEqual(quaySnap(t, -95600, -6600, SNAP), null);
});
