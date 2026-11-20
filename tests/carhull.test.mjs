// ---- a car is solid all the way along, and you walk round it to its door --------
// js/carhull.js: the hull as a rounded oriented rectangle, the way round it on
// foot, the crowd's step aside, and the discs of the car-against-car pass.
// Two bugs are pinned here (Frank, 20 Nov 2026): a walker went through the
// front seats of every car (the hull was two discs that do not meet), and a
// player who came up on the passenger's side walked through the car to the
// driver's door.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('../libs/three.module.js');
const { WALK } = await import('../js/config.js');
const H = await import('../js/carhull.js');
const { SEMI_LEN, SEMI_WID } = await import('../js/semitrailer.js');
const VEH = await import('../js/vehicles.js');
const DOOR = await import('../js/cardoor.js');
const { Player } = await import('../js/player.js');
const { CityWorld } = await import('../js/city.js');

const R = WALK.radius;
const KINDS = [
  ['octavia', 4.7, 1.81], ['fabia', 4.1, 1.74], ['van', 4.8, 1.9], ['truck', 7.6, 2.3],
  ['bus', 11.0, 2.5], ['trolleybus', 12.2, 2.55], ['roadster', 4.0, 2.0],
];
const rec = (len, wid, x = 0, z = 0, heading = 0, more = {}) => ({ x, z, heading, len, wid, y: 0, speed: 0, ...more });
// car frame <-> world, the game's convention
const toWorld = (c, lx, lz) => ({ x: c.x + lx * Math.cos(c.heading) + lz * Math.sin(c.heading), z: c.z - lx * Math.sin(c.heading) + lz * Math.cos(c.heading) });
const toLocal = (c, x, z) => {
  const dx = x - c.x, dz = z - c.z, ch = Math.cos(c.heading), sh = Math.sin(c.heading);
  return { lx: dx * ch - dz * sh, lz: dx * sh + dz * ch };
};
// distance from a point (car frame) to the plain len x wid box, negative inside
const boxDist = (lx, lz, hw, hl) => {
  const ex = Math.abs(lx) - hw, ez = Math.abs(lz) - hl;
  return ex > 0 || ez > 0 ? Math.hypot(Math.max(ex, 0), Math.max(ez, 0)) : Math.max(ex, ez);
};

// ---- 1. the hull -----------------------------------------------------------------

test('the old two discs let a walker through at the front seats, and the hull does not', () => {
  const c = rec(4.7, 1.81);
  // the model city.js had: two discs down the axis, pushed out of one after the other
  const discs = (pos) => {
    const rr = c.wid * 0.55 + R, back = c.len / 2 - c.wid * 0.55;
    for (const s of [-back, back]) {
      const ex = pos.x, ez = pos.z - s, d = Math.hypot(ex, ez);
      if (d >= rr || d < 1e-9) continue;
      pos.x = ex / d * rr; pos.z = s + ez / d * rr;
    }
  };
  // walking at the driver's door from the right at a walk, 60 steps a second
  const march = (push) => {
    const p = { x: 3, z: 0.03 };
    for (let i = 0; i < 60 * 4; i++) { p.x -= WALK.walk / 60; push(p); }
    return p;
  };
  const before = march(discs);
  assert.ok(before.x < -c.wid / 2, `the old model did hold (x ${before.x.toFixed(2)}): what is this test pinning?`);
  const after = march((p) => H.hullPushOut(p, R, c));
  assert.ok(Math.abs(after.x - (c.wid / 2 + R)) < 1e-6, `the walker stands at x ${after.x.toFixed(3)}`);
  assert.ok(H.hullContains(c, 0, 0, R) && H.hullContains(c, 0.5, 0.05, R));
});

