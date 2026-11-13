// ---- the crowd, after the code review ------------------------------------------
// One test per defect the review confirmed in the crowd and its seams with the
// buses, each on the smallest fixture that shows it:
//   - people waiting for a bus stood inside the lay-by the bus pulls into, and
//     a footway the map drew a metre behind the kerb ran through it,
//   - a bench seat was remembered per bench instead of per visit, and who had
//     it turned on which bodies this client happened to have made,
//   - a beat with a metre of pavement left paced it for seven minutes,
//   - boarders walked to a window pane instead of a door,
//   - the old man held his stick in the air when he stood still,
//   - fast movers who told the gait only a capped speedK got spinning legs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { Pedestrians } = await import('../js/pedestrians.js');
const { SITE, RoadIndex, stopSpot, stopBay } = await import('../js/crowdsites.js');
const streets = await import('../js/streets.js');
const { sampleTimeline } = await import('../js/dwell.js');
const { makeCitizen } = await import('../js/citizen.js');
const { makeGait } = await import('../js/gait.js');
const { BONE, bodyDims } = await import('../js/bodyshape.js');
const { PLAYER_SCALE } = await import('../js/config.js');

const T_NOON = 17_899_320;            // half past noon on the shared clock (a weekday)
const scene = () => ({ add() {}, remove() {} });

// An 8 m street with a bus stop on its north kerb, so js/streets.js makes a
// lay-by there, and a footway on each side 0.8 m behind the nominal kerb: the
// north one runs through the bay.
function bayTown({ house = false, wall = 7.3 } = {}) {
  const street = { t: 'secondary', d: 1, w: 8, _id: 1, _len: 400, p: [[-200, 0], [200, 0]] };
  const north = { t: 'footway', d: 0, w: 1.8, _id: 2, p: [[-200, 4.8], [200, 4.8]] };
  const south = { t: 'footway', d: 0, w: 1.8, _id: 3, p: [[-200, -4.8], [200, -4.8]] };
  const roads = [street, north, south];
  const pois = [{ t: 'bus_stop', p: [0, 5.5] }];
  // a house standing where the pavement behind the bay would be
  const buildings = house ? [{ t: 'yes', o: [[-9, wall], [9, wall], [9, 15], [-9, 15]] }] : [];
  const cell = () => ({ roads, furniture: [], crossings: [], venues: [], buildings });
  const city = { roads, pois, chunkIndex: new Map([['0,0', cell()], ['-1,0', cell()]]), onTileLoaded() {} };
  streets.indexBays(city, pois);
  return { city, street };
}

// ---------------------------------------------------------------- the lay-by ----
test('people waiting for a bus stand behind the lay-by, not in it', () => {
  const { city, street } = bayTown();
  assert.deepEqual(street._bays, [200, -1], 'the fixture changed: no lay-by was made at the stop');
  const idx = new RoadIndex();
  idx.add(street);
  const hw = street.w / 2;
  const road = idx.nearest(0, 5.5, 30);
  assert.equal(stopBay(0, 5.5, road), streets.BAY_W, 'the kerb steps out the width of the bay at the stop');
  assert.equal(stopBay(0, -5.5, idx.nearest(0, -5.5, 30)), 0, 'the opposite kerb has no bay');
  assert.equal(stopBay(120, 5.5, idx.nearest(120, 5.5, 30)), 0, 'nor has this kerb a hundred metres on');
  // the old spot: 1.1 m behind the nominal kerb, which is inside the bay
  const old = stopSpot(0, 5.5, road);
  assert.ok(old.z < hw + streets.BAY_W, 'the fixture changed: the unshifted spot is not in the bay');
  const spot = stopSpot(0, 5.5, road, stopBay(0, 5.5, road));
  assert.ok(spot.z >= hw + streets.BAY_W + 1.1 - 1e-9, `waiters stand ${spot.z.toFixed(2)} m out: the bus's flank reaches ${(hw + 2.2).toFixed(1)}`);
  assert.ok(spot.fz < 0, 'they face the road');
  // a stop node mapped on the centreline: the same rule
  const mid = stopSpot(0, 0, idx.nearest(0, 0, 30), streets.BAY_W);
  assert.ok(Math.abs(mid.z) >= hw + streets.BAY_W + 1.1);
  // where there is no bay nothing moves
  const plain = idx.nearest(120, 5.5, 30);
  assert.deepEqual(stopSpot(120, 5.5, plain, stopBay(120, 5.5, plain)), stopSpot(120, 5.5, plain));
  // …and the crowd files its stops that way
  const peds = new Pedestrians(scene(), city);
  const site = peds.sites.has(SITE.STOP, 0, 5.5, 1);
  assert.ok(site && site.spot.z >= hw + streets.BAY_W + 1.1 - 1e-9, 'the crowd still waits in the lay-by');
});

