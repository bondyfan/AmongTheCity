// ---- the real lines: buses and trolleybuses on the routes of the map --------------
// js/realtransit.js runs the bus and trolleybus routes of public/data/routes on
// the traffic graph (js/realines.js lays a route onto directed edges), the
// trolleybuses wear their poles on the wire (js/trolleypoles.js), and the masts
// that carry the wire are things a car can knock down (js/trolleymasts.js).
// What has to hold, on the real Pardubice data:
//
//   nearly every metre of every line round the station is driven on the graph,
//     with the stops in their real order and on the right of the bus;
//   the timetable is a pure function of the route ids and the shared clock,
//     the same whichever order the files arrived in, and two clients who start
//     the same trip at different stops have it in the same place from the
//     first stop they share;
//   the derived lines retire where a real line calls;
//   a trolleybus shoe is on the wire meshes.js draws, the doors are per body;
//   a mast stands where the chunk stood it, and a felled one kills its wire.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./three-alias.mjs', import.meta.url));

const PUBLIC = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
globalThis.requestAnimationFrame ??= (cb) => { setImmediate(() => cb(0)); return 0; };
globalThis.fetch = async (url) => {
  try {
    const buf = await readFile(path.join(PUBLIC, String(url).replace(/^\//, '')));
    return { ok: true, status: 200, json: async () => JSON.parse(buf.toString('utf8')) };
  } catch { return { ok: false, status: 404 }; }
};
const readRoute = (u) => JSON.parse(readFileSync(path.join(PUBLIC, u), 'utf8'));

const { loadCity } = await import('../js/geo.js');
const { Traffic } = await import('../js/traffic.js');
const { Buses } = await import('../js/buses.js');
const R = await import('../js/realines.js');
const { RealLines } = await import('../js/realtransit.js');
const { routePath } = await import('../js/tiledata.js');
const { wirePoint, poleAim, TW_H, TW_GAP } = await import('../js/trolleypoles.js');
const { doorsOf, TRANSIT_BODY } = await import('../js/transitbody.js');
const { signText } = await import('../js/destsign.js');
const { TrolleyMasts, deadOn, DEAD_SPAN } = await import('../js/trolleymasts.js');
const { trolleyPlan } = await import('../js/meshes.js');
const { Poles } = await import('../js/poles.js');

const T0 = 17_899_320 + 1800;       // a weekday, one in the afternoon, on the shared clock
const mesh = () => ({ position: { set() {} }, rotation: { y: 0 }, userData: {}, add() {} });
function vehicles() {
  return { scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading) {
      const car = { mesh: mesh(), wheels: [], x, z, heading, speed: 0, steer: 0, kind,
        len: kind === 'bus' ? 11 : kind === 'trolleybus' ? 12.2 : 4.6, wid: 2.5, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car); return car;
    },
    remove(car) { this.cars.delete(car); } };
}

const city = await loadCity('data/manifest.json');
await city.ensureTiles(25, -122);
const traffic = new Traffic(city, vehicles());
let now = T0;
traffic.clock = () => now;
const FILES = city.routeFilesNear(25, -122, 1900);

function realLines(order = 1) {
  const rl = new RealLines(city, traffic);
  rl.clock = () => now;
  const files = order > 0 ? FILES : [...FILES].reverse();
  for (const u of files) rl.addFile(u, readRoute(u));
  rl._budget = 1e9;
  return rl;
}
const real = realLines();
for (const line of real.lines) { real._budget = 1; real._match(line); }

test('the real network is there: Pardubice trolleybuses and buses with their real numbers', () => {
  const town = real.lines.filter((l) => /MHD Pardubice/.test(l._route.nw ?? ''));
  const trolley = new Set(town.filter((l) => l.trolley).map((l) => l.ref));
  for (const ref of ['1', '2', '3', '4', '5', '7', '11', '12', '13', '17', '27', '30', '33']) assert.ok(trolley.has(ref), `trolleybus ${ref}`);
  const bus = new Set(town.filter((l) => !l.trolley).map((l) => l.ref));
  for (const ref of ['6', '8', '9', '10', '14', '15', '16', '18', '88']) assert.ok(bus.has(ref), `bus ${ref}`);
  // both directions where OSM has them, one where it has one (bus 15)
  assert.equal(town.filter((l) => l.ref === '5').length, 2);
  assert.equal(town.filter((l) => l.ref === '15').length, 1);
  const l3 = town.find((l) => l.ref === '3' && /Bohdaneč/.test(l.dest));
  assert.ok(l3 && l3.from === 'Hlavní nádraží', 'trolleybus 3 runs from the main station to Lázně Bohdaneč');
});

test('a route is laid onto the directed edges: nearly all of it, the calls in order, on the right', () => {
  const T = city.tile;
  const loaded = (x, z) => city.manifestTiles.find((t) => t.tx === Math.floor(x / T) && t.tz === Math.floor(z / T))?.state >= 2;
  let tot = 0, got = 0, rightAll = 0, nAll = 0;
  const at = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const line of real.lines) {
    if (!/MHD Pardubice/.test(line._route.nw ?? '')) continue;
    for (let a = 5; a < line.P.L; a += 10) {
      R.pathAt(line.P, a, at);
      if (!loaded(at.x, at.z)) continue;
      tot += 10;
      if (line.chains.some((c) => a >= c.a0 && a <= c.a1)) got += 10;
    }
    for (const c of line.chains) {
      for (let i = 1; i < c.steps.length; i++) {
        const p = c.steps[i - 1].e, q = c.steps[i].e;
        assert.ok(p.b === q.a || Math.hypot(p.b.x - q.a.x, p.b.z - q.a.z) < 1.7, `line ${line.ref}: a chain that jumps`);
      }
    }
    // a trip on the first chain: calls strictly ahead of each other, each on the right of the bus
    const c = line.chains[0];
    let i0 = 0;
    while (i0 < line.stops.length && line.stops[i0].d < c.a0 - 0.5) i0++;
    const i1 = real._lastOn(line, c, i0);
    if (i1 <= i0) continue;
    const trip = R.chainTrip(c, line.stops, i0, i1);
    assert.ok(trip, `line ${line.ref}: no trip on its own road`);
    for (let k = 1; k < trip.arcs.length; k++) assert.ok(trip.arcs[k] > trip.arcs[k - 1], `line ${line.ref}: calls out of order`);
    let right = 0, n = 0;
    for (let k = 0; k < trip.arcs.length; k++) {
      const s = line.stops[i0 + k];
      if (s.f & 8) continue;                        // the path never came near this one
      let st = trip.route[0];
      for (const r of trip.route) if (r.base <= trip.arcs[k]) st = r;
      const e = st.e, u = Math.min(e.len, Math.max(0, trip.arcs[k] - st.base));
      let j = 0;
      while (j < e.pts.length - 2 && e.cum[j + 1] < u) j++;
      const dx = e.pts[j + 1][0] - e.pts[j][0], dz = e.pts[j + 1][1] - e.pts[j][1];
      const side = (s.x - e.pts[j][0]) * -dz + (s.z - e.pts[j][1]) * dx;  // right of (dx, dz) is (-dz, dx)
      n++; if (side > 0) right++;
    }
    // (OSM has a few poles that serve both directions from one kerb: trolleybus
    // 7 calls at two of them on its way back to the station)
    if (n >= 4) assert.ok(right >= n - 2, `line ${line.ref}: only ${right} of ${n} stops on the right`);
    rightAll += right; nAll += n;
  }
  assert.ok(rightAll / nAll > 0.97, `${rightAll} of ${nAll} calls on the right of the bus`);
  assert.ok(got / tot > 0.98, `only ${(100 * got / tot).toFixed(1)} % of the network is on the graph`);
});

test('a bus pulls up with its nose at the post, not with the post through its bodywork', () => {
  const line = real.lines.find((l) => l.ref === '13' && l.whole);
  const c = line.chains[0], n = line.stops.length - 1;
  const at = R.chainTrip(c, line.stops, 0, n, 0), bus = R.chainTrip(c, line.stops, 0, n, TRANSIT_BODY.trolleybus.halt);
  let moved = 0;
  for (let k = 1; k < n - 1; k++) {
    // centre half the body and a hand short of the point abreast the post: the
    // nose is 0.7 m before it, the front door a step behind that
    // (route arcs count from where the trip starts rolling: add startS for metres along the chain)
    if (Math.abs(bus.arcs[k] + bus.startS - (at.arcs[k] + at.startS + TRANSIT_BODY.trolleybus.halt)) < 1e-6) moved++;
  }
  assert.ok(moved >= n - 4, `${moved} of ${n - 2} calls halted short of the post`);
  assert.ok(-TRANSIT_BODY.trolleybus.halt > 12.2 / 2 && -TRANSIT_BODY.bus.halt > 11 / 2);
});

test('the timetable is pure: the same lines and the same due times whatever order the files came in', () => {
  const a = realLines(1), b = realLines(-1);
  assert.deepEqual(a.lines.map((l) => l.id), b.lines.map((l) => l.id));
  const stops = city.pois.filter((p) => p.t === 'bus_stop' && Math.hypot(p.p[0] - 900, p.p[1] + 500) < 1500).slice(0, 60);
  let served = 0;
  for (const s of stops) {
    const ea = a.eta(s.p[0], s.p[1], T0), eb = b.eta(s.p[0], s.p[1], T0);
    assert.equal(ea, eb);
    if (ea < T0 + 1800) served++;
  }
  assert.ok(served > 20, `only ${served} of ${stops.length} stops have a bus within half an hour`);
});

test('two clients that start one trip at different stops have the bus in the same place from the first stop they share', () => {
  let same = 0, n = 0;
  for (const line of real.lines.filter((l) => l.whole && l.stops.length >= 12).slice(0, 12)) {
    const k = Math.floor(T0 / line.headway - line.phase);
    const A = real._spec(line, k, 0), B = real._spec(line, k, 4);
    real._live.clear();
    if (!A || !B) continue;
    A.key += ':a'; B.key += ':b';
    const ta = traffic.fixedTimes(A), tb = traffic.fixedTimes(B);
    // when each copy LEAVES call 6 and later: the hold makes it the timetable's second
    for (let i = 6; i < Math.min(A.stops.length, B.stops.length + 4); i++) {
      const la = Math.max(A.stops[i].hold, ta[i] + A.stops[i].dwell);
      const lb = Math.max(B.stops[i - 4].hold, tb[i - 4] + B.stops[i - 4].dwell);
      n++; if (Math.abs(la - lb) < 1e-6) same++;
    }
  }
  assert.ok(n > 50 && same / n > 0.9, `${same} of ${n} departures agree`);
});

test('real trips are on the road near the player, trolleybuses only on trolleybus routes', () => {
  // (the one traffic of the file: a second Traffic on the same city gets no graph)
  const tr = traffic;
  const buses = new Buses(city, tr);
  buses.clock = () => now;
  for (const u of FILES) buses.real.addFile(u, readRoute(u));
  for (let i = 0; i < 6; i++) { buses.real._t = 0; buses.update(1, { x: 25, z: -122 }); }
  const live = [...buses.real._live.values()];
  assert.ok(live.length > 15, `only ${live.length} trips`);
  for (const [key, p] of tr._pool) {
    if (!p.fixed?.tag?.real) continue;
    assert.equal(p.fixed.kind, p.fixed.tag.trolley ? 'trolleybus' : 'bus', key);
    assert.ok(p.stops.every((s) => typeof s.n === 'string'), 'every call carries its stop name');
  }
  assert.ok(live.some((l) => l.line.trolley) && live.some((l) => !l.line.trolley));
  // a real stop in reach of a derived one retires it: the station forecourt derives nothing
  buses._derive(0, -1);
  const derivedHere = buses.lines.filter((l) => l.stops.some((s) => Math.hypot(s.x - 25, s.z + 122) < 300));
  assert.equal(derivedHere.length, 0);
});

test('a trolleybus shoe is on the wire meshes.js draws, and the poles can reach it', () => {
  const road = city.roads.find((r) => r.tw && (r.w ?? 7) > 9 && r.p.length >= 2 && !r.br);
  const terrain = { heightAt: () => 221 };
  const o = { x: 0, y: 0, z: 0 };
  const [ax, az] = road.p[0], [bx, bz] = road.p[1];
  const L = Math.hypot(bx - ax, bz - az), px = -(bz - az) / L, pz = (bx - ax) / L, half = road.w / 2;
  // meshes.trolleyInto: the pairs at -half/2 and +half/2 across the STORED
  // direction, the two wires of a pair TW_GAP apart, TW_H up
  wirePoint(road, 0, 1, 1, terrain, o);
  assert.ok(Math.abs(o.x - (ax + px * (half / 2 + TW_GAP / 2))) < 1e-6 && Math.abs(o.z - (az + pz * (half / 2 + TW_GAP / 2))) < 1e-6);
  assert.equal(o.y, 221 + TW_H);
  wirePoint(road, 0, -1, -1, terrain, o);            // against the stored direction: the other pair
  assert.ok(Math.abs(o.x - (ax - px * (half / 2 - TW_GAP / 2))) < 1e-6);
  assert.equal(wirePoint({ ...road, tw: 0 }, 0, 1, 1, terrain, o), null, 'no wire, no shoe');
  // a pole from the roof of a 32Tr to a wire 5.5 m up and 5 m behind is in range
  const P = TRANSIT_BODY.trolleybus.poles, aim = {};
  poleAim(-0.3 + 1.2, TW_H, P.z + 5.5, -0.3, P.y, P.z, aim);
  assert.ok(aim.ok && aim.len > 5 && aim.len < 7);
  poleAim(-0.3, TW_H, P.z - 3, -0.3, P.y, P.z, aim);
  assert.ok(!aim.ok, 'a wire ahead of the hinge is out of reach');
});

test('the doors and the displays are per body', () => {
  assert.ok(doorsOf({ kind: 'trolleybus' }).mid > doorsOf({ kind: 'bus' }).mid);
  assert.equal(doorsOf({ kind: 'octavia' }), TRANSIT_BODY.bus.doors);
  assert.deepEqual(signText({ ref: '650606', dest: 'Holice' }), ['606', 'Holice']);
  assert.deepEqual(signText({ ref: '13', dest: ' Dubina, sever ' }), ['13', 'Dubina, sever']);
});

test('a trolley mast stands where the chunk planned it, goes over like a lamp, and kills its wire', () => {
  const key = [...city.chunkIndex.keys()].find((k) => trolleyPlan(city, k).length >= 3);
  const built = new Map([[key, {}]]);
  const poles = new Poles(null);
  const added = [];
  const scene = { add: (m) => added.push(m), remove: (m) => added.splice(added.indexOf(m), 1) };
  const world = { built, terrain: { heightAt: () => 221 }, walkY: () => 221.15, poles };
  const tm = new TrolleyMasts({ scene, city, world });
  const c = key.indexOf(','), x = (+key.slice(0, c) + 0.5) * 120, z = (+key.slice(c + 1) + 0.5) * 120;
  tm.update(1, { x, z });
  const rec = tm.cells.get(key), plan = trolleyPlan(city, key);
  assert.equal(rec.masts.length, plan.length);
  assert.equal(added.length, 1, 'one mesh for the cell');
  for (const m of plan) assert.equal(poles.near(m[0], m[1], 0.05).length, 1, 'each mast is a pole');
  // a car at 50 km/h into the first one
  const ms = rec.masts[0];
  assert.equal(poles.strike(ms.x, ms.z, 13.9, 0, 0.5), 1);
  assert.equal(poles.near(ms.x, ms.z, 0.05).length, 0);
  assert.ok(poles.isFelled(ms.x, ms.z));
  const pos = added[0].geometry.attributes.position.array;
  for (let v = ms.v0 + 1; v < ms.v1; v++) assert.equal(pos[v * 3 + 1], pos[ms.v0 * 3 + 1], 'its vertices are folded away');
  assert.ok(tm.deadAt(ms.f, ms.m[7]) && tm.deadAt(ms.f, ms.m[7] + DEAD_SPAN - 1));
  assert.ok(!tm.deadAt(ms.f, ms.m[7] + DEAD_SPAN + 1), 'and only the stretch it held');
  assert.ok(!deadOn(undefined, 0));
  // the cell leaves and comes back: the mast does not stand up again
  built.delete(key); tm.update(1, { x, z });
  assert.equal(added.length, 0);
  built.set(key, {}); tm.update(1, { x, z });
  assert.equal(tm.cells.get(key).masts.length, plan.length - 1);
  assert.equal(poles.near(ms.x, ms.z, 0.05).length, 0);
  // and the falling mast is its own shape, built about its foot
  assert.equal(poles.falling.length, 1);
  const g = poles.falling[0].mesh.geometry;
  g.computeBoundingBox();
  assert.ok(g.boundingBox.min.y > -0.01 && g.boundingBox.max.y > 5.5, 'from the pavement up past the wire');
});

test('a trolleybus drops its poles where the wire is dead and raises them beyond', async () => {
  const { TrolleyPoles } = await import('../js/trolleypoles.js');
  const road = city.roads.find((r) => r.tw && !r.br && Math.hypot(r.p[1][0] - r.p[0][0], r.p[1][1] - r.p[0][1]) > 45);
  let dead = false;
  const tp = new TrolleyPoles({ heightAt: () => 221 }, () => dead);
  const rig = { P: TRANSIT_BODY.trolleybus.poles, piv: [0, 1].map(() => ({ rotation: {}, scale: {} })), rest: 0.03,
    up: 1, reach: [5.5, 5.5], yaw: [0, 0], pitch: [0, 0], len: [6, 6], on: true };
  // a bus going the stored way of the road, 40 m in, pointing along it (heading: forward is (-sin h, -cos h))
  const [ax, az] = road.p[0], [bx, bz] = road.p[1];
  const L = Math.hypot(bx - ax, bz - az), dx = (bx - ax) / L, dz = (bz - az) / L;
  const s = 30;
  const e = { road, off0: 0, offSign: 1, len: L };
  const half = (road.w ?? 7) / 2, c = half > 4.5 ? half * 0.5 : 0;
  const car = { x: ax + dx * s - dz * c, z: az + dz * s + dx * c, heading: Math.atan2(-dx, -dz), mesh: { position: { y: 221 } } };
  const p = { route: [{ e, base: 0 }], sR: s, ri: 0 };
  tp.update(rig, car, p, 1 / 60);
  assert.ok(rig.on, 'on the wire');
  dead = true;
  tp.update(rig, car, p, 1 / 60);
  assert.ok(!rig.on, 'off a dead wire');
  dead = false;
  tp.update(rig, car, p, 1 / 60);
  assert.ok(rig.on, 'back on beyond it');
});
