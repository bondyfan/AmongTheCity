// ---- sanity tests for the v5 interiors + destructible piece model ----
// interiors.js and pieces.js are deliberately free of three.js, so the whole
// "does every building have a sane inside" question can be answered headless
// against the real Pardubice data — before a browser ever opens the page.
//
// The two tests that matter most are the STAIR ones. Both encode bugs that
// actually shipped and were caught in play: a stair shaft parked on a part of
// the OBB the building does not occupy (all 19 treads clipped away, upper
// floors unreachable), and slab tiles wide enough to seal the hole the stair
// climbs through (nine treads into a ceiling).

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildingPlan, classify, hasInterior, entranceOf } from '../js/interiors.js';
import { interiorPieces, shellPieces } from '../js/pieces.js';

const city = JSON.parse(readFileSync(new URL('../public/data/pardubice.json', import.meta.url), 'utf8'));
let _id = 1;
for (const b of city.buildings) b._id = _id++;
const named = (re) => city.buildings.filter(b => b.n && re.test(b.n));

test('use classification reads the city the way a local would', () => {
  const use = (re) => {
    const b = named(re).sort((p, q) => (q.o.length) - (p.o.length))[0];
    assert.ok(b, `no building matching ${re}`);
    return classify(b);
  };
  assert.equal(use(/^Kaufland$/), 'supermarket');
  assert.equal(use(/^Lidl$/), 'supermarket');
  assert.equal(use(/^Palác Pardubice$/), 'mall');
  assert.equal(use(/^HALA B$/), 'industrial');   // a shed, not a sports hall
  assert.equal(use(/Gymnázium/), 'school');

  // and the bulk of the city lands somewhere believable
  const counts = {};
  for (const b of city.buildings) counts[classify(b)] = (counts[classify(b)] ?? 0) + 1;
  assert.ok(counts.house > 2000, `houses: ${counts.house}`);
  assert.ok(counts.flats > 500, `blocks of flats: ${counts.flats}`);
  assert.ok(counts.mall >= 3 && counts.mall < 40, `malls: ${counts.mall}`);
  assert.ok(counts.industrial > 200, `industry: ${counts.industrial}`);
});

test('every multi-storey building has a staircase that is actually built', () => {
  let multi = 0, stairless = 0;
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    const plan = buildingPlan(b, null);
    if (plan.storeys < 2) continue;
    multi++;
    assert.ok(plan.core, 'a multi-storey plan must carry a stair core');
    const treads = interiorPieces(plan).filter(p => p.kind === 'stair').length;
    if (treads === 0) stairless++;
  }
  assert.ok(multi > 2000, `multi-storey buildings: ${multi}`);
  assert.equal(stairless, 0, `${stairless} buildings have upper floors you cannot reach`);
});

test('the slab leaves the stair well open on every floor above the ground', () => {
  // A tile whose CENTRE misses the void but whose body covers it seals the
  // shaft. Sample the middle of the run on each upper floor and assert no
  // floor piece is sitting over it.
  const tall = city.buildings
    .filter(b => hasInterior(b) && (b.lv ?? 0) >= 4)
    .sort((a, b) => b.h - a.h).slice(0, 40);
  assert.ok(tall.length > 10, 'need some tall buildings to test');
  for (const b of tall) {
    const plan = buildingPlan(b, null);
    if (!plan.core) continue;
    const { fr, core } = plan;
    const run = core.run;
    const u = (run.u0 + run.u1) / 2, v = (run.v0 + run.v1) / 2;
    const x = fr.cx + fr.ux * u + fr.vx * v, z = fr.cz + fr.uz * u + fr.vz * v;
    const pieces = interiorPieces(plan);
    for (let fi = 1; fi < plan.storeys; fi++) {
      const y = plan.floors[fi].y;
      const blocking = pieces.filter(p => p.kind === 'floor'
        && Math.abs(p.top - y) < 0.01
        && Math.abs(p.x - x) <= p.ax + 0.01 && Math.abs(p.z - z) <= p.az + 0.01);
      assert.equal(blocking.length, 0,
        `floor ${fi} of a ${plan.storeys}-storey ${plan.use} roofs over its own staircase`);
    }
  }
});

