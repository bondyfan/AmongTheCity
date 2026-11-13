// ---- The parts a person is built from: mesh builder, wardrobe, seat fit ----
//
// js/citizen.js v3 is assembled from small pure modules, and these are the
// tests for the logic in them that has a right answer:
//
//   · js/bodymesh.js   a lofted tube must be a closed solid wound OUTWARD. A
//                      tube wound inside out renders as a hole (back faces are
//                      culled) and nothing throws, so it is pinned here by its
//                      signed volume.
//   · js/wardrobe.js   the same random stream must dress the same person: two
//                      co-op clients never talk about what a citizen wears.
//   · every outfit the wardrobe can draw must BUILD, for every body: a hem
//                      rule that only breaks for a grandmother in shorts is
//                      found here, not on a street at night.
//   · js/seating.js    a seated body must be inside the car, for all eight.

import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { BodyMesh } = await import('../js/bodymesh.js');
const { bodyDims, BONE_COUNT, SHAPE } = await import('../js/bodyshape.js');
const { buildBody, TOPS } = await import('../js/bodybuild.js');
const { buildHead } = await import('../js/bodyhead.js');
const W = await import('../js/wardrobe.js');
const { seatX, SIT_DROP } = await import('../js/seating.js');
const { seatAnchor, CAR_KINDS } = await import('../js/vehicles.js');
const { lookForUid, PLAYER_JACKETS } = await import('../js/identity.js');
const { ARCHETYPES } = await import('../js/people.js');

