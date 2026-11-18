// ---- locked cars, doors, jumps, vaults, getting up, pulling a driver out ------
// The step between parts one and two of the campaign. Everything here is a
// claim that can be checked without a renderer: which cars are locked, what a
// door's outline is, how high a jump goes and whether it hurts, what counts as
// something to vault, how a body gets up, who saw a carjacking.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('../libs/three.module.js');
const locks = await import('../js/carlocks.js');
const { riseCurve, RISE_PRONE, RISE_SUPINE, stepBody } = await import('../js/ejection.js');
const VEH = await import('../js/vehicles.js');
const DOOR = await import('../js/cardoor.js');
const { Player } = await import('../js/player.js');
const { findVault, JUMP_V } = await import('../js/leap.js');
const { Carjack, witnessed, WITNESS_R } = await import('../js/carjack.js');
const { cabinVariant, SEATS, WHEELS, wheelParts } = await import('../js/cabinkit.js');
const vitals = await import('../js/vitals.js');
const wanted = await import('../js/wanted.js');

// ---- 1. locks ------------------------------------------------------------------

test('ninety-nine parked cars in a hundred are locked, and a car answers the same way twice', () => {
  let open = 0;
  const n = 40000;
  for (let i = 0; i < n; i++) {
    const car = { kind: i % 2 ? 'octavia' : 'fabia', x: i * 3.71, z: (i % 97) * 5.3 };
    const a = locks.isLocked(car);
    assert.equal(locks.isLocked(car), a);
    if (!a) open++;
  }
  const share = open / n;
  assert.ok(share > 0.006 && share < 0.014, `open share ${share}`);
  // the room agrees about a fleet car: the key is its index, not where it stands
  const a = { kind: 'bmw', parkIdx: 12, x: 1, z: 1 }, b = { kind: 'bmw', parkIdx: 12, x: 500, z: -90 };
  assert.equal(locks.lockDraw(a), locks.lockDraw(b));
});

test('your own car, the story\'s car and a car you have sat in are never locked', () => {
  const locked = () => {
    for (let i = 0; i < 50; i++) { const c = { kind: 'octavia', x: i * 11, z: 3 }; if (locks.isLocked(c)) return c; }
    throw Error('no locked car in fifty');
  };
  const a = locked(); a.owned = true;
  assert.equal(locks.isLocked(a), false);
  const b = locked(); locks.unlock(b);
  assert.equal(locks.isLocked(b), false);
  assert.equal(locks.isLocked(null), false);
});

// ---- 2. doors and cabins ---------------------------------------------------------

test('every kind with a greenhouse has two front doors that fit its body', () => {
  for (const kind of VEH.CAR_KINDS) {
    const L = DOOR.doorSpec(kind, 0), R = DOOR.doorSpec(kind, 1);
    const K = VEH.carShape(kind).K;
    if (!K.green) { assert.equal(L, null, kind); continue; }
    assert.ok(L && R, kind);
    assert.equal(L.side, -1); assert.equal(R.side, 1);
    assert.ok(L.zB - L.zF > 0.8 && L.zB - L.zF < 2.0, `${kind}: door ${L.zB - L.zF} m long`);
    assert.ok(L.yLo > 0.1 && L.yLo < 0.4 && L.yTop > L.yBelt + 0.3, `${kind}: heights`);
    assert.ok(L.hingeX > K.wid * 0.4 && L.hingeX <= K.wid / 2 + 0.01, `${kind}: hinge`);
    // the handle is on the door and the standing spot is outside its swing
    assert.ok(L.handle.z > L.zF && L.handle.z < L.zB && L.handle.y < L.yBelt, `${kind}: handle`);
    const sw = Math.hypot(Math.abs(L.stand.x) - L.hingeX, L.stand.z - L.zF);
    assert.ok(sw > L.zB - L.zF, `${kind}: you would stand in the door's swing (${sw.toFixed(2)})`);
    // the seat is between the shut lines
    const a = VEH.seatAnchor({ kind }, 0);
    assert.ok(a.z > L.zF && a.z < L.zB + 0.25, `${kind}: seat ${a.z} outside ${L.zF}..${L.zB}`);
    // what the glass draws is the same cabin
    const g = VEH.cabinGlass(kind, 0x224466);
    assert.ok(g && g.A.every(Number.isFinite) && g.C[3] === 1 && g.A[2] > g.A[1] && g.A[3] > g.A[2], `${kind}: glass`);
  }
});

