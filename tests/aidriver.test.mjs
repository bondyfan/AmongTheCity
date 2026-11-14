// ---- AI cars on real vehicle dynamics (js/aidriver.js, js/ailane.js) -------
// "Když auta NPC zatáčí, otočí se okamžitě. Musí mít tuhé tělo, normální
// fyziku, jako moje." What is pinned here:
//   1. the lane a driver steers for is continuous in position and direction,
//      through a single right-angle corner and through a zigzag of short
//      edges, and its corners are no tighter than the radius asked for allows
//   2. the controller's signs: the wheel turns the front axle back onto the
//      lane, the pedal never selects reverse, the far model never turns
//      tighter than the lock
//   3. a blow is a rigid-body impulse: a hit on the flank pushes the car
//      sideways and spins it; cars moving apart are left alone
//   4. on a grid town, every car near the player turns in an arc (no pivot)
//      and a car the player's car rams is shoved, spins, and then either
//      drives on or stays a wreck
// tests/aidrive-harness.mjs measures the same on the real town.
import test from 'node:test';
import assert from 'node:assert';
import { register } from 'node:module';

register(new URL('./three-alias.mjs', import.meta.url));
const { Traffic } = await import('../js/traffic.js');
const { laneAt, laneFoot, cornerAt, curveCap } = await import('../js/ailane.js');
const { AI, cornerR, stanley, pedalFor, kinStep, ramImpulse, lockAt } = await import('../js/aidriver.js');

// a route record the way traffic.js builds one: steps { e, base }
function edge(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const n = pts.length, L = cum[n - 1];
  const vertAng = new Float32Array(n);
  return { pts, cum, len: L, road: { w: 9 }, vertAng,
    fdx: (pts[1][0] - pts[0][0]) / cum[1], fdz: (pts[1][1] - pts[0][1]) / cum[1],
    ldx: (pts[n - 1][0] - pts[n - 2][0]) / (cum[n - 1] - cum[n - 2]), ldz: (pts[n - 1][1] - pts[n - 2][1]) / (cum[n - 1] - cum[n - 2]) };
}
function route(...polys) {
  const r = []; let base = 0;
  for (const p of polys) { const e = edge(p); r.push({ e, base }); base += e.len; }
  return r;
}
// north 60 m, then a right turn east 60 m (-z is north, +x east)
const corner = () => route([[0, 0], [0, -60]], [[0, -60], [60, -60]]);
// north, then a junction box drawn as three two-metre edges, then east
const zigzag = () => route([[0, 0], [0, -50]], [[0, -50], [-1.5, -51.5]], [[-1.5, -51.5], [0.5, -53]],
  [[0.5, -53], [2.5, -53.5]], [[2.5, -53.5], [60, -53.5]]);

function sweep(r, off, r0) {
  const end = r[r.length - 1].base + r[r.length - 1].e.len;
  const out = []; let i = 0, seg = 0;
  for (let a = 0; a <= end; a += 0.1) {
    const q = laneAt(r, i, seg, a, off, {}, r0);
    i = q.i; seg = q.seg;
    out.push({ ...q });
  }
  return out;
}

test('the lane is continuous through a corner and through a junction zigzag', () => {
  for (const [name, mk] of [['corner', corner], ['zigzag', zigzag]]) {
    const pts = sweep(mk(), 1.8, 5);
    let jump = 0, turn = 0;
    for (let k = 1; k < pts.length; k++) {
      jump = Math.max(jump, Math.hypot(pts[k].x - pts[k - 1].x, pts[k].z - pts[k - 1].z));
      const h = Math.atan2(pts[k - 1].dx * pts[k].dz - pts[k - 1].dz * pts[k].dx, pts[k - 1].dx * pts[k].dx + pts[k - 1].dz * pts[k].dz);
      turn = Math.max(turn, Math.abs(h));
    }
    // 0.1 m of arc never moves the lane point more than a few times that, and
    // never turns it by more than a tight car would in that distance
    assert.ok(jump < 0.3, `${name}: the lane jumps ${jump.toFixed(2)} m between samples`);
    assert.ok(turn < 0.1 / 2.5, `${name}: the lane turns ${turn.toFixed(3)} rad in 0.1 m`);
  }
});

