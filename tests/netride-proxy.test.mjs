// ---- riding along in a peer's car: the proxy, and a real body getting into it ----
// The pure rules are tests/netride.test.mjs. Here the real classes meet: the
// ghost fleet (js/netvehicles.js) fed wire packets by hand, the real Player
// (js/player.js) with its boarding state machine and the real door
// (js/carentry.js, js/cardoor.js), and js/netride.js between them. No server.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const ctx2d = new Proxy({}, {
  get: (_, k) => k === 'measureText' ? () => ({ width: 200 })
    : k === 'createLinearGradient' || k === 'createRadialGradient'
      ? () => ({ addColorStop() {} })
      : k === 'getImageData' ? (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) })
        : k === 'canvas' ? { width: 1, height: 1 } : () => {},
  set: () => true,
});
globalThis.document ??= { createElement: () => ({ width: 1, height: 1, style: {},
  getContext: () => ctx2d, toDataURL: () => '' }) };
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {} };
// just enough of a socket for connectCity() to resolve (as tests/coop-wire.test.mjs)
globalThis.WebSocket = class {
  constructor() {
    this.readyState = 1;
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({ t: 'welcome', code: 'PARDUBICE', uid: 'bob:02',
        role: 'authority', peers: [], now: Date.now() }) });
    }, 0);
  }
  send() {}
  close() {}
};

const THREE = await import('three');
const { makeGhostCars } = await import('../js/netvehicles.js');
const { Player } = await import('../js/player.js');
const { makeRides, seatsOf } = await import('../js/netride.js');
const { connectCity } = await import('../js/netcity.js');
const { kindOf } = await import('../js/vehicles.js');

const net = await connectCity('Tester');
test.after(() => { try { net.dispose(); } catch {} });

const DRIVER = 'anna:01', ME = 'bob:02', THIRD = 'cyril:03';
const DT = 1 / 60;
const world = {
  heightAt: () => 0, surfaceY: () => ({ y: 0 }), supportY: () => 0,
  collide: () => false, carHulls: () => [],
};
const input = { moveX: 0, moveZ: 0, keys: new Set() };

const drive = (x, z, h = 0, sp = 0, kd = 'octavia', cl = 0x224466) =>
  ({ k: 'car', kd, cl, x, z, h, sp, st: 0 });

function rig() {
  const scene = new THREE.Scene();
  const ghosts = makeGhostCars(scene);
  ghosts.world = world;
  ghosts.selfUid = ME;
  return { scene, ghosts };
}

// a driver going straight along his heading at `sp`, a packet every 100 ms
function makeDriver(ghosts, uid, x, z, h, sp, kd = 'octavia') {
  const d = { x, z, h, sp, t: 0 };
  d.step = (dt) => {
    d.x += -Math.sin(d.h) * d.sp * dt; d.z += -Math.cos(d.h) * d.sp * dt;
    d.t += dt;
    if (d.t >= 0.1 - 1e-9) { d.t -= 0.1; ghosts.sync(uid, drive(d.x, d.z, d.h, d.sp, kd)); }
  };
  ghosts.sync(uid, drive(x, z, h, sp, kd));
  ghosts.update(DT);
  return d;
}

// ---- the proxy -------------------------------------------------------------------
test('a car somebody drives has a boardable face, shaped like a vehicle', () => {
  const { ghosts } = rig();
  ghosts.sync(DRIVER, drive(10, 20, 0.4, 0, 'tesla'));
  ghosts.update(DT);
  const v = ghosts.proxyOf(DRIVER);
  assert.ok(v, 'a driven car has no proxy');
  assert.equal(v.proxy, true);
  assert.equal(v.uid, DRIVER);
  assert.equal(v.kind, 'tesla');
  assert.equal(v.len, kindOf('tesla').len);
  assert.equal(v.wid, kindOf('tesla').wid);
  assert.ok(Math.abs(v.x - 10) < 1e-6 && Math.abs(v.z - 20) < 1e-6 && Math.abs(v.heading - 0.4) < 1e-6);
  assert.ok(v.mesh?.parent, 'its mesh is not in the scene');
  assert.ok(v.mesh.userData.carState, 'a door cannot be cut into it');
  assert.deepEqual(v.seats, []);
  assert.deepEqual(ghosts.proxies(), [v]);
  // the same object for as long as it is the same car
  for (let i = 0; i < 20; i++) { ghosts.sync(DRIVER, drive(10 + i, 20, 0.4, 10, 'tesla')); ghosts.update(DT); }
  assert.equal(ghosts.proxyOf(DRIVER), v);
  assert.equal(v.gone, false);
});

