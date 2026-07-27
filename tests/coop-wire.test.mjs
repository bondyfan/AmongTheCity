// ---- the co-op wire: what a peer is actually told about you ---------------
// These are not unit tests of a formula, they are the four ways the shipped
// build stopped being a shared world, each pinned at the exact line that let it
// happen. Every one of them was reproduced against the real classes before it
// was fixed — no stubs stand in for Player, Helicopter, Fighter or NetGame.
//
//   1. A HELICOPTER HAS NO `.speed`. helicopter.js carries vx/vy/vz and says in
//      a comment that a scalar would be a lie. player.js copied it blind, so
//      `player.speed` was undefined for the whole flight, and netcity's
//      `+p.speed.toFixed(2)` threw — from inside stepGame, i.e. before the
//      frame was rendered. Co-op froze on the last drawn frame, every frame,
//      for as long as you were airborne. This is the highest-severity bug the
//      review found and it is one line in two files.
//   2. A FIGHTER IS NOT A CAR. The duck test was `rotorSpeed !== undefined`, so
//      a Gripen went on the wire as k:'car' and every peer built a black
//      Octavia, snapped it to the road under an aircraft doing 600 km/h, and
//      fed it to the AI traffic as an obstacle.
//   3. AIRCRAFT MUST SEND `y`. A car derives altitude from the road; a flier
//      cannot, so without it the ghost — and the seat anchor built on it, and
//      the pilot's avatar hanging off that — sit at ground level.
//   4. A HELICOPTER'S `sp` WAS ALWAYS 0, which switches off the receiver's dead
//      reckoning entirely and leaves the ghost trailing its pilot.
//
// three.js resolves through the same hook the other tests use, so the real
// modules run; WebSocket is the only thing faked, and only enough to let
// connectCity() resolve.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

// identity.js reads storage through guarded accessors; give it something.
globalThis.localStorage ??= { getItem: () => null, setItem: () => {} };
globalThis.sessionStorage ??= { getItem: () => null, setItem: () => {} };

const outbound = [];
globalThis.WebSocket = class {
  constructor() {
    this.readyState = 1;
    setTimeout(() => {
      this.onopen?.();
      this.onmessage?.({ data: JSON.stringify({
        t: 'welcome', code: 'PARDUBICE', uid: 'me:aa', role: 'authority',
        peers: [], now: Date.now(),
      }) });
    }, 0);
  }
  send(s) { outbound.push(JSON.parse(s)); }
  close() {}
};

const { Player } = await import('../js/player.js');
const { Helicopter } = await import('../js/helicopter.js');
const { Fighter } = await import('../js/aircraft.js');
const { connectCity } = await import('../js/netcity.js');
const { makeGhostCars } = await import('../js/netvehicles.js');
const { localUid } = await import('../js/identity.js');
const THREE = await import('three');

const scene = { add() {}, remove() {} };
const world = { heightAt: () => 0, collide: (p) => p, surfaceY: () => ({ y: 0 }) };
const input = { moveX: 0, moveZ: 0, keys: new Set() };

const net = await connectCity('Tester');
const player = new Player(scene, 0, 0, 0, localUid());

// Sit in `veh`, fly/drive it for `secs`, then force one state packet out
// through the exact path stepGame uses. Returns that packet's `state`.
function rideAndSend(veh, secs, ctl) {
  player.inCar = veh; player.seat = 0; veh.seats = [player];
  for (let i = 0; i < Math.round(secs * 60); i++) {
    veh.update(1 / 60, ctl, world);
    player.update(1 / 60, { input, camYaw: 0, world });
  }
  outbound.length = 0;
  net._sendAt = -1e9;                      // defeat the 10 Hz gate
  net.update(1 / 60, { scene, player, game: {}, world, cars: [], peds: null });
  const pkt = outbound.filter((m) => m.t === 'state').pop();
  player.inCar = null;
  return pkt?.state ?? null;
}

const heli = new Helicopter(scene, 0, 0, 0);
const heliState = rideAndSend(heli, 8, { lift: 1, pitch: -0.5 });

test('a helicopter ride does not throw on the way to the wire', () => {
  assert.ok(heliState, 'no state packet was sent at all');
  assert.ok(Number.isFinite(heliState.s), 'player speed reached the wire as ' + heliState.s);
});

test('the helicopter goes on the wire as a helicopter, with its altitude', () => {
  assert.equal(heliState.veh.k, 'heli');
  assert.ok(heliState.veh.y > 5, 'y = ' + heliState.veh.y + ' — a flier at ground level');
});

test('a helicopter reports GROUND SPEED, not the 0 that kills dead reckoning', () => {
  const real = Math.hypot(heli.vx, heli.vz);
  assert.ok(real > 1, 'fixture never built up speed (' + real.toFixed(2) + ')');
  assert.ok(Math.abs(heliState.veh.sp - real) < 0.05,
    'sp = ' + heliState.veh.sp + ' vs |v| = ' + real.toFixed(2));
});

const jet = new Fighter(scene, 100, 100, 0);
const jetState = rideAndSend(jet, 40, { throttle: 1, pitch: 0.35 });

test('a Gripen is not advertised to the room as a car', () => {
  assert.equal(jetState.veh.k, 'jet', 'a fighter went out as k=' + jetState.veh.k);
  assert.ok(jetState.veh.y > 20, 'y = ' + jetState.veh.y);
});

test('the receiver refuses to approximate an aircraft it cannot draw', () => {
  const ghosts = makeGhostCars(null);
  ghosts.sync('pilot:aa', jetState.veh);
  assert.equal(ghosts.has('pilot:aa'), false,
    'a jet built a ghost — which is a phantom Octavia braking the AI traffic');
});

test('…but a ghost helicopter flies at the reported altitude', () => {
  // a real Scene: the Helicopter mesh holder adds itself to one, and without it
  // makeGhostCars keeps the record but never builds the machine
  const ghosts = makeGhostCars(new THREE.Scene());
  ghosts.world = world;
  ghosts.sync('pilot:aa', heliState.veh);
  ghosts.update(1 / 60);
  const p = ghosts.pose('pilot:aa');
  assert.ok(p && p.y > 5, 'ghost y = ' + p?.y);
  // and the seat the pilot's avatar hangs off is up there with it
  const a = ghosts.seatAnchor('pilot:aa', 0);
  assert.ok(a && a.y > 5, 'seat anchor y = ' + a?.y);
});

test('a rider always reports a finite speed, whatever they are riding', () => {
  for (const veh of [new Helicopter(scene, 0, 0, 0), new Fighter(scene, 0, 0, 0)]) {
    player.inCar = veh; player.seat = 0;
    player.update(1 / 60, { input, camYaw: 0, world });
    assert.ok(Number.isFinite(player.speed),
      veh.constructor.name + ' left player.speed = ' + player.speed);
    player.inCar = null;
  }
});

test.after(() => { try { net.dispose(); } catch {} });