test('no kind can be entered on foot anywhere: from every side, at every heading', () => {
  for (const [kind, len, wid] of KINDS) {
    for (const heading of [0, 0.6, -2.2, Math.PI / 2]) {
      const c = rec(len, wid, 31, -17, heading);
      const hw = wid / 2, hl = len / 2, rc = H.cornerRadius(c);
      // a walker marching at the car from every direction, aiming at every
      // point along its axis, pushed after each 5 cm step as collide() does
      for (let aim = -hl + 0.1; aim <= hl - 0.1; aim += 0.2) {
        for (let k = 0; k < 24; k++) {
          const a = k / 24 * Math.PI * 2, far = hl + 3;
          const from = toWorld(c, Math.cos(a) * far, aim + Math.sin(a) * far), to = toWorld(c, 0, aim);
          const p = { x: from.x, z: from.z };
          const n = Math.ceil(far / 0.05);
          for (let i = 0; i < n; i++) {
            p.x += (to.x - from.x) / n; p.z += (to.z - from.z) / n;
            H.hullPushOut(p, R, c);
            const l = toLocal(c, p.x, p.z);
            // never inside the body: at least a walker's radius from the box
            // with its corners cut by the corner radius (rc(sqrt2 - 1) at most)
            const d = boxDist(l.lx, l.lz, hw, hl);
            assert.ok(d >= R - rc * 0.4143 - 1e-6, `${kind} h=${heading}: walker ${d.toFixed(3)} m from the body at (${l.lx.toFixed(2)}, ${l.lz.toFixed(2)})`);
          }
        }
      }
      // and every point of the perimeter band is refused, with no slot in it
      for (let s = 0; s < 400; s++) {
        const t = s / 400 * 2 * (len + wid);
        let lx, lz;
        if (t < len) { lx = hw; lz = -hl + t; }
        else if (t < len + wid) { lx = hw - (t - len); lz = hl; }
        else if (t < 2 * len + wid) { lx = -hw; lz = hl - (t - len - wid); }
        else { lx = -hw + (t - 2 * len - wid); lz = -hl; }
        // step in from the outline by 5 cm: inside every hull whatever its corners
        const w = toWorld(c, lx * (1 - 0.05 / hw) * 0.98, lz * (1 - 0.05 / hl) * 0.98);
        assert.ok(H.hullContains(c, w.x, w.z, R), `${kind}: a slot in the hull at (${lx.toFixed(2)}, ${lz.toFixed(2)})`);
      }
    }
  }
});

test('a point in the very middle leaves through the nearer face, and outside nothing moves', () => {
  const c = rec(4.7, 1.81, 5, 5, 1.1);
  const mid = toWorld(c, 0.1, 0.4), p = { x: mid.x, z: mid.z };
  assert.equal(H.hullPushOut(p, R, c), true);
  const l = toLocal(c, p.x, p.z);
  assert.ok(Math.abs(l.lx - (c.wid / 2 + R)) < 1e-6 && Math.abs(l.lz - 0.4) < 1e-6, `left by (${l.lx}, ${l.lz})`);
  const out = toWorld(c, c.wid / 2 + R + 0.01, 0.4), q = { x: out.x, z: out.z };
  assert.equal(H.hullPushOut(q, R, c), false);
  assert.deepEqual(q, out);
  // a corner is round: on the diagonal the walker stands closer than to a square one
  const rc = H.cornerRadius(c), dg = toWorld(c, c.wid / 2 + 0.25, -c.len / 2 - 0.25);
  assert.ok(Math.hypot(0.25 + rc, 0.25 + rc) > rc + R, 'the test point should be clear of a round corner');
  const g = { x: dg.x, z: dg.z };
  assert.equal(H.hullPushOut(g, R, c), false);
});