test('only a DRIVEN car is boardable: not a helicopter, not a passenger\'s own copy', () => {
  const { ghosts } = rig();
  ghosts.sync('pilot:09', { k: 'heli', x: 0, z: 0, y: 30, h: 0, sp: 0, st: 0 });
  ghosts.sync('lost:08', { k: 'car', kd: 'fabia', cl: 1, x: 500, z: 500, h: 0, sp: 0, st: 1 });
  ghosts.update(DT);
  assert.equal(ghosts.proxyOf('pilot:09'), null);
  assert.equal(ghosts.proxyOf('lost:08'), null, 'a passenger with no host on screen became somebody to ride with');
  assert.deepEqual(ghosts.proxies(), []);
});

test('the proxy is gone the moment it stops being that car', () => {
  const { ghosts } = rig();
  // the driver steps out (veh:null) / leaves the room (drop)
  ghosts.sync(DRIVER, drive(0, 0));
  const a = ghosts.proxyOf(DRIVER);
  ghosts.sync(DRIVER, null);
  assert.equal(a.gone, true);
  assert.equal(ghosts.proxyOf(DRIVER), null);
  assert.ok(!a.mesh?.parent, 'a gone car is still drawn');
  // …is suddenly in a different kind of car
  ghosts.sync(DRIVER, drive(0, 0, 0, 0, 'octavia'));
  const b = ghosts.proxyOf(DRIVER);
  for (let i = 0; i < 20; i++) ghosts.update(0.1);         // past the respray throttle
  ghosts.sync(DRIVER, drive(0, 0, 0, 0, 'bus'));
  assert.equal(b.gone, true);
  const c = ghosts.proxyOf(DRIVER);
  assert.ok(c && c !== b && c.kind === 'bus' && c.len === kindOf('bus').len);
  // …or turns passenger
  ghosts.sync(DRIVER, { ...drive(0, 0, 0, 0, 'bus'), st: 1 });
  assert.equal(c.gone, true);
  assert.equal(ghosts.proxyOf(DRIVER), null);
});

test('a respray waits while somebody local is aboard; the body rides in that mesh', () => {
  const { ghosts } = rig();
  ghosts.sync(DRIVER, drive(0, 0, 0, 0, 'octavia', 0x224466));
  const v = ghosts.proxyOf(DRIVER), mesh = v.mesh;
  v.seats[1] = { rider: true };
  for (let i = 0; i < 20; i++) ghosts.update(0.1);         // past the respray throttle
  ghosts.sync(DRIVER, drive(0, 0, 0, 0, 'octavia', 0xcc2020));
  assert.equal(v.mesh, mesh, 'the car was rebuilt under its passenger');
  assert.equal(v.gone, false);
  v.seats[1] = null;
  ghosts.sync(DRIVER, drive(0, 0, 0, 0, 'octavia', 0xcc2020));
  assert.notEqual(v.mesh, mesh, 'the new paint never arrived');
  assert.equal(ghosts.proxyOf(DRIVER), v, 'the same car became a different object');
  assert.ok(v.mesh.parent);
});

test('a driver whose packets stop is standing still: speed 0, and the silence is counted', () => {
  const { ghosts } = rig();
  ghosts.sync(DRIVER, drive(0, 0, 0, 20));
  ghosts.update(0.05);
  const v = ghosts.proxyOf(DRIVER);
  assert.equal(v.speed, 20);
  for (let i = 0; i < 400; i++) ghosts.update(DT);
  assert.equal(v.speed, 0, 'a frozen peer still reads as doing 72 km/h');
  assert.ok(v.quiet > 6);
  // one new packet and he is back
  ghosts.sync(DRIVER, drive(0, -1, 0, 5));
  ghosts.update(DT);
  assert.ok(v.quiet < 0.1 && v.speed === 5);
});

