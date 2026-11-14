// ---- Prague blocks: courtyards, party walls, the zone and the roof grammar ----
// The pure halves of round 7's BLOCKS package (js/roofholes.js,
// js/partywalls.js, js/praguezone.js, js/roofgrammar.js), on hand-made
// footprints so each rule is pinned on its own, plus one pass over the real
// Old Town tile for the two numbers that made the work necessary.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { roofCapHoled, hasCourtyard, holeShare } = await import('../js/roofholes.js');
const { stampPartyWalls, partyOf, blockCorner } = await import('../js/partywalls.js');
const { inPrague, praguePlace, inOldTown, oldTownK } = await import('../js/praguezone.js');
const { insetRingVar } = await import('../js/roofgrammar.js');
const { insetRing } = await import('../js/roofs.js');
const T = await import('../js/typology.js');
const { classify } = await import('../js/interiors.js');
const { roofInto } = await import('../js/roofs.js');
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
    triFacing(ax, ay, az, bx, by, bz, cx, cy, cz) { tris.push([ax, ay, az, bx, by, bz, cx, cy, cz]); },
    tri(...a) { tris.push(a); }, quad() {}, pinTo() {},
  };
};

test('a courtyard block keeps its yard open under its own roof', () => {
  // a 40 x 40 m palace round a 20 x 20 m yard (the hole wound the other way)
  const outer = rect(0, 0, 40, 40), hole = rect(10, 10, 20, 20).reverse();
  const f = { o: outer, i: [hole] };
  assert.ok(hasCourtyard(f) && holeShare(f) > 0.2);
  const s = recorder();
  const rise = roofCapHoled(s, outer, [hole], 20, 1, 0, 0, 0.3, false, null, tri);
  assert.ok(rise > 1, `the palace kept a pitched roof (rise ${rise})`);
  // nothing lands in the yard past the eave (0.3 m) and the slope it needs
  const inner = rect(11, 11, 18, 18);
  for (const t of s.tris) {
    const x = (t[0] + t[3] + t[6]) / 3, z = (t[2] + t[5] + t[8]) / 3;
    assert.ok(!pip(x, z, inner), `a roof triangle over the yard at ${x.toFixed(1)}, ${z.toFixed(1)}`);
  }
  // and with no ear clipper it builds nothing, so the caller's flat deck shows
  assert.equal(roofCapHoled(recorder(), outer, [hole], 20, 1, 0, 0, 0.3, false, null, null), 0);
});

test('roofOf turns a ridge over a courtyard into the roof that follows it', () => {
  const f = { o: rect(0, 0, 30, 24), i: [rect(8, 6, 14, 12).reverse()], r: 'gabled', lv: 4, h: 14, t: 'residential', _id: 77 };
  const typ = T.typologyOf(f, classify(f));
  assert.equal(T.roofOf(f, typ).shape, 'cap');
  // a light well stays under its ridge
  const g = { o: rect(0, 0, 30, 12), i: [rect(14, 5, 1.5, 1.5).reverse()], r: 'gabled', lv: 4, h: 14, t: 'residential', _id: 78 };
  assert.ok(!hasCourtyard(g));
  assert.equal(T.roofOf(g, T.typologyOf(g, classify(g))).shape, 'gable');
});

test('party walls: shared edges carry the neighbour height, free edges 0, any order', () => {
  // three row houses on a street; the middle one is lower
  const mk = (x, h, id) => ({ o: rect(x, 0, 8, 12), h, lv: Math.round(h / 3.1), _id: id });
  const a = mk(0, 16, 1), b = mk(8.1, 10, 2), c = mk(16.2, 16, 3);
  stampPartyWalls([a, b, c]);
  // rect edges: 0 south, 1 east, 2 north, 3 west
  assert.deepEqual(b._pw, [0, 16, 0, 16]);
  assert.equal(partyOf(a, 1), 10);
  assert.equal(partyOf(a, 3), 0);
  const snap = JSON.stringify([a._pw, b._pw, c._pw]);
  stampPartyWalls([c, a, b]);
  assert.equal(JSON.stringify([a._pw, b._pw, c._pw]), snap, 'the stamp depends on list order');
  // a lone house carries none
  const d = mk(100, 9, 4);
  stampPartyWalls([d]);
  assert.equal(d._pw, undefined);
});

test('slab sections share one name, so one colour', () => {
  const s1 = { o: rect(0, 0, 18, 12), h: 25, lv: 8, _id: 11 }, s2 = { o: rect(18, 0, 18, 12), h: 25, lv: 8, _id: 12 };
  const villa = { o: rect(36, 0, 10, 12), h: 7, lv: 2, r: 'gabled', _id: 13 };
  stampPartyWalls([s2, villa, s1]);
  assert.equal(s1._slab, 11);
  assert.equal(s2._slab, 11);
  assert.equal(villa._slab, undefined);
});