test('a cabin is a function of the kind and the paint, and all three wheels build', () => {
  const seen = new Set(), seats = new Set();
  for (let c = 0; c < 300; c++) {
    const v = cabinVariant('octavia', 0x101010 + c * 977);
    assert.deepEqual(v, cabinVariant('octavia', 0x101010 + c * 977));
    assert.ok(v.wheel >= 0 && v.wheel < WHEELS && v.seat >= 0 && v.seat < SEATS.length);
    seen.add(v.wheel); seats.add(v.seat);
  }
  assert.equal(seen.size, WHEELS, 'not every wheel is ever drawn');
  assert.ok(seats.size >= SEATS.length - 1, 'the upholstery barely varies');
  for (let t = 0; t < WHEELS; t++) {
    const w = wheelParts(t, 0.18);
    assert.ok(w.rim.length >= 1 && w.pad.length >= 1);
    for (const g of [...w.rim, ...w.pad])
      for (const x of g.attributes.position.array) assert.ok(Number.isFinite(x));
  }
});

// ---- 3. the player on a flat world ---------------------------------------------

function stage({ wall = null, cars = [] } = {}) {
  const world = {
    carHulls: () => cars,
    supportY: () => 0,
    heightAt: () => 0,
    collide(pos, r, o) {
      let pushed = false;
      for (const c of cars) {
        const fx = -Math.sin(c.heading), fz = -Math.cos(c.heading);
        const rr = c.wid * 0.55 + r, back = c.len / 2 - c.wid * 0.55;
        for (const s of [-back, back]) {
          const ex = pos.x - (c.x + fx * s), ez = pos.z - (c.z + fz * s), d = Math.hypot(ex, ez);
          if (d >= rr || d < 1e-6) continue;
          pos.x = c.x + fx * s + ex / d * rr; pos.z = c.z + fz * s + ez / d * rr; pushed = true;
        }
      }
      // wall: a slab across z = wall.z, from the ground to wall.h
      if (wall && (o?.yLo ?? 0) < wall.h && Math.abs(pos.z - wall.z) < 0.15 + r) {
        pos.z = wall.z + (pos.z >= wall.z ? 1 : -1) * (0.15 + r); pushed = true;
      }
      return pushed;
    },
  };
  const scene = new THREE.Scene();
  const input = { moveX: 0, moveZ: 0, keys: new Set() };
  const player = new Player(scene, 0, 0, 0, 'test:1');
  const step = (n = 1) => { for (let i = 0; i < n; i++) player.update(1 / 60, { input, camYaw: 0, world }); };
  return { world, scene, input, player, step };
}

test('Space jumps: about seven tenths of a metre, half a second, and it costs no health', () => {
  vitals.reset();
  const S = stage();
  S.step(5);
  S.input.keys.add('Space');
  S.step(1);
  S.input.keys.delete('Space');
  assert.equal(S.player.grounded, false);
  let top = 0, n = 0;
  const hp0 = vitals.hp();
  while (!S.player.grounded && n < 200) {
    S.step(1); n++;
    vitals.update(1 / 60, { onFoot: true, car: null, player: S.player });
    top = Math.max(top, S.player.y);
  }
  assert.ok(top > 0.55 && top < 0.9, `apex ${top}`);
  assert.ok(n > 24 && n < 40, `air time ${n} steps`);
  assert.ok(Math.abs(top - JUMP_V * JUMP_V / 42) < 0.08, 'the apex is the gravity the walker already had');
  assert.equal(vitals.hp(), hp0);
  // held down, Space is one jump, not a pogo stick
  S.input.keys.add('Space');
  S.step(60);
  let jumps = 0, was = true;
  for (let i = 0; i < 240; i++) { S.step(1); if (was && !S.player.grounded) jumps++; was = S.player.grounded; }
  assert.equal(jumps, 0, 'a held key kept jumping');
});

