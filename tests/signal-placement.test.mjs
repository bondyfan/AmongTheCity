// ---- a signal mast stands at the kerb, never in the lane -------------------
// _makePole offsets "half width + shoulder" perpendicular to the pole's OWN
// approach, and at a junction where service roads come in at angles that spot
// is inside the next road over. Reported standing on Palackého třída with a
// mast in the middle of the lane; measured on this very tile: 3 of 19 poles
// inside a carriageway, the worst 2.35 m in — and with masts now solid
// objects, that is a steel post standing in traffic.
//
// Against the REAL tile rather than a fixture, deliberately: the offending
// geometry is Kpt. Bartoše's slip roads, and a synthetic grid of clean right
// angles never reproduces it (every kerb of every approach clears every other
// road — verified while writing this).
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import fs from 'node:fs';
register(new URL('./three-alias.mjs', import.meta.url));
const { Traffic } = await import('../js/traffic.js');

const d = JSON.parse(fs.readFileSync(new URL('../public/data/tiles/-1_-1.json', import.meta.url)));
const stub = { scene: { add() {}, remove() {} }, cars: new Set(),
  add() { return { mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} },
    wheels: [], x: 0, z: 0, heading: 0, speed: 0, steer: 0, len: 4.6, wid: 1.8, y: 0, _rammedT: 0 }; },
  remove() {} };

test('no signal mast in the Pardubice tile stands inside a carriageway', () => {
  const t = new Traffic({ roads: d.roads ?? [], signals: d.signals ?? [], onTileLoaded() {} }, stub);
  const poles = [];
  for (const jn of t._junctions.values?.() ?? t._junctions)
    for (const sg of jn.sigs ?? []) if (sg.mesh) poles.push([sg.mesh.position.x, sg.mesh.position.z]);
  assert.ok(poles.length >= 12, `only ${poles.length} poles were built — the fix `
    + 'must move masts to the kerb, not delete the junction');
  const segD = (x, z, ax, az, bx, bz) => {
    const ex = bx - ax, ez = bz - az, L2 = ex * ex + ez * ez || 1e-9;
    let q = ((x - ax) * ex + (z - az) * ez) / L2;
    q = q < 0 ? 0 : q > 1 ? 1 : q;
    return Math.hypot(x - (ax + ex * q), z - (az + ez * q));
  };
  for (const [x, z] of poles) {
    for (const r of d.roads) {
      if (!r.d || !r.p || r.p.length < 2) continue;
      for (let k = 0; k < r.p.length - 1; k++) {
        const inside = (r.w ?? 3) / 2 - segD(x, z, r.p[k][0], r.p[k][1], r.p[k + 1][0], r.p[k + 1][1]);
        assert.ok(inside <= 0, `a signal mast at ${x.toFixed(1)}, ${z.toFixed(1)} stands `
          + `${inside.toFixed(2)} m inside a ${r.t}${r.n ? ` "${r.n}"` : ''}`);
      }
    }
  }
});