test('the block corner is a free convex corner between two long walls', () => {
  // an end-of-terrace house: its west wall is shared, its north-east corner free
  const a = { o: rect(0, 0, 14, 12), h: 16, _id: 21 }, b = { o: rect(-10, 0, 10, 12), h: 16, _id: 22 };
  stampPartyWalls([a, b]);
  const i = blockCorner(a);
  assert.ok(i === 1 || i === 2, `corner index ${i}`);
  // a free-standing house is a villa, not a block corner
  const v = { o: rect(100, 0, 14, 12), h: 16, _id: 23 };
  stampPartyWalls([v]);
  assert.equal(blockCorner(v), -1);
});

test('insetRingVar is insetRing when every factor is 1, and holds a 0 edge on the wall', () => {
  const ring = rect(0, 0, 10, 6), sgn = 1;
  const a = insetRing(ring, 1, sgn), b = insetRingVar(ring, 1, sgn, [1, 1, 1, 1]);
  for (let i = 0; i < 4; i++) {
    assert.ok(Math.abs(a[i][0] - b[i][0]) < 1e-9 && Math.abs(a[i][1] - b[i][1]) < 1e-9);
  }
  const c = insetRingVar(ring, 1, sgn, [1, 0, 1, 1]);
  // edge 1 (x = 10) stays on its wall line
  assert.ok(Math.abs(c[1][0] - 10) < 1e-9 && Math.abs(c[2][0] - 10) < 1e-9);
});

test('the Prague zone: the city, the old town, and not Pardubice', () => {
  assert.ok(inPrague(-95631, -6205), 'Old Town Square');
  assert.ok(inPrague(-87991, 79), 'Haje');
  assert.ok(!inPrague(1566, -701), 'Pardubice');
  assert.ok(!inPrague(-119482, -22488), 'Kladno');
  assert.equal(oldTownK(-95631, -6205), 1);
  assert.equal(oldTownK(-94081, -4982), 0, 'Vinohrady is not the old town');
  assert.ok(inOldTown({ o: [[-96911, -6239]], _id: 5 }), 'Mala Strana');
  assert.ok(!praguePlace({ o: [[0, 0]] }));
});

test('the grammar stays out of Pardubice: same roof, same triangles', () => {
  const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/0_-1.json', import.meta.url), 'utf8'));
  const bs = tile.buildings.slice(0, 1500);
  bs.forEach((b, i) => { b._id = 900 * (1 << 20) + i + 1; });
  stampPartyWalls(bs);
  let n = 0;
  for (const b of bs) {
    const typ = T.typologyOf(b, classify(b)), roof = T.roofOf(b, typ);
    assert.ok(!roof.old && !(roof.steep && roof.attic === 1 && !b.rl), 'a Prague roof in Pardubice');
    if (typ !== 'tenement') continue;
    // the far shell ring (bare) and the full tier differ by furniture only
    // outside Prague: no cornice, dormer or turret is built here
    const s = recorder();
    roofInto(s, b, typ, roof, 100, [0.5, 0.5, 0.5], b.lv ?? 3, { tri });
    for (const t of s.tris) assert.ok(Math.max(t[1], t[4], t[7]) < 100 + 9, 'something tall on a Pardubice roof');
    n++;
  }
  assert.ok(n > 20, `tenements checked: ${n}`);
});

test('Old Town tile: no courtyard roofed over, no surveyed ridge flattened', () => {
  const tile = JSON.parse(readFileSync(new URL('../public/data/tiles/-20_-2.json', import.meta.url), 'utf8'));
  const bs = tile.buildings;
  bs.forEach((b, i) => { b._id = 200 * (1 << 20) + i + 1; });
  stampPartyWalls(bs);
  let holed = 0, covered = 0, flattened = 0;
  for (const b of bs) {
    const [x, z] = b.o[0];
    const typ = T.typologyOf(b, classify(b)), roof = T.roofOf(b, typ);
    if (x > -96200 && x < -95080 && z > -6760 && z < -5760 && b.r && b.r !== 'flat'
        && roof.shape === 'flat' && typ !== 'panel' && typ !== 'parking') flattened++;
    if (!hasCourtyard(b) || roof.shape === 'flat') continue;
    holed++;
    const s = recorder();
    roofInto(s, b, typ, roof, 50, [0.5, 0.5, 0.5], 4, { tri });
    // (the yard less its eave margin: an eave may hang 0.3 m into it)
    const shrunk = b.i.filter((h) => h.length >= 3)
      .map((h) => insetRing(h, 0.8, polygonArea(h) > 0 ? 1 : -1) ?? h);
    for (const t of s.tris) {
      const cx = (t[0] + t[3] + t[6]) / 3, cz = (t[2] + t[5] + t[8]) / 3;
      if (shrunk.some((h) => pip(cx, cz, h))) { covered++; break; }
    }
  }
  assert.ok(holed > 50, `courtyard roofs checked: ${holed}`);
  assert.ok(covered <= 2, `${covered} courtyard roofs still reach over their yard`);
  assert.equal(flattened, 0, 'a surveyed pitched roof in the Old Town came out flat');
});
