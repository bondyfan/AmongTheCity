// ---- city life: the day has a shape, and people do things in it ----------------
// Four small pure modules carry the crowd's behaviour, and each is pinned here
// by what it has to guarantee rather than by its numbers:
//
//   js/dayrhythm.js   how many people are out, by the shared hour
//   js/dwell.js       a walker's timeline: walk, stop, sit, wait, cross
//   js/roadrules.js   who gives way to whom
//   js/crowdsites.js  what stands beside a beat and what a beat crosses
//
// …and then the claim that matters, against js/pedestrians.js itself: nobody
// ever STANDS on a carriageway, the crowd thins at night, and two clients
// agree about who is sitting where.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const day = await import('../js/dayrhythm.js');
const { DW, buildTimeline, sampleTimeline, dwellSeconds } = await import('../js/dwell.js');
const rules = await import('../js/roadrules.js');
const sites = await import('../js/crowdsites.js');
const furniture = await import('../js/furniture.js');
const { Pedestrians } = await import('../js/pedestrians.js');

// ---------------------------------------------------------------- the day ----
test('the crowd curve never exceeds the slider and is nearly empty at three in the morning', () => {
  for (const we of [false, true]) {
    for (let h = 0; h <= 24; h += 0.25) {
      const k = day.crowdK(h, we), v = day.venueK(h, we);
      assert.ok(k > 0 && k <= 1, `crowdK(${h}) = ${k}`);
      assert.ok(v > 0 && v <= 1, `venueK(${h}) = ${v}`);
      assert.ok(day.placeCrowdK(h, we, 1) >= k - 1e-12, 'a pub may only ADD to its street');
      assert.ok(day.placeCrowdK(h, we, 1) <= 1);
    }
  }
  assert.ok(day.crowdK(3, false) < 0.06, 'somebody is still out at 03:00, but hardly anybody');
  assert.ok(day.crowdK(3, false) > 0, 'the odd night walker');
  assert.ok(day.crowdK(7.5, false) > 0.9 && day.crowdK(16.5, false) > 0.9, 'two rush hours');
  assert.ok(day.crowdK(12.5, false) > day.crowdK(10, false) + 0.2, 'a lunch bump');
  assert.ok(day.crowdK(12.5, false) > day.crowdK(14.2, false), '…that ends');
  assert.ok(day.venueK(21, false) > day.crowdK(21, false) + 0.4, 'the evening belongs to pubs and restaurants');
  assert.ok(day.crowdK(7.5, true) < 0.4, 'nobody commutes on a Saturday');
  assert.ok(day.crowdK(1.5, true) > day.crowdK(1.5, false), 'and the night runs later');
});

test('the crowd and the traffic tell the same story', () => {
  // main.js owns the traffic table and cannot be imported headless: read it
  const src = fs.readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
  const m = /const TRAFFIC_HOURS = \[([\s\S]*?)\];/.exec(src);
  assert.ok(m, 'TRAFFIC_HOURS moved: this test reads it from main.js');
  const tbl = [...m[1].matchAll(/\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)].map((q) => [+q[1], +q[2]]);
  const traffic = (h) => {
    for (let i = 0; i < tbl.length - 1; i++) {
      if (h >= tbl[i][0] && h <= tbl[i + 1][0]) return tbl[i][1] + (tbl[i + 1][1] - tbl[i][1]) * (h - tbl[i][0]) / (tbl[i + 1][0] - tbl[i][0]);
    }
    return 0;
  };
  const a = [], b = [];
  for (let h = 0; h < 24; h++) { a.push(day.crowdK(h + 0.5, false)); b.push(traffic(h + 0.5)); }
  const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length;
  const ma = mean(a), mb = mean(b);
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < 24; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
  const r = sab / Math.sqrt(saa * sbb);
  assert.ok(r > 0.85, `hour by hour the two curves correlate at ${r.toFixed(2)}`);
  assert.equal(a.indexOf(Math.min(...a)), b.indexOf(Math.min(...b)), 'both are quietest in the same hour');
});

