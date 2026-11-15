// ---- the D11 bench: motorway traffic on the real tiles (round 8) -----------
// The survey that planned this work measured today's D11 headlessly
// (scratch harness survey9/traffic/d11.mjs): 2 cars per km per direction at
// noon, one line 2.1 m right of the centreline, cars at 150 to 172 km/h next
// to crawlers, lorries at 144. These tests drive a viewer down the real
// eastbound carriageway (tiles -12..-9 of both rows the motorway straddles,
// with the ecoduct patches and the paved widths geo.js gives the ways) and
// hold the corridor to what the D11 looks like: density that does not thin
// ahead of a fast player, lorries on their limiters in the right lane, cars
// overtaking in the left, nobody crawling, and two co-op clients agreeing
// on every motorway schedule and lane near them.

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

// the eastbound carriageway from Kostelní Lhota to Poděbrady, as one polyline
function eastbound(t, x0 = -54000, z0 = -9980, x1 = -45300) {
  let best = null, bd = Infinity;
  for (const e of t.edges) {
    if (e.mw !== 1 || e.fdx < 0.8) continue;
    const d = (e.mx - x0) ** 2 + (e.mz - z0) ** 2;
    if (d < bd) { bd = d; best = e; }
  }
  const path = [best.pts[0]];
  for (let e = best, n = 0; e && n < 5000 && path[path.length - 1][0] < x1; n++) {
    for (let i = 1; i < e.pts.length; i++) path.push(e.pts[i]);
    let nx = null, nd = -2;
    for (const o of e.b.out) { if (o.mw !== 1) continue; const d = e.ldx * o.fdx + e.ldz * o.fdz; if (d > nd) { nd = d; nx = o; } }
    e = nx;
  }
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  return {
    len: cum[cum.length - 1],
    at(s) {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const L = (cum[i] - cum[i - 1]) || 1, u = (s - cum[i - 1]) / L;
      const dx = (path[i][0] - path[i - 1][0]) / L, dz = (path[i][1] - path[i - 1][1]) / L;
      return { x: path[i - 1][0] + (path[i][0] - path[i - 1][0]) * u, z: path[i - 1][1] + (path[i][1] - path[i - 1][1]) * u, dx, dz };
    },
  };
}

// Drive a viewer at v m/s in the left lane for `secs`, sampling once a second.
function drive(c, v, secs, warm = 40) {
  const { t } = c;
  const road = eastbound(t);
  const S = { ahead: 0, behind: 0, n: 0, spd: [], heavy: [], heavyOff: [], carOff: [], slow: 0, mw: 0, over: 0 };
  for (let i = 0; i < (secs + warm) * 20; i++) {
    c.step(0.05);
    const s = 200 + v * Math.max(0, i / 20 - warm);
    if (s > road.len - 100) break;
    const a = road.at(s);
    const px = a.x + a.dz * 1.875, pz = a.z - a.dx * 1.875;     // the left lane
    t.setViewer({ x: px - a.dx * 6, z: pz - a.dz * 6, dirX: a.dx, dirZ: a.dz, fovRad: 68 * Math.PI / 180, aspect: 16 / 9, fogFar: 634 });
    t.update(0.05, { x: px, z: pz }, { x: px, z: pz, heading: Math.atan2(-a.dx, -a.dz), speed: v, _lat: 0 });
    if (i < warm * 20 || i % 20) continue;
    S.n++;
    // live motorway schedules (with a body or not) on this carriageway, by
    // where they are: what the corridor holds, whatever the attach rules show
    for (const p of t._pool.values()) {
      if (p.ndone || !p.route) continue;
      const st = p.route[p.ni];
      if (st.e.mw !== 1) continue;
      const ps = t._nomPose(p, c.now);
      if (ps.dx * a.dx + ps.dz * a.dz < 0.5) continue;
      const rx = ps.x - px, rz = ps.z - pz, f = rx * a.dx + rz * a.dz;
      if (Math.abs(a.dx * rz - a.dz * rx) > 30) continue;
      if (f > 0 && f < 500) S.ahead++; else if (f < 0 && f > -500) S.behind++;
    }
    for (const car of t.cars) {
      const p = car.ai;
      if (!p || p.edge.mw !== 1) continue;
      const kmh = car.speed * 3.6;
      S.mw++;
      if (kmh < 70) S.slow++;
      if (p.mwc === MW.CL_HEAVY) { S.heavy.push(kmh); if (p.eL === 1 && p.eT < c.now - 6) S.heavyOff.push(p.laneOff); }
      else if (p.mwc === MW.CL_CAR) { S.spd.push(kmh); if (p.eT < c.now - 6) S.carOff.push(p.laneOff); }
    }
  }
  return S;
}
const q = (a, f) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(f * (b.length - 1))]; };