test('where a house stands behind the lay-by, people wait in front of its wall and still behind the kerb', () => {
  // the wall 0.6 m behind the stepped-out kerb: 1.1 m behind that kerb is inside the house
  const { city, street } = bayTown({ house: true, wall: 7.6 });
  const kerb = street.w / 2 + streets.BAY_W;
  const idx = new RoadIndex();
  idx.add(street);
  const road = idx.nearest(0, 5.5, 30);
  assert.ok(stopSpot(0, 5.5, road, stopBay(0, 5.5, road)).z > 7.6, 'the fixture changed: the plain spot is not in the house');
  const peds = new Pedestrians(scene(), city);
  const spot = peds.sites.has(SITE.STOP, 0, 5.5, 1).spot;
  assert.ok(spot.z < 7.6, `waiting ${(spot.z - 7.6).toFixed(2)} m inside the wall`);
  assert.ok(spot.z >= kerb + 0.3 - 1e-9, `waiting ${(spot.z - kerb).toFixed(2)} m from the kerb of the bay: the bus pulls in there`);
  // no house, no change
  const open = new Pedestrians(scene(), bayTown().city).sites.has(SITE.STOP, 0, 5.5, 1).spot;
  assert.ok(Math.abs(open.z - (kerb + 1.1)) < 1e-9);
});

// every beat a cell's first `n` slots would walk
function beatsOf(peds, key, n = 40) {
  const c = peds._cells.get(key);
  for (let k = 0; k < n; k++) peds._birth(key + '/' + k, c, k, T_NOON);
  return [...peds._pool.values()];
}

test('a footway that runs through a lay-by is walked round it, behind the kerb', () => {
  const { city, street } = bayTown();
  const peds = new Pedestrians(scene(), city);
  peds.clock = () => T_NOON;
  const kerb = street.w / 2 + streets.BAY_W;
  const P = { x: 0, z: 0, dx: 0, dz: 0 };
  let inBay = 0, clear = 0, bent = 0;
  for (const s of beatsOf(peds, '0,0')) {                 // the north footway
    for (const sign of [1, -1]) {
      let px = NaN, pz = NaN;
      for (let a = s.lo; a <= s.span; a += 0.5) {
        const lat = s.lat * peds._latK(s.tight, a, sign);
        peds._walkPose(s.steps, a, sign, lat, s.span, P);              // where the map alone would put them
        const raw = P.z;
        peds._walkPose(s.steps, a, sign, lat, s.span, P, s.bay);
        if (Math.abs(P.x) <= 6) {
          inBay++;
          assert.ok(raw < kerb, 'the fixture changed: the footway does not run through the bay');
          assert.ok(P.z >= kerb + 0.35, `walking ${(kerb - P.z).toFixed(2)} m inside the lay-by at x = ${P.x.toFixed(1)}`);
        } else if (Math.abs(P.x) >= 40) {
          clear++;
          assert.equal(P.z, raw, 'pushed off the footway where there is no bay');
        }
        // nobody sidesteps: half a metre of beat is never more than a stride
        if (!Number.isNaN(px)) assert.ok(Math.hypot(P.x - px, P.z - pz) < 1, 'a jump where the line bends out');
        px = P.x; pz = P.z;
      }
    }
    if (s.bay) bent++;
  }
  assert.ok(inBay > 100 && clear > 100 && bent >= 3, `only ${inBay} samples in the bay, ${bent} beats through it`);
  // the pavement opposite has no bay to walk round
  const south = beatsOf(peds, '0,-1').filter((s) => s.cj === -1);
  assert.ok(south.length >= 5);
  for (const s of south) assert.equal(s.bay, null);
});