test('the day of the week is a function of the shared clock', () => {
  const t = 17_900_000;
  assert.equal(day.weekdayAt(t), day.weekdayAt(t + 5), 'ten to midnight and five to are one day');
  assert.notEqual(day.weekdayAt(t), day.weekdayAt(t + 15), 'and five past is the next');
  const seen = new Set();
  for (let d = 0; d < 7; d++) seen.add(day.weekdayAt(t + d * 1440));
  assert.equal(seen.size, 7);
  assert.ok(Math.abs(day.hourAt(1440 * 5 + 90) - 12) < 1e-9, '10:30 at the epoch, so noon 90 s later');
});

// ----------------------------------------------------------- the timeline ----
const plan = (extra = {}) => ({
  t0: 1000, tEnd: 1420, span: 200, speed: 1.3, seed: 0x1234,
  stops: [{ arc: 60, kind: DW.BENCH, p: 1, min: 20, vr: 10, sid: 7 }],
  cross: [{ a0: 100, a1: 108, kerb: true }], ...extra,
});

test('a timeline is walked at walking pace, stops where it says, and never stands on the road', () => {
  const o = plan();
  const tl = buildTimeline(o);
  const out = {};
  let prev = null, sat = 0, kerbs = 0;
  for (let t = o.t0; t <= o.tEnd; t += 0.25) {
    const s = sampleTimeline(tl, t, out);
    assert.ok(s.arc >= 0 && s.arc <= o.span, `arc ${s.arc} left the beat`);
    if (prev !== null) assert.ok(Math.abs(s.arc - prev) <= o.speed * 0.25 + 1e-9, 'faster than their own pace');
    if (s.v === 0) {
      assert.ok(!(s.arc > 100 && s.arc < 108), `standing on the carriageway at arc ${s.arc}`);
      if (s.kind === DW.BENCH) { sat++; assert.ok(Math.abs(s.arc - 60) < 1e-9); }
      if (s.kind === DW.KERB) { kerbs++; assert.ok(s.arc < 100 || s.arc > 108); }
    }
    prev = s.arc;
  }
  assert.ok(sat > 60, 'they sat on the bench');
  assert.ok(kerbs > 4, 'and stopped at the kerb to look');
  // out and back: the kerb is the near side of the road in BOTH directions
  const ks = [];
  for (let i = 0; i < tl.n - 1; i++) if (tl.k[i] === DW.KERB) ks.push(tl.a[i]);
  assert.ok(ks.some((a) => a < 100) && ks.some((a) => a > 108), `kerb stops at ${ks.join(', ')}`);
});

test('a timeline is a pure function of its inputs, read the same from any cursor', () => {
  const a = buildTimeline(plan()), b = buildTimeline(plan());
  assert.deepEqual([...a.t], [...b.t]);
  assert.deepEqual([...a.a], [...b.a]);
  const o1 = {}, o2 = {};
  for (const t of [1400, 1001, 1250.5, 1100, 1419, 1003]) {
    b.i = 0;
    assert.deepEqual({ ...sampleTimeline(a, t, o1) }, { ...sampleTimeline(b, t, o2) }, `t = ${t}`);
  }
  const c = buildTimeline(plan({ seed: 0x9999 }));
  assert.notDeepEqual([...a.t], [...c.t], 'another walker, another day');
});