test('a running jump carries: five metres at a run', () => {
  const S = stage();
  S.input.moveZ = -1; S.input.keys.add('ShiftLeft');
  S.step(90);
  const z0 = S.player.pos.z;
  S.input.keys.add('Space'); S.step(1); S.input.keys.delete('Space');
  let n = 0;
  while (!S.player.grounded && n++ < 200) S.step(1);
  const d = Math.abs(S.player.pos.z - z0);
  assert.ok(d > 2.2 && d < 4.5, `carried ${d} m`);
});

test('a low wall is vaulted, a high one is not, and open ground is just a jump', () => {
  const low = stage({ wall: { z: -0.8, h: 0.95 } });
  const v = findVault(low.player, low.world);
  assert.ok(v && v.tz < -1.2 && v.dist < 3.7, 'no way over a hip-high wall');
  { const high = stage({ wall: { z: -0.8, h: 2.4 } }); assert.equal(findVault(high.player, high.world), null); }
  { const open = stage(); assert.equal(findVault(open.player, open.world), null); }
  // and the move itself lands on the far side, on the ground, upright
  low.input.keys.add('Space'); low.step(1); low.input.keys.delete('Space');
  assert.ok(low.player.vault, 'Space did not start the vault');
  let peak = 0;
  for (let i = 0; i < 120 && low.player.vault; i++) { low.step(1); peak = Math.max(peak, low.player.y); }
  assert.equal(low.player.vault, null);
  assert.ok(low.player.pos.z < -1.2 && Math.abs(low.player.y) < 1e-6, `landed at z ${low.player.pos.z}, y ${low.player.y}`);
  assert.ok(peak > 0.3 && peak < 0.9, `the feet rode ${peak} m up`);
});

test('a bonnet is something to vault, a cabin is not', () => {
  const car = { kind: 'octavia', x: 0, z: 0, y: 0, heading: 0, len: 4.7, wid: 1.81 };
  // facing +x across the bonnet (nose at -z), from the driver's side
  const at = (z) => {
    const S = stage({ cars: [car] });
    S.player.pos.x = -1.5; S.player.pos.z = z; S.player.heading = -Math.PI / 2;
    return findVault(S.player, S.world);
  };
  const over = at(-1.6);
  assert.ok(over && over.tx > 1.2 && Math.abs(over.top - 0.95) < 1e-6, 'no way over the bonnet');
  assert.equal(at(0.3), null, 'vaulted the roof');
});

// ---- 4. getting up ----------------------------------------------------------------

test('getting up starts flat and ends standing, both ways up, without a jump in between', () => {
  for (const faceUp of [false, true]) {
    const a = riseCurve(0, faceUp), z = riseCurve(1, faceUp);
    assert.ok(Math.abs(Math.abs(a.pitch) - Math.PI / 2) < 1e-9 && a.h === 0);
    assert.equal(Math.sign(a.pitch), faceUp ? 1 : -1);
    assert.ok(Math.abs(z.pitch) < 1e-9 && Math.abs(z.h - 1) < 1e-9);
    let prev = a;
    for (let i = 1; i <= 200; i++) {
      const c = riseCurve(i / 200, faceUp);
      assert.ok(Math.abs(c.pitch - prev.pitch) < 0.08 && Math.abs(c.h - prev.h) < 0.03, `step at ${i / 200}`);
      assert.ok(c.h >= -1e-9 && c.h <= 1 + 1e-9);
      prev = { ...c };
    }
  }
  assert.ok(RISE_PRONE > 1.2 && RISE_SUPINE > 1.2, 'that is not getting up, that is levitating');
});