// six times the signed volume of the triangles [from, from + count)
function volume6(g, from, count) {
  const p = g.attributes.position.array, ix = g.index.array;
  let v = 0;
  for (let i = from; i < from + count; i += 3) {
    const a = ix[i] * 3, b = ix[i + 1] * 3, c = ix[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v;
}

// ------------------------------------------------------------- the mesh ----

test('a tube is a closed solid wound outward, in either ring order', () => {
  const rings = [
    { y: 0.0, rx: 0, c: 0xffffff }, { y: 0.1, rx: 0.1, c: 0xffffff }, { y: 0.9, rx: 0.1, c: 0xffffff }, { y: 1.0, rx: 0, c: 0xffffff },
  ];
  for (const order of [rings, rings.slice().reverse()]) {
    const M = new BodyMesh();
    M.tube(order.map((r) => ({ ...r })), { segs: 12 });
    const g = M.build(), u = g.userData;
    const vol = volume6(g, 0, u.nearCount) / 6;
    // a cylinder r = 0.1, h = 0.8 plus two cones: about 0.027 m3
    assert.ok(vol > 0.02 && vol < 0.03, `near volume ${vol.toFixed(4)} (negative means inside out)`);
    const far = volume6(g, u.farStart, u.farCount) / 6;
    assert.ok(far > 0.005 && far < vol * 1.001, `far volume ${far.toFixed(4)}`);
    // normals: unit length, and away from the axis on the wall
    const n = g.attributes.normal.array, p = g.attributes.position.array;
    for (let i = 0; i < n.length; i += 3) {
      assert.ok(Math.abs(Math.hypot(n[i], n[i + 1], n[i + 2]) - 1) < 1e-3, 'a normal is not unit length');
      if (p[i + 1] > 0.05 && p[i + 1] < 0.95) assert.ok(n[i] * p[i] + n[i + 2] * p[i + 2] > 0, 'a wall normal points inward');
    }
  }
});

test('a hard colour seam splits the ring, and a pole closes the tube', () => {
  const M = new BodyMesh();
  M.tube([{ y: 0, rx: 0.1, c: 0xff0000 }, { y: 0.5, rx: 0.1, c: 0xff0000, c2: 0x0000ff }, { y: 1, rx: 0.1, c: 0x0000ff }], { segs: 8 });
  const g = M.build();
  assert.equal(g.attributes.position.count, 8 * 4, 'the seam ring should exist twice');
  const c = g.attributes.color.array;
  // row 1 (below the seam) is red, row 2 (above it) is blue: no gradient between
  assert.ok(c[8 * 3] > 0.9 && c[8 * 3 + 2] < 0.1);
  assert.ok(c[16 * 3] < 0.1 && c[16 * 3 + 2] > 0.9);
});

// ---------------------------------------------------------- the wardrobe ----

test('the same random stream dresses the same person, a different one somebody else', () => {
  for (const a of ARCHETYPES) {
    const one = W.pickOutfit(a.key, W.seededRnd(42)), two = W.pickOutfit(a.key, W.seededRnd(42));
    assert.deepEqual(one, two, `${a.key}: not deterministic`);
  }
  const seen = new Set();
  for (let s = 0; s < 200; s++) { const o = W.pickOutfit('f30', W.seededRnd(s)); seen.add(o.top + o.bottom + o.hairStyle + o.topColor); }
  assert.ok(seen.size > 100, `only ${seen.size} distinct women in 200 draws: a clone army`);
});

test('pinned colours win over the draw, and never shift what else is drawn', () => {
  const free = W.pickOutfit('m30', W.seededRnd(7));
  const pinned = W.pickOutfit('m30', W.seededRnd(7), { jacket: 0x123456, pants: 0x654321, skin: 0xabcdef, hair: 0x111111 });
  assert.equal(pinned.topColor, 0x123456);
  assert.equal(pinned.bottomColor, 0x654321);
  assert.equal(pinned.skin, 0xabcdef);
  assert.equal(pinned.hair, 0x111111);
  assert.equal(pinned.top, free.top);
  assert.equal(pinned.hairStyle, free.hairStyle);
  assert.equal(pinned.bag, free.bag);
});

test('the wardrobe follows the body: sticks, grey hair, no shorts under a coat', () => {
  for (let s = 0; s < 300; s++) {
    for (const a of ARCHETYPES) {
      const o = W.pickOutfit(a.key, W.seededRnd(s * 31 + 5));
      assert.equal(o.cane, a.key === 'm90', `${a.key}: cane`);
      if (a.age >= 90) assert.ok(W.HAIRS_WHITE.includes(o.hair));
      else if (a.age >= 60) assert.ok(W.HAIRS_GREY.includes(o.hair));
      if (o.bottom === 'shorts') assert.ok(!['coat', 'puffer', 'jacket'].includes(o.top), 'shorts under a winter top');
      if (o.top === 'dress') { assert.equal(o.bottom, 'skirt'); assert.ok(a.sex === 'f', 'a man was dealt a dress'); }
      assert.ok(TOPS[o.top], `unknown top ${o.top}`);
    }
  }
});

test('a player keeps the four identity colours and gains a stable outfit', () => {
  const a = lookForUid('u4f2a1'), b = lookForUid('u4f2a1'), c = lookForUid('u4f2a2');
  assert.ok(PLAYER_JACKETS.includes(a.jacket));
  assert.deepEqual(a, b);
  assert.equal(a.outfit.topColor, a.jacket, 'the body does not wear the jacket the map and the name tag show');
  assert.equal(a.outfit.bottomColor, a.pants);
  assert.equal(a.outfit.skin, a.skin);
  assert.equal(a.outfit.cane, false);
  assert.ok(a.outfit.player);
  assert.ok(c.outfit, 'every uid gets one');
});

// ------------------------------------------- every outfit on every body ----

test('every top, bottom, haircut and hat builds a sound mesh on all five bodies', () => {
  const tops = Object.keys(TOPS), bottoms = ['trousers', 'jeans', 'shorts', 'skirt', 'leggings'];
  const hairs = ['short', 'crop', 'part', 'bald', 'curly', 'bob', 'long', 'pony', 'bun'];
  const hats = [null, 'cap', 'beanie', 'flat', 'scarf', 'police'], bags = [null, 'backpack', 'shoulder', 'hand'];
  let built = 0;
  for (const a of ARCHETYPES) {
    const D = bodyDims(a.key, a.h);
    let i = 0;
    for (const top of tops) for (const bottom of bottoms) {
      const o = W.pickOutfit(a.key, W.seededRnd(built + 1), {
        top, bottom, hairStyle: hairs[i % hairs.length], hat: hats[i % hats.length], bag: bags[i % bags.length],
        glasses: i % 2 === 0, cane: i % 5 === 0, open: i % 3 === 0,
      });
      i++;
      const M = new BodyMesh();
      buildBody(M, D, o);
      const top3 = buildHead(M, D, o);
      const g = M.build(), n = g.attributes.position.count;
      const tag = `${a.key} ${top}/${bottom}/${o.hairStyle}/${o.hat}`;
      assert.ok(n < 65536, `${tag}: ${n} vertices does not fit a 16 bit index`);
      for (const v of g.attributes.position.array) assert.ok(Number.isFinite(v), `${tag}: NaN position`);
      for (const v of g.attributes.normal.array) assert.ok(Number.isFinite(v), `${tag}: NaN normal`);
      for (const v of g.index.array) assert.ok(v < n, `${tag}: index past the vertices`);
      const si = g.attributes.skinIndex.array, sw = g.attributes.skinWeight.array;
      for (let q = 0; q < si.length; q += 4) {
        assert.ok(si[q] < BONE_COUNT && si[q + 1] < BONE_COUNT, `${tag}: bone out of range`);
        assert.equal(sw[q] + sw[q + 1], 255, `${tag}: skin weights do not sum to one`);
      }
      // the whole figure is solids wound outward: its volume is a body's
      const vol = volume6(g, 0, g.userData.nearCount) / 6;
      // (overlapping solids count twice, so a big man in a coat with a backpack reads high)
      assert.ok(vol > 0.035 && vol < 0.30, `${tag}: volume ${vol.toFixed(3)} m3`);
      assert.ok(top3 > D.crownY - 1e-6 && top3 < D.crownY + 0.09, `${tag}: head top ${top3}`);
      built++;
    }
  }
  assert.equal(built, ARCHETYPES.length * tops.length * bottoms.length);
});

test('the five bodies are five shapes, and the old man is the bent one', () => {
  const d = Object.fromEntries(ARCHETYPES.map((a) => [a.key, bodyDims(a.key, a.h)]));
  const shoulderToHip = (D) => D.trunk[6].rx / D.trunk[1].rx;
  assert.ok(shoulderToHip(d.m30) > shoulderToHip(d.f30) + 0.1, 'a man and a woman have the same outline');
  assert.ok(d.m60.trunk[3].fz > d.m30.trunk[3].fz + 0.05, 'sixty has no belly');
  assert.ok(d.m90.limb < d.m30.limb * 0.8, 'ninety has a young man\'s legs');
  assert.ok(SHAPE.m90.stoop > 0.15 && SHAPE.m90.stoop > SHAPE.m60.stoop * 3, 'the ninety-year-old is not bent enough to read at 40 m');
});

// -------------------------------------------------------------- seating ----

test('a seated body is inside every kind of car, on its own side', () => {
  const HALF_BODY = 0.27 * 0.9;
  for (const kind of CAR_KINDS) {
    for (const i of [0, 1, 2, 3]) {
      const a = seatAnchor({ kind }, i), x = seatX(a.x);
      const wid = Math.abs(a.x) / 0.35;
      assert.equal(Math.sign(x), Math.sign(a.x), `${kind} seat ${i} changed sides`);
      assert.ok(Math.abs(x) <= Math.abs(a.x) + 1e-9, `${kind} seat ${i} moved OUTWARD`);
      assert.ok(Math.abs(x) + HALF_BODY <= wid / 2 * 0.80 + 1e-6, `${kind} seat ${i}: a shoulder is through the glass`);
      assert.ok(Math.abs(x) >= HALF_BODY * 0.8, `${kind} seat ${i}: two front riders would share one seat`);
    }
  }
  assert.equal(seatX(0), 0);
  assert.equal(seatX(NaN), 0);
  assert.ok(SIT_DROP > 0.6 && SIT_DROP < 0.9);
});