test('a walker waits for the lights, boards a bus that is due and steps off one that came', () => {
  const lights = buildTimeline(plan({ stops: [], waitAt: () => 11 }));
  assert.ok((dwellSeconds(lights)[DW.KERB] ?? 0) >= 11, 'the red was waited out at the kerb');
  const o = {};
  const board = buildTimeline(plan({ stops: [{ arc: 40, kind: DW.STOP, p: 0, min: 5, vr: 0, sid: 3 }],
    board: { stop: 0, until: (t) => t + 30 } }));
  assert.equal(sampleTimeline(board, 1000 + 40 / 1.3 + 10, o).kind, DW.STOP, 'waiting at the stop');
  assert.equal(sampleTimeline(board, 1000 + 40 / 1.3 + 31, o).kind, DW.GONE, 'and gone with the bus');
  assert.equal(sampleTimeline(board, 1419, o).kind, DW.GONE, 'for good');
  const alight = buildTimeline(plan({ stops: [], alight: { arc: 80, t: 1100 } }));
  assert.equal(sampleTimeline(alight, 1050, o).kind, DW.GONE, 'not here before the bus');
  const s = sampleTimeline(alight, 1101, o);
  assert.ok(s.kind === DW.WALK && Math.abs(s.arc - 80) < 2, 'steps off at the stop and walks');
});

test('a beat that begins on the road starts and turns on the pavement instead', () => {
  const tl = buildTimeline(plan({ lo: 12, stops: [], cross: [] }));
  const o = {};
  for (let t = 1000; t < 1420; t += 0.5) assert.ok(sampleTimeline(tl, t, o).arc >= 12 - 1e-9);
});

// -------------------------------------------------------------- the rules ----
test('nobody is told to walk while the cars they cross have a green', () => {
  const CYCLE = 25, CAR = 12.5;
  for (const bucket of [0, 1]) {
    for (let u = 0; u < CYCLE * 2; u += 0.1) {
      const w = rules.walkPhaseWait(u, bucket, 5, CYCLE, CAR);
      assert.ok(w >= 0 && w <= CYCLE, `wait ${w}`);
      let v = (u + w + (bucket ? CYCLE / 2 : 0)) % CYCLE;
      assert.ok(v >= CAR, `told to start at phase ${v.toFixed(1)}, inside the cars' green`);
      assert.ok(v + 5 <= CYCLE + 1e-9, 'and with time to finish');
    }
  }
});

test('a driver stops for somebody on the road, and for somebody waiting only if it is easy', () => {
  // 12 m/s, 30 m out: easy either way
  assert.ok(rules.yieldSpeed(30, 12, false, 5, 4.5, 15) >= 0);
  // 12 m/s, 10 m out: 7.2 m/s² needed. Too hard to do for somebody on the kerb…
  assert.equal(rules.yieldSpeed(10, 12, false, 5, 4.5, 15), -1);
  // …but done for somebody on the zebra
  assert.ok(rules.yieldSpeed(10, 12, true, 5, 4.5, 15) >= 0);
  assert.equal(rules.yieldSpeed(0.5, 3, true, 5, 4.5, 15), 0, 'at the line: stand');
  assert.equal(rules.yieldSpeed(-1, 3, true, 5, 4.5, 15), -1, 'already over it: not this function\'s call');
});

test('a give-way line is held for priority traffic and for nobody else', () => {
  assert.equal(rules.mayEnter(30, 0.95, 12, false, 8, 4), false, 'a car 2.5 s away has priority');
  assert.equal(rules.mayEnter(60, 0.95, 12, false, 8, 4), true, 'one 5 s away does not matter');
  assert.equal(rules.mayEnter(30, -0.9, 12, false, 8, 4), true, 'driving away');
  assert.equal(rules.mayEnter(30, 0.95, 0, true, 8, 4), true, 'itself waiting at its own line');
  assert.equal(rules.mayEnter(5, 0, 4, false, 8, 4), false, 'somebody is crossing the junction');
});

// -------------------------------------------------------------- the sites ----
test('a bench faces the way the mesh drew it', () => {
  const cell = { roads: [{ p: [[0, 0], [40, 0]] }, { p: [[10, -30], [10, 30]] }] };
  for (const [x, z] of [[20, 6], [3, -9], [12, 14], [200, 200]]) {
    assert.equal(sites.facingOf(cell, x, z), furniture._test.facingOf(cell, x, z),
      'js/crowdsites.js facingOf drifted from js/furniture.js: people would sit facing the hedge');
  }
});