// ---- naming the host -------------------------------------------------------------
test('a passenger who names his driver sits in THAT car, however far behind his packet is', () => {
  const { scene, ghosts } = rig();
  ghosts.sync(DRIVER, drive(0, 0, 0, 25));
  ghosts.update(DT);
  // his own picture of the driver's car is 12 m behind ours (90 km/h, a packet and an ease)
  ghosts.sync(THIRD, { k: 'car', kd: 'octavia', cl: 0x224466, x: 0, z: 12, h: 0, sp: 25, st: 1, ho: DRIVER });
  ghosts.update(DT);
  assert.equal(scene.children.filter((o) => o.userData.ghost).length, 1, 'the passenger got a second car of his own');
  const drv = ghosts.seatAnchor(DRIVER, 0), pas = ghosts.seatAnchor(THIRD, 1);
  assert.ok(pas, 'no seat for the passenger');
  assert.ok(Math.abs(pas.z - drv.z) < 0.01 && Math.abs(pas.x + drv.x - 2 * ghosts.pose(DRIVER).x) < 0.01,
    'he is not in the seat beside the driver');
  // without the name the same packet is too far to be believed, as before
  ghosts.sync('old:07', { k: 'car', kd: 'octavia', cl: 0x224466, x: 0, z: 12, h: 0, sp: 25, st: 1 });
  assert.equal(scene.children.filter((o) => o.userData.ghost).length, 2);
});

test('a passenger who names US is seated in the car we drive', () => {
  const { scene, ghosts } = rig();
  const mine = { kind: 'octavia', x: 100, z: 100, heading: 1.0, y: 0,
    mesh: { parent: {}, visible: true, position: { y: 0 } } };
  ghosts.localVehicles = () => [mine];
  ghosts.sync(THIRD, { k: 'car', kd: 'octavia', cl: 1, x: 100, z: 111, h: 1.0, sp: 25, st: 1, ho: ME });
  assert.equal(scene.children.filter((o) => o.userData.ghost).length, 0, 'our passenger was wrapped in a second car');
  const a = ghosts.seatAnchor(THIRD, 1);
  assert.ok(a && Math.hypot(a.x - 100, a.z - 100) < 1.5, 'seat anchor ' + JSON.stringify(a));
  // we step out: no car of ours to sit in, so he falls back to guessing and gets his own
  ghosts.localVehicles = () => [];
  ghosts.sync(THIRD, { k: 'car', kd: 'octavia', cl: 1, x: 100, z: 111, h: 1.0, sp: 0, st: 1, ho: ME });
  assert.equal(scene.children.filter((o) => o.userData.ghost).length, 1);
});

test('hostOf: which car a peer sits in on this screen, for the glass', () => {
  const { ghosts } = rig();
  const mine = { kind: 'octavia', x: 100, z: 100, heading: 0, y: 0,
    mesh: { parent: {}, visible: true, position: { y: 0 }, userData: {} } };
  ghosts.localVehicles = () => [mine];
  ghosts.sync(DRIVER, drive(0, 0));
  ghosts.update(DT);
  // the driver: their own proxy, seat 0
  const d = ghosts.hostOf(DRIVER);
  assert.ok(d && d.seat === 0 && d.car.mesh === ghosts.proxyOf(DRIVER).mesh);
  // a passenger of that driver: the same mesh, seat 1
  ghosts.sync(THIRD, { k: 'car', kd: 'octavia', cl: 1, x: 0, z: 9, h: 0, sp: 0, st: 1, ho: DRIVER });
  const p = ghosts.hostOf(THIRD);
  assert.ok(p && p.seat === 1 && p.car.mesh === ghosts.proxyOf(DRIVER).mesh);
  // a passenger of OURS: our car
  ghosts.sync('dana:04', { k: 'car', kd: 'octavia', cl: 1, x: 100, z: 108, h: 0, sp: 0, st: 1, ho: ME });
  assert.equal(ghosts.hostOf('dana:04').car, mine);
  // on foot, unknown, or in a helicopter: no car
  ghosts.sync(THIRD, null);
  assert.equal(ghosts.hostOf(THIRD), null);
  assert.equal(ghosts.hostOf('nobody:00'), null);
  ghosts.sync('pilot:09', { k: 'heli', x: 0, z: 0, y: 30, h: 0, sp: 0, st: 0 });
  assert.equal(ghosts.hostOf('pilot:09'), null);
});

test('the name is parsed like everything else off the wire', () => {
  const { scene, ghosts } = rig();
  ghosts.sync(DRIVER, drive(0, 0));
  for (const ho of [123, {}, '', 'x'.repeat(500), THIRD /* himself */, 'nobody:00'])
    assert.doesNotThrow(() => ghosts.sync(THIRD, { k: 'car', kd: 'octavia', cl: 1, x: 300, z: 300, h: 0, sp: 0, st: 1, ho }));
  ghosts.update(DT);
  // none of those named the driver, and 300 m is nobody's passenger seat
  assert.equal(scene.children.filter((o) => o.userData.ghost).length, 2);
});

