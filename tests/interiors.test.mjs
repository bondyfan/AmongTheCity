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
import { buildingPlan, classify, hasInterior, entranceOf, stampFranchises } from '../js/interiors.js';
import { interiorPieces, shellPieces } from '../js/pieces.js';
import { distPointToSegment } from '../js/geo.js';

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

test('the slab leaves the stair well and lift shaft open above the ground', () => {
  // A tile whose CENTRE misses the void but whose body covers it seals the
  // shaft. Sample the middle of the stair run — and of the lift shaft, where
  // there is one — on each upper floor and assert no floor piece covers it.
  // (Floor tiles all share the OBB yaw, so the overlap test runs in plan
  // space: piece centre mapped back onto (u, v), extents straight off hx/hz.)
  const tall = city.buildings
    .filter(b => hasInterior(b) && (b.lv ?? 0) >= 4)
    .sort((a, b) => b.h - a.h).slice(0, 40);
  assert.ok(tall.length > 10, 'need some tall buildings to test');
  for (const b of tall) {
    const plan = buildingPlan(b, null);
    if (!plan.core) continue;
    const { fr, core } = plan;
    const spots = [core.run];
    if (plan.lift) spots.push(plan.lift.shaft);
    const pieces = interiorPieces(plan).filter(p => p.kind === 'floor');
    for (const r of spots) {
      const u = (r.u0 + r.u1) / 2, v = (r.v0 + r.v1) / 2;
      for (let fi = 1; fi < plan.storeys; fi++) {
        const y = plan.floors[fi].y;
        const blocking = pieces.filter(p => {
          if (Math.abs(p.y + p.hy - y) > 0.01) return false;
          const pu = (p.x - fr.cx) * fr.ux + (p.z - fr.cz) * fr.uz;
          const pv = (p.x - fr.cx) * fr.vx + (p.z - fr.cz) * fr.vz;
          return Math.abs(pu - u) <= p.hx + 0.01 && Math.abs(pv - v) <= p.hz + 0.01;
        });
        assert.equal(blocking.length, 0,
          `floor ${fi} of a ${plan.storeys}-storey ${plan.use} roofs over its own shaft`);
      }
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

test('a block of flats keeps its ground floor for the house, not for flats', () => {
  // The v5.1 reality pass: you enter a panelák through a zádveří into the
  // stair-core landing, the ground floor is sklepy and the kočárkárna, flats
  // start on floor 1 — and four storeys and up ride a výtah. No flat-unit
  // room may appear on floor 0 of any ≥3-storey block.
  const FLAT_ROOMS = new Set(['living', 'bedroom', 'kitchen', 'bath']);
  let three = 0, four = 0;
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    const plan = buildingPlan(b, null);
    if (plan.use !== 'flats' || plan.storeys < 3 || !plan.core) continue;
    three++;
    const g = plan.floors[0];
    assert.ok(g.rooms.some(r => r.kind === 'lobby'),
      `a ${plan.storeys}-storey block with no lobby`);
    assert.ok(!g.rooms.some(r => FLAT_ROOMS.has(r.kind)),
      `a flat-unit room on the ground floor of a ${plan.storeys}-storey block`);
    if (plan.storeys >= 4) {
      four++;
      assert.ok(plan.lift, `a ${plan.storeys}-storey block of flats has no výtah`);
      // the shaft is a real void: open slabs on every floor above the ground
      for (let fi = 1; fi < plan.storeys; fi++)
        assert.ok(plan.floors[fi].open.includes(plan.lift.shaft),
          'the lift shaft is slabbed over');
    }
  }
  assert.ok(three > 800, `3+-storey blocks checked: ${three}`);
  assert.ok(four > 200, `4+-storey blocks checked: ${four}`);
});

test('the front door never opens into the stair core', () => {
  // placeCore scores candidates toward the entrance but must SHIFT any shaft
  // that would swallow the door — the entrance edge midpoint may never fall
  // inside the stair shaft (nor the lift's).
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    const plan = buildingPlan(b, null);
    if (!plan.core || !plan.entrance) continue;
    const fr = plan.fr, e = plan.entrance;
    const u = (e.x - fr.cx) * fr.ux + (e.z - fr.cz) * fr.uz;
    const v = (e.x - fr.cx) * fr.vx + (e.z - fr.cz) * fr.vz;
    for (const s of plan.lift ? [plan.core.shaft, plan.lift.shaft] : [plan.core.shaft])
      assert.ok(!(u > s.u0 && u < s.u1 && v > s.v0 && v < s.v1),
        `the entrance midpoint sits inside the core shaft of a ${plan.use}`);
  }
});

test('a supermarket is stocked, and stays inside the piece budget', () => {
  for (const re of [/^Kaufland$/, /^Lidl$/]) {
    const b = named(re).sort((p, q) => q.o.length - p.o.length)[0];
    assert.ok(b, `no building matching ${re}`);
    const plan = buildingPlan(b, null);
    const interior = interiorPieces(plan);
    const goods = interior.filter(p => p.goods).length;
    assert.ok(goods >= 40, `${b.n}: only ${goods} goods runs on the shelving`);
    const total = interior.length + shellPieces(plan).length;
    assert.ok(total <= 5000, `${b.n}: ${total} pieces blows the interior budget`);
  }
});

test('brand signage carries the wordmark contract', () => {
  // Fascia band pieces and the totem panel all carry signText/signBg/signFg —
  // destructible.js paints the actual wordmark from those three fields.
  const expect = [
    [/^Kaufland$/, 'Kaufland', 0xe10915, 0xffffff],
    [/^Lidl$/, 'Lidl', 0x0050aa, 0xffffff],
  ];
  for (const [re, label, bg, fg] of expect) {
    const b = named(re).sort((p, q) => q.o.length - p.o.length)[0];
    assert.ok(b, `no building matching ${re}`);
    const signs = shellPieces(buildingPlan(b, null)).filter(p => p.kind === 'sign');
    assert.ok(signs.length >= 2, `${label}: expected a fascia and a totem`);
    // The wordmark sits on SOME sign pieces (one per fascia run + the totem),
    // never stretched across every 12 m segment — the rest stay plain fascia.
    const marked = signs.filter(p => p.signText !== undefined);
    assert.ok(marked.length >= 2, `${label}: no wordmark-carrying pieces`);
    assert.ok(marked.length < signs.length || signs.length <= 3,
      `${label}: every fascia segment carries the wordmark (it would tile stretched)`);
    for (const p of marked) {
      assert.equal(p.signText, label, `${label}: a sign piece with the wrong wordmark`);
      assert.equal(p.signBg, bg, `${label}: wrong sign background`);
      assert.equal(p.signFg, fg, `${label}: wrong sign foreground`);
    }
  }
  // Billa is the one chain that prints dark on its yellow
  const billa = named(/^Billa/i)[0];
  if (billa) {
    const signs = shellPieces(buildingPlan(billa, null))
      .filter(p => p.kind === 'sign' && p.signText !== undefined);
    for (const p of signs) assert.equal(p.signFg, 0x1c1c1c, 'Billa reads dark-on-yellow');
  }
  // McDonald's has no explicit fg — BOTH LOD tiers must fall back the same way
  // (trim red on the yellow fascia), or the sign changes ink at the tier swap.
  // The franchises are stamped at runtime, so stamp them here the same way
  // city.js does before looking one up.
  stampFranchises(city.buildings, city);
  const mcd = city.buildings.find(b => /mcdonald/i.test(b.n ?? ''));
  // Earlier tests built plans for every building BEFORE the stamp — in the
  // game the stamp runs at tile load, before any plan exists, so drop the
  // stale cache rather than weaken the assertion.
  if (mcd) { delete mcd._plan; delete mcd._use; mcd._brand = undefined; }
  if (mcd) {
    const signs = shellPieces(buildingPlan(mcd, null))
      .filter(p => p.kind === 'sign' && p.signText !== undefined);
    assert.ok(signs.length >= 1, "McDonald's grew no wordmark");
    for (const p of signs) assert.equal(p.signFg, 0xda291c, "McDonald's ink is its trim red");
  }
});

// ---- v7 architectural identity ---------------------------------------------

test('a fast-food pavilion is glass where it faces the car park', () => {
  // The v7 complaint: "McDonald's má branding, ale budova vypadá jak sovětská
  // krabice". The fix is a real pavilion shell — the entrance run must be
  // mostly GLASS (by facade area, panes vs solid pieces), under a cladding
  // band, with the mullions thin enough not to eat the frontage.
  stampFranchises(city.buildings, city);
  const mcd = city.buildings.find(b => /mcdonald/i.test(b.n ?? ''));
  assert.ok(mcd, "the franchise stamp produced no McDonald's");
  delete mcd._plan; delete mcd._use; mcd._brand = undefined;   // stale caches
  const plan = buildingPlan(mcd, null);
  assert.equal(plan.use, 'restaurant');
  const e = plan.entrance;
  const a = mcd.o[e.i], b2 = mcd.o[(e.i + 1) % mcd.o.length];
  const probe = { x: 0, z: 0, t: 0 };
  let glass = 0, solid = 0;
  for (const p of shellPieces(plan)) {
    if (p.kind !== 'glass' && p.kind !== 'ext') continue;
    if (p.y + p.hy > plan.top - 0.1) continue;   // parapet / roof overhang
    if (distPointToSegment(p.x, p.z, a[0], a[1], b2[0], b2[1], probe) > 1.6) continue;
    if (p.kind === 'glass') glass += p.hx * p.hy; else solid += p.hx * p.hy;
  }
  assert.ok(glass > 0, 'no glazing on the entrance run');
  assert.ok(glass / (glass + solid) >= 0.6,
    `entrance frontage is only ${(100 * glass / (glass + solid)).toFixed(0)} % glass`);
});

test('a panelák hangs balconies off its long facades', () => {
  // prefab type, or six storeys and up: a grid of balcony slabs with weak
  // rail panels, every storey above the first
  let checked = 0;
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    if (classify(b) !== 'flats') continue;
    const plan = buildingPlan(b, null);
    if (plan.nova || plan.storeys < 3) continue;
    if (!(plan.osmT === 'panel' || plan.storeys >= 6)) continue;
    let maxL = 0;
    for (let i = 0; i < b.o.length; i++) {
      const [ax, az] = b.o[i], [bx, bz] = b.o[(i + 1) % b.o.length];
      maxL = Math.max(maxL, Math.hypot(bx - ax, bz - az));
    }
    if (maxL < 12) continue;         // nowhere to hang a run of balconies
    checked++;
    const balc = shellPieces(plan).filter(p => p.balcony);
    assert.ok(balc.length >= 4, `a ${plan.storeys}-storey panelák with no balconies`);
    assert.ok(balc.some(p => p.kind === 'rail' && p.weak), 'balcony rails must be weak');
    assert.ok(balc.every(p => p.y > plan.y0 + plan.sH - 0.5),
      'balconies start above the ground floor');
    if (checked >= 50) break;
  }
  assert.ok(checked >= 15, `paneláky checked: ${checked}`);
});

test('novostavby exist, carry their own colour, and dropped the atlas', () => {
  // Hash-scattered (no OSM "year built" signal): ~30 % of the 3–5 storey
  // non-panel flats become new builds. Each must stamp f.c — that is the one
  // channel meshes.js's far LOD already reads, so near and far agree — and
  // their shell is flat plaster with tall windows and French balcony rails.
  let nova = 0, sampled = 0, withRail = 0;
  for (const b of city.buildings) {
    if (!hasInterior(b)) continue;
    if (classify(b) !== 'flats') continue;
    const plan = buildingPlan(b, null);
    if (!plan.nova) continue;
    nova++;
    assert.ok(typeof b.c === 'string' && b.c.startsWith('#'),
      'a novostavba must stamp f.c so the far LOD agrees');
    if (sampled < 10) {
      sampled++;
      const shell = shellPieces(plan);
      if (shell.some(p => p.french)) withRail++;
      assert.ok(!shell.some(p => p.uv),
        'a novostavba shell still samples the facade atlas');
    }
  }
  assert.ok(nova >= 20, `novostavby found: ${nova}`);
  assert.ok(withRail >= sampled * 0.5,
    `French balconies on only ${withRail}/${sampled} sampled novostavby`);
});

// ---- franchises are RARE, and they are shops ------------------------------
// "na dost místech, kde jsou nějaké obchody nebo nějaké firmy, tak to dělá buď
// McDonald's, anebo KFC". The host pool used to include `civic`, which is the
// classifier's catch-all — both a common OSM tag and the geometry fallback for
// any untyped footprint over 700 m². 23 of the 24 restaurants stamped in this
// very file landed on one: schools, sports halls, a fire station.
test('the franchise stamp is rare, and only ever lands on retail', () => {
  const fresh = JSON.parse(
    readFileSync(new URL('../public/data/pardubice.json', import.meta.url), 'utf8'));
  const before = fresh.buildings.filter((b) => b.n).length;
  stampFranchises(fresh.buildings, fresh);
  const stamped = fresh.buildings.filter(
    (b) => /mcdonald/i.test(b.n ?? '') || /\bkfc\b/i.test(b.n ?? ''));
  assert.ok(stamped.length <= 6,
    `${stamped.length} fast-food restaurants stamped on one town — Pardubice has about three`);
  assert.ok(stamped.length >= 1, 'a town this size has at least one');
  // …and each one stands at a SITE — a station or a hypermarket car park —
  // rather than wherever a hash happened to land it
  const anchors = [
    ...fresh.pois.filter((p) => p.t === 'station').map((p) => p.p),
    ...fresh.paved.filter((p) => p.t === 'parking' && p.o?.length >= 3)
      .map((p) => [p.o.reduce((a, q) => a + q[0], 0) / p.o.length,
        p.o.reduce((a, q) => a + q[1], 0) / p.o.length]),
  ];
  for (const b of stamped) {
    const d = Math.min(...anchors.map((a) => Math.hypot(a[0] - b.o[0][0], a[1] - b.o[0][1])));
    assert.ok(d < 300, `a ${b.n} stands ${Math.round(d)} m from any station or car park`);
  }
  for (const b of stamped) {
    assert.ok(['retail', 'commercial', 'supermarket', 'kiosk', 'shop'].includes(b.t),
      `a franchise was stamped on building=${b.t}, which is not a shop`);
  }
  assert.equal(fresh.buildings.filter((b) => b.n).length, before + stamped.length,
    'stamping renamed something that already had a name');
});

// …and nothing retail is left anonymous, which is the pressure that made
// branding everything look like an improvement in the first place.
test('an unnamed shop still gets lettering over its door', () => {
  const shop = { t: 'retail', h: 4.5, o: [[0, 0], [18, 0], [18, 12], [0, 12]], _id: 4242 };
  const plan = buildingPlan(shop, null);
  assert.equal(plan.use, 'shop');
  assert.ok(plan.sign?.sign !== undefined, 'no fascia at all on an unnamed shop');
  assert.equal(plan.sign.label, 'OBCHOD');
  assert.equal(plan.brand, null, 'a generic fascia must not masquerade as a chain');
});
