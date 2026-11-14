// ---- trams: Prague's real tram routes as moving trams on their rails ----------------
// js/tramlines.js turns a route of public/data/routes into a timetable whose
// tram position is a pure function of the route record and the shared clock;
// js/trams.js runs the trips near the player; js/tramyield.js makes the city
// give way. What has to hold, on the real Prague data:
//
//   the 79 PID tram routes are there with their numbers and colours, on paths
//     without gaps, and their calls lie on the path in order;
//   the arc of a trip is pure: the same whichever order the files came in and
//     whichever call it was first seen at, never moving backwards, halting with
//     the nose at the stop and standing there for the dwell;
//   the bogies of a posed 15T stay on the rail and its joints stay shut through
//     the sharpest kink of the network;
//   about as many trams round the Old Town as the survey measured;
//   night lines only depart by night, day lines by day;
//   a car stops short of a crossing a tram is due at and does not creep onto it;
//   the realtransit hook hands trams out and keeps them out of the bus lines;
//   nothing on the tram paths uses Math.random.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

register(new URL('./three-alias.mjs', import.meta.url));

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const ROUTES = path.join(ROOT, 'public/data/routes');
const T = await import('../js/tramlines.js');
const { Trams } = await import('../js/trams.js');
const { TRAM_BODY, consistOf } = await import('../js/trambody.js');
const { RealLines } = await import('../js/realtransit.js');
const { Traffic } = await import('../js/traffic.js');
const { hourAt, isNightService } = await import('../js/dayrhythm.js');

const T0 = 17_899_320 + 1800;       // a weekday afternoon on the shared clock
const files = readdirSync(ROUTES).map((f) => ({ url: 'data/routes/' + f, file: JSON.parse(readFileSync(path.join(ROUTES, f), 'utf8')) }));
const prague = [];
for (const { file } of files) for (const r of file.routes) if (r.m === 2 && /Pražsk/.test(r.nw ?? '')) prague.push({ file, r });
const lines = prague.map(({ file, r }) => T.buildTramLine(file, r)).filter(Boolean);
const OLD_TOWN = { x: -95636, z: -6206 };

function fleet(order = 1, clock = () => T0) {
  const tr = new Trams({ clock });
  const list = order > 0 ? files : [...files].reverse();
  for (const { file } of list) for (const r of file.routes) tr.addRoute(file, r);
  return tr;
}
// (a fleet builds a few lines a scan: a dozen scans and every line near is in)
const warm = (tr, pos) => { for (let i = 0; i < 16; i++) { tr._t = 0; tr.update(0, pos, 0.5); } };

test('the 79 Prague tram routes, with their numbers and colours, on whole paths', () => {
  assert.equal(prague.length, 79);
  assert.equal(lines.length, 79);
  const refs = new Set(lines.map((l) => l.ref));
  for (const ref of ['1', '2', '3', '9', '17', '22', '23', '24', '26', '41', '42', '91', '99']) assert.ok(refs.has(ref), `line ${ref}`);
  assert.equal(lines.find((l) => l.ref === '22').color, '#f3987b');
  for (const { r } of prague) assert.ok(!r.p.includes(0), `line ${r.ref}: a gap in its path`);
});

test('calls lie on the path, in order', () => {
  let near = 0, n = 0;
  const at = { x: 0, z: 0, dx: 0, dz: 0 };
  for (const l of lines) {
    for (let i = 1; i < l.stops.length; i++) assert.ok(l.stops[i].d > l.stops[i - 1].d, `line ${l.ref}: calls out of order`);
    for (const s of l.stops) {
      if (s.f & 8 || s.k === 2) continue;           // off the path, or a platform alone (x, z is the platform)
      T.pathAtExt(l.P, s.d, at);
      n++;
      if (Math.hypot(at.x - s.x, at.z - s.z) < 1.0) near++;
    }
  }
  assert.ok(near / n >= 0.98, `${near} of ${n} stops within a metre of the path`);
});

test('the path spike of line 41 is filtered, and nothing on the network turns back on itself', () => {
  for (const l of lines) {
    const p = l.P.pts;
    for (let i = 1; i < l.P.n - 1; i++) {
      const ax = p[i * 2] - p[i * 2 - 2], az = p[i * 2 + 1] - p[i * 2 - 1];
      const bx = p[i * 2 + 2] - p[i * 2], bz = p[i * 2 + 3] - p[i * 2 + 1];
      const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
      const c = (ax * bx + az * bz) / (la * lb);
      assert.ok(!(c < -0.5 && Math.min(la, lb) < 3), `line ${l.ref}: a spike at (${p[i * 2]}, ${p[i * 2 + 1]})`);
    }
  }
});