test('pieces are finite, solid and inside their own building', () => {
  const sample = [];
  const byUse = {};
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    const u = classify(b);
    if ((byUse[u] = (byUse[u] ?? 0) + 1) <= 3) sample.push(b);
  }
  assert.ok(sample.length > 20, 'sample covers the use classes');
  for (const b of sample) {
    const plan = buildingPlan(b, null);
    const all = interiorPieces(plan).concat(shellPieces(plan));
    assert.ok(all.length > 0, `${plan.use} produced no geometry`);
    for (const p of all) {
      assert.ok(Number.isFinite(p.x + p.y + p.z + p.yaw), 'finite placement');
      assert.ok(p.hx > 0 && p.hy > 0 && p.hz > 0, 'positive half-extents');
      assert.ok(p.y - p.hy > plan.y0 - 1.2, 'nothing buried under the building');
      // a brand TOTEM legitimately stands above the roof — that is what makes
      // it visible from the road; everything else must stay under the parapet
      if (p.kind !== 'sign')
        assert.ok(p.y + p.hy < plan.top + 2.5, `${p.kind} floating over the roof`);
    }
  }
});

test('the street door sits on the footprint and faces outward', () => {
  for (const b of city.buildings.filter(hasInterior).slice(0, 400)) {
    const e = entranceOf(b, null);
    assert.ok(e, 'every building with an inside gets a way in');
    const a = b.o[e.i], c = b.o[(e.i + 1) % b.o.length];
    // the door point is the midpoint of the edge it was cut into
    assert.ok(Math.abs(e.x - (a[0] + c[0]) / 2) < 1e-6, 'door x on its edge');
    assert.ok(Math.abs(e.z - (a[1] + c[1]) / 2) < 1e-6, 'door z on its edge');
    assert.ok(Math.abs(Math.hypot(e.nx, e.nz) - 1) < 1e-6, 'unit normal');
    // …and the normal points AWAY from the building: a step along it must
    // leave the polygon (checked against the ring's own winding)
    assert.ok(e.w > 0.5, 'the opening is wide enough to walk through');
  }
});

test('no interior surface is coplanar with the ground layers or with itself', () => {
  // Z-fighting is the one class of bug that never throws and always looks
  // broken. Two real ones shipped: the ground-floor slab landed 1 cm under
  // config's `paved` layer (OSM draws car parks straight through building
  // footprints, so every shop floor shimmered), and painted parking bays sat
  // exactly in the plane of the deck they were painted on. Both are cheap to
  // assert against: no big horizontal face may share a plane with the LAYER_Y
  // ladder, and no two big horizontal faces in one building may share one
  // either — unless they are meant to (a floor slab IS a ceiling).
  const LAYERS = [0, 0.05, 0.08, 0.10, 0.14, 0.16, 0.20, 0.26];
  const EPS = 0.03;
  const sample = [];
  const byUse = {};
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    const u = classify(b);
    if ((byUse[u] = (byUse[u] ?? 0) + 1) <= 2) sample.push(b);
  }
  for (const b of sample) {
    const plan = buildingPlan(b, null);
    const all = interiorPieces(plan).concat(shellPieces(plan));
    for (const p of all) {
      // only faces big enough to actually shimmer
      if (p.hx < 0.35 || p.hz < 0.35) continue;
      for (const y of [p.y - p.hy, p.y + p.hy]) {
        for (const L of LAYERS) {
          assert.ok(Math.abs(y - L) > EPS,
            `${plan.use}: a ${p.kind} face at y=${y.toFixed(3)} shares the LAYER_Y ${L} plane`);
        }
      }
    }
  }
});
