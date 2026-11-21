// ---- road law: the limit sign, speeding and red lights in front of the police
// Frank, 21 Nov 2026: the HUD shows the limit of the road, and police within
// 50 m give one star for driving more than 50 % over it, or through a red.
// js/roadlaw.js against a fake traffic graph and the real js/wanted.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as wanted from '../js/wanted.js';
import {
  RoadLaw, limitKmh, speeding, topUp, nearestLane, policeNear, STAR_CAP, WITNESS_R,
} from '../js/roadlaw.js';

// A street running north from (0, 0) to (0, −200): two directed edges, one each way.
function street(kmh = 50, w = 7) {
  const road = { w, t: 'secondary' };
  const n = { pts: [[0, 0], [0, -100], [0, -200]], speed: kmh / 3.6, road, len: 200, sig: null, sigStop: 0, sigPh: 0 };
  const s = { pts: [[0, -200], [0, -100], [0, 0]], speed: kmh / 3.6, road, len: 200, sig: null, sigStop: 0, sigPh: 0 };
  n.twin = s; s.twin = n;
  return { n, s };
}
function world(edges, { light = -1 } = {}) {
  return {
    patrols: new Set(),
    light,
    edgesNear(x, z, fn) { for (const e of edges) fn(e); },
    lightOf(e) { return e.sig ? this.light : -1; },
  };
}
// heading 0 faces −z (north), π faces +z
const car = (x, z, kmh, heading = 0) => ({ x, z, heading, speed: kmh / 3.6, vGround: kmh / 3.6 });
function drive(law, c, seconds, dt = 1 / 60) {
  for (let t = 0; t < seconds; t += dt) {
    const v = c.speed;
    c.x += -Math.sin(c.heading) * v * dt;
    c.z += -Math.cos(c.heading) * v * dt;
    law.update(dt, c);
    wanted.update(dt, {});
  }
}

test('the limit is the edge speed the AI drivers obey, in km/h', () => {
  assert.equal(limitKmh({ speed: 50 / 3.6 }), 50);
  assert.equal(limitKmh({ speed: 130 / 3.6 }), 130);
  assert.equal(limitKmh(null), 0);
});

test('more than 50 % OVER the limit: 75 in a 50 is not, 76 is', () => {
  assert.equal(speeding(75, 50), false);
  assert.equal(speeding(75.5, 50), true);
  assert.equal(speeding(134, 90), false);
  assert.equal(speeding(136, 90), true);
  assert.equal(speeding(200, 0), false, 'no known limit, no offence');
});

test('a traffic offence tops the heat up to one star and never past it', () => {
  assert.equal(topUp(0, 26), 26);
  assert.equal(topUp(25, 26), STAR_CAP - 25);
  assert.equal(topUp(STAR_CAP, 26), 0);
  assert.equal(topUp(60, 26), 0, 'already wanted for worse: nothing');
});

test('the lane is the edge pointing the way you face, not its twin', () => {
  const { n, s } = street();
  const out = {};
  assert.equal(nearestLane((x, z, fn) => { fn(n); fn(s); }, 1, -50, 0, -1, out).e, n);
  assert.equal(nearestLane((x, z, fn) => { fn(n); fn(s); }, 1, -50, 0, 1, out).e, s);
  assert.equal(nearestLane((x, z, fn) => { fn(n); fn(s); }, 30, -50, 0, -1, out), null, 'off the carriageway');
});

test('the sign shows the road you are on, and goes once you are off roads for a while', () => {
  const { n, s } = street(70);
  const law = new RoadLaw({ traffic: world([n, s]), wanted });
  const c = car(0, -20, 40);
  drive(law, c, 0.3);
  assert.equal(law.limit, 70);
  c.x = 300; c.speed = 0;
  drive(law, c, 4);
  assert.equal(law.limit, 0);
  law.update(1 / 60, null);
  assert.equal(law.limit, 0, 'on foot there is no sign');
});