test('the arc is pure, never goes back, halts nose at the stop and dwells', () => {
  const out = { s: 0, v: 0, i: 0, stop: false };
  for (const l of lines) {
    let prev = -1, standT = 0, standI = -1, dwelled = 0;
    for (let t = 0; t <= l.dur; t += 0.25) {
      const a = T.arcAt(l, t, out);
      assert.ok(a, `line ${l.ref}: off the rail at ${t} s`);
      assert.ok(a.s >= prev - 1e-6, `line ${l.ref}: backwards at ${t} s`);
      assert.ok(a.v <= T.VMAX + 1e-6, `line ${l.ref}: faster than 50 km/h`);
      prev = a.s;
      if (a.stop) {
        if (standI !== a.i) { standI = a.i; standT = 0; }
        standT += 0.25;
        assert.ok(Math.abs(a.s - l.stops[a.i].d) < 0.5, `line ${l.ref}: stands ${a.s - l.stops[a.i].d} m off call ${a.i}`);
        if (a.i > 0 && a.i < l.stops.length - 1 && standT >= T.DWELL - 0.25) dwelled++;
      }
    }
    assert.ok(dwelled >= l.stops.length - 3, `line ${l.ref}: dwelled at ${dwelled} of ${l.stops.length} calls`);
    assert.equal(T.arcAt(l, l.dur + 1, out), null);
    assert.equal(T.arcAt(l, -1, out), null);
  }
  // the same arcs from two fleets that read the files in opposite order
  const a = fleet(1), b = fleet(-1);
  warm(a, OLD_TOWN); warm(b, OLD_TOWN);
  assert.ok(a.live.size > 10);
  assert.equal(a.live.size, b.live.size);
  for (const [k, t] of a.live) assert.equal(b.live.get(k)?.s, t.s, k);
});

test('a trip is in the same place whichever call it was first seen at', () => {
  let now = T0;
  const near = fleet(1, () => now), far = fleet(1, () => now);
  // one fleet watches from the Old Town all along, the other comes from Smíchov
  warm(near, OLD_TOWN);
  warm(far, { x: -97200, z: -4600 });
  for (let i = 0; i < 240; i++) { now += 0.5; near.update(0.5, OLD_TOWN, 0.5); far.update(0.5, { x: -97200 + i * 6, z: -4600 - i * 6.5 }, 0.5); }
  let shared = 0;
  for (const [k, t] of far.live) { const o = near.live.get(k); if (o) { shared++; assert.equal(o.s, t.s, k); } }
  assert.ok(shared > 3, `only ${shared} trams in common`);
});

test('a 15T keeps its bogies on the rail and its joints shut through the 33 degree kink', () => {
  const l = lines.find((q) => /^(6|15|26)$/.test(q.ref) && Math.min(...Array.from({ length: q.P.n }, (_, i) => Math.hypot(q.P.pts[i * 2] + 94855, q.P.pts[i * 2 + 1] + 6437))) < 3);
  assert.ok(l, 'a line through the kink at (-94855, -6437)');
  let a0 = 0, best = Infinity;
  for (let i = 0; i < l.P.n; i++) { const d = Math.hypot(l.P.pts[i * 2] + 94855, l.P.pts[i * 2 + 1] + 6437); if (d < best) { best = d; a0 = l.P.cum[i]; } }
  const B = TRAM_BODY['15T'], at = { x: 0, z: 0, dx: 0, dz: 0 }, q = { d: 0, a: 0 };
  // (a brute-force projection, independent of the code under test)
  const projectOnPath = (P, x, z, lo, hi, o) => {
    let bd = Infinity;
    for (let a = lo; a <= hi; a += 0.05) { T.pathAtExt(P, a, at); const d = Math.hypot(at.x - x, at.z - z); if (d < bd) { bd = d; o.a = a; } }
    o.d = bd; return o;
  };
  for (let s = a0 - 5; s < a0 + B.len + 5; s += 0.5) {
    const bog = B.bogies.map((o) => { T.pathAtExt(l.P, s - o, at); return [at.x, at.z]; });
    // every bogie is a point of the path
    for (let k = 0; k < bog.length; k++) {
      projectOnPath(l.P, bog[k][0], bog[k][1], s - B.bogies[k] - 1, s - B.bogies[k] + 1, q);
      assert.ok(q.d < 0.05, `bogie ${k} ${q.d.toFixed(3)} m off the rail`);
    }
    // a Jacobs bogie is the back of one section and the front of the next: the
    // joint is the same point for both, whatever the angle
    for (let k = 0; k < B.sections.length - 1; k++) {
      assert.equal(B.sections[k].b1, B.sections[k + 1].b0, 'sections share their joint bogie');
    }
  }
  assert.ok(consistOf(T.KIND_15T).length === 1 && consistOf(T.KIND_T3_PAIR).length === 2);
});

