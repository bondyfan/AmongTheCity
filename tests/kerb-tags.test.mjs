// ---- kerb parking as the map tags it ---------------------------------------------
// A road may carry `pk: [left, right]` (docs/TILE-FORMAT.md). js/kerbrows.js
// turns that into rows of parked cars and js/kerbparking.js stands the cars in
// them. Pinned here:
//
//   1. a street with no `pk` parks exactly as it did before the tags existed
//   2. a no parking or no stopping side has no cars, whatever the hash wanted
//   3. an allowed side has them, on THAT side, in the mapped orientation, on
//      streets the procedural rule would never have picked as well
//   4. how far up the kerb: never further into the road than the traffic
//      leaves free, and each wheel stands on the verge or on the road
//   5. the same stalls whoever asks, and nothing hung on the map feature

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const { indexJunctions, polylineLength, setStreetCity, JUNCTIONS, CLUSTERS } = await import('../js/geo.js');
const { indexBays, KERB_H } = await import('../js/streets.js');
const { kerbStalls, kerbSideOf, secondKerbOf, parkable, KerbParking, KERB_INTRUDES } = await import('../js/kerbparking.js');
const { CycleNet } = await import('../js/cyclenet.js');
const { kerbRows, rowPlace, kerbPose, procSide, PARALLEL, DIAGONAL, PERPENDICULAR } = await import('../js/kerbrows.js');
const { parkCode, PARK_NO, PARK_NO_PARKING, PARK_NO_STOPPING, PARK_SEPARATE } = await import('../js/tiledata.js');
const { TRAFFIC } = await import('../js/config.js');

const square = (x0, z0, s) => [[x0, z0], [x0 + s, z0], [x0 + s, z0 + s], [x0, z0 + s]];
const LANE = 1, HALF = 3, ON = 4;

/**
 * A 230 m street running east at z = 60 with houses both sides (9 m back from
 * the kerb unless `houseGap` says otherwise; `terrace` joins those on the south
 * side into one unbroken front), a side street, a zebra and a bus stop. `over` is merged into the main street: its tags, class, width.
 */
function town(over = {}, { houseGap = 10.25, footway = 0, terrace = false } = {}) {
  JUNCTIONS.clear(); CLUSTERS.clear();
  let id = 0;
  const tag = (f) => { f._id = ++id; return f; };
  const main = tag({ t: 'residential', w: 5.5, d: 1, p: [[5, 60], [120, 60], [235, 60]], ...over });
  const side = tag({ t: 'residential', w: 5.5, d: 1, p: [[120, 60], [120, 118]] });
  const roads = [main, side];
  // a mapped footway `footway` metres south of the southern kerb, the length of the street
  if (footway) roads.push(tag({ t: 'footway', w: 1.8, d: 0, p: [[5, 60 + main.w / 2 + footway], [112, 60 + main.w / 2 + footway]] }));
  for (const r of roads) r._len = polylineLength(r.p);
  const hw = main.w / 2;
  const mk = () => ({ buildings: [], roads: [], rails: [], trees: [], water: [], green: [], paved: [],
    furniture: [], signs: [], crossings: [], calming: [], barriers: [], power: [], venues: [] });
  const chunkIndex = new Map();
  const cell = (x, z) => {
    const k = Math.floor(x / 120) + ',' + Math.floor(z / 120);
    if (!chunkIndex.has(k)) chunkIndex.set(k, mk());
    return chunkIndex.get(k);
  };
  for (let x = 6; x < 232; x += 18) {
    cell(x, 40).buildings.push(tag({ o: square(x, 60 - hw - houseGap - 9, 9), h: 9, t: 'house' }));
    if (!terrace) cell(x, 80).buildings.push(tag({ o: square(x, 60 + hw + houseGap, 9), h: 9, t: 'house' }));
  }
  if (terrace) for (const x of [6, 126]) {
    const z = 60 + hw + houseGap;
    cell(x, 80).buildings.push(tag({ o: [[x, z], [x + 108, z], [x + 108, z + 9], [x, z + 9]], h: 12, t: 'apartments' }));
  }
  for (const r of roads) for (const k of ['0,0', '1,0']) {
    if (r.p.some((q) => Math.floor(q[0] / 120) + ',' + Math.floor(q[1] / 120) === k) || r === main) cell(k === '0,0' ? 10 : 130, 60).roads.push(r);
  }
  cell(60, 60).crossings.push(tag({ p: [[60, 60]] }));
  const pois = [{ t: 'bus_stop', p: [190, 60 + 4.5] }];
  const city = { chunkIndex, tile: 4800, pois, waterways: [], signals: [], paved: [] };
  indexJunctions(roads);
  indexBays(city, pois);
  setStreetCity(city);
  return { city, main };
}
// the street runs east, so its right (pk[1], e = -1) is the south kerb: z > 60
const southOf = (st) => st.z > 60;
const noseOf = (st) => [-Math.sin(st.h), -Math.cos(st.h)];