// ---- the wire: what a passenger tells the room ------------------------------------
test('a passenger in a peer\'s car names the driver; a driver and a local car name nobody', () => {
  const proxy = { proxy: true, uid: DRIVER, kind: 'tesla', color: 0x112233, look: 3, x: 5, z: 6, heading: 1, speed: 12 };
  const p = { pos: { x: 5, z: 6 }, heading: 1, y: 0, inCar: proxy, seat: 1 };
  const d = net._vehDesc({ player: p, trains: null });
  assert.equal(d.ho, DRIVER);
  assert.equal(d.st, 1);
  assert.equal(d.kd, 'tesla');
  assert.equal(d.sp, 12);
  assert.ok(!('ho' in net._vehDesc({ player: { ...p, inCar: { kind: 'tesla', x: 0, z: 0, heading: 0, speed: 0 }, seat: 1 }, trains: null })));
  assert.ok(!('ho' in net._vehDesc({ player: { ...p, inCar: { kind: 'tesla', x: 0, z: 0, heading: 0, speed: 0 }, seat: 0 }, trains: null })));
});

// ---- a real body, a moving car ------------------------------------------------------
// The whole of it, as main.js wires it: E → boardVehicle on the proxy, the walk
// round the body, the door, the seat, the ride, E again, and the car vanishing.
function session(kd = 'octavia', sp = 0) {
  const { scene, ghosts } = rig();
  const drv = makeDriver(ghosts, DRIVER, 0, 0, 0, sp, kd);
  const car = ghosts.proxyOf(DRIVER);
  // on the DRIVER'S side, three metres off the flank: the passenger door is round the car
  const player = new Player(scene, -3.2, 0.4, 0, ME);
  const sent = [], left = [];
  const rides = makeRides({
    player, self: () => ME,
    send: (type, data) => sent.push({ type, ...data }),
    leave: (why, uid) => {                                 // main.js leavePeerCar, without the HUD
      left.push([why, uid]);
      if (player.boarding) player.cancelBoarding();
      else if (player.inCar) player.beginExit();
    },
  });
  // one frame, in stepGame's order: the body, then the proxies, then the ride
  const frame = () => {
    drv.step(DT);
    player.update(DT, { input, camYaw: 0, world });
    ghosts.update(DT);
    rides.update(DT);
  };
  const run = (secs, until) => {
    for (let i = 0; i < Math.round(secs * 60); i++) { frame(); if (until?.()) return true; }
    return !until;
  };
  return { scene, ghosts, drv, car, player, rides, sent, left, frame, run };
}

const inside = (obj, root) => { for (let o = obj; o; o = o.parent) if (o === root) return true; return false; };

for (const [kd, creep] of [['octavia', 0], ['octavia', 1.5], ['tesla', 0], ['roadster', 1.5], ['van', 0], ['bus', 0]]) {
  test(`into the passenger seat of a ${kd} somebody drives${creep ? ` while it creeps at ${creep} m/s` : ''}`, () => {
    const s = session(kd, creep);
    const seat = s.rides.seatFor(s.car);
    assert.equal(seat, 1);
    const events = [];
    assert.equal(s.player.boardVehicle(s.car, seat, {
      onDoor: () => events.push('door'), onSeated: (n) => events.push('seated' + n),
      onLocked: () => events.push('LOCKED'), onJack: () => events.push('JACK'),
    }), true);
    assert.ok(s.run(25, () => s.player.inCar === s.car),
      'never got in: phase ' + s.player.boarding?.phase + ', left ' + JSON.stringify(s.left));
    assert.equal(s.player.seat, 1);
    assert.deepEqual(events, ['door', 'seated1'], 'the door was locked, or somebody was hauled out');
    assert.ok(inside(s.player.mesh, s.car.mesh), 'the body does not ride in the car');
    assert.equal(s.left.length, 0);
    assert.deepEqual(s.sent, [{ type: 'seat_claim', ho: DRIVER, s: 1, on: 1 }]);
    // the driver still has his car to himself as far as the wheel goes
    assert.ok(!s.car.seats[0], 'the passenger is written into the driver\'s seat');
  });
}