test('the walk round a lay-by does not go through the wall of a house', () => {
  const { city } = bayTown({ house: true });
  const peds = new Pedestrians(scene(), city);
  peds.clock = () => T_NOON;
  const P = { x: 0, z: 0, dx: 0, dz: 0 };
  let n = 0;
  for (const s of beatsOf(peds, '0,0')) {
    for (let a = s.lo; a <= s.span; a += 0.5) {
      peds._walkPose(s.steps, a, 1, s.lat * peds._latK(s.tight, a, 1), s.span, P, s.bay);
      if (Math.abs(P.x) > 9) continue;
      n++;
      assert.ok(P.z < 7.3, `walking inside the house at ${P.x.toFixed(1)}, ${P.z.toFixed(1)}`);
    }
  }
  assert.ok(n > 50);
});

// ---------------------------------------------------------------- the bench ----
// a schedule as _seatOf reads it: a bench at stop 0, visited over the given spans
function sitter(key, seed, site, visits, t0) {
  const t = [0], k = [0], r = [-1];
  for (const [a, b] of visits) { t.push(a, b); k.push(1, 0); r.push(0, -1); }
  t.push(1e6); k.push(0); r.push(-1);
  const flat = t.map(() => 5);
  return { key, seed, rs: seed, pair: 0, t0, gen: 0, stops: [{ site, kind: 1 }], seat: null,
    tl: { n: t.length, i: 0, t, a: flat, d: flat, k, r } };
}
// three strangers who would all pick the same half of the bench
function sameHalf(peds, site, n = 3) {
  const seeds = [];
  for (let seed = 1; seeds.length < n; seed++) {
    if (peds._seatPref({ pair: 0, seed }, site) === 1) seeds.push(seed);
  }
  return seeds;
}

test('a seat is taken per visit: coming back to the bench, nobody sits on whoever sat down meanwhile', () => {
  const peds = new Pedestrians(scene(), { roads: [], pois: [], onTileLoaded() {} });
  const site = { sid: 9, x: 10, z: 42, h: 0 };
  const [sa, sb, sc] = sameHalf(peds, site);
  // a sits 100 to 130, walks on, and is back at 200; b sat down at 150 and stays
  const a = sitter('0,0/1', sa, site, [[100, 130], [200, 260]]);
  const b = sitter('0,0/2', sb, site, [[150, 300]]);
  const c = sitter('0,0/3', sc, site, [[210, 250]]);
  peds._benchers.set(9, new Set([a, b, c]));
  assert.equal(peds._seatOf(a, 0, 100), 1, 'alone on the bench: the half they prefer');
  assert.equal(peds._seatOf(b, 0, 150), 1, 'a has gone: their half is free');
  assert.equal(peds._seatOf(a, 0, 200), -1, 'back on the half b is sitting on');
  assert.equal(peds._seatOf(c, 0, 210), 0, 'a third on a bench for two');
  assert.equal(peds._seatOf(a, 0, 100), 1, 'the first visit is still what it was');
  // the keyframe a visit is read from is what sampleTimeline hands out
  const out = {};
  sampleTimeline(a.tl, 215, out);
  assert.equal(a.tl.t[out.i], 200);
});

