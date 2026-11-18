// ---- courtyard roofs with a depth per edge (round 9, package roofs) ----
// js/roofholes.js built a courtyard block's roof with ONE slope depth for the
// street ring and every yard ring, so a yard lying 0.3 to 0.7 m behind the
// plot line (68 of the 96 Prague courtyard blocks that stayed flat, measured)
// could never clear. js/roofclear.js gives each edge the share of the depth
// the gap in front of it leaves. Pinned here on hand-made blocks: the squeezed
// block gets its roof, the roof stays inside its outline and out of its yard,
// and a block the uniform depth could already roof is untouched.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { roofCapHoled, capPlan } = await import('../js/roofholes.js');
const { ringClearances, depthFactors, frontGap, CLEAR_GAP } = await import('../js/roofclear.js');
const { roofInto, insetRing } = await import('../js/roofs.js');
const { stampPartyWalls } = await import('../js/partywalls.js');
const { hasCourtyard } = await import('../js/roofholes.js');
const T = await import('../js/typology.js');
const { classify } = await import('../js/interiors.js');
const { polygonArea } = await import('../js/geo.js');

const v2 = (r) => r.map(([x, z]) => new THREE.Vector2(x, z));
const tri = (o, h) => THREE.ShapeUtils.triangulateShape(v2(o), h.map(v2));
const rect = (x0, z0, w, d) => [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d], [x0, z0 + d]];
const pip = (x, z, poly) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if ((zi > z) !== (zj > z) && x < (xj - xi) * (z - zi) / (zj - zi) + xi) c = !c;
  }
  return c;
};
const recorder = () => {
  const tris = [];
  return {
    tris,
    triFacing(ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, r, g, b) { tris.push([ax, ay, az, bx, by, bz, cx, cy, cz, nx, ny, nz, r, g, b]); },
    tri(...a) { tris.push(a); }, quad() {}, pinTo() {},
  };
};

test('the gap in front of a wall, and ring clearances', () => {
  const up = [0, 1];
  assert.equal(frontGap([0, 0], [10, 0], up, [5, -1], [5, 1]), 0, 'crossing segments');
  assert.ok(Math.abs(frontGap([0, 0], [10, 0], up, [2, 0.4], [8, 0.4]) - 0.4) < 1e-12);
  assert.equal(frontGap([0, 0], [10, 0], up, [2, -0.4], [8, -0.4]), Infinity, 'behind is no gap');
  assert.equal(frontGap([0, 0], [10, 0], up, [12, 0.4], [18, 0.4]), Infinity, 'past the end is no gap');
  // a slanted wall over part of the span: its lowest point over the span
  assert.ok(Math.abs(frontGap([0, 0], [10, 0], up, [8, 1], [14, 4]) - 1) < 1e-12);
  const outer = rect(0, 0, 40, 30), hole = rect(10, 8, 20, 21.6).reverse();
  const c = ringClearances([outer, hole], [1, 1]);
  // outer edges: 0 south (z 0), 1 east, 2 north (z 30), 3 west
  assert.ok(Math.abs(c[0][2] - 0.4) < 1e-9, `north wall to yard ${c[0][2]}`);
  assert.ok(Math.abs(c[0][0] - 8) < 1e-9 && Math.abs(c[0][1] - 10) < 1e-9);
  assert.equal(Math.min(...c[1]), c[0][2], 'the yard sees the same gap');
  // the yard's side walls end near the thin wall but do not face it
  assert.deepEqual(c[1].map((v) => +v.toFixed(6)), [0.4, 10, 8, 10]);
  const k = depthFactors(c[0], 2.1);
  assert.ok(k[0] === 1 && k[1] === 1 && Math.abs(k[2] - (0.4 - CLEAR_GAP) / 4.2) < 1e-12);
  // a ring's own walls count where they face each other across it, not where
  // they are neighbours or the two sides of a jog
  assert.deepEqual(ringClearances([rect(0, 0, 40, 3)], [1]), [[3, 40, 3, 40]]);
  const step = [[0, 0], [10, 0], [10, 0.2], [20, 0.2], [20, 8], [0, 8]];
  assert.deepEqual(ringClearances([step], [1])[0].map((v) => +v.toFixed(3)), [8, 10, 7.8, 20, 7.8, 10]);
});