test('a two-seater with its passenger seat taken is full, and says who has it', () => {
  const s = session('roadster');
  s.rides.observe(THIRD, { k: 'car', st: 1, ho: DRIVER });
  assert.equal(s.rides.seatFor(s.car), -1);
  assert.equal(seatsOf('roadster'), 2);
});

test('the ride: the body, the camera target and the car are one thing, at any speed', () => {
  const s = session('octavia', 0);
  s.player.boardVehicle(s.car, 1, {});
  assert.ok(s.run(25, () => s.player.inCar === s.car));
  // away he goes: 0 → 30 m/s over four seconds, then a steady 108 km/h
  let worstGap = 0, worstJerk = 0, prevV = null;
  let px = s.player.pos.x, pz = s.player.pos.z;
  for (let i = 0; i < 12 * 60; i++) {
    s.drv.sp = Math.min(30, s.drv.sp + 7.5 * DT);
    s.frame();
    worstGap = Math.max(worstGap, Math.hypot(s.player.pos.x - s.car.x, s.player.pos.z - s.car.z));
    const v = Math.hypot(s.player.pos.x - px, s.player.pos.z - pz) / DT;
    if (prevV !== null && i > 30) worstJerk = Math.max(worstJerk, Math.abs(v - prevV));
    prevV = v; px = s.player.pos.x; pz = s.player.pos.z;
  }
  assert.equal(s.player.inCar, s.car, 'he fell out on the way');
  assert.ok(worstGap < 1e-9, 'the camera target is ' + worstGap.toFixed(3) + ' m off the car');
  // the eye's speed never steps by more than a brisk acceleration allows in a frame
  assert.ok(worstJerk < 0.6, 'the view jerked by ' + worstJerk.toFixed(2) + ' m/s in one frame');
  // and he is where the driver is, not a car length behind
  const lag = Math.hypot(s.car.x - s.drv.x, s.car.z - s.drv.z);
  assert.ok(lag < 1.0, 'the passenger rides ' + lag.toFixed(2) + ' m behind his driver');
  assert.ok(Math.abs(s.player.speed - 30) < 0.01);
});

test('packets that land early and late do not shake the passenger', () => {
  // the same steady 25 m/s, but each packet is delivered up to 30 ms off its beat
  const run = (ridden) => {
    const { ghosts } = rig();
    ghosts.sync(DRIVER, drive(0, 0, 0, 25));
    ghosts.update(DT);
    const car = ghosts.proxyOf(DRIVER);
    if (ridden) car.seats[1] = { rider: true };
    let seed = 7, t = 0, next = 0.1, worst = 0, prev = null, lx = car.x, lz = car.z;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 20 * 60; i++) {
      t += DT;
      if (t >= next) {
        // the position is as of the packet's own beat; only its ARRIVAL is off
        const beat = Math.round(next * 10) / 10;
        ghosts.sync(DRIVER, drive(0, -25 * beat, 0, 25));
        next = beat + 0.1 + (rnd() - 0.5) * 0.06;
      }
      ghosts.update(DT);
      const v = Math.hypot(car.x - lx, car.z - lz) / DT;
      if (prev !== null && i > 120) worst = Math.max(worst, Math.abs(v - prev));
      prev = v; lx = car.x; lz = car.z;
    }
    return worst;
  };
  const plain = run(false), ridden = run(true);
  assert.ok(ridden < 1.0, 'a ridden car\'s speed stepped by ' + ridden.toFixed(2) + ' m/s in a frame');
  assert.ok(ridden < plain / 3, `the spring (${ridden.toFixed(2)}) is no steadier than the ease (${plain.toFixed(2)})`);
});

test('E again: out beside the car, on the ground, on his feet', () => {
  const s = session('octavia', 0);
  s.player.boardVehicle(s.car, 1, {});
  assert.ok(s.run(25, () => s.player.inCar === s.car));
  s.drv.sp = 12; s.run(3); s.drv.sp = 0; s.run(2);
  assert.equal(s.player.beginExit(), true);                // what main.js stepOutOfCar does
  assert.equal(s.player.inCar, null);
  assert.ok(s.run(5, () => !s.player.exiting && !s.player.doorAnim), 'never finished stepping out');
  assert.equal(s.player.mesh.parent, s.scene, 'the body is still parented to the car');
  assert.equal(s.player.y, 0);
  assert.equal(s.player.grounded, true);
  const d = Math.hypot(s.player.pos.x - s.car.x, s.player.pos.z - s.car.z);
  assert.ok(d > 0.9 && d < 3.5, 'he stands ' + d.toFixed(2) + ' m from the car');
  assert.ok(!s.car.seats[1], 'the seat is still his');
  assert.deepEqual(s.sent.map((e) => e.on), [1, 0], 'the room was not told the seat is free');
  assert.equal(s.left.length, 0);
});