test('no tags: the procedural row, to the last digit', () => {
  const { city, main } = town();
  assert.deepEqual(kerbRows(main).map((r) => [r.e, r.orient, r.tagged, r.primary]), [[procSide(main), PARALLEL, false, true]]);
  const st = kerbStalls(city, main);
  // recorded from the module as it stood before `pk` was read (13 Nov 2026)
  assert.equal(st.length, 18);
  assert.equal(kerbSideOf(main), 1);
  const want = [[19.8974, 57.3, 1.563558, 0.077265], [26.1974, 57.3, 1.556796, 0.077265], [32.4974, 57.3, 1.586647, 0.077265],
    [38.7974, 57.3, 1.549857, 0.077265], [45.0974, 57.3, 1.594846, 0.077265], [51.3974, 57.3, 1.583703, 0.077265],
    [70.2974, 57.3, 1.590547, 0.077265]];
  for (let i = 0; i < want.length; i++) {
    const got = [st[i].x, st[i].z, st[i].h, st[i].roll];
    for (let k = 0; k < 4; k++) assert.ok(Math.abs(got[k] - want[i][k]) < 6e-5, `stall ${i} field ${k}: ${got[k]}`);
    assert.equal(st[i].tag, undefined, 'a procedural stall carries nothing of the tagged path');
  }
});

test('a sign that forbids it empties that kerb, and only that kerb', () => {
  for (const no of [PARK_NO, PARK_NO_PARKING, PARK_NO_STOPPING, PARK_SEPARATE]) {
    const both = town({ pk: [no, no] });
    assert.ok(!parkable(both.main), `code ${no} on both sides still parks`);
    assert.equal(kerbStalls(both.city, both.main).length, 0);
    const kp = new KerbParking(both.city, vehicles(), { terrain: { ready: () => true } }, []);
    kp.update(10, { x: 400, z: 60 }, 0.0);
    assert.equal(kp.parked.length, 0);
    assert.equal(kp.sideOf(both.main), 0, 'the traffic is not asked to give way to nobody');
  }
  // the hash wants the north kerb of this street (e = +1, the left: pk[0])
  assert.equal(procSide(town().main), 1);
  // forbidden there, nothing said about the other side: no cars at all (the
  // procedural row is one hashed side, and the sign took it)
  const a = town({ pk: [PARK_NO_STOPPING, 0] });
  assert.equal(kerbStalls(a.city, a.main).length, 0);
  // forbidden on the side the hash did NOT want: the procedural row stays as it was
  const b = town({ pk: [0, PARK_NO_PARKING] }), plain = town();
  assert.deepEqual(kerbStalls(b.city, b.main).map((s) => [s.x, s.z, s.h, s.roll]),
    kerbStalls(plain.city, plain.main).map((s) => [s.x, s.z, s.h, s.roll]));
});

