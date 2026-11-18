// ---- trees: one description, two tiers ----------------------------------------
// A tree is drawn twice: as a cheap instance in its chunk (built on the main
// thread OR in the worker) and, near the camera, as a full model placed by the
// SAME matrix and coloured by the SAME colour. Nothing but that matrix and that
// colour crosses between the two, so everything here pins the contract that
// makes the swap invisible and the world the same on two machines:
//
//   1. what stands at a spot is a pure function of the spot and its id
//   2. an avenue is one planting, a wood is a mix
//   3. the species survives the colour, through the worker's byte quantisation
//   4. the near model stands on the ground the far matrix puts it on, and fills
//      the crown the far picture is painted from
//   5. a street tree gets its pit on paving and nowhere else
//   6. every species, the shrub included, has a picture framed on its foliage

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const S = await import('../js/treeshapes.js');
const { nearModel, shrubModel } = await import('../js/treemodels.js');
const { impostorFrame } = await import('../js/treeimpostor.js');
const { IMP_COLS, IMP_ROWS } = await import('../js/treeshader.js');
const { pavingUnder, treePitsInto } = await import('../js/treepits.js');
const { treeQuality } = await import('../js/trees.js');

const street = (i, x, z) => ({ x, z, seed: 5000 + i, forest: false });

test('the same spot grows the same tree, whoever asks', () => {
  for (let i = 0; i < 400; i++) {
    const t = { x: i * 7.3 - 900, z: i * 3.1 + 40, seed: 77 + i * 13, forest: i % 3 === 0, park: i % 6 === 0 };
    const a = S.treeSpec(t, 0, {}), b = S.treeSpec({ ...t }, 0, {});
    assert.deepEqual(a, b);
    assert.ok(a.sp >= 0 && a.sp < S.SPECIES.length, `species ${a.sp}`);
    assert.ok(a.h > 0.5 && a.h < 40 && a.rx > 0.2 && a.ry > 0.2, `a ${a.h} m tree ${a.rx} m wide`);
    assert.ok(a.rt > 0 && a.ht > 0);
  }
});

test('an avenue is one planting and a wood is a mix', () => {
  // 20 trees along one 72 m block of street
  const row = [];
  for (let i = 0; i < 20; i++) row.push(S.treeSpec(street(i, 150 + i * 3.4, 300), 0, {}).sp);
  const count = new Map();
  for (const sp of row) count.set(sp, (count.get(sp) ?? 0) + 1);
  const most = Math.max(...count.values());
  assert.ok(most >= 14, `the commonest species is only ${most} of 20 in one block`);
  // heights of the dominant species agree: they were planted together
  const main = [...count.entries()].find((e) => e[1] === most)[0], hs = [];
  for (let i = 0; i < 20; i++) { const s = S.treeSpec(street(i, 150 + i * 3.4, 300), 0, {}); if (s.sp === main) hs.push(s.h); }
  assert.ok(Math.max(...hs) / Math.min(...hs) < 1.3, `one planting from ${Math.min(...hs).toFixed(1)} to ${Math.max(...hs).toFixed(1)} m`);
  // …and a square kilometre of wood holds several species, conifers among them
  const wood = new Set();
  for (let i = 0; i < 3000; i++) {
    const t = { x: (i % 60) * 17, z: Math.floor(i / 60) * 19, seed: 90000 + i, forest: true };
    wood.add(S.treeSpec(t, 0, {}).sp);
  }
  assert.ok(wood.size >= 5, `a wood of ${wood.size} species`);
  assert.ok(wood.has(S.SP.PINE) && wood.has(S.SP.SPRUCE) && wood.has(S.SP.OAK));
});