test('the articulated lorry is two bodies, and its trailer is solid where it has swung to', () => {
  assert.equal(SEMI_LEN, 16.5, 'js/carhull.js copies this from js/semitrailer.js');
  assert.equal(SEMI_WID, 2.55);
  const straight = rec(SEMI_LEN, SEMI_WID, 0, 0, 0, { kind: 'semi', _tr: { psi: 0, init: true } });
  assert.equal(H.hullParts(straight), 2);
  // straight: solid from nose to tail, tractor and trailer both
  for (let lz = -8.0; lz <= 8.0; lz += 0.25) assert.ok(H.hullContains(straight, 0, lz, R), `open at ${lz}`);
  for (const lx of [1.0, -1.0]) for (let lz = -7.8; lz <= 8.0; lz += 0.25) assert.ok(H.hullContains(straight, lx, lz, R), `flank open at ${lx}, ${lz}`);
  // swung 0.5 rad: the tail is where the trailer is, not where the car's own axis says
  const bent = rec(SEMI_LEN, SEMI_WID, 0, 0, 0, { kind: 'semi', _tr: { psi: 0.5, init: true } });
  const kz = -(SEMI_LEN - 6.2) / 2 + 1.4, back = 11;
  const tail = { x: Math.sin(0.5) * back, z: kz + Math.cos(0.5) * back };
  assert.ok(H.hullContains(bent, tail.x, tail.z, 0.1), 'the swung trailer is not solid');
  assert.ok(!H.hullContains(bent, 0, kz + back, 0.1), 'the hull still stands where the trailer was');
  // a plain record of the same size (no trailer state) is one long box
  assert.equal(H.hullParts(rec(SEMI_LEN, SEMI_WID)), 1);
});

test('city.js collide(): a walker meets the body, a driven car\'s probes keep their discs', () => {
  const car = rec(4.7, 1.81, 100, 200, 0.8);
  const bus = rec(11, 2.5, 130, 200, 0, { kind: 'bus' });
  const w = Object.assign(Object.create(CityWorld.prototype), { city: { chunkIndex: new Map() }, carHulls: () => [car, bus] });
  const foot = { interior: true, yLo: 0.3, yHi: 1.8, aboveY: 0.3 };
  // through the front seats, and through the middle of the bus
  for (const [c, lz] of [[car, 0], [car, 0.3], [bus, 0], [bus, 2.5], [bus, -3]]) {
    const from = toWorld(c, 3, lz), to = toWorld(c, -3, lz), p = { x: from.x, z: from.z };
    for (let i = 0; i < 200; i++) {
      p.x += (to.x - from.x) / 200; p.z += (to.z - from.z) / 200;
      w.collide(p, R, foot);
    }
    const l = toLocal(c, p.x, p.z);
    assert.ok(l.lx >= c.wid / 2 + R - 1e-6, `walked through at lz ${lz}: ended at lx ${l.lx.toFixed(2)}`);
  }
  // asked without options (the exit landing) it is the body too
  const q = toWorld(bus, 0.2, 1);
  assert.equal(w.collide(q, R), true);
  assert.ok(!H.hullContains(bus, q.x, q.z, R - 1e-3));
  // the driven car's corner probe (wallPass asks with y): the two discs, as
  // before, hole and all, because car against car is carCarPass's to settle
  const c0 = toWorld(car, 0, 0), probe = { x: c0.x, z: c0.z };
  assert.equal(w.collide(probe, 0.2, { y: 0.3 }), false, 'the disc model changed under the car physics');
  const nose = toWorld(car, 0, -car.len / 2 + 0.3), pn = { x: nose.x, z: nose.z };
  assert.equal(w.collide(pn, 0.5, { y: 0.3 }), true);
  const back = car.len / 2 - car.wid * 0.55, ln = toLocal(car, pn.x, pn.z);
  assert.ok(Math.abs(Math.hypot(ln.lx, ln.lz + back) - (car.wid * 0.55 + 0.5)) < 1e-6, 'not the old disc');
});

// ---- 2. the way round ------------------------------------------------------------

const CLEAR = 0.5;
function walkRoute(hw, hl, sx, sz, gx, gz, ban = 0) {
  const r = H.planRound(hw, hl, CLEAR, sx, sz, gx, gz, H.makeRoute(), ban);
  const pts = [[sx, sz]];
  for (let i = 0; i < r.n; i++) pts.push([r.x[i], r.z[i]]);
  return { r, pts };
}
// the closest the polyline comes to the plain box
function closest(pts, hw, hl) {
  let m = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    for (let k = 0; k <= 40; k++) {
      const t = k / 40, x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t, z = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
      m = Math.min(m, boxDist(x, z, hw, hl));
    }
  }
  return m;
}