test('an allowed side has the cars, on that side, whatever the hash wanted', () => {
  // Lonkova in Pardubice is 1/13: no parking on the left, parallel in the lane on the right
  const { city, main } = town({ pk: [PARK_NO, parkCode(PARALLEL, LANE)] });
  const st = kerbStalls(city, main);
  assert.ok(st.length >= 8, `${st.length} stalls`);
  assert.ok(st.every(southOf), 'a car on the forbidden side');
  assert.equal(kerbSideOf(main), -1);
  for (const s of st) {
    const [fx, fz] = noseOf(s);
    assert.ok(Math.abs(fx - 1) < 0.01 && Math.abs(fz) < 0.06, 'parallel, nose the way the right-hand lane runs');
    assert.equal(s.tag, PARALLEL);
  }
  // mapped on one side only: the unmapped side does not get the hashed row on top
  const one = town({ pk: [0, parkCode(PARALLEL, HALF)] });
  assert.ok(kerbStalls(one.city, one.main).every(southOf));
  // …and a tertiary road, which the procedural rule never parks, is believed too
  const tert = town({ t: 'tertiary', w: 7, pk: [parkCode(PARALLEL, LANE), PARK_NO] });
  assert.ok(!parkable(town({ t: 'tertiary', w: 7 }).main));
  const ts = kerbStalls(tert.city, tert.main);
  assert.ok(ts.length >= 8 && ts.every((s) => !southOf(s)));
  for (const s of ts) assert.ok(Math.abs(noseOf(s)[0] + 1) < 0.01, 'on the left of the way cars face against it');
  // The streets that carry parking tags are the well mapped ones, and those
  // have their pavements drawn as footways a metre and a half behind the kerb.
  // A car two wheels up is not on that footway; one square to the kerb would be.
  const walk = town({ pk: [PARK_NO, parkCode(PARALLEL, LANE)] }, { footway: 1.5 });
  const beside = kerbStalls(walk.city, walk.main).filter((s) => s.x < 100);
  assert.ok(beside.length >= 7 && beside.every(southOf), `${beside.length} stalls beside a mapped pavement`);
  const across = town({ pk: [PARK_NO, parkCode(PERPENDICULAR, 2)] }, { footway: 1.5 });
  assert.ok(kerbStalls(across.city, across.main).filter((s) => s.x < 100).every((s) => s.tag === PARALLEL),
    'a car parked square across the mapped pavement');
  // a bridge, a tunnel or a roundabout is never parked on, tagged or not
  for (const k of ['br', 'l', 'rb']) assert.ok(!parkable(town({ pk: [9, 9], [k]: 1 }).main), k);
});

test('square and slanted to the kerb where the map says so and the ground allows', () => {
  const perp = town({ pk: [PARK_NO, parkCode(PERPENDICULAR, 2)] });
  const st = kerbStalls(perp.city, perp.main);
  assert.ok(st.length >= 16, `${st.length} perpendicular stalls on 230 m`);
  for (const s of st) {
    assert.equal(s.tag, PERPENDICULAR);
    const [fx, fz] = noseOf(s);
    assert.ok(Math.abs(fz - 1) < 0.01 && Math.abs(fx) < 0.06, 'nose in to the south kerb');
    assert.ok(Math.abs(s.x - 60) >= 6, 'on the zebra');
  }
  const gaps = st.slice(1).map((s, i) => s.s - st[i].s).filter((g) => g < 4);
  assert.ok(gaps.length >= 10 && gaps.every((g) => Math.abs(g - 2.7) < 1e-6), 'side by side, 2.7 m apart');
  const diag = town({ pk: [PARK_NO, parkCode(DIAGONAL, 2)] });
  const ds = kerbStalls(diag.city, diag.main);
  assert.ok(ds.length >= 12);
  for (const s of ds) {
    const [fx, fz] = noseOf(s);
    assert.ok(fx > 0.5 && fz > 0.6, `slanted toward the kerb in the direction of travel (${fx.toFixed(2)}, ${fz.toFixed(2)})`);
  }
  // a terrace hard against the pavement: no room to stand square, so the row stands parallel
  const tight = town({ pk: [PARK_NO, parkCode(PERPENDICULAR, 2)] }, { houseGap: 2.2, terrace: true });
  const tightStalls = kerbStalls(tight.city, tight.main);
  assert.ok(tightStalls.length >= 8 && tightStalls.every((s) => s.tag === PARALLEL && southOf(s)), 'no parallel fallback');
  // a mapped footway 5 m out leaves a strip the cars stand in; they stop short of it
  const strip = town({ pk: [PARK_NO, parkCode(PERPENDICULAR, 2)] }, { footway: 5.4 });
  const ss = kerbStalls(strip.city, strip.main).filter((s) => s.x < 100);
  assert.ok(ss.length >= 6 && ss.every((s) => s.tag === PERPENDICULAR), `${ss.length} stalls beside the footway`);
  for (const s of ss) assert.ok(s.ez < 60 + 2.75 + 5.4 - 0.9, 'a bonnet over the footway');
});