test('a right-angle corner is rounded, and the planner brakes for it', () => {
  const r = corner(), o = {};
  cornerAt(r, 1, 0, 1.8, 5, o);
  assert.ok(o.ok, 'no corner found at the junction vertex');
  // legs of r0 tan(45 deg) from the lane points at the vertex, `off` shorter
  // on the inside of the turn: the quadratic's apex is 0.71 of what is left
  assert.ok(o.R > 0.71 * (5 - 1.8) * 0.8 && o.R < 5.2, `corner radius ${o.R.toFixed(2)} m`);
  // the lane right of the centreline turns right INSIDE the corner, and never
  // further in than half the leg (it does not cut the kerb)
  const mid = laneAt(r, 1, 0, (o.aS + o.aE) / 2, 1.8, {}, 5);
  assert.ok(mid.x > 1.8 && mid.z > -60 + 1.8, 'the apex is not inside the corner');
  assert.ok(mid.x < 1.8 + 2.5 && mid.z < -60 + 1.8 + 2.5, 'the apex cuts the corner too deep');
  const far = curveCap(r, 0, 0, 80, AI.A_LAT, 5, 1.8, 5);
  const at = curveCap(r, 0, o.aS, 80, AI.A_LAT, 5, 1.8, 5);
  assert.ok(at < 6 && Math.abs(at - Math.sqrt(AI.A_LAT * o.R)) < 0.5, `corner speed ${at.toFixed(1)} m/s`);
  assert.ok(far > at + 5, 'no braking envelope before the corner');
  // a bus's corner is rounded wider than a car's
  assert.ok(cornerR(12) > 2 * cornerR(4.6));
});

test('the wheel steers the front axle back onto the lane, the pedal never reverses', () => {
  const r = route([[0, 0], [0, -200]]);
  const body = (x) => ({ x, z: -50, heading: 0, speed: 8, yaw: 0, len: 4.6 });
  for (const [x, sign] of [[-1, 1], [1, -1]]) {
    const b = body(1.8 + x);
    const L = b.len * AI.WHEELBASE * 0.45;
    const f = laneFoot(r, 0, 0, 50 + L, b.x, b.z - L, 1.8, 5, {});
    assert.ok(Math.abs(f.x - 1.8) < 1e-6 && Math.abs(f.z - (b.z - L)) < 1e-3, 'the foot is not level with the axle');
    const d = stanley(b, f, b.speed);
    // + steer turns the nose right: a car LEFT of its lane steers right
    assert.ok(Math.sign(d) === sign, `a car ${x < 0 ? 'left' : 'right'} of its lane steers ${d.toFixed(2)}`);
    assert.ok(Math.abs(d) <= lockAt(8) + 1e-9);
  }
  const K = { accel: 7, vmax: 64 };
  assert.equal(pedalFor(-5, 0, K, 11).gas, 0, 'a stopped car told to stop may not select reverse');
  assert.equal(pedalFor(-5, 0, K, 11).hb, true);
  assert.ok(pedalFor(-5, 10, K, 11).gas < 0 && pedalFor(2, 10, K, 11).gas > 0);
});

test('the far model turns in an arc no tighter than the lock, and not in one step', () => {
  const b = { x: 0, z: 0, heading: 0, speed: 5, len: 4.6, kappa: 0 };
  kinStep(b, 10, 5, 0.05, AI.A_LAT);           // asks for a pivot
  assert.ok(Math.abs(b.kappa) < 0.2, `curvature jumped to ${b.kappa.toFixed(3)} in one step`);
  for (let i = 0; i < 40; i++) kinStep(b, 10, 5, 0.05, AI.A_LAT);
  const kMax = Math.tan(lockAt(5)) / (4.6 * AI.WHEELBASE);
  assert.ok(Math.abs(b.kappa) <= kMax + 1e-9, 'past the lock');
  assert.ok(Math.abs(b.yaw) <= 5 * kMax + 1e-9);
});

test('a blow on the flank shoves the car sideways and spins it', () => {
  // struck car heading north at rest; striker from the west, into its rear door
  const b = { x: 0, z: 0, heading: 0, speed: 0, _lat: 0, yaw: 0, len: 4.6, wid: 1.8 };
  const closing = ramImpulse(b, 1.45, -3.2, 1.2, -Math.PI / 2, 4.7, 12, 0, 1.45);
  assert.ok(closing > 10, `closing ${closing}`);
  assert.ok(b._lat > 3, `pushed sideways (east) at ${b._lat.toFixed(2)} m/s`);
  assert.ok(Math.abs(b.yaw) > 0.3, `spun at ${b.yaw.toFixed(2)} rad/s`);
  // hit behind the centre from the west: the tail goes east, the nose west,
  // i.e. the heading increases (a turn to the left)
  assert.ok(b.yaw > 0, 'spun the wrong way');
  const c = { x: 0, z: 0, heading: 0, speed: 0, _lat: 0, yaw: 0, len: 4.6, wid: 1.8 };
  assert.equal(ramImpulse(c, 1.45, -3.2, 0, -Math.PI / 2, 4.7, -6, 0, 1.45), 0, 'cars moving apart were pushed');
});