test('the way round never enters the body, ends at the goal, and is the shorter one', () => {
  let seed = 12345;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (const [kind, len, wid] of KINDS) {
    const hw = wid / 2, hl = len / 2;
    for (let n = 0; n < 300; n++) {
      // both ends somewhere round the car, from leaning on it to 4 m off
      const pick = () => {
        for (;;) {
          const x = (rnd() * 2 - 1) * (hw + 4), z = (rnd() * 2 - 1) * (hl + 4);
          if (boxDist(x, z, hw, hl) >= R) return [x, z];
        }
      };
      const [sx, sz] = pick(), [gx, gz] = pick();
      const { r, pts } = walkRoute(hw, hl, sx, sz, gx, gz);
      assert.ok(r.n >= 1 && r.n <= 8);
      assert.ok(Math.abs(r.x[r.n - 1] - gx) < 1e-9 && Math.abs(r.z[r.n - 1] - gz) < 1e-9, `${kind}: the way does not end at the goal`);
      // never nearer the body than both ends already were (less the corner shave)
      const floor = Math.min(R, boxDist(sx, sz, hw, hl), boxDist(gx, gz, hw, hl)) - 0.02;
      const m = closest(pts, hw, hl);
      assert.ok(m >= floor - 1e-6, `${kind}: the way passes ${m.toFixed(3)} m from the body (${sx.toFixed(2)},${sz.toFixed(2)}) -> (${gx.toFixed(2)},${gz.toFixed(2)})`);
      let L = 0;
      for (let i = 0; i < pts.length - 1; i++) L += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
      assert.ok(Math.abs(L - r.len) < 1e-6, 'len is not the length of the way');
      if (!r.direct && r.corner >= 0) {
        // forbidding the end it chose can only make the way longer
        const other = walkRoute(hw, hl, sx, sz, gx, gz, 1 << r.corner).r;
        assert.ok(other.len >= r.len - 1e-6, `${kind}: went the long way round (${r.len.toFixed(2)} against ${other.len.toFixed(2)})`);
      }
    }
  }
});

test('from the passenger\'s door to the driver\'s: round the nearer end, about one car width plus two', () => {
  const hw = 0.905, hl = 2.35;
  // doors are ahead of the middle, so the front is the nearer end
  const { r, pts } = walkRoute(hw, hl, 1.38, -0.4, -1.38, -0.4);
  assert.equal(r.direct, false);
  assert.ok(r.corner === 0, `first corner ${r.corner}, expected the front right one`);
  assert.ok(pts.every((q) => q[1] <= -0.4 + 1e-9), 'it went round the back');
  assert.ok(r.len > 7.0 && r.len < 8.2, `${r.len.toFixed(2)} m`);
  // a goal behind the middle: round the back
  const b = walkRoute(hw, hl, 1.38, 0.9, -1.38, 0.9).r;
  assert.ok(b.corner === 3, `first corner ${b.corner}, expected the rear right one`);
  // with the front blocked (a wall, a car parked against the bumper) it goes round the back
  const alt = walkRoute(hw, hl, 1.38, -0.4, -1.38, -0.4, 1 << 0).r;
  assert.ok(alt.corner === 3 && alt.len > r.len);
  // the same side is a straight walk along the flank
  const same = walkRoute(hw, hl, -1.30, 1.8, -1.38, -0.4).r;
  assert.equal(same.direct, true);
  assert.equal(same.n, 1);
});

// ---- 3. the real player --------------------------------------------------------

function stage(car, others = []) {
  const world = {
    carHulls: () => others,        // main.js leaves the car being boarded out
    supportY: () => 0,
    heightAt: () => 0,
    collide(pos, r) { let m = false; for (const c of others) m = H.hullPushOut(pos, r, c) || m; return m; },
  };
  const scene = new THREE.Scene();
  const input = { moveX: 0, moveZ: 0, keys: new Set() };
  const player = new Player(scene, 0, 0, 0, 'test:hull');
  car.mesh = new THREE.Group();
  scene.add(car.mesh);
  return { world, input, player, step: () => player.update(1 / 60, { input, camYaw: 0, world }) };
}