test('a measured height is used, and a roof is not mistaken for one', () => {
  const t = street(1, 10, 10), free = S.treeSpec(t, 0, {});
  const lo = S.SPECIES[free.sp].h[0], hi = S.SPECIES[free.sp].h[1];
  const tall = S.treeSpec(t, hi, {});
  assert.ok(Math.abs(tall.h - hi) < hi * 0.07, `measured ${hi} m, drawn ${tall.h.toFixed(1)} m`);
  // 60 m is the tower block beside it
  const roof = S.treeSpec(t, 60, {});
  assert.ok(roof.h >= lo && roof.h <= hi, `a ${roof.h.toFixed(1)} m street tree`);
});

test('the species rides in the colour and survives the worker', () => {
  const col = new THREE.Color();
  for (let sp = 0; sp < S.SPECIES.length; sp++) for (const variant of [0, 1]) for (const light of [-0.05, 0, 0.05]) {
    S.crownColor({ sp, variant, light }, col);
    // the main-thread path keeps the float, the worker ships a normalised byte
    const bytes = [col.r, col.g, col.b].map((v) => Math.round(v * 255));
    for (let k = 0; k < 3; k++) assert.ok(Math.abs([col.r, col.g, col.b][k] * 255 - bytes[k]) < 1e-4, 'not on a byte');
    assert.equal(S.tagSpecies(bytes[0], bytes[2]), sp);
    assert.equal(S.tagVariant(bytes[1]), variant);
    // the tag costs at most three steps of a channel: nothing the eye reads
    col.setHex(S.SPECIES[sp].crown).offsetHSL(0, 0, light);
    assert.ok(Math.abs(col.r * 255 - bytes[0]) <= 3.5 && Math.abs(col.b * 255 - bytes[2]) <= 3.5);
  }
});

test('the far template is what the codec can carry', () => {
  const g = S.farTemplate();
  assert.equal(g.getAttribute('position').count, S.FAR_VERTS);
  for (const name of ['position', 'normal', 'color', 'uv']) assert.ok(g.getAttribute(name), name);
  const p = g.getAttribute('position'), n = g.getAttribute('normal'), c = g.getAttribute('color'), uv = g.getAttribute('uv');
  let quad = 0;
  for (let i = 0; i < n.count; i++) {
    assert.ok(Math.abs(Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) - 1) < 2e-3, 'a normal off unit length');
    for (const v of [c.getX(i), c.getY(i), c.getZ(i), uv.getX(i), uv.getY(i)]) assert.ok(v >= 0 && v <= 1, `${v} outside 0..1`);
    // the shader tells the picture from the trunk by the normal alone, and
    // the codec ships normals as bytes: the two must be far apart
    const ny = Math.round(n.getY(i) * 127) / 127;
    if (ny < -0.5) quad++;
    else assert.ok(ny > -0.2, `a trunk normal ${ny} too close to the picture's marker`);
  }
  assert.equal(quad, 4, 'the picture is one quad');
  assert.ok(g.index, 'a template that shares no vertices cannot shade smooth');
  // The worker quantises the template by its largest coordinate and folds that
  // into the instance matrices; the shader reads a crown's radii off those
  // matrices, so the largest coordinate must be exactly 1 (the fold is then 1)
  let ext = 0;
  for (let i = 0; i < p.count; i++) ext = Math.max(ext, Math.abs(p.getX(i)), Math.abs(p.getY(i)), Math.abs(p.getZ(i)));
  assert.equal(ext, 1);
  assert.equal(S.farCrownExtent(), 1);
  assert.ok(S.FAR_BOUND_PAD > 0);
  // the pad a batch takes covers its tallest tree: a 36 m pine reaches past
  // the 14 m floor, a street lime does not
  const reach = (sp, h, rx, ry) => S.farBoundPad({ sp, h, rx, ry });
  assert.ok(reach(S.SP.LINDEN, 14, 4, 4) <= S.FAR_BOUND_PAD);
  assert.ok(reach(S.SP.PINE, 36, 4, 5.5) > S.FAR_BOUND_PAD);
  for (let sp = 0; sp < S.SPECIES.length; sp++) {
    const ry = 5, rx = 4, m = Math.max(rx, ry), lowest = S.groundOf(sp) * ry + S.TRUNK_SINK;
    assert.ok(Math.SQRT2 * m + reach(sp, 20, rx, ry) >= lowest - 1e-9, `${S.SPECIES[sp].name}: the pad misses the trunk's foot`);
  }
});