test('the driver steps out from under a seated passenger: put down on the road, cleanly', () => {
  const s = session('octavia', 0);
  s.player.boardVehicle(s.car, 1, {});
  assert.ok(s.run(25, () => s.player.inCar === s.car));
  s.drv.sp = 15; s.run(4);
  const at = { x: s.car.x, z: s.car.z };
  s.drv.step = () => {};                                   // no more packets from him
  s.ghosts.sync(DRIVER, null);                             // veh:null: he is out of the car
  assert.ok(s.run(5, () => !s.player.inCar && !s.player.exiting), 'still stuck in a car that is gone');
  assert.deepEqual(s.left, [['gone', DRIVER]]);
  assert.equal(s.player.mesh.parent, s.scene, 'the body went with the car\'s mesh');
  assert.equal(s.player.y, 0, 'not on the ground');
  assert.equal(s.player.grounded, true);
  assert.equal(s.player.boarding, null);
  const d = Math.hypot(s.player.pos.x - at.x, s.player.pos.z - at.z);
  assert.ok(d < 4, 'he was put down ' + d.toFixed(1) + ' m from where the car was');
  assert.ok(Number.isFinite(s.player.pos.x) && Number.isFinite(s.player.pos.z));
  assert.deepEqual(s.sent.at(-1), { type: 'seat_claim', ho: DRIVER, s: 1, on: 0 });
  // and he walks: the stick moves him again
  input.moveZ = -1;
  const z0 = s.player.pos.z;
  s.run(1);
  input.moveZ = 0;
  assert.ok(Math.abs(s.player.pos.z - z0) > 2, 'the body is back on the street but does not walk');
});

test('the driver leaves the room during the walk-up: back to walking, no seat held', () => {
  const s = session('octavia', 0);
  s.player.boardVehicle(s.car, 1, {});
  s.run(0.4);
  assert.ok(s.player.boarding, 'fixture: the walk was over before it began');
  s.drv.step = () => {};
  s.ghosts.drop(DRIVER);
  s.run(0.2);
  assert.equal(s.player.boarding, null);
  assert.equal(s.player.inCar, null);
  assert.ok(!s.car.seats[1]);
  assert.deepEqual(s.left, [['gone', DRIVER]]);
  assert.deepEqual(s.sent.map((e) => e.on), [1, 0]);
});

test('the driver pulls away during the walk-up: the walker is not dragged after him', () => {
  const s = session('octavia', 0);
  s.player.boardVehicle(s.car, 1, {});
  s.run(0.3);
  assert.equal(s.player.boarding?.phase, 'walk');
  s.drv.sp = 14;
  assert.ok(s.run(3, () => !s.player.boarding), 'still chasing a car doing 50 km/h');
  assert.equal(s.player.inCar, null);
  assert.deepEqual(s.left, [['left', DRIVER]]);
  assert.equal(s.car.gone, false);
  assert.ok(!s.car.seats[1], 'the seat he gave up is still marked his');
});

test('the driver\'s packets just stop: the car stands, the passenger stays in until he chooses', () => {
  const s = session('octavia', 0);
  s.player.boardVehicle(s.car, 1, {});
  assert.ok(s.run(25, () => s.player.inCar === s.car));
  s.drv.sp = 20; s.run(3);
  s.drv.step = () => {};                                   // his tab froze
  s.run(2.5);
  const stood = { x: s.car.x, z: s.car.z };
  s.run(10);
  assert.equal(s.player.inCar, s.car, 'a lag spike threw him out');
  assert.ok(Math.hypot(s.car.x - stood.x, s.car.z - stood.z) < 0.05, 'the car drove on with nobody driving it');
  assert.equal(s.car.speed, 0);
  // he gets out on his own, into a car that is still there
  assert.equal(s.player.beginExit(), true);
  assert.ok(s.run(5, () => !s.player.exiting && !s.player.doorAnim));
  assert.equal(s.player.y, 0);
  // the fleet's own reap (35 s of silence) then takes the car away
  s.run(36);
  assert.equal(s.car.gone, true);
});
