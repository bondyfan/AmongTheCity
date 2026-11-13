// ---- cyclists: a hand on the bar, a foot on the pedal -------------------------
// The bicycle (js/bikemodel.js) and the rider's pose (js/poses.js makeRidePose,
// js/gait.js makePedal) are solved against ONE record, the bike's `fit`. These
// tests put the real skeleton on the real numbers and measure where the wrists
// and the soles end up: if somebody moves a handlebar or changes a body, a
// rider holding thin air or pedalling beside the cranks fails here and not in
// front of a player.

import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));

const THREE = await import('three');
const { makeCitizen } = await import('../js/citizen.js');
const { makeRidePose } = await import('../js/poses.js');
const { makePedal } = await import('../js/gait.js');
const { BIKES, WHEEL_R, bikeGeometry, PAINTS, PAINTS_BRIGHT } = await import('../js/bikemodel.js');
const { BikeFleet } = await import('../js/bikefleet.js');

const ARCHS = ['m30', 'f30', 'f60', 'm60'];     // who rides (js/cyclists.js RIDERS)
const v = new THREE.Vector3();

function rider(arch) {
  const c = makeCitizen({ archetype: arch, style: { bag: null } });
  const k = (0 - c.parts.kneeL.position.y) / 0.415;
  return { c, k, ride: makeRidePose(c.parts), pedal: makePedal(c.parts) };
}

test('both hands are on the grips, on every bicycle, for every body', (t) => {
  let worst = 0;
  for (const arch of ARCHS) for (const B of BIKES) {
    const { c, k, ride } = rider(arch);
    ride(B.fit, 0, 0);
    c.group.updateMatrixWorld(true);
    for (const [hand, sx] of [[c.parts.handL, -1], [c.parts.handR, 1]]) {
      // the middle of the fist, 6.5 cm down the hand from the wrist
      hand.localToWorld(v.set(0, -0.065 * k, 0));
      const ex = sx * B.fit.gripX * k, ey = B.fit.gripY * k, ez = -B.fit.gripF * k;
      const d = Math.hypot(v.x - ex, v.y - ey, v.z - ez);
      worst = Math.max(worst, d / k);
      assert.ok(d < 0.04 * k, `${arch} on the ${B.key}: ${sx < 0 ? 'left' : 'right'} hand is ${(d * 100).toFixed(1)} cm off its grip`);
    }
    c.dispose();
  }
  t.diagnostic('worst hand: ' + (worst * 100).toFixed(1) + ' cm');
});

test('the hands follow the bar when it turns', () => {
  const { c, k, ride } = rider('m30');
  const B = BIKES[0];
  ride(B.fit, 0.4, 0);            // bars to the right: the left grip goes forward
  c.group.updateMatrixWorld(true);
  const zL = c.parts.handL.localToWorld(v.set(0, -0.065 * k, 0)).z;
  const zR = c.parts.handR.localToWorld(v.set(0, -0.065 * k, 0)).z;
  assert.ok(zL < zR - 0.12, 'left hand ahead of the right (the figure faces -z): ' + zL + ' ' + zR);
  c.dispose();
});

test('both feet stay on the pedals all the way round', () => {
  for (const arch of ARCHS) for (const B of BIKES) {
    const { c, k, ride, pedal } = rider(arch);
    ride(B.fit, 0, 0);
    let worst = 0, kneeMin = 9, kneeMax = 0;
    for (let i = 0; i < 24; i++) {
      const phi = i / 24 * Math.PI * 2;
      pedal(B.fit, phi, 0, 0);
      c.group.updateMatrixWorld(true);
      for (const [foot, sx, ph] of [[c.parts.footR, 1, phi], [c.parts.footL, -1, phi + Math.PI]]) {
        // the ball of the foot: under the ankle and forward of it
        foot.localToWorld(v.set(0, -0.085 * k, -0.125 * k));
        const cr = B.fit.crank * k;
        const ex = sx * B.fit.pedalX * k, ey = B.fit.bbY * k + cr * Math.cos(ph) + 0.012 * k, ez = -cr * Math.sin(ph);
        worst = Math.max(worst, Math.hypot(v.y - ey, v.z - ez), Math.abs(v.x - ex) - 0.03);
      }
      const bend = -c.parts.kneeR.rotation.x;
      kneeMin = Math.min(kneeMin, bend); kneeMax = Math.max(kneeMax, bend);
    }
    assert.ok(worst < 0.03 * k, `${arch} on the ${B.key}: a foot is ${(worst * 100).toFixed(1)} cm off its pedal`);
    // the saddle is the right height: the leg nearly straightens at the bottom
    // and the knee does not come up into the chest at the top
    assert.ok(kneeMin > 0.12 && kneeMin < 0.95, `${arch} on the ${B.key}: knee at the bottom of the stroke ${kneeMin.toFixed(2)} rad`);
    assert.ok(kneeMax < 2.2, `${arch} on the ${B.key}: knee at the top ${kneeMax.toFixed(2)} rad`);
    c.dispose();
  }
});

