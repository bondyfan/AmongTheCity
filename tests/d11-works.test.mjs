// ---- the D11 roadworks and patrols (round 8 integration fixes) ----------------
// The roadworks closure must hold wherever a day puts its zone (the km
// recalibration of the SIGNS package walked one zone onto a stretch where
// 6 % of the bodies drove the closed lane: two causes, a free-flow lane-change
// gap no 60 km/h queue ever opens, and the stuck-behind-a-lorry pull-out that
// took cars INTO the closed lane); the carriageways must carry patrols again
// (they left the town cells, and the patrol slot with them); and what the
// traffic obeys must be drawn: cones in the closed lane, boards before it.
// Same harness as tests/d11-traffic.test.mjs: the real tiles -13..-9.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register(new URL('./three-alias.mjs', import.meta.url));
const { Traffic } = await import('../js/traffic.js');
const { withRoadPatches } = await import('../js/roadpatches.js');
const { laneLayout } = await import('../js/lanes.js');
const MW = await import('../js/mwtraffic.js');

// geo.js pave(): what a motorway or a slip road's w becomes in the game
const PAVE = { motorway: 1.5, motorway_link: 1.0, trunk: 1.5, trunk_link: 1.0, primary: 1.5, primary_link: 1.0,
  secondary: 2, secondary_link: 1, tertiary: 2, tertiary_link: 1, unclassified: 2.5, residential: 2.5,
  living_street: 1.5, service: 1.2, track: 0.5 };
const TILES = [];
for (let tx = -13; tx <= -9; tx++) TILES.push([tx, -3], [tx, -2]);
function roads() {
  const out = [];
  for (const [tx, tz] of TILES) {
    const j = JSON.parse(readFileSync(new URL(`../public/data/tiles/${tx}_${tz}.json`, import.meta.url), 'utf8'));
    withRoadPatches(j.roads, tx, tz, 1 << 20);
    for (const r of j.roads) {
      if (r.d !== 1) continue;
      if (r.w > 0 && PAVE[r.t]) { r.w = +(r.w + PAVE[r.t]).toFixed(2); r._paved = true; }
      out.push(r);
    }
  }
  return out;
}
const DIMS = { bus: [11, 2.5], semi: [16.5, 2.55], truck: [7.6, 2.3], van: [4.8, 1.9] };
function stubVehicles() {
  return {
    scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading, color) {
      const [len, wid] = DIMS[kind] ?? [4.6, 1.8];
      const car = { mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} },
        wheels: [], x, z, heading, speed: 0, steer: 0, kind, color, len, wid, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car);
      return car;
    },
    remove(car) { this.cars.delete(car); },
  };
}
const T0 = 17_899_320;            // a noon-ish world epoch far from zero
function client(maxCars = 192, t0 = T0) {
  const log = console.log; console.log = () => {};
  const t = new Traffic({ roads: roads(), signals: [], onTileLoaded() {} }, stubVehicles());
  console.log = log;
  let now = t0;
  t.clock = () => now;
  t.maxCars = maxCars;
  return { t, step(dt) { now += dt; }, get now() { return now; } };
}

const { d11Locate, d11At } = await import('../js/d11.js');
const W = await import('../js/mwworks.js');

// Zones of three game days that fall on the loaded stretch, among the worst
// before the fix (17 %, 9.6 % and 9.3 % of settled bodies in the closed lane)
const DAYS = [[17_326_170, 'E', 31.51], [17_317_530, 'W', 24.38], [17_306_010, 'E', 42.78]];

test('roadworks: the left lane stays closed wherever the zone falls, and is empty before the cones', () => {
  for (const [TZ, cw, a] of DAYS) {
    const z = MW.zonesAt(TZ).find((q) => q.cw === cw && Math.abs(q.a - a) < 0.01);
    assert.ok(z, `the zone of day ${TZ}`);
    const c = client(192, TZ);
    // the viewer beside the closure's start: the taper, the trailer and the merge
    const P = d11At(cw === 'E' ? z.a : z.b, cw);
    const px = P.x - P.dz * 15, pz = P.z + P.dx * 15;
    let left = 0, settled = 0, inTaper = 0, nTaper = 0;
    for (let i = 0; i < 20 * 110; i++) {
      c.step(0.05);
      c.t.update(0.05, { x: px, z: pz }, null);
      if (i < 20 * 40 || i % 10) continue;
      for (const car of c.t.cars) {
        const p = car.ai;
        if (!p || p.edge.mw !== 1 || p.ghost) continue;
        const L = d11Locate(car.x, car.z);
        if (!L || L.cw !== cw) continue;
        const rel = cw === 'E' ? L.km - z.a : z.b - L.km;          // km past the zone's start
        // from the trailer on: no body left in the closed lane (its offset)
        if (rel > -MW.TAPER_AT + 0.03 && rel < 0.3) { nTaper++; if (L.off < -0.9) inTaper++; }
        if (rel > 0.1 && rel < z.b - z.a && p.eT < c.now - 6) { settled++; if (p.eL === 0) left++; }
      }
    }
    assert.ok(nTaper > 100 && settled > 100, `${nTaper} / ${settled} samples`);
    assert.ok(inTaper <= 0.005 * nTaper, `${cw} ${z.a.toFixed(2)}: ${inTaper} of ${nTaper} bodies in the closed lane past the trailer`);
    assert.ok(left <= 0.01 * settled, `${cw} ${z.a.toFixed(2)}: ${left} of ${settled} settled samples in the closed left lane`);
  }
});