for (const [kind, heading] of [['octavia', 0.7], ['tesla', -2.4], ['van', 0], ['bus', 1.9]]) {
  test(`E from the passenger's side of a ${kind}: the player walks round it to the driver's door`, () => {
    const K = VEH.carShape(kind).K;
    const car = rec(K.len, K.wid, 40, -25, heading, { kind });
    const S = stage(car);
    const door = DOOR.doorSpec(kind, 0);
    const a = VEH.seatAnchor(car, 0);
    const stand = door ? door.stand : { x: Math.sign(a.x || -1) * (K.wid / 2 + 0.5), z: a.z };
    assert.ok(stand.x < 0, 'the driver sits on the left');
    // standing at the passenger's door, facing the car
    const from = toWorld(car, -stand.x + 0.3, stand.z);
    S.player.pos.x = from.x; S.player.pos.z = from.z;
    S.step();
    assert.equal(S.player.boardVehicle(car, 0, { locked: true }), true);
    let n = 0, walked = 0, far = 0, px = S.player.pos.x, pz = S.player.pos.z, top = 0;
    while (S.player.boarding?.phase === 'walk' && n < 60 * 30) {
      S.step(); n++;
      const l = toLocal(car, S.player.pos.x, S.player.pos.z);
      assert.ok(!H.hullContains(car, S.player.pos.x, S.player.pos.z, 0.3), `${kind}: inside the car at (${l.lx.toFixed(2)}, ${l.lz.toFixed(2)}) on step ${n}`);
      walked += Math.hypot(S.player.pos.x - px, S.player.pos.z - pz);
      px = S.player.pos.x; pz = S.player.pos.z;
      far = Math.max(far, Math.abs(l.lz));
      top = Math.max(top, S.player.speed);
    }
    assert.ok(S.player.boarding, `${kind}: the boarding was given up after ${n} steps (${walked.toFixed(1)} m walked)`);
    assert.notEqual(S.player.boarding.phase, 'walk', `${kind}: still walking after 30 s`);
    const l = toLocal(car, S.player.pos.x, S.player.pos.z);
    assert.ok(Math.hypot(l.lx - stand.x, l.lz - stand.z) < 0.33, `${kind}: stopped ${Math.hypot(l.lx - stand.x, l.lz - stand.z).toFixed(2)} m from the door`);
    // round an END of the car, on foot: further than straight through, and by way of a bumper
    assert.ok(walked > K.wid + 2 * 0.9, `${kind}: only ${walked.toFixed(2)} m walked: that is through the car`);
    assert.ok(far > K.len / 2 + 0.3, `${kind}: never went past a bumper (max |z| ${far.toFixed(2)})`);
    // the last metres are a walk, not a sprint (the jog is for the way up to the car)
    if (walked < 9) assert.ok(top <= 3.4 + 1e-6, `${kind}: ${top.toFixed(1)} m/s round the body`);
  });
}

test('from the driver\'s own side the walk-up is the straight one it always was', () => {
  const car = rec(4.7, 1.81, 0, 0, 0.3, { kind: 'octavia' });
  const S = stage(car);
  const door = DOOR.doorSpec('octavia', 0);
  const from = toWorld(car, door.stand.x - 2.5, door.stand.z + 1.5);
  S.player.pos.x = from.x; S.player.pos.z = from.z;
  S.step();
  S.player.boardVehicle(car, 0, { locked: true });
  let n = 0, walked = 0, px = from.x, pz = from.z;
  while (S.player.boarding?.phase === 'walk' && n < 600) {
    S.step(); n++;
    walked += Math.hypot(S.player.pos.x - px, S.player.pos.z - pz);
    px = S.player.pos.x; pz = S.player.pos.z;
  }
  assert.ok(S.player.boarding && S.player.boarding.phase !== 'walk');
  assert.ok(walked < Math.hypot(2.5, 1.5) + 0.1, `a detour of ${walked.toFixed(2)} m on the near side`);
  assert.ok(n < 120, `${n} steps`);
});