let _noon = null;
const noon = () => (_noon ??= drive(client(192), 130 / 3.6, 150));

test('motorway pieces belong to every cell they cross, and the town cells hold no carriageway', () => {
  const { t } = client();
  let mwLen = 0, pieces = 0;
  for (const c of t._mwCells.values()) { mwLen += c.len; pieces += c.pieces.length; }
  let edgeLen = 0;
  for (const e of t.edges) if (e.mw === 1) edgeLen += e.len;
  assert.ok(Math.abs(mwLen - edgeLen) < 1, `pieces ${mwLen.toFixed(0)} m vs carriageway ${edgeLen.toFixed(0)} m`);
  assert.ok(pieces > edgeLen / 200, 'long edges are cut into pieces');
  for (const c of t._cells.values()) for (const e of c.edges) assert.notEqual(e.road.t, 'motorway');
});

// (one viewer at 130 km/h shares its speed with half the cars, so a gap in
// the traffic that happens to be behind it stays behind it for the whole
// run: one run's ahead and behind differ by chance more than at 160, where
// the viewer passes everything. The mean is what the corridor holds.)
test('at 130 km/h the corridor holds 8 to 12 vehicles a km a direction around the player', () => {
  const S = noon();
  const ahead = S.ahead / S.n / 0.5, behind = S.behind / S.n / 0.5;
  assert.ok((ahead + behind) / 2 >= 7.5 && (ahead + behind) / 2 <= 13, `ahead ${ahead.toFixed(1)}/km, behind ${behind.toFixed(1)}/km`);
  assert.ok(ahead >= 6 && behind >= 3.5, `ahead ${ahead.toFixed(1)}/km, behind ${behind.toFixed(1)}/km`);
});

test('…and at 160 km/h the road ahead does not thin out', () => {
  const S = drive(client(192), 160 / 3.6, 120);
  const ahead = S.ahead / S.n / 0.5, behind = S.behind / S.n / 0.5;
  assert.ok(ahead >= 7, `ahead ${ahead.toFixed(1)}/km`);
  assert.ok(ahead / behind > 0.7 && ahead / behind < 1.4, `ahead/behind ${(ahead / behind).toFixed(2)}`);
});

test('the 16:00 peak is denser than noon on the same corridor', () => {
  const S = drive(client(348), 130 / 3.6, 90);
  const ahead = S.ahead / S.n / 0.5;
  assert.ok(ahead >= 13, `peak ahead ${ahead.toFixed(1)}/km`);
});

test('speeds: cars 112 to 139 km/h with a few km/h of catch-up, lorries on their limiters, nobody crawling', () => {
  const S = noon();
  assert.ok(S.spd.length > 200 && S.heavy.length > 100, `${S.spd.length} car / ${S.heavy.length} lorry samples`);
  const c50 = q(S.spd, 0.5), c95 = q(S.spd, 0.95), cmax = q(S.spd, 1);
  assert.ok(c50 >= 105 && c50 <= 132, `car p50 ${c50.toFixed(0)}`);
  assert.ok(c95 <= 145 && cmax <= 152, `car p95 ${c95.toFixed(0)} max ${cmax.toFixed(0)}`);
  const h50 = q(S.heavy, 0.5), hmax = q(S.heavy, 1);
  assert.ok(h50 >= 78 && h50 <= 89, `lorry p50 ${h50.toFixed(0)}`);
  assert.ok(hmax <= 93, `lorry max ${hmax.toFixed(0)}`);
  assert.ok(S.slow / S.mw < 0.03, `${(100 * S.slow / S.mw).toFixed(1)} % of motorway samples under 70 km/h`);
});