test('never further into the road than the traffic leaves free', () => {
  const flank = (w) => Math.min(Math.min(TRAFFIC.laneOffsetK * w, TRAFFIC.laneOffsetMax) + 1.275, w / 2 - 0.5);
  for (const w of [5.5, 6.5, 7, 8, 10, 12]) for (const ow of [0, 1]) for (const orient of [PARALLEL, DIAGONAL, PERPENDICULAR]) {
    for (const pos of [0, LANE, 2, HALF, ON, 5]) {
      const r = { t: 'tertiary', w, d: 1, ow, _len: 200, p: [[0, 0], [200, 0]], pk: [parkCode(orient, pos), parkCode(orient, pos)] };
      const rows = kerbRows(r);
      assert.equal(rows.length, 2);
      assert.ok(rows[0].primary && !rows[1].primary);
      if (ow) assert.equal(rows[0].e, -1, 'on a one-way street the traffic can only give way to its right');
      for (const row of rows) {
        const P = rowPlace(r, row, rows), into = P.across - P.c;        // m of carriageway taken
        const at = `w ${w} ow ${ow} orient ${orient} pos ${pos} e ${row.e}`;
        if (row.primary) assert.ok(into <= Math.max(KERB_INTRUDES, w / 2 - flank(w) - 0.3) + 1e-9, at);
        else if (!ow) assert.ok(into <= w / 2 - flank(w) - 0.3 + 1e-9, `${at}: ${into.toFixed(2)} m with nobody giving way`);
        else assert.ok(into <= w / 2 + (w / 2 - KERB_INTRUDES - 0.35 - 1.275) - 1.275 - 0.3 + 1e-9 || into <= 0.2, at);
        assert.ok(P.need >= 0 && P.need <= 2 * P.across + 0.3);
        if (pos === ON) assert.ok(into <= 0, `${at}: on_kerb takes ${into.toFixed(2)} m of road`);
      }
    }
  }
  // each wheel on the verge or on the road: two up is half a kerb and a lean,
  // four up is a whole kerb and level, none is the deck
  let p = kerbPose(1, 0, 0, 1, 0);                 // nose east, kerb to the south (its right), centre on the kerb line
  assert.ok(Math.abs(p.lift - KERB_H / 2) < 1e-9 && Math.abs(Math.tan(p.roll) * 1.55 - KERB_H) < 1e-9 && p.pitch === 0);
  p = kerbPose(-1, 0, 0, 1, 0);                    // the other way round: the kerb is on its left
  assert.ok(Math.abs(Math.tan(p.roll) * 1.55 + KERB_H) < 1e-9);
  p = kerbPose(1, 0, 0, 1, 1.2);
  assert.ok(Math.abs(p.lift - KERB_H) < 1e-9 && p.roll === 0 && p.pitch === 0);
  p = kerbPose(1, 0, 0, 1, -1.2);
  assert.ok(p.lift === 0 && p.roll === 0 && p.pitch === 0);
  p = kerbPose(0, 1, 0, 1, 0);                     // nose in, front axle up
  assert.ok(Math.abs(p.lift - KERB_H / 2) < 1e-9 && p.roll === 0 && Math.abs(Math.tan(p.pitch) * 2.6 - KERB_H) < 1e-9);
});

class Group { constructor() { this.position = { set() {} }; } }
function vehicles() {
  return { cars: new Set(),
    add(kind, x, z, heading) { const car = { mesh: new Group(), x, z, y: 221, heading, kind, len: 4.6, wid: 1.8 }; this.cars.add(car); return car; },
    remove(car) { this.cars.delete(car); } };
}