test('a way round that something else blocks is tried by the other end', () => {
  const car = rec(4.7, 1.81, 0, 0, 0, { kind: 'octavia' });
  // another car parked nose to nose with it, bumper to bumper: no way round the front
  const block = rec(4.7, 1.81, 0, -4.75, 0, { kind: 'fabia' });
  const S = stage(car, [block]);
  const door = DOOR.doorSpec('octavia', 0);
  const from = toWorld(car, -door.stand.x + 0.2, door.stand.z);
  S.player.pos.x = from.x; S.player.pos.z = from.z;
  S.step();
  S.player.boardVehicle(car, 0, { locked: true });
  let n = 0, rear = false;
  while (S.player.boarding?.phase === 'walk' && n < 60 * 30) {
    S.step(); n++;
    assert.ok(!H.hullContains(car, S.player.pos.x, S.player.pos.z, 0.3) && !H.hullContains(block, S.player.pos.x, S.player.pos.z, 0.3), 'inside a car');
    if (S.player.pos.z > car.len / 2 + 0.3) rear = true;
  }
  assert.ok(S.player.boarding && S.player.boarding.phase !== 'walk', `gave up after ${n} steps`);
  assert.ok(rear, 'it did not go round the back');
});

test('the passenger\'s door from the driver\'s side is the same walk, mirrored', () => {
  const car = rec(4.7, 1.81, -12, 60, 2.2, { kind: 'octavia' });
  const S = stage(car);
  const door = DOOR.doorSpec('octavia', 1);
  assert.ok(door.stand.x > 0);
  const from = toWorld(car, -door.stand.x - 0.4, door.stand.z + 0.3);
  S.player.pos.x = from.x; S.player.pos.z = from.z;
  S.step();
  assert.equal(S.player.boardVehicle(car, 1, {}), true);
  let n = 0, far = 0;
  while (S.player.boarding?.phase === 'walk' && n < 60 * 30) {
    S.step(); n++;
    assert.ok(!H.hullContains(car, S.player.pos.x, S.player.pos.z, 0.3), 'inside the car');
    far = Math.max(far, Math.abs(toLocal(car, S.player.pos.x, S.player.pos.z).lz));
  }
  assert.ok(S.player.boarding && S.player.boarding.phase !== 'walk', `gave up after ${n} steps`);
  assert.ok(far > 2.35 + 0.3);
  const l = toLocal(car, S.player.pos.x, S.player.pos.z);
  assert.ok(Math.hypot(l.lx - door.stand.x, l.lz - door.stand.z) < 0.33);
});

test('stepping out between cars parked a hand apart never puts the feet inside one', () => {
  for (const gap of [0.6, 0.3, 0.1]) {
    const car = rec(4.7, 1.81, 0, 0, 0.4, { kind: 'octavia' });
    const off = 1.81 + gap;
    const nl = toWorld(car, -off, 0), nr = toWorld(car, off, 0);
    const left = rec(4.7, 1.81, nl.x, nl.z, 0.4, { kind: 'fabia' }), right = rec(4.7, 1.81, nr.x, nr.z, 0.4, { kind: 'fabia' });
    const S = stage(car, [left, right]);
    // as in the game on the way out: our own car is a hull again
    const all = [left, right, car];
    S.world.carHulls = () => all;
    S.world.collide = (pos, r) => { let m = false; for (const c of all) m = H.hullPushOut(pos, r, c) || m; return m; };
    S.step();
    S.player.setInCar(car, 0);
    assert.equal(S.player.beginExit({}), true);
    const x = S.player.exiting;
    for (const c of all) assert.ok(!H.hullContains(c, x.tx, x.tz, 0.2), `gap ${gap}: the feet come down inside a car`);
  }
});