test('lorries keep right, cars use both lanes, and lanes are the painted ones', () => {
  const S = noon();
  const lay = laneLayout({ t: 'motorway', w: 12.5, ln: 2, ow: 1, _paved: true });
  const right = lay.centers[1], left = lay.centers[0];
  assert.ok(S.heavyOff.length > 50);
  for (const o of S.heavyOff) assert.ok(Math.abs(o - right) < 0.05, `a lorry at ${o.toFixed(2)} m`);
  const inLeft = S.carOff.filter((o) => Math.abs(o - left) < 0.05).length;
  const inRight = S.carOff.filter((o) => Math.abs(o - right) < 0.05).length;
  assert.ok(inLeft > 0.08 * S.carOff.length, `${inLeft} of ${S.carOff.length} settled car samples in the left lane`);
  assert.ok(inRight > 0.3 * S.carOff.length, `${inRight} in the right lane`);
});

test('two cars side by side in the two lanes do not brake for each other', () => {
  const c = client();
  c.t.mwCrossN = 0;
  drive(c, 130 / 3.6, 60, 20);
  // (a crossing-rule hard brake between two motorway cars: lanes are not a junction)
  assert.ok((c.t.mwCrossN | 0) <= 3, `${c.t.mwCrossN} crossing-rule brakes on the carriageway`);
});

test('two clients, one watching and one not, agree on every motorway schedule and lane near them', () => {
  const A = client(), B = client();
  const road = eastbound(A.t);
  const P = road.at(3000), px = P.x, pz = P.z;
  for (let i = 0; i < 20 * 90; i++) {
    A.step(0.05); B.step(0.05);
    A.t.setViewer({ x: px, z: pz, dirX: P.dx, dirZ: P.dz, fogFar: 634 });
    A.t.update(0.05, { x: px, z: pz }, null);
    B.t.update(0.05, { x: px + 1, z: pz }, null);
  }
  const near = (t) => {
    const out = new Map();
    for (const p of t._pool.values()) {
      if (!p.cell?.mw || p.ndone) continue;
      t._nomTo(p, A.now);
      const ps = t._nomPose(p, A.now);
      if (Math.hypot(ps.x - px, ps.z - pz) > 400) continue;
      out.set(p.key, `${t._nomArc(p, A.now).toFixed(6)}|${p.kind}|${p.ln}|${p.lnF}|${p.lnT}`);
    }
    return out;
  };
  const a = near(A.t), b = near(B.t);
  assert.ok(a.size > 6, `${a.size} motorway schedules near the viewer`);
  let same = 0;
  for (const [k, v] of a) if (b.get(k) === v) same++;
  assert.ok(same >= a.size - 1, `${same} of ${a.size} agree (B holds ${b.size})`);
});

test('the desire tables: limits, classes and the motorway corner rule', () => {
  const v130 = 130 / 3.6;
  assert.ok(Math.abs(MW.mwDesire(MW.CL_CAR, MW.VK_MW_MIN, 0, v130, false) * 3.6 - 111.8) < 0.1);
  assert.ok(MW.mwDesire(MW.CL_CAR, MW.VK_MW_MIN + MW.VK_MW_VAR, 0, v130, false) * 3.6 < 139.2);
  assert.ok(MW.mwDesire(MW.CL_VAN, 1.07, 0, v130, false) * 3.6 <= 125.01);
  assert.ok(MW.mwDesire(MW.CL_HEAVY, 1.07, MW.heavyV(MW.CL_HEAVY, 1), v130, false) * 3.6 <= 89.01);
  // an entry slip signed 60 is driven to join 130 km/h traffic
  assert.ok(MW.mwDesire(MW.CL_CAR, 1, 0, 60 / 3.6, true) * 3.6 >= 79.9);
  // a 0.1 rad vertex between 300 m segments is no corner; the town rule made it 64 km/h
  assert.equal(MW.mwCornerV(0.05, 300), Infinity);
  assert.ok(MW.mwCornerV(0.1, 300) > 36);
  // a slip road's tight vertex still slows a car, as much as the town rule does
  assert.ok(Math.abs(MW.mwCornerV(0.5, 5) - Math.sqrt(31.5 / 0.5)) < 1e-9);
  // the kind mix: about 30 % heavy on the carriageway
  let heavy = 0;
  for (let i = 0; i < 1000; i++) if (MW.classOf(MW.mwKind((i + 0.5) / 1000)) === MW.CL_HEAVY) heavy++;
  assert.ok(heavy >= 280 && heavy <= 320, `${heavy} per mille heavy`);
});