test('tagged stalls are parked like any other: the same on every machine, nothing on the feature', () => {
  // (7 m: on a 5.5 m one-way street a bus passing a row on its right leaves
  // the left kerb only room for a car half up on it)
  const mk = () => town({ w: 7, ow: 1, pk: [parkCode(PARALLEL, LANE), parkCode(PARALLEL, HALF)] });
  const a = mk(), keys = Object.keys(a.main).sort();
  const st = kerbStalls(a.city, a.main);
  // a one-way street: half on the kerb on the right (the traffic moves over),
  // and room for a whole car in the lane on the left
  const right = st.filter(southOf), left = st.filter((s) => !southOf(s));
  assert.ok(right.length >= 8 && left.length >= 8, `${right.length} right, ${left.length} left`);
  for (const s of right) assert.ok(Math.abs(s.lift - KERB_H / 2) < 1e-9 && s.roll > 0.05);
  for (const s of left) {
    assert.ok(s.lift === 0 && s.roll === 0, 'a car in the lane stands flat on the road');
    assert.ok(s.z > 60 - 3.5 + 0.9, 'inside the kerb line');
    assert.ok(Math.abs(noseOf(s)[0] - 1) < 0.01, 'one way: both rows face the way of the street');
  }
  assert.deepEqual(Object.keys(a.main).filter((k) => !keys.includes(k)).filter((k) => k !== '_vg' && k !== '_sbb'), [],
    'something was hung on the road feature');
  const b = mk();
  assert.deepEqual(kerbStalls(b.city, b.main).map((s) => [s.x, s.z, s.h, s.roll, s.lift, s.pitch]),
    st.map((s) => [s.x, s.z, s.h, s.roll, s.lift, s.pitch]));
  // parked: the same car in the same stall from two clients, at the height its wheels say
  const fleet = () => {
    const w = mk(), parked = [];
    const kp = new KerbParking(w.city, vehicles(), { terrain: { ready: () => true } }, parked);
    kp.update(10, { x: 120, z: 200 }, 0.0);      // midnight, the player a street away
    return { parked, kp, main: w.main };
  };
  const one = fleet(), two = fleet();
  assert.ok(one.parked.length >= 8);
  assert.deepEqual(one.parked.map((c) => [c.kind, c.x, c.z, c.heading, c.y, c._gr, c._gp]),
    two.parked.map((c) => [c.kind, c.x, c.z, c.heading, c.y, c._gr, c._gp]));
  // (the untagged side street parks too, by the old rule: half a kerb up)
  assert.ok(one.parked.filter((c) => c._kerb.tag).length >= 8);
  for (const c of one.parked) {
    assert.ok(Math.abs(c.y - 221 - (c._kerb.tag ? c._kerb.lift : KERB_H / 2)) < 1e-9 && c._grounded, `y ${c.y}`);
  }
  assert.equal(one.kp.sideOf(one.main), -1, 'the traffic gives way to the right-hand row');
});

test('a bicycle keeps off both kerbs of a street parked on both sides', () => {
  // The traffic moves over for one row (kerbSideOf); the second is fitted
  // beside a bus in its lane, and a rider at the kerb edge would ride into it.
  const mk = (pk, w = 9) => ({ t: 'residential', w, d: 1, _len: 200, _id: 7000 + pk[0] * 40 + pk[1], p: [[0, 0], [100, 0], [200, 0]], pk });
  const both = mk([parkCode(PARALLEL, LANE), parkCode(PARALLEL, LANE)]);
  const first = kerbSideOf(both), second = secondKerbOf(both);
  assert.equal(second, -first, 'the other kerb');
  const net = new CycleNet();
  net.add([both]);
  const w = net.ways.get(both);
  assert.equal(net.rideable(w, 1), false);
  assert.equal(net.rideable(w, -1), false);
  // a second row standing wholly on the pavement leaves its kerb edge free
  const up = mk([parkCode(PARALLEL, ON), parkCode(PARALLEL, ON)]);
  assert.equal(secondKerbOf(up), 0);
  // one row, tagged or hashed: no second kerb, and the rule of old holds
  assert.equal(secondKerbOf(mk([PARK_NO, parkCode(PARALLEL, LANE)])), 0);
  const plain = { t: 'residential', w: 6, d: 1, _len: 200, p: [[0, 0], [200, 0]] };
  assert.equal(secondKerbOf(plain), 0);
  const net2 = new CycleNet();
  net2.add([plain]);
  const w2 = net2.ways.get(plain);
  assert.equal(net2.rideable(w2, -w2.park), false);
  assert.equal(net2.rideable(w2, w2.park), true);
});