test('about as many trams round the Old Town as the timetable predicts', () => {
  const counts = [];
  let now = T0;
  const tr = fleet(1, () => now);
  for (let i = 0; i < 40; i++) {
    now += 90;
    tr.update(0.5, OLD_TOWN, 0.5);
    let n = 0;
    for (const t of tr.list) if ((t.x - OLD_TOWN.x) ** 2 + (t.z - OLD_TOWN.z) ** 2 < 1000 * 1000) n++;
    counts.push(n);
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  assert.ok(mean >= 12 && mean <= 35, `mean ${mean.toFixed(1)} trams within 1 km of the Old Town Square`);
  for (const c of counts) assert.ok(c < 45, `${c} trams within a kilometre at once`);
});

test('night lines depart by night only, day lines thin out after dark', () => {
  const night = lines.filter((l) => l.night), day = lines.filter((l) => !l.night && l.headway === T.DAY_H);
  assert.ok(night.length >= 9 && day.length >= 40);
  for (const l of night) {
    for (let k = 180000; k < 180400; k++) {
      if (T.tripRuns(l, k)) assert.ok(isNightService(hourAt(T.departOf(l, k))), `night line ${l.ref} departs by day`);
    }
  }
  let dayRuns = 0, nightRuns = 0, dayAll = 0, nightAll = 0;
  for (const l of day) for (let k = 45000; k < 45200; k++) {
    const n = isNightService(hourAt(T.departOf(l, k)));
    if (n) { nightAll++; if (T.tripRuns(l, k)) nightRuns++; } else { dayAll++; if (T.tripRuns(l, k)) dayRuns++; }
  }
  assert.equal(dayRuns, dayAll);
  assert.ok(nightRuns > 0 && nightRuns < nightAll * 0.6);
});

test('a car stops short of a crossing a tram is due at, and does not creep onto it', () => {
  const mesh = () => ({ position: { set() {} }, rotation: { y: 0 }, userData: {}, add() {} });
  const veh = { scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading) { const car = { mesh: mesh(), wheels: [], x, z, heading, speed: 0, steer: 0, kind, len: 4.6, wid: 1.8, ai: null, y: 0, _rammedT: 0 }; this.cars.add(car); return car; },
    remove(car) { this.cars.delete(car); } };
  const roads = [];
  for (let x = -1200; x < 1200; x += 200) roads.push({ t: 'primary', d: 1, w: 9, v: 50, p: [[x, 0], [x + 200, 0]] });
  for (let x = -1200; x <= 1200; x += 200) roads.push({ t: 'residential', d: 1, w: 6, v: 50, p: [[x, -300], [x, 0], [x, 300]] });
  const traffic = new Traffic({ roads, pois: [], signals: [], onTileLoaded() {} }, veh);
  let now = 17_899_320;
  traffic.clock = () => now;
  traffic.maxCars = 400;
  // a rail across the main street at x = 100, a tram due there all along
  traffic.railCross = [{ cx: 100, cz: 0, rdx: 1, rdz: 0, hw: 4.5, clr: 1.7, must: true, x: 100, z: 0, body: false, stale: false, rail: true }];
  const pos = { x: 100, z: 30 };
  const east = (c) => Math.abs(c.z - 2.1) < 1.2 && -Math.sin(c.heading) > 0.9;
  let arrived = 0, queued = 0;
  const came = new Set();           // cars seen approaching (one spawned past the rail is not one that drove onto it)
  for (let i = 1; i <= 240 * 20; i++) {
    now += 1 / 20;
    traffic.update(1 / 20, pos, null);
    let q = 0;
    for (const c of traffic.cars) {
      if (!east(c)) continue;
      if (c.x < 100 && c.x > 40) { arrived++; came.add(c); }
      if (came.has(c)) assert.ok(!(c.x + c.len / 2 > 100 - 1.6 && c.x - c.len / 2 < 100 + 1.6), `a car drove onto the rail (x = ${c.x.toFixed(1)}, t = ${(i / 20).toFixed(1)} s)`);
      if (c.x < 100 && c.x > 20 && c.speed < 0.5) q++;
    }
    if (q > queued) queued = q;
  }
  assert.ok(arrived > 0, 'no car ever came: the fixture is not testing this');
  assert.ok(queued >= 1, 'nobody waited');
  // the tram has gone: the road flows again
  traffic.railCross.length = 0;
  let passed = 0;
  for (let i = 1; i <= 40 * 20; i++) {
    now += 1 / 20;
    traffic.update(1 / 20, pos, null);
    for (const c of traffic.cars) if (east(c) && c.x > 104 && c.x < 140 && c.speed > 3) passed++;
  }
  assert.ok(passed > 0, 'nobody moved after the tram passed');
});