test('a body thrown down lies, gets up over more than a second, and is itself again', () => {
  const S = stage();
  assert.ok(S.player.tumble(0, -4, 2.5));
  let rise = 0, n = 0;
  while (S.player.ragdoll && n++ < 60 * 12) {
    if (S.player.ragdoll.phase === 'rise') {
      rise++;
      for (const j of Object.values(S.player._cit.parts)) if (j.rotation) assert.ok(Number.isFinite(j.rotation.x + j.rotation.y + j.rotation.z));
    }
    S.step(1);
  }
  assert.equal(S.player.ragdoll, null, 'never got up');
  assert.ok(rise / 60 > 1.2, `up in ${rise / 60} s`);
  assert.ok(Math.abs(S.player.y) < 1e-6 && S.player.grounded);
  assert.equal(S.player.mesh.rotation.x, 0);
  // rolled right over is face up or face down with the head the other way
  const st = { phase: 'lie', t: 5, pitch: -Math.PI / 2, roll: Math.PI, yaw: 0.4, gy: 0, hip: 0.83, y: 0.16 };
  stepBody(st, 1 / 60, S.world, null);
  assert.equal(st.phase, 'rise'); assert.equal(st.roll, 0); assert.equal(st.faceUp, false);
});

// ---- 5. pulling the driver out ------------------------------------------------------

test('a witness is a person or a lit window within a hundred metres', () => {
  const city = { chunkIndex: new Map([['0,0', { buildings: [{ o: [[40, 40], [50, 40], [50, 50]] }] }]]) };
  assert.equal(witnessed(10, 10, { city, night: 0 }), null, 'a dark window saw it by day');
  assert.equal(witnessed(10, 10, { city, night: 0.8 }), 'window');
  assert.equal(witnessed(-400, -400, { city, night: 0.8 }), null);
  const peds = { nearest: (x, z, r) => (Math.hypot(x - 60, z) < r ? { dead: false } : null) };
  assert.equal(witnessed(0, 0, { peds }), 'person');
  assert.equal(witnessed(0, 0, { cars: [{ x: 30, z: 0, ai: {} }] }), 'person');
  assert.equal(witnessed(0, 0, { cars: [{ x: 30, z: 0, ai: null }, { x: WITNESS_R + 5, z: 0, ai: {} }] }), null);
  // and seen is two stars on the spot
  wanted.reset();
  wanted.add('prepadeni');
  assert.equal(wanted.stars(), 2);
  wanted.reset();
});

test('the driver lands beside the car, gets up and runs off', () => {
  const made = [];
  const body = () => {
    const parts = {};
    for (const k of ['body', 'torso', 'chest', 'head', 'pelvis', 'armL', 'armR', 'legL', 'legR', 'elbowL', 'elbowR',
      'kneeL', 'kneeR', 'footL', 'footR']) parts[k] = { rotation: { x: 0, y: 0, z: 0 }, position: { x: 0, y: 0, z: 0 } };
    const b = { group: new THREE.Group(), parts, gone: false, ragdollPose() {}, standPose() {}, walk() {}, dispose() { this.gone = true; } };
    made.push(b);
    return b;
  };
  const J = new Carjack({ scene: new THREE.Scene(), world: { supportY: () => 0, heightAt: () => 0 }, makeBody: body });
  const car = { x: 0, z: 0, y: 0, heading: 0, wid: 1.8, len: 4.6 };
  const r = J.throwOut(car, -1, { x: -0.6, y: 0.45, z: 0.1 });
  let n = 0;
  while (r.phase !== 'run' && n++ < 60 * 12) J.update(1 / 60, 0, 0);
  assert.equal(r.phase, 'run', 'never got up');
  assert.ok(r.x < -1.2 && r.x > -7, `landed at x ${r.x}: not out of the driver's door`);
  const d0 = Math.hypot(r.x, r.z);
  for (let i = 0; i < 180; i++) J.update(1 / 60, 0, 0);
  assert.ok(Math.hypot(r.x, r.z) > d0 + 6, 'did not run from the player');
  for (let i = 0; i < 60 * 20 && J.out.length; i++) J.update(1 / 60, 0, 0);
  assert.equal(J.out.length, 0);
  assert.ok(made[0].gone, 'the body was never given back');
});