test('a yard against the back wall gets its pitched roof, inside the outline and out of the yard', () => {
  // a 40 x 30 m tenement round a yard that stops 0.4 m short of the north wall
  const outer = rect(0, 0, 40, 30), hole = rect(10, 8, 20, 21.6).reverse();
  // one depth for both rings cannot clear 0.4 m
  assert.equal(capPlan(outer, [hole], null, tri, 0.15), null);
  const P = capPlan(outer, [hole], null, tri, 0.15, true);
  assert.ok(P && P.d > 1, 'the per-edge search found a depth');
  const s = recorder();
  const ov = 0.3, rise = roofCapHoled(s, outer, [hole], 20, 1, 0, 0, ov, false, null, tri, 1.2, true, [0, 1, 0]);
  assert.ok(rise > 1, `the block kept a pitched roof (rise ${rise})`);
  // nothing over the yard past its eave, nothing past the street eave
  const yard = rect(10 + ov + 0.05, 8 + ov + 0.05, 20 - 2 * (ov + 0.05), 21.6 - 2 * (ov + 0.05));
  const out = rect(-ov - 0.05, -ov - 0.05, 40 + 2 * (ov + 0.05), 30 + 2 * (ov + 0.05));
  for (const t of s.tris) {
    for (let v = 0; v < 9; v += 3) assert.ok(pip(t[v], t[v + 2], out), `a roof vertex outside the outline at ${t[v]}, ${t[v + 2]}`);
    const x = (t[0] + t[3] + t[6]) / 3, z = (t[2] + t[5] + t[8]) / 3;
    assert.ok(!pip(x, z, yard), `a roof triangle over the yard at ${x.toFixed(2)}, ${z.toFixed(2)}`);
    // every normal is a unit normal that faces up or sideways, never down
    const nl = Math.hypot(t[9], t[10], t[11]);
    assert.ok(Math.abs(nl - 1) < 1e-6 && t[10] >= -1e-9, 'a roof normal off');
  }
  // the ridge rings stop short of each other across the thin wing
  const north = P.inner.filter(([, z]) => z > 29).map(([, z]) => z);
  const yardTop = Math.max(...P.grown[0].map(([, z]) => z));
  assert.ok(north.length && Math.min(...north) - yardTop >= CLEAR_GAP - 1e-9, 'the two ridges cross over the thin wing');
  // where the slopes have no room the wall goes on up to the ridge, upright
  // and in the wall's plaster; everywhere else it is roof
  const fins = s.tris.filter((t) => t[13] === 1);
  assert.ok(fins.length >= 4, 'no plaster over the thin north wing');
  for (const t of fins) {
    assert.ok(t[10] === 0 && Math.abs(Math.abs(t[11]) - 1) < 1e-9, 'a fin that is not an upright north or south face');
    assert.ok(Math.min(t[2], t[5], t[8]) > 29.5 - 1e-9, 'plaster away from the thin wing');
  }
  assert.ok(s.tris.filter((t) => t[12] === 1).length > fins.length * 4, 'the roof itself went plaster');
});

test('a block the uniform depth could roof is not touched by the per-edge search', () => {
  const outer = rect(0, 0, 40, 40), hole = rect(10, 10, 20, 20).reverse();
  const a = recorder(), b = recorder();
  roofCapHoled(a, outer, [hole], 20, 1, 0, 0, 0.3, false, null, tri);
  const P = capPlan(outer, [hole], null, tri, 0.15);
  assert.ok(P && !P.ko && !P.kh, 'the uniform plan carries no factors');
  // the same block through the same call twice: the same triangles, and the
  // uniform depth it always had (7 m wings of 10 m: the deepest that clears)
  roofCapHoled(b, outer, [hole], 20, 1, 0, 0, 0.3, false, null, tri);
  assert.deepStrictEqual(a.tris, b.tris);
  assert.ok(P.d >= 4.5, `uniform depth ${P.d}`);
});

test('the Old Town west tile: courtyard blocks keep their pitch, and their yards open', () => {
  // ids stamped by manifest slot, as the survey that counted them did
  const man = JSON.parse(readFileSync(new URL('../public/data/manifest.json', import.meta.url), 'utf8'));
  const si = man.tiles.findIndex((t) => t.f === 'data/tiles/-21_-2.json');
  const bs = JSON.parse(readFileSync(new URL('../public/data/tiles/-21_-2.json', import.meta.url), 'utf8')).buildings;
  let next = (si + 1) * (1 << 20);
  for (const b of bs) b._id = ++next;
  stampPartyWalls(bs);
  let holed = 0, flat = 0, covered = 0;
  for (const b of bs) {
    if (!b.i?.length || !hasCourtyard(b)) continue;
    const typ = T.typologyOf(b, classify(b)), roof = T.roofOf(b, typ);
    if (roof.shape !== 'cap') continue;
    holed++;
    const s = recorder();
    if (!roofInto(s, b, typ, roof, 50, [0.5, 0.5, 0.5], 4, { tri })) { flat++; continue; }
    const shrunk = b.i.filter((h) => h.length >= 3)
      .map((h) => insetRing(h, 0.8, polygonArea(h) > 0 ? 1 : -1) ?? h);
    for (const t of s.tris) {
      const cx = (t[0] + t[3] + t[6]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
      if (shrunk.some((h) => pip(cx, cz, h))) { covered++; break; }
    }
  }
  // 49 of them stayed flat with one depth for every ring (3e810cb, measured)
  assert.ok(holed > 150, `courtyard roofs checked: ${holed}`);
  assert.ok(flat <= 10, `${flat} courtyard blocks still flat`);
  assert.ok(covered <= 2, `${covered} courtyard roofs reach over their yard`);
});