test('the road index knows asphalt from pavement, and a bridge from a crossing', () => {
  const ix = new sites.RoadIndex();
  ix.add({ t: 'residential', w: 6, p: [[0, 0], [100, 0]] });
  ix.add({ t: 'primary', w: 8, br: 1, p: [[50, -40], [50, 40]] });
  assert.ok(ix.on(20, 2.5), 'inside the carriageway');
  assert.equal(ix.on(20, 3.5), null, 'on the pavement');
  assert.equal(ix.on(50, 20), null, 'under a bridge is not on a road');
  const all = ix.onAll(50, 1, 0, []);
  assert.equal(all.length, 1);
  assert.equal(ix.crossSeg(20, -10, 20, 10, 0, []).length, 1);
});

// ------------------------------------------------- the crowd, end to end ----
const HALF = 420, STEP = 60, T_NOON = 17_899_320;
function town() {
  const roads = [];
  let id = 0;
  const n = HALF / STEP;
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j < n; j++) {
      roads.push({ t: 'footway', d: 0, w: 2, _id: ++id, p: [[i * STEP, j * STEP], [i * STEP, j * STEP + STEP]] });
      roads.push({ t: 'footway', d: 0, w: 2, _id: ++id, p: [[j * STEP, i * STEP], [j * STEP + STEP, i * STEP]] });
    }
  }
  // two streets the pavements cross, mid-block
  roads.push({ t: 'residential', d: 1, w: 6, _id: ++id, p: [[30, -HALF], [30, HALF]] });
  roads.push({ t: 'residential', d: 1, w: 6, _id: ++id, p: [[-HALF, -90], [HALF, -90]] });
  // benches beside the pavements, in one chunk cell, with a way to face
  const furn = [];
  for (let i = -3; i <= 3; i++) furn.push({ p: [[i * STEP + 14, 3]], k: 'bench', _id: ++id });
  const cell = { roads: roads.filter((r) => !r.d), furniture: furn, crossings: [], venues: [] };
  return { roads, chunkIndex: new Map([['0,0', cell]]), pois: [], onTileLoaded() {} };
}
function crowd(t) {
  const peds = new Pedestrians({ add() {}, remove() {} }, town());
  let now = t;
  peds.clock = () => now;
  peds.max = 60;
  const run = (secs, pos = { x: 0, z: 0 }) => {
    for (let i = 0; i < secs * 20; i++) {
      now += 1 / 20;
      peds.setViewer({ x: pos.x, z: pos.z, dirX: 1, dirZ: 0, hideR: 0 });
      peds.update(1 / 20, pos);
    }
  };
  return { peds, run, at: (v) => { now = v; } };
}

test('nobody stands still on a carriageway, and everybody stops at its kerb first', () => {
  const c = crowd(T_NOON);
  c.run(8);
  let crossers = 0, checked = 0;
  for (const s of c.peds._pool.values()) {
    if (!s.cross.length) continue;
    crossers++;
    const o = {};
    for (let t = s.t0; t < s.t0 + 420; t += 0.5) {
      const a = sampleTimeline(s.tl, t, o);
      if (a.v !== 0 || a.kind === DW.GONE) continue;
      checked++;
      for (const x of s.cross) {
        assert.ok(!(a.arc > x.g0 + 0.3 && a.arc < x.g1 - 0.3),
          `slot ${s.key} stands at arc ${a.arc.toFixed(1)} inside the crossing ${x.g0.toFixed(1)}..${x.g1.toFixed(1)}`);
      }
    }
    assert.ok(s.lo === 0 || s.cross.every((x) => x.g0 > s.lo), 'the beat starts on the pavement');
    assert.ok(s.cross.every((x) => x.g1 < s.span), 'and turns round on it');
    assert.ok((dwellSeconds(s.tl)[DW.KERB] ?? 0) > 0 || s.tl.n < 4, `slot ${s.key} crosses and never looks`);
  }
  assert.ok(crossers > 20 && checked > 200, `only ${crossers} beats cross a street: the fixture is not testing this`);
});