test('seats come out the same whoever asks first, and whether or not the earlier sitter is still pooled', () => {
  const site = { sid: 9, x: 10, z: 42, h: 0 };
  const build = () => {
    const peds = new Pedestrians(scene(), { roads: [], pois: [], onTileLoaded() {} });
    const [so, ss, s2] = sameHalf(peds, site);
    // o's generation ends at 420 (t0 = 0): on the bench from 380, and gone at 420
    // whatever the timeline says. s sits down beside them at 400; s2 arrives at 425.
    const o = sitter('0,0/1', so, site, [[380, 440]], 0);
    const s = sitter('0,0/2', ss, site, [[400, 460]], 300);
    const n = sitter('0,0/3', s2, site, [[425, 470]], 300);
    peds._benchers.set(9, new Set([o, s, n]));
    return { peds, o, s, n };
  };
  // a client that met them in the order they arrived
  const A = build();
  const want = [A.peds._seatOf(A.o, 0, 380), A.peds._seatOf(A.s, 0, 400), A.peds._seatOf(A.n, 0, 425)];
  assert.deepEqual(want, [1, -1, 1], 's sits beside o; n takes the half o left when their generation rolled');
  // …one that gave the last arrival a body first, with o in no pool at all
  // (nothing in the fixture is pooled: the answer may not turn on that)
  const B = build();
  assert.equal(B.peds._pool.size, 0);
  assert.deepEqual([B.peds._seatOf(B.n, 0, 425), B.peds._seatOf(B.s, 0, 400), B.peds._seatOf(B.o, 0, 380)].reverse(), want);
  // a schedule this client learns of late (a cold boot): the answers are worked out again
  const C = build();
  C.peds._benchers.get(9).delete(C.o);
  assert.equal(C.peds._seatOf(C.s, 0, 400), 1, 'without o, s has the half they prefer');
  C.peds._benchers.get(9).add(C.o);
  C.peds._benchRev++;                                   // what _plan does for a late arrival
  assert.equal(C.peds._seatOf(C.s, 0, 400), -1, 'still seated as if o had never been there');
});

// ------------------------------------------------------------ the short beat ----
test('a beat with under four metres of pavement left is no beat: nobody paces it, nobody is NaN', () => {
  // a 12 m path that starts in the middle of a 10 m street: pulled in off the
  // carriageway, two or three metres of it are left
  const mk = (len) => {
    const roads = [
      { t: 'residential', d: 1, w: 10, _id: 1, p: [[-100, 0], [100, 0]] },
      { t: 'footway', d: 0, w: 1.8, _id: 2, p: [[0, -3], [0, -3 + len]] },
    ];
    let loaded = null;
    const peds = new Pedestrians(scene(), { roads, pois: [], onTileLoaded(f) { loaded = f; } });
    peds.clock = () => T_NOON;
    return { peds, load: () => loaded({ roads: [], cells: [] }) };
  };
  const short = mk(12.2);
  const key = [...short.peds._cells.keys()][0];
  assert.equal(beatsOf(short.peds, key, 8).length, 0, 'somebody was given a beat a stride long');
  assert.equal(short.peds._dud.size, 8, 'the answer is remembered for the generation, not worked out again every sweep');
  short.load();
  assert.equal(short.peds._dud.size, 0, 'more map may give the beat somewhere to go');
  // the same street with a path that leads somewhere
  const long = mk(70);
  const beats = beatsOf(long.peds, [...long.peds._cells.keys()][0], 8);
  assert.ok(beats.length >= 6, `only ${beats.length} of 8 walkers on a 70 m path`);
  const out = {};
  for (const s of beats) {
    assert.ok(s.span - s.lo >= 4);
    assert.ok(s.tl.n >= 2);
    for (let t = s.t0; t < s.t0 + 420; t += 7) assert.ok(Number.isFinite(sampleTimeline(s.tl, t, out).arc));
  }
});