// ---- the grid town --------------------------------------------------------
function gridRoads() {
  const roads = [], HALF = 1800, STEP = 120, n = Math.floor(HALF / STEP);
  const line = (fn) => { const p = []; for (let j = -n; j <= n; j++) p.push(fn(j * STEP)); return p; };
  for (let i = -n; i <= n; i++) {
    roads.push({ t: (i % 3 === 0) ? 'primary' : 'residential', d: 1, w: 9, v: 50, p: line((zz) => [i * STEP, zz]) });
    roads.push({ t: (i % 4 === 0) ? 'secondary' : 'residential', d: 1, w: 9, v: 50, p: line((xx) => [xx, i * STEP]) });
  }
  return roads;
}
function town() {
  const vehicles = { scene: { add() {}, remove() {} }, cars: new Set(),
    add(kind, x, z, heading) {
      const car = { mesh: { position: { set() {} }, rotation: { y: 0 }, userData: {} }, wheels: [], x, z, heading,
        speed: 0, steer: 0, kind, len: 4.6, wid: 1.8, ai: null, y: 0, _rammedT: 0 };
      this.cars.add(car); return car;
    }, remove(car) { this.cars.delete(car); } };
  const t = new Traffic({ roads: gridRoads(), signals: [], onTileLoaded() {} }, vehicles);
  let now = 17_900_000;
  t.clock = () => now;
  t.maxCars = 240;
  const pos = { x: 7, y: 0, z: 7 };
  t.setViewer({ x: 7, z: 7, dirX: 1, dirZ: 0, fovRad: 1.19, aspect: 1, fogFar: 634 });
  return { t, pos, step(dt = 1 / 20, car = null) { now += dt; t.update(dt, pos, car); } };
}

test('on the grid every car near you turns in an arc, on its lane', () => {
  const T = town();
  for (let i = 0; i < 40 * 20; i++) T.step();
  const prev = new Map();
  let worst = 0, n = 0, phys = 0;
  for (let i = 0; i < 40 * 20; i++) {
    T.step();
    for (const c of T.t.cars) {
      if (Math.hypot(c.x - T.pos.x, c.z - T.pos.z) > 200) continue;
      const h = prev.get(c);
      if (h !== undefined) {
        const r = Math.abs(Math.atan2(Math.sin(c.heading - h), Math.cos(c.heading - h))) * 20;
        if (r > worst) worst = r;
        n++;
      }
      if (c.ai?.body?.phys) phys++;
      prev.set(c, c.heading);
    }
  }
  assert.ok(n > 2000, `only ${n} samples`);
  assert.ok(phys > 0, 'no car near the player ran the tyre model');
  // v10 pivoted at junction vertices at up to 20 rad/s
  assert.ok(worst < 2.0, `a car turned at ${worst.toFixed(2)} rad/s`);
});

test('a car the player rams is shoved and spun, then drives on or stays a wreck', () => {
  const T = town();
  for (let i = 0; i < 30 * 20; i++) T.step();
  // a car on the lane, moving, near the player
  let car = null;
  for (const c of T.t.cars) {
    const p = c.ai;
    if (p && !p.ghost && p.body?.phys && Math.abs(c.speed) > 4 && Math.hypot(c.x - T.pos.x, c.z - T.pos.z) < 140) { car = c; break; }
  }
  assert.ok(car, 'no driving car near the player');
  const p = car.ai, b = p.body;
  // the player's car coming in square on its right flank at 15 m/s, just
  // behind its centre, the way driveStep would leave things on contact
  const fx = -Math.sin(car.heading), fz = -Math.cos(car.heading), rx = -fz, rz = fx;
  const pc = { x: car.x + rx * 3.2 - fx * 0.8, z: car.z + rz * 3.2 - fz * 0.8, heading: Math.atan2(rx, rz),
    speed: 15, _lat: 0, len: 4.7, wid: 1.81, kind: 'octavia' };
  T.step(1 / 60, pc);                            // a frame to remember the player's velocity
  car._rammedT = 2.5;
  car.x += 0.01;                                 // driveStep's separation shove
  const lat0 = b._lat, yaw0 = b.yaw;
  T.step(1 / 60, pc);
  assert.ok(b._lat - lat0 < -2, `not pushed away (lateral ${b._lat.toFixed(2)} m/s)`);
  assert.ok(Math.abs(b.yaw - yaw0) > 0.2, `not spun (yaw ${b.yaw.toFixed(2)} rad/s)`);
  // nothing snaps while it slides: heading changes smoothly frame to frame
  let h = car.heading, jump = 0;
  for (let i = 0; i < 6 * 20; i++) {
    T.step();
    jump = Math.max(jump, Math.abs(Math.atan2(Math.sin(car.heading - h), Math.cos(car.heading - h))));
    h = car.heading;
  }
  assert.ok(jump < 0.25, `the heading jumped ${jump.toFixed(2)} rad in one step`);
  assert.ok(!(car._rammedT > 0), 'still rammed after six seconds');
  if (p.wreck) {
    assert.ok(Math.abs(car.speed) < 0.5, 'a wreck that keeps rolling');
  } else {
    for (let i = 0; i < 6 * 20; i++) T.step();
    assert.ok(car.ai === p, 'the car lost its driver');
    const e = p.edge, q = laneAt(p.route, p.ri, 0, p.bArc, p.laneOff, {}, b.r0);
    assert.ok(Math.hypot(q.x - car.x, q.z - car.z) < 2, 'it did not find its lane again');
    assert.ok(e && Math.abs(car.speed) > 0.5, 'it did not drive on');
  }
});