test('people sit on the benches, facing the way the bench faces, and two clients agree who', () => {
  const a = crowd(T_NOON), b = crowd(T_NOON);
  a.run(60); b.run(20); b.run(40);
  let sitting = 0;
  for (const p of a.peds.peds) {
    if (p.pose !== 2) continue;
    sitting++;
    const s = p.sch, o = sampleTimeline(s.tl, a.peds.now(), {});
    const q = s.stops[o.ref].site;
    assert.ok(Math.hypot(p.x - q.x, p.z - q.z) < 0.6, 'seated ON the bench, not beside it');
    // citizen forward is (-sin h, -cos h); the bench faces (sin q.h, cos q.h)
    const want = Math.atan2(-Math.sin(q.h), -Math.cos(q.h));
    const d = Math.atan2(Math.sin(p.heading - want), Math.cos(p.heading - want));
    assert.ok(Math.abs(d) < 0.35, `facing ${p.heading.toFixed(2)}, the bench faces ${want.toFixed(2)}`);
    assert.ok(p.mesh.position.y < -0.05, 'lowered onto the seat');
  }
  assert.ok(sitting >= 1, 'seven benches beside busy pavements and nobody sat down');
  const sa = a.peds.snapshot(0, 0, 400), sb = b.peds.snapshot(0, 0, 400);
  assert.equal(sa.length, sb.length);
  for (let i = 0; i < sa.length; i++) {
    assert.equal(sa[i].key, sb[i].key);
    assert.equal(sa[i].doing, sb[i].doing, `${sa[i].key}: one client has them sitting, the other walking`);
    assert.ok(Math.abs(sa[i].arc - sb[i].arc) < 1e-6);
  }
  assert.ok(sa.some((r) => r.doing === DW.BENCH), 'the snapshot shows somebody on a bench');
});

test('the streets are nearly empty at 03:00 and full at half past noon, on the same slider', () => {
  const noon = crowd(T_NOON), night = crowd(T_NOON + (14.5 / 24) * 1440);
  noon.run(6); night.run(6);
  const nNoon = noon.peds._pool.size, nNight = night.peds._pool.size;
  assert.ok(nNoon > 40, `only ${nNoon} people at noon`);
  assert.ok(nNight >= 1, 'the odd night walker');
  assert.ok(nNight < nNoon * 0.12, `${nNight} people out at 03:00 against ${nNoon} at noon`);
  // the knob with the clock taken out of it, for anything that needs a fixed crowd
  const flat = crowd(T_NOON + (14.5 / 24) * 1440);
  flat.peds.rhythm = false;
  flat.run(6);
  assert.ok(flat.peds._pool.size > nNoon, 'rhythm = false ignores the hour');
});

test('a pair walks one timeline, shoulder to shoulder', () => {
  const c = crowd(T_NOON);
  c.run(8);
  let pairs = 0;
  for (const s of c.peds._pool.values()) {
    if (s.pair !== 2) continue;
    const lead = c.peds._pool.get(s.ci + ',' + s.cj + '/' + (s.k - 1));
    if (!lead) continue;
    pairs++;
    assert.equal(lead.pair, 1);
    assert.deepEqual([...lead.tl.t], [...s.tl.t], 'the two of a pair keep one timetable');
    assert.notEqual(lead.seed, s.seed, 'but they are two people');
    assert.equal(Math.sign(lead.lat), Math.sign(s.lat), 'on the same side of the pavement');
  }
  assert.ok(pairs >= 3, `only ${pairs} pairs in the fixture`);
});