// Found in review: a car that had stopped across the rail for the tram's hull
// (a blocker in front of it) also held the tram, which then stood still with
// its hull in front of the car: both waited for good. The tram now pins such a
// car and leaves its hull points round it out of the blockers, so it drives off.
test('a car standing against a tram nose is let off the rail, not waited for by both', async () => {
  const { TramYield } = await import('../js/tramyield.js');
  const { indexPath } = await import('../js/realines.js');
  const P = indexPath([0, 0, 400, 0]);
  const car = { x: 202, z: 0.6, heading: 0, speed: 0, len: 4.6 };
  const traffic = { cars: [car], actors: null };
  const y = new TramYield(traffic);
  const tr = { key: 'tram:1:1', line: { P }, sr: 200, s: 230, len: 31.4, v: 0, stop: false, hidden: false, far: false,
    x: 200, z: 0, hx: 1, hz: 0, hold: Infinity, pin: null };
  const trams = { list: [tr] };
  y.update(trams, 0.05, { x: 200, z: 20 });
  assert.ok(tr.hold <= tr.sr + 1e-9, 'the tram does not drive into the car');
  assert.strictEqual(tr.pin, car, 'the standing car against the nose is pinned');
  const hulls = [];
  y.blockInto(trams, hulls);
  assert.ok(hulls.length > 0, 'the rest of the tram is still a hull');
  for (const h of hulls) assert.ok(Math.hypot(h.x - car.x, h.z - car.z) > 3 + 2.3, `a hull point ${Math.hypot(h.x - car.x, h.z - car.z).toFixed(1)} m from the pinned car`);
  // pulling away it stays pinned; once off the rail the hull is whole again
  car.speed = 3;
  y.update(trams, 0.05, { x: 200, z: 20 });
  assert.strictEqual(tr.pin, car);
  car.z = 6;
  y.update(trams, 0.05, { x: 200, z: 20 });
  assert.equal(tr.pin, null);
  assert.equal(tr.hold, Infinity);
  // a car further up the rail is waited for and is not pinned
  car.z = 0.5; car.x = 215; car.speed = 0;
  y.update(trams, 0.05, { x: 200, z: 20 });
  assert.ok(tr.hold > tr.sr + 5 && tr.hold < 215, `hold ${tr.hold}`);
  assert.equal(tr.pin, null);
});

test('realtransit hands the tram routes out and keeps them out of the bus lines', () => {
  const city = { routeFilesNear: () => null, onTileLoaded() {} };
  const rl = new RealLines(city, { _egrid: { m: new Map() } });
  const got = [];
  rl.onTramRoute = (file, r) => got.push(r.id);
  for (const { url, file } of files) rl.addFile(url, file);
  assert.ok(got.length >= 79, `${got.length} tram routes handed out`);
  assert.ok(rl.lines.every((l) => l.mode !== 2), 'a tram among the bus lines');
});

test('no Math.random on the tram paths', () => {
  for (const f of readdirSync(path.join(ROOT, 'js'))) {
    if (!/^tram.*\.js$/.test(f)) continue;
    // (code only: the comments say what is not used)
    const src = readFileSync(path.join(ROOT, 'js', f), 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/Math\.random/.test(src), `${f} uses Math.random`);
    assert.ok(!/Date\.now|performance\.now\(\)\s*[-+*/]/.test(src.replace(/this\.ms = performance\.now\(\) - t0/, '')), `${f} reads the wall clock into its state`);
  }
});