test('patrols drive the carriageways again: their own way, at motorway speed, the same on two clients', () => {
  const A = client(), B = client();
  A.t.patrolP = B.t.patrolP = 0.7;           // main.js's default police setting
  const seen = new Set(), spd = [];
  let wrong = 0;
  for (let i = 0; i < 20 * 400; i++) {
    A.step(0.05); B.step(0.05);
    const km = 23 + (36 * i / 20) / 1000;     // a viewer at 130 km/h down the eastbound carriageway
    const P = d11At(km, 'E');
    A.t.update(0.05, { x: P.x, z: P.z }, null);
    B.t.update(0.05, { x: P.x + 2, z: P.z }, null);
    if (i % 20) continue;
    for (const p of A.t._pool.values()) if (p.police === 2) seen.add(p.key);
    for (const car of A.t.cars) {
      const p = car.ai;
      if (!p || p.police !== 2 || p.edge?.mw !== 1 || p.ghost) continue;
      spd.push(car.speed * 3.6);
      const L = d11Locate(car.x, car.z);
      if (L && L.dx * -Math.sin(car.heading) + L.dz * -Math.cos(car.heading) < 0) wrong++;
    }
  }
  assert.ok(seen.size >= 3, `${seen.size} motorway patrols minted along 14 km`);
  assert.ok(spd.length > 30, `${spd.length} patrol samples on a carriageway`);
  spd.sort((x, y) => x - y);
  assert.ok(spd[Math.floor(spd.length / 2)] > 100, `patrol p50 ${spd[Math.floor(spd.length / 2)].toFixed(0)} km/h`);
  assert.equal(wrong, 0, 'no patrol against the traffic');
  // the other client holds the same patrols (same keys, same nominal place)
  let same = 0, both = 0;
  for (const k of seen) {
    const a = A.t._pool.get(k), b = B.t._pool.get(k);
    if (!a || !b || a.ndone) continue;
    both++;
    A.t._nomTo(a, A.now); B.t._nomTo(b, A.now);
    if (Math.abs(A.t._nomArc(a, A.now) - B.t._nomArc(b, A.now)) < 1e-6 && b.police === 2) same++;
  }
  assert.ok(both > 0 && same === both, `${same} of ${both} patrols agree`);
  // the police setting at zero empties the motorway of them too
  const C = client(); C.t.patrolP = 0;
  for (let i = 0; i < 20 * 20; i++) { C.step(0.05); const P = d11At(30, 'E'); C.t.update(0.05, { x: P.x, z: P.z }, null); }
  assert.equal([...C.t._pool.values()].filter((p) => p.police === 2).length, 0);
});

test('the works plan: cones in the closed lane from the trailer to the end, boards before it, all from the zone', () => {
  for (const z of MW.zonesAt(17_913_720)) {
    const p = W.worksPlan(z), len = (z.b - z.a) * 1000;
    assert.strictEqual(W.worksPlan(z), p, 'memoised per zone record');
    assert.ok(p.trailer && p.trailer.d < -MW.TAPER_AT * 1000 && p.trailer.d > -MW.CLOSE_FORCE * 1000,
      'the trailer stands after the forced merge point, before the taper');
    assert.ok(p.cones.length > len / W.CONE_STEP, `${p.cones.length} cones over ${len.toFixed(0)} m`);
    for (const c of p.cones) {
      assert.ok(c.off <= W.CONE_LINE + 1e-9 && c.off >= W.CONE_EDGE - 1e-9, 'every cone inside the closed lane');
      assert.ok(c.d >= -MW.TAPER_AT * 1000 - 1e-6 && c.d <= len + 1e-6, 'and within the closure');
      const L = d11Locate(c.x, c.z);
      assert.ok(L && L.cw === z.cw && Math.abs(L.off - c.off) < 0.05, `cone on ${z.cw} at ${c.off}`);
    }
    for (const face of ['closure', 'works80', 'works60']) {
      const s = p.signs.filter((q) => q.face === face);
      assert.ok(s.length >= 1, `${face} board`);
      for (const q of s) assert.ok(q.d <= 0, `${face} before the zone`);
    }
  }
  // two clients plan the same: the plan is a function of the zone table alone
  const a = W.worksPlan({ ...MW.zonesAt(17_913_720)[0] }), b = W.worksPlan({ ...MW.zonesAt(17_913_720)[0] });
  assert.deepStrictEqual(a, b);
});