// ------------------------------------------------------------------ the bus ----
test('boarders go in at the front door of the bus and alighters come out of the middle one', () => {
  const peds = new Pedestrians(scene(), bayTown().city);
  peds.clock = () => T_NOON;
  // nose toward -z, so the kerb side is +x; js/cardetail.js: door glass 0.47 to
  // 1.43 m and 4.63 to 5.97 m behind the nose of the 11 m body
  const bus = { x: 0, z: 0, heading: 0, len: 11, wid: 2.5, speed: 0 };
  const nose = -bus.len / 2;
  const p = { state: 'board', boardCar: bus, boardT: 0, boardDone: false, x: 4, z: -1, heading: 0, walkT: 0, speed: 0,
    gx: 1e9, gz: 1e9, gy: null, blend: 0, animate() {}, standPose() {}, mesh: { visible: true, position: { set() {} }, rotation: {} } };
  for (let i = 0; i < 400 && !p.boardDone; i++) peds._boardStep(p, 1 / 20);
  assert.ok(p.boardDone, 'never reached the door');
  assert.ok(p.z > nose + 0.47 - 0.4 && p.z < nose + 1.43 + 0.4, `went in ${(p.z - nose).toFixed(2)} m behind the nose: that is a window`);
  assert.ok(p.x > bus.wid / 2 && p.x < bus.wid / 2 + 0.8, 'on the kerb side');
  // somebody whose timetable has them stepping off the bus standing at their stop
  const s = beatsOf(peds, '0,-1').find((q) => q.cross.length === 0 && !q.bay);
  const out = {};
  sampleTimeline(s.tl, T_NOON, out);
  peds._walkPose(s.steps, out.arc, out.sign, s.lat, s.span, out);
  s.stops = [{ site: { x: 0, z: 0 } }];
  s.alight = { stop: 0, arc: out.arc, t: T_NOON - 1 };
  peds.busAt = () => bus;
  for (const q of peds._pool.values()) if (q !== s) q.held = 1;       // only this one is wanted
  peds._sweep(T_NOON, out.x, out.z);
  assert.ok(s.body, 'nobody stepped off');
  assert.ok(s.body.bz > nose + 4.63 && s.body.bz < nose + 5.97, `stepped out ${(s.body.bz - nose).toFixed(2)} m behind the nose: that is a window`);
  assert.ok(s.body.bx > bus.wid / 2);
  s.body.dispose();
});

// --------------------------------------------------------------- the old man ----
// the tip of the stick (its lowest vertices), in the world
function stickTip(c) {
  c.group.updateMatrixWorld(true);
  let mesh = null;
  c.group.traverse((o) => { if (o.isSkinnedMesh) mesh = o; });
  const sk = mesh.skeleton, pos = mesh.geometry.attributes.position;
  const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
  let minY = Infinity;
  for (let i = 0; i < pos.count; i++) if (si.getX(i) === BONE.cane && sw.getX(i) > 0.99 && pos.getY(i) < minY) minY = pos.getY(i);
  const m = new THREE.Matrix4().multiplyMatrices(sk.bones[BONE.cane].matrixWorld, sk.boneInverses[BONE.cane]);
  const v = new THREE.Vector3(), acc = new THREE.Vector3();
  let n = 0;
  for (let i = 0; i < pos.count; i++) {
    if (si.getX(i) !== BONE.cane || !(sw.getX(i) > 0.99) || pos.getY(i) > minY + 1e-4) continue;
    acc.add(v.fromBufferAttribute(pos, i).applyMatrix4(m)); n++;
  }
  return acc.multiplyScalar(1 / n);
}