test('stopped: the left foot is on the road and the right one still on its pedal', () => {
  for (const arch of ARCHS) for (const B of BIKES) {
    const { c, k, ride, pedal } = rider(arch);
    const roll = -0.13;                    // leaning onto the standing foot (js/cyclistride.js STAND_ROLL)
    ride(B.fit, 0, 1);
    pedal(B.fit, 1.0, 1, roll);
    c.group.updateMatrixWorld(true);
    // the ball of the left foot, in the frame of the leaning bike: on the
    // plane the road makes there
    c.parts.footL.localToWorld(v.set(0, -0.085 * k, -0.125 * k));
    const ground = v.x * Math.tan(roll);
    assert.ok(v.x < -0.2 * k, 'out to the left of the frame: ' + v.x);
    assert.ok(Math.abs(v.y - ground) < 0.05 * k, `${arch} on the ${B.key}: the standing foot is ${((v.y - ground) * 100).toFixed(1)} cm off the road`);
    c.dispose();
  }
});

test('the pose is a fixed one: standing up afterwards leaves nothing behind', () => {
  const { c, ride, pedal } = rider('f30');
  const P = c.parts, before = {};
  c.standPose();
  for (const n in P) if (P[n].rotation) before[n] = [P[n].rotation.x, P[n].rotation.y, P[n].rotation.z, P[n].position.y];
  ride(BIKES[2].fit, 0.3, 0.5); pedal(BIKES[2].fit, 2, 0.5, -0.1);
  c.standPose();
  for (const n in before) {
    const r = P[n].rotation;
    assert.deepEqual([r.x, r.y, r.z, P[n].position.y].map((q) => +q.toFixed(6)), before[n].map((q) => +q.toFixed(6)), n);
  }
  c.dispose();
});

// ---- the machines ---------------------------------------------------------------

test('four bicycles: on their wheels, the saddle under the rider, nothing degenerate', () => {
  const g = bikeGeometry();
  assert.equal(g.frame.length, BIKES.length);
  for (let i = 0; i < BIKES.length; i++) {
    const B = BIKES[i];
    for (const part of [g.frame[i], g.front[i]]) {
      const a = part.attributes.position.array;
      for (let q = 0; q < a.length; q++) assert.ok(Number.isFinite(a[q]));
      assert.ok(part.attributes.paint && part.attributes.color && part.attributes.normal);
      assert.ok(part.userData.tris > 100 && part.userData.tris < 400, B.key + ' ' + part.userData.tris);
    }
    g.frame[i].computeBoundingBox();
    const bb = g.frame[i].boundingBox;
    assert.ok(bb.min.y > 0.03, B.key + ': nothing of the frame is under the road');
    assert.ok(Math.abs(bb.max.y - (B.fit.seatY - 0.065)) < 0.08 || bb.max.y < B.fit.seatY, B.key + ': the saddle is under the hips');
    assert.ok(B.frontF - B.rearF > 0.9 && B.frontF - B.rearF < 1.2, 'a wheelbase');
    assert.ok(B.fit.bbY - B.fit.crank > 0.08, B.key + ': the pedal clears the road at the bottom');
    assert.ok(B.wheelR > 0.3 && B.wheelR <= WHEEL_R + 1e-9);
  }
  assert.ok(g.wheel.userData.tris > 150 && g.wheelFar.userData.tris < 60, 'the distance wheel is a ring');
  for (const i of PAINTS_BRIGHT) assert.ok(PAINTS[i] !== undefined);
});

test('the fleet draws what it is given and nothing else', () => {
  const added = [];
  const fleet = new BikeFleet({ add: (m) => added.push(m), remove() {} }, 8);
  const b = { type: 0, x: 10, y: 221, z: -5, heading: 0.3, pitch: 0, roll: 0.1, steer: 0.2, spin: 1, crank: 2,
    scale: 0.9, paint: PAINTS[3], far: false, camD: 20, lit: true };
  fleet.begin(0);
  fleet.put(b); fleet.put({ ...b, type: 2, far: true });
  fleet.end();
  assert.equal(fleet.count, 2);
  assert.equal(fleet.frame[0].count, 1); assert.equal(fleet.frame[2].count, 1); assert.equal(fleet.frame[1].visible, false);
  assert.equal(fleet.wheel.count, 2, 'two spoked wheels for the near one');
  assert.equal(fleet.wheelFar.count, 2, 'two rings for the far one');
  assert.equal(fleet.crank.count, 1, 'no cranks past the distance line');
  assert.equal(fleet.lamp.count, 0, 'no lamps by day');
  // the rear wheel sits on the ground under the frame: its axle is a wheel radius up
  const m = new THREE.Matrix4();
  fleet.wheel.getMatrixAt(0, m);
  assert.ok(Math.abs(m.elements[13] - (221 + BIKES[0].wheelR * 0.9 * Math.cos(0.1))) < 0.02, 'axle height ' + m.elements[13]);
  // at night: a white lamp and a red one each, and a pool for the near one
  fleet.begin(1);
  fleet.put(b); fleet.put({ ...b, type: 2, far: true }); fleet.put({ ...b, lit: false });
  fleet.end();
  assert.equal(fleet.lamp.count, 4);
  assert.equal(fleet.pool.count, 1);
  const c = fleet.lamp.instanceColor.array;
  assert.ok(c[0] > 1 && c[2] > 1, 'white ahead'); assert.ok(c[3] > 1 && c[4] < 0.2, 'red behind');
  // a frame nobody put anything into draws nothing
  fleet.begin(1); fleet.end();
  assert.equal(fleet.count, 0);
  for (const mesh of added) assert.equal(mesh.visible, false);
  // more than it was sized for: the extra ones are not drawn, and nothing overflows
  fleet.begin(0);
  for (let i = 0; i < 12; i++) fleet.put(b);
  fleet.end();
  assert.equal(fleet.frame[0].count, 8);
  fleet.dispose();
});