test('every species has a picture, framed on its foliage', () => {
  assert.ok(S.SPECIES.length * 2 <= IMP_COLS * IMP_ROWS, 'the atlas has a cell for every build');
  for (let sp = 0; sp < S.SPECIES.length; sp++) for (const variant of [0, 1]) {
    const g = sp === S.SP.SHRUB ? shrubModel(variant) : nearModel(sp, variant), name = S.SPECIES[sp].name;
    assert.ok(g, `${name} has no model to paint`);
    const f = impostorFrame(g);
    // the picture is about a crown wide (a poplar's is its height, which in
    // crown space is about 1), and centred inside the crown
    assert.ok(f.half > 0.6 && f.half < 1.9, `${name}: a picture ${f.half.toFixed(2)} crown radii wide`);
    assert.ok(Math.abs(f.yc) < 0.5, `${name}: picture centred ${f.yc.toFixed(2)} off the crown`);
    assert.ok(f.foot >= f.yc - f.half, `${name}: the stem would run off the cell`);
  }
  // a shrub's cushion reaches down to its own ground
  const g = shrubModel(0), p = g.getAttribute('position');
  let low = Infinity;
  for (let i = 0; i < p.count; i++) low = Math.min(low, p.getY(i));
  assert.ok(low < -0.8 && low > -1.2, `the shrub's foliage ends at ${low.toFixed(2)}`);
});

test('the near model stands where the far matrix puts the ground', () => {
  const crown = new THREE.Matrix4(), trunk = new THREE.Matrix4(), v = new THREE.Vector3();
  for (let sp = 0; sp < S.SPECIES.length; sp++) {
    if (sp === S.SP.SHRUB) { assert.equal(nearModel(sp, 0), null); continue; }
    // an upright tree of this species at y = 200
    const spec = S.treeSpec({ x: 0, z: 0, seed: 1, forest: false }, 0, {});
    spec.sp = sp; spec.lean = 0;
    const b = S.SPECIES[sp].b; spec.h = 12; spec.ry = spec.h * (1 - b) / 2; spec.cy = spec.h * b + spec.ry; spec.rx = spec.ry * 0.8;
    S.treeMatrices(spec, 0, 200, 0, crown, trunk);
    for (const variant of [0, 1]) {
      const g = nearModel(sp, variant), p = g.getAttribute('position'), uv = g.getAttribute('uv');
      let low = Infinity, top = -Infinity, wide = 0;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        if (uv.getY(i) > 0.5) wide = Math.max(wide, Math.hypot(v.x, v.z));
        v.applyMatrix4(crown);
        low = Math.min(low, v.y); top = Math.max(top, v.y);
      }
      const name = S.SPECIES[sp].name;
      assert.ok(low < 200.05 && low > 199.0, `${name}: the trunk ends ${(low - 200).toFixed(2)} m from the ground`);
      assert.ok(Math.abs(top - 212) < 1.3, `${name}: a 12 m tree drawn ${(top - 200).toFixed(1)} m tall`);
      // the foliage fills the crown (a spruce is a cone, widest at its foot)
      assert.ok(wide > 0.7 && wide < (sp === S.SP.SPRUCE ? 1.75 : 1.3), `${name}: foliage ${wide.toFixed(2)} crown radii wide`);
      for (const name2 of ['normal', 'aGeoN', 'color', 'uv']) assert.equal(g.getAttribute(name2).count, p.count);
      assert.ok(p.count < 1500, `${name} is ${p.count} vertices`);
    }
  }
});