test('a man with a stick stands with it on the ground, not in the air behind him', () => {
  const c = makeCitizen({ archetype: 'm90' });
  assert.ok(c.outfit.cane, 'the fixture changed: the ninety-year-old has no stick');
  c.group.scale.setScalar(PLAYER_SCALE);
  for (const pose of [() => {}, () => c.standPose(), () => { c.walk(1, 1, 0, 0.7); c.walk(2, 1, 0, 0.7); c.standPose(); },
    () => { c.ragdollPose(); c.standPose(); }]) {
    pose();
    const tip = stickTip(c);
    assert.ok(tip.y > -0.03 && tip.y < 0.04, `the tip of the stick is ${(tip.y * 100).toFixed(0)} cm off the ground`);
    assert.ok(tip.z < 0, `…and ${tip.z.toFixed(2)} m behind him (he faces -z)`);
    // a fixed pose still clears what a ragdoll splayed
    assert.equal(c.parts.armL.rotation.z, 0);
    assert.equal(c.parts.armR.rotation.z, 0);
  }
  // the stride picks up where the owner says, as after any fixed pose
  c.walk(3, 1, 0, 0.7);
  c.dispose();
  // everybody else stands as before: arms hanging
  const y = makeCitizen({ archetype: 'm30' });
  y.walk(1, 1, 0, 1.4); y.standPose();
  assert.equal(y.parts.armR.rotation.x, 0);
  assert.equal(y.parts.elbowR.rotation.x, 0);
  y.dispose();
});

// ------------------------------------------------------------------ the gait ----
// strides a second the gait draws for somebody covering `speed` m/s
function cadence(key, unit, speed, speedK, runK, mps) {
  const J = {};
  for (const n of ['group', 'body', 'pelvis', 'torso', 'chest', 'head', 'armL', 'armR', 'elbowL', 'elbowR', 'handL', 'handR',
    'legL', 'legR', 'kneeL', 'kneeR', 'footL', 'footR', 'cane'])
    J[n] = { rotation: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 }, scale: { x: 1 } };
  const g = makeGait(J, bodyDims(key, 1.8), { unit, seed: 0 });
  const real = globalThis.performance;
  let clock = 0;
  globalThis.performance = { now: () => clock };
  try {
    let walkT = 0, cycles = 0;
    g.walk(walkT, speedK, runK, mps);
    let prev = g.state.phase;
    for (let i = 0; i < 300; i++) {
      clock += 1000 / 60;
      walkT += speed / 60 * 1.6;
      g.walk(walkT, speedK, runK, mps);
      let d = g.state.phase - prev;
      if (d < 0) d += 1;
      cycles += d; prev = g.state.phase;
    }
    return cycles / 5;
  } finally { globalThis.performance = real; }
}

test('told the true speed, the gait gives a sprinter and somebody fleeing a running stride', () => {
  // js/netcity.js: a remote player sprinting at 14 m/s. speedK is capped at
  // 1.25 of a jog and no run blend is sent, so the speed is what has to say it.
  const local = cadence('m30', 5.6, 14, 1.25, 1, 14);
  const blind = cadence('m30', 5.6, 14, 1.25, 0, undefined);
  const told = cadence('m30', 5.6, 14, 1.25, 0, 14);
  assert.ok(blind > local * 1.4, `the fixture changed: ${blind.toFixed(2)} against ${local.toFixed(2)} strides a second`);
  assert.ok(Math.abs(told - local) < 0.02 * local, `a remote sprinter strides ${told.toFixed(2)} a second, their own screen ${local.toFixed(2)}`);
  // js/interiorsim.js: an occupant fleeing at 4.6 x their own pace, animated with 1.3
  for (const key of ['m30', 'f30', 'm90']) {
    const before = cadence(key, 1.4, 4.83, 1.3, 0, undefined), after = cadence(key, 1.4, 4.83, 1.3, 0, 4.83);
    assert.ok(before > 2.8, `the fixture changed: ${key} ${before.toFixed(2)}`);
    assert.ok(after < 1.8, `${key} flees at ${after.toFixed(2)} strides a second`);
  }
});