test('roadworks: the same zone on every client, 60 km/h in it, the left lane closed, no standing queue', async () => {
  const { d11Locate, d11At } = await import('../js/d11.js');
  // a game day whose zone on the eastbound carriageway lies in this stretch
  // (km 34.2 to 36.1, between Kostelní Lhota and Poděbrady)
  const TZ = 17_913_720;
  const z = MW.zonesAt(TZ).find((q) => q.cw === 'E' && q.a > 32 && q.b < 37);
  assert.ok(z, 'the zone of that day');
  const c = client(192, TZ);
  // beside the zone's middle, 15 m off the carriageway on its right: from the
  // zone's own km, so a recalibration of the km (the signs package moved the
  // exit anchors to the nearest km) cannot walk the viewer off the zone
  const mid = d11At((z.a + z.b) / 2, 'E');
  const px = mid.x - mid.dz * 15, pz = mid.z + mid.dx * 15;
  const inZ = [], outZ = [];
  let left = 0, settled = 0;
  for (let i = 0; i < 20 * 150; i++) {
    c.step(0.05);
    c.t.update(0.05, { x: px, z: pz }, null);
    if (i < 20 * 40 || i % 10) continue;
    for (const car of c.t.cars) {
      const p = car.ai;
      if (!p || p.edge.mw !== 1 || p.ghost) continue;
      const L = d11Locate(car.x, car.z);
      if (!L) continue;
      const kmh = car.speed * 3.6;
      if (L.cw === 'W') { if (p.mwc === MW.CL_CAR) outZ.push(kmh); continue; }
      if (L.km > z.a + 0.1 && L.km < z.b) {
        inZ.push(kmh);
        if (p.eT < c.now - 6) { settled++; if (p.eL === 0) left++; }
      }
    }
  }
  assert.ok(inZ.length > 40, `${inZ.length} samples in the zone`);
  assert.ok(q(inZ, 0.95) <= 75, `zone p95 ${q(inZ, 0.95).toFixed(0)} km/h`);
  assert.ok(q(inZ, 0.5) >= 45, `zone p50 ${q(inZ, 0.5).toFixed(0)} km/h: a queue that stands`);
  // (the westbound carriageway beside it runs free)
  assert.ok(outZ.length === 0 || q(outZ, 0.5) > 80, `outside p50 ${q(outZ, 0.5)?.toFixed(0)}`);
  assert.ok(left <= 0.02 * settled, `${left} of ${settled} settled samples in the closed left lane`);
});

test('police: on a carriageway the pursuit ceiling follows the player up, never down', async () => {
  const { motorwayVmax, MW_COP_VMAX, TIERS } = await import('../js/policetune.js');
  const base = TIERS[2].vmax;
  assert.equal(motorwayVmax(base, 20), base);                       // a slow player: the tier's own
  assert.equal(motorwayVmax(base, 50), 54);                         // 180 km/h: a few m/s over it
  assert.equal(motorwayVmax(base, 90), MW_COP_VMAX);                // never a Gripen
});

// (review) a peer's steal of a motorway car reaches us as its slot key; the
// key must parse in claimSlot, or the tombstone is never laid and we mint
// and drive our own copy of the car he is driving
test('claimSlot lays a tombstone for a motorway slot we have not built yet', () => {
  const A = client(), B = client();
  const road = eastbound(A.t);
  const P = road.at(3000);
  for (let i = 0; i < 20 * 3; i++) { A.step(0.05); A.t.update(0.05, { x: P.x, z: P.z }, null); }
  const key = [...A.t._pool.values()].find((p) => p.cell?.mw && !p.ndone)?.key;
  assert.ok(key, 'a motorway schedule');
  B.t.claimSlot(key);
  const tomb = B.t._pool.get(key);
  assert.ok(tomb && tomb.stolen === 1, `tombstone for ${key}`);
  for (let i = 0; i < 20 * 3; i++) { B.step(0.05); B.t.update(0.05, { x: P.x, z: P.z }, null); }
  assert.strictEqual(B.t._pool.get(key).stolen, 1, 'the slot stays claimed, no copy minted');
});