test('speeding past a patrol 40 m away is one star; 60 m away, or 75 in a 50, is none', () => {
  wanted.reset();
  const { n, s } = street(50);
  const tr = world([n, s]);
  const law = new RoadLaw({ traffic: tr, wanted });
  tr.patrols.add({ x: 30, z: -70 });             // ~ off to the side as we pass
  const fast = car(0, -10, 75);
  drive(law, fast, 1.5);
  assert.equal(wanted.stars(), 0, 'exactly 50 % over is not more than 50 % over');
  const c = car(0, -10, 90);
  drive(law, c, 1.5);
  assert.equal(wanted.stars(), 1);
  assert.equal(wanted.lastCrime(), 'překročení rychlosti');

  wanted.reset();
  const tr2 = world([n, s]);
  tr2.patrols.add({ x: 60, z: -40 });
  const law2 = new RoadLaw({ traffic: tr2, wanted });
  drive(law2, car(0, -10, 90), 1.5);
  assert.equal(wanted.stars(), 0, 'the patrol is 60 m off: nobody saw it');
});

test('speeding on and on in front of the police stays one star', () => {
  wanted.reset();
  const { n, s } = street(50);
  const tr = world([n, s]);
  const police = { units: [], officers: { out: [] } };
  const law = new RoadLaw({ traffic: tr, police, wanted });
  const c = car(0, -10, 95);
  // an officer on foot keeps pace beside us the whole way
  police.officers.out.push({ x: 0, z: -10, state: 'chase' });
  for (let i = 0; i < 12; i++) {
    drive(law, c, 1);
    police.officers.out[0].x = 5; police.officers.out[0].z = c.z;
    if (c.z < -190) c.z = -10;
  }
  assert.equal(wanted.stars(), 1);
  assert.ok(wanted.heat() <= STAR_CAP + 1e-9);
});

test('a red light run with the police there is one star; on green, or unseen, none', () => {
  for (const [light, cops, want] of [[2, true, 1], [0, true, 0], [1, true, 0], [2, false, 0]]) {
    wanted.reset();
    const { n, s } = street(50);
    n.sig = { id: 1 }; n.sigStop = 195;
    const tr = world([n, s], { light });
    if (cops) tr.patrols.add({ x: 8, z: -205 });   // waiting on the far side of the junction
    const law = new RoadLaw({ traffic: tr, wanted });
    drive(law, car(0, -170, 40), 3);
    assert.equal(wanted.stars(), want, `light ${light}, police ${cops}`);
    if (want) assert.equal(wanted.lastCrime(), 'jízda na červenou');
  }
});

test('stopping at the red and going on green is no offence', () => {
  wanted.reset();
  const { n, s } = street(50);
  n.sig = { id: 1 }; n.sigStop = 195;
  const tr = world([n, s], { light: 2 });
  tr.patrols.add({ x: 8, z: -205 });
  const law = new RoadLaw({ traffic: tr, wanted });
  const c = car(0, -180, 30);
  drive(law, c, 0.9);                    // up to the line
  c.speed = 0; drive(law, c, 2);         // wait
  tr.light = 0; c.speed = 40 / 3.6; drive(law, c, 2);
  assert.equal(wanted.stars(), 0);
});

test('braking late and stopping with the nose on the paint is not running the red', () => {
  wanted.reset();
  const { n, s } = street(50);
  n.sig = { id: 1 }; n.sigStop = 195;
  const tr = world([n, s], { light: 2 });
  tr.patrols.add({ x: 8, z: -205 });
  const law = new RoadLaw({ traffic: tr, wanted });
  const c = car(0, -185, 20);
  drive(law, c, 2.1);                    // the middle ends up 1.7 m past the hold point
  assert.ok(-c.z > n.sigStop + 1.5 && -c.z < n.sigStop + 2.5);
  c.speed = 0; c.vGround = 0; drive(law, c, 3);
  assert.equal(wanted.stars(), 0);
});

test('police near: patrols, pursuit units and officers on foot, not the fallen', () => {
  assert.equal(WITNESS_R, 50);
  assert.equal(policeNear(0, 0, 50, { patrols: new Set([{ x: 49, z: 0 }]) }, null), true);
  assert.equal(policeNear(0, 0, 50, { patrols: new Set([{ x: 51, z: 0 }]) }, null), false);
  assert.equal(policeNear(0, 0, 50, null, { units: [{ car: { x: 0, z: 30 } }] }), true);
  assert.equal(policeNear(0, 0, 50, null, { officers: { out: [{ x: 3, z: 3, state: 'down' }] } }), false);
  assert.equal(policeNear(0, 0, 50, null, { officers: { out: [{ x: 3, z: 3, state: 'aim' }] } }), true);
});