test('a street tree gets a pit on paving and nowhere else', () => {
  const terrain = { heightAt: () => 220 };
  const cell = { roads: [], paved: [{ o: [[0, 0], [40, 0], [40, 40], [0, 40]] }] };
  const on = pavingUnder(cell, 20, 20, terrain);
  assert.ok(on && Math.abs(on.y - 220.10) < 1e-6, 'a tree on a square stands in a pit at the paving');
  assert.equal(pavingUnder(cell, 60, 20, terrain), null, 'a tree in grass has no pit');
  // …and never in a carriageway, whatever is mapped under it
  const road = { d: 1, w: 7, p: [[0, 20], [40, 20]] };
  assert.equal(pavingUnder({ ...cell, roads: [road] }, 20, 21, terrain), null);
});

test('every tree on paving gets a pit, mapped or not, cut to its trunk', () => {
  const terrain = { heightAt: () => 220 };
  const cell = { roads: [], paved: [{ o: [[0, 0], [40, 0], [40, 40], [0, 40]] }] };
  const quads = [];
  const sink = { mark: () => 0, at() { return this; }, fixFrom() {},
    triFacing: (ax, ay, az, bx, by, bz, cx, cy, cz) => quads.push([ax, az, bx, bz, cx, cz, ay]) };
  const span = () => { let lo = Infinity, hi = -Infinity; for (const q of quads) for (const k of [0, 2, 4]) { lo = Math.min(lo, q[k]); hi = Math.max(hi, q[k]); } return hi - lo; };
  // a scattered tree nobody mapped (the planes on the station forecourt are these)
  treePitsInto(sink, cell, [{ x: 20, z: 20, seed: 9, forest: true, wild: true, h: 9 }], () => ({ rt: 0.2 }), terrain);
  assert.equal(quads.length, 10, 'soil and four frame stones');
  const small = span();
  // ...and an old one gets a bigger pit, or its root flare hides the pit whole
  quads.length = 0;
  treePitsInto(sink, cell, [{ x: 20, z: 20, seed: 9, forest: true, wild: true, h: 22 }], () => ({ rt: 0.6 }), terrain);
  assert.ok(span() > small + 0.5 && span() > 2 * 0.6 * 1.7, `a ${span().toFixed(2)} m pit round a 2 m root flare`);
  // a shrub, and a tree in grass, get none
  quads.length = 0;
  treePitsInto(sink, cell, [{ x: 20, z: 20, seed: 3, bush: true, h: 1.2 }, { x: 60, z: 20, seed: 4, forest: true }], () => ({ rt: 0.2 }), terrain);
  assert.equal(quads.length, 0);
  // the sealed plate a chunk lays where nothing is mapped counts as paving
  // (the station forecourt is one), unless a mapped lawn lies over it
  const plates = [{ x0: 50, z0: 0, x1: 90, z1: 40 }], wild = [{ x: 60, z: 20, seed: 4, forest: true, wild: true, h: 9 }];
  treePitsInto(sink, cell, wild, () => ({ rt: 0.2 }), terrain, plates);
  assert.equal(quads.length, 10);
  assert.ok(Math.abs(Math.min(...quads.map((q) => q[6])) - 220.06) < 1e-6, 'soil 3 cm over the sealed layer');
  quads.length = 0;
  treePitsInto(sink, { ...cell, green: [{ t: 'grass', o: [[50, 0], [90, 0], [90, 40], [50, 40]] }] }, wild, () => ({ rt: 0.2 }), terrain, plates);
  assert.equal(quads.length, 0);
});

test('the quality tiers buy more trees, never fewer', () => {
  const lo = treeQuality({ buildingR: 80 }), mid = treeQuality({ buildingR: 160 }), hi = treeQuality({ buildingR: 280 });
  assert.ok(lo.radius < mid.radius && mid.radius < hi.radius);
  assert.ok(lo.cap < mid.cap && mid.cap < hi.cap);
  assert.ok(lo.radius >= 24 && hi.radius <= 96);
});