// ---- 4. the crowd's step aside ---------------------------------------------------

test('a walker whose line crosses a parked car is carried round its nearer end', () => {
  const c = rec(4.7, 1.81, 0, 0, 0);       // nose along -z
  const r = 0.35;
  // crossing it sideways (walking +x) a metre ahead of its middle: round the nose (-z)
  // left of travel (+x) is (dz, -dx) = (0, -1): so a step toward -z is positive
  const abeam = H.skirtOffset(c, 0, -1, 1, 0, r);
  assert.ok(abeam > 0, 'stepped toward the tail, the far end');
  assert.ok(Math.abs(abeam - (2.35 - 1 + r)) < 1e-6, `step ${abeam}`);
  assert.ok(!H.hullContains(c, 0, -1 - abeam - 1e-3, r - 0.01), 'the step does not clear the car');
  // behind the middle: round the tail
  assert.ok(H.skirtOffset(c, 0, 0.8, 1, 0, r) < 0);
  // it comes on over the last strides and is gone behind
  let prev = 0;
  for (let x = -5; x <= -0.905 - r; x += 0.1) {
    const o = H.skirtOffset(c, x, -1, 1, 0, r);
    assert.ok(o >= prev - 1e-9, 'the step shrank on the way up to the car');
    assert.ok(o - prev < 0.25, `a jump of ${(o - prev).toFixed(2)} m in one 10 cm stride`);
    prev = o;
  }
  assert.equal(H.skirtOffset(c, -5, -1, 1, 0, r), 0);
  assert.equal(H.skirtOffset(c, 4, -1, 1, 0, r), 0);
  // a line that passes the bumper clear is left alone, at any distance
  for (let x = -5; x <= 5; x += 0.5) assert.equal(H.skirtOffset(c, x, -2.35 - r - 0.05, 1, 0, r), 0);
  // along the pavement beside it: nothing
  for (let z = -6; z <= 6; z += 0.5) assert.equal(H.skirtOffset(c, 0.905 + r + 0.05, z, 0, -1, r), 0);
});

// ---- 5. the discs of car against car -----------------------------------------------

test('cars keep the two discs they had, long bodies get as many as close the gap', () => {
  const out = [];
  for (const [kind, len, wid] of [['octavia', 4.7, 1.81], ['fabia', 4.1, 1.74], ['bmw', 4.7, 1.86], ['mercedes', 4.9, 1.86], ['tesla', 4.7, 1.85], ['van', 4.8, 1.9], ['roadster', 4.0, 2.0]]) {
    const n = H.discOffsets(len, wid, out), rA = wid * 0.62, dA = Math.max(0, len / 2 - rA);
    assert.equal(n, 2, `${kind} has ${n} discs`);
    assert.ok(Math.abs(out[0] + dA) < 1e-9 && Math.abs(out[1] - dA) < 1e-9, `${kind}: the discs moved`);
  }
  for (const [kind, len, wid, want] of [['truck', 7.6, 2.3, 3], ['bus', 11, 2.5, 4], ['trolleybus', 12.2, 2.55, 4], ['semi', 16.5, 2.55, 6]]) {
    const n = H.discOffsets(len, wid, out), rA = wid * 0.62;
    assert.equal(n, want, `${kind} has ${n} discs`);
    assert.ok(Math.abs(out[0] + (len / 2 - rA)) < 1e-9 && Math.abs(out[n - 1] - (len / 2 - rA)) < 1e-9, `${kind}: the end discs moved`);
    // the slimmest car's disc, pushed at the flank between two discs, sinks a hand at most
    const rB = 1.74 * 0.62;
    for (let i = 0; i < n - 1; i++) {
      const s = out[i + 1] - out[i];
      const lat = Math.sqrt((rA + rB) ** 2 - (s / 2) ** 2);
      assert.ok(wid / 2 - (lat - rB) <= 0.25 + 1e-6, `${kind}: a nose goes ${(wid / 2 - (lat - rB)).toFixed(2)} m into the flank`);
    }
  }
});
